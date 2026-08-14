// Self-test for envelope/protocol version negotiation (T-FEAT-11).
//
// Drives the PURE negotiation logic on both sides — the gateway's version gate
// (acceptEnvelopeVersion / PROTO_RANGE from gateway/gateway.mjs) and the client's version
// selector (selectProtoVersion / buildEnvelope from client/rgoe-client.mjs) — plus the real
// lib/rln.mjs verifyEnvelope, with NO sockets, NO Tor, NO real proof. Proves:
//
//   - BACKWARD-COMPAT: an envelope with no `v` is treated as v3 and accepted; buildEnvelope's
//     default still emits `v:3` (byte-shape unchanged), and the gateway accepts it
//   - the gateway accepts exactly its inclusive [PROTO_MIN, PROTO_MAX] range
//   - an out-of-range integer version is rejected `unsupported-version:<v>` (distinct reason)
//   - a garbage/non-integer version is rejected `bad-version:<repr>` (distinct reason), BEFORE
//     any mis-parse — and BOTH rejections advertise the gateway's range in `proto`
//   - the version gate is the SOLE version authority: verifyEnvelope never inspects `v`, so an
//     ungated bad version would reach a parser expecting a different shape (why the gate runs first)
//   - a DOWNGRADE cannot strip target binding: an accepted version still flows through
//     verifyEnvelope's independent target-binding check unchanged
//   - the client selects the HIGHEST mutually supported version; disjoint ranges fail closed with
//     a precise `no-mutual-version` reason; and every selected version the gateway then accepts
//
// Run:  node gateway/version-negotiation.selftest.mjs

import assert from "node:assert/strict";
import {
  acceptEnvelopeVersion, PROTO_MIN, PROTO_MAX, PROTO_RANGE,
} from "../gateway/gateway.mjs";
import {
  selectProtoVersion, buildEnvelope, CLIENT_PROTO_MIN, CLIENT_PROTO_MAX,
} from "../client/rgoe-client.mjs";
import {
  verifyEnvelope, currentEpoch, externalNullifierFor, calculateSignalHash, requestSignal,
} from "../lib/rln.mjs";

let failures = 0;
function ok(name) { console.log("  PASS  " + name); }
function bad(name, e) { failures++; console.log("  FAIL  " + name + "  ::  " + (e && e.message || e)); }
async function test(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

// A minimal fake pool + prover so buildEnvelope runs with NO real Groth16 / group load. It only
// needs to return the wire fields; the version test cares about `envelope.v`, not proof validity.
const fakePool = { nextSlot: () => ({ epoch: 1n, slot: 0 }), ensureGroup: async () => ({}) };
const fakeProve = async () => ({
  proof: { snarkProof: { publicSignals: { x: "1", y: "2", externalNullifier: "3", root: "4", nullifier: "5" } } },
  nullifier: "5", externalNullifier: "3", share: { x: "1", y: "2" },
});

console.log("envelope/protocol version negotiation (T-FEAT-11):");

// ---- gateway range constants ------------------------------------------------
await test("gateway range is a sane inclusive interval and {3} today", () => {
  assert.equal(Number.isInteger(PROTO_MIN), true);
  assert.equal(Number.isInteger(PROTO_MAX), true);
  assert.ok(PROTO_MIN <= PROTO_MAX, "min <= max");
  assert.deepEqual(PROTO_RANGE, { min: PROTO_MIN, max: PROTO_MAX });
  assert.equal(PROTO_MIN, 3);
  assert.equal(PROTO_MAX, 3);
});

// ---- gateway version gate: accept / reject ----------------------------------
await test("accepts a version inside the range", () => {
  for (let v = PROTO_MIN; v <= PROTO_MAX; v++) {
    const r = acceptEnvelopeVersion(v);
    assert.equal(r.ok, true, `v=${v}`);
    assert.equal(r.version, v);
  }
});

await test("BACKWARD-COMPAT: absent version (undefined/null) is treated as v3 and accepted", () => {
  for (const absent of [undefined, null]) {
    const r = acceptEnvelopeVersion(absent);
    assert.equal(r.ok, true, `absent=${absent}`);
    assert.equal(r.version, 3, "absent maps to the legacy v3 wire");
  }
});

await test("rejects an out-of-range integer as unsupported-version:<v> and advertises the range", () => {
  for (const v of [0, 1, 2, 4, 5, 99, -1]) {
    if (v >= PROTO_MIN && v <= PROTO_MAX) continue;
    const r = acceptEnvelopeVersion(v);
    assert.equal(r.ok, false, `v=${v}`);
    assert.equal(r.reason, `unsupported-version:${v}`);
    assert.equal(r.label, "unsupported-version");
    assert.deepEqual(r.proto, PROTO_RANGE, "reject carries the gateway's advertised range");
  }
});

await test("rejects a garbage/non-integer version as bad-version:<repr> BEFORE any mis-parse", () => {
  const cases = [
    ["3", 'bad-version:"3"'],
    [3.5, "bad-version:3.5"],
    [NaN, "bad-version:NaN"],
    [true, "bad-version:boolean"],
    [{}, "bad-version:object"],
    [[3], "bad-version:object"],
    ["definitely-not-a-version-way-too-long", 'bad-version:"definitely-not-a"'],
  ];
  for (const [v, reason] of cases) {
    const r = acceptEnvelopeVersion(v);
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason, `repr for ${JSON.stringify(v)}`);
    assert.equal(r.label, "bad-version");
    assert.deepEqual(r.proto, PROTO_RANGE);
  }
});

await test("the two rejection reasons are DISTINCT (unsupported vs bad), never confused", () => {
  assert.notEqual(acceptEnvelopeVersion(4).reason, acceptEnvelopeVersion("4").reason);
  assert.match(acceptEnvelopeVersion(4).reason, /^unsupported-version:/);
  assert.match(acceptEnvelopeVersion("4").reason, /^bad-version:/);
});

// ---- the gate is the SOLE version authority ---------------------------------
await test("verifyEnvelope NEVER inspects `v` — so the gate must run first (else a bad version mis-parses)", async () => {
  // Feed verifyEnvelope an out-of-range version; it fails for an UNRELATED reason (no-proof),
  // proving it does not (and cannot) enforce the version — the gateway's gate is the only guard.
  const r4 = await verifyEnvelope({ v: 4 }, new Set());
  assert.equal(r4.ok, false);
  assert.equal(r4.reason, "no-proof", "verifyEnvelope ignores v; it stops on the missing proof, not the version");
  const rGarbage = await verifyEnvelope({ v: "not-a-version" }, new Set());
  assert.equal(rGarbage.reason, "no-proof", "even a garbage v reaches the proof parser unguarded");
});

await test("handler ordering: an out-of-range version is caught by the gate and verifyEnvelope is never reached", async () => {
  // Mirror the gateway handler's order: gate FIRST, verifyEnvelope only if the gate passes.
  let verifyCalled = false;
  const gatedVerify = async (env) => {
    const vv = acceptEnvelopeVersion(env.v);
    if (!vv.ok) return { ok: false, reason: vv.reason, proto: vv.proto };
    verifyCalled = true;
    return verifyEnvelope(env, new Set());
  };
  const out = await gatedVerify({ v: 9, target: "example.com:443", nonce: "n" });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "unsupported-version:9");
  assert.equal(verifyCalled, false, "verifyEnvelope must NOT run for a rejected version");
});

// ---- downgrade cannot strip target binding ----------------------------------
await test("DOWNGRADE-SAFE: an accepted version still flows through verifyEnvelope's target binding", async () => {
  // Build an envelope whose proof-shape passes the cheap pre-binding checks (fresh
  // externalNullifier, share.x == ps.x) but OMITS the nonce. verifyEnvelope must reject it
  // `unbound-target` regardless of the version value — the binding is independent of `v`, so no
  // (accepted) version choice can skip it.
  const ep = currentEpoch();
  const extNull = externalNullifierFor(ep).toString();
  const x = calculateSignalHash(requestSignal("example.com:443", "the-nonce")).toString();
  const makeEnv = (v) => ({
    v, target: "example.com:443", // nonce intentionally omitted -> unbound-target
    proof: { snarkProof: { publicSignals: { x, y: "0", externalNullifier: extNull, root: "0", nullifier: "0" } } },
    share: { x, y: "0" },
  });
  for (const v of [undefined, 3]) {
    const gate = acceptEnvelopeVersion(makeEnv(v).v);
    assert.equal(gate.ok, true, `gate accepts v=${v}`);
    const r = await verifyEnvelope(makeEnv(v), new Set());
    assert.equal(r.reason, "unbound-target", `binding enforced regardless of v=${v}`);
  }
  // The gate result exposes NO target/binding fields — it decides version only, never binding.
  assert.deepEqual(Object.keys(acceptEnvelopeVersion(3)).sort(), ["ok", "proto", "version"]);
});

// ---- client selection: highest mutually supported ---------------------------
await test("client constants are a sane interval and {3} today", () => {
  assert.ok(CLIENT_PROTO_MIN <= CLIENT_PROTO_MAX);
  assert.equal(CLIENT_PROTO_MIN, 3);
  assert.equal(CLIENT_PROTO_MAX, 3);
});

await test("unknown gateway range => client optimistically sends its own max", () => {
  for (const unknown of [null, undefined, {}, { min: 3 }, { max: 5 }]) {
    const r = selectProtoVersion(unknown);
    assert.equal(r.ok, true);
    assert.equal(r.version, CLIENT_PROTO_MAX);
  }
});

await test("overlapping ranges => the HIGHEST mutually supported version", () => {
  const cases = [
    [{ min: 3, max: 5 }, { min: 4, max: 6 }, 5],
    [{ min: 3, max: 4 }, { min: 3, max: 3 }, 3],
    [{ min: 3, max: 7 }, { min: 5, max: 5 }, 5],
    [{ min: 1, max: 9 }, { min: 3, max: 6 }, 6],
  ];
  for (const [client, gateway, want] of cases) {
    const r = selectProtoVersion(gateway, client);
    assert.equal(r.ok, true, `client ${JSON.stringify(client)} gateway ${JSON.stringify(gateway)}`);
    assert.equal(r.version, want);
  }
});

await test("disjoint ranges => fail closed with a precise no-mutual-version reason", () => {
  const cases = [
    [{ min: 3, max: 3 }, { min: 4, max: 5 }],
    [{ min: 5, max: 6 }, { min: 3, max: 4 }],
    [{ min: 1, max: 2 }, { min: 8, max: 9 }],
  ];
  for (const [client, gateway] of cases) {
    const r = selectProtoVersion(gateway, client);
    assert.equal(r.ok, false);
    assert.match(r.reason, /^no-mutual-version:client=\d+-\d+,gateway=\d+-\d+$/);
  }
});

await test("ROUND-TRIP: every version the client selects for an overlapping range, the gateway accepts", () => {
  // For a grid of gateway ranges that overlap the client, the selected version must be one the
  // gateway then accepts — end-to-end negotiation is self-consistent.
  const client = { min: 1, max: 10 };
  for (let gMin = 1; gMin <= 6; gMin++) {
    for (let gMax = gMin; gMax <= 10; gMax++) {
      const gw = { min: gMin, max: gMax };
      const sel = selectProtoVersion(gw, client);
      assert.equal(sel.ok, true, `overlap ${JSON.stringify(gw)}`);
      const accepted = acceptEnvelopeVersion(sel.version, gw);
      assert.equal(accepted.ok, true, `gateway ${JSON.stringify(gw)} must accept selected v${sel.version}`);
      assert.equal(accepted.version, sel.version);
      assert.equal(sel.version, gMax, "the highest mutual is the gateway's max when client spans it");
    }
  }
});

// ---- buildEnvelope backward-compat + evolution ------------------------------
await test("BACKWARD-COMPAT: buildEnvelope default emits v:3 and the gateway accepts it unchanged", async () => {
  const { envelope } = await buildEnvelope({ secret: "s", target: "example.com:443", pool: fakePool, prove: fakeProve });
  assert.equal(envelope.v, 3, "default wire version is still 3 (byte-shape unchanged)");
  // `v` is the FIRST field so the gate reads it without touching the rest of the envelope.
  assert.equal(Object.keys(envelope)[0], "v");
  assert.equal(acceptEnvelopeVersion(envelope.v).ok, true);
});

await test("EVOLUTION: buildEnvelope honors an explicit negotiated version; a future v is out of range today", async () => {
  const { envelope } = await buildEnvelope({ secret: "s", target: "example.com:443", pool: fakePool, prove: fakeProve, version: 5 });
  assert.equal(envelope.v, 5);
  // A v5 client talking to today's {3} gateway is cleanly rejected — not a silent mis-parse.
  const r = acceptEnvelopeVersion(envelope.v);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unsupported-version:5");
  assert.deepEqual(r.proto, PROTO_RANGE, "the reject tells the client the gateway speaks 3-3");
});

console.log("");
if (failures) {
  console.log(`SELFTEST FAILED: ${failures} failing case(s)`);
  process.exit(1);
}
console.log("SELFTEST PASSED: all cases green");
