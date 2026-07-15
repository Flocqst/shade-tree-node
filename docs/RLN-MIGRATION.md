# Plan: close the three PoC seams by adopting RLN

**Status: plan, not built.** Seams 1–3 from `network/sepolia/E2E-REPORT.md` §9
(membership-from-chain, real RLN circuit, real verifier/hasher) are **one** change:
replace the two-view Semaphore+JS-Shamir crypto with the real Rate-Limiting-Nullifier
circuit. This doc scopes that; build after review.

## Why one change closes all three

Today: membership leaf = `Poseidon(EdDSA-pubkey(secret))` (Semaphore identity), slash
leaf = `Poseidon(secret)` (on-chain). Different functions → the two-view seam.

RLN uses **`Poseidon(secret)` as the leaf for both** the membership proof and the
slashable identity, in one Groth16 proof that also emits the Shamir share. So:

- **Seam 2 (real circuit):** the RLN circuit *is* the real circuit. ✓
- **Seam 3 (real verifier/hasher):** its Groth16 verifier replaces `MockWithdrawVerifier`
  semantics; the hasher is already `Poseidon(secret)` (`MockCommitmentHasher`), which is
  RLN-correct. ✓
- **Seam 1 (membership-from-chain):** the on-chain `StakedReputationSet` already stores
  `Poseidon(secret)` leaves, and `loadGroupOnchain` already rebuilds that tree from
  `Member*` events. Once membership proofs verify against *that* tree (they will, under
  RLN), the gateway sources membership from chain and "stake → member" is automatic. ✓

The key unlock: **the on-chain side is already RLN-shaped** — we adapted
`StakedReputationSet` from RLN.sol and the hasher is already `Poseidon(secret)`. Only the
client/gateway crypto and the gateway's root sourcing change.

## What changes vs. what stays

| Stays unchanged | Changes |
|---|---|
| Tor transport, fleet, onion directory | `lib/rln.mjs` crypto core (Semaphore proof → RLN proof) |
| Shim rotation (gateway + slot) | `lib/semaphore.mjs` `proveForSlot`/`verifyEnvelope` internals |
| `StakedReputationSet` stake/slash/exit logic | Gateway: verify RLN proof; source root from chain (drop members.json default) |
| Envelope v2 shape (proof/nullifier/share) | Enrollment: RLN identity, register `Poseidon(secret)` on-chain |
| On-chain hasher (`Poseidon(secret)`) | New: Groth16 verifier contract for withdraw/exit ZK-auth |

## Decision points (resolve before building)

1. **Library: `rlnjs` (JS) vs `zerokit` (Rust).** `rlnjs` keeps the current Node stack and
   is the fast path. `zerokit` is the Rust path (pairs with the LIGHT-CLIENT.md /
   embedded-Helios direction). **Lean `rlnjs` now**, revisit zerokit with the Rust rewrite.
2. **Circuit artifacts.** Adopt upstream `rate-limiting-nullifier` circom `rln` + its
   Groth16 wasm/zkey/vkey. Do **not** hand-roll or re-trust a ceremony — use their
   published artifacts; pin hashes. This is the audit surface.
3. **Rate model.** RLN's `userMessageLimit` per epoch maps directly to our K slots. Confirm
   the mapping (K = messageLimit) and that the nullifier/share match our spent-set.
4. **Withdraw/exit ZK-auth.** RLN.sol's withdraw differs from our time-locked exit. Either
   graft our `initiateExit`/`withdraw` (with `U ≥ F+E+C`) onto RLN's registry, or add a
   real Groth16 withdraw verifier (replaces the mock's revealed-secret shortcut). Pick one.
5. **Migration.** `members.json` (identity leaves) is abandoned; members re-enroll with RLN
   identities and re-register `Poseidon(secret)` on-chain. Fresh testnet deploy; no
   in-place migration of the current 8 demo members.

## Phased build (each phase independently testable)

- **P1 — crypto swap (offline).** `lib/rln.mjs`: RLN identity, `proveForSlot` → RLN proof
  (real circuit), `verifyEnvelope` → RLN verify, keep `reconstructSecret`/share logic
  (RLN gives it natively). Unit test: prove→verify, 2-share reconstruct, K-limit. No chain,
  no Tor. *Gate: rln.selftest green.*
- **P2 — on-chain group + membership-from-chain.** Point the gateway at
  `RGOE_GROUP_CONTRACT` (on-chain root mode already exists); verify an RLN proof built
  against the on-chain-reconstructed root passes. Register a member, watch the gateway
  accept them with **no members.json**. *Gate: stake → recognized, on anvil.*
- **P3 — real slashing + exit.** Wire the Groth16 withdraw verifier (or graft the timelock);
  redo the integration test (`scripts/integration-sepolia.mjs`) with RLN proofs end-to-end
  on a fresh Sepolia deploy. *Gate: integration test green with the real circuit.*
- **P4 — fleet + live Tor.** Re-provision with RLN artifacts (add a role task to fetch +
  hash-pin the zkey/wasm — also fixes the corrupt-artifact issue seen this run). Live
  round-trip. *Gate: live fleet round-trip on RLN.*

## Cost / risk (honest)

- **The circuit is the audit surface.** Unaudited circuit + real bonds = testnet-only until
  reviewed. Biggest single risk.
- **Artifact size/latency.** RLN proving is heavier than Semaphore; re-check the hot path
  (still one prove per slot at request time until the precompute split, ROADMAP #1).
- **No mainnet until:** audited circuit, real (not mock) withdraw verifier, and the
  members-only directory (seam 4, separate — FLEET.md).

## Not in this plan (deliberately)

Seam 4 (public directory → members-only / on-chain gateway registry with service staking)
is independent and lives in FLEET.md. The Rust rewrite (zerokit + embedded Helios) is a
separate track (LIGHT-CLIENT.md). Sequence: **RLN first**, then those.
