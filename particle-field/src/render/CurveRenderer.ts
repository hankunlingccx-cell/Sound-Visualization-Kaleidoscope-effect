import { MorphController, type MorphUniforms } from './MorphController';
import { PitchShapeController, type ShapeParams } from '../audio/pitchShape';
import type { AudioFeatures } from '../audio/types';

type RenderFeatures = Pick<
  AudioFeatures,
  | 'volume'
  | 'bass'
  | 'mid'
  | 'treble'
  | 'transient'
  | 'centroid'
  | 'spectralFlux'
  | 'onset'
  | 'pitchNormalized'
  | 'pitchConfidence'
  | 'hasSignal'
>;

/** Shared continuous centerline math for ribbons + bead particles. */
const CENTERLINE_GLSL = `
const float TAU = 6.28318530718;

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float smoothNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x),
        mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
        mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y), f.z
  );
}

float layerPhaseOf(float layer, vec4 phases) {
  if (layer < 0.5) return phases.x;
  if (layer < 1.5) return phases.y;
  if (layer < 2.5) return phases.z;
  return phases.w;
}

float layerWeightOf(float layer, vec4 w) {
  if (layer < 0.5) return w.x;
  if (layer < 1.5) return w.y;
  if (layer < 2.5) return w.z;
  return w.w;
}

float layerBaseRadius(float layer, float curveHash, float outerReach) {
  float t = fract(curveHash * 0.917 + 0.13);
  // Core / Inner / Mid / Outer ? outer skeleton starts farther out
  if (layer < 0.5) return mix(0.06, 0.16, t);
  if (layer < 1.5) return mix(0.16, 0.30, t);
  if (layer < 2.5) return mix(0.30, 0.50, t);
  return mix(0.52, clamp(outerReach, 0.62, 0.92), t);
}

float layerWarp(float layer, float foldAmount, float lobeDepth) {
  if (layer < 0.5) return 0.035 + foldAmount * 0.04;
  if (layer < 1.5) return 0.06 + foldAmount * 0.08;
  if (layer < 2.5) return 0.08 + lobeDepth * 0.55;
  return 0.10 + lobeDepth * 0.7;
}

// Returns polar (r, thetaLocal in [0,1]) in the base half-sector.
// Pitch shape params rewrite the single seed; copies reuse the same geometry.
// Volume only modulates brightness-linked wave amp + slight radial expansion.
vec2 polarLocal(
  float u,
  float curveId,
  float layer,
  float rnd,
  float phase,
  float time,
  float volume,
  float treble,
  float transient,
  float foldAmount,
  float lobeDepth,
  float outerReach,
  float flowSpeed,
  float topologyMix,
  float waveOrderA,
  float waveOrderB,
  float angularFlow,
  vec4 layerPhase,
  vec4 pulsePosition,
  vec4 pulseAmplitude,
  float bendFrequency,
  float bendAmplitude,
  float tipSharpness,
  float radialStretch
) {
  float lp = layerPhaseOf(layer, layerPhase);
  float morph = time * flowSpeed;
  float n0 = smoothNoise3(vec3(curveId * 0.17, u * 1.35, morph * 0.065));
  float correlated = (n0 - 0.5) * 2.0;

  float inner = 1.0 - step(0.5, layer);
  float outer = step(2.5, layer);
  float middle = 1.0 - inner - outer;

  // Pitch owns geometry; autonomous morph is a soft base (~40%).
  float pitchW = 0.72;
  float autoW = 1.0 - pitchW;

  float bendFreq = mix(waveOrderA * 0.45, bendFrequency, pitchW);
  float bendAmp = mix(lobeDepth * 1.1, bendAmplitude, pitchW);
  float tipPow = mix(1.0, mix(0.78, 1.55, tipSharpness), pitchW);
  float stretch = mix(1.0, radialStretch, pitchW);
  // Mid-pitch fold peak: bendAmplitude is highest around mid shape
  float foldDrive = mix(foldAmount, bendAmplitude * 1.35, pitchW);

  float waveA = sin(u * TAU * bendFreq + morph * 0.23 + curveId + phase);
  float waveB = cos(u * TAU * mix(waveOrderB, bendFreq * 1.35, pitchW) - morph * 0.17 + layer + lp);
  float warp = layerWarp(layer, foldDrive, bendAmp * 0.55);

  // Stable angular homes evenly spanning half-sector [0,1].
  // Do NOT smoothstep homes toward center ? that periodically opens C-gaps at seams.
  float home = fract(curveId * 0.61803398875 + rnd * 0.05 + layer * 0.11);
  home = mix(0.03, 0.97, home);
  // Dedicated outer edge rails (alternate near 0 / near 1)
  float rail = mix(0.05, 0.95, step(0.5, fract(curveId * 0.37 + rnd)));
  float seedA = mix(home, rail, outer * 0.7);
  float seedB = mix(clamp(home + 0.33, 0.03, 0.97), 1.0 - rail, outer * 0.55);
  seedB = clamp(seedB, 0.03, 0.97);

  // Cap angular wobble so neighbors cannot open a lasting hole
  float maxWobble = mix(0.08, 0.045, tipSharpness);
  maxWobble *= mix(1.0, 0.4, abs(seedA - 0.5) * 2.0); // quieter near seams
  maxWobble = max(maxWobble, 0.025);

  // Mid fills wedge with moderate sweep; outer = circumferential skeleton arcs
  float angTravel = mix(0.42, 0.22, tipSharpness);
  angTravel = mix(angTravel, mix(0.92, 0.7, tipSharpness), outer);

  // --- Topology A: arc ribbon / nested loop (low: wide round) ---
  float baseA = layerBaseRadius(layer, curveId + rnd, outerReach * stretch);
  float spanA = inner * 0.10 + middle * mix(0.18, 0.30, step(1.5, layer)) + outer * 0.38;
  // Low pitch ? wider radial fill; high pitch ? delayed tip growth
  spanA *= mix(1.18, 0.82, tipSharpness);
  float uRad = pow(clamp(u, 0.0, 1.0), tipPow);
  float rA = baseA + spanA * uRad * stretch;
  rA += autoW * warp * (0.58 * waveA + 0.42 * waveB);
  rA += pitchW * bendAmp * (0.55 * waveA + 0.35 * waveB) * mix(1.15, 0.55, tipSharpness);
  rA += autoW * correlated * (0.014 + middle * 0.02);

  // Angular fold: mid pitch maximizes S-curve / petal fold (amplitude capped)
  float foldAng = (0.05 + foldDrive * 0.10) * sin(u * TAU * bendFreq + phase + morph * 0.15);
  float midFold = 1.0 - abs(tipSharpness - 0.42) * 2.2;
  midFold = clamp(midFold, 0.0, 1.0);
  foldAng += midFold * 0.07 * sin(u * TAU * (bendFreq * 0.5) + phase * 1.7 - morph * 0.09);
  foldAng += tipSharpness * 0.035 * sin(u * TAU * (bendFreq * 1.8) + curveId);
  foldAng = clamp(foldAng, -maxWobble, maxWobble);

  // Direction of circumferential sweep for outer skeleton (+/- alternate)
  float sweepDir = mix(1.0, -1.0, step(0.5, fract(curveId * 0.5 + rnd * 0.3)));
  float thA = seedA
    + sweepDir * angTravel * (u - 0.5)
    + autoW * 0.04 * sin(u * TAU * mix(1.1, 2.0, n0) + phase + morph * 0.12)
    + pitchW * foldAng
    + autoW * 0.025 * sin(u * TAU * waveOrderB - morph * 0.1 + lp);
  thA = clamp(thA, 0.02, 0.98);

  // --- Topology B: radial tendril / open arc (outer skeleton) ---
  float baseB = layerBaseRadius(layer, curveId + rnd + 3.1, outerReach * stretch);
  float reachB = mix(0.22, 0.62, outer * 0.85 + middle * 0.55) * stretch;
  reachB *= mix(1.15, 0.88, tipSharpness);
  float rB = baseB + reachB * pow(u, mix(0.72, 1.35, tipSharpness));
  rB += autoW * warp * 0.75 * sin(u * TAU * (bendFreq * 0.5) + morph * 0.19 + phase);
  rB += pitchW * bendAmp * 0.7 * sin(u * TAU * bendFreq + morph * 0.19 + phase);
  rB += autoW * correlated * 0.02;
  // Outer: nearly full half-sector arc (skeleton ring); others: home + travel
  float outerU = mix(u, 1.0 - u, step(0.5, fract(curveId * 0.5)));
  float thB = mix(
    seedB + angTravel * (u - 0.5),
    mix(0.04, 0.96, outerU),
    outer
  );
  thB += clamp(
    pitchW * foldAng * 0.7
      + autoW * 0.035 * sin(u * TAU * 1.6 + phase - morph * 0.13)
      + tipSharpness * outer * 0.04 * sin(pow(u, 1.35) * TAU * bendFreq + phase),
    -maxWobble,
    maxWobble
  );
  thB = clamp(thB, 0.02, 0.98);

  // Keep topology away from extremes that collapse sector fill
  float topo = smoothstep(0.0, 1.0, mix(topologyMix, tipSharpness * 0.45 + 0.3, pitchW * 0.45));
  topo = clamp(topo, 0.25, 0.75);
  topo = mix(topo, mix(0.45, 0.7, tipSharpness), outer * 0.5);
  float r = mix(rA, rB, topo);
  float th = mix(thA, thB, topo);

  // Volume: fluctuation amplitude + slight expansion (NOT shape type)
  float volWave = volume * (0.012 + tipSharpness * 0.006);
  r += volWave * sin(morph * 0.31 + lp + u * TAU);
  r *= 1.0 + volume * 0.045;
  // Timbre (treble) ? fine texture density only, small amp
  th += treble * 0.012 * sin(u * TAU * (bendFreq * 2.2) - morph * 0.2 + curveId);
  r += treble * 0.008 * outer * sin(u * TAU * 4.0 + phase);

  // Travelling burst wave from center (transient/onset) -- secondary feedback
  float rNorm = clamp(r / max(outerReach * stretch, 0.55), 0.0, 1.2);
  float pulse = 0.0;
  for (int i = 0; i < 4; i++) {
    float d = rNorm - pulsePosition[i];
    pulse += pulseAmplitude[i] * exp(-(d * d) / 0.0065);
  }
  r += pulse * (0.028 + middle * 0.03 + outer * 0.042);
  th += clamp(pulse * 0.018 * sin(curveId * 2.3 + u * TAU + lp), -maxWobble, maxWobble);
  r += transient * 0.014 * outer * sin(u * TAU * 3.0 + morph);

  // Outer skeleton stays extended ? no periodic retract (was causing incomplete lobes)
  if (outer > 0.5) {
    float breathe = 0.92 + 0.08 * sin(lp * 0.7 + curveId * 1.3 + morph * 0.05);
    r *= breathe;
  }

  float rMax = outerReach * stretch + outer * mix(0.20, 0.12, tipSharpness);
  r = clamp(r, 0.04, rMax);
  th = clamp(th, 0.02, 0.98);
  return vec2(r, th);
}
`;

const LINE_FRAG = `#version 300 es
precision mediump float;
in float vAlpha;
in float vColorMix;
in float vPitch;
in float vTransient;
out vec4 fragColor;
void main() {
  // Pitch tint: low lake-blue ? mid mint (primary) ? high ice; onset soft mauve
  vec3 lowCol = vec3(0.310, 0.663, 0.910);   // #4FA9E8
  vec3 midCol = vec3(0.388, 0.878, 0.796);   // #63E0CB primary
  vec3 highCol = vec3(0.851, 1.000, 0.973);  // #D9FFF8
  vec3 onsetCol = vec3(0.847, 0.475, 0.784); // #D879C8
  float p = clamp(vPitch, 0.0, 1.0);
  vec3 pitchCol = p < 0.5
    ? mix(lowCol, midCol, p * 2.0)
    : mix(midCol, highCol, (p - 0.5) * 2.0);
  // Keep mint as stable base ? high pitch never fully washes white
  pitchCol = mix(midCol, pitchCol, 0.72);
  vec3 col = mix(pitchCol, onsetCol, clamp(vTransient, 0.0, 1.0) * 0.45);
  col = mix(col, midCol, 0.18);
  fragColor = vec4(col, vAlpha);
}
`;

const BEAD_VERT = `#version 300 es
layout(location = 0) in vec4 aSeed; // curveId, layer, phase, rnd
layout(location = 1) in float aU0;
layout(location = 2) in vec2 aCopy;

uniform float uTime;
uniform float uVolume;
uniform float uTreble;
uniform float uTransient;
uniform float uFlux;
uniform float uCentroid;
uniform float uPitchNorm;
uniform float uBendFrequency;
uniform float uBendAmplitude;
uniform float uBundleWidth;
uniform float uTipSharpness;
uniform float uRadialStretch;
uniform float uAspect;
uniform float uBreath;
uniform float uReduceMotion;
uniform float uAlphaMul;
uniform float uBeadSpeed;

uniform float uSectorCount;
uniform float uGlobalPhase;
uniform vec4 uLayerPhase;
uniform float uFoldAmount;
uniform float uLobeDepth;
uniform float uOuterReach;
uniform float uFlowSpeed;
uniform float uTopologyMix;
uniform float uWaveOrderA;
uniform float uWaveOrderB;
uniform float uAngularFlow;
uniform vec4 uLayerWeight;
uniform vec4 uPulsePosition;
uniform vec4 uPulseAmplitude;

out float vAlpha;
out float vColorMix;
out float vPitch;
out float vTransient;

${CENTERLINE_GLSL}

vec2 toCartesian(vec2 polar, float sectorCount, float rotationIndex, float mirrorSign, float globalPhase, float aspect) {
  float sectorAngle = TAU / max(sectorCount, 1.0);
  float sectorHalf = sectorAngle * 0.5;
  float theta = rotationIndex * sectorAngle
              + mirrorSign * (polar.y * sectorHalf)
              + globalPhase;
  // Scale radius/position only (~25%); pixel line width & spacing stay unchanged
  vec2 p = vec2(cos(theta), sin(theta)) * (polar.x * 1.25);
  p.x /= max(aspect, 0.001);
  return p;
}

void main() {
  float sectorCount = max(uSectorCount, 1.0);
  if (aCopy.x >= sectorCount) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    vColorMix = 0.0;
    vPitch = uPitchNorm;
    vTransient = 0.0;
    return;
  }

  float curveId = aSeed.x;
  float layer = aSeed.y;
  float phase = aSeed.z;
  float rnd = aSeed.w;
  float speed = uBeadSpeed * mix(0.7, 1.3, rnd) * (1.0 - 0.55 * uReduceMotion);
  float u = fract(aU0 + uTime * speed + phase * 0.01);

  float effectiveVol = max(uVolume, uBreath * 0.025);
  vec2 pol = polarLocal(
    u, curveId, layer, rnd, phase, uTime,
    effectiveVol, uTreble, uTransient,
    uFoldAmount, uLobeDepth, uOuterReach, uFlowSpeed, uTopologyMix,
    uWaveOrderA, uWaveOrderB, uAngularFlow, uLayerPhase,
    uPulsePosition, uPulseAmplitude,
    uBendFrequency, uBendAmplitude, uTipSharpness, uRadialStretch
  );
  vec2 p = toCartesian(pol, sectorCount, aCopy.x, aCopy.y, uGlobalPhase, uAspect);

  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = mix(0.55, 0.85, rnd) + effectiveVol * 0.12;
  float lw = layerWeightOf(layer, uLayerWeight);
  // Volume ? brightness; transient ? brief sparkle
  vAlpha = (0.055 + 0.10 * effectiveVol + uTransient * 0.05) * lw * uAlphaMul;
  vColorMix = clamp(0.35 + uCentroid * 0.25 + rnd * 0.15, 0.0, 1.0);
  vPitch = uPitchNorm;
  vTransient = uTransient;
}
`;

const BEAD_FRAG = `#version 300 es
precision mediump float;
in float vAlpha;
in float vColorMix;
in float vPitch;
in float vTransient;
out vec4 fragColor;
void main() {
  vec2 p = gl_PointCoord - vec2(0.5);
  float d = length(p);
  if (d > 0.5) discard;
  float g = smoothstep(0.5, 0.0, d);
  vec3 lowCol = vec3(0.310, 0.663, 0.910);
  vec3 midCol = vec3(0.388, 0.878, 0.796);
  vec3 highCol = vec3(0.851, 1.000, 0.973);
  vec3 onsetCol = vec3(0.847, 0.475, 0.784);
  float pn = clamp(vPitch, 0.0, 1.0);
  vec3 pitchCol = pn < 0.5
    ? mix(lowCol, midCol, pn * 2.0)
    : mix(midCol, highCol, (pn - 0.5) * 2.0);
  pitchCol = mix(midCol, pitchCol, 0.72);
  vec3 col = mix(pitchCol, onsetCol, clamp(vTransient, 0.0, 1.0) * 0.5);
  fragColor = vec4(col, g * vAlpha);
}
`;

const QUAD_VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const DECAY_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D uPrev;
uniform float uDecay;
in vec2 vUv;
out vec4 fragColor;
void main() {
  fragColor = vec4(texture(uPrev, vUv).rgb * uDecay, 1.0);
}
`;

const BLOOM_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uDirection;
uniform float uThreshold;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 texel = uDirection;
  vec3 c = texture(uTex, vUv).rgb;
  float bright = max(max(c.r, c.g), c.b);
  vec3 sum = c * step(uThreshold, bright) * 0.227027;
  sum += texture(uTex, vUv + texel * 1.384615).rgb * 0.316216;
  sum += texture(uTex, vUv - texel * 1.384615).rgb * 0.316216;
  sum += texture(uTex, vUv + texel * 3.230769).rgb * 0.070270;
  sum += texture(uTex, vUv - texel * 3.230769).rgb * 0.070270;
  fragColor = vec4(sum, 1.0);
}
`;

const COMPOSITE_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 scene = texture(uScene, vUv).rgb;
  vec3 bloom = texture(uBloom, vUv).rgb;
  vec3 color = scene + bloom * uBloomStrength;
  color = color / (1.0 + color * 0.7);
  fragColor = vec4(color, 1.0);
}
`;

const COPY_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 fragColor;
void main() {
  fragColor = vec4(texture(uTex, vUv).rgb, 1.0);
}
`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(log || 'Shader compile failed');
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(log || 'Program link failed');
  }
  return prog;
}

interface Fbo {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

function createFbo(gl: WebGL2RenderingContext, w: number, h: number): Fbo {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, w, h };
}

export type QualityTier = 'high' | 'medium' | 'low' | 'fallback';

interface TierConfig {
  strands: number;
  samples: number;
  curves: [number, number, number, number]; // per layer
  beads: number;
  spacingPx: number;
  lineHalfPx: number;
}

const TIER: Record<QualityTier, TierConfig> = {
  // Budget prioritizes parallel strands while staying interactive
  // curves: [core, inner, mid, outer] ? outer skeleton boosted
  high: { strands: 16, samples: 128, curves: [2, 3, 3, 4], beads: 20, spacingPx: 1.6, lineHalfPx: 0.45 },
  medium: { strands: 12, samples: 96, curves: [2, 3, 3, 4], beads: 12, spacingPx: 1.8, lineHalfPx: 0.45 },
  low: { strands: 9, samples: 80, curves: [1, 2, 3, 3], beads: 8, spacingPx: 2.1, lineHalfPx: 0.5 },
  fallback: { strands: 7, samples: 64, curves: [1, 2, 2, 3], beads: 4, spacingPx: 2.4, lineHalfPx: 0.5 },
};

const MAX_SECTORS = 10;

export class CurveRenderer {
  private gl: WebGL2RenderingContext;
  private ribbonProg: WebGLProgram;
  private beadProg: WebGLProgram;
  private decayProg: WebGLProgram;
  private bloomProg: WebGLProgram;
  private compositeProg: WebGLProgram;
  private copyProg: WebGLProgram;

  private ribbonVao: WebGLVertexArrayObject;
  private beadVao: WebGLVertexArrayObject;
  private quadVao: WebGLVertexArrayObject;
  private ribbonVertCount = 0;
  private ribbonInstanceCount = 0;
  private beadCount = 0;
  private beadInstanceCount = 0;

  private quality: QualityTier = 'medium';
  private usePost = true;
  private morph = new MorphController();
  private pitchShape = new PitchShapeController();
  private tierCfg = TIER.medium;
  private activeShape: ShapeParams = this.pitchShape.getShape();
  private heldPitchNorm = 0.45;

  private trailA: Fbo | null = null;
  private trailB: Fbo | null = null;
  private bloomA: Fbo | null = null;
  private bloomB: Fbo | null = null;
  private currTrailIsA = true;

  private uRibbon: Record<string, WebGLUniformLocation | null> = {};
  private uBead: Record<string, WebGLUniformLocation | null> = {};

  private startMs = performance.now();
  private frozen = false;
  private frozenTime = 0;
  private reduceMotion = false;
  private cssW = 1;
  private cssH = 1;
  private lastActiveSectors = 6;
  private elementCount = 0;
  private pulsePositions = new Float32Array([-2, -2, -2, -2]);
  private pulseAmplitudes = new Float32Array(4);
  private nextPulseSlot = 0;
  private lastPulseTriggerMs = -Infinity;
  private lastRenderMs = performance.now();

  private fpsFrames = 0;
  private fpsLast = performance.now();
  private fps = 60;
  private lowFpsMs = 0;

  constructor(canvas: HTMLCanvasElement, quality: QualityTier = 'medium') {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;
    // High: short trail + low Bloom; Medium/Low: weak trail only; Fallback: direct
    this.usePost = quality === 'high';
    this.tierCfg = TIER[quality];
    this.quality = quality;

    const lineVertSrc = buildLineVert();
    this.ribbonProg = link(gl, lineVertSrc, LINE_FRAG);
    this.beadProg = link(gl, BEAD_VERT, BEAD_FRAG);
    this.decayProg = link(gl, QUAD_VERT, DECAY_FRAG);
    this.bloomProg = link(gl, QUAD_VERT, BLOOM_FRAG);
    this.compositeProg = link(gl, QUAD_VERT, COMPOSITE_FRAG);
    this.copyProg = link(gl, QUAD_VERT, COPY_FRAG);

    this.ribbonVao = gl.createVertexArray()!;
    this.beadVao = gl.createVertexArray()!;
    this.quadVao = this.createQuadVao();
    this.cacheUniforms();
    this.rebuildGeometry();

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  }

  setReduceMotion(v: boolean): void {
    this.reduceMotion = v;
    this.morph.setReduceMotion(v);
  }

  setFrozen(frozen: boolean): void {
    if (frozen && !this.frozen) {
      this.frozenTime = (performance.now() - this.startMs) * 0.001;
    }
    this.frozen = frozen;
    this.morph.setFrozen(frozen);
  }

  setQuality(tier: QualityTier): void {
    if (tier === this.quality) return;
    this.quality = tier;
    this.tierCfg = TIER[tier];
    this.usePost = tier === 'high';
    this.rebuildGeometry();
    this.resize(this.cssW, this.cssH);
  }

  getFps(): number {
    return this.fps;
  }

  getQuality(): QualityTier {
    return this.quality;
  }

  /** Approx visible elements for debug (curves ? strands ? sectors ? 2). */
  getParticleCount(): number {
    return this.elementCount;
  }

  resize(cssW: number, cssH: number): void {
    this.cssW = cssW;
    this.cssH = cssH;
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 2 : 1.5);
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    this.disposeFbos();
    if (this.usePost) {
      this.trailA = createFbo(gl, w, h);
      this.trailB = createFbo(gl, w, h);
      const bw = Math.max(1, Math.floor(w / 4));
      const bh = Math.max(1, Math.floor(h / 4));
      this.bloomA = createFbo(gl, bw, bh);
      this.bloomB = createFbo(gl, bw, bh);
      this.clearFbo(this.trailA);
      this.clearFbo(this.trailB);
    }
  }

  render(features: RenderFeatures): void {
    const gl = this.gl;
    const now = performance.now();
    const dt = Math.min(0.08, Math.max(0, (now - this.lastRenderMs) * 0.001));
    const deltaMs = dt * 1000;
    this.lastRenderMs = now;
    this.activeShape = this.pitchShape.update(
      features.pitchNormalized ?? 0.45,
      features.pitchConfidence ?? 0,
      features.hasSignal ?? features.volume > 0.04,
      deltaMs,
    );
    this.heldPitchNorm = this.pitchShape.getHeldPitch();
    this.updatePulses(dt, now, features.onset, features.spectralFlux);
    this.updateFps(now);
    const t = this.frozen ? this.frozenTime : (now - this.startMs) * 0.001;
    const breath = this.frozen ? 0.35 : 0.5 + 0.5 * Math.sin(t * 0.8);
    const aspect = this.cssW / Math.max(this.cssH, 1);
    const morph = this.morph.update();
    this.lastActiveSectors = Math.round(
      morph.sectorCountA * (1 - morph.sectorMix) + morph.sectorCountB * morph.sectorMix,
    );
    const curveTotal = this.tierCfg.curves.reduce((a, b) => a + b, 0);
    this.elementCount = curveTotal * this.tierCfg.strands * this.lastActiveSectors * 2;

    if (!this.usePost || !this.trailA || !this.trailB) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clearColor(0.02, 0.012, 0.035, 1); // #050309
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drawField(t, breath, aspect, features, morph);
      return;
    }

    const read = this.currTrailIsA ? this.trailA : this.trailB;
    const write = this.currTrailIsA ? this.trailB : this.trailA;
    const decay = this.reduceMotion
      ? 0.55
      : this.quality === 'high'
        ? 0.76
        : this.quality === 'medium'
          ? 0.72
          : 0.68;

    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
    gl.viewport(0, 0, write.w, write.h);
    gl.disable(gl.BLEND);
    gl.useProgram(this.decayProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, read.tex);
    gl.uniform1i(gl.getUniformLocation(this.decayProg, 'uPrev'), 0);
    gl.uniform1f(gl.getUniformLocation(this.decayProg, 'uDecay'), decay);
    this.drawQuad();

    this.drawField(t, breath, aspect, features, morph);
    this.currTrailIsA = !this.currTrailIsA;
    const sceneTex = write.tex;

    let bloomTex = sceneTex;
    const doBloom =
      !!this.bloomA &&
      !!this.bloomB &&
      (this.quality === 'high') &&
      !this.reduceMotion;

    if (doBloom && this.bloomA && this.bloomB) {
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fbo);
      gl.viewport(0, 0, this.bloomA.w, this.bloomA.h);
      gl.useProgram(this.bloomProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.uniform1i(gl.getUniformLocation(this.bloomProg, 'uTex'), 0);
      gl.uniform1f(gl.getUniformLocation(this.bloomProg, 'uThreshold'), 0.88);
      gl.uniform2f(gl.getUniformLocation(this.bloomProg, 'uDirection'), 1 / this.bloomA.w, 0);
      this.drawQuad();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB.fbo);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex);
      gl.uniform2f(gl.getUniformLocation(this.bloomProg, 'uDirection'), 0, 1 / this.bloomA.h);
      this.drawQuad();
      bloomTex = this.bloomB.tex;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.BLEND);
    if (doBloom) {
      gl.useProgram(this.compositeProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.uniform1i(gl.getUniformLocation(this.compositeProg, 'uScene'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bloomTex);
      gl.uniform1i(gl.getUniformLocation(this.compositeProg, 'uBloom'), 1);
      gl.uniform1f(
        gl.getUniformLocation(this.compositeProg, 'uBloomStrength'),
        this.quality === 'high' ? 0.08 : 0.05,
      );
    } else {
      gl.useProgram(this.copyProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.uniform1i(gl.getUniformLocation(this.copyProg, 'uTex'), 0);
    }
    this.drawQuad();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  }

  private drawField(
    t: number,
    breath: number,
    aspect: number,
    features: RenderFeatures,
    morph: MorphUniforms,
  ): void {
    const mix = morph.sectorMix;
    const needsCrossfade =
      morph.sectorCountA !== morph.sectorCountB && mix < 0.999;
    if (needsCrossfade) {
      this.drawPass(t, breath, aspect, features, morph, morph.sectorCountA, 1 - mix);
      this.drawPass(t, breath, aspect, features, morph, morph.sectorCountB, mix);
    } else {
      this.drawPass(t, breath, aspect, features, morph, morph.sectorCountB, 1);
    }
  }

  private drawPass(
    t: number,
    breath: number,
    aspect: number,
    features: RenderFeatures,
    morph: MorphUniforms,
    sectorCount: number,
    alphaMul: number,
  ): void {
    if (alphaMul < 0.01) return;
    this.drawRibbons(t, breath, aspect, features, morph, sectorCount, alphaMul);
    this.drawBeads(t, breath, aspect, features, morph, sectorCount, alphaMul * 0.85);
  }

  private setMorphUniforms(
    u: Record<string, WebGLUniformLocation | null>,
    morph: MorphUniforms,
    sectorCount: number,
    alphaMul: number,
    t: number,
    breath: number,
    aspect: number,
    features: RenderFeatures,
  ): void {
    const gl = this.gl;
    const shape = this.activeShape;
    gl.uniform1f(u.uTime!, t);
    gl.uniform1f(u.uVolume!, features.volume);
    gl.uniform1f(u.uTreble!, features.treble);
    gl.uniform1f(u.uTransient!, features.transient);
    gl.uniform1f(u.uFlux!, features.spectralFlux);
    gl.uniform1f(u.uCentroid!, features.centroid);
    gl.uniform1f(u.uPitchNorm!, this.heldPitchNorm);
    gl.uniform1f(u.uBendFrequency!, shape.bendFrequency);
    gl.uniform1f(u.uBendAmplitude!, shape.bendAmplitude);
    gl.uniform1f(u.uBundleWidth!, shape.bundleWidth);
    gl.uniform1f(u.uTipSharpness!, shape.tipSharpness);
    gl.uniform1f(u.uRadialStretch!, shape.radialStretch);
    gl.uniform1f(u.uAspect!, aspect);
    gl.uniform1f(u.uBreath!, breath);
    gl.uniform1f(u.uReduceMotion!, this.reduceMotion ? 1 : 0);
    gl.uniform1f(u.uAlphaMul!, alphaMul);
    gl.uniform1f(u.uSectorCount!, sectorCount);
    gl.uniform1f(u.uGlobalPhase!, morph.globalPhase);
    gl.uniform4f(
      u.uLayerPhase!,
      morph.layerPhase[0],
      morph.layerPhase[1],
      morph.layerPhase[2],
      morph.layerPhase[3],
    );
    // Pitch also nudges autonomous morph toward matching contour
    const pitchFold = shape.bendAmplitude * 1.15;
    const pitchOuter = morph.outerReach * shape.radialStretch;
    gl.uniform1f(u.uFoldAmount!, morph.foldAmount * 0.35 + pitchFold * 0.65);
    gl.uniform1f(u.uLobeDepth!, morph.lobeDepth * 0.3 + shape.bendAmplitude * 0.45);
    gl.uniform1f(u.uOuterReach!, pitchOuter);
    gl.uniform1f(u.uFlowSpeed!, morph.flowSpeed);
    gl.uniform1f(u.uTopologyMix!, morph.topologyMix);
    gl.uniform1f(u.uWaveOrderA!, morph.waveOrderA);
    gl.uniform1f(u.uWaveOrderB!, morph.waveOrderB);
    gl.uniform1f(u.uAngularFlow!, morph.angularFlow);
    gl.uniform4f(
      u.uLayerWeight!,
      morph.layerWeight[0],
      morph.layerWeight[1],
      morph.layerWeight[2],
      morph.layerWeight[3],
    );
    gl.uniform4fv(u.uPulsePosition!, this.pulsePositions);
    gl.uniform4fv(u.uPulseAmplitude!, this.pulseAmplitudes);
  }

  private drawRibbons(
    t: number,
    breath: number,
    aspect: number,
    features: RenderFeatures,
    morph: MorphUniforms,
    sectorCount: number,
    alphaMul: number,
  ): void {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    // Spec: SRC_ALPHA, ONE additive; overlaps brighten naturally
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.useProgram(this.ribbonProg);
    gl.bindVertexArray(this.ribbonVao);
    this.setMorphUniforms(this.uRibbon, morph, sectorCount, alphaMul, t, breath, aspect, features);
    gl.uniform1f(this.uRibbon.uViewportY!, gl.drawingBufferHeight);
    gl.uniform1f(this.uRibbon.uLineHalfPx!, this.tierCfg.lineHalfPx);
    gl.uniform1f(this.uRibbon.uBundleSpacingPx!, this.tierCfg.spacingPx);
    gl.uniform1f(this.uRibbon.uSamplesPerCurve!, this.tierCfg.samples);
    gl.drawArraysInstanced(gl.LINES, 0, this.ribbonVertCount, this.ribbonInstanceCount);
    gl.bindVertexArray(null);
  }

  private drawBeads(
    t: number,
    breath: number,
    aspect: number,
    features: RenderFeatures,
    morph: MorphUniforms,
    sectorCount: number,
    alphaMul: number,
  ): void {
    if (this.beadCount <= 0) return;
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.useProgram(this.beadProg);
    gl.bindVertexArray(this.beadVao);
    this.setMorphUniforms(this.uBead, morph, sectorCount, alphaMul, t, breath, aspect, features);
    // Spectral flux / treble ? detail motion only
    gl.uniform1f(
      this.uBead.uBeadSpeed!,
      0.025 + features.spectralFlux * 0.1 + features.treble * 0.02,
    );
    gl.drawArraysInstanced(gl.POINTS, 0, this.beadCount, this.beadInstanceCount);
    gl.bindVertexArray(null);
  }

  private rebuildGeometry(): void {
    const gl = this.gl;
    const { strands, samples, curves, beads, spacingPx } = this.tierCfg;
    void spacingPx;

    // Base curve segments once; kaleidoscope copies via instancing (rot ? mirror)
    const verts: number[] = [];
    let curveId = 0;
    for (let layer = 0; layer < 4; layer++) {
      const nCurves = curves[layer];
      for (let c = 0; c < nCurves; c++) {
        const cid = curveId + 0.17;
        const phase = ((c * 0.618 + layer * 1.7) % 1) * Math.PI * 2;
        const rnd = (Math.sin(cid * 12.9898) * 43758.5453) % 1;
        const rndAbs = rnd - Math.floor(rnd);
        for (let s = 0; s < strands; s++) {
          const strandOffset = s - (strands - 1) * 0.5;
          const lineRole = Math.abs(strandOffset) < 0.6 ? 0 : 1;
          for (let i = 0; i < samples - 1; i++) {
            const u0 = i / (samples - 1);
            const u1 = (i + 1) / (samples - 1);
            for (const u of [u0, u1]) {
              verts.push(u, cid, layer, strandOffset, lineRole, phase, rndAbs, 0);
            }
          }
        }
        curveId += 1;
      }
    }

    const ribbonData = new Float32Array(verts);
    this.ribbonVertCount = verts.length / 8;

    const copies: number[] = [];
    for (let rot = 0; rot < MAX_SECTORS; rot++) {
      copies.push(rot, 1);
      copies.push(rot, -1);
    }
    this.ribbonInstanceCount = copies.length / 2;

    gl.bindVertexArray(this.ribbonVao);
    const ribbonBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, ribbonBuf);
    gl.bufferData(gl.ARRAY_BUFFER, ribbonData, gl.STATIC_DRAW);
    const stride = 8 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(0, 0);
    gl.vertexAttribDivisor(1, 0);

    const copyBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, copyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(copies), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 8, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);

    // Beads: base seeds + same sector instances
    const beadVerts: number[] = [];
    for (let i = 0; i < beads; i++) {
      const layer = i % 4;
      const maxC = Math.max(1, curves[layer]);
      const cLocal = (i * 7) % maxC;
      let cid = cLocal;
      for (let L = 0; L < layer; L++) cid += curves[L];
      const seed0 = cid + 0.17;
      const seed1 = layer;
      const seed2 = (i * 0.37) % (Math.PI * 2);
      let seed3 = (Math.sin(i * 19.1) * 43758.5453) % 1;
      seed3 -= Math.floor(seed3);
      const u0 = (i * 0.173) % 1;
      beadVerts.push(seed0, seed1, seed2, seed3, u0);
    }
    this.beadCount = beadVerts.length / 5;
    this.beadInstanceCount = this.ribbonInstanceCount;

    gl.bindVertexArray(this.beadVao);
    const beadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, beadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(beadVerts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, 16);
    gl.vertexAttribDivisor(0, 0);
    gl.vertexAttribDivisor(1, 0);

    const beadCopyBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, beadCopyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(copies), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 8, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
  }

  private createQuadVao(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  private cacheUniforms(): void {
    const names = [
      'uTime',
      'uVolume',
      'uTreble',
      'uTransient',
      'uFlux',
      'uCentroid',
      'uPitchNorm',
      'uBendFrequency',
      'uBendAmplitude',
      'uBundleWidth',
      'uTipSharpness',
      'uRadialStretch',
      'uAspect',
      'uBreath',
      'uReduceMotion',
      'uAlphaMul',
      'uSectorCount',
      'uGlobalPhase',
      'uLayerPhase',
      'uFoldAmount',
      'uLobeDepth',
      'uOuterReach',
      'uFlowSpeed',
      'uTopologyMix',
      'uWaveOrderA',
      'uWaveOrderB',
      'uAngularFlow',
      'uLayerWeight',
      'uPulsePosition',
      'uPulseAmplitude',
      'uViewportY',
      'uLineHalfPx',
      'uBundleSpacingPx',
      'uSamplesPerCurve',
      'uBeadSpeed',
    ];
    for (const n of names) {
      this.uRibbon[n] = this.gl.getUniformLocation(this.ribbonProg, n);
      this.uBead[n] = this.gl.getUniformLocation(this.beadProg, n);
    }
  }

  private updatePulses(
    dt: number,
    nowMs: number,
    onset: number,
    spectralFlux: number,
  ): void {
    for (let i = 0; i < 4; i++) {
      if (this.pulseAmplitudes[i] <= 0.002) {
        this.pulseAmplitudes[i] = 0;
        this.pulsePositions[i] = -2;
        continue;
      }
      this.pulsePositions[i] += dt * (0.62 + spectralFlux * 0.32);
      this.pulseAmplitudes[i] *= Math.exp(-dt / 0.58);
      if (this.pulsePositions[i] > 1.25) this.pulseAmplitudes[i] = 0;
    }

    if (onset > 0.08 && nowMs - this.lastPulseTriggerMs > 140) {
      const i = this.nextPulseSlot;
      this.pulsePositions[i] = 0.02;
      this.pulseAmplitudes[i] = Math.min(1, 0.38 + onset * 0.75);
      this.nextPulseSlot = (i + 1) % 4;
      this.lastPulseTriggerMs = nowMs;
    }
  }

  private clearFbo(fbo: Fbo): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private disposeFbos(): void {
    const gl = this.gl;
    for (const f of [this.trailA, this.trailB, this.bloomA, this.bloomB]) {
      if (!f) continue;
      gl.deleteFramebuffer(f.fbo);
      gl.deleteTexture(f.tex);
    }
    this.trailA = this.trailB = this.bloomA = this.bloomB = null;
  }

  private drawQuad(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  private updateFps(now: number): void {
    this.fpsFrames++;
    const dt = now - this.fpsLast;
    if (dt >= 1000) {
      this.fps = (this.fpsFrames * 1000) / dt;
      this.fpsFrames = 0;
      this.fpsLast = now;
      if (this.fps < 45) {
        this.lowFpsMs += dt;
        if (this.lowFpsMs > 3500) {
          if (this.quality === 'high') this.setQuality('medium');
          else if (this.quality === 'medium') this.setQuality('low');
          else if (this.quality === 'low') this.setQuality('fallback');
          this.lowFpsMs = 0;
        }
      } else {
        this.lowFpsMs = 0;
      }
    }
  }
}

function buildLineVert(): string {
  return `#version 300 es
layout(location = 0) in vec4 aPrim;
layout(location = 1) in vec4 aMeta;
layout(location = 2) in vec2 aCopy;

uniform float uTime;
uniform float uVolume;
uniform float uTreble;
uniform float uTransient;
uniform float uFlux;
uniform float uCentroid;
uniform float uPitchNorm;
uniform float uBendFrequency;
uniform float uBendAmplitude;
uniform float uBundleWidth;
uniform float uTipSharpness;
uniform float uRadialStretch;
uniform float uAspect;
uniform float uBreath;
uniform float uReduceMotion;
uniform float uAlphaMul;
uniform float uViewportY;
uniform float uLineHalfPx;
uniform float uBundleSpacingPx;
uniform float uSamplesPerCurve;

uniform float uSectorCount;
uniform float uGlobalPhase;
uniform vec4 uLayerPhase;
uniform float uFoldAmount;
uniform float uLobeDepth;
uniform float uOuterReach;
uniform float uFlowSpeed;
uniform float uTopologyMix;
uniform float uWaveOrderA;
uniform float uWaveOrderB;
uniform float uAngularFlow;
uniform vec4 uLayerWeight;
uniform vec4 uPulsePosition;
uniform vec4 uPulseAmplitude;

out float vAlpha;
out float vColorMix;
out float vPitch;
out float vTransient;

${CENTERLINE_GLSL}

vec2 toCartesian(vec2 polar, float sectorCount, float rotationIndex, float mirrorSign, float globalPhase, float aspect) {
  float sectorAngle = TAU / max(sectorCount, 1.0);
  float sectorHalf = sectorAngle * 0.5;
  float theta = rotationIndex * sectorAngle
              + mirrorSign * (polar.y * sectorHalf)
              + globalPhase;
  // Scale radius/position only (~25%); pixel line width & spacing stay unchanged
  vec2 p = vec2(cos(theta), sin(theta)) * (polar.x * 1.25);
  p.x /= max(aspect, 0.001);
  return p;
}

void main() {
  float sectorCount = max(uSectorCount, 1.0);
  if (aCopy.x >= sectorCount) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    vAlpha = 0.0;
    vColorMix = 0.0;
    vPitch = uPitchNorm;
    vTransient = 0.0;
    return;
  }

  float u = aPrim.x;
  float curveId = aPrim.y;
  float layer = aPrim.z;
  float strandOffset = aPrim.w;
  float lineRole = aMeta.x;
  float phase = aMeta.y;
  float rnd = aMeta.z;
  float mirrorSign = aCopy.y;
  float rotationIndex = aCopy.x;

  float effectiveVol = max(uVolume, uBreath * 0.025);
  vec2 pol = polarLocal(
    u, curveId, layer, rnd, phase, uTime,
    effectiveVol, uTreble, uTransient,
    uFoldAmount, uLobeDepth, uOuterReach, uFlowSpeed, uTopologyMix,
    uWaveOrderA, uWaveOrderB, uAngularFlow, uLayerPhase,
    uPulsePosition, uPulseAmplitude,
    uBendFrequency, uBendAmplitude, uTipSharpness, uRadialStretch
  );

  // Derive a true curve normal from neighboring correlated samples. Offsetting
  // in this direction produces a fibre bundle, not a set of radial copies.
  float du = 1.0 / max(48.0, uSamplesPerCurve - 1.0);
  vec2 polA = polarLocal(
    clamp(u - du, 0.0, 1.0), curveId, layer, rnd, phase, uTime,
    effectiveVol, uTreble, uTransient,
    uFoldAmount, uLobeDepth, uOuterReach, uFlowSpeed, uTopologyMix,
    uWaveOrderA, uWaveOrderB, uAngularFlow, uLayerPhase,
    uPulsePosition, uPulseAmplitude,
    uBendFrequency, uBendAmplitude, uTipSharpness, uRadialStretch
  );
  vec2 polB = polarLocal(
    clamp(u + du, 0.0, 1.0), curveId, layer, rnd, phase, uTime,
    effectiveVol, uTreble, uTransient,
    uFoldAmount, uLobeDepth, uOuterReach, uFlowSpeed, uTopologyMix,
    uWaveOrderA, uWaveOrderB, uAngularFlow, uLayerPhase,
    uPulsePosition, uPulseAmplitude,
    uBendFrequency, uBendAmplitude, uTipSharpness, uRadialStretch
  );
  vec2 pos = toCartesian(pol, sectorCount, rotationIndex, mirrorSign, uGlobalPhase, uAspect);
  vec2 posA = toCartesian(polA, sectorCount, rotationIndex, mirrorSign, uGlobalPhase, uAspect);
  vec2 posB = toCartesian(polB, sectorCount, rotationIndex, mirrorSign, uGlobalPhase, uAspect);
  vec2 tangentPx = normalize(vec2((posB.x - posA.x) * uAspect, posB.y - posA.y) + vec2(1e-5, 0.0));
  vec2 normalPx = vec2(-tangentPx.y, tangentPx.x);

  float bundleNoise = smoothNoise3(vec3(curveId * 0.2 + 21.0, u * 1.15, uTime * 0.035));
  // Pitch ? bundle width; volume only mild gather breathe
  float gather = 0.92
    + 0.10 * sin(u * TAU * 0.85 + phase + uTime * 0.08)
    + (bundleNoise - 0.5) * 0.08
    + effectiveVol * 0.04;
  gather = clamp(gather, 0.78, 1.22);
  float radiusExpand = 1.0 + clamp(pol.x / max(uOuterReach, 0.55), 0.0, 1.0) * 0.35;
  float localSpacingPx = uBundleSpacingPx * uBundleWidth * gather * radiusExpand;
  float offsetPx = strandOffset * localSpacingPx;
  vec2 offsetNdc = vec2(normalPx.x / max(uAspect, 0.001), normalPx.y)
    * (2.0 * offsetPx / max(uViewportY, 1.0));
  pos += offsetNdc;

  float lw = layerWeightOf(layer, uLayerWeight);
  // Volume ? brightness; centroid mildly assists warm/cool bias via alpha
  float alpha = mix(0.22, 0.10, lineRole) * lw;
  alpha *= mix(1.0, mix(0.5, 0.78, step(2.5, layer)), clamp(pol.x / max(uOuterReach, 0.55), 0.0, 1.0));
  if (layer < 0.5) alpha *= 0.55;
  // Outer skeleton stays visible ? removed periodic alpha gate that punched holes
  alpha *= uAlphaMul;
  alpha *= mix(1.0, 0.7, uReduceMotion);
  alpha *= mix(0.72, 1.18, effectiveVol);
  alpha *= mix(0.92, 1.05, uCentroid);

  gl_Position = vec4(pos, 0.0, 1.0);
  // Timbre ? dash density (texture), not silhouette
  float dash = smoothstep(0.12, 0.4, abs(sin(u * TAU * (5.0 + uTreble * 1.8) + curveId)));
  alpha *= mix(0.78, 1.0, dash);
  vAlpha = clamp(alpha, 0.0, 0.32);
  vColorMix = clamp(0.12 + layer * 0.1 + uCentroid * 0.2 + rnd * 0.08, 0.0, 1.0);
  vPitch = uPitchNorm;
  vTransient = uTransient;
}
`;
}
