import type {
  ManagedClientImageModel,
  ManagedClientImageModelPolicy,
  ManagedClientTextModel,
  ManagedClientTextModelPolicy,
  ManagedClientRuntimeConfig,
  ManagedRuntimeFeatureGate,
  ManagedClientVideoModel,
  ManagedClientVideoModelPolicy,
} from '../../shared/managed-client-config';
import {
  createDefaultManagedClientTextModelPolicy,
  createDefaultManagedClientRuntimeConfig,
  UCLAW_DEFAULT_FALLBACK_MODEL,
} from '../../shared/managed-client-config';
import {
  UCLAW_COMPATIBILITY_PROVIDER_ID,
  UCLAW_DEFAULT_THINKING_LEVEL,
  UCLAW_MANAGED_PROVIDER_ID,
  UCLAW_SUPPORT_REFRESH_INTERVAL_MS,
  UCLAW_SUPPORT_REQUEST_TIMEOUT_MS,
  UCLAW_SUPPORT_ROUTES,
} from '../../shared/junfeiai-endpoints';
import { createHash } from 'node:crypto';
import type {
  UclawThinkingLevel,
} from '../../shared/junfeiai-endpoints';
import {
  getUclawBackendOrigin,
  isUclawManagedDistribution,
  UCLAW_AUTH_ACCOUNT_ID,
} from '../utils/junfeiai-distribution';
import { logger } from '../utils/logger';
import { proxyAwareFetch } from '../utils/proxy-fetch';
import { isRecord } from './payload-utils';
import { getOrCreateInstallationId } from '../utils/installation-id';
import { getProviderSecret } from './secrets/secret-store';

type FetchJsonResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
};

type ManagedClientConfigStore = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
};

type ManagedClientTextModelCache = {
  version: 3;
  policiesByOrigin: Record<string, ManagedClientTextModelPolicy>;
};

type ManagedClientVideoModelCache = {
  version: 2;
  policiesByOrigin: Record<string, VerifiedMediaPolicy<ManagedClientVideoModelPolicy>>;
};

type ManagedClientImageModelCache = {
  version: 1;
  policiesByOrigin: Record<string, VerifiedMediaPolicy<ManagedClientImageModelPolicy>>;
};

type VerifiedMediaPolicy<T> = {
  policy: T;
  verifiedAt: number;
};

const CACHE_KEY = 'textModelPolicy';
const IMAGE_CACHE_KEY = 'imageModelPolicy';
const VIDEO_CACHE_KEY = 'videoModelPolicy';
const MEDIA_POLICY_CACHE_MS = UCLAW_SUPPORT_REFRESH_INTERVAL_MS;
let storePromise: Promise<ManagedClientConfigStore> | null = null;
const cachedPolicyPromises = new Map<string, Promise<ManagedClientTextModelPolicy>>();
const lastVerifiedPolicies = new Map<string, ManagedClientTextModelPolicy>();
const refreshPromises = new Map<string, Promise<ManagedClientTextModelPolicy>>();
const policyRevisions = new Map<string, number>();
const cachedImagePolicyPromises = new Map<string, Promise<VerifiedMediaPolicy<ManagedClientImageModelPolicy> | null>>();
const lastVerifiedImagePolicies = new Map<string, VerifiedMediaPolicy<ManagedClientImageModelPolicy>>();
const imageRefreshPromises = new Map<string, Promise<ManagedClientImageModelPolicy | null>>();
const imagePolicyRevisions = new Map<string, number>();
const cachedVideoPolicyPromises = new Map<string, Promise<VerifiedMediaPolicy<ManagedClientVideoModelPolicy> | null>>();
const lastVerifiedVideoPolicies = new Map<string, VerifiedMediaPolicy<ManagedClientVideoModelPolicy>>();
const videoRefreshPromises = new Map<string, Promise<ManagedClientVideoModelPolicy | null>>();
const videoPolicyRevisions = new Map<string, number>();
const remoteClientConfigPromises = new Map<string, Promise<unknown>>();
type ManagedClientRuntimeConfigState = {
  value: ManagedClientRuntimeConfig;
  epoch: number;
  verifiedAt: number;
};

export type ManagedClientRuntimeConfigSnapshot = {
  config: ManagedClientRuntimeConfig;
  epoch: number;
  verifiedAt: number;
};

export type ManagedClientRuntimeConfigListener = (
  current: ManagedClientRuntimeConfigSnapshot,
  previous: ManagedClientRuntimeConfigSnapshot,
) => void;

const runtimeConfigCache = new Map<string, ManagedClientRuntimeConfigState>();
const runtimeConfigRefreshPromises = new Map<string, Promise<ManagedClientRuntimeConfigSnapshot>>();
const runtimeConfigListeners = new Set<ManagedClientRuntimeConfigListener>();
const RUNTIME_CONFIG_CACHE_MS = 15 * 1000;
let runtimeConfigRefreshTimer: ReturnType<typeof setInterval> | null = null;

function cloneRuntimeConfig(value: ManagedClientRuntimeConfig): ManagedClientRuntimeConfig {
  return structuredClone(value);
}

function defaultRuntimeConfigState(): ManagedClientRuntimeConfigState {
  return { value: createDefaultManagedClientRuntimeConfig(), epoch: 0, verifiedAt: 0 };
}

function runtimeConfigSnapshot(state: ManagedClientRuntimeConfigState): ManagedClientRuntimeConfigSnapshot {
  return { config: cloneRuntimeConfig(state.value), epoch: state.epoch, verifiedAt: state.verifiedAt };
}

function sameRuntimeConfig(left: ManagedClientRuntimeConfig, right: ManagedClientRuntimeConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function commitRuntimeConfigState(
  origin: string,
  value: ManagedClientRuntimeConfig,
  verifiedAt: number,
): ManagedClientRuntimeConfigSnapshot {
  const previousState = runtimeConfigCache.get(origin) ?? defaultRuntimeConfigState();
  const changed = !sameRuntimeConfig(previousState.value, value);
  const currentState: ManagedClientRuntimeConfigState = {
    value: cloneRuntimeConfig(value),
    epoch: previousState.epoch + (changed ? 1 : 0),
    verifiedAt,
  };
  runtimeConfigCache.set(origin, currentState);
  const current = runtimeConfigSnapshot(currentState);
  if (changed) {
    const previous = runtimeConfigSnapshot(previousState);
    for (const listener of runtimeConfigListeners) {
      try {
        listener(current, previous);
      } catch (error) {
        logger.warn('[managed-client-config] Runtime config listener failed:', error);
      }
    }
  }
  return current;
}

export function normalizeManagedRuntimeInstallationId(installationId: string): string | null {
  const raw = installationId.trim();
  if (!raw || raw.length > 4_096) return null;
  // Diagnostic headers never expose the persisted installation identity. Keep
  // rollout hashing on that exact pseudonymous value so Main and zz-cn see the
  // same bucket even for legacy IDs that happen to look like SHA-256 strings.
  return createHash('sha256').update(raw).digest('hex');
}

export function managedRuntimeRolloutBucketForNormalizedInstallationId(
  normalizedInstallationId: string,
  salt: string,
): number | null {
  const normalized = normalizedInstallationId.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) return null;
  return createHash('sha256').update(`${normalized}:${salt}`).digest().readUInt32BE(0) % 10_000;
}

export function managedRuntimeRolloutBucket(installationId: string, salt: string): number | null {
  const normalized = normalizeManagedRuntimeInstallationId(installationId);
  if (!normalized) return null;
  return managedRuntimeRolloutBucketForNormalizedInstallationId(normalized, salt);
}

async function applyRuntimeFeatureRollout(
  value: ManagedClientRuntimeConfig,
): Promise<ManagedClientRuntimeConfig> {
  const config = structuredClone(value);
  const installationId = await getOrCreateInstallationId().catch(() => '');
  const inRollout = (percentage: number, name: string): boolean => {
    const bucket = managedRuntimeRolloutBucket(installationId, name);
    return bucket !== null && percentage > 0 && bucket < percentage * 100;
  };
  const eligible = (gate: ManagedRuntimeFeatureGate, name: string): boolean => (
    gate.enabled
    && (gate.eligible || inRollout(gate.rolloutPercentage, name))
  );
  const artifactsEligible = eligible(config.features.artifacts, 'artifacts');
  config.features.artifacts.enabled = artifactsEligible;
  const ecommerce = config.features.ecommerceMainImage;
  ecommerce.enabled = artifactsEligible && eligible(ecommerce, 'ecommerce-main-image');
  config.features.htmlPreview.enabled = eligible(config.features.htmlPreview, 'html-preview');
  config.features.longTermRules.enabled = eligible(config.features.longTermRules, 'long-term-rules');
  config.observability.enabled = config.observability.enabled
    && inRollout(config.observability.rolloutPercentage, 'observability');
  return config;
}

class ManagedClientConfigHttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ManagedClientConfigHttpError';
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clonePolicy(policy: ManagedClientTextModelPolicy): ManagedClientTextModelPolicy {
  return {
    defaultModel: policy.defaultModel,
    fallbackModels: [...policy.fallbackModels],
    defaultThinkingLevel: policy.defaultThinkingLevel,
    models: policy.models.map((model) => ({ ...model })),
  };
}

function cloneImagePolicy(policy: ManagedClientImageModelPolicy): ManagedClientImageModelPolicy {
  return {
    defaultModel: policy.defaultModel,
    defaultSize: policy.defaultSize,
    defaultQuality: policy.defaultQuality,
    models: policy.models.map((model) => ({
      ...model,
      sizes: [...model.sizes],
      qualities: [...model.qualities],
    })),
  };
}

function cloneVideoPolicy(policy: ManagedClientVideoModelPolicy): ManagedClientVideoModelPolicy {
  return {
    defaultModel: policy.defaultModel,
    defaultSize: policy.defaultSize,
    defaultAspectRatio: policy.defaultAspectRatio,
    defaultResolution: policy.defaultResolution,
    defaultDurationSeconds: policy.defaultDurationSeconds,
    models: policy.models.map((model) => ({
      ...model,
      modes: [...model.modes],
      sizes: [...model.sizes],
      aspectRatios: [...model.aspectRatios],
      resolutions: [...model.resolutions],
      durations: [...model.durations],
    })),
  };
}

/** Normalize only the two managed Provider prefixes; reject third-party model refs. */
function managedModelId(value: unknown): string {
  const id = stringValue(value);
  const separator = id.indexOf('/');
  if (separator < 0) return id;
  const providerId = id.slice(0, separator).trim().toLowerCase();
  const modelId = id.slice(separator + 1).trim();
  if (
    !modelId
    || (providerId !== UCLAW_MANAGED_PROVIDER_ID && providerId !== UCLAW_COMPATIBILITY_PROVIDER_ID)
  ) {
    return '';
  }
  return modelId;
}

function normalizeModel(value: unknown): ManagedClientTextModel | null {
  if (!isRecord(value) || value.enabled === false) return null;
  const id = managedModelId(value.id);
  if (!id) return null;
  const label = stringValue(value.label);
  const description = stringValue(value.description);
  return {
    id,
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    ...(value.visible === false ? { visible: false } : {}),
  };
}

function boundedRate(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

function validPercentage(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function runtimeFeatureGateFromPayload(value: unknown): ManagedRuntimeFeatureGate {
  if (!isRecord(value) || !validPercentage(value.rolloutPercentage)) {
    return { enabled: false, rolloutPercentage: 0, eligible: false };
  }
  return {
    enabled: value.enabled === true,
    rolloutPercentage: value.rolloutPercentage,
    eligible: value.eligible === true,
  };
}

function isFreshVerifiedPolicy<T>(
  value: VerifiedMediaPolicy<T> | null | undefined,
  now = Date.now(),
): value is VerifiedMediaPolicy<T> {
  return Boolean(
    value
    && Number.isFinite(value.verifiedAt)
    && value.verifiedAt > 0
    && now - value.verifiedAt >= 0
    && now - value.verifiedAt < MEDIA_POLICY_CACHE_MS,
  );
}

function safeHttpUrl(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

const OBSERVABILITY_FIELDS = new Set([
  'enabled',
  'rolloutPercentage',
  'sentryDsn',
  'tunnelPath',
  'crashSampleRate',
  'handledErrorSampleRate',
  'tracesSampleRate',
  'artifactSampleRate',
  'maxEventsPerHour',
]);

function hasOnlyObservabilityFields(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => OBSERVABILITY_FIELDS.has(key));
}

function runtimeConfigFromPayload(payload: unknown): ManagedClientRuntimeConfig {
  const fallback = createDefaultManagedClientRuntimeConfig();
  if (!isRecord(payload)) return fallback;
  const root = isRecord(payload.client) ? payload.client : payload;
  const observability = isRecord(root.observability) ? root.observability : null;
  const features = isRecord(root.features) ? root.features : null;
  const artifacts = features && isRecord(features.artifacts) ? features.artifacts : null;
  const ecommerce = features && isRecord(features.ecommerceMainImage)
    ? features.ecommerceMainImage
    : null;
  const htmlPreview = features && isRecord(features.htmlPreview) ? features.htmlPreview : null;
  const longTermRules = features && isRecord(features.longTermRules) ? features.longTermRules : null;

  const tunnelPath = stringValue(observability?.tunnelPath);
  const maxEvents = observability?.maxEventsPerHour;
  const observabilityRollout = observability?.rolloutPercentage;
  const hasValidObservability = observability !== null
    && hasOnlyObservabilityFields(observability)
    && observability.enabled === true
    && safeHttpUrl(observability?.sentryDsn) !== undefined
    && tunnelPath === fallback.observability.tunnelPath
    && boundedRate(observability?.crashSampleRate, Number.NaN) === observability?.crashSampleRate
    && boundedRate(observability?.handledErrorSampleRate, Number.NaN) === observability?.handledErrorSampleRate
    && boundedRate(observability?.tracesSampleRate, Number.NaN) === observability?.tracesSampleRate
    && boundedRate(observability?.artifactSampleRate, Number.NaN) === observability?.artifactSampleRate
    && typeof maxEvents === 'number'
    && Number.isInteger(maxEvents)
    && maxEvents >= 1
    && maxEvents <= 30
    && validPercentage(observabilityRollout);
  const artifactGate = runtimeFeatureGateFromPayload(artifacts);
  const artifactAlias = stringValue(artifacts?.modelAlias);
  const artifactPolicyVersion = stringValue(artifacts?.policyVersion);
  const artifactContractValid = artifactAlias === 'uclaw-artifact-v1'
    && artifactPolicyVersion === 'v1';
  artifactGate.enabled = artifactGate.enabled && artifactContractValid;
  const ecommerceGate = runtimeFeatureGateFromPayload(ecommerce);
  return {
    observability: {
      enabled: hasValidObservability,
      rolloutPercentage: validPercentage(observabilityRollout) ? observabilityRollout : 0,
      ...(safeHttpUrl(observability?.sentryDsn) ? { sentryDsn: safeHttpUrl(observability?.sentryDsn) } : {}),
      tunnelPath: tunnelPath.startsWith('/api/clawx/')
        ? tunnelPath
        : fallback.observability.tunnelPath,
      crashSampleRate: boundedRate(
        observability?.crashSampleRate,
        fallback.observability.crashSampleRate,
      ),
      handledErrorSampleRate: boundedRate(
        observability?.handledErrorSampleRate,
        fallback.observability.handledErrorSampleRate,
      ),
      tracesSampleRate: boundedRate(
        observability?.tracesSampleRate,
        fallback.observability.tracesSampleRate,
      ),
      artifactSampleRate: boundedRate(
        observability?.artifactSampleRate,
        fallback.observability.artifactSampleRate,
      ),
      maxEventsPerHour: typeof maxEvents === 'number' && Number.isInteger(maxEvents)
        ? Math.max(1, Math.min(100, maxEvents))
        : fallback.observability.maxEventsPerHour,
    },
    features: {
      artifacts: {
        ...artifactGate,
        modelAlias: artifactContractValid ? artifactAlias : fallback.features.artifacts.modelAlias,
        policyVersion: artifactContractValid
          ? artifactPolicyVersion
          : fallback.features.artifacts.policyVersion,
      },
      ecommerceMainImage: {
        ...ecommerceGate,
        skillVersion: stringValue(ecommerce?.skillVersion) || fallback.features.ecommerceMainImage.skillVersion,
      },
      htmlPreview: runtimeFeatureGateFromPayload(htmlPreview),
      longTermRules: runtimeFeatureGateFromPayload(longTermRules),
    },
  };
}

const UCLAW_THINKING_LEVELS = new Set<UclawThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

function normalizeThinkingLevel(value: unknown): UclawThinkingLevel {
  const normalized = stringValue(value).toLowerCase() as UclawThinkingLevel;
  return UCLAW_THINKING_LEVELS.has(normalized)
    ? normalized
    : UCLAW_DEFAULT_THINKING_LEVEL;
}

function textModelOptionsFromPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.modelOptions)) return payload.modelOptions.text;
  if (isRecord(payload.client) && isRecord(payload.client.modelOptions)) {
    return payload.client.modelOptions.text;
  }
  return undefined;
}

function imageModelOptionsFromPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.modelOptions)) return payload.modelOptions.image;
  if (isRecord(payload.client) && isRecord(payload.client.modelOptions)) {
    return payload.client.modelOptions.image;
  }
  return undefined;
}

function videoModelOptionsFromPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.modelOptions)) return payload.modelOptions.video;
  if (isRecord(payload.client) && isRecord(payload.client.modelOptions)) {
    return payload.client.modelOptions.video;
  }
  return undefined;
}

function normalizeTextModelOptions(value: unknown): ManagedClientTextModelPolicy | null {
  if (!isRecord(value) || !Array.isArray(value.models)) return null;
  const seen = new Set<string>();
  const models = value.models
    .map(normalizeModel)
    .filter((model): model is ManagedClientTextModel => {
      if (!model || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
  if (models.length === 0) return null;
  if (!models.some((model) => model.id === UCLAW_DEFAULT_FALLBACK_MODEL)) {
    models.push({ id: UCLAW_DEFAULT_FALLBACK_MODEL, label: 'DeepSeek V4 Flash' });
  }
  const configuredDefault = managedModelId(value.defaultModel);
  const defaultModel = models.some((model) => model.id === configuredDefault)
    ? configuredDefault
    : models[0].id;
  const availableModelIds = new Set(models.map((model) => model.id));
  const seenFallbacks = new Set<string>();
  const fallbackModels = Array.isArray(value.fallbackModels)
    ? value.fallbackModels.flatMap((entry) => {
        const modelId = managedModelId(entry);
        if (
          !modelId
          || modelId === defaultModel
          || !availableModelIds.has(modelId)
          || seenFallbacks.has(modelId)
        ) {
          return [];
        }
        seenFallbacks.add(modelId);
        return [modelId];
      })
    : [];
  if (
    defaultModel !== UCLAW_DEFAULT_FALLBACK_MODEL
    && availableModelIds.has(UCLAW_DEFAULT_FALLBACK_MODEL)
    && !fallbackModels.includes(UCLAW_DEFAULT_FALLBACK_MODEL)
  ) {
    fallbackModels.push(UCLAW_DEFAULT_FALLBACK_MODEL);
  }
  return {
    defaultModel,
    fallbackModels,
    defaultThinkingLevel: normalizeThinkingLevel(value.defaultThinkingLevel),
    models,
  };
}

function uniqueStrings(value: unknown, validator: (entry: string) => boolean): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => {
    const normalized = stringValue(entry);
    return normalized && validator(normalized) ? [normalized] : [];
  }))];
}

function isMediaToken(value: string): boolean {
  return value.length <= 128 && ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function isPixelSize(value: string): boolean {
  const match = /^(\d{1,5})x(\d{1,5})$/u.exec(value);
  return Boolean(match && Number(match[1]) > 0 && Number(match[2]) > 0);
}

function isAspectRatio(value: string): boolean {
  const match = /^(\d{1,5}):(\d{1,5})$/u.exec(value);
  return Boolean(match && Number(match[1]) > 0 && Number(match[2]) > 0);
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function aspectRatioForSize(size: string): string {
  const match = /^(\d{1,5})x(\d{1,5})$/u.exec(size);
  if (!match) return '';
  const width = Number(match[1]);
  const height = Number(match[2]);
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function resolutionForSize(size: string): string {
  const match = /^(\d{1,5})x(\d{1,5})$/u.exec(size);
  if (!match) return '';
  return `${Math.min(Number(match[1]), Number(match[2]))}P`;
}

function positiveIntegers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is number => (
    typeof entry === 'number' && Number.isSafeInteger(entry) && entry > 0
  )))];
}

function selectAllowedString(
  allowed: readonly string[],
  ...candidates: unknown[]
): string {
  for (const candidate of candidates) {
    const normalized = stringValue(candidate);
    if (normalized && allowed.includes(normalized)) return normalized;
  }
  return allowed[0] ?? '';
}

function selectAllowedInteger(allowed: readonly number[], ...candidates: unknown[]): number {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && allowed.includes(candidate)) return candidate;
  }
  return allowed[0] ?? 0;
}

function normalizeImageModel(value: unknown): ManagedClientImageModel | null {
  if (!isRecord(value) || value.enabled === false) return null;
  const id = stringValue(value.id);
  const sizes = uniqueStrings(value.sizes, isPixelSize);
  const qualities = uniqueStrings(value.qualities, isMediaToken);
  if (!id || sizes.length === 0 || qualities.length === 0) return null;
  const label = stringValue(value.label);
  const description = stringValue(value.description);
  return {
    id,
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    sizes,
    qualities,
    defaultSize: selectAllowedString(sizes, value.defaultSize),
    defaultQuality: selectAllowedString(qualities, value.defaultQuality),
    supportsEditing: value.supportsEditing === true,
  };
}

function normalizeImageModelOptions(value: unknown): ManagedClientImageModelPolicy | null {
  if (!isRecord(value) || !Array.isArray(value.models)) return null;
  const seen = new Set<string>();
  const models = value.models
    .map(normalizeImageModel)
    .filter((model): model is ManagedClientImageModel => {
      if (!model || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
  if (models.length === 0) return null;
  const configuredDefaultModel = stringValue(value.defaultModel);
  const defaultModel = models.some((model) => model.id === configuredDefaultModel)
    ? configuredDefaultModel
    : models[0].id;
  const selectedModel = models.find((model) => model.id === defaultModel)!;
  return {
    defaultModel,
    defaultSize: selectAllowedString(
      selectedModel.sizes,
      value.defaultSize,
      selectedModel.defaultSize,
    ),
    defaultQuality: selectAllowedString(
      selectedModel.qualities,
      value.defaultQuality,
      selectedModel.defaultQuality,
    ),
    models,
  };
}

function normalizeVideoModel(value: unknown): ManagedClientVideoModel | null {
  if (!isRecord(value) || value.enabled === false) return null;
  const id = stringValue(value.id);
  const modes = uniqueStrings(value.modes, isMediaToken);
  const sizes = uniqueStrings(value.sizes, isPixelSize);
  const durations = positiveIntegers(value.durations);
  if (!id || modes.length === 0 || sizes.length === 0 || durations.length === 0) return null;

  const derivedAspectRatios = [...new Set(sizes.map(aspectRatioForSize).filter(Boolean))];
  const configuredAspectRatios = uniqueStrings(value.aspectRatios, isAspectRatio);
  const aspectRatios = configuredAspectRatios.length > 0 ? configuredAspectRatios : derivedAspectRatios;
  const derivedResolutions = [...new Set(sizes.map(resolutionForSize).filter(Boolean))];
  const configuredResolutions = uniqueStrings(value.resolutions, isMediaToken);
  const resolutions = configuredResolutions.length > 0 ? configuredResolutions : derivedResolutions;
  if (aspectRatios.length === 0 || resolutions.length === 0) return null;

  const defaultSize = selectAllowedString(sizes, value.defaultSize);
  const label = stringValue(value.label);
  const description = stringValue(value.description);
  return {
    id,
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    modes,
    sizes,
    aspectRatios,
    resolutions,
    durations,
    defaultSize,
    defaultAspectRatio: selectAllowedString(
      aspectRatios,
      value.defaultAspectRatio,
      aspectRatioForSize(defaultSize),
    ),
    defaultResolution: selectAllowedString(
      resolutions,
      value.defaultResolution,
      resolutionForSize(defaultSize),
    ),
    defaultDurationSeconds: selectAllowedInteger(durations, value.defaultDurationSeconds),
    requiresImage: value.requiresImage === true,
  };
}

function normalizeVideoModelOptions(value: unknown): ManagedClientVideoModelPolicy | null {
  if (!isRecord(value) || !Array.isArray(value.models)) return null;
  const seen = new Set<string>();
  const models = value.models
    .map(normalizeVideoModel)
    .filter((model): model is ManagedClientVideoModel => {
      if (!model || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
  if (models.length === 0) return null;
  const configuredDefaultModel = stringValue(value.defaultModel);
  const defaultModel = models.some((model) => model.id === configuredDefaultModel)
    ? configuredDefaultModel
    : models[0].id;
  const selectedModel = models.find((model) => model.id === defaultModel)!;
  const defaultSize = selectAllowedString(
    selectedModel.sizes,
    value.defaultSize,
    selectedModel.defaultSize,
  );
  return {
    defaultModel,
    defaultSize,
    defaultAspectRatio: selectAllowedString(
      selectedModel.aspectRatios,
      value.defaultAspectRatio,
      aspectRatioForSize(defaultSize),
      selectedModel.defaultAspectRatio,
    ),
    defaultResolution: selectAllowedString(
      selectedModel.resolutions,
      value.defaultResolution,
      resolutionForSize(defaultSize),
      selectedModel.defaultResolution,
    ),
    defaultDurationSeconds: selectAllowedInteger(
      selectedModel.durations,
      value.defaultDurationSeconds,
      selectedModel.defaultDurationSeconds,
    ),
    models,
  };
}

function normalizedCachedPolicies(value: unknown): Record<string, ManagedClientTextModelPolicy> {
  if (
    !isRecord(value)
    || (value.version !== 2 && value.version !== 3)
    || !isRecord(value.policiesByOrigin)
  ) return {};
  const policies: Record<string, ManagedClientTextModelPolicy> = {};
  for (const [origin, policy] of Object.entries(value.policiesByOrigin)) {
    const normalized = normalizeTextModelOptions(policy);
    if (normalized) policies[origin] = normalized;
  }
  return policies;
}

function normalizedCachedImagePolicies(
  value: unknown,
): Record<string, VerifiedMediaPolicy<ManagedClientImageModelPolicy>> {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.policiesByOrigin)) return {};
  const policies: Record<string, VerifiedMediaPolicy<ManagedClientImageModelPolicy>> = {};
  for (const [origin, entry] of Object.entries(value.policiesByOrigin)) {
    if (!isRecord(entry) || typeof entry.verifiedAt !== 'number') continue;
    const policy = normalizeImageModelOptions(entry.policy);
    const verified = policy ? { policy, verifiedAt: entry.verifiedAt } : null;
    if (isFreshVerifiedPolicy(verified)) policies[origin] = verified;
  }
  return policies;
}

function normalizedCachedVideoPolicies(
  value: unknown,
): Record<string, VerifiedMediaPolicy<ManagedClientVideoModelPolicy>> {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.policiesByOrigin)) return {};
  const policies: Record<string, VerifiedMediaPolicy<ManagedClientVideoModelPolicy>> = {};
  for (const [origin, entry] of Object.entries(value.policiesByOrigin)) {
    if (!isRecord(entry) || typeof entry.verifiedAt !== 'number') continue;
    const policy = normalizeVideoModelOptions(entry.policy);
    const verified = policy ? { policy, verifiedAt: entry.verifiedAt } : null;
    if (isFreshVerifiedPolicy(verified)) policies[origin] = verified;
  }
  return policies;
}

async function getStore(): Promise<ManagedClientConfigStore> {
  if (!storePromise) {
    storePromise = import('electron-store').then(({ default: Store }) => new Store({
      name: 'managed-client-config',
      defaults: { [CACHE_KEY]: null },
    }) as ManagedClientConfigStore);
  }
  return storePromise;
}

async function readCachedPolicy(origin: string): Promise<ManagedClientTextModelPolicy> {
  let cachedPolicyPromise = cachedPolicyPromises.get(origin);
  if (!cachedPolicyPromise) {
    const startingRevision = policyRevisions.get(origin) ?? 0;
    cachedPolicyPromise = (async () => {
      try {
        const store = await getStore();
        const normalized = normalizedCachedPolicies(store.get(CACHE_KEY))[origin];
        if (normalized) {
          if ((policyRevisions.get(origin) ?? 0) === startingRevision) {
            lastVerifiedPolicies.set(origin, normalized);
          }
          return clonePolicy(lastVerifiedPolicies.get(origin) ?? normalized);
        }
      } catch (error) {
        logger.warn('[managed-client-config] Failed to read cached text models:', error);
      }
      return clonePolicy(
        lastVerifiedPolicies.get(origin) ?? createDefaultManagedClientTextModelPolicy(),
      );
    })();
    cachedPolicyPromises.set(origin, cachedPolicyPromise);
  }
  return clonePolicy(await cachedPolicyPromise);
}

async function persistPolicy(origin: string, policy: ManagedClientTextModelPolicy): Promise<void> {
  try {
    const store = await getStore();
    const policiesByOrigin = normalizedCachedPolicies(store.get(CACHE_KEY));
    policiesByOrigin[origin] = clonePolicy(policy);
    const cache: ManagedClientTextModelCache = {
      version: 3,
      policiesByOrigin,
    };
    store.set(CACHE_KEY, cache);
  } catch (error) {
    logger.warn('[managed-client-config] Failed to persist text models:', error);
  }
}

async function readCachedImagePolicy(origin: string): Promise<ManagedClientImageModelPolicy | null> {
  let cachedPolicyPromise = cachedImagePolicyPromises.get(origin);
  if (!cachedPolicyPromise) {
    const startingRevision = imagePolicyRevisions.get(origin) ?? 0;
    cachedPolicyPromise = (async () => {
      try {
        const store = await getStore();
        const verified = normalizedCachedImagePolicies(store.get(IMAGE_CACHE_KEY))[origin] ?? null;
        if (verified && (imagePolicyRevisions.get(origin) ?? 0) === startingRevision) {
          lastVerifiedImagePolicies.set(origin, verified);
        }
        return lastVerifiedImagePolicies.get(origin) ?? verified;
      } catch (error) {
        logger.warn('[managed-client-config] Failed to read cached image models:', error);
        return lastVerifiedImagePolicies.get(origin) ?? null;
      }
    })();
    cachedImagePolicyPromises.set(origin, cachedPolicyPromise);
  }
  const verified = await cachedPolicyPromise;
  return isFreshVerifiedPolicy(verified) ? cloneImagePolicy(verified.policy) : null;
}

async function persistImagePolicy(
  origin: string,
  verified: VerifiedMediaPolicy<ManagedClientImageModelPolicy>,
): Promise<void> {
  try {
    const store = await getStore();
    const policiesByOrigin = normalizedCachedImagePolicies(store.get(IMAGE_CACHE_KEY));
    policiesByOrigin[origin] = {
      policy: cloneImagePolicy(verified.policy),
      verifiedAt: verified.verifiedAt,
    };
    const cache: ManagedClientImageModelCache = { version: 1, policiesByOrigin };
    store.set(IMAGE_CACHE_KEY, cache);
  } catch (error) {
    logger.warn('[managed-client-config] Failed to persist image models:', error);
  }
}

async function readCachedVideoPolicy(origin: string): Promise<ManagedClientVideoModelPolicy | null> {
  let cachedPolicyPromise = cachedVideoPolicyPromises.get(origin);
  if (!cachedPolicyPromise) {
    const startingRevision = videoPolicyRevisions.get(origin) ?? 0;
    cachedPolicyPromise = (async () => {
      try {
        const store = await getStore();
        const verified = normalizedCachedVideoPolicies(store.get(VIDEO_CACHE_KEY))[origin] ?? null;
        if (verified && (videoPolicyRevisions.get(origin) ?? 0) === startingRevision) {
          lastVerifiedVideoPolicies.set(origin, verified);
        }
        return lastVerifiedVideoPolicies.get(origin) ?? verified;
      } catch (error) {
        logger.warn('[managed-client-config] Failed to read cached video models:', error);
        return lastVerifiedVideoPolicies.get(origin) ?? null;
      }
    })();
    cachedVideoPolicyPromises.set(origin, cachedPolicyPromise);
  }
  const verified = await cachedPolicyPromise;
  return isFreshVerifiedPolicy(verified) ? cloneVideoPolicy(verified.policy) : null;
}

async function persistVideoPolicy(
  origin: string,
  verified: VerifiedMediaPolicy<ManagedClientVideoModelPolicy>,
): Promise<void> {
  try {
    const store = await getStore();
    const policiesByOrigin = normalizedCachedVideoPolicies(store.get(VIDEO_CACHE_KEY));
    policiesByOrigin[origin] = {
      policy: cloneVideoPolicy(verified.policy),
      verifiedAt: verified.verifiedAt,
    };
    const cache: ManagedClientVideoModelCache = { version: 2, policiesByOrigin };
    store.set(VIDEO_CACHE_KEY, cache);
  } catch (error) {
    logger.warn('[managed-client-config] Failed to persist video models:', error);
  }
}

function payloadMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  return stringValue(payload.message)
    || stringValue(payload.msg)
    || (typeof payload.error === 'string' ? stringValue(payload.error) : '')
    || fallback;
}

function unwrapPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  if (payload.success === false) {
    throw new ManagedClientConfigHttpError(payloadMessage(payload, 'UClaw client-config request failed'), 400);
  }
  if (!Object.hasOwn(payload, 'data')) return payload;
  return payload.data;
}

/** Request one public client configuration document without attaching credentials. */
async function requestPublicJson(origin: string, path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UCLAW_SUPPORT_REQUEST_TIMEOUT_MS);
  try {
    const installationId = normalizeManagedRuntimeInstallationId(
      await getOrCreateInstallationId().catch(() => ''),
    );
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(installationId ? { 'X-UClaw-Install-Id': installationId } : {}),
    };
    const auth = await getProviderSecret(UCLAW_AUTH_ACCOUNT_ID).catch(() => null);
    if (auth?.type === 'oauth' && auth.accessToken.trim()) {
      headers.Authorization = `Bearer ${auth.accessToken.trim()}`;
    }
    const response = await proxyAwareFetch(`${origin}${path}`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    }) as unknown as FetchJsonResponse;
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ManagedClientConfigHttpError(
        payloadMessage(payload, `${response.status} ${response.statusText}`),
        response.status,
      );
    }
    return unwrapPayload(payload);
  } catch (error) {
    if (error instanceof ManagedClientConfigHttpError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('UClaw client-config request timed out', { cause: error });
    }
    throw new Error('Unable to reach UClaw client-config', { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRemoteClientConfigPayload(origin: string): Promise<unknown> {
  let promise = remoteClientConfigPromises.get(origin);
  if (!promise) {
    promise = (async () => {
      try {
        return await requestPublicJson(origin, UCLAW_SUPPORT_ROUTES.clientConfig);
      } catch (error) {
        if (!(error instanceof ManagedClientConfigHttpError) || error.status !== 404) throw error;
        return requestPublicJson(origin, UCLAW_SUPPORT_ROUTES.bootstrap);
      }
    })().finally(() => {
      remoteClientConfigPromises.delete(origin);
    });
    remoteClientConfigPromises.set(origin, promise);
  }
  return promise;
}

async function fetchRemoteTextModelPolicy(origin: string): Promise<ManagedClientTextModelPolicy | null> {
  return normalizeTextModelOptions(textModelOptionsFromPayload(await fetchRemoteClientConfigPayload(origin)));
}

async function fetchRemoteImageModelPolicy(origin: string): Promise<ManagedClientImageModelPolicy | null> {
  return normalizeImageModelOptions(imageModelOptionsFromPayload(await fetchRemoteClientConfigPayload(origin)));
}

async function fetchRemoteVideoModelPolicy(origin: string): Promise<ManagedClientVideoModelPolicy | null> {
  const payload = await fetchRemoteClientConfigPayload(origin);
  const image = normalizeImageModelOptions(imageModelOptionsFromPayload(payload));
  if (image) await commitVerifiedImagePolicy(origin, image);
  return normalizeVideoModelOptions(videoModelOptionsFromPayload(payload));
}

async function commitVerifiedPolicy(
  origin: string,
  policy: ManagedClientTextModelPolicy,
): Promise<ManagedClientTextModelPolicy> {
  policyRevisions.set(origin, (policyRevisions.get(origin) ?? 0) + 1);
  lastVerifiedPolicies.set(origin, clonePolicy(policy));
  cachedPolicyPromises.set(origin, Promise.resolve(clonePolicy(policy)));
  await persistPolicy(origin, policy);
  logger.info('[managed-client-config] Managed text fallback policy accepted', {
    event: 'managed_text_fallback_policy',
    result: 'accepted',
    defaultModel: policy.defaultModel,
    fallbackModels: [...policy.fallbackModels],
    modelCount: policy.models.length,
  });
  return clonePolicy(policy);
}

async function commitVerifiedVideoPolicy(
  origin: string,
  policy: ManagedClientVideoModelPolicy,
): Promise<ManagedClientVideoModelPolicy> {
  const verified = { policy: cloneVideoPolicy(policy), verifiedAt: Date.now() };
  videoPolicyRevisions.set(origin, (videoPolicyRevisions.get(origin) ?? 0) + 1);
  lastVerifiedVideoPolicies.set(origin, verified);
  cachedVideoPolicyPromises.set(origin, Promise.resolve(verified));
  await persistVideoPolicy(origin, verified);
  return cloneVideoPolicy(policy);
}

async function commitVerifiedImagePolicy(
  origin: string,
  policy: ManagedClientImageModelPolicy,
): Promise<ManagedClientImageModelPolicy> {
  const verified = { policy: cloneImagePolicy(policy), verifiedAt: Date.now() };
  imagePolicyRevisions.set(origin, (imagePolicyRevisions.get(origin) ?? 0) + 1);
  lastVerifiedImagePolicies.set(origin, verified);
  cachedImagePolicyPromises.set(origin, Promise.resolve(verified));
  await persistImagePolicy(origin, verified);
  return cloneImagePolicy(policy);
}

async function getManagedClientTextModelPolicyForOrigin(
  origin: string,
  options: { refresh?: boolean },
): Promise<ManagedClientTextModelPolicy> {
  const invocationRevision = policyRevisions.get(origin) ?? 0;
  const cached = await readCachedPolicy(origin);
  if (!options.refresh || !isUclawManagedDistribution()) {
    return clonePolicy(lastVerifiedPolicies.get(origin) ?? cached);
  }

  let refreshPromise = refreshPromises.get(origin);
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const remote = await fetchRemoteTextModelPolicy(origin);
        if (remote) {
          if ((policyRevisions.get(origin) ?? 0) !== invocationRevision) {
            return clonePolicy(lastVerifiedPolicies.get(origin) ?? cached);
          }
          return commitVerifiedPolicy(origin, remote);
        }
      } catch (error) {
        logger.warn('[managed-client-config] Failed to refresh text models; using the last verified policy:', error);
      }
      return clonePolicy(lastVerifiedPolicies.get(origin) ?? cached);
    })().finally(() => {
      refreshPromises.delete(origin);
    });
    refreshPromises.set(origin, refreshPromise);
  }
  return clonePolicy(await refreshPromise);
}

async function getManagedClientImageModelPolicyForOrigin(
  origin: string,
  options: { refresh?: boolean },
): Promise<ManagedClientImageModelPolicy | null> {
  const invocationRevision = imagePolicyRevisions.get(origin) ?? 0;
  const cached = await readCachedImagePolicy(origin);
  if (!options.refresh || !isUclawManagedDistribution()) return cached;

  let refreshPromise = imageRefreshPromises.get(origin);
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const remote = await fetchRemoteImageModelPolicy(origin);
        if (remote) {
          if ((imagePolicyRevisions.get(origin) ?? 0) !== invocationRevision) {
            return readCachedImagePolicy(origin);
          }
          return commitVerifiedImagePolicy(origin, remote);
        }
      } catch (error) {
        logger.warn('[managed-client-config] Failed to refresh image models; using a current verified policy only:', error);
      }
      return readCachedImagePolicy(origin);
    })().finally(() => {
      imageRefreshPromises.delete(origin);
    });
    imageRefreshPromises.set(origin, refreshPromise);
  }
  const policy = await refreshPromise;
  return policy ? cloneImagePolicy(policy) : null;
}

async function getManagedClientVideoModelPolicyForOrigin(
  origin: string,
  options: { refresh?: boolean },
): Promise<ManagedClientVideoModelPolicy | null> {
  const invocationRevision = videoPolicyRevisions.get(origin) ?? 0;
  const cached = await readCachedVideoPolicy(origin);
  if (!options.refresh || !isUclawManagedDistribution()) {
    return cached;
  }

  let refreshPromise = videoRefreshPromises.get(origin);
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const remote = await fetchRemoteVideoModelPolicy(origin);
        if (remote) {
          if ((videoPolicyRevisions.get(origin) ?? 0) !== invocationRevision) {
            return readCachedVideoPolicy(origin);
          }
          return commitVerifiedVideoPolicy(origin, remote);
        }
      } catch (error) {
        logger.warn('[managed-client-config] Failed to refresh video models; using the last verified policy:', error);
      }
      return readCachedVideoPolicy(origin);
    })().finally(() => {
      videoRefreshPromises.delete(origin);
    });
    videoRefreshPromises.set(origin, refreshPromise);
  }
  const policy = await refreshPromise;
  return policy ? cloneVideoPolicy(policy) : null;
}

/** Cache embedded model options, or explicitly refresh them before login takes over Providers. */
export async function cacheManagedClientTextModelPolicyFromPayload(
  payload: unknown,
): Promise<ManagedClientTextModelPolicy> {
  const origin = getUclawBackendOrigin();
  const policy = normalizeTextModelOptions(textModelOptionsFromPayload(payload));
  if (policy) return commitVerifiedPolicy(origin, policy);
  return getManagedClientTextModelPolicyForOrigin(origin, { refresh: true });
}

/** Cache all server-owned model policies from one login/bootstrap document. */
export async function cacheManagedClientModelPoliciesFromPayload(
  payload: unknown,
): Promise<{
  text: ManagedClientTextModelPolicy;
  image: ManagedClientImageModelPolicy | null;
  video: ManagedClientVideoModelPolicy | null;
}> {
  const origin = getUclawBackendOrigin();
  let textPolicy = normalizeTextModelOptions(textModelOptionsFromPayload(payload));
  let imagePolicy = normalizeImageModelOptions(imageModelOptionsFromPayload(payload));
  let videoPolicy = normalizeVideoModelOptions(videoModelOptionsFromPayload(payload));

  // Commit embedded policies before network I/O so older refreshes cannot replace login state.
  const embeddedText = textPolicy ? commitVerifiedPolicy(origin, textPolicy) : null;
  const embeddedImage = imagePolicy ? commitVerifiedImagePolicy(origin, imagePolicy) : null;
  const embeddedVideo = videoPolicy ? commitVerifiedVideoPolicy(origin, videoPolicy) : null;

  if (!textPolicy || !imagePolicy || !videoPolicy) {
    try {
      const remote = await fetchRemoteClientConfigPayload(origin);
      textPolicy ??= normalizeTextModelOptions(textModelOptionsFromPayload(remote));
      imagePolicy ??= normalizeImageModelOptions(imageModelOptionsFromPayload(remote));
      videoPolicy ??= normalizeVideoModelOptions(videoModelOptionsFromPayload(remote));
    } catch (error) {
      logger.warn('[managed-client-config] Failed to refresh omitted managed model options:', error);
    }
  }

  const [text, image, video] = await Promise.all([
    embeddedText ?? (
      textPolicy
      ? commitVerifiedPolicy(origin, textPolicy)
      : getManagedClientTextModelPolicyForOrigin(origin, { refresh: false })
    ),
    embeddedImage ?? (
      imagePolicy
      ? commitVerifiedImagePolicy(origin, imagePolicy)
      : getManagedClientImageModelPolicyForOrigin(origin, { refresh: false })
    ),
    embeddedVideo ?? (
      videoPolicy
      ? commitVerifiedVideoPolicy(origin, videoPolicy)
      : getManagedClientVideoModelPolicyForOrigin(origin, { refresh: false })
    ),
  ]);
  return { text, image, video };
}

/** Read the server-owned text model policy, preserving the last successful policy on failures. */
export async function getManagedClientTextModelPolicy(
  options: { refresh?: boolean } = {},
): Promise<ManagedClientTextModelPolicy> {
  return getManagedClientTextModelPolicyForOrigin(getUclawBackendOrigin(), options);
}

/** Read the server-owned image policy; missing or expired verified data is disabled as null. */
export async function getManagedClientImageModelPolicy(
  options: { refresh?: boolean } = {},
): Promise<ManagedClientImageModelPolicy | null> {
  return getManagedClientImageModelPolicyForOrigin(getUclawBackendOrigin(), options);
}

/** Read the server-owned video policy; missing or expired verified data is disabled as null. */
export async function getManagedClientVideoModelPolicy(
  options: { refresh?: boolean } = {},
): Promise<ManagedClientVideoModelPolicy | null> {
  return getManagedClientVideoModelPolicyForOrigin(getUclawBackendOrigin(), options);
}

/** Read the current in-memory image policy without disk or network I/O. */
export function getVerifiedManagedClientImageModelPolicySnapshot(): ManagedClientImageModelPolicy | null {
  const verified = lastVerifiedImagePolicies.get(getUclawBackendOrigin());
  return isFreshVerifiedPolicy(verified) ? cloneImagePolicy(verified.policy) : null;
}

/** Read the current in-memory video policy without disk or network I/O. */
export function getVerifiedManagedClientVideoModelPolicySnapshot(): ManagedClientVideoModelPolicy | null {
  const verified = lastVerifiedVideoPolicies.get(getUclawBackendOrigin());
  return isFreshVerifiedPolicy(verified) ? cloneVideoPolicy(verified.policy) : null;
}

/** Read independent observability and feature gates. Invalid or missing fields stay disabled. */
export async function getManagedClientRuntimeConfig(
  options: { refresh?: boolean } = {},
): Promise<ManagedClientRuntimeConfig> {
  if (options.refresh) {
    return (await refreshManagedClientRuntimeConfig({ force: true })).config;
  }
  return getManagedClientRuntimeConfigSnapshot().config;
}

/** Synchronously read the latest Main-owned gate snapshot without starting network I/O. */
export function getManagedClientRuntimeConfigSnapshot(): ManagedClientRuntimeConfigSnapshot {
  const origin = getUclawBackendOrigin();
  return runtimeConfigSnapshot(runtimeConfigCache.get(origin) ?? defaultRuntimeConfigState());
}

/** Subscribe to verified runtime-config changes. The listener never performs network I/O. */
export function subscribeManagedClientRuntimeConfig(
  listener: ManagedClientRuntimeConfigListener,
): () => void {
  runtimeConfigListeners.add(listener);
  return () => runtimeConfigListeners.delete(listener);
}

/** Refresh runtime gates with one request per origin and a fail-closed 15 second negative cache. */
export function refreshManagedClientRuntimeConfig(
  options: { force?: boolean } = {},
): Promise<ManagedClientRuntimeConfigSnapshot> {
  const origin = getUclawBackendOrigin();
  const cached = runtimeConfigCache.get(origin);
  if (!options.force && cached && Date.now() - cached.verifiedAt < RUNTIME_CONFIG_CACHE_MS) {
    return Promise.resolve(runtimeConfigSnapshot(cached));
  }
  if (!isUclawManagedDistribution()) {
    return Promise.resolve(commitRuntimeConfigState(
      origin,
      createDefaultManagedClientRuntimeConfig(),
      Date.now(),
    ));
  }

  let promise = runtimeConfigRefreshPromises.get(origin);
  if (!promise) {
    promise = (async () => {
      try {
        const remote = runtimeConfigFromPayload(await fetchRemoteClientConfigPayload(origin));
        const value = await applyRuntimeFeatureRollout(remote);
        return commitRuntimeConfigState(origin, value, Date.now());
      } catch (error) {
        logger.warn('[managed-client-config] Failed to refresh runtime feature config:', error);
        return commitRuntimeConfigState(
          origin,
          createDefaultManagedClientRuntimeConfig(),
          Date.now(),
        );
      }
    })().finally(() => {
      runtimeConfigRefreshPromises.delete(origin);
    });
    runtimeConfigRefreshPromises.set(origin, promise);
  }
  return promise.then((snapshot) => ({ ...snapshot, config: cloneRuntimeConfig(snapshot.config) }));
}

/** Start the Main-owned 15 second refresh loop after proxy settings are active. */
export function startManagedClientRuntimeConfigRefresh(): () => void {
  if (!runtimeConfigRefreshTimer) {
    void refreshManagedClientRuntimeConfig({ force: true });
    runtimeConfigRefreshTimer = setInterval(() => {
      // The timer is anchored before the initial request completes. Force each
      // tick so request latency cannot make the first 15 second recheck miss
      // its cache boundary and slip to the next 30 second interval.
      void refreshManagedClientRuntimeConfig({ force: true });
    }, RUNTIME_CONFIG_CACHE_MS);
    runtimeConfigRefreshTimer.unref?.();
  }
  return () => {
    if (!runtimeConfigRefreshTimer) return;
    clearInterval(runtimeConfigRefreshTimer);
    runtimeConfigRefreshTimer = null;
  };
}
