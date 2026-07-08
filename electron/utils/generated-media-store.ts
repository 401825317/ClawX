import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { getDataDir, getOpenClawMediaDir } from './paths';

const GENERATED_MEDIA_FILE_MODE = 0o644;
const SAVE_ATTEMPTS_PER_DIR = 3;

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export interface SavedGeneratedMedia {
  path: string;
  contentType: string;
  size: number;
}

function normalizeContentType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
}

function normalizeBrandText(value: string): string {
  return value.replace(/clawx/giu, 'UClaw');
}

function safeOriginalName(originalFilename: string | undefined): string {
  const base = normalizeBrandText(basename(originalFilename || '').trim());
  if (!base) return '';
  return base
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function safeExtension(contentType: string, originalFilename: string | undefined): string {
  const fromMime = MIME_EXTENSIONS[normalizeContentType(contentType)];
  if (fromMime) return fromMime;

  const ext = extname(basename(originalFilename || '')).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : '';
}

function buildGeneratedFileName(contentType: string, originalFilename: string | undefined): string {
  const uuid = randomUUID();
  const ext = safeExtension(contentType, originalFilename);
  const original = safeOriginalName(originalFilename);
  if (!original) return `${uuid}${ext}`;

  const originalWithoutExt = original
    .slice(0, Math.max(0, original.length - extname(original).length))
    .replace(/^_+|_+$/g, '');
  return originalWithoutExt ? `${originalWithoutExt}---${uuid}${ext}` : `${uuid}${ext}`;
}

function resolveClawXDataDir(): string {
  return process.env.CLAWX_ELECTRON_STORE_CWD?.trim() || getDataDir();
}

function uniqueCandidateDirs(): string[] {
  return [...new Set([
    join(getOpenClawMediaDir(), 'generated'),
    join(resolveClawXDataDir(), 'generated-media'),
    join(tmpdir(), 'uclaw-generated-media'),
  ])];
}

async function writeVerifiedFile(dir: string, fileName: string, buffer: Buffer): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const finalPath = join(dir, fileName);
  const tempPath = join(dir, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
  let tempExists = false;

  try {
    const handle = await open(tempPath, 'wx', GENERATED_MEDIA_FILE_MODE);
    tempExists = true;
    try {
      await handle.writeFile(buffer);
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    await rename(tempPath, finalPath);
    tempExists = false;

    const saved = await readFile(finalPath);
    if (!saved.equals(buffer)) {
      await rm(finalPath, { force: true }).catch(() => undefined);
      throw new Error('Generated media verification failed after write');
    }

    return finalPath;
  } catch (error) {
    if (tempExists) {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

export async function saveGeneratedMediaBuffer(
  buffer: Buffer,
  contentType: string,
  originalFilename?: string,
): Promise<SavedGeneratedMedia> {
  const errors: unknown[] = [];

  for (const dir of uniqueCandidateDirs()) {
    for (let attempt = 0; attempt < SAVE_ATTEMPTS_PER_DIR; attempt += 1) {
      try {
        const fileName = buildGeneratedFileName(contentType, originalFilename);
        const finalPath = await writeVerifiedFile(dir, fileName, buffer);
        return {
          path: finalPath,
          contentType: normalizeContentType(contentType),
          size: buffer.byteLength,
        };
      } catch (error) {
        errors.push(error);
      }
    }
  }

  throw new AggregateError(errors, 'Generated image was produced but could not be saved to any local media directory');
}
