import type {
  ManagedClientTextModel,
  ManagedClientTextModelPolicy,
  ManagedClientVideoModel,
  ManagedClientVideoModelPolicy,
} from '../../shared/managed-client-config';
import {
  createDefaultManagedClientTextModelPolicy,
  createDefaultManagedClientVideoModelPolicy,
} from '../../shared/managed-client-config';
import {
  UCLAW_COMPATIBILITY_PROVIDER_ID,
  UCLAW_DEFAULT_THINKING_LEVEL,
  UCLAW_MANAGED_PROVIDER_ID,
  UCLAW_SUPPORT_REQUEST_TIMEOUT_MS,
  UCLAW_SUPPORT_ROUTES,
  UCLAW_VIDEO_MODELS,
} from '../../shared/junfeiai-endpoints';
import type {
  UclawThinkingLevel,
  UclawVideoAspectRatio,
  UclawVideoMode,
  UclawVideoResolution,
} from '../../shared/junfeiai-endpoints';
import {
  getUclawBackendOrigin,
  isUclawManagedDistribution,
} from '../utils/junfeiai-distribution';
import { logger } from '../utils/logger';
import { proxyAwareFetch } from '../utils/proxy-fetch';
import { isRecord } from './payload-utils';

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
  version: 1;
  policiesByOrigin: Record<string, ManagedClientVideoModelPolicy>;
};

const CACHE_KEY = 'textModelPolicy';
const VIDEO_CACHE_KEY = 'videoModelPolicy';
let storePromise: Promise<ManagedClientConfigStore> | null = null;
const cachedPolicyPromises = new Map<string, Promise<ManagedClientTextModelPolicy>>();
const lastVerifiedPolicies = new Map<string, ManagedClientTextModelPolicy>();
const refreshPromises = new Map<string, Promise<ManagedClientTextModelPolicy>>();
const policyRevisions = new Map<string, number>();
const cachedVideoPolicyPromises = new Map<string, Promise<ManagedClientVideoModelPolicy>>();
const lastVerifiedVideoPolicies = new Map<string, ManagedClientVideoModelPolicy>();
const videoRefreshPromises = new Map<string, Promise<ManagedClientVideoModelPolicy>>();
const videoPolicyRevisions = new Map<string, number>();
const remoteClientConfigPromises = new Map<string, Promise<unknown>>();

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
    defaultThinkingLevel: policy.defaultThinkingLevel,
    models: policy.models.map((model) => ({ ...model })),
  };
}

function cloneVideoPolicy(policy: ManagedClientVideoModelPolicy): ManagedClientVideoModelPolicy {
  return {
    defaultModel: policy.defaultModel,
    defaultAspectRatio: policy.defaultAspectRatio,
    defaultResolution: policy.defaultResolution,
    defaultDurationSeconds: policy.defaultDurationSeconds,
    models: policy.models.map((model) => ({
      ...model,
      modes: [...model.modes],
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
  const configuredDefault = managedModelId(value.defaultModel);
  const defaultModel = models.some((model) => model.id === configuredDefault)
    ? configuredDefault
    : models[0].id;
  return {
    defaultModel,
    defaultThinkingLevel: normalizeThinkingLevel(value.defaultThinkingLevel),
    models,
  };
}

function normalizeVideoResolution(value: unknown): UclawVideoResolution | null {
  const normalized = stringValue(value).toUpperCase();
  return normalized === '480P' || normalized === '720P' ? normalized : null;
}

function normalizeVideoAspectRatio(value: unknown): UclawVideoAspectRatio | null {
  const normalized = stringValue(value);
  return ['2:3', '3:2', '1:1', '9:16', '16:9'].includes(normalized)
    ? normalized as UclawVideoAspectRatio
    : null;
}

function legacyVideoSizeResolution(value: unknown): UclawVideoResolution | null {
  const match = stringValue(value).match(/^(\d+)x(\d+)$/iu);
  if (!match) return null;
  const shortEdge = Math.min(Number(match[1]), Number(match[2]));
  if (shortEdge === 480) return '480P';
  if (shortEdge === 720) return '720P';
  return null;
}

function normalizeVideoModes(
  value: unknown,
  supported: readonly UclawVideoMode[],
): UclawVideoMode[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(supported);
  return [...new Set(value
    .map((entry) => stringValue(entry) as UclawVideoMode)
    .filter((entry) => allowed.has(entry)))];
}

function normalizeVideoAspectRatios(
  value: unknown,
  supported: readonly UclawVideoAspectRatio[],
): UclawVideoAspectRatio[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(supported);
  return [...new Set(value
    .map(normalizeVideoAspectRatio)
    .filter((entry): entry is UclawVideoAspectRatio => entry !== null && allowed.has(entry)))];
}

function normalizeVideoResolutions(
  value: unknown,
  legacySizes: unknown,
  supported: readonly UclawVideoResolution[],
): UclawVideoResolution[] {
  const source = Array.isArray(value)
    ? value.map(normalizeVideoResolution)
    : (Array.isArray(legacySizes) ? legacySizes.map(legacyVideoSizeResolution) : []);
  const allowed = new Set(supported);
  return [...new Set(source.filter((entry): entry is UclawVideoResolution => (
    entry !== null && allowed.has(entry)
  )))];
}

function normalizeVideoDurations(value: unknown, supported: readonly number[]): number[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(supported);
  return [...new Set(value.filter((entry): entry is number => (
    typeof entry === 'number' && Number.isInteger(entry) && allowed.has(entry)
  )))];
}

function normalizeVideoModel(value: unknown): ManagedClientVideoModel | null {
  if (!isRecord(value) || value.enabled === false) return null;
  const id = stringValue(value.id);
  const local = UCLAW_VIDEO_MODELS.find((model) => model.id === id);
  if (!local) return null;
  const modes = normalizeVideoModes(value.modes, local.modes);
  const aspectRatios = Array.isArray(value.aspectRatios)
    ? normalizeVideoAspectRatios(value.aspectRatios, local.aspectRatios)
    : [...local.aspectRatios];
  const resolutions = normalizeVideoResolutions(value.resolutions, value.sizes, local.resolutions);
  const durations = normalizeVideoDurations(value.durations, local.durations);
  if (modes.length === 0 || aspectRatios.length === 0 || resolutions.length === 0 || durations.length === 0) return null;
  const explicitDefaultAspectRatio = normalizeVideoAspectRatio(value.defaultAspectRatio);
  const defaultAspectRatio = explicitDefaultAspectRatio && aspectRatios.includes(explicitDefaultAspectRatio)
    ? explicitDefaultAspectRatio
    : (aspectRatios.includes(local.defaultAspectRatio) ? local.defaultAspectRatio : aspectRatios[0]);
  const explicitDefaultResolution = normalizeVideoResolution(value.defaultResolution);
  const defaultResolution = explicitDefaultResolution && resolutions.includes(explicitDefaultResolution)
    ? explicitDefaultResolution
    : (resolutions.includes(local.defaultResolution) ? local.defaultResolution : resolutions[0]);
  const configuredDuration = typeof value.defaultDurationSeconds === 'number'
    ? value.defaultDurationSeconds
    : null;
  const defaultDurationSeconds = configuredDuration !== null && durations.includes(configuredDuration)
    ? configuredDuration
    : (durations.includes(local.defaultDurationSeconds) ? local.defaultDurationSeconds : durations[0]);
  const label = stringValue(value.label);
  const description = stringValue(value.description);
  return {
    id,
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    modes,
    aspectRatios,
    resolutions,
    durations,
    defaultAspectRatio,
    defaultResolution,
    defaultDurationSeconds,
    requiresImage: local.requiresImage || value.requiresImage === true,
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
  const fallback = createDefaultManagedClientVideoModelPolicy();
  const configuredDefaultModel = stringValue(value.defaultModel);
  const defaultModel = models.some((model) => model.id === configuredDefaultModel)
    ? configuredDefaultModel
    : (models.some((model) => model.id === fallback.defaultModel) ? fallback.defaultModel : models[0].id);
  const selectedModel = models.find((model) => model.id === defaultModel)!;
  const configuredAspectRatio = normalizeVideoAspectRatio(value.defaultAspectRatio);
  const defaultAspectRatio = configuredAspectRatio && selectedModel.aspectRatios.includes(configuredAspectRatio)
    ? configuredAspectRatio
    : (selectedModel.aspectRatios.includes(fallback.defaultAspectRatio)
      ? fallback.defaultAspectRatio
      : selectedModel.defaultAspectRatio);
  const configuredResolution = normalizeVideoResolution(value.defaultResolution);
  const defaultResolution = configuredResolution && selectedModel.resolutions.includes(configuredResolution)
    ? configuredResolution
    : (selectedModel.resolutions.includes(fallback.defaultResolution)
      ? fallback.defaultResolution
      : selectedModel.defaultResolution);
  const configuredDuration = typeof value.defaultDurationSeconds === 'number'
    ? value.defaultDurationSeconds
    : null;
  const defaultDurationSeconds = configuredDuration !== null && selectedModel.durations.includes(configuredDuration)
    ? configuredDuration
    : (selectedModel.durations.includes(fallback.defaultDurationSeconds)
      ? fallback.defaultDurationSeconds
      : selectedModel.defaultDurationSeconds);
  return { defaultModel, defaultAspectRatio, defaultResolution, defaultDurationSeconds, models };
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

function normalizedCachedVideoPolicies(value: unknown): Record<string, ManagedClientVideoModelPolicy> {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.policiesByOrigin)) return {};
  const policies: Record<string, ManagedClientVideoModelPolicy> = {};
  for (const [origin, policy] of Object.entries(value.policiesByOrigin)) {
    const normalized = normalizeVideoModelOptions(policy);
    if (normalized) policies[origin] = normalized;
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

async function readCachedVideoPolicy(origin: string): Promise<ManagedClientVideoModelPolicy> {
  let cachedPolicyPromise = cachedVideoPolicyPromises.get(origin);
  if (!cachedPolicyPromise) {
    const startingRevision = videoPolicyRevisions.get(origin) ?? 0;
    cachedPolicyPromise = (async () => {
      try {
        const store = await getStore();
        const normalized = normalizedCachedVideoPolicies(store.get(VIDEO_CACHE_KEY))[origin];
        if (normalized) {
          if ((videoPolicyRevisions.get(origin) ?? 0) === startingRevision) {
            lastVerifiedVideoPolicies.set(origin, normalized);
          }
          return cloneVideoPolicy(lastVerifiedVideoPolicies.get(origin) ?? normalized);
        }
      } catch (error) {
        logger.warn('[managed-client-config] Failed to read cached video models:', error);
      }
      return cloneVideoPolicy(
        lastVerifiedVideoPolicies.get(origin) ?? createDefaultManagedClientVideoModelPolicy(),
      );
    })();
    cachedVideoPolicyPromises.set(origin, cachedPolicyPromise);
  }
  return cloneVideoPolicy(await cachedPolicyPromise);
}

async function persistVideoPolicy(origin: string, policy: ManagedClientVideoModelPolicy): Promise<void> {
  try {
    const store = await getStore();
    const policiesByOrigin = normalizedCachedVideoPolicies(store.get(VIDEO_CACHE_KEY));
    policiesByOrigin[origin] = cloneVideoPolicy(policy);
    const cache: ManagedClientVideoModelCache = { version: 1, policiesByOrigin };
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
    const response = await proxyAwareFetch(`${origin}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
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

async function fetchRemoteVideoModelPolicy(origin: string): Promise<ManagedClientVideoModelPolicy | null> {
  return normalizeVideoModelOptions(videoModelOptionsFromPayload(await fetchRemoteClientConfigPayload(origin)));
}

async function commitVerifiedPolicy(
  origin: string,
  policy: ManagedClientTextModelPolicy,
): Promise<ManagedClientTextModelPolicy> {
  policyRevisions.set(origin, (policyRevisions.get(origin) ?? 0) + 1);
  lastVerifiedPolicies.set(origin, clonePolicy(policy));
  cachedPolicyPromises.set(origin, Promise.resolve(clonePolicy(policy)));
  await persistPolicy(origin, policy);
  return clonePolicy(policy);
}

async function commitVerifiedVideoPolicy(
  origin: string,
  policy: ManagedClientVideoModelPolicy,
): Promise<ManagedClientVideoModelPolicy> {
  videoPolicyRevisions.set(origin, (videoPolicyRevisions.get(origin) ?? 0) + 1);
  lastVerifiedVideoPolicies.set(origin, cloneVideoPolicy(policy));
  cachedVideoPolicyPromises.set(origin, Promise.resolve(cloneVideoPolicy(policy)));
  await persistVideoPolicy(origin, policy);
  return cloneVideoPolicy(policy);
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

async function getManagedClientVideoModelPolicyForOrigin(
  origin: string,
  options: { refresh?: boolean },
): Promise<ManagedClientVideoModelPolicy> {
  const invocationRevision = videoPolicyRevisions.get(origin) ?? 0;
  const cached = await readCachedVideoPolicy(origin);
  if (!options.refresh || !isUclawManagedDistribution()) {
    return cloneVideoPolicy(lastVerifiedVideoPolicies.get(origin) ?? cached);
  }

  let refreshPromise = videoRefreshPromises.get(origin);
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const remote = await fetchRemoteVideoModelPolicy(origin);
        if (remote) {
          if ((videoPolicyRevisions.get(origin) ?? 0) !== invocationRevision) {
            return cloneVideoPolicy(lastVerifiedVideoPolicies.get(origin) ?? cached);
          }
          return commitVerifiedVideoPolicy(origin, remote);
        }
      } catch (error) {
        logger.warn('[managed-client-config] Failed to refresh video models; using the last verified policy:', error);
      }
      return cloneVideoPolicy(lastVerifiedVideoPolicies.get(origin) ?? cached);
    })().finally(() => {
      videoRefreshPromises.delete(origin);
    });
    videoRefreshPromises.set(origin, refreshPromise);
  }
  return cloneVideoPolicy(await refreshPromise);
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

/** Cache server-owned text and video policies from one login/bootstrap document. */
export async function cacheManagedClientModelPoliciesFromPayload(
  payload: unknown,
): Promise<{ text: ManagedClientTextModelPolicy; video: ManagedClientVideoModelPolicy }> {
  const origin = getUclawBackendOrigin();
  let textPolicy = normalizeTextModelOptions(textModelOptionsFromPayload(payload));
  let videoPolicy = normalizeVideoModelOptions(videoModelOptionsFromPayload(payload));

  // Commit embedded policies before network I/O so older refreshes cannot replace login state.
  const embeddedText = textPolicy ? commitVerifiedPolicy(origin, textPolicy) : null;
  const embeddedVideo = videoPolicy ? commitVerifiedVideoPolicy(origin, videoPolicy) : null;

  if (!textPolicy || !videoPolicy) {
    try {
      const remote = await fetchRemoteClientConfigPayload(origin);
      textPolicy ??= normalizeTextModelOptions(textModelOptionsFromPayload(remote));
      videoPolicy ??= normalizeVideoModelOptions(videoModelOptionsFromPayload(remote));
    } catch (error) {
      logger.warn('[managed-client-config] Failed to refresh omitted managed model options:', error);
    }
  }

  const [text, video] = await Promise.all([
    embeddedText ?? (
      textPolicy
      ? commitVerifiedPolicy(origin, textPolicy)
      : getManagedClientTextModelPolicyForOrigin(origin, { refresh: false })
    ),
    embeddedVideo ?? (
      videoPolicy
      ? commitVerifiedVideoPolicy(origin, videoPolicy)
      : getManagedClientVideoModelPolicyForOrigin(origin, { refresh: false })
    ),
  ]);
  return { text, video };
}

/** Read the server-owned text model policy, preserving the last successful policy on failures. */
export async function getManagedClientTextModelPolicy(
  options: { refresh?: boolean } = {},
): Promise<ManagedClientTextModelPolicy> {
  return getManagedClientTextModelPolicyForOrigin(getUclawBackendOrigin(), options);
}

/** Read the server-owned video model policy, preserving the last verified policy on failures. */
export async function getManagedClientVideoModelPolicy(
  options: { refresh?: boolean } = {},
): Promise<ManagedClientVideoModelPolicy> {
  return getManagedClientVideoModelPolicyForOrigin(getUclawBackendOrigin(), options);
}
