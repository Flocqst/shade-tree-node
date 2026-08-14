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
]);

// Recursively find *.selftest.mjs, skipping node_modules / out / build dirs.
function findSelftests(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "out" || name === ".git" || name === "cache") continue;
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

console.log(`\n=== node selftests (${selftests.length}) ===`);
for (const f of selftests) {
  const rel = relative(ROOT, f);
  const r = spawnSync(process.execPath, [f], { cwd: ROOT, encoding: "utf8" });
  const passed = r.status === 0;
  results.push({ name: rel, passed });
  const tail = (r.stdout || "").trim().split("\n").pop() || "";
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${rel}${passed ? "" : "  <-- " + ((r.stderr || tail).trim().split("\n").pop() || "nonzero exit")}`);
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
if (failed.length) { console.log("FAILED:\n" + failed.map((f) => "  - " + f.name).join("\n")); process.exit(1); }
console.log("all green");
