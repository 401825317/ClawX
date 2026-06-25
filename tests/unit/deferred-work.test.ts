import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleAfterNavigationFrame, scheduleIdleWork } from '@/lib/deferred-work';

describe('deferred work scheduling', () => {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  const originalRequestIdleCallback = window.requestIdleCallback;
  const originalCancelIdleCallback = window.cancelIdleCallback;

  beforeEach(() => {
    vi.useFakeTimers();
    window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => (
      window.setTimeout(() => callback(performance.now()), 16)
    ));
    window.cancelAnimationFrame = vi.fn((id: number) => {
      window.clearTimeout(id);
    });
    window.requestIdleCallback = undefined;
    window.cancelIdleCallback = undefined;
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    window.requestIdleCallback = originalRequestIdleCallback;
    window.cancelIdleCallback = originalCancelIdleCallback;
    vi.useRealTimers();
  });

  it('runs after the next frame and optional delay', async () => {
    const callback = vi.fn();

    scheduleAfterNavigationFrame(callback, 25);

    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(16);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(24);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('cancels scheduled frame work before it runs', async () => {
    const callback = vi.fn();

    const cancel = scheduleAfterNavigationFrame(callback);
    cancel();

    await vi.advanceTimersByTimeAsync(50);

    expect(callback).not.toHaveBeenCalled();
  });

  it('falls back to post-frame timeout when idle callbacks are unavailable', async () => {
    const callback = vi.fn();

    scheduleIdleWork(callback, 1_500);

    await vi.advanceTimersByTimeAsync(1_515);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
