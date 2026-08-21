import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedClientVideoModelPolicy } from '../../shared/managed-client-config';
import { createAcpTurnVideoPreferenceStore } from '../../electron/services/acp-turn-video-preference-store';

const temporaryDirectories: string[] = [];
const VIDEO_POLICY = {
  defaultModel: 'future-video-model',
  defaultSize: '3072x1728',
  defaultAspectRatio: '16:9',
  defaultResolution: '1728P',
  defaultDurationSeconds: 17,
  models: [{
    id: 'future-video-model',
    modes: ['text-to-video', 'image-to-video'],
    sizes: ['3072x1728'],
    aspectRatios: ['16:9'],
    resolutions: ['1728P'],
    durations: [17],
    defaultSize: '3072x1728',
    defaultAspectRatio: '16:9',
    defaultResolution: '1728P',
    defaultDurationSeconds: 17,
    requiresImage: false,
  }],
} satisfies ManagedClientVideoModelPolicy;

const resolveVideoPolicy = async () => VIDEO_POLICY;

const TEXT_TO_VIDEO_OPTIONS = {
  modelId: 'future-video-model',
  size: '3072x1728',
  mode: 'text-to-video',
  aspectRatio: '16:9',
  resolution: '1728P',
  durationSeconds: 17,
} as const;

const IMAGE_TO_VIDEO_OPTIONS = {
  ...TEXT_TO_VIDEO_OPTIONS,
  mode: 'image-to-video',
} as const;

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ACP turn video preference store', () => {
  it('stores normalized options with only a message digest and supports failed-prompt cleanup', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'uclaw-turn-video-preference-'));
    temporaryDirectories.push(stateDirectory);
    const store = createAcpTurnVideoPreferenceStore(stateDirectory, resolveVideoPolicy);
    const message = 'Create a six-second product video.';

    const entry = await store.enqueue({
      sessionKey: 'agent:main:session-1',
      message,
      videoOptions: TEXT_TO_VIDEO_OPTIONS,
    });

    expect(entry).not.toBeNull();
    const preferenceDirectory = join(stateDirectory, 'media', 'uclaw-turn-preferences');
    const files = await readdir(preferenceDirectory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^video-turn-/u);
    const stored = JSON.parse(await readFile(join(preferenceDirectory, files[0]!), 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({
      version: 2,
      sessionKey: 'agent:main:session-1',
      messageDigest: createHash('sha256').update(message, 'utf8').digest('hex'),
      messageLength: message.length,
      videoOptions: TEXT_TO_VIDEO_OPTIONS,
    });
    expect(JSON.stringify(stored)).not.toContain(message);

    await store.discard(entry?.id);
    await expect(readdir(preferenceDirectory)).resolves.toEqual([]);
  });

  it('rejects aspect ratios, resolutions, and durations outside the managed local contract', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'uclaw-turn-video-preference-'));
    temporaryDirectories.push(stateDirectory);
    const store = createAcpTurnVideoPreferenceStore(stateDirectory, resolveVideoPolicy);

    await expect(store.enqueue({
      sessionKey: 'agent:main:session-1',
      message: 'Create a video.',
      videoOptions: {
        ...TEXT_TO_VIDEO_OPTIONS,
        aspectRatio: '4:3',
        resolution: '1080P',
        durationSeconds: 30,
      },
    })).resolves.toBeNull();

    await expect(store.enqueue({
      sessionKey: 'agent:main:session-1',
      message: 'Create a video.',
      videoOptions: {
        ...TEXT_TO_VIDEO_OPTIONS,
        resolution: '1080P',
      },
    })).resolves.toBeNull();
  });

  it('rejects a declared resolution that does not match the exact declared size', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'uclaw-turn-video-preference-'));
    temporaryDirectories.push(stateDirectory);
    const mismatchedPolicy = {
      ...VIDEO_POLICY,
      models: [{
        ...VIDEO_POLICY.models[0],
        resolutions: ['1728P', '720P'],
      }],
    } satisfies ManagedClientVideoModelPolicy;
    const store = createAcpTurnVideoPreferenceStore(stateDirectory, async () => mismatchedPolicy);

    await expect(store.enqueue({
      sessionKey: 'agent:main:session-1',
      message: 'Create a video.',
      videoOptions: { ...TEXT_TO_VIDEO_OPTIONS, resolution: '720P' },
    })).resolves.toBeNull();
    await expect(readdir(join(stateDirectory, 'media', 'uclaw-turn-preferences'))).rejects.toThrow();
  });

  it('fails closed when the managed policy is unavailable', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'uclaw-turn-video-preference-'));
    temporaryDirectories.push(stateDirectory);
    const store = createAcpTurnVideoPreferenceStore(stateDirectory, async () => null);

    await expect(store.enqueue({
      sessionKey: 'agent:main:session-1',
      message: 'Create a video.',
      videoOptions: TEXT_TO_VIDEO_OPTIONS,
    })).resolves.toBeNull();
  });

  it('owns and removes the bounded current-turn reference image', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'uclaw-turn-video-preference-'));
    temporaryDirectories.push(stateDirectory);
    const store = createAcpTurnVideoPreferenceStore(stateDirectory, resolveVideoPolicy);
    const image = Buffer.from('bounded-reference-image');

    const entry = await store.enqueue({
      sessionKey: 'agent:main:session-1',
      message: 'Animate this image.',
      videoOptions: IMAGE_TO_VIDEO_OPTIONS,
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
    const store = createAcpTurnVideoPreferenceStore(stateDirectory, resolveVideoPolicy);

    await store.enqueue({
      sessionKey: 'agent:main:session-1',
      message: 'Animate this image.',
      videoOptions: IMAGE_TO_VIDEO_OPTIONS,
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
