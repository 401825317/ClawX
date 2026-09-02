import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger';
import {
  assertPortableUpdateReplaceable,
  getPortableModeInfo,
} from '../utils/portable-mode';
import { setQuitting } from './app-state';
import { verifyPortableUpdatePackage } from './portable-update-security';

const PORTABLE_DATA_DIR_NAME = 'UClawData';

type PortableInstallerUpdateInfo = {
  version: string;
  sha512?: string;
  size?: number;
};

export type PortableUpdaterTask = {
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
  readyPath: string;
};

export type PortableUpdateInstallerLaunch = {
  helperPath: string;
  taskPath: string;
  logPath: string;
};

export class PortableUpdaterLaunchError extends Error {
  readonly code?: string;
  readonly helperPath: string;

  constructor(helperPath: string, cause: unknown) {
    const code = typeof cause === 'object' && cause && 'code' in cause
      ? String((cause as { code?: unknown }).code)
      : undefined;
    const detail = cause instanceof Error ? cause.message : String(cause);
    const message = code === 'EACCES' || code === 'EPERM'
      ? `Portable updater helper was blocked by the operating system or security software: ${helperPath}`
      : `Portable updater helper failed to start: ${helperPath}${detail ? ` (${detail})` : ''}`;
    super(message);
    this.name = 'PortableUpdaterLaunchError';
    this.code = code;
    this.helperPath = helperPath;
  }
}

function portableUpdaterFileName(platform = process.platform): string {
  return platform === 'win32' ? 'uclaw-portable-updater.exe' : 'uclaw-portable-updater';
}

export function portableUpdaterTargetForPlatform(platform = process.platform, arch = process.arch): string {
  if (platform === 'win32' && arch === 'x64') {
    return 'win32-x64';
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return 'darwin-arm64';
  }
  if (platform === 'darwin' && arch === 'x64') {
    return 'darwin-x64';
  }
  throw new Error(`Portable auto-update is not supported on ${platform}/${arch}`);
}

export function resolveBundledPortableUpdaterPath(
  target = portableUpdaterTargetForPlatform(),
  platform = process.platform,
): string {
  const fileName = portableUpdaterFileName(platform);
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources', 'updater', target, fileName);
  }
  return join(process.cwd(), 'resources', 'updater', target, fileName);
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function copyHelperToRuntime(
  sourcePath: string,
  runtimeUpdatesDir: string,
  target: string,
  attemptId: string,
): Promise<string> {
  if (!existsSync(sourcePath)) {
    throw new Error(`Portable updater helper is missing: ${sourcePath}`);
  }

  // Each update attempt uses an isolated helper copy. A detached helper from a
  // failed attempt can therefore never lock the next helper on Windows.
  const helperDir = join(runtimeUpdatesDir, 'installer', target, app.getVersion(), attemptId);
  const helperPath = join(helperDir, portableUpdaterFileName());
  await mkdir(helperDir, { recursive: true });
  await copyFile(sourcePath, helperPath);
  if (process.platform !== 'win32') {
    try {
      await chmod(helperPath, 0o755);
    } catch (error) {
      // FAT/exFAT volumes can reject chmod even though they expose the helper
      // as executable through their fixed permission mask.
      const helperMode = (await stat(helperPath)).mode;
      if ((helperMode & 0o111) === 0) {
        throw error;
      }
      logger.warn(`[PortableUpdater] chmod was rejected but helper is executable: ${helperPath}`);
    }
  }
  return helperPath;
}

export async function preparePortableUpdateInstaller(
  zipPath: string,
  info: PortableInstallerUpdateInfo,
): Promise<PortableUpdateInstallerLaunch> {
  assertPortableUpdateReplaceable();
  const portable = getPortableModeInfo();
  if (!portable.enabled || !portable.rootDir || !portable.runtimeUpdatesDir) {
    throw new Error('Portable mode is not enabled or update cache is unavailable');
  }

  const sha512 = typeof info.sha512 === 'string' ? info.sha512.trim().toLowerCase() : '';
  if (!info.version || !/^[a-f0-9]{128}$/u.test(sha512)) {
    throw new Error('Portable update metadata is missing version or a valid sha512');
  }

  const size = info.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error('Portable update metadata is missing a positive size');
  }
  await verifyPortableUpdatePackage(zipPath, { sha512, size });

  const target = portableUpdaterTargetForPlatform();
  // The task, staging directory, readiness marker, and log all share this
  // identifier.  A wall-clock timestamp alone has millisecond resolution and
  // can collide when two update checks finish together; that would make the
  // second task overwrite the first task while both detached helpers operate
  // on the same staging/ready paths.  Keep the timestamp for diagnostics but
  // add a UUID so every attempt gets an isolated workspace.
  const stamp = `${timestampForPath()}-${randomUUID()}`;
  const attemptId = stamp;
  const sourceHelperPath = resolveBundledPortableUpdaterPath(target);
  const helperPath = await copyHelperToRuntime(sourceHelperPath, portable.runtimeUpdatesDir, target, attemptId);
  // Keep helper logs inside the same portable runtime root as the task,
  // staging, and readiness marker.  Electron's default logger directory can
  // be ~/Library/Logs/UClaw (or another global app log location); the Go
  // helper intentionally rejects paths outside that trusted workspace.
  const logDir = portable.runtimeLogsDir || logger.getLogDir() || portable.runtimeUpdatesDir;
  const taskDir = join(portable.runtimeUpdatesDir, 'tasks');
  const readyDir = join(portable.runtimeUpdatesDir, 'ready');
  const stagingDir = join(portable.runtimeUpdatesDir, 'staging', stamp);
  const logPath = join(logDir, `portable-updater-${stamp}.log`);
  const taskPath = join(taskDir, `portable-update-${stamp}.json`);
  const readyPath = join(readyDir, `portable-update-${stamp}.ready.json`);
  const task: PortableUpdaterTask = {
    zipPath,
    rootDir: portable.rootDir,
    dataDirName: PORTABLE_DATA_DIR_NAME,
    launchPath: process.execPath,
    targetVersion: info.version,
    sha512,
    size,
    parentPid: process.pid,
    logPath,
    stagingDir,
    readyPath,
  };

  await mkdir(taskDir, { recursive: true });
  await mkdir(readyDir, { recursive: true });
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`, 'utf-8');

  return { helperPath, taskPath, logPath };
}

function waitForHelperLaunch(child: ChildProcess, helperPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => {
      settle(resolve);
    }, 1000);

    child.once('spawn', () => {
      clearTimeout(timer);
      settle(resolve);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      settle(() => reject(new PortableUpdaterLaunchError(helperPath, error)));
    });
  });
}

export async function launchPortableUpdateInstaller(
  zipPath: string,
  info: PortableInstallerUpdateInfo,
): Promise<PortableUpdateInstallerLaunch> {
  const launch = await preparePortableUpdateInstaller(zipPath, info);
  logger.info(`[PortableUpdater] Launching helper: ${launch.helperPath}`);
  logger.info(`[PortableUpdater] Task file: ${launch.taskPath}`);

  const child = spawn(launch.helperPath, ['--task', launch.taskPath], {
    cwd: dirname(launch.helperPath),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  await waitForHelperLaunch(child, launch.helperPath);
  child.unref();

  setQuitting();
  app.quit();
  return launch;
}
