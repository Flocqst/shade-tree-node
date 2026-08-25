import assert from "node:assert/strict";
import { CompositeRootProvider, _internals } from "./root-provider.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let calls = 0;
let active = 0;
let maxActive = 0;
let releaseFirst;
const first = new Promise((resolve) => { releaseFirst = resolve; });
const currentRoots = async () => {
  calls++;
  active++;
  maxActive = Math.max(maxActive, active);
  if (calls === 1) await first;
  active--;
  return { roots: [String(calls)] };
};

let callbacks = 0;
let stop = () => {};
stop = _internals.pollOnChange(currentRoots)(() => {
  callbacks++;
  stop();
}, 5);

for (let i = 0; i < 20 && calls === 0; i++) await sleep(2);
assert.equal(calls, 1, "the first periodic refresh started");
await sleep(35);
assert.equal(calls, 1, "a stalled refresh does not start overlapping interval callbacks");
assert.equal(maxActive, 1);

releaseFirst();
for (let i = 0; i < 20 && callbacks === 0; i++) await sleep(2);
assert.equal(callbacks, 1);
await sleep(20);
assert.equal(calls, 1, "unsubscribe during the callback prevents a reschedule");

const until = async (predicate, attempts = 50) => {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return true;
    await sleep(2);
  }
  return false;
};

let secondaryRoot = "20";
let secondaryStale = false;
const child = (contract, read) => ({
  contract,
  currentRoots: read,
  describe: () => ({ provider: "node", contract }),
});
const composite = CompositeRootProvider([
  child("0xA", async () => ({ roots: ["10"] })),
  child("0xB", async () => ({ roots: [secondaryRoot], stale: secondaryStale })),
]);
const snapshots = [];
const stopComposite = composite.onChange((roots) => snapshots.push(roots.slice()), 5);
assert.equal(await until(() => snapshots.length === 1), true, "composite emits its initial snapshot");

secondaryRoot = "21";
assert.equal(await until(() => snapshots.length === 2), true, "a secondary root change emits even when the first root is stable");
assert.deepEqual(snapshots[1], ["10", "21"]);

secondaryStale = true;
assert.equal(await until(() => snapshots.length === 3), true, "a source health change emits even when every root is stable");

secondaryStale = false;
assert.equal(await until(() => snapshots.length === 4), true, "source recovery emits even when every root is stable");
stopComposite();

console.log("PASS: root-provider polling is serial, complete, and cancellable");
