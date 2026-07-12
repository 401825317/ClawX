import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const SESSION_KEY = 'agent:main:route-test';

async function waitForTask(
  origin: string,
  taskId: string,
  status: string,
  predicate: (task: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/task-bridge/tasks/${encodeURIComponent(taskId)}?sessionKey=${encodeURIComponent(SESSION_KEY)}`);
    const payload = await response.json() as { task?: Record<string, unknown> };
    if (payload.task?.status === status && predicate(payload.task)) return payload.task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for task ${taskId} to reach ${status}`);
}

test('Host task bridge routes delegate safe resume and cancellation to the registered executor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-host-task-route-'));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  const [{ HostEventBus }, { hostCapabilityRegistry }, { handleRuntimeRoutes }, { hostTaskService }] = await Promise.all([
    import('../electron/api/event-bus.ts'),
    import('../electron/services/agent-runtime/host-capability-registry.ts'),
    import('../electron/api/routes/runtime.ts'),
    import('../electron/services/agent-runtime/host-task-service.ts'),
  ]);
  const kind = `test.safe-observe.${Date.now()}`;
  let resumes = 0;
  let cancels = 0;
  let starts = 0;
  hostCapabilityRegistry.register({
    descriptor: {
      kind,
      label: 'Safe observation test',
      description: 'No-side-effect route integration executor',
      sideEffect: 'none',
      requiresApproval: false,
    },
    async start(context) {
      starts += 1;
      const input = context.input as { mode?: string };
      if (input.mode === 'throw') throw new Error('simulated start failure');
      if (input.mode === 'cancel') {
        await context.update({ status: 'running', checkpoint: { phase: 'working' } });
        return;
      }
      await context.update({ status: 'lost', checkpoint: { phase: 'interrupted', cursor: 3 }, error: 'simulated interruption' });
    },
    async resume(context) {
      resumes += 1;
      assert.deepEqual(context.checkpoint, { phase: 'interrupted', cursor: 3 });
      await context.update({ status: 'running', checkpoint: { phase: 'resumed', cursor: 4 } });
      await context.update({ status: 'succeeded', checkpoint: { phase: 'completed', cursor: 4 } });
    },
    async cancel(context) {
      cancels += 1;
      assert.equal(context.reason, 'route cancellation');
    },
  });

  const context = {
    gatewayManager: {},
    clawHubService: {},
    eventBus: new HostEventBus(),
    mainWindow: null,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    void handleRuntimeRoutes(req, res, url, context as never).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  const start = async (idempotencyKey: string, input: Record<string, unknown>) => {
    const response = await fetch(`${origin}/api/task-bridge/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind,
        title: `Route task ${idempotencyKey}`,
        input,
        correlation: {
          sessionKey: SESSION_KEY,
          runId: 'run-route-test',
          toolCallId: `tool-${idempotencyKey}`,
          idempotencyKey,
        },
      }),
    });
    const payload = await response.json() as { task?: { taskId?: string } };
    assert.equal(response.status, 202);
    assert.ok(payload.task?.taskId);
    return payload.task.taskId;
  };

  try {
    const capabilitiesResponse = await fetch(`${origin}/api/task-bridge/capabilities`);
    const capabilitiesPayload = await capabilitiesResponse.json() as { capabilities?: Array<{ kind?: string; operations?: unknown }> };
    const capability = capabilitiesPayload.capabilities?.find((item) => item.kind === kind);
    assert.deepEqual(capability?.operations, { start: true, cancel: true, resume: true });

    const orphanRequest = {
      sessionKey: SESSION_KEY,
      runId: 'run-route-test',
      toolCallId: 'tool-route-orphan',
      idempotencyKey: 'route-orphan',
      capability: kind,
      title: 'Route task route-orphan',
      input: { mode: 'resume' },
    };
    const orphan = await hostTaskService.create(orphanRequest);
    const orphanReplayResponse = await fetch(`${origin}/api/task-bridge/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind,
        title: orphanRequest.title,
        input: orphanRequest.input,
        correlation: {
          sessionKey: orphanRequest.sessionKey,
          runId: orphanRequest.runId,
          toolCallId: orphanRequest.toolCallId,
          idempotencyKey: orphanRequest.idempotencyKey,
        },
      }),
    });
    assert.equal(orphanReplayResponse.status, 200);
    const orphanReplay = await orphanReplayResponse.json() as { idempotent?: boolean };
    assert.equal(orphanReplay.idempotent, true);
    await waitForTask(origin, orphan.task.taskId, 'lost');
    assert.equal(starts, 1);

    const crossSessionGet = await fetch(`${origin}/api/task-bridge/tasks/${encodeURIComponent(orphan.task.taskId)}?sessionKey=${encodeURIComponent('agent:main:other-session')}`);
    assert.equal(crossSessionGet.status, 404);

    const crossSessionRecover = await fetch(`${origin}/api/task-bridge/tasks/${encodeURIComponent(orphan.task.taskId)}/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        strategy: 'resume_if_safe',
        correlation: { sessionKey: 'agent:main:other-session' },
      }),
    });
    assert.equal(crossSessionRecover.status, 404);

    const secondOrphanReplayResponse = await fetch(`${origin}/api/task-bridge/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind,
        title: orphanRequest.title,
        input: orphanRequest.input,
        correlation: {
          sessionKey: orphanRequest.sessionKey,
          runId: orphanRequest.runId,
          toolCallId: orphanRequest.toolCallId,
          idempotencyKey: orphanRequest.idempotencyKey,
        },
      }),
    });
    assert.equal(secondOrphanReplayResponse.status, 200);
    assert.equal(starts, 1);

    const failedTaskId = await start('route-failed-replay', { mode: 'throw' });
    await waitForTask(origin, failedTaskId, 'failed');
    const startsAfterFailure = starts;
    const failedReplayResponse = await fetch(`${origin}/api/task-bridge/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind,
        title: 'Route task route-failed-replay',
        input: { mode: 'throw' },
        correlation: {
          sessionKey: SESSION_KEY,
          runId: 'run-route-test',
          toolCallId: 'tool-route-failed-replay',
          idempotencyKey: 'route-failed-replay',
        },
      }),
    });
    assert.equal(failedReplayResponse.status, 200);
    assert.equal(starts, startsAfterFailure);

    const recoverTaskId = await start('route-resume', { mode: 'resume' });
    await waitForTask(origin, recoverTaskId, 'lost', (task) => {
      const operations = (task.lifecycle as { operations?: Array<{ status?: string }> } | undefined)?.operations;
      return operations?.at(-1)?.status === 'completed';
    });
    const recoverResponse = await fetch(`${origin}/api/task-bridge/tasks/${encodeURIComponent(recoverTaskId)}/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: 'resume_if_safe', correlation: { sessionKey: SESSION_KEY } }),
    });
    assert.equal(recoverResponse.status, 202);
    const resumed = await waitForTask(origin, recoverTaskId, 'succeeded');
    assert.equal((resumed.recovery as { checkpointAvailable?: boolean })?.checkpointAvailable, true);
    assert.equal(resumes, 1);

    const cancelTaskId = await start('route-cancel', { mode: 'cancel' });
    await waitForTask(origin, cancelTaskId, 'running');
    const cancelResponse = await fetch(`${origin}/api/task-bridge/tasks/${encodeURIComponent(cancelTaskId)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'route cancellation', correlation: { sessionKey: SESSION_KEY } }),
    });
    assert.equal(cancelResponse.status, 202);
    const cancelled = await waitForTask(origin, cancelTaskId, 'cancelled');
    assert.equal(cancels, 1);

    const lateUpdateResponse = await fetch(`${origin}/api/runtime/tasks/${encodeURIComponent(cancelTaskId)}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        progress: { detail: 'late route callback' },
        artifacts: [{ id: 'late-route-artifact', filePath: '/tmp/late-route.txt' }],
      }),
    });
    assert.equal(lateUpdateResponse.status, 410);

    const lateCompleteResponse = await fetch(`${origin}/api/runtime/tasks/${encodeURIComponent(cancelTaskId)}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'succeeded' }),
    });
    assert.equal(lateCompleteResponse.status, 410);
    const afterLateCallbacks = await hostTaskService.get(cancelTaskId);
    assert.equal(afterLateCallbacks?.status, 'cancelled');
    assert.equal(afterLateCallbacks?.revision, cancelled.revision);
    assert.equal(afterLateCallbacks?.artifacts.some((artifact) => artifact.id === 'late-route-artifact'), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await rm(root, { recursive: true, force: true });
  }
});
