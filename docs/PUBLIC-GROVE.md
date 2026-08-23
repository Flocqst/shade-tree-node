# Public Grove data contract

The [Grove](https://shade-tree-node.vercel.app/grove/) is a deliberately small
public view of Shade Tree. It shows how many gateway identities appeared in the
last signed directory that the hosted observer could verify. It is topology,
not territory: there are no locations, identities, traffic paths, or selectable
nodes on the page.

This document defines what the view means and what its collector is allowed to
publish.

## What one tree means

One tree means one gateway identity in the bootnode directory at observation
time. The observer fetches `/directory` over Tor and verifies its signature
against the pinned directory signer before counting entries.

The count means **announced within the bootnode TTL**. It does not necessarily
mean the gateway was independently reachable. When optional active probing is
enabled, the signed directory can mark an entry down; the public aggregate does
not retain that per-node health dimension. An entry remains present until its
announcement expires.

The count is also not a count of people, operators, physical machines, public
IPs, or independent organizations. One operator can announce more than one
gateway identity. It is the directory visible through this observer and this
bootnode, not a claim about every Shade Tree deployment.

Publishing an exact total makes growth and churn observable. That is an
intentional privacy tradeoff. The view avoids adding the much more identifying
dimensions that could explain which node caused a change. The project keeps
only a bounded public history, but any third party can archive a count once it
has been published.

## Publication path

```text
node heartbeat
    -> bootnode directory
    -> signed directory fetched over Tor
    -> pinned signature + freshness verification
    -> aggregate-only snapshot signed by the observer
    -> /grove/network.json
```

The scheduled observer runs every 15 minutes. It accepts a signed directory only
when its issue time is within the five-minute freshness and future-skew window.
It then signs the canonical aggregate with a dedicated Ed25519 publication key.
The browser pins the corresponding key from
[`network/grove-signing-public.pem`](../network/grove-signing-public.pem) and
refuses an unsigned, malformed, stale-forged, or incorrectly signed payload.

The read-only observer passes the signed JSON to a separate minimal publisher;
the publisher checks out no code and receives repository write permission only
for that step. It creates a one-file, parentless commit on the generated
`network-state` branch, so the branch itself carries no old commit chain. Vercel
serves that snapshot through the same-origin `/grove/network.json` path, so a
Grove visitor never contacts the bootnode or GitHub directly from their browser.

The browser verifies the publication signature, not the raw directory. That
signature attests that the project observer completed the pinned directory and
freshness checks. Changing the observation process or rotating the publication
key still requires a reviewed site release.

If the bootnode is unreachable, its health check fails, or the directory
signature cannot be verified, the observer publishes nothing. A failed
observation is never translated into a zero count. The site keeps its last
verified snapshot and labels it stale as it ages.

## Allowed public fields

The `shade-tree-public-grove-v1` envelope contains only:

- the network label and a cadence-rounded observation time;
- the announced count;
- up to 96 aggregate count samples, approximately 24 hours at the hosted
  cadence;
- whole-number announced node-hours derived from that count history;
- booleans that describe the verification and privacy contract.

History is treated as untrusted input every time a snapshot is built. It is
carried forward only when its publication signature verifies and its schema,
network, and cadence match the new observation. Only `at` and `announced` are
retained; malformed, future, old, or excess samples are discarded. Announced
node-hours cap gaps at 30 minutes and floor to whole hours so a stalled
collector cannot invent a long period of availability. They are not a measure
of successful traffic or delivered cover.

The collector must never publish:

- onion addresses or prefixes, gateway or signer public keys, operator
  addresses, or stable pseudonyms;
- IP addresses, ASN, region, country, coordinates, or inferred location;
- capability documents, per-node health rows, or generated positions derived
  from a node identity;
- client counts, destinations, request or tunnel counts, timing, byte totals,
  logs, errors, or raw Prometheus metrics; or
- the signed directory or any other raw bootnode response.

The canopy is regenerated from only the aggregate count and rounded snapshot
time, with density capped for rendering performance. Its roots are an
illustration of announcements, not observed traffic.

## Shared statistics later, not now

Nodes do not currently send optional public statistics. If that experiment is
added, it must use a separate opt-in report rather than the persisted directory
announcement. The minimum contract is:

- publish no aggregate below five reporting nodes; this threshold would not
  prove five independent operators;
- delay publication by at least six hours and use coarse, fixed buckets;
- retain reports in memory only, with no raw reporting endpoint, logs,
  federation, or individual contribution view;
- heavily round any released total and label it self-reported; and
- reassess differencing attacks across repeated snapshots before release.

Until those conditions have an implementation and a separate review, the Grove
collects no per-node usage metrics. Small groves stay quiet.

## Reproduce the aggregate

With Tor running and the same discovery variables used by the uptime probe:

```bash
SHADE_TREE_GROVE_SIGNING_KEY="$(< /path/to/grove-private.pem)" \
  node scripts/grove-snapshot.mjs \
  --network sepolia \
  --previous ./grove.previous.json \
  --out ./grove.json
node scripts/grove-snapshot.selftest.mjs
```

The output file is safe to inspect or publish only if the collector exits zero
and its attestation verifies against the pinned public key. The self-test
enforces the allowlist, freshness boundary, history authentication, and signing
contract, and checks that representative identity and capability fields cannot
survive serialization.
