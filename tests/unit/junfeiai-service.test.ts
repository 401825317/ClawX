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
  createJunFeiAITopupOrder,
  ensureJunFeiAIProviderSeeded,
  getJunFeiAITopupOrderStatus,
  getJunFeiAITopupOverview,
  loginJunFeiAI,
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

  it('supports separate auth backend and provider base URL in dev mode', async () => {
    vi.stubEnv('CLAWX_JUNFEIAI_BACKEND_ORIGIN', 'http://127.0.0.1:8080');
    vi.stubEnv('CLAWX_JUNFEIAI_PROVIDER_BASE_URL', 'http://127.0.0.1:18080/v1');
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      data: {
        service: { displayName: 'Local JunFeiAI' },
        runtime: { defaultModel: 'gpt-5.5' },
      },
    }), { status: 200 }));

    const result = await ensureJunFeiAIProviderSeeded({ syncRuntime: false });

    expect(result.source).toBe('remote');
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

  it('loads topup overview with the stored JunFeiAI login token', async () => {
    mocks.getProviderSecret.mockResolvedValue({
      type: 'oauth',
      accountId: 'junfeiai-auth',
      accessToken: 'access',
      refreshToken: '',
      expiresAt: Date.now() + 60_000,
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 42, email: 'user@example.com', balance: 1234 } }), { status: 200 }))
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
      user: { id: 42, shrimp_quota: 1234 },
      quotaPerUnit: 1,
      topupInfo: {
        payg_current_quota: 1234,
        payg_credit_usd_per_cny: 2,
        enable_online_topup: true,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://junfeiai.com/api/v1/auth/me',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer access' }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://junfeiai.com/api/v1/payment/checkout-info',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer access' }),
      }),
    );
  });

  it('maps topup order and status calls to the Sub2API payment endpoints', async () => {
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
          methods: { alipay: { payment_type: 'alipay', currency: 'CNY' } },
          balance_recharge_multiplier: 2,
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
      'https://junfeiai.com/api/v1/payment/orders',
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
      'https://junfeiai.com/api/v1/payment/orders/verify',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer access' }),
        body: JSON.stringify({
          out_trade_no: 'T100',
        }),
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
      if (accountId === 'junfeiai-auth') {
        return {
          type: 'oauth',
          accountId: 'junfeiai-auth',
          accessToken: 'jwt-access',
          refreshToken: 'jwt-refresh',
          expiresAt: Date.now() + 60_000,
        };
      }
      if (accountId === 'junfeiai') {
        return { type: 'api_key', accountId: 'junfeiai', apiKey: 'sk-runtime-key' };
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
      'https://junfeiai.com/api/v1/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: 'user@example.com',
          password: 'password',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://junfeiai.com/api/v1/keys',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-access' }),
        body: JSON.stringify({ name: 'ClawX device-1' }),
      }),
    );
    expect(mocks.setProviderSecret).toHaveBeenCalledWith(expect.objectContaining({
      type: 'oauth',
      accountId: 'junfeiai-auth',
      accessToken: 'jwt-access',
      refreshToken: 'jwt-refresh',
    }));
    expect(mocks.setProviderSecret).toHaveBeenCalledWith({
      type: 'api_key',
      accountId: 'junfeiai',
      apiKey: 'sk-runtime-key',
    });
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'junfeiai', type: 'junfeiai' }),
      'sk-runtime-key',
      undefined,
    );
  });
});
