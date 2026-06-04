// Grant reputation to a member: add them to the reputation set.
//
// This is the trust boundary of the whole system: the zk proof gates on
// membership in THIS set, so whatever ceremony adds a commitment here is what
// "reputable" means. For the PoC, enrollment is a local command. In production
// the leaf is added only after whatever the admission policy requires: a stake,
// an invite, accrued good standing, or a proof-of-personhood check (World ID,
// which is itself Semaphore-based). The cryptography below is identical either
// way; only the admission policy changes.
//
// Usage:
//   node group/enroll.mjs                  -> new identity, prints a client secret
//   node group/enroll.mjs <name>           -> label the member (label is NOT stored in the set)

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Identity, MEMBERS_PATH, loadGroup } from "../lib/semaphore.mjs";

const label = process.argv[2] || "member-" + randomBytes(2).toString("hex");

// A random high-entropy secret. The holder of this secret can prove membership.
const secret = randomBytes(32).toString("hex");
const identity = new Identity(secret);
const commitment = identity.commitment.toString();

let doc = { version: 1, members: [] };
if (existsSync(MEMBERS_PATH)) {
  doc = JSON.parse(await readFile(MEMBERS_PATH, "utf8"));
}
doc.members.push(commitment);
await writeFile(MEMBERS_PATH, JSON.stringify(doc, null, 2) + "\n");

const { root, count } = await loadGroup();

console.log("Granted reputation to a member (added to the reputation set).");
console.log("  label:        " + label + "   (local only, never enters the set)");
console.log("  commitment:   " + commitment);
console.log("  set size:     " + count);
console.log("  group root:   " + root);
console.log("");
console.log("Give this secret to the client (keep it private):");
console.log("");
console.log("  export RGOE_SECRET=" + secret);
console.log("");
console.log("The client proves membership with this secret; it never sends the secret itself.");
