# Public Sepolia staking profile

The public Protocol v4 profile is deliberately narrow:

- stake exactly **0.1 Sepolia ETH** at tier `1`;
- receive **one new HTTPS `CONNECT` tunnel per fixed 60-second epoch**;
- relay at most **40 MiB (41,943,040 bytes) of combined payload** through that slot;
- recover the stake after the ZK-authorized 24-hour exit window unless the member is slashed.

The deployed proof artifacts are explicitly untrusted testnet material. This is a disposable
research Grove, not a production anonymity system.

## What “one request” means

TLS remains end to end. A node can count the admitted `CONNECT` tunnel and its opaque bytes, but it
cannot see or count Google queries, HTTP requests, or HTTP/2 streams inside that tunnel. The epoch
is `floor(unixSeconds / 60)`, not a rolling window, so uses immediately before and after a minute
boundary are possible.

The v4 external nullifier is Grove-wide, not egress-specific. Honest JavaScript and Rust clients
therefore allocate one tier-1 slot total and reuse the identical proof only for gateway failover.
Using the same private slot for two different target-bound requests produces slash evidence.

Nodes also exchange spent-nullifier notices. That fleet tally closes ordinary sequential replay,
but it is asynchronous and fail-open: simultaneous requests, a partition, or a dropped notice can
still race. The accurate claim is **one honest-client allocation per fixed minute, with best-effort
Grove-wide replay suppression**. A hard per-egress entitlement would require an egress-scoped
external nullifier and a new protocol version.

## Protocol parameters

| parameter | public value |
|---|---:|
| network | Sepolia (`11155111`) |
| tier-1 bond | `0.1 ETH` |
| tier-8 bond | `0.8 ETH` |
| allowed limits | `[1, 8]` |
| default member limit | `1` |
| epoch | fixed `60 seconds` |
| previous epochs accepted | `1` |
| superseded-root lifetime | `60 seconds` |
| combined payload per slot | `40 MiB` (`41,943,040` bytes) |
| slash confirmation allowance | `3,600 seconds` |
| contract minimum safety window | `3,720 seconds` (`F + E + C`) |
| deployed unbonding | `86,400 seconds` (24 hours) |

Tier 8 is priced linearly so the compatibility tier cannot buy eight slots for the tier-1 price.
The 40 MiB payload is the 4 MiB text-oriented search-and-fetch estimate from
[ADR 0009](adr/0009-epoch-bandwidth-envelope.md), multiplied by the chosen `10×` safety factor.
Both relay directions spend one shared allowance. The boundary chunk is truncated and both sockets
close with reason `payload-limit`.

## Member flow

The JavaScript CLI uses the bundled live Sepolia record by default:

```bash
shade-tree enroll --commitment-only
# Store the secret privately, then fund a separate registration wallet with 0.1 ETH + gas.
read -s SHADE_TREE_REGISTER_KEY && export SHADE_TREE_REGISTER_KEY
shade-tree register-member <commitment>
unset SHADE_TREE_REGISTER_KEY
shade-tree proxy
```

The Rust client provides the same native `enroll`, `register-member`, and proxy/egress path. Both
clients read the Elder, signer, current staking contract, RPC, deployment block, tier, and rate
policy from the bundled deployment record. Explicit flags and environment variables still win.

Membership proofs use the finalized Sepolia tree by default, matching the gateways' pinned root
snapshot. A newly mined registration is therefore not usable until its block is finalized; this
deliberate delay prevents client and gateway RPCs from racing on different tip roots. Every
superseded root the gateway observes remains accepted for the full 60-second freshness window.

The staking wallet, commitment, tier, amount, and timing are public forever. Only the identity
secret stays local. Use a separately funded wallet when address-graph separation matters.

The second local allocation in one epoch fails with
`SHADE_TREE_EPOCH_BUDGET_EXHAUSTED`; the client does not intentionally manufacture slash evidence.

## Operator invariants

The live deployment record is the source of truth. Its `ratePolicy` and public staking root pin the
contract receipt, hasher, real testnet exit verifier, tier table, deployment block, clock, payload,
root lifetime, and unbonding relationship. The deployment preflight rejects drift.

Every node must run the same values and advertise the rate policy in its onion-signed capabilities.
Clients fail closed before proving when a signed node policy is absent or differs from their
expected epoch/payload profile. Operators must keep the fleet tally enabled on public-profile nodes
and retain the explicit caveat that it is not an atomic distributed reservation system.
