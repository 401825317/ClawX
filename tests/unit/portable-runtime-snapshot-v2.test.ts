// @vitest-environment node

import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const unstableFiles = vi.hoisted(() => new Set<string>());
const durableSyncCount = vi.hoisted(() => ({ value: 0 }));
const durableSyncFlags = vi.hoisted(() => new Map<number, string>());
const durableFsyncFlags = vi.hoisted(() => [] as string[]);
const rejectReadOnlyFsync = vi.hoisted(() => ({ value: false }));
const unstableSqliteBackupOutputs = vi.hoisted(() => ({ value: false }));
const transientSqliteBackupMutations = vi.hoisted(() => ({ value: 0 }));
const corruptStableObjectCopies = vi.hoisted(() => ({ value: false }));
const failStableObjectCopies = vi.hoisted(() => ({ value: false }));
const sqliteBackupCompletedHook = vi.hoisted(() => ({
  value: undefined as (() => void | Promise<void>) | undefined,
}));
const sqliteBackupCalls = vi.hoisted(() => ({ value: 0 }));
const restorePublishFailureTargets = vi.hoisted(() => new Set<string>());
const restoreCleanupFailureTargets = vi.hoisted(() => new Set<string>());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync(filePath: import('node:fs').PathLike, flags: import('node:fs').OpenMode, mode?: import('node:fs').Mode | null) {
      const descriptor = actual.openSync(filePath, flags, mode);
      durableSyncFlags.set(descriptor, String(flags));
      return descriptor;
    },
    fsyncSync(descriptor: number) {
      durableSyncCount.value += 1;
      const flags = durableSyncFlags.get(descriptor);
      if (flags) durableFsyncFlags.push(flags);
      if (rejectReadOnlyFsync.value && flags === 'r') {
        const error = new Error('Injected Windows read-only fsync failure') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return actual.fsyncSync(descriptor);
    },
    renameSync(source: import('node:fs').PathLike, target: import('node:fs').PathLike) {
      if (
        restorePublishFailureTargets.has(String(target))
        && String(source).includes('.restore.')
      ) {
        const error = new Error('Injected restore publish failure') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return actual.renameSync(source, target);
    },
    rmSync(target: import('node:fs').PathLike, options?: import('node:fs').RmDirOptions) {
      if ([...restoreCleanupFailureTargets].some((prefix) => String(target).startsWith(`${prefix}.previous.`))) {
        const error = new Error('Injected restore cleanup failure') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      }
      return actual.rmSync(target, options);
    },
    createReadStream(filePath: import('node:fs').PathLike, options?: Parameters<typeof actual.createReadStream>[1]) {
      const stream = actual.createReadStream(filePath, options);
      if (unstableFiles.has(String(filePath))) {
        stream.once('data', () => actual.appendFileSync(filePath, 'changed'));
      }
      if (unstableSqliteBackupOutputs.value && String(filePath).includes('sqlite-backup.')) {
        stream.once('data', () => actual.appendFileSync(filePath, 'changed'));
      }
      if (transientSqliteBackupMutations.value > 0 && String(filePath).includes('sqlite-backup.')) {
        transientSqliteBackupMutations.value -= 1;
        stream.once('data', () => actual.appendFileSync(filePath, 'changed'));
      }
      return stream;
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async copyFile(
      source: import('node:fs').PathLike,
      destination: import('node:fs').PathLike,
      mode?: number,
    ) {
      const target = String(destination);
      const isStableObjectCopy = /[\\/]objects[\\/]/u.test(target) && target.endsWith('.tmp');
      if (isStableObjectCopy && failStableObjectCopies.value) {
        const error = new Error('Injected stable object copy failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      await actual.copyFile(source, destination, mode);
      if (isStableObjectCopy && corruptStableObjectCopies.value) {
        const content = await actual.readFile(destination);
        if (content.length > 0) content[0] ^= 0xff;
        await actual.writeFile(destination, content);
      }
    },
  };
});

vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>();
  return {
    ...actual,
    async backup(...args: Parameters<typeof actual.backup>) {
      sqliteBackupCalls.value += 1;
      const result = await actual.backup(...args);
      await sqliteBackupCompletedHook.value?.();
      return result;
    },
  };
});
import {
  PORTABLE_SNAPSHOT_V2_SCHEMA,
  readLatestPortableSnapshotV2Sync,
  restorePortableRuntimeSnapshotV2Sync,
  syncPortableRuntimeSnapshotV2,
  type PortableSnapshotV2Layout,
  type PortableSnapshotV2Manifest,
} from '@electron/utils/portable-runtime-snapshot-v2';

const tempDirs: string[] = [];

afterEach(async () => {
  unstableFiles.clear();
  durableSyncCount.value = 0;
  durableSyncFlags.clear();
  durableFsyncFlags.splice(0);
  rejectReadOnlyFsync.value = false;
  unstableSqliteBackupOutputs.value = false;
  transientSqliteBackupMutations.value = 0;
  corruptStableObjectCopies.value = false;
  failStableObjectCopies.value = false;
  sqliteBackupCompletedHook.value = undefined;
  sqliteBackupCalls.value = 0;
  restorePublishFailureTargets.clear();
  restoreCleanupFailureTargets.clear();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createLayout(): Promise<PortableSnapshotV2Layout> {
  const root = await mkdtemp(join(tmpdir(), 'uclaw-portable-snapshot-v2-'));
  tempDirs.push(root);
  const layout = {
    stateDir: join(root, 'state'),
    snapshotDir: join(root, 'snapshot-v2'),
    portableId: 'portable-test-id',
  };
  await mkdir(layout.stateDir, { recursive: true });
  await mkdir(join(layout.snapshotDir, 'manifests'), { recursive: true });
  return layout;
}

async function writeManifest(
  layout: PortableSnapshotV2Layout,
  manifest: PortableSnapshotV2Manifest,
  name = 'snapshot-2026-08-06T00-00-00-000Z-test.json',
): Promise<void> {
  await writeFile(
    join(layout.snapshotDir, 'manifests', name),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

function validManifest(layout: PortableSnapshotV2Layout): PortableSnapshotV2Manifest {
  return {
    schema: PORTABLE_SNAPSHOT_V2_SCHEMA,
    portableId: layout.portableId,
    createdAt: '2026-08-06T00:00:00.000Z',
    reason: 'test',
    entries: {
      'agents/main.json': {
        object: 'a'.repeat(64),
        size: 1,
        mtimeMs: 1,
      },
    },
  };
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string, prefix = ''): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(join(dir, entry.name), relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };
  await visit(root);
  return files.sort();
}

describe('portable runtime snapshot v2 manifest', () => {
  it('reads the latest valid manifest for the portable identity', async () => {
    const layout = await createLayout();
    const manifest = validManifest(layout);
    const object = manifest.entries['agents/main.json'].object;
    await mkdir(join(layout.snapshotDir, 'objects', object.slice(0, 2)), { recursive: true });
    await writeFile(join(layout.snapshotDir, 'objects', object.slice(0, 2), object), 'x');
    await writeManifest(layout, manifest);

    expect(readLatestPortableSnapshotV2Sync(layout)).toEqual(manifest);
  });

  it.each([
    '../outside.json',
    '/absolute.json',
    'C:\\absolute.json',
    'agents/../../outside.json',
    'agents\\..\\outside.json',
    'agents/file:stream',
    'agents/\0outside.json',
  ])('rejects an unsafe manifest entry path: %s', async (entryPath) => {
    const layout = await createLayout();
    const manifest = validManifest(layout);
    manifest.entries = {
      [entryPath]: {
        object: 'a'.repeat(64),
        size: 1,
        mtimeMs: 1,
      },
    };
    await writeManifest(layout, manifest);

    expect(readLatestPortableSnapshotV2Sync(layout)).toBeUndefined();
  });

  it('rejects a manifest owned by another portable identity', async () => {
    const layout = await createLayout();
    const manifest = validManifest(layout);
    manifest.portableId = 'another-portable-id';
    await writeManifest(layout, manifest);

    expect(readLatestPortableSnapshotV2Sync(layout)).toBeUndefined();
  });
});

describe('portable runtime snapshot v2 sync', () => {
  it('writes one baseline and performs no USB writes when state is unchanged', async () => {
    const layout = await createLayout();
    await mkdir(join(layout.stateDir, 'agents'), { recursive: true });
    await writeFile(join(layout.stateDir, 'openclaw.json'), '{"ok":true}\n', 'utf8');
    await writeFile(join(layout.stateDir, 'agents', 'main.json'), '{"name":"main"}\n', 'utf8');
    await writeFile(join(layout.stateDir, '.uclaw-runtime-state.json'), '{"local":true}\n', 'utf8');

    const first = await syncPortableRuntimeSnapshotV2(layout, 'periodic');
    expect(first).toMatchObject({
      skipped: false,
      scannedFiles: 2,
      changedFiles: 2,
      reusedFiles: 0,
      writtenObjects: 2,
    });

    const manifestsAfterFirst = await listFiles(join(layout.snapshotDir, 'manifests'));
    const objectsAfterFirst = await listFiles(join(layout.snapshotDir, 'objects'));

    await writeFile(join(layout.stateDir, '.uclaw-runtime-state.json'), '{"local":false}\n', 'utf8');
    const second = await syncPortableRuntimeSnapshotV2(layout, 'periodic');

    expect(second).toMatchObject({
      skipped: true,
      scannedFiles: 2,
      changedFiles: 0,
      reusedFiles: 2,
      writtenObjects: 0,
      writtenBytes: 0,
    });
    expect(await listFiles(join(layout.snapshotDir, 'manifests'))).toEqual(manifestsAfterFirst);
    expect(await listFiles(join(layout.snapshotDir, 'objects'))).toEqual(objectsAfterFirst);
  });

  it('writes only the changed object and removes deleted paths from the next manifest', async () => {
    const layout = await createLayout();
    await writeFile(join(layout.stateDir, 'a.json'), '{"version":1}\n', 'utf8');
    await writeFile(join(layout.stateDir, 'b.json'), '{"remove":true}\n', 'utf8');
    await syncPortableRuntimeSnapshotV2(layout, 'baseline');

    await writeFile(join(layout.stateDir, 'a.json'), '{"version":22}\n', 'utf8');
    await rm(join(layout.stateDir, 'b.json'));
    await writeFile(join(layout.stateDir, 'c.json'), '{"added":true}\n', 'utf8');

    const result = await syncPortableRuntimeSnapshotV2(layout, 'periodic');
    const latest = readLatestPortableSnapshotV2Sync(layout);

    expect(result).toMatchObject({
      skipped: false,
      scannedFiles: 2,
      changedFiles: 2,
      reusedFiles: 0,
      writtenObjects: 2,
    });
    expect(Object.keys(latest?.entries ?? {}).sort()).toEqual(['a.json', 'c.json']);
  });

  it('assigns monotonic generations and parent ids to snapshots', async () => {
    const layout = await createLayout();
    await writeFile(join(layout.stateDir, 'state.json'), '{"version":1}\n', 'utf8');
    await syncPortableRuntimeSnapshotV2(layout, 'version-1');
    const first = readLatestPortableSnapshotV2Sync(layout) as PortableSnapshotV2Manifest & {
      snapshotId?: string;
      generation?: number;
      parentSnapshotId?: string;
    };

    await writeFile(join(layout.stateDir, 'state.json'), '{"version":2}\n', 'utf8');
    await syncPortableRuntimeSnapshotV2(layout, 'version-2');
    const second = readLatestPortableSnapshotV2Sync(layout) as PortableSnapshotV2Manifest & {
      snapshotId?: string;
      generation?: number;
      parentSnapshotId?: string;
    };

    expect(first.snapshotId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(first.generation).toBe(1);
    expect(first.parentSnapshotId).toBeUndefined();
    expect(second.snapshotId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(second.generation).toBe(2);
    expect(second.parentSnapshotId).toBe(first.snapshotId);
  });

  it('syncs changed objects and the manifest through writable handles before publishing them', async () => {
    const layout = await createLayout();
    await writeFile(join(layout.stateDir, 'state.json'), '{"durable":true}\n', 'utf8');

    await syncPortableRuntimeSnapshotV2(layout, 'durability');

    expect(durableSyncCount.value).toBeGreaterThanOrEqual(2);
    expect(durableFsyncFlags).toEqual(expect.arrayContaining(['r+']));
  });

  it('does not defer when Windows rejects read-only fsync handles', async () => {
    const layout = await createLayout();
    await writeFile(join(layout.stateDir, 'state.json'), '{"durable":true}\n', 'utf8');
    rejectReadOnlyFsync.value = true;

    const result = await syncPortableRuntimeSnapshotV2(layout, 'windows-durability');

    expect(result).toMatchObject({ skipped: false, deferred: false });
    expect(durableFsyncFlags).toEqual(expect.arrayContaining(['r+']));
  });

  it('does not publish copied bytes under a mismatched content-addressed object name', async () => {
    const layout = await createLayout();
    await writeFile(join(layout.stateDir, 'state.json'), '{"stable":true}\n', 'utf8');
    corruptStableObjectCopies.value = true;

    const result = await syncPortableRuntimeSnapshotV2(layout, 'copy-integrity');

    expect(result).toMatchObject({
      skipped: true,
      deferred: true,
      deferredReason: 'file-group-unstable',
      deferredPaths: ['state.json'],
    });
    expect(readLatestPortableSnapshotV2Sync(layout)).toBeUndefined();
    expect(await listFiles(join(layout.snapshotDir, 'objects'))).toEqual([]);
  });

  it('keeps an existing object until its verified replacement is ready', async () => {
    const layout = await createLayout();
    const stateFile = join(layout.stateDir, 'state.json');
    await writeFile(stateFile, '{"stable":true}\n', 'utf8');
    await syncPortableRuntimeSnapshotV2(layout, 'baseline');
    const entry = readLatestPortableSnapshotV2Sync(layout)!.entries['state.json'];
    const storedObject = join(layout.snapshotDir, 'objects', entry.object.slice(0, 2), entry.object);
    const corrupt = Buffer.alloc(entry.size, 0x78);
    await writeFile(storedObject, corrupt);
    const future = new Date(Date.now() + 5_000);
    await utimes(stateFile, future, future);
    failStableObjectCopies.value = true;

    await expect(syncPortableRuntimeSnapshotV2(layout, 'replace-corrupt-object')).rejects.toMatchObject({
      code: 'EIO',
    });

    await expect(readFile(storedObject)).resolves.toEqual(corrupt);
  });

  it('does not reuse a corrupt object when its replacement copy fails verification', async () => {
    const layout = await createLayout();
    const stateFile = join(layout.stateDir, 'state.json');
    await writeFile(stateFile, '{"stable":true}\n', 'utf8');
    await syncPortableRuntimeSnapshotV2(layout, 'baseline');
    const previous = readLatestPortableSnapshotV2Sync(layout)!;
    const entry = previous.entries['state.json'];
    const storedObject = join(layout.snapshotDir, 'objects', entry.object.slice(0, 2), entry.object);
    const corrupt = Buffer.alloc(entry.size, 0x78);
    await writeFile(storedObject, corrupt);
    const future = new Date(Date.now() + 5_000);
    await utimes(stateFile, future, future);
    corruptStableObjectCopies.value = true;

    const result = await syncPortableRuntimeSnapshotV2(layout, 'replace-corrupt-object');

    expect(result).toMatchObject({
      skipped: true,
      deferred: true,
      deferredReason: 'file-group-unstable',
      reusedPreviousSnapshot: true,
    });
    await expect(readFile(storedObject)).resolves.toEqual(corrupt);
  });

  it('captures a WAL-mode SQLite database as one consistent database object', async () => {
    const layout = await createLayout();
    const databasePath = join(layout.stateDir, 'history.db');
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
        INSERT INTO messages (body) VALUES ('first'), ('second');
      `);
      database.exec("BEGIN IMMEDIATE; INSERT INTO messages (body) VALUES ('uncommitted');");

      await syncPortableRuntimeSnapshotV2(layout, 'sqlite-online-backup');
      database.exec('ROLLBACK');
    } finally {
      database.close();
    }

    const manifest = readLatestPortableSnapshotV2Sync(layout)!;
    expect(manifest.entries['history.db']).toBeTruthy();
    expect(manifest.entries['history.db-wal']).toBeUndefined();
    expect(manifest.entries['history.db-shm']).toBeUndefined();

    await rm(layout.stateDir, { recursive: true, force: true });
    expect(restorePortableRuntimeSnapshotV2Sync(layout, layout.stateDir)).toBe(true);
    const restored = new DatabaseSync(join(layout.stateDir, 'history.db'), { readOnly: true });
    try {
      const row = restored.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number };
      expect(row.count).toBe(2);
    } finally {
      restored.close();
    }
  });

  it('rechecks an unchanged SQLite source during a scheduled integrity scan', async () => {
    const layout = await createLayout();
    const database = new DatabaseSync(join(layout.stateDir, 'history.db'));
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
    try {
      database.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL);');
      await syncPortableRuntimeSnapshotV2(layout, 'baseline');
      prepare.mockClear();

      await syncPortableRuntimeSnapshotV2(layout, 'integrity-scan', {
        verifyExistingObjects: true,
      });

      const pragmas = prepare.mock.calls.map(([sql]) => String(sql));
      expect(pragmas).toContain('PRAGMA integrity_check');
    } finally {
      prepare.mockRestore();
      database.close();
    }
  });

  it('accepts a validated point-in-time backup while the live WAL advances', async () => {
    const layout = await createLayout();
    const databasePath = join(layout.stateDir, 'history.db');
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
        INSERT INTO messages (body) VALUES ('before-backup');
      `);
      sqliteBackupCompletedHook.value = () => {
        database.exec("INSERT INTO messages (body) VALUES ('during-capture');");
      };

      const first = await syncPortableRuntimeSnapshotV2(layout, 'active-sqlite');
      sqliteBackupCompletedHook.value = undefined;
      const firstManifest = readLatestPortableSnapshotV2Sync(layout)!;
      const second = await syncPortableRuntimeSnapshotV2(layout, 'refresh-active-sqlite');
      const secondManifest = readLatestPortableSnapshotV2Sync(layout)!;

      expect(first).toMatchObject({ skipped: false, deferred: false });
      expect(second).toMatchObject({ skipped: false, deferred: false });
      expect(secondManifest.entries['history.db'].object).not.toBe(firstManifest.entries['history.db'].object);
    } finally {
      sqliteBackupCompletedHook.value = undefined;
      database.close();
    }
  });

  it('recovers from a transient unstable backup within the bounded retry window', async () => {
    const layout = await createLayout();
    const database = new DatabaseSync(join(layout.stateDir, 'history.db'));
    try {
      database.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL);');
      transientSqliteBackupMutations.value = 1;

      const result = await syncPortableRuntimeSnapshotV2(layout, 'sqlite-transient-busy');

      expect(result).toMatchObject({ skipped: false, deferred: false });
      expect(sqliteBackupCalls.value).toBe(2);
      expect(readLatestPortableSnapshotV2Sync(layout)?.entries['history.db']).toBeTruthy();
    } finally {
      database.close();
    }
  });

  it('accepts a SQLite backup when a scanned WAL companion disappears first', async () => {
    const layout = await createLayout();
    const firstDatabase = new DatabaseSync(join(layout.stateDir, 'a.db'));
    const historyPath = join(layout.stateDir, 'history.db');
    const historyDatabase = new DatabaseSync(historyPath);
    try {
      firstDatabase.exec('CREATE TABLE first_state (id INTEGER PRIMARY KEY);');
      historyDatabase.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL);');
      const walPath = `${historyPath}-wal`;
      await writeFile(walPath, '');
      let completedBackups = 0;
      sqliteBackupCompletedHook.value = async () => {
        completedBackups += 1;
        if (completedBackups === 1) await rm(walPath, { force: true });
      };

      const result = await syncPortableRuntimeSnapshotV2(layout, 'vanishing-wal');

      expect(result).toMatchObject({ skipped: false, deferred: false });
      expect(readLatestPortableSnapshotV2Sync(layout)?.entries).toMatchObject({
        'a.db': expect.any(Object),
        'history.db': expect.any(Object),
      });
    } finally {
      sqliteBackupCompletedHook.value = undefined;
      firstDatabase.close();
      historyDatabase.close();
    }
  });

  it('defers an initial unstable SQLite baseline without touching its source files', async () => {
    const layout = await createLayout();
    const databasePath = join(layout.stateDir, 'history.db');
    const database = new DatabaseSync(databasePath);
    try {
      database.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL);');
      const before = await readFile(databasePath);
      unstableSqliteBackupOutputs.value = true;

      const result = await syncPortableRuntimeSnapshotV2(layout, 'sqlite-busy');

      expect(result).toMatchObject({
        skipped: true,
        deferred: true,
        deferredReason: 'sqlite-unstable',
        deferredPaths: ['history.db'],
        reusedPreviousSnapshot: false,
      });
      await expect(readFile(databasePath)).resolves.toEqual(before);
      expect(readLatestPortableSnapshotV2Sync(layout)).toBeUndefined();
    } finally {
      unstableSqliteBackupOutputs.value = false;
      database.close();
    }
  });

  it('reuses the prior SQLite snapshot when a later online backup is unstable', async () => {
    const layout = await createLayout();
    const databasePath = join(layout.stateDir, 'history.db');
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
        INSERT INTO messages (body) VALUES ('baseline');
      `);
      await syncPortableRuntimeSnapshotV2(layout, 'baseline');
      const previous = readLatestPortableSnapshotV2Sync(layout)!;
      database.exec("INSERT INTO messages (body) VALUES ('pending-backup');");
      const sourceBefore = await readFile(databasePath);
      const walPath = `${databasePath}-wal`;
      const walBefore = await readFile(walPath);
      unstableSqliteBackupOutputs.value = true;

      const result = await syncPortableRuntimeSnapshotV2(layout, 'sqlite-busy');
      const latest = readLatestPortableSnapshotV2Sync(layout)!;

      expect(result).toMatchObject({
        skipped: true,
        deferred: true,
        deferredReason: 'sqlite-unstable',
        deferredPaths: ['history.db'],
        reusedPreviousSnapshot: true,
      });
      expect(latest.entries['history.db']).toEqual(previous.entries['history.db']);
      await expect(readFile(databasePath)).resolves.toEqual(sourceBefore);
      await expect(readFile(walPath)).resolves.toEqual(walBefore);
    } finally {
      unstableSqliteBackupOutputs.value = false;
      database.close();
    }
  });

  it('excludes reconstructable Chromium caches but preserves browser login state', async () => {
    const layout = await createLayout();
    const profile = join(layout.stateDir, 'browser', 'openclaw', 'user-data', 'Default');
    await mkdir(join(profile, 'Cache'), { recursive: true });
    await mkdir(join(profile, 'Code Cache'), { recursive: true });
    await mkdir(join(profile, 'GPUCache'), { recursive: true });
    await mkdir(join(profile, 'Service Worker', 'CacheStorage'), { recursive: true });
    await mkdir(join(layout.stateDir, 'browser', 'openclaw', 'user-data', 'Crashpad'), { recursive: true });
    await mkdir(join(profile, 'Local Storage'), { recursive: true });
    await mkdir(join(profile, 'IndexedDB'), { recursive: true });
    await writeFile(join(profile, 'Cache', 'cache.bin'), 'cache');
    await writeFile(join(profile, 'Code Cache', 'code.bin'), 'cache');
    await writeFile(join(profile, 'GPUCache', 'gpu.bin'), 'cache');
    await writeFile(join(profile, 'Service Worker', 'CacheStorage', 'service.bin'), 'cache');
    await writeFile(join(layout.stateDir, 'browser', 'openclaw', 'user-data', 'Crashpad', 'dump.bin'), 'cache');
    await writeFile(join(profile, 'Cookies'), 'cookies');
    await writeFile(join(profile, 'Local Storage', 'state.bin'), 'local');
    await writeFile(join(profile, 'IndexedDB', 'db.bin'), 'indexed');

    await syncPortableRuntimeSnapshotV2(layout, 'baseline');
    const paths = Object.keys(readLatestPortableSnapshotV2Sync(layout)?.entries ?? {}).sort();

    expect(paths).toEqual([
      'browser/openclaw/user-data/Default/Cookies',
      'browser/openclaw/user-data/Default/IndexedDB/db.bin',
      'browser/openclaw/user-data/Default/Local Storage/state.bin',
    ]);
  });

  it('retains three manifests and removes objects no longer referenced by them', async () => {
    const layout = await createLayout();
    for (let version = 1; version <= 4; version += 1) {
      await writeFile(join(layout.stateDir, 'state.json'), `${JSON.stringify({ version, marker: 'x'.repeat(version) })}\n`);
      await syncPortableRuntimeSnapshotV2(layout, `version-${version}`);
    }

    expect(await listFiles(join(layout.snapshotDir, 'manifests'))).toHaveLength(3);
    expect(await listFiles(join(layout.snapshotDir, 'objects'))).toHaveLength(3);
  });

  it('restores the previous complete snapshot when the latest object is corrupt', async () => {
    const layout = await createLayout();
    await writeFile(join(layout.stateDir, 'state.json'), '{"version":1}\n');
    await syncPortableRuntimeSnapshotV2(layout, 'version-1');
    const first = readLatestPortableSnapshotV2Sync(layout);

    await writeFile(join(layout.stateDir, 'state.json'), '{"version":22}\n');
    await syncPortableRuntimeSnapshotV2(layout, 'version-2');
    const latest = readLatestPortableSnapshotV2Sync(layout);
    expect(latest?.entries['state.json'].object).not.toBe(first?.entries['state.json'].object);

    const corruptObject = latest?.entries['state.json'].object;
    expect(corruptObject).toBeTruthy();
    await writeFile(
      join(layout.snapshotDir, 'objects', corruptObject!.slice(0, 2), corruptObject!),
      'corrupt',
    );
    await rm(layout.stateDir, { recursive: true, force: true });

    expect(restorePortableRuntimeSnapshotV2Sync(layout, layout.stateDir)).toBe(true);
    await expect(readFile(join(layout.stateDir, 'state.json'), 'utf8')).resolves.toBe('{"version":1}\n');
  });

  it('keeps the existing target when publishing a restored directory fails', async () => {
    const layout = await createLayout();
    await writeFile(join(layout.stateDir, 'state.json'), '{"source":"usb"}\n');
    await syncPortableRuntimeSnapshotV2(layout, 'usb-snapshot');
    await writeFile(join(layout.stateDir, 'state.json'), '{"source":"local"}\n');
    restorePublishFailureTargets.add(layout.stateDir);

    expect(restorePortableRuntimeSnapshotV2Sync(layout, layout.stateDir)).toBe(false);
    await expect(readFile(join(layout.stateDir, 'state.json'), 'utf8')).resolves.toBe('{"source":"local"}\n');
  });

  it('accepts a published restore when only previous-directory cleanup fails', async () => {
    const layout = await createLayout();
    await writeFile(join(layout.stateDir, 'state.json'), '{"source":"usb"}\n');
    await syncPortableRuntimeSnapshotV2(layout, 'usb-snapshot');
    await writeFile(join(layout.stateDir, 'state.json'), '{"source":"local"}\n');
    restoreCleanupFailureTargets.add(layout.stateDir);

    expect(restorePortableRuntimeSnapshotV2Sync(layout, layout.stateDir)).toBe(true);
    await expect(readFile(join(layout.stateDir, 'state.json'), 'utf8')).resolves.toBe('{"source":"usb"}\n');
  });

  it('reuses the entire previous snapshot when a file group is unstable', async () => {
    const layout = await createLayout();
    const database = join(layout.stateDir, 'history.db');
    const wal = join(layout.stateDir, 'history.db-wal');
    await writeFile(database, 'database-v1');
    await writeFile(wal, 'wal-v1');
    await writeFile(join(layout.stateDir, 'agent.json'), '{"version":1}\n');
    await syncPortableRuntimeSnapshotV2(layout, 'baseline');
    const previous = readLatestPortableSnapshotV2Sync(layout)!;

    await writeFile(database, 'database-v2');
    await writeFile(wal, 'wal-v2');
    await writeFile(join(layout.stateDir, 'agent.json'), '{"version":22}\n');
    unstableFiles.add(wal);

    const result = await syncPortableRuntimeSnapshotV2(layout, 'periodic');
    const latest = readLatestPortableSnapshotV2Sync(layout)!;

    expect(latest).toEqual(previous);
    expect(result).toMatchObject({
      skipped: true,
      deferred: true,
      deferredReason: 'file-group-unstable',
      deferredPaths: ['history.db'],
      reusedPreviousSnapshot: true,
    });
    expect(result.unstableFiles).toBeGreaterThan(0);
  });

  it('aborts before writing a manifest when shutdown synchronization is cancelled', async () => {
    const layout = await createLayout();
    await writeFile(join(layout.stateDir, 'state.json'), '{"version":1}\n');
    const controller = new AbortController();
    controller.abort();

    await expect(syncPortableRuntimeSnapshotV2(layout, 'shutdown', {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await listFiles(join(layout.snapshotDir, 'manifests'))).toEqual([]);
  });

  it('does not use a manifest with missing objects as the incremental baseline', async () => {
    const layout = await createLayout();
    await writeFile(join(layout.stateDir, 'state.json'), '{"version":1}\n');
    await syncPortableRuntimeSnapshotV2(layout, 'baseline');
    const complete = readLatestPortableSnapshotV2Sync(layout)!;
    const missingObjectManifest: PortableSnapshotV2Manifest = {
      ...complete,
      createdAt: new Date(Date.now() + 60_000).toISOString(),
      reason: 'missing-object',
      entries: {
        'state.json': {
          ...complete.entries['state.json'],
          object: 'f'.repeat(64),
        },
      },
    };
    await writeManifest(
      layout,
      missingObjectManifest,
      `snapshot-${Date.now() + 60_000}-99999999999999999999-corrupt.json`,
    );

    const result = await syncPortableRuntimeSnapshotV2(layout, 'periodic');

    expect(result.skipped).toBe(true);
    expect(readLatestPortableSnapshotV2Sync(layout)?.entries['state.json']).toEqual(complete.entries['state.json']);
  });

  it('repairs a same-size corrupt object when its local file is captured again', async () => {
    const layout = await createLayout();
    const stateFile = join(layout.stateDir, 'state.json');
    await writeFile(stateFile, '{"version":1}\n');
    await syncPortableRuntimeSnapshotV2(layout, 'baseline');
    const manifest = readLatestPortableSnapshotV2Sync(layout)!;
    const entry = manifest.entries['state.json'];
    const storedObject = join(layout.snapshotDir, 'objects', entry.object.slice(0, 2), entry.object);
    await writeFile(storedObject, 'x'.repeat(entry.size));
    const future = new Date(Date.now() + 5_000);
    await utimes(stateFile, future, future);

    await syncPortableRuntimeSnapshotV2(layout, 'repair');
    await rm(layout.stateDir, { recursive: true, force: true });

    expect(restorePortableRuntimeSnapshotV2Sync(layout, layout.stateDir)).toBe(true);
    await expect(readFile(stateFile, 'utf8')).resolves.toBe('{"version":1}\n');
  });

  it('repairs a same-size corrupt object during a scheduled integrity verification', async () => {
    const layout = await createLayout();
    const stateFile = join(layout.stateDir, 'state.json');
    await writeFile(stateFile, '{"version":1}\n');
    await syncPortableRuntimeSnapshotV2(layout, 'baseline');
    const manifest = readLatestPortableSnapshotV2Sync(layout)!;
    const entry = manifest.entries['state.json'];
    const storedObject = join(layout.snapshotDir, 'objects', entry.object.slice(0, 2), entry.object);
    await writeFile(storedObject, 'x'.repeat(entry.size));

    const result = await syncPortableRuntimeSnapshotV2(layout, 'integrity', {
      verifyExistingObjects: true,
    } as Parameters<typeof syncPortableRuntimeSnapshotV2>[2]);
    await rm(layout.stateDir, { recursive: true, force: true });

    expect(result.skipped).toBe(false);
    expect(restorePortableRuntimeSnapshotV2Sync(layout, layout.stateDir)).toBe(true);
    await expect(readFile(stateFile, 'utf8')).resolves.toBe('{"version":1}\n');
  });

  it('retains the latest three generations when the system clock moves backwards', async () => {
    vi.useFakeTimers();
    const layout = await createLayout();
    for (let generation = 1; generation <= 4; generation += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 10 - generation)));
      await writeFile(join(layout.stateDir, 'state.json'), `${JSON.stringify({ generation })}\n`, 'utf8');
      await syncPortableRuntimeSnapshotV2(layout, `generation-${generation}`);
    }

    const manifestDir = join(layout.snapshotDir, 'manifests');
    const generations = await Promise.all((await readdir(manifestDir)).map(async (name) => {
      const manifest = JSON.parse(await readFile(join(manifestDir, name), 'utf8')) as { generation: number };
      return manifest.generation;
    }));
    expect(generations.sort((left, right) => right - left)).toEqual([4, 3, 2]);
  });

  it('performs zero USB writes for an unchanged 5000-file state', async () => {
    const layout = await createLayout();
    const filesDir = join(layout.stateDir, 'workspace', 'many-files');
    await mkdir(filesDir, { recursive: true });
    for (let offset = 0; offset < 5_000; offset += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, index) => (
        writeFile(join(filesDir, `file-${String(offset + index).padStart(4, '0')}.txt`), 'same-content')
      )));
    }

    await syncPortableRuntimeSnapshotV2(layout, 'baseline');
    const manifests = await listFiles(join(layout.snapshotDir, 'manifests'));
    const second = await syncPortableRuntimeSnapshotV2(layout, 'periodic');

    expect(second).toMatchObject({
      skipped: true,
      scannedFiles: 5_000,
      changedFiles: 0,
      reusedFiles: 5_000,
      writtenObjects: 0,
      writtenBytes: 0,
    });
    expect(await listFiles(join(layout.snapshotDir, 'manifests'))).toEqual(manifests);
  }, 30_000);
});
