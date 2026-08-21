// @vitest-environment node

import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalPlatform = process.platform;
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock('electron', () => ({
  app: { getPath: () => process.env.UCLAW_OWNERSHIP_TEST_DIR },
}));

vi.mock('node:child_process', () => ({ execFile: mockExecFile }));

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, writable: true });
}

describe('Gateway ownership record', () => {
  let userData = '';

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    userData = await mkdtemp(path.join(os.tmpdir(), 'uclaw-gateway-ownership-'));
    process.env.UCLAW_OWNERSHIP_TEST_DIR = userData;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    delete process.env.UCLAW_OWNERSHIP_TEST_DIR;
    await rm(userData, { recursive: true, force: true });
  });

  it('reclaims a structured lock immediately when its PID is dead', async () => {
    const deadPid = 2147483647;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === deadPid && signal === 0) {
        throw Object.assign(new Error('process is gone'), { code: 'ESRCH' });
      }
      return true;
    });
    const lockPath = path.join(userData, 'gateway-ownership.json.lock');
    await writeFile(lockPath, `${JSON.stringify({
      pid: deadPid,
      createdAt: Date.now(),
      nonce: 'dead-lock-1234',
    })}\n`, 'utf8');

    const ownership = await import('@electron/gateway/gateway-ownership');
    const record = await ownership.createGatewayOwnershipRecord({
      pid: 4321,
      processCreationIdentity: 'creation-4321',
      runtimeRoot: userData,
      tokenHash: 'a'.repeat(64),
      launchNonce: 'nonce-dead-lock-1234',
    });

    await expect(ownership.writeGatewayOwnershipRecord(record)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith(deadPid, 0);
    await expect(ownership.readGatewayOwnershipRecord()).resolves.toMatchObject({ pid: 4321 });
  });

  it('does not reclaim a fresh lock owned by a live PID', async () => {
    let resolveProbe!: () => void;
    const probed = new Promise<void>((resolve) => {
      resolveProbe = resolve;
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === process.pid && signal === 0) resolveProbe();
      return true;
    });
    const lockPath = path.join(userData, 'gateway-ownership.json.lock');
    const lockBody = `${JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      nonce: 'live-lock-1234',
    })}\n`;
    await writeFile(lockPath, lockBody, 'utf8');

    const ownership = await import('@electron/gateway/gateway-ownership');
    const record = await ownership.createGatewayOwnershipRecord({
      pid: 4321,
      processCreationIdentity: 'creation-4321',
      runtimeRoot: userData,
      tokenHash: 'a'.repeat(64),
      launchNonce: 'nonce-live-lock-1234',
    });
    const pendingWrite = ownership.writeGatewayOwnershipRecord(record);

    await probed;
    await expect(readFile(lockPath, 'utf8')).resolves.toBe(lockBody);
    await unlink(lockPath);
    await expect(pendingWrite).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith(process.pid, 0);
  });

  it('accepts and reclaims the legacy plain-PID lock format', async () => {
    const deadPid = 2147483646;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === deadPid && signal === 0) {
        throw Object.assign(new Error('process is gone'), { code: 'ESRCH' });
      }
      return true;
    });
    const lockPath = path.join(userData, 'gateway-ownership.json.lock');
    await writeFile(lockPath, `${deadPid}\n`, 'utf8');

    const ownership = await import('@electron/gateway/gateway-ownership');
    const record = await ownership.createGatewayOwnershipRecord({
      pid: 4321,
      processCreationIdentity: 'creation-4321',
      runtimeRoot: userData,
      tokenHash: 'a'.repeat(64),
      launchNonce: 'nonce-legacy-lock-1234',
    });

    await expect(ownership.writeGatewayOwnershipRecord(record)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith(deadPid, 0);
    await expect(ownership.readGatewayOwnershipRecord()).resolves.toMatchObject({ pid: 4321 });
  });

  it('uses lock age as a fallback when the PID probe is inconclusive', async () => {
    const pid = process.pid;
    vi.spyOn(process, 'kill').mockImplementation((candidatePid, signal) => {
      if (candidatePid === pid && signal === 0) {
        throw Object.assign(new Error('access denied'), { code: 'EPERM' });
      }
      return true;
    });
    const lockPath = path.join(userData, 'gateway-ownership.json.lock');
    await writeFile(lockPath, `${JSON.stringify({
      pid,
      createdAt: Date.now() - 5 * 60_000,
      nonce: 'old-lock-1234',
    })}\n`, 'utf8');

    const ownership = await import('@electron/gateway/gateway-ownership');
    const record = await ownership.createGatewayOwnershipRecord({
      pid: 4321,
      processCreationIdentity: 'creation-4321',
      runtimeRoot: userData,
      tokenHash: 'a'.repeat(64),
      launchNonce: 'nonce-old-lock-1234',
    });

    await expect(ownership.writeGatewayOwnershipRecord(record)).resolves.toBeUndefined();
    await expect(ownership.readGatewayOwnershipRecord()).resolves.toMatchObject({ pid: 4321 });
  });

  it('atomically persists only opaque token data and refuses to clear a mismatched newer record', async () => {
    const ownership = await import('@electron/gateway/gateway-ownership');
    const record = await ownership.createGatewayOwnershipRecord({
      pid: 4321,
      processCreationIdentity: 'creation-4321',
      runtimeRoot: userData,
      token: 'secret-token-must-not-hit-disk',
      launchNonce: 'nonce-test-1234',
    });
    await ownership.writeGatewayOwnershipRecord(record);

    const raw = await readFile(path.join(userData, 'gateway-ownership.json'), 'utf8');
    expect(raw).not.toContain('secret-token-must-not-hit-disk');
    expect(JSON.parse(raw)).toMatchObject({ pid: 4321, tokenHash: ownership.hashGatewayToken('secret-token-must-not-hit-disk') });
    expect(await readdir(userData)).toEqual(['gateway-ownership.json']);

    await expect(ownership.clearGatewayOwnershipRecordIfMatches({
      ...record,
      launchNonce: 'newer-nonce-1234',
    })).resolves.toBe(false);
    expect(await ownership.readGatewayOwnershipRecord()).toMatchObject({ launchNonce: 'nonce-test-1234' });

    await expect(ownership.clearGatewayOwnershipRecordIfMatches(record)).resolves.toBe(true);
    await expect(ownership.readGatewayOwnershipRecord()).resolves.toBeNull();
  });

  it('serializes old cleanup with a new canonical write without moving or deleting the new record', async () => {
    const ownership = await import('@electron/gateway/gateway-ownership');
    const oldRecord = await ownership.createGatewayOwnershipRecord({
      pid: 4321,
      processCreationIdentity: 'creation-old',
      runtimeRoot: userData,
      tokenHash: 'a'.repeat(64),
      launchNonce: 'nonce-old-1234',
    });
    const newRecord = await ownership.createGatewayOwnershipRecord({
      pid: 5432,
      processCreationIdentity: 'creation-new',
      runtimeRoot: userData,
      tokenHash: 'b'.repeat(64),
      launchNonce: 'nonce-new-1234',
    });
    await ownership.writeGatewayOwnershipRecord(oldRecord);

    await Promise.all([
      ownership.clearGatewayOwnershipRecordIfMatches(oldRecord),
      ownership.writeGatewayOwnershipRecord(newRecord),
    ]);

    await expect(ownership.readGatewayOwnershipRecord()).resolves.toMatchObject({
      pid: newRecord.pid,
      launchNonce: newRecord.launchNonce,
    });
    expect(await readdir(userData)).toEqual(['gateway-ownership.json']);
  });

  it('uses SystemRoot PowerShell and returns no identity when the probe fails', async () => {
    setPlatform('win32');
    process.env.SystemRoot = 'C:\\Windows';
    mockExecFile.mockImplementation((file: string, args: string[], options: { env?: NodeJS.ProcessEnv }, callback: (error: Error | null, stdout: string) => void) => {
      const encodedCommandIndex = args.indexOf('-EncodedCommand') + 1;
      const script = Buffer.from(args[encodedCommandIndex], 'base64').toString('utf16le');
      expect(script).toContain('GetProcessTimes');
      expect(script).toContain('CreationIdentity = $nativeCreation.ToString()');
      expect(script).toContain('[UClawGatewayIdentity]::CommandIdentityHash');
      expect(options.env).toMatchObject({ UCLAW_GATEWAY_TARGET_PID: '4321' });
      callback(null, JSON.stringify({
        ProcessId: 4321,
        CreationIdentity: '13371337',
        ExecutablePath: 'C:\\Program Files\\用户\\UClaw.exe',
        CommandLine: '"C:\\Program Files\\用户\\UClaw.exe" gateway --port 18789',
        CommandIdentityHash: 'c'.repeat(64),
      }));
      return {} as never;
    });
    const { inspectWindowsGatewayProcess } = await import('@electron/gateway/gateway-ownership');

    await expect(inspectWindowsGatewayProcess(4321)).resolves.toMatchObject({
      processId: 4321,
      creationIdentity: '13371337',
      commandIdentityHash: 'c'.repeat(64),
    });
    expect(mockExecFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      expect.any(Array),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('binds startup ownership and command identity to the concrete child lifecycle', async () => {
    const ownership = await import('@electron/gateway/gateway-ownership');
    const child = {};
    const record = await ownership.createGatewayOwnershipRecord({
      pid: 4321,
      processCreationIdentity: 'creation-4321',
      runtimeRoot: userData,
      tokenHash: 'a'.repeat(64),
      launchNonce: 'nonce-test-1234',
    });

    ownership.trackOwnedGatewayChild(child);
    ownership.registerOwnedGatewayChildMetadata(child, {
      record,
      processIdentity: {
        processId: 4321,
        creationIdentity: 'creation-4321',
        executablePath: 'C:\\Program Files\\UClaw\\UClaw.exe',
        commandLine: '"C:\\Program Files\\UClaw\\UClaw.exe" gateway --port 18789',
        commandIdentityHash: 'b'.repeat(64),
      },
      port: 18789,
    });

    expect(ownership.getOwnedGatewayChildMetadata(child)).toMatchObject({
      record,
      exited: false,
      port: 18789,
      commandIdentityHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    ownership.markOwnedGatewayChildExited(child);
    expect(ownership.hasOwnedGatewayChildExited(child)).toBe(true);
    expect(ownership.getOwnedGatewayChildMetadata(child)?.exited).toBe(true);
  });

  it('holds a process handle while validating identity and invoking taskkill', async () => {
    setPlatform('win32');
    const executablePath = 'C:\\Program Files\\UClaw\\UClaw.exe';
    const commandLine = `"${executablePath}" gateway --port 18789`;
    const ownership = await import('@electron/gateway/gateway-ownership');
    const commandIdentityHash = ownership.createWindowsProcessCommandIdentityHash({
      commandIdentityHash: 'b'.repeat(64),
    });
    expect(commandIdentityHash).toMatch(/^[a-f0-9]{64}$/u);
    const record = await ownership.createGatewayOwnershipRecord({
      pid: 4321,
      processCreationIdentity: '13371337',
      runtimeRoot: userData,
      tokenHash: 'a'.repeat(64),
      launchNonce: 'nonce-test-1234',
    });
    await ownership.writeGatewayOwnershipRecord(record);
    const expectedRecordHash = createHash('sha256')
      .update(`${JSON.stringify(record)}\n`, 'utf8')
      .digest('hex');

    mockExecFile.mockImplementation((_file: string, args: string[], options: { env?: NodeJS.ProcessEnv }, callback: (error: Error | null, stdout: string) => void) => {
      const encodedCommandIndex = args.indexOf('-EncodedCommand') + 1;
      const script = Buffer.from(args[encodedCommandIndex], 'base64').toString('utf16le');
      expect(script.indexOf('OpenProcess')).toBeLessThan(script.indexOf("& $taskkillPath"));
      expect(script.indexOf('System.IO.FileStream')).toBeLessThan(script.indexOf("& $taskkillPath"));
      expect(script.indexOf("& $taskkillPath")).toBeLessThan(script.lastIndexOf('CloseHandle($handle)'));
      expect(script.indexOf("& $taskkillPath")).toBeLessThan(script.lastIndexOf('$ownershipStream.Dispose()'));
      expect(script).toContain('GetLastWin32Error()');
      expect(script).toContain("Write-UClawResult 'verification_failed'");
      expect(script).toContain('[UClawGatewayIdentity]::CommandIdentityHash');
      expect(args.join(' ')).not.toContain(executablePath);
      expect(args.join(' ')).not.toContain(commandLine);
      expect(options.env).toMatchObject({
        UCLAW_GATEWAY_TARGET_PID: '4321',
        UCLAW_GATEWAY_CREATION_IDENTITY: '13371337',
        UCLAW_GATEWAY_COMMAND_IDENTITY_HASH: commandIdentityHash,
        UCLAW_GATEWAY_OWNERSHIP_PATH: path.join(userData, 'gateway-ownership.json'),
        UCLAW_GATEWAY_OWNERSHIP_RECORD_HASH: expectedRecordHash,
      });
      callback(null, '{"Status":"creation_identity_mismatch"}');
      return {} as never;
    });

    await expect(ownership.terminateWindowsProcessTreeIfOwned({
      record,
      commandIdentityHash: commandIdentityHash!,
    })).resolves.toBe('creation_identity_mismatch');
  });

  it('reports an unverifiable process separately from a missing process', async () => {
    setPlatform('win32');
    const ownership = await import('@electron/gateway/gateway-ownership');
    const record = await ownership.createGatewayOwnershipRecord({
      pid: 4321,
      processCreationIdentity: '13371337',
      runtimeRoot: userData,
      tokenHash: 'a'.repeat(64),
      launchNonce: 'nonce-test-1234',
    });
    mockExecFile.mockImplementation((_file: string, _args: string[], _options: object, callback: (error: Error | null, stdout: string) => void) => {
      callback(null, '{"Status":"verification_failed"}');
      return {} as never;
    });

    await expect(ownership.terminateWindowsProcessTreeIfOwned({
      record,
      commandIdentityHash: 'b'.repeat(64),
    })).resolves.toBe('verification_failed');
  });
});
