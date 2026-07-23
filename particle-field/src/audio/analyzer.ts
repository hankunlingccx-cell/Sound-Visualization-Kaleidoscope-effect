import { featureStore } from './featureStore';
import {
  centroidToPseudoPitch,
  estimatePitch,
  normalizePitchHz,
} from './pitchDetector';
import { attackRelease, clamp01, softLimit, smoothToward } from './smoother';
import {
  SIGNAL_THRESHOLD_DBFS,
  SILENT_FEATURES,
  type AudioFeatures,
} from './types';

const FFT_SIZE = 2048;
const ANALYSIS_HZ = 30;

export interface MicDeviceOption {
  deviceId: string;
  label: string;
}

export interface MicStatus {
  listening: boolean;
  deviceLabel: string;
  trackReady: boolean;
  trackMuted: boolean;
  contextState: string;
  error: string | null;
}

const CONSTRAINT_FALLBACKS: Array<MediaTrackConstraints | 'any'> = [
  {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
  },
  'any',
];

export class AudioAnalyzer {
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private freqData: Float32Array | null = null;
  private timeData: Float32Array | null = null;
  private timer: number | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private recordingStartMs = 0;
  private pausedAccumMs = 0;
  private pauseStartedMs = 0;
  private preferredDeviceId: string | null = null;
  private deviceLabel = '';
  private lastError: string | null = null;

  private smoothed = { ...SILENT_FEATURES };
  private prevSpectrum = new Float32Array(FFT_SIZE / 2);
  private noiseFloorDb = -58;
  private fluxFloor = 0.015;
  private lastAnalysisMs = performance.now();
  private lastOnsetMs = -Infinity;
  private lastBlob: Blob | null = null;
  private pitchHistory: number[] = [];
  private lastStablePitchHz = 220;

  get recordedBlob(): Blob | null {
    return this.lastBlob;
  }

  getStatus(): MicStatus {
    const track = this.stream?.getAudioTracks()[0];
    return {
      listening: !!track && track.readyState === 'live',
      deviceLabel: this.deviceLabel || track?.label || '未知设备',
      trackReady: track?.readyState === 'live',
      trackMuted: !!track?.muted,
      contextState: this.audioCtx?.state ?? 'closed',
      error: this.lastError,
    };
  }

  setPreferredDevice(deviceId: string | null): void {
    this.preferredDeviceId = deviceId && deviceId.length > 0 ? deviceId : null;
  }

  /** Enumerate mics after permission (labels are empty before grant). */
  async listInputDevices(): Promise<MicDeviceOption[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `麦克风 ${i + 1}`,
      }));
  }

  async start(): Promise<void> {
    this.lastError = null;

    if (!window.isSecureContext) {
      throw new Error(
        '当前页面不是安全上下文（需要 localhost 或 https）。请用 http://127.0.0.1:5173 打开。',
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持麦克风采集（getUserMedia）。请改用 Chrome / Edge。');
    }

    this.stream = await this.acquireStream();
    const track = this.stream.getAudioTracks()[0];
    if (!track) {
      throw new Error('未拿到音频轨道，请检查系统是否启用了麦克风。');
    }
    this.deviceLabel = track.label || '默认麦克风';
    track.onended = () => {
      this.lastError = '麦克风轨道已断开，请重新开始。';
    };
    track.onmute = () => {
      this.lastError = '系统将麦克风静音了，请在系统托盘取消静音。';
    };
    track.onunmute = () => {
      this.lastError = null;
    };

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioCtx = new AudioCtx();
    // Critical: browsers often start suspended until resume() after a user gesture
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.15;
    this.source.connect(this.analyser);
    // Keep graph alive on some browsers; muted destination avoids feedback
    const silence = this.audioCtx.createGain();
    silence.gain.value = 0;
    this.analyser.connect(silence);
    silence.connect(this.audioCtx.destination);

    this.freqData = new Float32Array(this.analyser.frequencyBinCount);
    this.timeData = new Float32Array(this.analyser.fftSize);

    this.recordedChunks = [];
    this.lastBlob = null;
    try {
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';
      this.mediaRecorder = mime
        ? new MediaRecorder(this.stream, { mimeType: mime })
        : new MediaRecorder(this.stream);
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.recordedChunks.push(e.data);
      };
      this.mediaRecorder.start(250);
    } catch {
      // Visualization can continue even if recording container fails
      this.mediaRecorder = null;
      this.lastError = '录音封装不可用，但实时可视化仍可使用。';
    }

    this.recordingStartMs = performance.now();
    this.pausedAccumMs = 0;
    this.pauseStartedMs = 0;
    this.prevSpectrum.fill(0);
    this.noiseFloorDb = -58;
    this.fluxFloor = 0.015;
    this.lastAnalysisMs = performance.now();
    this.lastOnsetMs = -Infinity;
    this.pitchHistory = [];
    this.lastStablePitchHz = 220;
    this.smoothed = { ...SILENT_FEATURES };

    this.timer = window.setInterval(() => this.tick(), 1000 / ANALYSIS_HZ);
  }

  pause(): void {
    this.mediaRecorder?.pause();
    this.pauseStartedMs = performance.now();
    void this.audioCtx?.suspend();
  }

  resume(): void {
    if (this.pauseStartedMs > 0) {
      this.pausedAccumMs += performance.now() - this.pauseStartedMs;
      this.pauseStartedMs = 0;
    }
    this.mediaRecorder?.resume();
    void this.audioCtx?.resume();
  }

  async stop(): Promise<{ blob: Blob; durationMs: number }> {
    const durationMs = this.elapsedMs();

    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const blob = await this.finalizeRecorder();
    this.lastBlob = blob;
    this.teardownGraph();
    this.deviceLabel = '';

    this.smoothed = { ...SILENT_FEATURES, timestampNanos: performance.now() * 1e6 };
    featureStore.set(this.smoothed);

    return { blob, durationMs };
  }

  elapsedMs(): number {
    if (this.recordingStartMs <= 0) return 0;
    const pausedExtra =
      this.pauseStartedMs > 0 ? performance.now() - this.pauseStartedMs : 0;
    return Math.max(
      0,
      performance.now() - this.recordingStartMs - this.pausedAccumMs - pausedExtra,
    );
  }

  private async acquireStream(): Promise<MediaStream> {
    let lastErr: unknown;

    const withDevice = (base: MediaTrackConstraints | 'any'): MediaStreamConstraints => {
      if (base === 'any') {
        return this.preferredDeviceId
          ? { audio: { deviceId: { exact: this.preferredDeviceId } }, video: false }
          : { audio: true, video: false };
      }
      const audio: MediaTrackConstraints = { ...base };
      if (this.preferredDeviceId) {
        audio.deviceId = { exact: this.preferredDeviceId };
      }
      return { audio, video: false };
    };

    for (const constraints of CONSTRAINT_FALLBACKS) {
      try {
        return await navigator.mediaDevices.getUserMedia(withDevice(constraints));
      } catch (err) {
        lastErr = err;
      }
    }

    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      lastErr = err;
    }

    throw lastErr instanceof Error ? lastErr : new Error('无法打开麦克风');
  }

  private async finalizeRecorder(): Promise<Blob> {
    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state === 'inactive') {
      return new Blob(this.recordedChunks, { type: 'audio/webm' });
    }

    return new Promise((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(this.recordedChunks, { type: recorder.mimeType || 'audio/webm' }));
      };
      if (recorder.state === 'paused') recorder.resume();
      recorder.stop();
    });
  }

  private teardownGraph(): void {
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.audioCtx?.close();
    this.source = null;
    this.analyser = null;
    this.stream = null;
    this.audioCtx = null;
    this.mediaRecorder = null;
    this.freqData = null;
    this.timeData = null;
  }

  private tick(): void {
    if (!this.analyser || !this.freqData || !this.timeData || !this.audioCtx) return;

    // Auto-recover suspended context (tab focus / autoplay policy)
    if (this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume();
      return;
    }

    const time = this.timeData as Float32Array<ArrayBuffer>;
    const freq = this.freqData as Float32Array<ArrayBuffer>;
    this.analyser.getFloatTimeDomainData(time);
    this.analyser.getFloatFrequencyData(freq);

    const features = this.computeFeatures(time, freq, this.audioCtx.sampleRate);
    featureStore.set(features);
  }

  private computeFeatures(
    time: Float32Array,
    freqDb: Float32Array,
    sampleRate: number,
  ): AudioFeatures {
    const nowMs = performance.now();
    const deltaMs = Math.min(100, Math.max(8, nowMs - this.lastAnalysisMs));
    this.lastAnalysisMs = nowMs;
    let mean = 0;
    for (let i = 0; i < time.length; i++) mean += time[i];
    mean /= time.length;

    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < time.length; i++) {
      const v = time[i] - mean;
      sumSq += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    const rms = Math.sqrt(sumSq / time.length);
    // Blend peak so quiet Windows mics still register
    const level = Math.max(rms, peak * 0.35);
    const db = 20 * Math.log10(Math.max(level, 1e-8));
    const dbfs = Math.max(-60, Math.min(0, db));
    // Slowly learn the ambient floor only while the input is quiet. The gate is
    // deliberately soft so phone microphones still respond to low-level speech.
    if (dbfs < this.noiseFloorDb + 8) {
      this.noiseFloorDb += (dbfs - this.noiseFloorDb) * 0.012;
    }
    const gateDb = Math.min(-42, this.noiseFloorDb + 7);
    const gatedDb = Math.max(0, dbfs - gateDb);
    const volumeRaw = softLimit(clamp01(gatedDb / Math.max(14, -gateDb)) * 1.45);
    const instantVolume = softLimit(
      smoothToward(this.smoothed.instantVolume, volumeRaw, 0.65, 0.28),
    );
    const hasSignal = dbfs > Math.max(SIGNAL_THRESHOLD_DBFS, gateDb);

    const binHz = sampleRate / (freqDb.length * 2);
    const bandEnergy = (lo: number, hi: number): number => {
      const i0 = Math.max(0, Math.floor(lo / binHz));
      const i1 = Math.min(freqDb.length - 1, Math.ceil(hi / binHz));
      let sum = 0;
      let n = 0;
      for (let i = i0; i <= i1; i++) {
        const lin = clamp01((freqDb[i] + 90) / 70);
        sum += lin * lin;
        n++;
      }
      return n > 0 ? Math.sqrt(sum / n) : 0;
    };

    const bandGate = hasSignal ? 1 : 0;
    const bassRaw = softLimit(bandEnergy(45, 250) * bandGate);
    const midRaw = softLimit(bandEnergy(250, 2200) * bandGate);
    const trebleRaw = softLimit(bandEnergy(2200, 9000) * 1.15 * bandGate);

    let num = 0;
    let den = 0;
    for (let i = 1; i < freqDb.length; i++) {
      const mag = clamp01((freqDb[i] + 90) / 70);
      num += i * binHz * mag;
      den += mag;
    }
    const centroidHz = den > 1e-6 ? num / den : 1000;
    const centroidRaw = clamp01((centroidHz - 200) / 6000);

    // Pitch / F0: McLeod-style NSDF; fall back to centroid when unvoiced
    const pitchEst = hasSignal
      ? estimatePitch(time, sampleRate)
      : { hz: 0, confidence: 0, reliable: false };
    let shapePitchHz: number;
    let pitchConfidence = 0;
    if (pitchEst.confidence > 0.65 && pitchEst.hz > 0) {
      shapePitchHz = pitchEst.hz;
      pitchConfidence = pitchEst.confidence;
      this.lastStablePitchHz = pitchEst.hz;
    } else if (hasSignal) {
      shapePitchHz = centroidToPseudoPitch(centroidHz);
      pitchConfidence = Math.max(0.2, pitchEst.confidence * 0.6);
    } else {
      shapePitchHz = this.lastStablePitchHz;
      pitchConfidence = 0;
    }

    // Median of last 5 frames to reject single-frame pitch jumps
    this.pitchHistory.push(shapePitchHz);
    if (this.pitchHistory.length > 5) this.pitchHistory.shift();
    const sorted = [...this.pitchHistory].sort((a, b) => a - b);
    const medianHz = sorted[Math.floor(sorted.length / 2)] ?? shapePitchHz;
    const pitchNormRaw = normalizePitchHz(medianHz);

    let positiveChange = 0;
    let spectrumEnergy = 0;
    const bins = Math.min(freqDb.length, this.prevSpectrum.length);
    for (let i = 1; i < bins; i++) {
      const mag = clamp01((freqDb[i] + 92) / 72);
      positiveChange += Math.max(0, mag - this.prevSpectrum[i]);
      spectrumEnergy += mag;
      this.prevSpectrum[i] = mag;
    }
    const fluxRaw = hasSignal
      ? positiveChange / Math.max(6, Math.sqrt(spectrumEnergy) * 3.2)
      : 0;
    if (fluxRaw < this.fluxFloor * 2.5) {
      this.fluxFloor += (fluxRaw - this.fluxFloor) * 0.02;
    }
    const gatedFlux = clamp01((fluxRaw - this.fluxFloor * 1.8) * 7.5);
    const onsetReady = nowMs - this.lastOnsetMs > 170;
    const onset = onsetReady && gatedFlux > 0.16 && volumeRaw > 0.055
      ? clamp01((gatedFlux - 0.12) * 2.4)
      : 0;
    if (onset > 0) this.lastOnsetMs = nowMs;

    const volume = softLimit(attackRelease(this.smoothed.volume, volumeRaw, deltaMs, 60, 360));
    const bass = softLimit(attackRelease(this.smoothed.bass, bassRaw, deltaMs, 85, 480));
    const mid = softLimit(attackRelease(this.smoothed.mid, midRaw, deltaMs, 50, 260));
    const treble = softLimit(attackRelease(this.smoothed.treble, trebleRaw, deltaMs, 28, 160));
    const spectralFlux = softLimit(
      attackRelease(this.smoothed.spectralFlux, gatedFlux, deltaMs, 32, 210),
    );
    const transient = onset > 0
      ? onset
      : attackRelease(this.smoothed.transient, 0, deltaMs, 1, 480);

    // Pitch envelope: attack 120–220 ms, release 300–600 ms
    const pitchNormalized = hasSignal
      ? attackRelease(this.smoothed.pitchNormalized, pitchNormRaw, deltaMs, 170, 420)
      : attackRelease(this.smoothed.pitchNormalized, 0.45, deltaMs, 80, 520);
    const pitchHz = hasSignal
      ? attackRelease(this.smoothed.pitchHz, medianHz, deltaMs, 170, 420)
      : attackRelease(this.smoothed.pitchHz, this.lastStablePitchHz, deltaMs, 80, 520);
    const pitchConfSmooth = attackRelease(
      this.smoothed.pitchConfidence,
      hasSignal ? pitchConfidence : 0,
      deltaMs,
      90,
      380,
    );

    this.smoothed = {
      timestampNanos: nowMs * 1e6,
      volume,
      instantVolume,
      dbfs,
      hasSignal,
      bass,
      mid,
      treble,
      spectralFlux,
      onset,
      transient,
      centroid: clamp01(smoothToward(this.smoothed.centroid, centroidRaw, 0.12, 0.06)),
      pitchHz,
      pitchNormalized: clamp01(pitchNormalized),
      pitchConfidence: clamp01(pitchConfSmooth),
    };

    return this.smoothed;
  }
}
