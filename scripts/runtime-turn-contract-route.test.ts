import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import type { ChatRuntimeEvent } from '../shared/chat-runtime-events.ts';
import { HostEventBus } from '../electron/api/event-bus.ts';
import type { HostApiContext } from '../electron/api/context.ts';
import { handleRuntimeRoutes } from '../electron/api/routes/runtime.ts';

test('the Host turn-contract route validates and emits a run-scoped contract event', async () => {
  const events: ChatRuntimeEvent[] = [];
  const eventBus = new HostEventBus();
  eventBus.emit = (eventName, payload) => {
    if (eventName === 'chat:runtime-event') events.push(payload as ChatRuntimeEvent);
  };
  const context: HostApiContext = {
    gatewayManager: {} as HostApiContext['gatewayManager'],
    clawHubService: {} as HostApiContext['clawHubService'],
    eventBus,
    mainWindow: null,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    void handleRuntimeRoutes(req, res, url, context).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/runtime/turn-contracts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        correlation: {
          sessionKey: 'agent:main:contract-route',
          runId: 'run-contract-route',
          toolCallId: 'tool-contract-route',
        },
        contract: {
          intent: 'artifact',
          toolRequirement: 'required',
          sideEffect: 'local_artifact',
          sideEffectAuthorized: true,
          capabilityRefs: ['presentation-maker'],
        },
      }),
    });
    const payload = await response.json() as { success?: boolean; result?: { contract?: { acceptance?: { requiresArtifact?: boolean } } } };
    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.result?.contract?.acceptance?.requiresArtifact, true);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'run.contract.updated');
    assert.equal(events[0]?.runId, 'run-contract-route');
    assert.equal(events[0]?.sessionKey, 'agent:main:contract-route');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
