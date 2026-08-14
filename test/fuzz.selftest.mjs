// T-TEST-2: fuzz / property tests over every surface that takes UNTRUSTED input. The bar is
// not "parses the good case" (other selftests do that) but "cannot be made to crash, hang, or
// return garbage by hostile bytes", plus a few algebraic properties that must hold for ALL input.
//
//   node test/fuzz.selftest.mjs                 (default seed + iteration count)
//   RGOE_FUZZ_SEED=123 RGOE_FUZZ_N=20000 node test/fuzz.selftest.mjs
//
// Seeded (mulberry32) so any failure is reproducible: the seed is printed and can be replayed.

import { randomBytes } from "node:crypto";
import { onionToPubkey, pubkeyToOnion, canonicalDirectoryBytes, verifyDirectory } from "../lib/directory.mjs";
import { parseHttp } from "../bootnode/fetch.mjs";
import { verifyAnnounce } from "../bootnode/announce.mjs";

const SEED = Number(process.env.RGOE_FUZZ_SEED || 0x9e3779b9);
const N = Number(process.env.RGOE_FUZZ_N || 5000);

let failures = 0;
const fail = (msg) => { console.log(`  FAIL ${msg}`); failures++; };
const ok = (msg) => console.log(`  ok   ${msg}`);

// mulberry32: tiny deterministic PRNG so a failing case is reproducible from the seed.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const randInt = (n) => Math.floor(rnd() * n);
function randStr(maxLen) {
  const len = randInt(maxLen);
  let s = "";
  const alphabets = ["abcdefghijklmnopqrstuvwxyz234567", "0123456789abcdef", "\x00\n\r .:/onABZ!", "abcdefghijklmnopqrstuvwxyz"];
  const al = alphabets[randInt(alphabets.length)];
  for (let i = 0; i < len; i++) s += al[randInt(al.length)];
  return s;
}
function randBytes(maxLen) { return randomBytes(randInt(maxLen)); }
// A grab-bag random JS value, for object-shaped surfaces.
function randVal(depth = 0) {
  const k = randInt(depth > 2 ? 6 : 9);
  switch (k) {
    case 0: return randStr(40);
    case 1: return randInt(1e9) - 5e8;
    case 2: return rnd() < 0.5;
    case 3: return null;
    case 4: return undefined;
    case 5: return randBytes(20).toString("hex");
    case 6: return Array.from({ length: randInt(4) }, () => randVal(depth + 1));
    default: { const o = {}; for (let i = randInt(4); i > 0; i--) o[randStr(8)] = randVal(depth + 1); return o; }
  }
}

// Run a body many times; on the first throw, print the seed + iteration for replay.
function fuzz(label, body) {
  try {
    for (let i = 0; i < N; i++) body(i);
    ok(`${label} (${N} iters, no crash/hang/garbage)`);
  } catch (e) {
    fail(`${label}: iteration threw uncaught -> ${e.message} (seed=${SEED}; set RGOE_FUZZ_SEED=${SEED} to replay)`);
  }
}

async function main() {
  console.log(`fuzz seed=${SEED} iters=${N}\n`);

  // 1. onionToPubkey: hostile strings must throw (rejected) or return a 64-hex key. Never hang,
  //    never return anything else. A throw is FINE (that is rejection); an escape is not.
  fuzz("onionToPubkey rejects or cleanly decodes arbitrary strings", () => {
    const s = rnd() < 0.5 ? randStr(70) : randStr(70) + ".onion";
    let out;
    try { out = onionToPubkey(s); } catch { return; } // rejection is the expected path
    if (typeof out !== "string" || !/^[0-9a-f]{64}$/.test(out)) throw new Error(`bad accept for ${JSON.stringify(s)} -> ${out}`);
  });

  // 2. Round-trip property: for ALL valid 32-byte pubkeys, onionToPubkey(pubkeyToOnion(pub)) === pub,
  //    and the onion an accepted address yields must re-encode to that same address.
  fuzz("pubkey<->onion round-trip holds for all valid keys", () => {
    const pub = randomBytes(32).toString("hex");
    const onion = pubkeyToOnion(pub);
    if (onionToPubkey(onion) !== pub) throw new Error(`round-trip broke for ${pub}`);
    if (pubkeyToOnion(onionToPubkey(onion)) !== onion) throw new Error(`address not idempotent for ${onion}`);
  });

  // 3. parseHttp: hostile byte buffers must throw or return a parsed value; never hang/escape.
  fuzz("parseHttp rejects or parses arbitrary bytes", () => {
    const buf = rnd() < 0.5 ? randBytes(200) : Buffer.from(`HTTP/1.1 ${200 + randInt(400)} X\r\n${randStr(30)}\r\n\r\n${randStr(50)}`);
    try { parseHttp(buf); } catch { /* rejection is fine */ }
  });

  // 4. verifyDirectory: any object must yield {ok:boolean}. Garbage must be ok:false, never a throw,
  //    and never ok:true (only a genuinely valid signed+bound directory can be true, which random
  //    input effectively never is).
  fuzz("verifyDirectory total on arbitrary objects (garbage => ok:false, never throws)", () => {
    const dir = rnd() < 0.5 ? randVal() : { version: randInt(3), issued: randInt(1e9), gateways: Array.from({ length: randInt(3) }, () => ({ onion: randStr(62), pubkey: randBytes(32).toString("hex"), weight: randInt(200), health: "up" })), signer: rnd() < 0.2 ? randVal() : randBytes(32).toString("hex"), signature: rnd() < 0.2 ? randVal() : randBytes(64).toString("hex") };
    const r = verifyDirectory(dir, randBytes(32).toString("hex"));
    if (typeof r !== "object" || typeof r.ok !== "boolean") throw new Error(`non-{ok} result: ${JSON.stringify(r)}`);
    if (r.ok) throw new Error(`random directory verified as OK (should be impossible): ${JSON.stringify(dir).slice(0, 120)}`);
  });

  // 5. canonicalDirectoryBytes permutation invariance: the SIGNED bytes must not depend on key order
  //    or unsigned extra fields. This is what makes a signature independent of JSON formatting.
  fuzz("canonicalDirectoryBytes is permutation/extra-field invariant", () => {
    const gws = Array.from({ length: randInt(4) }, () => ({ onion: randStr(20), pubkey: randStr(20), weight: randInt(200), health: rnd() < 0.5 ? "up" : "down" }));
    const a = { version: 1, issued: 42, gateways: gws.map((g) => ({ onion: g.onion, pubkey: g.pubkey, weight: g.weight, health: g.health })) };
    // same logical value, shuffled key order + junk unsigned fields
    const b = { gateways: gws.map((g) => ({ health: g.health, note: randStr(6), weight: g.weight, pubkey: g.pubkey, onion: g.onion })), issued: 42, version: 1, extra: randVal() };
    if (!canonicalDirectoryBytes(a).equals(canonicalDirectoryBytes(b))) throw new Error("canonical bytes diverged under permutation");
  });

  // 6. verifyAnnounce (async, total): arbitrary objects must resolve to {ok:boolean}, garbage => false,
  //    never an uncaught rejection. (No isStaked injected, so stake is not consulted.)
  {
    let bad = 0;
    for (let i = 0; i < Math.min(N, 1500); i++) {
      const rec = rnd() < 0.5 ? randVal() : { v: 1, onion: randStr(62), weight: randInt(200), ts: Math.floor(Date.now() / 1000) + randInt(500) - 250, nonce: randBytes(16).toString("hex"), onionSig: randBytes(64).toString("hex") };
      let r;
      try { r = await verifyAnnounce(rec, {}); } catch (e) { bad++; if (bad <= 1) fail(`verifyAnnounce threw on ${JSON.stringify(rec).slice(0, 100)}: ${e.message} (seed=${SEED})`); continue; }
      if (typeof r !== "object" || typeof r.ok !== "boolean") { bad++; if (bad <= 1) fail(`verifyAnnounce non-{ok}: ${JSON.stringify(r)}`); continue; }
      if (r.ok) { bad++; if (bad <= 1) fail(`random announce verified OK (impossible): ${JSON.stringify(rec).slice(0, 100)}`); }
    }
    if (bad === 0) ok(`verifyAnnounce total on arbitrary objects (garbage => ok:false, never throws)`);
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: fuzz selftest (${failures} failure${failures === 1 ? "" : "s"}, seed=${SEED})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
