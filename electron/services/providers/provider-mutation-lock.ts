import { AsyncLocalStorage } from 'node:async_hooks';
import {
  UCLAW_COMPATIBILITY_PROVIDER_ID,
  UCLAW_DEFAULT_API_PROTOCOL,
  UCLAW_DEFAULT_MODEL,
  UCLAW_LEGACY_PROVIDER_BASE_URLS,
  UCLAW_LEGACY_PROVIDER_IDS,
  UCLAW_MANAGED_ACCOUNT_ID,
  UCLAW_MANAGED_AUTH_ACCOUNT_ID,
  UCLAW_MANAGED_PROVIDER_ID,
  UCLAW_MANAGED_PROVIDER_BASE_URL,
  UCLAW_RUNTIME_CONTRACT_VERSION,
} from '../../../shared/junfeiai-endpoints';

const UCLAW_MANAGED_OPENAI_ACCOUNT_ID = UCLAW_MANAGED_PROVIDER_ID;
const OPENAI_PROVIDER_IDS = new Set([
  UCLAW_MANAGED_PROVIDER_ID,
  UCLAW_COMPATIBILITY_PROVIDER_ID,
  ...UCLAW_LEGACY_PROVIDER_IDS,
]);

const mutationContext = new AsyncLocalStorage<boolean>();
let mutationTail: Promise<void> = Promise.resolve();

type ProviderAccountReader = {
  getAccount(accountId: string): Promise<unknown>;
};

type ManagedProviderModelContract = {
  defaultModel: string;
  models: string[];
};

type ManagedRelayResolution = {
  token: string;
  modelContract: ManagedProviderModelContract;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedProviderBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      return null;
    }
    const pathname = url.pathname.replace(/\/+$/u, '') || '/';
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

function exactStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item || item.trim() !== item) return null;
    values.push(item);
  }
  return new Set(values).size === values.length ? values : null;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Validate the non-display fields written by buildManagedProviderAccounts. */
function resolveManagedProviderModelContract(
  account: unknown,
  expectedAccountId: string,
  expectedVendorId: string,
  expectedIsDefault: boolean,
): ManagedProviderModelContract | null {
  if (
    !isRecord(account)
    || account.id !== expectedAccountId
    || account.vendorId !== expectedVendorId
    || account.authMode !== 'api_key'
    || normalizedProviderBaseUrl(account.baseUrl) !== normalizedProviderBaseUrl(UCLAW_MANAGED_PROVIDER_BASE_URL)
    || account.apiProtocol !== UCLAW_DEFAULT_API_PROTOCOL
    || account.enabled !== true
    || account.isDefault !== expectedIsDefault
    || !Array.isArray(account.fallbackModels)
    || account.fallbackModels.length !== 0
    || !Array.isArray(account.fallbackAccountIds)
    || account.fallbackAccountIds.length !== 0
    || !isUclawManagedAccount(account)
    || !isRecord(account.metadata)
    || account.metadata.managedRuntimeContractVersion !== UCLAW_RUNTIME_CONTRACT_VERSION
  ) {
    return null;
  }

  const defaultModel = typeof account.model === 'string' ? account.model.trim() : '';
  const managedDefaultModel = typeof account.metadata.managedDefaultModel === 'string'
    ? account.metadata.managedDefaultModel.trim()
    : '';
  const allowedModels = exactStringArray(account.metadata.managedAllowedModels);
  const customModels = exactStringArray(account.metadata.customModels);
  if (
    !defaultModel
    || account.model !== defaultModel
    || managedDefaultModel !== defaultModel
    || !allowedModels
    || allowedModels.length === 0
    || !customModels
    || !allowedModels.includes(defaultModel)
    || !sameStringArray(allowedModels, customModels)
  ) {
    return null;
  }
  return { defaultModel, models: allowedModels };
}

function isManagedOpenAiModel(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  const separator = normalized.lastIndexOf('/');
  return (separator >= 0 ? normalized.slice(separator + 1) : normalized) === UCLAW_DEFAULT_MODEL;
}

function hasManagedOpenAiModel(value: Record<string, unknown>): boolean {
  if (isManagedOpenAiModel(value.model) || isManagedOpenAiModel(value.modelId)) return true;
  if (Array.isArray(value.models) && value.models.some((model) => (
    isRecord(model) && isManagedOpenAiModel(model.id)
  ))) {
    return true;
  }
  return isRecord(value.metadata)
    && Array.isArray(value.metadata.customModels)
    && value.metadata.customModels.some(isManagedOpenAiModel);
}

/** Error returned when an ordinary Provider flow attempts to mutate UClaw-owned OpenAI state. */
export class ManagedProviderMutationError extends Error {
  constructor() {
    super('This UClaw-managed provider account can only be changed through UClaw account settings');
    this.name = 'ManagedProviderMutationError';
  }

  override toString(): string {
    return this.message;
  }
}

/** Run one Provider mutation transaction at a time while allowing nested service calls. */
export async function withProviderMutationLock<T>(task: () => Promise<T>): Promise<T> {
  if (mutationContext.getStore() === true) {
    return task();
  }

  const previous = mutationTail;
  let release: () => void = () => undefined;
  mutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await mutationContext.run(true, task);
  } finally {
    release();
  }
}

/** Exposed for lifecycle assertions; production callers should use withProviderMutationLock. */
export function isProviderMutationLockHeld(): boolean {
  return mutationContext.getStore() === true;
}

export function isUclawManagedAccount(account: unknown): boolean {
  return isRecord(account)
    && isRecord(account.metadata)
    && account.metadata.managedBy === 'uclaw';
}

function normalizedIdentity(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

/** Match Relay ownership to the canonical UClaw OAuth identity. */
function managedRelayOwnerMatchesAuth(
  relaySecret: Record<string, unknown>,
  authSecret: Record<string, unknown>,
): boolean {
  const ownerUserId = typeof relaySecret.ownerUserId === 'string'
    ? relaySecret.ownerUserId.trim()
    : '';
  const authSubject = typeof authSecret.subject === 'string'
    ? authSecret.subject.trim()
    : '';
  if (ownerUserId && authSubject) {
    return ownerUserId === authSubject;
  }

  const ownerEmail = normalizedIdentity(relaySecret.ownerEmail);
  const authEmail = normalizedIdentity(authSecret.email);
  return Boolean(ownerEmail && authEmail && ownerEmail === authEmail);
}

/**
 * Return a Relay Token only when the complete canonical managed identity is coherent.
 * The optional clock keeps expiry checks deterministic for callers and unit tests.
 */
function resolveValidManagedRelay(
  account: unknown,
  expectedAccountId: string,
  expectedVendorId: string,
  expectedIsDefault: boolean,
  authSecret: unknown,
  relaySecret: unknown,
  nowMs = Date.now(),
): ManagedRelayResolution | null {
  const modelContract = resolveManagedProviderModelContract(
    account,
    expectedAccountId,
    expectedVendorId,
    expectedIsDefault,
  );
  if (!modelContract) return null;

  if (
    !isRecord(authSecret)
    || authSecret.type !== 'oauth'
    || authSecret.accountId !== UCLAW_MANAGED_AUTH_ACCOUNT_ID
    || typeof authSecret.accessToken !== 'string'
    || !authSecret.accessToken.trim()
    || typeof authSecret.expiresAt !== 'number'
    || !Number.isFinite(authSecret.expiresAt)
    || authSecret.expiresAt <= 0
  ) {
    return null;
  }

  if (
    !isRecord(relaySecret)
    || relaySecret.type !== 'api_key'
    || relaySecret.accountId !== expectedAccountId
    || typeof relaySecret.apiKey !== 'string'
    || !relaySecret.apiKey.trim()
  ) {
    return null;
  }

  if (
    relaySecret.expiresAt !== undefined
    && (
      typeof relaySecret.expiresAt !== 'number'
      || !Number.isFinite(relaySecret.expiresAt)
      || relaySecret.expiresAt <= nowMs
    )
  ) {
    return null;
  }

  return managedRelayOwnerMatchesAuth(relaySecret, authSecret)
    ? { token: relaySecret.apiKey.trim(), modelContract }
    : null;
}

export function resolveValidUclawManagedRelayToken(
  account: unknown,
  authSecret: unknown,
  relaySecret: unknown,
  nowMs = Date.now(),
): string | null {
  return resolveValidManagedRelay(
    account,
    UCLAW_MANAGED_ACCOUNT_ID,
    UCLAW_MANAGED_PROVIDER_ID,
    true,
    authSecret,
    relaySecret,
    nowMs,
  )?.token ?? null;
}

/** Inject a Relay Token only when both managed Provider identities contain the same credential. */
export function resolveValidUclawManagedRelayPairToken(
  account: unknown,
  compatibilityAccount: unknown,
  authSecret: unknown,
  relaySecret: unknown,
  compatibilityRelaySecret: unknown,
  nowMs = Date.now(),
): string | null {
  const primary = resolveValidManagedRelay(
    account,
    UCLAW_MANAGED_ACCOUNT_ID,
    UCLAW_MANAGED_PROVIDER_ID,
    true,
    authSecret,
    relaySecret,
    nowMs,
  );
  if (!primary) return null;
  const compatibility = resolveValidManagedRelay(
    compatibilityAccount,
    UCLAW_COMPATIBILITY_PROVIDER_ID,
    UCLAW_COMPATIBILITY_PROVIDER_ID,
    false,
    authSecret,
    compatibilityRelaySecret,
    nowMs,
  );
  if (
    !compatibility
    || compatibility.token !== primary.token
    || compatibility.modelContract.defaultModel !== primary.modelContract.defaultModel
    || !sameStringArray(compatibility.modelContract.models, primary.modelContract.models)
  ) {
    return null;
  }
  return primary.token;
}

/** Recognize legacy relay records that were incorrectly stored as custom Providers. */
function isUclawOpenAiRelayIdentity(value: Record<string, unknown>): boolean {
  if (!hasManagedOpenAiModel(value) || typeof value.baseUrl !== 'string') return false;

  const normalized = normalizedProviderBaseUrl(value.baseUrl);
  if (!normalized) return false;
  return [UCLAW_MANAGED_PROVIDER_BASE_URL, ...UCLAW_LEGACY_PROVIDER_BASE_URLS]
    .some((baseUrl) => normalizedProviderBaseUrl(baseUrl) === normalized);
}

/** Match OpenAI identities, including the canonical and historical runtime aliases. */
export function isOpenAiProviderIdentity(value: unknown): boolean {
  if (typeof value === 'string') return OPENAI_PROVIDER_IDS.has(value.trim());
  if (!isRecord(value)) return false;
  return OPENAI_PROVIDER_IDS.has(typeof value.id === 'string' ? value.id.trim() : '')
    || value.vendorId === 'openai'
    || value.vendorId === UCLAW_COMPATIBILITY_PROVIDER_ID
    || value.type === 'openai'
    || value.type === UCLAW_COMPATIBILITY_PROVIDER_ID
    || isUclawOpenAiRelayIdentity(value);
}

/** Check the canonical managed marker only when the requested mutation targets real OpenAI. */
export async function isManagedOpenAiMutationLocked(
  providerService: ProviderAccountReader,
  ...targets: unknown[]
): Promise<boolean> {
  if (!targets.some(isOpenAiProviderIdentity)) return false;
  return isUclawManagedAccount(
    await providerService.getAccount(UCLAW_MANAGED_OPENAI_ACCOUNT_ID),
  );
}

/** Enforce managed ownership after entering the mutation lock. */
export function assertProviderMutationAllowed(
  canonicalOpenAiAccount: unknown,
  ...targets: unknown[]
): void {
  if (targets.some(isUclawManagedAccount)) {
    throw new ManagedProviderMutationError();
  }
  if (
    isUclawManagedAccount(canonicalOpenAiAccount)
    && targets.some(isOpenAiProviderIdentity)
  ) {
    throw new ManagedProviderMutationError();
  }
}
