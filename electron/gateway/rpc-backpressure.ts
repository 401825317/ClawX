type GatewayRpcRunner = (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;

type QueuedRpc = {
  run: () => Promise<void>;
};

type ChatSendSessionTail = {
  abortVersion: number;
  promise: Promise<void>;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`;
}

export interface GatewayRpcBackpressureOptions {
  maxConcurrentHistory?: number;
  chatAbortSettleMs?: number;
  chatSendConflictRetryTimeoutMs?: number;
  chatSendConflictRetryDelayMs?: number;
}

/**
 * Prevents renderer fan-out from forwarding an unbounded number of expensive
 * chat.history RPCs to OpenClaw. The Gateway still owns the canonical response;
 * this class only coalesces duplicate in-flight history calls and runs distinct
 * history requests through a small FIFO queue.
 */
export class GatewayRpcBackpressure {
  private readonly maxConcurrentHistory: number;
  private readonly chatAbortSettleMs: number;
  private readonly chatSendConflictRetryTimeoutMs: number;
  private readonly chatSendConflictRetryDelayMs: number;
  private readonly inFlightHistory = new Map<string, Promise<unknown>>();
  private readonly inFlightChatSend = new Map<string, Promise<unknown>>();
  private readonly chatSendSessionTails = new Map<string, ChatSendSessionTail>();
  private readonly chatAbortSessionTails = new Map<string, Promise<void>>();
  private readonly chatAbortSettleUntil = new Map<string, number>();
  private readonly chatAbortSessionVersions = new Map<string, number>();
  private readonly queue: QueuedRpc[] = [];
  private activeHistory = 0;

  constructor(options: GatewayRpcBackpressureOptions = {}) {
    this.maxConcurrentHistory = Math.max(1, options.maxConcurrentHistory ?? 2);
    this.chatAbortSettleMs = Math.max(0, options.chatAbortSettleMs ?? 750);
    this.chatSendConflictRetryTimeoutMs = Math.max(0, options.chatSendConflictRetryTimeoutMs ?? 30_000);
    this.chatSendConflictRetryDelayMs = Math.max(1, options.chatSendConflictRetryDelayMs ?? 1_000);
  }

  run(
    method: string,
    params: unknown,
    timeoutMs: number | undefined,
    runner: GatewayRpcRunner,
  ): Promise<unknown> {
    if (method === 'chat.send') {
      return this.runChatSend(params, timeoutMs, runner);
    }

    if (method === 'chat.abort') {
      return this.runChatAbort(params, timeoutMs, runner);
    }

    if (method !== 'chat.history') {
      return runner(method, params, timeoutMs);
    }

    const key = `${method}:${stableStringify(params)}:${timeoutMs ?? 'default'}`;
    const existing = this.inFlightHistory.get(key);
    if (existing) return existing;

    const promise = this.enqueueHistory(() => runner(method, params, timeoutMs))
      .finally(() => {
        if (this.inFlightHistory.get(key) === promise) {
          this.inFlightHistory.delete(key);
        }
      });
    this.inFlightHistory.set(key, promise);
    return promise;
  }

  getDiagnostics(): { activeHistory: number; queuedHistory: number; inFlightHistory: number } {
    return {
      activeHistory: this.activeHistory,
      queuedHistory: this.queue.length,
      inFlightHistory: this.inFlightHistory.size,
    };
  }

  private enqueueHistory(work: () => Promise<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const queued: QueuedRpc = {
        run: async () => {
          this.activeHistory += 1;
          try {
            resolve(await work());
          } catch (error) {
            reject(error);
          } finally {
            this.activeHistory -= 1;
            this.drain();
          }
        },
      };
      this.queue.push(queued);
      this.drain();
    });
  }

  private runChatSend(
    params: unknown,
    timeoutMs: number | undefined,
    runner: GatewayRpcRunner,
  ): Promise<unknown> {
    const record = params && typeof params === 'object' ? params as Record<string, unknown> : {};
    const sessionKey = typeof record.sessionKey === 'string' && record.sessionKey.trim()
      ? record.sessionKey.trim()
      : 'unknown';
    const idempotencyKey = typeof record.idempotencyKey === 'string' ? record.idempotencyKey.trim() : '';
    const inFlightKey = idempotencyKey ? `${sessionKey}:${idempotencyKey}` : '';
    const existing = inFlightKey ? this.inFlightChatSend.get(inFlightKey) : undefined;
    if (existing) return existing;

    const abortVersion = this.chatAbortSessionVersions.get(sessionKey) ?? 0;
    const previousSendTail = this.chatSendSessionTails.get(sessionKey);
    const previousSendPromise = previousSendTail?.abortVersion === abortVersion
      ? previousSendTail.promise
      : Promise.resolve();
    const previousAbortTail = this.chatAbortSessionTails.get(sessionKey) ?? Promise.resolve();
    const previousTail = Promise.all([
      previousSendPromise.catch(() => undefined),
      previousAbortTail.catch(() => undefined),
    ]).then(() => this.waitForChatAbortSettle(sessionKey));
    const promise = previousTail
      .catch(() => undefined)
      .then(() => this.runChatSendWithConflictRetry(sessionKey, params, timeoutMs, runner))
      .finally(() => {
        if (inFlightKey && this.inFlightChatSend.get(inFlightKey) === promise) {
          this.inFlightChatSend.delete(inFlightKey);
        }
      });
    const currentTail = promise.then(() => undefined, () => undefined);
    this.chatSendSessionTails.set(sessionKey, { abortVersion, promise: currentTail });
    currentTail.finally(() => {
      if (this.chatSendSessionTails.get(sessionKey)?.promise === currentTail) {
        this.chatSendSessionTails.delete(sessionKey);
      }
    });

    if (inFlightKey) {
      this.inFlightChatSend.set(inFlightKey, promise);
    }
    return promise;
  }

  private async runChatSendWithConflictRetry(
    sessionKey: string,
    params: unknown,
    timeoutMs: number | undefined,
    runner: GatewayRpcRunner,
  ): Promise<unknown> {
    const startedAt = Date.now();
    while (true) {
      try {
        return await runner('chat.send', params, timeoutMs);
      } catch (error) {
        if (!this.isChatSessionInitializationConflict(error)) {
          throw error;
        }
        if (Date.now() - startedAt >= this.chatSendConflictRetryTimeoutMs) {
          throw error;
        }
        this.chatAbortSettleUntil.set(sessionKey, Date.now() + this.chatSendConflictRetryDelayMs);
        await this.waitForChatAbortSettle(sessionKey);
      }
    }
  }

  private runChatAbort(
    params: unknown,
    timeoutMs: number | undefined,
    runner: GatewayRpcRunner,
  ): Promise<unknown> {
    const record = params && typeof params === 'object' ? params as Record<string, unknown> : {};
    const sessionKey = typeof record.sessionKey === 'string' && record.sessionKey.trim()
      ? record.sessionKey.trim()
      : 'unknown';
    this.chatAbortSessionVersions.set(sessionKey, (this.chatAbortSessionVersions.get(sessionKey) ?? 0) + 1);
    const previousAbortTail = this.chatAbortSessionTails.get(sessionKey) ?? Promise.resolve();
    const promise = previousAbortTail
      .catch(() => undefined)
      .then(() => runner('chat.abort', params, timeoutMs))
      .finally(() => {
        this.chatAbortSettleUntil.set(sessionKey, Date.now() + this.chatAbortSettleMs);
      });
    const currentTail = promise.then(() => undefined, () => undefined);
    this.chatAbortSessionTails.set(sessionKey, currentTail);
    currentTail.finally(() => {
      if (this.chatAbortSessionTails.get(sessionKey) === currentTail) {
        this.chatAbortSessionTails.delete(sessionKey);
      }
    });
    return promise;
  }

  private async waitForChatAbortSettle(sessionKey: string): Promise<void> {
    const settleUntil = this.chatAbortSettleUntil.get(sessionKey) ?? 0;
    const remainingMs = settleUntil - Date.now();
    if (remainingMs <= 0) {
      this.chatAbortSettleUntil.delete(sessionKey);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, remainingMs));
    if ((this.chatAbortSettleUntil.get(sessionKey) ?? 0) <= Date.now()) {
      this.chatAbortSettleUntil.delete(sessionKey);
    }
  }

  private isChatSessionInitializationConflict(error: unknown): boolean {
    const message = String(error).toLowerCase();
    return (
      message.includes('session initialization')
      || message.includes('reply session')
      || message.includes('repy session')
    ) && (
      message.includes('conflict')
      || message.includes('conflicted')
      || message.includes('conffict')
      || message.includes('confficted')
    );
  }

  private drain(): void {
    while (this.activeHistory < this.maxConcurrentHistory) {
      const next = this.queue.shift();
      if (!next) return;
      void next.run();
    }
  }
}
