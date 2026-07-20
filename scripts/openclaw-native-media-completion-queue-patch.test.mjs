import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { join } from 'node:path';

import { patchOpenClawNativeMediaCompletionQueueContent } from './openclaw-native-media-completion-queue-patch.mjs';

async function findMediaFixture() {
  const distDir = join(process.cwd(), 'node_modules', 'openclaw', 'dist');
  for (const entry of await readdir(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = await readFile(filePath, 'utf8');
    if (content.includes('async function wakeMediaGenerationTaskCompletion(params) {')) {
      return { filePath, content };
    }
  }
  throw new Error('OpenClaw native media completion fixture was not found.');
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushAsyncQueue() {
  await new Promise((resolve) => setImmediate(resolve));
}

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

const fixture = await findMediaFixture();
const first = patchOpenClawNativeMediaCompletionQueueContent(fixture.content, fixture.filePath);
assert.equal(first.matched, true);
assert.equal(first.changed || first.content.includes('UCLAW_NATIVE_MEDIA_COMPLETION_CONTRACT_V2'), true);
assert.match(first.content, /UCLAW_NATIVE_MEDIA_COMPLETION_CONTRACT_V2/u);
assert.match(first.content, /UCLAW_SESSION_COORDINATOR_V1/u);
assert.match(first.content, /UCLAW_ARTIFACT_STATUS=available/u);
assert.match(first.content, /const localArtifactPath =/u);
assert.match(first.content, /setDetachedTaskDeliveryStatusByRunId/u);
assert.match(first.content, /setUclawNativeMediaDeliveryStatus\(\{ handle: params\.handle \}, "failed", error\)/u);
assert.match(first.content, /media-completion:/u);
assert.match(first.content, /Generated media; persisting artifact before delivery/u);
assert.match(first.content, /typeof executed\.contentText === "string"/u);
assert.doesNotMatch(first.content, /UCLAW_NATIVE_MEDIA_COMPLETION_SESSION_QUEUES/u);
assert.equal(countOccurrences(first.content, 'async function wakeMediaGenerationTaskCompletion(params) {'), 1);
assert.equal(countOccurrences(first.content, 'async function wakeMediaGenerationTaskCompletionQueued(params) {'), 1);

const second = patchOpenClawNativeMediaCompletionQueueContent(first.content, fixture.filePath);
assert.equal(second.changed, false);
assert.equal(second.content, first.content);

const queuedAnchor = `async function wakeMediaGenerationTaskCompletionQueued(params) {
\tif (!params.handle || isUClawNativeMediaTaskCancelled(params.handle)) return true;`;
const recursiveQueuedWrapper = `async function wakeMediaGenerationTaskCompletionQueued(params) {
\tif (!params.handle || isUClawNativeMediaTaskCancelled(params.handle)) return true;
\treturn await runUclawNativeMediaCompletionInSessionQueue(params.handle.requesterSessionKey, async () => {
\t\tif (isUClawNativeMediaTaskCancelled(params.handle)) return true;
\t\treturn await wakeMediaGenerationTaskCompletionQueued(params);
\t});
}
`;
const duplicated = first.content.replace(queuedAnchor, recursiveQueuedWrapper + queuedAnchor);
assert.equal(countOccurrences(duplicated, 'async function wakeMediaGenerationTaskCompletionQueued(params) {'), 2);
const repaired = patchOpenClawNativeMediaCompletionQueueContent(duplicated, fixture.filePath);
assert.equal(repaired.changed, true);
assert.equal(repaired.content, first.content);

const helperStart = first.content.indexOf('const UCLAW_NATIVE_MEDIA_COMPLETION_CONTRACT_V2');
const helperEnd = first.content.indexOf('async function wakeMediaGenerationTaskCompletion(params) {', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const helperSource = first.content.slice(helperStart, helperEnd)
  + '\nglobalThis.runMediaQueue = runUclawNativeMediaCompletionInSessionQueue;';
const context = vm.createContext({
  events: [],
  globalThis: undefined,
  Map,
  Promise,
  String,
  Symbol,
  setImmediate,
});
context.globalThis = context;
new vm.Script(helperSource).runInContext(context);

const firstWait = deferred();
const secondWait = deferred();
const firstRun = context.runMediaQueue('session-a', async () => {
  context.events.push('start:first');
  await firstWait.promise;
  context.events.push('end:first');
});
await flushAsyncQueue();
const secondRun = context.runMediaQueue('session-a', async () => {
  context.events.push('start:second');
  await secondWait.promise;
  context.events.push('end:second');
});
await flushAsyncQueue();
assert.deepEqual(context.events, ['start:first']);
firstWait.resolve();
await firstRun;
await flushAsyncQueue();
assert.deepEqual(context.events, ['start:first', 'end:first', 'start:second']);
secondWait.resolve();
await secondRun;
assert.deepEqual(context.events, ['start:first', 'end:first', 'start:second', 'end:second']);

const independent = [];
const left = context.runMediaQueue('session-left', async () => independent.push('left'));
const right = context.runMediaQueue('session-right', async () => independent.push('right'));
await Promise.all([left, right]);
assert.deepEqual(new Set(independent), new Set(['left', 'right']));

console.log('openclaw native media completion contract patch tests passed');
