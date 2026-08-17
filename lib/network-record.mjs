// Network records: the committed per-deployment truth under network/<name>/ (T-DEPLOY-5, GAP-2 +
// GAP-10 in docs/GO-LIVE.md), and the ONE place that turns them into RGOE_* defaults.
//
//   network/<name>/contracts.json   deployed contract addresses (+ tx / block per contract)
//   network/<name>/bootnode.json    the fleet's discovery inputs: bootnode onion, pinned signer,
//                                   admission mode, static-directory fallback
//
// Two jobs, both pure over the parsed JSON (the file I/O is a thin sync wrapper at the bottom):
//
//   1. validate*Record(obj)  — shape checks so a hand-edited or half-written record fails LOUDLY
//                              at load, not as an opaque crash later. Same posture as
//                              lib/config.mjs (which validates the env these records feed).
//   2. networkEnvDefaults()  — RGOE_NETWORK=<name> resolves the records into the env vars the
//                              client / bootnode / heartbeat / register-gateway / uptime probe
//                              already read. applyNetworkEnv() copies them into an env object
//                              WITHOUT overwriting anything already set: an explicit env var (or
//                              `rgoe --flag`) always beats the file. The record is a default, never
//                              an override, so an operator can pin a different bootnode or signer
//                              for testing without editing a committed file.
//
// "Not yet deployed" is REPRESENTED, not omitted: a contract slot (e.g. `contracts.gatewayRegistry`)
// or a discovery input (`bootnode.onion`) that is not live yet is `null`. Loaders treat null and a
// missing key identically (both mean "no default"), so a record can be committed with the schema
// slot in place BEFORE the broadcast happens (GO-LIVE row 3.2 / 7.1), and `scripts/record-deploy.mjs`
// fills it in one command afterwards. `status: "pending"` on bootnode.json says the same at the
// file level and is what a `live` record must NOT be.
//
// Privacy: records carry onions, pubkeys and contract addresses — the public discovery handles —
// and never IPs, keys, or operator identities beyond an EOA address. validate* rejects a record
// that smuggles an IP into a discovery field.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { isOnion, isEd25519PubHex, isEthAddress, isUrl } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const NETWORK_ROOT = join(HERE, "..", "network");

// A network name is a plain directory label (`sepolia`, `anvil-local`, `mainnet`): no path
// separators, no dots, so RGOE_NETWORK can never escape network/.
export function isNetworkName(v) {
  return typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v);
}

// A 32-byte tx hash, 0x-prefixed.
export function isTxHash(v) {
  return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v.trim());
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const looksLikeIp = (v) => typeof v === "string" && (IPV4.test(v) || /^[0-9a-f:]+:[0-9a-f:]+$/i.test(v.trim()));

// Contract slots a record may carry. Any slot may be null (= that contract not deployed on that network
// yet); `stakedReputationSet` is what every live record has so far. Unknown extra slots are
// allowed (a future contract just adds a key) but must still be address|null.
export const KNOWN_CONTRACTS = ["stakedReputationSet", "hasher", "withdrawVerifier", "gatewayRegistry"];
export const CONTRACTS_STATUS = ["live", "pending", "retired"];
export const BOOTNODE_STATUS = ["live", "pending", "retired"];
export const ADMISSION_MODES = ["open", "stake"];

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const addrOrNull = (v) => v === null || isEthAddress(v);
// Block numbers are JSON numbers (not strings), so `deployBlock: "123"` is a schema error.
const isBlock = (v) => Number.isInteger(v) && v >= 0;

// ---- contracts.json ----------------------------------------------------------------------
// {
//   network, chainId, status, release?, deployer?, rpcUrl?, params?,
//   contracts:    { <name>: 0xaddr | null, ... },   // null = slot exists, not deployed
//   deployTxs?:   { <name>: 0xtxhash | null, ... },
//   deployBlock?: N,                                 // block of the ORIGINAL deploy batch
//   deployBlocks?:{ <name>: N, ... },                // per-contract, for later additions
//   ...free-form documentation keys (circuit, note, liveIntegration) are ignored here
// }
export function validateContractsRecord(rec) {
  const errors = [];
  const bad = (field, problem) => errors.push({ field, problem });
  if (!isPlainObject(rec)) return { ok: false, errors: [{ field: "$", problem: "record must be a JSON object" }] };

  if (!isNetworkName(rec.network)) bad("network", "must be a network name (lowercase [a-z0-9-])");
  if (!Number.isInteger(rec.chainId) || rec.chainId < 1) bad("chainId", "must be a positive integer chain id");
  if (rec.status !== undefined && !CONTRACTS_STATUS.includes(rec.status)) bad("status", `must be one of: ${CONTRACTS_STATUS.join(", ")}`);
  if (rec.deployer !== undefined && rec.deployer !== null && !isEthAddress(rec.deployer)) bad("deployer", "must be a 0x address or null");
  if (rec.rpcUrl !== undefined && rec.rpcUrl !== null && !isUrl(rec.rpcUrl)) bad("rpcUrl", "must be an http(s)/ws(s) URL or null");

  if (!isPlainObject(rec.contracts)) bad("contracts", "must be an object of { name: 0xaddr | null }");
  else {
    for (const [name, v] of Object.entries(rec.contracts)) {
      if (!addrOrNull(v)) bad(`contracts.${name}`, "must be a 0x-prefixed 20-byte address, or null (= not deployed)");
    }
  }
  if (rec.deployTxs !== undefined) {
    if (!isPlainObject(rec.deployTxs)) bad("deployTxs", "must be an object of { name: 0xtxhash | null }");
    else for (const [name, v] of Object.entries(rec.deployTxs)) {
      if (!(v === null || isTxHash(v))) bad(`deployTxs.${name}`, "must be a 0x-prefixed 32-byte tx hash, or null");
      // A tx recorded for a slot that is null/missing is contradictory.
      if (v && rec.contracts && !isEthAddress(rec.contracts[name])) bad(`deployTxs.${name}`, `has a tx hash but contracts.${name} is not an address`);
    }
  }
  if (rec.deployBlock !== undefined && rec.deployBlock !== null && !isBlock(rec.deployBlock)) bad("deployBlock", "must be a non-negative integer");
  if (rec.deployBlocks !== undefined) {
    if (!isPlainObject(rec.deployBlocks)) bad("deployBlocks", "must be an object of { name: blockNumber }");
    else for (const [name, v] of Object.entries(rec.deployBlocks)) {
      if (!(v === null || isBlock(v))) bad(`deployBlocks.${name}`, "must be a non-negative integer, or null");
      if (v !== null && rec.contracts && !isEthAddress(rec.contracts[name])) bad(`deployBlocks.${name}`, `has a block but contracts.${name} is not an address`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// The address of one contract slot, or null when the slot is missing / null.
export function contractAddress(rec, name) {
  const v = rec && rec.contracts ? rec.contracts[name] : undefined;
  return isEthAddress(v) ? v : null;
}

// ---- bootnode.json -----------------------------------------------------------------------
// {
//   network, status: live|pending|retired,
//   onion:      <bootnode v3 .onion> | null,       // RGOE_BOOTNODE_ONION
//   signer:     <64-hex ed25519> | [<hex>, ...] | null, // RGOE_DIR_SIGNER (array = rotation
//                                                       // overlap allowlist, joined with ",")
//   admission:  open|stake,                         // what the bootnode enforces
//   staticDirectory?: { path: "directory.json", signer: <hex> | [<hex>] } | null,
//                                                   // cold-path fallback: RGOE_DIRECTORY +
//                                                   // its own pinned signer
//   deployedRef?, updated?, note?                   // documentation
// }
// `live` REQUIRES onion + signer (a live record without discovery inputs is a lie); `pending`
// tolerates nulls. Nothing here may look like an IP.
function signerListOk(v) {
  if (isEd25519PubHex(v)) return true;
  return Array.isArray(v) && v.length > 0 && v.every(isEd25519PubHex);
}
function signerToEnv(v) {
  return Array.isArray(v) ? v.map((s) => s.trim()).join(",") : v.trim();
}

export function validateBootnodeRecord(rec) {
  const errors = [];
  const bad = (field, problem) => errors.push({ field, problem });
  if (!isPlainObject(rec)) return { ok: false, errors: [{ field: "$", problem: "record must be a JSON object" }] };

  if (!isNetworkName(rec.network)) bad("network", "must be a network name (lowercase [a-z0-9-])");
  if (!BOOTNODE_STATUS.includes(rec.status)) bad("status", `must be one of: ${BOOTNODE_STATUS.join(", ")}`);
  if (!(rec.onion === null || isOnion(rec.onion))) bad("onion", looksLikeIp(rec.onion) ? "must be a v3 .onion, never an IP" : "must be a valid v3 .onion, or null (= not deployed)");
  if (!(rec.signer === null || signerListOk(rec.signer))) bad("signer", "must be a 64-hex ed25519 pubkey (no 0x), a non-empty array of them, or null");
  if (!ADMISSION_MODES.includes(rec.admission)) bad("admission", `must be one of: ${ADMISSION_MODES.join(", ")}`);
  if (rec.gatewayRegistry !== undefined && !addrOrNull(rec.gatewayRegistry)) bad("gatewayRegistry", "must be a 0x address or null (canonical home is contracts.json)");
  if (rec.staticDirectory !== undefined && rec.staticDirectory !== null) {
    const sd = rec.staticDirectory;
    if (!isPlainObject(sd)) bad("staticDirectory", "must be { path, signer } or null");
    else {
      if (typeof sd.path !== "string" || !sd.path || sd.path.includes("..") || isAbsolute(sd.path)) bad("staticDirectory.path", "must be a relative path inside network/<name>/ (no .., not absolute)");
      if (!signerListOk(sd.signer)) bad("staticDirectory.signer", "must be a 64-hex ed25519 pubkey or a non-empty array of them");
    }
  }
  if (rec.status === "live") {
    if (!isOnion(rec.onion)) bad("onion", "required (non-null) when status is live");
    if (!signerListOk(rec.signer)) bad("signer", "required (non-null) when status is live");
  }
  for (const k of ["note", "deployedRef", "updated"]) {
    if (rec[k] !== undefined && rec[k] !== null && typeof rec[k] !== "string") bad(k, "must be a string");
    if (typeof rec[k] === "string" && looksLikeIp(rec[k])) bad(k, "must not contain an IP address");
  }
  return { ok: errors.length === 0, errors };
}

// ---- loading -----------------------------------------------------------------------------
export function networkDir(name, root = NETWORK_ROOT) {
  if (!isNetworkName(name)) throw new Error(`RGOE_NETWORK: bad network name "${name}" (expected [a-z0-9-])`);
  return join(root, name);
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  try { return JSON.parse(raw); } catch (e) { throw new Error(`${path}: invalid JSON (${e.message})`); }
}

function throwIfInvalid(path, res) {
  if (res.ok) return;
  const lines = res.errors.map((e) => `  ${e.field}: ${e.problem}`).join("\n");
  throw new Error(`${path}: invalid record\n${lines}`);
}

// { name, dir, contracts: rec|null, bootnode: rec|null }. A missing file is null (no defaults
// from it); a present-but-invalid file THROWS (never silently ignore a broken record).
export function loadNetworkRecords(name, { root = NETWORK_ROOT } = {}) {
  const dir = networkDir(name, root);
  if (!existsSync(dir)) throw new Error(`RGOE_NETWORK=${name}: no such network record directory ${dir}`);
  const contractsPath = join(dir, "contracts.json");
  const bootnodePath = join(dir, "bootnode.json");
  const contracts = readJsonIfExists(contractsPath);
  if (contracts) throwIfInvalid(contractsPath, validateContractsRecord(contracts));
  const bootnode = readJsonIfExists(bootnodePath);
  if (bootnode) throwIfInvalid(bootnodePath, validateBootnodeRecord(bootnode));
  return { name, dir, contracts, bootnode };
}

// Pure: records -> { RGOE_*: value } defaults. Only keys with a resolvable value appear.
//   bootnode.json  -> RGOE_BOOTNODE_ONION, RGOE_DIR_SIGNER, RGOE_BOOTNODE_ADMISSION
//                     (fallback when the bootnode is not live: RGOE_DIRECTORY + RGOE_DIR_SIGNER
//                      from staticDirectory, so a pending fleet still has a cold path)
//   contracts.json -> RGOE_GATEWAY_REGISTRY, RGOE_GROUP_CONTRACT (= stakedReputationSet), RGOE_RPC_URL
export function envDefaultsFromRecords({ dir, contracts, bootnode }) {
  const out = {};
  if (bootnode) {
    const liveish = bootnode.status !== "retired";
    if (liveish && isOnion(bootnode.onion)) out.RGOE_BOOTNODE_ONION = bootnode.onion.trim();
    if (liveish && signerListOk(bootnode.signer)) out.RGOE_DIR_SIGNER = signerToEnv(bootnode.signer);
    if (liveish && bootnode.admission) out.RGOE_BOOTNODE_ADMISSION = bootnode.admission;
    // Cold path: no live bootnode onion -> point the client at the committed static directory,
    // pinned to THAT directory's signer. (If a bootnode is live it wins in client/selection.mjs
    // anyway, so we only wire the static path when there is no onion.)
    if (!out.RGOE_BOOTNODE_ONION && bootnode.staticDirectory && bootnode.staticDirectory.path) {
      const p = resolve(dir, bootnode.staticDirectory.path);
      if (existsSync(p)) {
        out.RGOE_DIRECTORY = p;
        if (!out.RGOE_DIR_SIGNER && signerListOk(bootnode.staticDirectory.signer)) out.RGOE_DIR_SIGNER = signerToEnv(bootnode.staticDirectory.signer);
      }
    }
  }
  if (contracts) {
    const reg = contractAddress(contracts, "gatewayRegistry");
    if (reg) out.RGOE_GATEWAY_REGISTRY = reg;
    const set = contractAddress(contracts, "stakedReputationSet");
    if (set) out.RGOE_GROUP_CONTRACT = set;
    if (isUrl(contracts.rpcUrl)) out.RGOE_RPC_URL = contracts.rpcUrl;
  }
  return out;
}

export function networkEnvDefaults(name, opts) {
  return envDefaultsFromRecords(loadNetworkRecords(name, opts));
}

// Copy the network defaults into `env` for every key NOT already set (empty string counts as
// unset). Returns the list of keys it filled. No-op (returns []) when RGOE_NETWORK is unset.
// Throws on a bad/invalid record — the caller decides whether that is fatal (rgoe: yes).
export function applyNetworkEnv(env = process.env, { name = env.RGOE_NETWORK, root } = {}) {
  if (!name) return [];
  const defaults = networkEnvDefaults(name, root ? { root } : undefined);
  const applied = [];
  for (const [k, v] of Object.entries(defaults)) {
    if (env[k] === undefined || env[k] === null || String(env[k]).trim() === "") { env[k] = v; applied.push(k); }
  }
  return applied;
}

// Best-effort variant for library defaults (lib/gateway-registry.mjs, group/register-gateway.mjs):
// the value of ONE default from RGOE_NETWORK, or null if unset / unresolvable. Never throws, so a
// missing/invalid record cannot break a code path that only wanted a default.
export function networkDefault(key, env = process.env) {
  try {
    if (!env.RGOE_NETWORK) return null;
    return networkEnvDefaults(env.RGOE_NETWORK)[key] ?? null;
  } catch {
    return null;
  }
}
