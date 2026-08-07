// @vitest-environment node

import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const unstableFiles = vi.hoisted(() => new Set<string>());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream(filePath: import('node:fs').PathLike, options?: Parameters<typeof actual.createReadStream>[1]) {
      const stream = actual.createReadStream(filePath, options);
      if (unstableFiles.has(String(filePath))) {
        stream.once('data', () => actual.appendFileSync(filePath, 'changed'));
      }
      return stream;
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

  it('keeps an entire SQLite file group on its previous stable version', async () => {
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

    expect(latest.entries['history.db']).toEqual(previous.entries['history.db']);
    expect(latest.entries['history.db-wal']).toEqual(previous.entries['history.db-wal']);
    expect(latest.entries['agent.json']).not.toEqual(previous.entries['agent.json']);
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
