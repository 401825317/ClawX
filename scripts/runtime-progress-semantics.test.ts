import assert from 'node:assert/strict';
import type { ChatRuntimeEvent } from '../shared/chat-runtime-events';
import { applyRuntimeEventToRuns } from '../src/stores/chat/runtime-graph';
import { buildRuntimeProgressEvents } from '../src/stores/chat/runtime-progress';
import type { ChatRuntimeRunState } from '../src/stores/chat/types';

const runId = 'run-semantic-progress';
const sessionKey = 'agent:main:test-semantic-progress';
let ts = 1_000;
let runs: Record<string, ChatRuntimeRunState> = {};

function base<T extends ChatRuntimeEvent>(event: Omit<T, 'contractVersion' | 'producer' | 'runId' | 'sessionKey' | 'ts'>): T {
  ts += 1;
  return {
    contractVersion: 1,
    producer: 'gateway',
    runId,
    sessionKey,
    ts,
    ...event,
  } as T;
}

function apply(event: ChatRuntimeEvent): ChatRuntimeEvent[] {
  runs = applyRuntimeEventToRuns(runs, event);
  const progressEvents = buildRuntimeProgressEvents(runs[runId], event);
  for (const progressEvent of progressEvents) {
    runs = applyRuntimeEventToRuns(runs, progressEvent);
  }
  return progressEvents;
}

function actionEntries() {
  return (runs[runId]?.progressEntries ?? []).filter((entry) => entry.kind === 'action');
}

apply(base({ type: 'run.started', startedAt: ts }));

const describeCallId = 'call-describe-video';
assert.deepEqual(apply(base({
  type: 'tool.started',
  toolCallId: describeCallId,
  name: 'tool_describe',
  args: { id: 'video_generate' },
})), []);
assert.deepEqual(apply(base({
  type: 'tool.completed',
  toolCallId: describeCallId,
  name: 'tool_describe',
  result: { id: 'openclaw:core:video_generate', name: 'video_generate', label: 'Video Generation' },
})), []);

const searchCallId = 'call-web-search';
apply(base({
  type: 'tool.started',
  toolCallId: searchCallId,
  name: 'tool_call',
  args: {
    id: 'web_search',
    args: { query: '小米 SU7 Ultra 官方性能参数', count: 5 },
  },
}));
apply(base({
  type: 'tool.completed',
  toolCallId: searchCallId,
  name: 'tool_call',
  result: {
    tool: { name: 'web_search', label: 'Web Search' },
    result: { details: { count: 5, tookMs: 2_000 } },
  },
}));

const listVideoCallId = 'call-video-list';
assert.deepEqual(apply(base({
  type: 'tool.started',
  toolCallId: listVideoCallId,
  name: 'tool_call',
  args: { id: 'video_generate', args: { action: 'list' } },
})), []);
assert.deepEqual(apply(base({
  type: 'tool.completed',
  toolCallId: listVideoCallId,
  name: 'tool_call',
  result: {
    tool: { name: 'video_generate', label: 'Video Generation' },
    result: { details: { status: 'completed', items: [] } },
  },
})), []);
assert.equal(actionEntries().length, 1);

const longPrompt = '制作电影级汽车宣传片'.repeat(200);
const videoCallId = 'call-video-generate';
apply(base({
  type: 'tool.started',
  toolCallId: videoCallId,
  name: 'tool_call',
  args: {
    id: 'video_generate',
    args: {
      action: 'generate',
      prompt: longPrompt,
      durationSeconds: 60,
      size: '1920x1080',
      resolution: '1080P',
      aspectRatio: '16:9',
      audio: true,
    },
  },
}));
apply(base({
  type: 'tool.completed',
  toolCallId: videoCallId,
  name: 'tool_call',
  result: JSON.stringify({
    tool: { name: 'video_generate', label: 'Video Generation' },
    result: {
      content: [{ type: 'text', text: 'Background task started.' }],
      details: {
        async: true,
        status: 'started',
        taskId: 'video-task-1',
        runId: 'tool:video_generate:1',
        durationSeconds: 60,
        size: '1920x1080',
        resolution: '1080P',
        aspectRatio: '16:9',
        audio: true,
      },
    },
  }),
}));

let actions = actionEntries();
assert.equal(actions.length, 2);
const search = actions.find((entry) => entry.toolName === 'web_search');
const video = actions.find((entry) => entry.toolName === 'video_generate');
assert.equal(search?.translationKey, 'runtimeProgress.toolCompleted');
assert.equal(search?.status, 'completed');
assert.match(search?.command ?? '', /SU7 Ultra/u);
assert.equal(video?.translationKey, 'runtimeProgress.toolSubmitted');
assert.equal(video?.status, 'running');
assert.equal(video?.taskId, 'video-task-1');
assert.match(video?.command ?? '', /60s/u);
assert.match(video?.command ?? '', /1920x1080/u);
assert.doesNotMatch(video?.command ?? '', /制作电影级汽车宣传片/u);
assert.equal(actions.some((entry) => entry.text === '已运行' || entry.text === '正在执行'), false);
assert.equal(actions.some((entry) => /tool_call|tool_describe/iu.test(entry.text)), false);

apply(base({
  type: 'task.updated',
  task: {
    taskId: 'video-task-1',
    runtime: 'video_generate',
    title: '生成 1 分钟宣传片',
    status: 'running',
    updatedAt: ts,
  },
}));
assert.equal(actionEntries().find((entry) => entry.toolName === 'video_generate')?.translationKey, 'runtimeProgress.toolSubmitted');

apply(base({
  type: 'task.updated',
  task: {
    taskId: 'video-task-1',
    runtime: 'video_generate',
    title: '生成 1 分钟宣传片',
    detail: '视频生成服务暂时不可用（HTTP 503）',
    status: 'error',
    sourceStatus: 'failed',
    terminalOutcome: 'failed',
    updatedAt: ts,
    endedAt: ts,
  },
}));

actions = actionEntries();
const failedVideo = actions.find((entry) => entry.toolName === 'video_generate');
assert.equal(failedVideo?.translationKey, 'runtimeProgress.toolFailed');
assert.equal(failedVideo?.status, 'error');
assert.equal((runs[runId]?.progressEntries ?? []).some((entry) => /HTTP 503/u.test(entry.text)), true);

const partialRunId = 'run-partial-video';
let partialRuns: Record<string, ChatRuntimeRunState> = {};
function applyPartial(event: ChatRuntimeEvent): void {
  partialRuns = applyRuntimeEventToRuns(partialRuns, event);
  for (const progressEvent of buildRuntimeProgressEvents(partialRuns[partialRunId], event)) {
    partialRuns = applyRuntimeEventToRuns(partialRuns, progressEvent);
  }
}
applyPartial({
  type: 'tool.started', runId: partialRunId, sessionKey, ts: 1,
  toolCallId: 'partial-video', name: 'tool_call',
  args: { id: 'video_generate', args: { durationSeconds: 60, resolution: '1080P', audio: true } },
});
applyPartial({
  type: 'tool.completed', runId: partialRunId, sessionKey, ts: 2,
  toolCallId: 'partial-video', name: 'tool_call',
  result: { tool: { name: 'video_generate', label: 'Video Generation' }, result: { details: { async: true, status: 'started', taskId: 'partial-video-task' } } },
});
applyPartial({
  type: 'task.updated', runId: partialRunId, sessionKey, ts: 3,
  task: {
    taskId: 'partial-video-task', title: '生成一分钟视频', status: 'completed',
    sourceStatus: 'succeeded', terminalOutcome: 'blocked',
    detail: 'Generated intermediate video; requested 60s, actual 12s; audio unsupported',
    updatedAt: 3, endedAt: 3,
  },
});
const partialAction = partialRuns[partialRunId]?.progressEntries?.find((entry) => entry.kind === 'action');
assert.equal(partialAction?.translationKey, 'runtimeProgress.toolPartial');
assert.equal(partialAction?.status, 'blocked');
assert.equal(partialAction?.command, '');
assert.equal((partialRuns[partialRunId]?.progressEntries ?? []).some((entry) => /actual 12s/u.test(entry.text)), true);

function applyWithDerivedProgress(
  current: Record<string, ChatRuntimeRunState>,
  event: ChatRuntimeEvent,
): Record<string, ChatRuntimeRunState> {
  let next = applyRuntimeEventToRuns(current, event);
  if (next === current || event.type === 'progress.update') return next;
  for (const progressEvent of buildRuntimeProgressEvents(next[event.runId], event)) {
    next = applyRuntimeEventToRuns(next, progressEvent);
  }
  return next;
}

const reverseRunId = 'run-reverse-tool-order';
let reverseRuns: Record<string, ChatRuntimeRunState> = {};
reverseRuns = applyWithDerivedProgress(reverseRuns, {
  type: 'tool.completed',
  runId: reverseRunId,
  sessionKey,
  ts: 200,
  toolCallId: 'reverse-video',
  name: 'tool_call',
  result: {
    tool: { name: 'video_generate', label: 'Video Generation' },
    result: { details: { async: true, status: 'started', taskId: 'reverse-task' } },
  },
});
reverseRuns = applyWithDerivedProgress(reverseRuns, {
  type: 'tool.started',
  runId: reverseRunId,
  sessionKey,
  ts: 100,
  toolCallId: 'reverse-video',
  name: 'tool_call',
  args: { id: 'video_generate', args: { durationSeconds: 5 } },
});
const reverseAction = reverseRuns[reverseRunId]?.progressEntries?.find((entry) => entry.kind === 'action');
assert.equal(reverseAction?.translationKey, 'runtimeProgress.toolSubmitted');
assert.equal(reverseAction?.taskId, 'reverse-task');

const historyMetaRunId = 'run-history-meta-task';
let historyMetaRuns: Record<string, ChatRuntimeRunState> = {};
historyMetaRuns = applyWithDerivedProgress(historyMetaRuns, {
  type: 'tool.started',
  runId: historyMetaRunId,
  sessionKey,
  ts: 1,
  toolCallId: 'history-video',
  name: 'tool_call',
  args: { id: 'video_generate', args: { durationSeconds: 5 } },
});
historyMetaRuns = applyWithDerivedProgress(historyMetaRuns, {
  type: 'tool.completed',
  runId: historyMetaRunId,
  sessionKey,
  ts: 2,
  toolCallId: 'history-video',
  name: 'tool_call',
  result: { summary: 'Background task started.' },
  meta: { async: true, status: 'started', taskId: 'history-video-task' },
});
const historyMetaAction = historyMetaRuns[historyMetaRunId]?.progressEntries?.find((entry) => entry.kind === 'action');
assert.equal(historyMetaAction?.translationKey, 'runtimeProgress.toolSubmitted');
assert.equal(historyMetaAction?.taskId, 'history-video-task');

const directoryRunId = 'run-directory-wrapper-dedupe';
const directoryParentCallId = 'call-directory-image';
const directoryNestedCallId = `tool_search_code:${directoryParentCallId}:image_generate:2`;
let directoryRuns: Record<string, ChatRuntimeRunState> = {};
for (const event of [{
  type: 'tool.started' as const,
  runId: directoryRunId,
  sessionKey,
  ts: 1,
  toolCallId: directoryParentCallId,
  name: 'tool_call',
  args: { id: 'image_generate', args: { prompt: '生成汽车图片' } },
}, {
  type: 'tool.started' as const,
  runId: directoryRunId,
  sessionKey,
  ts: 2,
  toolCallId: directoryNestedCallId,
  name: 'image_generate',
  args: { prompt: '生成汽车图片' },
}, {
  type: 'tool.completed' as const,
  runId: directoryRunId,
  sessionKey,
  ts: 3,
  toolCallId: directoryNestedCallId,
  name: 'image_generate',
  result: { details: { async: true, status: 'started', taskId: 'directory-image-task' } },
}, {
  type: 'tool.completed' as const,
  runId: directoryRunId,
  sessionKey,
  ts: 4,
  toolCallId: directoryParentCallId,
  name: 'tool_call',
  result: {
    tool: { name: 'image_generate', label: 'Image Generation' },
    result: { details: { async: true, status: 'started', taskId: 'directory-image-task' } },
  },
}]) {
  directoryRuns = applyWithDerivedProgress(directoryRuns, event);
}
const directoryActions = directoryRuns[directoryRunId]?.progressEntries?.filter((entry) => entry.kind === 'action') ?? [];
assert.equal(directoryActions.length, 1);
assert.equal(directoryActions[0]?.id, `progress:tool:${directoryParentCallId}`);
assert.equal(directoryActions[0]?.toolCallId, directoryParentCallId);
assert.equal(directoryActions[0]?.toolName, 'image_generate');
assert.equal(directoryActions[0]?.translationKey, 'runtimeProgress.toolSubmitted');

const independentRunId = 'run-independent-image-tools';
let independentRuns: Record<string, ChatRuntimeRunState> = {};
for (const [index, parentCallId] of ['call-image-one', 'call-image-two'].entries()) {
  const nestedCallId = `tool_search_code:${parentCallId}:image_generate:1`;
  for (const event of [{
    type: 'tool.started' as const,
    runId: independentRunId,
    sessionKey,
    ts: index * 10 + 1,
    toolCallId: parentCallId,
    name: 'tool_call',
    args: { id: 'image_generate', args: { prompt: `生成图片 ${index + 1}` } },
  }, {
    type: 'tool.started' as const,
    runId: independentRunId,
    sessionKey,
    ts: index * 10 + 2,
    toolCallId: nestedCallId,
    name: 'image_generate',
    args: { prompt: `生成图片 ${index + 1}` },
  }, {
    type: 'tool.completed' as const,
    runId: independentRunId,
    sessionKey,
    ts: index * 10 + 3,
    toolCallId: nestedCallId,
    name: 'image_generate',
    result: { details: { async: true, status: 'started', taskId: `image-task-${index + 1}` } },
  }, {
    type: 'tool.completed' as const,
    runId: independentRunId,
    sessionKey,
    ts: index * 10 + 4,
    toolCallId: parentCallId,
    name: 'tool_call',
    result: {
      tool: { name: 'image_generate', label: 'Image Generation' },
      result: { details: { async: true, status: 'started', taskId: `image-task-${index + 1}` } },
    },
  }]) {
    independentRuns = applyWithDerivedProgress(independentRuns, event);
  }
}
const independentActions = independentRuns[independentRunId]?.progressEntries?.filter((entry) => entry.kind === 'action') ?? [];
assert.equal(independentActions.length, 2);
assert.deepEqual(independentActions.map((entry) => entry.toolCallId), ['call-image-one', 'call-image-two']);

const codeModeRunId = 'run-code-mode-multiple-tools';
const codeModeParentCallId = 'call-code-mode';
let codeModeRuns: Record<string, ChatRuntimeRunState> = {};
codeModeRuns = applyWithDerivedProgress(codeModeRuns, {
  type: 'tool.started',
  runId: codeModeRunId,
  sessionKey,
  ts: 1,
  toolCallId: codeModeParentCallId,
  name: 'tool_search_code',
  args: { code: 'call image_generate twice' },
});
for (const sequence of [1, 2]) {
  const toolCallId = `tool_search_code:${codeModeParentCallId}:image_generate:${sequence}`;
  for (const event of [{
    type: 'tool.started' as const,
    runId: codeModeRunId,
    sessionKey,
    ts: sequence * 10,
    toolCallId,
    name: 'image_generate',
    args: { prompt: `代码模式图片 ${sequence}` },
  }, {
    type: 'tool.completed' as const,
    runId: codeModeRunId,
    sessionKey,
    ts: sequence * 10 + 1,
    toolCallId,
    name: 'image_generate',
    result: { details: { async: true, status: 'started', taskId: `code-image-task-${sequence}` } },
  }]) {
    codeModeRuns = applyWithDerivedProgress(codeModeRuns, event);
  }
}
const codeModeImageActions = codeModeRuns[codeModeRunId]?.progressEntries?.filter((entry) => (
  entry.kind === 'action' && entry.toolName === 'image_generate'
)) ?? [];
assert.equal(codeModeImageActions.length, 2);
assert.deepEqual(codeModeImageActions.map((entry) => entry.toolCallId), [
  `tool_search_code:${codeModeParentCallId}:image_generate:1`,
  `tool_search_code:${codeModeParentCallId}:image_generate:2`,
]);

const derivedFirstRunId = 'run-derived-first';
let derivedFirst: Record<string, ChatRuntimeRunState> = {};
derivedFirst = applyWithDerivedProgress(derivedFirst, {
  type: 'tool.started',
  runId: derivedFirstRunId,
  sessionKey,
  ts: 1,
  toolCallId: 'native-dedupe',
  name: 'web_search',
  args: { query: 'official docs' },
});
derivedFirst = applyWithDerivedProgress(derivedFirst, {
  type: 'progress.update',
  runId: derivedFirstRunId,
  sessionKey,
  ts: 2,
  entry: {
    id: 'native-progress-id',
    kind: 'action',
    text: '正在执行：Web Search',
    status: 'running',
    toolCallId: 'native-dedupe',
    toolName: 'web_search',
    source: 'native',
  },
});
const derivedFirstActions = derivedFirst[derivedFirstRunId]?.progressEntries?.filter((entry) => entry.kind === 'action') ?? [];
assert.equal(derivedFirstActions.length, 1);
assert.equal(derivedFirstActions[0]?.source, 'native');

const nativeFirstRunId = 'run-native-first';
let nativeFirst: Record<string, ChatRuntimeRunState> = {};
nativeFirst = applyWithDerivedProgress(nativeFirst, {
  type: 'progress.update',
  runId: nativeFirstRunId,
  sessionKey,
  ts: 1,
  entry: {
    id: 'native-first-action',
    kind: 'action',
    text: '正在执行：Web Search',
    status: 'running',
    toolCallId: 'native-first-call',
    toolName: 'web_search',
    source: 'native',
  },
});
nativeFirst = applyWithDerivedProgress(nativeFirst, {
  type: 'tool.started',
  runId: nativeFirstRunId,
  sessionKey,
  ts: 2,
  toolCallId: 'native-first-call',
  name: 'web_search',
  args: { query: 'official docs' },
});
assert.equal(nativeFirst[nativeFirstRunId]?.progressEntries?.filter((entry) => entry.kind === 'action').length, 1);
assert.equal(nativeFirst[nativeFirstRunId]?.progressEntries?.find((entry) => entry.kind === 'action')?.source, 'native');

const commentaryOnlyRunId = 'run-native-commentary-only';
let commentaryOnly: Record<string, ChatRuntimeRunState> = {};
commentaryOnly = applyWithDerivedProgress(commentaryOnly, {
  type: 'progress.update',
  runId: commentaryOnlyRunId,
  sessionKey,
  ts: 1,
  entry: {
    id: 'native-commentary',
    kind: 'commentary',
    text: '我先查看相关内容。',
    toolCallId: 'commentary-call',
    source: 'native',
  },
});
commentaryOnly = applyWithDerivedProgress(commentaryOnly, {
  type: 'tool.started',
  runId: commentaryOnlyRunId,
  sessionKey,
  ts: 2,
  toolCallId: 'commentary-call',
  name: 'read',
  args: { path: '/tmp/example.md' },
});
assert.equal(commentaryOnly[commentaryOnlyRunId]?.progressEntries?.filter((entry) => entry.kind === 'action').length, 1);

const cancelledRunId = 'run-cancelled-task-progress';
let cancelledRuns: Record<string, ChatRuntimeRunState> = {};
for (const event of [{
  type: 'tool.completed' as const,
  runId: cancelledRunId,
  sessionKey,
  ts: 1,
  toolCallId: 'cancelled-video',
  name: 'video_generate',
  result: { details: { async: true, status: 'started', taskId: 'cancelled-task' } },
}, {
  type: 'task.updated' as const,
  runId: cancelledRunId,
  sessionKey,
  ts: 2,
  task: {
    taskId: 'cancelled-task',
    title: 'Cancelled video',
    status: 'error' as const,
    sourceStatus: 'cancelled',
    terminalOutcome: 'aborted',
    updatedAt: 2,
    endedAt: 2,
  },
}]) {
  cancelledRuns = applyWithDerivedProgress(cancelledRuns, event);
}
const cancelledAction = cancelledRuns[cancelledRunId]?.progressEntries?.find((entry) => entry.kind === 'action');
assert.equal(cancelledAction?.translationKey, 'runtimeProgress.toolAborted');
assert.equal(cancelledAction?.status, 'aborted');

console.log('runtime progress semantic tests: ok');
