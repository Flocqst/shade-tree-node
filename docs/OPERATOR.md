# Operator runbook

For running a gateway or a bootnode in production. Every command here exists in
`bin/rgoe.mjs` or the deploy scripts. For the full config surface see
[CONFIG.md](CONFIG.md); for the discovery design see [BOOTNODE.md](BOOTNODE.md).

Two ways to invoke the CLI:

- Workstation with the repo: `npm link` once, then `rgoe <cmd>`.
- On a bootstrapped droplet (repo at `/opt/rgoe`, not linked): run it explicitly,
  e.g. `sudo -u rgoe node /opt/rgoe/bin/rgoe.mjs <cmd>`.

`rgoe help` lists commands; `rgoe <cmd> --help` prints one-line help. Every `--flag`
just sets the matching `RGOE_*` env var (see [CLI.md](CLI.md)).

Note the two Tor SOCKS ports: the local-dev repo Tor runs SOCKS on **9250**; a
droplet bootstrapped by `bootstrap.sh` uses the **system Tor on 9050**. The curl
examples below use 9050 (droplet). Adjust for local dev.

---

## 1. Deploy a gateway + bootnode

One command on a fresh Ubuntu 24.04 box. It installs Node 24 + Tor (official repo,
so onion PoW is available), mints the onion identities, writes and starts the
systemd units, and prints the bootnode onion, its pinned signer, the gateway onion,
and the client command. Idempotent (re-running reuses keys and units).

```bash
ssh root@<droplet-ip>
curl -fsSL https://raw.githubusercontent.com/dmarzzz/reputation-gated-onion-egress/feat/bootnode-and-productionize/bootnode/deploy/bootstrap.sh | sudo bash
```

Or, if the repo is already on the box:

```bash
sudo bash bootnode/deploy/bootstrap.sh
```

It creates three `Restart=always` units:

| unit | what it runs | source |
|---|---|---|
| `rgoe-bootnode` | discovery service | `bootnode/server.mjs` |
| `rgoe-gateway` | reputation-gated egress | `gateway/gateway.mjs` |
| `rgoe-heartbeat` | announces the gateway to the local bootnode | `bootnode/heartbeat.mjs` |

Tunables are env vars on the `curl | bash` line, e.g. `RGOE_ADMISSION=stake`,
`RGOE_BOOTNODE_PORT`, `RGOE_GATEWAY_PORT`, `RGOE_DIR`.

Firewall: the gateway and bootnode are onion services and take **no inbound clearnet
ports**. Inbound-22-only + outbound-allow (UFW) is correct. Never expose the loopback
backends (8877 / 8443).

Wait ~30s for descriptor propagation, then verify (see day-2 below).

---

## 2. Join the fleet as a new gateway operator

If you did not use `bootstrap.sh` (bringing your own host, or adding a second gateway
against an existing bootnode):

### a. Mint an onion identity

```bash
rgoe keygen tor/hs-gateway --label gateway
```

This writes Tor's HS key files (`hs_ed25519_secret_key`, `hs_ed25519_public_key`,
`hostname`) plus `identity.local.json` (the announce-signing seed) into the dir. Point
your Tor daemon's `HiddenServiceDir` at it with `HiddenServicePort 80 127.0.0.1:8443`.

### b. (Optional) stake the operator

Only needed for a `--admission stake` bootnode, or to fund the address that pays gas
to slash member over-spenders. Stake binds to the operator **address**, never to an
onion (one stake can back rotating onions).

```bash
rgoe register-gateway \
  --gateway-registry 0x<GatewayRegistry> \
  --register-key 0x<operator-key> \
  --rpc-url https://<rpc-endpoint>
```

`--bond` is optional (defaults to the on-chain `BOND()`). The command is a no-op if
the operator is already staked.

### c. Run the gateway and heartbeat

```bash
rgoe gateway                                    # the egress; verifies proofs, tunnels :443

rgoe heartbeat \
  --bootnode <bootnode-onion> \
  --identity tor/hs-gateway/identity.local.json
```

For a staked bootnode, add the operator key so the heartbeat signs the durable
onion<->operator authorization:

```bash
RGOE_GW_OPERATOR_KEY=0x<operator-key> rgoe heartbeat \
  --bootnode <bootnode-onion> \
  --identity tor/hs-gateway/identity.local.json
```

The heartbeat re-announces every `--interval` seconds (default 300). Confirm you are
listed:

```bash
curl --socks5-hostname 127.0.0.1:9050 http://<bootnode-onion>/directory
```

---

## 3. Day-2 operations

### Health

```bash
systemctl status rgoe-bootnode rgoe-gateway rgoe-heartbeat

# over Tor (droplet SOCKS = 9050):
curl --socks5-hostname 127.0.0.1:9050 http://<bootnode-onion>/health      # liveness + count + admission
curl --socks5-hostname 127.0.0.1:9050 http://<bootnode-onion>/directory   # current signed directory

# local sanity (node, tor, deps, keys):
rgoe doctor
```

`rgoe doctor` is read-only; it flags a missing Tor daemon, missing deps, missing onion
identity, and whether on-chain mode is configured.

### Logs

```bash
journalctl -u rgoe-gateway   -f
journalctl -u rgoe-bootnode  -f
journalctl -u rgoe-heartbeat -f
```

### Normal log lines

Gateway on startup:

```
gateway up on 127.0.0.1:8443  (epoch <n>, 120s)
egress policy: :443 only (metadata-only TLS tunnel)
root source: members.json (PoC fallback), <n> members     # or "on-chain RootProvider ..."
```

A served request (PASS) and a rejected one (DROP):

```
PASS  egress->api.ipify.org:443  null=0x1234abcd.. extNull=0x5678ef01..
DROP  root-not-recent  target=example.com:443
DROP  rate-slashed  null=0x1234abcd..
```

`PASS` = proof verified, tunnel opened. `DROP` = the request was rejected; the reason
token (`root-not-recent`, `bad-target`, `rate-slashed`, `over-spend-slashed`, ...) says
why. Heartbeat lines look like `announced (staked=false, ttl=900s)`.

---

## 4. Key management

Three secrets. All are gitignored (`identity.local.json`, `hs_ed25519_secret_key`,
`bootnode-signer.key`) and never leave the box on their own.

| secret | where (droplet) | what it is |
|---|---|---|
| gateway onion seed | `deploy-state/gateway-hs/identity.local.json` (+ Tor's copy in `/var/lib/tor/rgoe-gateway/`) | the 32-byte seed behind the onion; signs announces. Losing it loses the onion address. |
| bootnode onion seed | `deploy-state/bootnode-hs/identity.local.json` (+ `/var/lib/tor/rgoe-bootnode/`) | same, for the bootnode onion. |
| bootnode signer key | `deploy-state/bootnode-signer.key` | the `{pub,priv}` that signs the directory. The `pub` is what clients pin as `--dir-signer`. |
| operator EOA key | operator's wallet (env `RGOE_GW_OPERATOR_KEY` / `RGOE_REGISTER_KEY`, `RGOE_SLASH_KEY`) | funds the stake and pays slash gas. Keep it off the box where possible. |

Locally (non-bootstrapped) the same files live under `tor/hs*/identity.local.json` and
`bootnode/bootnode-signer.key`.

### Backup

**Manual for now** (no backup tooling is shipped). Copy the seed files off-box,
encrypted. Example:

```bash
sudo tar czf - \
  /opt/rgoe/deploy-state/bootnode-hs/identity.local.json \
  /opt/rgoe/deploy-state/gateway-hs/identity.local.json \
  /opt/rgoe/deploy-state/bootnode-signer.key \
  | gpg --symmetric --cipher-algo AES256 -o rgoe-keys-$(date +%F).tar.gz.gpg
# then move rgoe-keys-*.tar.gz.gpg to an off-box, encrypted-at-rest location.
```

Restore by placing the files back before starting the units; the onion address and
pinned signer are preserved, so clients keep working. The operator EOA key is backed up
with your normal wallet backups, not here.

---

## 5. Respond to a member over-spend / slash

An over-spend is a member reusing a per-epoch rate slot: two RLN signals under the same
nullifier with distinct evaluation points. The gateway detects it cryptographically and
slashes automatically. No operator action is required for the slash itself; your job is
to confirm it landed.

What the gateway logs on the offending request:

```
DROP  over-spend-slashed  null=0x1234abcd..
SLASH tx 0x<hash> commitment=0x0123456789abcd.. (waiting)
SLASH mined block <n> commitment=0x0123456789abcd..
```

Subsequent requests on that nullifier log `DROP  rate-slashed  null=...`.

If slashing is not configured you instead see a dry-run and **no on-chain tx**:

```
slash: DRY-RUN (set RGOE_SLASH_KEY + deployed.local.json/RGOE_GROUP_CONTRACT to submit on chain)
SLASH (dry-run) commitment=0x0123456789abcd.. secret=0x89abcdef..
```

To slash for real, the gateway needs `RGOE_SLASH_KEY` (a hot key, separate from any
member secret) and a slash contract (`RGOE_SLASH_CONTRACT`, or `contracts/deployed.local.json`);
`ethers` must be installed. Optional `RGOE_SLASH_RECEIVER` sets who receives the bond
(defaults to the slasher wallet).

Verify:

```bash
journalctl -u rgoe-gateway | grep SLASH          # find the tx hash
# then confirm on chain with your explorer or:
cast tx 0x<hash> --rpc-url https://<rpc-endpoint>   # foundry; check it was mined and reverted=false
```

Confirm the member's stake in `StakedReputationSet` moved to the receiver, and that the
over-spending member can no longer egress (repeated `DROP rate-slashed`).

---

## 6. Rotate or retire a gateway

Retiring a **staked** gateway is a two-step on-chain exit plus stopping the units. There
is **no `rgoe` wrapper for exit/withdraw yet (manual for now)** — use foundry `cast`
against `GatewayRegistry` (`contracts/GatewayRegistry.sol`).

1. Start the unbonding clock (operator-only). You stay slashable for the whole
   `UNBONDING` window, so you cannot exit-then-dodge a slash:

   ```bash
   cast send 0x<GatewayRegistry> "initiateExit()" \
     --private-key 0x<operator-key> --rpc-url https://<rpc-endpoint>
   ```

   Check when the bond becomes withdrawable:

   ```bash
   cast call 0x<GatewayRegistry> "withdrawableAt(address)(uint256)" 0x<operator> \
     --rpc-url https://<rpc-endpoint>
   ```

2. Stop the units so the gateway stops announcing:

   ```bash
   systemctl disable --now rgoe-heartbeat rgoe-gateway
   # keep rgoe-bootnode running if this box is also the bootnode
   ```

3. The bootnode holds soft state with a TTL (`--ttl`, default 900s). Once the heartbeat
   stops, the entry ages out and clients stop selecting it. Clients cache the
   last-known-good directory, so the fleet degrades gracefully.

4. After the `UNBONDING` window, reclaim the bond:

   ```bash
   cast send 0x<GatewayRegistry> "withdraw(address)" 0x<recipient> \
     --private-key 0x<operator-key> --rpc-url https://<rpc-endpoint>
   ```

**Rotating** an onion (new address, same operator/stake): mint a new identity
(`rgoe keygen ...`), point Tor and the heartbeat at it, and let the old entry TTL out.
No re-staking needed; the stake is keyed to the operator address, not the onion.

An **unstaked** (`--admission open`) gateway is just steps 2-3: stop the units, let the
TTL expire.

---

## 7. Config reference

Full surface: [CONFIG.md](CONFIG.md). The knobs an operator actually changes:

| Env var | Flag | What it does |
|---|---|---|
| `RGOE_BOOTNODE_ADMISSION` | `--admission` | `open` (onion-control only) or `stake` (require live operator bond). |
| `RGOE_BOOTNODE_TTL` | `--ttl` | Seconds a gateway stays live without re-announcing (default 900). |
| `RGOE_BOOTNODE_HEARTBEAT` | `--interval` | Re-announce interval (default 300). |
| `RGOE_GW_WEIGHT` | `--weight` | Selection weight advertised for this gateway (default 100). |
| `RGOE_STAKE_MODE` | `--stake-mode` | `onchain` (eth_call `isStaked`) or `mock` (chainless dev). |
| `RGOE_GATEWAY_REGISTRY` | `--gateway-registry` | `GatewayRegistry` address (required for onchain stake + `register-gateway`). |
| `RGOE_GROUP_CONTRACT` | `--group-contract` | `StakedReputationSet` address; set = on-chain membership roots, unset = `members.json`. |
| `RGOE_SLASH_KEY` | `--slash-key` | Hot key that submits `slash()` txs; unset = dry-run. |
| `RGOE_SLASH_CONTRACT` | `--slash-contract` | Slash contract address (independent of the root source). |
| `RGOE_SLOTS` | (none) | Per-epoch rate cap (nullifiers before over-spend). Must match client and gateway. |
| `RGOE_EPOCH_SECONDS` | `--epoch-seconds` | Epoch length (default 120). Must match client and gateway. |
| `RGOE_RPC_URL` | `--rpc-url` | JSON-RPC endpoint for all on-chain reads/writes. |
| `RGOE_TOR_HOST` / `RGOE_TOR_PORT` | `--tor-host` / `--tor-port` | Local Tor SOCKS (droplet 9050, local dev 9250). |

On the systemd deploy, set these as `Environment=` lines in the relevant unit
(`/etc/systemd/system/rgoe-*.service`), then `systemctl daemon-reload && systemctl
restart <unit>`.
