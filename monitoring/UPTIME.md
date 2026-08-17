# External uptime checks (T-MON-4)

`scripts/uptime-probe.mjs` is a standalone, dependency-light prober an **external** monitor runs
to check fleet health from OUTSIDE, over Tor. It is not a server and arms nothing: a cron job or a
hosted uptime service (with a tor-capable runner) invokes it on an interval and reads its exit code.

Unlike the loopback `/health` on the bootnode (`bootnode/server.mjs`, reachable only on 127.0.0.1
or through the onion), this prober reaches the bootnode the way a client does — a SOCKS dial
through the local Tor daemon, no exit node, the bootnode never learns the monitor's IP — then
verifies the served directory against the **pinned** signer. So a green check means more than
"the box answers": it means the fleet is serving an authentic, signer-pinned directory. A
swapped or MITM'd bootnode fails `signerOk`, not merely reachability.

## Run it

```
# Production: over Tor to the bootnode onion
RGOE_BOOTNODE_ONION=<bootnode>.onion \
RGOE_DIR_SIGNER=<pinned signer pubkey hex> \
  node scripts/uptime-probe.mjs

# Dev: plain HTTP straight to a local bootnode (bypasses Tor)
RGOE_BOOTNODE_URL=http://127.0.0.1:8877 \
RGOE_DIR_SIGNER=<pinned signer pubkey hex> \
  node scripts/uptime-probe.mjs
```

`RGOE_DIR_SIGNER` is the pinned directory-signer pubkey the bootnode prints on boot
("pinned signer pubkey (clients set RGOE_DIR_SIGNER to this)").

## Config (all `RGOE_*`)

| var | meaning | default |
| --- | --- | --- |
| `RGOE_BOOTNODE_ONION` | bootnode v3 `.onion` (fetched over Tor) | — |
| `RGOE_TOR_HOST` / `RGOE_TOR_PORT` | local Tor SOCKS proxy | `127.0.0.1` / `9250` |
| `RGOE_BOOTNODE_URL` | plain-http base, dev only (bypasses Tor) | — |
| `RGOE_DIR_SIGNER` | pinned directory-signer pubkey (hex), **required** | — |
| `RGOE_NETWORK` | `<name>`: default `RGOE_BOOTNODE_ONION` + `RGOE_DIR_SIGNER` from `network/<name>/bootnode.json` (explicit env wins; a `pending` record supplies nothing → misconfig) | — |
| `RGOE_PROBE_TIMEOUT_MS` | per-request timeout | `20000` |

Provide `RGOE_BOOTNODE_ONION` **or** `RGOE_BOOTNODE_URL` (or `RGOE_NETWORK` naming a live record). Reads are bounded
(`RGOE_BOOTNODE_MAX_RESP`, 2 MB) and time out; the prober never hangs and **fails closed** —
any error (unreachable, bad signature, timeout, misconfig) reports UNHEALTHY.

## Check formats

**Default (JSON).** One line to stdout; exit `0` healthy, nonzero unhealthy:

```json
{"ok":true,"bootnodeReachable":true,"signerOk":true,"fleetSize":3,"ts":1786675086}
```

(An optional `reason` field is appended when unhealthy.)

**Nagios** (`--format nagios`), for uptime services that consume a status line + code — exit `0`
OK / `2` CRITICAL:

```
OK: bootnode reachable, directory signer pinned, fleet=3
CRITICAL: bootnode unreachable (timeout)
```

## Privacy posture

Mirrors the status page: the prober prints a **count** (`fleetSize`), never gateway onions or
operator addresses, and scrubs any `.onion` out of error text. `fleetSize` is a number, not identities.

## Scheduling it (T-DEPLOY-5 / GAP-8)

The probe is the SLI source for `docs/SLO.md` 2.2/2.3 (GO-LIVE row 6.3), so it needs a
scheduler on a tor-capable runner **outside** the fleet. Three shipped options, all in
`monitoring/uptime/`; pick one per vantage point (two vantages are better than one):

| runner | files | cadence | notes |
|---|---|---|---|
| systemd (any Linux box with tor) | `rgoe-uptime-probe.service` + `rgoe-uptime-probe.timer` | 5 min | sandboxed oneshot; exit code in the journal |
| GitHub Actions (hosted) | `.github/workflows/uptime-probe.yml` | 15 min | installs tor on the runner; **no-ops green** until repo variables are set |
| plain cron | `crontab.example` | 5 min | one line, appends nagios lines to `/var/log/rgoe-uptime.log` |

All three read the same inputs: `RGOE_BOOTNODE_ONION` + `RGOE_DIR_SIGNER`, **or**
`RGOE_NETWORK=<name>` (resolved from `network/<name>/bootnode.json`, `lib/network-record.mjs`).
Neither input is secret (an onion and a public key). `uptime-probe.env.example` is the
`/etc/rgoe/uptime-probe.env` template the systemd unit and cron line source.

### systemd timer

```bash
# on the prober box: repo at /opt/rgoe (npm ci done), tor running with SocksPort 9050, user `rgoe`
sudo install -m 0644 monitoring/uptime/rgoe-uptime-probe.{service,timer} /etc/systemd/system/
sudo install -d -m 0755 /etc/rgoe
sudo install -m 0644 monitoring/uptime/uptime-probe.env.example /etc/rgoe/uptime-probe.env   # edit: onion+signer or RGOE_NETWORK
sudo systemctl daemon-reload
sudo systemctl enable --now rgoe-uptime-probe.timer
systemctl list-timers rgoe-uptime-probe.timer            # next fire
journalctl -u rgoe-uptime-probe.service -n 20            # last probe lines (OK: … / CRITICAL: …)
```

The service uses `SuccessExitStatus=1 2` so a CRITICAL probe is a **journal line, not a failed
unit** — the timer keeps firing and the SLI is `grep CRITICAL` over the journal (or ship the
journal to your log stack). Adjust `User=`, `WorkingDirectory=`, `RGOE_TOR_PORT` for your box.

### GitHub Actions

`.github/workflows/uptime-probe.yml` runs `*/15 * * * *` (+ `workflow_dispatch`). Set repository
**variables** (Settings → Secrets and variables → Actions → Variables): `RGOE_BOOTNODE_ONION` +
`RGOE_DIR_SIGNER`, or `RGOE_NETWORK` (e.g. `sepolia`) to read them from the committed record.
Secrets of the same names are read as a fallback. Until one of those is set the job emits a
`::notice::` and exits green (it does not even check out the repo), so an unconfigured repo or
fork never red-flags. A `pending` network record likewise skips green. Once configured, a
CRITICAL probe fails the run with an `::error::` (which is the alert). GitHub's schedule floor is
5 minutes but scheduled runs are best-effort and often late, so this is the coarse hosted signal;
the systemd timer is the 5-minute SLI source.

### cron

```
*/5 * * * * set -a; . /etc/rgoe/uptime-probe.env; set +a; RGOE_TOR_PORT=9050 /usr/bin/node /opt/rgoe/scripts/uptime-probe.mjs --format nagios >> /var/log/rgoe-uptime.log 2>&1
```

(`monitoring/uptime/crontab.example`, verbatim.)

Tests: `node scripts/uptime-probe.selftest.mjs` (probe) and
`node monitoring/uptime/uptime-scheduler.selftest.mjs` (units / cron / workflow well-formed and
wired to the probe), both auto-discovered by `scripts/test-all.mjs`.
