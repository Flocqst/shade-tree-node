# Quickstart

Join the fleet that is running, or stand up your own (a discovery bootnode, a reputation-gated
gateway, and a client). Three paths: **Path A, join the live fleet** (invited with a secret, buy a
leaf over HTTP 402, or stake one), **Path B, a local loop** to understand the pieces, and
**Path C, a live droplet** to run your own gateway or fleet (you choose what you admit, default
invited only, and what you sell).

Everything is one CLI: `rgoe <command> [--flags]`. Install it:

```bash
npm install
npm link           # puts `rgoe` on PATH; or just use `node bin/rgoe.mjs` everywhere
rgoe doctor        # checks node, tor, deps, keys
```

Each `--flag` maps to an `RGOE_*` env var (see [CONFIG.md](CONFIG.md)); either works.

## Path A: join the live fleet (`RGOE_NETWORK=sepolia`)

The fleet went live on 2026-08-17 ([GO-LIVE-LOG-2026-08-17.md](GO-LIVE-LOG-2026-08-17.md)): a
bootnode, two gateways (New York, San Francisco), stake admission, membership rooted on Sepolia.
`RGOE_NETWORK=sepolia` reads the committed record under [`network/sepolia/`](../network/sepolia/README.md)
(bootnode onion, pinned signer, contract addresses) so you set nothing else. You need a Tor
SOCKS port: `bash scripts/start-tor-client.sh` starts one on 9260 (or `--tor-port 9050` for a
system tor).

```bash
# handed a member secret (a leaf in group/members.json):
RGOE_SECRET=<hex> RGOE_NETWORK=sepolia rgoe client --tor-port 9260
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json     # a gateway's IP, not yours

# no secret? buy a leaf over HTTP 402 (a wallet holding the settle asset; no gas)...
rgoe enroll
rgoe pay --network sepolia --limit 8 --protocol x402 --key-file buyer.key --secret-file ./.secret   # or --protocol mpp
RGOE_NETWORK=sepolia rgoe client --secret <hex> --limit 8 --tor-port 9260

# ...or stake one (Sepolia ETH; tier 8 or 32):
rgoe register-member <commitment> --limit 8 --network sepolia
```

The client fetches the signed directory over Tor, verifies it against the pinned signer, and
rotates across the gateways per request. Member page: [JOIN.md](JOIN.md); buying: [PAYMENTS.md](PAYMENTS.md).
Testnet, untrusted ZK artifacts, one operator: see the README "Status".

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

## Path C: your own fleet on a droplet (one command)

If you want to run one, rent a fresh Ubuntu 24.04 box and:

```bash
ssh root@<droplet>
curl -fsSL https://raw.githubusercontent.com/dmarzzz/reputation-gated-onion-egress/main/bootnode/deploy/bootstrap.sh | sudo bash
```

It installs Tor + Node, mints the onions, starts the bootnode + gateway + heartbeat as
systemd units, and prints the bootnode onion, its pinned signer, and the client command. Opt-ins:
`RGOE_BOOTNODE_ONION=<onion>` (gateway-only box joining an existing bootnode), `RGOE_REGISTRAR=1`
(sell access over 402), `RGOE_HELIOS=1` (light-client root anchor). See
[bootnode/deploy/README.md](../bootnode/deploy/README.md). Then connect as in [step 4](#4-connect-a-client), pointing `--bootnode` / `--dir-signer` at what it printed.

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
