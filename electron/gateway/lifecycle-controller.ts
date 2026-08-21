import { logger } from '../utils/logger';
import { isLifecycleSuperseded, nextLifecycleEpoch } from './process-policy';

export class LifecycleSupersededError extends Error {
  readonly code = 'GATEWAY_LIFECYCLE_SUPERSEDED';
  readonly phase?: string;
  readonly expectedEpoch?: number;
  readonly currentEpoch?: number;

  constructor(message: string);
  constructor(phase: string, expectedEpoch: number, currentEpoch: number);
  constructor(messageOrPhase: string, expectedEpoch?: number, currentEpoch?: number) {
    const hasEpochContext = expectedEpoch !== undefined && currentEpoch !== undefined;
    super(
      hasEpochContext
        ? `Gateway ${messageOrPhase} superseded (expectedEpoch=${expectedEpoch}, currentEpoch=${currentEpoch})`
        : messageOrPhase,
    );
    this.name = 'LifecycleSupersededError';
    if (hasEpochContext) {
      this.phase = messageOrPhase;
      this.expectedEpoch = expectedEpoch;
      this.currentEpoch = currentEpoch;
    }
  }
}

export class GatewayLifecycleController {
  private epoch = 0;

  getCurrentEpoch(): number {
    return this.epoch;
  }

  isCurrent(expectedEpoch: number): boolean {
    return !isLifecycleSuperseded(expectedEpoch, this.epoch);
  }

  bump(reason: string): number {
    this.epoch = nextLifecycleEpoch(this.epoch);
    logger.debug(`Gateway lifecycle epoch advanced to ${this.epoch} (${reason})`);
    return this.epoch;
  }

  assert(expectedEpoch: number, phase: string): void {
    if (isLifecycleSuperseded(expectedEpoch, this.epoch)) {
      throw new LifecycleSupersededError(phase, expectedEpoch, this.epoch);
    }
  }
}
