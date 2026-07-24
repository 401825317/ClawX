import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const encryptString = vi.fn((value: string) => Buffer.from(`protected:${value}`, 'utf8'));
  const decryptString = vi.fn((value: Buffer) => value.toString('utf8').replace(/^protected:/, ''));
  return {
    values,
    encryptionAvailable: true,
    encryptString,
    decryptString,
    store: {
      get: vi.fn((key: string) => values.get(key)),
      set: vi.fn((key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === 'string') {
          values.set(key, value);
          return;
        }
        for (const [entryKey, entryValue] of Object.entries(key)) {
          values.set(entryKey, entryValue);
        }
      }),
    },
  };
});

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    encryptString: mocks.encryptString,
    decryptString: mocks.decryptString,
  },
}));

vi.mock('@electron/services/providers/store-instance', () => ({
  getClawXProviderStore: async () => mocks.store,
}));

import {
  ElectronStoreSecretStore,
  installManagedProviderSecrets,
  restoreProviderSecretSlots,
  snapshotProviderSecretSlots,
} from '@electron/services/secrets/secret-store';
import { withProviderMutationLock } from '@electron/services/providers/provider-mutation-lock';

describe('ElectronStoreSecretStore', () => {
  beforeEach(() => {
    mocks.values.clear();
    mocks.encryptionAvailable = true;
    vi.clearAllMocks();
  });

  it('persists managed credentials only in protected storage when encryption is available', async () => {
    mocks.values.set('providerSecrets', {});
    mocks.values.set('providerSecretsV2', {});
    mocks.values.set('apiKeys', { 'uclaw-auth': 'legacy-copy' });
    const store = new ElectronStoreSecretStore();

    await store.set({
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'access-fixture-secret',
      refreshToken: 'refresh-fixture-secret',
      expiresAt: Date.now() + 60_000,
    });

    expect(mocks.values.get('providerSecrets')).toEqual({});
    expect(mocks.values.get('apiKeys')).toEqual({});
    const persisted = JSON.stringify(Object.fromEntries(mocks.values));
    expect(persisted).not.toContain('access-fixture-secret');
    expect(persisted).not.toContain('refresh-fixture-secret');
    expect(persisted).not.toContain('legacy-copy');
    expect(persisted).toContain('electron-safe-storage-v1');
  });

  it('migrates a legacy plaintext secret after reading it', async () => {
    mocks.values.set('providerSecrets', {
      openai: { type: 'api_key', accountId: 'openai', apiKey: 'relay-fixture-secret' },
    });
    mocks.values.set('providerSecretsV2', {});
    mocks.values.set('apiKeys', { openai: 'relay-fixture-secret' });
    const store = new ElectronStoreSecretStore();

    await expect(store.get('openai')).resolves.toEqual({
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'relay-fixture-secret',
    });

    expect(mocks.values.get('providerSecrets')).toEqual({});
    expect(mocks.values.get('apiKeys')).toEqual({});
    const persisted = JSON.stringify(Object.fromEntries(mocks.values));
    expect(persisted).not.toContain('relay-fixture-secret');
    await expect(store.get('openai')).resolves.toEqual({
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'relay-fixture-secret',
    });
  });

  it('re-reads a legacy Secret after the managed install lock instead of restoring stale credentials', async () => {
    const oldRelay = {
      type: 'api_key' as const,
      accountId: 'openai',
      apiKey: 'old-relay',
    };
    const nextRelay = {
      type: 'api_key' as const,
      accountId: 'openai',
      apiKey: 'next-relay',
    };
    mocks.values.set('providerSecretsV2', {});
    mocks.values.set('providerSecrets', { openai: oldRelay });
    mocks.values.set('apiKeys', {});

    let releaseManagedInstall!: () => void;
    const managedInstallPaused = new Promise<void>((resolve) => {
      releaseManagedInstall = resolve;
    });
    let managedSnapshotReady!: () => void;
    const managedSnapshotCaptured = new Promise<void>((resolve) => {
      managedSnapshotReady = resolve;
    });

    const managedInstall = withProviderMutationLock(async () => {
      const snapshot = await snapshotProviderSecretSlots(['openai', 'uclaw-auth']);
      managedSnapshotReady();
      await managedInstallPaused;
      await installManagedProviderSecrets(snapshot, {
        type: 'oauth',
        accountId: 'uclaw-auth',
        accessToken: 'next-access',
        refreshToken: 'next-refresh',
        expiresAt: 456,
      }, nextRelay);
    });
    await managedSnapshotCaptured;

    let legacyReadObserved!: () => void;
    const legacyRead = new Promise<void>((resolve) => {
      legacyReadObserved = resolve;
    });
    let watchLegacyRead = true;
    mocks.store.get.mockImplementation((key: string) => {
      const value = mocks.values.get(key);
      if (watchLegacyRead && key === 'providerSecrets') {
        watchLegacyRead = false;
        legacyReadObserved();
      }
      return value;
    });

    const store = new ElectronStoreSecretStore();
    const migration = store.get('openai');
    await legacyRead;
    releaseManagedInstall();

    await managedInstall;
    await expect(migration).resolves.toEqual(nextRelay);
    await expect(store.get('openai', { migrate: false })).resolves.toEqual(nextRelay);
    expect(JSON.stringify(Object.fromEntries(mocks.values))).not.toContain('old-relay');
  });

  it('reads legacy data without migrating during a read-only status check', async () => {
    mocks.values.set('providerSecrets', {
      openai: { type: 'api_key', accountId: 'openai', apiKey: 'legacy-read-only' },
    });
    mocks.values.set('providerSecretsV2', {});
    mocks.values.set('apiKeys', { openai: 'legacy-read-only' });
    const store = new ElectronStoreSecretStore();

    await expect(store.get('openai', { migrate: false })).resolves.toEqual({
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'legacy-read-only',
    });

    expect(mocks.values.get('providerSecrets')).toEqual({
      openai: { type: 'api_key', accountId: 'openai', apiKey: 'legacy-read-only' },
    });
    expect(mocks.values.get('providerSecretsV2')).toEqual({});
    expect(mocks.values.get('apiKeys')).toEqual({ openai: 'legacy-read-only' });
  });

  it('removes protected and legacy copies together', async () => {
    mocks.values.set('providerSecrets', {
      openai: { type: 'api_key', accountId: 'openai', apiKey: 'plain' },
    });
    mocks.values.set('providerSecretsV2', {
      openai: { encoding: 'electron-safe-storage-v1', ciphertext: 'ciphertext' },
    });
    mocks.values.set('apiKeys', { openai: 'legacy' });
    const store = new ElectronStoreSecretStore();

    await store.delete('openai');

    expect(mocks.values.get('providerSecrets')).toEqual({});
    expect(mocks.values.get('providerSecretsV2')).toEqual({});
    expect(mocks.values.get('apiKeys')).toEqual({});
  });

  it('keeps a compatibility value when OS encryption is unavailable', async () => {
    mocks.encryptionAvailable = false;
    mocks.values.set('providerSecrets', {});
    mocks.values.set('providerSecretsV2', {});
    mocks.values.set('apiKeys', {});
    const store = new ElectronStoreSecretStore();

    await store.set({ type: 'api_key', accountId: 'openai', apiKey: 'local-fallback' });

    expect(mocks.values.get('providerSecrets')).toEqual({
      openai: { type: 'api_key', accountId: 'openai', apiKey: 'local-fallback' },
    });
    expect(mocks.values.get('providerSecretsV2')).toEqual({});
  });

  it('snapshots opaque raw slots without decrypting or migrating them', async () => {
    const encryptedOpenAi = { encoding: 'electron-safe-storage-v1', ciphertext: 'opaque-ciphertext' };
    const plainAuth = {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh',
      expiresAt: 123,
    };
    mocks.values.set('providerSecretsV2', { openai: encryptedOpenAi, deepseek: { keep: true } });
    mocks.values.set('providerSecrets', { 'uclaw-auth': plainAuth });
    mocks.values.set('apiKeys', { 'openai-codex': 'legacy-key', deepseek: 'keep-key' });

    const snapshot = await snapshotProviderSecretSlots(['openai', 'uclaw-auth', 'openai-codex']);
    await restoreProviderSecretSlots(snapshot);

    expect(Object.keys(snapshot)).toEqual([]);
    expect(mocks.values.get('providerSecretsV2')).toEqual({ openai: encryptedOpenAi, deepseek: { keep: true } });
    expect(mocks.values.get('providerSecrets')).toEqual({ 'uclaw-auth': plainAuth });
    expect(mocks.values.get('apiKeys')).toEqual({ 'openai-codex': 'legacy-key', deepseek: 'keep-key' });
    expect(mocks.store.set).not.toHaveBeenCalled();
    expect(mocks.encryptString).not.toHaveBeenCalled();
    expect(mocks.decryptString).not.toHaveBeenCalled();
  });

  it('atomically installs managed Secrets and restores exact target slots', async () => {
    const originalEncrypted = {
      openai: { encoding: 'electron-safe-storage-v1', ciphertext: 'old-openai' },
      'openai-secondary': { encoding: 'electron-safe-storage-v1', ciphertext: 'old-secondary' },
      deepseek: { encoding: 'electron-safe-storage-v1', ciphertext: 'keep-deepseek' },
    };
    const originalPlain = {
      'uclaw-auth': {
        type: 'oauth',
        accountId: 'uclaw-auth',
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: 123,
      },
      'openai-codex': { type: 'api_key', accountId: 'openai-codex', apiKey: 'old-codex' },
      moonshot: { type: 'api_key', accountId: 'moonshot', apiKey: 'keep-moonshot' },
    };
    const originalApiKeys = {
      openai: 'old-openai-key',
      'openai-secondary': 'old-secondary-key',
      'openai-codex': 'old-codex-key',
      deepseek: 'keep-deepseek-key',
    };
    mocks.values.set('providerSecretsV2', structuredClone(originalEncrypted));
    mocks.values.set('providerSecrets', structuredClone(originalPlain));
    mocks.values.set('apiKeys', structuredClone(originalApiKeys));
    const targets = ['openai', 'openai-secondary', 'openai-codex', 'uclaw-auth'];
    const snapshot = await snapshotProviderSecretSlots(targets);
    const authSecret = {
      type: 'oauth' as const,
      accountId: 'uclaw-auth',
      accessToken: 'next-access',
      refreshToken: 'next-refresh',
      expiresAt: 456,
    };
    const relaySecret = {
      type: 'api_key' as const,
      accountId: 'openai',
      apiKey: 'next-relay',
      ownerUserId: 'user-1',
    };

    await installManagedProviderSecrets(snapshot, authSecret, relaySecret);

    expect(mocks.store.set).toHaveBeenCalledTimes(1);
    expect(mocks.store.set.mock.calls[0]).toHaveLength(1);
    const installedEncrypted = mocks.values.get('providerSecretsV2') as Record<string, unknown>;
    const installedPlain = mocks.values.get('providerSecrets') as Record<string, unknown>;
    const installedApiKeys = mocks.values.get('apiKeys') as Record<string, unknown>;
    expect(Object.keys(installedEncrypted).sort()).toEqual(['deepseek', 'openai', 'uclaw-auth']);
    expect(installedEncrypted.deepseek).toEqual(originalEncrypted.deepseek);
    expect(JSON.stringify(installedEncrypted)).not.toContain('next-access');
    expect(JSON.stringify(installedEncrypted)).not.toContain('next-relay');
    expect(installedPlain).toEqual({ moonshot: originalPlain.moonshot });
    expect(installedApiKeys).toEqual({ deepseek: 'keep-deepseek-key' });

    installedEncrypted.deepseek = { changedDuringTransaction: true };
    installedPlain.moonshot = { changedDuringTransaction: true };
    installedApiKeys.deepseek = 'changed-during-transaction';
    mocks.values.set('providerSecretsV2', installedEncrypted);
    mocks.values.set('providerSecrets', installedPlain);
    mocks.values.set('apiKeys', installedApiKeys);

    await restoreProviderSecretSlots(snapshot);

    expect(mocks.store.set).toHaveBeenCalledTimes(2);
    expect(mocks.values.get('providerSecretsV2')).toEqual({
      ...originalEncrypted,
      deepseek: { changedDuringTransaction: true },
    });
    expect(mocks.values.get('providerSecrets')).toEqual({
      ...originalPlain,
      moonshot: { changedDuringTransaction: true },
    });
    expect(mocks.values.get('apiKeys')).toEqual({
      ...originalApiKeys,
      deepseek: 'changed-during-transaction',
    });
  });

  it('rejects install when any target slot changed after the snapshot', async () => {
    mocks.values.set('providerSecretsV2', {});
    mocks.values.set('providerSecrets', {});
    mocks.values.set('apiKeys', { openai: 'before-secret' });
    const snapshot = await snapshotProviderSecretSlots(['openai', 'uclaw-auth']);
    mocks.values.set('apiKeys', { openai: 'concurrent-secret' });

    const error = await installManagedProviderSecrets(snapshot, {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'next-access',
      refreshToken: 'next-refresh',
      expiresAt: 456,
    }, {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'next-relay',
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Provider Secret targets changed after the transaction snapshot');
    expect((error as Error).message).not.toMatch(/before-secret|concurrent-secret|next-/);
    expect(mocks.store.set).not.toHaveBeenCalled();
    expect(mocks.values.get('apiKeys')).toEqual({ openai: 'concurrent-secret' });
  });

  it('restores only the applied generation and refuses a concurrent target change', async () => {
    mocks.values.set('providerSecretsV2', {});
    mocks.values.set('providerSecrets', {
      openai: { type: 'api_key', accountId: 'openai', apiKey: 'before-relay' },
    });
    mocks.values.set('apiKeys', {});
    const snapshot = await snapshotProviderSecretSlots(['openai', 'uclaw-auth']);
    await installManagedProviderSecrets(snapshot, {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'next-access',
      refreshToken: 'next-refresh',
      expiresAt: 456,
    }, {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'next-relay',
    });
    const encrypted = mocks.values.get('providerSecretsV2') as Record<string, unknown>;
    encrypted.openai = { encoding: 'electron-safe-storage-v1', ciphertext: 'concurrent-secret' };
    mocks.values.set('providerSecretsV2', encrypted);

    const error = await restoreProviderSecretSlots(snapshot).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Provider Secret targets changed after the managed install');
    expect((error as Error).message).not.toMatch(/before-relay|next-|concurrent-secret/);
    expect((mocks.values.get('providerSecretsV2') as Record<string, unknown>).openai).toEqual({
      encoding: 'electron-safe-storage-v1',
      ciphertext: 'concurrent-secret',
    });
  });
});
