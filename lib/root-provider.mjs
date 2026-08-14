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
//   - LightClientRootProvider : Helios-style. Validates headers against the sync
//                         committee, then proves the root's storage slot with
//                         eth_getProof. Requires the root on chain; still a TODO here.
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

const HERE = dirname(fileURLToPath(import.meta.url));

const CONFIRMATIONS = Number(process.env.RGOE_CONFIRMATIONS || 0); // 0 = use finalized
const RPC_URL = process.env.RGOE_RPC_URL || "http://127.0.0.1:8545";
const FRESHNESS_ROOTS = Number(process.env.RGOE_FRESHNESS_ROOTS || 2); // current + how many prior
const FROM_BLOCK = process.env.RGOE_FROM_BLOCK || "0x0"; // deploy block; 0x0 fine on anvil

// Contract address: contracts/deployed.local.json (written by the deploy) wins, else env.
function resolveContract(explicit) {
  if (explicit) return explicit;
  if (process.env.RGOE_GROUP_CONTRACT) return process.env.RGOE_GROUP_CONTRACT;
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
// Precomputed; recompute with: node -e "require('js-sha3').keccak256('MemberRegistered(uint256,uint64)')"
const TOPIC = {
  registered: "0x0dbb6a3ed41d8f3d21e481b86d0e8bbf65a630b7dc4c5ee6c2c1a74561841e6d", // MemberRegistered(uint256,uint64)
  exiting: "0x971e754215411b0ec07054d759063d876d53872b7d4b37294744e5a776604f37", // MemberExiting(uint256,uint64,uint64)
  withdrawn: "0x8f2d81dd61a3f7ff90ea7265e45192f03f643615dd2458e287d84aaac222ffe9", // MemberWithdrawn(uint256,address)
  slashed: "0x707cd9719d0c14265b9e456f7add99095401f907e570e5cdd65a92920947c450", // MemberSlashed(uint256,address)
};
const ALL_TOPICS = [TOPIC.registered, TOPIC.exiting, TOPIC.withdrawn, TOPIC.slashed];

// ---- minimal JSON-RPC -------------------------------------------------------

let rpcId = 0;
async function rpc(method, params, url = RPC_URL) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

async function blockNumber(tag = "latest") {
  const b = await rpc("eth_getBlockByNumber", [tag, false]);
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

export function NodeRootProvider({ rpcUrl = RPC_URL, contract } = {}) {
  const addr = resolveContract(contract);
  if (!addr) throw new Error("NodeRootProvider needs a contract (deployed.local.json or RGOE_GROUP_CONTRACT)");

  // a small ring of recent roots so a proof built against a just-superseded root still
  // verifies inside the freshness window F.
  let ring = [];
  const pushRoot = (root) => {
    if (root && ring[0] !== root) ring.unshift(root);
    ring = ring.slice(0, FRESHNESS_ROOTS);
    return ring.slice();
  };

  // Read the confirmation-depth block: finalized (CONFIRMATIONS=0) or head - N.
  async function readBlockTag() {
    if (CONFIRMATIONS <= 0) return "finalized";
    const head = await blockNumber("latest");
    if (head == null) return "latest";
    return "0x" + BigInt(Math.max(0, head - CONFIRMATIONS)).toString(16);
  }

  const currentRoots = withCache(async () => {
    const tag = await readBlockTag();
    const blk = await rpc("eth_getBlockByNumber", [tag, false], rpcUrl);
    const observedAtBlock = blk ? Number(BigInt(blk.number)) : null;
    const toBlock = blk ? blk.number : tag;

    // eth_getLogs the Member* events up to the confirmation-depth block. (Single range;
    // for a large L1 history you would page this — fine for anvil / a small demo set.)
    const logs = await rpc(
      "eth_getLogs",
      [{ address: addr, fromBlock: FROM_BLOCK, toBlock, topics: [ALL_TOPICS] }],
      rpcUrl
    );

    const root = reconstructRoot(logs);
    return { roots: pushRoot(root), observedAtBlock, finalized: tag === "finalized" };
  });

  return { currentRoots, onChange: pollOnChange(currentRoots) };
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
    if (topic0 === TOPIC.registered) {
      // A register APPENDS a fresh leaf at the next free index — exactly the contract's
      // monotonic nextIndex. `g.members.length` is that append index. The guard is purely
      // defensive: the contract reverts a second active registration of the same
      // commitment (AlreadyMember), so a duplicate register log can only be a reorg echo.
      if (liveIndex.has(commitment)) continue;
      liveIndex.set(commitment, g.members.length);
      g.addMember(BigInt(commitment));
      active++;
    } else if (topic0 === TOPIC.exiting || topic0 === TOPIC.withdrawn || topic0 === TOPIC.slashed) {
      const idx = liveIndex.get(commitment);
      if (idx === undefined) continue;  // not currently live -> nothing to vacate
      g.removeMember(idx);              // ZERO-IN-PLACE at the original index (indices preserved)
      liveIndex.delete(commitment);
      active--;
    }
  }
  if (active === 0) return null; // empty admission set has no root (gateway then accepts nothing)
  // COORDINATION: the on-chain StakedReputationSet MUST maintain the identical circom-rln
  // depth-20 Poseidon tree of rateCommitments for these roots to match proof roots, and
  // MUST emit the rateCommitment as the indexed topic[1] and the leaf index as topic[2].
  // Removed leaves are zeroed in place (above), matching the contract's immutable indices.
  return g.root.toString();
}

// ---- LightClientRootProvider (Helios-style, run-many path) -------------------

export function LightClientRootProvider({ contract } = {}) {
  const addr = resolveContract(contract);
  if (!addr) throw new Error("LightClientRootProvider needs a contract address");

  const currentRoots = withCache(async () => {
    // 1. Validate a recent header against the sync committee (Helios embedded, or a
    //    helios sidecar exposing a verified header + stateRoot).
    // 2. eth_getProof(contract, [rootSlot], blockOfHeader) and verify the returned
    //    account+storage proof against header.stateRoot. Only then trust the slot value.
    // REQUIRES the root in an on-chain storage slot (contracts/README): the off-chain
    // event-reconstruction tree this repo ships is node-only. Put the root on chain to
    // use this path.
    throw new Error("LightClientRootProvider: on-chain root + Helios validation not wired");
  });

  return { currentRoots, onChange: pollOnChange(currentRoots) };
}

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

export function makeRootProvider(mode = process.env.RGOE_ROOT_PROVIDER || "node") {
  if (mode === "light") return LightClientRootProvider();
  if (mode === "node") return NodeRootProvider();
  throw new Error(`unknown RGOE_ROOT_PROVIDER: ${mode} (expected node|light)`);
}
