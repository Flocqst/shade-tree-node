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
  return selectionOrder(dir).map((g) => ({ onion: g.onion.replace(/\.onion$/, "") }));
}

// Health/latency feedback from the shim after a dial attempt.
export function reportResult(onion, { ok, latencyMs } = {}) {
  if (!loaded) return;
  const full = onion.endsWith(".onion") ? onion : onion + ".onion";
  reportHealth(loaded.dir, full, { ok, latencyMs });
}
