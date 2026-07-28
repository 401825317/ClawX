import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAcpTurnVideoPreferenceStore } from '../../electron/services/acp-turn-video-preference-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ACP turn video preference store', () => {
  it('stores normalized options with only a message digest and supports failed-prompt cleanup', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'uclaw-turn-video-preference-'));
    temporaryDirectories.push(stateDirectory);
    const store = createAcpTurnVideoPreferenceStore(stateDirectory);
    const message = 'Create a six-second product video.';

    const entry = await store.enqueue({
      sessionKey: 'agent:main:session-1',
      message,
      videoOptions: {
        aspectRatio: '16:9',
        resolution: '480P',
        durationSeconds: 6,
      },
    });

    expect(entry).not.toBeNull();
    const preferenceDirectory = join(stateDirectory, 'media', 'uclaw-turn-preferences');
    const files = await readdir(preferenceDirectory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^video-turn-/u);
    const stored = JSON.parse(await readFile(join(preferenceDirectory, files[0]!), 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({
      version: 1,
      sessionKey: 'agent:main:session-1',
      messageDigest: createHash('sha256').update(message, 'utf8').digest('hex'),
      messageLength: message.length,
      videoOptions: {
        aspectRatio: '16:9',
        resolution: '480P',
        durationSeconds: 6,
      },
    });
    expect(JSON.stringify(stored)).not.toContain(message);

    await store.discard(entry?.id);
    await expect(readdir(preferenceDirectory)).resolves.toEqual([]);
  });

  it('rejects aspect ratios, resolutions, and durations outside the managed local contract', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'uclaw-turn-video-preference-'));
    temporaryDirectories.push(stateDirectory);
    const store = createAcpTurnVideoPreferenceStore(stateDirectory);

    await expect(store.enqueue({
      sessionKey: 'agent:main:session-1',
      message: 'Create a video.',
      videoOptions: {
        aspectRatio: '4:3',
        resolution: '1080P',
        durationSeconds: 30,
      } as never,
    })).resolves.toBeNull();
  });

  it('owns and removes the bounded current-turn reference image', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'uclaw-turn-video-preference-'));
    temporaryDirectories.push(stateDirectory);
    const store = createAcpTurnVideoPreferenceStore(stateDirectory);
    const image = Buffer.from('bounded-reference-image');

    const entry = await store.enqueue({
      sessionKey: 'agent:main:session-1',
      message: 'Animate this image.',
      videoOptions: {
        aspectRatio: '16:9',
        resolution: '480P',
        durationSeconds: 6,
      },
      referenceImage: {
        buffer: image,
        fileName: 'reference.jpg',
        mimeType: 'image/jpeg',
      },
    });

    const preferenceDirectory = join(stateDirectory, 'media', 'uclaw-turn-preferences');
    const files = (await readdir(preferenceDirectory)).sort();
    expect(files).toHaveLength(2);
    const preferenceFile = files.find((fileName) => fileName.startsWith('video-turn-'))!;
    const referenceFile = files.find((fileName) => fileName.startsWith('video-reference-'))!;
    const stored = JSON.parse(
      await readFile(join(preferenceDirectory, preferenceFile), 'utf8'),
    ) as { referenceImage: { filePath: string; fileName: string; mimeType: string } };
    expect(stored.referenceImage).toEqual({
      filePath: join(preferenceDirectory, referenceFile),
      fileName: 'reference.jpg',
      mimeType: 'image/jpeg',
    });
    await expect(readFile(stored.referenceImage.filePath)).resolves.toEqual(image);

    await store.discard(entry?.id);
    await expect(readdir(preferenceDirectory)).resolves.toEqual([]);
  });

  it('expires an unclaimed reference image without waiting for another video turn', async () => {
    vi.useFakeTimers();
    const stateDirectory = await mkdtemp(join(tmpdir(), 'uclaw-turn-video-preference-'));
    temporaryDirectories.push(stateDirectory);
    const store = createAcpTurnVideoPreferenceStore(stateDirectory);

    await store.enqueue({
      sessionKey: 'agent:main:session-1',
      message: 'Animate this image.',
      videoOptions: {
        aspectRatio: '16:9',
        resolution: '480P',
        durationSeconds: 6,
      },
      referenceImage: {
        buffer: Buffer.from('bounded-reference-image'),
        fileName: 'reference.jpg',
        mimeType: 'image/jpeg',
      },
    });

    const preferenceDirectory = join(stateDirectory, 'media', 'uclaw-turn-preferences');
    const files = await readdir(preferenceDirectory);
    expect(files).toHaveLength(2);
    const preferenceFile = files.find((fileName) => fileName.startsWith('video-turn-'))!;
    await rm(join(preferenceDirectory, preferenceFile), { force: true });
    await expect(readdir(preferenceDirectory)).resolves.toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    vi.useRealTimers();

    await expect.poll(() => readdir(preferenceDirectory)).toEqual([]);
  });
});
