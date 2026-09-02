import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const {
  mockReaddirSync,
  mockStatSync,
  mockCopyFileSync,
  mockCpSync,
  mockAsyncReaddir,
  mockAsyncLstat,
  mockAsyncStat,
  mockAsyncCopyFile,
  mockAsyncMkdir,
} = vi.hoisted(() => ({
  mockReaddirSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockCopyFileSync: vi.fn(),
  mockCpSync: vi.fn(),
  mockAsyncReaddir: vi.fn(),
  mockAsyncLstat: vi.fn(),
  mockAsyncStat: vi.fn(),
  mockAsyncCopyFile: vi.fn(),
  mockAsyncMkdir: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const mocked = {
    ...actual,
    readdirSync: mockReaddirSync,
    statSync: mockStatSync,
    copyFileSync: mockCopyFileSync,
    cpSync: mockCpSync,
  };

  return {
    ...mocked,
    default: mocked,
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const mocked = {
    ...actual,
    readdir: mockAsyncReaddir,
    lstat: mockAsyncLstat,
    stat: mockAsyncStat,
    copyFile: mockAsyncCopyFile,
    mkdir: mockAsyncMkdir,
  };

  return {
    ...mocked,
    default: mocked,
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
  },
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@electron/utils/plugin-install-index', () => ({
  ensureOpenClawStateDirExists: vi.fn(),
  upsertPluginInstallRecordsIntoSqlite: vi.fn(() => false),
}));

vi.mock('@electron/utils/paths', () => ({
  resolveOpenClawConfigPath: () => join(tmpdir(), 'uclaw-plugin-copy-test', 'openclaw.json'),
  resolveOpenClawStateDir: () => join(tmpdir(), 'uclaw-plugin-copy-test'),
}));

type FsPromises = typeof import('node:fs/promises');

let actualFs: FsPromises;
const temporaryRoots: string[] = [];

function callActual<T extends (...args: never[]) => unknown>(fn: T, args: unknown[]): unknown {
  return Reflect.apply(fn, actualFs, args);
}

async function createLargeTree(root: string): Promise<string> {
  const source = join(root, 'source');
  await actualFs.mkdir(source, { recursive: true });

  await Promise.all(Array.from({ length: 12 }, async (_, directoryIndex) => {
    const directory = join(source, `group-${directoryIndex}`, 'nested');
    await actualFs.mkdir(directory, { recursive: true });
    await Promise.all(Array.from({ length: 32 }, async (_, fileIndex) => {
      const contents = `group=${directoryIndex};file=${fileIndex};${'x'.repeat(256)}`;
      await actualFs.writeFile(join(directory, `file-${fileIndex}.txt`), contents, 'utf8');
    }));
  }));

  return source;
}

async function collectFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await actualFs.readdir(current, { withFileTypes: true })) {
    const entryPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, entryPath));
    } else {
      files.push(relative(root, entryPath));
    }
  }
  return files;
}

describe('plugin installer asynchronous directory copy', () => {
  beforeEach(async () => {
    vi.resetModules();
    actualFs = await vi.importActual<FsPromises>('node:fs/promises');

    mockReaddirSync.mockReset().mockImplementation(() => {
      throw new Error('readdirSync must not run in the asynchronous copy path');
    });
    mockStatSync.mockReset().mockImplementation(() => {
      throw new Error('statSync must not run in the asynchronous copy path');
    });
    mockCopyFileSync.mockReset().mockImplementation(() => {
      throw new Error('copyFileSync must not run in the asynchronous copy path');
    });
    mockCpSync.mockReset().mockImplementation(() => {
      throw new Error('cpSync must not run in the asynchronous copy path');
    });

    mockAsyncReaddir.mockReset().mockImplementation((...args: unknown[]) => (
      callActual(actualFs.readdir as (...innerArgs: never[]) => unknown, args)
    ));
    mockAsyncLstat.mockReset().mockImplementation((...args: unknown[]) => (
      callActual(actualFs.lstat as (...innerArgs: never[]) => unknown, args)
    ));
    mockAsyncStat.mockReset().mockImplementation((...args: unknown[]) => (
      callActual(actualFs.stat as (...innerArgs: never[]) => unknown, args)
    ));
    mockAsyncCopyFile.mockReset().mockImplementation((...args: unknown[]) => (
      callActual(actualFs.copyFile as (...innerArgs: never[]) => unknown, args)
    ));
    mockAsyncMkdir.mockReset().mockImplementation((...args: unknown[]) => (
      callActual(actualFs.mkdir as (...innerArgs: never[]) => unknown, args)
    ));
  });

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => (
      actualFs.rm(root, { recursive: true, force: true })
    )));
    vi.restoreAllMocks();
  });

  it('copies a large recursive tree through fs/promises while yielding the event loop', async () => {
    const root = await actualFs.mkdtemp(join(tmpdir(), 'uclaw-plugin-async-copy-'));
    temporaryRoots.push(root);
    const source = await createLargeTree(root);
    const destination = join(root, 'destination');
    const atomicsWait = vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      throw new Error('Atomics.wait must not run in the asynchronous copy path');
    });

    const { cpAsyncSafe } = await import('@electron/utils/plugin-install');
    let copyCompleted = false;
    const timerObservation = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(copyCompleted), 0);
    });
    const copyPromise = cpAsyncSafe(source, destination).then(() => {
      copyCompleted = true;
    });

    const completedBeforeTimer = await timerObservation;
    await copyPromise;

    expect(completedBeforeTimer).toBe(false);
    expect(await collectFiles(destination)).toHaveLength(384);
    await expect(actualFs.readFile(
      join(destination, 'group-11', 'nested', 'file-31.txt'),
      'utf8',
    )).resolves.toBe(`group=11;file=31;${'x'.repeat(256)}`);

    expect(mockAsyncReaddir).toHaveBeenCalled();
    expect(mockAsyncLstat).toHaveBeenCalled();
    expect(mockAsyncCopyFile).toHaveBeenCalledTimes(384);
    expect(mockAsyncMkdir).toHaveBeenCalled();

    expect(mockReaddirSync).not.toHaveBeenCalled();
    expect(mockStatSync).not.toHaveBeenCalled();
    expect(mockCopyFileSync).not.toHaveBeenCalled();
    expect(mockCpSync).not.toHaveBeenCalled();
    expect(atomicsWait).not.toHaveBeenCalled();
  });

  it('rejects symbolic links instead of dereferencing them into the destination', async () => {
    const root = await actualFs.mkdtemp(join(tmpdir(), 'uclaw-plugin-symlink-copy-'));
    temporaryRoots.push(root);
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    const outside = join(root, 'outside-secret.txt');
    await actualFs.mkdir(source, { recursive: true });
    await actualFs.writeFile(outside, 'must-not-be-copied', 'utf8');
    await actualFs.symlink(outside, join(source, 'linked-secret.txt'), 'file');

    const { cpAsyncSafe } = await import('@electron/utils/plugin-install');
    await expect(cpAsyncSafe(source, destination)).rejects.toThrow('symbolic link');
    await expect(actualFs.access(join(destination, 'linked-secret.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects special filesystem entries instead of copying them as files', async () => {
    const root = await actualFs.mkdtemp(join(tmpdir(), 'uclaw-plugin-special-copy-'));
    temporaryRoots.push(root);
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await actualFs.mkdir(source, { recursive: true });

    // A FIFO is available on POSIX hosts. Windows has no portable equivalent,
    // so keep the assertion conditional and retain the cross-platform copy
    // coverage above.
    if (process.platform === 'win32') return;
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      execFile('mkfifo', [join(source, 'plugin.fifo')], (error) => error ? reject(error) : resolve());
    });

    const { cpAsyncSafe } = await import('@electron/utils/plugin-install');
    await expect(cpAsyncSafe(source, destination)).rejects.toThrow('unsupported filesystem entry');
  });
});
