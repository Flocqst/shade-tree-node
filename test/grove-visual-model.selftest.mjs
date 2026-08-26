import assert from "node:assert/strict";
import { groveArcCount, grovePatchCount } from "../docs/post/grove/visual-model.js";

for (const quality of ["low", "high"]) {
  assert.equal(grovePatchCount(0, quality), 0, `zero announcements render no trees at ${quality} quality`);
  assert.equal(groveArcCount(0, quality), 0, `zero announcements render no arcs at ${quality} quality`);
  for (const announced of [1, 2, 8, 64, 1_024, 100_000]) {
    assert.equal(
      grovePatchCount(announced, quality),
      announced,
      `one tree renders for each announced identity at ${quality} quality`,
    );
  }
  assert.equal(groveArcCount(1, quality), 0, `a lone tree does not draw a self-arc at ${quality} quality`);
  assert.ok(groveArcCount(2, quality) <= 2, `arcs never outnumber announced identities at ${quality} quality`);
}

console.log("PASS: Grove visual-model selftest");
