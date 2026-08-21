import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsPromises = vi.hoisted(() => ({
  access: vi.fn(),
  copyFile: vi.fn(),
  lstat: vi.fn(),
  mkdir: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  realpath: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));

const delay = vi.hoisted(() => vi.fn(async (_delayMs: number) => undefined));
const logger = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const mocked = { ...actual, ...fsPromises };
  return {
    ...mocked,
    default: mocked,
  };
});

vi.mock('node:timers/promises', async () => {
  const actual = await vi.importActual<typeof import('node:timers/promises')>('node:timers/promises');
  const mocked = { ...actual, setTimeout: delay };
  return {
    ...mocked,
    default: mocked,
  };
});

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => 'C:\\UClaw'),
    isPackaged: true,
  },
}));

vi.mock('@electron/utils/config-mutex', () => ({
  withConfigLock: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

vi.mock('@electron/utils/logger', () => ({ logger }));

vi.mock('@electron/utils/plugin-install-index', () => ({
  upsertPluginInstallRecordsIntoSqlite: vi.fn(() => false),
}));

vi.mock('@electron/utils/paths', () => ({
  resolveOpenClawConfigPath: vi.fn(() => 'C:\\uclaw-test-state\\openclaw.json'),
  resolveOpenClawStateDir: vi.fn(() => 'C:\\uclaw-test-state'),
}));

const TRANSIENT_CODES = ['EPERM', 'EACCES', 'EBUSY'] as const;
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

function forbidAtomicsWait(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(Atomics, 'wait').mockImplementation(() => {
    throw new Error('Atomics.wait must not run in the asynchronous install path');
  });
}

describe('plugin installer asynchronous filesystem retries', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });

    fsPromises.access.mockRejectedValue(errno('ENOENT'));
    fsPromises.copyFile.mockResolvedValue(undefined);
    fsPromises.lstat.mockRejectedValue(errno('ENOENT'));
    fsPromises.mkdir.mockResolvedValue(undefined);
    fsPromises.readFile.mockResolvedValue('{}');
    fsPromises.readdir.mockResolvedValue([]);
    fsPromises.realpath.mockImplementation(async (filePath: string) => filePath);
    fsPromises.rename.mockResolvedValue(undefined);
    fsPromises.rm.mockResolvedValue(undefined);
    fsPromises.stat.mockResolvedValue({ isDirectory: () => false, mtimeMs: 1 });
    fsPromises.unlink.mockResolvedValue(undefined);
    fsPromises.writeFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
    vi.restoreAllMocks();
  });

  it.each(TRANSIENT_CODES)(
    'retries work-root cleanup after one %s using asynchronous delay',
    async (code) => {
      const atomicsWait = forbidAtomicsWait();
      fsPromises.rm
        .mockRejectedValueOnce(errno(code))
        .mockResolvedValueOnce(undefined);

      const { cleanupStalePluginInstallArtifacts } = await import('@electron/utils/plugin-install');
      await expect(cleanupStalePluginInstallArtifacts()).resolves.toBe(true);

      expect(fsPromises.rm).toHaveBeenCalledTimes(2);
      expect(delay).toHaveBeenCalledTimes(1);
      expect(delay).toHaveBeenCalledWith(50);
      expect(atomicsWait).not.toHaveBeenCalled();
    },
  );

  it('does not retry a non-transient work-root cleanup error', async () => {
    const atomicsWait = forbidAtomicsWait();
    fsPromises.rm.mockRejectedValueOnce(errno('EIO'));

    const { cleanupStalePluginInstallArtifacts } = await import('@electron/utils/plugin-install');
    await expect(cleanupStalePluginInstallArtifacts()).resolves.toBe(false);

    expect(fsPromises.rm).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[plugin] Failed to clean plugin install work directory',
      expect.objectContaining({ code: 'EIO' }),
    );
    expect(atomicsWait).not.toHaveBeenCalled();
  });

  it('exhausts transient work-root cleanup retries and preserves the errno diagnostic', async () => {
    const atomicsWait = forbidAtomicsWait();
    fsPromises.rm.mockRejectedValue(errno('EPERM'));

    const { cleanupStalePluginInstallArtifacts } = await import('@electron/utils/plugin-install');
    await expect(cleanupStalePluginInstallArtifacts()).resolves.toBe(false);

    expect(fsPromises.rm).toHaveBeenCalledTimes(5);
    expect(delay.mock.calls.map(([delayMs]) => delayMs)).toEqual([50, 150, 300, 600]);
    expect(logger.warn).toHaveBeenCalledWith(
      '[plugin] Failed to clean plugin install work directory',
      expect.objectContaining({ code: 'EPERM' }),
    );
    expect(atomicsWait).not.toHaveBeenCalled();
  });

  it('classifies a staging copy failure through the public install entrypoint', async () => {
    const atomicsWait = forbidAtomicsWait();
    const sourceDir = 'C:\\plugin-source';
    const sourceManifest = `${sourceDir}\\openclaw.plugin.json`;

    fsPromises.access.mockImplementation(async (filePath: string) => {
      if (String(filePath).replace(/^\\\\\?\\/, '') === sourceManifest) return undefined;
      throw errno('ENOENT');
    });
    fsPromises.readFile.mockImplementation(async (filePath: string) => {
      if (String(filePath).endsWith('package.json')) {
        return JSON.stringify({ main: 'index.mjs', name: 'fixture-plugin', version: '1.0.0' });
      }
      return JSON.stringify({ entry: 'index.mjs', id: 'fixture-plugin', version: '1.0.0' });
    });
    fsPromises.readdir.mockResolvedValue([{ name: 'index.mjs' }]);
    fsPromises.copyFile.mockRejectedValue(errno('EIO'));

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    await expect(ensurePluginInstalled('fixture-plugin', [sourceDir], 'Fixture')).resolves.toEqual({
      installed: false,
      warning: 'Failed to install bundled Fixture plugin mirror',
    });

    expect(fsPromises.copyFile).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      '[plugin] Bundled mirror install failed for Fixture',
      expect.objectContaining({
        attempts: [
          expect.objectContaining({ attempt: 1, code: 'EIO', phase: 'staging-copy' }),
          expect.objectContaining({ attempt: 2, code: 'EIO', phase: 'staging-copy' }),
        ],
      }),
    );
    expect(atomicsWait).not.toHaveBeenCalled();
  });
});
