export const CHAT_RUNTIME_CONTRACT_VERSION = 1;

export type ChatRuntimeEventProducer =
  | 'gateway'
  | 'renderer'
  | 'openclaw'
  | 'plugin'
  | 'media'
  | 'history'
  | 'gate'
  | string;

export type ChatRuntimeEventBase = {
  contractVersion?: typeof CHAT_RUNTIME_CONTRACT_VERSION;
  producer?: ChatRuntimeEventProducer;
  runId: string;
  sessionKey?: string;
  seq?: number;
  ts?: number;
};

export type ChatRuntimeStepStatus = 'pending' | 'running' | 'completed' | 'error' | 'blocked' | 'skipped';

export type ChatRuntimePlanStep = {
  id: string;
  title: string;
  status?: ChatRuntimeStepStatus;
  detail?: string;
  durationMs?: number;
  kind?: string;
  order?: number;
  parentId?: string;
  requiresArtifact?: boolean;
  requiredArtifact?: boolean;
  artifactRequired?: boolean;
  outputArtifactRequired?: boolean;
};

export type ChatRuntimeArtifact = {
  id: string;
  kind?: string;
  title?: string;
  filePath?: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
  stepId?: string;
  sourceToolCallId?: string;
  source?: string;
};

export type ChatRuntimeVerificationStatus = 'passed' | 'failed' | 'blocked' | 'skipped';
export type ChatRuntimeVerificationKind =
  | 'artifact.availability'
  | 'artifact.integrity'
  | 'command.exit'
  | 'lint'
  | 'typecheck'
  | 'test'
  | 'build'
  | 'ui.visual'
  | 'media.metadata'
  | 'runtime.gate'
  | 'manual'
  | string;
export type ChatRuntimeIssueSeverity = 'info' | 'warning' | 'blocking';

export type ChatRuntimeGateIssue = {
  id: string;
  code: string;
  severity: ChatRuntimeIssueSeverity;
  title: string;
  detail?: string;
  targetId?: string;
  artifactId?: string;
  stepId?: string;
  verificationId?: string;
  recoverable?: boolean;
  suggestedRecovery?: string;
};

export type ChatRuntimeVerification = {
  id: string;
  status: ChatRuntimeVerificationStatus;
  kind?: ChatRuntimeVerificationKind;
  required?: boolean;
  severity?: ChatRuntimeIssueSeverity;
  title?: string;
  detail?: string;
  targetId?: string;
  artifactId?: string;
  evidence?: string;
  source?: string;
};

export type ChatRuntimeCheckpoint = {
  id: string;
  summary: string;
  reason?: string;
  recoverable?: boolean;
  issues?: ChatRuntimeGateIssue[];
};

export type ChatRuntimeGateDecision =
  | 'deliverable'
  | 'continue_required'
  | 'blocked_needs_user'
  | 'failed'
  | 'aborted';

export type ChatRuntimeGateEvaluation = {
  id: string;
  decision: ChatRuntimeGateDecision;
  summary?: string;
  artifactCount: number;
  requiredVerificationCount: number;
  passedRequiredVerificationCount: number;
  blockingIssueCount: number;
  warningIssueCount: number;
  verificationCoverage: number;
  issues: ChatRuntimeGateIssue[];
};

export type ChatRuntimeEvent =
  | (ChatRuntimeEventBase & {
      type: 'run.started';
      startedAt?: number;
      objective?: string;
    })
  | (ChatRuntimeEventBase & {
      type: 'run.plan.updated';
      objective?: string;
      summary?: string;
      steps: ChatRuntimePlanStep[];
    })
  | (ChatRuntimeEventBase & {
      type: 'run.step.updated';
      step: ChatRuntimePlanStep;
    })
  | (ChatRuntimeEventBase & {
      type: 'run.ended';
      status: 'completed' | 'error' | 'aborted';
      endedAt?: number;
      error?: string;
      livenessState?: string;
      replayInvalid?: boolean;
      stopReason?: string;
    })
  | (ChatRuntimeEventBase & {
      type: 'assistant.delta';
      text?: string;
      delta?: string;
      replace?: boolean;
      phase?: string;
      mediaUrls?: string[];
    })
  | (ChatRuntimeEventBase & {
      type: 'thinking.delta';
      text?: string;
      delta?: string;
    })
  | (ChatRuntimeEventBase & {
      type: 'tool.started';
      toolCallId: string;
      name: string;
      args?: unknown;
    })
  | (ChatRuntimeEventBase & {
      type: 'tool.updated';
      toolCallId: string;
      name: string;
      partialResult?: unknown;
    })
  | (ChatRuntimeEventBase & {
      type: 'tool.completed';
      toolCallId: string;
      name: string;
      result?: unknown;
      meta?: unknown;
      durationMs?: number;
      isError?: boolean;
    })
  | (ChatRuntimeEventBase & {
      type: 'artifact.produced';
      artifact: ChatRuntimeArtifact;
      toolCallId?: string;
      itemId?: string;
    })
  | (ChatRuntimeEventBase & {
      type: 'verification.completed';
      verification: ChatRuntimeVerification;
      toolCallId?: string;
      itemId?: string;
    })
  | (ChatRuntimeEventBase & {
      type: 'gate.issue';
      issue: ChatRuntimeGateIssue;
    })
  | (ChatRuntimeEventBase & {
      type: 'run.checkpoint';
      checkpoint: ChatRuntimeCheckpoint;
    })
  | (ChatRuntimeEventBase & {
      type: 'gate.evaluated';
      gate: ChatRuntimeGateEvaluation;
    })
  | (ChatRuntimeEventBase & {
      type: 'command.output';
      itemId?: string;
      toolCallId?: string;
      name?: string;
      title?: string;
      output?: string;
      status?: string;
      phase?: string;
      exitCode?: number;
      durationMs?: number;
      cwd?: string;
    })
  | (ChatRuntimeEventBase & {
      type: 'patch.completed';
      itemId?: string;
      toolCallId?: string;
      name?: string;
      title?: string;
      summary?: string;
      added?: number;
      modified?: number;
      deleted?: number;
    })
  | (ChatRuntimeEventBase & {
      type: 'approval.updated';
      itemId?: string;
      toolCallId?: string;
      title?: string;
      kind?: string;
      phase?: string;
      status?: string;
      message?: string;
    });
