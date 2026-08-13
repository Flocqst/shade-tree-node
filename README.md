# reputation-gated onion egress

A Tor onion service that egresses to the clearnet only for clients who prove, in
zero knowledge, that they belong to a curated set. Everyone else is dropped before
a byte leaves. The point is a clean-IP egress that stays clean without ever
learning who its users are.

It runs as a **fleet**: many gateways, discovered live through a **bootnode**, with
membership and stake rooted on chain and a client that rotates across gateways per
request. It is a reference implementation, deployed and verified live end to end, and
**unaudited** (see [Security and audit](#security-and-audit)).

The write-up, with the exit-blocking benchmark and the gate protocol, is at
[reputation-gated-egress.vercel.app](https://reputation-gated-egress.vercel.app)
(source: [`docs/post/`](docs/post/)). The design of each milestone is in
[`docs/ROADMAP.md`](docs/ROADMAP.md).

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
your billing identity. Underneath both: an open clean-IP egress is blocklisted
within hours, so clean IPs stay clean only by being gated and scarce. We gate on a
proof of membership instead of an identity, which keeps sybil and rate resistance
while decoupling them from the IP and from who you are.

## Design

The gate is an application-layer protocol on top of Tor, not a Tor modification.
Tor cannot carry a reputation proof natively (cells are opaque, v3 client-auth is a
static linkable allowlist), but onion services give us the part that matters: each
gateway is published as a `.onion` and reached by rendezvous, so there is no exit
node and the gateway never learns the client IP.

```
  curl / SearXNG / your agent
        |
        v
  client ──── 1. pull the live gateway set from the bootnode (over Tor), verify it
        |     2. build ONE RLN membership proof for this request (fresh per-request nullifier)
        |     3. pick a gateway (weighted rotation + failover)
        |  SOCKS to Tor, no exit node
        v
  Tor rendezvous  (3 + 3 hops; client IP never revealed to the gateway)
        |
        v
  gateway.onion ── verify RLN proof · root in the on-chain freshness window? · nullifier fresh?
        |          a 2nd distinct signal on one nullifier reconstructs the secret and SLASHES
        v
  clean egress IP ──> destination   (TCP CONNECT :443 only; TLS stays end to end)
```

Three things make it a system rather than one proxy:

- **Membership is a real RLN circuit.** The set is a [Semaphore](https://semaphore.pse.dev/)
  / [RLN](https://rate-limiting-nullifier.github.io/rln-docs/) group. Each request carries a
  *fresh* nullifier and a Shamir share, all proven inside one circom-rln Groth16 proof
  (`lib/rln.mjs`, `circuits/rln/`). One share per slot egresses; a second distinct signal on
  the same nullifier is a provable over-spend, so the gateway reconstructs the identity secret
  and slashes the member's on-chain stake. Requests are mutually unlinkable, even to the gateway.
  Proofs are ~0.9 KB and verify in ~30 ms regardless of set size.
- **The root is on chain.** Members self-enroll (they generate their own identity and only a
  commitment ever leaves the machine) and stake into `StakedReputationSet` (`contracts/`, live on
  Sepolia). The gateway reads the admission root from the chain through a `RootProvider`
  (`lib/root-provider.mjs`), so there is no `members.json` to keep in sync and the operator never
  holds a member secret.
- **The fleet is discovered live.** Gateways announce to a **bootnode** (`bootnode/`), which
  serves a signed directory of live onions; the client pulls it over Tor and rotates per request.
  The onion is never on chain, and the bootnode is a cache, not a trust root. See
  [`docs/BOOTNODE.md`](docs/BOOTNODE.md).

## Run it

One CLI fronts every role. Each `--flag` maps to an `RGOE_*` env var (either works).

```bash
npm install
npm link                 # puts `rgoe` on PATH (or use `node bin/rgoe.mjs`)
rgoe doctor              # check node, tor, deps, keys
```

Fastest path to a running fleet, on a fresh Ubuntu droplet:

```bash
curl -fsSL https://raw.githubusercontent.com/dmarzzz/reputation-gated-onion-egress/main/bootnode/deploy/bootstrap.sh | sudo bash
```

It installs Tor and Node, mints the onions, starts the bootnode + gateway + heartbeat as
systemd units, and prints the bootnode onion, its pinned signer, and the client command.

Local, understand-the-pieces version (each a terminal):

```bash
rgoe keygen tor/hs-bootnode           # mint an onion identity
rgoe bootnode --admission open        # discovery bootnode (its own onion service)
rgoe gateway                          # a reputation-gated gateway
rgoe heartbeat --bootnode <onion>     # keep the gateway announced
rgoe enroll                           # a member identity (prints RGOE_SECRET)
rgoe client --secret <hex> --bootnode <onion> --dir-signer <signer-pubkey>
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json
```

The returned IP is a gateway's, not yours; the gateway never learned your IP; the request
carried a fresh RLN proof of membership. Full walkthrough (local and droplet) in
[`docs/QUICKSTART.md`](docs/QUICKSTART.md); every command and variable in
[`docs/CLI.md`](docs/CLI.md) and [`docs/CONFIG.md`](docs/CONFIG.md).

Watch the gate drop non-members: `node scripts/probe.mjs {noproof|garbage|wronggroup}`.

## Security and audit

This is a reference implementation, unaudited, and the ZK artifacts came from an untrusted
testnet ceremony. It is ready to be reviewed end to end: the trust boundaries, the threat
model per party, the test inventory, and what to read in what order are in
[`docs/AUDIT.md`](docs/AUDIT.md).

The whole repo is tested. One command runs every node selftest plus the Foundry contract suite:

```bash
npm test                 # auto-discovers all *selftest.mjs, then `forge test`
npm run test:node        # node selftests only (no foundry)
```

Coverage today: the security-critical directory module (onion↔key binding, signature
verification, poison resistance, rotation), the bootnode discovery loop end to end (every
adversarial announce rejected), the RLN spent-set and slashing control flow, the on-chain
`StakedReputationSet` and `GatewayRegistry` (Foundry), the stake verifier, the Tor key-format
correctness, the CLI, and the client selection path. See [`docs/AUDIT.md`](docs/AUDIT.md) for
the per-suite breakdown.

## Scope: what it is and is not

Built and verified:

- **Client anonymous to the gateway.** Onion rendezvous, no exit node, no IP.
- **Membership proven, never named**, with *per-request* unlinkable nullifiers (real RLN), so
  even a colluding set of gateways cannot rejoin a member's requests.
- **Operator never holds a secret.** Self-enrollment: only the commitment leaves the member.
- **On-chain admission with stake and slashing.** `StakedReputationSet` (members) and an optional
  `GatewayRegistry` (operators); over-spenders are slashed by cryptographic reconstruction.
- **A live fleet.** Bootnode discovery, per-request gateway rotation, failover, last-known-good
  caching. The onion is never on chain; the bootnode is a cache, not a trust root.
- **Metadata-only tunnel.** TCP `CONNECT :443` only; TLS stays end to end.

Deliberately out of scope, or still an operator responsibility:

- **No payments.** The gate is membership plus stake, not a fee. Anonymous payments are designed
  in [`docs/PAYMENTS.md`](docs/PAYMENTS.md), not built.
- **Admission is where sybil resistance lives.** The proof gates membership; it does not create
  reputation. Whatever adds a leaf (stake, invite, standing, proof-of-personhood) is what
  "reputable" means. This moves the sybil problem to admission; it does not dissolve it.
- **Gateway slashing is governed, not permissionless.** A member over-spend is a cryptographic
  proof; gateway misbehavior is a subjective judgment, so `GatewayRegistry.slash` is owner-gated.
- **Scale past one clean IP is the fleet's job**, and the fleet is only as clean as its gateways'
  IPs. Sourcing and rotating clean egress IPs is an operational problem, not a protocol one.
- **Rendezvous DoS.** Anyone with a `.onion` can force verify work; Tor's onion proof-of-work
  defense is the outer gate, enabled where the tor build has the `pow` module.
- **Unaudited, testnet ZK artifacts.** Do not put real funds or real anonymity needs on this yet.

Per-party worst case and fixes: [`docs/adversarial-review.md`](docs/adversarial-review.md).
Milestone design and status: [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Layout

| Path | What it is |
|------|------------|
| `bin/rgoe.mjs` | The unified CLI (every role, `--flag` → `RGOE_*` env) |
| `lib/rln.mjs`, `circuits/rln/` | Real circom-rln Groth16: prove, verify, reconstruct, slash |
| `lib/semaphore.mjs` | Load the group, prove, verify, epoch/slot math |
| `lib/directory.mjs` | Signed fleet directory: onion↔key binding, verify, rotation |
| `lib/root-provider.mjs` | Read the on-chain admission root (node or light client) |
| `lib/gateway-registry.mjs` | The pluggable gateway-stake verifier (on-chain or mock) |
| `contracts/StakedReputationSet.sol` | Member stake + ZK exit/withdraw + permissionless slash |
| `contracts/GatewayRegistry.sol` | Optional gateway operator stake (onion never on chain) |
| `gateway/gateway.mjs` | Onion-side egress: verify, dedup/slash, tunnel, drop |
| `client/rgoe-client.mjs`, `client/shim.mjs` | The fleet client (library) and its HTTP-CONNECT proxy |
| `client/selection.mjs` | Per-request gateway selection over the directory / bootnode |
| `bootnode/server.mjs` | Live discovery service (its own onion); serves the signed directory |
| `bootnode/announce.mjs`, `keygen.mjs`, `heartbeat.mjs`, `fetch.mjs` | Announce protocol, onion identity, gateway heartbeat, client fetch |
| `bootnode/deploy/` | One-command droplet bring-up |
| `group/enroll.mjs` | Self-enrollment (member generates its own identity) |
| `group/register-onchain.mjs`, `register-gateway.mjs` | Stake a member commitment / a gateway operator |
| `smithers/` | The whole roadmap as a runnable [Smithers](https://smithers.sh) workflow |
| `docker/`, `Dockerfile`, `docker-compose.yml` | Container image + a local tor/bootnode/gateway/client fleet |
| `scripts/test-all.mjs` | The audit entrypoint: every selftest + the contract suite |
| `docs/AUDIT.md` | Threat model, trust boundaries, test inventory, review order |
| `docs/QUICKSTART.md`, `CLI.md`, `CONFIG.md`, `BOOTNODE.md` | Getting started, commands, config, discovery design |
| `docs/ROADMAP.md`, `ONCHAIN.md`, `PAYMENTS.md` | Milestone design; on-chain admission; anonymous-payment design |
| `docs/STATUS.md`, `adversarial-review.md`, `exit-blocking-benchmark.md` | Live results; per-party worst case; the benchmark |
| `docs/post/` | The published write-up (HTML + figures) |
