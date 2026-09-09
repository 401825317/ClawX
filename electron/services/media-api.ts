import { dialog, nativeImage } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import type { AttachmentFileRef } from '@shared/host-api/contract';
import { resolveOutgoingMediaAttachment, type AttachmentAccess } from './attachment-access';
import { resolveOpenClawStateDir } from '../utils/paths';
import { ACP_INLINE_IMAGE_MAX_DATA_URI_CHARS, base64EncodedLength } from '@shared/chat/media-limits';
import {
  CLAWX_OPENAI_IMAGE_DEFAULT_MODEL,
  CLAWX_OPENAI_IMAGE_PROVIDER_KEY,
} from '../utils/openclaw-image-relay-constants';
import {
  applyOpenAiImageRelaySettings,
  getImageGenerationSettingsSnapshot,
  listImageGenerationProvidersFromRuntime,
  runImageGenerationTest,
  setImageGenerationConfig,
  type ImageGenerationModelConfig,
} from '../utils/openclaw-image-generation';
import { isRecord } from './payload-utils';

type ThumbnailEntry = {
  filePath?: unknown;
  gatewayUrl?: unknown;
  attachmentFileRef?: unknown;
  key?: unknown;
  mimeType?: unknown;
};

type MediaApiDependencies = {
  attachmentAccess?: Pick<AttachmentAccess, 'resolveAttachment' | 'readAttachmentBinary'>;
};

const OPAQUE_ATTACHMENT_KEY = /^[a-f0-9]{64}$/;
const PREVIEW_DIMENSIONS = [512, 384, 256, 192] as const;
const PREVIEW_JPEG_QUALITIES = [82, 70, 58] as const;

type SaveImagePayload = {
  base64?: unknown;
  mimeType?: unknown;
  filePath?: unknown;
  defaultFileName?: unknown;
};

type ImageGenerationSettingsPayload = {
  timeoutMs?: unknown;
  openAiRelayEnabled?: unknown;
  openAiRelayBaseUrl?: unknown;
  openAiRelayModel?: unknown;
  openAiRelayApiKey?: unknown;
};

function asBoundedDataUri(mimeType: string, buffer: Buffer): string | null {
  const prefix = `data:${mimeType};base64,`;
  if (prefix.length + base64EncodedLength(buffer.length) > ACP_INLINE_IMAGE_MAX_DATA_URI_CHARS) return null;
  return `${prefix}${buffer.toString('base64')}`;
}

function generateImagePreviewFromBuffer(buffer: Buffer, mimeType: string): string | null {
  try {
    if (mimeType === 'image/svg+xml') {
      return asBoundedDataUri(mimeType, buffer);
    }
    const img = nativeImage.createFromBuffer(buffer);
    if (img.isEmpty()) return null;
    const size = img.getSize();
    const original = asBoundedDataUri(mimeType, buffer);
    if (original && size.width <= PREVIEW_DIMENSIONS[0] && size.height <= PREVIEW_DIMENSIONS[0]) {
      return original;
    }
    for (const maxDim of PREVIEW_DIMENSIONS) {
      const resized = size.width > maxDim || size.height > maxDim
        ? size.width >= size.height
          ? img.resize({ width: maxDim })
          : img.resize({ height: maxDim })
        : img;
      for (const quality of PREVIEW_JPEG_QUALITIES) {
        const preview = asBoundedDataUri('image/jpeg', resized.toJPEG(quality));
        if (preview) return preview;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function generateImagePreview(filePath: string, mimeType: string): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const buffer = await readFile(filePath);
    return generateImagePreviewFromBuffer(buffer, mimeType);
  } catch {
    return null;
  }
}

function normalizeThumbnailEntries(payload: unknown): ThumbnailEntry[] {
  const value = isRecord(payload) ? payload.paths : payload;
  return Array.isArray(value) ? value as ThumbnailEntry[] : [];
}

export function createMediaApi(dependencies: MediaApiDependencies = {}): CompleteHostServiceRegistry['media'] {
  return {
    thumbnails: async (payload) => {
      const entries = normalizeThumbnailEntries(payload);
      const fsP = await import('node:fs/promises');
      const results: Record<string, { preview: string | null; fileSize: number }> = {};
      for (const entry of entries) {
        const mimeType = typeof entry.mimeType === 'string' ? entry.mimeType : 'application/octet-stream';
        if (entry.attachmentFileRef && typeof entry.attachmentFileRef === 'object') {
          const key = typeof entry.key === 'string' && entry.key ? entry.key : null;
          if (!key || !OPAQUE_ATTACHMENT_KEY.test(key) || !dependencies.attachmentAccess) continue;
          const ref = entry.attachmentFileRef as AttachmentFileRef;
          const resolution = await dependencies.attachmentAccess.resolveAttachment({ ref });
          if (!resolution.ok
            || resolution.identity !== key
            || resolution.target.kind !== 'local') {
            continue;
          }
          const readResult = await dependencies.attachmentAccess.readAttachmentBinary({
            ref,
          });
          if (!readResult.ok) {
            results[key] = { preview: null, fileSize: 0 };
            continue;
          }
          const effectiveMimeType = mimeType === 'application/octet-stream'
            ? readResult.mimeType
            : mimeType;
          const buffer = Buffer.from(
            readResult.data.buffer,
            readResult.data.byteOffset,
            readResult.data.byteLength,
          );
          results[key] = {
            preview: effectiveMimeType.startsWith('image/')
              ? generateImagePreviewFromBuffer(buffer, effectiveMimeType)
              : null,
            fileSize: readResult.size,
          };
          continue;
        }
        if (typeof entry.filePath === 'string' && entry.filePath) {
          try {
            const stat = await fsP.stat(entry.filePath);
            const preview = mimeType.startsWith('image/')
              ? await generateImagePreview(entry.filePath, mimeType)
              : null;
            results[entry.filePath] = { preview, fileSize: stat.size };
          } catch {
            results[entry.filePath] = { preview: null, fileSize: 0 };
          }
          continue;
        }

        if (typeof entry.gatewayUrl === 'string' && entry.gatewayUrl) {
          const resolved = await resolveOutgoingMediaAttachment({
            uri: entry.gatewayUrl,
            stateDir: resolveOpenClawStateDir(),
          });
          if (!resolved) {
            results[entry.gatewayUrl] = { preview: null, fileSize: 0 };
            continue;
          }
          try {
            const stat = await fsP.stat(resolved.path);
            const preview = resolved.mimeType.startsWith('image/')
              ? await generateImagePreview(resolved.path, resolved.mimeType)
              : null;
            results[entry.gatewayUrl] = { preview, fileSize: stat.size };
          } catch {
            results[entry.gatewayUrl] = { preview: null, fileSize: 0 };
          }
        }
      }
      return results;
    },
    saveImage: async (payload) => {
      const body = isRecord(payload) ? payload as SaveImagePayload : {};
      const defaultFileName = typeof body.defaultFileName === 'string' && body.defaultFileName
        ? body.defaultFileName
        : 'image.png';
      const mimeType = typeof body.mimeType === 'string' ? body.mimeType : undefined;
      const ext = defaultFileName.includes('.')
        ? defaultFileName.split('.').pop()!
        : (mimeType?.split('/')[1] || 'png');
      const result = await dialog.showSaveDialog({
        defaultPath: join(homedir(), 'Downloads', defaultFileName),
        filters: [
          { name: 'Images', extensions: [ext, 'png', 'jpg', 'jpeg', 'webp', 'gif'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) return { success: false };

      const fsP = await import('node:fs/promises');
      if (typeof body.filePath === 'string' && body.filePath) {
        try {
          await fsP.access(body.filePath);
          await fsP.copyFile(body.filePath, result.filePath);
        } catch {
          return { success: false, error: 'Source file not found' };
        }
      } else if (typeof body.base64 === 'string' && body.base64) {
        await fsP.writeFile(result.filePath, Buffer.from(body.base64, 'base64'));
      } else {
        return { success: false, error: 'No image data provided' };
      }
      return { success: true, savedPath: result.filePath };
    },
    imageGenerationSettings: async () => ({
      success: true,
      ...(await getImageGenerationSettingsSnapshot()),
    }),
    saveImageGenerationSettings: async (payload) => {
      const body = isRecord(payload) ? payload as ImageGenerationSettingsPayload : {};
      const current = await getImageGenerationSettingsSnapshot();
      const normalizeRelayModel = (value: unknown): string => {
        const raw = typeof value === 'string' && value.trim()
          ? value.trim()
          : (current.openAiRelay.model || CLAWX_OPENAI_IMAGE_DEFAULT_MODEL);
        const slash = raw.indexOf('/');
        return (slash > 0 ? raw.slice(slash + 1) : raw).trim() || CLAWX_OPENAI_IMAGE_DEFAULT_MODEL;
      };
      const relayModel = normalizeRelayModel(body.openAiRelayModel);
      let nextPrimary = current.config.primary;
      if (body.openAiRelayEnabled === true) {
        nextPrimary = `${CLAWX_OPENAI_IMAGE_PROVIDER_KEY}/${relayModel}`;
      } else if (body.openAiRelayEnabled === false) {
        nextPrimary = null;
      }
      const next: ImageGenerationModelConfig = {
        primary: nextPrimary,
        fallbacks: [],
        timeoutMs: body.timeoutMs !== undefined
          ? (typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? Math.floor(body.timeoutMs) : null)
          : current.config.timeoutMs,
      };

      if (typeof body.openAiRelayEnabled === 'boolean') {
        await applyOpenAiImageRelaySettings({
          enabled: body.openAiRelayEnabled,
          baseUrl: typeof body.openAiRelayBaseUrl === 'string' ? body.openAiRelayBaseUrl : null,
          apiKey: typeof body.openAiRelayApiKey === 'string' ? body.openAiRelayApiKey : undefined,
          model: relayModel,
        });
      }

      const config = await setImageGenerationConfig(next);
      return {
        success: true,
        ...(await getImageGenerationSettingsSnapshot()),
        config,
      };
    },
    imageGenerationProviders: async () => ({
      success: true,
      providers: await listImageGenerationProvidersFromRuntime(),
    }),
    testImageGeneration: async (payload) => runImageGenerationTest(isRecord(payload) ? payload : {}),
  };
}
