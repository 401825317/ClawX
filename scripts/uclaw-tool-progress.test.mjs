import assert from 'node:assert/strict';
import { __test } from '../resources/openclaw-plugins/uclaw-artifact-guard/index.mjs';

const emitted = [];
const api = {
  emitAgentEvent(event) {
    emitted.push(event);
    return { emitted: true };
  },
};
const ctx = {
  runId: 'run-native-progress',
  sessionKey: 'agent:main:test-native-progress',
};

function progressEntries() {
  return emitted.filter((event) => event.stream === 'progress').map((event) => event.data.entry);
}

__test.emitToolCallProgress(api, {
  toolCallId: 'describe-video',
  toolName: 'tool_describe',
  params: { id: 'video_generate' },
}, ctx);
__test.emitToolResultProgress(api, {
  toolCallId: 'describe-video',
  toolName: 'tool_describe',
  params: { id: 'video_generate' },
  result: { name: 'video_generate', label: 'Video Generation' },
}, ctx);

assert.equal(progressEntries().length, 0);

__test.emitToolCallProgress(api, {
  toolCallId: 'update-plan',
  toolName: 'update_plan',
  params: { plan: [{ step: 'Build the app', status: 'in_progress' }] },
}, ctx);
__test.emitToolResultProgress(api, {
  toolCallId: 'update-plan',
  toolName: 'update_plan',
  result: { message: 'Plan updated' },
}, ctx);

assert.equal(progressEntries().length, 0);

__test.emitToolCallProgress(api, {
  toolCallId: 'search-official-data',
  toolName: 'tool_call',
  params: {
    id: 'web_search',
    args: { query: '小米 SU7 Ultra 官方性能参数', count: 5 },
  },
}, ctx);
__test.emitToolResultProgress(api, {
  toolCallId: 'search-official-data',
  toolName: 'tool_call',
  params: {
    id: 'web_search',
    args: { query: '小米 SU7 Ultra 官方性能参数', count: 5 },
  },
  result: {
    tool: { name: 'web_search', label: 'Web Search' },
    result: { details: { count: 5 } },
  },
}, ctx);

const longPrompt = '电影级汽车宣传片'.repeat(300);
__test.emitToolCallProgress(api, {
  toolCallId: 'generate-video',
  toolName: 'tool_call',
  params: {
    id: 'video_generate',
    args: {
      action: 'generate',
      prompt: longPrompt,
      durationSeconds: 60,
      size: '1920x1080',
      aspectRatio: '16:9',
      audio: true,
    },
  },
}, ctx);
__test.emitToolResultProgress(api, {
  toolCallId: 'generate-video',
  toolName: 'tool_call',
  params: {
    id: 'video_generate',
    args: {
      action: 'generate',
      prompt: longPrompt,
      durationSeconds: 60,
      size: '1920x1080',
      aspectRatio: '16:9',
      audio: true,
    },
  },
  result: {
    tool: { name: 'video_generate', label: 'Video Generation' },
    result: {
      details: {
        async: true,
        status: 'started',
        taskId: 'video-task-native-1',
        durationSeconds: 60,
        size: '1920x1080',
        aspectRatio: '16:9',
        audio: true,
      },
    },
  },
}, ctx);

const directoryImageParentId = 'call-directory-image';
for (const toolCallId of [
  directoryImageParentId,
  `tool_search_code:${directoryImageParentId}:image_generate:2`,
]) {
  __test.emitToolCallProgress(api, {
    toolCallId,
    toolName: toolCallId === directoryImageParentId ? 'tool_call' : 'image_generate',
    params: {
      id: 'image_generate',
      args: { prompt: '生成一张汽车图片', size: '1536x1024' },
    },
  }, ctx);
  __test.emitToolResultProgress(api, {
    toolCallId,
    toolName: toolCallId === directoryImageParentId ? 'tool_call' : 'image_generate',
    params: { id: 'image_generate' },
    result: {
      tool: { name: 'image_generate', label: 'Image Generation' },
      result: { details: { async: true, status: 'started', taskId: 'image-task-native-1' } },
    },
  }, ctx);
}

const sanitizedDirectoryImageParentId = 'call-directory-image|fc_4f13f53d';
const sanitizedDirectoryImageNestedId = `tool_search_code:${sanitizedDirectoryImageParentId.replaceAll('|', '_')}:image_generate:2`;
for (const toolCallId of [sanitizedDirectoryImageParentId, sanitizedDirectoryImageNestedId]) {
  __test.emitToolCallProgress(api, {
    toolCallId,
    toolName: toolCallId === sanitizedDirectoryImageParentId ? 'tool_call' : 'image_generate',
    params: {
      id: 'image_generate',
      args: { prompt: '生成一张餐饮宣传图', size: '1536x1024' },
    },
  }, ctx);
  __test.emitToolResultProgress(api, {
    toolCallId,
    toolName: toolCallId === sanitizedDirectoryImageParentId ? 'tool_call' : 'image_generate',
    params: { id: 'image_generate' },
    result: {
      tool: { name: 'image_generate', label: 'Image Generation' },
      result: { details: { async: true, status: 'started', taskId: 'image-task-native-sanitized' } },
    },
  }, ctx);
}

const codeModeParentId = 'call-code-mode';
__test.emitToolCallProgress(api, {
  toolCallId: codeModeParentId,
  toolName: 'tool_search_code',
  params: { code: 'call image_generate twice' },
}, ctx);
for (const sequence of [1, 2]) {
  const toolCallId = `tool_search_code:${codeModeParentId}:image_generate:${sequence}`;
  __test.emitToolCallProgress(api, {
    toolCallId,
    toolName: 'image_generate',
    params: { prompt: `代码模式图片 ${sequence}` },
  }, ctx);
  __test.emitToolResultProgress(api, {
    toolCallId,
    toolName: 'image_generate',
    params: { prompt: `代码模式图片 ${sequence}` },
    result: { details: { async: true, status: 'started', taskId: `code-image-task-${sequence}` } },
  }, ctx);
}

__test.emitToolCallProgress(api, {
  toolCallId: 'secret-command',
  toolName: 'exec',
  params: {
    command: 'curl -H "Authorization: Bearer sk-proj-secret12345" "https://host/file?X-Amz-Signature=signed-secret"',
  },
}, ctx);
__test.emitToolResultProgress(api, {
  toolCallId: 'secret-command',
  toolName: 'exec',
  params: { command: 'echo done' },
  isError: true,
  result: {
    details: {
      status: 'error',
      error: '{"api_key":"sk-proj-errorsecret","cookie":"sid=private-cookie"}',
    },
  },
}, ctx);

const entries = progressEntries();
const completedSearch = entries.filter((entry) => entry.toolName === 'web_search').at(-1);
const submittedVideo = entries.filter((entry) => entry.toolName === 'video_generate').at(-1);
assert.equal(completedSearch?.translationKey, 'runtimeProgress.toolCompleted');
assert.equal(completedSearch?.status, 'completed');
assert.match(completedSearch?.command ?? '', /SU7 Ultra/u);
assert.equal(submittedVideo?.translationKey, 'runtimeProgress.toolSubmitted');
assert.equal(submittedVideo?.status, 'running');
assert.equal(submittedVideo?.taskId, 'video-task-native-1');
assert.match(submittedVideo?.command ?? '', /60s/u);
assert.doesNotMatch(submittedVideo?.command ?? '', /电影级汽车宣传片/u);
const directoryImageEntries = entries.filter((entry) => (
  entry.toolName === 'image_generate' && entry.taskId === 'image-task-native-1'
));
assert.equal(new Set(directoryImageEntries.map((entry) => entry.id)).size, 1);
assert.equal(directoryImageEntries.every((entry) => entry.toolCallId === directoryImageParentId), true);
const sanitizedDirectoryImageEntries = entries.filter((entry) => (
  entry.toolName === 'image_generate' && entry.taskId === 'image-task-native-sanitized'
));
assert.equal(new Set(sanitizedDirectoryImageEntries.map((entry) => entry.id)).size, 1);
assert.equal(sanitizedDirectoryImageEntries.every((entry) => entry.toolCallId === sanitizedDirectoryImageParentId), true);
const codeModeEntries = entries.filter((entry) => entry.taskId?.startsWith('code-image-task-'));
assert.equal(new Set(codeModeEntries.map((entry) => entry.id)).size, 2);
assert.deepEqual(codeModeEntries.map((entry) => entry.toolCallId), [
  `tool_search_code:${codeModeParentId}:image_generate:1`,
  `tool_search_code:${codeModeParentId}:image_generate:2`,
]);
assert.equal(entries.some((entry) => entry.text === '已运行' || entry.text === '正在执行'), false);
const secretEntries = entries.filter((entry) => entry.toolCallId === 'secret-command');
const secretDisplay = JSON.stringify(secretEntries);
assert.doesNotMatch(secretDisplay, /sk-proj-secret12345|signed-secret|sk-proj-errorsecret|private-cookie/u);
assert.match(secretDisplay, /\[REDACTED\]/u);

console.log('uclaw native tool progress tests: ok');
