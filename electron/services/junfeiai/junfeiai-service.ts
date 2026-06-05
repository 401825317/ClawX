import type { GatewayManager } from '../../gateway/manager';
import type { ProviderAccount } from '../../shared/providers/types';
import { OPENCLAW_API_PROTOCOLS } from '../../shared/providers/types';
import { saveProviderAccount, getProviderAccount, providerAccountToConfig } from '../providers/provider-store';
import { getClawXProviderStore } from '../providers/store-instance';
import { setProviderSecret, getProviderSecret, deleteProviderSecret } from '../secrets/secret-store';
import { setDefaultProvider, getDefaultProvider } from '../../utils/secure-storage';
import {
  syncDefaultProviderToRuntime,
  syncSavedProviderToRuntime,
} from '../providers/provider-runtime-sync';
import {
  getJunFeiAIOrigin,
  isJunFeiAIManagedDistribution,
  JUNFEIAI_AUTH_ACCOUNT_ID,
  JUNFEIAI_DEFAULT_API_PROTOCOL,
  JUNFEIAI_DEFAULT_BASE_URL,
  JUNFEIAI_DEFAULT_MODEL,
  JUNFEIAI_PROVIDER_ID,
  JUNFEIAI_PROVIDER_NAME,
} from '../../utils/junfeiai-distribution';
import { getJunFeiAIDevicePayload } from '../../utils/junfeiai-device';
import { logger } from '../../utils/logger';

type ProviderProtocol = NonNullable<ProviderAccount['apiProtocol']>;

interface Sub2APIEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

class JunFeiAIHttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'JunFeiAIHttpError';
  }
}

export interface JunFeiAIRuntimePayload {
  providerKey?: string;
  providerName?: string;
  baseUrl?: string;
  apiProtocol?: string;
  defaultModel?: string;
  fallbackModels?: string[];
}

export interface JunFeiAIBootstrapPayload {
  service?: {
    name?: string;
    displayName?: string;
    apiOrigin?: string;
  };
  auth?: {
    registrationEnabled?: boolean;
    loginEnabled?: boolean;
    activationRequired?: boolean;
  };
  runtime?: JunFeiAIRuntimePayload;
  offline?: {
    graceSeconds?: number;
    verifyMemoryCacheSeconds?: number;
  };
  skills?: {
    bundledOpenClawEnabled?: boolean;
    remoteMarketplaceEnabled?: boolean;
    remoteMarketplaceBaseUrl?: string | null;
    requiresRemoteMarketplace?: boolean;
  };
}

export interface JunFeiAIAuthPayload extends JunFeiAIBootstrapPayload {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  user?: Record<string, unknown>;
  device?: Record<string, unknown>;
}

interface JunFeiAIRelayTokenPayload {
  token?: string;
  tokenType?: string;
  expiresIn?: number | null;
  runtime?: JunFeiAIRuntimePayload;
}

type JunFeiAIVerificationCache = {
  verifiedAt: number;
  graceSeconds: number;
  payload: Record<string, unknown>;
};

export interface JunFeiAISeedResult {
  managed: boolean;
  account: ProviderAccount | null;
  bootstrap: JunFeiAIBootstrapPayload;
  source: 'remote' | 'fallback' | 'provided';
  hasRelayToken: boolean;
}

function fallbackBootstrap(): JunFeiAIBootstrapPayload {
  return {
    service: {
      name: JUNFEIAI_PROVIDER_ID,
      displayName: JUNFEIAI_PROVIDER_NAME,
      apiOrigin: getJunFeiAIOrigin(),
    },
    auth: {
      registrationEnabled: true,
      loginEnabled: true,
      activationRequired: false,
    },
    runtime: {
      providerKey: JUNFEIAI_PROVIDER_ID,
      providerName: JUNFEIAI_PROVIDER_NAME,
      baseUrl: `${getJunFeiAIOrigin()}/v1`,
      apiProtocol: JUNFEIAI_DEFAULT_API_PROTOCOL,
      defaultModel: JUNFEIAI_DEFAULT_MODEL,
      fallbackModels: [],
    },
    offline: {
      graceSeconds: 7 * 24 * 60 * 60,
      verifyMemoryCacheSeconds: 300,
    },
    skills: {
      bundledOpenClawEnabled: true,
      remoteMarketplaceEnabled: false,
      remoteMarketplaceBaseUrl: null,
      requiresRemoteMarketplace: false,
    },
  };
}

function unwrapEnvelope<T>(payload: unknown): T {
  const envelope = payload as Sub2APIEnvelope<T>;
  if (envelope && typeof envelope === 'object' && 'data' in envelope) {
    if (typeof envelope.code === 'number' && envelope.code !== 0) {
      throw new JunFeiAIHttpError(envelope.message || `Sub2API error ${envelope.code}`, envelope.code);
    }
    return envelope.data as T;
  }
  return payload as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractGraceSeconds(payload: unknown): number {
  if (isRecord(payload) && isRecord(payload.offline) && typeof payload.offline.graceSeconds === 'number') {
    return payload.offline.graceSeconds;
  }
  return fallbackBootstrap().offline?.graceSeconds ?? 0;
}

async function readVerificationCache(): Promise<JunFeiAIVerificationCache | null> {
  const store = await getClawXProviderStore();
  const cache = store.get('junfeiaiVerificationCache') as JunFeiAIVerificationCache | null;
  if (!cache || typeof cache.verifiedAt !== 'number' || typeof cache.graceSeconds !== 'number') {
    return null;
  }
  return cache;
}

async function saveVerificationCache(payload: unknown): Promise<void> {
  const store = await getClawXProviderStore();
  store.set('junfeiaiVerificationCache', {
    verifiedAt: Date.now(),
    graceSeconds: extractGraceSeconds(payload),
    payload: isRecord(payload) ? payload : {},
  } satisfies JunFeiAIVerificationCache);
}

async function clearVerificationCache(): Promise<void> {
  const store = await getClawXProviderStore();
  store.set('junfeiaiVerificationCache', null);
}

async function getOfflineGracePayload(): Promise<Record<string, unknown> | null> {
  const cache = await readVerificationCache();
  if (!cache || cache.graceSeconds <= 0) {
    return null;
  }
  const expiresAt = cache.verifiedAt + cache.graceSeconds * 1000;
  if (Date.now() > expiresAt) {
    return null;
  }
  return {
    ...cache.payload,
    valid: true,
    offlineGrace: true,
    serverTime: new Date().toISOString(),
    offline: {
      ...(isRecord(cache.payload.offline) ? cache.payload.offline : {}),
      graceSeconds: cache.graceSeconds,
      lastVerifiedAt: new Date(cache.verifiedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    },
  };
}

function canUseOfflineGraceForError(error: unknown): boolean {
  if (error instanceof JunFeiAIHttpError) {
    return error.status >= 500 || error.status === 408;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return !(
    message.includes('unauthorized')
    || message.includes('forbidden')
    || message.includes('auth_required')
    || message.includes('device_revoked')
    || message.includes('entitlement_missing')
    || message.includes('server_disabled')
  );
}

function normalizeBaseUrl(raw?: string): string {
  const normalized = (raw || JUNFEIAI_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!normalized) {
    return JUNFEIAI_DEFAULT_BASE_URL;
  }
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

function normalizeProviderProtocol(raw?: string): ProviderProtocol {
  if (
    raw === 'openai-completions'
    || raw === 'openai-responses'
    || raw === 'anthropic-messages'
  ) {
    return raw;
  }
  if (raw && !(OPENCLAW_API_PROTOCOLS as readonly string[]).includes(raw)) {
    logger.warn(`[junfeiai] Ignoring unsupported api protocol from bootstrap: ${raw}`);
  }
  return JUNFEIAI_DEFAULT_API_PROTOCOL as ProviderProtocol;
}

function normalizeFallbackModels(models?: string[]): string[] {
  return Array.from(new Set((models ?? []).map((model) => model.trim()).filter(Boolean)));
}

function buildAccount(bootstrap: JunFeiAIBootstrapPayload, existing?: ProviderAccount | null): ProviderAccount {
  const runtime = bootstrap.runtime ?? {};
  const now = new Date().toISOString();
  const providerName = runtime.providerName || bootstrap.service?.displayName || JUNFEIAI_PROVIDER_NAME;
  return {
    id: JUNFEIAI_PROVIDER_ID,
    vendorId: JUNFEIAI_PROVIDER_ID,
    label: providerName,
    authMode: 'api_key',
    baseUrl: normalizeBaseUrl(runtime.baseUrl),
    apiProtocol: normalizeProviderProtocol(runtime.apiProtocol),
    model: runtime.defaultModel || JUNFEIAI_DEFAULT_MODEL,
    fallbackModels: normalizeFallbackModels(runtime.fallbackModels),
    enabled: true,
    isDefault: true,
    metadata: {
      resourceUrl: bootstrap.service?.apiOrigin || getJunFeiAIOrigin(),
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function accountChanged(left: ProviderAccount | null, right: ProviderAccount): boolean {
  if (!left) return true;
  const fields: Array<keyof ProviderAccount> = [
    'vendorId',
    'label',
    'authMode',
    'baseUrl',
    'apiProtocol',
    'model',
    'enabled',
    'isDefault',
  ];
  if (fields.some((field) => JSON.stringify(left[field]) !== JSON.stringify(right[field]))) {
    return true;
  }
  if (JSON.stringify(left.fallbackModels ?? []) !== JSON.stringify(right.fallbackModels ?? [])) {
    return true;
  }
  return JSON.stringify(left.metadata ?? {}) !== JSON.stringify(right.metadata ?? {});
}

async function requestJunFeiAI<T>(
  path: string,
  init?: RequestInit & { accessToken?: string; timeoutMs?: number },
): Promise<T> {
  const origin = getJunFeiAIOrigin();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init?.timeoutMs ?? 12000);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    ...Object.fromEntries(new Headers(init?.headers).entries()),
  };
  if (init?.accessToken) {
    headers.Authorization = `Bearer ${init.accessToken}`;
  }

  try {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message?: unknown }).message)
        : `${response.status} ${response.statusText}`;
      throw new JunFeiAIHttpError(message, response.status);
    }
    return unwrapEnvelope<T>(payload);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJunFeiAIBootstrap(): Promise<JunFeiAIBootstrapPayload> {
  return requestJunFeiAI<JunFeiAIBootstrapPayload>('/api/clawx/bootstrap', {
    method: 'GET',
    timeoutMs: 8000,
  });
}

export async function getStoredJunFeiAIAuthToken(): Promise<string | null> {
  const secret = await getProviderSecret(JUNFEIAI_AUTH_ACCOUNT_ID);
  if (secret?.type !== 'oauth') {
    return null;
  }
  if (secret.expiresAt > 0 && secret.expiresAt < Date.now()) {
    return null;
  }
  return secret.accessToken;
}

async function storeJunFeiAIAuthSession(auth: JunFeiAIAuthPayload): Promise<void> {
  if (!auth.accessToken) {
    return;
  }
  await setProviderSecret({
    type: 'oauth',
    accountId: JUNFEIAI_AUTH_ACCOUNT_ID,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken || '',
    expiresAt: Date.now() + Math.max(1, auth.expiresIn ?? 24 * 60 * 60) * 1000,
    email: typeof auth.user?.email === 'string' ? auth.user.email : undefined,
    subject: typeof auth.user?.id === 'number' || typeof auth.user?.id === 'string'
      ? String(auth.user.id)
      : undefined,
  });
}

export async function storeJunFeiAIRelayToken(
  relayToken: string,
  bootstrap: JunFeiAIBootstrapPayload,
  gatewayManager?: GatewayManager,
): Promise<ProviderAccount> {
  const seed = await ensureJunFeiAIProviderSeeded({
    bootstrap,
    relayToken,
    gatewayManager,
  });
  if (!seed.account) {
    throw new Error('JunFeiAI provider is not available');
  }
  return seed.account;
}

async function requestRelayToken(accessToken: string, device?: Record<string, unknown>): Promise<JunFeiAIRelayTokenPayload> {
  return requestJunFeiAI<JunFeiAIRelayTokenPayload>('/api/clawx/relay-token', {
    method: 'POST',
    body: JSON.stringify({ device: device ?? await getJunFeiAIDevicePayload() }),
    accessToken,
  });
}

export async function ensureJunFeiAIProviderSeeded(options: {
  bootstrap?: JunFeiAIBootstrapPayload;
  relayToken?: string;
  gatewayManager?: GatewayManager;
  syncRuntime?: boolean;
} = {}): Promise<JunFeiAISeedResult> {
  if (!isJunFeiAIManagedDistribution()) {
    return {
      managed: false,
      account: null,
      bootstrap: fallbackBootstrap(),
      source: 'fallback',
      hasRelayToken: false,
    };
  }

  let source: JunFeiAISeedResult['source'] = options.bootstrap ? 'provided' : 'remote';
  let bootstrap = options.bootstrap;
  if (!bootstrap) {
    try {
      bootstrap = await fetchJunFeiAIBootstrap();
    } catch (error) {
      source = 'fallback';
      bootstrap = fallbackBootstrap();
      logger.warn('[junfeiai] Falling back to bundled bootstrap defaults:', error);
    }
  }

  const existing = await getProviderAccount(JUNFEIAI_PROVIDER_ID);
  const account = buildAccount(bootstrap, existing);
  if (accountChanged(existing, account)) {
    await saveProviderAccount(account);
  }

  const defaultProvider = await getDefaultProvider();
  if (defaultProvider !== JUNFEIAI_PROVIDER_ID) {
    await setDefaultProvider(JUNFEIAI_PROVIDER_ID);
  }

  if (options.relayToken?.trim()) {
    await setProviderSecret({
      type: 'api_key',
      accountId: JUNFEIAI_PROVIDER_ID,
      apiKey: options.relayToken.trim(),
    });
  }

  if (options.syncRuntime !== false) {
    const apiKey = options.relayToken?.trim() || undefined;
    await syncSavedProviderToRuntime(providerAccountToConfig(account), apiKey, options.gatewayManager);
    await syncDefaultProviderToRuntime(JUNFEIAI_PROVIDER_ID, options.gatewayManager);
  }

  return {
    managed: true,
    account,
    bootstrap,
    source,
    hasRelayToken: Boolean(await getProviderSecret(JUNFEIAI_PROVIDER_ID)),
  };
}

export async function loginJunFeiAI(
  credentials: Record<string, unknown>,
  gatewayManager?: GatewayManager,
): Promise<JunFeiAISeedResult & { auth: Omit<JunFeiAIAuthPayload, 'accessToken' | 'refreshToken'> }> {
  const auth = await requestJunFeiAI<JunFeiAIAuthPayload>('/api/clawx/login', {
    method: 'POST',
    body: JSON.stringify({ ...credentials, device: await getJunFeiAIDevicePayload() }),
  });
  await storeJunFeiAIAuthSession(auth);
  const relay = auth.accessToken ? await requestRelayToken(auth.accessToken, auth.device) : {};
  const seed = await ensureJunFeiAIProviderSeeded({
    bootstrap: auth,
    relayToken: relay.token,
    gatewayManager,
  });
  const { accessToken: _accessToken, refreshToken: _refreshToken, ...safeAuth } = auth;
  await saveVerificationCache(safeAuth);
  return { ...seed, auth: safeAuth };
}

export async function registerJunFeiAI(
  payload: Record<string, unknown>,
  gatewayManager?: GatewayManager,
): Promise<JunFeiAISeedResult & { auth: Omit<JunFeiAIAuthPayload, 'accessToken' | 'refreshToken'> }> {
  const auth = await requestJunFeiAI<JunFeiAIAuthPayload>('/api/clawx/register', {
    method: 'POST',
    body: JSON.stringify({ ...payload, device: await getJunFeiAIDevicePayload() }),
  });
  await storeJunFeiAIAuthSession(auth);
  const relay = auth.accessToken ? await requestRelayToken(auth.accessToken, auth.device) : {};
  const seed = await ensureJunFeiAIProviderSeeded({
    bootstrap: auth,
    relayToken: relay.token,
    gatewayManager,
  });
  const { accessToken: _accessToken, refreshToken: _refreshToken, ...safeAuth } = auth;
  await saveVerificationCache(safeAuth);
  return { ...seed, auth: safeAuth };
}

export async function checkJunFeiAIActivation(payload: Record<string, unknown>): Promise<unknown> {
  return requestJunFeiAI<unknown>('/api/clawx/activation/check', {
    method: 'POST',
    body: JSON.stringify({ ...payload, device: await getJunFeiAIDevicePayload() }),
  });
}

export async function verifyJunFeiAIAuth(payload: Record<string, unknown> = {}): Promise<unknown> {
  const accessToken = await getStoredJunFeiAIAuthToken();
  if (!accessToken) {
    const offline = await getOfflineGracePayload();
    if (offline) {
      return offline;
    }
    throw new Error('JunFeiAI is not logged in');
  }
  try {
    const verified = await requestJunFeiAI<unknown>('/api/clawx/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ ...payload, device: await getJunFeiAIDevicePayload() }),
      accessToken,
    });
    await saveVerificationCache(verified);
    return verified;
  } catch (error) {
    const offline = canUseOfflineGraceForError(error) ? await getOfflineGracePayload() : null;
    if (offline) {
      return offline;
    }
    throw error;
  }
}

export async function logoutJunFeiAI(): Promise<void> {
  await deleteProviderSecret(JUNFEIAI_AUTH_ACCOUNT_ID);
  await deleteProviderSecret(JUNFEIAI_PROVIDER_ID);
  await clearVerificationCache();
}
