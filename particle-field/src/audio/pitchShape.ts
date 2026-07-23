/** Pitch-driven seed shape parameters (shared across all six sectors). */

export interface ShapeParams {
  bendFrequency: number;
  bendAmplitude: number;
  bundleWidth: number;
  tipSharpness: number;
  radialStretch: number;
}

export const LOW_SHAPE: ShapeParams = {
  bendFrequency: 0.8,
  bendAmplitude: 0.32,
  bundleWidth: 1.25,
  tipSharpness: 0.15,
  radialStretch: 1.12,
};

export const MID_SHAPE: ShapeParams = {
  bendFrequency: 1.7,
  bendAmplitude: 0.48,
  bundleWidth: 1.0,
  tipSharpness: 0.42,
  radialStretch: 1.0,
};

export const HIGH_SHAPE: ShapeParams = {
  bendFrequency: 3.2,
  bendAmplitude: 0.16,
  bundleWidth: 0.72,
  tipSharpness: 0.85,
  radialStretch: 1.08,
};

export const NEUTRAL_SHAPE: ShapeParams = { ...MID_SHAPE };

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function mixShape(a: ShapeParams, b: ShapeParams, t: number): ShapeParams {
  const u = Math.min(1, Math.max(0, t));
  return {
    bendFrequency: lerp(a.bendFrequency, b.bendFrequency, u),
    bendAmplitude: lerp(a.bendAmplitude, b.bendAmplitude, u),
    bundleWidth: lerp(a.bundleWidth, b.bundleWidth, u),
    tipSharpness: lerp(a.tipSharpness, b.tipSharpness, u),
    radialStretch: lerp(a.radialStretch, b.radialStretch, u),
  };
}

/** Continuous low↔mid↔high interpolation from normalized pitch. */
export function shapeFromPitch(pitchNormalized: number): ShapeParams {
  if (pitchNormalized < 0.5) {
    return mixShape(LOW_SHAPE, MID_SHAPE, pitchNormalized * 2);
  }
  return mixShape(MID_SHAPE, HIGH_SHAPE, (pitchNormalized - 0.5) * 2);
}

/**
 * Smooth pitch→shape driver with attack/release and low-confidence hold.
 * Shape is computed once and reused for all sector copies.
 */
export class PitchShapeController {
  private shape: ShapeParams = { ...NEUTRAL_SHAPE };
  private heldPitch = 0.45;
  private lastReliablePitch = 0.45;
  private confidence = 0;

  getShape(): ShapeParams {
    return this.shape;
  }

  getHeldPitch(): number {
    return this.heldPitch;
  }

  getConfidence(): number {
    return this.confidence;
  }

  /**
   * @param pitchNormalized raw smoothed pitch 0..1
   * @param pitchConfidence 0..1
   * @param hasSignal whether mic currently has energy
   * @param deltaMs frame delta
   */
  update(
    pitchNormalized: number,
    pitchConfidence: number,
    hasSignal: boolean,
    deltaMs: number,
  ): ShapeParams {
    this.confidence = pitchConfidence;

    let targetPitch = this.heldPitch;
    if (!hasSignal || pitchConfidence < 0.35) {
      // Hold last shape, then slowly return toward mid/neutral
      const release = 1 - Math.exp(-deltaMs / 520);
      targetPitch = lerp(this.lastReliablePitch, 0.45, release * 0.35);
    } else if (pitchConfidence > 0.65) {
      targetPitch = pitchNormalized;
      this.lastReliablePitch = pitchNormalized;
    } else {
      // Weak confidence: blend toward detected, prefer last reliable
      targetPitch = lerp(this.lastReliablePitch, pitchNormalized, 0.35);
    }

    // Hysteresis ~10% so small jitter does not twitch contour
    const delta = targetPitch - this.heldPitch;
    if (Math.abs(delta) < 0.1) {
      targetPitch = this.heldPitch + delta * 0.35;
    }
    this.heldPitch = targetPitch;

    const desired = shapeFromPitch(this.heldPitch);
    // 250–600 ms shape smoothing
    const rising =
      desired.bendFrequency + desired.tipSharpness >
      this.shape.bendFrequency + this.shape.tipSharpness;
    const tau = rising ? 280 : 480;
    const amt = 1 - Math.exp(-Math.max(0, deltaMs) / tau);
    this.shape = mixShape(this.shape, desired, amt);
    return this.shape;
  }

  reset(): void {
    this.shape = { ...NEUTRAL_SHAPE };
    this.heldPitch = 0.45;
    this.lastReliablePitch = 0.45;
    this.confidence = 0;
  }
}
