import { createHash } from 'node:crypto';
import type { ProviderAccount, ProviderConfig, ProviderType } from '../../shared/providers/types';
import { getProviderDefinition } from '../../shared/providers/registry';
import { isOpenAiProviderIdentity } from './provider-mutation-lock';
import { getClawXProviderStore } from './store-instance';

const MANAGED_PROVIDER_STORE_SNAPSHOT_VERSION = 1 as const;
const OPENAI_PROVIDER_ID = 'openai';

type ProviderStoreValueSnapshot = {
  present: boolean;
  value?: unknown;
};

type ManagedProviderStoreState = {
  providerAccountsPresent: boolean;
  providerAccounts: Record<string, ProviderAccount>;
  defaultProvider: ProviderStoreValueSnapshot;
  defaultProviderAccountId: ProviderStoreValueSnapshot;
};

type ManagedProviderStoreSnapshotData = {
  version: typeof MANAGED_PROVIDER_STORE_SNAPSHOT_VERSION;
  before: ManagedProviderStoreState;
  beforeHash: string;
  applied?: {
    version: typeof MANAGED_PROVIDER_STORE_SNAPSHOT_VERSION;
    hash: string;
  };
};

declare const managedProviderStoreSnapshotBrand: unique symbol;

/** Opaque transaction state used only by the managed Provider install and restore APIs. */
export type ManagedProviderStoreSnapshot = {
  readonly [managedProviderStoreSnapshotBrand]: true;
};

function cloneProviderAccounts(value: unknown): Record<string, ProviderAccount> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return structuredClone(value) as Record<string, ProviderAccount>;
}

function snapshotValue(store: Record<string, unknown>, key: string): ProviderStoreValueSnapshot {
  const present = Object.hasOwn(store, key);
  return {
    present,
    ...(present ? { value: structuredClone(store[key]) } : {}),
  };
}

function readManagedProviderStoreState(store: Record<string, unknown>): ManagedProviderStoreState {
  return {
    providerAccountsPresent: Object.hasOwn(store, 'providerAccounts'),
    providerAccounts: cloneProviderAccounts(store.providerAccounts),
    defaultProvider: snapshotValue(store, 'defaultProvider'),
    defaultProviderAccountId: snapshotValue(store, 'defaultProviderAccountId'),
  };
}

function fingerprintManagedProviderStoreState(state: ManagedProviderStoreState): string {
  return createHash('sha256')
    .update(`${MANAGED_PROVIDER_STORE_SNAPSHOT_VERSION}\0${JSON.stringify(state)}`)
    .digest('hex');
}

function getSnapshotData(snapshot: ManagedProviderStoreSnapshot): ManagedProviderStoreSnapshotData {
  const data = snapshot as unknown as ManagedProviderStoreSnapshotData;
  if (
    data?.version !== MANAGED_PROVIDER_STORE_SNAPSHOT_VERSION
    || !data.before
    || typeof data.beforeHash !== 'string'
    || (data.applied !== undefined && (
      data.applied.version !== MANAGED_PROVIDER_STORE_SNAPSHOT_VERSION
      || typeof data.applied.hash !== 'string'
    ))
  ) {
    throw new Error('Invalid managed Provider store snapshot');
  }
  return data;
}

function isOpenAiTargetAccount(storageId: string, account: ProviderAccount): boolean {
  return isOpenAiProviderIdentity(storageId) || isOpenAiProviderIdentity(account);
}

function restoreSnapshotValue(
  store: Record<string, unknown>,
  key: string,
  snapshot: ProviderStoreValueSnapshot,
): void {
  if (snapshot.present) store[key] = structuredClone(snapshot.value);
  else delete store[key];
}

function applyManagedProviderStoreState(
  store: Record<string, unknown>,
  state: ManagedProviderStoreState,
): Record<string, unknown> {
  const nextStore = structuredClone(store);
  if (state.providerAccountsPresent) {
    nextStore.providerAccounts = structuredClone(state.providerAccounts);
  } else {
    delete nextStore.providerAccounts;
  }
  restoreSnapshotValue(nextStore, 'defaultProvider', state.defaultProvider);
  restoreSnapshotValue(nextStore, 'defaultProviderAccountId', state.defaultProviderAccountId);
  return nextStore;
}


function inferAuthMode(type: ProviderType): ProviderAccount['authMode'] {
  if (type === 'ollama') {
    return 'local';
  }

  const definition = getProviderDefinition(type);
  if (definition?.defaultAuthMode) {
    return definition.defaultAuthMode;
  }

  return 'api_key';
}

export function providerConfigToAccount(
  config: ProviderConfig,
  options?: { isDefault?: boolean },
): ProviderAccount {
  return {
    id: config.id,
    vendorId: config.type,
    label: config.name,
    authMode: inferAuthMode(config.type),
    baseUrl: config.baseUrl,
    apiProtocol: config.apiProtocol || (config.type === 'custom' || config.type === 'ollama'
      ? 'openai-completions'
      : getProviderDefinition(config.type)?.providerConfig?.api),
    headers: config.headers,
    model: config.model,
    fallbackModels: config.fallbackModels,
    fallbackAccountIds: config.fallbackProviderIds,
    enabled: config.enabled,
    isDefault: options?.isDefault ?? false,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

export function providerAccountToConfig(account: ProviderAccount): ProviderConfig {
  return {
    id: account.id,
    name: account.label,
    type: account.vendorId,
    baseUrl: account.baseUrl,
    apiProtocol: account.apiProtocol,
    headers: account.headers,
    model: account.model,
    fallbackModels: account.fallbackModels,
    fallbackProviderIds: account.fallbackAccountIds,
    enabled: account.enabled,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export async function listProviderAccounts(): Promise<ProviderAccount[]> {
  const store = await getClawXProviderStore();
  const accounts = store.get('providerAccounts') as Record<string, ProviderAccount> | undefined;
  return Object.values(accounts ?? {});
}

export async function getProviderAccount(accountId: string): Promise<ProviderAccount | null> {
  const store = await getClawXProviderStore();
  const accounts = store.get('providerAccounts') as Record<string, ProviderAccount> | undefined;
  return accounts?.[accountId] ?? null;
}

export async function saveProviderAccount(account: ProviderAccount): Promise<void> {
  const store = await getClawXProviderStore();
  const accounts = (store.get('providerAccounts') ?? {}) as Record<string, ProviderAccount>;
  accounts[account.id] = account;
  store.set('providerAccounts', accounts);
}

export async function deleteProviderAccount(accountId: string): Promise<void> {
  const store = await getClawXProviderStore();
  const accounts = (store.get('providerAccounts') ?? {}) as Record<string, ProviderAccount>;
  delete accounts[accountId];
  store.set('providerAccounts', accounts);

  if (store.get('defaultProviderAccountId') === accountId) {
    store.delete('defaultProviderAccountId');
  }
}

export async function setDefaultProviderAccount(accountId: string): Promise<void> {
  const store = await getClawXProviderStore();
  store.set('defaultProviderAccountId', accountId);

  const accounts = (store.get('providerAccounts') ?? {}) as Record<string, ProviderAccount>;
  for (const account of Object.values(accounts)) {
    account.isDefault = account.id === accountId;
  }
  store.set('providerAccounts', accounts);
}

export async function getDefaultProviderAccountId(): Promise<string | undefined> {
  const store = await getClawXProviderStore();
  return store.get('defaultProviderAccountId') as string | undefined;
}

/** Capture the complete Provider account/default state before managed authentication takes ownership. */
export async function snapshotManagedProviderStore(): Promise<ManagedProviderStoreSnapshot> {
  const store = await getClawXProviderStore();
  const before = readManagedProviderStoreState(store.store as Record<string, unknown>);
  const snapshot: ManagedProviderStoreSnapshotData = {
    version: MANAGED_PROVIDER_STORE_SNAPSHOT_VERSION,
    before,
    beforeHash: fingerprintManagedProviderStoreState(before),
  };
  return snapshot as unknown as ManagedProviderStoreSnapshot;
}

/** Return account ids whose stored OpenAI configuration must be exclusively replaced. */
export function getManagedOpenAiTargetAccountIds(snapshot: ManagedProviderStoreSnapshot): string[] {
  const { before } = getSnapshotData(snapshot);
  const targetIds = new Set<string>();
  for (const [storageId, account] of Object.entries(before.providerAccounts)) {
    if (!isOpenAiTargetAccount(storageId, account)) continue;
    targetIds.add(storageId);
    if (typeof account?.id === 'string') targetIds.add(account.id);
  }
  return [...targetIds];
}

/** Atomically replace all OpenAI targets with the single UClaw-managed account. */
export async function installManagedOpenAiProviderAccount(
  snapshot: ManagedProviderStoreSnapshot,
  account: ProviderAccount,
): Promise<void> {
  if (
    account.id !== OPENAI_PROVIDER_ID
    || account.vendorId !== OPENAI_PROVIDER_ID
    || account.metadata?.managedBy !== 'uclaw'
  ) {
    throw new Error('Expected the managed UClaw OpenAI account');
  }

  const snapshotData = getSnapshotData(snapshot);
  const store = await getClawXProviderStore();
  const currentStore = store.store as Record<string, unknown>;
  const current = readManagedProviderStoreState(currentStore);
  if (fingerprintManagedProviderStoreState(current) !== snapshotData.beforeHash) {
    throw new Error('Provider store changed after the managed snapshot');
  }

  const providerAccounts: Record<string, ProviderAccount> = {};
  for (const [storageId, existing] of Object.entries(current.providerAccounts)) {
    if (isOpenAiTargetAccount(storageId, existing)) continue;
    providerAccounts[storageId] = { ...structuredClone(existing), isDefault: false };
  }
  providerAccounts[account.id] = { ...structuredClone(account), isDefault: true };
  const appliedState: ManagedProviderStoreState = {
    providerAccountsPresent: true,
    providerAccounts,
    defaultProvider: { present: true, value: account.id },
    defaultProviderAccountId: { present: true, value: account.id },
  };

  snapshotData.applied = {
    version: MANAGED_PROVIDER_STORE_SNAPSHOT_VERSION,
    hash: fingerprintManagedProviderStoreState(appliedState),
  };
  // Record the expected result before the write so rollback can resolve an ambiguous write error.
  store.store = applyManagedProviderStoreState(currentStore, appliedState);
}

/** Restore the original Provider state only when no concurrent Provider change would be overwritten. */
export async function restoreManagedProviderStore(snapshot: ManagedProviderStoreSnapshot): Promise<void> {
  const snapshotData = getSnapshotData(snapshot);
  const store = await getClawXProviderStore();
  const currentStore = store.store as Record<string, unknown>;
  const currentHash = fingerprintManagedProviderStoreState(readManagedProviderStoreState(currentStore));
  if (currentHash === snapshotData.beforeHash) return;
  if (!snapshotData.applied || currentHash !== snapshotData.applied.hash) {
    throw new Error('Provider store changed after managed installation');
  }

  // Restore all managed keys together while retaining unrelated top-level settings.
  store.store = applyManagedProviderStoreState(currentStore, snapshotData.before);
}
