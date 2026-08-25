import assert from "node:assert/strict";
import { splitHistory, windowedHistory } from "../docs/post/grove/history.js";

const sample = (minutes, announced = 1) => ({
  at: new Date(Date.parse("2026-08-25T12:00:00.000Z") + minutes * 60_000).toISOString(),
  announced,
});

assert.deepEqual(
  splitHistory([sample(0), sample(15), sample(30)], 15).map((segment) => segment.length),
  [3],
  "ordinary cadence remains one continuous segment",
);
assert.deepEqual(
  splitHistory([sample(0), sample(15), sample(45)], 15).map((segment) => segment.length),
  [2, 1],
  "one missed census creates a visible gap",
);

const observedAt = sample(24 * 60).at;
assert.deepEqual(
  windowedHistory([sample(-1), sample(0), sample(24 * 60)], observedAt).map(({ at }) => at),
  [sample(0).at, sample(24 * 60).at],
  "24-hour history includes its boundary and excludes older samples",
);

console.log("PASS: Grove history selftest");
