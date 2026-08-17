# Monitoring: dashboards + alerts (T-MON-3)

Grafana dashboard and Prometheus alert rules for the reputation-gated onion egress fleet. Both are
built ONLY on the metrics that `lib/metrics.mjs` renders and that `bootnode/server.mjs` and
`gateway/gateway.mjs` register (T-MON-2). No metric here is aspirational; every PromQL expression
references a series the code actually emits.

Files:

- `grafana-dashboard.json` -- importable Grafana dashboard (`$datasource` / `$job` / `$instance`
  template vars).
- `alerts.yml` -- Prometheus alerting rules grounded in `docs/SLO.md`.
- this README -- how to scrape, import, and load the rules.

## The metrics these are built on

| Metric | Type | Labels | Source |
|---|---|---|---|
| `rgoe_bootnode_announces_total` | counter | `result` (accepted\|rejected), `reason` (on reject) | `bootnode/server.mjs` |
| `rgoe_bootnode_directory_fetches_total` | counter | -- | `bootnode/server.mjs` |
| `rgoe_bootnode_live_gateways` | gauge | -- | `bootnode/server.mjs` |
| `rgoe_gateway_requests_total` | counter | `result` (pass\|drop), `reason` (on drop) | `gateway/gateway.mjs` |
| `rgoe_gateway_slashes_total` | counter | -- | `gateway/gateway.mjs` |
| `rgoe_gateway_active_tunnels` | gauge | -- | `gateway/gateway.mjs` |
| `rgoe_gateway_verify_seconds` | histogram | `le` (on `_bucket`) | `gateway/gateway.mjs` |

The histogram exposes `rgoe_gateway_verify_seconds_bucket{le=...}`, `_sum`, and `_count`, in SECONDS
(Prometheus base-unit convention; buckets are `DEFAULT_LATENCY_BUCKETS` in `lib/metrics.mjs`).

## Where the /metrics endpoints live (and why they need a tunnel)

Both endpoints are **loopback-only by design**. They are never meant to be exposed publicly, and the
scrape config must reach them over the local host, an SSH tunnel, or a node-exporter-style sidecar on
the box, NOT over the onion or a public interface.

- **Bootnode**: `/metrics` is served on the SAME loopback HTTP server as the bootnode transport,
  bound to `127.0.0.1` on `RGOE_BOOTNODE_PORT` (default `8877`). Tor maps the onion to this loopback
  port; the `/metrics` route inherits that loopback scope. So the scrape target is
  `127.0.0.1:8877/metrics` on the bootnode host. There is no separate metrics port for the bootnode.

- **Gateway**: `/metrics` is served on a SEPARATE http server that starts ONLY when
  `RGOE_METRICS_PORT` is set (off by default). It binds `RGOE_METRICS_HOST` (default `127.0.0.1`).
  The gateway's egress transport is a raw TCP server with no HTTP listener of its own, so this
  dedicated loopback server is how it exposes metrics. Set e.g. `RGOE_METRICS_PORT=9101` on each
  gateway; the scrape target is `127.0.0.1:9101/metrics` on that gateway host.

Because both bind loopback, Prometheus (running elsewhere) reaches them one of two ways:

1. **Prometheus on the same box** -- scrape `127.0.0.1:<port>` directly. Simplest for a single-box
   reference deploy.
2. **SSH tunnel** -- forward each remote loopback port to a distinct local port on the Prometheus
   host, then scrape the forwarded ports. Example:

   ```sh
   # bootnode 8877 -> local 18877 ; gateway metrics 9101 -> local 19101
   ssh -N -L 18877:127.0.0.1:8877 operator@bootnode-host &
   ssh -N -L 19101:127.0.0.1:9101 operator@gateway-1-host &
   ```

Do NOT open `RGOE_METRICS_PORT` or `RGOE_BOOTNODE_PORT` on a public interface to make scraping easier.
The metrics carry fleet-shape and traffic signal; keep them loopback and tunnel.

## Prometheus scrape config

Add to `prometheus.yml`. The `job` names here (`rgoe-bootnode`, `rgoe-gateway`) are what `alerts.yml`
matches on -- keep them in sync if you rename. Targets shown for the SSH-tunnel case; swap for the
real `127.0.0.1:<port>` if Prometheus runs on the box.

```yaml
scrape_configs:
  - job_name: rgoe-bootnode
    metrics_path: /metrics
    scheme: http
    scrape_interval: 15s
    static_configs:
      # tunnel:  ssh -L 18877:127.0.0.1:8877 operator@bootnode-host
      # on-box:  replace with 127.0.0.1:8877
      - targets: ["127.0.0.1:18877"]
        labels:
          instance: bootnode-1

  - job_name: rgoe-gateway
    metrics_path: /metrics
    scheme: http
    scrape_interval: 15s
    static_configs:
      # each gateway runs with RGOE_METRICS_PORT set; tunnel each loopback port to a distinct local one
      - targets: ["127.0.0.1:19101"]
        labels:
          instance: gateway-1
      - targets: ["127.0.0.1:19102"]
        labels:
          instance: gateway-2

rule_files:
  - /etc/prometheus/rules/rgoe-alerts.yml   # this repo's monitoring/alerts.yml
```

`up{job="rgoe-bootnode"}` and `up{job="rgoe-gateway"}` are synthesized by Prometheus from the scrape
outcome, which is what `BootnodeDown` / `GatewayDown` alert on -- no extra instrumentation needed.

## Import the dashboard

1. Grafana -> Dashboards -> New -> Import.
2. Upload `grafana-dashboard.json` (or paste it).
3. When prompted, pick your Prometheus data source for the `DS_PROMETHEUS` input; it binds the
   dashboard's `$datasource` variable.
4. The `$job` and `$instance` variables auto-populate from `label_values(up, job)` and
   `label_values(up{job=~"$job"}, instance)`. Leave both on `All` to see the whole fleet, or narrow
   to one gateway/bootnode.

Panels: fleet size (`rgoe_bootnode_live_gateways`), directory fetch rate, announce accept/reject by
reason + rejection fraction, active tunnels, slash events, gateway pass/drop by reason + drop
fraction, and `verifyEnvelope` p50/p95/p99 (histogram_quantile over
`rgoe_gateway_verify_seconds_bucket`) plus mean verify time and verifies/sec.

## Load the alert rules

Point Prometheus's `rule_files` at `alerts.yml` (see the snippet above), then reload:

```sh
promtool check rules monitoring/alerts.yml    # validate first
curl -X POST http://localhost:9090/-/reload   # if --web.enable-lifecycle is set
```

Route them through Alertmanager as you see fit; every rule carries a `severity` label
(`critical`/`warning`) and a `component` label (`bootnode`/`gateway`/`fleet`) to route on.

## What each alert means operationally

Grounded in `docs/SLO.md` and cross-referenced to the runbooks in `docs/INCIDENT.md`.

| Alert | Severity | Meaning | SLO / runbook |
|---|---|---|---|
| `BootnodeDown` | critical | Bootnode `/metrics` unscrapable (`up==0`). Discovery degraded; clients fall back to LKG cache, so rarely member-visible, but burns bootnode-availability budget. | SLO 2.2; INCIDENT.md #1 (verify-false -> #2) |
| `FleetTooSmall` | critical | `rgoe_bootnode_live_gateways < 2`. No failover spread, target metadata 1/1 not 1/N. Add gateways before egress-success burns. | SLO 2.3; INCIDENT.md #3 |
| `FleetEmpty` | critical | `< 1` live gateway. No member can egress. Never cleared by weakening admission. | SLO 2.3, section 5; INCIDENT.md #3 |
| `AnnounceRejectionSpike` | warning | >80% of announces rejected with real volume. Rejections are the gate working; a sustained spike = forged announces / misconfig / full registry. Not an outage. | SLO section 1 |
| `GatewayDown` | warning | One gateway unscrapable. Individual gateway uptime is explicitly NOT an SLO; the fleet routes around it. Escalates only if it drives `FleetTooSmall`. | SLO section 4; INCIDENT.md #3 |
| `SlashSpike` | warning | Elevated `rgoe_gateway_slashes_total` rate. A slash is the RLN rate limit working (over-spend caught), never error budget; but a spike warrants a look (broken client / prober). | SLO sections 3-4; INCIDENT.md #7 |
| `HighDropRate` | warning | >50% of requests dropped. Gate DROPs are correct rejections -> read the reason mix. `root-not-recent` spike = config mismatch (align epoch/slots/identifier/root, widen freshness); dial/upstream drops = capacity, add gateways. | SLO 2.1, section 3; INCIDENT.md #6 |
| `VerifyLatencyP95High` | warning | `verifyEnvelope` p95 > 50ms. Server-side verify CPU only (Tor RTT excluded by design). Near the ~30 verify/s/core ceiling: add cores/gateways, never skip a verify check. | SLO 2.4, section 5 |
| `VerifyLatencyP99High` | warning | `verifyEnvelope` p99 > 100ms. Tail verify latency climbing; check jitter / saturation, add capacity. | SLO 2.4, section 3 |

The hard line from `docs/SLO.md` section 5 applies to every response here: no alert is ever cleared by
weakening the gate, admitting an unverified gateway, serving an unverifiable directory, narrowing the
anonymity set, or skipping a `verifyEnvelope` check. When a target and a correctness/anonymity
property conflict, the property wins.

## Calibration note

Every threshold in `alerts.yml` is a defensible default, not a measured commitment. The SLO doc flags
its availability targets `[NEEDS DATA]`: recalibrate the fractions, `for:` windows, and rate thresholds
against the first 30 days of real metrics. `docs/SLO.md` section 3 also calls for multi-window
burn-rate alerts once a real error-budget baseline exists; those are deliberately NOT included here
because they need production event volumes to set the burn multipliers honestly.
