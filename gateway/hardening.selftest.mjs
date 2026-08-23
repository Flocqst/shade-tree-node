// Self-test for gateway endpoint hardening (T-HARD-4): slow-loris deadline on the envelope
// read, idle timeout on the established relay, and concurrent-connection caps (total + per
// nullifier). Runs the REAL connection handler (makeHandler) on a REAL loopback TCP server
// against REAL client sockets — the attacks below are executed on the wire, not modelled.
// The only injections are `verify` (a stub that admits any envelope carrying a nullifier, so
// no Groth16 proof is needed) and the hardening knobs (tiny timeouts so the suite runs fast).
//
//   - slow-loris SILENCE: connect, never send the newline => cut at the deadline with
//     `bad-envelope:envelope timeout`, drop reason `envelope-timeout` counted
//   - slow-loris DRIBBLE: one byte every few ms, no newline => cut at the SAME absolute
//     deadline (activity does not re-arm it), the connection never lives past it
//   - a well-formed envelope arriving just before the deadline still passes (no false cut)
//   - envelope size cap => `envelope-too-large`; close-before-newline => `bad-envelope`
//   - established relay: bytes flow both ways; then no bytes in either direction for the
//     idle timeout => both ends closed, `idle-timeout` counted in tunnel_closes; steady
//     traffic inside the window keeps it open (timer IS re-armed by activity here)
//   - a black-holed upstream connect (never completes) is bounded by the same idle timeout
//   - SHADE_TREE_MAX_CONNS: the (max+1)th concurrent socket is refused `too-many-connections`
//     BEFORE any envelope read; closing one admits the next (release on close)
//   - SHADE_TREE_MAX_CONNS_PER_NULLIFIER: the (max+1)th tunnel on ONE nullifier is refused
//     `nullifier-conn-limit`; other nullifiers unaffected; released on close; and the
//     spent-set still SEES the over-limit share (admit is called before the cap)
//   - clients that vanish before/while sending release their slot (no leak)
//   - HARDENING defaults are the documented values; makeConnLimiter 0 == unlimited
//
// Run:  node gateway/hardening.selftest.mjs

import assert from "node:assert/strict";
import net from "node:net";

// The egress policy is built from env at import time; allow loopback so the fake upstream
// (a local echo server) is an admitted target. Set BEFORE the dynamic import.
process.env.SHADE_TREE_EGRESS_ALLOW = "127.0.0.1:*";
const { makeHandler, makeConnLimiter, HARDENING } = await import("./gateway.mjs");
const { registry: metrics } = await import("../lib/metrics.mjs");

let failures = 0;
function ok(name) { console.log("  PASS  " + name); }
function bad(name, e) { failures++; console.log("  FAIL  " + name + "  ::  " + (e && e.message || e)); }
async function test(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- harness ----------------------------------------------------------------
// Read the value of a labelled series out of the process-wide registry's rendered text.
function metricValue(name, labels) {
  // lib/metrics.mjs renders labels sorted by name.
  const lab = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}="${v}"`).join(",");
  const line = `${name}{${lab}} `;
  const hit = metrics.render().split("\n").find((l) => l.startsWith(line));
  return hit ? Number(hit.slice(line.length)) : 0;
}

// Local echo server standing in for the :443 target (bytes are relayed opaquely either way).
function startEcho() {
  return new Promise((resolve) => {
    const s = net.createServer((c) => { c.on("data", (d) => c.write(d)); c.on("error", () => {}); });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

// A verify stub: admits any envelope with a `nullifier`, reading nullifier/share from the
// envelope itself (the real verifyEnvelope reads them from the proof's public signals).
const stubVerify = async (env) => env.nullifier
  ? { ok: true, nullifier: String(env.nullifier), externalNullifier: "1", share: env.share || { x: "1", y: "2" } }
  : { ok: false, reason: "no-nullifier" };
// A spent-set that admits everything and records what it saw.
function makeAdmitAll() {
  const seen = [];
  return { seen, admit: async (nullifier, share) => { seen.push({ nullifier: String(nullifier), x: String(share.x) }); return { ok: true, action: "first" }; } };
}

function startGateway(handler) {
  return new Promise((resolve) => {
    const s = net.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}
function closeServer(s) { return new Promise((r) => s.close(() => r())); }

// A client socket with a line reader + close tracking.
function dial(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    const st = { sock, lines: [], closed: false, closedAt: 0, buf: "", data: [] };
    sock.on("data", (d) => {
      st.data.push(d);
      st.buf += d.toString("utf8");
      let i;
      while ((i = st.buf.indexOf("\n")) !== -1) { st.lines.push(st.buf.slice(0, i)); st.buf = st.buf.slice(i + 1); }
    });
    sock.on("error", () => {});
    sock.on("close", () => { st.closed = true; st.closedAt = Date.now(); });
    sock.once("connect", () => resolve(st));
    sock.once("error", reject);
  });
}
async function waitFor(pred, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return; await sleep(5); }
  throw new Error("timed out waiting for " + what);
}
const envelopeFor = (nullifier, port, x = "1") => JSON.stringify({ v: 4, target: `127.0.0.1:${port}`, nullifier, share: { x, y: "2" }, nonce: "n" }) + "\n";
const lastJson = (st) => JSON.parse(st.lines[st.lines.length - 1]);

console.log("gateway endpoint hardening (T-HARD-4):");

// ---- defaults ---------------------------------------------------------------
await test("HARDENING defaults are the documented safe values", () => {
  assert.equal(HARDENING.envelopeTimeoutMs, 30000, "envelope deadline 30s (the pre-hardening hard-coded value)");
  assert.equal(HARDENING.idleTimeoutMs, 300000, "relay idle timeout 5 min");
  assert.equal(HARDENING.maxConns, 1024);
  assert.equal(HARDENING.maxConnsPerNullifier, 8);
});

await test("makeConnLimiter: caps, release, per-nullifier isolation, 0 == unlimited", () => {
  const l = makeConnLimiter({ maxConns: 2, maxPerNullifier: 1 });
  assert.equal(l.acquire(), true); assert.equal(l.acquire(), true); assert.equal(l.acquire(), false, "3rd over maxConns=2");
  l.release(); assert.equal(l.acquire(), true, "release frees a slot");
  assert.equal(l.acquireNullifier("a"), true); assert.equal(l.acquireNullifier("a"), false, "2nd on same nullifier over cap 1");
  assert.equal(l.acquireNullifier("b"), true, "other nullifier unaffected");
  l.releaseNullifier("a"); assert.equal(l.acquireNullifier("a"), true, "released nullifier slot reusable");
  assert.equal(l.trackedNullifiers(), 2);
  l.releaseNullifier("a"); l.releaseNullifier("b"); assert.equal(l.trackedNullifiers(), 0, "map entries vanish at zero (bounded by open sockets)");
  l.release(); l.release(); l.release(); l.release(); assert.equal(l.total(), 0, "release never underflows");
  const u = makeConnLimiter({ maxConns: 0, maxPerNullifier: 0 });
  for (let i = 0; i < 50; i++) { assert.equal(u.acquire(), true); assert.equal(u.acquireNullifier("z"), true); }
});

// ---- slow-loris on the envelope read ----------------------------------------
{
  const ENV_MS = 300;
  const echo = await startEcho();
  const admit = makeAdmitAll();
  const gw = await startGateway(makeHandler(admit, { verify: stubVerify, envelopeTimeoutMs: ENV_MS, idleTimeoutMs: 0, limiter: makeConnLimiter({ maxConns: 0, maxPerNullifier: 0 }) }));
  const port = gw.address().port;

  await test("slow-loris SILENCE: connect + never send => cut at the deadline, reason envelope-timeout", async () => {
    const before = metricValue("shade_tree_gateway_tunnels_total", { result: "drop", reason: "envelope-timeout" });
    const t0 = Date.now();
    const c = await dial(port);
    await waitFor(() => c.closed, ENV_MS * 10, "silent client to be closed");
    const dt = c.closedAt - t0;
    assert.ok(dt >= ENV_MS * 0.8, `closed no earlier than the deadline (${dt}ms >= ~${ENV_MS}ms)`);
    assert.ok(dt < ENV_MS * 8, `closed promptly after the deadline (${dt}ms)`);
    assert.equal(lastJson(c).err, "bad-envelope:envelope timeout", "wire reply text unchanged from the pre-hardening path");
    assert.equal(metricValue("shade_tree_gateway_tunnels_total", { result: "drop", reason: "envelope-timeout" }), before + 1, "drop reason envelope-timeout counted once");
  });

  await test("slow-loris DRIBBLE: a byte every 20ms with no newline => cut at the SAME absolute deadline", async () => {
    const before = metricValue("shade_tree_gateway_tunnels_total", { result: "drop", reason: "envelope-timeout" });
    const t0 = Date.now();
    const c = await dial(port);
    let sent = 0;
    const drip = setInterval(() => { if (!c.closed) { try { c.sock.write("x"); sent++; } catch {} } }, 20);
    await waitFor(() => c.closed, ENV_MS * 10, "dribbling client to be closed");
    clearInterval(drip);
    const dt = c.closedAt - t0;
    assert.ok(sent >= 5, `the client really dribbled bytes (${sent})`);
    assert.ok(dt < ENV_MS * 3, `dribbling did NOT extend the deadline (${dt}ms; would be unbounded with an inactivity timer)`);
    assert.equal(lastJson(c).err, "bad-envelope:envelope timeout");
    assert.equal(metricValue("shade_tree_gateway_tunnels_total", { result: "drop", reason: "envelope-timeout" }), before + 1);
  });

  await test("a slow-but-honest client that completes the envelope inside the deadline is NOT cut", async () => {
    const c = await dial(port);
    const env = envelopeFor("late-1", echo.address().port);
    // Send in two halves with a pause well inside the deadline.
    c.sock.write(env.slice(0, 10));
    await sleep(ENV_MS / 3);
    c.sock.write(env.slice(10));
    await waitFor(() => c.lines.length >= 1, ENV_MS * 5, "success ack");
    assert.deepEqual(lastJson(c), { ok: true }, "admitted and tunneled");
    assert.equal(c.closed, false, "still open (no false positive)");
    c.sock.destroy();
  });

  await test("envelope size cap => envelope-too-large; close-before-newline => bad-envelope (both counted, socket released)", async () => {
    const tooBig = metricValue("shade_tree_gateway_tunnels_total", { result: "drop", reason: "envelope-too-large" });
    const badEnv = metricValue("shade_tree_gateway_tunnels_total", { result: "drop", reason: "bad-envelope" });
    const c1 = await dial(port);
    c1.sock.write(Buffer.alloc(70 * 1024, 0x61)); // 70 KiB of 'a', no newline
    await waitFor(() => c1.closed, ENV_MS * 5, "oversized client to be closed");
    assert.equal(lastJson(c1).err, "bad-envelope:envelope too large");
    assert.equal(metricValue("shade_tree_gateway_tunnels_total", { result: "drop", reason: "envelope-too-large" }), tooBig + 1);
    const c2 = await dial(port);
    c2.sock.write("{\"partial\":");
    c2.sock.end(); // half-close before the newline
    await waitFor(() => c2.closed, ENV_MS * 5, "half-closed client to be closed");
    assert.equal(metricValue("shade_tree_gateway_tunnels_total", { result: "drop", reason: "bad-envelope" }), badEnv + 1);
  });

  await closeServer(gw); await closeServer(echo);
}

// ---- idle timeout on the established relay ----------------------------------
{
  const IDLE_MS = 300;
  const echo = await startEcho();
  const admit = makeAdmitAll();
  const gw = await startGateway(makeHandler(admit, { verify: stubVerify, envelopeTimeoutMs: 5000, idleTimeoutMs: IDLE_MS, limiter: makeConnLimiter({ maxConns: 0, maxPerNullifier: 0 }) }));
  const port = gw.address().port;

  await test("established relay: bytes flow both ways, then idle in BOTH directions => closed, idle-timeout counted", async () => {
    const before = metricValue("shade_tree_gateway_tunnel_closes_total", { reason: "idle-timeout" });
    const c = await dial(port);
    c.sock.write(envelopeFor("idle-1", echo.address().port));
    await waitFor(() => c.lines.length >= 1, 3000, "success ack");
    assert.deepEqual(lastJson(c), { ok: true });
    c.sock.write("ping\n");
    await waitFor(() => c.lines.length >= 2, 3000, "echo through the tunnel");
    assert.equal(c.lines[1], "ping", "relay carries bytes client->target->client");
    const t0 = Date.now();
    await waitFor(() => c.closed, IDLE_MS * 10, "idle tunnel to be closed");
    const dt = c.closedAt - t0;
    assert.ok(dt >= IDLE_MS * 0.8, `not closed before the idle window (${dt}ms)`);
    assert.equal(metricValue("shade_tree_gateway_tunnel_closes_total", { reason: "idle-timeout" }), before + 1, "idle-timeout counted once");
  });

  await test("steady traffic inside the idle window keeps the tunnel open (activity re-arms the idle timer)", async () => {
    const c = await dial(port);
    c.sock.write(envelopeFor("busy-1", echo.address().port));
    await waitFor(() => c.lines.length >= 1, 3000, "success ack");
    const t0 = Date.now();
    let n = 0;
    while (Date.now() - t0 < IDLE_MS * 3) { c.sock.write("k\n"); n++; await sleep(IDLE_MS / 4); }
    assert.equal(c.closed, false, `still open after ${IDLE_MS * 3}ms of periodic traffic (${n} writes)`);
    await waitFor(() => c.lines.length >= 1 + n, 3000, "all echoes");
    c.sock.destroy();
  });

  await test("a black-holed upstream connect (never completes, never errors) is bounded by the idle timeout", async () => {
    // A connector whose socket never connects and never errors: the classic SYN black hole.
    const blackHole = () => { const s = new net.Socket(); return s; };
    const admit2 = makeAdmitAll();
    const gw2 = await startGateway(makeHandler(admit2, { verify: stubVerify, connect: blackHole, envelopeTimeoutMs: 5000, idleTimeoutMs: IDLE_MS, limiter: makeConnLimiter({ maxConns: 0, maxPerNullifier: 0 }) }));
    const before = metricValue("shade_tree_gateway_tunnels_total", { result: "drop", reason: "upstream-timeout" });
    const c = await dial(gw2.address().port);
    c.sock.write(envelopeFor("bh-1", 1));
    await waitFor(() => c.closed, IDLE_MS * 10, "black-holed tunnel to be cut");
    assert.equal(lastJson(c).err, "upstream:ETIMEDOUT");
    assert.equal(metricValue("shade_tree_gateway_tunnels_total", { result: "drop", reason: "upstream-timeout" }), before + 1);
    await closeServer(gw2);
  });

  await closeServer(gw); await closeServer(echo);
}

// ---- concurrent-connection caps ---------------------------------------------
{
  const echo = await startEcho();
  const admit = makeAdmitAll();
  const limiter = makeConnLimiter({ maxConns: 3, maxPerNullifier: 2 });
  const gw = await startGateway(makeHandler(admit, { verify: stubVerify, envelopeTimeoutMs: 5000, idleTimeoutMs: 0, limiter }));
  const port = gw.address().port;

  await test("SHADE_TREE_MAX_CONNS: the 4th concurrent socket is refused too-many-connections BEFORE any envelope; closing one admits the next", async () => {
    const before = metricValue("shade_tree_gateway_tunnels_total", { result: "drop", reason: "too-many-connections" });
    const held = [await dial(port), await dial(port), await dial(port)]; // 3 idle sockets, no envelope sent
    await waitFor(() => limiter.total() === 3, 2000, "3 held connections accounted");
    const c4 = await dial(port);
    await waitFor(() => c4.closed, 3000, "4th connection to be refused");
    assert.equal(lastJson(c4).err, "too-many-connections");
    assert.equal(metricValue("shade_tree_gateway_tunnels_total", { result: "drop", reason: "too-many-connections" }), before + 1);
    assert.equal(admit.seen.length, 0, "the refused socket never reached admit (no envelope read at all)");
    held[0].sock.destroy();
    await waitFor(() => limiter.total() === 2, 2000, "release on close");
    const c5 = await dial(port);
    await sleep(100);
    assert.equal(c5.closed, false, "a slot freed by close is granted to the next connection");
    for (const h of held) h.sock.destroy();
    c5.sock.destroy();
    await waitFor(() => limiter.total() === 0, 2000, "all released");
  });

  await test("SHADE_TREE_MAX_CONNS_PER_NULLIFIER: 3rd tunnel on ONE nullifier refused nullifier-conn-limit; other nullifiers fine; spent-set still saw the share; released on close", async () => {
    const before = metricValue("shade_tree_gateway_tunnels_total", { result: "drop", reason: "nullifier-conn-limit" });
    const seen0 = admit.seen.length;
    const t1 = await dial(port); t1.sock.write(envelopeFor("N", echo.address().port));
    await waitFor(() => t1.lines.length >= 1, 3000, "t1 ack");
    const t2 = await dial(port); t2.sock.write(envelopeFor("N", echo.address().port));
    await waitFor(() => t2.lines.length >= 1, 3000, "t2 ack");
    assert.deepEqual(lastJson(t1), { ok: true }); assert.deepEqual(lastJson(t2), { ok: true });
    assert.equal(limiter.nullifierCount("N"), 2);
    // maxConns is 3 -- the 3rd socket is admitted at accept, then refused at the per-nullifier gate.
    const t3 = await dial(port); t3.sock.write(envelopeFor("N", echo.address().port, "2")); // a DISTINCT share.x too
    await waitFor(() => t3.closed, 3000, "t3 refused");
    assert.equal(lastJson(t3).err, "nullifier-conn-limit");
    assert.equal(metricValue("shade_tree_gateway_tunnels_total", { result: "drop", reason: "nullifier-conn-limit" }), before + 1);
    assert.equal(admit.seen.length - seen0, 3, "admit saw ALL three shares (the cap sits AFTER admit so a slashable 2nd distinct share is never hidden)");
    assert.equal(admit.seen[admit.seen.length - 1].x, "2", "...including the distinct-x share on the refused tunnel");
    // Another nullifier is unaffected (t3's slot was released at its close; give the server-side
    // close event a beat -- the client can observe the close before the server's handler runs).
    await sleep(50);
    await waitFor(() => limiter.total() === 2, 2000, "t3 slot released");
    const o1 = await dial(port); o1.sock.write(envelopeFor("OTHER", echo.address().port));
    await waitFor(() => o1.lines.length >= 1, 3000, "other nullifier ack");
    assert.deepEqual(lastJson(o1), { ok: true }, "a different nullifier is not limited by N's cap");
    o1.sock.destroy();
    // Close one N tunnel -> the per-nullifier slot frees -> a new N tunnel is admitted.
    t1.sock.destroy();
    await waitFor(() => limiter.nullifierCount("N") === 1, 2000, "N slot released on close");
    const t4 = await dial(port); t4.sock.write(envelopeFor("N", echo.address().port));
    await waitFor(() => t4.lines.length >= 1, 3000, "t4 ack");
    assert.deepEqual(lastJson(t4), { ok: true }, "slot freed by close is granted to a new tunnel on the same nullifier");
    t2.sock.destroy(); t4.sock.destroy();
    await waitFor(() => limiter.total() === 0 && limiter.trackedNullifiers() === 0, 2000, "everything released; no per-nullifier residue");
  });

  await test("clients that vanish mid-envelope or before sending never leak a slot", async () => {
    const a = await dial(port); a.sock.write("{\"half"); a.sock.destroy();
    const b = await dial(port); b.sock.destroy();
    const c = await dial(port); c.sock.write(envelopeFor("V", echo.address().port)); await waitFor(() => c.lines.length >= 1, 3000, "ack"); c.sock.destroy();
    await waitFor(() => limiter.total() === 0 && limiter.trackedNullifiers() === 0, 3000, "all slots released");
  });

  await closeServer(gw); await closeServer(echo);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: gateway hardening selftest (${failures} failure${failures === 1 ? "" : "s"})`);
process.exit(failures === 0 ? 0 : 1);
