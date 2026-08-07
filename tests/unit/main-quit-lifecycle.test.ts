import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createQuitLifecycleState,
  markQuitCleanupCompleted,
  requestQuitLifecycleAction,
  runAbortableQuitTask,
} from '@electron/main/quit-lifecycle';

afterEach(() => {
  vi.useRealTimers();
});

describe('main quit lifecycle coordination', () => {
  it('starts cleanup only once', () => {
    const state = createQuitLifecycleState();

    expect(requestQuitLifecycleAction(state)).toBe('start-cleanup');
    expect(requestQuitLifecycleAction(state)).toBe('cleanup-in-progress');
  });

  it('allows quit after cleanup is marked complete', () => {
    const state = createQuitLifecycleState();

    expect(requestQuitLifecycleAction(state)).toBe('start-cleanup');
    markQuitCleanupCompleted(state);
    expect(requestQuitLifecycleAction(state)).toBe('allow-quit');
  });

  it('completes an abortable quit task before its deadline', async () => {
    const result = await runAbortableQuitTask(async (signal) => {
      expect(signal.aborted).toBe(false);
    }, 10_000);

    expect(result).toBe('completed');
  });

  it('aborts an overdue quit task and returns timeout', async () => {
    vi.useFakeTimers();
    let observedAbort = false;
    const running = runAbortableQuitTask((signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        observedAbort = true;
        reject(signal.reason);
      }, { once: true });
    }), 10_000);

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(running).resolves.toBe('timeout');
    expect(observedAbort).toBe(true);
  });
});
