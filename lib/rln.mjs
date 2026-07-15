// RLN-at-PoC-fidelity crypto library (docs/NEXT-VERSION.md "Library API", docs/ONCHAIN.md).
//
// This is the v2 crypto core the shim + gateway build against. It layers per-request
// slot nullifiers (ROADMAP #1 Tier 1) and an RLN-style secret-share over the existing
// Semaphore membership proof, so the gateway can:
//   - rate-cap a member at K slots/epoch via K distinct, mutually-unlinkable nullifiers,
//   - reconstruct a proven over-spender's secret from two shares and slash the leaf.
//
// Everything below runs in the BN254 scalar field (the field Poseidon + Semaphore use),
// so a reconstructed constant term is a valid `secret` and `deriveCommitment(secret)`
// lands on the same leaf the on-chain hasher stores.
//
// FIDELITY NOTE (must stay honest, per NEXT-VERSION.md "RLN share + slashing"): the demo
// does NOT ZK-prove the share is well-formed relative to the membership proof. A
// production RLN circuit (rate-limiting-nullifier) binds share <-> membership in one
// Groth16 proof. Here the two are bound only by the shared `secret` and a cheap
// signal==share.x check; the gateway trusts the envelope's share format. Do not hide it.

import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof, verifyProof } from "@semaphore-protocol/proof";
import { poseidon1, poseidon2 } from "poseidon-lite";
import sha3 from "js-sha3";
const { keccak256 } = sha3;

// BN254 (alt_bn128) scalar field prime — the field Poseidon and Semaphore operate in.
export const FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ---- epoch + slot parameters (all env-overridable) --------------------------

// Demo default 120s (NEXT-VERSION.md); production 3600s. Must match on both sides —
// client and gateway both import this file, so the default already agrees everywhere.
export const EPOCH_SECONDS = Number(process.env.RGOE_EPOCH_SECONDS || 120);
// K valid slots (=> K distinct nullifiers) per member per epoch: the hard rate cap.
export const K_SLOTS = Number(process.env.RGOE_SLOTS || 8);

export function currentEpoch(nowMs = Date.now()) {
  return BigInt(Math.floor(nowMs / 1000 / EPOCH_SECONDS));
}

// ---- field helpers ----------------------------------------------------------

export function toField(v) {
  let n;
  if (typeof v === "bigint") n = v;
  else if (typeof v === "number") n = BigInt(v);
  else if (typeof v === "string") n = v.startsWith("0x") ? BigInt(v) : BigInt(v);
  else throw new Error("toField: unsupported " + typeof v);
  return ((n % FIELD) + FIELD) % FIELD;
}

const modAdd = (a, b) => (a + b) % FIELD;
const modSub = (a, b) => ((a - b) % FIELD + FIELD) % FIELD;
const modMul = (a, b) => (a * b) % FIELD;

// modular inverse via extended Euclid (a nonzero, mod prime FIELD)
function modInv(a) {
  let [old_r, r] = [((a % FIELD) + FIELD) % FIELD, FIELD];
  let [old_s, s] = [1n, 0n];
  if (old_r === 0n) throw new Error("modInv(0)");
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return ((old_s % FIELD) + FIELD) % FIELD;
}

// keccak256(abi.encode(uint256 x)) as a bigint — matches Solidity for the keccak scheme.
function keccakField(x) {
  const n = ((toField(x)) & ((1n << 256n) - 1n));
  const buf = Buffer.alloc(32);
  let hex = n.toString(16).padStart(64, "0");
  Buffer.from(hex, "hex").copy(buf);
  return BigInt("0x" + keccak256(buf));
}
// keccak of an arbitrary string, folded into the field (for hashing host:port).
function keccakStrField(s) {
  return BigInt("0x" + keccak256(Buffer.from(String(s), "utf8"))) % FIELD;
}

// ---- slot scope + request signal --------------------------------------------

// scope(epoch, i) = Poseidon(epoch, i), the Semaphore/RLN external nullifier for slot i.
// Distinct per (epoch, slot) => distinct nullifier per slot => rate cap = K per epoch.
export function slotScope(epoch, i) {
  return poseidon2([toField(epoch), toField(i)]);
}

// The request-bound RLN signal / Shamir evaluation point (NEXT-VERSION.md "A"):
//   signal = H(target_host:port, requestNonce), deterministic per logical request.
// The shim MUST reuse the same (target, nonce) on every retry so a retry reproduces the
// SAME point (no new share) — otherwise a rogue gateway forces retries to manufacture an
// over-spend. Never 0 (x=0 would leak the constant term directly).
export function requestSignal(target, nonce) {
  const x = poseidon2([keccakStrField(target), keccakStrField(nonce)]);
  return x === 0n ? 1n : x;
}

// ---- the degree-1 RLN share (PoC) -------------------------------------------

// Per (secret, scope): line f(X) = a0 + a1*X with a0 = secret (the thing we slash on),
// a1 = Poseidon(secret, scope). y = f(signal). One signal => one point => reveals nothing;
// a second DISTINCT signal under the same (scope) => two points => reconstruct a0.
export function shareFor(secret, scope, signal) {
  const a0 = toField(secret);
  const a1 = poseidon2([a0, toField(scope)]);
  const x = toField(signal);
  const y = modAdd(a0, modMul(a1, x));
  return { x: x.toString(), y: y.toString() };
}

// nullifier N = Poseidon(secret, scope): distinct per slot, one-way, the spent-set key.
export function slotNullifier(secret, scope) {
  return poseidon2([toField(secret), toField(scope)]).toString();
}

// ---- identity / commitment --------------------------------------------------

// The Semaphore identity a member proves membership with. Seeded from the canonical
// field-element secret so deriveCommitment("identity") reproduces the same leaf.
export function identityFor(secret) {
  return new Identity(toField(secret).toString());
}

// deriveCommitment(secret) MUST equal the on-chain ICommitmentHasher.commitmentOf(secret)
// so a reconstructed secret slashes the right leaf (NEXT-VERSION.md coordination note).
// Three schemes, flip via RGOE_COMMITMENT_SCHEME:
//   "poseidon"  -> Poseidon(secret)            (single field element; matches poseidon-solidity)
//   "keccak"    -> keccak256(abi.encode(secret)) as uint256
//   "identity"  -> new Identity(secret).commitment  (the Semaphore v4 leaf)
// DEFAULT "poseidon" to match Track 1's hasher. See the report's coherence note: the ONLY
// scheme under which the *real Semaphore membership proof* and the *on-chain slash* name
// the SAME leaf is "identity"; under poseidon/keccak the membership<->slash binding is the
// documented PoC seam (bound by the shared secret, not a common Merkle root).
export const COMMITMENT_SCHEME = process.env.RGOE_COMMITMENT_SCHEME || "poseidon";

export function deriveCommitment(secret, scheme = COMMITMENT_SCHEME) {
  const s = toField(secret);
  if (scheme === "poseidon") return poseidon1([s]).toString();
  if (scheme === "keccak") return keccakField(s).toString();
  if (scheme === "identity") return identityFor(s).commitment.toString();
  throw new Error("deriveCommitment: unknown scheme " + scheme);
}

// ---- prove one slot ---------------------------------------------------------

// proveForSlot(secret, epoch, i, signal, { group }) ->
//   { proof, nullifier, scope, slot, share }
// `proof` is a REAL Semaphore membership proof against the current group, with
//   scope = slotScope(epoch, i)  and  message = signal (request-bound).
// The group defaults to the on-chain-reconstructed / members.json group; pass one for tests.
export async function proveForSlot(secret, epoch, i, signal, { group } = {}) {
  const identity = identityFor(secret);
  const g = group || (await loadGroup()).group;
  const scope = slotScope(epoch, i);
  const x = toField(signal);
  const proof = await generateProof(identity, g, x, scope);
  return {
    proof, // { merkleTreeRoot, nullifier, scope, message, points, merkleTreeDepth }
    nullifier: slotNullifier(secret, scope),
    scope: scope.toString(),
    slot: i,
    share: shareFor(secret, scope, x),
  };
}

// ---- verify an envelope (gateway side) --------------------------------------

// Cheap checks BEFORE the SNARK verify (adversarial-review #4 / NEXT-VERSION.md order):
//   1. scope is a valid slot for current/prev epoch,
//   2. share.x matches the proof's committed signal (message),
//   3. proof.merkleTreeRoot ∈ recentRoots,
//   4. SNARK verifyProof.
// Returns { ok, reason, nullifier, scope, slot, share } — the nullifier + share feed the
// gateway's share-collecting spent-set.
export async function verifyEnvelope(env, recentRoots, nowMs = Date.now()) {
  if (!env || typeof env !== "object") return { ok: false, reason: "no-envelope" };
  const { proof, share } = env;
  if (!proof || typeof proof !== "object") return { ok: false, reason: "no-proof" };
  if (!share || share.x == null || share.y == null) return { ok: false, reason: "no-share" };

  // 1. scope must be one of the K valid slot scopes for this-or-last epoch (cheap).
  const scope = String(env.scope);
  const slot = validSlotFor(scope, nowMs);
  if (slot < 0) return { ok: false, reason: "bad-scope" };

  // 2. the proof committed to `message`; the share must be evaluated at that same signal,
  //    else the share is not the one this proof authorizes (cheap PoC binding).
  if (String(proof.message) !== String(share.x)) {
    return { ok: false, reason: "signal-mismatch" };
  }

  // 3. root must be one we currently accept (cheap). Accept an Array or a Set (the
  //    gateway keeps recentRoots as a Set) — Array.from normalizes both.
  const roots = Array.from(recentRoots || []).map(String);
  if (!roots.includes(String(proof.merkleTreeRoot))) {
    return { ok: false, reason: "wrong-group-root" };
  }

  // 4. the zk proof must verify (expensive — last).
  let valid = false;
  try {
    valid = await verifyProof(proof);
  } catch (e) {
    return { ok: false, reason: "verify-threw:" + e.message };
  }
  if (!valid) return { ok: false, reason: "invalid-proof" };

  return {
    ok: true,
    reason: "ok",
    nullifier: String(env.nullifier),
    scope,
    slot,
    share: { x: String(share.x), y: String(share.y) },
  };
}

// Returns the slot index i if `scope` is slotScope(epoch, i) for the current or previous
// epoch, else -1. One epoch of skew is allowed (mirrors the freshness window).
export function validSlotFor(scope, nowMs = Date.now()) {
  const target = String(scope);
  const now = currentEpoch(nowMs);
  for (const epoch of [now, now - 1n]) {
    for (let i = 0; i < K_SLOTS; i++) {
      if (slotScope(epoch, i).toString() === target) return i;
    }
  }
  return -1;
}

// ---- reconstruct the secret from two shares ---------------------------------

// Two points (xA,yA),(xB,yB) on the degree-1 line f(X)=a0+a1*X. Interpolate back to
// f(0)=a0=secret. Distinct x required (a retry reuses x => same point => no reconstruct).
export function reconstructSecret(shareA, shareB) {
  const xA = toField(shareA.x), yA = toField(shareA.y);
  const xB = toField(shareB.x), yB = toField(shareB.y);
  if (xA === xB) throw new Error("reconstructSecret: identical evaluation points");
  // slope a1 = (yB - yA) / (xB - xA); a0 = yA - a1*xA
  const a1 = modMul(modSub(yB, yA), modInv(modSub(xB, xA)));
  const a0 = modSub(yA, modMul(a1, xA));
  return a0.toString();
}

// ---- group loading (offline cache + on-chain reconstruction) ----------------

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MEMBERS_PATH = join(HERE, "..", "group", "members.json");

// Offline cache path (published members.json). Kept for tests + as the fallback group.
export async function loadGroup() {
  const raw = JSON.parse(await readFile(MEMBERS_PATH, "utf8"));
  const commitments = raw.members.map((m) => BigInt(m));
  const group = new Group(commitments);
  return { group, root: group.root.toString(), count: commitments.length };
}

// loadGroupOnchain(rootProvider) -> { recentRoots }: reconstruct the active group from
// the contract's Member* events (via lib/root-provider.mjs, node mode) and return the
// freshness-window root set the gateway will accept proofs against.
export async function loadGroupOnchain(rootProvider) {
  const provider = rootProvider || (await import("./root-provider.mjs")).makeRootProvider("node");
  const { roots } = await provider.currentRoots();
  return { recentRoots: (roots || []).map(String) };
}

export { Identity, Group, generateProof, verifyProof };
