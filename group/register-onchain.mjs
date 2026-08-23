// register-onchain: stake a self-enrolled commitment into the on-chain
// StakedReputationSet (docs/ONCHAIN.md). The sibling of self-enrollment: enroll.mjs
// generates the identity locally and emits the commitment; this posts that
// commitment with the fixed BOND so the member is admitted to the *canonical*,
// tamper-evident on-chain root the gateway reads through its RootProvider.
//
// register() is permissionless: anyone may pay the bond for any commitment, but
// only the secret-holder can ever spend or exit it. In production the bond is
// funded from a Layer-0 shielded (Railgun / Privacy Pools) fresh address so the
// funding identity never links to the member (R1). For the local anvil demo we
// fund from a well-known anvil dev key.
//
// Usage:
//   node group/register-onchain.mjs <commitment> [--limit N]
//   node group/enroll.mjs --commitment-only | node group/register-onchain.mjs
//   shade-tree register-member <commitment> --limit 32
//
// Reputation tiers (T-FEAT-8b, docs/adr/0006-reputation-tiers.md): `--limit N` (or SHADE_TREE_LIMIT)
// is the tier the commitment was ENROLLED at (`shade-tree enroll --limit N`); the rln-v4 set records
// it and prices the bond per tier (`bondFor(limit)`), so the amount is read from the contract
// for that tier. Default = 8 (the pre-tier K). Against an rln-v3 set (no tiers) only the
// default tier is admitted: `register(commitment)` at `BOND()`.
//
// Config (all overridable by env; defaults read contracts/deployed.local.json):
//   SHADE_TREE_RPC_URL        JSON-RPC endpoint         (default: deployed.rpcUrl or anvil)
//   SHADE_TREE_GROUP_CONTRACT StakedReputationSet addr  (default: deployed.StakedReputationSet)
//   SHADE_TREE_REGISTER_KEY   funding private key       (default: anvil account #0)
//   SHADE_TREE_LIMIT          tier limit (== --limit)   (default: 8)
//   SHADE_TREE_BOND           bond in wei               (default: on-chain bondFor(limit) / BOND())
//
// NB: needs the `ethers` dependency (see final report). Imported lazily so this
// file still parses without it.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normLimit, K_SLOTS } from "../lib/rln.mjs";
import { parseContractList } from "../lib/root-provider.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOYED_PATH = join(HERE, "..", "contracts", "deployed.local.json");

// anvil's deterministic account #0 — dev only, funded on a fresh anvil.
const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

async function readDeployed() {
  try {
    return JSON.parse(await readFile(DEPLOYED_PATH, "utf8"));
  } catch {
    return {}; // fall back entirely to env
  }
}

// --limit <n> | --limit=<n> (or SHADE_TREE_LIMIT): the tier the leaf was enrolled at.
const argv = process.argv.slice(2);
let limitArg = process.env.SHADE_TREE_LIMIT || null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--limit") { limitArg = argv[i + 1]; argv.splice(i, 2); break; }
  if (argv[i].startsWith("--limit=")) { limitArg = argv[i].slice("--limit=".length); argv.splice(i, 1); break; }
}
const LIMIT = normLimit(limitArg == null || limitArg === "" ? K_SLOTS : limitArg); // throws on a bad tier

async function readCommitment() {
  const arg = argv[0];
  if (arg && !arg.startsWith("--")) return arg.trim();
  // else read a single commitment from stdin (pipe from enroll --commitment-only)
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const s = Buffer.concat(chunks).toString("utf8").trim();
  if (s) return s.split(/\s+/)[0];
  console.error("usage: node group/register-onchain.mjs <commitment>   (or pipe one on stdin)");
  process.exit(1);
}

async function main() {
  const commitment = await readCommitment();
  const deployed = await readDeployed();

  const rpcUrl = process.env.SHADE_TREE_RPC_URL || deployed.rpcUrl || "http://127.0.0.1:8545";
  // SHADE_TREE_GROUP_CONTRACT may be a comma list since T-FEAT-7 (several sets trusted by the gateway);
  // a stake goes to the FIRST — the canonical staked set. (Paid access is inserted by the operator, docs/PAYMENTS.md.)
  const address = parseContractList(process.env.SHADE_TREE_GROUP_CONTRACT)[0] || deployed.StakedReputationSet || deployed.address;
  const key = process.env.SHADE_TREE_REGISTER_KEY || ANVIL_KEY_0;
  if (!address) {
    console.error("no StakedReputationSet address: set SHADE_TREE_GROUP_CONTRACT or write contracts/deployed.local.json");
    process.exit(1);
  }

  let ethers;
  try {
    ({ ethers } = await import("ethers"));
  } catch {
    console.error("register-onchain needs the `ethers` dependency (add it to package.json; see report).");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(key, provider);
  const abi = [
    "function register(uint256 commitment) payable",
    "function register(uint256 commitment, uint256 limit) payable",
    "function BOND() view returns (uint256)",
    "function bondFor(uint256 limit) view returns (uint256)",
    "function isActive(uint256 commitment) view returns (bool)",
  ];
  const contract = new ethers.Contract(address, abi, wallet);

  // rln-v4 (tiered) vs rln-v3: probe bondFor(limit). A v3 set has no such function.
  let tiered = true;
  let tierBond = 0n;
  try { tierBond = await contract.bondFor(LIMIT); } catch { tiered = false; }
  if (tiered && tierBond === 0n) {
    console.error(`tier ${LIMIT} is not admitted by ${address} (bondFor(${LIMIT}) == 0); enroll at an admitted tier`);
    process.exit(1);
  }
  if (!tiered && LIMIT !== BigInt(K_SLOTS)) {
    console.error(`contract ${address} has no tier table (rln-v3): only --limit ${K_SLOTS} can be staked there`);
    process.exit(1);
  }
  const bond = process.env.SHADE_TREE_BOND ?? deployed.bond ?? (tiered ? tierBond : await contract.BOND());

  console.log(tiered ? `register(${commitment}, ${LIMIT})` : `register(${commitment})`);
  console.log(`  contract: ${address}${tiered ? "" : " (rln-v3, default tier only)"}`);
  console.log(`  rpc:      ${rpcUrl}`);
  console.log(`  from:     ${wallet.address}`);
  console.log(`  limit:    ${LIMIT}`);
  console.log(`  bond:     ${bond} wei`);

  const tx = tiered
    ? await contract["register(uint256,uint256)"](commitment, LIMIT, { value: bond })
    : await contract["register(uint256)"](commitment, { value: bond });
  console.log(`  tx:       ${tx.hash}  (waiting for confirmation...)`);
  const rcpt = await tx.wait();
  console.log(`  mined in block ${rcpt.blockNumber}; member staked and admitted to the on-chain root.`);
}

main().catch((e) => {
  console.error("register failed:", e.shortMessage || e.message);
  process.exit(1);
});
