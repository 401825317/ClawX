import type { ProviderAccount, ProviderVendorInfo, ProviderWithKeyInfo } from '@/lib/providers';
import type {
  ManagedClientTextModelPolicy,
  ManagedClientVideoModelPolicy,
} from '@shared/managed-client-config';
import type { AcpVideoGenerationOptions } from '@shared/acp-chat/types';
import { toManagedClientTextModelRef } from '@shared/managed-client-config';
import { UCLAW_MANAGED_ACCOUNT_ID, UCLAW_MANAGED_PROVIDER_ID } from '@shared/junfeiai-endpoints';
import {
  listVideoGenerationVariants,
  resolveVideoGenerationOptions,
  videoAspectRatiosForModel,
  videoResolutionsForAspectRatio,
} from '@shared/video-generation-contract';

export interface ConfiguredModelOption {
  modelRef: string;
  label: string;
  runtimeProviderKey: string;
  accountId: string;
}

export interface RuntimeProviderOption {
  runtimeProviderKey: string;
  accountId: string;
  label: string;
  modelIdPlaceholder?: string;
  configuredModelId?: string;
}

export type ManagedImageModelLike = {
  id?: unknown;
  sizes?: unknown;
  qualities?: unknown;
  defaultSize?: unknown;
  defaultQuality?: unknown;
  enabled?: unknown;
};

export type ManagedImageModelPolicyLike = {
  defaultModel?: unknown;
  defaultSize?: unknown;
  defaultQuality?: unknown;
  models?: unknown;
};

export type ImageComposerOptions = {
  size: string;
  quality: string;
  preset?: 'ecommerce-main-image';
};

export type ImageComposerState = {
  modelId: string;
  sizes: string[];
  qualities: string[];
  options: ImageComposerOptions;
};

export type VideoComposerOptions = Omit<AcpVideoGenerationOptions, 'resolution'> & {
  resolution: string;
};

export type VideoComposerState = {
  modelId: string;
  sizes: string[];
  aspectRatios: string[];
  resolutions: string[];
  durations: number[];
  options: VideoComposerOptions;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function uniqueValidStrings(value: unknown, validator: (entry: string) => boolean): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => {
    const normalized = nonEmptyString(entry);
    return normalized && validator(normalized) ? [normalized] : [];
  }))];
}

function selectAllowedString(
  preferred: unknown,
  modelDefault: unknown,
  policyDefault: unknown,
  allowed: readonly string[],
): string {
  for (const candidate of [preferred, modelDefault, policyDefault]) {
    const normalized = nonEmptyString(candidate);
    if (normalized && allowed.includes(normalized)) return normalized;
  }
  return allowed[0];
}

function uniquePositiveIntegers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is number => (
    typeof entry === 'number' && Number.isInteger(entry) && entry > 0
  )))];
}

/** Resolve image controls strictly from the server-owned model catalog. */
export function resolveImageComposerState(
  policy: ManagedImageModelPolicyLike | null | undefined,
  preferred: Partial<ImageComposerOptions> | null | undefined,
): ImageComposerState | null {
  const models = Array.isArray(policy?.models) ? policy.models : [];
  const normalizedModels = models.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const model = entry as ManagedImageModelLike;
    if (model.enabled === false) return [];
    const id = nonEmptyString(model.id);
    const sizes = uniqueValidStrings(model.sizes, isMediaSize);
    const qualities = uniqueValidStrings(model.qualities, isMediaOptionToken);
    if (!id || sizes.length === 0 || qualities.length === 0) return [];
    return [{ model, id, sizes, qualities }];
  });
  const defaultModel = nonEmptyString(policy?.defaultModel);
  const active = normalizedModels.find((entry) => entry.id === defaultModel) ?? normalizedModels[0];
  if (!active) return null;

  return {
    modelId: active.id,
    sizes: active.sizes,
    qualities: active.qualities,
    options: {
      size: selectAllowedString(
        preferred?.size,
        active.model.defaultSize,
        policy?.defaultSize,
        active.sizes,
      ),
      quality: selectAllowedString(
        preferred?.quality,
        active.model.defaultQuality,
        policy?.defaultQuality,
        active.qualities,
      ),
      ...(preferred?.preset === 'ecommerce-main-image'
        ? { preset: 'ecommerce-main-image' as const }
        : {}),
    },
  };
}

/** Resolve a complete video selection from the server-owned exact-size catalog. */
export function resolveVideoComposerState(
  policy: ManagedClientVideoModelPolicy | null | undefined,
  mode: 'text-to-video' | 'image-to-video',
  preferred: Partial<VideoComposerOptions> | null | undefined,
): VideoComposerState | null {
  const models = Array.isArray(policy?.models) ? policy.models : [];
  const eligibleModels = models.flatMap((model) => {
    const id = nonEmptyString(model.id);
    const modes = uniqueValidStrings(model.modes, isMediaOptionToken);
    const sizes = uniqueValidStrings(model.sizes, isMediaSize);
    const aspectRatios = uniqueValidStrings(model.aspectRatios, isAspectRatio);
    const resolutions = uniqueValidStrings(model.resolutions, isMediaOptionToken);
    const durations = uniquePositiveIntegers(model.durations);
    if (
      !id
      || !modes.includes(mode)
      || sizes.length === 0
      || aspectRatios.length === 0
      || resolutions.length === 0
      || durations.length === 0
    ) return [];
    const normalizedModel = {
      ...model,
      id,
      modes,
      sizes,
      aspectRatios,
      resolutions,
      durations,
    };
    if (listVideoGenerationVariants(normalizedModel).length === 0) return [];
    return [{ model: normalizedModel, id }];
  });
  const preferredModelId = nonEmptyString(preferred?.modelId);
  const active = eligibleModels.find((entry) => entry.id === preferredModelId)
    ?? eligibleModels.find((entry) => entry.id === policy?.defaultModel)
    ?? eligibleModels[0];
  if (!active) return null;

  const options = resolveVideoGenerationOptions(active.model, mode, preferred, {
    defaultSize: policy?.defaultSize,
    defaultAspectRatio: policy?.defaultAspectRatio,
    defaultResolution: policy?.defaultResolution,
    defaultDurationSeconds: policy?.defaultDurationSeconds,
  });
  if (!options) return null;
  const variants = listVideoGenerationVariants(active.model);

  return {
    modelId: active.id,
    sizes: [...new Set(variants.map((variant) => variant.size))],
    aspectRatios: videoAspectRatiosForModel(active.model),
    resolutions: videoResolutionsForAspectRatio(active.model, options.aspectRatio),
    durations: active.model.durations,
    options,
  };
}

export function isMediaSize(value: string): boolean {
  const match = /^(\d{1,5})x(\d{1,5})$/u.exec(value);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0;
}

export function isAspectRatio(value: string): boolean {
  const match = /^(\d{1,5}):(\d{1,5})$/u.exec(value);
  if (!match) return false;
  return Number(match[1]) > 0 && Number(match[2]) > 0;
}

export function isMediaOptionToken(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value);
}

export function aspectRatioForMediaSize(size: string): string {
  const match = /^(\d{1,5})x(\d{1,5})$/u.exec(size);
  if (!match) return size;
  let width = Number(match[1]);
  let height = Number(match[2]);
  const originalWidth = width;
  const originalHeight = height;
  while (height !== 0) {
    const remainder = width % height;
    width = height;
    height = remainder;
  }
  return `${originalWidth / width}:${originalHeight / width}`;
}

/** Build chat-picker options exclusively from the server-owned managed model policy. */
export function buildManagedTextModelOptions(
  policy: ManagedClientTextModelPolicy,
): ConfiguredModelOption[] {
  const seen = new Set<string>();
  return policy.models.filter(model => model.visible !== false).flatMap((model) => {
    const modelId = model.id.trim();
    if (!modelId || seen.has(modelId)) return [];
    seen.add(modelId);
    return [{
      modelRef: toManagedClientTextModelRef(modelId),
      label: model.label?.trim() || modelId,
      runtimeProviderKey: UCLAW_MANAGED_PROVIDER_ID,
      accountId: UCLAW_MANAGED_ACCOUNT_ID,
    }];
  });
}

export function resolveRuntimeProviderKey(account: ProviderAccount): string {
  if (account.authMode === 'oauth_browser') {
    if (account.vendorId === 'openai') return 'openai';
  }

  if (account.vendorId === 'custom' || account.vendorId === 'ollama') {
    const prefix = `${account.vendorId}-`;
    if (account.id.startsWith(prefix)) {
      const tail = account.id.slice(prefix.length);
      if (tail.length === 8 && !tail.includes('-')) {
        return account.id;
      }
    }

    const suffix = account.id.replace(/-/g, '').slice(0, 8);
    return `${account.vendorId}-${suffix}`;
  }

  if (account.vendorId === 'minimax-portal-cn') {
    return 'minimax-portal';
  }

  return account.vendorId;
}

export function splitModelRef(modelRef: string | null | undefined): { providerKey: string; modelId: string } | null {
  const value = (modelRef || '').trim();
  if (!value) return null;
  const separatorIndex = value.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) return null;
  return {
    providerKey: value.slice(0, separatorIndex),
    modelId: value.slice(separatorIndex + 1),
  };
}

export function normalizeModelIdForRuntimeProvider(
  modelId: string | null | undefined,
  runtimeProviderKey: string,
): string {
  const value = (modelId || '').trim();
  const prefix = `${runtimeProviderKey}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export function formatModelRefLabel(modelRef: string | null | undefined): string {
  const parsed = splitModelRef(modelRef);
  return parsed?.modelId || (modelRef || '').trim() || 'Model';
}

export function formatProviderDisplayName(
  account: ProviderAccount,
  vendorMap: Map<string, ProviderVendorInfo>,
): string {
  if (account.vendorId === 'custom' || account.vendorId === 'ollama') {
    return account.label.trim() || account.vendorId;
  }

  const vendor = vendorMap.get(account.vendorId);
  return vendor?.name || account.label.trim() || account.vendorId;
}

export function formatConfiguredModelLabel(
  modelId: string,
  account: ProviderAccount,
  vendorMap: Map<string, ProviderVendorInfo>,
): string {
  const providerName = formatProviderDisplayName(account, vendorMap);
  return `${modelId} (${providerName})`;
}

export function toModelOptionTestId(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

export function hasConfiguredProviderCredentials(
  account: ProviderAccount,
  statusById: Map<string, ProviderWithKeyInfo>,
): boolean {
  if (account.authMode === 'oauth_device' || account.authMode === 'oauth_browser' || account.authMode === 'local') {
    return true;
  }
  return statusById.get(account.id)?.hasKey ?? false;
}

export function buildRuntimeProviderOptions(
  providerAccounts: ProviderAccount[],
  providerStatuses: ProviderWithKeyInfo[],
  providerVendors: ProviderVendorInfo[],
  providerDefaultAccountId: string | null,
): RuntimeProviderOption[] {
  const safeAccounts = Array.isArray(providerAccounts) ? providerAccounts : [];
  const safeStatuses = Array.isArray(providerStatuses) ? providerStatuses : [];
  const safeVendors = Array.isArray(providerVendors) ? providerVendors : [];
  const vendorMap = new Map<string, ProviderVendorInfo>(safeVendors.map((vendor) => [vendor.id, vendor]));
  const statusById = new Map<string, ProviderWithKeyInfo>(safeStatuses.map((status) => [status.id, status]));
  const entries = safeAccounts
    .filter((account) => account.enabled && hasConfiguredProviderCredentials(account, statusById))
    .sort((left, right) => {
      if (left.id === providerDefaultAccountId) return -1;
      if (right.id === providerDefaultAccountId) return 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    });

  const deduped = new Map<string, RuntimeProviderOption>();
  for (const account of entries) {
    const runtimeProviderKey = resolveRuntimeProviderKey(account);
    if (!runtimeProviderKey || deduped.has(runtimeProviderKey)) continue;
    const vendor = vendorMap.get(account.vendorId);
    const label = `${account.label} (${vendor?.name || account.vendorId})`;
    const configuredModelId = account.model
      ? (account.model.startsWith(`${runtimeProviderKey}/`)
        ? account.model.slice(runtimeProviderKey.length + 1)
        : account.model)
      : undefined;

    deduped.set(runtimeProviderKey, {
      runtimeProviderKey,
      accountId: account.id,
      label,
      modelIdPlaceholder: vendor?.modelIdPlaceholder,
      configuredModelId,
    });
  }

  return [...deduped.values()];
}

export function buildConfiguredModelOptions(
  providerAccounts: ProviderAccount[],
  providerStatuses: ProviderWithKeyInfo[],
  providerVendors: ProviderVendorInfo[],
  providerDefaultAccountId: string | null,
): ConfiguredModelOption[] {
  const safeAccounts = Array.isArray(providerAccounts) ? providerAccounts : [];
  const safeStatuses = Array.isArray(providerStatuses) ? providerStatuses : [];
  const safeVendors = Array.isArray(providerVendors) ? providerVendors : [];
  const vendorMap = new Map<string, ProviderVendorInfo>(safeVendors.map((vendor) => [vendor.id, vendor]));
  const statusById = new Map<string, ProviderWithKeyInfo>(safeStatuses.map((status) => [status.id, status]));
  const entries = safeAccounts
    .filter((account) => {
      const hasModel = Boolean(account.model?.trim())
        || Boolean(account.metadata?.customModels?.some((modelId) => modelId.trim()));
      return account.enabled && hasModel && hasConfiguredProviderCredentials(account, statusById);
    })
    .sort((left, right) => {
      if (left.id === providerDefaultAccountId) return -1;
      if (right.id === providerDefaultAccountId) return 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    });

  const deduped = new Map<string, ConfiguredModelOption>();
  for (const account of entries) {
    const runtimeProviderKey = resolveRuntimeProviderKey(account);
    const modelIds = (() => {
      const selectedModelId = normalizeModelIdForRuntimeProvider(account.model, runtimeProviderKey);
      const supportsMultipleModels = account.vendorId === 'custom' || account.vendorId === 'ollama';
      if (!supportsMultipleModels && selectedModelId) {
        return [selectedModelId];
      }
      const configured = (account.metadata?.customModels ?? [])
        .map((modelId) => normalizeModelIdForRuntimeProvider(modelId, runtimeProviderKey))
        .filter(Boolean);
      if (configured.length > 0) return configured;
      return selectedModelId ? [selectedModelId] : [];
    })();
    for (const modelId of modelIds) {
      const modelRef = `${runtimeProviderKey}/${modelId}`;
      if (deduped.has(modelRef)) continue;
      deduped.set(modelRef, {
        modelRef,
        label: formatConfiguredModelLabel(modelId, account, vendorMap),
        runtimeProviderKey,
        accountId: account.id,
      });
    }
  }

  return [...deduped.values()];
}

export function isConfiguredModelRefAvailable(
  modelRef: string | null | undefined,
  modelOptions: ConfiguredModelOption[],
): boolean {
  const value = (modelRef || '').trim();
  if (!value) return false;
  return modelOptions.some((option) => option.modelRef === value);
}

export function resolveConfiguredModelRef(
  preferredModelRef: string | null | undefined,
  defaultModelRef: string | null | undefined,
  modelOptions: ConfiguredModelOption[],
): string | null {
  const preferred = (preferredModelRef || '').trim();
  if (preferred && isConfiguredModelRefAvailable(preferred, modelOptions)) {
    return preferred;
  }

  const fallbackDefault = (defaultModelRef || '').trim();
  if (fallbackDefault && isConfiguredModelRefAvailable(fallbackDefault, modelOptions)) {
    return fallbackDefault;
  }

  return modelOptions[0]?.modelRef ?? null;
}
