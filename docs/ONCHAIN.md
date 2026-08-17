# On-chain staked reputation set: max-anonymous admission with slashing

**Status: design doc; the core is built.** `contracts/StakedReputationSet.sol` (stake,
ZK-authorized exit/withdraw via `contracts/WithdrawVerifier.sol`, permissionless slash by
secret reconstruction, on-chain incremental tree + `currentRoot` accessor) is live on Sepolia
as release `rln-v3` (`network/sepolia/contracts.json`; the live deployment still points at
`MockWithdrawVerifier`, see `docs/CONTRACTS-AUDIT.md` section 3); the gateway reads the root
through `lib/root-provider.mjs` (`RGOE_GROUP_CONTRACT`; `node` provider, plus the EIP-1186
`light` provider, whose stateRoot is anchored to the beacon sync committee when the opt-in Helios
sidecar is on, `RGOE_HELIOS_RPC_URL`, T-DEV-9b); `contracts/GatewayRegistry.sol`
is deployed on Sepolia at `0x94ECeD0C1c7a8793a5c901c8C1995C8E7039A868` (block 11509783,
`network/sepolia/contracts.json`). Read the design below for the reasoning; read
`docs/CONTRACTS-AUDIT.md` for the invariants as implemented. This is ROADMAP-v1 item #2 ("On-chain reputation
set") sharpened on two axes the roadmap deliberately left open:

1. **Max anonymity of enrollment.** ROADMAP-v1 #2 parks enroller privacy as out of
   scope, noting that "enrollment is now publicly timestamped and linkable to the
   address that paid the gas." This doc closes that link.
2. **Staking with slashing.** Admission is a bonded stake. It is refundable (unstake
   to get it back), slashable by the egress (claim a spammer's bond), and the exit
   is time-locked for protocol security.

## Relationship to the other docs

- **ROADMAP-v1 #2** is the baseline: move the set from `group/members.json` to an
  on-chain Semaphore group so the Merkle root is canonical, public, and
  tamper-evident, and the gateway reads it through a pluggable root provider (its own
  node, or a light client) instead of holding a synced file.
  Everything there still holds; this adds the stake, the anonymity, and the slash.
- **PAYMENTS.md** is a sibling, not a duplicate. That doc *sells access*: a
  fixed-denomination deposit, an operator `sweep`, no refund, redeemed off chain.
  This doc *gates admission*: a bond the **member** owns and can reclaim, that the
  **gateway** can slash on abuse. They share two building blocks — the Railgun-style
  Layer-0 funding hop and the on-chain Merkle root — and differ on who owns the funds
  and whether there is slashing. You can run either, or both (stake to get in, prepay
  to use).
- **adversarial-review.md** frames why this matters: finding #1 (the operator must
  stop holding member secrets — self-enrollment), finding #2 and #10 (admission is
  the sybil boundary *and* the unblockability boundary; abuse needs a cost). Staking
  is the "cost" those findings ask for; slashing is the eviction path.
- **ROADMAP-v1 #1** (unlinkable per-request nullifiers) and **FLEET.md** (the gateway
  fleet) compose with this doc. The slashing mechanism below is RLN; #1 is the same
  RLN machinery pointed at unlinkability, and the fleet is where slashing has to go
  from single-node to shared. Cross-references are called out inline.

## Requirements, restated

| # | Requirement | Where it is met |
|---|---|---|
| R1 | Max anonymous: unlinkable funding source ↔ member | Layer-0 shielded funding (Railgun / Privacy Pools) into a fresh staking address; permissionless commitment registration; ZK-authorized, recipient-specified refund |
| R2 | Refundable: unstake to reclaim the bond | `withdraw`, authorized by a ZK proof of the commitment secret, paid to a caller-specified fresh address |
| R3 | Slashable: egress claims a spammer's bond | RLN reconstruction of a proven over-spender's secret → permissionless `slash(commitment, secret, receiver)` |
| R4 | Time-locked exit | `initiateExit` starts an unbonding delay `U`; the bond stays slashable for the whole `U`; `withdraw` only after |
| R5 | Gateway monitors its own nodes for double-spend / replay and for member exits | Per-nullifier share-collecting spent-set + recent-roots tracking; distinguishes replay (dedup, no slash) from over-spend (reconstruct, slash) |

## The core tension, and why it forces RLN

An anonymous gate that can slash a *specific* spammer's stake is a contradiction on
its face: to slash you must name the leaf, but the whole design exists so you cannot
see the leaf. Stock Semaphore cannot resolve this. Its nullifier is
`H(secret, scope)`, one-way; the gateway learns the nullifier and never the
commitment. There is nothing to slash on.

**RLN resolves it, and slashing is exactly what RLN was built for.** In an RLN proof
the member also emits a Shamir secret-share of its identity secret, evaluated at a
point derived from the message, on a polynomial whose degree equals the rate limit.
For a limit of `L` signals per epoch the polynomial has degree `L`, so:

- **Up to `L` signals in an epoch reveal `≤ L` shares.** A degree-`L` polynomial needs
  `L + 1` points to interpolate, so `L` shares reveal **nothing** about the constant
  term. Honest members are safe and stay anonymous.
- **The `L + 1`-th distinct signal in the same epoch reveals one share too many.** Now
  anyone holding the shares interpolates the constant term, which is the identity
  secret. From the secret you derive the identity commitment (the leaf), and call
  `slash(commitment, secret, ...)` on chain.

So **cheating is the only thing that deanonymizes you**, and only to your pseudonymous
leaf, never to a real identity (the Layer-0 hop keeps even a slashed member unlinked
to a person). This is the minimal, intended disclosure.

**The gateway is the reconstructor.** RLN's canonical deployment gossips shares on a
public network so anyone can reconstruct. We do not need that: the gateway is a single
verifier and it *already receives every signal directed at it* inside the Tor tunnel,
so it holds the shares itself and reconstructs locally. This is strictly simpler than
public RLN and it reconciles with ROADMAP-v1 #1's remark that "our proof never leaves the
Tor-encrypted tunnel to a single verifier, so there is no public share to slash on."
Correct — there is no *public* share. There is a **private** share, held by the one
verifier, and it becomes reconstructable only on a provable rate violation. The single
gateway is a feature here, not a limitation. (Going multi-gateway reintroduces the
need to pool shares; see the fleet section.)

**Consequence for the code.** The proof is no longer stock Semaphore; it is RLN.
Adopt the [rate-limiting-nullifier](https://rate-limiting-nullifier.github.io/rln-docs/)
project's circuit and artifacts (`rlnjs` / `zerokit` / the circom `rln` circuit)
rather than hand-rolling one. The RLN circuit already does Merkle membership + a
Poseidon nullifier + the share evaluation in one proof, and its tree is a Poseidon
incremental Merkle tree compatible with the Semaphore/LeanIMT group we already build.
So `lib/semaphore.mjs` swaps `@semaphore-protocol/proof` for an RLN prover/verifier;
the group machinery is largely reusable.

**Two budget knobs, kept distinct.** The RLN degree `L` sets the *slashable* threshold
(exceeding it is provable over-spend). The gateway's own in-memory `Map` budget can
still rate-limit *below* `L` without slashing, so ordinary throttling stays a soft
refusal and only genuine abuse burns a bond. Set `L` at the hard ceiling you are
willing to slash on; set the soft budget wherever you want to start refusing.

## The contract

Prior art is direct: the RLN project ships an on-chain registry (`RLN.sol`) that is
already a staked-registration + slashing + delayed-withdrawal contract. Our
`StakedReputationSet` is that shape, adapted to our egress semantics and our anonymity
requirements. Reference interface (see `contracts/StakedReputationSet.sol` for the
commented reference implementation):

```solidity
BOND        // fixed denomination, so stake amounts never fingerprint a member
UNBONDING   // exit time-lock; must satisfy the ordering constraint below
group       // the on-chain Semaphore/RLN group (Merkle root of commitments)

register(uint256 commitment) payable
    // permissionless. msg.value == BOND. addMember(commitment); record the bond.
    // The commitment binds the bond to a secret only its holder knows. Anyone may
    // pay to register any commitment; only the secret-holder can ever spend or exit it.

initiateExit(bytes withdrawProof)
    // authorized by a ZK proof of knowledge of the secret behind `commitment`,
    // NOT by msg.sender. Marks the member exiting, starts the UNBONDING clock,
    // and removes the commitment from the admission root.

withdraw(bytes withdrawProof, address recipient)
    // after UNBONDING elapses and the bond was not slashed: pay BOND to `recipient`
    // (a fresh, caller-specified shielded address), delete the member.

slash(uint256 commitment, uint256 secret, address receiver)
    // permissionless. Verify the revealed secret matches the commitment
    // (commitment == Poseidon(secret, ...)), pay BOND to `receiver`, remove the member.
    // Callable by whoever reconstructed the secret — in practice the gateway.
```

**Why authorization is a ZK proof, not `msg.sender`.** This is what makes R1 hold.
`register` is permissionless: it publishes a commitment and posts the bond from a
fresh Railgun-funded address, and the identity secret is generated locally and never
touches the chain. `initiateExit` and `withdraw` cannot key off `msg.sender`, because
the member is anonymous and its on-chain addresses are throwaway; instead they carry a
ZK proof "I know the secret behind this commitment" (a withdraw-scoped nullifier) and
name the refund recipient in the call. This is the Tornado withdrawal pattern
(prove knowledge, pay to a specified recipient) and it keeps both the fund-in and the
fund-out endpoints as unlinkable shielded addresses. `slash` needs no authorization at
all: possession of a valid `(commitment, secret)` pair *is* the authorization, and
that pair only exists after a proven over-spend.

## The exit time-lock, reconciled with the freshness window (R4, R5)

This is the protocol-security core, and it is where the three clocks in the system
have to be ordered correctly or the slash is dodgeable.

Three clocks:

- **`E` — epoch length.** Nullifier rotation and rate-budget window (today 86400s;
  shorter for tighter unlinkability).
- **`F` — root freshness window.** The on-chain analog of today's "this-epoch or
  last-epoch" skew tolerance (ROADMAP-v1 #2): the gateway accepts a proof built against
  any root that was current within the last `F`. So a commitment removed from the root
  at time `T` can still authorize egress until `T + F`, using a proof against a
  pre-removal root.
- **`U` — unbonding delay.** From `initiateExit` to a permitted `withdraw`.

**The constraint: `U ≥ F + E + C`**, where `C` is a confirmation margin for the
gateway to land a slash transaction.

Reasoning, the escape it closes:

1. A member calls `initiateExit`. The commitment leaves the *current* root, but proofs
   against pre-removal roots stay valid until those roots age out of the freshness
   window, i.e. until `T + F`. The member can still egress — and still over-spend —
   during that window.
2. An over-spend inside that window produces a reconstructable secret. The gateway
   needs time to submit `slash` and have it confirm: the margin `C`.
3. The epoch term `E` covers the front-run where a member initiates exit at the very
   end of an epoch and over-spends in the next epoch under a root that is still fresh.

Bounding `U ≥ F + E + C` guarantees the bond is still on chain and still slashable for
the entire period during which any proof it ever authorized could still be redeemed
and its abuse detected. **The bond stays fully slashable for the whole of `U`**; a
slash during unbonding makes `withdraw` revert. That is the "you cannot spam and then
instantly unstake to dodge the slash" property, the same rationale as an Ethereum
validator exit queue or a Cosmos unbonding period, stated in our terms.

Concretely, with `E = 1h`, `F = 1` epoch, and `C ≈ 13min` of L1 finality (~2 epochs),
`U ≥ ~2.25h`; round to `U = 24h` for margin and for ordinary staking-exit ergonomics.
`U` is a deployment parameter, but it must never be set below `F + E + C`, and the
contract should encode that lower bound so a misconfiguration cannot open the escape.

## Double-spend and replay monitoring on the gateway's own nodes (R5)

The gateway maintains, per epoch, a spent-set keyed by RLN nullifier that collects
*shares*, not just a count. Two failure modes must be told apart, and getting them
mixed up is the way to either miss abuse or slash an honest retry:

- **Replay of the identical signal** (same nullifier, same evaluation point / same
  share): this is a duplicate, **not** a rate violation. It reveals no new share, so
  it must be deduped and refused (or served idempotently) and it must **never** trigger
  a slash. This is why the RLN message has to be **bound to the request** — the target
  `host:port` plus a per-connection anti-replay salt — so an honest retry (which
  reuses the same signal) is distinguishable from a genuinely distinct new signal.
  (This also finally closes adversarial-review finding #8, "MESSAGE is a constant";
  binding the message is required here, not optional.)

  **Client invariant — the signal must be deterministic per logical request.** This is
  the one place a rogue gateway has a lever: it cannot forge a member's shares (it lacks
  the secret), but it *can* fail requests to induce the client to retry, and if the shim
  generated a *fresh* signal per retry those would be distinct points and a forced retry
  storm could push an honest member past `L` and get them slashed. So the shim must make
  the signal a deterministic function of the logical request (target `host:port` + a
  stable per-request nonce) and **reuse the same signal on every retry of that request**.
  Then an induced retry reproduces the *same* share (same evaluation point, no new
  information) and the rogue-gateway "force retries to manufacture an over-spend" attack
  does nothing. This invariant lives in the shim, and it is load-bearing: without it, a
  gateway can slash honest members by making them retry.
- **A distinct signal under the same epoch nullifier beyond degree `L`** (the real
  over-spend): the gateway now holds `L + 1` shares for that nullifier, interpolates
  the secret, derives the commitment, and slashes. This is the slashable event, and it
  is provable: the shares themselves are the evidence.

**Membership and root freshness.** The gateway tracks the on-chain group — the current
root plus every root inside the freshness window `F` — refreshed on `MemberAdded` /
`MemberRemoved` / exit events. `checkProof`'s single-root equality test becomes
membership in that recent-root set. When a member calls `initiateExit`, the gateway
sees the removal and immediately stops accepting *new-root* proofs from it, but keeps
honoring *old-root* proofs until they age out at `T + F`, and **keeps that nullifier's
share-set alive for the whole window** so a late over-spend is still caught and still
slashable (which is exactly why `U` must cover `F`).

## Reading the root: a modular provider, on Ethereum L1

We target **Ethereum L1**, not an L2. This is the same argument PAYMENTS.md makes for
L1: every L2 runs a single sequencer, which is exactly the "one specific party" that
can censor, reorder, and observe, and the admission root is the last place we want a
trusted intermediary. L1 has no single sequencer, its finality is real (Casper FFG,
~2 epochs / ~13 min), and — a bonus for a sybil gate — enrollment costing real L1 gas
is a *feature*: every member pays gas plus the bond, which raises the sybil and
unblockability cost (adversarial-review #3, #10) rather than being a tax.

**How the gateway reads the root is pluggable, behind one interface.** The gateway does
not care *how* it learned the current root; it only needs the set of roots it will
accept proofs against right now. So the source is a `RootProvider` with a single shape
(see `lib/root-provider.mjs`):

```
RootProvider.currentRoots() -> {
  roots: [string],        // current root + every root still inside the freshness window F
  observedAtBlock: number,
  finalized: bool
}
RootProvider.onChange(cb)  -> unsubscribe   // optional: refresh promptly on membership change
```

`checkProof` consumes `currentRoots()` and nothing else, so the two providers below are
interchangeable at config time (`RGOE_ROOT_PROVIDER=node|light`) with no change to the
gate:

- **`NodeRootProvider` (trusted local node).** `eth_call` the group contract's `root()`,
  backfill the recent-root set from `MemberAdded` / `MemberRemoved` logs, read at a
  confirmation depth (finalized, or `head − N`). The trust is a node the operator runs.
  **This is the solo-staker path, and for them it is not a compromise but the optimum**:
  someone running this next to their own validator already operates a trusted local
  node, so reading its state is fully trust-minimized *for them* with zero extra
  machinery. Just point `RGOE_RPC_URL` at `localhost:8545`.
- **`LightClientRootProvider` (Helios-style).** For operators who do *not* run a full
  node — e.g. someone running many gateways — validate block headers against the sync
  committee, then verify the root's storage slot with an `eth_getProof` state proof
  against the validated `stateRoot`. Now the RPC is a dumb data pipe: a hostile RPC can
  cause unavailability but cannot forge a root, because it cannot produce a valid
  Merkle-Patricia proof for a root that is not in state. The trust is Ethereum
  consensus, not a provider.

The two providers are **not fully symmetric**, and it constrains the contract: a light
client can only prove a root that lives in an **on-chain storage slot**, so the
light-client path *requires* the group's root to be maintained on chain. **As of T-DEV-9
this is done:** `StakedReputationSet` maintains the identical RLN depth-20 Poseidon(2)
incremental tree on chain and commits the current root to a fixed slot
(`currentRoot`, `ROOT_STORAGE_SLOT = 3`), with the same zero-in-place removal semantics as
the off-chain `reconstructRoot`, so the two roots are equal by construction (pinned to the
`lib/rln-removal-parity` golden in `test/StakedReputationSet.t.sol::test_Root_*`). The node
provider can instead reconstruct the tree from `Member*` events, because there you already
trust the node's log view. Both paths now work against the same contract.

*Trust chain of the shipped light client.* `LightClientRootProvider` verifies the account
+ storage Merkle-Patricia proofs from `eth_getProof` against a block's `stateRoot`, so a
hostile RPC cannot forge the root's **value**. Where that `stateRoot` comes from is the last
link, and it is a switch (T-DEV-9b, `docs/LIGHT-CLIENT.md` "Decision, how-to and receipt"):

- `RGOE_HELIOS_RPC_URL` **unset** (default): the header is fetched from the RPC at the
  confirmed depth and *trusted*. The gateway logs `stateRootSource: rpc header (TRUSTED, not
  verified; …)` at startup and results carry `stateRootVerified:false`. A lying RPC can pair a
  fake header with a proof consistent with it (the `THREAT-MODEL.md` "RPC lies about the
  stateRoot" lever).
- `RGOE_HELIOS_RPC_URL` **set** to a local Helios verifying RPC (`lib/helios-root.mjs`,
  sidecar via `bootnode/deploy/bootstrap.sh RGOE_HELIOS=1`): the header comes from Helios,
  i.e. it chains to a beacon **sync-committee**-signed execution payload; the RPC's header for
  the same block is only cross-checked and a divergence is rejected with a precise
  `stateRoot mismatch` reason. Now the whole chain — sync committee → `stateRoot` → account
  proof → storage proof → root — is verified end to end and there is **no RPC trust** left:
  the RPC can withhold, not lie. The residual trust is the sync committee (2/3-honest) plus
  Helios' weak-subjectivity checkpoint. Startup logs `stateRootSource: helios (sync-committee
  verified)`; results carry `stateRootVerified:true`.

A `RGOE_LIGHT_MODE=storageat` fallback (trusts the RPC for the value, no proof) exists for RPCs
without `eth_getProof` and is clearly the weaker mode (the Helios anchor does not help it).
Live receipt against the Sepolia contract with a Helios anchor: `docs/LIGHT-CLIENT.md`.

Both providers read at a **confirmation depth**, and this is what ties back to the
unbonding constraint. Reading *finalized* state means a reorg can never retroactively
change the admission set out from under an in-flight slash, at the cost of ~13 min of
enrollment latency (a new member waits for finality before egressing — fine for a
slowly-changing set). Reading `head − N` trades a small reorg risk for lower latency.
Either way, on L1 the slash-confirmation margin `C` is cleanly "one finality period," so
`C ≈ 13 min` and the `U ≥ F + E + C` bound lands comfortably at the ~24h we already
picked. L1 makes these margins *cleaner* than an L2 would, where finality is muddier.

**Liveness.** Reading the root adds a chain-liveness assumption to a system that is
otherwise fully local. Mitigate as ROADMAP-v1 #2 says — cache the last-known root and keep
gating against it if the provider is unreachable — with one caveat: *slashing* needs the
chain live to land the transaction, so an extended outage degrades to "still gating,
temporarily cannot slash." Both providers implement the same last-known-good cache, so
this behaves identically whichever source is configured.

**On a Rust rewrite.** This modular seam is also where a language choice lives. Helios
is a Rust crate, so a light-client-native gateway wants to *embed* it rather than shell
out to a sidecar, and the RLN verify on the hot path is equally at home in Rust. The
`RootProvider` interface is deliberately language-agnostic so the port, if we take it,
is bounded: reimplement the gateway + the two providers behind the same contract, keep
the circuit artifacts and the Solidity untouched. The recommendation is to build the
trusted-node provider first in the current Node stack (it is the solo-staker path and
needs no light client at all), prove the on-chain gate end to end, and treat "rewrite in
Rust to embed Helios" as a deliberate follow-on once the light-client path is the one
we actually need — not a prerequisite.

## Fleet composition: where single-node slashing breaks (see FLEET.md)

Everything above is correct for **one** gateway. Across a fleet it breaks in a
specific, important way, and it is the same fact from two sides:

- The in-memory spent-set does not compose. A member can emit `L` signals at gateway A
  and `L` more at gateway B. Each gateway sees only `L` shares for that nullifier,
  neither reaches `L + 1`, so **neither can reconstruct**, no slash fires, and the
  member also gets `N×` their intended budget across `N` gateways.
- To slash cross-gateway spam, gateways must **pool shares**: publish `(nullifier,
  share)` pairs to a common tally, so that once `L + 1` shares for one nullifier exist
  anywhere in the fleet, any gateway reconstructs and slashes. This is precisely RLN's
  original gossip design, reintroduced at the fleet layer. It is an honest cost, but a
  bounded one: shares reveal nothing below threshold, and reconstruction still only
  deanonymizes a *proven* over-spender's pseudonymous leaf.

This ties directly to FLEET.md's "the rate limit does not compose across the fleet"
section. The shared share-pool is the mechanism that makes both the fleet budget and
fleet slashing work, and it is only safe to share because RLN shares carry no
information until the abuse threshold is crossed. Rotation across the fleet (FLEET.md)
plus per-request unlinkable nullifiers (ROADMAP-v1 #1) plus this shared share-pool is the
combination that gives "no operator, even a colluding set, can profile a member, *and*
a spammer is still slashable no matter how they spread the abuse."

**State the limitation plainly here, not only in FLEET.md: as written above, slashing
is per-gateway, so a fleet without a shared tally lets a staked member split an
over-spend across two gateways and evade the slash for free.** The shared tally is what
closes that, and the two docs must agree on its schema. The tally is keyed
`(nullifier, epoch)`; for budget it maps to a `count`, and for slashing it maps to the
`shares` collected so far, and any gateway that observes the `L + 1`-th share
reconstructs and slashes. That `(nullifier, epoch) -> {count, shares}` shape is the one
contract between this doc and FLEET.md's "shared nullifier accounting"; whether it lives
in a replicated KV, a gossip tally, or on chain is an implementation choice, but the key
and the two values are fixed.

**On "one canonical root" (FLEET.md seam #1): one on-chain *source*, two distinct
lists.** Members and gateways are different node types — a member is an identity
commitment that proves membership, a gateway is an operator advertising an onion — so
they are not literally the same Merkle tree, and "the fleet shares the reputation set's
root" should be read as "the fleet directory is published by the same on-chain contract
system, from the same canonical source, verified the same way," not "gateways are leaves
in the member group." Concretely: one deployment, a member registry (this doc's
`StakedReputationSet`) and a gateway registry (a sibling contract holding
`{ onion, pubkey, weight }` advertisements, each self-authenticated because a v3 onion
*is* its key), both readable over the same RPC with no separate signer to trust. FLEET's
static-signed directory is the interim; this is its endgame, and it removes the pinned
directory signer in favor of the on-chain gateway registry.

## Max-anonymity leak ledger (R1)

| Link | Where it breaks | Residual to mitigate |
|---|---|---|
| funding identity → member | Layer-0 hop through a large shared pool (Railgun / Privacy Pools, user's choice, no mandated party) into a fresh staking address | pool anonymity set; fixed `BOND` denomination so the amount never fingerprints |
| staking address → member | `register` is a permissionless post of `(commitment, BOND)` from a shielded fresh address; the secret is generated locally and never revealed on chain | timing correlation between a shielded deposit and the `register` tx → dwell time, batch registrations per epoch |
| fund-in address → fund-out address | `withdraw` is authorized by a ZK proof of the secret and pays a caller-named fresh recipient, not `msg.sender`, so stake and unstake share no address-graph link | the *commitment* appears in both `register` and the exit path (it must, to be a tree leaf), so the two are linkable **via the pseudonymous leaf** — but that link carries no identity |
| gateway → which member, on honest use | RLN nullifier is one-way below the slash threshold `L` | none: honest members are cryptographically anonymous to the gateway |
| gateway → which member, on spam | reconstruction reveals the leaf | intended and minimal: only a proven over-spender, only to the pseudonymous leaf, still no real identity (Layer-0) |
| client IP → anything | the whole exchange rides the existing Tor onion | standard Tor caveats only (see adversarial-review #11) |

The one claim **not** to overstate: `register` and `withdraw` are *not* fully
unlinkable — the public commitment threads them. What is unlinkable is the identity and
the address graph. Neither endpoint links to a person, and the money in and the money
out are different shielded addresses; the only common thread is a pseudonymous leaf
that reveals nothing, exactly as any staking system's account is linkable to itself.

## What changes in the codebase

- **`lib/semaphore.mjs`** → gains an RLN mode: `generateProof` / `verifyProof` swap to
  an RLN prover/verifier (rlnjs / zerokit artifacts), plus nullifier + share
  extraction. `loadGroup` gains an on-chain mode behind `RGOE_GROUP_CONTRACT` /
  `RGOE_RPC_URL` / `RGOE_GROUP_ID`, with the JSON path kept as an offline cache whose
  root is verified against chain. The RLN message becomes request-bound (target +
  anti-replay salt), not the constant `1n`.
- **`gateway/gateway.mjs`** → `TRUSTED_ROOT` becomes a refreshed recent-roots set fed
  by a `RootProvider` (below); `spend()` becomes a share-collecting spent-set that
  reconstructs and slashes on threshold; add an on-chain slash submitter behind
  `RGOE_SLASH_KEY` (an operational hot key, deliberately separate from any member
  anonymity — the gateway slashing is not anonymous and does not need to be). Reorder
  the cheap public checks before the SNARK verify, as adversarial-review #4 recommends.
- **`lib/root-provider.mjs`** (new) → the pluggable root source behind
  `RGOE_ROOT_PROVIDER=node|light`: `NodeRootProvider` (trusted local node, the
  solo-staker path) and `LightClientRootProvider` (Helios-style state proofs, the
  run-many path), both returning the same `currentRoots()` shape with a shared
  last-known-good cache. See "Reading the root" above.
- **`group/enroll.mjs`** → self-enrollment first (member generates its `Identity`
  locally, submits only the `commitment`; closes adversarial-review #1), then a
  sibling that submits `register(commitment)` on chain with the bond.
- **`contracts/`** → `StakedReputationSet.sol` (reference implementation adapted from
  RLN.sol semantics) + deploy scripts. Ethereum L1 target: local `anvil` (or a mainnet
  fork) first, then Sepolia L1, then L1 mainnet. Semaphore/RLN have L1 deployments to
  reuse.
- **Circuit artifacts** → adopt the rate-limiting-nullifier circuit; do not hand-roll.
  This is the one heavy new artifact and it must be audited before any mainnet money.

## Tiers on chain (T-FEAT-8 follow-up — NOT deployed)

Off chain, a reputation tier is the leaf's `userMessageLimit` (`docs/adr/0006-reputation-tiers.md`):
`rateCommitment = Poseidon2(Poseidon1(identitySecret), limit)`, one tree for every tier, the
circuit range-checking the private `messageId` under the private `limit`. The deployed
`StakedReputationSet` (`network/sepolia/contracts.json`, `userMessageLimit: 8`) is immutable and
its `RateCommitmentHasher` pins `K = 8`, so today:

- `register(commitment)` admits a leaf at ANY limit — the contract cannot see the limit inside
  a leaf. Nothing stops a member from staking a tier-32 leaf; the gateway would honour it.
- `slash(commitment, secret, receiver)` checks `hasher.commitmentOf(secret) == commitment`
  with `K = 8`, so it can only slash tier-8 leaves. A tiered leaf on the on-chain root is
  therefore **unslashable on chain** — which is why the gateway's slash resolver
  (`resolveSlashLeaf`) falls back to the default tier's leaf in on-chain root mode and the
  runbook says: on chain, default limit only, until this ships.

The contract-side design (a redeploy — flagged for the human, never autonomous):

1. **Tiered hasher.** `ICommitmentHasher.commitmentOf(secret, limit)` (or a `TieredRateCommitmentHasher`
   with `commitmentOf(secret, limit) = Poseidon2(Poseidon1(secret), limit)`, `1 <= limit <= 65535`)
   and `slash(commitment, secret, limit, receiver)`: the slasher supplies the reconstructed secret
   AND the tier it resolved (`resolveSlashLeaf` already returns `{ commitment, limit }`); the
   contract recomputes the leaf at that limit. No ZK change; the same `(commitment, secret)`
   soundness argument (ADR 0005) holds per limit.
2. **Stake -> allowed limit at admission.** `register(commitment, limit)` records `limit` next to
   the bond and requires `msg.value == bondFor(limit)` from a fixed, small tier table (e.g. `8 =>
   BOND`, `32 => 4*BOND`) — a fixed denomination PER TIER so stake amounts still never fingerprint
   a member within a tier (R1); the tier itself is public at registration (as it is in
   `members.json`) but never at proof time. `slash`/`withdraw` pay `bondFor(limit)`.
   Alternatively keep `register(commitment)` limit-blind and let the operator's off-chain
   admission decide (today's behaviour) — simpler, but then the contract cannot slash tiers.
3. **Root reconstruction is unchanged** (`lib/root-provider.mjs` builds the tree from leaves;
   a leaf is a leaf), and so are the light-client / freshness-window paths.

Foundry: a `TieredRateCommitmentHasher` + `slash(.., limit, ..)` test that a tier-32 leaf slashes
only with `limit = 32` and a tier-8 leaf only with `limit = 8` (the JS goldens in
`lib/tiers.selftest.mjs` / `rust/rgoe-rln/tests/tree_parity.rs` `rate_commitment_tiers_*`).
Contracts are deliberately UNTOUCHED in this slice: the deployed set is immutable and a
tiered hasher only means something with the redeploy.

## Honest scope: what this does not solve

- **The RLN circuit is a real dependency and a real audit surface.** Adopt upstream,
  and treat "unaudited circuit + real bonds" as testnet-only until reviewed.
- **Stake is not proof-of-personhood.** It raises the sybil and unblockability cost
  (adversarial-review #3, #10) but a funded adversary can still buy in, become a
  member, and enumerate the fleet's egress IPs (finding #10). If unblockability against
  a well-capitalized adversary matters, compose the admission gate with an invite graph
  or World ID (both Semaphore-based, so they compose cleanly), not stake alone.
- **Chain-liveness for slashing.** Gating survives a root-provider outage on the
  last-known root (either provider mode); slashing does not, because it must land a
  transaction. Extended outages degrade to "gating, temporarily unable to slash."
- **The bond and its existence are public.** The fixed denomination hides *which*
  member and *how much beyond one unit*, but not *that* there is a staked set of a
  known size and unit bond. That is inherent to an on-chain, auditable set and is the
  point of putting it on chain.

## References

- **RLN (rate-limiting nullifier)** — the direct prior art for staked, slashable,
  anonymous rate limiting, including the on-chain `RLN.sol` registry
  (staked registration + slash + delayed withdrawal) and the circom circuit:
  `rate-limiting-nullifier` docs, `rln.waku.org`.
- **Semaphore v4 + LeanIMT** — the group/tree machinery reused under the RLN proof.
- **Shamir secret sharing / polynomial interpolation** — the slashing primitive: `L`
  shares hide the secret, `L + 1` reconstruct it.
- **Tornado-style prove-knowledge-then-withdraw-to-recipient** — the unlinkable,
  ZK-authorized refund pattern used by `withdraw`.
- **Railgun (proof-of-innocence, broadcaster network) / Privacy Pools** — the Layer-0
  shielded funding hop; user's choice of rail, no mandated party (same stance as
  PAYMENTS.md Layer 0).

Numbers and library maturity above should be re-verified against current sources before
this is built. The design does not depend on any single figure.
