// @vitest-environment node

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  preparePortableRuntimeState,
  resolvePortableRuntimeLayout,
  syncPortableRuntimeSnapshot,
} from '@electron/utils/portable-runtime-state';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
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
});
