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

// The pinned directory signer. In a real bundle this is a hardcoded constant set
// at build time; RGOE_DIR_SIGNER overrides for dev/testing. There is intentionally
// NO default: an unpinned directory is trust-on-first-use, which is exactly the
// poisoning surface the signature exists to close. Set it, or directory mode is off.
const PINNED_SIGNER = process.env.RGOE_DIR_SIGNER || null;

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
const REFRESH_MS = Number(process.env.RGOE_DIRECTORY_REFRESH_MS || 5 * 60 * 1000);

async function ensureLoaded() {
  const now = Date.now();
  if (loaded && now - loadedAt < REFRESH_MS) return loaded;
  try {
    const next = BOOTNODE_ONION
      ? await loadFromBootnode()
      : await loadDirectory({ path: DIRECTORY_PATH, pinnedSigner: PINNED_SIGNER, cachePath: CACHE_PATH });
    // Carry forward live health across a refresh so a reload doesn't forget which
    // gateways just failed.
    if (loaded) {
      const prev = new Map(loaded.dir.gateways.map((g) => [g.onion, g]));
      for (const g of next.dir.gateways) {
        const p = prev.get(g.onion);
        if (p) { g.health = p.health; g._fails = p._fails; g._latencyMs = p._latencyMs; }
      }
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
}
