import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { isProviderApiKeyConfigured } from 'openclaw/plugin-sdk/provider-auth';
import { resolveApiKeyForProvider } from 'openclaw/plugin-sdk/provider-auth-runtime';
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';
import { resizeToJpeg } from 'openclaw/plugin-sdk/media-runtime';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const PROVIDER_ID = 'uclaw-video';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 1000;
const DEFAULT_CONTENT_DOWNLOAD_ATTEMPT_TIMEOUT_MS = 60 * 1000;
const DEFAULT_CONTENT_DOWNLOAD_MAX_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_INPUT_IMAGE_BYTES = 1024 * 1024;
const DEFAULT_MIME_TYPE = 'video/mp4';
const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PROVIDER_DIAGNOSTIC_CHARS = 400;
const PROVIDER_REQUEST_ID_HEADERS = [
  'x-request-id',
  'request-id',
  'x-correlation-id',
  'x-trace-id',
  'cf-ray',
];
const REFERENCE_IMAGE_COMPRESSION_ATTEMPTS = [
  { maxSide: 1600, quality: 76 },
  { maxSide: 1280, quality: 60 },
  { maxSide: 1024, quality: 48 },
  { maxSide: 768, quality: 40 },
  { maxSide: 512, quality: 32 },
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
  'Use the managed model, exact pixel size, mode, and duration supplied to the tool call.',
  'The runtime binds the current turn reference image automatically.',
  'Do not invent a reference-image file path.',
].join(' ');
const turnPreferencesByRun = new Map();

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeStringArray(value, validator = () => true) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => {
    const normalized = normalizeOptionalString(entry);
    return normalized && validator(normalized) ? [normalized] : [];
  }))];
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1;
}

function parseExactVideoSize(value) {
  const size = normalizeOptionalString(value);
  if (!size) return undefined;
  const match = /^(\d{1,5})x(\d{1,5})$/u.exec(size);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  const divisor = greatestCommonDivisor(width, height);
  return {
    size,
    width,
    height,
    aspectRatio: `${width / divisor}:${height / divisor}`,
    resolution: `${Math.min(width, height)}P`,
  };
}

function isPixelSize(value) {
  return Boolean(parseExactVideoSize(value));
}

function aspectRatioForExactSize(size) {
  return parseExactVideoSize(size)?.aspectRatio;
}

function resolutionForExactSize(size) {
  return parseExactVideoSize(size)?.resolution;
}

function numericResolutionMatchesSize(resolution, size) {
  const normalized = normalizeOptionalString(resolution);
  const exactSize = parseExactVideoSize(size);
  if (!normalized || !exactSize) return false;
  if (!/^\d+P$/iu.test(normalized)) return true;
  return normalized.toUpperCase() === exactSize.resolution.toUpperCase();
}

function listVideoGenerationVariants(model) {
  const declaredAspectRatios = new Set(normalizeStringArray(model?.aspectRatios));
  const declaredResolutions = normalizeStringArray(model?.resolutions);
  const seen = new Set();
  const variants = [];
  for (const rawSize of Array.isArray(model?.sizes) ? model.sizes : []) {
    const exactSize = parseExactVideoSize(rawSize);
    if (!exactSize || !declaredAspectRatios.has(exactSize.aspectRatio)) continue;
    for (const resolution of declaredResolutions) {
      if (!numericResolutionMatchesSize(resolution, exactSize.size)) continue;
      const key = `${exactSize.size}\u0000${exactSize.aspectRatio}\u0000${resolution}`;
      if (seen.has(key)) continue;
      seen.add(key);
      variants.push({ ...exactSize, resolution });
    }
  }
  return variants;
}

function normalizedDuration(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function validateVideoGenerationOptions(value, model) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issue: 'combination' };
  }
  const modelId = normalizeOptionalString(value.modelId);
  if (!modelId || modelId !== model.id) return { ok: false, issue: 'model' };
  const mode = normalizeOptionalString(value.mode);
  if (!mode || !model.modes.includes(mode)) return { ok: false, issue: 'mode' };
  const size = normalizeOptionalString(value.size);
  if (!size || !model.sizes.includes(size) || !parseExactVideoSize(size)) {
    return { ok: false, issue: 'size' };
  }
  const aspectRatio = normalizeOptionalString(value.aspectRatio);
  if (!aspectRatio || !model.aspectRatios.includes(aspectRatio)) {
    return { ok: false, issue: 'aspectRatio' };
  }
  const resolution = normalizeOptionalString(value.resolution);
  if (!resolution || !model.resolutions.includes(resolution)) {
    return { ok: false, issue: 'resolution' };
  }
  const variantSupported = listVideoGenerationVariants(model).some((variant) => (
    variant.size === size
    && variant.aspectRatio === aspectRatio
    && variant.resolution === resolution
  ));
  if (!variantSupported) return { ok: false, issue: 'combination' };
  const durationSeconds = normalizedDuration(value.durationSeconds);
  if (!durationSeconds || !model.durations.includes(durationSeconds)) {
    return { ok: false, issue: 'durationSeconds' };
  }
  return {
    ok: true,
    options: { modelId, size, mode, aspectRatio, resolution, durationSeconds },
  };
}

function variantMatches(variant, preference) {
  const size = normalizeOptionalString(preference?.size);
  const aspectRatio = normalizeOptionalString(preference?.aspectRatio);
  const resolution = normalizeOptionalString(preference?.resolution);
  return (!size || variant.size === size)
    && (!aspectRatio || variant.aspectRatio === aspectRatio)
    && (!resolution || variant.resolution === resolution);
}

function hasVariantPreference(preference) {
  return Boolean(
    normalizeOptionalString(preference?.size)
    || normalizeOptionalString(preference?.aspectRatio)
    || normalizeOptionalString(preference?.resolution),
  );
}

function pickVariant(variants, preferences) {
  for (const preference of preferences) {
    if (!hasVariantPreference(preference)) continue;
    const match = variants.find((variant) => variantMatches(variant, preference));
    if (match) return match;
  }
  return variants[0];
}

function pickDuration(model, preferred, defaults) {
  for (const candidate of [preferred, model.defaultDurationSeconds, defaults?.defaultDurationSeconds]) {
    const duration = normalizedDuration(candidate);
    if (duration && model.durations.includes(duration)) return duration;
  }
  return model.durations.find((duration) => normalizedDuration(duration) !== undefined);
}

function resolveVideoGenerationOptions(model, mode, preferred, defaults = {}) {
  if (!model.modes.includes(mode)) return undefined;
  const variants = listVideoGenerationVariants(model);
  if (variants.length === 0) return undefined;
  const preferredSize = normalizeOptionalString(preferred?.size);
  const preferredAspectRatio = normalizeOptionalString(preferred?.aspectRatio);
  const preferredResolution = normalizeOptionalString(preferred?.resolution);
  const variant = pickVariant(variants, [
    { size: preferredSize, aspectRatio: preferredAspectRatio, resolution: preferredResolution },
    { size: preferredSize, aspectRatio: preferredAspectRatio },
    { size: preferredSize, resolution: preferredResolution },
    { size: preferredSize },
    { aspectRatio: preferredAspectRatio, resolution: preferredResolution },
    { aspectRatio: preferredAspectRatio },
    { resolution: preferredResolution },
    {
      size: model.defaultSize,
      aspectRatio: model.defaultAspectRatio,
      resolution: model.defaultResolution,
    },
    { size: model.defaultSize },
    { aspectRatio: model.defaultAspectRatio, resolution: model.defaultResolution },
    {
      size: defaults.defaultSize,
      aspectRatio: defaults.defaultAspectRatio,
      resolution: defaults.defaultResolution,
    },
    { size: defaults.defaultSize },
    { aspectRatio: defaults.defaultAspectRatio, resolution: defaults.defaultResolution },
  ]);
  const durationSeconds = pickDuration(model, preferred?.durationSeconds, defaults);
  if (!durationSeconds) return undefined;
  return {
    modelId: model.id,
    size: variant.size,
    mode,
    aspectRatio: variant.aspectRatio,
    resolution: variant.resolution,
    durationSeconds,
  };
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
  const modes = normalizeStringArray(value.modes);
  const sizes = normalizeStringArray(value.sizes, isPixelSize);
  const durations = Array.isArray(value.durations)
    ? [...new Set(value.durations
      .map((entry) => Number(entry))
      .filter((entry) => Number.isSafeInteger(entry) && entry > 0))]
    : [];
  if (!id || modes.length === 0 || sizes.length === 0 || durations.length === 0) return undefined;

  const configuredDefaultSize = normalizeOptionalString(value.defaultSize);
  const defaultSize = configuredDefaultSize && sizes.includes(configuredDefaultSize)
    ? configuredDefaultSize
    : sizes[0];
  const derivedAspectRatios = [...new Set(sizes.map(aspectRatioForExactSize).filter(Boolean))];
  const configuredAspectRatios = normalizeStringArray(value.aspectRatios);
  const aspectRatios = configuredAspectRatios.length > 0 ? configuredAspectRatios : derivedAspectRatios;
  const derivedResolutions = [...new Set(sizes.map(resolutionForExactSize).filter(Boolean))];
  const configuredResolutions = normalizeStringArray(value.resolutions);
  const resolutions = configuredResolutions.length > 0 ? configuredResolutions : derivedResolutions;
  const contractModel = { id, modes, sizes, aspectRatios, resolutions, durations };
  if (listVideoGenerationVariants(contractModel).length === 0) return undefined;
  const sizeAspectRatio = aspectRatioForExactSize(defaultSize);
  const configuredDefaultAspectRatio = normalizeOptionalString(value.defaultAspectRatio);
  const defaultAspectRatio = configuredDefaultAspectRatio && aspectRatios.includes(configuredDefaultAspectRatio)
    ? configuredDefaultAspectRatio
    : sizeAspectRatio && aspectRatios.includes(sizeAspectRatio)
      ? sizeAspectRatio
      : aspectRatios[0];
  const sizeResolution = resolutionForExactSize(defaultSize);
  const configuredDefaultResolution = normalizeOptionalString(value.defaultResolution);
  const defaultResolution = configuredDefaultResolution
    && resolutions.includes(configuredDefaultResolution)
    && numericResolutionMatchesSize(configuredDefaultResolution, defaultSize)
    ? configuredDefaultResolution
    : sizeResolution && resolutions.includes(sizeResolution)
      ? sizeResolution
      : resolutions[0];
  const configuredDuration = normalizePositiveInteger(value.defaultDurationSeconds, durations[0]);
  const defaultDurationSeconds = durations.includes(configuredDuration) ? configuredDuration : durations[0];
  return {
    id,
    modes,
    sizes,
    aspectRatios,
    resolutions,
    durations,
    defaultSize,
    defaultAspectRatio,
    defaultResolution,
    defaultDurationSeconds,
    requiresImage: value.requiresImage === true,
  };
}

/** A media provider exists only when a verified runtime catalog was explicitly installed. */
function resolvePluginConfig(value) {
  const configuredModels = Array.isArray(value?.models)
    ? value.models.map(normalizeModelConfig).filter(Boolean)
    : [];
  if (value?.enabled !== true || configuredModels.length === 0) return undefined;
  const models = configuredModels;
  const configuredDefaultModel = normalizeOptionalString(value?.defaultModel);
  const defaultModel = models.some((model) => model.id === configuredDefaultModel)
    ? configuredDefaultModel
    : models[0].id;
  const defaultModelConfig = models.find((model) => model.id === defaultModel) ?? models[0];
  const configuredDefaultSize = normalizeOptionalString(value?.defaultSize);
  const defaultSize = configuredDefaultSize && defaultModelConfig.sizes.includes(configuredDefaultSize)
    ? configuredDefaultSize
    : defaultModelConfig.defaultSize;
  const configuredDefaultDuration = normalizePositiveInteger(
    value?.defaultDurationSeconds,
    defaultModelConfig.defaultDurationSeconds,
  );
  const defaultDurationSeconds = defaultModelConfig.durations.includes(configuredDefaultDuration)
    ? configuredDefaultDuration
    : defaultModelConfig.defaultDurationSeconds;
  return {
    models,
    defaultModel,
    defaultSize,
    defaultDurationSeconds,
    pollIntervalMs: normalizePositiveInteger(value?.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
    requestTimeoutMs: normalizePositiveInteger(value?.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    contentDownloadAttemptTimeoutMs: normalizePositiveInteger(
      value?.contentDownloadAttemptTimeoutMs,
      DEFAULT_CONTENT_DOWNLOAD_ATTEMPT_TIMEOUT_MS,
    ),
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

function sanitizeDiagnosticText(value, maxChars = MAX_PROVIDER_DIAGNOSTIC_CHARS) {
  const text = String(value || '')
    .replace(/(authorization["'\s:=]+)(?:bearer\s+)?[^"',\s}]+/giu, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/giu, 'sk-[REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret|token|signature)["'\s:=]+)([^"',\s}]+)/giu,
      '$1[REDACTED]',
    )
    .replace(/data:image\/[^;,]+;base64,[A-Za-z0-9+/=_-]+/giu, 'data:image/[REDACTED];base64,[REDACTED]')
    .replace(/https?:\/\/[^\s"']*(?:access_token|api_key|token|signature|x-amz-signature)[^\s"']*/giu, '[REDACTED_URL]')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...[truncated ${text.length - maxChars} chars]`;
}

function sanitizeProviderRequestId(value) {
  const requestId = normalizeOptionalString(value);
  if (!requestId) return undefined;
  return requestId.replace(/[^A-Za-z0-9._:/-]/gu, '_').slice(0, 160) || undefined;
}

function extractProviderRequestId(response, payload) {
  for (const header of PROVIDER_REQUEST_ID_HEADERS) {
    const requestId = sanitizeProviderRequestId(response.headers.get(header));
    if (requestId) return requestId;
  }
  for (const record of nestedPayloadRecords(payload)) {
    for (const key of ['request_id', 'requestId', 'trace_id', 'traceId']) {
      const requestId = sanitizeProviderRequestId(record[key]);
      if (requestId) return requestId;
    }
  }
  return undefined;
}

function summarizeProviderResponse(response, payload, rawText) {
  const contentType = normalizeOptionalString(response.headers.get('content-type'))?.split(';', 1)[0];
  const keys = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload)
      .slice(0, 12)
      .map((key) => sanitizeDiagnosticText(key, 48))
      .filter(Boolean)
      .sort()
    : [];
  const records = nestedPayloadRecords(payload);
  const errorRecord = records
    .map((record) => (record.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? record.error
      : record))
    .find((record) => record && typeof record === 'object');
  const errorCode = sanitizeDiagnosticText(errorRecord?.code, 80);
  const errorType = sanitizeDiagnosticText(errorRecord?.type, 80);
  const message = sanitizeDiagnosticText(readResponseError(payload, ''), 220);
  const invalidJsonSample = payload && typeof payload === 'object'
    ? ''
    : sanitizeDiagnosticText(rawText, 160);
  return [
    contentType ? `contentType=${contentType}` : undefined,
    keys.length > 0 ? `keys=${keys.join(',')}` : undefined,
    errorCode ? `code=${errorCode}` : undefined,
    errorType ? `type=${errorType}` : undefined,
    message ? `message=${message}` : undefined,
    invalidJsonSample ? `body=${invalidJsonSample}` : undefined,
  ].filter(Boolean).join(' ');
}

function isReferenceUploadNotFound(status, summary) {
  if (status === 404) return true;
  const normalized = String(summary || '').toLowerCase();
  return /(?:apimart|reference|image).{0,100}(?:upload|上传).{0,100}(?:404|not found)/iu.test(normalized)
    || /(?:404|not found).{0,100}(?:apimart|reference|image).{0,100}(?:upload|上传)/iu.test(normalized);
}

function remainingTimeout(deadline) {
  return Math.max(1, deadline - Date.now());
}

class HttpResponseError extends Error {
  constructor(message, status, details = {}) {
    const diagnostics = [
      details.requestId ? `providerRequestId=${details.requestId}` : undefined,
      details.responseSummary ? `response={${details.responseSummary}}` : undefined,
    ].filter(Boolean).join(' ');
    super(diagnostics ? `${message}; ${diagnostics}` : message);
    this.name = 'HttpResponseError';
    this.status = status;
    this.providerRequestId = details.requestId;
    this.responseSummary = details.responseSummary;
    this.retryable = details.retryable;
  }
}

class IncompleteVideoContentError extends Error {
  constructor(message, resumeState) {
    super(message);
    this.name = 'IncompleteVideoContentError';
    this.resumeState = resumeState;
  }
}

class GeneratedVideoTooLargeError extends Error {
  constructor(maxDownloadBytes) {
    super(`Generated video exceeds ${maxDownloadBytes} bytes`);
    this.name = 'GeneratedVideoTooLargeError';
  }
}

/** Reads a response incrementally so an absent Content-Length cannot bypass the managed limit. */
async function readResponseBuffer(response, maxDownloadBytes, options = {}) {
  if (!response.body) throw new IncompleteVideoContentError('Video content response has no body');
  const reader = response.body.getReader();
  const resumeState = options.resumeState;
  const expectedBytes = options.expectedBytes;
  const target = Number.isSafeInteger(expectedBytes)
    ? resumeState?.buffer?.length === expectedBytes
      ? resumeState.buffer
      : Buffer.allocUnsafe(expectedBytes)
    : undefined;
  const chunks = target ? undefined : [];
  const startOffset = target && resumeState ? resumeState.receivedBytes : 0;
  let totalBytes = startOffset;
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
    ) {
      throw error;
    }
    const nextResumeState = target && totalBytes > startOffset
      ? {
        buffer: target,
        receivedBytes: totalBytes,
        totalBytes: target.length,
        validator: options.validator,
      }
      : undefined;
    throw new IncompleteVideoContentError(
      error instanceof Error && error.name === 'AbortError'
        ? 'Video content download timed out before the body was complete'
        : 'Video content response ended before the body was complete',
      nextResumeState,
    );
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) throw new IncompleteVideoContentError('Video content response is empty');
  if (target && totalBytes !== target.length) {
    throw new IncompleteVideoContentError(`Video content declared ${target.length} bytes but returned ${totalBytes}`, {
      buffer: target,
      receivedBytes: totalBytes,
      totalBytes: target.length,
      validator: options.validator,
    });
  }
  return target ?? Buffer.concat(chunks, totalBytes - startOffset);
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
function requestTimeout(deadline, timeoutMs) {
  return Math.min(remainingTimeout(deadline), timeoutMs);
}

function isTransientHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function errorCode(error) {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current.code === 'string' && current.code) return current.code.toUpperCase();
    current = current.cause;
  }
  return undefined;
}

function isRetryableNetworkError(error) {
  if (error instanceof HttpResponseError) {
    return typeof error.retryable === 'boolean'
      ? error.retryable
      : isTransientHttpStatus(error.status);
  }
  if (error instanceof IncompleteVideoContentError) return true;
  const code = errorCode(error);
  if (code && new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
  ]).has(code)) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('timed out') || message.includes('fetch failed');
}

/** Performs one JSON request with an operation timeout inside the generation deadline. */
async function fetchJson(url, init, deadline, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeout(deadline, timeoutMs));
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let payload = {};
    let invalidJson = false;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      invalidJson = true;
      payload = null;
    }
    const requestId = extractProviderRequestId(response, payload);
    const responseSummary = summarizeProviderResponse(response, payload, text);
    if (invalidJson && response.ok) {
      throw new HttpResponseError(`${label} returned invalid JSON`, response.status, {
        requestId,
        responseSummary,
        retryable: false,
      });
    }
    if (!response.ok) {
      const message = sanitizeDiagnosticText(
        readResponseError(payload, `${label} failed with HTTP ${response.status}`),
        240,
      );
      const terminalReferenceUploadFailure = isReferenceUploadNotFound(response.status, responseSummary);
      throw new HttpResponseError(
        message || `${label} failed with HTTP ${response.status}`,
        response.status,
        {
          requestId,
          responseSummary,
          retryable: !terminalReferenceUploadFailure && isTransientHttpStatus(response.status),
        },
      );
    }
    return { payload, requestId, responseSummary };
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
async function pollVideoTask({ baseUrl, apiKey, taskId, deadline, pollIntervalMs, requestTimeoutMs, logger }) {
  let lastStatus;
  while (Date.now() < deadline) {
    let payload;
    let diagnostics;
    try {
      const response = await fetchJson(
        `${baseUrl}/videos/${encodeURIComponent(taskId)}`,
        {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        },
        deadline,
        requestTimeoutMs,
        'Video status request',
      );
      payload = response.payload;
      diagnostics = response;
    } catch (error) {
      if (!isRetryableNetworkError(error)) throw error;
      logger?.warn?.('Video status request failed temporarily; polling will continue', {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(Math.min(pollIntervalMs, remainingTimeout(deadline)));
      continue;
    }
    const failureMessage = extractFailureMessage(payload);
    if (failureMessage) {
      throw new HttpResponseError(sanitizeDiagnosticText(failureMessage, 240), 200, {
        requestId: diagnostics?.requestId,
        responseSummary: diagnostics?.responseSummary,
        retryable: false,
      });
    }
    if (isComplete(payload)) return payload;
    lastStatus = extractStatus(payload);
    await sleep(Math.min(pollIntervalMs, remainingTimeout(deadline)));
  }
  throw new Error(lastStatus
    ? `Video generation task ${taskId} did not finish in time; last status was "${lastStatus}"`
    : `Video generation task ${taskId} did not finish in time`);
}

/** Performs one authenticated download and accepts only a structurally complete MP4. */
function parseContentRange(value) {
  const match = normalizeOptionalString(value)?.match(/^bytes (\d+)-(\d+)\/(\d+)$/iu);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) {
    return undefined;
  }
  return { start, end, total };
}

function responseValidator(response) {
  const etag = normalizeOptionalString(response.headers.get('etag'));
  const lastModified = normalizeOptionalString(response.headers.get('last-modified'));
  if (!etag && !lastModified) return undefined;
  return {
    header: etag ? 'etag' : 'last-modified',
    value: etag ?? lastModified,
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
  };
}

function responseValidatorChanged(response, validator) {
  if (!validator) return false;
  const currentEtag = normalizeOptionalString(response.headers.get('etag'));
  const currentLastModified = normalizeOptionalString(response.headers.get('last-modified'));
  return Boolean((validator.etag && currentEtag && currentEtag !== validator.etag)
    || (validator.lastModified
      && currentLastModified
      && currentLastModified !== validator.lastModified));
}

/** Performs one authenticated download and accepts only a structurally complete MP4. */
async function downloadVideoContentAttempt({
  baseUrl,
  apiKey,
  taskId,
  deadline,
  attemptTimeoutMs,
  maxDownloadBytes,
  resumeState,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeout(deadline, attemptTimeoutMs));
  try {
    const headers = {
      Accept: 'video/*,application/octet-stream',
      'Accept-Encoding': 'identity',
      Authorization: `Bearer ${apiKey}`,
    };
    const hasResumeState = resumeState && resumeState.receivedBytes < resumeState.totalBytes;
    if (hasResumeState) {
      headers.Range = `bytes=${resumeState.receivedBytes}-`;
      if (resumeState.validator) headers['If-Range'] = resumeState.validator.value;
    }
    const response = await fetch(`${baseUrl}/videos/${encodeURIComponent(taskId)}/content`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpResponseError(`Video content download failed with HTTP ${response.status}`, response.status);
    }
    const contentRange = response.status === 206
      ? parseContentRange(response.headers.get('content-range'))
      : undefined;
    if (response.status === 206 && !contentRange) {
      await response.body?.cancel().catch(() => undefined);
      throw new IncompleteVideoContentError('Video content response has an invalid Content-Range header');
    }
    let acceptedResumeState;
    if (hasResumeState && response.status === 206) {
      const validRange = contentRange.start === resumeState.receivedBytes
        && contentRange.total === resumeState.totalBytes;
      if (!validRange) {
        await response.body?.cancel().catch(() => undefined);
        throw new IncompleteVideoContentError(
          'Video content response does not match the requested byte range; restarting from byte zero',
        );
      }
      if (responseValidatorChanged(response, resumeState.validator)) {
        await response.body?.cancel().catch(() => undefined);
        throw new IncompleteVideoContentError(
          'Video content validator changed during range resume; restarting from byte zero',
        );
      }
      acceptedResumeState = resumeState;
    } else if (response.status === 206 && contentRange.start !== 0) {
      await response.body?.cancel().catch(() => undefined);
      throw new IncompleteVideoContentError(
        'Video content response started after byte zero without resumable state',
      );
    }
    const contentLengthHeader = normalizeOptionalString(response.headers.get('content-length'));
    const contentLength = contentLengthHeader && /^\d+$/u.test(contentLengthHeader)
      ? Number(contentLengthHeader)
      : undefined;
    const totalBytes = contentRange?.total ?? contentLength;
    if (Number.isSafeInteger(totalBytes) && totalBytes > maxDownloadBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new GeneratedVideoTooLargeError(maxDownloadBytes);
    }
    const contentEncoding = normalizeOptionalString(response.headers.get('content-encoding'))?.toLowerCase();
    const expectedBytes = Number.isSafeInteger(totalBytes)
      && (!contentEncoding || contentEncoding === 'identity')
      ? totalBytes
      : undefined;
    const buffer = await readResponseBuffer(response, maxDownloadBytes, {
      expectedBytes,
      resumeState: acceptedResumeState,
      validator: responseValidator(response) ?? acceptedResumeState?.validator,
    });
    assertCompleteMp4(buffer);
    return {
      buffer,
      mimeType: DEFAULT_MIME_TYPE,
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

/** Retries recoverable content downloads without resubmitting the completed generation task. */
async function downloadVideoContent({
  baseUrl,
  apiKey,
  taskId,
  deadline,
  attemptTimeoutMs,
  maxDownloadBytes,
  pollIntervalMs,
  contentDownloadMaxAttempts,
}) {
  let attempts = 0;
  let lastError;
  let resumeState;
  while (attempts < contentDownloadMaxAttempts && Date.now() < deadline) {
    attempts += 1;
    try {
      return await downloadVideoContentAttempt({
        baseUrl,
        apiKey,
        taskId,
        deadline,
        attemptTimeoutMs,
        maxDownloadBytes,
        resumeState,
      });
    } catch (error) {
      if (!isRetryableNetworkError(error)) throw error;
      lastError = error;
      resumeState = error instanceof IncompleteVideoContentError ? error.resumeState : undefined;
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
  if (asset?.buffer) {
    const mimeType = normalizeOptionalString(asset.mimeType) ?? 'image/png';
    return `data:${mimeType};base64,${Buffer.from(asset.buffer).toString('base64')}`;
  }
  const url = normalizeOptionalString(asset?.url);
  if (url && (/^https?:\/\//iu.test(url) || /^data:image\/(?:jpeg|png|webp);base64,/iu.test(url))) {
    return url;
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

function normalizeToolReferenceInputs(params, singularKey, pluralKey) {
  const inputs = [];
  const add = (value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const input = value.trim();
    if (!inputs.includes(input)) inputs.push(input);
  };
  add(params?.[singularKey]);
  if (Array.isArray(params?.[pluralKey])) {
    for (const value of params[pluralKey]) add(value);
  }
  return inputs;
}

function assertSupportedToolReferences(params) {
  const images = normalizeToolReferenceImages(params);
  const videos = normalizeToolReferenceInputs(params, 'video', 'videos');
  const audios = normalizeToolReferenceInputs(params, 'audioRef', 'audioRefs');
  if (images.length > 0 && videos.length > 0) {
    throw new Error('UClaw video generation does not support combined image/video reference inputs');
  }
  if (videos.length > 0) {
    throw new Error('UClaw video generation does not support video reference inputs');
  }
  if (audios.length > 0) {
    throw new Error('UClaw video generation does not support audio reference inputs');
  }
}

function assertSupportedOutputOptions(params) {
  if (params?.audio !== undefined && params.audio !== false) {
    throw new Error('UClaw video generation does not support generated audio');
  }
  if (params?.watermark !== undefined && params.watermark !== false) {
    throw new Error('UClaw video generation does not support watermarks');
  }
}

function modelIdFromReference(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  const slash = normalized.indexOf('/');
  if (slash < 0) return normalized;
  return normalized.slice(0, slash) === PROVIDER_ID
    ? normalizeOptionalString(normalized.slice(slash + 1))
    : undefined;
}

/** Select a configured model that explicitly supports the input-derived mode. */
function modelForInputImages(config, inputImageCount, requestedModelId) {
  if (inputImageCount > 1) {
    throw new Error('UClaw video generation supports at most one reference image');
  }
  const requiredMode = inputImageCount === 1 ? 'image-to-video' : 'text-to-video';
  const requested = modelIdFromReference(requestedModelId);
  const model = requested
    ? config.models.find((entry) => entry.id === requested && entry.modes.includes(requiredMode))
    : config.models.find((entry) => entry.id === config.defaultModel && entry.modes.includes(requiredMode))
      ?? config.models.find((entry) => entry.modes.includes(requiredMode));
  if (!model) {
    const detail = requested ? `model ${requested}` : 'a default model';
    throw new Error(`Managed video policy does not provide ${detail} for ${requiredMode}`);
  }
  return { model, mode: requiredMode };
}

function applyOptionsForModel(videoOptions, model) {
  if (!videoOptions) return undefined;
  const mode = model.modes.includes(videoOptions.mode) ? videoOptions.mode : model.modes[0];
  return resolveVideoGenerationOptions(model, mode, videoOptions, {
    defaultSize: model.defaultSize,
    defaultAspectRatio: model.defaultAspectRatio,
    defaultResolution: model.defaultResolution,
    defaultDurationSeconds: model.defaultDurationSeconds,
  });
}

function referenceImageLimitLabel(maxBytes) {
  return `${maxBytes} ${maxBytes === 1 ? 'byte' : 'bytes'}`;
}

function detectedInlineImageMimeType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

/** Normalizes buffered references to the inline formats accepted by the managed video relay. */
async function prepareInputImage(asset, maxBytes) {
  if (!asset?.buffer) return asset;
  const input = Buffer.from(asset.buffer);
  const detectedMimeType = detectedInlineImageMimeType(input);
  if (input.byteLength <= maxBytes && SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(detectedMimeType)) {
    return { ...asset, buffer: input, mimeType: detectedMimeType };
  }

  try {
    for (const attempt of REFERENCE_IMAGE_COMPRESSION_ATTEMPTS) {
      const output = await resizeToJpeg({
        buffer: input,
        maxSide: attempt.maxSide,
        quality: attempt.quality,
        withoutEnlargement: true,
      });
      if (output.byteLength <= maxBytes) {
        return { ...asset, buffer: output, mimeType: 'image/jpeg' };
      }
    }
  } catch {
    // A stable validation error below is safe to surface when image processing is unavailable.
  }

  if (!detectedMimeType) {
    throw new Error('Reference image must be a valid PNG, JPEG, or WebP image');
  }

  throw new Error(
    `Reference image exceeds the ${referenceImageLimitLabel(maxBytes)} reference-image limit and could not be compressed below it`,
  );
}

async function resolveModelRequest(req, config) {
  const inputImages = Array.isArray(req.inputImages) ? req.inputImages : [];
  const inputVideos = Array.isArray(req.inputVideos) ? req.inputVideos : [];
  const inputAudios = Array.isArray(req.inputAudios) ? req.inputAudios : [];
  if (inputImages.length > 0 && inputVideos.length > 0) {
    throw new Error('UClaw video generation does not support combined image/video reference inputs');
  }
  if (inputVideos.length > 0) {
    throw new Error('UClaw video generation does not support video reference inputs');
  }
  if (inputAudios.length > 0) {
    throw new Error('UClaw video generation does not support audio reference inputs');
  }
  assertSupportedOutputOptions(req);
  const { model, mode } = modelForInputImages(config, inputImages.length, req.model);

  const requested = {
    modelId: model.id,
    size: normalizeOptionalString(req.size) ?? model.defaultSize ?? config.defaultSize,
    mode,
    aspectRatio: normalizeOptionalString(req.aspectRatio)
      ?? aspectRatioForExactSize(req.size ?? model.defaultSize ?? config.defaultSize),
    resolution: normalizeOptionalString(req.resolution)
      ?? resolutionForExactSize(req.size ?? model.defaultSize ?? config.defaultSize),
    durationSeconds: normalizePositiveInteger(
      req.durationSeconds,
      model.defaultDurationSeconds ?? config.defaultDurationSeconds,
    ),
  };
  const validation = validateVideoGenerationOptions(requested, model);
  if (!validation.ok) {
    if (validation.issue === 'size') {
      throw new Error(`${model.id} does not support ${requested.size} size`);
    }
    if (validation.issue === 'aspectRatio') {
      throw new Error(`${model.id} does not support ${requested.aspectRatio} aspect ratio`);
    }
    if (validation.issue === 'resolution') {
      throw new Error(`${model.id} does not support ${requested.resolution} resolution`);
    }
    if (validation.issue === 'durationSeconds') {
      throw new Error(
        `${model.id} does not support ${requested.durationSeconds} second videos; supported durations: ${model.durations.join(', ')}`,
      );
    }
    const exactResolution = resolutionForExactSize(requested.size);
    throw new Error(
      exactResolution && requested.resolution !== exactResolution
        ? `${model.id} requires ${exactResolution} resolution for ${requested.size} size`
        : `${model.id} does not support ${requested.size}/${requested.aspectRatio}/${requested.resolution}`,
    );
  }
  const requestedDuration = validation.options.durationSeconds;
  if (!model.durations.includes(requestedDuration)) {
    throw new Error(
      `${model.id} does not support ${requestedDuration} second videos; supported durations: ${model.durations.join(', ')}`,
    );
  }

  const inputImage = inputImages.length === 1
    ? await prepareInputImage(inputImages[0], config.maxInputImageBytes)
    : undefined;

  const image = inputImages.length === 1 ? inputImageValue(inputImage) : undefined;
  if (inputImages.length === 1 && !image) {
    throw new Error(`${model.id} reference image is missing data`);
  }
  return {
    model,
    mode,
    aspectRatio: validation.options.aspectRatio,
    resolution: validation.options.resolution,
    size: validation.options.size,
    durationSeconds: requestedDuration,
    image,
  };
}

function modeCapabilities(model) {
  const shared = {
    maxVideos: 1,
    maxInputAudios: 0,
    maxDurationSeconds: Math.max(...model.durations),
    supportedDurationSeconds: model.durations,
    supportsSize: true,
    sizes: model.sizes,
    supportsAspectRatio: true,
    aspectRatios: model.aspectRatios,
    supportsResolution: true,
    resolutions: model.resolutions,
    supportsAudio: false,
    supportsWatermark: false,
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
    ...modeCapabilities(model),
  }), {});
}

/** Builds the provider registered against OpenClaw's native video_generate tool. */
function buildProvider(config, logger) {
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
      return configuredModel ? modeCapabilities(configuredModel) : undefined;
    },
    async generateVideo(req) {
      const providerConfig = resolveProviderConfig(req);
      const baseUrl = normalizeBaseUrl(providerConfig.baseUrl);
      const request = await resolveModelRequest(req, config);
      const apiKey = await resolveApiKey(req);
      const deadline = Date.now() + normalizePositiveInteger(req.timeoutMs, config.timeoutMs);

      // Submit one OpenAI-compatible task, then follow the provider-owned task id.
      const body = {
        model: request.model.id,
        prompt: req.prompt,
        seconds: String(request.durationSeconds),
        size: request.size,
        aspect_ratio: request.aspectRatio,
        ...(request.resolution
          ? {
            quality: request.resolution.toLowerCase(),
            resolution: request.resolution.toLowerCase(),
          }
          : {}),
        ...(request.image ? { input_reference: request.image } : {}),
      };
      const submissionResponse = await fetchJson(
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
        config.requestTimeoutMs,
        'Video generation request',
      );
      const submitted = submissionResponse.payload;
      const failureMessage = extractFailureMessage(submitted);
      if (failureMessage) {
        throw new HttpResponseError(sanitizeDiagnosticText(failureMessage, 240), 200, {
          requestId: submissionResponse.requestId,
          responseSummary: submissionResponse.responseSummary,
          retryable: false,
        });
      }
      const taskId = extractTaskId(submitted);
      if (!taskId) {
        const submittedUrl = isComplete(submitted) ? extractVideoUrl(submitted) : undefined;
        if (submittedUrl) {
          const metadata = {
            status: extractStatus(submitted),
            mode: request.mode,
            aspectRatio: request.aspectRatio,
            ...(request.resolution ? { resolution: request.resolution } : {}),
            size: request.size,
            durationSeconds: request.durationSeconds,
          };
          return {
            videos: [{
              url: submittedUrl,
              mimeType: DEFAULT_MIME_TYPE,
              fileName: 'generated-video.mp4',
              metadata,
            }],
            model: request.model.id,
            metadata,
          };
        }
        throw new HttpResponseError('Video generation response missing task id', 200, {
          requestId: submissionResponse.requestId,
          responseSummary: submissionResponse.responseSummary,
          retryable: false,
        });
      }
      logger?.info?.('Video generation task submitted', { taskId, model: request.model.id });
      const completed = isComplete(submitted)
        ? submitted
        : await pollVideoTask({
          baseUrl,
          apiKey,
          taskId,
          deadline,
          pollIntervalMs: config.pollIntervalMs,
          requestTimeoutMs: config.requestTimeoutMs,
          logger,
        });
      const resultUrl = extractVideoUrl(completed);
      const metadata = {
        taskId,
        status: extractStatus(completed),
        mode: request.mode,
        aspectRatio: request.aspectRatio,
        ...(request.resolution ? { resolution: request.resolution } : {}),
        size: request.size,
        durationSeconds: request.durationSeconds,
      };
      // Prefer a local managed-media asset; URL-only delivery is reserved for
      // completed tasks whose bounded local download attempts all fail.
      logger?.info?.('Video generation completed; downloading content', { taskId });
      let video;
      try {
        video = {
          ...await downloadVideoContent({
            baseUrl,
            apiKey,
            taskId,
            deadline,
            attemptTimeoutMs: config.contentDownloadAttemptTimeoutMs,
            maxDownloadBytes: config.maxDownloadBytes,
            pollIntervalMs: config.pollIntervalMs,
            contentDownloadMaxAttempts: config.contentDownloadMaxAttempts,
          }),
          ...(resultUrl ? { url: resultUrl } : {}),
          metadata,
        };
      } catch (error) {
        if (error instanceof GeneratedVideoTooLargeError || !resultUrl) throw error;
        const downloadError = error instanceof Error ? error.message : String(error);
        logger?.warn?.('Video content download failed; delivering provider result URL', {
          taskId,
          error: downloadError,
        });
        video = {
          url: resultUrl,
          mimeType: DEFAULT_MIME_TYPE,
          fileName: `${taskId}.mp4`,
          metadata: {
            ...metadata,
            localDownloadFailed: true,
            downloadError,
          },
        };
      }
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
  const modelId = modelIdFromReference(value.modelId);
  const model = config.models.find((entry) => entry.id === modelId);
  if (!model) return undefined;
  const validation = validateVideoGenerationOptions({ ...value, modelId }, model);
  return validation.ok ? validation.options : undefined;
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
    assertSupportedToolReferences(effectiveParams);
    assertSupportedOutputOptions(effectiveParams);
    const inputImageCount = normalizeToolReferenceImages(effectiveParams).length;
    const requestedModelId = preference?.videoOptions?.modelId ?? effectiveParams.model;
    const { model, mode } = modelForInputImages(config, inputImageCount, requestedModelId);
    const options = applyOptionsForModel(preference?.videoOptions ?? {
      modelId: model.id,
      size: effectiveParams.size,
      mode,
      aspectRatio: effectiveParams.aspectRatio,
      resolution: effectiveParams.resolution,
      durationSeconds: effectiveParams.durationSeconds,
    }, model);
    return {
      params: {
        ...effectiveParams,
        model: `${PROVIDER_ID}/${model.id}`,
        ...(options
          ? {
            ...options,
            mode,
            size: options.size,
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
    if (!config) {
      api.logger?.warn?.('UClaw video provider disabled: no verified runtime model policy');
      return;
    }
    api.registerVideoGenerationProvider(buildProvider(config, api.logger));
    registerTurnPreferenceHooks(api, config);
  },
});

export const videoGenerationContractForTesting = Object.freeze({
  listVideoGenerationVariants,
  resolveVideoGenerationOptions,
  validateVideoGenerationOptions,
});

export default pluginEntry;
