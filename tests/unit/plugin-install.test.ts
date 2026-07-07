import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockExistsSync,
  mockCpSync,
  mockCopyFileSync,
  mockStatSync,
  mockMkdirSync,
  mockRmSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockReaddirSync,
  mockRealpathSync,
  mockLoggerWarn,
  mockLoggerInfo,
  mockHomedir,
  mockApp,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockCpSync: vi.fn(),
  mockCopyFileSync: vi.fn(),
  mockStatSync: vi.fn(() => ({ isDirectory: () => false })),
  mockMkdirSync: vi.fn(),
  mockRmSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockReaddirSync: vi.fn(),
  mockRealpathSync: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockHomedir: vi.fn(() => '/home/test'),
  mockApp: {
    isPackaged: true,
    getAppPath: vi.fn(() => '/mock/app'),
  },
}));

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');

function normalizeTestPath(input: unknown): string {
  return String(input).replace(/\\/g, '/');
}

function dependencyPathSegment(dependencyName: string): string {
  return dependencyName.split('/').join('/');
}

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const mocked = {
    ...actual,
    existsSync: mockExistsSync,
    cpSync: mockCpSync,
    copyFileSync: mockCopyFileSync,
    statSync: mockStatSync,
    mkdirSync: mockMkdirSync,
    rmSync: mockRmSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    readdirSync: mockReaddirSync,
    realpathSync: mockRealpathSync,
  };
  return {
    ...mocked,
    default: mocked,
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readdir: vi.fn(),
    stat: vi.fn(),
    copyFile: vi.fn(),
    mkdir: vi.fn(),
  };
});

vi.mock('node:os', () => ({
  homedir: () => mockHomedir(),
  default: {
    homedir: () => mockHomedir(),
  },
}));

vi.mock('electron', () => ({
  app: mockApp,
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    warn: mockLoggerWarn,
    info: mockLoggerInfo,
  },
}));

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

describe('plugin installer diagnostics', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockApp.isPackaged = true;
    mockHomedir.mockReturnValue('/home/test');
    process.env.OPENCLAW_HOME = '/home/test';
    setPlatform('linux');

    mockExistsSync.mockReturnValue(false);
    mockCpSync.mockImplementation(() => undefined);
    mockMkdirSync.mockImplementation(() => undefined);
    mockRmSync.mockImplementation(() => undefined);
    mockReadFileSync.mockReturnValue('{}');
    mockWriteFileSync.mockImplementation(() => undefined);
    mockReaddirSync.mockReturnValue([]);
    mockRealpathSync.mockImplementation((input: string) => input);
  });

  afterEach(() => {
    delete process.env.OPENCLAW_HOME;
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
  });

  it('returns source-missing warning when bundled mirror cannot be found', async () => {
    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    const result = ensurePluginInstalled('wecom', ['/bundle/wecom'], 'WeCom');

    expect(result.installed).toBe(false);
    expect(result.warning).toContain('Bundled WeCom plugin mirror not found');
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('retries once on Windows and logs diagnostic details when bundled copy fails', async () => {
    setPlatform('win32');
    mockHomedir.mockReturnValue('C:\\Users\\test');
    process.env.OPENCLAW_HOME = 'C:\\Users\\test';

    const sourceDir = 'C:\\Program Files\\ClawX\\resources\\openclaw-plugins\\wecom';
    const sourceManifestSuffix = 'Program Files\\ClawX\\resources\\openclaw-plugins\\wecom\\openclaw.plugin.json';

    mockExistsSync.mockImplementation((input: string) => String(input).includes(sourceManifestSuffix));
    // On win32, cpSyncSafe uses _copyDirSyncRecursive (readdirSync) instead of cpSync.
    // Simulate copy failure by making readdirSync throw during directory traversal.
    mockReaddirSync.mockImplementation((_path: string, opts?: unknown) => {
      if (opts && typeof opts === 'object' && 'withFileTypes' in (opts as Record<string, unknown>)) {
        const error = new Error('path too long') as NodeJS.ErrnoException;
        error.code = 'ENAMETOOLONG';
        throw error;
      }
      return [];
    });

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    const result = ensurePluginInstalled('wecom', [sourceDir], 'WeCom');

    expect(result).toEqual({
      installed: false,
      warning: 'Failed to install bundled WeCom plugin mirror',
    });

    // On win32, cpSyncSafe walks the directory via readdirSync (with withFileTypes)
    const copyAttempts = mockReaddirSync.mock.calls.filter(
      (call: unknown[]) => {
        const opts = call[1];
        return opts && typeof opts === 'object' && 'withFileTypes' in (opts as Record<string, unknown>);
      },
    );
    expect(copyAttempts).toHaveLength(2); // initial + 1 retry
    const firstSrcPath = String(copyAttempts[0][0]);
    expect(firstSrcPath.startsWith('\\\\?\\')).toBe(true);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[plugin] Bundled mirror install failed for WeCom',
      expect.objectContaining({
        pluginDirName: 'wecom',
        pluginLabel: 'WeCom',
        sourceDir,
        platform: 'win32',
        attempts: [
          expect.objectContaining({ attempt: 1, code: 'ENAMETOOLONG' }),
          expect.objectContaining({ attempt: 2, code: 'ENAMETOOLONG' }),
        ],
      }),
    );
  });

  it('logs EPERM diagnostics with source and target paths', async () => {
    setPlatform('win32');
    mockHomedir.mockReturnValue('C:\\Users\\test');

    const sourceDir = 'C:\\Program Files\\ClawX\\resources\\openclaw-plugins\\wecom';
    const sourceManifestSuffix = 'Program Files\\ClawX\\resources\\openclaw-plugins\\wecom\\openclaw.plugin.json';

    mockExistsSync.mockImplementation((input: string) => String(input).includes(sourceManifestSuffix));
    // On win32, cpSyncSafe uses _copyDirSyncRecursive (readdirSync) instead of cpSync.
    mockReaddirSync.mockImplementation((_path: string, opts?: unknown) => {
      if (opts && typeof opts === 'object' && 'withFileTypes' in (opts as Record<string, unknown>)) {
        const error = new Error('access denied') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return [];
    });

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    const result = ensurePluginInstalled('wecom', [sourceDir], 'WeCom');

    expect(result.installed).toBe(false);
    expect(result.warning).toBe('Failed to install bundled WeCom plugin mirror');

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[plugin] Bundled mirror install failed for WeCom',
      expect.objectContaining({
        sourceDir,
        targetDir: expect.stringMatching(/[\\/]\.openclaw[\\/]extensions[\\/]wecom$/),
        platform: 'win32',
        attempts: [
          expect.objectContaining({ attempt: 1, code: 'EPERM' }),
          expect.objectContaining({ attempt: 2, code: 'EPERM' }),
        ],
      }),
    );
  });

  it('refreshes an installed plugin when bundled content changes without a version bump', async () => {
    const sourceDir = '/bundle/clawx-openai-image';
    const targetDir = '/home/test/.openclaw/extensions/clawx-openai-image';
    const sourceManifest = `${sourceDir}/openclaw.plugin.json`;
    const sourcePackage = `${sourceDir}/package.json`;
    const sourceEntry = `${sourceDir}/index.mjs`;
    const targetManifest = `${targetDir}/openclaw.plugin.json`;
    const targetPackage = `${targetDir}/package.json`;
    const targetEntry = `${targetDir}/index.mjs`;

    mockExistsSync.mockImplementation((input: string) => {
      const filePath = normalizeTestPath(input);
      return [
        sourceManifest,
        sourcePackage,
        sourceEntry,
        targetManifest,
        targetPackage,
        targetEntry,
      ].includes(filePath) || filePath.endsWith('/.openclaw/extensions/clawx-openai-image/openclaw.plugin.json');
    });

    mockReadFileSync.mockImplementation((input: string) => {
      const filePath = normalizeTestPath(input);
      const isSource = filePath.includes('/bundle/clawx-openai-image/');
      const isTarget = filePath.includes('/.openclaw/extensions/clawx-openai-image/');
      if (isSource || isTarget) {
        if (filePath.endsWith('/openclaw.plugin.json')) {
          return JSON.stringify({ id: 'clawx-openai-image', entry: 'index.mjs' });
        }
        if (filePath.endsWith('/package.json')) {
          return JSON.stringify({ name: 'clawx-openai-image-plugin', version: '0.1.4', main: 'index.mjs' });
        }
        if (filePath.endsWith('/index.mjs') && isSource) {
          return 'export const value = "new";';
        }
        if (filePath.endsWith('/index.mjs') && isTarget) {
          return 'export const value = "old";';
        }
      }
      return '{}';
    });

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    const result = ensurePluginInstalled('clawx-openai-image', [sourceDir], 'UClaw OpenAI Image');

    expect(result).toEqual({ installed: true });
    expect(mockRmSync).toHaveBeenCalledWith(expect.stringMatching(/[\\/]\.openclaw[\\/]extensions[\\/]clawx-openai-image$/), {
      recursive: true,
      force: true,
    });
    expect(mockCpSync).toHaveBeenCalledWith(
      '/bundle/clawx-openai-image',
      expect.stringMatching(/[\\/]\.openclaw[\\/]extensions[\\/]clawx-openai-image$/),
      { recursive: true, dereference: true },
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      '[plugin] Refreshing UClaw OpenAI Image plugin: bundled content changed without version bump',
    );
  });

  it('installs the UClaw local artifacts plugin from bundled helper sources', async () => {
    mockApp.isPackaged = false;

    const sourceDir = '/mock/app/resources/openclaw-plugins/uclaw-local-artifacts';
    const targetDir = '/home/test/.openclaw/extensions/uclaw-local-artifacts';
    const sourceManifest = `${sourceDir}/openclaw.plugin.json`;
    const sourcePackage = `${sourceDir}/package.json`;
    const sourceEntry = `${sourceDir}/index.mjs`;
    const targetManifest = `${targetDir}/openclaw.plugin.json`;
    const targetPackage = `${targetDir}/package.json`;
    const targetEntry = `${targetDir}/index.mjs`;
    let copied = false;

    mockCpSync.mockImplementation(() => {
      copied = true;
    });
    mockExistsSync.mockImplementation((input: string) => {
      const filePath = normalizeTestPath(input);
      if ([sourceManifest, sourcePackage, sourceEntry].includes(filePath)) {
        return true;
      }
      return copied && [targetManifest, targetPackage, targetEntry].includes(filePath);
    });
    mockReadFileSync.mockImplementation((input: string) => {
      const filePath = normalizeTestPath(input);
      if (filePath.endsWith('/openclaw.plugin.json')) {
        return JSON.stringify({ id: 'uclaw-local-artifacts', entry: 'index.mjs' });
      }
      if (filePath.endsWith('/package.json')) {
        return JSON.stringify({ name: 'uclaw-local-artifacts-plugin', version: '0.1.0', main: 'index.mjs' });
      }
      if (filePath.endsWith('/index.mjs')) {
        return 'export const plugin = { id: "uclaw-local-artifacts" };';
      }
      return '{}';
    });

    const { ensureUClawLocalArtifactsPluginInstalled } = await import('@electron/utils/plugin-install');
    const result = ensureUClawLocalArtifactsPluginInstalled();

    expect(result).toEqual({ installed: true });
    expect(mockCpSync).toHaveBeenCalledWith(
      sourceDir,
      expect.stringMatching(/[\\/]\.openclaw[\\/]extensions[\\/]uclaw-local-artifacts$/),
      { recursive: true, dereference: true },
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      `Installed UClaw Local Artifacts plugin from bundled mirror: ${sourceDir}`,
    );
  });

  it('hydrates UClaw local artifacts runtime deps when installing from raw helper sources in dev', async () => {
    mockApp.isPackaged = false;

    const sourceDir = '/mock/app/resources/openclaw-plugins/uclaw-local-artifacts';
    const targetDir = '/home/test/.openclaw/extensions/uclaw-local-artifacts';
    const sourceManifest = `${sourceDir}/openclaw.plugin.json`;
    const sourcePackage = `${sourceDir}/package.json`;
    const sourceEntry = `${sourceDir}/index.mjs`;
    const targetManifest = `${targetDir}/openclaw.plugin.json`;
    const targetPackage = `${targetDir}/package.json`;
    const targetEntry = `${targetDir}/index.mjs`;
    const runtimeDeps = ['@sinclair/typebox', 'jszip', 'xlsx'];
    const copiedDeps = new Set<string>();
    let copiedPlugin = false;

    mockCpSync.mockImplementation((src: string, dest: string) => {
      const sourcePath = normalizeTestPath(src);
      const destPath = normalizeTestPath(dest);
      if (sourcePath === sourceDir && destPath === targetDir) {
        copiedPlugin = true;
      }
      for (const depName of runtimeDeps) {
        const depSegment = dependencyPathSegment(depName);
        if (
          sourcePath.endsWith(`/node_modules/${depSegment}`) &&
          destPath === `${targetDir}/node_modules/${depSegment}`
        ) {
          copiedDeps.add(depName);
        }
      }
    });
    mockReaddirSync.mockReturnValue([]);
    mockExistsSync.mockImplementation((input: string) => {
      const filePath = normalizeTestPath(input);
      if ([sourceManifest, sourcePackage, sourceEntry].includes(filePath)) {
        return true;
      }
      if (copiedPlugin && [targetManifest, targetPackage, targetEntry].includes(filePath)) {
        return true;
      }
      for (const depName of runtimeDeps) {
        const depSegment = dependencyPathSegment(depName);
        if (filePath === `${process.cwd()}/node_modules/${depSegment}`) {
          return true;
        }
        if (
          filePath === `${targetDir}/node_modules/${depSegment}` ||
          filePath === `${targetDir}/node_modules/${depSegment}/package.json`
        ) {
          return copiedDeps.has(depName);
        }
      }
      return false;
    });
    mockReadFileSync.mockImplementation((input: string) => {
      const filePath = normalizeTestPath(input);
      if (filePath.endsWith('/openclaw.plugin.json')) {
        return JSON.stringify({ id: 'uclaw-local-artifacts', entry: 'index.mjs' });
      }
      if (filePath.endsWith('/package.json')) {
        return JSON.stringify({
          name: 'uclaw-local-artifacts-plugin',
          version: '0.1.0',
          main: 'index.mjs',
          dependencies: {
            '@sinclair/typebox': '^0.34.48',
            jszip: '3.10.1',
            xlsx: '^0.18.5',
          },
        });
      }
      if (filePath.endsWith('/index.mjs')) {
        return 'export const plugin = { id: "uclaw-local-artifacts" };';
      }
      return '{}';
    });

    const { ensureUClawLocalArtifactsPluginInstalled } = await import('@electron/utils/plugin-install');
    const result = ensureUClawLocalArtifactsPluginInstalled();

    expect(result).toEqual({ installed: true });
    expect(copiedDeps).toEqual(new Set(runtimeDeps));
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      '[plugin] Hydrated 3 runtime deps for UClaw Local Artifacts from root node_modules',
    );
  });

  it('refreshes an installed UClaw local artifacts plugin when runtime deps are missing', async () => {
    const sourceDir = '/bundle/uclaw-local-artifacts';
    const targetDir = '/home/test/.openclaw/extensions/uclaw-local-artifacts';
    const runtimeDeps = ['@sinclair/typebox', 'jszip', 'xlsx'];
    let refreshed = false;

    mockCpSync.mockImplementation((src: string, dest: string) => {
      if (normalizeTestPath(src) === sourceDir && normalizeTestPath(dest) === targetDir) {
        refreshed = true;
      }
    });
    mockExistsSync.mockImplementation((input: string) => {
      const filePath = normalizeTestPath(input);
      if (
        [
          `${sourceDir}/openclaw.plugin.json`,
          `${sourceDir}/package.json`,
          `${sourceDir}/index.mjs`,
          `${targetDir}/openclaw.plugin.json`,
          `${targetDir}/package.json`,
          `${targetDir}/index.mjs`,
        ].includes(filePath)
      ) {
        return true;
      }
      for (const depName of runtimeDeps) {
        const depSegment = dependencyPathSegment(depName);
        if (
          filePath === `${sourceDir}/node_modules/${depSegment}` ||
          filePath === `${sourceDir}/node_modules/${depSegment}/package.json`
        ) {
          return true;
        }
        if (
          filePath === `${targetDir}/node_modules/${depSegment}` ||
          filePath === `${targetDir}/node_modules/${depSegment}/package.json`
        ) {
          return refreshed;
        }
      }
      return false;
    });
    mockReadFileSync.mockImplementation((input: string) => {
      const filePath = normalizeTestPath(input);
      if (filePath.endsWith('/openclaw.plugin.json')) {
        return JSON.stringify({ id: 'uclaw-local-artifacts', entry: 'index.mjs' });
      }
      if (filePath.endsWith('/package.json')) {
        return JSON.stringify({
          name: 'uclaw-local-artifacts-plugin',
          version: '0.1.0',
          main: 'index.mjs',
          dependencies: {
            '@sinclair/typebox': '^0.34.48',
            jszip: '3.10.1',
            xlsx: '^0.18.5',
          },
        });
      }
      if (filePath.endsWith('/index.mjs')) {
        return 'export const plugin = { id: "uclaw-local-artifacts" };';
      }
      return '{}';
    });

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    const result = ensurePluginInstalled('uclaw-local-artifacts', [sourceDir], 'UClaw Local Artifacts');

    expect(result).toEqual({ installed: true });
    expect(mockCpSync).toHaveBeenCalledWith(
      sourceDir,
      expect.stringMatching(/[\\/]\.openclaw[\\/]extensions[\\/]uclaw-local-artifacts$/),
      { recursive: true, dereference: true },
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      '[plugin] Refreshing UClaw Local Artifacts plugin: runtime deps missing (@sinclair/typebox, jszip, xlsx)',
    );
  });

  it('chooses the newest bundled source instead of a stale source that matches the installed copy', async () => {
    const buildDir = '/app/build/openclaw-plugins/uclaw-artifact-guard';
    const resourcesDir = '/app/resources/openclaw-plugins/uclaw-artifact-guard';
    const targetDir = '/home/test/.openclaw/extensions/uclaw-artifact-guard';

    mockExistsSync.mockImplementation((input: string) => normalizeTestPath(input).endsWith('/openclaw.plugin.json'));
    mockReadFileSync.mockImplementation((input: string) => {
      const filePath = normalizeTestPath(input);
      if (filePath.endsWith('/openclaw.plugin.json')) {
        const hasNewTool = filePath.startsWith(resourcesDir);
        return JSON.stringify({
          id: 'uclaw-artifact-guard',
          entry: 'index.mjs',
          contracts: {
            hooks: hasNewTool ? ['before_agent_finalize', 'before_prompt_build'] : ['before_agent_finalize'],
          },
        });
      }
      if (filePath.endsWith('/package.json')) {
        return JSON.stringify({ name: 'uclaw-artifact-guard-plugin', version: '0.1.0', main: 'index.mjs' });
      }
      if (filePath.endsWith('/index.mjs')) {
        return filePath.startsWith(resourcesDir)
          ? 'export const hook = "before_prompt_build";'
          : 'export const hook = "before_agent_finalize";';
      }
      return '{}';
    });
    mockStatSync.mockImplementation((input: string) => ({
      isDirectory: () => false,
      mtimeMs: normalizeTestPath(input).startsWith(resourcesDir) ? 200 : 100,
    }) as never);

    const { findBestBundledPluginSource } = await import('@electron/utils/plugin-install');

    expect(findBestBundledPluginSource([buildDir, resourcesDir], targetDir)).toBe(resourcesDir);
  });

  it('prefers a dependency-complete local plugin bundle over a newer raw source', async () => {
    const buildDir = '/app/build/openclaw-plugins/uclaw-local-artifacts';
    const resourcesDir = '/app/resources/openclaw-plugins/uclaw-local-artifacts';
    const runtimeDeps = ['@sinclair/typebox', 'jszip', 'xlsx'];

    mockExistsSync.mockImplementation((input: string) => {
      const filePath = normalizeTestPath(input);
      if (
        filePath === `${buildDir}/openclaw.plugin.json` ||
        filePath === `${resourcesDir}/openclaw.plugin.json`
      ) {
        return true;
      }
      for (const depName of runtimeDeps) {
        const depSegment = dependencyPathSegment(depName);
        if (
          filePath === `${buildDir}/node_modules/${depSegment}` ||
          filePath === `${buildDir}/node_modules/${depSegment}/package.json`
        ) {
          return true;
        }
      }
      return false;
    });
    mockReadFileSync.mockImplementation((input: string) => {
      const filePath = normalizeTestPath(input);
      if (filePath.endsWith('/openclaw.plugin.json')) {
        return JSON.stringify({ id: 'uclaw-local-artifacts', entry: 'index.mjs' });
      }
      if (filePath.endsWith('/package.json')) {
        return JSON.stringify({
          name: 'uclaw-local-artifacts-plugin',
          version: '0.1.0',
          main: 'index.mjs',
          dependencies: {
            '@sinclair/typebox': '^0.34.48',
            jszip: '3.10.1',
            xlsx: '^0.18.5',
          },
        });
      }
      if (filePath.endsWith('/index.mjs')) {
        return 'export const plugin = { id: "uclaw-local-artifacts" };';
      }
      return '{}';
    });
    mockStatSync.mockImplementation((input: string) => ({
      isDirectory: () => false,
      mtimeMs: normalizeTestPath(input).startsWith(resourcesDir) ? 200 : 100,
    }) as never);

    const { findBestBundledPluginSource } = await import('@electron/utils/plugin-install');

    expect(findBestBundledPluginSource([buildDir, resourcesDir])).toBe(buildDir);
  });
});
