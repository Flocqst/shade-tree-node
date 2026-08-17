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

- **Node 24** (NodeSource) and **Tor** (official Tor Project repo, so the onion PoW DoS
  defense is *available*; it is **off by default**, `RGOE_ENABLE_POW=1` turns it on).
- A `rgoe` service user and the repo at `/opt/rgoe`.
- Onion identities minted once into `/opt/rgoe/deploy-state/` and copied into Tor's own HS
  dirs (`bootnode/keygen.mjs`).
- Three systemd units: `rgoe-bootnode`, `rgoe-gateway`, `rgoe-heartbeat` — all `Restart=always`.
  (Gateway-only mode: two units, no `rgoe-bootnode`.)
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
| `RGOE_RENDER_ONLY` | *(unset)* | `<dir>`: **render mode** — write the torrc include + units under `<dir>/etc/…` with placeholder onions and exit; no root, no apt, no tor/node install, no clone, no `systemctl`. `bootstrap.sh --render <dir>` is the same. This is what `bootstrap.selftest.mjs` drives. |

`RGOE_GW_OPERATOR_KEY` (staked bootnodes) is a secret and deliberately **not** a tunable: add it
to the heartbeat unit by hand after staking (see "Turn on staking").

### Add a second gateway to an existing bootnode

```bash
RGOE_BOOTNODE_ONION=<bootnode>.onion RGOE_BOOTNODE_SIGNER=<pinned-signer> \
  bash bootnode/deploy/bootstrap.sh
journalctl -u rgoe-heartbeat -f          # 'announced (...)' once the descriptors propagate
```

Same idempotence rules: re-running reuses the gateway identity and units.

### Render mode (review / tests, no root)

```bash
bash bootnode/deploy/bootstrap.sh --render /tmp/r && find /tmp/r -type f
RGOE_ENABLE_POW=1 RGOE_BOOTNODE_ONION=<onion> bash bootnode/deploy/bootstrap.sh --render /tmp/r2
node bootnode/deploy/bootstrap.selftest.mjs   # golden default + PoW on/off + gateway-only assertions
```

The default render is frozen in `bootnode/deploy/golden/default/`; a deliberate change to what
the deploy writes is regenerated with `RGOE_UPDATE_GOLDEN=1 node bootnode/deploy/bootstrap.selftest.mjs`
and reviewed as a diff.

## Systemd hardening

All three units run under a sandboxed `[Service]` section: `NoNewPrivileges`,
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
| `bootstrap.selftest.mjs` | offline render assertions: golden default, `RGOE_ENABLE_POW` on/off, gateway-only mode, input validation |
| `golden/default/` | the frozen default render (torrc include + 3 units) |
| `e2e-container.sh` | systemd-in-container e2e (`E2E_MODE=gateway-only` for the remote-bootnode mode) |

Systemd units and the `torrc` include are generated by `bootstrap.sh` (self-contained; no
templates to keep in sync — the render mode + golden are the check that they stay right).
