# Deploy: a bootnode + gateway on a fresh droplet

One command on a rented Ubuntu 24.04 box brings up the whole thing: Tor (Tor Project build,
`pow: yes` available), the discovery [bootnode](../../docs/BOOTNODE.md), a reputation-gated
[gateway](../../gateway/gateway.mjs), and a heartbeat that keeps the gateway announced. You rent
the box; `bootstrap.sh` does the rest. Set `RGOE_BOOTNODE_ONION` to get a **gateway-only** box
that joins an existing bootnode instead (see Tunables).

## Run it

```bash
ssh root@<droplet-ip>
curl -fsSL https://raw.githubusercontent.com/dmarzzz/reputation-gated-onion-egress/main/bootnode/deploy/bootstrap.sh | sudo bash
```

or, if you already cloned the repo on the box:

```bash
sudo bash bootnode/deploy/bootstrap.sh
```

It prints the **bootnode onion**, the **pinned signer pubkey**, the **gateway onion**, and
the exact `rgoe client …` command to hand out. Re-running is safe (keys and units are reused).

## What it installs

- **Node 24** (NodeSource; a pre-installed Node < 24 is upgraded — under the units'
  `SystemCallFilter=@system-service` Node 20 dies with `SIGSYS` on `pkey_alloc`, Node 24 does not)
  and **Tor** (official Tor Project repo, so the onion PoW DoS
  defense is *available*; it is **off by default**, `RGOE_ENABLE_POW=1` turns it on).
- A `rgoe` service user and the repo at `/opt/rgoe`.
- Onion identities minted once into `/opt/rgoe/deploy-state/` and copied into Tor's own HS
  dirs (`bootnode/keygen.mjs`).
- Three systemd units: `rgoe-bootnode`, `rgoe-gateway`, `rgoe-heartbeat` — all `Restart=always`.
  (Gateway-only mode: two units, no `rgoe-bootnode`. `RGOE_HELIOS=1` adds a fourth,
  `rgoe-helios`, plus the sha256-pinned `helios` binary at `/usr/local/bin/helios`.)
- A `torrc` include publishing two onions (bootnode → `:8877`, gateway → `:8443`), each block
  carrying `HiddenServicePoWDefensesEnabled <RGOE_ENABLE_POW>` right after its `HiddenServicePort`
  (it is a per-service option). Gateway-only mode publishes the gateway onion only.

## Tunables

All are env vars on the `curl | bash` / `sudo bash` line. Every value is validated up front and
the script exits before installing anything on a bad one.

| env | default | meaning |
|---|---|---|
| `RGOE_REPO` / `RGOE_REF` | public repo / `main` | what to clone onto the box |
| `RGOE_DIR` | `/opt/rgoe` | install dir; `deploy-state/` under it holds keys + persistence |
| `RGOE_ADMISSION` | `open` | bootnode admission (`open` \| `stake`); ignored in gateway-only mode |
| `RGOE_BOOTNODE_PORT` / `RGOE_GATEWAY_PORT` | `8877` / `8443` | loopback backends the onions map to |
| `RGOE_ENABLE_POW` | `0` | `1` = `HiddenServicePoWDefensesEnabled 1` on every HS block this box publishes; `0` = off. **Default off** because a client tor built without the `pow` module (the Homebrew bottle reports `pow: no`) could not reach a PoW-enabled onion at all (`docs/DEPLOYMENT.md` "PoW capability mismatch"), and the `agent-devops` fleet role defaults `rgoe_enable_pow: false` for the same reason. Turn it on once every client you serve runs a pow-capable tor. Flip later by editing `/etc/tor/torrc.d-rgoe` + `systemctl reload tor` (onions/keys unchanged). Also accepts `true/false/yes/no/on/off`. |
| `RGOE_BOOTNODE_ONION` | *(unset = run our own bootnode)* | **Gateway-only mode.** A v3 onion (56 base32 chars, `.onion` optional): the box installs ONLY tor + `rgoe-gateway` + `rgoe-heartbeat`, mints only the gateway identity, publishes only the gateway HS, and the heartbeat announces to *that* remote bootnode. Re-running a former bootnode+gateway box in this mode disables and removes its `rgoe-bootnode` unit. |
| `RGOE_BOOTNODE_SIGNER` | *(unset)* | gateway-only only: the remote bootnode's pinned signer pubkey, printed into the client command at the end. The heartbeat itself does not need it. |
| `RGOE_GATEWAY_REGION` | *(unset = not advertised)* | `na sa eu af as oc aq unknown`: coarse region bucket the heartbeat advertises in signed caps (`docs/CONFIG.md`). Written as `Environment=` into `rgoe-heartbeat.service`. |
| `RGOE_HELIOS` | `0` | **Opt-in Helios light-client sidecar** (T-DEV-9b, `docs/LIGHT-CLIENT.md`). `1` = download the pinned [a16z/helios](https://github.com/a16z/helios) release (`RGOE_HELIOS_VERSION`, default `0.11.1`; `helios_linux_{amd64,arm64}.tar.gz`, sha256 verified against the table in `bootstrap.sh` before install), render + start a hardened `rgoe-helios.service` (loopback `127.0.0.1:RGOE_HELIOS_PORT`, endpoints via `EXECUTION_RPC`/`CONSENSUS_RPC` env so keys stay out of `ps`, same sandbox as the other units plus `MemoryDenyWriteExecute`), and set `RGOE_ROOT_PROVIDER=light` + `RGOE_HELIOS_RPC_URL` + `RGOE_RPC_URL` + `RGOE_GROUP_CONTRACT` on `rgoe-gateway.service` (ordered after the sidecar). The admission root is then anchored to the beacon sync committee — the RPC can withhold but not lie. Re-running with `0` disables and removes the unit. Also accepts `true/false/yes/no/on/off`. |
| `RGOE_HELIOS_CONSENSUS_RPC` | *(unset)* | **required with `RGOE_HELIOS=1`**: beacon API URL serving the light-client endpoints (`/eth/v1/beacon/light_client/…`). Sepolia has no built-in default; `https://lodestar-sepolia.chainsafe.io` worked on 2026-08-17 (publicnode's beacon API did not). |
| `RGOE_RPC_URL` | *(unset)* | **required with `RGOE_HELIOS=1`**: execution JSON-RPC (http(s)/ws(s)); the sidecar's `EXECUTION_RPC` and the gateway's `RGOE_RPC_URL`. Must serve `eth_getProof` at the **finalized** block (own node / archive-capable provider; public RPCs' ~32-block proof windows are shorter than finality). If the URL carries an API key, prefer a root-only drop-in (`systemctl edit rgoe-helios` / `rgoe-gateway`) over the world-readable unit. |
| `RGOE_GROUP_CONTRACT` | *(unset)* | **required with `RGOE_HELIOS=1`**: `StakedReputationSet` address the gateway reads roots from (`0x` + 40 hex). Written as `Environment=` into `rgoe-gateway.service`. |
| `RGOE_HELIOS_NETWORK` | `sepolia` | `mainnet` \| `sepolia` \| `holesky` — helios `--network`. |
| `RGOE_HELIOS_PORT` | `8546` | sidecar loopback RPC port (1024..65535); `8545` is left free for a local node. `RGOE_HELIOS_RPC_URL` on the gateway follows it. |
| `RGOE_HELIOS_CHECKPOINT` | *(unset)* | weak-subjectivity checkpoint: a recent **finalized** beacon block root (`0x` + 64 hex, e.g. `GET <beacon>/eth/v1/beacon/headers/finalized` → `data.root`, cross-checked against a second source). Unset = helios `--load-external-fallback` (fetches one from public checkpoint services). Pinning is the more trust-minimized bootstrap. |
| `RGOE_HELIOS_VERSION` / `RGOE_HELIOS_SHA256` | `0.11.1` / *(pinned table)* | release to install; a version without a pinned sha256 in `bootstrap.sh` must pass `RGOE_HELIOS_SHA256=<sha256 of helios_linux_<arch>.tar.gz>` — there is no unpinned download. Unsupported arch (only amd64/arm64 are pinned) ⇒ the script stops and tells you to install `helios` at `/usr/local/bin/helios` by hand and re-run. |
| `RGOE_ADMIT` | `invited` | **Admission policy** (T-FEAT-9, `docs/adr/0008`): `invited[,staked][,paid]`, normalized to the canonical anonymity order (`invited,staked,paid`). Rendered into BOTH `rgoe-gateway.service` (enforced by `gateway/gateway.mjs`: these are the ONLY root sources + slash targets; a named path whose contract is missing fails closed at startup) and `rgoe-heartbeat.service` (advertised as signed `caps.admits`, so clients route only to gateways that admit their leaf source). Default `invited` alone = the maximum-anonymity mode (members.json only, no contract, no RPC). `staked` needs `RGOE_GROUP_CONTRACT`, `paid` needs `RGOE_PAID_ACCESS_CONTRACT`, either needs `RGOE_RPC_URL` — validated up front and rendered into the gateway unit. `RGOE_HELIOS=1` requires `staked`; `RGOE_REGISTRAR=1` requires `paid`. The default golden render gained `Environment=RGOE_ADMIT=invited` in both units. |
| `RGOE_REGISTRAR` | `0` | **Opt-in 402 registrar** (T-FEAT-7, `docs/PAYMENTS.md` "Shipped 2026-08-17"): `1` = render + start a hardened `rgoe-registrar.service` (`payments/registrar.mjs` on `127.0.0.1:RGOE_REGISTRAR_PORT`; same sandbox as the other Node units; order store under `deploy-state/`), publish it as an **extra virtual port of an onion this box runs** (`HiddenServicePort <port> 127.0.0.1:<port>` inside the BOOTNODE HS block on a bootnode+gateway box, so buyers reach `http://<bootnode-onion>:<port>/pay/quote`; or — T-FEAT-9 — inside the GATEWAY HS block on a gateway-only box, `RGOE_BOOTNODE_ONION` set, so buyers reach `http://<gateway-onion>:<port>/pay/quote`), set `RGOE_REGISTRAR_ADVERTISE=1` (+ asset/prices/chain/protocols) on `rgoe-bootnode.service` (when present) so `/health` carries `pay: {port, protocols, asset, chain, tiers}`, AND the same advert (+ `RGOE_REGISTRAR_ONION`) on `rgoe-heartbeat.service` so the gateway's signed caps carry `pay`. Requires `paid` in `RGOE_ADMIT`. Re-running with `0` disables and removes the unit. The unit is **enabled but not started** until the operator key drop-in exists (see below). Also accepts `true/false/yes/no/on/off`. |
| `RGOE_PAY_PROTOCOLS` | `x402,mpp` | With `RGOE_REGISTRAR=1`: the rails this registrar serves + advertises (`x402,mpp` / `x402` / `mpp`; normalized to `x402,mpp` order; rendered into the registrar unit, the bootnode advert and the heartbeat advert). A disabled rail gets no 402 challenge and its payload is refused `400 protocol-disabled`. |
| `RGOE_PAID_ACCESS_CONTRACT` | *(unset)* | **required with `RGOE_REGISTRAR=1`**: `PaidAccessSet` address the registrar inserts into (`network/sepolia/contracts.json` `contracts.paidAccessSet`). |
| `RGOE_PAY_ASSET` | *(unset)* | **required with `RGOE_REGISTRAR=1`**: EIP-3009 stablecoin address (Sepolia USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, or the test tUSD in `contracts.json` `payAsset`). |
| `RGOE_PAY_PRICES` | *(unset)* | **required with `RGOE_REGISTRAR=1`**: `<limit>=<atomic amount>[,…]`, e.g. `8=100000,32=400000`. |
| `RGOE_RPC_URL` | *(unset)* | **required with `RGOE_REGISTRAR=1`** (and with `RGOE_HELIOS=1`, and with `staked`/`paid` in `RGOE_ADMIT`): the JSON-RPC the registrar settles/inserts through and the gateway reads on-chain roots through. |
| `RGOE_GROUP_CONTRACT` | *(unset)* | **required with `staked` in `RGOE_ADMIT`** (and with `RGOE_HELIOS=1`): `StakedReputationSet` address(es), rendered into the gateway unit. |
| `RGOE_PAY_TO` / `RGOE_REGISTRAR_PORT` / `RGOE_PAY_CHAIN_ID` | *(operator address)* / `8878` / `11155111` | stablecoin recipient / loopback+onion port / chain id advertised in `/health`. |
| `RGOE_FROM_BLOCK` / `RGOE_FROM_BLOCKS` | *(unset = not rendered)* | `eth_getLogs` start block(s) for the gateway's on-chain root scans (`<block>` / `<0xaddr>=<block>,…`), written as `Environment=` into `rgoe-gateway.service` when given. Usually unnecessary: the gateway pages the scan and starts at each contract's deploy block from the network record (`docs/OPERATOR.md` "Public RPC log-range caps"). |
| `RGOE_RENDER_ONLY` | *(unset)* | `<dir>`: **render mode** — write the torrc include + units under `<dir>/etc/…` with placeholder onions and exit; no root, no apt, no tor/node install, no clone, no `systemctl`. `bootstrap.sh --render <dir>` is the same. This is what `bootstrap.selftest.mjs` drives. |

`RGOE_GW_OPERATOR_KEY` (staked bootnodes) is a secret and deliberately **not** a tunable: add it
to the heartbeat unit by hand after staking (see "Turn on staking"). Likewise
`RGOE_REGISTRAR_KEY` (the 402 registrar's operator key): after `RGOE_REGISTRAR=1`, install it as a
0600 drop-in via stdin and start the unit —

```bash
install -d -m 0755 /etc/systemd/system/rgoe-registrar.service.d
printf '[Service]\nEnvironment=RGOE_REGISTRAR_KEY=%s\n' "$(cat /path/to/key)" \
  | install -m 0600 /dev/stdin /etc/systemd/system/rgoe-registrar.service.d/operator.conf
systemctl daemon-reload && systemctl restart rgoe-registrar
curl --socks5-hostname 127.0.0.1:9050 "http://<bootnode-onion>:8878/pay/quote?limit=8"   # 402 + both challenges
```

(`docs/OPERATOR.md` "Selling access via 402" has the full runbook.)

### Add a second gateway to an existing bootnode

```bash
RGOE_BOOTNODE_ONION=<bootnode>.onion RGOE_BOOTNODE_SIGNER=<pinned-signer> \
  bash bootnode/deploy/bootstrap.sh
journalctl -u rgoe-heartbeat -f          # 'announced (...)' once the descriptors propagate
```

Same idempotence rules: re-running reuses the gateway identity and units.

Choose what this gateway admits and sells (T-FEAT-9, `docs/OPERATOR.md` "Choose what you admit and
what you sell"): the default is `invited` (members.json only). A gateway-only box that ALSO sells
access on its own onion, with its own `PaidAccessSet`:

```bash
RGOE_BOOTNODE_ONION=<bootnode>.onion RGOE_BOOTNODE_SIGNER=<pinned-signer> RGOE_ADMIT=invited,paid RGOE_REGISTRAR=1 RGOE_PAY_PROTOCOLS=x402 RGOE_PAID_ACCESS_CONTRACT=0x… RGOE_PAY_ASSET=0x… RGOE_PAY_PRICES=8=100000,32=400000 RGOE_RPC_URL=https://…   bash bootnode/deploy/bootstrap.sh
# -> torrc: HiddenServicePort 8878 inside the GATEWAY HS block; rgoe-registrar.service on this box;
#    the heartbeat advertises admits=[invited,paid] + pay{protocols:[x402],…} as signed caps
```

### Render mode (review / tests, no root)

```bash
bash bootnode/deploy/bootstrap.sh --render /tmp/r && find /tmp/r -type f
RGOE_ENABLE_POW=1 RGOE_BOOTNODE_ONION=<onion> bash bootnode/deploy/bootstrap.sh --render /tmp/r2
RGOE_HELIOS=1 RGOE_ADMIT=invited,staked RGOE_HELIOS_CONSENSUS_RPC=https://… RGOE_RPC_URL=https://… RGOE_GROUP_CONTRACT=0x… \
  bash bootnode/deploy/bootstrap.sh --render /tmp/r3     # + rgoe-helios.service, gateway unit pointed at it
RGOE_ADMIT=invited,staked,paid RGOE_GROUP_CONTRACT=0x… RGOE_PAID_ACCESS_CONTRACT=0x… RGOE_RPC_URL=https://… \
  bash bootnode/deploy/bootstrap.sh --render /tmp/r4     # gateway + heartbeat units carry RGOE_ADMIT; gateway unit carries the contracts + RPC
node bootnode/deploy/bootstrap.selftest.mjs   # golden default + PoW on/off + gateway-only + helios + registrar + admission assertions
```

The default render is frozen in `bootnode/deploy/golden/default/`; a deliberate change to what
the deploy writes is regenerated with `RGOE_UPDATE_GOLDEN=1 node bootnode/deploy/bootstrap.selftest.mjs`
and reviewed as a diff.

## Systemd hardening

All units (the optional `rgoe-helios` too, which additionally sets `MemoryDenyWriteExecute=true`
since helios is a Rust binary with no JIT) run under a sandboxed `[Service]` section: `NoNewPrivileges`,
`ProtectSystem=strict` (with `ReadWritePaths=/opt/rgoe/deploy-state` so the minted signer key,
persistence store, and onion identities stay writable), `ProtectHome`, `PrivateTmp`,
`ProtectKernel{Tunables,Modules}`, `ProtectControlGroups`,
`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` (Node + the Tor SOCKS socket),
`RestrictNamespaces`, `LockPersonality`, `SystemCallFilter=@system-service` (a vetted allowlist
that excludes `@privileged`/`@mount`/`@module`/etc.), an empty `CapabilityBoundingSet=` (all caps
dropped — the services bind only loopback high ports), and `MemoryMax=512M` / `TasksMax=256`
resource caps. `MemoryDenyWriteExecute` is intentionally omitted because it breaks V8's JIT.

Verify after deploy with e.g. `systemd-analyze security rgoe-bootnode` (same for `rgoe-gateway`
and `rgoe-heartbeat`) — expect an "OK"/hardened exposure score around ~2.x, down from the ~9.6
"UNSAFE" default of an unsandboxed unit.

## Firewall

The gateway and bootnode are onion services — they take **no inbound clearnet ports**. A
UFW policy of inbound-22-only + outbound-allow is correct and sufficient. Do not open the
loopback backends (8877 / 8443) to the internet.

## Turn on staking (optional)

`bootstrap.sh` runs `--admission open` by default. To require a gateway stake:

1. Deploy `GatewayRegistry` (see `script/Deploy.s.sol`) and set `RGOE_GATEWAY_REGISTRY` +
   `RGOE_RPC_URL` + `RGOE_STAKE_MODE=onchain` on the `rgoe-bootnode` unit; set
   `RGOE_BOOTNODE_ADMISSION=stake`.
2. Stake the gateway operator: `rgoe register-gateway` with the operator key funded on that
   chain.
3. Add `RGOE_GW_OPERATOR_KEY=<operator-key>` to the `rgoe-heartbeat` unit so the heartbeat
   signs the durable onion↔operator authorization.

See [docs/BOOTNODE.md](../../docs/BOOTNODE.md) and [docs/CONFIG.md](../../docs/CONFIG.md).

## Files

| file | purpose |
|---|---|
| `bootstrap.sh` | the one-command bring-up (idempotent); `--render <dir>` = write configs only |
| `bootstrap.selftest.mjs` | offline render assertions: golden default, `RGOE_ENABLE_POW` on/off, gateway-only mode, `RGOE_HELIOS` sidecar render, input validation |
| `golden/default/` | the frozen default render (torrc include + 3 units) |
| `e2e-container.sh` | systemd-in-container e2e (`E2E_MODE=gateway-only` for the remote-bootnode mode) |

Systemd units and the `torrc` include are generated by `bootstrap.sh` (self-contained; no
templates to keep in sync — the render mode + golden are the check that they stay right).
