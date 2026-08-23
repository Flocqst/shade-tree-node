// Offline proof that the shade-tree CLI router (bin/shade-tree.mjs) behaves. It SPAWNS the real CLI as a
// child (node:child_process) for every case — no importing internals — so it exercises exactly
// what a user gets on the command line: help/version/unknown-command exit codes and output, the
// doctor health check, and the flag plumbing that maps clean --flags onto the SHADE_TREE_* env the
// underlying modules read. The one live command it runs is `keygen`, which is fast and offline;
// it never launches a long-running service (bootnode/gateway/client) — those are --help only.
//
//   node bin/shade-tree.selftest.mjs
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
const CLI = join(HERE, "shade-tree.mjs");

// Run the CLI with args; return { code, out } where out is stdout+stderr combined so we can
// assert on messages regardless of which stream the CLI chose.
function shadeTreeCli(args, opts = {}) {
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
  const help = shadeTreeCli(["help"]);
  ok(help.code === 0, "`shade-tree help` exits 0");
  ok(/\brun\b/.test(help.out) && /\bkeygen\b/.test(help.out) && /\bbootnode\b/.test(help.out), "`shade-tree help` lists the commands (run, keygen, bootnode)");
  ok(/\bidentity\b/.test(help.out) && /\bexit-gateway\b/.test(help.out) && /\bwithdraw-gateway\b/.test(help.out) && /\bgateway-status\b/.test(help.out),
    "`shade-tree help` lists identity, exit-gateway, withdraw-gateway, gateway-status (T-DEPLOY-5 GAP-4/GAP-12)");
  ok(/\bjoin\b/.test(help.out) && /\bbackup\b/.test(help.out) && /\brestore\b/.test(help.out), "`shade-tree help` lists join, backup, restore");
  // no args behaves as help too
  ok(shadeTreeCli([]).code === 0, "`shade-tree` with no command exits 0 (prints help)");
  const runHelp = shadeTreeCli(["run", "--help"]);
  ok(runHelp.code === 0 && /process-scoped|scoped HTTP\(S\) proxy/i.test(runHelp.out), "`shade-tree run --help` describes scoped routing and exits 0");

  // --- version ---------------------------------------------------------------
  console.log("\nversion:");
  const ver = shadeTreeCli(["version"]);
  ok(ver.code === 0, "`shade-tree version` exits 0");
  ok(ver.out.trim() === pkg.version, `\`shade-tree version\` prints package.json version (${pkg.version})`);

  // --- unknown command -------------------------------------------------------
  console.log("\nunknown command:");
  const bad = shadeTreeCli(["no-such-command"]);
  ok(bad.code !== 0, "`shade-tree no-such-command` exits nonzero");
  ok(/unknown command/i.test(bad.out), "`shade-tree no-such-command` explains it is an unknown command");

  // --- doctor (health check; 0 or 1 both fine, it's advisory) -----------------
  console.log("\ndoctor:");
  const doc = shadeTreeCli(["doctor"]);
  ok(doc.code === 0 || doc.code === 1, "`shade-tree doctor` runs and exits 0 or 1 (health check)");
  ok(/shade-tree doctor/.test(doc.out), "`shade-tree doctor` prints its `shade-tree doctor` banner");

  // --- --help short-circuits BEFORE running a service -------------------------
  // A durable service (bootnode) must print its help and exit 0 without ever binding a port.
  console.log("\ncommand --help:");
  const bhelp = shadeTreeCli(["bootnode", "--help"], { timeout: 10_000 });
  ok(bhelp.code === 0, "`shade-tree bootnode --help` exits 0 (never starts the service)");
  ok(/bootnode/.test(bhelp.out), "`shade-tree bootnode --help` prints the bootnode command help");
  // the on-chain exit commands must never reach a chain from --help either
  const ehelp = shadeTreeCli(["exit-gateway", "--help"], { timeout: 10_000 });
  ok(ehelp.code === 0 && /initiateExit|unbonding/i.test(ehelp.out), "`shade-tree exit-gateway --help` exits 0 (no RPC touched)");
  const ihelp = shadeTreeCli(["identity", "--help"], { timeout: 10_000 });
  ok(ihelp.code === 0 && /--out/.test(ihelp.out), "`shade-tree identity --help` exits 0 and names --out");

  // --- live flag plumbing: keygen mints an onion into a positional dir --------
  // Proves BOTH positional passthrough (<hsDir>) and the module-parsed --label flag (which is
  // NOT in FLAG_ENV, so it must fall through to the child as `--label test`).
  console.log("\nkeygen (live flag + positional passthrough):");
  const work = await mkdtemp(join(tmpdir(), "shade-tree-cli-"));
  try {
    const hsDir = join(work, "hs");
    const kg = shadeTreeCli(["keygen", hsDir, "--label", "test"], { timeout: 30_000 });
    ok(kg.code === 0, "`shade-tree keygen <dir> --label test` exits 0");
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
  // The env mapping is the CLI's whole contract: flags and SHADE_TREE_* env vars stay one-to-one so
  // either works. Importing the CLI to read FLAG_ENV would run main(); instead assert the
  // documented pairs exist in the source text.
  console.log("\nFLAG_ENV mapping (static):");
  const src = await readFile(CLI, "utf8");
  const pairs = [
    ["port", "SHADE_TREE_BOOTNODE_PORT"],
    ["secret", "SHADE_TREE_SECRET"],
    ["bootnode", "SHADE_TREE_BOOTNODE_ONION"],
    ["admission", "SHADE_TREE_BOOTNODE_ADMISSION"],
    ["shim-port", "SHADE_TREE_SHIM_PORT"],
    ["directory", "SHADE_TREE_DIRECTORY"],
    ["dir-signer", "SHADE_TREE_DIR_SIGNER"],
    ["network", "SHADE_TREE_NETWORK"],
  ];
  for (const [flag, env] of pairs) {
    // matches:  port: "SHADE_TREE_BOOTNODE_PORT"   or   "shim-port": "SHADE_TREE_SHIM_PORT"
    const re = new RegExp(`(?:"${flag}"|\\b${flag})\\s*:\\s*"${env}"`);
    ok(re.test(src), `FLAG_ENV maps --${flag} -> ${env}`);
  }

  // --- --network / SHADE_TREE_NETWORK (lib/network-record.mjs) --------------------------------------
  // `record-deploy` has no config role and its --dry-run writes nothing, so it is the safe live
  // command to prove the wrapper resolves network/<name>/ records into env before spawning.
  console.log("\n--network (SHADE_TREE_NETWORK record resolution):");
  const badNet = shadeTreeCli(["record-deploy", "--network", "no-such-network-zzz", "--address", "0x" + "ab".repeat(20), "--dry-run"]);
  ok(badNet.code === 1 && /SHADE_TREE_NETWORK=no-such-network-zzz/.test(badNet.out) && /no such network/.test(badNet.out), "`--network <unknown>` fails fast in the wrapper before spawning");
  const trav = shadeTreeCli(["record-deploy", "--network", "../lib", "--dry-run"]);
  ok(trav.code === 1 && /bad network name/.test(trav.out), "`--network ../x` (traversal) is rejected");
  // --force because network/sepolia already records a GatewayRegistry; --dry-run never writes.
  const dry = shadeTreeCli(["record-deploy", "--network", "sepolia", "--address", "0x" + "ab".repeat(20), "--force", "--dry-run"]);
  ok(dry.code === 0 && /supplied .*SHADE_TREE_/.test(dry.out) && /dry-run/.test(dry.out), "`--network sepolia` resolves record defaults (reports supplied vars) and runs the child");
  ok(!/SHADE_TREE_BOOTNODE_ONION|SHADE_TREE_DIR_SIGNER=/.test(dry.out.replace(/supplied [^\n]*/g, "")), "resolved discovery values are never printed (only the var NAMES)");
  const viaEnv = shadeTreeCli(["record-deploy", "--address", "0x" + "ab".repeat(20), "--force", "--dry-run"], { env: { SHADE_TREE_NETWORK: "sepolia" } });
  ok(viaEnv.code === 0 && /supplied/.test(viaEnv.out), "SHADE_TREE_NETWORK from the environment works the same as --network");
  const helpRd = shadeTreeCli(["record-deploy", "--help"]);
  ok(helpRd.code === 0 && /record-deploy/.test(helpRd.out), "`shade-tree record-deploy --help` is wired");

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: shade-tree CLI selftest (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
