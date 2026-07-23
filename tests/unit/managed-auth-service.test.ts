import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayManager } from '@electron/gateway/manager';
import type {
  ProviderAccount,
  ProviderSecret,
} from '@electron/shared/providers/types';

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
  getManagedDevicePayload: vi.fn(),
  markManagedDeviceActivated: vi.fn(),
  readManagedDeviceActivationState: vi.fn(),
  deleteProviderSecret: vi.fn(),
  getProviderSecret: vi.fn(),
  setProviderSecret: vi.fn(),
  deleteProviderAccount: vi.fn(),
  getDefaultProviderAccountId: vi.fn(),
  getProviderAccount: vi.fn(),
  providerAccountToConfig: vi.fn(),
  saveProviderAccount: vi.fn(),
  setDefaultProviderAccount: vi.fn(),
  createAccount: vi.fn(),
  listAccounts: vi.fn(),
  updateAccount: vi.fn(),
  syncDefaultProviderToRuntime: vi.fn(),
  syncSavedProviderToRuntime: vi.fn(),
  removeProviderKeyFromOpenClaw: vi.fn(),
  updateAgentModelProvider: vi.fn(),
  readOpenClawConfig: vi.fn(),
  writeOpenClawConfig: vi.fn(),
  storeGet: vi.fn(),
  storeSet: vi.fn(),
  storeDelete: vi.fn(),
  ensureProviderStoreMigrated: vi.fn(),
  setDefaultAccount: vi.fn(),
  getDefaultProvider: vi.fn(),
  setDefaultProvider: vi.fn(),
}));

vi.mock('@electron/utils/junfeiai-distribution', () => ({
  UCLAW_ACCOUNT_ID: 'openai',
  UCLAW_AUTH_REQUEST_TIMEOUT_MS: 12_000,
  UCLAW_AUTH_ACCOUNT_ID: 'uclaw-auth',
  UCLAW_BOOTSTRAP_REQUEST_TIMEOUT_MS: 8_000,
  UCLAW_DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS: 86_400,
  UCLAW_DEFAULT_API_PROTOCOL: 'openai-responses',
  UCLAW_DEFAULT_BASE_URL: 'https://zz-cn.lingzhiwuxian.com/v1',
  UCLAW_DEFAULT_MODEL: 'smart-latest',
  UCLAW_DEFAULT_MODEL_CONTEXT_WINDOW: 258_000,
  UCLAW_DEFAULT_THINKING_LEVEL: 'medium',
  UCLAW_MANAGED_SERVICE_NAME: 'UClaw',
  UCLAW_OFFLINE_GRACE_SECONDS: 86_400,
  UCLAW_PROVIDER_ID: 'openai',
  UCLAW_RELAY_REQUEST_TIMEOUT_MS: 12_000,
  UCLAW_RUNTIME_CONTRACT_VERSION: 4,
  UCLAW_TOKEN_REFRESH_SKEW_SECONDS: 60,
  UCLAW_VERIFICATION_REQUEST_TIMEOUT_MS: 12_000,
  UCLAW_VERIFY_MEMORY_CACHE_SECONDS: 300,
  getUclawBackendOrigin: () => 'https://auth.test',
  isUclawManagedDistribution: () => true,
}));

vi.mock('@electron/utils/junfeiai-device', () => ({
  getManagedDevicePayload: mocks.getManagedDevicePayload,
  markManagedDeviceActivated: mocks.markManagedDeviceActivated,
  readManagedDeviceActivationState: mocks.readManagedDeviceActivationState,
}));

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

vi.mock('@electron/services/secrets/secret-store', () => ({
  deleteProviderSecret: mocks.deleteProviderSecret,
  getProviderSecret: mocks.getProviderSecret,
  setProviderSecret: mocks.setProviderSecret,
}));

vi.mock('@electron/services/providers/provider-store', () => ({
  deleteProviderAccount: mocks.deleteProviderAccount,
  getDefaultProviderAccountId: mocks.getDefaultProviderAccountId,
  getProviderAccount: mocks.getProviderAccount,
  providerAccountToConfig: mocks.providerAccountToConfig,
  saveProviderAccount: mocks.saveProviderAccount,
  setDefaultProviderAccount: mocks.setDefaultProviderAccount,
}));

vi.mock('@electron/services/providers/provider-service', () => ({
  getProviderService: () => ({
    createAccount: mocks.createAccount,
    listAccounts: mocks.listAccounts,
    updateAccount: mocks.updateAccount,
    setDefaultAccount: mocks.setDefaultAccount,
  }),
}));

vi.mock('@electron/services/providers/provider-migration', () => ({
  ensureProviderStoreMigrated: mocks.ensureProviderStoreMigrated,
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
  updateAgentModelProvider: mocks.updateAgentModelProvider,
}));

vi.mock('@electron/utils/channel-config', () => ({
  readOpenClawConfig: mocks.readOpenClawConfig,
  writeOpenClawConfig: mocks.writeOpenClawConfig,
}));

vi.mock('@electron/utils/config-mutex', () => ({
  withConfigLock: async (task: () => Promise<unknown>) => task(),
}));

vi.mock('@electron/services/providers/store-instance', () => ({
  getClawXProviderStore: async () => ({
    get: mocks.storeGet,
    set: mocks.storeSet,
    delete: mocks.storeDelete,
  }),
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  checkManagedAuthActivation,
  getManagedAuthLocalStatus,
  getManagedAuthStatus,
  loginManagedAuth,
  logoutManagedAuth,
  registerManagedAuth,
  refreshManagedAuth,
  sendManagedAuthVerificationCode,
} from '@electron/services/managed-auth-service';

type ActivationState = Awaited<ReturnType<typeof mocks.readManagedDeviceActivationState>>;

const DEVICE = {
  id: 'device-1',
  name: 'Test Mac',
  platform: 'darwin',
  arch: 'arm64',
  appVersion: '1.0.0',
};

let accountState: ProviderAccount | null;
let defaultAccountId: string | undefined;
let legacyDefaultProvider: string | undefined;
let activationState: ActivationState;
let verificationCache: unknown;
let secrets: Map<string, ProviderSecret>;
let openClawConfig: Record<string, unknown>;

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : status >= 500 ? 'Server Error' : 'Bad Request',
    json: vi.fn().mockResolvedValue(payload),
  };
}

function requestPath(input: unknown): string {
  return new URL(String(input)).pathname;
}

function requestBody(init: unknown): Record<string, unknown> {
  const body = (init as { body?: string } | undefined)?.body;
  return body ? JSON.parse(body) as Record<string, unknown> : {};
}

function createGateway(state: ReturnType<GatewayManager['getStatus']>['state']) {
  let currentState = state;
  return {
    getStatus: vi.fn(() => ({ state: currentState, port: 18_789 })),
    reload: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockImplementation(async () => {
      currentState = 'stopped';
    }),
  } as unknown as GatewayManager;
}

function installSuccessBackend() {
  mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
    switch (requestPath(input)) {
      case '/api/clawx/bootstrap':
        return jsonResponse(200, { auth: { activationRequired: false } });
      case '/api/clawx/login':
      case '/api/clawx/register':
        return jsonResponse(200, {
          accessToken: 'access-secret',
          refreshToken: 'refresh-secret',
          expiresIn: 3_600,
          user: { id: 'user-1', username: 'tester', email: 'test@example.com' },
        });
      case '/api/clawx/relay-token':
        return jsonResponse(200, { token: 'relay-secret', expiresIn: 3_600 });
      case '/api/clawx/auth/logout':
        return jsonResponse(200, { success: true });
      default:
        throw new Error(`Unexpected request: ${requestPath(input)}`);
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  accountState = null;
  defaultAccountId = undefined;
  legacyDefaultProvider = undefined;
  activationState = null;
  verificationCache = undefined;
  secrets = new Map<string, ProviderSecret>();
  openClawConfig = {};

  mocks.getManagedDevicePayload.mockResolvedValue(DEVICE);
  mocks.readManagedDeviceActivationState.mockImplementation(async () => activationState);
  mocks.markManagedDeviceActivated.mockImplementation(async (source, user) => {
    activationState = {
      version: 1,
      deviceId: DEVICE.id,
      activated: true,
      onboardingCompleted: true,
      activatedAt: '2026-07-23T00:00:00.000Z',
      lastSeenAt: '2026-07-23T00:00:00.000Z',
      source,
      userId: user?.id,
      username: user?.username,
      email: user?.email,
    };
  });

  mocks.getProviderSecret.mockImplementation(async (accountId: string) => secrets.get(accountId));
  mocks.setProviderSecret.mockImplementation(async (secret: ProviderSecret) => {
    secrets.set(secret.accountId, secret);
  });
  mocks.deleteProviderSecret.mockImplementation(async (accountId: string) => {
    secrets.delete(accountId);
  });
  mocks.getProviderAccount.mockImplementation(async () => accountState);
  mocks.saveProviderAccount.mockImplementation(async (account: ProviderAccount) => {
    accountState = account;
  });
  mocks.deleteProviderAccount.mockImplementation(async () => {
    accountState = null;
  });
  mocks.getDefaultProviderAccountId.mockImplementation(async () => defaultAccountId);
  mocks.setDefaultProviderAccount.mockImplementation(async (accountId: string) => {
    defaultAccountId = accountId;
  });
  mocks.ensureProviderStoreMigrated.mockResolvedValue(undefined);
  mocks.getDefaultProvider.mockImplementation(async () => legacyDefaultProvider);
  mocks.setDefaultProvider.mockImplementation(async (providerId: string) => {
    legacyDefaultProvider = providerId;
    defaultAccountId = providerId;
  });
  mocks.setDefaultAccount.mockImplementation(async (accountId: string) => {
    defaultAccountId = accountId;
    legacyDefaultProvider = accountId;
  });
  mocks.providerAccountToConfig.mockImplementation((account: ProviderAccount) => ({
    id: account.id,
    name: account.label,
    type: account.vendorId,
    enabled: account.enabled,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  }));
  mocks.createAccount.mockImplementation(async (account: ProviderAccount) => {
    accountState = account;
  });
  mocks.listAccounts.mockImplementation(async () => accountState ? [accountState] : []);
  mocks.updateAccount.mockImplementation(async (_accountId: string, account: ProviderAccount) => {
    accountState = account;
  });
  mocks.syncSavedProviderToRuntime.mockResolvedValue(undefined);
  mocks.syncDefaultProviderToRuntime.mockResolvedValue(undefined);
  mocks.removeProviderKeyFromOpenClaw.mockResolvedValue(undefined);
  mocks.updateAgentModelProvider.mockResolvedValue(undefined);
  mocks.readOpenClawConfig.mockImplementation(async () => structuredClone(openClawConfig));
  mocks.writeOpenClawConfig.mockImplementation(async (config: Record<string, unknown>) => {
    openClawConfig = structuredClone(config);
  });

  mocks.storeGet.mockImplementation(() => verificationCache);
  mocks.storeSet.mockImplementation((_key: string, value: unknown) => {
    verificationCache = value;
  });
  mocks.storeDelete.mockImplementation(() => {
    verificationCache = undefined;
  });

  installSuccessBackend();
});

describe('managed auth service transaction and compatibility behavior', () => {
  it('loads the remote registration policy before returning a logged-out status', async () => {
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/bootstrap') {
        return jsonResponse(200, {
          auth: {
            registrationEnabled: true,
            activationRequired: true,
          },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const status = await getManagedAuthStatus();

    expect(status).toEqual(expect.objectContaining({
      hasAuthToken: false,
      activationRequired: true,
      bootstrap: expect.objectContaining({
        auth: expect.objectContaining({ activationRequired: true }),
      }),
    }));
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves the optional activation policy when bootstrap disables it', async () => {
    const status = await getManagedAuthStatus();

    expect(status.activationRequired).toBe(false);
    expect(status.bootstrap.auth?.activationRequired).toBe(false);
  });

  it('commits a successful login to the managed OpenAI account', async () => {
    const result = await loginManagedAuth({
      account: 'test@example.com',
      password: 'password',
    });

    expect(result.success).toBe(true);
    expect(mocks.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'openai',
        vendorId: 'openai',
        label: 'UClaw',
        baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
        apiProtocol: 'openai-responses',
        model: 'smart-latest',
        metadata: expect.objectContaining({ managedBy: 'uclaw' }),
      }),
      'relay-secret',
    );
    expect(secrets.get('uclaw-auth')).toEqual(expect.objectContaining({
      type: 'oauth',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
    }));
    expect(secrets.get('openai')).toEqual(expect.objectContaining({
      type: 'api_key',
      apiKey: 'relay-secret',
      ownerUserId: 'user-1',
    }));
    expect(defaultAccountId).toBe('openai');
    expect(mocks.markManagedDeviceActivated).toHaveBeenCalledWith(
      'login',
      expect.objectContaining({ id: 'user-1' }),
    );
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.syncDefaultProviderToRuntime).toHaveBeenCalledTimes(1);
    expect(openClawConfig).toMatchObject({
      agents: {
        defaults: {
          thinkingDefault: 'medium',
          reasoningDefault: 'on',
        },
      },
      models: {
        providers: {
          openai: {
            models: [expect.objectContaining({
              id: 'smart-latest',
              contextWindow: 258_000,
              reasoning: true,
              compat: expect.objectContaining({ supportsReasoningEffort: true }),
            })],
          },
        },
      },
    });
    expect(mocks.updateAgentModelProvider).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({
        models: [expect.objectContaining({ id: 'smart-latest', contextWindow: 258_000 })],
      }),
    );
  });

  it('falls back only after a 404 and preserves device and activation fields', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown, init: unknown) => {
      const path = requestPath(input);
      calls.push({ path, body: requestBody(init) });
      if (path === '/api/clawx/activation/check') {
        return jsonResponse(200, { valid: true, activationTicket: 'activation-ticket-secret' });
      }
      if (path === '/api/clawx/login') return jsonResponse(404, { message: 'missing route' });
      if (path === '/api/v1/auth/login') {
        return jsonResponse(200, {
          access_token: 'fallback-access',
          refresh_token: 'fallback-refresh',
          user: { id: 'fallback-user' },
        });
      }
      if (path === '/api/clawx/relay-token') return jsonResponse(200, { token: 'fallback-relay' });
      throw new Error(`Unexpected request: ${path}`);
    });

    const result = await loginManagedAuth({
      account: 'fallback@example.com',
      password: 'password',
      activationCode: 'ACT-123',
      verifyCode: '9988',
      turnstileToken: 'turnstile-secret',
    });

    expect(result.success).toBe(true);
    const primary = calls.find((call) => call.path === '/api/clawx/login');
    const fallback = calls.find((call) => call.path === '/api/v1/auth/login');
    expect(primary).toBeDefined();
    expect(fallback?.body).toEqual(primary?.body);
    expect(fallback?.body).toEqual(expect.objectContaining({
      activationCode: 'ACT-123',
      activation_code: 'ACT-123',
      activationTicket: 'activation-ticket-secret',
      activation_ticket: 'activation-ticket-secret',
      verifyCode: '9988',
      verify_code: '9988',
      turnstileToken: 'turnstile-secret',
      turnstile_token: 'turnstile-secret',
      device: DEVICE,
    }));
  });

  it('does not use the fallback login route for non-404 failures', async () => {
    const paths: string[] = [];
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      paths.push(path);
      if (path === '/api/clawx/login') {
        return jsonResponse(500, { message: 'temporary failure' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' });

    expect(result).toEqual(expect.objectContaining({ success: false }));
    expect(paths).toEqual(['/api/clawx/login']);
    expect(mocks.createAccount).not.toHaveBeenCalled();
  });

  it('blocks authentication commit when activation validation fails', async () => {
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/activation/check') {
        return jsonResponse(200, { valid: false, errorCode: 'activation_used' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const result = await loginManagedAuth({
      account: 'test@example.com',
      password: 'password',
      activationCode: 'USED-CODE',
    });

    expect(result).toEqual({ success: false, errorCode: 'activation_used' });
    expect(mocks.createAccount).not.toHaveBeenCalled();
    expect(mocks.setProviderSecret).not.toHaveBeenCalled();
    expect(mocks.markManagedDeviceActivated).not.toHaveBeenCalled();
  });

  it('does not commit activation, provider, or secrets when relay acquisition fails', async () => {
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/login') {
        return jsonResponse(200, { accessToken: 'access-secret', refreshToken: 'refresh-secret' });
      }
      if (path === '/api/clawx/relay-token') {
        return jsonResponse(503, { message: 'relay unavailable' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' });

    expect(result).toEqual(expect.objectContaining({ success: false }));
    expect(mocks.createAccount).not.toHaveBeenCalled();
    expect(mocks.updateAccount).not.toHaveBeenCalled();
    expect(mocks.setProviderSecret).not.toHaveBeenCalled();
    expect(mocks.markManagedDeviceActivated).not.toHaveBeenCalled();
    expect(accountState).toBeNull();
    expect(secrets.size).toBe(0);
  });

  it('fails closed and removes the previous managed session after login is rejected', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'previous-access',
      refreshToken: 'previous-refresh',
      expiresAt: Date.now() + 60_000,
      subject: 'previous-user',
    });
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'previous-relay',
      ownerUserId: 'previous-user',
    });
    verificationCache = { verifiedAt: Date.now(), verifyAfter: Date.now(), expiresAt: Date.now() + 60_000 };
    mocks.proxyAwareFetch.mockResolvedValue(jsonResponse(401, {
      code: 'invalid_credentials',
      message: 'Invalid credentials',
    }));
    const gateway = createGateway('running');

    const result = await loginManagedAuth(
      { account: 'test@example.com', password: 'wrong-password' },
      gateway,
    );

    expect(result.success).toBe(false);
    expect(secrets.has('uclaw-auth')).toBe(false);
    expect(secrets.has('openai')).toBe(false);
    expect(verificationCache).toBeUndefined();
    expect(mocks.removeProviderKeyFromOpenClaw).toHaveBeenCalledWith('openai');
    expect(gateway.reload).toHaveBeenCalledTimes(1);
  });

  it('fails closed and removes the previous managed session when relay acquisition fails', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'previous-access',
      refreshToken: 'previous-refresh',
      expiresAt: Date.now() + 60_000,
      subject: 'previous-user',
    });
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'previous-relay',
      ownerUserId: 'previous-user',
    });
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/login') {
        return jsonResponse(200, {
          accessToken: 'next-access',
          refreshToken: 'next-refresh',
          user: { id: 'next-user' },
        });
      }
      if (path === '/api/clawx/relay-token') {
        return jsonResponse(503, { message: 'relay unavailable' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const gateway = createGateway('running');

    const result = await loginManagedAuth(
      { account: 'test@example.com', password: 'password' },
      gateway,
    );

    expect(result.success).toBe(false);
    expect(secrets.has('uclaw-auth')).toBe(false);
    expect(secrets.has('openai')).toBe(false);
    expect(mocks.removeProviderKeyFromOpenClaw).toHaveBeenCalledWith('openai');
    expect(gateway.reload).toHaveBeenCalledTimes(1);
  });

  it('shares one refresh request across concurrent status reads', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'expired-access',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() - 1_000,
      subject: 'user-1',
    });
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'relay-secret',
      ownerUserId: 'user-1',
      expiresAt: Date.now() + 60_000,
    });
    activationState = {
      version: 1,
      deviceId: DEVICE.id,
      activated: true,
      onboardingCompleted: true,
      activatedAt: '2026-07-23T00:00:00.000Z',
      lastSeenAt: '2026-07-23T00:00:00.000Z',
      source: 'login',
      userId: 'user-1',
    };

    let resolveRefresh!: (value: ReturnType<typeof jsonResponse>) => void;
    const refreshResponse = new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
      resolveRefresh = resolve;
    });
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/bootstrap') return jsonResponse(200, {});
      if (path === '/api/clawx/auth/refresh') return refreshResponse;
      if (path === '/api/clawx/auth/verify') {
        return jsonResponse(200, { valid: true, user: { id: 'user-1' } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const first = getManagedAuthStatus();
    const second = getManagedAuthStatus();
    await vi.waitFor(() => {
      expect(mocks.proxyAwareFetch.mock.calls.filter(([input]) => (
        requestPath(input) === '/api/clawx/auth/refresh'
      ))).toHaveLength(1);
    });
    resolveRefresh(jsonResponse(200, {
      access_token: 'fresh-access',
      refresh_token: 'fresh-refresh',
      expires_in: 3_600,
    }));

    const statuses = await Promise.all([first, second]);
    expect(statuses.every((status) => status.authValid)).toBe(true);
    expect(mocks.proxyAwareFetch.mock.calls.filter(([input]) => (
      requestPath(input) === '/api/clawx/auth/refresh'
    ))).toHaveLength(1);
    expect(secrets.get('uclaw-auth')).toEqual(expect.objectContaining({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
    }));
  });

  it('overwrites an existing personal OpenAI slot after login succeeds', async () => {
    accountState = {
      id: 'openai',
      vendorId: 'openai',
      label: 'Personal OpenAI',
      authMode: 'api_key',
      baseUrl: 'https://api.openai.com/v1',
      apiProtocol: 'openai-responses',
      headers: { 'X-Personal': 'do-not-keep' },
      fallbackModels: ['personal-fallback'],
      enabled: true,
      isDefault: true,
      metadata: { resourceUrl: 'https://platform.openai.com' },
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    };
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'personal-secret',
    });

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' });

    expect(result.success).toBe(true);
    expect(mocks.updateAccount).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({
        id: 'openai',
        baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
        model: 'smart-latest',
        fallbackModels: [],
        metadata: expect.objectContaining({ managedBy: 'uclaw' }),
      }),
      'relay-secret',
    );
    expect(accountState?.headers).toBeUndefined();
    expect(accountState?.metadata?.resourceUrl).toBeUndefined();
    expect(secrets.get('openai')).toEqual(expect.objectContaining({ apiKey: 'relay-secret' }));
  });

  it('overwrites an unmanaged OpenClaw-only provider after importing it into the account cache', async () => {
    mocks.listAccounts.mockImplementation(async () => {
      accountState = {
        id: 'openai',
        vendorId: 'openai',
        label: 'Imported OpenAI',
        authMode: 'api_key',
        baseUrl: 'https://api.openai.com/v1',
        apiProtocol: 'openai-responses',
        enabled: true,
        isDefault: true,
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z',
      };
      return [accountState];
    });

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' });

    expect(result.success).toBe(true);
    expect(mocks.listAccounts).toHaveBeenCalledTimes(1);
    expect(mocks.updateAccount).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ metadata: expect.objectContaining({ managedBy: 'uclaw' }) }),
      'relay-secret',
    );
  });

  it('uses the same managed OpenAI takeover after registration succeeds', async () => {
    accountState = {
      id: 'openai',
      vendorId: 'openai',
      label: 'Existing OpenAI',
      authMode: 'api_key',
      baseUrl: 'https://api.openai.com/v1',
      apiProtocol: 'openai-responses',
      enabled: true,
      isDefault: true,
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    };

    const result = await registerManagedAuth({
      account: 'new-user',
      username: 'new-user',
      password: 'Password1',
    });

    expect(result.success).toBe(true);
    expect(mocks.updateAccount).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({
        model: 'smart-latest',
        metadata: expect.objectContaining({ managedBy: 'uclaw' }),
      }),
      'relay-secret',
    );
    expect(mocks.markManagedDeviceActivated).toHaveBeenCalledWith(
      'register',
      expect.objectContaining({ id: 'user-1' }),
    );
  });

  it('reloads a running Gateway exactly once after all writes complete', async () => {
    const gateway = createGateway('running');

    const result = await loginManagedAuth(
      { account: 'test@example.com', password: 'password' },
      gateway,
    );

    expect(result.success).toBe(true);
    expect(gateway.reload).toHaveBeenCalledTimes(1);
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledWith(
      expect.anything(),
      'relay-secret',
      undefined,
    );
    expect(mocks.syncDefaultProviderToRuntime).toHaveBeenCalledWith('openai', undefined);
  });

  it('does not reload or start a stopped Gateway', async () => {
    const gateway = createGateway('stopped');

    const result = await loginManagedAuth(
      { account: 'test@example.com', password: 'password' },
      gateway,
    );

    expect(result.success).toBe(true);
    expect(gateway.reload).not.toHaveBeenCalled();
    expect(gateway.stop).not.toHaveBeenCalled();
  });

  it('clears current and legacy credentials on logout', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() + 60_000,
    });
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'relay-secret',
    });
    secrets.set('lingzhiwuxian-auth', {
      type: 'oauth',
      accountId: 'lingzhiwuxian-auth',
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh',
      expiresAt: Date.now() + 60_000,
    });
    secrets.set('lingzhiwuxian', {
      type: 'api_key',
      accountId: 'lingzhiwuxian',
      apiKey: 'legacy-relay',
    });
    verificationCache = { verifiedAt: Date.now(), expiresAt: Date.now() + 60_000 };
    const gateway = createGateway('running');

    const result = await logoutManagedAuth(gateway);

    expect(result.success).toBe(true);
    expect(secrets.size).toBe(0);
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('uclaw-auth');
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('openai');
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('lingzhiwuxian-auth');
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('lingzhiwuxian');
    expect(mocks.removeProviderKeyFromOpenClaw).toHaveBeenCalledWith('openai');
    expect(mocks.removeProviderKeyFromOpenClaw).toHaveBeenCalledWith('lingzhiwuxian');
    expect(mocks.storeDelete).toHaveBeenCalledWith('uclawVerificationCache');
    expect(gateway.reload).toHaveBeenCalledTimes(1);
  });

  it('returns a logged-out status when Gateway reload fails after local cleanup', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() + 60_000,
    });
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'relay-secret',
    });
    const gateway = createGateway('running');
    vi.mocked(gateway.reload).mockRejectedValueOnce(new Error('reload failed'));

    const result = await logoutManagedAuth(gateway);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      status: expect.objectContaining({
        hasAuthToken: false,
        hasRefreshToken: false,
        hasRelayToken: false,
        authValid: false,
        gatewayReloaded: false,
        gatewayReloadError: 'Gateway reload failed',
      }),
    }));
    expect(secrets.size).toBe(0);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.getStatus().state).toBe('stopped');
  });

  it('stops a reconnecting Gateway after logout clears local credentials', async () => {
    const gateway = createGateway('reconnecting');

    const result = await logoutManagedAuth(gateway);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      status: expect.objectContaining({
        hasAuthToken: false,
        hasRelayToken: false,
        gatewayReloaded: false,
        gatewayReloadError: 'Gateway was not ready to reload',
      }),
    }));
    expect(gateway.reload).not.toHaveBeenCalled();
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.getStatus().state).toBe('stopped');
  });

  it('stops Gateway when reload resolves into an unhealthy state during logout', async () => {
    let gatewayState: ReturnType<GatewayManager['getStatus']>['state'] = 'running';
    const gateway = {
      getStatus: vi.fn(() => ({ state: gatewayState, port: 18_789 })),
      reload: vi.fn().mockImplementation(async () => {
        gatewayState = 'reconnecting';
      }),
      stop: vi.fn().mockImplementation(async () => {
        gatewayState = 'stopped';
      }),
    } as unknown as GatewayManager;

    const result = await logoutManagedAuth(gateway);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      status: expect.objectContaining({
        gatewayReloaded: false,
        gatewayReloadError: 'Gateway reload did not remain healthy',
      }),
    }));
    expect(gateway.reload).toHaveBeenCalledTimes(1);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.getStatus().state).toBe('stopped');
  });

  it('never exposes tokens or activation tickets in renderer-facing payloads', async () => {
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/activation/check') {
        return jsonResponse(200, { valid: true, activationTicket: 'ticket-do-not-return' });
      }
      if (path === '/api/clawx/login') {
        return jsonResponse(200, {
          accessToken: 'access-do-not-return',
          refreshToken: 'refresh-do-not-return',
          user: { id: 'user-1' },
        });
      }
      if (path === '/api/clawx/relay-token') {
        return jsonResponse(200, { token: 'relay-do-not-return' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const result = await loginManagedAuth({
      account: 'test@example.com',
      password: 'password',
      activationCode: 'ACT-SECRET',
    });
    const serialized = JSON.stringify(result);

    expect(result.success).toBe(true);
    expect(serialized).not.toMatch(/access-do-not-return|refresh-do-not-return|relay-do-not-return|ticket-do-not-return/);
    expect(serialized).not.toMatch(/accessToken|refreshToken|activationTicket|apiKey/);
  });

  it('normalizes backend JunFeiAI and Chinese legacy branding to UClaw', async () => {
    mocks.proxyAwareFetch.mockResolvedValue(jsonResponse(400, {
      code: 'quota_exhausted',
      message: 'JunFeiAI service: 君飞 AI quota exhausted',
    }));

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' });

    expect(result).toEqual({
      success: false,
      errorCode: 'quota_exhausted',
      message: 'UClaw service: UClaw quota exhausted',
    });
    expect(result.message).not.toMatch(/junfei|君飞/i);
  });

  it.each([
    ['relay owner is missing', 'current-user', undefined],
    ['current user is missing', undefined, 'another-user'],
    ['relay owner differs from current user', 'current-user', 'another-user'],
  ])('does not reuse a relay when %s', async (_label, subject, ownerUserId) => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() + 3_600_000,
      subject,
    });
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'relay-from-another-user',
      ownerUserId,
      expiresAt: Date.now() + 60_000,
    });

    const status = await getManagedAuthLocalStatus();

    expect(status.hasRelayToken).toBe(false);
  });

  it('single-flights two concurrent remote status requests', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() + 3_600_000,
      subject: 'user-1',
    });
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'relay-secret',
      ownerUserId: 'user-1',
      expiresAt: Date.now() + 60_000,
    });

    let resolveVerify!: (value: ReturnType<typeof jsonResponse>) => void;
    const verifyResponse = new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
      resolveVerify = resolve;
    });
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/bootstrap') return jsonResponse(200, {});
      if (path === '/api/clawx/auth/verify') return verifyResponse;
      throw new Error(`Unexpected request: ${path}`);
    });

    const first = getManagedAuthStatus();
    const second = getManagedAuthStatus();
    await vi.waitFor(() => {
      expect(mocks.proxyAwareFetch.mock.calls.some(([input]) => (
        requestPath(input) === '/api/clawx/auth/verify'
      ))).toBe(true);
    });
    resolveVerify(jsonResponse(200, { valid: true, user: { id: 'user-1' } }));
    const statuses = await Promise.all([first, second]);

    expect(statuses.every((status) => status.authValid)).toBe(true);
    expect(mocks.proxyAwareFetch.mock.calls.filter(([input]) => (
      requestPath(input) === '/api/clawx/auth/verify'
    ))).toHaveLength(1);
  });

  it('serializes logout after an in-flight status and prevents status write-back', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() + 3_600_000,
      subject: 'user-1',
    });
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'relay-secret',
      ownerUserId: 'user-1',
      expiresAt: Date.now() + 60_000,
    });
    const events: string[] = [];
    let resolveVerify!: (value: ReturnType<typeof jsonResponse>) => void;
    const verifyResponse = new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
      resolveVerify = resolve;
    });
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/bootstrap') return jsonResponse(200, {});
      if (path === '/api/clawx/auth/verify') {
        events.push('verify-request');
        return verifyResponse;
      }
      if (path === '/api/clawx/auth/logout') {
        events.push('logout-request');
        return jsonResponse(200, { success: true });
      }
      if (path === '/api/clawx/relay-token') {
        events.push('relay-request');
        return jsonResponse(200, { token: 'relay-written-after-logout' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const statusPromise = getManagedAuthStatus();
    await vi.waitFor(() => expect(events).toContain('verify-request'));
    const logoutPromise = logoutManagedAuth();
    await new Promise((resolve) => setTimeout(resolve, 0));
    events.push('verify-resolved');
    resolveVerify(jsonResponse(200, { valid: true, user: { id: 'user-1' } }));
    await Promise.all([statusPromise, logoutPromise]);

    expect.soft(events.indexOf('logout-request')).toBeGreaterThan(events.indexOf('verify-resolved'));
    expect.soft(secrets.has('uclaw-auth')).toBe(false);
    expect.soft(secrets.has('openai')).toBe(false);
    expect.soft(verificationCache).toBeUndefined();
  });

  it('serializes login after an in-flight status request', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() + 3_600_000,
      subject: 'user-1',
    });
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'old-relay',
      ownerUserId: 'user-1',
      expiresAt: Date.now() + 60_000,
    });
    const events: string[] = [];
    let resolveVerify!: (value: ReturnType<typeof jsonResponse>) => void;
    const verifyResponse = new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
      resolveVerify = resolve;
    });
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/bootstrap') return jsonResponse(200, {});
      if (path === '/api/clawx/auth/verify') {
        events.push('verify-request');
        return verifyResponse;
      }
      if (path === '/api/clawx/login') {
        events.push('login-request');
        return jsonResponse(200, {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          user: { id: 'user-1' },
        });
      }
      if (path === '/api/clawx/relay-token') {
        return jsonResponse(200, { token: 'new-relay' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const statusPromise = getManagedAuthStatus();
    await vi.waitFor(() => expect(events).toContain('verify-request'));
    const loginPromise = loginManagedAuth({ account: 'test@example.com', password: 'password' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    events.push('verify-resolved');
    resolveVerify(jsonResponse(200, { valid: true, user: { id: 'user-1' } }));
    const [, loginResult] = await Promise.all([statusPromise, loginPromise]);

    expect(loginResult.success).toBe(true);
    expect(events.indexOf('login-request')).toBeGreaterThan(events.indexOf('verify-resolved'));
    expect(secrets.get('uclaw-auth')).toEqual(expect.objectContaining({ accessToken: 'new-access' }));
  });

  it('finishes provider-store migration before reading the managed OpenAI slot', async () => {
    let migrationFinished = false;
    const staleUnmanagedAccount: ProviderAccount = {
      id: 'openai',
      vendorId: 'openai',
      label: 'Stale OpenAI',
      authMode: 'api_key',
      baseUrl: 'https://api.openai.com/v1',
      apiProtocol: 'openai-responses',
      enabled: true,
      isDefault: true,
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    };
    mocks.ensureProviderStoreMigrated.mockImplementation(async () => {
      migrationFinished = true;
    });
    mocks.getProviderAccount.mockImplementation(async () => (
      migrationFinished ? accountState : staleUnmanagedAccount
    ));

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' });

    expect.soft(result.success).toBe(true);
    expect(mocks.ensureProviderStoreMigrated).toHaveBeenCalled();
    if (mocks.ensureProviderStoreMigrated.mock.invocationCallOrder[0] !== undefined) {
      expect(mocks.ensureProviderStoreMigrated.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.getProviderAccount.mock.invocationCallOrder[0],
      );
    }
  });

  it('applies one Gateway reload when remote status replenishes a relay token', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() + 3_600_000,
      subject: 'user-1',
    });
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/bootstrap') return jsonResponse(200, {});
      if (path === '/api/clawx/auth/verify') {
        return jsonResponse(200, { valid: true, user: { id: 'user-1' } });
      }
      if (path === '/api/clawx/relay-token') {
        return jsonResponse(200, { token: 'replenished-relay' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const gateway = createGateway('running');

    const result = await refreshManagedAuth({}, gateway);

    expect(result.success).toBe(true);
    expect(gateway.reload).toHaveBeenCalledTimes(1);
  });

  it('waits for a recently connected Gateway to become stable before reloading', async () => {
    vi.useFakeTimers();
    try {
      const connectedAt = Date.now();
      const gateway = {
        getStatus: vi.fn(() => ({ state: 'running', port: 18_789, connectedAt })),
        reload: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      } as unknown as GatewayManager;

      const resultPromise = loginManagedAuth(
        { account: 'test@example.com', password: 'password' },
        gateway,
      );
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(gateway.reload).toHaveBeenCalledTimes(1);
      expect(Date.now() - connectedAt).toBeGreaterThanOrEqual(8_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps newly committed credentials and stops Gateway when reload fails', async () => {
    const previousAccount: ProviderAccount = {
      id: 'openai',
      vendorId: 'openai',
      label: 'Previous UClaw',
      authMode: 'api_key',
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      apiProtocol: 'openai-responses',
      model: 'smart-latest',
      enabled: true,
      isDefault: true,
      metadata: { managedBy: 'uclaw', managedRuntimeContractVersion: 3 },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    };
    accountState = previousAccount;
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'previous-access',
      refreshToken: 'previous-refresh',
      expiresAt: Date.now() + 3_600_000,
      subject: 'previous-user',
    });
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'previous-relay',
      ownerUserId: 'previous-user',
    });
    const gateway = createGateway('running');
    vi.mocked(gateway.reload).mockRejectedValueOnce(new Error('reload failed'));

    const result = await loginManagedAuth(
      { account: 'test@example.com', password: 'password' },
      gateway,
    );

    expect(result).toEqual(expect.objectContaining({
      success: true,
      status: expect.objectContaining({
        gatewayReloaded: false,
        gatewayReloadError: 'Gateway reload failed',
      }),
    }));
    expect(secrets.get('uclaw-auth')).toEqual(expect.objectContaining({ accessToken: 'access-secret' }));
    expect(secrets.get('openai')).toEqual(expect.objectContaining({ apiKey: 'relay-secret' }));
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledTimes(1);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.getStatus().state).toBe('stopped');
  });

  it('restores provider storage and OpenClaw runtime after a mid-sync failure', async () => {
    const previousAccount: ProviderAccount = {
      id: 'openai',
      vendorId: 'openai',
      label: 'Previous UClaw',
      authMode: 'api_key',
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      apiProtocol: 'openai-responses',
      model: 'previous-model',
      enabled: true,
      isDefault: false,
      metadata: { managedBy: 'uclaw', managedRuntimeContractVersion: 3 },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    };
    const previousAuth: ProviderSecret = {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'previous-access',
      refreshToken: 'previous-refresh',
      expiresAt: Date.now() + 3_600_000,
      subject: 'previous-user',
    };
    const previousRelay: ProviderSecret = {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'previous-relay',
      ownerUserId: 'previous-user',
      expiresAt: Date.now() + 60_000,
    };
    accountState = previousAccount;
    secrets.set('uclaw-auth', previousAuth);
    secrets.set('openai', previousRelay);
    defaultAccountId = 'moonshot';
    legacyDefaultProvider = 'moonshot';
    mocks.syncSavedProviderToRuntime.mockResolvedValue(undefined);
    mocks.syncDefaultProviderToRuntime
      .mockRejectedValueOnce(new Error('default runtime sync failed'))
      .mockResolvedValue(undefined);

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' });

    expect(result.success).toBe(false);
    expect(accountState).toEqual(previousAccount);
    expect(secrets.has('uclaw-auth')).toBe(false);
    expect(secrets.has('openai')).toBe(false);
    expect(defaultAccountId).toBe('moonshot');
    expect(legacyDefaultProvider).toBe('moonshot');
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'openai', name: 'Previous UClaw' }),
      'previous-relay',
      undefined,
    );
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledTimes(2);
    expect(mocks.syncDefaultProviderToRuntime).toHaveBeenLastCalledWith('moonshot', undefined);
    expect(mocks.removeProviderKeyFromOpenClaw).toHaveBeenLastCalledWith('openai');
  });

  it('continues restoring runtime defaults after an earlier rollback step fails', async () => {
    const previousAccount: ProviderAccount = {
      id: 'openai',
      vendorId: 'openai',
      label: 'Previous UClaw',
      authMode: 'api_key',
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      apiProtocol: 'openai-responses',
      model: 'smart-latest',
      enabled: true,
      isDefault: false,
      metadata: { managedBy: 'uclaw', managedRuntimeContractVersion: 3 },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    };
    accountState = previousAccount;
    defaultAccountId = 'moonshot';
    legacyDefaultProvider = 'moonshot';
    openClawConfig = {
      agents: { defaults: { thinkingDefault: 'low', reasoningDefault: 'off' } },
      models: {
        providers: {
          openai: {
            models: [{ id: 'smart-latest', name: 'Previous Model', contextWindow: 64_000 }],
          },
        },
      },
    };
    mocks.syncDefaultProviderToRuntime
      .mockRejectedValueOnce(new Error('default runtime sync failed'))
      .mockResolvedValue(undefined);
    mocks.saveProviderAccount.mockRejectedValueOnce(new Error('provider restore failed'));

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' });

    expect(result).toEqual(expect.objectContaining({ success: false, errorCode: 'rollback_failed' }));
    expect(mocks.syncDefaultProviderToRuntime).toHaveBeenLastCalledWith('moonshot', undefined);
    expect(mocks.updateAgentModelProvider).toHaveBeenCalledWith('openai', expect.objectContaining({
      models: [expect.objectContaining({
        id: 'smart-latest',
        name: 'Previous Model',
        contextWindow: 64_000,
      })],
    }));
    expect(openClawConfig).toEqual(expect.objectContaining({
      agents: { defaults: { thinkingDefault: 'low', reasoningDefault: 'off' } },
    }));
  });

  it('keeps legacy defaultProvider and defaultProviderAccountId consistent after login', async () => {
    defaultAccountId = 'moonshot';
    legacyDefaultProvider = 'moonshot';

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' });

    expect(result.success).toBe(true);
    expect(defaultAccountId).toBe('openai');
    expect(legacyDefaultProvider).toBe('openai');
  });

  it('invalidates stored and runtime credentials after remote authentication is rejected', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'rejected-access',
      refreshToken: 'rejected-refresh',
      expiresAt: Date.now() + 3_600_000,
      subject: 'user-1',
    });
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'rejected-relay',
      ownerUserId: 'user-1',
    });
    verificationCache = {
      verifiedAt: Date.now() - 10_000,
      verifyAfter: Date.now() - 1,
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'user-1' },
    };
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/bootstrap') return jsonResponse(200, {});
      if (path === '/api/clawx/auth/verify') {
        return jsonResponse(401, { code: 'session_revoked', message: 'Session revoked' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const gateway = createGateway('running');

    const status = await getManagedAuthStatus({ force: true }, gateway);

    expect(status).toEqual(expect.objectContaining({
      authValid: false,
      authRejected: true,
      authErrorCode: 'session_revoked',
      hasAuthToken: false,
      hasRelayToken: false,
    }));
    expect(secrets.size).toBe(0);
    expect(mocks.removeProviderKeyFromOpenClaw).toHaveBeenCalledWith('openai');
    expect(gateway.reload).toHaveBeenCalledTimes(1);
  });

  it('reports cleanup failure only after attempting every local and Gateway cleanup step', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'previous-access',
      refreshToken: 'previous-refresh',
      expiresAt: Date.now() + 60_000,
    });
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'previous-relay',
    });
    verificationCache = { verifiedAt: Date.now(), verifyAfter: Date.now(), expiresAt: Date.now() + 60_000 };
    mocks.proxyAwareFetch.mockResolvedValue(jsonResponse(401, {
      code: 'invalid_credentials',
      message: 'Invalid credentials',
    }));
    mocks.removeProviderKeyFromOpenClaw.mockRejectedValueOnce(new Error('runtime write failed'));
    const gateway = createGateway('running');

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'wrong' }, gateway);

    expect(result).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'session_cleanup_failed',
    }));
    expect(secrets.size).toBe(0);
    expect(verificationCache).toBeUndefined();
    expect(gateway.reload).not.toHaveBeenCalled();
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.getStatus().state).toBe('stopped');
  });

  it('preserves the cleanup error when fail-closed Gateway stop also fails', async () => {
    mocks.proxyAwareFetch.mockResolvedValue(jsonResponse(401, {
      code: 'invalid_credentials',
      message: 'Invalid credentials',
    }));
    mocks.removeProviderKeyFromOpenClaw.mockRejectedValueOnce(new Error('runtime write failed'));
    const gateway = createGateway('running');
    vi.mocked(gateway.stop).mockRejectedValueOnce(new Error('stop failed'));

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'wrong' }, gateway);

    expect(result).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'session_cleanup_failed',
    }));
    expect(gateway.stop).toHaveBeenCalledTimes(1);
  });

  it('stops a reconnecting Gateway when managed credential cleanup fails', async () => {
    mocks.removeProviderKeyFromOpenClaw.mockRejectedValueOnce(new Error('runtime write failed'));
    const gateway = createGateway('reconnecting');

    const result = await logoutManagedAuth(gateway);

    expect(result).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'session_cleanup_failed',
    }));
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.getStatus().state).toBe('stopped');
  });

  it('redacts quoted JSON secrets and normalizes legacy branding in backend errors', async () => {
    mocks.proxyAwareFetch.mockResolvedValue(jsonResponse(400, {
      code: 'bad_request',
      message: '{"password":"raw-password","access_token":"raw-token","message":"JunFeiAI rejected the request"}',
    }));

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' });
    const serialized = JSON.stringify(result);

    expect(result).toEqual(expect.objectContaining({ success: false, errorCode: 'bad_request' }));
    expect(serialized).not.toContain('raw-password');
    expect(serialized).not.toContain('raw-token');
    expect(serialized).not.toMatch(/junfei|君飞/i);
    expect(serialized).toContain('UClaw');
  });

  it('preserves force semantics when a normal status request is already in flight', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() + 3_600_000,
      subject: 'user-1',
    });
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'relay-secret',
      ownerUserId: 'user-1',
    });
    let resolveFirst!: (value: ReturnType<typeof jsonResponse>) => void;
    const firstVerify = new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
      resolveFirst = resolve;
    });
    let verifyCalls = 0;
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/bootstrap') return jsonResponse(200, {});
      if (path === '/api/clawx/auth/verify') {
        verifyCalls += 1;
        if (verifyCalls === 1) return firstVerify;
        return jsonResponse(200, { valid: true, user: { id: 'user-1' } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const gateway = createGateway('running');

    const normal = getManagedAuthStatus({}, gateway);
    await vi.waitFor(() => expect(verifyCalls).toBe(1));
    const forced = getManagedAuthStatus({ force: true }, gateway);
    resolveFirst(jsonResponse(200, { valid: true, user: { id: 'user-1' } }));
    await Promise.all([normal, forced]);

    expect(verifyCalls).toBe(2);
  });

  it('keeps concurrent activation tickets isolated by code and device', async () => {
    const loginBodies: Record<string, unknown>[] = [];
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown, init: unknown) => {
      const path = requestPath(input);
      const body = requestBody(init);
      if (path === '/api/clawx/activation/check') {
        const code = String(body.code);
        return jsonResponse(200, { valid: true, activationTicket: `ticket-${code}` });
      }
      if (path === '/api/clawx/login') {
        loginBodies.push(body);
        return jsonResponse(200, {
          accessToken: 'access-secret',
          refreshToken: 'refresh-secret',
          user: { id: 'user-1' },
        });
      }
      if (path === '/api/clawx/relay-token') return jsonResponse(200, { token: 'relay-secret' });
      throw new Error(`Unexpected request: ${path}`);
    });

    await Promise.all([
      checkManagedAuthActivation('CODE-A'),
      checkManagedAuthActivation('CODE-B'),
    ]);
    const result = await loginManagedAuth({
      account: 'test@example.com',
      password: 'password',
      activationCode: 'CODE-A',
    });

    expect(result.success).toBe(true);
    expect(loginBodies[0]).toEqual(expect.objectContaining({
      activationCode: 'CODE-A',
      activationTicket: 'ticket-CODE-A',
    }));
  });

  it('returns stable business error codes for activation and verification-code failures', async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse(429, {
      code: 'activation_rate_limited',
      message: 'JunFeiAI activation token=raw-secret',
    }));

    await expect(checkManagedAuthActivation('RATE-LIMITED')).resolves.toEqual({
      valid: false,
      errorCode: 'activation_rate_limited',
    });

    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse(429, {
      code: 'verification_rate_limited',
      message: 'JunFeiAI password=raw-secret',
    }));
    await expect(sendManagedAuthVerificationCode({ account: 'test@example.com' })).resolves.toEqual({
      success: false,
      errorCode: 'verification_rate_limited',
    });
  });
});
