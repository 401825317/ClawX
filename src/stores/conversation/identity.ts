import type { ConversationEvent } from '../../../shared/conversation-events';
import type {
  ConversationAssignmentBasis,
  ConversationAssignmentConfidence,
  ConversationState,
  ConversationTurn,
} from './types';

const TASK_LEDGER_ACTIVE_TURN_SKEW_MS = 30_000;

export type ConversationTurnAssignment = {
  turnId: string;
  basis: ConversationAssignmentBasis;
  confidence: ConversationAssignmentConfidence;
};

function stableSerialize(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
    .join(',')}}`;
}

export function stableHash(value: unknown): string {
  const input = stableSerialize(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function createTurnId(input: {
  sessionKey: string;
  messageId?: string;
  idempotencyKey?: string;
  runId?: string;
  timestamp?: number;
  content?: unknown;
}): string {
  const identity = input.idempotencyKey
    ?? input.messageId
    ?? input.runId
    ?? `${input.timestamp ?? 0}:${stableHash(input.content)}`;
  return `turn:${stableHash(input.sessionKey)}:${identity}`;
}

/** Scope upstream aliases to their owning session before indexing them. */
export function createSessionAliasKey(sessionKey: string, upstreamId: string): string {
  return JSON.stringify([sessionKey, upstreamId]);
}

/** Match a scoped dedupe/alias key without relying on delimiter escaping. */
export function sessionAliasKeyBelongsTo(key: string, sessionKey: string): boolean {
  try {
    const parsed = JSON.parse(key) as unknown;
    return Array.isArray(parsed) && parsed[0] === sessionKey;
  } catch {
    return false;
  }
}

export type ToolSearchNestedCallIdentity = {
  encodedParentToolCallId: string;
  toolName: string;
};

/** Match OpenClaw's Tool Search child identity without assuming parent IDs survive sanitization. */
export function parseToolSearchNestedCallId(toolCallId: string): ToolSearchNestedCallIdentity | null {
  const match = /^tool_search_code:(.+):([^:]+):\d+$/u.exec(toolCallId.trim());
  if (!match) return null;
  return {
    encodedParentToolCallId: match[1],
    toolName: match[2],
  };
}

/** Mirror OpenClaw's parent-ID encoding used inside Tool Search child call IDs. */
export function encodeToolSearchParentCallId(toolCallId: string): string {
  return toolCallId.trim().replace(/[^A-Za-z0-9_.:-]+/gu, '_').slice(0, 120) || 'call';
}

export function createEventId(input: {
  source: string;
  type: string;
  runId?: string;
  seq?: number;
  entityId?: string;
  toolCallId?: string;
  taskId?: string;
  messageId?: string;
  phase?: string;
  occurredAt?: number;
  data?: unknown;
}): string {
  if (input.entityId) {
    return `${input.source}:${input.runId ?? 'run'}:${input.entityId}:${input.phase ?? input.type}`;
  }
  if (input.toolCallId) {
    return `${input.source}:${input.runId ?? 'run'}:${input.toolCallId}:${input.phase ?? input.type}`;
  }
  if (input.taskId) {
    return `${input.source}:${input.taskId}:${input.phase ?? input.type}`;
  }
  if (input.messageId) {
    return `${input.source}:${input.messageId}:${input.phase ?? input.type}`;
  }
  if (input.runId && input.phase) {
    return `${input.source}:${input.runId}:${input.phase}:${input.type}`;
  }
  return `${input.source}:${input.type}:${stableHash({
    runId: input.runId,
    occurredAt: input.occurredAt,
    data: input.data,
  })}`;
}

function scopedTurnId(
  state: ConversationState,
  sessionKey: string,
  turnId: string | undefined,
): string | undefined {
  if (!turnId) return undefined;
  return state.turnsById[turnId]?.sessionKey === sessionKey ? turnId : undefined;
}

function pendingLocalTurnId(state: ConversationState, sessionKey: string): string | undefined {
  const turnId = scopedTurnId(state, sessionKey, state.aliases.pendingLocalBySession[sessionKey]);
  if (!turnId) return undefined;
  const status = state.turnsById[turnId].status;
  return status === 'completed' || status === 'error' || status === 'aborted'
    ? undefined
    : turnId;
}

function assignment(
  turnId: string | undefined,
  basis: ConversationAssignmentBasis,
  confidence: ConversationAssignmentConfidence,
): ConversationTurnAssignment | undefined {
  return turnId ? { turnId, basis, confidence } : undefined;
}

/** Accept an ownerless ledger fallback only when its lifecycle overlaps the candidate Turn. */
function taskLedgerCanFallbackToTurn(turn: ConversationTurn, event: ConversationEvent): boolean {
  if (event.type !== 'task.updated' || event.source !== 'task-ledger' || event.rootRunId) return false;
  if (['completed', 'error', 'aborted'].includes(turn.status)) return false;
  const task = (event.data as {
    task?: { createdAt?: number; startedAt?: number };
  }).task;
  const rawTaskStartedAt = task?.createdAt ?? task?.startedAt;
  const taskStartedAt = rawTaskStartedAt != null && rawTaskStartedAt < 100_000_000_000
    ? rawTaskStartedAt * 1_000
    : rawTaskStartedAt;
  if (taskStartedAt != null && taskStartedAt + TASK_LEDGER_ACTIVE_TURN_SKEW_MS < turn.createdAt) {
    return false;
  }
  return true;
}

/** Use a session fallback only while one live Turn can plausibly own the task. */
function taskLedgerActiveTurnId(state: ConversationState, event: ConversationEvent): string | undefined {
  const turnId = scopedTurnId(state, event.sessionKey, state.aliases.activeBySession[event.sessionKey]);
  if (!turnId) return undefined;
  const turn = state.turnsById[turnId];
  if (!taskLedgerCanFallbackToTurn(turn, event)) return undefined;
  return turnId;
}

/** Native approvals omit run identity, so keep their fallback narrow and session-scoped. */
function nativeApprovalActiveTurnId(state: ConversationState, event: ConversationEvent): string | undefined {
  const runId = event.rootRunId ?? event.runId;
  if (event.type !== 'approval.updated'
    || (event.source !== 'openclaw-runtime' && event.source !== 'plugin')
    || !runId
    || !/^approval:(?:exec|plugin):/u.test(runId)) {
    return undefined;
  }
  return scopedTurnId(state, event.sessionKey, state.aliases.activeBySession[event.sessionKey]);
}

export function resolveTurnAssignment(
  state: ConversationState,
  event: ConversationEvent,
): ConversationTurnAssignment | undefined {
  if (event.turnId) {
    const explicitTurn = state.turnsById[event.turnId];
    if (!explicitTurn || explicitTurn.sessionKey === event.sessionKey) {
      return assignment(event.turnId, 'explicit-turn', 'high');
    }
  }
  if (event.messageId) {
    const turnId = state.aliases.byMessageId[createSessionAliasKey(event.sessionKey, event.messageId)];
    const scoped = scopedTurnId(state, event.sessionKey, turnId);
    if (scoped) return assignment(scoped, 'message-alias', 'high');
  }
  if (event.taskId) {
    const turnId = state.aliases.byTaskId[createSessionAliasKey(event.sessionKey, event.taskId)];
    const scoped = scopedTurnId(state, event.sessionKey, turnId);
    if (scoped) return assignment(scoped, 'task-alias', 'high');
  }
  if (event.parentTaskId) {
    const turnId = state.aliases.byTaskId[createSessionAliasKey(event.sessionKey, event.parentTaskId)];
    const scoped = scopedTurnId(state, event.sessionKey, turnId);
    if (scoped) return assignment(scoped, 'parent-task-alias', 'high');
  }
  if (event.toolCallId) {
    const turnId = state.aliases.byToolCallId[createSessionAliasKey(event.sessionKey, event.toolCallId)];
    const scoped = scopedTurnId(state, event.sessionKey, turnId);
    if (scoped) return assignment(scoped, 'tool-alias', 'high');
  }
  const runIds = [event.rootRunId, event.runId]
    .filter((runId): runId is string => Boolean(runId))
    .filter((runId, index, values) => values.indexOf(runId) === index);
  for (const [index, runId] of runIds.entries()) {
    const turnId = state.aliases.byRunId[createSessionAliasKey(event.sessionKey, runId)];
    const scoped = scopedTurnId(state, event.sessionKey, turnId);
    if (scoped) {
      return assignment(scoped, index === 0 && event.rootRunId ? 'root-run-alias' : 'run-alias', 'high');
    }
  }
  const pending = pendingLocalTurnId(state, event.sessionKey);
  if (pending) {
    const pendingTurn = state.turnsById[pending];
    const taskLedgerEvent = event.type === 'task.updated' && event.source === 'task-ledger';
    if (!taskLedgerEvent || taskLedgerCanFallbackToTurn(pendingTurn, event)) {
      return assignment(pending, 'pending-local', 'medium');
    }
  }
  const activeTask = taskLedgerActiveTurnId(state, event);
  if (activeTask) return assignment(activeTask, 'active-task-ledger', 'medium');
  const approval = nativeApprovalActiveTurnId(state, event);
  return assignment(approval, 'active-native-approval', 'medium');
}

export function resolveTurnId(state: ConversationState, event: ConversationEvent): string | undefined {
  return resolveTurnAssignment(state, event)?.turnId;
}

export function eventBelongsToTurn(turn: ConversationTurn, event: ConversationEvent): boolean {
  if (turn.sessionKey !== event.sessionKey) return false;
  if (event.turnId === turn.id) return true;
  if (event.messageId && turn.trigger.message.id === event.messageId) return true;
  if (event.taskId && turn.taskIds.includes(event.taskId)) return true;
  if (event.toolCallId && turn.toolItemByCallId[event.toolCallId]) return true;
  const runId = event.rootRunId ?? event.runId;
  return Boolean(runId && (turn.rootRunId === runId || turn.runAliases.includes(runId)));
}
