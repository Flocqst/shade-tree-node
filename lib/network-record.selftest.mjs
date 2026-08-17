// Selftest for lib/network-record.mjs — the network/<name>/{contracts,bootnode}.json schema +
// the RGOE_NETWORK -> RGOE_* defaults resolver (T-DEPLOY-5, GAP-2 / GAP-10).
//
// Covers: contracts.json accepts a present-null AND a present-address gatewayRegistry, rejects
// malformed addresses / tx hashes / blocks / contradictory tx-without-address; bootnode.json
// live-vs-pending rules, signer allowlist arrays, IP smuggling rejected; the COMMITTED
// network/sepolia records validate; env resolution fills only UNSET keys (env beats file), a
// pending bootnode falls back to the static directory, a null registry supplies no default,
// networkDefault never throws; adversarial: bad network names cannot escape network/.
//
//   node lib/network-record.selftest.mjs
//
// Exit 0 = all invariants held. Filesystem: a temp dir only (plus a read of network/sepolia).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { pubkeyToOnion } from "./directory.mjs";
import {
  validateContractsRecord, validateBootnodeRecord, contractAddress, isNetworkName, isTxHash,
  loadNetworkRecords, envDefaultsFromRecords, networkEnvDefaults, applyNetworkEnv, networkDefault,
} from "./network-record.mjs";

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { console.log(`  FAIL ${msg}`); failures++; } };
const errFields = (res) => res.errors.map((e) => e.field);

function newEd() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("hex");
}
const SIGNER = newEd();
const SIGNER2 = newEd();
const ONION = pubkeyToOnion(newEd());
const ADDR = "0x" + "ab".repeat(20);
const ADDR2 = "0x" + "cd".repeat(20);
const TX = "0x" + "12".repeat(32);

const goodContracts = () => ({
  network: "testnet", chainId: 31337, status: "live", deployer: ADDR, rpcUrl: "http://127.0.0.1:8545",
  contracts: { stakedReputationSet: ADDR, hasher: ADDR, withdrawVerifier: ADDR, gatewayRegistry: null },
  deployTxs: { stakedReputationSet: TX, gatewayRegistry: null },
  deployBlock: 100, deployBlocks: {},
});
const goodBootnode = () => ({ network: "testnet", status: "live", onion: ONION, signer: SIGNER, admission: "open" });

function main() {
  console.log("contracts.json schema:");
  {
    ok(validateContractsRecord(goodContracts()).ok, "valid record with gatewayRegistry: null passes (present-null)");
    const c = goodContracts(); c.contracts.gatewayRegistry = ADDR2; c.deployTxs.gatewayRegistry = TX; c.deployBlocks.gatewayRegistry = 200;
    ok(validateContractsRecord(c).ok, "valid record with gatewayRegistry address + tx + block passes (present-address)");
    ok(contractAddress(c, "gatewayRegistry") === ADDR2, "contractAddress returns the address");
    ok(contractAddress(goodContracts(), "gatewayRegistry") === null, "contractAddress is null for a null slot");
    ok(contractAddress(goodContracts(), "nope") === null, "contractAddress is null for a missing slot");
    const missing = goodContracts(); delete missing.contracts.gatewayRegistry;
    ok(validateContractsRecord(missing).ok, "a record WITHOUT the gatewayRegistry key is still valid (missing == null)");

    const b1 = goodContracts(); b1.contracts.gatewayRegistry = "0x1234";
    ok(errFields(validateContractsRecord(b1)).includes("contracts.gatewayRegistry"), "short address rejected on contracts.gatewayRegistry");
    const b2 = goodContracts(); b2.contracts.gatewayRegistry = "pending";
    ok(!validateContractsRecord(b2).ok, "the string 'pending' is not an accepted address (null is the representation)");
    const b3 = goodContracts(); b3.deployTxs.gatewayRegistry = TX; // tx but slot null
    ok(errFields(validateContractsRecord(b3)).includes("deployTxs.gatewayRegistry"), "tx hash for a null slot is contradictory -> rejected");
    const b4 = goodContracts(); b4.deployTxs.stakedReputationSet = "0xzz";
    ok(errFields(validateContractsRecord(b4)).includes("deployTxs.stakedReputationSet"), "malformed tx hash rejected");
    const b5 = goodContracts(); b5.deployBlock = "100";
    ok(errFields(validateContractsRecord(b5)).includes("deployBlock"), "string deployBlock rejected (must be a JSON number)");
    const b6 = goodContracts(); b6.deployBlocks = { gatewayRegistry: 5 };
    ok(errFields(validateContractsRecord(b6)).includes("deployBlocks.gatewayRegistry"), "block for a null slot rejected");
    const b7 = goodContracts(); b7.chainId = "11155111";
    ok(errFields(validateContractsRecord(b7)).includes("chainId"), "string chainId rejected");
    const b8 = goodContracts(); b8.status = "deployed";
    ok(errFields(validateContractsRecord(b8)).includes("status"), "unknown status rejected");
    const b9 = goodContracts(); b9.contracts = [];
    ok(errFields(validateContractsRecord(b9)).includes("contracts"), "contracts must be an object");
    ok(!validateContractsRecord(null).ok && !validateContractsRecord("x").ok && !validateContractsRecord([]).ok, "non-object records rejected (total)");
    ok(isTxHash(TX) && !isTxHash(TX.slice(0, 40)) && !isTxHash(TX.slice(2)), "isTxHash: 0x + 64 hex only");
  }

  console.log("\npayments slots (T-FEAT-7): payAsset + registrar + paidAccessSet:");
  {
    const c = goodContracts();
    c.contracts.paidAccessSet = ADDR2;
    c.payAsset = { address: ADDR, name: "USDC", symbol: "USDC", version: "2", decimals: 6, kind: "usdc", deployTx: null, note: "Circle testnet USDC" };
    c.registrar = { port: 8878, protocols: ["x402", "mpp"], prices: { "8": "100000", "32": "400000" }, note: "on the bootnode onion" };
    ok(validateContractsRecord(c).ok, "record with paidAccessSet + payAsset + registrar passes");
    const d = envDefaultsFromRecords({ dir: "/nonexistent", contracts: c, bootnode: null });
    ok(d.RGOE_PAID_ACCESS_CONTRACT === ADDR2 && d.RGOE_PAY_ASSET === ADDR && d.RGOE_REGISTRAR_PORT === "8878", "-> RGOE_PAID_ACCESS_CONTRACT / RGOE_PAY_ASSET / RGOE_REGISTRAR_PORT defaults");
    const n = goodContracts(); n.payAsset = null; n.registrar = null;
    ok(validateContractsRecord(n).ok && !("RGOE_PAY_ASSET" in envDefaultsFromRecords({ dir: "/x", contracts: n, bootnode: null })), "null payAsset/registrar = not sold here (valid, no defaults)");
    const bad = [
      [(r) => { r.payAsset = { address: "0x12" }; }, "payAsset.address"],
      [(r) => { r.payAsset = { address: ADDR, decimals: 300 }; }, "payAsset.decimals"],
      [(r) => { r.payAsset = { address: ADDR, deployTx: "0xzz" }; }, "payAsset.deployTx"],
      [(r) => { r.payAsset = "usdc"; }, "payAsset"],
      [(r) => { r.registrar = { port: 0, protocols: ["x402"] }; }, "registrar.port"],
      [(r) => { r.registrar = { port: 8878, protocols: ["l402"] }; }, "registrar.protocols"],
      [(r) => { r.registrar = { port: 8878, protocols: [] }; }, "registrar.protocols"],
      [(r) => { r.registrar = { port: 8878, protocols: ["mpp"], prices: { "8": 100000 } }; }, "registrar.prices"],
      [(r) => { r.registrar = { port: 8878, protocols: ["mpp"], note: "box at 10.0.0.1" }; }, "registrar.note"],
    ];
    for (const [mut, field] of bad) {
      const r = goodContracts(); mut(r);
      const res = validateContractsRecord(r);
      ok(!res.ok && res.errors.some((e) => e.field === field), `rejects bad ${field}`);
    }
  }

  console.log("\nbootnode.json schema:");
  {
    ok(validateBootnodeRecord(goodBootnode()).ok, "live record with onion + signer + admission passes");
    ok(validateBootnodeRecord({ network: "t", status: "pending", onion: null, signer: null, admission: "open" }).ok, "pending template with nulls passes");
    const arr = goodBootnode(); arr.signer = [SIGNER, SIGNER2];
    ok(validateBootnodeRecord(arr).ok, "signer may be an array (rotation overlap allowlist)");
    const sd = { ...goodBootnode(), status: "pending", onion: null, signer: null, staticDirectory: { path: "directory.json", signer: SIGNER } };
    ok(validateBootnodeRecord(sd).ok, "staticDirectory { path, signer } accepted");

    const l1 = { ...goodBootnode(), onion: null };
    ok(errFields(validateBootnodeRecord(l1)).includes("onion"), "live WITHOUT onion rejected");
    const l2 = { ...goodBootnode(), signer: null };
    ok(errFields(validateBootnodeRecord(l2)).includes("signer"), "live WITHOUT signer rejected");
    const l3 = { ...goodBootnode(), onion: "10.0.0.7" };
    ok(errFields(validateBootnodeRecord(l3)).includes("onion") && /never an IP/.test(validateBootnodeRecord(l3).errors[0].problem), "an IP in `onion` is rejected with the IP message");
    const l4 = { ...goodBootnode(), note: "box at 165.227.118.154" };
    ok(errFields(validateBootnodeRecord(l4)).includes("note"), "an IP smuggled into `note` is rejected");
    const l5 = { ...goodBootnode(), signer: "0x" + SIGNER };
    ok(errFields(validateBootnodeRecord(l5)).includes("signer"), "0x-prefixed signer rejected (RGOE_DIR_SIGNER is bare hex)");
    const l6 = { ...goodBootnode(), signer: [] };
    ok(errFields(validateBootnodeRecord(l6)).includes("signer"), "empty signer array rejected");
    const l7 = { ...goodBootnode(), admission: "closed" };
    ok(errFields(validateBootnodeRecord(l7)).includes("admission"), "unknown admission rejected");
    const l8 = { ...goodBootnode(), status: "up" };
    ok(errFields(validateBootnodeRecord(l8)).includes("status"), "unknown status rejected");
    const l9 = { ...goodBootnode(), staticDirectory: { path: "../../etc/passwd", signer: SIGNER } };
    ok(errFields(validateBootnodeRecord(l9)).includes("staticDirectory.path"), "staticDirectory.path may not escape the network dir");
    const l10 = { ...goodBootnode(), staticDirectory: { path: "/abs/dir.json", signer: SIGNER } };
    ok(errFields(validateBootnodeRecord(l10)).includes("staticDirectory.path"), "absolute staticDirectory.path rejected");
    const l11 = { ...goodBootnode(), gatewayRegistry: "0xnope" };
    ok(errFields(validateBootnodeRecord(l11)).includes("gatewayRegistry"), "optional gatewayRegistry must be address|null");
    ok(!validateBootnodeRecord(null).ok && !validateBootnodeRecord(42).ok, "non-object rejected (total)");
  }

  console.log("\nnetwork names:");
  {
    ok(isNetworkName("sepolia") && isNetworkName("anvil-local") && isNetworkName("mainnet"), "plain names accepted");
    for (const bad of ["../sepolia", "sepolia/..", "Sepolia", "", "a b", "sep.olia", "-x", "x".repeat(65)]) {
      ok(!isNetworkName(bad), `bad name rejected: ${JSON.stringify(bad)}`);
    }
    let threw = false;
    try { loadNetworkRecords("../lib"); } catch { threw = true; }
    ok(threw, "loadNetworkRecords refuses a path-traversal name");
    threw = false;
    try { loadNetworkRecords("no-such-network-zzz"); } catch (e) { threw = /no such network/.test(e.message); }
    ok(threw, "loadNetworkRecords throws on an unknown network");
  }

  console.log("\ncommitted network/sepolia records:");
  {
    const r = loadNetworkRecords("sepolia");
    ok(r.contracts && r.contracts.chainId === 11155111, "network/sepolia/contracts.json loads + validates");
    ok("gatewayRegistry" in r.contracts.contracts, "sepolia contracts.json carries the gatewayRegistry slot");
    ok(r.bootnode && ["live", "pending"].includes(r.bootnode.status), "network/sepolia/bootnode.json loads + validates");
    const d = envDefaultsFromRecords(r);
    ok(d.RGOE_RPC_URL === r.contracts.rpcUrl, "sepolia rpcUrl resolves to RGOE_RPC_URL");
    ok(d.RGOE_GROUP_CONTRACT === r.contracts.contracts.stakedReputationSet, "sepolia stakedReputationSet -> RGOE_GROUP_CONTRACT");
    ok(d.RGOE_DIR_SIGNER && d.RGOE_DIR_SIGNER.length >= 64, "sepolia resolves a pinned signer (live bootnode or static directory)");
    ok(Boolean(d.RGOE_BOOTNODE_ONION) || Boolean(d.RGOE_DIRECTORY), "sepolia resolves a discovery source (bootnode onion or static RGOE_DIRECTORY)");
    if (r.contracts.contracts.gatewayRegistry === null) ok(!("RGOE_GATEWAY_REGISTRY" in d), "null gatewayRegistry supplies NO RGOE_GATEWAY_REGISTRY default");
    const s = JSON.stringify(r.bootnode);
    ok(!/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(s), "sepolia bootnode.json contains no IPv4 address");
  }

  console.log("\nenv resolution (temp network dir):");
  {
    const root = mkdtempSync(join(tmpdir(), "rgoe-net-"));
    const dir = join(root, "testnet"); mkdirSync(dir);
    const c = goodContracts(); c.contracts.gatewayRegistry = ADDR2;
    writeFileSync(join(dir, "contracts.json"), JSON.stringify(c));
    writeFileSync(join(dir, "bootnode.json"), JSON.stringify({ ...goodBootnode(), signer: [SIGNER, SIGNER2], admission: "stake" }));
    writeFileSync(join(dir, "directory.json"), "{}");

    const d = networkEnvDefaults("testnet", { root });
    ok(d.RGOE_BOOTNODE_ONION === ONION, "live bootnode onion -> RGOE_BOOTNODE_ONION");
    ok(d.RGOE_DIR_SIGNER === `${SIGNER},${SIGNER2}`, "signer array -> comma-joined RGOE_DIR_SIGNER (rotation allowlist)");
    ok(d.RGOE_BOOTNODE_ADMISSION === "stake", "admission -> RGOE_BOOTNODE_ADMISSION");
    ok(d.RGOE_GATEWAY_REGISTRY === ADDR2, "gatewayRegistry address -> RGOE_GATEWAY_REGISTRY");
    ok(d.RGOE_GROUP_CONTRACT === ADDR, "stakedReputationSet -> RGOE_GROUP_CONTRACT");
    ok(!("RGOE_PAID_ACCESS_CONTRACT" in d), "no paidAccessSet slot -> no RGOE_PAID_ACCESS_CONTRACT default");
    ok(!("RGOE_DIRECTORY" in d), "with a live bootnode the static directory is NOT wired (bootnode wins)");
    // T-FEAT-7: a paidAccessSet slot resolves to RGOE_PAID_ACCESS_CONTRACT (env still beats file)
    const cp = goodContracts(); cp.contracts.paidAccessSet = ADDR2; cp.deployTxs.paidAccessSet = TX; cp.deployBlocks.paidAccessSet = 300;
    ok(validateContractsRecord(cp).ok, "paidAccessSet slot + tx + block validates");
    writeFileSync(join(dir, "contracts.json"), JSON.stringify(cp));
    const dpaid = networkEnvDefaults("testnet", { root });
    ok(dpaid.RGOE_PAID_ACCESS_CONTRACT === ADDR2 && dpaid.RGOE_GROUP_CONTRACT === ADDR, "paidAccessSet -> RGOE_PAID_ACCESS_CONTRACT next to RGOE_GROUP_CONTRACT");
    const envp = { RGOE_NETWORK: "testnet", RGOE_PAID_ACCESS_CONTRACT: "explicit" };
    applyNetworkEnv(envp, { root });
    ok(envp.RGOE_PAID_ACCESS_CONTRACT === "explicit", "explicit RGOE_PAID_ACCESS_CONTRACT is NOT overwritten by the record");
    const cpn = goodContracts(); cpn.contracts.paidAccessSet = null;
    writeFileSync(join(dir, "contracts.json"), JSON.stringify(cpn));
    ok(!("RGOE_PAID_ACCESS_CONTRACT" in networkEnvDefaults("testnet", { root })), "null paidAccessSet supplies no RGOE_PAID_ACCESS_CONTRACT");
    const cpb = goodContracts(); cpb.contracts.paidAccessSet = "0x1234";
    ok(errFields(validateContractsRecord(cpb)).includes("contracts.paidAccessSet"), "malformed paidAccessSet address rejected");
    writeFileSync(join(dir, "contracts.json"), JSON.stringify(c));

    // env beats file
    const env = { RGOE_NETWORK: "testnet", RGOE_DIR_SIGNER: "explicit", RGOE_BOOTNODE_ONION: "" };
    const filled = applyNetworkEnv(env, { root });
    ok(env.RGOE_DIR_SIGNER === "explicit", "explicit env RGOE_DIR_SIGNER is NOT overwritten by the record");
    ok(env.RGOE_BOOTNODE_ONION === ONION && filled.includes("RGOE_BOOTNODE_ONION"), "empty-string env counts as unset and is filled");
    ok(env.RGOE_GATEWAY_REGISTRY === ADDR2, "unset RGOE_GATEWAY_REGISTRY filled from the record");
    ok(applyNetworkEnv({}, { root }).length === 0, "no RGOE_NETWORK -> applyNetworkEnv is a no-op");

    // pending bootnode + static fallback + null registry
    writeFileSync(join(dir, "bootnode.json"), JSON.stringify({ network: "testnet", status: "pending", onion: null, signer: null, admission: "open", staticDirectory: { path: "directory.json", signer: SIGNER } }));
    writeFileSync(join(dir, "contracts.json"), JSON.stringify(goodContracts()));
    const p = networkEnvDefaults("testnet", { root });
    ok(!("RGOE_BOOTNODE_ONION" in p), "pending bootnode (onion null) supplies no RGOE_BOOTNODE_ONION");
    ok(p.RGOE_DIRECTORY === join(dir, "directory.json") && p.RGOE_DIR_SIGNER === SIGNER, "pending bootnode falls back to staticDirectory path + its signer");
    ok(!("RGOE_GATEWAY_REGISTRY" in p), "null gatewayRegistry supplies no RGOE_GATEWAY_REGISTRY");
    ok(!("RGOE_BOOTNODE_ADMISSION" in p) || p.RGOE_BOOTNODE_ADMISSION === "open", "admission still reported for a pending record");

    // static directory path missing on disk -> not wired
    rmSync(join(dir, "directory.json"));
    const q = networkEnvDefaults("testnet", { root });
    ok(!("RGOE_DIRECTORY" in q) && !("RGOE_DIR_SIGNER" in q), "staticDirectory whose file is absent is not wired");

    // retired bootnode supplies nothing
    writeFileSync(join(dir, "bootnode.json"), JSON.stringify({ ...goodBootnode(), status: "retired" }));
    const rt = networkEnvDefaults("testnet", { root });
    ok(!("RGOE_BOOTNODE_ONION" in rt) && !("RGOE_DIR_SIGNER" in rt), "retired bootnode supplies no discovery defaults");

    // invalid record throws (never silently ignored)
    writeFileSync(join(dir, "bootnode.json"), JSON.stringify({ ...goodBootnode(), onion: null }));
    let threw = false;
    try { networkEnvDefaults("testnet", { root }); } catch (e) { threw = /invalid record/.test(e.message) && /onion/.test(e.message); }
    ok(threw, "an invalid bootnode.json throws naming the field");
    writeFileSync(join(dir, "bootnode.json"), "{not json");
    threw = false;
    try { networkEnvDefaults("testnet", { root }); } catch (e) { threw = /invalid JSON/.test(e.message); }
    ok(threw, "malformed JSON throws");
    rmSync(join(dir, "bootnode.json"));
    const noBoot = networkEnvDefaults("testnet", { root });
    ok(noBoot.RGOE_RPC_URL && !("RGOE_BOOTNODE_ONION" in noBoot), "a network with contracts.json but no bootnode.json still resolves contract defaults");

    // networkDefault never throws
    ok(networkDefault("RGOE_GATEWAY_REGISTRY", { RGOE_NETWORK: "no-such-network-zzz" }) === null, "networkDefault -> null on unknown network (no throw)");
    ok(networkDefault("RGOE_GATEWAY_REGISTRY", {}) === null, "networkDefault -> null without RGOE_NETWORK");
    ok(networkDefault("RGOE_GATEWAY_REGISTRY", { RGOE_NETWORK: "../x" }) === null, "networkDefault -> null on a traversal name");

    rmSync(root, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall network-record checks passed");
  process.exit(failures ? 1 : 0);
}

main();
