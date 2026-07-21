import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { HostEventBus } from '../electron/api/event-bus.ts';
import { handleGatewayRoutes } from '../electron/api/routes/gateway.ts';
import { collectCancellableTasks } from '../src/stores/conversation/control-selectors.ts';
import { reduceConversationEvents } from '../src/stores/conversation/reducer.ts';
import { runtimeEventToConversationEvents } from '../src/stores/conversation/runtime-adapter.ts';
import { createEmptyConversationState } from '../src/stores/conversation/types.ts';

test('canonical task evidence exposes cancellable task ids before completion', () => {
  const taskId = '11111111-2222-4333-8444-555555555555';
  const activeRunId = 'run-current';
  const sessionKey = 'agent:main:session-1';
  const now = Date.now();
  const runtimeEvents = [{
    type: 'run.started' as const,
    runId: activeRunId,
    sessionKey,
    seq: 1,
    ts: now,
  }, {
    type: 'task.updated' as const,
    runId: activeRunId,
    sessionKey,
    taskId,
    seq: 2,
    ts: now + 1,
    task: {
      taskId,
      runtime: 'video_generate',
      title: 'Generate video',
      status: 'running' as const,
      updatedAt: now + 1,
    },
  }, {
    type: 'task.updated' as const,
    runId: activeRunId,
    sessionKey,
    taskId: 'host-task-1',
    seq: 3,
    ts: now + 2,
    producer: 'uclaw-host-task',
    task: {
      taskId: 'host-task-1',
      runtime: 'uclaw-host-task',
      title: 'Render locally',
      status: 'running' as const,
      updatedAt: now + 2,
    },
  }];

  // Reduce the same canonical task facts consumed by the Timeline and abort flow.
  const state = reduceConversationEvents(
    createEmptyConversationState(),
    runtimeEvents.flatMap(runtimeEventToConversationEvents),
  );
  const turnId = state.turnOrderBySession[sessionKey]?.[0];
  assert.ok(turnId);
  const selection = collectCancellableTasks(state.turnsById[turnId]);

  assert.deepEqual(selection.taskIds, [taskId, 'host-task-1']);
  assert.deepEqual(selection.nativeTaskIds, [taskId]);
  assert.deepEqual(selection.hostTaskIds, ['host-task-1']);
});

test('chat abort cancels the current run detached tasks before aborting the chat controller', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const context = {
    gatewayManager: {
      async rpc(method: string, params: unknown) {
        calls.push({ method, params });
        if (method === 'tasks.cancel') return { found: true, cancelled: true };
        if (method === 'chat.abort') return { ok: true, aborted: true, runIds: ['run-current'] };
        throw new Error(`Unexpected RPC ${method}`);
      },
    },
    clawHubService: {},
    eventBus: new HostEventBus(),
    mainWindow: null,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    void handleGatewayRoutes(req, res, url, context as never).then((handled) => {
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
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionKey: 'agent:main:session-1',
        runId: 'run-current',
        taskIds: ['task-image', 'task-subagent', 'task-image', ''],
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.map(({ method }) => method), ['tasks.cancel', 'tasks.cancel', 'chat.abort']);
    assert.deepEqual(calls[0]?.params, {
      taskId: 'task-image',
      reason: 'Cancelled from the UClaw chat composer.',
    });
    assert.deepEqual(calls[1]?.params, {
      taskId: 'task-subagent',
      reason: 'Cancelled from the UClaw chat composer.',
    });
    assert.deepEqual(calls[2]?.params, {
      sessionKey: 'agent:main:session-1',
      runId: 'run-current',
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
