import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ManagedClientImageModelPolicy } from '../../shared/managed-client-config';
import { createAcpTurnImagePreferenceStore } from '../../electron/services/acp-turn-image-preference-store';

const temporaryDirectories: string[] = [];
const FUTURE_IMAGE_POLICY: ManagedClientImageModelPolicy = {
  defaultModel: 'future-image-model',
  defaultSize: '2048x3072',
  defaultQuality: 'ultra',
  models: [{
    id: 'future-image-model',
    sizes: ['2048x3072', '3072x2048'],
    qualities: ['studio', 'ultra'],
    defaultSize: '2048x3072',
    defaultQuality: 'ultra',
    supportsEditing: true,
  }],
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Acp turn image preference store', () => {
  it('stores only a message digest and removes the preference after a failed ACP prompt', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'clawx-turn-image-preference-'));
    temporaryDirectories.push(stateDirectory);
    const store = createAcpTurnImagePreferenceStore(stateDirectory, {
      resolvePolicy: () => FUTURE_IMAGE_POLICY,
    });
    const message = 'Create a blue coffee cup on a white table.';

    const entry = await store.enqueue({
      sessionKey: 'agent:main:session-1',
      message,
      imageOptions: {
        modelId: 'future-image-model',
        size: '3072x2048',
        quality: 'ultra',
      },
    });

    expect(entry).not.toBeNull();
    const preferenceDirectory = join(stateDirectory, 'uclaw-turn-preferences');
    const files = await readdir(preferenceDirectory);
    expect(files).toHaveLength(1);
    const stored = JSON.parse(await readFile(join(preferenceDirectory, files[0]!), 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({
      version: 2,
      sessionKey: 'agent:main:session-1',
      messageDigest: createHash('sha256').update(message, 'utf8').digest('hex'),
      messageLength: message.length,
      imageOptions: {
        modelId: 'future-image-model',
        size: '3072x2048',
        quality: 'ultra',
      },
    });
    expect(JSON.stringify(stored)).not.toContain(message);

    await store.discard(entry?.id);
    await expect(readdir(preferenceDirectory)).resolves.toEqual([]);
  });

  it('fails closed for a null, empty, invalid, or unavailable verified policy', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'clawx-turn-image-preference-'));
    temporaryDirectories.push(stateDirectory);
    const resolvers = [
      () => null,
      () => ({ defaultModel: '', defaultSize: '', defaultQuality: '', models: [] }),
      () => ({
        ...FUTURE_IMAGE_POLICY,
        defaultSize: 'size-not-owned-by-the-default-model',
      }),
      () => { throw new Error('verified policy unavailable'); },
    ];

    for (const resolvePolicy of resolvers) {
      const store = createAcpTurnImagePreferenceStore(stateDirectory, {
        resolvePolicy: resolvePolicy as () => ManagedClientImageModelPolicy | null,
      });
      await expect(store.enqueue({
        sessionKey: 'agent:main:session-1',
        message: 'Create an image.',
        imageOptions: {
          modelId: 'future-image-model',
          size: '3072x2048',
          quality: 'ultra',
        },
      })).resolves.toBeNull();
    }
    await expect(readdir(join(stateDirectory, 'uclaw-turn-preferences'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires model, exact size, and dynamic quality to match the same verified model', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'clawx-turn-image-preference-'));
    temporaryDirectories.push(stateDirectory);
    const store = createAcpTurnImagePreferenceStore(stateDirectory, {
      resolvePolicy: () => FUTURE_IMAGE_POLICY,
    });
    const invalidOptions = [
      { modelId: 'unverified-image-model', size: '3072x2048', quality: 'ultra' },
      { modelId: 'future-image-model', size: '4096x4096', quality: 'ultra' },
      { modelId: 'future-image-model', size: '3072x2048', quality: 'legacy-quality' },
    ];

    for (const imageOptions of invalidOptions) {
      await expect(store.enqueue({
        sessionKey: 'agent:main:session-1',
        message: 'Create an image.',
        imageOptions,
      })).resolves.toBeNull();
    }
    await expect(readdir(join(stateDirectory, 'uclaw-turn-preferences'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
