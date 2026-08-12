import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import sharp from 'sharp';

const COMPRESSION_ATTEMPTS = [
  { maxSide: 1600, quality: 76 },
  { maxSide: 1280, quality: 60 },
  { maxSide: 1024, quality: 48 },
  { maxSide: 768, quality: 40 },
  { maxSide: 512, quality: 32 },
] as const;

export const ACP_CHAT_IMAGE_MAX_BYTES = 6 * 1024 * 1024;
export const ACP_CHAT_IMAGE_TOO_LARGE_ERROR_CODE = 'IMAGE_TOO_LARGE' as const;

export type PreparedVideoReferenceImage = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  inputBytes: number;
  outputBytes: number;
  compressed: boolean;
};

export type PreparedAcpChatImage = PreparedVideoReferenceImage;

/** Stable local failure consumed by ACP error normalization and user-facing recovery UI. */
export class AcpChatImageTooLargeError extends Error {
  readonly code = ACP_CHAT_IMAGE_TOO_LARGE_ERROR_CODE;

  constructor() {
    super(`ACP chat image could not be compressed below ${ACP_CHAT_IMAGE_MAX_BYTES} bytes.`);
    this.name = 'AcpChatImageTooLargeError';
  }
}

function jpegFileName(fileName: string | undefined, filePath: string): string {
  const source = fileName?.trim() || basename(filePath) || 'reference-image';
  const extension = extname(source);
  return extension ? `${source.slice(0, -extension.length)}.jpg` : `${source}.jpg`;
}

function byteLimitLabel(maxBytes: number): string {
  if (maxBytes === 1024 * 1024) return '1024 KB';
  return `${maxBytes} ${maxBytes === 1 ? 'byte' : 'bytes'}`;
}

async function prepareImageWithinByteLimit(params: {
  filePath: string;
  fileName?: string;
  mimeType: string;
  maxBytes: number;
  createLimitError: () => Error;
}): Promise<PreparedVideoReferenceImage> {
  // The provider limit applies to source binary bytes, before base64 encoding.
  const inputBytes = (await stat(params.filePath)).size;
  const fileName = params.fileName?.trim() || basename(params.filePath) || 'reference-image';
  if (inputBytes <= params.maxBytes) {
    const input = await readFile(params.filePath);
    return {
      buffer: input,
      fileName,
      mimeType: params.mimeType,
      inputBytes,
      outputBytes: inputBytes,
      compressed: false,
    };
  }

  // Decode from disk in native memory, then reduce dimensions and quality together.
  for (const attempt of COMPRESSION_ATTEMPTS) {
    let output: Buffer;
    try {
      output = await sharp(params.filePath, { failOn: 'none', sequentialRead: true })
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize({
          width: attempt.maxSide,
          height: attempt.maxSide,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: attempt.quality })
        .toBuffer();
    } catch {
      throw params.createLimitError();
    }
    if (output.byteLength > params.maxBytes) continue;

    return {
      buffer: output,
      fileName: jpegFileName(params.fileName, params.filePath),
      mimeType: 'image/jpeg',
      inputBytes,
      outputBytes: output.byteLength,
      compressed: true,
    };
  }

  throw params.createLimitError();
}

/** Prepares one ordinary ACP chat image for the provider's 6 MiB binary limit. */
export async function prepareAcpChatImage(params: {
  filePath: string;
  fileName?: string;
  mimeType: string;
}): Promise<PreparedAcpChatImage> {
  return prepareImageWithinByteLimit({
    ...params,
    maxBytes: ACP_CHAT_IMAGE_MAX_BYTES,
    createLimitError: () => new AcpChatImageTooLargeError(),
  });
}

/** Produces bounded video input bytes without modifying or duplicating the staged source file. */
export async function prepareVideoReferenceImage(params: {
  filePath: string;
  fileName?: string;
  mimeType: string;
  maxBytes: number;
}): Promise<PreparedVideoReferenceImage> {
  return prepareImageWithinByteLimit({
    ...params,
    createLimitError: () => new Error(
      `Video reference image could not be compressed below ${byteLimitLabel(params.maxBytes)}. Choose a smaller image and try again.`,
    ),
  });
}
