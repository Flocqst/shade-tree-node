// External uptime prober (T-MON-4): check fleet health from OUTSIDE, over Tor.
//
// An external monitor (cron, or an uptime service with a tor-capable runner) runs this
// standalone, dependency-light check on an interval. It reaches the bootnode the SAME way a
// client does -- a SOCKS dial through the local Tor daemon (bootnode/fetch.mjs), no exit node,
// the bootnode never learns the monitor's IP -- fetches GET /health and GET /directory, and
// verifies the directory signature against the PINNED signer (lib/directory.mjs verifyDirectory).
// So the check proves the fleet is not just reachable but serving an authentic, signer-pinned
// directory: a swapped/MITM'd bootnode fails signerOk, not just reachability.
//
//   node scripts/uptime-probe.mjs                 -> one-line JSON, exit 0 healthy / nonzero not
//   node scripts/uptime-probe.mjs --format nagios -> "OK|CRITICAL: ..." line, exit 0 / 2
//
// Config (all SHADE_TREE_*):
//   SHADE_TREE_BOOTNODE_ONION   the bootnode v3 .onion  (production: fetched over Tor)
//   SHADE_TREE_TOR_HOST/PORT    local Tor SOCKS proxy   (default 127.0.0.1:9250)
//   SHADE_TREE_BOOTNODE_URL     plain http base, e.g. http://127.0.0.1:8877  (DEV ONLY; bypasses Tor)
//   SHADE_TREE_DIR_SIGNER       pinned directory-signer pubkey (hex) -- REQUIRED
//   SHADE_TREE_DIR_MAX_AGE_SEC  oldest accepted signed-directory issue time (default 300)
//   SHADE_TREE_DIR_FUTURE_SEC   accepted future clock skew for issue time (default 300)
//   SHADE_TREE_NETWORK          <name>: default BOOTNODE_ONION + DIR_SIGNER from network/<name>/bootnode.json
//                         (explicit env wins; a pending record supplies nothing -> misconfig)
//   SHADE_TREE_PROBE_TIMEOUT_MS per-request timeout     (default 20000)
//
// PRIVACY: machine-readable output can include a COUNT for private monitoring, but the hosted
// workflow uses the count-free Nagios line. Neither mode prints gateway identities, and errors
// scrub any .onion. Fail-closed: any error reports UNHEALTHY and never hangs.

import http from "node:http";
import { fetchOverTor } from "../bootnode/fetch.mjs";
import { verifyDirectory } from "../lib/directory.mjs";
import { applyNetworkEnv } from "../lib/network-record.mjs";

const TOR_HOST = process.env.SHADE_TREE_TOR_HOST || "127.0.0.1";
const TOR_PORT = Number(process.env.SHADE_TREE_TOR_PORT || 9250);
const TIMEOUT_MS = Number(process.env.SHADE_TREE_PROBE_TIMEOUT_MS || 20000);
const MAX_RESP = Number(process.env.SHADE_TREE_BOOTNODE_MAX_RESP || 2 * 1024 * 1024);
const boundedSeconds = (value, fallback) => {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 3600 ? parsed : fallback;
};
const DIR_MAX_AGE_SEC = boundedSeconds(process.env.SHADE_TREE_DIR_MAX_AGE_SEC, 300);
const DIR_FUTURE_SEC = boundedSeconds(process.env.SHADE_TREE_DIR_FUTURE_SEC, 300);

// Never let an onion address leak into monitor logs via an error string.
const scrub = (s) => String(s == null ? "" : s).replace(/[a-z2-7]{56}\.onion/gi, "<onion>");

// Parse --format nagios | --format=nagios | --nagios | --format json (default json).
function parseFormat(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--nagios") return "nagios";
    if (a === "--format") return (argv[i + 1] || "json").toLowerCase();
    if (a.startsWith("--format=")) return a.slice("--format=".length).toLowerCase();
  }
  return "json";
}

// Bounded, timed plain-HTTP GET for DEV mode (SHADE_TREE_BOOTNODE_URL). Production goes over Tor via
// fetchOverTor, which already caps the read and times out. Both return parsed JSON or throw.
function plainGet(base, path) {
  return new Promise((resolve, reject) => {
    let req;
    const url = new URL(path, base);
    req = http.get(url, { timeout: TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let buf = Buffer.alloc(0);
      res.on("data", (c) => {
        buf = Buffer.concat([buf, c]);
        if (buf.length > MAX_RESP) { res.destroy(); reject(new Error(`response exceeded ${MAX_RESP} bytes`)); }
      });
      res.on("end", () => { try { resolve(JSON.parse(buf.toString("utf8"))); } catch (e) { reject(e); } });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// `preferUrl`: an EXPLICIT SHADE_TREE_BOOTNODE_URL (set before the SHADE_TREE_NETWORK record filled
// anything) beats a record-supplied onion — explicit env wins over the record, and since the
// sepolia record went live (2026-08-17) it always supplies an onion.
function makeFetcher({ preferUrl = false } = {}) {
  const onion = process.env.SHADE_TREE_BOOTNODE_ONION;
  const url = process.env.SHADE_TREE_BOOTNODE_URL;
  if (preferUrl && url) return (path) => plainGet(url, path);
  if (onion) {
    return (path) => fetchOverTor(onion, path, { torHost: TOR_HOST, torPort: TOR_PORT, timeoutMs: TIMEOUT_MS, maxBytes: MAX_RESP });
  }
  if (url) return (path) => plainGet(url, path);
  return null; // misconfigured
}

export async function observeFleet() {
  // Fail-closed default: everything false / zero until proven otherwise.
  const result = { ok: false, bootnodeReachable: false, signerOk: false, directoryFresh: false, fleetSize: 0, ts: Math.floor(Date.now() / 1000) };
  let health = null;
  let directory = null;

  // SHADE_TREE_NETWORK: fill unset discovery inputs from the committed record; a broken record is a
  // misconfig (fail closed), never a throw out of probe().
  const explicitUrl = !!process.env.SHADE_TREE_BOOTNODE_URL && !process.env.SHADE_TREE_BOOTNODE_ONION;
  try { applyNetworkEnv(process.env); } catch (e) { result.reason = "misconfig:" + scrub(e.message).split("\n")[0]; return { result, health, directory }; }
  const pinnedSigner = process.env.SHADE_TREE_DIR_SIGNER;
  const fetchJson = makeFetcher({ preferUrl: explicitUrl });
  if (!fetchJson) { result.reason = "misconfig:set SHADE_TREE_BOOTNODE_ONION or SHADE_TREE_BOOTNODE_URL"; return { result, health, directory }; }
  if (!pinnedSigner) { result.reason = "misconfig:set SHADE_TREE_DIR_SIGNER (pinned signer)"; return { result, health, directory }; }

  try {
    health = await fetchJson("/health");
    result.bootnodeReachable = true;            // we got a 200 from the bootnode
    const healthOk = health?.ok === true;       // the bootnode's own self-report

    const dir = await fetchJson("/directory");
    const v = verifyDirectory(dir, pinnedSigner);
    result.signerOk = v.ok;
    const nowSec = Math.floor(Date.now() / 1000);
    result.directoryFresh = v.ok
      && Number.isInteger(dir?.issued)
      && dir.issued >= nowSec - DIR_MAX_AGE_SEC
      && dir.issued <= nowSec + DIR_FUTURE_SEC;
    result.fleetSize = result.directoryFresh && Array.isArray(dir.gateways) ? dir.gateways.length : 0;
    result.ok = healthOk && result.signerOk && result.directoryFresh;
    if (result.directoryFresh) directory = dir; // exposed only to trusted local aggregators; never printed here

    if (!v.ok) result.reason = "directory:" + v.reason;
    else if (!result.directoryFresh) result.reason = "directory:issued-outside-freshness-window";
    else if (!healthOk) result.reason = "bootnode health not ok";
  } catch (e) {
    // Unreachable, timeout, bad JSON, oversized body -> stay unhealthy, record a scrubbed reason.
    result.reason = scrub(e?.message || e);
  }
  return { result, health, directory };
}

export async function probe() {
  return (await observeFleet()).result;
}

function nagiosLine(r) {
  if (r.ok) return "OK: bootnode reachable, signed directory fresh";
  let why = r.reason || "unhealthy";
  if (!r.bootnodeReachable) why = "bootnode unreachable" + (r.reason ? ` (${r.reason})` : "");
  else if (!r.signerOk) why = "directory signer check failed" + (r.reason ? ` (${r.reason})` : "");
  return `CRITICAL: ${why}`;
}

// Only run when invoked directly; importing (the selftest) pulls probe() with no side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  const format = parseFormat(process.argv.slice(2));
  probe().then((result) => {
    if (format === "nagios") {
      console.log(nagiosLine(result));
      process.exit(result.ok ? 0 : 2); // Nagios convention: 0 OK, 2 CRITICAL
    } else {
      // Ordered, machine-readable one-liner for private/operator monitoring.
      const { ok, bootnodeReachable, signerOk, directoryFresh, fleetSize, ts, reason } = result;
      console.log(JSON.stringify({ ok, bootnodeReachable, signerOk, directoryFresh, fleetSize, ts, ...(reason ? { reason } : {}) }));
      process.exit(ok ? 0 : 1);
    }
  }).catch((e) => {
    // Last-resort fail-closed: even an unexpected throw reports unhealthy, never hangs.
    const ts = Math.floor(Date.now() / 1000);
    if (format === "nagios") { console.log(`CRITICAL: ${scrub(e?.message || e)}`); process.exit(2); }
    console.log(JSON.stringify({ ok: false, bootnodeReachable: false, signerOk: false, directoryFresh: false, fleetSize: 0, ts, reason: scrub(e?.message || e) }));
    process.exit(1);
  });
}
