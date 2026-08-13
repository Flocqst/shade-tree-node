// T-TEST-3: unit test for reconstructRoot in lib/root-provider.mjs — the function that rebuilds
// the on-chain admission root from Member* event logs. Gateway and client BOTH run this and must
// agree by construction, so a bug here silently breaks every proof (root mismatch => all DROP) or,
// worse, keeps a removed member admitted. Oracle: the same newGroup the code uses, fed the set we
// expect to survive, so the test fails on any ordering/dedup/removal defect.
//
//   node lib/root-provider.selftest.mjs

import { reconstructRoot } from "./root-provider.mjs";
import { newGroup } from "./rln.mjs";

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { console.log(`  FAIL ${msg}`); failures++; } };

// The Member* event topic0 hashes (keccak of the signatures), as hardcoded in root-provider.mjs.
const TOPIC = {
  registered: "0x0dbb6a3ed41d8f3d21e481b86d0e8bbf65a630b7dc4c5ee6c2c1a74561841e6d",
  exiting: "0x971e754215411b0ec07054d759063d876d53872b7d4b37294744e5a776604f37",
  withdrawn: "0x8f2d81dd61a3f7ff90ea7265e45192f03f643615dd2458e287d84aaac222ffe9",
  slashed: "0x707cd9719d0c14265b9e456f7add99095401f907e570e5cdd65a92920947c450",
};
const log = (topic0, commitment, block, logIndex = 0) => ({
  topics: [topic0, "0x" + BigInt(commitment).toString(16)],
  blockNumber: "0x" + BigInt(block).toString(16),
  logIndex: "0x" + BigInt(logIndex).toString(16),
});
// Oracle: the root the code SHOULD produce for a given surviving set, in registration order.
const rootOf = (commitments) => newGroup(commitments.map((c) => BigInt(c))).root.toString();

function main() {
  // 1. plain registrations, in order
  {
    const logs = [log(TOPIC.registered, 11, 1), log(TOPIC.registered, 22, 2), log(TOPIC.registered, 33, 3)];
    ok(reconstructRoot(logs) === rootOf([11, 22, 33]), "three registrations -> root of {11,22,33}");
  }

  // 2. out-of-order logs are sorted by (block, logIndex) before building
  {
    const inOrder = [log(TOPIC.registered, 11, 1), log(TOPIC.registered, 22, 2), log(TOPIC.registered, 33, 3)];
    const shuffled = [log(TOPIC.registered, 33, 3), log(TOPIC.registered, 11, 1), log(TOPIC.registered, 22, 2)];
    ok(reconstructRoot(shuffled) === reconstructRoot(inOrder), "log order does not change the root (sorted by block/logIndex)");
    // same-block ordering resolved by logIndex
    const byLogIndex = [log(TOPIC.registered, 22, 5, 1), log(TOPIC.registered, 11, 5, 0)];
    ok(reconstructRoot(byLogIndex) === rootOf([11, 22]), "same-block events ordered by logIndex");
  }

  // 3. removal: exit / withdraw / slash drop the leaf; survivors rebuild in registration order
  {
    const base = [log(TOPIC.registered, 11, 1), log(TOPIC.registered, 22, 2), log(TOPIC.registered, 33, 3)];
    ok(reconstructRoot([...base, log(TOPIC.exiting, 22, 4)]) === rootOf([11, 33]), "exiting removes the leaf -> root of {11,33}");
    ok(reconstructRoot([...base, log(TOPIC.withdrawn, 11, 4)]) === rootOf([22, 33]), "withdrawn removes the leaf -> root of {22,33}");
    ok(reconstructRoot([...base, log(TOPIC.slashed, 33, 4)]) === rootOf([11, 22]), "slashed removes the leaf -> root of {11,22}");
    ok(reconstructRoot([...base, log(TOPIC.slashed, 11, 4), log(TOPIC.exiting, 33, 5)]) === rootOf([22]), "multiple removals -> root of survivor {22}");
  }

  // 4. a removed member is NOT re-admitted by a later duplicate registration event for the same commitment
  {
    const logs = [log(TOPIC.registered, 11, 1), log(TOPIC.registered, 22, 2), log(TOPIC.slashed, 11, 3), log(TOPIC.registered, 11, 4)];
    ok(reconstructRoot(logs) === rootOf([22]), "a slashed commitment stays removed even if a later register event repeats it");
  }

  // 5. dedup: a repeated registration of the same commitment counts once, keeping first position
  {
    const logs = [log(TOPIC.registered, 11, 1), log(TOPIC.registered, 22, 2), log(TOPIC.registered, 11, 3)];
    ok(reconstructRoot(logs) === rootOf([11, 22]), "duplicate registration deduped (position preserved)");
  }

  // 6. empty / fully-removed set -> null (no root), never a throw
  {
    ok(reconstructRoot([]) === null, "no logs -> null root");
    ok(reconstructRoot([log(TOPIC.registered, 11, 1), log(TOPIC.exiting, 11, 2)]) === null, "register then remove the only member -> null");
  }

  // 7. determinism: identical logs always yield the identical root
  {
    const logs = [log(TOPIC.registered, 7, 1), log(TOPIC.registered, 8, 2), log(TOPIC.registered, 9, 3)];
    ok(reconstructRoot(logs) === reconstructRoot(logs.slice()), "deterministic: same logs -> same root");
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: root-provider selftest (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
