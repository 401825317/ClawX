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

type ParsedPortableVersion = {
  core: number[];
  prerelease: string[] | null;
};

// Keep the update identity boundary strict.  A malformed version must not be
// fed into the comparison/fallback filename code where punctuation could
// become a path segment.  A leading `v` is accepted for compatibility with
// older feeds, but the semantic version itself follows the SemVer numeric
// identifier rules.
const PORTABLE_VERSION_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function isValidPortableUpdateVersion(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  const match = PORTABLE_VERSION_PATTERN.exec(text);
  if (!match) return false;
  return !match[4]?.split('.').some((part) => /^0\d+$/u.test(part));
}

/** Parse the SemVer fields used to decide whether a portable update is newer. */
function parsePortableVersion(value: string): ParsedPortableVersion {
  const withoutBuild = value.trim().replace(/^v/i, '').split('+', 1)[0];
  const prereleaseSeparator = withoutBuild.indexOf('-');
  const coreValue = prereleaseSeparator >= 0
    ? withoutBuild.slice(0, prereleaseSeparator)
    : withoutBuild;
  const prereleaseValue = prereleaseSeparator >= 0
    ? withoutBuild.slice(prereleaseSeparator + 1)
    : '';

  return {
    core: coreValue.split('.').map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : 0)),
    prerelease: prereleaseValue ? prereleaseValue.split('.') : null,
  };
}

/** Compare portable package versions using SemVer prerelease ordering. */
export function comparePortableUpdateVersions(leftValue: string, rightValue: string): number {
  const left = parsePortableVersion(leftValue);
  const right = parsePortableVersion(rightValue);
  const coreLength = Math.max(left.core.length, right.core.length);

  for (let index = 0; index < coreLength; index++) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return difference;
  }

  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;

  const prereleaseLength = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < prereleaseLength; index++) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftIsNumber = /^\d+$/.test(leftPart);
    const rightIsNumber = /^\d+$/.test(rightPart);
    if (leftIsNumber && rightIsNumber) {
      return Number.parseInt(leftPart, 10) - Number.parseInt(rightPart, 10);
    }
    if (leftIsNumber) return -1;
    if (rightIsNumber) return 1;
    return leftPart < rightPart ? -1 : 1;
  }

  return 0;
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

  const safeVersion = sanitizePortableUpdateFilename(info.version)
    .replace(/[^A-Za-z0-9.+-]/gu, '-')
    .replace(/\.{2,}/gu, '.')
    .replace(/^\.+|\.+$/gu, '')
    || 'unknown';
  return `UClaw-${safeVersion}-${platform}-${arch}-usb.zip`;
}

export function assertPortableUpdateZipFilename(filename: string): void {
  if (!filename || filename !== basename(filename) || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Portable update filename must be a single safe path segment');
  }
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
  if (typeof info.size !== 'number' || !Number.isSafeInteger(info.size) || info.size <= 0) {
    throw new Error('Portable update size is required and must be a positive integer');
  }
  const expectedSha512 = typeof info.sha512 === 'string' ? info.sha512.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{128}$/u.test(expectedSha512)) {
    throw new Error('Portable update sha512 is required and must be a 128-character hexadecimal digest');
  }

  const file = await stat(filePath);
  if (file.size !== info.size) {
    throw new Error(`Portable update size mismatch: expected ${info.size}, got ${file.size}`);
  }

  await assertZipMagic(filePath);

  const actualSha512 = await calculateFileSha512(filePath);
  if (actualSha512.toLowerCase() !== expectedSha512) {
    throw new Error('Portable update sha512 mismatch');
  }

  return { size: file.size, sha512: actualSha512 };
}
