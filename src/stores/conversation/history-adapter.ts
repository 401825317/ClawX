import {
  CONVERSATION_EVENT_CONTRACT_VERSION,
  type ConversationEvent,
  type ConversationMessageSnapshot,
} from '../../../shared/conversation-events';
import {
  extractText,
  extractThinking,
  extractToolUse,
  normalizeMessageRole,
} from '../../pages/Chat/message-utils';
import { parseSubagentCompletionInfo } from '../../pages/Chat/task-visualization';
import { isInternalMessage } from '../chat/helpers';
import { hasCanonicalArtifactEvidence } from '../chat/runtime-evidence';
import type { RawMessage } from '../chat/types';
import { extractGeneratedFiles } from '../../lib/generated-files';
import { asyncTaskPayloadToConversationEvents } from './async-task-adapter';
import { createEventId, createTurnId, stableHash } from './identity';
import { conversationMessageSnapshot } from './chat-adapter';

function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const numeric = Number(value);
    value = Number.isFinite(numeric) ? numeric : Date.parse(value);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value < 100_000_000_000 ? value * 1_000 : value;
}

type HistoryMessageProjection = {
  message: RawMessage;
  occurredAt: number;
  locationId: string;
};

/** Use persisted time when present and transcript position when old rows omit it. */
function projectHistoryMessages(messages: RawMessage[]): HistoryMessageProjection[] {
  const persistedTimes = messages.map((message) => timestampMs(message.timestamp));
  let previousOccurredAt: number | undefined;
  return messages.map((message, index) => {
    let occurredAt = persistedTimes[index];
    if (occurredAt == null) {
      let nextIndex = index + 1;
      while (nextIndex < persistedTimes.length && persistedTimes[nextIndex] == null) nextIndex += 1;
      const nextOccurredAt = persistedTimes[nextIndex];
      if (previousOccurredAt != null && nextOccurredAt != null && nextOccurredAt > previousOccurredAt) {
        occurredAt = previousOccurredAt + ((nextOccurredAt - previousOccurredAt) / (nextIndex - index + 1));
      } else if (previousOccurredAt != null) {
        occurredAt = nextOccurredAt == null ? previousOccurredAt + 1 : previousOccurredAt;
      } else if (nextOccurredAt != null) {
        occurredAt = nextOccurredAt;
      } else {
        occurredAt = index;
      }
    } else if (previousOccurredAt != null && occurredAt < previousOccurredAt) {
      occurredAt = previousOccurredAt;
    }
    previousOccurredAt = occurredAt;
    return {
      message,
      occurredAt,
      locationId: `history-location:${index}:${stableHash({
        role: message.role,
        content: message.content,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
      })}`,
    };
  });
}

function isToolResultUserMessage(message: RawMessage): boolean {
  if (normalizeMessageRole(message.role) === 'toolresult') return true;
  if (message.role !== 'user' || !Array.isArray(message.content)) return false;
  const blocks = message.content as Array<{ type?: string }>;
  return blocks.length > 0 && blocks.every((block) => block.type === 'tool_result' || block.type === 'toolResult');
}

/** Internal async delivery belongs to the existing parent turn, never a new user boundary. */
function isInternalCompletionMessage(message: RawMessage): boolean {
  if (parseSubagentCompletionInfo(message)) return true;
  if (extractText(message).includes('[Internal task completion event]')) return true;
  if (!Array.isArray(message.content)) return false;
  return (message.content as Array<{ type?: string }>).some(
    (block) => block.type === 'task_completion' || block.type === 'continuation',
  );
}

function isUserBoundary(message: RawMessage): boolean {
  return message.role === 'user'
    && !isToolResultUserMessage(message)
    && !isInternalMessage(message)
    && !isInternalCompletionMessage(message);
}

function hasVisibleMessage(message: RawMessage): boolean {
  return Boolean(extractText(message).trim() || message._attachedFiles?.length);
}

type HistoryAssistantTerminal = {
  index: number;
  status: 'error' | 'aborted';
  error: string;
  stopReason?: string;
};

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function terminalAssistantStatus(message: RawMessage): 'error' | 'aborted' | null {
  if (message.role !== 'assistant') return null;
  const record = message as RawMessage & { isFailed?: unknown };
  const stopReason = normalizedString(record.stopReason ?? record.stop_reason)?.toLowerCase();
  const errorMessage = normalizedString(record.errorMessage ?? record.error_message);
  const text = extractText(message).trim();

  if (stopReason && /^(?:abort|aborted|cancel|cancelled|canceled)$/u.test(stopReason)) {
    return 'aborted';
  }
  if (/^\[assistant turn (?:aborted|cancelled|canceled)\b/iu.test(text)) {
    return 'aborted';
  }
  if (
    stopReason === 'error'
    || stopReason === 'failed'
    || record.isFailed === true
    || message.isError === true
    || Boolean(errorMessage)
    || /^\[assistant turn failed\b/iu.test(text)
  ) {
    return 'error';
  }
  return null;
}

function terminalAssistantError(message: RawMessage, status: 'error' | 'aborted'): string {
  const record = message as RawMessage & { isFailed?: unknown };
  const explicitError = normalizedString(record.errorMessage ?? record.error_message);
  if (explicitError) return explicitError;

  const visibleText = extractText(message).trim().replace(
    /^\[assistant turn (?:failed|aborted|cancelled|canceled)\]\s*/iu,
    '',
  );
  if (visibleText) return visibleText;
  return status;
}

/** The latest meaningful assistant message owns the persisted terminal outcome. */
function terminalAssistant(messages: RawMessage[]): HistoryAssistantTerminal | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const status = terminalAssistantStatus(message);
    if (status) {
      return {
        index,
        status,
        error: terminalAssistantError(message, status),
        stopReason: normalizedString(message.stopReason ?? message.stop_reason),
      };
    }
    if (hasVisibleMessage(message) || extractThinking(message) || extractToolUse(message).length > 0) {
      return null;
    }
  }
  return null;
}

function finalAssistantIndex(messages: RawMessage[], terminal: HistoryAssistantTerminal | null): number {
  if (terminal) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || !hasVisibleMessage(message)) continue;
    // Assistant tool-request messages may include a short preamble, but they
    // are not the delivered answer when no post-tool assistant message exists.
    if (extractToolUse(message).length > 0) continue;
    return index;
  }
  return -1;
}

function baseEvent(input: {
  eventId: string;
  type: ConversationEvent['type'];
  sessionKey: string;
  turnId: string;
  occurredAt: number;
  messageId?: string;
  toolCallId?: string;
  data: ConversationEvent['data'];
}): ConversationEvent {
  return {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: input.eventId,
    type: input.type,
    source: 'history',
    authority: 'authoritative',
    sessionKey: input.sessionKey,
    turnId: input.turnId,
    messageId: input.messageId,
    toolCallId: input.toolCallId,
    occurredAt: input.occurredAt,
    receivedAt: input.occurredAt,
    replayed: true,
    data: input.data,
  };
}

function toolResultContent(message: RawMessage): unknown {
  if (message.details != null) return message.details;
  if (!Array.isArray(message.content)) return message.content;
  const blocks = message.content as Array<{ type?: string; content?: unknown }>;
  const result = blocks.find((block) => block.type === 'tool_result' || block.type === 'toolResult');
  return result?.content ?? message.content;
}

function toolInputPath(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['filePath', 'file_path', 'path', 'targetPath', 'target_path']) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  }
  return null;
}

function artifactEvents(
  sessionKey: string,
  turnId: string,
  message: RawMessage,
  occurredAt: number,
  locationId: string,
): ConversationEvent[] {
  return (message._attachedFiles ?? [])
    .filter(hasCanonicalArtifactEvidence)
    .map((file, index) => {
      const artifact = {
        id: `history-artifact:${stableHash(file.filePath ?? file.gatewayUrl ?? `${locationId}:${index}`)}`,
        kind: file.mimeType,
        title: file.fileName,
        filePath: file.filePath,
        url: file.gatewayUrl,
        mimeType: file.mimeType,
        sizeBytes: file.fileSize,
        availability: file.error
          ? 'error'
          : file.availability
          ?? (file.fileSize > 0 || file.gatewayUrl || file.preview ? 'available' : 'registered'),
        error: file.error,
        preview: file.preview,
        previewStatus: file.previewStatus,
        width: file.width,
        height: file.height,
        durationSeconds: file.durationSeconds,
        hasAudio: file.hasAudio,
        source: 'history',
      };
      return baseEvent({
        eventId: createEventId({
          source: 'history',
          type: 'artifact.updated',
          messageId: message.id ?? locationId,
          phase: artifact.id,
          occurredAt,
          data: artifact,
        }),
        type: 'artifact.updated',
        sessionKey,
        turnId,
        occurredAt,
        messageId: message.id,
        data: { artifact },
      });
    });
}

function projectSegment(
  sessionKey: string,
  user: HistoryMessageProjection,
  segment: HistoryMessageProjection[],
): ConversationEvent[] {
  const userMessage = user.message;
  const turnId = createTurnId({
    sessionKey,
    messageId: userMessage.id,
    idempotencyKey: userMessage.idempotencyKey,
    timestamp: userMessage.timestamp ?? user.occurredAt,
    content: userMessage.content,
  });
  const userTime = user.occurredAt;
  const events: ConversationEvent[] = [baseEvent({
    eventId: createEventId({
      source: 'history',
      type: 'turn.requested',
      messageId: userMessage.id ?? user.locationId,
      occurredAt: userTime,
      data: userMessage.content,
    }),
    type: 'turn.requested',
    sessionKey,
    turnId,
    occurredAt: userTime,
    messageId: userMessage.id,
    data: { message: conversationMessageSnapshot(userMessage) },
  })];
  const segmentMessages = segment.map((entry) => entry.message);
  const terminal = terminalAssistant(segmentMessages);
  const finalIndex = finalAssistantIndex(segmentMessages, terminal);
  const toolNames = new Map<string, string>();

  segment.forEach(({ message, occurredAt, locationId }, index) => {
    let taskToolCallId = message.toolCallId;
    const thinking = extractThinking(message);
    if (thinking) {
      events.push(baseEvent({
        eventId: createEventId({ source: 'history', type: 'thinking.content', messageId: message.id ?? locationId, phase: 'thinking', occurredAt, data: thinking }),
        type: 'thinking.content',
        sessionKey,
        turnId,
        occurredAt,
        messageId: message.id,
        data: { text: thinking, replace: true },
      }));
    }

    for (const tool of extractToolUse(message)) {
      const toolCallId = tool.id || `history-tool:${stableHash({ turnId, index, name: tool.name })}`;
      toolNames.set(toolCallId, tool.name);
      events.push(baseEvent({
        eventId: createEventId({ source: 'history', type: 'tool.started', toolCallId, phase: 'start', occurredAt, data: tool.input }),
        type: 'tool.started',
        sessionKey,
        turnId,
        occurredAt,
        messageId: message.id,
        toolCallId,
        data: { toolCallId, name: tool.name, args: tool.input },
      }));
    }

    if (isToolResultUserMessage(message)) {
      const toolCallId = (message.toolCallId
        ?? (Array.isArray(message.content)
          ? String((message.content as Array<{ id?: string; tool_use_id?: string }>)[0]?.tool_use_id ?? '')
          : '')) || `history-result:${stableHash({ turnId, index })}`;
      taskToolCallId = toolCallId;
      const name = message.toolName ?? toolNames.get(toolCallId) ?? 'tool';
      events.push(baseEvent({
        eventId: createEventId({ source: 'history', type: 'tool.completed', toolCallId, phase: 'completed', occurredAt, data: message.content }),
        type: 'tool.completed',
        sessionKey,
        turnId,
        occurredAt,
        messageId: message.id,
        toolCallId,
        data: { toolCallId, name, result: toolResultContent(message), isError: message.isError },
      }));
    }

    if (message.role === 'assistant') {
      const text = extractText(message).trim();
      if (terminal?.index === index) {
        events.push(baseEvent({
          eventId: createEventId({ source: 'history', type: 'turn.error', messageId: message.id ?? locationId, phase: `turn-${terminal.status}`, occurredAt, data: terminal.error }),
          type: 'turn.error',
          sessionKey,
          turnId,
          occurredAt,
          messageId: message.id,
          data: { error: terminal.error, recoverable: false },
        }));
        events.push(baseEvent({
          eventId: createEventId({ source: 'history', type: 'run.ended', messageId: message.id ?? locationId, phase: `run-${terminal.status}`, occurredAt, data: terminal.error }),
          type: 'run.ended',
          sessionKey,
          turnId,
          occurredAt,
          messageId: message.id,
          data: {
            status: terminal.status,
            endedAt: occurredAt,
            error: terminal.error,
            stopReason: terminal.stopReason,
          },
        }));
      } else if (text) {
        const isFinal = index === finalIndex;
        const type = isFinal ? 'final.message' : 'commentary.append';
        const data = isFinal
          ? { message: conversationMessageSnapshot(message) }
          : { text, replace: true };
        events.push(baseEvent({
          eventId: createEventId({ source: 'history', type, messageId: message.id ?? locationId, phase: isFinal ? 'final' : 'commentary', occurredAt, data: message.content }),
          type,
          sessionKey,
          turnId,
          occurredAt,
          messageId: message.id,
          data,
        }));
      }
      events.push(...artifactEvents(sessionKey, turnId, message, occurredAt, locationId));
    }

    events.push(...asyncTaskPayloadToConversationEvents(message, {
      sessionKey,
      turnId,
      toolCallId: taskToolCallId,
      messageId: message.id,
      occurredAt,
      receivedAt: occurredAt,
      replayed: true,
      source: 'history',
    }));
  });

  const changedPaths = new Set(segment.flatMap(({ message }) => extractToolUse(message))
    .filter((tool) => /(?:write|edit|patch|replace|create|delete|move)/iu.test(tool.name))
    .map((tool) => toolInputPath(tool.input))
    .filter((path): path is string => Boolean(path)));
  const generatedFiles = extractGeneratedFiles([userMessage, ...segmentMessages], 0, segment.length)
    .filter((change) => changedPaths.has(change.filePath));
  generatedFiles.forEach((change, index) => {
    const occurredAt = segment[change.lastSeenIndex - 1]?.occurredAt
      ?? userTime + segment.length + index + 1;
    const artifact = {
      id: `history-change:${stableHash(change.filePath)}`,
      kind: change.contentType,
      title: change.fileName,
      filePath: change.filePath,
      mimeType: change.mimeType,
      sizeBytes: change.size,
      availability: change.size && change.size > 0 ? 'available' as const : 'registered' as const,
      source: 'history-tool-call',
    };
    events.push(baseEvent({
      eventId: createEventId({
        source: 'history',
        type: 'artifact.updated',
        messageId: userMessage.id,
        phase: artifact.id,
        occurredAt,
        data: change,
      }),
      type: 'artifact.updated',
      sessionKey,
      turnId,
      occurredAt,
      data: { artifact, change },
    }));
  });

  return events;
}

/** Preserve assistant-only transcript suffixes without inventing a visible user request. */
function projectOrphanAssistantSegment(
  sessionKey: string,
  segment: HistoryMessageProjection[],
): ConversationEvent[] {
  const ownerIndex = segment.findIndex(({ message }) => (
    message.role === 'assistant'
    && (
      hasVisibleMessage(message)
      || Boolean(extractThinking(message))
      || extractToolUse(message).length > 0
    )
  ));
  if (ownerIndex < 0) return [];

  const owner = segment[ownerIndex];
  const syntheticTrigger: RawMessage = {
    role: 'user',
    id: `history-orphan:${owner.message.id ?? stableHash({ locationId: owner.locationId, content: owner.message.content })}`,
    timestamp: owner.message.timestamp,
    content: '',
  };
  return projectSegment(
    sessionKey,
    {
      message: syntheticTrigger,
      occurredAt: owner.occurredAt,
      locationId: `history-orphan-trigger:${owner.locationId}`,
    },
    segment.slice(ownerIndex),
  ).filter((event) => event.type !== 'turn.requested');
}

export function historyMessagesToConversationEvents(
  sessionKey: string,
  messages: RawMessage[],
  options?: { reason?: 'initial-load' | 'terminal-refresh' | 'manual-refresh'; transcriptMtime?: number },
): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  const projectedMessages = projectHistoryMessages(messages);
  const boundaries: number[] = [];
  messages.forEach((message, index) => {
    if (isUserBoundary(message)) boundaries.push(index);
  });
  const firstBoundary = boundaries[0] ?? messages.length;
  if (firstBoundary > 0) {
    events.push(...projectOrphanAssistantSegment(
      sessionKey,
      projectedMessages.slice(0, firstBoundary),
    ));
  }
  boundaries.forEach((messageIndex, boundaryIndex) => {
    const end = boundaries[boundaryIndex + 1] ?? messages.length;
    events.push(...projectSegment(
      sessionKey,
      projectedMessages[messageIndex],
      projectedMessages.slice(messageIndex + 1, end),
    ));
  });
  const lastMessage = messages[messages.length - 1];
  const occurredAt = projectedMessages.at(-1)?.occurredAt ?? 0;
  events.push({
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: createEventId({
      source: 'history',
      type: 'history.checkpoint',
      messageId: lastMessage?.id ?? `count:${messages.length}`,
      phase: options?.reason ?? 'initial-load',
      occurredAt,
      data: { messageCount: messages.length, transcriptMtime: options?.transcriptMtime },
    }),
    type: 'history.checkpoint',
    source: 'history',
    authority: 'authoritative',
    sessionKey,
    occurredAt,
    receivedAt: occurredAt,
    replayed: true,
    data: {
      messageCount: messages.length,
      throughMessageId: lastMessage?.id,
      transcriptMtime: options?.transcriptMtime,
      reason: options?.reason ?? 'initial-load',
    },
  });
  return events;
}

export function snapshotToRawMessage(snapshot: ConversationMessageSnapshot): RawMessage {
  return {
    role: snapshot.role,
    content: snapshot.content,
    timestamp: snapshot.timestamp,
    id: snapshot.id,
    idempotencyKey: snapshot.idempotencyKey,
    _attachedFiles: snapshot.attachments?.map((file) => ({ ...file })),
  };
}
