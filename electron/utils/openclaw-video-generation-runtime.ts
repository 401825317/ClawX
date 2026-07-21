/**
 * In-process OpenClaw video generation runtime (no CLI subprocess).
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  JUNFEIAI_VIDEO_GENERATION_DEFAULT_SIZE,
  JUNFEIAI_VIDEO_GENERATION_POLL_INTERVAL_MS,
} from '../../shared/junfeiai-endpoints';
import { proxyAwareFetch } from './proxy-fetch';
import { resolveOpenClawRuntimeModulePath } from './runtime-package-resolution';
import {
  CLAWX_OPENAI_VIDEO_15_MODEL,
  CLAWX_OPENAI_VIDEO_PROVIDER_KEY,
  isClawXOpenAiVideoModelId,
} from './openclaw-video-relay-constants';

export interface VideoGenerationInputImageAsset {
  filePath: string;
  mimeType?: string;
  fileName?: string;
  role?: string;
  metadata?: Record<string, unknown>;
}

type VideoGenerationSourceAsset = {
  url?: string;
  buffer?: Buffer;
  mimeType?: string;
  fileName?: string;
  role?: string;
  metadata?: Record<string, unknown>;
};

type VideoGenerationRuntimeModule = {
  generateVideo: (params: {
    cfg: unknown;
    prompt: string;
    agentDir?: string;
    modelOverride?: string;
    size?: string;
    durationSeconds?: number;
    timeoutMs?: number;
    inputImages?: VideoGenerationSourceAsset[];
  }) => Promise<{
    videos: Array<{
      buffer?: Buffer;
      url?: string;
      mimeType: string;
      fileName?: string;
      metadata?: Record<string, unknown>;
    }>;
    provider: string;
    model: string;
    attempts: unknown[];
    normalization?: unknown;
    metadata?: Record<string, unknown>;
    ignoredOverrides: unknown[];
  }>;
  listRuntimeVideoGenerationProviders: (params?: { config?: unknown }) => Array<{
    id: string;
    aliases?: string[];
    label?: string;
    defaultModel?: string;
    models?: string[];
    capabilities?: unknown;
  }>;
};

type MediaStoreModule = {
  saveMediaBuffer: (
    buffer: Buffer,
    mimeType: string,
    subdir: string,
    maxBytes: number,
    originalFilename?: string,
  ) => Promise<{ path: string; contentType: string; size: number }>;
};

type DirectOpenAiCompatibleVideoOptions = {
  baseUrl: string;
  apiKey: string;
};

type DirectVideoTaskPayload = {
  id?: unknown;
  task_id?: unknown;
  status?: unknown;
  model?: unknown;
  result_url?: unknown;
  url?: unknown;
  seconds?: unknown;
  size?: unknown;
  error?: unknown;
  video?: {
    url?: unknown;
  };
  data?: DirectVideoTaskPayload;
};

const OPENCLAW_VIDEO_GENERATION_RUNTIME = 'openclaw/plugin-sdk/video-generation-runtime';
const OPENCLAW_MEDIA_STORE = 'openclaw/plugin-sdk/media-store';
const OFFICIAL_OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
const DIRECT_POLL_INTERVAL_MS = JUNFEIAI_VIDEO_GENERATION_POLL_INTERVAL_MS;

let videoRuntimeModule: VideoGenerationRuntimeModule | null = null;
let mediaStoreModule: MediaStoreModule | null = null;

async function importOpenClawSdkModule<T>(specifier: string): Promise<T> {
  const modulePath = resolveOpenClawRuntimeModulePath(specifier);
  return import(pathToFileURL(modulePath).href) as Promise<T>;
}

async function getVideoGenerationRuntime(): Promise<VideoGenerationRuntimeModule> {
  if (!videoRuntimeModule) {
    const mod = await importOpenClawSdkModule<{
      generateVideo: VideoGenerationRuntimeModule['generateVideo'];
      listRuntimeVideoGenerationProviders: VideoGenerationRuntimeModule['listRuntimeVideoGenerationProviders'];
    }>(OPENCLAW_VIDEO_GENERATION_RUNTIME);
    videoRuntimeModule = {
      generateVideo: mod.generateVideo,
      listRuntimeVideoGenerationProviders: mod.listRuntimeVideoGenerationProviders,
    };
  }
  return videoRuntimeModule;
}

async function getMediaStore(): Promise<MediaStoreModule> {
  if (!mediaStoreModule) {
    const mod = await importOpenClawSdkModule<{ saveMediaBuffer: MediaStoreModule['saveMediaBuffer'] }>(
      OPENCLAW_MEDIA_STORE,
    );
    mediaStoreModule = { saveMediaBuffer: mod.saveMediaBuffer };
  }
  return mediaStoreModule;
}

function resolvePrimaryRef(videoGenerationModel: unknown): string | undefined {
  if (typeof videoGenerationModel === 'string' && videoGenerationModel.trim()) {
    return videoGenerationModel.trim();
  }
  if (!videoGenerationModel || typeof videoGenerationModel !== 'object' || Array.isArray(videoGenerationModel)) {
    return undefined;
  }
  const primary = (videoGenerationModel as Record<string, unknown>).primary;
  return typeof primary === 'string' && primary.trim() ? primary.trim() : undefined;
}

async function loadInputImages(
  images: VideoGenerationInputImageAsset[] | undefined,
): Promise<VideoGenerationSourceAsset[] | undefined> {
  const refs = (images ?? [])
    .map((image) => ({
      filePath: image.filePath?.trim() || '',
      mimeType: image.mimeType?.trim() || undefined,
      fileName: image.fileName?.trim() || undefined,
      role: image.role?.trim() || undefined,
      metadata: image.metadata,
    }))
    .filter((image) => image.filePath.length > 0);
  if (refs.length === 0) {
    return undefined;
  }

  return Promise.all(refs.map(async (image) => ({
    buffer: await readFile(image.filePath),
    mimeType: image.mimeType || 'image/png',
    fileName: image.fileName || basename(image.filePath),
    role: image.role || 'first_frame',
    metadata: {
      ...(image.metadata ?? {}),
      filePath: image.filePath,
    },
  })));
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseVideoSize(size: string | undefined): { width?: number; height?: number } {
  const match = size?.trim().match(/^(\d{2,5})\s*x\s*(\d{2,5})$/i);
  if (!match) {
    return {};
  }
  return {
    width: Number.parseInt(match[1]!, 10),
    height: Number.parseInt(match[2]!, 10),
  };
}

function normalizeDurationSeconds(durationSeconds: number | undefined): number {
  return typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
    ? Math.max(1, Math.round(durationSeconds))
    : 4;
}

function buildVideoOutputMetadata(params: {
  metadata?: Record<string, unknown>;
  size?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
}): Record<string, unknown> {
  return {
    ...(params.metadata ?? {}),
    ...(params.size ? { size: params.size } : {}),
    width: params.width,
    height: params.height,
    durationSeconds: params.durationSeconds,
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function parseModelRef(modelRef: string): { provider: string; model: string } | null {
  const trimmed = modelRef.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return null;
  }
  return {
    provider: trimmed.slice(0, slash).trim().toLowerCase(),
    model: trimmed.slice(slash + 1).trim(),
  };
}

function listAdvertisedVideoModels(provider: {
  defaultModel?: string;
  models?: string[];
}): Set<string> {
  const models = new Set((provider.models ?? []).map((model) => model.trim()).filter(Boolean));
  if (models.size === 0 && provider.defaultModel?.trim()) {
    models.add(provider.defaultModel.trim());
  }
  return models;
}

function validateVideoModelRef(
  modelRef: string,
  providers: ReturnType<VideoGenerationRuntimeModule['listRuntimeVideoGenerationProviders']>,
): { provider: string; model: string } {
  const parsed = parseModelRef(modelRef);
  if (!parsed) {
    throw new Error(`invalid_video_model: "${modelRef}" must use provider/model format.`);
  }
  const provider = providers.find((candidate) => {
    const ids = [candidate.id, ...(candidate.aliases ?? [])]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    return ids.includes(parsed.provider);
  });
  if (!provider || !listAdvertisedVideoModels(provider).has(parsed.model)) {
    throw new Error(
      `invalid_video_model: "${modelRef}" is not advertised by a registered video-generation provider.`,
    );
  }
  return { provider: provider.id, model: parsed.model };
}

function isOfficialOpenAiBaseUrl(baseUrl: string): boolean {
  return normalizeBaseUrl(baseUrl).toLowerCase() === OFFICIAL_OPENAI_API_BASE_URL;
}

function bufferToDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function isCompleteVideoStatus(status: unknown): boolean {
  const normalized = normalizeOptionalString(status)?.toLowerCase();
  return normalized === 'completed'
    || normalized === 'succeeded'
    || normalized === 'success'
    || normalized === 'done';
}

function getVideoFailureMessage(payload: DirectVideoTaskPayload): string | null {
  const normalized = normalizeOptionalString(payload.status)?.toLowerCase();
  if (normalized !== 'failed' && normalized !== 'cancelled' && normalized !== 'canceled') {
    return null;
  }

  const error = payload.error;
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = normalizeOptionalString((error as Record<string, unknown>).message);
    if (message) {
      return message;
    }
  }
  return `Video generation failed with status "${normalized}"`;
}

function extractTaskId(payload: DirectVideoTaskPayload): string | undefined {
  return normalizeOptionalString(payload.id)
    ?? normalizeOptionalString(payload.task_id)
    ?? normalizeOptionalString(payload.data?.id)
    ?? normalizeOptionalString(payload.data?.task_id);
}

function extractVideoResultUrl(payload: DirectVideoTaskPayload): string | undefined {
  return normalizeOptionalString(payload.result_url)
    ?? normalizeOptionalString(payload.url)
    ?? normalizeOptionalString(payload.video?.url)
    ?? normalizeOptionalString(payload.data?.result_url)
    ?? normalizeOptionalString(payload.data?.url)
    ?? normalizeOptionalString(payload.data?.video?.url);
}

function buildContentUrl(baseUrl: string, taskId: string): string {
  return `${normalizeBaseUrl(baseUrl)}/videos/${encodeURIComponent(taskId)}/content`;
}

function buildDirectVideoRequestBody(params: {
  prompt: string;
  model: string;
  size?: string;
  durationSeconds?: number;
  inputImages?: VideoGenerationSourceAsset[];
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: params.prompt,
    model: params.model,
  };

  if (params.size?.trim()) {
    body.size = params.size.trim();
  }
  if (typeof params.durationSeconds === 'number' && Number.isFinite(params.durationSeconds)) {
    body.seconds = String(Math.max(1, Math.round(params.durationSeconds)));
  }

  const firstImage = params.inputImages?.find((image) => image.buffer && image.buffer.length > 0);
  if (firstImage?.buffer) {
    body.image = bufferToDataUrl(firstImage.buffer, firstImage.mimeType || 'image/png');
  }

  return body;
}

function readErrorText(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const error = record.error;
    if (typeof error === 'string' && error.trim()) {
      return error.trim();
    }
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const message = normalizeOptionalString((error as Record<string, unknown>).message);
      if (message) return message;
    }
    const message = normalizeOptionalString(record.message);
    if (message) return message;
  }
  return fallback;
}

async function fetchJsonWithTimeout(params: {
  url: string;
  init: RequestInit;
  timeoutMs: number;
  label: string;
}): Promise<DirectVideoTaskPayload> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, params.timeoutMs));
  try {
    const response = await proxyAwareFetch(params.url, {
      ...params.init,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    if (!response.ok) {
      throw new Error(readErrorText(payload, `${params.label} failed with HTTP ${response.status}`));
    }
    return (payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : {}) as DirectVideoTaskPayload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${params.label} timed out`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollDirectOpenAiCompatibleVideo(params: {
  baseUrl: string;
  apiKey: string;
  taskId: string;
  timeoutMs: number;
}): Promise<DirectVideoTaskPayload> {
  const startedAt = Date.now();
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  let lastPayload: DirectVideoTaskPayload | null = null;

  while (Date.now() - startedAt < params.timeoutMs) {
    const payload = await fetchJsonWithTimeout({
      url: `${baseUrl}/videos/${encodeURIComponent(params.taskId)}`,
      init: {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${params.apiKey}`,
        },
      },
      timeoutMs: Math.min(30_000, Math.max(1, params.timeoutMs - (Date.now() - startedAt))),
      label: 'Video status request',
    });
    lastPayload = payload;

    const failureMessage = getVideoFailureMessage(payload);
    if (failureMessage) {
      throw new Error(failureMessage);
    }
    if (isCompleteVideoStatus(payload.status) || extractVideoResultUrl(payload)) {
      return payload;
    }

    await sleep(DIRECT_POLL_INTERVAL_MS);
  }

  const status = normalizeOptionalString(lastPayload?.status);
  throw new Error(
    status
      ? `Video generation task ${params.taskId} did not finish in time; last status was "${status}"`
      : `Video generation task ${params.taskId} did not finish in time`,
  );
}

async function generateDirectOpenAiCompatibleVideo(params: {
  baseUrl: string;
  apiKey: string;
  prompt: string;
  model: string;
  size?: string;
  durationSeconds?: number;
  timeoutMs: number;
  inputImages?: VideoGenerationSourceAsset[];
}): Promise<{
  videos: Array<{
    url: string;
    mimeType: string;
    fileName?: string;
    metadata?: Record<string, unknown>;
  }>;
  provider: string;
  model: string;
  attempts: unknown[];
  metadata?: Record<string, unknown>;
  ignoredOverrides: unknown[];
}> {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const submitted = await fetchJsonWithTimeout({
    url: `${baseUrl}/videos`,
    init: {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildDirectVideoRequestBody({
        prompt: params.prompt,
        model: params.model,
        size: params.size,
        durationSeconds: params.durationSeconds,
        inputImages: params.inputImages,
      })),
    },
    timeoutMs: Math.max(1, params.timeoutMs),
    label: 'Video generation request',
  });
  const taskId = extractTaskId(submitted);
  if (!taskId) {
    throw new Error('Video generation response missing task id');
  }

  const completed = isCompleteVideoStatus(submitted.status) || extractVideoResultUrl(submitted)
    ? submitted
    : await pollDirectOpenAiCompatibleVideo({
      baseUrl,
      apiKey: params.apiKey,
      taskId,
      timeoutMs: Math.max(1, params.timeoutMs - 1000),
    });

  const url = extractVideoResultUrl(completed) ?? buildContentUrl(baseUrl, taskId);
  return {
    videos: [{
      url,
      mimeType: 'video/mp4',
      fileName: `${taskId}.mp4`,
      metadata: {
        taskId,
        status: normalizeOptionalString(completed.status),
        seconds: completed.seconds ?? submitted.seconds,
        size: completed.size ?? submitted.size,
      },
    }],
    provider: 'openai',
    model: normalizeOptionalString(completed.model) ?? normalizeOptionalString(submitted.model) ?? params.model,
    attempts: [],
    metadata: {
      taskId,
      status: normalizeOptionalString(completed.status),
    },
    ignoredOverrides: [],
  };
}

export async function listVideoGenerationProvidersInProcess(params: {
  config: unknown;
  isProviderConfigured: (providerId: string) => Promise<boolean>;
}): Promise<Array<{
  id: string;
  aliases: string[];
  label: string;
  defaultModel: string;
  configured: boolean;
  available: boolean;
  selected: boolean;
  models: string[];
}>> {
  const { listRuntimeVideoGenerationProviders } = await getVideoGenerationRuntime();
  const defaults = (params.config as { agents?: { defaults?: { videoGenerationModel?: unknown } } })
    ?.agents?.defaults;
  const primaryRef = resolvePrimaryRef(defaults?.videoGenerationModel);
  const selectedProvider = primaryRef?.includes('/')
    ? primaryRef.slice(0, primaryRef.indexOf('/')).trim().toLowerCase()
    : undefined;

  const providers = listRuntimeVideoGenerationProviders({ config: params.config });
  return Promise.all(providers.map(async (provider) => ({
    available: true,
    configured: selectedProvider === provider.id || await params.isProviderConfigured(provider.id),
    selected: selectedProvider === provider.id,
    id: provider.id,
    aliases: provider.aliases ?? [],
    label: provider.label ?? provider.id,
    defaultModel: provider.defaultModel ?? '',
    models: provider.models ?? [],
  })));
}

export async function generateVideoInProcess(params: {
  config: unknown;
  agentDir: string;
  prompt: string;
  model: string;
  timeoutMs: number;
  size?: string;
  durationSeconds?: number;
  inputImages?: VideoGenerationInputImageAsset[];
  directOpenAiCompatible?: DirectOpenAiCompatibleVideoOptions;
}): Promise<{
  ok: true;
  capability: 'video.generate';
  transport: 'local';
  provider: string;
  model: string;
  attempts: unknown[];
  outputs: Array<{
    path?: string;
    url?: string;
    mimeType: string;
    size?: number;
    fileName?: string;
    metadata?: Record<string, unknown>;
    outputIndex: number;
  }>;
  normalization?: unknown;
  metadata?: Record<string, unknown>;
  ignoredOverrides: unknown[];
}> {
  const runtime = await getVideoGenerationRuntime();
  const parsedModel = validateVideoModelRef(
    params.model,
    runtime.listRuntimeVideoGenerationProviders({ config: params.config }),
  );
  const inputImages = await loadInputImages(params.inputImages);
  const imageCount = inputImages?.filter((image) => image.buffer && image.buffer.length > 0).length ?? 0;
  const requestedSize = params.size?.trim() || JUNFEIAI_VIDEO_GENERATION_DEFAULT_SIZE;
  const requestedDurationSeconds = normalizeDurationSeconds(params.durationSeconds);
  const requestedDimensions = parseVideoSize(requestedSize);

  if (parsedModel.provider === CLAWX_OPENAI_VIDEO_PROVIDER_KEY
    && params.directOpenAiCompatible
    && !isOfficialOpenAiBaseUrl(params.directOpenAiCompatible.baseUrl)
    && !isClawXOpenAiVideoModelId(parsedModel.model)) {
    throw new Error(
      `invalid_video_model: "${parsedModel.model}" is not supported by the managed OpenAI-compatible video relay.`,
    );
  }

  if (parsedModel.provider === CLAWX_OPENAI_VIDEO_PROVIDER_KEY
    && parsedModel.model === CLAWX_OPENAI_VIDEO_15_MODEL
    && imageCount !== 1) {
    throw new Error('grok-video-1.5 requires exactly one reference image.');
  }

  if (
    parsedModel.provider === CLAWX_OPENAI_VIDEO_PROVIDER_KEY
    && params.directOpenAiCompatible?.baseUrl
    && params.directOpenAiCompatible.apiKey
    && !isOfficialOpenAiBaseUrl(params.directOpenAiCompatible.baseUrl)
  ) {
    const result = await generateDirectOpenAiCompatibleVideo({
      baseUrl: params.directOpenAiCompatible.baseUrl,
      apiKey: params.directOpenAiCompatible.apiKey,
      prompt: params.prompt,
      model: parsedModel.model,
      size: requestedSize,
      durationSeconds: requestedDurationSeconds,
      timeoutMs: params.timeoutMs,
      inputImages,
    });

    return {
      ok: true,
      capability: 'video.generate',
      transport: 'local',
      provider: result.provider,
      model: result.model,
      attempts: result.attempts,
      outputs: result.videos.map((video, index) => ({
        url: video.url,
        mimeType: video.mimeType,
        fileName: video.fileName,
        width: requestedDimensions.width,
        height: requestedDimensions.height,
        durationSeconds: requestedDurationSeconds,
        metadata: buildVideoOutputMetadata({
          metadata: video.metadata,
          size: requestedSize,
          durationSeconds: requestedDurationSeconds,
          ...requestedDimensions,
        }),
        outputIndex: index,
      })),
      metadata: result.metadata,
      ignoredOverrides: result.ignoredOverrides,
    };
  }

  const { generateVideo } = runtime;
  const { saveMediaBuffer } = await getMediaStore();

  const result = await generateVideo({
    cfg: params.config,
    agentDir: params.agentDir,
    prompt: params.prompt,
    modelOverride: params.model,
    size: requestedSize,
    durationSeconds: requestedDurationSeconds,
    timeoutMs: params.timeoutMs,
    inputImages,
  });

  const outputs = await Promise.all(result.videos.map(async (video, index) => {
    if (video.buffer && video.buffer.length > 0) {
      const saved = await saveMediaBuffer(
        video.buffer,
        video.mimeType,
        'generated',
        Number.MAX_SAFE_INTEGER,
        video.fileName,
      );
      return {
        path: saved.path,
        mimeType: saved.contentType,
        size: saved.size,
        fileName: video.fileName,
        width: requestedDimensions.width,
        height: requestedDimensions.height,
        durationSeconds: requestedDurationSeconds,
        metadata: buildVideoOutputMetadata({
          metadata: video.metadata,
          size: requestedSize,
          durationSeconds: requestedDurationSeconds,
          ...requestedDimensions,
        }),
        outputIndex: index,
      };
    }

    if (video.url && video.url.trim()) {
      return {
        url: video.url.trim(),
        mimeType: video.mimeType,
        fileName: video.fileName,
        width: requestedDimensions.width,
        height: requestedDimensions.height,
        durationSeconds: requestedDurationSeconds,
        metadata: buildVideoOutputMetadata({
          metadata: video.metadata,
          size: requestedSize,
          durationSeconds: requestedDurationSeconds,
          ...requestedDimensions,
        }),
        outputIndex: index,
      };
    }

    throw new Error('Video generation returned an empty asset without buffer or URL');
  }));

  return {
    ok: true,
    capability: 'video.generate',
    transport: 'local',
    provider: result.provider,
    model: result.model,
    attempts: result.attempts,
    outputs,
    normalization: result.normalization,
    metadata: result.metadata,
    ignoredOverrides: result.ignoredOverrides,
  };
}
