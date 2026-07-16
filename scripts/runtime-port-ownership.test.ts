import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listenHttpServer } from '../electron/api/server-listener.ts';
import { acquireProcessInstanceFileLock } from '../electron/main/process-instance-lock.ts';
import {
  buildWindowsProcessInspectionScript,
  isClearlyForeignUClawLockOwner,
  isLikelyUClawRuntimeProcess,
  isProcessDescendantByParentResolver,
  isVerifiedUClawProcess,
} from '../electron/utils/process-inspection.ts';

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('Host API listener rejects EADDRINUSE instead of reporting startup success', async () => {
  const blocker = createServer();
  await listenHttpServer(blocker, 0);
  const address = blocker.address();
  assert.ok(address && typeof address === 'object');

  const candidate = createServer();
  try {
    await assert.rejects(
      listenHttpServer(candidate, address.port),
      (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE',
    );
    assert.equal(candidate.listening, false);
  } finally {
    await closeServer(candidate);
    await closeServer(blocker);
  }
});

test('Host API listener resolves only after the server is listening', async () => {
  const server = createServer();
  try {
    await listenHttpServer(server, 0);
    assert.equal(server.listening, true);
  } finally {
    await closeServer(server);
  }
});

test('Windows process termination requires exact executable and product identity', () => {
  assert.equal(isVerifiedUClawProcess({
    pid: 101,
    name: 'UClaw.exe',
    executablePath: 'C:\\Program Files\\UClaw\\UClaw.exe',
    productName: 'UClaw',
    productVersion: '1.0.2',
  }, 'win32'), true);
  assert.equal(isVerifiedUClawProcess({
    pid: 102,
    name: 'UClaw.exe',
    executablePath: 'C:\\Temp\\UClaw.exe',
  }, 'win32'), false);
  assert.equal(isVerifiedUClawProcess({
    pid: 103,
    name: 'python.exe',
    executablePath: 'C:\\Temp\\uclaw-helper\\python.exe',
    productName: 'Python',
  }, 'win32'), false);
});

test('shared lock stale-owner detection distinguishes PID reuse from UClaw runtime processes', () => {
  assert.equal(isClearlyForeignUClawLockOwner({
    pid: 20868,
    name: 'WmiApSrv.exe',
    executablePath: 'C:\\Windows\\system32\\wbem\\WmiApSrv.exe',
  }, 'win32'), true);
  assert.equal(isLikelyUClawRuntimeProcess({
    pid: 20868,
    name: 'electron.exe',
    executablePath: 'C:\\Users\\me\\project\\node_modules\\.pnpm\\electron@40.8.4\\node_modules\\electron\\dist\\electron.exe',
    productName: 'Electron',
  }, 'win32'), true);
  assert.equal(isClearlyForeignUClawLockOwner({
    pid: 20868,
    name: 'UClaw.exe',
    executablePath: 'C:\\Temp\\UClaw.exe',
  }, 'win32'), false);
});

test('macOS shared lock stale-owner detection preserves app and Electron dev owners', () => {
  assert.equal(isLikelyUClawRuntimeProcess({
    pid: 301,
    executablePath: '/Applications/UClaw.app/Contents/Frameworks/UClaw Helper.app/Contents/MacOS/UClaw Helper',
  }, 'darwin'), true);
  assert.equal(isLikelyUClawRuntimeProcess({
    pid: 302,
    executablePath: '/Users/me/project/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    name: 'Electron',
  }, 'darwin'), true);
  assert.equal(isClearlyForeignUClawLockOwner({
    pid: 303,
    executablePath: '/usr/sbin/cfprefsd',
    name: 'cfprefsd',
  }, 'darwin'), true);
});

test('Windows process inspection emits valid block and hashtable separators', () => {
  const script = buildWindowsProcessInspectionScript(321);
  assert.match(script, /ProcessId = 321/u);
  assert.doesNotMatch(script, /\{\s*;/u);
  assert.doesNotMatch(script, /@\{\s*;/u);
  assert.match(script, /productVersion = \$productVersion;/u);
});

test('macOS verification requires an exact UClaw or ClawX app-bundle executable', () => {
  assert.equal(isVerifiedUClawProcess({
    pid: 201,
    executablePath: '/Applications/UClaw.app/Contents/MacOS/UClaw',
  }, 'darwin'), true);
  assert.equal(isVerifiedUClawProcess({
    pid: 202,
    executablePath: '/tmp/UClaw.app-helper/Contents/MacOS/UClaw',
  }, 'darwin'), false);
});

test('Gateway listener ancestry accepts descendants and rejects cycles', async () => {
  const parents = new Map<number, number>([
    [403, 402],
    [402, 401],
  ]);
  assert.equal(await isProcessDescendantByParentResolver(
    403,
    401,
    async (pid) => parents.get(pid),
  ), true);

  const cycle = new Map<number, number>([
    [501, 502],
    [502, 501],
  ]);
  assert.equal(await isProcessDescendantByParentResolver(
    501,
    599,
    async (pid) => cycle.get(pid),
  ), false);
});

test('Windows installer closes both UClaw.exe and legacy ClawX.exe processes', () => {
  const installer = readFileSync('scripts/installer.nsh', 'utf8');
  const extractPatch = readFileSync('scripts/patch-nsis-extract.mjs', 'utf8');
  assert.match(installer, /!define LEGACY_APP_EXECUTABLE_FILENAME "ClawX\.exe"/u);
  assert.match(installer, /taskkill \/F \/T \/IM "\$\{LEGACY_APP_EXECUTABLE_FILENAME\}"/u);
  assert.match(
    installer,
    /Name -ieq '\$\{APP_EXECUTABLE_FILENAME\}' -or \$\$_\.Name -ieq '\$\{LEGACY_APP_EXECUTABLE_FILENAME\}'/u,
  );
  assert.match(extractPatch, /taskkill \/F \/T \/IM ClawX\.exe/u);
});

test('shared instance lock blocks a live owner and reclaims a stale owner', () => {
  const lockDir = mkdtempSync(join(tmpdir(), 'uclaw-runtime-lock-'));
  try {
    const first = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'uclaw-test',
      pid: 1101,
      isPidAlive: (pid) => pid === 1101,
    });
    assert.equal(first.acquired, true);

    const blocked = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'uclaw-test',
      pid: 1102,
      isPidAlive: (pid) => pid === 1101,
    });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.ownerPid, 1101);
    first.release();

    writeFileSync(first.lockPath, '1101', 'utf8');
    const reclaimed = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'uclaw-test',
      pid: 1102,
      isPidAlive: () => false,
    });
    assert.equal(reclaimed.acquired, true);
    reclaimed.release();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test('shared instance lock never removes unknown or changed ownership content', () => {
  const lockDir = mkdtempSync(join(tmpdir(), 'uclaw-runtime-lock-'));
  try {
    const seed = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'uclaw-test',
      pid: 1201,
      isPidAlive: () => true,
    });
    assert.equal(seed.acquired, true);

    writeFileSync(seed.lockPath, 'unrecognized-owner', 'utf8');
    seed.release();
    assert.equal(readFileSync(seed.lockPath, 'utf8'), 'unrecognized-owner');

    const blocked = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'uclaw-test',
      pid: 1202,
      isPidAlive: () => false,
    });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.ownerFormat, 'unknown');

    rmSync(seed.lockPath, { force: true });
    const changed = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'uclaw-test',
      pid: 1203,
      isPidAlive: () => true,
    });
    assert.equal(changed.acquired, true);
    writeFileSync(changed.lockPath, '1204', 'utf8');
    changed.release();
    assert.equal(readFileSync(changed.lockPath, 'utf8'), '1204');
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});
