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

### Cross-fleet replay defense (shared nonce tally — T-FEAT-20)

Each gateway defends itself against an exact-envelope replay with a per-gateway
seen-envelope cache (T-FEAT-12): a captured envelope resent to the **same** gateway
outside the honest-retry window (`RGOE_REPLAY_WINDOW_MS`, default 5s) is dropped
`replayed-envelope`. That cache is local, so a non-colluding fleet had no shared
spent-set — a malicious relay could fan one captured envelope to **peer** gateways and
each would serve it once.

The optional **shared nonce tally** (`gateway/fleet-tally.mjs`) closes that: gateways
share a per-epoch spent-**nullifier** tally, so a nullifier admitted at gateway A
propagates and gateway B rejects the same envelope `replayed-envelope` once it has the
tally. On such a fleet-wide rejection the gateway logs `scope=fleet`.

- **What crosses the wire, and why it is safe.** Only the pair `(nullifier, epoch)` is
  shared — never member identity/commitment, never `share.y` (the secret a slash
  reconstructs from), never the egress `target`, never `share.x` or the nonce. An RLN
  nullifier is per-epoch, per-request, and pseudorandom (unlinkable to the member — the
  same property that already lets one gateway dedup on it without learning who the member
  is), so sharing it adds no linkability beyond what the admitting gateway already had. A
  peer learns only "some request with nullifier N happened in epoch E." Because `share.y`
  never leaves a gateway, the tally is **not** a slashing/deanonymization side channel.
- **Slashing stays local.** A slash needs two shares under one nullifier; since `share.y`
  is not shared, a **distributed** over-spend (the two shares landing on different
  gateways) is rejected fleet-wide but slashed only where both shares land. That is the
  intended privacy trade — the alternative (gossiping shares) would leak the very bytes
  that reconstruct an identity.
- **Fail-open.** A gateway that cannot reach the tally degrades to the per-gateway
  T-FEAT-12 defense and keeps serving — the tally is defense-in-depth, never an admission
  authority, so a partition or a broken peer cannot deny legitimate members.
- **Off by default.** No shared transport is wired unless one is configured. With no
  `RGOE_FLEET_TALLY_PEERS` set the gateway runs **exactly** the per-gateway behavior
  (byte-identical to T-FEAT-12). When the tally is active the gateway logs `fleet tally: ON`
  at startup. Note: with the tally enabled a nullifier is single-use **fleet-wide**, so a
  client that fails over to another gateway must use a fresh RLN slot (a follow-up on the
  client side); until then, keep it off in production.

#### Real cross-host transport (T-FEAT-20b — HTTP push)

The tally speaks to the fleet through an injectable `{ publish(nullifier, epoch),
subscribe(cb) }` seam. The bundled real transport (`makeHttpTallyTransport` in
`gateway/fleet-tally.mjs`) is a tiny **HTTP push**: each gateway exposes an inbound
announcement endpoint and POSTs `{"nullifier":…,"epoch":…}` to each **configured peer**
gateway. It is a direct **1-hop** push to a fixed peer set — not a forwarding flood — so a
nullifier crosses the wire at most once per peer per admit (no gossip storm, no loops: the
inbound handler only records locally, it never re-publishes).

- **Enable it** with `RGOE_FLEET_TALLY_PEERS` (comma-separated peer gateways). A peer that is
  an `.onion` is reached **over Tor** (reusing the bootnode fetch path — no exit node, the
  peer never learns this gateway's IP); a bare `host:port` peer is reached with a plain HTTP
  POST (localhost / private management network). Set `RGOE_FLEET_TALLY_LISTEN` (`host:port` or
  `port`, default `127.0.0.1:0`) for this gateway's inbound endpoint — behind Tor, map the
  gateway's onion to that local port. `RGOE_FLEET_TALLY_PATH` overrides the endpoint path
  (default `/fleet-tally`). For a full mesh, list the other gateways as each gateway's peers
  (federation, T-FEAT-1, already discovers them).
- **Trust model — peers are semi-trusted.** Peers are fleet gateways the operator configured,
  not the open internet, but the transport assumes any peer can be down, slow, or malicious
  and bounds the damage:
  - **Fail-open, both directions.** Outbound POSTs are fire-and-forget with a per-peer timeout
    (`RGOE_FLEET_TALLY_TIMEOUT_MS`, default 4s); a refused / 500 / slow / partitioned peer is
    swallowed and **never** blocks admission — `publish()` returns synchronously and the
    gateway proceeds on its local defense. Inbound malformed / oversized bodies are dropped
    (400/413), never crash the endpoint.
  - **Only two fields ever read.** The inbound handler reads **only** `nullifier` and `epoch`;
    any extra key a peer stuffs into the body is ignored, never stored, never acted on — the
    same privacy invariant as above, now enforced at the wire boundary.
  - **Bounded blast radius.** A malicious peer flooding fake nullifiers can at worst fill this
    gateway's per-epoch bucket up to the flood cap (`maxPerEpoch`, memory stays bounded; past
    the cap recording simply stops — lose dedup, never deny). It cannot cause a fleet-wide
    outage. A live nullifier is `H(identitySecret, externalNullifier)`, per-request
    pseudorandom and unpredictable, so a flooder cannot pre-image a **future** honest member's
    nullifier to get it pre-rejected — its garbage collides with nothing real, and the only
    harm stays on the flooder. Response reads are byte-capped against an unbounded reply.

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
| `RGOE_FLEET_TALLY_PEERS` | (none) | Comma-separated peer gateways for the cross-fleet shared nonce tally (T-FEAT-20b). `.onion` peers over Tor, `host:port` over plain HTTP. **Unset = off** (per-gateway behavior, byte-identical). |
| `RGOE_FLEET_TALLY_LISTEN` | (none) | Inbound tally endpoint `host:port` (or bare `port`); default `127.0.0.1:0`. Behind Tor, map the gateway onion to this local port. |
| `RGOE_FLEET_TALLY_PATH` | (none) | Inbound tally endpoint path (default `/fleet-tally`). |
| `RGOE_FLEET_TALLY_TIMEOUT_MS` | (none) | Per-peer push timeout (default 4000). A slow/down peer is swallowed (fail-open), never blocks admission. |
| `RGOE_FLEET_TALLY` | (none) | Legacy flag; with no `RGOE_FLEET_TALLY_PEERS` it only logs a note and stays off (fail-open). |
| `RGOE_EGRESS_ALLOW` / `RGOE_EGRESS_DENY` | (none) | Egress policy (see §2). When `RGOE_EGRESS_ALLOW` is **set**, the heartbeat also advertises its concrete allowed ports as SIGNED capabilities (T-FEAT-10b) so clients can route by port. Unset = default `*:443` and **no** caps advertised. |
| `RGOE_GATEWAY_REGION` | (none) | Coarse self-declared region bucket advertised in signed caps: one of `na sa eu af as oc aq unknown`. Continent-scale only (too coarse to fingerprint). Unset/invalid = omitted. |
| `RGOE_ENVELOPE_TIMEOUT_MS` / `RGOE_TUNNEL_IDLE_TIMEOUT_MS` | (none) | Gateway slow-client limits: envelope deadline (default 30 s) and relay idle timeout (default 5 min). See "Endpoint hardening" below. |
| `RGOE_MAX_CONNS` / `RGOE_MAX_CONNS_PER_NULLIFIER` | (none) | Gateway concurrent-connection caps: total (default 1024) and per nullifier (default 8). `0` = unlimited. |
| `RGOE_BOOTNODE_ANNOUNCE_RATE` / `RGOE_BOOTNODE_ANNOUNCE_BURST` | (none) | Bootnode GLOBAL announce token bucket (default 66.7/s, burst 1000 — sized from `RGOE_BOOTNODE_MAX_ENTRIES` and `RGOE_BOOTNODE_HEARTBEAT`; `docs/BOOTNODE.md`). |
| `RGOE_BOOTNODE_HEADERS_TIMEOUT_MS` / `_REQUEST_TIMEOUT_MS` / `_KEEPALIVE_TIMEOUT_MS` / `_MAX_HEADER_BYTES` | (none) | Bootnode HTTP slow-client limits (defaults 10 s / 30 s / 5 s / 8 KiB). |

### Endpoint hardening (T-HARD-4)

Both listeners bound every lever an *unauthenticated* peer can pull. Defaults are on; you
should not need to touch them unless you run an unusually large or slow fleet.

**Gateway** (`gateway/gateway.mjs`):

- **Envelope deadline** — the newline-terminated envelope must arrive within
  `RGOE_ENVELOPE_TIMEOUT_MS` (30 s) *of connect*. The deadline is absolute (dribbling one byte
  at a time does not extend it). Cut connections show as `drop reason=envelope-timeout` in the
  metrics (`rgoe_gateway_requests_total{result="drop",reason="envelope-timeout"}`).
- **Relay idle timeout** — an established tunnel with no bytes in either direction for
  `RGOE_TUNNEL_IDLE_TIMEOUT_MS` (5 min) is closed at both ends
  (`rgoe_gateway_tunnel_closes_total{reason="idle-timeout"}`). Long-lived idle TLS sessions
  simply reconnect; raise it if members legitimately hold idle connections longer.
- **Connection caps** — `RGOE_MAX_CONNS` (1024) concurrent sockets total, refused at accept
  before any read (`too-many-connections`); `RGOE_MAX_CONNS_PER_NULLIFIER` (8) concurrent
  tunnels per nullifier (`nullifier-conn-limit`), so one proof replayed inside the honest-retry
  window cannot pin an unbounded number of idle tunnels. Both slots are released on close.
- **Half-close crash fixed** — a client that sent a partial envelope and then FIN'd used to
  crash the whole gateway process (uncaught `EPIPE` on the error reply). Fixed in the same
  slice; `test/adversarial.selftest.mjs` scenario 6 exercises it.

If a *legitimate* member trips `too-many-connections` (metric climbing under normal load), raise
`RGOE_MAX_CONNS`; the per-nullifier cap should never be hit by an honest client (one request per
nullifier, one tunnel each; a retry replaces a dead tunnel).

**Bootnode** (`bootnode/server.mjs`):

- **HTTP slow-client limits** — headers within 10 s, whole request within 30 s (`408`), keep-alive
  idle 5 s, headers <= 8 KiB (`431`), enforced every second (Node's own defaults are 60 s / 300 s
  / 16 KiB / checked every 30 s).
- **Global announce bucket** — in front of the per-onion throttle's blind spot: an attacker
  minting *fresh* onions could force one ed25519 verify per onion until the registry filled. Now
  at most `RGOE_BOOTNODE_ANNOUNCE_BURST` (1000) reach verification in one instant, then
  `RGOE_BOOTNODE_ANNOUNCE_RATE` (66.7/s). Overflow gets `429` + `Retry-After` and the heartbeat
  simply retries at its next beat. Legit fleets never hit it at default cadence — the math is in
  `docs/BOOTNODE.md` "Endpoint hardening". If your bootnode logs many `global-rate-limited`
  rejects while the fleet is healthy, you are under an announce flood, not misconfigured.

### Capability advertisement (T-FEAT-10b)

By default a gateway advertises **no** capabilities and its announce is byte-identical to a
legacy gateway — an unconfigured gateway is indistinguishable on the wire. When you set an
egress policy (`RGOE_EGRESS_ALLOW`) and/or a region (`RGOE_GATEWAY_REGION`), the heartbeat
attaches a **signed** capability set to every announce:

- `ports` — the coarse allowed egress port set derived from `RGOE_EGRESS_ALLOW`
  (`*:443` → `[443]`; `*:443,*:8443` → `[443,8443]`; a wildcard `*` port is dropped).
- `region` — your `RGOE_GATEWAY_REGION` bucket, if valid.
- `proto` — the envelope version range this build speaks (from the gateway's negotiated range).

The caps are signed by the gateway's onion key (not the bootnode), so a bootnode or directory
signer cannot forge or alter them. Clients that opt into capability-aware selection then route a
port-`X` request only to gateways advertising `X`. The heartbeat logs the exact caps it advertises
on startup (`capabilities advertised (signed): …`), or `capabilities: none` when unconfigured.

On the systemd deploy, set these as `Environment=` lines in the relevant unit
(`/etc/systemd/system/rgoe-*.service`), then `systemctl daemon-reload && systemctl
restart <unit>`.
