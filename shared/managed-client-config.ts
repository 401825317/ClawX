import {
  UCLAW_DEFAULT_MODEL,
  UCLAW_MANAGED_PROVIDER_ID,
  UCLAW_VIDEO_DEFAULT_DURATION_SECONDS,
  UCLAW_VIDEO_DEFAULT_MODEL,
  UCLAW_VIDEO_DEFAULT_RESOLUTION,
  UCLAW_VIDEO_MODELS,
} from './junfeiai-endpoints';
import type { UclawVideoMode, UclawVideoResolution } from './junfeiai-endpoints';

export type ManagedClientTextModel = {
  id: string;
  label?: string;
  description?: string;
};

export type ManagedClientTextModelPolicy = {
  defaultModel: string;
  models: ManagedClientTextModel[];
};

export type ManagedClientTextModelRequest = {
  refresh?: boolean;
};

export type ManagedClientVideoModel = {
  id: string;
  label?: string;
  description?: string;
  modes: UclawVideoMode[];
  resolutions: UclawVideoResolution[];
  durations: number[];
  defaultResolution: UclawVideoResolution;
  defaultDurationSeconds: number;
  requiresImage: boolean;
};

export type ManagedClientVideoModelPolicy = {
  defaultModel: string;
  defaultResolution: UclawVideoResolution;
  defaultDurationSeconds: number;
  models: ManagedClientVideoModel[];
};

export type ManagedClientVideoModelRequest = {
  refresh?: boolean;
};

/** Build a fresh fallback policy from the centralized managed Provider defaults. */
export function createDefaultManagedClientTextModelPolicy(): ManagedClientTextModelPolicy {
  return {
    defaultModel: UCLAW_DEFAULT_MODEL,
    models: [{ id: UCLAW_DEFAULT_MODEL }],
  };
}

/** Build a fresh video fallback from the centralized UClaw media contract. */
export function createDefaultManagedClientVideoModelPolicy(): ManagedClientVideoModelPolicy {
  return {
    defaultModel: UCLAW_VIDEO_DEFAULT_MODEL,
    defaultResolution: UCLAW_VIDEO_DEFAULT_RESOLUTION,
    defaultDurationSeconds: UCLAW_VIDEO_DEFAULT_DURATION_SECONDS,
    models: UCLAW_VIDEO_MODELS.map((model) => ({
      ...model,
      modes: [...model.modes],
      resolutions: [...model.resolutions],
      durations: [...model.durations],
    })),
  };
}

/** Convert a managed model ID into the canonical OpenClaw model reference. */
export function toManagedClientTextModelRef(modelId: string): string {
  return `${UCLAW_MANAGED_PROVIDER_ID}/${modelId}`;
}
