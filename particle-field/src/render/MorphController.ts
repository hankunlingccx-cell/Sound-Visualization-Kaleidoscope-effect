/** Low-frequency deterministic morph driver for kaleidoscope layers. */

export type SectorCount = 6 | 8 | 10;

export interface MorphUniforms {
  sectorCountA: number;
  sectorCountB: number;
  sectorMix: number; // 0 = A only, 1 = B only
  globalPhase: number;
  layerPhase: [number, number, number, number];
  foldAmount: number;
  lobeDepth: number;
  outerReach: number;
  flowSpeed: number;
  topologyMix: number;
  waveOrderA: number;
  waveOrderB: number;
  angularFlow: number;
  layerWeight: [number, number, number, number];
}

const SECTOR_OPTIONS: SectorCount[] = [6]; // keep six-fold while tuning negative space

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Deterministic hash → 0..1 from integer seeds (no Math.random in render path). */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class MorphController {
  private startMs = performance.now();
  private frozen = false;
  private frozenElapsed = 0;
  private reduceMotion = false;

  private sectorA: SectorCount = 6;
  private sectorB: SectorCount = 6;
  private sectorMix = 1;
  private nextSectorAt = 14; // seconds
  private sectorTransitioning = false;
  private sectorTransitionStart = 0;
  private sectorTransitionDur = 2.0;

  private globalPhase = 0;
  private layerPhase = new Float32Array([0, 0.7, 1.4, 2.1]);

  private foldAmount = 0.58;
  private lobeDepth = 0.16;
  private outerReach = 0.78;
  private flowSpeed = 0.2;
  private topologyMix = 0.48;
  private waveOrderA = 3;
  private waveOrderB = 5;
  private angularFlow = 0.16;
  private layerWeight = new Float32Array([0.55, 0.75, 1.1, 0.8]);

  private foldTarget = 0.58;
  private lobeTarget = 0.16;
  private outerTarget = 0.78;
  private flowTarget = 0.2;
  private topoTarget = 0.48;
  private angFlowTarget = 0.16;
  private weightTargets = new Float32Array([0.55, 0.75, 1.1, 0.8]);

  private nextParamAt = 5.5;
  private paramEpoch = 1;

  setFrozen(frozen: boolean): void {
    if (frozen && !this.frozen) {
      this.frozenElapsed = (performance.now() - this.startMs) * 0.001;
    } else if (!frozen && this.frozen) {
      this.startMs = performance.now() - this.frozenElapsed * 1000;
    }
    this.frozen = frozen;
  }

  setReduceMotion(v: boolean): void {
    this.reduceMotion = v;
  }

  update(): MorphUniforms {
    const t = this.frozen
      ? this.frozenElapsed
      : (performance.now() - this.startMs) * 0.001;

    if (!this.frozen) {
      this.advanceAutonomous(t);
    }

    return {
      sectorCountA: this.sectorA,
      sectorCountB: this.sectorB,
      sectorMix: this.sectorMix,
      globalPhase: this.globalPhase,
      layerPhase: [
        this.layerPhase[0],
        this.layerPhase[1],
        this.layerPhase[2],
        this.layerPhase[3],
      ],
      foldAmount: this.foldAmount,
      lobeDepth: this.lobeDepth,
      outerReach: this.outerReach,
      flowSpeed: this.flowSpeed * (this.reduceMotion ? 0.35 : 1),
      topologyMix: this.topologyMix,
      waveOrderA: this.waveOrderA,
      waveOrderB: this.waveOrderB,
      angularFlow: this.angularFlow * (this.reduceMotion ? 0.4 : 1),
      layerWeight: [
        this.layerWeight[0],
        this.layerWeight[1],
        this.layerWeight[2],
        this.layerWeight[3],
      ],
    };
  }

  private advanceAutonomous(t: number): void {
    const dt = 1 / 60; // approximate; rAF-driven but ok for slow morph
    const phaseRate = this.reduceMotion ? 0.012 : 0.028;
    this.globalPhase += phaseRate * dt;

    // Layer phases drift with alternating directions
    const speeds = [0.055, -0.04, 0.07, -0.09];
    for (let i = 0; i < 4; i++) {
      const s = speeds[i] * (this.reduceMotion ? 0.4 : 1);
      this.layerPhase[i] += s * dt;
    }

    // Soft-follow parameter targets
    const follow = this.reduceMotion ? 0.015 : 0.028;
    this.foldAmount = lerp(this.foldAmount, this.foldTarget, follow);
    this.lobeDepth = lerp(this.lobeDepth, this.lobeTarget, follow);
    this.outerReach = lerp(this.outerReach, this.outerTarget, follow);
    this.flowSpeed = lerp(this.flowSpeed, this.flowTarget, follow);
    this.topologyMix = lerp(this.topologyMix, this.topoTarget, follow);
    this.angularFlow = lerp(this.angularFlow, this.angFlowTarget, follow);
    for (let i = 0; i < 4; i++) {
      this.layerWeight[i] = lerp(this.layerWeight[i], this.weightTargets[i], follow);
    }

    // Retarget morph params every 4–9s
    if (t >= this.nextParamAt) {
      this.pickNewTargets(this.paramEpoch++);
      this.nextParamAt = t + 4 + hash01(this.paramEpoch * 17.3) * 5;
    }

    // Sector count crossfade every 12–24s
    if (!this.sectorTransitioning && t >= this.nextSectorAt) {
      this.beginSectorTransition(t);
    }
    if (this.sectorTransitioning) {
      const u = (t - this.sectorTransitionStart) / this.sectorTransitionDur;
      if (u >= 1) {
        this.sectorA = this.sectorB;
        this.sectorMix = 1;
        this.sectorTransitioning = false;
        this.nextSectorAt = t + 12 + hash01(this.paramEpoch * 9.1) * 12;
      } else {
        this.sectorMix = smoothstep(0, 1, u);
      }
    }
  }

  private beginSectorTransition(t: number): void {
    const cur = this.sectorB;
    let next = cur;
    let guard = 0;
    while (next === cur && guard++ < 8) {
      next = SECTOR_OPTIONS[Math.floor(hash01(t * 0.37 + this.paramEpoch) * 3) % 3];
    }
    this.sectorA = cur;
    this.sectorB = next;
    this.sectorMix = 0;
    this.sectorTransitioning = true;
    this.sectorTransitionStart = t;
    this.sectorTransitionDur = 1.5 + hash01(this.paramEpoch * 3.7) * 1.0;
  }

  private pickNewTargets(epoch: number): void {
    const h = (k: number) => hash01(epoch * 13.1 + k * 7.7);
    this.foldTarget = lerp(0.18, 0.82, h(1));
    this.lobeTarget = lerp(0.05, 0.2, h(2));
    this.outerTarget = lerp(0.48, 0.8, h(3));
    this.flowTarget = lerp(0.09, 0.3, h(4));
    this.topoTarget = lerp(0.1, 0.85, h(5));
    this.angFlowTarget = lerp(0.06, 0.2, h(6));
    this.waveOrderA = 2 + Math.floor(h(7) * 3); // 2..4
    this.waveOrderB = 4 + Math.floor(h(8) * 3); // 4..6

    // Cyclic visual weight handover across layers
    const peak = Math.floor(h(9) * 4);
    for (let i = 0; i < 4; i++) {
      const dist = Math.min(Math.abs(i - peak), 4 - Math.abs(i - peak));
      this.weightTargets[i] = clamp(1.05 - dist * 0.28 + (h(10 + i) - 0.5) * 0.1, 0.45, 1.1);
    }
  }
}
