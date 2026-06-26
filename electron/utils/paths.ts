/**
 * Path Utilities
 * Cross-platform path resolution helpers
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'fs';

const require = createRequire(import.meta.url);

type ElectronAppLike = Pick<typeof import('electron').app, 'isPackaged' | 'getPath' | 'getAppPath'>;

export {
  quoteForCmd,
  needsWinShell,
  prepareWinSpawn,
  normalizeNodeRequirePathForNodeOptions,
  appendNodeRequireToNodeOptions,
} from './win-shell';

function getElectronApp() {
  if (process.versions?.electron) {
    const electronModule = require('electron') as Partial<typeof import('electron')> & { app?: typeof import('electron').app };
    if (electronModule.app) {
      return electronModule.app;
    }
  }

  const fallbackUserData = process.env.CLAWX_USER_DATA_DIR?.trim() || join(homedir(), '.clawx');
  const fallbackAppPath = process.cwd();
  const fallbackApp: ElectronAppLike = {
    isPackaged: false,
    getPath: (name) => {
      if (name === 'userData') return fallbackUserData;
      return fallbackUserData;
    },
    getAppPath: () => fallbackAppPath,
  };
  return fallbackApp;
}

function resolveExplicitOpenClawDir(): string | null {
  const explicitDir = process.env.CLAWX_OPENCLAW_DIR?.trim();
  if (!explicitDir) {
    return null;
  }
  return resolve(explicitDir);
}

function resolvePackagedOpenClawDirFromProcess(): string | null {
  const resourcesPath = process.resourcesPath?.trim();
  if (!resourcesPath) {
    return null;
  }
  const candidate = join(resourcesPath, 'openclaw');
  if (existsSync(join(candidate, 'package.json'))) {
    return candidate;
  }
  return null;
}

/**
 * Resolve OpenClaw's effective home directory. This mirrors OpenClaw's own
 * tilde semantics: OPENCLAW_HOME becomes the home for ~/.openclaw paths.
 */
export function resolveOpenClawEffectiveHomeDir(): string {
  const explicitHome = process.env.OPENCLAW_HOME?.trim();
  if (explicitHome) {
    if (explicitHome === '~' || explicitHome.startsWith('~/') || explicitHome.startsWith('~\\')) {
      return resolve(explicitHome.replace(/^~(?=$|[\\/])/, resolveOsHomeDir()));
    }
    return resolve(explicitHome);
  }
  return resolveOsHomeDir();
}

function resolveOsHomeDir(): string {
  return homedir()
    || process.env.HOME?.trim()
    || process.env.USERPROFILE?.trim()
    || process.cwd();
}

/**
 * Expand ~ to the OS home directory
 */
export function expandPath(path: string): string {
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) {
    return resolve(path.replace(/^~(?=$|[\\/])/, resolveOsHomeDir()));
  }
  return path;
}

/**
 * Expand ~ using OpenClaw's effective home. Use this for OpenClaw config paths
 * such as ~/.openclaw/workspace and agents.list[].agentDir.
 */
export function expandOpenClawPath(path: string): string {
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) {
    return resolve(path.replace(/^~(?=$|[\\/])/, resolveOpenClawEffectiveHomeDir()));
  }
  return path;
}

/**
 * Expand paths surfaced to file preview. OpenClaw-owned paths must follow
 * OpenClaw's effective home, while ordinary user paths keep OS-home tilde
 * semantics.
 */
export function expandFilePreviewPath(path: string): string {
  if (path === '~/.openclaw' || path === '~\\.openclaw' || path.startsWith('~/.openclaw/') || path.startsWith('~\\.openclaw\\')) {
    return expandOpenClawPath(path);
  }
  return expandPath(path);
}

/**
 * Get OpenClaw config directory
 */
export function getOpenClawConfigDir(): string {
  const explicitStateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicitStateDir) {
    return expandOpenClawPath(explicitStateDir);
  }

  const explicitConfigPath = process.env.OPENCLAW_CONFIG_PATH?.trim()
    || process.env.OPENCLAW_CONFIG?.trim();
  if (explicitConfigPath) {
    return dirname(expandOpenClawPath(explicitConfigPath));
  }

  return join(resolveOpenClawHomeDir(), '.openclaw');
}

/**
 * Get OpenClaw home directory. In portable mode this follows the USB data root.
 */
export function resolveOpenClawHomeDir(): string {
  return resolveOpenClawEffectiveHomeDir();
}

/**
 * Get OpenClaw config file path
 */
export function getOpenClawConfigPath(): string {
  const explicitConfigPath = process.env.OPENCLAW_CONFIG_PATH?.trim()
    || process.env.OPENCLAW_CONFIG?.trim();
  return explicitConfigPath
    ? expandOpenClawPath(explicitConfigPath)
    : join(getOpenClawConfigDir(), 'openclaw.json');
}

/**
 * Get OpenClaw skills directory
 */
export function getOpenClawSkillsDir(): string {
  return join(getOpenClawConfigDir(), 'skills');
}

export function getOpenClawExtensionsDir(): string {
  return join(getOpenClawConfigDir(), 'extensions');
}

export function getOpenClawAgentsDir(): string {
  return join(getOpenClawConfigDir(), 'agents');
}

export function getOpenClawMediaDir(): string {
  return join(getOpenClawConfigDir(), 'media');
}

/**
 * Get ClawX config directory
 */
export function getClawXConfigDir(): string {
  return process.env.CLAWX_USER_DATA_DIR?.trim() || join(homedir(), '.clawx');
}

/**
 * Get ClawX logs directory
 */
export function getLogsDir(): string {
  return join(getElectronApp().getPath('userData'), 'logs');
}

/**
 * Get ClawX data directory
 */
export function getDataDir(): string {
  return getElectronApp().getPath('userData');
}

/**
 * Ensure directory exists
 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Get resources directory (for bundled assets)
 */
export function getResourcesDir(): string {
  if (getElectronApp().isPackaged) {
    return join(process.resourcesPath, 'resources');
  }
  return join(__dirname, '../../resources');
}

/**
 * Get preload script path
 */
export function getPreloadPath(): string {
  return join(__dirname, '../preload/index.js');
}

/**
 * Get OpenClaw package directory
 * - Production (packaged): from resources/openclaw (copied by electron-builder extraResources)
 * - Development: from node_modules/openclaw
 */
export function getOpenClawDir(): string {
  const explicitDir = resolveExplicitOpenClawDir();
  if (explicitDir) {
    return explicitDir;
  }

  if (getElectronApp().isPackaged) {
    return join(process.resourcesPath, 'openclaw');
  }

  // Electron utility processes do not expose electron.app, so the fallback app
  // above looks like development mode even when launched from app.asar.
  // Detect the packaged resources directory directly before falling back to
  // node_modules/openclaw.
  const packagedDir = resolvePackagedOpenClawDirFromProcess();
  if (packagedDir) {
    return packagedDir;
  }

  // Development: use node_modules/openclaw
  return join(__dirname, '../../node_modules/openclaw');
}

/**
 * Get OpenClaw package directory resolved to a real path.
 * Useful when consumers need deterministic module resolution under pnpm symlinks.
 */
export function getOpenClawResolvedDir(): string {
  const dir = getOpenClawDir();
  if (!existsSync(dir)) {
    return dir;
  }
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Get OpenClaw entry script path (openclaw.mjs)
 */
export function getOpenClawEntryPath(): string {
  return join(getOpenClawDir(), 'openclaw.mjs');
}

/**
 * Get ClawHub CLI entry script path (clawdhub.js)
 */
export function getClawHubCliEntryPath(): string {
  return join(getElectronApp().getAppPath(), 'node_modules', 'clawhub', 'bin', 'clawdhub.js');
}

/**
 * Get ClawHub CLI binary path (node_modules/.bin)
 */
export function getClawHubCliBinPath(): string {
  const binName = process.platform === 'win32' ? 'clawhub.cmd' : 'clawhub';
  return join(getElectronApp().getAppPath(), 'node_modules', '.bin', binName);
}

/**
 * Check if OpenClaw package exists
 */
export function isOpenClawPresent(): boolean {
  const dir = getOpenClawDir();
  const pkgJsonPath = join(dir, 'package.json');
  return existsSync(dir) && existsSync(pkgJsonPath);
}

/**
 * Check if OpenClaw is built (has dist folder)
 * For the npm package, this should always be true since npm publishes the built dist.
 */
export function isOpenClawBuilt(): boolean {
  const dir = getOpenClawDir();
  const distDir = join(dir, 'dist');
  const hasDist = existsSync(distDir);
  return hasDist;
}

/**
 * Get OpenClaw status for environment check
 */
export interface OpenClawStatus {
  packageExists: boolean;
  isBuilt: boolean;
  entryPath: string;
  dir: string;
  version?: string;
}

export function getOpenClawStatus(): OpenClawStatus {
  const dir = getOpenClawDir();
  let version: string | undefined;

  // Try to read version from package.json
  try {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      version = pkg.version;
    }
  } catch {
    // Ignore version read errors
  }

  const status: OpenClawStatus = {
    packageExists: isOpenClawPresent(),
    isBuilt: isOpenClawBuilt(),
    entryPath: getOpenClawEntryPath(),
    dir,
    version,
  };

  try {
    const { logger } = require('./logger') as typeof import('./logger');
    logger.info('OpenClaw status:', status);
  } catch {
    // Ignore logger bootstrap issues in non-Electron contexts such as unit tests.
  }
  return status;
}
