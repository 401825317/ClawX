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
  if (next.syntheticLocalArtifactConversation !== true && transcriptMessage.syntheticLocalArtifactConversation === true) {
    next.syntheticLocalArtifactConversation = true;
    changed = true;
  }
  if (!next.localArtifactResultKind && transcriptMessage.localArtifactResultKind) {
    next.localArtifactResultKind = transcriptMessage.localArtifactResultKind;
    changed = true;
  }
  if (!next.compositeArtifactManifest && transcriptMessage.compositeArtifactManifest) {
    next.compositeArtifactManifest = {
      ...transcriptMessage.compositeArtifactManifest,
      tasks: transcriptMessage.compositeArtifactManifest.tasks.map((task) => ({
        ...task,
        artifactRefs: [...task.artifactRefs],
      })),
      ...(transcriptMessage.compositeArtifactManifest.runtimeEvents ? {
        runtimeEvents: transcriptMessage.compositeArtifactManifest.runtimeEvents.map((event) => ({ ...event })),
      } : {}),
    };
    changed = true;
  }
  if (!next.mediaGenerationSnapshot && transcriptMessage.mediaGenerationSnapshot) {
    next.mediaGenerationSnapshot = structuredClone(transcriptMessage.mediaGenerationSnapshot);
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

function isTranscriptOwnedResult(message: RawMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (message.syntheticLocalArtifactConversation !== true) return false;
  return message.localArtifactResultKind != null
    || message.compositeArtifactManifest != null
    || message.mediaGenerationSnapshot != null
    || (message._attachedFiles?.length ?? 0) > 0;
}

function timestampMs(message: RawMessage): number {
  const value = typeof message.timestamp === 'number' ? message.timestamp : 0;
  return value > 0 && value < 100_000_000_000 ? value * 1000 : value;
}

export function gatewayHistoryNeedsTranscriptHydration(messages: RawMessage[]): boolean {
  return messages.some((message) => {
    if (isTruncatedHistoryText(getMessageText(message.content))) return true;
    if (message.role !== 'assistant') return false;
    const isCompositeResult = message.localArtifactResultKind === 'composite'
      || message.id?.startsWith('composite-result:') === true
      || /^已完成\s+\d+\/\d+\s+项/u.test(getMessageText(message.content).trim());
    if (isCompositeResult && !message.compositeArtifactManifest) return true;
    const isMediaResult = message.localArtifactResultKind === 'image'
      || message.localArtifactResultKind === 'video'
      || message.id?.startsWith('media-result:') === true;
    return isMediaResult && (
      (message._attachedFiles?.length ?? 0) === 0
      || !message.mediaGenerationSnapshot
    );
  });
}

export function mergeGatewayHistoryWithTranscript(
  gatewayMessages: RawMessage[],
  transcriptMessages: RawMessage[],
): RawMessage[] {
  if (transcriptMessages.length === 0) {
    return gatewayMessages;
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

  const knownPrimaryKeys = new Set(mergedGatewayMessages.map(messageMatchKey));
  const knownRoleTimestampKeys = new Set(mergedGatewayMessages.map(messageRoleTimestampKey));
  const transcriptOnlyResults = transcriptMessages.filter((message) => {
    if (consumedTranscriptMessages.has(message) || !isTranscriptOwnedResult(message)) return false;
    if (knownPrimaryKeys.has(messageMatchKey(message))) return false;
    return !knownRoleTimestampKeys.has(messageRoleTimestampKey(message));
  });
  if (transcriptOnlyResults.length === 0) return mergedGatewayMessages;

  return [...mergedGatewayMessages, ...transcriptOnlyResults]
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const delta = timestampMs(left.message) - timestampMs(right.message);
      return delta !== 0 ? delta : left.index - right.index;
    })
    .map(({ message }) => message);
}
