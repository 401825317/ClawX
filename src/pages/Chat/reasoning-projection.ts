import { sanitizeRuntimeDisplayText } from '../../lib/runtime-display-sanitizer';
import type { ChatRuntimeRunState, RawMessage } from '../../stores/chat/types';
import { extractThinkingSegments } from './message-utils';

export type ReasoningVisibilityLevel = 'off' | 'on' | 'stream';

export interface ReasoningPanelProjection {
  id: string;
  text: string;
  source: 'history' | 'runtime' | 'stream' | 'mixed';
  displayMode: 'persisted' | 'live';
  runId?: string;
  historyMessageIndexes: number[];
  updatedAt?: number;
}

export interface ReasoningProjectionInput {
  reasoningLevel?: string | null;
  historyMessages?: readonly RawMessage[];
  historyStartIndex?: number;
  runtimeRun?: Pick<
    ChatRuntimeRunState,
    'runId' | 'status' | 'thinkingText' | 'lastEventAt' | 'endedAt'
  > | null;
  streamMessage?: RawMessage | null;
  activeTurn?: boolean;
  /** Stable user-turn key supplied by the chat segment renderer when available. */
  turnId?: string;
}

interface ReasoningPart {
  text: string;
  source: 'history' | 'runtime' | 'stream';
}

export function normalizeReasoningVisibilityLevel(
  value: string | null | undefined,
): ReasoningVisibilityLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'stream') return normalized;
  return 'off';
}

function normalizeReasoningText(value: string): string {
  return sanitizeRuntimeDisplayText(value)
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function comparableReasoningText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function combineReasoningParts(parts: readonly ReasoningPart[]): string {
  return parts.map((part) => part.text).join('\n\n');
}

function appendReasoningPart(parts: ReasoningPart[], rawPart: ReasoningPart): void {
  const nextText = normalizeReasoningText(rawPart.text);
  if (!nextText) return;

  const nextComparable = comparableReasoningText(nextText);
  const combinedComparable = comparableReasoningText(combineReasoningParts(parts));
  if (combinedComparable) {
    if (nextComparable === combinedComparable || combinedComparable.startsWith(nextComparable)) {
      return;
    }
    if (nextComparable.startsWith(combinedComparable)) {
      parts.splice(0, parts.length, { ...rawPart, text: nextText });
      return;
    }
  }

  const duplicateIndex = parts.findIndex(
    (part) => comparableReasoningText(part.text) === nextComparable,
  );
  if (duplicateIndex >= 0) return;

  const previous = parts.at(-1);
  if (previous) {
    const previousComparable = comparableReasoningText(previous.text);
    if (previousComparable.startsWith(nextComparable)) return;
    if (nextComparable.startsWith(previousComparable)) {
      parts[parts.length - 1] = { ...rawPart, text: nextText };
      return;
    }
  }

  parts.push({ ...rawPart, text: nextText });
}

function hashReasoningText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function getMessageTimestamp(message: RawMessage | null | undefined): number | undefined {
  return typeof message?.timestamp === 'number' && Number.isFinite(message.timestamp)
    ? message.timestamp
    : undefined;
}

function resolvePanelSource(parts: readonly ReasoningPart[]): ReasoningPanelProjection['source'] {
  const sources = new Set(parts.map((part) => part.source));
  if (sources.size !== 1) return 'mixed';
  return parts[0]?.source ?? 'history';
}

/**
 * Projects OpenClaw reasoning into a single panel for one chat turn.
 * Callers should pass only the historical messages belonging to that turn.
 */
export function projectReasoningPanels(input: ReasoningProjectionInput): ReasoningPanelProjection[] {
  const reasoningLevel = normalizeReasoningVisibilityLevel(input.reasoningLevel);
  if (reasoningLevel === 'off') return [];

  const activeTurn = input.activeTurn ?? input.runtimeRun?.status === 'running';
  if (reasoningLevel === 'stream' && !activeTurn) return [];

  const parts: ReasoningPart[] = [];
  const historyMessageIndexes: number[] = [];
  const historyMessages = input.historyMessages ?? [];
  const historyStartIndex = input.historyStartIndex ?? 0;
  let lastHistoryMessageWithThinking: RawMessage | undefined;

  if (reasoningLevel === 'on') {
    historyMessages.forEach((message, localIndex) => {
      if (message.role !== 'assistant') return;
      const segments = extractThinkingSegments(message);
      if (segments.length === 0) return;

      historyMessageIndexes.push(historyStartIndex + localIndex);
      lastHistoryMessageWithThinking = message;
      for (const segment of segments) {
        appendReasoningPart(parts, { text: segment, source: 'history' });
      }
    });
  }

  const runtimeThinking = input.runtimeRun?.thinkingText ?? '';
  if (runtimeThinking.trim()) {
    appendReasoningPart(parts, { text: runtimeThinking, source: 'runtime' });
  }

  if (activeTurn && input.streamMessage) {
    for (const segment of extractThinkingSegments(input.streamMessage)) {
      appendReasoningPart(parts, { text: segment, source: 'stream' });
    }
  }

  const text = combineReasoningParts(parts).trim();
  if (!text) return [];

  const runId = input.runtimeRun?.runId;
  const historyMessageId = lastHistoryMessageWithThinking?.id;
  const stableTurnId = input.turnId || runId || historyMessageId || hashReasoningText(text);
  const runtimeUpdatedAt = input.runtimeRun?.lastEventAt ?? input.runtimeRun?.endedAt;
  const streamUpdatedAt = activeTurn ? getMessageTimestamp(input.streamMessage) : undefined;
  const historyUpdatedAt = getMessageTimestamp(lastHistoryMessageWithThinking);
  const updatedAt = runtimeUpdatedAt ?? streamUpdatedAt ?? historyUpdatedAt;
  const hasLiveSource = activeTurn && parts.some((part) => part.source !== 'history');

  return [{
    id: `reasoning:${stableTurnId}`,
    text,
    source: resolvePanelSource(parts),
    displayMode: hasLiveSource ? 'live' : 'persisted',
    ...(runId ? { runId } : {}),
    historyMessageIndexes,
    ...(updatedAt != null ? { updatedAt } : {}),
  }];
}
