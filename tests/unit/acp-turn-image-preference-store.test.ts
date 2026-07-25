import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpTurnImagePreferenceStore } from '../../electron/services/acp-turn-image-preference-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Acp turn image preference store', () => {
  it('stores only a message digest and removes the preference after a failed ACP prompt', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'clawx-turn-image-preference-'));
    temporaryDirectories.push(stateDirectory);
    const store = createAcpTurnImagePreferenceStore(stateDirectory);
    const message = 'Create a blue coffee cup on a white table.';

    const entry = await store.enqueue({
      sessionKey: 'agent:main:session-1',
      message,
      imageOptions: { size: '3840x2160', quality: 'medium' },
    });

    expect(entry).not.toBeNull();
    const preferenceDirectory = join(stateDirectory, 'uclaw-turn-preferences');
    const files = await readdir(preferenceDirectory);
    expect(files).toHaveLength(1);
    const stored = JSON.parse(await readFile(join(preferenceDirectory, files[0]!), 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({
      version: 1,
      sessionKey: 'agent:main:session-1',
      messageDigest: createHash('sha256').update(message, 'utf8').digest('hex'),
      imageOptions: { size: '3840x2160', quality: 'medium' },
    });
    expect(JSON.stringify(stored)).not.toContain(message);

    await store.discard(entry?.id);
    await expect(readdir(preferenceDirectory)).resolves.toEqual([]);
  });

  it('rejects unsupported renderer values before they reach the gateway plugin', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'clawx-turn-image-preference-'));
    temporaryDirectories.push(stateDirectory);
    const store = createAcpTurnImagePreferenceStore(stateDirectory);

    await expect(store.enqueue({
      sessionKey: 'agent:main:session-1',
      message: 'Create an image.',
      imageOptions: { size: '512x512', quality: 'medium' } as never,
    })).resolves.toBeNull();
  });
});
