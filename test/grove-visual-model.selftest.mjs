import assert from "node:assert/strict";
import { groveArcCount, grovePatchCount } from "../docs/post/grove/visual-model.js";

for (const quality of ["low", "high"]) {
  assert.equal(grovePatchCount(0, quality), 0, `zero announcements render no trees at ${quality} quality`);
  assert.equal(groveArcCount(0, quality), 0, `zero announcements render no arcs at ${quality} quality`);
  const counts = [1, 2, 8, 64, 1_024].map((announced) => grovePatchCount(announced, quality));
  assert.ok(counts.every((count) => count > 0), `positive announcements render aggregate groves at ${quality} quality`);
  assert.ok(counts.every((count, index) => index === 0 || count >= counts[index - 1]), `aggregate density is monotonic at ${quality} quality`);
}

console.log("PASS: Grove visual-model selftest");
