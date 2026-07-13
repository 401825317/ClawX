import { getMessageText } from './helpers';
import type { RawMessage } from './types';

const TRUNCATION_SUFFIXES = [
  /\n?\.\.\.\(truncated\)\.\.\.$/,
  /\n?…\(truncated\)…$/,
  /\n?\[chat\.history omitted: message too large\]$/,
];

export function isTruncatedHistoryText(text: string): boolean {
  if (!text) return false;
  return TRUNCATION_SUFFIXES.some((pattern) => pattern.test(text));
}

function stripTruncationSuffix(text: string): string {
  let result = text;
  for (const pattern of TRUNCATION_SUFFIXES) {
    result = result.replace(pattern, '');
  }
  return result;
}

function replaceTruncatedContent(
  gatewayContent: unknown,
  transcriptContent: unknown,
): unknown {
  if (typeof gatewayContent === 'string' && typeof transcriptContent === 'string') {
    if (!isTruncatedHistoryText(gatewayContent)) return gatewayContent;
    if (isTruncatedHistoryText(transcriptContent)) return gatewayContent;
    const gatewayPrefix = stripTruncationSuffix(gatewayContent);
    if (
      transcriptContent.length > gatewayPrefix.length
      && (transcriptContent.startsWith(gatewayPrefix) || gatewayPrefix.length >= 64)
    ) {
      return transcriptContent;
    }
    return gatewayContent;
  }

  if (!Array.isArray(gatewayContent) || !Array.isArray(transcriptContent)) {
    return gatewayContent;
  }

  const gatewayBlocks = gatewayContent as Array<{ type?: string; text?: string }>;
  const transcriptBlocks = transcriptContent as Array<{ type?: string; text?: string }>;
  if (gatewayBlocks.length !== transcriptBlocks.length) {
    const gatewayText = getMessageText(gatewayContent);
    const transcriptText = getMessageText(transcriptContent);
    if (isTruncatedHistoryText(gatewayText) && !isTruncatedHistoryText(transcriptText)) {
      const gatewayPrefix = stripTruncationSuffix(gatewayText);
      if (
        transcriptText.length > gatewayPrefix.length
        && (transcriptText.startsWith(gatewayPrefix) || gatewayPrefix.length >= 64)
      ) {
        return transcriptContent;
      }
    }
    return gatewayContent;
  }

  let changed = false;
  const mergedBlocks = gatewayBlocks.map((block, index) => {
    if (block.type !== 'text' || typeof block.text !== 'string') return block;
    const transcriptBlock = transcriptBlocks[index];
    if (transcriptBlock?.type !== 'text' || typeof transcriptBlock.text !== 'string') {
      return block;
    }
    const nextText = replaceTruncatedContent(block.text, transcriptBlock.text);
    if (nextText !== block.text) {
      changed = true;
      return { ...block, text: nextText as string };
    }
    return block;
  });

  return changed ? mergedBlocks : gatewayContent;
}

function messageMatchKey(message: RawMessage): string {
  if (message.id) return `id:${message.id}`;
  if (message.idempotencyKey) return `idem:${message.idempotencyKey}`;
  return messageRoleTimestampKey(message);
}

function messageRoleTimestampKey(message: RawMessage): string {
  return `rt:${message.role}|${message.timestamp ?? ''}`;
}

function cloneAttachedFilesFromTranscript(message: RawMessage): RawMessage['_attachedFiles'] | undefined {
  return message._attachedFiles?.map((file) => ({ ...file }));
}

function mergeTranscriptMetadata(
  gatewayMessage: RawMessage,
  transcriptMessage: RawMessage,
): RawMessage {
  let changed = false;
  const next: RawMessage = { ...gatewayMessage };

  if (!next.id && transcriptMessage.id) {
    next.id = transcriptMessage.id;
    changed = true;
  }
  if (!next.idempotencyKey && transcriptMessage.idempotencyKey) {
    next.idempotencyKey = transcriptMessage.idempotencyKey;
    changed = true;
  }
  if (!next.model && transcriptMessage.model) {
    next.model = transcriptMessage.model;
    changed = true;
  }
  if (!next.provenance && transcriptMessage.provenance) {
    next.provenance = { ...transcriptMessage.provenance };
    changed = true;
  }
  if ((next._attachedFiles?.length ?? 0) === 0 && (transcriptMessage._attachedFiles?.length ?? 0) > 0) {
    next._attachedFiles = cloneAttachedFilesFromTranscript(transcriptMessage);
    changed = true;
  }

  return changed ? next : gatewayMessage;
}

function buildTranscriptLookup(transcriptMessages: RawMessage[]): Map<string, RawMessage> {
  const lookup = new Map<string, RawMessage>();
  const ambiguousRoleTimestamps = new Set<string>();
  for (const message of transcriptMessages) {
    const roleTimestampKey = messageRoleTimestampKey(message);
    const primaryKey = messageMatchKey(message);
    if (primaryKey !== roleTimestampKey) lookup.set(primaryKey, message);
    if (ambiguousRoleTimestamps.has(roleTimestampKey)) continue;
    if (lookup.has(roleTimestampKey)) {
      lookup.delete(roleTimestampKey);
      ambiguousRoleTimestamps.add(roleTimestampKey);
      continue;
    }
    lookup.set(roleTimestampKey, message);
  }
  return lookup;
}

function dedupeTranscriptMessages(messages: RawMessage[]): RawMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const key = message.id
      ? `id:${message.id}`
      : message.idempotencyKey
        ? `idem:${message.idempotencyKey}`
        : null;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function gatewayHistoryNeedsTranscriptHydration(messages: RawMessage[]): boolean {
  return messages.some((message) => isTruncatedHistoryText(getMessageText(message.content)));
}

export function mergeGatewayHistoryWithTranscript(
  gatewayMessages: RawMessage[],
  transcriptMessages: RawMessage[],
): RawMessage[] {
  if (transcriptMessages.length === 0) {
    return gatewayMessages;
  }
  if (gatewayMessages.length === 0) {
    return dedupeTranscriptMessages(transcriptMessages);
  }

  const lookup = buildTranscriptLookup(transcriptMessages);
  const consumedTranscriptMessages = new Set<RawMessage>();
  const mergedGatewayMessages = gatewayMessages.map((message) => {
    const transcriptMatch = lookup.get(messageMatchKey(message))
      ?? lookup.get(messageRoleTimestampKey(message));
    if (!transcriptMatch) return message;
    consumedTranscriptMessages.add(transcriptMatch);

    const nextContent = replaceTruncatedContent(message.content, transcriptMatch.content);
    const mergedMetadata = mergeTranscriptMetadata(message, transcriptMatch);
    if (nextContent === message.content && mergedMetadata === message) return message;
    return nextContent === message.content
      ? mergedMetadata
      : { ...mergedMetadata, content: nextContent };
  });

  return mergedGatewayMessages;
}
