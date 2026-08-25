export function windowedHistory(history, observedAt, windowMinutes = 24 * 60) {
  const endAt = Date.parse(observedAt);
  const startAt = endAt - windowMinutes * 60_000;
  return history.filter((sample) => {
    const at = Date.parse(sample.at);
    return at >= startAt && at <= endAt;
  });
}

export function splitHistory(samples, cadenceMinutes) {
  const segments = [];
  const maximumContinuousGap = cadenceMinutes * 1.5 * 60_000;
  samples.forEach((sample) => {
    const current = segments.at(-1);
    const prior = current?.at(-1);
    const gap = prior ? Date.parse(sample.at) - Date.parse(prior.at) : 0;
    if (!current || gap > maximumContinuousGap) segments.push([sample]);
    else current.push(sample);
  });
  return segments;
}
