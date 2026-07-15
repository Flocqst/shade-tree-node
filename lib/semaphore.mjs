// Shared Semaphore helpers used by the enroll tool, the client shim, and the gateway.
//
// The "reputation set" is a Semaphore group: a Merkle tree of identity commitments.
// A client proves, in zero knowledge, that it owns the secret behind *some* leaf
// in that tree, without revealing which one. The proof carries a `nullifier`
// derived from (secret, scope).
//
// v1 (this file's own helpers) used scope = epoch: one nullifier per member per epoch.
// v2 (lib/rln.mjs) refines this to K per-slot nullifiers per epoch + an RLN secret-share
// for slashing. The v2 surface is re-exported at the bottom so callers can migrate to
// `import { proveForSlot, verifyEnvelope, ... } from "../lib/semaphore.mjs"` or import
// lib/rln.mjs directly; both share ONE source of truth for the epoch clock.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof, verifyProof } from "@semaphore-protocol/proof";

// Epoch clock lives in lib/rln.mjs so the v1 and v2 paths can never disagree on the
// window. Demo default is 120s (was 86400 in v1); override RGOE_EPOCH_SECONDS on BOTH sides.
import { EPOCH_SECONDS, currentEpoch } from "./rln.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MEMBERS_PATH = join(HERE, "..", "group", "members.json");

export { EPOCH_SECONDS, currentEpoch };

// A constant v1 signal. v2 replaces this with a request-bound signal (rln.requestSignal);
// kept here so v1 callers (the pre-migration shim/gateway) still resolve the import.
export const MESSAGE = 1n;

// Load the published reputation set. Returns { group, root, count }.
export async function loadGroup() {
  const raw = JSON.parse(await readFile(MEMBERS_PATH, "utf8"));
  const commitments = raw.members.map((m) => BigInt(m));
  const group = new Group(commitments);
  return { group, root: group.root.toString(), count: commitments.length };
}

// v1 client side: prove membership for the current epoch (single epoch-scoped nullifier).
export async function proveMembership(secret, scope = currentEpoch()) {
  const identity = new Identity(secret);
  const { group } = await loadGroup();
  const proof = await generateProof(identity, group, MESSAGE, scope);
  return proof; // { merkleTreeRoot, nullifier, scope, message, points, merkleTreeDepth }
}

// v1 gateway side: is this a valid, in-set, current-epoch proof?
// Returns { ok, reason, nullifier, scope }.
export async function checkProof(proof, trustedRoot, nowMs = Date.now()) {
  if (!proof || typeof proof !== "object") return { ok: false, reason: "no-proof" };

  let valid = false;
  try {
    valid = await verifyProof(proof);
  } catch (e) {
    return { ok: false, reason: "verify-threw:" + e.message };
  }
  if (!valid) return { ok: false, reason: "invalid-proof" };

  if (String(proof.merkleTreeRoot) !== String(trustedRoot)) {
    return { ok: false, reason: "wrong-group-root" };
  }

  const now = currentEpoch(nowMs);
  const scope = BigInt(proof.scope);
  if (scope !== now && scope !== now - 1n) {
    return { ok: false, reason: "stale-epoch" };
  }

  return { ok: true, nullifier: String(proof.nullifier), scope: String(scope) };
}

export { Identity, Group, generateProof, verifyProof };

// ---- v2 surface (lib/rln.mjs) re-exported for callers migrating off v1 -------
export {
  FIELD,
  K_SLOTS,
  toField,
  slotScope,
  requestSignal,
  shareFor,
  slotNullifier,
  identityFor,
  deriveCommitment,
  COMMITMENT_SCHEME,
  proveForSlot,
  verifyEnvelope,
  validSlotFor,
  reconstructSecret,
  loadGroupOnchain,
} from "./rln.mjs";
