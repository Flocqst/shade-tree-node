# rgoe CLI

`rgoe <command> [--flags] [args]`

One entrypoint for the whole reputation-gated onion egress system (`bin/rgoe.mjs`). Install it as `rgoe` with `npm link` (uses the `bin` field in `package.json`), or run it directly with `node bin/rgoe.mjs <command>`.

Every `--flag` is a thin alias: it sets the matching `RGOE_*` environment variable, then runs the underlying module as a child with that environment. So flags and env vars are one-to-one and interchangeable, and a flag simply overrides whatever the environment already had. Flags are accepted on any command (setting env is harmless where unused). A flag the router does not know is passed through verbatim to the child module (e.g. `keygen --label`). `--help` / `-h` on any command prints its one-line help; `rgoe help` lists all commands; `rgoe version` prints the package version.

See `docs/CONFIG.md` for the full env-var reference and defaults.

## Commands

| Command | Script | What it does | Example |
|---|---|---|---|
| `join` | `group/join.mjs` | Guided front door. `rgoe join [member] [label]` self-enrolls a member (secret on stderr, commitment + next commands on stdout); `rgoe join gateway [hsDir]` mints an onion identity and prints the operator's next commands. Composes `enroll` / `keygen`; never reimplements crypto. | `rgoe join` / `rgoe join gateway tor/hs` |
| `keygen` | `bootnode/keygen.mjs` | Mint an onion identity: a Tor v3 hidden-service key plus the announce-signing seed. Writes `hs_ed25519_secret_key`, `hs_ed25519_public_key`, `hostname`, and `identity.local.json` into `<hsDir>`. | `rgoe keygen tor/hs --label gw1` |
| `bootnode` | `bootnode/server.mjs` | Run the discovery bootnode (an onion service); verifies gateway announces and serves a signed directory. Long-running. | `rgoe bootnode --port 8877 --admission stake --gateway-registry 0xReg --rpc-url https://rpc.example` |
| `heartbeat` | `bootnode/heartbeat.mjs` | Keep this gateway announced on the bootnode; re-announces every interval. Long-running. | `rgoe heartbeat --bootnode <onion> --operator-key 0xKEY` |
| `enroll` | `group/enroll.mjs` | Generate a member identity locally and print its secret + commitment (the secret never leaves the machine). | `rgoe enroll alice --commitment-only` |
| `identity` | `group/identity.mjs` | Export the **Rust client's `--identity` file** `{identitySecret, leaf}` from your member secret (same derivation as the JS client, `lib/identity-file.mjs` → `lib/rln.mjs`; `leaf` is your `members.json` entry). Secret from `--secret-file` > `RGOE_SECRET` (`--secret`) > `./.secret`. Stdout = the JSON only; `--out <path>` writes it mode 0600 instead. The public leaf is echoed on stderr, never the secret. Derive with the fleet's `RGOE_SLOTS`. | `RGOE_SECRET=0x… rgoe identity --out identity.json` |
| `register-member` | `group/register-onchain.mjs` | Stake a self-enrolled member commitment into `StakedReputationSet` (posts the tier's bond). `--limit N` (or `RGOE_LIMIT`) is the reputation tier the leaf was enrolled at (`enroll --limit N`); default 8. The rln-v4 set records it and charges `bondFor(N)`; an rln-v3 set admits only 8. | `rgoe register-member 0xCOMMITMENT --limit 32 --rpc-url https://rpc.example --group-contract 0xSet` |
| `pay` | `group/pay.mjs` | **Buy a membership leaf over HTTP 402** (T-FEAT-7, `docs/PAYMENTS.md` "Shipped 2026-08-17"): fetch the operator's quote from the registrar on the bootnode onion (`:8878`, over Tor), sign an EIP-3009 `TransferWithAuthorization` for the stablecoin with the **buyer** wallet (holds the coin, needs **no ETH** — the operator submits and pays gas), POST it, and print `settleTx` / `insertTx` / `leafIndex` / `root` once the operator has inserted your commitment into `PaidAccessSet`. `--protocol x402` (default) or `mpp`; `--limit 8\|32` (tier; default 8); registrar via `--bootnode <onion>` / `--network sepolia` (+ `--registrar-port`, default 8878) or `--registrar-url http://…` (no Tor); buyer key `--key-file <path>` / `--account <keystore.json>` (`RGOE_PAY_PASSPHRASE`) / `RGOE_PAY_KEY`; commitment `--commitment <dec>` or derived from your member secret like `identity` (`--secret-file` / `RGOE_SECRET` / `./.secret`) at `--limit`. `--dry-run` prints the challenge + the exact authorization it would sign and signs nothing; `--json` for machine output. Prints the Layer-0 advice (the transfer is public: pay from a fresh address). Then egress with `rgoe client` as usual. | `rgoe pay --network sepolia --limit 8 --protocol mpp --key-file buyer.key --secret-file ./.secret` |
| `leaves` | `group/leaves.mjs` | Export an ON-CHAIN set's ordered leaves as a `members.json` document (`{ version: 2, members: [leaf, …] }`, slashed/exited slots written as the tree ZERO so the root matches) — the bridge for the **Rust client**, whose `rgoe egress --members <f>` reads only that file (T-FEAT-7). Rebuilds the tree from the contract's event log exactly as the gateway does (`lib/root-provider.mjs`). Contract: `--contract` > `RGOE_PAID_ACCESS_CONTRACT` > first `RGOE_GROUP_CONTRACT`. Stdout = the JSON only; `--out <path>` writes it instead. Nothing secret involved. | `rgoe leaves --contract 0xPaid --rpc-url https://rpc.example --out members.json` |
| `register-gateway` | `group/register-gateway.mjs` | Stake a gateway operator bond into `GatewayRegistry` (binds to the operator address). | `rgoe register-gateway --gateway-registry 0xReg --register-key 0xKEY` |
| `exit-gateway` | `group/exit-gateway.mjs exit` | Operator-side exit half of `GatewayRegistry` (rollback of `register-gateway`): call `initiateExit()` — leave the active set, start the `UNBONDING` clock, stay slashable until it elapses. Reads state first and refuses what would revert (`NotStaked`, second call = no-op). `--dry-run` prints target + calldata + an `eth_call` simulation and never broadcasts. Signer: `--key-file` / `--account` (Foundry keystore, `RGOE_KEYSTORE_PASSWORD`) / `--keystore` / `RGOE_REGISTER_KEY`; never on argv. | `rgoe exit-gateway --gateway-registry 0xReg --rpc-url https://rpc.example --account rgoe-operator --dry-run` |
| `withdraw-gateway` | `group/exit-gateway.mjs withdraw` | After `UNBONDING`, call `withdraw(recipient)` to reclaim the bond (`--recipient`, default the operator address). Refuses `NotStaked` / `NotExiting` / `StillBonded` (prints the withdrawable time). Same `--dry-run` and signer options as `exit-gateway`. | `rgoe withdraw-gateway --recipient 0xCold --gateway-registry 0xReg --rpc-url https://rpc.example --account rgoe-operator` |
| `gateway-status` | `group/exit-gateway.mjs status` | Read-only: an operator's stake state (`staked (active)` / `exiting` / `not staked`), `BOND`, `UNBONDING`, `withdrawableAt` and chain time. Needs no key: `--operator 0x…`. | `rgoe gateway-status --operator 0xOp --gateway-registry 0xReg --rpc-url https://rpc.example` |
| `sign-directory` | `group/sign-directory.mjs` | Sign a static fleet directory for offline discovery; with no args mints example keys + file. | `rgoe sign-directory unsigned.json` |
| `gateway` | `gateway/gateway.mjs` | Run the reputation-gated egress gateway (Tor onion, `:443` metadata-only tunnel). Long-running. Admits the paths YOU choose (T-FEAT-9, `docs/adr/0008`): `--admit invited[,staked][,paid]` — default `invited` alone (members.json; the max-anon mode) even when `--network` supplies contracts; `staked` reads every `--group-contract` (comma list), `paid` the `--paid-access-contract`; a named path without its contract refuses to start. Startup: `admits: invited+staked+paid` then `roots: members.json + staked(0x…) + paid(0x…)`. `--roots static,onchain` is the deprecated alias. | `rgoe gateway --admit invited,staked,paid --group-contract 0xSet --paid-access-contract 0xPaid --rpc-url https://rpc.example` |
| `client` | `client/shim.mjs` | Run the local HTTP-CONNECT proxy (fleet client). Long-running. Finds which set holds your leaf (`members.json`, then each `--group-contract`, then `--paid-access-contract`; `--leaf-source` pins one) and proves against it; `--limit` must be your tier. Routes only to gateways whose signed policy admits that leaf source; `--max-anon` = invited-only gateways only (refuses a staked/paid leaf with the reason). | `rgoe client --secret <hex> --bootnode <onion> --dir-signer <hex>` (or `--network sepolia`; a paid member: `--network sepolia --limit 32`; max anonymity: `--network sepolia --max-anon`) |
| `shim` | `client/shim.mjs` | Alias for `client`. | `rgoe shim --secret <hex> --onion <onion>` |
| `doctor` | `scripts/doctor.mjs` | Check the local setup (node, tor, keys, deps). | `rgoe doctor` |
| `record-deploy` | `scripts/record-deploy.mjs` | Record a broadcast contract deploy (address + tx + block) into `network/<name>/contracts.json` from Foundry's `run-latest.json` or explicit flags; never touches a chain. | `rgoe record-deploy --network sepolia --from-broadcast broadcast/DeployRegistry.s.sol/11155111/run-latest.json` |
| `backup` | `scripts/backup.mjs backup` | Encrypt and back up secret key material (onion seeds + signer key) from a directory into one file. Passphrase only via `RGOE_BACKUP_PASSPHRASE` (never argv). See `docs/BACKUP.md`. | `RGOE_BACKUP_PASSPHRASE=… rgoe backup deploy-state keys.rgoebak` |
| `restore` | `scripts/backup.mjs restore` | Restore an encrypted key backup into a directory (`--force` to overwrite). Passphrase via `RGOE_BACKUP_PASSPHRASE`. | `RGOE_BACKUP_PASSPHRASE=… rgoe restore keys.rgoebak deploy-state --force` |

`keygen` takes a positional `<hsDir>` and an own `--label`; `join` takes an optional role (`member` | `gateway`) and a label / `<hsDir>`; `register-member` takes a positional `<commitment>` (`--limit` is env-mapped to `RGOE_LIMIT`, which it reads); `sign-directory` takes an optional positional unsigned-list path; `backup` / `restore` take `<src> <dest>` positionals. All other positionals are forwarded to the child module.

Module-parsed flags (passed through, not env-mapped): `identity --out --secret-file`; `leaves --contract --out --from-block`; `exit-gateway` / `withdraw-gateway` / `gateway-status` `--dry-run --recipient --key-file --account --keystore` (`--operator`, `--rpc-url`, `--gateway-registry`, `--register-key` are env-mapped as usual); `restore --force`; `keygen --label`; `enroll --commitment-only`. `--limit` is env-mapped (`RGOE_LIMIT`) for every command since T-FEAT-7 (`identity`, `register-member`, `client` all read it).

## Flags

Every `--flag` sets exactly one `RGOE_*` env var (from `FLAG_ENV` in `bin/rgoe.mjs`). Flags override the environment.

| Flag | Env var | Group |
|---|---|---|
| `--network` | `RGOE_NETWORK` | global (fills unset vars from `network/<name>/`; see `docs/CONFIG.md`) |
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
| `--group-contract` | `RGOE_GROUP_CONTRACT` | gateway (comma list allowed, T-FEAT-7) / client leaf discovery |
| `--paid-access-contract` | `RGOE_PAID_ACCESS_CONTRACT` | gateway / client / `leaves` (T-FEAT-7) |
| `--admit` | `RGOE_ADMIT` | gateway (`invited[,staked][,paid]`; default `invited` = max-anon; T-FEAT-9) |
| `--roots` | `RGOE_ROOTS` | gateway (`static,onchain`; T-FEAT-7 spelling, DEPRECATED alias of `--admit`) |
| `--pay-protocols` | `RGOE_PAY_PROTOCOLS` | registrar / bootnode advert (`x402,mpp` subset; T-FEAT-9) |
| `--leaf-source` | `RGOE_LEAF_SOURCE` | client (`auto\|invited\|staked\|paid`; T-FEAT-9) |
| `--max-anon` | `RGOE_MAX_ANON` | client (bare flag ⇒ `true`: invited-only gateways; T-FEAT-9) |
| `--limit` | `RGOE_LIMIT` | client / identity / register-member (the member's tier) |
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

Some env vars have no flag and must be set in the environment directly: `RGOE_SLASH_RECEIVER`, `RGOE_MEMBERS_FILE`, `RGOE_PAID_MIN_LEAVES`, `RGOE_CONFIRMATIONS`, `RGOE_STAKE_CACHE_MS`, `RGOE_FRESHNESS_ROOTS`, `RGOE_FROM_BLOCK`, `RGOE_FROM_BLOCKS`, `RGOE_LOGS_CHUNK`, `RGOE_DIRECTORY_CACHE`, `RGOE_DIRECTORY_REFRESH_MS`, `RGOE_SLOTS`, `RGOE_RLN_IDENTIFIER`, and the demo/test vars. See `docs/CONFIG.md`.
