import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { app } from 'electron';

const PORTABLE_DATA_DIR_NAME = 'UClawData';
const PORTABLE_FLAG_FILE = 'portable.flag';
const RUNTIME_CACHE_DIR_NAME = 'UClawRuntime';

export type PortableRuntimeMode = 'high-performance';

export type PortableModeInfo = {
  enabled: boolean;
  mode: PortableRuntimeMode | null;
  rootDir: string | null;
  dataDir: string | null;
  clawxDataDir: string | null;
  openclawHomeDir: string | null;
  openclawConfigDir: string | null;
  updatesDir: string | null;
  runtimeRootDir: string | null;
  runtimeUpdatesDir: string | null;
  runtimeSessionDataDir: string | null;
  runtimeLogsDir: string | null;
  runtimeCrashDumpsDir: string | null;
  runtimePythonDir: string | null;
  runtimeUvCacheDir: string | null;
  runtimeUvToolDir: string | null;
  runtimeTempDir: string | null;
  runtimeNodeCompileCacheDir: string | null;
  runtimeBrowserCacheDir: string | null;
  runtimeXdgCacheDir: string | null;
  runtimeCrabboxSyncDir: string | null;
};

let cachedPortableModeInfo: PortableModeInfo | null = null;

type PendingPortableStartup = {
  version: 1;
  targetVersion: string;
  rootDir: string;
  ackPath: string;
};

function truthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function pathApi() {
  return process.platform === 'win32' ? win32 : posix;
}

function resolvePortableRootDir(): string {
  const explicitRoot = process.env.CLAWX_PORTABLE_ROOT?.trim();
  if (explicitRoot) {
    return pathApi().resolve(explicitRoot);
  }
  if (app.isPackaged) {
    return resolvePackagedPortableRootDir();
  }
  return process.cwd();
}

function resolvePackagedPortableRootDir(): string {
  const path = pathApi();
  const execDir = path.dirname(process.execPath);
  if (process.platform === 'darwin') {
    const contentsDir = path.dirname(execDir);
    const appBundleDir = path.dirname(contentsDir);
    if (
      path.basename(execDir) === 'MacOS'
      && path.basename(contentsDir) === 'Contents'
      && path.basename(appBundleDir).endsWith('.app')
    ) {
      return path.dirname(appBundleDir);
    }
  }
  return execDir;
}

function resolveLocalRuntimeRootDir(): string {
  const explicitRoot = process.env.CLAWX_RUNTIME_CACHE_ROOT?.trim()
    || process.env.CLAWX_PORTABLE_RUNTIME_ROOT?.trim();
  if (explicitRoot) {
    return pathApi().resolve(explicitRoot);
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim()
      || process.env.APPDATA?.trim()
      || pathApi().join(homedir(), 'AppData', 'Local');
    return pathApi().join(localAppData, RUNTIME_CACHE_DIR_NAME);
  }

  if (process.platform === 'darwin') {
    return pathApi().join(homedir(), 'Library', 'Caches', RUNTIME_CACHE_DIR_NAME);
  }

  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim() || pathApi().join(homedir(), '.cache');
  return pathApi().join(xdgCacheHome, RUNTIME_CACHE_DIR_NAME);
}

export function getPortableModeInfo(): PortableModeInfo {
  if (cachedPortableModeInfo) {
    return cachedPortableModeInfo;
  }

  const rootDir = resolvePortableRootDir();
  const path = pathApi();
  const dataDir = path.join(rootDir, PORTABLE_DATA_DIR_NAME);
  const runtimeRootDir = resolveLocalRuntimeRootDir();
  const enabled = truthyEnv(process.env.CLAWX_PORTABLE)
    || existsSync(path.join(rootDir, PORTABLE_FLAG_FILE))
    || existsSync(dataDir);

  cachedPortableModeInfo = enabled
    ? {
        enabled: true,
        mode: 'high-performance',
        rootDir,
        dataDir,
        clawxDataDir: path.join(dataDir, 'clawx'),
        openclawHomeDir: path.join(dataDir, 'openclaw-home'),
        openclawConfigDir: path.join(dataDir, 'openclaw-home', '.openclaw'),
        updatesDir: path.join(dataDir, 'updates'),
        runtimeRootDir,
        runtimeUpdatesDir: path.join(runtimeRootDir, 'updates'),
        runtimeSessionDataDir: path.join(runtimeRootDir, 'electron-session'),
        runtimeLogsDir: path.join(runtimeRootDir, 'logs'),
        runtimeCrashDumpsDir: path.join(runtimeRootDir, 'crash-dumps'),
        runtimePythonDir: path.join(runtimeRootDir, 'python'),
        runtimeUvCacheDir: path.join(runtimeRootDir, 'uv-cache'),
        runtimeUvToolDir: path.join(runtimeRootDir, 'uv-tools'),
        runtimeTempDir: path.join(runtimeRootDir, 'tmp'),
        runtimeNodeCompileCacheDir: path.join(runtimeRootDir, 'node-compile-cache'),
        runtimeBrowserCacheDir: path.join(runtimeRootDir, 'browser-cache'),
        runtimeXdgCacheDir: path.join(runtimeRootDir, 'xdg-cache'),
        runtimeCrabboxSyncDir: path.join(runtimeRootDir, 'crabbox-sync'),
      }
    : {
        enabled: false,
        mode: null,
        rootDir: null,
        dataDir: null,
        clawxDataDir: null,
        openclawHomeDir: null,
        openclawConfigDir: null,
        updatesDir: null,
        runtimeRootDir: null,
        runtimeUpdatesDir: null,
        runtimeSessionDataDir: null,
        runtimeLogsDir: null,
        runtimeCrashDumpsDir: null,
        runtimePythonDir: null,
        runtimeUvCacheDir: null,
        runtimeUvToolDir: null,
        runtimeTempDir: null,
        runtimeNodeCompileCacheDir: null,
        runtimeBrowserCacheDir: null,
        runtimeXdgCacheDir: null,
        runtimeCrabboxSyncDir: null,
      };

  return cachedPortableModeInfo;
}

export function isPortableMode(): boolean {
  return getPortableModeInfo().enabled;
}

function normalizedPath(value: string): string {
  const resolved = pathApi().resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(parent: string, child: string): boolean {
  const path = pathApi();
  const relative = path.relative(normalizedPath(parent), normalizedPath(child));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Confirms that a newly installed portable build completed its critical Main-process startup. */
export function acknowledgePortableUpdateStartup(): boolean {
  const info = getPortableModeInfo();
  if (!info.enabled || !info.rootDir || !info.runtimeUpdatesDir) return false;

  const pendingPath = pathApi().join(info.runtimeUpdatesDir, 'pending-startup.json');
  if (!existsSync(pendingPath)) return false;

  const pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as PendingPortableStartup;
  if (pending.version !== 1 || pending.targetVersion !== app.getVersion()) return false;
  if (normalizedPath(pending.rootDir) !== normalizedPath(info.rootDir)) return false;
  if (!isPathInside(info.runtimeUpdatesDir, pending.ackPath)) {
    throw new Error('Portable update acknowledgement path is outside the managed update directory');
  }

  // Write atomically so the helper never observes a partial startup acknowledgement.
  mkdirSync(pathApi().dirname(pending.ackPath), { recursive: true });
  const temporaryPath = `${pending.ackPath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify({
    version: 1,
    ready: true,
    targetVersion: pending.targetVersion,
    rootDir: info.rootDir,
    pid: process.pid,
    acknowledgedAt: new Date().toISOString(),
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryPath, pending.ackPath);
  rmSync(pendingPath, { force: true });
  return true;
}

export function ensurePortableDataDirs(): PortableModeInfo {
  const info = getPortableModeInfo();
  if (!info.enabled) {
    return info;
  }

  for (const dir of [
    info.dataDir,
    info.clawxDataDir,
    info.openclawHomeDir,
    info.openclawConfigDir,
    info.updatesDir,
    info.runtimeRootDir,
    info.runtimeUpdatesDir,
    info.runtimeSessionDataDir,
    info.runtimeLogsDir,
    info.runtimeCrashDumpsDir,
    info.runtimePythonDir,
    info.runtimeUvCacheDir,
    info.runtimeUvToolDir,
    info.runtimeTempDir,
    info.runtimeNodeCompileCacheDir,
    info.runtimeBrowserCacheDir,
    info.runtimeXdgCacheDir,
    info.runtimeCrabboxSyncDir,
  ]) {
    if (dir) {
      mkdirSync(dir, { recursive: true });
    }
  }

  return info;
}

export function applyPortableEnvironment(): PortableModeInfo {
  const info = ensurePortableDataDirs();
  if (!info.enabled || !info.clawxDataDir || !info.openclawHomeDir || !info.openclawConfigDir) {
    return info;
  }

  process.env.CLAWX_PORTABLE = '1';
  process.env.CLAWX_PORTABLE_MODE = info.mode ?? 'high-performance';
  process.env.CLAWX_USER_DATA_DIR = info.clawxDataDir;
  process.env.OPENCLAW_HOME = info.openclawHomeDir;
  process.env.OPENCLAW_STATE_DIR = info.openclawConfigDir;
  process.env.OPENCLAW_CONFIG_PATH = pathApi().join(info.openclawConfigDir, 'openclaw.json');
  process.env.OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG_PATH;

  if (info.runtimeRootDir) {
    process.env.CLAWX_RUNTIME_CACHE_DIR = info.runtimeRootDir;
  }
  if (info.runtimeUpdatesDir) {
    process.env.CLAWX_UPDATE_DOWNLOAD_DIR = info.runtimeUpdatesDir;
  }
  if (info.runtimePythonDir) {
    process.env.UV_PYTHON_INSTALL_DIR = info.runtimePythonDir;
  }
  if (info.runtimeUvCacheDir) {
    process.env.UV_CACHE_DIR = info.runtimeUvCacheDir;
  }
  if (info.runtimeUvToolDir) {
    process.env.UV_TOOL_DIR = info.runtimeUvToolDir;
  }
  if (info.runtimeNodeCompileCacheDir) {
    process.env.NODE_COMPILE_CACHE = info.runtimeNodeCompileCacheDir;
  }
  if (info.runtimeBrowserCacheDir) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = info.runtimeBrowserCacheDir;
  }
  if (info.runtimeXdgCacheDir) {
    process.env.XDG_CACHE_HOME = info.runtimeXdgCacheDir;
  }
  if (info.runtimeCrabboxSyncDir) {
    process.env.OPENCLAW_CRABBOX_SYNC_TMPDIR = info.runtimeCrabboxSyncDir;
  }
  if (info.runtimeTempDir) {
    process.env.TMPDIR = info.runtimeTempDir;
    process.env.TMP = info.runtimeTempDir;
    process.env.TEMP = info.runtimeTempDir;
  }

  return info;
}

export function getPortableUpdatesDir(): string | null {
  return getPortableUpdateDownloadsDir();
}

export function getPortableUpdateDownloadsDir(): string | null {
  return getPortableModeInfo().runtimeUpdatesDir;
}
