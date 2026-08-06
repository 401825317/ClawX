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
    prepareManagedOpenClawDowngrade: vi.fn(),
    commitManagedOpenClawDowngrade: vi.fn(),
    rollbackOpenClawDowngrade: vi.fn(),
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

vi.mock('@electron/gateway/openclaw-downgrade', () => ({
  prepareManagedOpenClawDowngrade: mocks.prepareManagedOpenClawDowngrade,
  commitManagedOpenClawDowngrade: mocks.commitManagedOpenClawDowngrade,
  rollbackOpenClawDowngrade: mocks.rollbackOpenClawDowngrade,
  isOpenClawDowngradeBlockedError: (error: unknown) => (
    error instanceof Error && error.name === 'OpenClawDowngradeBlockedError'
  ),
  isOpenClawCommandTerminationUnconfirmedError: (error: unknown) => (
    error instanceof Error && error.name === 'OpenClawCommandTerminationUnconfirmedError'
  ),
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

class TestOpenClawCommandTerminationUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenClawCommandTerminationUnconfirmedError';
  }
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
    mocks.prepareManagedOpenClawDowngrade.mockResolvedValue(null);
    mocks.commitManagedOpenClawDowngrade.mockResolvedValue(undefined);
    mocks.rollbackOpenClawDowngrade.mockResolvedValue(undefined);
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

  it('prepares and commits the 6.11 handoff around the first managed Gateway ready event', async () => {
    const transaction = {
      configPath: '/tmp/openclaw.json',
      backupPath: '/tmp/openclaw.json.bak',
      fromVersion: '2026.6.11',
      toVersion: '2026.6.10',
    };
    const child = fakeChild(6110);
    mocks.prepareManagedOpenClawDowngrade.mockResolvedValueOnce(transaction);
    mocks.launchGatewayProcess.mockResolvedValueOnce({ child, lastSpawnSummary: 'downgrade-spawn' });
    mocks.runGatewayStartupSequence.mockImplementationOnce(async (hooks: {
      startProcess: () => Promise<void>;
      afterManagedGatewayReady?: () => Promise<void>;
      canRecoverStartup?: () => boolean;
    }) => {
      expect(hooks.canRecoverStartup?.()).toBe(false);
      await hooks.startProcess();
      await hooks.afterManagedGatewayReady?.();
      expect(hooks.canRecoverStartup?.()).toBe(true);
    });

    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    await manager.start();

    expect(mocks.prepareManagedOpenClawDowngrade).toHaveBeenCalledTimes(1);
    expect(mocks.prepareManagedOpenClawDowngrade.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prepareGatewayLaunchContext.mock.invocationCallOrder[0]!,
    );
    expect(mocks.launchGatewayProcess).toHaveBeenCalledWith(expect.objectContaining({
      allowOlderBinaryDestructiveActions: true,
    }));
    expect(mocks.commitManagedOpenClawDowngrade).toHaveBeenCalledWith(transaction);
  });

  it('terminates and rolls back a failed controlled handoff without reconnecting', async () => {
    const transaction = {
      configPath: '/tmp/openclaw.json',
      backupPath: '/tmp/openclaw.json.bak',
      fromVersion: '2026.6.11',
      toVersion: '2026.6.10',
    };
    const child = fakeChild(6111);
    mocks.prepareManagedOpenClawDowngrade.mockResolvedValueOnce(transaction);
    mocks.launchGatewayProcess.mockResolvedValueOnce({ child, lastSpawnSummary: 'downgrade-spawn' });
    mocks.commitManagedOpenClawDowngrade.mockRejectedValueOnce(new Error('stamp failed'));
    mocks.runGatewayStartupSequence.mockImplementationOnce(async (hooks: {
      startProcess: () => Promise<void>;
      afterManagedGatewayReady?: () => Promise<void>;
    }) => {
      await hooks.startProcess();
      await hooks.afterManagedGatewayReady?.();
    });

    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const reconnectSpy = vi.spyOn(
      manager as unknown as { scheduleReconnect: () => void },
      'scheduleReconnect',
    );

    await expect(manager.start()).rejects.toThrow('stamp failed');

    expect(mocks.terminateOwnedGatewayProcess).toHaveBeenCalledWith(child);
    expect(mocks.rollbackOpenClawDowngrade).toHaveBeenCalledWith(transaction);
    expect(reconnectSpy).not.toHaveBeenCalled();
    expect((manager as unknown as { shouldReconnect: boolean }).shouldReconnect).toBe(false);
  });

  it('isolates an unconfirmed CLI termination without restoring the config backup', async () => {
    const transaction = {
      configPath: '/tmp/openclaw.json',
      backupPath: '/tmp/openclaw.json.bak',
      fromVersion: '2026.6.11',
      toVersion: '2026.6.10',
    };
    const child = fakeChild(6120);
    const commitError = new TestOpenClawCommandTerminationUnconfirmedError(
      'Bundled OpenClaw command termination could not be confirmed',
    );
    mocks.prepareManagedOpenClawDowngrade.mockResolvedValueOnce(transaction);
    mocks.launchGatewayProcess.mockResolvedValueOnce({ child, lastSpawnSummary: 'downgrade-spawn' });
    mocks.commitManagedOpenClawDowngrade.mockRejectedValueOnce(commitError);
    mocks.runGatewayStartupSequence.mockImplementationOnce(async (hooks: {
      startProcess: () => Promise<void>;
      afterManagedGatewayReady?: () => Promise<void>;
    }) => {
      await hooks.startProcess();
      await hooks.afterManagedGatewayReady?.();
    });

    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const internals = manager as unknown as {
      openClawDowngradeTransaction: unknown;
      ownsProcess: boolean;
      process: Electron.UtilityProcess | null;
      shouldReconnect: boolean;
      scheduleReconnect: () => void;
    };
    const reconnectSpy = vi.spyOn(internals, 'scheduleReconnect');
    mocks.terminateOwnedGatewayProcess.mockImplementationOnce(async () => {
      expect(internals.openClawDowngradeTransaction).toBeNull();
    });

    const failure = await manager.start().catch((error: unknown) => error);

    expect(failure).toBe(commitError);
    expect(mocks.terminateOwnedGatewayProcess).toHaveBeenCalledWith(child);
    expect(mocks.rollbackOpenClawDowngrade).not.toHaveBeenCalled();
    expect(reconnectSpy).not.toHaveBeenCalled();
    expect(internals.shouldReconnect).toBe(false);
    expect(internals.openClawDowngradeTransaction).toBeNull();
    expect(internals.process).toBeNull();
    expect(internals.ownsProcess).toBe(false);
  });

  it('blocks later starts on the same manager after an unconfirmed CLI termination', async () => {
    const transaction = {
      configPath: '/tmp/openclaw.json',
      backupPath: '/tmp/openclaw.json.bak',
      fromVersion: '2026.6.11',
      toVersion: '2026.6.10',
    };
    const child = fakeChild(6122);
    const commitError = new TestOpenClawCommandTerminationUnconfirmedError(
      'Bundled OpenClaw command termination could not be confirmed',
    );
    mocks.prepareManagedOpenClawDowngrade.mockResolvedValueOnce(transaction);
    mocks.launchGatewayProcess.mockResolvedValueOnce({ child, lastSpawnSummary: 'downgrade-spawn' });
    mocks.commitManagedOpenClawDowngrade.mockRejectedValueOnce(commitError);
    mocks.runGatewayStartupSequence.mockImplementationOnce(async (hooks: {
      startProcess: () => Promise<void>;
      connect: (port: number) => Promise<void>;
      afterManagedGatewayReady?: () => Promise<void>;
    }) => {
      await hooks.startProcess();
      await hooks.connect(18789);
      await hooks.afterManagedGatewayReady?.();
    });

    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const connectSpy = vi.spyOn(
      manager as unknown as { connect: (port: number) => Promise<void> },
      'connect',
    ).mockResolvedValue(undefined);

    await expect(manager.start()).rejects.toBe(commitError);
    const callsAfterIsolation = {
      prepare: mocks.prepareManagedOpenClawDowngrade.mock.calls.length,
      startup: mocks.runGatewayStartupSequence.mock.calls.length,
      launch: mocks.launchGatewayProcess.mock.calls.length,
      connect: connectSpy.mock.calls.length,
    };

    const retryFailure = await manager.start().catch((error: unknown) => error);

    expect(retryFailure).toEqual(expect.objectContaining({
      name: 'GatewayProcessIsolationError',
    }));
    expect(mocks.prepareManagedOpenClawDowngrade).toHaveBeenCalledTimes(callsAfterIsolation.prepare);
    expect(mocks.runGatewayStartupSequence).toHaveBeenCalledTimes(callsAfterIsolation.startup);
    expect(mocks.launchGatewayProcess).toHaveBeenCalledTimes(callsAfterIsolation.launch);
    expect(connectSpy).toHaveBeenCalledTimes(callsAfterIsolation.connect);
    expect(mocks.rollbackOpenClawDowngrade).not.toHaveBeenCalled();

    // A new manager represents a new application process lifecycle and is not isolated.
    mocks.runGatewayStartupSequence.mockResolvedValueOnce(undefined);
    const freshManager = new GatewayManager();
    await expect(freshManager.start()).resolves.toBeUndefined();
    expect(mocks.prepareManagedOpenClawDowngrade).toHaveBeenCalledTimes(
      callsAfterIsolation.prepare + 1,
    );
  });

  it('allows a manual retry after an ordinary commit failure is rolled back', async () => {
    const transaction = {
      configPath: '/tmp/openclaw.json',
      backupPath: '/tmp/openclaw.json.bak',
      fromVersion: '2026.6.11',
      toVersion: '2026.6.10',
    };
    const firstChild = fakeChild(6123);
    const secondChild = fakeChild(6124);
    mocks.prepareManagedOpenClawDowngrade.mockResolvedValueOnce(transaction);
    mocks.launchGatewayProcess
      .mockResolvedValueOnce({ child: firstChild, lastSpawnSummary: 'first-spawn' })
      .mockResolvedValueOnce({ child: secondChild, lastSpawnSummary: 'retry-spawn' });
    mocks.commitManagedOpenClawDowngrade.mockRejectedValueOnce(new Error('stamp failed'));
    mocks.runGatewayStartupSequence
      .mockImplementationOnce(async (hooks: {
        startProcess: () => Promise<void>;
        afterManagedGatewayReady?: () => Promise<void>;
      }) => {
        await hooks.startProcess();
        await hooks.afterManagedGatewayReady?.();
      })
      .mockImplementationOnce(async (hooks: { startProcess: () => Promise<void> }) => {
        await hooks.startProcess();
      });

    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();

    await expect(manager.start()).rejects.toThrow('stamp failed');
    await expect(manager.start()).resolves.toBeUndefined();

    expect(mocks.prepareManagedOpenClawDowngrade).toHaveBeenCalledTimes(2);
    expect(mocks.launchGatewayProcess).toHaveBeenCalledTimes(2);
    expect(mocks.rollbackOpenClawDowngrade).toHaveBeenCalledOnce();
    expect(mocks.rollbackOpenClawDowngrade).toHaveBeenCalledWith(transaction);
  });

  it('preserves both failures when Gateway termination fails during CLI isolation', async () => {
    const transaction = {
      configPath: '/tmp/openclaw.json',
      backupPath: '/tmp/openclaw.json.bak',
      fromVersion: '2026.6.11',
      toVersion: '2026.6.10',
    };
    const child = fakeChild(6121);
    const commitError = new TestOpenClawCommandTerminationUnconfirmedError(
      'Bundled OpenClaw command termination could not be confirmed',
    );
    const terminationError = new Error('Gateway termination failed');
    mocks.prepareManagedOpenClawDowngrade.mockResolvedValueOnce(transaction);
    mocks.launchGatewayProcess.mockResolvedValueOnce({ child, lastSpawnSummary: 'downgrade-spawn' });
    mocks.commitManagedOpenClawDowngrade.mockRejectedValueOnce(commitError);
    mocks.terminateOwnedGatewayProcess.mockRejectedValueOnce(terminationError);
    mocks.runGatewayStartupSequence.mockImplementationOnce(async (hooks: {
      startProcess: () => Promise<void>;
      afterManagedGatewayReady?: () => Promise<void>;
    }) => {
      await hooks.startProcess();
      await hooks.afterManagedGatewayReady?.();
    });

    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const internals = manager as unknown as {
      openClawDowngradeTransaction: unknown;
      process: Electron.UtilityProcess | null;
      shouldReconnect: boolean;
      scheduleReconnect: () => void;
    };
    const reconnectSpy = vi.spyOn(internals, 'scheduleReconnect');

    const failure = await manager.start().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([commitError, terminationError]);
    expect(mocks.rollbackOpenClawDowngrade).not.toHaveBeenCalled();
    expect(reconnectSpy).not.toHaveBeenCalled();
    expect(internals.shouldReconnect).toBe(false);
    expect(internals.openClawDowngradeTransaction).toBeNull();
    expect(internals.process).toBe(child);
  });

  it('clears the exited child pid when isolation termination emits onExit first', async () => {
    const transaction = {
      configPath: '/tmp/openclaw.json',
      backupPath: '/tmp/openclaw.json.bak',
      fromVersion: '2026.6.11',
      toVersion: '2026.6.10',
    };
    const child = fakeChild(6125);
    const commitError = new TestOpenClawCommandTerminationUnconfirmedError(
      'Bundled OpenClaw command termination could not be confirmed',
    );
    let launchOptions: {
      onSpawn: (pid: number | undefined) => void;
      onExit: (child: Electron.UtilityProcess, code: number | null) => void;
    } | null = null;
    mocks.prepareManagedOpenClawDowngrade.mockResolvedValueOnce(transaction);
    mocks.launchGatewayProcess.mockImplementationOnce(async (options: typeof launchOptions) => {
      launchOptions = options;
      options!.onSpawn(child.pid);
      return { child, lastSpawnSummary: 'downgrade-spawn' };
    });
    mocks.commitManagedOpenClawDowngrade.mockRejectedValueOnce(commitError);
    mocks.runGatewayStartupSequence.mockImplementationOnce(async (hooks: {
      startProcess: () => Promise<void>;
      afterManagedGatewayReady?: () => Promise<void>;
    }) => {
      await hooks.startProcess();
      await hooks.afterManagedGatewayReady?.();
    });
    mocks.terminateOwnedGatewayProcess.mockImplementationOnce(async () => {
      launchOptions!.onExit(child, 1);
    });

    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const internals = manager as unknown as {
      ownsProcess: boolean;
      process: Electron.UtilityProcess | null;
      reconnectTimer: NodeJS.Timeout | null;
      shouldReconnect: boolean;
    };

    await expect(manager.start()).rejects.toBe(commitError);

    expect(internals.process).toBeNull();
    expect(internals.ownsProcess).toBe(false);
    expect(manager.getStatus().pid).toBeUndefined();
    expect(internals.shouldReconnect).toBe(false);
    expect(internals.reconnectTimer).toBeNull();
    expect(mocks.launchGatewayProcess).toHaveBeenCalledOnce();
    expect(mocks.rollbackOpenClawDowngrade).not.toHaveBeenCalled();
  });

  it('does not clear a replacement child pid after the isolated child exits', async () => {
    const transaction = {
      configPath: '/tmp/openclaw.json',
      backupPath: '/tmp/openclaw.json.bak',
      fromVersion: '2026.6.11',
      toVersion: '2026.6.10',
    };
    const child = fakeChild(6126);
    const replacementChild = fakeChild(6127);
    const commitError = new TestOpenClawCommandTerminationUnconfirmedError(
      'Bundled OpenClaw command termination could not be confirmed',
    );
    let launchOptions: {
      onSpawn: (pid: number | undefined) => void;
      onExit: (child: Electron.UtilityProcess, code: number | null) => void;
    } | null = null;
    mocks.prepareManagedOpenClawDowngrade.mockResolvedValueOnce(transaction);
    mocks.launchGatewayProcess.mockImplementationOnce(async (options: typeof launchOptions) => {
      launchOptions = options;
      options!.onSpawn(child.pid);
      return { child, lastSpawnSummary: 'downgrade-spawn' };
    });
    mocks.commitManagedOpenClawDowngrade.mockRejectedValueOnce(commitError);
    mocks.runGatewayStartupSequence.mockImplementationOnce(async (hooks: {
      startProcess: () => Promise<void>;
      afterManagedGatewayReady?: () => Promise<void>;
    }) => {
      await hooks.startProcess();
      await hooks.afterManagedGatewayReady?.();
    });

    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const internals = manager as unknown as {
      ownsProcess: boolean;
      process: Electron.UtilityProcess | null;
    };
    mocks.terminateOwnedGatewayProcess.mockImplementationOnce(async () => {
      launchOptions!.onExit(child, 1);
      internals.process = replacementChild;
      internals.ownsProcess = true;
      launchOptions!.onSpawn(replacementChild.pid);
    });

    await expect(manager.start()).rejects.toBe(commitError);

    expect(internals.process).toBe(replacementChild);
    expect(internals.ownsProcess).toBe(true);
    expect(manager.getStatus().pid).toBe(replacementChild.pid);
    expect(mocks.rollbackOpenClawDowngrade).not.toHaveBeenCalled();
  });

  it('terminates and rolls back when owned-process finalization fails', async () => {
    const transaction = {
      configPath: '/tmp/openclaw.json',
      backupPath: '/tmp/openclaw.json.bak',
      fromVersion: '2026.6.11',
      toVersion: '2026.6.10',
    };
    const child = fakeChild(6114);
    mocks.prepareManagedOpenClawDowngrade.mockResolvedValueOnce(transaction);
    mocks.commitManagedOpenClawDowngrade.mockRejectedValueOnce(new Error('stamp failed'));
    mocks.runGatewayStartupSequence.mockImplementationOnce(async (hooks: {
      afterManagedGatewayReady?: () => Promise<void>;
    }) => {
      await hooks.afterManagedGatewayReady?.();
    });

    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const internals = manager as unknown as {
      process: Electron.UtilityProcess | null;
      ownsProcess: boolean;
      shouldReconnect: boolean;
      scheduleReconnect: () => void;
    };
    internals.process = child;
    internals.ownsProcess = true;
    const reconnectSpy = vi.spyOn(internals, 'scheduleReconnect');

    await expect(manager.start()).rejects.toThrow('stamp failed');

    expect(mocks.launchGatewayProcess).not.toHaveBeenCalled();
    expect(mocks.terminateOwnedGatewayProcess).toHaveBeenCalledWith(child);
    expect(mocks.rollbackOpenClawDowngrade).toHaveBeenCalledWith(transaction);
    expect(reconnectSpy).not.toHaveBeenCalled();
    expect(internals.shouldReconnect).toBe(false);
  });

  it('does not restore the backup when the controlled Gateway cannot be terminated', async () => {
    const transaction = {
      configPath: '/tmp/openclaw.json',
      backupPath: '/tmp/openclaw.json.bak',
      fromVersion: '2026.6.11',
      toVersion: '2026.6.10',
    };
    const child = fakeChild(6112);
    mocks.prepareManagedOpenClawDowngrade.mockResolvedValueOnce(transaction);
    mocks.launchGatewayProcess.mockResolvedValueOnce({ child, lastSpawnSummary: 'downgrade-spawn' });
    mocks.commitManagedOpenClawDowngrade.mockRejectedValueOnce(new Error('stamp failed'));
    mocks.terminateOwnedGatewayProcess.mockRejectedValueOnce(new Error('termination failed'));
    mocks.runGatewayStartupSequence.mockImplementationOnce(async (hooks: {
      startProcess: () => Promise<void>;
      afterManagedGatewayReady?: () => Promise<void>;
    }) => {
      await hooks.startProcess();
      await hooks.afterManagedGatewayReady?.();
    });

    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const reconnectSpy = vi.spyOn(
      manager as unknown as { scheduleReconnect: () => void },
      'scheduleReconnect',
    );

    const failure = await manager.start().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'stamp failed' }),
      expect.objectContaining({ message: 'termination failed' }),
    ]);
    expect(mocks.rollbackOpenClawDowngrade).not.toHaveBeenCalled();
    expect(reconnectSpy).not.toHaveBeenCalled();
    expect((manager as unknown as { shouldReconnect: boolean }).shouldReconnect).toBe(false);
    expect((manager as unknown as { process: Electron.UtilityProcess | null }).process).toBe(child);
  });

  it('stops every reconnect path when an unmanaged startup hits the future-config guard', async () => {
    const child = fakeChild(6113);
    let launchOptions: {
      onStderrLine: (line: string) => void;
      onExit: (child: Electron.UtilityProcess, code: number | null) => void;
    } | null = null;
    mocks.launchGatewayProcess.mockImplementationOnce(async (options: typeof launchOptions) => {
      launchOptions = options;
      return { child, lastSpawnSummary: 'future-config-spawn' };
    });
    mocks.runGatewayStartupSequence.mockImplementationOnce(async (hooks: {
      startProcess: () => Promise<void>;
    }) => {
      await hooks.startProcess();
      launchOptions!.onStderrLine(
        'Your OpenClaw config was written by version 2026.6.11, but this command is running 2026.6.10.',
      );
      launchOptions!.onExit(child, 1);
      throw new Error('Gateway process exited before becoming ready (code=1)');
    });

    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const reconnectSpy = vi.spyOn(
      manager as unknown as { scheduleReconnect: () => void },
      'scheduleReconnect',
    );

    await expect(manager.start()).rejects.toThrow('Gateway process exited before becoming ready');

    expect(reconnectSpy).not.toHaveBeenCalled();
    expect((manager as unknown as { shouldReconnect: boolean }).shouldReconnect).toBe(false);
    expect(mocks.rollbackOpenClawDowngrade).not.toHaveBeenCalled();
  });

  it('does not restore a backup when handoff stops before managed config mutation begins', async () => {
    const transaction = {
      configPath: '/tmp/openclaw.json',
      backupPath: '/tmp/openclaw.json.bak',
      fromVersion: '2026.6.11',
      toVersion: '2026.6.10',
    };
    mocks.prepareManagedOpenClawDowngrade.mockResolvedValueOnce(transaction);
    mocks.findExistingGatewayProcess.mockResolvedValueOnce({ port: 18789 });
    mocks.runGatewayStartupSequence.mockImplementationOnce(async (hooks: {
      findExistingGateway: (port: number) => Promise<unknown>;
    }) => {
      await hooks.findExistingGateway(18789);
    });

    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();

    await expect(manager.start()).rejects.toThrow(
      'Cannot hand off OpenClaw config while another Gateway is running',
    );

    expect(mocks.rollbackOpenClawDowngrade).not.toHaveBeenCalled();
    expect(mocks.launchGatewayProcess).not.toHaveBeenCalled();
    expect((manager as unknown as { openClawDowngradeTransaction: unknown }).openClawDowngradeTransaction)
      .toBeNull();
    expect((manager as unknown as { shouldReconnect: boolean }).shouldReconnect).toBe(false);
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
