import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpTurnVideoPreferenceStore } from '../../electron/services/acp-turn-video-preference-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
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
        model: 'grok-image-video',
        resolution: '480P',
        durationSeconds: 6,
      },
    });

    expect(entry).not.toBeNull();
    const preferenceDirectory = join(stateDirectory, 'uclaw-turn-preferences');
    const files = await readdir(preferenceDirectory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^video-turn-/u);
    const stored = JSON.parse(await readFile(join(preferenceDirectory, files[0]!), 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({
      version: 1,
      sessionKey: 'agent:main:session-1',
      messageDigest: createHash('sha256').update(message, 'utf8').digest('hex'),
      videoOptions: {
        model: 'grok-image-video',
        resolution: '480P',
        durationSeconds: 6,
      },
    });
    expect(JSON.stringify(stored)).not.toContain(message);

    await store.discard(entry?.id);
    await expect(readdir(preferenceDirectory)).resolves.toEqual([]);
  });

  it('rejects models, resolutions, and durations outside the managed local contract', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'uclaw-turn-video-preference-'));
    temporaryDirectories.push(stateDirectory);
    const store = createAcpTurnVideoPreferenceStore(stateDirectory);

    await expect(store.enqueue({
      sessionKey: 'agent:main:session-1',
      message: 'Create a video.',
      videoOptions: {
        model: 'unsupported-video-model',
        resolution: '1080P',
        durationSeconds: 30,
      } as never,
    })).resolves.toBeNull();
  });
});
