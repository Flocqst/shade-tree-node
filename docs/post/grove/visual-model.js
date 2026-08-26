export function grovePatchCount(announced) {
  if (!Number.isInteger(announced) || announced <= 0) return 0;
  return announced;
}

export function groveArcCount(patchCount, quality = "high") {
  if (!Number.isInteger(patchCount) || patchCount < 2) return 0;
  return Math.min(patchCount, quality === "low" ? 3 : 6);
}
