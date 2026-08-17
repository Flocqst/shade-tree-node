// T-TEST-3: unit test for reconstructRoot in lib/root-provider.mjs — the function that rebuilds
// the on-chain admission root from Member* event logs. Gateway and client BOTH run this and must
// agree by construction, so a bug here silently breaks every proof (root mismatch => all DROP) or,
// worse, keeps a removed member admitted. Oracle: the same newGroup the code uses, fed the set we
// expect to survive, so the test fails on any ordering/dedup/removal defect.
//
//   node lib/root-provider.selftest.mjs

import { reconstructRoot, reconstructGroup, parseContractList, configuredContracts, CompositeRootProvider, _internals } from "./root-provider.mjs";
import { newGroup } from "./rln.mjs";

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { console.log(`  FAIL ${msg}`); failures++; } };

// The Member* event topic0 hashes (keccak of the signatures), as hardcoded in root-provider.mjs.
const TOPIC = {
  registered: "0x0dbb6a3ed41d8f3d21e481b86d0e8bbf65a630b7dc4c5ee6c2c1a74561841e6d",
  exiting: "0x971e754215411b0ec07054d759063d876d53872b7d4b37294744e5a776604f37",
  withdrawn: "0x8f2d81dd61a3f7ff90ea7265e45192f03f643615dd2458e287d84aaac222ffe9",
  slashed: "0x707cd9719d0c14265b9e456f7add99095401f907e570e5cdd65a92920947c450",
  // rln-v4 (T-FEAT-8b): the register/slash events carry a trailing non-indexed `limit`.
  registeredV4: "0x509c8735bf3647b16c92625a43b5459d0b51845aa0f3ec846f9d24594e7b824b",
  slashedV4: "0x0a39eb0fcb6a37e10a529e106ae887cbd1721626fa57900170ed0c2437af3797",
  // PaidAccessSet (T-FEAT-7): Inserted / Deposit (append) + Slashed (zero in place), all
  // (commitment indexed, limit, index, root).
  inserted: "0x829b3fd9a2105b78eea5138f4d692eb507be107a9b265a9456ea94fb2db9f992",
  deposit: "0x9b776d199f09c774f5b205c9bc2ac6f40d508c347aaea919867eeaf06ebef0e9",
  paidSlashed: "0xac0c8be2061774c705c517af2a774ab5cb33a2d7fe7054dd4a2728433026029c",
};
const log = (topic0, commitment, block, logIndex = 0) => ({
  topics: [topic0, "0x" + BigInt(commitment).toString(16)],
  blockNumber: "0x" + BigInt(block).toString(16),
  logIndex: "0x" + BigInt(logIndex).toString(16),
});
// Oracle: the root the code SHOULD produce for a given surviving set, in registration order.
const rootOf = (commitments) => newGroup(commitments.map((c) => BigInt(c))).root.toString();

// Oracle for ZERO-IN-PLACE removal (T-DEV-2): build the tree by APPENDING every
// registration in index order, then removeMember() at the ORIGINAL index of each removed
// leaf. This is the Semaphore/RLN convention the contract's immutable append-only leaf
// `index` encodes (StakedReputationSet.nextIndex never renumbers survivors), expressed via
// the Group API on a DIFFERENT path than reconstructRoot's event replay — so it still
// catches an ordering/index bug. `registeredInOrder` is every commitment ever registered,
// in index order (including ones later removed); `removedIndices` are the vacated slots.
const rootWithRemovals = (registeredInOrder, removedIndices) => {
  const g = newGroup();
  for (const c of registeredInOrder) g.addMember(BigInt(c));
  for (const i of removedIndices) g.removeMember(i);
  return g.root.toString();
};

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

  // 3. removal is ZERO-IN-PLACE (T-DEV-2): exit / withdraw / slash vacate the leaf at its
  // ORIGINAL index; survivors KEEP their indices (they are NOT renumbered). Registered in
  // index order 11@0, 22@1, 33@2. Corrected from the earlier renumber assertion
  // (rootOf([11,33]) etc.), which built a fresh compacted tree and so DISAGREED with the
  // contract's immutable append-only index after any removal — the exact T-DEV-2 divergence.
  {
    const base = [log(TOPIC.registered, 11, 1), log(TOPIC.registered, 22, 2), log(TOPIC.registered, 33, 3)];
    ok(reconstructRoot([...base, log(TOPIC.exiting, 22, 4)]) === rootWithRemovals([11, 22, 33], [1]), "exiting vacates leaf@1 -> [11, _, 33] (indices preserved)");
    ok(reconstructRoot([...base, log(TOPIC.withdrawn, 11, 4)]) === rootWithRemovals([11, 22, 33], [0]), "withdrawn vacates leaf@0 -> [_, 22, 33]");
    ok(reconstructRoot([...base, log(TOPIC.slashed, 33, 4)]) === rootWithRemovals([11, 22, 33], [2]), "slashed vacates leaf@2 -> [11, 22, _]");
    ok(reconstructRoot([...base, log(TOPIC.slashed, 11, 4), log(TOPIC.exiting, 33, 5)]) === rootWithRemovals([11, 22, 33], [0, 2]), "multiple removals vacate leaf@0 and leaf@2 -> [_, 22, _]");
    // zero-in-place must NOT equal the old renumber-of-survivors root (regression guard).
    ok(reconstructRoot([...base, log(TOPIC.exiting, 22, 4)]) !== rootOf([11, 33]), "zero-in-place removal differs from the (wrong) renumber-of-survivors root");
  }

  // 4. re-registration after removal (T-DEV-2): the contract ALLOWS a slashed commitment to
  // register again with a FRESH index (test_ReRegister_AfterSlash), so a later register event
  // for the same commitment RE-ADMITS it at a new leaf while the old slot stays vacated.
  // Corrected from the earlier assertion (rootOf([22]), "stays removed"), which wrongly
  // dropped the legitimately re-registered member. Log: 11@0, 22@1, slash 11 (vacates @0),
  // 11 re-registers @2. Result: [_, 22, 11].
  {
    const logs = [log(TOPIC.registered, 11, 1), log(TOPIC.registered, 22, 2), log(TOPIC.slashed, 11, 3), log(TOPIC.registered, 11, 4)];
    ok(reconstructRoot(logs) === rootWithRemovals([11, 22, 11], [0]), "re-registration after slash re-admits at a fresh index -> [_, 22, 11]");
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

  // 8. rln-v4 event generation (T-FEAT-8b): MemberRegistered/MemberSlashed with a `limit`
  //    field have a different topic0 but the same topics[1] leaf; reconstruction is identical,
  //    and a mixed log (v3 + v4 shapes) replays as one history. The provider's own table must
  //    pin the exact hashes (recompute: ethers id('MemberRegistered(uint256,uint64,uint256)')).
  {
    ok(_internals.TOPIC.registeredV4 === TOPIC.registeredV4 && _internals.TOPIC.slashedV4 === TOPIC.slashedV4, "v4 topic0 hashes pinned in root-provider");
    const v3 = [log(TOPIC.registered, 11, 1), log(TOPIC.registered, 22, 2), log(TOPIC.registered, 33, 3), log(TOPIC.slashed, 22, 4)];
    const v4 = [log(TOPIC.registeredV4, 11, 1), log(TOPIC.registeredV4, 22, 2), log(TOPIC.registeredV4, 33, 3), log(TOPIC.slashedV4, 22, 4)];
    const mixed = [log(TOPIC.registered, 11, 1), log(TOPIC.registeredV4, 22, 2), log(TOPIC.registered, 33, 3), log(TOPIC.slashedV4, 22, 4)];
    const want = rootWithRemovals([11, 22, 33], [1]);
    ok(reconstructRoot(v4) === want, "v4 (limit-carrying) events reconstruct the same zero-in-place root");
    ok(reconstructRoot(v3) === reconstructRoot(v4) && reconstructRoot(mixed) === want, "v3 and v4 event shapes are interchangeable in one history");
    ok(reconstructRoot([log("0x" + "ab".repeat(32), 11, 1)]) === null, "an unknown topic0 is ignored (never admits a leaf)");
  }

  // 9. PaidAccessSet event generation (T-FEAT-7): Inserted/Deposit append, Slashed zeroes in
  //    place; the same replay, so a paid set and a staked set reconstruct identically. Plus
  //    reconstructGroup exposes the tree, the live index map and the live count for the client.
  {
    ok(_internals.TOPIC.inserted === TOPIC.inserted && _internals.TOPIC.deposit === TOPIC.deposit && _internals.TOPIC.paidSlashed === TOPIC.paidSlashed, "paid topic0 hashes pinned in root-provider (Inserted / Deposit / Slashed)");
    const paid = [log(TOPIC.inserted, 11, 1), log(TOPIC.deposit, 22, 2), log(TOPIC.inserted, 33, 3), log(TOPIC.paidSlashed, 22, 4)];
    const want = rootWithRemovals([11, 22, 33], [1]);
    ok(reconstructRoot(paid) === want, "paid events (insert, insert, insert, slash middle) reconstruct the zero-in-place root");
    const g = reconstructGroup(paid);
    ok(g.root === want && g.active === 2 && g.liveIndex.get("11") === 0 && g.liveIndex.get("33") === 2 && !g.liveIndex.has("22"), "reconstructGroup: root + live count + commitment->index map (slashed leaf gone, indices preserved)");
    ok(g.group.indexOf(33n) === 2 && g.group.members.length === 3, "reconstructGroup.group is the replayed tree (member proofs can be generated from it)");
    ok(reconstructGroup([]).root === null && reconstructGroup([]).active === 0, "empty log -> null root, 0 live");
  }

  // 10. contract lists (T-FEAT-7): RGOE_GROUP_CONTRACT as a comma list + RGOE_PAID_ACCESS_CONTRACT sugar.
  {
    ok(parseContractList("0xA").join() === "0xA" && parseContractList(" 0xA , 0xB,0xa ,, ").join() === "0xA,0xB" && parseContractList("").length === 0 && parseContractList(undefined).length === 0, "parseContractList: trims, drops empties, de-dupes case-insensitively; single = one-element list");
    const cs = configuredContracts({ RGOE_GROUP_CONTRACT: "0xA,0xB", RGOE_PAID_ACCESS_CONTRACT: "0xC" });
    ok(cs.map((c) => `${c.kind}:${c.address}`).join() === "staked:0xA,staked:0xB,paid:0xC", "configuredContracts: group list as staked, paid appended");
    ok(configuredContracts({}).length === 0 && configuredContracts({ RGOE_PAID_ACCESS_CONTRACT: "0xC" }).map((c) => c.kind).join() === "paid", "configuredContracts: none / paid-only");
    ok(configuredContracts({ RGOE_GROUP_CONTRACT: "0xC", RGOE_PAID_ACCESS_CONTRACT: "0xc" }).map((c) => `${c.kind}:${c.address}`).join() === "paid:0xC", "a paid address also in the group list is tagged paid once");
  }

  // 11. CompositeRootProvider: the union of children's roots, de-duplicated; a failing child is
  //     dropped from that refresh (errors[]) — only ALL failing throws; onChange fans out.
  {
    const child = (contract, roots, { throws = false, leafCount = null } = {}) => ({
      contract,
      currentRoots: async () => { if (throws) throw new Error("rpc down"); return { roots, observedAtBlock: 10, finalized: true, leafCount }; },
      onChange: (cb) => { child.cbs = (child.cbs || []).concat(cb); return () => {}; },
      describe: () => ({ provider: "node", contract }),
    });
    const composite = CompositeRootProvider([child("0xA", ["1", "2"]), child("0xB", ["2", "3"], { leafCount: 5 }), child("0xC", [], { throws: true })]);
    return composite.currentRoots().then((r) => {
      ok(r.roots.join() === "1,2,3", "union of roots, de-duplicated, order preserved");
      ok(r.perSource.length === 3 && r.perSource[1].leafCount === 5 && r.perSource[2].error === "rpc down" && r.errors.length === 1, "perSource per child (leafCount passed through); the failing child is reported, not fatal");
      ok(r.observedAtBlock === 10 && r.finalized === true, "observedAtBlock/finalized summarized");
      const allBad = CompositeRootProvider([child("0xA", [], { throws: true })]);
      return allBad.currentRoots().then(() => ok(false, "all children failing must throw"), (e) => ok(/all root providers failed/.test(e.message), "all children failing -> throws (nothing to trust)"));
    }).then(() => {
      let threw = false;
      try { CompositeRootProvider([]); } catch { threw = true; }
      ok(threw, "an empty composite is refused");
      console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: root-provider selftest (${failures} failure${failures === 1 ? "" : "s"})`);
      process.exit(failures === 0 ? 0 : 1);
    });
  }
}

main();
