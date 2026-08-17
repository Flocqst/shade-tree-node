# Run a gateway

You read the write-up. This is how you put a clean-IP egress into the fleet.

A gateway is a Tor onion service that verifies a member's RLN proof and, only then,
egresses TCP CONNECT to `:443`. It takes no inbound clearnet ports and never learns a
client's IP. You supply one thing the protocol cannot: a clean egress IP.

Status: reference implementation, unaudited, testnet ZK artifacts. It runs end to end
today. A live fleet serving real members is gated behind test hardening and the Rust
client. Do not put real anonymity needs on it yet. See the repo README "Scope" and
[`../SHIP-PLAN.md`](../SHIP-PLAN.md).

## Prerequisites

- A fresh Ubuntu 24.04 box (for the one-command path), or Node 18+ and a local Tor
  daemon (for the manual path). `npm install && npm link` puts `rgoe` on PATH; `rgoe
  doctor` checks node, tor, deps, and keys.
- An existing bootnode's onion, if you are adding a gateway to a fleet someone else
  runs. `bootstrap.sh` stands up its own bootnode + gateway together.

## One command on a droplet

Rent a fresh Ubuntu 24.04 box and run:

```bash
ssh root@<droplet-ip>
curl -fsSL https://raw.githubusercontent.com/dmarzzz/reputation-gated-onion-egress/main/bootnode/deploy/bootstrap.sh | sudo bash
```

It installs Tor (official repo, so onion PoW is available) and Node, mints the onion
identities, starts `rgoe-bootnode` + `rgoe-gateway` + `rgoe-heartbeat` as
`Restart=always` systemd units, and prints the bootnode onion, its pinned signer, the
gateway onion, and the client command. Idempotent: re-running reuses keys and units.

Tunables are env vars on the `curl | bash` line, e.g. `RGOE_ADMISSION=stake`,
`RGOE_BOOTNODE_PORT`, `RGOE_GATEWAY_PORT`, `RGOE_DIR`. Firewall stays inbound-22-only;
the onion services take no clearnet ports. Never expose the loopback backends (8877 /
8443).

## Three commands by hand

Adding a gateway to an existing bootnode, or bringing your own host:

```bash
rgoe keygen tor/hs-gateway --label gateway    # mint the onion identity + announce-signing seed
rgoe gateway                                  # the egress: verify proofs, tunnel :443
rgoe heartbeat --bootnode <bootnode-onion> \
  --identity tor/hs-gateway/identity.local.json
```

Point your Tor daemon's `HiddenServiceDir` at `tor/hs-gateway` with `HiddenServicePort
80 127.0.0.1:8443` so it publishes the onion. The heartbeat re-announces every
`--interval` seconds (default 300) and keeps the gateway live. Confirm you are listed
(droplet Tor SOCKS = 9050, local-dev repo Tor = 9250):

```bash
curl --socks5-hostname 127.0.0.1:9050 http://<bootnode-onion>/directory
```

`rgoe join gateway` is the guided version: it mints the identity and prints these exact
next commands.

## Optional: stake the operator

Only needed for a `--admission stake` bootnode, or to fund the address that pays gas to
slash member over-spenders. Stake binds to the operator address, never to an onion, so
one stake can back rotating onions.

```bash
rgoe register-gateway \
  --gateway-registry 0x<GatewayRegistry> \
  --register-key 0x<operator-key> \
  --rpc-url https://<rpc-endpoint>
```

`--bond` defaults to the on-chain `BOND()`. The command is a no-op if the operator is
already staked. For a staked bootnode, run the heartbeat with the operator key so it
signs the durable onion-to-operator authorization:

```bash
RGOE_GW_OPERATOR_KEY=0x<operator-key> rgoe heartbeat \
  --bootnode <bootnode-onion> \
  --identity tor/hs-gateway/identity.local.json
```

## Where to go deeper

- [`../OPERATOR.md`](../OPERATOR.md): the full runbook. Day-2 health and logs, the normal
  PASS/DROP log lines, key management and backup, responding to a slash, rotating or
  retiring a gateway.
- [`../CONFIG.md`](../CONFIG.md): every `RGOE_*` variable and its default.
- [`../BOOTNODE.md`](../BOOTNODE.md): the live-discovery design, admission modes, and the
  trust boundary (the bootnode is a cache, not a trust root).
- [`../INCIDENT.md`](../INCIDENT.md): the incident-response playbook.
- [JOIN.md](JOIN.md): the other side, joining the set as a member and routing traffic.
