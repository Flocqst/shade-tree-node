# reputation-gated onion egress

[![ci][ci-badge]][ci-url]
[![real-tor-e2e][e2e-badge]][e2e-url]
[![release][release-badge]][release-url]
[![license: MIT][license-badge]][license-url]

**Clean-IP egress from Tor for anyone who can prove, in zero knowledge, that a gateway trusts them.**

**[Install](#install)**
| [Docs](docs/README.md)
| [Run a gateway](docs/OPERATOR.md)
| [Buy access](docs/PAYMENTS.md)
| [Write-up](https://reputation-gated-egress.vercel.app)
| [Security](SECURITY.md)

> [!WARNING]
> Testnet only (Sepolia), one operator on one cloud provider. The ZK artifacts are the untrusted
> dev set until the ceremony runs ([issue #6][issue-6], [`docs/CEREMONY.md`](docs/CEREMONY.md)).
> Unaudited. Do not rely on it for real anonymity or real funds.

## What is it?

Tor exit IPs are a public list, so sites block them (17% of web and 37% of search requests in
the [exit-blocking benchmark](docs/exit-blocking-benchmark.md)). This project puts the egress
behind onion services instead: each gateway is a `.onion` reached by rendezvous (no exit
node, it never sees your IP) that tunnels `CONNECT host:443` from its own clean IP, and it
admits a request only with one [RLN][rln] membership proof per request. The proof hides
which leaf you are, a fresh nullifier keeps requests unlinkable, and a second spend on one
nullifier reconstructs your secret and slashes you. Gateways run as a fleet discovered
through a bootnode, membership rooted on Sepolia; each provider chooses which set it admits
(invited, staked, paid) and whether it sells access over HTTP 402. It is **not** a Tor
modification and **not** a VPN: an application-layer gate on onion services, one CLI (`rgoe`).

```
client ──SOCKS──> Tor rendezvous (no exit node) ──> gateway.onion ──CONNECT host:443──> destination
one RLN proof per request (leaf hidden, fresh nullifier)   verify against admitted roots, then tunnel
```

Full diagram, the anonymity table, the numbers, the layout: [`docs/OVERVIEW.md`](docs/OVERVIEW.md).

## Install

```bash
git clone https://github.com/dmarzzz/reputation-gated-onion-egress && cd reputation-gated-onion-egress
npm install && npm link          # puts `rgoe` on PATH; `rgoe doctor` checks node, tor, deps, keys
```

A static Rust client (`rgoe-0.1.1-<target>`, plus `-live` with embedded Tor + prover) is on
[Releases][release-url]; see [`rust/INSTALL.md`](rust/INSTALL.md). Every install path:
[`docs/QUICKSTART.md`](docs/QUICKSTART.md).

## Use it

You need a Tor SOCKS port (`bash scripts/start-tor-client.sh` gives you 9260, pass `--tor-port 9260`;
a system tor is 9050). Every `--flag` is also an `RGOE_*` env var. `RGOE_NETWORK=sepolia` reads the
live fleet's onion, signer and contracts from [`network/sepolia/`](network/sepolia/README.md).

**I was invited** (someone handed you an `RGOE_SECRET`):

```bash
RGOE_SECRET=<hex> RGOE_NETWORK=sepolia rgoe client
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json   # returns a gateway's IP, not yours
```

**Buy access** (a wallet holding the Sepolia settle asset; no ETH, no gas):

```bash
rgoe enroll                                                       # secret + commitment, locally; keep the secret
rgoe pay --network sepolia --limit 8 --protocol x402 --key-file buyer.key --secret-file ./.secret   # or --protocol mpp
RGOE_NETWORK=sepolia rgoe client --secret <hex> --limit 8         # tier 8 or 32
```

Public on chain: your address paid this operator this tier's price, and the operator
inserted a commitment. Your requests are not. `--dry-run` shows the exact authorization first.

**Stake** (Sepolia ETH; a refundable bond, `bondFor(8)` 0.001 ETH):

```bash
rgoe enroll --limit 8
rgoe register-member <commitment> --limit 8 --network sepolia    # wallet <-> commitment is public
RGOE_NETWORK=sepolia rgoe client --secret <hex> --limit 8
```

`--max-anon` uses invited-only gateways and refuses to run with a staked or paid leaf.
Member page: [`docs/JOIN.md`](docs/JOIN.md); every command: [`docs/CLI.md`](docs/CLI.md).

## Run a gateway

Your box's IP is the egress: destinations see it and abuse complaints come to you. One command
on a fresh Ubuntu 24.04 box installs Tor + Node and starts bootnode + gateway + heartbeat as systemd units:

```bash
curl -fsSL https://raw.githubusercontent.com/dmarzzz/reputation-gated-onion-egress/main/bootnode/deploy/bootstrap.sh | sudo bash
```

Three provider decisions, all env vars on that line:

- **What you admit.** `RGOE_ADMIT=invited` (default, maximum anonymity); add `,staked` and/or
  `,paid`. A named path without its contract fails closed at startup.
- **What you sell.** `RGOE_REGISTRAR=1 RGOE_PAY_PROTOCOLS=x402,mpp` runs a 402 registrar on the
  box (needs `paid` in `RGOE_ADMIT`).
- **Whose fleet.** `RGOE_BOOTNODE_ONION=<onion>` makes it a gateway-only box that joins an
  existing bootnode (the live one admits staked operators: `rgoe register-gateway` first).

It prints the onion, the pinned signer and the client command to hand out. `systemctl status
rgoe-bootnode rgoe-gateway rgoe-heartbeat` and `rgoe doctor` check the box; `curl --socks5-hostname
127.0.0.1:9050 http://<bootnode-onion>/health` checks it over Tor. Full guide: [`docs/OPERATOR.md`](docs/OPERATOR.md);
every knob: [`docs/CONFIG.md`](docs/CONFIG.md).

## Status (2026-08-18)

- Live fleet on Sepolia since 2026-08-17: bootnode + 2 gateways (NYC1, SFO3), stake admission
  ([`docs/GO-LIVE-LOG-2026-08-17.md`](docs/GO-LIVE-LOG-2026-08-17.md)).
- Three admission paths: invited (`group/members.json`), staked (`StakedReputationSet`, tiers
  8/32), paid (`PaidAccessSet`); gateway-1 admits all three and sells, gateway-2 admits invited + staked.
- Payments live: x402 v2 and MPP, one EIP-3009 authorization, settled by the operator; test token today.
- [v0.1.1][release-url] static Rust client for 7 targets, `-live` for 3; Helios sync-committee
  anchor for the root read (`RGOE_HELIOS=1`, [`docs/LIGHT-CLIENT.md`](docs/LIGHT-CLIENT.md)).
- **Not done:** trusted-setup ceremony ([issue #6][issue-6]), audit, more than one
  provider/ASN, real USDC.

## What it does not protect against

- **End-to-end timing correlation.** Same limit as Tor: watch both ends and you can match them.
- **The gateway sees the destination.** `host:443` of every request, never the body (TLS is end to end).
- **Staked or paid admission is linkable on chain.** Wallet to commitment and tier bucket
  (staked); buyer to operator transfer plus the operator's insert (paid). Fund from a fresh
  address if that matters; requests stay unlinkable to the leaf.
- **A prepaid operator can refuse a valid proof.** No on-chain recourse, only public evidence.
- **Forged proofs until the ceremony.** The dev artifacts' toxic waste is recomputable.

Ledger: [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) (residual risks in section 5).

## For developers

```bash
npm install && npm test              # every *selftest.mjs + forge test
(cd rust && cargo test --workspace)  # the Rust client
```

House rules and test layout: [`CONTRIBUTING.md`](CONTRIBUTING.md). Wire formats and the bootnode
HTTP API: [`docs/PROTOCOL-API.md`](docs/PROTOCOL-API.md). Decisions: [`docs/adr/`](docs/adr/).

## Getting help

Start with the [docs index](docs/README.md); if it does not answer, open an
[issue](https://github.com/dmarzzz/reputation-gated-onion-egress/issues) (there is no chat channel).

## Contributing

Contributions are welcome; CI must pass and every change ships its tests. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

See [`SECURITY.md`](SECURITY.md).

## Acknowledgements

- [Semaphore][semaphore] and [RLN][rln] ([circom-rln][circom-rln]) for the membership proof and the slashing nullifier.
- [Tor][tor] and [arti][arti] for onion services and the embedded client in the Rust binary.
- [x402][x402] and [MPP][mpp] for the HTTP 402 rails; [Helios][helios] for the sync-committee anchor.

#### License

<sup>Licensed under the <a href="LICENSE">MIT license</a>.</sup>
<sub>Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion
in this repository by you shall be licensed as above, without any additional terms or conditions.</sub>

[ci-badge]: https://github.com/dmarzzz/reputation-gated-onion-egress/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/dmarzzz/reputation-gated-onion-egress/actions/workflows/ci.yml
[e2e-badge]: https://github.com/dmarzzz/reputation-gated-onion-egress/actions/workflows/real-tor-e2e.yml/badge.svg
[e2e-url]: https://github.com/dmarzzz/reputation-gated-onion-egress/actions/workflows/real-tor-e2e.yml
[release-badge]: https://img.shields.io/github/v/release/dmarzzz/reputation-gated-onion-egress
[release-url]: https://github.com/dmarzzz/reputation-gated-onion-egress/releases/tag/v0.1.1
[license-badge]: https://img.shields.io/badge/license-MIT-blue.svg
[license-url]: LICENSE
[issue-6]: https://github.com/dmarzzz/reputation-gated-onion-egress/issues/6
[rln]: https://rate-limiting-nullifier.github.io/rln-docs/
[semaphore]: https://semaphore.pse.dev/
[circom-rln]: https://github.com/Rate-Limiting-Nullifier/circom-rln
[tor]: https://www.torproject.org/
[arti]: https://gitlab.torproject.org/tpo/core/arti
[x402]: https://github.com/x402-foundation/x402
[mpp]: https://mpp.dev/
[helios]: https://github.com/a16z/helios
