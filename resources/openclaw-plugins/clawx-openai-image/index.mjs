import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { imageSourceUploadFileName } from 'openclaw/plugin-sdk/image-generation';
import { randomUUID } from 'node:crypto';

const PROVIDER_ID = 'clawx-openai-image';
const DEFAULT_MODEL = 'gpt-image-2';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_SIZE = '1024x1024';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MIME_TYPE = 'image/png';
const MAX_INPUT_IMAGES = 5;

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

function parseImagesResponse(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data.map((entry, index) => {
    const base64 = typeof entry?.b64_json === 'string' ? entry.b64_json.trim() : '';
    if (!base64) return null;
    const mimeType = typeof entry?.mime_type === 'string' && entry.mime_type.trim()
      ? entry.mime_type.trim()
      : DEFAULT_MIME_TYPE;
    const image = {
      buffer: Buffer.from(base64, 'base64'),
      mimeType,
      fileName: `clawx-image-${index + 1}.${imageFileExtensionForMimeType(mimeType)}`,
    };
    if (typeof entry?.revised_prompt === 'string' && entry.revised_prompt.trim()) {
      image.revisedPrompt = entry.revised_prompt.trim();
    }
    return image;
  }).filter(Boolean);
}

async function readJsonResponse(response, failureLabel) {
  const text = await response.text();
  let payload = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`${failureLabel}: invalid JSON response`);
    }
  }
  if (!response.ok) {
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
  const normalizedMimeType = String(mimeType || DEFAULT_MIME_TYPE).trim() || DEFAULT_MIME_TYPE;
  return Buffer.concat([
    multipartHeader(boundary, name, `; filename="${safeName}"`),
    Buffer.from(`Content-Type: ${normalizedMimeType}\r\n\r\n`, 'utf8'),
    Buffer.from(bytes),
    Buffer.from('\r\n', 'utf8'),
  ]);
}

function buildEditMultipart(req, inputImages, model, count) {
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
  inputImages.forEach((image, index) => {
    const fieldName = inputImages.length > 1 ? 'image[]' : 'image';
    const bytes = image.buffer instanceof Uint8Array
      ? Buffer.from(image.buffer.buffer, image.buffer.byteOffset, image.buffer.byteLength)
      : Buffer.from(image.buffer);
    parts.push(multipartFilePart(
      boundary,
      fieldName,
      imageSourceUploadFileName({ image, index }),
      image.mimeType,
      bytes,
    ));
  });
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const body = Buffer.concat(parts);
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: String(body.byteLength),
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
      const inputImages = req.inputImages ?? [];
      if (inputImages.length > MAX_INPUT_IMAGES) {
        throw new Error(`UClaw OpenAI image editing supports up to ${MAX_INPUT_IMAGES} reference images.`);
      }
      const mode = inputImages.length > 0 ? 'edit' : 'generate';
      const providerConfig = resolveProviderConfig(req);
      const apiKey = resolveApiKey(req, providerConfig);
      const model = String(req.model || DEFAULT_MODEL).split('/').pop() || DEFAULT_MODEL;
      const count = resolveCount(req);
      const baseUrl = normalizeRelayBaseUrl(providerConfig.baseUrl, DEFAULT_BASE_URL);
      const editMultipart = mode === 'edit' ? buildEditMultipart(req, inputImages, model, count) : null;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), resolveTimeoutMs(req));
      try {
        const response = await globalThis.fetch(appendImagesPath(baseUrl, mode), {
          method: 'POST',
          headers: mode === 'edit'
            ? {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': editMultipart.contentType,
              'Content-Length': editMultipart.contentLength,
            }
            : {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
          body: mode === 'edit'
            ? editMultipart.body
            : JSON.stringify(buildGenerateBody(req, model, count)),
          signal: controller.signal,
        });
        const payload = await readJsonResponse(
          response,
          mode === 'edit' ? 'UClaw OpenAI image edit failed' : 'UClaw OpenAI image generation failed',
        );
        return { images: parseImagesResponse(payload) };
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
