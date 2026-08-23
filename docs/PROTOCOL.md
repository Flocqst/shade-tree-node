# Shade Tree protocol

**Status:** research preview · protocol v4 · testnet only · unaudited

Shade Tree carries an HTTPS tunnel from a local client to a destination through a
proof-gated Tor onion service. This page describes the current protocol and its
boundaries. [`PROTOCOL-API.md`](PROTOCOL-API.md) contains the byte-level directory,
announce, and error formats.

## Roles

- The **application** speaks HTTP CONNECT to a loopback-only client proxy.
- The **client** discovers a node, creates an RLN membership proof, and reaches that
  node's `.onion` address through Tor SOCKS.
- The **node** verifies the proof and opens a TCP connection to the requested target.
- A **bootnode** caches signed node announcements and serves a signed directory. It
  may omit entries, but it cannot mint a node's onion identity or alter signed node
  capabilities.

The public name is *node*. Source code and low-level documents may call the egress
process a *gateway*.

## Tunnel flow

```text
application      local client          Tor             node.onion       destination
     | CONNECT host:443 |                |                   |                 |
     |----------------->|                |                   |                 |
     |                  |-- onion dial --|------------------>|                 |
     |                  |       Shade Tree v4 envelope       |                 |
     |                  |----------------------------------->|                 |
     |                  |                 verify + TCP connect---------------->|
     |                  |<-------------- {"ok":true} --------|                 |
     |<-- 200 Connected-|                |                   |                 |
     |========================== end-to-end TLS bytes =========================>|
```

One successful envelope admits one **CONNECT tunnel**. It does not meter HTTP
requests inside that tunnel. HTTP/2 can multiplex many streams and HTTP keep-alive can
carry many requests before the tunnel closes.

## v4 envelope

The first client-to-node frame is one UTF-8 JSON object followed by `\n`, bounded to
64 KiB and an absolute read deadline. Its shape is:

```jsonc
{
  "v": 4,
  "target": "example.com:443",
  "nonce": "<16 random bytes, lowercase hex>",
  "artifact": "rln-<verification-key hash prefix>",
  "proof": { "snarkProof": {}, "epoch": "...", "rlnIdentifier": "1" },
  "nullifier": "...",
  "externalNullifier": "...",
  "share": { "x": "...", "y": "..." }
}
```

`artifact` may be absent only while the configured legacy artifact remains accepted.
The node takes authoritative nullifier and share values from the proof's public
signals, not from duplicate envelope fields.

The request signal committed inside the proof is exactly:

```text
shade-tree:v4\n<target>\n<nonce>
```

That domain change is intentionally breaking. The client and node both advertise
`{min:4,max:4}`. A missing envelope version is classified as legacy v3 and rejected as
`unsupported-version:3`; it is never silently interpreted as v4.

## Admission checks

The node performs bounded, cheap checks before Groth16 verification:

1. The envelope version is an integer in the supported range.
2. The external nullifier belongs to the current or immediately previous epoch.
3. The public share coordinate matches the proof's committed signal.
4. `target` and `nonce` are bounded and newline-free, and their v4 signal hash equals
   the proof's public `x` value.
5. The proof root is a recent root from a set this operator explicitly admits.
6. The declared artifact is in the node's accepted verification-key set.
7. The RLN Groth16 proof verifies under that artifact.
8. The target matches the operator's allow policy and no deny rule. The default is
   `*:443` only.
9. Replay, rate, and concurrent-tunnel limits admit the nullifier.

Only then does the node connect to the destination. The success acknowledgement is a
newline-terminated `{"ok":true}`; an operator may enable a coarse, onion-signed
liveness receipt that contains no target, nullifier, or fine timestamp.

## Rate limiting and retries

Each membership leaf commits to a private per-epoch limit. The client spends one
private RLN message slot for each new tunnel. A slot produces one nullifier for that
member and epoch.

- An exact retry reuses the same envelope, signal, share, and nullifier. A short replay
  window treats it idempotently so failover cannot manufacture an over-spend.
- Reusing one slot in the same epoch for a different signal creates a second point on
  the RLN line. The two public shares reconstruct the circuit identity secret and may
  identify the leaf for removal or onchain slashing.
- A different epoch produces new epoch-scoped values.

Fleet-wide replay tallying is optional and fail-open. Without a shared tally, replay
protection and accounting are strongest per node; the threat model records the residual
cross-node window.

## Discovery and trust

Each node controls a Tor v3 onion identity. Its heartbeat signs the announcement and
capabilities with that onion key. Capabilities include the supported envelope range,
accepted artifact identifiers, admission paths, destination ports, and optional payment
offer.

The bootnode returns a signed directory. Clients pin its directory signer, verify each
entry's onion-key signatures, and re-derive the public key from the `.onion` address.
The bootnode is still a selection and availability dependency: it can omit, delay, or
reorder valid nodes. Static signed directories are supported as a fallback.

## Admission sets

An operator explicitly chooses any combination of:

- `invited`: the configured local membership tree;
- `staked`: one or more `StakedReputationSet` roots;
- `paid`: a `PaidAccessSet` root.

Invited-only is the default. Naming an admission path without its required contract or
root is a startup error; the node does not silently weaken the requested policy.

The proof hides which leaf in an accepted root the client controls. It does not erase
links created when a wallet enrolls or pays onchain, and a small set remains a small
anonymity set.

## What the protocol does and does not hide

- The Tor onion leg does not deliver the client's source IP to the node application.
- The destination sees the node's public IP.
- With the default `:443` policy, TLS terminates at the destination. The node sees the
  target hostname, port, timing, connection lifetime, and byte counts, but not plaintext
  inside TLS.
- The node can refuse, delay, truncate, or misroute a valid tunnel. The protocol does not
  force availability or honest forwarding.
- End-to-end timing correlation remains possible for an observer able to watch both
  sides.
- Development proving artifacts and unaudited code are not production security
  guarantees.

Read [`THREAT-MODEL.md`](THREAT-MODEL.md) before operating or depending on a node.

## Versioning

Protocol v4 is the first Shade Tree release. Envelope-version and proof-artifact
negotiation are separate axes: a wire shape can remain v4 while verification keys rotate
through a dual-artifact window. See [`PROTOCOL-VERSIONING.md`](PROTOCOL-VERSIONING.md)
and [`CEREMONY.md`](CEREMONY.md).
