import { describe, expect, it } from 'vitest';
import {
  deriveRuntimeTaskSteps,
  deriveTaskSteps,
  findReplyMessageIndex,
  parseSubagentCompletionInfo,
  segmentHasFinalReply,
} from '@/pages/Chat/task-visualization';
import { stripProcessMessagePrefix } from '@/pages/Chat/message-utils';
import { applyRuntimeEventToRuns } from '@/stores/chat/runtime-graph';
import {
  buildRuntimeCompletionGateEvents,
  buildRuntimeCompletionGateReport,
} from '@/stores/chat/runtime-contract';
import type { RawMessage, ToolStatus } from '@/stores/chat';

describe('runtime graph state', () => {
  it('keeps distinct runtime tool updates for the same tool call', () => {
    const started = applyRuntimeEventToRuns({}, {
      type: 'tool.started',
      runId: 'run-1',
      toolCallId: 'call-1',
      name: 'exec',
    });
    const firstUpdate = applyRuntimeEventToRuns(started, {
      type: 'tool.updated',
      runId: 'run-1',
      toolCallId: 'call-1',
      name: 'exec',
      partialResult: 'step 1',
    });
    const secondUpdate = applyRuntimeEventToRuns(firstUpdate, {
      type: 'tool.updated',
      runId: 'run-1',
      toolCallId: 'call-1',
      name: 'exec',
      partialResult: 'step 2',
    });
    const duplicateSecondUpdate = applyRuntimeEventToRuns(secondUpdate, {
      type: 'tool.updated',
      runId: 'run-1',
      toolCallId: 'call-1',
      name: 'exec',
      partialResult: 'step 2',
    });

    expect(secondUpdate['run-1'].events).toHaveLength(3);
    expect(duplicateSecondUpdate['run-1'].events).toHaveLength(3);
  });

  it('deduplicates replayed runtime events by runId and seq while keeping distinct seq values', () => {
    const first = applyRuntimeEventToRuns({}, {
      type: 'tool.updated',
      runId: 'run-replay',
      seq: 10,
      toolCallId: 'call-1',
      name: 'exec',
      partialResult: 'step 1',
    });
    const second = applyRuntimeEventToRuns(first, {
      type: 'tool.updated',
      runId: 'run-replay',
      seq: 11,
      toolCallId: 'call-1',
      name: 'exec',
      partialResult: 'step 1',
    });
    const replayedFirst = applyRuntimeEventToRuns(second, {
      type: 'tool.updated',
      runId: 'run-replay',
      seq: 10,
      toolCallId: 'call-1',
      name: 'exec',
      partialResult: 'step 1',
    });

    expect(second['run-replay'].events.map((event) => event.seq)).toEqual([10, 11]);
    expect(replayedFirst).toBe(second);
    expect(replayedFirst['run-replay'].events.map((event) => event.seq)).toEqual([10, 11]);
  });

  it('does not drop full-text assistant deltas that do not extend the previous prefix', () => {
    const first = applyRuntimeEventToRuns({}, {
      type: 'assistant.delta',
      runId: 'run-1',
      text: 'hello',
    });
    const second = applyRuntimeEventToRuns(first, {
      type: 'assistant.delta',
      runId: 'run-1',
      text: 'corrected',
    });

    expect(second['run-1'].assistantText).toBe('corrected');
  });

  it('aggregates plan, artifact, verification, and checkpoint events into the run contract', () => {
    const planned = applyRuntimeEventToRuns({}, {
      type: 'run.plan.updated',
      runId: 'run-contract',
      objective: '生成并验证报告',
      summary: '先生成文件，再验证可打开',
      steps: [
        { id: 'write', title: '生成报告', status: 'running', order: 2 },
        { id: 'inspect', title: '检查输入', status: 'completed', order: 1 },
      ],
    });
    const withArtifact = applyRuntimeEventToRuns(planned, {
      type: 'artifact.produced',
      runId: 'run-contract',
      artifact: {
        id: 'report',
        kind: 'document',
        title: '报告',
        filePath: '/tmp/report.docx',
      },
      toolCallId: 'tool-create',
    });
    const withVerification = applyRuntimeEventToRuns(withArtifact, {
      type: 'verification.completed',
      runId: 'run-contract',
      verification: {
        id: 'verify-report',
        status: 'passed',
        artifactId: 'report',
        title: '文件存在',
      },
    });
    const withCheckpoint = applyRuntimeEventToRuns(withVerification, {
      type: 'run.checkpoint',
      runId: 'run-contract',
      checkpoint: {
        id: 'cp-1',
        summary: '报告已生成，准备最终回复',
        recoverable: true,
      },
    });

    expect(withCheckpoint['run-contract']).toMatchObject({
      objective: '生成并验证报告',
      planSummary: '先生成文件，再验证可打开',
      planSteps: [
        expect.objectContaining({ id: 'inspect' }),
        expect.objectContaining({ id: 'write' }),
      ],
      artifacts: [
        expect.objectContaining({
          id: 'report',
          sourceToolCallId: 'tool-create',
        }),
      ],
      verifications: [
        expect.objectContaining({ id: 'verify-report', status: 'passed' }),
      ],
      checkpoints: [
        expect.objectContaining({ id: 'cp-1' }),
      ],
    });
  });

  it('aggregates gate issues and evaluations into the run contract', () => {
    const withIssue = applyRuntimeEventToRuns({}, {
      type: 'gate.issue',
      runId: 'run-gate-contract',
      issue: {
        id: 'issue-1',
        code: 'tool.failed',
        severity: 'blocking',
        title: '工具失败',
        recoverable: true,
      },
    });
    const withGate = applyRuntimeEventToRuns(withIssue, {
      type: 'gate.evaluated',
      runId: 'run-gate-contract',
      gate: {
        id: 'gate:run-gate-contract:completion',
        decision: 'continue_required',
        artifactCount: 0,
        requiredVerificationCount: 0,
        passedRequiredVerificationCount: 0,
        blockingIssueCount: 1,
        warningIssueCount: 0,
        verificationCoverage: 1,
        issues: [{
          id: 'issue-1',
          code: 'tool.failed',
          severity: 'blocking',
          title: '工具失败',
          recoverable: true,
        }],
      },
    });

    expect(withGate['run-gate-contract']).toMatchObject({
      issues: [expect.objectContaining({ id: 'issue-1', code: 'tool.failed' })],
      gateEvaluations: [expect.objectContaining({ id: 'gate:run-gate-contract:completion' })],
      gateResult: expect.objectContaining({
        decision: 'continue_required',
        blockingIssueCount: 1,
      }),
    });
  });

  it('blocks completion when runtime facts still contain failed or unfinished execution work', () => {
    const runtimeRuns = [
      {
        type: 'run.plan.updated' as const,
        runId: 'run-gate',
        steps: [
          { id: 'uclaw.execute', title: '执行任务', status: 'running' as const, order: 1 },
          { id: 'tool:create', title: '生成文件', status: 'completed' as const, order: 2 },
          { id: 'tool:inspect', title: '检查文件', status: 'running' as const, order: 3 },
          { id: 'tool:upload', title: '上传文件', status: 'error' as const, order: 4 },
        ],
      },
      {
        type: 'artifact.produced' as const,
        runId: 'run-gate',
        artifact: {
          id: 'artifact-report',
          title: '报告',
          filePath: '/tmp/report.docx',
        },
      },
      {
        type: 'verification.completed' as const,
        runId: 'run-gate',
        verification: {
          id: 'verify-report',
          status: 'blocked' as const,
          artifactId: 'artifact-report',
          detail: '文件不存在',
        },
      },
      {
        type: 'run.checkpoint' as const,
        runId: 'run-gate',
        checkpoint: {
          id: 'fatal',
          summary: '无法恢复',
          recoverable: false,
        },
      },
    ].reduce((runs, event) => applyRuntimeEventToRuns(runs, event), {});

    const run = runtimeRuns['run-gate'];
    const report = buildRuntimeCompletionGateReport(run);
    expect(report).toMatchObject({
      artifactCount: 1,
      blockedVerificationCount: 1,
      failedStepCount: 1,
      runningStepCount: 1,
      blockingCheckpointCount: 1,
      hasBlockingIssues: true,
    });

    const gateEvents = buildRuntimeCompletionGateEvents(run, {
      runId: 'run-gate',
      status: 'completed',
      ts: 1,
    });

    expect(gateEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'gate.issue',
        producer: 'gate',
        contractVersion: 1,
        issue: expect.objectContaining({
          code: 'verification.required.failed',
          severity: 'blocking',
        }),
      }),
      expect.objectContaining({
        type: 'gate.evaluated',
        producer: 'gate',
        contractVersion: 1,
        gate: expect.objectContaining({
          decision: 'blocked_needs_user',
          blockingIssueCount: 4,
          requiredVerificationCount: 1,
          passedRequiredVerificationCount: 0,
          verificationCoverage: 0,
        }),
      }),
      expect.objectContaining({
        type: 'run.step.updated',
        step: expect.objectContaining({
          id: 'uclaw.verify',
          status: 'blocked',
          detail: expect.stringContaining('阻断项 4 个'),
        }),
      }),
      expect.objectContaining({
        type: 'run.step.updated',
        step: expect.objectContaining({
          id: 'uclaw.deliver',
          status: 'error',
          detail: expect.stringContaining('上传文件 失败或阻塞'),
        }),
      }),
      expect.objectContaining({
        type: 'run.checkpoint',
        checkpoint: expect.objectContaining({
          id: 'checkpoint:run-gate:completion-gate',
          summary: '完成门禁发现执行结果尚未满足交付条件。',
          reason: expect.stringContaining('无法恢复'),
        }),
      }),
    ]));
  });

  it('blocks completion on failed tool, command, and approval runtime facts even without producer steps', () => {
    const runtimeRuns = [
      {
        type: 'tool.completed' as const,
        runId: 'run-raw-failures',
        toolCallId: 'call-write',
        name: 'write_file',
        isError: true,
        result: { error: 'permission denied' },
      },
      {
        type: 'command.output' as const,
        runId: 'run-raw-failures',
        itemId: 'cmd-1',
        name: 'exec',
        title: 'npm test',
        output: 'failed',
        exitCode: 1,
        phase: 'end',
      },
      {
        type: 'approval.updated' as const,
        runId: 'run-raw-failures',
        itemId: 'approval-1',
        title: '写入授权',
        status: 'denied',
        message: 'user denied',
      },
    ].reduce((runs, event) => applyRuntimeEventToRuns(runs, event), {});

    const report = buildRuntimeCompletionGateReport(runtimeRuns['run-raw-failures']);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'tool.failed',
      'command.failed',
      'approval.denied',
    ]));
    expect(report).toMatchObject({
      blockingIssueCount: 3,
      failedStepCount: 3,
      hasBlockingIssues: true,
    });

    const gateEvents = buildRuntimeCompletionGateEvents(runtimeRuns['run-raw-failures'], {
      runId: 'run-raw-failures',
      status: 'completed',
    });

    expect(gateEvents.filter((event) => event.type === 'gate.issue')).toHaveLength(3);
    expect(gateEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'gate.evaluated',
        gate: expect.objectContaining({
          decision: 'blocked_needs_user',
          blockingIssueCount: 3,
        }),
      }),
    ]));
    expect(gateEvents.some((event) => event.type === 'run.checkpoint')).toBe(true);
  });

  it('blocks completion on failed required command verification even without an artifact id', () => {
    const runtimeRuns = [
      {
        type: 'verification.completed' as const,
        runId: 'run-command-verification',
        verification: {
          id: 'verification:cmd-typecheck',
          status: 'failed' as const,
          kind: 'typecheck',
          required: true,
          severity: 'blocking' as const,
          title: 'pnpm run typecheck',
          targetId: 'cmd-typecheck',
          evidence: 'exitCode=1',
        },
      },
    ].reduce((runs, event) => applyRuntimeEventToRuns(runs, event), {});

    const report = buildRuntimeCompletionGateReport(runtimeRuns['run-command-verification']);

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'verification.required.failed',
        verificationId: 'verification:cmd-typecheck',
        targetId: 'cmd-typecheck',
      }),
    ]));
    expect(report).toMatchObject({
      blockedVerificationCount: 1,
      blockingIssueCount: 1,
      hasBlockingIssues: true,
    });
  });

  it('blocks artifact-oriented objectives that finish without producing artifacts', () => {
    const runtimeRuns = [
      {
        type: 'run.started' as const,
        runId: 'run-missing-artifact',
        objective: '生图，PPT，Excel，生视频，每个事儿都随便给我来一个',
      },
      {
        type: 'run.plan.updated' as const,
        runId: 'run-missing-artifact',
        objective: '生图，PPT，Excel，生视频，每个事儿都随便给我来一个',
        steps: [
          { id: 'uclaw.objective', title: '理解目标', status: 'completed' as const, order: 0 },
          { id: 'uclaw.execute', title: '执行任务', status: 'completed' as const, order: 1 },
        ],
      },
    ].reduce((runs, event) => applyRuntimeEventToRuns(runs, event), {});

    const report = buildRuntimeCompletionGateReport(runtimeRuns['run-missing-artifact']);
    expect(report).toMatchObject({
      artifactCount: 0,
      missingRequiredArtifactCount: 1,
      blockingIssueCount: 1,
      verificationCoverage: 0,
      hasBlockingIssues: true,
    });
    expect(report.issues.map((issue) => issue.code)).toContain('artifact.required.missing');

    const gateEvents = buildRuntimeCompletionGateEvents(runtimeRuns['run-missing-artifact'], {
      runId: 'run-missing-artifact',
      status: 'completed',
    });

    expect(gateEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'gate.issue',
        issue: expect.objectContaining({
          code: 'artifact.required.missing',
          severity: 'blocking',
          recoverable: true,
        }),
      }),
      expect.objectContaining({
        type: 'gate.evaluated',
        gate: expect.objectContaining({
          decision: 'continue_required',
          artifactCount: 0,
          verificationCoverage: 0,
        }),
      }),
      expect.objectContaining({
        type: 'run.checkpoint',
        checkpoint: expect.objectContaining({
          id: 'checkpoint:run-missing-artifact:completion-gate',
          recoverable: true,
        }),
      }),
    ]));
  });

  it('blocks composite required-artifact subtasks until each one has an artifact', () => {
    const runtimeRuns = [
      {
        type: 'run.plan.updated' as const,
        runId: 'run-composite-artifacts',
        objective: '生成图片、PPT 和 Excel',
        steps: [
          { id: 'task:image', title: '生成图片', status: 'completed' as const, requiresArtifact: true, order: 1 },
          { id: 'task:ppt', title: '生成 PPT', status: 'completed' as const, requiresArtifact: true, order: 2 },
          { id: 'task:excel', title: '生成 Excel', status: 'running' as const, requiresArtifact: true, order: 3 },
        ],
      },
      {
        type: 'artifact.produced' as const,
        runId: 'run-composite-artifacts',
        artifact: {
          id: 'artifact:image',
          title: '图片',
          filePath: '/tmp/image.png',
          sourceToolCallId: 'task:image',
        },
      },
      {
        type: 'verification.completed' as const,
        runId: 'run-composite-artifacts',
        verification: {
          id: 'verify-image',
          status: 'passed' as const,
          artifactId: 'artifact:image',
        },
      },
    ].reduce((runs, event) => applyRuntimeEventToRuns(runs, event), {});

    const report = buildRuntimeCompletionGateReport(runtimeRuns['run-composite-artifacts']);

    expect(report).toMatchObject({
      artifactCount: 1,
      missingRequiredArtifactCount: 2,
      runningStepCount: 1,
      blockingIssueCount: 3,
      hasBlockingIssues: true,
      verificationCoverage: 1,
    });
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'artifact.required.missing',
        stepId: 'task:ppt',
        title: '生成 PPT 缺少必需产物',
      }),
      expect.objectContaining({
        code: 'artifact.required.missing',
        stepId: 'task:excel',
        title: '生成 Excel 缺少必需产物',
      }),
      expect.objectContaining({
        code: 'step.unfinished',
        stepId: 'task:excel',
      }),
    ]));

    const gateEvents = buildRuntimeCompletionGateEvents(runtimeRuns['run-composite-artifacts'], {
      runId: 'run-composite-artifacts',
      status: 'completed',
    });

    expect(gateEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'gate.evaluated',
        gate: expect.objectContaining({
          decision: 'continue_required',
          blockingIssueCount: 3,
          artifactCount: 1,
        }),
      }),
      expect.objectContaining({
        type: 'run.step.updated',
        step: expect.objectContaining({
          id: 'uclaw.deliver',
          status: 'blocked',
          detail: expect.stringContaining('生成 PPT 缺少必需产物'),
        }),
      }),
    ]));
  });

  it('matches seven composite artifacts by structured stepId without order fallback', () => {
    const steps = [
      { id: 'uclaw.composite.image', title: '生成图片' },
      { id: 'uclaw.composite.video', title: '生成视频' },
      { id: 'uclaw.composite.ppt', title: '制作 PPT' },
      { id: 'uclaw.composite.excel', title: '制作 Excel' },
      { id: 'uclaw.composite.doc', title: '制作 Word' },
      { id: 'uclaw.composite.web', title: '制作网页' },
      { id: 'uclaw.composite.code', title: '输出代码' },
    ].map((step, index) => ({
      ...step,
      status: 'completed' as const,
      kind: 'composite-task',
      requiresArtifact: true,
      order: index + 1,
    }));
    const producedStepIds = [
      'uclaw.composite.ppt',
      'uclaw.composite.image',
      'uclaw.composite.doc',
      'uclaw.composite.web',
      'uclaw.composite.code',
    ];
    const artifactEvents = producedStepIds.map((stepId, index) => ({
      type: 'artifact.produced' as const,
      runId: 'run-seven-composite-artifacts',
      artifact: {
        id: `artifact:${stepId}`,
        title: `产物 ${index + 1}`,
        filePath: `/tmp/artifact-${index + 1}`,
        stepId,
      },
    }));
    const verificationEvents = artifactEvents.map((event) => ({
      type: 'verification.completed' as const,
      runId: 'run-seven-composite-artifacts',
      verification: {
        id: `verify:${event.artifact.id}`,
        status: 'passed' as const,
        artifactId: event.artifact.id,
      },
    }));
    const runtimeRuns = [
      {
        type: 'run.plan.updated' as const,
        runId: 'run-seven-composite-artifacts',
        objective: '生成 7 个 composite 子任务产物',
        steps,
      },
      ...artifactEvents,
      ...verificationEvents,
    ].reduce((runs, event) => applyRuntimeEventToRuns(runs, event), {});

    const report = buildRuntimeCompletionGateReport(runtimeRuns['run-seven-composite-artifacts']);
    const missingStepIds = report.issues
      .filter((issue) => issue.code === 'artifact.required.missing')
      .map((issue) => issue.stepId);

    expect(report).toMatchObject({
      artifactCount: 5,
      missingRequiredArtifactCount: 2,
      blockingIssueCount: 2,
      hasBlockingIssues: true,
      verificationCoverage: 1,
    });
    expect(missingStepIds).toEqual([
      'uclaw.composite.video',
      'uclaw.composite.excel',
    ]);
  });

  it('marks completion as deliverable when artifacts are verified and no execution issues remain', () => {
    const runtimeRuns = [
      {
        type: 'run.step.updated' as const,
        runId: 'run-clean',
        step: { id: 'tool:create', title: '生成文件', status: 'completed' as const },
      },
      {
        type: 'artifact.produced' as const,
        runId: 'run-clean',
        artifact: {
          id: 'artifact-report',
          title: '报告',
          filePath: '/tmp/report.docx',
        },
      },
      {
        type: 'verification.completed' as const,
        runId: 'run-clean',
        verification: {
          id: 'verify-report',
          status: 'passed' as const,
          artifactId: 'artifact-report',
        },
      },
    ].reduce((runs, event) => applyRuntimeEventToRuns(runs, event), {});

    const run = runtimeRuns['run-clean'];
    expect(buildRuntimeCompletionGateReport(run)).toMatchObject({
      hasBlockingIssues: false,
      artifactCount: 1,
    });

    const gateEvents = buildRuntimeCompletionGateEvents(run, {
      runId: 'run-clean',
      status: 'completed',
      ts: 1,
    });

    expect(gateEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'run.step.updated',
        step: expect.objectContaining({ id: 'uclaw.verify', status: 'completed' }),
      }),
      expect.objectContaining({
        type: 'run.step.updated',
        step: expect.objectContaining({ id: 'uclaw.deliver', status: 'completed' }),
      }),
      expect.objectContaining({
        type: 'gate.evaluated',
        gate: expect.objectContaining({
          decision: 'deliverable',
          artifactCount: 1,
          requiredVerificationCount: 1,
          passedRequiredVerificationCount: 1,
        }),
      }),
    ]));
    expect(gateEvents.some((event) => event.type === 'run.checkpoint')).toBe(false);
    expect(gateEvents.some((event) => event.type === 'gate.issue')).toBe(false);
  });

  it('does not treat optional artifact registration as required availability verification', () => {
    const runtimeRuns = [
      {
        type: 'artifact.produced' as const,
        runId: 'run-registration-only',
        artifact: {
          id: 'artifact-image',
          title: '图片',
          filePath: '/tmp/image.png',
        },
      },
      {
        type: 'verification.completed' as const,
        runId: 'run-registration-only',
        verification: {
          id: 'verification:artifact-image:registration',
          status: 'passed' as const,
          kind: 'artifact.registration',
          required: false,
          severity: 'info' as const,
          artifactId: 'artifact-image',
        },
      },
    ].reduce((runs, event) => applyRuntimeEventToRuns(runs, event), {});

    const report = buildRuntimeCompletionGateReport(runtimeRuns['run-registration-only']);

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'artifact.verification.missing',
        artifactId: 'artifact-image',
      }),
    ]));
    expect(report).toMatchObject({
      artifactCount: 1,
      missingVerificationCount: 1,
      hasBlockingIssues: true,
    });
  });
});

describe('deriveTaskSteps', () => {
  it('projects runtime tool events into active execution graph steps', () => {
    const steps = deriveRuntimeTaskSteps({
      runId: 'run-1',
      status: 'running',
      assistantText: '',
      thinkingText: '',
      events: [
        { type: 'run.started', runId: 'run-1', sessionKey: 'agent:main:main' },
        { type: 'tool.started', runId: 'run-1', sessionKey: 'agent:main:main', toolCallId: 'call-1', name: 'read', args: { filePath: '/tmp/demo.md' } },
        { type: 'command.output', runId: 'run-1', sessionKey: 'agent:main:main', toolCallId: 'call-1', itemId: 'cmd-1', title: 'exec output', output: 'Scanning workspace', status: 'running', phase: 'update' },
        { type: 'tool.completed', runId: 'run-1', sessionKey: 'agent:main:main', toolCallId: 'call-1', name: 'read', result: { summary: 'Done' }, isError: false },
      ],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'call-1',
        label: 'read',
        status: 'completed',
        kind: 'tool',
      }),
      expect.objectContaining({
        id: 'cmd-1',
        label: 'exec output',
        status: 'running',
        kind: 'message',
        detail: 'Scanning workspace',
      }),
    ]);
  });

  it('projects runtime contract events into visible execution steps', () => {
    const steps = deriveRuntimeTaskSteps({
      runId: 'run-contract',
      status: 'running',
      assistantText: '',
      thinkingText: '',
      events: [
        {
          type: 'run.plan.updated',
          runId: 'run-contract',
          objective: '生成并验证报告',
          summary: '先生成文件，再验证可打开',
          steps: [
            { id: 'write', title: '生成报告', status: 'running', order: 1 },
          ],
        },
        {
          type: 'artifact.produced',
          runId: 'run-contract',
          artifact: {
            id: 'report',
            kind: 'document',
            title: '报告',
            filePath: '/tmp/report.docx',
          },
        },
        {
          type: 'verification.completed',
          runId: 'run-contract',
          verification: {
            id: 'verify-report',
            status: 'passed',
            artifactId: 'report',
            title: '文件存在',
            evidence: 'stat ok',
          },
        },
      ],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'run-plan',
        label: 'Plan',
        kind: 'system',
      }),
      expect.objectContaining({
        id: 'plan-step:write',
        label: '生成报告',
        status: 'running',
        parentId: 'run-plan',
      }),
      expect.objectContaining({
        id: 'artifact:report',
        label: '报告',
        status: 'completed',
        detail: expect.stringContaining('/tmp/report.docx'),
      }),
      expect.objectContaining({
        id: 'verification:verify-report',
        label: '文件存在',
        status: 'completed',
        depth: 2,
        parentId: 'artifact:report',
        detail: expect.stringContaining('stat ok'),
      }),
    ]);
  });

  it('projects gate issues and gate decisions into visible execution steps', () => {
    const steps = deriveRuntimeTaskSteps({
      runId: 'run-gate-ui',
      status: 'running',
      assistantText: '',
      thinkingText: '',
      events: [
        {
          type: 'gate.issue',
          runId: 'run-gate-ui',
          issue: {
            id: 'issue-1',
            code: 'tool.failed',
            severity: 'blocking',
            title: '工具失败',
            detail: 'permission denied',
            recoverable: true,
          },
        },
        {
          type: 'gate.evaluated',
          runId: 'run-gate-ui',
          gate: {
            id: 'gate:run-gate-ui:completion',
            decision: 'continue_required',
            summary: '需要继续执行。',
            artifactCount: 0,
            requiredVerificationCount: 0,
            passedRequiredVerificationCount: 0,
            blockingIssueCount: 1,
            warningIssueCount: 0,
            verificationCoverage: 1,
            issues: [{
              id: 'issue-1',
              code: 'tool.failed',
              severity: 'blocking',
              title: '工具失败',
              detail: 'permission denied',
              recoverable: true,
            }],
          },
        },
      ],
    });

    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'gate-result',
        label: 'Gate',
        status: 'blocked',
        detail: expect.stringContaining('decision=continue_required'),
      }),
      expect.objectContaining({
        id: 'gate-issue:issue-1',
        label: '工具失败',
        status: 'blocked',
        parentId: 'gate-result',
        detail: expect.stringContaining('recoverable=true'),
      }),
    ]));
    expect(steps.find((step) => step.id === 'gate-issue:issue-1')?.detail).toEqual(expect.stringContaining('permission denied'));
  });

  it('keeps gate and checkpoint status semantics visible in execution steps', () => {
    const steps = deriveRuntimeTaskSteps({
      runId: 'run-gate-statuses',
      status: 'running',
      assistantText: '',
      thinkingText: '',
      events: [
        {
          type: 'gate.evaluated',
          runId: 'run-gate-statuses',
          gate: {
            id: 'gate:run-gate-statuses:continue',
            decision: 'continue_required',
            summary: '需要继续补产物。',
            artifactCount: 0,
            requiredVerificationCount: 1,
            passedRequiredVerificationCount: 0,
            blockingIssueCount: 1,
            warningIssueCount: 0,
            verificationCoverage: 0,
            issues: [{
              id: 'issue-recoverable',
              code: 'artifact.required.missing',
              severity: 'blocking',
              title: '缺少产物',
              detail: '没有 artifact.produced',
              recoverable: true,
              suggestedRecovery: '继续生成产物。',
            }],
          },
        },
        {
          type: 'run.checkpoint',
          runId: 'run-gate-statuses',
          checkpoint: {
            id: 'completion-gate',
            summary: '完成门禁发现执行结果尚未满足交付条件。',
            reason: '缺少产物验证',
            recoverable: true,
            issues: [{
              id: 'issue-recoverable',
              code: 'artifact.required.missing',
              severity: 'blocking',
              title: '缺少产物',
              detail: '没有 artifact.produced',
              recoverable: true,
              suggestedRecovery: '继续生成产物。',
            }],
          },
        },
      ],
    });

    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'gate-result',
        status: 'blocked',
        detail: expect.stringContaining('decision=continue_required'),
      }),
      expect.objectContaining({
        id: 'gate-issue:issue-recoverable',
        status: 'blocked',
        parentId: 'gate-result',
        detail: expect.stringContaining('code=artifact.required.missing'),
      }),
      expect.objectContaining({
        id: 'checkpoint:completion-gate',
        status: 'blocked',
        detail: expect.stringContaining('checkpoint=completion-gate'),
      }),
    ]));
    expect(steps.find((step) => step.id === 'gate-issue:issue-recoverable')?.detail)
      .toEqual(expect.stringContaining('recovery=继续生成产物。'));
    expect(steps.find((step) => step.id === 'checkpoint:completion-gate')?.detail)
      .toEqual(expect.stringContaining('recoverable=true'));
  });

  it.each([
    ['blocked_needs_user', 'blocked'],
    ['failed', 'failed'],
    ['aborted', 'aborted'],
  ] as const)('maps gate decision %s to task step status %s', (decision, status) => {
    const steps = deriveRuntimeTaskSteps({
      runId: `run-gate-${decision}`,
      status: 'running',
      assistantText: '',
      thinkingText: '',
      events: [
        {
          type: 'gate.evaluated',
          runId: `run-gate-${decision}`,
          gate: {
            id: `gate:run-gate-${decision}`,
            decision,
            artifactCount: 0,
            requiredVerificationCount: 0,
            passedRequiredVerificationCount: 0,
            blockingIssueCount: 0,
            warningIssueCount: 0,
            verificationCoverage: 1,
            issues: [],
          },
        },
      ],
    });

    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'gate-result',
        status,
        detail: expect.stringContaining(`decision=${decision}`),
      }),
    ]));
  });

  it('filters noisy process runtime events from execution graph steps', () => {
    const steps = deriveRuntimeTaskSteps({
      runId: 'run-1',
      status: 'running',
      assistantText: '',
      thinkingText: '',
      events: [
        { type: 'tool.started', runId: 'run-1', sessionKey: 'agent:main:main', toolCallId: 'process-1', name: 'process', args: { action: 'poll' } },
        { type: 'command.output', runId: 'run-1', sessionKey: 'agent:main:main', toolCallId: 'process-1', itemId: 'process-out', name: 'process', title: 'process output', output: '(no new output)', status: 'running', phase: 'update' },
        { type: 'tool.completed', runId: 'run-1', sessionKey: 'agent:main:main', toolCallId: 'read-1', name: 'read', result: { summary: 'Done' }, isError: false },
      ],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'read-1',
        label: 'read',
        status: 'completed',
        kind: 'tool',
      }),
    ]);
  });

  it('summarizes structured tool error payloads instead of exposing raw JSON wrappers', () => {
    const steps = deriveRuntimeTaskSteps({
      runId: 'run-1',
      status: 'running',
      assistantText: '',
      thinkingText: '',
      events: [
        {
          type: 'tool.completed',
          runId: 'run-1',
          sessionKey: 'agent:main:main',
          toolCallId: 'search-1',
          name: 'web_search',
          isError: true,
          result: {
            content: [
              {
                type: 'text',
                text: '{\n  "status": "error",\n  "tool": "web_search",\n  "error": "web_search is disabled or no provider is available."\n}',
              },
            ],
            details: {
              status: 'error',
              tool: 'web_search',
              error: 'web_search is disabled or no provider is available.',
            },
          },
        },
      ],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'search-1',
        label: 'web_search',
        status: 'error',
        kind: 'tool',
        detail: [
          'web_search 当前不可用或没有配置可用 provider。',
          '',
          'web_search is disabled or no provider is available.',
        ].join('\n'),
      }),
    ]);
    expect(steps[0].detail).not.toContain('"content"');
    expect(steps[0].detail).not.toContain('"details"');
  });

  it('builds running steps from streaming tool status without exposing chain-of-thought', () => {
    const streamingTools: ToolStatus[] = [
      {
        name: 'web_search',
        status: 'running',
        updatedAt: Date.now(),
        summary: 'Searching docs',
      },
    ];

    const steps = deriveTaskSteps({
      messages: [],
      streamingMessage: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Compare a few approaches before coding.' },
          { type: 'tool_use', id: 'tool-1', name: 'web_search', input: { query: 'openclaw task list' } },
        ],
      },
      streamingTools,
    });

    expect(steps).toEqual([
      expect.objectContaining({
        label: 'web_search',
        status: 'running',
        kind: 'tool',
      }),
    ]);
  });

  it('keeps completed tool steps visible while a later tool is still streaming', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-history',
          content: [
            { type: 'tool_use', id: 'tool-read', name: 'read', input: { filePath: '/tmp/a.md' } },
          ],
        },
      ],
      streamingMessage: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-grep', name: 'grep', input: { pattern: 'TODO' } },
        ],
      },
      streamingTools: [
        {
          toolCallId: 'tool-grep',
          name: 'grep',
          status: 'running',
          updatedAt: Date.now(),
          summary: 'Scanning files',
        },
      ],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'tool-read',
        label: 'read',
        status: 'completed',
        kind: 'tool',
      }),
      expect.objectContaining({
        id: 'tool-grep',
        label: 'grep',
        status: 'running',
        kind: 'tool',
      }),
    ]);
  });

  it('upgrades a completed historical tool step when streaming status reports a later state', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-history',
          content: [
            { type: 'tool_use', id: 'tool-read', name: 'read', input: { filePath: '/tmp/a.md' } },
          ],
        },
      ],
      streamingMessage: null,
      streamingTools: [
        {
          toolCallId: 'tool-read',
          name: 'read',
          status: 'error',
          updatedAt: Date.now(),
          summary: 'Permission denied',
        },
      ],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'tool-read',
        label: 'read',
        status: 'error',
        kind: 'tool',
        detail: 'Permission denied',
      }),
    ]);
  });

  it('keeps all steps when the execution graph exceeds the previous max length', () => {
    const messages: RawMessage[] = Array.from({ length: 9 }, (_, index) => ({
      role: 'assistant',
      id: `assistant-${index}`,
      content: [
        { type: 'tool_use', id: `tool-${index}`, name: `read_${index}`, input: { filePath: `/tmp/${index}.md` } },
      ],
    }));

    const steps = deriveTaskSteps({
      messages,
      streamingMessage: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-live', name: 'grep_live', input: { pattern: 'TODO' } },
        ],
      },
      streamingTools: [
        {
          toolCallId: 'tool-live',
          name: 'grep_live',
          status: 'running',
          updatedAt: Date.now(),
          summary: 'Scanning current workspace',
        },
      ],
    });

    expect(steps).toHaveLength(10);
    expect(steps[0]).toEqual(expect.objectContaining({
      id: 'tool-0',
      label: 'read_0',
      status: 'completed',
    }));
    expect(steps.at(-1)).toEqual(expect.objectContaining({
      id: 'tool-live',
      label: 'grep_live',
      status: 'running',
    }));
  });

  it('keeps recent completed tool steps from assistant history', () => {
    const messages: RawMessage[] = [
      {
        role: 'assistant',
        id: 'assistant-1',
        content: [
          { type: 'thinking', thinking: 'Reviewing the code path.' },
          { type: 'tool_use', id: 'tool-2', name: 'read_file', input: { path: 'src/App.tsx' } },
        ],
      },
    ];

    const steps = deriveTaskSteps({
      messages,
      streamingMessage: null,
      streamingTools: [],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'tool-2',
        label: 'read_file',
        status: 'completed',
        kind: 'tool',
      }),
    ]);
  });

  it('does not expose streaming chain-of-thought in the execution graph', () => {
    const steps = deriveTaskSteps({
      messages: [],
      streamingMessage: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Reviewing X.' },
          { type: 'thinking', thinking: 'Reviewing X. Comparing Y.' },
          { type: 'thinking', thinking: 'Reviewing X. Comparing Y. Drafting answer.' },
        ],
      },
      streamingTools: [],
    });

    expect(steps).toEqual([]);
  });

  it('skips internal assistant turns and hides NO_REPLY from the execution graph', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Continue the OpenClaw runtime event internally.' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'NO_REPLY' }],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-image', name: 'image_generate', input: { prompt: 'astronaut' } },
          ],
        },
      ],
      streamingMessage: null,
      streamingTools: [],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'tool-image',
        label: 'image_generate',
        kind: 'tool',
      }),
    ]);
  });

  it('keeps earlier reply segments in the graph when the last streaming segment is rendered separately', () => {
    const steps = deriveTaskSteps({
      messages: [],
      streamingMessage: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checked X.' },
          { type: 'text', text: 'Checked X. Checked Snowball.' },
          { type: 'text', text: 'Checked X. Checked Snowball. Here is the summary.' },
        ],
      },
      streamingTools: [],
      omitLastStreamingMessageSegment: true,
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'stream-message-0',
        detail: 'Checked X.',
        status: 'completed',
      }),
      expect.objectContaining({
        id: 'stream-message-1',
        detail: 'Checked Snowball.',
        status: 'completed',
      }),
    ]);
  });

  it('folds earlier reply segments into the graph but leaves the final answer for the chat bubble', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-reply',
          content: [
            { type: 'text', text: 'Checked X.' },
            { type: 'text', text: 'Checked X. Checked Snowball.' },
            { type: 'text', text: 'Checked X. Checked Snowball. Here is the summary.' },
          ],
        },
      ],
      streamingMessage: null,
      streamingTools: [],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'history-message-assistant-reply-0',
        detail: 'Checked X.',
        status: 'completed',
      }),
      expect.objectContaining({
        id: 'history-message-assistant-reply-1',
        detail: 'Checked Snowball.',
        status: 'completed',
      }),
    ]);
    expect(steps.map((step) => step.detail)).not.toContain('Here is the summary.');
  });

  it('strips folded process narration from the final reply text', () => {
    expect(stripProcessMessagePrefix(
      'Checked X. Checked Snowball. Here is the summary.',
      ['Checked X.', 'Checked Snowball.'],
    )).toBe('Here is the summary.');
  });

  it('builds a branch for spawned subagents', () => {
    const messages: RawMessage[] = [
      {
        role: 'assistant',
        id: 'assistant-2',
        content: [
          {
            type: 'tool_use',
            id: 'spawn-1',
            name: 'sessions_spawn',
            input: { agentId: 'coder', task: 'inspect repo' },
          },
          {
            type: 'tool_use',
            id: 'yield-1',
            name: 'sessions_yield',
            input: { message: 'wait coder finishes' },
          },
        ],
      },
    ];

    const steps = deriveTaskSteps({
      messages,
      streamingMessage: null,
      streamingTools: [],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'spawn-1',
        label: 'sessions_spawn',
        depth: 1,
      }),
      expect.objectContaining({
        id: 'spawn-1:branch',
        label: 'coder run',
        depth: 2,
        parentId: 'spawn-1',
      }),
      expect.objectContaining({
        id: 'yield-1',
        label: 'sessions_yield',
        depth: 3,
        parentId: 'spawn-1:branch',
      }),
    ]);
  });

  it('parses internal subagent completion events from injected user messages', () => {
    const info = parseSubagentCompletionInfo({
      role: 'user',
      content: [{
        type: 'text',
        text: `[Internal task completion event]
source: subagent
session_key: agent:coder:subagent:child-123
session_id: child-session-id
status: completed successfully`,
      }],
    } as RawMessage);

    expect(info).toEqual({
      sessionKey: 'agent:coder:subagent:child-123',
      sessionId: 'child-session-id',
      agentId: 'coder',
    });
  });
});

describe('run completion detection', () => {
  it('treats delivered image attachments as a final reply after image generation tools', () => {
    const messages: RawMessage[] = [
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'tool-image',
          name: 'image_generate',
          arguments: { prompt: 'wheat' },
        }],
      },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'tool-message',
          name: 'message',
          arguments: {
            action: 'send',
            attachments: [{ path: '/tmp/wheat.png' }],
          },
        }],
      },
      {
        role: 'assistant',
        content: [{
          type: 'image',
          url: '/api/chat/media/outgoing/agent%3Amain%3As-1/image-1/full',
          mimeType: 'image/png',
          alt: 'wheat.png',
        }],
        _attachedFiles: [{
          fileName: 'wheat.png',
          mimeType: 'image/png',
          fileSize: 42,
          preview: 'data:image/png;base64,ok',
          gatewayUrl: '/api/chat/media/outgoing/agent%3Amain%3As-1/image-1/full',
          source: 'gateway-media',
        }],
      },
    ];

    expect(segmentHasFinalReply(messages)).toBe(true);
    expect(findReplyMessageIndex(messages, false)).toBe(2);
  });
});
