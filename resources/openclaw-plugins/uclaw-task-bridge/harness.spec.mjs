import assert from 'node:assert/strict';
import pluginEntry, { __test } from './index.mjs';

function makeApi() {
  const injections = [];
  const schedules = [];
  const registeredTools = [];
  const services = [];
  return {
    injections,
    schedules,
    registeredTools,
    services,
    logger: { warn() {} },
    registerTool(tool, options) {
      registeredTools.push({ tool, options });
    },
    registerService(service) {
      services.push(service);
    },
    lifecycle: {
      registerRuntimeLifecycle() {},
    },
    session: {
      workflow: {
        async enqueueNextTurnInjection(payload) {
          injections.push(payload);
          return { enqueued: true, id: payload.idempotencyKey, sessionKey: payload.sessionKey };
        },
        async scheduleSessionTurn(payload) {
          schedules.push(payload);
          return { id: 'scheduled-1', sessionKey: payload.sessionKey };
        },
      },
    },
  };
}

const task = __test.normalizeTask({
  schema: 'uclaw.host-task/v1',
  taskId: 'task-1',
  kind: 'local.video.compose',
  title: 'Compose final video',
  status: 'succeeded',
  revision: 2,
  recoverable: true,
  recovery: { supported: ['status_only', 'resume_if_safe'], checkpointAvailable: true },
  lifecycle: { operations: [{ kind: 'resume', status: 'completed', attempt: 1, startedAt: 10, finishedAt: 20 }] },
  correlation: {
    sessionKey: 'agent:main:session-1',
    runId: 'run-1',
    toolCallId: 'call-1',
    idempotencyKey: 'request-1',
  },
  progress: [{ stage: 'compose', status: 'completed', percent: 100 }],
  artifacts: [{ id: 'artifact-1', role: 'final', filePath: '/tmp/final.mp4', mimeType: 'video/mp4' }],
  verifications: [{ id: 'verify-1', status: 'passed', kind: 'media.playable', required: true }],
});

assert.equal(task.taskId, 'task-1');
assert.equal(task.artifacts[0].filePath, '/tmp/final.mp4');
assert.deepEqual(task.recovery.supported, ['status_only', 'resume_if_safe']);
assert.equal(task.lifecycle.operations[0].kind, 'resume');
assert.equal(__test.taskEvents(task).some((event) => event.type === 'task.succeeded'), true);
assert.match(__test.buildTaskToolResult('status', task).content[0].text, /MEDIA:\/tmp\/final\.mp4/);

const correlation = __test.correlationFromContext(
  { sessionKey: 'agent:main:session-1', runId: 'run-1' },
  'call-1',
);
assert.equal(correlation.idempotencyKey, 'uclaw-task-bridge:agent:main:session-1:run-1:call-1');

const api = makeApi();
const ackCalls = [];
const bridge = __test.createBridge(api, {
  hostApiFetch: async (route, options = {}) => {
    if (route.endsWith('/ack')) {
      ackCalls.push({ route, options });
      return { ok: true };
    }
    return { tasks: [task] };
  },
});
await bridge.deliverTerminalTask(task);
assert.equal(api.injections.length, 1);
assert.equal(api.injections[0].idempotencyKey, 'uclaw-task-bridge:completion:task-1:2');
assert.equal(api.schedules.length, 1);
assert.equal(ackCalls.length, 1);

const pollingApi = makeApi();
const pollingRoutes = [];
let pollingAcknowledged = false;
const pollingBridge = __test.createBridge(pollingApi, {
  hostApiFetch: async (route) => {
    pollingRoutes.push(route);
    if (route.endsWith('/ack')) {
      pollingAcknowledged = true;
      return { ok: true };
    }
    assert.match(route, /activeOnly=true/);
    assert.match(route, /includeTerminalUndelivered=true/);
    return { tasks: pollingAcknowledged ? [] : [task] };
  },
});
await pollingBridge.poll();
await pollingBridge.poll();
assert.equal(pollingApi.injections.length, 1);
assert.equal(pollingApi.schedules.length, 1);
assert.equal(pollingRoutes.filter((route) => route.endsWith('/ack')).length, 1);

const failedWakeApi = makeApi();
failedWakeApi.session.workflow.scheduleSessionTurn = async (payload) => {
  failedWakeApi.schedules.push(payload);
  throw new Error('wake unavailable');
};
let failedWakeAckCount = 0;
let failedWakeNow = 1_000;
const failedWakeBridge = __test.createBridge(failedWakeApi, {
  now: () => failedWakeNow,
  completionRetryBaseMs: 100,
  completionRetryMaxMs: 1_000,
  hostApiFetch: async (route) => {
    if (route.endsWith('/ack')) {
      failedWakeAckCount += 1;
      return { ok: true };
    }
    return { tasks: [task] };
  },
});
await failedWakeBridge.poll();
await failedWakeBridge.poll();
assert.equal(failedWakeApi.schedules.length, 1);
assert.equal(failedWakeApi.injections.length, 1);
failedWakeNow += 100;
await failedWakeBridge.poll();
assert.equal(failedWakeApi.schedules.length, 2);
assert.equal(failedWakeApi.injections.length, 2);
assert.equal(failedWakeApi.injections[0].idempotencyKey, failedWakeApi.injections[1].idempotencyKey);
assert.equal(failedWakeAckCount, 0);

const missingInjectionApi = makeApi();
let missingInjectionAckCount = 0;
let missingInjectionAttempts = 0;
let missingInjectionNow = 5_000;
missingInjectionApi.session.workflow.enqueueNextTurnInjection = async () => {
  missingInjectionAttempts += 1;
  return { enqueued: false, id: '' };
};
const missingInjectionBridge = __test.createBridge(missingInjectionApi, {
  now: () => missingInjectionNow,
  completionRetryBaseMs: 100,
  completionRetryMaxMs: 1_000,
  hostApiFetch: async (route) => {
    if (route.endsWith('/ack')) missingInjectionAckCount += 1;
    return { tasks: [task] };
  },
});
await missingInjectionBridge.poll();
await missingInjectionBridge.poll();
assert.equal(missingInjectionAttempts, 1);
missingInjectionNow += 100;
await missingInjectionBridge.poll();
assert.equal(missingInjectionAttempts, 2);
assert.equal(missingInjectionApi.schedules.length, 0);
assert.equal(missingInjectionAckCount, 0);

const queuedDuplicateApi = makeApi();
queuedDuplicateApi.session.workflow.enqueueNextTurnInjection = async () => ({ enqueued: false, id: 'existing-injection' });
let queuedDuplicateAckCount = 0;
const queuedDuplicateBridge = __test.createBridge(queuedDuplicateApi, {
  hostApiFetch: async (route) => {
    if (route.endsWith('/ack')) queuedDuplicateAckCount += 1;
    return { tasks: [task] };
  },
});
await queuedDuplicateBridge.poll();
assert.equal(queuedDuplicateApi.schedules.length, 1);
assert.equal(queuedDuplicateAckCount, 1);

const waitingTask = __test.normalizeTask({
  ...task,
  taskId: 'task-waiting',
  status: 'waiting',
  revision: 3,
});
assert.equal(__test.terminalTask(waitingTask), false);

const registrationApi = makeApi();
pluginEntry.register(registrationApi);
assert.equal(registrationApi.registeredTools.length, 1);
assert.equal(typeof registrationApi.registeredTools[0].tool, 'function');
assert.deepEqual(registrationApi.registeredTools[0].options.names, [
  'uclaw_get_runtime_capabilities',
  'uclaw_declare_turn_contract',
  'uclaw_get_task_bridge_capabilities',
  'uclaw_start_host_task',
  'uclaw_get_host_task',
  'uclaw_list_host_tasks',
  'uclaw_cancel_host_task',
  'uclaw_recover_host_task',
]);
assert.equal(registrationApi.services.length, 1);

const startCalls = [];
const startBridge = __test.createBridge(makeApi(), {
  hostApiFetch: async (route, options = {}) => {
    startCalls.push({ route, options });
    return task;
  },
});
const startTools = startBridge.createTools({
  sessionKey: 'agent:main:session-2',
  runId: 'run-2',
});
const capabilityTool = startTools.find((tool) => tool.name === 'uclaw_get_task_bridge_capabilities');
assert.match(capabilityTool.description, /local\.video\.timeline\.render/);
const startTool = startTools.find((tool) => tool.name === 'uclaw_start_host_task');
assert.match(startTool.description, /local\.video\.timeline\.render/);
const started = await startTool.execute(
  'call-2',
  { kind: 'local.video.compose', title: 'Compose final video' },
);
assert.equal(started.details.ok, true);
assert.equal(startCalls[0].route, '/api/task-bridge/tasks');
assert.match(startCalls[0].options.body, /agent:main:session-2/);
assert.match(startCalls[0].options.body, /run-2/);
assert.match(startCalls[0].options.body, /call-2/);

const recoveryCalls = [];
const recoveryBridge = __test.createBridge(makeApi(), {
  hostApiFetch: async (route, options = {}) => {
    recoveryCalls.push({ route, options });
    return task;
  },
});
const recoverTool = recoveryBridge.createTools({
  sessionKey: 'agent:main:session-1',
  runId: 'run-3',
}).find((tool) => tool.name === 'uclaw_recover_host_task');
const recovered = await recoverTool.execute(
  'call-3',
  { taskId: 'task-1', strategy: 'resume_if_safe' },
);
assert.equal(recovered.details.ok, true);
assert.equal(recoveryCalls[0].route, '/api/task-bridge/tasks/task-1/recover');
assert.match(recoveryCalls[0].options.body, /resume_if_safe/);

console.log('uclaw-task-bridge harness passed');
