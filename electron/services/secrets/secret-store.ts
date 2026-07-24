import { safeStorage } from 'electron';
import { createHash } from 'node:crypto';
import type { ProviderSecret } from '../../shared/providers/types';
import { getClawXProviderStore } from '../providers/store-instance';
import { withProviderMutationLock } from '../providers/provider-mutation-lock';

export interface SecretStore {
  get(accountId: string, options?: { migrate?: boolean }): Promise<ProviderSecret | null>;
  set(secret: ProviderSecret): Promise<void>;
  delete(accountId: string): Promise<void>;
}

type EncryptedProviderSecret = {
  encoding: 'electron-safe-storage-v1';
  ciphertext: string;
};

type RawSecretMap = Record<string, unknown>;

type ProviderSecretRawSlot =
  | { exists: false }
  | { exists: true; value: unknown };

type ProviderSecretRawSlots = Record<string, ProviderSecretRawSlot>;

type ProviderSecretRawState = {
  providerSecretsV2: ProviderSecretRawSlots;
  providerSecrets: ProviderSecretRawSlots;
  apiKeys: ProviderSecretRawSlots;
};

declare const providerSecretSlotsSnapshotBrand: unique symbol;

export type ProviderSecretSlotsSnapshot = {
  readonly [providerSecretSlotsSnapshotBrand]: true;
};

type ProviderSecretSlotsSnapshotState = {
  accountIds: readonly string[];
  before: ProviderSecretRawState;
  beforeVersion: string;
  appliedVersion?: string;
};

const providerSecretSlotsSnapshots = new WeakMap<
  ProviderSecretSlotsSnapshot,
  ProviderSecretSlotsSnapshotState
>();

type RawSecretMaps = {
  providerSecretsV2: RawSecretMap;
  providerSecrets: RawSecretMap;
  apiKeys: RawSecretMap;
};

function canEncryptSecrets(): boolean {
  try {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  } catch {
    return false;
  }
}

function encryptSecret(secret: ProviderSecret): EncryptedProviderSecret | null {
  if (!canEncryptSecrets()) {
    return null;
  }

  return {
    encoding: 'electron-safe-storage-v1',
    ciphertext: safeStorage.encryptString(JSON.stringify(secret)).toString('base64'),
  };
}

function decryptSecret(value: unknown): ProviderSecret | null {
  if (
    !value
    || typeof value !== 'object'
    || (value as EncryptedProviderSecret).encoding !== 'electron-safe-storage-v1'
    || typeof (value as EncryptedProviderSecret).ciphertext !== 'string'
    || !canEncryptSecrets()
  ) {
    return null;
  }

  try {
    return JSON.parse(
      safeStorage.decryptString(Buffer.from((value as EncryptedProviderSecret).ciphertext, 'base64')),
    ) as ProviderSecret;
  } catch {
    return null;
  }
}

function normalizedTargetAccountIds(accountIds: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const accountId of accountIds) {
    if (typeof accountId !== 'string' || !accountId.trim()) {
      throw new Error('Provider Secret snapshot target ids must not be empty');
    }
    unique.add(accountId);
  }
  return [...unique];
}

function rawSecretMap(value: unknown, key: keyof RawSecretMaps): RawSecretMap {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${key} Secret store value`);
  }
  return { ...(value as RawSecretMap) };
}

function readRawSecretMaps(store: Awaited<ReturnType<typeof getClawXProviderStore>>): RawSecretMaps {
  return {
    providerSecretsV2: rawSecretMap(store.get('providerSecretsV2'), 'providerSecretsV2'),
    providerSecrets: rawSecretMap(store.get('providerSecrets'), 'providerSecrets'),
    apiKeys: rawSecretMap(store.get('apiKeys'), 'apiKeys'),
  };
}

function snapshotRawSlots(map: RawSecretMap, accountIds: readonly string[]): ProviderSecretRawSlots {
  const slots: ProviderSecretRawSlots = {};
  for (const accountId of accountIds) {
    slots[accountId] = Object.hasOwn(map, accountId)
      ? { exists: true, value: structuredClone(map[accountId]) }
      : { exists: false };
  }
  return slots;
}

function snapshotRawState(maps: RawSecretMaps, accountIds: readonly string[]): ProviderSecretRawState {
  return {
    providerSecretsV2: snapshotRawSlots(maps.providerSecretsV2, accountIds),
    providerSecrets: snapshotRawSlots(maps.providerSecrets, accountIds),
    apiKeys: snapshotRawSlots(maps.apiKeys, accountIds),
  };
}

function rawStateVersion(state: ProviderSecretRawState): string {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function requireSnapshotState(snapshot: ProviderSecretSlotsSnapshot): ProviderSecretSlotsSnapshotState {
  const state = providerSecretSlotsSnapshots.get(snapshot);
  if (!state) throw new Error('Invalid Provider Secret slots snapshot');
  return state;
}

function clearRawSlots(maps: RawSecretMaps, accountIds: readonly string[]): void {
  for (const accountId of accountIds) {
    delete maps.providerSecretsV2[accountId];
    delete maps.providerSecrets[accountId];
    delete maps.apiKeys[accountId];
  }
}

function installRawSecret(maps: RawSecretMaps, secret: ProviderSecret): void {
  const encrypted = encryptSecret(secret);
  if (encrypted) {
    maps.providerSecretsV2[secret.accountId] = encrypted;
    delete maps.providerSecrets[secret.accountId];
  } else {
    maps.providerSecrets[secret.accountId] = secret;
    delete maps.providerSecretsV2[secret.accountId];
  }
  delete maps.apiKeys[secret.accountId];
}

function restoreRawSlots(map: RawSecretMap, slots: ProviderSecretRawSlots, accountIds: readonly string[]): void {
  for (const accountId of accountIds) {
    const slot = slots[accountId];
    if (!slot?.exists) {
      delete map[accountId];
      continue;
    }
    map[accountId] = structuredClone(slot.value);
  }
}

function writeRawSecretMaps(
  store: Awaited<ReturnType<typeof getClawXProviderStore>>,
  maps: RawSecretMaps,
): void {
  store.set({
    providerSecretsV2: maps.providerSecretsV2,
    providerSecrets: maps.providerSecrets,
    apiKeys: maps.apiKeys,
  });
}

export class ElectronStoreSecretStore implements SecretStore {
  /** Re-read after acquiring the mutation lock so a stale legacy value cannot overwrite a newer login. */
  private async migrateCurrentSecret(accountId: string): Promise<ProviderSecret | null> {
    return withProviderMutationLock(async () => {
      const current = await this.get(accountId, { migrate: false });
      if (!current) return null;
      await this.set(current);
      return current;
    });
  }

  /** Read a secret from protected storage and migrate legacy values once. */
  async get(accountId: string, options: { migrate?: boolean } = {}): Promise<ProviderSecret | null> {
    const store = await getClawXProviderStore();
    const encryptedSecrets = (store.get('providerSecretsV2') ?? {}) as Record<string, EncryptedProviderSecret>;
    const secrets = (store.get('providerSecrets') ?? {}) as Record<string, ProviderSecret>;
    const encrypted = decryptSecret(encryptedSecrets[accountId]);
    if (encrypted) {
      return encrypted;
    }

    const legacySecret = secrets[accountId];
    if (legacySecret) {
      return options.migrate === false
        ? legacySecret
        : this.migrateCurrentSecret(accountId);
    }

    const apiKeys = (store.get('apiKeys') ?? {}) as Record<string, string>;
    const apiKey = apiKeys[accountId];
    if (!apiKey) {
      return null;
    }

    const secret: ProviderSecret = {
      type: 'api_key',
      accountId,
      apiKey,
    };
    return options.migrate === false
      ? secret
      : this.migrateCurrentSecret(accountId);
  }

  /** Persist a secret in safeStorage when available and remove legacy copies. */
  async set(secret: ProviderSecret): Promise<void> {
    const store = await getClawXProviderStore();
    const encryptedSecrets = (store.get('providerSecretsV2') ?? {}) as Record<string, EncryptedProviderSecret>;
    const secrets = (store.get('providerSecrets') ?? {}) as Record<string, ProviderSecret>;
    const encrypted = encryptSecret(secret);
    if (encrypted) {
      encryptedSecrets[secret.accountId] = encrypted;
      delete secrets[secret.accountId];
    } else {
      // Keep a compatibility value only when Electron cannot access OS encryption.
      secrets[secret.accountId] = secret;
      delete encryptedSecrets[secret.accountId];
    }
    store.set('providerSecretsV2', encryptedSecrets);
    store.set('providerSecrets', secrets);

    // Remove the legacy mirror so API keys cannot be duplicated in plain JSON.
    const apiKeys = (store.get('apiKeys') ?? {}) as Record<string, string>;
    delete apiKeys[secret.accountId];
    store.set('apiKeys', apiKeys);
  }

  /** Remove protected, compatibility, and legacy secret copies. */
  async delete(accountId: string): Promise<void> {
    const store = await getClawXProviderStore();
    const encryptedSecrets = (store.get('providerSecretsV2') ?? {}) as Record<string, EncryptedProviderSecret>;
    delete encryptedSecrets[accountId];
    store.set('providerSecretsV2', encryptedSecrets);

    const secrets = (store.get('providerSecrets') ?? {}) as Record<string, ProviderSecret>;
    delete secrets[accountId];
    store.set('providerSecrets', secrets);

    const apiKeys = (store.get('apiKeys') ?? {}) as Record<string, string>;
    delete apiKeys[accountId];
    store.set('apiKeys', apiKeys);
  }
}

/** Snapshot opaque target slots without decrypting or migrating any Secret. */
export async function snapshotProviderSecretSlots(
  accountIds: readonly string[],
): Promise<ProviderSecretSlotsSnapshot> {
  const targets = normalizedTargetAccountIds(accountIds);
  const store = await getClawXProviderStore();
  const maps = readRawSecretMaps(store);
  const before = snapshotRawState(maps, targets);
  const snapshot = Object.freeze({}) as ProviderSecretSlotsSnapshot;
  providerSecretSlotsSnapshots.set(snapshot, {
    accountIds: targets,
    before,
    beforeVersion: rawStateVersion(before),
  });
  return snapshot;
}

/** Atomically replace every frozen target with the canonical managed auth generation. */
export async function installManagedProviderSecrets(
  snapshot: ProviderSecretSlotsSnapshot,
  authSecret: Extract<ProviderSecret, { type: 'oauth' }>,
  relaySecret: Extract<ProviderSecret, { type: 'api_key' }>,
): Promise<void> {
  const state = requireSnapshotState(snapshot);
  const targets = state.accountIds;
  const targetSet = new Set(targets);
  if (relaySecret.accountId === authSecret.accountId) {
    throw new Error('Managed relay and auth Secret account ids must be different');
  }
  if (!targetSet.has(relaySecret.accountId) || !targetSet.has(authSecret.accountId)) {
    throw new Error('Managed Secret account ids must be included in the frozen target set');
  }

  const store = await getClawXProviderStore();
  const maps = readRawSecretMaps(store);
  const currentVersion = rawStateVersion(snapshotRawState(maps, targets));
  if (currentVersion !== state.beforeVersion) {
    throw new Error('Provider Secret targets changed after the transaction snapshot');
  }

  clearRawSlots(maps, targets);
  installRawSecret(maps, relaySecret);
  installRawSecret(maps, authSecret);
  const appliedVersion = rawStateVersion(snapshotRawState(maps, targets));
  try {
    writeRawSecretMaps(store, maps);
    state.appliedVersion = appliedVersion;
  } catch (error) {
    const observedVersion = rawStateVersion(snapshotRawState(readRawSecretMaps(store), targets));
    if (observedVersion === appliedVersion) state.appliedVersion = appliedVersion;
    throw error;
  }
}

/** Atomically restore the exact raw target slots while preserving unrelated Secrets. */
export async function restoreProviderSecretSlots(
  snapshot: ProviderSecretSlotsSnapshot,
): Promise<void> {
  const state = requireSnapshotState(snapshot);
  const targets = state.accountIds;
  const store = await getClawXProviderStore();
  const maps = readRawSecretMaps(store);
  const currentVersion = rawStateVersion(snapshotRawState(maps, targets));
  if (currentVersion === state.beforeVersion) {
    state.appliedVersion = undefined;
    return;
  }
  if (!state.appliedVersion || currentVersion !== state.appliedVersion) {
    throw new Error('Provider Secret targets changed after the managed install');
  }

  restoreRawSlots(maps.providerSecretsV2, state.before.providerSecretsV2, targets);
  restoreRawSlots(maps.providerSecrets, state.before.providerSecrets, targets);
  restoreRawSlots(maps.apiKeys, state.before.apiKeys, targets);
  writeRawSecretMaps(store, maps);
  state.appliedVersion = undefined;
}

const secretStore = new ElectronStoreSecretStore();

export function getSecretStore(): SecretStore {
  return secretStore;
}

export async function getProviderSecret(
  accountId: string,
  options?: { migrate?: boolean },
): Promise<ProviderSecret | null> {
  return getSecretStore().get(accountId, options);
}

export async function setProviderSecret(secret: ProviderSecret): Promise<void> {
  await getSecretStore().set(secret);
}

export async function deleteProviderSecret(accountId: string): Promise<void> {
  await getSecretStore().delete(accountId);
}
