# rgoe CLI

`rgoe <command> [--flags] [args]`

One entrypoint for the whole reputation-gated onion egress system (`bin/rgoe.mjs`). Install it as `rgoe` with `npm link` (uses the `bin` field in `package.json`), or run it directly with `node bin/rgoe.mjs <command>`.

Every `--flag` is a thin alias: it sets the matching `RGOE_*` environment variable, then runs the underlying module as a child with that environment. So flags and env vars are one-to-one and interchangeable, and a flag simply overrides whatever the environment already had. Flags are accepted on any command (setting env is harmless where unused). A flag the router does not know is passed through verbatim to the child module (e.g. `keygen --label`). `--help` / `-h` on any command prints its one-line help; `rgoe help` lists all commands; `rgoe version` prints the package version.

See `docs/CONFIG.md` for the full env-var reference and defaults.

## Commands

| Command | Script | What it does | Example |
|---|---|---|---|
| `keygen` | `bootnode/keygen.mjs` | Mint an onion identity: a Tor v3 hidden-service key plus the announce-signing seed. Writes `hs_ed25519_secret_key`, `hs_ed25519_public_key`, `hostname`, and `identity.local.json` into `<hsDir>`. | `rgoe keygen tor/hs --label gw1` |
| `bootnode` | `bootnode/server.mjs` | Run the discovery bootnode (an onion service); verifies gateway announces and serves a signed directory. Long-running. | `rgoe bootnode --port 8877 --admission stake --gateway-registry 0xReg --rpc-url https://rpc.example` |
| `heartbeat` | `bootnode/heartbeat.mjs` | Keep this gateway announced on the bootnode; re-announces every interval. Long-running. | `rgoe heartbeat --bootnode <onion> --operator-key 0xKEY` |
| `enroll` | `group/enroll.mjs` | Generate a member identity locally and print its secret + commitment (the secret never leaves the machine). | `rgoe enroll alice --commitment-only` |
| `register-member` | `group/register-onchain.mjs` | Stake a self-enrolled member commitment into `StakedReputationSet` (posts the bond). | `rgoe register-member 0xCOMMITMENT --rpc-url https://rpc.example --group-contract 0xSet` |
| `register-gateway` | `group/register-gateway.mjs` | Stake a gateway operator bond into `GatewayRegistry` (binds to the operator address). | `rgoe register-gateway --gateway-registry 0xReg --register-key 0xKEY` |
| `sign-directory` | `group/sign-directory.mjs` | Sign a static fleet directory for offline discovery; with no args mints example keys + file. | `rgoe sign-directory unsigned.json` |
| `gateway` | `gateway/gateway.mjs` | Run the reputation-gated egress gateway (Tor onion, `:443` metadata-only tunnel). Long-running. | `rgoe gateway --group-contract 0xSet --rpc-url https://rpc.example` |
| `client` | `client/shim.mjs` | Run the local HTTP-CONNECT proxy (fleet client). Long-running. | `rgoe client --secret <hex> --bootnode <onion> --dir-signer <hex>` |
| `shim` | `client/shim.mjs` | Alias for `client`. | `rgoe shim --secret <hex> --onion <onion>` |
| `doctor` | `scripts/doctor.mjs` | Check the local setup (node, tor, keys, deps). | `rgoe doctor` |

`keygen` takes a positional `<hsDir>` and an own `--label`; `register-member` takes a positional `<commitment>`; `sign-directory` takes an optional positional unsigned-list path. All other positionals are forwarded to the child module.

## Flags

Every `--flag` sets exactly one `RGOE_*` env var (from `FLAG_ENV` in `bin/rgoe.mjs`). Flags override the environment.

| Flag | Env var | Group |
|---|---|---|
| `--rpc-url` | `RGOE_RPC_URL` | global |
| `--tor-host` | `RGOE_TOR_HOST` | global |
| `--tor-port` | `RGOE_TOR_PORT` | global |
| `--epoch-seconds` | `RGOE_EPOCH_SECONDS` | global |
| `--port` | `RGOE_BOOTNODE_PORT` | bootnode |
| `--admission` | `RGOE_BOOTNODE_ADMISSION` | bootnode |
| `--ttl` | `RGOE_BOOTNODE_TTL` | bootnode |
| `--signer-key` | `RGOE_BOOTNODE_SIGNER_KEY` | bootnode |
| `--stake-mode` | `RGOE_STAKE_MODE` | bootnode |
| `--gateway-registry` | `RGOE_GATEWAY_REGISTRY` | bootnode |
| `--stake-allowlist` | `RGOE_STAKE_ALLOWLIST` | bootnode |
| `--group-contract` | `RGOE_GROUP_CONTRACT` | gateway |
| `--root-provider` | `RGOE_ROOT_PROVIDER` | gateway |
| `--slash-key` | `RGOE_SLASH_KEY` | gateway |
| `--slash-contract` | `RGOE_SLASH_CONTRACT` | gateway |
| `--secret` | `RGOE_SECRET` | client |
| `--onion` | `RGOE_ONION` | client |
| `--bootnode` | `RGOE_BOOTNODE_ONION` | client |
| `--directory` | `RGOE_DIRECTORY` | client |
| `--dir-signer` | `RGOE_DIR_SIGNER` | client |
| `--shim-port` | `RGOE_SHIM_PORT` | client |
| `--identity` | `RGOE_GW_IDENTITY` | gateway announce / heartbeat |
| `--weight` | `RGOE_GW_WEIGHT` | gateway announce / heartbeat |
| `--interval` | `RGOE_BOOTNODE_HEARTBEAT` | gateway announce / heartbeat |
| `--operator-key` | `RGOE_GW_OPERATOR_KEY` | gateway announce / heartbeat |
| `--operator` | `RGOE_GW_OPERATOR` | gateway announce / heartbeat |
| `--operator-sig` | `RGOE_GW_OPERATOR_SIG` | gateway announce / heartbeat |
| `--register-key` | `RGOE_REGISTER_KEY` | gateway announce / heartbeat |
| `--bond` | `RGOE_BOND` | gateway announce / heartbeat |

Some env vars have no flag and must be set in the environment directly: `RGOE_SLASH_RECEIVER`, `RGOE_CONFIRMATIONS`, `RGOE_STAKE_CACHE_MS`, `RGOE_FRESHNESS_ROOTS`, `RGOE_FROM_BLOCK`, `RGOE_DIRECTORY_CACHE`, `RGOE_DIRECTORY_REFRESH_MS`, `RGOE_SLOTS`, `RGOE_RLN_IDENTIFIER`, and the demo/test vars. See `docs/CONFIG.md`.
