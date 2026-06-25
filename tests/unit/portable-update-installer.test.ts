import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({
  isPackaged: false,
  resourcesPath: '',
  version: '0.4.8',
  quit: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electronState.isPackaged;
    },
    getVersion: () => electronState.version,
    quit: electronState.quit,
  },
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    getLogDir: () => null,
  },
}));

async function importInstaller() {
  vi.resetModules();
  return await import('@electron/main/portable-update-installer');
}

describe('portable update installer', () => {
  let root: string;
  const originalPlatform = process.platform;
  const originalArch = process.arch;
  const originalExecPath = process.execPath;

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    root = await mkdtemp(join(tmpdir(), 'uclaw-portable-installer-'));
    vi.stubEnv('CLAWX_PORTABLE', '1');
    vi.stubEnv('CLAWX_PORTABLE_ROOT', join(root, 'PortableRoot'));
    vi.stubEnv('CLAWX_RUNTIME_CACHE_ROOT', join(root, 'Runtime'));
    await mkdir(join(root, 'PortableRoot'), { recursive: true });
    await writeFile(join(root, 'PortableRoot', 'portable.flag'), 'portable', 'utf-8');
    await mkdir(join(root, 'resources', 'updater', 'win32-x64'), { recursive: true });
    await writeFile(
      join(root, 'resources', 'updater', 'win32-x64', 'uclaw-portable-updater.exe'),
      'helper',
      'utf-8',
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    Object.defineProperty(process, 'execPath', {
      value: join(root, 'PortableRoot', 'UClaw.exe'),
      configurable: true,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    await rm(root, { recursive: true, force: true });
  });

  it('copies the updater helper to local runtime cache and writes an install task', async () => {
    const zipPath = join(root, 'Runtime', 'updates', 'UClaw-0.5.0-win-x64-usb.zip');
    const zipContent = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
    await mkdir(join(root, 'Runtime', 'updates'), { recursive: true });
    await writeFile(zipPath, zipContent);
    const sha512 = createHash('sha512').update(zipContent).digest('hex');
    const { preparePortableUpdateInstaller } = await importInstaller();

    const launch = await preparePortableUpdateInstaller(zipPath, {
      version: '0.5.0',
      sha512,
      size: zipContent.length,
    });

    expect(launch.helperPath).toContain(join('Runtime', 'updates', 'installer', 'win32-x64'));
    await expect(stat(launch.helperPath)).resolves.toMatchObject({ size: 6 });
    const task = JSON.parse(await readFile(launch.taskPath, 'utf-8')) as {
      zipPath: string;
      rootDir: string;
      dataDirName: string;
      launchPath: string;
      targetVersion: string;
      sha512: string;
      size: number;
      parentPid: number;
      logPath: string;
      stagingDir: string;
    };

    expect(task).toMatchObject({
      zipPath,
      rootDir: join(root, 'PortableRoot'),
      dataDirName: 'UClawData',
      launchPath: join(root, 'PortableRoot', 'UClaw.exe'),
      targetVersion: '0.5.0',
      sha512,
      size: zipContent.length,
    });
    expect(task.parentPid).toBe(process.pid);
    expect(task.logPath).toContain(join('Runtime', 'logs'));
    expect(task.stagingDir).toContain(join('Runtime', 'updates', 'staging'));
  });
});
