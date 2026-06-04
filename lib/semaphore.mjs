// Shared Semaphore helpers used by the enroll tool, the client shim, and the gateway.
//
// The "reputation set" is a Semaphore group: a Merkle tree of identity commitments.
// A client proves, in zero knowledge, that it owns the secret behind *some* leaf
// in that tree, without revealing which one. The proof carries a `nullifier`
// derived from (secret, scope). We use scope = the current epoch, so:
//   - within an epoch a given member always produces the SAME nullifier
//     => the gateway can rate-limit per member without knowing who they are,
//   - across epochs the nullifier changes => requests are unlinkable over time.
// That is the RLN (rate-limiting nullifier) idea at PoC fidelity.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof, verifyProof } from "@semaphore-protocol/proof";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MEMBERS_PATH = join(HERE, "..", "group", "members.json");

// One epoch = one rate-limit window. 3600s = a member gets a fresh budget hourly.
export const EPOCH_SECONDS = 3600;

// A constant signal. In production you would bind this to the request so a proof
// cannot be lifted and replayed against a different target; for the PoC the proof
// rides inside the Tor-encrypted onion tunnel, so it is never exposed to replay.
export const MESSAGE = 1n;

export function currentEpoch(nowMs = Date.now()) {
  return BigInt(Math.floor(nowMs / 1000 / EPOCH_SECONDS));
}

// Load the published reputation set. Returns { group, root, count }.
export async function loadGroup() {
  const raw = JSON.parse(await readFile(MEMBERS_PATH, "utf8"));
  const commitments = raw.members.map((m) => BigInt(m));
  const group = new Group(commitments);
  return { group, root: group.root.toString(), count: commitments.length };
}

// Client side: prove membership for the current epoch.
export async function proveMembership(secret, scope = currentEpoch()) {
  const identity = new Identity(secret);
  const { group } = await loadGroup();
  const proof = await generateProof(identity, group, MESSAGE, scope);
  return proof; // JSON-serializable: { merkleTreeRoot, nullifier, scope, message, points, merkleTreeDepth }
}

// Gateway side: is this a valid, in-set, current-epoch proof?
// Returns { ok, reason, nullifier, scope }.
export async function checkProof(proof, trustedRoot, nowMs = Date.now()) {
  if (!proof || typeof proof !== "object") return { ok: false, reason: "no-proof" };

  // 1. The zk proof must verify.
  let valid = false;
  try {
    valid = await verifyProof(proof);
  } catch (e) {
    return { ok: false, reason: "verify-threw:" + e.message };
  }
  if (!valid) return { ok: false, reason: "invalid-proof" };

  // 2. It must be a proof against OUR reputation set, not a set the client invented.
  if (String(proof.merkleTreeRoot) !== String(trustedRoot)) {
    return { ok: false, reason: "wrong-group-root" };
  }

  // 3. Scope must be the current epoch (allow one epoch of clock skew).
  const now = currentEpoch(nowMs);
  const scope = BigInt(proof.scope);
  if (scope !== now && scope !== now - 1n) {
    return { ok: false, reason: "stale-epoch" };
  }

  return { ok: true, nullifier: String(proof.nullifier), scope: String(scope) };
}

export { Identity, Group, generateProof, verifyProof };
