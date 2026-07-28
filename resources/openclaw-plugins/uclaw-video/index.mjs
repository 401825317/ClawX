import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { isProviderApiKeyConfigured } from 'openclaw/plugin-sdk/provider-auth';
import { resolveApiKeyForProvider } from 'openclaw/plugin-sdk/provider-auth-runtime';
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const PROVIDER_ID = 'uclaw-video';
const TEXT_TO_VIDEO_MODEL = 'grok-image-video';
const IMAGE_TO_VIDEO_MODEL = 'grok-video-1.5';
const DEFAULT_MODEL = TEXT_TO_VIDEO_MODEL;
const DEFAULT_ASPECT_RATIO = '16:9';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_RESOLUTION = '480P';
const DEFAULT_DURATION_SECONDS = 6;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_CONTENT_DOWNLOAD_MAX_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_INPUT_IMAGE_BYTES = 1024 * 1024;
const DEFAULT_MIME_TYPE = 'video/mp4';
const RESOLUTION_SIZES = {
  '480P': '854x480',
  '720P': '1280x720',
};
const SUPPORTED_ASPECT_RATIOS = new Set(['2:3', '3:2', '1:1', '9:16', '16:9']);
const DEFAULT_MODELS = [
  {
    id: 'grok-image-video',
    modes: ['text-to-video'],
    aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
    resolutions: ['480P', '720P'],
    durations: [6, 10, 15],
    defaultAspectRatio: DEFAULT_ASPECT_RATIO,
    defaultResolution: '480P',
    defaultDurationSeconds: 6,
    requiresImage: false,
  },
  {
    id: 'grok-video-1.5',
    modes: ['image-to-video'],
    aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
    resolutions: ['480P', '720P'],
    durations: [6, 10, 15],
    defaultAspectRatio: DEFAULT_ASPECT_RATIO,
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
  'Use the managed aspect ratio, resolution, and duration supplied to the tool call.',
  'The runtime selects the video model and binds the current turn reference image automatically.',
  'Do not invent a reference-image file path.',
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
  const aspectRatios = Array.isArray(value.aspectRatios)
    ? [...new Set(value.aspectRatios.filter((entry) => SUPPORTED_ASPECT_RATIOS.has(entry)))]
    : [];
  const resolutions = Array.isArray(value.resolutions)
    ? [...new Set(value.resolutions.filter((entry) => entry === '480P' || entry === '720P'))]
    : [];
  const durations = Array.isArray(value.durations)
    ? [...new Set(value.durations
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry) && entry > 0)
      .map((entry) => Math.round(entry)))]
    : [];
  if (!id || aspectRatios.length === 0 || resolutions.length === 0 || durations.length === 0) return undefined;

  const modes = Array.isArray(value.modes)
    ? [...new Set(value.modes.filter((entry) => entry === 'text-to-video' || entry === 'image-to-video'))]
    : [];
  const defaultAspectRatio = aspectRatios.includes(value.defaultAspectRatio)
    ? value.defaultAspectRatio
    : aspectRatios[0];
  const defaultResolution = resolutions.includes(value.defaultResolution)
    ? value.defaultResolution
    : resolutions[0];
  const configuredDuration = normalizePositiveInteger(value.defaultDurationSeconds, durations[0]);
  const defaultDurationSeconds = durations.includes(configuredDuration) ? configuredDuration : durations[0];
  return {
    id,
    modes,
    aspectRatios,
    resolutions,
    durations,
    defaultAspectRatio,
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
    : (models.find((model) => model.id === DEFAULT_MODEL)?.id ?? models[0].id);
  const defaultModelConfig = models.find((model) => model.id === defaultModel) ?? models[0];
  const configuredDefaultAspectRatio = normalizeOptionalString(value?.defaultAspectRatio);
  const defaultAspectRatio = defaultModelConfig.aspectRatios.includes(configuredDefaultAspectRatio)
    ? configuredDefaultAspectRatio
    : defaultModelConfig.defaultAspectRatio;
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
    defaultAspectRatio,
    defaultResolution,
    defaultDurationSeconds,
    resolutionSizes,
    pollIntervalMs: normalizePositiveInteger(value?.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
    contentDownloadMaxAttempts: normalizePositiveInteger(
      value?.contentDownloadMaxAttempts,
      DEFAULT_CONTENT_DOWNLOAD_MAX_ATTEMPTS,
    ),
    timeoutMs: normalizePositiveInteger(value?.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxDownloadBytes: normalizePositiveInteger(value?.maxDownloadBytes, DEFAULT_MAX_DOWNLOAD_BYTES),
    maxInputImageBytes: normalizePositiveInteger(value?.maxInputImageBytes, DEFAULT_MAX_INPUT_IMAGE_BYTES),
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
  if (status) return COMPLETE_STATUSES.has(status);
  return Boolean(extractVideoUrl(payload));
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

class IncompleteVideoContentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IncompleteVideoContentError';
  }
}

class GeneratedVideoTooLargeError extends Error {
  constructor(maxDownloadBytes) {
    super(`Generated video exceeds ${maxDownloadBytes} bytes`);
    this.name = 'GeneratedVideoTooLargeError';
  }
}

/** Reads a response incrementally so an absent Content-Length cannot bypass the managed limit. */
async function readResponseBuffer(response, maxDownloadBytes, expectedBytes) {
  if (!response.body) throw new IncompleteVideoContentError('Video content response has no body');
  const reader = response.body.getReader();
  const target = Number.isSafeInteger(expectedBytes) ? Buffer.allocUnsafe(expectedBytes) : undefined;
  const chunks = target ? undefined : [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const nextTotalBytes = totalBytes + value.byteLength;
      if (nextTotalBytes > maxDownloadBytes) {
        await reader.cancel().catch(() => undefined);
        throw new GeneratedVideoTooLargeError(maxDownloadBytes);
      }
      if (target && nextTotalBytes > target.length) {
        await reader.cancel().catch(() => undefined);
        throw new IncompleteVideoContentError(
          `Video content declared ${target.length} bytes but returned more data`,
        );
      }
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (target) chunk.copy(target, totalBytes);
      else chunks.push(chunk);
      totalBytes = nextTotalBytes;
    }
  } catch (error) {
    if (
      error instanceof GeneratedVideoTooLargeError
      || error instanceof IncompleteVideoContentError
      || (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error;
    }
    throw new IncompleteVideoContentError('Video content response ended before the body was complete');
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) throw new IncompleteVideoContentError('Video content response is empty');
  if (target && totalBytes !== target.length) {
    throw new IncompleteVideoContentError(
      `Video content declared ${target.length} bytes but returned ${totalBytes}`,
    );
  }
  return target ?? Buffer.concat(chunks, totalBytes);
}

/** Validates enough of ISO-BMFF to reject a file whose declared top-level box is truncated. */
function assertCompleteMp4(buffer) {
  const requiredBoxes = new Set(['ftyp', 'moov', 'mdat']);
  let offset = 0;
  while (offset < buffer.length) {
    const remainingBytes = buffer.length - offset;
    if (remainingBytes < 8) {
      throw new IncompleteVideoContentError(`MP4 has ${remainingBytes} trailing bytes without a box header`);
    }

    const compactSize = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    let boxSize;
    if (compactSize === 1) {
      if (remainingBytes < 16) {
        throw new IncompleteVideoContentError(`MP4 ${type} box has an incomplete extended-size header`);
      }
      headerSize = 16;
      const extendedSize = buffer.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new IncompleteVideoContentError(`MP4 ${type} box declares an unsupported size`);
      }
      boxSize = Number(extendedSize);
    } else {
      boxSize = compactSize === 0 ? remainingBytes : compactSize;
    }

    if (boxSize < headerSize) {
      throw new IncompleteVideoContentError(`MP4 ${type} box is smaller than its header`);
    }
    const boxEnd = offset + boxSize;
    if (boxEnd > buffer.length) {
      throw new IncompleteVideoContentError(
        `MP4 ${type} box declares ${boxSize} bytes but only ${remainingBytes} remain`,
      );
    }
    const payloadBytes = boxSize - headerSize;
    if ((type === 'moov' || type === 'mdat') && payloadBytes === 0) {
      throw new IncompleteVideoContentError(`MP4 ${type} box has no payload`);
    }
    if (type === 'ftyp' && payloadBytes < 8) {
      throw new IncompleteVideoContentError('MP4 ftyp box is missing its brand payload');
    }
    requiredBoxes.delete(type);
    offset = boxEnd;
  }

  if (requiredBoxes.size > 0) {
    throw new IncompleteVideoContentError(
      `MP4 is missing required top-level box${requiredBoxes.size === 1 ? '' : 'es'}: ${[...requiredBoxes].join(', ')}`,
    );
  }
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

/** Performs one authenticated download and accepts only a structurally complete MP4. */
async function downloadVideoContentAttempt({ baseUrl, apiKey, taskId, deadline, maxDownloadBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingTimeout(deadline));
  try {
    const response = await fetch(`${baseUrl}/videos/${encodeURIComponent(taskId)}/content`, {
      method: 'GET',
      headers: {
        Accept: 'video/*,application/octet-stream',
        'Accept-Encoding': 'identity',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Video content download failed with HTTP ${response.status}`);
    }
    const contentLengthHeader = normalizeOptionalString(response.headers.get('content-length'));
    const contentLength = contentLengthHeader && /^\d+$/u.test(contentLengthHeader)
      ? Number(contentLengthHeader)
      : undefined;
    if (Number.isSafeInteger(contentLength) && contentLength > maxDownloadBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new GeneratedVideoTooLargeError(maxDownloadBytes);
    }
    const contentEncoding = normalizeOptionalString(response.headers.get('content-encoding'))?.toLowerCase();
    const expectedBytes = Number.isSafeInteger(contentLength)
      && (!contentEncoding || contentEncoding === 'identity')
      ? contentLength
      : undefined;
    const buffer = await readResponseBuffer(response, maxDownloadBytes, expectedBytes);
    assertCompleteMp4(buffer);
    return {
      buffer,
      mimeType: normalizeOptionalString(response.headers.get('content-type'))?.split(';', 1)[0]
        ?? DEFAULT_MIME_TYPE,
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

/** Retries only a completed task whose content object has not finished materializing. */
async function downloadVideoContent({
  baseUrl,
  apiKey,
  taskId,
  deadline,
  maxDownloadBytes,
  pollIntervalMs,
  contentDownloadMaxAttempts,
}) {
  let attempts = 0;
  let lastError;
  while (attempts < contentDownloadMaxAttempts && Date.now() < deadline) {
    attempts += 1;
    try {
      return await downloadVideoContentAttempt({ baseUrl, apiKey, taskId, deadline, maxDownloadBytes });
    } catch (error) {
      if (!(error instanceof IncompleteVideoContentError)) throw error;
      lastError = error;
    }
    if (attempts >= contentDownloadMaxAttempts) break;
    const delayMs = Math.min(pollIntervalMs, remainingTimeout(deadline));
    if (Date.now() + delayMs >= deadline) break;
    await sleep(delayMs);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(
    `Video content remained incomplete after ${attempts} download attempt${attempts === 1 ? '' : 's'}${detail}`,
    { cause: lastError },
  );
}

function inputImageValue(asset) {
  const url = normalizeOptionalString(asset?.url);
  if (url) return url;
  if (!asset?.buffer) return undefined;
  const mimeType = normalizeOptionalString(asset.mimeType) ?? 'image/png';
  return `data:${mimeType};base64,${Buffer.from(asset.buffer).toString('base64')}`;
}

/** Derive the OpenAI-compatible size fallback without contradicting the selected ratio. */
function sizeForAspectRatio(resolution, aspectRatio, resolutionSizes) {
  const fallback = resolutionSizes[resolution] ?? RESOLUTION_SIZES[resolution];
  const [fallbackWidth, fallbackHeight] = String(fallback).split('x').map(Number);
  const base = Math.min(fallbackWidth, fallbackHeight);
  const [widthRatio, heightRatio] = aspectRatio.split(':').map(Number);
  if (!Number.isFinite(base) || !Number.isFinite(widthRatio) || !Number.isFinite(heightRatio)) {
    return fallback;
  }
  if (widthRatio >= heightRatio) {
    return `${Math.ceil((base * widthRatio) / heightRatio)}x${base}`;
  }
  return `${base}x${Math.ceil((base * heightRatio) / widthRatio)}`;
}

function aspectRatioForSize(size, resolutionSizes) {
  const [width, height] = String(size ?? '').split('x').map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  for (const resolution of Object.keys(resolutionSizes)) {
    for (const aspectRatio of SUPPORTED_ASPECT_RATIOS) {
      if (sizeForAspectRatio(resolution, aspectRatio, resolutionSizes) === `${width}x${height}`) {
        return { aspectRatio, resolution };
      }
    }
  }
  return undefined;
}

function normalizeToolReferenceImages(params) {
  const inputs = [];
  const add = (value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const input = value.trim();
    const dedupe = input.startsWith('@') ? input.slice(1).trim() : input;
    if (!dedupe || inputs.some((entry) => entry.dedupe === dedupe)) return;
    inputs.push({ input, dedupe });
  };
  add(params?.image);
  if (Array.isArray(params?.images)) {
    for (const image of params.images) add(image);
  }
  return inputs;
}

/** Routes strictly from the normalized reference-image count, never from a user-facing model setting. */
function automaticModelForInputImages(config, inputImageCount) {
  if (inputImageCount > 1) {
    throw new Error('UClaw video generation supports at most one reference image');
  }
  const requiredMode = inputImageCount === 1 ? 'image-to-video' : 'text-to-video';
  const requiredModelId = inputImageCount === 1 ? IMAGE_TO_VIDEO_MODEL : TEXT_TO_VIDEO_MODEL;
  const model = config.models.find((entry) => (
    entry.id === requiredModelId && entry.modes.includes(requiredMode)
  ));
  if (!model) {
    throw new Error(`Managed video policy is missing ${requiredModelId} for ${requiredMode}`);
  }
  return model;
}

function applyOptionsForModel(videoOptions, model) {
  if (!videoOptions) return undefined;
  return {
    aspectRatio: model.aspectRatios.includes(videoOptions.aspectRatio)
      ? videoOptions.aspectRatio
      : model.defaultAspectRatio,
    resolution: model.resolutions.includes(videoOptions.resolution)
      ? videoOptions.resolution
      : model.defaultResolution,
    durationSeconds: model.durations.includes(videoOptions.durationSeconds)
      ? videoOptions.durationSeconds
      : model.defaultDurationSeconds,
  };
}

function inputImageByteLength(asset) {
  if (!asset?.buffer) return undefined;
  return Buffer.from(asset.buffer).byteLength;
}

function referenceImageLimitLabel(maxBytes) {
  return `${maxBytes} ${maxBytes === 1 ? 'byte' : 'bytes'}`;
}

function resolveModelRequest(req, config) {
  const inputImages = Array.isArray(req.inputImages) ? req.inputImages : [];
  const model = automaticModelForInputImages(config, inputImages.length);
  const inputBytes = inputImages.length === 1 ? inputImageByteLength(inputImages[0]) : undefined;
  if (inputBytes !== undefined && inputBytes > config.maxInputImageBytes) {
    throw new Error(
      `Reference image exceeds the ${referenceImageLimitLabel(config.maxInputImageBytes)} reference-image limit after client compression`,
    );
  }

  const requestedSize = aspectRatioForSize(req.size, config.resolutionSizes);
  const requestedAspectRatio = normalizeOptionalString(req.aspectRatio)
    ?? requestedSize?.aspectRatio
    ?? model.defaultAspectRatio
    ?? config.defaultAspectRatio;
  if (!model.aspectRatios.includes(requestedAspectRatio)) {
    throw new Error(`${model.id} does not support ${requestedAspectRatio} aspect ratio`);
  }
  const requestedResolution = normalizeOptionalString(req.resolution)
    ?? requestedSize?.resolution
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
    aspectRatio: requestedAspectRatio,
    resolution: requestedResolution,
    size: sizeForAspectRatio(requestedResolution, requestedAspectRatio, config.resolutionSizes),
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
    sizes: model.resolutions.flatMap((resolution) => (
      model.aspectRatios.map((aspectRatio) => sizeForAspectRatio(resolution, aspectRatio, config.resolutionSizes))
    )),
    supportsAspectRatio: true,
    aspectRatios: model.aspectRatios,
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

/** Exposes every configured mode for OpenClaw's provider-level input preflight. */
function providerCapabilities(config) {
  return config.models.reduce((capabilities, model) => ({
    ...capabilities,
    ...modeCapabilities(model, config),
  }), {});
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
    capabilities: providerCapabilities(config),
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
        aspect_ratio: request.aspectRatio,
        resolution: request.resolution.toLowerCase(),
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
        aspectRatio: request.aspectRatio,
        resolution: request.resolution,
        size: request.size,
        durationSeconds: request.durationSeconds,
      };
      // Always materialize the completed asset. OpenClaw persists provider buffers
      // in its managed media store and keeps resultUrl only as an oversize fallback.
      const video = {
        ...await downloadVideoContent({
          baseUrl,
          apiKey,
          taskId,
          deadline,
          maxDownloadBytes: config.maxDownloadBytes,
          pollIntervalMs: config.pollIntervalMs,
          contentDownloadMaxAttempts: config.contentDownloadMaxAttempts,
        }),
        ...(resultUrl ? { url: resultUrl } : {}),
        metadata,
      };
      return { videos: [video], model: request.model.id, metadata };
    },
  };
}

function preferenceDirectory() {
  return join(resolveStateDir(), 'media', TURN_PREFERENCES_DIRECTORY);
}

function digestPrompt(prompt) {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

/** Matches composer text inside OpenClaw metadata and ACP attachment descriptions. */
function matchesStoredPrompt(prompt, record) {
  const storedDigest = normalizeOptionalString(record?.messageDigest);
  if (!storedDigest) return false;
  if (digestPrompt(prompt) === storedDigest) return true;
  const messageLength = Number(record?.messageLength);
  if (!Number.isSafeInteger(messageLength) || messageLength <= 0 || messageLength > prompt.length) {
    return false;
  }
  if (digestPrompt(prompt.slice(-messageLength)) === storedDigest) return true;

  // ACP appends attachment descriptions after the original user text.
  for (const separator of prompt.matchAll(/\r?\n/g)) {
    const end = separator.index;
    const start = end - messageLength;
    if (start < 0) continue;
    if (start > 0 && prompt[start - 1] !== '\n' && prompt[start - 1] !== '\r') continue;
    if (digestPrompt(prompt.slice(start, end)) === storedDigest) return true;
  }
  return false;
}

function normalizeTurnOptions(value, config) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const supported = config.models.some((model) => (
    model.aspectRatios.includes(value.aspectRatio)
    && model.resolutions.includes(value.resolution)
    && model.durations.includes(value.durationSeconds)
  ));
  if (!supported) {
    return undefined;
  }
  return {
    aspectRatio: value.aspectRatio,
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

function normalizeManagedReferenceImage(value, directory = preferenceDirectory()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const filePath = normalizeOptionalString(value.filePath);
  const fileName = normalizeOptionalString(value.fileName);
  const mimeType = normalizeOptionalString(value.mimeType);
  if (!filePath || !fileName || !mimeType?.startsWith('image/')) return undefined;
  const resolvedDirectory = resolve(directory);
  const resolvedFilePath = resolve(filePath);
  if (
    dirname(resolvedFilePath) !== resolvedDirectory
    || !basename(resolvedFilePath).startsWith('video-reference-')
  ) {
    return undefined;
  }
  return { filePath: resolvedFilePath, fileName, mimeType };
}

function removeManagedReferenceImage(referenceImage) {
  if (!referenceImage) return;
  void rm(referenceImage.filePath, { force: true }).catch(() => undefined);
}

function releaseTurnPreference(event, ctx) {
  const key = turnCacheKey(event, ctx);
  if (!key) return;
  const entry = turnPreferencesByRun.get(key);
  if (!entry) return;
  turnPreferencesByRun.delete(key);
  removeManagedReferenceImage(entry.preference.referenceImage);
}

function prunePreferenceCache(now = Date.now()) {
  for (const [key, entry] of turnPreferencesByRun) {
    if (entry.expiresAt > now) continue;
    turnPreferencesByRun.delete(key);
    removeManagedReferenceImage(entry.preference.referenceImage);
  }
  while (turnPreferencesByRun.size > TURN_PREFERENCE_CACHE_MAX_ENTRIES) {
    const oldestKey = turnPreferencesByRun.keys().next().value;
    if (!oldestKey) return;
    removeManagedReferenceImage(turnPreferencesByRun.get(oldestKey)?.preference.referenceImage);
    turnPreferencesByRun.delete(oldestKey);
  }
}

function cacheTurnPreference(event, ctx, preference) {
  const key = turnCacheKey(event, ctx);
  if (!key || !preference) return;
  const now = Date.now();
  prunePreferenceCache(now);
  turnPreferencesByRun.set(key, { preference, expiresAt: now + TURN_PREFERENCE_TTL_MS });
}

function getTurnPreference(event, ctx) {
  prunePreferenceCache();
  const key = turnCacheKey(event, ctx);
  return key ? turnPreferencesByRun.get(key)?.preference : undefined;
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
  const matches = [];
  for (const fileName of fileNames) {
    if (!TURN_PREFERENCE_FILE_RE.test(fileName)) continue;
    const filePath = join(directory, fileName);
    try {
      const record = JSON.parse(await readFile(filePath, 'utf8'));
      const videoOptions = normalizeTurnOptions(record?.videoOptions, config);
      const referenceImage = normalizeManagedReferenceImage(record?.referenceImage, directory);
      const expiresAt = Number(record?.expiresAt);
      if (!videoOptions || !Number.isFinite(expiresAt) || expiresAt <= now) {
        removeManagedReferenceImage(referenceImage);
        await rm(filePath, { force: true });
        continue;
      }
      if (record.sessionKey !== sessionKey || !matchesStoredPrompt(prompt, record)) continue;
      matches.push({
        filePath,
        createdAt: Number(record.createdAt) || 0,
        preference: {
          videoOptions,
          ...(referenceImage ? { referenceImage } : {}),
        },
      });
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
    return match.preference;
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

/** Keeps tool invocation model-owned while routing its managed Provider model from real image inputs. */
function registerTurnPreferenceHooks(api, config) {
  registerLifecycleHook(api, 'before_prompt_build', async (event, ctx) => {
    const preference = await consumeTurnOptions(event, ctx, config);
    if (!preference) return undefined;
    cacheTurnPreference(event, ctx, preference);
    return { appendContext: VIDEO_MODE_PROMPT_CONTEXT };
  }, {
    name: `${PROVIDER_ID}:turn-video-preferences`,
    description: 'Consume one composer video preference and retain it for a model-selected video tool call.',
    timeoutMs: 1000,
  });

  registerLifecycleHook(api, 'before_tool_call', (event, ctx) => {
    const toolName = normalizeOptionalString(event?.toolName)?.split(':').at(-1)?.toLowerCase();
    if (toolName !== 'video_generate') return undefined;
    const params = event?.params && typeof event.params === 'object' && !Array.isArray(event.params)
      ? event.params
      : {};
    const action = normalizeOptionalString(params.action)?.toLowerCase();
    if (action && action !== 'generate') return undefined;
    const preference = getTurnPreference(event, ctx);
    const effectiveParams = preference?.referenceImage
      ? (() => {
        const { image: _image, images: _images, imageRoles: _imageRoles, ...rest } = params;
        return { ...rest, image: preference.referenceImage.filePath };
      })()
      : params;
    const model = automaticModelForInputImages(config, normalizeToolReferenceImages(effectiveParams).length);
    const options = applyOptionsForModel(preference?.videoOptions, model);
    return {
      params: {
        ...effectiveParams,
        model: `${PROVIDER_ID}/${model.id}`,
        ...(options
          ? {
            ...options,
            size: sizeForAspectRatio(options.resolution, options.aspectRatio, config.resolutionSizes),
          }
          : {}),
        timeoutMs: config.timeoutMs,
      },
    };
  }, {
    name: `${PROVIDER_ID}:turn-video-options`,
    description: 'Route the managed video model from tool image inputs and apply current-turn video constraints.',
    priority: 100,
  });

  registerLifecycleHook(api, 'after_tool_call', (event, ctx) => {
    const toolName = normalizeOptionalString(event?.toolName)?.split(':').at(-1)?.toLowerCase();
    if (toolName !== 'video_generate' || event?.error) return;
    releaseTurnPreference(event, ctx);
  }, {
    name: `${PROVIDER_ID}:release-video-reference`,
    description: 'Release the managed current-turn reference image after video_generate accepts it.',
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
