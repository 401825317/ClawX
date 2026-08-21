import { logger } from '../utils/logger';

type HealthResult = { ok: boolean; error?: string };
type HeartbeatAliveReason = 'pong' | 'message';

export type ReadOnlyProbeResult = {
  ok: boolean;
  durationMs: number;
  error?: unknown;
  stale?: boolean;
};

type PingOptions = {
  sendPing: () => void;
  onHeartbeatTimeout: (context: { consecutiveMisses: number; timeoutMs: number }) => void;
  intervalMs?: number;
  timeoutMs?: number;
  maxConsecutiveMisses?: number;
};

export class GatewayConnectionMonitor {
  private pingInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private lastPingAt = 0;
  private waitingForAlive = false;
  private consecutiveMisses = 0;
  private timeoutTriggered = false;
  private generation = 0;
  private readOnlyProbeInFlight: Promise<ReadOnlyProbeResult> | null = null;

  startPing(options: PingOptions): void {
    const intervalMs = options.intervalMs ?? 30000;
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxConsecutiveMisses = Math.max(1, options.maxConsecutiveMisses ?? 3);
    this.resetHeartbeatState();

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    this.pingInterval = setInterval(() => {
      const now = Date.now();

      if (this.waitingForAlive && now - this.lastPingAt >= timeoutMs) {
        this.waitingForAlive = false;
        this.consecutiveMisses += 1;
        logger.warn(
          `Gateway heartbeat missed (${this.consecutiveMisses}/${maxConsecutiveMisses}, timeout=${timeoutMs}ms)`,
        );
        if (this.consecutiveMisses >= maxConsecutiveMisses && !this.timeoutTriggered) {
          this.timeoutTriggered = true;
          options.onHeartbeatTimeout({
            consecutiveMisses: this.consecutiveMisses,
            timeoutMs,
          });
          return;
        }
      }

      options.sendPing();
      this.waitingForAlive = true;
      this.lastPingAt = now;
    }, intervalMs);
  }

  markAlive(reason: HeartbeatAliveReason): void {
    // Only log true recovery cases to avoid steady-state heartbeat log spam.
    if (this.consecutiveMisses > 0) {
      logger.debug(`Gateway heartbeat recovered via ${reason} (misses=${this.consecutiveMisses})`);
    }
    this.waitingForAlive = false;
    this.consecutiveMisses = 0;
    this.timeoutTriggered = false;
  }

  // Backward-compatible alias for old callers.
  handlePong(): void {
    this.markAlive('pong');
  }

  getConsecutiveMisses(): number {
    return this.consecutiveMisses;
  }

  /** Runs a one-shot probe with no configuration or mutation capability. */
  runReadOnlyProbe(probe: () => Promise<void>): Promise<ReadOnlyProbeResult> {
    if (this.readOnlyProbeInFlight) return this.readOnlyProbeInFlight;

    const generation = this.generation;
    const startedAt = Date.now();
    let resolveCurrent!: (result: ReadOnlyProbeResult) => void;
    const current = new Promise<ReadOnlyProbeResult>((resolve) => {
      resolveCurrent = resolve;
    });
    this.readOnlyProbeInFlight = current;
    void (async (): Promise<void> => {
      let result: ReadOnlyProbeResult;
      try {
        await probe();
        if (generation !== this.generation) {
          result = { ok: false, stale: true, durationMs: Date.now() - startedAt };
        } else {
          result = { ok: true, durationMs: Date.now() - startedAt };
        }
      } catch (error) {
        if (generation !== this.generation) {
          result = { ok: false, stale: true, durationMs: Date.now() - startedAt };
        } else {
          result = { ok: false, durationMs: Date.now() - startedAt, error };
        }
      } finally {
        if (this.readOnlyProbeInFlight === current) this.readOnlyProbeInFlight = null;
        resolveCurrent(result!);
      }
    })();
    return current;
  }

  startHealthCheck(options: {
    shouldCheck: () => boolean;
    checkHealth: () => Promise<HealthResult>;
    onUnhealthy: (errorMessage: string) => void;
    onError: (error: unknown) => void;
    intervalMs?: number;
  }): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    const generation = ++this.generation;

    this.healthCheckInterval = setInterval(async () => {
      if (!options.shouldCheck()) {
        return;
      }

      try {
        const health = await options.checkHealth();
        if (generation !== this.generation) return;
        if (!health.ok) {
          const errorMessage = health.error ?? 'Health check failed';
          logger.warn(`Gateway health check failed: ${errorMessage}`);
          options.onUnhealthy(errorMessage);
        }
      } catch (error) {
        if (generation !== this.generation) return;
        logger.error('Gateway health check error:', error);
        options.onError(error);
      }
    }, options.intervalMs ?? 30000);
  }

  clear(): void {
    this.generation += 1;
    this.readOnlyProbeInFlight = null;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.resetHeartbeatState();
  }

  private resetHeartbeatState(): void {
    this.lastPingAt = 0;
    this.waitingForAlive = false;
    this.consecutiveMisses = 0;
    this.timeoutTriggered = false;
  }
}
