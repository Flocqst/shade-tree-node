# Roadmap: scoped but not built

Design for the pieces we have worked out but deliberately left out of the proof
of concept. Each is a real protocol change, not a config tweak. The README links
here so it can stay a README.

### 1. Unlinkable rate limiting (decouple linkability from the rate window)

**Problem.** The gate rate-limits per member by scoping the nullifier to the
current epoch (`scope = floor(now / 86400)`, a day by default). That scope is
public and shared, so every request a member makes within the day carries the
same nullifier. The
gateway can count them, which is the point, but it can also link them. Shrinking
the epoch shrinks the linkable window but also shrinks the budget, so it looks like
rate limiting and unlinkability trade off against each other.

**They don't.** The trick is to stop publishing the scope. Make the epoch long, let
a member scope each request to a *different* epoch of their choosing, and prove in
zero knowledge only that the chosen epoch `e` is in range, for example
`present - W <= e <= present`, without revealing which `e`. Now:

- each request uses a distinct, member-chosen `e`, so each carries a distinct
  nullifier and the requests are **mutually unlinkable**, even to the gateway,
- the number of valid `e` values in the window (`W + 1`) bounds how many distinct
  nullifiers a member can present, so the **rate is still capped**: roughly one
  fresh nullifier per epoch sustained, with a burst of `W + 1`.

It turns out this ships in two tiers, and the first one needs **no custom circuit
at all.**

**Tier 1: public slots, stock Semaphore (buildable now).** Publish `K` scope slots
per epoch, `scope_i = H(epoch, i)` for `i` in `[0, K)`. The client uses a different
slot for each request and generates one ordinary Semaphore proof per slot. The
gateway accepts a proof only if its `scope` is in the published slot set for the
current or previous epoch, and dedups per nullifier as it does today. This already
breaks the tension:

- each slot yields a distinct nullifier `H(secret, scope_i)`, and those nullifiers
  are **mutually unlinkable** to the gateway, so a member's requests across slots
  cannot be tied together,
- a member has exactly `K` valid scopes per epoch, so the **rate is capped at `K`**
  no matter how they interleave them.

The cost is that the client now generates up to `K` proofs per epoch instead of one.
At ~0.7s per proof (see [proof overhead](#proof-overhead)) that is the difference
between a per-request stall and a non-issue: **precompute the epoch's `K` proofs in
the background at epoch rollover and rotate through them per request**, so the hot
path is just "pick the next unused proof," near zero latency. `K = 30` is ~21s of
background work per hour, fully parallel across cores. This is the bulk-generate-and-
rotate strategy, and it is what makes per-request unlinkability usable. The only
residual leak is that the gateway learns *which slot index* a request used (not who
used it), so it sees the slot-usage histogram but never a member.

**Tier 2: hidden slots, custom circuit (hardening).** To also hide the slot index,
and to get a sliding-window budget instead of a fixed per-epoch `K`, move the scope
inside the proof: prove in zero knowledge that the chosen epoch `e` satisfies
`present - W <= e <= present` (and `i < K`) without revealing `e` or `i`. Now the
gateway learns nothing but a fresh nullifier and the fact that it is in-budget.

- A custom circuit replaces the stock Semaphore proof: Merkle membership, a
  Poseidon nullifier over a *private* scope, and a comparator enforcing the range
  bound on `e` (and `i < K`). `present` is a public input the gateway pins to its
  clock.
- The gateway keeps a spent-nullifier set across the last `W + 1` epochs instead of
  just the current and previous epoch. Bounded by `K * W * activeMembers`.
- No slashing. RLN reconstructs an over-spender's secret from Shamir shares revealed
  in *public* messages. Our proof never leaves the Tor-encrypted tunnel to a single
  verifier, so there is no public share to slash on and nothing to reconstruct. The
  gateway simply refuses a nullifier once its budget is spent. This is strictly
  simpler than RLN and a better fit for the single-verifier setting.

**Cost.** Tier 1 is a small change to the gateway's scope check plus a precompute
loop in the shim, both on stock Semaphore. Tier 2 adds a circuit to write, audit,
and ship artifacts for, in exchange for hiding the slot index and a more flexible
budget. Tier 1 is the next thing to build; Tier 2 is the hardening after it.

### Proof overhead

Measured locally (Apple Silicon, `@semaphore-protocol` v4), so the numbers above are
grounded:

| Reputation set | Merkle depth | Proof size | Generate (warm) | Verify |
|---|---|---|---|---|
| 1 member | 1 | 882 B | ~470 ms | ~32 ms |
| 100 | 7 | 882 B | ~784 ms | ~30 ms |
| 1000 | 10 | 884 B | ~891 ms | ~30 ms |

Takeaways: the proof is **tiny and fixed-size** (~0.9 KB, a Groth16 proof plus
public signals, independent of set size), verification is **cheap and constant**
(~30 ms, so the gateway can verify thousands/sec/core), and **generation is the only
real cost** (~0.5–0.9s warm, growing slowly with tree depth, plus a one-time ~2–4s
cold start for artifact load). Today the shim pays one generation per epoch and
caches it, so cost is negligible. The bulk-precompute strategy above keeps it
negligible even when every request wants its own nullifier.

### 2. On-chain reputation set (Ethereum)

**Problem.** Today the reputation set is `group/members.json`, a file the gateway
and every client must hold byte-identical or proofs fail the root check. The trust
root is whoever runs `enroll.mjs`. There is no public audit trail, no shared source
of truth, and updating the set means redistributing a file out of band.

**Goal.** Source the set from an Ethereum contract so the Merkle root is canonical,
public, and tamper-evident, admission is enforced on-chain, and the gateway and
clients both read the same root from the same place with no file to sync.

**Design.**

- Deploy Semaphore's on-chain group contract (`Semaphore.sol` maintains a group's
  members, exposes the current Merkle root, and accepts proofs against recent roots
  within a freshness window). Members are added by `addMember(groupId, commitment)`,
  gated by whatever admission policy you want in front of it: `onlyOwner`, a stake
  deposit, a token balance, a DAO vote, or a World ID proof (itself Semaphore-based,
  so it composes cleanly).
- The gateway stops calling `loadGroup()` on JSON and instead reads the group's
  current root, plus the recent roots inside the freshness window, from the contract
  over RPC, refreshing on `MemberAdded` events. `checkProof`'s single-root equality
  test becomes membership in that recent-root set. The freshness window is the
  on-chain analog of the current "this epoch or last epoch" skew tolerance: a proof
  built against a root that was current a block ago still verifies.
- Clients derive the leaves from `MemberAdded` event logs and rebuild the tree
  locally, then check the local root against the on-chain root before trusting it.
  No `members.json` to ship. `members.json` can stay as an offline cache whose root
  is verified against chain.

**What changes.**

- `lib/semaphore.mjs`: `loadGroup()` gains an on-chain mode behind
  `RGOE_GROUP_CONTRACT` / `RGOE_RPC_URL` / `RGOE_GROUP_ID`, with the JSON path kept
  as the offline default.
- `gateway/gateway.mjs`: `TRUSTED_ROOT` becomes a refreshed set of recent roots.
- `group/enroll.mjs`: grows a sibling that submits `addMember` on-chain.
- New `contracts/` with the group contract and a deploy script.

**Cost and honest scope.**

- Adds an RPC dependency and a chain-liveness assumption to a system that is
  otherwise fully local. Mitigate by caching the last-known root: if the RPC is
  down, the gate keeps working against the last root it saw.
- Enrollment now costs gas and confirmation latency. Fine for a slowly-changing set;
  use an L2 (Base, Optimism, Arbitrum) to keep it cheap. Semaphore has deployments
  there.
- No new identity leakage. Only commitments go on-chain, exactly as in
  `members.json` today, and a commitment reveals nothing about who holds the secret.
  One new exposure: enrollment is now publicly timestamped and linkable to the
  address that paid the gas. If admission is stake- or token-based that linkage is
  inherent. If you need enroller privacy, relay the `addMember` call through a
  meta-transaction or a privacy pool. Out of scope here.
