// join — the guided front door. One command that walks a new participant through
// joining the fleet, in whichever role they play:
//
//   node group/join.mjs [member] [label]   -> become a MEMBER: self-enroll an identity,
//                                             print the bearer secret + commitment, and the
//                                             EXACT next commands (optional on-chain stake,
//                                             then `rgoe client ...`).
//   node group/join.mjs gateway [hsDir]    -> become a GATEWAY operator: mint an onion
//                                             identity and print the EXACT next commands
//                                             (optional stake, then `rgoe gateway` + heartbeat).
//
// This composes the EXISTING flows — it never reimplements crypto. The member path spawns
// `group/enroll.mjs --commitment-only` (the real self-enrollment; the secret is generated on
// THIS machine and never leaves it) and reformats its output into a scripted guide. The gateway
// path calls generateOnionIdentity() from bootnode/keygen.mjs.
//
// Stream contract (mirrors enroll's commitment-only mode, so the secret is never captured by a
// pipe or scrolled into a shared log):
//   stdout -> the human guide: role banner, commitment/onion, and numbered copy-paste next steps.
//   stderr -> the bearer SECRET (`export RGOE_SECRET=0x...`) with its "keep this local" note.
// The `rgoe client` line on stdout references $RGOE_SECRET, never the raw hex, so stdout carries
// no secret material.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateOnionIdentity } from "../bootnode/keygen.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENROLL = join(HERE, "enroll.mjs");

const args = process.argv.slice(2);
const positionals = args.filter((a) => !a.startsWith("--"));
const mode = positionals[0] === "gateway" ? "gateway" : "member";

const out = (s = "") => process.stdout.write(s + "\n");
const err = (s = "") => process.stderr.write(s + "\n");

const SECRET_RE = /RGOE_SECRET=(0x[0-9a-fA-F]{64})/;

function joinMember() {
  // The role is MEMBER when positionals[0] is "member" or absent. An optional local-only label
  // is handed straight to enroll: the token after "member", or a lone token that isn't a role.
  const label = positionals[0] === "member" ? positionals[1] : positionals[0];
  const enrollArgs = ["--commitment-only", ...(label ? [label] : [])];

  // Compose the REAL self-enrollment: commitment on the child's stdout, secret on its stderr.
  const r = spawnSync(process.execPath, [ENROLL, ...enrollArgs], { encoding: "utf8", timeout: 60_000 });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    process.stderr.write(r.stderr || "enroll failed\n");
    process.exit(r.status || 1);
  }
  const commitment = (r.stdout || "").trim().split(/\s+/)[0];
  const secret = (r.stderr.match(SECRET_RE) || [])[1];
  if (!commitment || !secret) {
    process.stderr.write("join: could not read commitment/secret from enroll\n" + (r.stderr || ""));
    process.exit(1);
  }

  // --- the guide (stdout) ---------------------------------------------------
  out("rgoe join — you are joining as a MEMBER of the reputation set.");
  out("You generated this identity locally; only the commitment ever leaves this machine.");
  out("");
  out("  commitment:   " + commitment + "   (public; hand this to the operator or stake it on chain)");
  out("");
  out("Next steps:");
  out("");
  out("  1. Keep your secret (printed on stderr below). It is a BEARER credential: whoever holds");
  out("     it can egress as you until the set is rotated. Export it in the shell you'll run from:");
  out("");
  out("       export RGOE_SECRET=<your-secret-hex>      # copy the exact value from stderr");
  out("");
  out("  2. (optional) Stake the commitment on the on-chain StakedReputationSet:");
  out("");
  out("       rgoe register-member " + commitment);
  out("");
  out("  3. Run the client — a local HTTP-CONNECT proxy — pointed at a bootnode and pinning its signer:");
  out("");
  out("       rgoe client --secret $RGOE_SECRET \\");
  out("         --bootnode <bootnode-onion> \\");
  out("         --dir-signer <bootnode-signer-pubkey>");
  out("");
  out("     (get <bootnode-onion> and <bootnode-signer-pubkey> from the fleet operator.)");

  // --- the secret (stderr; never on stdout) ---------------------------------
  err("");
  err("Keep THIS SECRET private — it stays on your machine and the operator never sees it:");
  err("");
  err("  export RGOE_SECRET=" + secret);
  err("");
  process.exit(0);
}

async function joinGateway() {
  // hsDir: positional after "gateway", else env override (tests), else the repo default.
  const hsDir = positionals[1] || process.env.RGOE_JOIN_HSDIR || "tor/hs-gateway";
  const id = await generateOnionIdentity(hsDir, { label: "gateway" });

  out("rgoe join — you are joining as a GATEWAY operator.");
  out("Minted a fresh onion identity Tor will publish and this node can sign announces with.");
  out("");
  out("  onion:        " + id.onion);
  out("  hsDir:        " + id.dir + "   (point Tor's HiddenServiceDir here)");
  out("  identity:     " + join(id.dir, "identity.local.json") + "   (announce-signing seed; keep secret)");
  out("");
  out("Next steps:");
  out("");
  out("  1. (optional) Stake a gateway operator bond so clients can require skin-in-the-game:");
  out("");
  out("       rgoe register-gateway");
  out("");
  out("  2. Run the egress gateway (verifies member proofs, tunnels :443):");
  out("");
  out("       rgoe gateway");
  out("");
  out("  3. Announce it to a bootnode and keep it live:");
  out("");
  out("       rgoe heartbeat --bootnode <bootnode-onion> \\");
  out("         --identity " + join(id.dir, "identity.local.json"));
  out("");
  out("     (get <bootnode-onion> from the fleet operator; it also pins the signer clients need.)");

  // The announce-signing seed lives in identity.local.json (mode 0600); flag it on stderr so a
  // piped/logged stdout never implies the seed itself is safe to share.
  err("");
  err("Keep the announce-signing seed private: " + join(id.dir, "identity.local.json"));
  err("");
  process.exit(0);
}

if (mode === "gateway") {
  await joinGateway();
} else {
  joinMember();
}
