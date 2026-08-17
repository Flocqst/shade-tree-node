// Gateway heartbeat: keep this gateway listed on the bootnode.
//
// A bootnode entry is soft-state with a TTL (bootnode/server.mjs): the gateway must re-announce
// periodically or it drops from the fleet. That is deliberate — liveness is proven by continuing
// to announce, so a dead gateway ages out without anyone deregistering it. This loop builds a
// fresh signed announce (fresh ts + nonce) from the gateway's onion identity and POSTs it to the
// bootnode onion over Tor, every RGOE_BOOTNODE_HEARTBEAT seconds.
//
// Config:
//   RGOE_BOOTNODE_ONION     the bootnode to announce to (required)
//   RGOE_GW_IDENTITY        path to the onion identity.local.json { onion, seed }
//                           (bootnode/keygen.mjs; default tor/hs/identity.local.json)
//   RGOE_GW_WEIGHT          selection weight advertised                    (default 100)
//   RGOE_BOOTNODE_HEARTBEAT re-announce interval in seconds                (default 300)
//   RGOE_TOR_HOST/PORT      local Tor SOCKS                                (default 127.0.0.1:9250)
//   capability advertisement (optional, T-FEAT-10b — OFF/byte-identical when both unset):
//   RGOE_EGRESS_ALLOW       the gateway's egress policy (also read by gateway/gateway.mjs);
//                           when SET, its concrete allowed ports are advertised as signed caps
//   RGOE_GATEWAY_REGION     a coarse self-declared region bucket (REGION_BUCKETS; e.g. `eu`)
//   stake (optional, admission=stake bootnodes):
//   RGOE_GW_OPERATOR_KEY    operator EOA private key; signs the durable onion<->operator auth, OR
//   RGOE_GW_OPERATOR +      a pre-computed operator address and
//   RGOE_GW_OPERATOR_SIG    its signature over operatorAuthMessage(onion, operator)
//                           (the pair takes precedence over the key; any misconfiguration —
//                           half a pair, malformed key, sig that does not recover the
//                           operator — fails at startup; see resolveOperator)
//
// Selftest: bootnode/heartbeat.selftest.mjs (operator resolution, announce bytes vs
// testdata/vectors.json, failure paths, log hygiene) + bootnode/heartbeat-caps.selftest.mjs.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildAnnounce, operatorAuthMessage, verifyOperatorSig } from "./announce.mjs";
import { postOverTor } from "./fetch.mjs";
import { checkEgress, EGRESS_CHECK_TARGET, PROTO_RANGE } from "../gateway/gateway.mjs";
import { REGION_BUCKETS } from "../lib/directory.mjs";
import { isPrivHex, isEthAddress } from "../lib/config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Every piece of the CLI path below takes its env + I/O as injectable arguments (defaulting to
// process.env / real fs / real ethers / real Tor) so bootnode/heartbeat.selftest.mjs can drive
// each source/precedence path and each failure path with fakes — no Tor, no network, no chain.
// With the defaults, behaviour is byte-identical to the pre-refactor CLI.

export async function loadIdentity(env = process.env, { readFile: readFileFn = readFile } = {}) {
  const path = env.RGOE_GW_IDENTITY || join(HERE, "..", "tor", "hs", "identity.local.json");
  const id = JSON.parse(await readFileFn(path, "utf8"));
  if (!id || typeof id !== "object" || !id.onion || !id.seed) throw new Error(`identity file ${path} missing onion/seed (run bootnode/keygen.mjs)`);
  return id;
}

// Resolve the optional operator-stake authorization once (it is durable across heartbeats).
// Precedence: a pre-computed (RGOE_GW_OPERATOR + RGOE_GW_OPERATOR_SIG) pair wins over
// RGOE_GW_OPERATOR_KEY; neither -> onion-only. Every misconfiguration FAILS FAST here (at
// startup) instead of surfacing as `announce rejected: bad-operator-sig` on every beat:
//   - a half-configured pair (operator without sig, or sig without operator) is an error, not a
//     silent downgrade to onion-only;
//   - a pre-computed sig is verified locally against the operator address before it is ever
//     sent (verifyOperatorSig — the same check the bootnode runs);
//   - a malformed RGOE_GW_OPERATOR_KEY is rejected by shape BEFORE it reaches ethers, whose
//     INVALID_ARGUMENT error would otherwise echo the mistyped key bytes into the message that
//     main() prints (log hygiene: the key value must never reach a log sink, mistyped or not).
export async function resolveOperator(onion, env = process.env, { importEthers = () => import("ethers") } = {}) {
  const operator = env.RGOE_GW_OPERATOR, operatorSig = env.RGOE_GW_OPERATOR_SIG, key = env.RGOE_GW_OPERATOR_KEY;
  if (operator && operatorSig) {
    if (!isEthAddress(operator)) throw new Error("RGOE_GW_OPERATOR is not a 0x-prefixed 20-byte address");
    if (!/^0x[0-9a-fA-F]{130}$/.test(String(operatorSig).trim())) throw new Error("RGOE_GW_OPERATOR_SIG is not a 65-byte 0x-hex personal_sign signature");
    if (!(await verifyOperatorSig(onion, operator, operatorSig))) {
      throw new Error(`RGOE_GW_OPERATOR_SIG does not recover RGOE_GW_OPERATOR for onion ${onion} (re-sign operatorAuthMessage with the operator key)`);
    }
    return { operator, operatorSig };
  }
  if (key) {
    if (!isPrivHex(key)) throw new Error("RGOE_GW_OPERATOR_KEY is not a 32-byte hex private key (64 hex, 0x optional)");
    const { ethers } = await importEthers();
    let w;
    try { w = new ethers.Wallet(key.trim()); } catch { throw new Error("RGOE_GW_OPERATOR_KEY is not a valid secp256k1 private key"); }
    return { operator: w.address, operatorSig: await w.signMessage(operatorAuthMessage(onion, w.address)) };
  }
  if (operator || operatorSig) {
    throw new Error("RGOE_GW_OPERATOR and RGOE_GW_OPERATOR_SIG must be set together (or set RGOE_GW_OPERATOR_KEY instead)");
  }
  return { operator: null, operatorSig: null };
}

// ---- capability advertisement (T-FEAT-10b) ----------------------------------
// T-FEAT-10 added build/verify/select SUPPORT for signed caps; this WIRES the producer so a
// gateway advertises its REAL config instead of "any gateway". Caps are derived from what the
// gateway actually runs:
//   - ports : the coarse ALLOWED egress port set, taken from the gateway's egress policy
//             (RGOE_EGRESS_ALLOW / gateway.mjs makeEgressPolicy). `*:443` -> [443]; a wildcard
//             `*` port is NOT enumerable coarsely, so it is dropped (never advertise "any port").
//   - region: a coarse, self-declared continent bucket (RGOE_GATEWAY_REGION, validated against
//             REGION_BUCKETS). Omitted when unset/invalid. Deliberately too coarse to fingerprint.
//   - proto : the envelope version range the gateway actually speaks (gateway.mjs PROTO_RANGE,
//             the version-negotiation source of truth) — carried through, never hardcoded here.
//
// OPT-IN + OMIT-WHEN-UNCONFIGURED: with NEITHER a configured egress policy NOR a region,
// buildGatewayCaps returns null, buildAnnounce attaches nothing, and the announce is
// BYTE-IDENTICAL to a pre-T-FEAT-10 announce. proto rides along ONLY when caps are otherwise
// non-empty, so it can never on its own force a non-identical announce.

// Coarse allowed-port set from an RGOE_EGRESS_ALLOW spec (comma-separated `host:port` patterns,
// same grammar as gateway.mjs makeEgressPolicy). Keeps only CONCRETE numeric ports — a wildcard
// `*` port or garbage is dropped — then dedupes + sorts. Returns [] when nothing concrete remains.
export function advertisedPorts(allowSpec) {
  const out = new Set();
  for (const raw of String(allowSpec ?? "").split(",")) {
    const spec = raw.trim();
    if (!spec) continue;
    const i = spec.lastIndexOf(":"); // split on LAST colon, mirroring parseEgressPattern
    if (i <= 0 || i === spec.length - 1) continue;
    const portStr = spec.slice(i + 1);
    if (!/^\d{1,5}$/.test(portStr)) continue; // "*" or junk -> not a concrete port
    const port = Number(portStr);
    if (port >= 1 && port <= 65535) out.add(port);
  }
  return [...out].sort((a, b) => a - b);
}

// Build the raw caps object from env (injectable for tests; defaults to process.env). Returns
// null when the gateway is UNCONFIGURED (no explicit egress policy, no valid region) so the
// announce stays byte-identical to today. buildAnnounce canonicalizes + signs whatever we return.
export function buildGatewayCaps(env = process.env) {
  const caps = {};
  // ports: advertised ONLY when the operator explicitly set an egress policy (env present). An
  // UNSET policy is the implicit :443 floor every gateway already meets (DEFAULT_EGRESS_PORT), so
  // advertising it would attach caps to an otherwise-default gateway — keep the default cap-free.
  if (env.RGOE_EGRESS_ALLOW !== undefined) {
    const ports = advertisedPorts(env.RGOE_EGRESS_ALLOW);
    if (ports.length) caps.ports = ports;
  }
  // region: opt-in coarse bucket, validated against the shared allowlist.
  if (typeof env.RGOE_GATEWAY_REGION === "string" && REGION_BUCKETS.has(env.RGOE_GATEWAY_REGION)) {
    caps.region = env.RGOE_GATEWAY_REGION;
  }
  // Nothing configured -> no caps -> byte-identical announce (proven in the selftest).
  if (caps.ports === undefined && caps.region === undefined) return null;
  // At least one real cap: advertise the proto range too (complete, and safe — it only ever
  // rides alongside already-present caps, never triggers caps on its own).
  caps.proto = { min: PROTO_RANGE.min, max: PROTO_RANGE.max };
  return caps;
}

// One announce: build a fresh signed record (fresh ts + nonce) and POST it to the bootnode over
// Tor. `post` is injectable (defaults to the real Tor transport) so the selftest can capture the
// exact record + path/opts that would go on the wire without a Tor daemon.
export async function announceOnce({ id, bootnode, op, weight, torHost, torPort, caps = buildGatewayCaps(), post = postOverTor }) {
  const rec = buildAnnounce({ onion: id.onion, weight, onionSeedHex: id.seed, operator: op.operator, operatorSig: op.operatorSig, caps });
  return post(bootnode, "/announce", rec, { torHost, torPort });
}

// ---- egress-gated announce (T-FEAT-16) --------------------------------------
// Before EACH announce, probe this host's clearnet egress (a metadata-only TCP connect to a
// well-known :443 host — see checkEgress in gateway/gateway.mjs). If egress is DOWN, SKIP the
// announce: a broken gateway then ages out of the bootnode /directory via its TTL instead of
// staying listed and DROPping every member routed to it. When egress recovers, the next beat
// finds it healthy and announcing resumes — no state to reset. The probe runs once per beat
// (throttling is unnecessary at heartbeat cadence, default 300s).
//
// Off-switch: RGOE_EGRESS_CHECK=0 disables the check and announces UNCONDITIONALLY (today's
// behavior), so a fresh/offline env (no working egress yet, or a test box) is never blocked.
//
// Factored out and fully injectable (announce + egress + enabled) so the selftest asserts the
// gating with a fake checkEgress and a fake announce — no Tor, no real network.
export function egressCheckEnabled(env = process.env) {
  return String(env.RGOE_EGRESS_CHECK ?? "1") !== "0";
}

export async function announceIfHealthy({ announce, egress, enabled = egressCheckEnabled(), log = console.log }) {
  if (!enabled) return announce(); // check disabled: announce unconditionally (current behavior)
  const r = await egress();
  if (!r.healthy) {
    log(`egress DOWN (${r.target} ${r.reason}); SKIP announce — gateway ages out of the bootnode via TTL`);
    return { skipped: true, egress: r };
  }
  return announce();
}

// The runtime knobs main() reads. Throws (fail fast) when the bootnode is unset.
export function heartbeatConfig(env = process.env) {
  const bootnode = env.RGOE_BOOTNODE_ONION;
  if (!bootnode) throw new Error("set RGOE_BOOTNODE_ONION (the bootnode to announce to)");
  return {
    bootnode,
    intervalSec: Number(env.RGOE_BOOTNODE_HEARTBEAT || 300),
    weight: Number(env.RGOE_GW_WEIGHT || 100),
    torHost: env.RGOE_TOR_HOST || "127.0.0.1",
    torPort: Number(env.RGOE_TOR_PORT || 9250),
  };
}

// One heartbeat tick: egress-gate, announce, log the outcome. NEVER throws — a failed or
// rejected announce is logged and retried on the next interval (the bootnode's TTL is the only
// state, so there is nothing to back off or reset). Returns the outcome for tests:
//   { skipped: true }               egress DOWN, announce skipped
//   { ok: true, ...bootnode reply }  accepted
//   { ok: false, err }               rejected by the bootnode (or a malformed reply)
//   { failed: true, err }            transport failure (unreachable bootnode, bad HTTP, bad JSON)
// The bootnode reply is treated as UNTRUSTED input: anything that is not a plain object is a
// rejection ("malformed response"), never a TypeError out of the tick.
export function makeBeat({ announce, egress, enabled = egressCheckEnabled(), log = console.log }) {
  return async () => {
    try {
      const r = await announceIfHealthy({ announce, egress, enabled, log });
      if (r && r.skipped) return r; // egress DOWN: announce already logged + skipped
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        log("announce rejected: malformed response from bootnode (will retry next interval)");
        return { ok: false, err: "malformed response" };
      }
      log(r.ok === true ? `announced (staked=${r.staked ?? false}, ttl=${r.ttl}s)` : `announce rejected: ${r.err}`);
      return r.ok === true ? r : { ok: false, err: r.err };
    } catch (e) {
      log(`announce failed: ${e.message} (will retry next interval)`);
      return { failed: true, err: e.message };
    }
  };
}

// The long-running heartbeat. `deps` are all optional (defaults = the real CLI); tests inject
// fakes for env, identity/operator resolution, announce transport, egress probe, scheduler, log.
export async function runHeartbeat({
  env = process.env,
  log = console.log,
  schedule = setInterval,
  announce = announceOnce,
  egress = checkEgress,
  identity = null,       // pre-resolved { onion, seed } (else loadIdentity(env))
  operator = null,       // pre-resolved { operator, operatorSig } (else resolveOperator(onion, env))
} = {}) {
  const { bootnode, intervalSec, weight, torHost, torPort } = heartbeatConfig(env);
  const id = identity ?? await loadIdentity(env);
  const op = operator ?? await resolveOperator(id.onion, env);
  log(`heartbeat: ${id.onion.slice(0, 16)}..onion -> ${bootnode.slice(0, 16)}..onion every ${intervalSec}s${op.operator ? ` (operator ${op.operator.slice(0, 10)}..)` : " (onion-only)"}`);
  const enabled = egressCheckEnabled(env);
  log(enabled
    ? `egress self-check: ON (metadata-only TCP connect to ${EGRESS_CHECK_TARGET} before each announce; SKIP announce if DOWN). Disable with RGOE_EGRESS_CHECK=0`
    : "egress self-check: OFF (RGOE_EGRESS_CHECK=0) — announcing unconditionally");
  const caps = buildGatewayCaps(env);
  log(caps
    ? `capabilities advertised (signed): ${JSON.stringify(caps)}`
    : "capabilities: none (unconfigured — announce is byte-identical to a legacy gateway; set RGOE_EGRESS_ALLOW and/or RGOE_GATEWAY_REGION to advertise)");

  const beat = makeBeat({
    announce: () => announce({ id, bootnode, op, weight, torHost, torPort, caps }),
    egress: () => egress(),
    enabled,
    log,
  });
  const first = await beat();
  const timer = schedule(beat, intervalSec * 1000);
  return { beat, first, timer, id: { onion: id.onion }, op: { operator: op.operator }, caps };
}

async function main() {
  try {
    heartbeatConfig();
  } catch (e) {
    console.error(e.message); process.exit(1);
  }
  await runHeartbeat();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
