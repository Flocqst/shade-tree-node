# Docs index

Every document in `docs/`, one line each, grouped by what you are trying to do. The
[README](../README.md) is the short front door; [`OVERVIEW.md`](OVERVIEW.md) is the long one.
A browsable HTML build of all of this: `node docs-site/build.mjs` ([`docs-site/`](../docs-site/README.md)).

## Start here

| Doc | What it is |
|-----|------------|
| [`OVERVIEW.md`](OVERVIEW.md) | How a request flows, the anonymity ledger per admission path, what is not done and why it matters, the exit-blocking numbers, the repo layout |
| [`QUICKSTART.md`](QUICKSTART.md) | Path A join the live fleet (invited / buy / stake), Path B the local loop, Path C your own droplet; every install path |
| [`JOIN.md`](JOIN.md) | The member page: get a leaf, run the client, what is public per path |
| [`CLI.md`](CLI.md) | Every `rgoe` command with its module and an example |
| [`CONFIG.md`](CONFIG.md) | Every `RGOE_*` variable, its default, who reads it, its `--flag` |
| [`STATUS.md`](STATUS.md) | Historical: the June 2026 single-gateway PoC status (the README "Status" is current) |

## Use it (clients, SDK, agents)

| Doc | What it is |
|-----|------------|
| [`CLIENTS.md`](CLIENTS.md) | Client modes: the local proxy (shim) vs the library, and a planned no-tooling path; leaf source and admission filtering |
| [`SDK.md`](SDK.md) | The `RgoeClient` SDK surface (`package.json` exports) |
| [`ADAPTERS.md`](ADAPTERS.md) | Routing tools and agents (curl, SearXNG, browsers, LLM agents) through the local proxy |
| [`RECEIPTS.md`](RECEIPTS.md) | Signed egress success receipts: proof a gateway actually served traffic, with no linkability channel |
| [`PROTOCOL-VERSIONING.md`](PROTOCOL-VERSIONING.md) | Envelope version negotiation (v3-with-nonce today) without a flag day; garbage versions rejected with a reason |
| [`../rust/INSTALL.md`](../rust/INSTALL.md) | The static Rust client: which binary for which platform, verify the checksum, `egress` with the `-live` build |

## Run it (gateway, bootnode, fleet)

| Doc | What it is |
|-----|------------|
| [`OPERATOR.md`](OPERATOR.md) | Deploy a gateway + bootnode, join the fleet as a new operator, day-2 health and logs, keys, slash response, rotate or retire, config reference, what you admit and what you sell |
| [`../bootnode/deploy/README.md`](../bootnode/deploy/README.md) | The one-command droplet bootstrap and every tunable it accepts |
| [`BOOTNODE.md`](BOOTNODE.md) | Live discovery: announce, signed directory, per-gateway signed caps, the trust boundary |
| [`FLEET.md`](FLEET.md) | Per-request gateway selection, weights, failover, fleet budget |
| [`INCIDENT.md`](INCIDENT.md) | Incident playbook |
| [`SLO.md`](SLO.md) | Service-level objectives and error budget (proposals, recalibrated on live data) |
| [`BACKUP.md`](BACKUP.md) | Encrypted key backup and restore |
| [`ONION-IDENTITY.md`](ONION-IDENTITY.md) | Onion continuity: bring a gateway or bootnode back on the same `.onion` (verify before cutover, restore) |
| [`TOR-HARDENING.md`](TOR-HARDENING.md) | Hardening the Tor layer under a gateway or bootnode |
| [`LIGHT-CLIENT.md`](LIGHT-CLIENT.md) | Light-client root reads and the Helios sync-committee anchor (`RGOE_HELIOS=1`), with live receipts |
| [`../monitoring/README.md`](../monitoring/README.md) | Grafana dashboard + Prometheus alert rules on the real metric names |
| [`../docker/README.md`](../docker/README.md) | Single image and the local compose fleet |
| [`GO-LIVE.md`](GO-LIVE.md), [`GO-LIVE-LOG-2026-08-17.md`](GO-LIVE-LOG-2026-08-17.md) | The go-live runbook and the record of executing it |
| [`../network/README.md`](../network/README.md), [`../network/sepolia/`](../network/sepolia/README.md) | The committed per-network record; the live Sepolia deployment (`contracts.json`, `bootnode.json`, signed directory, integration reports) |

## Design and security

| Doc | What it is |
|-----|------------|
| [`THREAT-MODEL.md`](THREAT-MODEL.md) | Assets, adversaries, trust assumptions per party, every property and where it is enforced, residual risks (section 5), audit checklist |
| [`AUDIT.md`](AUDIT.md) | Trust boundaries, test inventory, suggested review order |
| [`CONTRACTS-AUDIT.md`](CONTRACTS-AUDIT.md) | Contract invariants and the Foundry evidence |
| [`adversarial-review.md`](adversarial-review.md) | Per-party worst case |
| [`CEREMONY.md`](CEREMONY.md) | The trusted-setup runbook (not run; [issue #6](https://github.com/dmarzzz/reputation-gated-onion-egress/issues/6)) |
| [`PROTOCOL.md`](PROTOCOL.md) (+ [`PROTOCOL.html`](PROTOCOL.html)) | The anonymous-paid-access design write-up |
| [`PROTOCOL-API.md`](PROTOCOL-API.md) | Wire formats and the bootnode HTTP API |
| [`MUTATION-TESTING.md`](MUTATION-TESTING.md) | Mutation-testing setup and surviving mutants |
| [`adr/`](adr/README.md) | Decision records: context, decision, consequences, rejected alternatives |
| [`adr/0001`](adr/0001-client-language.md) | JS stays the reference implementation; the Rust client is the distributable, kept honest by conformance vectors |
| [`adr/0002`](adr/0002-onion-never-on-chain.md) | The onion address is never on chain; stake is keyed by operator address |
| [`adr/0003`](adr/0003-bootnode-is-a-cache-not-a-trust-root.md) | The bootnode is a cache, not a trust root: entries are self-authenticating |
| [`adr/0004`](adr/0004-rln-over-slot-scheme.md) | Real RLN over the public-slot scheme |
| [`adr/0005`](adr/0005-governed-gateway-slash.md) | Member slashing permissionless, gateway slashing governed |
| [`adr/0006`](adr/0006-reputation-tiers.md) | Reputation tiers are per-leaf `userMessageLimit`s in one tree |
| [`adr/0007`](adr/0007-paid-access.md) | Paid access is an operator-inserted leaf in a second on-chain tree, redeemed with the same proof |
| [`adr/0008`](adr/0008-per-gateway-admission-and-payment-choice.md) | Each provider chooses what it admits and sells; the default is maximum anonymity |
| [`../SECURITY.md`](../SECURITY.md), [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | Security policy and how to report; tests and house rules |

## On chain

| Doc | What it is |
|-----|------------|
| [`ONCHAIN.md`](ONCHAIN.md) | Staked reputation set, gateway registry, root provider: the design |
| [`ONCHAIN-DEPLOY.md`](ONCHAIN-DEPLOY.md) | Deploying the contracts and recording the deployment |
| [`../contracts/README.md`](../contracts/README.md) | The contract map (`StakedReputationSet`, `PaidAccessSet`, `GatewayRegistry`, verifiers) |

## Payments

| Doc | What it is |
|-----|------------|
| [`PAYMENTS.md`](PAYMENTS.md) | The HTTP 402 rails as shipped (x402 v2, MPP, EIP-3009), the leak ledger, the design of record |
| [`adr/0007`](adr/0007-paid-access.md), [`adr/0008`](adr/0008-per-gateway-admission-and-payment-choice.md) | Paid access is an operator-inserted leaf; each provider chooses what it admits and sells |

## Background and history

| Doc | What it is |
|-----|------------|
| [`exit-blocking-benchmark.md`](exit-blocking-benchmark.md) | The benchmark: 51 exits, web and search destinations, block rates and reasons |
| [`residential-proxies.md`](residential-proxies.md), [`residential-proxy-providers.md`](residential-proxy-providers.md) | What residential proxies do to your privacy; a provider taxonomy |
| [`post/`](post/) | The published write-up ([`index.html`](post/index.html) + figures), plus [`JOIN.md`](post/JOIN.md) and [`RUN-A-GATEWAY.md`](post/RUN-A-GATEWAY.md) |
| [`SHIP-PLAN.md`](SHIP-PLAN.md), [`ROADMAP.md`](ROADMAP.md) | The shipping backlog and release gates; the forward roadmap |
| [`ROADMAP-v1.md`](ROADMAP-v1.md), [`NEXT-VERSION.md`](NEXT-VERSION.md), [`RLN-MIGRATION.md`](RLN-MIGRATION.md) | Historical designs (milestones 1 to 5, next-version spec, RLN migration); what they specified is built |
| [`REPORT.md`](REPORT.md), [`DEPLOY.md`](DEPLOY.md), [`DEPLOYMENT.md`](DEPLOYMENT.md), [`walkthrough.html`](walkthrough.html) | Historical: the June 2026 PoC report and deploy guide, the July fleet deployment record, the request walkthrough |
