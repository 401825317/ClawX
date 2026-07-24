// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const providerState = new Map<string, unknown>();
  return {
    providerState,
    prepareGatewayLaunchContext: vi.fn(),
    findExistingGatewayProcess: vi.fn(),
    runOpenClawDoctorRepair: vi.fn(),
    terminateOwnedGatewayProcess: vi.fn(),
    unloadLaunchctlGatewayService: vi.fn(),
    waitForPortFree: vi.fn(),
    warmupManagedPythonReadiness: vi.fn(),
    launchGatewayProcess: vi.fn(),
    runGatewayStartupSequence: vi.fn(),
    loadGatewayReloadPolicy: vi.fn(),
    loadOrCreateDeviceIdentity: vi.fn(),
    cancelLocalDeviceAutoApproval: vi.fn(),
    scheduleLocalDeviceAutoApproval: vi.fn(),
    providerStore: {
      get: vi.fn((key: string) => providerState.get(key)),
      has: vi.fn((key: string) => providerState.has(key)),
      set: vi.fn((key: string, value: unknown) => {
        providerState.set(key, value);
      }),
      delete: vi.fn((key: string) => providerState.delete(key)),
    },
  };
});

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

vi.mock('@electron/utils/telemetry', () => ({
  captureTelemetryEvent: vi.fn(),
  trackMetric: vi.fn(),
}));

vi.mock('@electron/utils/device-identity', () => ({
  loadOrCreateDeviceIdentity: mocks.loadOrCreateDeviceIdentity,
}));

vi.mock('@electron/utils/control-ui-device-pairing', () => ({
  cancelLocalDeviceAutoApproval: mocks.cancelLocalDeviceAutoApproval,
  scheduleLocalDeviceAutoApproval: mocks.scheduleLocalDeviceAutoApproval,
}));

vi.mock('@electron/services/providers/store-instance', () => ({
  getClawXProviderStore: async () => mocks.providerStore,
}));

vi.mock('@electron/gateway/config-sync', () => ({
  prepareGatewayLaunchContext: mocks.prepareGatewayLaunchContext,
}));

vi.mock('@electron/gateway/supervisor', () => ({
  findExistingGatewayProcess: mocks.findExistingGatewayProcess,
  runOpenClawDoctorRepair: mocks.runOpenClawDoctorRepair,
  terminateOwnedGatewayProcess: mocks.terminateOwnedGatewayProcess,
  unloadLaunchctlGatewayService: mocks.unloadLaunchctlGatewayService,
  waitForPortFree: mocks.waitForPortFree,
  warmupManagedPythonReadiness: mocks.warmupManagedPythonReadiness,
}));

vi.mock('@electron/gateway/process-launcher', () => ({
  launchGatewayProcess: mocks.launchGatewayProcess,
}));

vi.mock('@electron/gateway/startup-orchestrator', () => ({
  runGatewayStartupSequence: mocks.runGatewayStartupSequence,
}));

vi.mock('@electron/gateway/reload-policy', async () => {
  const actual = await vi.importActual<typeof import('@electron/gateway/reload-policy')>(
    '@electron/gateway/reload-policy',
  );
  return {
    ...actual,
    loadGatewayReloadPolicy: mocks.loadGatewayReloadPolicy,
  };
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeChild(pid = 4242): Electron.UtilityProcess {
  return { pid } as Electron.UtilityProcess;
}

const originalManagedDistribution = process.env.CLAWX_MANAGED_PROVIDER;
const originalPlatform = process.platform;

describe('GatewayManager managed runtime mutation barrier', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.providerState.clear();
    process.env.CLAWX_MANAGED_PROVIDER = '1';
    Object.defineProperty(process, 'platform', { value: originalPlatform });

    mocks.prepareGatewayLaunchContext.mockResolvedValue({});
    mocks.findExistingGatewayProcess.mockResolvedValue(null);
    mocks.runOpenClawDoctorRepair.mockResolvedValue(false);
    mocks.terminateOwnedGatewayProcess.mockResolvedValue(undefined);
    mocks.unloadLaunchctlGatewayService.mockResolvedValue(undefined);
    mocks.waitForPortFree.mockResolvedValue(undefined);
    mocks.loadGatewayReloadPolicy.mockResolvedValue({ mode: 'hybrid', debounceMs: 0 });
    mocks.loadOrCreateDeviceIdentity.mockResolvedValue({ deviceId: 'test-device' });
    mocks.runGatewayStartupSequence.mockImplementation(async (hooks: {
      assertLifecycle: (phase: string) => void;
      startProcess: () => Promise<void>;
    }) => {
      hooks.assertLifecycle('test/before-process');
      await hooks.startProcess();
      hooks.assertLifecycle('test/after-process');
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalManagedDistribution === undefined) {
      delete process.env.CLAWX_MANAGED_PROVIDER;
    } else {
      process.env.CLAWX_MANAGED_PROVIDER = originalManagedDistribution;
    }
  });

  it('does not spawn from stopped state while a managed transaction holds the lease', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const barrier = await import('@electron/gateway/managed-runtime-mutation-barrier');
    const manager = new GatewayManager();
    const lease = manager.acquireManagedRuntimeMutationLease();

    try {
      await expect(manager.start()).rejects.toBeInstanceOf(barrier.ManagedRuntimeStartBlockedError);
      expect(mocks.launchGatewayProcess).not.toHaveBeenCalled();
      expect(manager.getStatus().state).toBe('stopped');
    } finally {
      manager.releaseManagedRuntimeMutationLease(lease);
    }
  });

  it('checks the lifecycle immediately before forking', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const expected = new Error('superseded before fork');
    const guard = vi.fn(() => {
      throw expected;
    });
    const startProcess = (manager as unknown as {
      startProcess: (assertCanLaunch: (phase: string) => void) => Promise<void>;
    }).startProcess.bind(manager);

    await expect(startProcess(guard)).rejects.toBe(expected);

    expect(guard).toHaveBeenCalledWith('start/process-before-fork');
    expect(mocks.launchGatewayProcess).not.toHaveBeenCalled();
  });

  it('terminates a child that spawns after a managed lease is acquired', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const barrier = await import('@electron/gateway/managed-runtime-mutation-barrier');
    const manager = new GatewayManager();
    const child = fakeChild();
    const launch = deferred<{ child: Electron.UtilityProcess; lastSpawnSummary: string }>();
    mocks.launchGatewayProcess.mockImplementationOnce(async (options: {
      onSpawn: (pid: number | undefined) => void;
    }) => {
      const result = await launch.promise;
      options.onSpawn(result.child.pid);
      return result;
    });
    const reconnectSpy = vi.spyOn(
      manager as unknown as { scheduleReconnect: () => void },
      'scheduleReconnect',
    );

    const starting = manager.start();
    await vi.waitFor(() => expect(mocks.launchGatewayProcess).toHaveBeenCalledTimes(1));
    const lease = barrier.acquireManagedRuntimeMutationLease();

    try {
      launch.resolve({ child, lastSpawnSummary: 'test-spawn' });

      await expect(starting).rejects.toBeInstanceOf(barrier.ManagedRuntimeStartBlockedError);
      expect(mocks.terminateOwnedGatewayProcess).toHaveBeenCalledWith(child);
      expect(reconnectSpy).not.toHaveBeenCalled();
      expect((manager as unknown as { process: Electron.UtilityProcess | null }).process).toBeNull();
      expect((manager as unknown as { ownsProcess: boolean }).ownsProcess).toBe(false);
      expect(manager.getStatus().pid).toBeUndefined();
    } finally {
      barrier.releaseManagedRuntimeMutationLease(lease);
    }
  });

  it('waits for a late child to be terminated before stop resolves', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const child = fakeChild(5151);
    const launch = deferred<{ child: Electron.UtilityProcess; lastSpawnSummary: string }>();
    const termination = deferred<void>();
    mocks.launchGatewayProcess.mockReturnValueOnce(launch.promise);
    mocks.terminateOwnedGatewayProcess.mockReturnValueOnce(termination.promise);

    const starting = manager.start();
    await vi.waitFor(() => expect(mocks.launchGatewayProcess).toHaveBeenCalledTimes(1));

    // Managed transactions acquire first, then stop and drain any superseded launch.
    const lease = manager.acquireManagedRuntimeMutationLease();
    let stopResolved = false;
    const stopping = manager.stop().then(() => {
      stopResolved = true;
    });

    launch.resolve({ child, lastSpawnSummary: 'late-spawn' });
    await vi.waitFor(() => expect(mocks.terminateOwnedGatewayProcess).toHaveBeenCalledWith(child));
    expect(stopResolved).toBe(false);

    termination.resolve();
    await Promise.all([starting, stopping]);

    expect(stopResolved).toBe(true);
    expect(manager.getStatus().state).toBe('stopped');
    expect((manager as unknown as { process: Electron.UtilityProcess | null }).process).toBeNull();
    manager.releaseManagedRuntimeMutationLease(lease);
  });

  it('fails quiescence and retains a late child when termination keeps failing', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const child = fakeChild(5252);
    const launch = deferred<{ child: Electron.UtilityProcess; lastSpawnSummary: string }>();
    mocks.launchGatewayProcess.mockImplementationOnce(async (options: {
      onSpawn: (pid: number | undefined) => void;
    }) => {
      const result = await launch.promise;
      options.onSpawn(result.child.pid);
      return result;
    });
    mocks.terminateOwnedGatewayProcess
      .mockRejectedValueOnce(new Error('post-fork termination failed'))
      .mockRejectedValueOnce(new Error('stop termination failed'));

    const startFailure = manager.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.launchGatewayProcess).toHaveBeenCalledTimes(1));
    const lease = manager.acquireManagedRuntimeMutationLease();

    try {
      const stopping = manager.stop();
      launch.resolve({ child, lastSpawnSummary: 'late-spawn' });

      await expect(stopping).rejects.toThrow('stop termination failed');
      const lifecycleFailure = await startFailure;
      expect(lifecycleFailure).toBeInstanceOf(AggregateError);
      expect((lifecycleFailure as AggregateError).errors).toEqual([
        expect.objectContaining({ name: 'LifecycleSupersededError' }),
        expect.objectContaining({ message: 'post-fork termination failed' }),
      ]);
      expect(mocks.terminateOwnedGatewayProcess).toHaveBeenCalledTimes(2);
      expect((manager as unknown as { process: Electron.UtilityProcess | null }).process).toBe(child);
      expect((manager as unknown as { ownsProcess: boolean }).ownsProcess).toBe(true);
      expect(manager.getStatus().pid).toBe(5252);
      expect(mocks.providerStore.set).not.toHaveBeenCalled();
    } finally {
      mocks.terminateOwnedGatewayProcess.mockResolvedValue(undefined);
      await manager.stop();
      manager.releaseManagedRuntimeMutationLease(lease);
    }
  });

  it('does not schedule reconnect when restart is blocked by the mutation barrier', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const barrier = await import('@electron/gateway/managed-runtime-mutation-barrier');
    const manager = new GatewayManager();
    const lease = manager.acquireManagedRuntimeMutationLease();
    const internals = manager as unknown as {
      status: { state: 'running' | 'stopped'; port: number };
      shouldReconnect: boolean;
      scheduleReconnect: () => void;
    };
    internals.status = { state: 'running', port: 18789 };
    internals.shouldReconnect = true;
    vi.spyOn(manager, 'stop').mockImplementation(async () => {
      internals.status = { state: 'stopped', port: 18789 };
      internals.shouldReconnect = false;
    });
    vi.spyOn(manager, 'start').mockRejectedValue(new barrier.ManagedRuntimeStartBlockedError());
    const reconnectSpy = vi.spyOn(internals, 'scheduleReconnect');

    try {
      await expect(manager.restart(lease)).rejects.toBeInstanceOf(barrier.ManagedRuntimeStartBlockedError);
      expect(reconnectSpy).not.toHaveBeenCalled();
      expect(internals.shouldReconnect).toBe(false);
    } finally {
      manager.releaseManagedRuntimeMutationLease(lease);
    }
  });

  it('preserves the managed lease when Windows reload falls back to restart', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const lease = manager.acquireManagedRuntimeMutationLease();
    (manager as unknown as {
      process: Electron.UtilityProcess;
      status: { state: 'running'; port: number; connectedAt: number };
    }).process = fakeChild(6161);
    (manager as unknown as {
      status: { state: 'running'; port: number; connectedAt: number };
    }).status = {
      state: 'running',
      port: 18789,
      connectedAt: Date.now() - 10_000,
    };
    const restartSpy = vi.spyOn(manager, 'restart').mockResolvedValue();

    try {
      await manager.reload(lease);
      expect(restartSpy).toHaveBeenCalledWith(lease);
    } finally {
      manager.releaseManagedRuntimeMutationLease(lease);
    }
  });
});
