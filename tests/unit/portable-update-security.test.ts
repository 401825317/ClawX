import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  assertPortableUpdateZipFilename,
  filenameFromPortableUpdateInfo,
  sanitizePortableUpdateFilename,
  verifyPortableUpdatePackage,
} from '@electron/main/portable-update-security';

describe('portable update package security', () => {
  it('prefers a sanitized backend file name', () => {
    expect(filenameFromPortableUpdateInfo({
      version: '0.5.0',
      fileName: '..\\UClaw:0.5.0?.zip',
      downloadUrl: 'https://example.com/bad.exe',
    }, 'win', 'x64')).toBe('..-UClaw-0.5.0-.zip');
  });

  it('falls back to a deterministic USB zip file name', () => {
    expect(filenameFromPortableUpdateInfo({ version: '0.5.0' }, 'win', 'x64'))
      .toBe('UClaw-0.5.0-win-x64-usb.zip');
  });

  it('rejects non-zip portable update packages', () => {
    expect(() => assertPortableUpdateZipFilename('UClaw-0.5.0-win-x64.exe'))
      .toThrow(/not allowed/);
    expect(() => assertPortableUpdateZipFilename('UClaw-0.5.0-win-x64.7z'))
      .toThrow(/\.zip/);
  });

  it('verifies package size and sha512', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uclaw-update-security-'));
    try {
      const filePath = join(dir, 'UClaw.zip');
      const content = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
      await writeFile(filePath, content);
      const sha512 = createHash('sha512').update(content).digest('hex');

      await expect(verifyPortableUpdatePackage(filePath, {
        size: content.length,
        sha512,
      })).resolves.toMatchObject({ size: content.length, sha512 });

      await expect(verifyPortableUpdatePackage(filePath, {
        size: content.length + 1,
        sha512,
      })).rejects.toThrow(/size mismatch/);

      await expect(verifyPortableUpdatePackage(filePath, {
        size: content.length,
        sha512: 'bad',
      })).rejects.toThrow(/sha512 mismatch/);

      const notZipPath = join(dir, 'not-zip.zip');
      const notZip = Buffer.from('not a zip');
      await writeFile(notZipPath, notZip);
      await expect(verifyPortableUpdatePackage(notZipPath, {
        size: notZip.length,
        sha512: createHash('sha512').update(notZip).digest('hex'),
      })).rejects.toThrow(/valid zip/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('removes path separators and control characters from filenames', () => {
    expect(sanitizePortableUpdateFilename('dir/UClaw\u0000*.zip')).toBe('dir-UClaw--.zip');
  });
});
