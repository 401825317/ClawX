import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunGatewayStartupSequence } = vi.hoisted(() => ({
  mockRunGatewayStartupSequence: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    isPackaged: false,
  },
  utilityProcess: {},
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@electron/gateway/startup-orchestrator', () => ({
  runGatewayStartupSequence: mockRunGatewayStartupSequence,
}));

describe('GatewayManager external ownership conflict', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports one bounded failure without scheduling reconnect', async () => {
    const {
      GatewayPortOwnershipConflictError,
    } = await import('@electron/gateway/supervisor');
    mockRunGatewayStartupSequence.mockRejectedValueOnce(
      new GatewayPortOwnershipConflictError(18789, ['4321'], true),
    );

    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager({
      maxAttempts: 10,
      baseDelay: 1_000,
      maxDelay: 30_000,
    });
    const internals = manager as unknown as {
      refreshReloadPolicy: (force?: boolean) => Promise<void>;
      initDeviceIdentity: () => Promise<void>;
      reconnectTimer: NodeJS.Timeout | null;
      shouldReconnect: boolean;
    };
    vi.spyOn(internals, 'refreshReloadPolicy').mockResolvedValue();
    vi.spyOn(internals, 'initDeviceIdentity').mockResolvedValue();

    await expect(manager.start({ reason: 'test', source: 'unit-test' })).rejects.toMatchObject({
      code: 'GATEWAY_PORT_OWNERSHIP_CONFLICT',
    });

    expect(mockRunGatewayStartupSequence).toHaveBeenCalledTimes(1);
    expect(internals.shouldReconnect).toBe(false);
    expect(internals.reconnectTimer).toBeNull();
    expect(manager.getStatus()).toMatchObject({
      state: 'error',
      reconnectAttempts: 0,
    });
    expect(manager.getDiagnostics().recentLifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'start_blocked',
          reason: 'external-gateway-port-owner',
          source: 'unit-test',
        }),
      ]),
    );

    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockRunGatewayStartupSequence).toHaveBeenCalledTimes(1);
  });

  it('preserves auto-reconnect for ordinary transient startup failures', async () => {
    mockRunGatewayStartupSequence.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager({
      maxAttempts: 10,
      baseDelay: 1_000,
      maxDelay: 30_000,
    });
    const internals = manager as unknown as {
      refreshReloadPolicy: (force?: boolean) => Promise<void>;
      initDeviceIdentity: () => Promise<void>;
      reconnectTimer: NodeJS.Timeout | null;
      shouldReconnect: boolean;
    };
    vi.spyOn(internals, 'refreshReloadPolicy').mockResolvedValue();
    vi.spyOn(internals, 'initDeviceIdentity').mockResolvedValue();

    await expect(manager.start({ reason: 'test', source: 'unit-test' })).rejects.toThrow(
      'ECONNREFUSED',
    );

    expect(internals.shouldReconnect).toBe(true);
    expect(internals.reconnectTimer).not.toBeNull();
    expect(manager.getStatus()).toMatchObject({
      state: 'reconnecting',
      reconnectAttempts: 1,
    });
    expect(manager.getDiagnostics().recentLifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'reconnect_scheduled',
          reason: 'start-failed',
          source: 'unit-test',
        }),
      ]),
    );
  });

  it('does not re-enable reconnect when a restart meets an ownership conflict', async () => {
    const {
      GatewayPortOwnershipConflictError,
    } = await import('@electron/gateway/supervisor');
    const conflict = new GatewayPortOwnershipConflictError(18789, ['9876'], true);
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const internals = manager as unknown as {
      status: { state: 'running' | 'stopped'; port: number };
      startLock: boolean;
      shouldReconnect: boolean;
      scheduleReconnect: () => void;
    };
    internals.status = { state: 'running', port: 18789 };
    internals.startLock = false;
    internals.shouldReconnect = true;

    vi.spyOn(manager, 'stop').mockImplementation(async () => {
      internals.shouldReconnect = false;
      internals.status = { state: 'stopped', port: 18789 };
    });
    vi.spyOn(manager, 'start').mockRejectedValue(conflict);
    const scheduleReconnect = vi.spyOn(internals, 'scheduleReconnect');

    await expect(manager.restart({ reason: 'test', source: 'unit-test' })).rejects.toMatchObject({
      code: 'GATEWAY_PORT_OWNERSHIP_CONFLICT',
    });

    expect(internals.shouldReconnect).toBe(false);
    expect(scheduleReconnect).not.toHaveBeenCalled();
  });
});
