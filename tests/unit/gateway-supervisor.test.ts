import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalPlatform = process.platform;

const {
  mockExec,
  mockCreateServer,
} = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockCreateServer: vi.fn(),
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
  execSync: vi.fn(),
  spawn: vi.fn(),
  default: {
    exec: mockExec,
    execSync: vi.fn(),
    spawn: vi.fn(),
  },
}));

vi.mock('net', () => ({
  createServer: mockCreateServer,
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

describe('gateway supervisor process cleanup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mockExec.mockImplementation((_cmd: string, _opts: object, cb: (err: Error | null, stdout: string) => void) => {
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

  it('uses taskkill tree strategy for owned process on Windows', async () => {
    setPlatform('win32');
    const child = new MockUtilityChild(4321);
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    const stopPromise = terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess);
    child.emit('exit', 0);
    await stopPromise;

    await vi.waitFor(() => {
      expect(mockExec).toHaveBeenCalledWith(
        'taskkill /F /PID 4321 /T',
        expect.objectContaining({ timeout: 5000, windowsHide: true }),
        expect.any(Function),
      );
    });
    expect(child.kill).not.toHaveBeenCalled();
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
    setPlatform('win32');
    const child = new MockUtilityChild(4321);
    mockExec.mockImplementationOnce(
      (_cmd: string, _opts: object, cb: (err: Error | null, stdout: string) => void) => {
        cb(new Error('access denied'), '');
        return {} as never;
      },
    );
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    await expect(
      terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess),
    ).rejects.toThrow(/taskkill.*access denied/i);
  });

  it('waits for port release after orphan cleanup on Windows', async () => {
    setPlatform('win32');
    const { findExistingGatewayProcess } = await import('@electron/gateway/supervisor');

    mockExec.mockImplementation((cmd: string, _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      if (cmd.includes('netstat -ano')) {
        cb(null, '  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4321\n');
        return {} as never;
      }
      cb(null, '');
      return {} as never;
    });

    const result = await findExistingGatewayProcess({ port: 18789 });
    expect(result).toBeNull();

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('taskkill /F /PID 4321 /T'),
      expect.objectContaining({ timeout: 5000, windowsHide: true }),
      expect.any(Function),
    );
    expect(mockCreateServer).toHaveBeenCalled();
  });
});
