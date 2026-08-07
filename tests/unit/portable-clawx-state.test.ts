// @vitest-environment node

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const restorePublishFailureTargets = vi.hoisted(() => new Set<string>());
const backupPublishFailureTargets = vi.hoisted(() => new Set<string>());
const backupRollbackFailureTargets = vi.hoisted(() => new Set<string>());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync(source: import('node:fs').PathLike, target: import('node:fs').PathLike) {
      if (restorePublishFailureTargets.has(String(target))) {
        const error = new Error('Injected core-state publish failure') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return actual.renameSync(source, target);
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async rename(source: import('node:fs').PathLike, target: import('node:fs').PathLike) {
      const sourcePath = String(source);
      const targetPath = String(target);
      if (
        (backupPublishFailureTargets.has(targetPath) && sourcePath.includes('.staging-'))
        || (backupRollbackFailureTargets.has(targetPath) && sourcePath.includes('.previous-'))
      ) {
        const error = new Error('Injected core-state backup rename failure') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return actual.rename(source, target);
    },
  };
});
import {
  preparePortableClawXStateSync,
  syncPortableClawXState,
  type PortableClawXStateLayout,
} from '@electron/utils/portable-clawx-state';

const tempDirs: string[] = [];

afterEach(async () => {
  restorePublishFailureTargets.clear();
  backupPublishFailureTargets.clear();
  backupRollbackFailureTargets.clear();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createLayout(): Promise<PortableClawXStateLayout> {
  const root = await mkdtemp(join(tmpdir(), 'uclaw-portable-clawx-state-'));
  tempDirs.push(root);
  const layout = {
    sourceDir: join(root, 'UClawData', 'clawx'),
    backupDir: join(root, 'runtime-profile', 'clawx-core-state'),
  };
  await mkdir(layout.sourceDir, { recursive: true });
  return layout;
}

describe('portable ClawX core state', () => {
  it('backs up and restores only top-level persistent JSON files', async () => {
    const layout = await createLayout();
    await writeFile(join(layout.sourceDir, 'settings.json'), '{"theme":"dark"}\n', 'utf8');
    await writeFile(join(layout.sourceDir, 'clawx-providers.json'), '{"provider":"uclaw"}\n', 'utf8');
    await writeFile(join(layout.sourceDir, 'uclaw-device-identity.json'), '{"device":"stable"}\n', 'utf8');
    await mkdir(join(layout.sourceDir, 'electron-session', 'Cache'), { recursive: true });
    await writeFile(join(layout.sourceDir, 'electron-session', 'Cache', 'cache.bin'), 'cache');
    await mkdir(join(layout.sourceDir, 'logs'), { recursive: true });
    await writeFile(join(layout.sourceDir, 'logs', 'clawx.log'), 'log');

    const result = await syncPortableClawXState(layout);
    expect(result).toMatchObject({ skipped: false, fileCount: 3 });

    await rm(layout.sourceDir, { recursive: true, force: true });
    await mkdir(layout.sourceDir, { recursive: true });
    expect(preparePortableClawXStateSync(layout)).toBe(true);

    await expect(readFile(join(layout.sourceDir, 'settings.json'), 'utf8')).resolves.toContain('dark');
    await expect(readFile(join(layout.sourceDir, 'clawx-providers.json'), 'utf8')).resolves.toContain('uclaw');
    await expect(readFile(join(layout.sourceDir, 'uclaw-device-identity.json'), 'utf8')).resolves.toContain('stable');
    await expect(readFile(join(layout.sourceDir, 'electron-session', 'Cache', 'cache.bin'))).rejects.toThrow();
    await expect(readFile(join(layout.sourceDir, 'logs', 'clawx.log'))).rejects.toThrow();
  });

  it('refuses a corrupt backup without partially restoring files', async () => {
    const layout = await createLayout();
    await writeFile(join(layout.sourceDir, 'settings.json'), '{"valid":true}\n', 'utf8');
    await writeFile(join(layout.sourceDir, 'clawx-providers.json'), '{"valid":true}\n', 'utf8');
    await syncPortableClawXState(layout);
    await writeFile(join(layout.backupDir, 'current', 'settings.json'), '{"corrupt":true}\n', 'utf8');
    await rm(layout.sourceDir, { recursive: true, force: true });
    await mkdir(layout.sourceDir, { recursive: true });

    expect(preparePortableClawXStateSync(layout)).toBe(false);
    await expect(readFile(join(layout.sourceDir, 'settings.json'))).rejects.toThrow();
    await expect(readFile(join(layout.sourceDir, 'clawx-providers.json'))).rejects.toThrow();
  });

  it('rolls back every published JSON file when restoring one file fails', async () => {
    const layout = await createLayout();
    await writeFile(join(layout.sourceDir, 'clawx-providers.json'), '{"provider":"uclaw"}\n', 'utf8');
    await writeFile(join(layout.sourceDir, 'settings.json'), '{"theme":"dark"}\n', 'utf8');
    await syncPortableClawXState(layout);
    await rm(layout.sourceDir, { recursive: true, force: true });
    await mkdir(layout.sourceDir, { recursive: true });
    restorePublishFailureTargets.add(join(layout.sourceDir, 'settings.json'));

    expect(preparePortableClawXStateSync(layout)).toBe(false);
    await expect(readFile(join(layout.sourceDir, 'clawx-providers.json'))).rejects.toThrow();
    await expect(readFile(join(layout.sourceDir, 'settings.json'))).rejects.toThrow();
  });

  it('retains the previous backup generation when publish and rollback both fail', async () => {
    const layout = await createLayout();
    await writeFile(join(layout.sourceDir, 'settings.json'), '{"version":1}\n', 'utf8');
    await syncPortableClawXState(layout);
    await writeFile(join(layout.sourceDir, 'settings.json'), '{"version":2}\n', 'utf8');
    const current = join(layout.backupDir, 'current');
    backupPublishFailureTargets.add(current);
    backupRollbackFailureTargets.add(current);

    await expect(syncPortableClawXState(layout)).rejects.toThrow('Injected core-state backup rename failure');

    const recoveryGeneration = (await readdir(layout.backupDir))
      .find((name) => name.startsWith('.previous-'));
    expect(recoveryGeneration).toBeTruthy();
    await expect(readFile(
      join(layout.backupDir, recoveryGeneration!, 'settings.json'),
      'utf8',
    )).resolves.toBe('{"version":1}\n');
  });
});
