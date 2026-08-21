// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  fsMocks,
  mockApp,
  mockDelay,
  mockLoggerError,
  mockLoggerInfo,
  mockLoggerWarn,
  mockUpsertPluginInstallRecordsIntoSqlite,
  paths,
} = vi.hoisted(() => ({
  fsMocks: {
    copyFile: vi.fn(),
    copyFailureCode: null as string | null,
  },
  mockApp: {
    isPackaged: true,
    getAppPath: vi.fn(() => process.cwd()),
  },
  mockDelay: vi.fn(async () => undefined),
  mockLoggerError: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockUpsertPluginInstallRecordsIntoSqlite: vi.fn(() => true),
  paths: {
    configPath: '',
    stateDir: '',
  },
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    copyFile: fsMocks.copyFile,
  };
});

vi.mock('node:timers/promises', async () => {
  const actual = await vi.importActual<typeof import('node:timers/promises')>('node:timers/promises');
  return {
    ...actual,
    setTimeout: mockDelay,
  };
});

vi.mock('electron', () => ({ app: mockApp }));

vi.mock('@electron/utils/config-mutex', () => ({
  withConfigLock: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    error: mockLoggerError,
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
  },
}));

vi.mock('@electron/utils/plugin-install-index', () => ({
  upsertPluginInstallRecordsIntoSqlite: mockUpsertPluginInstallRecordsIntoSqlite,
}));

vi.mock('@electron/utils/paths', () => ({
  resolveOpenClawConfigPath: () => paths.configPath,
  resolveOpenClawStateDir: () => paths.stateDir,
}));

type FsPromises = typeof import('node:fs/promises');

let actualFs: FsPromises;
let testRoot: string;

type PluginFixtureOptions = {
  dependencies?: Record<string, string>;
  entry?: string;
  id: string;
  includeEntry?: boolean;
  name: string;
  version?: string;
};

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

async function createPluginFixture(
  directory: string,
  {
    dependencies = {},
    entry = 'index.mjs',
    id,
    includeEntry = true,
    name,
    version = '1.2.3',
  }: PluginFixtureOptions,
): Promise<void> {
  await actualFs.mkdir(directory, { recursive: true });
  await Promise.all([
    actualFs.writeFile(
      join(directory, 'openclaw.plugin.json'),
      `${JSON.stringify({ entry, id, version }, null, 2)}\n`,
      'utf8',
    ),
    actualFs.writeFile(
      join(directory, 'package.json'),
      `${JSON.stringify({ dependencies, main: entry, name, version }, null, 2)}\n`,
      'utf8',
    ),
  ]);
  if (includeEntry) {
    await actualFs.writeFile(join(directory, entry), 'export default {};\n', 'utf8');
  }
}

async function writeManagedPluginMarker(directory: string, pluginId: string): Promise<void> {
  await actualFs.writeFile(
    join(directory, '.uclaw-managed-plugin.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      managedBy: 'uclaw',
      pluginId,
      contentFingerprint: '0'.repeat(64),
      installedAt: '2026-08-19T00:00:00.000Z',
    }, null, 2)}\n`,
    'utf8',
  );
}

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await actualFs.readFile(paths.configPath, 'utf8')) as Record<string, unknown>;
}

describe('plugin installer diagnostics', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    actualFs = await vi.importActual<FsPromises>('node:fs/promises');
    testRoot = await actualFs.mkdtemp(join(tmpdir(), 'uclaw-plugin-install-'));
    paths.stateDir = join(testRoot, 'openclaw-state');
    paths.configPath = join(paths.stateDir, 'openclaw.json');
    await actualFs.mkdir(paths.stateDir, { recursive: true });

    mockApp.isPackaged = true;
    fsMocks.copyFailureCode = null;
    fsMocks.copyFile.mockImplementation(async (...args: Parameters<FsPromises['copyFile']>) => {
      if (fsMocks.copyFailureCode) throw errno(fsMocks.copyFailureCode);
      return Reflect.apply(actualFs.copyFile, actualFs, args) as Promise<void>;
    });
    mockDelay.mockResolvedValue(undefined);
    mockUpsertPluginInstallRecordsIntoSqlite.mockReturnValue(true);
  });

  afterEach(async () => {
    await actualFs.rm(testRoot, { recursive: true, force: true });
  });

  it('returns source-missing warning when bundled mirror cannot be found', async () => {
    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');

    const result = await ensurePluginInstalled('wecom', [join(testRoot, 'missing')], 'WeCom');

    expect(result.installed).toBe(false);
    expect(result.warning).toContain('Bundled WeCom plugin mirror not found');
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('repairs a same-version plugin when its installed runtime dependency is missing', async () => {
    const sourceDir = join(testRoot, 'bundle', 'clawx-openai-image');
    const targetDir = join(paths.stateDir, 'extensions', 'clawx-openai-image');
    const fixture = {
      dependencies: { undici: '8.1.0' },
      id: 'clawx-openai-image',
      name: 'clawx-openai-image-plugin',
      version: '0.1.11',
    };
    await createPluginFixture(sourceDir, fixture);
    await createPluginFixture(targetDir, fixture);
    await actualFs.mkdir(join(sourceDir, 'node_modules', 'undici'), { recursive: true });
    await actualFs.writeFile(
      join(sourceDir, 'node_modules', 'undici', 'package.json'),
      '{"name":"undici","version":"8.1.0"}\n',
      'utf8',
    );

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    const result = await ensurePluginInstalled('clawx-openai-image', [sourceDir], 'UClaw OpenAI Image');

    expect(result).toEqual({ installed: true });
    await expect(actualFs.access(
      join(targetDir, 'node_modules', 'undici', 'package.json'),
    )).resolves.toBeUndefined();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      '[plugin] Refreshing UClaw OpenAI Image plugin: runtime dependencies missing (undici)',
    );
  });

  it('keeps an incomplete installed plugin when no bundled repair source exists', async () => {
    const targetDir = join(paths.stateDir, 'extensions', 'clawx-openai-image');
    await createPluginFixture(targetDir, {
      dependencies: { undici: '8.1.0' },
      id: 'clawx-openai-image',
      name: 'clawx-openai-image-plugin',
      version: '0.1.11',
    });
    await writeManagedPluginMarker(targetDir, 'clawx-openai-image');

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    const result = await ensurePluginInstalled(
      'clawx-openai-image',
      [join(testRoot, 'missing-source')],
      'UClaw OpenAI Image',
    );

    expect(result).toEqual({
      installed: false,
      warning: expect.stringContaining('no bundled repair source is available: undici'),
    });
    await expect(actualFs.access(join(targetDir, 'openclaw.plugin.json'))).resolves.toBeUndefined();
  });

  it('classifies a malformed staged package as a validation failure', async () => {
    const sourceDir = join(testRoot, 'bundle', 'wecom');
    await createPluginFixture(sourceDir, {
      id: 'wecom',
      includeEntry: false,
      name: '@wecom/wecom-openclaw-plugin',
    });

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    const result = await ensurePluginInstalled('wecom', [sourceDir], 'WeCom');

    expect(result).toEqual({
      installed: false,
      warning: 'Failed to install bundled WeCom plugin mirror',
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[plugin] Bundled mirror install failed for WeCom',
      expect.objectContaining({
        attempts: expect.arrayContaining([
          expect.objectContaining({ attempt: 1, phase: 'validation' }),
        ]),
      }),
    );
  });

  it('keeps the root errno and staging phase in failed-copy diagnostics', async () => {
    const sourceDir = join(testRoot, 'bundle', 'wecom');
    await createPluginFixture(sourceDir, {
      id: 'wecom',
      name: '@wecom/wecom-openclaw-plugin',
    });
    fsMocks.copyFailureCode = 'EPERM';

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    const result = await ensurePluginInstalled('wecom', [sourceDir], 'WeCom');

    expect(result).toEqual({
      installed: false,
      warning: 'Failed to install bundled WeCom plugin mirror',
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[plugin] Bundled mirror install failed for WeCom',
      expect.objectContaining({
        attempts: expect.arrayContaining([
          expect.objectContaining({ code: 'EPERM', phase: 'staging-copy' }),
        ]),
      }),
    );
    expect(mockDelay).toHaveBeenCalledWith(150);
  });

  it('preserves a same-name user plugin instead of overwriting it', async () => {
    const pluginId = 'clawx-openai-image';
    const sourceDir = join(testRoot, 'bundle', pluginId);
    const targetDir = join(paths.stateDir, 'extensions', pluginId);
    await createPluginFixture(sourceDir, {
      id: pluginId,
      name: 'clawx-openai-image-plugin',
      version: '2.0.0',
    });
    await createPluginFixture(targetDir, {
      id: pluginId,
      name: 'user-owned-image-plugin',
      version: '9.9.9',
    });
    await actualFs.writeFile(join(targetDir, 'index.mjs'), 'export default { owner: "user" };\n', 'utf8');
    const before = await actualFs.readFile(join(targetDir, 'index.mjs'), 'utf8');

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    const result = await ensurePluginInstalled(pluginId, [sourceDir], 'UClaw OpenAI Image');

    expect(result).toMatchObject({
      installed: false,
      code: 'managed-plugin-ownership-conflict',
      action: 'preserved',
      ownership: {
        status: 'user-owned-or-unknown',
        code: 'ownership_not_proven',
      },
    });
    await expect(actualFs.readFile(join(targetDir, 'index.mjs'), 'utf8')).resolves.toBe(before);
    await expect(actualFs.access(join(targetDir, '.uclaw-managed-plugin.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[plugin] Preserved same-name plugin because UClaw ownership was not proven',
      expect.objectContaining({ pluginId, outcome: 'preserved' }),
    );
  });

  it('upgrades a stale plugin carrying a valid UClaw managed marker', async () => {
    const pluginId = 'uclaw-local-artifacts';
    const sourceDir = join(testRoot, 'bundle', pluginId);
    const targetDir = join(paths.stateDir, 'extensions', pluginId);
    await createPluginFixture(sourceDir, {
      id: pluginId,
      name: 'uclaw-local-artifacts-plugin',
      version: '2.0.0',
    });
    await createPluginFixture(targetDir, {
      id: pluginId,
      name: 'uclaw-local-artifacts-plugin',
      version: '1.0.0',
    });
    await writeManagedPluginMarker(targetDir, pluginId);

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    const installResult = await ensurePluginInstalled(pluginId, [sourceDir], 'UClaw Local Artifacts');
    expect(installResult).toEqual({ installed: true });

    const installedPackage = JSON.parse(
      await actualFs.readFile(join(targetDir, 'package.json'), 'utf8'),
    ) as { version: string };
    const marker = JSON.parse(
      await actualFs.readFile(join(targetDir, '.uclaw-managed-plugin.json'), 'utf8'),
    ) as { managedBy: string; pluginId: string; contentFingerprint: string };
    expect(installedPackage.version).toBe('2.0.0');
    expect(marker).toMatchObject({ managedBy: 'uclaw', pluginId });
    expect(marker.contentFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('uses an integrity-bound trusted install record when the marker is missing', async () => {
    const pluginId = 'whatsapp';
    const sourceDir = join(testRoot, 'bundle', pluginId);
    const targetDir = join(paths.stateDir, 'extensions', pluginId);
    await actualFs.writeFile(paths.configPath, '{"plugins":{"enabled":true}}\n', 'utf8');
    await createPluginFixture(sourceDir, {
      id: pluginId,
      name: '@openclaw/whatsapp',
      version: '1.0.0',
    });

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    await expect(ensurePluginInstalled(pluginId, [sourceDir], 'WhatsApp'))
      .resolves.toEqual({ installed: true });
    await actualFs.rm(join(targetDir, '.uclaw-managed-plugin.json'));
    await createPluginFixture(sourceDir, {
      id: pluginId,
      name: '@openclaw/whatsapp',
      version: '2.0.0',
    });

    await expect(ensurePluginInstalled(pluginId, [sourceDir], 'WhatsApp'))
      .resolves.toEqual({ installed: true });
    const installedPackage = JSON.parse(
      await actualFs.readFile(join(targetDir, 'package.json'), 'utf8'),
    ) as { version: string };
    expect(installedPackage.version).toBe('2.0.0');
  });

  it('fails safe when a managed marker is malformed', async () => {
    const pluginId = 'uclaw-video';
    const sourceDir = join(testRoot, 'bundle', pluginId);
    const targetDir = join(paths.stateDir, 'extensions', pluginId);
    await createPluginFixture(sourceDir, {
      id: pluginId,
      name: 'uclaw-video-plugin',
      version: '2.0.0',
    });
    await createPluginFixture(targetDir, {
      id: pluginId,
      name: 'uclaw-video-plugin',
      version: '1.0.0',
    });
    await actualFs.writeFile(join(targetDir, '.uclaw-managed-plugin.json'), '{broken', 'utf8');
    const before = await actualFs.readFile(join(targetDir, 'package.json'), 'utf8');

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    const result = await ensurePluginInstalled(pluginId, [sourceDir], 'UClaw Video');

    expect(result).toMatchObject({
      installed: false,
      code: 'managed-plugin-ownership-conflict',
      action: 'preserved',
      ownership: {
        status: 'indeterminate',
        evidence: 'invalid-marker',
        code: 'managed_marker_invalid',
      },
    });
    await expect(actualFs.readFile(join(targetDir, 'package.json'), 'utf8')).resolves.toBe(before);
  });

  it('refuses cleanup of an unowned same-name plugin and removes a marked managed one', async () => {
    const pluginId = 'parallel';
    const sourceDir = join(testRoot, 'bundle', pluginId);
    const targetDir = join(paths.stateDir, 'extensions', pluginId);
    await createPluginFixture(sourceDir, {
      id: pluginId,
      name: '@openclaw/parallel-plugin',
      version: '2.0.0',
    });
    await createPluginFixture(targetDir, {
      id: pluginId,
      name: 'user-parallel-plugin',
      version: '1.0.0',
    });

    const { removeManagedPluginInstall } = await import('@electron/utils/plugin-install');
    await expect(removeManagedPluginInstall(pluginId, {
      candidateSources: [sourceDir],
      operation: 'test-cleanup',
    })).resolves.toMatchObject({
      removed: false,
      preserved: true,
      code: 'ownership-conflict',
    });
    await expect(actualFs.access(targetDir)).resolves.toBeUndefined();

    await writeManagedPluginMarker(targetDir, pluginId);
    await expect(removeManagedPluginInstall(pluginId, {
      candidateSources: [sourceDir],
      operation: 'test-cleanup',
    })).resolves.toMatchObject({
      removed: true,
      preserved: false,
      code: 'removed',
    });
    await expect(actualFs.access(targetDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['whatsapp', '@openclaw/whatsapp'],
    ['parallel', '@openclaw/parallel-plugin'],
  ] as const)('writes trusted install metadata for mirrored official %s plugin', async (pluginId, npmName) => {
    const sourceDir = join(testRoot, 'bundle', pluginId);
    await createPluginFixture(sourceDir, {
      id: pluginId,
      name: npmName,
      version: '2026.6.10',
    });
    await actualFs.writeFile(
      paths.configPath,
      '{"plugins":{"allow":[],"enabled":true}}\n',
      'utf8',
    );

    const { ensurePluginInstalled } = await import('@electron/utils/plugin-install');
    const result = await ensurePluginInstalled(pluginId, [sourceDir], pluginId);
    const config = await readConfig() as {
      plugins?: { installs?: Record<string, Record<string, unknown>> };
    };

    expect(result).toEqual({ installed: true });
    expect(config.plugins?.installs?.[pluginId]).toMatchObject({
      resolvedName: npmName,
      source: 'npm',
      version: '2026.6.10',
    });
  });

  it('repairs all trusted plugin records in one SQLite batch', async () => {
    await actualFs.writeFile(paths.configPath, '{"plugins":{"enabled":true}}\n', 'utf8');
    for (const [pluginId, npmName] of [
      ['whatsapp', '@openclaw/whatsapp'],
      ['discord', '@openclaw/discord'],
      ['qqbot', '@openclaw/qqbot'],
      ['parallel', '@openclaw/parallel-plugin'],
    ] as const) {
      await createPluginFixture(join(paths.stateDir, 'extensions', pluginId), {
        id: pluginId,
        name: npmName,
      });
      await writeManagedPluginMarker(join(paths.stateDir, 'extensions', pluginId), pluginId);
    }

    const { repairTrustedOfficialPluginInstallRecords } = await import('@electron/utils/plugin-install');
    await repairTrustedOfficialPluginInstallRecords();

    const config = await readConfig() as {
      plugins?: { installs?: Record<string, unknown> };
    };
    expect(Object.keys(config.plugins?.installs ?? {}).sort()).toEqual([
      'discord',
      'parallel',
      'qqbot',
      'whatsapp',
    ]);
    expect(mockUpsertPluginInstallRecordsIntoSqlite).toHaveBeenCalledTimes(1);
    expect(mockUpsertPluginInstallRecordsIntoSqlite).toHaveBeenCalledWith(
      expect.objectContaining({
        discord: expect.any(Object),
        parallel: expect.any(Object),
        qqbot: expect.any(Object),
        whatsapp: expect.any(Object),
      }),
    );
  });
});
