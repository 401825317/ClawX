/**
 * Read/write agents.defaults.videoGenerationModel and per-agent auth readiness.
 */
import { readOpenClawConfig, writeOpenClawConfig } from './channel-config';
import { withConfigLock } from './config-mutex';
import {
  getOAuthTokenFromOpenClaw,
  getProviderApiKeyFromOpenClaw,
  readOpenAiCompatibleVideoRelayState,
  syncOpenAiCompatibleVideoRelay,
} from './openclaw-auth';
import { listAgentsSnapshot, type AgentsSnapshot } from './agent-config';
import { expandOpenClawPath } from './paths';
import {
  generateVideoInProcess,
  listVideoGenerationProvidersInProcess,
  type VideoGenerationInputImageAsset,
} from './openclaw-video-generation-runtime';
import { OPENAI_CODEX_RUNTIME_PROVIDER_KEY } from './provider-keys';
import {
  CLAWX_OPENAI_VIDEO_DEFAULT_MODEL,
  CLAWX_OPENAI_VIDEO_DEFAULT_SIZE,
  CLAWX_OPENAI_VIDEO_DEFAULT_TIMEOUT_MS,
  CLAWX_OPENAI_VIDEO_MODEL_OPTIONS,
  CLAWX_OPENAI_VIDEO_PROVIDER_KEY,
  isClawXOpenAiVideoModelId,
  normalizeClawXOpenAiVideoModelId,
  orderedClawXOpenAiVideoModelIds,
  type ClawXOpenAiVideoModelOption,
} from './openclaw-video-relay-constants';
import { getJunFeiAIDefaultBaseUrl, JUNFEIAI_PROVIDER_ID } from './junfeiai-distribution';
import { getProviderSecret } from '../services/secrets/secret-store';

export interface VideoGenerationModelConfig {
  primary: string | null;
  fallbacks: string[];
  timeoutMs: number | null;
}

export interface VideoGenerationProviderRow {
  id: string;
  aliases: string[];
  label: string;
  defaultModel: string;
  configured: boolean;
  available: boolean;
  selected: boolean;
  models: string[];
}

export interface VideoGenerationAgentAuthRow {
  id: string;
  name: string;
  isDefault: boolean;
  provider: string | null;
  configured: boolean;
}

export interface OpenAiVideoRelayConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  providerKey?: string;
  apiKeyConfigured: boolean;
  inheritedFromManagedAccount?: boolean;
  modelOptions: ClawXOpenAiVideoModelOption[];
}

export interface VideoGenerationSettingsSnapshot {
  config: VideoGenerationModelConfig;
  autoProviderFallback: boolean;
  defaultAgentId: string;
  agents: VideoGenerationAgentAuthRow[];
  openAiRelay: OpenAiVideoRelayConfig;
}

export interface VideoGenerationInputImageRef {
  filePath: string;
  fileName?: string;
  mimeType?: string;
}

export interface VideoGenerationTestResult {
  success: boolean;
  agentId: string;
  command: string;
  durationMs: number;
  error?: string;
  stdout?: string;
  stderr?: string;
  result?: unknown;
}

const DEFAULT_TEST_PROMPT = 'A cinematic four-second shot of a small red paper airplane gliding over a white desk.';
const DEFAULT_TEST_VIDEO_SIZE = CLAWX_OPENAI_VIDEO_DEFAULT_SIZE;
const DEFAULT_TEST_DURATION_SECONDS = 4;
export const VIDEO_GEN_UI_TEST_MAX_TIMEOUT_MS = CLAWX_OPENAI_VIDEO_DEFAULT_TIMEOUT_MS;

type AgentModelConfigShape = {
  primary?: string;
  fallbacks?: string[];
  timeoutMs?: number;
};

type ParsedVideoModelRef = {
  provider: string;
  model: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isApiKeySecret(
  secret: Awaited<ReturnType<typeof getProviderSecret>>,
): secret is Extract<NonNullable<Awaited<ReturnType<typeof getProviderSecret>>>, { type: 'api_key' }> {
  return Boolean(secret && secret.type === 'api_key' && secret.apiKey?.trim());
}

async function getManagedVideoRelayDefaults(): Promise<{
  inherited: boolean;
  baseUrl: string;
  apiKey: string | null;
}> {
  const managedSecret = await getProviderSecret(JUNFEIAI_PROVIDER_ID);
  return {
    inherited: isApiKeySecret(managedSecret),
    baseUrl: getJunFeiAIDefaultBaseUrl(),
    apiKey: isApiKeySecret(managedSecret) ? managedSecret.apiKey.trim() : null,
  };
}

async function resolveVideoRelayApiKey(
  providerKey: string,
  agentId: string,
): Promise<string | null> {
  const runtimeKey = await getProviderApiKeyFromOpenClaw(providerKey, agentId);
  if (runtimeKey) {
    return runtimeKey;
  }

  if (providerKey !== CLAWX_OPENAI_VIDEO_PROVIDER_KEY) {
    return null;
  }

  const managedDefaults = await getManagedVideoRelayDefaults();
  return managedDefaults.apiKey;
}

function normalizeModelRef(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  return null;
}

function normalizeInputImageRefs(raw: VideoGenerationInputImageRef[] | undefined): VideoGenerationInputImageAsset[] {
  return (raw ?? [])
    .map((image) => ({
      filePath: image.filePath?.trim() || '',
      fileName: image.fileName?.trim() || undefined,
      mimeType: image.mimeType?.trim() || undefined,
      role: 'first_frame',
    }))
    .filter((image) => image.filePath.length > 0);
}

function parseVideoGenerationModelConfig(raw: unknown): VideoGenerationModelConfig {
  if (typeof raw === 'string') {
    const primary = normalizeModelRef(raw);
    return { primary, fallbacks: [], timeoutMs: null };
  }

  if (!isRecord(raw)) {
    return { primary: null, fallbacks: [], timeoutMs: null };
  }

  const primary = normalizeModelRef(raw.primary);
  const fallbacks = Array.isArray(raw.fallbacks)
    ? raw.fallbacks
      .map((entry) => normalizeModelRef(entry))
      .filter((entry): entry is string => Boolean(entry))
    : [];

  const timeoutMs = typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
    ? Math.floor(raw.timeoutMs)
    : null;

  return { primary, fallbacks: [...new Set(fallbacks)], timeoutMs };
}

function buildVideoGenerationModelConfigWrite(
  config: VideoGenerationModelConfig,
): AgentModelConfigShape | undefined {
  if (!config.primary && config.fallbacks.length === 0 && config.timeoutMs === null) {
    return undefined;
  }

  const next: AgentModelConfigShape = {};
  if (config.primary) next.primary = config.primary;
  if (config.fallbacks.length > 0) next.fallbacks = config.fallbacks;
  if (config.timeoutMs !== null) next.timeoutMs = config.timeoutMs;
  return next;
}

export function parseProviderFromVideoModelRef(modelRef: string): string | null {
  return parseVideoModelRef(modelRef)?.provider ?? null;
}

function parseVideoModelRef(modelRef: string): ParsedVideoModelRef | null {
  const trimmed = modelRef.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return null;
  }
  const provider = trimmed.slice(0, slash).trim().toLowerCase();
  const model = trimmed.slice(slash + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

export function isValidVideoModelRef(modelRef: string): boolean {
  return parseVideoModelRef(modelRef) !== null;
}

async function listRegisteredVideoProviders(config: unknown): Promise<VideoGenerationProviderRow[]> {
  return listVideoGenerationProvidersInProcess({
    config,
    isProviderConfigured: async () => false,
  });
}

export function normalizeRegisteredVideoModelRef(
  modelRef: string,
  registeredProviders: readonly VideoGenerationProviderRow[],
): string | null {
  const parsed = parseVideoModelRef(modelRef);
  if (!parsed) {
    return null;
  }
  const provider = registeredProviders.find((candidate) => [candidate.id, ...candidate.aliases]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(parsed.provider));
  if (!provider) {
    return null;
  }
  const normalizedModel = provider.id === CLAWX_OPENAI_VIDEO_PROVIDER_KEY
    && isClawXOpenAiVideoModelId(parsed.model)
    ? normalizeClawXOpenAiVideoModelId(parsed.model)
    : parsed.model;
  const advertisedModels = new Set(provider.models.map((model) => model.trim()).filter(Boolean));
  if (advertisedModels.size === 0 && provider.defaultModel.trim()) {
    advertisedModels.add(provider.defaultModel.trim());
  }
  if (!advertisedModels.has(normalizedModel)) {
    return null;
  }
  return `${provider.id}/${normalizedModel}`;
}

function assertRegisteredVideoModelRef(
  modelRef: string,
  registeredProviders: readonly VideoGenerationProviderRow[],
  field: 'primary' | 'fallback',
): string {
  const parsed = parseVideoModelRef(modelRef);
  if (!parsed) {
    throw new Error(field === 'primary'
      ? 'primary must be in "provider/model" format'
      : `Invalid fallback model ref "${modelRef}"`);
  }
  const normalized = normalizeRegisteredVideoModelRef(modelRef, registeredProviders);
  if (normalized) {
    return normalized;
  }
  throw new Error(`Video model "${modelRef}" is not advertised by a registered video-generation provider`);
}

function authProviderCandidates(providerKey: string): string[] {
  const normalized = providerKey.trim().toLowerCase();
  if (normalized === 'openai') {
    return ['openai', OPENAI_CODEX_RUNTIME_PROVIDER_KEY];
  }
  return [normalized];
}

export async function isVideoProviderAuthenticated(
  providerKey: string,
  agentId: string,
): Promise<boolean> {
  for (const candidate of authProviderCandidates(providerKey)) {
    const apiKey = await getProviderApiKeyFromOpenClaw(candidate, agentId);
    if (apiKey) {
      return true;
    }
    const oauth = await getOAuthTokenFromOpenClaw(candidate, agentId);
    if (oauth) {
      return true;
    }
  }
  return false;
}

export async function readVideoGenerationConfig(): Promise<VideoGenerationModelConfig> {
  const config = await readOpenClawConfig();
  const defaults = config.agents?.defaults;
  if (!defaults || typeof defaults !== 'object') {
    return { primary: null, fallbacks: [], timeoutMs: null };
  }
  return parseVideoGenerationModelConfig(
    (defaults as Record<string, unknown>).videoGenerationModel,
  );
}

export async function setVideoGenerationConfig(
  next: VideoGenerationModelConfig,
): Promise<VideoGenerationModelConfig> {
  if (next.primary && !isValidVideoModelRef(next.primary)) {
    throw new Error('primary must be in "provider/model" format');
  }
  for (const fallback of next.fallbacks) {
    if (!isValidVideoModelRef(fallback)) {
      throw new Error(`Invalid fallback model ref "${fallback}"`);
    }
  }

  return withConfigLock(async () => {
    const config = await readOpenClawConfig();
    const registeredProviders = await listRegisteredVideoProviders(config);
    const agents = (config.agents && typeof config.agents === 'object'
      ? { ...(config.agents as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    const defaults = (agents.defaults && typeof agents.defaults === 'object'
      ? { ...(agents.defaults as Record<string, unknown>) }
      : {}) as Record<string, unknown>;

    const writeValue = buildVideoGenerationModelConfigWrite({
      primary: next.primary
        ? assertRegisteredVideoModelRef(next.primary, registeredProviders, 'primary')
        : null,
      fallbacks: [...new Set(next.fallbacks
        .map((ref) => assertRegisteredVideoModelRef(ref, registeredProviders, 'fallback')))],
      timeoutMs: CLAWX_OPENAI_VIDEO_DEFAULT_TIMEOUT_MS,
    });

    if (writeValue) {
      defaults.videoGenerationModel = writeValue;
    } else {
      delete defaults.videoGenerationModel;
    }
    defaults.mediaGenerationAutoProviderFallback = false;

    agents.defaults = defaults;
    config.agents = agents;
    await writeOpenClawConfig(config);

    return readVideoGenerationConfig();
  });
}

async function buildAgentAuthRows(
  snapshot: AgentsSnapshot,
  providerKey: string | null,
): Promise<VideoGenerationAgentAuthRow[]> {
  if (!providerKey) {
    return snapshot.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      isDefault: agent.isDefault,
      provider: null,
      configured: false,
    }));
  }

  const rows: VideoGenerationAgentAuthRow[] = [];
  for (const agent of snapshot.agents) {
    const configured = await isVideoProviderAuthenticated(providerKey, agent.id);
    rows.push({
      id: agent.id,
      name: agent.name,
      isDefault: agent.isDefault,
      provider: providerKey,
      configured,
    });
  }
  return rows;
}

function extractModelIdFromProviderEntry(provider: unknown): string | null {
  if (!provider || typeof provider !== 'object') {
    return null;
  }
  const models = (provider as Record<string, unknown>).models;
  if (!Array.isArray(models)) {
    return null;
  }
  for (const model of models) {
    if (typeof model === 'string' && model.trim()) {
      return normalizeClawXOpenAiVideoModelId(model);
    }
    if (model && typeof model === 'object') {
      const id = (model as Record<string, unknown>).id;
      if (typeof id === 'string' && id.trim()) {
        return normalizeClawXOpenAiVideoModelId(id);
      }
    }
  }
  return null;
}

function resolveOpenAiVideoRelayModelId(
  config: VideoGenerationModelConfig,
  openclawConfig: Record<string, unknown>,
): string {
  const primary = config.primary?.trim();
  if (primary) {
    const slash = primary.indexOf('/');
    if (slash > 0 && slash < primary.length - 1) {
      const provider = primary.slice(0, slash).toLowerCase();
      if (provider === CLAWX_OPENAI_VIDEO_PROVIDER_KEY) {
        return normalizeClawXOpenAiVideoModelId(primary.slice(slash + 1));
      }
    }
  }

  const models = openclawConfig.models;
  const providers = models && typeof models === 'object'
    ? (models as Record<string, unknown>).providers
    : null;
  const providerEntry = providers && typeof providers === 'object'
    ? (providers as Record<string, unknown>)[CLAWX_OPENAI_VIDEO_PROVIDER_KEY]
    : null;
  return extractModelIdFromProviderEntry(providerEntry) ?? CLAWX_OPENAI_VIDEO_DEFAULT_MODEL;
}

export async function getVideoGenerationSettingsSnapshot(): Promise<VideoGenerationSettingsSnapshot> {
  const config = await readVideoGenerationConfig();
  const snapshot = await listAgentsSnapshot();
  const openclawConfig = await readOpenClawConfig();
  const defaults = openclawConfig.agents?.defaults;
  const autoProviderFallback = !(
    defaults
    && typeof defaults === 'object'
    && (defaults as Record<string, unknown>).mediaGenerationAutoProviderFallback === false
  );

  const providerKey = config.primary ? parseProviderFromVideoModelRef(config.primary) : null;
  const relayState = readOpenAiCompatibleVideoRelayState(openclawConfig as Record<string, unknown>);
  const relayKeyConfigured = await isVideoProviderAuthenticated(CLAWX_OPENAI_VIDEO_PROVIDER_KEY, snapshot.defaultAgentId);
  const managedDefaults = await getManagedVideoRelayDefaults();
  const effectiveBaseUrl = relayState.baseUrl || managedDefaults.baseUrl;

  return {
    config,
    autoProviderFallback,
    defaultAgentId: snapshot.defaultAgentId,
    agents: await buildAgentAuthRows(snapshot, providerKey ?? CLAWX_OPENAI_VIDEO_PROVIDER_KEY),
    openAiRelay: {
      enabled: relayState.enabled || managedDefaults.inherited,
      baseUrl: effectiveBaseUrl,
      model: resolveOpenAiVideoRelayModelId(config, openclawConfig as Record<string, unknown>),
      providerKey: relayState.providerKey ?? CLAWX_OPENAI_VIDEO_PROVIDER_KEY,
      apiKeyConfigured: relayKeyConfigured || managedDefaults.inherited,
      inheritedFromManagedAccount: managedDefaults.inherited,
      modelOptions: CLAWX_OPENAI_VIDEO_MODEL_OPTIONS,
    },
  };
}

export async function applyOpenAiVideoRelaySettings(params: {
  enabled: boolean;
  baseUrl?: string | null;
  apiKey?: string;
  model?: string | null;
}): Promise<void> {
  const modelIds = orderedClawXOpenAiVideoModelIds(params.model);
  const managedDefaults = await getManagedVideoRelayDefaults();

  await syncOpenAiCompatibleVideoRelay({
    enabled: params.enabled,
    baseUrl: params.enabled ? ((params.baseUrl ?? '').trim() || managedDefaults.baseUrl) : null,
    apiKey: params.apiKey?.trim() || managedDefaults.apiKey || undefined,
    videoModelIds: modelIds,
  });
}

export async function listVideoGenerationProvidersFromRuntime(): Promise<VideoGenerationProviderRow[]> {
  const cfg = await readOpenClawConfig();
  const snapshot = await listAgentsSnapshot();
  const rows = await listVideoGenerationProvidersInProcess({
    config: cfg,
    isProviderConfigured: (providerId) => isVideoProviderAuthenticated(providerId, snapshot.defaultAgentId),
  });
  return rows.filter((row) => row.id === CLAWX_OPENAI_VIDEO_PROVIDER_KEY);
}

function resolveAgentDirForTest(agentId: string, snapshot: AgentsSnapshot): string {
  const entry = snapshot.agents.find((agent) => agent.id === agentId);
  const agentDir = entry?.agentDir || `~/.openclaw/agents/${agentId}/agent`;
  return expandOpenClawPath(agentDir);
}

export async function runVideoGenerationTest(params: {
  agentId?: string;
  prompt?: string;
  model?: string;
}): Promise<VideoGenerationTestResult> {
  await ensureManagedOpenAiVideoRelay();

  const snapshot = await listAgentsSnapshot();
  const agentId = params.agentId?.trim() || snapshot.defaultAgentId;
  const agent = snapshot.agents.find((entry) => entry.id === agentId);
  if (!agent) {
    throw new Error(`Agent "${agentId}" not found`);
  }

  const config = await readVideoGenerationConfig();
  const model = params.model?.trim() || config.primary;
  if (!model) {
    throw new Error('No video generation model configured. Set a primary model first.');
  }

  const providerKey = parseProviderFromVideoModelRef(model);
  if (!providerKey) {
    throw new Error('Invalid video model ref');
  }

  const authenticated = await isVideoProviderAuthenticated(providerKey, agentId);
  if (!authenticated) {
    throw new Error(
      `Agent "${agent.name}" is not authenticated for video provider "${providerKey}". `
      + 'Add an API key or OAuth for this provider.',
    );
  }

  const agentDir = resolveAgentDirForTest(agentId, snapshot);
  const prompt = params.prompt?.trim() || DEFAULT_TEST_PROMPT;
  const generateTimeoutMs = Math.min(
    CLAWX_OPENAI_VIDEO_DEFAULT_TIMEOUT_MS,
    VIDEO_GEN_UI_TEST_MAX_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  const command = `runtime:generateVideo model=${model} agentDir=${agentDir}`;

  try {
    const openclawConfig = await readOpenClawConfig();
    const current = await getVideoGenerationSettingsSnapshot();
    const directApiKey = providerKey === CLAWX_OPENAI_VIDEO_PROVIDER_KEY
      ? await resolveVideoRelayApiKey(CLAWX_OPENAI_VIDEO_PROVIDER_KEY, agentId)
      : null;
    const result = await generateVideoInProcess({
      config: openclawConfig,
      agentDir,
      prompt,
      model,
      timeoutMs: generateTimeoutMs,
      size: DEFAULT_TEST_VIDEO_SIZE,
      durationSeconds: DEFAULT_TEST_DURATION_SECONDS,
      directOpenAiCompatible: directApiKey && current.openAiRelay.baseUrl
        ? {
          baseUrl: current.openAiRelay.baseUrl,
          apiKey: directApiKey,
        }
        : undefined,
    });

    return {
      success: true,
      agentId,
      command,
      durationMs: Date.now() - startedAt,
      result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      agentId,
      command,
      durationMs: Date.now() - startedAt,
      error: message,
      result: undefined,
    };
  }
}

export async function ensureManagedOpenAiVideoRelay(
  options: { preserveExisting?: boolean } = {},
): Promise<void> {
  const config = await readOpenClawConfig();
  const currentConfig = parseVideoGenerationModelConfig(config.agents?.defaults?.videoGenerationModel);
  if (options.preserveExisting && currentConfig.primary) {
    const registeredProviders = await listRegisteredVideoProviders(config);
    const parsedPrimary = parseVideoModelRef(currentConfig.primary);
    const normalizedPrimary = normalizeRegisteredVideoModelRef(currentConfig.primary, registeredProviders);
    const openAiProvider = isRecord(config.models)
      && isRecord(config.models.providers)
      && isRecord(config.models.providers[CLAWX_OPENAI_VIDEO_PROVIDER_KEY])
      ? config.models.providers[CLAWX_OPENAI_VIDEO_PROVIDER_KEY]
      : undefined;
    const configuredOpenAiBaseUrl = typeof openAiProvider?.baseUrl === 'string'
      ? openAiProvider.baseUrl.trim().replace(/\/+$/u, '')
      : '';
    const managedOpenAiBaseUrl = getJunFeiAIDefaultBaseUrl().trim().replace(/\/+$/u, '');
    const isManagedOpenAiRelay = parsedPrimary?.provider === CLAWX_OPENAI_VIDEO_PROVIDER_KEY
      && configuredOpenAiBaseUrl === managedOpenAiBaseUrl;
    const canPreservePrimary = Boolean(normalizedPrimary)
      && (!isManagedOpenAiRelay || isClawXOpenAiVideoModelId(parsedPrimary?.model));
    if (canPreservePrimary && normalizedPrimary) {
      const normalizedFallbacks = currentConfig.fallbacks
        .map((fallback) => normalizeRegisteredVideoModelRef(fallback, registeredProviders))
        .filter((fallback): fallback is string => Boolean(fallback));
      if (
        normalizedPrimary !== currentConfig.primary
        || normalizedFallbacks.length !== currentConfig.fallbacks.length
        || normalizedFallbacks.some((fallback, index) => fallback !== currentConfig.fallbacks[index])
      ) {
        await setVideoGenerationConfig({
          primary: normalizedPrimary,
          fallbacks: normalizedFallbacks,
          timeoutMs: currentConfig.timeoutMs,
        });
      }
      return;
    }
  }
  const current = await getVideoGenerationSettingsSnapshot();
  const model = current.openAiRelay.model || CLAWX_OPENAI_VIDEO_DEFAULT_MODEL;
  const timeoutMs = CLAWX_OPENAI_VIDEO_DEFAULT_TIMEOUT_MS;
  const modelIds = orderedClawXOpenAiVideoModelIds(model);
  const primaryModel = `${CLAWX_OPENAI_VIDEO_PROVIDER_KEY}/${modelIds[0] ?? CLAWX_OPENAI_VIDEO_DEFAULT_MODEL}`;
  const relayState = readOpenAiCompatibleVideoRelayState(config as Record<string, unknown>);
  const relayAlreadyConfigured = relayState.enabled
    && relayState.providerKey === CLAWX_OPENAI_VIDEO_PROVIDER_KEY
    && relayState.baseUrl.trim() === current.openAiRelay.baseUrl.trim()
    && currentConfig.primary === primaryModel
    && currentConfig.timeoutMs === timeoutMs
    && currentConfig.fallbacks.length === 0;

  if (!relayAlreadyConfigured) {
    await applyOpenAiVideoRelaySettings({
      enabled: true,
      baseUrl: current.openAiRelay.baseUrl,
      model,
      timeoutMs,
    });
    return;
  }

  if (currentConfig.primary !== primaryModel || currentConfig.timeoutMs !== timeoutMs || currentConfig.fallbacks.length > 0) {
    await setVideoGenerationConfig({
      primary: primaryModel,
      fallbacks: [],
      timeoutMs,
    });
  }
}

export async function generateVideoForChatSession(params: {
  sessionKey: string;
  prompt: string;
  model?: string;
  size?: string;
  durationSeconds?: number;
  inputImages?: VideoGenerationInputImageRef[];
}, options?: { skipManagedRelayPreparation?: boolean }): Promise<Awaited<ReturnType<typeof generateVideoInProcess>>> {
  if (!options?.skipManagedRelayPreparation) {
    await ensureManagedOpenAiVideoRelay();
  }

  const snapshot = await listAgentsSnapshot();
  const agentId = params.sessionKey.split(':')[1] || snapshot.defaultAgentId;
  const agent = snapshot.agents.find((entry) => entry.id === agentId);
  if (!agent) {
    throw new Error(`Agent "${agentId}" not found`);
  }

  const config = await readOpenClawConfig();
  const current = await getVideoGenerationSettingsSnapshot();
  const inputImages = normalizeInputImageRefs(params.inputImages);
  const requestedModel = params.model?.trim();
  const configuredModel = requestedModel
    ? (requestedModel.includes('/') ? requestedModel : `${CLAWX_OPENAI_VIDEO_PROVIDER_KEY}/${requestedModel}`)
    : current.config.primary
      || `${CLAWX_OPENAI_VIDEO_PROVIDER_KEY}/${current.openAiRelay.model || CLAWX_OPENAI_VIDEO_DEFAULT_MODEL}`;
  const providerKey = parseProviderFromVideoModelRef(configuredModel);
  const directApiKey = providerKey === CLAWX_OPENAI_VIDEO_PROVIDER_KEY
    ? await resolveVideoRelayApiKey(CLAWX_OPENAI_VIDEO_PROVIDER_KEY, agentId)
    : null;

  return generateVideoInProcess({
    config,
    agentDir: expandOpenClawPath(agent.agentDir),
    prompt: params.prompt.trim(),
    model: configuredModel,
    timeoutMs: CLAWX_OPENAI_VIDEO_DEFAULT_TIMEOUT_MS,
    size: params.size?.trim() || DEFAULT_TEST_VIDEO_SIZE,
    durationSeconds: params.durationSeconds ?? DEFAULT_TEST_DURATION_SECONDS,
    inputImages,
    directOpenAiCompatible: directApiKey && current.openAiRelay.baseUrl
      ? {
        baseUrl: current.openAiRelay.baseUrl,
        apiKey: directApiKey,
      }
      : undefined,
  });
}
