import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayRestartController } from '@electron/gateway/restart-controller';

vi.mock('@electron/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
  },
}));

const BUSY = { state: 'starting' as const, startLock: true };
const READY = { state: 'running' as const, startLock: false, shouldReconnect: true };

describe('GatewayRestartController', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('executes a deferred request after startup settles', () => {
    const controller = new GatewayRestartController();
    const executeRestart = vi.fn();

    controller.markDeferredRestart('config-change', BUSY);
    controller.flushDeferredRestart('startup-settled', READY, executeRestart);

    expect(executeRestart).toHaveBeenCalledTimes(1);
  });

  it('drops a request covered by a later restart completion', () => {
    const controller = new GatewayRestartController();
    const executeRestart = vi.fn();

    controller.markDeferredRestart('config-change', BUSY);
    controller.recordRestartCompleted();
    controller.flushDeferredRestart('restart-completed', READY, executeRestart);

    expect(executeRestart).not.toHaveBeenCalled();
  });

  it('does not drop a new request that follows a completion in the same millisecond', () => {
    const controller = new GatewayRestartController();
    const executeRestart = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValue(42);

    controller.recordRestartCompleted();
    controller.markDeferredRestart('new-config-change', BUSY);
    controller.flushDeferredRestart('startup-settled', READY, executeRestart);

    expect(executeRestart).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest coalesced request when an older request was covered', () => {
    const controller = new GatewayRestartController();
    const executeRestart = vi.fn();

    controller.markDeferredRestart('old-config-change', BUSY);
    controller.recordRestartCompleted();
    controller.markDeferredRestart('new-config-change', BUSY);
    controller.flushDeferredRestart('startup-settled', READY, executeRestart);

    expect(executeRestart).toHaveBeenCalledTimes(1);
  });

  it('coalesces debounce requests and invalidates a cleared callback', () => {
    vi.useFakeTimers();
    const controller = new GatewayRestartController();
    const first = vi.fn();
    const second = vi.fn();

    controller.debouncedRestart(100, first);
    controller.debouncedRestart(100, second);
    vi.advanceTimersByTime(100);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    controller.debouncedRestart(100, second);
    controller.clearDebounceTimer();
    vi.advanceTimersByTime(100);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
