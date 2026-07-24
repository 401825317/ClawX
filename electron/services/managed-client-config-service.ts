import type {
  ManagedClientTextModel,
  ManagedClientTextModelPolicy,
} from '../../shared/managed-client-config';
import { createDefaultManagedClientTextModelPolicy } from '../../shared/managed-client-config';
import {
  UCLAW_COMPATIBILITY_PROVIDER_ID,
  UCLAW_MANAGED_PROVIDER_ID,
  UCLAW_SUPPORT_REQUEST_TIMEOUT_MS,
  UCLAW_SUPPORT_ROUTES,
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
  version: 2;
  policiesByOrigin: Record<string, ManagedClientTextModelPolicy>;
};

const CACHE_KEY = 'textModelPolicy';
let storePromise: Promise<ManagedClientConfigStore> | null = null;
const cachedPolicyPromises = new Map<string, Promise<ManagedClientTextModelPolicy>>();
const lastVerifiedPolicies = new Map<string, ManagedClientTextModelPolicy>();
const refreshPromises = new Map<string, Promise<ManagedClientTextModelPolicy>>();
const policyRevisions = new Map<string, number>();

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
    models: policy.models.map((model) => ({ ...model })),
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

function textModelOptionsFromPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.modelOptions)) return payload.modelOptions.text;
  if (isRecord(payload.client) && isRecord(payload.client.modelOptions)) {
    return payload.client.modelOptions.text;
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
  return { defaultModel, models };
}

function normalizedCachedPolicies(value: unknown): Record<string, ManagedClientTextModelPolicy> {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.policiesByOrigin)) return {};
  const policies: Record<string, ManagedClientTextModelPolicy> = {};
  for (const [origin, policy] of Object.entries(value.policiesByOrigin)) {
    const normalized = normalizeTextModelOptions(policy);
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
      version: 2,
      policiesByOrigin,
    };
    store.set(CACHE_KEY, cache);
  } catch (error) {
    logger.warn('[managed-client-config] Failed to persist text models:', error);
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

async function fetchRemoteTextModelPolicy(origin: string): Promise<ManagedClientTextModelPolicy | null> {
  try {
    const payload = await requestPublicJson(origin, UCLAW_SUPPORT_ROUTES.clientConfig);
    return normalizeTextModelOptions(textModelOptionsFromPayload(payload));
  } catch (error) {
    if (!(error instanceof ManagedClientConfigHttpError) || error.status !== 404) throw error;
    const bootstrap = await requestPublicJson(origin, UCLAW_SUPPORT_ROUTES.bootstrap);
    return normalizeTextModelOptions(textModelOptionsFromPayload(bootstrap));
  }
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

/** Cache embedded model options, or explicitly refresh them before login takes over Providers. */
export async function cacheManagedClientTextModelPolicyFromPayload(
  payload: unknown,
): Promise<ManagedClientTextModelPolicy> {
  const origin = getUclawBackendOrigin();
  const policy = normalizeTextModelOptions(textModelOptionsFromPayload(payload));
  if (policy) return commitVerifiedPolicy(origin, policy);
  return getManagedClientTextModelPolicyForOrigin(origin, { refresh: true });
}

/** Read the server-owned text model policy, preserving the last successful policy on failures. */
export async function getManagedClientTextModelPolicy(
  options: { refresh?: boolean } = {},
): Promise<ManagedClientTextModelPolicy> {
  return getManagedClientTextModelPolicyForOrigin(getUclawBackendOrigin(), options);
}
