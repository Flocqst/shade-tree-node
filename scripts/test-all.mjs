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
import { dirname, join, relative } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const noContracts = process.argv.includes("--no-contracts");

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

const selftests = findSelftests(ROOT).sort();
const results = [];

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

if (!noContracts) {
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
