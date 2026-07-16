import assert from 'node:assert/strict';
import test from 'node:test';

import type { HostTaskSnapshot } from '../electron/services/agent-runtime/host-task-service.ts';
import {
  buildTaskBridgeWakeMessage,
  extractTaskBridgeWakeTaskIds,
  scheduleTaskBridgeSessionWake,
  taskBridgeWakeJobName,
  type TaskBridgeWakeGateway,
} from '../electron/services/agent-runtime/host-task-session-wake.ts';

function makeTask(taskId: string, overrides: Partial<HostTaskSnapshot> = {}): HostTaskSnapshot {
  return {
    version: 3,
    taskId,
    sessionKey: 'agent:main:test-session',
    runId: `run-${taskId}`,
    toolCallId: `tool-${taskId}`,
    idempotencyKey: `request-${taskId}`,
    capability: 'local.video.shot.qa',
    title: `QA ${taskId}`,
    input: { sourcePath: `/tmp/${taskId}.mp4`, expectedWidth: 720, expectedHeight: 1280 },
    acceptance: {
      source: 'host_capability',
      requiresArtifact: true,
      requiresVerification: true,
      requiredVerificationKinds: ['media.shot.qa'],
    },
    completion: { mode: 'replan', reason: 'Continue semantic review without rerunning QA.' },
    status: 'succeeded',
    createdAt: 1,
    updatedAt: 2,
    revision: 4,
    progress: { completed: 3, total: 3, detail: 'QA complete' },
    artifacts: [
      { id: `${taskId}-contact`, kind: 'image', title: 'Shot QA contact sheet', filePath: `/tmp/${taskId}-contact.png`, mimeType: 'image/png' },
      { id: `${taskId}-sample-1`, kind: 'image', title: 'sample-01.jpg', filePath: `/tmp/${taskId}-sample-01.jpg`, mimeType: 'image/jpeg' },
      { id: `${taskId}-sample-2`, kind: 'image', title: 'sample-02.jpg', filePath: `/tmp/${taskId}-sample-02.jpg`, mimeType: 'image/jpeg' },
    ],
    verifications: [{
      id: `${taskId}-qa`,
      status: 'passed',
      kind: 'media.shot.qa',
      required: true,
      detail: '{"blackFrameCount":0,"possibleFreeze":false}',
      evidence: `/tmp/${taskId}-contact.png`,
      artifactId: `${taskId}-contact`,
    }],
    completionAcks: [],
    lifecycle: { operations: [] },
    ...overrides,
  };
}

function makeGateway(handler: (method: string, params: unknown) => unknown | Promise<unknown>): TaskBridgeWakeGateway {
  return {
    async rpc<T>(method: string, params?: unknown): Promise<T> {
      return await handler(method, params) as T;
    },
  };
}

test('wake message carries trusted task evidence without every diagnostic sample', () => {
  const task = makeTask('task-1');
  const message = buildTaskBridgeWakeMessage([task]);
  assert.deepEqual(extractTaskBridgeWakeTaskIds(message), ['task-1']);
  assert.match(message, /Never rerun|never rerun/);
  assert.match(message, /task-1-contact\.png/);
  assert.doesNotMatch(message, /task-1-sample-01\.jpg/);
  assert.match(message, /"sourcePath":"\/tmp\/task-1\.mp4"/);
});

test('same-session pending wake is replaced with one merged durable cron job', async () => {
  const first = makeTask('task-1');
  const second = makeTask('task-2');
  const tasks = new Map([[first.taskId, first], [second.taskId, second]]);
  const calls: Array<{ method: string; params: unknown }> = [];
  const existingMessage = buildTaskBridgeWakeMessage([first]);
  const gateway = makeGateway(async (method, params) => {
    calls.push({ method, params });
    if (method === 'cron.list') {
      return {
        jobs: [{
          id: 'wake-old',
          name: taskBridgeWakeJobName(first.sessionKey),
          payload: { message: existingMessage },
        }],
      };
    }
    if (method === 'cron.remove') return { removed: true };
    if (method === 'cron.add') return { id: 'wake-new' };
    throw new Error(`Unexpected RPC ${method}`);
  });

  const scheduled = await scheduleTaskBridgeSessionWake(gateway, first.sessionKey, [second.taskId], {
    getTask: async (taskId) => tasks.get(taskId),
    now: () => 1_000,
  });

  assert.deepEqual(scheduled.taskIds, ['task-2', 'task-1']);
  assert.deepEqual(calls.map((call) => call.method), ['cron.list', 'cron.remove', 'cron.add']);
  const add = calls.find((call) => call.method === 'cron.add');
  assert.ok(add);
  const addParams = add.params as {
    sessionTarget: string;
    schedule: { at: string };
    payload: { message: string };
  };
  assert.equal(addParams.sessionTarget, `session:${first.sessionKey}`);
  assert.equal(addParams.schedule.at, new Date(3_000).toISOString());
  assert.deepEqual(extractTaskBridgeWakeTaskIds(addParams.payload.message), ['task-2', 'task-1']);
});

test('cross-session task is rejected before mutating cron state', async () => {
  const task = makeTask('task-cross', { sessionKey: 'agent:main:other-session' });
  let rpcCalls = 0;
  await assert.rejects(
    scheduleTaskBridgeSessionWake(makeGateway(() => {
      rpcCalls += 1;
      return {};
    }), 'agent:main:test-session', [task.taskId], {
      getTask: async () => task,
    }),
    /unknown or cross-session task/,
  );
  assert.equal(rpcCalls, 0);
});

test('unconfirmed cron add fails so Task Bridge keeps the task unacknowledged', async () => {
  const task = makeTask('task-unconfirmed');
  const gateway = makeGateway((method) => {
    if (method === 'cron.list') return { jobs: [] };
    if (method === 'cron.add') return {};
    throw new Error(`Unexpected RPC ${method}`);
  });
  await assert.rejects(
    scheduleTaskBridgeSessionWake(gateway, task.sessionKey, [task.taskId], {
      getTask: async () => task,
    }),
    /did not confirm/,
  );
});
