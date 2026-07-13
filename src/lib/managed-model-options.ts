import type { ClientModelOptionsConfig } from '@/stores/client-config';

export const MANAGED_TEXT_PROVIDER_KEY = 'openai';
const LEGACY_MANAGED_TEXT_PROVIDER_KEY = 'lingzhiwuxian';
export const DEFAULT_MANAGED_TEXT_MODEL_ID = 'smart-latest';

type TextModelOptionLike = {
  id?: string;
  enabled?: boolean;
};

export type ManagedTextModelOptionsLike = {
  text?: {
    defaultModel?: string;
    models?: TextModelOptionLike[];
  };
};

export interface ManagedTextModelPolicy {
  providerKey: string;
  defaultModelId: string;
  defaultModelRef: string;
  allowedModelIds: string[];
  allowedModelRefs: string[];
}

function normalizeModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueModelIds(models: TextModelOptionLike[] | undefined): string[] {
  if (!Array.isArray(models)) {
    return [];
  }
  return Array.from(new Set(
    models
      .filter((model) => model?.enabled !== false)
      .map((model) => normalizeModelId(model?.id))
      .filter(Boolean),
  ));
}

export function getManagedTextModelPolicy(
  modelOptions?: ManagedTextModelOptionsLike | ClientModelOptionsConfig,
): ManagedTextModelPolicy {
  const configuredDefault = normalizeModelId(modelOptions?.text?.defaultModel);
  const allowedModelIds = uniqueModelIds(modelOptions?.text?.models);
  const fallbackModelId = configuredDefault || DEFAULT_MANAGED_TEXT_MODEL_ID;
  const resolvedAllowedIds = allowedModelIds.length > 0 ? allowedModelIds : [fallbackModelId];
  const defaultModelId = configuredDefault && resolvedAllowedIds.includes(configuredDefault)
    ? configuredDefault
    : (resolvedAllowedIds[0] ?? DEFAULT_MANAGED_TEXT_MODEL_ID);

  return {
    providerKey: MANAGED_TEXT_PROVIDER_KEY,
    defaultModelId,
    defaultModelRef: `${MANAGED_TEXT_PROVIDER_KEY}/${defaultModelId}`,
    allowedModelIds: resolvedAllowedIds,
    allowedModelRefs: resolvedAllowedIds.map((modelId) => `${MANAGED_TEXT_PROVIDER_KEY}/${modelId}`),
  };
}

export function splitManagedTextModelRef(modelRef: string | null | undefined): {
  providerKey: string;
  modelId: string;
} | null {
  const normalized = typeof modelRef === 'string' ? modelRef.trim() : '';
  if (!normalized) return null;
  const separatorIndex = normalized.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= normalized.length - 1) return null;
  return {
    providerKey: normalized.slice(0, separatorIndex),
    modelId: normalized.slice(separatorIndex + 1),
  };
}

export function isManagedTextModelRef(modelRef: string | null | undefined): boolean {
  const providerKey = splitManagedTextModelRef(modelRef)?.providerKey;
  return providerKey === MANAGED_TEXT_PROVIDER_KEY || providerKey === LEGACY_MANAGED_TEXT_PROVIDER_KEY;
}

export function isAllowedManagedTextModelRef(
  modelRef: string | null | undefined,
  modelOptions?: ManagedTextModelOptionsLike | ClientModelOptionsConfig,
): boolean {
  const parsed = splitManagedTextModelRef(modelRef);
  if (!parsed || (parsed.providerKey !== MANAGED_TEXT_PROVIDER_KEY && parsed.providerKey !== LEGACY_MANAGED_TEXT_PROVIDER_KEY)) {
    return true;
  }
  return getManagedTextModelPolicy(modelOptions).allowedModelIds.includes(parsed.modelId);
}

export function normalizeManagedTextModelRef(
  modelRef: string | null | undefined,
  modelOptions?: ManagedTextModelOptionsLike | ClientModelOptionsConfig,
  options?: { fallbackEmpty?: boolean },
): string | null {
  const normalized = typeof modelRef === 'string' ? modelRef.trim() : '';
  const policy = getManagedTextModelPolicy(modelOptions);
  if (!normalized) {
    return options?.fallbackEmpty ? policy.defaultModelRef : null;
  }

  const parsed = splitManagedTextModelRef(normalized);
  if (!parsed || (parsed.providerKey !== MANAGED_TEXT_PROVIDER_KEY && parsed.providerKey !== LEGACY_MANAGED_TEXT_PROVIDER_KEY)) {
    return normalized;
  }

  return policy.allowedModelIds.includes(parsed.modelId)
    ? `${MANAGED_TEXT_PROVIDER_KEY}/${parsed.modelId}`
    : policy.defaultModelRef;
}
