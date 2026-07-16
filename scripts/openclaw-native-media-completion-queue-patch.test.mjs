import assert from 'node:assert/strict';
import vm from 'node:vm';

import { patchOpenClawNativeMediaCompletionQueueContent } from './openclaw-native-media-completion-queue-patch.mjs';

const fixture = `
function isUClawNativeMediaTaskCancelled(handle) {
\treturn handle?.cancelled === true;
}
async function wakeMediaGenerationTaskCompletion(params) {
\tif (!params.handle || isUClawNativeMediaTaskCancelled(params.handle)) return true;
\tglobalThis.events.push(\`start:\${params.handle.taskId}\`);
\tawait params.wait;
\tglobalThis.events.push(\`end:\${params.handle.taskId}\`);
\treturn params.handle.taskId;
}
globalThis.wake = wakeMediaGenerationTaskCompletion;
`;

const patched = patchOpenClawNativeMediaCompletionQueueContent(fixture);
assert.equal(patched.changed, true);
assert.match(patched.content, /UCLAW_NATIVE_MEDIA_COMPLETION_SESSION_QUEUE_V1/);
assert.equal(patchOpenClawNativeMediaCompletionQueueContent(patched.content).changed, false);

function createRuntime() {
  const context = vm.createContext({ events: [], Promise, Map, String });
  new vm.Script(patched.content).runInContext(context);
  return context;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushAsyncQueue() {
  await new Promise((resolve) => setImmediate(resolve));
}

const sameSession = createRuntime();
const first = deferred();
const second = deferred();
const firstRun = sameSession.wake({ handle: { taskId: 'one', requesterSessionKey: 'session-a' }, wait: first.promise });
await flushAsyncQueue();
const secondRun = sameSession.wake({ handle: { taskId: 'two', requesterSessionKey: 'session-a' }, wait: second.promise });
await flushAsyncQueue();
assert.deepEqual([...sameSession.events], ['start:one']);
first.resolve();
assert.equal(await firstRun, 'one');
await flushAsyncQueue();
assert.deepEqual([...sameSession.events], ['start:one', 'end:one', 'start:two']);
second.resolve();
assert.equal(await secondRun, 'two');
assert.deepEqual([...sameSession.events], ['start:one', 'end:one', 'start:two', 'end:two']);

const differentSessions = createRuntime();
const left = deferred();
const right = deferred();
const leftRun = differentSessions.wake({ handle: { taskId: 'left', requesterSessionKey: 'session-left' }, wait: left.promise });
const rightRun = differentSessions.wake({ handle: { taskId: 'right', requesterSessionKey: 'session-right' }, wait: right.promise });
await flushAsyncQueue();
assert.deepEqual(new Set(differentSessions.events), new Set(['start:left', 'start:right']));
left.resolve();
right.resolve();
await Promise.all([leftRun, rightRun]);

const cancelled = createRuntime();
assert.equal(await cancelled.wake({ handle: { taskId: 'cancelled', requesterSessionKey: 'session-a', cancelled: true }, wait: Promise.resolve() }), true);
assert.deepEqual([...cancelled.events], []);

console.log('openclaw native media completion queue patch tests passed');
