import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchJsonRpcNotification, dispatchProtocolEvent } from '@electron/gateway/event-dispatch';
import { logger } from '@electron/utils/logger';

function createMockEmitter() {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    emit: vi.fn((event: string, payload: unknown) => {
      emitted.push({ event, payload });
      return true;
    }),
    emitted,
  };
}

describe('dispatchProtocolEvent', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  it('dispatches gateway.ready event to gateway:ready', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'gateway.ready', { version: '4.11' });
    expect(emitter.emit).toHaveBeenCalledWith('gateway:ready', { version: '4.11' });
  });

  it('dispatches ready event to gateway:ready', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'ready', { skills: 31 });
    expect(emitter.emit).toHaveBeenCalledWith('gateway:ready', { skills: 31 });
  });

  it('dispatches channel.status to channel:status', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'channel.status', { channelId: 'telegram', status: 'connected' });
    expect(emitter.emit).toHaveBeenCalledWith('channel:status', { channelId: 'telegram', status: 'connected' });
  });

  it('dispatches native health and presence events separately from generic notifications', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'health', { ok: true });
    dispatchProtocolEvent(emitter, 'presence', [{ mode: 'gateway', ts: 1 }]);

    expect(emitter.emit).toHaveBeenCalledWith('gateway:health', { ok: true });
    expect(emitter.emit).toHaveBeenCalledWith('gateway:presence', [{ mode: 'gateway', ts: 1 }]);
    expect(emitter.emit).not.toHaveBeenCalledWith('notification', expect.objectContaining({ method: 'health' }));
    expect(emitter.emit).not.toHaveBeenCalledWith('notification', expect.objectContaining({ method: 'presence' }));
  });

  it('dispatches chat to chat:message', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'chat', { text: 'hello' });
    expect(emitter.emit).toHaveBeenCalledWith('chat:message', { message: { text: 'hello' } });
  });

  it('does not normalize non-terminal lifecycle phase=end as run.ended', () => {
    const emitter = createMockEmitter();
    const payload = {
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      stream: 'lifecycle',
      seq: 4,
      ts: 10,
      data: {
        phase: 'end',
        endedAt: 11,
      },
    };

    dispatchProtocolEvent(emitter, 'agent', payload);

    expect(emitter.emit).not.toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'run.ended',
      runId: 'run-1',
    }));
    expect(emitter.emit).toHaveBeenCalledWith('notification', {
      method: 'agent',
      params: payload,
    });
  });

  it('normalizes terminal lifecycle phases as run.ended', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      stream: 'lifecycle',
      seq: 5,
      ts: 12,
      data: {
        phase: 'completed',
        endedAt: 13,
      },
    });

    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'run.ended',
      contractVersion: 1,
      producer: 'gateway',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      seq: 5,
      ts: 12,
      status: 'completed',
      endedAt: 13,
      livenessState: undefined,
      replayInvalid: undefined,
      stopReason: undefined,
    }));
  });

  it('dispatches normalized agent runtime events alongside the legacy notification path', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      stream: 'tool',
      seq: 3,
      ts: 10,
      data: {
        phase: 'start',
        name: 'read',
        toolCallId: 'call-1',
        args: { filePath: '/tmp/demo.md' },
      },
    });

    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'tool.started',
      contractVersion: 1,
      producer: 'gateway',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      seq: 3,
      ts: 10,
      toolCallId: 'call-1',
      name: 'read',
      args: { filePath: '/tmp/demo.md' },
    }));
    expect(emitter.emit).toHaveBeenCalledWith('notification', {
      method: 'agent',
      params: expect.objectContaining({ runId: 'run-1', stream: 'tool' }),
    });
  });

  it('normalizes run contract events for plan, artifacts, and verification', () => {
    const emitter = createMockEmitter();

    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-contract',
      sessionKey: 'agent:main:main',
      stream: 'plan',
      seq: 11,
      ts: 100,
      data: {
        objective: '生成并验证报告',
        summary: '先生成，再检查',
        steps: [
          { id: 'write', title: '生成报告', status: 'running', order: 1 },
        ],
      },
    });
    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-contract',
      sessionKey: 'agent:main:main',
      stream: 'artifact',
      seq: 12,
      ts: 101,
      data: {
        artifact: {
          id: 'report',
          kind: 'document',
          title: '报告',
          filePath: '/tmp/report.docx',
          stepId: 'write',
        },
        toolCallId: 'tool-create',
      },
    });
    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-contract',
      sessionKey: 'agent:main:main',
      stream: 'verification',
      seq: 13,
      ts: 102,
      data: {
        id: 'verify-report',
        status: 'passed',
        artifactId: 'report',
        title: '文件存在',
        evidence: 'stat ok',
      },
    });
    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-contract',
      sessionKey: 'agent:main:main',
      stream: 'checkpoint',
      seq: 14,
      ts: 103,
      data: {
        checkpointId: 'cp-1',
        summary: '报告已生成，准备最终回复',
        reason: 'final-review',
        recoverable: true,
      },
    });

    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'run.plan.updated',
      contractVersion: 1,
      producer: 'gateway',
      runId: 'run-contract',
      sessionKey: 'agent:main:main',
      seq: 11,
      ts: 100,
      objective: '生成并验证报告',
      summary: '先生成，再检查',
      steps: [
        {
          id: 'write',
          title: '生成报告',
          status: 'running',
          detail: undefined,
          kind: undefined,
          order: 1,
          parentId: undefined,
        },
      ],
    }));
    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'artifact.produced',
      contractVersion: 1,
      producer: 'gateway',
      runId: 'run-contract',
      sessionKey: 'agent:main:main',
      seq: 12,
      ts: 101,
      artifact: {
        id: 'report',
        kind: 'document',
        title: '报告',
        filePath: '/tmp/report.docx',
        url: undefined,
        mimeType: undefined,
        sizeBytes: undefined,
        stepId: 'write',
        sourceToolCallId: undefined,
        source: undefined,
      },
      toolCallId: 'tool-create',
      itemId: undefined,
    }));
    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'verification.completed',
      contractVersion: 1,
      producer: 'gateway',
      runId: 'run-contract',
      sessionKey: 'agent:main:main',
      seq: 13,
      ts: 102,
      verification: expect.objectContaining({
        id: 'verify-report',
        status: 'passed',
        title: '文件存在',
        artifactId: 'report',
        evidence: 'stat ok',
      }),
      toolCallId: undefined,
      itemId: undefined,
    }));
    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'run.checkpoint',
      contractVersion: 1,
      producer: 'gateway',
      runId: 'run-contract',
      sessionKey: 'agent:main:main',
      seq: 14,
      ts: 103,
      checkpoint: expect.objectContaining({
        id: 'cp-1',
        summary: '报告已生成，准备最终回复',
        reason: 'final-review',
        recoverable: true,
      }),
    }));
  });

  it('does not default missing or invalid verification status to passed', () => {
    const emitter = createMockEmitter();

    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-verification',
      sessionKey: 'agent:main:main',
      stream: 'verification',
      seq: 1,
      data: {
        id: 'verify-missing-status',
        artifactId: 'artifact-1',
        title: '缺少状态',
      },
    });
    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-verification',
      sessionKey: 'agent:main:main',
      stream: 'verification',
      seq: 2,
      data: {
        id: 'verify-invalid-status',
        status: 'ok',
        artifactId: 'artifact-1',
        title: '非法状态',
      },
    });

    expect(emitter.emit).not.toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'verification.completed',
    }));
  });

  it('produces verification contract events from terminal command outputs', () => {
    const emitter = createMockEmitter();

    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-command-verification',
      sessionKey: 'agent:main:main',
      stream: 'command_output',
      seq: 21,
      ts: 200,
      data: {
        itemId: 'cmd-typecheck',
        toolCallId: 'call-typecheck',
        name: 'exec_command',
        title: 'pnpm run typecheck',
        output: 'tsc --noEmit completed',
        phase: 'end',
        exitCode: 0,
        durationMs: 1200,
      },
    });

    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'command.output',
      runId: 'run-command-verification',
      itemId: 'cmd-typecheck',
      exitCode: 0,
    }));
    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'verification.completed',
      contractVersion: 1,
      producer: 'gateway',
      runId: 'run-command-verification',
      sessionKey: 'agent:main:main',
      toolCallId: 'call-typecheck',
      itemId: 'cmd-typecheck',
      verification: expect.objectContaining({
        id: 'verification:cmd-typecheck',
        status: 'passed',
        kind: 'typecheck',
        required: true,
        title: 'pnpm run typecheck',
        targetId: 'cmd-typecheck',
        evidence: 'exitCode=0',
        source: 'command.output',
      }),
    }));
  });

  it('produces blocking gate issues from failed terminal command outputs', () => {
    const emitter = createMockEmitter();

    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-command-failed',
      sessionKey: 'agent:main:main',
      stream: 'command_output',
      seq: 22,
      ts: 210,
      data: {
        itemId: 'cmd-test',
        toolCallId: 'call-test',
        name: 'exec_command',
        title: 'pnpm test',
        output: '1 failed',
        phase: 'end',
        exitCode: 1,
      },
    });

    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'verification.completed',
      runId: 'run-command-failed',
      verification: expect.objectContaining({
        id: 'verification:cmd-test',
        status: 'failed',
        kind: 'test',
        severity: 'blocking',
        title: 'pnpm test',
      }),
    }));
    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'gate.issue',
      runId: 'run-command-failed',
      issue: expect.objectContaining({
        id: 'issue:verification:cmd-test',
        code: 'verification.command.failed',
        severity: 'blocking',
        title: 'pnpm test 验证未通过',
        targetId: 'cmd-test',
        stepId: 'call-test',
        verificationId: 'verification:cmd-test',
        recoverable: true,
      }),
    }));
  });

  it('classifies build command results as build verifications', () => {
    const emitter = createMockEmitter();

    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-build-verification',
      sessionKey: 'agent:main:main',
      stream: 'command_output',
      seq: 23,
      data: {
        itemId: 'cmd-build',
        name: 'exec_command',
        title: 'pnpm run build',
        status: 'completed',
        phase: 'completed',
      },
    });

    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'verification.completed',
      runId: 'run-build-verification',
      verification: expect.objectContaining({
        id: 'verification:cmd-build',
        status: 'passed',
        kind: 'build',
        title: 'pnpm run build',
      }),
    }));
  });

  it('normalizes artifact aliases and gate events from gateway payloads', () => {
    const emitter = createMockEmitter();

    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-gate',
      sessionKey: 'agent:main:main',
      stream: 'artifact',
      producer: 'uclaw-artifact-guard',
      seq: 1,
      data: {
        artifact: {
          id: 'artifact-output',
          kind: 'document',
          title: '输出文档',
          outputPath: '/tmp/output.docx',
          source: 'uclaw-artifact-guard',
          toolCallId: 'call-write',
        },
      },
    });
    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-gate',
      sessionKey: 'agent:main:main',
      stream: 'issue',
      producer: 'gate',
      seq: 2,
      data: {
        issue: {
          id: 'issue-1',
          code: 'tool.failed',
          severity: 'blocking',
          title: '工具失败',
          targetId: 'call-write',
          recoverable: true,
        },
      },
    });
    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-gate',
      sessionKey: 'agent:main:main',
      stream: 'gate',
      producer: 'gate',
      seq: 3,
      data: {
        id: 'gate:run-gate:completion',
        decision: 'continue_required',
        artifactCount: 1,
        requiredVerificationCount: 1,
        passedRequiredVerificationCount: 0,
        blockingIssueCount: 1,
        warningIssueCount: 0,
        verificationCoverage: 0,
        issues: [{
          id: 'issue-1',
          code: 'tool.failed',
          severity: 'blocking',
          title: '工具失败',
          targetId: 'call-write',
          recoverable: true,
        }],
      },
    });

    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'artifact.produced',
      producer: 'uclaw-artifact-guard',
      artifact: expect.objectContaining({
        id: 'artifact-output',
        filePath: '/tmp/output.docx',
        source: 'uclaw-artifact-guard',
        sourceToolCallId: 'call-write',
      }),
    }));
    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'gate.issue',
      producer: 'gate',
      issue: expect.objectContaining({
        id: 'issue-1',
        code: 'tool.failed',
        severity: 'blocking',
      }),
    }));
    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'gate.evaluated',
      producer: 'gate',
      gate: expect.objectContaining({
        id: 'gate:run-gate:completion',
        decision: 'continue_required',
        artifactCount: 1,
        requiredVerificationCount: 1,
        passedRequiredVerificationCount: 0,
        blockingIssueCount: 1,
        verificationCoverage: 0,
      }),
    }));
  });

  it('normalizes agent events from JSON-RPC notifications', () => {
    const emitter = createMockEmitter();

    dispatchJsonRpcNotification(emitter, {
      jsonrpc: '2.0',
      method: 'agent',
      params: {
        runId: 'run-json-rpc',
        sessionKey: 'agent:main:main',
        stream: 'gate.evaluated',
        producer: 'gate',
        data: {
          id: 'gate:run-json-rpc:completion',
          decision: 'deliverable',
          artifactCount: 0,
          requiredVerificationCount: 0,
          passedRequiredVerificationCount: 0,
          blockingIssueCount: 0,
          warningIssueCount: 0,
          verificationCoverage: 1,
          issues: [],
        },
      },
    });

    expect(emitter.emit).toHaveBeenCalledWith('notification', expect.objectContaining({
      method: 'agent',
    }));
    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'gate.evaluated',
      runId: 'run-json-rpc',
      gate: expect.objectContaining({
        decision: 'deliverable',
      }),
    }));
  });

  it('normalizes semantic runtime protocol event names', () => {
    const emitter = createMockEmitter();

    dispatchProtocolEvent(emitter, 'chat.runtime_event', {
      runId: 'run-semantic-protocol',
      sessionKey: 'agent:main:main',
      stream: 'gate.evaluated',
      producer: 'gate',
      data: {
        id: 'gate:run-semantic-protocol:completion',
        decision: 'deliverable',
        artifactCount: 0,
        requiredVerificationCount: 0,
        passedRequiredVerificationCount: 0,
        blockingIssueCount: 0,
        warningIssueCount: 0,
        verificationCoverage: 1,
        issues: [],
      },
    });

    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'gate.evaluated',
      runId: 'run-semantic-protocol',
      gate: expect.objectContaining({ decision: 'deliverable' }),
    }));
    expect(emitter.emit).toHaveBeenCalledWith('notification', expect.objectContaining({
      method: 'chat.runtime_event',
    }));
  });

  it('normalizes semantic runtime JSON-RPC method names', () => {
    const emitter = createMockEmitter();

    dispatchJsonRpcNotification(emitter, {
      jsonrpc: '2.0',
      method: 'agent.runtime',
      params: {
        runId: 'run-semantic-rpc',
        sessionKey: 'agent:main:main',
        stream: 'issue',
        producer: 'gate',
        data: {
          id: 'issue-semantic',
          code: 'runtime.test',
          severity: 'blocking',
          title: '语义事件名测试',
          recoverable: true,
        },
      },
    });

    expect(emitter.emit).toHaveBeenCalledWith('notification', expect.objectContaining({
      method: 'agent.runtime',
    }));
    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'gate.issue',
      runId: 'run-semantic-rpc',
      issue: expect.objectContaining({
        id: 'issue-semantic',
        code: 'runtime.test',
      }),
    }));
  });

  it('logs normalized runtime event summaries without assistant text deltas', () => {
    const emitter = createMockEmitter();

    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-log-tool',
      sessionKey: 'agent:main:main',
      stream: 'tool',
      seq: 7,
      ts: 10,
      data: {
        phase: 'start',
        name: 'exec_command',
        toolCallId: 'call-log-tool',
        args: { cmd: 'full user prompt should not be logged here' },
      },
    });

    expect(logger.info).toHaveBeenCalledWith('[metric] chat.runtime.event', {
      type: 'tool.started',
      contractVersion: 1,
      producer: 'gateway',
      runId: 'run-log-tool',
      sessionKey: 'agent:main:main',
      seq: 7,
      toolCallId: 'call-log-tool',
      name: 'exec_command',
      isError: undefined,
    });

    vi.mocked(logger.info).mockClear();
    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-log-assistant',
      sessionKey: 'agent:main:main',
      stream: 'assistant',
      seq: 8,
      ts: 11,
      data: {
        delta: '这段 assistant 增量不应该进入诊断摘要',
      },
    });

    expect(logger.info).not.toHaveBeenCalled();
  });

  it('suppresses tick events', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'tick', {});
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('dispatches unknown events as notifications', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'some.custom.event', { data: 1 });
    expect(emitter.emit).toHaveBeenCalledWith('notification', { method: 'some.custom.event', params: { data: 1 } });
  });
});
