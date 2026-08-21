// @vitest-environment node

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { toSqlitePath } from '@electron/utils/sqlite-path';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('toSqlitePath', () => {
  it('converts Windows drive and UNC paths while preserving SQLite special locations', () => {
    expect(toSqlitePath('C:\\portable\\state\\openclaw.sqlite', 'win32'))
      .toBe('\\\\?\\C:\\portable\\state\\openclaw.sqlite');
    expect(toSqlitePath('\\\\server\\share\\openclaw.sqlite', 'win32'))
      .toBe('\\\\?\\UNC\\server\\share\\openclaw.sqlite');
    expect(toSqlitePath('\\\\?\\C:\\portable\\state\\openclaw.sqlite', 'win32'))
      .toBe('\\\\?\\C:\\portable\\state\\openclaw.sqlite');
    expect(toSqlitePath(':memory:', 'win32')).toBe(':memory:');
    expect(toSqlitePath('file:C:/portable/state/openclaw.sqlite', 'win32'))
      .toBe('file:C:/portable/state/openclaw.sqlite');
    expect(toSqlitePath('relative/openclaw.sqlite', 'win32')).toBe('relative/openclaw.sqlite');
    expect(toSqlitePath('C:\\portable\\state\\openclaw.sqlite', 'linux'))
      .toBe('C:\\portable\\state\\openclaw.sqlite');
  });

  it.runIf(process.platform === 'win32')('opens and writes a database beyond MAX_PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-sqlite-long-path-'));
    tempDirs.push(root);
    let databasePath = join(root, 'openclaw.sqlite');
    while (databasePath.length <= 280) {
      databasePath = join(dirname(databasePath), 'portable-runtime-segment', 'openclaw.sqlite');
    }
    await mkdir(dirname(databasePath), { recursive: true });

    const database = new DatabaseSync(toSqlitePath(databasePath));
    try {
      database.exec('CREATE TABLE probe (value TEXT NOT NULL); INSERT INTO probe VALUES (\'ok\');');
      expect(database.prepare('SELECT value FROM probe').get()).toEqual({ value: 'ok' });
    } finally {
      database.close();
    }
  });
});
