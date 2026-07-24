import type { GatewayManager } from '../gateway/manager';
import {
  acquireManagedRuntimeMutationLease as acquireRuntimeMutationLease,
  clearManagedRuntimeMutationMarker,
  markManagedRuntimeMutationStarted,
  quarantineManagedRuntimeMutation,
  releaseManagedRuntimeMutationLease as releaseRuntimeMutationLease,
  type ManagedRuntimeMutationLease,
} from '../gateway/managed-runtime-mutation-barrier';
import { waitForPortFree } from '../gateway/supervisor';
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
  UCLAW_LEGACY_AUTH_ACCOUNT_IDS,
  UCLAW_LEGACY_PROVIDER_IDS,
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
  restoreManagedDeviceActivationFiles,
  snapshotManagedDeviceActivationFiles,
  type ManagedDeviceActivationFileSnapshot,
  type ManagedDeviceActivationFilesApplied,
  type ManagedDeviceActivationFilesSnapshot,
  type ManagedDevicePayload,
} from '../utils/junfeiai-device';
import { proxyAwareFetch } from '../utils/proxy-fetch';
import {
  deleteProviderSecret,
  getProviderSecret,
  installManagedProviderSecrets,
  restoreProviderSecretSlots,
  setProviderSecret,
  snapshotProviderSecretSlots,
  type ProviderSecretSlotsSnapshot,
} from './secrets/secret-store';
import {
  getManagedOpenAiTargetAccountIds,
  getProviderAccount,
  installManagedOpenAiProviderAccount,
  restoreManagedProviderStore,
  snapshotManagedProviderStore,
  type ManagedProviderStoreSnapshot,
} from './providers/provider-store';
import { ensureProviderStoreMigrated } from './providers/provider-migration';
import {
  getManagedRuntimeOpenAiProviderIds,
  removeManagedRuntimeOpenAiState,
  restoreManagedRuntimeConfig,
  snapshotManagedRuntimeConfig,
  updateManagedRuntimeConfig,
  type ManagedRuntimeConfigSnapshot,
} from './providers/managed-runtime-config';
import {
  getManagedAgentOpenAiProviderIds,
  installManagedAgentOpenAiApiKey,
  removeManagedAgentOpenAiCredentialsFromSnapshot,
  removeManagedAgentOpenAiProviders,
  restoreManagedAgentAuthProfiles,
  restoreManagedAgentModelsFiles,
  snapshotManagedAgentAuthProfiles,
  snapshotManagedAgentModelsFiles,
  updateManagedAgentModelProviderStrict,
  type ManagedAgentAuthProfilesSnapshot,
  type ManagedAgentModelsFilesSnapshot,
} from '../utils/openclaw-auth';
import { getClawXProviderStore } from './providers/store-instance';
import { logger } from '../utils/logger';
import {
  isOpenAiProviderIdentity,
  withProviderMutationLock,
} from './providers/provider-mutation-lock';

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
  for (const accountId of [UCLAW_AUTH_ACCOUNT_ID, ...UCLAW_LEGACY_AUTH_ACCOUNT_IDS]) {
    const secret = await getProviderSecret(accountId, { migrate });
    if (secret?.type === 'oauth') return secret;
  }
  return null;
}

async function readRelaySecret(migrate = true): Promise<RelaySecret | null> {
  for (const accountId of [UCLAW_ACCOUNT_ID, ...UCLAW_LEGACY_PROVIDER_IDS]) {
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

function buildVerificationCache(
  user: ManagedAuthUser | undefined,
  bootstrap: ManagedAuthBootstrap,
): VerificationCache {
  const verifiedAt = Date.now();
  const verifyAfter = verifiedAt
    + (bootstrap.offline?.verifyMemoryCacheSeconds ?? UCLAW_VERIFY_MEMORY_CACHE_SECONDS) * 1000;
  const expiresAt = verifiedAt + (bootstrap.offline?.graceSeconds ?? UCLAW_OFFLINE_GRACE_SECONDS) * 1000;
  return {
    verifiedAt,
    verifyAfter,
    expiresAt,
    ...(user ? { user } : {}),
  };
}

async function persistVerificationCache(cache: VerificationCache): Promise<void> {
  const store = await getClawXProviderStore();
  store.set('uclawVerificationCache', cache);
}

async function writeVerificationCache(
  user: ManagedAuthUser | undefined,
  bootstrap: ManagedAuthBootstrap,
): Promise<VerificationCache> {
  const cache = buildVerificationCache(user, bootstrap);
  await persistVerificationCache(cache);
  return cache;
}

function verificationCacheEquals(left: VerificationCache | null, right: VerificationCache | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function clearVerificationCache(): Promise<void> {
  const store = await getClawXProviderStore();
  store.delete('uclawVerificationCache');
}

async function clearManagedCredentials(previous: ManagedAuthSnapshot): Promise<void> {
  activationTickets.clear();
  refreshInFlight = null;
  const managedProviderIds = new Set(previous.managedOpenAiTargetAccountIds);
  const failures: string[] = [];
  const skipped: string[] = [];
  const attempt = async (name: string, task: () => Promise<void>): Promise<boolean> => {
    try {
      await task();
      return true;
    } catch {
      failures.push(name);
      return false;
    }
  };

  await attempt('auth-secret', () => deleteProviderSecret(UCLAW_AUTH_ACCOUNT_ID));
  for (const id of UCLAW_LEGACY_AUTH_ACCOUNT_IDS) {
    await attempt(`legacy-secret:${id}`, () => deleteProviderSecret(id));
  }
  let relaySecretsCleared = true;
  for (const id of managedProviderIds) {
    const cleared = await attempt(`relay-secret:${id}`, () => deleteProviderSecret(id));
    relaySecretsCleared = cleared && relaySecretsCleared;
  }

  // Runtime/model entries are the only reliable discovery anchors for some
  // historical custom ids. Preserve them whenever an earlier cleanup stage
  // fails so a later login/logout can deterministically retry the same ids.
  let agentAuthCleared = false;
  if (relaySecretsCleared) {
    agentAuthCleared = await attempt('agent-auth-profiles', () => (
      removeManagedAgentOpenAiCredentialsFromSnapshot(previous.agentAuthProfiles, managedProviderIds)
    ));
  } else {
    skipped.push('agent-auth-profiles', 'agent-models', 'runtime-state');
  }

  if (relaySecretsCleared && agentAuthCleared) {
    const agentModelsCleared = await attempt('agent-models', () => (
      removeManagedAgentOpenAiProviders(previous.agentModelsFiles, managedProviderIds)
    ));
    if (agentModelsCleared) {
      await attempt('runtime-state', () => (
        removeManagedRuntimeOpenAiState(previous.managedRuntime, managedProviderIds)
      ));
    } else {
      skipped.push('runtime-state');
    }
  } else if (relaySecretsCleared) {
    skipped.push('agent-models', 'runtime-state');
  }
  await attempt('verification-cache', clearVerificationCache);
  if (failures.length > 0) {
    logger.warn('[uclaw-auth] Managed session cleanup was incomplete', {
      failedSteps: failures,
      skippedSteps: skipped,
    });
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

type GatewayQuiescence = {
  gatewayManager?: GatewayManager;
  lease: ManagedRuntimeMutationLease;
  operation: string;
  wasActive: boolean;
  previousPid?: number;
  markerStarted: boolean;
};

function releaseManagedMutationLease(quiescence: GatewayQuiescence): void {
  if (quiescence.gatewayManager) {
    quiescence.gatewayManager.releaseManagedRuntimeMutationLease(quiescence.lease);
    return;
  }
  releaseRuntimeMutationLease(quiescence.lease);
}

async function markManagedMutationStarted(quiescence: GatewayQuiescence): Promise<void> {
  await markManagedRuntimeMutationStarted(quiescence.lease, quiescence.operation);
  quiescence.markerStarted = true;
}

async function quarantineManagedMutation(
  quiescence: GatewayQuiescence,
  reason: string,
): Promise<void> {
  try {
    if (quiescence.markerStarted) {
      await quarantineManagedRuntimeMutation(
        quiescence.lease,
        quiescence.operation,
        reason,
      );
    }
  } catch (error) {
    // The existing in-progress marker still keeps startup fail-closed.
    logger.error('[uclaw-auth] Failed to update managed runtime quarantine marker', error);
  } finally {
    releaseManagedMutationLease(quiescence);
  }
}

/** Reserve runtime ownership, drain any start, and prove the port is free. */
async function quiesceGatewayForManagedMutation(
  operation: string,
  gatewayManager?: GatewayManager,
): Promise<GatewayQuiescence> {
  let lease: ManagedRuntimeMutationLease;
  try {
    lease = gatewayManager
      ? gatewayManager.acquireManagedRuntimeMutationLease()
      : acquireRuntimeMutationLease();
  } catch {
    throw new ManagedAuthServiceError('auth_in_progress', 'Another UClaw runtime update is in progress');
  }

  if (!gatewayManager) {
    return {
      lease,
      operation,
      wasActive: false,
      markerStarted: false,
    };
  }

  const initial = gatewayManager.getStatus();
  const quiescence: GatewayQuiescence = {
    gatewayManager,
    lease,
    operation,
    wasActive: initial.state !== 'stopped',
    previousPid: initial.pid,
    markerStarted: false,
  };

  try {
    await gatewayManager.stop();
    if (gatewayManager.getStatus().state !== 'stopped') {
      throw new Error('Gateway did not enter the stopped state');
    }
    // An externally attached Gateway can report stopped after its shutdown RPC
    // fails, so require the listening socket to disappear before credentials move.
    await waitForPortFree(initial.port, 10_000);
  } catch {
    releaseManagedMutationLease(quiescence);
    throw new ManagedAuthServiceError('gateway_stop_failed', 'UClaw could not stop Gateway before updating credentials');
  }
  return quiescence;
}

/** Restore the prior active state with a provably new credential environment. */
async function resumeGatewayAfterManagedMutation(
  quiescence: GatewayQuiescence,
): Promise<Pick<ManagedAuthStatus, 'gatewayReloaded' | 'gatewayReloadError'>> {
  const { gatewayManager } = quiescence;
  try {
    if (quiescence.markerStarted) {
      await clearManagedRuntimeMutationMarker(quiescence.lease);
      quiescence.markerStarted = false;
    }
  } catch (error) {
    await quarantineManagedMutation(quiescence, 'managed runtime marker cleanup failed');
    logger.error('[uclaw-auth] Failed to clear managed runtime mutation marker', error);
    return {
      gatewayReloaded: false,
      gatewayReloadError: 'Gateway remains blocked until managed credentials are recovered',
    };
  }

  if (!gatewayManager || !quiescence.wasActive) {
    releaseManagedMutationLease(quiescence);
    return { gatewayReloaded: false };
  }

  try {
    await gatewayManager.start(quiescence.lease);
    const started = gatewayManager.getStatus();
    const hasNewProcess = started.pid !== undefined
      && (quiescence.previousPid === undefined || started.pid !== quiescence.previousPid);
    if (started.state !== 'running' || !hasNewProcess) {
      await stopGatewayForAuthSafety(gatewayManager, 'managed credential start returned an unhealthy Gateway');
      return { gatewayReloaded: false, gatewayReloadError: 'Gateway start did not remain healthy' };
    }
    return { gatewayReloaded: true };
  } catch {
    await stopGatewayForAuthSafety(gatewayManager, 'managed credential start failure');
    return { gatewayReloaded: false, gatewayReloadError: 'Gateway start failed' };
  } finally {
    releaseManagedMutationLease(quiescence);
  }
}

async function invalidateManagedSession(
  gatewayManager?: GatewayManager,
): Promise<Pick<ManagedAuthStatus, 'gatewayReloaded' | 'gatewayReloadError'>> {
  const quiescence = await quiesceGatewayForManagedMutation('invalidate-session', gatewayManager);
  let cleanupError: unknown;
  let snapshotCompleted = false;
  try {
    await withProviderMutationLock(async () => {
      // snapshot() may migrate the Provider Store, so persist recovery evidence
      // before it can perform the first credential-related write.
      await markManagedMutationStarted(quiescence);
      const previous = await snapshot();
      snapshotCompleted = true;
      await clearManagedCredentials(previous);
    });
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) {
    // Once the marker exists, snapshot migration or cleanup may have written
    // partially. Without a complete rollback, the runtime must stay isolated.
    if (quiescence.markerStarted) {
      await quarantineManagedMutation(
        quiescence,
        snapshotCompleted
          ? 'managed session cleanup failed'
          : 'managed session snapshot failed',
      );
    } else {
      await resumeGatewayAfterManagedMutation(quiescence);
    }
    throw cleanupError;
  }
  const gateway = await resumeGatewayAfterManagedMutation(quiescence);
  if (gateway.gatewayReloadError) {
    throw new ManagedAuthServiceError('gateway_start_failed', gateway.gatewayReloadError);
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
  return withProviderMutationLock(async () => {
    // The refresh HTTP request may outlive logout or a new login generation.
    const current = await readAuthSecret(false);
    if (
      !current
      || current.accountId !== secret.accountId
      || current.accessToken !== secret.accessToken
      || current.refreshToken !== secret.refreshToken
      || current.expiresAt !== secret.expiresAt
    ) {
      return null;
    }
    await setProviderSecret(next);
    if (secret.accountId !== UCLAW_AUTH_ACCOUNT_ID) await deleteProviderSecret(secret.accountId);
    return next;
  });
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

/** Execute a Main-only UClaw request with the current refreshed access token. */
export async function requestManagedAuthenticatedJson<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  try {
    const access = await getAccessToken(true);
    if (!access) {
      throw new ManagedAuthServiceError('auth_required', 'Sign in to UClaw to continue');
    }

    return await requestJson<T>(path, {
      method: options.method,
      body: options.body,
      accessToken: access.token,
      timeoutMs: options.timeoutMs ?? UCLAW_AUTH_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    if (
      error instanceof ManagedAuthHttpError
      && error.status === 401
    ) {
      throw new ManagedAuthServiceError('auth_expired', 'Your UClaw session has expired', error.status);
    }
    throw error;
  }
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

function copiedRecord(value: unknown): JsonRecord {
  return isRecord(value) ? { ...value } : {};
}

function isManagedOpenAiProviderKey(value: unknown, managedProviderIds: ReadonlySet<string>): boolean {
  return typeof value === 'string'
    && (managedProviderIds.has(value) || isOpenAiProviderIdentity(value));
}

/** Remove stale OpenAI auth metadata while preserving every unrelated Provider route. */
function removeManagedOpenAiAuthMetadata(
  config: JsonRecord,
  managedProviderIds: ReadonlySet<string>,
): void {
  const auth = copiedRecord(config.auth);
  const profiles = copiedRecord(auth.profiles);
  const removedProfileIds = new Set<string>();
  for (const [profileId, profile] of Object.entries(profiles)) {
    const provider = isRecord(profile) ? profile.provider : undefined;
    if (!isManagedOpenAiProviderKey(provider, managedProviderIds)) continue;
    delete profiles[profileId];
    removedProfileIds.add(profileId);
  }

  const order = copiedRecord(auth.order);
  for (const [provider, rawProfileIds] of Object.entries(order)) {
    if (isManagedOpenAiProviderKey(provider, managedProviderIds)) {
      delete order[provider];
      continue;
    }
    if (!Array.isArray(rawProfileIds)) continue;
    const retained = rawProfileIds.filter(
      (profileId): profileId is string => typeof profileId === 'string' && !removedProfileIds.has(profileId),
    );
    if (retained.length > 0) order[provider] = retained;
    else delete order[provider];
  }

  if (Object.keys(profiles).length > 0) auth.profiles = profiles;
  else delete auth.profiles;
  if (Object.keys(order).length > 0) auth.order = order;
  else delete auth.order;
  if (Object.keys(auth).length > 0) config.auth = auth;
  else delete config.auth;
}

function managedRuntimeModelEntry(): JsonRecord {
  return {
    id: UCLAW_DEFAULT_MODEL,
    name: UCLAW_DEFAULT_MODEL,
    contextWindow: UCLAW_DEFAULT_MODEL_CONTEXT_WINDOW,
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { ...UCLAW_RESPONSES_REASONING_COMPAT },
  };
}

async function syncManagedRuntimeDefaults(
  agentModelsFiles: ManagedAgentModelsFilesSnapshot,
  runtimeSnapshot: ManagedRuntimeConfigSnapshot,
  managedProviderIds: ReadonlySet<string>,
): Promise<void> {
  const modelEntry = managedRuntimeModelEntry();
  const providerEntry = {
    baseUrl: UCLAW_DEFAULT_BASE_URL,
    api: UCLAW_DEFAULT_API_PROTOCOL,
    // Canonical OpenAI entries must stay on ClawX's bundled agent runtime.
    agentRuntime: { id: 'pi' },
    models: [modelEntry as { id: string; name: string; [key: string]: unknown }],
  };

  await updateManagedRuntimeConfig(runtimeSnapshot, (config) => {
    const agents = copiedRecord(config.agents);
    const defaults = copiedRecord(agents.defaults);
    defaults.model = {
      primary: `${UCLAW_PROVIDER_ID}/${UCLAW_DEFAULT_MODEL}`,
      fallbacks: [],
    };
    defaults.thinkingDefault = UCLAW_DEFAULT_THINKING_LEVEL;
    defaults.reasoningDefault = 'on';
    agents.defaults = defaults;
    config.agents = agents;

    removeManagedOpenAiAuthMetadata(config, managedProviderIds);

    const models = copiedRecord(config.models);
    const providers = copiedRecord(models.providers);
    for (const [providerId, existingEntry] of Object.entries(providers)) {
      if (
        managedProviderIds.has(providerId)
        || isOpenAiProviderIdentity({ ...copiedRecord(existingEntry), id: providerId })
      ) {
        delete providers[providerId];
      }
    }
    providers[UCLAW_PROVIDER_ID] = structuredClone(providerEntry);
    models.providers = providers;
    config.models = models;
  });

  await updateManagedAgentModelProviderStrict(agentModelsFiles, providerEntry, managedProviderIds);
}

type ManagedAuthSnapshot = {
  account: ProviderAccount | null;
  auth: AuthSecret | null;
  providerStore: ManagedProviderStoreSnapshot;
  providerSecretSlots: ProviderSecretSlotsSnapshot;
  verificationCache: VerificationCache | null;
  managedRuntime: ManagedRuntimeConfigSnapshot;
  deviceActivationFiles: ManagedDeviceActivationFilesSnapshot;
  agentModelsFiles: ManagedAgentModelsFilesSnapshot;
  agentAuthProfiles: ManagedAgentAuthProfilesSnapshot;
  managedOpenAiTargetAccountIds: string[];
  appliedVerificationCache?: VerificationCache | null;
  appliedDeviceActivationFiles?: ManagedDeviceActivationFilesApplied;
};

function activationFileSnapshotEquals(
  left: ManagedDeviceActivationFileSnapshot,
  right: ManagedDeviceActivationFileSnapshot,
): boolean {
  return left.path === right.path
    && (left.bytes === null
      ? right.bytes === null
      : right.bytes !== null && left.bytes.equals(right.bytes));
}

async function snapshot(): Promise<ManagedAuthSnapshot> {
  await ensureProviderStoreMigrated();
  // Freeze runtime files first so historical managed ids are discovered from
  // the same generations later used for commit, cleanup, or rollback.
  const managedRuntime = await snapshotManagedRuntimeConfig();
  const agentModelsFiles = await snapshotManagedAgentModelsFiles();
  const providerStore = await snapshotManagedProviderStore();
  const managedOpenAiTargetAccountIds = [...new Set([
    UCLAW_ACCOUNT_ID,
    UCLAW_PROVIDER_ID,
    ...UCLAW_LEGACY_PROVIDER_IDS,
    ...getManagedOpenAiTargetAccountIds(providerStore),
    ...getManagedRuntimeOpenAiProviderIds(managedRuntime),
    ...getManagedAgentOpenAiProviderIds(agentModelsFiles),
  ])];
  const providerSecretSlots = await snapshotProviderSecretSlots([
    ...managedOpenAiTargetAccountIds,
    UCLAW_AUTH_ACCOUNT_ID,
    ...UCLAW_LEGACY_AUTH_ACCOUNT_IDS,
  ]);
  return {
    account: await getProviderAccount(UCLAW_ACCOUNT_ID),
    auth: await readAuthSecret(false),
    providerStore,
    providerSecretSlots,
    verificationCache: await readVerificationCache(),
    managedRuntime,
    deviceActivationFiles: await snapshotManagedDeviceActivationFiles(),
    agentModelsFiles,
    agentAuthProfiles: await snapshotManagedAgentAuthProfiles(),
    managedOpenAiTargetAccountIds,
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
    fallbackAccountIds: [],
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

async function restoreSnapshot(previous: ManagedAuthSnapshot): Promise<void> {
  const failures: string[] = [];
  const attempt = async (name: string, task: () => Promise<void>): Promise<void> => {
    try {
      await task();
    } catch {
      failures.push(name);
    }
  };

  await attempt('provider-store', () => restoreManagedProviderStore(previous.providerStore));
  await attempt('provider-secrets', () => restoreProviderSecretSlots(previous.providerSecretSlots));

  if (Object.hasOwn(previous, 'appliedVerificationCache')) {
    await attempt('verification-cache', async () => {
      const current = await readVerificationCache();
      if (verificationCacheEquals(current, previous.verificationCache)) {
        return;
      }
      if (!verificationCacheEquals(current, previous.appliedVerificationCache ?? null)) {
        throw new ManagedAuthServiceError(
          'rollback_conflict',
          'UClaw verification cache changed after the managed authentication write',
        );
      }
      const store = await getClawXProviderStore();
      if (previous.verificationCache) store.set('uclawVerificationCache', previous.verificationCache);
      else store.delete('uclawVerificationCache');
    });
  }
  await attempt('runtime-managed-defaults', () => restoreManagedRuntimeConfig(previous.managedRuntime));
  let currentDeviceActivation: ManagedDeviceActivationFilesSnapshot | null = null;
  await attempt('device-activation-snapshot', async () => {
    currentDeviceActivation = await snapshotManagedDeviceActivationFiles();
  });
  if (currentDeviceActivation) {
    for (const target of ['current', 'stable'] as const) {
      await attempt(`device-activation:${target}`, async () => {
        const current = currentDeviceActivation![target];
        const before = previous.deviceActivationFiles[target];
        if (activationFileSnapshotEquals(current, before)) return;
        const applied = previous.appliedDeviceActivationFiles?.[target];
        if (!applied || !activationFileSnapshotEquals(current, applied)) {
          throw new ManagedAuthServiceError(
            'rollback_conflict',
            'UClaw device activation changed after the managed authentication write',
          );
        }
        await restoreManagedDeviceActivationFiles({ [target]: before });
      });
    }
  }
  // Raw Agent snapshots win after every Provider/config restoration step.
  await attempt('agent-models', () => restoreManagedAgentModelsFiles(previous.agentModelsFiles));
  await attempt('agent-auth-profiles', () => restoreManagedAgentAuthProfiles(previous.agentAuthProfiles));

  if (failures.length > 0) {
    logger.warn('[uclaw-auth] Provider snapshot rollback was incomplete', { failedSteps: failures });
    throw new ManagedAuthServiceError('rollback_failed', 'UClaw could not restore the previous runtime state');
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
  const responseUser = authUserFromPayload(auth);
  let rollbackFailed = false;
  let snapshotCompleted = false;
  let committedStatus: ManagedAuthStatus;
  const quiescence = await quiesceGatewayForManagedMutation(`commit-${source}`, gatewayManager);
  try {
    committedStatus = await withProviderMutationLock(async () => {
      // snapshot() may migrate the Provider Store, so persist recovery evidence
      // before it can perform the first credential-related write.
      await markManagedMutationStarted(quiescence);
      // Freeze every local generation only after all earlier Provider writers finish.
      const previous = await snapshot();
      snapshotCompleted = true;
      const previousAuth = previous.auth;
      const user = responseUser ?? (source === 'auth-token' ? userFromSecret(previousAuth) : undefined);
      if (!hasUserIdentity(user)) {
        throw new ManagedAuthServiceError('auth_identity_missing', 'UClaw did not return a usable account identity');
      }

      try {
        const previousSessionMatches = previousAuth
          ? ownerMatchesUser({ userId: previousAuth.subject, email: previousAuth.email }, user)
          : false;
        const authSecret: AuthSecret = {
          type: 'oauth',
          accountId: UCLAW_AUTH_ACCOUNT_ID,
          accessToken,
          refreshToken: auth.refreshToken?.trim()
            || (previousSessionMatches && previousAuth ? previousAuth.refreshToken.trim() : ''),
          expiresAt: authExpiry(auth),
          email: user?.email,
          subject: user?.id,
        };
        const account = buildManagedAccount(previous.account, user);
        const relaySecret: RelaySecret = {
          type: 'api_key',
          accountId: UCLAW_ACCOUNT_ID,
          apiKey: relay.token,
          ownerUserId: user?.id,
          ownerUsername: user?.username,
          ownerEmail: user?.email,
          expiresAt: relay.expiresAt,
        };
        await installManagedOpenAiProviderAccount(previous.providerStore, account);
        await installManagedProviderSecrets(previous.providerSecretSlots, authSecret, relaySecret);

        // Install only the managed OpenAI credential and runtime entries; generic
        // Provider synchronization can self-heal unrelated Provider ids.
        const managedProviderIds = new Set(previous.managedOpenAiTargetAccountIds);
        await installManagedAgentOpenAiApiKey(previous.agentAuthProfiles, relay.token, managedProviderIds);
        await syncManagedRuntimeDefaults(previous.agentModelsFiles, previous.managedRuntime, managedProviderIds);
        const appliedVerificationCache = buildVerificationCache(user, bootstrap);
        previous.appliedVerificationCache = appliedVerificationCache;
        await persistVerificationCache(appliedVerificationCache);
        const appliedDeviceActivationFiles: ManagedDeviceActivationFilesApplied = {};
        previous.appliedDeviceActivationFiles = appliedDeviceActivationFiles;
        await markManagedDeviceActivated(source, user, appliedDeviceActivationFiles);

        const status = await localStatus(bootstrap);
        return {
          ...status,
          localOnly: false,
          authValid: true,
          ...(user ? { user, auth: { user } } : {}),
        };
      } catch (error) {
        try {
          await restoreSnapshot(previous);
        } catch (rollbackError) {
          rollbackFailed = true;
          throw rollbackError;
        }
        throw error;
      }
    });
  } catch (error) {
    // Gateway lifecycle must never inherit or run inside the Provider lock context.
    if (rollbackFailed || (quiescence.markerStarted && !snapshotCompleted)) {
      await quarantineManagedMutation(
        quiescence,
        rollbackFailed
          ? 'managed authentication rollback failed'
          : 'managed authentication snapshot failed',
      );
    } else {
      const gateway = await resumeGatewayAfterManagedMutation(quiescence);
      if (gateway.gatewayReloadError) {
        logger.error(`[uclaw-auth] ${gateway.gatewayReloadError} after managed auth rollback`);
      }
    }
    throw error;
  }

  const gateway = await resumeGatewayAfterManagedMutation(quiescence);
  return { ...committedStatus, ...gateway };
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
    const device = isRecord(raw) && isRecord(raw.device) ? raw.device : null;
    let status = await localStatus(bootstrap);
    if (!status.hasRelayToken) {
      // The commit owns cache/device writes when relay recovery also requires
      // runtime mutation, so its snapshot still represents the old generation.
      const relay = await requestRelayToken(access.token, await getManagedDevicePayload());
      status = await commitAuthenticatedSession({
        accessToken: access.token,
        refreshToken: access.secret.refreshToken,
        expiresAt: access.secret.expiresAt,
        user,
      }, relay, 'auth-token', bootstrap, gatewayManager);
    } else {
      status = await withProviderMutationLock(async () => {
        await writeVerificationCache(user, bootstrap);
        if (device && ['active', 'activated', 'enabled'].includes(pickString(device, 'status', 'state').toLowerCase())) {
          await markManagedDeviceActivated('auth-token', user);
        }
        return localStatus(bootstrap);
      });
    }
    return { ...status, localOnly: false, authValid: true };
  } catch (error) {
    if (canUseOfflineGrace(error, currentLocal)) return currentLocal;
    const shape = errorShape(error);
    // Only an authoritative 401 revokes the local session. A successful
    // verification payload with valid:false is normalized to 401 above.
    const authRejected = shape.httpStatus === 401;
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

/** Force one verification that starts after every status request already in flight. */
export async function getFreshManagedAuthStatus(
  gatewayManager?: GatewayManager,
): Promise<ManagedAuthStatus> {
  const existing = statusInFlight?.promise;
  if (existing) {
    const previous = await existing.catch(() => null);
    // An earlier authoritative rejection remains conclusive after Billing 401.
    if (previous?.authRejected === true) return previous;
  }
  return getManagedAuthStatus({ force: true }, gatewayManager);
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
    const device = await getManagedDevicePayload();
    if (payload.activationCode?.trim() && !activationTicketFor(payload.activationCode.trim(), device.id)) {
      const activation = await checkActivationInternal(payload.activationCode.trim(), device);
      if (!activation.valid) {
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
  }).catch(failureResult);
}

export async function registerManagedAuth(
  payload: ManagedAuthRegisterPayload,
  gatewayManager?: GatewayManager,
): Promise<ManagedAuthResult> {
  return withMutation(async () => {
    const device = await getManagedDevicePayload();
    if (payload.activationCode?.trim() && !activationTicketFor(payload.activationCode.trim(), device.id)) {
      const activation = await checkActivationInternal(payload.activationCode.trim(), device);
      if (!activation.valid) {
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
    // Read without legacy migration so no credential write can precede quiescence.
    const secret = await readAuthSecret(false);
    const quiescence = await quiesceGatewayForManagedMutation('logout', gatewayManager);
    try {
      // Persist crash recovery before the remote logout can invalidate the
      // server session while local relay credentials still exist.
      await markManagedMutationStarted(quiescence);
    } catch (error) {
      await resumeGatewayAfterManagedMutation(quiescence);
      throw error;
    }
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
      await withProviderMutationLock(async () => {
        const previous = await snapshot();
        await clearManagedCredentials(previous);
      });
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      await quarantineManagedMutation(quiescence, 'managed logout cleanup failed');
      throw cleanupError;
    }
    // Local logout is authoritative; Gateway start failures are reported as
    // degraded status after the local credentials have already been removed.
    const gateway = await resumeGatewayAfterManagedMutation(quiescence);
    const status = await localStatus(defaultBootstrap());
    return {
      success: true,
      status: { ...status, ...gateway },
    };
  }).catch(failureResult);
}
