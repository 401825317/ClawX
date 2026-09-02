// @vitest-environment node

import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from 'electron';

// Keep this classifier test independent from the optional SQLite runtime used
// by the full portable snapshot service. That runtime is exercised separately
// and is not needed for side-effect-free layout inspection.
const {
  preparePortableClawXStateSyncMock,
  preparePortableRuntimeStateMock,
  resolvePortableRuntimeLayoutMock,
} = vi.hoisted(() => ({
  preparePortableClawXStateSyncMock: vi.fn(),
  preparePortableRuntimeStateMock: vi.fn(),
  resolvePortableRuntimeLayoutMock: vi.fn(() => null),
}));
vi.mock('@electron/utils/portable-runtime-state', () => ({
  preparePortableRuntimeState: (...args: unknown[]) => preparePortableRuntimeStateMock(...args),
  resolvePortableRuntimeLayout: resolvePortableRuntimeLayoutMock,
}));
vi.mock('@electron/utils/portable-clawx-state', () => ({
  preparePortableClawXStateSync: (...args: unknown[]) => preparePortableClawXStateSyncMock(...args),
}));
import {
  applyPortableEnvironment,
  assertPortableUpdateReplaceable,
  canAutoReplacePortableUpdate,
  getPortableMigrationInfo,
  getPortableModeInfo,
  getPortableUpdateDownloadsDir,
  getPortableUpdatePackageType,
  inspectPortableLayout,
  resetPortableModeInfoCache,
  shouldUsePortableUpdatePackage,
  resolvePortableRootDir,
} from '@electron/utils/portable-mode';

const temporaryRoots: string[] = [];
const portableEnvironmentNames = [
  'CLAWX_PORTABLE',
  'CLAWX_PORTABLE_MODE',
  'CLAWX_PORTABLE_ID',
  'CLAWX_PORTABLE_RUNTIME_STATE',
  'CLAWX_PORTABLE_RUNTIME_SNAPSHOT_DIR',
  'CLAWX_OPENCLAW_RUNTIME_DIR',
  'CLAWX_PORTABLE_RUNTIME_ROOT',
  'CLAWX_RUNTIME_CACHE_ROOT',
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
  'TMPDIR',
  'TMP',
  'TEMP',
] as const;
const originalPortableEnvironment = Object.fromEntries(
  portableEnvironmentNames.map((name) => [name, process.env[name]]),
) as Record<string, string | undefined>;
const originalPortableRoot = process.env.CLAWX_PORTABLE_ROOT;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalExecPath = Object.getOwnPropertyDescriptor(process, 'execPath');
const originalAppPackaged = app.isPackaged;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: platform,
  });
}

beforeEach(() => {
  for (const name of portableEnvironmentNames) delete process.env[name];
  resolvePortableRuntimeLayoutMock.mockClear();
  resolvePortableRuntimeLayoutMock.mockReturnValue(null);
  preparePortableRuntimeStateMock.mockReset();
  preparePortableRuntimeStateMock.mockImplementation(() => undefined);
  preparePortableClawXStateSyncMock.mockReset();
  preparePortableClawXStateSyncMock.mockImplementation(() => undefined);
  resetPortableModeInfoCache();
});

afterEach(async () => {
  resetPortableModeInfoCache();
  if (originalPortableRoot === undefined) delete process.env.CLAWX_PORTABLE_ROOT;
  else process.env.CLAWX_PORTABLE_ROOT = originalPortableRoot;
  for (const name of portableEnvironmentNames) {
    const value = originalPortableEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  if (originalExecPath) Object.defineProperty(process, 'execPath', originalExecPath);
  app.isPackaged = originalAppPackaged;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createMacPortableRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'uclaw-macos-portable-layout-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'UClaw.app', 'Contents', 'MacOS'), { recursive: true });
  await mkdir(join(root, 'UClawData'), { recursive: true });
  await writeFile(join(root, 'portable.flag'), 'UClaw USB portable mode\n', 'utf8');
  return root;
}

function createRuntimeLayout(rootDir: string, dataDir: string, runtimeRootDir: string) {
  const portableId = 'portable-test-id';
  const profileDir = join(runtimeRootDir, 'profiles', portableId);
  return {
    rootDir,
    dataDir,
    legacyStateDir: join(dataDir, 'openclaw-home', '.openclaw'),
    runtimeRootDir,
    portableId,
    profileDir,
    stateDir: join(profileDir, 'openclaw-state'),
    snapshotDir: join(dataDir, 'runtime-snapshots'),
    snapshotV2Dir: join(dataDir, 'runtime-snapshots-v2'),
    markerPath: join(profileDir, '.uclaw-runtime-state.json'),
    portableIdPath: join(dataDir, '.uclaw-portable-id'),
  };
}

async function createRuntimeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'uclaw-macos-runtime-cache-'));
  temporaryRoots.push(root);
  return root;
}

describe('macOS update package selection', () => {
  it('always selects portable_zip independently of colocated data mode', () => {
    expect(getPortableUpdatePackageType('darwin')).toBe('portable_zip');
    expect(shouldUsePortableUpdatePackage('darwin')).toBe(true);
  });

  it('keeps POSIX selectors POSIX when Darwin is emulated on Windows', () => {
    // The CI macOS runner supplies real `/var/...` temporary roots, while the
    // Windows unit suite emulates Darwin with synthetic selectors.  A
    // `win32.isAbsolute('/var/...')` check incorrectly routes those real macOS
    // paths through win32 path resolution and reports every root as missing.
    setPlatform('darwin');
    app.isPackaged = false;
    process.env.CLAWX_PORTABLE_ROOT = '/tmp/uclaw-posix-selector';

    expect(resolvePortableRootDir()).toBe('/tmp/uclaw-posix-selector');
  });

  it('ignores a stale explicit portable root when a packaged app was copied elsewhere', async () => {
    const staleRoot = await mkdtemp(join(tmpdir(), 'uclaw-macos-stale-root-'));
    temporaryRoots.push(staleRoot);
    const appRoot = await mkdtemp(join(tmpdir(), 'uclaw-macos-packaged-root-'));
    temporaryRoots.push(appRoot);
    setPlatform('darwin');
    app.isPackaged = true;
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: join(appRoot, 'UClaw.app', 'Contents', 'MacOS', 'UClaw'),
    });
    process.env.CLAWX_PORTABLE_ROOT = staleRoot;

    expect(resolvePortableRootDir()).toBe(appRoot);
  });

  it('resolves packaged app roots when the bundle suffix casing differs', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'uclaw-macos-packaged-case-root-'));
    temporaryRoots.push(appRoot);
    setPlatform('darwin');
    app.isPackaged = true;
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: join(appRoot, 'UClaw.APP', 'Contents', 'MacOS', 'UClaw'),
    });

    expect(resolvePortableRootDir()).toBe(appRoot);
  });

  it('ignores a stale runtime-root selector from another volume for packaged apps', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'uclaw-macos-runtime-current-'));
    const staleRuntimeRoot = await mkdtemp(join(tmpdir(), 'uclaw-macos-runtime-stale-'));
    temporaryRoots.push(appRoot, staleRuntimeRoot);
    await mkdir(join(appRoot, 'UClaw.app', 'Contents', 'MacOS'), { recursive: true });
    await mkdir(join(appRoot, 'UClawData'), { recursive: true });
    await writeFile(join(appRoot, 'portable.flag'), 'UClaw USB portable mode\n', 'utf8');
    setPlatform('darwin');
    app.isPackaged = true;
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: join(appRoot, 'UClaw.app', 'Contents', 'MacOS', 'UClaw'),
    });
    process.env.CLAWX_RUNTIME_CACHE_ROOT = staleRuntimeRoot;
    resetPortableModeInfoCache();

    const info = getPortableModeInfo();
    expect(info.enabled).toBe(true);
    expect(info.runtimeRootDir).not.toBe(staleRuntimeRoot);
    expect(info.runtimeRootDir?.replaceAll('\\', '/')).toContain('Library/Caches/UClawRuntime');
  });

  it('preserves a packaged runtime selector scoped to the current app root', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'uclaw-macos-runtime-scoped-'));
    temporaryRoots.push(appRoot);
    await mkdir(join(appRoot, 'UClaw.app', 'Contents', 'MacOS'), { recursive: true });
    await mkdir(join(appRoot, 'UClawData'), { recursive: true });
    await writeFile(join(appRoot, 'portable.flag'), 'UClaw USB portable mode\n', 'utf8');
    const scopedRuntimeRoot = join(appRoot, 'UClawRuntime');
    setPlatform('darwin');
    app.isPackaged = true;
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: join(appRoot, 'UClaw.app', 'Contents', 'MacOS', 'UClaw'),
    });
    process.env.CLAWX_RUNTIME_CACHE_ROOT = scopedRuntimeRoot;
    resetPortableModeInfoCache();

    expect(getPortableModeInfo().runtimeRootDir).toBe(scopedRuntimeRoot);
  });
});

describe('macOS portable layout inspection', () => {
  it('allows replacement only for a complete writable app layout', async () => {
    const root = await createMacPortableRoot();
    const layout = inspectPortableLayout({ platform: 'darwin', rootDir: root });

    expect(layout).toMatchObject({
      packageType: 'portable_zip',
      hasPortableFlag: true,
      hasDataDirectory: true,
      hasAppBundle: true,
      structureComplete: true,
      rootWritable: true,
      dataDirectoryWritable: true,
      appBundleWritable: true,
      writable: true,
      canAutoReplace: true,
      migrationRequired: false,
      reason: 'complete',
    });
  });

  it('keeps macOS ZIP discovery enabled while data mode stays installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-macos-installed-layout-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'UClaw.app', 'Contents', 'MacOS'), { recursive: true });
    setPlatform('darwin');
    process.env.CLAWX_PORTABLE_ROOT = root;
    resetPortableModeInfoCache();

    const info = getPortableModeInfo();
    expect(info.updatePackageType).toBe('portable_zip');
    expect(info.packageType).toBe('portable_zip');
    expect(info.dataMode).toBe('installed');
    expect(info.enabled).toBe(false);
    expect(info.canAutoReplace).toBe(false);
    expect(info.migrationRequired).toBe(true);
    expect(info.migrationReason).toBe('missing-portable-flag');
    expect(getPortableUpdateDownloadsDir()?.replaceAll('\\', '/')).toContain(
      'Library/Caches/UClawRuntime/updates',
    );
  });

  it('requires migration when an app is copied without the portable marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-macos-installed-layout-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'UClaw.app', 'Contents', 'MacOS'), { recursive: true });

    const layout = inspectPortableLayout({ platform: 'darwin', rootDir: root });

    expect(layout.packageType).toBe('portable_zip');
    expect(layout.structureComplete).toBe(false);
    expect(layout.canAutoReplace).toBe(false);
    expect(layout.migrationRequired).toBe(true);
    expect(layout.reason).toBe('missing-portable-flag');
    // Inspection is side-effect free: it must not create UClawData in an
    // installed /Applications-style app just to make an update possible.
    expect(layout.hasDataDirectory).toBe(false);
    expect(existsSync(join(root, 'UClawData'))).toBe(false);
  });

  it('requires exact Darwin portable entry names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-macos-case-layout-'));
    temporaryRoots.push(root);
    // Deliberately use casing variants. On a case-insensitive HFS/APFS volume
    // lstat(root/"portable.flag") would otherwise resolve these entries.
    await mkdir(join(root, 'uclaw.app', 'Contents', 'MacOS'), { recursive: true });
    await mkdir(join(root, 'uclawdata'), { recursive: true });
    await writeFile(join(root, 'Portable.flag'), 'UClaw USB portable mode\n', 'utf8');

    const layout = inspectPortableLayout({ platform: 'darwin', rootDir: root });

    expect(layout.hasPortableFlag).toBe(false);
    expect(layout.hasDataDirectory).toBe(false);
    expect(layout.hasAppBundle).toBe(false);
    expect(layout.structureComplete).toBe(false);
    expect(layout.canAutoReplace).toBe(false);
    expect(layout.reason).toBe('missing-portable-flag');
  });

  it('does not manufacture UClawData from a marker-only macOS layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-macos-marker-layout-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'UClaw.app', 'Contents', 'MacOS'), { recursive: true });
    await writeFile(join(root, 'portable.flag'), 'UClaw USB portable mode\n', 'utf8');
    setPlatform('darwin');
    process.env.CLAWX_PORTABLE_ROOT = root;
    resetPortableModeInfoCache();

    const info = applyPortableEnvironment();
    expect(info.enabled).toBe(false);
    expect(info.dataMode).toBe('installed');
    expect(info.canAutoReplace).toBe(false);
    expect(info.migrationRequired).toBe(true);
    expect(info.migrationReason).toBe('missing-data-directory');
    expect(resolvePortableRuntimeLayoutMock).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'UClawData'))).toBe(false);
  });

  it('does not manufacture UClawData from an environment-forced macOS layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-macos-env-layout-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'UClaw.app', 'Contents', 'MacOS'), { recursive: true });
    setPlatform('darwin');
    process.env.CLAWX_PORTABLE_ROOT = root;
    process.env.CLAWX_PORTABLE = '1';
    resetPortableModeInfoCache();

    const info = applyPortableEnvironment();
    expect(info.enabled).toBe(false);
    expect(info.dataMode).toBe('installed');
    expect(info.packageType).toBe('portable_zip');
    expect(info.migrationRequired).toBe(true);
    expect(info.migrationReason).toBe('missing-portable-flag');
    expect(resolvePortableRuntimeLayoutMock).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'UClawData'))).toBe(false);
  });

  it('clears stale portable environment before an incomplete installed launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-macos-stale-env-layout-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'UClaw.app', 'Contents', 'MacOS'), { recursive: true });
    setPlatform('darwin');
    process.env.CLAWX_PORTABLE_ROOT = root;
    // These values can survive when a USB launcher hands off to an app copied
    // from a ZIP/DMG.  They must not leak into paths.ts after the strict
    // Darwin classifier rejects the incomplete layout.
    process.env.CLAWX_PORTABLE = '1';
    process.env.CLAWX_PORTABLE_ID = 'stale-portable-id';
    process.env.CLAWX_PORTABLE_MODE = 'high-performance';
    process.env.CLAWX_PORTABLE_RUNTIME_ROOT = join(root, 'UClawRuntime');
    process.env.CLAWX_RUNTIME_CACHE_ROOT = join(root, 'UClawRuntime');
    process.env.TMPDIR = join(root, 'UClawRuntime', 'tmp');
    process.env.TMP = join(root, 'UClawRuntime', 'tmp');
    process.env.TEMP = join(root, 'UClawRuntime', 'tmp');
    process.env.OPENCLAW_HOME = join(root, 'UClawData', 'openclaw-home');
    process.env.CLAWX_OPENCLAW_RUNTIME_DIR = join(root, 'UClawRuntime', 'oc', 'stale');
    resetPortableModeInfoCache();

    const info = applyPortableEnvironment();

    expect(info.enabled).toBe(false);
    expect(info.dataMode).toBe('installed');
    expect(info.migrationReason).toBe('missing-portable-flag');
    expect(process.env.CLAWX_PORTABLE).toBeUndefined();
    expect(process.env.CLAWX_PORTABLE_ID).toBeUndefined();
    expect(process.env.CLAWX_PORTABLE_MODE).toBeUndefined();
    expect(process.env.CLAWX_PORTABLE_ROOT).toBeUndefined();
    expect(process.env.CLAWX_PORTABLE_RUNTIME_ROOT).toBeUndefined();
    expect(process.env.CLAWX_RUNTIME_CACHE_ROOT).toBeUndefined();
    expect(process.env.TMPDIR).toBeUndefined();
    expect(process.env.TMP).toBeUndefined();
    expect(process.env.TEMP).toBeUndefined();
    expect(process.env.OPENCLAW_HOME).toBeUndefined();
    expect(process.env.CLAWX_OPENCLAW_RUNTIME_DIR).toBeUndefined();
    expect(existsSync(join(root, 'UClawData'))).toBe(false);
  });

  it('clears derived paths from an ignored stale launcher root', async () => {
    const staleRoot = await mkdtemp(join(tmpdir(), 'uclaw-macos-stale-derived-root-'));
    temporaryRoots.push(staleRoot);
    const appRoot = await mkdtemp(join(tmpdir(), 'uclaw-macos-current-app-root-'));
    temporaryRoots.push(appRoot);
    await mkdir(join(appRoot, 'UClaw.app', 'Contents', 'MacOS'), { recursive: true });

    setPlatform('darwin');
    app.isPackaged = true;
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: join(appRoot, 'UClaw.app', 'Contents', 'MacOS', 'UClaw'),
    });
    // The packaged-app guard ignores this selector because it points at the
    // old USB root. All derived portable paths must still be purged.
    process.env.CLAWX_PORTABLE_ROOT = staleRoot;
    process.env.CLAWX_PORTABLE = '1';
    process.env.CLAWX_PORTABLE_ID = 'stale-id';
    process.env.OPENCLAW_HOME = join(staleRoot, 'UClawData', 'openclaw-home');
    process.env.OPENCLAW_STATE_DIR = join(staleRoot, 'UClawRuntime', 'state');
    process.env.CLAWX_PORTABLE_RUNTIME_SNAPSHOT_DIR = join(staleRoot, 'UClawData', 'snapshots');
    process.env.CLAWX_OPENCLAW_RUNTIME_DIR = join(staleRoot, 'UClawRuntime', 'openclaw');
    resetPortableModeInfoCache();

    const info = applyPortableEnvironment();

    expect(info.enabled).toBe(false);
    expect(info.dataMode).toBe('installed');
    expect(process.env.CLAWX_PORTABLE_ROOT).toBeUndefined();
    expect(process.env.CLAWX_PORTABLE).toBeUndefined();
    expect(process.env.CLAWX_PORTABLE_ID).toBeUndefined();
    expect(process.env.OPENCLAW_HOME).toBeUndefined();
    expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
    expect(process.env.CLAWX_PORTABLE_RUNTIME_SNAPSHOT_DIR).toBeUndefined();
    expect(process.env.CLAWX_OPENCLAW_RUNTIME_DIR).toBeUndefined();
  });

  it('clears launcher-owned paths even when they point outside the stale portable root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-macos-external-env-layout-'));
    const external = await mkdtemp(join(tmpdir(), 'uclaw-macos-external-runtime-'));
    temporaryRoots.push(root, external);
    await mkdir(join(root, 'UClaw.app', 'Contents', 'MacOS'), { recursive: true });
    setPlatform('darwin');
    process.env.CLAWX_PORTABLE_ROOT = root;
    process.env.CLAWX_PORTABLE = '1';
    // These values deliberately do not sit below `root`. They are still
    // launcher-owned values and must not survive cleanup into an installed
    // launch after the portable layout is rejected.
    process.env.OPENCLAW_HOME = join(external, 'openclaw-home');
    process.env.CLAWX_OPENCLAW_RUNTIME_DIR = join(external, 'openclaw-runtime');
    process.env.CLAWX_USER_DATA_DIR = join(external, 'clawx-data');
    process.env.UV_CACHE_DIR = join(external, 'uv-cache');
    resetPortableModeInfoCache();

    const info = applyPortableEnvironment();

    expect(info.enabled).toBe(false);
    expect(process.env.OPENCLAW_HOME).toBeUndefined();
    expect(process.env.CLAWX_OPENCLAW_RUNTIME_DIR).toBeUndefined();
    expect(process.env.CLAWX_USER_DATA_DIR).toBeUndefined();
    expect(process.env.UV_CACHE_DIR).toBeUndefined();
  });

  it('preserves an explicit development root selector without portable mode flags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-macos-dev-selector-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'UClaw.app', 'Contents', 'MacOS'), { recursive: true });
    setPlatform('darwin');
    app.isPackaged = false;
    process.env.CLAWX_PORTABLE_ROOT = root;
    process.env.OPENCLAW_HOME = join(root, 'custom-openclaw-home');
    resetPortableModeInfoCache();

    const info = applyPortableEnvironment();

    expect(info.enabled).toBe(false);
    expect(process.env.CLAWX_PORTABLE_ROOT).toBe(root);
    expect(process.env.OPENCLAW_HOME).toBe(join(root, 'custom-openclaw-home'));
  });

  it('does not treat a non-directory UClawData entry as portable state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-macos-invalid-data-layout-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'UClaw.app', 'Contents', 'MacOS'), { recursive: true });
    // A stale file can be left behind by an interrupted extraction or by an
    // installed app that happens to share the parent directory.  It must not
    // activate runtime-layout initialization, which may otherwise write an
    // identity file through this path.
    await writeFile(join(root, 'UClawData'), 'not a directory\n', 'utf8');
    setPlatform('darwin');
    process.env.CLAWX_PORTABLE_ROOT = root;
    resetPortableModeInfoCache();

    const info = applyPortableEnvironment();
    expect(info.enabled).toBe(false);
    expect(info.dataMode).toBe('installed');
    expect(info.packageType).toBe('portable_zip');
    expect(info.portableLayout.hasDataDirectory).toBe(false);
    expect(info.migrationReason).toBe('missing-portable-flag');
    expect(resolvePortableRuntimeLayoutMock).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'UClawData'))).toBe(true);
  });

  it('does not enable legacy UClawData without the portable marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-macos-data-layout-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'UClaw.app', 'Contents', 'MacOS'), { recursive: true });
    await mkdir(join(root, 'UClawData'), { recursive: true });
    setPlatform('darwin');
    process.env.CLAWX_PORTABLE_ROOT = root;
    resetPortableModeInfoCache();

    const info = getPortableModeInfo();
    // A directory left beside an app copied from a DMG or /Applications is
    // not enough to opt into portable data mode.  Only the complete
    // portable.flag + UClawData + UClaw.app contract enables runtime state;
    // the ZIP update remains discoverable but must use manual migration.
    expect(info.enabled).toBe(false);
    expect(info.dataMode).toBe('installed');
    expect(info.canAutoReplace).toBe(false);
    expect(info.migrationRequired).toBe(true);
    expect(info.migrationReason).toBe('missing-portable-flag');
    expect(resolvePortableRuntimeLayoutMock).not.toHaveBeenCalled();
  });

  it('does not adopt a stray UClawData directory beside an installed macOS app', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-macos-stray-data-layout-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'UClaw.app', 'Contents', 'MacOS'), { recursive: true });
    await mkdir(join(root, 'UClawData'), { recursive: true });
    setPlatform('darwin');
    process.env.CLAWX_PORTABLE_ROOT = root;
    resetPortableModeInfoCache();

    const info = applyPortableEnvironment();
    expect(info.enabled).toBe(false);
    expect(info.dataMode).toBe('installed');
    expect(info.migrationReason).toBe('missing-portable-flag');
    expect(resolvePortableRuntimeLayoutMock).not.toHaveBeenCalled();
    // The pre-existing directory is left untouched; no child state is
    // manufactured and the update remains on the manual migration path.
    expect(existsSync(join(root, 'UClawData'))).toBe(true);
  });

  it('rejects a read-only app bundle for in-place replacement', async () => {
    const root = await createMacPortableRoot();
    const appBundle = join(root, 'UClaw.app');
    await chmod(appBundle, 0o555);

    try {
      const layout = inspectPortableLayout({ platform: 'darwin', rootDir: root });
      expect(layout.structureComplete).toBe(true);
      expect(layout.appBundleWritable).toBe(false);
      expect(layout.writable).toBe(false);
      expect(layout.canAutoReplace).toBe(false);
      expect(layout.reason).toBe('read-only-app-bundle');
      expect(layout.migrationRequired).toBe(true);
    } finally {
      await chmod(appBundle, 0o755);
    }
  });

  it('rejects a read-only data directory before attempting a replacement', async () => {
    const root = await createMacPortableRoot();
    const dataDir = join(root, 'UClawData');
    await chmod(dataDir, 0o555);

    try {
      const layout = inspectPortableLayout({ platform: 'darwin', rootDir: root });
      expect(layout.structureComplete).toBe(true);
      expect(layout.dataDirectoryWritable).toBe(false);
      expect(layout.writable).toBe(false);
      expect(layout.canAutoReplace).toBe(false);
      expect(layout.migrationRequired).toBe(true);
      expect(layout.reason).toBe('read-only-data-directory');
    } finally {
      await chmod(dataDir, 0o755);
    }
  });

  it('rejects a read-only root before attempting a replacement', async () => {
    const root = await createMacPortableRoot();
    await chmod(root, 0o555);

    try {
      const layout = inspectPortableLayout({ platform: 'darwin', rootDir: root });
      expect(layout.structureComplete).toBe(true);
      expect(layout.rootWritable).toBe(false);
      expect(layout.writable).toBe(false);
      expect(layout.canAutoReplace).toBe(false);
      expect(layout.reason).toBe('read-only-root');
    } finally {
      await chmod(root, 0o755);
    }
  });

  it.each(['EROFS', 'EACCES', 'EPERM'])('continues startup when runtime-state preparation reports %s', async (code) => {
      const root = await createMacPortableRoot();
      const runtimeRoot = await createRuntimeRoot();
      setPlatform('darwin');
      process.env.CLAWX_PORTABLE_ROOT = root;
      process.env.CLAWX_RUNTIME_CACHE_ROOT = runtimeRoot;
      resolvePortableRuntimeLayoutMock.mockReturnValue(
        createRuntimeLayout(root, join(root, 'UClawData'), runtimeRoot),
      );
      const error = Object.assign(new Error(`runtime preparation failed: ${code}`), { code });
      preparePortableRuntimeStateMock.mockImplementationOnce(() => { throw error; });
      resetPortableModeInfoCache();

      const info = applyPortableEnvironment();

      expect(info.enabled).toBe(true);
      expect(info.dataMode).toBe('portable');
      expect(preparePortableRuntimeStateMock).toHaveBeenCalledTimes(1);
      expect(preparePortableClawXStateSyncMock).toHaveBeenCalledTimes(1);
      expect(process.env.CLAWX_PORTABLE).toBe('1');
    });

  it('rethrows unexpected runtime-state preparation failures', async () => {
    const root = await createMacPortableRoot();
    const runtimeRoot = await createRuntimeRoot();
    setPlatform('darwin');
    process.env.CLAWX_PORTABLE_ROOT = root;
    process.env.CLAWX_RUNTIME_CACHE_ROOT = runtimeRoot;
    resolvePortableRuntimeLayoutMock.mockReturnValue(
      createRuntimeLayout(root, join(root, 'UClawData'), runtimeRoot),
    );
    const error = Object.assign(new Error('runtime preparation failed: EIO'), { code: 'EIO' });
    preparePortableRuntimeStateMock.mockImplementationOnce(() => { throw error; });
    resetPortableModeInfoCache();

    expect(() => applyPortableEnvironment()).toThrow('runtime preparation failed: EIO');
    expect(preparePortableClawXStateSyncMock).not.toHaveBeenCalled();
  });

  it.each(['EROFS', 'EACCES', 'EPERM'])('continues startup when ClawX state sync reports %s', async (code) => {
      const root = await createMacPortableRoot();
      const runtimeRoot = await createRuntimeRoot();
      setPlatform('darwin');
      process.env.CLAWX_PORTABLE_ROOT = root;
      process.env.CLAWX_RUNTIME_CACHE_ROOT = runtimeRoot;
      resolvePortableRuntimeLayoutMock.mockReturnValue(
        createRuntimeLayout(root, join(root, 'UClawData'), runtimeRoot),
      );
      const error = Object.assign(new Error(`ClawX state sync failed: ${code}`), { code });
      preparePortableClawXStateSyncMock.mockImplementationOnce(() => { throw error; });
      resetPortableModeInfoCache();

      const info = applyPortableEnvironment();

      expect(info.enabled).toBe(true);
      expect(preparePortableRuntimeStateMock).toHaveBeenCalledTimes(1);
      expect(preparePortableClawXStateSyncMock).toHaveBeenCalledTimes(1);
      expect(process.env.CLAWX_PORTABLE).toBe('1');
    });

  it('rethrows unexpected ClawX state sync failures', async () => {
    const root = await createMacPortableRoot();
    const runtimeRoot = await createRuntimeRoot();
    setPlatform('darwin');
    process.env.CLAWX_PORTABLE_ROOT = root;
    process.env.CLAWX_RUNTIME_CACHE_ROOT = runtimeRoot;
    resolvePortableRuntimeLayoutMock.mockReturnValue(
      createRuntimeLayout(root, join(root, 'UClawData'), runtimeRoot),
    );
    const error = Object.assign(new Error('ClawX state sync failed: EIO'), { code: 'EIO' });
    preparePortableClawXStateSyncMock.mockImplementationOnce(() => { throw error; });
    resetPortableModeInfoCache();

    expect(() => applyPortableEnvironment()).toThrow('ClawX state sync failed: EIO');
  });

  it('rechecks a cached layout before launching the replacement helper', async () => {
    const root = await createMacPortableRoot();
    const dataDir = join(root, 'UClawData');
    setPlatform('darwin');
    process.env.CLAWX_PORTABLE_ROOT = root;
    resetPortableModeInfoCache();

    expect(getPortableModeInfo().canAutoReplace).toBe(true);
    await chmod(dataDir, 0o555);

    try {
      expect(canAutoReplacePortableUpdate()).toBe(false);
      expect(getPortableMigrationInfo().reason).toBe('read-only-data-directory');
      expect(() => assertPortableUpdateReplaceable()).toThrow(
        'Portable update requires manual migration (read-only-data-directory).',
      );
    } finally {
      await chmod(dataDir, 0o755);
    }
  });

  it('allows replacement when a previously installed app is converted to a complete portable root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-macos-converted-layout-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'UClaw.app', 'Contents', 'MacOS'), { recursive: true });
    setPlatform('darwin');
    process.env.CLAWX_PORTABLE_ROOT = root;
    resetPortableModeInfoCache();

    expect(getPortableModeInfo().enabled).toBe(false);
    expect(canAutoReplacePortableUpdate()).toBe(false);

    await mkdir(join(root, 'UClawData'), { recursive: true });
    await writeFile(join(root, 'portable.flag'), 'UClaw USB portable mode\n', 'utf8');
    expect(canAutoReplacePortableUpdate()).toBe(true);

    // The classifier is cached for runtime-path stability, but completion of
    // the on-disk contract must invalidate that cache without requiring a
    // process restart or an explicit test-only reset. This lets an update
    // downloaded before migration finish transition to the in-place path.
    const refreshed = getPortableModeInfo();
    expect(refreshed.enabled).toBe(true);
    expect(refreshed.dataMode).toBe('portable');
    expect(refreshed.runtimeUpdatesDir).toBeTruthy();
  });
});
