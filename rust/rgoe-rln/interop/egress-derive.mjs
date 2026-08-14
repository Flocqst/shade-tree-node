// T-RUST-2d harness helper: derive a member identity + the group member set from a fixed
// app secret using the JS reference (lib/rln.mjs), and write the two input files the Rust
// `rgoe egress --features live` build consumes:
//
//   <outdir>/identity.json  = { identitySecret, leaf }   (the member's derived secret + leaf)
//   <outdir>/members.json   = { members: [leaf, ...] }   (the ordered group)
//
// The SAME members.json is copied over group/members.json by egress-run.sh so the JS
// gateway's PoC root source (loadGroup) computes the identical depth-20 root the Rust
// native tree does. This is the ONLY place the identity derivation lives (Semaphore-v3
// identitySecret + rateCommitment leaf); the Rust side takes them as inputs and computes
// the root + path natively.
//
// Usage: node egress-derive.mjs <outdir> [secret]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { identityFor, identitySecretOf, rateCommitmentOf, cleanUp } from "../../../lib/rln.mjs";

const outdir = process.argv[2];
if (!outdir) {
  console.error("usage: node egress-derive.mjs <outdir> [secret]");
  process.exit(2);
}
const SECRET = process.argv[3] || "12345678901234567890";

const identity = identityFor(SECRET);
const identitySecret = identitySecretOf(identity).toString();
const leaf = rateCommitmentOf(identity).toString();

writeFileSync(join(outdir, "identity.json"), JSON.stringify({ identitySecret, leaf }, null, 2) + "\n");
writeFileSync(join(outdir, "members.json"), JSON.stringify({ version: 2, members: [leaf] }, null, 2) + "\n");

console.error("[derive] secret          =", SECRET);
console.error("[derive] identitySecret  =", identitySecret);
console.error("[derive] leaf (commit)   =", leaf);
console.error("[derive] wrote", join(outdir, "identity.json"), "+", join(outdir, "members.json"));
cleanUp();
