import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { imageSourceUploadFileName } from 'openclaw/plugin-sdk/image-generation';
import { resolveApiKeyForProvider } from 'openclaw/plugin-sdk/image-generation-core';
import { isProviderApiKeyConfigured } from 'openclaw/plugin-sdk/provider-auth';
import { createHash, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';

const PROVIDER_ID = 'clawx-openai-image';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MIME_TYPE = 'image/png';
const OUTPUT_MIME_TYPES = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};
const MAX_INPUT_IMAGES = 5;
const MAX_UPSTREAM_DIAGNOSTIC_CHARS = 1000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const MAX_REMOTE_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PROVIDER_REQUEST_ID_HEADERS = [
  'x-request-id',
  'request-id',
  'x-correlation-id',
  'x-trace-id',
  'cf-ray',
];
const IMAGE_ERROR_CODES = {
  http: 'IMAGE_PROVIDER_HTTP_ERROR',
  incompatible: 'IMAGE_RESPONSE_INCOMPATIBLE',
  invalidBase64: 'IMAGE_RESPONSE_INVALID_BASE64',
  mediaDownload: 'IMAGE_MEDIA_DOWNLOAD_FAILED',
  mediaTooLarge: 'IMAGE_MEDIA_TOO_LARGE',
  remoteUrlBlocked: 'IMAGE_REMOTE_URL_BLOCKED',
  responseTooLarge: 'IMAGE_PROVIDER_RESPONSE_TOO_LARGE',
};
const PROVIDER_REQUEST_ID_PAYLOAD_KEYS = [
  'request_id',
  'requestId',
  'trace_id',
  'traceId',
  'correlation_id',
  'correlationId',
];
const IMAGE_RESPONSE_CONTAINER_KEYS = [
  'data',
  'images',
  'output',
  'content',
  'result',
  'response',
  'choices',
  'message',
  'parts',
  'candidates',
  'inline_data',
  'inlineData',
  'source',
];
const IMAGE_RESPONSE_SCALAR_KEYS = new Set([
  'data',
  'images',
  'output',
  'content',
  'result',
  'image',
  'image_url',
  'imageUrl',
  'url',
  'href',
  'b64_json',
  'base64',
  'image_base64',
  'imageBase64',
  'inline_data',
  'inlineData',
]);
const TURN_IMAGE_PREFERENCES_DIRECTORY = 'uclaw-turn-preferences';
const TURN_IMAGE_PREFERENCE_TTL_MS = 5 * 60 * 1000;
const TURN_IMAGE_PREFERENCE_CACHE_MAX_ENTRIES = 64;
const TURN_IMAGE_PREFERENCE_FILE_RE = /^turn-([0-9a-f-]{36})\.json$/iu;
const IMAGE_MODE_PROMPT_CONTEXT = [
  'The user selected image generation mode for this turn.',
  'When the request asks for an image, call image_generate instead of only describing an image.',
].join(' ');
const turnImagePreferencesByRun = new Map();
const imageFetchDispatcher = new Agent({
  headersTimeout: DEFAULT_TIMEOUT_MS,
  bodyTimeout: DEFAULT_TIMEOUT_MS,
});
const blockedRemoteAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  blockedRemoteAddresses.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 96],
  ['::1', 128],
  ['::ffff:0.0.0.0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) {
  blockedRemoteAddresses.addSubnet(address, prefix, 'ipv6');
}
const publicImageFetchDispatcher = new Agent({
  headersTimeout: DEFAULT_TIMEOUT_MS,
  bodyTimeout: DEFAULT_TIMEOUT_MS,
  connect: { lookup: lookupPublicRemoteAddress },
});
const SUPPORTED_EDIT_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/u, '');
}

function normalizeRelayBaseUrl(value, fallback = DEFAULT_BASE_URL) {
  const trimmed = trimTrailingSlash(value || fallback);
  if (!trimmed) return DEFAULT_BASE_URL;
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function resolveCount(req) {
  const raw = Number(req.count ?? 1);
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(4, Math.trunc(raw)));
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeCatalogString(value, maxLength = 200) {
  const normalized = normalizeOptionalString(value);
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001F\u007F]/u.test(normalized)) return undefined;
  return normalized;
}

function normalizeImageSize(value) {
  const normalized = normalizeCatalogString(value, 40);
  if (!normalized) return undefined;
  const match = normalized.match(/^(\d+)x(\d+)$/u);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return `${width}x${height}`;
}

function uniqueNormalizedStrings(value, normalize) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalize).filter(Boolean))];
}

function firstAllowed(value, allowed, fallback) {
  const normalized = normalizeCatalogString(value);
  if (normalized && allowed.includes(normalized)) return normalized;
  return fallback;
}

function normalizeRuntimeImageModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.enabled !== true) return undefined;
  const id = normalizeCatalogString(value.id);
  const sizes = uniqueNormalizedStrings(value.sizes, normalizeImageSize);
  const qualities = uniqueNormalizedStrings(value.qualities, (entry) => normalizeCatalogString(entry, 64));
  if (!id || sizes.length === 0 || qualities.length === 0) return undefined;
  return {
    id,
    sizes,
    qualities,
    defaultSize: firstAllowed(value.defaultSize, sizes, sizes[0]),
    defaultQuality: firstAllowed(value.defaultQuality, qualities, qualities[0]),
    supportsEditing: value.supportsEditing !== false,
  };
}

/** A missing or empty managed catalog disables the provider; there are no bundled model defaults. */
function resolveRuntimeImageConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.models)) {
    return undefined;
  }
  const seen = new Set();
  const models = value.models
    .map(normalizeRuntimeImageModel)
    .filter((model) => {
      if (!model || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
  if (models.length === 0) return undefined;

  const configuredDefaultModel = normalizeCatalogString(value.defaultModel);
  const defaultModel = models.some((model) => model.id === configuredDefaultModel)
    ? configuredDefaultModel
    : models[0].id;
  const defaultModelConfig = models.find((model) => model.id === defaultModel);
  return {
    models,
    defaultModel,
    defaultSize: firstAllowed(value.defaultSize, defaultModelConfig.sizes, defaultModelConfig.defaultSize),
    defaultQuality: firstAllowed(
      value.defaultQuality,
      defaultModelConfig.qualities,
      defaultModelConfig.defaultQuality,
    ),
  };
}

function turnImagePreferenceDirectory() {
  const stateDirectory = normalizeOptionalString(process.env.OPENCLAW_STATE_DIR) || join(homedir(), '.openclaw');
  return join(stateDirectory, TURN_IMAGE_PREFERENCES_DIRECTORY);
}

function digestPrompt(prompt) {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

/** Matches either a raw composer prompt or OpenClaw's metadata-wrapped prompt suffix. */
function matchesStoredPrompt(prompt, record) {
  const storedDigest = normalizeOptionalString(record?.messageDigest);
  if (!storedDigest) return false;
  if (digestPrompt(prompt) === storedDigest) return true;
  const messageLength = Number(record?.messageLength);
  return Number.isSafeInteger(messageLength)
    && messageLength > 0
    && messageLength <= prompt.length
    && digestPrompt(prompt.slice(-messageLength)) === storedDigest;
}

function normalizeTurnImageOptions(value, config) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const modelId = normalizeCatalogString(value.modelId);
  const size = normalizeOptionalString(value.size);
  const quality = normalizeOptionalString(value.quality);
  const model = config.models.find((entry) => entry.id === modelId);
  if (!model || !model.sizes.includes(size) || !model.qualities.includes(quality)) return undefined;
  return { modelId, size, quality };
}

function turnCacheKey(event, ctx) {
  return normalizeOptionalString(event?.runId)
    || normalizeOptionalString(ctx?.runId)
    || normalizeOptionalString(event?.sessionKey)
    || normalizeOptionalString(ctx?.sessionKey);
}

function pruneTurnImagePreferenceCache(now = Date.now()) {
  for (const [key, entry] of turnImagePreferencesByRun) {
    if (entry.expiresAt <= now) turnImagePreferencesByRun.delete(key);
  }
  while (turnImagePreferencesByRun.size > TURN_IMAGE_PREFERENCE_CACHE_MAX_ENTRIES) {
    const oldestKey = turnImagePreferencesByRun.keys().next().value;
    if (!oldestKey) return;
    turnImagePreferencesByRun.delete(oldestKey);
  }
}

function cacheTurnImageOptions(event, ctx, imageOptions) {
  const key = turnCacheKey(event, ctx);
  if (!key || !imageOptions) return;
  const now = Date.now();
  pruneTurnImagePreferenceCache(now);
  turnImagePreferencesByRun.set(key, {
    imageOptions,
    expiresAt: now + TURN_IMAGE_PREFERENCE_TTL_MS,
  });
}

function getTurnImageOptions(event, ctx) {
  pruneTurnImagePreferenceCache();
  const key = turnCacheKey(event, ctx);
  return key ? turnImagePreferencesByRun.get(key)?.imageOptions : undefined;
}

/** Atomically claims the UI preference for one ACP prompt without persisting prompt text. */
async function consumeTurnImageOptions(event, ctx, config) {
  const sessionKey = normalizeOptionalString(event?.sessionKey) || normalizeOptionalString(ctx?.sessionKey);
  const prompt = normalizeOptionalString(event?.prompt);
  if (!sessionKey || !prompt) return undefined;

  const directory = turnImagePreferenceDirectory();
  let fileNames;
  try {
    fileNames = await readdir(directory);
  } catch {
    return undefined;
  }

  const now = Date.now();
  const matches = [];
  for (const fileName of fileNames) {
    if (!TURN_IMAGE_PREFERENCE_FILE_RE.test(fileName)) continue;
    const filePath = join(directory, fileName);
    try {
      const record = JSON.parse(await readFile(filePath, 'utf8'));
      const imageOptions = record?.version === 2
        ? normalizeTurnImageOptions(record?.imageOptions, config)
        : undefined;
      const expiresAt = Number(record?.expiresAt);
      if (!imageOptions || !Number.isFinite(expiresAt) || expiresAt <= now) {
        await rm(filePath, { force: true });
        continue;
      }
      if (record.sessionKey !== sessionKey || !matchesStoredPrompt(prompt, record)) continue;
      matches.push({ filePath, createdAt: Number(record?.createdAt) || 0, imageOptions });
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
    return match.imageOptions;
  }

  return undefined;
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
  if (!apiKey) throw new Error('UClaw OpenAI image API key missing');
  return apiKey;
}

function isConfigured({ cfg, agentDir }) {
  const configuredApiKey = cfg?.models?.providers?.[PROVIDER_ID]?.apiKey;
  if (typeof configuredApiKey === 'string' && configuredApiKey.trim()) return true;
  return isProviderApiKeyConfigured({ provider: PROVIDER_ID, agentDir });
}

function appendImagesPath(baseUrl, mode) {
  return `${trimTrailingSlash(baseUrl)}/images/${mode === 'edit' ? 'edits' : 'generations'}`;
}

function resolveTimeoutMs(req) {
  const raw = Number(req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function imageFileExtensionForMimeType(mimeType) {
  const normalized = String(mimeType || DEFAULT_MIME_TYPE).split(';')[0].trim().toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('svg')) return 'svg';
  return 'png';
}

function compactTimestamp(date = new Date()) {
  return date.toISOString()
    .replace(/\.\d{3}Z$/u, 'Z')
    .replace(/[-:]/gu, '')
    .replace(/[TZ]/gu, '-')
    .replace(/-$/u, '');
}

function uniqueImageFileName(index, mimeType) {
  return `uclaw-image-${index + 1}-${compactTimestamp()}-${randomUUID().slice(0, 8)}.${imageFileExtensionForMimeType(mimeType)}`;
}

function nowMs() {
  return Date.now();
}

function durationSince(startedAt) {
  return Math.max(0, nowMs() - startedAt);
}

function sanitizeErrorMessage(error) {
  if (error instanceof Error) return sanitizeDiagnosticText(error.message, 500);
  return sanitizeDiagnosticText(String(error || 'unknown error'), 500);
}

function sanitizeDiagnosticText(value, maxChars = MAX_UPSTREAM_DIAGNOSTIC_CHARS) {
  const text = String(value || '')
    .replace(/(authorization["'\s:=]+)(?:bearer\s+)?[^"',\s}]+/giu, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/giu, 'sk-[REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret|token)["'\s:=]+)([^"',\s}]+)/giu,
      '$1[REDACTED]',
    )
    .replace(/data:image\/[^;,]+(?:;[^,]*)?;base64,[A-Za-z0-9+/=_-]+/giu, 'data:image/[REDACTED];base64,[REDACTED]')
    .replace(/https?:\/\/[^\s"']*(?:access_token|api_key|token|signature|x-amz-signature)[^\s"']*/giu, '[REDACTED_URL]')
    .replace(/(https?:\/\/[^\s"'?#]+)[?#][^\s"']*/giu, '$1?[REDACTED]')
    .replace(/[\u0000-\u001F\u007F]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...[truncated ${text.length - maxChars} chars]`;
}

function optionalDiagnosticText(value, maxChars) {
  if (value === undefined || value === null) return null;
  const text = sanitizeDiagnosticText(value, maxChars).trim();
  return text || null;
}

function sanitizeProviderRequestId(value) {
  const requestId = sanitizeDiagnosticText(normalizeOptionalString(value), 160);
  if (!requestId || requestId.includes('[REDACTED]')) return undefined;
  return requestId.replace(/[^A-Za-z0-9._:/-]/gu, '_').slice(0, 160) || undefined;
}

function nestedResponseRecords(payload) {
  const records = [];
  const seen = new Set();
  const visit = (value, depth) => {
    if (depth > 4 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 16)) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);
    if (records.length >= 64) return;
    records.push(value);
    for (const key of [
      'error',
      ...IMAGE_RESPONSE_CONTAINER_KEYS,
      'meta',
      'metadata',
      'request',
    ]) {
      const child = value[key];
      if (Array.isArray(child) || isRecord(child)) visit(child, depth + 1);
    }
  };
  visit(payload, 0);
  return records;
}

function extractProviderRequestId(response, payload) {
  for (const header of PROVIDER_REQUEST_ID_HEADERS) {
    const requestId = sanitizeProviderRequestId(response?.headers?.get?.(header));
    if (requestId) return requestId;
  }
  for (const record of nestedResponseRecords(payload)) {
    for (const key of PROVIDER_REQUEST_ID_PAYLOAD_KEYS) {
      const requestId = sanitizeProviderRequestId(record[key]);
      if (requestId) return requestId;
    }
  }
  return undefined;
}

function responseShapeSummary(payload, response, rawText = '') {
  const contentType = normalizeOptionalString(response?.headers?.get?.('content-type'))?.split(';', 1)[0];
  const binaryPayload = Buffer.isBuffer(payload) || payload instanceof Uint8Array;
  const rootType = binaryPayload
    ? 'binary'
    : Array.isArray(payload) ? 'array' : payload === null ? 'null' : typeof payload;
  const keys = !binaryPayload && payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload)
      .slice(0, 16)
      .map((key) => {
        const normalized = sanitizeDiagnosticText(key, 48)
          .replace(/[^A-Za-z0-9_.-]/gu, '_');
        return /(?:authorization|api[_-]?key|access[_-]?token|password|secret|token|cookie|signature)/iu.test(normalized)
          ? '[redacted]'
          : normalized;
      })
      .filter(Boolean)
      .sort()
    : [];
  const collectionCounts = ['data', 'images', 'output', 'content']
    .map((key) => (Array.isArray(payload?.[key]) ? `${key}:${payload[key].length}` : undefined))
    .filter(Boolean);
  return [
    contentType ? `contentType=${contentType}` : undefined,
    `root=${rootType}`,
    keys.length > 0 ? `keys=${keys.join(',')}` : undefined,
    collectionCounts.length > 0 ? `arrays=${collectionCounts.join(',')}` : undefined,
    `bodyBytes=${Buffer.isBuffer(rawText) || rawText instanceof Uint8Array
      ? rawText.byteLength
      : Buffer.byteLength(String(rawText || ''))}`,
  ].filter(Boolean).join(' ');
}

class ImageProviderError extends Error {
  constructor(message, details = {}) {
    const providerRequestId = sanitizeProviderRequestId(details.providerRequestId);
    const responseSummary = sanitizeDiagnosticText(details.responseSummary, MAX_UPSTREAM_DIAGNOSTIC_CHARS);
    const diagnostics = [
      providerRequestId ? `providerRequestId=${providerRequestId}` : undefined,
      responseSummary ? `response={${responseSummary}}` : undefined,
    ].filter(Boolean).join(' ');
    super(diagnostics ? `${message}; ${diagnostics}` : message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'ImageProviderError';
    this.code = details.code;
    this.status = details.status;
    this.providerRequestId = providerRequestId;
    this.responseSummary = responseSummary;
  }
}

function logImageTiming(event, details = {}) {
  const message = `[clawx-openai-image] ${event} ${JSON.stringify(details)}`;
  if (event.endsWith('_failed') || event === 'response_error') {
    console.error(message);
    return;
  }
  console.info(message);
}

function unsafeRemoteAddressError() {
  const error = new Error('Remote host did not resolve to a public address');
  error.code = 'UCLAW_UNSAFE_REMOTE_ADDRESS';
  return error;
}

function normalizeRemoteHostname(hostname) {
  const value = String(hostname || '').trim().toLowerCase();
  const withoutBrackets = value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1)
    : value;
  return withoutBrackets.replace(/\.+$/u, '');
}

function isBlockedRemoteAddress(address) {
  const normalized = String(address || '').trim().toLowerCase();
  if (!normalized || normalized.includes('%')) return true;
  const family = isIP(normalized);
  if (family === 4) return blockedRemoteAddresses.check(normalized, 'ipv4');
  if (family === 6) return blockedRemoteAddresses.check(normalized, 'ipv6');
  return true;
}

function isLocalNetworkHostname(hostname) {
  const normalized = normalizeRemoteHostname(hostname);
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal')
    || normalized === 'home.arpa'
    || normalized.endsWith('.home.arpa');
}

function lookupPublicRemoteAddress(hostname, options, callback) {
  const normalizedHostname = normalizeRemoteHostname(hostname);
  const lookupOptions = typeof options === 'number' ? { family: options } : (options || {});
  const family = lookupOptions.family === 4 || lookupOptions.family === 6
    ? lookupOptions.family
    : 0;
  if (!normalizedHostname || isLocalNetworkHostname(normalizedHostname)) {
    callback(unsafeRemoteAddressError());
    return;
  }
  dnsLookup(normalizedHostname, {
    all: true,
    verbatim: true,
  }).then((addresses) => {
    if (
      addresses.length === 0
      || addresses.some((entry) => isBlockedRemoteAddress(entry.address))
    ) {
      callback(unsafeRemoteAddressError());
      return;
    }
    if (lookupOptions.all === true) {
      callback(null, addresses);
      return;
    }
    const candidates = family === 0
      ? addresses
      : addresses.filter((entry) => entry.family === family);
    if (candidates.length === 0) {
      callback(new Error('Remote host has no address for the requested family'));
      return;
    }
    callback(null, candidates[0].address, candidates[0].family);
  }).catch(() => callback(new Error('Remote host lookup failed')));
}

function errorChainHasCode(error, expectedCode) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (current.code === expectedCode) return true;
    current = current.cause;
  }
  return false;
}

function remoteUrlBlockedError(context = {}) {
  return new ImageProviderError(
    context.kind === 'provider'
      ? 'OpenAI-compatible image provider URL was blocked by network policy'
      : 'OpenAI-compatible image media URL was blocked by network policy',
    {
      code: IMAGE_ERROR_CODES.remoteUrlBlocked,
      providerRequestId: context.providerRequestId,
      responseSummary: context.responseSummary,
    },
  );
}

function validateRemoteHttpUrl(value, context = {}) {
  let parsedUrl;
  try {
    parsedUrl = value instanceof URL ? new URL(value.href) : new URL(String(value || '').trim());
  } catch {
    throw remoteUrlBlockedError(context);
  }
  if (
    !['http:', 'https:'].includes(parsedUrl.protocol)
    || parsedUrl.username
    || parsedUrl.password
  ) {
    throw remoteUrlBlockedError(context);
  }
  const hostname = normalizeRemoteHostname(parsedUrl.hostname);
  if (!hostname) throw remoteUrlBlockedError(context);
  const trustedProviderOrigin = normalizeOptionalString(context.trustedProviderOrigin);
  const isTrustedProviderOrigin = Boolean(trustedProviderOrigin && parsedUrl.origin === trustedProviderOrigin);
  if (context.providerOnly === true && !isTrustedProviderOrigin) {
    throw remoteUrlBlockedError(context);
  }
  if (!isTrustedProviderOrigin) {
    const addressFamily = isIP(hostname);
    if (
      isLocalNetworkHostname(hostname)
      || (addressFamily !== 0 && isBlockedRemoteAddress(hostname))
    ) {
      throw remoteUrlBlockedError(context);
    }
  }
  return { parsedUrl, isTrustedProviderOrigin };
}

function redirectedRequestInit(init, status, currentUrl, nextUrl) {
  const nextInit = { ...init };
  const headers = new Headers(init.headers);
  const method = String(init.method || 'GET').toUpperCase();
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
    nextInit.method = 'GET';
    delete nextInit.body;
    headers.delete('content-length');
    headers.delete('content-type');
  }
  if (currentUrl.origin !== nextUrl.origin) {
    headers.delete('authorization');
    headers.delete('cookie');
    headers.delete('proxy-authorization');
  }
  nextInit.headers = headers;
  return nextInit;
}

async function fetchWithValidatedRedirects(inputUrl, init, context = {}) {
  let currentUrl = inputUrl instanceof URL ? new URL(inputUrl.href) : new URL(String(inputUrl));
  let currentInit = { ...init };
  for (let redirects = 0; ; redirects += 1) {
    const validated = validateRemoteHttpUrl(currentUrl, context);
    let response;
    try {
      response = await undiciFetch(validated.parsedUrl, {
        ...currentInit,
        redirect: 'manual',
        dispatcher: validated.isTrustedProviderOrigin
          ? imageFetchDispatcher
          : publicImageFetchDispatcher,
      });
    } catch (error) {
      if (isAbortError(error, currentInit.signal)) throw error;
      if (errorChainHasCode(error, 'UCLAW_UNSAFE_REMOTE_ADDRESS')) {
        throw remoteUrlBlockedError(context);
      }
      throw new ImageProviderError(
        context.kind === 'provider'
          ? 'OpenAI-compatible image provider request failed'
          : 'OpenAI-compatible image media download failed',
        {
          code: context.kind === 'provider' ? IMAGE_ERROR_CODES.http : IMAGE_ERROR_CODES.mediaDownload,
          providerRequestId: context.providerRequestId,
          responseSummary: context.responseSummary,
        },
      );
    }
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
    await response.body?.cancel().catch(() => undefined);
    if (redirects >= MAX_REMOTE_REDIRECTS) {
      throw new ImageProviderError('OpenAI-compatible image request exceeded the redirect limit', {
        code: context.kind === 'provider' ? IMAGE_ERROR_CODES.http : IMAGE_ERROR_CODES.mediaDownload,
        providerRequestId: context.providerRequestId,
        responseSummary: context.responseSummary,
      });
    }
    let nextUrl;
    try {
      nextUrl = new URL(location, validated.parsedUrl);
    } catch {
      throw remoteUrlBlockedError(context);
    }
    currentInit = redirectedRequestInit(currentInit, response.status, validated.parsedUrl, nextUrl);
    currentUrl = nextUrl;
  }
}

function boundedResponseError(response, context) {
  const contentType = normalizeMimeType(response.headers.get('content-type')) || 'unknown';
  return new ImageProviderError(`${context.label} exceeded ${context.maxBytes} bytes`, {
    code: context.tooLargeCode,
    status: response.status,
    providerRequestId: extractProviderRequestId(response, null) || context.providerRequestId,
    responseSummary: `contentType=${contentType} maxBodyBytes=${context.maxBytes}`,
  });
}

async function readBoundedResponseBody(response, context) {
  const rawContentLength = normalizeOptionalString(response.headers.get('content-length'));
  if (rawContentLength && /^\d+$/u.test(rawContentLength)) {
    try {
      if (BigInt(rawContentLength) > BigInt(context.maxBytes)) {
        await response.body?.cancel().catch(() => undefined);
        throw boundedResponseError(response, context);
      }
    } catch (error) {
      if (error instanceof ImageProviderError) throw error;
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      totalBytes += value.byteLength;
      if (totalBytes > context.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw boundedResponseError(response, context);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch (error) {
    if (error instanceof ImageProviderError || isAbortError(error, context.signal)) throw error;
    throw new ImageProviderError(`${context.label} could not be read`, {
      code: context.readErrorCode,
      status: response.status,
      providerRequestId: extractProviderRequestId(response, null) || context.providerRequestId,
      responseSummary: context.responseSummary,
    });
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

function normalizeMimeType(mimeType) {
  return String(mimeType || '').split(';')[0].trim().toLowerCase();
}

function imageBytes(image) {
  if (image?.buffer instanceof Uint8Array) {
    return Buffer.from(image.buffer.buffer, image.buffer.byteOffset, image.buffer.byteLength);
  }
  return Buffer.from(image?.buffer || []);
}

function sniffSupportedImageMimeType(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return '';
}

function resolveDeliverableImageMimeType(bytes, context = {}) {
  const mimeType = sniffSupportedImageMimeType(bytes);
  if (mimeType) return mimeType;
  throw new ImageProviderError('OpenAI-compatible image response contains a non-image binary payload', {
    code: IMAGE_ERROR_CODES.incompatible,
    providerRequestId: context.providerRequestId,
    responseSummary: context.responseSummary,
  });
}

function supportedMimeTypeFromFileName(fileName) {
  const normalized = String(fileName || '').toLowerCase();
  if (/\.(jpe?g|jfif)$/u.test(normalized)) return 'image/jpeg';
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.webp')) return 'image/webp';
  return '';
}

function isGenericMimeType(mimeType) {
  return !mimeType || mimeType === 'application/octet-stream' || mimeType === 'binary/octet-stream';
}

function resolveEditInputImages(inputImages) {
  const unsupported = [];
  const resolvedImages = inputImages.map((image, index) => {
    const fileName = imageSourceUploadFileName({ image, index });
    const declaredMimeType = normalizeMimeType(image?.mimeType);
    const bytes = imageBytes(image);
    let mimeType = SUPPORTED_EDIT_IMAGE_MIME_TYPES.has(declaredMimeType) ? declaredMimeType : '';
    if (!mimeType && isGenericMimeType(declaredMimeType)) {
      mimeType = sniffSupportedImageMimeType(bytes) || supportedMimeTypeFromFileName(fileName);
    }
    if (!mimeType) {
      unsupported.push({
        fileName,
        mimeType: declaredMimeType || 'unknown',
      });
    }
    return {
      bytes,
      fileName,
      mimeType,
    };
  });

  if (unsupported.length > 0) {
    const details = unsupported
      .map(({ fileName, mimeType }) => `${fileName} (${mimeType})`)
      .join(', ');
    throw new Error(`UClaw OpenAI 图片编辑只支持 PNG、JPEG 或 WebP 参考图。当前文件不支持：${details}。请先转成 PNG 或 JPEG 后重试。`);
  }

  return resolvedImages;
}

function parseDataUrlImage(dataUrl, context = {}) {
  const normalized = String(dataUrl || '');
  if (!/^data:/iu.test(normalized)) return null;
  const match = normalized.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]+)$/iu);
  if (!match) {
    throw new ImageProviderError('OpenAI-compatible image response returned an unsupported data URL', {
      code: IMAGE_ERROR_CODES.incompatible,
      providerRequestId: context.providerRequestId,
      responseSummary: context.responseSummary,
    });
  }
  const buffer = decodeBase64Image(match[2], context);
  const mimeType = resolveDeliverableImageMimeType(buffer, context);
  return {
    buffer,
    mimeType,
  };
}

function decodeBase64Image(value, context = {}) {
  const compact = String(value || '').replace(/\s+/gu, '');
  const unpadded = compact.replace(/=+$/u, '');
  if (
    !compact
    || compact.length % 4 === 1
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)
  ) {
    throw new ImageProviderError('OpenAI-compatible image response contains invalid base64 image data', {
      code: IMAGE_ERROR_CODES.invalidBase64,
      providerRequestId: context.providerRequestId,
      responseSummary: context.responseSummary,
    });
  }
  const buffer = Buffer.from(compact, 'base64');
  const canonical = buffer.toString('base64').replace(/=+$/u, '');
  if (buffer.byteLength === 0 || canonical !== unpadded) {
    throw new ImageProviderError('OpenAI-compatible image response contains invalid base64 image data', {
      code: IMAGE_ERROR_CODES.invalidBase64,
      providerRequestId: context.providerRequestId,
      responseSummary: context.responseSummary,
    });
  }
  return buffer;
}

async function fetchImageUrl(url, context = {}) {
  const startedAt = nowMs();
  const trimmed = String(url || '').trim();
  if (!trimmed) return null;
  let dataImage;
  try {
    dataImage = parseDataUrlImage(trimmed, context);
  } catch (error) {
    if (error instanceof ImageProviderError) throw error;
    throw new ImageProviderError('OpenAI-compatible image response contains invalid image data URL', {
      code: IMAGE_ERROR_CODES.invalidBase64,
      providerRequestId: context.providerRequestId,
      responseSummary: context.responseSummary,
      cause: error,
    });
  }
  if (dataImage) {
    logImageTiming('image_data_url_decoded', {
      requestId: context.requestId,
      index: context.index,
      durationMs: durationSince(startedAt),
      bytes: dataImage.buffer.byteLength,
      mimeType: dataImage.mimeType,
    });
    return dataImage;
  }
  const { parsedUrl } = validateRemoteHttpUrl(trimmed, {
    kind: 'media',
    trustedProviderOrigin: context.trustedProviderOrigin,
    providerRequestId: context.providerRequestId,
    responseSummary: context.responseSummary,
  });
  logImageTiming('image_url_fetch_start', {
    requestId: context.requestId,
    index: context.index,
    host: parsedUrl.host,
    pathHash: createHash('sha256').update(parsedUrl.pathname, 'utf8').digest('hex').slice(0, 12),
  });
  try {
    const response = await fetchWithValidatedRedirects(parsedUrl, {
      method: 'GET',
      signal: context.signal,
    }, {
      kind: 'media',
      trustedProviderOrigin: context.trustedProviderOrigin,
      providerRequestId: context.providerRequestId,
      responseSummary: context.responseSummary,
    });
    if (!response.ok) {
      throw new ImageProviderError(`OpenAI-compatible image media download failed: HTTP ${response.status}`, {
        code: IMAGE_ERROR_CODES.mediaDownload,
        status: response.status,
        providerRequestId: extractProviderRequestId(response, null) || context.providerRequestId,
        responseSummary: `contentType=${normalizeOptionalString(response.headers.get('content-type'))?.split(';', 1)[0] || 'unknown'}`,
      });
    }
    const buffer = await readBoundedResponseBody(response, {
      label: 'OpenAI-compatible image media response',
      maxBytes: MAX_IMAGE_DOWNLOAD_BYTES,
      tooLargeCode: IMAGE_ERROR_CODES.mediaTooLarge,
      readErrorCode: IMAGE_ERROR_CODES.mediaDownload,
      providerRequestId: context.providerRequestId,
      responseSummary: context.responseSummary,
      signal: context.signal,
    });
    const declaredMimeType = normalizeMimeType(response.headers.get('content-type'));
    const contentType = resolveDeliverableImageMimeType(buffer, {
      providerRequestId: extractProviderRequestId(response, null) || context.providerRequestId,
      responseSummary: `contentType=${declaredMimeType || 'unknown'} bodyBytes=${buffer.byteLength}`,
    });
    logImageTiming('image_url_fetch_done', {
      requestId: context.requestId,
      index: context.index,
      status: response.status,
      durationMs: durationSince(startedAt),
      bytes: buffer.byteLength,
      mimeType: contentType,
    });
    return {
      buffer,
      mimeType: contentType,
    };
  } catch (error) {
    logImageTiming('image_url_fetch_failed', {
      requestId: context.requestId,
      index: context.index,
      durationMs: durationSince(startedAt),
      error: sanitizeErrorMessage(error).slice(0, 240),
    });
    if (error instanceof ImageProviderError) throw error;
    throw new ImageProviderError('OpenAI-compatible image media download failed', {
      code: IMAGE_ERROR_CODES.mediaDownload,
      providerRequestId: context.providerRequestId,
      responseSummary: context.responseSummary,
    });
  }
}

function isRecord(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Uint8Array);
}

function hasImagePayloadFields(entry) {
  if (!isRecord(entry)) return false;
  return [
    entry.b64_json,
    entry.base64,
    entry.image_base64,
    entry.url,
    entry.image_url,
    entry.imageUrl,
    entry.image,
    entry.b64Json,
    entry.imageBase64,
    entry.inline_data,
    entry.inlineData,
    entry.source,
  ].some((value) => typeof value === 'string' || isRecord(value))
    || [entry.data, entry.content, entry.result].some((value) => Boolean(classifyFlexibleImagePayload(value)))
    || (/image/iu.test(String(entry.type || '')) && (typeof entry.result === 'string' || isRecord(entry.result)));
}

function collectImageResponseEntries(payload) {
  const entries = [];
  const seen = new Set();
  const visit = (value, key, depth) => {
    if (depth > 4 || entries.length >= 32 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      const classified = key === 'root' || IMAGE_RESPONSE_SCALAR_KEYS.has(key)
        ? classifyFlexibleImagePayload(value)
        : undefined;
      if (classified) {
        entries.push(classified.kind === 'base64' ? { base64: classified.value } : { url: classified.value });
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 32)) visit(item, key, depth + 1);
      return;
    }
    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);
    const imageEntry = hasImagePayloadFields(value);
    if (imageEntry) {
      entries.push(value);
      return;
    }
    for (const childKey of IMAGE_RESPONSE_CONTAINER_KEYS) {
      const child = value[childKey];
      if (Array.isArray(child) || isRecord(child) || typeof child === 'string') {
        visit(child, childKey, depth + 1);
      }
    }
  };
  visit(payload, 'root', 0);
  return entries;
}

function classifyFlexibleImagePayload(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = value.trim();
  if (/^https?:\/\//iu.test(normalized) || /^data:/iu.test(normalized)) {
    return { kind: 'url', value: normalized };
  }

  const compact = normalized.replace(/\s+/gu, '');
  if (
    compact.length < 16
    || compact.length % 4 === 1
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)
  ) {
    return undefined;
  }
  const header = Buffer.from(compact.slice(0, 64), 'base64');
  return sniffSupportedImageMimeType(header)
    ? { kind: 'base64', value: normalized }
    : undefined;
}

function imagePayloadCandidates(entry) {
  const candidates = [];
  const seen = new Set();
  const addCandidate = (kind, value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const normalized = value.trim();
    const key = `${kind}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ kind, value: normalized });
  };

  const visited = new Set();
  const visit = (value, key, depth) => {
    if (depth > 4 || candidates.length >= 16 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (key === 'result' && /image/iu.test(String(entry?.type || ''))) {
        const classified = classifyFlexibleImagePayload(value);
        addCandidate(classified?.kind || 'base64', value);
        return;
      }
      if (['b64_json', 'b64Json', 'base64', 'image_base64', 'imageBase64'].includes(key)) {
        const classified = classifyFlexibleImagePayload(value);
        addCandidate(classified?.kind === 'url' ? 'url' : 'base64', value);
        return;
      }
      if (['url', 'href', 'image_url', 'imageUrl'].includes(key)) {
        const classified = classifyFlexibleImagePayload(value);
        addCandidate(classified?.kind || 'url', value);
        return;
      }
      const classified = classifyFlexibleImagePayload(value);
      if (classified) addCandidate(classified.kind, classified.value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 16)) visit(item, key, depth + 1);
      return;
    }
    if (!isRecord(value) || visited.has(value)) return;
    visited.add(value);
    for (const childKey of [
      'b64_json',
      'b64Json',
      'base64',
      'image_base64',
      'imageBase64',
      'url',
      'href',
      'image_url',
      'imageUrl',
      'image',
      'data',
      'content',
      'result',
      'inline_data',
      'inlineData',
      'source',
    ]) {
      visit(value[childKey], childKey, depth + 1);
    }
  };
  visit(entry, 'entry', 0);
  return candidates;
}

function isAbortError(error, signal) {
  return Boolean(signal?.aborted)
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || error?.code === 'UND_ERR_ABORTED';
}

function candidateFailureDetails(error) {
  return {
    code: normalizeOptionalString(error?.code) || IMAGE_ERROR_CODES.incompatible,
    status: Number.isInteger(error?.status) ? error.status : null,
    providerRequestId: sanitizeProviderRequestId(error?.providerRequestId) || null,
    responseSummary: sanitizeDiagnosticText(error?.responseSummary, MAX_UPSTREAM_DIAGNOSTIC_CHARS) || null,
  };
}

async function parseImageResponseEntry(entry, index, context) {
  const payloads = imagePayloadCandidates(entry);
  let lastFailure;
  for (const imagePayload of payloads) {
    const itemStartedAt = nowMs();
    try {
      const decodedBuffer = imagePayload.kind === 'base64'
        ? decodeBase64Image(imagePayload.value, context)
        : null;
      const fetched = decodedBuffer
        ? {
          buffer: decodedBuffer,
          mimeType: resolveDeliverableImageMimeType(decodedBuffer, context),
        }
        : await fetchImageUrl(imagePayload.value, {
          requestId: context.requestId,
          providerRequestId: context.providerRequestId,
          responseSummary: context.responseSummary,
          trustedProviderOrigin: context.trustedProviderOrigin,
          index,
          signal: context.signal,
        });
      if (!fetched) continue;
      logImageTiming('image_payload_decoded', {
        requestId: context.requestId,
        providerRequestId: context.providerRequestId || null,
        index,
        source: imagePayload.kind,
        durationMs: durationSince(itemStartedAt),
        bytes: fetched.buffer.byteLength,
        mimeType: fetched.mimeType,
      });
      const image = {
        buffer: fetched.buffer,
        mimeType: fetched.mimeType,
        fileName: uniqueImageFileName(index, fetched.mimeType),
      };
      if (typeof entry?.revised_prompt === 'string' && entry.revised_prompt.trim()) {
        image.revisedPrompt = entry.revised_prompt.trim();
      }
      return image;
    } catch (error) {
      if (isAbortError(error, context.signal)) throw error;
      lastFailure = error instanceof ImageProviderError
        ? error
        : new ImageProviderError('OpenAI-compatible image response candidate could not be delivered', {
          code: IMAGE_ERROR_CODES.incompatible,
          providerRequestId: context.providerRequestId,
          responseSummary: context.responseSummary,
          cause: error,
        });
      logImageTiming('image_payload_candidate_skipped', {
        requestId: context.requestId,
        providerRequestId: context.providerRequestId || null,
        responseSummary: context.responseSummary || null,
        index,
        source: imagePayload.kind,
        ...candidateFailureDetails(lastFailure),
      });
    }
  }
  throw lastFailure || new ImageProviderError('OpenAI-compatible image response returned no usable image payload', {
    code: IMAGE_ERROR_CODES.incompatible,
    providerRequestId: context.providerRequestId,
    responseSummary: context.responseSummary,
  });
}

async function parseImagesResponse(payload, context = {}) {
  const startedAt = nowMs();
  const data = collectImageResponseEntries(payload);
  if (data.length === 0) {
    throw new ImageProviderError('OpenAI-compatible image service succeeded but returned an incompatible response shape', {
      code: IMAGE_ERROR_CODES.incompatible,
      providerRequestId: context.providerRequestId,
      responseSummary: context.responseSummary,
    });
  }
  const candidates = await Promise.allSettled(
    data.map((entry, index) => parseImageResponseEntry(entry, index, context)),
  );
  const parsedImages = [];
  const failures = [];
  for (const candidate of candidates) {
    if (candidate.status === 'fulfilled') {
      parsedImages.push(candidate.value);
      continue;
    }
    if (isAbortError(candidate.reason, context.signal)) throw candidate.reason;
    failures.push(candidate.reason);
  }
  if (parsedImages.length > 0 && failures.length > 0) {
    logImageTiming('image_candidates_skipped', {
      requestId: context.requestId,
      providerRequestId: context.providerRequestId || null,
      failedCandidates: failures.length,
      deliveredCandidates: parsedImages.length,
      failures: failures.slice(0, 4).map((error) => ({
        code: error instanceof ImageProviderError ? error.code : undefined,
        status: error instanceof ImageProviderError ? error.status : undefined,
        message: sanitizeErrorMessage(error).slice(0, 240),
      })),
    });
  }
  if (parsedImages.length === 0) {
    const firstFailure = failures.find((error) => error instanceof ImageProviderError);
    if (firstFailure) throw firstFailure;
    throw new ImageProviderError('OpenAI-compatible image service succeeded but returned no deliverable image payloads', {
      code: IMAGE_ERROR_CODES.incompatible,
      providerRequestId: context.providerRequestId,
      responseSummary: context.responseSummary,
    });
  }
  logImageTiming('images_parsed', {
    requestId: context.requestId,
    responseItems: data.length,
    outputImages: parsedImages.length,
    durationMs: durationSince(startedAt),
  });
  return parsedImages;
}

function logUpstreamResponseError(response, text, payload, context = {}) {
  const errorPayload = payload && typeof payload === 'object' ? payload.error : null;
  const errorRecord = errorPayload && typeof errorPayload === 'object' ? errorPayload : {};
  const providerRequestId = extractProviderRequestId(response, payload);
  logImageTiming('response_error', {
    requestId: context.requestId || null,
    providerRequestId: providerRequestId || null,
    mode: context.mode || null,
    status: response.status,
    statusText: optionalDiagnosticText(response.statusText, 120),
    upstreamMessage: optionalDiagnosticText(errorRecord.message || payload?.message, 500),
    upstreamType: optionalDiagnosticText(errorRecord.type || payload?.type, 160),
    upstreamCode: optionalDiagnosticText(errorRecord.code || payload?.code, 160),
    upstreamParam: optionalDiagnosticText(errorRecord.param || payload?.param, 160),
    responseSummary: responseShapeSummary(payload, response, text),
  });
}

async function readJsonResponse(response, failureLabel, context = {}) {
  const body = await readBoundedResponseBody(response, {
    label: 'OpenAI-compatible image provider response',
    maxBytes: MAX_PROVIDER_RESPONSE_BYTES,
    tooLargeCode: IMAGE_ERROR_CODES.responseTooLarge,
    readErrorCode: IMAGE_ERROR_CODES.http,
    responseSummary: `contentType=${normalizeMimeType(response.headers.get('content-type')) || 'unknown'}`,
    signal: context.signal,
  });
  const headerRequestId = extractProviderRequestId(response, null);
  const directImageMimeType = response.ok ? sniffSupportedImageMimeType(body) : '';
  if (directImageMimeType) {
    return {
      payload: {
        data: [{ b64_json: body.toString('base64'), mime_type: directImageMimeType }],
      },
      providerRequestId: headerRequestId,
      responseSummary: responseShapeSummary(body, response, body),
    };
  }

  const text = body.toString('utf8');
  let payload = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      const responseSummary = responseShapeSummary(null, response, body);
      if (!response.ok) {
        logUpstreamResponseError(response, body, null, context);
        throw new ImageProviderError(`${failureLabel}: HTTP ${response.status}`, {
          code: IMAGE_ERROR_CODES.http,
          status: response.status,
          providerRequestId: headerRequestId,
          responseSummary,
        });
      }
      if (classifyFlexibleImagePayload(text)) {
        return {
          payload: text.trim(),
          providerRequestId: headerRequestId,
          responseSummary: responseShapeSummary(text.trim(), response, body),
        };
      }
      throw new ImageProviderError('OpenAI-compatible image service succeeded but returned invalid JSON', {
        code: IMAGE_ERROR_CODES.incompatible,
        status: response.status,
        providerRequestId: headerRequestId,
        responseSummary,
      });
    }
  }
  const providerRequestId = extractProviderRequestId(response, payload);
  const responseSummary = responseShapeSummary(payload, response, body);
  if (!response.ok) {
    logUpstreamResponseError(response, body, payload, context);
    const message = optionalDiagnosticText(payload?.error?.message || payload?.message, 300)
      || `HTTP ${response.status}`;
    throw new ImageProviderError(`${failureLabel}: ${message}`, {
      code: IMAGE_ERROR_CODES.http,
      status: response.status,
      providerRequestId,
      responseSummary,
    });
  }
  return { payload, providerRequestId, responseSummary };
}

function resolveOpenAIImageOptions(req) {
  const openai = req.providerOptions?.openai ?? {};
  const outputFormat = req.outputFormat ?? req.output_format ?? openai.outputFormat ?? openai.output_format;
  const background = openai.background ?? req.background;
  const requestedCompression = openai.outputCompression
    ?? openai.output_compression
    ?? req.outputCompression
    ?? req.output_compression;
  const outputCompression = outputFormat === 'jpeg' || outputFormat === 'webp'
    ? requestedCompression
    : undefined;
  return {
    outputFormat,
    outputMimeType: OUTPUT_MIME_TYPES[outputFormat] || DEFAULT_MIME_TYPE,
    background,
    outputCompression,
    moderation: openai.moderation,
    user: openai.user,
  };
}

function openAIImageOptionEntries(req, quality) {
  const options = resolveOpenAIImageOptions(req);
  return {
    quality,
    ...(options.outputFormat !== undefined ? { output_format: options.outputFormat } : {}),
    ...(options.background !== undefined ? { background: options.background } : {}),
    ...(options.moderation !== undefined ? { moderation: options.moderation } : {}),
    ...(options.outputCompression !== undefined ? { output_compression: options.outputCompression } : {}),
    ...(options.user !== undefined ? { user: options.user } : {}),
  };
}

function parseDimensions(value) {
  const match = String(value || '').trim().match(/^(\d+)x(\d+)$/u);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height, area: width * height, ratio: width / height };
}

function parseAspectRatio(value) {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/u);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return width / height;
}

function bestSizeForAspectRatio(sizes, aspectRatio, fallbackSize) {
  const requestedRatio = parseAspectRatio(aspectRatio);
  if (!requestedRatio) return fallbackSize;
  const referenceArea = parseDimensions(fallbackSize)?.area;
  return sizes
    .map((size) => ({ size, dimensions: parseDimensions(size) }))
    .filter(({ dimensions }) => dimensions)
    .sort((left, right) => {
      const leftRatioDistance = Math.abs(Math.log(left.dimensions.ratio / requestedRatio));
      const rightRatioDistance = Math.abs(Math.log(right.dimensions.ratio / requestedRatio));
      if (leftRatioDistance !== rightRatioDistance) return leftRatioDistance - rightRatioDistance;
      if (!referenceArea) return 0;
      return Math.abs(Math.log(left.dimensions.area / referenceArea))
        - Math.abs(Math.log(right.dimensions.area / referenceArea));
    })[0]?.size ?? fallbackSize;
}

function requestModelId(value, fallback) {
  const requested = normalizeCatalogString(value);
  if (!requested) return fallback;
  const prefix = `${PROVIDER_ID}/`;
  return requested.startsWith(prefix) ? requested.slice(prefix.length) : requested;
}

function resolveImageRequest(req, config) {
  const modelId = requestModelId(req.model, config.defaultModel);
  const model = config.models.find((entry) => entry.id === modelId);
  if (!model) throw new Error(`Managed image policy does not allow model ${modelId}`);

  const modelDefaultSize = model.id === config.defaultModel ? config.defaultSize : model.defaultSize;
  const requestedSize = normalizeOptionalString(req.size);
  const size = requestedSize
    || bestSizeForAspectRatio(model.sizes, req.aspectRatio, modelDefaultSize);
  if (!model.sizes.includes(size)) {
    throw new Error(`${model.id} does not support image size ${size}`);
  }

  const modelDefaultQuality = model.id === config.defaultModel ? config.defaultQuality : model.defaultQuality;
  const quality = normalizeOptionalString(req.quality) || modelDefaultQuality;
  if (!model.qualities.includes(quality)) {
    throw new Error(`${model.id} does not support image quality ${quality}`);
  }
  if (Array.isArray(req.inputImages) && req.inputImages.length > 0 && !model.supportsEditing) {
    throw new Error(`${model.id} does not support image editing`);
  }
  return { model, size, quality };
}

function buildGenerateBody(req, request, count) {
  return {
    model: request.model.id,
    prompt: req.prompt,
    n: count,
    size: request.size,
    ...openAIImageOptionEntries(req, request.quality),
  };
}

function multipartHeader(boundary, name, extra = '') {
  return Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n\r\n`, 'utf8');
}

function multipartTextPart(boundary, name, value) {
  return Buffer.concat([
    multipartHeader(boundary, name),
    Buffer.from(String(value), 'utf8'),
    Buffer.from('\r\n', 'utf8'),
  ]);
}

function multipartFilePart(boundary, name, fileName, mimeType, bytes) {
  const safeName = String(fileName || 'image.png').replace(/[\r\n"]/gu, '_');
  const normalizedMimeType = String(mimeType || DEFAULT_MIME_TYPE).replace(/[\r\n]/gu, '').trim() || DEFAULT_MIME_TYPE;
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${name}"; filename="${safeName}"\r\n`
      + `Content-Type: ${normalizedMimeType}\r\n\r\n`,
      'utf8',
    ),
    Buffer.from(bytes),
    Buffer.from('\r\n', 'utf8'),
  ]);
}

function buildEditMultipart(req, editImages, request, count) {
  const boundary = `uclaw-openai-image-${randomUUID()}`;
  const parts = [
    multipartTextPart(boundary, 'model', request.model.id),
    multipartTextPart(boundary, 'prompt', req.prompt),
    multipartTextPart(boundary, 'n', String(count)),
    multipartTextPart(boundary, 'size', request.size),
  ];
  for (const [name, value] of Object.entries(openAIImageOptionEntries(req, request.quality))) {
    parts.push(multipartTextPart(boundary, name, value));
  }
  editImages.forEach((image, index) => {
    const fieldName = editImages.length > 1 ? 'image[]' : 'image';
    parts.push(multipartFilePart(
      boundary,
      fieldName,
      image.fileName,
      image.mimeType,
      image.bytes,
    ));
  });
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const body = Buffer.concat(parts);
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b > 0) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}

function aspectRatioForImageSize(size) {
  const dimensions = parseDimensions(size);
  if (!dimensions) return undefined;
  const divisor = greatestCommonDivisor(dimensions.width, dimensions.height);
  return `${dimensions.width / divisor}:${dimensions.height / divisor}`;
}

function imageProviderCapabilities(config) {
  const sizesByModel = Object.fromEntries(config.models.map((model) => [model.id, [...model.sizes]]));
  const aspectRatiosByModel = Object.fromEntries(config.models.map((model) => [
    model.id,
    [...new Set(model.sizes.map(aspectRatioForImageSize).filter(Boolean))],
  ]));
  return {
    generate: {
      maxCount: 4,
      supportsSize: true,
      supportsAspectRatio: true,
      supportsResolution: false,
    },
    edit: {
      enabled: config.models.some((model) => model.supportsEditing),
      maxCount: 4,
      maxInputImages: MAX_INPUT_IMAGES,
      supportsSize: true,
      supportsAspectRatio: true,
      supportsResolution: false,
    },
    geometry: {
      sizes: [...new Set(config.models.flatMap((model) => model.sizes))],
      sizesByModel,
      aspectRatios: [...new Set(Object.values(aspectRatiosByModel).flat())],
      aspectRatiosByModel,
    },
    output: {
      qualities: [...new Set(config.models.flatMap((model) => model.qualities))],
      formats: ['png', 'jpeg', 'webp'],
      backgrounds: ['transparent', 'opaque', 'auto'],
    },
  };
}

function buildProvider(config) {
  return {
    id: PROVIDER_ID,
    label: 'UClaw OpenAI Images',
    defaultModel: config.defaultModel,
    models: config.models.map((model) => model.id),
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    capabilities: imageProviderCapabilities(config),
    isConfigured,
    async generateImage(req) {
      const requestId = randomUUID().slice(0, 8);
      const startedAt = nowMs();
      const inputImages = req.inputImages ?? [];
      if (inputImages.length > MAX_INPUT_IMAGES) {
        throw new Error(`UClaw OpenAI image editing supports up to ${MAX_INPUT_IMAGES} reference images.`);
      }
      const mode = inputImages.length > 0 ? 'edit' : 'generate';
      const editImages = mode === 'edit' ? resolveEditInputImages(inputImages) : [];
      const providerConfig = resolveProviderConfig(req);
      const apiKey = await resolveApiKey(req);
      const request = resolveImageRequest(req, config);
      const count = resolveCount(req);
      const baseUrl = normalizeRelayBaseUrl(providerConfig.baseUrl, DEFAULT_BASE_URL);
      const outputOptions = resolveOpenAIImageOptions(req);
      const editMultipart = mode === 'edit' ? buildEditMultipart(req, editImages, request, count) : null;
      const upstreamUrl = appendImagesPath(baseUrl, mode);
      const parsedUpstreamUrl = new URL(upstreamUrl);
      const upstreamPath = parsedUpstreamUrl.pathname;
      const trustedProviderOrigin = parsedUpstreamUrl.origin;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), resolveTimeoutMs(req));
      const relayRequestAbort = () => controller.abort(req.signal?.reason);
      if (req.signal?.aborted) relayRequestAbort();
      else req.signal?.addEventListener('abort', relayRequestAbort, { once: true });
      try {
        const requestBody = mode === 'edit'
          ? editMultipart.body
          : JSON.stringify(buildGenerateBody(req, request, count));
        logImageTiming('request_start', {
          requestId,
          mode,
          inputImageCount: inputImages.length,
          model: request.model.id,
          path: upstreamPath,
          count,
          size: request.size,
          quality: request.quality,
          outputFormat: outputOptions.outputFormat || null,
          background: outputOptions.background || null,
          outputCompression: outputOptions.outputCompression ?? null,
          requestBodyBytes: Buffer.byteLength(requestBody),
        });
        const requestStartedAt = nowMs();
        const response = await fetchWithValidatedRedirects(parsedUpstreamUrl, {
          method: 'POST',
          headers: mode === 'edit'
            ? {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': editMultipart.contentType,
            }
            : {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
          body: requestBody,
          signal: controller.signal,
        }, {
          kind: 'provider',
          providerOnly: true,
          trustedProviderOrigin,
        });
        logImageTiming('response_headers', {
          requestId,
          status: response.status,
          durationMs: durationSince(requestStartedAt),
        });
        const parseStartedAt = nowMs();
        const parsedResponse = await readJsonResponse(
          response,
          mode === 'edit' ? 'UClaw OpenAI image edit failed' : 'UClaw OpenAI image generation failed',
          { requestId, mode, signal: controller.signal },
        );
        const { payload, providerRequestId, responseSummary } = parsedResponse;
        logImageTiming('response_json_parsed', {
          requestId,
          providerRequestId: providerRequestId || null,
          durationMs: durationSince(parseStartedAt),
          responseItems: collectImageResponseEntries(payload).length,
          responseSummary,
        });
        const images = await parseImagesResponse(payload, {
          requestId,
          providerRequestId,
          responseSummary,
          signal: controller.signal,
          trustedProviderOrigin,
          outputMimeType: outputOptions.outputMimeType,
        });
        logImageTiming('request_done', {
          requestId,
          mode,
          totalDurationMs: durationSince(startedAt),
          outputImages: images.length,
        });
        return { images, model: request.model.id };
      } catch (error) {
        logImageTiming('request_failed', {
          requestId,
          mode,
          totalDurationMs: durationSince(startedAt),
          error: sanitizeErrorMessage(error).slice(0, 240),
        });
        throw error;
      } finally {
        clearTimeout(timeout);
        req.signal?.removeEventListener('abort', relayRequestAbort);
      }
    },
  };
}

function registerLifecycleHook(api, name, handler, options) {
  if (typeof api.on === 'function') {
    api.on(name, handler, options);
    return;
  }
  if (typeof api.registerHook === 'function') {
    api.registerHook(name, handler, options);
  }
}

/** Keeps the model-owned image tool call while applying the current UI constraints. */
function registerTurnImagePreferenceHooks(api, config) {
  registerLifecycleHook(api, 'before_prompt_build', async (event, ctx) => {
    const imageOptions = await consumeTurnImageOptions(event, ctx, config);
    if (!imageOptions) return undefined;
    cacheTurnImageOptions(event, ctx, imageOptions);
    return { appendContext: IMAGE_MODE_PROMPT_CONTEXT };
  }, {
    name: `${PROVIDER_ID}:turn-image-preferences`,
    description: 'Consume one composer image preference and retain it for the model-selected image tool call.',
    timeoutMs: 1000,
  });

  registerLifecycleHook(api, 'before_tool_call', (event, ctx) => {
    const toolName = normalizeOptionalString(event?.toolName)?.split(':').at(-1)?.toLowerCase();
    if (toolName !== 'image_generate') return undefined;

    const imageOptions = getTurnImageOptions(event, ctx);
    if (!imageOptions) return undefined;
    return {
      params: {
        ...(event?.params ?? {}),
        model: imageOptions.modelId,
        size: imageOptions.size,
        quality: imageOptions.quality,
      },
    };
  }, {
    name: `${PROVIDER_ID}:turn-image-options`,
    description: 'Apply the managed model, size, and quality to a model-selected image_generate call.',
    priority: 100,
  });
}

export const pluginEntry = definePluginEntry({
  id: PROVIDER_ID,
  name: 'UClaw OpenAI Image',
  description: 'Independent OpenAI-compatible image generation provider managed by UClaw.',
  register(api) {
    const config = resolveRuntimeImageConfig(api.pluginConfig);
    if (!config) {
      api.logger?.warn?.('UClaw image provider disabled because the managed image model catalog is missing or empty');
      return;
    }
    api.registerImageGenerationProvider(buildProvider(config));
    registerTurnImagePreferenceHooks(api, config);
  },
});

export default pluginEntry;
