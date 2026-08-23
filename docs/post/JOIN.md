# Join the set and route your traffic

You read the write-up. This is how you become a member of the reputation set and send
your own requests out through a clean gateway IP, proving you belong to the set without
telling any gateway who you are.

You need three things from the fleet operator: the bootnode's onion, the bootnode's
pinned signer pubkey, and admission (your commitment added to the set, on chain or in
the operator's set). Everything else you generate locally, and your secret never leaves
your machine.

Status: reference implementation, unaudited, testnet ZK artifacts. It runs end to end
in local and operator-run v4 fleets but is not yet deployed here as a public v4 service.
Do not put real anonymity needs on it yet. The checked-in Sepolia record is the incompatible
pre-v4 research deployment, not a current connection profile. The public Grove observes that
old fleet read-only; its count does not advertise v4 client availability.
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

## 2. Run the client

The client is a local HTTP-CONNECT proxy. It pulls the live signed directory from the
bootnode over Tor, verifies it against the pinned signer, mints a fresh RLN proof per
request, and rotates gateways per tunnel.

```bash
export SHADE_TREE_SECRET=<your-secret-hex>
shade-tree client --secret $SHADE_TREE_SECRET \
  --bootnode <bootnode-onion> \
  --dir-signer <bootnode-signer-pubkey>
```

Get both discovery values from the same v4 fleet operator. If the operator gives you one
gateway onion instead, use `--onion <v4-gateway.onion>` and omit bootnode discovery. Do not
point this v4 client at `network/sepolia/bootnode.json`; that record and its 2026-08-17
go-live log are retained as pre-v4 deployment history.

It binds `127.0.0.1:8888` (override with `SHADE_TREE_SHIM_PORT`).

## 3. Route traffic through it

```bash
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json
```

The IP returned is a gateway's, not yours. The gateway never learned your IP (no exit
node, Tor rendezvous), and TLS stays end to end so it sees only ciphertext.

HTTPS only: the client speaks HTTP CONNECT and a gateway egresses TCP CONNECT to `:443`
only. Every target must be reachable over HTTPS. Plain `http://` is not tunneled.

## Point a tool or an agent at it

- SearXNG, curl, most HTTP libraries: proxy style. Point the tool at
  `http://127.0.0.1:8888`. No code change; the shim proves and rotates per connection.
- Your own code doing many requests: library style. `import { ShadeTreeClient } from
  "./client/shade-tree-client.mjs"` and call `shadeTree.fetch(url)` directly. One proof per tunnel,
  no extra process, direct access to the egress IP and gateway used.

Both mint a fresh per-tunnel nullifier and select a gateway for each tunnel. The proof
does not reveal a stable member identifier across slots, but a gateway may still correlate
tunnels through destination, timing, volume, or application metadata.
Full SearXNG `settings.yml` wiring, the agent example, and the Docker loopback caveat are
in [`../ADAPTERS.md`](../ADAPTERS.md).

## Where to go deeper

- [`../ADAPTERS.md`](../ADAPTERS.md): proxy vs library, SearXNG config, the agent example.
- [`../CONFIG.md`](../CONFIG.md): every `SHADE_TREE_*` variable and its default.
- [`../QUICKSTART.md`](../QUICKSTART.md): stand up the whole system yourself (local loop,
  on-chain mode, droplet).
- [RUN-A-GATEWAY.md](RUN-A-GATEWAY.md): the other side, running a gateway for the fleet.
