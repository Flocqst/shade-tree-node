// T-FEAT-5: deterministic member subkeys (HD-style key derivation for RLN identities).
//
// WHY: a member enrolls ONCE (a rateCommitment leaf is registered on-chain), but wants
// several unlinkable personas — or to rotate its on-chain commitment — WITHOUT running a
// fresh enrollment ceremony each time. This module derives per-(context,index) RLN member
// secrets deterministically from ONE master secret, so a single backup (the master) can
// reproduce every persona/rotation. It is a pure library: no I/O, no chain, no network.
//
// The derived thing is a normal RLN identity: deriveIdentity() returns the sub-secret plus
// its rateCommitment leaf, which is registered on-chain via the EXISTING register-onchain
// flow (scripts/register-onchain.*). A subkey needs NO new contract — its commitment is an
// ordinary depth-20 tree leaf, indistinguishable from a freshly-enrolled member's.
//
//   node lib/subkeys.selftest.mjs
//
// zero new deps — node:crypto (HMAC-SHA512) + lib/rln.mjs (toField/FIELD/identityFor/...).

import { createHmac } from "node:crypto";
import { FIELD, toField, identityFor, rateCommitmentOf } from "./rln.mjs";

// ---- derivation wire/compat contract ----------------------------------------
//
// This string format is a COMPAT CONTRACT: any implementation deriving the same subkey from
// the same master MUST hash exactly these bytes. Changing it silently re-homes every persona
// to a different leaf, so it is versioned (`:v1`) and pinned by a golden vector in the test.
//
//   PRF        = HMAC-SHA512, key = master secret bytes, message = the info string below.
//   info(c=0)  = `shade-tree-subkey:v1\n${context}\n${index}`                 (the normal case)
//   info(c>0)  = `shade-tree-subkey:v1\n${context}\n${index}\n${counter}`     (counter appended
//                only on the astronomically-rare (~2^-254) re-derivation when a digest
//                reduces to 0 mod FIELD; the base string is left byte-identical for c=0)
//
//   secret     = BigInt('0x' + HMAC_SHA512(...)) mod FIELD             (512 bits -> ~254-bit
//                field element; reduction bias is < 2^-252, negligible)
//
//   `context`  labels the persona/purpose (e.g. "egress", "rotation-2026Q3"); `index`
//              enumerates keys within a context. Different context OR different index =>
//              a different, unlinkable secret (and therefore a different on-chain leaf).
//
// The master secret is hex (optional 0x prefix). Its RAW BYTES key the HMAC — the master is
// NOT itself reduced mod FIELD, so it may carry more than 254 bits of entropy.
const DERIVATION_PREFIX = "shade-tree-subkey:v1";

// Normalize a hex master secret to a Buffer of its raw bytes. Accepts an optional 0x prefix;
// pads a lone leading nibble so an odd-length hex string is still well-defined.
function masterBytes(masterSecretHex) {
  if (typeof masterSecretHex !== "string") {
    throw new Error("deriveSubSecret: masterSecretHex must be a hex string");
  }
  let h = masterSecretHex.startsWith("0x") ? masterSecretHex.slice(2) : masterSecretHex;
  if (!/^[0-9a-fA-F]+$/.test(h)) {
    throw new Error("deriveSubSecret: masterSecretHex is not valid hex");
  }
  if (h.length % 2 === 1) h = "0" + h;
  return Buffer.from(h, "hex");
}

// Build the exact info string for (context, index, counter). counter 0 is the base format.
function infoString(context, index, counter) {
  const base = `${DERIVATION_PREFIX}\n${String(context)}\n${String(index)}`;
  return counter === 0 ? base : `${base}\n${String(counter)}`;
}

/**
 * deriveSubSecret(masterSecretHex, context, index=0) -> fieldElementString
 *
 * Deterministic: same (master, context, index) always yields the same decimal-string field
 * element in [1, FIELD). Uses HMAC-SHA512(master, info) reduced mod FIELD; on the vanishingly
 * rare zero result it re-derives with an incremented counter appended to the info string.
 */
export function deriveSubSecret(masterSecretHex, context, index = 0) {
  if (context == null) throw new Error("deriveSubSecret: context is required");
  const key = masterBytes(masterSecretHex);
  for (let counter = 0; counter < 256; counter++) {
    const digest = createHmac("sha512", key).update(infoString(context, index, counter), "utf8").digest();
    const reduced = toField(BigInt("0x" + digest.toString("hex")));
    if (reduced !== 0n) return reduced.toString(); // valid nonzero field element
  }
  // Unreachable in practice (each counter has ~2^-254 chance of hitting 0).
  throw new Error("deriveSubSecret: exhausted counters without a nonzero field element");
}

/**
 * deriveIdentity(masterSecretHex, context, index=0) -> { secret, identity, commitment }
 *
 * Composes deriveSubSecret with lib/rln.mjs to produce a real, registerable RLN identity:
 *   - secret     : the derived sub-secret (decimal string field element)
 *   - identity   : the rlnjs (Semaphore v3) Identity seeded from that secret
 *   - commitment : the rateCommitment leaf (decimal string) — the value you register
 *                  on-chain via the existing register-onchain flow (no new contract needed).
 *
 * commitment === rateCommitmentOf(identityFor(secret)).toString() by construction, so a
 * subkey is a normal member leaf: it proves, over-spends, and slashes exactly like an
 * enrolled identity.
 */
export function deriveIdentity(masterSecretHex, context, index = 0) {
  const secret = deriveSubSecret(masterSecretHex, context, index);
  const identity = identityFor(secret);
  const commitment = rateCommitmentOf(identity).toString();
  return { secret, identity, commitment };
}

export { FIELD };
