// Self-test for lib/subkeys.mjs — deterministic member subkeys (T-FEAT-5). Pure/crypto only:
// no chain, no network, no Groth16 (HMAC + field reduction + Poseidon leaf). Asserts the
// derivation is deterministic, unlinkable-by-derivation, field-valid, RLN-composable,
// master-isolated, and cross-run stable (a pinned golden vector).
//
//   node lib/subkeys.selftest.mjs

import {
  FIELD,
  identityFor,
  rateCommitmentOf,
} from "./rln.mjs";
import { deriveSubSecret, deriveIdentity } from "./subkeys.mjs";

let pass = 0;
const fail = [];
const ok = (name, cond) => {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail.push(name); console.log("FAIL  " + name); }
};

function main() {
  // A canonical master secret (same seed the rln selftest uses as a member secret) — here it
  // is the MASTER from which personas are derived.
  const master = "b96d0584614e2d620d19601d278b93278bf0a2479d2bf0ab2d5ec3ae36960f53";

  // ---- 1. DETERMINISM ------------------------------------------------------
  console.log("determinism:");
  const s1 = deriveSubSecret(master, "egress", 0);
  const s2 = deriveSubSecret(master, "egress", 0);
  ok("same (master,context,index) => identical secret", s1 === s2);
  const d1 = deriveIdentity(master, "egress", 0);
  const d2 = deriveIdentity(master, "egress", 0);
  ok("same (master,context,index) => identical secret via deriveIdentity", d1.secret === d2.secret);
  ok("same (master,context,index) => identical commitment", d1.commitment === d2.commitment);
  ok("deriveSubSecret and deriveIdentity agree on the secret", s1 === d1.secret);
  ok("index defaults to 0", deriveSubSecret(master, "egress") === s1);

  // ---- 2. UNLINKABILITY BY DERIVATION --------------------------------------
  // Different context OR different index => different secret AND different commitment, with
  // no collisions across a range of both.
  console.log("\nunlinkability-by-derivation:");
  const secrets = new Set();
  const commitments = new Set();
  const contexts = ["egress", "rotation-2026Q3", "persona-b", "audit", ""];
  let n = 0;
  for (const ctx of contexts) {
    for (let idx = 0; idx < 16; idx++) {
      const d = deriveIdentity(master, ctx, idx);
      secrets.add(d.secret);
      commitments.add(d.commitment);
      n++;
    }
  }
  ok(`no secret collisions across ${n} (context,index) pairs`, secrets.size === n);
  ok(`no commitment collisions across ${n} (context,index) pairs`, commitments.size === n);
  ok("different index => different secret", deriveSubSecret(master, "egress", 0) !== deriveSubSecret(master, "egress", 1));
  ok("different index => different commitment",
    deriveIdentity(master, "egress", 0).commitment !== deriveIdentity(master, "egress", 1).commitment);
  ok("different context => different secret", deriveSubSecret(master, "egress", 0) !== deriveSubSecret(master, "audit", 0));
  ok("different context => different commitment",
    deriveIdentity(master, "egress", 0).commitment !== deriveIdentity(master, "audit", 0).commitment);

  // ---- 3. VALID FIELD ELEMENT ----------------------------------------------
  // Every derived secret is a decimal string in [1, FIELD).
  console.log("\nvalid field element:");
  let allInRange = true;
  for (const s of secrets) {
    const v = BigInt(s);
    if (!(/^[0-9]+$/.test(s) && v >= 1n && v < FIELD)) { allInRange = false; break; }
  }
  ok(`every derived secret is a decimal string in [1, FIELD) (${secrets.size} checked)`, allInRange);

  // ---- 4. COMPOSES WITH RLN ------------------------------------------------
  // deriveIdentity's commitment == rateCommitmentOf(identityFor(secret)) for its own secret,
  // so the subkey is a real, registerable RLN identity (a normal depth-20 tree leaf).
  console.log("\ncomposes with RLN:");
  const d = deriveIdentity(master, "egress", 7);
  ok("commitment == rateCommitmentOf(identityFor(secret))",
    d.commitment === rateCommitmentOf(identityFor(d.secret)).toString());
  ok("deriveIdentity.identity matches identityFor(secret)",
    d.identity.commitment.toString() === identityFor(d.secret).commitment.toString());

  // ---- 5. MASTER ISOLATION -------------------------------------------------
  // A different master (even one flipped byte) yields entirely different subkeys — no secret
  // leaks from one master to another.
  console.log("\nmaster isolation:");
  // flip the last byte: ...0f53 -> ...0f52
  const master2 = "b96d0584614e2d620d19601d278b93278bf0a2479d2bf0ab2d5ec3ae36960f52";
  ok("one-byte-different master => different secret", deriveSubSecret(master2, "egress", 0) !== s1);
  ok("one-byte-different master => different commitment",
    deriveIdentity(master2, "egress", 0).commitment !== d1.commitment);
  const masterC = "00" + master.slice(2); // change a high byte
  ok("high-byte-different master => different secret", deriveSubSecret(masterC, "egress", 0) !== s1);
  // no cross-master collisions across a context/index range
  const crossA = new Set(), crossB = new Set();
  for (let idx = 0; idx < 8; idx++) {
    crossA.add(deriveSubSecret(master, "egress", idx));
    crossB.add(deriveSubSecret(master2, "egress", idx));
  }
  let disjoint = true;
  for (const s of crossA) if (crossB.has(s)) disjoint = false;
  ok("no subkey collisions between two masters over an index range", disjoint);

  // ---- 6. CROSS-RUN STABILITY (GOLDEN VECTOR) ------------------------------
  // Pin ONE fully-worked vector so any future change to the derivation is caught. If this
  // fails, the derivation (or a dependency's Poseidon/rate-commitment math) changed — every
  // previously-derived on-chain leaf just moved. Treat as a compat break, not a test to bump.
  console.log("\ncross-run stability (golden vector):");
  //   master  = b96d0584614e2d620d19601d278b93278bf0a2479d2bf0ab2d5ec3ae36960f53
  //   context = "egress"
  //   index   = 0
  const GOLDEN_SECRET =
    "7868783973619995873911899641335400987268755161973011444265637074941608784397";
  const GOLDEN_COMMITMENT =
    "650852481588743495874623128839796746323766269368697313873197005888715206616";
  const g = deriveIdentity(master, "egress", 0);
  ok("golden secret matches pinned vector", g.secret === GOLDEN_SECRET);
  ok("golden commitment matches pinned vector", g.commitment === GOLDEN_COMMITMENT);

  console.log(`\n${pass} passed, ${fail.length} failed`);
  console.log(`\n${fail.length === 0 ? "PASS" : "FAIL"}: subkeys selftest (${fail.length} failure${fail.length === 1 ? "" : "s"})`);
  if (fail.length) { console.error("FAILURES:", fail); process.exit(1); }
  process.exit(0);
}

main();
