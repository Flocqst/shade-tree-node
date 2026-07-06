# reputation-gated onion egress

A Tor onion service that egresses to the clearnet only for clients who prove, in
zero knowledge, that they belong to a curated set. Everyone else is dropped before
a byte leaves. The point is a clean-IP egress that stays clean without ever
learning who its users are.

This is a working proof of concept, deployed and verified live. It is not
production, and it has no payments and no dynamic membership (see
[Scope](#scope-what-it-is-and-is-not)).

The full write-up, with the exit-blocking benchmark, the gate protocol,
deployment numbers, and the design space for a production version, is at
[reputation-gated-egress.vercel.app](https://reputation-gated-egress.vercel.app)
(source: [`docs/post/`](docs/post/)).

## The problem

Tor exit IPs are a public, auto-blocked list with perpetually bad reputation
([torbulkexitlist](https://check.torproject.org/torbulkexitlist),
[FireHOL tor_exits](https://iplists.firehol.org/?ipset=tor_exits)), so honest Tor
users get locked out. Measured directly over the same 36 sites: a home IP was
blocked 8.3 percent of the time, a datacenter IP 16.7, and Tor 17.1, with the
sites that wall Tor at 90 to 100 percent mostly fronted by commercial anti-bot
vendors; method and classifier in
[`docs/exit-blocking-benchmark.md`](docs/exit-blocking-benchmark.md).
The usual escape, a [residential proxy](docs/residential-proxies.md), trades
IP-reputation evasion for a fully trusted third party who links every request to
your billing identity. Underneath
both: an open clean-IP egress is blocklisted within hours, so clean IPs stay clean
only by being gated and scarce. We gate on a proof of membership instead of an
identity, which keeps sybil and rate resistance while decoupling them from the IP
and from who you are.

## Design

The gate is an application-layer protocol on top of Tor, not a Tor modification.
Tor cannot carry a reputation proof natively (cells are opaque, v3 client-auth is a
static linkable allowlist), but onion services give us the part that matters: the
gateway is published as a `.onion` and reached by rendezvous, so there is no exit
node and the gateway never learns the client IP.

```
  curl / SearXNG  (http_proxy=127.0.0.1:8888)
        |
        v
  client shim ── builds a Semaphore membership proof, caches it per epoch
        |  SOCKS to Tor, no exit node
        v
  Tor rendezvous  (3 + 3 hops; client IP never revealed to the gateway)
        |
        v
  gateway.onion ── 1. verify proof   2. against OUR root?   3. this epoch?
        |          4. nullifier within budget?    drop on any failure
        v
  clean egress IP ──> destination
```

The set is a [Semaphore](https://semaphore.pse.dev/) group. The client proves it
owns the secret behind some leaf without revealing which, and the proof carries a
nullifier over `(secret, epoch)`: one nullifier per member per epoch, so the gateway
rate-limits per member without knowing who, and the nullifier rotates across epochs.
[RLN](https://rate-limiting-nullifier.github.io/rln-docs/) at PoC fidelity. Proofs
are ~0.9 KB and verify in ~30 ms regardless of set size; generation (~0.5 to 0.9 s
warm) is paid once per epoch and cached. The tunnel is TCP `CONNECT :443` only, so
TLS stays end to end and the gateway sees host:port, never content.

## Status

Live and verified, both ends. A laptop request egresses from the gateway's clean IP
and the gateway logs the matching `PASS`; the path crosses six real Tor relays with
no exit node, and the client IP appears in zero logs on the box. A four-hypothesis
stress test (multiple members, forged and garbage and non-member proofs, rate-limit,
spam) all passed. Numbers, including end-to-end latency, are in
[`docs/STATUS.md`](docs/STATUS.md).

## Run it

Requires `tor` and Node 18+. Local, all on one machine:

```bash
npm install
node group/enroll.mjs alice      # adds a member, prints a secret
export RGOE_SECRET=...            # the printed secret
bash scripts/run-all.sh          # tor + gateway + shim
curl -x http://127.0.0.1:8888 https://api.ipify.org
```

For a genuinely separate clean egress, split the roles across two machines:
`scripts/run-gateway.sh` on a server (prints the `.onion`, holds no secret),
`scripts/run-client.sh` on your laptop with `RGOE_ONION=<onion>`. Procedure,
invariants, and a verification matrix are in [`docs/DEPLOY.md`](docs/DEPLOY.md); the
friend handout is [`docs/JOIN.md`](docs/JOIN.md); the request lifecycle, hop by hop,
is in [`docs/walkthrough.html`](docs/walkthrough.html).

Watch the gate drop non-members: `node scripts/probe.mjs {noproof|garbage|wronggroup}`.

## Scope: what it is and is not

Gets right:

- Client anonymous to the gateway: onion rendezvous, no exit node, no IP.
- Membership proven, never named. The gateway logs a per-epoch nullifier, unlinkable
  across epochs.
- Forged sets rejected by the trusted-root check; bad proofs rejected with reasons.
- Anonymous per-member rate limiting; metadata-only tunnel.

Does not do, on purpose:

- **No payments.** There is no payment, fee, or staking anywhere in the system. The
  gate is pure membership. Pay-to-enroll, if you ever want it, belongs in the
  admission policy in front of `enroll.mjs`, not in this code.
- **No dynamic membership.** The set is fixed at gateway startup. Adding or removing
  a member means editing `members.json` and restarting, and there is no per-member
  revocation: removing a leaf changes the root, so the whole set re-keys. Live
  on-chain membership is in the [roadmap](docs/ROADMAP.md).
- **Anonymity against the operator is not real yet.** The PoC `enroll.mjs` generates
  each member's secret and hands it over, so the operator sees it. Until members
  self-generate their identity and submit only a commitment, you trust the operator.
  This is the first thing to fix.
- **The set is the trust root.** The proof gates membership; it does not create
  reputation. Whatever ceremony adds a leaf (stake, invite, accrued standing,
  proof-of-personhood) is what "reputable" means. This moves the sybil problem to
  admission, it does not dissolve it.
- **Within-epoch linkability.** A member's requests in one epoch share a nullifier.
  This is separable from the rate window, not inherent; the fix is in the
  [roadmap](docs/ROADMAP.md).
- **Replay within an epoch is allowed by design.** The cached proof is re-sent and
  the gateway counts redemptions. It only ever travels inside the Tor tunnel.
- **One clean IP at volume still looks botlike.** Scaling is a fleet-of-clean-IPs
  problem; the fleet, its discovery, and per-request gateway rotation are in the
  [roadmap](docs/ROADMAP.md).
- **Rendezvous DoS.** Anyone with the `.onion` can force ~30 ms of verify work each.
  Tor's onion proof-of-work defense is the outer gate: stock tor with the GPL `pow`
  module, which `scripts/start-tor.sh` enables automatically when the build has it.

Per-party worst case and the fixes in priority order:
[`docs/adversarial-review.md`](docs/adversarial-review.md). Scoped-but-unbuilt design
(unlinkable rate limiting, on-chain set): [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Layout

| Path | What it is |
|------|------------|
| `lib/semaphore.mjs` | Shared: load the group, prove, verify, epoch math |
| `group/enroll.mjs` | Add a member to the set (the trust boundary) |
| `group/seed-demo-members.mjs` | Mint a labeled demo set + a private keyring to hand out |
| `group/members.json` | The published set (identity commitments only) |
| `gateway/gateway.mjs` | Onion-side egress proxy: verify, rate-limit, tunnel, drop |
| `client/shim.mjs` | Local CONNECT proxy: prove, dial onion over Tor, tunnel |
| `scripts/probe.mjs` | Adversary probe (no-proof / garbage / forged-group) |
| `scripts/run-all.sh` | Start tor + gateway + shim on one machine (local PoC) |
| `scripts/run-gateway.sh` | Server role: tor + gateway, no shim, no secret |
| `scripts/run-client.sh` | Laptop role: client-only tor + shim, via `RGOE_ONION` |
| `scripts/join.sh` | Friend one-command: bring up the client and verify |
| `scripts/verify.sh` / `gateway-status.sh` | Client and server receipts |
| `scripts/build-tor-pow.sh` | Compile a pow-capable tor (`--enable-gpl`) into `tor/tor-pow/` |
| `tor/torrc`, `tor/torrc.client` | Dedicated tor (onion + PoW) and client-only tor (SOCKS) |
| `docs/DEPLOY.md`, `docs/JOIN.md` | Two-machine deploy; friend handout |
| `docs/STATUS.md`, `docs/ROADMAP.md` | Current status and results; scoped-but-unbuilt design |
| `docs/walkthrough.html` | Visual request-lifecycle walkthrough |
| `docs/exit-blocking-benchmark.md` | Exit-blocking benchmark: method and the 6-outcome classifier |
| `docs/post/` | The published write-up (HTML + figures), live at [reputation-gated-egress.vercel.app](https://reputation-gated-egress.vercel.app) |
| `docs/adversarial-review.md` | Worst case per party, and the fixes |
