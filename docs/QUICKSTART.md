# Quickstart

Stand up the whole system — a discovery bootnode, a reputation-gated gateway, and a client —
from scratch. Two paths: a **local loop** to understand the pieces, and a **live droplet** to
actually run it.

Everything is one CLI: `rgoe <command> [--flags]`. Install it:

```bash
npm install
npm link           # puts `rgoe` on PATH; or just use `node bin/rgoe.mjs` everywhere
rgoe doctor        # checks node, tor, deps, keys
```

Each `--flag` maps to an `RGOE_*` env var (see [CONFIG.md](CONFIG.md)); either works.

## Path A: the live fleet on a droplet (one command)

If you just want it running, rent a fresh Ubuntu 24.04 box and:

```bash
ssh root@<droplet>
curl -fsSL https://raw.githubusercontent.com/dmarzzz/reputation-gated-onion-egress/main/bootnode/deploy/bootstrap.sh | sudo bash
```

It installs Tor + Node, mints the onions, starts the bootnode + gateway + heartbeat as
systemd units, and prints the bootnode onion, its pinned signer, and the client command. See
[bootnode/deploy/README.md](../bootnode/deploy/README.md). Then jump to [Connect a client](#4-connect-a-client).

## Path B: the local loop (understand the pieces)

You need a local Tor daemon. The repo ships one (`scripts/run-*.sh` / `tor/torrc`); it runs
SOCKS on 9250. Below, each role is a separate terminal.

### 1. Mint onion identities

```bash
rgoe keygen tor/hs-bootnode --label bootnode   # the bootnode's onion
rgoe keygen tor/hs-gateway  --label gateway    # the gateway's onion
```

Each writes Tor HS key files + an `identity.local.json` (the announce-signing seed). Point
your Tor daemon's `HiddenServiceDir` at these dirs so it publishes the onions
(`HiddenServicePort 80 127.0.0.1:8877` for the bootnode, `... 127.0.0.1:8443` for the gateway).

### 2. Run the bootnode

```bash
rgoe bootnode --port 8877 --admission open
```

It prints its **pinned signer pubkey** — clients need it. (`--admission open` = onion control
is the only requirement; `--admission stake` also requires an on-chain gateway bond, see
[BOOTNODE.md](BOOTNODE.md).)

### 3. Run a gateway and announce it

```bash
rgoe gateway                                   # the egress; verifies proofs, tunnels :443
rgoe heartbeat --bootnode <bootnode-onion> \
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
rgoe enroll                 # prints RGOE_SECRET (a member of the set) + its commitment
```

Then run the client, pointed at the bootnode and pinning its signer:

```bash
rgoe client --secret <member-hex> \
  --bootnode <bootnode-onion> \
  --dir-signer <bootnode-signer-pubkey>
```

The client fetches the live directory over Tor, verifies it, and runs a local HTTP-CONNECT
proxy on `127.0.0.1:8888` with per-request gateway rotation. Use it:

```bash
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json
```

The IP returned is a gateway's, not yours; the gateway never learned your IP (no exit node);
and your request carried a fresh RLN proof of membership, rate-limited without identifying you.

## On-chain mode (optional)

To source membership from the on-chain `StakedReputationSet` and require staked gateways:

```bash
# deploy locally
anvil &
forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

rgoe register-member <commitment>          # stake a member (from `rgoe enroll --commitment-only`)
rgoe register-gateway                      # stake a gateway operator
rgoe bootnode --admission stake --stake-mode onchain \
  --gateway-registry <addr> --rpc-url http://127.0.0.1:8545
```

See [CONFIG.md](CONFIG.md) for every variable and [ONCHAIN.md](ONCHAIN.md) for the design.

## Verify everything works

```bash
npm test                 # bootnode + shim + rln selftests
npm run test:contracts   # forge test (StakedReputationSet + GatewayRegistry)
```
