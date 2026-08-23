# Quickstart

Connect to an operator's fleet, or stand up your own (a discovery bootnode, an access-gated
gateway, and a client). Three paths: **Path A, connect to a v4 fleet** with configuration from
its operator, **Path B, a local loop** to understand the pieces, and **Path C, a live droplet**
to run your own gateway or fleet (you choose what you admit, default invited only, and what
you sell).

> **Current network status.** This checkout speaks envelope v4 only. The committed
> [`network/sepolia/`](../network/sepolia/README.md) record describes the earlier, incompatible
> pre-v4 research deployment; it is not a runnable default for this client, payments, or
> staking. The public Grove observes that old fleet read-only. Its count is a historical-network
> reachability signal, not evidence that a public v4 fleet is available.

Everything is one CLI: `shade-tree <command> [--flags]`. Install it:

```bash
npm install
npm link           # puts `shade-tree` on PATH; or just use `node bin/shade-tree.mjs` everywhere
shade-tree doctor        # checks node, tor, deps, keys
```

Each `--flag` maps to an `SHADE_TREE_*` env var (see [CONFIG.md](CONFIG.md)); either works.

## Path A: connect to an operator's v4 fleet

Ask the operator for a member secret or enrollment path and either a gateway onion, or the
v4 bootnode onion plus its pinned directory signer. You need a Tor SOCKS port:
`bash scripts/start-tor-client.sh` starts one on 9260 (or use `--tor-port 9050` with a system
Tor). Pinning one gateway is the smallest path:

```bash
SHADE_TREE_SECRET=<hex> SHADE_TREE_ONION=<v4-gateway.onion> \
  shade-tree client --tor-port 9260
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json     # a gateway's IP, not yours
```

For signed discovery and rotation, use both values supplied by the same v4 operator:

```bash
SHADE_TREE_SECRET=<hex> shade-tree client --tor-port 9260 \
  --bootnode <v4-bootnode.onion> \
  --dir-signer <v4-directory-signer-hex>
```

If that operator enables paid or staked admission, they must also supply the v4 registrar,
chain, and contract addresses. Do not substitute the checked-in Sepolia values:

```bash
# paid admission, when offered by the v4 operator
shade-tree enroll
shade-tree pay --bootnode <v4-bootnode.onion> --limit 8 \
  --protocol x402 --key-file buyer.key --secret-file ./.secret

# staked admission, when offered by the v4 operator
shade-tree register-member <commitment> --limit 8 \
  --rpc-url <operator-rpc-url> --group-contract <v4-staked-set-address>
```

The client fetches the signed directory over Tor, verifies it against the pinned signer, and
rotates across the gateways per tunnel. Member page: [JOIN.md](JOIN.md); buying: [PAYMENTS.md](PAYMENTS.md).
Research preview and untrusted ZK artifacts: see the README "Status".

## Path B: the local loop (understand the pieces)

You need a local Tor daemon. The repo ships one (`scripts/run-*.sh` / `tor/torrc`); it runs
SOCKS on 9250. Below, each role is a separate terminal.

### 1. Mint onion identities

```bash
shade-tree keygen tor/hs-bootnode --label bootnode   # the bootnode's onion
shade-tree keygen tor/hs-gateway  --label gateway    # the gateway's onion
```

Each writes Tor HS key files + an `identity.local.json` (the announce-signing seed). Point
your Tor daemon's `HiddenServiceDir` at these dirs so it publishes the onions
(`HiddenServicePort 80 127.0.0.1:8877` for the bootnode, `... 127.0.0.1:8443` for the gateway).

### 2. Run the bootnode

```bash
shade-tree bootnode --port 8877 --admission open
```

It prints its **pinned signer pubkey** — clients need it. (`--admission open` = onion control
is the only requirement; `--admission stake` also requires an on-chain gateway bond, see
[BOOTNODE.md](BOOTNODE.md).)

### 3. Run a gateway and announce it

```bash
shade-tree gateway                                   # the egress; verifies proofs, tunnels :443
shade-tree heartbeat --bootnode <bootnode-onion> \
  --identity tor/hs-gateway/identity.local.json
```

The heartbeat announces the gateway to the bootnode every few minutes and keeps it live.
Confirm it is listed:

```bash
curl --socks5-hostname 127.0.0.1:9250 http://<bootnode-onion>/directory
```

### 4. Connect a client

First get a member secret (the reputation-set identity):

```bash
shade-tree enroll                 # prints SHADE_TREE_SECRET (a member of the set) + its commitment
```

Then run the client, pointed at the bootnode and pinning its signer:

```bash
shade-tree client --secret <member-hex> \
  --bootnode <bootnode-onion> \
  --dir-signer <bootnode-signer-pubkey>
```

The client fetches the live directory over Tor, verifies it, and runs a local HTTP-CONNECT
proxy on `127.0.0.1:8888` with per-tunnel gateway rotation. Use it:

```bash
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json
```

The IP returned is a gateway's, not yours; the gateway never learned your IP (no exit node);
and your request carried a fresh RLN proof of membership, rate-limited without identifying you.

## Path C: your own fleet on a droplet (one command)

If you want to run one, rent a fresh Ubuntu 24.04 box and:

```bash
ssh root@<droplet>
curl -fsSL https://raw.githubusercontent.com/dmarzzz/shade-tree-node/main/bootnode/deploy/bootstrap.sh | sudo bash
```

It installs Tor + Node, mints the onions, starts the bootnode + gateway + heartbeat as
systemd units, and prints the bootnode onion, its pinned signer, and the client command. Opt-ins:
`SHADE_TREE_BOOTNODE_ONION=<onion>` (gateway-only box joining an existing bootnode), `SHADE_TREE_REGISTRAR=1`
(sell access over 402), `SHADE_TREE_HELIOS=1` (light-client root anchor). See
[bootnode/deploy/README.md](../bootnode/deploy/README.md). Then connect as in [step 4](#4-connect-a-client), pointing `--bootnode` / `--dir-signer` at what it printed.

## On-chain mode (optional)

To source membership from the on-chain `StakedReputationSet` and require staked gateways:

```bash
# deploy locally
anvil &
forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

shade-tree register-member <commitment>          # stake a member (from `shade-tree enroll --commitment-only`)
shade-tree register-gateway                      # stake a gateway operator
shade-tree bootnode --admission stake --stake-mode onchain \
  --gateway-registry <addr> --rpc-url http://127.0.0.1:8545
```

See [CONFIG.md](CONFIG.md) for every variable and [ONCHAIN.md](ONCHAIN.md) for the design.

## Verify everything works

```bash
npm test                 # bootnode + shim + rln selftests
npm run test:contracts   # forge test (StakedReputationSet + GatewayRegistry)
```
