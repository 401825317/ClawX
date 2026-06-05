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
  getClawXProviderStore: vi.fn(),
  getJunFeiAIDevicePayload: vi.fn(),
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
}));

import {
  ensureJunFeiAIProviderSeeded,
  storeJunFeiAIRelayToken,
  verifyJunFeiAIAuth,
} from '@electron/services/junfeiai/junfeiai-service';

const memoryStore = new Map<string, unknown>();

function makeAccount(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: 'junfeiai',
    vendorId: 'junfeiai' as ProviderAccount['vendorId'],
    label: 'JunFeiAI',
    authMode: 'api_key',
    baseUrl: 'https://junfeiai.com/v1',
    apiProtocol: 'anthropic-messages',
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
    vi.stubEnv('CLAWX_E2E', '');
    vi.stubEnv('CLAWX_MANAGED_PROVIDER', '1');
    vi.stubEnv('CLAWX_JUNFEIAI_ORIGIN', 'https://junfeiai.com');
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
    memoryStore.clear();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('seeds JunFeiAI account from bootstrap and sets it as default provider', async () => {
    const result = await ensureJunFeiAIProviderSeeded({
      bootstrap: {
        service: { displayName: 'JunFeiAI Managed', apiOrigin: 'https://junfeiai.com' },
        runtime: {
          baseUrl: 'https://junfeiai.com/v1/',
          apiProtocol: 'anthropic-messages',
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
        id: 'junfeiai',
        vendorId: 'junfeiai',
        label: 'JunFeiAI Managed',
        baseUrl: 'https://junfeiai.com/v1',
        apiProtocol: 'anthropic-messages',
        model: 'gpt-5.5',
        fallbackModels: ['gpt-5.5-mini'],
      }),
    );
    expect(mocks.setDefaultProvider).toHaveBeenCalledWith('junfeiai');
    expect(mocks.syncSavedProviderToRuntime).not.toHaveBeenCalled();
  });

  it('stores relay token as provider secret and syncs runtime auth', async () => {
    const existing = makeAccount();
    mocks.getProviderAccount.mockResolvedValue(existing);
    mocks.getProviderSecret.mockResolvedValueOnce(null).mockResolvedValueOnce({ type: 'api_key', apiKey: 'relay' });

    const account = await storeJunFeiAIRelayToken('  relay-token  ', {
      runtime: {
        baseUrl: 'https://junfeiai.com/v1',
        apiProtocol: 'anthropic-messages',
        defaultModel: 'gpt-5.5',
      },
    });

    expect(account.id).toBe('junfeiai');
    expect(mocks.setProviderSecret).toHaveBeenCalledWith({
      type: 'api_key',
      accountId: 'junfeiai',
      apiKey: 'relay-token',
    });
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'junfeiai', type: 'junfeiai' }),
      'relay-token',
      undefined,
    );
    expect(mocks.syncDefaultProviderToRuntime).toHaveBeenCalledWith('junfeiai', undefined);
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
      accountId: 'junfeiai-auth',
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
      accountId: 'junfeiai-auth',
      accessToken: 'access',
      refreshToken: '',
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ message: 'device_revoked' }), { status: 403 }));

    await expect(verifyJunFeiAIAuth()).rejects.toThrow('device_revoked');
  });
});
