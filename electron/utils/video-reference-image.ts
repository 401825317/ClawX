import { open, type FileHandle } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { Transform } from 'node:stream';
import sharp from 'sharp';

const COMPRESSION_ATTEMPTS = [
  { maxSide: 1600, quality: 76 },
  { maxSide: 1280, quality: 60 },
  { maxSide: 1024, quality: 48 },
  { maxSide: 768, quality: 40 },
  { maxSide: 512, quality: 32 },
] as const;

/**
 * Do not let an image upload turn into an unbounded native decode.  The
 * provider limits below are deliberately much smaller, but this separate
 * source cap also protects the compression path when a caller gives us a
 * malformed or unexpectedly huge file.
 */
export const IMAGE_SOURCE_MAX_BYTES = 64 * 1024 * 1024;
/**
 * libvips allocates working buffers from native memory.  Keep the pixel limit
 * explicit instead of relying on sharp's much larger default (268 MP).
 */
export const IMAGE_SOURCE_MAX_PIXELS = 25_000_000;
const FILE_READ_CHUNK_BYTES = 64 * 1024;

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

type BoundedFileRead = {
  handle: FileHandle;
  inputBytes: number;
  buffer: Buffer | null;
  sourceTooLarge: boolean;
};

/**
 * Read only enough bytes to decide whether the source already fits.  Opening
 * one handle and reading from it removes the old stat(path) -> readFile(path)
 * TOCTOU window and, importantly, never allocates a buffer proportional to an
 * untrusted file size.
 */
async function readFileUpToLimit(filePath: string, maxBytes: number): Promise<BoundedFileRead> {
  const handle = await open(filePath, 'r');
  try {
    const sourceStat = await handle.stat();
    const declaredBytes = Number.isSafeInteger(sourceStat.size) && sourceStat.size >= 0
      ? sourceStat.size
      : 0;
    if (declaredBytes > IMAGE_SOURCE_MAX_BYTES) {
      return { handle, inputBytes: declaredBytes, buffer: null, sourceTooLarge: true };
    }

    const safeLimit = Number.isFinite(maxBytes) && maxBytes > 0
      ? Math.floor(maxBytes)
      : 0;
    // The extra byte distinguishes exactly-at-limit files from files that
    // grew after the initial stat.  The hard source cap keeps this allocation
    // bounded even if a caller passes an accidental Infinity/very large limit.
    const probeBytes = Math.min(safeLimit + 1, IMAGE_SOURCE_MAX_BYTES + 1);
    // One bounded probe buffer avoids the chunk-array + Buffer.concat double
    // allocation that used to briefly duplicate a large upload in JS memory.
    const probe = Buffer.allocUnsafe(probeBytes);
    let bytesRead = 0;
    while (bytesRead < probeBytes) {
      const readLength = Math.min(FILE_READ_CHUNK_BYTES, probeBytes - bytesRead);
      const result = await handle.read(probe, bytesRead, readLength, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }

    const latestStat = await handle.stat();
    const latestBytes = Number.isSafeInteger(latestStat.size) && latestStat.size >= 0
      ? latestStat.size
      : bytesRead;
    if (latestBytes > IMAGE_SOURCE_MAX_BYTES) {
      return { handle, inputBytes: latestBytes, buffer: null, sourceTooLarge: true };
    }

    const fits = bytesRead <= safeLimit && bytesRead < probeBytes;
    if (fits) {
      return {
        handle,
        inputBytes: bytesRead,
        buffer: probe.subarray(0, bytesRead),
        sourceTooLarge: false,
      };
    }

    return {
      handle,
      // Prefer the file metadata for diagnostics, but never report less than
      // the bytes we actually observed when the file changed during the read.
      inputBytes: Math.max(declaredBytes, latestBytes, bytesRead),
      buffer: null,
      sourceTooLarge: false,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Feed sharp from an already-open descriptor instead of making it resolve the
 * path again. Besides avoiding another path TOCTOU window, the bounded stream
 * prevents an untrusted file from becoming an unbounded JavaScript/native
 * allocation inside the compression path.
 */
async function compressImageFromFile(
  handle: FileHandle,
  attempt: (typeof COMPRESSION_ATTEMPTS)[number],
): Promise<Buffer> {
  let source: ReturnType<typeof handle.createReadStream> | null = null;
  let boundedSource: Transform | null = null;
  try {
    const sourceStat = await handle.stat();
    if (sourceStat.size > IMAGE_SOURCE_MAX_BYTES) {
      throw new Error('Image source exceeds the local safety limit.');
    }

    source = handle.createReadStream({
      autoClose: false,
      highWaterMark: FILE_READ_CHUNK_BYTES,
      // Always rewind the shared descriptor and cap the stream itself.  The
      // bounded probe above advances the file position; an explicit range
      // prevents compression from starting at that probe offset or reading a
      // file that grows after the initial stat.
      start: 0,
      end: IMAGE_SOURCE_MAX_BYTES - 1,
    });
    let streamedBytes = 0;
    boundedSource = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        streamedBytes += chunk.byteLength;
        if (streamedBytes > IMAGE_SOURCE_MAX_BYTES) {
          callback(new Error('Image source exceeds the local safety limit.'));
          return;
        }
        callback(null, chunk);
      },
    });
    const transformer = sharp({
      failOn: 'none',
      sequentialRead: true,
      // Keep libvips' native decode bounded for huge dimensions, including
      // decompression-bomb style PNG/TIFF/SVG inputs.
      limitInputPixels: IMAGE_SOURCE_MAX_PIXELS,
      pages: 1,
      animated: false,
      unlimited: false,
    })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({
        width: attempt.maxSide,
        height: attempt.maxSide,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: attempt.quality });

    const sourceError = new Promise<never>((_resolve, reject) => {
      source?.once('error', reject);
      boundedSource?.once('error', reject);
      transformer.once('error', reject);
    });
    // `Promise.race` may settle from libvips before a delayed stream error;
    // consume it so an already-destroyed stream cannot surface an unhandled
    // rejection after the caller has received its bounded result.
    sourceError.catch(() => undefined);
    const output = transformer.toBuffer();
    source.pipe(boundedSource).pipe(transformer);
    return await Promise.race([output, sourceError]);
  } finally {
    source?.destroy();
    boundedSource?.destroy();
  }
}

async function prepareImageWithinByteLimit(params: {
  filePath: string;
  fileName?: string;
  mimeType: string;
  maxBytes: number;
  createLimitError: () => Error;
}): Promise<PreparedVideoReferenceImage> {
  // The provider limit applies to source binary bytes, before base64 encoding.
  const boundedRead = await readFileUpToLimit(params.filePath, params.maxBytes);
  const inputBytes = boundedRead.inputBytes;
  const fileName = params.fileName?.trim() || basename(params.filePath) || 'reference-image';
  try {
    if (boundedRead.sourceTooLarge) throw params.createLimitError();
    if (boundedRead.buffer) {
      const input = boundedRead.buffer;
      return {
        buffer: input,
        fileName,
        mimeType: params.mimeType,
        inputBytes,
        outputBytes: input.byteLength,
        compressed: false,
      };
    }

    // Decode from the already-open source in native memory, then reduce
    // dimensions and quality together.
    for (const attempt of COMPRESSION_ATTEMPTS) {
      let output: Buffer;
      try {
        output = await compressImageFromFile(boundedRead.handle, attempt);
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
  } finally {
    await boundedRead.handle.close().catch(() => undefined);
  }
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
