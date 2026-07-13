import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  JsonFileReadError,
  readJsonFileWithRetry,
  writeJsonFileAtomically,
} from '../electron/utils/json-file-io.ts';

async function withTempConfig(run: (configPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'clawx-json-file-io-'));
  try {
    await run(join(directory, 'openclaw.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('atomic JSON replacement never exposes a partial document to concurrent readers', async () => {
  await withTempConfig(async (configPath) => {
    await writeJsonFileAtomically(configPath, { revision: 0, payload: 'initial' });

    const writer = (async () => {
      for (let revision = 1; revision <= 80; revision += 1) {
        await writeJsonFileAtomically(configPath, {
          revision,
          payload: 'x'.repeat(1024 + revision),
        });
      }
    })();
    const reader = (async () => {
      for (let read = 0; read < 160; read += 1) {
        const parsed = JSON.parse(await readFile(configPath, 'utf8')) as { revision?: unknown };
        assert.equal(typeof parsed.revision, 'number');
      }
    })();

    await Promise.all([writer, reader]);
  });
});

test('transient partial JSON is retried instead of becoming an empty config', async () => {
  await withTempConfig(async (configPath) => {
    await writeFile(configPath, '{"state":', 'utf8');
    const repair = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void writeFile(configPath, '{"state":"ready"}', 'utf8').then(resolve, reject);
      }, 5);
    });

    const config = await readJsonFileWithRetry<{ state: string }>(configPath, {
      retryDelaysMs: [20, 40],
    });
    await repair;

    assert.deepEqual(config, { state: 'ready' });
  });
});

test('persistent malformed JSON fails instead of returning an empty config', async () => {
  await withTempConfig(async (configPath) => {
    await writeFile(configPath, '{', 'utf8');

    await assert.rejects(
      () => readJsonFileWithRetry(configPath, { retryDelaysMs: [1] }),
      (error: unknown) => error instanceof JsonFileReadError && error.attempts === 2,
    );
  });
});
