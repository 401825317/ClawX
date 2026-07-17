import { toMs } from './runtime-control';
import type { ContentBlock, RawMessage } from './types';

const OPTIMISTIC_USER_MESSAGE_TTL_MS = 30 * 60 * 1_000;
export const OPTIMISTIC_USER_TIMESTAMP_MATCH_MS = 120_000;

type PendingOptimisticUserMessage = {
  message: RawMessage;
  timestampMs: number;
  createdAtMs: number;
};

const pendingOptimisticUserMessages = new Map<string, PendingOptimisticUserMessage[]>();

function normalizeBlockText(text: string | undefined): string {
  return typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '';
}

function compactProgressiveTextParts(parts: string[]): string[] {
  const compacted: string[] = [];
  for (const part of parts) {
    const current = normalizeBlockText(part);
    if (!current) continue;
    const previous = compacted.at(-1);
    if (!previous) {
      compacted.push(part);
      continue;
    }
    const normalizedPrevious = normalizeBlockText(previous);
    if (!normalizedPrevious) {
      compacted[compacted.length - 1] = part;
      continue;
    }
    if (current === normalizedPrevious || normalizedPrevious.startsWith(current)) continue;
    if (current.startsWith(normalizedPrevious)) {
      compacted[compacted.length - 1] = part;
      continue;
    }
    compacted.push(part);
  }
  return compacted;
}

/** Extract stable plain text from string or progressive text content blocks. */
export function getMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = (content as Array<{ type?: string; text?: string }>)
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text!);
  return compactProgressiveTextParts(parts).join('\n');
}

/** Clone live content blocks before merging them into renderer-owned state. */
export function normalizeStreamingMessage(message: unknown): unknown {
  if (!message || typeof message !== 'object') return message;
  const rawMessage = message as RawMessage;
  if (!Array.isArray(rawMessage.content)) return rawMessage;
  return {
    ...rawMessage,
    content: (rawMessage.content as ContentBlock[]).map((block) => ({ ...block })),
  };
}

function stripInboundMediaVisionEnvelope(text: string): string {
  if (!/\[Image\]/i.test(text) && !/^User text:/im.test(text) && !/\nDescription:\s*\n/i.test(text)) return text;
  const result = text.replace(/^\s*\[Image\]\s*\n?/i, '');
  const userTextBlock = result.match(/^User text:\s*\n([\s\S]*?)(?:\n\s*Description:\s*\n[\s\S]*)?\s*$/i);
  if (userTextBlock) {
    const userText = userTextBlock[1].trim();
    return /^Process the attached file\(s\)\.\s*$/i.test(userText) ? '' : userText;
  }
  return result.replace(/\n\s*Description:\s*\n[\s\S]*$/i, '').trim();
}

function stripGatewayUserMetadata(text: string): string {
  return stripInboundMediaVisionEnvelope(
    text
      .replace(/\s*\[media attached:[^\]]*\]/g, '')
      .replace(/\s*\[message_id:\s*[^\]]+\]/g, '')
      .replace(/^Sender\s*\([^)]*\)\s*:\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
      .replace(/^Sender\s*\([^)]*\)\s*:\s*\{[\s\S]*?\}\s*/i, '')
      .replace(/^Sender\s*\([^)]*\)\s*:\s*[^\n]*(?:\n\s*)*/i, '')
      .replace(/^Sender\s*:\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
      .replace(/^Sender\s*:\s*\{[\s\S]*?\}\s*/i, '')
      .replace(/^Sender\s*:\s*[^\n]*(?:\n\s*)*/i, '')
      .replace(/^Conversation info\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
      .replace(/^Conversation info\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/i, '')
      .replace(/^\s*\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\]]+\]\s*/i, ''),
  );
}

function normalizeComparableUserText(content: unknown): string {
  const text = stripGatewayUserMetadata(getMessageText(content)).replace(/\s+/g, ' ').trim();
  return /^\(file attached\)$/i.test(text) ? '' : text;
}

function getComparableAttachmentSignature(message: Pick<RawMessage, '_attachedFiles'>): string {
  return (message._attachedFiles || [])
    .map((file) => file.filePath || `${file.fileName}|${file.mimeType}|${file.fileSize}`)
    .filter(Boolean)
    .sort()
    .join('::');
}

function matchesOptimisticUserMessage(
  candidate: RawMessage,
  optimistic: RawMessage,
  optimisticTimestampMs: number,
): boolean {
  if (candidate.role !== 'user') return false;
  const optimisticText = normalizeComparableUserText(optimistic.content);
  const candidateText = normalizeComparableUserText(candidate.content);
  const sameText = optimisticText.length > 0 && optimisticText === candidateText;
  const optimisticAttachments = getComparableAttachmentSignature(optimistic);
  const candidateAttachments = getComparableAttachmentSignature(candidate);
  const sameAttachments = optimisticAttachments.length > 0 && optimisticAttachments === candidateAttachments;
  const hasCandidateTimestamp = candidate.timestamp != null;
  const timestampMatches = Number.isFinite(optimisticTimestampMs) && optimisticTimestampMs > 0 && hasCandidateTimestamp
    ? Math.abs(toMs(candidate.timestamp as number) - optimisticTimestampMs) < OPTIMISTIC_USER_TIMESTAMP_MATCH_MS
    : false;

  if (sameText && sameAttachments) return true;
  if (sameText && (!optimisticAttachments || !candidateAttachments) && (timestampMatches || !hasCandidateTimestamp)) return true;
  if (sameAttachments && (!optimisticText || !candidateText) && (timestampMatches || !hasCandidateTimestamp)) return true;
  const attachmentOnly = optimisticAttachments.length > 0 && !optimisticText;
  const candidateIsAttachmentEcho = !candidateText
    && /\[(?:media attached:|\s*Image\s*\])/i.test(getMessageText(candidate.content));
  return attachmentOnly && candidateIsAttachmentEcho && (timestampMatches || !hasCandidateTimestamp);
}

/** Retain one optimistic user message until history confirms the server echo. */
export function rememberPendingOptimisticUserMessage(
  sessionKey: string,
  message: RawMessage,
  timestampMs: number,
): void {
  const now = Date.now();
  const existing = (pendingOptimisticUserMessages.get(sessionKey) || [])
    .filter((entry) => now - entry.createdAtMs <= OPTIMISTIC_USER_MESSAGE_TTL_MS);
  existing.push({ message, timestampMs, createdAtMs: now });
  pendingOptimisticUserMessages.set(sessionKey, existing);
}

export function clearPendingOptimisticUserMessages(sessionKey: string): void {
  pendingOptimisticUserMessages.delete(sessionKey);
}

/** Reinsert unconfirmed optimistic messages into their timestamp position. */
export function mergePendingOptimisticUserMessages(
  sessionKey: string,
  loadedMessages: RawMessage[],
): RawMessage[] {
  const pending = pendingOptimisticUserMessages.get(sessionKey);
  if (!pending?.length) return loadedMessages;
  const now = Date.now();
  let merged = loadedMessages;
  const stillPending: PendingOptimisticUserMessage[] = [];
  for (const entry of pending) {
    if (now - entry.createdAtMs > OPTIMISTIC_USER_MESSAGE_TTL_MS) continue;
    if (hasOptimisticServerEcho(loadedMessages, entry.message, entry.timestampMs)) continue;
    const alreadyRendered = merged.some((message) => (
      message.id === entry.message.id
      || matchesOptimisticUserMessage(message, entry.message, entry.timestampMs)
    ));
    if (!alreadyRendered) {
      const insertAt = merged.findIndex((message) => (
        typeof message.timestamp === 'number' && toMs(message.timestamp) > entry.timestampMs
      ));
      merged = insertAt === -1
        ? [...merged, entry.message]
        : [...merged.slice(0, insertAt), entry.message, ...merged.slice(insertAt)];
    }
    stillPending.push(entry);
  }
  if (stillPending.length > 0) pendingOptimisticUserMessages.set(sessionKey, stillPending);
  else pendingOptimisticUserMessages.delete(sessionKey);
  return merged;
}

/** Snapshot a partial assistant message without duplicating a persisted message id. */
export function snapshotStreamingAssistantMessage(
  currentStream: RawMessage | null,
  existingMessages: RawMessage[],
  runId: string,
): RawMessage[] {
  if (!currentStream) return [];
  const normalizedStream = normalizeStreamingMessage(currentStream) as RawMessage;
  if (normalizedStream.role !== 'assistant' && normalizedStream.role !== undefined) return [];
  const id = normalizedStream.id || `${runId || 'run'}-turn-${existingMessages.length}`;
  if (existingMessages.some((message) => message.id === id)) return [];
  return [{ ...normalizedStream, role: 'assistant', id }];
}

export function getLatestOptimisticUserMessage(
  messages: RawMessage[],
  userTimestampMs: number,
): RawMessage | undefined {
  return [...messages].reverse().find((message) => (
    message.role === 'user'
    && (!message.timestamp
      || Math.abs(toMs(message.timestamp) - userTimestampMs) < OPTIMISTIC_USER_TIMESTAMP_MATCH_MS)
  ));
}

export function hasOptimisticServerEcho(
  loadedMessages: RawMessage[],
  optimistic: RawMessage,
  optimisticTimestampMs: number,
): boolean {
  if (loadedMessages.some((message) => (
    matchesOptimisticUserMessage(message, optimistic, optimisticTimestampMs)
  ))) return true;
  const optimisticText = normalizeComparableUserText(optimistic.content);
  if (!optimisticText) return false;
  const matchingUsers = loadedMessages.filter((message) => (
    message.role === 'user' && normalizeComparableUserText(message.content) === optimisticText
  ));
  if (matchingUsers.length !== 1) return false;
  const candidate = matchingUsers[0]!;
  if (candidate.timestamp == null) return true;
  return Math.abs(toMs(candidate.timestamp as number) - optimisticTimestampMs) < OPTIMISTIC_USER_TIMESTAMP_MATCH_MS;
}

/** Remove a local optimistic row once another history row proves its server echo. */
export function dropRedundantOptimisticUserMessages(
  sessionKey: string,
  messages: RawMessage[],
): RawMessage[] {
  const pending = pendingOptimisticUserMessages.get(sessionKey);
  if (!pending?.length) return messages;
  const pendingIds = new Set(
    pending.map((entry) => entry.message.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  if (pendingIds.size === 0) return messages;
  return messages.filter((message) => {
    if (message.role !== 'user' || !message.id || !pendingIds.has(message.id)) return true;
    const entry = pending.find((candidate) => candidate.message.id === message.id);
    if (!entry) return true;
    return !hasOptimisticServerEcho(
      messages.filter((candidate) => candidate !== message),
      entry.message,
      entry.timestampMs,
    );
  });
}
