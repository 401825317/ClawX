// @vitest-environment node

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRendererRecoveryGovernor,
  type RendererRecoveryEvent,
} from '../../electron/main/renderer-recovery';

describe('renderer recovery governor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createTestGovernor(options: {
    reload?: ReturnType<typeof vi.fn>;
    onEvent?: (event: RendererRecoveryEvent) => void;
    watchdogMs?: number;
    minDelayMs?: number;
  } = {}) {
    const reload = options.reload ?? vi.fn();
    const governor = createRendererRecoveryGovernor({
      reload,
      onEvent: options.onEvent,
      watchdogMs: options.watchdogMs ?? 2_000,
      minDelayMs: options.minDelayMs,
    });
    return { governor, reload };
  }

  it('does not reload for clean exits or intentional kills', () => {
    const events: RendererRecoveryEvent[] = [];
    const { governor, reload } = createTestGovernor({ onEvent: event => events.push(event) });

    governor.onRenderProcessGone('clean-exit');
    governor.onRenderProcessGone('killed');
    vi.advanceTimersByTime(10_000);

    expect(reload).not.toHaveBeenCalled();
    expect(events.filter(event => event.type === 'recovery_suppressed')).toHaveLength(2);
    expect(governor.getSnapshot().phase).toBe('idle');
  });

  it('backs off exponentially when recovery never reaches a healthy navigation', () => {
    const events: RendererRecoveryEvent[] = [];
    const { governor, reload } = createTestGovernor({
      onEvent: event => events.push(event),
      watchdogMs: 100,
    });

    governor.onRenderProcessGone('oom');
    vi.advanceTimersByTime(500);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);

    governor.onRenderProcessGone('crashed');
    expect(events.at(-1)).toMatchObject({
      type: 'recovery_scheduled',
      delayMs: 1_000,
      attempt: 2,
    });
    vi.advanceTimersByTime(1_000);
    expect(reload).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(100);

    governor.onRenderProcessGone('memory-eviction');
    expect(events.at(-1)).toMatchObject({
      type: 'recovery_scheduled',
      delayMs: 2_000,
      attempt: 3,
    });
  });

  it('clamps a configured delay to at least 500ms', () => {
    const events: RendererRecoveryEvent[] = [];
    const { governor, reload } = createTestGovernor({
      onEvent: event => events.push(event),
      minDelayMs: 1,
    });

    governor.onRenderProcessGone('abnormal-exit');
    expect(events.at(-1)).toMatchObject({ delayMs: 500 });
    vi.advanceTimersByTime(499);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('uses a minimum delay and exponential backoff while keeping in-flight single-flight', () => {
    const events: RendererRecoveryEvent[] = [];
    const { governor, reload } = createTestGovernor({ onEvent: event => events.push(event) });

    governor.onRenderProcessGone('oom');
    expect(reload).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: 'recovery_scheduled',
      delayMs: 500,
      attempt: 1,
    });

    // Duplicate gone events do not reset or shorten the pending timer.
    governor.onRenderProcessGone('crashed');
    vi.advanceTimersByTime(499);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(governor.getSnapshot().inFlight).toBe(true);

    // The in-flight flag lasts until a navigation event, not until reload()
    // returns.  A second failure is therefore suppressed.
    governor.onRenderProcessGone('oom');
    expect(events.at(-1)).toMatchObject({
      type: 'recovery_suppressed',
      cause: 'in-flight',
    });
    governor.onNavigation('did-finish-load');
    expect(governor.getSnapshot().inFlight).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'healthy' });

    governor.onRenderProcessGone('oom');
    expect(events.at(-1)).toMatchObject({
      type: 'recovery_scheduled',
      delayMs: 500,
      attempt: 1,
    });
  });

  it('opens a circuit after three actual reloads in sixty seconds', () => {
    const events: RendererRecoveryEvent[] = [];
    const { governor, reload } = createTestGovernor({ onEvent: event => events.push(event) });

    for (let i = 0; i < 3; i += 1) {
      governor.onRenderProcessGone('oom');
      vi.advanceTimersByTime(500);
      expect(reload).toHaveBeenCalledTimes(i + 1);
      governor.onNavigation('did-finish-load');
      // Keep each attempt inside the rolling budget while allowing the next
      // request to be scheduled.
      vi.advanceTimersByTime(1);
    }

    governor.onRenderProcessGone('oom');
    expect(reload).toHaveBeenCalledTimes(3);
    expect(governor.getSnapshot().circuitOpen).toBe(true);
    expect(events.filter(event => event.type === 'circuit_open')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'circuit_open',
      cause: 'retry-budget-exhausted',
    });

    governor.onRenderProcessGone('oom');
    expect(events.at(-1)).toMatchObject({
      type: 'recovery_suppressed',
      cause: 'circuit-open',
    });
  });

  it('opens immediately for launch and integrity failures', () => {
    const events: RendererRecoveryEvent[] = [];
    const { governor, reload } = createTestGovernor({ onEvent: event => events.push(event) });

    governor.onRenderProcessGone('launch-failed');
    expect(reload).not.toHaveBeenCalled();
    expect(governor.getSnapshot().phase).toBe('circuit-open');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'recovery_suppressed', cause: 'circuit-reason' }),
      expect.objectContaining({ type: 'circuit_open', cause: 'circuit-reason' }),
    ]));

    governor.onRenderProcessGone('integrity-failure');
    expect(events.filter(event => event.type === 'circuit_open')).toHaveLength(1);
  });

  it('invalidates timers on dispose and releases in-flight on watchdog', () => {
    const { governor: disposedGovernor, reload: disposedReload } = createTestGovernor();
    disposedGovernor.onRenderProcessGone('oom');
    disposedGovernor.dispose();
    vi.advanceTimersByTime(10_000);
    expect(disposedReload).not.toHaveBeenCalled();
    expect(disposedGovernor.getSnapshot().phase).toBe('disposed');

    const { governor, reload } = createTestGovernor({ watchdogMs: 1_000 });
    governor.onRenderProcessGone('oom');
    vi.advanceTimersByTime(500);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(governor.getSnapshot().inFlight).toBe(true);
    vi.advanceTimersByTime(999);
    expect(governor.getSnapshot().inFlight).toBe(true);
    vi.advanceTimersByTime(1);
    expect(governor.getSnapshot().inFlight).toBe(false);
    expect(governor.getSnapshot().phase).toBe('idle');
  });

  it('cancels only a pending unresponsive recovery when the renderer responds', () => {
    const { governor, reload } = createTestGovernor();

    governor.onUnresponsive();
    governor.onResponsive();
    vi.advanceTimersByTime(10_000);
    expect(reload).not.toHaveBeenCalled();

    governor.onRenderProcessGone('oom');
    governor.onResponsive();
    vi.advanceTimersByTime(500);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(governor.getSnapshot().inFlight).toBe(true);
  });

  it('retries a failed replacement page with backoff and a single timer', () => {
    const events: RendererRecoveryEvent[] = [];
    const { governor, reload } = createTestGovernor({ onEvent: event => events.push(event) });

    governor.onRenderProcessGone('oom');
    vi.advanceTimersByTime(500);
    expect(reload).toHaveBeenCalledTimes(1);

    governor.onNavigation('did-fail-load');
    expect(events.at(-1)).toMatchObject({
      type: 'recovery_scheduled',
      delayMs: 1_000,
      attempt: 2,
    });
    governor.onRenderProcessGone('crashed');
    expect(events.at(-1)).toMatchObject({
      type: 'recovery_suppressed',
      cause: 'already-scheduled',
    });
    vi.advanceTimersByTime(1_000);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('keeps state independent for each window instance', () => {
    const first = createTestGovernor();
    const second = createTestGovernor();

    first.governor.onRenderProcessGone('oom');
    first.governor.dispose();
    second.governor.onRenderProcessGone('oom');
    vi.advanceTimersByTime(500);

    expect(first.reload).not.toHaveBeenCalled();
    expect(second.reload).toHaveBeenCalledTimes(1);
    expect(second.governor.getSnapshot().inFlight).toBe(true);
    expect(first.governor.getSnapshot().phase).toBe('disposed');
  });
});
