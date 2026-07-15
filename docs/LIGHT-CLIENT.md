# Light-client integration: trust-minimized reads of the reputation root

**Status: protocol design, for review.** Not built. The near-term build uses the
trusted-node provider (`RGOE_ROOT_PROVIDER=node`), which is the right default for a solo
operator; this doc is the design for the *other* provider, so an operator who does not
run a full node can still read the reputation-set root without trusting an RPC. It is
written to be reviewed by someone who knows the Helios internals, so it front-loads the
trust model and collects the open questions at the end.

Context: the gateway is a Tor onion-service egress that admits only members of a
reputation set, where membership is an on-chain Semaphore/RLN group (docs/ONCHAIN.md).
The gateway's only on-chain read is **the group's current Merkle root, plus the recent
roots inside a freshness window `F`.** Everything downstream (proof verification, the
per-nullifier rate budget, slashing) is local. So the entire chain-trust question
reduces to: *how does the gateway learn the canonical root without trusting whoever
served it?*

## Why not the obvious two

- **Third-party RPC (Infura/Alchemy).** A lying RPC is not just a staleness problem: it
  can feed a root whose tree contains attacker commitments, so the attacker's own proofs
  verify and they egress for free, or a root that still contains a member you slashed.
  This is trusting exactly the party the rest of the system refuses. Disqualified for the
  admission root.
- **Own full node.** Correct and fully trust-minimized, and for a solo staker already
  running a validator it is *free* (they have the node). But it is the thing an operator
  who wants to run many gateways will not do per gateway. That is the gap this doc fills.

## What a sync-committee light client gives us, and what it costs

A Helios-style client validates the beacon chain's **sync committee** signatures to
obtain a validated execution-layer header, and therefore a trusted `stateRoot`, without
replaying the chain. Given a trusted `stateRoot`, the group contract's root is read with
an `eth_getProof` account+storage proof verified against that `stateRoot`; a hostile data
source then cannot forge the root, because it cannot fabricate a valid Merkle-Patricia
proof for a slot value that is not in state. It can only withhold (unavailability), not
lie.

The trust you take on, stated plainly for review:

- **Sync-committee honesty.** ~512 validators per ~27h period, 2/3-honest assumption. A
  majority-malicious committee can sign a false header. This is weaker than a full node's
  execution-validity guarantee and stronger than trusting a named RPC company. For an
  admission root that changes slowly and whose abuse is bounded by the unbonding window,
  this is a reasonable trade, but it is the load-bearing assumption and it belongs at the
  top.
- **Weak-subjectivity checkpoint.** The client must bootstrap from a recent trusted
  block root (a weak-subjectivity checkpoint) to avoid long-range attacks. *Who supplies
  the checkpoint, and how the operator verifies it, is the single biggest open question
  below.* A bad checkpoint at bootstrap undermines everything after it.
- **Connectivity, not validity.** The light client still needs a consensus data source
  (a beacon API) and an execution data source (for `eth_getProof` / `eth_call`). Helios
  removes the *trust* in those endpoints, not the *dependency* on reaching some endpoint.
  Liveness still requires a reachable source.

## Integration options

Three, in the order I would reach for them.

**A. Helios as a local verifying RPC proxy (recommended default).** Helios already runs
as a local JSON-RPC server that only returns consensus-verified results, executing
`eth_call` locally against light-client-verified state. So the integration is almost
nothing on our side: run Helios as a local process and point `RGOE_RPC_URL` at its
endpoint. The existing `NodeRootProvider` (docs/ONCHAIN.md, `lib/root-provider.mjs`) then
reads `root()` and gets light-client security for free, because the "node" it is talking
to is a verifying client rather than a trusted upstream. This collapses "trusted vs
light" into *which endpoint the provider points at* — own node, a bad third-party RPC, or
a local Helios — and the cleanest version of the whole abstraction is exactly that. The
separate `LightClientRootProvider` with hand-rolled `eth_getProof` verification is only
needed if we deliberately avoid running Helios in-process.

**B. Helios embedded as a Rust library (the single-binary path).** If the gateway is
rewritten in Rust (docs/ONCHAIN.md, "On a Rust rewrite"), embed Helios as a crate rather
than shell out to a sidecar: one process, one supervised lifecycle, no local RPC socket to
secure, and the RLN verify sits in the same binary. This is the tightest deployment and
the reason the Rust question and the light-client question are really one question. It is
strictly more work than A and only pays off once the light-client path is the one being
run at scale.

**C. Hand-rolled verification (avoid unless there is a reason).** A raw sync-committee
client plus our own `eth_getProof` MPT verification. Maximum control, maximum surface to
get wrong, and it reimplements what Helios already does well. Listed for completeness; not
recommended.

## The on-chain-root requirement (this constrains the contract)

A consequence worth stating because it changes the contract choice. State proofs
(`eth_getProof` over a storage slot) are clean and well-supported. **Log/receipt proofs
are not** — verifying `eth_getLogs` results under a light client is materially harder and
less supported. So a light-client gateway must read the root from an **on-chain storage
slot**, i.e. the group must maintain its root on chain (an on-chain incremental Merkle
tree, e.g. Semaphore's on-chain group), *not* have the gateway reconstruct the tree from
`MemberAdded` events. Event reconstruction is fine only for the trusted-node provider,
where you already trust the node's log view. **If the light-client path matters at all,
build the on-chain-root contract; it serves both providers.** (Same conclusion as
docs/ONCHAIN.md, reached here from the light-client side, and it is a firmer reason than
the one there.)

## Read at finalized

Read the root at the **finalized** checkpoint, not head. On L1 finality is real (Casper
FFG, ~2 epochs, ~13 min), so a reorg can never retroactively change the admission set out
from under an in-flight slash. The cost is ~13 min of enrollment latency (a new member
waits for finality before egressing), which is nothing for a slowly-changing set. This is
the same `C ≈ 13 min` slash-confirmation margin that sizes the unbonding bound
`U ≥ F + E + C` in docs/ONCHAIN.md; the light client and the exit time-lock agree on
"one finality period," which is a reason L1 is cleaner here than an L2 would be.

## Tradeoffs

| Axis | Third-party RPC | Own full node | Light client (Helios) |
|---|---|---|---|
| Trust | the RPC company | none (self) | sync committee 2/3 + WS checkpoint |
| Can a bad source forge the root? | **yes** | no | no (only withhold) |
| Runs a full node? | no | yes | no |
| Resource cost | ~0 | high (validator-class) | low (seconds to sync, small memory) |
| Bootstrap trust | none extra | none | weak-subjectivity checkpoint |
| Best fit | never (for the root) | solo staker w/ a validator | run-many operator |
| Enrollment latency | provider-dependent | finalized ~13 min | finalized ~13 min |
| Needs on-chain root slot? | no (can reconstruct) | no (can reconstruct) | **yes** (state proofs, not log proofs) |
| Liveness dependency | RPC reachable | self | a beacon + execution source reachable |

## Failure modes

- **Data source unreachable.** Degrade to the last-known-good root (both providers cache
  it) and keep gating; only *slashing* stalls, because it must land a transaction. This is
  the one caveat: an extended outage means "still gating, temporarily cannot slash." Size
  the unbonding window with that in mind.
- **Stale checkpoint / long offline.** A client offline past the weak-subjectivity period
  must re-bootstrap from a fresh checkpoint. Operationally the same concern as any
  light-client wallet; the checkpoint-source question below covers it.
- **Sync committee majority-malicious.** Out of scope to defend cryptographically; the
  mitigation is that the damage is bounded by the unbonding window and that the operator
  can cross-check the finalized root against any second source (a friend's node, a block
  explorer) out of band, since the root is a single public value.

## Open questions for review

1. **Checkpoint source.** What is the right weak-subjectivity checkpoint source for an
   unattended gateway — a pinned checkpoint at bundle time, a checkpoint-sync endpoint, a
   small set cross-checked? This is the biggest residual trust and the thing most worth an
   expert opinion.
2. **Sidecar vs embedded.** For the Rust gateway, is embedding Helios as a crate the
   intended integration, or is the local-RPC-proxy deployment (option A) preferred even
   in-process? Any gotchas running Helios headless/long-lived next to a Tor daemon.
3. **`eth_call` vs explicit `eth_getProof`.** Is executing `root()` via Helios's local
   verified execution sufficient, or is an explicit storage-slot `eth_getProof` preferable
   for auditability (a single proof against a known slot vs trusting local EVM execution)?
4. **Finalized-state read latency and freshness.** Any reason the freshness window `F`
   should be sized around light-client head-follow lag rather than just the epoch, e.g. if
   finalized state lags enough to matter for enrollment UX.
5. **Log verifiability.** Confirm the premise: is verifying `MemberAdded` logs under a
   light client actually impractical enough to justify mandating the on-chain-root slot,
   or is there a receipts-proof path that makes event reconstruction viable? This decides
   whether the on-chain-root contract is truly required or merely convenient.

## Recommendation

Ship the trusted-node provider now (solo-staker path, no light client, gets the on-chain
gate working end to end). Treat this doc as the design for the run-many path, land the
on-chain-root contract when that path is needed, and prefer integration option A (Helios
as a local verifying RPC proxy) unless and until the Rust rewrite makes option B the
natural home. Reconcile the open questions above with review before building it.
