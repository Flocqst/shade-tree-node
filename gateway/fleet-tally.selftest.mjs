// Self-test for the cross-fleet shared spent-nullifier tally (T-FEAT-20 — the T-FEAT-12
// residual). Drives makeSpentSet() with an INJECTED shared tally (gateway/fleet-tally.mjs)
// over an in-process loopback transport, so TWO gateways share a spent-set with NO real
// network. Proves:
//
//   ACCEPTANCE
//   - two gateways sharing the tally: an envelope admitted at gateway A is rejected as
//     replayed-envelope at gateway B once propagated (the fleet-wide replay defense)
//   - a distinct-share OVER-SPEND at the SAME gateway still reconstructs + slashes EXACTLY
//     once with the tally wired in (the local slash path is untouched)
//
//   PRIVACY
//   - ONLY (nullifier, epoch) crosses the transport: never share.y, share.x, target, or
//     member identity (asserted against a recording transport)
//
//   DEGRADATION / SEMANTICS
//   - a DISTRIBUTED over-spend (two shares on two gateways) is rejected fleet-wide but NOT
//     slashed on the second gateway (it lacks share.y — the documented privacy trade)
//   - fail-OPEN: a throwing transport degrades to the per-gateway defense, never denies
//   - bounded + epoch-scoped: old epoch buckets prune; a per-epoch flood cap holds
//
//   DEFAULT UNCHANGED
//   - makeSpentSet with sharedTally:null (and with no arg at all) is byte-identical to the
//     T-FEAT-12 first/replay/slash sequence — the feature is OFF by default
//   - makeConfiguredFleetTally() returns null unless a transport is wired
//
// Run:  node gateway/fleet-tally.selftest.mjs

import assert from "node:assert/strict";
import { makeSpentSet } from "../gateway/gateway.mjs";
import { makeLoopbackTransport, makeFleetTally, makeConfiguredFleetTally } from "../gateway/fleet-tally.mjs";

let failures = 0;
function ok(name) { console.log("  PASS  " + name); }
function bad(name, e) { failures++; console.log("  FAIL  " + name + "  ::  " + (e && e.message || e)); }
async function test(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

function makeClock(t = 1_000_000) {
  const c = { t };
  return { now: () => c.t, advance: (ms) => { c.t += ms; }, set: (v) => { c.t = v; } };
}

// A transport that records EVERY publish() call's arguments, wrapping an inner transport so
// the fan-out still works. Lets us prove exactly what data crosses the wire.
function makeRecordingTransport(inner) {
  const published = [];
  return {
    published,
    publish(...args) { published.push(args); return inner.publish(...args); },
    subscribe(cb) { return inner.subscribe(cb); },
  };
}

const WINDOW = 1000;
const MOCKS = { reconstruct: () => "S", derive: () => "C", replayWindowMs: WINDOW };

console.log("gateway cross-fleet shared nonce tally (T-FEAT-20):");

// ---- ACCEPTANCE 1: two gateways, replay to B is rejected once propagated -----
await test("two gateways sharing the tally: admit at A => replayed-envelope at B (fleet-wide)", async () => {
  const clk = makeClock();
  const transport = makeLoopbackTransport();
  const tallyA = makeFleetTally({ transport, now: clk.now });
  const tallyB = makeFleetTally({ transport, now: clk.now });
  const A = makeSpentSet({ ...MOCKS, slash: async () => {}, sharedTally: tallyA, now: clk.now });
  const B = makeSpentSet({ ...MOCKS, slash: async () => {}, sharedTally: tallyB, now: clk.now });

  // Gateway A admits the envelope first (fresh nullifier this epoch).
  const rA = await A.admit("nullN", { x: "xA", y: "yA" }, { nonce: "n1", epoch: "E1" });
  assert.equal(rA.action, "first");
  assert.equal(rA.ok, true);

  // The loopback propagated (nullifier, epoch) to B's tally synchronously.
  assert.equal(tallyB.size(), 1, "B's tally learned the nullifier via the transport");

  // The SAME envelope, fanned to gateway B, is now an exact fleet-wide replay.
  const rB = await B.admit("nullN", { x: "xA", y: "yA" }, { nonce: "n1", epoch: "E1" });
  assert.equal(rB.ok, false, "a captured envelope replayed to a peer gateway must be rejected");
  assert.equal(rB.action, "replayed-envelope");
  assert.equal(rB.reason, "replayed-envelope");
  assert.equal(rB.scope, "fleet", "rejected by the shared fleet tally, not the local cache");

  // A DIFFERENT nullifier at B is unaffected (fresh request => first).
  const rB2 = await B.admit("nullOther", { x: "xZ", y: "yZ" }, { nonce: "n9", epoch: "E1" });
  assert.equal(rB2.action, "first");
  assert.equal(rB2.ok, true);
});

// ---- ACCEPTANCE 2: distinct-share over-spend at ONE gateway still slashes -----
await test("distinct-share over-spend at the SAME gateway still slashes exactly once (tally wired)", async () => {
  const clk = makeClock();
  const transport = makeLoopbackTransport();
  const tally = makeFleetTally({ transport, now: clk.now });
  const slashes = [];
  const A = makeSpentSet({
    reconstruct: (a, b) => "SECRET(" + a.y + "|" + b.y + ")",
    derive: (secret) => "COMMIT(" + secret + ")",
    slash: async (commitment, secret) => slashes.push({ commitment, secret }),
    sharedTally: tally, replayWindowMs: WINDOW, now: clk.now,
  });
  await A.admit("nullM", { x: "xA", y: "yA" }, { nonce: "n1", epoch: "E1" });        // first (recorded to tally)
  const r = await A.admit("nullM", { x: "xB", y: "yB" }, { nonce: "n2", epoch: "E1" }); // 2nd DISTINCT share => over-spend
  assert.equal(r.action, "slash", "the local slash path is not short-circuited by the tally");
  assert.equal(r.ok, false);
  assert.equal(slashes.length, 1, "slash exactly once");
  assert.equal(slashes[0].commitment, "COMMIT(SECRET(yA|yB))");
  assert.equal(slashes[0].secret, "SECRET(yA|yB)");
});

// ---- PRIVACY: only (nullifier, epoch) crosses the transport ------------------
await test("privacy: ONLY (nullifier, epoch) crosses the tally — never share.y, share.x, target, member", async () => {
  const clk = makeClock();
  const rec = makeRecordingTransport(makeLoopbackTransport());
  const tally = makeFleetTally({ transport: rec, now: clk.now });
  const A = makeSpentSet({ ...MOCKS, slash: async () => {}, sharedTally: tally, now: clk.now });

  const SHARE = { x: "SECRET_X", y: "SECRET_Y" };
  const TARGET = "example.com:443";
  await A.admit("nullP", SHARE, { nonce: "n1", epoch: "E7", target: TARGET });

  assert.equal(rec.published.length, 1, "exactly one publish for one admit");
  const args = rec.published[0];
  assert.equal(args.length, 2, "publish carries EXACTLY two positional args (nullifier, epoch)");
  assert.equal(args[0], "nullP", "arg 0 is the nullifier");
  assert.equal(args[1], "E7", "arg 1 is the epoch scope");
  // Nothing sensitive is anywhere in what crossed the wire.
  const wire = JSON.stringify(args);
  assert.ok(!wire.includes("SECRET_Y"), "share.y must NEVER cross the tally (it reconstructs the identity secret)");
  assert.ok(!wire.includes("SECRET_X"), "share.x does not cross the tally");
  assert.ok(!wire.includes(TARGET), "the egress target does not cross the tally");
});

// ---- DEGRADATION: distributed over-spend rejected fleet-wide, NOT slashed -----
await test("distributed over-spend (two shares on two gateways): rejected on B, NOT slashed (no share.y crosses)", async () => {
  const clk = makeClock();
  const transport = makeLoopbackTransport();
  const tallyA = makeFleetTally({ transport, now: clk.now });
  const tallyB = makeFleetTally({ transport, now: clk.now });
  const slashesB = [];
  const A = makeSpentSet({ ...MOCKS, slash: async () => {}, sharedTally: tallyA, now: clk.now });
  const B = makeSpentSet({
    reconstruct: () => "S", derive: () => "C",
    slash: async (...a) => slashesB.push(a),
    sharedTally: tallyB, replayWindowMs: WINDOW, now: clk.now,
  });
  await A.admit("nullQ", { x: "xA", y: "yA" }, { nonce: "n1", epoch: "E1" });          // A holds share A
  const rB = await B.admit("nullQ", { x: "xB", y: "yB" }, { nonce: "n2", epoch: "E1" }); // distinct share to B
  assert.equal(rB.ok, false, "B sees the nullifier already spent => reject");
  assert.equal(rB.action, "replayed-envelope");
  assert.equal(rB.scope, "fleet");
  assert.equal(slashesB.length, 0, "B cannot slash — it never received share.y (the documented trade)");
});

// ---- FAIL-OPEN: a throwing transport degrades to the per-gateway defense ------
await test("fail-open: a throwing transport degrades to per-gateway defense, never denies", async () => {
  const clk = makeClock();
  const throwing = {
    publish() { throw new Error("network down"); },
    subscribe() { return { unsubscribe() {} }; },
    // has() lives on the tally, but its buckets read never sees a peer entry; still, make the
    // tally's own has() robust by having subscribe deliver nothing.
  };
  const tally = makeFleetTally({ transport: throwing, now: clk.now });
  const A = makeSpentSet({ ...MOCKS, slash: async () => {}, sharedTally: tally, now: clk.now });
  // record() will hit the throwing publish, but must be swallowed and STILL admit.
  const r = await A.admit("nullR", { x: "xA", y: "yA" }, { nonce: "n1", epoch: "E1" });
  assert.equal(r.action, "first", "admission proceeds despite the transport throwing");
  assert.equal(r.ok, true);
  // The per-gateway T-FEAT-12 cache still works locally after the degrade.
  clk.advance(WINDOW + 1);
  const r2 = await A.admit("nullR", { x: "xA", y: "yA" }, { nonce: "n1", epoch: "E1" });
  assert.equal(r2.action, "replayed-envelope", "local replay defense still holds when the tally is down");
});

// ---- BOUNDED + EPOCH-SCOPED --------------------------------------------------
await test("bounded + epoch-scoped: old epoch buckets prune past ttlMs", async () => {
  const clk = makeClock();
  const transport = makeLoopbackTransport();
  const tally = makeFleetTally({ transport, ttlMs: 10_000, now: clk.now });
  tally.record("nullOld", "E1");
  assert.equal(tally.size(), 1);
  clk.advance(10_001);
  tally.prune();
  assert.equal(tally.size(), 0, "the aged epoch bucket is pruned");
  // A nullifier in a fresh epoch is tracked independently.
  tally.record("nullNew", "E2");
  assert.equal(tally.size(), 1);
});

await test("bounded: a per-epoch flood cap stops unbounded growth (fail-open, no crash)", async () => {
  const clk = makeClock();
  const transport = makeLoopbackTransport();
  const tally = makeFleetTally({ transport, maxPerEpoch: 3, now: clk.now });
  for (let i = 0; i < 10; i++) tally.record("null#" + i, "E1");
  assert.equal(tally.size(), 3, "the bucket is capped at maxPerEpoch");
  // has() for a capped-out (never-recorded) nullifier is false => fail-open (admit locally).
  assert.equal(tally.has("null#9", "E1"), false);
});

// ---- DEFAULT UNCHANGED: sharedTally:null is byte-identical to T-FEAT-12 -------
await test("default OFF: sharedTally:null and no-arg produce the identical T-FEAT-12 sequence", async () => {
  const clk1 = makeClock();
  const clk2 = makeClock();
  const withNull = makeSpentSet({ ...MOCKS, slash: async () => {}, sharedTally: null, now: clk1.now });
  const withOut = makeSpentSet({ ...MOCKS, slash: async () => {}, now: clk2.now });
  const seq = [
    ["nullX", { x: "xA", y: "yA" }, { nonce: "n1", epoch: "E1" }],  // first
    ["nullX", { x: "xA", y: "yA" }, { nonce: "n1", epoch: "E1" }],  // replay (within window)
    ["nullX", { x: "xB", y: "yB" }, { nonce: "n2", epoch: "E1" }],  // distinct share => slash
  ];
  for (const [n, s, o] of seq) {
    const a = await withNull.admit(n, s, o);
    const b = await withOut.admit(n, s, o);
    assert.deepEqual(
      { ok: a.ok, action: a.action, reason: a.reason },
      { ok: b.ok, action: b.action, reason: b.reason },
      `null-tally vs no-arg diverged on ${JSON.stringify(o)}`,
    );
  }
});

await test("makeConfiguredFleetTally() returns null unless a transport is wired (OFF by default)", async () => {
  assert.equal(makeConfiguredFleetTally({ env: {} }), null, "no env, no transport => null");
  assert.equal(makeConfiguredFleetTally({ env: { SHADE_TREE_FLEET_TALLY: "1" } }), null, "flag set but no bundled transport => still null (fail-open)");
  const t = makeConfiguredFleetTally({ transport: makeLoopbackTransport() });
  assert.ok(t && typeof t.has === "function" && typeof t.record === "function", "an injected transport yields a live tally");
  t.close();
});

// ---- loopback transport shape ------------------------------------------------
await test("loopback transport fans one publish to every subscriber; unsubscribe stops delivery", async () => {
  const transport = makeLoopbackTransport();
  const a = [];
  const b = [];
  const subA = transport.subscribe((n, e) => a.push([n, e]));
  transport.subscribe((n, e) => b.push([n, e]));
  transport.publish("nn", "ee");
  assert.deepEqual(a, [["nn", "ee"]]);
  assert.deepEqual(b, [["nn", "ee"]]);
  subA.unsubscribe();
  transport.publish("mm", "ff");
  assert.deepEqual(a, [["nn", "ee"]], "unsubscribed callback receives nothing further");
  assert.deepEqual(b, [["nn", "ee"], ["mm", "ff"]]);
});

console.log("");
if (failures) {
  console.log(`SELFTEST FAILED: ${failures} failing case(s)`);
  process.exit(1);
}
console.log("SELFTEST PASSED: all cases green");
