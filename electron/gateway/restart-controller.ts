import { logger } from '../utils/logger';
import {
  getDeferredRestartAction,
  shouldDeferRestart,
  type GatewayLifecycleState,
} from './process-policy';

type RestartDeferralState = {
  state: GatewayLifecycleState;
  startLock: boolean;
};

type DeferredRestartContext = RestartDeferralState & {
  shouldReconnect: boolean;
};

export class GatewayRestartController {
  private deferredRestartPending = false;
  private deferredRestartCompletionGeneration = 0;
  private restartCompletionGeneration = 0;
  private restartDebounceTimer: NodeJS.Timeout | null = null;
  private restartDebounceGeneration = 0;

  isRestartDeferred(context: RestartDeferralState): boolean {
    return shouldDeferRestart(context);
  }

  markDeferredRestart(reason: string, context: RestartDeferralState): void {
    if (!this.deferredRestartPending) {
      logger.info(
        `Deferring Gateway restart (${reason}) until startup/reconnect settles (state=${context.state}, startLock=${context.startLock})`,
      );
    } else {
      logger.debug(
        `Gateway restart already deferred; keeping pending request (${reason}, state=${context.state}, startLock=${context.startLock})`,
      );
    }
    this.deferredRestartPending = true;
    // Capture the completion generation for every request, including requests
    // coalesced behind an older pending one. A wall-clock timestamp cannot
    // establish causality when completion and request happen in the same ms.
    this.deferredRestartCompletionGeneration = this.restartCompletionGeneration;
  }

  recordRestartCompleted(): void {
    this.restartCompletionGeneration = this.nextGeneration(this.restartCompletionGeneration);
  }

  flushDeferredRestart(
    trigger: string,
    context: DeferredRestartContext,
    executeRestart: () => void,
  ): void {
    const action = getDeferredRestartAction({
      hasPendingRestart: this.deferredRestartPending,
      state: context.state,
      startLock: context.startLock,
      shouldReconnect: context.shouldReconnect,
    });

    if (action === 'none') return;
    if (action === 'wait') {
      logger.debug(
        `Deferred Gateway restart still waiting (${trigger}, state=${context.state}, startLock=${context.startLock})`,
      );
      return;
    }

    const requestedAfterGeneration = this.deferredRestartCompletionGeneration;
    this.deferredRestartPending = false;
    this.deferredRestartCompletionGeneration = this.restartCompletionGeneration;
    if (action === 'drop') {
      logger.info(
        `Dropping deferred Gateway restart (${trigger}) because lifecycle already recovered (state=${context.state}, shouldReconnect=${context.shouldReconnect})`,
      );
      return;
    }

    // A different completion generation proves that a restart completed after
    // the latest pending request. Equality means the request is newer and must
    // still execute, even if both events occurred in the same millisecond.
    if (requestedAfterGeneration !== this.restartCompletionGeneration) {
      logger.info(
        `Dropping deferred Gateway restart (${trigger}): a restart already completed after the request ` +
        `(requestedAfterGeneration=${requestedAfterGeneration}, completedGeneration=${this.restartCompletionGeneration})`,
      );
      return;
    }

    logger.info(`Executing deferred Gateway restart now (${trigger})`);
    executeRestart();
  }

  debouncedRestart(delayMs: number, executeRestart: () => void): void {
    if (this.restartDebounceTimer) {
      clearTimeout(this.restartDebounceTimer);
    }
    const generation = this.nextGeneration(this.restartDebounceGeneration);
    this.restartDebounceGeneration = generation;
    logger.debug(`Gateway restart debounced (will fire in ${delayMs}ms)`);
    this.restartDebounceTimer = setTimeout(() => {
      if (generation !== this.restartDebounceGeneration) return;
      this.restartDebounceTimer = null;
      executeRestart();
    }, delayMs);
  }

  clearDebounceTimer(): void {
    this.restartDebounceGeneration = this.nextGeneration(this.restartDebounceGeneration);
    if (this.restartDebounceTimer) {
      clearTimeout(this.restartDebounceTimer);
      this.restartDebounceTimer = null;
    }
  }

  resetDeferredRestart(): void {
    this.deferredRestartPending = false;
    this.deferredRestartCompletionGeneration = this.restartCompletionGeneration;
  }

  private nextGeneration(current: number): number {
    return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
  }
}
