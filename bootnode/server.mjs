// The bootnode: a live gateway-discovery service, published as its own v3 onion service.
//
// The static signed directory (group/sign-directory.mjs + lib/directory.mjs) is complete but
// hand-maintained: to add or retire a gateway you re-sign and re-ship a file. The bootnode is
// the DYNAMIC version of that exact same signed shape. Gateways announce themselves (bootnode/
// announce.mjs); the bootnode verifies each announce, holds live ones for a TTL, and serves the
// union as a signed directory that lib/directory.mjs verifyDirectory() already knows how to check.
//
// THE BOOTNODE IS A CONVENIENCE CACHE, NOT A TRUST ROOT. It cannot forge a gateway:
//   - every entry is self-authenticating (the v3 .onion IS its ed25519 key; verifyDirectory
//     re-derives the key from the address, so a swapped onion fails the client's own check),
//   - onion control is proven cryptographically on announce and re-provable by any client
//     from GET /gateway/<onion> (the stored, signed announce),
//   - the operator stake, if required, is checked on chain and re-checkable by any client.
// So a hostile bootnode can at worst OMIT gateways or list one whose stake later lapsed — both
// caught by the client re-checking on chain — never inject an onion it does not control.
//
// The onion is NEVER on chain (contracts/GatewayRegistry.sol stakes only an operator address).
// Discovery of the onion happens HERE, through the bootnode, exactly as intended.
//
// Config (all RGOE_*):
//   RGOE_BOOTNODE_PORT       loopback port Tor maps the onion to        (default 8877)
//   RGOE_BOOTNODE_SIGNER_KEY {pub,priv} JSON path for the pinned signer (default bootnode/bootnode-signer.key)
//   RGOE_BOOTNODE_ADMISSION  open | stake                               (default open)
//   RGOE_BOOTNODE_TTL        seconds a gateway stays live w/o re-announce (default 900)
//   RGOE_BOOTNODE_STORE      OPTIONAL JSON path for write-through persistence  (default off)
//                            When set, accepted announces are mirrored to disk and reloaded
//                            on boot so a restart does not blank the fleet until every gateway
//                            re-announces. Reload re-runs each stored record through the real
//                            announce path, so persistence can never admit anything a live
//                            announce would reject (see loadPersisted below).
//   RGOE_STAKE_MODE etc.     the StakeVerifier (lib/gateway-registry.mjs)

import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { signDirectory, verifyDirectory } from "../lib/directory.mjs";
import { verifyAnnounce } from "./announce.mjs";
import { makeStakeVerifier } from "../lib/gateway-registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- signer key (mint + persist if absent) ----------------------------------
function rawSeedHex(privKey) {
  const der = privKey.export({ format: "der", type: "pkcs8" });
  return der.subarray(der.length - 32).toString("hex");
}
function rawPubHex(pubKey) {
  const der = pubKey.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("hex");
}
export async function loadOrMintSigner(path) {
  if (existsSync(path)) return JSON.parse(await readFile(path, "utf8"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signer = { pub: rawPubHex(publicKey), priv: rawSeedHex(privateKey) };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(signer, null, 2) + "\n");
  return signer;
}

// ---- replay guard: bounded nonce memory, swept with the entries -------------
function makeNonceGuard(ttlMs) {
  const seen = new Map(); // key -> at
  return {
    has: (k) => seen.has(k),
    add: (k) => seen.set(k, Date.now()),
    sweep: () => { const cut = Date.now() - ttlMs; for (const [k, at] of seen) if (at < cut) seen.delete(k); },
  };
}

// ---- the registry (transport-independent; the selftest drives it directly) --
// DoS controls for the default `admission=open` mode, where anyone can mint onions and announce:
//   maxEntries      caps resident memory (a new onion is refused when full; existing ones still
//                   refresh, so a live fleet is never evicted by a flood).
//   minReannounceSec throttles per-onion re-announce so a single onion cannot spin the verify path.
//   MAX_WEIGHT      clamps the gateway-attested selection weight so one gateway cannot self-assign
//                   a huge weight and capture ~all client traffic (a concentration/deanon lever).
const MAX_WEIGHT = 1000;
export function makeRegistry({ signer, stake, admission = "open", ttlSec = 900, now = () => Math.floor(Date.now() / 1000),
    maxEntries = Number(process.env.RGOE_BOOTNODE_MAX_ENTRIES || 10000),
    minReannounceSec = Number(process.env.RGOE_BOOTNODE_MIN_REANNOUNCE || 5),
    // OPTIONAL persistence: a JSON store the live set is mirrored to. Off (null) by default, so
    // unset behavior — and every existing test — is byte-for-byte unchanged.
    persistPath = process.env.RGOE_BOOTNODE_STORE || null }) {
  const live = new Map(); // onion -> { pubkey, weight, operator, staked, rec, expiresAt, lastAt }
  const nonces = makeNonceGuard(ttlSec * 1000);
  const requireStake = admission === "stake";
  // While replaying the store on boot we call announce() but must NOT write-through each replay
  // (it would churn the file mid-reload); a single persist() after reload prunes what dropped.
  let reloading = false;

  // Write-through the CURRENT live set. We store the raw signed announce records (rec) + their
  // expiresAt — NOT derived state (pubkey/weight/staked). That is deliberate: reload must
  // RE-VERIFY from the signed record, never trust a cached verdict, so nothing on disk can grant
  // trust the crypto/stake path would not. Written atomically (tmp + rename) so a crash mid-write
  // cannot leave a truncated store. Persistence is a convenience cache: a write failure logs and
  // is swallowed, never breaking an accepted announce.
  function persist() {
    if (!persistPath) return;
    try {
      const entries = [...live.values()].map((e) => ({ rec: e.rec, expiresAt: e.expiresAt }));
      mkdirSync(dirname(persistPath), { recursive: true });
      const tmp = persistPath + ".tmp";
      writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
      renameSync(tmp, persistPath);
    } catch (e) {
      console.error(`[bootnode] persist write failed (continuing): ${e.message}`);
    }
  }

  // Reload-on-boot. For EACH persisted record we re-run the real announce() path — verifyAnnounce
  // (onion control + operator/stake) plus every DoS cap. WHY re-verify instead of trusting the
  // file: persistence must not be a trust bypass. A record is restored only if its onion signature
  // (and, in stake mode, its live operator stake) still verifies, so
  //   - a tampered store entry (e.g. a flipped onionSig) fails signature verification and is dropped,
  //   - a poisoned file can add nothing a live gateway could not have announced itself,
  //   - an operator who has since unstaked drops (isStaked is re-read on chain, fail-closed).
  // FRESHNESS on reload is the stored TTL (expiresAt), NOT the live-announce anti-replay window.
  // Those are different clocks: the ts-skew (~120s) bounds how old a LIVE announce may be to defeat
  // replay; the TTL (~900s) bounds how long an ACCEPTED gateway stays listed without re-announcing.
  // A restart 300s after the last heartbeat is normal and must keep the fleet — so we gate each
  // entry on its own expiresAt here and tell announce() to skip the ts-skew for this replay of our
  // OWN atomically-written store. An entry already past expiresAt is dropped (a stale store cannot
  // resurrect a long-dead gateway). Returns { loaded, dropped } for boot logging/tests.
  async function loadPersisted() {
    if (!persistPath || !existsSync(persistPath)) return { loaded: 0, dropped: 0 };
    let stored;
    try {
      stored = JSON.parse(readFileSync(persistPath, "utf8"));
    } catch (e) {
      console.error(`[bootnode] persist read failed, ignoring store: ${e.message}`);
      return { loaded: 0, dropped: 0 };
    }
    const entries = Array.isArray(stored?.entries) ? stored.entries : [];
    let loaded = 0, dropped = 0;
    reloading = true;
    try {
      for (const ent of entries) {
        // TTL freshness gate (against the current clock), independent of the announce ts-skew.
        if (!ent || typeof ent.expiresAt !== "number" || ent.expiresAt <= now()) { dropped++; continue; }
        const r = await announce(ent.rec, { fromStore: { expiresAt: ent.expiresAt } });
        if (r.ok) loaded++; else dropped++;
      }
    } finally {
      reloading = false;
    }
    persist(); // rewrite the store once so dropped (stale/tampered) records don't linger on disk
    return { loaded, dropped };
  }

  async function announce(rec, { fromStore = null } = {}) {
    // Cheap pre-checks BEFORE the expensive signature verify, so a flood is rejected early.
    const onionKey = typeof rec?.onion === "string" ? rec.onion : null;
    const existing = onionKey ? live.get(onionKey) : null;
    if (existing && now() - existing.lastAt < minReannounceSec) return { ok: false, reason: "rate-limited" };
    if (!existing && live.size >= maxEntries) { sweep(); if (live.size >= maxEntries) return { ok: false, reason: "registry-full" }; }

    const v = await verifyAnnounce(rec, {
      now: now(),
      // Reloading our OWN persisted store: freshness is the stored TTL (checked in loadPersisted),
      // not the anti-replay ts window — so don't drop a gateway announced more than one skew-window
      // before the restart. Onion control + operator stake are still fully re-verified.
      ...(fromStore ? { skew: Number.MAX_SAFE_INTEGER } : {}),
      isStaked: stake?.isStaked,
      requireStake,
      seenNonce: nonces,
    });
    if (!v.ok) return { ok: false, reason: v.reason };
    const rawWeight = Number.isFinite(rec.weight) ? rec.weight : 100;
    live.set(v.onion, {
      pubkey: v.pubkey,
      weight: Math.max(0, Math.min(MAX_WEIGHT, rawWeight)), // clamp self-attested weight
      operator: v.operator,
      staked: v.staked,
      rec,
      // Preserve the original expiry across a restart (don't silently extend a gateway's TTL);
      // a live announce gets a fresh now()+ttlSec.
      expiresAt: fromStore ? fromStore.expiresAt : now() + ttlSec,
      lastAt: now(),
    });
    if (!reloading) persist(); // write-through on each accepted announce (skipped during reload)
    return { ok: true, onion: v.onion, staked: v.staked };
  }

  function sweep() {
    const t = now();
    let evicted = false;
    for (const [onion, e] of live) if (e.expiresAt <= t) { live.delete(onion); evicted = true; }
    nonces.sweep();
    if (evicted && !reloading) persist(); // keep the store from retaining aged-out gateways
  }

  // Build the signed directory over currently-live entries — the exact shape
  // lib/directory.mjs verifyDirectory() consumes, plus operator/staked labels.
  function directory() {
    sweep();
    const gateways = [...live.entries()].map(([onion, e]) => ({
      onion,
      pubkey: e.pubkey,
      weight: e.weight,
      health: "up", // liveness here == announced within TTL; clients still probe + fail over
      ...(e.operator ? { operator: e.operator, staked: e.staked } : {}),
    }));
    const dir = { version: 1, issued: now(), gateways, signer: signer.pub };
    return signDirectory(dir, signer.priv);
  }

  const record = (onion) => live.get(String(onion).endsWith(".onion") ? onion : onion + ".onion")?.rec || null;

  return { announce, directory, sweep, record, loadPersisted, size: () => live.size, admission, ttlSec };
}

// ---- HTTP transport ---------------------------------------------------------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => { buf += c; if (buf.length > max) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

export function makeServer(registry, { signerPub } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://bootnode");
      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, count: registry.size(), admission: registry.admission, signer: signerPub });
      }
      if (req.method === "GET" && url.pathname === "/directory") {
        return send(res, 200, registry.directory());
      }
      // GET /gateway/<onion> -> the stored signed announce, for zero-trust re-verification.
      if (req.method === "GET" && url.pathname.startsWith("/gateway/")) {
        const onion = decodeURIComponent(url.pathname.slice("/gateway/".length));
        const rec = registry.record(onion);
        return rec ? send(res, 200, rec) : send(res, 404, { ok: false, err: "not-found" });
      }
      if (req.method === "POST" && url.pathname === "/announce") {
        let rec;
        try { rec = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { ok: false, err: "bad-json:" + e.message }); }
        const r = await registry.announce(rec);
        return send(res, r.ok ? 200 : 400, r.ok ? { ok: true, onion: r.onion, staked: r.staked, ttl: registry.ttlSec } : { ok: false, err: r.reason });
      }
      return send(res, 404, { ok: false, err: "no-route" });
    } catch (e) {
      return send(res, 500, { ok: false, err: "bootnode-error:" + e.message });
    }
  });
}

// ---- main -------------------------------------------------------------------
async function main() {
  const port = Number(process.env.RGOE_BOOTNODE_PORT || 8877);
  const admission = process.env.RGOE_BOOTNODE_ADMISSION || "open";
  const ttlSec = Number(process.env.RGOE_BOOTNODE_TTL || 900);
  const signerPath = process.env.RGOE_BOOTNODE_SIGNER_KEY || join(HERE, "bootnode-signer.key");

  const signer = await loadOrMintSigner(signerPath);
  const stake = makeStakeVerifier();
  const persistPath = process.env.RGOE_BOOTNODE_STORE || null;
  const registry = makeRegistry({ signer, stake, admission, ttlSec, persistPath });
  registry.ttlSec = ttlSec;
  // Reload-on-boot: re-announce any persisted fleet so a restart doesn't blank the directory
  // until every gateway re-announces. Each record is re-verified (stale/tampered ones drop).
  if (persistPath) {
    const { loaded, dropped } = await registry.loadPersisted();
    console.log(`persistence: reloaded ${loaded} gateway(s) from ${persistPath} (${dropped} dropped as stale/invalid)`);
  }
  setInterval(() => registry.sweep(), Math.min(ttlSec, 60) * 1000).unref();

  const server = makeServer(registry, { signerPub: signer.pub });
  server.listen(port, "127.0.0.1", () => {
    console.log(`bootnode up on 127.0.0.1:${port}  (admission=${admission}, stake=${stake.mode}, ttl=${ttlSec}s)`);
    console.log(`pinned signer pubkey (clients set RGOE_DIR_SIGNER to this):`);
    console.log(`  ${signer.pub}`);
    console.log(`endpoints: POST /announce  GET /directory  GET /gateway/<onion>  GET /health`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
