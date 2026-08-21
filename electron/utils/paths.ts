/**
 * Path Utilities
 * Cross-platform path resolution helpers
 */
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'fs';
import { DEFAULT_WORKSPACE_CWD } from '@shared/workspace';

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
    return (require('electron') as typeof import('electron')).app;
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

function resolveOsHomeDir(): string {
  return homedir()
    || process.env.HOME?.trim()
    || process.env.USERPROFILE?.trim()
    || process.cwd();
}

/** Resolve the home directory OpenClaw uses for its own `~` paths. */
export function resolveOpenClawEffectiveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCLAW_HOME?.trim();
  if (!configured) return resolveOsHomeDir();
  if (configured === '~' || configured.startsWith('~/') || configured.startsWith('~\\')) {
    return resolve(configured.replace(/^~(?=$|[\\/])/, resolveOsHomeDir()));
  }
  return resolve(configured);
}

/**
 * Expand ~ to home directory
 */
export function expandPath(path: string): string {
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) {
    return resolve(path.replace(/^~(?=$|[\\/])/, resolveOsHomeDir()));
  }
  return path;
}

/** Expand OpenClaw-owned paths against OPENCLAW_HOME in portable mode. */
export function expandOpenClawPath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) {
    return resolve(path.replace(/^~(?=$|[\\/])/, resolveOpenClawEffectiveHomeDir(env)));
  }
  return path;
}

/**
 * Get OpenClaw config directory
 */
export function getOpenClawConfigDir(): string {
  return resolveOpenClawConfigDir();
}

export function resolveOpenClawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCLAW_STATE_DIR?.trim();
  return resolve(expandOpenClawPath(configured || join(resolveOpenClawEffectiveHomeDir(env), '.openclaw'), env));
}

/** Resolve the logical default workspace and its children inside the active OpenClaw state directory. */
export function resolveOpenClawWorkspacePath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const expandedPath = expandPath(path);
  const defaultWorkspace = expandPath(DEFAULT_WORKSPACE_CWD);
  const relativePath = relative(defaultWorkspace, expandedPath);
  const isDefaultWorkspace = relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
  if (!isDefaultWorkspace) return expandedPath;

  return resolve(resolveOpenClawStateDir(env), 'workspace', relativePath);
}

/** Convert the active state directory's physical default workspace back to its stable logical path. */
export function collapseOpenClawWorkspacePath(
  path: string,
  stateDir: string = resolveOpenClawStateDir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const portableWorkspace = collapsePortableDefaultWorkspacePath(path, env);
  if (!isAbsolute(path)) return portableWorkspace ?? path;

  const physicalWorkspace = resolve(stateDir, 'workspace');
  const relativePath = relative(physicalWorkspace, resolve(path));
  const isDefaultWorkspace = relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
  if (!isDefaultWorkspace) return portableWorkspace ?? path;

  return relativePath
    ? `${DEFAULT_WORKSPACE_CWD}/${relativePath.split(sep).join('/')}`
    : DEFAULT_WORKSPACE_CWD;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collapsePortableDefaultWorkspacePath(
  input: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const portableId = env.CLAWX_PORTABLE_ID?.trim();
  const portableMode = env.CLAWX_PORTABLE?.trim() === '1' || Boolean(portableId);
  if (!portableMode) return null;

  const slashedPath = input.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!slashedPath || (!slashedPath.startsWith('/') && !/^[A-Za-z]:\//.test(slashedPath))) return null;

  const workspaceSuffixes = [
    'UClawData/openclaw-home/\\.openclaw/workspace',
    ...(portableId
      ? [`UClawRuntime/profiles/${escapeRegExp(portableId)}/openclaw-state/workspace`]
      : []),
  ];

  for (const suffix of workspaceSuffixes) {
    const match = new RegExp(`(?:^|/)${suffix}(?:/(.*))?$`, 'i').exec(slashedPath);
    if (!match) continue;
    const childPath = match[1]?.trim();
    if (!childPath) return DEFAULT_WORKSPACE_CWD;
    const segments = childPath.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
    return `${DEFAULT_WORKSPACE_CWD}/${segments.join('/')}`;
  }

  return null;
}

export function resolveOpenClawConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCLAW_CONFIG_PATH?.trim() || env.OPENCLAW_CONFIG?.trim();
  return resolve(expandOpenClawPath(configured || join(resolveOpenClawStateDir(env), 'openclaw.json'), env));
}

export function resolveOpenClawConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return dirname(resolveOpenClawConfigPath(env));
}

/**
 * Get OpenClaw skills directory
 */
export function getOpenClawSkillsDir(): string {
  return join(getOpenClawConfigDir(), 'skills');
}

/**
 * Get ClawX config directory
 */
export function getClawXConfigDir(): string {
  return resolve(process.env.CLAWX_USER_DATA_DIR?.trim() || join(resolveOsHomeDir(), '.clawx'));
}

/**
 * Get ClawX logs directory
 */
export function getLogsDir(): string {
  const electronApp = getElectronApp();
  try {
    return electronApp.getPath('logs');
  } catch {
    return join(electronApp.getPath('userData'), 'logs');
  }
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
  if (getElectronApp().isPackaged) {
    const portableRuntimeDir = process.env.CLAWX_OPENCLAW_RUNTIME_DIR?.trim();
    if (portableRuntimeDir) return resolve(portableRuntimeDir);
    return join(process.resourcesPath, 'openclaw');
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
