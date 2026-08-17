# reputation-gated onion egress

A Tor onion service that egresses to the clearnet only for clients who prove, in
zero knowledge, that they belong to a curated set. Everyone else is dropped before
a byte leaves. The point is a clean-IP egress that stays clean without ever learning
who its users are.

- **What it is.** An application-layer reputation gate on top of Tor onion services.
  It runs as a fleet: many gateways, discovered live through a bootnode, membership and
  stake rooted on chain, and a client that rotates across gateways per request.
- **Why it matters.** Tor exit IPs are a public, auto-blocked list, so honest Tor users
  get walled out. This gates on a *proof of membership* instead of an identity, so a
  clean egress IP stays scarce and sybil-resistant without a trusted third party ever
  learning who you are.
- **How to run it.** One CLI, `rgoe`. Joining the live fleet and the 30-second local loop are
  [below](#run-it); the full walkthrough is in [`docs/QUICKSTART.md`](docs/QUICKSTART.md).

It is a reference implementation, **unaudited**, on **testnet ZK artifacts** (see
[Security and audit](#security-and-audit)). As of 2026-08-17 a fleet is live for members:
two gateways in two regions behind one bootnode, stake admission on, membership rooted on
Sepolia, access buyable over HTTP 402. It is still not production: the trusted-setup ceremony
has not been run, nothing is audited, everything on chain is testnet, and the fleet is one
operator on one cloud provider (see [Status](#status-2026-08-17) and
[Scope](#scope-what-it-is-and-is-not)).

The write-up, with the exit-blocking benchmark and the gate protocol, is at
[reputation-gated-egress.vercel.app](https://reputation-gated-egress.vercel.app)
(source: [`docs/post/`](docs/post/)). What comes next is in [`docs/ROADMAP.md`](docs/ROADMAP.md);
the design of each shipped milestone is in [`docs/ROADMAP-v1.md`](docs/ROADMAP-v1.md).

## Status (2026-08-17)

- **Fleet live.** Bootnode + gateway-1 (DigitalOcean NYC1) and gateway-2 (DigitalOcean SFO3), stake
  admission on (`GatewayRegistry` `0x94ECeD0C1c7a8793a5c901c8C1995C8E7039A868`). Bootnode onion
  `kssrk54kb5kngr4jjdzjouecwjh5ayzbzhamwmvju4kz63vno7hy4uyd.onion`, signer
  `d79f78c369bd9c7b74575eae0c5068e6921f90bfdc97d43af9adc0039f953a73`; both are in
  [`network/sepolia/README.md`](network/sepolia/README.md) and `RGOE_NETWORK=sepolia` reads them.
  Execution record: [`docs/GO-LIVE-LOG-2026-08-17.md`](docs/GO-LIVE-LOG-2026-08-17.md).
- **Three ways in.** Invited (a leaf in the committed `group/members.json`), staked
  (`StakedReputationSet` rln-v4 `0xFe48De8b9aCA4386DC31C845d579ae62f04f9d25`, tiers 8/32, on-chain
  tiered slash), or bought (`PaidAccessSet` `0x4e8C2Bf5d3c5454A04837401095fce2646484111`); the
  gateways trust the union of the three roots.
- **Payments live on Sepolia.** HTTP 402 in both x402 v2 and MPP, settled by the operator via
  EIP-3009 (buyer needs no gas). On 2026-08-17 one buyer per rail bought a leaf and egressed
  through the fleet with nothing else. Settle asset today is a test EIP-3009 token; real USDC is
  one env ([`docs/PAYMENTS.md`](docs/PAYMENTS.md)).
- **Not done.** The trusted-setup ceremony has not been run: ZK artifacts are the untrusted dev
  testnet set ([issue #6](https://github.com/dmarzzz/reputation-gated-onion-egress/issues/6),
  [`docs/CEREMONY.md`](docs/CEREMONY.md)). Unaudited. Testnet only. One operator, one provider
  (two regions, same ASN). Do not rely on it for real anonymity or funds.

## The problem

Tor exit IPs are a public, auto-blocked list with perpetually bad reputation
([torbulkexitlist](https://check.torproject.org/torbulkexitlist),
[FireHOL tor_exits](https://iplists.firehol.org/?ipset=tor_exits)), so honest Tor
users get locked out. Measured directly over the same 36 sites: a home IP was blocked
8.3 percent of the time, a datacenter IP 16.7, and Tor 17.1, with the sites that wall
Tor at 90 to 100 percent mostly fronted by commercial anti-bot vendors; method and
classifier in [`docs/exit-blocking-benchmark.md`](docs/exit-blocking-benchmark.md).
The usual escape, a [residential proxy](docs/residential-proxies.md), trades
IP-reputation evasion for a fully trusted third party who links every request to your
billing identity. Underneath both: an open clean-IP egress is blocklisted within hours,
so clean IPs stay clean only by being gated and scarce. We gate on a proof of membership
instead of an identity, which keeps sybil and rate resistance while decoupling them from
the IP and from who you are.

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
- **The root is on chain, and it is a union.** Members self-enroll (they generate their own
  identity and only a commitment ever leaves the machine). The gateway admits the UNION of three
  sets, one tree shape, one proof: the committed `group/members.json` (invited), every staked set in
  `RGOE_GROUP_CONTRACT` (`StakedReputationSet`, `contracts/`, live on Sepolia, tiered stake), and the
  **paid** set (`PaidAccessSet`, `RGOE_PAID_ACCESS_CONTRACT`) whose leaves the operator inserts after
  a 402 payment. Roots are read from the chain through a `RootProvider` (`lib/root-provider.mjs`,
  node or Helios-anchored light client), so the operator never holds a member secret, and a slash
  lands on whichever contract holds the leaf ([ADR 0007](docs/adr/0007-paid-access.md),
  [`docs/PAYMENTS.md`](docs/PAYMENTS.md)).
- **The fleet is discovered live.** Gateways announce to a **bootnode** (`bootnode/`), which
  serves a signed directory of live onions; the client pulls it over Tor, verifies it, caches a
  persisted last-known-good copy, and rotates per request. The onion is never on chain, and the
  bootnode is a cache, not a trust root. See [`docs/BOOTNODE.md`](docs/BOOTNODE.md).

## Run it

One CLI fronts every role. Each `--flag` maps to an `RGOE_*` env var (either works).

```bash
npm install
npm link                 # puts `rgoe` on PATH (or use `node bin/rgoe.mjs`)
rgoe doctor              # check node, tor, deps, keys
```

**Join the live fleet.** `RGOE_NETWORK=sepolia` fills the bootnode onion, its pinned signer,
and the contract addresses from [`network/sepolia/`](network/sepolia/README.md); the client
fetches the signed directory over Tor and rotates across the two gateways. You need a local Tor
SOCKS port (`bash scripts/start-tor-client.sh` gives you 9260; `--tor-port 9050` for a system tor).

```bash
# handed a secret by the operator (a leaf in group/members.json):
RGOE_SECRET=<hex> RGOE_NETWORK=sepolia rgoe client
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json     # a gateway's clean IP

# or buy a leaf over HTTP 402 (a wallet holding the settle asset; no gas):
rgoe enroll                                                    # your secret + commitment, locally
rgoe pay --network sepolia --limit 8 --protocol x402 --key-file buyer.key --secret-file ./.secret   # or --protocol mpp
RGOE_NETWORK=sepolia rgoe client --secret <hex> --limit 8      # proves against the paid set

# or stake a leaf (tier 8 or 32; posts the tier's bond):
rgoe register-member <commitment> --limit 8 --network sepolia
```

The returned IP is a gateway's, not yours; the gateway never learned your IP; the request
carried a fresh RLN proof of membership. Member page: [`docs/JOIN.md`](docs/JOIN.md).

**The 30-second local loop** stands up a bootnode, a gateway, and a client on one box
(each line its own terminal; you need a local Tor daemon, which the repo ships):

```bash
rgoe keygen tor/hs-bootnode           # mint an onion identity
rgoe bootnode --admission open        # discovery bootnode (its own onion service)
rgoe gateway                          # a reputation-gated gateway
rgoe heartbeat --bootnode <onion>     # keep the gateway announced
rgoe enroll                           # a member identity (prints RGOE_SECRET)
rgoe client --secret <hex> --bootnode <onion> --dir-signer <signer-pubkey>
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json
```

Watch the gate drop non-members with `node scripts/probe.mjs {noproof|garbage|wronggroup}`.

**The one-command droplet** brings the same fleet up on a fresh Ubuntu box:

```bash
curl -fsSL https://raw.githubusercontent.com/dmarzzz/reputation-gated-onion-egress/main/bootnode/deploy/bootstrap.sh | sudo bash
```

It installs Tor and Node, mints the onions, starts the bootnode + gateway + heartbeat as
systemd units, and prints the bootnode onion, its pinned signer, and the client command.
Opt-ins: `RGOE_BOOTNODE_ONION=<onion>` for a gateway-only box that joins an existing bootnode
(how gateway-2 was added), `RGOE_REGISTRAR=1` to sell access over 402, `RGOE_HELIOS=1` for the
light-client root anchor ([`bootnode/deploy/README.md`](bootnode/deploy/README.md)).

Full walkthrough (live fleet, local, on-chain mode, and droplet) is in
[`docs/QUICKSTART.md`](docs/QUICKSTART.md); every command in [`docs/CLI.md`](docs/CLI.md)
and every variable in [`docs/CONFIG.md`](docs/CONFIG.md).

## Security and audit

This is a reference implementation, unaudited, and the ZK artifacts came from an untrusted
testnet ceremony. It is ready to be reviewed end to end: the trust boundaries, the threat
model per party, the test inventory, and what to read in what order are in
[`docs/AUDIT.md`](docs/AUDIT.md). The security policy and how to report privately are in
[`SECURITY.md`](SECURITY.md); the auditor's guide and written invariants for the contracts
are in [`docs/CONTRACTS-AUDIT.md`](docs/CONTRACTS-AUDIT.md).

The whole repo is tested. One command runs every node selftest plus the Foundry contract suite:

```bash
npm test                 # auto-discovers all *selftest.mjs, then `forge test`
npm run test:node        # node selftests only (no foundry)
```

Coverage today: the security-critical directory module (onion↔key binding, signature
verification, poison resistance, rotation), the bootnode discovery loop end to end (every
adversarial announce rejected), the RLN spent-set and slashing control flow, the on-chain
`StakedReputationSet`, `PaidAccessSet` and `GatewayRegistry` (Foundry), the stake verifier, the
client-side stake re-verification path, the 402 registrar and both payment wire dialects
(adversarial matrix, replay, crash recovery), the multi-root gateway with real proofs, the Tor
key-format correctness, the CLI, and the client selection path. See [`docs/AUDIT.md`](docs/AUDIT.md) for the per-suite breakdown.

## Scope: what it is and is not

Built and verified:

- **Client anonymous to the gateway.** Onion rendezvous, no exit node, no IP.
- **Membership proven, never named**, with *per-request* unlinkable nullifiers (real RLN), so
  even a colluding set of gateways cannot rejoin a member's requests.
- **Reputation is a spectrum, not a bit.** A member's per-epoch budget is a *tier* baked into
  its leaf (`rgoe enroll --limit 32`); two tiers with different `K` are proven in the same
  circuit, enforced by the same root + nullifier set, unforgeable, and invisible on the wire.
  On chain too: the rln-v4 `StakedReputationSet` charges `bondFor(limit)` and slashes per tier
  ([ADR 0006](docs/adr/0006-reputation-tiers.md)).
- **Operator never holds a secret.** Self-enrollment: only the commitment leaves the member.
- **On-chain admission with stake and slashing.** `StakedReputationSet` (members) and
  `GatewayRegistry` (operators; the live bootnode admits staked operators only); over-spenders
  are slashed by cryptographic reconstruction, on the contract that holds the leaf.
- **Access can be bought, and it was.** `rgoe pay` speaks HTTP 402 in both machine-payment
  dialects (x402 v2 and MPP) to the operator's registrar on the bootnode onion (`:8878`), signs
  one EIP-3009 stablecoin authorization (no gas), the operator settles and inserts the leaf into
  `PaidAccessSet`, and egress is the same RLN proof. Both rails were exercised live on Sepolia on
  2026-08-17, purchase through egress ([`docs/PAYMENTS.md`](docs/PAYMENTS.md), `payments/`).
- **A live fleet.** Bootnode discovery, per-request gateway rotation, failover, and a persisted
  last-known-good directory cache; two gateways in two regions today. Clients re-derive each
  onion's key and, opt-in with `RGOE_VERIFY_STAKE`, re-check a gateway's operator signature and
  live stake themselves rather than trusting the bootnode's label. The onion is never on chain;
  the bootnode is a cache, not a trust root.
- **A trust-minimized root read.** `LightClientRootProvider` proves the root against the block
  state (EIP-1186) and, with `RGOE_HELIOS_RPC_URL`, anchors the state root to the beacon sync
  committee; live receipts in [`docs/LIGHT-CLIENT.md`](docs/LIGHT-CLIENT.md).
- **Metadata-only tunnel.** TCP `CONNECT :443` only; TLS stays end to end.
- **A distributable Rust client.** `rust/` (`rgoe-proto` + `rgoe-rln` + `rgoe-client`) byte-matches
  the JS wire formats against `testdata/vectors.json`, and the `-live` build egresses over embedded
  arti with per-request rotation; it went through the fleet on go-live day. Release binaries are
  built by `.github/workflows/release.yml` on a `v*` tag; none is cut yet, so build it yourself
  ([`rust/INSTALL.md`](rust/INSTALL.md)).
- **Artifact-version negotiation.** Client and gateway agree on which ZK artifact set a proof
  was made with, so the ceremony swap can roll without a flag day
  ([`docs/PROTOCOL-VERSIONING.md`](docs/PROTOCOL-VERSIONING.md), `testdata/zk-artifacts.lock.json`).

Deliberately out of scope, still an operator responsibility, or honestly not done:

- **Payments are testnet-only and the buyer↔operator link is public.** The transfer (buyer
  address → operator, the tier's price) is on chain by design and the tier bucket is public;
  decorrelating the funding address (Layer 0) is the buyer's choice, not something the protocol
  does for them. The operator is its own x402 facilitator (no third party, so nothing to trust
  but also nothing to hide behind). Today's settle asset is a test EIP-3009 token; real USDC is
  one env.
- **Admission is where sybil resistance lives.** The proof gates membership; it does not create
  reputation. Whatever adds a leaf (stake, invite, payment, proof-of-personhood) is what
  "reputable" means. This moves the sybil problem to admission; it does not dissolve it.
- **Gateway slashing is governed, not permissionless.** A member over-spend is a cryptographic
  proof; gateway misbehavior is a subjective judgment, so `GatewayRegistry.slash` is owner-gated.
- **Scale past one clean IP is the fleet's job**, and the fleet is only as clean as its gateways'
  IPs. Sourcing and rotating clean egress IPs is an operational problem, not a protocol one.
- **Rendezvous DoS.** Anyone with a `.onion` can force verify work; Tor's onion proof-of-work
  defense is the outer gate, enabled where the tor build has the `pow` module (off on the live
  fleet today, because not every client tor has it).
- **Live on testnet for members; not production.** The ceremony has not been run
  ([issue #6](https://github.com/dmarzzz/reputation-gated-onion-egress/issues/6)), nothing is
  audited, and the fleet is one operator on one provider, two regions, same ASN. What remains is
  in [`docs/SHIP-PLAN.md`](docs/SHIP-PLAN.md) and the go-live log's "Left open".
- **Unaudited, testnet ZK artifacts.** Do not put real funds or real anonymity needs on this yet.

Per-party worst case and fixes: [`docs/adversarial-review.md`](docs/adversarial-review.md).

## Docs

| Doc | What it is |
|-----|------------|
| [`docs/GO-LIVE-LOG-2026-08-17.md`](docs/GO-LIVE-LOG-2026-08-17.md) | The go-live execution record: bootnode + gateway-1, gateway-2, stake admission, backups, the 402 registrar and the live purchases, and what is left open |
| [`network/sepolia/README.md`](network/sepolia/README.md) | The live Sepolia record: `contracts.json` (addresses), `bootnode.json` (bootnode onion + signer, read by `RGOE_NETWORK=sepolia`), `directory-bootnode.json` (signed fleet), the legacy static fleet |
| [`docs/QUICKSTART.md`](docs/QUICKSTART.md) | Join the live fleet, or stand up your own: local loop, on-chain mode, one-command droplet |
| [`docs/CLI.md`](docs/CLI.md), [`docs/CONFIG.md`](docs/CONFIG.md) | Every `rgoe` command and every `RGOE_*` variable + default |
| [`docs/OPERATOR.md`](docs/OPERATOR.md) | Runbook for running a gateway or bootnode in production |
| [`docs/INCIDENT.md`](docs/INCIDENT.md) | Incident-response playbook for the failure modes that matter |
| [`docs/BACKUP.md`](docs/BACKUP.md), [`docs/ONION-IDENTITY.md`](docs/ONION-IDENTITY.md) | `rgoe backup` / `rgoe restore` (encrypted key material) and verify-before-cutover onion continuity |
| [`docs/TOR-HARDENING.md`](docs/TOR-HARDENING.md), [`docs/SLO.md`](docs/SLO.md) | Hardening the Tor layer under the fleet; service-level objectives + error budget |
| [`docs/ONCHAIN-DEPLOY.md`](docs/ONCHAIN-DEPLOY.md) | Runbook for a persistent on-chain deployment of the stake contracts |
| [`docs/BOOTNODE.md`](docs/BOOTNODE.md) | The live-discovery design: announce, signed directory, trust boundary |
| [`docs/FLEET.md`](docs/FLEET.md) | Fleet discovery + per-request selection design, and the fleet-wide budget analysis |
| [`docs/ONCHAIN.md`](docs/ONCHAIN.md) | On-chain admission: staked set, gateway registry, root provider |
| [`docs/LIGHT-CLIENT.md`](docs/LIGHT-CLIENT.md) | Trust-minimized (light-client) reads of the reputation root; the Helios sync-committee anchor and its live receipts |
| [`docs/PAYMENTS.md`](docs/PAYMENTS.md) | Payments, shipped 2026-08-17: the 402 rails (x402 + MPP, EIP-3009, operator as facilitator, `PaidAccessSet`), the leak ledger, and the anonymity design they sit in |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md), [`docs/AUDIT.md`](docs/AUDIT.md) | The consolidated threat model; trust boundaries, test inventory, review order |
| [`docs/CONTRACTS-AUDIT.md`](docs/CONTRACTS-AUDIT.md) | Auditor's guide + written invariants for the Solidity contracts |
| [`docs/PROTOCOL-API.md`](docs/PROTOCOL-API.md) | Wire formats + bootnode HTTP API; the Rust conformance target |
| [`docs/PROTOCOL-VERSIONING.md`](docs/PROTOCOL-VERSIONING.md), [`docs/RECEIPTS.md`](docs/RECEIPTS.md) | Envelope version negotiation; signed egress success receipts |
| [`docs/CLIENTS.md`](docs/CLIENTS.md), [`docs/SDK.md`](docs/SDK.md), [`docs/ADAPTERS.md`](docs/ADAPTERS.md) | Client modes (shim vs. library), the `RgoeClient` SDK, routing tools/agents through the fleet |
| [`docs/MUTATION-TESTING.md`](docs/MUTATION-TESTING.md) | Mutation-testing setup and the surviving-mutant list |
| [`docs/adr/`](docs/adr/) | Architecture decision records for the load-bearing decisions; [0006](docs/adr/0006-reputation-tiers.md) reputation tiers, [0007](docs/adr/0007-paid-access.md) paid access as a second tree |
| [`SECURITY.md`](SECURITY.md) | Security policy: what is in scope, what is known, how to report |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to run the tests and the house rules a change must hold |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | The forward roadmap: protocol properties, fleet gaps, discovery, payments, zkAPI; with a status map of what PR #5 built |
| [`docs/ROADMAP-v1.md`](docs/ROADMAP-v1.md), [`docs/NEXT-VERSION.md`](docs/NEXT-VERSION.md), [`docs/RLN-MIGRATION.md`](docs/RLN-MIGRATION.md) | The original milestone designs (1–5), the next-version build spec, and the RLN migration plan (historical; what they specified is built) |
| [`docs/SHIP-PLAN.md`](docs/SHIP-PLAN.md) | The shipping backlog and the release gates (test → Rust client → deploy; all three passed 2026-08-17), and what is still open |
| [`docs/CEREMONY.md`](docs/CEREMONY.md), [`docs/GO-LIVE.md`](docs/GO-LIVE.md) | The two human-gated runbooks: production trusted setup (NOT run yet; artifact hashes are pinned in `testdata/zk-artifacts.lock.json` and CI-verified) and the live-deployment runbook the go-live log executed |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) (+ `PROTOCOL.html`) | The protocol design write-up for anonymous paid access (access layer built; payment layer design) |
| [`docs/STATUS.md`](docs/STATUS.md), [`docs/REPORT.md`](docs/REPORT.md), [`docs/DEPLOY.md`](docs/DEPLOY.md), [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), [`docs/JOIN.md`](docs/JOIN.md), [`docs/walkthrough.html`](docs/walkthrough.html) | Historical: the June 2026 single-gateway PoC status/report/deploy guides, the July fleet deployment record, and the PoC member page + request walkthrough |
| [`docs/adversarial-review.md`](docs/adversarial-review.md), [`docs/exit-blocking-benchmark.md`](docs/exit-blocking-benchmark.md) | Per-party worst case; the benchmark |
| [`docs/residential-proxies.md`](docs/residential-proxies.md), [`docs/residential-proxy-providers.md`](docs/residential-proxy-providers.md) | Background research: what residential proxies do to your privacy, and a provider taxonomy |
| [`docs/post/`](docs/post/) | The published write-up (HTML + figures), plus [`JOIN.md`](docs/post/JOIN.md) and [`RUN-A-GATEWAY.md`](docs/post/RUN-A-GATEWAY.md) for members and operators |

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
| `contracts/GatewayRegistry.sol` | Gateway operator stake (onion never on chain); the live bootnode admits on it |
| `contracts/PaidAccessSet.sol` | Paid-access membership tree: operator-inserted leaves, on-chain root, slash zeroes the leaf |
| `payments/` | The 402 registrar (`registrar.mjs`), both wire dialects (`wire.mjs`), EIP-3009 typed data, test-asset deploy |
| `group/pay.mjs`, `group/leaves.mjs` | `rgoe pay` (buy a leaf over x402/MPP); export an on-chain set's leaves for the Rust client |
| `lib/helios-root.mjs`, `lib/zk-artifacts.mjs` | Helios sync-committee anchor for the light-client root; ZK artifact-set lock + negotiation |
| `network/` | Committed deployment records per network (`sepolia/`: contracts, bootnode, signed directory); `RGOE_NETWORK` reads them |
| `gateway/gateway.mjs` | Onion-side egress: verify, dedup/slash, tunnel, drop |
| `client/rgoe-client.mjs`, `client/shim.mjs` | The fleet client (library) and its HTTP-CONNECT proxy |
| `client/selection.mjs` | Per-request gateway selection + client-side stake re-verification |
| `bootnode/server.mjs` | Live discovery service (its own onion); serves the signed directory |
| `bootnode/announce.mjs`, `keygen.mjs`, `heartbeat.mjs`, `fetch.mjs` | Announce protocol, onion identity, gateway heartbeat, client fetch |
| `bootnode/deploy/` | One-command droplet bring-up |
| `group/enroll.mjs` | Self-enrollment (member generates its own identity) |
| `group/register-onchain.mjs`, `register-gateway.mjs` | Stake a member commitment / a gateway operator |
| `rust/` | The distributable client: `rgoe-proto` (wire formats), `rgoe-rln` (prover + tree), `rgoe-client` (embedded arti, `-live` egress) |
| `smithers/` | The whole roadmap as a runnable [Smithers](https://smithers.sh) workflow |
| `docker/`, `Dockerfile`, `docker-compose.yml` | Container image + a local tor/bootnode/gateway/client fleet |
| `monitoring/`, `scripts/uptime-probe.mjs` | Prometheus/Grafana material for the gateway + bootnode metrics; the scheduled fleet uptime probe |
| `examples/`, `web/` | Routing an agent through the fleet (`agent-egress.mjs`, `agent-fetch.mjs`); the fleet map page |
| `scripts/test-all.mjs` | The audit entrypoint: every selftest + the contract suite |
