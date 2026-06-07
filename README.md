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

Want to see exactly what happens to a request, hop by hop, and where the proof is
checked? Open [`docs/walkthrough.html`](docs/walkthrough.html) in a browser and
step through it.

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
residential IP and beats a Tor exit. To get a separate clean egress, split the
roles across two machines. The gateway and its tor run on a server; only the shim
runs on your laptop.

On the server (the egress box):

```bash
bash scripts/run-gateway.sh          # starts tor + gateway, prints the .onion
```

On your laptop, holding the same `group/members.json` and your own secret:

```bash
export RGOE_ONION=<the printed .onion>
bash scripts/run-client.sh           # starts a client-only tor + the shim
bash scripts/verify.sh               # receipt: your IP vs the egress IP
```

The gateway is portable: it is just a TCP server behind an onion address, and it
holds no secret. The full procedure, the invariants that matter (identical
`members.json`, clocks on NTP, loopback-only gateway), and a verification matrix
are in [`docs/DEPLOY.md`](docs/DEPLOY.md). To hand the egress to friends, give
each their own key and [`docs/JOIN.md`](docs/JOIN.md).

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
- **Within-epoch linkability is a limitation of this construction, not an inherent
  cost.** Here the nullifier scope is the public current epoch, so a member's
  requests within the day carry one shared nullifier and are linkable to each
  other. It is tempting to call this the unavoidable price of rate limiting, where
  a shorter epoch buys tighter limits at the cost of more in-window linkability.
  That framing is wrong. The rate-limit window and the linkability window are
  separable: hide the nullifier scope and range-prove it in zero knowledge, and a
  member can spend a fresh, unlinkable nullifier per request while the gateway still
  bounds the count. This PoC keeps the single-shared-nullifier version for
  simplicity; the fix does not even require a custom circuit in its first form, and
  is written up in [Future upgrades](#future-upgrades).
- **Replay inside an epoch is allowed by design.** The cached proof is re-sent each
  request and the gateway counts each redemption. The proof only ever travels
  inside the Tor-encrypted tunnel, so it is not exposed to an eavesdropper.
  Production RLN binds a fresh share per message and slashes over-rate secrets.
- **DoS on the rendezvous.** Anyone who knows the `.onion` can force proof
  verification work (~30ms of CPU each). Tor's onion-service proof-of-work defense
  is the outer gate against this. It is **stock tor, not a fork**: the PoW code
  (Equi-X) is GPL, so it compiles in only with `--enable-gpl`, which Homebrew's
  BSD-only bottle omits (`tor --list-modules` shows `pow: no`). Nothing was removed.
  `scripts/build-tor-pow.sh` compiles a pow-capable tor from stock source into
  `tor/tor-pow/`, and `scripts/start-tor.sh` turns the defense on automatically when
  it finds a tor that has the module. On stock tor the system runs unchanged, just
  without this outer gate; the zk gate still bounds egress regardless.

For the worst case each party (member, outsider, gateway operator, enroller, network
observer) can achieve, and the fixes in priority order, see
[`docs/adversarial-review.md`](docs/adversarial-review.md). The headline: the PoC's
enrollment hands the operator every member's secret, so anonymity against the
operator is not real until members self-generate their identities. That is the first
thing to fix.

## Future upgrades

Two improvements we have scoped but deliberately not built yet. Each is a real
protocol change, not a config tweak, which is why they live here and not in the
PoC.

### 1. Unlinkable rate limiting (decouple linkability from the rate window)

**Problem.** The gate rate-limits per member by scoping the nullifier to the
current epoch (`scope = floor(now / 86400)`, a day by default). That scope is
public and shared, so every request a member makes within the day carries the
same nullifier. The
gateway can count them, which is the point, but it can also link them. Shrinking
the epoch shrinks the linkable window but also shrinks the budget, so it looks like
rate limiting and unlinkability trade off against each other.

**They don't.** The trick is to stop publishing the scope. Make the epoch long, let
a member scope each request to a *different* epoch of their choosing, and prove in
zero knowledge only that the chosen epoch `e` is in range, for example
`present - W <= e <= present`, without revealing which `e`. Now:

- each request uses a distinct, member-chosen `e`, so each carries a distinct
  nullifier and the requests are **mutually unlinkable**, even to the gateway,
- the number of valid `e` values in the window (`W + 1`) bounds how many distinct
  nullifiers a member can present, so the **rate is still capped**: roughly one
  fresh nullifier per epoch sustained, with a burst of `W + 1`.

It turns out this ships in two tiers, and the first one needs **no custom circuit
at all.**

**Tier 1: public slots, stock Semaphore (buildable now).** Publish `K` scope slots
per epoch, `scope_i = H(epoch, i)` for `i` in `[0, K)`. The client uses a different
slot for each request and generates one ordinary Semaphore proof per slot. The
gateway accepts a proof only if its `scope` is in the published slot set for the
current or previous epoch, and dedups per nullifier as it does today. This already
breaks the tension:

- each slot yields a distinct nullifier `H(secret, scope_i)`, and those nullifiers
  are **mutually unlinkable** to the gateway, so a member's requests across slots
  cannot be tied together,
- a member has exactly `K` valid scopes per epoch, so the **rate is capped at `K`**
  no matter how they interleave them.

The cost is that the client now generates up to `K` proofs per epoch instead of one.
At ~0.7s per proof (see [proof overhead](#proof-overhead)) that is the difference
between a per-request stall and a non-issue: **precompute the epoch's `K` proofs in
the background at epoch rollover and rotate through them per request**, so the hot
path is just "pick the next unused proof," near zero latency. `K = 30` is ~21s of
background work per hour, fully parallel across cores. This is the bulk-generate-and-
rotate strategy, and it is what makes per-request unlinkability usable. The only
residual leak is that the gateway learns *which slot index* a request used (not who
used it), so it sees the slot-usage histogram but never a member.

**Tier 2: hidden slots, custom circuit (hardening).** To also hide the slot index,
and to get a sliding-window budget instead of a fixed per-epoch `K`, move the scope
inside the proof: prove in zero knowledge that the chosen epoch `e` satisfies
`present - W <= e <= present` (and `i < K`) without revealing `e` or `i`. Now the
gateway learns nothing but a fresh nullifier and the fact that it is in-budget.

- A custom circuit replaces the stock Semaphore proof: Merkle membership, a
  Poseidon nullifier over a *private* scope, and a comparator enforcing the range
  bound on `e` (and `i < K`). `present` is a public input the gateway pins to its
  clock.
- The gateway keeps a spent-nullifier set across the last `W + 1` epochs instead of
  just the current and previous epoch. Bounded by `K * W * activeMembers`.
- No slashing. RLN reconstructs an over-spender's secret from Shamir shares revealed
  in *public* messages. Our proof never leaves the Tor-encrypted tunnel to a single
  verifier, so there is no public share to slash on and nothing to reconstruct. The
  gateway simply refuses a nullifier once its budget is spent. This is strictly
  simpler than RLN and a better fit for the single-verifier setting.

**Cost.** Tier 1 is a small change to the gateway's scope check plus a precompute
loop in the shim, both on stock Semaphore. Tier 2 adds a circuit to write, audit,
and ship artifacts for, in exchange for hiding the slot index and a more flexible
budget. Tier 1 is the next thing to build; Tier 2 is the hardening after it.

### Proof overhead

Measured locally (Apple Silicon, `@semaphore-protocol` v4), so the numbers above are
grounded:

| Reputation set | Merkle depth | Proof size | Generate (warm) | Verify |
|---|---|---|---|---|
| 1 member | 1 | 882 B | ~470 ms | ~32 ms |
| 100 | 7 | 882 B | ~784 ms | ~30 ms |
| 1000 | 10 | 884 B | ~891 ms | ~30 ms |

Takeaways: the proof is **tiny and fixed-size** (~0.9 KB, a Groth16 proof plus
public signals, independent of set size), verification is **cheap and constant**
(~30 ms, so the gateway can verify thousands/sec/core), and **generation is the only
real cost** (~0.5–0.9s warm, growing slowly with tree depth, plus a one-time ~2–4s
cold start for artifact load). Today the shim pays one generation per epoch and
caches it, so cost is negligible. The bulk-precompute strategy above keeps it
negligible even when every request wants its own nullifier.

### 2. On-chain reputation set (Ethereum)

**Problem.** Today the reputation set is `group/members.json`, a file the gateway
and every client must hold byte-identical or proofs fail the root check. The trust
root is whoever runs `enroll.mjs`. There is no public audit trail, no shared source
of truth, and updating the set means redistributing a file out of band.

**Goal.** Source the set from an Ethereum contract so the Merkle root is canonical,
public, and tamper-evident, admission is enforced on-chain, and the gateway and
clients both read the same root from the same place with no file to sync.

**Design.**

- Deploy Semaphore's on-chain group contract (`Semaphore.sol` maintains a group's
  members, exposes the current Merkle root, and accepts proofs against recent roots
  within a freshness window). Members are added by `addMember(groupId, commitment)`,
  gated by whatever admission policy you want in front of it: `onlyOwner`, a stake
  deposit, a token balance, a DAO vote, or a World ID proof (itself Semaphore-based,
  so it composes cleanly).
- The gateway stops calling `loadGroup()` on JSON and instead reads the group's
  current root, plus the recent roots inside the freshness window, from the contract
  over RPC, refreshing on `MemberAdded` events. `checkProof`'s single-root equality
  test becomes membership in that recent-root set. The freshness window is the
  on-chain analog of the current "this epoch or last epoch" skew tolerance: a proof
  built against a root that was current a block ago still verifies.
- Clients derive the leaves from `MemberAdded` event logs and rebuild the tree
  locally, then check the local root against the on-chain root before trusting it.
  No `members.json` to ship. `members.json` can stay as an offline cache whose root
  is verified against chain.

**What changes.**

- `lib/semaphore.mjs`: `loadGroup()` gains an on-chain mode behind
  `RGOE_GROUP_CONTRACT` / `RGOE_RPC_URL` / `RGOE_GROUP_ID`, with the JSON path kept
  as the offline default.
- `gateway/gateway.mjs`: `TRUSTED_ROOT` becomes a refreshed set of recent roots.
- `group/enroll.mjs`: grows a sibling that submits `addMember` on-chain.
- New `contracts/` with the group contract and a deploy script.

**Cost and honest scope.**

- Adds an RPC dependency and a chain-liveness assumption to a system that is
  otherwise fully local. Mitigate by caching the last-known root: if the RPC is
  down, the gate keeps working against the last root it saw.
- Enrollment now costs gas and confirmation latency. Fine for a slowly-changing set;
  use an L2 (Base, Optimism, Arbitrum) to keep it cheap. Semaphore has deployments
  there.
- No new identity leakage. Only commitments go on-chain, exactly as in
  `members.json` today, and a commitment reveals nothing about who holds the secret.
  One new exposure: enrollment is now publicly timestamped and linkable to the
  address that paid the gas. If admission is stake- or token-based that linkage is
  inherent. If you need enroller privacy, relay the `addMember` call through a
  meta-transaction or a privacy pool. Out of scope here.

## Layout

| Path | What it is |
|------|------------|
| `lib/semaphore.mjs` | Shared: load the group, prove, verify, epoch math |
| `group/enroll.mjs` | Add a member to the reputation set (the trust boundary) |
| `group/seed-demo-members.mjs` | Mint a labeled demo set + a private keyring to hand out |
| `group/members.json` | The published reputation set (identity commitments only) |
| `gateway/gateway.mjs` | Onion-side egress proxy: verify, rate-limit, tunnel, drop |
| `client/shim.mjs` | Local CONNECT proxy: prove, dial onion over Tor, tunnel |
| `scripts/probe.mjs` | Adversary probe (no-proof / garbage / forged-group) |
| `scripts/run-all.sh` | Start tor + gateway + shim on one machine (local PoC) |
| `scripts/run-gateway.sh` | Server role: tor + gateway, no shim, no secret |
| `scripts/run-client.sh` | Laptop role: client-only tor + shim, via `RGOE_ONION` |
| `scripts/start-tor.sh` | Start dedicated tor; auto-enable PoW if the build supports it |
| `scripts/start-tor-client.sh` | Start a SOCKS-only client tor (no onion published) |
| `scripts/join.sh` | Friend one-command: bring up the client and verify |
| `scripts/verify.sh` | Client receipt: your IP vs egress IP, RTT, google check |
| `scripts/gateway-status.sh` | Server receipt: PASS/DROP counts, distinct members, egress IP |
| `scripts/build-tor-pow.sh` | Compile a pow-capable tor (stock source, `--enable-gpl`) into `tor/tor-pow/` |
| `scripts/stop.sh` | Stop everything this PoC started |
| `tor/torrc` | Dedicated tor: ports 9250/9251, onion service, PoW note |
| `tor/torrc.client` | Client-only tor: SOCKS 9260, no onion |
| `docs/DEPLOY.md` | Two-machine deploy: procedure, invariants, verification matrix |
| `docs/JOIN.md` | Friend handout: one command to use the egress |
| `docs/walkthrough.html` | Visual request-lifecycle walkthrough (open in a browser) |
| `docs/adversarial-review.md` | What is the worst each party can do, and the fixes |
