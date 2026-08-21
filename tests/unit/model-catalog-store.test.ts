import { readdir, rename as fsRename, unlink as fsUnlink } from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, realpath as fsRealpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@electron/utils/logger', () => ({
  logger: loggerMocks,
}));

import {
  modelCatalogStoreTestApi,
  resetModelCatalogWriteLocksForTests,
  updateModelCatalog,
  withModelCatalogWriteLock,
} from '@electron/utils/model-catalog-store';

describe('model catalog store', () => {
  let directory: string;
  let catalogPath: string;

  beforeEach(async () => {
    resetModelCatalogWriteLocksForTests();
    vi.clearAllMocks();
    directory = await mkdtemp(join(tmpdir(), 'uclaw-model-catalog-'));
    catalogPath = join(directory, 'models.json');
  });

  afterEach(async () => {
    resetModelCatalogWriteLocksForTests();
    await rm(directory, { recursive: true, force: true });
  });

  it('serializes concurrent provider updates without losing either catalog row', async () => {
    await writeFile(catalogPath, JSON.stringify({ providers: {} }), 'utf8');

    await Promise.all([
      updateModelCatalog(catalogPath, addProvider('alpha')),
      updateModelCatalog(catalogPath, addProvider('beta')),
    ]);

    const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as { providers: Record<string, unknown> };
    expect(Object.keys(catalog.providers).sort()).toEqual(['alpha', 'beta']);
    expect((await readFile(catalogPath, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('cleans the Promise queue only when the actual tail settles', async () => {
    let releaseOperation!: () => void;
    const operationBlocked = new Promise<void>((resolve) => { releaseOperation = resolve; });
    const operation = withModelCatalogWriteLock(catalogPath, async () => {
      await operationBlocked;
    });

    await vi.waitFor(() => expect(modelCatalogStoreTestApi.getWriteQueueCount()).toBe(1));
    releaseOperation();
    await operation;

    expect(modelCatalogStoreTestApi.getWriteQueueCount()).toBe(0);
  });

  it('canonicalizes Windows case, 8.3 names, and junction aliases to one lock key', async () => {
    const canonical = 'C:\\Program Files\\UClaw\\models.json';
    const aliases = new Map<string, string>([
      ['C:\\PROGRA~1\\UCLAW\\models.json', canonical],
      ['c:\\program files\\uclaw\\MODELS.json', canonical],
      ['C:\\Mounted\\UClawLink\\models.json', canonical],
    ]);
    modelCatalogStoreTestApi.setRuntimeOverrides({
      platform: 'win32',
      realpath: async (path) => aliases.get(path) ?? path,
    });

    const identities = await Promise.all([...aliases.keys()].map((path) => (
      modelCatalogStoreTestApi.resolvePathIdentity(path)
    )));

    expect(new Set(identities.map(({ lockKey }) => lockKey))).toHaveLength(1);
    expect(new Set(identities.map(({ pathHash }) => pathHash))).toHaveLength(1);
    expect(identities[0].lockKey).toBe(canonical.toLowerCase());
  });

  it('canonicalizes the nearest existing parent when the target does not exist', async () => {
    const missing = 'C:\\PROGRA~1\\UCLAW\\agents\\main\\models.json';
    modelCatalogStoreTestApi.setRuntimeOverrides({
      platform: 'win32',
      realpath: async (path) => {
        if (path === 'C:\\PROGRA~1\\UCLAW') return 'C:\\Program Files\\UClaw';
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
    });

    const identity = await modelCatalogStoreTestApi.resolvePathIdentity(missing);

    expect(identity.canonicalPath).toBe('C:\\Program Files\\UClaw\\agents\\main\\models.json');
    expect(identity.lockKey).toBe(identity.canonicalPath.toLowerCase());
  });

  it('reads and replaces the canonical target instead of creating a second alias file', async () => {
    const canonicalDirectory = join(directory, 'canonical');
    const aliasDirectory = join(directory, 'alias');
    const canonicalPath = join(canonicalDirectory, 'models.json');
    const aliasPath = join(aliasDirectory, 'models.json');
    await Promise.all([
      mkdir(canonicalDirectory, { recursive: true }),
      mkdir(aliasDirectory, { recursive: true }),
    ]);
    await writeFile(canonicalPath, `${JSON.stringify({ providers: { existing: {} } }, null, 2)}\n`, 'utf8');
    modelCatalogStoreTestApi.setRuntimeOverrides({
      realpath: async (path) => path === aliasPath ? canonicalPath : fsRealpath(path),
    });

    await updateModelCatalog(aliasPath, addProvider('managed'));

    const catalog = JSON.parse(await readFile(canonicalPath, 'utf8')) as { providers: Record<string, unknown> };
    expect(Object.keys(catalog.providers).sort()).toEqual(['existing', 'managed']);
    await expect(stat(aliasPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries against the newest target generation instead of losing an external write', async () => {
    await writePrettyCatalog({ providers: {} });
    let renameCalls = 0;
    modelCatalogStoreTestApi.setRuntimeOverrides({
      random: () => 0,
      sleep: async () => undefined,
      rename: async (source, target) => {
        renameCalls += 1;
        if (renameCalls === 1) {
          await writePrettyCatalog({ providers: { external: {} } });
          throw errno('EBUSY');
        }
        await fsRename(source, target);
      },
    });

    const result = await updateModelCatalog(catalogPath, addProvider('managed'));

    expect(result).toEqual({ changed: true, attempts: 2 });
    expect(await readCatalogProviderIds()).toEqual(['external', 'managed']);
    expect(eventResults()).toEqual(['target_changed_retry', 'updated']);
  });

  it('retries when another writer replaces the target immediately after publication', async () => {
    await writePrettyCatalog({ providers: {} });
    let renameCalls = 0;
    modelCatalogStoreTestApi.setRuntimeOverrides({
      rename: async (source, target) => {
        renameCalls += 1;
        await fsRename(source, target);
        if (renameCalls === 1) {
          await writePrettyCatalog({ providers: { external: {} } });
        }
      },
    });

    const result = await updateModelCatalog(catalogPath, addProvider('managed'));

    expect(result).toEqual({ changed: true, attempts: 2 });
    expect(await readCatalogProviderIds()).toEqual(['external', 'managed']);
    expect(eventResults()).toEqual(['target_changed_retry', 'updated']);
  });

  it('accepts an ambiguous rename error only after verifying the intended generation', async () => {
    await writePrettyCatalog({ providers: {} });
    let renameCalls = 0;
    modelCatalogStoreTestApi.setRuntimeOverrides({
      rename: async (source, target) => {
        renameCalls += 1;
        await fsRename(source, target);
        if (renameCalls === 1) throw errno('EIO');
      },
    });

    await expect(updateModelCatalog(catalogPath, addProvider('managed'))).resolves.toEqual({
      changed: true,
      attempts: 1,
    });

    expect(renameCalls).toBe(1);
    expect(await readCatalogProviderIds()).toEqual(['managed']);
    expect(eventResults()).toEqual(['updated']);
  });

  it('reports retry exhaustion without leaking the catalog path', async () => {
    await writePrettyCatalog({ revision: 0 });
    let revision = 0;
    modelCatalogStoreTestApi.setRuntimeOverrides({
      random: () => 0,
      sleep: async () => undefined,
      rename: async () => {
        revision += 1;
        await writePrettyCatalog({ revision });
        throw errno('EBUSY');
      },
    });

    await expect(updateModelCatalog(catalogPath, (document) => ({ ...document, managed: true }), {
      maxTargetChangeRetries: 1,
    })).rejects.toMatchObject({ code: 'MODEL_CATALOG_RETRY_EXHAUSTED' });

    expect(eventResults()).toEqual(['target_changed_retry', 'retry_exhausted']);
    expect(serializedLogCalls()).not.toContain(catalogPath);
    expectStructuredEventsUseOnlyPathHashes();
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a transient Windows %s rename with bounded deterministic jitter', async (code) => {
    await writePrettyCatalog({ providers: {} });
    const sleeps: number[] = [];
    let renameCalls = 0;
    modelCatalogStoreTestApi.setRuntimeOverrides({
      random: () => 0,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      rename: async (source, target) => {
        renameCalls += 1;
        if (renameCalls <= 3) throw errno(code);
        await fsRename(source, target);
      },
    });

    await expect(updateModelCatalog(catalogPath, addProvider('managed'))).resolves.toEqual({
      changed: true,
      attempts: 1,
    });

    expect(renameCalls).toBe(4);
    expect(sleeps).toEqual([15, 30, 60]);
    expect(eventResults()).toEqual(['updated']);
  });

  it('keeps the last known-good catalog when atomic publication never succeeds', async () => {
    const original = `${JSON.stringify({ providers: { stable: {} } }, null, 2)}\n`;
    await writeFile(catalogPath, original, 'utf8');
    modelCatalogStoreTestApi.setRuntimeOverrides({
      random: () => 0,
      sleep: async () => undefined,
      rename: async () => { throw errno('EACCES'); },
    });

    await expect(updateModelCatalog(catalogPath, addProvider('managed'))).rejects.toMatchObject({
      code: 'EACCES',
    });

    expect(await readFile(catalogPath, 'utf8')).toBe(original);
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(eventResults()).toEqual(['failed']);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a transient Windows %s sibling-lock release', async (code) => {
    const sleeps: number[] = [];
    const observedLockStates: string[] = [];
    let lockUnlinks = 0;
    modelCatalogStoreTestApi.setRuntimeOverrides({
      random: () => 0,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      unlink: async (path) => {
        if (path.endsWith('.uclaw-model-catalog.lock')) {
          lockUnlinks += 1;
          observedLockStates.push((JSON.parse(await readFile(path, 'utf8')) as { state: string }).state);
          if (lockUnlinks <= 2) throw errno(code);
        }
        await fsUnlink(path);
      },
    });

    await updateModelCatalog(catalogPath, () => ({ providers: {} }));

    const identity = await modelCatalogStoreTestApi.resolvePathIdentity(catalogPath);
    expect(lockUnlinks).toBe(3);
    expect(sleeps).toEqual([10, 20]);
    expect(observedLockStates).toEqual(['held', 'held', 'held']);
    await expect(stat(identity.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('marks a lock released after bounded unlink retries so the live PID cannot strand it forever', async () => {
    let lockUnlinks = 0;
    modelCatalogStoreTestApi.setRuntimeOverrides({
      random: () => 0,
      sleep: async () => undefined,
      unlink: async (path) => {
        if (path.endsWith('.uclaw-model-catalog.lock')) {
          lockUnlinks += 1;
          throw errno('EBUSY');
        }
        await fsUnlink(path);
      },
    });

    await updateModelCatalog(catalogPath, () => ({ providers: {} }));

    const identity = await modelCatalogStoreTestApi.resolvePathIdentity(catalogPath);
    const abandoned = JSON.parse(await readFile(identity.lockPath, 'utf8')) as { pid: number; state: string };
    expect(lockUnlinks).toBe(4);
    expect(abandoned).toMatchObject({ pid: process.pid, state: 'released' });
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'Model catalog sibling lock release failed',
      expect.objectContaining({ result: 'release_failed', pathHash: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
    );

    modelCatalogStoreTestApi.setRuntimeOverrides({
      processAlive: async () => true,
      unlink: async (path) => fsUnlink(path),
    });
    await expect(updateModelCatalog(catalogPath, (document) => ({ ...document, recovered: true }))).resolves.toEqual({
      changed: true,
      attempts: 1,
    });
    await expect(stat(identity.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers an atomic sibling lock owned by a dead process', async () => {
    const identity = await modelCatalogStoreTestApi.resolvePathIdentity(catalogPath);
    await writeFile(identity.lockPath, JSON.stringify({
      version: 1,
      ownerToken: 'dead-owner-token-00000000',
      pid: 2_147_483_000,
      createdAtMs: Date.now(),
    }), 'utf8');
    modelCatalogStoreTestApi.setRuntimeOverrides({
      processAlive: async () => false,
    });

    await updateModelCatalog(catalogPath, () => ({ providers: {} }));

    await expect(stat(identity.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never steals a sibling lock from a live process', async () => {
    const identity = await modelCatalogStoreTestApi.resolvePathIdentity(catalogPath);
    await writeFile(identity.lockPath, JSON.stringify({
      version: 1,
      ownerToken: 'live-owner-token-00000000',
      pid: process.pid,
      createdAtMs: 1,
    }), 'utf8');
    let clock = 0;
    modelCatalogStoreTestApi.setRuntimeOverrides({
      now: () => {
        clock += 6_000;
        return clock;
      },
      processAlive: async () => true,
      random: () => 0,
      sleep: async () => undefined,
    });

    await expect(updateModelCatalog(catalogPath, () => ({ providers: {} }))).rejects.toMatchObject({
      code: 'MODEL_CATALOG_LOCK_TIMEOUT',
    });

    expect(JSON.parse(await readFile(identity.lockPath, 'utf8'))).toMatchObject({
      ownerToken: 'live-owner-token-00000000',
      pid: process.pid,
    });
    expect(eventResults()).toEqual(['failed']);
  });

  it('emits updated and unchanged events with hashes instead of absolute paths', async () => {
    const next = { providers: { managed: {} } };
    await updateModelCatalog(catalogPath, () => next);
    await updateModelCatalog(catalogPath, () => next);

    expect(eventResults()).toEqual(['updated', 'unchanged']);
    expect(serializedLogCalls()).not.toContain(catalogPath);
    expect(serializedLogCalls()).not.toContain(dirname(catalogPath));
    expectStructuredEventsUseOnlyPathHashes();
  });

  it('keeps the last known-good catalog and emits a safe failed event when a transform rejects', async () => {
    const original = '{\n  "providers": { "stable": {} }\n}\n';
    await writeFile(catalogPath, original, 'utf8');

    await expect(updateModelCatalog(catalogPath, () => {
      throw new Error(`cannot build catalog at ${catalogPath}`);
    })).rejects.toThrow('cannot build catalog');

    expect(await readFile(catalogPath, 'utf8')).toBe(original);
    expect(eventResults()).toEqual(['failed']);
    expect(serializedLogCalls()).not.toContain(catalogPath);
    expectStructuredEventsUseOnlyPathHashes();
  });

  it('classifies malformed JSON as invalid_catalog without logging parser text or paths', async () => {
    await writeFile(catalogPath, `{ "providers": ${catalogPath}`, 'utf8');

    await expect(updateModelCatalog(catalogPath, () => ({ providers: {} }))).rejects.toMatchObject({
      code: 'MODEL_CATALOG_INVALID_JSON',
    });

    const failed = updateEvents().find(({ result }) => result === 'failed');
    expect(failed).toMatchObject({
      failureKind: 'model_catalog_invalid_json',
      result: 'failed',
    });
    expect(serializedLogCalls()).not.toContain(catalogPath);
  });

  function eventResults(): string[] {
    return updateEvents()
      .sort((left, right) => (
        (left.attempt ?? 0) - (right.attempt ?? 0)
      ))
      .map((value) => value.result ?? '');
  }

  function updateEvents(): Array<{ attempt?: number; failureKind?: string; result?: string }> {
    return [...loggerMocks.info.mock.calls, ...loggerMocks.warn.mock.calls, ...loggerMocks.error.mock.calls]
      .map((call) => call[1] as { attempt?: number; event?: string; failureKind?: string; result?: string } | undefined)
      .filter((value): value is { attempt?: number; failureKind?: string; result?: string } => (
        value?.event === 'model_catalog_update'
      ));
  }

  function serializedLogCalls(): string {
    return JSON.stringify([
      ...loggerMocks.info.mock.calls,
      ...loggerMocks.warn.mock.calls,
      ...loggerMocks.error.mock.calls,
    ]);
  }

  function expectStructuredEventsUseOnlyPathHashes(): void {
    for (const call of [...loggerMocks.info.mock.calls, ...loggerMocks.warn.mock.calls, ...loggerMocks.error.mock.calls]) {
      const details = call[1] as Record<string, unknown> | undefined;
      if (details?.event !== 'model_catalog_update') continue;
      expect(details.pathHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(details).not.toHaveProperty('filePath');
      expect(details).not.toHaveProperty('path');
      expect(details).not.toHaveProperty('error');
    }
  }

  async function writePrettyCatalog(document: Record<string, unknown>): Promise<void> {
    await writeFile(catalogPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  }

  async function readCatalogProviderIds(): Promise<string[]> {
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as { providers: Record<string, unknown> };
    return Object.keys(catalog.providers).sort();
  }
});

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function addProvider(providerId: string): (document: Record<string, unknown>) => Record<string, unknown> {
  return (document) => ({
    ...document,
    providers: {
      ...(document.providers as Record<string, unknown> ?? {}),
      [providerId]: { models: [{ id: `${providerId}-model` }] },
    },
  });
}
