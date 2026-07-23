/** Fast rise / slow fall smoothing from the spec. */
export function smoothToward(
  previous: number,
  target: number,
  riseFactor = 0.35,
  fallFactor = 0.08,
): number {
  const factor = target > previous ? riseFactor : fallFactor;
  return previous + (target - previous) * factor;
}

/** Frame-rate-independent attack/release envelope. */
export function attackRelease(
  previous: number,
  target: number,
  deltaMs: number,
  attackMs: number,
  releaseMs: number,
): number {
  const tau = Math.max(1, target > previous ? attackMs : releaseMs);
  const amount = 1 - Math.exp(-Math.max(0, deltaMs) / tau);
  return previous + (target - previous) * amount;
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export function softLimit(v: number, knee = 0.85): number {
  if (v <= knee) return v;
  const t = (v - knee) / (1 - knee);
  return knee + (1 - knee) * (1 - Math.exp(-2.2 * t)) / (1 - Math.exp(-2.2));
}
