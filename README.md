# reputation-gated onion egress

A Tor onion service that egresses to the clearnet only for clients who prove, in zero
knowledge, that they belong to a set the gateway trusts. Everyone else is dropped before a
byte leaves. The gateway never learns who its users are or where they come from: it is
reached by onion rendezvous (no exit node, no client IP), it verifies one RLN membership
proof per request, and it tunnels `CONNECT host:443` from its own clean IP. It runs as a
fleet: many gateways, discovered live through a bootnode, membership rooted on chain, one
CLI (`rgoe`) for every role. Write-up with the design and the exit-blocking benchmark:
[reputation-gated-egress.vercel.app](https://reputation-gated-egress.vercel.app)
(source [`docs/post/`](docs/post/)). Security policy: [`SECURITY.md`](SECURITY.md).

## Status (2026-08-18)

- **Live on testnet.** Bootnode + gateway-1 (DigitalOcean NYC1) + gateway-2 (DigitalOcean
  SFO3), stake admission on (`GatewayRegistry` `0x94ECeD0C1c7a8793a5c901c8C1995C8E7039A868`).
  Bootnode `kssrk54kb5kngr4jjdzjouecwjh5ayzbzhamwmvju4kz63vno7hy4uyd.onion`, signer
  `d79f78c369bd9c7b74575eae0c5068e6921f90bfdc97d43af9adc0039f953a73`; `RGOE_NETWORK=sepolia`
  reads both from [`network/sepolia/`](network/sepolia/README.md). Record:
  [`docs/GO-LIVE-LOG-2026-08-17.md`](docs/GO-LIVE-LOG-2026-08-17.md).
- **Three ways in.** Invited (a leaf in the committed `group/members.json`), staked
  (`StakedReputationSet` rln-v4 `0xFe48De8b9aCA4386DC31C845d579ae62f04f9d25`, tiers 8/32,
  refundable bond, tiered slash) and paid (`PaidAccessSet`
  `0x4e8C2Bf5d3c5454A04837401095fce2646484111`, operator-inserted after an HTTP 402 payment).
  Each gateway provider chooses which of the three it honors (`RGOE_ADMIT`, default `invited`,
  the maximum-anonymity mode) and whether it sells
  ([ADR 0008](docs/adr/0008-per-gateway-admission-and-payment-choice.md)). The live fleet is
  heterogeneous on purpose since 2026-08-18: gateway-1 admits `invited,staked,paid` and sells
  over x402 and MPP; gateway-2 admits `invited,staked` and sells nothing. So a paid buyer
  routes to gateway-1 only, and `--max-anon` refuses both today (neither is invited-only) and
  says so.
- **Payments live on Sepolia**, x402 v2 and MPP, one EIP-3009 authorization signed by the
  buyer (no gas), settled by the operator, who is its own facilitator. Per provider: a
  registrar is opt-in and `RGOE_PAY_PROTOCOLS` picks the rails. Settle asset today is a test
  token (tUSD); real USDC is one env ([`docs/PAYMENTS.md`](docs/PAYMENTS.md)).
- **Binaries.** [v0.1.1](https://github.com/dmarzzz/reputation-gated-onion-egress/releases/tag/v0.1.1):
  a static Rust client for 7 targets, plus a `-live` build (embedded Tor + prover) for
  linux-x86_64, macos-arm64 and windows-x86_64, each with a `.sha256`
  ([`rust/INSTALL.md`](rust/INSTALL.md)).
- **Not done.** No trusted-setup ceremony: the ZK artifacts are the untrusted dev set
  ([issue #6](https://github.com/dmarzzz/reputation-gated-onion-egress/issues/6),
  [`docs/CEREMONY.md`](docs/CEREMONY.md)). Unaudited. Sepolia only. One operator, one cloud
  provider, one ASN. Do not rely on it for real anonymity or real funds.

## Use it

Install the CLI (`npm install && npm link`, or `node bin/rgoe.mjs`; `rgoe doctor` checks node,
tor, deps, keys) and start a local Tor SOCKS port (`bash scripts/start-tor-client.sh` gives
you 9260, add `--tor-port 9260`; a system tor is `--tor-port 9050`). Every `--flag` is an
`RGOE_*` env var, either works. Then pick your way in; all three end at the same proxy:

```bash
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json   # a gateway's clean IP, not yours
```

**I was invited** (someone sent you an `RGOE_SECRET`; your leaf is in `group/members.json`):

```bash
RGOE_SECRET=<hex> RGOE_NETWORK=sepolia rgoe client
```

**I want to buy access** (a wallet holding the settle asset on Sepolia; no ETH, no gas):

```bash
rgoe enroll                                              # your secret + commitment, locally; keep the secret
rgoe pay --network sepolia --limit 8 --protocol x402 --key-file buyer.key --secret-file ./.secret   # or --protocol mpp
RGOE_NETWORK=sepolia rgoe client --secret <hex> --limit 8   # --limit 32 if you bought tier 32
```

`--dry-run` shows the operator's 402 challenge and the exact authorization you would sign.
Read before paying: the transfer (your address, the operator's address, the tier's price) and
the operator's `insert(commitment, limit)` are public on chain, so "this address bought access
from this operator" is visible to anyone; your later requests are not (the gateway sees a
proof, never a leaf). Pay from a fresh address if that matters to you.

**I want to stake** (Sepolia ETH; a refundable bond, `bondFor(8)` 0.001 ETH, `bondFor(32)` 0.004 ETH):

```bash
rgoe enroll --limit 8                                            # or --limit 32
rgoe register-member <commitment> --limit 8 --network sepolia    # posts the tier's bond
RGOE_NETWORK=sepolia rgoe client --secret <hex> --limit 8
```

Over-spend your tier's per-epoch budget and the gateway reconstructs your secret and slashes
the bond (a paid leaf is zeroed instead). Your wallet and your commitment are linked on chain.

**Which gateways you use.** `RGOE_LEAF_SOURCE=auto|invited|staked|paid` (default `auto`: the
set that holds your leaf) and the client only picks gateways whose signed `admits` include
that source (a gateway advertising no policy is assumed to admit every path during the
rollout). `--max-anon` (`RGOE_MAX_ANON=1`) goes further: it uses only gateways whose signed
`admits` is exactly `invited`, so a gateway that also sells or stakes access, or advertises no
policy, is refused, and it refuses to run at all with a paid or staked leaf (those paths leave
an on-chain footprint, so "max anon" would be a lie). On today's fleet it refuses both gateways,
naming each one's policy. Order of the paths, most to least anonymous: invited, staked, paid.

**The Rust binary** (`rgoe-0.1.1-<target>-live`, no Node, no tor daemon; the default
non-live binary verifies, selects and fetches directories but does not egress):

```bash
RGOE_SECRET=<hex> rgoe identity --out identity.json              # JS CLI, once: {identitySecret, leaf}
rgoe leaves --contract 0x4e8C2Bf5d3c5454A04837401095fce2646484111 --network sepolia --out members.json   # a paid or staked leaf; invited = group/members.json
./rgoe-0.1.1-<target>-live egress --bootnode-onion kssrk54kb5kngr4jjdzjouecwjh5ayzbzhamwmvju4kz63vno7hy4uyd.onion \
  --signer d79f78c369bd9c7b74575eae0c5068e6921f90bfdc97d43af9adc0039f953a73 \
  --identity identity.json --members members.json --target api.ipify.org:443
```

Member page: [`docs/JOIN.md`](docs/JOIN.md); walkthrough: [`docs/QUICKSTART.md`](docs/QUICKSTART.md);
every command: [`docs/CLI.md`](docs/CLI.md).

## Run one

**One command on a fresh Ubuntu 24.04 box** installs Tor + Node, mints the onions, starts
bootnode + gateway + heartbeat as systemd units, and prints the bootnode onion, its pinned
signer, and the client command to hand out:

```bash
curl -fsSL https://raw.githubusercontent.com/dmarzzz/reputation-gated-onion-egress/main/bootnode/deploy/bootstrap.sh | sudo bash
```

A provider decides three things, all env vars on that line
([`bootnode/deploy/README.md`](bootnode/deploy/README.md), [`docs/CONFIG.md`](docs/CONFIG.md)):

- **What you admit.** `RGOE_ADMIT=invited[,staked][,paid]`, default `invited` even when
  `RGOE_NETWORK` supplies the contracts (opt in explicitly). `staked` needs
  `RGOE_GROUP_CONTRACT`, `paid` needs `RGOE_PAID_ACCESS_CONTRACT`; a missing one fails closed
  at startup. The gateway trusts the union of the roots you list and advertises `admits` in its
  signed caps, so clients can filter. `RGOE_ROOTS` is a deprecated alias.
- **What you sell.** `RGOE_REGISTRAR=1` runs a 402 registrar on this box (an extra onion port,
  8878) and `RGOE_PAY_PROTOCOLS=x402,mpp` picks the rails (any non-empty subset; default both).
  Companions: `paid` in `RGOE_ADMIT` (admit what you sell), `RGOE_PAID_ACCESS_CONTRACT`,
  `RGOE_PAY_ASSET`, `RGOE_PAY_PRICES`, `RGOE_RPC_URL`; the operator key is a secret drop-in,
  never a tunable. On a gateway-only box the registrar rides the gateway onion. You sell on
  your own terms; the fleet's other gateways decide separately whether to admit paid leaves.
- **Where and how you read the chain.** `RGOE_GATEWAY_REGION=na|eu|…` goes into the signed
  caps; `RGOE_HELIOS=1` (with `staked` admitted) anchors the root read to the beacon sync
  committee so the RPC can withhold but not lie ([`docs/LIGHT-CLIENT.md`](docs/LIGHT-CLIENT.md)).

`RGOE_BOOTNODE_ONION=<onion>` makes it a gateway-only box that joins an existing bootnode
(how gateway-2 was added; the live bootnode admits staked operators, so joining it means
`rgoe register-gateway` first, [`docs/OPERATOR.md`](docs/OPERATOR.md) §2). `RGOE_ADMISSION=stake`
makes your own bootnode require the same bond.

**The 30-second local loop** (one box, each line its own terminal, a local tor daemon):

```bash
rgoe keygen tor/hs-bootnode           # mint an onion identity
rgoe bootnode --admission open        # discovery bootnode (its own onion service)
rgoe gateway                          # a reputation-gated gateway (RGOE_ADMIT=invited)
rgoe heartbeat --bootnode <onion>     # keep the gateway announced
rgoe enroll                           # a member identity (prints RGOE_SECRET)
rgoe client --secret <hex> --bootnode <onion> --dir-signer <signer-pubkey>
```

Watch the gate drop non-members with `node scripts/probe.mjs {noproof|garbage|wronggroup}`.

## How it works

The gate is an application-layer protocol on top of Tor, not a Tor modification. Tor cannot
carry a reputation proof natively (cells are opaque, v3 client-auth is a static linkable
allowlist), but onion services give the part that matters: each gateway is a `.onion` reached
by rendezvous, so there is no exit node and the gateway never learns the client IP.

```
  curl / SearXNG / your agent
        |
        v
  client ──── 1. pull the live gateway set from the bootnode (over Tor), verify it
        |     2. keep the gateways whose signed `admits` cover my leaf source
        |     3. build ONE RLN membership proof for this request (fresh per-request nullifier)
        |     4. pick a gateway (weighted rotation + failover)
        |  SOCKS to Tor, no exit node
        v
  Tor rendezvous  (3 + 3 hops; client IP never revealed to the gateway)
        |
        v
  gateway.onion ── verify RLN proof · root in the union it admits (invited ∪ staked ∪ paid),
        |          within the freshness window? · nullifier fresh?
        |          a 2nd distinct signal on one nullifier reconstructs the secret and SLASHES
        v
  clean egress IP ──> destination   (TCP CONNECT :443 only; TLS stays end to end)
```

- **The proof is real RLN.** The set is a [Semaphore](https://semaphore.pse.dev/) /
  [RLN](https://rate-limiting-nullifier.github.io/rln-docs/) group; each request carries a
  fresh nullifier and a Shamir share inside one circom-rln Groth16 proof (`lib/rln.mjs`,
  `circuits/rln/`). One share per slot egresses; a second distinct signal on the same
  nullifier is a provable over-spend, so the gateway reconstructs the identity secret and
  slashes on whichever contract holds the leaf (`gateway/gateway.mjs:makeRoutingSlasher`).
  Requests are mutually unlinkable, even to the gateway. A member's per-epoch budget is a tier
  baked into its leaf (`Poseidon2(Poseidon1(secret), limit)`, 8 or 32), proven in the same
  circuit and invisible on the wire ([ADR 0006](docs/adr/0006-reputation-tiers.md)).
- **The root is a union of on-chain sets.** Members self-enroll (only a commitment leaves the
  machine). A gateway reads one root per source it admits, `group/members.json` (invited),
  `StakedReputationSet` (staked, `contracts/StakedReputationSet.sol`) and `PaidAccessSet`
  (paid, `contracts/PaidAccessSet.sol`, [ADR 0007](docs/adr/0007-paid-access.md)), through a
  `RootProvider` (`lib/root-provider.mjs`: node, or an EIP-1186 light client, optionally
  Helios-anchored) and trusts their union. `GatewayRegistry` (`contracts/GatewayRegistry.sol`)
  holds operator bonds; the live bootnode admits staked operators only. Addresses:
  [`network/sepolia/contracts.json`](network/sepolia/contracts.json).
- **Payment is a leaf, not a token.** `rgoe pay` speaks HTTP 402 in x402 v2 or MPP to the
  provider's registrar (`payments/registrar.mjs`), signs one EIP-3009 authorization, the
  operator settles it and inserts the commitment; egress is the same RLN proof
  ([`docs/PAYMENTS.md`](docs/PAYMENTS.md)).
- **The fleet is discovered live.** Gateways heartbeat to a bootnode (`bootnode/`) that
  serves a signed directory with per-gateway signed caps (`admits`, `pay`, region); the client
  pulls it over Tor, verifies it, re-derives each onion's key, keeps a last-known-good copy,
  and rotates per request. The onion is never on chain; the bootnode is a cache, not a trust
  root ([`docs/BOOTNODE.md`](docs/BOOTNODE.md), [ADR 0002](docs/adr/0002-onion-never-on-chain.md),
  [ADR 0003](docs/adr/0003-bootnode-is-a-cache-not-a-trust-root.md)).

## What is and is not anonymous

The proof hides the leaf; the request hides the IP. What differs is how you got the leaf.

| path | on-chain footprint | who can link what | default admitted? |
|---|---|---|---|
| invited | none | the operator knows it handed you a secret; nobody can tell which requests are yours | yes (`RGOE_ADMIT=invited`); live fleet: both gateways |
| staked | `register(commitment, limit)` from your wallet, `bondFor(limit)` posted | wallet ↔ commitment ↔ tier bucket, public; requests still unlinkable to the leaf | opt-in (`staked`); live fleet: both gateways |
| paid | your address → operator transfer (tier price) and the operator's `insert(commitment, limit)` a block or two later | "this address bought from this operator" and the tier, public; the operator learns commitment ↔ payer; requests still unlinkable | opt-in (`paid`); live fleet: gateway-1 only |

Facts that hold for all three: the gateway sees a rendezvous circuit, never your IP; which
root a proof opens (invited / staked / paid) is a public signal, so your crowd is that set's
size (the paid set is warned below `RGOE_PAID_MIN_LEAVES`, never refused); TLS is end to end,
the gateway sees `host:443`. Prepaid access is trust in the operator: a valid proof the
operator refuses to honor, or a payment it never inserts, has no on-chain recourse, only
public evidence. Full ledger: [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) §4.14b, §5.

## Not done, and why it matters

- **No trusted-setup ceremony.** `circuits/rln/` is circom-rln's dev phase-2 (two hard-coded
  contributions, a fixed beacon); anyone can recompute the toxic waste and forge a membership
  proof under any root or an exit-auth proof against any bond. `testdata/zk-artifacts.lock.json`
  says so (`trust: "UNTRUSTED-TESTNET"`) and CI verifies the pins; the runbook is
  [`docs/CEREMONY.md`](docs/CEREMONY.md), the reasoning is
  [issue #6](https://github.com/dmarzzz/reputation-gated-onion-egress/issues/6).
- **No audit.** Trust boundaries, per-party threat model and review order:
  [`docs/AUDIT.md`](docs/AUDIT.md), [`docs/CONTRACTS-AUDIT.md`](docs/CONTRACTS-AUDIT.md),
  [`docs/adversarial-review.md`](docs/adversarial-review.md). `npm test` runs every
  `*selftest.mjs` plus the Foundry suite.
- **One operator, one provider.** Two regions, same AS14061; every asset is Sepolia testnet;
  onion PoW is off (`RGOE_ENABLE_POW=0`, most client tors lack the module), so rendezvous DoS
  is unmitigated; gateway slashing is owner-gated ([ADR 0005](docs/adr/0005-governed-gateway-slash.md)).
- **Why bother.** [`docs/exit-blocking-benchmark.md`](docs/exit-blocking-benchmark.md): over 51
  Tor exits, web destinations blocked 315 of 1,812 requests (17%), and 98% of those blocks were
  403 / CAPTCHA / JS challenge, 2% rate limits; search engines blocked 2,217 of 6,024 (37%),
  62% reputation, 38% rate limit. Sites behind commercial anti-bot vendors block Tor in the
  90 to 100 percent range, the open web roughly zero. Clean IPs stay clean by being gated and
  scarce; this gates on membership instead of identity.

## Docs

| Doc | What it is |
|-----|------------|
| [`docs/QUICKSTART.md`](docs/QUICKSTART.md), [`docs/JOIN.md`](docs/JOIN.md) | Join the live fleet (invited / buy / stake), the local loop, the droplet; the member page |
| [`docs/CLI.md`](docs/CLI.md), [`docs/CONFIG.md`](docs/CONFIG.md) | Every `rgoe` command; every `RGOE_*` variable and default |
| [`docs/OPERATOR.md`](docs/OPERATOR.md), [`docs/INCIDENT.md`](docs/INCIDENT.md), [`docs/SLO.md`](docs/SLO.md) | Running a gateway or bootnode; incident playbook; service-level objectives |
| [`docs/BACKUP.md`](docs/BACKUP.md), [`docs/ONION-IDENTITY.md`](docs/ONION-IDENTITY.md), [`docs/TOR-HARDENING.md`](docs/TOR-HARDENING.md) | Encrypted key backup/restore; onion continuity; hardening the Tor layer |
| [`docs/GO-LIVE-LOG-2026-08-17.md`](docs/GO-LIVE-LOG-2026-08-17.md), [`docs/GO-LIVE.md`](docs/GO-LIVE.md) | The go-live execution record and the runbook it executed |
| [`network/sepolia/README.md`](network/sepolia/README.md) | The live Sepolia record: `contracts.json`, `bootnode.json`, the signed directory |
| [`docs/ONCHAIN.md`](docs/ONCHAIN.md), [`docs/ONCHAIN-DEPLOY.md`](docs/ONCHAIN-DEPLOY.md) | On-chain admission design (staked set, gateway registry, root provider); deploying it |
| [`docs/LIGHT-CLIENT.md`](docs/LIGHT-CLIENT.md) | Light-client root reads and the Helios sync-committee anchor, with live receipts |
| [`docs/PAYMENTS.md`](docs/PAYMENTS.md), [`docs/PROTOCOL.md`](docs/PROTOCOL.md) (+ `PROTOCOL.html`) | The 402 rails as shipped and the leak ledger; the anonymous-paid-access design write-up |
| [`docs/BOOTNODE.md`](docs/BOOTNODE.md), [`docs/FLEET.md`](docs/FLEET.md) | Live discovery (announce, signed directory, trust boundary); per-request selection and fleet budget |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md), [`docs/AUDIT.md`](docs/AUDIT.md), [`docs/CONTRACTS-AUDIT.md`](docs/CONTRACTS-AUDIT.md), [`docs/adversarial-review.md`](docs/adversarial-review.md) | Threat model; trust boundaries, test inventory, review order; contract invariants; per-party worst case |
| [`docs/CEREMONY.md`](docs/CEREMONY.md) | Trusted-setup runbook (not run) |
| [`docs/PROTOCOL-API.md`](docs/PROTOCOL-API.md), [`docs/PROTOCOL-VERSIONING.md`](docs/PROTOCOL-VERSIONING.md), [`docs/RECEIPTS.md`](docs/RECEIPTS.md) | Wire formats + bootnode HTTP API; artifact-version negotiation; signed egress receipts |
| [`docs/CLIENTS.md`](docs/CLIENTS.md), [`docs/SDK.md`](docs/SDK.md), [`docs/ADAPTERS.md`](docs/ADAPTERS.md) | Client modes, the `RgoeClient` SDK, routing tools and agents through the fleet |
| [`docs/adr/`](docs/adr/) | Decision records: client language, onion never on chain, bootnode is a cache, RLN, governed slash, tiers, paid access, [0008](docs/adr/0008-per-gateway-admission-and-payment-choice.md) per-gateway admission and payment choice |
| [`docs/exit-blocking-benchmark.md`](docs/exit-blocking-benchmark.md), [`docs/residential-proxies.md`](docs/residential-proxies.md), [`docs/residential-proxy-providers.md`](docs/residential-proxy-providers.md) | The benchmark; what residential proxies do to your privacy; a provider taxonomy |
| [`docs/MUTATION-TESTING.md`](docs/MUTATION-TESTING.md) | Mutation-testing setup and surviving mutants |
| [`docs/SHIP-PLAN.md`](docs/SHIP-PLAN.md), [`docs/ROADMAP.md`](docs/ROADMAP.md) | The shipping backlog and release gates; the forward roadmap |
| [`docs/ROADMAP-v1.md`](docs/ROADMAP-v1.md), [`docs/NEXT-VERSION.md`](docs/NEXT-VERSION.md), [`docs/RLN-MIGRATION.md`](docs/RLN-MIGRATION.md) | Historical designs (milestones 1 to 5, next-version spec, RLN migration); what they specified is built |
| [`docs/STATUS.md`](docs/STATUS.md), [`docs/REPORT.md`](docs/REPORT.md), [`docs/DEPLOY.md`](docs/DEPLOY.md), [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), [`docs/walkthrough.html`](docs/walkthrough.html) | Historical: the June 2026 single-gateway PoC status/report/deploy guides, the July fleet deployment record, the request walkthrough |
| [`docs/post/`](docs/post/) | The published write-up (HTML + figures), plus [`JOIN.md`](docs/post/JOIN.md) and [`RUN-A-GATEWAY.md`](docs/post/RUN-A-GATEWAY.md) |
| [`SECURITY.md`](SECURITY.md), [`CONTRIBUTING.md`](CONTRIBUTING.md) | Security policy and how to report; tests and house rules |

## Layout

| Path | What it is |
|------|------------|
| `bin/rgoe.mjs` | The unified CLI (every role, `--flag` → `RGOE_*` env) |
| `lib/rln.mjs`, `circuits/rln/` | circom-rln Groth16: prove, verify, reconstruct, slash |
| `lib/directory.mjs`, `lib/root-provider.mjs`, `lib/helios-root.mjs` | Signed fleet directory + caps; on-chain root read (node / light client); Helios anchor |
| `lib/gateway-registry.mjs`, `lib/zk-artifacts.mjs` | Gateway-stake verifier; ZK artifact-set lock + negotiation |
| `contracts/` | `StakedReputationSet.sol`, `PaidAccessSet.sol`, `GatewayRegistry.sol` |
| `gateway/gateway.mjs` | Onion-side egress: admit set, verify, dedup/slash, tunnel, drop |
| `bootnode/` | Discovery server, announce, keygen, heartbeat, fetch; `deploy/` = the one-command droplet |
| `client/` | The fleet client library (`rgoe-client.mjs`), HTTP-CONNECT proxy (`shim.mjs`), selection |
| `payments/` | The 402 registrar, both wire dialects, EIP-3009 typed data, test-asset deploy |
| `group/` | Self-enrollment, `rgoe pay`, `rgoe leaves`, on-chain register (member / gateway), the committed `members.json` |
| `network/` | Committed deployment records per network; `RGOE_NETWORK` reads them |
| `rust/` | The distributable client: `rgoe-proto` (wire), `rgoe-rln` (prover + tree), `rgoe-client` (embedded arti, `-live`) |
| `test/`, `testdata/`, `scripts/test-all.mjs` | Foundry suite + cross-module selftests; golden vectors + artifact lock; the audit entrypoint |
| `docker/`, `monitoring/`, `examples/`, `web/`, `smithers/` | Local container fleet; Prometheus/Grafana; agent examples; fleet map page; the roadmap as a Smithers workflow |
