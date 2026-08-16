import {
  UCLAW_DEFAULT_THINKING_LEVEL,
  UCLAW_DEFAULT_MODEL,
  UCLAW_MANAGED_PROVIDER_ID,
  UCLAW_VIDEO_DEFAULT_DURATION_SECONDS,
  UCLAW_VIDEO_DEFAULT_ASPECT_RATIO,
  UCLAW_VIDEO_DEFAULT_MODEL,
  UCLAW_VIDEO_DEFAULT_RESOLUTION,
  UCLAW_VIDEO_MODELS,
} from './junfeiai-endpoints';
import type {
  UclawThinkingLevel,
  UclawVideoAspectRatio,
  UclawVideoMode,
  UclawVideoResolution,
} from './junfeiai-endpoints';

export type ManagedClientTextModel = {
  id: string;
  label?: string;
  description?: string;
};

export type ManagedClientTextModelPolicy = {
  defaultModel: string;
  defaultThinkingLevel: UclawThinkingLevel;
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
  aspectRatios: UclawVideoAspectRatio[];
  resolutions: UclawVideoResolution[];
  durations: number[];
  defaultAspectRatio: UclawVideoAspectRatio;
  defaultResolution: UclawVideoResolution;
  defaultDurationSeconds: number;
  requiresImage: boolean;
};

export type ManagedClientVideoModelPolicy = {
  defaultModel: string;
  defaultAspectRatio: UclawVideoAspectRatio;
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
    defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
    models: [{ id: UCLAW_DEFAULT_MODEL }],
  };
}

/** Build a fresh video fallback from the centralized UClaw media contract. */
export function createDefaultManagedClientVideoModelPolicy(): ManagedClientVideoModelPolicy {
  return {
    defaultModel: UCLAW_VIDEO_DEFAULT_MODEL,
    defaultAspectRatio: UCLAW_VIDEO_DEFAULT_ASPECT_RATIO,
    defaultResolution: UCLAW_VIDEO_DEFAULT_RESOLUTION,
    defaultDurationSeconds: UCLAW_VIDEO_DEFAULT_DURATION_SECONDS,
    models: UCLAW_VIDEO_MODELS.map((model) => ({
      ...model,
      modes: [...model.modes],
      aspectRatios: [...model.aspectRatios],
      resolutions: [...model.resolutions],
      durations: [...model.durations],
    })),
  };
}

/** Convert a managed model ID into the canonical OpenClaw model reference. */
export function toManagedClientTextModelRef(modelId: string): string {
  return `${UCLAW_MANAGED_PROVIDER_ID}/${modelId}`;
}
