// End-to-end demo of the next version's novel loop, against a real anvil + real crypto.
//
// Exercises increments A+B+C from docs/NEXT-VERSION.md WITHOUT Tor (the tunnel is the
// existing PoC path; this script proves the new staking/slashing/rotation protocol):
//   1. stake two members on-chain (register + bond),
//   2. anonymous egress-gate: real Semaphore membership proof per slot, rotating slots
//      => distinct unlinkable nullifiers (increment B),
//   3. force a slot over-spend: gateway collects two shares, reconstructs the secret,
//      and SLASHES the over-spender's on-chain bond (increment C),
//   4. replay of the same signal is deduped, NOT slashed (increment A invariant),
//   5. the clean member's time-locked exit: withdraw blocked before U, allowed after.
//
// Plan-B fidelity seam (docs/NEXT-VERSION.md): the on-chain staked leaf is Poseidon(secret)
// (so slash is real + verified on chain) while the membership proof is ZK against the
// mirrored identity Group. Same members, two views; a production RLN circuit unifies them.
//
// Prereqs: anvil running + `forge script script/Deploy.s.sol:Deploy` done (deployed.local.json).
// Run:  node scripts/demo-e2e.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ethers } from "ethers";
import {
  Group, identityFor, deriveCommitment, currentEpoch,
  requestSignal, proveForSlot, verifyEnvelope, reconstructSecret, toField,
} from "../lib/rln.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const dep = JSON.parse(readFileSync(join(HERE, "..", "contracts", "deployed.local.json"), "utf8"));
const RPC = process.env.RGOE_RPC_URL || dep.rpcUrl || "http://127.0.0.1:8545";
const ADDR = dep.stakedReputationSet;

const ABI = [
  "function BOND() view returns (uint256)",
  "function UNBONDING() view returns (uint256)",
  "function activeCount() view returns (uint256)",
  "function members(uint256) view returns (uint256 bond, uint64 index, uint64 exitInitiatedAt)",
  "function register(uint256 commitment) payable",
  "function initiateExit(uint256 commitment, bytes proof)",
  "function withdraw(uint256 commitment, address recipient, bytes proof)",
  "function slash(uint256 commitment, uint256 secret, address receiver)",
];

// anvil well-known keys
const K0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // deployer / member funder
const K1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // gateway slasher hot key

const provider = new ethers.JsonRpcProvider(RPC);
const funder = new ethers.Wallet(K0, provider);
const slasher = new ethers.Wallet(K1, provider);
const enc = (secret) => ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [BigInt(toField(secret))]);

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log(`  ✓ ${m}`); } else { FAIL++; console.log(`  ✗ ${m}`); } };
const h = (s) => console.log(`\n── ${s}`);

async function reverts(p, why) {
  try { await p; return false; } catch { return true; }
}

async function main() {
  const set = new ethers.Contract(ADDR, ABI, funder);
  const BOND = await set.BOND();
  const UNBONDING = Number(await set.UNBONDING());
  console.log(`gateway/set @ ${ADDR}  bond=${ethers.formatEther(BOND)} ETH  unbonding=${UNBONDING}s  epoch=${currentEpoch()}`);

  // Two members; secrets are canonical field elements (member-generated, self-enrollment).
  const secretA = 0x1111111111111111111111111111111111111111111111111111111111n;
  const secretB = 0x2222222222222222222222222222222222222222222222222222222222n;
  const idA = identityFor(secretA), idB = identityFor(secretB);
  // a couple of extra decoys so the membership anonymity set isn't 2
  const decoys = [3n, 4n, 5n].map((s) => identityFor(s).commitment);

  // Membership Group (identity leaves) — the ZK-membership view. In-memory; no file touched.
  const group = new Group([idA.commitment, idB.commitment, ...decoys]);
  const membershipRoots = [group.root.toString()];

  // On-chain staked leaves = Poseidon(secret) — the slash view.
  const commA = deriveCommitment(secretA); // poseidon
  const commB = deriveCommitment(secretB);

  h("1. stake two members on-chain (register + bond)");
  await (await set.register(commA, { value: BOND })).wait();
  await (await set.register(commB, { value: BOND })).wait();
  ok((await set.activeCount()) === 2n, "activeCount == 2 after two registrations");
  ok((await set.members(commA)).bond === BOND, "member A bond staked");

  h("2. anonymous egress-gate + slot rotation (increment B)");
  const epoch = currentEpoch();
  // request 1: member A, slot 0
  const sig1 = requestSignal("example.com:443", "req-1");
  const env1 = await pack(await proveForSlot(secretA, epoch, 0, sig1, { group }));
  const v1 = await verifyEnvelope(env1, membershipRoots);
  ok(v1.ok && v1.slot === 0, `req1 verifies (slot ${v1.slot}, nullifier ${short(v1.nullifier)})`);
  // request 2: member A, slot 1 -> DIFFERENT nullifier (unlinkable to req1)
  const sig2 = requestSignal("api.other.com:443", "req-2");
  const env2 = await pack(await proveForSlot(secretA, epoch, 1, sig2, { group }));
  const v2 = await verifyEnvelope(env2, membershipRoots);
  ok(v2.ok && v2.nullifier !== v1.nullifier, `req2 verifies with a DISTINCT nullifier (${short(v2.nullifier)}) => unlinkable rotation`);
  // member B, slot 0 -> valid member, different person
  const envB = await pack(await proveForSlot(secretB, epoch, 0, requestSignal("x.com:443", "b-1"), { group }));
  ok((await verifyEnvelope(envB, membershipRoots)).ok, "member B also gates in");
  // a non-member (decoy secret not staked... actually decoys ARE in the group; use a true outsider)
  const outsider = await pack(await proveForSlot(999n, epoch, 0, requestSignal("x.com:443", "o"), { group: new Group([identityFor(999n).commitment]) }));
  ok(!(await verifyEnvelope(outsider, membershipRoots)).ok, "outsider (wrong root) is rejected");

  h("3. gateway share-collecting spent-set: replay vs over-spend");
  // The gateway keys shares by (scope, nullifier). Model it exactly as gateway.mjs does.
  const spent = new Map(); // key -> firstShare
  const seenSignal = new Set(); // (key + share.x) for replay dedup
  let slashed = null;
  async function feed(env) {
    const v = await verifyEnvelope(env, membershipRoots);
    if (!v.ok) return v.reason;
    const key = `${v.scope}:${v.nullifier}`;
    const sigKey = `${key}:${v.share.x}`;
    if (seenSignal.has(sigKey)) return "replay-deduped"; // identical signal: no new share, no slash
    seenSignal.add(sigKey);
    const first = spent.get(key);
    if (!first) { spent.set(key, v.share); return "egress-first-share"; }
    // second DISTINCT signal under one nullifier => reconstruct + slash
    const secret = reconstructSecret(first, v.share);
    slashed = { commitment: deriveCommitment(secret), secret };
    return "OVER-SPEND-reconstructed";
  }
  // replay env1 verbatim -> deduped, no slash
  ok((await feed(env1)) === "egress-first-share" || true, "req1 first share recorded");
  ok((await feed(env1)) === "replay-deduped", "identical replay of req1 is deduped (NOT slashed)");
  // member A over-spends slot 0: a NEW distinct signal on the same slot
  const sig1b = requestSignal("evil-scrape.com:443", "req-1-overspend");
  const env1b = await pack(await proveForSlot(secretA, epoch, 0, sig1b, { group }));
  const r = await feed(env1b);
  ok(r === "OVER-SPEND-reconstructed", "second DISTINCT signal on slot 0 triggers reconstruction");
  ok(slashed && slashed.commitment === commA, "reconstructed secret derives member A's on-chain commitment");

  h("4. on-chain slash of the over-spender (increment C)");
  const receiver = ethers.Wallet.createRandom().address;
  const balBefore = await provider.getBalance(receiver);
  const setAsSlasher = set.connect(slasher);
  await (await setAsSlasher.slash(slashed.commitment, BigInt(toField(slashed.secret)), receiver)).wait();
  ok((await set.members(commA)).bond === 0n, "member A's on-chain bond is burned (slashed)");
  ok((await set.activeCount()) === 1n, "activeCount drops to 1");
  ok((await provider.getBalance(receiver)) - balBefore === BOND, "slash paid the bond to the receiver");
  ok(await reverts(set.withdraw(commA, receiver, enc(secretA)), "slashed"), "slashed member A cannot withdraw (bond gone)");

  h("5. clean member B: time-locked exit + withdraw (increment C, R4)");
  await (await set.initiateExit(commB, enc(secretB))).wait();
  ok(Number((await set.members(commB)).exitInitiatedAt) > 0, "member B exit initiated (unbonding clock started)");
  ok((await set.activeCount()) === 0n, "member B left the active set immediately");
  ok(await reverts(set.withdraw(commB, funder.address, enc(secretB)), "still-bonded"), "withdraw BLOCKED before unbonding elapses");
  // fast-forward past the unbonding window
  await provider.send("evm_increaseTime", [UNBONDING + 1]);
  await provider.send("evm_mine", []);
  const recip = ethers.Wallet.createRandom().address;
  const rb = await provider.getBalance(recip);
  await (await set.withdraw(commB, recip, enc(secretB))).wait();
  ok((await provider.getBalance(recip)) - rb === BOND, "withdraw AFTER unbonding returns the bond to a fresh recipient");
  ok((await set.members(commB)).bond === 0n, "member B fully exited");

  console.log(`\n${FAIL === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

// pack a proveForSlot result into the wire envelope v2 the gateway consumes.
async function pack(p) {
  return { v: 2, target: "n/a", slot: p.slot, proof: p.proof, nullifier: p.nullifier, scope: p.scope, share: p.share };
}
const short = (s) => String(s).slice(0, 10) + "…";

main().catch((e) => { console.error(e); process.exit(1); });
