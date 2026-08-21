// @vitest-environment node

import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalPlatform = process.platform;
type ProcessExitListener = (code: number) => void;

let processExitListenerBaseline: ProcessExitListener[] = [];

function removeProcessExitListenersAddedSince(
  baseline: readonly ProcessExitListener[],
): void {
  const remainingBaselineCounts = new Map<ProcessExitListener, number>();
  for (const listener of baseline) {
    remainingBaselineCounts.set(listener, (remainingBaselineCounts.get(listener) ?? 0) + 1);
  }

  for (const listener of process.rawListeners('exit') as ProcessExitListener[]) {
    const remainingCount = remainingBaselineCounts.get(listener) ?? 0;
    if (remainingCount > 0) {
      remainingBaselineCounts.set(listener, remainingCount - 1);
      continue;
    }

    process.removeListener('exit', listener);
  }
}

beforeEach(() => {
  processExitListenerBaseline = process.rawListeners('exit') as ProcessExitListener[];
});

afterEach(() => {
  removeProcessExitListenersAddedSince(processExitListenerBaseline);
});

const {
  mockExec,
  mockExecFile,
  mockCreateServer,
  mockGatewayOwnershipRecordsMatch,
  mockGetOwnedGatewayChildMetadata,
  mockHasOwnedGatewayChildExited,
  mockInspectWindowsGatewayProcess,
  mockMarkOwnedGatewayChildExited,
  mockProbeGatewayReady,
  mockReadGatewayOwnershipRecord,
  mockTerminateWindowsProcessTreeIfOwned,
} = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockExecFile: vi.fn(),
  mockCreateServer: vi.fn(),
  mockGatewayOwnershipRecordsMatch: vi.fn(),
  mockGetOwnedGatewayChildMetadata: vi.fn(),
  mockHasOwnedGatewayChildExited: vi.fn(),
  mockInspectWindowsGatewayProcess: vi.fn(),
  mockMarkOwnedGatewayChildExited: vi.fn(),
  mockProbeGatewayReady: vi.fn(),
  mockReadGatewayOwnershipRecord: vi.fn(),
  mockTerminateWindowsProcessTreeIfOwned: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
  },
  utilityProcess: {},
}));

vi.mock('child_process', () => ({
  exec: mockExec,
  execFile: mockExecFile,
  execSync: vi.fn(),
  spawn: vi.fn(),
  default: {
    exec: mockExec,
    execFile: mockExecFile,
    execSync: vi.fn(),
    spawn: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  exec: mockExec,
  execFile: mockExecFile,
}));

vi.mock('net', () => ({
  createServer: mockCreateServer,
}));

vi.mock('@electron/gateway/ws-client', () => ({
  probeGatewayReady: mockProbeGatewayReady,
}));

vi.mock('@electron/gateway/gateway-ownership', () => ({
  gatewayOwnershipRecordsMatch: mockGatewayOwnershipRecordsMatch,
  getOwnedGatewayChildMetadata: mockGetOwnedGatewayChildMetadata,
  hashGatewayToken: (token: string) => `hash:${token}`,
  hasOwnedGatewayChildExited: mockHasOwnedGatewayChildExited,
  inspectWindowsGatewayProcess: mockInspectWindowsGatewayProcess,
  markOwnedGatewayChildExited: mockMarkOwnedGatewayChildExited,
  readGatewayOwnershipRecord: mockReadGatewayOwnershipRecord,
  terminateWindowsProcessTreeIfOwned: mockTerminateWindowsProcessTreeIfOwned,
}));

class MockUtilityChild extends EventEmitter {
  pid?: number;
  kill = vi.fn();

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }
}

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, writable: true });
}

function setOwnedWindowsChildMetadata(pid = 4321) {
  const record = {
    version: 1 as const,
    pid,
    processCreationIdentity: `creation-${pid}`,
    runtimeRoot: 'C:\\UClawRuntime',
    launchNonce: 'nonce-test-1234',
    tokenHash: 'a'.repeat(64),
    createdAt: 1,
  };
  mockGetOwnedGatewayChildMetadata.mockReturnValue({
    record,
    commandIdentityHash: 'b'.repeat(64),
    exited: false,
    port: 18789,
  });
  mockReadGatewayOwnershipRecord.mockResolvedValue(record);
  mockGatewayOwnershipRecordsMatch.mockReturnValue(true);
  return record;
}

describe('gateway supervisor process cleanup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockProbeGatewayReady.mockResolvedValue(false);
    mockGatewayOwnershipRecordsMatch.mockReturnValue(false);
    mockGetOwnedGatewayChildMetadata.mockReturnValue(null);
    mockHasOwnedGatewayChildExited.mockReturnValue(false);
    mockInspectWindowsGatewayProcess.mockResolvedValue(null);
    mockReadGatewayOwnershipRecord.mockResolvedValue(null);
    mockTerminateWindowsProcessTreeIfOwned.mockResolvedValue('terminated');

    mockExec.mockImplementation((_cmd: string, _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      cb(null, '');
      return {} as never;
    });
    mockExecFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      cb(null, '');
      return {} as never;
    });

    mockCreateServer.mockImplementation(() => {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      return {
        once(event: string, callback: (...args: unknown[]) => void) {
          handlers.set(event, callback);
          return this;
        },
        listen() {
          queueMicrotask(() => handlers.get('listening')?.());
          return this;
        },
        close(callback?: () => void) {
          callback?.();
        },
      };
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  it('accepts direct entry only when its parent PID is the current process', async () => {
    const { isExpectedUClawGatewayProcess } = await import('@electron/gateway/supervisor');
    const options = {
      port: 18789,
      currentPid: 9001,
      executablePath: 'C:\\Program Files\\UClaw\\UClaw.exe',
      gatewayEntryPath: 'C:\\runtime\\openclaw.mjs',
    };
    const identity = {
      processId: 4321,
      creationIdentity: 'created-4321',
      executablePath: options.executablePath,
      commandLine: `"${options.executablePath}" ${options.gatewayEntryPath} gateway --port 18789`,
      parentProcessId: 7777,
      parentExecutablePath: options.executablePath,
    };

    expect(isExpectedUClawGatewayProcess(identity, options)).toBe(false);
    expect(isExpectedUClawGatewayProcess({ ...identity, parentProcessId: options.currentPid }, options)).toBe(true);
  });

  it('uses object-bound child.kill first while Windows ownership metadata is pending', async () => {
    setPlatform('win32');
    const child = new MockUtilityChild(4321);
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 0));
      return true;
    });
    mockGetOwnedGatewayChildMetadata.mockImplementation(() => {
      throw new Error('WMI metadata lookup is still pending');
    });
    mockReadGatewayOwnershipRecord.mockImplementation(() => new Promise(() => {}));
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    await expect(
      terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess),
    ).resolves.toBeUndefined();

    expect(child.kill).toHaveBeenCalledOnce();
    expect(mockTerminateWindowsProcessTreeIfOwned).not.toHaveBeenCalled();
    expect(mockReadGatewayOwnershipRecord).not.toHaveBeenCalled();
  });

  it('falls back to the verified process tree when object-bound kill returns false', async () => {
    vi.useFakeTimers();
    setPlatform('win32');
    const child = new MockUtilityChild(4321);
    const record = setOwnedWindowsChildMetadata();
    child.kill.mockReturnValue(false);
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    try {
      const stopPromise = terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(mockTerminateWindowsProcessTreeIfOwned).toHaveBeenCalledOnce());
      child.emit('exit', 0);
      await expect(stopPromise).resolves.toBeUndefined();

      expect(child.kill).toHaveBeenCalledOnce();
      expect(mockTerminateWindowsProcessTreeIfOwned).toHaveBeenCalledWith({
        record,
        commandIdentityHash: 'b'.repeat(64),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses ownership metadata that becomes available before PID-tree escalation', async () => {
    vi.useFakeTimers();
    setPlatform('win32');
    const child = new MockUtilityChild(4321);
    const record = setOwnedWindowsChildMetadata();
    const metadata = {
      record,
      commandIdentityHash: 'b'.repeat(64),
      exited: false,
      port: 18789,
    };
    mockGetOwnedGatewayChildMetadata.mockReturnValue(null);
    child.kill.mockReturnValue(true);
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    try {
      const stopPromise = terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess);
      await vi.advanceTimersByTimeAsync(4999);
      mockGetOwnedGatewayChildMetadata.mockReturnValue(metadata);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(mockTerminateWindowsProcessTreeIfOwned).toHaveBeenCalledOnce());
      child.emit('exit', 0);
      await expect(stopPromise).resolves.toBeUndefined();

      expect(mockTerminateWindowsProcessTreeIfOwned).toHaveBeenCalledWith({
        record,
        commandIdentityHash: 'b'.repeat(64),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a reused Windows PID as an already-ended owned child without killing it', async () => {
    vi.useFakeTimers();
    setPlatform('win32');
    const child = new MockUtilityChild(4321);
    setOwnedWindowsChildMetadata();
    mockTerminateWindowsProcessTreeIfOwned.mockResolvedValueOnce('creation_identity_mismatch');
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    try {
      const stopPromise = terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(stopPromise).resolves.toBeUndefined();

      expect(mockTerminateWindowsProcessTreeIfOwned).toHaveBeenCalledOnce();
      expect(mockMarkOwnedGatewayChildExited).toHaveBeenCalledWith(child);
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('revalidates ownership and identity before Windows PID-tree escalation', async () => {
    vi.useFakeTimers();
    setPlatform('win32');
    const child = new MockUtilityChild(4321);
    setOwnedWindowsChildMetadata();
    mockTerminateWindowsProcessTreeIfOwned.mockResolvedValueOnce('terminated');
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    try {
      const stopPromise = terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess);
      const rejection = expect(stopPromise).rejects.toThrow(/did not exit after taskkill/i);
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockTerminateWindowsProcessTreeIfOwned).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      await rejection;
      expect(mockReadGatewayOwnershipRecord).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses Windows PID termination when the durable ownership record changed', async () => {
    vi.useFakeTimers();
    setPlatform('win32');
    const child = new MockUtilityChild(4321);
    setOwnedWindowsChildMetadata();
    mockGatewayOwnershipRecordsMatch.mockReturnValue(false);
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    try {
      const stopPromise = terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess);
      const rejection = expect(stopPromise).rejects.toThrow(/ownership record mismatch/i);
      await vi.advanceTimersByTimeAsync(5000);
      await rejection;

      expect(mockTerminateWindowsProcessTreeIfOwned).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses Windows PID termination when command identity no longer matches', async () => {
    vi.useFakeTimers();
    setPlatform('win32');
    const child = new MockUtilityChild(4321);
    setOwnedWindowsChildMetadata();
    mockTerminateWindowsProcessTreeIfOwned.mockResolvedValueOnce('command_identity_mismatch');
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    try {
      const stopPromise = terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess);
      const rejection = expect(stopPromise).rejects.toThrow(/command identity mismatch/i);
      await vi.advanceTimersByTimeAsync(5000);
      await rejection;

      expect(mockTerminateWindowsProcessTreeIfOwned).toHaveBeenCalledOnce();
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat an ownership verification failure as an exited Windows child', async () => {
    vi.useFakeTimers();
    setPlatform('win32');
    const child = new MockUtilityChild(4321);
    setOwnedWindowsChildMetadata();
    mockTerminateWindowsProcessTreeIfOwned.mockResolvedValueOnce('verification_failed');
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    try {
      const stopPromise = terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess);
      const rejection = expect(stopPromise).rejects.toThrow(/ownership verification failed/i);
      await vi.advanceTimersByTimeAsync(5000);
      await rejection;

      expect(mockMarkOwnedGatewayChildExited).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never targets a Windows PID without child-bound ownership metadata', async () => {
    vi.useFakeTimers();
    setPlatform('win32');
    const child = new MockUtilityChild(4321);
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    try {
      const stopPromise = terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess);
      const rejection = expect(stopPromise).rejects.toThrow(/child-bound ownership metadata/i);
      await vi.advanceTimersByTimeAsync(5000);
      await rejection;

      expect(mockTerminateWindowsProcessTreeIfOwned).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses direct child.kill for owned process on non-Windows', async () => {
    setPlatform('linux');
    const child = new MockUtilityChild(9876);
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    const stopPromise = terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess);
    child.emit('exit', 0);
    await stopPromise;

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects when child.kill reports that SIGTERM was not sent', async () => {
    setPlatform('linux');
    const child = new MockUtilityChild(9876);
    child.kill.mockReturnValue(false);
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    await expect(
      terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess),
    ).rejects.toThrow(/SIGTERM.*child\.kill\(\) returned false/i);
  });

  it('waits for the child exit event after escalating to SIGKILL', async () => {
    vi.useFakeTimers();
    setPlatform('linux');
    const child = new MockUtilityChild(9876);
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    try {
      let settled = false;
      const stopPromise = terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess)
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(5000);
      expect(killSpy).toHaveBeenCalledWith(9876, 'SIGKILL');
      expect(settled).toBe(false);

      child.emit('exit', null);
      await stopPromise;
      expect(settled).toBe(true);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('rejects when SIGKILL is denied', async () => {
    vi.useFakeTimers();
    setPlatform('linux');
    const child = new MockUtilityChild(9876);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    try {
      const stopPromise = terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess);
      const rejection = expect(stopPromise).rejects.toThrow(/SIGKILL.*operation not permitted/i);
      await vi.advanceTimersByTimeAsync(5000);
      await rejection;
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('rejects when the child remains alive after SIGKILL', async () => {
    vi.useFakeTimers();
    setPlatform('linux');
    const child = new MockUtilityChild(9876);
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    try {
      const stopPromise = terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess);
      const rejection = expect(stopPromise).rejects.toThrow(/did not exit after SIGKILL/i);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);
      await rejection;
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('rejects when taskkill cannot terminate an owned Windows process', async () => {
    vi.useFakeTimers();
    setPlatform('win32');
    const child = new MockUtilityChild(4321);
    setOwnedWindowsChildMetadata();
    mockTerminateWindowsProcessTreeIfOwned.mockRejectedValueOnce(new Error('access denied'));
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    try {
      const stopPromise = terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess);
      const rejection = expect(stopPromise).rejects.toThrow(/taskkill.*access denied/i);
      await vi.advanceTimersByTimeAsync(5000);
      await rejection;
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves an unverified user plist that reuses the OpenClaw launchd label', async () => {
    setPlatform('darwin');
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'uclaw-user-launch-agent-'));
    const launchAgentsDir = path.join(homeDir, 'Library', 'LaunchAgents');
    const plistPath = path.join(launchAgentsDir, 'ai.openclaw.gateway.plist');
    const userPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>ai.openclaw.gateway</string>
  <key>Comment</key><string>OpenClaw Gateway</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/Users/test/projects/openclaw-dev/dist/index.js</string>
    <string>gateway</string>
  </array>
</dict></plist>`;
    await mkdir(launchAgentsDir, { recursive: true });
    await writeFile(plistPath, userPlist, 'utf8');
    mockExecFile.mockImplementation((file: string, args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      if (file === 'launchctl' && args[0] === 'print') {
        cb(null, 'gui/501/ai.openclaw.gateway = { program = /usr/local/bin/personal-service; }');
        return {} as never;
      }
      cb(null, '');
      return {} as never;
    });
    const { unloadLaunchctlGatewayService } = await import('@electron/gateway/supervisor');

    try {
      await unloadLaunchctlGatewayService({ homeDir, uid: 501 });

      await expect(readFile(plistPath, 'utf8')).resolves.toBe(userPlist);
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'launchctl',
        ['bootout', 'gui/501/ai.openclaw.gateway'],
        expect.anything(),
        expect.any(Function),
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('bootouts a verified loaded service without deleting an unverified user plist', async () => {
    setPlatform('darwin');
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'uclaw-split-launch-agent-'));
    const launchAgentsDir = path.join(homeDir, 'Library', 'LaunchAgents');
    const plistPath = path.join(launchAgentsDir, 'ai.openclaw.gateway.plist');
    const userPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>ai.openclaw.gateway</string>
  <key>Comment</key><string>Personal file that must remain</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/personal-service</string><string>gateway</string>
  </array>
</dict></plist>`;
    const managedRuntime = `gui/501/ai.openclaw.gateway = {
  arguments = {
    0 = /usr/local/bin/openclaw
    1 = gateway
  }
  environment = {
    OPENCLAW_SERVICE_MARKER => openclaw
    OPENCLAW_SERVICE_KIND => gateway
  }
}`;
    await mkdir(launchAgentsDir, { recursive: true });
    await writeFile(plistPath, userPlist, 'utf8');
    mockExecFile.mockImplementation((file: string, args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      if (file === 'launchctl' && args[0] === 'print') {
        cb(null, managedRuntime);
        return {} as never;
      }
      if (file === 'launchctl' && args[0] === 'bootout') {
        cb(null, '');
        return {} as never;
      }
      cb(new Error('unexpected command'), '');
      return {} as never;
    });
    const { unloadLaunchctlGatewayService } = await import('@electron/gateway/supervisor');

    try {
      await unloadLaunchctlGatewayService({ homeDir, uid: 501 });

      await expect(readFile(plistPath, 'utf8')).resolves.toBe(userPlist);
      expect(mockExecFile).toHaveBeenCalledWith(
        'launchctl',
        ['bootout', 'gui/501/ai.openclaw.gateway'],
        expect.anything(),
        expect.any(Function),
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('refuses bootout when the loaded launchctl service identity changes between checks', async () => {
    setPlatform('darwin');
    const managedRuntime = (pid: number) => `gui/501/ai.openclaw.gateway = {
  path = /Users/test/.openclaw/launchd/ai.openclaw.gateway.plist
  pid = ${pid}
  arguments = {
    0 = /usr/local/bin/openclaw
    1 = gateway
  }
  environment = {
    OPENCLAW_SERVICE_MARKER => openclaw
    OPENCLAW_SERVICE_KIND => gateway
  }
}`;
    let printCount = 0;
    mockExecFile.mockImplementation((file: string, args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      if (file === 'launchctl' && args[0] === 'print') {
        printCount += 1;
        cb(null, managedRuntime(printCount === 1 ? 4321 : 8765));
        return {} as never;
      }
      cb(new Error('unexpected command'), '');
      return {} as never;
    });
    const { unloadLaunchctlGatewayService } = await import('@electron/gateway/supervisor');

    await unloadLaunchctlGatewayService({ homeDir: path.join(os.tmpdir(), 'uclaw-no-plist'), uid: 501 });

    expect(printCount).toBe(2);
    expect(mockExecFile).not.toHaveBeenCalledWith(
      'launchctl',
      ['bootout', 'gui/501/ai.openclaw.gateway'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('bootouts and deletes a plist only after managed OpenClaw ownership is explicit', async () => {
    setPlatform('darwin');
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'uclaw-managed-launch-agent-'));
    const launchAgentsDir = path.join(homeDir, 'Library', 'LaunchAgents');
    const plistPath = path.join(launchAgentsDir, 'ai.openclaw.gateway.plist');
    const managedPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>ai.openclaw.gateway</string>
  <key>Comment</key><string>OpenClaw Gateway (v2026.6.10)</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/node_modules/openclaw/dist/index.js</string>
    <string>gateway</string><string>--port</string><string>18789</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>OPENCLAW_SERVICE_MARKER</key><string>openclaw</string>
    <key>OPENCLAW_SERVICE_KIND</key><string>gateway</string>
  </dict>
</dict></plist>`;
    const launchctlOutput = `gui/501/ai.openclaw.gateway = {
  arguments = {
    0 = /Users/test/.openclaw/launchd/ai.openclaw.gateway-env-wrapper.sh
    1 = /Users/test/.openclaw/launchd/ai.openclaw.gateway.env
    2 = /usr/local/bin/node
    3 = /usr/local/lib/node_modules/openclaw/dist/index.js
    4 = gateway
  }
}`;
    await mkdir(launchAgentsDir, { recursive: true });
    await writeFile(plistPath, managedPlist, 'utf8');
    mockExecFile.mockImplementation((file: string, args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      if (file === 'launchctl' && args[0] === 'print') {
        cb(null, launchctlOutput);
        return {} as never;
      }
      if (file === 'launchctl' && args[0] === 'bootout') {
        cb(null, '');
        return {} as never;
      }
      cb(new Error('unexpected command'), '');
      return {} as never;
    });
    const { unloadLaunchctlGatewayService } = await import('@electron/gateway/supervisor');

    try {
      await unloadLaunchctlGatewayService({ homeDir, uid: 501 });

      await expect(readFile(plistPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(mockExecFile).toHaveBeenCalledWith(
        'launchctl',
        ['bootout', 'gui/501/ai.openclaw.gateway'],
        expect.objectContaining({ timeout: 10_000 }),
        expect.any(Function),
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('preserves an unknown Windows listener and reports a port conflict', async () => {
    setPlatform('win32');
    const { findExistingGatewayProcess } = await import('@electron/gateway/supervisor');

    mockExecFile.mockImplementation((file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      if (file.endsWith('netstat.exe')) {
        cb(null, '  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4321\n');
        return {} as never;
      }
      cb(null, '');
      return {} as never;
    });

    await expect(findExistingGatewayProcess({ port: 18789 })).rejects.toThrow(
      'Gateway port 18789 is already in use by another process',
    );

    expect(mockExec).not.toHaveBeenCalledWith(
      expect.stringContaining('taskkill'),
      expect.anything(),
      expect.any(Function),
    );
    expect(mockCreateServer).not.toHaveBeenCalled();
  });

  it('reuses a responsive verified Gateway after checking listener ownership before and after readiness', async () => {
    setPlatform('win32');
    mockProbeGatewayReady.mockResolvedValueOnce(true);
    const { findExistingGatewayProcess } = await import('@electron/gateway/supervisor');
    const { getOpenClawDir } = await import('@electron/utils/paths');

    mockExecFile.mockImplementation((file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      if (file.endsWith('netstat.exe')) {
        cb(null, '  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4321\n');
        return {} as never;
      }
      cb(null, '');
      return {} as never;
    });
    mockInspectWindowsGatewayProcess.mockResolvedValue({
      processId: 4321,
      creationIdentity: '13371337',
      executablePath: process.execPath,
      commandLine: `"${process.execPath}" /tmp/gateway-entry-wrapper.cjs gateway --port 18789`,
      parentProcessId: 0,
    });
    mockReadGatewayOwnershipRecord.mockResolvedValue({
      pid: 4321,
      processCreationIdentity: '13371337',
      runtimeRoot: getOpenClawDir(),
      launchNonce: 'nonce-test-1234',
      tokenHash: 'hash:current-runtime-token',
    });

    await expect(findExistingGatewayProcess({
      port: 18789,
      tokenHash: 'hash:current-runtime-token',
    })).resolves.toEqual({ port: 18789, pid: 4321, provenance: 'verified-orphan' });
    expect(mockInspectWindowsGatewayProcess).toHaveBeenCalledTimes(2);
  });

  it('leaves an unready owned Gateway for the startup orchestrator to recover', async () => {
    setPlatform('win32');
    const { findExistingGatewayProcess } = await import('@electron/gateway/supervisor');

    mockExecFile.mockImplementation((file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      if (file.endsWith('netstat.exe')) {
        cb(null, '  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4321\n');
        return {} as never;
      }
      cb(null, '');
      return {} as never;
    });

    await expect(findExistingGatewayProcess({ port: 18789, ownedPid: 4321 })).resolves.toBeNull();
    expect(mockExec).not.toHaveBeenCalledWith(
      expect.stringContaining('taskkill'),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('treats a failed netstat inspection as unknown rather than a free port', async () => {
    setPlatform('win32');
    mockExecFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      cb(new Error('netstat denied'), '');
      return {} as never;
    });
    const { findExistingGatewayProcess } = await import('@electron/gateway/supervisor');

    await expect(findExistingGatewayProcess({ port: 18789 })).rejects.toThrow('Gateway port 18789');
    expect(mockProbeGatewayReady).not.toHaveBeenCalled();
  });

  it('rejects takeover when the listener PID changes during readiness', async () => {
    setPlatform('win32');
    let netstatCalls = 0;
    mockExecFile.mockImplementation((file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      if (file.endsWith('netstat.exe')) {
        netstatCalls += 1;
        const pid = netstatCalls === 1 ? 4321 : 9999;
        cb(null, `  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    ${pid}\n`);
        return {} as never;
      }
      cb(null, '');
      return {} as never;
    });
    mockInspectWindowsGatewayProcess.mockImplementation(async (pid: number) => ({
      processId: pid,
      creationIdentity: `created-${pid}`,
      executablePath: process.execPath,
      commandLine: `"${process.execPath}" /tmp/gateway-entry-wrapper.cjs gateway --port 18789`,
      parentProcessId: 0,
    }));
    mockProbeGatewayReady.mockResolvedValue(true);
    const { findExistingGatewayProcess } = await import('@electron/gateway/supervisor');

    await expect(findExistingGatewayProcess({ port: 18789 })).rejects.toThrow('Gateway port 18789');
  });

  it('allows an orphan direct entry only when the durable token-bound record matches', async () => {
    setPlatform('win32');
    const { getOpenClawDir, getOpenClawEntryPath } = await import('@electron/utils/paths');
    mockExecFile.mockImplementation((file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      if (file.endsWith('netstat.exe')) {
        cb(null, '  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4321\n');
        return {} as never;
      }
      cb(null, '');
      return {} as never;
    });
    mockInspectWindowsGatewayProcess.mockResolvedValue({
      processId: 4321,
      creationIdentity: 'orphan-created',
      executablePath: process.execPath,
      commandLine: `"${process.execPath}" ${getOpenClawEntryPath()} gateway --port 18789`,
      parentProcessId: 7777,
    });
    mockReadGatewayOwnershipRecord.mockResolvedValue({
      pid: 4321,
      processCreationIdentity: 'orphan-created',
      runtimeRoot: getOpenClawDir(),
      launchNonce: 'nonce-test-1234',
      tokenHash: 'hash:token-bound-to-this-runtime',
    });
    mockProbeGatewayReady.mockResolvedValue(true);
    const { findExistingGatewayProcess } = await import('@electron/gateway/supervisor');

    await expect(findExistingGatewayProcess({
      port: 18789,
      tokenHash: 'hash:token-bound-to-this-runtime',
    })).resolves.toEqual({ port: 18789, pid: 4321, provenance: 'verified-orphan' });
  });

  it('cancels a slow verified takeover without waiting for the readiness timeout', async () => {
    setPlatform('win32');
    const { getOpenClawDir } = await import('@electron/utils/paths');
    mockExecFile.mockImplementation((file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      if (file.endsWith('netstat.exe')) {
        cb(null, '  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4321\n');
        return {} as never;
      }
      cb(null, '');
      return {} as never;
    });
    mockInspectWindowsGatewayProcess.mockResolvedValue({
      processId: 4321,
      creationIdentity: 'slow-created',
      executablePath: process.execPath,
      commandLine: `"${process.execPath}" /tmp/gateway-entry-wrapper.cjs gateway --port 18789`,
      parentProcessId: 0,
    });
    mockReadGatewayOwnershipRecord.mockResolvedValue({
      pid: 4321,
      processCreationIdentity: 'slow-created',
      runtimeRoot: getOpenClawDir(),
      launchNonce: 'nonce-test-1234',
      tokenHash: 'hash:current-runtime-token',
    });
    mockProbeGatewayReady.mockResolvedValue(false);
    const controller = new AbortController();
    const { findExistingGatewayProcess } = await import('@electron/gateway/supervisor');

    const takeover = findExistingGatewayProcess({
      port: 18789,
      tokenHash: 'hash:current-runtime-token',
      candidateReadyTimeoutMs: 90_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mockProbeGatewayReady).toHaveBeenCalledOnce());
    controller.abort(new Error('superseded startup'));

    await expect(takeover).rejects.toThrow('superseded startup');
  });
});
