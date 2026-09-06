/**
 * A small, Electron-independent governor for recovering a renderer process.
 *
 * Chromium may emit several process-gone/unresponsive notifications while a
 * navigation is being torn down.  Recovery therefore has to be a state
 * machine, rather than a direct `setTimeout(() => reload())` call.  One
 * governor is created per BrowserWindow so a failure in one window cannot
 * cancel or accelerate recovery in another window.
 */

export type RendererRecoveryReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | 'memory-eviction'
  | 'unresponsive';

export type RendererRecoveryEventType =
  | 'recovery_scheduled'
  | 'recovery_executed'
  | 'recovery_suppressed'
  | 'circuit_open'
  | 'healthy';

export interface RendererRecoveryEvent {
  type: RendererRecoveryEventType;
  generation: number;
  at: number;
  reason?: RendererRecoveryReason;
  attempt?: number;
  delayMs?: number;
  /** Why a request was suppressed or why the circuit was opened. */
  cause?: string;
}

export type RendererRecoveryPhase =
  | 'idle'
  | 'scheduled'
  | 'in-flight'
  | 'circuit-open'
  | 'disposed';

export interface RendererRecoverySnapshot {
  generation: number;
  phase: RendererRecoveryPhase;
  inFlight: boolean;
  scheduled: boolean;
  circuitOpen: boolean;
  /** Number of actual reload attempts still inside the rolling window. */
  attemptsInWindow: number;
  /** Number of consecutive failures used to calculate the next delay. */
  consecutiveFailures: number;
  lastReason?: RendererRecoveryReason;
}

export interface RendererRecoveryReloadContext {
  generation: number;
  reason: RendererRecoveryReason;
  attempt: number;
}

export interface RendererRecoveryScheduler {
  setTimeout: (handler: () => void, timeout: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  now: () => number;
}

export interface RendererRecoveryGovernorOptions {
  /** Invoked exactly once for each reload attempt. */
  reload: (context: RendererRecoveryReloadContext) => void | Promise<void>;
  /** Return false when the owning BrowserWindow is no longer active. */
  canRecover?: () => boolean;
  onEvent?: (event: RendererRecoveryEvent) => void;
  scheduler?: Partial<RendererRecoveryScheduler>;
  /** Minimum delay before an automatic reload. Must be at least 500ms. */
  minDelayMs?: number;
  /** Maximum delay for exponential backoff. */
  maxDelayMs?: number;
  /** Number of actual reloads permitted during the rolling window. */
  maxAttempts?: number;
  /** Rolling window for the reload budget. */
  attemptWindowMs?: number;
  /** Time after reload at which in-flight is released if no navigation arrives. */
  watchdogMs?: number;
  /** Delay used for an unresponsive notification before the first attempt. */
  unresponsiveDelayMs?: number;
  /** Stable time after a completed navigation before backoff is reset. */
  healthyAfterMs?: number;
}

export interface RendererRecoveryGovernor {
  /** Handle Electron's render-process-gone reason. */
  onRenderProcessGone: (reason: string) => void;
  /** Handle Electron's unresponsive event. */
  onUnresponsive: () => void;
  /** Handle a navigation event (normally did-finish-load/did-fail-load). */
  onNavigation: (event?: string) => void;
  /** Handle a responsive event without prematurely clearing an OOM/crash retry. */
  onResponsive: () => void;
  /** Cancel all work and invalidate callbacks for this window. */
  dispose: () => void;
  /** A read-only view useful for diagnostics and tests. */
  getSnapshot: () => RendererRecoverySnapshot;
}

const DEFAULT_MIN_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_ATTEMPT_WINDOW_MS = 60_000;
const DEFAULT_WATCHDOG_MS = 15_000;
const DEFAULT_UNRESPONSIVE_DELAY_MS = 5_000;
const DEFAULT_HEALTHY_AFTER_MS = 10_000;

const RECOVERABLE_REASONS = new Set<RendererRecoveryReason>([
  'oom',
  'memory-eviction',
  'crashed',
  'abnormal-exit',
  'unresponsive',
]);

const NON_RECOVERABLE_REASONS = new Set<RendererRecoveryReason>([
  'clean-exit',
  'killed',
]);

const CIRCUIT_REASONS = new Set<RendererRecoveryReason>([
  'launch-failed',
  'integrity-failure',
]);

function clampMinimum(value: number, minimum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, value) : minimum;
}

function normalizeDelay(value: number | undefined, fallback: number, minimum: number): number {
  return clampMinimum(value ?? fallback, minimum);
}

function normalizeReason(reason: string): RendererRecoveryReason | undefined {
  if (
    reason === 'clean-exit'
    || reason === 'abnormal-exit'
    || reason === 'killed'
    || reason === 'crashed'
    || reason === 'oom'
    || reason === 'launch-failed'
    || reason === 'integrity-failure'
    || reason === 'memory-eviction'
    || reason === 'unresponsive'
  ) {
    return reason;
  }
  return undefined;
}

/**
 * Create one renderer recovery state machine. Callers should create a new
 * instance for every BrowserWindow; no state is shared between instances.
 */
export function createRendererRecoveryGovernor(
  options: RendererRecoveryGovernorOptions,
): RendererRecoveryGovernor {
  const minDelayMs = normalizeDelay(options.minDelayMs, DEFAULT_MIN_DELAY_MS, DEFAULT_MIN_DELAY_MS);
  const maxDelayMs = Math.max(
    minDelayMs,
    normalizeDelay(options.maxDelayMs, DEFAULT_MAX_DELAY_MS, minDelayMs),
  );
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const attemptWindowMs = Math.max(1, Math.floor(options.attemptWindowMs ?? DEFAULT_ATTEMPT_WINDOW_MS));
  const watchdogMs = Math.max(1, Math.floor(options.watchdogMs ?? DEFAULT_WATCHDOG_MS));
  const unresponsiveDelayMs = normalizeDelay(
    options.unresponsiveDelayMs,
    DEFAULT_UNRESPONSIVE_DELAY_MS,
    minDelayMs,
  );
  const healthyAfterMs = Math.max(1, Math.floor(options.healthyAfterMs ?? DEFAULT_HEALTHY_AFTER_MS));

  const scheduler: RendererRecoveryScheduler = {
    setTimeout: options.scheduler?.setTimeout ?? ((handler, timeout) => setTimeout(handler, timeout)),
    clearTimeout: options.scheduler?.clearTimeout ?? (handle => clearTimeout(handle)),
    now: options.scheduler?.now ?? (() => Date.now()),
  };

  let generation = 0;
  let phase: RendererRecoveryPhase = 'idle';
  let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let healthyTimer: ReturnType<typeof setTimeout> | null = null;
  let circuitTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlightGeneration: number | null = null;
  let scheduledReason: RendererRecoveryReason | undefined;
  let lastReason: RendererRecoveryReason | undefined;
  let consecutiveFailures = 0;
  let healthy = true;
  let disposed = false;
  let circuitEventEmitted = false;
  const attemptTimes: number[] = [];

  const emit = (
    type: RendererRecoveryEventType,
    details: Omit<RendererRecoveryEvent, 'type' | 'generation' | 'at'> = {},
  ): void => {
    options.onEvent?.({
      type,
      generation,
      at: scheduler.now(),
      ...details,
    });
  };

  const clearScheduledTimer = (): void => {
    if (scheduledTimer !== null) {
      scheduler.clearTimeout(scheduledTimer);
      scheduledTimer = null;
    }
    scheduledReason = undefined;
  };

  const clearWatchdogTimer = (): void => {
    if (watchdogTimer !== null) {
      scheduler.clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  };

  const clearHealthyTimer = (): void => {
    if (healthyTimer !== null) {
      scheduler.clearTimeout(healthyTimer);
      healthyTimer = null;
    }
  };

  const clearCircuitTimer = (): void => {
    if (circuitTimer !== null) {
      scheduler.clearTimeout(circuitTimer);
      circuitTimer = null;
    }
  };

  /** Invalidate callbacks without changing the in-flight ownership. */
  const invalidateGeneration = (): void => {
    generation += 1;
  };

  const pruneAttempts = (now: number): void => {
    const cutoff = now - attemptWindowMs;
    while (attemptTimes.length > 0 && attemptTimes[0] <= cutoff) {
      attemptTimes.shift();
    }
  };

  const emitSuppressed = (
    reason: RendererRecoveryReason | undefined,
    cause: string,
  ): void => {
    emit('recovery_suppressed', { reason, cause });
  };

  const openCircuit = (
    reason: RendererRecoveryReason | undefined,
    cause: string,
  ): void => {
    clearScheduledTimer();
    clearWatchdogTimer();
    clearHealthyTimer();
    clearCircuitTimer();
    inFlightGeneration = null;
    phase = 'circuit-open';
    invalidateGeneration();
    if (!circuitEventEmitted) {
      circuitEventEmitted = true;
      emit('circuit_open', { reason, cause });
    }
    circuitTimer = scheduler.setTimeout(() => {
      circuitTimer = null;
      if (disposed || phase !== 'circuit-open') return;
      pruneAttempts(scheduler.now());
      phase = 'idle';
      circuitEventEmitted = false;
      consecutiveFailures = 0;
      healthy = true;
      invalidateGeneration();
    }, attemptWindowMs);
  };

  const emitHealthy = (event?: string): void => {
    if (!healthy) {
      healthy = true;
      emit('healthy', { cause: event });
    }
  };

  /** Keep a short stability timer so a transient page does not emit a second
   * healthy event. The exponential counter itself is reset on the first
   * successful navigation; the rolling attempt budget still prevents a
   * rapid crash/reload storm. */
  const scheduleHealthyReset = (event?: string): void => {
    clearHealthyTimer();
    const stableGeneration = generation;
    healthyTimer = scheduler.setTimeout(() => {
      healthyTimer = null;
      if (disposed || generation !== stableGeneration || phase !== 'idle') return;
      if (options.canRecover && !options.canRecover()) return;
      healthy = true;
      // Do not emit a second healthy event; the navigation/responsive event
      // already emitted it when the state transitioned from unhealthy.
      void event;
    }, healthyAfterMs);
  };

  const releaseInFlight = (successfulNavigation: boolean): boolean => {
    if (inFlightGeneration === null) return false;
    clearWatchdogTimer();
    inFlightGeneration = null;
    if (phase === 'in-flight') phase = 'idle';
    invalidateGeneration();
    if (successfulNavigation) consecutiveFailures = 0;
    return true;
  };

  const onWatchdog = (watchdogGeneration: number): void => {
    watchdogTimer = null;
    if (disposed || inFlightGeneration !== watchdogGeneration || generation !== watchdogGeneration) {
      return;
    }
    inFlightGeneration = null;
    phase = 'idle';
    // No healthy navigation was observed. Keep the rolling budget and
    // exponential count so a later process-gone event backs off.
    invalidateGeneration();
  };

  const executeScheduled = (executionGeneration: number): void => {
    scheduledTimer = null;
    const reason = scheduledReason;
    scheduledReason = undefined;
    if (
      disposed
      || phase !== 'scheduled'
      || executionGeneration !== generation
      || !reason
    ) {
      return;
    }
    if (options.canRecover && !options.canRecover()) {
      phase = 'idle';
      invalidateGeneration();
      emitSuppressed(reason, 'inactive-window');
      return;
    }

    const now = scheduler.now();
    pruneAttempts(now);
    if (attemptTimes.length >= maxAttempts) {
      phase = 'idle';
      emitSuppressed(reason, 'retry-budget-exhausted');
      openCircuit(reason, 'retry-budget-exhausted');
      return;
    }

    const attempt = attemptTimes.length + 1;
    attemptTimes.push(now);
    consecutiveFailures += 1;
    phase = 'in-flight';
    inFlightGeneration = executionGeneration;
    healthy = false;
    emit('recovery_executed', { reason, attempt });
    watchdogTimer = scheduler.setTimeout(
      () => onWatchdog(executionGeneration),
      watchdogMs,
    );

    try {
      const result = options.reload({
        generation: executionGeneration,
        reason,
        attempt,
      });
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Keep in-flight until navigation or watchdog. Clearing it immediately
      // would turn a synchronous reload error into a tight retry loop.
    }
  };

  const schedule = (reason: RendererRecoveryReason): void => {
    clearHealthyTimer();
    if (disposed) {
      emitSuppressed(reason, 'disposed');
      return;
    }
    if (options.canRecover && !options.canRecover()) {
      emitSuppressed(reason, 'inactive-window');
      return;
    }
    if (phase === 'circuit-open') {
      emitSuppressed(reason, 'circuit-open');
      return;
    }
    if (scheduledTimer !== null || phase === 'scheduled') {
      emitSuppressed(reason, 'already-scheduled');
      return;
    }
    if (inFlightGeneration !== null || phase === 'in-flight') {
      emitSuppressed(reason, 'in-flight');
      return;
    }

    const now = scheduler.now();
    pruneAttempts(now);
    if (attemptTimes.length >= maxAttempts) {
      emitSuppressed(reason, 'retry-budget-exhausted');
      openCircuit(reason, 'retry-budget-exhausted');
      return;
    }

    const attemptIndex = consecutiveFailures + 1;
    const baseDelay = reason === 'unresponsive' ? unresponsiveDelayMs : minDelayMs;
    const delayMs = Math.min(
      maxDelayMs,
      Math.max(minDelayMs, baseDelay * (2 ** Math.max(0, attemptIndex - 1))),
    );
    generation += 1;
    scheduledReason = reason;
    phase = 'scheduled';
    healthy = false;
    emit('recovery_scheduled', {
      reason,
      attempt: attemptIndex,
      delayMs,
    });
    const timerGeneration = generation;
    scheduledTimer = scheduler.setTimeout(
      () => executeScheduled(timerGeneration),
      delayMs,
    );
  };

  const onRenderProcessGone = (reasonValue: string): void => {
    const reason = normalizeReason(reasonValue);
    if (!reason) {
      emitSuppressed(undefined, `unsupported-reason:${reasonValue}`);
      return;
    }
    lastReason = reason;
    clearHealthyTimer();

    if (NON_RECOVERABLE_REASONS.has(reason)) {
      // A clean shutdown or intentional kill supersedes pending recovery.
      clearScheduledTimer();
      clearWatchdogTimer();
      inFlightGeneration = null;
      if (phase !== 'circuit-open') phase = 'idle';
      invalidateGeneration();
      emitSuppressed(reason, 'non-recoverable');
      return;
    }

    if (CIRCUIT_REASONS.has(reason)) {
      emitSuppressed(reason, 'circuit-reason');
      openCircuit(reason, 'circuit-reason');
      return;
    }

    if (!RECOVERABLE_REASONS.has(reason)) {
      emitSuppressed(reason, 'unsupported-reason');
      return;
    }

    if (inFlightGeneration !== null || phase === 'in-flight') {
      // Chromium can report the old and replacement renderer as gone during
      // one reload. Keep the attempt in flight until navigation or watchdog;
      // otherwise each duplicate event would start another reload immediately.
      emitSuppressed(reason, 'in-flight');
      return;
    }
    schedule(reason);
  };

  const onUnresponsive = (): void => {
    lastReason = 'unresponsive';
    schedule('unresponsive');
  };

  const onNavigation = (event = 'navigation'): void => {
    if (disposed) return;

    if (scheduledTimer !== null || phase === 'scheduled') {
      clearScheduledTimer();
      phase = 'idle';
      invalidateGeneration();
    }

    const failed = event === 'did-fail-load';
    const released = releaseInFlight(!failed);
    if (failed) {
      schedule(lastReason ?? 'crashed');
      return;
    }

    if (released || !healthy) {
      emitHealthy(event);
      scheduleHealthyReset(event);
    }
  };

  const onResponsive = (): void => {
    if (disposed) return;
    // A responsive signal can cancel only a pending unresponsive recovery.
    // It must not clear an OOM/crash in-flight attempt; navigation is the
    // signal that proves the replacement page really loaded.
    if (
      (scheduledTimer !== null || phase === 'scheduled')
      && scheduledReason === 'unresponsive'
    ) {
      clearScheduledTimer();
      phase = 'idle';
      invalidateGeneration();
      emitHealthy('responsive');
      scheduleHealthyReset('responsive');
      return;
    }
    if (inFlightGeneration !== null) return;
    emitHealthy('responsive');
    scheduleHealthyReset('responsive');
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearScheduledTimer();
    clearWatchdogTimer();
    clearHealthyTimer();
    clearCircuitTimer();
    inFlightGeneration = null;
    phase = 'disposed';
    invalidateGeneration();
  };

  const getSnapshot = (): RendererRecoverySnapshot => {
    pruneAttempts(scheduler.now());
    return {
      generation,
      phase,
      inFlight: inFlightGeneration !== null,
      scheduled: scheduledTimer !== null || phase === 'scheduled',
      circuitOpen: phase === 'circuit-open',
      attemptsInWindow: attemptTimes.length,
      consecutiveFailures,
      lastReason,
    };
  };

  return {
    onRenderProcessGone,
    onUnresponsive,
    onNavigation,
    onResponsive,
    dispose,
    getSnapshot,
  };
}
