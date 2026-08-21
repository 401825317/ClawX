// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => {
  const calls: unknown[][] = [];
  return {
    calls,
    info: vi.fn((...args: unknown[]) => { calls.push(args); }),
    warn: vi.fn((...args: unknown[]) => { calls.push(args); }),
    error: vi.fn((...args: unknown[]) => { calls.push(args); }),
    debug: vi.fn((...args: unknown[]) => { calls.push(args); }),
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  utilityProcess: { fork: vi.fn() },
}));

vi.mock('@electron/utils/logger', () => ({
  logger: loggerMocks,
}));

vi.mock('@electron/services/providers/store-instance', () => ({
  getClawXProviderStore: async () => ({ get: () => undefined, has: () => false }),
}));

type ManagerInternals = {
  ws: { readyState: number; terminate?: () => void } | null;
  process: Electron.UtilityProcess | null;
  ownsProcess: boolean;
  connectedGatewayOwned: boolean;
  connectedGatewayProvenance: 'managed-process' | 'verified-orphan' | 'unknown-external';
  terminateOwnedProcess: (child: Electron.UtilityProcess) => Promise<void>;
  waitForConnectedGatewayPortFree: (port?: number) => Promise<void>;
  status: { state: string; port: number; gatewayReady?: boolean };
  activeRunIds: Set<string>;
  processGeneration: number;
  restartAfterDrainOperation: unknown | null;
  stateController: { setStatus: (status: Record<string, unknown>) => void };
};

type RestartDrainEvent = {
  event: 'gateway_restart_drain';
  state: 'waiting' | 'drained' | 'forced' | 'executing' | 'terminal';
  result: 'pending' | 'joined' | 'succeeded' | 'failed' | 'cancelled' | 'deferred' | 'suppressed';
  forcedReason: 'none' | 'active_runs_deadline' | 'runtime_unavailable';
};

describe('GatewayManager restart drain', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    loggerMocks.calls.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createRunningManager() {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const internals = manager as unknown as ManagerInternals;
    internals.ws = { readyState: 1 };
    internals.status = { state: 'running', port: 18789, gatewayReady: true };
    return { manager, internals };
  }

  function restartDrainEvents(): RestartDrainEvent[] {
    return loggerMocks.calls
      .map((call) => call[1] as RestartDrainEvent | undefined)
      .filter((details): details is RestartDrainEvent => details?.event === 'gateway_restart_drain');
  }

  function terminalEvents(): RestartDrainEvent[] {
    return restartDrainEvents().filter((event) => event.state === 'terminal');
  }

  function expectNoSensitiveLoggerPayload(...values: string[]): void {
    const serialized = JSON.stringify(loggerMocks.calls);
    for (const value of values) expect(serialized).not.toContain(value);
  }

  it('classifies deterministic Gateway authentication failures as non-retryable', async () => {
    const { __test } = await import('@electron/gateway/manager');
    expect(__test.isDeterministicGatewayAuthenticationError(new Error('authentication failed: token mismatch'))).toBe(true);
    expect(__test.isDeterministicGatewayAuthenticationError(new Error('Gateway unavailable: ECONNREFUSED'))).toBe(false);
  });

  it('restarts immediately when idle', async () => {
    const { manager } = await createRunningManager();
    const stop = vi.spyOn(manager, 'stop').mockResolvedValue();
    const start = vi.spyOn(manager, 'start').mockResolvedValue();

    await manager.restart();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(restartDrainEvents()).toEqual([
      expect.objectContaining({ state: 'executing', result: 'pending', forcedReason: 'none' }),
      expect.objectContaining({ state: 'terminal', result: 'succeeded', forcedReason: 'none' }),
    ]);
    expect(terminalEvents()).toHaveLength(1);
  });

  it('disconnects from an external Gateway without sending shutdown', async () => {
    const { manager, internals } = await createRunningManager();
    const terminate = vi.fn();
    internals.ws = { readyState: 1, terminate };
    internals.process = null;
    internals.ownsProcess = false;
    internals.connectedGatewayOwned = false;
    const rpc = vi.spyOn(manager, 'rpc').mockResolvedValue(undefined);

    const stopped = manager.stop();
    await vi.advanceTimersByTimeAsync(250);
    await stopped;

    expect(rpc).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(manager.getStatus().state).toBe('stopped');
  });

  it('clears stale connection retry progress when stopped', async () => {
    const { manager, internals } = await createRunningManager();
    internals.stateController.setStatus({
      state: 'reconnecting',
      reconnectAttempts: 3,
      reconnectMaxAttempts: 5,
      connectionAttempt: 4,
      connectionMaxAttempts: 5,
    });

    await manager.stop();

    expect(manager.getStatus()).toMatchObject({ state: 'stopped' });
    expect(manager.getStatus().reconnectAttempts).toBeUndefined();
    expect(manager.getStatus().reconnectMaxAttempts).toBeUndefined();
    expect(manager.getStatus().connectionAttempt).toBeUndefined();
    expect(manager.getStatus().connectionMaxAttempts).toBeUndefined();
  });

  it('gracefully shuts down a verified orphan and waits for its port to be released', async () => {
    const { manager, internals } = await createRunningManager();
    internals.process = null;
    internals.ownsProcess = false;
    internals.connectedGatewayOwned = false;
    internals.connectedGatewayProvenance = 'verified-orphan';
    const rpc = vi.spyOn(manager, 'rpc').mockResolvedValue(undefined);
    const waitForPort = vi.spyOn(internals, 'waitForConnectedGatewayPortFree').mockResolvedValue(undefined);

    await manager.stop();

    expect(rpc).toHaveBeenCalledWith('shutdown', undefined, 5000);
    expect(waitForPort).toHaveBeenCalledTimes(1);
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(waitForPort.mock.invocationCallOrder[0]);
  });

  it('cleans up its own stale child without shutting down a different connected Gateway', async () => {
    const { manager, internals } = await createRunningManager();
    const child = { pid: 1111 } as Electron.UtilityProcess;
    const terminateSocket = vi.fn();
    internals.ws = { readyState: 1, terminate: terminateSocket };
    internals.process = child;
    internals.ownsProcess = true;
    internals.connectedGatewayOwned = false;
    const rpc = vi.spyOn(manager, 'rpc').mockResolvedValue(undefined);
    const terminateOwnedProcess = vi
      .spyOn(internals, 'terminateOwnedProcess')
      .mockResolvedValue(undefined);

    const stopped = manager.stop();
    await vi.advanceTimersByTimeAsync(250);
    await stopped;

    expect(rpc).not.toHaveBeenCalled();
    expect(terminateSocket).toHaveBeenCalledTimes(1);
    expect(terminateOwnedProcess).toHaveBeenCalledWith(child);
  });

  it('requests graceful shutdown before terminating the connected owned Gateway', async () => {
    const { manager, internals } = await createRunningManager();
    const child = { pid: 1111 } as Electron.UtilityProcess;
    internals.ws = { readyState: 1, terminate: vi.fn() };
    internals.process = child;
    internals.ownsProcess = true;
    internals.connectedGatewayOwned = true;
    const rpc = vi.spyOn(manager, 'rpc').mockResolvedValue(undefined);
    const terminateOwnedProcess = vi
      .spyOn(internals, 'terminateOwnedProcess')
      .mockResolvedValue(undefined);
    const waitForPort = vi
      .spyOn(internals, 'waitForConnectedGatewayPortFree')
      .mockResolvedValue(undefined);

    const stopped = manager.stop();
    await vi.advanceTimersByTimeAsync(250);
    await stopped;

    expect(rpc).toHaveBeenCalledWith('shutdown', undefined, 5000);
    expect(terminateOwnedProcess).toHaveBeenCalledWith(child);
    expect(waitForPort).toHaveBeenCalledWith(18789);
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(
      terminateOwnedProcess.mock.invocationCallOrder[0],
    );
    expect(terminateOwnedProcess.mock.invocationCallOrder[0]).toBeLessThan(
      waitForPort.mock.invocationCallOrder[0],
    );
  });

  it('waits for the captured owned port when the child exits during shutdown RPC', async () => {
    const { manager, internals } = await createRunningManager();
    const child = { pid: 2222 } as Electron.UtilityProcess;
    internals.process = child;
    internals.ownsProcess = true;
    internals.connectedGatewayOwned = true;

    let releasePort!: () => void;
    const portReleased = new Promise<void>((resolve) => {
      releasePort = resolve;
    });
    const waitForPort = vi
      .spyOn(internals, 'waitForConnectedGatewayPortFree')
      .mockReturnValue(portReleased);
    vi.spyOn(manager, 'rpc').mockImplementation(async () => {
      // Mirror the real process exit callback racing the shutdown RPC.
      internals.process = null;
      internals.ownsProcess = false;
    });

    let settled = false;
    const stopping = manager.stop().finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(waitForPort).toHaveBeenCalledWith(18789));
    expect(settled).toBe(false);

    releasePort();
    await stopping;
    expect(settled).toBe(true);
  });

  it('rechecks process generation after a stable window before termination', async () => {
    const { manager, internals } = await createRunningManager();
    const child = { pid: 1111 } as Electron.UtilityProcess;
    internals.process = child;
    internals.ownsProcess = true;
    internals.connectedGatewayOwned = false;
    const terminateOwnedProcess = vi.spyOn(internals, 'terminateOwnedProcess').mockResolvedValue(undefined);

    const stopped = manager.stop();
    const rejection = expect(stopped).rejects.toThrow('termination target changed');
    internals.processGeneration += 1;
    await vi.advanceTimersByTimeAsync(250);

    await rejection;
    expect(terminateOwnedProcess).not.toHaveBeenCalled();
  });

  it('joins concurrent requests and emits one terminal event after runs drain', async () => {
    const { manager, internals } = await createRunningManager();
    const stop = vi.spyOn(manager, 'stop').mockResolvedValue();
    const start = vi.spyOn(manager, 'start').mockResolvedValue();
    const sensitiveRunId = 'F:\\private\\prompt.txt \\\\fileserver\\private Bearer test-secret-token';

    manager.emit('chat:runtime-event', { type: 'run.started', runId: sensitiveRunId });
    const firstRestart = manager.restart();
    const joinedRestart = manager.restart();
    await vi.waitFor(() => {
      expect(restartDrainEvents().filter((event) => event.state === 'waiting')).toHaveLength(2);
    });
    expect(stop).not.toHaveBeenCalled();

    manager.emit('chat:runtime-event', {
      type: 'run.ended',
      runId: sensitiveRunId,
      status: 'completed',
    });
    await Promise.all([firstRestart, joinedRestart]);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(internals.restartAfterDrainOperation).toBeNull();
    expect(restartDrainEvents()).toEqual([
      expect.objectContaining({ state: 'waiting', result: 'pending', forcedReason: 'none' }),
      expect.objectContaining({ state: 'waiting', result: 'joined', forcedReason: 'none' }),
      expect.objectContaining({ state: 'drained', result: 'pending', forcedReason: 'none' }),
      expect.objectContaining({ state: 'executing', result: 'pending', forcedReason: 'none' }),
      expect.objectContaining({ state: 'terminal', result: 'succeeded', forcedReason: 'none' }),
    ]);
    expect(terminalEvents()).toHaveLength(1);
    expectNoSensitiveLoggerPayload(
      'F:\\private\\prompt.txt',
      '\\\\fileserver\\private',
      'test-secret-token',
    );
  });

  it('closes new chat run admission while restart is draining', async () => {
    const { manager } = await createRunningManager();
    const stop = vi.spyOn(manager, 'stop').mockResolvedValue();
    vi.spyOn(manager, 'start').mockResolvedValue();
    manager.emit('chat:runtime-event', { type: 'run.started', runId: 'run-active' });

    const restarting = manager.restart();
    await expect(manager.rpc('chat.send', { message: 'late run' })).rejects.toThrow('closing run admission');
    manager.emit('chat:runtime-event', { type: 'run.ended', runId: 'run-active', status: 'completed' });
    await restarting;

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('forces a restart after the bounded drain deadline', async () => {
    const { manager, internals } = await createRunningManager();
    const stop = vi.spyOn(manager, 'stop').mockResolvedValue();
    const start = vi.spyOn(manager, 'start').mockResolvedValue();
    const rpc = vi.spyOn(manager, 'rpc').mockResolvedValue(undefined);

    manager.emit('chat:runtime-event', {
      type: 'run.started',
      runId: 'run-timeout',
      sessionKey: 'session-timeout',
    });
    const restart = manager.restart();
    await vi.advanceTimersByTimeAsync(90_000);
    await restart;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('chat.abort', { sessionKey: 'session-timeout' }, 15_000);
    expect(internals.activeRunIds.size).toBe(0);
    expect(restartDrainEvents()).toEqual([
      expect.objectContaining({ state: 'waiting', result: 'pending', forcedReason: 'none' }),
      expect.objectContaining({
        state: 'forced',
        result: 'pending',
        forcedReason: 'active_runs_deadline',
      }),
      expect.objectContaining({
        state: 'executing',
        result: 'pending',
        forcedReason: 'active_runs_deadline',
      }),
      expect.objectContaining({
        state: 'terminal',
        result: 'succeeded',
        forcedReason: 'active_runs_deadline',
      }),
    ]);
    expect(terminalEvents()).toHaveLength(1);
  });

  it('forces and records a single terminal result when the runtime cannot drain', async () => {
    const { manager, internals } = await createRunningManager();
    const stop = vi.spyOn(manager, 'stop').mockResolvedValue();
    const start = vi.spyOn(manager, 'start').mockResolvedValue();
    internals.ws = null;

    manager.emit('chat:runtime-event', { type: 'run.started', runId: 'run-unavailable' });
    await manager.restart();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(internals.activeRunIds.size).toBe(0);
    expect(restartDrainEvents()).toEqual([
      expect.objectContaining({
        state: 'forced',
        result: 'pending',
        forcedReason: 'runtime_unavailable',
      }),
      expect.objectContaining({
        state: 'executing',
        result: 'pending',
        forcedReason: 'runtime_unavailable',
      }),
      expect.objectContaining({
        state: 'terminal',
        result: 'succeeded',
        forcedReason: 'runtime_unavailable',
      }),
    ]);
    expect(terminalEvents()).toHaveLength(1);
  });

  it('cancels a run without a session key by run id and emits forced_restart terminal state', async () => {
    const { manager, internals } = await createRunningManager();
    vi.spyOn(manager, 'stop').mockResolvedValue();
    vi.spyOn(manager, 'start').mockResolvedValue();
    const rpc = vi.spyOn(manager, 'rpc').mockResolvedValue(undefined);
    const runtimeEvents: unknown[] = [];
    manager.on('chat:runtime-event', event => runtimeEvents.push(event));

    manager.emit('chat:runtime-event', { type: 'run.started', runId: 'run-no-session' });
    const restart = manager.restart();
    await vi.advanceTimersByTimeAsync(90_000);
    await restart;

    expect(rpc).toHaveBeenCalledWith('chat.abort', { runId: 'run-no-session' }, 15_000);
    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      type: 'run.ended',
      runId: 'run-no-session',
      status: 'aborted',
      stopReason: 'forced_restart',
    }));
    expect(internals.activeRunIds.size).toBe(0);
  });

  it('emits one safe failed terminal event without logging failure details', async () => {
    const { manager } = await createRunningManager();
    vi.spyOn(manager, 'stop').mockResolvedValue();
    const drivePath = 'F:\\customer\\session.jsonl';
    const uncPath = '\\\\fileserver\\private\\openclaw.json';
    const token = 'test-secret-token';
    vi.spyOn(manager, 'start').mockRejectedValue(
      new Error(`${drivePath} ${uncPath} Bearer ${token}`),
    );

    manager.emit('chat:runtime-event', { type: 'run.started', runId: 'run-failure' });
    const restart = manager.restart();
    await vi.waitFor(() => {
      expect(restartDrainEvents()).toContainEqual(
        expect.objectContaining({ state: 'waiting', result: 'pending' }),
      );
    });
    manager.emit('chat:runtime-event', {
      type: 'run.ended',
      runId: 'run-failure',
      status: 'failed',
    });

    await expect(restart).rejects.toThrow(token);

    expect(terminalEvents()).toEqual([
      expect.objectContaining({ state: 'terminal', result: 'failed', forcedReason: 'none' }),
    ]);
    expectNoSensitiveLoggerPayload(drivePath, uncPath, token);
  });

  it('preserves the recovered runtime when the read-only channel probe fails', async () => {
    const { manager, internals } = await createRunningManager();
    const restart = vi.spyOn(manager, 'restart').mockResolvedValue();
    const rpc = vi.spyOn(manager, 'rpc').mockRejectedValue(new Error('channels.status unavailable'));
    internals.stateController.setStatus({ state: 'starting', port: 18789, gatewayReady: false });

    manager.emit('gateway:ready', {});
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.getStatus()).toMatchObject({ state: 'running', gatewayReady: true });
    expect(rpc).toHaveBeenCalledWith('channels.status', { probe: false }, 5_000);
    expect(restart).not.toHaveBeenCalled();
  });
});
