# Quickstart

Shade Tree has a local **Proxy** (protocol client), an access-gated **Shade Tree node**
(protocol gateway), and an **Elder Tree** (discovery bootnode). Source paths, environment
variables, flags, and service units retain `client`, `gateway`, and `bootnode` where
compatibility matters.

Connect to an operator's v4 Grove, or stand up your own. Three paths follow: connect with
configuration from an operator, run a local loop to understand the pieces, or run your own
node or Grove on a host.

> **Current network status.** This checkout speaks envelope v4 only. The committed
> [`network/sepolia/`](../network/sepolia/README.md) record describes the earlier, incompatible
> pre-v4 research deployment; it is not a runnable default for this Proxy, payments, or
> staking. The public Grove observes that old fleet read-only. Its count is a historical-network
> reachability signal, not evidence that a public v4 Grove is available.

Everything is one CLI: `shade-tree <command> [--flags]`. Install it:

```bash
npm install
npm link           # puts `shade-tree` on PATH; or just use `node bin/shade-tree.mjs` everywhere
shade-tree doctor        # checks node, tor, deps, keys
```

Each `--flag` maps to an `SHADE_TREE_*` env var (see [CONFIG.md](CONFIG.md)); either works.
Agent developers who do not need the repository can use the shorter
[agent install](AGENT.md#1-install-the-agent-cli).

## Path A: connect to an operator's v4 Grove

Ask the operator for a member secret or enrollment path and either a node onion, or the v4
Elder Tree onion plus its pinned Canopy signer. You need a Tor SOCKS port:
`bash scripts/start-tor-client.sh` starts one on 9260 (or use `--tor-port 9050` with a system
Tor). Pinning one node is the smallest path:

```bash
SHADE_TREE_SECRET=<hex> SHADE_TREE_ONION=<v4-node.onion> \
  shade-tree proxy --tor-port 9260
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json     # the node's IP
```

For signed discovery and rotation, use both values supplied by the same v4 operator:

```bash
SHADE_TREE_SECRET=<hex> shade-tree proxy --tor-port 9260 \
  --bootnode <v4-elder.onion> \
  --dir-signer <v4-canopy-signer-hex>
```

If that operator enables paid or staked admission, they must also supply the v4 registrar,
chain, and contract addresses. Do not substitute the checked-in Sepolia values:

```bash
# paid admission, when offered by the v4 operator
shade-tree enroll
shade-tree pay --bootnode <v4-elder.onion> --limit 8 \
  --protocol x402 --key-file buyer.key --secret-file ./.secret

# staked admission, when offered by the v4 operator
shade-tree register-member <commitment> --limit 8 \
  --rpc-url <operator-rpc-url> --group-contract <v4-staked-set-address>
```

The Proxy fetches the signed Canopy over Tor, verifies it against the pinned signer, and
selects a node per tunnel. Member page: [JOIN.md](JOIN.md); buying: [PAYMENTS.md](PAYMENTS.md).
Research preview and untrusted ZK artifacts: see the README "Status".

## Path B: the local loop (understand the pieces)

You need a local Tor daemon. The repo ships one (`scripts/run-*.sh` / `tor/torrc`); it runs
SOCKS on 9250. Below, each role is a separate terminal.

### 1. Mint onion identities

```bash
shade-tree keygen tor/hs-bootnode --label bootnode   # Elder Tree identity; internal path/label
shade-tree keygen tor/hs-gateway  --label gateway    # node identity; internal path/label
```

Each writes Tor HS key files + an `identity.local.json` (the announce-signing seed). Point
your Tor daemon's `HiddenServiceDir` at these dirs so it publishes the onions
(`HiddenServicePort 80 127.0.0.1:8877` for the Elder Tree, `... 127.0.0.1:8443` for the node).

### 2. Run the Elder Tree

```bash
shade-tree elder --port 8877 --admission open
```

It prints its **pinned signer pubkey**. Proxies need it. (`--admission open` means onion
control is the only requirement; `--admission stake` also requires an on-chain node bond, see
[BOOTNODE.md](BOOTNODE.md).)

### 3. Run a Shade Tree node and announce it

```bash
shade-tree node                                      # verifies proofs, tunnels :443
shade-tree heartbeat --bootnode <elder-onion> \
  --identity tor/hs-gateway/identity.local.json
```

The heartbeat announces the node to the Elder Tree every few minutes and keeps it live.
Confirm it is listed:

```bash
curl --socks5-hostname 127.0.0.1:9250 http://<elder-onion>/directory
```

### 4. Connect a Proxy

First get a member secret (the reputation-set identity):

```bash
shade-tree enroll                 # prints SHADE_TREE_SECRET (a member of the set) + its commitment
```

Then run the Proxy, pointed at the Elder Tree and pinning its signer:

```bash
read -s SHADE_TREE_SECRET && export SHADE_TREE_SECRET
```

Paste the member secret at the hidden prompt, then run:

```bash
shade-tree proxy \
  --bootnode <elder-onion> \
  --dir-signer <elder-signer-pubkey>
```

The Proxy fetches the signed Canopy over Tor, verifies it, and listens on
`127.0.0.1:8888`. It selects a node for each CONNECT tunnel. Use it:

```bash
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json
```

The returned IP belongs to the node. The node application receives a Tor onion connection,
not the Proxy's source IP. It still sees the target, timing, lifetime, and traffic volume.
One RLN proof admits one CONNECT tunnel, not each HTTP request carried inside it.

## Path C: your own Grove on a droplet (one command)

> **Deployment blocked.** [Issue #73](https://github.com/dmarzzz/shade-tree-node/issues/73)
> leaves private and link-local destinations reachable through the default node policy.
> Do not run this path on a public or private-network-connected host until that guard and
> the other [`DEPLOYMENT-PLAN.md`](DEPLOYMENT-PLAN.md) gates are closed.

After those gates clear, the bootstrap target is a fresh Ubuntu 24.04 host:

```bash
ssh root@<droplet>
curl -fsSL https://raw.githubusercontent.com/dmarzzz/shade-tree-node/main/bootnode/deploy/bootstrap.sh | sudo bash
```

It installs Tor + Node.js, mints the onions, starts the internal bootnode + gateway + heartbeat
systemd units, and prints the Elder Tree onion, its pinned signer, and the Proxy command. Opt-ins:
`SHADE_TREE_BOOTNODE_ONION=<onion>` (node-only host joining an existing Elder Tree), `SHADE_TREE_REGISTRAR=1`
(sell access over 402), `SHADE_TREE_HELIOS=1` (light-client root anchor). See
[bootnode/deploy/README.md](../bootnode/deploy/README.md). Then connect as in [step 4](#4-connect-a-proxy), pointing `--bootnode` / `--dir-signer` at what it printed.

## On-chain mode (optional)

To source membership from the on-chain `StakedReputationSet` and require staked gateways:

```bash
# deploy locally
anvil &
forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

shade-tree register-member <commitment>          # stake a member (from `shade-tree enroll --commitment-only`)
shade-tree register-gateway                      # stake a node operator; command retains wire name
shade-tree elder --admission stake --stake-mode onchain \
  --gateway-registry <addr> --rpc-url http://127.0.0.1:8545
```

See [CONFIG.md](CONFIG.md) for every variable and [ONCHAIN.md](ONCHAIN.md) for the design.

## Verify everything works

```bash
npm test                 # bootnode + shim + rln selftests
npm run test:contracts   # forge test (StakedReputationSet + GatewayRegistry)
```
