// identity-file: the ONE place the Rust client's `--identity` file is derived and serialized.
//
// The Rust `rgoe egress` (rust/rgoe-client, `--features live`) does not derive an identity from
// the app secret; it takes the two field elements it needs as inputs:
//
//   { "identitySecret": "<dec>",   // Semaphore-v3 identitySecret = Poseidon2(nullifier, trapdoor)
//     "leaf":           "<dec>" }  // RLN rateCommitment = Poseidon2(Poseidon1(identitySecret), K)
//
// Both come from the JS reference (lib/rln.mjs): identityFor(secret) is the SAME derivation the
// JS client's proveForSlot uses, and rateCommitmentOf() is the SAME leaf `rgoe enroll` publishes
// and the on-chain slash names. So a member's Rust and JS clients are the same member, and the
// leaf here is exactly the entry in group/members.json.
//
// Consumers: `rgoe identity` (group/identity.mjs, the operator/member-facing command) and the
// Rust interop harness (rust/rgoe-rln/interop/egress-derive.mjs). They MUST agree byte-for-byte,
// which is why the serialization lives here too and group/identity.selftest.mjs pins both.
//
// NOTE: the leaf depends on K (RGOE_SLOTS, default 8) exactly like every other rateCommitment in
// the system — derive with the same RGOE_SLOTS the fleet runs, or the leaf will not be in the tree.

import { identityFor, identitySecretOf, rateCommitmentOf } from "./rln.mjs";

// identityFileFor(secret) -> { identitySecret, leaf } (decimal strings, as the Rust side parses).
// `secret` is the app secret (0x-hex or decimal; toField() normalizes it) — the RGOE_SECRET value.
export function identityFileFor(secret) {
  if (typeof secret !== "string" || secret.trim() === "") throw new Error("identityFileFor: empty secret");
  const identity = identityFor(secret.trim());
  return {
    identitySecret: identitySecretOf(identity).toString(),
    leaf: rateCommitmentOf(identity).toString(),
  };
}

// The exact on-disk bytes: 2-space JSON + trailing newline (what the harness has always written,
// what the Rust client parses). Key order is fixed by construction above.
export function serializeIdentityFile(file) {
  return JSON.stringify({ identitySecret: file.identitySecret, leaf: file.leaf }, null, 2) + "\n";
}
