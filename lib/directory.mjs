// The fleet directory: load, verify, and select from a signed list of gateways.
//
// The PoC pins one gateway (RGOE_ONION or tor/hs/hostname). A fleet needs a
// discovery layer, because onion descriptors are stored under a *blinded* key on
// the HSDir hashring precisely so gateways cannot be enumerated. So the directory
// is something we build at the app layer: a small signed JSON of
//   { onion, pubkey, weight, health }
// shipped with the bundle and refreshable over its own onion. The signer key is
// PINNED in the client, so a swapped file is rejected, not trusted.
//
// Two integrity checks, layered:
//   1. The whole list is ed25519-signed by the pinned directory signer.
//   2. Each entry's `pubkey` MUST equal the ed25519 identity key encoded in its
//      own v3 `.onion` address (onionToPubkey below). A v3 address *is* that key,
//      so a poisoned directory cannot graft a hostile onion under a pubkey it does
//      not control: the live onion-control challenge (verifyOnionControl) is then
//      a signature by that same key. Address and key cannot disagree.
//
// The static-signed-JSON path here is complete. The on-chain-sourced mode (source
// the fleet from the same group root as the reputation set) is a TODO that reuses
// the same entry shape; see docs/FLEET.md and docs/ONCHAIN.md.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createPublicKey, createPrivateKey, sign as edSign, verify as edVerify, createHash } from "node:crypto";
import { dirname } from "node:path";

// --- ed25519 raw-key helpers (node built-in crypto, no deps) -----------------
// Raw 32-byte keys wrapped in the fixed DER prefixes so KeyObjects can be built
// without a keygen round-trip. ed25519 signs/verifies with a null digest.

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex"); // + 32B pubkey
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex"); // + 32B seed

export function ed25519PublicKey(rawHex) {
  const raw = Buffer.from(rawHex, "hex");
  if (raw.length !== 32) throw new Error("ed25519 pubkey must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function ed25519PrivateKey(rawHex) {
  const raw = Buffer.from(rawHex, "hex");
  if (raw.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

export function ed25519Sign(msgBuf, privHex) {
  return edSign(null, msgBuf, ed25519PrivateKey(privHex)).toString("hex");
}

export function ed25519Verify(msgBuf, sigHex, pubHex) {
  try {
    return edVerify(null, msgBuf, ed25519PublicKey(pubHex), Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}

// --- v3 onion <-> ed25519 key --------------------------------------------------
// v3 address = base32(PUBKEY[32] || CHECKSUM[2] || VERSION[1]), lowercase, no pad.
// CHECKSUM = SHA3-256(".onion checksum" || PUBKEY || 0x03)[:2]. The address is the
// key, so we can recover the key from the address and verify the checksum.

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32Decode(s) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s.toLowerCase()) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("bad base32 char in onion");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(value >> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// Recover the 32-byte ed25519 identity key from a v3 .onion address (checked).
export function onionToPubkey(onion) {
  const addr = onion.replace(/\.onion$/, "").toLowerCase();
  if (addr.length !== 56) throw new Error("not a v3 onion (expected 56 chars)");
  const decoded = base32Decode(addr);
  if (decoded.length !== 35) throw new Error("v3 onion decodes to 35 bytes");
  const pubkey = decoded.subarray(0, 32);
  const checksum = decoded.subarray(32, 34);
  const version = decoded[34];
  if (version !== 0x03) throw new Error("not onion version 3");
  const want = createHash("sha3-256")
    .update(Buffer.concat([Buffer.from(".onion checksum"), pubkey, Buffer.from([0x03])]))
    .digest()
    .subarray(0, 2);
  if (!checksum.equals(want)) throw new Error("onion checksum mismatch");
  return pubkey.toString("hex");
}

// Encode a 32-byte ed25519 key as its v3 .onion address (used by the signer tool).
export function pubkeyToOnion(pubHex) {
  const pubkey = Buffer.from(pubHex, "hex");
  if (pubkey.length !== 32) throw new Error("pubkey must be 32 bytes");
  const checksum = createHash("sha3-256")
    .update(Buffer.concat([Buffer.from(".onion checksum"), pubkey, Buffer.from([0x03])]))
    .digest()
    .subarray(0, 2);
  return base32Encode(Buffer.concat([pubkey, checksum, Buffer.from([0x03])])) + ".onion";
}

// --- directory signing / verification -----------------------------------------
// The signature covers a canonical serialization with fixed field order, so it is
// independent of file whitespace or key ordering. Sign and verify build the same
// bytes from the same fields; nothing else in the file is covered.

export function canonicalDirectoryBytes(dir) {
  const payload = {
    version: dir.version,
    issued: dir.issued,
    gateways: (dir.gateways || []).map((g) => ({
      onion: g.onion,
      pubkey: g.pubkey,
      weight: g.weight,
      health: g.health,
    })),
  };
  return Buffer.from(JSON.stringify(payload), "utf8");
}

export function signDirectory(dir, signerPrivHex) {
  const sig = ed25519Sign(canonicalDirectoryBytes(dir), signerPrivHex);
  return { ...dir, signature: sig };
}

// Verify the pinned-signer signature AND each entry's onion<->pubkey binding.
// Returns { ok, reason }. Does NOT prove liveness or control (that is the live
// challenge, verifyOnionControl); it proves the list is authentic and internally
// consistent, which is what stops a swapped or poisoned file.
export function verifyDirectory(dir, pinnedSignerHex) {
  if (!dir || typeof dir !== "object") return { ok: false, reason: "no-directory" };
  if (!dir.signature) return { ok: false, reason: "unsigned" };
  if (dir.signer && pinnedSignerHex && dir.signer.toLowerCase() !== pinnedSignerHex.toLowerCase()) {
    return { ok: false, reason: "signer-not-pinned" };
  }
  if (!ed25519Verify(canonicalDirectoryBytes(dir), dir.signature, pinnedSignerHex)) {
    return { ok: false, reason: "bad-signature" };
  }
  for (const g of dir.gateways || []) {
    let derived;
    try {
      derived = onionToPubkey(g.onion);
    } catch (e) {
      return { ok: false, reason: `bad-onion:${g.onion?.slice(0, 12)}..:${e.message}` };
    }
    if (derived.toLowerCase() !== String(g.pubkey).toLowerCase()) {
      return { ok: false, reason: `pubkey-onion-mismatch:${g.onion.slice(0, 12)}..` };
    }
  }
  return { ok: true };
}

// Live onion-control proof: the gateway signs a fresh challenge with its onion
// identity key. Verified against the key encoded in its own address, so a
// directory entry cannot claim an onion it does not hold the key for. Wire the
// challenge/response into the gateway envelope handshake; here is the check.
export function verifyOnionControl(onion, challengeBuf, sigHex) {
  let pub;
  try {
    pub = onionToPubkey(onion);
  } catch {
    return false;
  }
  return ed25519Verify(challengeBuf, sigHex, pub);
}

// --- load with last-known-good fallback ---------------------------------------
// A dead or poisoned directory must degrade to the PREVIOUS good fleet, never to
// nothing and never to a hostile gateway. So: verify the fetched file; on success
// cache it; on failure fall back to the cached last-known-good (itself re-verified
// against the same pinned signer). Returns { dir, source } or throws if neither
// the fresh nor the cached copy verifies.
export async function loadDirectory({ path, pinnedSigner, cachePath } = {}) {
  let fresh = null, freshErr = null;
  if (path) {
    try {
      fresh = JSON.parse(await readFile(path, "utf8"));
      const v = verifyDirectory(fresh, pinnedSigner);
      if (!v.ok) throw new Error(v.reason);
    } catch (e) {
      fresh = null;
      freshErr = e;
    }
  }
  if (fresh) {
    if (cachePath) {
      try {
        await mkdir(dirname(cachePath), { recursive: true });
        await writeFile(cachePath, JSON.stringify(fresh, null, 2) + "\n");
      } catch { /* cache write is best-effort */ }
    }
    return { dir: fresh, source: "fresh" };
  }
  // Fresh failed or absent: try last-known-good.
  if (cachePath) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8"));
      const v = verifyDirectory(cached, pinnedSigner);
      if (v.ok) return { dir: cached, source: "cache", freshError: freshErr?.message };
    } catch { /* fall through */ }
  }
  throw new Error("no verifiable directory (fresh: " + (freshErr?.message || "none") + ", no valid cache)");
}

// --- selection ----------------------------------------------------------------
// Weighted-random pick over healthy gateways, excluding any the caller already
// tried this connection. `exclude` is a Set of onion addresses. Health is a
// runtime signal (see reportHealth); a gateway marked "down" is skipped unless it
// is the only option left, so the fleet degrades rather than dead-ending.

// Selection weight is gateway-attested, so the CLIENT must bound it too, not just the bootnode:
// the bootnode clamps `weight` at announce (bootnode/server.mjs MAX_WEIGHT), but a STATIC signed
// directory or a compromised directory signer bypasses that path. Clamping here means no directory
// source can concentrate a member's traffic on one gateway (a deanonymization lever). Undefined/NaN
// weight defaults to 1; negative floors at 0; anything huge caps at MAX_WEIGHT.
export const MAX_WEIGHT = 1000;
function clampWeight(g) {
  const w = Number(g?.weight);
  return Number.isFinite(w) ? Math.max(0, Math.min(MAX_WEIGHT, w)) : 1;
}

export function pickGateway(dir, { exclude = new Set(), rng = Math.random } = {}) {
  const all = (dir.gateways || []).filter((g) => !exclude.has(g.onion));
  if (all.length === 0) return null;
  const healthy = all.filter((g) => g.health !== "down");
  const pool = healthy.length ? healthy : all; // last resort: try a "down" one
  const total = pool.reduce((s, g) => s + clampWeight(g), 0);
  if (total <= 0) return pool[Math.floor(rng() * pool.length)];
  let r = rng() * total;
  for (const g of pool) {
    r -= clampWeight(g);
    if (r < 0) return g;
  }
  return pool[pool.length - 1];
}

// Failover order: the weighted pick first, then the rest of the fleet as fallbacks
// in weighted order, so the shim can walk the list on dial timeout.
export function selectionOrder(dir, { rng = Math.random } = {}) {
  const order = [];
  const exclude = new Set();
  let g;
  while ((g = pickGateway(dir, { exclude, rng }))) {
    order.push(g);
    exclude.add(g.onion);
  }
  return order;
}

// Health-update hook. Mutates the in-memory dir entry so subsequent picks react to
// live latency/failures. Health is intentionally NOT persisted to the signed file
// (the file is the signer's view; this is the client's local view of liveness).
export function reportHealth(dir, onion, { ok, latencyMs } = {}) {
  const g = (dir.gateways || []).find((x) => x.onion === onion);
  if (!g) return;
  if (ok === false) {
    g._fails = (g._fails || 0) + 1;
    if (g._fails >= 2) g.health = "down";
  } else if (ok === true) {
    g._fails = 0;
    g.health = "up";
    if (typeof latencyMs === "number") {
      // simple EWMA so a persistently slow gateway loses weight over time
      g._latencyMs = g._latencyMs == null ? latencyMs : Math.round(0.7 * g._latencyMs + 0.3 * latencyMs);
    }
  }
}
