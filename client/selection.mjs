// Shim-as-router: per-request gateway selection over the signed fleet directory.
//
// The shim stays the router; curl stays dumb. When RGOE_DIRECTORY points at a
// signed directory JSON, the shim asks here for a candidate ORDER per CONNECT:
// a weighted-random pick first, then the rest of the fleet as failover targets.
// The membership proof is gateway-independent (same root + same epoch verifies at
// any gateway loading the same members.json), so rotation reuses the cached proof
// and just dials a different onion. No new proof per rotation.
//
// The single-onion path (RGOE_ONION / tor/hs/hostname) is untouched: if
// RGOE_DIRECTORY is unset, directoryEnabled() is false and the shim keeps pinning.
//
// Integration is one line in the shim's connect handler (see docs/FLEET.md):
//   const candidates = await selectCandidates();   // [{ onion }, ...] in try order
// then dial candidates in order, and on success/failure call:
//   reportResult(onion, { ok, latencyMs });

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDirectory, selectionOrder, reportHealth, verifyDirectory } from "../lib/directory.mjs";
import { fetchOverTor } from "../bootnode/fetch.mjs";
import { verifyAnnounce } from "../bootnode/announce.mjs";
import { makeStakeVerifier } from "../lib/gateway-registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Two directory SOURCES, same signed shape and same pinned-signer verification:
//   - RGOE_BOOTNODE_ONION : live discovery. Fetch /directory from the bootnode onion over Tor
//                           (bootnode/server.mjs). The pinned signer (RGOE_DIR_SIGNER) is the
//                           bootnode's signer key. This is the dynamic fleet.
//   - RGOE_DIRECTORY      : static signed JSON file (group/sign-directory.mjs). The offline path.
// Bootnode wins if both are set. Either way, verifyDirectory + last-known-good caching apply.
const BOOTNODE_ONION = process.env.RGOE_BOOTNODE_ONION || null;
const DIRECTORY_PATH = process.env.RGOE_DIRECTORY || null;
const CACHE_PATH =
  process.env.RGOE_DIRECTORY_CACHE ||
  (BOOTNODE_ONION ? join(HERE, "..", "cache", "bootnode-directory.lkg") : DIRECTORY_PATH ? DIRECTORY_PATH + ".lkg" : null);
const TOR_HOST = process.env.RGOE_TOR_HOST || "127.0.0.1";
const TOR_PORT = Number(process.env.RGOE_TOR_PORT || 9250);

// ---- client-side gateway reputation persistence (T-FEAT-19) ---------------------
// reportHealth() (lib/directory.mjs) mutates in-memory dir entries (_fails/health/_latencyMs),
// which is LOST on restart: a gateway that failed all last session is forgotten and gets a fresh
// weighted pick again this session. We keep a SMALL local, best-effort cache of per-gateway
// liveness so a flaky gateway stays deprioritized ACROSS sessions until it proves healthy again.
//
// Scope + privacy: this is a LOCAL file only. It is never sent to the bootnode or the fleet, and
// it stores only onions the client already learned from the SIGNED directory plus fail counts and
// a latency EWMA. No member data, no directory contents. The cache is keyed by onion:
//   onion -> { fails, lastFail, latencyMs, lastSeen }
//
// Fully OPTIONAL and non-breaking: if the path is empty or the dir isn't writable, load returns {}
// and save no-ops (fail soft) — selection behaves exactly as the in-memory-only path does today.
//
// RGOE_HEALTH_CACHE   : path to the JSON file (default cache/gateway-health.json, which is gitignored).
//                       Set to "" (or "off"/"0") to disable persistence entirely.
// RGOE_HEALTH_MAX     : max distinct gateways retained (oldest-lastSeen evicted first).
// RGOE_HEALTH_DECAY_MS: an entry not SEEN for this long is treated as recovered (not seeded, pruned).
function resolveHealthCachePath() {
  const raw = process.env.RGOE_HEALTH_CACHE;
  if (raw === undefined) return join(HERE, "..", "cache", "gateway-health.json");
  const v = raw.trim();
  if (v === "" || v === "0" || v.toLowerCase() === "off") return null; // explicit OFF
  return v;
}
const HEALTH_CACHE_PATH = resolveHealthCachePath();
const HEALTH_MAX_ENTRIES = Math.max(1, Number(process.env.RGOE_HEALTH_MAX || 512));
const HEALTH_DECAY_MS = Number(process.env.RGOE_HEALTH_DECAY_MS || 14 * 24 * 60 * 60 * 1000); // 14 days
const HEALTH_FAIL_THRESHOLD = 2; // mirror reportHealth(): >= 2 consecutive fails => "down"

// Read the persisted cache. Best-effort and TOTAL: any error (missing/unwritable/corrupt) yields an
// empty map, so a broken cache can never break selection. Tolerates both the versioned envelope we
// write ({version,entries}) and a bare onion->entry map.
export function loadHealthCache(path = HEALTH_CACHE_PATH) {
  if (!path) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw && typeof raw === "object") {
      if (raw.entries && typeof raw.entries === "object") return raw.entries;
      if (!raw.version) return raw; // bare map
    }
  } catch { /* fail soft */ }
  return {};
}

// Cap the cache in place: evict the oldest-lastSeen entries down to HEALTH_MAX_ENTRIES so it can
// never grow unboundedly. Mutates and returns the same object.
function boundHealthCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length <= HEALTH_MAX_ENTRIES) return cache;
  keys.sort((a, b) => (cache[a]?.lastSeen || 0) - (cache[b]?.lastSeen || 0));
  for (const k of keys.slice(0, keys.length - HEALTH_MAX_ENTRIES)) delete cache[k];
  return cache;
}

// Write-through, bounded, best-effort. Returns true iff the file was written. A failure (no path,
// read-only dir, ENOTDIR, ...) is swallowed: persistence is off, selection is unaffected.
export function saveHealthCache(cache = _healthCache, path = HEALTH_CACHE_PATH) {
  if (!path) return false;
  try {
    boundHealthCache(cache);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, entries: cache }, null, 2) + "\n");
    return true;
  } catch { return false; }
}

// Seed a freshly-loaded directory's in-memory liveness from the persisted cache, so a gateway that
// failed a lot last session STARTS deprioritized (health "down" and/or a latency handicap) until it
// proves healthy again this session. Decay, not blacklist: an entry not seen for HEALTH_DECAY_MS is
// ignored (and will be pruned on the next save), so a long-idle or recovered gateway comes back.
// Mutates dir.gateways in place (the same objects selectionOrder/reportHealth key on) and returns dir.
export function seedHealthFromCache(dir, cache = _healthCache, now = Date.now()) {
  if (!dir || !Array.isArray(dir.gateways) || !cache) return dir;
  for (const g of dir.gateways) {
    const e = cache[g.onion];
    if (!e) continue;
    if (typeof e.lastSeen === "number" && now - e.lastSeen >= HEALTH_DECAY_MS) {
      delete cache[g.onion]; // decayed: recovered, prune
      continue;
    }
    const fails = Number(e.fails) || 0;
    if (fails > 0) g._fails = fails;
    if (fails >= HEALTH_FAIL_THRESHOLD) g.health = "down";
    if (typeof e.latencyMs === "number") g._latencyMs = e.latencyMs;
  }
  return dir;
}

// Fold one dial result into the persisted cache and write through. Privacy guard: only persist an
// onion the client already knows from the SIGNED directory (never arbitrary caller input). A
// successful dial resets fails (recovery); failures increment toward the "down" threshold.
function updateHealthCache(dir, onion, { ok, latencyMs } = {}) {
  if (!HEALTH_CACHE_PATH) return; // persistence disabled
  if (!(dir.gateways || []).some((x) => x.onion === onion)) return; // unknown onion: don't persist
  const now = Date.now();
  const e = _healthCache[onion] || { fails: 0, lastFail: 0, latencyMs: null, lastSeen: 0 };
  if (ok === false) {
    e.fails = (e.fails || 0) + 1;
    e.lastFail = now;
  } else if (ok === true) {
    e.fails = 0; // a successful dial recovers the gateway
    if (typeof latencyMs === "number") {
      e.latencyMs = e.latencyMs == null ? latencyMs : Math.round(0.7 * e.latencyMs + 0.3 * latencyMs);
    }
  }
  e.lastSeen = now;
  _healthCache[onion] = e;
  saveHealthCache(_healthCache, HEALTH_CACHE_PATH);
}

// Loaded once at module init (best-effort). Env is read at import, same as the rest of this module.
let _healthCache = loadHealthCache(HEALTH_CACHE_PATH);

// The pinned directory signer(s). In a real bundle this is a hardcoded constant set
// at build time; RGOE_DIR_SIGNER overrides for dev/testing. There is intentionally
// NO default: an unpinned directory is trust-on-first-use, which is exactly the
// poisoning surface the signature exists to close. Set it, or directory mode is off.
//
// RGOE_DIR_SIGNER accepts a COMMA-SEPARATED list of pubkeys — the signer-rotation
// OVERLAP SET. This is an allowlist (verifyDirectory accepts a directory signed by ANY
// listed signer, and requires the declared `dir.signer` to be one of them), NOT
// "trust any signer": an unpinned/wrong key is still rejected. A single value behaves
// exactly as before. Rotating the directory signer without a flag day:
//   1. Add the NEW signer pubkey to the client set (now {old,new}); ship it. Clients
//      still accept the old-signed directory, so nothing breaks during rollout.
//   2. Once the {old,new} clients have propagated, rotate the bootnode's signing key
//      to NEW (bootnode now signs with, and declares, the new key). Old clients that
//      already have {old,new} accept it; not-yet-updated {old} clients still work
//      until they update, because the overlap window covers both.
//   3. After everyone has the new set, drop OLD from the client set (now {new} only),
//      retiring the old key.
function parsePinnedSigners(raw) {
  if (!raw) return null;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}
const PINNED_SIGNER = parsePinnedSigners(process.env.RGOE_DIR_SIGNER);

export function directoryEnabled() {
  return Boolean((BOOTNODE_ONION || DIRECTORY_PATH) && PINNED_SIGNER);
}

// ---- client zero-trust operator re-verification (T-DEV-5) -----------------------
// OFF by default (RGOE_VERIFY_STAKE=1 to arm) so existing behavior + tests are unchanged.
//
// The signed directory carries the bootnode's `operator`/`staked` LABEL, but that label is the
// one claim in the directory the client cannot check from the entry alone: the onion<->operator
// binding and the operator's live stake live in the raw announce and on chain, not in the
// signed directory. So a compromised bootnode (or a compromised directory signer) could paste a
// `staked:true` label onto a gateway whose operator never authorized it, or whose stake has
// lapsed. With the flag armed, the client refuses to take that label on faith: for every entry
// that claims stake it fetches the bootnode's STORED signed announce (GET /gateway/<onion>) and
// independently re-runs the same two proofs the bootnode ran at admission —
//   1. onion-control + operator-authorization signatures (announce.mjs verifyAnnounce), and
//   2. GatewayRegistry.isStaked(operator) live (gateway-registry.mjs makeStakeVerifier) —
// dropping any gateway that fails, regardless of the label. Onion-only entries (no operator)
// are not claiming stake, so there is nothing to re-verify and they pass through untouched.
const VERIFY_STAKE = process.env.RGOE_VERIFY_STAKE === "1";
export function verifyStakeEnabled() {
  return VERIFY_STAKE;
}

// Injectable dependencies. Defaults hit the live bootnode over Tor and the configured
// StakeVerifier; a test swaps in an in-memory fetch + a mock stake verifier via setVerifyDeps()
// so the re-verification can be driven with no Tor and no chain. Mirrors how selection.mjs reads
// config at import while still exposing the moving parts as hooks.
let _fetchAnnounce = null; // (onion) => Promise<announceRecord>  (GET /gateway/<onion>)
let _stakeVerifier = null; // { isStaked(operatorAddr) => Promise<bool> }
export function setVerifyDeps({ fetchAnnounce, stake } = {}) {
  if (fetchAnnounce !== undefined) _fetchAnnounce = fetchAnnounce;
  if (stake !== undefined) _stakeVerifier = stake;
}

// Default announce fetch: the bootnode's stored, signed announce for one onion, over Tor.
// Only meaningful in live-discovery mode (RGOE_BOOTNODE_ONION); a static-file directory has no
// bootnode to ask, so re-verification is a live-discovery feature.
function defaultFetchAnnounce(onion) {
  if (!BOOTNODE_ONION) throw new Error("stake re-verification needs RGOE_BOOTNODE_ONION (no bootnode to fetch the signed announce from)");
  const full = onion.endsWith(".onion") ? onion : onion + ".onion";
  return fetchOverTor(BOOTNODE_ONION, `/gateway/${encodeURIComponent(full)}`, { torHost: TOR_HOST, torPort: TOR_PORT });
}

function stakeVerifier() {
  if (!_stakeVerifier) _stakeVerifier = makeStakeVerifier();
  return _stakeVerifier;
}

// Independently re-verify one directory entry that claims stake. Returns { ok, reason }.
// An entry with no `operator` is not claiming stake, so there is nothing to re-verify (ok).
// Freshness is intentionally NOT re-enforced here (skew defaults to Infinity): the replay window
// is the bootnode's admission control, and the client already verified the signed directory's
// recency + probes liveness by dialing. What the client re-checks is the pairing (onion<->operator
// signatures) and the LIVE stake — the two things a lying bootnode/label could get wrong.
export async function reverifyGateway(entry, opts = {}) {
  if (!entry || !entry.operator) return { ok: true, reason: "not-staked-entry" };
  const fetchAnnounce = opts.fetchAnnounce || _fetchAnnounce || defaultFetchAnnounce;
  const stake = opts.stake || _stakeVerifier || stakeVerifier();
  const skew = opts.skew ?? Infinity;

  let rec;
  try {
    rec = await fetchAnnounce(entry.onion);
  } catch (e) {
    return { ok: false, reason: `announce-fetch-failed:${e.message}` };
  }
  // The fetched announce must be for the SAME onion the directory listed (a bootnode cannot
  // satisfy a re-verify by returning a valid announce for a DIFFERENT onion).
  const want = String(entry.onion).replace(/\.onion$/, "");
  const got = String(rec?.onion || "").replace(/\.onion$/, "");
  if (got !== want) return { ok: false, reason: "announce-onion-mismatch" };

  // verifyAnnounce runs onion-control sig + operator-authorization sig + isStaked in one place —
  // the SAME code the bootnode uses, so the client never reimplements the crypto. requireStake
  // makes a missing/failed stake a hard reject.
  const v = await verifyAnnounce(rec, { isStaked: stake.isStaked, requireStake: true, skew });
  return v.ok ? { ok: true } : { ok: false, reason: v.reason };
}

// Filter a gateway list down to those that survive re-verification. Entries without an operator
// label pass through; entries claiming stake are re-verified in parallel and dropped on failure.
async function filterReverified(gateways) {
  const kept = await Promise.all(
    gateways.map(async (g) => {
      if (!g.operator) return g;
      const v = await reverifyGateway(g);
      if (v.ok) return g;
      console.log(`directory: dropping ${g.onion.slice(0, 12)}.. — stake re-verification failed (${v.reason})`);
      return null;
    })
  );
  return kept.filter(Boolean);
}

// Fetch + verify the bootnode's live directory over Tor, with the same last-known-good
// discipline loadDirectory() gives the file path: a dead or poisoned bootnode degrades to
// the previously-cached good fleet, never to nothing and never to an unverified list.
async function loadFromBootnode() {
  try {
    const fresh = await fetchOverTor(BOOTNODE_ONION, "/directory", { torHost: TOR_HOST, torPort: TOR_PORT });
    const v = verifyDirectory(fresh, PINNED_SIGNER);
    if (!v.ok) throw new Error(v.reason);
    if (CACHE_PATH) {
      try { await mkdir(dirname(CACHE_PATH), { recursive: true }); await writeFile(CACHE_PATH, JSON.stringify(fresh, null, 2) + "\n"); } catch {}
    }
    return { dir: fresh, source: "bootnode" };
  } catch (freshErr) {
    if (CACHE_PATH) {
      try {
        const cached = JSON.parse(await readFile(CACHE_PATH, "utf8"));
        if (verifyDirectory(cached, PINNED_SIGNER).ok) return { dir: cached, source: "cache", freshError: freshErr.message };
      } catch {}
    }
    throw new Error(`no verifiable bootnode directory (fresh: ${freshErr.message}, no valid cache)`);
  }
}

// Loaded once and refreshed lazily; health is mutated in place across requests.
let loaded = null; // { dir, source }
let loadedAt = 0;
// High-water mark of every directory `issued` we've accepted this session. Used to refuse a
// directory whose timestamp moves BACKWARD (audit loop-15 F2). Exported reset for tests.
let lastAcceptedIssued = 0;
export function _resetIssuedFloor() { lastAcceptedIssued = 0; }
const REFRESH_MS = Number(process.env.RGOE_DIRECTORY_REFRESH_MS || 5 * 60 * 1000);

async function ensureLoaded() {
  const now = Date.now();
  if (loaded && now - loadedAt < REFRESH_MS) return loaded;
  try {
    const next = BOOTNODE_ONION
      ? await loadFromBootnode()
      : await loadDirectory({ path: DIRECTORY_PATH, pinnedSigner: PINNED_SIGNER, cachePath: CACHE_PATH });
    // Rollback / stale-directory replay guard (audit loop-15 F2): a directory's `issued` must
    // never move BACKWARD. The bootnode signs its own directory and an ed25519 signature is
    // valid forever, so a hostile or replaying bootnode could serve an OLD signed directory to
    // resurrect a gateway that was since dropped or slashed — and verifyDirectory, being
    // stateless, would accept it clean. We refuse any FRESH directory whose issued predates the
    // newest one we've already accepted (a same-issued refetch is idempotent and fine). Our own
    // last-known-good CACHE is trusted so it never trips the guard, but it still raises the floor
    // so a subsequent fresh fetch can't roll us back behind the cache. A thrown rejection is
    // caught below and we keep the good in-memory fleet — fail-closed.
    const nextIssued = Number(next.dir && next.dir.issued) || 0;
    if (next.source !== "cache" && nextIssued < lastAcceptedIssued) {
      throw new Error(`directory rollback rejected: issued ${nextIssued} < last accepted ${lastAcceptedIssued}`);
    }
    if (nextIssued > lastAcceptedIssued) lastAcceptedIssued = nextIssued;
    // Carry forward live health across a refresh so a reload doesn't forget which
    // gateways just failed.
    if (loaded) {
      const prev = new Map(loaded.dir.gateways.map((g) => [g.onion, g]));
      for (const g of next.dir.gateways) {
        const p = prev.get(g.onion);
        if (p) { g.health = p.health; g._fails = p._fails; g._latencyMs = p._latencyMs; }
      }
    } else {
      // First load of the session: seed liveness from the persisted cross-session cache so a
      // gateway that failed a lot last session starts deprioritized until it proves healthy again.
      seedHealthFromCache(next.dir, _healthCache, now);
    }
    loaded = next;
    loadedAt = now;
    if (next.source === "cache") {
      console.log(`directory: using last-known-good cache (${next.freshError || "fresh unavailable"})`);
    }
  } catch (e) {
    if (loaded) {
      console.log(`directory refresh failed (${e.message}); keeping in-memory fleet`);
    } else {
      throw e; // no fleet at all is fatal for directory mode
    }
  }
  return loaded;
}

// Returns an ordered list of candidate gateways to try this CONNECT: the weighted
// pick first, then failovers. Each is { onion }.
export async function selectCandidates() {
  const { dir } = await ensureLoaded();
  let gateways = dir.gateways;
  if (VERIFY_STAKE) gateways = await filterReverified(gateways);
  // Run selection over the (possibly filtered) fleet. Reuse the SAME entry objects so
  // reportHealth's in-place mutation (keyed by onion on dir.gateways) still lands on them.
  const view = gateways === dir.gateways ? dir : { ...dir, gateways };
  return selectionOrder(view).map((g) => ({ onion: g.onion.replace(/\.onion$/, "") }));
}

// Health/latency feedback from the shim after a dial attempt.
export function reportResult(onion, { ok, latencyMs } = {}) {
  if (!loaded) return;
  const full = onion.endsWith(".onion") ? onion : onion + ".onion";
  reportHealth(loaded.dir, full, { ok, latencyMs });
  // Write-through to the local cross-session cache (best-effort; no-op if persistence is off).
  updateHealthCache(loaded.dir, full, { ok, latencyMs });
}
