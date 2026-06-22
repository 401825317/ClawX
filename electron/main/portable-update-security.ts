import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

export interface PortableUpdatePackageMetadata {
  version: string;
  downloadUrl?: string;
  fileName?: string;
  file_name?: string;
  sha512?: string;
  size?: number;
}

export function sanitizePortableUpdateFilename(name: string): string {
  return Array.from(name)
    .map((char) => (char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? '-' : char))
    .join('')
    .trim();
}

function basenameFromUrl(downloadUrl: string): string {
  try {
    const parsed = new URL(downloadUrl);
    return basename(decodeURIComponent(parsed.pathname));
  } catch {
    return basename(downloadUrl);
  }
}

export function filenameFromPortableUpdateInfo(
  info: PortableUpdatePackageMetadata,
  platform: string,
  arch: string,
): string {
  const declaredName = sanitizePortableUpdateFilename(info.fileName || info.file_name || '');
  if (declaredName && extname(declaredName)) {
    return declaredName;
  }

  if (info.downloadUrl) {
    const urlName = sanitizePortableUpdateFilename(basenameFromUrl(info.downloadUrl));
    if (urlName && extname(urlName)) {
      return urlName;
    }
  }

  return `UClaw-${info.version}-${platform}-${arch}-usb.zip`;
}

export function assertPortableUpdateZipFilename(filename: string): void {
  const extension = extname(filename).toLowerCase();
  const blockedExtensions = new Set(['.exe', '.msi', '.dmg', '.pkg', '.appimage', '.deb', '.rpm']);
  if (blockedExtensions.has(extension)) {
    throw new Error(`Portable update package type is not allowed: ${extension}`);
  }
  if (extension !== '.zip') {
    throw new Error('Portable updates must be distributed as .zip packages');
  }
}

export async function calculateFileSha512(filePath: string): Promise<string> {
  const hash = createHash('sha512');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function assertZipMagic(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw new Error('Portable update package is not a valid zip file');
    }
  } finally {
    await handle.close();
  }
}

export async function verifyPortableUpdatePackage(
  filePath: string,
  info: Pick<PortableUpdatePackageMetadata, 'sha512' | 'size'>,
): Promise<{ size: number; sha512: string }> {
  const file = await stat(filePath);
  if (info.size && info.size > 0 && file.size !== info.size) {
    throw new Error(`Portable update size mismatch: expected ${info.size}, got ${file.size}`);
  }

  const expectedSha512 = info.sha512?.trim().toLowerCase();
  if (!expectedSha512) {
    throw new Error('Portable update sha512 is required');
  }

  await assertZipMagic(filePath);

  const actualSha512 = await calculateFileSha512(filePath);
  if (actualSha512.toLowerCase() !== expectedSha512) {
    throw new Error('Portable update sha512 mismatch');
  }

  return { size: file.size, sha512: actualSha512 };
}
