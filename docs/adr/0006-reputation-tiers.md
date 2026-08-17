# ADR 0006: Reputation tiers are per-leaf `userMessageLimit`s in one tree

- Status: Accepted (JS + Rust clients and gateway shipped; on-chain tier admission is a follow-up)
- Date: 2026-08-17
- Task: T-FEAT-8 (docs/SHIP-PLAN.md) — reputation-weighted rate budget

## Context

Membership was binary: every member proved against the same leaf formula and got the
same per-epoch budget `K` (`K_SLOTS = 8`, `RGOE_SLOTS`). T-FEAT-8 asks for a spectrum:
"a member with higher on-chain stake (or accrued good behavior) proves, in zero knowledge,
a budget tier and gets a larger `K`, without revealing which member" — two tiers with
different `K`, each proven in ZK, the gateway enforcing the proven tier, and no member able
to claim a tier it lacks. The task text assumed a circuit change ("the RLN circuit taking a
tier as a range-checked public input").

Reading the circuit we ship (`circuits/rln/ARTIFACTS.md`, circom-rln v1.0.0 `RLN(20,16)`)
shows the tier is ALREADY a circuit input — it is just private:

```
identityCommitment = Poseidon(1)([ identitySecret ])
rateCommitment     = Poseidon(2)([ identityCommitment, userMessageLimit ])   // the tree leaf
messageId < userMessageLimit                                                 // RangeCheck(16), asserted
public signals: [ y, root, nullifier, x, externalNullifier ]                 // no limit on the wire
```

`userMessageLimit` is a PRIVATE witness that is (a) hashed into the leaf the Merkle path
opens and (b) the upper bound of the in-circuit range check on the private `messageId`. Every
side of the repo simply hard-wired it to 8: `lib/rln.mjs` (`K_BIG` in the leaf and in
`proveForSlot`), the JS client's slot pool (`makeSlotPool` wraps at `K_SLOTS`), the Rust
client (`slotcursor::K_SLOTS`, `--k`), the identity file, `group/enroll.mjs`, and on chain
`RateCommitmentHasher.K = 8` (`network/sepolia/contracts.json` `userMessageLimit: 8`).

## Decision

**A tier IS the leaf's `userMessageLimit`.** One tree holds every tier; a member enrols a leaf
`Poseidon2(Poseidon1(identitySecret), limit)` at its tier's limit and proves with that same
limit. Nothing else changes:

- **Proven in ZK, without revealing which member — or which tier.** The proof opens a leaf
  that commits to `limit` and asserts `messageId < limit`; both are private. The public
  signals, the envelope (`docs/PROTOCOL-API.md`), and `verifyEnvelope`'s result are
  byte-identical across tiers. The gateway learns nothing about a proof's tier — strictly
  more private than the task's "public tier input", and than the separate-root alternative
  below.
- **The gateway enforces the proven tier** the only way a private input can be enforced:
  the Groth16 verify against a TRUSTED ROOT (`wrong-group-root` before any SNARK work), and
  the per-nullifier spent-set. A tier-1 member (limit 8) has no valid proof for
  `messageId >= 8` (client pre-check `slot i >= limit`, and bypassing it the circuit's
  RangeCheck asserts), so its 9th distinct request in an epoch must reuse a messageId =>
  the same nullifier with a distinct `x` => `over-spend-slashed`. A tier-2 member (limit 32)
  gets 32 distinct nullifiers from the same tree.
- **A member cannot claim a tier it lacks.** A different limit is a different Poseidon
  output, i.e. a leaf that is NOT in the tree: `proveForSlot(.., { limit: 32 })` for a
  tier-8 member fails at the Merkle lookup ("not in group"), and a real proof over a
  forged tree containing the wished-for leaf is rejected `wrong-group-root`. Tier
  admission is therefore exactly leaf admission: whoever admits leaves (the operator's
  `members.json`, or the contract) decides who may hold which limit.
- **Slashing names the right leaf.** After an over-spend the gateway holds the
  reconstructed `identitySecret` but not the tier. `resolveSlashLeaf(secret, { tiers,
  hasLeaf })` derives one candidate per known tier (`RGOE_TIERS`, always containing `K`)
  and picks the one present in the local set; with no leaves (on-chain root mode) it falls
  back to the default tier's leaf (`resolved:false`, a warn) — the pre-tier behaviour and the
  only leaf today's on-chain hasher can slash (see Consequences).
- **Bounds.** `MAX_LIMIT = 65535`: the circuit compares with `LessThan(16)`, which is NOT
  sound for a limit >= 2^16 (a leaf with such a limit is not rejected by the circuit), so
  `normLimit` refuses it everywhere a leaf is derived, and admission MUST never accept one.

Surface (all default to `K_SLOTS`, so pre-tier files, leaves, and wire bytes are unchanged):
`rateCommitmentOf(identity, limit)`, `deriveCommitment(identitySecret, limit)`,
`proveForSlot(.., { limit })`, `groupFromIdentities([{ identity, limit }])`,
`RgoeClient({ limit })` / `RGOE_LIMIT`, `rgoe enroll --limit N`, `rgoe identity --limit N`
(writes `limit` into the Rust identity file only when non-default), Rust `--k` (defaults to
the identity file's `limit`, else 8), gateway `RGOE_TIERS`.

## Consequences

- No circuit change, no new trusted setup, no artifact rotation, no wire version bump, no
  Rust conformance-vector change: the envelope shape and public signals are unchanged.
- The tier is a per-leaf, admission-time fact. Changing a member's tier = removing its
  leaf and admitting a new one (the member re-enrols at the new limit; the identity secret
  can stay). There is no "upgrade in place".
- A member must run its client with the limit its leaf was enrolled with (`RGOE_LIMIT`,
  identity-file `limit`, `--k`); a mismatch fails at prove time, never on the wire.
- **On chain, tiers are not admitted yet.** `StakedReputationSet` is immutable and its
  `RateCommitmentHasher` pins `K = 8`, so (1) on-chain `register` admits leaves at any
  limit (a leaf is opaque to the contract) but (2) `slash(commitment, secret)` recomputes
  `Poseidon2(Poseidon1(secret), 8)` and can therefore only slash tier-8 leaves. Tiered
  members on the on-chain root are unslashable until the follow-up in `docs/ONCHAIN.md`
  "Tiers on chain" ships (a `slash(commitment, secret, limit)` / tiered hasher + a
  stake-amount -> allowed-limit admission rule) — a redeploy, flagged for the human. Until
  then tiers are safe to use on `members.json` gateways (dry-run / local slash resolves the
  tier) and, on chain, only at the default limit.
- The gateway's `RGOE_TIERS` is bookkeeping for the slash path, not a policy: proof
  verification does not consult it, and an unknown-tier over-spend still slashes (the
  default leaf, with a warn).

## Alternatives considered

- **Tier as a new PUBLIC circuit input** (the task's original framing). Needs a circuit
  change + a new ceremony (`docs/CEREMONY.md`), a wire bump, and it publishes the tier on
  every request — a linkability channel across the fleet's logs (`docs/THREAT-MODEL.md`
  §4.13 spirit). Rejected: strictly more work and strictly less private than what the
  shipped circuit already gives.
- **One tree per tier, gateway maps root -> K.** Also zero circuit work and simple, but
  the root IS a public signal, so every proof reveals its tier to the gateway and to any
  observer of the accepted-root set; it also splits the anonymity set per tier and doubles
  the root plumbing (on-chain contract, root providers, freshness windows). Rejected: the
  per-leaf limit gives the same enforcement with one tree, one root, and no tier leak.
- **Gateway-side counting (`K` per nullifier family).** Impossible: nullifiers are
  unlinkable by design, so the gateway cannot count a member's requests; the only counter
  is the circuit's messageId range, which is what per-leaf limits use.

## References

- `circuits/rln/ARTIFACTS.md` — leaf formula, `RLN(20,16)`, public-signal order.
- `lib/rln.mjs` — `K_SLOTS`, `MAX_LIMIT`, `normLimit`, `parseTiers`/`TIERS`,
  `rateCommitmentOf`, `deriveCommitment(s)`, `resolveSlashLeaf`, `proveForSlot({ limit })`.
- `gateway/gateway.mjs` — `deriveSlashLeaf`, `RGOE_TIERS` startup line.
- `client/rgoe-client.mjs` — `makeSlotPool({ K })`, `RgoeClient({ limit })`, `buildEnvelope`.
- `lib/identity-file.mjs`, `group/identity.mjs`, `group/enroll.mjs` — `--limit`.
- `rust/rgoe-client/src/main.rs` (`IdentityFile.limit`, `--k`), `rust/rgoe-client/src/slotcursor.rs`
  (`MAX_LIMIT`), `rust/rgoe-rln/src/tree.rs` (`rate_commitment`), `rust/rgoe-rln/tests/tree_parity.rs`.
- Tests: `lib/tiers.selftest.mjs` (fast), `test/reputation-tiers.selftest.mjs` (real proofs).
- `docs/ONCHAIN.md` "Tiers on chain" — the contract-side follow-up.
