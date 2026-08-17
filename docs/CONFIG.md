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
| `RGOE_GW_OPERATOR_KEY` | (unset) | Operator EOA private key; signs the durable onion↔operator authorization (stake mode). Must be 64 hex (0x optional); a malformed value fails the heartbeat at startup with a message that never echoes the key. | heartbeat | `--operator-key` |
| `RGOE_GW_OPERATOR` | (unset) | Pre-computed operator address (used with `RGOE_GW_OPERATOR_SIG` instead of the key; the pair takes precedence over `RGOE_GW_OPERATOR_KEY`). Setting one without the other is a startup error, not a silent onion-only downgrade. | heartbeat | `--operator` |
| `RGOE_GW_OPERATOR_SIG` | (unset) | Pre-computed operator signature over `operatorAuthMessage(onion, operator)`. Verified locally at startup (same check the bootnode runs); a sig that does not recover `RGOE_GW_OPERATOR` for this onion fails fast. | heartbeat | `--operator-sig` |
| `RGOE_BOOTNODE_MAX_ENTRIES` | `10000` | Registry size cap: a NEW onion is refused `registry-full` when full; resident onions still refresh. | bootnode server | (none) |
| `RGOE_BOOTNODE_MIN_REANNOUNCE` | `5` | Per-onion re-announce throttle in seconds (`rate-limited`, before verify). | bootnode server | (none) |
| `RGOE_BOOTNODE_ANNOUNCE_RATE` | `2 * maxEntries / RGOE_BOOTNODE_HEARTBEAT` (= `66.7`/s) | GLOBAL announce token-bucket refill (announces/second that may reach ed25519 verification, whoever sends them). Sized so a fleet at the registry cap heartbeating at the default cadence (`maxEntries/heartbeat` = 33.3/s) draws half the refill; see `docs/BOOTNODE.md` "Endpoint hardening". Overflow is `429 global-rate-limited` + `Retry-After`. `0` with burst `0` disables. | bootnode server | (none) |
| `RGOE_BOOTNODE_ANNOUNCE_BURST` | `max(100, maxEntries / 10)` (= `1000`) | The bucket's capacity: how many announces may reach verify in one instant. Covers a lockstep re-announce of a fleet up to this size; an attacker minting fresh onions gets at most this many verifies up front, then `RATE`/s. | bootnode server | (none) |
| `RGOE_BOOTNODE_HEADERS_TIMEOUT_MS` | `10000` | HTTP: complete request headers must arrive within this (slow-loris headers => `408` + close). `0` disables. | bootnode server | (none) |
| `RGOE_BOOTNODE_REQUEST_TIMEOUT_MS` | `30000` | HTTP: the whole request (headers + body) must complete within this (a dribbled body => `408` + close). Must be >= headers timeout (clamped). `0` disables. | bootnode server | (none) |
| `RGOE_BOOTNODE_KEEPALIVE_TIMEOUT_MS` | `5000` | HTTP: an idle keep-alive connection is closed after this. | bootnode server | (none) |
| `RGOE_BOOTNODE_MAX_HEADER_BYTES` | `8192` | HTTP: max total request-header bytes; over => `431`. | bootnode server | (none) |
| `RGOE_BOOTNODE_CONN_CHECK_MS` | `1000` | HTTP: how often the timeouts above are enforced (Node's default 30 s would let a slow client linger that long past the deadline). | bootnode server | (none) |

## Gateway

Read by `gateway/gateway.mjs` (egress proxy). See also On-chain and Common groups.

| Env var | Default | Controls | Component | Flag |
|---|---|---|---|---|
| `RGOE_GROUP_CONTRACT` | (unset; falls back to `contracts/deployed.local.json`, else `members.json`) | `StakedReputationSet` address. If set, the gateway reads roots on-chain via a RootProvider; if unset it uses the local `members.json` root (PoC fallback). | gateway root source, root-provider | `--group-contract` |
| `RGOE_ROOT_PROVIDER` | `node` | Root source mode: `node` (trusted local node, event reconstruction) or `light` (EIP-1186 storage proof of `currentRoot` against the block header, `LightClientRootProvider`; the header's `stateRoot` is RPC-trusted unless `RGOE_HELIOS_RPC_URL` anchors it to the beacon sync committee, T-DEV-9b). | root-provider factory | `--root-provider` |
| `RGOE_HELIOS_RPC_URL` | (unset = stateRoot RPC-trusted) | `light` provider only: URL of a LOCAL [Helios](https://github.com/a16z/helios) verifying JSON-RPC (sidecar, `bootnode/deploy/bootstrap.sh RGOE_HELIOS=1`, default `http://127.0.0.1:8546`). When set, the block `stateRoot` the storage proof is verified against comes from Helios (sync-committee verified) and the RPC's header is only cross-checked (mismatch ⇒ rejected, precise reason); Helios unreachable / wrong chain ⇒ fail closed. Startup log says `stateRootSource: helios (sync-committee verified)` vs `rpc header (TRUSTED, …)`. Refused with `RGOE_ROOT_PROVIDER=node`. `docs/LIGHT-CLIENT.md`. | root-provider (`lib/helios-root.mjs`) | (none) |
| `RGOE_HELIOS_CHAIN_ID` | (unset = must equal the RPC's `eth_chainId`) | Decimal chain id Helios must report (`11155111` Sepolia, `1` mainnet); mismatch ⇒ the provider refuses to anchor. Unset: Helios and `RGOE_RPC_URL` must agree on `eth_chainId`. | root-provider (`lib/helios-root.mjs`) | (none) |
| `RGOE_SLASH_KEY` | (unset → dry-run) | Operational hot key that submits on-chain `slash()` txs. Without it (or without a slash contract) slashing logs a dry-run. | gateway slasher | `--slash-key` |
| `RGOE_SLASH_CONTRACT` | (unset; falls back to `deployed.local.json`) | Slash contract address. Independent of the membership root source, so a gateway can slash on-chain while membership stays on `members.json`. | gateway slasher | `--slash-contract` |
| `RGOE_SLASH_RECEIVER` | (unset → the slasher wallet's own address) | Address that receives the slashed bond. | gateway slasher | (none) |
| `RGOE_ENVELOPE_TIMEOUT_MS` | `30000` | Absolute deadline (from connect, NOT re-armed by activity) for the newline-terminated envelope; a slow-loris client that never sends the newline or dribbles bytes is cut at the deadline (reply `bad-envelope:envelope timeout`, drop reason `envelope-timeout`). `0` disables. | gateway | (none) |
| `RGOE_TUNNEL_IDLE_TIMEOUT_MS` | `300000` (5 min) | Inactivity timeout on the ESTABLISHED relay: no bytes in either direction for this long => both ends closed (`rgoe_gateway_tunnel_closes_total{reason="idle-timeout"}`). Also bounds a black-holed upstream connect (`upstream-timeout`). `0` disables. | gateway | (none) |
| `RGOE_MAX_CONNS` | `1024` | Max concurrent client connections, decided at accept BEFORE any byte is read; over => reply `too-many-connections` + close. `0` = unlimited. | gateway | (none) |
| `RGOE_MAX_CONNS_PER_NULLIFIER` | `8` | Max concurrent tunnels ONE nullifier may hold open (the RLN budget counts requests, not open tunnels; an in-window honest retry is admitted idempotently, so without this one proof could pin N idle tunnels). Over => `nullifier-conn-limit`. `0` = unlimited. | gateway | (none) |
| `RGOE_TIERS` | `RGOE_SLOTS` (i.e. `8`) | Comma-separated tier limits this gateway KNOWS (T-FEAT-8), e.g. `8,32`; ascending, distinct, 1..65535; `K` is always included. Used ONLY after an over-spend to name which tier's leaf the reconstructed `identitySecret` sits behind (`resolveSlashLeaf`); verification never consults it (the tier is private to the proof). Against an rln-v4 (tiered) slash contract the on-chain slasher unions this with the contract's `allowedLimits()` and resolves the tier via `limitOf` on chain, then calls `slash(commitment, secret, limit, receiver)`; against rln-v3 it calls the 3-arg default-tier slash (auto-detected at startup, logged as `slash: on-chain … abi=`). Bad value = startup error. | gateway slash path | (none) |
| `RGOE_REPLAY_WINDOW_MS` | `5000` | Honest-retry window of the per-gateway seen-envelope cache; an exact replay later than this is dropped `replayed-envelope`. | gateway | (none) |
| `RGOE_SHUTDOWN_TIMEOUT_MS` | `10000` | Drain grace on SIGTERM/SIGINT before in-flight tunnels are force-closed. | gateway, bootnode | (none) |

## Client

Read by `client/shim.mjs` / `client/rgoe-client.mjs` (proxy + library) and `client/selection.mjs` (fleet selection).

| Env var | Default | Controls | Component | Flag |
|---|---|---|---|---|
| `RGOE_SECRET` | (required) | Member secret (bearer credential from `enroll`); used to mint per-request RLN proofs. | client | `--secret` |
| `RGOE_ONION` | (unset) | Pin a single gateway onion (skips directory selection). `.onion` suffix optional. | client | `--onion` |
| `RGOE_DIRECTORY` | (unset) | Path to a static signed directory JSON (offline discovery). | client selection | `--directory` |
| `RGOE_DIR_SIGNER` | (unset; no default — directory mode is off unless set) | Pinned ed25519 public key of the directory signer (bootnode signer, or the static directory signer). | client selection | `--dir-signer` |
| `RGOE_BOOTNODE_ONION` | (unset; or from `network/<RGOE_NETWORK>/bootnode.json`) | Bootnode onion to fetch the live signed directory from over Tor. Wins over `RGOE_DIRECTORY` if both set. | client selection | `--bootnode` |
| `RGOE_DIRECTORY_CACHE` | `cache/bootnode-directory.lkg` (bootnode) or `<RGOE_DIRECTORY>.lkg` (file), else none | Last-known-good directory cache path. | client selection | (none) |
| `RGOE_DIRECTORY_REFRESH_MS` | `300000` (5 min) | How often to refresh the loaded directory. | client selection | (none) |
| `RGOE_SHIM_PORT` | `8888` | Local HTTP-CONNECT proxy listen port (on `127.0.0.1`). | shim | `--shim-port` |
| `RGOE_SLOTS` | `8` | `K_SLOTS`: the DEFAULT tier's per-epoch rate cap (`userMessageLimit` baked into a leaf enrolled without `--limit`; number of per-slot nullifiers before over-spend). | lib/rln (client + gateway) | (none) |
| `RGOE_LIMIT` | `RGOE_SLOTS` (8) | THIS member's reputation-tier limit (T-FEAT-8, `docs/adr/0006-reputation-tiers.md`): the `userMessageLimit` its leaf was enrolled with (`rgoe enroll --limit N`). The client wraps slots at it and proves with it; a value the leaf does not carry fails at prove time (`not in group`). 1..65535. Also read by `rgoe identity` (`--limit`) for the Rust identity file, and by `rgoe register-member` (`--limit`) as the tier to stake at (`register(commitment, limit)` for `bondFor(limit)` on an rln-v4 set; an rln-v3 set admits only 8). | client, `rgoe identity`, `rgoe register-member` | `RgoeClient({ limit })`, `--limit` |
| `RGOE_RLN_IDENTIFIER` | `1` | RLN identifier bound into the circuit / external nullifier. Must match across client and gateway. | lib/rln (client + gateway) | (none) |

## On-chain

Read by `lib/gateway-registry.mjs` (StakeVerifier), `lib/root-provider.mjs` (RootProvider), and the `register-*` scripts.

| Env var | Default | Controls | Component | Flag |
|---|---|---|---|---|
| `RGOE_STAKE_MODE` | auto: `onchain` if `RGOE_GATEWAY_REGISTRY` set, else `mock` | StakeVerifier source: `onchain` (eth_call `isStaked`) or `mock` (chainless dev). | gateway-registry | `--stake-mode` |
| `RGOE_GATEWAY_REGISTRY` | (unset; falls back to `network/<RGOE_NETWORK>/contracts.json` `contracts.gatewayRegistry`, then `deployed.local.json`) | `GatewayRegistry` contract address (required for `onchain` stake mode and `register-gateway`). | gateway-registry, register-gateway | `--gateway-registry` |
| `RGOE_STAKE_ALLOWLIST` | (unset → everyone staked) | Comma-separated operator addresses treated as staked in `mock` mode; empty means open dev (all staked). | gateway-registry (mock) | `--stake-allowlist` |
| `RGOE_STAKE_CACHE_MS` | `15000` | TTL of the on-chain `isStaked` result cache (keeps heartbeat storms cheap). | gateway-registry (onchain) | (none) |
| `RGOE_FRESHNESS_ROOTS` | `2` | Current root plus how many prior roots are still accepted (freshness window ring). | root-provider | (none) |
| `RGOE_FROM_BLOCK` | `0x0` | Deploy / start block for `eth_getLogs` when reconstructing the member tree. | root-provider (node) | (none) |
| `RGOE_CONFIRMATIONS` | `0` | Confirmation depth. `0` reads `latest` (stake) / `finalized` (roots); `>0` reads `head - N` for reorg safety. | gateway-registry, root-provider | (none) |
| `RGOE_REGISTER_KEY` | anvil account #0 (member) / #1 (gateway) | Funding / operator private key used to submit the stake tx. `exit-gateway` / `withdraw-gateway` reuse it as the operator signer (falling back to `RGOE_GW_OPERATOR_KEY`; the anvil default applies only on a loopback RPC). Prefer `--key-file` / `--account` on a real chain. | register-onchain, register-gateway, exit-gateway, withdraw-gateway | `--register-key` |
| `RGOE_KEYSTORE_PASSWORD` | (unset → interactive prompt on a TTY) | Password for the Foundry-style encrypted keystore selected with `--account <name>` (`~/.foundry/keystores/<name>`, dir overridable via `FOUNDRY_KEYSTORES`) or `--keystore <path>`. Env only, never argv. | exit-gateway, withdraw-gateway, gateway-status | (none) |
| `RGOE_BOND` | on-chain `BOND()` (member also tries `deployed.bond`) | Bond amount in wei to stake. | register-onchain, register-gateway | `--bond` |

## Common

| Env var | Default | Controls | Component | Flag |
|---|---|---|---|---|
| `RGOE_NETWORK` | (unset) | Name of a committed network record under `network/<name>/`. Fills any UNSET discovery / contract var from `bootnode.json` (`RGOE_BOOTNODE_ONION`, `RGOE_DIR_SIGNER`, `RGOE_BOOTNODE_ADMISSION`, or the static `RGOE_DIRECTORY` fallback) and `contracts.json` (`RGOE_GATEWAY_REGISTRY`, `RGOE_GROUP_CONTRACT`, `RGOE_PAID_ACCESS_CONTRACT` from `contracts.paidAccessSet`, `RGOE_RPC_URL`). Explicit env/flags always win. See `network/README.md`. | `rgoe` (all commands), client selection, heartbeat, gateway-registry, register-gateway, uptime probe | `--network` |
| `RGOE_RPC_URL` | `http://127.0.0.1:8545` (register scripts try `deployed.rpcUrl` first) | JSON-RPC endpoint for all on-chain reads/writes. | gateway-registry, root-provider, gateway slasher, register-* | `--rpc-url` |
| `RGOE_TOR_HOST` | `127.0.0.1` | Local Tor SOCKS host. | heartbeat, client, selection | `--tor-host` |
| `RGOE_TOR_PORT` | `9250` | Local Tor SOCKS port. | heartbeat, client, selection | `--tor-port` |
| `RGOE_EPOCH_SECONDS` | `120` | Epoch length in seconds (the nullifier/rate window). Must match on client and gateway. | lib/rln (client + gateway) | `--epoch-seconds` |

## Deploy (`bootnode/deploy/bootstrap.sh`)

Read only by the one-command droplet bring-up (not by any `rgoe` process). They shape the torrc include + systemd units the script writes; the units then carry the runtime `RGOE_*` values above as `Environment=` lines. Full table + rationale: `bootnode/deploy/README.md` "Tunables".

| Env var | Default | Controls |
|---|---|---|
| `RGOE_ENABLE_POW` | `0` | `HiddenServicePoWDefensesEnabled` on every onion this box publishes (per-HS line, right after `HiddenServicePort`). Off by default: a client tor without the `pow` module (Homebrew, `pow: no`) could not connect to a PoW onion; matches the agent-devops role default. |
| `RGOE_BOOTNODE_ONION` | (unset = this box runs its own bootnode) | Gateway-only mode: install tor + gateway + heartbeat only, heartbeat announces to this remote bootnode. |
| `RGOE_BOOTNODE_SIGNER` | (unset) | Gateway-only: remote bootnode's pinned signer, echoed into the printed client command. |
| `RGOE_GATEWAY_REGION` | (unset) | Written into the heartbeat unit (see Bootnode/heartbeat rows above). |
| `RGOE_ADMISSION` | `open` | Becomes `RGOE_BOOTNODE_ADMISSION` on the bootnode unit. |
| `RGOE_REPO` / `RGOE_REF` / `RGOE_DIR` / `RGOE_BOOTNODE_PORT` / `RGOE_GATEWAY_PORT` | see script header | Clone source, install dir, loopback backend ports. |
| `RGOE_RENDER_ONLY` | (unset) | `<dir>`: render the torrc + units under `<dir>/etc/…` and exit (no root, nothing installed); `--render <dir>` is the same. |

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

## Client directory freshness bound (T-FEAT-21)

Read by `client/selection.mjs`. OPTIONAL, OFF by default — leave unset and directory loading behaves
exactly as before (legitimate long-lived static-file directories are unaffected).

The monotonic issued FLOOR (loop-15) refuses a directory whose `issued` moves BACKWARD within a
session, but on a COLD start a fresh client accepts whatever `issued` the bootnode first serves — so a
bootnode replaying a months-old (but validly signed) directory to a new client is undetectable. Arming
the max-age bound rejects a FRESH directory (not the last-known-good cache) whose `issued` is older
than `now - RGOE_DIRECTORY_MAX_AGE_MS`, failing closed to the last-good in-memory fleet / cache.

| Env var | Default | Controls | Component | Flag |
|---|---|---|---|---|
| `RGOE_DIRECTORY_MAX_AGE_MS` | (unset → no bound) | Max age (ms) a FRESH directory's `issued` may be before it is rejected as stale. Unset / non-positive => check disabled. | client selection | (none) |
| `RGOE_DIRECTORY_MAX_AGE_SKEW_MS` | `300000` (5 min) | Clock-skew grace added on top of the bound so a lagging client clock doesn't spuriously reject a just-issued directory. Only consulted when the bound is armed. | client selection | (none) |

Note: directory `issued` is in SECONDS (the bootnode signs `Math.floor(Date.now()/1000)`); the bound is
in MILLISECONDS. `client/selection.mjs` scales `issued` by 1000 before comparing, matching the unit the
rollback floor uses.

## Client receipt reputation → quality-aware selection (T-FEAT-22)

Read by `client/selection.mjs`. OPTIONAL, OFF by default — leave `RGOE_RECEIPT_SCORING` unset and
selection is byte-for-byte today's weight-only behavior (no tally file is written, `reportReceipt` is a
no-op). Even with the flag armed, a fleet with no receipt evidence yet produces an identity adjustment,
so arming it alone changes nothing until real receipts arrive.

T-FEAT-13 gives the client a verifiable per-epoch egress-success receipt from each gateway. With scoring
armed, the client folds each verified-or-bogus receipt outcome into a SMALL, LOCAL, per-gateway quality
tally sitting next to the gateway-health cache: a gateway that keeps returning VALID receipts earns a
modest weight bonus; one that returns BAD receipts (present but bogus — the gate-then-drop signal) is
deprioritized. A gateway simply running with receipts OFF sends none and is never entered into the tally
or penalized (fully additive).

Privacy: the tally stores ONLY the gateway `.onion` (already learned from the SIGNED directory) plus
three locally-computed numbers — a decaying quality EWMA in `[0,1]`, a bounded sample count, and a
`lastSeen` wall-clock. It NEVER stores receipt bytes, the receipt's epoch, or anything tied to a specific
request, and is never transmitted anywhere — the same never-sent, local-only discipline as the health
cache. Schema: `onion -> { score, samples, lastSeen }`.

| Env var | Default | Controls |
|---|---|---|
| `RGOE_RECEIPT_SCORING` | (unset → OFF) | Arm the feature: `1`/`on`/`true`/`yes` enables it; anything else (or unset) is OFF. |
| `RGOE_RECEIPT_CACHE` | `cache/gateway-receipts.json` (gitignored) | Tally file path. `""`/`off`/`0` disables persistence (in-memory only). |
| `RGOE_RECEIPT_MAX` | `512` | Max distinct gateways retained; oldest-`lastSeen` evicted first (bounded). |
| `RGOE_RECEIPT_DECAY_MS` | `1209600000` (14 days) | A tally not updated for this long is treated as decayed → neutral (no bonus, no penalty): a gateway is never punished forever. |
| `RGOE_RECEIPT_ALPHA` | `0.3` | EWMA weight on the newest outcome (mirrors the health latency EWMA). |
| `RGOE_RECEIPT_BONUS` | `0.5` | Max fractional weight swing at full confidence + extreme score (±50%). |
| `RGOE_RECEIPT_CONFIDENCE_N` | `4` | Samples needed for full confidence, so one good receipt is not decisive. |

Integration seam: `client/selection.mjs` exposes `reportReceipt(onion, { valid })` (mirroring
`reportResult(onion, { ok, latencyMs })`). The one-line call site — added later in
`client/rgoe-client.mjs`, immediately after `_verifyReceipt` — is
`if (receipt.present) reportReceipt(usedOnion, { valid: receipt.valid === true });`.

## Client rotation / load spread (T-FEAT-4)

Read by `client/selection.mjs`. OPTIONAL, OFF by default — leave `RGOE_ROTATION_SPREAD` unset and
slot-0 selection is byte-for-byte today's independent weighted-random draw per CONNECT.

By default each CONNECT re-rolls slot-0 (the gateway the shim actually dials) as a fresh weighted-random
draw: memoryless, so the top-weight gateway keeps winning back-to-back and equal-weight peers see bursty,
clumped load. With spread armed, slot-0 is chosen by a smooth weighted round-robin (SWRR) over the SAME
healthy, weight-clamped, receipt-adjusted pool the failover order already selects from. SWRR keeps a
per-gateway in-memory "current deficit" that advances every CONNECT, giving two properties: (1) the
just-used gateway drops below its peers and is not re-picked until they have had their proportional turn
— load spreads evenly across the healthy fleet, no back-to-back hammering (equal weights => strict
round-robin, zero immediate repeats); and (2) over each full cycle a gateway is selected exactly in
proportion to its effective weight, so the long-run weighted (and receipt-adjusted) share is preserved —
spread changes the ORDER, never the marginal distribution. Deficits are seeded with a small rng jitter so
two clients loading the same fleet don't emit an identical, cross-linkable sequence.

No new persistence store: the SWRR deficits are in-memory session state (like the live health signal),
and the failover TAIL (only consulted on a dial timeout) stays weighted-random via the existing
selection order. Reuses the health (`"down"`) + receipt-adjusted weight signals already in the module.

| Env var | Default | Controls | Component | Flag |
|---|---|---|---|---|
| `RGOE_ROTATION_SPREAD` | (unset → OFF) | Arm smooth weighted round-robin slot-0 spread: `1`/`on`/`true`/`yes` enables it; anything else (or unset) is OFF (today's weighted-random). | client selection | (none) |
