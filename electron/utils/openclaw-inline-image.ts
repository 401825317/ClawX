import { readFile } from 'node:fs/promises';

export const OPENCLAW_INLINE_IMAGE_SAFE_MAX_BYTES = 2_000_000;
export const OPENCLAW_IMAGE_ATTACHMENT_HARD_MAX_BYTES = 6 * 1024 * 1024;

export const OPENCLAW_VISION_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/bmp',
  'image/webp',
]);

const INLINE_IMAGE_MAX_SIDE_PX = 1600;
const JPEG_QUALITY_STEPS = [86, 78, 70, 62, 54, 46, 38];

export type OpenClawInlineImageAttachment = {
  content: string;
  mimeType: string;
  fileName: string;
};

export type OpenClawInlineImageResult = {
  attachment?: OpenClawInlineImageAttachment;
  inputBytes: number;
  outputBytes?: number;
  outputMimeType?: string;
  resized: boolean;
  skippedReason?: 'resize_failed' | 'above_inline_safe_cap';
};

function toJpegFileName(fileName: string): string {
  const clean = fileName.trim() || 'image';
  return /\.[^./\\]+$/.test(clean) ? clean.replace(/\.[^./\\]+$/, '.jpg') : `${clean}.jpg`;
}

async function resizeImageForOpenClawInline(buffer: Buffer): Promise<Buffer | undefined> {
  let sharpDefault: typeof import('sharp').default;
  try {
    sharpDefault = (await import('sharp')).default;
  } catch {
    return undefined;
  }

  for (const quality of JPEG_QUALITY_STEPS) {
    const resized = await sharpDefault(buffer, { failOn: 'none' })
      .rotate()
      .resize({
        width: INLINE_IMAGE_MAX_SIDE_PX,
        height: INLINE_IMAGE_MAX_SIDE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (resized.byteLength <= OPENCLAW_INLINE_IMAGE_SAFE_MAX_BYTES) {
      return resized;
    }
  }

  return undefined;
}

export async function buildOpenClawInlineImageAttachment(params: {
  filePath: string;
  mimeType: string;
  fileName: string;
}): Promise<OpenClawInlineImageResult> {
  const fileBuffer = await readFile(params.filePath);
  if (fileBuffer.byteLength <= OPENCLAW_INLINE_IMAGE_SAFE_MAX_BYTES) {
    return {
      attachment: {
        content: fileBuffer.toString('base64'),
        mimeType: params.mimeType,
        fileName: params.fileName,
      },
      inputBytes: fileBuffer.byteLength,
      outputBytes: fileBuffer.byteLength,
      outputMimeType: params.mimeType,
      resized: false,
    };
  }

  const resized = await resizeImageForOpenClawInline(fileBuffer).catch(() => undefined);
  if (resized && resized.byteLength <= OPENCLAW_INLINE_IMAGE_SAFE_MAX_BYTES) {
    return {
      attachment: {
        content: resized.toString('base64'),
        mimeType: 'image/jpeg',
        fileName: toJpegFileName(params.fileName),
      },
      inputBytes: fileBuffer.byteLength,
      outputBytes: resized.byteLength,
      outputMimeType: 'image/jpeg',
      resized: true,
    };
  }

  return {
    inputBytes: fileBuffer.byteLength,
    resized: false,
    skippedReason: resized ? 'above_inline_safe_cap' : 'resize_failed',
  };
}
