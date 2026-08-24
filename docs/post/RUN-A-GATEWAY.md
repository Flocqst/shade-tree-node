# Run a Shade Tree node

You read the write-up. This is how you add an egress node to a Grove.

A **Shade Tree node** is the protocol gateway: a Tor onion service that verifies a member's
RLN proof and, only then, egresses TCP CONNECT to `:443`. The local **Proxy** is the protocol
client, and the **Elder Tree** is the discovery bootnode. Source paths, environment variables,
flags, and service units retain `gateway`, `client`, and `bootnode` where compatibility matters.

The node takes no inbound clearnet service port. Its application connection comes from the
local Tor service rather than carrying the Proxy's source IP. The node still sees the target,
timing, lifetime, and traffic volume. You supply the destination-facing public IP.

Status: research preview, unaudited, with testnet ZK artifacts. The software can be exercised
in a local or operator-configured v4 Grove, but this repository does not advertise a public
v4 service. The checked-in Sepolia records describe the incompatible pre-v4 research fleet.
Do not put sensitive traffic on it. See the repo README "Scope" and
[`../SHIP-PLAN.md`](../SHIP-PLAN.md).

## Prerequisites

- A fresh Ubuntu 24.04 box (for the one-command path), or Node.js 18+ and a local Tor
  daemon (for the manual path). `npm install && npm link` puts `shade-tree` on PATH; `shade-tree
  doctor` checks Node.js, Tor, dependencies, and keys.
- An existing Elder Tree onion, if you are adding a node to a Grove someone else
  runs. `bootstrap.sh` stands up its own internal bootnode + gateway services together.

## One command on a droplet

> **Blocked today.** [Issue #73](https://github.com/dmarzzz/shade-tree-node/issues/73)
> leaves private and link-local destinations reachable through the default node policy.
> Do not run this public-host path until that guard and the current
> [deployment gates](../DEPLOYMENT-PLAN.md) are closed.

After those gates clear, the intended target is a fresh Ubuntu 24.04 host:

```bash
ssh root@<droplet-ip>
curl -fsSL https://raw.githubusercontent.com/dmarzzz/shade-tree-node/main/bootnode/deploy/bootstrap.sh | sudo bash
```

It installs Tor (official repo, so onion PoW is available) and Node.js, mints the onion
identities, starts `shade-tree-bootnode` + `shade-tree-gateway` + `shade-tree-heartbeat` as
`Restart=always` systemd units, and prints the Elder Tree onion, its pinned signer, the
node onion, and the Proxy command. Idempotent: re-running reuses keys and units.

Tunables are env vars on the `curl | bash` line, e.g. `SHADE_TREE_ADMISSION=stake`,
`SHADE_TREE_BOOTNODE_PORT`, `SHADE_TREE_GATEWAY_PORT`, `SHADE_TREE_DIR`, `SHADE_TREE_REF=<tag|sha>` to pin the
git ref the box clones (fetch the script from that same ref), `SHADE_TREE_ENABLE_POW=1` (onion PoW,
off by default). To add a node to an *existing* Elder Tree instead, set
`SHADE_TREE_BOOTNODE_ONION=<elder-onion>`: the box then runs only Tor + gateway + heartbeat.
Firewall stays inbound-22-only;
the onion services take no clearnet ports. Never expose the loopback backends (8877 /
8443).

## Three commands by hand

Adding a node to an existing Elder Tree, or bringing your own host:

```bash
shade-tree keygen tor/hs-gateway --label gateway    # internal path/label for the node identity
shade-tree node                                     # verify proofs, tunnel :443
shade-tree heartbeat --bootnode <elder-onion> \
  --identity tor/hs-gateway/identity.local.json
```

Point your Tor daemon's `HiddenServiceDir` at `tor/hs-gateway` with `HiddenServicePort
80 127.0.0.1:8443` so it publishes the onion. The heartbeat re-announces every
`--interval` seconds (default 300) and keeps the node announced. Confirm you are listed
(droplet Tor SOCKS = 9050, local-dev repo Tor = 9250):

```bash
curl --socks5-hostname 127.0.0.1:9050 http://<elder-onion>/directory
```

The guided operator command remains `shade-tree join gateway`; it mints the node identity and
prints the next commands.

## Optional: stake the operator

Only needed for an Elder Tree using `--admission stake`, or to fund the address that pays gas to
slash member over-spenders. Stake binds to the operator address, never to an onion, so
one stake can back rotating onions.

```bash
shade-tree register-gateway \
  --gateway-registry 0x<GatewayRegistry> \
  --register-key 0x<operator-key> \
  --rpc-url https://<rpc-endpoint>
```

`--bond` defaults to the on-chain `BOND()`. The command is a no-op if the operator is
already staked. For a staked Elder Tree, run the heartbeat with the operator key so it
signs the durable onion-to-operator authorization:

```bash
SHADE_TREE_GW_OPERATOR_KEY=0x<operator-key> shade-tree heartbeat \
  --bootnode <elder-onion> \
  --identity tor/hs-gateway/identity.local.json
```

## Where to go deeper

- [`../OPERATOR.md`](../OPERATOR.md): the full runbook. Day-2 health and logs, the normal
  PASS/DROP log lines, key management and backup, responding to a slash, rotating or
  retiring a node.
- [`../CONFIG.md`](../CONFIG.md): every `SHADE_TREE_*` variable and its default.
- [`../BOOTNODE.md`](../BOOTNODE.md): the live-discovery design, admission modes, and the
  pinned signer's discovery trust boundary.
- [`../INCIDENT.md`](../INCIDENT.md): the incident-response playbook.
- [JOIN.md](JOIN.md): the other side, joining the set as a member and routing traffic.
