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
import { removeProviderKeyFromOpenClaw } from '../../utils/openclaw-auth';
import {
  getJunFeiAIBackendOrigin,
  getJunFeiAIOrigin,
  getJunFeiAIProviderBaseUrl,
  isJunFeiAIManagedDistribution,
  isJunFeiAIDevOverrideEnabled,
  JUNFEIAI_AUTH_ACCOUNT_ID,
  JUNFEIAI_DEFAULT_API_PROTOCOL,
  getJunFeiAIDefaultBaseUrl,
  JUNFEIAI_DEFAULT_MODEL,
  JUNFEIAI_PROVIDER_ID,
  JUNFEIAI_PROVIDER_NAME,
} from '../../utils/junfeiai-distribution';
import {
  getJunFeiAIDevicePayload,
  markJunFeiAIDeviceActivated,
  readJunFeiAIDeviceActivationState,
} from '../../utils/junfeiai-device';
import { logger } from '../../utils/logger';

type ProviderProtocol = NonNullable<ProviderAccount['apiProtocol']>;

interface Sub2APIEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

class JunFeiAIHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = 'JunFeiAIHttpError';
  }
}

export class JunFeiAIUserError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'JunFeiAIUserError';
  }
}

export interface JunFeiAIRuntimePayload {
  providerKey?: string;
  providerName?: string;
  baseUrl?: string;
  apiProtocol?: string;
  defaultModel?: string;
  fallbackModels?: string[];
  modelFamilies?: Array<{ id?: unknown; name?: unknown }>;
}

export interface JunFeiAIBootstrapPayload {
  service?: {
    name?: string;
    displayName?: string;
    apiOrigin?: string;
  };
  auth?: {
    registrationEnabled?: boolean;
    emailVerifyEnabled?: boolean;
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
  client?: JunFeiAIClientConfigPayload;
}

export interface JunFeiAIClientAnnouncement {
  id?: string;
  title?: string;
  content?: string;
  level?: 'normal' | 'important' | 'urgent';
  publishedAt?: string;
  expiresAt?: string;
  link?: string;
  enabled?: boolean;
}

export interface JunFeiAIClientConfigPayload {
  announcements?: {
    enabled?: boolean;
    items?: JunFeiAIClientAnnouncement[];
  };
  support?: {
    enabled?: boolean;
    title?: string;
    description?: string;
    contacts?: Array<{
      id?: string;
      label?: string;
      description?: string;
      qrCodeUrl?: string;
      workHours?: string;
      wechatId?: string;
      extraNote?: string;
      enabled?: boolean;
    }>;
    qrCodeUrl?: string;
    workHours?: string;
    wechatId?: string;
    extraNote?: string;
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

interface JunFeiAIRefreshPayload {
  accessToken?: string;
  access_token?: string;
  refreshToken?: string;
  refresh_token?: string;
  expiresIn?: number;
  expires_in?: number;
  tokenType?: string;
  token_type?: string;
}

interface JunFeiAIRelayTokenPayload {
  token?: string;
  tokenType?: string;
  expiresIn?: number | null;
  runtime?: JunFeiAIRuntimePayload;
}

const JUNFEIAI_FALLBACK_MODELS_ON_FETCH_ERROR = [
  'smart-latest',
  'qwen-latest',
  'deepseek-latest',
  'doubao-latest',
  'kimi-latest',
  'glm-latest',
] as const;

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
  deviceActivated?: boolean;
  activationRequired?: boolean;
  relayOwnerUserId?: string;
  hasAuthToken?: boolean;
  authValid?: boolean;
  authRejected?: boolean;
  authError?: string;
  auth?: {
    user?: Record<string, unknown>;
  };
}

export function isJunFeiAISeedReady(seed: Pick<
  JunFeiAISeedResult,
  'managed' | 'hasRelayToken' | 'hasAuthToken' | 'authValid' | 'activationRequired'
>): boolean {
  if (!seed.managed) {
    return true;
  }
  return Boolean(seed.hasRelayToken)
    && Boolean(seed.hasAuthToken)
    && Boolean(seed.authValid)
    && seed.activationRequired !== true;
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

export interface JunFeiAITopupOrdersPayload {
  page?: unknown;
  pageSize?: unknown;
}

type StoredProviderSecret = Awaited<ReturnType<typeof getProviderSecret>>;
type StoredApiKeySecret = Extract<NonNullable<StoredProviderSecret>, { type: 'api_key' }>;

function fallbackBootstrap(): JunFeiAIBootstrapPayload {
  return {
    service: {
      name: JUNFEIAI_PROVIDER_ID,
      displayName: JUNFEIAI_PROVIDER_NAME,
      apiOrigin: getJunFeiAIOrigin(),
    },
    auth: {
      registrationEnabled: true,
      emailVerifyEnabled: false,
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

async function applyLocalDeviceActivationState(
  bootstrap: JunFeiAIBootstrapPayload,
  user?: Record<string, unknown> | null,
): Promise<{ bootstrap: JunFeiAIBootstrapPayload; deviceActivated: boolean; activationRequired: boolean }> {
  const activationState = await readJunFeiAIDeviceActivationState();
  const userId = getUserId(user);
  const activationUserId = typeof activationState?.userId === 'string' && activationState.userId.trim()
    ? activationState.userId.trim()
    : undefined;
  const deviceActivated = Boolean(
    activationState?.activated
    && activationState.onboardingCompleted
    && userId
    && (!activationUserId || activationUserId === userId),
  );

  if (deviceActivated && activationState && !activationUserId && userId) {
    try {
      await markJunFeiAIDeviceActivated(activationState.source, getActivationUser(user));
    } catch (error) {
      logger.warn('[junfeiai] Failed to bind legacy device activation to current user:', error);
    }
  }

  if (!deviceActivated) {
    return {
      bootstrap,
      deviceActivated,
      activationRequired: Boolean(bootstrap.auth?.activationRequired),
    };
  }

  return {
    deviceActivated,
    activationRequired: false,
    bootstrap: {
      ...bootstrap,
      auth: {
        ...(bootstrap.auth ?? {}),
        activationRequired: false,
      },
    },
  };
}

function unwrapEnvelope<T>(payload: unknown): T {
  if (isRecord(payload) && payload.success === false) {
    const code = getPayloadErrorCode(payload);
    const message = getPayloadErrorMessage(payload) || 'Request failed';
    throw new JunFeiAIHttpError(message, 400, code, payload);
  }

  const envelope = payload as Sub2APIEnvelope<T>;
  if (envelope && typeof envelope === 'object' && 'data' in envelope) {
    if (typeof envelope.code === 'number' && envelope.code !== 0) {
      throw new JunFeiAIHttpError(envelope.message || `API error ${envelope.code}`, envelope.code, String(envelope.code), payload);
    }
    return envelope.data as T;
  }
  return payload as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getPayloadString(payload: unknown, ...keys: string[]): string {
  if (!isRecord(payload)) {
    return '';
  }
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return '';
}

function getPayloadErrorCode(payload: unknown): string {
  const direct = getPayloadString(payload, 'errorCode', 'error_code', 'code');
  if (direct) {
    return direct;
  }
  if (isRecord(payload) && isRecord(payload.error)) {
    return getPayloadString(payload.error, 'code', 'errorCode', 'error_code');
  }
  return '';
}

function getPayloadErrorMessage(payload: unknown): string {
  const direct = getPayloadString(payload, 'message', 'msg', 'error_description');
  if (direct) {
    return direct;
  }
  if (isRecord(payload)) {
    const error = payload.error;
    if (typeof error === 'string' && error.trim()) {
      return error.trim();
    }
    if (isRecord(error)) {
      return getPayloadString(error, 'message', 'msg', 'description', 'code');
    }
  }
  return '';
}

export function toJunFeiAIUserError(error: unknown): JunFeiAIUserError | null {
  if (error instanceof JunFeiAIUserError) {
    return error;
  }
  if (!(error instanceof JunFeiAIHttpError)) {
    return null;
  }

  const code = error.code || getPayloadString(error.responseBody, 'errorCode', 'error_code', 'code');
  if (code) {
    return new JunFeiAIUserError(code, error.message, error.status);
  }

  if (error.status === 401) {
    return new JunFeiAIUserError('invalid_credentials', error.message, error.status);
  }
  if (error.status === 403) {
    return new JunFeiAIUserError('permission_denied', error.message, error.status);
  }
  return null;
}

export function toJunFeiAIClientError(error: unknown): { status: number; code: string; message: string } | null {
  const userError = toJunFeiAIUserError(error);
  if (!userError) {
    return null;
  }
  const status = typeof userError.status === 'number' && userError.status >= 400 && userError.status < 500
    ? userError.status
    : 400;
  return {
    status,
    code: userError.code,
    message: userError.message || userError.code,
  };
}

function getUserId(user?: Record<string, unknown> | null): string | undefined {
  if (!user) return undefined;
  const raw = user.id ?? user.userId ?? user.uid ?? user.sub;
  if (typeof raw === 'number' || typeof raw === 'string') {
    const id = String(raw).trim();
    return id || undefined;
  }
  return undefined;
}

function getUsername(user?: Record<string, unknown> | null): string | undefined {
  const raw = user?.username ?? user?.displayName ?? user?.name;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function getUserEmail(user?: Record<string, unknown> | null): string | undefined {
  const raw = user?.email;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function getAuthUser(auth?: JunFeiAIAuthPayload | null): Record<string, unknown> | undefined {
  return isRecord(auth?.user) ? auth.user : undefined;
}

function getActivationUser(user?: Record<string, unknown> | null): { id?: string; username?: string; email?: string } {
  const id = getUserId(user);
  const username = getUsername(user);
  const email = getUserEmail(user);
  return {
    ...(id ? { id } : {}),
    ...(username ? { username } : {}),
    ...(email ? { email } : {}),
  };
}

function getDeviceStatus(device?: Record<string, unknown> | null): string {
  const raw = device?.status ?? device?.state;
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function authPayloadIndicatesDeviceActivated(auth: JunFeiAIAuthPayload): boolean {
  const device = isRecord(auth.device) ? auth.device : null;
  if (!device) {
    return auth.auth?.activationRequired === false;
  }
  const status = getDeviceStatus(device);
  return status === 'active'
    || status === 'activated'
    || status === 'enabled'
    || device.activated === true
    || device.active === true;
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

function getLocalProviderBaseUrlOverride(): string {
  if (!isJunFeiAIDevOverrideEnabled()) {
    return '';
  }
  return (
    process.env.CLAWX_JUNFEIAI_PROVIDER_BASE_URL
    || process.env.CLAWX_JUNFEIAI_BASE_URL
    || ''
  ).trim();
}

function applyLocalBootstrapOverrides(bootstrap: JunFeiAIBootstrapPayload): JunFeiAIBootstrapPayload {
  const providerBaseUrl = getLocalProviderBaseUrlOverride();
  if (!providerBaseUrl) {
    return bootstrap;
  }

  return {
    ...bootstrap,
    runtime: {
      ...(bootstrap.runtime ?? {}),
      baseUrl: normalizeBaseUrl(providerBaseUrl),
    },
  };
}

function normalizeProviderProtocol(raw?: string): ProviderProtocol {
  if (
    raw === 'openai-completions'
    || raw === 'openai-responses'
  ) {
    return raw;
  }
  if (raw && (OPENCLAW_API_PROTOCOLS as readonly string[]).includes(raw)) {
    logger.warn(`[junfeiai] Ignoring non-OpenAI api protocol from bootstrap: ${raw}`);
  } else if (raw) {
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
      const message = getPayloadErrorMessage(payload) || `${response.status} ${response.statusText}`;
      throw new JunFeiAIHttpError(message, response.status, getPayloadErrorCode(payload), payload);
    }
    return unwrapEnvelope<T>(payload);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRemoteJunFeiAIBootstrap(): Promise<JunFeiAIBootstrapPayload> {
  return requestJunFeiAI<JunFeiAIBootstrapPayload>('/api/clawx/bootstrap', {
    method: 'GET',
    timeoutMs: 8000,
  });
}

export async function fetchJunFeiAIBootstrap(): Promise<JunFeiAIBootstrapPayload> {
  const bootstrap = applyLocalBootstrapOverrides(await fetchRemoteJunFeiAIBootstrap());
  return (await applyLocalDeviceActivationState(bootstrap)).bootstrap;
}

export async function getJunFeiAIClientConfig(): Promise<JunFeiAIClientConfigPayload> {
  if (!isJunFeiAIManagedDistribution()) {
    return {};
  }
  try {
    return await requestJunFeiAI<JunFeiAIClientConfigPayload>('/api/clawx/client-config', {
      method: 'GET',
      timeoutMs: 8000,
    });
  } catch (error) {
    if (!isMissingJunFeiAICompatRoute(error)) {
      throw error;
    }
    const bootstrap = await fetchRemoteJunFeiAIBootstrap();
    return bootstrap.client ?? {};
  }
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
    const refreshed = await refreshStoredJunFeiAIAuthSession(secret);
    return refreshed?.accessToken ?? null;
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

async function refreshStoredJunFeiAIAuthSession(secret: Extract<Awaited<ReturnType<typeof getProviderSecret>>, { type: 'oauth' }>): Promise<JunFeiAIRefreshPayload | null> {
  const refreshToken = secret.refreshToken?.trim();
  if (!refreshToken) {
    return null;
  }

  const refreshed = normalizeJunFeiAIAuthPayload(
    await requestJunFeiAI<JunFeiAIRefreshPayload>('/api/clawx/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    }),
  );
  if (!refreshed.accessToken) {
    return null;
  }

  await setProviderSecret({
    type: 'oauth',
    accountId: JUNFEIAI_AUTH_ACCOUNT_ID,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken?.trim() || refreshToken,
    expiresAt: Date.now() + Math.max(1, refreshed.expiresIn ?? 24 * 60 * 60) * 1000,
    email: secret.email,
    subject: secret.subject,
    scopes: secret.scopes,
  });

  return refreshed;
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
  const name = deviceId ? `UClaw ${deviceId}` : 'UClaw';
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

function normalizeJunFeiAIModelFamilies(bootstrap: JunFeiAIBootstrapPayload): string[] {
  const raw = Array.isArray(bootstrap.runtime?.modelFamilies) ? bootstrap.runtime.modelFamilies : [];
  return Array.from(new Set(
    raw
      .map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : ''))
      .filter(Boolean),
  ));
}

export async function listJunFeiAIModels(): Promise<{ models: string[] }> {
  try {
    const bootstrap = applyLocalBootstrapOverrides(await fetchRemoteJunFeiAIBootstrap());
    const models = normalizeJunFeiAIModelFamilies(bootstrap);
    return { models: models.length > 0 ? models : [...JUNFEIAI_FALLBACK_MODELS_ON_FETCH_ERROR] };
  } catch (error) {
    logger.warn('[junfeiai] Failed to fetch remote model families, falling back to bundled defaults:', error);
    return {
      models: [...JUNFEIAI_FALLBACK_MODELS_ON_FETCH_ERROR],
    };
  }
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

function relayTokenExpiresAt(relay: JunFeiAIRelayTokenPayload): number | undefined {
  return typeof relay.expiresIn === 'number' && relay.expiresIn > 0
    ? Date.now() + relay.expiresIn * 1000
    : undefined;
}

function normalizeComparableString(value: unknown, { lower = false }: { lower?: boolean } = {}): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return undefined;
  }
  return lower ? normalized.toLowerCase() : normalized;
}

function isRelaySecretExpired(secret: StoredProviderSecret): boolean {
  return Boolean(
    secret?.type === 'api_key'
    && typeof secret.expiresAt === 'number'
    && secret.expiresAt > 0
    && secret.expiresAt < Date.now(),
  );
}

function relaySecretHasOwner(secret: StoredApiKeySecret): boolean {
  return Boolean(secret.ownerUserId || secret.ownerEmail || secret.ownerUsername);
}

function relaySecretMatchesUser(secret: StoredApiKeySecret, user?: Record<string, unknown> | null): boolean {
  const ownerUserId = normalizeComparableString(secret.ownerUserId);
  if (ownerUserId) {
    return ownerUserId === getUserId(user);
  }

  const ownerEmail = normalizeComparableString(secret.ownerEmail, { lower: true });
  if (ownerEmail) {
    return ownerEmail === normalizeComparableString(getUserEmail(user), { lower: true });
  }

  const ownerUsername = normalizeComparableString(secret.ownerUsername, { lower: true });
  if (ownerUsername) {
    return ownerUsername === normalizeComparableString(getUsername(user), { lower: true });
  }

  return false;
}

function isRelaySecretUsableForUser(
  secret: StoredProviderSecret,
  user?: Record<string, unknown> | null,
): secret is StoredApiKeySecret {
  if (secret?.type !== 'api_key' || !secret.apiKey.trim()) {
    return false;
  }
  if (isRelaySecretExpired(secret)) {
    return false;
  }
  if (!relaySecretHasOwner(secret)) {
    return false;
  }
  return relaySecretMatchesUser(secret, user);
}

async function saveJunFeiAIRelaySecret(
  relay: JunFeiAIRelayTokenPayload,
  user?: Record<string, unknown> | null,
): Promise<string | undefined> {
  const token = relay.token?.trim();
  if (!token) {
    return undefined;
  }
  const expiresAt = relayTokenExpiresAt(relay);
  await setProviderSecret({
    type: 'api_key',
    accountId: JUNFEIAI_PROVIDER_ID,
    apiKey: token,
    ...(getUserId(user) ? { ownerUserId: getUserId(user) } : {}),
    ...(getUsername(user) ? { ownerUsername: getUsername(user) } : {}),
    ...(getUserEmail(user) ? { ownerEmail: getUserEmail(user) } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  });
  return token;
}

async function getJunFeiAIAuthStatusWithOptions(options: {
  markDeviceActivatedFromStoredAuth?: boolean;
}): Promise<{
  hasAuthToken: boolean;
  authValid: boolean;
  authRejected?: boolean;
  authError?: string;
  auth?: { user?: Record<string, unknown> };
}> {
  let accessToken: string | null;
  try {
    accessToken = await getStoredJunFeiAIAuthToken();
  } catch (error) {
    return {
      hasAuthToken: true,
      authValid: false,
      authRejected: isJunFeiAIAuthRejection(error),
      authError: error instanceof Error ? error.message : String(error),
    };
  }
  if (!accessToken) {
    return {
      hasAuthToken: false,
      authValid: false,
      authError: 'JunFeiAI is not logged in',
    };
  }

  try {
    let userPayload: Record<string, unknown>;
    try {
      userPayload = await requestJunFeiAI<Record<string, unknown>>('/api/clawx/user/self', {
        method: 'GET',
        accessToken,
        timeoutMs: 8000,
      });
    } catch (error) {
      if (!isMissingJunFeiAICompatRoute(error)) {
        throw error;
      }
      userPayload = await requestJunFeiAI<Record<string, unknown>>('/api/v1/auth/me', {
        method: 'GET',
        accessToken,
        timeoutMs: 8000,
      });
    }
    const user = isRecord(userPayload.user) ? userPayload.user : userPayload;
    if (options.markDeviceActivatedFromStoredAuth === true) {
      await markJunFeiAIDeviceActivated('auth-token', getActivationUser(user));
    }
    return {
      hasAuthToken: true,
      authValid: true,
      auth: { user },
    };
  } catch (error) {
    return {
      hasAuthToken: true,
      authValid: false,
      authRejected: isJunFeiAIAuthRejection(error),
      authError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function ensureJunFeiAIProviderSeeded(options: {
  bootstrap?: JunFeiAIBootstrapPayload;
  relayToken?: string;
  relayTokenExpiresAt?: number;
  gatewayManager?: GatewayManager;
  syncRuntime?: boolean;
  syncRuntimeOnAuthChange?: boolean;
  markDeviceActivatedFromStoredAuth?: boolean;
} = {}): Promise<JunFeiAISeedResult> {
  if (!isJunFeiAIManagedDistribution()) {
    return {
      managed: false,
      account: null,
      bootstrap: fallbackBootstrap(),
      source: 'fallback',
      hasRelayToken: false,
      deviceActivated: false,
    };
  }

  let source: JunFeiAISeedResult['source'] = options.bootstrap ? 'provided' : 'remote';
  let bootstrap = options.bootstrap;
  if (!bootstrap) {
    try {
      bootstrap = await fetchRemoteJunFeiAIBootstrap();
    } catch (error) {
      source = 'fallback';
      bootstrap = fallbackBootstrap();
      logger.warn('[junfeiai] Falling back to bundled bootstrap defaults:', error);
    }
  }
  bootstrap = applyLocalBootstrapOverrides(bootstrap);

  const authStatus = await getJunFeiAIAuthStatusWithOptions({
    markDeviceActivatedFromStoredAuth: options.markDeviceActivatedFromStoredAuth,
  });
  const authUser = authStatus.auth?.user ?? null;
  const authUserId = getUserId(authUser);
  const activation = await applyLocalDeviceActivationState(bootstrap, authUser);
  bootstrap = activation.bootstrap;

  const existing = await getProviderAccount(JUNFEIAI_PROVIDER_ID);
  const account = buildAccount(bootstrap, existing);
  if (accountChanged(existing, account)) {
    await saveProviderAccount(account);
  }

  const defaultProvider = await getDefaultProvider();
  if (defaultProvider !== JUNFEIAI_PROVIDER_ID) {
    await setDefaultProvider(JUNFEIAI_PROVIDER_ID);
  }

  let runtimeApiKey = options.relayToken?.trim() || undefined;
  let relaySecret: StoredProviderSecret = null;
  let relayOwnerUserId: string | undefined;
  let relaySecretChanged = false;
  const authCanReceiveRelay = authStatus.authValid && !activation.activationRequired;

  if (runtimeApiKey) {
    await setProviderSecret({
      type: 'api_key',
      accountId: JUNFEIAI_PROVIDER_ID,
      apiKey: runtimeApiKey,
      ...(authUserId ? { ownerUserId: authUserId } : {}),
      ...(getUsername(authUser) ? { ownerUsername: getUsername(authUser) } : {}),
      ...(getUserEmail(authUser) ? { ownerEmail: getUserEmail(authUser) } : {}),
      ...(options.relayTokenExpiresAt ? { expiresAt: options.relayTokenExpiresAt } : {}),
    });
    relaySecretChanged = true;
    relaySecret = await getProviderSecret(JUNFEIAI_PROVIDER_ID);
    relayOwnerUserId = authUserId;
  } else if (authCanReceiveRelay) {
    relaySecret = await getProviderSecret(JUNFEIAI_PROVIDER_ID);
    relayOwnerUserId = relaySecret?.type === 'api_key' ? relaySecret.ownerUserId : undefined;
    if (!isRelaySecretUsableForUser(relaySecret, authUser)) {
      const accessToken = await getStoredJunFeiAIAuthToken();
      if (accessToken) {
        const relay = await requestRuntimeToken(accessToken);
        runtimeApiKey = await saveJunFeiAIRelaySecret(relay, authUser);
        relaySecretChanged = Boolean(runtimeApiKey);
        relaySecret = await getProviderSecret(JUNFEIAI_PROVIDER_ID);
        relayOwnerUserId = authUserId;
      }
    }
  }

  const hasRelayToken = authCanReceiveRelay && (
    Boolean(runtimeApiKey)
    || isRelaySecretUsableForUser(relaySecret, authUser)
  );
  const relayOwnerMismatch = Boolean(
    relaySecret?.type === 'api_key'
    && relaySecretHasOwner(relaySecret)
    && authUser
    && !relaySecretMatchesUser(relaySecret, authUser),
  );
  const relayExpired = isRelaySecretExpired(relaySecret);
  const shouldClearRuntimeKey = !authStatus.hasAuthToken
    || authStatus.authRejected
    || activation.activationRequired
    || relayOwnerMismatch
    || relayExpired;

  if (shouldClearRuntimeKey) {
    await deleteProviderSecret(JUNFEIAI_PROVIDER_ID);
    relayOwnerUserId = undefined;
    if (authStatus.authRejected) {
      await deleteProviderSecret(JUNFEIAI_AUTH_ACCOUNT_ID);
      await clearVerificationCache();
    }
    runtimeApiKey = undefined;
  }

  const shouldSyncRuntime = options.syncRuntime !== false
    || (
      options.syncRuntimeOnAuthChange === true
      && (relaySecretChanged || shouldClearRuntimeKey)
    );

  if (shouldSyncRuntime) {
    const apiKey = runtimeApiKey ?? (shouldClearRuntimeKey ? '' : undefined);
    await syncSavedProviderToRuntime(providerAccountToConfig(account), apiKey, options.gatewayManager);
    if (options.syncRuntime !== false && !shouldClearRuntimeKey) {
      await syncDefaultProviderToRuntime(JUNFEIAI_PROVIDER_ID, options.gatewayManager);
    }
  }

  return {
    managed: true,
    account,
    bootstrap,
    source,
    hasRelayToken,
    deviceActivated: activation.deviceActivated,
    activationRequired: activation.activationRequired,
    relayOwnerUserId,
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
  const authUser = getAuthUser(auth);
  if (authPayloadIndicatesDeviceActivated(auth) || relay.token?.trim()) {
    await markJunFeiAIDeviceActivated('login', getActivationUser(authUser));
  }
  const seed = await ensureJunFeiAIProviderSeeded({
    bootstrap: auth,
    relayToken: relay.token,
    relayTokenExpiresAt: relayTokenExpiresAt(relay),
    gatewayManager,
    markDeviceActivatedFromStoredAuth: false,
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
  const authUser = getAuthUser(auth);
  await markJunFeiAIDeviceActivated('register', getActivationUser(authUser));
  const relay = auth.accessToken ? await requestRuntimeToken(auth.accessToken, auth.device ?? device) : {};
  const seed = await ensureJunFeiAIProviderSeeded({
    bootstrap: auth,
    relayToken: relay.token,
    relayTokenExpiresAt: relayTokenExpiresAt(relay),
    gatewayManager,
    markDeviceActivatedFromStoredAuth: false,
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

function normalizeTopupPaymentStatus(status: unknown): 'pending' | 'success' | 'failed' | 'cancelled' | 'expired' {
  const normalized = String(status ?? '').trim().toUpperCase();
  if (normalized === 'SUCCESS' || normalized === 'COMPLETED') {
    return 'success';
  }
  if (normalized === 'CANCELLED' || normalized === 'CANCELED') {
    return 'cancelled';
  }
  if (normalized === 'EXPIRED') {
    return 'expired';
  }
  if (
    normalized === 'FAILED'
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
  try {
    return await requestJunFeiAI<Record<string, unknown>>('/api/clawx/billing/checkout-info', {
      method: 'GET',
      accessToken,
    });
  } catch (error) {
    normalizeTopupAuthError(error);
  }
}

export async function getJunFeiAITopupOrders(
  payload: JunFeiAITopupOrdersPayload = {},
): Promise<Record<string, unknown>> {
  const accessToken = await requireStoredJunFeiAIAuthToken();
  const page = Math.max(1, Math.floor(getFiniteNumber(payload.page, 1)));
  const pageSize = Math.min(100, Math.max(1, Math.floor(getFiniteNumber(payload.pageSize, 20))));
  try {
    return await requestJunFeiAI<Record<string, unknown>>(
      `/api/clawx/billing/orders/history?p=${encodeURIComponent(String(page))}&page_size=${encodeURIComponent(String(pageSize))}`,
      {
        method: 'GET',
        accessToken,
      },
    );
  } catch (error) {
    normalizeTopupAuthError(error);
  }
}

export async function createJunFeiAITopupOrder(payload: JunFeiAITopupOrderPayload): Promise<unknown> {
  const accessToken = await requireStoredJunFeiAIAuthToken();
  const moneyText = parseTopupMoney(payload.money);
  const money = Number(moneyText);
  const epayMethod = parseRequiredString(payload.epayMethod, 'epayMethod');
  let overview: Record<string, unknown>;
  try {
    overview = await requestJunFeiAI<Record<string, unknown>>('/api/clawx/billing/checkout-info', {
      method: 'GET',
      accessToken,
    });
  } catch (error) {
    normalizeTopupAuthError(error);
  }
  const topupInfo = isRecord(overview.topupInfo) ? overview.topupInfo : {};
  const quotaPerUnit = normalizePositiveNumber(overview.quotaPerUnit, 1);
  const rechargeMultiplier = normalizePositiveNumber(topupInfo.payg_credit_usd_per_cny, 1) * quotaPerUnit;

  let result: Record<string, unknown>;
  try {
    result = await requestJunFeiAI<Record<string, unknown>>('/api/clawx/billing/orders', {
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
    result = await requestJunFeiAI<Record<string, unknown>>('/api/clawx/billing/orders/verify', {
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

export async function logoutJunFeiAI(gatewayManager?: GatewayManager): Promise<void> {
  const secret = await getProviderSecret(JUNFEIAI_AUTH_ACCOUNT_ID);
  if (secret?.type === 'oauth' && secret.refreshToken?.trim()) {
    try {
      await requestJunFeiAI('/api/clawx/auth/logout', {
        method: 'POST',
        body: JSON.stringify({
          refresh_token: secret.refreshToken.trim(),
        }),
      });
    } catch (error) {
      logger.warn('[junfeiai] Failed to revoke refresh token during logout:', error);
    }
  }
  await deleteProviderSecret(JUNFEIAI_AUTH_ACCOUNT_ID);
  await deleteProviderSecret(JUNFEIAI_PROVIDER_ID);
  await removeProviderKeyFromOpenClaw(JUNFEIAI_PROVIDER_ID);
  await clearVerificationCache();
  await gatewayManager?.stop();
}
