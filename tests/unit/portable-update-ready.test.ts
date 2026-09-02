// @vitest-environment node

import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getVersion: vi.fn(() => '2.0.4'),
  },
  portable: {
    enabled: true,
    runtimeUpdatesDir: '',
  },
}));

vi.mock('electron', () => ({ app: state.app }));
vi.mock('@electron/utils/portable-mode', () => ({
  getPortableModeInfo: () => state.portable,
}));

const temporaryRoots: string[] = [];

beforeEach(() => {
  state.app.isPackaged = true;
  state.app.getVersion.mockReturnValue('2.0.4');
  state.portable.enabled = true;
  state.portable.runtimeUpdatesDir = '';
  delete process.env.UCLAW_PORTABLE_UPDATE_READY_PATH;
});

afterEach(async () => {
  delete process.env.UCLAW_PORTABLE_UPDATE_READY_PATH;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('portable update startup readiness marker', () => {
  it('writes an atomic marker only inside the portable runtime ready directory', async () => {
    const runtimeUpdatesDir = await mkdtemp(join(tmpdir(), 'uclaw-ready-marker-'));
    temporaryRoots.push(runtimeUpdatesDir);
    state.portable.runtimeUpdatesDir = runtimeUpdatesDir;
    const readyPath = join(runtimeUpdatesDir, 'ready', 'portable-update-attempt.ready.json');
    process.env.UCLAW_PORTABLE_UPDATE_READY_PATH = readyPath;

    const { writePortableUpdateReadyMarker } = await import('@electron/main/portable-update-ready');
    await expect(writePortableUpdateReadyMarker()).resolves.toBe(true);

    const marker = JSON.parse(await readFile(readyPath, 'utf8')) as {
      version?: string;
      pid?: number;
      readyAt?: string;
    };
    expect(marker.version).toBe('2.0.4');
    expect(marker.pid).toBe(process.pid);
    expect(marker.readyAt).toEqual(expect.any(String));
    await expect(access(`${readyPath}.${process.pid}.tmp`, fsConstants.F_OK)).rejects.toThrow();
  });

  it('fails closed for a marker path outside the runtime ready directory', async () => {
    const runtimeUpdatesDir = await mkdtemp(join(tmpdir(), 'uclaw-ready-marker-'));
    temporaryRoots.push(runtimeUpdatesDir);
    state.portable.runtimeUpdatesDir = runtimeUpdatesDir;
    const outsidePath = join(runtimeUpdatesDir, '..', 'outside.ready.json');
    process.env.UCLAW_PORTABLE_UPDATE_READY_PATH = outsidePath;

    const { writePortableUpdateReadyMarker } = await import('@electron/main/portable-update-ready');
    await expect(writePortableUpdateReadyMarker()).rejects.toThrow(/outside the runtime ready directory/i);
  });

  it('rejects readiness markers from non-portable or unpackaged launches', async () => {
    const runtimeUpdatesDir = await mkdtemp(join(tmpdir(), 'uclaw-ready-marker-'));
    temporaryRoots.push(runtimeUpdatesDir);
    state.portable.runtimeUpdatesDir = runtimeUpdatesDir;
    process.env.UCLAW_PORTABLE_UPDATE_READY_PATH = join(
      runtimeUpdatesDir,
      'ready',
      'portable-update-attempt.ready.json',
    );
    const { writePortableUpdateReadyMarker } = await import('@electron/main/portable-update-ready');

    state.portable.enabled = false;
    await expect(writePortableUpdateReadyMarker()).rejects.toThrow(/outside portable packaged mode/i);

    state.portable.enabled = true;
    state.app.isPackaged = false;
    await expect(writePortableUpdateReadyMarker()).rejects.toThrow(/outside portable packaged mode/i);
  });

  it('returns false when the helper did not request a readiness marker', async () => {
    const { writePortableUpdateReadyMarker } = await import('@electron/main/portable-update-ready');
    await expect(writePortableUpdateReadyMarker()).resolves.toBe(false);
  });
});
