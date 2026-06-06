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
  getJunFeiAIBackendOrigin,
  getJunFeiAIOrigin,
  getJunFeiAIProviderBaseUrl,
  isJunFeiAIManagedDistribution,
  JUNFEIAI_AUTH_ACCOUNT_ID,
  JUNFEIAI_DEFAULT_API_PROTOCOL,
  getJunFeiAIDefaultBaseUrl,
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
  access_token?: string;
  refreshToken?: string;
  refresh_token?: string;
  expiresIn?: number;
  expires_in?: number;
  tokenType?: string;
  token_type?: string;
  user?: Record<string, unknown>;
  device?: Record<string, unknown>;
}

interface JunFeiAIRelayTokenPayload {
  token?: string;
  tokenType?: string;
  expiresIn?: number | null;
  runtime?: JunFeiAIRuntimePayload;
}

type JunFeiAIStandardApiKeyPayload = Record<string, unknown> & {
  key?: unknown;
};

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
  hasAuthToken?: boolean;
  authValid?: boolean;
  authError?: string;
  auth?: {
    user?: Record<string, unknown>;
  };
}

export interface JunFeiAITopupOrderPayload {
  money?: unknown;
  payMethod?: unknown;
  epayMethod?: unknown;
  productId?: unknown;
}

export interface JunFeiAITopupOrderStatusPayload {
  tradeNo?: unknown;
  sync?: unknown;
}

type JunFeiAIPaymentCheckoutInfo = Record<string, unknown> & {
  methods?: Record<string, JunFeiAIPaymentMethodLimit>;
  global_min?: unknown;
  global_max?: unknown;
  balance_disabled?: unknown;
  balance_recharge_multiplier?: unknown;
  recharge_fee_rate?: unknown;
};

type JunFeiAIPaymentMethodLimit = Record<string, unknown> & {
  payment_type?: unknown;
  currency?: unknown;
  fee_rate?: unknown;
  daily_limit?: unknown;
  single_min?: unknown;
  single_max?: unknown;
  available?: unknown;
};

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
      baseUrl: getJunFeiAIProviderBaseUrl(),
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

function jsonNumberAsFinite(value: unknown): number | null {
  const num = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : NaN;
  return Number.isFinite(num) ? num : null;
}

function parseTopupMoney(value: unknown): string {
  const money = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  const numeric = Number(money);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('充值金额必须大于 0');
  }
  return numeric.toFixed(2);
}

function parseRequiredString(value: unknown, fieldName: string): string {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (!text) {
    throw new Error(`${fieldName} is required`);
  }
  return text;
}

function isMissingJunFeiAICompatRoute(error: unknown): boolean {
  return error instanceof JunFeiAIHttpError && error.status === 404;
}

function isJunFeiAIAuthRejection(error: unknown): boolean {
  if (error instanceof JunFeiAIHttpError && (error.status === 401 || error.status === 403)) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('invalid token')
    || message.includes('unauthorized')
    || message.includes('forbidden')
    || message.includes('auth_required');
}

function getStringField(record: Record<string, unknown>, ...fields: string[]): string {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function getNumberField(record: Record<string, unknown>, ...fields: string[]): number | undefined {
  for (const field of fields) {
    const numeric = jsonNumberAsFinite(record[field]);
    if (numeric !== null) {
      return numeric;
    }
  }
  return undefined;
}

function normalizeJunFeiAIAuthPayload(payload: JunFeiAIAuthPayload): JunFeiAIAuthPayload {
  const record = payload as Record<string, unknown>;
  return {
    ...payload,
    accessToken: payload.accessToken || getStringField(record, 'access_token'),
    refreshToken: payload.refreshToken || getStringField(record, 'refresh_token'),
    expiresIn: payload.expiresIn ?? getNumberField(record, 'expires_in'),
    tokenType: payload.tokenType || getStringField(record, 'token_type'),
  };
}

function buildSub2APIAuthBody(payload: Record<string, unknown>): Record<string, unknown> {
  const account = getStringField(payload, 'account', 'email');
  return {
    email: account,
    password: payload.password,
    verify_code: getStringField(payload, 'verifyCode', 'verify_code') || undefined,
    turnstile_token: getStringField(payload, 'turnstileToken', 'turnstile_token') || undefined,
    promo_code: getStringField(payload, 'promoCode', 'promo_code') || undefined,
    invitation_code: getStringField(payload, 'invitationCode', 'invitation_code') || undefined,
    aff_code: getStringField(payload, 'affCode', 'aff_code') || undefined,
  };
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
  const normalized = (raw || getJunFeiAIProviderBaseUrl()).trim().replace(/\/+$/, '');
  if (!normalized) {
    return getJunFeiAIDefaultBaseUrl();
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
  const origin = getJunFeiAIBackendOrigin();
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
      throw new JunFeiAIHttpError(`${path}: ${message}`, response.status);
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

async function requireStoredJunFeiAIAuthToken(): Promise<string> {
  const accessToken = await getStoredJunFeiAIAuthToken();
  if (!accessToken) {
    throw new Error('请先在设置页重新登录 JunFeiAI 后再充值');
  }
  return accessToken;
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
  const normalized = normalizeJunFeiAIAuthPayload(auth);
  if (!normalized.accessToken) {
    return;
  }
  await setProviderSecret({
    type: 'oauth',
    accountId: JUNFEIAI_AUTH_ACCOUNT_ID,
    accessToken: normalized.accessToken,
    refreshToken: normalized.refreshToken || '',
    expiresAt: Date.now() + Math.max(1, normalized.expiresIn ?? 24 * 60 * 60) * 1000,
    email: typeof normalized.user?.email === 'string' ? normalized.user.email : undefined,
    subject: typeof normalized.user?.id === 'number' || typeof normalized.user?.id === 'string'
      ? String(normalized.user.id)
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

async function createStandardSub2APIKey(accessToken: string, device?: Record<string, unknown>): Promise<JunFeiAIRelayTokenPayload> {
  const deviceId = isRecord(device) ? String(device.id ?? '').trim() : '';
  const name = deviceId ? `ClawX ${deviceId}` : 'ClawX';
  const created = await requestJunFeiAI<JunFeiAIStandardApiKeyPayload>('/api/v1/keys', {
    method: 'POST',
    accessToken,
    body: JSON.stringify({ name }),
  });
  const token = typeof created.key === 'string' ? created.key.trim() : '';
  if (!token) {
    throw new Error('JunFeiAI did not return a usable API key');
  }
  return {
    token,
    tokenType: 'sub2api-api-key',
    expiresIn: null,
  };
}

async function requestRuntimeToken(accessToken: string, device?: Record<string, unknown>): Promise<JunFeiAIRelayTokenPayload> {
  try {
    return await requestRelayToken(accessToken, device);
  } catch (error) {
    if (!isMissingJunFeiAICompatRoute(error)) {
      throw error;
    }
    logger.warn('[junfeiai] /api/clawx/relay-token is unavailable; falling back to /api/v1/keys.');
    return createStandardSub2APIKey(accessToken, device);
  }
}

async function getJunFeiAIAuthStatus(): Promise<{
  hasAuthToken: boolean;
  authValid: boolean;
  authError?: string;
  auth?: { user?: Record<string, unknown> };
}> {
  const accessToken = await getStoredJunFeiAIAuthToken();
  if (!accessToken) {
    return {
      hasAuthToken: false,
      authValid: false,
      authError: 'JunFeiAI is not logged in',
    };
  }

  try {
    const user = await requestJunFeiAI<Record<string, unknown>>('/api/v1/auth/me', {
      method: 'GET',
      accessToken,
      timeoutMs: 8000,
    });
    return {
      hasAuthToken: true,
      authValid: true,
      auth: { user },
    };
  } catch (error) {
    return {
      hasAuthToken: true,
      authValid: false,
      authError: error instanceof Error ? error.message : String(error),
    };
  }
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

  const authStatus = await getJunFeiAIAuthStatus();

  return {
    managed: true,
    account,
    bootstrap,
    source,
    hasRelayToken: Boolean(await getProviderSecret(JUNFEIAI_PROVIDER_ID)),
    ...authStatus,
  };
}

export async function loginJunFeiAI(
  credentials: Record<string, unknown>,
  gatewayManager?: GatewayManager,
): Promise<JunFeiAISeedResult & { auth: Omit<JunFeiAIAuthPayload, 'accessToken' | 'refreshToken'> }> {
  const device = await getJunFeiAIDevicePayload();
  let auth: JunFeiAIAuthPayload;
  try {
    auth = await requestJunFeiAI<JunFeiAIAuthPayload>('/api/clawx/login', {
      method: 'POST',
      body: JSON.stringify({ ...credentials, device }),
    });
  } catch (error) {
    if (!isMissingJunFeiAICompatRoute(error)) {
      throw error;
    }
    logger.warn('[junfeiai] /api/clawx/login is unavailable; falling back to /api/v1/auth/login.');
    auth = await requestJunFeiAI<JunFeiAIAuthPayload>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(buildSub2APIAuthBody(credentials)),
    });
  }
  auth = normalizeJunFeiAIAuthPayload(auth);
  await storeJunFeiAIAuthSession(auth);
  const relay = auth.accessToken ? await requestRuntimeToken(auth.accessToken, auth.device ?? device) : {};
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
  const device = await getJunFeiAIDevicePayload();
  let auth: JunFeiAIAuthPayload;
  try {
    auth = await requestJunFeiAI<JunFeiAIAuthPayload>('/api/clawx/register', {
      method: 'POST',
      body: JSON.stringify({ ...payload, device }),
    });
  } catch (error) {
    if (!isMissingJunFeiAICompatRoute(error)) {
      throw error;
    }
    logger.warn('[junfeiai] /api/clawx/register is unavailable; falling back to /api/v1/auth/register.');
    auth = await requestJunFeiAI<JunFeiAIAuthPayload>('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify(buildSub2APIAuthBody(payload)),
    });
  }
  auth = normalizeJunFeiAIAuthPayload(auth);
  await storeJunFeiAIAuthSession(auth);
  const relay = auth.accessToken ? await requestRuntimeToken(auth.accessToken, auth.device ?? device) : {};
  const seed = await ensureJunFeiAIProviderSeeded({
    bootstrap: auth,
    relayToken: relay.token,
    gatewayManager,
  });
  const { accessToken: _accessToken, refreshToken: _refreshToken, ...safeAuth } = auth;
  await saveVerificationCache(safeAuth);
  return { ...seed, auth: safeAuth };
}

export async function sendJunFeiAIVerificationCode(payload: Record<string, unknown>): Promise<unknown> {
  try {
    return await requestJunFeiAI<unknown>('/api/clawx/verification/send-code', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (!isMissingJunFeiAICompatRoute(error)) {
      throw error;
    }
    return requestJunFeiAI<unknown>('/api/v1/auth/send-verify-code', {
      method: 'POST',
      body: JSON.stringify({
        email: getStringField(payload, 'email', 'account'),
        turnstile_token: getStringField(payload, 'turnstileToken', 'turnstile_token') || undefined,
      }),
    });
  }
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
    let verified: unknown;
    try {
      verified = await requestJunFeiAI<unknown>('/api/clawx/auth/verify', {
        method: 'POST',
        body: JSON.stringify({ ...payload, device: await getJunFeiAIDevicePayload() }),
        accessToken,
      });
    } catch (error) {
      if (!isMissingJunFeiAICompatRoute(error)) {
        throw error;
      }
      const user = await requestJunFeiAI<Record<string, unknown>>('/api/v1/auth/me', {
        method: 'GET',
        accessToken,
      });
      verified = {
        valid: true,
        serverTime: new Date().toISOString(),
        user,
        offline: fallbackBootstrap().offline,
      };
    }
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

function getFiniteNumber(value: unknown, fallback = 0): number {
  const numeric = jsonNumberAsFinite(value);
  return numeric === null ? fallback : numeric;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const numeric = jsonNumberAsFinite(value);
  return numeric !== null && numeric > 0 ? numeric : fallback;
}

function normalizePaymentMethodLabel(type: string): string {
  switch (type) {
    case 'alipay':
    case 'alipay_direct':
      return '支付宝';
    case 'wxpay':
    case 'wxpay_direct':
      return '微信支付';
    case 'easypay':
      return '易支付';
    case 'airwallex':
      return 'Airwallex';
    case 'card':
      return '银行卡';
    case 'link':
      return '支付链接';
    case 'stripe':
      return 'Stripe';
    default:
      return type;
  }
}

function normalizePaymentMethods(methods: unknown): Array<Record<string, unknown>> {
  if (!isRecord(methods)) {
    return [];
  }

  return Object.entries(methods)
    .flatMap(([key, raw]) => {
      const item = isRecord(raw) ? raw as JunFeiAIPaymentMethodLimit : {};
      if (item.available === false) {
        return [];
      }
      const paymentType = String(item.payment_type ?? key).trim();
      if (!paymentType) {
        return [];
      }
      return [{
        type: paymentType,
        name: normalizePaymentMethodLabel(paymentType),
        currency: String(item.currency ?? '').trim(),
        fee_rate: getFiniteNumber(item.fee_rate, 0),
        single_min: getFiniteNumber(item.single_min, 0),
        single_max: getFiniteNumber(item.single_max, 0),
        daily_limit: getFiniteNumber(item.daily_limit, 0),
      }];
    });
}

function getUserBalance(user: Record<string, unknown>): number {
  const balance = jsonNumberAsFinite(user.balance);
  if (balance !== null && balance >= 0) {
    return balance;
  }
  const shrimpQuota = jsonNumberAsFinite(user.shrimp_quota);
  if (shrimpQuota !== null && shrimpQuota >= 0) {
    return shrimpQuota;
  }
  return 0;
}

function getOrderTradeNo(order: Record<string, unknown>): string {
  return String(order.out_trade_no ?? order.trade_no ?? order.order_id ?? order.id ?? '').trim();
}

function getOrderPaymentUrl(order: Record<string, unknown>): string {
  const direct = String(order.pay_url ?? order.checkout_url ?? order.pay_page_url ?? '').trim();
  if (direct) {
    return direct;
  }
  if (isRecord(order.oauth)) {
    return String(order.oauth.authorize_url ?? '').trim();
  }
  return '';
}

function normalizeTopupOrderResult(
  order: Record<string, unknown>,
  amount: number,
  paymentType: string,
  multiplier = 1,
): Record<string, unknown> {
  const tradeNo = getOrderTradeNo(order);
  const paymentUrl = getOrderPaymentUrl(order);
  const creditQuota = Math.round(amount * multiplier * 100) / 100;
  const nextStatus = normalizeTopupPaymentStatus(order.status);
  return {
    ...order,
    status: nextStatus === 'success' ? 'success' : 'pending',
    trade_no: tradeNo,
    checkout_url: paymentUrl,
    pay_page_url: paymentUrl,
    pay_url: paymentUrl,
    qr_code: String(order.qr_code ?? ''),
    credit_quota: creditQuota,
    money: amount.toFixed(2),
    pay_method: 'epay',
    epay_method: String(order.payment_type ?? paymentType),
  };
}

function normalizeTopupPaymentStatus(status: unknown): 'pending' | 'success' | 'failed' {
  const normalized = String(status ?? '').trim().toUpperCase();
  if (normalized === 'SUCCESS' || normalized === 'COMPLETED') {
    return 'success';
  }
  if (
    normalized === 'FAILED'
    || normalized === 'EXPIRED'
    || normalized === 'CANCELLED'
    || normalized === 'REFUNDED'
    || normalized === 'PARTIALLY_REFUNDED'
    || normalized === 'REFUND_FAILED'
  ) {
    return 'failed';
  }
  return 'pending';
}

function normalizeTopupOrderStatusResult(order: Record<string, unknown>): Record<string, unknown> {
  return {
    ...order,
    status: normalizeTopupPaymentStatus(order.status),
    trade_no: getOrderTradeNo(order),
    credit_quota: getFiniteNumber(order.amount, 0),
  };
}

function normalizeTopupAuthError(error: unknown): never {
  if (isJunFeiAIAuthRejection(error)) {
    throw new Error('JunFeiAI 登录状态已失效，请先在设置页重新登录后再充值');
  }
  throw error;
}

export async function getJunFeiAITopupOverview(): Promise<Record<string, unknown>> {
  const accessToken = await requireStoredJunFeiAIAuthToken();
  let user: Record<string, unknown>;
  let checkoutInfo: JunFeiAIPaymentCheckoutInfo;
  try {
    [user, checkoutInfo] = await Promise.all([
      requestJunFeiAI<Record<string, unknown>>('/api/v1/auth/me', {
        method: 'GET',
        accessToken,
      }),
      requestJunFeiAI<JunFeiAIPaymentCheckoutInfo>('/api/v1/payment/checkout-info', {
        method: 'GET',
        accessToken,
      }),
    ]);
  } catch (error) {
    normalizeTopupAuthError(error);
  }

  const shrimpQuota = getUserBalance(user);
  const rechargeMultiplier = normalizePositiveNumber(checkoutInfo.balance_recharge_multiplier, 1);
  const methods = normalizePaymentMethods(checkoutInfo.methods);
  const nextUser = { ...user };
  nextUser.shrimp_quota = shrimpQuota;

  return {
    user: nextUser,
    quotaPerUnit: 1,
    topupInfo: {
      payg_current_quota: shrimpQuota,
      payg_credit_usd_per_cny: rechargeMultiplier,
      enable_online_topup: checkoutInfo.balance_disabled !== true && methods.length > 0,
      pay_methods: JSON.stringify(methods),
      payg_products: [{
        id: 1,
        name: '余额充值',
        description: '充值后自动增加账户余额',
        enabled: checkoutInfo.balance_disabled !== true,
        sort_order: 0,
        stock: null,
        allowed_group_ids: [1],
      }],
      global_min: getFiniteNumber(checkoutInfo.global_min, 0),
      global_max: getFiniteNumber(checkoutInfo.global_max, 0),
      recharge_fee_rate: getFiniteNumber(checkoutInfo.recharge_fee_rate, 0),
      payment_checkout_info: checkoutInfo,
    },
  };
}

export async function createJunFeiAITopupOrder(payload: JunFeiAITopupOrderPayload): Promise<unknown> {
  const accessToken = await requireStoredJunFeiAIAuthToken();
  const moneyText = parseTopupMoney(payload.money);
  const money = Number(moneyText);
  const epayMethod = parseRequiredString(payload.epayMethod, 'epayMethod');
  let checkoutInfo: JunFeiAIPaymentCheckoutInfo;
  try {
    checkoutInfo = await requestJunFeiAI<JunFeiAIPaymentCheckoutInfo>('/api/v1/payment/checkout-info', {
      method: 'GET',
      accessToken,
    });
  } catch (error) {
    normalizeTopupAuthError(error);
  }
  const rechargeMultiplier = normalizePositiveNumber(checkoutInfo.balance_recharge_multiplier, 1);

  let result: Record<string, unknown>;
  try {
    result = await requestJunFeiAI<Record<string, unknown>>('/api/v1/payment/orders', {
      method: 'POST',
      accessToken,
      body: JSON.stringify({
        amount: money,
        payment_type: epayMethod,
        order_type: 'balance',
        payment_source: 'clawx',
        is_mobile: false,
      }),
    });
  } catch (error) {
    normalizeTopupAuthError(error);
  }
  return normalizeTopupOrderResult(result, money, epayMethod, rechargeMultiplier);
}

export async function getJunFeiAITopupOrderStatus(
  payload: JunFeiAITopupOrderStatusPayload,
): Promise<unknown> {
  const accessToken = await requireStoredJunFeiAIAuthToken();
  const tradeNo = parseRequiredString(payload.tradeNo, 'tradeNo');
  let result: Record<string, unknown>;
  try {
    result = await requestJunFeiAI<Record<string, unknown>>('/api/v1/payment/orders/verify', {
      method: 'POST',
      accessToken,
      body: JSON.stringify({
        out_trade_no: tradeNo,
      }),
    });
  } catch (error) {
    normalizeTopupAuthError(error);
  }
  return normalizeTopupOrderStatusResult(result);
}

export async function logoutJunFeiAI(): Promise<void> {
  await deleteProviderSecret(JUNFEIAI_AUTH_ACCOUNT_ID);
  await deleteProviderSecret(JUNFEIAI_PROVIDER_ID);
  await clearVerificationCache();
}
