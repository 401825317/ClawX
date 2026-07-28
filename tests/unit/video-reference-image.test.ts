import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareVideoReferenceImage } from '../../electron/utils/video-reference-image';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('video reference image preparation', () => {
  it('keeps an image already inside the byte limit unchanged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'uclaw-video-reference-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'small.png');
    await sharp({
      create: { width: 32, height: 32, channels: 4, background: '#ffffff' },
    }).png().toFile(filePath);

    const original = await readFile(filePath);
    const result = await prepareVideoReferenceImage({
      filePath,
      fileName: 'small.png',
      mimeType: 'image/png',
      maxBytes: 1024 * 1024,
    });

    expect(result).toMatchObject({
      fileName: 'small.png',
      mimeType: 'image/png',
      compressed: false,
      inputBytes: original.byteLength,
      outputBytes: original.byteLength,
    });
    expect(result.buffer).toEqual(original);
  });

  it('returns compressed bytes below 1 MiB without changing or duplicating the staged original', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'uclaw-video-reference-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'large.png');
    const pixels = randomBytes(700 * 700 * 3);
    await sharp(pixels, { raw: { width: 700, height: 700, channels: 3 } }).png().toFile(filePath);

    const original = await readFile(filePath);
    expect(original.byteLength).toBeGreaterThan(1024 * 1024);
    const result = await prepareVideoReferenceImage({
      filePath,
      fileName: 'large.png',
      mimeType: 'image/png',
      maxBytes: 1024 * 1024,
    });

    expect(result.compressed).toBe(true);
    expect(result.fileName).toBe('large.jpg');
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.outputBytes).toBeLessThanOrEqual(1024 * 1024);
    await expect(readFile(filePath)).resolves.toEqual(original);
    await expect(readdir(directory)).resolves.toEqual(['large.png']);
  }, 15_000);

  it('fails clearly when the compressed copy cannot meet the configured limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'uclaw-video-reference-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'tiny-limit.png');
    await sharp({
      create: { width: 64, height: 64, channels: 4, background: '#ff0000' },
    }).png().toFile(filePath);

    await expect(prepareVideoReferenceImage({
      filePath,
      fileName: 'tiny-limit.png',
      mimeType: 'image/png',
      maxBytes: 32,
    })).rejects.toThrow('could not be compressed below 32 bytes');
  });
});
