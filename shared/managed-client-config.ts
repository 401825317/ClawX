import {
  UCLAW_DEFAULT_MODEL,
  UCLAW_MANAGED_PROVIDER_ID,
} from './junfeiai-endpoints';

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

/** Build a fresh fallback policy from the centralized managed Provider defaults. */
export function createDefaultManagedClientTextModelPolicy(): ManagedClientTextModelPolicy {
  return {
    defaultModel: UCLAW_DEFAULT_MODEL,
    models: [{ id: UCLAW_DEFAULT_MODEL }],
  };
}

/** Convert a managed model ID into the canonical OpenClaw model reference. */
export function toManagedClientTextModelRef(modelId: string): string {
  return `${UCLAW_MANAGED_PROVIDER_ID}/${modelId}`;
}
