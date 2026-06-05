import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSecret } from '../../electron/shared/providers/types';

const memoryStore = new Map<string, unknown>();

vi.mock('@electron/services/providers/store-instance', () => ({
  getClawXProviderStore: vi.fn(async () => ({
    get: (key: string) => memoryStore.get(key),
    set: (key: string, value: unknown) => memoryStore.set(key, value),
  })),
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')),
  },
}));

describe('ElectronStoreSecretStore', () => {
  beforeEach(() => {
    memoryStore.clear();
    memoryStore.set('apiKeys', {});
    memoryStore.set('providerSecrets', {});
    memoryStore.set('providerSecretsV2', {});
  });

  it('stores provider secrets with safeStorage encryption and clears legacy plaintext slots', async () => {
    const { ElectronStoreSecretStore } = await import('@electron/services/secrets/secret-store');
    const store = new ElectronStoreSecretStore();
    const secret: ProviderSecret = {
      type: 'api_key',
      accountId: 'junfeiai',
      apiKey: 'relay-token',
    };

    await store.set(secret);

    expect(memoryStore.get('apiKeys')).toEqual({});
    expect(memoryStore.get('providerSecrets')).toEqual({});
    const encrypted = memoryStore.get('providerSecretsV2') as Record<string, { ciphertext: string }>;
    expect(encrypted.junfeiai.ciphertext).not.toContain('relay-token');
    await expect(store.get('junfeiai')).resolves.toEqual(secret);
  });

  it('migrates legacy apiKeys to the encrypted secret store when read', async () => {
    const { ElectronStoreSecretStore } = await import('@electron/services/secrets/secret-store');
    const store = new ElectronStoreSecretStore();
    memoryStore.set('apiKeys', { junfeiai: 'legacy-token' });

    await expect(store.get('junfeiai')).resolves.toEqual({
      type: 'api_key',
      accountId: 'junfeiai',
      apiKey: 'legacy-token',
    });

    expect(memoryStore.get('apiKeys')).toEqual({});
    const encrypted = memoryStore.get('providerSecretsV2') as Record<string, { ciphertext: string }>;
    expect(encrypted.junfeiai.ciphertext).not.toContain('legacy-token');
  });
});
