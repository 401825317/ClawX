import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
  default: {
    readFile: mockReadFile,
  },
}));

import {
  DEFAULT_GATEWAY_RELOAD_POLICY,
  loadGatewayReloadPolicy,
  parseGatewayReloadPolicy,
} from '@electron/gateway/reload-policy';

describe('parseGatewayReloadPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns defaults when config is missing', () => {
    expect(parseGatewayReloadPolicy(undefined)).toEqual(DEFAULT_GATEWAY_RELOAD_POLICY);
  });

  it('parses mode and debounce from gateway.reload', () => {
    const result = parseGatewayReloadPolicy({
      gateway: {
        reload: {
          mode: 'off',
          debounceMs: 3000,
        },
      },
    });

    expect(result).toEqual({ mode: 'off', debounceMs: 3000 });
  });

  it('normalizes invalid mode and debounce bounds', () => {
    const negative = parseGatewayReloadPolicy({
      gateway: { reload: { mode: 'invalid', debounceMs: -100 } },
    });
    expect(negative).toEqual({
      mode: DEFAULT_GATEWAY_RELOAD_POLICY.mode,
      debounceMs: 0,
    });

    const overMax = parseGatewayReloadPolicy({
      gateway: { reload: { mode: 'hybrid', debounceMs: 600_000 } },
    });
    expect(overMax).toEqual({ mode: 'hybrid', debounceMs: 60_000 });
  });

  it('falls back to default mode for non-string or unknown mode values', () => {
    const unknownString = parseGatewayReloadPolicy({
      gateway: { reload: { mode: 'HYBRID', debounceMs: 1200 } },
    });
    expect(unknownString.mode).toBe(DEFAULT_GATEWAY_RELOAD_POLICY.mode);

    const nonString = parseGatewayReloadPolicy({
      gateway: { reload: { mode: { value: 'reload' }, debounceMs: 1200 } },
    });
    expect(nonString.mode).toBe(DEFAULT_GATEWAY_RELOAD_POLICY.mode);
  });

  it('handles malformed gateway/reload shapes', () => {
    const malformedGateway = parseGatewayReloadPolicy({ gateway: 'bad-shape' });
    expect(malformedGateway).toEqual(DEFAULT_GATEWAY_RELOAD_POLICY);

    const malformedReload = parseGatewayReloadPolicy({
      gateway: { reload: ['bad-shape'] },
    });
    expect(malformedReload).toEqual(DEFAULT_GATEWAY_RELOAD_POLICY);
  });

  it('normalizes debounce boundary and rounding behavior', () => {
    const atMin = parseGatewayReloadPolicy({
      gateway: { reload: { mode: 'reload', debounceMs: 0 } },
    });
    expect(atMin).toEqual({ mode: 'reload', debounceMs: 0 });

    const roundsUpToCap = parseGatewayReloadPolicy({
      gateway: { reload: { mode: 'reload', debounceMs: 60_000.5 } },
    });
    expect(roundsUpToCap).toEqual({ mode: 'reload', debounceMs: 60_000 });

    const roundsDownAtCap = parseGatewayReloadPolicy({
      gateway: { reload: { mode: 'reload', debounceMs: 60_000.4 } },
    });
    expect(roundsDownAtCap).toEqual({ mode: 'reload', debounceMs: 60_000 });
  });
});

describe('loadGatewayReloadPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns defaults when config read fails', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('EACCES'));

    await expect(loadGatewayReloadPolicy()).resolves.toEqual(DEFAULT_GATEWAY_RELOAD_POLICY);
    expect(mockReadFile).toHaveBeenCalledOnce();
  });

  it('returns defaults when config JSON is malformed', async () => {
    mockReadFile.mockResolvedValueOnce('{');

    await expect(loadGatewayReloadPolicy()).resolves.toEqual(DEFAULT_GATEWAY_RELOAD_POLICY);
  });

  it('returns defaults when config JSON has malformed shape', async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        gateway: { reload: ['malformed'] },
      }),
    );

    await expect(loadGatewayReloadPolicy()).resolves.toEqual(DEFAULT_GATEWAY_RELOAD_POLICY);
  });

  it('loads config and applies invalid mode fallback', async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        gateway: { reload: { mode: 'unknown-mode', debounceMs: 1350 } },
      }),
    );

    await expect(loadGatewayReloadPolicy()).resolves.toEqual({
      mode: DEFAULT_GATEWAY_RELOAD_POLICY.mode,
      debounceMs: 1350,
    });
  });

  it('loads config and keeps debounce boundary values', async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        gateway: { reload: { mode: 'restart', debounceMs: 60_000 } },
      }),
    );

    await expect(loadGatewayReloadPolicy()).resolves.toEqual({
      mode: 'restart',
      debounceMs: 60_000,
    });
  });
});

describe('GatewayManager reload deferral', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
  });

  it('defers reload while a runtime run is active and flushes as a deferred restart after run.ended', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();

    const internals = manager as unknown as {
      shouldReconnect: boolean;
      status: { state: string; port: number; connectedAt?: number };
      startLock: boolean;
      process: { pid: number } | null;
      reloadPolicy: { mode: 'reload' | 'restart' | 'hybrid' | 'off'; debounceMs: number };
      refreshReloadPolicy: (force?: boolean) => Promise<void>;
    };

    internals.status = {
      state: 'running',
      port: 18789,
      connectedAt: Date.now() - 60_000,
    };
    internals.startLock = false;
    internals.shouldReconnect = true;
    internals.process = { pid: 4321 };
    internals.reloadPolicy = { mode: 'reload', debounceMs: 0 };

    vi.spyOn(internals, 'refreshReloadPolicy').mockResolvedValue();
    const restartSpy = vi.spyOn(manager, 'restart').mockResolvedValue();

    manager.emit('chat:runtime-event', {
      type: 'run.started',
      runId: 'run-reload',
      sessionKey: 'agent:main:main',
    });

    await manager.reload({
      reason: 'channel-config-save',
      source: 'test',
    });

    expect(restartSpy).not.toHaveBeenCalled();

    manager.emit('chat:runtime-event', {
      type: 'run.ended',
      runId: 'run-reload',
      sessionKey: 'agent:main:main',
      status: 'completed',
    });
    await vi.runAllTicks();

    expect(restartSpy).toHaveBeenCalledTimes(1);
    expect(restartSpy).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'deferred-restart-flush',
      source: 'runtime:run.ended',
    }));
  });
});
