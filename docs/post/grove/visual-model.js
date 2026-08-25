export function grovePatchCount(announced, quality = "high") {
  if (!Number.isInteger(announced) || announced <= 0) return 0;
  const lowQuality = quality === "low";
  return Math.min(
    lowQuality ? 22 : 36,
    Math.max(lowQuality ? 13 : 19, 14 + Math.round(Math.log2(announced + 1) * (lowQuality ? 3 : 5))),
  );
}

export function groveArcCount(patchCount, quality = "high") {
  if (!Number.isInteger(patchCount) || patchCount <= 0) return 0;
  return quality === "low" ? 3 : 6;
}
