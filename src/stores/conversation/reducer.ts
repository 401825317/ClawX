import type { ConversationEvent, ConversationFileChange, ConversationMessageSnapshot } from '../../../shared/conversation-events';
import type {
  ChatRuntimeArtifact,
  ChatRuntimeApprovalDecision,
  ChatRuntimeApprovalKind,
  ChatRuntimeApprovalResolutionSource,
  ChatRuntimePlanStep,
  ChatRuntimeProgressEntry,
  ChatRuntimeTaskProjection,
  ChatRuntimeVerification,
} from '../../../shared/chat-runtime-events';
import { stripProcessMessagePrefix } from '../../pages/Chat/message-utils';
import { canAppendToolToGroup, toolCategory, toolGroupStatus, toolGroupSummary } from './tool-grouping';
import {
  createSessionAliasKey,
  createTurnId,
  encodeToolSearchParentCallId,
  parseToolSearchNestedCallId,
  resolveTurnAssignment,
  sessionAliasKeyBelongsTo,
  stableHash,
} from './identity';
import { conversationPerformanceNow, recordConversationDuration } from './metrics';
import {
  EMPTY_TURN_EVIDENCE,
  type ApprovalItem,
  type ArtifactGroupItem,
  type CommentaryItem,
  type ConversationAssignmentBasis,
  type ConversationAssignmentConfidence,
  type ConversationMergeDomain,
  type ConversationMergeEvidence,
  type ConversationState,
  type ConversationTurn,
  type EntityMergeState,
  type ErrorItem,
  type FinalAnswerItem,
  type PlanItem,
  type SubtaskItem,
  type ThinkingItem,
  type TimelineItem,
  type ToolEntry,
  type ToolGroupItem,
  type UserMessageItem,
  type VerificationSummaryItem,
} from './types';

export const ACTIVE_EVENT_TAIL_LIMIT = 256;
export const TERMINAL_EVENT_TAIL_LIMIT = 64;
export const NO_SEQUENCE_DEDUPE_LIMIT = 2_048;
export const QUARANTINE_EVENT_LIMIT = 64;
export const ASSIGNMENT_DIAGNOSTIC_LIMIT = 128;

const TERMINAL_TURN_STATUSES = new Set<ConversationTurn['status']>([
  'completed',
  'error',
  'aborted',
]);

function isTerminalTurn(turn: ConversationTurn): boolean {
  return TERMINAL_TURN_STATUSES.has(turn.status);
}

function appendAssignmentDiagnostic(
  state: ConversationState,
  event: ConversationEvent,
  input: {
    turnId?: string;
    basis: ConversationAssignmentBasis;
    confidence: ConversationAssignmentConfidence;
  },
): void {
  const current = state.ingressDiagnosticsBySession[event.sessionKey];
  const assignments = [
    ...(current?.assignments ?? []),
    {
      eventId: event.eventId,
      type: event.type,
      source: event.source,
      turnId: input.turnId,
      basis: input.basis,
      confidence: input.confidence,
    },
  ];
  state.ingressDiagnosticsBySession[event.sessionKey] = {
    duplicateCount: current?.duplicateCount ?? 0,
    staleSequenceCount: current?.staleSequenceCount ?? 0,
    quarantineCount: current?.quarantineCount ?? 0,
    assignments: assignments.length > ASSIGNMENT_DIAGNOSTIC_LIMIT
      ? assignments.slice(-ASSIGNMENT_DIAGNOSTIC_LIMIT)
      : assignments,
  };
}

function incrementIngressDiagnostic(
  state: ConversationState,
  sessionKey: string,
  field: 'duplicateCount' | 'staleSequenceCount' | 'quarantineCount',
): void {
  const current = state.ingressDiagnosticsBySession[sessionKey];
  state.ingressDiagnosticsBySession[sessionKey] = {
    duplicateCount: current?.duplicateCount ?? 0,
    staleSequenceCount: current?.staleSequenceCount ?? 0,
    quarantineCount: current?.quarantineCount ?? 0,
    assignments: current?.assignments ?? [],
    [field]: (current?.[field] ?? 0) + 1,
  };
}

function mergeEvidence(event: ConversationEvent, domain: ConversationMergeDomain): ConversationMergeEvidence {
  return {
    domain,
    authority: event.authority,
    source: event.source,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    sequenceRunId: event.runId ?? event.rootRunId,
    seq: event.seq,
  };
}

/** Rank evidence by its owning fact domain before comparing event chronology. */
function mergeAuthorityRank(evidence: ConversationMergeEvidence, field = ''): number {
  const domainRank = evidence.domain === 'tool'
    ? 6
    : evidence.domain === 'run-fallback'
      ? 1
      : evidence.domain === 'approval'
        ? 5
      : 4;
  const lifecycleSourceRank = evidence.source === 'openclaw-runtime' || evidence.source === 'task-ledger'
    ? 7
    : evidence.source === 'openclaw-chat'
      ? 6
      : evidence.source === 'plugin'
        ? 5
        : evidence.source === 'host'
          ? 4
          : evidence.source === 'history'
            ? 3
            : evidence.source === 'derived'
              ? 2
              : 1;
  const authorityRank = evidence.authority === 'authoritative'
    ? 3
    : evidence.authority === 'corroborating'
      ? 2
      : 1;
  const finalField = evidence.domain === 'final';
  const availabilityField = evidence.domain === 'artifact'
    && ['filePath', 'url', 'mimeType', 'sizeBytes', 'availability', 'error'].includes(field);
  const verificationOutcomeField = evidence.domain === 'verification'
    && ['status', 'required', 'severity', 'detail', 'evidence'].includes(field);
  if (finalField) {
    const sourceRank = evidence.source === 'history'
      ? 8
      : evidence.source === 'openclaw-chat'
        ? 7
        : lifecycleSourceRank;
    return domainRank * 10_000 + authorityRank * 100 + sourceRank;
  }
  if (availabilityField) {
    const sourceRank = evidence.source === 'host' || evidence.source === 'plugin'
      ? 9
      : evidence.source === 'openclaw-runtime' || evidence.source === 'task-ledger'
        ? 8
        : evidence.source === 'openclaw-chat'
          ? 7
          : evidence.source === 'history'
            ? 3
            : lifecycleSourceRank;
    return domainRank * 10_000 + authorityRank * 100 + sourceRank;
  }
  if (verificationOutcomeField) {
    const sourceRank = evidence.source === 'host' || evidence.source === 'plugin'
      ? 9
      : evidence.source === 'openclaw-runtime' || evidence.source === 'task-ledger'
        ? 8
        : evidence.source === 'history'
          ? 3
          : lifecycleSourceRank;
    return domainRank * 10_000 + authorityRank * 100 + sourceRank;
  }
  return domainRank * 10_000 + lifecycleSourceRank * 10 + authorityRank;
}

function compareMergeEvidence(
  incoming: ConversationMergeEvidence,
  existing: ConversationMergeEvidence,
  field = '',
): number {
  const finalEntityField = incoming.domain === 'final' && existing.domain === 'final';
  if (finalEntityField && incoming.occurredAt < existing.occurredAt) return -1;
  const authorityDifference = mergeAuthorityRank(incoming, field) - mergeAuthorityRank(existing, field);
  if (authorityDifference !== 0) return authorityDifference;
  if (
    incoming.sequenceRunId === existing.sequenceRunId
    && incoming.seq != null
    && existing.seq != null
    && incoming.seq !== existing.seq
  ) {
    return incoming.seq - existing.seq;
  }
  if (incoming.occurredAt !== existing.occurredAt) return incoming.occurredAt - existing.occurredAt;
  if (incoming.receivedAt !== existing.receivedAt) return incoming.receivedAt - existing.receivedAt;
  return incoming.eventId.localeCompare(existing.eventId);
}

/** Merge only the fields for which the incoming event owns stronger evidence. */
function mergeRecordFields<T extends object>(
  current: T | undefined,
  incoming: T,
  state: EntityMergeState | undefined,
  evidence: ConversationMergeEvidence,
  prefix = '',
): { value: T; state: EntityMergeState } {
  const value = { ...(current ?? {}) } as Record<string, unknown>;
  const fields = { ...(state?.fields ?? {}) };
  Object.entries(incoming as Record<string, unknown>).forEach(([field, incomingValue]) => {
    if (incomingValue === undefined) return;
    const fieldKey = `${prefix}${field}`;
    const existingEvidence = fields[fieldKey];
    if (value[field] === undefined || !existingEvidence || compareMergeEvidence(evidence, existingEvidence, fieldKey) > 0) {
      value[field] = incomingValue;
      fields[fieldKey] = evidence;
    }
  });
  return { value: value as T, state: { fields } };
}

function messageData(event: ConversationEvent): ConversationMessageSnapshot | null {
  const data = event.data as { message?: ConversationMessageSnapshot };
  return data.message ?? null;
}

function blankTrigger(turnId: string, event: ConversationEvent): UserMessageItem {
  return {
    id: `user:${turnId}`,
    turnId,
    kind: 'user-message',
    status: 'completed',
    firstSeenAt: event.occurredAt,
    updatedAt: event.occurredAt,
    sourceEventIds: [],
    revision: 0,
    message: { role: 'user', content: '', timestamp: event.occurredAt },
  };
}

function createTurn(turnId: string, event: ConversationEvent, message?: ConversationMessageSnapshot): ConversationTurn {
  const trigger = blankTrigger(turnId, event);
  if (message) {
    trigger.message = message;
    trigger.sourceEventIds = [event.eventId];
    trigger.revision = 1;
  }
  return {
    id: turnId,
    sessionKey: event.sessionKey,
    trigger,
    status: event.type === 'turn.requested' ? 'queued' : 'running',
    rootRunId: event.rootRunId ?? event.runId,
    runAliases: [event.rootRunId, event.runId].filter((value): value is string => Boolean(value)),
    taskIds: event.taskId ? [event.taskId] : [],
    // Runtime and orphan-history evidence can arrive without a user boundary.
    // Keep the synthetic trigger for Turn identity, but do not render it.
    items: message ? [trigger] : [],
    itemIndex: message ? { [trigger.id]: 0 } : {},
    toolItemByCallId: {},
    toolMergeByCallId: {},
    approvalMergeById: {},
    taskItemById: {},
    taskById: {},
    taskMergeById: {},
    artifactEntityByAlias: {},
    artifactItemByEntity: {},
    artifactMergeByEntity: {},
    verificationEntityByAlias: {},
    verificationItemByEntity: {},
    verificationMergeByEntity: {},
    finalMerge: { fields: {} },
    sequenceWatermarks: {},
    hasLiveEvidence: event.source !== 'history',
    evidence: { ...EMPTY_TURN_EVIDENCE },
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
    revision: 1,
  };
}

function rebuildItemIndex(items: TimelineItem[]): Record<string, number> {
  return Object.fromEntries(items.map((item, index) => [item.id, index]));
}

const TIMELINE_ITEM_TIE_RANK: Record<TimelineItem['kind'], number> = {
  'user-message': 0,
  thinking: 1,
  commentary: 2,
  plan: 3,
  'tool-group': 4,
  subtask: 5,
  approval: 6,
  'artifact-group': 7,
  'verification-summary': 8,
  'final-answer': 9,
  error: 10,
};

function timelineTerminalRank(item: TimelineItem): number {
  if (item.kind === 'user-message') return -1;
  if (item.kind === 'final-answer') return 1;
  if (item.kind === 'error') return 2;
  return 0;
}

/** Keep late transport delivery from changing the canonical visual sequence. */
function reorderTurnItemsByCanonicalTime(turn: ConversationTurn): ConversationTurn {
  if (turn.items.length < 2) return turn;
  const items = turn.items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const terminalOrder = timelineTerminalRank(left.item) - timelineTerminalRank(right.item);
      if (terminalOrder !== 0) return terminalOrder;
      return left.item.firstSeenAt - right.item.firstSeenAt
        || TIMELINE_ITEM_TIE_RANK[left.item.kind] - TIMELINE_ITEM_TIE_RANK[right.item.kind]
        || left.index - right.index;
    })
    .map(({ item }) => item);
  if (items.every((item, index) => item === turn.items[index])) return turn;
  return {
    ...turn,
    items,
    itemIndex: rebuildItemIndex(items),
    revision: turn.revision + 1,
  };
}

function isToolGroupBoundary(item: TimelineItem): boolean {
  return item.kind !== 'user-message'
    && item.kind !== 'tool-group'
    && item.kind !== 'final-answer';
}

/** Split a group when late canonical evidence reveals a narrative boundary. */
function splitToolGroupsAtCanonicalBoundaries(turn: ConversationTurn): ConversationTurn {
  const boundaryTimes = turn.items
    .filter(isToolGroupBoundary)
    .map((item) => item.firstSeenAt);
  if (boundaryTimes.length === 0) return turn;

  let changed = false;
  const items: TimelineItem[] = [];
  const toolItemByCallId = { ...turn.toolItemByCallId };

  for (const item of turn.items) {
    if (item.kind !== 'tool-group' || item.entries.length < 2) {
      items.push(item);
      continue;
    }

    const chunks: ToolEntry[][] = [[item.entries[0]]];
    for (let index = 1; index < item.entries.length; index += 1) {
      const previous = item.entries[index - 1];
      const entry = item.entries[index];
      const hasBoundary = boundaryTimes.some((boundaryAt) => (
        boundaryAt > previous.startedAt && boundaryAt <= entry.startedAt
      ));
      if (hasBoundary) chunks.push([entry]);
      else chunks[chunks.length - 1].push(entry);
    }
    if (chunks.length === 1) {
      items.push(item);
      continue;
    }

    changed = true;
    const groupIdsByToolCallId = new Map<string, string>();
    const chunkItems = chunks.map((entries, index): ToolGroupItem => {
      const id = index === 0
        ? item.id
        : `tool-group:${item.category}:${entries[0].toolCallId}`;
      entries.forEach((entry) => groupIdsByToolCallId.set(entry.toolCallId, id));
      const summary = toolGroupSummary(item.category, entries);
      return {
        ...item,
        id,
        entries,
        toolCallIds: entries.map((entry) => entry.toolCallId),
        summaryKey: summary.key,
        summaryParams: summary.params,
        status: toolGroupStatus(entries),
        firstSeenAt: Math.min(...entries.map((entry) => entry.startedAt)),
        updatedAt: Math.max(...entries.map((entry) => entry.updatedAt)),
        revision: item.revision + 1,
      };
    });

    Object.entries(toolItemByCallId).forEach(([alias, ownerItemId]) => {
      if (ownerItemId !== item.id) return;
      let targetItemId = groupIdsByToolCallId.get(alias);
      if (!targetItemId) {
        const nested = parseToolSearchNestedCallId(alias);
        const parent = nested && item.entries.find((entry) => (
          encodeToolSearchParentCallId(entry.toolCallId) === nested.encodedParentToolCallId
        ));
        targetItemId = parent ? groupIdsByToolCallId.get(parent.toolCallId) : undefined;
      }
      toolItemByCallId[alias] = targetItemId ?? chunkItems[0].id;
    });
    items.push(...chunkItems);
  }

  if (!changed) return turn;
  return {
    ...turn,
    items,
    itemIndex: rebuildItemIndex(items),
    toolItemByCallId,
    revision: turn.revision + 1,
  };
}

function updateItem<TItem extends TimelineItem>(
  turn: ConversationTurn,
  id: string,
  updater: (current: TItem | undefined) => TItem,
): ConversationTurn {
  const index = turn.itemIndex[id];
  const current = index == null ? undefined : turn.items[index] as TItem;
  const nextItem = updater(current);
  if (current === nextItem) return turn;
  const items = index == null
    ? [...turn.items, nextItem]
    : turn.items.map((item, itemIndex) => (itemIndex === index ? nextItem : item));
  return {
    ...turn,
    items,
    itemIndex: index == null ? { ...turn.itemIndex, [id]: items.length - 1 } : turn.itemIndex,
    updatedAt: Math.max(turn.updatedAt, nextItem.updatedAt),
    revision: turn.revision + 1,
  };
}

const MAX_ITEM_SOURCE_EVENT_IDS = 64;

function appendSource(current: string[], eventId: string): string[] {
  if (current.includes(eventId)) return current;
  if (current.length < MAX_ITEM_SOURCE_EVENT_IDS) return [...current, eventId];
  return [current[0], ...current.slice(-(MAX_ITEM_SOURCE_EVENT_IDS - 2)), eventId];
}

function mergeText(current: string, data: { text?: string; delta?: string; replace?: boolean }): string {
  if (data.replace || data.text != null) return data.text ?? data.delta ?? current;
  return `${current}${data.delta ?? ''}`;
}

function artifactAliases(artifact: ChatRuntimeArtifact): string[] {
  const aliases: string[] = [];
  if (artifact.filePath?.trim()) aliases.push(`path:${artifact.filePath.trim().replace(/\\/gu, '/')}`);
  if (artifact.url?.trim()) aliases.push(`url:${artifact.url.trim()}`);
  if (artifact.id) aliases.push(`id:${artifact.id}`);
  return aliases;
}

function artifactItemStatus(artifacts: ChatRuntimeArtifact[]): TimelineItem['status'] {
  if (artifacts.some((artifact) => artifact.error || artifact.availability === 'error')) return 'error';
  if (artifacts.some((artifact) => artifact.availability === 'unavailable')) return 'blocked';
  if (artifacts.some((artifact) => artifact.availability === 'registered')) return 'pending';
  return 'completed';
}

function verificationAliases(verification: ChatRuntimeVerification): string[] {
  const owner = verification.targetId ?? verification.artifactId ?? verification.taskId;
  const aliases = owner && verification.kind ? [`target:${owner}:${verification.kind}`] : [];
  if (verification.id) aliases.push(`id:${verification.id}`);
  return aliases;
}

function artifactReferenceAliases(value: string | undefined): string[] {
  const normalized = value?.trim();
  if (!normalized) return [];
  const aliases = [`id:${normalized}`];
  if (/^(?:https?:)?\/\//iu.test(normalized)) aliases.push(`url:${normalized}`);
  if (/^(?:[a-zA-Z]:[\\/]|[\\/])/u.test(normalized)) {
    aliases.push(`path:${normalized.replace(/\\/gu, '/')}`);
  }
  return aliases;
}

function verificationArtifactAliases(verification: ChatRuntimeVerification): string[] {
  return [...new Set([
    ...artifactReferenceAliases(verification.artifactId),
    ...artifactReferenceAliases(verification.targetId),
  ])];
}

function artifactAvailabilityFromVerification(
  verification: ChatRuntimeVerification,
): ChatRuntimeArtifact['availability'] | undefined {
  if (verification.kind !== 'artifact.availability') return undefined;
  if (verification.status === 'passed') return 'available';
  if (verification.status === 'failed' || verification.status === 'blocked') return 'unavailable';
  return undefined;
}

/** Keep native sequence watermarks independent across canonical entity streams. */
function eventSequenceStreamKey(event: ConversationEvent): string {
  // OpenClaw sequence numbers restart for each concrete run. rootRunId only
  // assigns child/background evidence to a Turn and must not merge seq domains.
  const runId = event.runId ?? event.rootRunId ?? event.turnId ?? 'session';
  let entity: string;
  switch (event.type) {
    case 'run.started':
    case 'run.ended':
    case 'session.activity':
      entity = `run:${runId}`;
      break;
    case 'assistant.content':
    case 'commentary.append':
      entity = `assistant:${event.messageId ?? runId}`;
      break;
    case 'thinking.content':
      entity = `thinking:${event.messageId ?? runId}`;
      break;
    case 'tool.started':
    case 'tool.updated':
    case 'tool.completed':
      entity = `tool:${event.toolCallId ?? (event.data as { toolCallId?: string }).toolCallId ?? runId}`;
      break;
    case 'task.updated':
      entity = `task:${event.taskId ?? (event.data as { task?: ChatRuntimeTaskProjection }).task?.taskId ?? runId}`;
      break;
    case 'approval.updated':
      entity = `approval:${(event.data as { itemId?: string }).itemId ?? event.taskId ?? runId}`;
      break;
    case 'artifact.updated': {
      const artifact = (event.data as { artifact: ChatRuntimeArtifact }).artifact;
      entity = `artifact:${artifactAliases(artifact)[0] ?? runId}`;
      break;
    }
    case 'verification.updated': {
      const verification = (event.data as { verification: ChatRuntimeVerification }).verification;
      entity = `verification:${verificationAliases(verification)[0] ?? runId}`;
      break;
    }
    case 'final.message':
      entity = `final:${runId}`;
      break;
    case 'plan.updated':
    case 'step.updated':
      entity = `plan:${runId}`;
      break;
    case 'progress.updated':
      entity = `progress:${(event.data as { entry?: ChatRuntimeProgressEntry }).entry?.id ?? runId}`;
      break;
    default:
      entity = `${event.type}:${event.messageId ?? event.taskId ?? runId}`;
  }
  return `${event.source}:${runId}:${entity}`;
}

function sealNarrativeItems(turn: ConversationTurn): ConversationTurn {
  let changed = false;
  const items = turn.items.map((item) => {
    if ((item.kind !== 'commentary' && item.kind !== 'thinking') || item.sealed) return item;
    changed = true;
    return { ...item, sealed: true, status: 'completed' as const, revision: item.revision + 1 };
  });
  return changed
    ? { ...turn, items, revision: turn.revision + 1 }
    : turn;
}

function activeNarrativeId(turn: ConversationTurn, kind: 'commentary' | 'thinking', event: ConversationEvent): string {
  const origin = event.type === 'assistant.content' ? 'assistant' : 'progress';
  const active = [...turn.items].reverse().find((item) => (
    item.kind === kind
    && !item.sealed
    && (item.kind !== 'commentary' || item.origin === origin)
  ));
  return active?.id ?? `${kind}:${event.messageId ?? event.eventId}`;
}

/** Reuse an exact live assistant commentary when authoritative history enriches the same Turn. */
function alignedLiveCommentaryId(
  turn: ConversationTurn,
  event: ConversationEvent,
  kind: 'commentary' | 'thinking',
  data: { text?: string; delta?: string; replace?: boolean },
): string | undefined {
  if (event.source !== 'history' || kind !== 'commentary' || !turn.hasLiveEvidence) return undefined;
  const text = mergeText('', data).trim();
  if (!text) return undefined;
  return turn.items.find((item) => (
    item.kind === 'commentary'
    && item.origin === 'assistant'
    && item.text.trim() === text
    && item.sourceEventIds.some((eventId) => !eventId.startsWith('history:'))
  ))?.id;
}

function applyNarrative(turn: ConversationTurn, event: ConversationEvent, kind: 'commentary' | 'thinking'): ConversationTurn {
  const commentaryData = event.data as { entry?: ChatRuntimeProgressEntry; text?: string; delta?: string; replace?: boolean };
  const data = event.type === 'commentary.append' && commentaryData.entry
    ? { text: commentaryData.entry.text, replace: false }
    : commentaryData;
  const id = alignedLiveCommentaryId(turn, event, kind, data)
    ?? activeNarrativeId(turn, kind, event);
  const origin = event.type === 'assistant.content' ? 'assistant' : 'progress';
  const persistedAfterFinal = event.source === 'history'
    && turn.items.some((item) => item.kind === 'final-answer');
  return updateItem<CommentaryItem | ThinkingItem>(turn, id, (current) => {
    const text = mergeText(current?.text ?? '', data);
    const base = {
      id,
      turnId: turn.id,
      kind,
      text,
      sealed: persistedAfterFinal,
      status: persistedAfterFinal ? 'completed' as const : 'running' as const,
      firstSeenAt: current?.firstSeenAt ?? event.occurredAt,
      updatedAt: event.occurredAt,
      sourceEventIds: appendSource(current?.sourceEventIds ?? [], event.eventId),
      revision: (current?.revision ?? 0) + 1,
    };
    return kind === 'commentary'
      ? { ...base, kind, origin } as CommentaryItem
      : base as ThinkingItem;
  });
}

function progressItemStatus(entry: ChatRuntimeProgressEntry): CommentaryItem['status'] {
  if (entry.status === 'completed') return 'completed';
  if (entry.status === 'blocked') return 'blocked';
  if (entry.status === 'aborted') return 'aborted';
  if (entry.status === 'error') return 'error';
  return 'running';
}

/** Project ownerless action/status progress as one stable compact narrative row. */
function applyProgress(turn: ConversationTurn, event: ConversationEvent): ConversationTurn {
  if (event.timelineVisibility === 'diagnostics') return turn;
  const entry = (event.data as { entry?: ChatRuntimeProgressEntry }).entry;
  if (!entry || entry.toolCallId || entry.taskId || entry.stepId) return turn;
  const id = `progress:${entry.id}`;
  const baseTurn = turn.itemIndex[id] == null ? sealNarrativeItems(turn) : turn;
  return updateItem<CommentaryItem>(baseTurn, id, (current) => ({
    id,
    turnId: turn.id,
    kind: 'commentary',
    text: entry.text,
    sealed: true,
    origin: 'progress',
    status: progressItemStatus(entry),
    firstSeenAt: current?.firstSeenAt ?? event.occurredAt,
    updatedAt: Math.max(current?.updatedAt ?? event.occurredAt, event.occurredAt),
    sourceEventIds: appendSource(current?.sourceEventIds ?? [], event.eventId),
    revision: (current?.revision ?? 0) + 1,
  }));
}

function toolData(event: ConversationEvent): {
  toolCallId: string;
  name: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  durationMs?: number;
  isError?: boolean;
} {
  return event.data as ReturnType<typeof toolData>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function delegatedToolName(entry: ToolEntry): string | undefined {
  if (entry.name.trim().toLowerCase() !== 'tool_call') return undefined;
  const wrapper = record(entry.args);
  if (!wrapper) return undefined;
  for (const key of ['id', 'toolName', 'tool_name', 'name']) {
    const value = wrapper[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Fold one Tool Search target call into its unique outer tool_call Timeline owner. */
function canonicalTimelineToolCallId(
  turn: ConversationTurn,
  toolCallId: string,
  toolName: string,
): string {
  const nested = parseToolSearchNestedCallId(toolCallId);
  if (!nested || nested.toolName !== toolName) return toolCallId;
  const aliasedItemId = turn.toolItemByCallId[toolCallId];
  const aliasedItemIndex = aliasedItemId == null ? undefined : turn.itemIndex[aliasedItemId];
  const aliasedItem = aliasedItemIndex == null ? undefined : turn.items[aliasedItemIndex];
  if (aliasedItem?.kind === 'tool-group') {
    const aliasedEntries = aliasedItem.entries.filter((entry) => (
      encodeToolSearchParentCallId(entry.toolCallId) === nested.encodedParentToolCallId
    ));
    if (aliasedEntries.length === 1) return aliasedEntries[0].toolCallId;
  }
  const candidates = turn.items.flatMap((item) => item.kind === 'tool-group' ? item.entries : [])
    .filter((entry) => (
      encodeToolSearchParentCallId(entry.toolCallId) === nested.encodedParentToolCallId
      && delegatedToolName(entry) === nested.toolName
    ));
  return candidates.length === 1 ? candidates[0].toolCallId : toolCallId;
}

/** Preserve direct tool terminals while allowing them to correct run-level fallbacks. */
function mergeToolEntry(
  current: ToolEntry | undefined,
  currentMerge: EntityMergeState | undefined,
  event: ConversationEvent,
  data: ReturnType<typeof toolData>,
  toolCallId: string,
): { entry: ToolEntry; merge: EntityMergeState } {
  const evidence = mergeEvidence(event, 'tool');
  const incomingStatus: ToolEntry['status'] = event.type === 'tool.completed'
    ? (data.isError ? 'error' : 'completed')
    : 'running';
  const merged = mergeRecordFields(
    current && {
      name: current.name,
      args: current.args,
      partialResult: current.partialResult,
      result: current.result,
      durationMs: current.durationMs,
      taskId: current.taskId,
      parentTaskId: current.parentTaskId,
    },
    {
      name: data.name,
      args: data.args,
      partialResult: data.partialResult,
      result: data.result,
      durationMs: data.durationMs,
      taskId: event.taskId,
      parentTaskId: event.parentTaskId,
    },
    currentMerge,
    evidence,
  );
  const fields = { ...merged.state.fields };
  const currentStatus = current?.status;
  const currentStatusEvidence = currentMerge?.fields.status;
  const currentTerminal = currentStatus === 'completed' || currentStatus === 'aborted' || currentStatus === 'error';
  const incomingTerminal = incomingStatus !== 'running';
  let status = currentStatus ?? incomingStatus;
  if (!currentStatusEvidence) {
    status = incomingStatus;
    fields.status = evidence;
  } else if (!currentTerminal && incomingTerminal) {
    status = incomingStatus;
    fields.status = evidence;
  } else if (currentTerminal && incomingTerminal && currentStatus !== incomingStatus) {
    if (mergeAuthorityRank(evidence) > mergeAuthorityRank(currentStatusEvidence)) {
      status = incomingStatus;
      fields.status = evidence;
    }
  } else if (currentStatus === incomingStatus && compareMergeEvidence(evidence, currentStatusEvidence) > 0) {
    fields.status = evidence;
  }
  return {
    entry: {
      toolCallId,
      name: merged.value.name ?? current?.name ?? data.name,
      status,
      args: merged.value.args,
      partialResult: merged.value.partialResult,
      result: merged.value.result,
      durationMs: merged.value.durationMs,
      startedAt: current?.startedAt ?? event.occurredAt,
      updatedAt: Math.max(current?.updatedAt ?? event.occurredAt, event.occurredAt),
      taskId: merged.value.taskId,
      parentTaskId: merged.value.parentTaskId,
    },
    merge: { fields },
  };
}

function applyTool(turn: ConversationTurn, event: ConversationEvent): ConversationTurn {
  const data = toolData(event);
  const rawToolCallId = event.toolCallId ?? data.toolCallId;
  if (!rawToolCallId || !data.name) return turn;
  const toolCallId = canonicalTimelineToolCallId(turn, rawToolCallId, data.name);
  const existingItemId = turn.toolItemByCallId[toolCallId];
  if (
    turn.evidence.runTerminal
    && turn.evidence.runTerminalAuthority === 'authoritative'
    && !existingItemId
    && event.type !== 'tool.completed'
  ) {
    return turn;
  }
  let nextTurn = existingItemId ? turn : sealNarrativeItems(turn);
  if (existingItemId) {
    let nextMerge = turn.toolMergeByCallId[toolCallId];
    const updated = updateItem<ToolGroupItem>(nextTurn, existingItemId, (group) => {
      if (!group) return group as never;
      const entries = group.entries.map((entry) => {
        if (entry.toolCallId !== toolCallId) return entry;
        const merged = mergeToolEntry(entry, nextMerge, event, data, toolCallId);
        nextMerge = merged.merge;
        return merged.entry;
      });
      const summary = toolGroupSummary(group.category, entries);
      return {
        ...group,
        entries,
        status: toolGroupStatus(entries),
        summaryKey: summary.key,
        summaryParams: summary.params,
        updatedAt: event.occurredAt,
        sourceEventIds: appendSource(group.sourceEventIds, event.eventId),
        revision: group.revision + 1,
      };
    });
    return {
      ...updated,
      toolItemByCallId: rawToolCallId === toolCallId
        ? updated.toolItemByCallId
        : { ...updated.toolItemByCallId, [rawToolCallId]: existingItemId },
      toolMergeByCallId: { ...updated.toolMergeByCallId, [toolCallId]: nextMerge },
    };
  }

  const mergedEntry = mergeToolEntry(undefined, undefined, event, data, toolCallId);
  const entry = mergedEntry.entry;
  const lastItem = nextTurn.items[nextTurn.items.length - 1];
  const candidate = lastItem?.kind === 'tool-group' ? lastItem : undefined;
  const itemId = candidate && canAppendToolToGroup(candidate, entry)
    ? candidate.id
    : `tool-group:${toolCategory(data.name)}:${toolCallId}`;
  nextTurn = updateItem<ToolGroupItem>(nextTurn, itemId, (current) => {
    const entries = current ? [...current.entries, entry] : [entry];
    const category = current?.category ?? toolCategory(data.name);
    const summary = toolGroupSummary(category, entries);
    return {
      id: itemId,
      turnId: turn.id,
      kind: 'tool-group',
      category,
      summaryKey: summary.key,
      summaryParams: summary.params,
      toolCallIds: entries.map((tool) => tool.toolCallId),
      entries,
      status: toolGroupStatus(entries),
      firstSeenAt: current?.firstSeenAt ?? event.occurredAt,
      updatedAt: event.occurredAt,
      sourceEventIds: appendSource(current?.sourceEventIds ?? [], event.eventId),
      revision: (current?.revision ?? 0) + 1,
    };
  });
  return {
    ...nextTurn,
    toolItemByCallId: { ...nextTurn.toolItemByCallId, [toolCallId]: itemId },
    toolMergeByCallId: { ...nextTurn.toolMergeByCallId, [toolCallId]: mergedEntry.merge },
  };
}

/** Transfer one tool's default Timeline ownership to its structured task fact. */
function removeToolTimelineOwner(turn: ConversationTurn, event: ConversationEvent): ConversationTurn {
  const data = toolData(event);
  const rawToolCallId = event.toolCallId ?? data.toolCallId;
  if (!rawToolCallId) return turn;
  const toolCallId = canonicalTimelineToolCallId(turn, rawToolCallId, data.name);
  const itemId = turn.toolItemByCallId[toolCallId];
  if (!itemId) return turn;
  const itemIndex = turn.itemIndex[itemId];
  const item = itemIndex == null ? undefined : turn.items[itemIndex];
  if (!item || item.kind !== 'tool-group') return turn;

  const entries = item.entries.filter((entry) => entry.toolCallId !== toolCallId);
  if (entries.length === item.entries.length) return turn;
  const toolItemByCallId = { ...turn.toolItemByCallId };
  const toolMergeByCallId = { ...turn.toolMergeByCallId };
  const encodedToolCallId = encodeToolSearchParentCallId(toolCallId);
  Object.keys(toolItemByCallId).forEach((alias) => {
    const nested = parseToolSearchNestedCallId(alias);
    if (alias !== toolCallId && nested?.encodedParentToolCallId !== encodedToolCallId) return;
    delete toolItemByCallId[alias];
    delete toolMergeByCallId[alias];
  });

  if (entries.length === 0) {
    const items = turn.items.filter((_, index) => index !== itemIndex);
    return {
      ...turn,
      items,
      itemIndex: rebuildItemIndex(items),
      toolItemByCallId,
      toolMergeByCallId,
      updatedAt: Math.max(turn.updatedAt, event.occurredAt),
      revision: turn.revision + 1,
    };
  }

  const summary = toolGroupSummary(item.category, entries);
  const nextItem: ToolGroupItem = {
    ...item,
    entries,
    toolCallIds: entries.map((entry) => entry.toolCallId),
    status: toolGroupStatus(entries),
    summaryKey: summary.key,
    summaryParams: summary.params,
    updatedAt: Math.max(item.updatedAt, event.occurredAt),
    sourceEventIds: appendSource(item.sourceEventIds, event.eventId),
    revision: item.revision + 1,
  };
  const items = turn.items.map((current, index) => index === itemIndex ? nextItem : current);
  return {
    ...turn,
    items,
    toolItemByCallId,
    toolMergeByCallId,
    updatedAt: Math.max(turn.updatedAt, event.occurredAt),
    revision: turn.revision + 1,
  };
}

const TASK_TERMINAL_STATUSES = new Set<ChatRuntimeTaskProjection['status']>([
  'completed',
  'aborted',
  'error',
  'partial',
]);

function isTaskTerminal(task: ChatRuntimeTaskProjection): boolean {
  return TASK_TERMINAL_STATUSES.has(task.status);
}

/** Native evidence outranks history and synthetic recovery evidence. */
function evidenceRank(
  source: ConversationEvent['source'],
  authority: ConversationEvent['authority'],
): number {
  const sourceRank = source === 'openclaw-runtime' || source === 'task-ledger'
    ? 4
    : source === 'openclaw-chat' || source === 'plugin'
      ? 3
      : source === 'host' || source === 'history'
        ? 2
        : 1;
  const authorityRank = authority === 'authoritative'
    ? 3
    : authority === 'corroborating'
      ? 2
      : 1;
  return sourceRank * 10 + authorityRank;
}

function shouldApplyTaskUpdate(
  turn: ConversationTurn,
  existing: ChatRuntimeTaskProjection | undefined,
  incoming: ChatRuntimeTaskProjection,
  event: ConversationEvent,
): boolean {
  if (!existing) return true;
  const existingTerminal = isTaskTerminal(existing);
  const incomingTerminal = isTaskTerminal(incoming);
  const mergeEvidence = turn.taskMergeById[incoming.taskId];
  const existingUpdatedAt = existing.updatedAt ?? mergeEvidence?.updatedAt ?? 0;
  const incomingUpdatedAt = incoming.updatedAt ?? event.occurredAt;

  // A terminal task never reopens. A contradictory terminal correction must
  // come from a strictly stronger evidence source.
  if (existingTerminal) {
    if (!incomingTerminal) return false;
    if (existing.status !== incoming.status) {
      return mergeEvidence != null
        && evidenceRank(event.source, event.authority) > evidenceRank(mergeEvidence.source, mergeEvidence.authority);
    }
    return incomingUpdatedAt >= existingUpdatedAt || (
      mergeEvidence != null
      && evidenceRank(event.source, event.authority) > evidenceRank(mergeEvidence.source, mergeEvidence.authority)
    );
  }

  // A replayed terminal snapshot may fill a missing native terminal event.
  if (incomingTerminal) return true;
  if (!mergeEvidence) return incomingUpdatedAt >= existingUpdatedAt;
  const incomingRank = evidenceRank(event.source, event.authority);
  const existingRank = evidenceRank(mergeEvidence.source, mergeEvidence.authority);
  return incomingRank > existingRank || (incomingRank === existingRank && incomingUpdatedAt >= existingUpdatedAt);
}

const SUBTASK_GROUP_WINDOW_MS = 15_000;

function subtaskItemStatus(tasks: ChatRuntimeTaskProjection[]): SubtaskItem['status'] {
  if (tasks.some((task) => task.status === 'error' || task.status === 'partial')) return 'error';
  if (tasks.some((task) => task.status === 'pending' || task.status === 'running')) return 'running';
  if (tasks.some((task) => task.status === 'waiting_approval')) return 'blocked';
  if (tasks.some((task) => task.status === 'aborted')) return 'aborted';
  return 'completed';
}

function subtaskSummary(tasks: ChatRuntimeTaskProjection[]): {
  key: string;
  params: Record<string, string | number>;
} {
  const failed = tasks.filter((task) => task.status === 'error' || task.status === 'partial').length;
  const waiting = tasks.filter((task) => task.status === 'waiting_approval').length;
  const running = tasks.filter((task) => task.status === 'pending' || task.status === 'running').length;
  const aborted = tasks.filter((task) => task.status === 'aborted').length;
  const status = failed > 0
    ? 'failed'
    : running > 0
      ? 'running'
      : waiting > 0
        ? 'waiting'
        : aborted > 0
          ? 'aborted'
          : 'completed';
  return {
    key: `timeline.subtasks.${status}`,
    params: { count: tasks.length, failed, waiting, running, aborted },
  };
}

/** Project adjacent native tasks as one compact, parent-owned subtask item. */
function applySubtaskTimeline(
  turn: ConversationTurn,
  event: ConversationEvent,
  task: ChatRuntimeTaskProjection,
): ConversationTurn {
  const existingItemId = turn.taskItemById[task.taskId];
  if (existingItemId) {
    return updateItem<SubtaskItem>(turn, existingItemId, (item) => {
      if (!item) return item as never;
      const tasks = item.tasks.map((current) => current.taskId === task.taskId ? task : current);
      const summary = subtaskSummary(tasks);
      return {
        ...item,
        tasks,
        status: subtaskItemStatus(tasks),
        summaryKey: summary.key,
        summaryParams: summary.params,
        updatedAt: Math.max(item.updatedAt, event.occurredAt),
        sourceEventIds: appendSource(item.sourceEventIds, event.eventId),
        revision: item.revision + 1,
      };
    });
  }

  const parentTaskId = task.parentTaskId ?? event.parentTaskId;
  const lastItem = turn.items[turn.items.length - 1];
  const candidate = lastItem?.kind === 'subtask'
    && (lastItem.parentTaskId ?? '') === (parentTaskId ?? '')
    && event.occurredAt - lastItem.updatedAt <= SUBTASK_GROUP_WINDOW_MS
    && lastItem.status !== 'error'
    && !['error', 'partial'].includes(task.status)
    ? lastItem
    : undefined;
  const itemId = candidate
    ? candidate.id
    : `subtask:${parentTaskId ?? turn.id}:${task.taskId}`;
  const nextTurn = updateItem<SubtaskItem>(turn, itemId, (current) => {
    const tasks = current ? [...current.tasks, task] : [task];
    const summary = subtaskSummary(tasks);
    return {
      id: itemId,
      turnId: turn.id,
      kind: 'subtask',
      parentTaskId,
      summaryKey: summary.key,
      summaryParams: summary.params,
      taskIds: tasks.map((item) => item.taskId),
      tasks,
      status: subtaskItemStatus(tasks),
      firstSeenAt: current?.firstSeenAt ?? event.occurredAt,
      updatedAt: event.occurredAt,
      sourceEventIds: appendSource(current?.sourceEventIds ?? [], event.eventId),
      revision: (current?.revision ?? 0) + 1,
    };
  });
  return {
    ...nextTurn,
    taskItemById: { ...nextTurn.taskItemById, [task.taskId]: itemId },
  };
}

function applyTask(turn: ConversationTurn, event: ConversationEvent): ConversationTurn {
  const incoming = (event.data as { task: ChatRuntimeTaskProjection }).task;
  if (!incoming?.taskId) return turn;
  const existing = turn.taskById[incoming.taskId];
  if (
    turn.evidence.runTerminal
    && turn.evidence.runTerminalAuthority === 'authoritative'
    && !existing
    && !isTaskTerminal(incoming)
  ) {
    return turn;
  }
  if (!shouldApplyTaskUpdate(turn, existing, incoming, event)) return turn;
  const existingMerge = turn.taskMergeById[incoming.taskId];
  const clearsWeakTerminalFallback = Boolean(
    existing
    && isTaskTerminal(existing)
    && isTaskTerminal(incoming)
    && existingMerge?.source === 'synthetic'
    && existingMerge.authority === 'inferred'
    && evidenceRank(event.source, event.authority) > evidenceRank(existingMerge.source, existingMerge.authority),
  );
  const task = {
    ...existing,
    ...(clearsWeakTerminalFallback ? {
      sourceStatus: undefined,
      terminalOutcome: undefined,
      endedAt: undefined,
    } : {}),
    ...incoming,
    parentTaskId: incoming.parentTaskId ?? event.parentTaskId ?? existing?.parentTaskId,
  };
  const nextUpdatedAt = task.updatedAt ?? event.occurredAt;
  const taskOwnerTurn = !existing && !isTaskTerminal(task)
    ? demotePrematureFinalForTask(turn, event)
    : turn;
  const baseTurn = !existing && !isTaskTerminal(task) ? sealNarrativeItems(taskOwnerTurn) : taskOwnerTurn;
  const nextTurn: ConversationTurn = {
    ...baseTurn,
    taskById: { ...baseTurn.taskById, [task.taskId]: task },
    taskMergeById: {
      ...baseTurn.taskMergeById,
      [task.taskId]: {
        authority: event.authority,
        source: event.source,
        occurredAt: event.occurredAt,
        updatedAt: nextUpdatedAt,
      },
    },
    taskIds: baseTurn.taskIds.includes(task.taskId) ? baseTurn.taskIds : [...baseTurn.taskIds, task.taskId],
    updatedAt: Math.max(baseTurn.updatedAt, event.occurredAt),
    revision: baseTurn.revision + 1,
  };
  const projected = applySubtaskTimeline(nextTurn, event, task);
  const owned = event.toolCallId ? removeToolTimelineOwner(projected, event) : projected;
  const resolved = existing?.status !== 'waiting_approval' || task.status === 'waiting_approval'
    ? owned
    : resolveTaskFallbackApproval(owned, event, task);
  return releaseDeferredFinal(resolved);
}

function applyPlan(turn: ConversationTurn, event: ConversationEvent): ConversationTurn {
  const id = `plan:${turn.id}`;
  return updateItem<PlanItem>(turn, id, (current) => {
    const data = event.data as { objective?: string; summary?: string; steps?: ChatRuntimePlanStep[]; step?: ChatRuntimePlanStep };
    let steps = data.steps ?? current?.steps ?? [];
    if (data.step) {
      const index = steps.findIndex((step) => step.id === data.step!.id);
      steps = index < 0
        ? [...steps, data.step]
        : steps.map((step, stepIndex) => (stepIndex === index ? { ...step, ...data.step } : step));
    }
    steps = [...steps].sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER));
    const running = steps.some((step) => step.status === 'running' || step.status === 'pending');
    const failed = steps.some((step) => step.status === 'error' || step.status === 'blocked');
    return {
      id,
      turnId: turn.id,
      kind: 'plan',
      objective: data.objective ?? current?.objective,
      summary: data.summary ?? current?.summary,
      steps,
      status: failed ? 'error' : running ? 'running' : 'completed',
      firstSeenAt: current?.firstSeenAt ?? event.occurredAt,
      updatedAt: event.occurredAt,
      sourceEventIds: appendSource(current?.sourceEventIds ?? [], event.eventId),
      revision: (current?.revision ?? 0) + 1,
    };
  });
}

type ApprovalEventData = {
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
};

type ApprovalMergeFields = Pick<
  ApprovalItem,
  | 'approvalId'
  | 'approvalKind'
  | 'allowedDecisions'
  | 'decision'
  | 'requestedAt'
  | 'expiresAt'
  | 'request'
  | 'actionable'
  | 'resolutionSource'
  | 'itemId'
  | 'title'
  | 'legacyKind'
  | 'phase'
  | 'approvalStatus'
  | 'message'
  | 'taskId'
  | 'authority'
  | 'source'
  | 'status'
>;

const APPROVAL_TERMINAL_FIELDS = new Set<keyof ApprovalMergeFields>([
  'decision',
  'actionable',
  'resolutionSource',
  'phase',
  'approvalStatus',
  'authority',
  'source',
  'status',
]);

function approvalMergeFields(item: ApprovalItem | undefined): Partial<ApprovalMergeFields> | undefined {
  if (!item) return undefined;
  return {
    approvalId: item.approvalId,
    approvalKind: item.approvalKind,
    allowedDecisions: item.allowedDecisions,
    decision: item.decision,
    requestedAt: item.requestedAt,
    expiresAt: item.expiresAt,
    request: item.request,
    actionable: item.actionable,
    resolutionSource: item.resolutionSource,
    itemId: item.itemId,
    title: item.title,
    legacyKind: item.legacyKind,
    phase: item.phase,
    approvalStatus: item.approvalStatus,
    message: item.message,
    taskId: item.taskId,
    authority: item.authority,
    source: item.source,
    status: item.status,
  };
}

function withApprovalFallbackEvidence(
  state: EntityMergeState | undefined,
  evidence: ConversationMergeEvidence,
): EntityMergeState {
  const fields = { ...(state?.fields ?? {}) };
  APPROVAL_TERMINAL_FIELDS.forEach((field) => {
    fields[field] = evidence;
  });
  return { fields };
}

function approvalTimelineStatus(data: ApprovalEventData): ApprovalItem['status'] {
  if (data.decision === 'deny') return 'error';
  if (data.decision === 'allow-once' || data.decision === 'allow-always') return 'completed';
  const status = data.status?.trim().toLowerCase();
  if (status === 'pending' || status === 'waiting' || status === 'requested') return 'blocked';
  if (
    status === 'deny'
    || status === 'denied'
    || status === 'rejected'
    || status === 'cancelled'
    || status === 'canceled'
    || status === 'expired'
    || status === 'error'
    || status === 'failed'
  ) return 'error';
  if (data.phase === 'requested') return 'blocked';
  return 'completed';
}

function normalizedApprovalTitle(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, ' ').trim();
  return normalized || undefined;
}

/** Resolve a native terminal approval to one unambiguous task-only waiting fallback. */
function taskFallbackApprovalAlias(
  turn: ConversationTurn,
  event: ConversationEvent,
  data: ApprovalEventData,
  targetId: string,
  incomingStatus: ApprovalItem['status'],
): ApprovalItem | undefined {
  const taskId = event.taskId?.trim();
  const explicitApprovalId = data.approvalId ?? data.itemId;
  if (
    !taskId
    || !explicitApprovalId
    || incomingStatus === 'blocked'
    || data.approvalKind === 'task'
    || event.authority !== 'authoritative'
    || !['openclaw-runtime', 'plugin', 'host'].includes(event.source)
  ) return undefined;

  const candidates = turn.items.filter((item): item is ApprovalItem => (
    item.kind === 'approval'
    && item.id !== targetId
    && item.status === 'blocked'
    && item.taskId === taskId
    && item.approvalKind === 'task'
    && item.actionable === false
    && item.allowedDecisions.length === 0
  ));
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0];
  if (event.occurredAt < candidate.firstSeenAt) return undefined;
  const candidateTitle = normalizedApprovalTitle(candidate.title);
  const incomingTitle = normalizedApprovalTitle(data.title);
  if (candidateTitle && incomingTitle && candidateTitle !== incomingTitle) return undefined;

  const existingTargetIndex = turn.itemIndex[targetId];
  if (existingTargetIndex == null) return candidate;
  const existingTarget = turn.items[existingTargetIndex];
  return existingTarget?.kind === 'approval'
    && existingTarget.taskId === taskId
    && existingTarget.approvalKind !== 'task'
    ? candidate
    : undefined;
}

/** Re-key the fallback to the explicit identity, or remove it when that identity already exists. */
function convergeTaskFallbackApprovalAlias(
  turn: ConversationTurn,
  fallback: ApprovalItem,
  targetId: string,
): ConversationTurn {
  const targetIndex = turn.itemIndex[targetId];
  const approvalMergeById = { ...turn.approvalMergeById };
  const fallbackMerge = approvalMergeById[fallback.id];
  delete approvalMergeById[fallback.id];

  if (targetIndex == null) {
    const fields = { ...(fallbackMerge?.fields ?? {}) };
    delete fields.approvalId;
    delete fields.approvalKind;
    delete fields.itemId;
    const items = turn.items.map((item) => item.id === fallback.id
      ? {
          ...fallback,
          id: targetId,
          approvalId: undefined,
          approvalKind: undefined,
          itemId: undefined,
        }
      : item);
    approvalMergeById[targetId] = { fields };
    return {
      ...turn,
      items,
      itemIndex: rebuildItemIndex(items),
      approvalMergeById,
    };
  }

  const target = turn.items[targetIndex] as ApprovalItem;
  const sourceEventIds = fallback.sourceEventIds.reduce(
    (current, eventId) => appendSource(current, eventId),
    target.sourceEventIds,
  );
  const items = turn.items
    .filter((item) => item.id !== fallback.id)
    .map((item) => item.id === targetId
      ? {
          ...target,
          firstSeenAt: Math.min(target.firstSeenAt, fallback.firstSeenAt),
          sourceEventIds,
        }
      : item);
  return {
    ...turn,
    items,
    itemIndex: rebuildItemIndex(items),
    approvalMergeById,
  };
}

function applyApproval(turn: ConversationTurn, event: ConversationEvent): ConversationTurn {
  const data = event.data as ApprovalEventData;
  const approvalId = data.approvalId ?? data.itemId;
  const id = `approval:${approvalId ?? event.taskId ?? event.eventId}`;
  const incomingStatus = approvalTimelineStatus(data);
  const incomingPending = incomingStatus === 'blocked';
  if (incomingPending && turn.evidence.runTerminalAuthority === 'authoritative') {
    const terminalAt = turn.evidence.runTerminalMerge?.occurredAt ?? Number.NEGATIVE_INFINITY;
    const pendingBeforeCompletedTerminal = turn.evidence.runTerminal === 'completed'
      && data.actionable === true
      && ['desktop', 'exec', 'plugin'].includes(data.approvalKind ?? '')
      && event.occurredAt <= terminalAt;
    if (!pendingBeforeCompletedTerminal) return turn;
  }
  const fallbackAlias = taskFallbackApprovalAlias(turn, event, data, id, incomingStatus);
  const baseTurn = fallbackAlias
    ? convergeTaskFallbackApprovalAlias(turn, fallbackAlias, id)
    : turn;
  const currentIndex = baseTurn.itemIndex[id];
  const current = currentIndex == null ? undefined : baseTurn.items[currentIndex] as ApprovalItem;
  const currentTerminal = current != null && current.status !== 'blocked';
  const incomingTerminal = !incomingPending;
  const evidence = mergeEvidence(event, 'approval');
  const incoming: Partial<ApprovalMergeFields> = {
    approvalId,
    approvalKind: data.approvalKind,
    allowedDecisions: data.allowedDecisions,
    decision: data.decision,
    requestedAt: data.requestedAt,
    expiresAt: data.expiresAt,
    request: data.request,
    actionable: incomingPending ? data.actionable : false,
    resolutionSource: data.resolutionSource,
    itemId: data.itemId,
    title: data.title,
    legacyKind: data.kind,
    phase: data.phase,
    approvalStatus: data.status ?? data.decision,
    message: data.message,
    taskId: event.taskId,
    authority: event.authority,
    source: event.source,
    status: incomingStatus,
  };
  let mergeState = baseTurn.approvalMergeById[id];

  if (currentTerminal && incomingPending) {
    APPROVAL_TERMINAL_FIELDS.forEach((field) => {
      delete incoming[field];
    });
  } else if (current?.status === 'blocked' && incomingTerminal) {
    const fields = { ...(mergeState?.fields ?? {}) };
    APPROVAL_TERMINAL_FIELDS.forEach((field) => {
      delete fields[field];
    });
    mergeState = { fields };
  } else if (currentTerminal && incomingTerminal) {
    APPROVAL_TERMINAL_FIELDS.forEach((field) => {
      const incomingValue = incoming[field];
      const currentValue = current[field];
      if (incomingValue === undefined || currentValue === undefined || incomingValue === currentValue) return;
      const currentEvidence = mergeState?.fields[field];
      if (currentEvidence && mergeAuthorityRank(evidence, field) <= mergeAuthorityRank(currentEvidence, field)) {
        delete incoming[field];
      }
    });
  }

  const merged = mergeRecordFields(
    approvalMergeFields(current),
    incoming,
    mergeState,
    evidence,
  );
  const accepted = Object.values(merged.state.fields).some((fieldEvidence) => (
    fieldEvidence.eventId === event.eventId
  ));
  if (!accepted) return turn;

  const fields = merged.value;
  const status = fields.status ?? current?.status ?? incomingStatus;
  const approvalKind = fields.approvalKind;
  const allowedDecisions = fields.allowedDecisions ?? [];
  const supportsUserDecision = approvalKind === 'exec'
    || approvalKind === 'plugin'
    || approvalKind === 'desktop';
  const actionable = status === 'blocked'
    && supportsUserDecision
    && allowedDecisions.length > 0
    && (fields.actionable ?? false);
  const nextItem: ApprovalItem = {
    id,
    turnId: turn.id,
    kind: 'approval',
    approvalId: fields.approvalId,
    approvalKind,
    allowedDecisions,
    decision: fields.decision,
    requestedAt: fields.requestedAt,
    expiresAt: fields.expiresAt,
    request: fields.request,
    actionable,
    resolutionSource: fields.resolutionSource,
    itemId: fields.itemId,
    title: fields.title,
    legacyKind: fields.legacyKind,
    phase: fields.phase,
    approvalStatus: fields.approvalStatus,
    message: fields.message,
    taskId: fields.taskId,
    authority: fields.authority ?? current?.authority ?? event.authority,
    source: fields.source ?? current?.source ?? event.source,
    status,
    firstSeenAt: current?.firstSeenAt ?? event.occurredAt,
    updatedAt: Math.max(current?.updatedAt ?? 0, event.occurredAt),
    sourceEventIds: appendSource(current?.sourceEventIds ?? [], event.eventId),
    revision: (current?.revision ?? 0) + 1,
  };
  const updatedTurn = updateItem<ApprovalItem>(sealNarrativeItems(baseTurn), id, () => nextItem);
  return {
    ...updatedTurn,
    approvalMergeById: {
      ...updatedTurn.approvalMergeById,
      [id]: merged.state,
    },
  };
}

/** A task resuming after task-only waiting evidence closes the fallback row without inventing a user decision. */
function resolveTaskFallbackApproval(
  turn: ConversationTurn,
  event: ConversationEvent,
  task: ChatRuntimeTaskProjection,
): ConversationTurn {
  let changed = false;
  const approvalMergeById = { ...turn.approvalMergeById };
  const fallbackEvidence = mergeEvidence(event, 'run-fallback');
  const failed = task.status === 'error' || task.status === 'partial';
  const aborted = task.status === 'aborted';
  const items = turn.items.map((item) => {
    if (
      item.kind !== 'approval'
      || item.status !== 'blocked'
      || item.taskId !== task.taskId
      || item.approvalKind !== 'task'
    ) return item;
    changed = true;
    approvalMergeById[item.id] = withApprovalFallbackEvidence(
      approvalMergeById[item.id],
      fallbackEvidence,
    );
    return {
      ...item,
      status: aborted ? 'aborted' as const : failed ? 'error' as const : 'completed' as const,
      approvalStatus: aborted || failed ? 'cancelled' : 'resolved',
      actionable: false,
      authority: 'corroborating' as const,
      source: 'derived' as const,
      resolutionSource: 'task-state-transition' as const,
      updatedAt: Math.max(item.updatedAt, event.occurredAt),
      sourceEventIds: appendSource(item.sourceEventIds, event.eventId),
      revision: item.revision + 1,
    };
  });
  return changed
    ? {
        ...turn,
        items,
        approvalMergeById,
        updatedAt: Math.max(turn.updatedAt, event.occurredAt),
        revision: turn.revision + 1,
      }
    : turn;
}

function closePendingApprovals(
  turn: ConversationTurn,
  event: ConversationEvent,
  runStatus: 'completed' | 'error' | 'aborted',
): ConversationTurn {
  let changed = false;
  const approvalMergeById = { ...turn.approvalMergeById };
  const fallbackEvidence = mergeEvidence(event, 'run-fallback');
  const items = turn.items.map((item) => {
    if (item.kind !== 'approval' || item.status !== 'blocked') return item;
    // A successful model run may finish after reporting "waiting for approval".
    // Main-owned actionable approvals remain open until the broker resolves them.
    if (runStatus === 'completed' && item.actionable) return item;
    changed = true;
    approvalMergeById[item.id] = withApprovalFallbackEvidence(
      approvalMergeById[item.id],
      fallbackEvidence,
    );
    return {
      ...item,
      status: runStatus === 'aborted' ? 'aborted' as const : 'error' as const,
      approvalStatus: 'cancelled',
      actionable: false,
      resolutionSource: 'run-terminal' as const,
      // The run is authoritative that waiting ended, but not which approval
      // decision was made. Keep this fallback weaker than a late native resolve.
      authority: 'corroborating' as const,
      source: 'derived' as const,
      updatedAt: event.occurredAt,
      sourceEventIds: appendSource(item.sourceEventIds, event.eventId),
      revision: item.revision + 1,
    };
  });
  return changed
    ? {
        ...turn,
        items,
        approvalMergeById,
        updatedAt: Math.max(turn.updatedAt, event.occurredAt),
        revision: turn.revision + 1,
      }
    : turn;
}

function closePendingHistoryApprovals(
  turn: ConversationTurn,
  event: ConversationEvent,
): ConversationTurn {
  let changed = false;
  const approvalMergeById = { ...turn.approvalMergeById };
  const fallbackEvidence = mergeEvidence(event, 'run-fallback');
  const items = turn.items.map((item) => {
    if (item.kind !== 'approval' || item.status !== 'blocked' || item.actionable) return item;
    changed = true;
    approvalMergeById[item.id] = withApprovalFallbackEvidence(
      approvalMergeById[item.id],
      fallbackEvidence,
    );
    return {
      ...item,
      status: 'error' as const,
      approvalStatus: 'cancelled',
      actionable: false,
      resolutionSource: 'history-checkpoint' as const,
      authority: 'inferred' as const,
      source: 'derived' as const,
      updatedAt: Math.max(item.updatedAt, event.occurredAt),
      sourceEventIds: appendSource(item.sourceEventIds, event.eventId),
      revision: item.revision + 1,
    };
  });
  return changed
    ? {
        ...turn,
        items,
        approvalMergeById,
        updatedAt: Math.max(turn.updatedAt, event.occurredAt),
        revision: turn.revision + 1,
      }
    : turn;
}

function closePendingTools(
  turn: ConversationTurn,
  event: ConversationEvent,
  runStatus: 'completed' | 'error' | 'aborted',
): ConversationTurn {
  let changed = false;
  const toolMergeByCallId = { ...turn.toolMergeByCallId };
  const fallbackEvidence = mergeEvidence(event, 'run-fallback');
  const items = turn.items.map((item) => {
    if (item.kind !== 'tool-group' || !item.entries.some((entry) => entry.status === 'running')) return item;
    changed = true;
    const entries = item.entries.map((entry) => {
      if (entry.status !== 'running') return entry;
      toolMergeByCallId[entry.toolCallId] = {
        fields: {
          ...(toolMergeByCallId[entry.toolCallId]?.fields ?? {}),
          status: fallbackEvidence,
        },
      };
      return {
        ...entry,
        status: runStatus,
        updatedAt: Math.max(entry.updatedAt, event.occurredAt),
      };
    });
    const summary = toolGroupSummary(item.category, entries);
    return {
      ...item,
      entries,
      status: toolGroupStatus(entries),
      summaryKey: summary.key,
      summaryParams: summary.params,
      updatedAt: Math.max(item.updatedAt, event.occurredAt),
      sourceEventIds: appendSource(item.sourceEventIds, event.eventId),
      revision: item.revision + 1,
    };
  });
  return changed
    ? {
        ...turn,
        items,
        toolMergeByCallId,
        updatedAt: Math.max(turn.updatedAt, event.occurredAt),
        revision: turn.revision + 1,
      }
    : turn;
}

function closePendingTasks(
  turn: ConversationTurn,
  event: ConversationEvent,
  runStatus: 'completed' | 'error' | 'aborted',
): ConversationTurn {
  if (runStatus === 'completed') return turn;
  let changed = false;
  const taskById = { ...turn.taskById };
  const taskMergeById = { ...turn.taskMergeById };
  Object.values(taskById).forEach((task) => {
    if (!['pending', 'running', 'waiting_approval'].includes(task.status)) return;
    changed = true;
    taskById[task.taskId] = {
      ...task,
      status: runStatus === 'aborted' ? 'aborted' : 'error',
      terminalOutcome: task.terminalOutcome ?? runStatus,
      endedAt: task.endedAt ?? event.occurredAt,
      updatedAt: Math.max(task.updatedAt ?? 0, event.occurredAt),
    };
    taskMergeById[task.taskId] = {
      authority: event.authority,
      source: event.source,
      occurredAt: event.occurredAt,
      updatedAt: event.occurredAt,
    };
  });
  if (!changed) return turn;
  const items = turn.items.map((item) => {
    if (item.kind !== 'subtask') return item;
    const tasks = item.tasks.map((task) => taskById[task.taskId] ?? task);
    const summary = subtaskSummary(tasks);
    return {
      ...item,
      tasks,
      status: subtaskItemStatus(tasks),
      summaryKey: summary.key,
      summaryParams: summary.params,
      updatedAt: Math.max(item.updatedAt, event.occurredAt),
      sourceEventIds: appendSource(item.sourceEventIds, event.eventId),
      revision: item.revision + 1,
    };
  });
  return {
    ...turn,
    items,
    taskById,
    taskMergeById,
    updatedAt: Math.max(turn.updatedAt, event.occurredAt),
    revision: turn.revision + 1,
  };
}

/** Settle stale history-only tasks without outranking a later native terminal update. */
function closePendingHistoryTasks(
  turn: ConversationTurn,
  event: ConversationEvent,
): ConversationTurn {
  let changed = false;
  const taskById = { ...turn.taskById };
  const taskMergeById = { ...turn.taskMergeById };
  Object.values(taskById).forEach((task) => {
    if (!['pending', 'running', 'waiting_approval'].includes(task.status)) return;
    if (taskMergeById[task.taskId]?.source !== 'history') return;
    changed = true;
    taskById[task.taskId] = {
      ...task,
      status: 'error',
      terminalOutcome: task.terminalOutcome ?? 'interrupted',
      endedAt: task.endedAt ?? event.occurredAt,
      updatedAt: Math.max(task.updatedAt ?? 0, event.occurredAt),
    };
    taskMergeById[task.taskId] = {
      authority: 'inferred',
      source: 'synthetic',
      occurredAt: event.occurredAt,
      updatedAt: event.occurredAt,
    };
  });
  if (!changed) return turn;
  const items = turn.items.map((item) => {
    if (item.kind !== 'subtask') return item;
    const tasks = item.tasks.map((task) => taskById[task.taskId] ?? task);
    const summary = subtaskSummary(tasks);
    return {
      ...item,
      tasks,
      status: subtaskItemStatus(tasks),
      summaryKey: summary.key,
      summaryParams: summary.params,
      updatedAt: Math.max(item.updatedAt, event.occurredAt),
      sourceEventIds: appendSource(item.sourceEventIds, event.eventId),
      revision: item.revision + 1,
    };
  });
  return {
    ...turn,
    items,
    taskById,
    taskMergeById,
    updatedAt: Math.max(turn.updatedAt, event.occurredAt),
    revision: turn.revision + 1,
  };
}

type ArtifactAvailabilityEvidence = {
  availability: NonNullable<ChatRuntimeArtifact['availability']>;
  evidence: ConversationMergeEvidence;
};

/** Resolve persisted availability checks even when verification arrived before the artifact. */
function strongestArtifactAvailabilityEvidence(
  turn: ConversationTurn,
  artifact: ChatRuntimeArtifact,
): ArtifactAvailabilityEvidence | undefined {
  const artifactAliasSet = new Set(artifactAliases(artifact));
  let strongest: ArtifactAvailabilityEvidence | undefined;
  for (const item of turn.items) {
    if (item.kind !== 'verification-summary') continue;
    for (const verification of item.verifications) {
      const availability = artifactAvailabilityFromVerification(verification);
      if (!availability || !verificationArtifactAliases(verification).some((alias) => artifactAliasSet.has(alias))) {
        continue;
      }
      const verificationEntity = verificationAliases(verification)
        .map((alias) => turn.verificationEntityByAlias[alias])
        .find(Boolean)
        ?? verificationAliases(verification)[0];
      const verificationEvidence = verificationEntity
        ? turn.verificationMergeByEntity[verificationEntity]?.fields.status
        : undefined;
      if (!verificationEvidence) continue;
      const evidence: ConversationMergeEvidence = { ...verificationEvidence, domain: 'artifact' };
      if (!strongest || compareMergeEvidence(evidence, strongest.evidence, 'availability') > 0) {
        strongest = { availability, evidence };
      }
    }
  }
  return strongest;
}

type StoredArtifactEntityRecord = {
  entity: string;
  itemId: string;
  artifact: ChatRuntimeArtifact;
  mergeState: EntityMergeState | undefined;
};

/** Merge two persisted entity records using each field's original evidence. */
function mergeStoredEntityFields<T extends object>(
  current: T | undefined,
  incoming: T,
  state: EntityMergeState | undefined,
  incomingState: EntityMergeState | undefined,
  prefix = '',
): { value: T; state: EntityMergeState } {
  const value = { ...(current ?? {}) } as Record<string, unknown>;
  const fields = { ...(state?.fields ?? {}) };
  Object.entries(incoming as Record<string, unknown>).forEach(([field, incomingValue]) => {
    if (incomingValue === undefined) return;
    const fieldKey = `${prefix}${field}`;
    const incomingEvidence = incomingState?.fields[fieldKey];
    const existingEvidence = fields[fieldKey];
    if (
      value[field] === undefined
      || (
        incomingEvidence
        && (!existingEvidence || compareMergeEvidence(incomingEvidence, existingEvidence, fieldKey) > 0)
      )
    ) {
      value[field] = incomingValue;
      if (incomingEvidence) fields[fieldKey] = incomingEvidence;
    }
  });
  return { value: value as T, state: { fields } };
}

function artifactEntityForRecord(
  turn: ConversationTurn,
  itemId: string,
  artifact: ChatRuntimeArtifact,
  matchedEntities: Set<string>,
): string | undefined {
  const entities = [...new Set(artifactAliases(artifact).flatMap((alias) => {
    const mapped = turn.artifactEntityByAlias[alias];
    return [mapped, matchedEntities.has(alias) ? alias : undefined];
  }).filter((entity): entity is string => typeof entity === 'string' && matchedEntities.has(entity)))];
  return entities.find((entity) => turn.artifactItemByEntity[entity] === itemId) ?? entities[0];
}

/** Collapse previously separate entities when one artifact bridges more than one alias set. */
function unionArtifactEntities(
  turn: ConversationTurn,
  canonicalEntity: string,
  entities: string[],
): ConversationTurn {
  const matchedEntities = new Set(entities);
  if (matchedEntities.size < 2) return turn;

  const records: StoredArtifactEntityRecord[] = [];
  const removedArtifactsByItem = new Map<string, Set<ChatRuntimeArtifact>>();
  for (const item of turn.items) {
    if (item.kind !== 'artifact-group') continue;
    for (const artifact of item.artifacts) {
      const entity = artifactEntityForRecord(turn, item.id, artifact, matchedEntities);
      if (!entity) continue;
      records.push({
        entity,
        itemId: item.id,
        artifact,
        mergeState: turn.artifactMergeByEntity[entity],
      });
      const removed = removedArtifactsByItem.get(item.id) ?? new Set<ChatRuntimeArtifact>();
      removed.add(artifact);
      removedArtifactsByItem.set(item.id, removed);
    }
  }

  let mergedArtifact: ChatRuntimeArtifact | undefined;
  let mergedState: EntityMergeState | undefined;
  const orderedRecords = [
    ...records.filter((record) => record.entity === canonicalEntity),
    ...records.filter((record) => record.entity !== canonicalEntity),
  ];
  for (const record of orderedRecords) {
    const merged = mergeStoredEntityFields(
      mergedArtifact,
      record.artifact,
      mergedState,
      record.mergeState,
    );
    mergedArtifact = merged.value;
    mergedState = merged.state;
  }
  if (!mergedArtifact) return turn;

  const canonicalItemId = turn.artifactItemByEntity[canonicalEntity]
    ?? orderedRecords[0]?.itemId;
  if (!canonicalItemId) return turn;

  // A file change with the same normalized path belongs to the merged artifact.
  const removedChangesByItem = new Map<string, Set<ConversationFileChange>>();
  const changesToMerge: Array<{
    change: ConversationFileChange;
    mergeState: EntityMergeState | undefined;
  }> = [];
  for (const item of turn.items) {
    if (item.kind !== 'artifact-group') continue;
    for (const change of item.changes) {
      const pathAlias = `path:${change.filePath.trim().replace(/\\/gu, '/')}`;
      const entity = turn.artifactEntityByAlias[pathAlias];
      if (!entity || !matchedEntities.has(entity)) continue;
      changesToMerge.push({ change, mergeState: turn.artifactMergeByEntity[entity] });
      const removed = removedChangesByItem.get(item.id) ?? new Set<ConversationFileChange>();
      removed.add(change);
      removedChangesByItem.set(item.id, removed);
    }
  }

  const mergedChanges: ConversationFileChange[] = [];
  for (const record of changesToMerge) {
    const index = mergedChanges.findIndex((change) => change.filePath === record.change.filePath);
    const merged = mergeStoredEntityFields(
      index < 0 ? undefined : mergedChanges[index],
      record.change,
      mergedState,
      record.mergeState,
      'change.',
    );
    mergedState = merged.state;
    if (index < 0) mergedChanges.push(merged.value);
    else mergedChanges[index] = merged.value;
  }

  const itemWillBeRemoved = new Set<string>();
  for (const item of turn.items) {
    if (item.kind !== 'artifact-group' || item.id === canonicalItemId) continue;
    const remainingArtifacts = item.artifacts.filter((artifact) => !removedArtifactsByItem.get(item.id)?.has(artifact));
    const remainingChanges = item.changes.filter((change) => !removedChangesByItem.get(item.id)?.has(change));
    if (remainingArtifacts.length === 0 && remainingChanges.length === 0) itemWillBeRemoved.add(item.id);
  }

  const canonicalItem = turn.items[turn.itemIndex[canonicalItemId]];
  const sourceItems = turn.items.filter((item) => (
    item.id === canonicalItemId
    || removedArtifactsByItem.has(item.id)
    || removedChangesByItem.has(item.id)
  ));
  const sourceEventIds = sourceItems.reduce(
    (current, item) => item.sourceEventIds.reduce(appendSource, current),
    [] as string[],
  );
  const firstSeenAt = sourceItems.reduce(
    (current, item) => Math.min(current, item.firstSeenAt),
    canonicalItem?.firstSeenAt ?? turn.updatedAt,
  );
  const updatedAt = sourceItems.reduce(
    (current, item) => Math.max(current, item.updatedAt),
    canonicalItem?.updatedAt ?? turn.updatedAt,
  );
  const revision = sourceItems.reduce(
    (current, item) => Math.max(current, item.revision),
    canonicalItem?.revision ?? 0,
  ) + 1;

  const items = turn.items.flatMap((item): TimelineItem[] => {
    if (item.kind !== 'artifact-group') return [item];
    const removedArtifacts = removedArtifactsByItem.get(item.id);
    const removedChanges = removedChangesByItem.get(item.id);
    if (item.id === canonicalItemId) {
      const firstRemovedIndex = item.artifacts.findIndex((artifact) => removedArtifacts?.has(artifact));
      const remainingArtifacts = item.artifacts.filter((artifact) => !removedArtifacts?.has(artifact));
      const insertAt = firstRemovedIndex < 0 ? remainingArtifacts.length : Math.min(firstRemovedIndex, remainingArtifacts.length);
      const artifacts = [
        ...remainingArtifacts.slice(0, insertAt),
        mergedArtifact,
        ...remainingArtifacts.slice(insertAt),
      ];
      const remainingChanges = item.changes.filter((change) => !removedChanges?.has(change));
      const changes = [...remainingChanges, ...mergedChanges];
      return [{
        ...item,
        artifacts,
        changes,
        status: artifactItemStatus(artifacts),
        firstSeenAt,
        updatedAt,
        sourceEventIds,
        revision,
      }];
    }

    const artifacts = item.artifacts.filter((artifact) => !removedArtifacts?.has(artifact));
    const changes = item.changes.filter((change) => !removedChanges?.has(change));
    if (artifacts.length === 0 && changes.length === 0) return [];
    if (artifacts.length === item.artifacts.length && changes.length === item.changes.length) return [item];
    return [{
      ...item,
      artifacts,
      changes,
      status: artifactItemStatus(artifacts),
      revision: item.revision + 1,
    }];
  });

  const artifactEntityByAlias = { ...turn.artifactEntityByAlias };
  Object.entries(artifactEntityByAlias).forEach(([alias, entity]) => {
    if (matchedEntities.has(entity)) artifactEntityByAlias[alias] = canonicalEntity;
  });
  const artifactItemByEntity = { ...turn.artifactItemByEntity };
  const artifactMergeByEntity = { ...turn.artifactMergeByEntity };
  matchedEntities.forEach((entity) => {
    if (entity === canonicalEntity) return;
    delete artifactItemByEntity[entity];
    delete artifactMergeByEntity[entity];
  });
  artifactItemByEntity[canonicalEntity] = canonicalItemId;
  artifactMergeByEntity[canonicalEntity] = mergedState ?? { fields: {} };

  return {
    ...turn,
    items,
    itemIndex: rebuildItemIndex(items),
    artifactEntityByAlias,
    artifactItemByEntity,
    artifactMergeByEntity,
    revision: turn.revision + 1,
  };
}

function applyArtifact(turn: ConversationTurn, event: ConversationEvent): ConversationTurn {
  const data = event.data as { artifact: ChatRuntimeArtifact; change?: ConversationFileChange };
  const artifact = data.artifact;
  const aliases = artifactAliases(artifact);
  const matchedEntities = [...new Set(aliases
    .map((alias) => turn.artifactEntityByAlias[alias])
    .filter((entity): entity is string => Boolean(entity)))];
  const entity = matchedEntities[0]
    ?? aliases[0]
    ?? `id:${artifact.id}`;
  const reconciledTurn = unionArtifactEntities(turn, entity, matchedEntities);
  const id = reconciledTurn.artifactItemByEntity[entity]
    ?? `artifacts:${event.taskId ?? event.toolCallId ?? turn.id}`;
  const evidence = mergeEvidence(event, 'artifact');
  let nextMerge = reconciledTurn.artifactMergeByEntity[entity];
  let mergedArtifact = artifact;
  const updated = updateItem<ArtifactGroupItem>(reconciledTurn, id, (current) => {
    const existing = current?.artifacts ?? [];
    const index = existing.findIndex((item) => artifactAliases(item).some((alias) => (
      alias === entity || reconciledTurn.artifactEntityByAlias[alias] === entity
    )));
    const merged = mergeRecordFields(index < 0 ? undefined : existing[index], artifact, nextMerge, evidence);
    const availabilityEvidence = strongestArtifactAvailabilityEvidence(reconciledTurn, merged.value);
    if (
      availabilityEvidence
      && (
        !merged.state.fields.availability
        || compareMergeEvidence(
          availabilityEvidence.evidence,
          merged.state.fields.availability,
          'availability',
        ) > 0
      )
    ) {
      merged.value = { ...merged.value, availability: availabilityEvidence.availability };
      merged.state = {
        fields: {
          ...merged.state.fields,
          availability: availabilityEvidence.evidence,
        },
      };
    }
    nextMerge = merged.state;
    mergedArtifact = merged.value;
    const artifacts = index < 0
      ? [...existing, merged.value]
      : existing.map((item, itemIndex) => (itemIndex === index ? merged.value : item));
    const existingChanges = current?.changes ?? [];
    const changeIndex = data.change
      ? existingChanges.findIndex((change) => change.filePath === data.change!.filePath)
      : -1;
    let changes = existingChanges;
    if (data.change) {
      const mergedChange = mergeRecordFields(
        changeIndex < 0 ? undefined : existingChanges[changeIndex],
        data.change,
        nextMerge,
        evidence,
        'change.',
      );
      nextMerge = mergedChange.state;
      changes = changeIndex < 0
        ? [...existingChanges, mergedChange.value]
        : existingChanges.map((change, itemIndex) => (itemIndex === changeIndex ? mergedChange.value : change));
    }
    return {
      id,
      turnId: reconciledTurn.id,
      kind: 'artifact-group',
      artifacts,
      changes,
      status: artifactItemStatus(artifacts),
      firstSeenAt: current?.firstSeenAt ?? event.occurredAt,
      updatedAt: Math.max(current?.updatedAt ?? event.occurredAt, event.occurredAt),
      sourceEventIds: appendSource(current?.sourceEventIds ?? [], event.eventId),
      revision: (current?.revision ?? 0) + 1,
    };
  });
  const artifactEntityByAlias = { ...updated.artifactEntityByAlias };
  [...aliases, ...artifactAliases(mergedArtifact)].forEach((alias) => {
    artifactEntityByAlias[alias] = entity;
  });
  return releaseDeferredFinal({
    ...updated,
    artifactEntityByAlias,
    artifactItemByEntity: { ...updated.artifactItemByEntity, [entity]: id },
    artifactMergeByEntity: {
      ...updated.artifactMergeByEntity,
      [entity]: nextMerge ?? { fields: {} },
    },
  });
}

/** Apply a structured availability check to an already-registered artifact. */
function applyArtifactAvailabilityVerification(
  turn: ConversationTurn,
  event: ConversationEvent,
  verification: ChatRuntimeVerification,
): ConversationTurn {
  const availability = artifactAvailabilityFromVerification(verification);
  const targetAliases = new Set(verificationArtifactAliases(verification));
  if (!availability || targetAliases.size === 0) return turn;

  const evidence = mergeEvidence(event, 'artifact');
  const artifactMergeByEntity = { ...turn.artifactMergeByEntity };
  let changed = false;
  const items = turn.items.map((item) => {
    if (item.kind !== 'artifact-group') return item;
    let groupChanged = false;
    const artifacts = item.artifacts.map((artifact) => {
      const aliases = artifactAliases(artifact);
      if (!aliases.some((alias) => targetAliases.has(alias))) return artifact;
      const entity = aliases.map((alias) => turn.artifactEntityByAlias[alias]).find(Boolean)
        ?? aliases[0];
      if (!entity) return artifact;
      const mergeState = artifactMergeByEntity[entity] ?? { fields: {} };
      const currentEvidence = mergeState.fields.availability;
      if (currentEvidence && compareMergeEvidence(evidence, currentEvidence, 'availability') <= 0) {
        return artifact;
      }
      changed = true;
      groupChanged = true;
      artifactMergeByEntity[entity] = {
        fields: { ...mergeState.fields, availability: evidence },
      };
      return { ...artifact, availability };
    });
    if (!groupChanged) return item;
    return {
      ...item,
      artifacts,
      status: artifactItemStatus(artifacts),
      updatedAt: Math.max(item.updatedAt, event.occurredAt),
      sourceEventIds: appendSource(item.sourceEventIds, event.eventId),
      revision: item.revision + 1,
    };
  });
  if (!changed) return turn;
  return {
    ...turn,
    items,
    artifactMergeByEntity,
    updatedAt: Math.max(turn.updatedAt, event.occurredAt),
    revision: turn.revision + 1,
  };
}

function applyVerification(turn: ConversationTurn, event: ConversationEvent): ConversationTurn {
  const verification = (event.data as { verification: ChatRuntimeVerification }).verification;
  const aliases = verificationAliases(verification);
  const entity = aliases.map((alias) => turn.verificationEntityByAlias[alias]).find(Boolean)
    ?? aliases[0]
    ?? `id:${verification.id}`;
  const id = turn.verificationItemByEntity[entity] ?? `verification:${event.taskId ?? turn.id}`;
  const evidence = mergeEvidence(event, 'verification');
  let nextMerge = turn.verificationMergeByEntity[entity];
  let mergedVerification = verification;
  const updated = updateItem<VerificationSummaryItem>(turn, id, (current) => {
    const existing = current?.verifications ?? [];
    const index = existing.findIndex((item) => verificationAliases(item).some((alias) => (
      alias === entity || turn.verificationEntityByAlias[alias] === entity
    )));
    const merged = mergeRecordFields(index < 0 ? undefined : existing[index], verification, nextMerge, evidence);
    nextMerge = merged.state;
    mergedVerification = merged.value;
    const verifications = index < 0
      ? [...existing, merged.value]
      : existing.map((item, itemIndex) => (itemIndex === index ? merged.value : item));
    const failed = verifications.some((item) => item.status === 'failed' || item.status === 'blocked');
    return {
      id,
      turnId: turn.id,
      kind: 'verification-summary',
      verifications,
      status: failed ? 'error' : 'completed',
      firstSeenAt: current?.firstSeenAt ?? event.occurredAt,
      updatedAt: Math.max(current?.updatedAt ?? event.occurredAt, event.occurredAt),
      sourceEventIds: appendSource(current?.sourceEventIds ?? [], event.eventId),
      revision: (current?.revision ?? 0) + 1,
    };
  });
  const verificationEntityByAlias = { ...updated.verificationEntityByAlias };
  [...aliases, ...verificationAliases(mergedVerification)].forEach((alias) => {
    verificationEntityByAlias[alias] = entity;
  });
  const verifiedTurn: ConversationTurn = {
    ...updated,
    verificationEntityByAlias,
    verificationItemByEntity: { ...updated.verificationItemByEntity, [entity]: id },
    verificationMergeByEntity: {
      ...updated.verificationMergeByEntity,
      [entity]: nextMerge ?? { fields: {} },
    },
  };
  return applyArtifactAvailabilityVerification(verifiedTurn, event, mergedVerification);
}

function messageVisibleText(message: ConversationMessageSnapshot): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return [];
      const value = block as { type?: unknown; text?: unknown };
      return value.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
    })
    .join('\n\n');
}

function hasPendingTasks(turn: ConversationTurn): boolean {
  return Object.values(turn.taskById).some((task) => (
    task.status === 'pending'
    || task.status === 'running'
    || task.status === 'waiting_approval'
  ));
}

function hasArtifactTimelineOwner(turn: ConversationTurn): boolean {
  return turn.items.some((item) => item.kind === 'artifact-group' && item.artifacts.length > 0);
}

function hasMediaTask(turn: ConversationTurn): boolean {
  return Object.values(turn.taskById).some((task) => (
    /(?:image|video|music|media)[_-]?(?:generate|edit|render)/iu.test(
      `${task.runtime ?? ''} ${task.title ?? ''}`,
    )
  ));
}

function isOwnerRunFinal(turn: ConversationTurn, event: ConversationEvent): boolean {
  const ownerRunId = event.rootRunId ?? turn.rootRunId;
  return !event.runId || !ownerRunId || event.runId === ownerRunId;
}

function isMediaCompletionFinal(event: ConversationEvent): boolean {
  return /^(?:image_generate|image_edit|video_generate|music_generate):[^:]+:/iu.test(event.runId ?? '');
}

function applyFinalAsCommentary(turn: ConversationTurn, event: ConversationEvent): ConversationTurn {
  const message = messageData(event);
  const text = message ? messageVisibleText(message).trim() : '';
  if (!text) return turn;
  return applyNarrative(turn, {
    ...event,
    type: 'assistant.content',
    data: { text, replace: true, phase: 'async-task-continuation' },
  }, 'commentary');
}

function deferFinal(turn: ConversationTurn, event: ConversationEvent): ConversationTurn {
  const current = turn.deferredFinal;
  if (current && compareMergeEvidence(
    mergeEvidence(event, 'final'),
    mergeEvidence(current, 'final'),
  ) <= 0) {
    return turn;
  }
  return {
    ...turn,
    deferredFinal: event,
    updatedAt: Math.max(turn.updatedAt, event.occurredAt),
    revision: turn.revision + 1,
  };
}

/** Replace only assistant text blocks while preserving attachment and media evidence. */
function withMessageVisibleText(
  message: ConversationMessageSnapshot,
  text: string,
): ConversationMessageSnapshot {
  if (typeof message.content === 'string') return { ...message, content: text };
  if (!Array.isArray(message.content)) return message;

  let replaced = false;
  const content = message.content.flatMap((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return [block];
    const record = block as Record<string, unknown>;
    if (record.type !== 'text') return [block];
    if (replaced) return [];
    replaced = true;
    return [{ ...record, text }];
  });
  if (!replaced) content.unshift({ type: 'text', text });
  return { ...message, content };
}

/** Apply the same exact ordered process-prefix fold used by history replay. */
function normalizeFinalNarrative(
  turn: ConversationTurn,
  message: ConversationMessageSnapshot,
): ConversationMessageSnapshot {
  const fullText = messageVisibleText(message).trim();
  if (!fullText) return message;
  const processSegments = turn.items.flatMap((item) => (
    item.kind === 'commentary' && item.origin === 'assistant' ? [item.text] : []
  ));
  const finalText = stripProcessMessagePrefix(fullText, processSegments);
  return finalText === fullText ? message : withMessageVisibleText(message, finalText);
}

function removeDuplicateAssistantNarrative(
  turn: ConversationTurn,
  message: ConversationMessageSnapshot,
): { turn: ConversationTurn; narrative?: CommentaryItem } {
  const finalText = messageVisibleText(message);
  if (!finalText) return { turn };
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.kind !== 'commentary' || item.origin !== 'assistant') continue;
    if (item.text !== finalText) return { turn };
    const items = turn.items.filter((_, itemIndex) => itemIndex !== index);
    return {
      narrative: item,
      turn: {
        ...turn,
        items,
        itemIndex: rebuildItemIndex(items),
        revision: turn.revision + 1,
      },
    };
  }
  return { turn };
}

function applyFinalNow(turn: ConversationTurn, event: ConversationEvent): ConversationTurn {
  const message = messageData(event);
  if (!message) return turn;
  const id = `final:${turn.id}`;
  const currentIndex = turn.itemIndex[id];
  const current = currentIndex == null ? undefined : turn.items[currentIndex] as FinalAnswerItem;
  const normalizedMessage = normalizeFinalNarrative(turn, message);
  const merged = mergeRecordFields(current?.message, normalizedMessage, turn.finalMerge, mergeEvidence(event, 'final'));
  const deduplicated = removeDuplicateAssistantNarrative(sealNarrativeItems(turn), merged.value);
  const updated = updateItem<FinalAnswerItem>(deduplicated.turn, id, (existing) => ({
    id,
    turnId: turn.id,
    kind: 'final-answer',
    message: merged.value,
    authoritative: existing?.authoritative === true || event.authority === 'authoritative',
    status: 'completed',
    firstSeenAt: existing?.firstSeenAt ?? deduplicated.narrative?.firstSeenAt ?? event.occurredAt,
    updatedAt: Math.max(existing?.updatedAt ?? event.occurredAt, event.occurredAt),
    sourceEventIds: appendSource([
      ...(existing?.sourceEventIds ?? []),
      ...(deduplicated.narrative?.sourceEventIds ?? []),
    ], event.eventId),
    revision: (existing?.revision ?? 0) + 1,
  }));
  return { ...updated, finalMerge: merged.state, deferredFinal: undefined };
}

function releaseDeferredFinal(turn: ConversationTurn): ConversationTurn {
  const event = turn.deferredFinal;
  if (!event || hasPendingTasks(turn)) return turn;
  if (isMediaCompletionFinal(event) && hasMediaTask(turn) && !hasArtifactTimelineOwner(turn)) return turn;
  return applyFinalNow(turn, event);
}

function applyFinal(turn: ConversationTurn, event: ConversationEvent): ConversationTurn {
  if (event.source === 'history') return applyFinalNow(turn, event);
  if (hasPendingTasks(turn)) {
    return isOwnerRunFinal(turn, event)
      ? applyFinalAsCommentary(turn, event)
      : deferFinal(turn, event);
  }
  if (isMediaCompletionFinal(event) && hasMediaTask(turn) && !hasArtifactTimelineOwner(turn)) {
    return deferFinal(turn, event);
  }
  return applyFinalNow(turn, event);
}

function demotePrematureFinalForTask(
  turn: ConversationTurn,
  event: ConversationEvent,
): ConversationTurn {
  const finalIndex = turn.items.findIndex((item) => item.kind === 'final-answer');
  if (finalIndex < 0) return turn;
  const final = turn.items[finalIndex] as FinalAnswerItem;
  const text = messageVisibleText(final.message).trim();
  const duplicateCommentary = text
    ? turn.items.find((item) => item.kind === 'commentary' && item.text === text)
    : undefined;
  const items = duplicateCommentary || !text
    ? turn.items.filter((_, index) => index !== finalIndex)
    : turn.items.map((item, index) => index === finalIndex
      ? {
          id: `commentary:${final.message.id ?? final.id}:pre-task`,
          turnId: turn.id,
          kind: 'commentary' as const,
          text,
          sealed: true,
          origin: 'assistant' as const,
          status: 'completed' as const,
          firstSeenAt: final.firstSeenAt,
          updatedAt: Math.max(final.updatedAt, event.occurredAt),
          sourceEventIds: final.sourceEventIds,
          revision: final.revision + 1,
        }
      : item);
  return {
    ...turn,
    items,
    itemIndex: rebuildItemIndex(items),
    finalMerge: { fields: {} },
    updatedAt: Math.max(turn.updatedAt, event.occurredAt),
    revision: turn.revision + 1,
  };
}

/** Settle interactive work when authoritative backend liveness reports the session idle. */
function applySessionActivityToTurn(
  turn: ConversationTurn,
  event: ConversationEvent,
  active: boolean,
): ConversationTurn {
  let next = turn;
  if (!active) {
    // Backend idle proves that interactive tool/approval work ended, but it does
    // not invent a failure outcome. These weak fallbacks remain correctable by
    // later native terminal evidence.
    next = closePendingTools(next, event, 'completed');
    next = closePendingHistoryTasks(next, event);
    next = closePendingApprovals(next, event, 'aborted');
    next = sealNarrativeItems(next);
  }
  return {
    ...next,
    evidence: { ...next.evidence, backendIdle: !active },
    revision: next.revision + 1,
  };
}

/**
 * OpenClaw can finish a run after streaming only runtime assistant content,
 * without emitting the companion chat final envelope. In that case the last
 * unsealed assistant segment is the delivered answer, not progress commentary.
 */
function promoteAssistantNarrativeToFinal(turn: ConversationTurn, event: ConversationEvent): ConversationTurn {
  if (hasPendingTasks(turn)) return turn;
  if (turn.items.some((item) => item.kind === 'final-answer')) return turn;
  let candidateIndex = -1;
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (
      item.kind === 'commentary'
      && item.origin === 'assistant'
      && !item.sealed
      && item.text.trim().length > 0
    ) {
      candidateIndex = index;
      break;
    }
  }
  if (candidateIndex < 0) return turn;
  const candidate = turn.items[candidateIndex] as CommentaryItem;
  const id = `final:${turn.id}`;
  const message: ConversationMessageSnapshot = {
    role: 'assistant',
    id: `runtime-final:${turn.id}`,
    content: candidate.text,
    timestamp: candidate.updatedAt,
  };
  const merged = mergeRecordFields(
    undefined,
    message,
    turn.finalMerge,
    mergeEvidence(event, 'run-fallback'),
  );
  const finalItem: FinalAnswerItem = {
    id,
    turnId: turn.id,
    kind: 'final-answer',
    message,
    authoritative: false,
    status: 'completed',
    firstSeenAt: candidate.firstSeenAt,
    updatedAt: event.occurredAt,
    sourceEventIds: appendSource(candidate.sourceEventIds, event.eventId),
    revision: candidate.revision + 1,
  };
  const items = turn.items.filter((_, index) => index !== candidateIndex);
  items.push(finalItem);
  return {
    ...turn,
    items,
    itemIndex: rebuildItemIndex(items),
    finalMerge: merged.state,
    updatedAt: Math.max(turn.updatedAt, event.occurredAt),
    revision: turn.revision + 1,
  };
}

function applyError(turn: ConversationTurn, event: ConversationEvent): ConversationTurn {
  const data = event.data as { error: string; recoverable?: boolean };
  const id = `error:${turn.id}`;
  return updateItem<ErrorItem>(sealNarrativeItems(turn), id, (current) => ({
    id,
    turnId: turn.id,
    kind: 'error',
    message: data.error,
    recoverable: data.recoverable ?? false,
    // Recoverable describes the available user command, not an open lifecycle.
    status: 'error',
    firstSeenAt: current?.firstSeenAt ?? event.occurredAt,
    updatedAt: event.occurredAt,
    sourceEventIds: appendSource(current?.sourceEventIds ?? [], event.eventId),
    revision: (current?.revision ?? 0) + 1,
  }));
}

function recomputeEvidence(turn: ConversationTurn): ConversationTurn {
  const tools = turn.items.flatMap((item) => item.kind === 'tool-group' ? item.entries : []);
  const tasks = Object.values(turn.taskById);
  const approvals = turn.items.filter((item) => item.kind === 'approval');
  const artifacts = turn.items.flatMap((item) => item.kind === 'artifact-group' ? item.artifacts : []);
  const verifications = turn.items.flatMap((item) => item.kind === 'verification-summary' ? item.verifications : []);
  const requiredAvailabilityChecks = verifications.filter((verification) => (
    verification.required === true && verification.kind === 'artifact.availability'
  ));
  const evidence = {
    ...turn.evidence,
    finalMessagePresent: turn.items.some((item) => item.kind === 'final-answer'),
    pendingToolCount: tools.filter((tool) => tool.status === 'running').length,
    pendingTaskCount: tasks.filter((task) => ['pending', 'running', 'waiting_approval'].includes(task.status)).length,
    pendingApprovalCount: approvals.filter((item) => item.status === 'blocked').length,
    requiredArtifactsSatisfied: requiredAvailabilityChecks.every((verification) => verification.status === 'passed'),
    blockingVerificationFailed: verifications.some((verification) => (
      verification.required === true
      && (verification.status === 'failed' || verification.status === 'blocked')
      && (verification.severity === 'blocking' || verification.severity == null)
    )),
  };
  const hasArtifacts = artifacts.length > 0;
  const artifactDeliveryFailed = artifacts.some((artifact) => (
    artifact.availability === 'unavailable'
    || artifact.availability === 'error'
    || Boolean(artifact.error)
  ));
  const hasTerminalError = turn.items.some((item) => item.kind === 'error' && item.status === 'error');
  const desktopApprovalSettled = approvals.some((approval) => {
    if (approval.approvalKind !== 'desktop' || approval.resolutionSource !== 'desktop-broker') return false;
    const status = approval.approvalStatus?.trim().toLowerCase();
    return status === 'denied' || status === 'expired' || status === 'consumed';
  });
  const historyApprovalSettled = approvals.some((approval) => (
    approval.resolutionSource === 'history-checkpoint'
    && approval.status !== 'blocked'
  ));
  const terminalPendingTaskCount = evidence.terminalPendingTaskIds.filter((taskId) => {
    const task = turn.taskById[taskId];
    return task && ['pending', 'running', 'waiting_approval'].includes(task.status);
  }).length;
  const authoritativeTerminal = evidence.runTerminal != null
    && evidence.runTerminalAuthority === 'authoritative';
  let status = turn.status === 'waiting_approval' && evidence.pendingApprovalCount === 0
    ? 'running'
    : turn.status;
  let settledAt = turn.settledAt;
  if (authoritativeTerminal && evidence.runTerminal === 'aborted') {
    status = 'aborted';
    settledAt ??= turn.updatedAt;
  } else if (authoritativeTerminal && (
    evidence.runTerminal === 'error'
    || hasTerminalError
    || evidence.blockingVerificationFailed
    || !evidence.requiredArtifactsSatisfied
    || artifactDeliveryFailed
  )) {
    status = 'error';
    settledAt ??= turn.updatedAt;
  } else if (authoritativeTerminal && terminalPendingTaskCount > 0) {
    status = 'running';
  } else if (authoritativeTerminal && evidence.pendingApprovalCount > 0) {
    status = 'waiting_approval';
  } else if (authoritativeTerminal) {
    status = evidence.finalMessagePresent || hasArtifacts ? 'completed' : 'error';
    settledAt ??= turn.updatedAt;
  } else if (evidence.pendingApprovalCount > 0) {
    status = 'waiting_approval';
  } else if (evidence.runTerminal === 'aborted') {
    status = 'aborted';
    settledAt ??= turn.updatedAt;
  } else if (
    evidence.runTerminal === 'error'
    || hasTerminalError
    || evidence.blockingVerificationFailed
    || ((evidence.runTerminal || evidence.backendIdle) && (
      !evidence.requiredArtifactsSatisfied || artifactDeliveryFailed
    ))
  ) {
    status = 'error';
    settledAt ??= turn.updatedAt;
  } else if (
    desktopApprovalSettled
    && evidence.pendingToolCount === 0
    && evidence.pendingTaskCount === 0
    && evidence.pendingApprovalCount === 0
  ) {
    // Desktop approvals are Main-owned and do not resume the model after the
    // broker reaches a terminal state, so the decision itself closes the Turn.
    status = 'completed';
    settledAt ??= turn.updatedAt;
  } else if (historyApprovalSettled && evidence.historyCheckpointed && !turn.hasLiveEvidence) {
    status = evidence.finalMessagePresent || hasArtifacts ? 'completed' : 'error';
    settledAt ??= turn.updatedAt;
  } else if (evidence.pendingTaskCount > 0 && evidence.runTerminal) {
    status = 'running';
  } else if (evidence.pendingToolCount > 0 || evidence.pendingTaskCount > 0) {
    status = 'running';
  } else if (
    evidence.runTerminal
    || evidence.backendIdle
    || (evidence.historyCheckpointed && !turn.hasLiveEvidence)
  ) {
    if (evidence.finalMessagePresent || hasArtifacts) {
      if (
        (evidence.historyCheckpointed && !turn.hasLiveEvidence)
        || evidence.backendIdle
        || evidence.runTerminalAuthority === 'authoritative'
      ) {
        status = 'completed';
        settledAt ??= turn.updatedAt;
      } else {
        status = 'running';
      }
    } else if (evidence.runTerminal) {
      status = 'error';
      settledAt ??= turn.updatedAt;
    } else if (evidence.backendIdle) {
      // Backend idle is authoritative that an interrupted/restored interactive
      // run no longer owns the composer, even when history has no final answer.
      status = 'completed';
      settledAt ??= turn.updatedAt;
    }
  } else if (turn.status === 'queued' && turn.items.length > 1) {
    status = 'running';
  }
  if (status === turn.status && settledAt === turn.settledAt && JSON.stringify(evidence) === JSON.stringify(turn.evidence)) {
    return turn;
  }
  return { ...turn, evidence, status, settledAt, revision: turn.revision + 1 };
}

function applyEventToTurn(turn: ConversationTurn, event: ConversationEvent): ConversationTurn {
  let next = turn;
  switch (event.type) {
    case 'turn.requested': {
      const message = messageData(event);
      if (!message) break;
      const id = turn.trigger.id;
      const currentIndex = turn.itemIndex[id];
      const current = currentIndex == null ? undefined : turn.items[currentIndex] as UserMessageItem;
      const trigger: UserMessageItem = {
        ...(current ?? turn.trigger),
        message,
        updatedAt: event.occurredAt,
        sourceEventIds: appendSource(current?.sourceEventIds ?? [], event.eventId),
        revision: (current?.revision ?? 0) + 1,
      };
      if (currentIndex == null) {
        const items = [trigger, ...turn.items];
        next = {
          ...turn,
          trigger,
          items,
          itemIndex: rebuildItemIndex(items),
          updatedAt: Math.max(turn.updatedAt, event.occurredAt),
          revision: turn.revision + 1,
        };
      } else {
        next = updateItem<UserMessageItem>(turn, id, () => trigger);
        next = { ...next, trigger };
      }
      break;
    }
    case 'run.started':
      next = { ...turn, status: 'running', rootRunId: turn.rootRunId ?? event.runId, revision: turn.revision + 1 };
      break;
    case 'run.ended': {
      const data = event.data as { status: 'completed' | 'error' | 'aborted'; backendIdle?: boolean };
      const incomingMerge = mergeEvidence(event, 'run');
      const existingMerge = turn.evidence.runTerminalMerge;
      if (existingMerge && compareMergeEvidence(incomingMerge, existingMerge) <= 0) break;
      const deliveredTurn = data.status === 'completed' && event.authority === 'authoritative'
        ? promoteAssistantNarrativeToFinal(turn, event)
        : turn;
      let terminalTurn = deliveredTurn;
      if (event.authority === 'authoritative') {
        terminalTurn = closePendingTools(terminalTurn, event, data.status);
        terminalTurn = data.status === 'completed'
          ? closePendingHistoryTasks(terminalTurn, event)
          : closePendingTasks(terminalTurn, event, data.status);
        terminalTurn = closePendingApprovals(terminalTurn, event, data.status);
      }
      const terminalPendingTaskIds = data.status === 'completed'
        ? Object.values(terminalTurn.taskById)
            .filter((task) => ['pending', 'running', 'waiting_approval'].includes(task.status))
            .map((task) => task.taskId)
        : [];
      next = {
        ...sealNarrativeItems(terminalTurn),
        evidence: {
          ...terminalTurn.evidence,
          runTerminal: data.status,
          runTerminalAuthority: event.authority,
          runTerminalSource: event.source,
          runTerminalMerge: incomingMerge,
          backendIdle: terminalTurn.evidence.backendIdle || data.backendIdle === true,
          terminalPendingTaskIds,
        },
        revision: terminalTurn.revision + 1,
      };
      break;
    }
    case 'assistant.content':
      next = applyNarrative(turn, event, 'commentary');
      break;
    case 'commentary.append':
      if (event.timelineVisibility !== 'diagnostics') next = applyNarrative(turn, event, 'commentary');
      break;
    case 'thinking.content':
      next = applyNarrative(turn, event, 'thinking');
      break;
    case 'tool.started':
    case 'tool.updated':
    case 'tool.completed':
      next = event.timelineVisibility === 'diagnostics'
        ? removeToolTimelineOwner(turn, event)
        : applyTool(turn, event);
      break;
    case 'task.updated':
      next = applyTask(turn, event);
      break;
    case 'plan.updated':
    case 'step.updated':
      if (event.timelineVisibility !== 'diagnostics') next = applyPlan(turn, event);
      break;
    case 'approval.updated':
      next = applyApproval(turn, event);
      break;
    case 'artifact.updated':
      next = applyArtifact(turn, event);
      break;
    case 'verification.updated':
      next = applyVerification(turn, event);
      break;
    case 'final.message':
      next = applyFinal(turn, event);
      break;
    case 'turn.error':
      next = applyError(turn, event);
      break;
    case 'session.activity': {
      const data = event.data as { active: boolean };
      next = applySessionActivityToTurn(turn, event, data.active);
      break;
    }
    case 'history.checkpoint':
      break;
    case 'progress.updated':
      next = applyProgress(turn, event);
      break;
  }
  const runAliases = [event.rootRunId, event.runId]
    .filter((value): value is string => Boolean(value))
    .reduce((aliases, runId) => aliases.includes(runId) ? aliases : [...aliases, runId], next.runAliases);
  next = {
    ...next,
    runAliases,
    rootRunId: next.rootRunId ?? event.rootRunId ?? event.runId,
    updatedAt: Math.max(next.updatedAt, event.occurredAt),
  };
  const boundaryAware = splitToolGroupsAtCanonicalBoundaries(next);
  return recomputeEvidence(reorderTurnItemsByCanonicalTime(boundaryAware));
}

/** Copy large state indexes once for the whole ingress batch. */
function createConversationDraft(state: ConversationState): ConversationState {
  return {
    noSequenceDedupeByScope: { ...state.noSequenceDedupeByScope },
    quarantineBySession: { ...state.quarantineBySession },
    ingressDiagnosticsBySession: { ...state.ingressDiagnosticsBySession },
    eventsByTurnId: { ...state.eventsByTurnId },
    eventRetentionByTurnId: { ...state.eventRetentionByTurnId },
    turnOrderBySession: { ...state.turnOrderBySession },
    turnsById: { ...state.turnsById },
    aliases: {
      byRunId: { ...state.aliases.byRunId },
      byTaskId: { ...state.aliases.byTaskId },
      byToolCallId: { ...state.aliases.byToolCallId },
      byMessageId: { ...state.aliases.byMessageId },
      activeBySession: { ...state.aliases.activeBySession },
      pendingLocalBySession: { ...state.aliases.pendingLocalBySession },
    },
  };
}

function noSequenceDedupeScopeKey(sessionKey: string, scope = 'session'): string {
  return createSessionAliasKey(sessionKey, scope);
}

function markNoSequenceEvent(
  state: ConversationState,
  event: ConversationEvent,
  scopeKey: string,
  mutableScopes: Set<string>,
): boolean {
  if (event.seq != null) return false;
  const current = state.noSequenceDedupeByScope[scopeKey];
  if (current?.eventIds[event.eventId]) {
    incrementIngressDiagnostic(state, event.sessionKey, 'duplicateCount');
    return true;
  }
  const bucket = current && mutableScopes.has(scopeKey)
    ? current
    : {
        eventIds: { ...(current?.eventIds ?? {}) },
        eventOrder: [...(current?.eventOrder ?? [])],
      };
  bucket.eventIds[event.eventId] = true;
  bucket.eventOrder.push(event.eventId);
  while (bucket.eventOrder.length > NO_SEQUENCE_DEDUPE_LIMIT) {
    const removed = bucket.eventOrder.shift();
    if (removed) delete bucket.eventIds[removed];
  }
  state.noSequenceDedupeByScope[scopeKey] = bucket;
  mutableScopes.add(scopeKey);
  return false;
}

function quarantineUnknownRun(
  state: ConversationState,
  event: ConversationEvent,
  runId: string,
): boolean {
  const current = state.quarantineBySession[event.sessionKey];
  if (current?.records.some((record) => record.eventId === event.eventId)) {
    incrementIngressDiagnostic(state, event.sessionKey, 'duplicateCount');
    return true;
  }
  const records = [
    ...(current?.records ?? []),
    {
      eventId: event.eventId,
      type: event.type,
      source: event.source,
      authority: event.authority,
      reason: 'unknown-run' as const,
      runId,
      taskId: event.taskId,
      toolCallId: event.toolCallId,
      occurredAt: event.occurredAt,
      receivedAt: event.receivedAt,
    },
  ];
  const droppedNow = Math.max(0, records.length - QUARANTINE_EVENT_LIMIT);
  state.quarantineBySession[event.sessionKey] = {
    records: droppedNow > 0 ? records.slice(-QUARANTINE_EVENT_LIMIT) : records,
    droppedCount: (current?.droppedCount ?? 0) + droppedNow,
  };
  incrementIngressDiagnostic(state, event.sessionKey, 'quarantineCount');
  appendAssignmentDiagnostic(state, event, {
    basis: 'quarantine',
    confidence: 'low',
  });
  return true;
}

/** Retain a bounded raw-event tail plus a monotonic diagnostic checkpoint. */
function appendRetainedEvent(
  state: ConversationState,
  turn: ConversationTurn,
  event: ConversationEvent,
): boolean {
  const existing = state.eventsByTurnId[turn.id] ?? [];
  if (existing.some((item) => item.eventId === event.eventId && item.sessionKey === event.sessionKey)) return false;
  const normalized = { ...event, turnId: turn.id };
  const checkpoint = state.eventRetentionByTurnId[turn.id];
  const cap = isTerminalTurn(turn) ? TERMINAL_EVENT_TAIL_LIMIT : ACTIVE_EVENT_TAIL_LIMIT;
  const appended = [...existing, normalized];
  const droppedNow = Math.max(0, appended.length - cap);
  state.eventsByTurnId[turn.id] = droppedNow > 0 ? appended.slice(-cap) : appended;
  state.eventRetentionByTurnId[turn.id] = {
    totalEventCount: (checkpoint?.totalEventCount ?? existing.length) + 1,
    droppedEventCount: (checkpoint?.droppedEventCount ?? 0) + droppedNow,
    firstOccurredAt: Math.min(checkpoint?.firstOccurredAt ?? existing[0]?.occurredAt ?? event.occurredAt, event.occurredAt),
    lastOccurredAt: Math.max(checkpoint?.lastOccurredAt ?? existing.at(-1)?.occurredAt ?? event.occurredAt, event.occurredAt),
    lastEventId: event.eventId,
  };
  return true;
}

function compactTerminalEventTail(state: ConversationState, turn: ConversationTurn): boolean {
  if (!isTerminalTurn(turn)) return false;
  const existing = state.eventsByTurnId[turn.id] ?? [];
  if (existing.length <= TERMINAL_EVENT_TAIL_LIMIT) return false;
  const droppedNow = existing.length - TERMINAL_EVENT_TAIL_LIMIT;
  state.eventsByTurnId[turn.id] = existing.slice(-TERMINAL_EVENT_TAIL_LIMIT);
  const checkpoint = state.eventRetentionByTurnId[turn.id];
  if (checkpoint) {
    state.eventRetentionByTurnId[turn.id] = {
      ...checkpoint,
      droppedEventCount: checkpoint.droppedEventCount + droppedNow,
    };
  }
  return true;
}

/** Only a checkpoint-completed history Turn may be corrected by later live liveness. */
function canReopenHistoryCheckpointedTurn(turn: ConversationTurn): boolean {
  return turn.status === 'completed'
    && turn.evidence.historyCheckpointed
    && !turn.hasLiveEvidence
    && turn.evidence.runTerminal == null;
}

function latestHistoryCheckpointedTurnId(
  state: ConversationState,
  sessionKey: string,
): string | undefined {
  const turnIds = state.turnOrderBySession[sessionKey] ?? [];
  if (turnIds.some((turnId) => {
    const turn = state.turnsById[turnId];
    return turn && !isTerminalTurn(turn);
  })) return undefined;
  for (let index = turnIds.length - 1; index >= 0; index -= 1) {
    const turnId = turnIds[index];
    const turn = state.turnsById[turnId];
    if (turn && canReopenHistoryCheckpointedTurn(turn)) return turnId;
  }
  return undefined;
}

function reopenHistoryCheckpointedTurn(
  turn: ConversationTurn,
  event: ConversationEvent,
): ConversationTurn {
  return recomputeEvidence({
    ...turn,
    status: 'running',
    settledAt: undefined,
    hasLiveEvidence: true,
    evidence: { ...turn.evidence, backendIdle: false },
    updatedAt: Math.max(turn.updatedAt, event.occurredAt),
    revision: turn.revision + 1,
  });
}

function applyCheckpoint(state: ConversationState, event: ConversationEvent): boolean {
  const turnIds = state.turnOrderBySession[event.sessionKey] ?? [];
  if (turnIds.length === 0) return true;
  let changed = false;
  turnIds.forEach((turnId) => {
    const turn = state.turnsById[turnId];
    if (!turn) return;
    // A history checkpoint can settle a history-only orphan, but it must not
    // close a live turn whose backend lifecycle or idle evidence is pending.
    if (turn.hasLiveEvidence) {
      changed = compactTerminalEventTail(state, turn) || changed;
      return;
    }
    if (turn.evidence.historyCheckpointed) {
      changed = compactTerminalEventTail(state, turn) || changed;
      return;
    }
    const checkpointed = closePendingHistoryApprovals(turn, event);
    const next = recomputeEvidence({
      ...checkpointed,
      evidence: { ...checkpointed.evidence, historyCheckpointed: true },
      updatedAt: Math.max(checkpointed.updatedAt, event.occurredAt),
      revision: checkpointed.revision + 1,
    });
    state.turnsById[turnId] = next;
    changed ||= next !== turn;
    changed = compactTerminalEventTail(state, next) || changed;
  });
  const lastTurnId = turnIds[turnIds.length - 1];
  const lastTurn = state.turnsById[lastTurnId];
  if (lastTurn && isTerminalTurn(lastTurn) && state.aliases.activeBySession[event.sessionKey]) {
    delete state.aliases.activeBySession[event.sessionKey];
    changed = true;
  }
  return changed;
}

/** Apply session liveness, correcting only the latest checkpoint-completed history Turn. */
function applySessionActivity(state: ConversationState, event: ConversationEvent): boolean {
  const data = event.data as { active: boolean };
  const turnIds = state.turnOrderBySession[event.sessionKey] ?? [];
  if (data.active) {
    const activeTurnId = state.aliases.activeBySession[event.sessionKey];
    const activeTurn = activeTurnId ? state.turnsById[activeTurnId] : undefined;
    if (!activeTurn || isTerminalTurn(activeTurn)) {
      const historyTurnId = latestHistoryCheckpointedTurnId(state, event.sessionKey);
      const historyTurn = historyTurnId ? state.turnsById[historyTurnId] : undefined;
      if (historyTurnId && historyTurn) {
        state.turnsById[historyTurnId] = reopenHistoryCheckpointedTurn(historyTurn, event);
        state.aliases.activeBySession[event.sessionKey] = historyTurnId;
      }
    }
  }
  turnIds.forEach((turnId) => {
    const turn = state.turnsById[turnId];
    if (!turn || isTerminalTurn(turn) || turn.evidence.backendIdle === !data.active) return;
    // A deferred local request does not own the session run slot until it has
    // runtime evidence. Session idle for the preceding run must not settle it.
    const isUnownedQueuedRequest = turn.status === 'queued'
      && turn.runAliases.length === 0
      && turn.items.every((item) => item.kind === 'user-message');
    if (!data.active && isUnownedQueuedRequest) return;
    state.turnsById[turnId] = recomputeEvidence({
      ...applySessionActivityToTurn(turn, event, data.active),
      updatedAt: Math.max(turn.updatedAt, event.occurredAt),
    });
  });
  const activeTurnId = state.aliases.activeBySession[event.sessionKey];
  const activeTurn = activeTurnId ? state.turnsById[activeTurnId] : undefined;
  if (activeTurn && isTerminalTurn(activeTurn)) {
    delete state.aliases.activeBySession[event.sessionKey];
  }
  const pendingTurnId = state.aliases.pendingLocalBySession[event.sessionKey];
  const pendingTurn = pendingTurnId ? state.turnsById[pendingTurnId] : undefined;
  if (pendingTurn && isTerminalTurn(pendingTurn)) {
    delete state.aliases.pendingLocalBySession[event.sessionKey];
  }
  return true;
}

function reduceConversationEventInto(
  state: ConversationState,
  event: ConversationEvent,
  mutableNoSequenceScopes: Set<string>,
): boolean {
  const sessionScoped = !event.turnId
    && !event.rootRunId
    && !event.runId
    && !event.messageId
    && !event.taskId
    && !event.toolCallId;
  if (event.type === 'history.checkpoint' && !event.turnId) {
    if (markNoSequenceEvent(
      state,
      event,
      noSequenceDedupeScopeKey(event.sessionKey),
      mutableNoSequenceScopes,
    )) return true;
    return applyCheckpoint(state, event);
  }
  if (event.type === 'session.activity' && sessionScoped) {
    if (markNoSequenceEvent(
      state,
      event,
      noSequenceDedupeScopeKey(event.sessionKey),
      mutableNoSequenceScopes,
    )) return true;
    return applySessionActivity(state, event);
  }
  const message = event.type === 'turn.requested' ? messageData(event) : null;
  let turnAssignment = resolveTurnAssignment(state, event);
  let resolved = turnAssignment?.turnId;
  const runId = event.rootRunId ?? event.runId;
  const activeSessionActivity = event.type === 'session.activity'
    && (event.data as { active?: boolean }).active === true;
  if (
    !resolved
    && event.source !== 'history'
    && (event.type === 'run.started' || activeSessionActivity)
  ) {
    resolved = latestHistoryCheckpointedTurnId(state, event.sessionKey);
    if (resolved) {
      turnAssignment = {
        turnId: resolved,
        basis: 'history-liveness',
        confidence: 'medium',
      };
    }
  }
  const activeTurnId = state.aliases.activeBySession[event.sessionKey];
  const activeTurn = activeTurnId ? state.turnsById[activeTurnId] : undefined;
  const nativeApprovalWithoutOwner = event.type === 'approval.updated'
    && (event.source === 'openclaw-runtime' || event.source === 'plugin')
    && Boolean(runId && /^approval:(?:exec|plugin):/u.test(runId));
  const unknownRunConflictsWithActiveTurn = Boolean(activeTurn && !isTerminalTurn(activeTurn));
  if (!resolved
    && runId
    && event.type !== 'run.started'
    && event.type !== 'turn.requested'
    && (unknownRunConflictsWithActiveTurn || nativeApprovalWithoutOwner)) {
    const scopeKey = noSequenceDedupeScopeKey(event.sessionKey, 'quarantine');
    if (markNoSequenceEvent(state, event, scopeKey, mutableNoSequenceScopes)) return true;
    return quarantineUnknownRun(state, event, runId);
  }
  if (!resolved && runId && event.type === 'session.activity') {
    const scopeKey = noSequenceDedupeScopeKey(event.sessionKey, 'quarantine');
    if (markNoSequenceEvent(state, event, scopeKey, mutableNoSequenceScopes)) return true;
    return quarantineUnknownRun(state, event, runId);
  }
  if (!resolved && event.type === 'task.updated' && event.source === 'task-ledger') {
    const taskRunId = runId ?? event.runId ?? (event.taskId ? `task:${event.taskId}` : 'task:unknown');
    const scopeKey = noSequenceDedupeScopeKey(event.sessionKey, 'quarantine');
    if (markNoSequenceEvent(state, event, scopeKey, mutableNoSequenceScopes)) return true;
    return quarantineUnknownRun(state, event, taskRunId);
  }
  const resolvedTurnId = resolved ?? createTurnId({
      sessionKey: event.sessionKey,
      messageId: event.messageId,
      runId,
      timestamp: event.occurredAt,
      content: message?.content ?? event.data,
    });
  if (markNoSequenceEvent(
    state,
    event,
    noSequenceDedupeScopeKey(event.sessionKey, `turn:${resolvedTurnId}`),
    mutableNoSequenceScopes,
  )) return true;
  appendAssignmentDiagnostic(state, event, turnAssignment ?? {
    turnId: resolvedTurnId,
    basis: 'created-turn',
    confidence: event.type === 'turn.requested' || event.type === 'run.started' ? 'medium' : 'low',
  });
  const existing = state.turnsById[resolvedTurnId];
  let turn = existing ?? createTurn(resolvedTurnId, event, message ?? undefined);
  const firstLiveEvidence = event.source !== 'history' && !turn.hasLiveEvidence;
  if (firstLiveEvidence) {
    const shouldReopen = canReopenHistoryCheckpointedTurn(turn)
      && (event.type === 'run.started' || activeSessionActivity);
    turn = {
      ...turn,
      hasLiveEvidence: true,
      ...(shouldReopen ? { status: 'running' as const, settledAt: undefined } : {}),
    };
  }
  const normalizedEvent = { ...event, turnId: resolvedTurnId };
  const sequenceStream = event.seq == null ? undefined : eventSequenceStreamKey(normalizedEvent);
  const watermark = sequenceStream ? turn.sequenceWatermarks[sequenceStream] : undefined;
  if (event.seq != null && watermark != null && event.seq <= watermark) {
    incrementIngressDiagnostic(
      state,
      event.sessionKey,
      event.seq === watermark ? 'duplicateCount' : 'staleSequenceCount',
    );
    appendRetainedEvent(state, turn, normalizedEvent);
    return true;
  }
  const projectionStartedAt = conversationPerformanceNow();
  let nextTurn = applyEventToTurn(turn, normalizedEvent);
  recordConversationDuration('projection', conversationPerformanceNow() - projectionStartedAt);
  if (sequenceStream && event.seq != null) {
    nextTurn = {
      ...nextTurn,
      sequenceWatermarks: { ...nextTurn.sequenceWatermarks, [sequenceStream]: event.seq },
    };
  }
  const sessionOrder = state.turnOrderBySession[event.sessionKey] ?? [];
  if (!sessionOrder.includes(resolvedTurnId)) {
    state.turnOrderBySession[event.sessionKey] = [...sessionOrder, resolvedTurnId];
  }
  const runIds = [event.rootRunId, event.runId].filter((value): value is string => Boolean(value));
  runIds.forEach((runId) => {
    state.aliases.byRunId[createSessionAliasKey(event.sessionKey, runId)] = resolvedTurnId;
  });
  if (event.taskId) {
    state.aliases.byTaskId[createSessionAliasKey(event.sessionKey, event.taskId)] = resolvedTurnId;
  }
  if (event.toolCallId) {
    state.aliases.byToolCallId[createSessionAliasKey(event.sessionKey, event.toolCallId)] = resolvedTurnId;
  }
  if (event.messageId) {
    state.aliases.byMessageId[createSessionAliasKey(event.sessionKey, event.messageId)] = resolvedTurnId;
  }
  const isLocalRequest = event.type === 'turn.requested'
    && event.source === 'host'
    && Boolean(message);
  const activatesLocalRequest = isLocalRequest
    && (event.data as { activate?: boolean }).activate !== false;
  if (activatesLocalRequest) {
    state.aliases.pendingLocalBySession[event.sessionKey] = resolvedTurnId;
  } else if (runIds.length > 0
    && state.aliases.pendingLocalBySession[event.sessionKey] === resolvedTurnId) {
    delete state.aliases.pendingLocalBySession[event.sessionKey];
  }
  if (isTerminalTurn(nextTurn)) {
    if (state.aliases.activeBySession[event.sessionKey] === resolvedTurnId) {
      delete state.aliases.activeBySession[event.sessionKey];
    }
    if (state.aliases.pendingLocalBySession[event.sessionKey] === resolvedTurnId) {
      delete state.aliases.pendingLocalBySession[event.sessionKey];
    }
  } else if (!isLocalRequest || activatesLocalRequest) {
    state.aliases.activeBySession[event.sessionKey] = resolvedTurnId;
  }
  state.turnsById[resolvedTurnId] = nextTurn;
  appendRetainedEvent(state, nextTurn, normalizedEvent);
  return true;
}

export function reduceConversationEvent(state: ConversationState, event: ConversationEvent): ConversationState {
  return reduceConversationEvents(state, [event]);
}

export function reduceConversationEvents(state: ConversationState, events: ConversationEvent[]): ConversationState {
  if (events.length === 0) return state;
  const draft = createConversationDraft(state);
  const mutableNoSequenceScopes = new Set<string>();
  let changed = false;
  events.forEach((event) => {
    changed = reduceConversationEventInto(draft, event, mutableNoSequenceScopes) || changed;
  });
  return changed ? draft : state;
}

const HISTORY_TURN_ALIGNMENT_WINDOW_MS = 60_000;

function messageTimestampMs(message: ConversationMessageSnapshot, fallback: number): number {
  const value = message.timestamp;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value < 100_000_000_000 ? value * 1_000 : value;
}

function messageAlignmentFingerprint(message: ConversationMessageSnapshot): string {
  return stableHash({
    role: message.role,
    content: message.content,
    attachments: message.attachments?.map((attachment) => ({
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
    })),
  });
}

type HistoryTurnAlignment = {
  historyTurnId: string;
  liveTurnId: string;
  eventIds: string[];
};

/** Align persisted server message IDs to a unique optimistic Turn without fuzzy text matching. */
function alignHistoryTurnsToLiveState(
  state: ConversationState,
  sessionKey: string,
  historyEvents: ConversationEvent[],
): { events: ConversationEvent[]; alignments: HistoryTurnAlignment[] } {
  const currentTurnIds = state.turnOrderBySession[sessionKey] ?? [];
  const candidatesByFingerprint = new Map<string, ConversationTurn[]>();
  currentTurnIds.forEach((turnId) => {
    const turn = state.turnsById[turnId];
    if (!turn?.hasLiveEvidence || turn.sessionKey !== sessionKey) return;
    const fingerprint = messageAlignmentFingerprint(turn.trigger.message);
    const candidates = candidatesByFingerprint.get(fingerprint) ?? [];
    candidates.push(turn);
    candidatesByFingerprint.set(fingerprint, candidates);
  });
  if (candidatesByFingerprint.size === 0) return { events: historyEvents, alignments: [] };

  const eventsByTurnId = new Map<string, ConversationEvent[]>();
  historyEvents.forEach((event) => {
    if (!event.turnId) return;
    const events = eventsByTurnId.get(event.turnId) ?? [];
    events.push(event);
    eventsByTurnId.set(event.turnId, events);
  });
  const usedLiveTurnIds = new Set<string>();
  const alignedTurnIds = new Map<string, string>();
  const alignments: HistoryTurnAlignment[] = [];

  for (const [historyTurnId, events] of eventsByTurnId) {
    if (state.turnsById[historyTurnId]?.sessionKey === sessionKey) continue;
    const requested = events.find((event) => event.type === 'turn.requested');
    const message = requested ? messageData(requested) : null;
    if (!requested || !message) continue;
    const historyAt = messageTimestampMs(message, requested.occurredAt);
    const candidates = (candidatesByFingerprint.get(messageAlignmentFingerprint(message)) ?? [])
      .filter((turn) => !usedLiveTurnIds.has(turn.id))
      .map((turn) => ({
        turn,
        distance: Math.abs(messageTimestampMs(turn.trigger.message, turn.createdAt) - historyAt),
      }))
      .filter((candidate) => candidate.distance <= HISTORY_TURN_ALIGNMENT_WINDOW_MS)
      .sort((left, right) => (
        left.distance - right.distance
        || left.turn.createdAt - right.turn.createdAt
        || left.turn.id.localeCompare(right.turn.id)
      ));
    const closest = candidates[0];
    if (!closest || (candidates[1] && candidates[1].distance === closest.distance)) continue;
    alignedTurnIds.set(historyTurnId, closest.turn.id);
    usedLiveTurnIds.add(closest.turn.id);
    alignments.push({
      historyTurnId,
      liveTurnId: closest.turn.id,
      eventIds: events.map((event) => event.eventId),
    });
  }
  if (alignedTurnIds.size === 0) return { events: historyEvents, alignments: [] };
  return {
    events: historyEvents.map((event) => {
      const turnId = event.turnId ? alignedTurnIds.get(event.turnId) : undefined;
      return turnId ? { ...event, turnId } : event;
    }),
    alignments,
  };
}

function historyReplayFingerprint(events: ConversationEvent[]): string {
  return stableHash(events.map((event) => {
    const {
      eventId: _eventId,
      occurredAt: _occurredAt,
      receivedAt: _receivedAt,
      ...stableEvent
    } = event;
    return stableEvent;
  }));
}

function sameTurnOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((turnId, index) => turnId === right[index]);
}

const HISTORY_TIMELINE_EVENT_TYPES: Record<TimelineItem['kind'], Set<ConversationEvent['type']>> = {
  'user-message': new Set(['turn.requested']),
  thinking: new Set(['thinking.content']),
  commentary: new Set(['assistant.content', 'commentary.append', 'progress.updated']),
  plan: new Set(['plan.updated', 'step.updated']),
  'tool-group': new Set(['tool.started', 'tool.updated', 'tool.completed']),
  subtask: new Set(['task.updated']),
  approval: new Set(['approval.updated']),
  'artifact-group': new Set(['artifact.updated']),
  'verification-summary': new Set(['verification.updated']),
  'final-answer': new Set(['final.message']),
  error: new Set(['turn.error']),
};

/** Resolve the persisted position owned by this Timeline item kind. */
function historyTimelineItemTime(
  item: TimelineItem,
  historyEventById: Map<string, ConversationEvent>,
  historyEvents: ConversationEvent[],
): number {
  const ownedTypes = HISTORY_TIMELINE_EVENT_TYPES[item.kind];
  const ownedOccurredAt = item.sourceEventIds
    .map((eventId) => historyEventById.get(eventId))
    .filter((event): event is ConversationEvent => Boolean(event && ownedTypes.has(event.type)))
    .reduce<number | undefined>((earliest, event) => (
      earliest == null ? event.occurredAt : Math.min(earliest, event.occurredAt)
    ), undefined);
  if (ownedOccurredAt != null) return ownedOccurredAt;

  const fallbackTypes = item.kind === 'artifact-group'
    ? new Set<ConversationEvent['type']>([...ownedTypes, 'final.message'])
    : ownedTypes;
  return historyEvents.find((event) => fallbackTypes.has(event.type))?.occurredAt ?? item.firstSeenAt;
}

/** Let authoritative transcript time repair a wrong live insertion order. */
function reorderHistoryEnrichedTurn(
  turn: ConversationTurn,
  historyEvents: ConversationEvent[],
): ConversationTurn {
  const historyEventById = new Map(historyEvents.map((event) => [event.eventId, event]));
  const items = turn.items
    .map((item, index) => ({
      item,
      index,
      historyTime: historyTimelineItemTime(item, historyEventById, historyEvents),
    }))
    .sort((left, right) => (
      timelineTerminalRank(left.item) - timelineTerminalRank(right.item)
      || left.historyTime - right.historyTime
      || TIMELINE_ITEM_TIE_RANK[left.item.kind] - TIMELINE_ITEM_TIE_RANK[right.item.kind]
      || left.index - right.index
    ))
    .map(({ item }) => item);
  if (items.every((item, index) => item === turn.items[index])) return turn;
  return {
    ...turn,
    items,
    itemIndex: rebuildItemIndex(items),
    revision: turn.revision + 1,
  };
}

export function replaceSessionTurns(
  state: ConversationState,
  sessionKey: string,
  historyEvents: ConversationEvent[],
): ConversationState {
  // History is an enrichment source for live turns, so preserve their reduced
  // projection instead of attempting to reconstruct it from a compacted tail.
  const currentTurnIds = state.turnOrderBySession[sessionKey] ?? [];
  const alignedHistory = alignHistoryTurnsToLiveState(state, sessionKey, historyEvents);
  const replayInputEvents = alignedHistory.events;
  const historyEventsByTurnId = new Map<string, ConversationEvent[]>();
  replayInputEvents.forEach((event) => {
    if (!event.turnId) return;
    const events = historyEventsByTurnId.get(event.turnId) ?? [];
    events.push(event);
    historyEventsByTurnId.set(event.turnId, events);
  });
  const historyTurnIds = [...historyEventsByTurnId.keys()];
  const historyFingerprintByTurnId = new Map(
    historyTurnIds.map((turnId) => [
      turnId,
      historyReplayFingerprint(historyEventsByTurnId.get(turnId) ?? []),
    ]),
  );
  const historyTurnSet = new Set(historyTurnIds);
  const liveOnlyTurnIds = currentTurnIds.filter((turnId) => (
    !historyTurnSet.has(turnId) && state.turnsById[turnId]?.hasLiveEvidence
  ));
  const nextTurnIds = [...historyTurnIds, ...liveOnlyTurnIds];
  const retainedTurnIds = new Set(nextTurnIds);
  const removedTurnIds = new Set(currentTurnIds.filter((turnId) => !retainedTurnIds.has(turnId)));
  const changedHistoryTurnIds = new Set(historyTurnIds.filter((turnId) => (
    state.turnsById[turnId]?.historyReplayFingerprint !== historyFingerprintByTurnId.get(turnId)
  )));
  const historyOrderRepairTurnIds = new Set(historyTurnIds.filter((turnId) => {
    const turn = state.turnsById[turnId];
    return Boolean(turn && reorderHistoryEnrichedTurn(
      turn,
      historyEventsByTurnId.get(turnId) ?? [],
    ) !== turn);
  }));
  const hasUnownedReplayEvidence = replayInputEvents.some((event) => (
    !event.turnId && event.type !== 'history.checkpoint'
  ));
  if (
    removedTurnIds.size === 0
    && changedHistoryTurnIds.size === 0
    && historyOrderRepairTurnIds.size === 0
    && !hasUnownedReplayEvidence
    && sameTurnOrder(currentTurnIds, nextTurnIds)
  ) {
    return state;
  }
  const base = createConversationDraft(state);
  alignedHistory.alignments.forEach((alignment) => {
    replayInputEvents
      .filter((event) => event.turnId === alignment.liveTurnId && alignment.eventIds.includes(event.eventId))
      .forEach((event) => appendAssignmentDiagnostic(base, event, {
        turnId: alignment.liveTurnId,
        basis: 'history-content-time',
        confidence: 'medium',
      }));
  });

  removedTurnIds.forEach((turnId) => {
    delete base.turnsById[turnId];
    delete base.eventsByTurnId[turnId];
    delete base.eventRetentionByTurnId[turnId];
  });
  base.turnOrderBySession[sessionKey] = nextTurnIds;
  Object.entries(base.aliases.byRunId).forEach(([key, turnId]) => {
    if (removedTurnIds.has(turnId)) delete base.aliases.byRunId[key];
  });
  Object.entries(base.aliases.byTaskId).forEach(([key, turnId]) => {
    if (removedTurnIds.has(turnId)) delete base.aliases.byTaskId[key];
  });
  Object.entries(base.aliases.byToolCallId).forEach(([key, turnId]) => {
    if (removedTurnIds.has(turnId)) delete base.aliases.byToolCallId[key];
  });
  Object.entries(base.aliases.byMessageId).forEach(([key, turnId]) => {
    if (removedTurnIds.has(turnId)) delete base.aliases.byMessageId[key];
  });
  if (removedTurnIds.has(base.aliases.activeBySession[sessionKey])) {
    delete base.aliases.activeBySession[sessionKey];
  }
  if (removedTurnIds.has(base.aliases.pendingLocalBySession[sessionKey])) {
    delete base.aliases.pendingLocalBySession[sessionKey];
  }

  // Only changed Turns need their history dedupe scope reopened. Unchanged
  // completed Turns retain their reducer and renderer identity.
  changedHistoryTurnIds.forEach((turnId) => {
    delete base.noSequenceDedupeByScope[noSequenceDedupeScopeKey(sessionKey, `turn:${turnId}`)];
  });
  const replayEvents = replayInputEvents.filter((event) => (
    !event.turnId
    || changedHistoryTurnIds.has(event.turnId)
  ));
  let next = reduceConversationEvents(base, replayEvents);
  let turnsById = next.turnsById;
  let turnsChanged = false;
  new Set([...changedHistoryTurnIds, ...historyOrderRepairTurnIds]).forEach((turnId) => {
    const turn = turnsById[turnId];
    if (!turn) return;
    const reordered = reorderHistoryEnrichedTurn(turn, historyEventsByTurnId.get(turnId) ?? []);
    if (reordered === turn) return;
    if (!turnsChanged) turnsById = { ...turnsById };
    turnsById[turnId] = reordered;
    turnsChanged = true;
  });
  let fingerprintsChanged = false;
  historyFingerprintByTurnId.forEach((fingerprint, turnId) => {
    const turn = turnsById[turnId];
    if (!turn || turn.historyReplayFingerprint === fingerprint) return;
    if (!fingerprintsChanged) turnsById = { ...turnsById };
    turnsById[turnId] = { ...turn, historyReplayFingerprint: fingerprint };
    fingerprintsChanged = true;
  });
  if (turnsChanged || fingerprintsChanged) next = { ...next, turnsById };
  return next;
}

/** Remove one session and every canonical index that can retain its data. */
export function removeConversationSession(
  state: ConversationState,
  sessionKey: string,
): ConversationState {
  const turnIds = new Set(state.turnOrderBySession[sessionKey] ?? []);
  Object.values(state.turnsById).forEach((turn) => {
    if (turn.sessionKey === sessionKey) turnIds.add(turn.id);
  });
  Object.entries(state.eventsByTurnId).forEach(([turnId, events]) => {
    if (events.some((event) => event.sessionKey === sessionKey)) turnIds.add(turnId);
  });

  const next = createConversationDraft(state);
  delete next.turnOrderBySession[sessionKey];
  delete next.quarantineBySession[sessionKey];
  delete next.ingressDiagnosticsBySession[sessionKey];
  Object.keys(next.noSequenceDedupeByScope).forEach((scopeKey) => {
    if (sessionAliasKeyBelongsTo(scopeKey, sessionKey)) {
      delete next.noSequenceDedupeByScope[scopeKey];
    }
  });
  turnIds.forEach((turnId) => {
    delete next.turnsById[turnId];
    delete next.eventsByTurnId[turnId];
    delete next.eventRetentionByTurnId[turnId];
  });
  const removeAliases = (aliases: Record<string, string>) => {
    Object.entries(aliases).forEach(([key, turnId]) => {
      if (turnIds.has(turnId) || sessionAliasKeyBelongsTo(key, sessionKey)) {
        delete aliases[key];
      }
    });
  };
  removeAliases(next.aliases.byRunId);
  removeAliases(next.aliases.byTaskId);
  removeAliases(next.aliases.byToolCallId);
  removeAliases(next.aliases.byMessageId);
  delete next.aliases.activeBySession[sessionKey];
  delete next.aliases.pendingLocalBySession[sessionKey];
  return next;
}

export function assertConversationState(state: ConversationState): void {
  Object.entries(state.noSequenceDedupeByScope).forEach(([scopeKey, bucket]) => {
    if (bucket.eventOrder.length > NO_SEQUENCE_DEDUPE_LIMIT) {
      throw new Error(`Conversation no-sequence dedupe scope ${scopeKey} exceeded its retention limit`);
    }
    if (new Set(bucket.eventOrder).size !== bucket.eventOrder.length) {
      throw new Error(`Conversation no-sequence dedupe scope ${scopeKey} contains duplicate keys`);
    }
    if (bucket.eventOrder.some((eventId) => !bucket.eventIds[eventId])
      || Object.keys(bucket.eventIds).length !== bucket.eventOrder.length) {
      throw new Error(`Conversation no-sequence dedupe scope ${scopeKey} has an inconsistent index`);
    }
  });
  Object.entries(state.quarantineBySession).forEach(([sessionKey, bucket]) => {
    if (bucket.records.length > QUARANTINE_EVENT_LIMIT) {
      throw new Error(`Conversation quarantine for ${sessionKey} exceeded its retention limit`);
    }
    if (bucket.droppedCount < 0) {
      throw new Error(`Conversation quarantine for ${sessionKey} has an invalid dropped count`);
    }
  });
  Object.entries(state.ingressDiagnosticsBySession).forEach(([sessionKey, diagnostics]) => {
    if (diagnostics.assignments.length > ASSIGNMENT_DIAGNOSTIC_LIMIT) {
      throw new Error(`Conversation assignments for ${sessionKey} exceeded its retention limit`);
    }
    if (diagnostics.duplicateCount < 0 || diagnostics.staleSequenceCount < 0 || diagnostics.quarantineCount < 0) {
      throw new Error(`Conversation ingress diagnostics for ${sessionKey} contain an invalid count`);
    }
  });
  Object.values(state.turnsById).forEach((turn) => {
    const expected = rebuildItemIndex(turn.items);
    if (JSON.stringify(expected) !== JSON.stringify(turn.itemIndex)) {
      throw new Error(`Conversation turn ${turn.id} has an invalid item index`);
    }
    const retainedEvents = state.eventsByTurnId[turn.id] ?? [];
    const retentionLimit = isTerminalTurn(turn) ? TERMINAL_EVENT_TAIL_LIMIT : ACTIVE_EVENT_TAIL_LIMIT;
    if (retainedEvents.length > retentionLimit) {
      throw new Error(`Conversation turn ${turn.id} exceeded its raw event retention limit`);
    }
    const checkpoint = state.eventRetentionByTurnId[turn.id];
    if (checkpoint && checkpoint.totalEventCount < retainedEvents.length) {
      throw new Error(`Conversation turn ${turn.id} has an invalid event retention checkpoint`);
    }
  });
}
