import { describe, expect, it } from 'vitest';
import { runPrelaunchBlockingPhase, runPrelaunchPhase } from '@electron/gateway/prelaunch-liveness';

describe('prelaunch liveness sampling', () => {
  it('measures an async phase and preserves its result', async () => {
    const { result, sample } = await runPrelaunchPhase('async-plugin-scan', async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      return 42;
    });

    expect(result).toBe(42);
    expect(sample).toMatchObject({
      phase: 'async-plugin-scan',
      outcome: 'success',
      slow: false,
    });
    expect(sample.durationMs).toBeGreaterThanOrEqual(10);
  });

  it('attributes synchronous work and its delayed next turn to the named phase', async () => {
    const { result, sample } = await runPrelaunchBlockingPhase('model-prewarm', () => {
      const deadline = performance.now() + 25;
      while (performance.now() < deadline) {
        // Deliberately emulate an unavoidable synchronous compatibility task.
      }
      return 'ready';
    });

    expect(result).toBe('ready');
    expect(sample.phase).toBe('model-prewarm');
    expect(sample.durationMs).toBeGreaterThanOrEqual(20);
    expect(sample.eventLoopDelayMs).toBeGreaterThanOrEqual(20);
    expect(sample.slow).toBe(false);
    expect(sample.outcome).toBe('success');
  });

  it('marks a phase slow when its event-loop delay crosses the diagnostic threshold', async () => {
    const { sample } = await runPrelaunchBlockingPhase('agent-runtime-plugins', () => {
      const deadline = performance.now() + 110;
      while (performance.now() < deadline) {
        // Deliberately emulate a pathological synchronous plugin scan.
      }
    });

    expect(sample.slow).toBe(true);
    expect(sample.eventLoopDelayMs).toBeGreaterThanOrEqual(100);
  });

  it('reports a failed phase before preserving the original exception', async () => {
    const failure = new Error('synthetic phase failure');
    const samples: Parameters<NonNullable<Parameters<typeof runPrelaunchBlockingPhase>[2]>>[0][] = [];

    await expect(runPrelaunchBlockingPhase(
      'plugin-maintenance',
      () => {
        const deadline = performance.now() + 10;
        while (performance.now() < deadline) {
          // Ensure the failed phase records measurable synchronous work.
        }
        throw failure;
      },
      (sample) => samples.push(sample),
    )).rejects.toBe(failure);

    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      phase: 'plugin-maintenance',
      outcome: 'failure',
    });
    expect(samples[0].durationMs).toBeGreaterThanOrEqual(8);
  });

  it('captures a synchronous stall after an async phase has yielded', async () => {
    const { sample } = await runPrelaunchPhase('post-await-phase', async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const deadline = performance.now() + 110;
      while (performance.now() < deadline) {
        // Deliberately block after the first await.
      }
    });

    expect(sample.eventLoopBlocked).toBe(true);
    expect(sample.eventLoopDelayMs).toBeGreaterThanOrEqual(100);
    expect(sample.slowPhase).toBe(true);
  });

  it('separates a slow asynchronous wait from an event-loop block', async () => {
    const { sample } = await runPrelaunchPhase('slow-io', async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 140));
    });

    expect(sample.slowPhase).toBe(true);
    expect(sample.eventLoopBlocked).toBe(false);
    expect(sample.slow).toBe(false);
  });

  it('redacts dynamic labels and preserves an undefined rejection', async () => {
    const samples: Parameters<NonNullable<Parameters<typeof runPrelaunchPhase>[2]>>[0][] = [];
    await expect(runPrelaunchPhase(
      'C:\\Users\\someone\\prompt.txt',
      () => Promise.reject(undefined),
      (sample) => samples.push(sample),
      { callSite: 'C:\\workspace\\secret prompt' },
    )).rejects.toBeUndefined();

    expect(samples[0]).toMatchObject({
      phase: 'redacted-phase',
      callSite: 'redacted',
      outcome: 'failure',
    });
  });

  it('does not let a diagnostic callback replace a successful result', async () => {
    await expect(runPrelaunchPhase(
      'callback-isolation',
      () => 'ok',
      () => {
        throw new Error('diagnostic failure');
      },
    )).resolves.toMatchObject({ result: 'ok' });
  });
});
