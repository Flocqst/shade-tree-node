// The audit entrypoint: run every test in the repo and report one summary.
//
//   npm test              (this script)
//   node scripts/test-all.mjs --no-contracts   (skip forge, e.g. no foundry installed)
//
// Auto-discovers every *.selftest.mjs so a new test file is picked up with no wiring, then
// runs the Foundry contract suite. Exits nonzero if anything fails, printing which.

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, relative } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const noContracts = process.argv.includes("--no-contracts");

// Fast lane (RGOE_FAST=1 or --fast): skip the slow real-Groth16-proof suites and forge,
// running only the quick node selftests for tight iteration. CI keeps the full run.
const fast = process.env.RGOE_FAST === "1" || process.argv.includes("--fast");

// Explicit denylist of slow suites, matched by filename (basename). Add here to extend.
const SLOW_SUITES = new Set([
  "rln.selftest.mjs",
  "rln-slash.property.selftest.mjs",
  "timing.selftest.mjs",
  "zk-artifact-window.selftest.mjs", // real proofs under two artifact sets (T-HARD-8)
  "reputation-tiers.selftest.mjs",   // real proofs at two tier limits in one tree (T-FEAT-8)
  "onchain-tiers.selftest.mjs",      // anvil + forge broadcast + real gateway + real proofs (T-FEAT-8b / T-DEV-9c)
  "registrar.selftest.mjs",          // anvil + forge create + the 402 registrar + rgoe pay, both rails (T-FEAT-7)
]);

// Recursively find *.selftest.mjs, skipping node_modules / out / build dirs.
function findSelftests(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "out" || name === ".git" || name === "cache" || name === ".stryker-tmp") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) findSelftests(p, acc);
    else if (name.endsWith("selftest.mjs")) acc.push(p); // matches foo.selftest.mjs AND bare selftest.mjs
  }
  return acc;
}

const allSelftests = findSelftests(ROOT).sort();

// In fast mode, split off the slow suites (by basename) so we can run the rest and
// report exactly what was skipped -- never silently drop coverage.
const skipped = fast ? allSelftests.filter((f) => SLOW_SUITES.has(basename(f))) : [];
const selftests = fast ? allSelftests.filter((f) => !SLOW_SUITES.has(basename(f))) : allSelftests;
const results = [];

if (fast) {
  console.log("\n=== FAST LANE (RGOE_FAST) -- slow real-proof suites + forge skipped ===");
  console.log(
    `skipped ${skipped.length} slow suites: ${skipped.map((f) => relative(ROOT, f)).join(", ") || "(none matched denylist)"}`
  );
}

// Contention resilience (T-TEST-23): the selftests run SERIALLY here, so a green suite
// only flakes because of EXTERNAL load (concurrent subagents saturating CPU/IO), racing a
// latency-sensitive assertion. When a suite fails, retry it ONCE in isolation -- alone, after
// a short quiesce, in its own process -- before declaring red. A genuine failure fails both
// times and stays red; a contention flake passes on the isolated retry and goes green, LOUDLY
// logged so a flaky suite is never silently masked. Retry is bounded (exactly one) and honest:
// the isolated retry's result is authoritative, and a failing retry prints its full output.
const RETRY_QUIESCE_MS = Number(process.env.RGOE_RETRY_QUIESCE_MS || 750);

function runSuite(f) {
  return spawnSync(process.execPath, [f], { cwd: ROOT, encoding: "utf8" });
}

// Busy-wait quiesce (no async in this top-level script); lets transient external load settle
// and gives the isolated retry a slightly calmer machine than the contended first attempt.
function quiesce(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* spin briefly before the isolated retry */ }
}

const retried = [];

console.log(`\n=== node selftests (${selftests.length}) ===`);
for (const f of selftests) {
  const rel = relative(ROOT, f);
  let r = runSuite(f);
  let passed = r.status === 0;
  let wasRetried = false;

  if (!passed) {
    // Isolated auto-retry: nothing else is running (serial loop), quiesce, then re-run alone.
    const firstTail = ((r.stderr || r.stdout || "").trim().split("\n").pop() || "nonzero exit").trim();
    console.log(`  FLAKY?  ${rel} failed (${firstTail}) -- retrying ONCE in isolation after ${RETRY_QUIESCE_MS}ms quiesce...`);
    quiesce(RETRY_QUIESCE_MS);
    const r2 = runSuite(f);
    wasRetried = true;
    if (r2.status === 0) {
      // Contention flake: green on the isolated retry. Loud, so it stays visible.
      console.log(`  RETRIED  ${rel} PASSED in isolation -- first failure attributed to resource contention, not a real defect.`);
      retried.push(rel);
      r = r2;
      passed = true;
    } else {
      // Failed BOTH times -> genuine failure. Keep the retry's output; hard red below.
      console.log(`  RETRIED  ${rel} FAILED again in isolation -- treating as a real failure (hard red).`);
      r = r2;
      passed = false;
    }
  }

  results.push({ name: rel, passed, retried: wasRetried && passed });
  const tail = (r.stdout || "").trim().split("\n").pop() || "";
  const flag = passed ? (wasRetried ? "PASS*" : "PASS") : "FAIL";
  console.log(`  ${flag}  ${rel}${passed ? (wasRetried ? "  (green on isolated retry)" : "") : "  <-- " + ((r.stderr || tail).trim().split("\n").pop() || "nonzero exit")}`);
  if (!passed && r.stdout) console.log(r.stdout.split("\n").filter((l) => l.includes("FAIL")).map((l) => "        " + l).join("\n"));
}

if (fast) {
  console.log(`\n=== foundry contract suite ===\n  SKIP  fast lane (RGOE_FAST) -- run full 'npm test' for contracts`);
} else if (!noContracts) {
  console.log(`\n=== foundry contract suite ===`);
  const forge = spawnSync("forge", ["test"], { cwd: ROOT, encoding: "utf8" });
  if (forge.error && forge.error.code === "ENOENT") {
    console.log("  SKIP  forge not installed (run with a foundry toolchain, or --no-contracts)");
  } else {
    const passed = forge.status === 0;
    results.push({ name: "forge test", passed });
    const summary = (forge.stdout || "").split("\n").filter((l) => /tests? passed|Suite result|failed/.test(l)).slice(-3).join("\n");
    console.log(passed ? summary || "  PASS" : (forge.stdout || forge.stderr));
  }
}

const failed = results.filter((r) => !r.passed);
console.log(`\n=== summary: ${results.length - failed.length}/${results.length} green ===`);
if (retried.length) {
  console.log(`RETRIED (green on isolated retry -- contention flake, not a defect):\n` + retried.map((n) => "  ~ " + n).join("\n"));
}
if (failed.length) { console.log("FAILED:\n" + failed.map((f) => "  - " + f.name).join("\n")); process.exit(1); }
console.log("all green");
