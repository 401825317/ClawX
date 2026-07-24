// @vitest-environment node

import { chmod, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { testHome, testUserData, getSettingMock } = vi.hoisted(() => {
  const suffix = Math.random().toString(36).slice(2);
  return {
    testHome: `/tmp/clawx-openclaw-auth-${suffix}`,
    testUserData: `/tmp/clawx-openclaw-auth-user-data-${suffix}`,
    getSettingMock: vi.fn(),
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const mocked = {
    ...actual,
    homedir: () => testHome,
  };
  return {
    ...mocked,
    default: mocked,
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => testUserData,
    getVersion: () => '0.0.0-test',
  },
}));

vi.mock('@electron/utils/store', () => ({
  getSetting: getSettingMock,
}));

vi.mock('@electron/utils/paths', async () => {
  const actual = await vi.importActual<typeof import('@electron/utils/paths')>('@electron/utils/paths');
  const resolvedDir = join(testHome, '.openclaw-test-openclaw');
  return {
    ...actual,
    getOpenClawResolvedDir: () => resolvedDir,
    getOpenClawDir: () => resolvedDir,
  };
});

async function writeOpenClawJson(config: unknown): Promise<void> {
  const openclawDir = join(testHome, '.openclaw');
  await mkdir(openclawDir, { recursive: true });
  await writeFile(join(openclawDir, 'openclaw.json'), JSON.stringify(config, null, 2), 'utf8');
}

async function readOpenClawJson(): Promise<Record<string, unknown>> {
  const content = await readFile(join(testHome, '.openclaw', 'openclaw.json'), 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
}

async function readAuthProfiles(agentId: string): Promise<Record<string, unknown>> {
  const content = await readFile(getAgentAuthProfilesPath(agentId), 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
}

function getAgentAuthProfilesPath(agentId: string): string {
  return join(testHome, '.openclaw', 'agents', agentId, 'agent', 'auth-profiles.json');
}

async function writeAgentAuthProfiles(agentId: string, store: Record<string, unknown>): Promise<void> {
  const agentDir = join(testHome, '.openclaw', 'agents', agentId, 'agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(getAgentAuthProfilesPath(agentId), JSON.stringify(store, null, 2), 'utf8');
}

async function fileMode(filePath: string): Promise<number> {
  return (await stat(filePath)).mode & 0o777;
}

function getAgentModelsPath(agentId: string): string {
  return join(testHome, '.openclaw', 'agents', agentId, 'agent', 'models.json');
}

async function writeAgentModelsJson(agentId: string, content: string): Promise<void> {
  const modelsPath = getAgentModelsPath(agentId);
  await mkdir(join(modelsPath, '..'), { recursive: true });
  await writeFile(modelsPath, content, 'utf8');
}

describe('saveProviderKeyToOpenClaw', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('only syncs auth profiles for configured agents', async () => {
    await writeOpenClawJson({
      agents: {
        list: [
          {
            id: 'main',
            name: 'Main',
            default: true,
            workspace: '~/.openclaw/workspace',
            agentDir: '~/.openclaw/agents/main/agent',
          },
          {
            id: 'test3',
            name: 'test3',
            workspace: '~/.openclaw/workspace-test3',
            agentDir: '~/.openclaw/agents/test3/agent',
          },
        ],
      },
    });

    await mkdir(join(testHome, '.openclaw', 'agents', 'test2', 'agent'), { recursive: true });
    await writeFile(
      join(testHome, '.openclaw', 'agents', 'test2', 'agent', 'auth-profiles.json'),
      JSON.stringify({
        version: 1,
        profiles: {
          'legacy:default': {
            type: 'api_key',
            provider: 'legacy',
            key: 'legacy-key',
          },
        },
      }, null, 2),
      'utf8',
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { saveProviderKeyToOpenClaw } = await import('@electron/utils/openclaw-auth');

    await saveProviderKeyToOpenClaw('openrouter', 'sk-test');

    const mainProfiles = await readAuthProfiles('main');
    const test3Profiles = await readAuthProfiles('test3');
    const staleProfiles = await readAuthProfiles('test2');

    expect((mainProfiles.profiles as Record<string, { key: string }>)['openrouter:default'].key).toBe('sk-test');
    expect((test3Profiles.profiles as Record<string, { key: string }>)['openrouter:default'].key).toBe('sk-test');
    expect(staleProfiles.profiles).toEqual({
      'legacy:default': {
        type: 'api_key',
        provider: 'legacy',
        key: 'legacy-key',
      },
    });
    expect(logSpy).toHaveBeenCalledWith(
      'Saved API key for provider "openrouter" to OpenClaw auth-profiles (agents: main, test3)',
    );

    logSpy.mockRestore();
  });
});

describe('managed auth profiles transaction', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('strictly replaces every OpenAI profile and restores the original OAuth stores', async () => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });
    const originalStore = {
      version: 1,
      profiles: {
        'openai:default': {
          type: 'oauth',
          provider: 'openai',
          access: 'original-access',
          refresh: 'original-refresh',
          expires: 123,
        },
        'personal-openai-oauth': {
          type: 'oauth',
          provider: 'openai',
          access: 'backup-access',
          refresh: 'backup-refresh',
          expires: 456,
        },
        'openai-codex:default': {
          type: 'oauth',
          provider: 'openai-codex',
          access: 'legacy-codex-access',
          refresh: 'legacy-codex-refresh',
          expires: 789,
        },
        'deepseek:default': {
          type: 'api_key',
          provider: 'deepseek',
          key: 'deepseek-key',
          metadata: { region: 'cn' },
        },
      },
      order: {
        openai: ['openai:default', 'personal-openai-oauth'],
        'openai-codex': ['openai-codex:default'],
        deepseek: ['deepseek:default'],
        routed: ['personal-openai-oauth', 'deepseek:default'],
      },
      lastGood: {
        openai: 'personal-openai-oauth',
        'openai-codex': 'openai-codex:default',
        deepseek: 'deepseek:default',
        routed: 'personal-openai-oauth',
      },
      usageStats: {
        'openai:default': { cooldownUntil: 99_999, errorCount: 1 },
        'personal-openai-oauth': { disabledUntil: 88_888, errorCount: 2 },
        'openai-codex:default': { cooldownUntil: 77_777, errorCount: 3 },
        'deepseek:default': { lastUsed: 7 },
      },
    };
    const originalJson = `${JSON.stringify(originalStore, null, 4)}\n`;
    const jsonPath = getAgentAuthProfilesPath('main');
    await mkdir(join(jsonPath, '..'), { recursive: true });
    await writeFile(jsonPath, originalJson);
    await chmod(jsonPath, 0o640);

    const {
      readAuthProfilesFromSqlite,
      snapshotAuthProfilesSqlitePrimaryRows,
      writeAuthProfilesToSqlite,
    } = await import('@electron/utils/openclaw-auth-sqlite');
    writeAuthProfilesToSqlite(originalStore, 'main');
    const originalSqliteRows = snapshotAuthProfilesSqlitePrimaryRows('main');
    const {
      installManagedAgentOpenAiApiKey,
      restoreManagedAgentAuthProfiles,
      snapshotManagedAgentAuthProfiles,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentAuthProfiles();

    await installManagedAgentOpenAiApiKey(snapshot, '  managed-openai-key  ');

    const installedJson = await readAuthProfiles('main');
    const installedProfiles = installedJson.profiles as Record<string, unknown>;
    expect(Object.keys(installedProfiles).sort()).toEqual(['deepseek:default', 'openai:default']);
    expect(installedProfiles['openai:default']).toEqual({
      type: 'api_key',
      provider: 'openai',
      key: 'managed-openai-key',
    });
    expect(installedProfiles['deepseek:default']).toEqual(originalStore.profiles['deepseek:default']);
    expect(installedJson.order).toEqual({
      openai: ['openai:default'],
      deepseek: ['deepseek:default'],
      routed: ['deepseek:default'],
    });
    expect(installedJson.lastGood).toEqual({
      openai: 'openai:default',
      deepseek: 'deepseek:default',
    });
    expect(installedJson.usageStats).toEqual({
      'deepseek:default': { lastUsed: 7 },
    });
    expect(readAuthProfilesFromSqlite('main')).toEqual(installedJson);

    await restoreManagedAgentAuthProfiles(snapshot);

    expect(await readFile(jsonPath, 'utf8')).toBe(originalJson);
    expect(await fileMode(jsonPath)).toBe(0o640);
    expect(snapshotAuthProfilesSqlitePrimaryRows('main')).toEqual(originalSqliteRows);
    expect(readAuthProfilesFromSqlite('main')?.profiles['openai:default']).toEqual(
      originalStore.profiles['openai:default'],
    );
    expect(readAuthProfilesFromSqlite('main')?.profiles['personal-openai-oauth']).toEqual(
      originalStore.profiles['personal-openai-oauth'],
    );
  });

  it('removes every dynamic managed relay profile from JSON and SQLite while preserving ordinary custom providers', async () => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });
    const jsonStore = {
      version: 1,
      profiles: {
        'relay-primary-with-arbitrary-id': {
          type: 'api_key',
          provider: 'legacy-uclaw-relay',
          key: 'legacy-json-key',
        },
        'ordinary-custom:default': {
          type: 'api_key',
          provider: 'ordinary-custom',
          key: 'ordinary-json-key',
        },
      },
      order: {
        'legacy-uclaw-relay': ['relay-primary-with-arbitrary-id'],
        routed: ['relay-primary-with-arbitrary-id', 'ordinary-custom:default'],
        'ordinary-custom': ['ordinary-custom:default'],
      },
      lastGood: {
        'legacy-uclaw-relay': 'relay-primary-with-arbitrary-id',
        routed: 'relay-primary-with-arbitrary-id',
        'ordinary-custom': 'ordinary-custom:default',
      },
      usageStats: {
        'relay-primary-with-arbitrary-id': { errorCount: 2 },
        'ordinary-custom:default': { lastUsed: 7 },
      },
    };
    const sqliteStore = {
      version: 1,
      profiles: {
        'sqlite-relay-profile': {
          type: 'api_key',
          provider: 'legacy-uclaw-relay',
          key: 'legacy-sqlite-key',
        },
        'sqlite-custom-profile': {
          type: 'api_key',
          provider: 'sqlite-custom',
          key: 'ordinary-sqlite-key',
        },
      },
      order: {
        'legacy-uclaw-relay': ['sqlite-relay-profile'],
        'sqlite-custom': ['sqlite-custom-profile'],
      },
      lastGood: {
        'legacy-uclaw-relay': 'sqlite-relay-profile',
        'sqlite-custom': 'sqlite-custom-profile',
      },
      usageStats: {
        'sqlite-relay-profile': { cooldownUntil: 88_888 },
        'sqlite-custom-profile': { lastUsed: 9 },
      },
    };
    await writeAgentAuthProfiles('main', jsonStore);
    const {
      readAuthProfilesFromSqlite,
      writeAuthProfilesToSqlite,
    } = await import('@electron/utils/openclaw-auth-sqlite');
    writeAuthProfilesToSqlite(sqliteStore, 'main');
    const { removeManagedAgentOpenAiCredentials } = await import('@electron/utils/openclaw-auth');

    await removeManagedAgentOpenAiCredentials(['legacy-uclaw-relay']);

    const cleanedJson = await readAuthProfiles('main');
    expect(cleanedJson.profiles).toEqual({
      'ordinary-custom:default': jsonStore.profiles['ordinary-custom:default'],
    });
    expect(cleanedJson.order).toEqual({
      routed: ['ordinary-custom:default'],
      'ordinary-custom': ['ordinary-custom:default'],
    });
    expect(cleanedJson.lastGood).toEqual({
      'ordinary-custom': 'ordinary-custom:default',
    });
    expect(cleanedJson.usageStats).toEqual({
      'ordinary-custom:default': { lastUsed: 7 },
    });

    const cleanedSqlite = readAuthProfilesFromSqlite('main');
    expect(cleanedSqlite?.profiles).toEqual({
      'sqlite-custom-profile': sqliteStore.profiles['sqlite-custom-profile'],
    });
    expect(cleanedSqlite?.order).toEqual({ 'sqlite-custom': ['sqlite-custom-profile'] });
    expect(cleanedSqlite?.lastGood).toEqual({ 'sqlite-custom': 'sqlite-custom-profile' });
    expect(cleanedSqlite?.usageStats).toEqual({
      'sqlite-custom-profile': { lastUsed: 9 },
    });
  });

  it('preserves each store own non-OpenAI profiles when JSON and SQLite differ', async () => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });
    await writeAgentAuthProfiles('main', {
      version: 1,
      profiles: {
        'deepseek:default': { type: 'api_key', provider: 'deepseek', key: 'json-deepseek-key' },
      },
      order: { deepseek: ['deepseek:default'] },
    });
    const {
      readAuthProfilesFromSqlite,
      writeAuthProfilesToSqlite,
    } = await import('@electron/utils/openclaw-auth-sqlite');
    writeAuthProfilesToSqlite({
      version: 1,
      profiles: {
        'moonshot:default': { type: 'api_key', provider: 'moonshot', key: 'sqlite-moonshot-key' },
      },
      order: { moonshot: ['moonshot:default'] },
    }, 'main');
    const {
      installManagedAgentOpenAiApiKey,
      snapshotManagedAgentAuthProfiles,
    } = await import('@electron/utils/openclaw-auth');

    const snapshot = await snapshotManagedAgentAuthProfiles();
    await installManagedAgentOpenAiApiKey(snapshot, 'managed-key');

    const jsonProfiles = (await readAuthProfiles('main')).profiles as Record<string, unknown>;
    const sqliteProfiles = readAuthProfilesFromSqlite('main')?.profiles ?? {};
    expect(Object.keys(jsonProfiles).sort()).toEqual(['deepseek:default', 'openai:default']);
    expect(jsonProfiles['moonshot:default']).toBeUndefined();
    expect(Object.keys(sqliteProfiles).sort()).toEqual(['moonshot:default', 'openai:default']);
    expect(sqliteProfiles['deepseek:default']).toBeUndefined();
  });

  it('seeds a missing SQLite store from JSON before replacing OpenAI', async () => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });
    await writeAgentAuthProfiles('main', {
      version: 1,
      profiles: {
        'deepseek:default': { type: 'api_key', provider: 'deepseek', key: 'json-deepseek-key' },
      },
    });
    const {
      getAuthProfilesSqlitePath,
      readAuthProfilesFromSqlite,
    } = await import('@electron/utils/openclaw-auth-sqlite');
    const {
      installManagedAgentOpenAiApiKey,
      snapshotManagedAgentAuthProfiles,
    } = await import('@electron/utils/openclaw-auth');

    await expect(readFile(getAuthProfilesSqlitePath('main'))).rejects.toMatchObject({ code: 'ENOENT' });
    const snapshot = await snapshotManagedAgentAuthProfiles();
    await installManagedAgentOpenAiApiKey(snapshot, 'managed-key');

    expect(Object.keys((await readAuthProfiles('main')).profiles as Record<string, unknown>).sort())
      .toEqual(['deepseek:default', 'openai:default']);
    expect(Object.keys(readAuthProfilesFromSqlite('main')?.profiles ?? {}).sort())
      .toEqual(['deepseek:default', 'openai:default']);
  });

  it('seeds a missing JSON store from SQLite before replacing OpenAI', async () => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });
    const {
      readAuthProfilesFromSqlite,
      writeAuthProfilesToSqlite,
    } = await import('@electron/utils/openclaw-auth-sqlite');
    writeAuthProfilesToSqlite({
      version: 1,
      profiles: {
        'moonshot:default': { type: 'api_key', provider: 'moonshot', key: 'sqlite-moonshot-key' },
      },
    }, 'main');
    const {
      installManagedAgentOpenAiApiKey,
      snapshotManagedAgentAuthProfiles,
    } = await import('@electron/utils/openclaw-auth');

    await expect(readFile(getAgentAuthProfilesPath('main'))).rejects.toMatchObject({ code: 'ENOENT' });
    const snapshot = await snapshotManagedAgentAuthProfiles();
    await installManagedAgentOpenAiApiKey(snapshot, 'managed-key');

    expect(Object.keys((await readAuthProfiles('main')).profiles as Record<string, unknown>).sort())
      .toEqual(['moonshot:default', 'openai:default']);
    expect(Object.keys(readAuthProfilesFromSqlite('main')?.profiles ?? {}).sort())
      .toEqual(['moonshot:default', 'openai:default']);
  });

  it('falls back to main when the frozen discovery result is empty', async () => {
    await mkdir(join(testHome, '.openclaw', 'agents'), { recursive: true });
    const agentConfig = await import('@electron/utils/agent-config');
    vi.spyOn(agentConfig, 'listConfiguredAgentIds').mockResolvedValue([]);
    const {
      installManagedAgentOpenAiApiKey,
      restoreManagedAgentAuthProfiles,
      snapshotManagedAgentAuthProfiles,
    } = await import('@electron/utils/openclaw-auth');

    const snapshot = await snapshotManagedAgentAuthProfiles();
    await installManagedAgentOpenAiApiKey(snapshot, 'managed-main-key');

    expect(snapshot).toEqual({});
    expect((await readAuthProfiles('main')).profiles).toEqual({
      'openai:default': {
        type: 'api_key',
        provider: 'openai',
        key: 'managed-main-key',
      },
    });

    await restoreManagedAgentAuthProfiles(snapshot);
    await expect(readFile(getAgentAuthProfilesPath('main'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a concurrent auth JSON change before writing any frozen agent', async () => {
    await writeOpenClawJson({
      agents: { list: [{ id: 'main', name: 'Main' }, { id: 'worker', name: 'Worker' }] },
    });
    await writeAgentAuthProfiles('main', {
      version: 1,
      profiles: { 'deepseek:default': { type: 'api_key', provider: 'deepseek', key: 'main-key' } },
    });
    await writeAgentAuthProfiles('worker', {
      version: 1,
      profiles: { 'deepseek:default': { type: 'api_key', provider: 'deepseek', key: 'worker-key' } },
    });
    const mainOriginal = await readFile(getAgentAuthProfilesPath('main'), 'utf8');
    const {
      getAuthProfilesSqlitePath,
    } = await import('@electron/utils/openclaw-auth-sqlite');
    const {
      installManagedAgentOpenAiApiKey,
      snapshotManagedAgentAuthProfiles,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentAuthProfiles();
    const concurrentWorker = JSON.stringify({
      version: 1,
      profiles: { 'moonshot:default': { type: 'api_key', provider: 'moonshot', key: 'concurrent-key' } },
    });
    await writeFile(getAgentAuthProfilesPath('worker'), concurrentWorker, 'utf8');

    await expect(installManagedAgentOpenAiApiKey(snapshot, 'managed-key')).rejects.toThrow('worker');

    expect(await readFile(getAgentAuthProfilesPath('main'), 'utf8')).toBe(mainOriginal);
    expect(await readFile(getAgentAuthProfilesPath('worker'), 'utf8')).toBe(concurrentWorker);
    await expect(readFile(getAuthProfilesSqlitePath('main'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(getAuthProfilesSqlitePath('worker'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a concurrently created auth JSON file when the snapshot target was missing', async () => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });
    const { getAuthProfilesSqlitePath } = await import('@electron/utils/openclaw-auth-sqlite');
    const {
      installManagedAgentOpenAiApiKey,
      snapshotManagedAgentAuthProfiles,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentAuthProfiles();
    const concurrentJson = JSON.stringify({
      version: 1,
      profiles: { 'deepseek:default': { type: 'api_key', provider: 'deepseek', key: 'concurrent-key' } },
    });
    const authPath = getAgentAuthProfilesPath('main');
    await mkdir(join(authPath, '..'), { recursive: true });
    await writeFile(authPath, concurrentJson, 'utf8');

    await expect(installManagedAgentOpenAiApiKey(snapshot, 'managed-key')).rejects.toThrow('main');

    expect(await readFile(authPath, 'utf8')).toBe(concurrentJson);
    await expect(readFile(getAuthProfilesSqlitePath('main'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to overwrite a concurrent auth JSON change during rollback', async () => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });
    await writeAgentAuthProfiles('main', {
      version: 1,
      profiles: { 'deepseek:default': { type: 'api_key', provider: 'deepseek', key: 'original-key' } },
    });
    const { getAuthProfilesSqlitePath } = await import('@electron/utils/openclaw-auth-sqlite');
    const {
      installManagedAgentOpenAiApiKey,
      restoreManagedAgentAuthProfiles,
      snapshotManagedAgentAuthProfiles,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentAuthProfiles();
    await installManagedAgentOpenAiApiKey(snapshot, 'managed-key');
    const concurrentJson = JSON.stringify({
      version: 1,
      profiles: { 'moonshot:default': { type: 'api_key', provider: 'moonshot', key: 'concurrent-key' } },
    });
    await writeFile(getAgentAuthProfilesPath('main'), concurrentJson, 'utf8');

    const error = await restoreManagedAgentAuthProfiles(snapshot).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AggregateError);
    expect(await readFile(getAgentAuthProfilesPath('main'), 'utf8')).toBe(concurrentJson);
    await expect(readFile(getAuthProfilesSqlitePath('main'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a concurrent auth JSON created after installing a missing target', async () => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });
    const { getAuthProfilesSqlitePath } = await import('@electron/utils/openclaw-auth-sqlite');
    const {
      installManagedAgentOpenAiApiKey,
      restoreManagedAgentAuthProfiles,
      snapshotManagedAgentAuthProfiles,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentAuthProfiles();
    await installManagedAgentOpenAiApiKey(snapshot, 'managed-key');
    const concurrentJson = JSON.stringify({
      version: 1,
      profiles: { 'deepseek:default': { type: 'api_key', provider: 'deepseek', key: 'concurrent-key' } },
    });
    await writeFile(getAgentAuthProfilesPath('main'), concurrentJson, 'utf8');

    const error = await restoreManagedAgentAuthProfiles(snapshot).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AggregateError);
    expect(await readFile(getAgentAuthProfilesPath('main'), 'utf8')).toBe(concurrentJson);
    await expect(readFile(getAuthProfilesSqlitePath('main'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['a missing profiles object', JSON.stringify({ version: 1, order: { openai: [] } })],
  ])('rejects %s before writing when SQLite has no usable store', async (_label, content) => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });
    const jsonPath = getAgentAuthProfilesPath('main');
    await mkdir(join(jsonPath, '..'), { recursive: true });
    await writeFile(jsonPath, content);
    const { getAuthProfilesSqlitePath } = await import('@electron/utils/openclaw-auth-sqlite');
    const { snapshotManagedAgentAuthProfiles } = await import('@electron/utils/openclaw-auth');

    await expect(snapshotManagedAgentAuthProfiles()).rejects.toThrow('Invalid auth-profiles.json');

    expect(await readFile(jsonPath, 'utf8')).toBe(content);
    await expect(readFile(getAuthProfilesSqlitePath('main'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects invalid JSON instead of replacing it from a valid SQLite store', async () => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });
    const jsonPath = getAgentAuthProfilesPath('main');
    await mkdir(join(jsonPath, '..'), { recursive: true });
    await writeFile(jsonPath, '{invalid-json', 'utf8');
    const { writeAuthProfilesToSqlite } = await import('@electron/utils/openclaw-auth-sqlite');
    writeAuthProfilesToSqlite({
      version: 1,
      profiles: {
        'deepseek:default': { type: 'api_key', provider: 'deepseek', key: 'sqlite-key' },
      },
    }, 'main');
    const { snapshotManagedAgentAuthProfiles } = await import('@electron/utils/openclaw-auth');

    await expect(snapshotManagedAgentAuthProfiles()).rejects.toThrow('Invalid auth-profiles.json');

    expect(await readFile(jsonPath, 'utf8')).toBe('{invalid-json');
  });

  it('rejects an invalid SQLite primary store row even when JSON is valid', async () => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });
    await writeAgentAuthProfiles('main', {
      version: 1,
      profiles: {
        'deepseek:default': { type: 'api_key', provider: 'deepseek', key: 'deepseek-key' },
      },
    });
    const {
      getAuthProfilesSqlitePath,
      writeAuthProfilesToSqlite,
    } = await import('@electron/utils/openclaw-auth-sqlite');
    writeAuthProfilesToSqlite({
      version: 1,
      profiles: {
        'deepseek:default': { type: 'api_key', provider: 'deepseek', key: 'deepseek-key' },
      },
    }, 'main');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(getAuthProfilesSqlitePath('main'));
    try {
      db.prepare('UPDATE auth_profile_store SET store_json = ? WHERE store_key = ?')
        .run('{invalid-sqlite-json', 'primary');
    } finally {
      db.close();
    }
    const { snapshotManagedAgentAuthProfiles } = await import('@electron/utils/openclaw-auth');

    await expect(snapshotManagedAgentAuthProfiles()).rejects.toThrow('Invalid SQLite auth profile store');
  });

  it('continues JSON and later-agent restoration after a SQLite failure', async () => {
    await writeOpenClawJson({
      agents: { list: [{ id: 'main', name: 'Main' }, { id: 'worker', name: 'Worker' }] },
    });
    const originalJson = new Map<string, string>();
    const sqliteSnapshots = new Map<string, unknown>();
    const {
      getAuthProfilesSqlitePath,
      snapshotAuthProfilesSqlitePrimaryRows,
      writeAuthProfilesToSqlite,
    } = await import('@electron/utils/openclaw-auth-sqlite');
    for (const agentId of ['main', 'worker']) {
      const store = {
        version: 1,
        profiles: {
          'openai:default': {
            type: 'oauth',
            provider: 'openai',
            access: `${agentId}-access`,
            refresh: `${agentId}-refresh`,
            expires: 123,
          },
        },
        order: { openai: ['openai:default'] },
        lastGood: { openai: 'openai:default' },
      };
      await writeAgentAuthProfiles(agentId, store);
      originalJson.set(agentId, await readFile(getAgentAuthProfilesPath(agentId), 'utf8'));
      writeAuthProfilesToSqlite(store, agentId);
      sqliteSnapshots.set(agentId, snapshotAuthProfilesSqlitePrimaryRows(agentId));
    }
    const {
      installManagedAgentOpenAiApiKey,
      restoreManagedAgentAuthProfiles,
      snapshotManagedAgentAuthProfiles,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentAuthProfiles();
    await installManagedAgentOpenAiApiKey(snapshot, 'managed-key');
    const mainSqlitePath = getAuthProfilesSqlitePath('main');
    await rm(mainSqlitePath);
    await mkdir(mainSqlitePath);

    const failure = await restoreManagedAgentAuthProfiles(snapshot).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(1);
    expect(await readFile(getAgentAuthProfilesPath('main'), 'utf8')).toBe(originalJson.get('main'));
    expect(await readFile(getAgentAuthProfilesPath('worker'), 'utf8')).toBe(originalJson.get('worker'));
    expect(snapshotAuthProfilesSqlitePrimaryRows('worker')).toEqual(sqliteSnapshots.get('worker'));
  });
});

describe('removeProviderKeyFromOpenClaw', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('removes only the default api-key profile for a provider', async () => {
    await writeAgentAuthProfiles('main', {
      version: 1,
      profiles: {
        'custom-abc12345:default': {
          type: 'api_key',
          provider: 'custom-abc12345',
          key: 'sk-main',
        },
        'custom-abc12345:backup': {
          type: 'api_key',
          provider: 'custom-abc12345',
          key: 'sk-backup',
        },
      },
      order: {
        'custom-abc12345': [
          'custom-abc12345:default',
          'custom-abc12345:backup',
        ],
      },
      lastGood: {
        'custom-abc12345': 'custom-abc12345:default',
      },
    });

    const { removeProviderKeyFromOpenClaw } = await import('@electron/utils/openclaw-auth');

    await removeProviderKeyFromOpenClaw('custom-abc12345', 'main');

    const mainProfiles = await readAuthProfiles('main');
    expect(mainProfiles.profiles).toEqual({
      'custom-abc12345:backup': {
        type: 'api_key',
        provider: 'custom-abc12345',
        key: 'sk-backup',
      },
    });
    expect(mainProfiles.order).toEqual({
      'custom-abc12345': ['custom-abc12345:backup'],
    });
    expect(mainProfiles.lastGood).toEqual({});
  });

  it('cleans stale default-profile references even when the profile object is already missing', async () => {
    await writeAgentAuthProfiles('main', {
      version: 1,
      profiles: {
        'custom-abc12345:backup': {
          type: 'api_key',
          provider: 'custom-abc12345',
          key: 'sk-backup',
        },
      },
      order: {
        'custom-abc12345': [
          'custom-abc12345:default',
          'custom-abc12345:backup',
        ],
      },
      lastGood: {
        'custom-abc12345': 'custom-abc12345:default',
      },
    });

    const { removeProviderKeyFromOpenClaw } = await import('@electron/utils/openclaw-auth');

    await removeProviderKeyFromOpenClaw('custom-abc12345', 'main');

    const mainProfiles = await readAuthProfiles('main');
    expect(mainProfiles.profiles).toEqual({
      'custom-abc12345:backup': {
        type: 'api_key',
        provider: 'custom-abc12345',
        key: 'sk-backup',
      },
    });
    expect(mainProfiles.order).toEqual({
      'custom-abc12345': ['custom-abc12345:backup'],
    });
    expect(mainProfiles.lastGood).toEqual({});
  });

  it('does not remove oauth default profiles when deleting only an api key', async () => {
    await writeAgentAuthProfiles('main', {
      version: 1,
      profiles: {
        'openai-codex:default': {
          type: 'oauth',
          provider: 'openai-codex',
          access: 'acc',
          refresh: 'ref',
          expires: 1,
        },
      },
      order: {
        'openai-codex': ['openai-codex:default'],
      },
      lastGood: {
        'openai-codex': 'openai-codex:default',
      },
    });

    const { removeProviderKeyFromOpenClaw } = await import('@electron/utils/openclaw-auth');

    await removeProviderKeyFromOpenClaw('openai-codex', 'main');

    const mainProfiles = await readAuthProfiles('main');
    expect(mainProfiles.profiles).toEqual({
      'openai-codex:default': {
        type: 'oauth',
        provider: 'openai-codex',
        access: 'acc',
        refresh: 'ref',
        expires: 1,
      },
    });
    expect(mainProfiles.order).toEqual({
      'openai-codex': ['openai-codex:default'],
    });
    expect(mainProfiles.lastGood).toEqual({
      'openai-codex': 'openai-codex:default',
    });
  });

  it('removes api-key defaults for oauth-capable providers that support api keys', async () => {
    await writeAgentAuthProfiles('main', {
      version: 1,
      profiles: {
        'minimax-portal:default': {
          type: 'api_key',
          provider: 'minimax-portal',
          key: 'sk-minimax',
        },
        'minimax-portal:oauth-backup': {
          type: 'oauth',
          provider: 'minimax-portal',
          access: 'acc',
          refresh: 'ref',
          expires: 1,
        },
      },
      order: {
        'minimax-portal': [
          'minimax-portal:default',
          'minimax-portal:oauth-backup',
        ],
      },
      lastGood: {
        'minimax-portal': 'minimax-portal:default',
      },
    });

    const { removeProviderKeyFromOpenClaw } = await import('@electron/utils/openclaw-auth');

    await removeProviderKeyFromOpenClaw('minimax-portal', 'main');

    const mainProfiles = await readAuthProfiles('main');
    expect(mainProfiles.profiles).toEqual({
      'minimax-portal:oauth-backup': {
        type: 'oauth',
        provider: 'minimax-portal',
        access: 'acc',
        refresh: 'ref',
        expires: 1,
      },
    });
    expect(mainProfiles.order).toEqual({
      'minimax-portal': ['minimax-portal:oauth-backup'],
    });
    expect(mainProfiles.lastGood).toEqual({});
  });
});

describe('sanitizeOpenClawConfig', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('skips sanitization when openclaw.json does not exist', async () => {
    // Ensure the .openclaw dir doesn't exist at all
    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Should not throw and should not create the file
    await expect(sanitizeOpenClawConfig()).resolves.toBeUndefined();

    const configPath = join(testHome, '.openclaw', 'openclaw.json');
    await expect(readFile(configPath, 'utf8')).rejects.toThrow();

    logSpy.mockRestore();
  });

  it('skips sanitization when openclaw.json contains invalid JSON', async () => {
    // Simulate a corrupted file: readJsonFile returns null, sanitize must bail out
    const openclawDir = join(testHome, '.openclaw');
    await mkdir(openclawDir, { recursive: true });
    const configPath = join(openclawDir, 'openclaw.json');
    await writeFile(configPath, 'NOT VALID JSON {{{', 'utf8');
    const before = await readFile(configPath, 'utf8');

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sanitizeOpenClawConfig();

    const after = await readFile(configPath, 'utf8');
    // Corrupt file must not be overwritten
    expect(after).toBe(before);

    logSpy.mockRestore();
  });

  it('properly sanitizes a genuinely empty {} config (fresh install)', async () => {
    // A fresh install with {} is a valid config — sanitize should proceed
    // and enforce tools.profile, commands.restart, etc.
    await writeOpenClawJson({});

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sanitizeOpenClawConfig();

    const configPath = join(testHome, '.openclaw', 'openclaw.json');
    const result = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    // Fresh install should get tools settings enforced
    const tools = result.tools as Record<string, unknown>;
    expect(tools.profile).toBe('full');
    expect(tools.deny).toEqual(['skill_workshop']);
    const gateway = result.gateway as Record<string, unknown>;
    const gatewayTools = gateway.tools as Record<string, unknown>;
    expect(gatewayTools.deny).toEqual(['skill_workshop']);
    const skills = result.skills as Record<string, unknown>;
    const workshop = skills.workshop as Record<string, unknown>;
    const autonomous = workshop.autonomous as Record<string, unknown>;
    expect(autonomous.enabled).toBe(false);
    const entries = skills.entries as Record<string, Record<string, unknown>>;
    expect(entries['skill-creator'].enabled).toBe(true);

    logSpy.mockRestore();
  });

  it('preserves user config (memory, agents, channels) when enforcing tools settings', async () => {
    await writeOpenClawJson({
      agents: { defaults: { model: { primary: 'openai/gpt-4' } } },
      channels: { discord: { token: 'tok', enabled: true } },
      memory: { enabled: true, limit: 100 },
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sanitizeOpenClawConfig();

    const configPath = join(testHome, '.openclaw', 'openclaw.json');
    const result = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;

    // User-owned sections must survive the sanitize pass
    expect(result.memory).toEqual({ enabled: true, limit: 100 });
    expect(result.channels).toEqual({ discord: { token: 'tok', enabled: true } });
    expect((result.agents as Record<string, unknown>).defaults).toEqual({
      model: { primary: 'openai/gpt-4' },
    });
    // tools settings should now be enforced
    const tools = result.tools as Record<string, unknown>;
    expect(tools.profile).toBe('full');
    expect(tools.deny).toEqual(['skill_workshop']);
    const gateway = result.gateway as Record<string, unknown>;
    expect((gateway.tools as Record<string, unknown>).deny).toEqual(['skill_workshop']);
    const skills = result.skills as Record<string, unknown>;
    expect(((skills.workshop as Record<string, unknown>).autonomous as Record<string, unknown>).enabled).toBe(false);
    expect((skills.entries as Record<string, Record<string, unknown>>)['skill-creator'].enabled).toBe(true);

    logSpy.mockRestore();
  });

  it('preserves existing denied tools while adding skill_workshop to the deny list', async () => {
    await writeOpenClawJson({
      tools: {
        deny: ['browser'],
      },
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const result = await readOpenClawJson();
    const tools = result.tools as Record<string, unknown>;
    expect(tools.deny).toEqual(['browser', 'skill_workshop']);
    const gateway = result.gateway as Record<string, unknown>;
    expect((gateway.tools as Record<string, unknown>).deny).toEqual(['skill_workshop']);
  });

  it('migrates legacy tools.web.search.kimi into moonshot plugin config', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          moonshot: { baseUrl: 'https://api.moonshot.cn/v1', api: 'openai-completions' },
        },
      },
      tools: {
        web: {
          search: {
            kimi: {
              apiKey: 'stale-inline-key',
              baseUrl: 'https://api.moonshot.cn/v1',
            },
          },
        },
      },
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const result = await readOpenClawJson();
    const tools = (result.tools as Record<string, unknown> | undefined) || {};
    const web = (tools.web as Record<string, unknown> | undefined) || {};
    const search = (web.search as Record<string, unknown> | undefined) || {};
    const moonshot = ((((result.plugins as Record<string, unknown>).entries as Record<string, unknown>).moonshot as Record<string, unknown>).config as Record<string, unknown>).webSearch as Record<string, unknown>;

    expect(search).not.toHaveProperty('kimi');
    expect(moonshot).not.toHaveProperty('apiKey');
    expect(moonshot.baseUrl).toBe('https://api.moonshot.cn/v1');
  });

  it('mirrors telegram default account credentials to top level during sanitize', async () => {
    await writeOpenClawJson({
      channels: {
        telegram: {
          enabled: true,
          defaultAccount: 'default',
          accounts: {
            default: {
              botToken: 'telegram-token',
              enabled: true,
            },
          },
          proxy: 'socks5://127.0.0.1:7891',
        },
      },
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const result = await readOpenClawJson();
    const channels = result.channels as Record<string, Record<string, unknown>>;
    const telegram = channels.telegram;
    // telegram is NOT in the exclude set, so credentials are mirrored to top level
    expect(telegram.proxy).toBe('socks5://127.0.0.1:7891');
    expect(telegram.botToken).toBe('telegram-token');
  });

  it('normalizes legacy feishu plugin state to a single external plugin and removes built-in feishu', async () => {
    await writeOpenClawJson({
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli-feishu-app',
          appSecret: 'cli-feishu-secret',
        },
      },
      plugins: {
        enabled: true,
        allow: ['custom-plugin', 'feishu', 'openclaw-lark'],
        entries: {
          'custom-plugin': { enabled: true },
          feishu: { enabled: true },
          'openclaw-lark': { enabled: true, config: { preserved: true } },
        },
      },
    });

    const legacyPluginDir = join(testHome, '.openclaw', 'extensions', 'openclaw-lark');
    await mkdir(legacyPluginDir, { recursive: true });
    await writeFile(
      join(legacyPluginDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'openclaw-lark' }, null, 2),
      'utf8',
    );

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const result = await readOpenClawJson();
    const plugins = result.plugins as Record<string, unknown>;
    const allow = plugins.allow as string[];
    const entries = plugins.entries as Record<string, Record<string, unknown>>;

    expect(allow).toContain('openclaw-lark');
    expect(allow).not.toContain('feishu');
    expect(entries['openclaw-lark']).toEqual({
      enabled: true,
      config: { preserved: true },
    });
    expect(entries.feishu).toBeUndefined();
  });

  it('removes residual feishu plugin registrations when feishu channel is not configured', async () => {
    await writeOpenClawJson({
      channels: {
        telegram: {
          enabled: true,
          botToken: 'telegram-token',
        },
      },
      plugins: {
        enabled: true,
        allow: ['custom-plugin', 'feishu', 'openclaw-lark'],
        entries: {
          'custom-plugin': { enabled: true },
          feishu: { enabled: false },
          'openclaw-lark': { enabled: true },
        },
      },
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const result = await readOpenClawJson();
    const plugins = result.plugins as Record<string, unknown>;
    const allow = plugins.allow as string[];
    const entries = plugins.entries as Record<string, Record<string, unknown>>;

    expect(allow).toContain('custom-plugin');
    expect(allow).not.toContain('feishu');
    expect(allow).not.toContain('openclaw-lark');
    expect(entries['custom-plugin']).toEqual({ enabled: true });
    expect(entries.feishu).toBeUndefined();
    expect(entries['openclaw-lark']).toBeUndefined();
  });

  it('strips defaultAccount (but preserves accounts) from dingtalk during sanitize', async () => {
    await writeOpenClawJson({
      channels: {
        dingtalk: {
          enabled: true,
          defaultAccount: 'default',
          accounts: {
            default: {
              clientId: 'dt-client-id-nested',
              clientSecret: 'dt-secret-nested',
              enabled: true,
            },
          },
          clientId: 'dt-client-id',
          clientSecret: 'dt-secret',
        },
      },
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const result = await readOpenClawJson();
    const channels = result.channels as Record<string, Record<string, unknown>>;
    const dingtalk = channels.dingtalk;
    // dingtalk's schema accepts `accounts` but NOT `defaultAccount`
    expect(dingtalk.enabled).toBe(true);
    expect(dingtalk.accounts).toEqual({
      default: {
        clientId: 'dt-client-id-nested',
        clientSecret: 'dt-secret-nested',
        enabled: true,
      },
    });
    expect(dingtalk.defaultAccount).toBeUndefined();
    // Top-level credentials preserved (were already there + mirrored)
    expect(dingtalk.clientId).toBe('dt-client-id');
    expect(dingtalk.clientSecret).toBe('dt-secret');
  });

  it('removes stale minimax-portal-auth plugin entries when merged minimax plugin is installed', async () => {
    await writeOpenClawJson({
      plugins: {
        allow: ['minimax-portal-auth', 'custom-plugin'],
        entries: {
          'minimax-portal-auth': { enabled: true },
          'custom-plugin': { enabled: true },
        },
      },
      models: {
        providers: {
          'minimax-portal': {
            baseUrl: 'https://api.minimax.io/anthropic',
            api: 'anthropic-messages',
          },
        },
      },
    });

    const openclawDir = join(testHome, '.openclaw-package-sanitize');
    await mkdir(join(openclawDir, 'dist', 'extensions', 'minimax'), { recursive: true });
    await writeFile(
      join(openclawDir, 'dist', 'extensions', 'minimax', 'openclaw.plugin.json'),
      JSON.stringify({
        id: 'minimax',
        providers: ['minimax', 'minimax-portal'],
        legacyPluginIds: ['minimax-portal-auth'],
      }, null, 2),
      'utf8',
    );

    vi.doMock('@electron/utils/paths', async () => {
      const actual = await vi.importActual<typeof import('@electron/utils/paths')>('@electron/utils/paths');
      return {
        ...actual,
        getOpenClawResolvedDir: () => openclawDir,
      };
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const result = await readOpenClawJson();
    const plugins = result.plugins as Record<string, unknown>;
    const allow = plugins.allow as string[];
    const entries = plugins.entries as Record<string, Record<string, unknown>>;

    expect(allow).toEqual(['custom-plugin']);
    expect(entries['minimax-portal-auth']).toBeUndefined();
    expect(entries['custom-plugin']).toEqual({ enabled: true });
  });

  it('removes stale bundled OpenClaw dist extension paths from plugins.load.paths', async () => {
    const staleAcpxPath = join(
      testHome,
      'old-workspace',
      'node_modules',
      '.pnpm',
      'openclaw@2026.4.11_hash',
      'node_modules',
      'openclaw',
      'dist',
      'extensions',
      'acpx',
    );
    await mkdir(staleAcpxPath, { recursive: true });
    await writeOpenClawJson({
      plugins: {
        load: {
          paths: [staleAcpxPath],
        },
        entries: {
          acpx: {
            enabled: true,
          },
        },
      },
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const result = await readOpenClawJson();
    const plugins = result.plugins as Record<string, unknown>;
    expect(plugins.load).toBeUndefined();
    expect((plugins.entries as Record<string, unknown>).acpx).toEqual({ enabled: true });
  });

  it('removes missing external plugin ids from plugins.allow while preserving installed and configured plugins', async () => {
    const installedPluginDir = join(testHome, '.openclaw', 'extensions', 'custom-installed');
    await mkdir(installedPluginDir, { recursive: true });
    await writeFile(
      join(installedPluginDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'custom-installed' }, null, 2),
      'utf8',
    );
    await writeOpenClawJson({
      plugins: {
        allow: ['custom-installed', 'configured-plugin', 'missing-plugin'],
        entries: {
          'configured-plugin': { enabled: true },
        },
      },
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const result = await readOpenClawJson();
    const plugins = result.plugins as Record<string, unknown>;
    const allow = plugins.allow as string[];

    expect(allow).toEqual(['custom-installed', 'configured-plugin']);
    expect((plugins.entries as Record<string, unknown>)['configured-plugin']).toEqual({ enabled: true });
  });

  it('preserves allowlisted plugins loaded from local plugin paths', async () => {
    const loadedPluginDir = join(testHome, 'local-plugins', 'custom-loaded');
    await mkdir(loadedPluginDir, { recursive: true });
    await writeFile(
      join(loadedPluginDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'custom-loaded' }, null, 2),
      'utf8',
    );
    await writeOpenClawJson({
      plugins: {
        allow: ['custom-loaded', 'missing-plugin'],
        load: {
          paths: [loadedPluginDir],
        },
      },
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const result = await readOpenClawJson();
    const plugins = result.plugins as Record<string, unknown>;
    const allow = plugins.allow as string[];
    const load = plugins.load as Record<string, unknown>;

    expect(allow).toEqual(['custom-loaded']);
    expect(load.paths).toEqual([loadedPluginDir]);
  });

  it('limits enabled-by-default provider plugins in plugins.allow to active providers', async () => {
    const openclawDir = join(testHome, '.openclaw-package-allowlist');
    const extensionsRoot = join(openclawDir, 'dist', 'extensions');
    for (const manifest of [
      { dir: 'browser', id: 'browser', enabledByDefault: true },
      { dir: 'groq', id: 'groq', enabledByDefault: true },
      { dir: 'alibaba', id: 'alibaba', enabledByDefault: true },
      { dir: 'memory-core', id: 'memory-core' },
      { dir: 'openrouter', id: 'openrouter', enabledByDefault: true, providers: ['openrouter'] },
      { dir: 'anthropic', id: 'anthropic', enabledByDefault: true, providers: ['anthropic'] },
    ]) {
      const pluginDir = join(extensionsRoot, manifest.dir);
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, 'openclaw.plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
    }
    await writeOpenClawJson({
      plugins: {
        allow: ['custom-plugin', 'browser', 'openrouter', 'anthropic'],
        entries: {
          'custom-plugin': { enabled: true },
          'memory-core': { config: { dreaming: { enabled: true } } },
        },
      },
      models: {
        providers: {
          alibaba: {},
          openrouter: {},
        },
      },
    });

    vi.doMock('@electron/utils/paths', async () => {
      const actual = await vi.importActual<typeof import('@electron/utils/paths')>('@electron/utils/paths');
      return {
        ...actual,
        getOpenClawResolvedDir: () => openclawDir,
        getOpenClawDir: () => openclawDir,
      };
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const result = await readOpenClawJson();
    const plugins = result.plugins as Record<string, unknown>;
    const allow = plugins.allow as string[];

    expect(allow).toContain('custom-plugin');
    expect(allow).toContain('browser');
    expect(allow).toContain('memory-core');
    expect(allow).toContain('alibaba');
    expect(allow).not.toContain('groq');
    expect(allow).toContain('openrouter');
    expect(allow).not.toContain('anthropic');
  });

  it('preserves active bundled provider plugins discovered from per-agent auth profile stores', async () => {
    await writeOpenClawJson({
      agents: {
        list: [
          {
            id: 'work',
            name: 'Work',
            workspace: '~/.openclaw/workspace-work',
            agentDir: '~/.openclaw/agents/work/agent',
          },
        ],
      },
      plugins: {
        allow: ['custom-plugin'],
        entries: {
          'custom-plugin': { enabled: true },
        },
      },
    });

    await writeAgentAuthProfiles('work', {
      version: 1,
      profiles: {
        'openai-codex:default': {
          type: 'oauth',
          provider: 'openai-codex',
          access: 'acc',
          refresh: 'ref',
          expires: 1,
        },
      },
    });

    const openclawDir = join(testHome, '.openclaw-package-sanitize-providers');
    await mkdir(join(openclawDir, 'dist', 'extensions', 'openai'), { recursive: true });
    await writeFile(
      join(openclawDir, 'dist', 'extensions', 'openai', 'openclaw.plugin.json'),
      JSON.stringify({
        id: 'openai',
        enabledByDefault: true,
        providers: ['openai', 'openai-codex'],
      }, null, 2),
      'utf8',
    );

    vi.doMock('@electron/utils/paths', async () => {
      const actual = await vi.importActual<typeof import('@electron/utils/paths')>('@electron/utils/paths');
      return {
        ...actual,
        getOpenClawResolvedDir: () => openclawDir,
      };
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const result = await readOpenClawJson();
    const plugins = result.plugins as Record<string, unknown>;
    const allow = plugins.allow as string[];

    expect(allow).toContain('custom-plugin');
    expect(allow).toContain('openai');
  });
});

describe('syncProviderConfigToOpenClaw', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('preserves existing custom-provider model metadata during provider sync', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          'custom-example': {
            baseUrl: 'https://example.com/v1',
            api: 'openai-completions',
            models: [
              {
                id: 'model-a',
                name: 'Model A',
                input: ['text', 'image'],
                reasoning: true,
                contextWindow: 200000,
                customField: 'keep-me',
              },
            ],
          },
        },
      },
    });

    const { syncProviderConfigToOpenClaw } = await import('@electron/utils/openclaw-auth');
    await syncProviderConfigToOpenClaw('custom-example', 'model-a', {
      baseUrl: 'https://example.com/v1',
      api: 'openai-completions',
    });

    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    const entry = providers['custom-example'] as Record<string, unknown>;
    const models = entry.models as Array<Record<string, unknown>>;

    expect(models).toEqual([
      expect.objectContaining({
        id: 'model-a',
        name: 'Model A',
        input: ['text', 'image'],
        reasoning: true,
        contextWindow: 200000,
        customField: 'keep-me',
      }),
    ]);
  });

  it('infers text-only input for a new unknown custom-provider model', async () => {
    await writeOpenClawJson({ models: { providers: {} } });

    const { syncProviderConfigToOpenClaw } = await import('@electron/utils/openclaw-auth');
    await syncProviderConfigToOpenClaw('custom-example', 'private-model-x', {
      baseUrl: 'https://example.com/v1',
      api: 'openai-completions',
    });

    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    const entry = providers['custom-example'] as Record<string, unknown>;
    const models = entry.models as Array<Record<string, unknown>>;

    expect(models).toEqual([
      expect.objectContaining({
        id: 'private-model-x',
        input: ['text'],
      }),
    ]);
  });

  it('writes an inferred contextWindow for new custom-provider model rows', async () => {
    await writeOpenClawJson({ models: { providers: {} } });

    const { syncProviderConfigToOpenClaw } = await import('@electron/utils/openclaw-auth');
    await syncProviderConfigToOpenClaw('custom-example', 'gpt-5.5', {
      baseUrl: 'https://example.com/v1',
      api: 'openai-completions',
    });

    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    const entry = providers['custom-example'] as Record<string, unknown>;
    const models = entry.models as Array<Record<string, unknown>>;

    expect(models).toEqual([
      expect.objectContaining({
        id: 'gpt-5.5',
        contextWindow: 272000,
      }),
    ]);
  });

  it('does not overwrite an existing contextWindow on re-sync', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          'custom-example': {
            baseUrl: 'https://example.com/v1',
            api: 'openai-completions',
            models: [
              { id: 'gpt-5.5', name: 'gpt-5.5', input: ['text'], contextWindow: 64000 },
            ],
          },
        },
      },
    });

    const { syncProviderConfigToOpenClaw } = await import('@electron/utils/openclaw-auth');
    await syncProviderConfigToOpenClaw('custom-example', 'gpt-5.5', {
      baseUrl: 'https://example.com/v1',
      api: 'openai-completions',
    });

    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    const entry = providers['custom-example'] as Record<string, unknown>;
    const models = entry.models as Array<Record<string, unknown>>;

    expect(models).toEqual([
      expect.objectContaining({ id: 'gpt-5.5', contextWindow: 64000 }),
    ]);
  });

  it('uses legacy minimax-portal-auth plugin registration when only the legacy plugin exists', async () => {
    await writeOpenClawJson({
      models: { providers: {} },
    });

    const openclawDir = join(testHome, '.openclaw-package-old');
    await mkdir(join(openclawDir, 'extensions', 'minimax-portal-auth'), { recursive: true });
    await writeFile(
      join(openclawDir, 'extensions', 'minimax-portal-auth', 'openclaw.plugin.json'),
      JSON.stringify({
        id: 'minimax-portal-auth',
        providers: ['minimax-portal'],
      }, null, 2),
      'utf8',
    );

    vi.doMock('@electron/utils/paths', async () => {
      const actual = await vi.importActual<typeof import('@electron/utils/paths')>('@electron/utils/paths');
      return {
        ...actual,
        getOpenClawResolvedDir: () => openclawDir,
      };
    });

    const { syncProviderConfigToOpenClaw } = await import('@electron/utils/openclaw-auth');

    await syncProviderConfigToOpenClaw('minimax-portal', 'MiniMax-M2.7', {
      baseUrl: 'https://api.minimax.io/anthropic',
      api: 'anthropic-messages',
      apiKeyEnv: 'minimax-oauth',
    });

    const result = await readOpenClawJson();
    const plugins = result.plugins as Record<string, unknown>;
    const allow = plugins.allow as string[];
    const entries = plugins.entries as Record<string, Record<string, unknown>>;

    expect(allow).toContain('minimax-portal-auth');
    expect(entries['minimax-portal-auth']).toEqual({ enabled: true });
    expect(entries.minimax).toBeUndefined();
  });

  it('uses merged minimax plugin registration and removes stale legacy ids when minimax plugin is installed', async () => {
    await writeOpenClawJson({
      plugins: {
        allow: ['minimax-portal-auth', 'custom-plugin'],
        entries: {
          'minimax-portal-auth': { enabled: true },
          'custom-plugin': { enabled: true },
        },
      },
      models: { providers: {} },
    });

    const openclawDir = join(testHome, '.openclaw-package-new');
    await mkdir(join(openclawDir, 'dist', 'extensions', 'minimax'), { recursive: true });
    await writeFile(
      join(openclawDir, 'dist', 'extensions', 'minimax', 'openclaw.plugin.json'),
      JSON.stringify({
        id: 'minimax',
        providers: ['minimax', 'minimax-portal'],
        legacyPluginIds: ['minimax-portal-auth'],
      }, null, 2),
      'utf8',
    );

    vi.doMock('@electron/utils/paths', async () => {
      const actual = await vi.importActual<typeof import('@electron/utils/paths')>('@electron/utils/paths');
      return {
        ...actual,
        getOpenClawResolvedDir: () => openclawDir,
      };
    });

    const { syncProviderConfigToOpenClaw } = await import('@electron/utils/openclaw-auth');

    await syncProviderConfigToOpenClaw('minimax-portal', 'MiniMax-M2.7', {
      baseUrl: 'https://api.minimax.io/anthropic',
      api: 'anthropic-messages',
      apiKeyEnv: 'minimax-oauth',
    });

    const result = await readOpenClawJson();
    const plugins = result.plugins as Record<string, unknown>;
    const allow = plugins.allow as string[];
    const entries = plugins.entries as Record<string, Record<string, unknown>>;

    expect(allow).toContain('minimax');
    expect(allow).toContain('custom-plugin');
    expect(allow).not.toContain('minimax-portal-auth');
    expect(entries.minimax).toEqual({ enabled: true });
    expect(entries['minimax-portal-auth']).toBeUndefined();
  });

  it('writes moonshot web search config to plugin config instead of tools.web.search.kimi', async () => {
    await writeOpenClawJson({
      models: {
        providers: {},
      },
    });

    const { syncProviderConfigToOpenClaw } = await import('@electron/utils/openclaw-auth');

    await syncProviderConfigToOpenClaw('moonshot', 'kimi-k2.6', {
      baseUrl: 'https://api.moonshot.cn/v1',
      api: 'openai-completions',
    });

    const result = await readOpenClawJson();
    const tools = (result.tools as Record<string, unknown> | undefined) || {};
    const web = (tools.web as Record<string, unknown> | undefined) || {};
    const search = (web.search as Record<string, unknown> | undefined) || {};
    const moonshot = ((((result.plugins as Record<string, unknown>).entries as Record<string, unknown>).moonshot as Record<string, unknown>).config as Record<string, unknown>).webSearch as Record<string, unknown>;

    expect(search).not.toHaveProperty('kimi');
    expect(moonshot.baseUrl).toBe('https://api.moonshot.cn/v1');
  });

  it('preserves legacy plugins array by converting it into plugins.load during moonshot sync', async () => {
    await writeOpenClawJson({
      plugins: ['/tmp/custom-plugin.js'],
      models: {
        providers: {},
      },
    });

    const { syncProviderConfigToOpenClaw } = await import('@electron/utils/openclaw-auth');

    await syncProviderConfigToOpenClaw('moonshot', 'kimi-k2.6', {
      baseUrl: 'https://api.moonshot.cn/v1',
      api: 'openai-completions',
    });

    const result = await readOpenClawJson();
    const plugins = result.plugins as Record<string, unknown>;
    const load = plugins.load as string[];
    const moonshot = (((plugins.entries as Record<string, unknown>).moonshot as Record<string, unknown>).config as Record<string, unknown>).webSearch as Record<string, unknown>;

    expect(load).toEqual(['/tmp/custom-plugin.js']);
    expect(moonshot.baseUrl).toBe('https://api.moonshot.cn/v1');
  });
});

describe('setOpenClawDefaultModelWithOverride model metadata', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('preserves old rows and infers image input for a newly selected vision model', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          'custom-example': {
            baseUrl: 'https://example.com/v1',
            api: 'openai-completions',
            models: [
              {
                id: 'model-a',
                name: 'Model A',
                input: ['text', 'image'],
                customField: 'keep-me',
              },
            ],
          },
        },
      },
    });

    const { setOpenClawDefaultModelWithOverride } = await import('@electron/utils/openclaw-auth');
    await setOpenClawDefaultModelWithOverride(
      'custom-example',
      'custom-example/claude-opus-4-6',
      {
        baseUrl: 'https://example.com/v1',
        api: 'openai-completions',
      },
    );

    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    const entry = providers['custom-example'] as Record<string, unknown>;
    const models = entry.models as Array<Record<string, unknown>>;
    const oldModel = models.find((model) => model.id === 'model-a');
    const newModel = models.find((model) => model.id === 'claude-opus-4-6');

    expect(oldModel).toEqual(expect.objectContaining({
      input: ['text', 'image'],
      customField: 'keep-me',
    }));
    expect(newModel).toEqual(expect.objectContaining({
      input: ['text', 'image'],
    }));
    expect(newModel).not.toHaveProperty('customField');
  });

  it('preserves model input metadata after switching to another provider and back', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          'custom-a': {
            baseUrl: 'https://a.example.com/v1',
            api: 'openai-completions',
            models: [
              {
                id: 'model-a',
                name: 'Model A',
                input: ['text', 'image'],
              },
            ],
          },
          'custom-b': {
            baseUrl: 'https://b.example.com/v1',
            api: 'openai-completions',
            models: [
              {
                id: 'model-b',
                name: 'Model B',
                input: ['text'],
              },
            ],
          },
        },
      },
    });

    const { setOpenClawDefaultModelWithOverride } = await import('@electron/utils/openclaw-auth');
    await setOpenClawDefaultModelWithOverride('custom-b', 'custom-b/model-b', {
      baseUrl: 'https://b.example.com/v1',
      api: 'openai-completions',
    });
    await setOpenClawDefaultModelWithOverride('custom-a', 'custom-a/model-a', {
      baseUrl: 'https://a.example.com/v1',
      api: 'openai-completions',
    });

    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    const providerA = providers['custom-a'] as Record<string, unknown>;
    const models = providerA.models as Array<Record<string, unknown>>;

    expect(models.find((model) => model.id === 'model-a')).toEqual(expect.objectContaining({
      input: ['text', 'image'],
    }));
  });
});

describe('auth-backed provider discovery', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('detects active providers from openclaw auth profiles and per-agent auth stores', async () => {
    await writeOpenClawJson({
      agents: {
        list: [
          { id: 'main', name: 'Main', default: true, workspace: '~/.openclaw/workspace', agentDir: '~/.openclaw/agents/main/agent' },
          { id: 'work', name: 'Work', workspace: '~/.openclaw/workspace-work', agentDir: '~/.openclaw/agents/work/agent' },
        ],
      },
      auth: {
        profiles: {
          'openai-codex:default': { type: 'oauth', provider: 'openai-codex', access: 'acc', refresh: 'ref', expires: 1 },
          'anthropic:default': { type: 'api_key', provider: 'anthropic', key: 'sk-ant' },
        },
      },
    });

    await writeAgentAuthProfiles('work', {
      version: 1,
      profiles: {
        'google-gemini-cli:default': {
          type: 'oauth',
          provider: 'google-gemini-cli',
          access: 'goog-access',
          refresh: 'goog-refresh',
          expires: 2,
        },
      },
    });

    const { getActiveOpenClawProviders } = await import('@electron/utils/openclaw-auth');

    // Raw runtime keys (openai-codex / google-gemini-cli) are kept alongside
    // their normalized UI aliases: newer OpenClaw versions no longer write
    // explicit models.providers / plugins entries for OAuth CLI providers, so
    // the auth profile is the only signal that the runtime provider is active.
    await expect(getActiveOpenClawProviders()).resolves.toEqual(
      new Set(['openai', 'openai-codex', 'anthropic', 'google', 'google-gemini-cli']),
    );
  });

  it('seeds provider config entries from auth profiles when models.providers is empty', async () => {
    await writeOpenClawJson({
      agents: {
        list: [
          { id: 'main', name: 'Main', default: true, workspace: '~/.openclaw/workspace', agentDir: '~/.openclaw/agents/main/agent' },
          { id: 'work', name: 'Work', workspace: '~/.openclaw/workspace-work', agentDir: '~/.openclaw/agents/work/agent' },
        ],
        defaults: {
          model: {
            primary: 'openai/gpt-5.5',
          },
        },
      },
      auth: {
        profiles: {
          'openai-codex:default': { type: 'oauth', provider: 'openai-codex', access: 'acc', refresh: 'ref', expires: 1 },
        },
      },
    });

    await writeAgentAuthProfiles('work', {
      version: 1,
      profiles: {
        'anthropic:default': {
          type: 'api_key',
          provider: 'anthropic',
          key: 'sk-ant',
        },
      },
    });

    const { getOpenClawProvidersConfig } = await import('@electron/utils/openclaw-auth');
    const result = await getOpenClawProvidersConfig();

    expect(result.defaultModel).toBe('openai/gpt-5.5');
    expect(result.providers).toMatchObject({
      openai: {},
      anthropic: {},
    });
  });

  it('removes all matching auth profiles for a deleted provider so it does not reappear', async () => {
    await writeOpenClawJson({
      agents: {
        list: [
          { id: 'main', name: 'Main', default: true, workspace: '~/.openclaw/workspace', agentDir: '~/.openclaw/agents/main/agent' },
          { id: 'work', name: 'Work', workspace: '~/.openclaw/workspace-work', agentDir: '~/.openclaw/agents/work/agent' },
        ],
      },
      models: {
        providers: {
          'custom-abc12345': {
            baseUrl: 'https://api.moonshot.cn/v1',
            api: 'openai-completions',
          },
        },
      },
      auth: {
        profiles: {
          'custom-abc12345:oauth': {
            type: 'oauth',
            provider: 'custom-abc12345',
            access: 'acc',
            refresh: 'ref',
            expires: 1,
          },
          'custom-abc12345:secondary': {
            type: 'api_key',
            provider: 'custom-abc12345',
            key: 'sk-inline',
          },
        },
      },
    });

    await writeAgentAuthProfiles('main', {
      version: 1,
      profiles: {
        'custom-abc12345:default': {
          type: 'api_key',
          provider: 'custom-abc12345',
          key: 'sk-main',
        },
        'custom-abc12345:backup': {
          type: 'api_key',
          provider: 'custom-abc12345',
          key: 'sk-backup',
        },
      },
      order: {
        'custom-abc12345': [
          'custom-abc12345:default',
          'custom-abc12345:backup',
        ],
      },
      lastGood: {
        'custom-abc12345': 'custom-abc12345:backup',
      },
    });

    const {
      getActiveOpenClawProviders,
      getOpenClawProvidersConfig,
      removeProviderFromOpenClaw,
    } = await import('@electron/utils/openclaw-auth');

    await expect(getActiveOpenClawProviders()).resolves.toEqual(new Set(['custom-abc12345']));

    await removeProviderFromOpenClaw('custom-abc12345');

    const mainProfiles = await readAuthProfiles('main');
    const config = await readOpenClawJson();
    const result = await getOpenClawProvidersConfig();

    expect(mainProfiles.profiles).toEqual({});
    expect(mainProfiles.order).toEqual({});
    expect(mainProfiles.lastGood).toEqual({});
    expect((config.auth as { profiles?: Record<string, unknown> }).profiles).toEqual({});
    expect((config.models as { providers?: Record<string, unknown> }).providers).toEqual({});
    expect(result.providers).toEqual({});
    await expect(getActiveOpenClawProviders()).resolves.toEqual(new Set());
  });

  it('removes deleted provider refs from agent defaults and overrides', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          'custom-abc12345': {
            baseUrl: 'https://api.example.com/v1',
            api: 'openai-completions',
          },
          'minimax-portal': {
            baseUrl: 'https://api.minimax.io/anthropic',
            api: 'anthropic-messages',
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: 'custom-abc12345/gpt-5.5',
            fallbacks: ['minimax-portal/MiniMax-M3'],
          },
        },
        list: [
          { id: 'main', name: 'Main', default: true, model: { primary: 'custom-abc12345/gpt-5.5' } },
        ],
      },
    });

    const { removeProviderFromOpenClaw } = await import('@electron/utils/openclaw-auth');
    await removeProviderFromOpenClaw('custom-abc12345');

    const config = await readOpenClawJson();
    const agents = config.agents as {
      defaults?: { model?: { primary?: string; fallbacks?: string[] } };
      list?: Array<{ id: string; model?: { primary?: string } }>;
    };

    expect(agents.defaults?.model?.primary).toBeUndefined();
    expect(agents.defaults?.model?.fallbacks).toEqual(['minimax-portal/MiniMax-M3']);
    expect(agents.list?.[0]?.model).toBeUndefined();
  });

  it('removes merged and legacy minimax plugin registrations when deleting the provider', async () => {
    await writeOpenClawJson({
      plugins: {
        allow: ['minimax', 'minimax-portal-auth', 'custom-plugin'],
        entries: {
          minimax: { enabled: true },
          'minimax-portal-auth': { enabled: true },
          'custom-plugin': { enabled: true },
        },
      },
      models: {
        providers: {
          'minimax-portal': {
            baseUrl: 'https://api.minimax.io/anthropic',
            api: 'anthropic-messages',
          },
        },
      },
    });

    const openclawDir = join(testHome, '.openclaw-package-new');
    await mkdir(join(openclawDir, 'dist', 'extensions', 'minimax'), { recursive: true });
    await writeFile(
      join(openclawDir, 'dist', 'extensions', 'minimax', 'openclaw.plugin.json'),
      JSON.stringify({
        id: 'minimax',
        providers: ['minimax', 'minimax-portal'],
        legacyPluginIds: ['minimax-portal-auth'],
      }, null, 2),
      'utf8',
    );

    vi.doMock('@electron/utils/paths', async () => {
      const actual = await vi.importActual<typeof import('@electron/utils/paths')>('@electron/utils/paths');
      return {
        ...actual,
        getOpenClawResolvedDir: () => openclawDir,
      };
    });

    const { removeProviderFromOpenClaw } = await import('@electron/utils/openclaw-auth');

    await removeProviderFromOpenClaw('minimax-portal');

    const result = await readOpenClawJson();
    const plugins = result.plugins as Record<string, unknown>;
    const allow = plugins.allow as string[];
    const entries = plugins.entries as Record<string, Record<string, unknown>>;

    expect(allow).toEqual(['custom-plugin']);
    expect(entries.minimax).toBeUndefined();
    expect(entries['minimax-portal-auth']).toBeUndefined();
    expect(entries['custom-plugin']).toEqual({ enabled: true });
  });

  it('sanitizes stale minimax-portal-auth entries when merged minimax plugin is installed', async () => {
    await writeOpenClawJson({
      plugins: {
        allow: ['minimax-portal-auth', 'custom-plugin'],
        entries: {
          'minimax-portal-auth': { enabled: true },
          'custom-plugin': { enabled: true },
        },
      },
    });

    const openclawDir = join(testHome, '.openclaw-package-new');
    await mkdir(join(openclawDir, 'dist', 'extensions', 'minimax'), { recursive: true });
    await writeFile(
      join(openclawDir, 'dist', 'extensions', 'minimax', 'openclaw.plugin.json'),
      JSON.stringify({
        id: 'minimax',
        providers: ['minimax', 'minimax-portal'],
        legacyPluginIds: ['minimax-portal-auth'],
      }, null, 2),
      'utf8',
    );

    vi.doMock('@electron/utils/paths', async () => {
      const actual = await vi.importActual<typeof import('@electron/utils/paths')>('@electron/utils/paths');
      return {
        ...actual,
        getOpenClawResolvedDir: () => openclawDir,
      };
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');

    await sanitizeOpenClawConfig();

    const result = await readOpenClawJson();
    const plugins = result.plugins as Record<string, unknown>;
    const allow = plugins.allow as string[];
    const entries = plugins.entries as Record<string, Record<string, unknown>>;

    expect(allow).toEqual(['custom-plugin']);
    expect(entries['minimax-portal-auth']).toBeUndefined();
    expect(entries['custom-plugin']).toEqual({ enabled: true });
  });
});

describe('assertValidApiProtocol guard at write sites', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.doUnmock('@electron/utils/provider-registry');
  });

  it('setOpenClawDefaultModel throws InvalidApiProtocolError and leaves openclaw.json untouched when registry api is invalid', async () => {
    const initialConfig = {
      agents: {
        list: [
          {
            id: 'main',
            name: 'Main',
            default: true,
            workspace: '~/.openclaw/workspace',
            agentDir: '~/.openclaw/agents/main/agent',
          },
        ],
      },
      models: {
        providers: {
          'minimax-portal': {
            baseUrl: 'https://api.minimax.io/anthropic',
            api: 'anthropic-messages',
          },
        },
      },
    };
    await writeOpenClawJson(initialConfig);
    const before = await readOpenClawJson();

    vi.doMock('@electron/utils/provider-registry', async () => {
      const actual = await vi.importActual<typeof import('@electron/utils/provider-registry')>(
        '@electron/utils/provider-registry',
      );
      return {
        ...actual,
        getProviderConfig: () => ({
          baseUrl: 'https://example.invalid/v1',
          api: 'totally-bogus-protocol',
          apiKeyEnv: 'EXAMPLE_API_KEY',
        }),
        getProviderDefaultModel: () => 'some-model',
      };
    });

    const { setOpenClawDefaultModel } = await import('@electron/utils/openclaw-auth');
    const { InvalidApiProtocolError } = await import('@electron/shared/providers/types');

    await expect(setOpenClawDefaultModel('bogus-provider')).rejects.toBeInstanceOf(InvalidApiProtocolError);

    const after = await readOpenClawJson();
    expect(after).toEqual(before);
  });
});

describe('anthropic-messages maxTokens', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('adds maxTokens when syncProviderConfigToOpenClaw writes anthropic-messages providers', async () => {
    await writeOpenClawJson({ models: { providers: {} } });

    const { syncProviderConfigToOpenClaw, MINIMAX_M27_MAX_TOKENS } = await import('@electron/utils/openclaw-auth');

    await syncProviderConfigToOpenClaw('minimax-portal', 'MiniMax-M2.7', {
      baseUrl: 'https://api.minimax.io/anthropic',
      api: 'anthropic-messages',
      apiKeyEnv: 'minimax-oauth',
    });

    const result = await readOpenClawJson();
    const provider = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    const entry = provider['minimax-portal'] as Record<string, unknown>;
    const models = entry.models as Array<Record<string, unknown>>;

    expect(entry.maxTokens).toBe(MINIMAX_M27_MAX_TOKENS);
    expect(models).toHaveLength(1);
    expect(models[0]?.maxTokens).toBe(MINIMAX_M27_MAX_TOKENS);
  });

  it('adds maxTokens for custom providers using anthropic-messages', async () => {
    await writeOpenClawJson({ models: { providers: {} } });

    const { syncProviderConfigToOpenClaw, ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS } = await import('@electron/utils/openclaw-auth');

    await syncProviderConfigToOpenClaw('custom-a1b2c3d4', 'my-claude-proxy', {
      baseUrl: 'https://example.com/anthropic',
      api: 'anthropic-messages',
      apiKeyEnv: 'CUSTOM_API_KEY',
    });

    const result = await readOpenClawJson();
    const provider = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    const entry = provider['custom-a1b2c3d4'] as Record<string, unknown>;
    const models = entry.models as Array<Record<string, unknown>>;

    expect(entry.maxTokens).toBe(ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS);
    expect(models[0]?.maxTokens).toBe(ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS);
  });

  it('does not inject maxTokens for openai-completions providers', async () => {
    await writeOpenClawJson({ models: { providers: {} } });

    const { syncProviderConfigToOpenClaw } = await import('@electron/utils/openclaw-auth');

    await syncProviderConfigToOpenClaw('custom-a1b2c3d4', 'gpt-proxy', {
      baseUrl: 'https://example.com/v1',
      api: 'openai-completions',
      apiKeyEnv: 'CUSTOM_API_KEY',
    });

    const result = await readOpenClawJson();
    const provider = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    const entry = provider['custom-a1b2c3d4'] as Record<string, unknown>;
    const models = entry.models as Array<Record<string, unknown>>;

    expect(entry.maxTokens).toBeUndefined();
    expect(models[0]?.maxTokens).toBeUndefined();
  });

  it('heals legacy anthropic-messages entries missing maxTokens', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          'minimax-portal': {
            baseUrl: 'https://api.minimax.io/anthropic',
            api: 'anthropic-messages',
            models: [{ id: 'MiniMax-M2.7', name: 'MiniMax-M2.7' }],
          },
        },
      },
    });

    const { ensureAnthropicMessagesModelMaxTokens, MINIMAX_M27_MAX_TOKENS } = await import('@electron/utils/openclaw-auth');
    const healed = await ensureAnthropicMessagesModelMaxTokens();

    expect(healed).toEqual(['minimax-portal']);

    const result = await readOpenClawJson();
    const entry = ((result.models as Record<string, unknown>).providers as Record<string, unknown>)['minimax-portal'] as Record<string, unknown>;
    const models = entry.models as Array<Record<string, unknown>>;

    expect(entry.maxTokens).toBe(MINIMAX_M27_MAX_TOKENS);
    expect(models[0]?.maxTokens).toBe(MINIMAX_M27_MAX_TOKENS);
  });

  it('preserves a valid user-configured maxTokens value', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          'custom-a1b2c3d4': {
            baseUrl: 'https://example.com/anthropic',
            api: 'anthropic-messages',
            maxTokens: 4096,
            models: [{ id: 'claude-proxy', name: 'claude-proxy', maxTokens: 12288 }],
          },
        },
      },
    });

    const { ensureAnthropicMessagesModelMaxTokens } = await import('@electron/utils/openclaw-auth');
    const healed = await ensureAnthropicMessagesModelMaxTokens();

    expect(healed).toEqual([]);

    const result = await readOpenClawJson();
    const entry = ((result.models as Record<string, unknown>).providers as Record<string, unknown>)['custom-a1b2c3d4'] as Record<string, unknown>;
    const models = entry.models as Array<Record<string, unknown>>;

    expect(entry.maxTokens).toBe(4096);
    expect(models[0]?.maxTokens).toBe(12288);
  });

  it('repairs invalid zero maxTokens during sanitizeOpenClawConfig', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          'minimax-portal': {
            baseUrl: 'https://api.minimax.io/anthropic',
            api: 'anthropic-messages',
            models: [{ id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', maxTokens: 0 }],
          },
        },
      },
    });

    const { sanitizeOpenClawConfig, MINIMAX_M27_MAX_TOKENS } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const result = await readOpenClawJson();
    const entry = ((result.models as Record<string, unknown>).providers as Record<string, unknown>)['minimax-portal'] as Record<string, unknown>;
    const models = entry.models as Array<Record<string, unknown>>;

    expect(entry.maxTokens).toBe(MINIMAX_M27_MAX_TOKENS);
    expect(models[0]?.maxTokens).toBe(MINIMAX_M27_MAX_TOKENS);
  });

  it('adds maxTokens to agent models.json for anthropic-messages providers', async () => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });

    const { updateAgentModelProvider, MINIMAX_M27_MAX_TOKENS } = await import('@electron/utils/openclaw-auth');

    await updateAgentModelProvider('minimax-portal', {
      baseUrl: 'https://api.minimax.io/anthropic',
      api: 'anthropic-messages',
      authHeader: true,
      apiKey: 'minimax-oauth',
      models: [{ id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });

    const content = await readFile(join(testHome, '.openclaw', 'agents', 'main', 'agent', 'models.json'), 'utf8');
    const result = JSON.parse(content) as Record<string, unknown>;
    const providers = result.providers as Record<string, Record<string, unknown>>;
    const entry = providers['minimax-portal'];
    const models = entry.models as Array<Record<string, unknown>>;

    expect(entry.maxTokens).toBe(MINIMAX_M27_MAX_TOKENS);
    expect(models[0]?.maxTokens).toBe(MINIMAX_M27_MAX_TOKENS);
    expect(models[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('repairs legacy agent models.json anthropic-messages entries during update', async () => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });
    const agentDir = join(testHome, '.openclaw', 'agents', 'main', 'agent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        'minimax-portal': {
          baseUrl: 'https://api.minimax.io/anthropic',
          api: 'anthropic-messages',
          models: [{ id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', maxTokens: 0 }],
        },
      },
    }, null, 2), 'utf8');

    const { updateAgentModelProvider, MINIMAX_M27_MAX_TOKENS } = await import('@electron/utils/openclaw-auth');

    await updateAgentModelProvider('minimax-portal', {
      baseUrl: 'https://api.minimax.io/anthropic',
      api: 'anthropic-messages',
      models: [{ id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });

    const content = await readFile(join(agentDir, 'models.json'), 'utf8');
    const result = JSON.parse(content) as Record<string, unknown>;
    const entry = ((result.providers as Record<string, unknown>)['minimax-portal']) as Record<string, unknown>;
    const models = entry.models as Array<Record<string, unknown>>;

    expect(entry.maxTokens).toBe(MINIMAX_M27_MAX_TOKENS);
    expect(models[0]?.maxTokens).toBe(MINIMAX_M27_MAX_TOKENS);
  });
});

describe('managed agent models transaction', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('falls back to main when model target discovery is empty', async () => {
    await mkdir(join(testHome, '.openclaw', 'agents'), { recursive: true });
    const agentConfig = await import('@electron/utils/agent-config');
    vi.spyOn(agentConfig, 'listConfiguredAgentIds').mockResolvedValue([]);
    const {
      restoreManagedAgentModelsFiles,
      snapshotManagedAgentModelsFiles,
      updateManagedAgentModelProviderStrict,
    } = await import('@electron/utils/openclaw-auth');

    const snapshot = await snapshotManagedAgentModelsFiles();
    await updateManagedAgentModelProviderStrict(snapshot, {
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      api: 'openai-responses',
      models: [{ id: 'smart-latest', name: 'smart-latest' }],
    });

    expect(snapshot).toEqual({});
    const installed = JSON.parse(await readFile(getAgentModelsPath('main'), 'utf8')) as {
      providers: Record<string, unknown>;
    };
    expect(installed.providers.openai).toBeDefined();

    await restoreManagedAgentModelsFiles(snapshot);
    await expect(readFile(getAgentModelsPath('main'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replaces the complete openai provider entry while preserving unrelated data', async () => {
    await writeOpenClawJson({
      agents: { list: [{ id: 'main', name: 'Main' }] },
    });
    await writeAgentModelsJson('main', JSON.stringify({
      schemaVersion: 7,
      customMetadata: { owner: 'user' },
      providers: {
        openai: {
          baseUrl: 'https://personal.example/v1',
          api: 'openai-responses',
          apiKey: 'personal-secret',
          authHeader: false,
          headers: { 'X-Personal': 'secret' },
          fallback: 'personal-fallback',
          models: [{ id: 'personal-model', name: 'Personal Model' }],
        },
        'openai-codex': {
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          api: 'openai-chatgpt-responses',
          models: [{ id: 'gpt-5.4', name: 'Legacy Codex' }],
        },
        'legacy-uclaw-relay': {
          baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1/',
          api: 'openai-responses',
          modelId: 'legacy-uclaw-relay/smart-latest',
        },
        'ordinary-custom': {
          baseUrl: 'https://llm.example.com/v1',
          api: 'openai-responses',
          models: [{ id: 'smart-latest', name: 'Unrelated Smart Model' }],
        },
        'same-host-other-model': {
          baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
          api: 'openai-responses',
          models: [{ id: 'other-model', name: 'Other Model' }],
        },
        deepseek: {
          baseUrl: 'https://api.deepseek.com/v1',
          api: 'openai-completions',
          models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
        },
      },
    }, null, 2));

    const {
      snapshotManagedAgentModelsFiles,
      updateManagedAgentModelProviderStrict,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentModelsFiles();
    const managedEntry = {
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      api: 'openai-completions',
      authHeader: true,
      models: [{
        id: 'smart-latest',
        name: 'smart-latest',
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    };

    await updateManagedAgentModelProviderStrict(snapshot, managedEntry);

    const result = JSON.parse(await readFile(getAgentModelsPath('main'), 'utf8')) as Record<string, unknown>;
    const providers = result.providers as Record<string, unknown>;
    expect(result.schemaVersion).toBe(7);
    expect(result.customMetadata).toEqual({ owner: 'user' });
    expect(providers.deepseek).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      api: 'openai-completions',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    });
    expect(providers.openai).toEqual(managedEntry);
    expect(providers['openai-codex']).toBeUndefined();
    expect(providers['legacy-uclaw-relay']).toBeUndefined();
    expect(providers['ordinary-custom']).toEqual({
      baseUrl: 'https://llm.example.com/v1',
      api: 'openai-responses',
      models: [{ id: 'smart-latest', name: 'Unrelated Smart Model' }],
    });
    expect(providers['same-host-other-model']).toEqual({
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      api: 'openai-responses',
      models: [{ id: 'other-model', name: 'Other Model' }],
    });
  });

  it('discovers managed relay ids from every frozen models.json without matching unrelated custom providers', async () => {
    await writeOpenClawJson({
      agents: { list: [{ id: 'main', name: 'Main' }, { id: 'worker', name: 'Worker' }] },
    });
    await writeAgentModelsJson('main', JSON.stringify({
      providers: {
        openai: { baseUrl: 'https://personal.example/v1', models: [{ id: 'personal-model' }] },
        'custom-a1b2c3d4': {
          baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1/',
          models: [{ id: 'smart-latest' }],
          apiKey: 'legacy-inline-key',
        },
        'same-host-other-model': {
          baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
          models: [{ id: 'other-model' }],
        },
        'other-host-same-model': {
          baseUrl: 'https://llm.example.com/v1',
          models: [{ id: 'smart-latest' }],
        },
      },
    }));
    await writeAgentModelsJson('worker', JSON.stringify({
      providers: {
        'custom-e5f6a7b8': {
          baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
          modelId: 'custom-e5f6a7b8/smart-latest',
        },
      },
    }));

    const {
      getManagedAgentOpenAiProviderIds,
      snapshotManagedAgentModelsFiles,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentModelsFiles();

    expect(getManagedAgentOpenAiProviderIds(snapshot)).toEqual([
      'custom-a1b2c3d4',
      'custom-e5f6a7b8',
      'openai',
    ]);
  });

  it('removes managed relay entries and inline keys while preserving unrelated custom providers', async () => {
    await writeOpenClawJson({
      agents: { list: [{ id: 'main', name: 'Main' }, { id: 'worker', name: 'Worker' }] },
    });
    await writeAgentModelsJson('main', JSON.stringify({
      owner: 'main',
      providers: {
        openai: { apiKey: 'personal-openai-key', models: [{ id: 'personal-model' }] },
        'custom-a1b2c3d4': {
          baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
          models: [{ id: 'smart-latest' }],
          apiKey: 'legacy-inline-key',
        },
        'known-managed-id': { apiKey: 'known-managed-key' },
        'same-host-other-model': {
          baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
          models: [{ id: 'other-model' }],
          apiKey: 'keep-other-model-key',
        },
        'other-host-same-model': {
          baseUrl: 'https://llm.example.com/v1',
          models: [{ id: 'smart-latest' }],
          apiKey: 'keep-other-host-key',
        },
      },
    }));
    await writeAgentModelsJson('worker', JSON.stringify({
      providers: {
        deepseek: { apiKey: 'deepseek-key', models: [{ id: 'deepseek-chat' }] },
      },
    }));

    const {
      getManagedAgentOpenAiProviderIds,
      removeManagedAgentOpenAiProviders,
      snapshotManagedAgentModelsFiles,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentModelsFiles();
    const discoveredIds = getManagedAgentOpenAiProviderIds(snapshot);
    await removeManagedAgentOpenAiProviders(snapshot, [...discoveredIds, 'known-managed-id']);

    const main = JSON.parse(await readFile(getAgentModelsPath('main'), 'utf8')) as {
      owner: string;
      providers: Record<string, unknown>;
    };
    const worker = JSON.parse(await readFile(getAgentModelsPath('worker'), 'utf8')) as {
      providers: Record<string, unknown>;
    };
    expect(main.owner).toBe('main');
    expect(Object.keys(main.providers).sort()).toEqual([
      'other-host-same-model',
      'same-host-other-model',
    ]);
    expect(worker.providers).toEqual({
      deepseek: { apiKey: 'deepseek-key', models: [{ id: 'deepseek-chat' }] },
    });
  });

  it('does not create a missing models.json when there is no managed provider to remove', async () => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });
    const {
      removeManagedAgentOpenAiProviders,
      snapshotManagedAgentModelsFiles,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentModelsFiles();

    await removeManagedAgentOpenAiProviders(snapshot);

    await expect(readFile(getAgentModelsPath('main'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preflights every frozen agent before removing any managed models.json entry', async () => {
    await writeOpenClawJson({
      agents: { list: [{ id: 'main', name: 'Main' }, { id: 'worker', name: 'Worker' }] },
    });
    const mainOriginal = JSON.stringify({
      providers: {
        'custom-a1b2c3d4': {
          baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
          models: [{ id: 'smart-latest' }],
          apiKey: 'legacy-inline-key',
        },
      },
    });
    await writeAgentModelsJson('main', mainOriginal);
    await writeAgentModelsJson('worker', JSON.stringify({
      providers: {
        'custom-e5f6a7b8': {
          baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
          models: [{ id: 'smart-latest' }],
        },
      },
    }));
    const {
      removeManagedAgentOpenAiProviders,
      snapshotManagedAgentModelsFiles,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentModelsFiles();
    const workerConcurrent = JSON.stringify({ providers: { deepseek: { apiKey: 'new-key' } } });
    await writeAgentModelsJson('worker', workerConcurrent);

    await expect(removeManagedAgentOpenAiProviders(snapshot)).rejects.toThrow('worker');

    expect(await readFile(getAgentModelsPath('main'), 'utf8')).toBe(mainOriginal);
    expect(await readFile(getAgentModelsPath('worker'), 'utf8')).toBe(workerConcurrent);
  });

  it('preflights every frozen agent before writing any models.json', async () => {
    await writeOpenClawJson({
      agents: { list: [{ id: 'main', name: 'Main' }, { id: 'worker', name: 'Worker' }] },
    });
    const mainOriginal = '{"owner":"main","providers":{"deepseek":{"api":"openai-completions"}}}\n';
    const workerOriginal = '{\n  "owner": "worker",\n  "providers": {}\n}\n';
    await writeAgentModelsJson('main', mainOriginal);
    await writeAgentModelsJson('worker', workerOriginal);

    const {
      snapshotManagedAgentModelsFiles,
      updateManagedAgentModelProviderStrict,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentModelsFiles();
    const workerPath = getAgentModelsPath('worker');
    await rm(workerPath);
    await mkdir(workerPath);

    await expect(updateManagedAgentModelProviderStrict(snapshot, {
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      api: 'openai-completions',
      models: [{ id: 'smart-latest', name: 'smart-latest' }],
    })).rejects.toThrow('worker');

    expect(await readFile(getAgentModelsPath('main'), 'utf8')).toBe(mainOriginal);
    expect((await stat(workerPath)).isDirectory()).toBe(true);
  });

  it('rejects a concurrently created models.json when the snapshot target was missing', async () => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });
    const {
      snapshotManagedAgentModelsFiles,
      updateManagedAgentModelProviderStrict,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentModelsFiles();
    const concurrentModels = '{"providers":{"deepseek":{"api":"openai-completions"}}}\n';
    await writeAgentModelsJson('main', concurrentModels);

    await expect(updateManagedAgentModelProviderStrict(snapshot, {
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      api: 'openai-responses',
      models: [{ id: 'smart-latest', name: 'smart-latest' }],
    })).rejects.toThrow('main');

    expect(await readFile(getAgentModelsPath('main'), 'utf8')).toBe(concurrentModels);
  });

  it('deletes models.json files that did not exist before the transaction', async () => {
    await writeOpenClawJson({
      agents: { list: [{ id: 'main', name: 'Main' }, { id: 'worker', name: 'Worker' }] },
    });

    const {
      restoreManagedAgentModelsFiles,
      snapshotManagedAgentModelsFiles,
      updateManagedAgentModelProviderStrict,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentModelsFiles();

    await updateManagedAgentModelProviderStrict(snapshot, {
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      api: 'openai-completions',
      models: [{ id: 'smart-latest', name: 'smart-latest' }],
    });
    await restoreManagedAgentModelsFiles(snapshot);

    await expect(readFile(getAgentModelsPath('main'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(getAgentModelsPath('worker'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to overwrite a concurrent models.json change during rollback', async () => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });
    await writeAgentModelsJson('main', '{"providers":{"deepseek":{"api":"openai-completions"}}}\n');
    const {
      restoreManagedAgentModelsFiles,
      snapshotManagedAgentModelsFiles,
      updateManagedAgentModelProviderStrict,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentModelsFiles();
    await updateManagedAgentModelProviderStrict(snapshot, {
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      api: 'openai-responses',
      models: [{ id: 'smart-latest', name: 'smart-latest' }],
    });
    const concurrentModels = '{"providers":{"moonshot":{"api":"openai-completions"}}}\n';
    await writeFile(getAgentModelsPath('main'), concurrentModels, 'utf8');

    const error = await restoreManagedAgentModelsFiles(snapshot).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AggregateError);
    expect(await readFile(getAgentModelsPath('main'), 'utf8')).toBe(concurrentModels);
  });

  it('preserves a concurrent models.json created after installing a missing target', async () => {
    await writeOpenClawJson({ agents: { list: [{ id: 'main', name: 'Main' }] } });
    const {
      restoreManagedAgentModelsFiles,
      snapshotManagedAgentModelsFiles,
      updateManagedAgentModelProviderStrict,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentModelsFiles();
    await updateManagedAgentModelProviderStrict(snapshot, {
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      api: 'openai-responses',
      models: [{ id: 'smart-latest', name: 'smart-latest' }],
    });
    const concurrentModels = '{"providers":{"deepseek":{"api":"openai-completions"}}}\n';
    await writeFile(getAgentModelsPath('main'), concurrentModels, 'utf8');

    const error = await restoreManagedAgentModelsFiles(snapshot).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AggregateError);
    expect(await readFile(getAgentModelsPath('main'), 'utf8')).toBe(concurrentModels);
  });

  it('attempts every restore target before reporting aggregated failures', async () => {
    await writeOpenClawJson({
      agents: { list: [{ id: 'main', name: 'Main' }, { id: 'worker', name: 'Worker' }] },
    });
    await writeAgentModelsJson('main', '{"providers":{}}');
    await writeAgentModelsJson('worker', '{"providers":{}}');

    const {
      restoreManagedAgentModelsFiles,
      snapshotManagedAgentModelsFiles,
    } = await import('@electron/utils/openclaw-auth');
    const snapshot = await snapshotManagedAgentModelsFiles();
    for (const agentId of ['main', 'worker']) {
      const modelsPath = getAgentModelsPath(agentId);
      await rm(modelsPath);
      await mkdir(modelsPath);
    }

    const error = await restoreManagedAgentModelsFiles(snapshot).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
  });

  it('rejects corrupt JSON during snapshot before any models.json write', async () => {
    await writeOpenClawJson({
      agents: { list: [{ id: 'main', name: 'Main' }, { id: 'worker', name: 'Worker' }] },
    });
    const mainOriginal = '{"providers":{"deepseek":{"api":"openai-completions"}}}\n';
    const workerOriginal = '{not-json';
    await writeAgentModelsJson('main', mainOriginal);
    await writeAgentModelsJson('worker', workerOriginal);

    const { snapshotManagedAgentModelsFiles } = await import('@electron/utils/openclaw-auth');

    await expect(snapshotManagedAgentModelsFiles()).rejects.toThrow('worker');
    expect(await readFile(getAgentModelsPath('main'), 'utf8')).toBe(mainOriginal);
    expect(await readFile(getAgentModelsPath('worker'), 'utf8')).toBe(workerOriginal);
  });

  it('keeps the generic updater best-effort when one agent write fails', async () => {
    await writeOpenClawJson({
      agents: { list: [{ id: 'main', name: 'Main' }, { id: 'worker', name: 'Worker' }] },
    });
    await writeAgentModelsJson('main', '{"providers":{}}');
    await writeAgentModelsJson('worker', '{"providers":{}}');
    const workerPath = getAgentModelsPath('worker');
    await rm(workerPath);
    await mkdir(workerPath);

    const { updateAgentModelProvider } = await import('@electron/utils/openclaw-auth');

    await expect(updateAgentModelProvider('openai', {
      baseUrl: 'https://example.com/v1',
      api: 'openai-completions',
      models: [{ id: 'example', name: 'example' }],
    })).resolves.toBeUndefined();

    const main = JSON.parse(await readFile(getAgentModelsPath('main'), 'utf8')) as Record<string, unknown>;
    expect((main.providers as Record<string, unknown>).openai).toBeDefined();
  });
});

describe('pruneInvalidApiProviderEntries', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('removes only the entries whose api field is not in the OpenClaw allowlist', async () => {
    await writeOpenClawJson({
      agents: { list: [{ id: 'main', name: 'Main', default: true, workspace: '~/.openclaw/workspace', agentDir: '~/.openclaw/agents/main/agent' }] },
      models: {
        providers: {
          openrouter: {
            baseUrl: 'https://openrouter.ai/api/v1',
            api: 'openrouter',
            apiKey: 'OPENROUTER_API_KEY',
          },
          'minimax-portal': {
            baseUrl: 'https://api.minimax.io/anthropic',
            api: 'anthropic-messages',
          },
          ark: {
            baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
            api: 'openai-completions',
          },
          someBroken: {
            baseUrl: 'https://example.invalid/v1',
            api: 'no-such-protocol',
          },
        },
      },
    });

    const { pruneInvalidApiProviderEntries } = await import('@electron/utils/openclaw-auth');

    const removed = await pruneInvalidApiProviderEntries();
    expect(new Set(removed)).toEqual(new Set(['openrouter', 'someBroken']));

    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    expect(Object.keys(providers).sort()).toEqual(['ark', 'minimax-portal']);
    expect((providers['minimax-portal'] as { api: string }).api).toBe('anthropic-messages');
    expect((providers.ark as { api: string }).api).toBe('openai-completions');
  });

  it('returns an empty array and leaves the file untouched when all entries are valid', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          'minimax-portal': {
            baseUrl: 'https://api.minimax.io/anthropic',
            api: 'anthropic-messages',
          },
        },
      },
    });
    const before = await readOpenClawJson();

    const { pruneInvalidApiProviderEntries } = await import('@electron/utils/openclaw-auth');
    const removed = await pruneInvalidApiProviderEntries();

    expect(removed).toEqual([]);
    const after = await readOpenClawJson();
    expect(after).toEqual(before);
  });

  it('migrates legacy openai-codex-responses api values instead of pruning them', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          'openai-codex': {
            baseUrl: 'https://api.openai.com/v1',
            api: 'openai-codex-responses',
          },
          openrouter: {
            baseUrl: 'https://openrouter.ai/api/v1',
            api: 'openrouter',
          },
        },
      },
    });

    const { pruneInvalidApiProviderEntries } = await import('@electron/utils/openclaw-auth');
    const removed = await pruneInvalidApiProviderEntries();

    expect(removed).toEqual(['openrouter']);
    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    expect(providers['openai-codex']).toBeUndefined();
    expect((providers.openai as { api: string }).api).toBe('openai-chatgpt-responses');
    expect((providers.openai as { baseUrl: string }).baseUrl).toBe('https://chatgpt.com/backend-api/codex');
  });
});

describe('openai agentRuntime pin', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('pins agentRuntime to the embedded "pi" runtime when syncProviderConfigToOpenClaw writes the openai entry', async () => {
    await writeOpenClawJson({
      models: { providers: {} },
    });

    const { syncProviderConfigToOpenClaw } = await import('@electron/utils/openclaw-auth');

    await syncProviderConfigToOpenClaw('openai', 'gpt-5.5', {
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-responses',
      apiKeyEnv: 'OPENAI_API_KEY',
    });

    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    const openai = providers.openai as Record<string, unknown>;

    expect(openai).toBeDefined();
    expect(openai.agentRuntime).toEqual({ id: 'pi' });
    expect(openai.api).toBe('openai-responses');
    expect(openai.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('pins agentRuntime to the embedded "pi" runtime for the OAuth openai-codex provider entry', async () => {
    await writeOpenClawJson({
      models: { providers: {} },
    });

    const { syncProviderConfigToOpenClaw } = await import('@electron/utils/openclaw-auth');

    await syncProviderConfigToOpenClaw('openai-codex', 'gpt-5.5', {
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-chatgpt-responses',
    });

    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    const codex = providers['openai-codex'] as Record<string, unknown>;

    expect(codex).toBeDefined();
    expect(codex.agentRuntime).toEqual({ id: 'pi' });
    expect(codex.api).toBe('openai-chatgpt-responses');
    expect(codex.baseUrl).toBe('https://chatgpt.com/backend-api/codex');
  });

  it('preserves a user-provided agentRuntime override on the openai entry', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            api: 'openai-responses',
            apiKey: 'OPENAI_API_KEY',
            agentRuntime: { id: 'custom-harness' },
            models: [],
          },
        },
      },
    });

    const { syncProviderConfigToOpenClaw } = await import('@electron/utils/openclaw-auth');

    await syncProviderConfigToOpenClaw('openai', 'gpt-5.5', {
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-responses',
      apiKeyEnv: 'OPENAI_API_KEY',
    });

    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    const openai = providers.openai as Record<string, unknown>;

    expect(openai.agentRuntime).toEqual({ id: 'custom-harness' });
  });
});

describe('syncOpenAiCompatibleImageRelay', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('writes a ClawX-owned provider with a custom image base URL without changing OpenAI chat config', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-responses', models: [] },
        },
      },
    });

    const { syncOpenAiCompatibleImageRelay } = await import('@electron/utils/openclaw-auth');
    await syncOpenAiCompatibleImageRelay({
      enabled: true,
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay-test',
      imageModelIds: ['gpt-image-2'],
    });

    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    const openai = providers.openai as Record<string, unknown>;
    const imageRelay = providers['clawx-openai-image'] as Record<string, unknown>;
    expect(openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(openai.api).toBe('openai-responses');
    expect(imageRelay.baseUrl).toBe('https://relay.example.com/v1');
    expect(imageRelay.api).toBe('openai-completions');
    expect(imageRelay.request).toEqual({ allowPrivateNetwork: true });
    expect(imageRelay.models).toEqual([{ id: 'gpt-image-2', name: 'gpt-image-2' }]);

    const plugins = result.plugins as Record<string, unknown>;
    const entries = plugins.entries as Record<string, unknown>;
    expect((entries['clawx-openai-image'] as Record<string, unknown>).enabled).toBe(true);

    const auth = await readAuthProfiles('main');
    expect((auth.profiles['clawx-openai-image:default'] as Record<string, unknown>).key).toBe('sk-relay-test');
  });

  it('removes only the ClawX image provider when relay is disabled', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-responses', models: [] },
          'clawx-openai-image': { baseUrl: 'https://relay.example.com/v1', api: 'openai-completions', models: [] },
        },
      },
      agents: {
        defaults: {
          imageGenerationModel: { primary: 'clawx-openai-image/gpt-image-2', timeoutMs: 180000 },
        },
      },
      plugins: {
        allow: ['clawx-openai-image'],
        entries: { 'clawx-openai-image': { enabled: true } },
      },
    });

    const { syncOpenAiCompatibleImageRelay } = await import('@electron/utils/openclaw-auth');
    await syncOpenAiCompatibleImageRelay({ enabled: false });

    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    expect(providers.openai).toEqual({ baseUrl: 'https://api.openai.com/v1', api: 'openai-responses', models: [] });
    expect(providers['clawx-openai-image']).toBeUndefined();
    const defaults = (result.agents as Record<string, unknown>).defaults as Record<string, unknown>;
    expect(defaults.imageGenerationModel).toBeUndefined();
    expect(result.plugins).toBeUndefined();
  });
});

describe('setOpenClawDefaultModel for OpenAI OAuth', () => {
  beforeEach(async () => {
    vi.doUnmock('@electron/utils/provider-registry');
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('writes models.providers.openai with a pinned pi runtime for legacy openai-codex calls', async () => {
    await writeOpenClawJson({
      models: { providers: {} },
    });

    const { setOpenClawDefaultModel } = await import('@electron/utils/openclaw-auth');
    await setOpenClawDefaultModel('openai-codex', 'openai-codex/gpt-5.5');

    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    const openai = providers.openai as Record<string, unknown>;
    const defaults = ((result.agents as Record<string, unknown>).defaults as Record<string, unknown>).model as Record<string, unknown>;

    expect(defaults.primary).toBe('openai/gpt-5.5');
    expect(openai.agentRuntime).toEqual({ id: 'pi' });
    expect(openai.api).toBe('openai-chatgpt-responses');
    expect(openai.baseUrl).toBe('https://chatgpt.com/backend-api/codex');
    expect(providers['openai-codex']).toBeUndefined();
  });
});

describe('ensureOpenClawProviderAgentRuntimePins', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('pins agentRuntime:{id:"pi"} on legacy openai entries that lack it', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            api: 'openai-responses',
            apiKey: 'OPENAI_API_KEY',
            models: [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
          },
        },
      },
    });

    const { ensureOpenClawProviderAgentRuntimePins } = await import('@electron/utils/openclaw-auth');
    const pinned = await ensureOpenClawProviderAgentRuntimePins();

    expect(pinned).toEqual(['openai']);
    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    const openai = providers.openai as Record<string, unknown>;
    expect(openai.agentRuntime).toEqual({ id: 'pi' });
    expect(openai.api).toBe('openai-responses');
  });

  it('pins agentRuntime:{id:"pi"} on legacy openai-codex OAuth entries that lack it', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          'openai-codex': {
            baseUrl: 'https://api.openai.com/v1',
            api: 'openai-chatgpt-responses',
            models: [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
          },
        },
      },
    });

    const { ensureOpenClawProviderAgentRuntimePins } = await import('@electron/utils/openclaw-auth');
    const pinned = await ensureOpenClawProviderAgentRuntimePins();

    expect(pinned).toEqual(['openai-codex']);
    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    const codex = providers['openai-codex'] as Record<string, unknown>;
    expect(codex.agentRuntime).toEqual({ id: 'pi' });
  });

  it('pins legacy OpenAI entries during sanitizeOpenClawConfig before Gateway launch', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            api: 'openai-responses',
            models: [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
          },
          'openai-codex': {
            baseUrl: 'https://api.openai.com/v1',
            api: 'openai-chatgpt-responses',
            models: [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
          },
        },
      },
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    expect((providers.openai as Record<string, unknown>).agentRuntime).toEqual({ id: 'pi' });
    expect(providers['openai-codex']).toBeUndefined();
  });

  it('migrates legacy openai-codex-responses api values during sanitizeOpenClawConfig', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          'openai-codex': {
            baseUrl: 'https://api.openai.com/v1',
            api: 'openai-codex-responses',
            models: [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
          },
        },
      },
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const result = await readOpenClawJson();
    const providers = (result.models as Record<string, unknown>).providers as Record<string, unknown>;
    expect((providers.openai as { api: string }).api).toBe('openai-chatgpt-responses');
    expect((providers.openai as { baseUrl: string }).baseUrl).toBe('https://chatgpt.com/backend-api/codex');
    expect(providers['openai-codex']).toBeUndefined();
  });

  it('leaves entries untouched when the openai entry already has any agentRuntime.id', async () => {
    const initial = {
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            api: 'openai-responses',
            apiKey: 'OPENAI_API_KEY',
            agentRuntime: { id: 'custom-harness' },
            models: [],
          },
          'minimax-portal': {
            baseUrl: 'https://api.minimax.io/anthropic',
            api: 'anthropic-messages',
          },
        },
      },
    };
    await writeOpenClawJson(initial);
    const before = await readOpenClawJson();

    const { ensureOpenClawProviderAgentRuntimePins } = await import('@electron/utils/openclaw-auth');
    const pinned = await ensureOpenClawProviderAgentRuntimePins();

    expect(pinned).toEqual([]);
    const after = await readOpenClawJson();
    expect(after).toEqual(before);
  });

  it('returns an empty array when openclaw.json has no openai provider entry', async () => {
    const initial = {
      models: {
        providers: {
          'minimax-portal': {
            baseUrl: 'https://api.minimax.io/anthropic',
            api: 'anthropic-messages',
          },
        },
      },
    };
    await writeOpenClawJson(initial);
    const before = await readOpenClawJson();

    const { ensureOpenClawProviderAgentRuntimePins } = await import('@electron/utils/openclaw-auth');
    const pinned = await ensureOpenClawProviderAgentRuntimePins();

    expect(pinned).toEqual([]);
    const after = await readOpenClawJson();
    expect(after).toEqual(before);
  });
});

describe('batchSyncConfigFields', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    getSettingMock.mockImplementation(async (key: string) => {
      if (key === 'gatewayPort') return 18789;
      return undefined;
    });
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('seeds web_fetch SSRF policy for fake-IP proxy environments', async () => {
    await writeOpenClawJson({ gateway: { auth: { mode: 'token', token: 'old' } } });

    const { batchSyncConfigFields } = await import('@electron/utils/openclaw-auth');
    await batchSyncConfigFields('new-token');

    const config = await readOpenClawJson();
    const fetch = (config.tools as Record<string, unknown>).web as Record<string, unknown>;
    const ssrfPolicy = (fetch.fetch as Record<string, unknown>).ssrfPolicy as Record<string, unknown>;
    expect(ssrfPolicy.allowRfc2544BenchmarkRange).toBe(true);
    expect(ssrfPolicy.allowIpv6UniqueLocalRange).toBe(true);
  });

  it('does not override explicit web_fetch SSRF policy opt-outs', async () => {
    await writeOpenClawJson({
      gateway: { auth: { mode: 'token', token: 'old' } },
      tools: {
        web: {
          fetch: {
            ssrfPolicy: {
              allowRfc2544BenchmarkRange: false,
              allowIpv6UniqueLocalRange: false,
            },
          },
        },
      },
    });

    const { batchSyncConfigFields } = await import('@electron/utils/openclaw-auth');
    await batchSyncConfigFields('new-token');

    const config = await readOpenClawJson();
    const fetch = (config.tools as Record<string, unknown>).web as Record<string, unknown>;
    const ssrfPolicy = (fetch.fetch as Record<string, unknown>).ssrfPolicy as Record<string, unknown>;
    expect(ssrfPolicy.allowRfc2544BenchmarkRange).toBe(false);
    expect(ssrfPolicy.allowIpv6UniqueLocalRange).toBe(false);
  });

  it('seeds compaction safeguard default when compaction is unset', async () => {
    await writeOpenClawJson({ gateway: { auth: { mode: 'token', token: 'old' } } });

    const { batchSyncConfigFields } = await import('@electron/utils/openclaw-auth');
    await batchSyncConfigFields('new-token');

    const config = await readOpenClawJson();
    const defaults = ((config.agents as Record<string, unknown>).defaults as Record<string, unknown>);
    expect(defaults.compaction).toEqual({
      mode: 'safeguard',
      reserveTokensFloor: 50_000,
    });
  });

  it('backfills reserveTokensFloor on safeguard compaction seeded without a floor', async () => {
    await writeOpenClawJson({
      gateway: { auth: { mode: 'token', token: 'old' } },
      agents: {
        defaults: {
          compaction: { mode: 'safeguard' },
        },
      },
    });

    const { batchSyncConfigFields } = await import('@electron/utils/openclaw-auth');
    await batchSyncConfigFields('new-token');

    const config = await readOpenClawJson();
    const defaults = ((config.agents as Record<string, unknown>).defaults as Record<string, unknown>);
    expect(defaults.compaction).toEqual({
      mode: 'safeguard',
      reserveTokensFloor: 50_000,
    });
  });

  it('does not touch an explicit compaction config', async () => {
    await writeOpenClawJson({
      gateway: { auth: { mode: 'token', token: 'old' } },
      agents: {
        defaults: {
          compaction: { mode: 'default', reserveTokensFloor: 30000 },
        },
      },
    });

    const { batchSyncConfigFields } = await import('@electron/utils/openclaw-auth');
    await batchSyncConfigFields('new-token');

    const config = await readOpenClawJson();
    const defaults = ((config.agents as Record<string, unknown>).defaults as Record<string, unknown>);
    expect(defaults.compaction).toEqual({ mode: 'default', reserveTokensFloor: 30000 });
  });

  it('backfills contextWindow on custom provider model rows that lack one', async () => {
    await writeOpenClawJson({
      gateway: { auth: { mode: 'token', token: 'old' } },
      models: {
        providers: {
          'custom-enterpri': {
            baseUrl: 'https://example.com/v1',
            api: 'openai-completions',
            models: [
              { id: 'gpt-5.5', name: 'gpt-5.5', input: ['text', 'image'] },
              { id: 'private-x', name: 'private-x', input: ['text'], contextTokens: 32000 },
            ],
          },
          moonshot: {
            baseUrl: 'https://api.moonshot.cn/v1',
            api: 'openai-completions',
            models: [{ id: 'kimi-k2.6', name: 'Kimi K2.6' }],
          },
        },
      },
    });

    const { batchSyncConfigFields } = await import('@electron/utils/openclaw-auth');
    await batchSyncConfigFields('new-token');

    const config = await readOpenClawJson();
    const providers = (config.models as Record<string, unknown>).providers as Record<string, unknown>;
    const custom = (providers['custom-enterpri'] as Record<string, unknown>).models as Array<Record<string, unknown>>;
    const moonshot = (providers.moonshot as Record<string, unknown>).models as Array<Record<string, unknown>>;

    expect(custom[0]).toEqual(expect.objectContaining({ id: 'gpt-5.5', contextWindow: 272000 }));
    // Rows with explicit contextTokens are user-owned — leave untouched.
    expect(custom[1].contextWindow).toBeUndefined();
    expect(custom[1].contextTokens).toBe(32000);
    // Non custom-* providers own their metadata — never backfilled.
    expect(moonshot[0].contextWindow).toBeUndefined();
  });
});
