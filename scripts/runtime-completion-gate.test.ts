import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRuntimeCompletionGateEvents,
  buildRuntimeCompletionGateReport,
} from '../src/stores/chat/runtime-contract.ts';
import type { ChatRuntimeRunState } from '../src/stores/chat/types.ts';

function artifactRunWithToolAttempts(attempts: Array<{ id: string; isError: boolean; name?: string }>): ChatRuntimeRunState {
  const runId = 'run-ppt-retry';
  const sessionKey = 'agent:main:main';
  return {
    runId,
    sessionKey,
    status: 'completed',
    objective: '帮我做一个 PPT',
    assistantText: 'PPT 已生成。',
    thinkingText: '',
    artifacts: [{
      id: 'artifact-ppt',
      kind: 'presentation',
      title: 'demo.pptx',
      filePath: '/tmp/demo.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }],
    verifications: [{
      id: 'verification-ppt',
      artifactId: 'artifact-ppt',
      status: 'passed',
      required: true,
      kind: 'artifact.content',
    }],
    events: attempts.map((attempt, index) => ({
      contractVersion: 1,
      producer: 'history' as const,
      runId,
      sessionKey,
      ts: index + 1,
      type: 'tool.completed' as const,
      toolCallId: attempt.id,
      name: attempt.name ?? 'create_designed_pptx_file',
      isError: attempt.isError,
      result: attempt.isError ? { error: 'slide overlap' } : { ok: true },
    })),
  };
}

test('a later successful retry resolves the earlier tool failure', () => {
  const report = buildRuntimeCompletionGateReport(artifactRunWithToolAttempts([
    { id: 'ppt-attempt-1', isError: true },
    { id: 'ppt-attempt-2', isError: false },
  ]));

  assert.equal(report.hasBlockingIssues, false);
  assert.equal(report.failedStepCount, 0);
  assert.equal(report.passedRequiredVerificationCount, 1);
  assert.equal(report.issues.some((issue) => issue.code === 'tool.failed'), false);
});

test('a successful incremental PPT repair resolves the blocked create attempt', () => {
  const report = buildRuntimeCompletionGateReport(artifactRunWithToolAttempts([
    { id: 'ppt-create', name: 'create_designed_pptx_file', isError: true },
    { id: 'ppt-repair', name: 'repair_designed_pptx_file', isError: false },
  ]));

  assert.equal(report.hasBlockingIssues, false);
  assert.equal(report.failedStepCount, 0);
  assert.equal(report.issues.some((issue) => issue.code === 'tool.failed'), false);
});

test('a text-only request that mentions search and PPT copy does not require a tool attempt', () => {
  const run: ChatRuntimeRunState = {
    runId: 'run-rag-copy',
    sessionKey: 'agent:main:main',
    status: 'completed',
    objective: '先用三句话解释 RAG，不要调用工具。接着举一个电商搜索的例子，最后改成一页发布会 PPT 的文案，不要生成 PPT 文件。',
    assistantText: 'RAG 是检索增强生成。',
    thinkingText: '',
    artifacts: [],
    verifications: [],
    events: [],
  };

  const report = buildRuntimeCompletionGateReport(run);
  assert.equal(report.hasBlockingIssues, false);
  assert.equal(report.issues.some((issue) => issue.code === 'execution.unattempted'), false);

  const gateEvent = buildRuntimeCompletionGateEvents(run, {
    runId: run.runId,
    sessionKey: run.sessionKey,
    status: 'completed',
  }).find((event) => event.type === 'gate.evaluated');
  assert.ok(gateEvent && gateEvent.type === 'gate.evaluated');
  assert.equal(gateEvent.gate.decision, 'deliverable');
});

test('text-only explanations may mention search, open, and run without being held for a tool', () => {
  const run: ChatRuntimeRunState = {
    runId: 'run-text-only-action-words',
    sessionKey: 'agent:main:main',
    status: 'completed',
    objective: '解释用户如何打开 App、运行搜索和发送消息，不要实际操作。',
    assistantText: '先打开 App，再运行搜索即可。',
    thinkingText: '',
    artifacts: [],
    verifications: [],
    events: [],
  };

  const report = buildRuntimeCompletionGateReport(run);
  assert.equal(report.hasBlockingIssues, false);
  assert.equal(report.issues.some((issue) => issue.code === 'execution.unattempted'), false);
});

test('a requested PPTX without an artifact remains blocked', () => {
  const run: ChatRuntimeRunState = {
    runId: 'run-missing-pptx',
    sessionKey: 'agent:main:main',
    status: 'completed',
    objective: '请生成一份 8 页可编辑 PPTX。',
    assistantText: '我会生成 PPTX。',
    thinkingText: '',
    artifacts: [],
    verifications: [],
    events: [],
  };

  const report = buildRuntimeCompletionGateReport(run);
  assert.equal(report.hasBlockingIssues, true);
  assert.equal(report.issues.some((issue) => issue.code === 'artifact.required.missing'), true);

  const gateEvent = buildRuntimeCompletionGateEvents(run, {
    runId: run.runId,
    sessionKey: run.sessionKey,
    status: 'completed',
  }).find((event) => event.type === 'gate.evaluated');
  assert.ok(gateEvent && gateEvent.type === 'gate.evaluated');
  assert.equal(gateEvent.gate.decision, 'continue_required');
});

function wrappedDesignedPptxRepairRun(options: {
  finalVerificationStatus?: 'passed' | 'blocked';
  includeUnrelatedBlockedArtifact?: boolean;
} = {}): ChatRuntimeRunState {
  const runId = 'run-ppt-quality-repair';
  const sessionKey = 'agent:main:main';
  const finalVerificationStatus = options.finalVerificationStatus ?? 'passed';
  const toolStarted = (toolCallId: string, id: string, ts: number) => ({
    contractVersion: 1 as const,
    producer: 'gateway' as const,
    runId,
    sessionKey,
    ts,
    type: 'tool.started' as const,
    toolCallId,
    name: 'tool_call',
    args: { id },
  });
  const toolCompleted = (toolCallId: string, isError: boolean, ts: number) => ({
    contractVersion: 1 as const,
    producer: 'gateway' as const,
    runId,
    sessionKey,
    ts,
    type: 'tool.completed' as const,
    toolCallId,
    // This mirrors the runtime event sent by OpenClaw's directory wrapper;
    // the selected tool is preserved on the matching tool.started args.id.
    name: 'tool_call',
    isError,
  });

  const artifacts = [
    {
      id: 'ppt-draft-create',
      kind: 'presentation',
      title: 'draft-create.pptx',
      filePath: '/tmp/draft-create.pptx',
      sourceToolCallId: 'ppt-create',
    },
    {
      id: 'ppt-draft-repair-1',
      kind: 'presentation',
      title: 'draft-repair-1.pptx',
      filePath: '/tmp/draft-repair-1.pptx',
      sourceToolCallId: 'ppt-repair-1',
    },
    {
      id: 'ppt-final',
      kind: 'presentation',
      title: 'final.pptx',
      filePath: '/tmp/final.pptx',
      sourceToolCallId: 'ppt-repair-2',
    },
  ];
  const verifications = [
    {
      id: 'verify-ppt-draft-create',
      artifactId: 'ppt-draft-create',
      status: 'blocked' as const,
      required: true,
      kind: 'artifact.content',
    },
    {
      id: 'verify-ppt-draft-repair-1',
      artifactId: 'ppt-draft-repair-1',
      status: 'blocked' as const,
      required: true,
      kind: 'artifact.content',
    },
    {
      id: 'verify-ppt-final',
      artifactId: 'ppt-final',
      status: finalVerificationStatus,
      required: true,
      kind: 'artifact.content',
    },
  ];
  if (options.includeUnrelatedBlockedArtifact) {
    artifacts.push({
      id: 'unrelated-artifact',
      kind: 'document',
      title: 'unrelated.docx',
      filePath: '/tmp/unrelated.docx',
      sourceToolCallId: 'other-tool',
    });
    verifications.push({
      id: 'verify-unrelated-artifact',
      artifactId: 'unrelated-artifact',
      status: 'blocked',
      required: true,
      kind: 'artifact.content',
    });
  }

  return {
    runId,
    sessionKey,
    status: 'completed',
    objective: '帮我做一个 PPT',
    assistantText: 'PPT 已生成。',
    thinkingText: '',
    artifacts,
    verifications,
    planSteps: [
      { id: 'tool:ppt-create', title: '创建初稿', status: 'error' },
      { id: 'tool:ppt-repair-1', title: '修复初稿', status: 'error' },
      { id: 'tool:ppt-repair-2', title: '完成修复', status: 'completed' },
    ],
    events: [
      toolStarted('ppt-create', 'openclaw:uclaw-local-artifacts:create_designed_pptx_file', 1),
      toolCompleted('ppt-create', true, 2),
      toolStarted('ppt-repair-1', 'openclaw:uclaw-local-artifacts:repair_designed_pptx_file', 3),
      toolCompleted('ppt-repair-1', true, 4),
      toolStarted('ppt-repair-2', 'openclaw:uclaw-local-artifacts:repair_designed_pptx_file', 5),
      toolCompleted('ppt-repair-2', false, 6),
    ],
  };
}

test('a verified repair supersedes only earlier blocked PPT attempts in the same create/repair chain', () => {
  const run = wrappedDesignedPptxRepairRun();
  const report = buildRuntimeCompletionGateReport(run);

  assert.equal(report.hasBlockingIssues, false);
  assert.equal(report.artifactCount, 1);
  assert.equal(report.requiredVerificationCount, 1);
  assert.equal(report.passedRequiredVerificationCount, 1);
  assert.equal(report.verificationCoverage, 1);
  assert.equal(report.blockedVerificationCount, 0);
  assert.equal(report.failedStepCount, 0);
  assert.equal(report.issues.some((issue) => issue.code === 'verification.required.failed'), false);
  assert.equal(report.issues.some((issue) => issue.code === 'step.failed'), false);

  const gateEvent = buildRuntimeCompletionGateEvents(run, {
    runId: run.runId,
    sessionKey: run.sessionKey,
    status: 'completed',
  }).find((event) => event.type === 'gate.evaluated');
  assert.ok(gateEvent && gateEvent.type === 'gate.evaluated');
  assert.equal(gateEvent.gate.decision, 'deliverable');
  assert.equal(gateEvent.gate.artifactCount, 1);
  assert.equal(gateEvent.gate.requiredVerificationCount, 1);
  assert.equal(gateEvent.gate.passedRequiredVerificationCount, 1);
  assert.equal(gateEvent.gate.blockingIssueCount, 0);
});

test('a successful repair does not supersede a PPT attempt until its final artifact is verified', () => {
  const report = buildRuntimeCompletionGateReport(wrappedDesignedPptxRepairRun({
    finalVerificationStatus: 'blocked',
  }));

  assert.equal(report.hasBlockingIssues, true);
  assert.equal(report.artifactCount, 3);
  assert.equal(report.blockedVerificationCount, 3);
});

test('a verified PPT repair does not suppress an unrelated blocked artifact', () => {
  const report = buildRuntimeCompletionGateReport(wrappedDesignedPptxRepairRun({
    includeUnrelatedBlockedArtifact: true,
  }));

  assert.equal(report.hasBlockingIssues, true);
  assert.equal(report.artifactCount, 2);
  assert.equal(report.requiredVerificationCount, 2);
  assert.equal(report.passedRequiredVerificationCount, 1);
  assert.equal(report.blockedVerificationCount, 1);
  assert.equal(report.issues.some((issue) => issue.artifactId === 'unrelated-artifact'), true);
});

test('an unrecovered tool failure remains blocking', () => {
  const report = buildRuntimeCompletionGateReport(artifactRunWithToolAttempts([
    { id: 'ppt-attempt-1', isError: true },
  ]));

  assert.equal(report.hasBlockingIssues, true);
  assert.equal(report.failedStepCount, 1);
  assert.equal(report.issues.some((issue) => issue.code === 'tool.failed'), true);
});
