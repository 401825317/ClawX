import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { imageSourceUploadFileName } from 'openclaw/plugin-sdk/image-generation';
import { randomUUID } from 'node:crypto';
import { Agent, fetch as undiciFetch } from 'undici';

const PROVIDER_ID = 'clawx-openai-image';
const DEFAULT_MODEL = 'gpt-image-2';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_SIZE = '1024x1024';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MIME_TYPE = 'image/png';
const MAX_INPUT_IMAGES = 5;
const MAX_UPSTREAM_DIAGNOSTIC_CHARS = 1000;
const imageFetchDispatcher = new Agent({
  headersTimeout: DEFAULT_TIMEOUT_MS,
  bodyTimeout: DEFAULT_TIMEOUT_MS,
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

function resolveProviderConfig(req) {
  return req.cfg?.models?.providers?.[PROVIDER_ID] ?? {};
}

function resolveApiKey(req, providerConfig) {
  const apiKey = String(providerConfig.apiKey || req.apiKey || '').trim();
  if (!apiKey) {
    throw new Error('UClaw OpenAI image API key missing');
  }
  return apiKey;
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
  if (error instanceof Error) return error.message;
  return String(error || 'unknown error');
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
    .replace(/https?:\/\/[^\s"']*(?:access_token|api_key|token|signature|x-amz-signature)[^\s"']*/giu, '[REDACTED_URL]');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...[truncated ${text.length - maxChars} chars]`;
}

function optionalDiagnosticText(value, maxChars) {
  if (value === undefined || value === null) return null;
  const text = sanitizeDiagnosticText(value, maxChars).trim();
  return text || null;
}

function logImageTiming(event, details = {}) {
  console.error(`[clawx-openai-image] ${event} ${JSON.stringify(details)}`);
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

function parseDataUrlImage(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/iu);
  if (!match) return null;
  const mimeType = normalizeMimeType(match[1]) || DEFAULT_MIME_TYPE;
  return {
    buffer: Buffer.from(match[2], 'base64'),
    mimeType,
  };
}

async function fetchImageUrl(url, context = {}) {
  const startedAt = nowMs();
  const trimmed = String(url || '').trim();
  if (!trimmed) return null;
  const dataImage = parseDataUrlImage(trimmed);
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
  if (!/^https?:\/\//iu.test(trimmed)) {
    throw new Error(`UClaw OpenAI image response returned unsupported image URL: ${trimmed.slice(0, 80)}`);
  }
  const parsedUrl = new URL(trimmed);
  logImageTiming('image_url_fetch_start', {
    requestId: context.requestId,
    index: context.index,
    host: parsedUrl.host,
    path: parsedUrl.pathname,
  });
  try {
    const response = await undiciFetch(trimmed, {
      method: 'GET',
      dispatcher: imageFetchDispatcher,
    });
    if (!response.ok) {
      throw new Error(`UClaw OpenAI image URL fetch failed: HTTP ${response.status}`);
    }
    const contentType = normalizeMimeType(response.headers.get('content-type')) || DEFAULT_MIME_TYPE;
    const buffer = Buffer.from(await response.arrayBuffer());
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
    throw error;
  }
}

async function parseImagesResponse(payload, context = {}) {
  const startedAt = nowMs();
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const images = await Promise.all(data.map(async (entry, index) => {
    const itemStartedAt = nowMs();
    const base64 = typeof entry?.b64_json === 'string' ? entry.b64_json.trim() : '';
    const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
    const fetched = base64
      ? {
        buffer: Buffer.from(base64, 'base64'),
        mimeType: typeof entry?.mime_type === 'string' && entry.mime_type.trim()
          ? entry.mime_type.trim()
          : DEFAULT_MIME_TYPE,
      }
      : await fetchImageUrl(url, { requestId: context.requestId, index });
    if (!fetched) return null;
    logImageTiming('image_payload_decoded', {
      requestId: context.requestId,
      index,
      source: base64 ? 'b64_json' : 'url',
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
  }));
  const parsedImages = images.filter(Boolean);
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
  logImageTiming('response_error', {
    requestId: context.requestId || null,
    mode: context.mode || null,
    status: response.status,
    statusText: response.statusText || null,
    upstreamMessage: optionalDiagnosticText(errorRecord.message || payload?.message, 500),
    upstreamType: optionalDiagnosticText(errorRecord.type || payload?.type, 160),
    upstreamCode: optionalDiagnosticText(errorRecord.code || payload?.code, 160),
    upstreamParam: optionalDiagnosticText(errorRecord.param || payload?.param, 160),
    responseBody: optionalDiagnosticText(text, MAX_UPSTREAM_DIAGNOSTIC_CHARS),
  });
}

async function readJsonResponse(response, failureLabel, context = {}) {
  const text = await response.text();
  let payload = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) {
        logUpstreamResponseError(response, text, null, context);
        throw new Error(`${failureLabel}: HTTP ${response.status}`);
      }
      throw new Error(`${failureLabel}: invalid JSON response`);
    }
  }
  if (!response.ok) {
    logUpstreamResponseError(response, text, payload, context);
    const message = payload?.error?.message || payload?.message || text || `HTTP ${response.status}`;
    throw new Error(`${failureLabel}: ${message}`);
  }
  return payload;
}

function buildGenerateBody(req, model, count) {
  return {
    model,
    prompt: req.prompt,
    n: count,
    size: req.size ?? DEFAULT_SIZE,
    ...(req.quality ? { quality: req.quality } : {}),
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

function buildEditMultipart(req, editImages, model, count) {
  const boundary = `uclaw-openai-image-${randomUUID()}`;
  const parts = [
    multipartTextPart(boundary, 'model', model),
    multipartTextPart(boundary, 'prompt', req.prompt),
    multipartTextPart(boundary, 'n', String(count)),
    multipartTextPart(boundary, 'size', req.size ?? DEFAULT_SIZE),
  ];
  if (req.quality) {
    parts.push(multipartTextPart(boundary, 'quality', req.quality));
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

function buildProvider() {
  return {
    id: PROVIDER_ID,
    label: 'UClaw OpenAI Images',
    defaultModel: DEFAULT_MODEL,
    models: [DEFAULT_MODEL],
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: MAX_INPUT_IMAGES,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [
          '1024x1024',
          '1536x1024',
          '1024x1536',
          '2048x2048',
          '2048x1152',
          '3840x2160',
          '2160x3840',
        ],
      },
      output: {
        qualities: ['low', 'medium', 'high'],
        formats: [],
        backgrounds: [],
      },
    },
    isConfigured: ({ cfg }) => Boolean(String(cfg?.models?.providers?.[PROVIDER_ID]?.apiKey || '').trim()),
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
      const apiKey = resolveApiKey(req, providerConfig);
      const model = String(req.model || DEFAULT_MODEL).split('/').pop() || DEFAULT_MODEL;
      const count = resolveCount(req);
      const baseUrl = normalizeRelayBaseUrl(providerConfig.baseUrl, DEFAULT_BASE_URL);
      const editMultipart = mode === 'edit' ? buildEditMultipart(req, editImages, model, count) : null;
      const upstreamUrl = appendImagesPath(baseUrl, mode);
      const upstreamPath = new URL(upstreamUrl).pathname;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), resolveTimeoutMs(req));
      try {
        const requestBody = mode === 'edit'
          ? editMultipart.body
          : JSON.stringify(buildGenerateBody(req, model, count));
        logImageTiming('request_start', {
          requestId,
          mode,
          inputImageCount: inputImages.length,
          model,
          path: upstreamPath,
          count,
          size: req.size ?? DEFAULT_SIZE,
          quality: req.quality || null,
          requestBodyBytes: Buffer.byteLength(requestBody),
        });
        const requestStartedAt = nowMs();
        const response = await undiciFetch(upstreamUrl, {
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
          dispatcher: imageFetchDispatcher,
        });
        logImageTiming('response_headers', {
          requestId,
          status: response.status,
          durationMs: durationSince(requestStartedAt),
        });
        const parseStartedAt = nowMs();
        const payload = await readJsonResponse(
          response,
          mode === 'edit' ? 'UClaw OpenAI image edit failed' : 'UClaw OpenAI image generation failed',
          { requestId, mode },
        );
        logImageTiming('response_json_parsed', {
          requestId,
          durationMs: durationSince(parseStartedAt),
          responseItems: Array.isArray(payload?.data) ? payload.data.length : 0,
        });
        const images = await parseImagesResponse(payload, { requestId });
        logImageTiming('request_done', {
          requestId,
          mode,
          totalDurationMs: durationSince(startedAt),
          outputImages: images.length,
        });
        return { images };
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
      }
    },
  };
}

export const pluginEntry = definePluginEntry({
  id: PROVIDER_ID,
  name: 'UClaw OpenAI Image',
  description: 'Independent OpenAI-compatible image generation provider managed by UClaw.',
  register(api) {
    api.registerImageGenerationProvider(buildProvider());
  },
});

export default pluginEntry;
