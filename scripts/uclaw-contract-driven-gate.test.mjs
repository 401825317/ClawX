import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __test } from '../resources/openclaw-plugins/uclaw-artifact-guard/index.mjs';

function finalizeEvent(runId, userText, finalText) {
  return {
    runId,
    messages: [
      { role: 'user', content: userText },
      { role: 'assistant', content: finalText },
    ],
  };
}

function recordContract(runId, contract) {
  __test.recordToolEvidence({
    runId,
    toolCallId: `${runId}:contract`,
    toolName: 'uclaw_declare_turn_contract',
    args: contract,
    result: {
      details: {
        ok: true,
        contract,
      },
    },
  }, { runId });
}

const textOnlyRunId = 'contract-gate:text-only';
const textOnly = __test.analyzeArtifactFinal(
  finalizeEvent(
    textOnlyRunId,
    '把这个例子改成一页发布会 PPT 的文案，不要生成 PPT 文件。',
    '标题：搜索不再猜测。正文：RAG 让商品搜索引用实时知识。',
  ),
  { runId: textOnlyRunId },
);
assert.equal(textOnly.artifactRequest, false);
assert.equal(textOnly.shouldRevise, false);
assert.equal(textOnly.legacySemanticFallback, false);

const undeclaredArtifactRunId = 'contract-gate:undeclared-artifact';
const undeclaredArtifact = __test.analyzeArtifactFinal(
  finalizeEvent(
    undeclaredArtifactRunId,
    '帮我生成一份 8 页可编辑 PPTX，完成后直接交付。',
    '已完成。',
  ),
  { runId: undeclaredArtifactRunId },
);
assert.equal(undeclaredArtifact.artifactRequest, true);
assert.equal(undeclaredArtifact.shouldReviseArtifact, true);
assert.equal(undeclaredArtifact.requiredEffects[0]?.requiresToolEvidence, true);

for (const prompt of [
  '不用做成 PPT，只给我一页发布会文案。',
  '别做 PPT，直接给我结构和文案。',
  '先不要做PPT，讨论一下页面结构。',
]) {
  const runId = `contract-gate:negated:${prompt}`;
  const result = __test.analyzeArtifactFinal(
    finalizeEvent(runId, prompt, '这里是结构和文案建议。'),
    { runId },
  );
  assert.equal(result.artifactRequest, false, prompt);
  assert.equal(result.shouldReviseArtifact, false, prompt);
}

const unfinishedContinuationRunId = 'contract-gate:unfinished-artifact-continuation';
const unfinishedContinuation = __test.analyzeArtifactFinal({
  runId: unfinishedContinuationRunId,
  messages: [
    { role: 'user', content: '做一条 60 秒汽车宣传片。' },
    {
      role: 'assistant',
      content: '当前只生成了 12 秒短版。\nMEDIA:/tmp/uclaw-short-video.mp4',
    },
    { role: 'user', content: '我要60秒啊' },
    {
      role: 'assistant',
      content: '你说得对，12 秒不能算完成。我会把现有样片重新剪辑成准确 60 秒的版本，并补齐旁白；最终会核验实际时长后再交付。',
    },
  ],
}, { runId: unfinishedContinuationRunId });
assert.equal(unfinishedContinuation.artifactContinuationPromise, true);
assert.equal(unfinishedContinuation.artifactRequest, true);
assert.equal(unfinishedContinuation.artifactRevisionRequest, true);
assert.equal(unfinishedContinuation.requiredEffects[0]?.kind, 'video');
assert.equal(unfinishedContinuation.requiredEffects[0]?.requiresToolEvidence, true);
assert.equal(unfinishedContinuation.shouldReviseArtifact, true);
assert.match(__test.buildRevision(unfinishedContinuation).reason, /revision final reply/iu);

const explanationOnlyContinuationRunId = 'contract-gate:artifact-explanation-only';
const explanationOnlyContinuation = __test.analyzeArtifactFinal({
  runId: explanationOnlyContinuationRunId,
  messages: [
    { role: 'assistant', content: 'MEDIA:/tmp/uclaw-short-video.mp4' },
    { role: 'user', content: '只解释为什么只有 12 秒，不要继续修改视频。' },
    { role: 'assistant', content: '服务端单次生成时长上限是 12 秒，所以这次返回了短版。' },
  ],
}, { runId: explanationOnlyContinuationRunId });
assert.equal(explanationOnlyContinuation.artifactContinuationPromise, false);
assert.equal(explanationOnlyContinuation.artifactRequest, false);
assert.equal(explanationOnlyContinuation.shouldReviseArtifact, false);

const promiseWithoutPriorArtifactRunId = 'contract-gate:promise-without-prior-artifact';
const promiseWithoutPriorArtifact = __test.analyzeArtifactFinal(
  finalizeEvent(
    promiseWithoutPriorArtifactRunId,
    '继续。',
    '当前版本不能算完成，我会重新制作并验证后交付。',
  ),
  { runId: promiseWithoutPriorArtifactRunId },
);
assert.equal(promiseWithoutPriorArtifact.artifactContinuationPromise, false);
assert.equal(promiseWithoutPriorArtifact.artifactRequest, false);
assert.equal(promiseWithoutPriorArtifact.shouldReviseArtifact, false);

const artifactRunId = 'contract-gate:artifact';
__test.recordToolEvidence({
  runId: artifactRunId,
  toolCallId: 'contract-call-1',
  toolName: 'uclaw_declare_turn_contract',
  args: {
    intent: 'artifact',
    toolRequirement: 'required',
    sideEffect: 'local_artifact',
    sideEffectAuthorized: true,
    capabilityRefs: ['create_designed_pptx_file'],
    acceptance: {
      requiresArtifact: true,
      requiresVerification: true,
      requiresToolEvidence: true,
    },
  },
  result: {
    details: {
      ok: true,
      contract: {
        intent: 'artifact',
        toolRequirement: 'required',
        sideEffect: 'local_artifact',
        sideEffectAuthorized: true,
        capabilityRefs: ['create_designed_pptx_file'],
        acceptance: {
          requiresArtifact: true,
          requiresVerification: true,
          requiresToolEvidence: true,
        },
      },
    },
  },
}, { runId: artifactRunId });

const artifact = __test.analyzeArtifactFinal(
  finalizeEvent(artifactRunId, '做一份产品发布会演示文稿。', '我接下来会开始制作。'),
  { runId: artifactRunId },
);
assert.equal(artifact.artifactRequest, true);
assert.equal(artifact.declaredContract?.intent, 'artifact');
assert.equal(artifact.requiredArtifactCount, 1);
assert.equal(artifact.shouldReviseArtifact, true);
assert.equal(artifact.requiredEffects[0]?.requiresToolEvidence, true);

const noVerificationContract = {
  intent: 'media',
  toolRequirement: 'optional',
  sideEffect: 'remote_generation',
  sideEffectAuthorized: true,
  capabilityRefs: ['image_generate'],
  acceptance: {
    requiresArtifact: true,
    requiresVerification: false,
    requiresApproval: false,
    requiresToolEvidence: false,
  },
};
const noVerificationEffects = __test.deriveRequiredEffects({
  activeUserText: '生成一张图片。',
  artifactRequest: true,
  artifactRevisionRequest: false,
  priorArtifacts: [],
  desktopActionRequest: false,
  compositeRequiredArtifactCount: 0,
  declaredContract: noVerificationContract,
  runToolEvidence: { attempts: [] },
  requireCurrentRunToolEvidence: true,
});
assert.equal(noVerificationEffects[0]?.requiresVerification, false);
assert.equal(noVerificationEffects[0]?.requiresToolEvidence, false);
assert.equal(noVerificationEffects[0]?.allowImplicitMediaToolEvidence, false);
const artifactDir = mkdtempSync(join(tmpdir(), 'uclaw-contract-artifact-'));
try {
  const artifactPath = join(artifactDir, 'image.png');
  writeFileSync(artifactPath, 'real artifact');
  const priorImagePath = join(artifactDir, 'prior-image.png');
  writeFileSync(priorImagePath, 'prior image artifact');

  const nativeCompletionRunId = 'image_generate:native-completion:ok';
  const nativeCompletion = __test.analyzeArtifactFinal({
    runId: nativeCompletionRunId,
    prompt: '[Inter-session message] This content was routed from an async completion event. Deliver the generated media.',
    finalText: `图片已完成。\nMEDIA:${artifactPath}`,
    messages: [
      { role: 'assistant', content: `上一张图片。\nMEDIA:${priorImagePath}` },
      { role: 'user', content: '修改上一张图片，保持构图不变。' },
      { role: 'assistant', content: `图片已完成。\nMEDIA:${artifactPath}` },
    ],
  }, { runId: nativeCompletionRunId });
  assert.equal(nativeCompletion.completionArtifactKind, 'image');
  assert.equal(nativeCompletion.priorArtifactEvidence, true);
  assert.equal(nativeCompletion.requiredEffects[0]?.kind, 'image');
  assert.equal(nativeCompletion.artifacts[0]?.successfulToolResult, true);
  assert.equal(nativeCompletion.missingRequiredArtifactCount, 0);
  assert.equal(nativeCompletion.shouldRevise, false);

  const videoPath = join(artifactDir, 'video.mp4');
  writeFileSync(videoPath, 'real video artifact');
  const nativeVideoCompletionRunId = 'video_generate:native-video-completion:ok';
  const nativeVideoCompletion = __test.analyzeArtifactFinal({
    runId: nativeVideoCompletionRunId,
    prompt: '[Inter-session message] This content contains an image reference and a presentation summary.',
    finalText: `视频已完成。\nMEDIA:${videoPath}`,
  }, { runId: nativeVideoCompletionRunId });
  assert.equal(nativeVideoCompletion.completionArtifactKind, 'video');
  assert.equal(nativeVideoCompletion.requiredEffects[0]?.kind, 'video');
  assert.equal(nativeVideoCompletion.missingRequiredArtifactCount, 0);
  assert.equal(nativeVideoCompletion.shouldRevise, false);

  const mismatchedCompletionRunId = 'image_generate:mismatched-completion:ok';
  const mismatchedCompletion = __test.analyzeArtifactFinal({
    runId: mismatchedCompletionRunId,
    prompt: '[Inter-session message] This content was routed from an async completion event.',
    finalText: `任务已完成。\nMEDIA:${videoPath}`,
  }, { runId: mismatchedCompletionRunId });
  assert.equal(mismatchedCompletion.completionArtifactKind, 'image');
  assert.equal(mismatchedCompletion.missingRequiredArtifactCount, 1);
  assert.equal(mismatchedCompletion.shouldRevise, true);

  const localArtifact = __test.buildArtifactEvidence({}, `MEDIA:${artifactPath}`)[0];
  const noVerificationResults = __test.evaluateRequiredEffects(noVerificationEffects, {
    artifacts: [{ ...localArtifact, successfulToolResult: false }],
    desktopActionEvidence: false,
    runToolEvidence: { attempts: [] },
    enforceCurrentRunToolEvidence: true,
  });
  assert.equal(noVerificationResults[0]?.satisfied, true);

  const fakeRemoteArtifact = __test.buildArtifactEvidence({}, 'https://does-not-exist.invalid/image.png')[0];
  const fakeRemoteResults = __test.evaluateRequiredEffects(noVerificationEffects, {
    artifacts: [{ ...fakeRemoteArtifact, successfulToolResult: false }],
    desktopActionEvidence: false,
    runToolEvidence: { attempts: [] },
    enforceCurrentRunToolEvidence: true,
  });
  assert.equal(fakeRemoteResults[0]?.satisfied, false);

  assert.deepEqual(__test.buildToolArtifactEvidence({
    toolName: 'tool_call',
    args: {
      id: 'openclaw:plugin:image_generate',
      args: { image: artifactPath, prompt: 'edit the source image' },
    },
    result: { content: [{ type: 'text', text: 'done' }] },
  }), []);
} finally {
  rmSync(artifactDir, { recursive: true, force: true });
}

const approvalArtifactRunId = 'contract-gate:approval-artifact';
recordContract(approvalArtifactRunId, {
  ...noVerificationContract,
  intent: 'artifact',
  sideEffect: 'local_artifact',
  capabilityRefs: ['create_document'],
  acceptance: {
    ...noVerificationContract.acceptance,
    requiresApproval: true,
  },
});
const approvalArtifact = __test.analyzeArtifactFinal(
  finalizeEvent(approvalArtifactRunId, '先审批，再创建本地文档。', '尚未创建。'),
  { runId: approvalArtifactRunId },
);
assert.equal(approvalArtifact.approvalRequired, true);
assert.equal(approvalArtifact.desktopActionRequest, false);
assert.equal(approvalArtifact.requiredEffects.some((effect) => effect.type === 'external_action'), false);

const unauthorizedRunId = 'contract-gate:unauthorized-media';
recordContract(unauthorizedRunId, {
  ...noVerificationContract,
  sideEffectAuthorized: false,
});
const unauthorized = __test.analyzeArtifactFinal(
  finalizeEvent(unauthorizedRunId, '先不要生成，等我确认。', '已经生成完成。'),
  { runId: unauthorizedRunId },
);
assert.equal(unauthorized.authorizationMissing, true);
assert.equal(unauthorized.shouldReviseAuthorization, true);
assert.match(__test.buildRevision(unauthorized).retry.idempotencyKey, /side-effect-authorization/u);
assert.equal(
  __test.unauthorizedSideEffectBlock({ toolName: 'uclaw_get_runtime_capabilities' }, { runId: unauthorizedRunId }),
  undefined,
);
assert.match(
  __test.unauthorizedSideEffectBlock({ toolName: 'image_generate' }, { runId: unauthorizedRunId })?.reason ?? '',
  /authorization is required/iu,
);
assert.equal(
  __test.unauthorizedSideEffectBlock({
    toolName: 'tool_call',
    args: { id: 'openclaw:plugin:image_generate', args: { action: 'list' } },
  }, { runId: unauthorizedRunId }),
  undefined,
);
for (const event of [
  { toolName: 'get_upload_status', args: { uploadId: 'upload-1' } },
  { toolName: 'publish_post', args: { action: 'status', postId: 'post-1' } },
  {
    toolName: 'tool_call',
    args: { id: 'openclaw:plugin:music_generate', args: { action: 'list' } },
  },
]) {
  assert.equal(__test.unauthorizedSideEffectBlock(event, { runId: unauthorizedRunId }), undefined);
}

const undeclaredSideEffectRunId = 'contract-gate:undeclared-side-effect-tool';
assert.match(
  __test.undeclaredSideEffectBlock({ toolName: 'image_generate', args: { prompt: 'car' } }, { runId: undeclaredSideEffectRunId })?.reason ?? '',
  /declare the uclaw turn contract/iu,
);
assert.equal(
  __test.undeclaredSideEffectBlock({ toolName: 'web_search', args: { query: 'car' } }, { runId: undeclaredSideEffectRunId }),
  undefined,
);
assert.equal(
  __test.undeclaredSideEffectBlock({ toolName: 'image', args: { image: '/tmp/input.png' } }, { runId: undeclaredSideEffectRunId }),
  undefined,
);
assert.equal(
  __test.undeclaredSideEffectBlock({ toolName: 'pdf', args: { path: '/tmp/input.pdf' } }, { runId: undeclaredSideEffectRunId }),
  undefined,
);
assert.match(
  __test.undeclaredSideEffectBlock({ toolName: 'create_pdf', args: { path: '/tmp/output.pdf' } }, { runId: undeclaredSideEffectRunId })?.reason ?? '',
  /declare the uclaw turn contract/iu,
);
assert.equal(
  __test.undeclaredSideEffectBlock({
    toolName: 'uclaw_start_host_task',
    args: { kind: 'desktop.observe', title: 'Observe desktop' },
  }, { runId: undeclaredSideEffectRunId }),
  undefined,
);
assert.equal(
  __test.undeclaredSideEffectBlock({
    toolName: 'tool_call',
    args: { id: 'openclaw:plugin:image_generate', args: { action: 'status' } },
  }, { runId: undeclaredSideEffectRunId }),
  undefined,
);

for (const event of [
  { toolName: 'music_generate', args: { prompt: 'cinematic score' } },
  {
    toolName: 'tool_call',
    args: { id: 'openclaw:plugin:generate_audio', args: { prompt: 'ambient soundscape' } },
  },
]) {
  assert.equal(__test.knownToolSideEffect(event), 'remote_generation');
  assert.match(
    __test.undeclaredSideEffectBlock(event, { runId: undeclaredSideEffectRunId })?.reason ?? '',
    /declare the uclaw turn contract/iu,
  );
}

for (const event of [
  { toolName: 'send_message', args: { recipient: 'user-1' } },
  { toolName: 'publish_post', args: { postId: 'post-1' } },
  { toolName: 'upload_file', args: { path: '/tmp/report.pdf' } },
  { toolName: 'delete_file', args: { path: '/tmp/report.pdf' } },
  {
    toolName: 'tool_call',
    args: { id: 'openclaw:plugin:remove_member', args: { memberId: 'member-1' } },
  },
]) {
  assert.equal(__test.knownToolSideEffect(event), 'external_action');
}

for (const event of [
  { toolName: 'read_file', args: { path: '/tmp/report.pdf' } },
  { toolName: 'get_upload_status', args: { uploadId: 'upload-1' } },
  { toolName: 'publish_post', args: { action: 'status', postId: 'post-1' } },
  {
    toolName: 'tool_call',
    args: { id: 'openclaw:plugin:music_generate', args: { action: 'list' } },
  },
]) {
  assert.equal(__test.knownToolSideEffect(event), undefined);
  assert.equal(__test.undeclaredSideEffectBlock(event, { runId: undeclaredSideEffectRunId }), undefined);
}

for (const event of [
  { toolName: 'get_and_delete', args: { id: 'record-1' } },
  { toolName: 'status_then_upload', args: { path: '/tmp/output.bin' } },
]) {
  assert.equal(__test.knownToolSideEffect(event), 'external_action');
  assert.match(
    __test.undeclaredSideEffectBlock(event, { runId: undeclaredSideEffectRunId })?.reason ?? '',
    /Declare the UClaw turn contract/iu,
  );
}

assert.equal(__test.nativeMediaPromptLengthBlock({
  toolName: 'video_generate',
  args: { prompt: 'a'.repeat(4_096) },
}), undefined);
assert.equal(__test.nativeMediaPromptLengthBlock({
  toolName: 'image_generate',
  args: { prompt: 'a'.repeat(4_097) },
})?.characterCount, 4_097);
assert.equal(__test.nativeMediaPromptLengthBlock({
  toolName: 'tool_call',
  args: { id: 'openclaw:plugin:video_generate', args: { prompt: '图'.repeat(4_097) } },
})?.characterCount, 4_097);

const noneContractRunId = 'contract-gate:none-contract-cannot-generate';
recordContract(noneContractRunId, {
  intent: 'chat',
  toolRequirement: 'optional',
  sideEffect: 'none',
  sideEffectAuthorized: true,
  capabilityRefs: [],
  acceptance: {
    requiresArtifact: false,
    requiresVerification: false,
    requiresApproval: false,
    requiresToolEvidence: false,
  },
});
assert.match(
  __test.contractSideEffectMismatchBlock({ toolName: 'image_generate' }, { runId: noneContractRunId })?.reason ?? '',
  /declares none/iu,
);
assert.equal(
  __test.contractSideEffectMismatchBlock({
    toolName: 'uclaw_start_host_task',
    args: { kind: 'desktop.observe', title: 'Observe desktop' },
  }, { runId: noneContractRunId }),
  undefined,
);

const localContractRunId = 'contract-gate:local-contract-scope';
recordContract(localContractRunId, {
  intent: 'artifact',
  toolRequirement: 'required',
  sideEffect: 'local_artifact',
  sideEffectAuthorized: true,
  capabilityRefs: ['create_document'],
  acceptance: {
    requiresArtifact: true,
    requiresVerification: true,
    requiresApproval: false,
    requiresToolEvidence: true,
  },
});
assert.match(
  __test.contractSideEffectMismatchBlock({ toolName: 'video_generate' }, { runId: localContractRunId })?.reason ?? '',
  /remote_generation/iu,
);
assert.match(
  __test.contractSideEffectMismatchBlock({ toolName: 'message', args: { action: 'send' } }, { runId: localContractRunId })?.reason ?? '',
  /external_action/iu,
);
assert.equal(
  __test.contractSideEffectMismatchBlock({ toolName: 'create_document' }, { runId: localContractRunId }),
  undefined,
);
assert.match(
  __test.contractSideEffectMismatchBlock({ toolName: 'music_generate' }, { runId: localContractRunId })?.reason ?? '',
  /remote_generation/iu,
);
assert.match(
  __test.contractSideEffectMismatchBlock({ toolName: 'upload_file' }, { runId: localContractRunId })?.reason ?? '',
  /external_action/iu,
);

const externalContractRunId = 'contract-gate:external-contract-scope';
recordContract(externalContractRunId, {
  intent: 'action',
  toolRequirement: 'required',
  sideEffect: 'external_action',
  sideEffectAuthorized: true,
  capabilityRefs: ['send_message'],
  acceptance: {
    requiresArtifact: false,
    requiresVerification: true,
    requiresApproval: false,
    requiresToolEvidence: true,
  },
});
assert.equal(
  __test.contractSideEffectMismatchBlock({ toolName: 'send_message' }, { runId: externalContractRunId }),
  undefined,
);
assert.match(
  __test.contractSideEffectMismatchBlock({ toolName: 'music_generate' }, { runId: externalContractRunId })?.reason ?? '',
  /remote_generation/iu,
);

const wrapperContractRunId = 'contract-gate:wrapper-contract';
const wrapperContract = {
  ...noVerificationContract,
  sideEffectAuthorized: false,
};
__test.recordToolEvidence({
  runId: wrapperContractRunId,
  toolCallId: 'wrapper-contract-call',
  toolName: 'tool_call',
  args: { id: 'openclaw:plugin:uclaw_declare_turn_contract', args: wrapperContract },
  result: {
    details: {
      tool: { name: 'uclaw_declare_turn_contract' },
      result: {
        details: { ok: true, contract: wrapperContract },
        isError: false,
      },
    },
  },
}, { runId: wrapperContractRunId });
assert.equal(__test.getToolEvidenceForRun(wrapperContractRunId).contract?.sideEffect, 'remote_generation');

const failedWrapperContractRunId = 'contract-gate:wrapper-contract-failed';
__test.recordToolEvidence({
  runId: failedWrapperContractRunId,
  toolCallId: 'wrapper-contract-failed-call',
  toolName: 'tool_call',
  args: { id: 'openclaw:plugin:uclaw_declare_turn_contract', args: wrapperContract },
  result: {
    details: {
      tool: { name: 'uclaw_declare_turn_contract' },
      result: {
        details: { ok: false, code: 'runtime_correlation_missing' },
        isError: true,
      },
    },
  },
}, { runId: failedWrapperContractRunId });
assert.equal(__test.getToolEvidenceForRun(failedWrapperContractRunId).contract, undefined);
assert.equal(
  __test.undeclaredSideEffectBlock({
    toolName: 'tool_call',
    args: { id: 'openclaw:plugin:uclaw_declare_turn_contract', args: wrapperContract },
  }, { runId: 'contract-gate:wrapper-contract-declare' }),
  undefined,
);

console.log('uclaw contract-driven gate tests passed');
