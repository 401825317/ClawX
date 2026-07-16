import assert from 'node:assert/strict';
import test from 'node:test';

import { GatewayManager } from '../electron/gateway/manager';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('Gateway RPC waits for a startup transport instead of failing immediately', async () => {
  const manager = new GatewayManager();
  const internals = manager as unknown as {
    setStatus(update: Record<string, unknown>): void;
    ws: {
      readyState: number;
      send(raw: string): void;
      ping(): void;
    } | null;
    handleMessage(message: unknown): void;
  };

  internals.setStatus({ state: 'starting', gatewayReady: false });

  let sentRequest: Record<string, unknown> | undefined;
  const resultPromise = manager.rpc<{ sessions: unknown[] }>('sessions.list', { includeLastMessage: true }, 500);

  await sleep(25);
  assert.equal(sentRequest, undefined);

  internals.ws = {
    readyState: 1,
    send(raw: string) {
      sentRequest = JSON.parse(raw) as Record<string, unknown>;
      setTimeout(() => {
        internals.handleMessage({
          type: 'res',
          id: sentRequest?.id,
          ok: true,
          payload: { sessions: [] },
        });
      }, 0);
    },
    ping() {},
  };
  internals.setStatus({ state: 'running', connectedAt: Date.now() });

  const result = await resultPromise;
  assert.deepEqual(result, { sessions: [] });
  assert.equal(sentRequest?.method, 'sessions.list');
});

test('Gateway RPC still fails quickly when no startup or reconnect is in progress', async () => {
  const manager = new GatewayManager();
  const startedAt = Date.now();
  await assert.rejects(
    () => manager.rpc('sessions.list', {}, 500),
    /Gateway not connected/,
  );
  assert.ok(Date.now() - startedAt < 100);
});
