import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { isProviderApiKeyConfigured } from 'openclaw/plugin-sdk/provider-auth';
import { resolveApiKeyForProvider } from 'openclaw/plugin-sdk/provider-auth-runtime';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROVIDER_ID = 'uclaw-video';
const DEFAULT_MODEL = 'grok-image-video';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_RESOLUTION = '480P';
const DEFAULT_DURATION_SECONDS = 6;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MIME_TYPE = 'video/mp4';
const RESOLUTION_SIZES = {
  '480P': '854x480',
  '720P': '1280x720',
};
const DEFAULT_MODELS = [
  {
    id: 'grok-image-video',
    modes: ['text-to-video', 'image-to-video'],
    resolutions: ['480P', '720P'],
    durations: [6, 10, 15],
    defaultResolution: '480P',
    defaultDurationSeconds: 6,
    requiresImage: false,
  },
  {
    id: 'grok-video-1.5',
    modes: ['image-to-video'],
    resolutions: ['480P', '720P'],
    durations: [6, 10, 15],
    defaultResolution: '480P',
    defaultDurationSeconds: 6,
    requiresImage: true,
  },
];
const COMPLETE_STATUSES = new Set(['completed', 'succeeded', 'success', 'done']);
const FAILED_STATUSES = new Set(['failed', 'cancelled', 'canceled', 'error']);
const TURN_PREFERENCES_DIRECTORY = 'uclaw-turn-preferences';
const TURN_PREFERENCE_TTL_MS = 5 * 60 * 1000;
const TURN_PREFERENCE_CACHE_MAX_ENTRIES = 64;
const TURN_PREFERENCE_FILE_RE = /^video-turn-([0-9a-f-]{36})\.json$/iu;
const VIDEO_MODE_PROMPT_CONTEXT = [
  'The user selected video generation mode for this turn.',
  'When the request asks for a video, call video_generate instead of only describing a video.',
  'Use the managed model, resolution, and duration supplied to the tool call.',
].join(' ');
const turnPreferencesByRun = new Map();

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : fallback;
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/u, '');
}

function normalizeBaseUrl(value) {
  const normalized = trimTrailingSlash(value || DEFAULT_BASE_URL);
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

function normalizeModelConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = normalizeOptionalString(value.id);
  const resolutions = Array.isArray(value.resolutions)
    ? [...new Set(value.resolutions.filter((entry) => entry === '480P' || entry === '720P'))]
    : [];
  const durations = Array.isArray(value.durations)
    ? [...new Set(value.durations
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry) && entry > 0)
      .map((entry) => Math.round(entry)))]
    : [];
  if (!id || resolutions.length === 0 || durations.length === 0) return undefined;

  const modes = Array.isArray(value.modes)
    ? [...new Set(value.modes.filter((entry) => entry === 'text-to-video' || entry === 'image-to-video'))]
    : [];
  const defaultResolution = resolutions.includes(value.defaultResolution)
    ? value.defaultResolution
    : resolutions[0];
  const configuredDuration = normalizePositiveInteger(value.defaultDurationSeconds, durations[0]);
  const defaultDurationSeconds = durations.includes(configuredDuration) ? configuredDuration : durations[0];
  return {
    id,
    modes,
    resolutions,
    durations,
    defaultResolution,
    defaultDurationSeconds,
    requiresImage: value.requiresImage === true,
  };
}

/** Reads the managed plugin configuration while preserving standalone defaults. */
function resolvePluginConfig(value) {
  const configuredModels = Array.isArray(value?.models)
    ? value.models.map(normalizeModelConfig).filter(Boolean)
    : [];
  const models = configuredModels.length > 0 ? configuredModels : DEFAULT_MODELS;
  const configuredDefaultModel = normalizeOptionalString(value?.defaultModel);
  const defaultModel = models.some((model) => model.id === configuredDefaultModel)
    ? configuredDefaultModel
    : DEFAULT_MODEL;
  const defaultModelConfig = models.find((model) => model.id === defaultModel) ?? models[0];
  const configuredDefaultResolution = normalizeOptionalString(value?.defaultResolution);
  const defaultResolution = defaultModelConfig.resolutions.includes(configuredDefaultResolution)
    ? configuredDefaultResolution
    : defaultModelConfig.defaultResolution;
  const configuredDefaultDuration = normalizePositiveInteger(
    value?.defaultDurationSeconds,
    defaultModelConfig.defaultDurationSeconds,
  );
  const defaultDurationSeconds = defaultModelConfig.durations.includes(configuredDefaultDuration)
    ? configuredDefaultDuration
    : defaultModelConfig.defaultDurationSeconds;
  const resolutionSizes = {
    ...RESOLUTION_SIZES,
    ...(value?.resolutionSizes && typeof value.resolutionSizes === 'object'
      ? value.resolutionSizes
      : {}),
  };

  return {
    models,
    defaultModel,
    defaultResolution,
    defaultDurationSeconds,
    resolutionSizes,
    pollIntervalMs: normalizePositiveInteger(value?.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
    timeoutMs: normalizePositiveInteger(value?.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxDownloadBytes: normalizePositiveInteger(value?.maxDownloadBytes, DEFAULT_MAX_DOWNLOAD_BYTES),
  };
}

function resolveProviderConfig(req) {
  return req.cfg?.models?.providers?.[PROVIDER_ID] ?? {};
}

async function resolveApiKey(req) {
  const auth = await resolveApiKeyForProvider({
    provider: PROVIDER_ID,
    cfg: req.cfg,
    agentDir: req.agentDir,
    store: req.authStore,
  });
  const apiKey = String(auth.apiKey || req.apiKey || '').trim();
  if (!apiKey) throw new Error('UClaw video API key missing');
  return apiKey;
}

function isConfigured({ cfg, agentDir }) {
  const configuredApiKey = cfg?.models?.providers?.[PROVIDER_ID]?.apiKey;
  if (typeof configuredApiKey === 'string' && configuredApiKey.trim()) return true;
  return isProviderApiKeyConfigured({ provider: PROVIDER_ID, agentDir });
}

function nestedPayloadRecords(value) {
  const records = [];
  const queue = [value];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || Array.isArray(current) || seen.has(current)) continue;
    seen.add(current);
    records.push(current);
    if (current.data && typeof current.data === 'object' && !Array.isArray(current.data)) {
      queue.push(current.data);
    }
  }
  return records;
}

function extractTaskId(payload) {
  const records = nestedPayloadRecords(payload);
  for (const key of ['task_id', 'taskId', 'id']) {
    for (const record of records) {
      const value = normalizeOptionalString(record[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function extractStatus(payload) {
  for (const record of nestedPayloadRecords(payload)) {
    const status = normalizeOptionalString(record.status);
    if (status) return status;
  }
  return undefined;
}

function firstOutputUrl(value) {
  if (typeof value === 'string') return normalizeOptionalString(value);
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const direct = normalizeOptionalString(item);
    if (direct) return direct;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const nested = normalizeOptionalString(item.url) ?? normalizeOptionalString(item.result_url);
      if (nested) return nested;
    }
  }
  return undefined;
}

function extractVideoUrl(payload) {
  for (const record of nestedPayloadRecords(payload)) {
    const videoUrl = record.video && typeof record.video === 'object' && !Array.isArray(record.video)
      ? normalizeOptionalString(record.video.url)
      : undefined;
    const url = normalizeOptionalString(record.result_url)
      ?? normalizeOptionalString(record.video_url)
      ?? normalizeOptionalString(record.url)
      ?? videoUrl
      ?? firstOutputUrl(record.output);
    if (url) return url;
  }
  return undefined;
}

function extractFailureMessage(payload) {
  const status = extractStatus(payload)?.toLowerCase();
  if (!status || !FAILED_STATUSES.has(status)) return undefined;
  for (const record of nestedPayloadRecords(payload)) {
    const error = record.error;
    const message = normalizeOptionalString(error)
      ?? (error && typeof error === 'object' && !Array.isArray(error)
        ? normalizeOptionalString(error.message)
        : undefined)
      ?? normalizeOptionalString(record.message)
      ?? normalizeOptionalString(record.fail_reason);
    if (message) return message;
  }
  return `Video generation failed with status "${status}"`;
}

function isComplete(payload) {
  const status = extractStatus(payload)?.toLowerCase();
  return Boolean(extractVideoUrl(payload)) || Boolean(status && COMPLETE_STATUSES.has(status));
}

function readResponseError(payload, fallback) {
  for (const record of nestedPayloadRecords(payload)) {
    const error = record.error;
    const message = normalizeOptionalString(error)
      ?? (error && typeof error === 'object' && !Array.isArray(error)
        ? normalizeOptionalString(error.message)
        : undefined)
      ?? normalizeOptionalString(record.message)
      ?? normalizeOptionalString(record.fail_reason);
    if (message) return message;
  }
  return fallback;
}

function remainingTimeout(deadline) {
  return Math.max(1, deadline - Date.now());
}

/** Performs one authenticated JSON request within the shared generation deadline. */
async function fetchJson(url, init, deadline, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingTimeout(deadline));
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      if (response.ok) throw new Error(`${label} returned invalid JSON`);
    }
    if (!response.ok) {
      throw new Error(readResponseError(payload, `${label} failed with HTTP ${response.status}`));
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${label} timed out`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls the OpenAI-compatible task endpoint until a terminal response arrives. */
async function pollVideoTask({ baseUrl, apiKey, taskId, deadline, pollIntervalMs }) {
  let lastStatus;
  while (Date.now() < deadline) {
    const payload = await fetchJson(
      `${baseUrl}/videos/${encodeURIComponent(taskId)}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      },
      deadline,
      'Video status request',
    );
    const failureMessage = extractFailureMessage(payload);
    if (failureMessage) throw new Error(failureMessage);
    if (isComplete(payload)) return payload;
    lastStatus = extractStatus(payload);
    await sleep(Math.min(pollIntervalMs, remainingTimeout(deadline)));
  }
  throw new Error(lastStatus
    ? `Video generation task ${taskId} did not finish in time; last status was "${lastStatus}"`
    : `Video generation task ${taskId} did not finish in time`);
}

/** Downloads a provider result that is available only through the authenticated content route. */
async function downloadVideoContent({ baseUrl, apiKey, taskId, deadline, maxDownloadBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingTimeout(deadline));
  try {
    const response = await fetch(`${baseUrl}/videos/${encodeURIComponent(taskId)}/content`, {
      method: 'GET',
      headers: { Accept: 'video/*,application/octet-stream', Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Video content download failed with HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxDownloadBytes) {
      throw new Error(`Generated video exceeds ${maxDownloadBytes} bytes`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxDownloadBytes) {
      throw new Error(`Generated video exceeds ${maxDownloadBytes} bytes`);
    }
    return {
      buffer,
      mimeType: normalizeOptionalString(response.headers.get('content-type')) ?? DEFAULT_MIME_TYPE,
      fileName: `${taskId}.mp4`,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Video content download timed out', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function inputImageValue(asset) {
  const url = normalizeOptionalString(asset?.url);
  if (url) return url;
  if (!asset?.buffer) return undefined;
  const mimeType = normalizeOptionalString(asset.mimeType) ?? 'image/png';
  return `data:${mimeType};base64,${Buffer.from(asset.buffer).toString('base64')}`;
}

function resolveModelRequest(req, config) {
  const requestedModel = normalizeOptionalString(req.model) ?? config.defaultModel;
  const model = config.models.find((entry) => entry.id === requestedModel);
  if (!model) throw new Error(`Unsupported UClaw video model: ${requestedModel}`);

  const inputImages = Array.isArray(req.inputImages) ? req.inputImages : [];
  if (model.requiresImage && inputImages.length !== 1) {
    throw new Error(`${model.id} requires exactly one reference image`);
  }
  if (inputImages.length > 1) {
    throw new Error(`${model.id} supports at most one reference image`);
  }
  if (inputImages.length > 0 && !model.modes.includes('image-to-video')) {
    throw new Error(`${model.id} does not support image-to-video generation`);
  }
  if (inputImages.length === 0 && !model.modes.includes('text-to-video')) {
    throw new Error(`${model.id} requires exactly one reference image`);
  }

  const requestedResolution = normalizeOptionalString(req.resolution)
    ?? (Object.values(config.resolutionSizes).includes(req.size) ? Object.entries(config.resolutionSizes)
      .find(([, size]) => size === req.size)?.[0] : undefined)
    ?? model.defaultResolution
    ?? config.defaultResolution;
  if (!model.resolutions.includes(requestedResolution)) {
    throw new Error(`${model.id} does not support ${requestedResolution} resolution`);
  }
  const requestedDuration = normalizePositiveInteger(
    req.durationSeconds,
    model.defaultDurationSeconds ?? config.defaultDurationSeconds,
  );
  if (!model.durations.includes(requestedDuration)) {
    throw new Error(`${model.id} does not support ${requestedDuration} second videos`);
  }

  const image = inputImages.length === 1 ? inputImageValue(inputImages[0]) : undefined;
  if (inputImages.length === 1 && !image) {
    throw new Error(`${model.id} reference image is missing data`);
  }
  return {
    model,
    resolution: requestedResolution,
    size: config.resolutionSizes[requestedResolution],
    durationSeconds: requestedDuration,
    image,
  };
}

function modeCapabilities(model, config) {
  const shared = {
    maxVideos: 1,
    maxDurationSeconds: Math.max(...model.durations),
    supportedDurationSeconds: model.durations,
    supportsSize: true,
    sizes: model.resolutions.map((resolution) => config.resolutionSizes[resolution]),
    supportsResolution: true,
    resolutions: model.resolutions,
  };
  return {
    ...(model.modes.includes('text-to-video') ? { generate: shared } : {}),
    ...(model.modes.includes('image-to-video')
      ? { imageToVideo: { ...shared, enabled: true, maxInputImages: 1 } }
      : {}),
  };
}

/** Builds the provider registered against OpenClaw's native video_generate tool. */
function buildProvider(config) {
  const defaultModel = config.models.find((model) => model.id === config.defaultModel) ?? config.models[0];
  return {
    id: PROVIDER_ID,
    label: 'UClaw Video',
    defaultModel: defaultModel.id,
    defaultTimeoutMs: config.timeoutMs,
    models: config.models.map((model) => model.id),
    capabilities: modeCapabilities(defaultModel, config),
    isConfigured,
    resolveModelCapabilities({ model }) {
      const configuredModel = config.models.find((entry) => entry.id === model);
      return configuredModel ? modeCapabilities(configuredModel, config) : undefined;
    },
    async generateVideo(req) {
      const providerConfig = resolveProviderConfig(req);
      const baseUrl = normalizeBaseUrl(providerConfig.baseUrl);
      const request = resolveModelRequest(req, config);
      const apiKey = await resolveApiKey(req);
      const deadline = Date.now() + normalizePositiveInteger(req.timeoutMs, config.timeoutMs);

      // Submit one OpenAI-compatible task, then follow the provider-owned task id.
      const body = {
        model: request.model.id,
        prompt: req.prompt,
        seconds: String(request.durationSeconds),
        size: request.size,
        ...(request.image ? { image: request.image } : {}),
      };
      const submitted = await fetchJson(
        `${baseUrl}/videos`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
        deadline,
        'Video generation request',
      );
      const failureMessage = extractFailureMessage(submitted);
      if (failureMessage) throw new Error(failureMessage);
      const taskId = extractTaskId(submitted);
      if (!taskId) throw new Error('Video generation response missing task id');
      const completed = isComplete(submitted)
        ? submitted
        : await pollVideoTask({
          baseUrl,
          apiKey,
          taskId,
          deadline,
          pollIntervalMs: config.pollIntervalMs,
        });
      const resultUrl = extractVideoUrl(completed);
      const metadata = {
        taskId,
        status: extractStatus(completed),
        resolution: request.resolution,
        size: request.size,
        durationSeconds: request.durationSeconds,
      };
      const video = resultUrl
        ? { url: resultUrl, mimeType: DEFAULT_MIME_TYPE, fileName: `${taskId}.mp4`, metadata }
        : {
          ...await downloadVideoContent({
            baseUrl,
            apiKey,
            taskId,
            deadline,
            maxDownloadBytes: config.maxDownloadBytes,
          }),
          metadata,
        };
      return { videos: [video], model: request.model.id, metadata };
    },
  };
}

function preferenceDirectory() {
  const stateDirectory = normalizeOptionalString(process.env.OPENCLAW_STATE_DIR) || join(homedir(), '.openclaw');
  return join(stateDirectory, TURN_PREFERENCES_DIRECTORY);
}

function digestPrompt(prompt) {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

function normalizeTurnOptions(value, config) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const model = config.models.find((entry) => entry.id === value.model);
  if (!model || !model.resolutions.includes(value.resolution) || !model.durations.includes(value.durationSeconds)) {
    return undefined;
  }
  return {
    model: model.id,
    resolution: value.resolution,
    durationSeconds: value.durationSeconds,
  };
}

function turnCacheKey(event, ctx) {
  return normalizeOptionalString(event?.runId)
    || normalizeOptionalString(ctx?.runId)
    || normalizeOptionalString(event?.sessionKey)
    || normalizeOptionalString(ctx?.sessionKey);
}

function prunePreferenceCache(now = Date.now()) {
  for (const [key, entry] of turnPreferencesByRun) {
    if (entry.expiresAt <= now) turnPreferencesByRun.delete(key);
  }
  while (turnPreferencesByRun.size > TURN_PREFERENCE_CACHE_MAX_ENTRIES) {
    const oldestKey = turnPreferencesByRun.keys().next().value;
    if (!oldestKey) return;
    turnPreferencesByRun.delete(oldestKey);
  }
}

function cacheTurnOptions(event, ctx, videoOptions) {
  const key = turnCacheKey(event, ctx);
  if (!key || !videoOptions) return;
  const now = Date.now();
  prunePreferenceCache(now);
  turnPreferencesByRun.set(key, { videoOptions, expiresAt: now + TURN_PREFERENCE_TTL_MS });
}

function getTurnOptions(event, ctx) {
  prunePreferenceCache();
  const key = turnCacheKey(event, ctx);
  return key ? turnPreferencesByRun.get(key)?.videoOptions : undefined;
}

/** Atomically claims one ACP composer's preference without retaining its prompt. */
async function consumeTurnOptions(event, ctx, config) {
  const sessionKey = normalizeOptionalString(event?.sessionKey) || normalizeOptionalString(ctx?.sessionKey);
  const prompt = normalizeOptionalString(event?.prompt);
  if (!sessionKey || !prompt) return undefined;

  const directory = preferenceDirectory();
  let fileNames;
  try {
    fileNames = await readdir(directory);
  } catch {
    return undefined;
  }
  const now = Date.now();
  const messageDigest = digestPrompt(prompt);
  const matches = [];
  for (const fileName of fileNames) {
    if (!TURN_PREFERENCE_FILE_RE.test(fileName)) continue;
    const filePath = join(directory, fileName);
    try {
      const record = JSON.parse(await readFile(filePath, 'utf8'));
      const videoOptions = normalizeTurnOptions(record?.videoOptions, config);
      const expiresAt = Number(record?.expiresAt);
      if (!videoOptions || !Number.isFinite(expiresAt) || expiresAt <= now) {
        await rm(filePath, { force: true });
        continue;
      }
      if (record.sessionKey !== sessionKey || record.messageDigest !== messageDigest) continue;
      matches.push({ filePath, createdAt: Number(record.createdAt) || 0, videoOptions });
    } catch {
      await rm(filePath, { force: true }).catch(() => undefined);
    }
  }

  matches.sort((left, right) => left.createdAt - right.createdAt);
  for (const match of matches) {
    const claimedPath = `${match.filePath}.${process.pid}.${randomUUID()}.claimed`;
    try {
      await rename(match.filePath, claimedPath);
    } catch {
      continue;
    }
    await rm(claimedPath, { force: true }).catch(() => undefined);
    return match.videoOptions;
  }
  return undefined;
}

function registerLifecycleHook(api, name, handler, options) {
  if (typeof api.on === 'function') {
    api.on(name, handler, options);
    return;
  }
  if (typeof api.registerHook === 'function') api.registerHook(name, handler, options);
}

/** Keeps model-owned tool selection while applying this turn's composer constraints. */
function registerTurnPreferenceHooks(api, config) {
  registerLifecycleHook(api, 'before_prompt_build', async (event, ctx) => {
    const videoOptions = await consumeTurnOptions(event, ctx, config);
    if (!videoOptions) return undefined;
    cacheTurnOptions(event, ctx, videoOptions);
    return { appendContext: VIDEO_MODE_PROMPT_CONTEXT };
  }, {
    name: `${PROVIDER_ID}:turn-video-preferences`,
    description: 'Consume one composer video preference and retain it for a model-selected video tool call.',
    timeoutMs: 1000,
  });

  registerLifecycleHook(api, 'before_tool_call', (event, ctx) => {
    const toolName = normalizeOptionalString(event?.toolName)?.split(':').at(-1)?.toLowerCase();
    if (toolName !== 'video_generate') return undefined;
    const videoOptions = getTurnOptions(event, ctx);
    if (!videoOptions) return undefined;
    return {
      params: {
        ...(event?.params ?? {}),
        model: `${PROVIDER_ID}/${videoOptions.model}`,
        resolution: videoOptions.resolution,
        durationSeconds: videoOptions.durationSeconds,
      },
    };
  }, {
    name: `${PROVIDER_ID}:turn-video-options`,
    description: 'Apply composer model, resolution, and duration to a model-selected video_generate call.',
    priority: 100,
  });
}

export const pluginEntry = definePluginEntry({
  id: PROVIDER_ID,
  name: 'UClaw Video',
  description: 'OpenAI-compatible video generation provider managed by UClaw.',
  register(api) {
    const config = resolvePluginConfig(api.pluginConfig);
    api.registerVideoGenerationProvider(buildProvider(config));
    registerTurnPreferenceHooks(api, config);
  },
});

export default pluginEntry;
