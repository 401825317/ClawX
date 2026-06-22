import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccount } from '@electron/shared/providers/types';

const mocks = vi.hoisted(() => ({
  getProviderAccount: vi.fn(),
  saveProviderAccount: vi.fn(),
  providerAccountToConfig: vi.fn(),
  setProviderSecret: vi.fn(),
  getProviderSecret: vi.fn(),
  deleteProviderSecret: vi.fn(),
  getDefaultProvider: vi.fn(),
  setDefaultProvider: vi.fn(),
  syncDefaultProviderToRuntime: vi.fn(),
  syncSavedProviderToRuntime: vi.fn(),
  removeProviderKeyFromOpenClaw: vi.fn(),
  getClawXProviderStore: vi.fn(),
  getJunFeiAIDevicePayload: vi.fn(),
  readJunFeiAIDeviceActivationState: vi.fn(),
  markJunFeiAIDeviceActivated: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('@electron/services/providers/provider-store', () => ({
  getProviderAccount: mocks.getProviderAccount,
  saveProviderAccount: mocks.saveProviderAccount,
  providerAccountToConfig: mocks.providerAccountToConfig,
}));

vi.mock('@electron/services/providers/store-instance', () => ({
  getClawXProviderStore: mocks.getClawXProviderStore,
}));

vi.mock('@electron/services/secrets/secret-store', () => ({
  setProviderSecret: mocks.setProviderSecret,
  getProviderSecret: mocks.getProviderSecret,
  deleteProviderSecret: mocks.deleteProviderSecret,
}));

vi.mock('@electron/utils/secure-storage', () => ({
  getDefaultProvider: mocks.getDefaultProvider,
  setDefaultProvider: mocks.setDefaultProvider,
}));

vi.mock('@electron/services/providers/provider-runtime-sync', () => ({
  syncDefaultProviderToRuntime: mocks.syncDefaultProviderToRuntime,
  syncSavedProviderToRuntime: mocks.syncSavedProviderToRuntime,
}));

vi.mock('@electron/utils/openclaw-auth', () => ({
  removeProviderKeyFromOpenClaw: mocks.removeProviderKeyFromOpenClaw,
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.loggerWarn,
    error: vi.fn(),
  },
}));

vi.mock('@electron/utils/junfeiai-device', () => ({
  getJunFeiAIDevicePayload: mocks.getJunFeiAIDevicePayload,
  readJunFeiAIDeviceActivationState: mocks.readJunFeiAIDeviceActivationState,
  markJunFeiAIDeviceActivated: mocks.markJunFeiAIDeviceActivated,
}));

import {
  createJunFeiAITopupOrder,
  ensureJunFeiAIProviderSeeded,
  getJunFeiAILocalStatus,
  getJunFeiAITopupOrderStatus,
  getJunFeiAITopupOverview,
  loginJunFeiAI,
  logoutJunFeiAI,
  storeJunFeiAIRelayToken,
  verifyJunFeiAIAuth,
} from '@electron/services/junfeiai/junfeiai-service';

const memoryStore = new Map<string, unknown>();

function makeAccount(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: 'lingzhiwuxian',
    vendorId: 'lingzhiwuxian' as ProviderAccount['vendorId'],
    label: 'JunFeiAI',
    authMode: 'api_key',
    baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
    apiProtocol: 'openai-responses',
    model: 'gpt-5.5',
    enabled: true,
    isDefault: true,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('JunFeiAI managed provider service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VITE_DEV_SERVER_URL', '');
    vi.stubEnv('CLAWX_E2E', '');
    vi.stubEnv('CLAWX_MANAGED_PROVIDER', '1');
    vi.stubEnv('CLAWX_JUNFEIAI_ORIGIN', '');
    vi.stubEnv('CLAWX_JUNFEIAI_BACKEND_ORIGIN', '');
    vi.stubEnv('CLAWX_JUNFEIAI_PROVIDER_BASE_URL', '');
    vi.stubEnv('CLAWX_JUNFEIAI_BASE_URL', '');
    mocks.getProviderAccount.mockResolvedValue(null);
    mocks.saveProviderAccount.mockResolvedValue(undefined);
    mocks.providerAccountToConfig.mockImplementation((account: ProviderAccount) => ({
      id: account.id,
      name: account.label,
      type: account.vendorId,
      baseUrl: account.baseUrl,
      apiProtocol: account.apiProtocol,
      model: account.model,
      fallbackModels: account.fallbackModels,
      enabled: account.enabled,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    }));
    mocks.setProviderSecret.mockResolvedValue(undefined);
    mocks.getProviderSecret.mockResolvedValue(null);
    mocks.getDefaultProvider.mockResolvedValue(undefined);
    mocks.setDefaultProvider.mockResolvedValue(undefined);
    mocks.syncSavedProviderToRuntime.mockResolvedValue(undefined);
    mocks.syncDefaultProviderToRuntime.mockResolvedValue(undefined);
    mocks.removeProviderKeyFromOpenClaw.mockResolvedValue(undefined);
    mocks.getClawXProviderStore.mockResolvedValue({
      get: (key: string) => memoryStore.get(key),
      set: (key: string, value: unknown) => memoryStore.set(key, value),
    });
    mocks.getJunFeiAIDevicePayload.mockResolvedValue({
      id: 'device-1',
      name: 'DESKTOP',
      platform: 'win32',
      arch: 'x64',
      appVersion: '0.4.8',
    });
    mocks.readJunFeiAIDeviceActivationState.mockResolvedValue(null);
    mocks.markJunFeiAIDeviceActivated.mockResolvedValue(undefined);
    memoryStore.clear();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('seeds JunFeiAI account from bootstrap and sets it as default provider', async () => {
    const result = await ensureJunFeiAIProviderSeeded({
      bootstrap: {
        service: { displayName: 'JunFeiAI Managed', apiOrigin: 'https://zz-cn.lingzhiwuxian.com' },
        runtime: {
          baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1/',
          apiProtocol: 'openai-responses',
          defaultModel: 'gpt-5.5',
          fallbackModels: ['gpt-5.5-mini', 'gpt-5.5-mini'],
        },
      },
      syncRuntime: false,
    });

    expect(result.managed).toBe(true);
    expect(result.source).toBe('provided');
    expect(mocks.saveProviderAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'lingzhiwuxian',
        vendorId: 'lingzhiwuxian',
        label: 'JunFeiAI Managed',
        baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
        apiProtocol: 'openai-responses',
        model: 'gpt-5.5',
        fallbackModels: ['gpt-5.5-mini'],
      }),
    );
    expect(mocks.setDefaultProvider).toHaveBeenCalledWith('lingzhiwuxian');
    expect(mocks.syncSavedProviderToRuntime).not.toHaveBeenCalled();
  });

  it('does not use local device activation to bypass auth when no user is logged in', async () => {
    mocks.readJunFeiAIDeviceActivationState.mockResolvedValue({
      activated: true,
      onboardingCompleted: true,
      activatedAt: '2026-06-07T00:00:00.000Z',
      source: 'register',
    });

    const result = await ensureJunFeiAIProviderSeeded({
      bootstrap: {
        auth: {
          loginEnabled: true,
          registrationEnabled: true,
          activationRequired: true,
        },
        runtime: {
          baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1/',
          defaultModel: 'gpt-5.5',
        },
      },
      syncRuntime: false,
    });

    expect(result.deviceActivated).toBe(false);
    expect(result.activationRequired).toBe(true);
    expect(result.bootstrap.auth?.activationRequired).toBe(true);
  });

  it('uses local device activation only when it belongs to the logged-in user', async () => {
    mocks.readJunFeiAIDeviceActivationState.mockResolvedValue({
      activated: true,
      onboardingCompleted: true,
      activatedAt: '2026-06-07T00:00:00.000Z',
      lastSeenAt: '2026-06-07T00:00:00.000Z',
      source: 'register',
      userId: '7',
    });
    mocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'lingzhiwuxian-auth') {
        return {
          type: 'oauth',
          accountId: 'lingzhiwuxian-auth',
          accessToken: 'access',
          refreshToken: '',
          expiresAt: Date.now() + 60_000,
          subject: '7',
        };
      }
      if (accountId === 'lingzhiwuxian') {
        return {
          type: 'api_key',
          accountId: 'lingzhiwuxian',
          apiKey: 'relay',
          ownerUserId: '7',
        };
      }
      return null;
    });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      data: { id: 7, username: 'alice' },
    }), { status: 200 }));

    const result = await ensureJunFeiAIProviderSeeded({
      bootstrap: {
        auth: {
          loginEnabled: true,
          registrationEnabled: true,
          activationRequired: true,
        },
        runtime: {
          baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1/',
          defaultModel: 'gpt-5.5',
        },
      },
      syncRuntime: false,
    });

    expect(result.authValid).toBe(true);
    expect(result.deviceActivated).toBe(true);
    expect(result.activationRequired).toBe(false);
    expect(result.bootstrap.auth?.activationRequired).toBe(false);
  });

  it('does not mark a device activated merely because a stored login token is valid', async () => {
    mocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'lingzhiwuxian-auth') {
        return {
          type: 'oauth',
          accountId: 'lingzhiwuxian-auth',
          accessToken: 'access',
          refreshToken: '',
          expiresAt: Date.now() + 60_000,
          subject: '7',
        };
      }
      return null;
    });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      data: { id: 7, username: 'alice' },
    }), { status: 200 }));

    const result = await ensureJunFeiAIProviderSeeded({
      bootstrap: {
        auth: {
          loginEnabled: true,
          registrationEnabled: true,
          activationRequired: true,
        },
        runtime: { defaultModel: 'gpt-5.5' },
      },
      syncRuntime: false,
    });

    expect(result.authValid).toBe(true);
    expect(result.deviceActivated).toBe(false);
    expect(result.activationRequired).toBe(true);
    expect(mocks.markJunFeiAIDeviceActivated).not.toHaveBeenCalled();
  });

  it('does not read the relay secret while logged out', async () => {
    mocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'lingzhiwuxian-auth') {
        return null;
      }
      throw new Error(`unexpected secret read for ${accountId}`);
    });

    const result = await ensureJunFeiAIProviderSeeded({
      bootstrap: {
        auth: { activationRequired: false },
        runtime: { defaultModel: 'gpt-5.5' },
      },
      syncRuntime: false,
      syncRuntimeOnAuthChange: true,
    });

    expect(result.hasAuthToken).toBe(false);
    expect(result.authValid).toBe(false);
    expect(result.hasRelayToken).toBe(false);
    expect(mocks.getProviderSecret).toHaveBeenCalledWith('lingzhiwuxian-auth');
    expect(mocks.getProviderSecret).not.toHaveBeenCalledWith('lingzhiwuxian');
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lingzhiwuxian', type: 'lingzhiwuxian' }),
      '',
      undefined,
    );
  });

  it('supports separate auth backend and provider base URL in dev mode', async () => {
    vi.stubEnv('VITE_DEV_SERVER_URL', 'http://127.0.0.1:5173');
    vi.stubEnv('CLAWX_JUNFEIAI_BACKEND_ORIGIN', 'http://127.0.0.1:8080');
    vi.stubEnv('CLAWX_JUNFEIAI_PROVIDER_BASE_URL', 'http://127.0.0.1:18080/v1');
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      data: {
        service: { displayName: 'Local JunFeiAI' },
        runtime: {
          baseUrl: 'https://zz.lingzhiwuxian.com/v1',
          defaultModel: 'gpt-5.5',
        },
      },
    }), { status: 200 }));

    const result = await ensureJunFeiAIProviderSeeded({ syncRuntime: false });

    expect(result.source).toBe('remote');
    expect(result.bootstrap.runtime?.baseUrl).toBe('http://127.0.0.1:18080/v1');
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/api/clawx/bootstrap',
      expect.any(Object),
    );
    expect(mocks.saveProviderAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://127.0.0.1:18080/v1',
        metadata: expect.objectContaining({
          resourceUrl: 'http://127.0.0.1:8080',
        }),
      }),
    );
  });

  it('uses the production backend by default when the Vite dev server is running', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VITE_DEV_SERVER_URL', 'http://127.0.0.1:5173');
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      data: {
        service: { displayName: 'JunFeiAI Dev' },
        runtime: { defaultModel: 'gpt-5.5' },
      },
    }), { status: 200 }));

    await ensureJunFeiAIProviderSeeded({ syncRuntime: false });

    expect(fetch).toHaveBeenCalledWith(
      'https://zz-cn.lingzhiwuxian.com/api/clawx/bootstrap',
      expect.any(Object),
    );
    expect(mocks.saveProviderAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
        metadata: expect.objectContaining({
          resourceUrl: 'https://zz-cn.lingzhiwuxian.com',
        }),
      }),
    );
  });

  it('defaults to the production backend outside Vite development', async () => {
    vi.stubEnv('CLAWX_JUNFEIAI_BACKEND_ORIGIN', 'http://127.0.0.1:8080');
    vi.stubEnv('CLAWX_JUNFEIAI_PROVIDER_BASE_URL', 'http://127.0.0.1:18080/v1');
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      data: {
        service: { displayName: 'JunFeiAI Production' },
        runtime: { defaultModel: 'gpt-5.5' },
      },
    }), { status: 200 }));

    await ensureJunFeiAIProviderSeeded({ syncRuntime: false });

    expect(fetch).toHaveBeenCalledWith(
      'https://zz-cn.lingzhiwuxian.com/api/clawx/bootstrap',
      expect.any(Object),
    );
    expect(mocks.saveProviderAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
        metadata: expect.objectContaining({
          resourceUrl: 'https://zz-cn.lingzhiwuxian.com',
        }),
      }),
    );
  });

  it('stores relay token as provider secret for the logged-in user and syncs runtime auth', async () => {
    const existing = makeAccount();
    let relaySecret: unknown = null;
    mocks.getProviderAccount.mockResolvedValue(existing);
    mocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'lingzhiwuxian-auth') {
        return {
          type: 'oauth',
          accountId: 'lingzhiwuxian-auth',
          accessToken: 'access',
          refreshToken: '',
          expiresAt: Date.now() + 60_000,
          subject: '7',
        };
      }
      if (accountId === 'lingzhiwuxian') {
        return relaySecret;
      }
      return null;
    });
    mocks.setProviderSecret.mockImplementation(async (secret: unknown) => {
      if (
        secret
        && typeof secret === 'object'
        && 'accountId' in secret
        && secret.accountId === 'lingzhiwuxian'
      ) {
        relaySecret = secret;
      }
    });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      data: { id: 7, username: 'alice', email: 'alice@example.com' },
    }), { status: 200 }));

    const account = await storeJunFeiAIRelayToken('  relay-token  ', {
      runtime: {
        baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
        apiProtocol: 'openai-responses',
        defaultModel: 'gpt-5.5',
      },
    });

    expect(account.id).toBe('lingzhiwuxian');
    expect(mocks.setProviderSecret).toHaveBeenCalledWith({
      type: 'api_key',
      accountId: 'lingzhiwuxian',
      apiKey: 'relay-token',
      ownerUserId: '7',
      ownerUsername: 'alice',
      ownerEmail: 'alice@example.com',
    });
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lingzhiwuxian', type: 'lingzhiwuxian' }),
      'relay-token',
      undefined,
    );
    expect(mocks.syncDefaultProviderToRuntime).toHaveBeenCalledWith('lingzhiwuxian', undefined);
  });

  it('refreshes a stored relay key when it belongs to a different logged-in user', async () => {
    const existing = makeAccount();
    let relaySecret: unknown = {
      type: 'api_key',
      accountId: 'lingzhiwuxian',
      apiKey: 'old-user-relay',
      ownerUserId: '7',
      ownerUsername: 'alice',
    };
    mocks.getProviderAccount.mockResolvedValue(existing);
    mocks.getDefaultProvider.mockResolvedValue('lingzhiwuxian');
    mocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'lingzhiwuxian-auth') {
        return {
          type: 'oauth',
          accountId: 'lingzhiwuxian-auth',
          accessToken: 'access-bob',
          refreshToken: '',
          expiresAt: Date.now() + 60_000,
          subject: '8',
        };
      }
      if (accountId === 'lingzhiwuxian') {
        return relaySecret;
      }
      return null;
    });
    mocks.setProviderSecret.mockImplementation(async (secret: unknown) => {
      if (
        secret
        && typeof secret === 'object'
        && 'accountId' in secret
        && secret.accountId === 'lingzhiwuxian'
      ) {
        relaySecret = secret;
      }
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: 8, username: 'bob', email: 'bob@example.com' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { token: 'bob-relay', expiresIn: 3600 },
      }), { status: 200 }));

    const result = await ensureJunFeiAIProviderSeeded({
      bootstrap: {
        auth: { activationRequired: false },
        runtime: { defaultModel: 'gpt-5.5' },
      },
    });

    expect(result.hasRelayToken).toBe(true);
    expect(mocks.setProviderSecret).toHaveBeenCalledWith(expect.objectContaining({
      type: 'api_key',
      accountId: 'lingzhiwuxian',
      apiKey: 'bob-relay',
      ownerUserId: '8',
      ownerUsername: 'bob',
      ownerEmail: 'bob@example.com',
    }));
    expect(mocks.deleteProviderSecret).not.toHaveBeenCalledWith('lingzhiwuxian');
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lingzhiwuxian', type: 'lingzhiwuxian' }),
      'bob-relay',
      undefined,
    );
    expect(mocks.syncDefaultProviderToRuntime).not.toHaveBeenCalled();
  });

  it('syncs runtime during status checks when a fresh relay key is issued', async () => {
    const existing = makeAccount();
    let relaySecret: unknown = null;
    mocks.getProviderAccount.mockResolvedValue(existing);
    mocks.getDefaultProvider.mockResolvedValue('lingzhiwuxian');
    mocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'lingzhiwuxian-auth') {
        return {
          type: 'oauth',
          accountId: 'lingzhiwuxian-auth',
          accessToken: 'access',
          refreshToken: '',
          expiresAt: Date.now() + 60_000,
          subject: '7',
        };
      }
      if (accountId === 'lingzhiwuxian') {
        return relaySecret;
      }
      return null;
    });
    mocks.setProviderSecret.mockImplementation(async (secret: unknown) => {
      if (
        secret
        && typeof secret === 'object'
        && 'accountId' in secret
        && secret.accountId === 'lingzhiwuxian'
      ) {
        relaySecret = secret;
      }
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: 7, username: 'alice', email: 'alice@example.com' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { token: 'fresh-relay', expiresIn: 3600 },
      }), { status: 200 }));

    const result = await ensureJunFeiAIProviderSeeded({
      bootstrap: {
        auth: { activationRequired: false },
        runtime: { defaultModel: 'gpt-5.5' },
      },
      syncRuntime: false,
      syncRuntimeOnAuthChange: true,
    });

    expect(result.hasRelayToken).toBe(true);
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lingzhiwuxian', type: 'lingzhiwuxian' }),
      'fresh-relay',
      undefined,
    );
    expect(mocks.syncDefaultProviderToRuntime).not.toHaveBeenCalled();
  });

  it('refreshes an expired relay key for the same logged-in user', async () => {
    const existing = makeAccount();
    let relaySecret: unknown = {
      type: 'api_key',
      accountId: 'lingzhiwuxian',
      apiKey: 'expired-relay',
      ownerUserId: '7',
      expiresAt: Date.now() - 60_000,
    };
    mocks.getProviderAccount.mockResolvedValue(existing);
    mocks.getDefaultProvider.mockResolvedValue('lingzhiwuxian');
    mocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'lingzhiwuxian-auth') {
        return {
          type: 'oauth',
          accountId: 'lingzhiwuxian-auth',
          accessToken: 'access',
          refreshToken: '',
          expiresAt: Date.now() + 60_000,
          subject: '7',
        };
      }
      if (accountId === 'lingzhiwuxian') {
        return relaySecret;
      }
      return null;
    });
    mocks.setProviderSecret.mockImplementation(async (secret: unknown) => {
      if (
        secret
        && typeof secret === 'object'
        && 'accountId' in secret
        && secret.accountId === 'lingzhiwuxian'
      ) {
        relaySecret = secret;
      }
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: 7, username: 'alice', email: 'alice@example.com' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { token: 'fresh-relay', expiresIn: 3600 },
      }), { status: 200 }));

    const result = await ensureJunFeiAIProviderSeeded({
      bootstrap: {
        auth: { activationRequired: false },
        runtime: { defaultModel: 'gpt-5.5' },
      },
    });

    expect(result.hasRelayToken).toBe(true);
    expect(mocks.setProviderSecret).toHaveBeenCalledWith(expect.objectContaining({
      type: 'api_key',
      accountId: 'lingzhiwuxian',
      apiKey: 'fresh-relay',
      ownerUserId: '7',
      ownerEmail: 'alice@example.com',
      expiresAt: expect.any(Number),
    }));
    expect(mocks.deleteProviderSecret).not.toHaveBeenCalledWith('lingzhiwuxian');
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lingzhiwuxian', type: 'lingzhiwuxian' }),
      'fresh-relay',
      undefined,
    );
    expect(mocks.syncDefaultProviderToRuntime).not.toHaveBeenCalled();
  });

  it('clears a stored relay key while the logged-in device still requires activation', async () => {
    const existing = makeAccount();
    mocks.getProviderAccount.mockResolvedValue(existing);
    mocks.getDefaultProvider.mockResolvedValue('lingzhiwuxian');
    mocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'lingzhiwuxian-auth') {
        return {
          type: 'oauth',
          accountId: 'lingzhiwuxian-auth',
          accessToken: 'access',
          refreshToken: '',
          expiresAt: Date.now() + 60_000,
          subject: '7',
        };
      }
      if (accountId === 'lingzhiwuxian') {
        return {
          type: 'api_key',
          accountId: 'lingzhiwuxian',
          apiKey: 'relay-before-activation',
          ownerUserId: '7',
        };
      }
      return null;
    });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      data: { id: 7, username: 'alice' },
    }), { status: 200 }));

    const result = await ensureJunFeiAIProviderSeeded({
      bootstrap: {
        auth: { activationRequired: true },
        runtime: { defaultModel: 'gpt-5.5' },
      },
    });

    expect(result.authValid).toBe(true);
    expect(result.deviceActivated).toBe(false);
    expect(result.activationRequired).toBe(true);
    expect(result.hasRelayToken).toBe(false);
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('lingzhiwuxian');
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lingzhiwuxian', type: 'lingzhiwuxian' }),
      '',
      undefined,
    );
    expect(mocks.syncDefaultProviderToRuntime).not.toHaveBeenCalled();
  });

  it('clears auth and relay secrets when stored login is rejected', async () => {
    const existing = makeAccount();
    mocks.getProviderAccount.mockResolvedValue(existing);
    mocks.getDefaultProvider.mockResolvedValue('lingzhiwuxian');
    mocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'lingzhiwuxian-auth') {
        return {
          type: 'oauth',
          accountId: 'lingzhiwuxian-auth',
          accessToken: 'rejected-access',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 60_000,
          subject: '7',
        };
      }
      if (accountId === 'lingzhiwuxian') {
        return {
          type: 'api_key',
          accountId: 'lingzhiwuxian',
          apiKey: 'stale-relay',
          ownerUserId: '7',
        };
      }
      return null;
    });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ message: 'invalid token' }), { status: 401 }));
    memoryStore.set('junfeiaiVerificationCache', {
      verifiedAt: Date.now(),
      graceSeconds: 3600,
      payload: { valid: true },
    });

    const result = await ensureJunFeiAIProviderSeeded({
      bootstrap: {
        auth: { activationRequired: false },
        runtime: { defaultModel: 'gpt-5.5' },
      },
    });

    expect(result.authValid).toBe(false);
    expect(result.authRejected).toBe(true);
    expect(result.hasRelayToken).toBe(false);
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('lingzhiwuxian');
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('lingzhiwuxian-auth');
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lingzhiwuxian', type: 'lingzhiwuxian' }),
      '',
      undefined,
    );
    expect(mocks.syncDefaultProviderToRuntime).not.toHaveBeenCalled();
    expect(memoryStore.get('junfeiaiVerificationCache')).toBeNull();
  });

  it('syncs runtime during status checks when a stored login is rejected', async () => {
    const existing = makeAccount();
    mocks.getProviderAccount.mockResolvedValue(existing);
    mocks.getDefaultProvider.mockResolvedValue('lingzhiwuxian');
    mocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'lingzhiwuxian-auth') {
        return {
          type: 'oauth',
          accountId: 'lingzhiwuxian-auth',
          accessToken: 'rejected-access',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 60_000,
          subject: '7',
        };
      }
      if (accountId === 'lingzhiwuxian') {
        return {
          type: 'api_key',
          accountId: 'lingzhiwuxian',
          apiKey: 'stale-relay',
          ownerUserId: '7',
        };
      }
      return null;
    });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ message: 'invalid token' }), { status: 401 }));

    const result = await ensureJunFeiAIProviderSeeded({
      bootstrap: {
        auth: { activationRequired: false },
        runtime: { defaultModel: 'gpt-5.5' },
      },
      syncRuntime: false,
      syncRuntimeOnAuthChange: true,
    });

    expect(result.authRejected).toBe(true);
    expect(result.hasRelayToken).toBe(false);
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lingzhiwuxian', type: 'lingzhiwuxian' }),
      '',
      undefined,
    );
    expect(mocks.syncDefaultProviderToRuntime).not.toHaveBeenCalled();
  });

  it('does not sync runtime during a no-change background status check', async () => {
    const existing = makeAccount({
      label: '灵智无限',
      metadata: { resourceUrl: 'https://zz-cn.lingzhiwuxian.com' },
      fallbackModels: [],
    });
    mocks.getProviderAccount.mockResolvedValue(existing);
    mocks.getDefaultProvider.mockResolvedValue('lingzhiwuxian');
    mocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'lingzhiwuxian-auth') {
        return {
          type: 'oauth',
          accountId: 'lingzhiwuxian-auth',
          accessToken: 'access',
          refreshToken: '',
          expiresAt: Date.now() + 60_000,
          subject: '7',
        };
      }
      if (accountId === 'lingzhiwuxian') {
        return {
          type: 'api_key',
          accountId: 'lingzhiwuxian',
          apiKey: 'relay',
          ownerUserId: '7',
        };
      }
      return null;
    });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      data: { id: 7, username: 'alice' },
    }), { status: 200 }));

    const result = await ensureJunFeiAIProviderSeeded({
      bootstrap: {
        auth: { activationRequired: false },
        runtime: {
          baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
          apiProtocol: 'openai-responses',
          defaultModel: 'gpt-5.5',
        },
      },
      syncRuntime: false,
      syncRuntimeOnAuthChange: true,
    });

    expect(result.authValid).toBe(true);
    expect(result.hasRelayToken).toBe(true);
    expect(mocks.saveProviderAccount).not.toHaveBeenCalled();
    expect(mocks.setDefaultProvider).not.toHaveBeenCalled();
    expect(mocks.syncSavedProviderToRuntime).not.toHaveBeenCalled();
    expect(mocks.syncDefaultProviderToRuntime).not.toHaveBeenCalled();
  });

  it('builds local status without network verification', async () => {
    const existing = makeAccount();
    mocks.getProviderAccount.mockResolvedValue(existing);
    mocks.readJunFeiAIDeviceActivationState.mockResolvedValue({
      activated: true,
      onboardingCompleted: true,
      activatedAt: '2026-06-07T00:00:00.000Z',
      userId: '7',
    });
    mocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'lingzhiwuxian-auth') {
        return {
          type: 'oauth',
          accountId: 'lingzhiwuxian-auth',
          accessToken: 'access',
          refreshToken: '',
          expiresAt: Date.now() + 60_000,
          subject: '7',
          email: 'alice@example.com',
        };
      }
      if (accountId === 'lingzhiwuxian') {
        return {
          type: 'api_key',
          accountId: 'lingzhiwuxian',
          apiKey: 'relay',
          ownerUserId: '7',
        };
      }
      return null;
    });
    memoryStore.set('junfeiaiVerificationCache', {
      verifiedAt: Date.now(),
      graceSeconds: 3600,
      payload: {
        valid: true,
        user: { id: 7, email: 'alice@example.com' },
      },
    });

    const result = await getJunFeiAILocalStatus();

    expect(result).toMatchObject({
      managed: true,
      localOnly: true,
      source: 'local',
      hasAuthToken: true,
      hasRelayToken: true,
      authValid: true,
      deviceActivated: true,
      activationRequired: false,
      auth: {
        user: { id: 7, email: 'alice@example.com' },
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does nothing when managed provider mode is disabled', async () => {
    vi.stubEnv('CLAWX_MANAGED_PROVIDER', '0');

    const result = await ensureJunFeiAIProviderSeeded();

    expect(result.managed).toBe(false);
    expect(mocks.saveProviderAccount).not.toHaveBeenCalled();
    expect(mocks.setDefaultProvider).not.toHaveBeenCalled();
  });

  it('uses offline grace for transient verify failures after a successful verification', async () => {
    mocks.getProviderSecret.mockResolvedValue({
      type: 'oauth',
      accountId: 'lingzhiwuxian-auth',
      accessToken: 'access',
      refreshToken: '',
      expiresAt: Date.now() + 60_000,
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          valid: true,
          user: { email: 'user@example.com' },
          offline: { graceSeconds: 3600 },
        },
      }), { status: 200 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(verifyJunFeiAIAuth()).resolves.toMatchObject({ valid: true });
    await expect(verifyJunFeiAIAuth()).resolves.toMatchObject({ valid: true, offlineGrace: true });
  });

  it('does not use offline grace for explicit authorization rejections', async () => {
    memoryStore.set('junfeiaiVerificationCache', {
      verifiedAt: Date.now(),
      graceSeconds: 3600,
      payload: { valid: true },
    });
    mocks.getProviderSecret.mockResolvedValue({
      type: 'oauth',
      accountId: 'lingzhiwuxian-auth',
      accessToken: 'access',
      refreshToken: '',
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ message: 'device_revoked' }), { status: 403 }));

    await expect(verifyJunFeiAIAuth()).rejects.toThrow('device_revoked');
  });

  it('loads topup overview with the stored JunFeiAI login token', async () => {
    mocks.getProviderSecret.mockResolvedValue({
      type: 'oauth',
      accountId: 'lingzhiwuxian-auth',
      accessToken: 'access',
      refreshToken: '',
      expiresAt: Date.now() + 60_000,
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          methods: {
            alipay: {
              payment_type: 'alipay',
              currency: 'CNY',
              fee_rate: 0,
              daily_limit: 0,
              single_min: 1,
              single_max: 1000,
            },
          },
          global_min: 1,
          global_max: 1000,
          balance_disabled: false,
          balance_recharge_multiplier: 2,
          recharge_fee_rate: 0,
        },
      }), { status: 200 }));

    await expect(getJunFeiAITopupOverview()).resolves.toMatchObject({
      balance_recharge_multiplier: 2,
      methods: {
        alipay: expect.objectContaining({ payment_type: 'alipay' }),
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://zz-cn.lingzhiwuxian.com/api/clawx/billing/checkout-info',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer access' }),
      }),
    );
  });

  it('maps topup order and status calls to the Sub2API payment endpoints', async () => {
    mocks.getProviderSecret.mockResolvedValue({
      type: 'oauth',
      accountId: 'lingzhiwuxian-auth',
      accessToken: 'access',
      refreshToken: '',
      expiresAt: Date.now() + 60_000,
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          methods: { alipay: { payment_type: 'alipay', currency: 'CNY' } },
          topupInfo: { payg_credit_usd_per_cny: 2 },
          quotaPerUnit: 1,
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          order_id: 9,
          out_trade_no: 'T100',
          pay_url: 'https://pay.example',
          qr_code: 'qr-data',
          amount: 10,
          status: 'PENDING',
          payment_type: 'alipay',
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { status: 'COMPLETED', out_trade_no: 'T100', amount: 10 } }), { status: 200 }));

    await expect(createJunFeiAITopupOrder({
      money: '10',
      payMethod: 'epay',
      epayMethod: 'alipay',
      productId: 7,
    })).resolves.toMatchObject({
      trade_no: 'T100',
      pay_url: 'https://pay.example',
      qr_code: 'qr-data',
      credit_quota: 20,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://zz-cn.lingzhiwuxian.com/api/clawx/billing/orders',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer access' }),
        body: JSON.stringify({
          amount: 10,
          payment_type: 'alipay',
          order_type: 'balance',
          payment_source: 'clawx',
          is_mobile: false,
        }),
      }),
    );

    await expect(getJunFeiAITopupOrderStatus({ tradeNo: 'T100', sync: true })).resolves.toMatchObject({
      status: 'success',
      trade_no: 'T100',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://zz-cn.lingzhiwuxian.com/api/clawx/billing/orders/verify',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer access' }),
        body: JSON.stringify({
          out_trade_no: 'T100',
        }),
      }),
    );
  });

  it('refreshes expired JunFeiAI auth token before creating a topup order', async () => {
    mocks.getProviderSecret.mockResolvedValue({
      type: 'oauth',
      accountId: 'lingzhiwuxian-auth',
      accessToken: 'expired-access',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() - 60_000,
      email: 'user@example.com',
      subject: '7',
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          methods: { alipay: { payment_type: 'alipay', currency: 'CNY' } },
          topupInfo: { payg_credit_usd_per_cny: 2 },
          quotaPerUnit: 1,
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          order_id: 9,
          out_trade_no: 'T200',
          pay_url: 'https://pay.example/refresh',
          qr_code: 'qr-data',
          amount: 10,
          status: 'PENDING',
          payment_type: 'alipay',
        },
      }), { status: 200 }));

    await expect(createJunFeiAITopupOrder({
      money: '10',
      payMethod: 'epay',
      epayMethod: 'alipay',
      productId: 7,
    })).resolves.toMatchObject({
      trade_no: 'T200',
      pay_url: 'https://pay.example/refresh',
      credit_quota: 20,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://zz-cn.lingzhiwuxian.com/api/clawx/auth/refresh',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ refresh_token: 'refresh-token' }),
      }),
    );
    expect(mocks.setProviderSecret).toHaveBeenCalledWith(expect.objectContaining({
      type: 'oauth',
      accountId: 'lingzhiwuxian-auth',
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://zz-cn.lingzhiwuxian.com/api/clawx/billing/orders',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer fresh-access' }),
      }),
    );
  });

  it('falls back to standard Sub2API auth and key routes when ClawX compat routes are missing', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          access_token: 'jwt-access',
          refresh_token: 'jwt-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
          user: { id: 7, email: 'user@example.com' },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { key: 'sk-runtime-key' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 7, email: 'user@example.com' } }), { status: 200 }));
    mocks.getProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === 'lingzhiwuxian-auth') {
        return {
          type: 'oauth',
          accountId: 'lingzhiwuxian-auth',
          accessToken: 'jwt-access',
          refreshToken: 'jwt-refresh',
          expiresAt: Date.now() + 60_000,
        };
      }
      if (accountId === 'lingzhiwuxian') {
        return { type: 'api_key', accountId: 'lingzhiwuxian', apiKey: 'sk-runtime-key' };
      }
      return null;
    });

    await expect(loginJunFeiAI({
      account: 'user@example.com',
      email: 'user@example.com',
      password: 'password',
    })).resolves.toMatchObject({
      managed: true,
      hasRelayToken: true,
      authValid: true,
      auth: {
        user: { email: 'user@example.com' },
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://zz-cn.lingzhiwuxian.com/api/v1/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: 'user@example.com',
          password: 'password',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://zz-cn.lingzhiwuxian.com/api/v1/keys',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-access' }),
        body: JSON.stringify({ name: 'UClaw device-1' }),
      }),
    );
    expect(mocks.setProviderSecret).toHaveBeenCalledWith(expect.objectContaining({
      type: 'oauth',
      accountId: 'lingzhiwuxian-auth',
      accessToken: 'jwt-access',
      refreshToken: 'jwt-refresh',
    }));
    expect(mocks.setProviderSecret).toHaveBeenCalledWith(expect.objectContaining({
      type: 'api_key',
      accountId: 'lingzhiwuxian',
      apiKey: 'sk-runtime-key',
      ownerUserId: '7',
    }));
    expect(mocks.markJunFeiAIDeviceActivated).toHaveBeenCalledWith('login', expect.objectContaining({
      id: '7',
      email: 'user@example.com',
    }));
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lingzhiwuxian', type: 'lingzhiwuxian' }),
      'sk-runtime-key',
      undefined,
    );
  });

  it('revokes refresh token on logout and clears local JunFeiAI secrets', async () => {
    mocks.getProviderSecret.mockResolvedValue({
      type: 'oauth',
      accountId: 'lingzhiwuxian-auth',
      accessToken: 'access',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      data: { message: 'Logged out successfully' },
    }), { status: 200 }));

    memoryStore.set('junfeiaiVerificationCache', {
      verifiedAt: Date.now(),
      graceSeconds: 3600,
      payload: { valid: true },
    });

    const gatewayManager = {
      stop: vi.fn().mockResolvedValue(undefined),
    };

    await logoutJunFeiAI(gatewayManager as never);

    expect(fetch).toHaveBeenCalledWith(
      'https://zz-cn.lingzhiwuxian.com/api/clawx/auth/logout',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ refresh_token: 'refresh-token' }),
      }),
    );
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('lingzhiwuxian-auth');
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('lingzhiwuxian');
    expect(mocks.removeProviderKeyFromOpenClaw).toHaveBeenCalledWith('lingzhiwuxian');
    expect(gatewayManager.stop).toHaveBeenCalled();
    expect(memoryStore.get('junfeiaiVerificationCache')).toBeNull();
  });
});
