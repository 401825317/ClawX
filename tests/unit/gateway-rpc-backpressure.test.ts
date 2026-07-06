import { describe, expect, it, vi } from 'vitest';
import { GatewayRpcBackpressure } from '../../electron/gateway/rpc-backpressure';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitForQueuedRun(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('GatewayRpcBackpressure', () => {
  it('coalesces duplicate in-flight chat.history requests', async () => {
    const backpressure = new GatewayRpcBackpressure({ maxConcurrentHistory: 2 });
    let resolveRunner: ((value: unknown) => void) | null = null;
    const runner = vi.fn(() => new Promise((resolve) => {
      resolveRunner = resolve;
    }));

    const first = backpressure.run('chat.history', { sessionKey: 'agent:main:one', limit: 200 }, undefined, runner);
    const second = backpressure.run('chat.history', { limit: 200, sessionKey: 'agent:main:one' }, undefined, runner);

    expect(runner).toHaveBeenCalledTimes(1);
    resolveRunner?.({ messages: ['ok'] });
    await expect(first).resolves.toEqual({ messages: ['ok'] });
    await expect(second).resolves.toEqual({ messages: ['ok'] });
  });

  it('limits distinct chat.history requests while allowing non-history RPCs through', async () => {
    const backpressure = new GatewayRpcBackpressure({ maxConcurrentHistory: 2 });
    let activeHistory = 0;
    let maxActiveHistory = 0;
    const releaseHistory: Array<() => void> = [];
    const runner = vi.fn(async (method: string) => {
      if (method !== 'chat.history') {
        return { method };
      }
      activeHistory += 1;
      maxActiveHistory = Math.max(maxActiveHistory, activeHistory);
      await new Promise<void>((resolve) => releaseHistory.push(resolve));
      activeHistory -= 1;
      return { method };
    });

    const historyRuns = Array.from({ length: 5 }, (_, index) => (
      backpressure.run('chat.history', { sessionKey: `agent:main:${index}`, limit: 200 }, undefined, runner)
    ));
    const statusRun = backpressure.run('status', {}, undefined, runner);

    await expect(statusRun).resolves.toEqual({ method: 'status' });
    expect(maxActiveHistory).toBe(2);
    expect(backpressure.getDiagnostics()).toMatchObject({
      activeHistory: 2,
      queuedHistory: 3,
    });

    while (releaseHistory.length > 0) {
      releaseHistory.shift()?.();
      await Promise.resolve();
    }

    await Promise.all(historyRuns);
    expect(maxActiveHistory).toBeLessThanOrEqual(2);
    expect(backpressure.getDiagnostics()).toEqual({
      activeHistory: 0,
      queuedHistory: 0,
      inFlightHistory: 0,
    });
  });

  it('serializes concurrent chat.send requests for the same session', async () => {
    const backpressure = new GatewayRpcBackpressure();
    const first = deferred<{ runId: string }>();
    const runner = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ runId: 'run-second' });

    const firstRun = backpressure.run(
      'chat.send',
      { sessionKey: 'agent:main:main', message: 'first', idempotencyKey: 'idem-first' },
      undefined,
      runner,
    );
    const secondRun = backpressure.run(
      'chat.send',
      { sessionKey: 'agent:main:main', message: 'second', idempotencyKey: 'idem-second' },
      undefined,
      runner,
    );

    await waitForQueuedRun();
    expect(runner).toHaveBeenCalledTimes(1);
    first.resolve({ runId: 'run-first' });

    await expect(firstRun).resolves.toEqual({ runId: 'run-first' });
    await expect(secondRun).resolves.toEqual({ runId: 'run-second' });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('coalesces duplicate in-flight chat.send requests with the same idempotency key', async () => {
    const backpressure = new GatewayRpcBackpressure();
    const first = deferred<{ runId: string }>();
    const runner = vi.fn().mockReturnValue(first.promise);

    const firstRun = backpressure.run(
      'chat.send',
      { sessionKey: 'agent:main:main', message: 'hello', idempotencyKey: 'idem-repeat' },
      undefined,
      runner,
    );
    const secondRun = backpressure.run(
      'chat.send',
      { sessionKey: 'agent:main:main', message: 'hello', idempotencyKey: 'idem-repeat' },
      undefined,
      runner,
    );

    await waitForQueuedRun();
    expect(runner).toHaveBeenCalledTimes(1);
    first.resolve({ runId: 'run-repeat' });

    await expect(firstRun).resolves.toEqual({ runId: 'run-repeat' });
    await expect(secondRun).resolves.toEqual({ runId: 'run-repeat' });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight chat.abort before sending again on the same session', async () => {
    const backpressure = new GatewayRpcBackpressure({ chatAbortSettleMs: 1 });
    const abort = deferred<Record<string, unknown>>();
    const runner = vi.fn((method: string) => {
      if (method === 'chat.abort') {
        return abort.promise;
      }
      return Promise.resolve({ runId: 'run-after-abort' });
    });

    const abortRun = backpressure.run(
      'chat.abort',
      { sessionKey: 'agent:main:main' },
      undefined,
      runner,
    );
    await waitForQueuedRun();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0]).toBe('chat.abort');

    const sendRun = backpressure.run(
      'chat.send',
      { sessionKey: 'agent:main:main', message: 'next', idempotencyKey: 'idem-next' },
      undefined,
      runner,
    );
    await waitForQueuedRun();
    expect(runner).toHaveBeenCalledTimes(1);

    abort.resolve({ aborted: true });
    await expect(abortRun).resolves.toEqual({ aborted: true });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(sendRun).resolves.toEqual({ runId: 'run-after-abort' });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1]?.[0]).toBe('chat.send');
  });

  it('does not wait for a superseded chat.send after chat.abort starts', async () => {
    const backpressure = new GatewayRpcBackpressure({ chatAbortSettleMs: 1 });
    const firstSend = deferred<{ runId: string }>();
    const runner = vi.fn((method: string, params?: unknown) => {
      const record = params as Record<string, unknown> | undefined;
      if (method === 'chat.send' && record?.message === 'first') {
        return firstSend.promise;
      }
      if (method === 'chat.abort') {
        return Promise.resolve({ aborted: true });
      }
      return Promise.resolve({ runId: 'run-after-abort' });
    });

    void backpressure.run(
      'chat.send',
      { sessionKey: 'agent:main:main', message: 'first', idempotencyKey: 'idem-first' },
      undefined,
      runner,
    );
    await waitForQueuedRun();
    expect(runner).toHaveBeenCalledTimes(1);

    await expect(backpressure.run(
      'chat.abort',
      { sessionKey: 'agent:main:main' },
      undefined,
      runner,
    )).resolves.toEqual({ aborted: true });

    const nextSend = backpressure.run(
      'chat.send',
      { sessionKey: 'agent:main:main', message: 'next', idempotencyKey: 'idem-next' },
      undefined,
      runner,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(nextSend).resolves.toEqual({ runId: 'run-after-abort' });
    expect(runner).toHaveBeenCalledTimes(3);
    expect(runner.mock.calls[2]?.[0]).toBe('chat.send');
  });

  it('retries transient reply session initialization conflicts for chat.send', async () => {
    const backpressure = new GatewayRpcBackpressure({
      chatSendConflictRetryDelayMs: 1,
      chatSendConflictRetryTimeoutMs: 100,
    });
    const runner = vi.fn()
      .mockRejectedValueOnce(new Error('reply session initialization conflicted for agent:main:main'))
      .mockResolvedValueOnce({ runId: 'run-retry-ok' });

    await expect(backpressure.run(
      'chat.send',
      { sessionKey: 'agent:main:main', message: 'next', idempotencyKey: 'idem-retry' },
      undefined,
      runner,
    )).resolves.toEqual({ runId: 'run-retry-ok' });

    expect(runner).toHaveBeenCalledTimes(2);
  });
});
