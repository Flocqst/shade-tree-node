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

import { loadDirectory, selectionOrder, reportHealth } from "../lib/directory.mjs";

const DIRECTORY_PATH = process.env.RGOE_DIRECTORY || null;
const CACHE_PATH = process.env.RGOE_DIRECTORY_CACHE || (DIRECTORY_PATH ? DIRECTORY_PATH + ".lkg" : null);

// The pinned directory signer. In a real bundle this is a hardcoded constant set
// at build time; RGOE_DIR_SIGNER overrides for dev/testing. There is intentionally
// NO default: an unpinned directory is trust-on-first-use, which is exactly the
// poisoning surface the signature exists to close. Set it, or directory mode is off.
const PINNED_SIGNER = process.env.RGOE_DIR_SIGNER || null;

export function directoryEnabled() {
  return Boolean(DIRECTORY_PATH && PINNED_SIGNER);
}

// Loaded once and refreshed lazily; health is mutated in place across requests.
let loaded = null; // { dir, source }
let loadedAt = 0;
const REFRESH_MS = Number(process.env.RGOE_DIRECTORY_REFRESH_MS || 5 * 60 * 1000);

async function ensureLoaded() {
  const now = Date.now();
  if (loaded && now - loadedAt < REFRESH_MS) return loaded;
  try {
    const next = await loadDirectory({
      path: DIRECTORY_PATH,
      pinnedSigner: PINNED_SIGNER,
      cachePath: CACHE_PATH,
    });
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
  return selectionOrder(dir).map((g) => ({ onion: g.onion.replace(/\.onion$/, "") }));
}

// Health/latency feedback from the shim after a dial attempt.
export function reportResult(onion, { ok, latencyMs } = {}) {
  if (!loaded) return;
  const full = onion.endsWith(".onion") ? onion : onion + ".onion";
  reportHealth(loaded.dir, full, { ok, latencyMs });
}
