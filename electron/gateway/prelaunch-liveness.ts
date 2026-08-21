import { performance } from 'node:perf_hooks';

export type PrelaunchBlockingSample = {
  phase: string;
  callSite: string;
  durationMs: number;
  eventLoopDelayMs: number;
  slowPhase: boolean;
  eventLoopBlocked: boolean;
  samplingTruncated: boolean;
  slow: boolean;
  outcome: 'success' | 'failure';
};

export type PrelaunchPhaseSample = PrelaunchBlockingSample;

export type PrelaunchPhaseOptions = {
  /** Static diagnostic id. Dynamic paths, prompts, and user text are rejected. */
  callSite?: string;
  /** Stops delay sampling only; cancellation of the phase remains caller-owned. */
  signal?: AbortSignal;
  /** Bounds timer overhead when a startup operation never settles. */
  maxSamplingMs?: number;
};

const SLOW_PHASE_MS = 100;
const EVENT_LOOP_BLOCKED_MS = 100;
const MAX_EVENT_LOOP_SAMPLING_MS = 30_000;
const DIAGNOSTIC_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;

function safeDiagnosticId(value: string | undefined, fallback: string): string {
  const candidate = value?.trim();
  return candidate && DIAGNOSTIC_ID_PATTERN.test(candidate) ? candidate : fallback;
}

function yieldToEventLoop(): Promise<number> {
  const scheduledAt = performance.now();
  return new Promise((resolve) => {
    setImmediate(() => resolve(performance.now() - scheduledAt));
  });
}

function yieldToTimers(): Promise<number> {
  const scheduledAt = performance.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(performance.now() - scheduledAt), 0);
    timer.unref?.();
  });
}

/**
 * Measure an async startup phase without keeping the main process in one
 * uninterrupted turn. The interval catches stalls between awaits; the final
 * immediate catches a synchronous stall that prevented the interval from
 * firing at all.
 */
export async function runPrelaunchPhase<T>(
  phase: string,
  task: () => T | Promise<T>,
  onSample?: (sample: PrelaunchPhaseSample) => void,
  options: PrelaunchPhaseOptions = {},
): Promise<{ result: T; sample: PrelaunchPhaseSample }> {
  await yieldToEventLoop();
  const startedAt = performance.now();
  let maxEventLoopDelayMs = 0;
  let samplingTruncated = false;
  let samplingActive = true;
  const eventLoopUtilizationStart = performance.eventLoopUtilization();

  const requestedMaxSamplingMs = options.maxSamplingMs;
  const maxSamplingMs = Number.isFinite(requestedMaxSamplingMs)
    && (requestedMaxSamplingMs ?? 0) > 0
    ? requestedMaxSamplingMs!
    : MAX_EVENT_LOOP_SAMPLING_MS;
  const stopSampling = (truncated: boolean): void => {
    if (!samplingActive) return;
    samplingActive = false;
    samplingTruncated ||= truncated;
  };
  const samplingDeadline = setTimeout(() => {
    stopSampling(true);
  }, maxSamplingMs);
  const onAbort = (): void => stopSampling(true);
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const nextTurn = yieldToEventLoop();

  let result: T | undefined;
  let didFail = false;
  let taskError: unknown;
  try {
    result = await task();
  } catch (error) {
    didFail = true;
    taskError = error;
  }

  const durationMs = performance.now() - startedAt;
  // Let timers delayed by synchronous work after an internal await report
  // before the interval is cleared. A timer turn is required here because a
  // setImmediate continuation can run before the delayed interval callback.
  // This adds one macrotask turn, not a fixed sampling delay, to the phase.
  const finalTurn = yieldToTimers();
  maxEventLoopDelayMs = Math.max(
    maxEventLoopDelayMs,
    await nextTurn,
    await finalTurn,
  );
  // Timer histograms can miss a block that begins in a Promise continuation
  // and ends before the next timers phase. ELU measures the active Main-loop
  // time directly, while an async network/disk wait contributes to idle time.
  const eventLoopUtilization = performance.eventLoopUtilization(eventLoopUtilizationStart);
  maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, eventLoopUtilization.active);
  stopSampling(false);
  clearTimeout(samplingDeadline);
  options.signal?.removeEventListener('abort', onAbort);

  const slowPhase = durationMs >= SLOW_PHASE_MS;
  const eventLoopBlocked = maxEventLoopDelayMs >= EVENT_LOOP_BLOCKED_MS;
  const sample: PrelaunchPhaseSample = {
    phase: safeDiagnosticId(phase, 'redacted-phase'),
    callSite: safeDiagnosticId(options.callSite, 'redacted'),
    durationMs,
    eventLoopDelayMs: maxEventLoopDelayMs,
    slowPhase,
    eventLoopBlocked,
    samplingTruncated,
    // Preserve the legacy field for callers that warn on an actual Main-loop
    // stall. Slow network or disk I/O is reported separately by slowPhase.
    slow: eventLoopBlocked,
    outcome: didFail ? 'failure' : 'success',
  };
  try {
    onSample?.(sample);
  } catch {
    // Diagnostics must never replace the startup operation's result/error.
  }

  if (didFail) throw taskError;
  return { result: result as T, sample };
}

/**
 * Run one unavoidable synchronous compatibility task as an isolated phase.
 * The yield before and after each phase prevents a batch of scans/copies from
 * monopolising the Main loop, and records the exact phase responsible for any
 * observed stall. The task itself remains semantically synchronous.
 */
export async function runPrelaunchBlockingPhase<T>(
  phase: string,
  task: () => T,
  onSample?: (sample: PrelaunchBlockingSample) => void,
  options: PrelaunchPhaseOptions = {},
): Promise<{ result: T; sample: PrelaunchBlockingSample }> {
  return runPrelaunchPhase(phase, task, onSample, options);
}
