import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __test } from '../resources/openclaw-plugins/uclaw-artifact-guard/index.mjs';

const EXPECTED_ANALYSIS_KEYS = [
  'activeUserText',
  'artifacts',
  'currentRunFailedToolCount',
  'currentRunId',
  'currentRunSuccessfulArtifactCount',
  'currentRunToolAttemptCount',
  'emptyFinal',
  'finalText',
  'heartbeatOk',
  'heartbeatPoll',
  'passedArtifactCount',
  'shouldRevise',
  'shouldReviseArtifact',
  'shouldReviseEmptyFinal',
  'shouldReviseHeartbeat',
  'verificationBlocked',
  'verificationPassed',
].sort();

function finalizeEvent(runId, userText, finalText, cwd) {
  return {
    runId,
    cwd,
    userMessage: userText,
    finalText,
    messages: [
      { role: 'user', content: userText },
      { role: 'assistant', content: finalText },
    ],
  };
}

for (const [index, [userText, finalText]] of [
  ['先用三句话解释 RAG，不要调用工具。接着举一个电商搜索例子。最后改成一页发布会 PPT 文案，不要生成 PPT 文件。', 'RAG 会先检索资料，再结合资料生成答案。电商搜索可以用商品库召回。发布会文案：让每一次搜索都更懂用户。'],
  ['解释一下“打开、搜索、运行”三个词在工具系统里的区别。', '它们分别表示启动对象、查找信息和执行动作。'],
  ['只给方案，不要执行。', '我会先梳理输入，再给出分阶段方案。'],
  ['我接下来会生成文件。', '这是未来时说明，但没有任何实际产物引用。'],
  ['图片服务失败了，当前没有文件。', '真实失败：provider 返回 quota exceeded。'],
]) {
  const analysis = __test.analyzeArtifactFinal(finalizeEvent(`ordinary-final:${index}`, userText, finalText));
  assert.equal(analysis.artifacts.length, 0, userText);
  assert.equal(analysis.shouldRevise, false, userText);
  assert.deepEqual(Object.keys(analysis).sort(), EXPECTED_ANALYSIS_KEYS);
}

const emptyFinal = __test.analyzeArtifactFinal(finalizeEvent('empty-final', '给我一个结论', ''));
assert.equal(emptyFinal.shouldReviseEmptyFinal, true);
assert.match(__test.buildRevision(emptyFinal)?.retry?.idempotencyKey ?? '', /empty-final/u);

const heartbeatMismatch = __test.analyzeArtifactFinal(finalizeEvent(
  'heartbeat:mismatch',
  '[OpenClaw heartbeat poll]',
  '仍在处理。',
));
assert.equal(heartbeatMismatch.shouldReviseHeartbeat, true);
assert.match(__test.buildRevision(heartbeatMismatch)?.retry?.idempotencyKey ?? '', /heartbeat/u);
assert.equal(__test.analyzeArtifactFinal(finalizeEvent(
  'heartbeat:ok',
  '[OpenClaw heartbeat poll]',
  'HEARTBEAT_OK',
)).shouldRevise, false);

const unverifiedRemoteUrl = __test.analyzeArtifactFinal(finalizeEvent(
  'artifact:remote-url',
  '生成图片',
  '已生成：https://example.invalid/generated.png',
));
assert.equal(unverifiedRemoteUrl.artifacts.length, 0);
assert.equal(unverifiedRemoteUrl.shouldRevise, false);

assert.equal(__test.sanitizeInternalTranscriptMessage({
  role: 'user',
  content: 'Continue the OpenClaw runtime event.',
}).action, 'block');

const lifecycleHooks = new Map();
const runtimeEvents = [];
__test.registerArtifactGuard({
  registerHook(name, handler) {
    lifecycleHooks.set(name, handler);
  },
  emitAgentEvent(event) {
    runtimeEvents.push(event);
    return { emitted: true };
  },
});
const beforePromptBuild = lifecycleHooks.get('before_prompt_build');
assert.equal(typeof beforePromptBuild, 'function');
const ordinaryPromptContext = await beforePromptBuild({
  runId: 'prompt:ordinary',
  userMessage: '解释一下 PPT 是什么，不要生成文件。',
  messages: [{ role: 'user', content: '解释一下 PPT 是什么，不要生成文件。' }],
}, { runId: 'prompt:ordinary' });
assert.equal(ordinaryPromptContext, undefined);

const mediaDefaultsEvent = {
  runId: 'prompt:media',
  toolName: 'image_generate',
  params: { prompt: 'test' },
};
__test.cacheTurnPreferences(mediaDefaultsEvent, { runId: 'prompt:media' }, {
  mode: 'image',
  image: { model: 'gpt-image-2', size: '1024x1024', quality: 'high' },
});
const mediaDefaults = __test.applyTurnMediaDefaults(mediaDefaultsEvent, { runId: 'prompt:media' });
assert.deepEqual(mediaDefaults, {
  params: { prompt: 'test', model: 'gpt-image-2', size: '1024x1024', quality: 'high' },
  appliedKeys: ['model', 'size', 'quality'],
});

const beforeToolCall = lifecycleHooks.get('before_tool_call');
assert.equal(typeof beforeToolCall, 'function');
for (const toolName of ['image_generate', 'video_generate', 'create_designed_pptx_file', 'message']) {
  const result = await beforeToolCall({
    runId: `native-tool:${toolName}`,
    toolName,
    args: { prompt: 'test' },
  }, { runId: `native-tool:${toolName}` });
  assert.notEqual(result?.block, true, toolName);
}

__test.emitToolResultRuntimeEvents({
  emitAgentEvent(event) {
    runtimeEvents.push(event);
    return { emitted: true };
  },
}, {
  toolCallId: 'failed-tool',
  toolName: 'image_generate',
  isError: true,
  result: { details: { status: 'error', error: 'provider unavailable' } },
}, { runId: 'runtime:failure', sessionKey: 'agent:main:runtime-failure' });
assert.equal(runtimeEvents.some((event) => event.stream === 'checkpoint' || event.stream === 'issue'), false);
assert.equal(runtimeEvents.some((event) => event.stream === 'step'), true);
assert.equal(runtimeEvents.some((event) => event.stream === 'progress'), true);

const artifactDir = mkdtempSync(join(tmpdir(), 'uclaw-deterministic-artifact-'));
try {
  const validPath = join(artifactDir, 'valid.png');
  const emptyPath = join(artifactDir, 'empty.png');
  const directoryPath = join(artifactDir, 'directory.png');
  const missingPath = join(artifactDir, 'missing.png');
  const stagedSourcePath = join(artifactDir, 'source.png');
  writeFileSync(validPath, 'real artifact');
  writeFileSync(emptyPath, '');
  writeFileSync(stagedSourcePath, 'source image');
  mkdirSync(directoryPath);

  const valid = __test.analyzeArtifactFinal(finalizeEvent(
    'artifact:valid',
    '生成图片',
    `已生成。\nMEDIA:${validPath}`,
    artifactDir,
  ));
  assert.equal(valid.artifacts.length, 1);
  assert.equal(valid.verificationPassed, true);
  assert.equal(valid.verificationBlocked, false);
  assert.equal(valid.shouldRevise, false);
  assert.match(valid.artifacts[0]?.verification.detail ?? '', /可读、非空的普通文件/u);

  const beforeAgentFinalize = lifecycleHooks.get('before_agent_finalize');
  assert.equal(typeof beforeAgentFinalize, 'function');
  const eventCountBeforeFinalize = runtimeEvents.length;
  assert.equal(beforeAgentFinalize(finalizeEvent(
    'artifact:finalize-hook',
    '生成图片',
    `已生成。\nMEDIA:${validPath}`,
    artifactDir,
  ), { runId: 'artifact:finalize-hook' }), undefined);
  const finalizeStreams = runtimeEvents.slice(eventCountBeforeFinalize).map((event) => event.stream);
  assert.deepEqual(finalizeStreams, ['artifact', 'verification']);

  for (const [label, filePath, expectedDetail] of [
    ['missing', missingPath, /不可访问/u],
    ['empty', emptyPath, /为空/u],
    ['directory', directoryPath, /不是普通文件/u],
  ]) {
    const analysis = __test.analyzeArtifactFinal(finalizeEvent(
      `artifact:${label}`,
      '生成图片',
      `已生成。\nMEDIA:${filePath}`,
      artifactDir,
    ));
    assert.equal(analysis.artifacts.length, 1, label);
    assert.equal(analysis.verificationBlocked, true, label);
    assert.equal(analysis.shouldReviseArtifact, true, label);
    assert.equal(analysis.shouldRevise, true, label);
    assert.match(analysis.artifacts[0]?.verification.detail ?? '', expectedDetail, label);
    const revision = __test.buildRevision(analysis);
    assert.equal(revision?.action, 'revise', label);
    assert.match(revision?.reason ?? '', /deterministic availability verification/u, label);
  }

  const historyOnlyArtifact = finalizeEvent(
    'artifact:history-only',
    '生成图片',
    '图片服务失败，没有可交付文件。',
    artifactDir,
  );
  historyOnlyArtifact.messages.splice(1, 0, {
    role: 'toolResult',
    content: `中间路径 MEDIA:${missingPath}`,
  });
  const historyOnlyAnalysis = __test.analyzeArtifactFinal(historyOnlyArtifact);
  assert.equal(historyOnlyAnalysis.artifacts.length, 0);
  assert.equal(historyOnlyAnalysis.shouldRevise, false);

  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = join(artifactDir, 'openclaw-state');
  try {
    const staged = await __test.stageMediaToolInputs({
      runId: 'media:stage',
      toolName: 'image_generate',
      args: { image: stagedSourcePath, prompt: 'edit' },
    }, { runId: 'media:stage' });
    assert.equal(staged.stagedCount, 1);
    assert.notEqual(staged.params.image, stagedSourcePath);
    assert.equal(statSync(staged.params.image).size, statSync(stagedSourcePath).size);
    assert.match(staged.params.image, /openclaw-state\/media\/outbound\/uclaw-runs/u);

    const screenshotRewrite = __test.rewriteTmpScreenshotMediaPaths(
      'screencapture -x /tmp/uclaw-screen.png',
    );
    assert.equal(screenshotRewrite?.rewrittenPaths.length, 1);
    assert.match(screenshotRewrite?.command ?? '', /openclaw-state\/media\/outbound\/uclaw-screen\.png/u);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
} finally {
  rmSync(artifactDir, { recursive: true, force: true });
}

assert.equal(__test.nativeMediaPromptLengthBlock({
  toolName: 'image_generate',
  args: { prompt: 'a'.repeat(4_096) },
}), undefined);
assert.match(__test.nativeMediaPromptLengthBlock({
  toolName: 'video_generate',
  args: { prompt: 'a'.repeat(4_097) },
})?.reason ?? '', /4096-character limit/u);

console.log('uclaw deterministic artifact guard runtime tests: ok');
