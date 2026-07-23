import { MorphController, type MorphUniforms } from './MorphController';

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
  if (layer < 0.5) return mix(0.085, 0.14, t);
  if (layer < 1.5) return mix(0.16, 0.24, t);
  if (layer < 2.5) return mix(0.25, 0.38, t);
  return mix(0.42, min(0.58, outerReach * 0.78), t);
}

// Returns polar (r, thetaLocal) in half-sector before kaleidoscope copy
vec2 polarLocal(
  float u,
  float curveId,
  float layer,
  float rnd,
  float phase,
  float time,
  float volume,
  float bass,
  float mid,
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
  vec4 pulseAmplitude
) {
  float lp = layerPhaseOf(layer, layerPhase);
  float morph = time * flowSpeed;
  // Noise coordinates move smoothly along the curve and slowly through time;
  // there is no per-point random displacement.
  float n0 = smoothNoise3(vec3(curveId * 0.2, u * 1.5, morph * 0.075));
  float n1 = smoothNoise3(vec3(curveId * 0.2 + 9.7, u * 1.15, morph * 0.051 + 4.0));
  float correlated = (n0 - 0.5) * 2.0;

  float base = layerBaseRadius(layer, curveId + rnd, outerReach);
  float inner = 1.0 - step(0.5, layer);
  float outer = step(2.5, layer);
  float middle = 1.0 - inner - outer;

  float span = inner * 0.15 + middle * mix(0.24, 0.34, step(1.5, layer)) + outer * 0.42;
  span *= 1.0 + bass * (inner * 0.12 + middle * 0.2 + outer * 0.28);

  // Non-monotonic radial progress makes neighboring radius layers weave through
  // one another instead of producing spokes or concentric rings.
  float radialProgress = u;
  radialProgress += (0.12 + foldAmount * 0.08 + mid * 0.08)
    * sin(u * TAU * mix(1.5, 2.5, n1) + phase + lp + morph * 0.19);
  radialProgress += 0.055 * sin(u * TAU * (waveOrderB + 0.5) - morph * 0.13 + curveId);
  float r = base + span * radialProgress;
  r += lobeDepth * (0.35 + mid * 0.55)
    * sin(u * TAU * waveOrderA + phase - morph * 0.23 + lp);
  r += correlated * (0.018 + middle * 0.025 + outer * 0.018);
  r += bass * (0.018 + layer * 0.011);

  // Tangential sweep, fold and curl use deliberately unrelated periods.
  float seedAngle = (fract(curveId * 0.371 + rnd * 0.23) - 0.5) * 1.25;
  float sweep = mix(1.15, 0.52, outer) * (u - 0.5);
  float bend = (0.34 + foldAmount * 0.5 + mid * 0.48)
    * sin(u * TAU * mix(1.0, 2.4, n0) + phase + morph * 0.17);
  float curl = (0.16 + angularFlow * 1.4 + mid * 0.2)
    * sin(u * TAU * waveOrderB - phase * 0.7 - morph * 0.11 + lp);
  float rollBack = outer * 0.34 * sin(pow(u, 1.4) * TAU * 1.25 + phase + morph * 0.09);
  float th = seedAngle + sweep + bend + curl + rollBack + correlated * 0.16;

  float rNorm = clamp(r / max(outerReach, 0.55), 0.0, 1.15);
  float pulse = 0.0;
  for (int i = 0; i < 4; i++) {
    float d = rNorm - pulsePosition[i];
    pulse += pulseAmplitude[i] * exp(-(d * d) / 0.0065);
  }
  // Onsets bend a narrow radial band as it travels; they never scale the field.
  r += pulse * (0.025 + middle * 0.035 + outer * 0.045);
  th += pulse * (0.08 + 0.04 * sin(curveId * 2.3 + u * TAU));

  r += volume * 0.012 * sin(morph * 0.31 + lp + u * TAU);
  r = clamp(r, 0.055, outerReach + outer * 0.13);
  return vec2(r, th);
}
`;

const LINE_FRAG = `#version 300 es
precision mediump float;
in float vAlpha;
in float vColorMix;
out vec4 fragColor;
void main() {
  vec3 lilac = vec3(0.58, 0.52, 0.78);
  vec3 silver = vec3(0.9, 0.88, 0.96);
  vec3 softPink = vec3(0.72, 0.48, 0.68);
  vec3 col = mix(lilac, softPink, vColorMix * 0.35);
  col = mix(col, silver, 0.45);
  fragColor = vec4(col, vAlpha);
}
`;

const BEAD_VERT = `#version 300 es
layout(location = 0) in vec4 aSeed; // curveId, layer, phase, rnd
layout(location = 1) in float aU0;
layout(location = 2) in vec2 aCopy;

uniform float uTime;
uniform float uVolume;
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uTransient;
uniform float uFlux;
uniform float uCentroid;
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

${CENTERLINE_GLSL}

vec2 toCartesian(vec2 polar, float sectorCount, float rotationIndex, float mirrorSign, float globalPhase, float aspect) {
  float sectorAngle = TAU / max(sectorCount, 1.0);
  float sectorHalf = sectorAngle * 0.5;
  float theta = rotationIndex * sectorAngle
              + mirrorSign * (polar.y * sectorHalf)
              + globalPhase;
  vec2 p = vec2(cos(theta), sin(theta)) * polar.x;
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
    effectiveVol, uBass, uMid, uTreble, uTransient,
    uFoldAmount, uLobeDepth, uOuterReach, uFlowSpeed, uTopologyMix,
    uWaveOrderA, uWaveOrderB, uAngularFlow, uLayerPhase,
    uPulsePosition, uPulseAmplitude
  );
  vec2 p = toCartesian(pol, sectorCount, aCopy.x, aCopy.y, uGlobalPhase, uAspect);

  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = mix(0.5, 0.9, rnd) + uTreble * 0.2;
  float lw = layerWeightOf(layer, uLayerWeight);
  vAlpha = (0.04 + 0.05 * effectiveVol + uTransient * 0.04) * lw * uAlphaMul;
  vColorMix = clamp(0.35 + uCentroid * 0.4 + rnd * 0.2, 0.0, 1.0);
}
`;

const BEAD_FRAG = `#version 300 es
precision mediump float;
in float vAlpha;
in float vColorMix;
out vec4 fragColor;
void main() {
  vec2 p = gl_PointCoord - vec2(0.5);
  float d = length(p);
  if (d > 0.5) discard;
  float g = smoothstep(0.5, 0.0, d);
  vec3 silver = vec3(0.92, 0.9, 0.96);
  vec3 pink = vec3(0.85, 0.55, 0.78);
  fragColor = vec4(mix(silver, pink, vColorMix * 0.5), g * vAlpha);
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
  high: { strands: 16, samples: 96, curves: [2, 2, 3, 1], beads: 12, spacingPx: 1.0, lineHalfPx: 0.55 },
  medium: { strands: 12, samples: 72, curves: [2, 2, 2, 1], beads: 8, spacingPx: 1.15, lineHalfPx: 0.5 },
  low: { strands: 10, samples: 56, curves: [1, 2, 2, 1], beads: 5, spacingPx: 1.35, lineHalfPx: 0.5 },
  fallback: { strands: 8, samples: 48, curves: [1, 1, 2, 1], beads: 3, spacingPx: 1.5, lineHalfPx: 0.5 },
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
  private beadCount = 0;

  private quality: QualityTier = 'medium';
  private usePost = true;
  private morph = new MorphController();
  private tierCfg = TIER.medium;

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
    // Short trail on high/medium; keep single-frame topology readable
    this.usePost = quality === 'high' || quality === 'medium';
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
    this.usePost = tier === 'high' || tier === 'medium';
    this.rebuildGeometry();
    this.resize(this.cssW, this.cssH);
  }

  getFps(): number {
    return this.fps;
  }

  getQuality(): QualityTier {
    return this.quality;
  }

  /** Approx visible elements for debug (curves × strands × sectors × 2). */
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

  render(features: {
    volume: number;
    bass: number;
    mid: number;
    treble: number;
    transient: number;
    centroid: number;
    spectralFlux: number;
    onset: number;
  }): void {
    const gl = this.gl;
    const now = performance.now();
    const dt = Math.min(0.08, Math.max(0, (now - this.lastRenderMs) * 0.001));
    this.lastRenderMs = now;
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
      gl.clearColor(0.02, 0.012, 0.035, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drawField(t, breath, aspect, features, morph);
      return;
    }

    const read = this.currTrailIsA ? this.trailA : this.trailB;
    const write = this.currTrailIsA ? this.trailB : this.trailA;
    const decay = this.reduceMotion ? 0.5 : 0.62;

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
      (this.quality === 'high' || this.quality === 'medium') &&
      !this.reduceMotion;

    if (doBloom && this.bloomA && this.bloomB) {
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fbo);
      gl.viewport(0, 0, this.bloomA.w, this.bloomA.h);
      gl.useProgram(this.bloomProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.uniform1i(gl.getUniformLocation(this.bloomProg, 'uTex'), 0);
      gl.uniform1f(gl.getUniformLocation(this.bloomProg, 'uThreshold'), 0.85);
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
        this.quality === 'high' ? 0.07 : 0.05,
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
    features: {
      volume: number;
      bass: number;
      mid: number;
      treble: number;
      transient: number;
      centroid: number;
      spectralFlux: number;
      onset: number;
    },
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
    features: {
      volume: number;
      bass: number;
      mid: number;
      treble: number;
      transient: number;
      centroid: number;
      spectralFlux: number;
      onset: number;
    },
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
    features: {
      volume: number;
      bass: number;
      mid: number;
      treble: number;
      transient: number;
      centroid: number;
      spectralFlux: number;
      onset: number;
    },
  ): void {
    const gl = this.gl;
    gl.uniform1f(u.uTime!, t);
    gl.uniform1f(u.uVolume!, features.volume);
    gl.uniform1f(u.uBass!, features.bass);
    gl.uniform1f(u.uMid!, features.mid);
    gl.uniform1f(u.uTreble!, features.treble);
    gl.uniform1f(u.uTransient!, features.transient);
    gl.uniform1f(u.uFlux!, features.spectralFlux);
    gl.uniform1f(u.uCentroid!, features.centroid);
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
    gl.uniform1f(u.uFoldAmount!, morph.foldAmount);
    gl.uniform1f(u.uLobeDepth!, morph.lobeDepth);
    gl.uniform1f(u.uOuterReach!, morph.outerReach);
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
    features: {
      volume: number;
      bass: number;
      mid: number;
      treble: number;
      transient: number;
      centroid: number;
      spectralFlux: number;
      onset: number;
    },
    morph: MorphUniforms,
    sectorCount: number,
    alphaMul: number,
  ): void {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.ribbonProg);
    gl.bindVertexArray(this.ribbonVao);
    this.setMorphUniforms(this.uRibbon, morph, sectorCount, alphaMul, t, breath, aspect, features);
    gl.uniform1f(this.uRibbon.uViewportY!, gl.drawingBufferHeight);
    gl.uniform1f(this.uRibbon.uLineHalfPx!, this.tierCfg.lineHalfPx);
    gl.uniform1f(this.uRibbon.uBundleSpacingPx!, this.tierCfg.spacingPx);
    gl.uniform1f(this.uRibbon.uSamplesPerCurve!, this.tierCfg.samples);
    gl.drawArrays(gl.LINES, 0, this.ribbonVertCount);
    gl.bindVertexArray(null);
  }

  private drawBeads(
    t: number,
    breath: number,
    aspect: number,
    features: {
      volume: number;
      bass: number;
      mid: number;
      treble: number;
      transient: number;
      centroid: number;
      spectralFlux: number;
      onset: number;
    },
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
    gl.uniform1f(this.uBead.uBeadSpeed!, 0.025 + features.spectralFlux * 0.13 + features.treble * 0.025);
    gl.drawArrays(gl.POINTS, 0, this.beadCount);
    gl.bindVertexArray(null);
  }

  private rebuildGeometry(): void {
    const gl = this.gl;
    const { strands, samples, curves, beads, spacingPx } = this.tierCfg;
    void spacingPx;

    // --- Expanded line segments (no instancing — more reliable for GL_LINES) ---
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
          for (let rot = 0; rot < MAX_SECTORS; rot++) {
            for (let m = 0; m < 2; m++) {
              const mirrorSign = m === 0 ? 1 : -1;
              for (let i = 0; i < samples - 1; i++) {
                const u0 = i / (samples - 1);
                const u1 = (i + 1) / (samples - 1);
                for (const u of [u0, u1]) {
                  // aPrim(4) + aMeta(4): lineRole, phase, rnd, unused + will pack copy into meta.w? 
                  // Use 10 floats: prim4, meta2 (role,phase), rnd, pad, rot, mirror
                  verts.push(
                    u,
                    cid,
                    layer,
                    strandOffset,
                    lineRole,
                    phase,
                    rndAbs,
                    0,
                    rot,
                    mirrorSign,
                  );
                }
              }
            }
          }
        }
        curveId += 1;
      }
    }

    const ribbonData = new Float32Array(verts);
    this.ribbonVertCount = verts.length / 10;

    gl.bindVertexArray(this.ribbonVao);
    const ribbonBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, ribbonBuf);
    gl.bufferData(gl.ARRAY_BUFFER, ribbonData, gl.STATIC_DRAW);
    const stride = 10 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(0, 0);
    gl.vertexAttribDivisor(1, 0);
    gl.vertexAttribDivisor(2, 0);
    gl.bindVertexArray(null);

    // --- Beads (also expanded) ---
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
      for (let rot = 0; rot < MAX_SECTORS; rot++) {
        for (let m = 0; m < 2; m++) {
          beadVerts.push(seed0, seed1, seed2, seed3, u0, rot, m === 0 ? 1 : -1);
        }
      }
    }
    this.beadCount = beadVerts.length / 7;

    gl.bindVertexArray(this.beadVao);
    const beadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, beadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(beadVerts), gl.STATIC_DRAW);
    const bstride = 7 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, bstride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, bstride, 16);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, bstride, 20);
    gl.vertexAttribDivisor(0, 0);
    gl.vertexAttribDivisor(1, 0);
    gl.vertexAttribDivisor(2, 0);
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
      'uBass',
      'uMid',
      'uTreble',
      'uTransient',
      'uFlux',
      'uCentroid',
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
        if (this.lowFpsMs > 2000) {
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
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uTransient;
uniform float uFlux;
uniform float uCentroid;
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

${CENTERLINE_GLSL}

vec2 toCartesian(vec2 polar, float sectorCount, float rotationIndex, float mirrorSign, float globalPhase, float aspect) {
  float sectorAngle = TAU / max(sectorCount, 1.0);
  float sectorHalf = sectorAngle * 0.5;
  float theta = rotationIndex * sectorAngle
              + mirrorSign * (polar.y * sectorHalf)
              + globalPhase;
  vec2 p = vec2(cos(theta), sin(theta)) * polar.x;
  p.x /= max(aspect, 0.001);
  return p;
}

void main() {
  float sectorCount = max(uSectorCount, 1.0);
  if (aCopy.x >= sectorCount) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    vAlpha = 0.0;
    vColorMix = 0.0;
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
    effectiveVol, uBass, uMid, uTreble, uTransient,
    uFoldAmount, uLobeDepth, uOuterReach, uFlowSpeed, uTopologyMix,
    uWaveOrderA, uWaveOrderB, uAngularFlow, uLayerPhase,
    uPulsePosition, uPulseAmplitude
  );

  // Derive a true curve normal from neighboring correlated samples. Offsetting
  // in this direction produces a fibre bundle, not a set of radial copies.
  float du = 1.0 / max(48.0, uSamplesPerCurve - 1.0);
  vec2 polA = polarLocal(
    clamp(u - du, 0.0, 1.0), curveId, layer, rnd, phase, uTime,
    effectiveVol, uBass, uMid, uTreble, uTransient,
    uFoldAmount, uLobeDepth, uOuterReach, uFlowSpeed, uTopologyMix,
    uWaveOrderA, uWaveOrderB, uAngularFlow, uLayerPhase,
    uPulsePosition, uPulseAmplitude
  );
  vec2 polB = polarLocal(
    clamp(u + du, 0.0, 1.0), curveId, layer, rnd, phase, uTime,
    effectiveVol, uBass, uMid, uTreble, uTransient,
    uFoldAmount, uLobeDepth, uOuterReach, uFlowSpeed, uTopologyMix,
    uWaveOrderA, uWaveOrderB, uAngularFlow, uLayerPhase,
    uPulsePosition, uPulseAmplitude
  );
  vec2 pos = toCartesian(pol, sectorCount, rotationIndex, mirrorSign, uGlobalPhase, uAspect);
  vec2 posA = toCartesian(polA, sectorCount, rotationIndex, mirrorSign, uGlobalPhase, uAspect);
  vec2 posB = toCartesian(polB, sectorCount, rotationIndex, mirrorSign, uGlobalPhase, uAspect);
  vec2 tangentPx = normalize(vec2((posB.x - posA.x) * uAspect, posB.y - posA.y) + vec2(1e-5, 0.0));
  vec2 normalPx = vec2(-tangentPx.y, tangentPx.x);

  float bundleNoise = smoothNoise3(vec3(curveId * 0.2 + 21.0, u * 1.5, uTime * 0.045));
  float gather = 0.52
    + 0.38 * sin(u * TAU * 1.7 + phase + uTime * 0.12)
    + 0.22 * sin(u * TAU * 3.1 - phase * 0.4 - uTime * 0.073)
    + (bundleNoise - 0.5) * 0.34;
  gather = clamp(gather, 0.18, 1.18);
  float split = smoothstep(0.48, 0.9, sin(u * TAU * 2.2 + curveId + uTime * 0.09));
  float side = sign(strandOffset);
  float localSpacingPx = uBundleSpacingPx * gather * (1.0 + uBass * 0.42);
  float offsetPx = strandOffset * localSpacingPx
    + side * split * abs(strandOffset) * abs(strandOffset) * 0.045;
  vec2 offsetNdc = vec2(normalPx.x / max(uAspect, 0.001), normalPx.y)
    * (2.0 * offsetPx / max(uViewportY, 1.0));
  pos += offsetNdc;

  float lw = layerWeightOf(layer, uLayerWeight);
  float alpha = mix(0.38, 0.18, lineRole) * lw;
  alpha *= mix(1.0, 0.45, clamp(pol.x / max(uOuterReach, 0.55), 0.0, 1.0));
  if (layer > 2.5) {
    float gate = smoothstep(0.08, 0.6, 0.5 + 0.5 * sin(layerPhaseOf(layer, uLayerPhase) * 0.85 + curveId * 2.1 + phase));
    alpha *= mix(0.1, 1.0, gate);
  }
  alpha *= uAlphaMul;
  alpha *= mix(1.0, 0.8, uReduceMotion);

  gl_Position = vec4(pos, 0.0, 1.0);
  // Centroid increases crisp fine-line density by revealing outer bundle hairs.
  alpha *= mix(0.78, 1.08, uCentroid);
  alpha *= 0.92 + 0.08 * sin(u * TAU * (7.0 + uTreble * 5.0) + curveId);
  vAlpha = clamp(alpha, 0.0, 0.45);
  vColorMix = clamp(0.15 + layer * 0.12 + uCentroid * 0.25 + rnd * 0.1, 0.0, 1.0);
}
`;
}
