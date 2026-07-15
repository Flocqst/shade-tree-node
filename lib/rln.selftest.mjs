// Self-test for lib/rln.mjs. Run: `node lib/rln.selftest.mjs`
// Asserts the crypto invariants the demo's correctness rests on. No chain, no network.

import {
  FIELD,
  K_SLOTS,
  currentEpoch,
  slotScope,
  requestSignal,
  shareFor,
  slotNullifier,
  reconstructSecret,
  deriveCommitment,
  identityFor,
  proveForSlot,
  verifyEnvelope,
  validSlotFor,
  toField,
  Group,
} from "./rln.mjs";

let pass = 0;
const fail = [];
function ok(name, cond) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail.push(name); console.log("FAIL  " + name); }
}

const epoch = currentEpoch();
// a canonical field-element secret
const secret = toField("0x" + "b96d0584614e2d620d19601d278b93278bf0a2479d2bf0ab2d5ec3ae36960f53");

// 1. slot scopes are distinct across slots in an epoch.
{
  const scopes = Array.from({ length: K_SLOTS }, (_, i) => slotScope(epoch, i).toString());
  const distinct = new Set(scopes).size === K_SLOTS;
  ok("slot scopes distinct within epoch", distinct);
  // and each maps back to its own slot index
  ok("validSlotFor round-trips slot index", scopes.every((s, i) => validSlotFor(s) === i));
}

// 2. K distinct nullifiers per epoch for one member.
{
  const nulls = Array.from({ length: K_SLOTS }, (_, i) =>
    slotNullifier(secret, slotScope(epoch, i))
  );
  ok("K distinct nullifiers per epoch", new Set(nulls).size === K_SLOTS);
}

// 3. two shares from the SAME (secret, scope) at DIFFERENT x reconstruct the secret.
{
  const scope = slotScope(epoch, 3);
  const xA = requestSignal("example.com:443", "req-A");
  const xB = requestSignal("example.com:443", "req-B");
  ok("distinct requests => distinct evaluation points", xA.toString() !== xB.toString());
  const sA = shareFor(secret, scope, xA);
  const sB = shareFor(secret, scope, xB);
  const rec = reconstructSecret(sA, sB);
  ok("two shares reconstruct the secret", rec === secret.toString());
  // reconstructed secret derives the same commitment => slashes the right leaf
  ok("reconstruct -> deriveCommitment matches", deriveCommitment(rec) === deriveCommitment(secret));
}

// 4. a single share (or a retry = same x) does NOT reveal the secret.
{
  const scope = slotScope(epoch, 3);
  const x = requestSignal("example.com:443", "req-A");
  const s1 = shareFor(secret, scope, x);
  // one point: infinitely many lines through it => cannot pin a0. Model "a single share":
  // the only info is (x, y); without a second distinct x there is nothing to interpolate.
  ok("single share is just one point", s1.x != null && s1.y != null);
  // a retry reuses the SAME signal => identical share => reconstruct must refuse (same x).
  const retry = shareFor(secret, scope, x);
  ok("retry reproduces identical share (no new info)", retry.x === s1.x && retry.y === s1.y);
  let threw = false;
  try { reconstructSecret(s1, retry); } catch { threw = true; }
  ok("identical-x shares cannot reconstruct", threw);
}

// 5. deriveCommitment is deterministic (and each documented scheme is stable).
{
  ok("deriveCommitment deterministic (default)", deriveCommitment(secret) === deriveCommitment(secret));
  for (const scheme of ["poseidon", "keccak", "identity"]) {
    ok(`deriveCommitment deterministic (${scheme})`,
      deriveCommitment(secret, scheme) === deriveCommitment(secret, scheme));
  }
  // schemes actually differ (guards against a silent fallthrough)
  const a = deriveCommitment(secret, "poseidon");
  const b = deriveCommitment(secret, "keccak");
  const c = deriveCommitment(secret, "identity");
  ok("commitment schemes are distinct values", new Set([a, b, c]).size === 3);
}

// 6. end-to-end: proveForSlot -> verifyEnvelope against a group containing the member.
//    Exercises the REAL Semaphore proof path + the cheap-check ordering.
{
  const id = identityFor(secret);
  const group = new Group([id.commitment, 111n, 222n]); // member + two others
  const i = 2;
  const signal = requestSignal("example.com:443", "req-e2e");
  const p = await proveForSlot(secret, epoch, i, signal, { group });
  ok("proveForSlot returns a slot proof", p && p.proof && p.slot === i);
  ok("nullifier matches slotNullifier", p.nullifier === slotNullifier(secret, slotScope(epoch, i)));

  const env = {
    v: 2,
    target: "example.com:443",
    slot: i,
    proof: p.proof,
    nullifier: p.nullifier,
    scope: p.scope,
    share: p.share,
  };
  const recentRoots = [group.root.toString()];
  const res = await verifyEnvelope(env, recentRoots);
  ok("verifyEnvelope accepts a good envelope", res.ok === true);
  ok("verifyEnvelope reports the slot", res.slot === i);

  // tamper: wrong root => cheap reject before SNARK
  const bad = await verifyEnvelope(env, ["999"]);
  ok("verifyEnvelope rejects wrong root", bad.ok === false && bad.reason === "wrong-group-root");

  // tamper: share.x != proof.message => signal-mismatch
  const env2 = { ...env, share: { x: "1234", y: p.share.y } };
  const bad2 = await verifyEnvelope(env2, recentRoots);
  ok("verifyEnvelope rejects signal mismatch", bad2.ok === false && bad2.reason === "signal-mismatch");

  // tamper: scope not a valid slot => bad-scope
  const env3 = { ...env, scope: "42" };
  const bad3 = await verifyEnvelope(env3, recentRoots);
  ok("verifyEnvelope rejects bad scope", bad3.ok === false && bad3.reason === "bad-scope");
}

// 7. field sanity
ok("FIELD is the BN254 scalar prime", FIELD % 2n === 1n && FIELD > 2n ** 253n);

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error("FAILURES:", fail); process.exit(1); }
