// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPortableUpdateZipFilename,
  comparePortableUpdateVersions,
  filenameFromPortableUpdateInfo,
  sanitizePortableUpdateFilename,
  verifyPortableUpdatePackage,
} from '@electron/main/portable-update-security';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('portable update package security', () => {
  it('orders stable and prerelease versions using SemVer rules', () => {
    expect(comparePortableUpdateVersions('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0);
    expect(comparePortableUpdateVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0);
    expect(comparePortableUpdateVersions('1.0.0-beta.1', '1.0.0-beta')).toBeGreaterThan(0);
    expect(comparePortableUpdateVersions('v1.2.3+build.5', '1.2.3+build.4')).toBe(0);
    expect(comparePortableUpdateVersions('1.2.4', '1.2.3')).toBeGreaterThan(0);
  });

  it('sanitizes server filenames and falls back to the UClaw USB contract', () => {
    expect(sanitizePortableUpdateFilename('../UClaw:1.2.3?.zip')).toBe('..-UClaw-1.2.3-.zip');
    expect(filenameFromPortableUpdateInfo(
      { version: '1.2.3', downloadUrl: 'https://download.test/releases/UClaw-1.2.3-win-x64-usb.zip' },
      'win',
      'x64',
    )).toBe('UClaw-1.2.3-win-x64-usb.zip');
    expect(filenameFromPortableUpdateInfo({ version: '1.2.3' }, 'win', 'x64'))
      .toBe('UClaw-1.2.3-win-x64-usb.zip');
  });

  it('rejects executable and non-ZIP update packages', () => {
    expect(() => assertPortableUpdateZipFilename('UClaw-update.exe')).toThrow(/not allowed/i);
    expect(() => assertPortableUpdateZipFilename('UClaw-update.tar')).toThrow(/\.zip/i);
    expect(() => assertPortableUpdateZipFilename('UClaw-update.zip')).not.toThrow();
  });

  it('verifies ZIP signature, exact size, and SHA-512 before installation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uclaw-portable-update-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'UClaw-1.2.3-win-x64-usb.zip');
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03]);
    await writeFile(filePath, bytes);
    const sha512 = createHash('sha512').update(bytes).digest('hex');

    await expect(verifyPortableUpdatePackage(filePath, { size: bytes.length, sha512 }))
      .resolves.toEqual({ size: bytes.length, sha512 });
    await expect(verifyPortableUpdatePackage(filePath, { size: bytes.length + 1, sha512 }))
      .rejects.toThrow(/size mismatch/i);
    await expect(verifyPortableUpdatePackage(filePath, { size: bytes.length, sha512: '0'.repeat(128) }))
      .rejects.toThrow(/sha512 mismatch/i);
  });

  it('rejects a file with the correct hash but no ZIP signature', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uclaw-portable-update-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'not-a-zip.zip');
    const bytes = Buffer.from('not a zip file');
    await writeFile(filePath, bytes);
    const sha512 = createHash('sha512').update(bytes).digest('hex');

    await expect(verifyPortableUpdatePackage(filePath, { size: bytes.length, sha512 }))
      .rejects.toThrow(/not a valid zip/i);
  });
});
