import {
  CONVERSATION_EVENT_CONTRACT_VERSION,
  type ConversationEvent,
  type ConversationEventAuthority,
  type ConversationEventData,
  type ConversationEventSource,
  type ConversationEventType,
} from '../../../shared/conversation-events';
import type { ChatRuntimeArtifact, ChatRuntimeEvent } from '../../../shared/chat-runtime-events';
import { CHAT_SYNTHETIC_TERMINAL_PRODUCER } from '../../../shared/chat-runtime-events';
import { asyncTaskPayloadToConversationEvents } from './async-task-adapter';
import { isRecoverableConversationError } from './chat-adapter';
import { createEventId, stableHash } from './identity';

function eventTime(event: ChatRuntimeEvent): number {
  const value = event.ts
    ?? (event.type === 'run.started' ? event.startedAt : undefined)
    ?? (event.type === 'run.ended' ? event.endedAt : undefined)
    ?? Date.now();
  return value > 0 && value < 100_000_000_000 ? value * 1_000 : value;
}

function hasSourceEventTime(event: ChatRuntimeEvent): boolean {
  return event.ts != null
    || (event.type === 'run.started' && event.startedAt != null)
    || (event.type === 'run.ended' && event.endedAt != null);
}

function authorityFor(
  event: ChatRuntimeEvent,
  source: ConversationEventSource,
): ConversationEventAuthority {
  if (event.producer === CHAT_SYNTHETIC_TERMINAL_PRODUCER) return 'corroborating';
  if (source === 'derived') return 'inferred';
  if (event.type === 'assistant.delta' || event.type === 'thinking.delta' || event.type === 'progress.update') {
    return 'corroborating';
  }
  return 'authoritative';
}

function sourceFor(event: ChatRuntimeEvent): ConversationEventSource {
  switch (event.producer) {
    case 'history': return 'history';
    case CHAT_SYNTHETIC_TERMINAL_PRODUCER: return 'synthetic';
    case 'uclaw-host-task':
    case 'openclaw-task-ledger':
      return 'task-ledger';
    case 'plugin':
    case 'uclaw-artifact-guard':
      return 'plugin';
    case 'media': return 'host';
    case 'uclaw-desktop-approval': return 'host';
    case 'renderer': return 'derived';
    case 'gateway':
    case 'openclaw':
    case undefined:
      return 'openclaw-runtime';
    default:
      return 'derived';
  }
}

function artifactWithAvailability(artifact: ChatRuntimeArtifact): ChatRuntimeArtifact {
  if (artifact.error) return { ...artifact, availability: 'error' };
  if (artifact.availability) return artifact;
  if ((artifact.sizeBytes ?? 0) > 0 || artifact.url || artifact.preview) {
    return { ...artifact, availability: 'available' };
  }
  return { ...artifact, availability: 'registered' };
}

function eventType(event: ChatRuntimeEvent): ConversationEventType {
  switch (event.type) {
    case 'run.started': return 'run.started';
    case 'run.ended': return 'run.ended';
    case 'assistant.delta': return 'assistant.content';
    case 'thinking.delta': return 'thinking.content';
    case 'progress.update': return event.entry.kind === 'commentary' ? 'commentary.append' : 'progress.updated';
    case 'tool.started': return 'tool.started';
    case 'tool.updated': return 'tool.updated';
    case 'tool.completed': return 'tool.completed';
    case 'task.updated': return 'task.updated';
    case 'run.plan.updated': return 'plan.updated';
    case 'run.step.updated': return 'step.updated';
    case 'approval.updated': return 'approval.updated';
    case 'artifact.produced': return 'artifact.updated';
    case 'verification.completed': return 'verification.updated';
    case 'command.output': return event.phase === 'end' || event.status === 'completed'
      ? 'tool.completed'
      : 'tool.updated';
    case 'patch.completed': return 'tool.completed';
  }
}

function eventData(event: ChatRuntimeEvent): ConversationEventData {
  switch (event.type) {
    case 'run.started':
      return { startedAt: event.startedAt, objective: event.objective };
    case 'run.ended':
      return {
        status: event.status,
        endedAt: event.endedAt,
        error: event.error,
        stopReason: event.stopReason,
      };
    case 'assistant.delta':
    case 'thinking.delta':
      return {
        text: event.text,
        delta: event.delta,
        ...('replace' in event ? { replace: event.replace, phase: event.phase, mediaUrls: event.mediaUrls } : {}),
      };
    case 'progress.update':
      return { entry: event.entry };
    case 'tool.started':
      return { toolCallId: event.toolCallId, name: event.name, args: event.args };
    case 'tool.updated':
      return { toolCallId: event.toolCallId, name: event.name, partialResult: event.partialResult };
    case 'tool.completed':
      return {
        toolCallId: event.toolCallId,
        name: event.name,
        result: event.result,
        meta: event.meta,
        durationMs: event.durationMs,
        isError: event.isError,
      };
    case 'task.updated':
      return { task: event.task };
    case 'run.plan.updated':
      return { objective: event.objective, summary: event.summary, steps: event.steps };
    case 'run.step.updated':
      return { step: event.step };
    case 'artifact.produced':
      return { artifact: artifactWithAvailability(event.artifact), itemId: event.itemId };
    case 'verification.completed':
      return { verification: event.verification, itemId: event.itemId };
    case 'approval.updated':
      return {
        approvalId: event.approvalId,
        approvalKind: event.approvalKind,
        allowedDecisions: event.allowedDecisions,
        decision: event.decision,
        requestedAt: event.requestedAt,
        expiresAt: event.expiresAt,
        request: event.request,
        actionable: event.actionable,
        resolutionSource: event.resolutionSource,
        itemId: event.itemId,
        title: event.title,
        kind: event.kind,
        phase: event.phase,
        status: event.status,
        message: event.message,
      };
    case 'command.output':
      return {
        toolCallId: event.toolCallId ?? event.itemId ?? `command:${event.runId}`,
        name: event.name ?? 'command',
        partialResult: event.output,
        result: event.output,
        durationMs: event.durationMs,
        isError: event.exitCode != null ? event.exitCode !== 0 : event.status === 'error',
      };
    case 'patch.completed':
      return {
        toolCallId: event.toolCallId ?? event.itemId ?? `patch:${event.runId}`,
        name: event.name ?? 'patch',
        result: {
          summary: event.summary,
          added: event.added,
          modified: event.modified,
          deleted: event.deleted,
        },
      };
  }
}

/** Keep entity identity independent from sequence numbers shared by gateway fan-out. */
function eventEntityId(event: ChatRuntimeEvent): string | undefined {
  switch (event.type) {
    case 'tool.started':
    case 'tool.updated':
    case 'tool.completed':
      return `tool:${event.toolCallId}`;
    case 'task.updated':
      return `task:${event.task.taskId}`;
    case 'run.step.updated':
      return `step:${event.step.id}`;
    case 'progress.update':
      return `progress:${event.entry.id}`;
    case 'artifact.produced':
      return `artifact:${event.artifact.id}`;
    case 'verification.completed':
      return `verification:${event.verification.id}`;
    case 'approval.updated':
      return `approval:${event.approvalId ?? event.itemId ?? event.toolCallId ?? event.kind ?? stableHash(eventData(event))}`;
    case 'command.output':
      return `tool:${event.toolCallId ?? event.itemId ?? `command:${event.runId}`}`;
    case 'patch.completed':
      return `tool:${event.toolCallId ?? event.itemId ?? `patch:${event.runId}`}`;
    default:
      return undefined;
  }
}

/** Keep no-sequence runtime updates distinct while retransmissions stay idempotent. */
function eventIdentityPhase(
  event: ChatRuntimeEvent,
  data: ConversationEventData,
  occurredAt: number,
): string {
  let phase: string;
  switch (event.type) {
    case 'run.started': phase = 'started'; break;
    case 'run.ended': phase = `ended:${event.status}`; break;
    case 'assistant.delta': phase = `assistant:${event.phase ?? 'delta'}:${stableHash(data)}`; break;
    case 'thinking.delta': phase = `thinking:${stableHash(data)}`; break;
    case 'progress.update': phase = `progress:${event.entry.id}:${event.entry.status ?? 'update'}:${stableHash(data)}`; break;
    case 'tool.started': phase = `start:${stableHash(data)}`; break;
    case 'tool.updated': phase = `update:${stableHash(data)}`; break;
    case 'tool.completed': phase = `completed:${stableHash(data)}`; break;
    case 'task.updated': phase = `task:${event.task.status}:${stableHash(data)}`; break;
    case 'run.plan.updated': phase = `plan:${stableHash(data)}`; break;
    case 'run.step.updated': phase = `step:${event.step.id}:${event.step.status ?? 'update'}:${stableHash(data)}`; break;
    case 'artifact.produced': phase = `artifact:${event.artifact.id}:${stableHash(data)}`; break;
    case 'verification.completed': phase = `verification:${event.verification.id}:${event.verification.status}:${stableHash(data)}`; break;
    case 'approval.updated': phase = `approval:${event.approvalId ?? event.itemId ?? event.kind ?? 'request'}:${event.decision ?? event.status ?? event.phase ?? 'update'}:${stableHash(data)}`; break;
    case 'command.output': phase = `command:${event.phase ?? event.status ?? 'update'}:${stableHash(data)}`; break;
    case 'patch.completed': phase = `patch:${event.itemId ?? 'completed'}:${stableHash(data)}`; break;
  }
  const sourceTimeOwnsNarrativeIdentity = event.type === 'assistant.delta' || event.type === 'thinking.delta';
  return hasSourceEventTime(event) && (event.seq == null || sourceTimeOwnsNarrativeIdentity)
    ? `${phase}:at:${occurredAt}`
    : phase;
}

export function runtimeEventToConversationEvent(event: ChatRuntimeEvent): ConversationEvent | null {
  const sessionKey = event.sessionKey?.trim();
  if (!sessionKey) return null;
  const type = eventType(event);
  const data = eventData(event);
  const occurredAt = eventTime(event);
  const toolCallId = 'toolCallId' in event ? event.toolCallId : undefined;
  const taskId = event.taskId ?? (event.type === 'task.updated' ? event.task.taskId : undefined);
  const parentTaskId = event.parentTaskId
    ?? (event.type === 'task.updated' ? event.task.parentTaskId : undefined);
  const phase = eventIdentityPhase(event, data, occurredAt);
  const source = sourceFor(event);
  const entityId = eventEntityId(event);
  const rootRunId = event.rootRunId
    ?? (source === 'task-ledger' ? undefined : event.runId);
  return {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: createEventId({
      source,
      type,
      runId: event.runId,
      seq: event.seq,
      entityId,
      toolCallId,
      taskId,
      phase,
      occurredAt,
      data,
    }),
    type,
    source,
    authority: authorityFor(event, source),
    sessionKey,
    rootRunId,
    runId: event.runId,
    taskId,
    parentTaskId,
    toolCallId,
    timelineVisibility: event.timelineVisibility,
    seq: event.seq,
    occurredAt,
    receivedAt: Date.now(),
    replayed: event.producer === 'history',
    data,
  };
}

function runtimeErrorConversationEvent(
  event: ChatRuntimeEvent,
  canonical: ConversationEvent,
): ConversationEvent | null {
  if (event.type !== 'run.ended' || event.status !== 'error') return null;
  const error = event.error?.trim();
  if (!error) return null;
  return {
    ...canonical,
    eventId: createEventId({
      source: canonical.source,
      type: 'turn.error',
      runId: event.runId,
      seq: event.seq,
      phase: `runtime-error:${stableHash(error)}`,
      occurredAt: canonical.occurredAt,
      data: error,
    }),
    type: 'turn.error',
    data: {
      error,
      recoverable: event.recoverable ?? isRecoverableConversationError(error),
    },
  };
}

/** Keep the native runtime fact first, then append its visible error and derived task ownership. */
export function runtimeEventToConversationEvents(event: ChatRuntimeEvent): ConversationEvent[] {
  const canonical = runtimeEventToConversationEvent(event);
  if (!canonical) return [];
  if (event.type === 'task.updated') return [canonical];
  const errorEvent = runtimeErrorConversationEvent(event, canonical);
  return [canonical, ...(errorEvent ? [errorEvent] : []), ...asyncTaskPayloadToConversationEvents(event, {
    sessionKey: canonical.sessionKey,
    turnId: canonical.turnId,
    rootRunId: canonical.rootRunId,
    runId: event.runId,
    parentTaskId: event.parentTaskId,
    toolCallId: event.toolCallId,
    seq: event.seq,
    occurredAt: canonical.occurredAt,
    receivedAt: canonical.receivedAt,
    replayed: canonical.replayed,
  })];
}
