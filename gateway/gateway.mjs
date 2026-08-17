// The gateway: a reputation-gated egress proxy, published as a Tor onion service.
//
// It listens on 127.0.0.1:8443 (Tor maps <addr>.onion:80 -> here). For each
// incoming connection it:
//   1. reads a single newline-terminated v3 JSON envelope
//      { v:3, target, nonce, artifact?, proof /*RLNFullProof*/, nullifier, externalNullifier, share },
//   2. verifies it CHEAP-FIRST (docs/NEXT-VERSION.md, adversarial-review #4):
//        externalNullifier is current/previous epoch's               (cheap)
//        share.x == proof's committed public x                        (cheap)
//        proof's public root ∈ recent-roots                           (cheap)
//        `artifact` id ∈ the accepted ZK artifact set (T-HARD-8)      (cheap; absent => legacy id)
//        RLN Groth16 verifyProof under THAT artifact's vkey            (expensive SNARK)
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
import { verifyEnvelope, loadGroupOnchain, loadGroup, currentEpoch, EPOCH_SECONDS, MEMBERS_PATH, getArtifactSet } from "../lib/semaphore.mjs";
import { reconstructSecret, deriveCommitment } from "../lib/rln.mjs";
import { makeRootProvider } from "../lib/root-provider.mjs";
import { buildReceipt } from "../lib/receipt.mjs";
import { makeConfiguredFleetTally } from "./fleet-tally.mjs";
import { registry as metrics, makeMetricsServer } from "../lib/metrics.mjs";
import { log } from "../lib/log.mjs";

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
// Test seam (gateway/*.selftest.mjs, lib/zk-artifacts.selftest.mjs): install the accepted
// root set directly so a handler can be driven without initRoots()/members.json/a chain.
export function _setRecentRoots(roots) { recentRoots = new Set(Array.from(roots || []).map(String)); }

async function initRoots() {
  if (process.env.RGOE_GROUP_CONTRACT) {
    const provider = makeRootProvider(); // node|light per RGOE_ROOT_PROVIDER
    const refresh = async () => {
      const { recentRoots: roots } = await loadGroupOnchain(provider);
      recentRoots = new Set((roots || []).map(String));
    };
    await refresh();
    provider.onChange?.(() => refresh().catch((e) => log.warn("root refresh failed; keeping recent-roots", { err: e.message })));
    log.info("root source: on-chain RootProvider", { provider: process.env.RGOE_ROOT_PROVIDER || "node", recentRoots: recentRoots.size });
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
  log.info("root source: members.json (PoC fallback)", { members: count });
  return { count };
}

// ---- share-collecting spent-set (RLN slashing at PoC fidelity) --------------
// Keyed by `nullifier` alone (there is no public slot in RLN v3 — the messageId is a
// private circuit witness). Stores the first share; a second DISTINCT evaluation point
// (distinct public `x`) under the same nullifier is a provable over-spend: reconstruct
// the identitySecret from the two shares, derive the rateCommitment leaf, and slash. An
// IDENTICAL replay (same share.x) is NEVER slashed (no new point) — but see below for
// exactly WHEN that identical replay egresses vs is rejected.
//
// ---- cross-gateway replay defense: per-epoch seen-envelope cache (T-FEAT-12) ----
// Target binding (T-DEV-3) stops a captured proof being REDIRECTED to a new target, but an
// EXACT-envelope replay (same nullifier + same share.x + same nonce/target) to the SAME
// gateway still passed the nullifier dedup as an "honest retry" and egressed idempotently,
// with no time bound. A malicious relay could therefore replay a member's captured envelope
// to peer gateways and amplify apparent traffic on one proof. We add a per-gateway defense:
//
//   The seen-envelope cache fingerprints each admitted envelope by (nullifier, share.x,
//   nonce) and records WHEN it was first seen HERE. On an identical share.x under a live
//   nullifier:
//     - age <= RGOE_REPLAY_WINDOW_MS  => an in-flight HONEST retry (e.g. a dropped
//       connection re-sent within a few seconds). Idempotent: action "replay", ok:true,
//       NO second egress, NO slash. This preserves the deterministic-retry allowance.
//     - age  > RGOE_REPLAY_WINDOW_MS  (or a fingerprint we never recorded, e.g. same
//       share.x under a different nonce) => an ABUSIVE late replay. Rejected ok:false,
//       action/reason "replayed-envelope"; the handler counts the drop metric + logs.
//
// Why a SHORT window is the right scoping, and why it does not break failover: the client
// reuses the SAME envelope across gateway FAILOVER, but failover hits DIFFERENT gateways,
// so a PER-gateway cache never sees that legitimate reuse twice. Only a genuine same-gateway
// resend (dropped connection) repeats here, and it does so within seconds — comfortably
// inside the window. Anything repeating on ONE gateway seconds/minutes later is a replay.
//
// CROSS-FLEET (T-FEAT-20): the per-gateway cache above defends ONE gateway only. A
// non-colluding fleet still has no SHARED spent-set, so a malicious relay can fan a captured
// envelope out to its PEERS (each sees it once). The optional `sharedTally` (gateway/fleet-
// tally.mjs) closes that: on a nullifier we have NOT seen locally, we first ask the shared
// tally whether a PEER already admitted it this epoch and, if so, reject it as an exact
// fleet-wide replay; when we DO admit a first-seen nullifier, we record it to the tally so
// peers reject the same envelope. Only (nullifier, epoch) crosses the tally — never share.y,
// target, or member identity (see the privacy note in fleet-tally.mjs). The tally is consulted
// ONLY on the first-locally-seen branch, so the local slash path (2nd distinct share.x) and the
// honest-retry window are UNCHANGED, and it is fail-OPEN: any tally error degrades to exactly
// the per-gateway defense. sharedTally=null (the default) => byte-identical to T-FEAT-12.
//
// reconstruct/derive/slash are injected so the selftest can drive this control flow with
// mocks (the real lib + on-chain slasher land at combine). `now` is injectable so the
// window is deterministically testable without a real wall clock.
export function makeSpentSet({
  reconstruct = reconstructSecret,
  derive = deriveCommitment,
  slash,
  sharedTally = null,
  ttlMs = 2 * EPOCH_SECONDS * 1000,
  replayWindowMs = Number(process.env.RGOE_REPLAY_WINDOW_MS) || 5000,
  now = () => Date.now(),
} = {}) {
  const seen = new Map();    // nullifier -> { xs:Set, first:share, slashed:bool, at:number }
  const seenEnv = new Map(); // "nullifier|share.x|nonce" -> firstSeenAt (exact-envelope fingerprints)
  const keyOf = (nullifier) => String(nullifier);
  const envKeyOf = (nullifier, share, nonce) => `${nullifier}|${share.x}|${nonce ?? ""}`;

  async function admit(nullifier, share, opts = {}) {
    if (!share || share.x == null) return { ok: false, action: "bad-share", reason: "no-share" };
    const nonce = opts.nonce;
    const k = keyOf(nullifier);
    const ek = envKeyOf(nullifier, share, nonce);
    const e = seen.get(k);

    if (!e) {
      // First time THIS gateway sees this nullifier. Before admitting, ask the shared fleet
      // tally whether a PEER already admitted it this epoch — if so, this is an exact
      // fleet-wide replay (a captured envelope fanned to us), reject it. `has()` is fail-open:
      // an unreachable/throwing tally returns false and we fall through to the local admit, so
      // a tally outage degrades to the per-gateway defense, never denies a legitimate member.
      if (sharedTally && sharedTally.has(nullifier, opts.epoch)) {
        log.warn("replayed-envelope rejected (fleet tally)", {
          nullifier: String(nullifier).slice(0, 10) + "..",
          scope: "fleet",
        });
        return { ok: false, action: "replayed-envelope", reason: "replayed-envelope", scope: "fleet" };
      }
      const t = now();
      seen.set(k, { xs: new Set([String(share.x)]), first: share, slashed: false, at: t });
      seenEnv.set(ek, t);
      // Announce the admitted nullifier so peers reject the same envelope. Only (nullifier,
      // epoch) is shared; record() is fail-open (a publish failure never blocks this egress).
      if (sharedTally) sharedTally.record(nullifier, opts.epoch);
      return { ok: true, action: "first" };
    }
    if (e.slashed) return { ok: false, action: "slashed", reason: "rate-slashed" };
    if (e.xs.has(String(share.x))) {
      // Identical evaluation point == an exact-envelope replay to THIS gateway. Distinguish
      // an in-flight honest retry (within the window) from an abusive late replay.
      const firstAt = seenEnv.get(ek);
      if (firstAt != null && (now() - firstAt) <= replayWindowMs) {
        return { ok: true, action: "replay" }; // idempotent honest retry (dropped-conn resend)
      }
      // Out-of-window, or a fingerprint we never recorded (same share.x, foreign nonce): drop.
      log.warn("replayed-envelope rejected", {
        nullifier: String(nullifier).slice(0, 10) + "..",
        ageMs: firstAt != null ? now() - firstAt : null,
        windowMs: replayWindowMs,
      });
      return { ok: false, action: "replayed-envelope", reason: "replayed-envelope" };
    }

    // Distinct public x under the same nullifier: the L+1-th point. Over-spend.
    e.slashed = true; // slash exactly once for this nullifier
    M.slashes.inc(); // one over-spend detected (counted at the point we decide to slash)
    let commitment = null;
    try {
      const secret = reconstruct(e.first, share); // identitySecret
      commitment = derive(secret);                // rateCommitment leaf
      if (slash) await slash(commitment, secret);
    } catch (err) {
      log.error("slash failed", { nullifier: String(nullifier).slice(0, 10) + "..", err: err.message });
    }
    return { ok: false, action: "slash", reason: "over-spend-slashed", commitment };
  }

  function sweep() {
    const cutoff = now() - ttlMs;
    for (const [k, e] of seen) if (e.at < cutoff) seen.delete(k);
    for (const [ek, at] of seenEnv) if (at < cutoff) seenEnv.delete(ek);
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
    log.info("slash: DRY-RUN (set RGOE_SLASH_KEY + deployed.local.json/RGOE_GROUP_CONTRACT to submit on chain)");
    return async (commitment, secret) => {
      // Log the (public) commitment leaf only; never any bytes of the reconstructed secret.
      log.info("SLASH (dry-run)", { commitment: String(commitment).slice(0, 18) + ".." });
    };
  }

  let ethers;
  try {
    ({ ethers } = await import("ethers"));
  } catch {
    log.info("slash: ethers not installed; DRY-RUN only (add `ethers` to package.json)");
    return async (commitment) => log.info("SLASH (dry-run, no ethers)", { commitment: String(commitment).slice(0, 18) + ".." });
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(key, provider);
  const contract = new ethers.Contract(address, ["function slash(uint256 commitment, uint256 secret, address receiver)"], wallet);
  const rcv = receiver || wallet.address;
  log.info("slash: on-chain", { via: address, receiver: rcv });
  return async (commitment, secret) => {
    const tx = await contract.slash(commitment, secret, rcv);
    // "SLASH tx <hash>" substring preserved for scripts/integration-sepolia.mjs's regex.
    log.info(`SLASH tx ${tx.hash} (waiting)`, { commitment: String(commitment).slice(0, 18) + ".." });
    const rcpt = await tx.wait();
    // "SLASH mined block <n>" substring preserved for scripts/integration-sepolia.mjs's regex.
    log.info(`SLASH mined block ${rcpt.blockNumber}`, { commitment: String(commitment).slice(0, 18) + ".." });
  };
}

// ---- wire protocol ----------------------------------------------------------

// ---- protocol version negotiation (T-FEAT-11) -------------------------------
// The wire envelope is v3-with-nonce today. To let the format evolve to v4+ without a flag
// day, the gateway declares the INCLUSIVE range of envelope versions it can parse, checks the
// incoming envelope's `v` against it BEFORE any field is read, and — on a mismatch — advertises
// its range back to the client so the client can re-select (or fail closed with a precise error).
//
// PROTO_MIN/PROTO_MAX are the SINGLE source of truth for the gateway's supported range. Bump
// PROTO_MAX (and add a v4 parser) to ship a new format; raise PROTO_MIN only to DROP an old one.
// Today both are 3, so the range is exactly {3}. Directory/announce advertisement of this range
// is a deliberate FOLLOW-UP (T-FEAT-10 capability advertisement) — this task keeps negotiation to
// the client<->gateway handshake and does not touch bootnode/announce or lib/directory.
export const PROTO_MIN = 3;
export const PROTO_MAX = 3;
export const PROTO_RANGE = { min: PROTO_MIN, max: PROTO_MAX };

// An envelope with NO `v` is the pre-negotiation v3 wire (older clients / the shim before this
// change). Backward-compat rule: absent version == v3, then checked against the range like any
// other. So a legacy client keeps working while the range includes 3, and is cleanly rejected
// (unsupported-version:3) once a future gateway raises PROTO_MIN past 3 — never a silent mis-parse.
const LEGACY_ENVELOPE_VERSION = 3;

// Decide whether we can parse an envelope of version `v`, WITHOUT reading any other field. Pure +
// exported so the selftest drives every branch directly. Returns:
//   { ok:true,  version }                              — in range; hand off to verifyEnvelope
//   { ok:false, reason:"bad-version:<repr>", proto }   — not an integer (garbage / string / float)
//   { ok:false, reason:"unsupported-version:<v>", proto } — a well-formed integer out of range
// `proto` (our advertised range) rides on BOTH rejections so the client learns what we speak.
// `reason` carries the specific value for logs/replies; `label` is a bounded coarse key for metrics.
export function acceptEnvelopeVersion(v, range = PROTO_RANGE) {
  const { min, max } = range;
  const ver = v === undefined || v === null ? LEGACY_ENVELOPE_VERSION : v;
  if (typeof ver !== "number" || !Number.isInteger(ver)) {
    // Reject BEFORE any mis-parse. A string "3", a float, NaN, or an object never reaches
    // verifyEnvelope (which does not inspect `v` at all — this gate is the sole version authority).
    return { ok: false, reason: `bad-version:${versionRepr(v)}`, label: "bad-version", proto: range };
  }
  if (ver < min || ver > max) {
    return { ok: false, reason: `unsupported-version:${ver}`, label: "unsupported-version", proto: range };
  }
  return { ok: true, version: ver, proto: range };
}

// A short, safe repr of an out-of-range/garbage version for the reason string (never dumps a
// large or nested value into a log line or wire reply).
function versionRepr(v) {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v.slice(0, 16));
  return typeof v;
}

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

// ---- configurable egress target policy (T-DEV-10) ---------------------------
// A pure, unit-testable policy layer over `host:port` egress targets. Semantics:
// default-DENY — a target must match an ALLOW pattern AND no DENY pattern. Deny is
// evaluated first, so deny wins. Patterns are `host:port` where:
//   host: `*` (any host) | `*.suffix` (subdomains of suffix, NOT the bare apex) | exact
//   port: `*` (any port) | an exact number in 1..65535
// Multiple patterns are comma-separated. Malformed patterns are dropped safely (a
// garbage entry never widens or breaks the policy).
//
// Default allow = `*:443` with empty deny === EXACTLY the old :443-only rule, so with
// no env set nothing changes: the gateway stays a metadata-only TLS tunnel and never
// sees plaintext.
//
// SECURITY: widening the allow list to non-TLS ports (e.g. `*:80`, `*:8080`) lets the
// gateway observe PLAINTEXT for those connections — it is then NO LONGER a metadata-only
// tunnel but a forward proxy that can read the bytes it carries, an operator opt-in with
// real privacy implications. Keep the default (443-only) unless you accept that trade.
export function makeEgressPolicy({ allow = "*:443", deny = "" } = {}) {
  const parseList = (spec) =>
    String(spec ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(parseEgressPattern)
      .filter(Boolean); // drop malformed patterns safely
  const allows = parseList(allow);
  const denies = parseList(deny);
  return function isAllowed(host, port) {
    if (typeof host !== "string" || host.length === 0) return false;
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return false;
    // Canonicalize the host before matching. A trailing dot is a FQDN that DNS resolves to the
    // exact same server (so `sub.evil.com.` must be treated as `sub.evil.com`, or an appended dot
    // would evade a host-specific deny), and empty labels (leading/double dot) are invalid hosts.
    // Without this, a gated member could bypass an operator's deny list by appending one dot.
    const h = host.toLowerCase().replace(/\.$/, "");
    if (h.length === 0 || h.startsWith(".") || h.includes("..")) return false; // invalid labels -> drop
    if (denies.some((pat) => matchEgressPattern(pat, h, p))) return false; // deny wins
    return allows.some((pat) => matchEgressPattern(pat, h, p)); // else default-DENY
  };
}

// Parse one `host:port` pattern into { host, port } (port kept as "*" or a number),
// or null when malformed so the caller can drop it. Split on the LAST colon so hosts
// (which never contain ':' in a valid target) are unambiguous.
function parseEgressPattern(spec) {
  const i = spec.lastIndexOf(":");
  if (i <= 0 || i === spec.length - 1) return null; // need non-empty host and port
  const host = spec.slice(0, i).toLowerCase();
  const portStr = spec.slice(i + 1);
  if (portStr === "*") return { host, port: "*" };
  if (!/^\d{1,5}$/.test(portStr)) return null;
  const port = Number(portStr);
  if (port < 1 || port > 65535) return null;
  return { host, port };
}

function matchEgressPattern(pat, host, port) {
  if (pat.port !== "*" && pat.port !== port) return false;
  if (pat.host === "*") return true;
  if (pat.host.startsWith("*.")) return host.endsWith(pat.host.slice(1)); // ".suffix"
  return pat.host === host;
}

// Built once from env at import (unset => default `*:443`, empty deny => today's rule).
const egressPolicy = makeEgressPolicy({
  allow: process.env.RGOE_EGRESS_ALLOW,
  deny: process.env.RGOE_EGRESS_DENY,
});

// Returns { ok:true, host, port } for an admitted target, else { ok:false, reason }.
// reason distinguishes a malformed target ("bad-target") from one the policy refuses
// ("bad-target-policy") so the drop metric and error reply are precise.
function validTarget(target) {
  if (typeof target !== "string") return { ok: false, reason: "bad-target" };
  const m = target.match(/^([a-zA-Z0-9.\-]+):(\d{1,5})$/);
  if (!m) return { ok: false, reason: "bad-target" };
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return { ok: false, reason: "bad-target" };
  if (!egressPolicy(m[1], port)) return { ok: false, reason: "bad-target-policy" };
  return { ok: true, host: m[1], port };
}

// ---- egress self-check (T-FEAT-16) ------------------------------------------
// A METADATA-ONLY liveness probe of THIS host's clearnet egress, used by the heartbeat
// (bootnode/heartbeat.mjs) to keep a broken gateway out of the fleet. Problem: a gateway
// whose clearnet egress is dead (bad routing, firewall, dead upstream) still ANNOUNCES to
// the bootnode and then DROPs every member routed to it. This probe lets it self-eject:
// the heartbeat runs it before each announce and SKIPS announcing when egress is DOWN, so a
// dead gateway ages out of the bootnode /directory via its TTL while a healthy one keeps
// announcing.
//
// It opens a PLAIN TCP connection to a well-known :443 host and closes it the instant it
// connects. It writes NO bytes, carries NO member traffic, and reads NO data — a pure
// connect()/close liveness check, exactly as metadata-only as the :443 tunnel it guards.
// It touches nothing else: request handling, metrics, the spent-set/replay cache, policy,
// and shutdown are all untouched (this is off the hot path and never runs per-request).
//
// Default target 1.1.1.1:443 (Cloudflare — an always-up anycast host reachable from anywhere
// with working egress). Override with RGOE_EGRESS_CHECK_TARGET (host:port). Timeout is short
// (RGOE_EGRESS_CHECK_TIMEOUT_MS, default 5000ms) so a beat is never blocked for long. The
// connector is injected so the selftest drives it with a fake — no real network in the test.
export const EGRESS_CHECK_TARGET = process.env.RGOE_EGRESS_CHECK_TARGET || "1.1.1.1:443";

export function checkEgress({
  target = EGRESS_CHECK_TARGET,
  timeoutMs = Number(process.env.RGOE_EGRESS_CHECK_TIMEOUT_MS) || 5000,
  connect = net.connect,
} = {}) {
  return new Promise((resolve) => {
    const s = String(target);
    const i = s.lastIndexOf(":");
    const host = i > 0 ? s.slice(0, i) : s;
    const port = i > 0 ? Number(s.slice(i + 1)) : 443;
    const label = `${host}:${port}`;
    let done = false;
    let socket = null;
    const finish = (healthy, reason) => {
      if (done) return;
      done = true;
      try { clearTimeout(timer); } catch {}
      try { socket && socket.destroy(); } catch {} // close immediately — no bytes ever sent/read
      resolve({ healthy, target: label, reason });
    };
    const timer = setTimeout(() => finish(false, "timeout"), timeoutMs);
    try {
      socket = connect(port, host, () => finish(true, "connected"));
    } catch (e) {
      return finish(false, "connect-threw:" + (e && e.message || e));
    }
    socket?.on?.("error", (e) => finish(false, "connect-error:" + ((e && e.code) || (e && e.message) || e)));
  });
}

// ---- signed egress success receipts (T-FEAT-13) -----------------------------
// OPTIONAL and ADDITIVE. When enabled, a SUCCESSFUL egress reply carries an extra `receipt`
// field: a small object signed by THIS gateway's onion-control key attesting "I (this onion)
// served a request at epoch E" (lib/receipt.mjs). A client holding the gateway's directory
// pubkey verifies it and accumulates it as gateway liveness/quality evidence (feeds T-FEAT-4).
//
// PRIVACY: the receipt carries NO member identity, NO nullifier (not even a prefix), NO share,
// NO target, NO request nonce, NO fine timestamp/counter — only { v, onion, coarse-epoch, ok }.
// So it can be verified by anyone yet links to neither the member nor the target. See the field
// table in lib/receipt.mjs and docs/RECEIPTS.md.
//
// DEFAULT OFF. With RGOE_RECEIPTS unset the success reply is EXACTLY `{ ok: true }` — byte-for-
// byte today's path. The receipt signer + identity load happen ONLY when enabled, so an env
// without an onion identity file is never affected. `makeReceipt` is injected into makeHandler
// so the selftest drives it without a real onion or process.
export function receiptsEnabled() {
  return String(process.env.RGOE_RECEIPTS ?? "0") === "1";
}

// The connect-success reply. With no receipt signer this returns the ORIGINAL `{ ok: true }`
// object unchanged (proved byte-identical in gateway/receipt.selftest.mjs); with one it adds a
// freshly signed `receipt`. Signing failure never breaks egress — the ack degrades to `{ ok:
// true }` (the tunnel still opens; receipts are best-effort evidence, never a gate).
export function successAck(makeReceipt) {
  if (!makeReceipt) return { ok: true };
  try {
    const receipt = makeReceipt();
    return receipt ? { ok: true, receipt } : { ok: true };
  } catch {
    return { ok: true };
  }
}

// Load the gateway's onion identity ({ onion, seed }) — the SAME file the heartbeat announces
// with (RGOE_GW_IDENTITY, default tor/hs/identity.local.json). Only called when receipts are on.
async function loadReceiptIdentity() {
  const path = process.env.RGOE_GW_IDENTITY || join(HERE, "..", "tor", "hs", "identity.local.json");
  const id = JSON.parse(await readFile(path, "utf8"));
  if (!id.onion || !id.seed) throw new Error(`identity file ${path} missing onion/seed (run bootnode/keygen.mjs)`);
  return id;
}

// Build the `makeReceipt` closure for main(): signs { onion, currentEpoch(), ok:true } with the
// onion seed on each call. Returns null when receipts are disabled OR the identity can't load
// (fail-open: a missing identity disables receipts, it never blocks egress).
async function makeReceiptSigner() {
  if (!receiptsEnabled()) return null;
  let id;
  try {
    id = await loadReceiptIdentity();
  } catch (e) {
    log.warn("receipts requested (RGOE_RECEIPTS=1) but identity unavailable; receipts DISABLED", { err: e.message });
    return null;
  }
  log.info("egress receipts: ON — signing success receipts with onion-control key", { onion: id.onion.slice(0, 16) + "..onion" });
  return () => buildReceipt({ onion: id.onion, epoch: currentEpoch(), onionSeedHex: id.seed });
}

// Exported for gateway/*.selftest.mjs + lib/zk-artifacts.selftest.mjs (driven with a fake
// socket, no listener); main() below is the only caller that binds a port.
export function makeHandler(spentSet, { makeReceipt = null } = {}) {
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
      // Step 0: protocol version gate (T-FEAT-11). Run FIRST, before any field is trusted, so an
      // out-of-range/garbage `v` is rejected with a precise reason (and our advertised range) rather
      // than being fed to a parser expecting a different shape. This never bypasses target binding:
      // an accepted version still flows through verifyEnvelope's checks below unchanged.
      const vv = acceptEnvelopeVersion(env.v);
      if (!vv.ok) {
        log.warn("drop", { reason: vv.reason, target: env.target });
        M.requests.inc({ result: "drop", reason: vv.label });
        reply(socket, { ok: false, err: vv.reason, proto: vv.proto });
        return socket.destroy();
      }

      // Steps 1-3, cheap-first, inside the lib: fresh externalNullifier -> share.x binding
      // -> root ∈ recent-roots -> RLN Groth16 verify. Returns the authoritative
      // nullifier/externalNullifier/share (read from the proof's public signals) to act on.
      const t0 = performance.now();
      const v = await verifyEnvelope(env, recentRoots);
      M.verify.observe((performance.now() - t0) / 1000);
      if (!v.ok) {
        log.warn("drop", { reason: v.reason, target: env.target });
        // Metrics use the bounded `label` when the lib supplies one (the T-HARD-8 artifact
        // rejections carry the offending id in `reason`; the label is the coarse key), else the
        // reason itself as before.
        M.requests.inc({ result: "drop", reason: v.label ?? v.reason });
        // An artifact rejection advertises the accepted ids back (like `proto` on a version
        // reject) so the client can re-select a mutual artifact set or fail closed precisely.
        reply(socket, v.artifacts ? { ok: false, err: "gate:" + v.reason, artifacts: v.artifacts } : { ok: false, err: "gate:" + v.reason });
        return socket.destroy();
      }

      const tgt = validTarget(env.target);
      if (!tgt.ok) {
        M.requests.inc({ result: "drop", reason: tgt.reason });
        reply(socket, { ok: false, err: tgt.reason });
        return socket.destroy();
      }

      // Step 4: nullifier dedup + share collection; slashes on 2nd distinct signal.
      // Pass the envelope nonce so the seen-envelope cache (T-FEAT-12) can reject an
      // exact-envelope replay outside the honest-retry window as "replayed-envelope", and the
      // proof's externalNullifier as the per-epoch scope key for the shared fleet tally
      // (T-FEAT-20). externalNullifier is the fleet-agreed per-epoch value, so both gateways
      // key the same nullifier into the same epoch bucket.
      const res = await spentSet.admit(v.nullifier, v.share, { nonce: env.nonce, epoch: v.externalNullifier });
      if (!res.ok) {
        log.warn("drop", { reason: res.reason, nullifier: String(v.nullifier).slice(0, 10) + ".." });
        M.requests.inc({ result: "drop", reason: res.reason });
        reply(socket, { ok: false, err: res.reason });
        return socket.destroy();
      }

      // Step 5: egress :443 tunnel (unchanged; TLS stays end-to-end).
      const upstream = net.connect(tgt.port, tgt.host, () => {
        log.info("egress", { target: `${tgt.host}:${tgt.port}`, nullifier: String(v.nullifier).slice(0, 10) + "..", externalNullifier: String(v.externalNullifier).slice(0, 10) + ".." });
        M.requests.inc({ result: "pass" });
        // Success ack. Default (no signer) => exactly `{ ok: true }` (byte-identical to the
        // pre-receipt path); with a signer => `{ ok: true, receipt }` (T-FEAT-13).
        reply(socket, successAck(makeReceipt));
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
      log.error("gateway-error", { err: e.message, target: env.target });
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

// ---- ZK artifact set (T-HARD-8 dual-VK rollout window) ----------------------
// Load the accepted {artifactId -> vkey} set at startup so a mis-configured window
// (RGOE_ZK_ARTIFACTS pointing an id at the wrong file, a missing vkey, ...) is a loud startup
// error, never a silently-wrong accepted set. verifyEnvelope reads the same process-wide set.
function initArtifacts() {
  const set = getArtifactSet(); // throws with a precise message on a bad config
  log.info("zk artifacts", {
    accepted: set.ids,
    legacy: set.legacyId,
    legacyStatus: set.legacyAccepted ? "accepted (window open: field-less envelopes verify under it)" : "RETIRED (field-less / explicit-legacy envelopes => artifact-retired)",
    source: set.explicit ? "RGOE_ZK_ARTIFACTS" : "built-in circuits/rln/verification_key.json",
  });
  return set;
}

async function main() {
  initArtifacts();
  await initRoots();
  const slash = await makeSlasher();
  // Optional cross-fleet shared spent-nullifier tally (T-FEAT-20). null unless a real
  // cross-host transport is wired — which this run does NOT bundle (follow-up), so this is
  // null by default and makeSpentSet({ sharedTally:null }) is byte-identical to T-FEAT-12.
  const sharedTally = makeConfiguredFleetTally();
  const spentSet = makeSpentSet({ slash, sharedTally });
  setInterval(() => spentSet.sweep(), EPOCH_SECONDS * 1000).unref();

  // Optional signed success receipts (T-FEAT-13); null unless RGOE_RECEIPTS=1.
  const makeReceipt = await makeReceiptSigner();

  const server = net.createServer(makeHandler(spentSet, { makeReceipt }));

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
    metricsServer.listen(metricsPort, metricsHost, () => log.info("metrics endpoint up", { url: `http://${metricsHost}:${metricsPort}/metrics`, scope: "loopback" }));
  }

  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    // "gateway up on <host>:<port>" substring preserved for scripts/integration-sepolia.mjs.
    log.info(`gateway up on ${LISTEN_HOST}:${LISTEN_PORT}`, { epoch: currentEpoch(), epochSeconds: EPOCH_SECONDS });
    const allowDesc = process.env.RGOE_EGRESS_ALLOW || "*:443";
    const denyDesc = process.env.RGOE_EGRESS_DENY || "";
    const dflt = allowDesc === "*:443" && !denyDesc;
    log.info(`egress policy: allow=[${allowDesc}] deny=[${denyDesc}]${dflt ? " (:443 only, metadata-only TLS tunnel)" : " (WIDENED — gateway may see plaintext; NOT metadata-only)"}`);
    log.info("rate: RLN degree-1 per nullifier; 2nd distinct signal on a nullifier => reconstruct + slash");
    const replayWindowMs = Number(process.env.RGOE_REPLAY_WINDOW_MS) || 5000;
    log.info(`replay defense: per-gateway seen-envelope cache; exact replay >${replayWindowMs}ms => reject replayed-envelope (honest retry within window still idempotent)`);
    if (sharedTally) log.info("fleet tally: ON — sharing per-epoch spent nullifiers across the fleet (nullifier+epoch only; fail-open)");
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
