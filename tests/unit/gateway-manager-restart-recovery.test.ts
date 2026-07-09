import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    isPackaged: false,
  },
  utilityProcess: {
    fork: vi.fn(),
  },
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('GatewayManager restart recovery', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-08T00:00:00.000Z'));
  });

  it('re-enables auto-reconnect when start() fails during restart', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();

    // Expose private members for testing
    const internals = manager as unknown as {
      shouldReconnect: boolean;
      status: { state: string; port: number };
      startLock: boolean;
      reconnectTimer: NodeJS.Timeout | null;
      restartInFlight: Promise<void> | null;
      scheduleReconnect: () => void;
      stop: () => Promise<void>;
      start: () => Promise<void>;
    };

    // Set the manager into a state where restart can proceed:
    // - state must not be 'starting' or 'reconnecting' (would defer restart)
    // - startLock must be false
    internals.status = { state: 'running', port: 18789 };
    internals.startLock = false;
    internals.shouldReconnect = true;

    // Mock stop to just reset flags (simulates normal stop)
    vi.spyOn(manager, 'stop').mockImplementation(async () => {
      internals.shouldReconnect = false;
      internals.status = { state: 'stopped', port: 18789 };
    });

    // Mock start to fail (simulates the race condition where gateway
    // is reachable but not attachable after in-process restart)
    vi.spyOn(manager, 'start').mockRejectedValue(
      new Error('WebSocket closed before handshake: unknown'),
    );

    // Spy on scheduleReconnect
    const scheduleReconnectSpy = vi.spyOn(
      internals as unknown as { scheduleReconnect: () => void },
      'scheduleReconnect',
    );

    // Perform the restart - it should throw because start() fails
    await expect(manager.restart()).rejects.toThrow(
      'WebSocket closed before handshake: unknown',
    );

    // KEY ASSERTION: After start() fails in restart(), shouldReconnect
    // must be re-enabled so the gateway can self-heal
    expect(internals.shouldReconnect).toBe(true);
    expect(scheduleReconnectSpy).toHaveBeenCalled();
  });

  it('does not schedule extra reconnect when restart succeeds', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();

    const internals = manager as unknown as {
      shouldReconnect: boolean;
      status: { state: string; port: number };
      startLock: boolean;
      reconnectTimer: NodeJS.Timeout | null;
      restartInFlight: Promise<void> | null;
      scheduleReconnect: () => void;
    };

    internals.status = { state: 'running', port: 18789 };
    internals.startLock = false;
    internals.shouldReconnect = true;

    // Mock stop to reset flags
    vi.spyOn(manager, 'stop').mockImplementation(async () => {
      internals.shouldReconnect = false;
      internals.status = { state: 'stopped', port: 18789 };
    });

    // Mock start to succeed
    vi.spyOn(manager, 'start').mockImplementation(async () => {
      internals.shouldReconnect = true;
      internals.status = { state: 'running', port: 18789 };
    });

    const scheduleReconnectSpy = vi.spyOn(
      internals as unknown as { scheduleReconnect: () => void },
      'scheduleReconnect',
    );

    await manager.restart();

    // scheduleReconnect should NOT have been called by the catch block
    // (it may be called from other paths, but not the restart-recovery catch)
    expect(scheduleReconnectSpy).not.toHaveBeenCalled();
  });

  it('defers restart until an active runtime run finishes', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();

    const internals = manager as unknown as {
      shouldReconnect: boolean;
      status: { state: string; port: number };
      startLock: boolean;
    };

    internals.status = { state: 'running', port: 18789 };
    internals.startLock = false;
    internals.shouldReconnect = true;

    const stopSpy = vi.spyOn(manager, 'stop').mockResolvedValue();
    const startSpy = vi.spyOn(manager, 'start').mockResolvedValue();

    manager.emit('chat:runtime-event', {
      type: 'run.started',
      runId: 'run-active',
      sessionKey: 'agent:main:main',
    });

    await manager.restart({
      reason: 'provider-config-save',
      source: 'test',
    });

    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();

    manager.emit('chat:runtime-event', {
      type: 'run.ended',
      runId: 'run-active',
      sessionKey: 'agent:main:main',
      status: 'completed',
    });
    await vi.runAllTicks();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('coalesces deferred restarts while the same run is still active', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();

    const internals = manager as unknown as {
      shouldReconnect: boolean;
      status: { state: string; port: number };
      startLock: boolean;
    };

    internals.status = { state: 'running', port: 18789 };
    internals.startLock = false;
    internals.shouldReconnect = true;

    const stopSpy = vi.spyOn(manager, 'stop').mockResolvedValue();
    const startSpy = vi.spyOn(manager, 'start').mockResolvedValue();

    manager.emit('chat:runtime-event', {
      type: 'run.started',
      runId: 'run-active',
      sessionKey: 'agent:main:main',
    });

    await Promise.all([
      manager.restart({ reason: 'config-save-a', source: 'test' }),
      manager.restart({ reason: 'config-save-b', source: 'test' }),
    ]);

    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();

    manager.emit('chat:runtime-event', {
      type: 'run.ended',
      runId: 'run-active',
      sessionKey: 'agent:main:main',
      status: 'completed',
    });
    await vi.runAllTicks();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('defers restart until a blocking rpc request settles', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();

    const internals = manager as unknown as {
      shouldReconnect: boolean;
      status: { state: string; port: number };
      startLock: boolean;
      ws: {
        readyState: number;
        send: ReturnType<typeof vi.fn>;
        ping: ReturnType<typeof vi.fn>;
        terminate: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
      } | null;
      pendingRequests: Map<string, unknown>;
      handleMessage: (message: unknown) => void;
    };

    internals.status = { state: 'running', port: 18789 };
    internals.startLock = false;
    internals.shouldReconnect = true;
    internals.ws = {
      readyState: 1,
      send: vi.fn(),
      ping: vi.fn(),
      terminate: vi.fn(),
      on: vi.fn(),
    };

    const stopSpy = vi.spyOn(manager, 'stop').mockResolvedValue();
    const startSpy = vi.spyOn(manager, 'start').mockResolvedValue();

    const rpcPromise = manager.rpc('chat.send', { text: 'hello' }, 5000);
    const requestId = Array.from(internals.pendingRequests.keys())[0] as string;

    await manager.restart({
      reason: 'reload-config',
      source: 'test',
    });

    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();

    internals.handleMessage({
      type: 'res',
      id: requestId,
      ok: true,
      payload: { runId: 'run-active' },
    });
    await expect(rpcPromise).resolves.toEqual({ runId: 'run-active' });
    await vi.runAllTicks();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('does not let heartbeat recovery wait behind active runtime work', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();

    const internals = manager as unknown as {
      shouldReconnect: boolean;
      status: { state: string; port: number };
      startLock: boolean;
    };

    internals.status = { state: 'running', port: 18789 };
    internals.startLock = false;
    internals.shouldReconnect = true;

    const stopSpy = vi.spyOn(manager, 'stop').mockResolvedValue();
    const startSpy = vi.spyOn(manager, 'start').mockResolvedValue();

    manager.emit('chat:runtime-event', {
      type: 'run.started',
      runId: 'run-stuck',
      sessionKey: 'agent:main:main',
    });

    await manager.restart({
      reason: 'heartbeat-timeout',
      source: 'gateway-heartbeat',
    });

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});
