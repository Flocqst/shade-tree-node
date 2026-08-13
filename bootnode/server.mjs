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
//   RGOE_STAKE_MODE etc.     the StakeVerifier (lib/gateway-registry.mjs)

import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
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
    minReannounceSec = Number(process.env.RGOE_BOOTNODE_MIN_REANNOUNCE || 5) }) {
  const live = new Map(); // onion -> { pubkey, weight, operator, staked, rec, expiresAt, lastAt }
  const nonces = makeNonceGuard(ttlSec * 1000);
  const requireStake = admission === "stake";

  async function announce(rec) {
    // Cheap pre-checks BEFORE the expensive signature verify, so a flood is rejected early.
    const onionKey = typeof rec?.onion === "string" ? rec.onion : null;
    const existing = onionKey ? live.get(onionKey) : null;
    if (existing && now() - existing.lastAt < minReannounceSec) return { ok: false, reason: "rate-limited" };
    if (!existing && live.size >= maxEntries) { sweep(); if (live.size >= maxEntries) return { ok: false, reason: "registry-full" }; }

    const v = await verifyAnnounce(rec, {
      now: now(),
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
      expiresAt: now() + ttlSec,
      lastAt: now(),
    });
    return { ok: true, onion: v.onion, staked: v.staked };
  }

  function sweep() {
    const t = now();
    for (const [onion, e] of live) if (e.expiresAt <= t) live.delete(onion);
    nonces.sweep();
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

  return { announce, directory, sweep, record, size: () => live.size, admission, ttlSec };
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
  const registry = makeRegistry({ signer, stake, admission, ttlSec });
  registry.ttlSec = ttlSec;
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
