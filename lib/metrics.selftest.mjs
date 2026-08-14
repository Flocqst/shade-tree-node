// Self-test for the zero-dep metrics registry (T-MON-2).
//
//   node lib/metrics.selftest.mjs
//
// Asserts: counters increment (per label set), the histogram buckets cumulatively with a
// correct _sum/_count and a +Inf bucket, gauges read a collect() callback at render time,
// label VALUES are escaped, and render() emits valid Prometheus exposition text (HELP/TYPE
// + series lines). Finally it spins the REAL bootnode http server in-process and GETs
// /metrics, asserting the payload parses as exposition text and carries the bootnode series.

import { makeRegistry, DEFAULT_LATENCY_BUCKETS } from "./metrics.mjs";

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { console.log(`  FAIL ${msg}`); failures++; } };

// Pull `name{labels} value` lines out of exposition text into a lookup keyed by the full
// `name{labels}` (label suffix included), so we can assert exact values.
function parseExposition(text) {
  const help = new Map(), type = new Map(), values = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^# HELP (\S+) (.*)$/))) { help.set(m[1], m[2]); continue; }
    if ((m = line.match(/^# TYPE (\S+) (\w+)$/))) { type.set(m[1], m[2]); continue; }
    if (line.startsWith("#")) continue;
    // metricSeries value  (value is the last whitespace-separated token)
    const sp = line.lastIndexOf(" ");
    if (sp === -1) { ok(false, `unparseable exposition line: ${JSON.stringify(line)}`); continue; }
    values.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return { help, type, values };
}

async function main() {
  // === counters ============================================================
  console.log("counters:");
  {
    const reg = makeRegistry();
    const c = reg.counter("rgoe_test_requests_total", "help text");
    c.inc({ result: "pass" });
    c.inc({ result: "pass" });
    c.inc({ result: "drop", reason: "bad-target" });
    c.inc({ result: "drop", reason: "bad-target" }, 3); // inc by N
    const { help, type, values } = parseExposition(reg.render());
    ok(help.get("rgoe_test_requests_total") === "help text", "counter emits # HELP");
    ok(type.get("rgoe_test_requests_total") === "counter", "counter emits # TYPE counter");
    ok(values.get('rgoe_test_requests_total{result="pass"}') === "2", "counter accumulates per label set (pass=2)");
    // labels always render in sorted key order (reason before result), regardless of inc order
    ok(values.get('rgoe_test_requests_total{reason="bad-target",result="drop"}') === "4", "counter inc-by-N + sorted labels (drop=4)");
    // label key order is normalized: {reason,result} and {result,reason} collapse to one series
    const c2 = reg.counter("rgoe_test_requests_total");
    c2.inc({ result: "drop", reason: "bad-target" });
    ok(parseExposition(reg.render()).values.get('rgoe_test_requests_total{reason="bad-target",result="drop"}') === "5",
      "label order normalized (same series regardless of key order)");
  }

  // === histogram ===========================================================
  console.log("\nhistogram:");
  {
    const reg = makeRegistry();
    const h = reg.histogram("rgoe_test_latency_seconds", "latency", [0.1, 0.5, 1]);
    for (const v of [0.05, 0.2, 0.2, 3]) h.observe(v); // <=0.1:1, <=0.5:3, <=1:3, +Inf:4
    const { type, values } = parseExposition(reg.render());
    ok(type.get("rgoe_test_latency_seconds") === "histogram", "histogram emits # TYPE histogram");
    ok(values.get('rgoe_test_latency_seconds_bucket{le="0.1"}') === "1", "bucket le=0.1 cumulative == 1");
    ok(values.get('rgoe_test_latency_seconds_bucket{le="0.5"}') === "3", "bucket le=0.5 cumulative == 3");
    ok(values.get('rgoe_test_latency_seconds_bucket{le="1"}') === "3", "bucket le=1 cumulative == 3");
    ok(values.get('rgoe_test_latency_seconds_bucket{le="+Inf"}') === "4", "bucket le=+Inf == total count 4");
    ok(values.get("rgoe_test_latency_seconds_count") === "4", "_count == 4");
    ok(Math.abs(Number(values.get("rgoe_test_latency_seconds_sum")) - 3.45) < 1e-9, "_sum == 3.45");
    // buckets are cumulative and non-decreasing
    const b = ["0.1", "0.5", "1"].map((le) => Number(values.get(`rgoe_test_latency_seconds_bucket{le="${le}"}`)));
    ok(b[0] <= b[1] && b[1] <= b[2], "buckets are monotonically non-decreasing (cumulative)");
    ok(DEFAULT_LATENCY_BUCKETS.length > 0 && DEFAULT_LATENCY_BUCKETS.every((x, i, a) => i === 0 || a[i - 1] < x), "default buckets exported, sorted ascending");
  }

  // === gauge (collect callback) ===========================================
  console.log("\ngauge:");
  {
    const reg = makeRegistry();
    let backing = 0;
    reg.gauge("rgoe_test_live", "live things").setCollect(() => backing);
    ok(parseExposition(reg.render()).values.get("rgoe_test_live") === "0", "gauge reads collect() at render (0)");
    backing = 7;
    ok(parseExposition(reg.render()).values.get("rgoe_test_live") === "7", "gauge re-reads collect() at each render (7)");
    // explicit .set also works and coexists with labels
    const reg2 = makeRegistry();
    reg2.gauge("rgoe_test_set", "set gauge").set(42, { kind: "a" });
    ok(parseExposition(reg2.render()).values.get('rgoe_test_set{kind="a"}') === "42", "gauge .set(value, labels)");
  }

  // === label value escaping ===============================================
  console.log("\nescaping:");
  {
    const reg = makeRegistry();
    reg.counter("rgoe_test_escaped_total", "esc").inc({ reason: 'a"b\\c\nd' });
    const text = reg.render();
    // The rendered line must escape " \ and newline in the VALUE.
    ok(text.includes('rgoe_test_escaped_total{reason="a\\"b\\\\c\\nd"} 1'), "label value escapes \\\" \\\\ and newline");
    // ...and stays on a single physical line (no raw newline leaked into output).
    const escLine = text.split("\n").find((l) => l.startsWith("rgoe_test_escaped_total{"));
    ok(escLine && !escLine.includes("\t") && escLine.endsWith(" 1"), "escaped series stays one physical line");
  }

  // === exposition shape ====================================================
  console.log("\nexposition shape:");
  {
    const reg = makeRegistry();
    reg.counter("rgoe_test_a_total", "a").inc();
    reg.histogram("rgoe_test_b_seconds", "b", [1]).observe(0.5);
    const text = reg.render();
    ok(text.endsWith("\n"), "output ends with a trailing newline");
    // Every non-comment, non-empty line is `<series> <value>` with a numeric value.
    let allNumeric = true;
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const val = line.slice(line.lastIndexOf(" ") + 1);
      if (!/^(\+Inf|-Inf|NaN|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/.test(val)) { allNumeric = false; break; }
    }
    ok(allNumeric, "every metric line ends in a valid numeric/±Inf value");
    // HELP precedes TYPE precedes samples for a metric.
    const iHelp = text.indexOf("# HELP rgoe_test_a_total");
    const iType = text.indexOf("# TYPE rgoe_test_a_total");
    const iSample = text.indexOf("\nrgoe_test_a_total ");
    ok(iHelp !== -1 && iType > iHelp && iSample > iType, "HELP then TYPE then sample ordering");
  }

  // === bootnode /metrics end-to-end =======================================
  console.log("\nbootnode /metrics (in-process):");
  {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { generateOnionIdentity } = await import("../bootnode/keygen.mjs");
    const { buildAnnounce } = await import("../bootnode/announce.mjs");
    const { makeRegistry: makeBootRegistry, makeServer, loadOrMintSigner } = await import("../bootnode/server.mjs");
    const { MockStakeVerifier } = await import("../lib/gateway-registry.mjs");

    const work = await mkdtemp(join(tmpdir(), "rgoe-metrics-"));
    try {
      const g1 = await generateOnionIdentity(join(work, "g1"), { label: "g1" });
      const signer = await loadOrMintSigner(join(work, "signer.key"));
      const reg = makeBootRegistry({ signer, stake: MockStakeVerifier({}), admission: "open", ttlSec: 900, minReannounceSec: 0 });
      const server = makeServer(reg, { signerPub: signer.pub });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${server.address().port}`;

      // drive the decision points: one accepted announce, one rejected (forged sig), one dir fetch
      const good = buildAnnounce({ onion: g1.onion, weight: 100, onionSeedHex: g1.seed });
      await fetch(base + "/announce", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good) });
      const bad = buildAnnounce({ onion: g1.onion, weight: 100, onionSeedHex: g1.seed });
      bad.onionSig = bad.onionSig.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
      await fetch(base + "/announce", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bad) });
      await fetch(base + "/directory");

      const res = await fetch(base + "/metrics");
      ok(res.status === 200, "GET /metrics -> 200");
      ok((res.headers.get("content-type") || "").includes("text/plain"), "/metrics content-type is text/plain");
      const text = await res.text();
      const { type, values } = parseExposition(text);
      ok(type.get("rgoe_bootnode_announces_total") === "counter", "bootnode exposes announces counter");
      ok(values.get('rgoe_bootnode_announces_total{result="accepted"}') === "1", "one accepted announce counted");
      ok(values.get('rgoe_bootnode_announces_total{reason="bad-onion-sig",result="rejected"}') === "1", "one rejected announce counted by reason");
      ok(Number(values.get("rgoe_bootnode_directory_fetches_total")) >= 1, "directory fetch counted");
      ok(values.get("rgoe_bootnode_live_gateways") === "1", "live-gateways gauge reflects the one accepted onion");

      await new Promise((r) => server.close(r));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: metrics selftest (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
