import { safeStorage } from 'electron';
import type { ProviderSecret } from '../../shared/providers/types';
import { getClawXProviderStore } from '../providers/store-instance';

export interface SecretStore {
  get(accountId: string, options?: { migrate?: boolean }): Promise<ProviderSecret | null>;
  set(secret: ProviderSecret): Promise<void>;
  delete(accountId: string): Promise<void>;
}

type EncryptedProviderSecret = {
  encoding: 'electron-safe-storage-v1';
  ciphertext: string;
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

export class ElectronStoreSecretStore implements SecretStore {
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
      if (options.migrate !== false) await this.set(legacySecret);
      return legacySecret;
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
    if (options.migrate !== false) await this.set(secret);
    return secret;
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
