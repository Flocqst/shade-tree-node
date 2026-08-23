![A sparse grove casting a patch of shade](assets/shade-tree-banner.webp)

# Shade Tree

**A small grove for local AI.**

[![CI][ci-badge]][ci-url]
[![real Tor E2E][e2e-badge]][e2e-url]
[![release][release-badge]][release-url]
[![MIT][license-badge]][license-url]

Shade Tree has two ways to take part:

- **Running an agent? Run the local proxy beside it.** Launch the agent through
  that proxy to route only that process.
- **Providing cover for agents? Run a Shade Tree node.** The node supplies the
  destination-facing egress, so destinations see its public IP.

The two sides meet through access-gated [Tor onion services][tor], one admitted
HTTPS tunnel at a time.

[Site][site] · [Research note][research-note] · [Docs](docs/README.md) ·
[Run a node](docs/OPERATOR.md) · [Protocol](docs/PROTOCOL.md) · [Security](SECURITY.md)

> [!WARNING]
> **Research preview.** The code has not been audited and the included ZK
> artifacts are development artifacts. The checked-in Sepolia records describe
> the pre-v4 deployment and are not a live-availability promise. Do not rely on
> this preview for real funds or security-sensitive anonymity.

## The shape

```text
agent ──HTTP CONNECT──> local proxy ──Tor rendezvous──> node.onion ──TLS──> destination
                         one proof admits one tunnel      destination sees the node IP
```

The client presents a rate-limited proof of membership before a node opens a
`CONNECT host:443` tunnel. The node can verify that the proof belongs to an
admitted set without receiving an account or stable identity. Tor carries the
client-to-node leg; TLS remains end to end between the local application and
the destination.

The unit is a **tunnel**, not an HTTP request. HTTP/2 and keep-alive may carry
many application requests inside one admitted tunnel. See the
[protocol](docs/PROTOCOL.md) and [threat model](docs/THREAT-MODEL.md) for the
precise guarantees.

## Run the proxy for an agent

You need Node.js, a local Tor SOCKS port, a member secret, and either a gateway
onion or a signed directory from an operator.

```bash
git clone https://github.com/dmarzzz/shade-tree-node.git
cd shade-tree-node
npm ci
npm link
shade-tree doctor
```

Start Tor and the local proxy:

```bash
bash scripts/start-tor-client.sh
SHADE_TREE_SECRET=<hex> SHADE_TREE_ONION=<gateway.onion> \
  shade-tree client --tor-port 9260
```

Then scope routing to one process:

```bash
shade-tree run -- hermes
shade-tree run -- curl https://api.ipify.org
```

`shade-tree run` checks that the local proxy is reachable, sets standard upper-
and lowercase proxy variables only for the child process, keeps loopback hosts
outside the proxy, and refuses to launch if the proxy is unavailable. That
makes it a small integration surface for Hermes and other proxy-aware agents
while local model servers such as Ollama or vLLM can remain on loopback.

Software that ignores standard proxy environment variables needs an explicit
HTTP proxy setting pointed at `http://127.0.0.1:8888`. Every mapped
configuration flag also has a `SHADE_TREE_*` environment-variable form. See [CLI](docs/CLI.md),
[configuration](docs/CONFIG.md), and the [JavaScript SDK](docs/SDK.md).

## Provide cover: run a node

A Shade Tree node is a Tor onion service plus a proof-gated HTTPS tunnel. Its
public IP becomes the destination-facing egress IP, so abuse complaints and IP
reputation land with the operator.

For a fresh Ubuntu 24.04 host:

```bash
curl -fsSL https://raw.githubusercontent.com/dmarzzz/shade-tree-node/main/bootnode/deploy/bootstrap.sh \
  | sudo bash
```

The bootstrap installs isolated `shade-tree-*` services, creates onion
identities, and prints the client configuration to share. Admission is
invited-only unless the operator explicitly enables another set.

Running a client beside a GPU worker, local model server, or Ethereum validator
is straightforward. Running the **egress node** on that same public IP is a
separate risk decision: use a dedicated egress IP when possible, keep validator
keys and authenticated RPC endpoints out of the node, and preserve the
loopback/onion-only listener boundaries. The [operator guide](docs/OPERATOR.md)
and [deployment guide](docs/DEPLOYMENT.md) cover both systemd and Compose.

## Boundaries

- The destination sees the node's public IP and can block it.
- The node sees the destination hostname, port, timing, and byte counts. With
  HTTPS it does not terminate application TLS.
- Tor does not prevent an observer who can watch both ends from correlating
  traffic timing.
- Staked or paid admission can create public onchain links at enrollment even
  when individual tunnel proofs do not reveal a leaf.
- A node may refuse a valid proof. The protocol does not force availability or
  honest forwarding.
- Co-locating independent services does not merge their trust boundaries.

## Repository map

| Path | Role |
| --- | --- |
| [`client/`](client/) | Local CONNECT proxy, discovery, and node rotation |
| [`gateway/`](gateway/) | Proof gate and destination tunnel |
| [`bootnode/`](bootnode/) | Signed node discovery and operator tooling |
| [`rust/`](rust/) | Rust client, protocol crate, and RLN prover |
| [`contracts/`](contracts/) | Optional Sepolia membership and operator sets |
| [`network/`](network/) | Signed test-network records |

## Develop

```bash
npm ci
npm test
(cd rust && cargo test --workspace)
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the test layout and change policy.
Breaking changes from the earlier prototype are recorded in
[the migration guide](docs/MIGRATING-TO-SHADE-TREE.md) and [changelog](CHANGELOG.md).
Security reports belong in the private channel described in
[SECURITY.md](SECURITY.md).

Shade Tree is open source under the [MIT license](LICENSE).

[ci-badge]: https://github.com/dmarzzz/shade-tree-node/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/dmarzzz/shade-tree-node/actions/workflows/ci.yml
[e2e-badge]: https://github.com/dmarzzz/shade-tree-node/actions/workflows/real-tor-e2e.yml/badge.svg
[e2e-url]: https://github.com/dmarzzz/shade-tree-node/actions/workflows/real-tor-e2e.yml
[release-badge]: https://img.shields.io/github/v/release/dmarzzz/shade-tree-node
[release-url]: https://github.com/dmarzzz/shade-tree-node/releases/latest
[license-badge]: https://img.shields.io/badge/license-MIT-59624f.svg
[license-url]: LICENSE
[site]: https://shade-tree-node.vercel.app
[research-note]: https://shade-tree-node.vercel.app/research/
[tor]: https://www.torproject.org/
