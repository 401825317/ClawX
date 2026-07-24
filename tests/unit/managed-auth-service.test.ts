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
  restoreManagedDeviceActivationFiles: vi.fn(),
  snapshotManagedDeviceActivationFiles: vi.fn(),
  acquireManagedRuntimeMutationLease: vi.fn(),
  releaseManagedRuntimeMutationLease: vi.fn(),
  markManagedRuntimeMutationStarted: vi.fn(),
  quarantineManagedRuntimeMutation: vi.fn(),
  clearManagedRuntimeMutationMarker: vi.fn(),
  deleteProviderSecret: vi.fn(),
  getProviderSecret: vi.fn(),
  installManagedProviderSecrets: vi.fn(),
  restoreProviderSecretSlots: vi.fn(),
  setProviderSecret: vi.fn(),
  snapshotProviderSecretSlots: vi.fn(),
  buildManagedProviderAccounts: vi.fn(),
  getManagedOpenAiTargetAccountIds: vi.fn(),
  getProviderAccount: vi.fn(),
  installManagedOpenAiProviderAccount: vi.fn(),
  restoreManagedProviderStore: vi.fn(),
  snapshotManagedProviderStore: vi.fn(),
  removeManagedAgentOpenAiCredentialsFromSnapshot: vi.fn(),
  removeManagedAgentOpenAiProviders: vi.fn(),
  getManagedAgentOpenAiProviderIds: vi.fn(),
  installManagedAgentOpenAiApiKey: vi.fn(),
  restoreManagedAgentAuthProfiles: vi.fn(),
  snapshotManagedAgentAuthProfiles: vi.fn(),
  restoreManagedAgentModelsFiles: vi.fn(),
  snapshotManagedAgentModelsFiles: vi.fn(),
  updateManagedAgentModelProviderStrict: vi.fn(),
  restoreManagedRuntimeConfig: vi.fn(),
  removeManagedRuntimeOpenAiState: vi.fn(),
  createManagedRuntimeProviderEntry: vi.fn(),
  getManagedRuntimeOpenAiProviderIds: vi.fn(),
  installManagedRuntimeProviderState: vi.fn(),
  snapshotManagedRuntimeConfig: vi.fn(),
  updateManagedRuntimeConfig: vi.fn(),
  cacheManagedClientTextModelPolicyFromPayload: vi.fn(),
  readOpenClawConfig: vi.fn(),
  writeOpenClawConfig: vi.fn(),
  storeGet: vi.fn(),
  storeSet: vi.fn(),
  storeDelete: vi.fn(),
  ensureProviderStoreMigrated: vi.fn(),
  waitForPortFree: vi.fn(),
}));

vi.mock('@electron/utils/junfeiai-distribution', () => ({
  UCLAW_ACCOUNT_ID: 'openai',
  UCLAW_AUTH_REQUEST_TIMEOUT_MS: 12_000,
  UCLAW_AUTH_ACCOUNT_ID: 'uclaw-auth',
  UCLAW_BOOTSTRAP_REQUEST_TIMEOUT_MS: 8_000,
  UCLAW_COMPATIBILITY_PROVIDER_ID: 'lingzhiwuxian',
  UCLAW_DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS: 86_400,
  UCLAW_DEFAULT_API_PROTOCOL: 'openai-responses',
  UCLAW_DEFAULT_BASE_URL: 'https://zz-cn.lingzhiwuxian.com/v1',
  UCLAW_DEFAULT_MODEL: 'smart-latest',
  UCLAW_DEFAULT_MODEL_CONTEXT_WINDOW: 258_000,
  UCLAW_DEFAULT_THINKING_LEVEL: 'medium',
  UCLAW_LEGACY_AUTH_ACCOUNT_IDS: ['lingzhiwuxian-auth'],
  UCLAW_LEGACY_PROVIDER_IDS: ['openai-codex'],
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
  restoreManagedDeviceActivationFiles: mocks.restoreManagedDeviceActivationFiles,
  snapshotManagedDeviceActivationFiles: mocks.snapshotManagedDeviceActivationFiles,
}));

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

vi.mock('@electron/services/secrets/secret-store', () => ({
  deleteProviderSecret: mocks.deleteProviderSecret,
  getProviderSecret: mocks.getProviderSecret,
  installManagedProviderSecrets: mocks.installManagedProviderSecrets,
  restoreProviderSecretSlots: mocks.restoreProviderSecretSlots,
  setProviderSecret: mocks.setProviderSecret,
  snapshotProviderSecretSlots: mocks.snapshotProviderSecretSlots,
}));

vi.mock('@electron/services/providers/provider-store', () => ({
  buildManagedProviderAccounts: mocks.buildManagedProviderAccounts,
  getManagedOpenAiTargetAccountIds: mocks.getManagedOpenAiTargetAccountIds,
  getProviderAccount: mocks.getProviderAccount,
  installManagedOpenAiProviderAccount: mocks.installManagedOpenAiProviderAccount,
  restoreManagedProviderStore: mocks.restoreManagedProviderStore,
  snapshotManagedProviderStore: mocks.snapshotManagedProviderStore,
}));

vi.mock('@electron/services/providers/provider-migration', () => ({
  ensureProviderStoreMigrated: mocks.ensureProviderStoreMigrated,
}));

vi.mock('@electron/gateway/supervisor', () => ({
  waitForPortFree: mocks.waitForPortFree,
}));

vi.mock('@electron/gateway/managed-runtime-mutation-barrier', () => ({
  acquireManagedRuntimeMutationLease: mocks.acquireManagedRuntimeMutationLease,
  releaseManagedRuntimeMutationLease: mocks.releaseManagedRuntimeMutationLease,
  markManagedRuntimeMutationStarted: mocks.markManagedRuntimeMutationStarted,
  quarantineManagedRuntimeMutation: mocks.quarantineManagedRuntimeMutation,
  clearManagedRuntimeMutationMarker: mocks.clearManagedRuntimeMutationMarker,
}));

vi.mock('@electron/services/providers/managed-runtime-config', () => ({
  createManagedRuntimeProviderEntry: mocks.createManagedRuntimeProviderEntry,
  getManagedRuntimeOpenAiProviderIds: mocks.getManagedRuntimeOpenAiProviderIds,
  installManagedRuntimeProviderState: mocks.installManagedRuntimeProviderState,
  removeManagedRuntimeOpenAiState: mocks.removeManagedRuntimeOpenAiState,
  restoreManagedRuntimeConfig: mocks.restoreManagedRuntimeConfig,
  snapshotManagedRuntimeConfig: mocks.snapshotManagedRuntimeConfig,
  updateManagedRuntimeConfig: mocks.updateManagedRuntimeConfig,
}));

vi.mock('@electron/services/managed-client-config-service', () => ({
  cacheManagedClientTextModelPolicyFromPayload: mocks.cacheManagedClientTextModelPolicyFromPayload,
}));

vi.mock('@electron/utils/openclaw-auth', () => ({
  getManagedAgentOpenAiProviderIds: mocks.getManagedAgentOpenAiProviderIds,
  removeManagedAgentOpenAiCredentialsFromSnapshot: mocks.removeManagedAgentOpenAiCredentialsFromSnapshot,
  removeManagedAgentOpenAiProviders: mocks.removeManagedAgentOpenAiProviders,
  installManagedAgentOpenAiApiKey: mocks.installManagedAgentOpenAiApiKey,
  restoreManagedAgentAuthProfiles: mocks.restoreManagedAgentAuthProfiles,
  snapshotManagedAgentAuthProfiles: mocks.snapshotManagedAgentAuthProfiles,
  restoreManagedAgentModelsFiles: mocks.restoreManagedAgentModelsFiles,
  snapshotManagedAgentModelsFiles: mocks.snapshotManagedAgentModelsFiles,
  updateManagedAgentModelProviderStrict: mocks.updateManagedAgentModelProviderStrict,
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
  getFreshManagedAuthStatus,
  getManagedAuthLocalStatus,
  getManagedAuthStatus,
  loginManagedAuth,
  logoutManagedAuth,
  reconcileManagedProviderRuntimeForStartup,
  registerManagedAuth,
  refreshManagedAuth,
  requestManagedAuthenticatedJson,
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

const PREVIOUS_OPENCLAW_AUTH_STORE = {
  version: 1,
  profiles: {
    'openai:oauth': {
      type: 'oauth',
      provider: 'openai',
      access: 'previous-openclaw-access',
      refresh: 'previous-openclaw-refresh',
    },
  },
};

const AGENT_AUTH_PROFILES_SNAPSHOT = {
  agents: [{
    agentId: 'main',
    filePath: '/snapshot/main/auth-profiles.json',
    originalContent: Buffer.from(JSON.stringify(PREVIOUS_OPENCLAW_AUTH_STORE)),
    originalMode: 0o600,
    sqlite: {
      agentId: 'main',
      sqlitePath: '/snapshot/main/auth-profiles.sqlite',
      storeRow: null,
      stateRow: null,
      parsedStore: PREVIOUS_OPENCLAW_AUTH_STORE,
    },
    store: PREVIOUS_OPENCLAW_AUTH_STORE,
  }],
};

let accountState: ProviderAccount | null;
let compatibilityAccountState: ProviderAccount | null;
let defaultAccountId: string | undefined;
let legacyDefaultProvider: string | undefined;
let activationState: ActivationState;
let verificationCache: unknown;
let secrets: Map<string, ProviderSecret>;
let openClawConfig: Record<string, unknown>;
let providerStoreSnapshotState: {
  account: ProviderAccount | null;
  compatibilityAccount: ProviderAccount | null;
  defaultAccountId?: string;
  defaultProviderId?: string;
};
let providerSecretSnapshotState: Map<string, ProviderSecret>;
let providerSecretTargetIds: string[];

const PROVIDER_STORE_SNAPSHOT = {};
const PROVIDER_SECRET_SLOTS_SNAPSHOT = {};
const RUNTIME_MUTATION_LEASE = {};
const MANAGED_MODEL_POLICY = {
  defaultModel: 'smart-latest',
  models: [
    { id: 'smart-latest', label: 'Smart Latest' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
  ],
};

function activationFilesSnapshot(state: ActivationState = activationState) {
  const bytes = state ? Buffer.from(JSON.stringify(state), 'utf8') : null;
  return {
    current: { path: '/test/uclaw-device-activation.json', bytes },
    stable: { path: '/test/stable/uclaw-device-activation.json', bytes },
  };
}

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
  let lastPid = 100;
  let currentPid = state === 'stopped' ? undefined : 100;
  return {
    getStatus: vi.fn(() => ({ state: currentState, port: 18_789, pid: currentPid })),
    acquireManagedRuntimeMutationLease: vi.fn(() => mocks.acquireManagedRuntimeMutationLease()),
    releaseManagedRuntimeMutationLease: vi.fn((lease) => mocks.releaseManagedRuntimeMutationLease(lease)),
    reload: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockImplementation(async () => {
      currentState = 'running';
      currentPid = ++lastPid;
    }),
    restart: vi.fn().mockImplementation(async () => {
      currentState = 'running';
      currentPid = ++lastPid;
    }),
    stop: vi.fn().mockImplementation(async () => {
      currentState = 'stopped';
      currentPid = undefined;
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
          client: { modelOptions: { text: MANAGED_MODEL_POLICY } },
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
  compatibilityAccountState = null;
  defaultAccountId = undefined;
  legacyDefaultProvider = undefined;
  activationState = null;
  verificationCache = undefined;
  secrets = new Map<string, ProviderSecret>();
  openClawConfig = {};
  providerStoreSnapshotState = { account: null, compatibilityAccount: null };
  providerSecretSnapshotState = new Map<string, ProviderSecret>();
  providerSecretTargetIds = [];

  mocks.getManagedDevicePayload.mockResolvedValue(DEVICE);
  mocks.readManagedDeviceActivationState.mockImplementation(async () => activationState);
  mocks.snapshotManagedDeviceActivationFiles.mockImplementation(async () => activationFilesSnapshot());
  mocks.restoreManagedDeviceActivationFiles.mockImplementation(async (snapshotValue) => {
    const file = snapshotValue.current ?? snapshotValue.stable;
    activationState = file?.bytes
      ? JSON.parse(file.bytes.toString('utf8')) as ActivationState
      : null;
  });
  mocks.markManagedDeviceActivated.mockImplementation(async (source, user, applied) => {
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
    if (applied) Object.assign(applied, activationFilesSnapshot());
  });

  mocks.getProviderSecret.mockImplementation(async (accountId: string) => secrets.get(accountId));
  mocks.setProviderSecret.mockImplementation(async (secret: ProviderSecret) => {
    secrets.set(secret.accountId, secret);
  });
  mocks.deleteProviderSecret.mockImplementation(async (accountId: string) => {
    secrets.delete(accountId);
  });
  mocks.snapshotProviderSecretSlots.mockImplementation(async (accountIds: string[]) => {
    providerSecretTargetIds = [...accountIds];
    providerSecretSnapshotState = structuredClone(secrets);
    return PROVIDER_SECRET_SLOTS_SNAPSHOT;
  });
  mocks.installManagedProviderSecrets.mockImplementation(async (
    _snapshot: unknown,
    authSecret: ProviderSecret,
    relaySecret: ProviderSecret,
    compatibilityRelaySecret: ProviderSecret,
  ) => {
    for (const accountId of providerSecretTargetIds) secrets.delete(accountId);
    secrets.set(authSecret.accountId, structuredClone(authSecret));
    secrets.set(relaySecret.accountId, structuredClone(relaySecret));
    secrets.set(compatibilityRelaySecret.accountId, structuredClone(compatibilityRelaySecret));
  });
  mocks.restoreProviderSecretSlots.mockImplementation(async () => {
    secrets = structuredClone(providerSecretSnapshotState);
  });
  mocks.getProviderAccount.mockImplementation(async (accountId: string) => (
    accountId === 'lingzhiwuxian' ? compatibilityAccountState : accountState
  ));
  mocks.snapshotManagedProviderStore.mockImplementation(async () => {
    providerStoreSnapshotState = {
      account: structuredClone(accountState),
      compatibilityAccount: structuredClone(compatibilityAccountState),
      defaultAccountId,
      defaultProviderId: legacyDefaultProvider,
    };
    return PROVIDER_STORE_SNAPSHOT;
  });
  mocks.getManagedOpenAiTargetAccountIds.mockReturnValue(['openai']);
  mocks.buildManagedProviderAccounts.mockImplementation((existing, policy, owner) => {
    const modelIds = policy.models.map((model: { id: string }) => model.id);
    const buildAccount = (
      id: 'openai' | 'lingzhiwuxian',
      label: string,
      previous: ProviderAccount | null | undefined,
      isDefault: boolean,
    ): ProviderAccount => ({
      id,
      vendorId: id,
      label,
      authMode: 'api_key',
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      apiProtocol: 'openai-responses',
      model: policy.defaultModel,
      fallbackModels: [],
      fallbackAccountIds: [],
      enabled: true,
      isDefault,
      metadata: {
        managedBy: 'uclaw',
        customModels: modelIds,
        managedDefaultModel: policy.defaultModel,
        managedAllowedModels: modelIds,
        managedRuntimeContractVersion: 4,
        ...(owner?.email || previous?.metadata?.email
          ? { email: owner?.email || previous?.metadata?.email }
          : {}),
      },
      createdAt: previous?.createdAt ?? '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
    });
    return [
      buildAccount('openai', 'OpenAI', existing.primary, true),
      buildAccount('lingzhiwuxian', 'UClaw', existing.compatibility, false),
    ];
  });
  mocks.installManagedOpenAiProviderAccount.mockImplementation(async (
    _snapshot: unknown,
    account: ProviderAccount,
    compatibilityAccount: ProviderAccount,
  ) => {
    accountState = structuredClone(account);
    compatibilityAccountState = structuredClone(compatibilityAccount);
    defaultAccountId = account.id;
    legacyDefaultProvider = account.id;
  });
  mocks.restoreManagedProviderStore.mockImplementation(async () => {
    accountState = structuredClone(providerStoreSnapshotState.account);
    compatibilityAccountState = structuredClone(providerStoreSnapshotState.compatibilityAccount);
    defaultAccountId = providerStoreSnapshotState.defaultAccountId;
    legacyDefaultProvider = providerStoreSnapshotState.defaultProviderId;
  });
  mocks.ensureProviderStoreMigrated.mockResolvedValue(undefined);
  mocks.waitForPortFree.mockResolvedValue(undefined);
  mocks.acquireManagedRuntimeMutationLease.mockReturnValue(RUNTIME_MUTATION_LEASE);
  mocks.releaseManagedRuntimeMutationLease.mockReturnValue(undefined);
  mocks.markManagedRuntimeMutationStarted.mockResolvedValue(undefined);
  mocks.quarantineManagedRuntimeMutation.mockResolvedValue(undefined);
  mocks.clearManagedRuntimeMutationMarker.mockResolvedValue(undefined);
  mocks.removeManagedAgentOpenAiCredentialsFromSnapshot.mockResolvedValue(undefined);
  mocks.removeManagedAgentOpenAiProviders.mockResolvedValue(undefined);
  mocks.getManagedAgentOpenAiProviderIds.mockReturnValue([]);
  mocks.installManagedAgentOpenAiApiKey.mockResolvedValue(undefined);
  mocks.restoreManagedAgentAuthProfiles.mockResolvedValue(undefined);
  mocks.snapshotManagedAgentAuthProfiles.mockResolvedValue(AGENT_AUTH_PROFILES_SNAPSHOT);
  mocks.restoreManagedAgentModelsFiles.mockResolvedValue(undefined);
  mocks.snapshotManagedAgentModelsFiles.mockResolvedValue({ files: [] });
  mocks.updateManagedAgentModelProviderStrict.mockResolvedValue(undefined);
  mocks.cacheManagedClientTextModelPolicyFromPayload.mockResolvedValue(MANAGED_MODEL_POLICY);
  mocks.createManagedRuntimeProviderEntry.mockImplementation((policy) => ({
    baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
    api: 'openai-responses',
    agentRuntime: { id: 'pi' },
    models: policy.models.map((model: { id: string; label?: string }) => ({
      id: model.id,
      name: model.label || model.id,
      contextWindow: 258_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(model.id === 'smart-latest' ? { reasoning: true } : {}),
      compat: model.id === 'smart-latest'
        ? {
            supportsPromptCacheKey: true,
            supportsReasoningEffort: true,
            supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
          }
        : { supportsPromptCacheKey: true },
    })),
  }));
  mocks.removeManagedRuntimeOpenAiState.mockResolvedValue(undefined);
  mocks.getManagedRuntimeOpenAiProviderIds.mockReturnValue([]);
  mocks.snapshotManagedRuntimeConfig.mockImplementation(async () => ({
    before: structuredClone(openClawConfig),
  }));
  mocks.updateManagedRuntimeConfig.mockImplementation(async (snapshotValue, mutate) => {
    const config = structuredClone(openClawConfig);
    mutate(config);
    const commands = typeof config.commands === 'object' && config.commands && !Array.isArray(config.commands)
      ? { ...config.commands as Record<string, unknown> }
      : {};
    commands.restart = true;
    config.commands = commands;
    snapshotValue.applied = structuredClone(config);
    await mocks.writeOpenClawConfig(config);
  });
  mocks.installManagedRuntimeProviderState.mockImplementation(async (
    snapshotValue,
    policy,
    additionalProviderIds: Iterable<string>,
  ) => {
    const managedProviderIds = new Set([
      'openai',
      'lingzhiwuxian',
      'openai-codex',
      ...additionalProviderIds,
    ]);
    const providerEntry = mocks.createManagedRuntimeProviderEntry(policy);
    await mocks.updateManagedRuntimeConfig(snapshotValue, (config: Record<string, unknown>) => {
      const agents = typeof config.agents === 'object' && config.agents && !Array.isArray(config.agents)
        ? { ...config.agents as Record<string, unknown> }
        : {};
      const defaults = typeof agents.defaults === 'object' && agents.defaults && !Array.isArray(agents.defaults)
        ? { ...agents.defaults as Record<string, unknown> }
        : {};
      defaults.model = { primary: `openai/${policy.defaultModel}`, fallbacks: [] };
      defaults.thinkingDefault = 'medium';
      defaults.reasoningDefault = 'on';
      agents.defaults = defaults;
      config.agents = agents;

      if (typeof config.auth === 'object' && config.auth && !Array.isArray(config.auth)) {
        const auth = { ...config.auth as Record<string, unknown> };
        const profiles = typeof auth.profiles === 'object' && auth.profiles && !Array.isArray(auth.profiles)
          ? { ...auth.profiles as Record<string, unknown> }
          : {};
        const removedProfileIds = new Set<string>();
        for (const [profileId, profile] of Object.entries(profiles)) {
          const provider = typeof profile === 'object' && profile && !Array.isArray(profile)
            ? (profile as Record<string, unknown>).provider
            : undefined;
          if (typeof provider === 'string' && managedProviderIds.has(provider)) {
            delete profiles[profileId];
            removedProfileIds.add(profileId);
          }
        }
        auth.profiles = profiles;
        if (typeof auth.order === 'object' && auth.order && !Array.isArray(auth.order)) {
          const order = { ...auth.order as Record<string, unknown> };
          for (const [providerId, profileIds] of Object.entries(order)) {
            if (managedProviderIds.has(providerId)) {
              delete order[providerId];
              continue;
            }
            if (!Array.isArray(profileIds)) continue;
            const remaining = profileIds.filter((profileId) => (
              typeof profileId !== 'string' || !removedProfileIds.has(profileId)
            ));
            if (remaining.length > 0) order[providerId] = remaining;
            else delete order[providerId];
          }
          auth.order = order;
        }
        config.auth = auth;
      }

      const models = typeof config.models === 'object' && config.models && !Array.isArray(config.models)
        ? { ...config.models as Record<string, unknown> }
        : {};
      const providers = typeof models.providers === 'object' && models.providers && !Array.isArray(models.providers)
        ? { ...models.providers as Record<string, unknown> }
        : {};
      for (const [providerId, entry] of Object.entries(providers)) {
        const baseUrl = typeof entry === 'object' && entry && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).baseUrl
          : undefined;
        if (
          managedProviderIds.has(providerId)
          || (typeof baseUrl === 'string'
            && baseUrl.replace(/\/+$/, '') === 'https://zz-cn.lingzhiwuxian.com/v1')
        ) {
          delete providers[providerId];
        }
      }
      providers.openai = structuredClone(providerEntry);
      providers.lingzhiwuxian = structuredClone(providerEntry);
      models.providers = providers;
      config.models = models;
    });
  });
  mocks.restoreManagedRuntimeConfig.mockImplementation(async (snapshotValue) => {
    if (!snapshotValue.applied) return;
    if (JSON.stringify(openClawConfig) === JSON.stringify(snapshotValue.before)) return;
    if (JSON.stringify(openClawConfig) !== JSON.stringify(snapshotValue.applied)) {
      throw new Error('OpenClaw config changed after the managed authentication write');
    }
    openClawConfig = structuredClone(snapshotValue.before);
  });
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
  it('repairs both managed Relay slots from a valid compatibility Secret at startup', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() + 3_600_000,
      subject: 'user-1',
      email: 'test@example.com',
    });
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'stale-primary-relay',
      ownerUserId: 'other-user',
      expiresAt: Date.now() + 3_600_000,
    });
    secrets.set('lingzhiwuxian', {
      type: 'api_key',
      accountId: 'lingzhiwuxian',
      apiKey: 'valid-compatibility-relay',
      ownerUserId: 'user-1',
      expiresAt: Date.now() + 3_600_000,
    });

    await reconcileManagedProviderRuntimeForStartup(MANAGED_MODEL_POLICY);

    expect(secrets.get('openai')).toEqual(expect.objectContaining({
      accountId: 'openai',
      apiKey: 'valid-compatibility-relay',
    }));
    expect(secrets.get('lingzhiwuxian')).toEqual(expect.objectContaining({
      accountId: 'lingzhiwuxian',
      apiKey: 'valid-compatibility-relay',
    }));
    expect(mocks.installManagedAgentOpenAiApiKey).toHaveBeenCalledWith(
      AGENT_AUTH_PROFILES_SNAPSHOT,
      'valid-compatibility-relay',
      new Set(['openai', 'lingzhiwuxian', 'openai-codex']),
    );
  });

  it('runs the Secret canonicalization transaction when startup values already match', async () => {
    const authSecret: ProviderSecret = {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() + 3_600_000,
      subject: 'user-1',
      email: 'test@example.com',
    };
    const relaySecret: ProviderSecret = {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'same-relay',
      ownerUserId: 'user-1',
      expiresAt: Date.now() + 3_600_000,
    };
    const compatibilityRelaySecret: ProviderSecret = {
      ...relaySecret,
      accountId: 'lingzhiwuxian',
    };
    secrets.set('uclaw-auth', authSecret);
    secrets.set('openai', relaySecret);
    secrets.set('lingzhiwuxian', compatibilityRelaySecret);

    await reconcileManagedProviderRuntimeForStartup(MANAGED_MODEL_POLICY);

    expect(mocks.installManagedProviderSecrets).toHaveBeenCalledWith(
      PROVIDER_SECRET_SLOTS_SNAPSHOT,
      authSecret,
      relaySecret,
      compatibilityRelaySecret,
    );
  });

  it('clears only managed runtime state when startup has no usable login', async () => {
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'orphaned-relay',
      ownerUserId: 'user-1',
    });

    await reconcileManagedProviderRuntimeForStartup(MANAGED_MODEL_POLICY);

    expect(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot).toHaveBeenCalledWith(
      AGENT_AUTH_PROFILES_SNAPSHOT,
      new Set(['openai', 'lingzhiwuxian', 'openai-codex']),
    );
    expect(mocks.removeManagedAgentOpenAiProviders).toHaveBeenCalledOnce();
    expect(mocks.removeManagedRuntimeOpenAiState).toHaveBeenCalledOnce();
    expect(mocks.installManagedOpenAiProviderAccount).not.toHaveBeenCalled();
    expect(secrets.get('openai')).toEqual(expect.objectContaining({ apiKey: 'orphaned-relay' }));
  });

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

  it('uses the Main-owned access token for authenticated UClaw requests', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() + 3_600_000,
    });
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown, init: unknown) => {
      expect(requestPath(input)).toBe('/api/clawx/billing/checkout-info');
      expect((init as { headers?: Record<string, string> }).headers?.Authorization)
        .toBe('Bearer access-secret');
      return jsonResponse(200, { data: { balance: 12 } });
    });

    await expect(requestManagedAuthenticatedJson('/api/clawx/billing/checkout-info'))
      .resolves.toEqual({ balance: 12 });
  });

  it('refreshes an expired access token before an authenticated UClaw request', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'expired-access',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() - 1_000,
    });
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown, init: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/auth/refresh') {
        return jsonResponse(200, {
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_in: 3_600,
        });
      }
      if (path === '/api/clawx/billing/checkout-info') {
        expect((init as { headers?: Record<string, string> }).headers?.Authorization)
          .toBe('Bearer fresh-access');
        return jsonResponse(200, { data: { balance: 12 } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await expect(requestManagedAuthenticatedJson('/api/clawx/billing/checkout-info'))
      .resolves.toEqual({ balance: 12 });
    expect(secrets.get('uclaw-auth')).toEqual(expect.objectContaining({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
    }));
  });

  it('maps rejected authenticated UClaw requests to an expired session', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'rejected-access',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() + 3_600_000,
    });
    mocks.proxyAwareFetch.mockResolvedValue(jsonResponse(401, {
      code: 'session_revoked',
      message: 'Session revoked',
    }));

    await expect(requestManagedAuthenticatedJson('/api/clawx/billing/checkout-info'))
      .rejects.toEqual(expect.objectContaining({ code: 'auth_expired', status: 401 }));
  });

  it('does not map authenticated UClaw 403 responses to an expired session', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'forbidden-access',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() + 3_600_000,
    });
    mocks.proxyAwareFetch.mockResolvedValue(jsonResponse(403, {
      code: 'auth_invalid',
      message: 'Forbidden',
    }));

    await expect(requestManagedAuthenticatedJson('/api/clawx/billing/checkout-info'))
      .rejects.toEqual(expect.objectContaining({ code: 'auth_invalid', status: 403 }));
  });

  it('commits a successful login to both managed Provider accounts', async () => {
    const result = await loginManagedAuth({
      account: 'test@example.com',
      password: 'password',
    });

    expect(result.success).toBe(true);
    expect(mocks.installManagedOpenAiProviderAccount).toHaveBeenCalledWith(
      PROVIDER_STORE_SNAPSHOT,
      expect.objectContaining({
        id: 'openai',
        vendorId: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
        apiProtocol: 'openai-responses',
        model: 'smart-latest',
        isDefault: true,
        metadata: expect.objectContaining({
          managedBy: 'uclaw',
          customModels: ['smart-latest', 'gpt-5.4'],
          managedAllowedModels: ['smart-latest', 'gpt-5.4'],
        }),
      }),
      expect.objectContaining({
        id: 'lingzhiwuxian',
        vendorId: 'lingzhiwuxian',
        label: 'UClaw',
        baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
        apiProtocol: 'openai-responses',
        model: 'smart-latest',
        isDefault: false,
        metadata: expect.objectContaining({
          managedBy: 'uclaw',
          customModels: ['smart-latest', 'gpt-5.4'],
          managedAllowedModels: ['smart-latest', 'gpt-5.4'],
        }),
      }),
    );
    expect(mocks.installManagedProviderSecrets).toHaveBeenCalledWith(
      PROVIDER_SECRET_SLOTS_SNAPSHOT,
      expect.objectContaining({
        type: 'oauth',
        accountId: 'uclaw-auth',
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
      }),
      expect.objectContaining({
        type: 'api_key',
        accountId: 'openai',
        apiKey: 'relay-secret',
        ownerUserId: 'user-1',
      }),
      expect.objectContaining({
        type: 'api_key',
        accountId: 'lingzhiwuxian',
        apiKey: 'relay-secret',
        ownerUserId: 'user-1',
      }),
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
    expect(secrets.get('lingzhiwuxian')).toEqual(expect.objectContaining({
      type: 'api_key',
      apiKey: 'relay-secret',
      ownerUserId: 'user-1',
    }));
    expect(defaultAccountId).toBe('openai');
    expect(mocks.markManagedDeviceActivated).toHaveBeenCalledWith(
      'login',
      expect.objectContaining({ id: 'user-1' }),
      expect.any(Object),
    );
    expect(mocks.installManagedAgentOpenAiApiKey).toHaveBeenCalledWith(
      AGENT_AUTH_PROFILES_SNAPSHOT,
      'relay-secret',
      new Set(['openai', 'lingzhiwuxian', 'openai-codex']),
    );
    expect(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot).not.toHaveBeenCalled();
    expect(openClawConfig).toMatchObject({
      agents: {
        defaults: {
          model: { primary: 'openai/smart-latest', fallbacks: [] },
          thinkingDefault: 'medium',
          reasoningDefault: 'on',
        },
      },
      models: {
        providers: {
          openai: {
            models: [
              expect.objectContaining({
                id: 'smart-latest',
                name: 'Smart Latest',
                contextWindow: 258_000,
                reasoning: true,
                compat: expect.objectContaining({ supportsReasoningEffort: true }),
              }),
              expect.objectContaining({ id: 'gpt-5.4', name: 'GPT-5.4' }),
            ],
          },
          lingzhiwuxian: {
            models: [
              expect.objectContaining({ id: 'smart-latest', name: 'Smart Latest' }),
              expect.objectContaining({ id: 'gpt-5.4', name: 'GPT-5.4' }),
            ],
          },
        },
      },
    });
    expect(mocks.updateManagedAgentModelProviderStrict).toHaveBeenCalledWith(
      { files: [] },
      expect.objectContaining({
        models: [
          expect.objectContaining({ id: 'smart-latest', contextWindow: 258_000 }),
          expect.objectContaining({ id: 'gpt-5.4', contextWindow: 258_000 }),
        ],
      }),
      new Set(['openai', 'lingzhiwuxian', 'openai-codex']),
    );
    expect(mocks.cacheManagedClientTextModelPolicyFromPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'access-secret',
        client: { modelOptions: { text: MANAGED_MODEL_POLICY } },
      }),
    );
  });

  it('snapshots every OpenAI Secret slot before installing the managed account', async () => {
    mocks.getManagedOpenAiTargetAccountIds.mockReturnValue([
      'openai-secondary',
      'openai-legacy-account',
    ]);

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' });

    expect(result.success).toBe(true);
    expect(mocks.getManagedOpenAiTargetAccountIds).toHaveBeenCalledWith(PROVIDER_STORE_SNAPSHOT);
    expect(new Set(mocks.snapshotProviderSecretSlots.mock.calls[0]?.[0])).toEqual(new Set([
      'openai-secondary',
      'openai-legacy-account',
      'openai',
      'openai-codex',
      'uclaw-auth',
      'lingzhiwuxian-auth',
      'lingzhiwuxian',
    ]));
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
    expect(mocks.installManagedOpenAiProviderAccount).not.toHaveBeenCalled();
    expect(mocks.installManagedProviderSecrets).not.toHaveBeenCalled();
  });

  it('preserves the previous managed session when registration activation validation fails', async () => {
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
    };
    const previousVerificationCache = {
      verifiedAt: Date.now(),
      verifyAfter: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    secrets.set('uclaw-auth', previousAuth);
    secrets.set('openai', previousRelay);
    verificationCache = previousVerificationCache;
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/activation/check') {
        return jsonResponse(200, { valid: false, errorCode: 'activation_used' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const gateway = createGateway('running');

    const result = await registerManagedAuth({
      account: 'test-user',
      username: 'test-user',
      password: 'Password1',
      activationCode: 'USED-CODE',
    }, gateway);

    expect(result).toEqual({ success: false, errorCode: 'activation_used' });
    expect(mocks.installManagedOpenAiProviderAccount).not.toHaveBeenCalled();
    expect(mocks.installManagedProviderSecrets).not.toHaveBeenCalled();
    expect(mocks.markManagedDeviceActivated).not.toHaveBeenCalled();
    expect(secrets.get('uclaw-auth')).toEqual(previousAuth);
    expect(secrets.get('openai')).toEqual(previousRelay);
    expect(verificationCache).toEqual(previousVerificationCache);
    expect(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot).not.toHaveBeenCalled();
    expect(gateway.reload).not.toHaveBeenCalled();
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
    expect(mocks.installManagedOpenAiProviderAccount).not.toHaveBeenCalled();
    expect(mocks.installManagedProviderSecrets).not.toHaveBeenCalled();
    expect(mocks.markManagedDeviceActivated).not.toHaveBeenCalled();
    expect(accountState).toBeNull();
    expect(secrets.size).toBe(0);
  });

  it('does not inherit a previous user refresh token when a different user logs in', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'previous-access',
      refreshToken: 'previous-refresh',
      expiresAt: Date.now() + 60_000,
      subject: 'previous-user',
      email: 'previous@example.com',
    });
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/login') {
        return jsonResponse(200, {
          accessToken: 'next-access',
          user: { id: 'next-user', email: 'next@example.com' },
        });
      }
      if (path === '/api/clawx/relay-token') {
        return jsonResponse(200, { token: 'next-relay' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const result = await loginManagedAuth({ account: 'next@example.com', password: 'password' });

    expect(result.success).toBe(true);
    expect(secrets.get('uclaw-auth')).toEqual(expect.objectContaining({
      accessToken: 'next-access',
      refreshToken: '',
      subject: 'next-user',
      email: 'next@example.com',
    }));
  });

  it('reuses an omitted refresh token only when the authenticated user is unchanged', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'previous-access',
      refreshToken: 'previous-refresh',
      expiresAt: Date.now() + 60_000,
      subject: 'user-1',
      email: 'test@example.com',
    });
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/login') {
        return jsonResponse(200, {
          accessToken: 'next-access',
          user: { id: 'user-1', email: 'test@example.com' },
        });
      }
      if (path === '/api/clawx/relay-token') {
        return jsonResponse(200, { token: 'next-relay' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' });

    expect(result.success).toBe(true);
    expect(secrets.get('uclaw-auth')).toEqual(expect.objectContaining({
      accessToken: 'next-access',
      refreshToken: 'previous-refresh',
      subject: 'user-1',
    }));
  });

  it('does not inherit the previous identity when a login response omits its user', async () => {
    const previousAuth: ProviderSecret = {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'previous-access',
      refreshToken: 'previous-refresh',
      expiresAt: Date.now() + 60_000,
      subject: 'previous-user',
    };
    secrets.set('uclaw-auth', previousAuth);
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/login') {
        return jsonResponse(200, {
          accessToken: 'next-access',
          refreshToken: 'next-refresh',
        });
      }
      if (path === '/api/clawx/relay-token') {
        return jsonResponse(200, { token: 'next-relay' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const result = await loginManagedAuth({ account: 'next@example.com', password: 'password' });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'auth_identity_missing',
    }));
    expect(secrets.get('uclaw-auth')).toEqual(previousAuth);
    expect(secrets.has('openai')).toBe(false);
    expect(mocks.installManagedOpenAiProviderAccount).not.toHaveBeenCalled();
    expect(mocks.installManagedProviderSecrets).not.toHaveBeenCalled();
    expect(mocks.installManagedAgentOpenAiApiKey).not.toHaveBeenCalled();
    expect(mocks.writeOpenClawConfig).not.toHaveBeenCalled();
  });

  it('fails before local mutation when the managed auth-profile snapshot cannot be read', async () => {
    mocks.snapshotManagedAgentAuthProfiles.mockRejectedValueOnce(new Error('auth profiles unreadable'));
    const gateway = createGateway('running');

    const result = await loginManagedAuth(
      { account: 'test@example.com', password: 'password' },
      gateway,
    );

    expect(result.success).toBe(false);
    expect(mocks.installManagedOpenAiProviderAccount).not.toHaveBeenCalled();
    expect(mocks.installManagedProviderSecrets).not.toHaveBeenCalled();
    expect(mocks.installManagedAgentOpenAiApiKey).not.toHaveBeenCalled();
    expect(mocks.writeOpenClawConfig).not.toHaveBeenCalled();
    expect(gateway.reload).not.toHaveBeenCalled();
  });

  it('preserves the previous managed session after a new login is rejected', async () => {
    const previousAccount: ProviderAccount = {
      id: 'openai',
      vendorId: 'openai',
      label: 'Previous OpenAI',
      authMode: 'api_key',
      baseUrl: 'https://previous.example/v1',
      apiProtocol: 'openai-responses',
      model: 'previous-model',
      enabled: true,
      isDefault: true,
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    };
    const previousAuth: ProviderSecret = {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'previous-access',
      refreshToken: 'previous-refresh',
      expiresAt: Date.now() + 60_000,
      subject: 'previous-user',
    };
    const previousRelay: ProviderSecret = {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'previous-relay',
      ownerUserId: 'previous-user',
    };
    const previousVerificationCache = {
      verifiedAt: Date.now(),
      verifyAfter: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    accountState = previousAccount;
    secrets.set('uclaw-auth', previousAuth);
    secrets.set('openai', previousRelay);
    verificationCache = previousVerificationCache;
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
    expect(accountState).toEqual(previousAccount);
    expect(secrets.get('uclaw-auth')).toEqual(previousAuth);
    expect(secrets.get('openai')).toEqual(previousRelay);
    expect(verificationCache).toEqual(previousVerificationCache);
    expect(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot).not.toHaveBeenCalled();
    expect(gateway.reload).not.toHaveBeenCalled();
  });

  it('preserves the previous managed session when relay acquisition fails', async () => {
    const previousAuth: ProviderSecret = {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'previous-access',
      refreshToken: 'previous-refresh',
      expiresAt: Date.now() + 60_000,
      subject: 'previous-user',
    };
    const previousRelay: ProviderSecret = {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'previous-relay',
      ownerUserId: 'previous-user',
    };
    const previousVerificationCache = {
      verifiedAt: Date.now(),
      verifyAfter: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    secrets.set('uclaw-auth', previousAuth);
    secrets.set('openai', previousRelay);
    verificationCache = previousVerificationCache;
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
    expect(secrets.get('uclaw-auth')).toEqual(previousAuth);
    expect(secrets.get('openai')).toEqual(previousRelay);
    expect(verificationCache).toEqual(previousVerificationCache);
    expect(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot).not.toHaveBeenCalled();
    expect(gateway.reload).not.toHaveBeenCalled();
  });

  it('preserves the previous managed session after a new registration is rejected', async () => {
    const previousAuth: ProviderSecret = {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'previous-access',
      refreshToken: 'previous-refresh',
      expiresAt: Date.now() + 60_000,
      subject: 'previous-user',
    };
    const previousRelay: ProviderSecret = {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'previous-relay',
      ownerUserId: 'previous-user',
    };
    secrets.set('uclaw-auth', previousAuth);
    secrets.set('openai', previousRelay);
    mocks.proxyAwareFetch.mockResolvedValue(jsonResponse(409, {
      code: 'account_exists',
      message: 'Account already exists',
    }));
    const gateway = createGateway('running');

    const result = await registerManagedAuth({
      account: 'test-user',
      username: 'test-user',
      password: 'Password1',
    }, gateway);

    expect(result.success).toBe(false);
    expect(secrets.get('uclaw-auth')).toEqual(previousAuth);
    expect(secrets.get('openai')).toEqual(previousRelay);
    expect(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot).not.toHaveBeenCalled();
    expect(gateway.reload).not.toHaveBeenCalled();
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
      fallbackAccountIds: ['moonshot'],
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
    openClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            api: 'openai-responses',
            apiKey: 'personal-runtime-secret',
            headers: { 'X-Personal': 'do-not-keep' },
            staleField: 'do-not-keep',
            models: [
              { id: 'personal-model', name: 'Personal Model' },
              { id: 'smart-latest', name: 'Existing Smart', cost: { input: 1 } },
            ],
          },
          'openai-codex': {
            baseUrl: 'https://chatgpt.com/backend-api/codex',
            api: 'openai-chatgpt-responses',
            models: [{ id: 'gpt-5.4', name: 'Legacy Codex' }],
          },
          'legacy-uclaw-relay': {
            baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1/',
            api: 'openai-responses',
            metadata: { customModels: ['legacy-uclaw-relay/smart-latest'] },
          },
          'ordinary-custom': {
            baseUrl: 'https://llm.example.com/v1',
            api: 'openai-responses',
            models: [{ id: 'smart-latest', name: 'Ordinary Custom' }],
          },
          moonshot: {
            baseUrl: 'https://api.moonshot.cn/v1',
            api: 'preserve-without-generic-self-heal',
          },
        },
      },
    };

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' });

    expect(result.success).toBe(true);
    expect(mocks.installManagedOpenAiProviderAccount).toHaveBeenCalledWith(
      PROVIDER_STORE_SNAPSHOT,
      expect.objectContaining({
        id: 'openai',
        vendorId: 'openai',
        baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
        apiProtocol: 'openai-responses',
        model: 'smart-latest',
        fallbackModels: [],
        metadata: expect.objectContaining({ managedBy: 'uclaw' }),
      }),
      expect.objectContaining({
        id: 'lingzhiwuxian',
        vendorId: 'lingzhiwuxian',
        model: 'smart-latest',
        isDefault: false,
        metadata: expect.objectContaining({ managedBy: 'uclaw' }),
      }),
    );
    expect(accountState?.headers).toBeUndefined();
    expect(accountState?.fallbackModels).toEqual([]);
    expect(accountState?.fallbackAccountIds).toEqual([]);
    expect(accountState?.metadata).toEqual({
      managedBy: 'uclaw',
      customModels: ['smart-latest', 'gpt-5.4'],
      managedDefaultModel: 'smart-latest',
      managedAllowedModels: ['smart-latest', 'gpt-5.4'],
      managedRuntimeContractVersion: 4,
      email: 'test@example.com',
    });
    expect(compatibilityAccountState?.metadata).toEqual(accountState?.metadata);
    expect(secrets.get('openai')).toEqual(expect.objectContaining({ apiKey: 'relay-secret' }));
    expect(secrets.get('lingzhiwuxian')).toEqual(expect.objectContaining({ apiKey: 'relay-secret' }));
    expect(((openClawConfig.models as Record<string, unknown>).providers as Record<string, unknown>).openai).toEqual({
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      api: 'openai-responses',
      agentRuntime: { id: 'pi' },
      models: [
        expect.objectContaining({
          id: 'smart-latest',
          name: 'Smart Latest',
          contextWindow: 258_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
        expect.objectContaining({
          id: 'gpt-5.4',
          name: 'GPT-5.4',
          contextWindow: 258_000,
        }),
      ],
    });
    expect((openClawConfig.agents as Record<string, unknown>).defaults).toEqual(expect.objectContaining({
      model: { primary: 'openai/smart-latest', fallbacks: [] },
    }));
    const runtimeProviders = (openClawConfig.models as Record<string, unknown>).providers as Record<string, unknown>;
    expect(runtimeProviders.lingzhiwuxian).toEqual(runtimeProviders.openai);
    expect(runtimeProviders['openai-codex']).toBeUndefined();
    expect(runtimeProviders['legacy-uclaw-relay']).toBeUndefined();
    expect(runtimeProviders['ordinary-custom']).toEqual({
      baseUrl: 'https://llm.example.com/v1',
      api: 'openai-responses',
      models: [{ id: 'smart-latest', name: 'Ordinary Custom' }],
    });
    expect(runtimeProviders.moonshot).toEqual({
      baseUrl: 'https://api.moonshot.cn/v1',
      api: 'preserve-without-generic-self-heal',
    });
  });

  it('overwrites an unmanaged OpenClaw-only provider without importing account cache state', async () => {
    openClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            api: 'openai-responses',
            headers: { 'X-OpenClaw-Only': 'remove' },
          },
          moonshot: { baseUrl: 'https://api.moonshot.cn/v1' },
        },
      },
    };

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' });

    expect(result.success).toBe(true);
    expect(mocks.installManagedOpenAiProviderAccount).toHaveBeenCalledWith(
      PROVIDER_STORE_SNAPSHOT,
      expect.objectContaining({ metadata: expect.objectContaining({ managedBy: 'uclaw' }) }),
      expect.objectContaining({
        id: 'lingzhiwuxian',
        metadata: expect.objectContaining({ managedBy: 'uclaw' }),
      }),
    );
    const providers = (openClawConfig.models as Record<string, unknown>).providers as Record<string, unknown>;
    expect(providers.openai).toEqual(expect.objectContaining({
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      api: 'openai-responses',
    }));
    expect(providers.openai).not.toHaveProperty('headers');
    expect(providers.lingzhiwuxian).toEqual(providers.openai);
    expect(providers.moonshot).toEqual({ baseUrl: 'https://api.moonshot.cn/v1' });
  });

  it('removes stale OpenAI auth metadata while preserving unrelated Provider routes', async () => {
    mocks.getManagedOpenAiTargetAccountIds.mockReturnValue(['openai', 'legacy-uclaw-relay']);
    openClawConfig = {
      auth: {
        profiles: {
          'openai:default': { provider: 'openai', mode: 'oauth' },
          'personal-openai': { provider: 'openai', mode: 'api_key' },
          'openai-codex:default': { provider: 'openai-codex', mode: 'oauth' },
          'arbitrary-legacy-profile': { provider: 'legacy-uclaw-relay', mode: 'api_key' },
          'ordinary-custom:default': { provider: 'ordinary-custom', mode: 'api_key' },
          'deepseek:default': { provider: 'deepseek', mode: 'api_key' },
        },
        order: {
          openai: ['openai:default', 'personal-openai'],
          'openai-codex': ['openai-codex:default'],
          'legacy-uclaw-relay': ['arbitrary-legacy-profile'],
          'ordinary-custom': ['ordinary-custom:default'],
          deepseek: ['deepseek:default'],
          routed: ['personal-openai', 'arbitrary-legacy-profile', 'ordinary-custom:default', 'deepseek:default'],
        },
        customPolicy: { keep: true },
      },
    };

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' });

    expect(result.success).toBe(true);
    expect(openClawConfig.auth).toEqual({
      profiles: {
        'ordinary-custom:default': { provider: 'ordinary-custom', mode: 'api_key' },
        'deepseek:default': { provider: 'deepseek', mode: 'api_key' },
      },
      order: {
        'ordinary-custom': ['ordinary-custom:default'],
        deepseek: ['deepseek:default'],
        routed: ['ordinary-custom:default', 'deepseek:default'],
      },
      customPolicy: { keep: true },
    });
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
    expect(mocks.installManagedOpenAiProviderAccount).toHaveBeenCalledWith(
      PROVIDER_STORE_SNAPSHOT,
      expect.objectContaining({
        vendorId: 'openai',
        model: 'smart-latest',
        metadata: expect.objectContaining({ managedBy: 'uclaw' }),
      }),
      expect.objectContaining({
        vendorId: 'lingzhiwuxian',
        model: 'smart-latest',
        metadata: expect.objectContaining({ managedBy: 'uclaw' }),
      }),
    );
    expect(mocks.markManagedDeviceActivated).toHaveBeenCalledWith(
      'register',
      expect.objectContaining({ id: 'user-1' }),
      expect.any(Object),
    );
    expect(mocks.installManagedAgentOpenAiApiKey).toHaveBeenCalledWith(
      AGENT_AUTH_PROFILES_SNAPSHOT,
      'relay-secret',
      new Set(['openai', 'lingzhiwuxian', 'openai-codex']),
    );
  });

  it('quiesces a running Gateway before writes and starts a new process after commit', async () => {
    const gateway = createGateway('running');
    const previousPid = gateway.getStatus().pid;

    const result = await loginManagedAuth(
      { account: 'test@example.com', password: 'password' },
      gateway,
    );

    expect(result.success).toBe(true);
    expect(gateway.acquireManagedRuntimeMutationLease).toHaveBeenCalledTimes(1);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.start).toHaveBeenCalledWith(RUNTIME_MUTATION_LEASE);
    expect(gateway.releaseManagedRuntimeMutationLease).toHaveBeenCalledWith(RUNTIME_MUTATION_LEASE);
    expect(mocks.markManagedRuntimeMutationStarted).toHaveBeenCalledWith(
      RUNTIME_MUTATION_LEASE,
      'commit-login',
    );
    expect(mocks.clearManagedRuntimeMutationMarker).toHaveBeenCalledWith(RUNTIME_MUTATION_LEASE);
    expect(mocks.quarantineManagedRuntimeMutation).not.toHaveBeenCalled();
    expect(gateway.reload).not.toHaveBeenCalled();
    expect(gateway.restart).not.toHaveBeenCalled();
    expect(gateway.getStatus()).toEqual(expect.objectContaining({
      state: 'running',
      pid: expect.any(Number),
    }));
    expect(gateway.getStatus().pid).not.toBe(previousPid);
    expect(mocks.waitForPortFree).toHaveBeenCalledWith(18_789, 10_000);
    expect(mocks.installManagedAgentOpenAiApiKey).toHaveBeenCalledWith(
      AGENT_AUTH_PROFILES_SNAPSHOT,
      'relay-secret',
      expect.any(Set),
    );
    const stopOrder = vi.mocked(gateway.stop).mock.invocationCallOrder[0];
    const portReleaseOrder = mocks.waitForPortFree.mock.invocationCallOrder[0];
    const markerOrder = mocks.markManagedRuntimeMutationStarted.mock.invocationCallOrder[0];
    const markerClearOrder = mocks.clearManagedRuntimeMutationMarker.mock.invocationCallOrder[0];
    const startOrder = vi.mocked(gateway.start).mock.invocationCallOrder[0];
    const releaseOrder = vi.mocked(gateway.releaseManagedRuntimeMutationLease).mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(portReleaseOrder);
    expect(portReleaseOrder).toBeLessThan(markerOrder);
    for (const snapshotStep of [
      mocks.ensureProviderStoreMigrated,
      mocks.snapshotManagedRuntimeConfig,
      mocks.snapshotManagedAgentModelsFiles,
      mocks.snapshotManagedProviderStore,
      mocks.snapshotProviderSecretSlots,
      mocks.snapshotManagedDeviceActivationFiles,
      mocks.snapshotManagedAgentAuthProfiles,
    ]) {
      expect(markerOrder).toBeLessThan(snapshotStep.mock.invocationCallOrder[0]);
    }
    for (const step of [
      mocks.installManagedOpenAiProviderAccount,
      mocks.installManagedProviderSecrets,
      mocks.installManagedAgentOpenAiApiKey,
      mocks.writeOpenClawConfig,
      mocks.updateManagedAgentModelProviderStrict,
      mocks.markManagedDeviceActivated,
    ]) {
      expect(portReleaseOrder).toBeLessThan(step.mock.invocationCallOrder[0]);
      expect(step.mock.invocationCallOrder[0]).toBeLessThan(startOrder);
    }
    expect(markerOrder).toBeLessThan(mocks.installManagedOpenAiProviderAccount.mock.invocationCallOrder[0]);
    expect(markerClearOrder).toBeLessThan(startOrder);
    expect(startOrder).toBeLessThan(releaseOrder);
    expect(mocks.snapshotManagedAgentAuthProfiles.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.installManagedAgentOpenAiApiKey.mock.invocationCallOrder[0],
    );
  });

  it('quarantines Gateway when a commit snapshot can fail after Provider migration writes', async () => {
    const gateway = createGateway('running');
    mocks.snapshotManagedRuntimeConfig.mockRejectedValueOnce(new Error('runtime snapshot failed'));

    const result = await loginManagedAuth(
      { account: 'test@example.com', password: 'password' },
      gateway,
    );

    expect(result.success).toBe(false);
    expect(mocks.markManagedRuntimeMutationStarted).toHaveBeenCalledWith(
      RUNTIME_MUTATION_LEASE,
      'commit-login',
    );
    expect(mocks.clearManagedRuntimeMutationMarker).not.toHaveBeenCalled();
    expect(mocks.quarantineManagedRuntimeMutation).toHaveBeenCalledWith(
      RUNTIME_MUTATION_LEASE,
      'commit-login',
      'managed authentication snapshot failed',
    );
    expect(mocks.installManagedOpenAiProviderAccount).not.toHaveBeenCalled();
    expect(mocks.installManagedProviderSecrets).not.toHaveBeenCalled();
    expect(mocks.installManagedAgentOpenAiApiKey).not.toHaveBeenCalled();
    expect(gateway.start).not.toHaveBeenCalled();
    expect(gateway.getStatus()).toEqual(expect.objectContaining({ state: 'stopped' }));
    expect(gateway.releaseManagedRuntimeMutationLease).toHaveBeenCalledWith(RUNTIME_MUTATION_LEASE);
    expect(mocks.markManagedRuntimeMutationStarted.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureProviderStoreMigrated.mock.invocationCallOrder[0],
    );
    expect(mocks.markManagedRuntimeMutationStarted.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.snapshotManagedRuntimeConfig.mock.invocationCallOrder[0],
    );
  });

  it('does not write local managed state when Gateway port release cannot be confirmed', async () => {
    const gateway = createGateway('running');
    mocks.waitForPortFree.mockRejectedValueOnce(new Error('port still occupied'));

    const result = await loginManagedAuth(
      { account: 'test@example.com', password: 'password' },
      gateway,
    );

    expect(result).toEqual(expect.objectContaining({ success: false, errorCode: 'gateway_stop_failed' }));
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.start).not.toHaveBeenCalled();
    expect(gateway.releaseManagedRuntimeMutationLease).toHaveBeenCalledWith(RUNTIME_MUTATION_LEASE);
    expect(mocks.markManagedRuntimeMutationStarted).not.toHaveBeenCalled();
    expect(mocks.ensureProviderStoreMigrated).not.toHaveBeenCalled();
    expect(mocks.snapshotManagedProviderStore).not.toHaveBeenCalled();
    expect(mocks.installManagedOpenAiProviderAccount).not.toHaveBeenCalled();
    expect(mocks.installManagedProviderSecrets).not.toHaveBeenCalled();
    expect(mocks.installManagedAgentOpenAiApiKey).not.toHaveBeenCalled();
    expect(mocks.writeOpenClawConfig).not.toHaveBeenCalled();
    expect(mocks.updateManagedAgentModelProviderStrict).not.toHaveBeenCalled();
    expect(mocks.markManagedDeviceActivated).not.toHaveBeenCalled();
  });

  it('does not reload or start a stopped Gateway', async () => {
    const gateway = createGateway('stopped');

    const result = await loginManagedAuth(
      { account: 'test@example.com', password: 'password' },
      gateway,
    );

    expect(result.success).toBe(true);
    expect(gateway.reload).not.toHaveBeenCalled();
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.start).not.toHaveBeenCalled();
  });

  it('clears current and legacy credentials on logout', async () => {
    mocks.getManagedOpenAiTargetAccountIds.mockReturnValue([
      'openai',
      'legacy-uclaw-relay',
    ]);
    mocks.getManagedRuntimeOpenAiProviderIds.mockReturnValue(['runtime-only-relay']);
    mocks.getManagedAgentOpenAiProviderIds.mockReturnValue(['agent-only-relay']);
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
    secrets.set('legacy-uclaw-relay', {
      type: 'api_key',
      accountId: 'legacy-uclaw-relay',
      apiKey: 'dynamic-legacy-relay',
    });
    secrets.set('runtime-only-relay', {
      type: 'api_key',
      accountId: 'runtime-only-relay',
      apiKey: 'runtime-only-key',
    });
    secrets.set('agent-only-relay', {
      type: 'api_key',
      accountId: 'agent-only-relay',
      apiKey: 'agent-only-key',
    });
    verificationCache = { verifiedAt: Date.now(), expiresAt: Date.now() + 60_000 };
    const gateway = createGateway('running');
    const previousPid = gateway.getStatus().pid;

    const result = await logoutManagedAuth(gateway);

    expect(result.success).toBe(true);
    expect(secrets.size).toBe(0);
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('uclaw-auth');
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('openai');
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('lingzhiwuxian-auth');
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('lingzhiwuxian');
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('legacy-uclaw-relay');
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('runtime-only-relay');
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('agent-only-relay');
    expect(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot).toHaveBeenCalledTimes(1);
    expect(new Set(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot.mock.calls[0]?.[1])).toEqual(new Set([
      'openai',
      'openai-codex',
      'lingzhiwuxian',
      'legacy-uclaw-relay',
      'runtime-only-relay',
      'agent-only-relay',
    ]));
    expect(mocks.removeManagedAgentOpenAiProviders).toHaveBeenCalledTimes(1);
    expect(mocks.removeManagedRuntimeOpenAiState).toHaveBeenCalledTimes(1);
    expect(new Set(mocks.removeManagedAgentOpenAiProviders.mock.calls[0]?.[1])).toEqual(
      new Set(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot.mock.calls[0]?.[1]),
    );
    expect(new Set(mocks.removeManagedRuntimeOpenAiState.mock.calls[0]?.[1])).toEqual(
      new Set(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot.mock.calls[0]?.[1]),
    );
    expect(mocks.storeDelete).toHaveBeenCalledWith('uclawVerificationCache');
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(gateway.restart).not.toHaveBeenCalled();
    expect(gateway.reload).not.toHaveBeenCalled();
    expect(gateway.getStatus().state).toBe('running');
    expect(gateway.getStatus().pid).not.toBe(previousPid);
  });

  it('stops Gateway before waiting for remote logout and before clearing local credentials', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() + 60_000,
    });
    let resolveLogout!: (response: ReturnType<typeof jsonResponse>) => void;
    const logoutResponse = new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
      resolveLogout = resolve;
    });
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      if (requestPath(input) === '/api/clawx/auth/logout') return logoutResponse;
      throw new Error(`Unexpected request: ${requestPath(input)}`);
    });
    const gateway = createGateway('running');

    const resultPromise = logoutManagedAuth(gateway);
    await vi.waitFor(() => expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1));

    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(mocks.waitForPortFree).toHaveBeenCalledTimes(1);
    expect(mocks.deleteProviderSecret).not.toHaveBeenCalled();
    expect(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot).not.toHaveBeenCalled();

    resolveLogout(jsonResponse(200, { success: true }));
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(mocks.deleteProviderSecret).toHaveBeenCalled();
    expect(gateway.start).toHaveBeenCalledTimes(1);
  });

  it('returns a logged-out status when Gateway start fails after local cleanup', async () => {
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
    vi.mocked(gateway.start).mockRejectedValueOnce(new Error('start failed'));

    const result = await logoutManagedAuth(gateway);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      status: expect.objectContaining({
        hasAuthToken: false,
        hasRefreshToken: false,
        hasRelayToken: false,
        authValid: false,
        gatewayReloaded: false,
        gatewayReloadError: 'Gateway start failed',
      }),
    }));
    expect(secrets.size).toBe(0);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.getStatus().state).toBe('stopped');
  });

  it('restores a reconnecting Gateway to running after logout clears local credentials', async () => {
    const gateway = createGateway('reconnecting');

    const result = await logoutManagedAuth(gateway);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      status: expect.objectContaining({
        hasAuthToken: false,
        hasRelayToken: false,
        gatewayReloaded: true,
      }),
    }));
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(gateway.reload).not.toHaveBeenCalled();
    expect(gateway.restart).not.toHaveBeenCalled();
    expect(gateway.getStatus().state).toBe('running');
  });

  it('stops Gateway when start resolves into an unhealthy state during logout', async () => {
    let gatewayState: ReturnType<GatewayManager['getStatus']>['state'] = 'running';
    let gatewayPid: number | undefined = 100;
    const gateway = {
      getStatus: vi.fn(() => ({ state: gatewayState, port: 18_789, pid: gatewayPid })),
      acquireManagedRuntimeMutationLease: vi.fn(() => mocks.acquireManagedRuntimeMutationLease()),
      releaseManagedRuntimeMutationLease: vi.fn((lease) => mocks.releaseManagedRuntimeMutationLease(lease)),
      start: vi.fn().mockImplementation(async () => {
        gatewayState = 'reconnecting';
        gatewayPid = 101;
      }),
      stop: vi.fn().mockImplementation(async () => {
        gatewayState = 'stopped';
        gatewayPid = undefined;
      }),
    } as unknown as GatewayManager;

    const result = await logoutManagedAuth(gateway);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      status: expect.objectContaining({
        gatewayReloaded: false,
        gatewayReloadError: 'Gateway start did not remain healthy',
      }),
    }));
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(gateway.stop).toHaveBeenCalledTimes(2);
    expect(gateway.getStatus().state).toBe('stopped');
  });

  it('fails closed when start reuses the previous Gateway process id', async () => {
    let gatewayState: ReturnType<GatewayManager['getStatus']>['state'] = 'running';
    let gatewayPid: number | undefined = 100;
    const gateway = {
      getStatus: vi.fn(() => ({ state: gatewayState, port: 18_789, pid: gatewayPid })),
      acquireManagedRuntimeMutationLease: vi.fn(() => mocks.acquireManagedRuntimeMutationLease()),
      releaseManagedRuntimeMutationLease: vi.fn((lease) => mocks.releaseManagedRuntimeMutationLease(lease)),
      start: vi.fn().mockImplementation(async () => {
        gatewayState = 'running';
        gatewayPid = 100;
      }),
      stop: vi.fn().mockImplementation(async () => {
        gatewayState = 'stopped';
        gatewayPid = undefined;
      }),
    } as unknown as GatewayManager;

    const result = await logoutManagedAuth(gateway);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      status: expect.objectContaining({
        gatewayReloaded: false,
        gatewayReloadError: 'Gateway start did not remain healthy',
      }),
    }));
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(gateway.stop).toHaveBeenCalledTimes(2);
  });

  it('fails closed when Gateway pid is unavailable after credential removal', async () => {
    let gatewayState: ReturnType<GatewayManager['getStatus']>['state'] = 'running';
    const gateway = {
      getStatus: vi.fn(() => ({ state: gatewayState, port: 18_789 })),
      acquireManagedRuntimeMutationLease: vi.fn(() => mocks.acquireManagedRuntimeMutationLease()),
      releaseManagedRuntimeMutationLease: vi.fn((lease) => mocks.releaseManagedRuntimeMutationLease(lease)),
      start: vi.fn().mockImplementation(async () => {
        gatewayState = 'running';
      }),
      stop: vi.fn().mockImplementation(async () => {
        gatewayState = 'stopped';
      }),
    } as unknown as GatewayManager;

    const result = await logoutManagedAuth(gateway);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      status: expect.objectContaining({ gatewayReloadError: 'Gateway start did not remain healthy' }),
    }));
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(gateway.stop).toHaveBeenCalledTimes(2);
  });

  it('keeps an already stopped Gateway stopped during logout', async () => {
    const gateway = createGateway('stopped');

    const result = await logoutManagedAuth(gateway);

    expect(result.success).toBe(true);
    expect(gateway.restart).not.toHaveBeenCalled();
    expect(gateway.reload).not.toHaveBeenCalled();
    expect(gateway.stop).toHaveBeenCalledTimes(1);
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

  it('starts a fresh authoritative verification after an older forced status flight', async () => {
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
        return jsonResponse(401, { code: 'session_revoked', message: 'Session revoked' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const gateway = createGateway('running');

    const older = getManagedAuthStatus({ force: true }, gateway);
    await vi.waitFor(() => expect(verifyCalls).toBe(1));
    const fresh = getFreshManagedAuthStatus(gateway);
    resolveFirst(jsonResponse(200, { valid: true, user: { id: 'user-1' } }));

    const [olderStatus, freshStatus] = await Promise.all([older, fresh]);
    expect(olderStatus.authValid).toBe(true);
    expect(freshStatus).toEqual(expect.objectContaining({ authRejected: true }));
    expect(verifyCalls).toBe(2);
  });

  it('preserves an older authoritative rejection instead of downgrading it after cleanup', async () => {
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
      expiresAt: Date.now() + 60_000,
    });
    let resolveVerify!: (value: ReturnType<typeof jsonResponse>) => void;
    const verifyResponse = new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
      resolveVerify = resolve;
    });
    let verifyCalls = 0;
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/bootstrap') return jsonResponse(200, {});
      if (path === '/api/clawx/auth/verify') {
        verifyCalls += 1;
        return verifyResponse;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const gateway = createGateway('running');

    const older = getManagedAuthStatus({ force: true }, gateway);
    await vi.waitFor(() => expect(verifyCalls).toBe(1));
    const fresh = getFreshManagedAuthStatus(gateway);
    resolveVerify(jsonResponse(401, { code: 'session_revoked', message: 'Session revoked' }));

    const [olderStatus, freshStatus] = await Promise.all([older, fresh]);
    expect(olderStatus).toEqual(expect.objectContaining({ authRejected: true }));
    expect(freshStatus).toBe(olderStatus);
    expect(verifyCalls).toBe(1);
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

  it('quiesces and starts Gateway when remote status replenishes a relay token', async () => {
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
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(gateway.reload).not.toHaveBeenCalled();
    expect(gateway.restart).not.toHaveBeenCalled();
  });

  it('does not pre-commit verification cache or device activation before relay recovery', async () => {
    const previousActivation = {
      version: 1 as const,
      deviceId: DEVICE.id,
      activated: true as const,
      onboardingCompleted: true as const,
      activatedAt: '2026-07-22T00:00:00.000Z',
      lastSeenAt: '2026-07-22T00:00:00.000Z',
      source: 'login' as const,
      userId: 'user-1',
    };
    const previousVerificationCache = {
      verifiedAt: Date.now() - 60_000,
      verifyAfter: Date.now() - 30_000,
      expiresAt: Date.now() + 60_000,
      user: { id: 'user-1' },
    };
    activationState = previousActivation;
    verificationCache = previousVerificationCache;
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
        return jsonResponse(200, {
          valid: true,
          user: { id: 'user-1' },
          device: { status: 'active' },
        });
      }
      if (path === '/api/clawx/relay-token') {
        return jsonResponse(200, { token: 'replenished-relay' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    mocks.updateManagedAgentModelProviderStrict.mockRejectedValueOnce(new Error('agent models write failed'));
    const gateway = createGateway('running');

    const result = await refreshManagedAuth({ force: true }, gateway);

    expect(result.success).toBe(false);
    expect(verificationCache).toEqual(previousVerificationCache);
    expect(activationState).toEqual(previousActivation);
    expect(mocks.restoreManagedAgentAuthProfiles).toHaveBeenCalledWith(AGENT_AUTH_PROFILES_SNAPSHOT);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(gateway.getStatus().state).toBe('running');
    expect(gateway.reload).not.toHaveBeenCalled();
  });

  it('does not wait for reload stability before quiescing a recently connected Gateway', async () => {
    const gateway = createGateway('running');

    const result = await loginManagedAuth(
      { account: 'test@example.com', password: 'password' },
      gateway,
    );

    expect(result.success).toBe(true);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(gateway.reload).not.toHaveBeenCalled();
  });

  it('keeps newly committed credentials and stops Gateway when start fails', async () => {
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
    vi.mocked(gateway.start).mockRejectedValueOnce(new Error('start failed'));

    const result = await loginManagedAuth(
      { account: 'test@example.com', password: 'password' },
      gateway,
    );

    expect(result).toEqual(expect.objectContaining({
      success: true,
      status: expect.objectContaining({
        gatewayReloaded: false,
        gatewayReloadError: 'Gateway start failed',
      }),
    }));
    expect(secrets.get('uclaw-auth')).toEqual(expect.objectContaining({ accessToken: 'access-secret' }));
    expect(secrets.get('openai')).toEqual(expect.objectContaining({ apiKey: 'relay-secret' }));
    expect(mocks.installManagedAgentOpenAiApiKey).toHaveBeenCalledTimes(1);
    expect(mocks.restoreManagedAgentAuthProfiles).not.toHaveBeenCalled();
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.getStatus().state).toBe('stopped');
  });

  it('restores provider storage and OpenClaw credentials after managed key installation fails', async () => {
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
    mocks.installManagedAgentOpenAiApiKey.mockRejectedValueOnce(new Error('managed auth-profile write failed'));
    const gateway = createGateway('running');

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' }, gateway);

    expect(result.success).toBe(false);
    expect(accountState).toEqual(previousAccount);
    expect(secrets.get('uclaw-auth')).toEqual(previousAuth);
    expect(secrets.get('openai')).toEqual(previousRelay);
    expect(defaultAccountId).toBe('moonshot');
    expect(legacyDefaultProvider).toBe('moonshot');
    expect(mocks.restoreManagedProviderStore).toHaveBeenCalledWith(PROVIDER_STORE_SNAPSHOT);
    expect(mocks.restoreProviderSecretSlots).toHaveBeenCalledWith(PROVIDER_SECRET_SLOTS_SNAPSHOT);
    expect(mocks.restoreManagedAgentAuthProfiles).toHaveBeenCalledWith(AGENT_AUTH_PROFILES_SNAPSHOT);
    expect(mocks.updateManagedAgentModelProviderStrict).not.toHaveBeenCalled();
    expect(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot).not.toHaveBeenCalled();
    expect(gateway.reload).not.toHaveBeenCalled();
  });

  it('removes a newly installed runtime default when the previous config had none', async () => {
    openClawConfig = {
      agents: { defaults: { workspace: '/previous/workspace' } },
    };
    mocks.writeOpenClawConfig.mockRejectedValueOnce(new Error('managed runtime defaults failed'));
    const gateway = createGateway('running');

    const result = await loginManagedAuth(
      { account: 'test@example.com', password: 'password' },
      gateway,
    );

    expect(result.success).toBe(false);
    expect(openClawConfig).toEqual({
      agents: { defaults: { workspace: '/previous/workspace' } },
    });
    expect(gateway.reload).not.toHaveBeenCalled();
  });

  it('restores the previous device activation before Gateway reload when final status assembly fails', async () => {
    const previousActivation = {
      version: 1 as const,
      deviceId: DEVICE.id,
      activated: true as const,
      onboardingCompleted: true as const,
      activatedAt: '2026-07-22T00:00:00.000Z',
      lastSeenAt: '2026-07-22T00:00:00.000Z',
      source: 'login' as const,
      userId: 'previous-user',
    };
    activationState = previousActivation;
    mocks.readManagedDeviceActivationState.mockRejectedValueOnce(new Error('activation read failed'));
    const gateway = createGateway('running');

    const result = await loginManagedAuth(
      { account: 'test@example.com', password: 'password' },
      gateway,
    );

    expect(result.success).toBe(false);
    expect(activationState).toEqual(previousActivation);
    expect(mocks.restoreManagedDeviceActivationFiles).toHaveBeenCalledTimes(2);
    expect(mocks.restoreManagedDeviceActivationFiles).toHaveBeenCalledWith({
      current: expect.objectContaining({ path: '/test/uclaw-device-activation.json' }),
    });
    expect(mocks.restoreManagedDeviceActivationFiles).toHaveBeenCalledWith({
      stable: expect.objectContaining({ path: '/test/stable/uclaw-device-activation.json' }),
    });
    expect(mocks.restoreManagedAgentAuthProfiles).toHaveBeenCalledWith(AGENT_AUTH_PROFILES_SNAPSHOT);
    expect(gateway.reload).not.toHaveBeenCalled();
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(gateway.getStatus().state).toBe('running');
  });

  it('restores the complete OpenAI runtime entry when strict agent model installation fails', async () => {
    const previousAccount: ProviderAccount = {
      id: 'openai',
      vendorId: 'openai',
      label: 'Previous OpenAI',
      authMode: 'api_key',
      baseUrl: 'https://previous.example/v1',
      apiProtocol: 'openai-responses',
      model: 'previous-model',
      enabled: true,
      isDefault: false,
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
    };
    const previousRuntimeProvider = {
      baseUrl: 'https://previous.example/v1',
      api: 'openai-responses',
      headers: { 'X-Previous': 'keep' },
      staleField: { keep: true },
      models: [{ id: 'previous-model', name: 'Previous Model' }],
    };
    const previousLegacyRuntimeProvider = {
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      api: 'openai-chatgpt-responses',
      models: [{ id: 'gpt-5.4', name: 'Legacy Codex' }],
    };
    const previousRuntimeAuth = {
      profiles: {
        'openai:default': { provider: 'openai', mode: 'oauth' },
        'deepseek:default': { provider: 'deepseek', mode: 'api_key' },
      },
      order: {
        openai: ['openai:default'],
        deepseek: ['deepseek:default'],
      },
    };
    accountState = previousAccount;
    secrets.set('uclaw-auth', previousAuth);
    secrets.set('openai', previousRelay);
    defaultAccountId = 'moonshot';
    legacyDefaultProvider = 'moonshot';
    openClawConfig = {
      auth: previousRuntimeAuth,
      models: {
        providers: {
          openai: previousRuntimeProvider,
          'openai-codex': previousLegacyRuntimeProvider,
          moonshot: { baseUrl: 'https://api.moonshot.cn/v1' },
        },
      },
    };
    mocks.updateManagedAgentModelProviderStrict.mockRejectedValueOnce(new Error('agent models write failed'));
    const gateway = createGateway('running');

    const result = await loginManagedAuth(
      { account: 'test@example.com', password: 'password' },
      gateway,
    );

    expect(result.success).toBe(false);
    expect(accountState).toEqual(previousAccount);
    expect(secrets.get('uclaw-auth')).toEqual(previousAuth);
    expect(secrets.get('openai')).toEqual(previousRelay);
    expect(openClawConfig.auth).toEqual(previousRuntimeAuth);
    const providers = (openClawConfig.models as Record<string, unknown>).providers as Record<string, unknown>;
    expect(providers.openai).toEqual(previousRuntimeProvider);
    expect(providers['openai-codex']).toEqual(previousLegacyRuntimeProvider);
    expect(providers.moonshot).toEqual({ baseUrl: 'https://api.moonshot.cn/v1' });
    expect(mocks.restoreManagedProviderStore).toHaveBeenCalledWith(PROVIDER_STORE_SNAPSHOT);
    expect(mocks.restoreProviderSecretSlots).toHaveBeenCalledWith(PROVIDER_SECRET_SLOTS_SNAPSHOT);
    expect(mocks.restoreManagedAgentModelsFiles).toHaveBeenCalledWith({ files: [] });
    expect(mocks.restoreManagedAgentAuthProfiles).toHaveBeenCalledWith(AGENT_AUTH_PROFILES_SNAPSHOT);
    expect(mocks.restoreManagedAgentModelsFiles.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.restoreManagedAgentAuthProfiles.mock.invocationCallOrder[0],
    );
    expect(mocks.restoreManagedDeviceActivationFiles).not.toHaveBeenCalled();
    expect(gateway.reload).not.toHaveBeenCalled();
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(gateway.getStatus().state).toBe('running');
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
    mocks.updateManagedAgentModelProviderStrict.mockRejectedValueOnce(new Error('agent models write failed'));
    mocks.restoreManagedProviderStore.mockRejectedValueOnce(new Error('provider restore failed'));

    const gateway = createGateway('running');
    const result = await loginManagedAuth(
      { account: 'test@example.com', password: 'password' },
      gateway,
    );

    expect(result).toEqual(expect.objectContaining({ success: false, errorCode: 'rollback_failed' }));
    expect(mocks.restoreManagedProviderStore).toHaveBeenCalledWith(PROVIDER_STORE_SNAPSHOT);
    expect(mocks.restoreProviderSecretSlots).toHaveBeenCalledWith(PROVIDER_SECRET_SLOTS_SNAPSHOT);
    expect(mocks.restoreManagedAgentModelsFiles).toHaveBeenCalledWith({ files: [] });
    expect(mocks.restoreManagedAgentAuthProfiles).toHaveBeenCalledWith(AGENT_AUTH_PROFILES_SNAPSHOT);
    expect(openClawConfig).toEqual(expect.objectContaining({
      agents: { defaults: { thinkingDefault: 'low', reasoningDefault: 'off' } },
    }));
    expect(gateway.reload).not.toHaveBeenCalled();
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.start).not.toHaveBeenCalled();
    expect(gateway.getStatus().state).toBe('stopped');
    expect(mocks.quarantineManagedRuntimeMutation).toHaveBeenCalledWith(
      RUNTIME_MUTATION_LEASE,
      'commit-login',
      'managed authentication rollback failed',
    );
    expect(mocks.clearManagedRuntimeMutationMarker).not.toHaveBeenCalled();
    expect(gateway.releaseManagedRuntimeMutationLease).toHaveBeenCalledWith(RUNTIME_MUTATION_LEASE);
  });

  it('keeps legacy defaultProvider and defaultProviderAccountId consistent after login', async () => {
    defaultAccountId = 'moonshot';
    legacyDefaultProvider = 'moonshot';

    const result = await loginManagedAuth({ account: 'test@example.com', password: 'password' });

    expect(result.success).toBe(true);
    expect(defaultAccountId).toBe('openai');
    expect(legacyDefaultProvider).toBe('openai');
  });

  it.each([400, 403, 500])(
    'preserves credentials and Gateway state when verification returns non-authoritative HTTP %i',
    async (httpStatus) => {
      const authSecret: ProviderSecret = {
        type: 'oauth',
        accountId: 'uclaw-auth',
        accessToken: 'forbidden-access',
        refreshToken: 'forbidden-refresh',
        expiresAt: Date.now() + 3_600_000,
        subject: 'user-1',
      };
      const relaySecret: ProviderSecret = {
        type: 'api_key',
        accountId: 'openai',
        apiKey: 'preserved-relay',
        ownerUserId: 'user-1',
      };
      secrets.set('uclaw-auth', authSecret);
      secrets.set('openai', relaySecret);
      verificationCache = {
        verifiedAt: Date.now() - 10_000,
        verifyAfter: Date.now() - 1,
        expiresAt: Date.now() - 1,
        user: { id: 'user-1' },
      };
      mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
        const path = requestPath(input);
        if (path === '/api/clawx/bootstrap') return jsonResponse(200, {});
        if (path === '/api/clawx/auth/verify') {
          return jsonResponse(httpStatus, { code: 'auth_invalid', message: 'Verification failed' });
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      const gateway = createGateway('running');

      const status = await getManagedAuthStatus({ force: true }, gateway);

      expect(status).toEqual(expect.objectContaining({
        authValid: false,
        authRejected: false,
        authErrorCode: 'auth_invalid',
      }));
      expect(secrets.get('uclaw-auth')).toEqual(authSecret);
      expect(secrets.get('openai')).toEqual(relaySecret);
      expect(mocks.deleteProviderSecret).not.toHaveBeenCalled();
      expect(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot).not.toHaveBeenCalled();
      expect(gateway.stop).not.toHaveBeenCalled();
      expect(mocks.markManagedRuntimeMutationStarted).not.toHaveBeenCalled();
    },
  );

  it('quarantines Gateway when an invalidation snapshot can fail after Provider migration writes', async () => {
    const authSecret: ProviderSecret = {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'rejected-access',
      refreshToken: 'rejected-refresh',
      expiresAt: Date.now() + 3_600_000,
      subject: 'user-1',
    };
    const relaySecret: ProviderSecret = {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'rejected-relay',
      ownerUserId: 'user-1',
    };
    secrets.set('uclaw-auth', authSecret);
    secrets.set('openai', relaySecret);
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
    mocks.snapshotManagedRuntimeConfig.mockRejectedValueOnce(new Error('runtime snapshot failed'));
    const gateway = createGateway('running');

    const status = await getManagedAuthStatus({ force: true }, gateway);

    expect(status).toEqual(expect.objectContaining({
      authValid: false,
      authRejected: true,
    }));
    expect(secrets.get('uclaw-auth')).toEqual(authSecret);
    expect(secrets.get('openai')).toEqual(relaySecret);
    expect(mocks.deleteProviderSecret).not.toHaveBeenCalled();
    expect(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot).not.toHaveBeenCalled();
    expect(mocks.markManagedRuntimeMutationStarted).toHaveBeenCalledWith(
      RUNTIME_MUTATION_LEASE,
      'invalidate-session',
    );
    expect(mocks.clearManagedRuntimeMutationMarker).not.toHaveBeenCalled();
    expect(mocks.quarantineManagedRuntimeMutation).toHaveBeenCalledWith(
      RUNTIME_MUTATION_LEASE,
      'invalidate-session',
      'managed session snapshot failed',
    );
    expect(gateway.start).not.toHaveBeenCalled();
    expect(gateway.getStatus()).toEqual(expect.objectContaining({ state: 'stopped' }));
    expect(gateway.releaseManagedRuntimeMutationLease).toHaveBeenCalledWith(RUNTIME_MUTATION_LEASE);
    expect(mocks.markManagedRuntimeMutationStarted.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureProviderStoreMigrated.mock.invocationCallOrder[0],
    );
    expect(mocks.markManagedRuntimeMutationStarted.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.snapshotManagedRuntimeConfig.mock.invocationCallOrder[0],
    );
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
    mocks.getManagedOpenAiTargetAccountIds.mockReturnValue(['openai', 'legacy-uclaw-relay']);
    secrets.set('legacy-uclaw-relay', {
      type: 'api_key',
      accountId: 'legacy-uclaw-relay',
      apiKey: 'rejected-dynamic-relay',
      ownerUserId: 'user-1',
    });
    const gateway = createGateway('running');
    const previousPid = gateway.getStatus().pid;

    const status = await getManagedAuthStatus({ force: true }, gateway);

    expect(status).toEqual(expect.objectContaining({
      authValid: false,
      authRejected: true,
      authErrorCode: 'session_revoked',
      hasAuthToken: false,
      hasRelayToken: false,
    }));
    expect(secrets.size).toBe(0);
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('legacy-uclaw-relay');
    expect(new Set(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot.mock.calls[0]?.[1])).toEqual(new Set([
      'openai',
      'openai-codex',
      'lingzhiwuxian',
      'legacy-uclaw-relay',
    ]));
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(gateway.restart).not.toHaveBeenCalled();
    expect(gateway.reload).not.toHaveBeenCalled();
    expect(gateway.getStatus().state).toBe('running');
    expect(gateway.getStatus().pid).not.toBe(previousPid);
  });

  it('fails stop after Agent auth cleanup fails and preserves later discovery anchors', async () => {
    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'previous-access',
      refreshToken: 'previous-refresh',
      expiresAt: Date.now() + 3_600_000,
    });
    secrets.set('openai', {
      type: 'api_key',
      accountId: 'openai',
      apiKey: 'previous-relay',
    });
    verificationCache = { verifiedAt: Date.now(), verifyAfter: Date.now(), expiresAt: Date.now() + 60_000 };
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const path = requestPath(input);
      if (path === '/api/clawx/bootstrap') return jsonResponse(200, {});
      if (path === '/api/clawx/auth/verify') {
        return jsonResponse(401, { code: 'session_revoked', message: 'Session revoked' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    mocks.removeManagedAgentOpenAiCredentialsFromSnapshot.mockRejectedValueOnce(new Error('runtime write failed'));
    const gateway = createGateway('running');

    const status = await getManagedAuthStatus({ force: true }, gateway);

    expect(status).toEqual(expect.objectContaining({
      authValid: false,
      authRejected: true,
      authErrorCode: 'session_cleanup_failed',
    }));
    expect(secrets.size).toBe(0);
    expect(verificationCache).toBeUndefined();
    expect(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.removeManagedAgentOpenAiProviders).not.toHaveBeenCalled();
    expect(mocks.removeManagedRuntimeOpenAiState).not.toHaveBeenCalled();
    expect(gateway.reload).not.toHaveBeenCalled();
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.getStatus().state).toBe('stopped');
    expect(mocks.quarantineManagedRuntimeMutation).toHaveBeenCalledWith(
      RUNTIME_MUTATION_LEASE,
      'invalidate-session',
      'managed session cleanup failed',
    );
    expect(mocks.clearManagedRuntimeMutationMarker).not.toHaveBeenCalled();
    expect(gateway.releaseManagedRuntimeMutationLease).toHaveBeenCalledWith(RUNTIME_MUTATION_LEASE);
  });

  it('retries a quarantined logout using dynamic provider ids preserved in runtime and Agent models', async () => {
    const dynamicProviderId = 'runtime-model-only-relay';
    const agentAuthProviderIds = new Set([dynamicProviderId]);
    const agentModelProviderIds = new Set([dynamicProviderId]);
    const runtimeProviderIds = new Set([dynamicProviderId]);
    type ProviderIdsSnapshot = { providerIds: string[] };

    mocks.getManagedOpenAiTargetAccountIds.mockReturnValue(['openai']);
    mocks.snapshotManagedRuntimeConfig.mockImplementation(async (): Promise<ProviderIdsSnapshot> => ({
      providerIds: [...runtimeProviderIds],
    }));
    mocks.getManagedRuntimeOpenAiProviderIds.mockImplementation(
      (snapshotValue: ProviderIdsSnapshot) => [...snapshotValue.providerIds],
    );
    mocks.snapshotManagedAgentModelsFiles.mockImplementation(async (): Promise<ProviderIdsSnapshot> => ({
      providerIds: [...agentModelProviderIds],
    }));
    mocks.getManagedAgentOpenAiProviderIds.mockImplementation(
      (snapshotValue: ProviderIdsSnapshot) => [...snapshotValue.providerIds],
    );
    mocks.snapshotManagedAgentAuthProfiles.mockImplementation(async (): Promise<ProviderIdsSnapshot> => ({
      providerIds: [...agentAuthProviderIds],
    }));
    mocks.removeManagedAgentOpenAiCredentialsFromSnapshot.mockImplementation(async (
      _snapshotValue: unknown,
      managedProviderIds: ReadonlySet<string>,
    ) => {
      for (const providerId of managedProviderIds) agentAuthProviderIds.delete(providerId);
    });
    mocks.removeManagedAgentOpenAiProviders.mockImplementation(async (
      _snapshotValue: unknown,
      managedProviderIds: ReadonlySet<string>,
    ) => {
      for (const providerId of managedProviderIds) agentModelProviderIds.delete(providerId);
    });
    mocks.removeManagedRuntimeOpenAiState.mockImplementation(async (
      _snapshotValue: unknown,
      managedProviderIds: ReadonlySet<string>,
    ) => {
      for (const providerId of managedProviderIds) runtimeProviderIds.delete(providerId);
    });

    secrets.set('uclaw-auth', {
      type: 'oauth',
      accountId: 'uclaw-auth',
      accessToken: 'previous-access',
      refreshToken: 'previous-refresh',
      expiresAt: Date.now() + 3_600_000,
    });
    secrets.set(dynamicProviderId, {
      type: 'api_key',
      accountId: dynamicProviderId,
      apiKey: 'dynamic-relay-secret',
    });
    let dynamicSecretDeleteAttempts = 0;
    mocks.deleteProviderSecret.mockImplementation(async (accountId: string) => {
      if (accountId === dynamicProviderId && dynamicSecretDeleteAttempts++ === 0) {
        throw new Error('dynamic Secret deletion failed');
      }
      secrets.delete(accountId);
    });
    const gateway = createGateway('running');

    const firstResult = await logoutManagedAuth(gateway);

    expect(firstResult).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'session_cleanup_failed',
    }));
    expect(secrets.has(dynamicProviderId)).toBe(true);
    expect(agentAuthProviderIds.has(dynamicProviderId)).toBe(true);
    expect(agentModelProviderIds.has(dynamicProviderId)).toBe(true);
    expect(runtimeProviderIds.has(dynamicProviderId)).toBe(true);
    expect(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot).not.toHaveBeenCalled();
    expect(mocks.removeManagedAgentOpenAiProviders).not.toHaveBeenCalled();
    expect(mocks.removeManagedRuntimeOpenAiState).not.toHaveBeenCalled();
    expect(mocks.quarantineManagedRuntimeMutation).toHaveBeenCalledWith(
      RUNTIME_MUTATION_LEASE,
      'logout',
      'managed logout cleanup failed',
    );
    expect(mocks.clearManagedRuntimeMutationMarker).not.toHaveBeenCalled();

    const secondResult = await logoutManagedAuth(gateway);

    expect(secondResult.success).toBe(true);
    expect(dynamicSecretDeleteAttempts).toBe(2);
    expect(secrets.has(dynamicProviderId)).toBe(false);
    expect(agentAuthProviderIds.has(dynamicProviderId)).toBe(false);
    expect(agentModelProviderIds.has(dynamicProviderId)).toBe(false);
    expect(runtimeProviderIds.has(dynamicProviderId)).toBe(false);
    expect(mocks.clearManagedRuntimeMutationMarker).toHaveBeenCalledTimes(1);
  });

  it('does not clear any local state when fail-closed Gateway stop fails', async () => {
    const gateway = createGateway('running');
    vi.mocked(gateway.stop).mockRejectedValueOnce(new Error('stop failed'));

    const result = await logoutManagedAuth(gateway);

    expect(result).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'gateway_stop_failed',
    }));
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(mocks.waitForPortFree).not.toHaveBeenCalled();
    expect(mocks.ensureProviderStoreMigrated).not.toHaveBeenCalled();
    expect(mocks.deleteProviderSecret).not.toHaveBeenCalled();
    expect(mocks.removeManagedAgentOpenAiCredentialsFromSnapshot).not.toHaveBeenCalled();
    expect(mocks.storeDelete).not.toHaveBeenCalled();
    expect(gateway.start).not.toHaveBeenCalled();
    expect(mocks.markManagedRuntimeMutationStarted).not.toHaveBeenCalled();
    expect(gateway.releaseManagedRuntimeMutationLease).toHaveBeenCalledWith(RUNTIME_MUTATION_LEASE);
  });

  it('stops a reconnecting Gateway when managed credential cleanup fails', async () => {
    mocks.removeManagedAgentOpenAiCredentialsFromSnapshot.mockRejectedValueOnce(new Error('runtime write failed'));
    const gateway = createGateway('reconnecting');

    const result = await logoutManagedAuth(gateway);

    expect(result).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'session_cleanup_failed',
    }));
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.getStatus().state).toBe('stopped');
    expect(mocks.quarantineManagedRuntimeMutation).toHaveBeenCalledWith(
      RUNTIME_MUTATION_LEASE,
      'logout',
      'managed logout cleanup failed',
    );
    expect(gateway.start).not.toHaveBeenCalled();
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
