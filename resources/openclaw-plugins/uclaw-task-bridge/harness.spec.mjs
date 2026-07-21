import assert from 'node:assert/strict';
import pluginEntry, { __test } from './index.mjs';

function makeApi() {
  const injections = [];
  const schedules = [];
  const unschedules = [];
  const registeredTools = [];
  const services = [];
  const agentEvents = [];
  return {
    injections,
    schedules,
    unschedules,
    registeredTools,
    services,
    agentEvents,
    logger: { warn() {} },
    uclawHost: {
      async scheduleSessionWake(payload) {
        schedules.push(payload);
        return {
          scheduled: true,
          wake: { id: `wake-${schedules.length}`, sessionKey: payload.sessionKey },
        };
      },
    },
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
        async unscheduleSessionTurnsByTag(payload) {
          unschedules.push(payload);
          return { removed: 0, failed: 0 };
        },
      },
    },
    agent: {
      events: {
        emitAgentEvent(payload) {
          agentEvents.push(payload);
          return { emitted: true, stream: payload.stream };
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
  acceptance: {
    source: 'host_capability',
    requiresArtifact: true,
    requiresVerification: true,
    requiredVerificationKinds: ['media.playable'],
  },
  completion: { mode: 'direct' },
  progress: [{ stage: 'compose', status: 'completed', percent: 100 }],
  artifacts: [{ id: 'artifact-1', role: 'final', filePath: '/tmp/final.mp4', mimeType: 'video/mp4' }],
  verifications: [{ id: 'verify-1', status: 'passed', kind: 'media.playable', required: true, artifactId: 'artifact-1' }],
});

assert.equal(task.taskId, 'task-1');
assert.equal(task.artifacts[0].filePath, '/tmp/final.mp4');
assert.deepEqual(task.recovery.supported, ['status_only', 'resume_if_safe']);
assert.equal(task.lifecycle.operations[0].kind, 'resume');
assert.equal(__test.taskEvents(task).some((event) => event.type === 'task.succeeded'), true);
assert.match(__test.buildTaskToolResult('status', task).content[0].text, /MEDIA:\/tmp\/final\.mp4/);
const mixedVerificationTask = __test.normalizeTask({
  ...task,
  taskId: 'task-mixed-artifacts',
  artifacts: [
    ...task.artifacts,
    { id: 'artifact-unverified', role: 'preview', filePath: '/tmp/unverified.mp4', mimeType: 'video/mp4' },
  ],
});
assert.deepEqual(__test.deliverableArtifacts(mixedVerificationTask).map((artifact) => artifact.id), ['artifact-1']);
const mixedDeliveryLines = __test.buildTaskToolResult('status', mixedVerificationTask).content[0].text
  .split('\n')
  .filter((line) => line.startsWith('MEDIA:'));
assert.deepEqual(mixedDeliveryLines, ['MEDIA:/tmp/final.mp4']);
const finalQaDeliveryTask = __test.normalizeTask({
  ...task,
  taskId: 'task-final-qa-delivery',
  artifacts: [
    { id: 'artifact-final-video', role: 'output', filePath: '/tmp/final-qa.mp4', mimeType: 'video/mp4' },
    { id: 'artifact-contact-sheet', role: 'diagnostic', filePath: '/tmp/contact-sheet.png', mimeType: 'image/png' },
  ],
  verifications: [
    { id: 'verify-final-metadata', status: 'passed', kind: 'media.metadata', required: true, artifactId: 'artifact-final-video' },
    { id: 'verify-final-qa', status: 'passed', kind: 'media.shot.qa', required: true, artifactId: 'artifact-final-video' },
  ],
});
assert.deepEqual(__test.deliverableArtifacts(finalQaDeliveryTask).map((artifact) => artifact.id), ['artifact-final-video']);
const noVerificationTask = __test.normalizeTask({
  ...task,
  taskId: 'task-no-verification',
  acceptance: {
    source: 'host_capability',
    requiresArtifact: true,
    requiresVerification: false,
    requiredVerificationKinds: [],
  },
  verifications: [],
});
assert.match(__test.buildTaskToolResult('status', noVerificationTask).content[0].text, /MEDIA:\/tmp\/final\.mp4/);
const failedTask = __test.normalizeTask({
  ...task,
  taskId: 'task-failed-artifact',
  status: 'blocked',
  verifications: [{ id: 'verify-failed', status: 'blocked', kind: 'media.playable', required: true, artifactId: 'artifact-1' }],
});
assert.doesNotMatch(__test.buildTaskToolResult('status', failedTask).content[0].text, /MEDIA:/);

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
assert.equal(api.injections.length, 0);
assert.equal(api.schedules.length, 1);
assert.equal(api.schedules[0].name, 'task-bridge-completion');
assert.deepEqual(api.schedules[0].tasks.map((entry) => entry.taskId), ['task-1']);
assert.equal(api.unschedules.length, 0);
assert.equal(api.agentEvents.length, 0);
assert.equal(ackCalls.length, 1);
assert.match(ackCalls[0].options.body, /"kind":"host_durable_session_wake"/);
assert.match(ackCalls[0].options.body, /"injectionEnqueued":false/);
assert.match(ackCalls[0].options.body, /"runtimeEventsEmitted":false/);
assert.match(ackCalls[0].options.body, /"sessionTurnScheduled":true/);

const internalTask = __test.normalizeTask({
  ...task,
  taskId: 'task-internal-compose',
  completion: { mode: 'internal' },
});
const internalApi = makeApi();
let internalAckCount = 0;
const internalBridge = __test.createBridge(internalApi, {
  hostApiFetch: async (route) => {
    if (route.endsWith('/ack')) internalAckCount += 1;
    return { ok: true };
  },
});
await internalBridge.deliverTerminalTask(internalTask);
assert.equal(internalAckCount, 1);
assert.equal(internalApi.injections.length, 0);
assert.equal(internalApi.schedules.length, 0);
assert.equal(internalApi.agentEvents.length, 0);

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
assert.equal(pollingApi.injections.length, 0);
assert.equal(pollingApi.schedules.length, 1);
assert.equal(pollingRoutes.filter((route) => route.endsWith('/ack')).length, 1);

const batchApi = makeApi();
const batchTasks = [
  __test.normalizeTask({ ...task, taskId: 'task-batch-1' }),
  __test.normalizeTask({ ...task, taskId: 'task-batch-2', completion: { mode: 'replan', reason: 'Review shot 2.' } }),
];
const batchAckRoutes = [];
const batchBridge = __test.createBridge(batchApi, {
  hostApiFetch: async (route) => {
    if (route.endsWith('/ack')) {
      batchAckRoutes.push(route);
      return { ok: true };
    }
    return { tasks: batchTasks };
  },
});
await batchBridge.poll();
assert.equal(batchApi.injections.length, 0);
assert.equal(batchApi.schedules.length, 1);
assert.equal(batchApi.schedules[0].name, 'task-bridge-batch');
assert.deepEqual(batchApi.schedules[0].tasks.map((entry) => entry.taskId), ['task-batch-1', 'task-batch-2']);
assert.equal(batchAckRoutes.length, 2);

const externalEventApi = makeApi();
externalEventApi.agent.events.emitAgentEvent = () => ({ emitted: false, reason: 'reserved stream' });
let externalEventAcknowledged = false;
const externalEventBridge = __test.createBridge(externalEventApi, {
  hostApiFetch: async (route) => {
    if (route.endsWith('/ack')) {
      externalEventAcknowledged = true;
      return { ok: true };
    }
    return { tasks: externalEventAcknowledged ? [] : [task] };
  },
});
await externalEventBridge.poll();
await externalEventBridge.poll();
assert.equal(externalEventApi.injections.length, 0);
assert.equal(externalEventApi.schedules.length, 1);
assert.equal(externalEventApi.agentEvents.length, 0);

const failedDirectWakeApi = makeApi();
failedDirectWakeApi.uclawHost.scheduleSessionWake = async (payload) => {
  failedDirectWakeApi.schedules.push(payload);
  throw new Error('direct wake unavailable');
};
let failedDirectWakeAckCount = 0;
let failedDirectWakeNow = 2_000;
const failedDirectWakeBridge = __test.createBridge(failedDirectWakeApi, {
  now: () => failedDirectWakeNow,
  completionRetryBaseMs: 100,
  completionRetryMaxMs: 1_000,
  hostApiFetch: async (route) => {
    if (route.endsWith('/ack')) {
      failedDirectWakeAckCount += 1;
      return { ok: true };
    }
    return { tasks: [task] };
  },
});
await failedDirectWakeBridge.poll();
await failedDirectWakeBridge.poll();
assert.equal(failedDirectWakeApi.schedules.length, 1);
assert.equal(failedDirectWakeApi.injections.length, 0);
failedDirectWakeNow += 100;
await failedDirectWakeBridge.poll();
assert.equal(failedDirectWakeApi.schedules.length, 2);
assert.equal(failedDirectWakeApi.injections.length, 0);
assert.equal(failedDirectWakeAckCount, 0);

const exhaustedRetryApi = makeApi();
exhaustedRetryApi.uclawHost.scheduleSessionWake = async (payload) => {
  exhaustedRetryApi.schedules.push(payload);
  throw new Error('session unavailable');
};
const exhaustedRetryAcks = [];
let exhaustedRetrySettled = false;
let exhaustedRetryNow = 2_000;
const exhaustedRetryBridge = __test.createBridge(exhaustedRetryApi, {
  now: () => exhaustedRetryNow,
  completionRetryBaseMs: 100,
  completionRetryMaxMs: 1_000,
  completionRetryMaxAttempts: 2,
  completionRetryMaxAgeMs: 10_000,
  hostApiFetch: async (route, options = {}) => {
    if (route.endsWith('/ack')) {
      exhaustedRetryAcks.push(JSON.parse(options.body));
      exhaustedRetrySettled = true;
      return { ok: true };
    }
    return { tasks: exhaustedRetrySettled ? [] : [task] };
  },
});
await exhaustedRetryBridge.poll();
assert.equal(exhaustedRetryAcks.length, 0);
exhaustedRetryNow += 100;
await exhaustedRetryBridge.poll();
assert.equal(exhaustedRetryAcks.length, 1);
assert.equal(exhaustedRetryAcks[0].delivery.outcome, 'abandoned');
assert.equal(exhaustedRetryAcks[0].delivery.attempts, 2);
assert.equal(exhaustedRetryAcks[0].delivery.reason, 'session_wake_failed');
assert.equal(exhaustedRetryAcks[0].delivery.details.scheduleError, 'session unavailable');
await exhaustedRetryBridge.poll();
assert.equal(exhaustedRetryApi.injections.length, 0);
assert.equal(exhaustedRetryApi.schedules.length, 2);
assert.equal(exhaustedRetryAcks.length, 1);

const replanTask = __test.normalizeTask({
  ...task,
  taskId: 'task-replan',
  completion: { mode: 'replan', reason: 'Continue the multi-step workflow after local rendering.' },
});
const failedWakeApi = makeApi();
failedWakeApi.uclawHost.scheduleSessionWake = async (payload) => {
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
    return { tasks: [replanTask] };
  },
});
await failedWakeBridge.poll();
await failedWakeBridge.poll();
assert.equal(failedWakeApi.schedules.length, 1);
assert.equal(failedWakeApi.injections.length, 0);
failedWakeNow += 100;
await failedWakeBridge.poll();
assert.equal(failedWakeApi.schedules.length, 2);
assert.equal(failedWakeApi.injections.length, 0);
assert.equal(failedWakeAckCount, 0);

const replanApi = makeApi();
let replanAckCount = 0;
const replanBridge = __test.createBridge(replanApi, {
  hostApiFetch: async (route) => {
    if (route.endsWith('/ack')) replanAckCount += 1;
    return { tasks: [replanTask] };
  },
});
await replanBridge.poll();
assert.equal(replanApi.schedules.length, 1);
assert.deepEqual(replanApi.schedules[0].tasks.map((entry) => entry.taskId), ['task-replan']);
assert.equal(replanApi.unschedules.length, 0);
assert.equal(replanAckCount, 1);

const replanAckFailureApi = makeApi();
let replanAckFailureCount = 0;
const replanAckFailureBridge = __test.createBridge(replanAckFailureApi, {
  hostApiFetch: async (route) => {
    if (route.endsWith('/ack')) {
      replanAckFailureCount += 1;
      throw new Error('ack unavailable');
    }
    return { tasks: [replanTask] };
  },
});
await replanAckFailureBridge.deliverTerminalTask(replanTask);
assert.equal(replanAckFailureApi.schedules.length, 1);
assert.equal(replanAckFailureApi.unschedules.length, 0);
assert.equal(replanAckFailureCount, 1);

const directAckFailureApi = makeApi();
let directAckFailureCount = 0;
const directAckFailureBridge = __test.createBridge(directAckFailureApi, {
  hostApiFetch: async (route) => {
    if (route.endsWith('/ack')) {
      directAckFailureCount += 1;
      throw new Error('ack unavailable');
    }
    return { tasks: [task] };
  },
});
await directAckFailureBridge.deliverTerminalTask(task);
assert.equal(directAckFailureApi.schedules.length, 1);
assert.equal(directAckFailureApi.unschedules.length, 0);
assert.equal(directAckFailureCount, 1);

const noInjectionApi = makeApi();
delete noInjectionApi.uclawHost;
delete noInjectionApi.session;
let noInjectionAckCount = 0;
const noInjectionWakeCalls = [];
const noInjectionBridge = __test.createBridge(noInjectionApi, {
  hostApiFetch: async (route, options = {}) => {
    if (route === '/api/task-bridge/session-wakes') {
      noInjectionWakeCalls.push(JSON.parse(options.body));
      return { scheduled: true, wake: { id: 'host-wake-1' } };
    }
    if (route.endsWith('/ack')) {
      noInjectionAckCount += 1;
      assert.match(options.body, /"injectionEnqueued":false/);
      return { ok: true };
    }
    return { tasks: noInjectionAckCount > 0 ? [] : [task] };
  },
});
await noInjectionBridge.poll();
await noInjectionBridge.poll();
assert.deepEqual(noInjectionWakeCalls, [{
  schema: 'uclaw.host-task.session-wake/v1',
  sessionKey: 'agent:main:session-1',
  taskIds: ['task-1'],
}]);
assert.equal(noInjectionAckCount, 1);
assert.equal(noInjectionApi.injections.length, 0);

const restartedApi = makeApi();
delete restartedApi.uclawHost;
delete restartedApi.session;
const staleUndeliveredTask = __test.normalizeTask({
  ...task,
  taskId: 'task-finished-before-restart',
  createdAt: 1,
  updatedAt: 1,
});
const restartedCalls = [];
const restartedBridge = __test.createBridge(restartedApi, {
  hostApiFetch: async (route, options = {}) => {
    restartedCalls.push({ route, options });
    if (route === '/api/task-bridge/session-wakes') {
      return { scheduled: true, wake: { id: 'wake-after-restart' } };
    }
    if (route.endsWith('/ack')) return { ok: true };
    return { tasks: [staleUndeliveredTask] };
  },
});
await restartedBridge.poll();
assert.equal(restartedCalls.some((call) => call.route === '/api/task-bridge/tasks'), false);
assert.equal(restartedCalls.filter((call) => call.route === '/api/task-bridge/session-wakes').length, 1);
assert.match(restartedCalls.find((call) => call.route === '/api/task-bridge/session-wakes').options.body, /task-finished-before-restart/);
assert.equal(restartedCalls.filter((call) => call.route.endsWith('/ack')).length, 1);

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
assert.match(startCalls[0].options.body, /"mode":"direct"/);

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
