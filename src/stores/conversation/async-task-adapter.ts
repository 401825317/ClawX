import {
  CONVERSATION_EVENT_CONTRACT_VERSION,
  type ConversationEvent,
} from '../../../shared/conversation-events';
import type {
  ChatRuntimeTaskProjection,
  ChatRuntimeTaskStatus,
} from '../../../shared/chat-runtime-events';
import type { AsyncTaskEvidence } from '../chat/types';
import { createEventId, stableHash } from './identity';

const TASK_COMPLETION_MARKERS = new Set([
  'task_completion',
  'task_completed',
  'task_complete',
]);

const ASYNC_TOOL_RESULT_MARKERS = new Set([
  'tool_completed',
  'tool_result',
  'toolresult',
]);

const CHAT_RUNTIME_EVENT_MARKERS = new Set([
  'run_started',
  'run_plan_updated',
  'run_step_updated',
  'task_updated',
  'run_ended',
  'assistant_delta',
  'thinking_delta',
  'progress_update',
  'tool_started',
  'tool_updated',
  'tool_completed',
  'artifact_produced',
  'verification_completed',
  'command_output',
  'patch_completed',
  'approval_updated',
]);

const GENERIC_RUNTIME_NAMES = new Set(['tool', 'tool_call', 'tool_result']);

export type StructuredAsyncTaskEvidence = AsyncTaskEvidence & {
  parentTaskId?: string;
  runtime?: string;
  title?: string;
  sourceStatus?: string;
  taskStatus: ChatRuntimeTaskStatus;
  toolCallId?: string;
};

export type AsyncTaskConversationContext = {
  sessionKey: string;
  turnId?: string;
  rootRunId?: string;
  runId?: string;
  parentTaskId?: string;
  toolCallId?: string;
  messageId?: string;
  seq?: number;
  occurredAt: number;
  receivedAt?: number;
  replayed?: boolean;
  source?: 'derived' | 'history';
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pickNonEmptyString(
  records: Array<Record<string, unknown> | null>,
  keys: string[],
): string | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function normalizeMarker(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    : '';
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const numeric = Number(value);
    value = Number.isFinite(numeric) ? numeric : Date.parse(value);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value > 0 && value < 100_000_000_000 ? value * 1_000 : value;
}

function evidenceTime(
  records: Array<Record<string, unknown> | null>,
  fallback: number,
): number {
  for (const record of records) {
    if (!record) continue;
    for (const key of [
      'updatedAt',
      'updated_at',
      'endedAt',
      'ended_at',
      'completedAt',
      'completed_at',
      'startedAt',
      'started_at',
      'createdAt',
      'created_at',
      'ts',
      'timestamp',
    ]) {
      const value = normalizeTimestamp(record[key]);
      if (value != null) return value;
    }
  }
  return fallback;
}

function normalizeTaskStatus(
  value: unknown,
  fallback: ChatRuntimeTaskStatus,
): ChatRuntimeTaskStatus {
  const status = normalizeMarker(value);
  if (['error', 'failed', 'failure', 'aborted', 'cancelled', 'canceled'].includes(status)) return 'error';
  if (['partial', 'partial_failure'].includes(status)) return 'partial';
  if (['completed', 'complete', 'done', 'success', 'succeeded', 'finished'].includes(status)) return 'completed';
  if (['waiting_approval', 'approval_required'].includes(status)) return 'waiting_approval';
  if (['running', 'started'].includes(status)) return 'running';
  if (['pending', 'accepted', 'queued', 'waiting'].includes(status)) return 'pending';
  return fallback;
}

function legacyTaskStatus(status: ChatRuntimeTaskStatus): AsyncTaskEvidence['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'error' || status === 'partial') return 'error';
  return 'pending';
}

function runtimeName(records: Array<Record<string, unknown> | null>): string | undefined {
  const candidates = [
    pickNonEmptyString(records, ['runtime', 'runtimeName', 'runtime_name']),
    ...records.map((record) => pickNonEmptyString([asRecord(record?.tool)], ['runtime', 'name', 'id'])),
    pickNonEmptyString(records, ['toolName', 'tool_name']),
    pickNonEmptyString(records, ['name']),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((value) => !GENERIC_RUNTIME_NAMES.has(normalizeMarker(value))) ?? candidates[0];
}

function evidenceFromRecords(input: {
  records: Array<Record<string, unknown> | null>;
  source: StructuredAsyncTaskEvidence['source'];
  fallbackStatus: ChatRuntimeTaskStatus;
  now: number;
  includeSessionAlias: boolean;
}): StructuredAsyncTaskEvidence | null {
  const { records, source, fallbackStatus, now, includeSessionAlias } = input;
  const taskId = pickNonEmptyString(records, ['taskId', 'task_id']);
  const runId = pickNonEmptyString(records, ['runId', 'run_id']);
  const parentTaskId = pickNonEmptyString(records, ['parentTaskId', 'parent_task_id']);
  const childSessionKey = pickNonEmptyString(records, includeSessionAlias
    ? ['childSessionKey', 'child_session_key', 'sessionKey', 'session_key']
    : ['childSessionKey', 'child_session_key']);
  const childSessionId = pickNonEmptyString(records, [
    'childSessionId',
    'child_session_id',
    'sessionId',
    'session_id',
  ]);
  if (!taskId && !childSessionKey && !childSessionId) return null;

  const sourceStatus = pickNonEmptyString(records, ['taskStatus', 'task_status', 'status', 'state']);
  const taskStatus = normalizeTaskStatus(sourceStatus, fallbackStatus);
  const runtime = runtimeName(records);
  const title = pickNonEmptyString(records, ['taskTitle', 'task_title', 'title', 'label']);
  const toolCallId = pickNonEmptyString(records, ['toolCallId', 'tool_call_id', 'toolUseId', 'tool_use_id']);
  const updatedAt = evidenceTime(records, now);
  return {
    id: taskId
      ? `task:${taskId}`
      : runId
        ? `run:${runId}`
        : childSessionKey
          ? `child:${childSessionKey}`
          : `child-id:${childSessionId}`,
    ...(taskId ? { taskId } : {}),
    ...(runId ? { runId } : {}),
    ...(parentTaskId ? { parentTaskId } : {}),
    ...(childSessionKey ? { childSessionKey } : {}),
    ...(childSessionId ? { childSessionId } : {}),
    ...(runtime ? { runtime } : {}),
    ...(title ? { title } : {}),
    ...(sourceStatus ? { sourceStatus } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    taskStatus,
    status: legacyTaskStatus(taskStatus),
    source,
    updatedAt,
  };
}

/** Follow only structured runtime payload fields; prose and path strings are never parsed. */
function runtimeEvidenceRecords(event: Record<string, unknown>): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const visited = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 7) return;
    const record = asRecord(value);
    if (!record || visited.has(record)) return;
    visited.add(record);
    records.push(record);
    for (const key of ['step', 'entry', 'artifact', 'verification', 'result', 'meta', 'details', 'task', 'async', 'tool']) {
      visit(record[key], depth + 1);
    }
  };
  visit(event, 0);
  return records;
}

function asyncTaskEvidenceFromRuntimeEvent(
  value: unknown,
  now: number,
): StructuredAsyncTaskEvidence | null {
  const event = asRecord(value);
  if (!event) return null;
  const type = pickNonEmptyString([event], ['type']);
  if (!type) return null;

  const records = runtimeEvidenceRecords(event);
  const identityRecord = records.find((record) => pickNonEmptyString([record], [
    'taskId',
    'task_id',
    'childSessionKey',
    'child_session_key',
    'childSessionId',
    'child_session_id',
  ]));
  const evidenceRecords = identityRecord
    ? [identityRecord, ...records.filter((record) => record !== identityRecord)]
    : records;
  const marker = normalizeMarker(type);
  const asyncMarker = evidenceRecords.some((record) => record.async === true || asRecord(record.async) != null);
  const taskCompletionMarker = TASK_COMPLETION_MARKERS.has(marker);
  const approvalLifecycle = marker === 'approval_updated';
  const asyncToolResult = ASYNC_TOOL_RESULT_MARKERS.has(marker) && asyncMarker;
  if (!taskCompletionMarker && !approvalLifecycle && !asyncToolResult) return null;

  const source = asyncToolResult ? 'tool-result' : 'task-completion';
  const sourceStatus = pickNonEmptyString(evidenceRecords, ['taskStatus', 'task_status', 'status', 'state']);
  let fallbackStatus: ChatRuntimeTaskStatus = taskCompletionMarker ? 'completed' : 'pending';
  if (approvalLifecycle) {
    fallbackStatus = 'waiting_approval';
  } else if (marker === 'tool_completed' && event.isError === true) {
    fallbackStatus = 'error';
  } else if (marker === 'tool_completed' && sourceStatus == null) {
    fallbackStatus = 'pending';
  }

  const evidence = evidenceFromRecords({
    records: evidenceRecords,
    source,
    fallbackStatus,
    now,
    includeSessionAlias: false,
  });
  if (!evidence) return null;
  if (approvalLifecycle) {
    return { ...evidence, taskStatus: 'waiting_approval', status: 'pending' };
  }
  if (marker === 'tool_completed' && event.isError === true) {
    return { ...evidence, taskStatus: 'error', status: 'error' };
  }
  return evidence;
}

/** Extract async task state only from the structured fields trusted by the legacy path. */
export function extractAsyncTaskEvidence(
  value: unknown,
  now = Date.now(),
): StructuredAsyncTaskEvidence[] {
  const evidence = new Map<string, StructuredAsyncTaskEvidence>();
  const visited = new Set<object>();
  const add = (entry: StructuredAsyncTaskEvidence | null): void => {
    if (!entry) return;
    const key = `${entry.id}|${entry.status}|${entry.source}`;
    evidence.set(key, entry);
  };

  const directRuntimeEvidence = asyncTaskEvidenceFromRuntimeEvent(value, now);
  if (directRuntimeEvidence) return [directRuntimeEvidence];

  // Canonical runtime facts own their own domains. Do not reinterpret nested
  // taskId/status/title fields as async task lifecycle without an allowed marker.
  const directType = pickNonEmptyString([asRecord(value)], ['type']);
  if (directType && CHAT_RUNTIME_EVENT_MARKERS.has(normalizeMarker(directType))) return [];

  const visit = (current: unknown, parent: Record<string, unknown> | null, depth: number): void => {
    if (depth > 7 || !current || typeof current === 'string' || typeof current !== 'object') return;
    if (visited.has(current as object)) return;
    visited.add(current as object);
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, parent, depth + 1));
      return;
    }

    const record = current as Record<string, unknown>;
    const details = asRecord(record.details);
    if (details) {
      const nestedAsync = asRecord(details.async);
      if (details.async === true || nestedAsync) {
        add(evidenceFromRecords({
          records: [nestedAsync ? { ...details, ...nestedAsync } : details, record],
          source: 'tool-result',
          fallbackStatus: 'pending',
          now,
          includeSessionAlias: true,
        }));
      }
    }

    const marker = [record.type, record.event, record.eventType, record.kind]
      .map(normalizeMarker)
      .find(Boolean) ?? '';
    if (TASK_COMPLETION_MARKERS.has(marker)) {
      add(evidenceFromRecords({
        records: [record, parent],
        source: 'task-completion',
        fallbackStatus: 'completed',
        now,
        includeSessionAlias: true,
      }));
    }

    for (const [key, child] of Object.entries(record)) {
      if (TASK_COMPLETION_MARKERS.has(normalizeMarker(key))) {
        add(evidenceFromRecords({
          records: [asRecord(child) ?? record, record],
          source: 'task-completion',
          fallbackStatus: 'completed',
          now,
          includeSessionAlias: true,
        }));
      }
      visit(child, record, depth + 1);
    }
  };

  visit(value, null, 0);
  return [...evidence.values()];
}

/** Project structured async evidence into low-authority canonical task facts. */
export function asyncTaskPayloadToConversationEvents(
  value: unknown,
  context: AsyncTaskConversationContext,
): ConversationEvent[] {
  const evidence = extractAsyncTaskEvidence(value, context.occurredAt);
  return evidence.flatMap((entry): ConversationEvent[] => {
    if (!entry.taskId) return [];
    const source = context.source ?? 'derived';
    const runId = entry.runId ?? context.runId;
    const rootRunId = context.rootRunId ?? context.runId ?? runId;
    const parentTaskId = entry.parentTaskId ?? context.parentTaskId;
    const toolCallId = entry.toolCallId ?? context.toolCallId;
    const task: ChatRuntimeTaskProjection = {
      taskId: entry.taskId,
      ...(parentTaskId ? { parentTaskId } : {}),
      ...(entry.runtime ? { runtime: entry.runtime } : {}),
      title: entry.title ?? entry.runtime ?? entry.taskId,
      sessionKey: context.sessionKey,
      ...(entry.childSessionKey ? { childSessionKey: entry.childSessionKey } : {}),
      status: entry.taskStatus,
      ...(entry.sourceStatus ? { sourceStatus: entry.sourceStatus } : {}),
      updatedAt: entry.updatedAt,
    };
    const phase = `async-task:${entry.source}:${stableHash({
      runId,
      parentTaskId,
      toolCallId,
      runtime: task.runtime,
      status: task.status,
      sourceStatus: task.sourceStatus,
    })}`;
    return [{
      version: CONVERSATION_EVENT_CONTRACT_VERSION,
      eventId: createEventId({
        source,
        type: 'task.updated',
        runId,
        taskId: entry.taskId,
        phase,
      }),
      type: 'task.updated',
      source,
      authority: 'corroborating',
      sessionKey: context.sessionKey,
      turnId: context.turnId,
      rootRunId,
      runId,
      messageId: context.messageId,
      taskId: entry.taskId,
      parentTaskId,
      toolCallId,
      seq: context.seq,
      occurredAt: entry.updatedAt,
      receivedAt: context.receivedAt ?? Date.now(),
      replayed: context.replayed ?? false,
      data: { task },
    }];
  });
}
