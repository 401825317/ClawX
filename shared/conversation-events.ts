import type {
  ChatRuntimeArtifact,
  ChatRuntimeApprovalDecision,
  ChatRuntimeApprovalKind,
  ChatRuntimeApprovalResolutionSource,
  ChatRuntimeEvent,
  ChatRuntimePlanStep,
  ChatRuntimeProgressEntry,
  ChatRuntimeTaskProjection,
  ChatRuntimeTimelineVisibility,
  ChatRuntimeVerification,
} from './chat-runtime-events';

export const CONVERSATION_EVENT_CONTRACT_VERSION = 1 as const;

export type ConversationEventSource =
  | 'openclaw-chat'
  | 'openclaw-runtime'
  | 'task-ledger'
  | 'history'
  | 'plugin'
  | 'host'
  | 'derived'
  | 'synthetic';

export type ConversationEventAuthority = 'authoritative' | 'corroborating' | 'inferred';

export type ConversationEventType =
  | 'turn.requested'
  | 'run.started'
  | 'run.ended'
  | 'assistant.content'
  | 'thinking.content'
  | 'commentary.append'
  | 'progress.updated'
  | 'tool.started'
  | 'tool.updated'
  | 'tool.completed'
  | 'task.updated'
  | 'plan.updated'
  | 'step.updated'
  | 'approval.updated'
  | 'artifact.updated'
  | 'verification.updated'
  | 'final.message'
  | 'turn.error'
  | 'history.checkpoint'
  | 'session.activity';

export type ConversationMessageSnapshot = {
  role: 'user' | 'assistant' | 'system' | 'toolresult';
  content: unknown;
  timestamp?: number;
  id?: string;
  idempotencyKey?: string;
  attachments?: Array<{
    fileName: string;
    mimeType: string;
    fileSize: number;
    preview: string | null;
    previewStatus?: 'unavailable';
    width?: number;
    height?: number;
    durationSeconds?: number;
    hasAudio?: boolean;
    filePath?: string;
    gatewayUrl?: string;
    source?: 'user-upload' | 'tool-result' | 'message-ref' | 'gateway-media';
    disposition?: 'input-reference' | 'output-delivery' | 'intermediate';
  }>;
};

export type ConversationFileChange = {
  filePath: string;
  fileName: string;
  ext: string;
  mimeType: string;
  contentType: 'snapshot' | 'code' | 'document' | 'video' | 'audio' | 'model3d' | 'other';
  size?: number;
  action: 'created' | 'modified';
  fullContent?: string;
  edits?: Array<{ old: string; new: string }>;
  baseline?:
    | { status: 'ok'; content: string }
    | { status: 'missing' }
    | { status: 'unavailable'; reason: string };
  lastSeenIndex: number;
};

export type ConversationEventData =
  | {
      message: ConversationMessageSnapshot;
      mode?: 'chat' | 'image' | 'video';
      /** Deferred local requests are visible queued Turns without owning the active run slot yet. */
      activate?: boolean;
    }
  | { startedAt?: number; objective?: string }
  | {
      status: 'completed' | 'error' | 'aborted';
      endedAt?: number;
      error?: string;
      stopReason?: string;
      backendIdle?: boolean;
    }
  | { text?: string; delta?: string; replace?: boolean; phase?: string; mediaUrls?: string[] }
  | { entry: ChatRuntimeProgressEntry }
  | { toolCallId: string; name: string; args?: unknown; partialResult?: unknown; result?: unknown; meta?: unknown; durationMs?: number; isError?: boolean }
  | { task: ChatRuntimeTaskProjection }
  | { objective?: string; summary?: string; steps: ChatRuntimePlanStep[] }
  | { step: ChatRuntimePlanStep }
  | {
      approvalId?: string;
      approvalKind?: ChatRuntimeApprovalKind;
      allowedDecisions?: ChatRuntimeApprovalDecision[];
      decision?: ChatRuntimeApprovalDecision;
      requestedAt?: number;
      expiresAt?: number;
      request?: unknown;
      actionable?: boolean;
      resolutionSource?: ChatRuntimeApprovalResolutionSource;
      itemId?: string;
      title?: string;
      kind?: string;
      phase?: string;
      status?: string;
      message?: string;
    }
  | { artifact: ChatRuntimeArtifact; itemId?: string; change?: ConversationFileChange }
  | { verification: ChatRuntimeVerification; itemId?: string }
  | { error: string; recoverable?: boolean }
  | { messageCount: number; throughMessageId?: string; transcriptMtime?: number; reason: 'initial-load' | 'terminal-refresh' | 'manual-refresh' }
  | { active: boolean };

export type ConversationEvent<TData extends ConversationEventData = ConversationEventData> = {
  version: typeof CONVERSATION_EVENT_CONTRACT_VERSION;
  eventId: string;
  type: ConversationEventType;
  source: ConversationEventSource;
  authority: ConversationEventAuthority;
  sessionKey: string;
  turnId?: string;
  rootRunId?: string;
  runId?: string;
  messageId?: string;
  taskId?: string;
  parentTaskId?: string;
  toolCallId?: string;
  timelineVisibility?: ChatRuntimeTimelineVisibility;
  seq?: number;
  occurredAt: number;
  receivedAt: number;
  replayed: boolean;
  data: TData;
};

export type ConversationEventEnvelope = {
  event: ConversationEvent;
  legacyRuntimeEvent?: ChatRuntimeEvent;
};
