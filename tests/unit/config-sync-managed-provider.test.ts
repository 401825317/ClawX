// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const providerMocks = vi.hoisted(() => ({
  getProviderAccount: vi.fn(),
  getProviderSecret: vi.fn(),
  withProviderMutationLock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getVersion: () => '0.0.0-test',
    isPackaged: true,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
  },
}));

vi.mock('@electron/services/providers/provider-store', () => ({
  getProviderAccount: providerMocks.getProviderAccount,
}));

vi.mock('@electron/services/secrets/secret-store', () => ({
  getProviderSecret: providerMocks.getProviderSecret,
}));

vi.mock('@electron/services/providers/provider-mutation-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@electron/services/providers/provider-mutation-lock')>();
  return {
    ...actual,
    withProviderMutationLock: providerMocks.withProviderMutationLock,
  };
});

import {
  loadManagedOpenAiProviderEnv,
} from '@electron/gateway/config-sync';
import {
  UCLAW_LOGIN_REQUIRED_PROVIDER_KEY,
} from '@electron/gateway/config-sync-env';
import {
  UCLAW_DEFAULT_API_PROTOCOL,
  UCLAW_MANAGED_PROVIDER_BASE_URL,
  UCLAW_RUNTIME_CONTRACT_VERSION,
} from '@shared/junfeiai-endpoints';

const managedAccount = {
  id: 'openai',
  vendorId: 'openai',
  label: 'UClaw',
  authMode: 'api_key',
  baseUrl: UCLAW_MANAGED_PROVIDER_BASE_URL,
  apiProtocol: UCLAW_DEFAULT_API_PROTOCOL,
  model: 'smart-latest',
  fallbackModels: [],
  fallbackAccountIds: [],
  enabled: true,
  isDefault: true,
  metadata: {
    managedBy: 'uclaw',
    customModels: ['smart-latest'],
    managedDefaultModel: 'smart-latest',
    managedAllowedModels: ['smart-latest'],
    managedRuntimeContractVersion: UCLAW_RUNTIME_CONTRACT_VERSION,
  },
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
};

const managedCompatibilityAccount = {
  ...managedAccount,
  id: 'lingzhiwuxian',
  vendorId: 'lingzhiwuxian',
  isDefault: false,
};

describe('loadManagedOpenAiProviderEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerMocks.withProviderMutationLock.mockImplementation(
      (task: () => Promise<unknown>) => task(),
    );
    providerMocks.getProviderAccount.mockImplementation(async (accountId: string) => (
      accountId === 'lingzhiwuxian' ? managedCompatibilityAccount : managedAccount
    ));
  });

  it('loads the Relay Token for canonical auth even when no refresh token was issued', async () => {
    providerMocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'uclaw-auth') {
        return {
          type: 'oauth',
          accountId: 'uclaw-auth',
          accessToken: 'current-access-token',
          refreshToken: '',
          expiresAt: Date.now() + 60_000,
          subject: 'user-1',
          email: 'user@example.com',
        };
      }
      return {
        type: 'api_key',
        accountId,
        apiKey: 'current-relay-token',
        ownerUserId: 'user-1',
        ownerEmail: 'user@example.com',
        expiresAt: Date.now() + 60_000,
      };
    });

    await expect(loadManagedOpenAiProviderEnv()).resolves.toEqual({
      providerEnv: {
        CODEX_API_KEY: 'current-relay-token',
        OPENAI_API_KEY: 'current-relay-token',
        OPENAI_API_KEYS: 'current-relay-token',
        OPENCLAW_LIVE_OPENAI_KEY: 'current-relay-token',
      },
      loadedProviderKeyCount: 1,
    });
    expect(providerMocks.withProviderMutationLock).toHaveBeenCalledOnce();
    expect(providerMocks.getProviderAccount).toHaveBeenCalledWith('openai');
    expect(providerMocks.getProviderAccount).toHaveBeenCalledWith('lingzhiwuxian');
    expect(providerMocks.getProviderSecret).toHaveBeenCalledWith('uclaw-auth', { migrate: false });
    expect(providerMocks.getProviderSecret).toHaveBeenCalledWith('openai', { migrate: false });
    expect(providerMocks.getProviderSecret).toHaveBeenCalledWith('lingzhiwuxian', { migrate: false });
  });

  it('does not read a Secret when the canonical account is not managed by UClaw', async () => {
    providerMocks.getProviderAccount.mockImplementation(async (accountId: string) => (
      accountId === 'openai'
        ? { ...managedAccount, metadata: undefined }
        : managedCompatibilityAccount
    ));

    await expect(loadManagedOpenAiProviderEnv()).resolves.toEqual({
      providerEnv: {
        CODEX_API_KEY: UCLAW_LOGIN_REQUIRED_PROVIDER_KEY,
        OPENAI_API_KEY: UCLAW_LOGIN_REQUIRED_PROVIDER_KEY,
        OPENAI_API_KEYS: UCLAW_LOGIN_REQUIRED_PROVIDER_KEY,
        OPENCLAW_LIVE_OPENAI_KEY: UCLAW_LOGIN_REQUIRED_PROVIDER_KEY,
      },
      loadedProviderKeyCount: 0,
    });
    expect(providerMocks.getProviderSecret).not.toHaveBeenCalled();
  });

  it.each([
    ['id', { ...managedCompatibilityAccount, id: 'compatibility-alias' }],
    ['vendorId', { ...managedCompatibilityAccount, vendorId: 'openai' }],
    ['managedBy metadata', { ...managedCompatibilityAccount, metadata: undefined }],
  ])('fails closed when the compatibility account has an invalid %s', async (_field, account) => {
    providerMocks.getProviderAccount.mockImplementation(async (accountId: string) => (
      accountId === 'lingzhiwuxian' ? account : managedAccount
    ));

    const result = await loadManagedOpenAiProviderEnv();

    expect(result.providerEnv.OPENAI_API_KEY).toBe(UCLAW_LOGIN_REQUIRED_PROVIDER_KEY);
    expect(result.loadedProviderKeyCount).toBe(0);
  });

  it.each([
    ['auth mode', { ...managedCompatibilityAccount, authMode: 'oauth_device' }],
    ['enabled state', { ...managedCompatibilityAccount, enabled: false }],
    ['Relay base URL', { ...managedCompatibilityAccount, baseUrl: 'https://wrong.example.test/v1' }],
    ['API protocol', { ...managedCompatibilityAccount, apiProtocol: 'openai-completions' }],
    ['default role', { ...managedCompatibilityAccount, isDefault: true }],
    ['fallback models', { ...managedCompatibilityAccount, fallbackModels: ['other-model'] }],
    ['runtime contract version', {
      ...managedCompatibilityAccount,
      metadata: {
        ...managedCompatibilityAccount.metadata,
        managedRuntimeContractVersion: UCLAW_RUNTIME_CONTRACT_VERSION + 1,
      },
    }],
  ])('fails closed when the compatibility account has an invalid %s contract', async (_field, account) => {
    providerMocks.getProviderAccount.mockImplementation(async (accountId: string) => (
      accountId === 'lingzhiwuxian' ? account : managedAccount
    ));

    const result = await loadManagedOpenAiProviderEnv();

    expect(result.providerEnv.OPENAI_API_KEY).toBe(UCLAW_LOGIN_REQUIRED_PROVIDER_KEY);
    expect(result.loadedProviderKeyCount).toBe(0);
  });

  it('fails closed when the two managed accounts contain different model policies', async () => {
    const compatibilityAccount = {
      ...managedCompatibilityAccount,
      model: 'reasoning-pro',
      metadata: {
        ...managedCompatibilityAccount.metadata,
        customModels: ['reasoning-pro'],
        managedDefaultModel: 'reasoning-pro',
        managedAllowedModels: ['reasoning-pro'],
      },
    };
    providerMocks.getProviderAccount.mockImplementation(async (accountId: string) => (
      accountId === 'lingzhiwuxian' ? compatibilityAccount : managedAccount
    ));

    const result = await loadManagedOpenAiProviderEnv();

    expect(result.providerEnv.OPENAI_API_KEY).toBe(UCLAW_LOGIN_REQUIRED_PROVIDER_KEY);
    expect(result.loadedProviderKeyCount).toBe(0);
  });

  it('fails closed when the compatibility account is missing', async () => {
    providerMocks.getProviderAccount.mockImplementation(async (accountId: string) => (
      accountId === 'lingzhiwuxian' ? null : managedAccount
    ));

    const result = await loadManagedOpenAiProviderEnv();

    expect(result.providerEnv.OPENAI_API_KEY).toBe(UCLAW_LOGIN_REQUIRED_PROVIDER_KEY);
    expect(result.loadedProviderKeyCount).toBe(0);
  });

  it('rejects a Secret that belongs to another account', async () => {
    providerMocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'uclaw-auth') {
        return {
          type: 'oauth',
          accountId: 'uclaw-auth',
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 60_000,
          subject: 'user-1',
        };
      }
      return {
        type: 'api_key',
        accountId: 'legacy-openai',
        apiKey: 'stale-token',
        ownerUserId: 'user-1',
      };
    });

    await expect(loadManagedOpenAiProviderEnv()).resolves.toEqual({
      providerEnv: {
        CODEX_API_KEY: UCLAW_LOGIN_REQUIRED_PROVIDER_KEY,
        OPENAI_API_KEY: UCLAW_LOGIN_REQUIRED_PROVIDER_KEY,
        OPENAI_API_KEYS: UCLAW_LOGIN_REQUIRED_PROVIDER_KEY,
        OPENCLAW_LIVE_OPENAI_KEY: UCLAW_LOGIN_REQUIRED_PROVIDER_KEY,
      },
      loadedProviderKeyCount: 0,
    });
  });

  it('rejects a Relay Token owned by another authenticated user', async () => {
    providerMocks.getProviderSecret.mockImplementation(async (accountId: string) => (
      accountId === 'uclaw-auth'
        ? {
            type: 'oauth',
            accountId: 'uclaw-auth',
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresAt: Date.now() + 60_000,
            subject: 'current-user',
          }
        : {
            type: 'api_key',
            accountId,
            apiKey: 'other-user-relay',
            ownerUserId: 'other-user',
            expiresAt: Date.now() + 60_000,
          }
    ));

    const result = await loadManagedOpenAiProviderEnv();

    expect(result.providerEnv.OPENAI_API_KEY).toBe(UCLAW_LOGIN_REQUIRED_PROVIDER_KEY);
    expect(result.loadedProviderKeyCount).toBe(0);
  });

  it('rejects an expired Relay Token', async () => {
    providerMocks.getProviderSecret.mockImplementation(async (accountId: string) => (
      accountId === 'uclaw-auth'
        ? {
            type: 'oauth',
            accountId: 'uclaw-auth',
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresAt: Date.now() + 60_000,
            email: 'user@example.com',
          }
        : {
            type: 'api_key',
            accountId,
            apiKey: 'expired-relay',
            ownerEmail: 'USER@example.com',
            expiresAt: Date.now() - 1,
          }
    ));

    const result = await loadManagedOpenAiProviderEnv();

    expect(result.providerEnv.OPENAI_API_KEY).toBe(UCLAW_LOGIN_REQUIRED_PROVIDER_KEY);
    expect(result.loadedProviderKeyCount).toBe(0);
  });

  it('rejects a Relay Token when the canonical OAuth Secret is missing', async () => {
    providerMocks.getProviderSecret.mockImplementation(async (accountId: string) => (
      accountId === 'uclaw-auth'
        ? null
        : {
            type: 'api_key',
            accountId,
            apiKey: 'orphaned-relay',
            ownerUserId: 'user-1',
            expiresAt: Date.now() + 60_000,
          }
    ));

    const result = await loadManagedOpenAiProviderEnv();

    expect(result.providerEnv.OPENAI_API_KEY).toBe(UCLAW_LOGIN_REQUIRED_PROVIDER_KEY);
    expect(result.loadedProviderKeyCount).toBe(0);
  });

  it('fails closed when the compatibility Relay Secret is missing', async () => {
    providerMocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'uclaw-auth') {
        return {
          type: 'oauth',
          accountId: 'uclaw-auth',
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 60_000,
          subject: 'user-1',
        };
      }
      if (accountId === 'lingzhiwuxian') return null;
      return {
        type: 'api_key',
        accountId: 'openai',
        apiKey: 'canonical-relay',
        ownerUserId: 'user-1',
        expiresAt: Date.now() + 60_000,
      };
    });

    const result = await loadManagedOpenAiProviderEnv();

    expect(result.providerEnv.OPENAI_API_KEY).toBe(UCLAW_LOGIN_REQUIRED_PROVIDER_KEY);
    expect(result.loadedProviderKeyCount).toBe(0);
  });

  it('fails closed when the compatibility Relay Token diverges from the canonical token', async () => {
    providerMocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'uclaw-auth') {
        return {
          type: 'oauth',
          accountId: 'uclaw-auth',
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 60_000,
          subject: 'user-1',
        };
      }
      return {
        type: 'api_key',
        accountId,
        apiKey: accountId === 'openai' ? 'canonical-relay' : 'divergent-relay',
        ownerUserId: 'user-1',
        expiresAt: Date.now() + 60_000,
      };
    });

    const result = await loadManagedOpenAiProviderEnv();

    expect(result.providerEnv.OPENAI_API_KEY).toBe(UCLAW_LOGIN_REQUIRED_PROVIDER_KEY);
    expect(result.loadedProviderKeyCount).toBe(0);
  });
});
