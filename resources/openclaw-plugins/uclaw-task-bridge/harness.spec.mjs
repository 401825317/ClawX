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
    registerTool(tool) {
      registeredTools.push(tool);
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

const registrationApi = makeApi();
pluginEntry.register(registrationApi);
assert.equal(registrationApi.registeredTools.length, 6);
assert.equal(registrationApi.services.length, 1);

const startCalls = [];
const startBridge = __test.createBridge(makeApi(), {
  hostApiFetch: async (route, options = {}) => {
    startCalls.push({ route, options });
    return task;
  },
});
const startTool = startBridge.createTools().find((tool) => tool.name === 'uclaw_start_host_task');
const started = await startTool.execute(
  'call-2',
  { kind: 'local.video.compose', title: 'Compose final video' },
  undefined,
  undefined,
  { sessionKey: 'agent:main:session-2', runId: 'run-2' },
);
assert.equal(started.details.ok, true);
assert.equal(startCalls[0].route, '/api/task-bridge/tasks');
assert.match(startCalls[0].options.body, /agent:main:session-2/);
assert.match(startCalls[0].options.body, /run-2/);
assert.match(startCalls[0].options.body, /call-2/);

console.log('uclaw-task-bridge harness passed');
