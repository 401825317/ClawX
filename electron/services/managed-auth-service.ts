import type { GatewayManager } from '../gateway/manager';
import type { ProviderAccount, ProviderSecret } from '../shared/providers/types';
import type {
  ManagedAuthActivationCheckResult,
  ManagedAuthBootstrap,
  ManagedAuthLoginPayload,
  ManagedAuthRefreshPayload,
  ManagedAuthRegisterPayload,
  ManagedAuthResult,
  ManagedAuthStatus,
  ManagedAuthUser,
  ManagedAuthVerificationCodePayload,
  ManagedAuthVerificationCodeResult,
  ManagedAuthVerifyPayload,
} from '../../shared/managed-auth';
import {
  UCLAW_ACCOUNT_ID,
  UCLAW_AUTH_REQUEST_TIMEOUT_MS,
  UCLAW_AUTH_ACCOUNT_ID,
  UCLAW_BOOTSTRAP_REQUEST_TIMEOUT_MS,
  UCLAW_DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS,
  UCLAW_DEFAULT_API_PROTOCOL,
  UCLAW_DEFAULT_BASE_URL,
  UCLAW_DEFAULT_MODEL,
  UCLAW_DEFAULT_MODEL_CONTEXT_WINDOW,
  UCLAW_DEFAULT_THINKING_LEVEL,
  UCLAW_MANAGED_SERVICE_NAME,
  UCLAW_OFFLINE_GRACE_SECONDS,
  UCLAW_PROVIDER_ID,
  UCLAW_RELAY_REQUEST_TIMEOUT_MS,
  UCLAW_RUNTIME_CONTRACT_VERSION,
  UCLAW_TOKEN_REFRESH_SKEW_SECONDS,
  UCLAW_VERIFICATION_REQUEST_TIMEOUT_MS,
  UCLAW_VERIFY_MEMORY_CACHE_SECONDS,
  getUclawBackendOrigin,
  isUclawManagedDistribution,
} from '../utils/junfeiai-distribution';
import {
  getManagedDevicePayload,
  markManagedDeviceActivated,
  readManagedDeviceActivationState,
  type ManagedDevicePayload,
} from '../utils/junfeiai-device';
import { proxyAwareFetch } from '../utils/proxy-fetch';
import {
  deleteProviderSecret,
  getProviderSecret,
  setProviderSecret,
} from './secrets/secret-store';
import {
  deleteProviderAccount,
  getDefaultProviderAccountId,
  getProviderAccount,
  providerAccountToConfig,
  saveProviderAccount,
  setDefaultProviderAccount,
} from './providers/provider-store';
import { getProviderService } from './providers/provider-service';
import { ensureProviderStoreMigrated } from './providers/provider-migration';
import {
  syncDefaultProviderToRuntime,
  syncSavedProviderToRuntime,
} from './providers/provider-runtime-sync';
import {
  removeProviderFromOpenClaw,
  removeProviderKeyFromOpenClaw,
  updateAgentModelProvider,
} from '../utils/openclaw-auth';
import { readOpenClawConfig, writeOpenClawConfig } from '../utils/channel-config';
import { withConfigLock } from '../utils/config-mutex';
import { getDefaultProvider, setDefaultProvider } from '../utils/secure-storage';
import { getClawXProviderStore } from './providers/store-instance';
import { logger } from '../utils/logger';

type JsonRecord = Record<string, unknown>;
type AuthSecret = Extract<ProviderSecret, { type: 'oauth' }>;
type RelaySecret = Extract<ProviderSecret, { type: 'api_key' }>;

type AuthPayload = JsonRecord & {
  accessToken?: string;
  access_token?: string;
  refreshToken?: string;
  refresh_token?: string;
  expiresIn?: number;
  expires_in?: number;
  expiresAt?: number;
  expires_at?: number;
  tokenType?: string;
  token_type?: string;
  user?: JsonRecord;
  device?: JsonRecord;
  runtime?: JsonRecord;
  auth?: JsonRecord;
};

type RelayPayload = JsonRecord & {
  token?: string;
  apiKey?: string;
  key?: string;
  expiresIn?: number;
  expires_in?: number;
  expiresAt?: number;
  expires_at?: number;
};

type VerificationCache = {
  verifiedAt: number;
  verifyAfter: number;
  expiresAt: number;
  user?: ManagedAuthUser;
};

type AuthErrorShape = {
  code: string;
  message: string;
  httpStatus?: number;
};

export class ManagedAuthServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ManagedAuthServiceError';
  }
}

class ManagedAuthHttpError extends ManagedAuthServiceError {
  constructor(
    message: string,
    status: number,
    code?: string,
  ) {
    super(code || (status === 401 ? 'invalid_credentials' : 'request_failed'), message, status);
    this.name = 'ManagedAuthHttpError';
  }
}

const LEGACY_AUTH_ACCOUNT_IDS = ['lingzhiwuxian-auth'] as const;
const LEGACY_PROVIDER_ACCOUNT_IDS = ['lingzhiwuxian'] as const;
const AUTH_ROUTE = '/api/clawx';
const FALLBACK_AUTH_ROUTE = '/api/v1/auth';

let refreshInFlight: Promise<AuthSecret | null> | null = null;
let mutationInFlight: Promise<unknown> | null = null;
type StatusFlight = {
  force: boolean;
  gatewayManager?: GatewayManager;
  promise: Promise<ManagedAuthStatus>;
};

type ActivationTicket = {
  ticket: string;
  deviceId: string;
  expiresAt: number;
};

let statusInFlight: StatusFlight | null = null;
const activationTickets = new Map<string, ActivationTicket>();

const SENSITIVE_ERROR_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'relaytoken',
  'apikey',
  'activationticket',
  'activationcode',
  'verifycode',
  'turnstiletoken',
  'password',
  'secret',
]);

const UCLAW_RESPONSES_REASONING_COMPAT = {
  supportsPromptCacheKey: true,
  supportsReasoningEffort: true,
  supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
} as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function pickString(record: JsonRecord | null | undefined, ...keys: string[]): string {
  if (!record) return '';
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return '';
}

function pickNumber(record: JsonRecord | null | undefined, ...keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const raw = record[key];
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function normalizedSensitiveKey(key: string): string {
  return key.replace(/[_-]/g, '').toLowerCase();
}

function redactStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStructuredValue);
  if (!isRecord(value)) return value;
  const redacted: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = SENSITIVE_ERROR_KEYS.has(normalizedSensitiveKey(key))
      ? '[redacted]'
      : redactStructuredValue(entry);
  }
  return redacted;
}

function redactMessage(value: unknown): string {
  let message = typeof value === 'string' ? value.trim() : '';
  if (!message) return 'Request failed';
  if (message.startsWith('{') || message.startsWith('[')) {
    try {
      message = JSON.stringify(redactStructuredValue(JSON.parse(message)));
    } catch {
      // Non-JSON backend text is handled by the fallback patterns below.
    }
  }
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /["']?(access[_-]?token|refresh[_-]?token|relay[_-]?token|api[_-]?key|activation[_-]?(?:ticket|code)|verify[_-]?code|turnstile[_-]?token|password|secret)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^,;\s}\]]+)/gi,
      '$1=[redacted]',
    )
    .slice(0, 500);
}

function normalizeUclawMessage(value: unknown): string {
  return redactMessage(value)
    .replace(/jun\s*fei\s*ai|junfei(?:ai)?|君飞(?:\s*AI)?/gi, UCLAW_MANAGED_SERVICE_NAME);
}

function payloadErrorCode(payload: unknown): string {
  if (!isRecord(payload)) return '';
  return pickString(payload, 'errorCode', 'error_code', 'code')
    || (isRecord(payload.error) ? pickString(payload.error, 'code', 'errorCode', 'error_code') : '');
}

function payloadErrorMessage(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const direct = pickString(payload, 'message', 'msg', 'error_description');
  if (direct) return normalizeUclawMessage(direct);
  if (typeof payload.error === 'string') return normalizeUclawMessage(payload.error);
  if (isRecord(payload.error)) return normalizeUclawMessage(pickString(payload.error, 'message', 'msg', 'description'));
  return '';
}

function unwrap<T>(payload: unknown): T {
  if (isRecord(payload) && payload.success === false) {
    throw new ManagedAuthHttpError(payloadErrorMessage(payload) || 'Request failed', 400, payloadErrorCode(payload));
  }
  if (isRecord(payload) && 'data' in payload) {
    if (typeof payload.code === 'number' && payload.code !== 0) {
      throw new ManagedAuthHttpError(payloadErrorMessage(payload) || 'Request failed', 400, payloadErrorCode(payload));
    }
    return payload.data as T;
  }
  return payload as T;
}

async function requestJson<T>(
  path: string,
  options: { method?: string; body?: unknown; accessToken?: string; timeoutMs: number } = {
    timeoutMs: UCLAW_AUTH_REQUEST_TIMEOUT_MS,
  },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

  try {
    const response = await proxyAwareFetch(`${getUclawBackendOrigin()}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    }) as unknown as {
      ok: boolean;
      status: number;
      statusText: string;
      json: () => Promise<unknown>;
    };
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ManagedAuthHttpError(
        payloadErrorMessage(payload) || `${response.status} ${response.statusText}`,
        response.status,
        payloadErrorCode(payload),
      );
    }
    return unwrap<T>(payload);
  } catch (error) {
    if (error instanceof ManagedAuthServiceError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ManagedAuthServiceError('timeout', 'Request timed out');
    }
    throw new ManagedAuthServiceError('network_error', 'Unable to reach UClaw');
  } finally {
    clearTimeout(timer);
  }
}

async function requestWithFallback<T>(
  primaryPath: string,
  fallbackPath: string,
  options: { method?: string; body?: unknown; accessToken?: string; timeoutMs: number },
): Promise<T> {
  try {
    return await requestJson<T>(primaryPath, options);
  } catch (error) {
    if (!(error instanceof ManagedAuthHttpError) || error.status !== 404) throw error;
    return requestJson<T>(fallbackPath, options);
  }
}

function defaultBootstrap(): ManagedAuthBootstrap {
  return {
    service: {
      name: 'uclaw',
      displayName: UCLAW_MANAGED_SERVICE_NAME,
      apiOrigin: getUclawBackendOrigin(),
    },
    auth: {
      registrationEnabled: true,
      emailVerifyEnabled: false,
      loginEnabled: true,
      activationRequired: false,
    },
    runtime: {
      providerId: UCLAW_PROVIDER_ID,
      accountId: UCLAW_ACCOUNT_ID,
      baseUrl: UCLAW_DEFAULT_BASE_URL,
      apiProtocol: UCLAW_DEFAULT_API_PROTOCOL,
      defaultModel: UCLAW_DEFAULT_MODEL,
    },
    offline: {
      graceSeconds: UCLAW_OFFLINE_GRACE_SECONDS,
      verifyMemoryCacheSeconds: UCLAW_VERIFY_MEMORY_CACHE_SECONDS,
    },
  };
}

function normalizeBootstrap(input: unknown): ManagedAuthBootstrap {
  const raw = isRecord(input) ? input : {};
  const rawAuth = isRecord(raw.auth) ? raw.auth : {};
  const rawOffline = isRecord(raw.offline) ? raw.offline : {};
  const fallback = defaultBootstrap();
  return {
    service: {
      ...fallback.service,
      name: 'uclaw',
      displayName: UCLAW_MANAGED_SERVICE_NAME,
    },
    auth: {
      ...fallback.auth,
      ...(typeof rawAuth.registrationEnabled === 'boolean' ? { registrationEnabled: rawAuth.registrationEnabled } : {}),
      ...(typeof rawAuth.emailVerifyEnabled === 'boolean' ? { emailVerifyEnabled: rawAuth.emailVerifyEnabled } : {}),
      ...(typeof rawAuth.loginEnabled === 'boolean' ? { loginEnabled: rawAuth.loginEnabled } : {}),
      ...(typeof rawAuth.activationRequired === 'boolean' ? { activationRequired: rawAuth.activationRequired } : {}),
    },
    runtime: {
      ...fallback.runtime,
      baseUrl: UCLAW_DEFAULT_BASE_URL,
      apiProtocol: UCLAW_DEFAULT_API_PROTOCOL,
      defaultModel: UCLAW_DEFAULT_MODEL,
      providerId: UCLAW_PROVIDER_ID,
      accountId: UCLAW_ACCOUNT_ID,
    },
    offline: {
      ...fallback.offline,
      ...(typeof rawOffline.graceSeconds === 'number' && rawOffline.graceSeconds > 0
        ? { graceSeconds: rawOffline.graceSeconds }
        : {}),
      ...(typeof rawOffline.verifyMemoryCacheSeconds === 'number' && rawOffline.verifyMemoryCacheSeconds > 0
        ? { verifyMemoryCacheSeconds: rawOffline.verifyMemoryCacheSeconds }
        : {}),
    },
  };
}

function normalizeUser(value: unknown): ManagedAuthUser | undefined {
  if (!isRecord(value)) return undefined;
  const id = pickString(value, 'id', 'userId', 'user_id', 'uid', 'sub');
  const username = pickString(value, 'username', 'name');
  const displayName = pickString(value, 'displayName', 'display_name');
  const email = pickString(value, 'email');
  if (!id && !username && !displayName && !email) return undefined;
  return {
    ...(id ? { id } : {}),
    ...(username ? { username } : {}),
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
  };
}

function normalizeAuthPayload(value: unknown): AuthPayload {
  const raw = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(raw)) return {};
  return {
    ...raw,
    accessToken: pickString(raw, 'accessToken', 'access_token'),
    refreshToken: pickString(raw, 'refreshToken', 'refresh_token'),
    expiresIn: pickNumber(raw, 'expiresIn', 'expires_in'),
    expiresAt: pickNumber(raw, 'expiresAt', 'expires_at'),
    user: isRecord(raw.user) ? raw.user : undefined,
    device: isRecord(raw.device) ? raw.device : undefined,
  };
}

function authExpiry(payload: AuthPayload): number {
  const absolute = payload.expiresAt;
  if (absolute && absolute > 0) return absolute > 10_000_000_000 ? absolute : absolute * 1000;
  const seconds = payload.expiresIn && payload.expiresIn > 0
    ? payload.expiresIn
    : UCLAW_DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS;
  return Date.now() + seconds * 1000;
}

function relayExpiry(payload: RelayPayload): number | undefined {
  const absolute = pickNumber(payload, 'expiresAt', 'expires_at');
  if (absolute && absolute > 0) return absolute > 10_000_000_000 ? absolute : absolute * 1000;
  const seconds = pickNumber(payload, 'expiresIn', 'expires_in');
  return seconds && seconds > 0 ? Date.now() + seconds * 1000 : undefined;
}

function isExpired(expiresAt: number | undefined, skewSeconds = 0): boolean {
  return typeof expiresAt === 'number'
    && expiresAt > 0
    && expiresAt <= Date.now() + skewSeconds * 1000;
}

async function readAuthSecret(migrate = true): Promise<AuthSecret | null> {
  for (const accountId of [UCLAW_AUTH_ACCOUNT_ID, ...LEGACY_AUTH_ACCOUNT_IDS]) {
    const secret = await getProviderSecret(accountId, { migrate });
    if (secret?.type === 'oauth') return secret;
  }
  return null;
}

async function readRelaySecret(migrate = true): Promise<RelaySecret | null> {
  for (const accountId of [UCLAW_ACCOUNT_ID, ...LEGACY_PROVIDER_ACCOUNT_IDS]) {
    const secret = await getProviderSecret(accountId, { migrate });
    if (secret?.type === 'api_key') return secret;
  }
  return null;
}

function userFromSecret(secret: AuthSecret | null): ManagedAuthUser | undefined {
  if (!secret) return undefined;
  return normalizeUser({
    id: secret.subject,
    email: secret.email,
  });
}

function userId(user: ManagedAuthUser | undefined): string | undefined {
  return user?.id?.trim() || undefined;
}

function normalizedIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function hasUserIdentity(user: ManagedAuthUser | undefined): boolean {
  return Boolean(userId(user) || normalizedIdentity(user?.email) || normalizedIdentity(user?.username));
}

function ownerMatchesUser(
  owner: { userId?: string; email?: string; username?: string },
  user: ManagedAuthUser | undefined,
): boolean {
  const ownerId = owner.userId?.trim() || undefined;
  const currentId = userId(user);
  if (ownerId && currentId) return ownerId === currentId;

  const ownerEmail = normalizedIdentity(owner.email);
  const currentEmail = normalizedIdentity(user?.email);
  if (ownerEmail && currentEmail) return ownerEmail === currentEmail;

  const ownerUsername = normalizedIdentity(owner.username);
  const currentUsername = normalizedIdentity(user?.username);
  if (ownerUsername && currentUsername) return ownerUsername === currentUsername;

  return false;
}

function relayBelongsToUser(secret: RelaySecret | null, user: ManagedAuthUser | undefined): boolean {
  if (!secret || isExpired(secret.expiresAt)) return false;
  return ownerMatchesUser({
    userId: secret.ownerUserId,
    email: secret.ownerEmail,
    username: secret.ownerUsername,
  }, user);
}

async function prepareManagedProviderSlot(): Promise<ProviderAccount | null> {
  await ensureProviderStoreMigrated();
  // Import OpenClaw-only state before the transaction snapshot so rollback can restore it.
  await getProviderService().listAccounts();
  return getProviderAccount(UCLAW_ACCOUNT_ID);
}

async function readVerificationCache(): Promise<VerificationCache | null> {
  const store = await getClawXProviderStore();
  const value = store.get('uclawVerificationCache');
  if (!isRecord(value) || typeof value.verifiedAt !== 'number' || typeof value.expiresAt !== 'number') return null;
  const user = normalizeUser(value.user);
  const verifyAfter = typeof value.verifyAfter === 'number' ? value.verifyAfter : value.verifiedAt;
  return {
    verifiedAt: value.verifiedAt,
    verifyAfter,
    expiresAt: value.expiresAt,
    ...(user ? { user } : {}),
  };
}

async function writeVerificationCache(user: ManagedAuthUser | undefined, bootstrap: ManagedAuthBootstrap): Promise<void> {
  const store = await getClawXProviderStore();
  const verifiedAt = Date.now();
  const verifyAfter = verifiedAt
    + (bootstrap.offline?.verifyMemoryCacheSeconds ?? UCLAW_VERIFY_MEMORY_CACHE_SECONDS) * 1000;
  const expiresAt = verifiedAt + (bootstrap.offline?.graceSeconds ?? UCLAW_OFFLINE_GRACE_SECONDS) * 1000;
  store.set('uclawVerificationCache', {
    verifiedAt,
    verifyAfter,
    expiresAt,
    ...(user ? { user } : {}),
  } satisfies VerificationCache);
}

async function clearVerificationCache(): Promise<void> {
  const store = await getClawXProviderStore();
  store.delete('uclawVerificationCache');
}

async function clearManagedCredentials(): Promise<void> {
  activationTickets.clear();
  refreshInFlight = null;
  const failures: string[] = [];
  const attempt = async (name: string, task: () => Promise<void>): Promise<void> => {
    try {
      await task();
    } catch {
      failures.push(name);
    }
  };

  await attempt('auth-secret', () => deleteProviderSecret(UCLAW_AUTH_ACCOUNT_ID));
  await attempt('relay-secret', () => deleteProviderSecret(UCLAW_ACCOUNT_ID));
  for (const id of [...LEGACY_AUTH_ACCOUNT_IDS, ...LEGACY_PROVIDER_ACCOUNT_IDS]) {
    await attempt(`legacy-secret:${id}`, () => deleteProviderSecret(id));
  }
  for (const id of LEGACY_PROVIDER_ACCOUNT_IDS) {
    await attempt(`legacy-runtime-key:${id}`, () => removeProviderKeyFromOpenClaw(id));
  }
  await attempt('runtime-key', () => removeProviderKeyFromOpenClaw(UCLAW_PROVIDER_ID));
  await attempt('verification-cache', clearVerificationCache);
  if (failures.length > 0) {
    logger.warn('[uclaw-auth] Managed session cleanup was incomplete', { failedSteps: failures });
    throw new ManagedAuthServiceError('session_cleanup_failed', 'UClaw could not clear the local session');
  }
}

async function stopGatewayForAuthSafety(
  gatewayManager: GatewayManager | undefined,
  reason: string,
): Promise<void> {
  if (!gatewayManager || gatewayManager.getStatus().state === 'stopped') return;
  try {
    await gatewayManager.stop();
  } catch {
    logger.error(`[uclaw-auth] Failed to stop Gateway after ${reason}`);
  }
}

async function invalidateManagedSession(
  gatewayManager?: GatewayManager,
): Promise<Pick<ManagedAuthStatus, 'gatewayReloaded' | 'gatewayReloadError'>> {
  let cleanupError: unknown;
  try {
    await clearManagedCredentials();
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) {
    // A running Gateway may still hold the credential that failed to clear.
    await stopGatewayForAuthSafety(gatewayManager, 'managed session cleanup failure');
    throw cleanupError;
  }
  const gateway = await applyGatewayReload(gatewayManager);
  if (gateway.gatewayReloadError) {
    throw new ManagedAuthServiceError('gateway_reload_failed', gateway.gatewayReloadError);
  }
  return gateway;
}

function activationMatchesUser(
  activation: Awaited<ReturnType<typeof readManagedDeviceActivationState>>,
  user: ManagedAuthUser | undefined,
): boolean {
  if (!activation?.activated || !activation.onboardingCompleted) return false;
  return ownerMatchesUser({
    userId: activation.userId,
    email: activation.email,
    username: activation.username,
  }, user);
}

function statusFromLocal(
  bootstrap: ManagedAuthBootstrap,
  authSecret: AuthSecret | null,
  relaySecret: RelaySecret | null,
  activation: Awaited<ReturnType<typeof readManagedDeviceActivationState>>,
  cache: VerificationCache | null,
): ManagedAuthStatus {
  const user = userFromSecret(authSecret) ?? cache?.user;
  const hasAuthToken = Boolean(authSecret?.accessToken?.trim());
  const hasRefreshToken = Boolean(authSecret?.refreshToken?.trim());
  const hasRelayToken = relayBelongsToUser(relaySecret, user);
  const deviceActivated = activationMatchesUser(activation, user);
  const accessTokenValid = hasAuthToken && !isExpired(authSecret?.expiresAt);
  const offlineSessionValid = hasAuthToken
    && hasRefreshToken
    && Boolean(cache && cache.expiresAt > Date.now());
  const authValid = accessTokenValid || offlineSessionValid;
  const activationRequired = Boolean(bootstrap.auth?.activationRequired) && !deviceActivated;
  return {
    managed: true,
    localOnly: true,
    hasAuthToken,
    hasRefreshToken,
    hasRelayToken,
    authValid,
    deviceActivated,
    activationRequired,
    ...(user ? { user, auth: { user } } : {}),
    ...(deviceActivated && activation
      ? { device: { id: activation.deviceId, status: 'active' as const, activated: true } }
      : {}),
    bootstrap,
    ...(cache ? { lastVerifiedAt: cache.verifiedAt, offlineGraceExpiresAt: cache.expiresAt } : {}),
  };
}

async function localStatus(bootstrap = defaultBootstrap()): Promise<ManagedAuthStatus> {
  if (!isUclawManagedDistribution()) {
    return {
      managed: false,
      hasAuthToken: false,
      hasRefreshToken: false,
      hasRelayToken: false,
      authValid: true,
      deviceActivated: false,
      activationRequired: false,
      bootstrap,
    };
  }
  const [authSecret, relaySecret, activation, cache] = await Promise.all([
    readAuthSecret(false),
    readRelaySecret(false),
    readManagedDeviceActivationState(),
    readVerificationCache(),
  ]);
  return statusFromLocal(bootstrap, authSecret, relaySecret, activation, cache);
}

async function fetchBootstrap(): Promise<ManagedAuthBootstrap> {
  try {
    const payload = await requestJson<unknown>(`${AUTH_ROUTE}/bootstrap`, {
      timeoutMs: UCLAW_BOOTSTRAP_REQUEST_TIMEOUT_MS,
    });
    return normalizeBootstrap(payload);
  } catch (error) {
    logger.debug('[uclaw-auth] Bootstrap unavailable; using local defaults', {
      code: error instanceof ManagedAuthServiceError ? error.code : 'unknown',
    });
    return defaultBootstrap();
  }
}

async function refreshAuthSecret(secret: AuthSecret): Promise<AuthSecret | null> {
  const refreshToken = secret.refreshToken.trim();
  if (!refreshToken) return null;
  const payload = normalizeAuthPayload(await requestWithFallback<unknown>(
    `${AUTH_ROUTE}/auth/refresh`,
    `${FALLBACK_AUTH_ROUTE}/refresh`,
    { method: 'POST', body: { refresh_token: refreshToken }, timeoutMs: UCLAW_AUTH_REQUEST_TIMEOUT_MS },
  ));
  const accessToken = payload.accessToken?.trim();
  if (!accessToken) throw new ManagedAuthServiceError('auth_invalid', 'UClaw did not return a usable session');
  const next: AuthSecret = {
    type: 'oauth',
    accountId: UCLAW_AUTH_ACCOUNT_ID,
    accessToken,
    refreshToken: payload.refreshToken?.trim() || refreshToken,
    expiresAt: authExpiry(payload),
    email: secret.email,
    subject: secret.subject,
    scopes: secret.scopes,
  };
  await setProviderSecret(next);
  if (secret.accountId !== UCLAW_AUTH_ACCOUNT_ID) await deleteProviderSecret(secret.accountId);
  return next;
}

async function getAccessToken(refresh = true): Promise<{ secret: AuthSecret; token: string } | null> {
  let secret = await readAuthSecret();
  if (!secret) return null;
  if (isExpired(secret.expiresAt, UCLAW_TOKEN_REFRESH_SKEW_SECONDS) && refresh) {
    if (!refreshInFlight) {
      refreshInFlight = refreshAuthSecret(secret).finally(() => {
        refreshInFlight = null;
      });
    }
    const refreshed = await refreshInFlight;
    secret = refreshed;
  }
  if (!secret?.accessToken?.trim()) return null;
  return { secret, token: secret.accessToken.trim() };
}

function extractRelay(payload: unknown): { token: string; expiresAt?: number } {
  const raw = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  const record = isRecord(raw) ? raw : {};
  const token = pickString(record, 'token', 'apiKey', 'key', 'api_key');
  if (!token) throw new ManagedAuthServiceError('relay_missing', 'UClaw did not return a usable runtime credential');
  return { token, expiresAt: relayExpiry(record) };
}

async function requestRelayToken(accessToken: string, device: ManagedDevicePayload): Promise<{ token: string; expiresAt?: number }> {
  try {
    return extractRelay(await requestJson<unknown>(`${AUTH_ROUTE}/relay-token`, {
      method: 'POST',
      body: { device },
      accessToken,
      timeoutMs: UCLAW_RELAY_REQUEST_TIMEOUT_MS,
    }));
  } catch (error) {
    if (!(error instanceof ManagedAuthHttpError) || error.status !== 404) throw error;
    const keyPayload = await requestJson<unknown>(`${FALLBACK_AUTH_ROUTE.replace('/auth', '')}/keys`, {
      method: 'POST',
      body: { name: `UClaw ${device.id}` },
      accessToken,
      timeoutMs: UCLAW_RELAY_REQUEST_TIMEOUT_MS,
    });
    return extractRelay(keyPayload);
  }
}

function activationTicketFor(code: string, deviceId: string): string | undefined {
  const ticket = activationTickets.get(code);
  if (!ticket || ticket.expiresAt <= Date.now() || ticket.deviceId !== deviceId) {
    activationTickets.delete(code);
    return undefined;
  }
  return ticket.ticket;
}

async function checkActivationInternal(
  code: string,
  device: ManagedDevicePayload,
): Promise<ManagedAuthActivationCheckResult> {
  const payload = await requestJson<unknown>(`${AUTH_ROUTE}/activation/check`, {
    method: 'POST',
    body: { code, device },
    timeoutMs: UCLAW_VERIFICATION_REQUEST_TIMEOUT_MS,
  });
  const raw = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  const record = isRecord(raw) ? raw : {};
  const valid = record.valid === true;
  const ticket = pickString(record, 'activationTicket', 'activation_ticket', 'ticket');
  if (valid && ticket) {
    activationTickets.set(code, {
      ticket,
      deviceId: device.id,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
  } else {
    activationTickets.delete(code);
  }
  return { valid, ...(payloadErrorCode(record) ? { errorCode: payloadErrorCode(record) } : {}) };
}

function buildAuthBody(payload: ManagedAuthLoginPayload | ManagedAuthRegisterPayload, device: ManagedDevicePayload): JsonRecord {
  const code = payload.activationCode?.trim();
  const ticket = code ? activationTicketFor(code, device.id) : undefined;
  return {
    email: payload.account.trim(),
    account: payload.account.trim(),
    username: ('username' in payload ? payload.username?.trim() : undefined) || payload.account.trim(),
    password: payload.password,
    verifyCode: payload.verifyCode?.trim() || undefined,
    verify_code: payload.verifyCode?.trim() || undefined,
    activationCode: code || undefined,
    activation_code: code || undefined,
    activationTicket: ticket,
    activation_ticket: ticket,
    turnstileToken: payload.turnstileToken?.trim() || undefined,
    turnstile_token: payload.turnstileToken?.trim() || undefined,
    device,
  };
}

function authUserFromPayload(payload: AuthPayload): ManagedAuthUser | undefined {
  return normalizeUser(payload.user);
}

async function requestAuth(
  kind: 'login' | 'register',
  payload: ManagedAuthLoginPayload | ManagedAuthRegisterPayload,
  device: ManagedDevicePayload,
): Promise<AuthPayload> {
  const body = buildAuthBody(payload, device);
  const primary = `${AUTH_ROUTE}/${kind}`;
  const fallback = `${FALLBACK_AUTH_ROUTE}/${kind}`;
  return normalizeAuthPayload(await requestWithFallback<unknown>(primary, fallback, {
    method: 'POST',
    body,
    timeoutMs: UCLAW_AUTH_REQUEST_TIMEOUT_MS,
  }));
}

type ManagedRuntimeSnapshot = {
  hasThinkingDefault: boolean;
  thinkingDefault?: unknown;
  hasReasoningDefault: boolean;
  reasoningDefault?: unknown;
  hasModelEntry: boolean;
  modelEntry?: JsonRecord;
};

function cloneRecord(value: JsonRecord): JsonRecord {
  return structuredClone(value);
}

function copiedRecord(value: unknown): JsonRecord {
  return isRecord(value) ? { ...value } : {};
}

async function readManagedRuntimeSnapshot(): Promise<ManagedRuntimeSnapshot> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig();
    const agents = copiedRecord(config.agents);
    const defaults = copiedRecord(agents.defaults);
    const models = copiedRecord(config.models);
    const providers = copiedRecord(models.providers);
    const provider = copiedRecord(providers[UCLAW_PROVIDER_ID]);
    const modelEntry = Array.isArray(provider.models)
      ? provider.models.find((entry) => isRecord(entry) && entry.id === UCLAW_DEFAULT_MODEL)
      : undefined;
    return {
      hasThinkingDefault: Object.hasOwn(defaults, 'thinkingDefault'),
      thinkingDefault: defaults.thinkingDefault,
      hasReasoningDefault: Object.hasOwn(defaults, 'reasoningDefault'),
      reasoningDefault: defaults.reasoningDefault,
      hasModelEntry: isRecord(modelEntry),
      ...(isRecord(modelEntry) ? { modelEntry: cloneRecord(modelEntry) } : {}),
    };
  });
}

function managedRuntimeModelEntry(existing?: JsonRecord): JsonRecord {
  const compat = isRecord(existing?.compat) ? { ...existing.compat } : {};
  delete compat.thinkingFormat;
  return {
    ...(existing ?? {}),
    id: UCLAW_DEFAULT_MODEL,
    name: UCLAW_DEFAULT_MODEL,
    contextWindow: UCLAW_DEFAULT_MODEL_CONTEXT_WINDOW,
    reasoning: true,
    compat: {
      ...compat,
      ...UCLAW_RESPONSES_REASONING_COMPAT,
    },
  };
}

async function syncManagedRuntimeDefaults(): Promise<void> {
  const modelEntry = await withConfigLock(async () => {
    const config = await readOpenClawConfig();
    const agents = copiedRecord(config.agents);
    const defaults = copiedRecord(agents.defaults);
    defaults.thinkingDefault = UCLAW_DEFAULT_THINKING_LEVEL;
    defaults.reasoningDefault = 'on';
    agents.defaults = defaults;
    config.agents = agents;

    const models = copiedRecord(config.models);
    const providers = copiedRecord(models.providers);
    const provider = isRecord(providers[UCLAW_PROVIDER_ID])
      ? copiedRecord(providers[UCLAW_PROVIDER_ID])
      : { baseUrl: UCLAW_DEFAULT_BASE_URL, api: UCLAW_DEFAULT_API_PROTOCOL };
    const currentModels = Array.isArray(provider.models)
      ? provider.models.filter(isRecord).map(cloneRecord)
      : [];
    const existingIndex = currentModels.findIndex((entry) => entry.id === UCLAW_DEFAULT_MODEL);
    const nextEntry = managedRuntimeModelEntry(existingIndex >= 0 ? currentModels[existingIndex] : undefined);
    if (existingIndex >= 0) currentModels[existingIndex] = nextEntry;
    else currentModels.push(nextEntry);
    provider.baseUrl = UCLAW_DEFAULT_BASE_URL;
    provider.api = UCLAW_DEFAULT_API_PROTOCOL;
    provider.models = currentModels;
    providers[UCLAW_PROVIDER_ID] = provider;
    models.providers = providers;
    config.models = models;
    await writeOpenClawConfig(config);
    return nextEntry;
  });

  await updateAgentModelProvider(UCLAW_PROVIDER_ID, {
    baseUrl: UCLAW_DEFAULT_BASE_URL,
    api: UCLAW_DEFAULT_API_PROTOCOL,
    models: [modelEntry as { id: string; name: string; [key: string]: unknown }],
  });
}

async function restoreManagedRuntimeSnapshot(snapshot: ManagedRuntimeSnapshot): Promise<void> {
  await withConfigLock(async () => {
    const config = await readOpenClawConfig();
    const agents = copiedRecord(config.agents);
    const defaults = copiedRecord(agents.defaults);
    if (snapshot.hasThinkingDefault) defaults.thinkingDefault = snapshot.thinkingDefault;
    else delete defaults.thinkingDefault;
    if (snapshot.hasReasoningDefault) defaults.reasoningDefault = snapshot.reasoningDefault;
    else delete defaults.reasoningDefault;
    agents.defaults = defaults;
    config.agents = agents;

    const models = copiedRecord(config.models);
    const providers = copiedRecord(models.providers);
    const provider = isRecord(providers[UCLAW_PROVIDER_ID])
      ? copiedRecord(providers[UCLAW_PROVIDER_ID])
      : null;
    if (provider) {
      const providerModels = Array.isArray(provider.models)
        ? provider.models.filter(isRecord).map(cloneRecord)
        : [];
      const index = providerModels.findIndex((entry) => entry.id === UCLAW_DEFAULT_MODEL);
      if (snapshot.hasModelEntry && snapshot.modelEntry) {
        if (index >= 0) providerModels[index] = cloneRecord(snapshot.modelEntry);
        else providerModels.push(cloneRecord(snapshot.modelEntry));
      } else if (index >= 0) {
        providerModels.splice(index, 1);
      }
      provider.models = providerModels;
      providers[UCLAW_PROVIDER_ID] = provider;
      models.providers = providers;
      config.models = models;
    }
    await writeOpenClawConfig(config);
  });

  if (snapshot.hasModelEntry && snapshot.modelEntry) {
    await updateAgentModelProvider(UCLAW_PROVIDER_ID, {
      baseUrl: UCLAW_DEFAULT_BASE_URL,
      api: UCLAW_DEFAULT_API_PROTOCOL,
      models: [snapshot.modelEntry as { id: string; name: string; [key: string]: unknown }],
    });
  }
}

async function snapshot(): Promise<{
  account: ProviderAccount | null;
  auth: ProviderSecret | null;
  relay: ProviderSecret | null;
  defaultAccountId?: string;
  defaultProviderId?: string;
  verificationCache: VerificationCache | null;
  managedRuntime: ManagedRuntimeSnapshot;
}> {
  await ensureProviderStoreMigrated();
  return {
    account: await getProviderAccount(UCLAW_ACCOUNT_ID),
    auth: await getProviderSecret(UCLAW_AUTH_ACCOUNT_ID),
    relay: await getProviderSecret(UCLAW_ACCOUNT_ID),
    defaultAccountId: await getDefaultProviderAccountId(),
    defaultProviderId: await getDefaultProvider(),
    verificationCache: await readVerificationCache(),
    managedRuntime: await readManagedRuntimeSnapshot(),
  };
}

function buildManagedAccount(existing: ProviderAccount | null, user: ManagedAuthUser | undefined): ProviderAccount {
  const now = new Date().toISOString();
  return {
    id: UCLAW_ACCOUNT_ID,
    vendorId: 'openai',
    label: UCLAW_MANAGED_SERVICE_NAME,
    authMode: 'api_key',
    baseUrl: UCLAW_DEFAULT_BASE_URL,
    apiProtocol: UCLAW_DEFAULT_API_PROTOCOL,
    model: UCLAW_DEFAULT_MODEL,
    fallbackModels: [],
    enabled: true,
    isDefault: true,
    metadata: {
      managedBy: 'uclaw',
      managedDefaultModel: UCLAW_DEFAULT_MODEL,
      managedAllowedModels: [UCLAW_DEFAULT_MODEL],
      managedRuntimeContractVersion: UCLAW_RUNTIME_CONTRACT_VERSION,
      ...(user?.email ? { email: user.email } : {}),
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

async function restoreSnapshot(previous: Awaited<ReturnType<typeof snapshot>>): Promise<void> {
  const failures: string[] = [];
  const attempt = async (name: string, task: () => Promise<void>): Promise<void> => {
    try {
      await task();
    } catch {
      failures.push(name);
    }
  };

  await attempt('provider-account', async () => {
    if (previous.account) await saveProviderAccount(previous.account);
    else await deleteProviderAccount(UCLAW_ACCOUNT_ID);
  });
  await attempt('auth-secret', async () => {
    if (previous.auth) await setProviderSecret(previous.auth);
    else await deleteProviderSecret(UCLAW_AUTH_ACCOUNT_ID);
  });
  await attempt('relay-secret', async () => {
    if (previous.relay) await setProviderSecret(previous.relay);
    else await deleteProviderSecret(UCLAW_ACCOUNT_ID);
  });

  let store: Awaited<ReturnType<typeof getClawXProviderStore>> | null = null;
  await attempt('provider-store', async () => {
    store = await getClawXProviderStore();
  });
  await attempt('default-provider', async () => {
    if (previous.defaultProviderId) await setDefaultProvider(previous.defaultProviderId);
    else if (store) store.delete('defaultProvider');
    else throw new Error('Provider store unavailable');
  });
  await attempt('default-account', async () => {
    if (previous.defaultAccountId) await setDefaultProviderAccount(previous.defaultAccountId);
    else if (store) store.delete('defaultProviderAccountId');
    else throw new Error('Provider store unavailable');
  });
  await attempt('verification-cache', async () => {
    if (!store) throw new Error('Provider store unavailable');
    if (previous.verificationCache) store.set('uclawVerificationCache', previous.verificationCache);
    else store.delete('uclawVerificationCache');
  });
  await attempt('runtime-provider', async () => {
    if (previous.account) {
      const relayKey = previous.relay?.type === 'api_key' ? previous.relay.apiKey : '';
      await syncSavedProviderToRuntime(providerAccountToConfig(previous.account), relayKey, undefined);
    } else {
      await removeProviderFromOpenClaw(UCLAW_PROVIDER_ID);
    }
  });
  const previousDefault = previous.defaultProviderId ?? previous.defaultAccountId;
  if (previousDefault) {
    await attempt('runtime-default', () => syncDefaultProviderToRuntime(previousDefault, undefined));
  }
  await attempt('runtime-managed-defaults', () => restoreManagedRuntimeSnapshot(previous.managedRuntime));

  if (failures.length > 0) {
    logger.warn('[uclaw-auth] Provider snapshot rollback was incomplete', { failedSteps: failures });
    throw new ManagedAuthServiceError('rollback_failed', 'UClaw could not restore the previous runtime state');
  }
}

async function applyGatewayReload(gatewayManager: GatewayManager | undefined): Promise<Pick<ManagedAuthStatus, 'gatewayReloaded' | 'gatewayReloadError'>> {
  if (!gatewayManager) {
    return { gatewayReloaded: false };
  }
  const initialState = gatewayManager.getStatus().state;
  if (initialState === 'stopped') return { gatewayReloaded: false };
  if (initialState !== 'running') {
    await stopGatewayForAuthSafety(gatewayManager, 'managed auth reload requested while Gateway was not running');
    return { gatewayReloaded: false, gatewayReloadError: 'Gateway was not ready to reload' };
  }
  try {
    const deadline = Date.now() + 10_000;
    while (true) {
      const status = gatewayManager.getStatus();
      if (status.state !== 'running') return { gatewayReloaded: false };
      const connectedForMs = status.connectedAt
        ? Date.now() - status.connectedAt
        : Number.POSITIVE_INFINITY;
      if (connectedForMs >= 8_000) break;
      const waitMs = Math.min(8_050 - connectedForMs, deadline - Date.now());
      if (waitMs <= 0) {
        await stopGatewayForAuthSafety(gatewayManager, 'unstable managed auth reload window');
        return { gatewayReloaded: false, gatewayReloadError: 'Gateway reload window was not stable' };
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    await gatewayManager.reload();
    if (gatewayManager.getStatus().state !== 'running') {
      await stopGatewayForAuthSafety(gatewayManager, 'managed auth reload returned an unhealthy Gateway');
      return { gatewayReloaded: false, gatewayReloadError: 'Gateway reload did not remain healthy' };
    }
    return { gatewayReloaded: true };
  } catch {
    await stopGatewayForAuthSafety(gatewayManager, 'managed auth reload failure');
    return { gatewayReloaded: false, gatewayReloadError: 'Gateway reload failed' };
  }
}

async function commitAuthenticatedSession(
  auth: AuthPayload,
  relay: { token: string; expiresAt?: number },
  source: 'login' | 'register' | 'auth-token',
  bootstrap: ManagedAuthBootstrap,
  gatewayManager?: GatewayManager,
): Promise<ManagedAuthStatus> {
  const accessToken = auth.accessToken?.trim();
  if (!accessToken) throw new ManagedAuthServiceError('auth_invalid', 'UClaw did not return a usable session');
  if (!relay.token.trim()) throw new ManagedAuthServiceError('relay_missing', 'UClaw did not return a usable runtime credential');
  const existing = await prepareManagedProviderSlot();
  const previous = await snapshot();
  const user = authUserFromPayload(auth) ?? userFromSecret(previous.auth?.type === 'oauth' ? previous.auth : null);
  if (!hasUserIdentity(user)) {
    throw new ManagedAuthServiceError('auth_identity_missing', 'UClaw did not return a usable account identity');
  }

  try {
    // Remove the previous user's runtime credential before committing the new generation.
    await deleteProviderSecret(UCLAW_ACCOUNT_ID);
    await removeProviderKeyFromOpenClaw(UCLAW_PROVIDER_ID);

    const authSecret: AuthSecret = {
      type: 'oauth',
      accountId: UCLAW_AUTH_ACCOUNT_ID,
      accessToken,
      refreshToken: auth.refreshToken?.trim() || (previous.auth?.type === 'oauth' ? previous.auth.refreshToken : ''),
      expiresAt: authExpiry(auth),
      email: user?.email,
      subject: user?.id,
    };
    await setProviderSecret(authSecret);

    const account = buildManagedAccount(existing, user);
    const providerService = getProviderService();
    if (existing) {
      await providerService.updateAccount(UCLAW_ACCOUNT_ID, account, relay.token);
    } else {
      await providerService.createAccount(account, relay.token);
    }
    await setDefaultProvider(UCLAW_ACCOUNT_ID);
    await setProviderSecret({
      type: 'api_key',
      accountId: UCLAW_ACCOUNT_ID,
      apiKey: relay.token,
      ownerUserId: user?.id,
      ownerUsername: user?.username,
      ownerEmail: user?.email,
      expiresAt: relay.expiresAt,
    });

    // Finish all OpenClaw file writes before the single Gateway lifecycle action.
    await syncSavedProviderToRuntime(providerAccountToConfig(account), relay.token, undefined);
    await syncDefaultProviderToRuntime(UCLAW_ACCOUNT_ID, undefined);
    await syncManagedRuntimeDefaults();
    await writeVerificationCache(user, bootstrap);
    await markManagedDeviceActivated(source, user);

    const gateway = await applyGatewayReload(gatewayManager);
    const status = await localStatus(bootstrap);
    return {
      ...status,
      localOnly: false,
      authValid: true,
      ...(user ? { user, auth: { user } } : {}),
      ...gateway,
    };
  } catch (error) {
    await restoreSnapshot(previous);
    throw error;
  }
}

async function withMutation<T>(task: () => Promise<T>): Promise<T> {
  if (mutationInFlight) {
    throw new ManagedAuthServiceError('auth_in_progress', 'Another UClaw authentication request is in progress');
  }
  const blockingStatus = statusInFlight?.promise;
  const current = (async () => {
    if (blockingStatus) await blockingStatus.catch(() => undefined);
    return task();
  })();
  mutationInFlight = current;
  try {
    return await current;
  } finally {
    if (mutationInFlight === current) mutationInFlight = null;
  }
}

function canUseOfflineGrace(error: unknown, status: ManagedAuthStatus): boolean {
  if (!status.hasRefreshToken || !status.hasRelayToken || !status.offlineGraceExpiresAt || status.offlineGraceExpiresAt <= Date.now()) {
    return false;
  }
  if (error instanceof ManagedAuthHttpError) {
    const status = error.status ?? 0;
    return status >= 500 || status === 408;
  }
  return error instanceof ManagedAuthServiceError && ['network_error', 'timeout'].includes(error.code);
}

function errorShape(error: unknown): AuthErrorShape {
  if (error instanceof ManagedAuthServiceError) {
    return { code: error.code, message: redactMessage(error.message), httpStatus: error.status };
  }
  return { code: 'unknown', message: 'UClaw request failed' };
}

export function toManagedAuthError(error: unknown): AuthErrorShape {
  return errorShape(error);
}

function failureResult(error: unknown): ManagedAuthResult {
  const shape = errorShape(error);
  return { success: false, errorCode: shape.code, message: shape.message };
}

export async function getManagedAuthBootstrap(): Promise<ManagedAuthBootstrap> {
  return fetchBootstrap();
}

export async function getManagedAuthLocalStatus(): Promise<ManagedAuthStatus> {
  return localStatus(defaultBootstrap());
}

async function verifyManagedAuthStatusInternal(
  options: ManagedAuthVerifyPayload,
  gatewayManager?: GatewayManager,
): Promise<ManagedAuthStatus> {
  const local = await localStatus(defaultBootstrap());
  if (!isUclawManagedDistribution()) return local;
  if (!local.hasAuthToken && !local.hasRefreshToken) {
    // Logged-out clients still need the server-owned registration policy.
    return localStatus(await fetchBootstrap());
  }
  const cache = await readVerificationCache();
  if (
    options.force !== true
    && cache
    && cache.verifyAfter > Date.now()
    && local.authValid
    && local.hasRelayToken
  ) {
    return { ...local, localOnly: false };
  }

  const bootstrap = await fetchBootstrap();
  const currentLocal = await localStatus(bootstrap);

  try {
    const access = await getAccessToken(true);
    if (!access) return currentLocal;
    let verified: unknown;
    try {
      verified = await requestJson<unknown>(`${AUTH_ROUTE}/auth/verify`, {
        method: 'POST',
        body: { device: await getManagedDevicePayload(), force: options.force === true },
        accessToken: access.token,
        timeoutMs: UCLAW_VERIFICATION_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      if (!(error instanceof ManagedAuthHttpError) || error.status !== 404) throw error;
      verified = await requestJson<unknown>(`${FALLBACK_AUTH_ROUTE}/me`, {
        accessToken: access.token,
        timeoutMs: UCLAW_VERIFICATION_REQUEST_TIMEOUT_MS,
      });
    }
    const raw = isRecord(verified) && isRecord(verified.data) ? verified.data : verified;
    const user = normalizeUser(isRecord(raw) && isRecord(raw.user) ? raw.user : raw) ?? userFromSecret(access.secret);
    if (isRecord(raw) && raw.valid === false) {
      throw new ManagedAuthServiceError(payloadErrorCode(raw) || 'auth_invalid', payloadErrorMessage(raw) || 'UClaw session is invalid', 401);
    }
    await writeVerificationCache(user, bootstrap);
    const device = isRecord(raw) && isRecord(raw.device) ? raw.device : null;
    if (device && ['active', 'activated', 'enabled'].includes(pickString(device, 'status', 'state').toLowerCase())) {
      await markManagedDeviceActivated('auth-token', user);
    }
    let status = await localStatus(bootstrap);
    if (!status.hasRelayToken) {
      const relay = await requestRelayToken(access.token, await getManagedDevicePayload());
      status = await commitAuthenticatedSession({
        accessToken: access.token,
        refreshToken: access.secret.refreshToken,
        expiresAt: access.secret.expiresAt,
        user,
      }, relay, 'auth-token', bootstrap, gatewayManager);
    }
    return { ...status, localOnly: false, authValid: true };
  } catch (error) {
    if (canUseOfflineGrace(error, currentLocal)) return currentLocal;
    const shape = errorShape(error);
    const authRejected = shape.httpStatus === 401
      || shape.httpStatus === 403
      || shape.code === 'auth_invalid';
    if (authRejected) {
      let cleanupFailure: AuthErrorShape | null = null;
      try {
        await invalidateManagedSession(gatewayManager);
      } catch (cleanupError) {
        cleanupFailure = errorShape(cleanupError);
      }
      const invalidated = await localStatus(bootstrap);
      return {
        ...invalidated,
        localOnly: false,
        authValid: false,
        authRejected: true,
        authErrorCode: cleanupFailure?.code ?? shape.code,
        authError: cleanupFailure ? 'UClaw could not clear the local session' : 'UClaw authentication was rejected',
      };
    }
    return {
      ...currentLocal,
      authValid: false,
      authRejected: false,
      authErrorCode: shape.code,
      authError: 'UClaw request failed',
    };
  }
}

export async function getManagedAuthStatus(
  options: ManagedAuthVerifyPayload = {},
  gatewayManager?: GatewayManager,
): Promise<ManagedAuthStatus> {
  if (statusInFlight) {
    const canReuseForce = options.force !== true || statusInFlight.force;
    const canReuseGateway = !gatewayManager
      || statusInFlight.gatewayManager === gatewayManager;
    if (canReuseForce && canReuseGateway) return statusInFlight.promise;
    await statusInFlight.promise.catch(() => undefined);
    return getManagedAuthStatus(options, gatewayManager);
  }
  const blockingMutation = mutationInFlight;
  const current = (async () => {
    if (blockingMutation) await blockingMutation.catch(() => undefined);
    return verifyManagedAuthStatusInternal(options, gatewayManager);
  })();
  const flight: StatusFlight = {
    force: options.force === true,
    gatewayManager,
    promise: current,
  };
  statusInFlight = flight;
  try {
    return await current;
  } finally {
    if (statusInFlight === flight) statusInFlight = null;
  }
}

export async function checkManagedAuthActivation(
  code: string,
): Promise<ManagedAuthActivationCheckResult> {
  const normalized = code.trim();
  if (!normalized) throw new ManagedAuthServiceError('activation_invalid', 'Activation code is required');
  try {
    return await checkActivationInternal(normalized, await getManagedDevicePayload());
  } catch (error) {
    return { valid: false, errorCode: errorShape(error).code };
  }
}

export async function sendManagedAuthVerificationCode(
  payload: ManagedAuthVerificationCodePayload,
): Promise<ManagedAuthVerificationCodeResult> {
  const account = payload.account.trim();
  if (!account) throw new ManagedAuthServiceError('missing_credentials', 'Account is required');
  try {
    const response = await requestWithFallback<unknown>(
      `${AUTH_ROUTE}/verification/send-code`,
      `${FALLBACK_AUTH_ROUTE}/send-verify-code`,
      {
        method: 'POST',
        body: {
          account,
          email: account,
          turnstileToken: payload.turnstileToken?.trim() || undefined,
          turnstile_token: payload.turnstileToken?.trim() || undefined,
        },
        timeoutMs: UCLAW_VERIFICATION_REQUEST_TIMEOUT_MS,
      },
    );
    const raw = isRecord(response) && isRecord(response.data) ? response.data : response;
    return {
      success: true,
      ...(isRecord(raw) && typeof raw.message === 'string' ? { message: normalizeUclawMessage(raw.message) } : {}),
      ...(isRecord(raw) && typeof raw.countdown === 'number' ? { countdown: raw.countdown } : {}),
    };
  } catch (error) {
    return { success: false, errorCode: errorShape(error).code };
  }
}

export async function loginManagedAuth(
  payload: ManagedAuthLoginPayload,
  gatewayManager?: GatewayManager,
): Promise<ManagedAuthResult> {
  return withMutation(async () => {
    try {
      const device = await getManagedDevicePayload();
      if (payload.activationCode?.trim() && !activationTicketFor(payload.activationCode.trim(), device.id)) {
        const activation = await checkActivationInternal(payload.activationCode.trim(), device);
        if (!activation.valid) {
          await invalidateManagedSession(gatewayManager);
          return { success: false, errorCode: activation.errorCode || 'activation_invalid' };
        }
      }
      const auth = await requestAuth('login', payload, device);
      if (!auth.accessToken) {
        throw new ManagedAuthServiceError('auth_invalid', 'UClaw did not return a usable session');
      }
      const relay = await requestRelayToken(auth.accessToken, device);
      const status = await commitAuthenticatedSession(auth, relay, 'login', normalizeBootstrap(auth), gatewayManager);
      if (payload.activationCode?.trim()) activationTickets.delete(payload.activationCode.trim());
      return { success: true, status, ...(status.user ? { user: status.user } : {}) };
    } catch (error) {
      await invalidateManagedSession(gatewayManager);
      throw error;
    }
  }).catch(failureResult);
}

export async function registerManagedAuth(
  payload: ManagedAuthRegisterPayload,
  gatewayManager?: GatewayManager,
): Promise<ManagedAuthResult> {
  return withMutation(async () => {
    try {
      const device = await getManagedDevicePayload();
      if (payload.activationCode?.trim() && !activationTicketFor(payload.activationCode.trim(), device.id)) {
        const activation = await checkActivationInternal(payload.activationCode.trim(), device);
        if (!activation.valid) {
          await invalidateManagedSession(gatewayManager);
          return { success: false, errorCode: activation.errorCode || 'activation_invalid' };
        }
      }
      const auth = await requestAuth('register', payload, device);
      if (!auth.accessToken) {
        throw new ManagedAuthServiceError('auth_invalid', 'UClaw did not return a usable session');
      }
      const relay = await requestRelayToken(auth.accessToken, device);
      const status = await commitAuthenticatedSession(auth, relay, 'register', normalizeBootstrap(auth), gatewayManager);
      if (payload.activationCode?.trim()) activationTickets.delete(payload.activationCode.trim());
      return { success: true, status, ...(status.user ? { user: status.user } : {}) };
    } catch (error) {
      await invalidateManagedSession(gatewayManager);
      throw error;
    }
  }).catch(failureResult);
}

export async function refreshManagedAuth(
  options: ManagedAuthRefreshPayload = {},
  gatewayManager?: GatewayManager,
): Promise<ManagedAuthResult> {
  return withMutation(async () => {
    const status = await verifyManagedAuthStatusInternal(
      { force: options.force === true },
      gatewayManager,
    );
    if (!status.authValid) return { success: false, status, errorCode: status.authErrorCode || 'auth_invalid', message: status.authError };
    return { success: true, status };
  }).catch(failureResult);
}

export async function verifyManagedAuth(
  options: ManagedAuthVerifyPayload = {},
  gatewayManager?: GatewayManager,
): Promise<ManagedAuthResult> {
  try {
    const status = await getManagedAuthStatus(options, gatewayManager);
    return status.authValid || !status.managed
      ? { success: true, status }
      : { success: false, status, errorCode: status.authErrorCode || 'auth_invalid', message: status.authError };
  } catch (error) {
    return failureResult(error);
  }
}

export async function logoutManagedAuth(gatewayManager?: GatewayManager): Promise<ManagedAuthResult> {
  return withMutation(async () => {
    const secret = await readAuthSecret();
    if (secret?.refreshToken?.trim()) {
      await requestJson<unknown>(`${AUTH_ROUTE}/auth/logout`, {
        method: 'POST',
        body: { refresh_token: secret.refreshToken.trim() },
        accessToken: secret.accessToken,
        timeoutMs: UCLAW_AUTH_REQUEST_TIMEOUT_MS,
      }).catch(() => undefined);
    }
    let cleanupError: unknown;
    try {
      await clearManagedCredentials();
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      await stopGatewayForAuthSafety(gatewayManager, 'managed session cleanup failure');
      throw cleanupError;
    }
    // Local logout is authoritative; Gateway reload failures are reported as
    // degraded status after the local credentials have already been removed.
    const gateway = await applyGatewayReload(gatewayManager);
    const status = await localStatus(defaultBootstrap());
    return {
      success: true,
      status: { ...status, ...gateway },
    };
  }).catch(failureResult);
}
