import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { app } from 'electron';
import {
  preparePortableRuntimeState,
  resolvePortableRuntimeLayout,
  type PortableRuntimeLayout,
} from './portable-runtime-state';
import { preparePortableClawXStateSync } from './portable-clawx-state';

const PORTABLE_DATA_DIR_NAME = 'UClawData';
const PORTABLE_FLAG_FILE = 'portable.flag';
const RUNTIME_CACHE_DIR_NAME = 'UClawRuntime';

/** The package channel is independent from where the user's state lives. */
export type PortableUpdatePackageType = 'portable_zip' | 'installer';

/**
 * `portable` means state is intentionally colocated with the app.  An app
 * installed from a DMG/installer remains `installed` even though macOS uses
 * the portable ZIP endpoint for update discovery.
 */
export type PortableDataMode = 'portable' | 'installed';

export type PortableLayoutReason =
  | 'complete'
  | 'missing-portable-flag'
  | 'missing-data-directory'
  | 'missing-app-bundle'
  | 'invalid-root'
  | 'read-only-root'
  | 'read-only-data-directory'
  | 'read-only-app-bundle';

/** Read-only inspection used by the updater before it offers replacement. */
export type PortableLayoutInspection = {
  platform: string;
  packageType: PortableUpdatePackageType;
  rootDir: string | null;
  appBundlePath: string | null;
  dataDir: string | null;
  portableFlagPath: string | null;
  hasPortableFlag: boolean;
  hasDataDirectory: boolean;
  hasAppBundle: boolean;
  structureComplete: boolean;
  rootWritable: boolean;
  dataDirectoryWritable: boolean;
  appBundleWritable: boolean;
  writable: boolean;
  /** Exact top-level names observed on Darwin; used to invalidate cached probes. */
  rootEntryNames: readonly string[];
  canAutoReplace: boolean;
  /** A downloaded ZIP must be fully extracted instead of replacing this root. */
  requiresMigration: boolean;
  migrationRequired: boolean;
  reason: PortableLayoutReason;
};

export type PortableRuntimeMode = 'high-performance';

export type PortableModeInfo = {
  enabled: boolean;
  mode: PortableRuntimeMode | null;
  /** Update artifact selected for this platform, independent of data mode. */
  updatePackageType: PortableUpdatePackageType;
  /** Alias kept for callers that use the API's package terminology. */
  packageType: PortableUpdatePackageType;
  dataMode: PortableDataMode;
  /** A ZIP can be downloaded but only a complete writable layout can replace in place. */
  canAutoReplace: boolean;
  requiresMigration: boolean;
  migrationRequired: boolean;
  migrationReason: PortableLayoutReason;
  portableLayout: PortableLayoutInspection;
  rootDir: string | null;
  dataDir: string | null;
  clawxDataDir: string | null;
  openclawHomeDir: string | null;
  openclawConfigDir: string | null;
  updatesDir: string | null;
  sessionDataDir: string | null;
  runtimeRootDir: string | null;
  runtimeUpdatesDir: string | null;
  runtimeElectronCacheDir: string | null;
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
  portableId: string | null;
  runtimeProfileDir: string | null;
  runtimeOpenClawStateDir: string | null;
  runtimeSnapshotDir: string | null;
  portableRuntimeLayout: PortableRuntimeLayout | null;
};

let cachedPortableModeInfo: PortableModeInfo | null = null;
// `getPortableModeInfo()` is intentionally cached because resolving the
// runtime layout can create/repair identity files.  The launch root can,
// however, be completed while the process is running (for example when a
// user extracts `UClawData` beside an app that was first launched from a DMG).
// Keep a small, side-effect-free signature of the inputs that determine the
// classification so a cached "installed" result cannot become permanent.
let cachedPortableModeCacheKey: string | null = null;
// The classifier accepts an explicit platform for cross-platform tests. Keep
// the host OS available so POSIX permission checks are not imposed on a
// Windows filesystem whose mode bits do not represent execute permissions.
const hostPlatform = process.platform;

function truthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function pathApi(platform: string = process.platform, pathHint?: string) {
  // Tests may classify a macOS layout using a temporary Windows path. In
  // production the platform and path style agree, but honoring an explicit
  // absolute Windows path keeps the classifier itself platform-independent.
  // `path.win32.isAbsolute('/var/...')` is also true, though, so checking only
  // the Windows helper misclassifies every POSIX absolute path on a real macOS
  // runner as a Windows path (turning `/var/...` into `\\var\\...`).  Select
  // win32 only when the hint is Windows-rooted *and not* POSIX-rooted.
  return platform === 'win32'
    || Boolean(pathHint && win32.isAbsolute(pathHint) && !posix.isAbsolute(pathHint))
    ? win32
    : posix;
}

/**
 * A portable root may live on a read-only USB/DMG volume.  Startup should
 * continue with the local runtime cache in that case; only unexpected
 * filesystem failures should abort bootstrap.
 */
function isReadOnlyFilesystemError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = String((error as { code?: unknown }).code);
  return code === 'EROFS' || code === 'EACCES' || code === 'EPERM';
}

/**
 * Remove portable-only process variables inherited from a previous USB
 * launcher when the current Darwin app does not have a valid portable data
 * layout.  `paths.ts` treats either CLAWX_PORTABLE or CLAWX_PORTABLE_ID as
 * authoritative, so leaving either value behind would make an installed app
 * resolve workspace paths as if it were portable.
 */
function clearInheritedPortableEnvironment(): void {
  // This function is called only after hasInheritedPortableEnvironment() has
  // established a portable bootstrap signal. Keep the cleanup scoped to the
  // variables owned by that bootstrap. Every path variable below is owned by
  // the portable bootstrap, and must be removed even when it points outside
  // the stale root; retaining an external value could redirect an installed
  // app back to an old USB runtime after the root was rejected. TMP/TEMP are
  // included because portable bootstrap explicitly overwrites all three
  // names below; when a portable signal is inherited, preserving them can
  // leave child processes writing to an ejected/read-only USB volume.
  for (const name of [
    'CLAWX_PORTABLE',
    'CLAWX_PORTABLE_MODE',
    'CLAWX_PORTABLE_ID',
    // Root selectors belong to the portable launcher. Clear them alongside
    // the mode flags so an installed app cannot continue resolving a stale
    // USB root (and accidentally replace that unrelated app) after startup.
    'CLAWX_PORTABLE_ROOT',
    'CLAWX_PORTABLE_RUNTIME_ROOT',
    'CLAWX_RUNTIME_CACHE_ROOT',
    'CLAWX_PORTABLE_RUNTIME_STATE',
    'TMPDIR',
    'TMP',
    'TEMP',
  ]) {
    delete process.env[name];
  }

  const ownedPathVariables = [
    'CLAWX_PORTABLE_RUNTIME_SNAPSHOT_DIR',
    // Set by portable-openclaw-runtime during bootstrap. Do not let an
    // inherited USB cache override the installed app's bundled runtime after
    // an incomplete macOS layout is classified as installed.
    'CLAWX_OPENCLAW_RUNTIME_DIR',
    'CLAWX_RUNTIME_CACHE_DIR',
    'CLAWX_UPDATE_DOWNLOAD_DIR',
    'CLAWX_USER_DATA_DIR',
    'OPENCLAW_HOME',
    'OPENCLAW_STATE_DIR',
    'OPENCLAW_CONFIG_PATH',
    'OPENCLAW_CONFIG',
    'UV_PYTHON_INSTALL_DIR',
    'UV_CACHE_DIR',
    'UV_TOOL_DIR',
    'NODE_COMPILE_CACHE',
    'PLAYWRIGHT_BROWSERS_PATH',
    'XDG_CACHE_HOME',
    'OPENCLAW_CRABBOX_SYNC_TMPDIR',
  ];
  for (const name of ownedPathVariables) {
    delete process.env[name];
  }
}

function hasInheritedPortableEnvironment(): boolean {
  // Development/E2E callers may intentionally set a root selector while
  // probing an incomplete layout; do not erase those explicit selectors.
  // Packaged Darwin launches must also treat launcher selectors as stale
  // bootstrap state because an app copied from a ZIP/DMG no longer shares the
  // original portable root.
  const explicitPortableMode = truthyEnv(process.env.CLAWX_PORTABLE)
    || Boolean(process.env.CLAWX_PORTABLE_ID?.trim());
  // An unpackaged development process may deliberately set only a root
  // selector while probing a synthetic layout. Preserve that selector. A
  // mode/id flag, however, is a launcher-owned portable bootstrap signal and
  // must be cleared when the strict layout probe rejects the root, even in
  // tests or diagnostic launches that emulate macOS without a real bundle.
  if (!isPackagedDarwinAppExecutable() && !explicitPortableMode) return false;
  if (explicitPortableMode) return true;
  return Boolean(
    process.env.CLAWX_PORTABLE_ROOT?.trim()
      || process.env.CLAWX_PORTABLE_RUNTIME_ROOT?.trim()
      || process.env.CLAWX_RUNTIME_CACHE_ROOT?.trim()
      || process.env.CLAWX_PORTABLE_RUNTIME_STATE?.trim()
      || process.env.CLAWX_PORTABLE_RUNTIME_SNAPSHOT_DIR?.trim()
      || process.env.CLAWX_OPENCLAW_RUNTIME_DIR?.trim(),
  );
}

/**
 * A packaged Darwin process must classify the directory that actually
 * contains its `.app` bundle.  A launcher-provided root selector can be stale
 * after the user copies only `UClaw.app` into `/Applications`; following that
 * selector would make the installed app inspect (and potentially replace) an
 * unrelated old USB root.  Development/E2E runs intentionally retain their
 * explicit selectors, so this guard is limited to a real packaged app path.
 */
function isPackagedDarwinAppExecutable(platform: string = process.platform): boolean {
  if (platform !== 'darwin' || !app.isPackaged) return false;
  const path = pathApi(platform, process.execPath);
  const execDir = path.dirname(process.execPath);
  const contentsDir = path.dirname(execDir);
  const appBundleDir = path.dirname(contentsDir);
  return path.basename(execDir) === 'MacOS'
    && path.basename(contentsDir) === 'Contents'
    && path.basename(appBundleDir).toLowerCase().endsWith('.app');
}

function normalizedPathForComparison(value: string, platform: string): string {
  const path = pathApi(platform, value);
  const normalized = path.resolve(value).replace(/[\\/]+$/u, '');
  // HFS/APFS volumes are commonly case-insensitive.  Comparing folded paths
  // avoids rejecting a valid selector that differs only in capitalization.
  return platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

export function resolvePortableRootDir(platform: string = process.platform): string {
  const explicitRoot = process.env.CLAWX_PORTABLE_ROOT?.trim();
  if (isPackagedDarwinAppExecutable(platform)) {
    const packagedRoot = resolvePackagedPortableRootDir(platform);
    if (!explicitRoot || normalizedPathForComparison(explicitRoot, platform)
      === normalizedPathForComparison(packagedRoot, platform)) {
      return packagedRoot;
    }
    // Ignore a stale launcher selector.  `applyPortableEnvironment()` will
    // subsequently clear the selector and related derived variables when the
    // actual app root is not a complete portable layout.
    return packagedRoot;
  }
  if (explicitRoot) {
    return pathApi(platform, explicitRoot).resolve(explicitRoot);
  }
  if (app.isPackaged) {
    return resolvePackagedPortableRootDir(platform);
  }
  return process.cwd();
}

export function resolvePackagedPortableRootDir(platform: string = process.platform): string {
  const path = pathApi(platform, process.execPath);
  const execDir = path.dirname(process.execPath);
  if (platform === 'darwin') {
    const contentsDir = path.dirname(execDir);
    const appBundleDir = path.dirname(contentsDir);
    if (
      path.basename(execDir) === 'MacOS'
      && path.basename(contentsDir) === 'Contents'
      // Bundle names are normally `UClaw.app`, but Finder/ZIP extraction can
      // preserve a case variant.  `isPackagedDarwinAppExecutable()` already
      // treats the suffix case-insensitively; keep root resolution consistent
      // so a valid packaged app is not accidentally classified as its
      // `Contents/MacOS` directory when the suffix casing differs.
      && path.basename(appBundleDir).toLowerCase().endsWith('.app')
    ) {
      return path.dirname(appBundleDir);
    }
  }
  return execDir;
}

function isDirectory(value: string | null): boolean {
  if (!value) return false;
  try {
    return lstatSync(value).isDirectory();
  } catch {
    return false;
  }
}

function isFile(value: string | null): boolean {
  if (!value) return false;
  try {
    return lstatSync(value).isFile();
  } catch {
    return false;
  }
}

/**
 * Return the exact top-level names present in a Darwin portable root.
 *
 * HFS+/APFS volumes are commonly case-insensitive, so `lstatSync(root/
 * 'portable.flag')` can succeed for a malformed `Portable.flag` entry. The
 * portable ZIP contract is case-sensitive at the archive/layout level; read
 * the directory entries themselves and require an exact spelling before
 * accepting the marker, data directory, or app bundle. A null result is used
 * for non-Darwin callers, where the existing cross-platform probing semantics
 * should remain unchanged.
 */
function readDarwinRootEntryNames(rootDir: string, platform: string): Set<string> | null {
  if (platform !== 'darwin') return null;
  try {
    return new Set(readdirSync(rootDir));
  } catch {
    return new Set();
  }
}

/**
 * Check a directory using both the POSIX mode bits and the OS access check.
 * The mode-bit check matters in test/diagnostic processes running as root,
 * where `access(2)` can otherwise report a read-only directory as writable.
 */
function isWritableDirectory(value: string | null, platform: string = process.platform): boolean {
  if (!isDirectory(value)) return false;
  try {
    const mode = lstatSync(value!).mode;
    if ((mode & 0o222) === 0) return false;
    // POSIX replacement requires both mutation permission and directory
    // traversal. Windows ignores X_OK and reports no execute mode bits for
    // directories, so keep its native access check to W_OK.
    const accessMode = platform === 'win32' || hostPlatform === 'win32'
      ? fsConstants.W_OK
      : fsConstants.W_OK | fsConstants.X_OK;
    if (platform !== 'win32' && hostPlatform !== 'win32' && (mode & 0o111) === 0) return false;
    accessSync(value!, accessMode);
    return true;
  } catch {
    return false;
  }
}

function resolvePortableAppBundlePath(
  rootDir: string,
  platform: string = process.platform,
  path = pathApi(platform),
): string | null {
  if (platform !== 'darwin') return null;
  // The managed macOS ZIP contract always extracts `UClaw.app` at the root.
  // Do not treat an unrelated sibling app (for example a renamed copy in
  // `/Applications`) as an in-place portable installation.
  return path.join(rootDir, 'UClaw.app');
}

function layoutReason(params: {
  rootDir: string | null;
  hasPortableFlag: boolean;
  hasDataDirectory: boolean;
  hasAppBundle: boolean;
  platform: string;
  rootWritable: boolean;
  dataDirectoryWritable: boolean;
  appBundleWritable: boolean;
}): PortableLayoutReason {
  if (!params.rootDir || !isDirectory(params.rootDir)) return 'invalid-root';
  if (!params.hasPortableFlag) return 'missing-portable-flag';
  if (!params.hasDataDirectory) return 'missing-data-directory';
  if (params.platform === 'darwin' && !params.hasAppBundle) return 'missing-app-bundle';
  if (!params.rootWritable) return 'read-only-root';
  if (!params.dataDirectoryWritable) return 'read-only-data-directory';
  if (params.platform === 'darwin' && !params.appBundleWritable) return 'read-only-app-bundle';
  return 'complete';
}

/**
 * Inspect the on-disk macOS portable contract without creating directories or
 * identity files. This function is intentionally side-effect free so update
 * checks can classify an app copied to `/Applications` or launched from a DMG.
 */
export function inspectPortableLayout(options: {
  platform?: string;
  rootDir?: string;
} = {}): PortableLayoutInspection {
  const platform = options.platform ?? process.platform;
  const path = pathApi(platform, options.rootDir);
  const rootDir = options.rootDir
    ? path.resolve(options.rootDir)
    : resolvePortableRootDir(platform);
  const dataDir = path.join(rootDir, PORTABLE_DATA_DIR_NAME);
  const portableFlagPath = path.join(rootDir, PORTABLE_FLAG_FILE);
  const appBundlePath = resolvePortableAppBundlePath(rootDir, platform, path);
  const darwinEntryNames = readDarwinRootEntryNames(rootDir, platform);
  const rootEntryNames = darwinEntryNames ? [...darwinEntryNames].sort() : [];
  const hasPortableFlag = isFile(portableFlagPath)
    && (darwinEntryNames === null || darwinEntryNames.has(PORTABLE_FLAG_FILE));
  const hasDataDirectory = isDirectory(dataDir)
    && (darwinEntryNames === null || darwinEntryNames.has(PORTABLE_DATA_DIR_NAME));
  const hasAppBundle = platform === 'darwin'
    ? isDirectory(appBundlePath)
      && (darwinEntryNames?.has('UClaw.app') ?? false)
    : true;
  const rootWritable = isWritableDirectory(rootDir, platform);
  const dataDirectoryWritable = isWritableDirectory(dataDir, platform);
  const appBundleWritable = platform === 'darwin' ? isWritableDirectory(appBundlePath, platform) : true;
  const structureComplete = hasPortableFlag && hasDataDirectory && hasAppBundle;
  const writable = structureComplete && rootWritable && dataDirectoryWritable && appBundleWritable;
  // In-place replacement is only safe after the complete layout and every
  // participating directory has passed the writable probe. This applies to
  // all platforms; a forced/partial portable signal must never advertise an
  // auto-replace path merely because it is not Darwin.
  const canAutoReplace = writable;
  const reason = layoutReason({
    rootDir,
    hasPortableFlag,
    hasDataDirectory,
    hasAppBundle,
    platform,
    rootWritable,
    dataDirectoryWritable,
    appBundleWritable,
  });
  const packageType: PortableUpdatePackageType = platform === 'darwin'
    || truthyEnv(process.env.CLAWX_PORTABLE)
    || hasPortableFlag
    || hasDataDirectory
    ? 'portable_zip'
    : 'installer';

  return {
    platform,
    packageType,
    rootDir,
    appBundlePath,
    dataDir,
    portableFlagPath,
    hasPortableFlag,
    hasDataDirectory,
    hasAppBundle,
    structureComplete,
    rootWritable,
    dataDirectoryWritable,
    appBundleWritable,
    writable,
    rootEntryNames,
    canAutoReplace,
    requiresMigration: platform === 'darwin' && !canAutoReplace,
    migrationRequired: platform === 'darwin' && !canAutoReplace,
    reason,
  };
}

/** Return the artifact family for update discovery, independent of data mode. */
export function getPortableUpdatePackageType(platform = process.platform): PortableUpdatePackageType {
  if (platform === 'darwin') return 'portable_zip';
  if (truthyEnv(process.env.CLAWX_PORTABLE)) return 'portable_zip';
  const rootDir = resolvePortableRootDir(platform);
  const path = pathApi(platform, rootDir);
  // Match the side-effect-free layout classifier above: a stray file,
  // symlink, or broken extraction named `UClawData`/`portable.flag` must not
  // silently switch an installed build onto the portable ZIP contract.  In
  // particular, `existsSync()` follows links and would let an unrelated
  // directory selected by a stale launcher environment look like portable
  // state.
  return isFile(path.join(rootDir, PORTABLE_FLAG_FILE))
    || isDirectory(path.join(rootDir, PORTABLE_DATA_DIR_NAME))
    ? 'portable_zip'
    : 'installer';
}

/** Compatibility alias for callers that phrase this as a predicate. */
export function shouldUsePortableUpdatePackage(platform = process.platform): boolean {
  return getPortableUpdatePackageType(platform) === 'portable_zip';
}

/** Re-read layout state after a test or an external volume is attached. */
export function resetPortableModeInfoCache(): void {
  cachedPortableModeInfo = null;
  cachedPortableModeCacheKey = null;
}

function resolveLocalRuntimeRootDir(): string {
  const explicitRoot = process.env.CLAWX_RUNTIME_CACHE_ROOT?.trim()
    || process.env.CLAWX_PORTABLE_RUNTIME_ROOT?.trim();
  if (explicitRoot) {
    // A packaged macOS app can outlive the USB/DMG launcher process that
    // supplied these selectors.  Never let an arbitrary inherited path point
    // the new app at a runtime profile from another volume.  Keep explicit
    // selectors for development and for a selector that is either the normal
    // per-user cache or is intentionally scoped below this app's portable
    // root.
    if (process.platform === 'darwin' && isPackagedDarwinAppExecutable()) {
      const path = pathApi('darwin', explicitRoot);
      const resolvedExplicit = path.resolve(explicitRoot);
      const defaultRoot = path.join(homedir(), 'Library', 'Caches', RUNTIME_CACHE_DIR_NAME);
      const packagedRoot = resolvePackagedPortableRootDir('darwin');
      const packagedRuntimeRoot = path.join(packagedRoot, RUNTIME_CACHE_DIR_NAME);
      const normalizedExplicit = normalizedPathForComparison(resolvedExplicit, 'darwin');
      const normalizedDefault = normalizedPathForComparison(defaultRoot, 'darwin');
      const normalizedPackagedRuntime = normalizedPathForComparison(packagedRuntimeRoot, 'darwin');
      if (normalizedExplicit !== normalizedDefault && normalizedExplicit !== normalizedPackagedRuntime) {
        return defaultRoot;
      }
    }
    return pathApi(process.platform, explicitRoot).resolve(explicitRoot);
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
  const rootDir = resolvePortableRootDir();
  const path = pathApi(process.platform, rootDir);
  const dataDir = path.join(rootDir, PORTABLE_DATA_DIR_NAME);
  const runtimeRootDir = resolveLocalRuntimeRootDir();
  const portableLayout = inspectPortableLayout({ rootDir });
  const forcedPortable = truthyEnv(process.env.CLAWX_PORTABLE);

  // Include structure and permission facts, not just the root path. This
  // invalidates the cache when marker/data/app entries are added or removed,
  // or when a volume becomes read-only, while avoiding any directory or
  // identity-file creation during the probe itself.
  const cacheKey = JSON.stringify({
    platform: process.platform,
    rootDir,
    runtimeRootDir,
    forcedPortable,
    packageType: portableLayout.packageType,
    hasPortableFlag: portableLayout.hasPortableFlag,
    hasDataDirectory: portableLayout.hasDataDirectory,
    hasAppBundle: portableLayout.hasAppBundle,
    rootWritable: portableLayout.rootWritable,
    dataDirectoryWritable: portableLayout.dataDirectoryWritable,
    appBundleWritable: portableLayout.appBundleWritable,
    rootEntryNames: portableLayout.rootEntryNames,
    reason: portableLayout.reason,
  });
  if (cachedPortableModeInfo && cachedPortableModeCacheKey === cacheKey) {
    return cachedPortableModeInfo;
  }
  // Reuse the lstat-based inspection result for mode detection.  `existsSync`
  // also returns true for a regular file or symlink named `UClawData`, which
  // could otherwise make a malformed installed app look portable and pass a
  // path into runtime-layout initialization.  The classifier is deliberately
  // side-effect free and only treats the exact marker file and data directory
  // types as portable signals.
  const hasPortableFlag = portableLayout.hasPortableFlag;
  const hasDataDirectory = portableLayout.hasDataDirectory;
  // On macOS, an app bundle can be launched directly from a DMG or copied
  // into /Applications while an inherited CLAWX_PORTABLE value (or a stale
  // marker) is still present. Do not let that incomplete signal manufacture
  // UClawData or a portable identity beside the installed app. An existing
  // UClawData directory remains authoritative for the data mode so legacy
  // portable roots continue to use their state even when the stricter update
  // replacement contract is incomplete. The update package classifier stays
  // independent and still reports portable_zip for every Darwin client.
  const portableSignal = forcedPortable || hasPortableFlag || hasDataDirectory;
  // On Darwin, portable data mode is enabled only by the complete contract.
  // A legacy/stray UClawData directory beside an app copied from a DMG or
  // /Applications must remain installed mode; it must never trigger runtime
  // directory creation.  The managed update package is still portable_zip,
  // and the updater will direct incomplete layouts through manual migration.
  const enabled = process.platform === 'darwin'
    ? portableSignal && portableLayout.structureComplete
    : portableSignal;
  const updatePackageType = getPortableUpdatePackageType(process.platform);

  const runtimeLayout = enabled
    ? resolvePortableRuntimeLayout({
        rootDir,
        dataDir,
        legacyStateDir: path.join(dataDir, 'openclaw-home', '.openclaw'),
        runtimeRootDir,
      })
    : null;

  cachedPortableModeInfo = enabled
    ? {
        enabled: true,
        mode: 'high-performance',
        updatePackageType,
        packageType: updatePackageType,
        dataMode: 'portable',
        canAutoReplace: portableLayout.canAutoReplace,
        requiresMigration: portableLayout.requiresMigration,
        migrationRequired: portableLayout.migrationRequired,
        migrationReason: portableLayout.reason,
        portableLayout,
        rootDir,
        dataDir,
        clawxDataDir: path.join(dataDir, 'clawx'),
        openclawHomeDir: path.join(dataDir, 'openclaw-home'),
        openclawConfigDir: path.join(dataDir, 'openclaw-home', '.openclaw'),
        updatesDir: path.join(dataDir, 'updates'),
        sessionDataDir: path.join(dataDir, 'clawx', 'electron-session'),
        runtimeRootDir,
        runtimeUpdatesDir: path.join(runtimeRootDir, 'updates'),
        runtimeElectronCacheDir: path.join(runtimeRootDir, 'electron-cache'),
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
        portableId: runtimeLayout?.portableId ?? null,
        runtimeProfileDir: runtimeLayout?.profileDir ?? null,
        runtimeOpenClawStateDir: runtimeLayout?.stateDir ?? null,
        runtimeSnapshotDir: runtimeLayout?.snapshotDir ?? null,
        portableRuntimeLayout: runtimeLayout,
      }
    : {
        enabled: false,
        mode: null,
        updatePackageType,
        packageType: updatePackageType,
        dataMode: 'installed',
        canAutoReplace: false,
        requiresMigration: portableLayout.requiresMigration,
        migrationRequired: portableLayout.migrationRequired,
        migrationReason: portableLayout.reason,
        portableLayout,
        rootDir: null,
        dataDir: null,
        clawxDataDir: null,
        openclawHomeDir: null,
        openclawConfigDir: null,
        updatesDir: null,
        sessionDataDir: null,
        runtimeRootDir: null,
        runtimeUpdatesDir: null,
        runtimeElectronCacheDir: null,
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
        portableId: null,
        runtimeProfileDir: null,
        runtimeOpenClawStateDir: null,
        runtimeSnapshotDir: null,
        portableRuntimeLayout: null,
      };

  cachedPortableModeCacheKey = cacheKey;

  return cachedPortableModeInfo;
}

export function isPortableMode(): boolean {
  return getPortableModeInfo().enabled;
}

/** The colocated state mode, intentionally separate from update package type. */
export function getPortableDataMode(): PortableDataMode {
  return getPortableModeInfo().dataMode;
}

/** True only when the current macOS portable root can be replaced in place. */
export function canAutoReplacePortableUpdate(): boolean {
  const info = getPortableModeInfo();
  if (process.platform !== 'darwin') return info.canAutoReplace;
  // Re-read the complete on-disk contract. The app may have been launched
  // before a portable root was finished (or may lose permissions while it is
  // running), so the cached data-mode flag must not gate the replacement check.
  return getPortableMigrationInfo().canAutoReplace;
}

/** Compatibility alias used by update callers that prefer an `is*` predicate. */
export function isPortableUpdateReplaceable(): boolean {
  return canAutoReplacePortableUpdate();
}

/** Return the side-effect-free migration/layout classification. */
export function getPortableMigrationInfo(): PortableLayoutInspection {
  // Always resolve the current launch root for a replacement decision.  The
  // mode-info cache is intentionally retained for runtime-path stability, but
  // the app bundle/portable selector can change while the process is alive
  // (for example after a volume remount or an app relaunch probe).  Reusing a
  // cached root here could authorize replacing a different, stale directory.
  return inspectPortableLayout({ rootDir: resolvePortableRootDir() });
}

/** Compatibility alias for callers that refer to this as a layout inspection. */
export function getPortableLayoutInspection(): PortableLayoutInspection {
  return getPortableMigrationInfo();
}

/**
 * Guard the external helper launch. Callers should surface this error as a
 * manual-migration prompt instead of attempting to write into `/Applications`.
 */
export function assertPortableUpdateReplaceable(): void {
  if (canAutoReplacePortableUpdate()) return;
  const reason = getPortableMigrationInfo().reason;
  throw new Error(`Portable update requires manual migration (${reason}).`);
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
    info.sessionDataDir,
    info.runtimeRootDir,
    info.runtimeUpdatesDir,
    info.runtimeElectronCacheDir,
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
    info.runtimeProfileDir,
    info.runtimeOpenClawStateDir,
    info.runtimeSnapshotDir,
  ]) {
    if (dir) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';
        // A portable volume may be intentionally mounted read-only. Runtime
        // caches remain usable locally; do not turn a read-only data volume
        // into a startup failure or attempt to create a new root layout.
        if (code !== 'EROFS' && code !== 'EACCES' && code !== 'EPERM') {
          throw error;
        }
      }
    }
  }

  return info;
}

export function applyPortableEnvironment(): PortableModeInfo {
  const info = ensurePortableDataDirs();
  if (!info.enabled || !info.clawxDataDir || !info.openclawHomeDir || !info.openclawConfigDir) {
    // A stale CLAWX_PORTABLE/CLAWX_PORTABLE_ID can be inherited when a user
    // launches a macOS app copied from a USB ZIP, DMG, or /Applications.  The
    // strict classifier intentionally keeps that app in installed mode; make
    // the process environment agree so path helpers do not switch back to
    // portable semantics later in bootstrap.
    if (process.platform === 'darwin' && hasInheritedPortableEnvironment()) {
      clearInheritedPortableEnvironment();
    }
    return info;
  }

  if (info.portableRuntimeLayout) {
    try {
      preparePortableRuntimeState(info.portableRuntimeLayout);
    } catch (error) {
      if (!isReadOnlyFilesystemError(error)) throw error;
      // Keep startup alive when the colocated data volume is read-only. The
      // already-prepared local runtime cache remains available for transient
      // state and the updater will correctly require manual migration.
    }
    if (info.clawxDataDir && info.runtimeProfileDir) {
      try {
        preparePortableClawXStateSync({
          sourceDir: info.clawxDataDir,
          backupDir: pathApi().join(info.runtimeProfileDir, 'clawx-core-state'),
        });
      } catch (error) {
        if (!isReadOnlyFilesystemError(error)) throw error;
        // Recovery is best-effort on a read-only portable volume. Do not make
        // an otherwise usable app fail before it can show the migration UI.
      }
    }
  }

  process.env.CLAWX_PORTABLE = '1';
  process.env.CLAWX_PORTABLE_MODE = info.mode ?? 'high-performance';
  process.env.CLAWX_USER_DATA_DIR = info.clawxDataDir;
  process.env.OPENCLAW_HOME = info.openclawHomeDir;
  process.env.OPENCLAW_STATE_DIR = info.runtimeOpenClawStateDir ?? info.openclawConfigDir;
  process.env.OPENCLAW_CONFIG_PATH = pathApi().join(
    info.runtimeOpenClawStateDir ?? info.openclawConfigDir,
    'openclaw.json',
  );
  process.env.OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG_PATH;
  // Keep OpenClaw's implicit default workspace in the same machine-local
  // state profile. Explicit config workspaces still take precedence, while
  // launches without agents.defaults.workspace no longer fall back to the
  // removable OPENCLAW_HOME tree.
  process.env.OPENCLAW_WORKSPACE_DIR = pathApi().join(
    info.runtimeOpenClawStateDir ?? info.openclawConfigDir,
    'workspace',
  );
  if (info.runtimeSnapshotDir) process.env.CLAWX_PORTABLE_RUNTIME_SNAPSHOT_DIR = info.runtimeSnapshotDir;
  if (info.portableId) process.env.CLAWX_PORTABLE_ID = info.portableId;
  process.env.CLAWX_PORTABLE_RUNTIME_STATE = 'local';

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
  const info = getPortableModeInfo();
  if (info.runtimeUpdatesDir) return info.runtimeUpdatesDir;
  // macOS always downloads the managed portable ZIP, including for an app
  // copied from a DMG or installed under `/Applications`. Keep that cache in
  // the user's local cache and never create UClawData beside the app bundle.
  if (process.platform === 'darwin' && info.updatePackageType === 'portable_zip') {
    const runtimeRootDir = resolveLocalRuntimeRootDir();
    return pathApi(process.platform, runtimeRootDir).join(runtimeRootDir, 'updates');
  }
  return null;
}
