import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  isPackaged: true,
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged;
    },
  },
}));

async function importPortableMode() {
  vi.resetModules();
  return await import('@electron/utils/portable-mode');
}

describe('portable mode', () => {
  const root = join(tmpdir(), `uclaw-portable-${Math.random().toString(36).slice(2)}`);
  const originalPlatform = process.platform;
  const originalExecPath = process.execPath;

  beforeEach(async () => {
    vi.unstubAllEnvs();
    state.isPackaged = true;
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    await rm(root, { recursive: true, force: true });
    vi.stubEnv('CLAWX_PORTABLE_ROOT', root);
    vi.stubEnv('CLAWX_RUNTIME_CACHE_ROOT', join(root, 'LocalRuntime'));
  });

  it('stays disabled without an env flag, marker, or data directory', async () => {
    const { getPortableModeInfo } = await importPortableMode();

    expect(getPortableModeInfo()).toMatchObject({
      enabled: false,
      rootDir: null,
      dataDir: null,
    });
  });

  it('enables portable mode from marker file and creates data directories', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'portable.flag'), 'portable', 'utf-8');
    const { ensurePortableDataDirs } = await importPortableMode();

    const info = ensurePortableDataDirs();

    expect(info).toMatchObject({
      enabled: true,
      mode: 'high-performance',
      rootDir: root,
      dataDir: join(root, 'UClawData'),
      clawxDataDir: join(root, 'UClawData', 'clawx'),
      openclawHomeDir: join(root, 'UClawData', 'openclaw-home'),
      openclawConfigDir: join(root, 'UClawData', 'openclaw-home', '.openclaw'),
      updatesDir: join(root, 'UClawData', 'updates'),
      runtimeRootDir: join(root, 'LocalRuntime'),
      runtimeSessionDataDir: join(root, 'LocalRuntime', 'electron-session'),
      runtimeLogsDir: join(root, 'LocalRuntime', 'logs'),
      runtimeCrashDumpsDir: join(root, 'LocalRuntime', 'crash-dumps'),
      runtimePythonDir: join(root, 'LocalRuntime', 'python'),
      runtimeUvCacheDir: join(root, 'LocalRuntime', 'uv-cache'),
      runtimeUvToolDir: join(root, 'LocalRuntime', 'uv-tools'),
      runtimeTempDir: join(root, 'LocalRuntime', 'tmp'),
      runtimeNodeCompileCacheDir: join(root, 'LocalRuntime', 'node-compile-cache'),
      runtimeBrowserCacheDir: join(root, 'LocalRuntime', 'browser-cache'),
      runtimeXdgCacheDir: join(root, 'LocalRuntime', 'xdg-cache'),
      runtimeCrabboxSyncDir: join(root, 'LocalRuntime', 'crabbox-sync'),
    });
  });

  it('applies portable environment variables for ClawX, OpenClaw, and local runtime caches', async () => {
    vi.stubEnv('CLAWX_PORTABLE', '1');
    const { applyPortableEnvironment } = await importPortableMode();

    const info = applyPortableEnvironment();

    expect(info.enabled).toBe(true);
    expect(process.env.CLAWX_PORTABLE_MODE).toBe('high-performance');
    expect(process.env.CLAWX_USER_DATA_DIR).toBe(join(root, 'UClawData', 'clawx'));
    expect(process.env.OPENCLAW_HOME).toBe(join(root, 'UClawData', 'openclaw-home'));
    expect(process.env.OPENCLAW_STATE_DIR).toBe(join(root, 'UClawData', 'openclaw-home', '.openclaw'));
    expect(process.env.OPENCLAW_CONFIG_PATH).toBe(join(root, 'UClawData', 'openclaw-home', '.openclaw', 'openclaw.json'));
    expect(process.env.OPENCLAW_CONFIG).toBe(process.env.OPENCLAW_CONFIG_PATH);
    expect(process.env.CLAWX_RUNTIME_CACHE_DIR).toBe(join(root, 'LocalRuntime'));
    expect(process.env.UV_PYTHON_INSTALL_DIR).toBe(join(root, 'LocalRuntime', 'python'));
    expect(process.env.UV_CACHE_DIR).toBe(join(root, 'LocalRuntime', 'uv-cache'));
    expect(process.env.UV_TOOL_DIR).toBe(join(root, 'LocalRuntime', 'uv-tools'));
    expect(process.env.NODE_COMPILE_CACHE).toBe(join(root, 'LocalRuntime', 'node-compile-cache'));
    expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBe(join(root, 'LocalRuntime', 'browser-cache'));
    expect(process.env.XDG_CACHE_HOME).toBe(join(root, 'LocalRuntime', 'xdg-cache'));
    expect(process.env.OPENCLAW_CRABBOX_SYNC_TMPDIR).toBe(join(root, 'LocalRuntime', 'crabbox-sync'));
    expect(process.env.TMPDIR).toBe(join(root, 'LocalRuntime', 'tmp'));
    expect(process.env.TMP).toBe(join(root, 'LocalRuntime', 'tmp'));
    expect(process.env.TEMP).toBe(join(root, 'LocalRuntime', 'tmp'));
  });

  it('uses the folder beside the macOS app bundle as the packaged portable root', async () => {
    const volumeRoot = join(root, 'mac-volume');
    vi.unstubAllEnvs();
    vi.stubEnv('CLAWX_RUNTIME_CACHE_ROOT', join(root, 'MacRuntime'));
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process, 'execPath', {
      value: join(volumeRoot, 'UClaw.app', 'Contents', 'MacOS', 'UClaw'),
      configurable: true,
    });
    await mkdir(volumeRoot, { recursive: true });
    await writeFile(join(volumeRoot, 'portable.flag'), 'portable', 'utf-8');

    const { getPortableModeInfo } = await importPortableMode();

    expect(getPortableModeInfo()).toMatchObject({
      enabled: true,
      rootDir: volumeRoot,
      dataDir: join(volumeRoot, 'UClawData'),
    });
  });

  it('uses the executable folder as the packaged Windows portable root', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('CLAWX_PORTABLE', '1');
    vi.stubEnv('CLAWX_RUNTIME_CACHE_ROOT', String.raw`C:\Users\tester\AppData\Local\UClawRuntime`);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    Object.defineProperty(process, 'execPath', {
      value: String.raw`X:\UClaw\UClaw.exe`,
      configurable: true,
    });

    const { getPortableModeInfo } = await importPortableMode();

    expect(getPortableModeInfo()).toMatchObject({
      enabled: true,
      rootDir: String.raw`X:\UClaw`,
      dataDir: win32.join(String.raw`X:\UClaw`, 'UClawData'),
      updatesDir: win32.join(String.raw`X:\UClaw`, 'UClawData', 'updates'),
    });
  });
});
