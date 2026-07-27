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
  mockRenameSync,
  mockLoggerWarn,
  mockLoggerInfo,
  mockLoggerError,
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
  mockRenameSync: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerError: vi.fn(),
  mockHomedir: vi.fn(() => '/home/test'),
  mockApp: {
    isPackaged: true,
    getAppPath: vi.fn(() => '/mock/app'),
  },
}));

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');

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
    renameSync: mockRenameSync,
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
    error: mockLoggerError,
  },
}));

vi.mock('@electron/utils/plugin-install-index', () => ({
  upsertPluginInstallRecordsIntoSqlite: vi.fn(() => true),
  ensureOpenClawStateDirExists: vi.fn(),
}));

vi.mock('@electron/utils/paths', () => ({
  resolveOpenClawConfigPath: () => `${mockHomedir()}/.openclaw/openclaw.json`,
  resolveOpenClawStateDir: () => `${mockHomedir()}/.openclaw`,
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
    setPlatform('linux');

    mockExistsSync.mockReturnValue(false);
    mockCpSync.mockImplementation(() => undefined);
    mockMkdirSync.mockImplementation(() => undefined);
    mockRmSync.mockImplementation(() => undefined);
    mockReadFileSync.mockReturnValue('{}');
    mockWriteFileSync.mockImplementation(() => undefined);
    mockReaddirSync.mockReturnValue([]);
    mockRealpathSync.mockImplementation((input: string) => input);
    mockRenameSync.mockImplementation(() => undefined);
  });

  afterEach(() => {
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

  it('repairs a same-version plugin when its local runtime dependency is missing', async () => {
    mockApp.isPackaged = false;
    const sourceDir = '/mock/app/resources/openclaw-plugins/clawx-openai-image';
    const targetDir = '/home/test/.openclaw/extensions/clawx-openai-image';
    const dependencySource = '/mock/app/node_modules/undici';
    const manifest = JSON.stringify({ id: 'clawx-openai-image', version: '0.1.11', entry: 'index.mjs' });
    const packageJson = JSON.stringify({
      name: 'clawx-openai-image-plugin',
      version: '0.1.11',
      main: 'index.mjs',
      dependencies: { undici: '8.1.0' },
    });
    let dependencyCopied = false;

    mockExistsSync.mockImplementation((input: string) => {
      const value = String(input);
      if (value.endsWith('/openclaw.plugin.json') || value.endsWith('/package.json') || value.endsWith('/index.mjs')) {
        if (value.includes('/node_modules/undici/package.json')) {
          return value === `${dependencySource}/package.json` || dependencyCopied;
        }
        return value.startsWith(sourceDir)
          || value.startsWith(targetDir)
          || value.includes('/.uclaw-plugin-install/clawx-openai-image.staging-');
      }
      if (value === `${dependencySource}/package.json`) return true;
      if (value === targetDir) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((input: string) => {
      const value = String(input);
      if (value.endsWith('/package.json') && !value.includes('/node_modules/undici/')) return packageJson;
      if (value.endsWith('/openclaw.plugin.json')) return manifest;
      if (value.endsWith('/index.mjs')) return 'export default {}';
      if (value === `${dependencySource}/package.json`) return JSON.stringify({ name: 'undici', version: '8.1.0' });
      return '{}';
    });
    mockCpSync.mockImplementation((source: string, destination: string) => {
      if (source === dependencySource && destination.includes('/node_modules/undici')) {
        dependencyCopied = true;
      }
    });

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    const result = ensurePluginInstalled('clawx-openai-image', [sourceDir], 'UClaw OpenAI Image');

    expect(result).toEqual({ installed: true });
    expect(mockCpSync).toHaveBeenCalledWith(
      sourceDir,
      expect.stringContaining('/.uclaw-plugin-install/clawx-openai-image.staging-'),
      { recursive: true, dereference: true },
    );
    expect(mockCpSync).toHaveBeenCalledWith(
      dependencySource,
      expect.stringMatching(/\.uclaw-plugin-install\/clawx-openai-image\.staging-.+\/node_modules\/undici$/u),
      { recursive: true, dereference: true },
    );
    expect(mockRenameSync).toHaveBeenCalledWith(
      expect.stringContaining('/.uclaw-plugin-install/clawx-openai-image.staging-'),
      targetDir,
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      '[plugin] Refreshing UClaw OpenAI Image plugin: runtime dependencies missing (undici)',
    );
  });

  it('keeps the installed plugin and reports a missing runtime dependency when repair input is unavailable', async () => {
    mockApp.isPackaged = false;
    const sourceDir = '/mock/app/resources/openclaw-plugins/clawx-openai-image';
    const targetDir = '/home/test/.openclaw/extensions/clawx-openai-image';
    const manifest = JSON.stringify({ id: 'clawx-openai-image', version: '0.1.11', entry: 'index.mjs' });
    const packageJson = JSON.stringify({
      name: 'clawx-openai-image-plugin',
      version: '0.1.11',
      main: 'index.mjs',
      dependencies: { undici: '8.1.0' },
    });

    mockExistsSync.mockImplementation((input: string) => {
      const value = String(input);
      if (value.includes('/node_modules/undici/package.json')) return false;
      if (value.endsWith('/openclaw.plugin.json') || value.endsWith('/package.json') || value.endsWith('/index.mjs')) {
        return value.startsWith(sourceDir)
          || value.startsWith(targetDir)
          || value.includes('/.uclaw-plugin-install/clawx-openai-image.staging-');
      }
      return value === targetDir;
    });
    mockReadFileSync.mockImplementation((input: string) => {
      const value = String(input);
      if (value.endsWith('/package.json')) return packageJson;
      if (value.endsWith('/openclaw.plugin.json')) return manifest;
      if (value.endsWith('/index.mjs')) return 'export default {}';
      return '{}';
    });

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    const result = ensurePluginInstalled('clawx-openai-image', [sourceDir], 'UClaw OpenAI Image');

    expect(result).toEqual({
      installed: false,
      warning: 'Failed to install bundled UClaw OpenAI Image plugin mirror',
    });
    expect(mockRenameSync).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[plugin] Failed to hydrate runtime dependencies',
      expect.objectContaining({ missingDeps: ['undici'] }),
    );
  });

  it('retries once on Windows and logs diagnostic details when bundled copy fails', async () => {
    setPlatform('win32');
    mockHomedir.mockReturnValue('C:\\Users\\test');

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
        targetDir: expect.stringContaining('.openclaw/extensions/wecom'),
        platform: 'win32',
        attempts: [
          expect.objectContaining({ attempt: 1, code: 'EPERM' }),
          expect.objectContaining({ attempt: 2, code: 'EPERM' }),
        ],
      }),
    );
  });

  it('writes trusted install metadata for mirrored official whatsapp plugin', async () => {
    const configPath = '/home/test/.openclaw/openclaw.json';
    const targetDir = '/home/test/.openclaw/extensions/whatsapp';
    const sourceDir = '/bundle/whatsapp';

    mockExistsSync.mockImplementation((input: string) => {
      const value = String(input);
      return value.includes('openclaw.plugin.json')
        || value.endsWith('/index.js')
        || value === configPath
        || value.includes('/bundle/whatsapp/package.json')
        || value.includes(`${targetDir}/package.json`);
    });
    mockReadFileSync.mockImplementation((input: string) => {
      if (String(input) === configPath) {
        return JSON.stringify({
          plugins: {
            allow: ['whatsapp'],
            enabled: true,
          },
        });
      }
      if (String(input).endsWith('package.json')) {
        return JSON.stringify({ name: '@openclaw/whatsapp', version: '2026.6.10', main: 'index.js' });
      }
      if (String(input).endsWith('openclaw.plugin.json')) return JSON.stringify({ id: 'whatsapp', entry: 'index.js' });
      if (String(input).endsWith('index.js')) return 'export default {}';
      return '{}';
    });
    mockRealpathSync.mockImplementation((input: string) => input);

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    const result = ensurePluginInstalled('whatsapp', [sourceDir], 'WhatsApp');

    expect(result.installed).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      configPath,
      expect.stringContaining(`"installPath": "${targetDir}"`),
      'utf-8',
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      configPath,
      expect.stringContaining('"resolvedName": "@openclaw/whatsapp"'),
      'utf-8',
    );
  });
});
