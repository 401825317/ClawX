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
        targetDir: expect.stringContaining('.openclaw\\extensions\\wecom'),
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
    expect(mockRmSync).toHaveBeenCalledWith(expect.stringContaining('.openclaw\\extensions\\clawx-openai-image'), {
      recursive: true,
      force: true,
    });
    expect(mockCpSync).toHaveBeenCalledWith(
      '/bundle/clawx-openai-image',
      expect.stringContaining('.openclaw\\extensions\\clawx-openai-image'),
      { recursive: true, dereference: true },
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      '[plugin] Refreshing UClaw OpenAI Image plugin: bundled content changed without version bump',
    );
  });

  it('chooses the newest bundled source instead of a stale source that matches the installed copy', async () => {
    const buildDir = '/app/build/openclaw-plugins/uclaw-computer-use';
    const resourcesDir = '/app/resources/openclaw-plugins/uclaw-computer-use';
    const targetDir = '/home/test/.openclaw/extensions/uclaw-computer-use';

    mockExistsSync.mockImplementation((input: string) => normalizeTestPath(input).endsWith('/openclaw.plugin.json'));
    mockReadFileSync.mockImplementation((input: string) => {
      const filePath = normalizeTestPath(input);
      if (filePath.endsWith('/openclaw.plugin.json')) {
        const hasNewTool = filePath.startsWith(resourcesDir);
        return JSON.stringify({
          id: 'uclaw-computer-use',
          entry: 'index.mjs',
          contracts: {
            tools: hasNewTool ? ['computer_screenshot', 'computer_web_observe'] : ['computer_screenshot'],
          },
        });
      }
      if (filePath.endsWith('/package.json')) {
        return JSON.stringify({ name: 'uclaw-computer-use-plugin', version: '0.1.0', main: 'index.mjs' });
      }
      if (filePath.endsWith('/index.mjs')) {
        return filePath.startsWith(resourcesDir)
          ? 'export const tool = "computer_web_observe";'
          : 'export const tool = "computer_screenshot";';
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
});
