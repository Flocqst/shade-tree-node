// Live experiment harness for the Shade Tree.
//
// Sends envelopes to the LIVE gateway onion over the client Tor SOCKS and records
// the gateway's verdict. Runs one phase per invocation and merges its slice into
// experiments/results.json (consumed by the dashboard).
//
//   SHADE_TREE_ONION=<onion> node experiments/run.mjs multi
//   SHADE_TREE_ONION=<onion> node experiments/run.mjs bad
//   SHADE_TREE_ONION=<onion> node experiments/run.mjs ratelimit <who> <count>
//   SHADE_TREE_ONION=<onion> node experiments/run.mjs spam <count> <concurrency>
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SocksClient } from "socks";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof } from "@semaphore-protocol/proof";
import { proveMembership, currentEpoch } from "../lib/semaphore.mjs";
import { randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ONION = (process.env.SHADE_TREE_ONION || "").replace(/\.onion$/, "");
const TOR_PORT = Number(process.env.SHADE_TREE_TOR_PORT || 9260);
const TARGET = "api.ipify.org:443";
const RESULTS = join(HERE, "results.json");
if (!ONION) { console.error("set SHADE_TREE_ONION"); process.exit(1); }

const keys = JSON.parse(await readFile(join(ROOT, "keys.local.json"), "utf8"));
const scope = currentEpoch();

function sendEnvelopeOnce(envelope, timeout = 70000) {
  return new Promise(async (resolve) => {
    const t0 = Date.now();
    let socket;
    try {
      ({ socket } = await SocksClient.createConnection({
        proxy: { host: "127.0.0.1", port: TOR_PORT, type: 5 },
        command: "connect", destination: { host: ONION + ".onion", port: 80 }, timeout,
      }));
    } catch (e) { return resolve({ ok: false, err: "socks:" + e.message, ms: Date.now() - t0 }); }
    let buf = "";
    const done = (r) => { try { socket.destroy(); } catch {} resolve({ ...r, ms: Date.now() - t0 }); };
    const timer = setTimeout(() => done({ ok: false, err: "timeout" }), timeout);
    socket.write(JSON.stringify(envelope) + "\n");
    socket.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) { clearTimeout(timer); let r; try { r = JSON.parse(buf.slice(0, nl)); } catch { r = { ok: false, err: "badreply" }; } done(r); }
    });
    socket.on("error", (e) => { clearTimeout(timer); done({ ok: false, err: "sock:" + e.message }); });
  });
}

// Retry only on onion cold-start failures (descriptor/rendezvous not warmed yet),
// the same way the shim does. A real gateway DROP reply is returned immediately.
async function sendEnvelope(envelope, timeout = 70000, attempts = 5) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await sendEnvelopeOnce(envelope, timeout);
    if (!/^socks:|^timeout$/.test(last.err || "")) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

async function merge(phase, data) {
  let all = {};
  try { all = JSON.parse(await readFile(RESULTS, "utf8")); } catch {}
  all[phase] = { scope: scope.toString(), at: Date.now(), ...data };
  await writeFile(RESULTS, JSON.stringify(all, null, 2));
  console.log(`\n[${phase}] merged into results.json`);
}

const phase = process.argv[2] || "multi";

if (phase === "multi") {
  // H1: several distinct members each egress, each with its own nullifier.
  const who = keys.slice(0, 5);
  const rows = [];
  for (const k of who) {
    const proof = await proveMembership(k.secret, scope);
    const r = await sendEnvelope({ v: 1, target: TARGET, proof });
    rows.push({ member: k.label, ok: r.ok, err: r.err || null, nullifier: String(proof.nullifier), ms: r.ms });
    console.log(`  ${k.label.padEnd(6)} ok=${r.ok} ${r.err || ""} null=${String(proof.nullifier).slice(0, 12)}.. ${r.ms}ms`);
  }
  const nulls = new Set(rows.map((r) => r.nullifier));
  await merge("multi", { rows, distinct_nullifiers: nulls.size, all_pass: rows.every((r) => r.ok) });
}

else if (phase === "bad") {
  // H2: every flavor of bad proof is rejected, with a clear reason.
  const rows = [];
  // no proof at all
  rows.push({ case: "no-proof", ...(await sendEnvelope({ v: 1, target: TARGET, proof: null })) });
  // structurally bogus proof
  const garbage = { merkleTreeRoot: "123", nullifier: "1", scope: String(scope), message: "1", merkleTreeDepth: 1, points: Array(8).fill("1") };
  rows.push({ case: "garbage", ...(await sendEnvelope({ v: 1, target: TARGET, proof: garbage })) });
  // a VALID proof, but against a group the attacker invented
  const attacker = new Identity("attacker-not-enrolled-" + randomBytes(4).toString("hex"));
  const fakeGroup = new Group([attacker.commitment]);
  const forged = await generateProof(attacker, fakeGroup, 1n, scope);
  rows.push({ case: "wrong-group", forged_root: String(forged.merkleTreeRoot).slice(0, 16) + "..", ...(await sendEnvelope({ v: 1, target: TARGET, proof: forged })) });
  // a non-member can't even build a proof (no leaf in the real tree)
  let nonmember;
  try {
    const p = await proveMembership(randomBytes(32).toString("hex"), scope);
    nonmember = { case: "non-member", ok: false, err: "UNEXPECTED: built a proof", clientReject: false };
  } catch (e) {
    nonmember = { case: "non-member", ok: false, err: e.message.slice(0, 60), clientReject: true };
  }
  rows.push(nonmember);
  for (const r of rows) console.log(`  ${String(r.case).padEnd(12)} ok=${r.ok} ${r.err || ""}`);
  await merge("bad", { rows, all_rejected: rows.every((r) => !r.ok) });
}

else if (phase === "ratelimit") {
  // H3: one member past its per-epoch budget gets throttled (set a low budget on the box first).
  const who = process.argv[3] || "heidi";
  const count = Number(process.argv[4] || 8);
  const k = keys.find((x) => x.label === who);
  const proof = await proveMembership(k.secret, scope); // same nullifier reused, as the shim does
  const rows = [];
  for (let i = 0; i < count; i++) {
    const r = await sendEnvelope({ v: 1, target: TARGET, proof });
    rows.push({ i: i + 1, ok: r.ok, err: r.err || null, ms: r.ms });
    console.log(`  req ${i + 1}/${count}  ok=${r.ok} ${r.err || ""}`);
  }
  const passed = rows.filter((r) => r.ok).length;
  const throttled = rows.filter((r) => /rate/i.test(r.err || "")).length;
  await merge("ratelimit", { member: who, nullifier: String(proof.nullifier), count, passed, throttled, rows });
}

else if (phase === "spam") {
  // H4: flood the node with junk, then prove a real member still gets in (no IP ban).
  const count = Number(process.argv[3] || 25);
  const conc = Number(process.argv[4] || 8);
  const garbage = { merkleTreeRoot: "123", nullifier: "1", scope: String(scope), message: "1", merkleTreeDepth: 1, points: Array(8).fill("1") };
  const t0 = Date.now();
  const results = [];
  let idx = 0;
  async function worker() { while (idx < count) { const my = idx++; results[my] = await sendEnvelope({ v: 1, target: TARGET, proof: garbage }, 40000); } }
  await Promise.all(Array.from({ length: conc }, worker));
  const elapsed = Date.now() - t0;
  const rejected = results.filter((r) => r && !r.ok).length;
  const leaked = results.filter((r) => r && r.ok).length;
  // after the flood, a real member must still get in immediately
  const k = keys.find((x) => x.label === "grace");
  const proof = await proveMembership(k.secret, scope);
  const after = await sendEnvelope({ v: 1, target: TARGET, proof });
  console.log(`  flooded ${count} junk envelopes (conc ${conc}) in ${elapsed}ms: ${rejected} rejected, ${leaked} leaked`);
  console.log(`  real member after flood: ok=${after.ok} ${after.err || ""} (${after.ms}ms)`);
  await merge("spam", { count, concurrency: conc, elapsed_ms: elapsed, rejected, leaked, real_member_after: { ok: after.ok, err: after.err || null, ms: after.ms } });
}

process.exit(0);
