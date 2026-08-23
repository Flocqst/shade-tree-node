# shade-tree CLI

`shade-tree <command> [--flags] [args]`

One entrypoint for the whole Shade Tree system (`bin/shade-tree.mjs`). Install it as `shade-tree` with `npm link` (uses the `bin` field in `package.json`), or run it directly with `node bin/shade-tree.mjs <command>`.

For module-backed commands, every mapped `--flag` is a thin alias: it sets the matching `SHADE_TREE_*` environment variable, then runs the underlying module as a child with that environment. So flags and env vars are one-to-one and interchangeable, and a flag simply overrides whatever the environment already had. Mapped flags are accepted on any module command (setting env is harmless where unused). A flag the router does not know is passed through verbatim to the child module (e.g. `keygen --label`). `run` has its own deliberately narrow parser, documented below. `--help` / `-h` on any command prints its one-line help; `shade-tree help` lists all commands; `shade-tree version` prints the package version.

See `docs/CONFIG.md` for the full env-var reference and defaults.

## Run one process through Shade Tree

After `shade-tree client` has started the local proxy, `run` scopes standard proxy variables to
one child process:

```bash
shade-tree run -- hermes
shade-tree run -- curl https://api.ipify.org
shade-tree run --proxy http://127.0.0.1:8888 -- command arg
```

The command checks the proxy before spawning the child and fails closed when it cannot connect.
It sets `HTTP_PROXY`, `HTTPS_PROXY`, and `WSS_PROXY` in upper- and lowercase, removes inherited
`ALL_PROXY`, and preserves loopback in `NO_PROXY`. The current shell is unchanged. `run` accepts
only `--proxy`, `--no-proxy`, and `--check-timeout-ms` before the required `--`; everything after
that separator is the child command and its arguments. Software that ignores standard proxy
environment variables must be configured explicitly for the local HTTP CONNECT proxy.

## Commands

| Command | Script | What it does | Example |
|---|---|---|---|
| `run` | built into the CLI | Run one proxy-aware child with process-scoped Shade Tree routing. Refuses to spawn if the local proxy is unavailable. | `shade-tree run -- hermes` |
| `join` | `group/join.mjs` | Guided front door. `shade-tree join [member] [label]` self-enrolls a member (secret on stderr, commitment + next commands on stdout); `shade-tree join gateway [hsDir]` mints an onion identity and prints the operator's next commands. Composes `enroll` / `keygen`; never reimplements crypto. | `shade-tree join` / `shade-tree join gateway tor/hs` |
| `keygen` | `bootnode/keygen.mjs` | Mint an onion identity: a Tor v3 hidden-service key plus the announce-signing seed. Writes `hs_ed25519_secret_key`, `hs_ed25519_public_key`, `hostname`, and `identity.local.json` into `<hsDir>`. | `shade-tree keygen tor/hs --label gw1` |
| `bootnode` | `bootnode/server.mjs` | Run the discovery bootnode (an onion service); verifies gateway announces and serves a signed directory. Long-running. | `shade-tree bootnode --port 8877 --admission stake --gateway-registry 0xReg --rpc-url https://rpc.example` |
| `heartbeat` | `bootnode/heartbeat.mjs` | Keep this gateway announced on the bootnode; re-announces every interval. Long-running. | `shade-tree heartbeat --bootnode <onion> --operator-key 0xKEY` |
| `enroll` | `group/enroll.mjs` | Generate a member identity locally and print its secret + commitment (the secret never leaves the machine). | `shade-tree enroll alice --commitment-only` |
| `identity` | `group/identity.mjs` | Export the **Rust client's `--identity` file** `{identitySecret, leaf}` from your member secret (same derivation as the JS client, `lib/identity-file.mjs` → `lib/rln.mjs`; `leaf` is your `members.json` entry). Secret from `--secret-file` > `SHADE_TREE_SECRET` (`--secret`) > `./.secret`. Stdout = the JSON only; `--out <path>` writes it mode 0600 instead. The public leaf is echoed on stderr, never the secret. Derive with the fleet's `SHADE_TREE_SLOTS`. | `SHADE_TREE_SECRET=0x… shade-tree identity --out identity.json` |
| `register-member` | `group/register-onchain.mjs` | Stake a self-enrolled member commitment into `StakedReputationSet` (posts the tier's bond). `--limit N` (or `SHADE_TREE_LIMIT`) is the reputation tier the leaf was enrolled at (`enroll --limit N`); default 8. The rln-v4 set records it and charges `bondFor(N)`; an rln-v3 set admits only 8. | `shade-tree register-member 0xCOMMITMENT --limit 32 --rpc-url https://rpc.example --group-contract 0xSet` |
| `pay` | `group/pay.mjs` | **Buy a membership leaf over HTTP 402** (T-FEAT-7, `docs/PAYMENTS.md` "Shipped 2026-08-17"): fetch the operator's quote from the registrar on the bootnode onion (`:8878`, over Tor), sign an EIP-3009 `TransferWithAuthorization` for the stablecoin with the **buyer** wallet (holds the coin, needs **no ETH** — the operator submits and pays gas), POST it, and print `settleTx` / `insertTx` / `leafIndex` / `root` once the operator has inserted your commitment into `PaidAccessSet`. `--protocol x402` (default) or `mpp`; `--limit 8\|32` (tier; default 8); registrar via `--bootnode <onion>` / `--network sepolia` (+ `--registrar-port`, default 8878) or `--registrar-url http://…` (no Tor); buyer key `--key-file <path>` / `--account <keystore.json>` (`SHADE_TREE_PAY_PASSPHRASE`) / `SHADE_TREE_PAY_KEY`; commitment `--commitment <dec>` or derived from your member secret like `identity` (`--secret-file` / `SHADE_TREE_SECRET` / `./.secret`) at `--limit`. `--dry-run` prints the challenge + the exact authorization it would sign and signs nothing; `--json` for machine output. Prints the Layer-0 advice (the transfer is public: pay from a fresh address). Then egress with `shade-tree client` as usual. | `shade-tree pay --network sepolia --limit 8 --protocol mpp --key-file buyer.key --secret-file ./.secret` |
| `leaves` | `group/leaves.mjs` | Export an ON-CHAIN set's ordered leaves as a `members.json` document (`{ version: 2, members: [leaf, …] }`, slashed/exited slots written as the tree ZERO so the root matches) — the bridge for the **Rust client**, whose `shade-tree egress --members <f>` reads only that file (T-FEAT-7). Rebuilds the tree from the contract's event log exactly as the gateway does (`lib/root-provider.mjs`). Contract: `--contract` > `SHADE_TREE_PAID_ACCESS_CONTRACT` > first `SHADE_TREE_GROUP_CONTRACT`. Stdout = the JSON only; `--out <path>` writes it instead. Nothing secret involved. | `shade-tree leaves --contract 0xPaid --rpc-url https://rpc.example --out members.json` |
| `register-gateway` | `group/register-gateway.mjs` | Stake a gateway operator bond into `GatewayRegistry` (binds to the operator address). | `shade-tree register-gateway --gateway-registry 0xReg --register-key 0xKEY` |
| `exit-gateway` | `group/exit-gateway.mjs exit` | Operator-side exit half of `GatewayRegistry` (rollback of `register-gateway`): call `initiateExit()` — leave the active set, start the `UNBONDING` clock, stay slashable until it elapses. Reads state first and refuses what would revert (`NotStaked`, second call = no-op). `--dry-run` prints target + calldata + an `eth_call` simulation and never broadcasts. Signer: `--key-file` / `--account` (Foundry keystore, `SHADE_TREE_KEYSTORE_PASSWORD`) / `--keystore` / `SHADE_TREE_REGISTER_KEY`; never on argv. | `shade-tree exit-gateway --gateway-registry 0xReg --rpc-url https://rpc.example --account shade-tree-operator --dry-run` |
| `withdraw-gateway` | `group/exit-gateway.mjs withdraw` | After `UNBONDING`, call `withdraw(recipient)` to reclaim the bond (`--recipient`, default the operator address). Refuses `NotStaked` / `NotExiting` / `StillBonded` (prints the withdrawable time). Same `--dry-run` and signer options as `exit-gateway`. | `shade-tree withdraw-gateway --recipient 0xCold --gateway-registry 0xReg --rpc-url https://rpc.example --account shade-tree-operator` |
| `gateway-status` | `group/exit-gateway.mjs status` | Read-only: an operator's stake state (`staked (active)` / `exiting` / `not staked`), `BOND`, `UNBONDING`, `withdrawableAt` and chain time. Needs no key: `--operator 0x…`. | `shade-tree gateway-status --operator 0xOp --gateway-registry 0xReg --rpc-url https://rpc.example` |
| `sign-directory` | `group/sign-directory.mjs` | Sign a static fleet directory for offline discovery; with no args mints example keys + file. | `shade-tree sign-directory unsigned.json` |
| `gateway` | `gateway/gateway.mjs` | Run the reputation-gated egress gateway (Tor onion, `:443` metadata-only tunnel). Long-running. Admits the paths YOU choose (T-FEAT-9, `docs/adr/0008`): `--admit invited[,staked][,paid]` — default `invited` alone (members.json; the max-anon mode) even when `--network` supplies contracts; `staked` reads every `--group-contract` (comma list), `paid` the `--paid-access-contract`; a named path without its contract refuses to start. Startup: `admits: invited+staked+paid` then `roots: members.json + staked(0x…) + paid(0x…)`. `--roots static,onchain` is the deprecated alias. | `shade-tree gateway --admit invited,staked,paid --group-contract 0xSet --paid-access-contract 0xPaid --rpc-url https://rpc.example` |
| `client` | `client/shim.mjs` | Run the local HTTP-CONNECT proxy (fleet client). Long-running. Finds which set holds your leaf (`members.json`, then each `--group-contract`, then `--paid-access-contract`; `--leaf-source` pins one) and proves against it; `--limit` must be your tier. Routes only to gateways whose signed policy admits that leaf source; `--max-anon` = invited-only gateways only (refuses a staked/paid leaf with the reason). | `shade-tree client --secret <hex> --bootnode <onion> --dir-signer <hex>` (or `--network sepolia`; a paid member: `--network sepolia --limit 32`; max anonymity: `--network sepolia --max-anon`) |
| `shim` | `client/shim.mjs` | Alias for `client`. | `shade-tree shim --secret <hex> --onion <onion>` |
| `doctor` | `scripts/doctor.mjs` | Check the local setup (node, tor, keys, deps). | `shade-tree doctor` |
| `record-deploy` | `scripts/record-deploy.mjs` | Record a broadcast contract deploy (address + tx + block) into `network/<name>/contracts.json` from Foundry's `run-latest.json` or explicit flags; never touches a chain. | `shade-tree record-deploy --network sepolia --from-broadcast broadcast/DeployRegistry.s.sol/11155111/run-latest.json` |
| `backup` | `scripts/backup.mjs backup` | Encrypt and back up secret key material (onion seeds + signer key) from a directory into one file. Passphrase only via `SHADE_TREE_BACKUP_PASSPHRASE` (never argv). See `docs/BACKUP.md`. | `SHADE_TREE_BACKUP_PASSPHRASE=… shade-tree backup deploy-state keys.shade-tree-backup` |
| `restore` | `scripts/backup.mjs restore` | Restore an encrypted key backup into a directory (`--force` to overwrite). Passphrase via `SHADE_TREE_BACKUP_PASSPHRASE`. | `SHADE_TREE_BACKUP_PASSPHRASE=… shade-tree restore keys.shade-tree-backup deploy-state --force` |

`keygen` takes a positional `<hsDir>` and an own `--label`; `join` takes an optional role (`member` | `gateway`) and a label / `<hsDir>`; `register-member` takes a positional `<commitment>` (`--limit` is env-mapped to `SHADE_TREE_LIMIT`, which it reads); `sign-directory` takes an optional positional unsigned-list path; `backup` / `restore` take `<src> <dest>` positionals. All other positionals are forwarded to the child module.

Module-parsed flags (passed through, not env-mapped): `identity --out --secret-file`; `leaves --contract --out --from-block`; `exit-gateway` / `withdraw-gateway` / `gateway-status` `--dry-run --recipient --key-file --account --keystore` (`--operator`, `--rpc-url`, `--gateway-registry`, `--register-key` are env-mapped as usual); `restore --force`; `keygen --label`; `enroll --commitment-only`. `--limit` is env-mapped (`SHADE_TREE_LIMIT`) for every command since T-FEAT-7 (`identity`, `register-member`, `client` all read it).

## Flags

Every `--flag` sets exactly one `SHADE_TREE_*` env var (from `FLAG_ENV` in `bin/shade-tree.mjs`). Flags override the environment.

| Flag | Env var | Group |
|---|---|---|
| `--network` | `SHADE_TREE_NETWORK` | global (fills unset vars from `network/<name>/`; see `docs/CONFIG.md`) |
| `--rpc-url` | `SHADE_TREE_RPC_URL` | global |
| `--tor-host` | `SHADE_TREE_TOR_HOST` | global |
| `--tor-port` | `SHADE_TREE_TOR_PORT` | global |
| `--epoch-seconds` | `SHADE_TREE_EPOCH_SECONDS` | global |
| `--port` | `SHADE_TREE_BOOTNODE_PORT` | bootnode |
| `--admission` | `SHADE_TREE_BOOTNODE_ADMISSION` | bootnode |
| `--ttl` | `SHADE_TREE_BOOTNODE_TTL` | bootnode |
| `--signer-key` | `SHADE_TREE_BOOTNODE_SIGNER_KEY` | bootnode |
| `--stake-mode` | `SHADE_TREE_STAKE_MODE` | bootnode |
| `--gateway-registry` | `SHADE_TREE_GATEWAY_REGISTRY` | bootnode |
| `--stake-allowlist` | `SHADE_TREE_STAKE_ALLOWLIST` | bootnode |
| `--group-contract` | `SHADE_TREE_GROUP_CONTRACT` | gateway (comma list allowed, T-FEAT-7) / client leaf discovery |
| `--paid-access-contract` | `SHADE_TREE_PAID_ACCESS_CONTRACT` | gateway / client / `leaves` (T-FEAT-7) |
| `--admit` | `SHADE_TREE_ADMIT` | gateway (`invited[,staked][,paid]`; default `invited` = max-anon; T-FEAT-9) |
| `--roots` | `SHADE_TREE_ROOTS` | gateway (`static,onchain`; T-FEAT-7 spelling, DEPRECATED alias of `--admit`) |
| `--pay-protocols` | `SHADE_TREE_PAY_PROTOCOLS` | registrar / bootnode advert (`x402,mpp` subset; T-FEAT-9) |
| `--leaf-source` | `SHADE_TREE_LEAF_SOURCE` | client (`auto\|invited\|staked\|paid`; T-FEAT-9) |
| `--max-anon` | `SHADE_TREE_MAX_ANON` | client (bare flag ⇒ `true`: invited-only gateways; T-FEAT-9) |
| `--limit` | `SHADE_TREE_LIMIT` | client / identity / register-member (the member's tier) |
| `--root-provider` | `SHADE_TREE_ROOT_PROVIDER` | gateway |
| `--slash-key` | `SHADE_TREE_SLASH_KEY` | gateway |
| `--slash-contract` | `SHADE_TREE_SLASH_CONTRACT` | gateway |
| `--secret` | `SHADE_TREE_SECRET` | client |
| `--onion` | `SHADE_TREE_ONION` | client |
| `--bootnode` | `SHADE_TREE_BOOTNODE_ONION` | client |
| `--directory` | `SHADE_TREE_DIRECTORY` | client |
| `--dir-signer` | `SHADE_TREE_DIR_SIGNER` | client |
| `--shim-port` | `SHADE_TREE_SHIM_PORT` | client |
| `--identity` | `SHADE_TREE_GW_IDENTITY` | gateway announce / heartbeat |
| `--weight` | `SHADE_TREE_GW_WEIGHT` | gateway announce / heartbeat |
| `--interval` | `SHADE_TREE_BOOTNODE_HEARTBEAT` | gateway announce / heartbeat |
| `--operator-key` | `SHADE_TREE_GW_OPERATOR_KEY` | gateway announce / heartbeat |
| `--operator` | `SHADE_TREE_GW_OPERATOR` | gateway announce / heartbeat |
| `--operator-sig` | `SHADE_TREE_GW_OPERATOR_SIG` | gateway announce / heartbeat |
| `--register-key` | `SHADE_TREE_REGISTER_KEY` | gateway announce / heartbeat |
| `--bond` | `SHADE_TREE_BOND` | gateway announce / heartbeat |

Some env vars have no flag and must be set in the environment directly: `SHADE_TREE_SLASH_RECEIVER`, `SHADE_TREE_MEMBERS_FILE`, `SHADE_TREE_PAID_MIN_LEAVES`, `SHADE_TREE_CONFIRMATIONS`, `SHADE_TREE_STAKE_CACHE_MS`, `SHADE_TREE_FRESHNESS_ROOTS`, `SHADE_TREE_FROM_BLOCK`, `SHADE_TREE_FROM_BLOCKS`, `SHADE_TREE_LOGS_CHUNK`, `SHADE_TREE_DIRECTORY_CACHE`, `SHADE_TREE_DIRECTORY_REFRESH_MS`, `SHADE_TREE_SLOTS`, `SHADE_TREE_RLN_IDENTIFIER`, and the demo/test vars. See `docs/CONFIG.md`.
