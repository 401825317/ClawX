/**
 * OpenClaw 2026.6+ persists agent auth in openclaw-agent.sqlite.
 * ClawX historically wrote auth-profiles.json only; gateway runtime reads SQLite.
 */
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { access, readFile } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { DatabaseSync } from 'node:sqlite';

const AUTH_PROFILE_FILENAME = 'auth-profiles.json';
const AUTH_SQLITE_FILENAME = 'openclaw-agent.sqlite';
const PRIMARY_ROW_KEY = 'primary';
const SCHEMA_VERSION = 1;
const SQLITE_BUSY_TIMEOUT_MS = 30_000;

const OPENCLAW_AGENT_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS schema_meta (
  meta_key TEXT NOT NULL PRIMARY KEY,
  role TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  agent_id TEXT,
  app_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_entries (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT,
  blob BLOB,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_cache_expiry
  ON cache_entries(scope, expires_at, key)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_cache_updated
  ON cache_entries(scope, updated_at DESC, key);

CREATE TABLE IF NOT EXISTS auth_profile_store (
  store_key TEXT NOT NULL PRIMARY KEY,
  store_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_profile_state (
  state_key TEXT NOT NULL PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export interface PersistedAuthProfileCredential {
  type: string;
  provider: string;
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  email?: string;
  projectId?: string;
  [extra: string]: unknown;
}

export interface PersistedAuthProfilesStore {
  version: number;
  profiles: Record<string, PersistedAuthProfileCredential>;
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
  usageStats?: Record<string, unknown>;
}

export interface AuthProfileStorePrimaryRowSnapshot {
  storeKey: string;
  storeJson: string;
  updatedAt: number;
}

export interface AuthProfileStatePrimaryRowSnapshot {
  stateKey: string;
  stateJson: string;
  updatedAt: number;
}

interface AuthProfileSqliteRowVersion {
  exists: boolean;
  jsonHash?: string;
  updatedAt?: number;
}

interface AuthProfilesSqliteRowsVersion {
  store: AuthProfileSqliteRowVersion;
  state: AuthProfileSqliteRowVersion;
}

export interface AuthProfilesSqlitePrimaryRowsSnapshot {
  agentId: string;
  sqlitePath: string;
  databaseExisted: boolean;
  storeRow: AuthProfileStorePrimaryRowSnapshot | null;
  stateRow: AuthProfileStatePrimaryRowSnapshot | null;
  parsedStore: PersistedAuthProfilesStore | null;
  managedWriteGuarded?: boolean;
  appliedRows?: AuthProfilesSqliteRowsVersion;
}

function getAgentAuthDir(agentId: string): string {
  return join(homedir(), '.openclaw', 'agents', agentId, 'agent');
}

export function getAuthProfilesJsonPath(agentId: string): string {
  return join(getAgentAuthDir(agentId), AUTH_PROFILE_FILENAME);
}

export function getAuthProfilesSqlitePath(agentId: string): string {
  return join(getAgentAuthDir(agentId), AUTH_SQLITE_FILENAME);
}

function ensureAgentAuthDir(agentId: string): void {
  const dir = getAgentAuthDir(agentId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    applyPrivateMode(dir, 0o700);
  }
}

function applyPrivateMode(target: string, mode: number): void {
  try {
    chmodSync(target, mode);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    const unsupported = code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EINVAL';
    const alreadyPrivate = code === 'EPERM' && (statSync(target).mode & 0o077) === 0;
    if (!unsupported && !alreadyPrivate) throw cause;
    console.warn(`Skipped permission hardening for ${target}: filesystem does not support POSIX modes`);
  }
}

function ensureDatabaseSchema(db: DatabaseSync, agentId: string): void {
  const versionRow = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const currentVersion = versionRow?.user_version ?? 0;
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(`Unsupported future OpenClaw agent database schema version ${currentVersion}`);
  }

  if (sqliteTableExists(db, 'schema_meta')) {
    const owner = db.prepare(`
      SELECT role, schema_version, agent_id
      FROM schema_meta
      WHERE meta_key = ?
    `).get(PRIMARY_ROW_KEY) as {
      role: string;
      schema_version: number;
      agent_id: string | null;
    } | undefined;
    if (owner?.schema_version && owner.schema_version > SCHEMA_VERSION) {
      throw new Error(`Unsupported future OpenClaw agent schema_meta version ${owner.schema_version}`);
    }
    if (owner && (owner.role !== 'agent' || (owner.agent_id !== null && owner.agent_id !== agentId))) {
      throw new Error(`OpenClaw agent database belongs to a different owner than "${agentId}"`);
    }
  }

  db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  if (currentVersion < SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }
  const now = Date.now();
  db.prepare(`
    INSERT INTO schema_meta (
      meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
    ) VALUES (?, 'agent', ?, ?, NULL, ?, ?)
    ON CONFLICT(meta_key) DO UPDATE SET
      role = excluded.role,
      schema_version = excluded.schema_version,
      agent_id = excluded.agent_id,
      updated_at = excluded.updated_at
  `).run(PRIMARY_ROW_KEY, SCHEMA_VERSION, agentId, now, now);
}

function runSqliteTransaction<T>(
  db: DatabaseSync,
  beginStatement: 'BEGIN DEFERRED;' | 'BEGIN IMMEDIATE;',
  description: string,
  task: () => T,
): T {
  db.exec(beginStatement);
  try {
    const result = task();
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK;');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], description, { cause: rollbackError });
    }
    throw new Error(description, { cause: error });
  }
}

function tightenDatabasePermissions(sqlitePath: string): void {
  if (process.platform !== 'win32') {
    applyPrivateMode(sqlitePath, 0o600);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${sqlitePath}${suffix}`;
      if (existsSync(sidecar)) {
        applyPrivateMode(sidecar, 0o600);
      }
    }
  }
}

function parseJsonCell(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function coerceAuthProfilesStore(raw: Record<string, unknown> | null): PersistedAuthProfilesStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const profiles = raw.profiles;
  if (!profiles || typeof profiles !== 'object') return null;
  const version = typeof raw.version === 'number' ? raw.version : 1;
  const store: PersistedAuthProfilesStore = {
    version,
    profiles: profiles as Record<string, PersistedAuthProfileCredential>,
  };
  if (raw.order && typeof raw.order === 'object') {
    store.order = raw.order as Record<string, string[]>;
  }
  if (raw.lastGood && typeof raw.lastGood === 'object') {
    store.lastGood = raw.lastGood as Record<string, string>;
  }
  if (raw.usageStats && typeof raw.usageStats === 'object') {
    store.usageStats = raw.usageStats as Record<string, unknown>;
  }
  return store;
}

function buildSecretsPayload(store: PersistedAuthProfilesStore): Record<string, unknown> {
  return {
    version: store.version ?? 1,
    profiles: store.profiles,
  };
}

function buildStatePayload(store: PersistedAuthProfilesStore): Record<string, unknown> | null {
  if (!store.order && !store.lastGood && !store.usageStats) {
    return null;
  }
  return {
    version: 1,
    ...(store.order ? { order: store.order } : {}),
    ...(store.lastGood ? { lastGood: store.lastGood } : {}),
    ...(store.usageStats ? { usageStats: store.usageStats } : {}),
  };
}

function jsonFingerprint(json: string): string {
  return createHash('sha256').update(json).digest('hex');
}

/** Enable compare-and-swap semantics for a managed auth write and its rollback. */
export function guardManagedAuthProfilesSqliteWrite(
  snapshot: AuthProfilesSqlitePrimaryRowsSnapshot,
): void {
  snapshot.managedWriteGuarded = true;
}

function mergeStoreAndState(
  secrets: Record<string, unknown> | null,
  state: Record<string, unknown> | null,
): PersistedAuthProfilesStore | null {
  const base = coerceAuthProfilesStore(secrets);
  if (!base) return null;
  if (!state) return base;
  if (state.order && typeof state.order === 'object') {
    base.order = state.order as Record<string, string[]>;
  }
  if (state.lastGood && typeof state.lastGood === 'object') {
    base.lastGood = state.lastGood as Record<string, string>;
  }
  if (state.usageStats && typeof state.usageStats === 'object') {
    base.usageStats = state.usageStats as Record<string, unknown>;
  }
  return base;
}

function hasPersistedProfiles(store: PersistedAuthProfilesStore | null | undefined): boolean {
  return !!store && Object.keys(store.profiles).length > 0;
}

function openAgentDatabase(agentId: string, sqlitePath: string): DatabaseSync {
  ensureAgentAuthDir(agentId);
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    db.exec('PRAGMA foreign_keys = ON;');
    ensureDatabaseSchema(db, agentId);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function sqliteTableExists(db: DatabaseSync, tableName: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(tableName));
}

interface AuthProfilesSqlitePrimaryRows {
  storeRow: AuthProfileStorePrimaryRowSnapshot | null;
  stateRow: AuthProfileStatePrimaryRowSnapshot | null;
}

function readAuthProfilesSqlitePrimaryRows(db: DatabaseSync): AuthProfilesSqlitePrimaryRows {
  const rawStoreRow = sqliteTableExists(db, 'auth_profile_store')
    ? db.prepare(`
        SELECT store_key, store_json, updated_at
        FROM auth_profile_store
        WHERE store_key = ?
      `).get(PRIMARY_ROW_KEY) as {
        store_key: string;
        store_json: string;
        updated_at: number;
      } | undefined
    : undefined;
  const rawStateRow = sqliteTableExists(db, 'auth_profile_state')
    ? db.prepare(`
        SELECT state_key, state_json, updated_at
        FROM auth_profile_state
        WHERE state_key = ?
      `).get(PRIMARY_ROW_KEY) as {
        state_key: string;
        state_json: string;
        updated_at: number;
      } | undefined
    : undefined;
  return {
    storeRow: rawStoreRow ? {
      storeKey: rawStoreRow.store_key,
      storeJson: rawStoreRow.store_json,
      updatedAt: rawStoreRow.updated_at,
    } : null,
    stateRow: rawStateRow ? {
      stateKey: rawStateRow.state_key,
      stateJson: rawStateRow.state_json,
      updatedAt: rawStateRow.updated_at,
    } : null,
  };
}

function authProfileRowVersion(
  row: AuthProfileStorePrimaryRowSnapshot | AuthProfileStatePrimaryRowSnapshot | null,
): AuthProfileSqliteRowVersion {
  if (!row) return { exists: false };
  const json = 'storeJson' in row ? row.storeJson : row.stateJson;
  return {
    exists: true,
    jsonHash: jsonFingerprint(json),
    updatedAt: row.updatedAt,
  };
}

function authProfilesRowsVersion(rows: AuthProfilesSqlitePrimaryRows): AuthProfilesSqliteRowsVersion {
  return {
    store: authProfileRowVersion(rows.storeRow),
    state: authProfileRowVersion(rows.stateRow),
  };
}

function sameRowVersion(left: AuthProfileSqliteRowVersion, right: AuthProfileSqliteRowVersion): boolean {
  return left.exists === right.exists
    && left.jsonHash === right.jsonHash
    && left.updatedAt === right.updatedAt;
}

function sameRowsVersion(left: AuthProfilesSqliteRowsVersion, right: AuthProfilesSqliteRowsVersion): boolean {
  return sameRowVersion(left.store, right.store) && sameRowVersion(left.state, right.state);
}

function snapshotRowsVersion(snapshot: AuthProfilesSqlitePrimaryRowsSnapshot): AuthProfilesSqliteRowsVersion {
  return authProfilesRowsVersion({
    storeRow: snapshot.storeRow,
    stateRow: snapshot.stateRow,
  });
}

/** Snapshot the exact primary auth rows without creating or modifying the SQLite database. */
export function snapshotAuthProfilesSqlitePrimaryRows(
  agentId: string,
): AuthProfilesSqlitePrimaryRowsSnapshot {
  const sqlitePath = getAuthProfilesSqlitePath(agentId);
  if (!existsSync(sqlitePath)) {
    return {
      agentId,
      sqlitePath,
      databaseExisted: false,
      storeRow: null,
      stateRow: null,
      parsedStore: null,
    };
  }

  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    return runSqliteTransaction(
      db,
      'BEGIN DEFERRED;',
      `Failed to snapshot auth profile rows for agent "${agentId}"`,
      () => {
        const rawStoreRow = sqliteTableExists(db, 'auth_profile_store')
          ? db.prepare(`
              SELECT store_key, store_json, updated_at
              FROM auth_profile_store
              WHERE store_key = ?
            `).get(PRIMARY_ROW_KEY) as {
              store_key: string;
              store_json: string;
              updated_at: number;
            } | undefined
          : undefined;
        const rawStateRow = sqliteTableExists(db, 'auth_profile_state')
          ? db.prepare(`
              SELECT state_key, state_json, updated_at
              FROM auth_profile_state
              WHERE state_key = ?
            `).get(PRIMARY_ROW_KEY) as {
              state_key: string;
              state_json: string;
              updated_at: number;
            } | undefined
          : undefined;
        const storeRow = rawStoreRow ? {
          storeKey: rawStoreRow.store_key,
          storeJson: rawStoreRow.store_json,
          updatedAt: rawStoreRow.updated_at,
        } : null;
        const stateRow = rawStateRow ? {
          stateKey: rawStateRow.state_key,
          stateJson: rawStateRow.state_json,
          updatedAt: rawStateRow.updated_at,
        } : null;
        return {
          agentId,
          sqlitePath,
          databaseExisted: true,
          storeRow,
          stateRow,
          parsedStore: mergeStoreAndState(
            parseJsonCell(storeRow?.storeJson),
            parseJsonCell(stateRow?.stateJson),
          ),
        };
      },
    );
  } finally {
    db.close();
  }
}

function restoreAuthProfileStoreRow(
  db: DatabaseSync,
  row: AuthProfileStorePrimaryRowSnapshot | null,
): void {
  if (!row) {
    if (sqliteTableExists(db, 'auth_profile_store')) {
      db.prepare('DELETE FROM auth_profile_store WHERE store_key = ?').run(PRIMARY_ROW_KEY);
    }
    return;
  }

  db.prepare(`
    INSERT INTO auth_profile_store (store_key, store_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(store_key) DO UPDATE SET
      store_json = excluded.store_json,
      updated_at = excluded.updated_at
  `).run(row.storeKey, row.storeJson, row.updatedAt);
}

function restoreAuthProfileStateRow(
  db: DatabaseSync,
  row: AuthProfileStatePrimaryRowSnapshot | null,
): void {
  if (!row) {
    if (sqliteTableExists(db, 'auth_profile_state')) {
      db.prepare('DELETE FROM auth_profile_state WHERE state_key = ?').run(PRIMARY_ROW_KEY);
    }
    return;
  }

  db.prepare(`
    INSERT INTO auth_profile_state (state_key, state_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `).run(row.stateKey, row.stateJson, row.updatedAt);
}

function removeCreatedSqliteDatabase(snapshot: AuthProfilesSqlitePrimaryRowsSnapshot): void {
  if (!snapshot.managedWriteGuarded) {
    throw new Error(`Missing rollback guard for newly created auth database for agent "${snapshot.agentId}"`);
  }

  const db = new DatabaseSync(snapshot.sqlitePath);
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    runSqliteTransaction(
      db,
      'BEGIN IMMEDIATE;',
      `Failed to verify transaction-created auth database for agent "${snapshot.agentId}"`,
      () => {
        const current = authProfilesRowsVersion(readAuthProfilesSqlitePrimaryRows(db));
        const before = snapshotRowsVersion(snapshot);
        const expected = snapshot.appliedRows ?? before;
        if (!sameRowsVersion(current, expected) && !sameRowsVersion(current, before)) {
          throw new Error(`Refusing to delete concurrently changed auth database for agent "${snapshot.agentId}"`);
        }
      },
    );
  } finally {
    db.close();
  }

  const failures: Error[] = [];
  for (const filePath of [snapshot.sqlitePath, `${snapshot.sqlitePath}-wal`, `${snapshot.sqlitePath}-shm`]) {
    try {
      unlinkSync(filePath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        failures.push(new Error(`Failed to remove transaction-created SQLite file at ${filePath}`, { cause }));
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to remove transaction-created auth database for agent "${snapshot.agentId}"`);
  }
}

/** Restore only the captured primary auth rows, preserving the surrounding SQLite database. */
export function restoreAuthProfilesSqlitePrimaryRows(
  snapshot: AuthProfilesSqlitePrimaryRowsSnapshot,
): void {
  const databaseExists = existsSync(snapshot.sqlitePath);
  if (snapshot.managedWriteGuarded && snapshot.databaseExisted && !snapshot.appliedRows) {
    return;
  }
  if (!databaseExists) {
    if (!snapshot.databaseExisted) return;
    if (snapshot.managedWriteGuarded) {
      throw new Error(`Managed auth database disappeared before rollback for agent "${snapshot.agentId}"`);
    }
  } else if (!snapshot.databaseExisted) {
    removeCreatedSqliteDatabase(snapshot);
    return;
  }

  const db = databaseExists
    ? new DatabaseSync(snapshot.sqlitePath)
    : openAgentDatabase(snapshot.agentId, snapshot.sqlitePath);
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    db.exec('PRAGMA foreign_keys = ON;');
    if (
      (snapshot.storeRow && !sqliteTableExists(db, 'auth_profile_store'))
      || (snapshot.stateRow && !sqliteTableExists(db, 'auth_profile_state'))
    ) {
      ensureDatabaseSchema(db, snapshot.agentId);
    }

    runSqliteTransaction(
      db,
      'BEGIN IMMEDIATE;',
      `Failed to restore auth profile rows for agent "${snapshot.agentId}"`,
      () => {
        if (snapshot.managedWriteGuarded && snapshot.appliedRows) {
          const current = authProfilesRowsVersion(readAuthProfilesSqlitePrimaryRows(db));
          const before = snapshotRowsVersion(snapshot);
          if (sameRowsVersion(current, before)) return;
          if (!sameRowsVersion(current, snapshot.appliedRows)) {
            throw new Error(`Refusing to overwrite concurrently changed auth rows for agent "${snapshot.agentId}"`);
          }
        }
        restoreAuthProfileStoreRow(db, snapshot.storeRow);
        restoreAuthProfileStateRow(db, snapshot.stateRow);
      },
    );
  } finally {
    db.close();
    tightenDatabasePermissions(snapshot.sqlitePath);
  }
}

export function readAuthProfilesFromSqlite(agentId: string): PersistedAuthProfilesStore | null {
  const sqlitePath = getAuthProfilesSqlitePath(agentId);
  if (!existsSync(sqlitePath)) {
    return null;
  }

  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    const storeRow = db.prepare(
      'SELECT store_json FROM auth_profile_store WHERE store_key = ?',
    ).get(PRIMARY_ROW_KEY) as { store_json?: string } | undefined;
    const stateRow = db.prepare(
      'SELECT state_json FROM auth_profile_state WHERE state_key = ?',
    ).get(PRIMARY_ROW_KEY) as { state_json?: string } | undefined;
    return mergeStoreAndState(
      parseJsonCell(storeRow?.store_json),
      parseJsonCell(stateRow?.state_json),
    );
  } catch (error) {
    console.warn(`Failed to read auth profiles from SQLite (${sqlitePath}):`, error);
    return null;
  } finally {
    db.close();
  }
}

export function writeAuthProfilesToSqlite(
  store: PersistedAuthProfilesStore,
  agentId: string,
  managedSnapshot?: AuthProfilesSqlitePrimaryRowsSnapshot,
): void {
  if (managedSnapshot && managedSnapshot.agentId !== agentId) {
    throw new Error(`Managed auth snapshot does not belong to agent "${agentId}"`);
  }
  if (managedSnapshot && !managedSnapshot.managedWriteGuarded) {
    throw new Error(`Managed auth snapshot is not guarded for agent "${agentId}"`);
  }
  const sqlitePath = getAuthProfilesSqlitePath(agentId);
  const db = openAgentDatabase(agentId, sqlitePath);
  try {
    const appliedRows = runSqliteTransaction(
      db,
      'BEGIN IMMEDIATE;',
      `Failed to write auth profile rows for agent "${agentId}"`,
      () => {
        if (managedSnapshot) {
          const current = authProfilesRowsVersion(readAuthProfilesSqlitePrimaryRows(db));
          if (!sameRowsVersion(current, snapshotRowsVersion(managedSnapshot))) {
            throw new Error(`Auth profile rows changed after snapshot for agent "${agentId}"`);
          }
        }

        const now = Date.now();
        const secretsPayload = JSON.stringify(buildSecretsPayload(store));
        db.prepare(`
          INSERT INTO auth_profile_store (store_key, store_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(store_key) DO UPDATE SET
            store_json = excluded.store_json,
            updated_at = excluded.updated_at
        `).run(PRIMARY_ROW_KEY, secretsPayload, now);

        const statePayload = buildStatePayload(store);
        if (statePayload) {
          db.prepare(`
            INSERT INTO auth_profile_state (state_key, state_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(state_key) DO UPDATE SET
              state_json = excluded.state_json,
              updated_at = excluded.updated_at
          `).run(PRIMARY_ROW_KEY, JSON.stringify(statePayload), now);
        } else {
          db.prepare('DELETE FROM auth_profile_state WHERE state_key = ?').run(PRIMARY_ROW_KEY);
        }
        return authProfilesRowsVersion(readAuthProfilesSqlitePrimaryRows(db));
      },
    );
    if (managedSnapshot) managedSnapshot.appliedRows = appliedRows;
  } finally {
    db.close();
    tightenDatabasePermissions(sqlitePath);
  }
}

export async function readAuthProfilesJson(agentId: string): Promise<PersistedAuthProfilesStore | null> {
  const jsonPath = getAuthProfilesJsonPath(agentId);
  try {
    await access(jsonPath, constants.F_OK);
    const raw = JSON.parse(await readFile(jsonPath, 'utf-8')) as Record<string, unknown>;
    return coerceAuthProfilesStore(raw);
  } catch {
    return null;
  }
}

export async function migrateAuthProfilesJsonToSqliteIfNeeded(agentId: string): Promise<boolean> {
  const sqliteStore = readAuthProfilesFromSqlite(agentId);
  if (hasPersistedProfiles(sqliteStore)) {
    return false;
  }

  const jsonStore = await readAuthProfilesJson(agentId);
  if (!hasPersistedProfiles(jsonStore)) {
    return false;
  }

  writeAuthProfilesToSqlite(jsonStore!, agentId);
  console.log(
    `[auth-sync] Migrated auth-profiles.json to SQLite for agent "${agentId}"`,
  );
  return true;
}
