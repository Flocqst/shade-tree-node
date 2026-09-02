# ADR 0009: Size a public RLN epoch as a bounded research session

- Status: Accepted and enforced locally in Protocol v4; Grove-wide atomicity remains future work
- Date: 2026-09-01
- Task: Public-staking follow-up — give a tier-1 epoch a defensible bandwidth envelope

## Context

RLN counts proof slots, and Protocol v4 spends one slot when it admits one target-bound HTTPS
`CONNECT` tunnel. TLS stays end to end, so a gateway cannot count Google searches, HTTP requests,
or HTTP/2 streams inside that tunnel. Before this decision was implemented, the gateway piped bytes
until close or idle timeout and observed aggregate payload without applying a byte-total limit.

The motivating public use case is low-grade, text-oriented research: submit one search query and
fetch a small set of result documents without downloading video or indiscriminately rendering all
page assets. We need a default derived from that workload, with enough headroom for redirects,
unusually large HTML, and protocol overhead, rather than a magic quota.

There is also a unit mismatch to preserve explicitly. A v4 proof is bound to one destination, so a
Google tunnel cannot fetch pages from five unrelated result origins. The calculation below is an
aggregate **research-session** budget. Applying it across several target tunnels needs a future
short-lived session capability. Protocol v4 therefore enforces it per private RLN epoch slot; a
tier-1 member has one such slot, and higher tiers receive one allowance per slot.

## Decision

Use the following transparent estimate for one text-oriented search session:

| component | payload estimate |
|---|---:|
| search response, redirects, and associated text | `0.5 MiB` |
| five result documents at `0.6 MiB` each | `3.0 MiB` |
| request headers, error pages, and workload variance | `0.5 MiB` |
| **estimated session** | **`4.0 MiB`** |
| **provisional allowance (`10 ×` estimate)** | **`40.0 MiB`** |

The provisional public tier-1 limit is therefore **40 MiB (`41,943,040` bytes) of combined relayed
payload per RLN epoch entitlement**. The factor of ten is the parameter rule: if representative
measurements revise the estimated workload, recompute the limit as `10 × estimate` instead of
preserving 40 MiB by folklore.

Direction should affect shaping, not per-byte price. On a public cloud relay, an agent-to-destination
byte arrives at the gateway and then leaves toward the destination; a destination-to-agent byte
arrives and then leaves toward Tor. Each application direction therefore creates approximately one
outbound public-interface byte, while responses merely dominate the volume. Start with:

| control | provisional value | implementation state |
|---|---:|---|
| combined payload ceiling | `40 MiB` (`41,943,040` bytes) | enforced per local RLN epoch slot |
| agent → destination shaping | `64 KiB/s`, `128 KiB` burst | not implemented |
| destination → agent shaping | `512 KiB/s`, `1 MiB` burst | not implemented |
| hard session lifetime | `90 seconds` | not implemented; current idle limit remains separate |
| idle timeout | `15 seconds` | not implemented; current default remains 5 minutes |
| future multi-target research session | at most `6` target tunnels: search + five results | not implemented |

The combined ceiling is authoritative. The asymmetric rates match the expected small-query,
large-response workload; they do not claim that one application direction is cheaper per byte.
The gateway should count opaque post-admission payload and never inspect TLS content.

For cost planning, use a conservative `1.15` transport multiplier for TCP, TLS, and Tor overhead:

```text
billable GiB/month
  ≈ members × entitlements_per_minute × 43,200 × payload_MiB / 1,024 × 1.15

one continuously saturated tier-1 member at 40 MiB/minute
  ≈ 1,941 GiB/month
```

DigitalOcean currently pools included Droplet outbound transfer, makes inbound transfer free, and
charges `$0.01/GiB` for additional outbound transfer. The current 1-vCPU/2-GiB plan lists 2,000 GiB
of included transfer. These are planning inputs, not protocol constants, and must be rechecked when
cost decisions are made:

- <https://docs.digitalocean.com/platform/billing/bandwidth/>
- <https://www.digitalocean.com/pricing/droplets>

## Implementation status and follow-ups

1. **Done:** both relay directions pass through bounded Node streams sharing one exact byte budget.
   The boundary chunk is truncated, flushed, and both sockets close with reason `payload-limit`.
2. **Done locally:** an ephemeral counter keyed by `(externalNullifier, nullifier)` makes concurrent
   tunnels and retries on one gateway share the slot allowance. The key is never persisted or
   attached to logs or metrics, and state is pruned after two epochs.
3. **Pending:** add token-bucket rate shaping. Delayed stream callbacks must exert backpressure;
   a high-water mark alone is not a bandwidth limiter.
4. **Pending:** add an unlabeled payload-per-entitlement histogram so the 4 MiB estimate can be recalibrated from
   aggregate percentiles without creating a browsing-history dataset.
5. **Pending:** advertise the enforced byte/rate/lifetime profile in onion-signed gateway capabilities so the
   client knows the service it is about to spend a slot on.
6. **Decided for v4:** higher RLN tiers receive 40 MiB per private slot. One aggregate 40 MiB tier
   envelope cannot be enforced across unlinkable v4 nullifiers without a session capability or
   another privacy-preserving aggregate mechanism.
7. **Pending:** for the multi-target form, exchange one RLN proof for a short-lived, gateway-bound capability
   carrying `{maxTargets: 6, maxPayloadBytes: 41943040, expiresIn: 90}`. Every child tunnel spends
   from that shared envelope.
8. **Pending:** a strict Grove-wide byte ceiling also depends on strict single-use admission. V4's asynchronous,
   fail-open fleet tally permits concurrent replay at different gateways; an atomic reservation or
   an equivalent protocol change is required before calling the ceiling exact across the Grove.

## Consequences

- A ticket no longer grants an unbounded long-lived data pipe. Search-oriented agents have enough
  room for ordinary HTML while media downloads and accidental asset floods are bounded.
- A continuously saturated tier-1 member has a calculable worst-case transfer footprint. Stake is
  refundable collateral, not bandwidth revenue, so an operator still needs a funding model or an
  admission ceiling when this moves beyond disposable Sepolia research.
- Full browser rendering is not the sizing target. HTTP Archive reported a 2.9 MB median desktop
  page in 2025; the 10× headroom may carry several such pages, but the protocol estimate remains
  based on text-oriented retrieval rather than unconstrained media:
  <https://almanac.httparchive.org/en/2025/page-weight>.
- The gateway learns no additional application content. It already observes timing and byte volume;
  enforcement uses only those existing transport facts.

## Alternatives considered

- **Unlimited bytes after one proof.** Rejected: one slot can become hours of traffic and gives the
  operator no usable cost bound.
- **One HTTP request per ticket.** Rejected for arbitrary HTTPS: HTTP boundaries are hidden by TLS,
  and HTTP/2 multiplexes many requests in one connection.
- **Charge agent-to-destination and destination-to-agent bytes at different prices.** Rejected as a
  default cloud-cost model: each relayed payload byte has one outbound gateway leg. Shape directions
  differently for workload quality, but account combined bytes.
- **Use 40 MiB without recording its derivation.** Rejected: the limit must remain `10 ×` a named,
  revisable workload estimate.
- **Treat one v4 tunnel as the complete search job.** Rejected: a target-bound Google tunnel cannot
  fetch unrelated result origins. That product unit requires the proposed multi-target capability.

## References

- `gateway/gateway.mjs`: bounded bidirectional relay, shared per-slot byte budget, and close metric
- `lib/relay-telemetry.mjs`: unlabeled node-local relay-byte telemetry
- `client/shade-tree-client.mjs`: one private RLN slot and one target-bound envelope per tunnel
- `gateway/fleet-tally.mjs`: asynchronous, fail-open cross-gateway spent-nullifier propagation
- `docs/PUBLIC-STAKING.md`: proposed 0.1 Sepolia ETH tier-1 profile and fixed-epoch semantics
