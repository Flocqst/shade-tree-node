# rgoe configuration

Every configuration value is an `RGOE_*` environment variable. Most also have a `--flag` on the `rgoe` CLI (see `docs/CLI.md`); the flag just sets the same env var and overrides it. Tables below give the default, what the variable controls, which component reads it, and the `--flag` alias where one exists.

## Bootnode

Read by `bootnode/server.mjs` (discovery service) and `bootnode/heartbeat.mjs` (gateway announcer).

| Env var | Default | Controls | Component | Flag |
|---|---|---|---|---|
| `RGOE_BOOTNODE_PORT` | `8877` | Loopback port Tor maps the bootnode onion to (listens on `127.0.0.1`). | bootnode server | `--port` |
| `RGOE_BOOTNODE_ADMISSION` | `open` | Admission policy: `open` (onion-control only) or `stake` (require live operator stake). | bootnode server | `--admission` |
| `RGOE_BOOTNODE_TTL` | `900` | Seconds a gateway stays live without re-announcing before it ages out. | bootnode server | `--ttl` |
| `RGOE_BOOTNODE_SIGNER_KEY` | `bootnode/bootnode-signer.key` | Path to the pinned `{pub,priv}` JSON signer; minted and persisted if absent. | bootnode server | `--signer-key` |
| `RGOE_BOOTNODE_STORE` | (off) | Optional JSON state file for write-through persistence. When set, each accepted announce is mirrored to disk and reloaded on boot so a restart does not blank the fleet until every gateway re-announces. Reload re-verifies each record (onion control + operator stake) and drops any past its TTL, so a stale or tampered store can never admit anything a live announce would reject. | bootnode server | — |
| `RGOE_BOOTNODE_ONION` | (required for heartbeat / bootnode discovery) | The bootnode onion to announce to (heartbeat) / to fetch the live directory from (client). | heartbeat, client selection | `--bootnode` |
| `RGOE_BOOTNODE_HEARTBEAT` | `300` | Re-announce interval in seconds. | heartbeat | `--interval` |
| `RGOE_GW_IDENTITY` | `tor/hs/identity.local.json` | Path to the onion identity `{onion, seed}` (from `keygen`) the heartbeat announces. | heartbeat | `--identity` |
| `RGOE_GW_WEIGHT` | `100` | Selection weight advertised for this gateway. | heartbeat | `--weight` |
| `RGOE_GW_OPERATOR_KEY` | (unset) | Operator EOA private key; signs the durable onion↔operator authorization (stake mode). | heartbeat | `--operator-key` |
| `RGOE_GW_OPERATOR` | (unset) | Pre-computed operator address (used with `RGOE_GW_OPERATOR_SIG` instead of the key). | heartbeat | `--operator` |
| `RGOE_GW_OPERATOR_SIG` | (unset) | Pre-computed operator signature over `operatorAuthMessage(onion, operator)`. | heartbeat | `--operator-sig` |

## Gateway

Read by `gateway/gateway.mjs` (egress proxy). See also On-chain and Common groups.

| Env var | Default | Controls | Component | Flag |
|---|---|---|---|---|
| `RGOE_GROUP_CONTRACT` | (unset; falls back to `contracts/deployed.local.json`, else `members.json`) | `StakedReputationSet` address. If set, the gateway reads roots on-chain via a RootProvider; if unset it uses the local `members.json` root (PoC fallback). | gateway root source, root-provider | `--group-contract` |
| `RGOE_ROOT_PROVIDER` | `node` | Root source mode: `node` (trusted local node, event reconstruction) or `light` (Helios light client; not yet wired). | root-provider factory | `--root-provider` |
| `RGOE_SLASH_KEY` | (unset → dry-run) | Operational hot key that submits on-chain `slash()` txs. Without it (or without a slash contract) slashing logs a dry-run. | gateway slasher | `--slash-key` |
| `RGOE_SLASH_CONTRACT` | (unset; falls back to `deployed.local.json`) | Slash contract address. Independent of the membership root source, so a gateway can slash on-chain while membership stays on `members.json`. | gateway slasher | `--slash-contract` |
| `RGOE_SLASH_RECEIVER` | (unset → the slasher wallet's own address) | Address that receives the slashed bond. | gateway slasher | (none) |

## Client

Read by `client/shim.mjs` / `client/rgoe-client.mjs` (proxy + library) and `client/selection.mjs` (fleet selection).

| Env var | Default | Controls | Component | Flag |
|---|---|---|---|---|
| `RGOE_SECRET` | (required) | Member secret (bearer credential from `enroll`); used to mint per-request RLN proofs. | client | `--secret` |
| `RGOE_ONION` | (unset) | Pin a single gateway onion (skips directory selection). `.onion` suffix optional. | client | `--onion` |
| `RGOE_DIRECTORY` | (unset) | Path to a static signed directory JSON (offline discovery). | client selection | `--directory` |
| `RGOE_DIR_SIGNER` | (unset; no default — directory mode is off unless set) | Pinned ed25519 public key of the directory signer (bootnode signer, or the static directory signer). | client selection | `--dir-signer` |
| `RGOE_BOOTNODE_ONION` | (unset) | Bootnode onion to fetch the live signed directory from over Tor. Wins over `RGOE_DIRECTORY` if both set. | client selection | `--bootnode` |
| `RGOE_DIRECTORY_CACHE` | `cache/bootnode-directory.lkg` (bootnode) or `<RGOE_DIRECTORY>.lkg` (file), else none | Last-known-good directory cache path. | client selection | (none) |
| `RGOE_DIRECTORY_REFRESH_MS` | `300000` (5 min) | How often to refresh the loaded directory. | client selection | (none) |
| `RGOE_SHIM_PORT` | `8888` | Local HTTP-CONNECT proxy listen port (on `127.0.0.1`). | shim | `--shim-port` |
| `RGOE_SLOTS` | `8` | `K_SLOTS`: per-epoch rate cap / number of per-slot nullifiers before over-spend. | lib/rln (client + gateway) | (none) |
| `RGOE_RLN_IDENTIFIER` | `1` | RLN identifier bound into the circuit / external nullifier. Must match across client and gateway. | lib/rln (client + gateway) | (none) |

## On-chain

Read by `lib/gateway-registry.mjs` (StakeVerifier), `lib/root-provider.mjs` (RootProvider), and the `register-*` scripts.

| Env var | Default | Controls | Component | Flag |
|---|---|---|---|---|
| `RGOE_STAKE_MODE` | auto: `onchain` if `RGOE_GATEWAY_REGISTRY` set, else `mock` | StakeVerifier source: `onchain` (eth_call `isStaked`) or `mock` (chainless dev). | gateway-registry | `--stake-mode` |
| `RGOE_GATEWAY_REGISTRY` | (unset; register scripts fall back to `deployed.local.json`) | `GatewayRegistry` contract address (required for `onchain` stake mode and `register-gateway`). | gateway-registry, register-gateway | `--gateway-registry` |
| `RGOE_STAKE_ALLOWLIST` | (unset → everyone staked) | Comma-separated operator addresses treated as staked in `mock` mode; empty means open dev (all staked). | gateway-registry (mock) | `--stake-allowlist` |
| `RGOE_STAKE_CACHE_MS` | `15000` | TTL of the on-chain `isStaked` result cache (keeps heartbeat storms cheap). | gateway-registry (onchain) | (none) |
| `RGOE_FRESHNESS_ROOTS` | `2` | Current root plus how many prior roots are still accepted (freshness window ring). | root-provider | (none) |
| `RGOE_FROM_BLOCK` | `0x0` | Deploy / start block for `eth_getLogs` when reconstructing the member tree. | root-provider (node) | (none) |
| `RGOE_CONFIRMATIONS` | `0` | Confirmation depth. `0` reads `latest` (stake) / `finalized` (roots); `>0` reads `head - N` for reorg safety. | gateway-registry, root-provider | (none) |
| `RGOE_REGISTER_KEY` | anvil account #0 (member) / #1 (gateway) | Funding / operator private key used to submit the stake tx. | register-onchain, register-gateway | `--register-key` |
| `RGOE_BOND` | on-chain `BOND()` (member also tries `deployed.bond`) | Bond amount in wei to stake. | register-onchain, register-gateway | `--bond` |

## Common

| Env var | Default | Controls | Component | Flag |
|---|---|---|---|---|
| `RGOE_RPC_URL` | `http://127.0.0.1:8545` (register scripts try `deployed.rpcUrl` first) | JSON-RPC endpoint for all on-chain reads/writes. | gateway-registry, root-provider, gateway slasher, register-* | `--rpc-url` |
| `RGOE_TOR_HOST` | `127.0.0.1` | Local Tor SOCKS host. | heartbeat, client, selection | `--tor-host` |
| `RGOE_TOR_PORT` | `9250` | Local Tor SOCKS port. | heartbeat, client, selection | `--tor-port` |
| `RGOE_EPOCH_SECONDS` | `120` | Epoch length in seconds (the nullifier/rate window). Must match on client and gateway. | lib/rln (client + gateway) | `--epoch-seconds` |

## Demo / test only

Not part of the core protocol; set only when running the demo page or the Sepolia integration script.

| Env var | Default | Controls | Component |
|---|---|---|---|
| `RGOE_DEMO_INDEX` | `0` | Which `keys.local.json` member index the demo uses as `RGOE_SECRET`. | `demo/server.mjs` |
| `RGOE_DEMO_PORT` | `8790` | Demo HTTP port. | `demo/server.mjs` |
| `RGOE_DEMO_WALLET` | (unset) | Address shown as the funder (display only). | `demo/server.mjs` |
| `RGOE_SCRATCH` | a session scratchpad path | Scratch directory the Sepolia integration script writes to. | `scripts/integration-sepolia.mjs` |

## Profiles

### (a) Local dev, no chain

Chainless: mock stake (everyone counts as staked), members root from the local `members.json`, discovery either pinned or via a static signed directory / local bootnode. No `RGOE_GROUP_CONTRACT`, so the gateway uses the `members.json` fallback and never touches an RPC.

```sh
# gateway (members.json root, dry-run slashing, mock stake)
export RGOE_STAKE_MODE=mock
# rgoe gateway

# bootnode (open admission; no stake checks)
export RGOE_BOOTNODE_PORT=8877
export RGOE_BOOTNODE_ADMISSION=open
# rgoe bootnode

# client — pinned single onion (simplest), OR static directory
export RGOE_SECRET=0x<member-secret-from-enroll>
export RGOE_ONION=<gateway-onion>            # pin one gateway
#   or, fleet rotation over a signed directory / local bootnode:
# export RGOE_DIRECTORY=group/directory.example.json
# export RGOE_DIR_SIGNER=<ed25519-pubkey>
# export RGOE_BOOTNODE_ONION=<bootnode-onion>   # live discovery instead of a file
export RGOE_TOR_HOST=127.0.0.1
export RGOE_TOR_PORT=9250
# rgoe client
```

### (b) Staked bootnode on a public chain

On-chain everything: bootnode requires operator stake, gateway reads the membership root on-chain and slashes for real. Point every component at the same RPC and contract addresses.

```sh
# shared
export RGOE_RPC_URL=https://<your-rpc-endpoint>
export RGOE_CONFIRMATIONS=6            # read head-N for reorg safety on a public chain

# bootnode — require live operator stake
export RGOE_BOOTNODE_ADMISSION=stake
export RGOE_STAKE_MODE=onchain
export RGOE_GATEWAY_REGISTRY=0x<GatewayRegistry>
# rgoe bootnode

# gateway operator heartbeat (durably authorizes this onion for the staked operator)
export RGOE_BOOTNODE_ONION=<bootnode-onion>
export RGOE_GW_IDENTITY=tor/hs/identity.local.json
export RGOE_GW_OPERATOR_KEY=0x<operator-key>
# rgoe heartbeat

# gateway — on-chain root + real slashing
export RGOE_GROUP_CONTRACT=0x<StakedReputationSet>
export RGOE_ROOT_PROVIDER=node
export RGOE_SLASH_KEY=0x<slasher-hot-key>
export RGOE_SLASH_CONTRACT=0x<StakedReputationSet>
# export RGOE_SLASH_RECEIVER=0x<receiver>    # optional; defaults to the slasher address
# rgoe gateway

# client — live directory from the bootnode, pinned to its signer
export RGOE_SECRET=0x<member-secret>
export RGOE_BOOTNODE_ONION=<bootnode-onion>
export RGOE_DIR_SIGNER=<bootnode-signer-pubkey>
# rgoe client
```
