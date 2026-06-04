# reputation-gated onion egress

A working proof of concept: a Tor onion service that egresses to the clearnet
**only for clients that prove, in zero knowledge, that they hold reputation, that
is, that they belong to a curated set of members in good standing.** Everyone
else is dropped before a single byte leaves.

You use Tor with this as your destination. The gateway address is a `.onion`, so
your Tor client routes to it natively, with no exit node in the path. The gateway
then makes the real outbound request from its own clean IP.

## Why this exists

Start from why SearXNG over Tor gets blocked: Tor exit IPs are a public,
auto-blockable list with perpetually bad reputation
([torbulkexitlist](https://check.torproject.org/torbulkexitlist),
[FireHOL tor_exits](https://iplists.firehol.org/?ipset=tor_exits)). The usual
escape is a residential proxy, which is an anonymity anti-pattern: you trade
IP-reputation evasion for a fully-trusted third party who links every request to
your billing identity.

The real constraint underneath both is simple. **An open egress on a clean IP
becomes a blocklisted IP within hours, because spammers find it and abuse it.**
Clean IPs stay clean only because they are gated and scarce. The residential
proxy market is just the commercial version of that gate, paid for by
surrendering anonymity.

This PoC gates the egress with a proof instead of an identity. The zero-knowledge
reputation proof is the mechanism that lets a clean-IP egress stay clean
**without ever learning who its users are.** It swaps the thing the whole problem
turns on, per-IP reputation, for per-member reputation that is anonymous and
portable: sybil and rate resistance decoupled from identity and from IP.

## Can Tor do this natively? No, and that turns out to be fine.

Worth being precise, because it shaped the design.

There is no slot in the Tor protocol to carry "a proof that you hold reputation."
Tor cells are opaque; the exit speaks no application semantics. You cannot make
stock `torify curl` emit a proof, and you cannot teach an exit to demand one
without forking Tor and getting your fork adopted by relay operators. The one
native hook (onion-service v3 client authorization) is a static per-client
keypair allowlist: linkable and identity-bearing, the opposite of what we want.

So the reputation gate **rides on top of Tor as a thin application-layer protocol,**
it does not modify Tor. What Tor does give us for free is the part that makes
"use Tor as my destination" literally true: onion services. The gateway is
published as a `.onion`, reached by rendezvous, so:

- there is **no exit node** between client and gateway, hence no exit-IP problem,
- the gateway **never learns the client IP** (rendezvous routing),
- the gateway is addressed the way every other Tor destination is.

The architecture is not "Tor plus a bolted-on hop." It is a reputation-gated egress
proxy published as an onion service, with a small proof-carrying protocol on top.

## Architecture

```
  curl / SearXNG                       your machine
  http_proxy=127.0.0.1:8888
        |
        v
  client shim (client/shim.mjs)  -- generates a Semaphore membership proof,
        |                            caches it for the epoch
        |  SOCKS5 to Tor (127.0.0.1:9250), no exit node
        v
  Tor rendezvous  (3 + 3 hops; client IP never revealed to the gateway)
        |
        v
  gateway.onion  ->  gateway (gateway/gateway.mjs)        the egress box
        |   1. verify the zk proof  (valid?)
        |   2. is the proof against OUR reputation set?  (root match)
        |   3. is it this epoch?  (freshness)
        |   4. is this anonymous member within its rate budget?  (RLN-style)
        |   drop on any failure
        v
  clean egress IP  --->  google.com / target site
```

TLS stays end to end between your client and the destination. The gateway tunnels
at the TCP layer (`CONNECT` to `:443`), so it sees the destination host and
nothing else. It cannot read your traffic.

## What is zero-knowledge here

The reputation set is a [Semaphore](https://semaphore.pse.dev/) group: a Merkle tree of
identity commitments. The client proves it owns the secret behind *some* leaf,
without revealing which leaf. The proof carries a **nullifier** derived from
`(secret, scope)`, and we set `scope = current epoch`:

- within an epoch, one member always produces the **same** nullifier, so the
  gateway can rate-limit per member without knowing who they are,
- across epochs the nullifier changes, so requests are **unlinkable over time.**

That is the [RLN](https://rate-limiting-nullifier.github.io/rln-docs/) (rate-limiting
nullifier) idea at PoC fidelity: anonymous membership plus anonymous rate limiting.

## Quickstart

Requires `tor` (`brew install tor`) and Node 18+.

```bash
npm install
node group/enroll.mjs alice          # adds a member to the set, prints a client secret
export RGOE_SECRET=...               # the secret it printed
bash scripts/run-all.sh              # starts tor + gateway + shim
curl -x http://127.0.0.1:8888 'https://api.ipify.org?format=json'
```

First request pays a one-time ~5s Semaphore proof generation (and, on a fresh
machine, a one-time SNARK-artifact download that can take a few minutes). After
that the proof is cached for the epoch and requests are fast.

Right after tor starts, the onion descriptor takes a little while to propagate
before the first rendezvous succeeds, so the very first request can be slow or
time out once. The shim retries through this automatically; just run the curl
again if the first one stalls.

Stop everything with `bash scripts/stop.sh`.

### Use it with SearXNG

Point SearXNG's outgoing requests at the shim:

```yaml
# settings.yml
outgoing:
  proxies:
    https: http://127.0.0.1:8888
    http:  http://127.0.0.1:8888
```

### See the gate drop non-members

```bash
node scripts/probe.mjs noproof       # -> gate:no-proof
node scripts/probe.mjs garbage       # -> gate:invalid-proof
node scripts/probe.mjs wronggroup    # valid proof, forged group -> gate:wrong-group-root
```

## Deploy for a genuinely clean egress IP

Run locally and the egress IP is your home IP, which is already a clean
residential IP and beats a Tor exit. To get a separate clean egress, run the
gateway and tor on a VPS:

1. On the VPS: install tor + node, `npm install`, `bash scripts/start-tor.sh`,
   `node gateway/gateway.mjs`. Copy out `tor/hs/hostname` and `group/members.json`.
2. On your machine: run only the shim, pointing at the VPS onion and set:
   `export RGOE_ONION=<hostname>` and run the shim against your local tor.

The gateway is portable: it is just a TCP server behind an onion address. Nothing
about it is tied to this machine.

## Threat model and honest limits

What this gets right:

- **Client is anonymous to the gateway.** Onion rendezvous, no exit node, no IP.
- **No identity anywhere.** Membership is proven, never named. The gateway logs a
  per-epoch nullifier, which is unlinkable across epochs.
- **Forged proofs are rejected.** A valid Semaphore proof against an
  attacker-invented group fails the trusted-root check (verified, see probe).
- **Anonymous rate limiting.** Per-nullifier per-epoch budget, with no idea whose.
- **Metadata-only.** TLS is end to end; the gateway sees host:port, not content.

What it does not solve, stated plainly:

- **The reputation set is the trust root.** The proof gates on membership in a
  set; it does not create reputation. Whatever ceremony adds a leaf in
  `group/enroll.mjs` is what "reputable" means. In production that leaf is added
  only after whatever the admission policy requires: a stake, an invite, accrued
  good standing, or a proof-of-personhood check (World ID, which is itself
  Semaphore-based). The PoC ceremony is a local command. This **moves** the sybil
  problem to the admission policy, it does not dissolve it. The win is that the
  policy can be as strict as you like while the gate still reveals nothing about
  which member is at the door.
- **One clean IP at high volume still looks like a bot.** Clean reputation needs
  low per-IP volume, which fights with serving many users from one gateway. The
  PoC proves the mechanism. Scaling it is a fleet-of-clean-IPs plus incentive
  question, the same scarce-clean-IP problem the residential-proxy report
  dissected. Out of scope here on purpose.
- **Within-epoch linkability is the cost of rate limiting.** A shorter epoch means
  tighter limits and more linkability inside the window; a longer epoch means the
  reverse. That tension is inherent to RLN, not a bug.
- **Replay inside an epoch is allowed by design.** The cached proof is re-sent each
  request and the gateway counts each redemption. The proof only ever travels
  inside the Tor-encrypted tunnel, so it is not exposed to an eavesdropper.
  Production RLN binds a fresh share per message and slashes over-rate secrets.
- **DoS on the rendezvous.** Anyone who knows the `.onion` can force proof
  verification work. Tor's onion-service proof-of-work defense is the intended
  outer gate (see `tor/torrc`); the Homebrew tor build ships without the `pow`
  module, so it is commented out. The zk gate still bounds egress regardless.

## Layout

| Path | What it is |
|------|------------|
| `lib/semaphore.mjs` | Shared: load the group, prove, verify, epoch math |
| `group/enroll.mjs` | Add a member to the reputation set (the trust boundary) |
| `group/members.json` | The published reputation set (identity commitments only) |
| `gateway/gateway.mjs` | Onion-side egress proxy: verify, rate-limit, tunnel, drop |
| `client/shim.mjs` | Local CONNECT proxy: prove, dial onion over Tor, tunnel |
| `scripts/probe.mjs` | Adversary probe (no-proof / garbage / forged-group) |
| `scripts/run-all.sh` | Start tor + gateway + shim |
| `scripts/stop.sh` | Stop everything this PoC started |
| `tor/torrc` | Dedicated tor: ports 9250/9251, onion service, PoW note |
