// Guided-onboarding selftest. Spawns the REAL CLI (`node bin/rgoe.mjs join ...`) for both
// roles and proves the front door does its two jobs without ever mishandling a secret:
//
//   rgoe join member   -> self-enrolls: prints a well-formed commitment + the EXACT client
//                         command on stdout, and the bearer secret on STDERR only (never stdout,
//                         mirroring enroll's commitment-only stream contract).
//   rgoe join gateway  -> mints a real .onion identity into a temp dir and prints the gateway +
//                         heartbeat next commands; the announce-signing seed stays off stdout.
//
//   node group/join.selftest.mjs
//
// Exit 0 = all invariants held; nonzero = a check failed (prints which). Temp files are cleaned
// up. Spawns are fast/offline (keygen + a nested enroll --commitment-only; no services).

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { identityFor, rateCommitmentOf, FIELD } from "../lib/rln.mjs";

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { console.log(`  FAIL ${msg}`); failures++; } };

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "bin", "rgoe.mjs");

// Run the CLI keeping stdout and stderr SEPARATE — the whole point is which stream carries what.
function rgoe(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...(opts.env || {}) },
    timeout: opts.timeout || 60_000,
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

const SECRET_RE = /RGOE_SECRET=(0x[0-9a-fA-F]{64})/;

function isFieldElement(tok) {
  if (!/^[0-9]+$/.test(tok)) return false;
  let n; try { n = BigInt(tok); } catch { return false; }
  return n > 0n && n < FIELD;
}

async function main() {
  // === 1. join member: guide on stdout, secret on stderr ONLY ==============
  console.log("join member:");
  const m = rgoe(["join", "member"], { timeout: 40_000 });
  ok(m.code === 0, "`rgoe join member` exits 0");
  ok(/joining as a MEMBER/i.test(m.stdout), "stdout announces the MEMBER role");

  // The commitment the guide prints must be a real leaf, and it must be derivable from the
  // secret on stderr (rateCommitmentOf(identityFor(secret))) — proving it composed the real
  // enroll flow, not printed a placeholder.
  const commitment = (m.stdout.match(/commitment:\s+([0-9]+)/) || [])[1];
  ok(commitment != null && isFieldElement(commitment), "stdout prints a well-formed field-element commitment");

  const secret = (m.stderr.match(SECRET_RE) || [])[1];
  ok(!!secret, "the bearer secret (export RGOE_SECRET=0x...) is emitted on STDERR");

  // Stream contract: the secret must NEVER ride stdout in any form.
  ok(secret ? !m.stdout.includes(secret) : true, "the secret hex does NOT appear on stdout");
  ok(!/RGOE_SECRET=0x[0-9a-fA-F]{64}/.test(m.stdout), "no concrete RGOE_SECRET=0x... value on stdout");

  let derived = "__underivable__";
  try { derived = rateCommitmentOf(identityFor(secret)).toString(); } catch { /* sentinel */ }
  ok(derived === commitment, "stdout commitment == rateCommitmentOf(identityFor(secret)) (composed real enroll)");

  // The whole point of the guide: the EXACT next commands, copy-paste ready.
  ok(/rgoe client --secret \$RGOE_SECRET/.test(m.stdout), "prints the `rgoe client --secret $RGOE_SECRET ...` command");
  ok(/--bootnode <bootnode-onion>/.test(m.stdout), "the client command shows the --bootnode placeholder");
  ok(/--dir-signer <bootnode-signer-pubkey>/.test(m.stdout), "the client command shows the --dir-signer placeholder");
  ok(new RegExp(`rgoe register-member ${commitment}`).test(m.stdout), "prints the optional `rgoe register-member <commitment>` step");

  // default (no role) behaves as member too
  const def = rgoe(["join"], { timeout: 40_000 });
  ok(def.code === 0 && /joining as a MEMBER/i.test(def.stdout), "`rgoe join` (no role) defaults to member");

  // === 2. join gateway: mint an onion into a temp dir, print gw/heartbeat ===
  console.log("\njoin gateway:");
  const work = await mkdtemp(join(tmpdir(), "rgoe-join-"));
  try {
    const hsDir = join(work, "hs");
    const g = rgoe(["join", "gateway", hsDir], { timeout: 40_000 });
    ok(g.code === 0, "`rgoe join gateway <hsDir>` exits 0");
    ok(/joining as a GATEWAY/i.test(g.stdout), "stdout announces the GATEWAY role");

    // It actually minted a real onion identity into the temp dir.
    ok(existsSync(join(hsDir, "hostname")), "keygen wrote a `hostname` into the temp hsDir");
    ok(existsSync(join(hsDir, "identity.local.json")), "keygen wrote `identity.local.json` into the temp hsDir");
    const onion = (g.stdout.match(/onion:\s+(\S+\.onion)/) || [])[1];
    ok(!!onion, "stdout prints a minted .onion address");
    if (existsSync(join(hsDir, "identity.local.json"))) {
      const id = JSON.parse(await readFile(join(hsDir, "identity.local.json"), "utf8"));
      ok(id.onion === onion, "the printed onion matches identity.local.json");
      // The announce-signing seed is a secret — it must not be spilled onto stdout.
      ok(id.seed && !g.stdout.includes(id.seed), "the announce-signing seed does NOT appear on stdout");
    }

    // The EXACT next commands for a gateway operator.
    ok(/rgoe register-gateway/.test(g.stdout), "prints the optional `rgoe register-gateway` step");
    ok(/rgoe gateway/.test(g.stdout), "prints the `rgoe gateway` command");
    ok(/rgoe heartbeat --bootnode <bootnode-onion>/.test(g.stdout), "prints the `rgoe heartbeat --bootnode <onion>` command");
    ok(new RegExp(`--identity ${join(hsDir, "identity.local.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(g.stdout),
       "the heartbeat command points --identity at the minted identity file");
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: join selftest (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
