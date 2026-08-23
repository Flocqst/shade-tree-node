# ADR 0003: The bootnode is a cache, not a trust root

- Status: Accepted
- Date: 2026-08-13
- Task: milestone 4 (docs/ROADMAP-v1.md #4)

## Context

Milestone 3 shipped fleet discovery as a signed static file. Milestone 4 makes it
live: gateways announce themselves, and a bootnode (`bootnode/server.mjs`, its own v3
onion service) holds live ones for a TTL and serves the union as a signed directory
that `lib/directory.mjs` already knows how to verify.

Making discovery live introduces a new always-on party. The danger is that this party
becomes a trust root: if a client had to believe whatever the bootnode said, a hostile
or compromised bootnode could steer a member onto a gateway it controls, which is a
deanonymization lever. Discovery needs to be live without the discovery service being
trusted.

## Decision

Every directory entry is self-authenticating and re-checkable by the client *without
trusting the bootnode*, on two independent axes:

- **Onion control (always, cryptographic).** The announce is ed25519-signed by the
  onion's own identity key. `verifyDirectory` re-derives that key from the `.onion`
  address itself (`onionToPubkey`) and checks each entry's `pubkey` equals the derived
  key, so a grafted or swapped onion fails the client's own check. Address and key
  cannot disagree.
- **Operator stake (optional, on chain).** In stake-admission mode a durable ECDSA
  authorization binds operator to onion; the bootnode and clients recover it and read
  `GatewayRegistry.isStaked(operator)` on chain.

The bootnode signs the *list* with the pinned directory signer (`SHADE_TREE_DIR_SIGNER`),
which authenticates that this is the bootnode's list, but the signer does not vouch for
the entries: each entry stands on its own onion-control proof. `GET /gateway/<onion>`
returns the raw stored announce so any client can re-run the whole verification from
scratch (zero-trust re-verification).

## Consequences

- A hostile bootnode can at worst **omit** a gateway, or briefly **list one whose stake
  later lapsed** (caught by the client re-reading `isStaked` on chain). It can **never
  inject** an onion it does not hold the key for, because the client re-derives every
  onion's key and verifies the signature under it.
- The pinned signer must be distributed to clients out of band; there is intentionally
  no default, because an unpinned directory is trust-on-first-use, which is the exact
  poisoning surface the pin closes (docs/AUDIT.md).
- Clients cache the last-known-good directory (`loadDirectory`), re-verified against the
  same pinned signer, so a dead or poisoned bootnode degrades to the previous good
  fleet, never to nothing and never to a hostile gateway.
- Persistence on restart is not blind trust: each stored announce is re-run through the
  same verification (onion control, and in stake mode a live `isStaked` re-check) and
  any entry past its TTL is dropped (docs/BOOTNODE.md, "Surviving a restart").

## Alternatives considered

- **A trusted registry the client believes.** A directory service whose signature is
  taken as proof a gateway is genuine. Rejected: it makes the bootnode a trust root and
  a single point of deanonymization. One compromised (or coerced) signer could graft a
  hostile egress under any onion. The self-authenticating entry removes the need to
  trust the service at all; the pinned signature is reduced to authenticating *which
  list*, not *which gateways are real*.

## References

- docs/BOOTNODE.md ("The two things that keep it honest", "The bootnode is a cache, not
  a trust root")
- lib/directory.mjs `verifyDirectory`, `onionToPubkey`, `verifyOnionControl`,
  `loadDirectory`
- bootnode/server.mjs (`GET /gateway/<onion>` zero-trust re-verification; `MAX_WEIGHT`)
- bootnode/announce.mjs, bootnode/selftest.mjs (adversarial cases rejected)
- docs/AUDIT.md ("The bootnode is a convenience cache, not a trust root")
- docs/ROADMAP-v1.md #4
