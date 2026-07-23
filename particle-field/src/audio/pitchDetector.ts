/** McLeod Pitch Method (MPM) + spectral-centroid fallback for F0. */

const MIN_HZ = 80;
const MAX_HZ = 1000;

export interface PitchEstimate {
  hz: number;
  confidence: number;
  /** True when autocorrelation peak is trustworthy. */
  reliable: boolean;
}

/**
 * Estimate fundamental frequency from a time-domain buffer.
 * Uses normalized square difference (McLeod-style) with parabolic refinement.
 */
export function estimatePitch(
  time: Float32Array,
  sampleRate: number,
): PitchEstimate {
  const n = time.length;
  if (n < 64 || sampleRate <= 0) {
    return { hz: 0, confidence: 0, reliable: false };
  }

  let mean = 0;
  for (let i = 0; i < n; i++) mean += time[i];
  mean /= n;

  let energy = 0;
  for (let i = 0; i < n; i++) {
    const v = time[i] - mean;
    energy += v * v;
  }
  if (energy < 1e-8) {
    return { hz: 0, confidence: 0, reliable: false };
  }

  const minLag = Math.max(2, Math.floor(sampleRate / MAX_HZ));
  const maxLag = Math.min(n - 2, Math.floor(sampleRate / MIN_HZ));
  if (maxLag <= minLag + 2) {
    return { hz: 0, confidence: 0, reliable: false };
  }

  // NSDF: 2 * r(tau) / (m(tau)) where m is running energy of overlapping windows
  const nsdf = new Float32Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) {
    let ac = 0;
    let m = 0;
    const lim = n - tau;
    for (let i = 0; i < lim; i++) {
      const a = time[i] - mean;
      const b = time[i + tau] - mean;
      ac += a * b;
      m += a * a + b * b;
    }
    nsdf[tau] = m > 1e-12 ? (2 * ac) / m : 0;
  }

  // Find first major peak after zero-crossing into positive NSDF
  let bestTau = -1;
  let bestVal = 0;
  let started = false;
  for (let tau = minLag + 1; tau < maxLag; tau++) {
    const prev = nsdf[tau - 1];
    const cur = nsdf[tau];
    const next = nsdf[tau + 1];
    if (!started) {
      if (cur > 0 && prev <= 0) started = true;
      continue;
    }
    if (cur > 0.3 && cur >= prev && cur >= next && cur > bestVal) {
      bestVal = cur;
      bestTau = tau;
    }
    // After first strong peak cluster, stop searching further harmonics
    if (bestTau > 0 && cur < 0 && tau > bestTau + 2) break;
  }

  if (bestTau < 0) {
    // Fallback: absolute max in lag range
    for (let tau = minLag; tau <= maxLag; tau++) {
      if (nsdf[tau] > bestVal) {
        bestVal = nsdf[tau];
        bestTau = tau;
      }
    }
  }

  if (bestTau < minLag || bestVal < 0.25) {
    return { hz: 0, confidence: Math.max(0, bestVal), reliable: false };
  }

  // Parabolic interpolation around peak
  const y0 = nsdf[bestTau - 1] ?? bestVal;
  const y1 = bestVal;
  const y2 = nsdf[bestTau + 1] ?? bestVal;
  const denom = 2 * (2 * y1 - y2 - y0);
  const shift = Math.abs(denom) > 1e-8 ? (y2 - y0) / denom : 0;
  const refinedLag = bestTau + Math.max(-0.5, Math.min(0.5, shift));
  const hz = sampleRate / refinedLag;

  if (hz < MIN_HZ * 0.9 || hz > MAX_HZ * 1.1) {
    return { hz: 0, confidence: bestVal * 0.5, reliable: false };
  }

  const confidence = Math.max(0, Math.min(1, (bestVal - 0.2) / 0.65));
  return {
    hz,
    confidence,
    reliable: confidence > 0.65,
  };
}

/** Map spectral centroid Hz into the same 80–1000 Hz pseudo-pitch space. */
export function centroidToPseudoPitch(centroidHz: number): number {
  // Centroids sit higher than F0; compress into voice-ish range.
  const mapped = Math.max(MIN_HZ, Math.min(MAX_HZ, centroidHz * 0.22));
  return mapped;
}

/** Log-frequency normalize into 0..1 for shape mixing. */
export function normalizePitchHz(hz: number, minHz = MIN_HZ, maxHz = MAX_HZ): number {
  if (hz <= minHz) return 0;
  if (hz >= maxHz) return 1;
  return Math.log2(hz / minHz) / Math.log2(maxHz / minHz);
}

export { MIN_HZ as PITCH_MIN_HZ, MAX_HZ as PITCH_MAX_HZ };
