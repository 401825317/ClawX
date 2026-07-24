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

const managedAccount = {
  id: 'openai',
  vendorId: 'openai',
  label: 'UClaw',
  authMode: 'api_key',
  model: 'smart-latest',
  enabled: true,
  isDefault: true,
  metadata: { managedBy: 'uclaw' },
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
};

describe('loadManagedOpenAiProviderEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerMocks.withProviderMutationLock.mockImplementation(
      (task: () => Promise<unknown>) => task(),
    );
  });

  it('loads the Relay Token for canonical auth even when no refresh token was issued', async () => {
    providerMocks.getProviderAccount.mockResolvedValue(managedAccount);
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
        accountId: 'openai',
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
    expect(providerMocks.getProviderSecret).toHaveBeenCalledWith('uclaw-auth', { migrate: false });
    expect(providerMocks.getProviderSecret).toHaveBeenCalledWith('openai', { migrate: false });
  });

  it('does not read a Secret when the canonical account is not managed by UClaw', async () => {
    providerMocks.getProviderAccount.mockResolvedValue({
      ...managedAccount,
      metadata: undefined,
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
    expect(providerMocks.getProviderSecret).not.toHaveBeenCalled();
  });

  it('rejects a Secret that belongs to another account', async () => {
    providerMocks.getProviderAccount.mockResolvedValue(managedAccount);
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
    providerMocks.getProviderAccount.mockResolvedValue(managedAccount);
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
            accountId: 'openai',
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
    providerMocks.getProviderAccount.mockResolvedValue(managedAccount);
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
            accountId: 'openai',
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
    providerMocks.getProviderAccount.mockResolvedValue(managedAccount);
    providerMocks.getProviderSecret.mockImplementation(async (accountId: string) => (
      accountId === 'uclaw-auth'
        ? null
        : {
            type: 'api_key',
            accountId: 'openai',
            apiKey: 'orphaned-relay',
            ownerUserId: 'user-1',
            expiresAt: Date.now() + 60_000,
          }
    ));

    const result = await loadManagedOpenAiProviderEnv();

    expect(result.providerEnv.OPENAI_API_KEY).toBe(UCLAW_LOGIN_REQUIRED_PROVIDER_KEY);
    expect(result.loadedProviderKeyCount).toBe(0);
  });
});
