# Join the set and route your traffic

You read the write-up. This is how you become a member of the reputation set and send
your own HTTPS tunnels through a node IP. The proof shows membership without sending the
node your leaf identity.

Public docs call the local protocol client the **Proxy**, the egress gateway a **Shade Tree
node**, and the discovery bootnode the **Elder Tree**. Source paths, environment variables,
and flags retain `client`, `gateway`, and `bootnode` where compatibility matters.

You need three things from the Grove operator: the Elder Tree onion, its pinned Canopy
signer pubkey, and admission (your commitment added to the set, on chain or in the
operator's set). Everything else is generated locally, and your secret stays on your machine.

Status: research preview, unaudited, with testnet ZK artifacts. The software can be exercised
in a local or operator-configured v4 Grove, but there is no public v4 service here.
Do not put sensitive traffic on it. The checked-in Sepolia record is the incompatible
pre-v4 research deployment, not a current connection profile. The public Grove observes that
old fleet read-only; its count does not advertise v4 Proxy availability.
See the repo README "Scope" and [`../SHIP-PLAN.md`](../SHIP-PLAN.md).

## 1. Get a member secret

Self-enroll. The identity is generated on your machine; only the commitment leaves it.

```bash
shade-tree join                    # guided: prints your commitment + the exact next commands
# or the raw tool:
shade-tree enroll --commitment-only     # commitment on stdout, secret (export SHADE_TREE_SECRET=...) on stderr
```

The secret is a bearer credential: whoever holds it can egress as you until the set is
rotated. Keep it local. Hand the operator your commitment, or stake it yourself:

```bash
shade-tree register-member <commitment>
```

## 2. Run the Proxy

The Proxy is a local HTTP-CONNECT service. It pulls the signed Canopy from the Elder Tree
over Tor, verifies it against the pinned signer, mints a fresh RLN proof per CONNECT tunnel,
and selects a node for that tunnel.

```bash
read -s SHADE_TREE_SECRET && export SHADE_TREE_SECRET
```

Paste the member secret at the hidden prompt, then run:

```bash
shade-tree proxy \
  --bootnode <elder-onion> \
  --dir-signer <canopy-signer-pubkey>
```

Get both discovery values from the same v4 Grove operator. If the operator gives you one
node onion instead, use `--onion <v4-node.onion>` and omit Elder Tree discovery. Do not
point this v4 Proxy at `network/sepolia/bootnode.json`; that record and its 2026-08-17
go-live log are retained as pre-v4 deployment history.

It binds `127.0.0.1:8888` (override with `SHADE_TREE_SHIM_PORT`).

## 3. Route traffic through it

```bash
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json
```

The returned IP belongs to the node. The node application receives a Tor onion connection,
not the Proxy's source IP. TLS stays end to end, but the node still sees the target, timing,
lifetime, and traffic volume.

HTTPS only: the Proxy speaks HTTP CONNECT and a node egresses TCP CONNECT to `:443`
only. Every target must be reachable over HTTPS. Plain `http://` is not tunneled.

## Point a tool or an agent at it

- SearXNG, curl, most HTTP libraries: proxy style. Point the tool at
  `http://127.0.0.1:8888`. No code change; the Proxy proves and selects per connection.
- Your own code doing many requests: library style. `import { ShadeTreeClient } from
  "./client/shade-tree-client.mjs"` and call `shadeTree.fetch(url)` directly. One proof per tunnel,
  no extra process, direct access to the node selected.

Both mint a fresh per-tunnel nullifier and select a node for each tunnel. The proof
does not reveal a stable member identifier across slots, but a node may still correlate
tunnels through destination, timing, volume, or application metadata.
Full SearXNG `settings.yml` wiring, the agent example, and the Docker loopback caveat are
in [`../ADAPTERS.md`](../ADAPTERS.md).

## Where to go deeper

- [`../ADAPTERS.md`](../ADAPTERS.md): proxy vs library, SearXNG config, the agent example.
- [`../CONFIG.md`](../CONFIG.md): every `SHADE_TREE_*` variable and its default.
- [`../QUICKSTART.md`](../QUICKSTART.md): stand up the whole system yourself (local loop,
  on-chain mode, droplet).
- [RUN-A-GATEWAY.md](RUN-A-GATEWAY.md): the other side, running a Shade Tree node.
