// RootProvider: the pluggable source of the on-chain reputation-set Merkle root(s).
//
// The gateway does not care HOW it learned the root, only which roots it will accept
// proofs against right now. So the source sits behind one interface and is chosen at
// config time (RGOE_ROOT_PROVIDER=node|light). See docs/ONCHAIN.md, "Reading the root".
//
//   currentRoots() -> { roots: string[], observedAtBlock: number, finalized: boolean }
//        roots = the current root plus every root still inside the freshness window F.
//   onChange(cb)   -> unsubscribe        (optional; refresh promptly on membership change)
//
// Two providers, interchangeable:
//   - NodeRootProvider  : trusted local node. The solo-staker path: someone running this
//                         next to their validator already has a trusted node, so this is
//                         optimal for them, not a compromise. Point RGOE_RPC_URL at it.
//                         Implemented here in EVENT-RECONSTRUCTION mode: eth_getLogs the
//                         contract's Member* events and rebuild the LeanIMT locally
//                         (StakedReputationSet keeps the tree off chain; contracts/README).
//   - LightClientRootProvider : proves the root's on-chain storage slot with eth_getProof
//                         (EIP-1186 MPT) against a block stateRoot. The stateRoot is RPC-
//                         trusted by default; set RGOE_HELIOS_RPC_URL (a local Helios
//                         verifying RPC, lib/helios-root.mjs) to anchor it to the beacon
//                         sync committee instead -- then no RPC trust remains (T-DEV-9b).
//
// Zero extra runtime deps: JSON-RPC over global fetch (Node 18+) + the Semaphore Group
// (already a dependency) for the LeanIMT. Event topic0 hashes are precomputed + hardcoded
// below (keccak256 of the event signature) so this file needs no keccak dep at runtime.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// Build the tree with the RLN v3 depth-20 Poseidon tree (newGroup), NOT the app's
// top-level Semaphore v4 LeanIMT — only the former matches the circom-rln circuit root.
// The indexed event value (topics[1]) is now the rateCommitment leaf.
import { newGroup } from "./rln.mjs";
import { makeHeliosTrustedStateRoot } from "./helios-root.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Env knobs are read at CALL time (not import time) so a process that imports this module early
// (the client library does, T-FEAT-7) and sets RGOE_* later still gets the intended values.
const CONFIRMATIONS = () => Number(process.env.RGOE_CONFIRMATIONS || 0); // 0 = use finalized
const RPC_URL = () => process.env.RGOE_RPC_URL || "http://127.0.0.1:8545";
const FRESHNESS_ROOTS = () => Number(process.env.RGOE_FRESHNESS_ROOTS || 2); // current + how many prior
const FROM_BLOCK = () => process.env.RGOE_FROM_BLOCK || "0x0"; // deploy block; 0x0 fine on anvil
const HELIOS_RPC_URL = () => process.env.RGOE_HELIOS_RPC_URL || ""; // T-DEV-9b: local Helios anchor (light provider only)

// parseContractList("0xA, 0xB,0xA") -> ["0xA", "0xB"]: the comma-separated address list form
// of RGOE_GROUP_CONTRACT (T-FEAT-7: several sets trusted at once). Trimmed, empties dropped,
// de-duplicated case-insensitively (first spelling wins). A single value is a one-element list.
export function parseContractList(spec) {
  const out = [];
  const seen = new Set();
  for (const part of String(spec == null ? "" : spec).split(",")) {
    const a = part.trim();
    if (!a) continue;
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

// The configured contract SOURCES, in trust order: every RGOE_GROUP_CONTRACT entry (kind
// "staked"), then RGOE_PAID_ACCESS_CONTRACT (kind "paid"; sugar that appends a PaidAccessSet —
// docs/PAYMENTS.md). Each -> { address, kind }. A paid address that also appears in the group
// list keeps its first (staked) position but is tagged "paid" so the startup log names it right.
export function configuredContracts(env = process.env) {
  const out = parseContractList(env.RGOE_GROUP_CONTRACT).map((address) => ({ address, kind: "staked" }));
  const paid = parseContractList(env.RGOE_PAID_ACCESS_CONTRACT);
  for (const address of paid) {
    const dup = out.find((c) => c.address.toLowerCase() === address.toLowerCase());
    if (dup) dup.kind = "paid";
    else out.push({ address, kind: "paid" });
  }
  return out;
}

// Contract address: contracts/deployed.local.json (written by the deploy) wins, else env.
// With a LIST in RGOE_GROUP_CONTRACT the FIRST entry is this (single) provider's contract; the
// composite provider (makeRootProvider) is what fans out over the whole list.
function resolveContract(explicit) {
  if (explicit) return explicit;
  if (process.env.RGOE_GROUP_CONTRACT) return parseContractList(process.env.RGOE_GROUP_CONTRACT)[0] || "";
  try {
    const raw = JSON.parse(
      readFileSync(join(HERE, "..", "contracts", "deployed.local.json"), "utf8")
    );
    // be liberal in what we accept from Track 1's deploy JSON
    return (
      raw.stakedReputationSet ||
      raw.StakedReputationSet ||
      raw.address ||
      raw.group ||
      (raw.contracts && (raw.contracts.StakedReputationSet || raw.contracts.stakedReputationSet)) ||
      ""
    );
  } catch {
    return "";
  }
}

// ---- Member* event topic0 (keccak256 of the signature) ----------------------
// Precomputed; recompute with: node -e "import('ethers').then(({id})=>console.log(id('MemberRegistered(uint256,uint64,uint256)')))"
// Two generations of the set emit two shapes of register/slash event: rln-v3 (no limit) and
// rln-v4 (T-FEAT-8b: a trailing non-indexed `limit`). Both carry the rateCommitment as
// topics[1], so reconstruction is identical; we accept either topic0 so ONE provider reads
// either deployment (the fleet's rln-v3 slasher and the rln-v4 tiered set coexist).
const TOPIC = {
  registered: "0x0dbb6a3ed41d8f3d21e481b86d0e8bbf65a630b7dc4c5ee6c2c1a74561841e6d", // MemberRegistered(uint256,uint64)          rln-v3
  registeredV4: "0x509c8735bf3647b16c92625a43b5459d0b51845aa0f3ec846f9d24594e7b824b", // MemberRegistered(uint256,uint64,uint256)  rln-v4
  exiting: "0x971e754215411b0ec07054d759063d876d53872b7d4b37294744e5a776604f37", // MemberExiting(uint256,uint64,uint64)
  withdrawn: "0x8f2d81dd61a3f7ff90ea7265e45192f03f643615dd2458e287d84aaac222ffe9", // MemberWithdrawn(uint256,address)
  slashed: "0x707cd9719d0c14265b9e456f7add99095401f907e570e5cdd65a92920947c450", // MemberSlashed(uint256,address)            rln-v3
  slashedV4: "0x0a39eb0fcb6a37e10a529e106ae887cbd1721626fa57900170ed0c2437af3797", // MemberSlashed(uint256,address,uint256)    rln-v4
  // PaidAccessSet (T-FEAT-7, docs/PAYMENTS.md, ADR 0007): the same tree, fed by operator inserts
  // after an off-chain (HTTP 402) payment. Its events carry the rateCommitment as topics[1] too, so
  // ONE reconstruction serves staked and paid sets alike. Both spellings of the append event are
  // accepted (`Inserted` = the insert-only contract; `Deposit` = the earlier payable draft), each
  // (commitment indexed, limit, index, root); the removal event is `Slashed` with the same fields.
  inserted: "0x829b3fd9a2105b78eea5138f4d692eb507be107a9b265a9456ea94fb2db9f992", // Inserted(uint256,uint256,uint256,uint256)  paid: append (operator insert)
  deposit: "0x9b776d199f09c774f5b205c9bc2ac6f40d508c347aaea919867eeaf06ebef0e9", // Deposit(uint256,uint256,uint256,uint256)   paid: append
  paidSlashed: "0xac0c8be2061774c705c517af2a774ab5cb33a2d7fe7054dd4a2728433026029c", // Slashed(uint256,uint256,uint256,uint256)   paid: zero in place
};
const ALL_TOPICS = [TOPIC.registered, TOPIC.registeredV4, TOPIC.exiting, TOPIC.withdrawn, TOPIC.slashed, TOPIC.slashedV4, TOPIC.inserted, TOPIC.deposit, TOPIC.paidSlashed];
const REGISTERED_TOPICS = new Set([TOPIC.registered, TOPIC.registeredV4, TOPIC.inserted, TOPIC.deposit]);
const REMOVED_TOPICS = new Set([TOPIC.exiting, TOPIC.withdrawn, TOPIC.slashed, TOPIC.slashedV4, TOPIC.paidSlashed]);

// ---- minimal JSON-RPC -------------------------------------------------------

let rpcId = 0;
async function rpc(method, params, url = RPC_URL()) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

async function blockNumber(tag = "latest", url = RPC_URL()) {
  const b = await rpc("eth_getBlockByNumber", [tag, false], url);
  return b ? Number(BigInt(b.number)) : null;
}

// ---- shared last-known-good cache ------------------------------------------

function withCache(fetchFresh) {
  let lkg = null; // { roots, observedAtBlock, finalized }
  return async function currentRoots() {
    try {
      const fresh = await fetchFresh();
      if (fresh && fresh.roots && fresh.roots.length) lkg = fresh;
      return fresh;
    } catch (e) {
      if (lkg) return { ...lkg, stale: true, error: e.message };
      throw e;
    }
  };
}

// ---- NodeRootProvider (trusted local node, event reconstruction) ------------

export function NodeRootProvider({ rpcUrl = RPC_URL(), contract } = {}) {
  const addr = resolveContract(contract);
  if (!addr) throw new Error("NodeRootProvider needs a contract (deployed.local.json or RGOE_GROUP_CONTRACT)");

  // a small ring of recent roots so a proof built against a just-superseded root still
  // verifies inside the freshness window F.
  let ring = [];
  const pushRoot = (root) => {
    if (root && ring[0] !== root) ring.unshift(root);
    ring = ring.slice(0, FRESHNESS_ROOTS());
    return ring.slice();
  };

  // Read the confirmation-depth block: finalized (CONFIRMATIONS=0) or head - N.
  async function readBlockTag() {
    const confirmations = CONFIRMATIONS();
    if (confirmations <= 0) return "finalized";
    const head = await blockNumber("latest", rpcUrl); // the provider's OWN endpoint, not the env default
    if (head == null) return "latest";
    return "0x" + BigInt(Math.max(0, head - confirmations)).toString(16);
  }

  const currentRoots = withCache(async () => {
    const tag = await readBlockTag();
    const blk = await rpc("eth_getBlockByNumber", [tag, false], rpcUrl);
    const observedAtBlock = blk ? Number(BigInt(blk.number)) : null;
    const toBlock = blk ? blk.number : tag;

    // eth_getLogs the Member*/Deposit/Slashed events up to the confirmation-depth block.
    const logs = await fetchMemberLogs({ contract: addr, rpcUrl, fromBlock: FROM_BLOCK(), toBlock });

    const { root, active } = reconstructGroup(logs);
    return { roots: pushRoot(root), observedAtBlock, finalized: tag === "finalized", leafCount: active };
  });

  const describe = () => ({ provider: "node", stateRootSource: "trusted node (RPC trusted by design; solo-staker path)", stateRootVerified: false, contract: addr });
  return { currentRoots, onChange: pollOnChange(currentRoots), describe, contract: addr };
}

// eth_getLogs of every membership event this module understands (both StakedReputationSet
// generations + PaidAccessSet), for `contract`, in [fromBlock, toBlock]. Single range; for a
// large L1 history you would page this — fine for anvil / a small set. Exported for the client's
// leaf discovery (loadGroupFromContract) and the `rgoe leaves` exporter.
export async function fetchMemberLogs({ contract, rpcUrl = RPC_URL(), fromBlock = FROM_BLOCK(), toBlock = "latest" } = {}) {
  if (!contract) throw new Error("fetchMemberLogs needs a contract address");
  return rpc("eth_getLogs", [{ address: contract, fromBlock, toBlock, topics: [ALL_TOPICS] }], rpcUrl);
}

// loadGroupFromContract({ contract, rpcUrl, blockTag }) -> { group, root, count, leaves, contract }:
// the CLIENT-side twin of NodeRootProvider — rebuild the whole tree (not just the root) from the
// event log so a member can generate a Merkle proof for its leaf under a staked or paid set.
// `leaves` = the LIVE leaves (decimal strings; zeroed slots excluded), `group.members` = the
// ordered leaf array including in-place zeros. Same shape as lib/rln.mjs loadGroup, so it plugs
// straight into makeSlotPool's loadGroupFn.
export async function loadGroupFromContract({ contract, rpcUrl = RPC_URL(), fromBlock = FROM_BLOCK(), blockTag = "latest" } = {}) {
  const logs = await fetchMemberLogs({ contract, rpcUrl, fromBlock, toBlock: blockTag });
  const { group, liveIndex, root, active } = reconstructGroup(logs);
  return { group, root, count: active, leaves: Array.from(liveIndex.keys()), contract };
}

// Rebuild the admission tree from ordered Member* logs and compute the depth-20 RLN root
// by REPLAYING the contract's own state transitions in block/logIndex order. Client and
// gateway both run this and must agree with each other AND with the leaf indices the
// contract assigns, so their roots agree by construction (the PoC keeps the tree off
// chain; contracts/README).
//
// REMOVAL SEMANTICS — zero-in-place (T-DEV-2). The contract (StakedReputationSet.sol)
// assigns every member an IMMUTABLE append-only leaf `index` at register (`nextIndex++`,
// never decremented, never reused) and a slash/exit/withdraw DELETES that member while
// leaving every other member's index untouched (see test_ReRegister_AfterSlash: a
// re-registered commitment gets a FRESH index, the old slot stays vacated). That is the
// standard Semaphore/RLN convention: a removed leaf is set to the tree's zero value AT ITS
// ORIGINAL INDEX, survivors keep their indices and Merkle paths, the root is recomputed
// over the zeroed leaf. So we mirror the contract exactly:
//   register  -> addMember (appends at the next index == the contract's nextIndex)
//   remove    -> removeMember(originalIndex) (Semaphore Group.delete: zero-in-place)
// The earlier implementation rebuilt a FRESH tree of the survivors, renumbering their
// indices — that produced a DIFFERENT root after any removal (and silently dropped a
// legitimately re-registered member), diverging from the contract. Fixed here.
export function reconstructRoot(logs) {
  return reconstructGroup(logs).root;
}

// reconstructGroup(logs) -> { group, liveIndex, active, root }: the replayed tree itself (root
// = null when no member is live), its live commitment -> leaf-index map, and the live count.
export function reconstructGroup(logs) {
  const ordered = [...logs].sort(
    (a, b) =>
      Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
      Number(BigInt(a.logIndex) - BigInt(b.logIndex))
  );
  const g = newGroup();                 // empty depth-20 RLN tree
  const liveIndex = new Map();          // commitment(string) -> its current live leaf index
  let active = 0;                       // members currently in the admission set
  for (const log of ordered) {
    const topic0 = (log.topics[0] || "").toLowerCase();
    const commitment = BigInt(log.topics[1]).toString(); // indexed commitment = topics[1]
    if (REGISTERED_TOPICS.has(topic0)) {
      // A register APPENDS a fresh leaf at the next free index — exactly the contract's
      // monotonic nextIndex. `g.members.length` is that append index. The guard is purely
      // defensive: the contract reverts a second active registration of the same
      // commitment (AlreadyMember), so a duplicate register log can only be a reorg echo.
      if (liveIndex.has(commitment)) continue;
      liveIndex.set(commitment, g.members.length);
      g.addMember(BigInt(commitment));
      active++;
    } else if (REMOVED_TOPICS.has(topic0)) {
      const idx = liveIndex.get(commitment);
      if (idx === undefined) continue;  // not currently live -> nothing to vacate
      g.removeMember(idx);              // ZERO-IN-PLACE at the original index (indices preserved)
      liveIndex.delete(commitment);
      active--;
    }
  }
  // COORDINATION: the on-chain StakedReputationSet / PaidAccessSet MUST maintain the identical
  // circom-rln depth-20 Poseidon tree of rateCommitments for these roots to match proof roots,
  // and MUST emit the rateCommitment as the indexed topic[1]. Removed leaves are zeroed in
  // place (above), matching the contract's immutable indices. An empty admission set has no
  // root (root null; the gateway then accepts nothing from this source).
  return { group: g, liveIndex, active, root: active === 0 ? null : g.root.toString() };
}

// ---- Merkle-Patricia storage-proof verification (T-DEV-9) -------------------
//
// A self-contained EIP-1186 proof verifier: no new dependency — keccak256 + RLP come from
// `ethers`, already a direct dep. Given a trusted state root, it cryptographically proves
// the value at a contract storage slot: verify the ACCOUNT proof against the state root to
// extract the account's storageHash, then verify the STORAGE proof against that storageHash
// to extract the slot value. A tampered value or a tampered/missing proof node fails (the
// node's keccak no longer matches the hash its parent commits to), so this defeats a lying
// RPC — as far as the state root we anchor to (see the trust note on LightClientRootProvider).

// keccak256 of a 0x-hex byte string -> 0x-hex (32 bytes). Imported lazily so the node path
// (NodeRootProvider) never loads ethers.
async function ethersMod() {
  return import("ethers");
}

// nibble array of a 0x-hex byte string (each byte -> hi, lo).
function toNibbles(bytes) {
  const out = [];
  for (const b of bytes) { out.push(b >> 4, b & 0x0f); }
  return out;
}

// Decode a hex-prefix (compact) encoded path -> { path: nibbles[], leaf: bool }.
function decodeCompactPath(getBytes, hex) {
  const bytes = getBytes(hex);
  if (bytes.length === 0) return { path: [], leaf: false };
  const flag = bytes[0] >> 4;
  const leaf = (flag & 2) !== 0;
  const odd = (flag & 1) !== 0;
  const nibs = [];
  if (odd) nibs.push(bytes[0] & 0x0f);
  for (let i = 1; i < bytes.length; i++) { nibs.push(bytes[i] >> 4, bytes[i] & 0x0f); }
  return { path: nibs, leaf };
}

// Walk an MPT proof for `keyBytesHex` (the RAW key; it is keccak-hashed here to the secure
// trie key) from `rootHex`. Returns the terminal value FIELD (0x-hex, RLP-encoded) if the
// key is present, null if the proof proves ABSENCE, and THROWS if the proof is invalid,
// incomplete, or tampered. `nodesHex` is the ordered eth_getProof node list (root..leaf).
async function verifyMptProof(rootHex, keyBytesHex, nodesHex) {
  const { keccak256, decodeRlp, getBytes } = await ethersMod();
  // Index every supplied node by its keccak so ordering/embedding is irrelevant and a
  // missing/altered node is detected as an absent hash.
  const byHash = new Map();
  for (const n of nodesHex) byHash.set(keccak256(n).toLowerCase(), decodeRlp(n));

  const key = toNibbles(getBytes(keccak256(keyBytesHex)));
  let expected = rootHex.toLowerCase();
  let i = 0;
  // Bounded by key length + slack; a correct proof terminates well within this.
  for (let step = 0; step < key.length + 4; step++) {
    let node;
    if (typeof expected === "string") {
      if (expected === "0x" || expected === "0x0") return null; // empty child -> absent
      node = byHash.get(expected);
      if (node === undefined) throw new Error("mpt: proof node missing for referenced hash");
    } else {
      node = expected; // embedded (<32B) node, used inline
    }
    if (Array.isArray(node) && node.length === 17) {
      if (i === key.length) return node[16]; // value at a branch
      expected = node[key[i]];
      i += 1;
      if (typeof expected === "string" && (expected === "0x" || expected === "0x0")) return null;
    } else if (Array.isArray(node) && node.length === 2) {
      const { path, leaf } = decodeCompactPath(getBytes, node[0]);
      for (let j = 0; j < path.length; j++) {
        if (key[i + j] !== path[j]) return null; // diverges from key -> absent
      }
      i += path.length;
      if (leaf) return i === key.length ? node[1] : null;
      expected = node[1]; // extension -> descend
    } else {
      throw new Error("mpt: malformed node");
    }
  }
  throw new Error("mpt: proof did not terminate");
}

// ---- LightClientRootProvider (Helios-style, run-many path) -------------------
//
// TRUST MODEL (read before relying on this):
//   VERIFIED cryptographically here: given a state root, the returned membership root is
//     the exact value at the contract's ROOT storage slot — proven with the account +
//     storage Merkle-Patricia proofs from eth_getProof. The RPC cannot substitute a false
//     root without breaking a keccak commitment, so this removes trust in the RPC's honesty
//     about the slot's contents (the gap the node/event-reconstruction path leaves open).
//   THE STATE ROOT we anchor the proof to -- two modes, chosen by RGOE_HELIOS_RPC_URL:
//     * unset (default): TRUSTED. It comes from the RPC's eth_getBlockByNumber at a confirmed
//       depth (finalized / head-N) and is NOT verified. `describe().stateRootSource` says so and
//       the gateway logs it at startup. A lying RPC can then forge a root by pairing a fake
//       header with a proof consistent with that fake header (docs/THREAT-MODEL.md).
//     * set (T-DEV-9b): VERIFIED. The header comes from a LOCAL Helios verifying RPC
//       (`lib/helios-root.mjs`, `makeHeliosTrustedStateRoot`), i.e. it chains to a beacon
//       sync-committee-signed execution payload. The RPC's own header for that block number is
//       then only CROSS-CHECKED: if its stateRoot differs from Helios' the provider REJECTS with
//       a precise reason (that is exactly the lying-RPC attack). Residual trust = the sync
//       committee + Helios' weak-subjectivity checkpoint (docs/LIGHT-CLIENT.md).
//     The `trustedStateRoot(blockTag) -> { stateRoot, number }` option is the same seam for
//     tests or another anchor; the env var just installs the Helios implementation of it.
//   FALLBACK: RGOE_LIGHT_MODE=storageat skips the proof and reads eth_getStorageAt at the
//     confirmed block. That TRUSTS the RPC for the value (no cryptographic check) and exists
//     only for RPCs without eth_getProof; it is clearly the weaker mode.
//
// Either way the returned root can be compared by a client to its own reconstructRoot: a
// match means the on-chain committed root and the locally-rebuilt tree agree.
export function LightClientRootProvider({
  contract,
  rpcUrl = RPC_URL(),
  slot = 3, // StakedReputationSet.ROOT_STORAGE_SLOT (currentRoot); see the contract
  mode = process.env.RGOE_LIGHT_MODE || "proof",
  trustedStateRoot = null, // optional: (blockTag) -> { stateRoot, number } from a verified header
  heliosRpcUrl = HELIOS_RPC_URL(), // RGOE_HELIOS_RPC_URL: installs the Helios trustedStateRoot
} = {}) {
  const addr = resolveContract(contract);
  if (!addr) throw new Error("LightClientRootProvider needs a contract address");
  if (!trustedStateRoot && heliosRpcUrl) {
    trustedStateRoot = makeHeliosTrustedStateRoot({ rpcUrl: heliosRpcUrl, upstreamRpcUrl: rpcUrl });
  }
  // What the startup log says about the anchor (gateway/gateway.mjs prints describe()).
  const stateRootSource = trustedStateRoot
    ? (trustedStateRoot.source || "injected trustedStateRoot hook")
    : "rpc header (TRUSTED, not verified; set RGOE_HELIOS_RPC_URL to anchor to the sync committee)";

  const slotHex = "0x" + BigInt(slot).toString(16).padStart(64, "0");

  // Confirmation-depth block tag, mirroring NodeRootProvider (finalized or head-N).
  async function readBlockTag() {
    const confirmations = CONFIRMATIONS();
    if (confirmations <= 0) return "finalized";
    const head = await blockNumber("latest", rpcUrl); // the provider's OWN endpoint, not the env default
    if (head == null) return "latest";
    return "0x" + BigInt(Math.max(0, head - confirmations)).toString(16);
  }

  // Normalize a 0x-hex slot value to the decimal root string the gateway/client compare on.
  // The empty tree's on-chain root is the depth-20 all-zero-leaf root (a nonzero field
  // element), which the off-chain reconstructRoot represents as null — same "no members"
  // meaning; a caller treats that sentinel as an empty set.
  function toRoot(valueHex) {
    if (valueHex == null) return null;
    const v = BigInt(valueHex);
    return v === 0n ? null : v.toString();
  }

  const currentRoots = withCache(async () => {
    // Resolve the confirmed block + its (trusted) state root.
    const tag = await readBlockTag();
    let stateRoot;
    let observedAtBlock;
    let blockTagForProof;
    if (trustedStateRoot) {
      const h = await trustedStateRoot(tag);
      if (!h || typeof h.stateRoot !== "string") throw new Error("LightClientRootProvider: trustedStateRoot returned no stateRoot");
      stateRoot = h.stateRoot;
      observedAtBlock = h.number != null ? Number(BigInt(h.number)) : null;
      blockTagForProof = h.number != null ? "0x" + BigInt(h.number).toString(16) : tag;
      // Cross-check the RPC's header for the SAME block. The proof below is anchored to the
      // verified stateRoot regardless, so a lying RPC could not pass anyway -- but naming the
      // attack beats a generic "proof node missing", and a divergent header is exactly what an
      // RPC that fabricates state looks like. Fail closed with the precise reason.
      const rpcBlk = await rpc("eth_getBlockByNumber", [blockTagForProof, false], rpcUrl);
      if (!rpcBlk) {
        throw new Error(`LightClientRootProvider: RPC has no block ${blockTagForProof} that the anchor (${stateRootSource}) attests`);
      }
      if (typeof rpcBlk.stateRoot !== "string" || rpcBlk.stateRoot.toLowerCase() !== stateRoot.toLowerCase()) {
        throw new Error(
          `LightClientRootProvider: stateRoot mismatch at block ${observedAtBlock}: RPC (${rpcUrl}) claims ${rpcBlk.stateRoot} but the anchor (${stateRootSource}) attests ${stateRoot} -- RPC is lying about the header or serving another chain; refusing its proofs`,
        );
      }
    } else {
      const blk = await rpc("eth_getBlockByNumber", [tag, false], rpcUrl);
      if (!blk) throw new Error("LightClientRootProvider: no block at " + tag);
      stateRoot = blk.stateRoot;
      observedAtBlock = Number(BigInt(blk.number));
      blockTagForProof = blk.number; // pin the proof to the exact block we read the root of
    }

    let root;
    if (mode === "storageat") {
      // Weaker fallback: trust the RPC for the value (no proof). Documented above.
      const valueHex = await rpc("eth_getStorageAt", [addr, slotHex, blockTagForProof], rpcUrl);
      root = toRoot(valueHex);
    } else {
      // Proof path: eth_getProof, then verify account + storage proofs against stateRoot.
      const proof = await rpc("eth_getProof", [addr, [slotHex], blockTagForProof], rpcUrl);
      if (!proof || !proof.accountProof || !proof.storageProof || !proof.storageProof[0]) {
        throw new Error("LightClientRootProvider: eth_getProof returned no proof");
      }
      const { decodeRlp } = await ethersMod();

      // 1. Account proof -> the account leaf [nonce, balance, storageHash, codeHash].
      const accountField = await verifyMptProof(stateRoot, addr, proof.accountProof);
      if (accountField == null) throw new Error("LightClientRootProvider: account absent in state proof");
      const account = decodeRlp(accountField);
      if (!Array.isArray(account) || account.length !== 4) {
        throw new Error("LightClientRootProvider: malformed account node");
      }
      const storageHash = account[2].toLowerCase();
      // Cross-check against the RPC-reported storageHash (defense in depth; the proof is
      // authoritative, but a mismatch flags a broken/lying RPC early).
      if (proof.storageHash && proof.storageHash.toLowerCase() !== storageHash) {
        throw new Error("LightClientRootProvider: storageHash mismatch vs proof");
      }

      // 2. Storage proof -> the slot value, proven against the account's storageHash.
      const sp = proof.storageProof[0];
      const valueField = await verifyMptProof(storageHash, slotHex, sp.proof);
      const proven = valueField == null ? 0n : BigInt(decodeRlp(valueField));
      // The RPC's claimed value must equal what the proof proves.
      if (sp.value != null && BigInt(sp.value) !== proven) {
        throw new Error("LightClientRootProvider: proven slot value != reported value");
      }
      root = proven === 0n ? null : proven.toString();
    }

    return {
      roots: root ? [root] : [],
      observedAtBlock,
      finalized: tag === "finalized",
      verified: mode !== "storageat",
      stateRootVerified: !!trustedStateRoot,
    };
  });

  const describe = () => ({ provider: "light", mode, stateRootSource, stateRootVerified: !!trustedStateRoot, contract: addr });
  return { currentRoots, onChange: pollOnChange(currentRoots), describe, contract: addr };
}

// Exported for the T-DEV-9 selftest (unit-test the MPT verifier against hand-built proofs)
// and the T-FEAT-8b selftest (both event generations reconstruct identically).
export const _internals = { verifyMptProof, decodeCompactPath, toNibbles, TOPIC };

// ---- change notification (poll; upgrade to log subscription later) ----------

function pollOnChange(currentRoots) {
  return function onChange(cb, intervalMs = 12000) {
    let last = null;
    const t = setInterval(async () => {
      try {
        const { roots } = await currentRoots();
        const head = roots && roots[0];
        if (head && head !== last) { last = head; cb(roots); }
      } catch { /* keep last-known-good; do not crash the gate */ }
    }, intervalMs);
    t.unref?.();
    return () => clearInterval(t);
  };
}

// ---- factory ----------------------------------------------------------------

// One provider (node|light) for ONE contract.
function makeSingleProvider(mode, contract) {
  if (mode === "light") return LightClientRootProvider(contract ? { contract } : {});
  if (mode === "node") {
    // Fail closed on a misconfig that would otherwise look verified: the Helios anchor is a
    // light-provider concept (the node provider trusts its RPC by design; to get light-client
    // security there, point RGOE_RPC_URL itself at Helios -- docs/LIGHT-CLIENT.md option A).
    if (HELIOS_RPC_URL()) throw new Error("RGOE_HELIOS_RPC_URL is set but RGOE_ROOT_PROVIDER=node; the Helios stateRoot anchor needs RGOE_ROOT_PROVIDER=light (or point RGOE_RPC_URL at Helios instead)");
    return NodeRootProvider(contract ? { contract } : {});
  }
  throw new Error(`unknown RGOE_ROOT_PROVIDER: ${mode} (expected node|light)`);
}

// ---- CompositeRootProvider (T-FEAT-7: several sets trusted at once) --------------
//
// The UNION of the roots of several providers, one per contract (a staked set, a paid set, a
// superseded set still inside its window...). currentRoots() = the de-duplicated union of every
// child's roots (order preserved: child order, then each child's freshness ring); a child that
// throws is dropped from THIS refresh (logged via `errors[]`) rather than blanking the whole
// union — the same last-known-good posture withCache gives each child. If EVERY child throws
// the composite throws (nothing to trust). onChange fans out; describe() lists the children.
// `perSource` carries each child's result so the gateway can log/gauge roots per source.
export function CompositeRootProvider(children) {
  if (!Array.isArray(children) || children.length === 0) throw new Error("CompositeRootProvider needs at least one child provider");
  async function currentRoots() {
    const roots = [];
    const seen = new Set();
    const perSource = [];
    const errors = [];
    let observedAtBlock = null;
    let finalized = true;
    for (const child of children) {
      try {
        const r = await child.currentRoots();
        perSource.push({ contract: child.contract || child.describe?.().contract || null, roots: (r.roots || []).slice(), leafCount: r.leafCount ?? null, stale: !!r.stale });
        for (const root of r.roots || []) { const k = String(root); if (!seen.has(k)) { seen.add(k); roots.push(k); } }
        if (r.observedAtBlock != null) observedAtBlock = observedAtBlock == null ? r.observedAtBlock : Math.min(observedAtBlock, r.observedAtBlock);
        if (r.finalized === false) finalized = false;
      } catch (e) {
        const contract = child.contract || child.describe?.().contract || null;
        errors.push({ contract, error: e.message });
        perSource.push({ contract, roots: [], leafCount: null, error: e.message });
      }
    }
    if (errors.length === children.length) throw new Error("all root providers failed: " + errors.map((e) => `${e.contract}: ${e.error}`).join("; "));
    return { roots, observedAtBlock, finalized, perSource, errors };
  }
  function onChange(cb, intervalMs) {
    const offs = children.map((c) => (c.onChange ? c.onChange(cb, intervalMs) : () => {}));
    return () => offs.forEach((off) => off());
  }
  const describe = () => ({ provider: "composite", children: children.map((c) => (c.describe ? c.describe() : { contract: c.contract })) });
  return { currentRoots, onChange, describe, children };
}

// makeRootProvider(mode, { contracts }) — the gateway's factory. `contracts` (default: every
// configured contract, configuredContracts()) is the address list to trust; ONE address returns
// the plain node|light provider (byte-equivalent to the pre-T-FEAT-7 single-contract path), more
// than one returns their CompositeRootProvider union. No contract at all: the single provider's
// own resolution (contracts/deployed.local.json) applies, as before.
export function makeRootProvider(mode = process.env.RGOE_ROOT_PROVIDER || "node", { contracts } = {}) {
  const list = contracts || configuredContracts().map((c) => c.address);
  if (list.length <= 1) return makeSingleProvider(mode, list[0]);
  return CompositeRootProvider(list.map((c) => makeSingleProvider(mode, c)));
}
