import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    encryptionAvailable: true,
    store: {
      get: vi.fn((key: string) => values.get(key)),
      set: vi.fn((key: string, value: unknown) => values.set(key, value)),
    },
  };
});

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    encryptString: (value: string) => Buffer.from(`protected:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^protected:/, ''),
  },
}));

vi.mock('@electron/services/providers/store-instance', () => ({
  getClawXProviderStore: async () => mocks.store,
}));

import { ElectronStoreSecretStore } from '@electron/services/secrets/secret-store';

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
});
