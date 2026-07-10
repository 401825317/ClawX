import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireProcessInstanceFileLock,
  resolveGlobalProcessInstanceLockDir,
} from '@electron/main/process-instance-lock';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'clawx-instance-lock-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('process instance file lock', () => {
  it('acquires lock and writes owner pid', () => {
    const lockDir = createTempDir();
    const lock = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'clawx',
      pid: 12345,
    });

    const lockPath = join(lockDir, 'clawx.instance.lock');
    expect(lock.acquired).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe('12345');

    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('rejects a second lock when owner pid is alive', () => {
    const lockDir = createTempDir();
    const first = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'clawx',
      pid: 2222,
      isPidAlive: () => true,
    });

    const second = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'clawx',
      pid: 3333,
      isPidAlive: () => true,
    });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    expect(second.ownerPid).toBe(2222);
    expect(second.ownerFormat).toBe('legacy');

    first.release();
  });

  it('replaces stale lock file when owner pid is not alive', () => {
    const lockDir = createTempDir();
    const lockPath = join(lockDir, 'clawx.instance.lock');
    writeFileSync(lockPath, '4444', 'utf8');

    const lock = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'clawx',
      pid: 5555,
      isPidAlive: () => false,
    });

    expect(lock.acquired).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe('5555');
    lock.release();
  });

  it('replaces stale structured lock file when owner pid is not alive', () => {
    const lockDir = createTempDir();
    const lockPath = join(lockDir, 'clawx.instance.lock');
    writeFileSync(lockPath, JSON.stringify({
      schema: 'clawx-instance-lock',
      version: 1,
      pid: 7777,
    }), 'utf8');

    const lock = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'clawx',
      pid: 6666,
      isPidAlive: () => false,
    });

    expect(lock.acquired).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe('6666');
    lock.release();
  });

  it('does not treat malformed lock file content as stale', () => {
    const lockDir = createTempDir();
    const lockPath = join(lockDir, 'clawx.instance.lock');
    writeFileSync(lockPath, 'not-a-pid', 'utf8');

    const lock = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'clawx',
      pid: 6666,
    });

    expect(lock.acquired).toBe(false);
    expect(lock.ownerPid).toBeUndefined();
    expect(lock.ownerFormat).toBe('unknown');
    expect(readFileSync(lockPath, 'utf8')).toBe('not-a-pid');
  });

  it('does not remove lock file if ownership changed before release', () => {
    const lockDir = createTempDir();
    const lockPath = join(lockDir, 'clawx.instance.lock');
    const first = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'clawx',
      pid: 1234,
    });

    // Simulate a new process acquiring the lock after a handover race.
    writeFileSync(lockPath, '9999', 'utf8');
    first.release();

    expect(readFileSync(lockPath, 'utf8')).toBe('9999');
  });

  it('does not treat unknown structured lock schema as stale', () => {
    const lockDir = createTempDir();
    const lockPath = join(lockDir, 'clawx.instance.lock');
    writeFileSync(lockPath, JSON.stringify({
      schema: 'future-lock-schema',
      version: 2,
      pid: 8888,
      owner: 'future-build',
    }), 'utf8');

    const lock = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'clawx',
      pid: 9999,
    });

    expect(lock.acquired).toBe(false);
    expect(lock.ownerPid).toBeUndefined();
    expect(lock.ownerFormat).toBe('unknown');
    expect(readFileSync(lockPath, 'utf8')).toContain('future-lock-schema');
  });

  it('shares one OS-user app lock across different portable userData directories', () => {
    const appDataDir = createTempDir();
    const portableUserDataA = createTempDir();
    const portableUserDataB = createTempDir();
    const lockDir = resolveGlobalProcessInstanceLockDir(appDataDir);

    expect(lockDir.startsWith(portableUserDataA)).toBe(false);
    expect(lockDir.startsWith(portableUserDataB)).toBe(false);

    const first = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'app.clawx.desktop',
      pid: 14736,
      isPidAlive: () => true,
    });
    const second = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'app.clawx.desktop',
      pid: 15555,
      isPidAlive: () => true,
    });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    expect(second.lockPath).toBe(first.lockPath);
    expect(second.ownerPid).toBe(14736);
    first.release();
  });

  it('keeps different app identities independent within the same OS-user lock directory', () => {
    const lockDir = resolveGlobalProcessInstanceLockDir(createTempDir());
    const uclaw = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'app.clawx.desktop',
      pid: 1001,
    });
    const otherApp = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'other.desktop.app',
      pid: 1002,
    });

    expect(uclaw.acquired).toBe(true);
    expect(otherApp.acquired).toBe(true);
    expect(otherApp.lockPath).not.toBe(uclaw.lockPath);
    uclaw.release();
    otherApp.release();
  });
});
