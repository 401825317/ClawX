import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACP_CHAT_IMAGE_MAX_BYTES,
  AcpChatImageTooLargeError,
  prepareAcpChatImage,
  prepareVideoReferenceImage,
} from '../../electron/utils/video-reference-image';

const temporaryDirectories: string[] = [];

async function writeUncompressedTiff(
  filePath: string,
  width: number,
  height: number,
): Promise<void> {
  await sharp({
    create: { width, height, channels: 3, background: '#4a90e2' },
  }).tiff({ compression: 'none' }).toFile(filePath);
}

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
    const filePath = join(directory, 'large.tiff');
    await writeUncompressedTiff(filePath, 1024, 512);

    const original = await readFile(filePath);
    expect(original.byteLength).toBeGreaterThan(1024 * 1024);
    const result = await prepareVideoReferenceImage({
      filePath,
      fileName: 'large.tiff',
      mimeType: 'image/tiff',
      maxBytes: 1024 * 1024,
    });

    expect(result.compressed).toBe(true);
    expect(result.fileName).toBe('large.jpg');
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.outputBytes).toBeLessThanOrEqual(1024 * 1024);
    expect((await readFile(filePath)).equals(original)).toBe(true);
    await expect(readdir(directory)).resolves.toEqual(['large.tiff']);
  });

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

describe('ACP chat image preparation', () => {
  it('uses original binary bytes instead of base64 size for the 6 MiB limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'uclaw-acp-chat-image-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'base64-larger.tiff');
    await writeUncompressedTiff(filePath, 1600, 1000);

    const original = await readFile(filePath);
    expect(original.byteLength).toBeLessThanOrEqual(ACP_CHAT_IMAGE_MAX_BYTES);
    expect(Buffer.byteLength(original.toString('base64'))).toBeGreaterThan(ACP_CHAT_IMAGE_MAX_BYTES);

    const result = await prepareAcpChatImage({
      filePath,
      fileName: 'base64-larger.tiff',
      mimeType: 'image/tiff',
    });

    expect(result).toMatchObject({
      fileName: 'base64-larger.tiff',
      mimeType: 'image/tiff',
      compressed: false,
      inputBytes: original.byteLength,
      outputBytes: original.byteLength,
    });
    expect(result.buffer.equals(original)).toBe(true);
  });

  it('converts an oversized source to a JPEG below 6 MiB without changing the source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'uclaw-acp-chat-image-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'oversized.tiff');
    await writeUncompressedTiff(filePath, 1600, 1400);

    const original = await readFile(filePath);
    expect(original.byteLength).toBeGreaterThan(ACP_CHAT_IMAGE_MAX_BYTES);

    const result = await prepareAcpChatImage({
      filePath,
      fileName: 'oversized.tiff',
      mimeType: 'image/tiff',
    });

    expect(result).toMatchObject({
      fileName: 'oversized.jpg',
      mimeType: 'image/jpeg',
      inputBytes: original.byteLength,
      compressed: true,
    });
    expect(result.outputBytes).toBeLessThanOrEqual(ACP_CHAT_IMAGE_MAX_BYTES);
    expect((await readFile(filePath)).equals(original)).toBe(true);
    await expect(readdir(directory)).resolves.toEqual(['oversized.tiff']);
  });

  it('throws a stable image-too-large error when an oversized source cannot be compressed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'uclaw-acp-chat-image-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'invalid-image.bin');
    await writeFile(filePath, Buffer.alloc(ACP_CHAT_IMAGE_MAX_BYTES + 1, 0x7f));

    const failure = await prepareAcpChatImage({
      filePath,
      fileName: 'invalid-image.bin',
      mimeType: 'application/octet-stream',
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AcpChatImageTooLargeError);
    expect(failure).toMatchObject({
      name: 'AcpChatImageTooLargeError',
      code: 'IMAGE_TOO_LARGE',
    });
  });
});
