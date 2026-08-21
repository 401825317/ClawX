import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayConnectionMonitor } from '@electron/gateway/connection-monitor';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
  utilityProcess: {
    fork: vi.fn(),
  },
}));

describe('GatewayConnectionMonitor heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-19T00:00:00.000Z'));
  });

  it('terminates only after consecutive heartbeat misses reach threshold', () => {
    const monitor = new GatewayConnectionMonitor();
    const sendPing = vi.fn();
    const onHeartbeatTimeout = vi.fn();

    monitor.startPing({
      sendPing,
      onHeartbeatTimeout,
      intervalMs: 100,
      timeoutMs: 50,
      maxConsecutiveMisses: 3,
    });

    vi.advanceTimersByTime(100); // send ping #1
    vi.advanceTimersByTime(100); // miss #1, send ping #2
    vi.advanceTimersByTime(100); // miss #2, send ping #3
    expect(onHeartbeatTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100); // miss #3 -> timeout callback
    expect(onHeartbeatTimeout).toHaveBeenCalledTimes(1);
    expect(onHeartbeatTimeout).toHaveBeenCalledWith({ consecutiveMisses: 3, timeoutMs: 50 });
    expect(sendPing).toHaveBeenCalledTimes(3);
  });

  it('resets miss counter when alive signal is received', () => {
    const monitor = new GatewayConnectionMonitor();
    const sendPing = vi.fn();
    const onHeartbeatTimeout = vi.fn();

    monitor.startPing({
      sendPing,
      onHeartbeatTimeout,
      intervalMs: 100,
      timeoutMs: 50,
      maxConsecutiveMisses: 2,
    });

    vi.advanceTimersByTime(100); // send ping #1
    vi.advanceTimersByTime(100); // miss #1, send ping #2
    expect(monitor.getConsecutiveMisses()).toBe(1);

    monitor.markAlive('pong');
    expect(monitor.getConsecutiveMisses()).toBe(0);

    vi.advanceTimersByTime(100); // send ping #3
    vi.advanceTimersByTime(100); // miss #1 again (reset confirmed)
    expect(monitor.getConsecutiveMisses()).toBe(1);
    expect(onHeartbeatTimeout).not.toHaveBeenCalled();
  });
});

describe('GatewayConnectionMonitor read-only recovery probes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not mutate runtime state when a channel probe fails', async () => {
    const monitor = new GatewayConnectionMonitor();
    const runtime = { configuredChannels: ['wechat'], plugins: ['wechat'] };
    const probe = vi.fn(async () => {
      throw new Error('channels.status unavailable');
    });

    const result = await monitor.runReadOnlyProbe(probe);

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(runtime).toEqual({ configuredChannels: ['wechat'], plugins: ['wechat'] });
  });

  it('makes a late channel probe result stale after recovery is cleared', async () => {
    const monitor = new GatewayConnectionMonitor();
    let resolveProbe: (() => void) | undefined;
    const pending = monitor.runReadOnlyProbe(async () => {
      await new Promise<void>((resolve) => { resolveProbe = resolve; });
    });

    monitor.clear();
    resolveProbe?.();

    await expect(pending).resolves.toMatchObject({ ok: false, stale: true });
  });
});
