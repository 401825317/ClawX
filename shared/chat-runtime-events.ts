export const CHAT_RUNTIME_CONTRACT_VERSION = 1;
export const CHAT_SYNTHETIC_TERMINAL_PRODUCER = 'gateway-chat-terminal';

export type ChatRuntimeEventProducer =
  | 'gateway'
  | 'renderer'
  | 'openclaw'
  | 'plugin'
  | 'media'
  | 'history'
  | string;

export type ChatRuntimeEventBase = {
  contractVersion?: typeof CHAT_RUNTIME_CONTRACT_VERSION;
  producer?: ChatRuntimeEventProducer;
  runId: string;
  sessionKey?: string;
  /** Stable OpenClaw background-task identity when this event belongs to a detached task. */
  taskId?: string;
  /** Optional parent task for native task-flow and subagent projections. */
  parentTaskId?: string;
  /** Native task lifecycle state when OpenClaw emits a detached-task projection. */
  taskStatus?: ChatRuntimeTaskStatus;
  seq?: number;
  ts?: number;
};

/**
 * UClaw's closed projection of OpenClaw task-ledger states. The original
 * OpenClaw status is retained on `sourceStatus`; consumers should use this
 * lifecycle for UI behavior instead of interpreting completion prose.
 */
export type ChatRuntimeTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'error'
  | 'waiting_approval'
  | 'partial';

export type ChatRuntimeTaskProjection = {
  taskId: string;
  parentTaskId?: string;
  flowId?: string;
  kind?: string;
  runtime?: string;
  title: string;
  detail?: string;
  agentId?: string;
  sessionKey?: string;
  childSessionKey?: string;
  status: ChatRuntimeTaskStatus;
  sourceStatus?: string;
  /** Provider/tool execution state, independent from artifact and delivery. */
  executionStatus?: string;
  /** Whether a durable output artifact is available, missing, or unverified. */
  artifactStatus?: string;
  deliveryStatus?: string;
  terminalOutcome?: string;
  createdAt?: number;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
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
  taskId?: string;
  toolCallId?: string;
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
  taskId?: string;
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
  | 'manual'
  | string;
export type ChatRuntimeIssueSeverity = 'info' | 'warning' | 'blocking';

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
  taskId?: string;
  evidence?: string;
  source?: string;
};

export type ChatRuntimeProgressEntryKind = 'commentary' | 'action' | 'status';
export type ChatRuntimeProgressEntryStatus = 'running' | 'completed' | 'blocked' | 'error' | 'aborted';

export type ChatRuntimeProgressEntry = {
  id: string;
  kind: ChatRuntimeProgressEntryKind;
  text: string;
  status?: ChatRuntimeProgressEntryStatus;
  translationKey?: string;
  translationParams?: Record<string, string | number>;
  toolName?: string;
  toolLabel?: string;
  command?: string;
  detail?: string;
  dedupeKey?: string;
  toolCallId?: string;
  stepId?: string;
  taskId?: string;
  source?: 'native' | 'derived' | 'history' | string;
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
      type: 'task.updated';
      task: ChatRuntimeTaskProjection;
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
      type: 'progress.update';
      entry: ChatRuntimeProgressEntry;
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
