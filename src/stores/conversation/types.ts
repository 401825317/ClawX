import type {
  ChatRuntimeArtifact,
  ChatRuntimeApprovalDecision,
  ChatRuntimeApprovalKind,
  ChatRuntimeApprovalResolutionSource,
  ChatRuntimePlanStep,
  ChatRuntimeTaskProjection,
  ChatRuntimeVerification,
} from '../../../shared/chat-runtime-events';
import type { ConversationEvent, ConversationFileChange, ConversationMessageSnapshot } from '../../../shared/conversation-events';
import type { ConversationEventAuthority, ConversationEventSource } from '../../../shared/conversation-events';
export type { ConversationTimelineMode } from '../../../shared/conversation-rollout';

export type TurnStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_background'
  | 'settling'
  | 'completed'
  | 'partial'
  | 'error'
  | 'aborted';

/** Whether a canonical Turn still owns interactive work for its session. */
export function isActiveTurnStatus(status: TurnStatus | undefined): boolean {
  return status === 'queued'
    || status === 'running'
    || status === 'waiting_approval'
    || status === 'waiting_background'
    || status === 'settling';
}

export type TimelineItemStatus = 'pending' | 'running' | 'completed' | 'error' | 'blocked';
export type ToolCategory = 'read' | 'search' | 'command' | 'edit' | 'browser' | 'media' | 'subagent' | 'generic';
export type TimelineItemKind =
  | 'user-message'
  | 'commentary'
  | 'thinking'
  | 'tool-group'
  | 'subtask'
  | 'plan'
  | 'approval'
  | 'artifact-group'
  | 'verification-summary'
  | 'final-answer'
  | 'error'
  | 'system-notice';

export type TimelineItemBase = {
  id: string;
  turnId: string;
  kind: TimelineItemKind;
  status: TimelineItemStatus;
  firstSeenAt: number;
  updatedAt: number;
  sourceEventIds: string[];
  revision: number;
};

export type UserMessageItem = TimelineItemBase & {
  kind: 'user-message';
  message: ConversationMessageSnapshot;
};

export type CommentaryItem = TimelineItemBase & {
  kind: 'commentary';
  text: string;
  sealed: boolean;
  origin: 'assistant' | 'progress';
};

export type ThinkingItem = TimelineItemBase & {
  kind: 'thinking';
  text: string;
  sealed: boolean;
};

export type ToolEntry = {
  toolCallId: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  durationMs?: number;
  startedAt: number;
  updatedAt: number;
  taskId?: string;
  parentTaskId?: string;
};

export type ToolGroupItem = TimelineItemBase & {
  kind: 'tool-group';
  category: ToolCategory;
  summaryKey: string;
  summaryParams: Record<string, string | number>;
  toolCallIds: string[];
  entries: ToolEntry[];
};

export type SubtaskItem = TimelineItemBase & {
  kind: 'subtask';
  parentTaskId?: string;
  taskIds: string[];
  tasks: ChatRuntimeTaskProjection[];
  summaryKey: string;
  summaryParams: Record<string, string | number>;
};

export type PlanItem = TimelineItemBase & {
  kind: 'plan';
  objective?: string;
  summary?: string;
  steps: ChatRuntimePlanStep[];
};

export type ApprovalItem = TimelineItemBase & {
  kind: 'approval';
  approvalId?: string;
  approvalKind?: ChatRuntimeApprovalKind;
  allowedDecisions: ChatRuntimeApprovalDecision[];
  decision?: ChatRuntimeApprovalDecision;
  requestedAt?: number;
  expiresAt?: number;
  request?: unknown;
  actionable: boolean;
  resolutionSource?: ChatRuntimeApprovalResolutionSource;
  itemId?: string;
  title?: string;
  legacyKind?: string;
  phase?: string;
  approvalStatus?: string;
  message?: string;
  taskId?: string;
  authority: ConversationEventAuthority;
  source: ConversationEventSource;
};

export type ArtifactGroupItem = TimelineItemBase & {
  kind: 'artifact-group';
  artifacts: ChatRuntimeArtifact[];
  changes: ConversationFileChange[];
};

export type VerificationSummaryItem = TimelineItemBase & {
  kind: 'verification-summary';
  verifications: ChatRuntimeVerification[];
};

export type FinalAnswerItem = TimelineItemBase & {
  kind: 'final-answer';
  message: ConversationMessageSnapshot;
  authoritative: boolean;
};

export type ErrorItem = TimelineItemBase & {
  kind: 'error';
  message: string;
  recoverable: boolean;
};

export type SystemNoticeItem = TimelineItemBase & {
  kind: 'system-notice';
  message: string;
};

export type TimelineItem =
  | UserMessageItem
  | CommentaryItem
  | ThinkingItem
  | ToolGroupItem
  | SubtaskItem
  | PlanItem
  | ApprovalItem
  | ArtifactGroupItem
  | VerificationSummaryItem
  | FinalAnswerItem
  | ErrorItem
  | SystemNoticeItem;

export type TurnEvidence = {
  runTerminal?: 'completed' | 'error' | 'aborted';
  runTerminalAuthority?: ConversationEventAuthority;
  runTerminalSource?: ConversationEventSource;
  runTerminalMerge?: ConversationMergeEvidence;
  backendIdle: boolean;
  finalMessagePresent: boolean;
  pendingToolCount: number;
  pendingTaskCount: number;
  pendingApprovalCount: number;
  terminalPendingTaskIds: string[];
  requiredArtifactsSatisfied: boolean;
  blockingVerificationFailed: boolean;
  historyCheckpointed: boolean;
};

export type TaskMergeEvidence = {
  authority: ConversationEventAuthority;
  source: ConversationEventSource;
  occurredAt: number;
  updatedAt: number;
};

export type ConversationMergeDomain =
  | 'run'
  | 'run-fallback'
  | 'approval'
  | 'tool'
  | 'artifact'
  | 'verification'
  | 'final';

export type ConversationMergeEvidence = {
  domain: ConversationMergeDomain;
  authority: ConversationEventAuthority;
  source: ConversationEventSource;
  eventId: string;
  occurredAt: number;
  receivedAt: number;
  sequenceRunId?: string;
  seq?: number;
};

export type EntityMergeState = {
  fields: Record<string, ConversationMergeEvidence>;
};

export type EventRetentionCheckpoint = {
  totalEventCount: number;
  droppedEventCount: number;
  firstOccurredAt: number;
  lastOccurredAt: number;
  lastEventId: string;
};

export type ConversationTurn = {
  id: string;
  sessionKey: string;
  trigger: UserMessageItem;
  status: TurnStatus;
  rootRunId?: string;
  runAliases: string[];
  taskIds: string[];
  items: TimelineItem[];
  itemIndex: Record<string, number>;
  toolItemByCallId: Record<string, string>;
  toolMergeByCallId: Record<string, EntityMergeState>;
  approvalMergeById: Record<string, EntityMergeState>;
  taskItemById: Record<string, string>;
  taskById: Record<string, ChatRuntimeTaskProjection>;
  taskMergeById: Record<string, TaskMergeEvidence>;
  artifactEntityByAlias: Record<string, string>;
  artifactItemByEntity: Record<string, string>;
  artifactMergeByEntity: Record<string, EntityMergeState>;
  verificationEntityByAlias: Record<string, string>;
  verificationItemByEntity: Record<string, string>;
  verificationMergeByEntity: Record<string, EntityMergeState>;
  finalMerge: EntityMergeState;
  sequenceWatermarks: Record<string, number>;
  historyReplayFingerprint?: string;
  hasLiveEvidence: boolean;
  evidence: TurnEvidence;
  createdAt: number;
  updatedAt: number;
  settledAt?: number;
  revision: number;
};

export type TurnAliasIndex = {
  byRunId: Record<string, string>;
  byTaskId: Record<string, string>;
  byToolCallId: Record<string, string>;
  byMessageId: Record<string, string>;
  activeBySession: Record<string, string>;
  pendingLocalBySession: Record<string, string>;
};

export type NoSequenceDedupeBucket = {
  eventIds: Record<string, true>;
  eventOrder: string[];
};

export type ConversationQuarantineRecord = {
  eventId: string;
  type: ConversationEvent['type'];
  source: ConversationEventSource;
  authority: ConversationEventAuthority;
  reason: 'unknown-run';
  runId: string;
  taskId?: string;
  toolCallId?: string;
  occurredAt: number;
  receivedAt: number;
};

export type ConversationQuarantineBucket = {
  records: ConversationQuarantineRecord[];
  droppedCount: number;
};

export type ConversationAssignmentBasis =
  | 'explicit-turn'
  | 'message-alias'
  | 'task-alias'
  | 'parent-task-alias'
  | 'tool-alias'
  | 'root-run-alias'
  | 'run-alias'
  | 'pending-local'
  | 'active-task-ledger'
  | 'active-native-approval'
  | 'history-liveness'
  | 'history-content-time'
  | 'created-turn'
  | 'quarantine';

export type ConversationAssignmentConfidence = 'high' | 'medium' | 'low';

export type ConversationAssignmentDiagnostic = {
  eventId: string;
  type: ConversationEvent['type'];
  source: ConversationEventSource;
  turnId?: string;
  basis: ConversationAssignmentBasis;
  confidence: ConversationAssignmentConfidence;
};

export type ConversationIngressDiagnostics = {
  duplicateCount: number;
  staleSequenceCount: number;
  quarantineCount: number;
  assignments: ConversationAssignmentDiagnostic[];
};

export type ConversationState = {
  noSequenceDedupeByScope: Record<string, NoSequenceDedupeBucket>;
  quarantineBySession: Record<string, ConversationQuarantineBucket>;
  ingressDiagnosticsBySession: Record<string, ConversationIngressDiagnostics>;
  eventsByTurnId: Record<string, ConversationEvent[]>;
  eventRetentionByTurnId: Record<string, EventRetentionCheckpoint>;
  turnOrderBySession: Record<string, string[]>;
  turnsById: Record<string, ConversationTurn>;
  aliases: TurnAliasIndex;
};

export const EMPTY_TURN_EVIDENCE: TurnEvidence = {
  backendIdle: false,
  finalMessagePresent: false,
  pendingToolCount: 0,
  pendingTaskCount: 0,
  pendingApprovalCount: 0,
  terminalPendingTaskIds: [],
  requiredArtifactsSatisfied: true,
  blockingVerificationFailed: false,
  historyCheckpointed: false,
};

export function createEmptyConversationState(): ConversationState {
  return {
    noSequenceDedupeByScope: {},
    quarantineBySession: {},
    ingressDiagnosticsBySession: {},
    eventsByTurnId: {},
    eventRetentionByTurnId: {},
    turnOrderBySession: {},
    turnsById: {},
    aliases: {
      byRunId: {},
      byTaskId: {},
      byToolCallId: {},
      byMessageId: {},
      activeBySession: {},
      pendingLocalBySession: {},
    },
  };
}
