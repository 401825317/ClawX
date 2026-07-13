import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { HostEventBus } from '../electron/api/event-bus.ts';
import { handleGatewayRoutes } from '../electron/api/routes/gateway.ts';
import {
  applyAsyncTaskEvidenceToRuns,
  collectRunDetachedTaskIdsForAbort,
  collectRunHostTaskIdsForAbort,
  extractAsyncTaskEvidence,
} from '../src/stores/chat/helpers.ts';

test('structured async task evidence exposes taskId before completion', () => {
  const taskId = '11111111-2222-4333-8444-555555555555';
  const activeRunId = 'run-current';
  const evidence = extractAsyncTaskEvidence({
    type: 'task.updated',
    taskId,
    runId: activeRunId,
    status: 'running',
  });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.taskId, taskId);
  assert.equal(evidence[0]?.status, 'pending');

  const runtimeRuns = applyAsyncTaskEvidenceToRuns(
    {
      [activeRunId]: {
        runId: activeRunId,
        sessionKey: 'agent:main:session-1',
        status: 'running',
        lastEventAt: Date.now(),
        assistantText: '',
        thinkingText: '',
        events: [],
      },
    },
    activeRunId,
    evidence,
    'agent:main:session-1',
  );
  assert.deepEqual(collectRunDetachedTaskIdsForAbort(runtimeRuns, activeRunId), [taskId]);
  assert.deepEqual(collectRunHostTaskIdsForAbort({
    [activeRunId]: {
      ...runtimeRuns[activeRunId]!,
      tasks: [{
        taskId: 'host-task-1',
        runtime: 'uclaw-host-task',
        title: 'Render locally',
        status: 'running',
      }],
    },
  }, activeRunId), ['host-task-1']);
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
