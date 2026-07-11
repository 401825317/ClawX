import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRuntimeCompletionGateReport } from '../src/stores/chat/runtime-contract.ts';
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

test('an unrecovered tool failure remains blocking', () => {
  const report = buildRuntimeCompletionGateReport(artifactRunWithToolAttempts([
    { id: 'ppt-attempt-1', isError: true },
  ]));

  assert.equal(report.hasBlockingIssues, true);
  assert.equal(report.failedStepCount, 1);
  assert.equal(report.issues.some((issue) => issue.code === 'tool.failed'), true);
});
