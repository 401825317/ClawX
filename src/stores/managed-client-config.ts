import { create } from 'zustand';
import type {
  ManagedClientImageModelPolicy,
  ManagedClientTextModelPolicy,
  ManagedClientRuntimeConfig,
  ManagedClientVideoModelPolicy,
} from '@shared/managed-client-config';
import {
  createDefaultManagedClientTextModelPolicy,
  createDefaultManagedClientRuntimeConfig,
} from '@shared/managed-client-config';
import { hostApi } from '@/lib/host-api';

interface ManagedClientConfigStore {
  textModelPolicy: ManagedClientTextModelPolicy;
  imageModelPolicy: ManagedClientImageModelPolicy | null;
  videoModelPolicy: ManagedClientVideoModelPolicy | null;
  runtimeConfig: ManagedClientRuntimeConfig;
  initialized: boolean;
  loading: boolean;
  loadTextModels: (refresh?: boolean) => Promise<ManagedClientTextModelPolicy>;
  loadImageModels: (refresh?: boolean) => Promise<ManagedClientImageModelPolicy | null>;
  loadVideoModels: (refresh?: boolean) => Promise<ManagedClientVideoModelPolicy | null>;
  loadRuntimeConfig: (refresh?: boolean) => Promise<ManagedClientRuntimeConfig>;
}

function enabledMediaPolicy<T extends { models: unknown[] }>(policy: T | null | undefined): T | null {
  if (!policy || policy.models.length === 0) return null;
  if ('enabled' in policy && policy.enabled === false) return null;
  return policy;
}

function normalizeTextModelPolicy(value: unknown): ManagedClientTextModelPolicy {
  const fallback = createDefaultManagedClientTextModelPolicy();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const policy = value as Partial<ManagedClientTextModelPolicy>;
  const models = Array.isArray(policy.models)
    ? policy.models.filter((model) => (
      model
      && typeof model === 'object'
      && typeof model.id === 'string'
      && model.id.trim().length > 0
    ))
    : [];
  return {
    defaultModel: typeof policy.defaultModel === 'string' && policy.defaultModel.trim()
      ? policy.defaultModel.trim()
      : fallback.defaultModel,
    fallbackModels: Array.isArray(policy.fallbackModels)
      ? policy.fallbackModels.filter((model): model is string => typeof model === 'string' && model.trim().length > 0)
      : fallback.fallbackModels,
    defaultThinkingLevel: typeof policy.defaultThinkingLevel === 'string' && policy.defaultThinkingLevel.trim()
      ? policy.defaultThinkingLevel
      : fallback.defaultThinkingLevel,
    models: models.length > 0 ? models : fallback.models,
  };
}

let imageLoadGeneration = 0;
let videoLoadGeneration = 0;

export const useManagedClientConfigStore = create<ManagedClientConfigStore>((set) => ({
  textModelPolicy: createDefaultManagedClientTextModelPolicy(),
  imageModelPolicy: null,
  videoModelPolicy: null,
  runtimeConfig: createDefaultManagedClientRuntimeConfig(),
  initialized: false,
  loading: false,

  loadTextModels: async (refresh = true) => {
    set({ loading: true });
    try {
      const textModelPolicy = normalizeTextModelPolicy(
        await hostApi.managedClientConfig.textModels({ refresh }),
      );
      set({ textModelPolicy, initialized: true, loading: false });
      return textModelPolicy;
    } catch (error) {
      set({ initialized: true, loading: false });
      throw error;
    }
  },

  loadImageModels: async (refresh = true) => {
    const generation = ++imageLoadGeneration;
    set({ imageModelPolicy: null });
    try {
      const imageModelPolicy = enabledMediaPolicy(
        await hostApi.managedClientConfig.imageModels({ refresh }),
      );
      if (generation === imageLoadGeneration) set({ imageModelPolicy });
      return imageModelPolicy;
    } catch (error) {
      if (generation === imageLoadGeneration) set({ imageModelPolicy: null });
      throw error;
    }
  },

  loadVideoModels: async (refresh = true) => {
    const generation = ++videoLoadGeneration;
    set({ videoModelPolicy: null });
    try {
      const videoModelPolicy = enabledMediaPolicy(
        await hostApi.managedClientConfig.videoModels({ refresh }),
      );
      if (generation === videoLoadGeneration) set({ videoModelPolicy });
      return videoModelPolicy;
    } catch (error) {
      if (generation === videoLoadGeneration) set({ videoModelPolicy: null });
      throw error;
    }
  },

  loadRuntimeConfig: async (refresh = true) => {
    const runtimeConfig = await hostApi.managedClientConfig.runtimeConfig({ refresh });
    set({ runtimeConfig });
    return runtimeConfig;
  },
}));
