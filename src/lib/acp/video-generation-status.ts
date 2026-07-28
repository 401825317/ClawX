import type { AcpSessionUpdateEnvelope } from '@shared/acp-chat/types';
import type { ChatRuntimeEvent } from '@shared/chat-runtime-events';
import type { GatewayChatMessageEvent } from '@shared/host-events/contract';

const VIDEO_TASK_START_RE = /Background task started for video generation \(([0-9a-f-]{36})\)/iu;
const VIDEO_TASK_REF_RE = /(?:^|:)video_generate:([0-9a-f-]{36})(?::|$)/iu;
const VIDEO_COMPLETION_SOURCE_RE = /sourceSession=video_generate:([0-9a-f-]{36})(?=[:\s]|$)/iu;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function collectStrings(value: unknown, output: string[], depth = 0): void {
  if (depth > 6) return;
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, output, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const entry of Object.values(record)) collectStrings(entry, output, depth + 1);
}

function videoTaskIdFromRef(value: unknown): string | null {
  return stringValue(value)?.match(VIDEO_TASK_REF_RE)?.[1] ?? null;
}

function structuredCompletionTaskId(value: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const taskId = structuredCompletionTaskId(entry, depth + 1);
      if (taskId) return taskId;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  if (stringValue(record.sourceTool)?.toLowerCase() === 'video_generate') {
    const taskId = videoTaskIdFromRef(record.sourceSessionKey ?? record.sourceSession);
    if (taskId) return taskId;
  }
  for (const entry of Object.values(record)) {
    const taskId = structuredCompletionTaskId(entry, depth + 1);
    if (taskId) return taskId;
  }
  return null;
}

/** Reads the authoritative task id returned by OpenClaw's async video tool. */
export function extractVideoGenerationStartFromAcpEnvelope(
  event: AcpSessionUpdateEnvelope,
): { taskId: string; toolCallId?: string } | null {
  const notification = asRecord(event.notification);
  const update = asRecord(notification?.update);
  if (!update) return null;
  const strings: string[] = [];
  collectStrings(update, strings);
  const match = strings.join('\n').match(VIDEO_TASK_START_RE);
  if (!match?.[1]) return null;
  const toolCallId = stringValue(update.toolCallId);
  return { taskId: match[1], ...(toolCallId ? { toolCallId } : {}) };
}

/** Detects the internal completion wake delivered back into the original ACP session. */
export function extractVideoGenerationTerminalTaskIdFromAcpEnvelope(
  event: AcpSessionUpdateEnvelope,
): string | null {
  const structuredTaskId = structuredCompletionTaskId(event.notification);
  if (structuredTaskId) return structuredTaskId;
  const strings: string[] = [];
  collectStrings(event.notification, strings);
  const text = strings.join('\n');
  if (!/sourceTool=video_generate\b/iu.test(text)) return null;
  return text.match(VIDEO_COMPLETION_SOURCE_RE)?.[1] ?? null;
}

/** Detects a completion-agent Gateway message without inspecting nested tool-result details. */
export function extractVideoGenerationTerminalTaskIdFromGatewayChatMessage(
  payload: GatewayChatMessageEvent | unknown,
): string | null {
  const root = asRecord(payload);
  if (!root) return null;
  const envelope = asRecord(root.message) ?? root;
  const state = stringValue(envelope.state ?? (envelope === root ? undefined : root.state))?.toLowerCase();
  if (state !== 'final' && state !== 'error' && state !== 'aborted') return null;
  return videoTaskIdFromRef(envelope.sessionKey)
    ?? videoTaskIdFromRef(envelope.runId)
    ?? (envelope === root ? null : videoTaskIdFromRef(root.sessionKey) ?? videoTaskIdFromRef(root.runId));
}

/** Settles a detached video task only after its completion run reaches a terminal delivery phase. */
export function extractVideoGenerationTerminalTaskIdFromRuntimeEvent(
  event: ChatRuntimeEvent | unknown,
): string | null {
  const record = asRecord(event);
  if (!record) return null;
  const type = stringValue(record.type);
  const terminal = type === 'run.ended'
    || (type === 'assistant.delta' && stringValue(record.phase)?.toLowerCase() === 'final_answer')
    || (type === 'tool.completed' && stringValue(record.name)?.toLowerCase() === 'message');
  if (!terminal) return null;
  return videoTaskIdFromRef(record.sessionKey) ?? videoTaskIdFromRef(record.runId);
}
