// @vitest-environment node

import { existsSync } from 'fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { testHome } = vi.hoisted(() => ({
  testHome: `/tmp/clawx-auth-sqlite-${Math.random().toString(36).slice(2)}`,
}));

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

async function writeJsonStore(agentId: string, store: Record<string, unknown>): Promise<void> {
  const dir = join(testHome, '.openclaw', 'agents', agentId, 'agent');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'auth-profiles.json'), JSON.stringify(store, null, 2), 'utf8');
}

describe('openclaw-auth-sqlite', () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(testHome, { recursive: true, force: true });
  });

  it('migrates auth-profiles.json into openclaw-agent.sqlite when sqlite is empty', async () => {
    await writeJsonStore('main', {
      version: 1,
      profiles: {
        'custom-customc7:default': {
          type: 'api_key',
          provider: 'custom-customc7',
          key: 'sk-test-key',
        },
      },
      order: { 'custom-customc7': ['custom-customc7:default'] },
      lastGood: { 'custom-customc7': 'custom-customc7:default' },
    });

    const {
      migrateAuthProfilesJsonToSqliteIfNeeded,
      readAuthProfilesFromSqlite,
      getAuthProfilesSqlitePath,
    } = await import('@electron/utils/openclaw-auth-sqlite');

    const migrated = await migrateAuthProfilesJsonToSqliteIfNeeded('main');
    expect(migrated).toBe(true);
    expect(existsSync(getAuthProfilesSqlitePath('main'))).toBe(true);

    const sqliteStore = readAuthProfilesFromSqlite('main');
    expect(sqliteStore?.profiles['custom-customc7:default']).toMatchObject({
      type: 'api_key',
      provider: 'custom-customc7',
      key: 'sk-test-key',
    });
    expect(sqliteStore?.order?.['custom-customc7']).toEqual(['custom-customc7:default']);
    expect(sqliteStore?.lastGood?.['custom-customc7']).toBe('custom-customc7:default');
  });

  it('saveProviderKeyToOpenClaw writes credentials readable from sqlite', async () => {
    const { saveProviderKeyToOpenClaw } = await import('@electron/utils/openclaw-auth');
    const {
      readAuthProfilesFromSqlite,
      getAuthProfilesSqlitePath,
    } = await import('@electron/utils/openclaw-auth-sqlite');

    await saveProviderKeyToOpenClaw('custom-customc7', 'sk-runtime-key', 'main');

    expect(existsSync(getAuthProfilesSqlitePath('main'))).toBe(true);
    const sqliteStore = readAuthProfilesFromSqlite('main');
    expect(sqliteStore?.profiles['custom-customc7:default']).toMatchObject({
      type: 'api_key',
      provider: 'custom-customc7',
      key: 'sk-runtime-key',
    });

    const json = JSON.parse(
      await readFile(join(testHome, '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect((json.profiles as Record<string, unknown>)['custom-customc7:default']).toMatchObject({
      key: 'sk-runtime-key',
    });
  });

  it('enforces private modes on an existing agent directory and credential database', async () => {
    if (process.platform === 'win32') return;
    const agentDir = join(testHome, '.openclaw', 'agents', 'main', 'agent');
    await mkdir(agentDir, { recursive: true, mode: 0o755 });
    await chmod(agentDir, 0o755);
    const {
      getAuthProfilesSqlitePath,
      writeAuthProfilesToSqlite,
    } = await import('@electron/utils/openclaw-auth-sqlite');

    writeAuthProfilesToSqlite({
      version: 1,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'private-key' },
      },
    }, 'main');

    expect((await stat(agentDir)).mode & 0o777).toBe(0o700);
    expect((await stat(getAuthProfilesSqlitePath('main'))).mode & 0o777).toBe(0o600);
  });

  it('restores the exact primary store and state rows', async () => {
    const {
      restoreAuthProfilesSqlitePrimaryRows,
      snapshotAuthProfilesSqlitePrimaryRows,
      writeAuthProfilesToSqlite,
    } = await import('@electron/utils/openclaw-auth-sqlite');
    writeAuthProfilesToSqlite({
      version: 1,
      profiles: {
        'openai:default': {
          type: 'oauth',
          provider: 'openai',
          access: 'original-access',
          refresh: 'original-refresh',
          expires: 123,
        },
      },
      order: { openai: ['openai:default'] },
      lastGood: { openai: 'openai:default' },
    }, 'main');
    const original = snapshotAuthProfilesSqlitePrimaryRows('main');

    writeAuthProfilesToSqlite({
      version: 1,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'managed-key' },
      },
      order: { openai: ['openai:default'] },
      lastGood: { openai: 'openai:default' },
    }, 'main');
    restoreAuthProfilesSqlitePrimaryRows(original);

    expect(snapshotAuthProfilesSqlitePrimaryRows('main')).toEqual(original);
  });

  it('removes a transaction-created sqlite database when the original did not exist', async () => {
    const {
      guardManagedAuthProfilesSqliteWrite,
      getAuthProfilesSqlitePath,
      restoreAuthProfilesSqlitePrimaryRows,
      snapshotAuthProfilesSqlitePrimaryRows,
      writeAuthProfilesToSqlite,
    } = await import('@electron/utils/openclaw-auth-sqlite');
    const original = snapshotAuthProfilesSqlitePrimaryRows('main');
    expect(original.storeRow).toBeNull();
    expect(original.stateRow).toBeNull();

    const managedStore = {
      version: 1,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'managed-key' },
      },
      order: { openai: ['openai:default'] },
      lastGood: { openai: 'openai:default' },
    };
    guardManagedAuthProfilesSqliteWrite(original);
    writeAuthProfilesToSqlite(managedStore, 'main', original);
    restoreAuthProfilesSqlitePrimaryRows(original);

    expect(existsSync(getAuthProfilesSqlitePath('main'))).toBe(false);
    expect(existsSync(`${getAuthProfilesSqlitePath('main')}-wal`)).toBe(false);
    expect(existsSync(`${getAuthProfilesSqlitePath('main')}-shm`)).toBe(false);
  });

  it('refuses to delete a transaction-created database after a concurrent credential change', async () => {
    const {
      guardManagedAuthProfilesSqliteWrite,
      getAuthProfilesSqlitePath,
      readAuthProfilesFromSqlite,
      restoreAuthProfilesSqlitePrimaryRows,
      snapshotAuthProfilesSqlitePrimaryRows,
      writeAuthProfilesToSqlite,
    } = await import('@electron/utils/openclaw-auth-sqlite');
    const original = snapshotAuthProfilesSqlitePrimaryRows('main');
    const managedStore = {
      version: 1,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'managed-key' },
      },
    };
    guardManagedAuthProfilesSqliteWrite(original);
    writeAuthProfilesToSqlite(managedStore, 'main', original);
    writeAuthProfilesToSqlite({
      version: 1,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'concurrent-key' },
      },
    }, 'main');

    expect(() => restoreAuthProfilesSqlitePrimaryRows(original)).toThrow(
      'Failed to verify transaction-created auth database',
    );
    expect(existsSync(getAuthProfilesSqlitePath('main'))).toBe(true);
    expect(readAuthProfilesFromSqlite('main')?.profiles['openai:default']).toMatchObject({
      key: 'concurrent-key',
    });
  });

  it('rejects a managed write when existing rows changed after its snapshot', async () => {
    const {
      guardManagedAuthProfilesSqliteWrite,
      readAuthProfilesFromSqlite,
      restoreAuthProfilesSqlitePrimaryRows,
      snapshotAuthProfilesSqlitePrimaryRows,
      writeAuthProfilesToSqlite,
    } = await import('@electron/utils/openclaw-auth-sqlite');
    writeAuthProfilesToSqlite({
      version: 1,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'original-key' },
      },
    }, 'main');
    const original = snapshotAuthProfilesSqlitePrimaryRows('main');
    guardManagedAuthProfilesSqliteWrite(original);
    writeAuthProfilesToSqlite({
      version: 1,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'concurrent-key' },
      },
    }, 'main');

    expect(() => writeAuthProfilesToSqlite({
      version: 1,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'managed-key' },
      },
    }, 'main', original)).toThrow('Failed to write auth profile rows');
    restoreAuthProfilesSqlitePrimaryRows(original);

    expect(readAuthProfilesFromSqlite('main')?.profiles['openai:default']).toMatchObject({
      key: 'concurrent-key',
    });
  });

  it('refuses a managed rollback when existing rows changed after its write', async () => {
    const {
      guardManagedAuthProfilesSqliteWrite,
      readAuthProfilesFromSqlite,
      restoreAuthProfilesSqlitePrimaryRows,
      snapshotAuthProfilesSqlitePrimaryRows,
      writeAuthProfilesToSqlite,
    } = await import('@electron/utils/openclaw-auth-sqlite');
    writeAuthProfilesToSqlite({
      version: 1,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'original-key' },
      },
    }, 'main');
    const original = snapshotAuthProfilesSqlitePrimaryRows('main');
    guardManagedAuthProfilesSqliteWrite(original);
    writeAuthProfilesToSqlite({
      version: 1,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'managed-key' },
      },
    }, 'main', original);
    writeAuthProfilesToSqlite({
      version: 1,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'concurrent-key' },
      },
    }, 'main');

    expect(() => restoreAuthProfilesSqlitePrimaryRows(original)).toThrow(
      'Failed to restore auth profile rows',
    );
    expect(readAuthProfilesFromSqlite('main')?.profiles['openai:default']).toMatchObject({
      key: 'concurrent-key',
    });
  });

  it('rolls back the credential row when the state row write fails', async () => {
    const {
      getAuthProfilesSqlitePath,
      readAuthProfilesFromSqlite,
      writeAuthProfilesToSqlite,
    } = await import('@electron/utils/openclaw-auth-sqlite');
    const originalStore = {
      version: 1,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'original-key' },
      },
      order: { openai: ['openai:default'] },
    };
    writeAuthProfilesToSqlite(originalStore, 'main');

    const db = new DatabaseSync(getAuthProfilesSqlitePath('main'));
    db.exec(`CREATE TRIGGER fail_auth_state_write
      BEFORE INSERT ON auth_profile_state
      BEGIN
        SELECT RAISE(ABORT, 'state write rejected');
      END;`);
    db.close();

    expect(() => writeAuthProfilesToSqlite({
      version: 1,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'partial-key' },
      },
      order: { openai: ['openai:default'] },
    }, 'main')).toThrow('Failed to write auth profile rows');
    expect(readAuthProfilesFromSqlite('main')).toEqual(originalStore);
  });

  it('does not downgrade or modify a future agent database schema', async () => {
    const {
      getAuthProfilesSqlitePath,
      writeAuthProfilesToSqlite,
    } = await import('@electron/utils/openclaw-auth-sqlite');
    const sqlitePath = getAuthProfilesSqlitePath('main');
    await mkdir(join(sqlitePath, '..'), { recursive: true });
    const db = new DatabaseSync(sqlitePath);
    db.exec('PRAGMA user_version = 2;');
    db.close();

    expect(() => writeAuthProfilesToSqlite({
      version: 1,
      profiles: {},
    }, 'main')).toThrow('future OpenClaw agent database schema version 2');

    const verifyDb = new DatabaseSync(sqlitePath, { readOnly: true });
    expect((verifyDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
    expect(verifyDb.prepare(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'`,
    ).get()).toBeUndefined();
    verifyDb.close();
  });

  it('does not overwrite a database owned by another agent', async () => {
    const {
      getAuthProfilesSqlitePath,
      writeAuthProfilesToSqlite,
    } = await import('@electron/utils/openclaw-auth-sqlite');
    const sqlitePath = getAuthProfilesSqlitePath('main');
    await mkdir(join(sqlitePath, '..'), { recursive: true });
    const db = new DatabaseSync(sqlitePath);
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_meta (
        meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
      ) VALUES ('primary', 'agent', 1, 'worker', NULL, 1, 1);
    `);
    db.close();

    expect(() => writeAuthProfilesToSqlite({
      version: 1,
      profiles: {},
    }, 'main')).toThrow('different owner');

    const verifyDb = new DatabaseSync(sqlitePath, { readOnly: true });
    const owner = verifyDb.prepare(
      `SELECT agent_id FROM schema_meta WHERE meta_key = 'primary'`,
    ).get() as { agent_id: string };
    expect(owner.agent_id).toBe('worker');
    expect(verifyDb.prepare(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'auth_profile_store'`,
    ).get()).toBeUndefined();
    verifyDb.close();
  });
});
