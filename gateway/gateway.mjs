// The gateway: a reputation-gated egress proxy, published as a Tor onion service.
//
// It listens on 127.0.0.1:8443 (Tor maps <addr>.onion:80 -> here). For each
// incoming connection it:
//   1. reads a single newline-terminated v3 JSON envelope
//      { v:3, target, proof /*RLNFullProof*/, nullifier, externalNullifier, share },
//   2. verifies it CHEAP-FIRST (docs/NEXT-VERSION.md, adversarial-review #4):
//        externalNullifier is current/previous epoch's               (cheap)
//        share.x == proof's committed public x                        (cheap)
//        proof's public root ∈ recent-roots                           (cheap)
//        RLN Groth16 verifyProof                                      (expensive SNARK)
//      all bundled behind lib verifyEnvelope(),
//   3. collects the RLN share per `nullifier`: the first share egresses; an identical
//      replay (same share.x) is deduped (no slash); a SECOND DISTINCT signal (same
//      nullifier, different x) reconstructs the identitySecret and slashes the member's
//      on-chain stake,
//   4. on success opens a raw :443 TCP tunnel to `target` from THIS host's IP and
//      pipes bytes both ways (TLS stays end-to-end client<->target),
//   5. on any failure writes a short error envelope and drops the connection.
//
// The reputation root is read from a RootProvider (the on-chain StakedReputationSet,
// via lib/root-provider.mjs) so TRUSTED_ROOT is a recent-roots SET refreshed on
// membership change, not a static members.json. Without RGOE_GROUP_CONTRACT it falls
// back to members.json so the PoC path still works.

import net from "node:net";
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verifyEnvelope, loadGroupOnchain, loadGroup, currentEpoch, EPOCH_SECONDS, MEMBERS_PATH } from "../lib/semaphore.mjs";
import { reconstructSecret, deriveCommitment } from "../lib/rln.mjs";
import { makeRootProvider } from "../lib/root-provider.mjs";
import { registry as metrics, makeMetricsServer } from "../lib/metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = 8443;
const MAX_ENVELOPE = 64 * 1024;

// ---- metrics (T-MON-2) ------------------------------------------------------
// Registered against the process-wide registry at import time: this only fills in-memory
// state and binds NO port. The gateway speaks raw TCP, so /metrics is exposed by a SEPARATE
// loopback http server started only when RGOE_METRICS_PORT is set (see main()). Off by
// default => existing behavior and every selftest are byte-for-byte unchanged. All
// increments below sit on cold branches / the connect callback, never the per-byte pipe.
const M = {
  requests: metrics.counter("rgoe_gateway_requests_total", "Requests by result=pass|drop (+ reason on drop)."),
  slashes: metrics.counter("rgoe_gateway_slashes_total", "Members slashed for an RLN over-spend (2nd distinct signal on a nullifier)."),
  verify: metrics.histogram("rgoe_gateway_verify_seconds", "verifyEnvelope() latency in seconds (cheap-first checks + Groth16)."),
};

// ---- recent-roots: the accepted admission roots, refreshed on change --------
// A proof against any root inside the freshness window verifies. On-chain: fed by
// the RootProvider. PoC fallback: the single members.json root, re-read on change.
let recentRoots = new Set();

async function initRoots() {
  if (process.env.RGOE_GROUP_CONTRACT) {
    const provider = makeRootProvider(); // node|light per RGOE_ROOT_PROVIDER
    const refresh = async () => {
      const { recentRoots: roots } = await loadGroupOnchain(provider);
      recentRoots = new Set((roots || []).map(String));
    };
    await refresh();
    provider.onChange?.(() => refresh().catch((e) => console.log(`root refresh failed (${e.message}); keeping recent-roots`)));
    console.log(`root source: on-chain RootProvider (${process.env.RGOE_ROOT_PROVIDER || "node"}), ${recentRoots.size} recent root(s)`);
    return { count: null };
  }
  // PoC fallback: members.json is the root source; refresh on file change.
  const load = async () => {
    const { root, count } = await loadGroup();
    recentRoots = new Set([String(root)]);
    return count;
  };
  let count = await load();
  try {
    watch(MEMBERS_PATH, { persistent: false }, () => load().then((c) => { count = c; }).catch(() => {}));
  } catch { /* watch is best-effort */ }
  console.log(`root source: members.json (PoC fallback), ${count} members`);
  return { count };
}

// ---- share-collecting spent-set (RLN slashing at PoC fidelity) --------------
// Keyed by `nullifier` alone (there is no public slot in RLN v3 — the messageId is a
// private circuit witness). Stores the first share; a second DISTINCT evaluation point
// (distinct public `x`) under the same nullifier is a provable over-spend: reconstruct
// the identitySecret from the two shares, derive the rateCommitment leaf, and slash. An
// IDENTICAL replay (same share.x) is deduped and is NEVER slashed (no new point).
//
// reconstruct/derive/slash are injected so the selftest can drive this control flow
// with mocks (the real lib + on-chain slasher land at combine).
export function makeSpentSet({ reconstruct = reconstructSecret, derive = deriveCommitment, slash, ttlMs = 2 * EPOCH_SECONDS * 1000 } = {}) {
  const seen = new Map(); // nullifier -> { xs:Set, first:share, slashed:bool, at:number }
  const keyOf = (nullifier) => String(nullifier);

  async function admit(nullifier, share) {
    if (!share || share.x == null) return { ok: false, action: "bad-share", reason: "no-share" };
    const k = keyOf(nullifier);
    const e = seen.get(k);

    if (!e) {
      seen.set(k, { xs: new Set([String(share.x)]), first: share, slashed: false, at: Date.now() });
      return { ok: true, action: "first" };
    }
    if (e.slashed) return { ok: false, action: "slashed", reason: "rate-slashed" };
    if (e.xs.has(String(share.x))) return { ok: true, action: "replay" }; // idempotent honest retry

    // Distinct public x under the same nullifier: the L+1-th point. Over-spend.
    e.slashed = true; // slash exactly once for this nullifier
    M.slashes.inc(); // one over-spend detected (counted at the point we decide to slash)
    let commitment = null;
    try {
      const secret = reconstruct(e.first, share); // identitySecret
      commitment = derive(secret);                // rateCommitment leaf
      if (slash) await slash(commitment, secret);
    } catch (err) {
      console.log(`slash failed for null=${String(nullifier).slice(0, 10)}..: ${err.message}`);
    }
    return { ok: false, action: "slash", reason: "over-spend-slashed", commitment };
  }

  function sweep() {
    const cutoff = Date.now() - ttlMs;
    for (const [k, e] of seen) if (e.at < cutoff) seen.delete(k);
  }

  return { admit, sweep, size: () => seen.size };
}

// ---- on-chain slash submitter (ethers, hot key) -----------------------------
// The gateway's slashing is NOT anonymous and does not need to be: RGOE_SLASH_KEY is
// an operational hot key, deliberately separate from any member secret. Address +
// rpc come from contracts/deployed.local.json (or env). ethers is imported lazily so
// the gateway still runs without it (falls back to a dry-run log).
async function readDeployed() {
  try {
    return JSON.parse(await readFile(join(HERE, "..", "contracts", "deployed.local.json"), "utf8"));
  } catch {
    return {};
  }
}

async function makeSlasher() {
  const key = process.env.RGOE_SLASH_KEY;
  const deployed = await readDeployed();
  // The slash contract is INDEPENDENT of the membership root source. RGOE_SLASH_CONTRACT
  // (or a deployed.local.json) enables on-chain slashing while membership stays on
  // members.json; it deliberately does NOT read RGOE_GROUP_CONTRACT, which is the
  // separate trigger for on-chain root mode (initRoots). So a gateway can slash on-chain
  // without also switching its membership tree — the common fleet config.
  const address = process.env.RGOE_SLASH_CONTRACT || deployed.stakedReputationSet
    || deployed.StakedReputationSet || deployed.address;
  const rpcUrl = process.env.RGOE_RPC_URL || deployed.rpcUrl || "http://127.0.0.1:8545";
  const receiver = process.env.RGOE_SLASH_RECEIVER || null;

  if (!key || !address) {
    console.log("slash: DRY-RUN (set RGOE_SLASH_KEY + deployed.local.json/RGOE_GROUP_CONTRACT to submit on chain)");
    return async (commitment, secret) => {
      // Log the (public) commitment leaf only; never any bytes of the reconstructed secret.
      console.log(`SLASH (dry-run) commitment=${String(commitment).slice(0, 18)}..`);
    };
  }

  let ethers;
  try {
    ({ ethers } = await import("ethers"));
  } catch {
    console.log("slash: ethers not installed; DRY-RUN only (add `ethers` to package.json)");
    return async (commitment) => console.log(`SLASH (dry-run, no ethers) commitment=${String(commitment).slice(0, 18)}..`);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(key, provider);
  const contract = new ethers.Contract(address, ["function slash(uint256 commitment, uint256 secret, address receiver)"], wallet);
  const rcv = receiver || wallet.address;
  console.log(`slash: on-chain via ${address} (receiver ${rcv})`);
  return async (commitment, secret) => {
    const tx = await contract.slash(commitment, secret, rcv);
    console.log(`SLASH tx ${tx.hash} commitment=${String(commitment).slice(0, 18)}.. (waiting)`);
    const rcpt = await tx.wait();
    console.log(`SLASH mined block ${rcpt.blockNumber} commitment=${String(commitment).slice(0, 18)}..`);
  };
}

// ---- wire protocol ----------------------------------------------------------

function readEnvelope(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length > MAX_ENVELOPE) cleanup(new Error("envelope too large"));
        return;
      }
      const line = buf.subarray(0, nl).toString("utf8");
      const rest = buf.subarray(nl + 1); // any early bytes after the envelope
      cleanup(null, line, rest);
    };
    const onErr = (e) => cleanup(e);
    const onEnd = () => cleanup(new Error("closed before envelope"));
    const timer = setTimeout(() => cleanup(new Error("envelope timeout")), 30000);
    function cleanup(err, line, rest) {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onErr);
      socket.removeListener("end", onEnd);
      if (err) reject(err);
      else resolve({ line, rest });
    }
    socket.on("data", onData);
    socket.on("error", onErr);
    socket.on("end", onEnd);
  });
}

function reply(socket, obj) {
  try { socket.write(JSON.stringify(obj) + "\n"); } catch {}
}

function validTarget(target) {
  if (typeof target !== "string") return null;
  const m = target.match(/^([a-zA-Z0-9.\-]+):(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  // PoC egress policy: TLS ports only, so the gateway is a metadata-only tunnel
  // and never sees plaintext. Widen deliberately if you want a forward proxy.
  if (port !== 443) return null;
  return { host: m[1], port };
}

function makeHandler(spentSet) {
  return async function handle(socket) {
    socket.setNoDelay(true);
    let env;
    try {
      const { line, rest } = await readEnvelope(socket);
      env = JSON.parse(line);
      env.__rest = rest;
    } catch (e) {
      reply(socket, { ok: false, err: "bad-envelope:" + e.message });
      return socket.destroy();
    }

    // Everything after the envelope parse is guarded: any throw must REPLY, never hang
    // the client (a silent throw here is exactly the bug that left clients waiting).
    try {
      // Steps 1-3, cheap-first, inside the lib: fresh externalNullifier -> share.x binding
      // -> root ∈ recent-roots -> RLN Groth16 verify. Returns the authoritative
      // nullifier/externalNullifier/share (read from the proof's public signals) to act on.
      const t0 = performance.now();
      const v = await verifyEnvelope(env, recentRoots);
      M.verify.observe((performance.now() - t0) / 1000);
      if (!v.ok) {
        console.log(`DROP  ${v.reason}  target=${env.target}`);
        M.requests.inc({ result: "drop", reason: v.reason });
        reply(socket, { ok: false, err: "gate:" + v.reason });
        return socket.destroy();
      }

      const tgt = validTarget(env.target);
      if (!tgt) {
        M.requests.inc({ result: "drop", reason: "bad-target" });
        reply(socket, { ok: false, err: "bad-target" });
        return socket.destroy();
      }

      // Step 4: nullifier dedup + share collection; slashes on 2nd distinct signal.
      const res = await spentSet.admit(v.nullifier, v.share);
      if (!res.ok) {
        console.log(`DROP  ${res.reason}  null=${String(v.nullifier).slice(0, 10)}..`);
        M.requests.inc({ result: "drop", reason: res.reason });
        reply(socket, { ok: false, err: res.reason });
        return socket.destroy();
      }

      // Step 5: egress :443 tunnel (unchanged; TLS stays end-to-end).
      const upstream = net.connect(tgt.port, tgt.host, () => {
        console.log(`PASS  egress->${tgt.host}:${tgt.port}  null=${String(v.nullifier).slice(0, 10)}.. extNull=${String(v.externalNullifier).slice(0, 10)}..`);
        M.requests.inc({ result: "pass" });
        reply(socket, { ok: true });
        if (env.__rest && env.__rest.length) upstream.write(env.__rest);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.setNoDelay(true);
      upstream.on("error", (e) => {
        reply(socket, { ok: false, err: "upstream:" + e.code });
        socket.destroy();
      });
      socket.on("error", () => upstream.destroy());
    } catch (e) {
      console.log(`ERROR  ${e.message}  target=${env.target}`);
      reply(socket, { ok: false, err: "gateway-error" });
      return socket.destroy();
    }
  };
}

// ---- graceful shutdown / connection draining (T-DEV-8) ----------------------
// OFF the hot path: signal handlers + a small openSockets set only; request handling
// is untouched. On SIGTERM/SIGINT we stop accepting NEW connections (server.close),
// let in-flight tunnels drain, then exit 0. If they outlive the grace window we
// force-destroy the stragglers and exit nonzero. server.close(cb) fires cb once the
// listener is shut AND every existing connection has ended, so the openSockets set is
// needed only to force-close on timeout (never consulted per-request).
//
// Factored out + fully injectable (server, timer, onExit) so the selftest can drive it
// with a fake server + fake sockets + a fake clock, no real process signals involved.
export function makeGracefulShutdown(server, {
  openSockets = new Set(),
  timeoutMs = 10000,
  onExit = (code) => process.exit(code),
  log = console.log,
  label = "gateway",
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let started = false; // idempotent: a second signal during drain is ignored
  return function shutdown(signal) {
    if (started) return;
    started = true;
    log(`${label}: draining (${signal || "shutdown"}); ${openSockets.size} in-flight, no new connections, ${timeoutMs}ms grace`);
    let timer = null;
    const finish = (code) => { if (timer) clearTimer(timer); onExit(code); };
    // Arm the grace window FIRST so an immediate (synchronous) clean drain can clear it —
    // force-close whatever is still open and exit nonzero if it elapses.
    timer = setTimer(() => {
      log(`${label}: drain timeout (${timeoutMs}ms) with ${openSockets.size} still open; forcing exit`);
      for (const s of openSockets) { try { s.destroy(); } catch {} }
      finish(1);
    }, timeoutMs);
    timer.unref?.();
    // Stop the listener; cb fires once all existing connections have ended -> clean exit.
    server.close(() => { log(`${label}: drained cleanly, exiting`); finish(0); });
    return timer;
  };
}

async function main() {
  await initRoots();
  const slash = await makeSlasher();
  const spentSet = makeSpentSet({ slash });
  setInterval(() => spentSet.sweep(), EPOCH_SECONDS * 1000).unref();

  const server = net.createServer(makeHandler(spentSet));

  // Track live tunnels for draining (add/delete only — no per-byte work).
  const openSockets = new Set();
  server.on("connection", (s) => { openSockets.add(s); s.on("close", () => openSockets.delete(s)); });

  // Active-tunnels gauge reads openSockets.size at scrape time (the same set draining uses).
  metrics.gauge("rgoe_gateway_active_tunnels", "Open egress tunnels right now.").setCollect(() => openSockets.size);

  // Loopback /metrics on a SEPARATE http server, ONLY when RGOE_METRICS_PORT is set.
  // Default OFF keeps the gateway a pure TCP server (existing behavior + tests unchanged).
  const metricsPort = Number(process.env.RGOE_METRICS_PORT || 0);
  let metricsServer = null;
  if (metricsPort > 0) {
    const metricsHost = process.env.RGOE_METRICS_HOST || "127.0.0.1";
    metricsServer = makeMetricsServer(metrics);
    metricsServer.listen(metricsPort, metricsHost, () => console.log(`metrics on http://${metricsHost}:${metricsPort}/metrics (loopback)`));
  }

  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(`gateway up on ${LISTEN_HOST}:${LISTEN_PORT}  (epoch ${currentEpoch()}, ${EPOCH_SECONDS}s)`);
    console.log(`egress policy: :443 only (metadata-only TLS tunnel)`);
    console.log(`rate: RLN degree-1 per nullifier; 2nd distinct signal on a nullifier => reconstruct + slash`);
  });

  const timeoutMs = Number(process.env.RGOE_SHUTDOWN_TIMEOUT_MS || 10000);
  const shutdown = makeGracefulShutdown(server, { openSockets, timeoutMs, label: "gateway" });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only run the server when invoked directly; importing (the selftest) pulls the
// exported makeSpentSet / makeGracefulShutdown control flow with mocks and installs
// NO signal handlers (only main() does, below).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
