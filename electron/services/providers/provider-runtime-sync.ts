import type { GatewayManager } from '../../gateway/manager';
import { getProviderAccount, listProviderAccounts } from './provider-store';
import { getProviderSecret } from '../secrets/secret-store';
import type { ProviderConfig } from '../../utils/secure-storage';
import { getAllProviders, getApiKey, getDefaultProvider, getProvider } from '../../utils/secure-storage';
import { getProviderConfig, getProviderDefaultModel } from '../../utils/provider-registry';
import {
  ensureAnthropicMessagesModelMaxTokens,
  ensureOpenClawProviderAgentRuntimePins,
  pruneInvalidApiProviderEntries,
  removeProviderFromOpenClaw,
  removeProviderKeyFromOpenClaw,
  saveOAuthTokenToOpenClaw,
  saveProviderKeyToOpenClaw,
  setOpenClawDefaultModel,
  setOpenClawDefaultModelWithOverride,
  syncProviderConfigToOpenClaw,
  updateAgentModelProvider,
  updateSingleAgentModelProvider,
} from '../../utils/openclaw-auth';
import {
  piAiModelsJsonModelEntry,
  type PiAiModelCostRates,
} from '../../shared/pi-ai-model-cost';
import { logger } from '../../utils/logger';
import { listAgentsSnapshot } from '../../utils/agent-config';
import { JUNFEIAI_PROVIDER_ID } from '../../utils/junfeiai-distribution';
import {
  CLAWX_OPENAI_IMAGE_DEFAULT_MODEL,
  CLAWX_OPENAI_IMAGE_PROVIDER_KEY,
} from '../../utils/openclaw-image-relay-constants';
import {
  CLAWX_OPENAI_VIDEO_DEFAULT_MODEL,
  CLAWX_OPENAI_VIDEO_PROVIDER_KEY,
  CLAWX_OPENAI_VIDEO_MODEL_IDS,
} from '../../utils/openclaw-video-relay-constants';

const OPENAI_OAUTH_RUNTIME_PROVIDER = 'openai-codex';
const OPENAI_OAUTH_DEFAULT_MODEL_REF = `${OPENAI_OAUTH_RUNTIME_PROVIDER}/gpt-5.5`;

/**
 * Provider types that are not in the built-in provider registry (no `providerConfig.api`).
 * They require explicit api-protocol defaulting to `openai-completions`.
 */
function isUnregisteredProviderType(type: string): boolean {
  return type === 'custom' || type === 'ollama';
}

type RuntimeProviderSyncContext = {
  runtimeProviderKey: string;
  meta: ReturnType<typeof getProviderConfig>;
  api: string;
};

type RuntimeApiKeyOverrides = Map<string, string | undefined>;

function normalizeProviderBaseUrl(
  config: ProviderConfig,
  baseUrl?: string,
  apiProtocol?: string,
): string | undefined {
  if (!baseUrl) {
    return undefined;
  }

  const normalized = baseUrl.trim().replace(/\/+$/, '');

  if (config.type === 'minimax-portal' || config.type === 'minimax-portal-cn') {
    return normalized.replace(/\/v1$/, '').replace(/\/anthropic$/, '').replace(/\/$/, '') + '/anthropic';
  }

  if (isUnregisteredProviderType(config.type)) {
    const protocol = apiProtocol || config.apiProtocol || 'openai-completions';
    if (protocol === 'openai-responses') {
      return normalized.replace(/\/responses?$/i, '');
    }
    if (protocol === 'openai-completions') {
      return normalized.replace(/\/chat\/completions$/i, '');
    }
    if (protocol === 'anthropic-messages') {
      return normalized.replace(/\/v1\/messages$/i, '').replace(/\/messages$/i, '');
    }
  }

  return normalized;
}

function shouldUseExplicitDefaultOverride(config: ProviderConfig, runtimeProviderKey: string): boolean {
  return Boolean(config.baseUrl || config.apiProtocol || runtimeProviderKey !== config.type);
}

function getRuntimeApiKeyEnv(config: ProviderConfig, apiKeyEnv?: string): string | undefined {
  return config.type === JUNFEIAI_PROVIDER_ID ? undefined : apiKeyEnv;
}

function normalizeRuntimeApiKey(
  config: ProviderConfig,
  apiKey: string | null | undefined,
  apiKeyEnv?: string,
): string | null {
  const trimmed = apiKey?.trim();
  if (!trimmed) {
    return null;
  }
  if (config.type === JUNFEIAI_PROVIDER_ID && apiKeyEnv && trimmed === apiKeyEnv) {
    return null;
  }
  return trimmed;
}

export function getOpenClawProviderKey(type: string, providerId: string): string {
  if (isUnregisteredProviderType(type)) {
    // If the providerId is already a runtime key (e.g. re-seeded from openclaw.json
    // as "custom-XXXXXXXX"), return it directly to avoid double-hashing.
    const prefix = `${type}-`;
    if (providerId.startsWith(prefix)) {
      const tail = providerId.slice(prefix.length);
      if (tail.length === 8 && !tail.includes('-')) {
        return providerId;
      }
    }
    const suffix = providerId.replace(/-/g, '').slice(0, 8);
    return `${type}-${suffix}`;
  }
  if (type === 'minimax-portal-cn') {
    return 'minimax-portal';
  }
  return type;
}

async function resolveRuntimeProviderKey(config: ProviderConfig): Promise<string> {
  const account = await getProviderAccount(config.id);
  if (account?.authMode === 'oauth_browser' && config.type === 'openai') {
    return OPENAI_OAUTH_RUNTIME_PROVIDER;
  }
  return getOpenClawProviderKey(config.type, config.id);
}

async function getBrowserOAuthRuntimeProvider(config: ProviderConfig): Promise<string | null> {
  const account = await getProviderAccount(config.id);
  if (account?.authMode !== 'oauth_browser') {
    return null;
  }

  const secret = await getProviderSecret(config.id);
  if (secret?.type !== 'oauth') {
    return null;
  }

  if (config.type === 'openai') {
    return OPENAI_OAUTH_RUNTIME_PROVIDER;
  }
  return null;
}

export function getProviderModelRef(config: ProviderConfig): string | undefined {
  const providerKey = getOpenClawProviderKey(config.type, config.id);

  if (config.model) {
    return config.model.startsWith(`${providerKey}/`)
      ? config.model
      : `${providerKey}/${config.model}`;
  }

  const defaultModel = getProviderDefaultModel(config.type);
  if (!defaultModel) {
    return undefined;
  }

  return defaultModel.startsWith(`${providerKey}/`)
    ? defaultModel
    : `${providerKey}/${defaultModel}`;
}

export async function getProviderFallbackModelRefs(config: ProviderConfig): Promise<string[]> {
  const allProviders = await getAllProviders();
  const providerMap = new Map(allProviders.map((provider) => [provider.id, provider]));
  const seen = new Set<string>();
  const results: string[] = [];
  const providerKey = getOpenClawProviderKey(config.type, config.id);

  for (const fallbackModel of config.fallbackModels ?? []) {
    const normalizedModel = fallbackModel.trim();
    if (!normalizedModel) continue;

    const modelRef = normalizedModel.startsWith(`${providerKey}/`)
      ? normalizedModel
      : `${providerKey}/${normalizedModel}`;

    if (seen.has(modelRef)) continue;
    seen.add(modelRef);
    results.push(modelRef);
  }

  for (const fallbackId of config.fallbackProviderIds ?? []) {
    if (!fallbackId || fallbackId === config.id) continue;

    const fallbackProvider = providerMap.get(fallbackId);
    if (!fallbackProvider) continue;

    const modelRef = getProviderModelRef(fallbackProvider);
    if (!modelRef || seen.has(modelRef)) continue;

    seen.add(modelRef);
    results.push(modelRef);
  }

  return results;
}

type GatewayRefreshMode = 'reload' | 'restart';

function scheduleGatewayRefresh(
  gatewayManager: GatewayManager | undefined,
  message: string,
  options?: { delayMs?: number; onlyIfRunning?: boolean; mode?: GatewayRefreshMode },
): void {
  if (!gatewayManager) {
    return;
  }

  if (options?.onlyIfRunning && gatewayManager.getStatus().state === 'stopped') {
    return;
  }

  logger.info(message);
  if (options?.mode === 'restart') {
    gatewayManager.debouncedRestart(options?.delayMs);
    return;
  }
  gatewayManager.debouncedReload(options?.delayMs);
}

export async function syncProviderApiKeyToRuntime(
  providerType: string,
  providerId: string,
  apiKey: string,
): Promise<void> {
  const ock = getOpenClawProviderKey(providerType, providerId);
  const runtimeApiKey = normalizeRuntimeApiKey(
    {
      id: providerId,
      name: providerId,
      type: providerType as ProviderConfig['type'],
      enabled: true,
      createdAt: '',
      updatedAt: '',
    },
    apiKey,
    getProviderConfig(providerType)?.apiKeyEnv,
  );
  if (runtimeApiKey) {
    await saveProviderKeyToOpenClaw(ock, runtimeApiKey);
  } else {
    await removeProviderKeyFromOpenClaw(ock);
  }
}

export async function syncAllProviderAuthToRuntime(): Promise<void> {
  const accounts = await listProviderAccounts();
  for (const account of accounts) {
    const config: ProviderConfig = {
      id: account.id,
      name: account.label,
      type: account.vendorId,
      baseUrl: account.baseUrl,
      model: account.model,
      fallbackModels: account.fallbackModels,
      fallbackProviderIds: account.fallbackAccountIds,
      enabled: account.enabled,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
    const runtimeProviderKey = await resolveRuntimeProviderKey(config);
    const apiKeyEnv = getProviderConfig(config.type)?.apiKeyEnv;

    const secret = await getProviderSecret(account.id);
    if (!secret) {
      continue;
    }

    if (secret.type === 'api_key') {
      const runtimeApiKey = normalizeRuntimeApiKey(config, secret.apiKey, apiKeyEnv);
      if (runtimeApiKey) {
        await saveProviderKeyToOpenClaw(runtimeProviderKey, runtimeApiKey);
      } else {
        await removeProviderKeyFromOpenClaw(runtimeProviderKey);
      }
      continue;
    }

    if (secret.type === 'local' && secret.apiKey) {
      const runtimeApiKey = normalizeRuntimeApiKey(config, secret.apiKey, apiKeyEnv);
      if (runtimeApiKey) {
        await saveProviderKeyToOpenClaw(runtimeProviderKey, runtimeApiKey);
      } else {
        await removeProviderKeyFromOpenClaw(runtimeProviderKey);
      }
      continue;
    }

    if (secret.type === 'oauth') {
      await saveOAuthTokenToOpenClaw(runtimeProviderKey, {
        access: secret.accessToken,
        refresh: secret.refreshToken,
        expires: secret.expiresAt,
        email: secret.email,
        projectId: secret.subject,
      });
    }
  }
}

async function syncProviderSecretToRuntime(
  config: ProviderConfig,
  runtimeProviderKey: string,
  apiKey: string | undefined,
): Promise<void> {
  const apiKeyEnv = getProviderConfig(config.type)?.apiKeyEnv;
  if (apiKey !== undefined) {
    const runtimeApiKey = normalizeRuntimeApiKey(config, apiKey, apiKeyEnv);
    if (runtimeApiKey) {
      await saveProviderKeyToOpenClaw(runtimeProviderKey, runtimeApiKey);
    } else {
      // An explicit empty string means the caller wants to clear the key.
      // Mirror that intent into OpenClaw auth-profiles so the gateway no
      // longer authenticates with the stale value (matches the explicit
      // delete branch in the legacy /api/providers/:id PUT handler).
      await removeProviderKeyFromOpenClaw(runtimeProviderKey);
    }
    return;
  }

  const secret = await getProviderSecret(config.id);
  if (secret?.type === 'api_key') {
    const runtimeApiKey = normalizeRuntimeApiKey(config, secret.apiKey, apiKeyEnv);
    if (runtimeApiKey) {
      await saveProviderKeyToOpenClaw(runtimeProviderKey, runtimeApiKey);
    } else {
      await removeProviderKeyFromOpenClaw(runtimeProviderKey);
    }
    return;
  }

  if (secret?.type === 'oauth') {
    await saveOAuthTokenToOpenClaw(runtimeProviderKey, {
      access: secret.accessToken,
      refresh: secret.refreshToken,
      expires: secret.expiresAt,
      email: secret.email,
      projectId: secret.subject,
    });
    return;
  }

  if (secret?.type === 'local' && secret.apiKey) {
    const runtimeApiKey = normalizeRuntimeApiKey(config, secret.apiKey, apiKeyEnv);
    if (runtimeApiKey) {
      await saveProviderKeyToOpenClaw(runtimeProviderKey, runtimeApiKey);
    } else {
      await removeProviderKeyFromOpenClaw(runtimeProviderKey);
    }
  }
}

async function resolveRuntimeSyncContext(config: ProviderConfig): Promise<RuntimeProviderSyncContext | null> {
  const runtimeProviderKey = await resolveRuntimeProviderKey(config);
  const meta = getProviderConfig(config.type);
  const api = config.apiProtocol || (isUnregisteredProviderType(config.type) ? 'openai-completions' : meta?.api);
  if (!api) {
    return null;
  }

  return {
    runtimeProviderKey,
    meta,
    api,
  };
}

async function syncRuntimeProviderConfig(
  config: ProviderConfig,
  context: RuntimeProviderSyncContext,
  apiKey: string | undefined,
): Promise<void> {
  const accountApiKey = config.type === JUNFEIAI_PROVIDER_ID
    ? normalizeRuntimeApiKey(
      config,
      apiKey !== undefined ? apiKey : await getApiKey(config.id),
      context.meta?.apiKeyEnv,
    )
    : null;
  await syncProviderConfigToOpenClaw(context.runtimeProviderKey, config.model, {
    baseUrl: normalizeProviderBaseUrl(config, config.baseUrl || context.meta?.baseUrl, context.api),
    api: context.api,
    apiKeyEnv: getRuntimeApiKeyEnv(config, context.meta?.apiKeyEnv),
    apiKey: config.type === JUNFEIAI_PROVIDER_ID ? (accountApiKey || null) : undefined,
    headers: config.headers ?? context.meta?.headers,
  });
}

async function syncCustomProviderAgentModel(
  config: ProviderConfig,
  runtimeProviderKey: string,
  apiKey: string | undefined,
): Promise<void> {
  if (!isUnregisteredProviderType(config.type)) {
    return;
  }

  if (apiKey !== undefined && !apiKey.trim()) {
    return;
  }

  const resolvedKey = apiKey !== undefined ? apiKey.trim() : await getApiKey(config.id);
  if (!resolvedKey || !config.baseUrl) {
    return;
  }

  const modelId = config.model;
  await updateAgentModelProvider(runtimeProviderKey, {
    baseUrl: normalizeProviderBaseUrl(config, config.baseUrl, config.apiProtocol || 'openai-completions'),
    api: config.apiProtocol || 'openai-completions',
    models: modelId ? [piAiModelsJsonModelEntry(modelId)] : [],
    apiKey: resolvedKey,
  });
}

async function syncProviderToRuntime(
  config: ProviderConfig,
  apiKey: string | undefined,
): Promise<RuntimeProviderSyncContext | null> {
  const context = await resolveRuntimeSyncContext(config);
  if (!context) {
    return null;
  }

  await syncProviderSecretToRuntime(config, context.runtimeProviderKey, apiKey);
  await syncRuntimeProviderConfig(config, context, apiKey);
  await syncCustomProviderAgentModel(config, context.runtimeProviderKey, apiKey);
  return context;
}

async function removeDeletedProviderFromOpenClaw(
  provider: ProviderConfig,
  providerId: string,
  runtimeProviderKey?: string,
): Promise<void> {
  const keys = new Set<string>();
  if (runtimeProviderKey) {
    keys.add(runtimeProviderKey);
  } else {
    keys.add(await resolveRuntimeProviderKey({ ...provider, id: providerId }));
  }
  keys.add(providerId);

  for (const key of keys) {
    await removeProviderFromOpenClaw(key);
  }
}

function parseModelRef(modelRef: string): { providerKey: string; modelId: string } | null {
  const trimmed = modelRef.trim();
  const separatorIndex = trimmed.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return null;
  }

  return {
    providerKey: trimmed.slice(0, separatorIndex),
    modelId: trimmed.slice(separatorIndex + 1),
  };
}

async function buildRuntimeProviderConfigMap(): Promise<Map<string, ProviderConfig>> {
  const configs = await getAllProviders();
  const runtimeMap = new Map<string, ProviderConfig>();

  for (const config of configs) {
    const runtimeKey = await resolveRuntimeProviderKey(config);
    runtimeMap.set(runtimeKey, config);
  }

  return runtimeMap;
}

async function buildAgentModelProviderEntry(
  config: ProviderConfig,
  modelId: string,
  apiKeyOverrides?: RuntimeApiKeyOverrides,
): Promise<{
  baseUrl?: string;
  api?: string;
  models?: Array<{ id: string; name: string; cost: PiAiModelCostRates }>;
  apiKey?: string;
  authHeader?: boolean;
} | null> {
  const meta = getProviderConfig(config.type);
  const api = config.apiProtocol || (isUnregisteredProviderType(config.type) ? 'openai-completions' : meta?.api);
  const baseUrl = normalizeProviderBaseUrl(config, config.baseUrl || meta?.baseUrl, api);
  if (!api || !baseUrl) {
    return null;
  }

  let apiKey: string | undefined;
  let authHeader: boolean | undefined;
  const rawApiKey = apiKeyOverrides?.has(config.id)
    ? apiKeyOverrides.get(config.id)
    : await getApiKey(config.id);
  const accountApiKey = normalizeRuntimeApiKey(config, rawApiKey, meta?.apiKeyEnv) || undefined;

  if (isUnregisteredProviderType(config.type)) {
    apiKey = accountApiKey;
  } else if (config.type === 'minimax-portal' || config.type === 'minimax-portal-cn') {
    if (accountApiKey) {
      apiKey = accountApiKey;
    } else {
      authHeader = true;
      apiKey = 'minimax-oauth';
    }
  } else if (accountApiKey) {
    apiKey = accountApiKey;
  }

  return {
    baseUrl,
    api,
    models: [piAiModelsJsonModelEntry(modelId)],
    apiKey: apiKey ?? (config.type === JUNFEIAI_PROVIDER_ID ? null : undefined),
    authHeader,
  };
}

async function syncAgentModelsToRuntime(
  agentIds?: Set<string>,
  apiKeyOverrides?: RuntimeApiKeyOverrides,
): Promise<void> {
  const snapshot = await listAgentsSnapshot();
  const runtimeProviderConfigs = await buildRuntimeProviderConfigMap();

  const targets = snapshot.agents.filter((agent) => {
    if (!agent.modelRef) return false;
    if (!agentIds) return true;
    return agentIds.has(agent.id);
  });

  for (const agent of targets) {
    const parsed = parseModelRef(agent.modelRef || '');
    if (!parsed) {
      continue;
    }

    const providerConfig = runtimeProviderConfigs.get(parsed.providerKey);
    if (!providerConfig) {
      logger.warn(
        `[provider-runtime] No provider account mapped to runtime key "${parsed.providerKey}" for agent "${agent.id}"`,
      );
      continue;
    }

    const entry = await buildAgentModelProviderEntry(providerConfig, parsed.modelId, apiKeyOverrides);
    if (!entry) {
      continue;
    }

    await updateSingleAgentModelProvider(agent.id, parsed.providerKey, entry);
  }
}

async function syncProviderAgentModelsAcrossDiscoveredAgents(
  config: ProviderConfig,
  runtimeProviderKey: string,
  apiKeyOverrides?: RuntimeApiKeyOverrides,
): Promise<void> {
  const modelId = config.model || getProviderDefaultModel(config.type);
  if (!modelId) {
    return;
  }

  const entry = await buildAgentModelProviderEntry(config, modelId, apiKeyOverrides);
  if (!entry) {
    return;
  }

  await updateAgentModelProvider(runtimeProviderKey, entry);
}

async function syncManagedRelayAgentModelsAcrossDiscoveredAgents(
  config: ProviderConfig,
  apiKey: string | undefined,
): Promise<void> {
  if (apiKey === undefined) {
    return;
  }

  const managedApiKey = apiKey.trim() || null;
  const meta = getProviderConfig(config.type);
  const baseUrl = normalizeProviderBaseUrl(
    config,
    config.baseUrl || meta?.baseUrl,
    meta?.api,
  );
  if (!baseUrl) {
    return;
  }

  await updateAgentModelProvider(CLAWX_OPENAI_IMAGE_PROVIDER_KEY, {
    baseUrl,
    api: 'openai-completions',
    models: [piAiModelsJsonModelEntry(CLAWX_OPENAI_IMAGE_DEFAULT_MODEL)],
    apiKey: managedApiKey,
  }, { createIfMissing: false });

  await updateAgentModelProvider(CLAWX_OPENAI_VIDEO_PROVIDER_KEY, {
    baseUrl,
    api: 'openai-responses',
    models: CLAWX_OPENAI_VIDEO_MODEL_IDS.map((modelId) => piAiModelsJsonModelEntry(modelId)),
    apiKey: managedApiKey,
  }, { createIfMissing: false });
}

async function syncManagedRelayAuthProfiles(apiKey: string | undefined): Promise<void> {
  if (apiKey === undefined) {
    return;
  }

  const managedApiKey = apiKey.trim();
  const providers = [
    JUNFEIAI_PROVIDER_ID,
    CLAWX_OPENAI_IMAGE_PROVIDER_KEY,
    CLAWX_OPENAI_VIDEO_PROVIDER_KEY,
  ];

  for (const provider of providers) {
    if (managedApiKey) {
      await saveProviderKeyToOpenClaw(provider, managedApiKey);
    } else {
      await removeProviderKeyFromOpenClaw(provider);
    }
  }
}

export async function syncAgentModelOverrideToRuntime(agentId: string): Promise<void> {
  await syncAgentModelsToRuntime(new Set([agentId]));
}

export async function syncSavedProviderToRuntime(
  config: ProviderConfig,
  apiKey: string | undefined,
  gatewayManager?: GatewayManager,
): Promise<void> {
  const context = await syncProviderToRuntime(config, apiKey);
  if (!context) {
    return;
  }

  const apiKeyOverrides = new Map([[config.id, apiKey]]);
  try {
    await syncAgentModelsToRuntime(undefined, apiKeyOverrides);
  } catch (err) {
    logger.warn('[provider-runtime] Failed to sync per-agent model registries after provider save:', err);
  }

  try {
    await syncProviderAgentModelsAcrossDiscoveredAgents(config, context.runtimeProviderKey, apiKeyOverrides);
    if (config.type === JUNFEIAI_PROVIDER_ID) {
      await syncManagedRelayAuthProfiles(apiKey);
      await syncManagedRelayAgentModelsAcrossDiscoveredAgents(config, apiKey);
    }
  } catch (err) {
    logger.warn('[provider-runtime] Failed to sync discovered per-agent model registries after provider save:', err);
  }

  scheduleGatewayRefresh(
    gatewayManager,
    `Scheduling Gateway reload after saving provider "${context.runtimeProviderKey}" config`,
    { onlyIfRunning: true },
  );
}

export async function syncUpdatedProviderToRuntime(
  config: ProviderConfig,
  apiKey: string | undefined,
  gatewayManager?: GatewayManager,
): Promise<void> {
  const context = await syncProviderToRuntime(config, apiKey);
  if (!context) {
    return;
  }

  const ock = context.runtimeProviderKey;
  const fallbackModels = await getProviderFallbackModelRefs(config);

  const defaultProviderId = await getDefaultProvider();
  const isDefaultProvider = defaultProviderId === config.id;
  if (isDefaultProvider) {
    const modelOverride = config.model ? `${ock}/${config.model}` : undefined;
    if (!isUnregisteredProviderType(config.type)) {
      if (shouldUseExplicitDefaultOverride(config, ock)) {
        const runtimeApiKey = normalizeRuntimeApiKey(
          config,
          apiKey !== undefined ? apiKey : await getApiKey(config.id),
          context.meta?.apiKeyEnv,
        );
        await setOpenClawDefaultModelWithOverride(ock, modelOverride, {
          baseUrl: normalizeProviderBaseUrl(config, config.baseUrl || context.meta?.baseUrl, context.api),
          api: context.api,
          apiKeyEnv: getRuntimeApiKeyEnv(config, context.meta?.apiKeyEnv),
          apiKey: config.type === JUNFEIAI_PROVIDER_ID ? (runtimeApiKey || null) : undefined,
          headers: config.headers ?? context.meta?.headers,
        }, fallbackModels);
      } else {
        await setOpenClawDefaultModel(ock, modelOverride, fallbackModels);
      }
    } else {
      await setOpenClawDefaultModelWithOverride(ock, modelOverride, {
        baseUrl: normalizeProviderBaseUrl(config, config.baseUrl, config.apiProtocol || 'openai-completions'),
        api: config.apiProtocol || 'openai-completions',
        headers: config.headers,
      }, fallbackModels);
    }
  }

  try {
    await syncAgentModelsToRuntime();
  } catch (err) {
    logger.warn('[provider-runtime] Failed to sync per-agent model registries after provider update:', err);
  }

  scheduleGatewayRefresh(
    gatewayManager,
    `Scheduling Gateway reload after updating provider "${ock}" config`,
    { onlyIfRunning: true },
  );
}

export async function syncDeletedProviderToRuntime(
  provider: ProviderConfig | null,
  providerId: string,
  gatewayManager?: GatewayManager,
  runtimeProviderKey?: string,
): Promise<void> {
  if (!provider?.type) {
    return;
  }

  const ock = runtimeProviderKey ?? await resolveRuntimeProviderKey({ ...provider, id: providerId });
  await removeDeletedProviderFromOpenClaw(provider, providerId, ock);

  scheduleGatewayRefresh(
    gatewayManager,
    `Scheduling Gateway restart after deleting provider "${ock}"`,
    { mode: 'restart' },
  );
}

export async function syncDeletedProviderApiKeyToRuntime(
  provider: ProviderConfig | null,
  providerId: string,
  runtimeProviderKey?: string,
): Promise<void> {
  if (!provider?.type) {
    return;
  }

  const ock = runtimeProviderKey ?? await resolveRuntimeProviderKey({ ...provider, id: providerId });
  await removeProviderKeyFromOpenClaw(ock);
}

export async function syncDefaultProviderToRuntime(
  providerId: string,
  gatewayManager?: GatewayManager,
): Promise<void> {
  const provider = await getProvider(providerId);
  if (!provider) {
    return;
  }

  // Self-heal: opportunistically remove any pre-existing models.providers
  // entries with an invalid `api` field so a switch to a healthy provider
  // can rescue the user from a previously broken config (e.g. the historical
  // openrouter `api: 'openrouter'` bug).  Covers both OAuth and non-OAuth
  // branches below.
  try {
    const removed = await pruneInvalidApiProviderEntries();
    if (removed.length > 0) {
      logger.warn(
        `[provider-runtime] Pruned invalid models.providers entries before switch: ${removed.join(', ')}`,
      );
    }
  } catch (err) {
    logger.warn('[provider-runtime] Failed to prune invalid provider entries before switch:', err);
  }

  // Self-heal: pin the embedded agent runtime for legacy OpenAI provider entries
  // (`openai`, `openai-codex`) that would otherwise be auto-routed to the
  // unbundled `codex` harness. Running this before every default-provider switch
  // repairs on-disk config written by earlier ClawX builds.
  try {
    const pinned = await ensureOpenClawProviderAgentRuntimePins();
    if (pinned.length > 0) {
      logger.warn(
        `[provider-runtime] Pinned embedded agent runtime for models.providers entries before switch: ${pinned.join(', ')}`,
      );
    }
  } catch (err) {
    logger.warn('[provider-runtime] Failed to pin embedded agent runtime for provider entries before switch:', err);
  }

  try {
    const healed = await ensureAnthropicMessagesModelMaxTokens();
    if (healed.length > 0) {
      logger.warn(
        `[provider-runtime] Ensured anthropic-messages maxTokens for models.providers entries before switch: ${healed.join(', ')}`,
      );
    }
  } catch (err) {
    logger.warn('[provider-runtime] Failed to ensure anthropic-messages maxTokens before switch:', err);
  }

  const ock = await resolveRuntimeProviderKey(provider);
  const providerMeta = getProviderConfig(provider.type);
  const providerKey = normalizeRuntimeApiKey(provider, await getApiKey(providerId), providerMeta?.apiKeyEnv);
  const fallbackModels = await getProviderFallbackModelRefs(provider);
  const oauthTypes = ['minimax-portal', 'minimax-portal-cn'];
  const browserOAuthRuntimeProvider = await getBrowserOAuthRuntimeProvider(provider);
  const isOAuthProvider = (oauthTypes.includes(provider.type) && !providerKey) || Boolean(browserOAuthRuntimeProvider);

  if (!isOAuthProvider) {
    const modelOverride = provider.model
      ? (provider.model.startsWith(`${ock}/`) ? provider.model : `${ock}/${provider.model}`)
      : undefined;

    if (isUnregisteredProviderType(provider.type)) {
      await setOpenClawDefaultModelWithOverride(ock, modelOverride, {
        baseUrl: normalizeProviderBaseUrl(provider, provider.baseUrl, provider.apiProtocol || 'openai-completions'),
        api: provider.apiProtocol || 'openai-completions',
        headers: provider.headers,
      }, fallbackModels);
    } else if (shouldUseExplicitDefaultOverride(provider, ock)) {
      await setOpenClawDefaultModelWithOverride(ock, modelOverride, {
        baseUrl: normalizeProviderBaseUrl(
          provider,
          provider.baseUrl || providerMeta?.baseUrl,
          provider.apiProtocol || providerMeta?.api,
        ),
        api: provider.apiProtocol || providerMeta?.api,
        apiKeyEnv: getRuntimeApiKeyEnv(provider, providerMeta?.apiKeyEnv),
        apiKey: provider.type === JUNFEIAI_PROVIDER_ID ? (providerKey || null) : undefined,
        headers: provider.headers ?? providerMeta?.headers,
      }, fallbackModels);
    } else {
      await setOpenClawDefaultModel(ock, modelOverride, fallbackModels);
    }

    if (providerKey) {
      await saveProviderKeyToOpenClaw(ock, providerKey);
    }
  } else {
    if (browserOAuthRuntimeProvider) {
      const secret = await getProviderSecret(provider.id);
      if (secret?.type === 'oauth') {
        await saveOAuthTokenToOpenClaw(browserOAuthRuntimeProvider, {
          access: secret.accessToken,
          refresh: secret.refreshToken,
          expires: secret.expiresAt,
          email: secret.email,
          projectId: secret.subject,
        });
      }

      const defaultModelRef = OPENAI_OAUTH_DEFAULT_MODEL_REF;
      const modelOverride = provider.model
        ? (provider.model.startsWith(`${browserOAuthRuntimeProvider}/`)
          ? provider.model
          : `${browserOAuthRuntimeProvider}/${provider.model}`)
        : defaultModelRef;

      await setOpenClawDefaultModel(browserOAuthRuntimeProvider, modelOverride, fallbackModels);
      logger.info(`Configured openclaw.json for browser OAuth provider "${provider.id}"`);
      try {
        await syncAgentModelsToRuntime();
      } catch (err) {
        logger.warn('[provider-runtime] Failed to sync per-agent model registries after browser OAuth switch:', err);
      }
      scheduleGatewayRefresh(
        gatewayManager,
        `Scheduling Gateway reload after provider switch to "${browserOAuthRuntimeProvider}"`,
      );
      return;
    }

    const defaultBaseUrl = provider.type === 'minimax-portal'
      ? 'https://api.minimax.io/anthropic'
      : 'https://api.minimaxi.com/anthropic';
    const api = 'anthropic-messages' as const;

    let baseUrl = provider.baseUrl || defaultBaseUrl;
    if (baseUrl) {
      baseUrl = baseUrl.replace(/\/v1$/, '').replace(/\/anthropic$/, '').replace(/\/$/, '') + '/anthropic';
    }

    const targetProviderKey = 'minimax-portal';

    await setOpenClawDefaultModelWithOverride(targetProviderKey, getProviderModelRef(provider), {
      baseUrl,
      api,
      authHeader: targetProviderKey === 'minimax-portal' ? true : undefined,
      apiKeyEnv: targetProviderKey === 'minimax-portal' ? 'minimax-oauth' : 'qwen-oauth',
    }, fallbackModels);

    logger.info(`Configured openclaw.json for OAuth provider "${provider.type}"`);

    try {
      const defaultModelId = provider.model?.split('/').pop();
      await updateAgentModelProvider(targetProviderKey, {
        baseUrl,
        api,
        authHeader: targetProviderKey === 'minimax-portal' ? true : undefined,
        apiKey: targetProviderKey === 'minimax-portal' ? 'minimax-oauth' : 'qwen-oauth',
        models: defaultModelId ? [piAiModelsJsonModelEntry(defaultModelId)] : [],
      });
    } catch (err) {
      logger.warn(`Failed to update models.json for OAuth provider "${targetProviderKey}":`, err);
    }
  }

  if (
    isUnregisteredProviderType(provider.type) &&
    providerKey &&
    provider.baseUrl
  ) {
    const modelId = provider.model;
    await updateAgentModelProvider(ock, {
      baseUrl: normalizeProviderBaseUrl(provider, provider.baseUrl, provider.apiProtocol || 'openai-completions'),
      api: provider.apiProtocol || 'openai-completions',
      models: modelId ? [piAiModelsJsonModelEntry(modelId)] : [],
      apiKey: providerKey,
    });
  }

  try {
    await syncAgentModelsToRuntime();
  } catch (err) {
    logger.warn('[provider-runtime] Failed to sync per-agent model registries after default provider switch:', err);
  }

  scheduleGatewayRefresh(
    gatewayManager,
    `Scheduling Gateway reload after provider switch to "${ock}"`,
    { onlyIfRunning: true },
  );
}
