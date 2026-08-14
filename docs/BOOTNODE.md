# The bootnode: live gateway discovery

The proof of concept pinned one gateway. The [fleet directory](FLEET.md) made that a
*signed static file*. The **bootnode** makes it *live*: gateways announce themselves, the
bootnode holds live ones for a TTL, and it serves the union as a signed directory that
[`lib/directory.mjs`](../lib/directory.mjs) already knows how to verify. It is the
dynamic realization of roadmap milestone 3.

## What it is

A small HTTP service (`bootnode/server.mjs`) published as its **own v3 onion service**, so
clients reach it the same way they reach a gateway — a Tor SOCKS dial, no exit node, the
bootnode never learns a client IP.

```
POST /announce         a gateway registers/renews itself (see "The announce" below)
GET  /directory        the current signed directory of live gateways
GET  /gateway/<onion>  the stored signed announce for one gateway (zero-trust re-verification)
GET  /health           liveness + count + admission policy
```

## The two things that keep it honest

### The onion is never on chain

A v3 `.onion` address *is* an ed25519 public key. Putting it on chain would make the whole
fleet publicly enumerable and bind each onion to the address that paid for it forever — the
exact property Tor's blinded HSDir descriptors exist to destroy. So the on-chain
[`GatewayRegistry`](../contracts/GatewayRegistry.sol) stakes only an **operator address**.
The onion lives only in the signed announce the operator hands the bootnode. One stake can
rotate across many onions; the fleet is never enumerable on chain.

### The bootnode is a cache, not a trust root

It cannot forge a gateway. Every entry is self-authenticating and re-checkable by the client
without trusting the bootnode:

- **Onion control (always, cryptographic).** The announce is ed25519-signed by the onion's
  own identity key. `verifyDirectory` re-derives the key from the `.onion` address, so a
  swapped or grafted onion fails the client's own check. Any client can re-verify from
  `GET /gateway/<onion>`.
- **Operator stake (optional).** A durable ECDSA authorization binds operator↔onion; the
  bootnode and clients recover it and check `GatewayRegistry.isStaked(operator)` on chain.

So a hostile bootnode can at worst *omit* a gateway, or list one whose stake later lapsed
(caught by the client re-checking on chain) — never inject an onion it does not control.

## The announce

`bootnode/announce.mjs` builds it; the bootnode and clients verify it. Shape:

```jsonc
{
  "v": 1,
  "onion": "<56-char>.onion",
  "weight": 100,
  "ts": 1789000000,          // fresh; a stale/future ts is rejected (replay window)
  "nonce": "<hex>",          // one-shot within the window
  "onionSig": "<ed25519>",   // by the onion's OWN key over {v,onion,weight,ts,nonce}  (onion control)
  "operator": "0x..",        // optional (admission=stake)
  "operatorSig": "<ecdsa>"   // personal_sign("RGOE gateway operator authorization\nonion=..\noperator=..")
}
```

The **onion signature is refreshed every heartbeat** (fresh `ts`/`nonce`, cheap, local). The
**operator signature is durable** — signed once, reused every heartbeat, revoked only by
unstaking. This is possible because a gateway holds the 32-byte seed behind its onion (see
[keygen](#the-onion-identity)), so it can sign with node's built-in crypto and no new
dependency.

## Admission policy

`--admission open` (default) requires only onion control — permissionless discovery.
`--admission stake` additionally requires a live, authorized operator bond. Staking is the
opt-in hardening tier, and a natural home for the on-chain funds a gateway needs anyway (it
is the party that pays gas to slash member over-spenders). Gateway slashing is **governed**
(owner-only), not permissionless — the one honest asymmetry vs the member slash, because a
member over-spend is a cryptographic proof while gateway misbehavior is a subjective
judgment. See [`GatewayRegistry.sol`](../contracts/GatewayRegistry.sol).

## The onion identity

`rgoe keygen <hsDir>` (`bootnode/keygen.mjs`) mints one ed25519 seed and writes both:

- Tor's HS key files (`hs_ed25519_secret_key`, `hs_ed25519_public_key`, `hostname`) so Tor
  publishes exactly this onion, and
- `identity.local.json` holding the seed, so the gateway can sign announces.

This works because a v3 onion's public key *is* the standard ed25519 public key of the seed:
`h = SHA-512(seed); a = clamp(h[:32]); A = a·B; onion = base32(A ‖ checksum ‖ 0x03)`. Tor's
expanded secret key derives the same `A`, so one seed is both "the key Tor publishes with"
and "the key we sign with."

## Liveness

A bootnode entry is soft state with a TTL (`--ttl`, default 900s). A gateway proves liveness
by continuing to announce (`rgoe heartbeat`, every `--interval` seconds); a dead gateway ages
out without anyone deregistering it. Clients cache the last-known-good directory, so a dead or
poisoned bootnode degrades to the previous good fleet, never to nothing.

### Surviving a restart

The live set is in-memory by default, so a bootnode restart would blank the fleet until every
gateway's next heartbeat. Set `RGOE_BOOTNODE_STORE=<path>` (the deploy sets it automatically) to
turn on **write-through persistence**: every accepted announce is mirrored to a small JSON file
and reloaded on boot. Reload is not blind trust — each stored record is re-run through the same
announce verification (onion control, and in stake mode a live on-chain `isStaked` re-check), and
any entry already past its TTL is dropped. Freshness on reload is the **TTL** (how long an
accepted gateway stays listed), not the announce anti-replay window — so a restart minutes after
the last heartbeat keeps the fleet, while a stale or tampered store can never resurrect a
long-dead gateway or inject an onion nobody controls.

## Client side

```bash
rgoe client --secret <hex> --bootnode <bootnode-onion> --dir-signer <bootnode-signer-pubkey>
```

The client fetches `/directory` over Tor (`bootnode/fetch.mjs`), verifies it against the
pinned signer, and feeds it into the existing weighted rotation + failover
(`client/selection.mjs`). Everything downstream — per-request RLN proof, gateway rotation,
slot rotation — is unchanged; the bootnode only changes *how the fleet is discovered*.

## Verify it end to end (no Tor, no chain)

```bash
node bootnode/selftest.mjs
```

Mints real onion identities, runs the real HTTP bootnode, and asserts every adversarial case
is rejected (forged onion sig, wrong key, stale ts, replayed nonce, unstaked operator, stolen
operator sig) while honest announces are served in a directory that verifies against the
pinned signer.
