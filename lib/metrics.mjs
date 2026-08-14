// A tiny, zero-dependency, in-process metrics registry (T-MON-2).
//
// Prometheus' text exposition format is just strings, so we do not pull in a client
// library: this module holds counters, gauges, and fixed-bucket histograms in memory and
// renders them as `# HELP` / `# TYPE` / `name{labels} value` lines.
//
// IMPORTING THIS MODULE INSTALLS NOTHING. It opens no socket and starts no server — it is
// pure in-process state. `serveMetrics()` (below) creates an HTTP server ONLY when called,
// and the gateway/bootnode call it only from main()/behind an env flag, so importing the
// registry never changes runtime behavior or binds a port.
//
// Design notes / correctness:
//   - Counters are monotonic (inc only). Gauges can be set() or fed by a collect() callback
//     (used for "current live size" style gauges read at scrape time).
//   - Histograms use cumulative `le` buckets plus `_sum` / `_count`, exactly as Prometheus
//     expects; +Inf is always emitted.
//   - Label VALUES are escaped per the exposition spec (\\, \", \n). Label NAMES are assumed
//     to be well-formed identifiers (all call sites here pass literal names).
//   - render() output is deterministic (metrics and label sets are emitted in sorted order)
//     so tests can assert on it byte-stably.

import http from "node:http"; // for makeMetricsServer only; importing never binds a port.

// Default latency buckets, in SECONDS (Prometheus convention: base-unit seconds).
export const DEFAULT_LATENCY_BUCKETS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

// Escape a label VALUE per the exposition format.
function escapeLabelValue(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

// Deterministic canonical key + rendered `{a="1",b="2"}` suffix for a label set.
// Keys are sorted so {a,b} and {b,a} collapse to one series.
function labelParts(labels) {
  const keys = Object.keys(labels || {}).filter((k) => labels[k] !== undefined && labels[k] !== null).sort();
  if (keys.length === 0) return { key: "", suffix: "" };
  const inner = keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(",");
  return { key: inner, suffix: `{${inner}}` };
}

export function makeRegistry() {
  // name -> { type, help, ... }
  const metrics = new Map();

  function getOrCreate(name, type, help, extra = {}) {
    let m = metrics.get(name);
    if (!m) {
      m = { name, type, help, series: new Map(), ...extra };
      metrics.set(name, m);
    } else if (help && !m.help) {
      m.help = help;
    }
    return m;
  }

  function counter(name, help) {
    const m = getOrCreate(name, "counter", help);
    return {
      inc(labels = {}, n = 1) {
        const { key, suffix } = labelParts(labels);
        const cur = m.series.get(key);
        if (cur) cur.value += n;
        else m.series.set(key, { suffix, value: n });
        return this;
      },
    };
  }

  // A gauge can be driven two ways:
  //   .set(value, labels)  -- explicit point-in-time value, and/or
  //   collect: () => number -- evaluated at render() time (for "current size" gauges).
  function gauge(name, help, collect) {
    const m = getOrCreate(name, "gauge", help, { collect });
    if (collect) m.collect = collect;
    return {
      set(value, labels = {}) {
        const { key, suffix } = labelParts(labels);
        m.series.set(key, { suffix, value });
        return this;
      },
      setCollect(fn) { m.collect = fn; return this; },
    };
  }

  function histogram(name, help, buckets = DEFAULT_LATENCY_BUCKETS) {
    // Sorted, de-duplicated bucket upper bounds (finite; +Inf is implicit at render).
    const bounds = [...new Set(buckets)].filter((b) => Number.isFinite(b)).sort((a, b) => a - b);
    const m = getOrCreate(name, "histogram", help, { bounds });
    return {
      observe(value, labels = {}) {
        const { key, suffix } = labelParts(labels);
        let h = m.series.get(key);
        if (!h) {
          h = { suffix, labels: { ...labels }, counts: new Array(bounds.length).fill(0), sum: 0, count: 0 };
          m.series.set(key, h);
        }
        h.count += 1;
        h.sum += value;
        for (let i = 0; i < bounds.length; i++) if (value <= bounds[i]) h.counts[i] += 1; // cumulative
        return this;
      },
    };
  }

  function fmtNum(v) {
    if (v === Infinity) return "+Inf";
    if (v === -Infinity) return "-Inf";
    if (Number.isNaN(v)) return "NaN";
    return String(v);
  }

  // Render every metric in Prometheus text exposition format.
  function render() {
    const out = [];
    for (const name of [...metrics.keys()].sort()) {
      const m = metrics.get(name);
      if (m.help) out.push(`# HELP ${name} ${String(m.help).replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`);
      out.push(`# TYPE ${name} ${m.type}`);

      if (m.type === "histogram") {
        for (const key of [...m.series.keys()].sort()) {
          const h = m.series.get(key);
          const base = h.suffix; // e.g. `{route="x"}` or ``
          // cumulative bucket lines
          for (let i = 0; i < m.bounds.length; i++) {
            out.push(`${name}_bucket${withLe(base, fmtNum(m.bounds[i]))} ${h.counts[i]}`);
          }
          out.push(`${name}_bucket${withLe(base, "+Inf")} ${h.count}`);
          out.push(`${name}_sum${base} ${fmtNum(h.sum)}`);
          out.push(`${name}_count${base} ${h.count}`);
        }
        continue;
      }

      // counter / gauge
      const lines = new Map(); // key -> {suffix, value}
      for (const [key, s] of m.series) lines.set(key, s);
      if (m.type === "gauge" && typeof m.collect === "function") {
        const collected = m.collect();
        if (typeof collected === "number") lines.set("", { suffix: "", value: collected });
        else if (Array.isArray(collected)) {
          for (const c of collected) {
            const { key, suffix } = labelParts(c.labels || {});
            lines.set(key, { suffix, value: c.value });
          }
        }
      }
      for (const key of [...lines.keys()].sort()) {
        const s = lines.get(key);
        out.push(`${name}${s.suffix} ${fmtNum(s.value)}`);
      }
    }
    return out.join("\n") + "\n";
  }

  // Splice an `le="..."` label into an existing (possibly empty) label suffix.
  function withLe(suffix, le) {
    const lePair = `le="${le}"`;
    if (!suffix) return `{${lePair}}`;
    return `{${suffix.slice(1, -1)},${lePair}}`;
  }

  return { counter, gauge, histogram, render, size: () => metrics.size, _metrics: metrics };
}

// The process-wide shared registry. Modules register their metrics against this and the
// per-role /metrics endpoints render it.
export const registry = makeRegistry();

// Convenience: a loopback HTTP server that serves `render()` at GET /metrics. Creating the
// server does nothing until the caller invokes .listen(); importing this module never calls
// it. Kept here so the gateway (a TCP server, no http listener of its own) and any other
// non-HTTP role can expose metrics without duplicating transport. Zero external deps.
export function makeMetricsServer(reg = registry) {
  return http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/metrics" || req.url === "/")) {
      const body = reg.render();
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "content-length": Buffer.byteLength(body) });
      res.end(body);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n");
    }
  });
}
