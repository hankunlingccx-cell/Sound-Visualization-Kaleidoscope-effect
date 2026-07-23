export type RecordingState =
  | 'Idle'
  | 'RequestingPermission'
  | 'Recording'
  | 'Paused'
  | 'Saving'
  | 'Completed'
  | 'Error';

export interface AudioFeatures {
  timestampNanos: number;
  volume: number;
  /** Instant RMS level 0..1 (less smoothed, for mic monitor UI). */
  instantVolume: number;
  /** Instant RMS in dBFS, typically -60..0. */
  dbfs: number;
  /** True when instant level exceeds the silence threshold. */
  hasSignal: boolean;
  bass: number;
  mid: number;
  treble: number;
  /** Positive bin-wise spectrum change, normalized to 0..1. */
  spectralFlux: number;
  /** One-frame onset trigger. The renderer owns its visual decay and travel. */
  onset: number;
  transient: number;
  centroid: number;
  /** Detected / fallback fundamental in Hz (smoothed). */
  pitchHz: number;
  /** Log-normalized pitch 0..1 (80–1000 Hz). Drives seed shape. */
  pitchNormalized: number;
  /** Pitch detection confidence 0..1. */
  pitchConfidence: number;
}

export const SILENT_FEATURES: AudioFeatures = {
  timestampNanos: 0,
  volume: 0,
  instantVolume: 0,
  dbfs: -60,
  hasSignal: false,
  bass: 0,
  mid: 0,
  treble: 0,
  spectralFlux: 0,
  onset: 0,
  transient: 0,
  centroid: 0.35,
  pitchHz: 220,
  pitchNormalized: 0.45,
  pitchConfidence: 0,
};

/** dBFS above this counts as “有声音”. */
export const SIGNAL_THRESHOLD_DBFS = -48;

export interface AppUiState {
  recordingState: RecordingState;
  elapsedMs: number;
  errorMessage: string | null;
  features: AudioFeatures;
  reduceMotion: boolean;
}
