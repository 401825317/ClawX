/**
 * Read/write agents.defaults.imageGenerationModel and per-agent auth readiness.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { readOpenClawConfig, writeOpenClawConfig } from './channel-config';
import { withConfigLock } from './config-mutex';
import {
  getOAuthTokenFromOpenClaw,
  getProviderApiKeyFromOpenClaw,
  readOpenAiCompatibleImageRelayState,
  syncOpenAiCompatibleImageRelay,
} from './openclaw-auth';
import { ensureClawXOpenAiImagePluginInstalled } from './plugin-install';
import { listAgentsSnapshot, type AgentsSnapshot } from './agent-config';
import { expandOpenClawPath } from './paths';
import {
  generateImageInProcess,
  resolveImageGenerationPrimaryFromConfig,
  listImageGenerationProvidersInProcess,
} from './openclaw-image-generation-runtime';
import { OPENAI_CODEX_RUNTIME_PROVIDER_KEY } from './provider-keys';
import {
  CLAWX_OPENAI_IMAGE_DEFAULT_MODEL,
  CLAWX_OPENAI_IMAGE_DEFAULT_REF,
  CLAWX_OPENAI_IMAGE_PROVIDER_KEY,
} from './openclaw-image-relay-constants';
import { getJunFeiAIDefaultBaseUrl, JUNFEIAI_PROVIDER_ID } from './junfeiai-distribution';
import { getProviderSecret } from '../services/secrets/secret-store';
import {
  JUNFEIAI_IMAGE_GENERATION_TIMEOUT_MS,
  JUNFEIAI_MEDIA_GENERATION_TEST_TIMEOUT_MS,
} from '../../shared/junfeiai-endpoints';

export interface ImageGenerationModelConfig {
  primary: string | null;
  fallbacks: string[];
  timeoutMs: number | null;
}

export interface ImageGenerationProviderRow {
  id: string;
  label: string;
  defaultModel: string;
  configured: boolean;
  available: boolean;
  selected: boolean;
  models: string[];
}

export interface ImageGenerationAgentAuthRow {
  id: string;
  name: string;
  isDefault: boolean;
  provider: string | null;
  configured: boolean;
}

export interface OpenAiImageRelayConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  providerKey?: string;
  apiKeyConfigured: boolean;
  inheritedFromManagedAccount?: boolean;
}

export interface ImageGenerationSettingsSnapshot {
  config: ImageGenerationModelConfig;
  autoProviderFallback: boolean;
  defaultAgentId: string;
  agents: ImageGenerationAgentAuthRow[];
  openAiRelay: OpenAiImageRelayConfig;
}

function isApiKeySecret(
  secret: Awaited<ReturnType<typeof getProviderSecret>>,
): secret is Extract<NonNullable<Awaited<ReturnType<typeof getProviderSecret>>>, { type: 'api_key' }> {
  return Boolean(secret && secret.type === 'api_key' && secret.apiKey?.trim());
}

async function getManagedImageRelayDefaults(): Promise<{
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

export interface ImageGenerationTestResult {
  success: boolean;
  agentId: string;
  command: string;
  durationMs: number;
  error?: string;
  stdout?: string;
  stderr?: string;
  result?: unknown;
}

export interface ImageGenerationInputImageRef {
  filePath: string;
  fileName?: string;
  mimeType?: string;
}

const DEFAULT_TEST_PROMPT = 'A small red circle on a white background, minimal flat illustration.';
/** Some relays (e.g. gpt-image-2) reject 512×512 as below minimum pixel budget. */
const DEFAULT_TEST_IMAGE_SIZE = '1024x1024';
const DEFAULT_TEST_TIMEOUT_MS = JUNFEIAI_IMAGE_GENERATION_TIMEOUT_MS;
export const IMAGE_GEN_CHAT_DEFAULT_TIMEOUT_MS = JUNFEIAI_IMAGE_GENERATION_TIMEOUT_MS;
/** Cap UI test duration so Models page does not wait on multi-minute config timeouts. */
export const IMAGE_GEN_UI_TEST_MAX_TIMEOUT_MS = JUNFEIAI_MEDIA_GENERATION_TEST_TIMEOUT_MS;

type AgentModelConfigShape = {
  primary?: string;
  fallbacks?: string[];
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeModelRef(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  return null;
}

export function toManagedOpenAiImageModelRef(
  _raw: string | null | undefined,
  _fallbackModel = CLAWX_OPENAI_IMAGE_DEFAULT_MODEL,
): string {
  return CLAWX_OPENAI_IMAGE_DEFAULT_REF;
}

export function resolveChatImageTimeoutMs(_timeoutMs: number | null | undefined): number {
  return IMAGE_GEN_CHAT_DEFAULT_TIMEOUT_MS;
}

function normalizeInputImageRefs(raw: ImageGenerationInputImageRef[] | undefined): ImageGenerationInputImageRef[] {
  return (raw ?? [])
    .map((image) => ({
      filePath: image.filePath?.trim() || '',
      fileName: image.fileName?.trim() || undefined,
      mimeType: image.mimeType?.trim() || undefined,
    }))
    .filter((image) => image.filePath.length > 0);
}

async function loadInputImages(
  refs: ImageGenerationInputImageRef[],
): Promise<Array<{ buffer: Buffer; mimeType: string; fileName?: string; metadata?: Record<string, unknown> }>> {
  return Promise.all(refs.map(async (image) => {
    const buffer = await readFile(image.filePath);
    return {
      buffer,
      mimeType: image.mimeType || 'image/png',
      fileName: image.fileName || basename(image.filePath),
      metadata: { filePath: image.filePath },
    };
  }));
}

function parseImageGenerationModelConfig(raw: unknown): ImageGenerationModelConfig {
  const normalizeConfig = (config: ImageGenerationModelConfig): ImageGenerationModelConfig => ({
    primary: config.primary ? CLAWX_OPENAI_IMAGE_DEFAULT_REF : null,
    fallbacks: [],
    timeoutMs: config.timeoutMs,
  });

  if (typeof raw === 'string') {
    const primary = normalizeModelRef(raw);
    return normalizeConfig({ primary, fallbacks: [], timeoutMs: null });
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
  return normalizeConfig({ primary, fallbacks: [...new Set(fallbacks)], timeoutMs });
}

function buildImageGenerationModelConfigWrite(
  config: ImageGenerationModelConfig,
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

export function parseProviderFromModelRef(modelRef: string): string | null {
  const trimmed = modelRef.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return null;
  }
  return trimmed.slice(0, slash).trim().toLowerCase();
}

export function isValidImageModelRef(modelRef: string): boolean {
  return parseProviderFromModelRef(modelRef) !== null;
}

function isManagedOpenAiImageModelRef(modelRef: string | null | undefined): boolean {
  return Boolean(modelRef?.trim()) && parseProviderFromModelRef(modelRef ?? '') === CLAWX_OPENAI_IMAGE_PROVIDER_KEY;
}

function authProviderCandidates(providerKey: string): string[] {
  const normalized = providerKey.trim().toLowerCase();
  if (normalized === 'openai') {
    return ['openai', OPENAI_CODEX_RUNTIME_PROVIDER_KEY];
  }
  return [normalized];
}

export async function isImageProviderAuthenticated(
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

export async function readImageGenerationConfig(): Promise<ImageGenerationModelConfig> {
  const config = await readOpenClawConfig();
  const defaults = config.agents?.defaults;
  if (!defaults || typeof defaults !== 'object') {
    return { primary: null, fallbacks: [], timeoutMs: null };
  }
  return parseImageGenerationModelConfig(
    (defaults as Record<string, unknown>).imageGenerationModel,
  );
}

export async function setImageGenerationConfig(
  next: ImageGenerationModelConfig,
): Promise<ImageGenerationModelConfig> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig();
    const agents = (config.agents && typeof config.agents === 'object'
      ? { ...(config.agents as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    const defaults = (agents.defaults && typeof agents.defaults === 'object'
      ? { ...(agents.defaults as Record<string, unknown>) }
      : {}) as Record<string, unknown>;

    const writeValue = buildImageGenerationModelConfigWrite({
      primary: next.primary ? CLAWX_OPENAI_IMAGE_DEFAULT_REF : null,
      fallbacks: [],
      timeoutMs: IMAGE_GEN_CHAT_DEFAULT_TIMEOUT_MS,
    });

    if (writeValue) {
      defaults.imageGenerationModel = writeValue;
    } else {
      delete defaults.imageGenerationModel;
    }
    // ClawX image generation is configured as one explicit custom endpoint.
    // Keep OpenClaw from appending other authenticated image providers such as
    // minimax-portal/image-01 after the configured ClawX image provider.
    defaults.mediaGenerationAutoProviderFallback = false;

    agents.defaults = defaults;
    config.agents = agents;
    await writeOpenClawConfig(config);

    return readImageGenerationConfig();
  });
}

async function buildAgentAuthRows(
  snapshot: AgentsSnapshot,
  providerKey: string | null,
): Promise<ImageGenerationAgentAuthRow[]> {
  if (!providerKey) {
    return snapshot.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      isDefault: agent.isDefault,
      provider: null,
      configured: false,
    }));
  }

  const rows: ImageGenerationAgentAuthRow[] = [];
  for (const agent of snapshot.agents) {
    const configured = await isImageProviderAuthenticated(providerKey, agent.id);
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

function resolveOpenAiImageRelayModelId(
  _config: ImageGenerationModelConfig,
  _openclawConfig: Record<string, unknown>,
): string {
  return CLAWX_OPENAI_IMAGE_DEFAULT_MODEL;
}

export async function getImageGenerationSettingsSnapshot(): Promise<ImageGenerationSettingsSnapshot> {
  const config = await readImageGenerationConfig();
  const snapshot = await listAgentsSnapshot();
  const openclawConfig = await readOpenClawConfig();
  const defaults = openclawConfig.agents?.defaults;
  const autoProviderFallback = !(
    defaults
    && typeof defaults === 'object'
    && (defaults as Record<string, unknown>).mediaGenerationAutoProviderFallback === false
  );

  const providerKey = config.primary ? parseProviderFromModelRef(config.primary) : null;
  const relayState = readOpenAiCompatibleImageRelayState(openclawConfig as Record<string, unknown>);
  const relayAuthProvider = relayState.providerKey === 'openai' ? 'openai' : CLAWX_OPENAI_IMAGE_PROVIDER_KEY;
  const relayKeyConfigured = await isImageProviderAuthenticated(relayAuthProvider, snapshot.defaultAgentId);
  const managedDefaults = await getManagedImageRelayDefaults();
  const effectiveBaseUrl = relayState.baseUrl || managedDefaults.baseUrl;
  const effectiveProviderKey = relayState.providerKey ?? (managedDefaults.inherited ? CLAWX_OPENAI_IMAGE_PROVIDER_KEY : undefined);

  return {
    config,
    autoProviderFallback,
    defaultAgentId: snapshot.defaultAgentId,
    agents: await buildAgentAuthRows(snapshot, providerKey),
    openAiRelay: {
      enabled: relayState.enabled || managedDefaults.inherited,
      baseUrl: effectiveBaseUrl,
      model: resolveOpenAiImageRelayModelId(config, openclawConfig as Record<string, unknown>),
      providerKey: effectiveProviderKey,
      apiKeyConfigured: relayKeyConfigured || managedDefaults.inherited,
      inheritedFromManagedAccount: managedDefaults.inherited,
    },
  };
}

export async function applyOpenAiImageRelaySettings(params: {
  enabled: boolean;
  baseUrl?: string | null;
  apiKey?: string;
  model?: string | null;
}): Promise<void> {
  const managedDefaults = await getManagedImageRelayDefaults();
  await syncOpenAiCompatibleImageRelay({
    enabled: params.enabled,
    baseUrl: params.enabled ? ((params.baseUrl ?? '').trim() || managedDefaults.baseUrl) : null,
    apiKey: params.apiKey?.trim() || managedDefaults.apiKey || undefined,
    imageModelIds: [CLAWX_OPENAI_IMAGE_DEFAULT_MODEL],
  });
  if (params.enabled) {
    ensureClawXOpenAiImagePluginInstalled();
  }
}

export async function listImageGenerationProvidersFromRuntime(): Promise<ImageGenerationProviderRow[]> {
  const cfg = await readOpenClawConfig();
  const snapshot = await listAgentsSnapshot();
  const rows = await listImageGenerationProvidersInProcess({
    config: cfg,
    isProviderConfigured: (providerId) => isImageProviderAuthenticated(providerId, snapshot.defaultAgentId),
  });
  return rows.filter((row) => row.id === CLAWX_OPENAI_IMAGE_PROVIDER_KEY);
}

function resolveAgentDirForTest(agentId: string, snapshot: AgentsSnapshot): string {
  const entry = snapshot.agents.find((agent) => agent.id === agentId);
  const agentDir = entry?.agentDir || `~/.openclaw/agents/${agentId}/agent`;
  return expandOpenClawPath(agentDir);
}

export async function runImageGenerationTest(params: {
  agentId?: string;
  prompt?: string;
  model?: string;
}): Promise<ImageGenerationTestResult> {
  const snapshot = await listAgentsSnapshot();
  const agentId = params.agentId?.trim() || snapshot.defaultAgentId;
  const agent = snapshot.agents.find((entry) => entry.id === agentId);
  if (!agent) {
    throw new Error(`Agent "${agentId}" not found`);
  }

  const model = CLAWX_OPENAI_IMAGE_DEFAULT_REF;

  const providerKey = parseProviderFromModelRef(model);
  if (!providerKey) {
    throw new Error('Invalid image model ref');
  }

  const authenticated = await isImageProviderAuthenticated(providerKey, agentId);
  if (!authenticated) {
    throw new Error(
      `Agent "${agent.name}" is not authenticated for image provider "${providerKey}". `
      + 'Add an API key or OAuth for this provider.',
    );
  }

  const agentDir = resolveAgentDirForTest(agentId, snapshot);
  const prompt = params.prompt?.trim() || DEFAULT_TEST_PROMPT;
  const generateTimeoutMs = Math.min(
    DEFAULT_TEST_TIMEOUT_MS,
    IMAGE_GEN_UI_TEST_MAX_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  const command = `runtime:generateImage model=${model} agentDir=${agentDir}`;

  try {
    const openclawConfig = await readOpenClawConfig();
    const result = await generateImageInProcess({
      config: openclawConfig,
      agentDir,
      prompt,
      model,
      timeoutMs: generateTimeoutMs,
      size: DEFAULT_TEST_IMAGE_SIZE,
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

export async function ensureManagedOpenAiImageRelay(
  options: { preserveExisting?: boolean } = {},
): Promise<void> {
  const config = await readOpenClawConfig();
  const currentModel = await resolveImageGenerationPrimaryFromConfig(config.agents?.defaults?.imageGenerationModel);
  if (options.preserveExisting && currentModel && !isManagedOpenAiImageModelRef(currentModel)) {
    return;
  }
  const current = await getImageGenerationSettingsSnapshot();
  const model = CLAWX_OPENAI_IMAGE_DEFAULT_MODEL;
  const managedModelRef = CLAWX_OPENAI_IMAGE_DEFAULT_REF;
  const timeoutMs = IMAGE_GEN_CHAT_DEFAULT_TIMEOUT_MS;
  const relayState = readOpenAiCompatibleImageRelayState(config as Record<string, unknown>);
  const relayModel = resolveOpenAiImageRelayModelId(current.config, config as Record<string, unknown>);
  const managedDefaults = await getManagedImageRelayDefaults();
  const models = isRecord(config.models) ? config.models : {};
  const providers = isRecord(models.providers) ? models.providers : {};
  const relayProvider = isRecord(providers[CLAWX_OPENAI_IMAGE_PROVIDER_KEY])
    ? providers[CLAWX_OPENAI_IMAGE_PROVIDER_KEY]
    : {};
  const relayApiKey = typeof relayProvider.apiKey === 'string' ? relayProvider.apiKey.trim() : '';
  const relayAlreadyConfigured = relayState.enabled
    && relayState.providerKey === CLAWX_OPENAI_IMAGE_PROVIDER_KEY
    && relayState.baseUrl.trim() === current.openAiRelay.baseUrl.trim()
    && relayModel === model
    && (!managedDefaults.apiKey || relayApiKey === managedDefaults.apiKey);

  if (!relayAlreadyConfigured) {
    await applyOpenAiImageRelaySettings({
      enabled: true,
      baseUrl: current.openAiRelay.baseUrl,
      apiKey: managedDefaults.apiKey || undefined,
      model,
    });
  }

  if (!isManagedOpenAiImageModelRef(currentModel) || currentModel !== managedModelRef || current.config.timeoutMs !== timeoutMs) {
    await setImageGenerationConfig({
      primary: managedModelRef,
      fallbacks: [],
      timeoutMs,
    });
  }
}

export async function generateImageForChatSession(params: {
  sessionKey: string;
  prompt: string;
  model?: string;
  size?: string;
  quality?: 'low' | 'medium' | 'high';
  inputImages?: ImageGenerationInputImageRef[];
}, options?: { skipManagedRelayPreparation?: boolean }): Promise<Awaited<ReturnType<typeof generateImageInProcess>>> {
  if (!options?.skipManagedRelayPreparation) {
    await ensureManagedOpenAiImageRelay();
  }

  const snapshot = await listAgentsSnapshot();
  const agentId = params.sessionKey.split(':')[1] || snapshot.defaultAgentId;
  const agent = snapshot.agents.find((entry) => entry.id === agentId);
  if (!agent) {
    throw new Error(`Agent "${agentId}" not found`);
  }

  const config = await readOpenClawConfig();
  const current = await getImageGenerationSettingsSnapshot();
  const configuredModel = CLAWX_OPENAI_IMAGE_DEFAULT_REF;
  const inputImageRefs = normalizeInputImageRefs(params.inputImages);
  const loadedInputImages = await loadInputImages(inputImageRefs);

  return generateImageInProcess({
    config,
    agentDir: expandOpenClawPath(agent.agentDir),
    prompt: params.prompt.trim(),
    model: configuredModel,
    timeoutMs: current ? resolveChatImageTimeoutMs(current.config.timeoutMs) : IMAGE_GEN_CHAT_DEFAULT_TIMEOUT_MS,
    size: params.size?.trim() || DEFAULT_TEST_IMAGE_SIZE,
    quality: params.quality,
    inputImages: loadedInputImages,
  });
}
