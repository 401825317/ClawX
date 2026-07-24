import { AsyncLocalStorage } from 'node:async_hooks';
import {
  UCLAW_DEFAULT_MODEL,
  UCLAW_LEGACY_PROVIDER_IDS,
  UCLAW_MANAGED_ACCOUNT_ID,
  UCLAW_MANAGED_AUTH_ACCOUNT_ID,
  UCLAW_MANAGED_PROVIDER_ID,
  UCLAW_MANAGED_PROVIDER_BASE_URL,
} from '../../../shared/junfeiai-endpoints';

const UCLAW_MANAGED_OPENAI_ACCOUNT_ID = UCLAW_MANAGED_PROVIDER_ID;
const OPENAI_PROVIDER_IDS = new Set([UCLAW_MANAGED_PROVIDER_ID, ...UCLAW_LEGACY_PROVIDER_IDS]);

const mutationContext = new AsyncLocalStorage<boolean>();
let mutationTail: Promise<void> = Promise.resolve();

type ProviderAccountReader = {
  getAccount(accountId: string): Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
export function resolveValidUclawManagedRelayToken(
  account: unknown,
  authSecret: unknown,
  relaySecret: unknown,
  nowMs = Date.now(),
): string | null {
  if (
    !isRecord(account)
    || account.id !== UCLAW_MANAGED_ACCOUNT_ID
    || account.vendorId !== 'openai'
    || !isUclawManagedAccount(account)
  ) {
    return null;
  }

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
    || relaySecret.accountId !== UCLAW_MANAGED_ACCOUNT_ID
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
    ? relaySecret.apiKey.trim()
    : null;
}

/** Recognize legacy relay records that were incorrectly stored as custom Providers. */
function isUclawOpenAiRelayIdentity(value: Record<string, unknown>): boolean {
  if (!hasManagedOpenAiModel(value) || typeof value.baseUrl !== 'string') return false;

  try {
    const baseUrl = new URL(value.baseUrl.trim());
    const managedBaseUrl = new URL(UCLAW_MANAGED_PROVIDER_BASE_URL);
    const pathname = baseUrl.pathname.replace(/\/+$/u, '') || '/';
    const managedPathname = managedBaseUrl.pathname.replace(/\/+$/u, '') || '/';
    return baseUrl.hostname.toLowerCase() === managedBaseUrl.hostname.toLowerCase()
      && baseUrl.port === managedBaseUrl.port
      && pathname === managedPathname;
  } catch {
    return false;
  }
}

/** Match OpenAI identities, including the canonical and historical runtime aliases. */
export function isOpenAiProviderIdentity(value: unknown): boolean {
  if (typeof value === 'string') return OPENAI_PROVIDER_IDS.has(value.trim());
  if (!isRecord(value)) return false;
  return OPENAI_PROVIDER_IDS.has(typeof value.id === 'string' ? value.id.trim() : '')
    || value.vendorId === 'openai'
    || value.type === 'openai'
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
