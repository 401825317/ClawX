import {
  UCLAW_DEFAULT_THINKING_LEVEL,
  UCLAW_DEFAULT_FALLBACK_MODEL,
  UCLAW_DEFAULT_MODEL,
  UCLAW_MANAGED_PROVIDER_ID,
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
  visible?: boolean;
};

export type ManagedClientTextModelPolicy = {
  defaultModel: string;
  fallbackModels: string[];
  defaultThinkingLevel: UclawThinkingLevel;
  models: ManagedClientTextModel[];
};

/** Preserve the existing shared export while sourcing the value from endpoint configuration. */
export { UCLAW_DEFAULT_FALLBACK_MODEL };

export type ManagedClientTextModelRequest = {
  refresh?: boolean;
};

export type ManagedClientImageModel = {
  id: string;
  label?: string;
  description?: string;
  sizes: string[];
  qualities: string[];
  defaultSize: string;
  defaultQuality: string;
  supportsEditing: boolean;
};

export type ManagedClientImageModelPolicy = {
  defaultModel: string;
  defaultSize: string;
  defaultQuality: string;
  models: ManagedClientImageModel[];
};

export type ManagedClientImageModelRequest = {
  refresh?: boolean;
};

export type ManagedClientVideoModel = {
  id: string;
  label?: string;
  description?: string;
  modes: UclawVideoMode[];
  /** Exact upstream dimensions. This is the canonical video size contract. */
  sizes: string[];
  aspectRatios: UclawVideoAspectRatio[];
  /** Optional display labels derived from sizes or supplied by a future server contract. */
  resolutions: UclawVideoResolution[];
  durations: number[];
  defaultSize: string;
  defaultAspectRatio: UclawVideoAspectRatio;
  defaultResolution: UclawVideoResolution;
  defaultDurationSeconds: number;
  requiresImage: boolean;
};

export type ManagedClientVideoModelPolicy = {
  defaultModel: string;
  defaultSize: string;
  defaultAspectRatio: UclawVideoAspectRatio;
  defaultResolution: UclawVideoResolution;
  defaultDurationSeconds: number;
  models: ManagedClientVideoModel[];
};

export type ManagedClientVideoModelRequest = {
  refresh?: boolean;
};

export type ManagedObservabilityConfig = {
  enabled: boolean;
  rolloutPercentage: number;
  sentryDsn?: string;
  tunnelPath: string;
  crashSampleRate: number;
  handledErrorSampleRate: number;
  tracesSampleRate: number;
  artifactSampleRate: number;
  maxEventsPerHour: number;
};

/** A server-owned, independently stoppable runtime capability. */
export type ManagedRuntimeFeatureGate = {
  enabled: boolean;
  rolloutPercentage: number;
  /** Server-authoritative account/device eligibility; never contains account IDs. */
  eligible: boolean;
};

export type ManagedArtifactFeatureConfig = ManagedRuntimeFeatureGate & {
  modelAlias: string;
  policyVersion: string;
};

export type ManagedEcommerceMainImageFeatureConfig = ManagedRuntimeFeatureGate & {
  skillVersion: string;
};

export type ManagedClientRuntimeConfig = {
  observability: ManagedObservabilityConfig;
  features: {
    artifacts: ManagedArtifactFeatureConfig;
    ecommerceMainImage: ManagedEcommerceMainImageFeatureConfig;
    htmlPreview: ManagedRuntimeFeatureGate;
    longTermRules: ManagedRuntimeFeatureGate;
  };
};

export type ManagedClientRuntimeConfigRequest = {
  refresh?: boolean;
};

/** Build a fresh fallback policy from the centralized managed Provider defaults. */
export function createDefaultManagedClientTextModelPolicy(): ManagedClientTextModelPolicy {
  return {
    defaultModel: UCLAW_DEFAULT_MODEL,
    fallbackModels: [UCLAW_DEFAULT_FALLBACK_MODEL],
    defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
    models: [
      { id: UCLAW_DEFAULT_MODEL },
      { id: UCLAW_DEFAULT_FALLBACK_MODEL, label: 'DeepSeek V4 Flash' },
    ],
  };
}

/** Managed media stays disabled until a server policy or explicit local policy is verified. */
export function createDefaultManagedClientImageModelPolicy(): ManagedClientImageModelPolicy {
  return {
    defaultModel: '',
    defaultSize: '',
    defaultQuality: '',
    models: [],
  };
}

/** Managed media stays disabled until a server policy or explicit local policy is verified. */
export function createDefaultManagedClientVideoModelPolicy(): ManagedClientVideoModelPolicy {
  return {
    defaultModel: '',
    defaultSize: '',
    defaultAspectRatio: '',
    defaultResolution: '',
    defaultDurationSeconds: 0,
    models: [],
  };
}

export function createDefaultManagedClientRuntimeConfig(): ManagedClientRuntimeConfig {
  return {
    observability: {
      enabled: false,
      rolloutPercentage: 0,
      tunnelPath: '/api/clawx/observability/envelope',
      crashSampleRate: 1,
      handledErrorSampleRate: 0.2,
      tracesSampleRate: 0.05,
      artifactSampleRate: 0.2,
      maxEventsPerHour: 30,
    },
    features: {
      artifacts: {
        enabled: false,
        rolloutPercentage: 0,
        eligible: false,
        modelAlias: 'uclaw-artifact-v1',
        policyVersion: 'v1',
      },
      ecommerceMainImage: {
        enabled: false,
        rolloutPercentage: 0,
        eligible: false,
        skillVersion: 'v1',
      },
      htmlPreview: {
        enabled: false,
        rolloutPercentage: 0,
        eligible: false,
      },
      longTermRules: {
        enabled: false,
        rolloutPercentage: 0,
        eligible: false,
      },
    },
  };
}

/** Convert a managed model ID into the canonical OpenClaw model reference. */
export function toManagedClientTextModelRef(modelId: string): string {
  return `${UCLAW_MANAGED_PROVIDER_ID}/${modelId}`;
}
