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
| `RGOE_PROBE_TIMEOUT_MS` | per-request timeout | `20000` |

Provide `RGOE_BOOTNODE_ONION` **or** `RGOE_BOOTNODE_URL`. Reads are bounded
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

## Example cron

```
*/5 * * * * RGOE_BOOTNODE_ONION=<b>.onion RGOE_DIR_SIGNER=<hex> \
  node /path/to/scripts/uptime-probe.mjs --format nagios >> /var/log/rgoe-uptime.log 2>&1
```

Tests: `node scripts/uptime-probe.selftest.mjs` (auto-discovered by `scripts/test-all.mjs`).
