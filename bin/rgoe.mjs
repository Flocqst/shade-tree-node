#!/usr/bin/env node
// rgoe — one entrypoint for the whole reputation-gated onion egress system.
//
// Every subcommand is a thin router: it maps clean --flags onto the RGOE_* environment the
// underlying module already reads (so flags and env vars stay in one-to-one sync and either
// works), then runs that module as a child so its own main() and lifecycle are unchanged.
//
//   rgoe <command> [--flags] [args]
//
// Run `rgoe help` for the command list, or `rgoe <command> --help` for a command's flags.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// flag -> RGOE_ env var. A flag is valid for any command; it simply sets env, which is
// harmless where unused, and keeps the surface small and uniform.
const FLAG_ENV = {
  // global
  "rpc-url": "RGOE_RPC_URL",
  "tor-host": "RGOE_TOR_HOST",
  "tor-port": "RGOE_TOR_PORT",
  "epoch-seconds": "RGOE_EPOCH_SECONDS",
  // bootnode
  port: "RGOE_BOOTNODE_PORT",
  admission: "RGOE_BOOTNODE_ADMISSION",
  ttl: "RGOE_BOOTNODE_TTL",
  "signer-key": "RGOE_BOOTNODE_SIGNER_KEY",
  "stake-mode": "RGOE_STAKE_MODE",
  "gateway-registry": "RGOE_GATEWAY_REGISTRY",
  "stake-allowlist": "RGOE_STAKE_ALLOWLIST",
  // gateway
  "group-contract": "RGOE_GROUP_CONTRACT",
  "root-provider": "RGOE_ROOT_PROVIDER",
  "slash-key": "RGOE_SLASH_KEY",
  "slash-contract": "RGOE_SLASH_CONTRACT",
  // client
  secret: "RGOE_SECRET",
  onion: "RGOE_ONION",
  bootnode: "RGOE_BOOTNODE_ONION",
  directory: "RGOE_DIRECTORY",
  "dir-signer": "RGOE_DIR_SIGNER",
  "shim-port": "RGOE_SHIM_PORT",
  // gateway announce / heartbeat
  identity: "RGOE_GW_IDENTITY",
  weight: "RGOE_GW_WEIGHT",
  interval: "RGOE_BOOTNODE_HEARTBEAT",
  "operator-key": "RGOE_GW_OPERATOR_KEY",
  operator: "RGOE_GW_OPERATOR",
  "operator-sig": "RGOE_GW_OPERATOR_SIG",
  "register-key": "RGOE_REGISTER_KEY",
  bond: "RGOE_BOND",
};

// command -> { script, help }. `long` marks a durable service (just for the help hint).
const COMMANDS = {
  keygen:            { script: "bootnode/keygen.mjs",       help: "mint an onion identity (Tor HS key + announce-signing seed): rgoe keygen <hsDir> [--label name]" },
  bootnode:          { script: "bootnode/server.mjs",       help: "run the discovery bootnode (an onion service)", long: true },
  heartbeat:         { script: "bootnode/heartbeat.mjs",    help: "keep this gateway announced on the bootnode", long: true },
  enroll:            { script: "group/enroll.mjs",          help: "generate a member identity + print its secret/commitment" },
  "register-member": { script: "group/register-onchain.mjs", help: "stake a member commitment into StakedReputationSet: rgoe register-member <commitment>" },
  "register-gateway":{ script: "group/register-gateway.mjs", help: "stake a gateway operator bond into GatewayRegistry" },
  "sign-directory":  { script: "group/sign-directory.mjs",  help: "sign a static fleet directory (offline discovery)" },
  gateway:           { script: "gateway/gateway.mjs",       help: "run the reputation-gated egress gateway", long: true },
  client:            { script: "client/shim.mjs",           help: "run the local HTTP-CONNECT proxy (fleet client)", long: true },
  shim:              { script: "client/shim.mjs",           help: "alias for `client`", long: true },
  doctor:            { script: "scripts/doctor.mjs",        help: "check the local setup (node, tor, keys, deps)" },
};

function parse(argv) {
  const flags = {}, positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { flags.help = true; continue; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); }
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { flags[a.slice(2)] = argv[++i]; }
      else { flags[a.slice(2)] = "true"; }
    } else positionals.push(a);
  }
  return { flags, positionals };
}

function topHelp() {
  console.log(`rgoe ${pkg.version} — reputation-gated onion egress\n`);
  console.log("usage: rgoe <command> [--flags] [args]\n");
  const order = ["keygen", "bootnode", "heartbeat", "enroll", "register-member", "register-gateway", "sign-directory", "gateway", "client", "doctor"];
  for (const name of order) console.log(`  ${name.padEnd(18)}${COMMANDS[name].help}`);
  console.log(`\ncommon flags: --bootnode <onion> --secret <hex> --port N --admission open|stake --stake-mode onchain|mock`);
  console.log(`every --flag maps to an RGOE_* env var (see docs/CLI.md); flags override the environment.`);
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { topHelp(); process.exit(0); }
  if (cmd === "version" || cmd === "--version") { console.log(pkg.version); process.exit(0); }
  const entry = COMMANDS[cmd];
  if (!entry) { console.error(`unknown command: ${cmd}\n`); topHelp(); process.exit(1); }

  const { flags, positionals } = parse(rest);
  if (flags.help) { console.log(`rgoe ${cmd} — ${entry.help}`); process.exit(0); }

  const env = { ...process.env };
  const passthrough = []; // flags the module parses itself (e.g. keygen --label)
  for (const [flag, val] of Object.entries(flags)) {
    const envKey = FLAG_ENV[flag];
    if (envKey) env[envKey] = val;
    else { passthrough.push(`--${flag}`); if (val !== "true") passthrough.push(val); }
  }

  const child = spawn(process.execPath, [join(ROOT, entry.script), ...positionals, ...passthrough], { stdio: "inherit", env });
  child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 0); });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { child.kill(sig); } catch {} });
}

main();
