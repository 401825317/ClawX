import { safeStorage } from 'electron';
import type { ProviderSecret } from '../../shared/providers/types';
import { getClawXProviderStore } from '../providers/store-instance';

export interface SecretStore {
  get(accountId: string): Promise<ProviderSecret | null>;
  set(secret: ProviderSecret): Promise<void>;
  delete(accountId: string): Promise<void>;
}

type EncryptedProviderSecret = {
  encoding: 'electron-safe-storage-v1';
  ciphertext: string;
};

const LOCAL_FILE_SECRET_ACCOUNT_IDS = new Set([
  'lingzhiwuxian',
  'lingzhiwuxian-auth',
]);

function usesLocalFileSecretStorage(accountId: string): boolean {
  return LOCAL_FILE_SECRET_ACCOUNT_IDS.has(accountId);
}

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

  const plaintext = JSON.stringify(secret);
  const encrypted = safeStorage.encryptString(plaintext);
  return {
    encoding: 'electron-safe-storage-v1',
    ciphertext: encrypted.toString('base64'),
  };
}

function decryptSecret(stored: unknown): ProviderSecret | null {
  if (
    !stored
    || typeof stored !== 'object'
    || (stored as EncryptedProviderSecret).encoding !== 'electron-safe-storage-v1'
    || typeof (stored as EncryptedProviderSecret).ciphertext !== 'string'
  ) {
    return null;
  }

  if (!canEncryptSecrets()) {
    return null;
  }

  try {
    const encrypted = Buffer.from((stored as EncryptedProviderSecret).ciphertext, 'base64');
    return JSON.parse(safeStorage.decryptString(encrypted)) as ProviderSecret;
  } catch {
    return null;
  }
}

export class ElectronStoreSecretStore implements SecretStore {
  async get(accountId: string): Promise<ProviderSecret | null> {
    const store = await getClawXProviderStore();
    const encryptedSecrets = (store.get('providerSecretsV2') ?? {}) as Record<string, EncryptedProviderSecret>;
    const secrets = (store.get('providerSecrets') ?? {}) as Record<string, ProviderSecret>;
    const secret = secrets[accountId];
    if (usesLocalFileSecretStorage(accountId)) {
      if (secret) {
        return secret;
      }
      if (encryptedSecrets[accountId]) {
        delete encryptedSecrets[accountId];
        store.set('providerSecretsV2', encryptedSecrets);
      }
    } else {
      const encryptedSecret = decryptSecret(encryptedSecrets[accountId]);
      if (encryptedSecret) {
        return encryptedSecret;
      }

      if (secret) {
        await this.set(secret);
        return secret;
      }
    }

    if (secret) {
      return secret;
    }

    const apiKeys = (store.get('apiKeys') ?? {}) as Record<string, string>;
    const apiKey = apiKeys[accountId];
    if (!apiKey) {
      return null;
    }

    const secretFromApiKey: ProviderSecret = {
      type: 'api_key',
      accountId,
      apiKey,
    };
    await this.set(secretFromApiKey);
    return secretFromApiKey;
  }

  async set(secret: ProviderSecret): Promise<void> {
    const store = await getClawXProviderStore();
    const encryptedSecrets = (store.get('providerSecretsV2') ?? {}) as Record<string, EncryptedProviderSecret>;
    const secrets = (store.get('providerSecrets') ?? {}) as Record<string, ProviderSecret>;

    if (usesLocalFileSecretStorage(secret.accountId)) {
      secrets[secret.accountId] = secret;
      delete encryptedSecrets[secret.accountId];
    } else {
      const encryptedSecret = encryptSecret(secret);
      if (encryptedSecret) {
        encryptedSecrets[secret.accountId] = encryptedSecret;
        delete secrets[secret.accountId];
      } else {
        secrets[secret.accountId] = secret;
        delete encryptedSecrets[secret.accountId];
      }
    }

    store.set('providerSecretsV2', encryptedSecrets);
    store.set('providerSecrets', secrets);

    const apiKeys = (store.get('apiKeys') ?? {}) as Record<string, string>;
    delete apiKeys[secret.accountId];
    store.set('apiKeys', apiKeys);
  }

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

export async function getProviderSecret(accountId: string): Promise<ProviderSecret | null> {
  return getSecretStore().get(accountId);
}

export async function setProviderSecret(secret: ProviderSecret): Promise<void> {
  await getSecretStore().set(secret);
}

export async function deleteProviderSecret(accountId: string): Promise<void> {
  await getSecretStore().delete(accountId);
}
