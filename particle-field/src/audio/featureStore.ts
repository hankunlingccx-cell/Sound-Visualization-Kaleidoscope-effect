import { SILENT_FEATURES, type AudioFeatures } from './types';

/** Thread-safe-ish snapshot holder for the latest audio features. */
export class FeatureStore {
  private snapshot: AudioFeatures = { ...SILENT_FEATURES };

  set(features: AudioFeatures): void {
    this.snapshot = features;
  }

  get(): AudioFeatures {
    return this.snapshot;
  }
}

export const featureStore = new FeatureStore();
