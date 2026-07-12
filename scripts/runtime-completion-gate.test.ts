import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRuntimeCompletionGateEvents,
  buildRuntimeCompletionGateReport,
} from '../src/stores/chat/runtime-contract.ts';
import type { ChatRuntimeRunState } from '../src/stores/chat/types.ts';
import type { AgentTurnContract } from '../shared/agent-turn-contract.ts';

const pptxTurnContract: AgentTurnContract = {
  version: 1,
  intent: 'artifact',
  toolRequirement: 'required',
  sideEffect: 'local_artifact',
  sideEffectAuthorized: true,
  capabilityRefs: ['presentation-maker'],
  acceptance: {
    requiresArtifact: true,
    requiresVerification: true,
    requiresApproval: false,
    requiresToolEvidence: true,
  },
};

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
      kind: 'artifact.availability',
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

test('an artifact contract may explicitly waive verification without creating a missing-verification gate', () => {
  const run: ChatRuntimeRunState = {
    runId: 'run-artifact-no-verification',
    sessionKey: 'agent:main:main',
    status: 'completed',
    objective: '创建一个无需内容验证的临时文件',
    turnContract: {
      ...pptxTurnContract,
      toolRequirement: 'optional',
      acceptance: {
        requiresArtifact: true,
        requiresVerification: false,
        requiresApproval: false,
        requiresToolEvidence: false,
      },
    },
    artifacts: [{
      id: 'artifact-unverified',
      kind: 'document',
      title: 'draft.txt',
      filePath: '/tmp/draft.txt',
    }],
    verifications: [{
      id: 'verification-unverified-availability',
      artifactId: 'artifact-unverified',
      status: 'passed',
      required: true,
      kind: 'artifact.availability',
    }],
    assistantText: '临时文件已创建。',
    thinkingText: '',
    events: [],
  };

  const report = buildRuntimeCompletionGateReport(run);
  assert.equal(report.hasBlockingIssues, false);
  assert.equal(report.missingVerificationCount, 0);
  assert.equal(report.verificationCoverage, 1);
});

test('requiresVerification=false never waives the artifact availability baseline', () => {
  const run: ChatRuntimeRunState = {
    runId: 'run-artifact-missing-availability',
    sessionKey: 'agent:main:main',
    status: 'completed',
    objective: '创建一个临时文件',
    turnContract: {
      ...pptxTurnContract,
      toolRequirement: 'optional',
      acceptance: {
        requiresArtifact: true,
        requiresVerification: false,
        requiresApproval: false,
        requiresToolEvidence: false,
      },
    },
    artifacts: [{ id: 'artifact-missing-availability', kind: 'document', title: 'missing.txt' }],
    verifications: [],
    assistantText: '文件已创建。',
    thinkingText: '',
    events: [],
  };

  const report = buildRuntimeCompletionGateReport(run);
  assert.equal(report.hasBlockingIssues, true);
  assert.equal(report.issues.some((issue) => issue.code === 'artifact.verification.missing'), true);
});

test('approval and side-effect authorization remain independent completion requirements', () => {
  const baseRun: ChatRuntimeRunState = {
    runId: 'run-artifact-approval',
    sessionKey: 'agent:main:main',
    status: 'completed',
    objective: '审批后创建文件',
    turnContract: {
      ...pptxTurnContract,
      toolRequirement: 'optional',
      acceptance: {
        requiresArtifact: true,
        requiresVerification: false,
        requiresApproval: true,
        requiresToolEvidence: false,
      },
    },
    artifacts: [{ id: 'artifact-approved', kind: 'document', title: 'approved.txt' }],
    verifications: [{
      id: 'verification-approved-availability',
      artifactId: 'artifact-approved',
      status: 'passed',
      required: true,
      kind: 'artifact.availability',
    }],
    assistantText: '文件已创建。',
    thinkingText: '',
    events: [],
  };

  const missingApproval = buildRuntimeCompletionGateReport(baseRun);
  assert.equal(missingApproval.issues.some((issue) => issue.code === 'approval.required.missing'), true);
  assert.equal(missingApproval.issues.some((issue) => issue.code === 'artifact.verification.missing'), false);

  const unauthorized = buildRuntimeCompletionGateReport({
    ...baseRun,
    runId: 'run-artifact-unauthorized',
    turnContract: { ...baseRun.turnContract!, sideEffectAuthorized: false },
  });
  assert.equal(unauthorized.issues.some((issue) => issue.code === 'side_effect.unauthorized'), true);
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
    turnContract: pptxTurnContract,
    assistantText: '我会生成 PPTX。',
    thinkingText: '',
    artifacts: [],
    verifications: [],
    events: [],
  };

  const report = buildRuntimeCompletionGateReport(run);
  assert.equal(report.hasBlockingIssues, true);
  assert.equal(report.issues.some((issue) => issue.code === 'artifact.required.missing'), true);
  assert.equal(report.issues.some((issue) => issue.code === 'execution.unattempted'), true);

  const gateEvent = buildRuntimeCompletionGateEvents(run, {
    runId: run.runId,
    sessionKey: run.sessionKey,
    status: 'completed',
  }).find((event) => event.type === 'gate.evaluated');
  assert.ok(gateEvent && gateEvent.type === 'gate.evaluated');
  assert.equal(gateEvent.gate.decision, 'continue_required');
});

test('declaring a contract or reading capabilities does not count as actual execution', () => {
  const run: ChatRuntimeRunState = {
    runId: 'run-metadata-only',
    sessionKey: 'agent:main:main',
    status: 'completed',
    objective: '生成一份文件。',
    turnContract: pptxTurnContract,
    assistantText: '已声明合同。',
    thinkingText: '',
    artifacts: [],
    verifications: [],
    events: [
      {
        contractVersion: 1,
        producer: 'plugin',
        runId: 'run-metadata-only',
        sessionKey: 'agent:main:main',
        type: 'tool.completed',
        toolCallId: 'contract',
        name: 'uclaw_declare_turn_contract',
        isError: false,
      },
      {
        contractVersion: 1,
        producer: 'plugin',
        runId: 'run-metadata-only',
        sessionKey: 'agent:main:main',
        type: 'tool.completed',
        toolCallId: 'capabilities',
        name: 'uclaw_get_runtime_capabilities',
        isError: false,
      },
    ],
  };

  const report = buildRuntimeCompletionGateReport(run);
  assert.equal(report.issues.some((issue) => issue.code === 'execution.unattempted'), true);
});

test('an undeclared text-only turn remains deliverable even when it mentions an artifact', () => {
  const run: ChatRuntimeRunState = {
    runId: 'run-undeclared-ppt-copy',
    sessionKey: 'agent:main:main',
    status: 'completed',
    objective: '给我一页发布会 PPT 的文案，不要生成文件。',
    assistantText: '标题：个人 AI 工作台。',
    thinkingText: '',
    artifacts: [],
    verifications: [],
    events: [],
  };

  const report = buildRuntimeCompletionGateReport(run);
  assert.equal(report.hasBlockingIssues, false);
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
      kind: 'artifact.availability',
    },
    {
      id: 'verify-ppt-draft-repair-1',
      artifactId: 'ppt-draft-repair-1',
      status: 'blocked' as const,
      required: true,
      kind: 'artifact.availability',
    },
    {
      id: 'verify-ppt-final',
      artifactId: 'ppt-final',
      status: finalVerificationStatus,
      required: true,
      kind: 'artifact.availability',
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
      kind: 'artifact.availability',
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

for (const scenario of [
  { status: 'completed' as const, issue: undefined, decision: 'deliverable', running: 0, failed: 0, delivery: 'completed' },
  { status: 'pending' as const, issue: 'task.unfinished', decision: 'continue_required', running: 1, failed: 0, delivery: 'blocked' },
  { status: 'running' as const, issue: 'task.unfinished', decision: 'continue_required', running: 1, failed: 0, delivery: 'blocked' },
  { status: 'partial' as const, issue: 'task.blocked', decision: 'continue_required', running: 0, failed: 1, delivery: 'error' },
  { status: 'waiting_approval' as const, issue: 'task.blocked', decision: 'blocked_needs_user', running: 0, failed: 1, delivery: 'error' },
  { status: 'error' as const, issue: 'task.failed', decision: 'continue_required', running: 0, failed: 1, delivery: 'error' },
]) {
  test(`completion gate projects ${scenario.status} detached tasks without duplicate companion-step issues`, () => {
    const run: ChatRuntimeRunState = {
      runId: `run-task-${scenario.status}`,
      sessionKey: 'agent:main:main',
      status: 'completed',
      objective: 'Execute detached work',
      assistantText: '',
      thinkingText: '',
      tasks: [{
        taskId: 'detached-task',
        title: 'Detached task',
        status: scenario.status,
        detail: scenario.status === 'waiting_approval' ? 'Approval required.' : undefined,
        updatedAt: 10,
      }],
      planSteps: [{
        id: 'task:detached-task',
        taskId: 'detached-task',
        title: 'Stale companion step',
        status: scenario.status === 'completed' ? 'completed' : 'running',
      }],
      artifacts: [],
      verifications: [],
      events: [],
    };

    const report = buildRuntimeCompletionGateReport(run);
    const taskIssues = report.issues.filter((issue) => issue.code.startsWith('task.'));
    assert.equal(taskIssues.length, scenario.issue ? 1 : 0);
    assert.equal(taskIssues[0]?.code, scenario.issue);
    assert.equal(report.issues.some((issue) => issue.code.startsWith('step.')), false);
    assert.equal(report.runningStepCount, scenario.running);
    assert.equal(report.failedStepCount, scenario.failed);
    if (scenario.status === 'waiting_approval') assert.equal(taskIssues[0]?.recoverable, false);

    const events = buildRuntimeCompletionGateEvents(run, {
      runId: run.runId,
      sessionKey: run.sessionKey,
      status: 'completed',
    });
    const gate = events.find((event) => event.type === 'gate.evaluated');
    const delivery = events.find((event) => (
      event.type === 'run.step.updated' && event.step.id === 'uclaw.deliver'
    ));
    assert.ok(gate && gate.type === 'gate.evaluated');
    assert.equal(gate.gate.decision, scenario.decision);
    assert.ok(delivery && delivery.type === 'run.step.updated');
    assert.equal(delivery.step.status, scenario.delivery);
  });
}
