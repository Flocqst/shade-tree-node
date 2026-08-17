// Paid access, off-chain half (T-FEAT-7, docs/PAYMENTS.md, ADR 0007) end to end on a throwaway
// anvil: the gateway trusting a UNION of roots (static members.json + a StakedReputationSet + a
// PaidAccessSet), the client discovering WHICH set holds its leaf, `rgoe leaves` exporting the paid
// tree for the Rust client, and the slasher ROUTING a paid over-spender's slash to the PAID
// contract. REAL contracts on both sides (the staked set deployed by contracts/script/
// DeployRegistry.s.sol; the operator-insert-only contracts/PaidAccessSet.sol, PR #50, deployed from
// its forge artifact — the payment itself is off chain, HTTP 402 rails), the REAL gateway process,
// REAL RLN Groth16 proofs. Slow suite
// (scripts/test-all.mjs SLOW_SUITES; skipped by RGOE_FAST=1). Needs anvil + forge on PATH and TCP
// :8443 free; else SKIPs honestly.
//
// Proves:
//   - the operator's `insert(commitment, 32)` appends the paid member's leaf (limitOf/leafCount/root
//     agree with the JS tree); a non-operator insert reverts;
//   - `rgoe leaves --contract <paid>` writes the members.json shape whose JS root == currentRoot;
//   - gateway startup logs `roots: members.json + staked(0x..) + paid(0x..)`, the paid floor WARN
//     (1 leaf < K=8), and `slash: routing over ...`;
//   - the client's leaf discovery names members.json / staked / paid for the three members;
//   - static, staked and paid members ALL egress (three roots trusted at once);
//   - a proof under an unknown root is dropped `gate:wrong-group-root`;
//   - the paid member's over-spend is slashed on the PAID contract (leaf zeroed, root changes) and
//     the staked contract is untouched.
//
//   node test/paid-access.selftest.mjs

import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { console.log(`  FAIL ${msg}`); failures++; } };

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "bin", "rgoe.mjs");
const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // deployer + staker
const ANVIL_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // gateway slasher hot key
const ANVIL_ADDR_2 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // slash receiver
const ANVIL_ADDR_3 = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // paid-set operator (the registrar key)
const ANVIL_KEY_3 = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const ANVIL_KEY_4 = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"; // NOT the operator
const ANVIL_KEY_5 = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"; // JS-side deployer (its own nonce lane: never shared with the forge broadcast key)

async function rpc(url, method, params = []) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}
function localTarget() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => { sock.on("error", () => {}); });
    srv.listen(0, "127.0.0.1", () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}
function rgoe(args, env) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, RGOE_NETWORK: "", ...env }, timeout: 180000 });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
async function waitFor(pred, ms, stepMs = 500) {
  const start = Date.now();
  while (Date.now() - start < ms) { const v = await pred(); if (v) return v; await new Promise((r) => setTimeout(r, stepMs)); }
  return null;
}

async function main() {
  console.log("paid access, off-chain half (T-FEAT-7): union roots + slasher routing + leaf discovery on anvil:");
  const anvilBin = spawnSync("which", ["anvil"], { encoding: "utf8" }).stdout.trim();
  const forgeBin = spawnSync("which", ["forge"], { encoding: "utf8" }).stdout.trim();
  if (!anvilBin || !forgeBin) { console.log("  SKIP anvil/forge not on PATH"); return; }
  if (!(await portFree(8443))) { console.log("  SKIP tcp 127.0.0.1:8443 busy (the gateway's fixed listen port)"); return; }

  const port = 19545 + Math.floor(Math.random() * 1000);
  const url = `http://127.0.0.1:${port}`;
  const anvil = spawn(anvilBin, ["--port", String(port), "--silent"], { stdio: "ignore" });
  const work = mkdtempSync(join(tmpdir(), "rgoe-paid-"));
  const targets = [await localTarget(), await localTarget()];
  const targetList = targets.map((t) => `127.0.0.1:${t.port}`);
  // The static members.json this gateway trusts (RGOE_MEMBERS_FILE) — set BEFORE lib/rln.mjs loads.
  const membersFile = join(work, "members.json");
  process.env.RGOE_MEMBERS_FILE = membersFile;
  process.env.RGOE_CONFIRMATIONS = "1";
  process.env.RGOE_HELIOS_RPC_URL = "";
  process.env.RGOE_NETWORK = "";
  let gw = null;
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { await rpc(url, "eth_chainId"); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    if (!up) { console.log("  SKIP anvil did not come up"); return; }

    // ---- 1. contracts: the real staked set (tiers 8,32) + the real paid set (tiers 8,32) ----------
    const outJson = join(ROOT, "cache", `paid-selftest-${port}.local.json`);
    const dep = spawnSync(forgeBin, ["script", "contracts/script/DeployRegistry.s.sol:DeployRegistry", "--rpc-url", url, "--broadcast", "--private-key", ANVIL_KEY_0, "-vv"], {
      cwd: ROOT, encoding: "utf8", timeout: 300000,
      env: { ...process.env, RGOE_BOND_WEI: "1000000000000000", RGOE_TIER_LIMITS: "32", RGOE_TIER_BONDS_WEI: "4000000000000000", RGOE_DEPLOY_OUT: outJson, RGOE_RPC_URL: url },
    });
    ok(dep.status === 0 && existsSync(outJson), "DeployRegistry.s.sol broadcast the tiered StakedReputationSet on anvil");
    if (dep.status !== 0) { console.log((dep.stdout || "").split("\n").slice(-15).join("\n"), dep.stderr); return; }
    const deployed = JSON.parse(readFileSync(outJson, "utf8"));
    rmSync(outJson, { force: true });
    const staked = deployed.stakedReputationSet;
    const hasher = deployed.hasher;
    const { ethers } = await import("ethers");
    const provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
    // A DIFFERENT key than the forge broadcast (key 0): sharing one account across forge + ethers
    // raced on the nonce in CI ("nonce has already been used").
    const deployer = new ethers.Wallet(ANVIL_KEY_5, provider);
    // PoseidonT3 (external library) + the linked PaidAccessSet, from the forge artifacts (the deploy
    // script above already built the tree; build if the artifact is missing).
    const readArtifact = (rel) => JSON.parse(readFileSync(join(ROOT, "out", rel), "utf8"));
    if (!existsSync(join(ROOT, "out", "PaidAccessSet.sol", "PaidAccessSet.json"))) spawnSync(forgeBin, ["build"], { cwd: ROOT, encoding: "utf8", timeout: 300000 });
    const poseidonArt = readArtifact("PoseidonT3.sol/PoseidonT3.json");
    const poseidon = await (await new ethers.ContractFactory(poseidonArt.abi, poseidonArt.bytecode.object, deployer).deploy()).waitForDeployment();
    const paidArt = readArtifact("PaidAccessSet.sol/PaidAccessSet.json");
    const linked = paidArt.bytecode.object.replace(/__\$[0-9a-fA-F]{34}\$__/g, (await poseidon.getAddress()).slice(2).toLowerCase());
    const paidC = await (await new ethers.ContractFactory(paidArt.abi, linked, deployer).deploy(ANVIL_ADDR_3, hasher, [8n, 32n])).waitForDeployment();
    const paid = await paidC.getAddress();
    ok(/^0x[0-9a-fA-F]{40}$/.test(paid) && (await paidC.allowedLimits()).map(Number).join(",") === "8,32" && (await paidC.operator()) === ANVIL_ADDR_3, `PaidAccessSet (contracts/PaidAccessSet.sol) deployed at ${paid} (operator = anvil #3; tiers 8,32; insert-only)`);
    const slot3 = await rpc(url, "eth_getStorageAt", [paid, "0x3", "latest"]);
    ok(BigInt(slot3) === (await paidC.currentRoot()), "currentRoot at storage slot 3 (LightClientRootProvider-compatible)");

    // ---- 2. three members: static S (tier 8), staked A (tier 8), paid P (tier 32) --------------
    const { memberOf, sendEnvelope, startGateway, stakeViaCli } = await import("../scripts/integration-tiers.mjs");
    const { groupFromIdentities, newGroup, currentEpoch, requestSignal, proveForSlot } = await import("../lib/rln.mjs");
    const { makeSlotPool, buildEnvelope, makeLeafSourceLoader } = await import("../client/rgoe-client.mjs");
    const seed = () => "0x" + randomBytes(32).toString("hex");
    const S = memberOf(seed(), 8), A = memberOf(seed(), 8), P = memberOf(seed(), 32);
    writeFileSync(membersFile, JSON.stringify({ version: 2, members: [S.leaf] }, null, 2) + "\n");

    const st = stakeViaCli(A, { rpcUrl: url, set: staked, key: ANVIL_KEY_0 });
    ok(st.code === 0 && !!st.tx, "staked member A: `rgoe register-member --limit 8` on the StakedReputationSet");

    // The paid member: the operator (registrar) inserts P's leaf after the off-chain 402 payment.
    const paidAsOp = paidC.connect(new ethers.Wallet(ANVIL_KEY_3, provider));
    let notOp = "did-not-revert";
    try { await paidC.connect(new ethers.Wallet(ANVIL_KEY_4, provider)).insert.staticCall(P.leaf, 32n); } catch (e) { notOp = e.revert?.name || e.shortMessage || "revert"; }
    ok(notOp !== "did-not-revert" && /NotOperator/.test(String(notOp)), `a non-operator insert reverts (${notOp})`);
    const insTx = await (await paidAsOp.insert(P.leaf, 32n)).wait();
    const insEv = insTx.logs.map((l) => { try { return paidC.interface.parseLog(l); } catch { return null; } }).find((p) => p && p.name === "Inserted");
    ok(!!insEv && String(insEv.args.index) === "0" && String(insEv.args.limit) === "32", "operator insert(P.leaf, 32) mined; Inserted(commitment, 32, index 0, root) emitted");
    ok((await paidC.limitOf(P.leaf)) === 32n && (await paidC.leafCount()) === 1n, "paid set: limitOf(P.leaf) == 32, leafCount == 1");
    ok((await paidC.currentRoot()).toString() === groupFromIdentities([{ identity: P.identity, limit: 32 }]).root.toString(), "paid currentRoot() == JS tree of [P@32]");

    // rgoe leaves: the Rust-client bridge
    const leavesOut = join(work, "paid-members.json");
    const lv = rgoe(["leaves", "--contract", paid, "--out", leavesOut], { RGOE_RPC_URL: url });
    const lvDoc = existsSync(leavesOut) ? JSON.parse(readFileSync(leavesOut, "utf8")) : null;
    ok(lv.code === 0 && lvDoc && lvDoc.version === 2 && Array.isArray(lvDoc.members) && lvDoc.members[0] === P.leaf && newGroup(lvDoc.members.map(BigInt)).root.toString() === (await paidC.currentRoot()).toString(), "`rgoe leaves --contract <paid> --out` writes {version:2, members:[..]} whose root == currentRoot()");

    await rpc(url, "evm_mine", []); // head-1 now covers the stake + the deposit

    // ---- 3. the REAL gateway: union of the three roots + routing slasher ------------------------
    gw = startGateway({
      RGOE_RPC_URL: url,
      RGOE_GROUP_CONTRACT: staked,
      RGOE_PAID_ACCESS_CONTRACT: paid,
      RGOE_MEMBERS_FILE: membersFile,
      RGOE_ROOT_PROVIDER: "node",
      RGOE_CONFIRMATIONS: "1",
      RGOE_FROM_BLOCK: "0x0",
      RGOE_SLASH_KEY: ANVIL_KEY_1,
      RGOE_SLASH_RECEIVER: ANVIL_ADDR_2,
      RGOE_SLASH_CONTRACT: "",
      RGOE_TIERS: "8,32",
      RGOE_HELIOS_RPC_URL: "",
      RGOE_NETWORK: "",
      RGOE_EGRESS_ALLOW: targetList.join(","),
      RGOE_EPOCH_SECONDS: "120",
    }, { log: (step, line) => { if (/roots:|paid-access|slash:|SLASH|root source|routed/.test(line)) console.log("    " + line); } });
    await gw.ready;
    ok(new RegExp(`roots: members\\.json \\+ staked\\(${staked}\\) \\+ paid\\(${paid}\\)`).test(gw.out), "startup log: `roots: members.json + staked(0x..) + paid(0x..)`");
    ok(/paid-access anonymity set: 1 leaves \(floor K=8\)/.test(gw.out) && /BELOW the floor/.test(gw.out), "startup log WARNs the paid anonymity set (1 leaf) is below the floor K=8 (and keeps running)");
    ok(new RegExp(`slash: routing over staked\\(${staked}\\) \\+ paid\\(${paid}\\)`).test(gw.out), "slasher routes over staked + paid");
    ok(/trustedRoots=3/.test(gw.out), "three roots trusted at once (trustedRoots=3)");

    // ---- 4. client leaf discovery + egress for all three ---------------------------------------
    const contracts = [{ address: staked, kind: "staked" }, { address: paid, kind: "paid" }];
    const loaderFor = (m) => makeLeafSourceLoader({ secret: m.seed, limit: m.limit, contracts, rpcUrl: url });
    const dS = await loaderFor(S)(), dA = await loaderFor(A)(), dP = await loaderFor(P)();
    ok(dS.source === "members.json", `client discovery: S's leaf found in ${dS.source}`);
    ok(dA.source === `staked(${staked})`, `client discovery: A's leaf found in ${dA.source}`);
    ok(dP.source === `paid(${paid})`, `client discovery: P's leaf found in ${dP.source}`);
    let missErr = null;
    try { await makeLeafSourceLoader({ secret: seed(), limit: 8, contracts, rpcUrl: url })(); } catch (e) { missErr = e.message; }
    ok(missErr && /in none of: members\.json \(1 leaves\), staked\(/.test(missErr) && /paid\(/.test(missErr) && /docs\/PAYMENTS\.md/.test(missErr), "an unknown member gets a precise error naming every source tried");
    const pools = { S: makeSlotPool({ secret: S.seed, K: 8, loadGroupFn: loaderFor(S) }), A: makeSlotPool({ secret: A.seed, K: 8, loadGroupFn: loaderFor(A) }), P: makeSlotPool({ secret: P.seed, K: 32, loadGroupFn: loaderFor(P) }) };
    for (const [name, m] of [["S (static)", S], ["A (staked)", A], ["P (paid)", P]]) {
      const { envelope, slot } = await buildEnvelope({ secret: m.seed, target: targetList[0], pool: pools[name[0]] });
      const ack = await sendEnvelope(envelope);
      ok(ack.ok === true, `${name} member's request at slot ${slot} accepted -> ${JSON.stringify(ack)}`);
    }

    // ---- 5. unknown root -> DROP wrong-group-root ------------------------------------------------
    const X = memberOf(seed(), 8);
    const gX = groupFromIdentities([X.identity]);
    const epoch = currentEpoch();
    const nx = "x-" + randomBytes(4).toString("hex");
    const ex = await proveForSlot(X.seed, epoch, 0, requestSignal(targetList[0], nx), { group: gX, limit: 8 });
    const ackX = await sendEnvelope({ v: 3, target: targetList[0], nonce: nx, proof: ex.proof, nullifier: ex.nullifier, externalNullifier: ex.externalNullifier, share: ex.share });
    ok(ackX.ok === false && ackX.err === "gate:wrong-group-root", `a proof under an unknown root is dropped -> ${JSON.stringify(ackX)}`);

    // ---- 6. paid over-spend -> slash routed to the PAID contract --------------------------------
    const stakedC = new ethers.Contract(staked, ["function limitOf(uint256) view returns (uint256)", "function currentRoot() view returns (uint256)"], provider);
    const stakedRootBefore = (await stakedC.currentRoot()).toString();
    const paidRootBefore = (await paidC.currentRoot()).toString();
    const n1 = "p-n1-" + randomBytes(4).toString("hex"), n2 = "p-n2-" + randomBytes(4).toString("hex");
    // slot 5: a fresh nullifier (slot 0 was P's normal request above); two DISTINCT signals under it.
    const e1 = await proveForSlot(P.seed, epoch, 5, requestSignal(targetList[0], n1), { group: dP.group, limit: 32 });
    const e2 = await proveForSlot(P.seed, epoch, 5, requestSignal(targetList[0], n2), { group: dP.group, limit: 32 });
    const mk = (n, e) => ({ v: 3, target: targetList[0], nonce: n, proof: e.proof, nullifier: e.nullifier, externalNullifier: e.externalNullifier, share: e.share });
    const a1 = await sendEnvelope(mk(n1, e1));
    const a2 = await sendEnvelope(mk(n2, e2), { timeoutMs: 180000 });
    ok(a1.ok === true && a2.ok === false && a2.err === "over-spend-slashed", `P's second distinct signal on slot 5 is dropped over-spend-slashed (${JSON.stringify(a1)} then ${JSON.stringify(a2)})`);
    const slashed = await waitFor(async () => (gw.out.match(/SLASH mined block (\d+)/) ? true : null), 180000, 1000);
    ok(!!slashed, "gateway submitted the on-chain slash");
    ok(new RegExp(`slash: routed to paid\\(${paid}\\)`).test(gw.out) && new RegExp(`SLASH tx .*via=${paid}`).test(gw.out), "the slash was ROUTED to the paid contract (limitOf found the leaf there)");
    ok((await paidC.limitOf(P.leaf)) === 0n && (await paidC.leafCount()) === 1n, "paid: P's leaf zeroed (limitOf == 0; leafCount stays 1 — the slot is never reused)");
    const gZ = groupFromIdentities([{ identity: P.identity, limit: 32 }]); gZ.removeMember(0);
    const paidRootAfter = (await paidC.currentRoot()).toString();
    ok(paidRootAfter !== paidRootBefore && paidRootAfter === gZ.root.toString(), "paid currentRoot changed == JS tree with P zeroed in place");
    ok((await stakedC.limitOf(A.leaf)) === 8n && (await stakedC.currentRoot()).toString() === stakedRootBefore, "staked contract untouched (A still tier 8, root unchanged)");
    ok(!/slash: leaf not held by the contract/.test(gw.out), "no default-tier fallback claim was needed (routing resolved the holder)");
  } finally {
    if (gw) gw.stop();
    for (const t of targets) t.close();
    anvil.kill();
    rmSync(work, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: paid-access selftest (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((e) => {
  // On stdout with a FAIL marker so scripts/test-all.mjs surfaces the cause, not just the last stderr line.
  console.log(`  FAIL (uncaught) ${e && e.stack ? e.stack.split("\n").join(" | ") : e}${e && e.code ? ` code=${e.code}` : ""}${e && e.path ? ` path=${e.path}` : ""}`);
  process.exit(1);
});
