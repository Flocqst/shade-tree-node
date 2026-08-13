// Offline proof that the rgoe CLI router (bin/rgoe.mjs) behaves. It SPAWNS the real CLI as a
// child (node:child_process) for every case — no importing internals — so it exercises exactly
// what a user gets on the command line: help/version/unknown-command exit codes and output, the
// doctor health check, and the flag plumbing that maps clean --flags onto the RGOE_* env the
// underlying modules read. The one live command it runs is `keygen`, which is fast and offline;
// it never launches a long-running service (bootnode/gateway/client) — those are --help only.
//
//   node bin/rgoe.selftest.mjs
//
// Exit 0 = all invariants held; nonzero = a check failed (prints which).

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { console.log(`  FAIL ${msg}`); failures++; } };

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(HERE, "rgoe.mjs");

// Run the CLI with args; return { code, out } where out is stdout+stderr combined so we can
// assert on messages regardless of which stream the CLI chose.
function rgoe(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...(opts.env || {}) },
    timeout: opts.timeout || 60_000,
  });
  if (r.error) throw r.error;
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

async function main() {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));

  // --- help ------------------------------------------------------------------
  console.log("help:");
  const help = rgoe(["help"]);
  ok(help.code === 0, "`rgoe help` exits 0");
  ok(/\bkeygen\b/.test(help.out) && /\bbootnode\b/.test(help.out), "`rgoe help` lists the commands (keygen, bootnode)");
  // no args behaves as help too
  ok(rgoe([]).code === 0, "`rgoe` with no command exits 0 (prints help)");

  // --- version ---------------------------------------------------------------
  console.log("\nversion:");
  const ver = rgoe(["version"]);
  ok(ver.code === 0, "`rgoe version` exits 0");
  ok(ver.out.trim() === pkg.version, `\`rgoe version\` prints package.json version (${pkg.version})`);

  // --- unknown command -------------------------------------------------------
  console.log("\nunknown command:");
  const bad = rgoe(["no-such-command"]);
  ok(bad.code !== 0, "`rgoe no-such-command` exits nonzero");
  ok(/unknown command/i.test(bad.out), "`rgoe no-such-command` explains it is an unknown command");

  // --- doctor (health check; 0 or 1 both fine, it's advisory) -----------------
  console.log("\ndoctor:");
  const doc = rgoe(["doctor"]);
  ok(doc.code === 0 || doc.code === 1, "`rgoe doctor` runs and exits 0 or 1 (health check)");
  ok(/rgoe doctor/.test(doc.out), "`rgoe doctor` prints its `rgoe doctor` banner");

  // --- --help short-circuits BEFORE running a service -------------------------
  // A durable service (bootnode) must print its help and exit 0 without ever binding a port.
  console.log("\ncommand --help:");
  const bhelp = rgoe(["bootnode", "--help"], { timeout: 10_000 });
  ok(bhelp.code === 0, "`rgoe bootnode --help` exits 0 (never starts the service)");
  ok(/bootnode/.test(bhelp.out), "`rgoe bootnode --help` prints the bootnode command help");

  // --- live flag plumbing: keygen mints an onion into a positional dir --------
  // Proves BOTH positional passthrough (<hsDir>) and the module-parsed --label flag (which is
  // NOT in FLAG_ENV, so it must fall through to the child as `--label test`).
  console.log("\nkeygen (live flag + positional passthrough):");
  const work = await mkdtemp(join(tmpdir(), "rgoe-cli-"));
  try {
    const hsDir = join(work, "hs");
    const kg = rgoe(["keygen", hsDir, "--label", "test"], { timeout: 30_000 });
    ok(kg.code === 0, "`rgoe keygen <dir> --label test` exits 0");
    ok(existsSync(join(hsDir, "hostname")), "keygen wrote a `hostname` file into the positional dir");
    ok(existsSync(join(hsDir, "identity.local.json")), "keygen wrote `identity.local.json` into the positional dir");
    if (existsSync(join(hsDir, "identity.local.json"))) {
      const id = JSON.parse(await readFile(join(hsDir, "identity.local.json"), "utf8"));
      ok(id.label === "test", "the --label test flag reached the module (identity.local.json.label === 'test')");
      ok(typeof id.onion === "string" && id.onion.endsWith(".onion"), "keygen minted a .onion address");
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  // --- static check of the FLAG_ENV mapping table ----------------------------
  // The env mapping is the CLI's whole contract: flags and RGOE_* env vars stay one-to-one so
  // either works. Importing the CLI to read FLAG_ENV would run main(); instead assert the
  // documented pairs exist in the source text.
  console.log("\nFLAG_ENV mapping (static):");
  const src = await readFile(CLI, "utf8");
  const pairs = [
    ["port", "RGOE_BOOTNODE_PORT"],
    ["secret", "RGOE_SECRET"],
    ["bootnode", "RGOE_BOOTNODE_ONION"],
    ["admission", "RGOE_BOOTNODE_ADMISSION"],
    ["shim-port", "RGOE_SHIM_PORT"],
    ["directory", "RGOE_DIRECTORY"],
    ["dir-signer", "RGOE_DIR_SIGNER"],
  ];
  for (const [flag, env] of pairs) {
    // matches:  port: "RGOE_BOOTNODE_PORT"   or   "shim-port": "RGOE_SHIM_PORT"
    const re = new RegExp(`(?:"${flag}"|\\b${flag})\\s*:\\s*"${env}"`);
    ok(re.test(src), `FLAG_ENV maps --${flag} -> ${env}`);
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: rgoe CLI selftest (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
