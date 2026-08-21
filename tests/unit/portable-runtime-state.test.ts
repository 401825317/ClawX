// @vitest-environment node

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sqliteBackupFailure = vi.hoisted(() => ({ value: false }));

vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>();
  return {
    ...actual,
    backup(...args: Parameters<typeof actual.backup>) {
      if (sqliteBackupFailure.value) {
        const error = new Error('Injected SQLite online backup failure') as NodeJS.ErrnoException;
        error.code = 'SQLITE_BUSY';
        return Promise.reject(error);
      }
      return actual.backup(...args);
    },
  };
});
import {
  PortableRuntimeSnapshotService,
  preparePortableRuntimeState,
  resolvePortableRuntimeLayout,
  syncPortableRuntimeSnapshot,
} from '@electron/utils/portable-runtime-state';
import {
  readLatestPortableSnapshotV2Sync,
  syncPortableRuntimeSnapshotV2,
} from '@electron/utils/portable-runtime-snapshot-v2';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  sqliteBackupFailure.value = false;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createLayout() {
  const root = await mkdtemp(join(tmpdir(), 'uclaw-portable-runtime-'));
  tempDirs.push(root);
  const portableRoot = join(root, 'usb');
  const dataDir = join(portableRoot, 'UClawData');
  const legacyStateDir = join(dataDir, 'openclaw-home', '.openclaw');
  const runtimeRootDir = join(root, 'runtime');
  await mkdir(portableRoot, { recursive: true });
  return resolvePortableRuntimeLayout({ rootDir: portableRoot, dataDir, legacyStateDir, runtimeRootDir });
}

describe('portable runtime state', () => {
  it('persists one durable portable ID for repeated launches', async () => {
    const first = await createLayout();
    const second = resolvePortableRuntimeLayout({
      rootDir: first.rootDir,
      dataDir: first.dataDir,
      legacyStateDir: first.legacyStateDir,
      runtimeRootDir: first.runtimeRootDir,
    });

    expect(second.portableId).toBe(first.portableId);
    await expect(readFile(first.portableIdPath, 'utf8')).resolves.toContain(first.portableId);
    expect(first.stateDir).toContain(join('profiles', first.portableId));
  });

  it('recovers a missing data-directory portable ID from the portable-root mirror', async () => {
    const first = await createLayout();
    const rootMirrorPath = join(first.rootDir, '.uclaw-portable-id');
    await expect(readFile(rootMirrorPath, 'utf8')).resolves.toContain(first.portableId);
    await rm(first.portableIdPath, { force: true });

    const recovered = resolvePortableRuntimeLayout({
      rootDir: first.rootDir,
      dataDir: first.dataDir,
      legacyStateDir: first.legacyStateDir,
      runtimeRootDir: first.runtimeRootDir,
    });

    expect(recovered.portableId).toBe(first.portableId);
    await expect(readFile(recovered.portableIdPath, 'utf8')).resolves.toContain(first.portableId);
  });

  it('repairs a conflicting portable-root mirror from the data-directory identity', async () => {
    const first = await createLayout();
    const rootMirrorPath = join(first.rootDir, '.uclaw-portable-id');
    await writeFile(rootMirrorPath, 'conflicting-portable-id\n', 'utf8');

    const repaired = resolvePortableRuntimeLayout({
      rootDir: first.rootDir,
      dataDir: first.dataDir,
      legacyStateDir: first.legacyStateDir,
      runtimeRootDir: first.runtimeRootDir,
    });

    expect(repaired.portableId).toBe(first.portableId);
    await expect(readFile(rootMirrorPath, 'utf8')).resolves.toBe(`${first.portableId}\n`);
  });

  it('recovers a missing portable ID from the only snapshot identity', async () => {
    const first = await createLayout();
    await mkdir(first.stateDir, { recursive: true });
    await writeFile(join(first.stateDir, 'openclaw.json'), '{"portable":true}\n', 'utf8');
    await syncPortableRuntimeSnapshotV2({
      stateDir: first.stateDir,
      snapshotDir: first.snapshotV2Dir,
      portableId: first.portableId,
    }, 'identity-source');
    await rm(first.portableIdPath, { force: true });
    await rm(join(first.rootDir, '.uclaw-portable-id'), { force: true });

    const recovered = resolvePortableRuntimeLayout({
      rootDir: first.rootDir,
      dataDir: first.dataDir,
      legacyStateDir: first.legacyStateDir,
      runtimeRootDir: first.runtimeRootDir,
    });

    expect(recovered.portableId).toBe(first.portableId);
    await expect(readFile(recovered.portableIdPath, 'utf8')).resolves.toContain(first.portableId);
    await expect(readFile(join(first.rootDir, '.uclaw-portable-id'), 'utf8')).resolves.toContain(first.portableId);
  });

  it('restores legacy state when no complete snapshot exists', async () => {
    const layout = await createLayout();
    await mkdir(layout.legacyStateDir, { recursive: true });
    await writeFile(join(layout.legacyStateDir, 'openclaw.json'), '{"legacy":true}\n', 'utf8');
    await mkdir(join(layout.snapshotDir, 'incomplete', 'state'), { recursive: true });
    await writeFile(join(layout.snapshotDir, 'incomplete', 'state', 'openclaw.json'), '{"bad":true}\n', 'utf8');

    preparePortableRuntimeState(layout);

    await expect(readFile(join(layout.stateDir, 'openclaw.json'), 'utf8')).resolves.toContain('legacy');
    await expect(readFile(layout.markerPath, 'utf8')).resolves.toContain(layout.portableId);
  });

  it('writes only complete snapshots, skips volatile files, and retains the latest three', async () => {
    vi.useFakeTimers();
    const layout = await createLayout();
    await mkdir(layout.stateDir, { recursive: true });
    await writeFile(join(layout.stateDir, 'openclaw.json'), '{"ok":true}\n', 'utf8');
    await writeFile(join(layout.stateDir, 'active.lock'), 'skip\n', 'utf8');
    await mkdir(join(layout.stateDir, 'logs'), { recursive: true });
    await writeFile(join(layout.stateDir, 'logs', 'gateway.log'), 'skip\n', 'utf8');

    for (let index = 0; index < 4; index += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 6, 25, 0, 0, index)));
      await syncPortableRuntimeSnapshot(layout, `test-${index}`);
    }

    const snapshots = (await readdir(layout.snapshotDir)).filter((name) => name.startsWith('snapshot-'));
    expect(snapshots).toHaveLength(3);
    for (const snapshot of snapshots) {
      const snapshotRoot = join(layout.snapshotDir, snapshot);
      const manifest = JSON.parse(await readFile(join(snapshotRoot, 'snapshot-complete.json'), 'utf8'));
      expect(manifest.portableId).toBe(layout.portableId);
      expect(manifest.fileCount).toBe(1);
      await expect(readFile(join(snapshotRoot, 'state', 'openclaw.json'), 'utf8')).resolves.toContain('ok');
      await expect(readFile(join(snapshotRoot, 'state', 'active.lock'), 'utf8')).rejects.toThrow();
    }
  });

  it('restores v2 before v1 when both portable snapshot formats exist', async () => {
    const layout = await createLayout();
    await mkdir(layout.stateDir, { recursive: true });
    await writeFile(join(layout.stateDir, 'openclaw.json'), '{"source":"v1"}\n', 'utf8');
    await syncPortableRuntimeSnapshot(layout, 'v1');

    await writeFile(join(layout.stateDir, 'openclaw.json'), '{"source":"v2"}\n', 'utf8');
    await syncPortableRuntimeSnapshotV2({
      stateDir: layout.stateDir,
      snapshotDir: layout.snapshotV2Dir,
      portableId: layout.portableId,
    }, 'v2');
    await rm(layout.stateDir, { recursive: true, force: true });

    preparePortableRuntimeState(layout);

    await expect(readFile(join(layout.stateDir, 'openclaw.json'), 'utf8')).resolves.toContain('v2');
  });

  it('replaces a clean stale local state when the USB has a newer generation', async () => {
    const layout = await createLayout();
    await mkdir(layout.stateDir, { recursive: true });
    await writeFile(join(layout.stateDir, 'openclaw.json'), '{"source":"generation-1"}\n', 'utf8');
    await syncPortableRuntimeSnapshotV2({
      stateDir: layout.stateDir,
      snapshotDir: layout.snapshotV2Dir,
      portableId: layout.portableId,
    }, 'generation-1');
    const first = readLatestPortableSnapshotV2Sync({
      stateDir: layout.stateDir,
      snapshotDir: layout.snapshotV2Dir,
      portableId: layout.portableId,
    })!;

    await writeFile(join(layout.stateDir, 'openclaw.json'), '{"source":"generation-2"}\n', 'utf8');
    await syncPortableRuntimeSnapshotV2({
      stateDir: layout.stateDir,
      snapshotDir: layout.snapshotV2Dir,
      portableId: layout.portableId,
    }, 'generation-2');
    await writeFile(join(layout.stateDir, 'openclaw.json'), '{"source":"stale-local"}\n', 'utf8');
    await writeFile(layout.markerPath, `${JSON.stringify({
      schema: 'uclaw.portable-runtime-state/v1',
      portableId: layout.portableId,
      preparedAt: new Date().toISOString(),
      lastAppliedSnapshotId: first.snapshotId,
      lastAppliedGeneration: first.generation,
      lifecycle: 'clean',
    })}\n`, 'utf8');

    preparePortableRuntimeState(layout);

    await expect(readFile(join(layout.stateDir, 'openclaw.json'), 'utf8')).resolves.toContain('generation-2');
    await expect(readdir(join(layout.profileDir, 'recovery'))).resolves.toEqual([]);
  });

  it('preserves an unclean stale local state before applying a newer USB generation', async () => {
    const layout = await createLayout();
    await mkdir(layout.stateDir, { recursive: true });
    await writeFile(join(layout.stateDir, 'openclaw.json'), '{"source":"generation-1"}\n', 'utf8');
    await syncPortableRuntimeSnapshotV2({
      stateDir: layout.stateDir,
      snapshotDir: layout.snapshotV2Dir,
      portableId: layout.portableId,
    }, 'generation-1');
    const first = readLatestPortableSnapshotV2Sync({
      stateDir: layout.stateDir,
      snapshotDir: layout.snapshotV2Dir,
      portableId: layout.portableId,
    })!;

    await writeFile(join(layout.stateDir, 'openclaw.json'), '{"source":"generation-2"}\n', 'utf8');
    await syncPortableRuntimeSnapshotV2({
      stateDir: layout.stateDir,
      snapshotDir: layout.snapshotV2Dir,
      portableId: layout.portableId,
    }, 'generation-2');
    await writeFile(join(layout.stateDir, 'openclaw.json'), '{"source":"unsynced-local"}\n', 'utf8');
    await writeFile(layout.markerPath, `${JSON.stringify({
      schema: 'uclaw.portable-runtime-state/v1',
      portableId: layout.portableId,
      preparedAt: new Date().toISOString(),
      lastAppliedSnapshotId: first.snapshotId,
      lastAppliedGeneration: first.generation,
      lifecycle: 'active',
    })}\n`, 'utf8');

    preparePortableRuntimeState(layout);

    await expect(readFile(join(layout.stateDir, 'openclaw.json'), 'utf8')).resolves.toContain('generation-2');
    const recoveryEntries = await readdir(join(layout.profileDir, 'recovery'));
    expect(recoveryEntries).toHaveLength(1);
    await expect(readFile(
      join(layout.profileDir, 'recovery', recoveryEntries[0], 'openclaw.json'),
      'utf8',
    )).resolves.toContain('unsynced-local');
  });

  it('falls back to v1 when the latest v2 snapshot is corrupt', async () => {
    const layout = await createLayout();
    await mkdir(layout.stateDir, { recursive: true });
    await writeFile(join(layout.stateDir, 'openclaw.json'), '{"source":"v1"}\n', 'utf8');
    await syncPortableRuntimeSnapshot(layout, 'v1');

    await writeFile(join(layout.stateDir, 'openclaw.json'), '{"source":"v2"}\n', 'utf8');
    const v2Layout = {
      stateDir: layout.stateDir,
      snapshotDir: layout.snapshotV2Dir,
      portableId: layout.portableId,
    };
    await syncPortableRuntimeSnapshotV2(v2Layout, 'v2');
    const object = readLatestPortableSnapshotV2Sync(v2Layout)?.entries['openclaw.json'].object;
    expect(object).toBeTruthy();
    await writeFile(join(layout.snapshotV2Dir, 'objects', object!.slice(0, 2), object!), 'corrupt');
    await rm(layout.stateDir, { recursive: true, force: true });

    preparePortableRuntimeState(layout);

    await expect(readFile(join(layout.stateDir, 'openclaw.json'), 'utf8')).resolves.toContain('v1');
  });

  it('uses incremental v2 snapshots for the periodic snapshot service', async () => {
    const layout = await createLayout();
    const logs: Array<{ message: string; details?: unknown }> = [];
    await mkdir(layout.stateDir, { recursive: true });
    await writeFile(join(layout.stateDir, 'openclaw.json'), '{"managed":true}\n', 'utf8');
    const service = new PortableRuntimeSnapshotService(
      layout,
      (message, details) => logs.push({ message, details }),
    );

    await service.sync('test');

    expect(readLatestPortableSnapshotV2Sync({
      stateDir: layout.stateDir,
      snapshotDir: layout.snapshotV2Dir,
      portableId: layout.portableId,
    })).toBeTruthy();
    await expect(readdir(layout.snapshotDir)).rejects.toThrow();
    expect(logs).toContainEqual(expect.objectContaining({
      message: 'Portable Runtime snapshot completed',
      details: expect.objectContaining({ writtenObjects: 1, changedFiles: 1 }),
    }));
  });

  it('mirrors portable ClawX core JSON during a snapshot service sync', async () => {
    const layout = await createLayout();
    await mkdir(layout.stateDir, { recursive: true });
    await writeFile(join(layout.stateDir, 'openclaw.json'), '{"managed":true}\n', 'utf8');
    const clawxDataDir = join(layout.dataDir, 'clawx');
    await mkdir(clawxDataDir, { recursive: true });
    await writeFile(join(clawxDataDir, 'settings.json'), '{"language":"zh"}\n', 'utf8');
    await mkdir(join(clawxDataDir, 'electron-session'), { recursive: true });
    await writeFile(join(clawxDataDir, 'electron-session', 'Cookies'), 'skip', 'utf8');
    const service = new PortableRuntimeSnapshotService(layout);

    await service.sync('test');

    await expect(readFile(
      join(layout.profileDir, 'clawx-core-state', 'current', 'settings.json'),
      'utf8',
    )).resolves.toContain('zh');
    await expect(readFile(
      join(layout.profileDir, 'clawx-core-state', 'current', 'electron-session', 'Cookies'),
    )).rejects.toThrow();
  });

  it('skips clean periodic ticks and scans again after being marked dirty', async () => {
    const layout = await createLayout();
    await mkdir(layout.stateDir, { recursive: true });
    await writeFile(join(layout.stateDir, 'openclaw.json'), '{"version":1}\n', 'utf8');
    const logs: Array<{ message: string; details?: unknown }> = [];
    const service = new PortableRuntimeSnapshotService(
      layout,
      (message, details) => logs.push({ message, details }),
      5 * 60_000,
      { watch: false, integrityIntervalMs: 1_000 },
    );

    await service.syncIfNeeded();
    expect(logs.filter((entry) => entry.message === 'Portable Runtime snapshot completed')).toHaveLength(1);

    await service.syncIfNeeded();
    expect(logs.filter((entry) => entry.message === 'Portable Runtime snapshot completed')).toHaveLength(1);

    service.markDirty();
    await service.syncIfNeeded();
    expect(logs.filter((entry) => entry.message === 'Portable Runtime snapshot completed')).toHaveLength(2);
  });

  it('backs off repeated SQLite baseline deferrals and resumes after the source stabilizes', async () => {
    const layout = await createLayout();
    const logs: Array<{ message: string; details?: Record<string, unknown> }> = [];
    await mkdir(layout.stateDir, { recursive: true });
    const database = new DatabaseSync(join(layout.stateDir, 'main-agent.sqlite'));
    try {
      database.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
      let now = 0;
      sqliteBackupFailure.value = true;
      const service = new PortableRuntimeSnapshotService(
        layout,
        (message, details) => logs.push({ message, details: details as Record<string, unknown> | undefined }),
        5,
        {
          watch: false,
          now: () => now,
          deferBackoffBaseMs: 10,
          deferBackoffMaxMs: 40,
        },
      );

      await expect(service.syncIfNeeded()).resolves.toBe(false);
      now = 5;
      await expect(service.syncIfNeeded()).resolves.toBe(true);
      now = 10;
      await expect(service.syncIfNeeded()).resolves.toBe(false);
      now = 29;
      await expect(service.syncIfNeeded()).resolves.toBe(true);

      const deferrals = logs.filter((entry) => entry.message === 'Portable Runtime snapshot deferred');
      expect(deferrals).toHaveLength(2);
      expect(deferrals.map((entry) => entry.details)).toEqual([
        expect.objectContaining({
          event: 'portable-runtime-snapshot-deferred',
          severity: 'warning',
          attempt: 1,
          retryAfterMs: 10,
          deferredReason: 'sqlite-unstable',
          deferredPaths: ['main-agent.sqlite'],
          reusedPreviousSnapshot: false,
        }),
        expect.objectContaining({ attempt: 2, retryAfterMs: 20 }),
      ]);

      sqliteBackupFailure.value = false;
      now = 30;
      await expect(service.syncIfNeeded()).resolves.toBe(true);
      expect(logs.filter((entry) => entry.message === 'Portable Runtime snapshot completed')).toHaveLength(1);
      expect(readLatestPortableSnapshotV2Sync({
        stateDir: layout.stateDir,
        snapshotDir: layout.snapshotV2Dir,
        portableId: layout.portableId,
      })).toBeTruthy();
    } finally {
      sqliteBackupFailure.value = false;
      database.close();
    }
  });

  it('starts the periodic snapshot service without performing startup I/O', async () => {
    const layout = await createLayout();
    const logs: Array<{ message: string }> = [];
    const service = new PortableRuntimeSnapshotService(
      layout,
      (message) => logs.push({ message }),
      60_000,
      { watch: false },
    );

    service.start();
    service.stop();

    expect(logs.map((entry) => entry.message)).toEqual(['Portable Runtime snapshot service started']);
    expect(readLatestPortableSnapshotV2Sync({
      stateDir: layout.stateDir,
      snapshotDir: layout.snapshotV2Dir,
      portableId: layout.portableId,
    })).toBeUndefined();
  });

  it('marks the runtime clean only after a successful shutdown snapshot', async () => {
    const layout = await createLayout();
    await mkdir(layout.stateDir, { recursive: true });
    await writeFile(join(layout.stateDir, 'openclaw.json'), '{"shutdown":true}\n', 'utf8');
    preparePortableRuntimeState(layout);
    const service = new PortableRuntimeSnapshotService(layout);

    await service.sync('shutdown');

    const marker = JSON.parse(await readFile(layout.markerPath, 'utf8')) as {
      lifecycle?: string;
      lastAppliedGeneration?: number;
      lastAppliedSnapshotId?: string;
    };
    expect(marker.lifecycle).toBe('clean');
    expect(marker.lastAppliedGeneration).toBe(1);
    expect(marker.lastAppliedSnapshotId).toMatch(/^[a-f0-9-]{36}$/u);
  });

  it('marks the runtime clean when shutdown waits for an in-flight periodic snapshot', async () => {
    const layout = await createLayout();
    await mkdir(layout.stateDir, { recursive: true });
    for (let index = 0; index < 200; index += 1) {
      await writeFile(join(layout.stateDir, `state-${index}.json`), `${JSON.stringify({ index })}\n`, 'utf8');
    }
    preparePortableRuntimeState(layout);
    const service = new PortableRuntimeSnapshotService(layout);

    const periodic = service.sync('periodic');
    const shutdown = service.sync('shutdown');
    await Promise.all([periodic, shutdown]);

    const marker = JSON.parse(await readFile(layout.markerPath, 'utf8')) as { lifecycle?: string };
    expect(marker.lifecycle).toBe('clean');
  });
});
