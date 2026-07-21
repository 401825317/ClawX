import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JPEG_QUALITY_STEPS = [88, 82, 76, 70, 64, 58, 52, 46, 40, 34];
const SCALE_STEPS = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];

function clampQuality(value) {
  return Math.max(20, Math.min(100, Math.round(value)));
}

function uniqueNumbers(values) {
  return [...new Set(values.filter((value) => Number.isFinite(value)))];
}

function normalizeOutputFormat(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'jpg') return 'jpeg';
  return normalized === 'jpeg' || normalized === 'png' || normalized === 'webp'
    ? normalized
    : undefined;
}

function formatForMimeType(value) {
  const normalized = typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
  if (normalized === 'image/jpeg') return 'jpeg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  return undefined;
}

function mimeTypeForFormat(format) {
  return format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
}

function formatFromSharpMetadata(metadata) {
  const normalized = normalizeOutputFormat(metadata?.format);
  return normalized === 'jpeg' || normalized === 'png' || normalized === 'webp'
    ? normalized
    : undefined;
}

function fileNameForFormat(fileName, format) {
  const extension = format === 'jpeg' ? 'jpg' : format;
  const normalized = typeof fileName === 'string' && fileName.trim() ? fileName.trim() : 'generated-image';
  return /\.[^./\\]+$/u.test(normalized)
    ? normalized.replace(/\.[^./\\]+$/u, `.${extension}`)
    : `${normalized}.${extension}`;
}

function deliveryFileExtension(image) {
  const fileName = typeof image?.fileName === 'string' ? image.fileName.trim() : '';
  const fileMatch = fileName.match(/\.(png|jpe?g|webp)$/iu);
  if (fileMatch) return fileMatch[1].toLowerCase().replace('jpeg', 'jpg');
  const format = formatForMimeType(image?.mimeType);
  return format === 'jpeg' ? 'jpg' : format ?? 'bin';
}

function shouldUseLocalTempFallback(error, platform) {
  if (platform !== 'win32') return false;
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  if (['PATH-MISMATCH', 'EACCES', 'EBUSY', 'EIO', 'ENODEV', 'ENOENT', 'EPERM', 'EROFS'].includes(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /(?:path|store directory|fallback target|fallback temp) changed during write|operation not permitted|permission denied|resource busy/iu.test(message);
}

export async function saveGeneratedImageForDelivery(saveMediaBuffer, image, options = {}) {
  try {
    return await saveMediaBuffer(
      image.buffer,
      image.mimeType,
      'tool-image-generation',
      options.maxBytes,
      options.originalFilename || image.fileName,
    );
  } catch (error) {
    const platform = options.platform ?? process.platform;
    if (!shouldUseLocalTempFallback(error, platform)) throw error;

    const outputDir = join(options.tempRoot ?? tmpdir(), 'openclaw', 'tool-image-generation');
    await mkdir(outputDir, { recursive: true });
    const id = `${randomUUID()}.${deliveryFileExtension(image)}`;
    const outputPath = join(outputDir, id);
    await writeFile(outputPath, image.buffer, { flag: 'wx', mode: 0o600 });
    const persisted = await readFile(outputPath);
    if (!persisted.equals(image.buffer)) {
      throw new Error(`Generated image local fallback verification failed: ${outputPath}`, { cause: error });
    }
    console.warn('[uclaw-native-image-delivery] OpenClaw media store write failed; used local temp fallback', {
      code: typeof error?.code === 'string' ? error.code : undefined,
      path: outputPath,
      size: image.buffer.byteLength,
    });
    return {
      id,
      path: outputPath,
      size: image.buffer.byteLength,
      contentType: image.mimeType,
    };
  }
}

function qualitySteps(requested) {
  const preferred = typeof requested === 'number' ? clampQuality(requested) : JPEG_QUALITY_STEPS[0];
  return uniqueNumbers([
    preferred,
    ...JPEG_QUALITY_STEPS.filter((quality) => quality < preferred),
  ]);
}

function dimensionsAtScale(metadata, scale) {
  if (scale >= 1 || !metadata.width || !metadata.height) return undefined;
  return {
    width: Math.max(1, Math.round(metadata.width * scale)),
    height: Math.max(1, Math.round(metadata.height * scale)),
  };
}

async function encodeCandidate(input, format, scale, quality, background) {
  let pipeline = sharp(input, { failOn: 'none' }).rotate();
  const metadata = await pipeline.metadata();
  const dimensions = dimensionsAtScale(metadata, scale);
  if (dimensions) {
    pipeline = pipeline.resize({
      ...dimensions,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  if (format === 'jpeg') {
    if (metadata.hasAlpha || background === 'transparent') {
      pipeline = pipeline.flatten({ background: '#ffffff' });
    }
    return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  if (format === 'webp') {
    return pipeline.webp({ quality, effort: 6, alphaQuality: 100 }).toBuffer();
  }
  return pipeline.png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10 }).toBuffer();
}

export async function normalizeGeneratedImageForDelivery(image, options) {
  const maxBytes = Number(options?.maxBytes);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error('Generated image delivery requires a positive maxBytes value.');
  }
  if (!image?.buffer || !Buffer.isBuffer(image.buffer)) {
    throw new Error('Generated image delivery requires an in-memory image buffer.');
  }

  const requestedFormat = normalizeOutputFormat(options?.outputFormat);
  const metadata = await sharp(image.buffer, { failOn: 'none' }).metadata();
  const declaredSourceFormat = formatForMimeType(image.mimeType);
  const sourceFormat = formatFromSharpMetadata(metadata) ?? declaredSourceFormat;
  const sourceFits = image.buffer.byteLength <= maxBytes;
  if (sourceFits && (!requestedFormat || requestedFormat === sourceFormat)) {
    if (!sourceFormat || declaredSourceFormat === sourceFormat) return image;
    return {
      ...image,
      mimeType: mimeTypeForFormat(sourceFormat),
      fileName: fileNameForFormat(image.fileName, sourceFormat),
      deliveryNormalization: {
        sourceBytes: image.buffer.byteLength,
        outputBytes: image.buffer.byteLength,
        sourceFormat,
        outputFormat: sourceFormat,
        quality: undefined,
        scale: 1,
      },
    };
  }

  const preserveTransparency = options?.background === 'transparent';
  const targetFormat = requestedFormat
    ?? (sourceFormat === 'jpeg' || sourceFormat === 'webp'
      ? sourceFormat
      : preserveTransparency ? 'png' : 'jpeg');
  const qualities = targetFormat === 'png'
    ? [100]
    : qualitySteps(options?.outputCompression);

  let smallestCandidate;
  for (const scale of SCALE_STEPS) {
    for (const quality of qualities) {
      const candidate = await encodeCandidate(image.buffer, targetFormat, scale, quality, options?.background);
      if (!smallestCandidate || candidate.byteLength < smallestCandidate.byteLength) {
        smallestCandidate = candidate;
      }
      if (candidate.byteLength <= maxBytes) {
        return {
          ...image,
          buffer: candidate,
          mimeType: mimeTypeForFormat(targetFormat),
          fileName: fileNameForFormat(image.fileName, targetFormat),
          deliveryNormalization: {
            sourceBytes: image.buffer.byteLength,
            outputBytes: candidate.byteLength,
            sourceFormat,
            outputFormat: targetFormat,
            quality: targetFormat === 'png' ? undefined : quality,
            scale,
          },
        };
      }
    }
  }

  const smallestBytes = smallestCandidate?.byteLength ?? image.buffer.byteLength;
  throw new Error(
    `Generated image could not be normalized below the ${maxBytes}-byte delivery limit `
      + `(source=${image.buffer.byteLength}, smallest=${smallestBytes}).`,
  );
}
