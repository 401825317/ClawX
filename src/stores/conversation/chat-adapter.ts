import {
  CONVERSATION_EVENT_CONTRACT_VERSION,
  type ConversationEvent,
  type ConversationMessageSnapshot,
} from '../../../shared/conversation-events';
import type { RawMessage } from '../chat/types';
import { extractText, extractToolUse } from '../../pages/Chat/message-utils';
import { asyncTaskPayloadToConversationEvents } from './async-task-adapter';
import { createEventId, stableHash } from './identity';

export type ChatEventContext = {
  sessionKey: string;
  activeRunId?: string | null;
  rootRunId?: string;
  turnId?: string;
};

/** Classify the narrow transient failures that can safely repeat the same send intent. */
export function isRecoverableConversationError(errorMessage: string): boolean {
  const normalized = errorMessage.trim().toLowerCase();
  if (!normalized) return false;
  return /\bterminated\b/u.test(normalized)
    || /\baborted\b/u.test(normalized)
    || normalized.includes('econnreset')
    || normalized.includes('connection reset');
}

function snapshotMessage(message: RawMessage): ConversationMessageSnapshot {
  return {
    role: message.role,
    content: message.content,
    timestamp: normalizeTimestamp(message.timestamp),
    id: message.id,
    idempotencyKey: message.idempotencyKey,
    attachments: message._attachedFiles?.map((file) => ({ ...file })),
  };
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toMs(value: unknown): number {
  value = normalizeTimestamp(value);
  if (!value) return Date.now();
  return (value as number) < 100_000_000_000 ? (value as number) * 1_000 : value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasChatEventIdentity(value: Record<string, unknown>): boolean {
  return value.state != null
    || value.seq != null
    || value.errorMessage != null;
}

/** Normalize modern `{ message: ChatEvent }` and legacy direct ChatEvent envelopes. */
export function normalizeGatewayChatEnvelope(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null;
  if (hasChatEventIdentity(data)) return data;
  if (isRecord(data.message)) {
    const nested = data.message;
    if (hasChatEventIdentity(nested)) {
      return {
        ...nested,
        ...(nested.sessionKey == null && data.sessionKey != null ? { sessionKey: data.sessionKey } : {}),
        ...(nested.runId == null && data.runId != null ? { runId: data.runId } : {}),
      };
    }
    return {
      state: 'final',
      message: nested,
      runId: data.runId,
      sessionKey: data.sessionKey,
    };
  }
  return { state: 'final', message: data, runId: data.runId, sessionKey: data.sessionKey };
}

/** Only the selected session may inherit its locally tracked active run. */
export function createChatEventContext(input: {
  sessionKey: string;
  currentSessionKey: string;
  activeRunId?: string | null;
  ownerRunId?: string | null;
}): ChatEventContext {
  const activeRunId = input.sessionKey === input.currentSessionKey
    ? input.activeRunId ?? undefined
    : undefined;
  const rootRunId = input.ownerRunId?.trim() || undefined;
  return {
    sessionKey: input.sessionKey,
    activeRunId,
    ...(rootRunId ? { rootRunId } : {}),
  };
}

export function chatEventToConversationEvents(
  raw: Record<string, unknown>,
  context: ChatEventContext,
): ConversationEvent[] {
  const message = raw.message && typeof raw.message === 'object'
    ? raw.message as RawMessage
    : null;
  const sessionKey = typeof raw.sessionKey === 'string' ? raw.sessionKey : context.sessionKey;
  if (!sessionKey) return [];
  const state = typeof raw.state === 'string' ? raw.state : message ? 'delta' : '';
  const runId = typeof raw.runId === 'string' ? raw.runId : context.activeRunId ?? undefined;
  const rootRunId = context.rootRunId ?? runId;
  const seq = typeof raw.seq === 'number' && Number.isFinite(raw.seq) ? raw.seq : undefined;
  const occurredAt = toMs(message?.timestamp);
  const receivedAt = Date.now();
  const base = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    source: 'openclaw-chat' as const,
    sessionKey,
    turnId: context.turnId,
    rootRunId,
    runId,
    seq,
    messageId: message?.id,
    occurredAt,
    receivedAt,
    replayed: false,
  };
  const taskEvents = asyncTaskPayloadToConversationEvents(raw.message ?? raw, {
    sessionKey,
    turnId: context.turnId,
    rootRunId,
    runId,
    toolCallId: message?.toolCallId
      ?? (typeof raw.toolCallId === 'string' ? raw.toolCallId : undefined),
    messageId: message?.id,
    seq,
    occurredAt,
    receivedAt,
  });

  if (state === 'started') {
    return [{
      ...base,
      eventId: createEventId({ source: base.source, type: 'run.started', runId, seq, phase: 'started', occurredAt, data: raw }),
      type: 'run.started',
      authority: 'corroborating',
      data: { startedAt: occurredAt },
    }, ...taskEvents];
  }

  if (state === 'aborted') {
    const error = (typeof raw.errorMessage === 'string'
      ? raw.errorMessage
      : message?.errorMessage ?? message?.error_message ?? extractText(message)) || state;
    return [{
      ...base,
      eventId: createEventId({ source: base.source, type: 'run.ended', runId, seq, phase: 'aborted', occurredAt, data: error }),
      type: 'run.ended',
      authority: 'authoritative',
      data: { status: 'aborted', endedAt: occurredAt, error },
    }, ...taskEvents];
  }

  if (state === 'error') {
    const error = (typeof raw.errorMessage === 'string'
      ? raw.errorMessage
      : message?.errorMessage ?? message?.error_message ?? extractText(message)) || state;
    const recoverable = typeof raw.recoverable === 'boolean'
      ? raw.recoverable
      : isRecoverableConversationError(error);
    return [
      {
        ...base,
        eventId: createEventId({ source: base.source, type: 'run.ended', runId, seq, messageId: message?.id, phase: state, occurredAt, data: error }),
        type: 'run.ended',
        authority: 'authoritative',
        data: { status: 'error', endedAt: occurredAt, error },
      },
      {
        ...base,
        eventId: createEventId({ source: base.source, type: 'turn.error', runId, seq, messageId: message?.id, phase: state, occurredAt, data: error }),
        type: 'turn.error',
        authority: 'authoritative',
        data: { error, recoverable },
      },
      ...taskEvents,
    ];
  }

  if (!message || message.role !== 'assistant') return taskEvents;
  const text = extractText(message);
  if (!text && !(message._attachedFiles?.length)) return taskEvents;
  // OpenClaw completes each assistant model message, including mixed
  // preamble + tool-call messages. Only a tool-free envelope is deliverable.
  const final = state === 'final' && extractToolUse(message).length === 0;
  return [{
    ...base,
    eventId: createEventId({
      source: base.source,
      type: final ? 'final.message' : 'assistant.content',
      runId,
      seq,
      messageId: message.id,
      phase: `${state}:${stableHash(message.content)}${seq == null ? `:at:${occurredAt}` : ''}`,
      occurredAt,
      data: message.content,
    }),
    type: final ? 'final.message' : 'assistant.content',
    authority: final ? 'corroborating' : 'corroborating',
    data: final
      ? { message: snapshotMessage(message) }
      : { text, replace: true, phase: state },
  }, ...taskEvents];
}

export { snapshotMessage as conversationMessageSnapshot };
