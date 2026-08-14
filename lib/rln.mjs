// RLN crypto core (v3) — REAL Rate-Limiting-Nullifier via rlnjs@3.3.0 against the
// locally-built circom-rln v1.0.0 Groth16 artifacts in circuits/rln/ (see
// circuits/rln/ARTIFACTS.md). This replaces the v2 PoC that layered a hand-rolled
// Shamir share over a Semaphore membership proof: the share <-> membership binding is
// now proven INSIDE one Groth16 circuit, not asserted by a cheap signal==share.x check.
//
// What a member proves per request (one RLN proof):
//   - it owns the identitySecret behind some rateCommitment leaf in the depth-20 tree,
//   - at messageId = slot i  (range-checked 0 <= i < K inside the circuit),
//   - for epoch (externalNullifier = Poseidon(epoch, rlnIdentifier)),
//   - evaluating the degree-1 line  y = identitySecret + a1*x  at  x = H(message),
//     where a1 is circuit-derived from (identitySecret, externalNullifier, messageId).
//
// Rate cap: K distinct messageIds per epoch => K distinct nullifiers. Reuse a messageId
// in the same epoch with a DIFFERENT message => two (x,y) points on the same line =>
// anyone can Shamir-reconstruct the identitySecret and slash the leaf.
//
// KEY SEMANTIC CHANGES from v2 (see lib/MIGRATION-NOTES.md):
//   - The slot is PRIVATE (messageId is a witness). There is no public "slot" any more.
//     The gateway keys its spent-set on `nullifier`; a repeated nullifier with a
//     DIFFERENT public `x` is a breach (over-spend), same as before but keyed differently.
//   - Per-epoch binding is `externalNullifier` (per-epoch, NOT per-slot). Per-slot
//     uniqueness comes from the private messageId inside the circuit.
//   - `identitySecret` (= Poseidon2(nullifier, trapdoor) of the Semaphore v3 identity) is
//     what a slash reveals — NOT the app's seed secret. deriveCommitment() takes that
//     identitySecret and returns the rateCommitment leaf.
//   - The signal/message is a STRING (rlnjs hashes it with keccak); requestSignal() now
//     returns that string, and the circuit's public `x` = calculateSignalHash(message).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

import {
  RLN,
  RLNProver,
  RLNVerifier,
  calculateExternalNullifier,
  calculateSignalHash,
  calculateRateCommitment,
} from "rlnjs";
// rlnjs nests its own Semaphore v3 identity/group (the ones the RLN circuit was built
// against). We MUST use these — the app's top-level @semaphore-protocol/* is v4 and its
// LeanIMT tree construction does NOT match the circom-rln depth-20 Poseidon tree.
import { Identity } from "rlnjs/node_modules/@semaphore-protocol/identity/dist/index.mjs";
import { Group as RLNGroup } from "rlnjs/node_modules/@semaphore-protocol/group/dist/index.mjs";
import { poseidon1, poseidon2 } from "poseidon-lite";

// ---- paths + artifacts ------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
export const MEMBERS_PATH = join(HERE, "..", "group", "members.json");
const RLN_DIR = join(HERE, "..", "circuits", "rln");
const WASM_PATH = join(RLN_DIR, "rln.wasm");
const ZKEY_PATH = join(RLN_DIR, "rln_final.zkey");
const VKEY = JSON.parse(readFileSync(join(RLN_DIR, "verification_key.json"), "utf8"));

// ---- protocol constants -----------------------------------------------------

// BN254 (alt_bn128) scalar field prime — the field Poseidon + the RLN circuit operate in.
export const FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// K = userMessageLimit = K_SLOTS = 8. bigint on-chain / in the circuit; Number here.
export const K_SLOTS = Number(process.env.RGOE_SLOTS || 8);
const K_BIG = BigInt(K_SLOTS);

// The RLN app identifier. MUST match the on-chain contract, the circuit's rlnIdentifier,
// and rlnjs's registry group-id (smoke.mjs uses 1n). It seeds externalNullifier and the
// tree's construction, so both JS sides and the chain must agree byte-for-byte.
export const RLN_IDENTIFIER = BigInt(process.env.RGOE_RLN_IDENTIFIER || 1n);

const TREE_DEPTH = 20; // circom-rln RLN(20,16)

// Demo default 120s (production 3600s). Must match on both sides — client and gateway
// both import this file, so the default already agrees everywhere.
export const EPOCH_SECONDS = Number(process.env.RGOE_EPOCH_SECONDS || 120);

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

const modSub = (a, b) => (((a - b) % FIELD) + FIELD) % FIELD;
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

// ---- external nullifier + request signal ------------------------------------

// externalNullifier(epoch) = Poseidon(epoch, rlnIdentifier): the per-EPOCH binding
// (NOT per-slot). rlnjs computes it the same way; this is what verifyEnvelope checks cheap.
export function externalNullifierFor(epoch) {
  return calculateExternalNullifier(toField(epoch), RLN_IDENTIFIER);
}

// The request-bound RLN message. rlnjs hashes a STRING message into the circuit's public
// `x` via calculateSignalHash (keccak256(utf8) >> 8). The shim MUST reuse the same
// (target, nonce) on every retry so a retry reproduces the SAME x (and therefore the same
// share + nullifier) — otherwise a rogue gateway could force retries to manufacture an
// over-spend. Returns a deterministic string; x is derived from it inside the circuit.
export function requestSignal(target, nonce) {
  return `rgoe:v3\n${String(target)}\n${String(nonce)}`;
}

// ---- identity / commitment --------------------------------------------------

// A deterministic rlnjs (Semaphore v3) identity, seeded from the app's field-element
// secret so the same secret always yields the same identity / identitySecret / leaf.
export function identityFor(secret) {
  return new Identity(toField(secret).toString());
}

// identitySecret = Poseidon2(nullifier, trapdoor) — the Semaphore v3 identity secret and
// the value a slash reveals. This is NOT the app's seed `secret`.
export function identitySecretOf(identity) {
  return poseidon2([identity.getNullifier(), identity.getTrapdoor()]);
}

// deriveCommitment(identitySecret) -> rateCommitment leaf (string).
//   rateCommitment = Poseidon2( Poseidon1(identitySecret), K )
// This is the on-chain leaf. The gateway reconstructs identitySecret from two shares and
// deriveCommitment(that) names the leaf to slash. Equals rlnjs calculateRateCommitment(
// identityCommitment, K) and rlnjs's own getRateCommitment() for the same identity.
export function deriveCommitment(identitySecret) {
  return rateCommitmentBig(toField(identitySecret)).toString();
}
function rateCommitmentBig(identitySecret) {
  return poseidon2([poseidon1([identitySecret]), K_BIG]);
}

// Convenience: the rateCommitment leaf (bigint) for a whole identity.
export function rateCommitmentOf(identity) {
  return rateCommitmentBig(identitySecretOf(identity));
}

// ---- group / tree -----------------------------------------------------------

// Build the depth-20 RLN Merkle tree of rateCommitment leaves using rlnjs's OWN Semaphore
// v3 Group (the exact tree its registry proves against), so the JS root == the circuit root.
export function newGroup(rateCommitments = []) {
  const g = new RLNGroup(RLN_IDENTIFIER, TREE_DEPTH);
  for (const leaf of rateCommitments) g.addMember(BigInt(leaf));
  return g;
}

// Build a group from a list of identities (test helper).
export function groupFromIdentities(identities) {
  return newGroup(identities.map((id) => rateCommitmentOf(id)));
}

// Load the published reputation set (rateCommitment leaves). Returns { group, root, count }.
export async function loadGroup() {
  const raw = JSON.parse(await readFile(MEMBERS_PATH, "utf8"));
  const leaves = raw.members.map((m) => BigInt(m));
  const group = newGroup(leaves);
  return { group, root: group.root.toString(), count: leaves.length };
}

// loadGroupOnchain(rootProvider) -> { recentRoots }: reconstruct the rateCommitment tree
// from the contract's Member* events (via lib/root-provider.mjs, node mode) and return the
// freshness-window root set the gateway accepts proofs against. NOTE: the leaves are now
// rateCommitments and the tree is the RLN v3 depth-20 Poseidon tree (root-provider was
// updated to build it with newGroup()), so the reconstructed root matches proof roots.
export async function loadGroupOnchain(rootProvider) {
  const provider =
    rootProvider || (await import("./root-provider.mjs")).makeRootProvider("node");
  const { roots } = await provider.currentRoots();
  return { recentRoots: (roots || []).map(String) };
}

// ---- prove one slot ---------------------------------------------------------

let _prover;
function getProver() {
  return (_prover ||= new RLNProver(WASM_PATH, ZKEY_PATH));
}
let _verifier;
function getVerifier() {
  return (_verifier ||= new RLNVerifier(VKEY));
}

// snarkjs' wasm witness calculator (shared by the one RLNProver) and groth16 fullProve
// are NOT reentrant in-process: two overlapping prove/verify calls share internal input
// buffers and clobber each other, surfacing as "Not enough values for input signal
// pathElements". This bites the shim (its background per-epoch warm proof races the first
// real request) and any gateway serving concurrent requests. Serialize ALL snarkjs work
// behind one promise-chain mutex. Proving is ~0.4s; overlapping callers simply queue.
let _snarkLock = Promise.resolve();
function withSnarkLock(fn) {
  const run = _snarkLock.then(fn, fn);
  _snarkLock = run.then(() => {}, () => {}); // keep the chain alive regardless of outcome
  return run;
}

// Make an RLNFullProof JSON-safe for the wire (epoch + rlnIdentifier are bigints).
function wireProof(full) {
  return {
    snarkProof: full.snarkProof, // proof fields + publicSignals are already strings
    epoch: String(full.epoch),
    rlnIdentifier: String(full.rlnIdentifier),
  };
}

// proveForSlot(secret, epoch, i, signal, { group }) ->
//   { proof /*RLNFullProof (wire-safe)*/, nullifier, externalNullifier, slot: i, share:{x,y} }
// A REAL RLN Groth16 proof with messageId = i, the given epoch, and message = signal.
// The Groth16 proof BYTES are randomized per call, but the PUBLIC SIGNALS (share x/y,
// nullifier, externalNullifier, root) are deterministic given (identitySecret,
// externalNullifier, messageId, x) — a retry with the same args reproduces an identical
// share + nullifier.
export async function proveForSlot(secret, epoch, i, signal, { group } = {}) {
  const identity = identityFor(secret);
  const identitySecret = identitySecretOf(identity);
  const g = group || (await loadGroup()).group;

  const leaf = rateCommitmentBig(identitySecret);
  const index = g.indexOf(leaf);
  if (index === -1) throw new Error("proveForSlot: identity's rateCommitment not in group");
  const merkleProof = g.generateMerkleProof(index);

  const message = String(signal);
  const x = calculateSignalHash(message); // circuit public x
  if (x <= 0n) throw new Error("proveForSlot: signal hashes to x<=0 (would leak secret)");

  const full = await withSnarkLock(() =>
    getProver().generateProof({
      identitySecret,
      userMessageLimit: K_BIG,
      messageId: toField(i),
      merkleProof,
      x,
      epoch: toField(epoch),
      rlnIdentifier: RLN_IDENTIFIER,
    })
  );

  const ps = full.snarkProof.publicSignals;
  return {
    proof: wireProof(full),
    nullifier: String(ps.nullifier),
    externalNullifier: String(ps.externalNullifier),
    slot: i,
    share: { x: String(ps.x), y: String(ps.y) },
  };
}

// ---- verify an envelope (gateway side) --------------------------------------

// Cheap checks BEFORE the SNARK verify (adversarial-review order):
//   1. externalNullifier == externalNullifierFor(current or previous epoch)  (one-epoch skew)
//   2. share.x == proof's public x  (the share is evaluated at the message this proof committed)
//   3. proof's public root ∈ recentRoots
//   4. RLN Groth16 verify  (expensive — last)
// Returns { ok, reason, nullifier, externalNullifier, share:{x,y} }. The nullifier + share
// are taken from the proof's PUBLIC SIGNALS (authoritative), never the envelope's copies,
// so a lying envelope cannot desync the gateway's spent-set. There is NO public slot.
export async function verifyEnvelope(env, recentRoots, nowMs = Date.now()) {
  if (!env || typeof env !== "object") return { ok: false, reason: "no-envelope" };
  const { proof } = env;
  if (!proof || !proof.snarkProof || !proof.snarkProof.publicSignals) {
    return { ok: false, reason: "no-proof" };
  }
  const ps = proof.snarkProof.publicSignals;
  const share = env.share || { x: ps.x, y: ps.y };

  // 1. externalNullifier must be this-or-last epoch's (cheap).
  const now = currentEpoch(nowMs);
  const ok1 = [now, now - 1n].some(
    (e) => externalNullifierFor(e).toString() === String(ps.externalNullifier)
  );
  if (!ok1) return { ok: false, reason: "stale-external-nullifier" };

  // 2. the share must be evaluated at the proof's committed x (cheap binding).
  if (String(share.x) !== String(ps.x)) return { ok: false, reason: "signal-mismatch" };

  // 2b. bind the proof to THIS request's target. The committed x is calculateSignalHash of
  // requestSignal(target, nonce); recomputing it from the envelope's target+nonce and checking it
  // equals ps.x means a captured proof cannot be redirected to a different target (or nonce) — a
  // malicious gateway replaying a member's proof to a peer with a swapped target is rejected. The
  // client sends the nonce for exactly this (client/rgoe-client.mjs buildEnvelope); without it the
  // target is unverifiable, so we fail closed.
  if (env.nonce == null || env.target == null) return { ok: false, reason: "unbound-target" };
  if (String(calculateSignalHash(requestSignal(env.target, env.nonce))) !== String(ps.x)) {
    return { ok: false, reason: "target-not-bound" };
  }

  // 3. root must be one we currently accept (cheap). Accept an Array or a Set — Array.from
  //    normalizes both (the gateway keeps recentRoots as a Set).
  const roots = Array.from(recentRoots || []).map(String);
  if (!roots.includes(String(ps.root))) return { ok: false, reason: "wrong-group-root" };

  // 4. the RLN Groth16 proof must verify (expensive — last).
  let valid = false;
  try {
    valid = await withSnarkLock(() =>
      getVerifier().verifyProof(RLN_IDENTIFIER, {
        snarkProof: proof.snarkProof,
        epoch: proof.epoch,
        rlnIdentifier: proof.rlnIdentifier ?? RLN_IDENTIFIER.toString(),
      })
    );
  } catch (e) {
    return { ok: false, reason: "verify-threw:" + e.message };
  }
  if (!valid) return { ok: false, reason: "invalid-proof" };

  return {
    ok: true,
    reason: "ok",
    nullifier: String(ps.nullifier),
    externalNullifier: String(ps.externalNullifier),
    share: { x: String(ps.x), y: String(ps.y) },
  };
}

// ---- reconstruct the identitySecret from two shares -------------------------

// Two points (xA,yA),(xB,yB) on the degree-1 line y = identitySecret + a1*x. Interpolate
// back to f(0) = identitySecret (the a0 revealed on over-spend). Distinct x required (a
// retry reuses x => same point => nothing to reconstruct). This is exactly rlnjs's
// shamirRecovery; kept as an explicit Lagrange interpolation.
export function reconstructSecret(shareA, shareB) {
  const xA = toField(shareA.x), yA = toField(shareA.y);
  const xB = toField(shareB.x), yB = toField(shareB.y);
  if (xA === xB) throw new Error("reconstructSecret: identical evaluation points");
  const a1 = modMul(modSub(yB, yA), modInv(modSub(xB, xA)));
  const a0 = modSub(yA, modMul(a1, xA));
  return a0.toString();
}

// ---- teardown ---------------------------------------------------------------

// Terminate snarkjs worker threads so the process can exit. Safe to call once at the end.
export function cleanUp() {
  try { RLN.cleanUp(); } catch { /* curve never initialized (no proof made) — fine */ }
}

export {
  RLN,
  Identity,
  RLNGroup,
  calculateRateCommitment,
  calculateSignalHash,
  calculateExternalNullifier,
};
