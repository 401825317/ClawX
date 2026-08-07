import { getMessageText } from './helpers';
import type { RawMessage } from './types';

const TRUNCATION_SUFFIXES = [
  /\n?\.\.\.\(truncated\)\.\.\.$/,
  /\n?…\(truncated\)…$/,
  /\n?\[chat\.history omitted: message too large\]$/,
];

const MINIMUM_SAFE_PREFIX_LENGTH = 16;

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
      && transcriptContent.startsWith(gatewayPrefix)
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
        && transcriptText.startsWith(gatewayPrefix)
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

function roleTimestampMatchKey(message: RawMessage): string {
  return `${message.role}|${message.timestamp ?? ''}`;
}

type TranscriptLookup = {
  byId: Map<string, RawMessage | null>;
  byRoleTimestamp: Map<string, RawMessage | null>;
};

function addUniqueTranscriptMatch(
  lookup: Map<string, RawMessage | null>,
  key: string,
  message: RawMessage,
): void {
  if (lookup.has(key)) {
    lookup.set(key, null);
    return;
  }
  lookup.set(key, message);
}

function buildTranscriptLookup(transcriptMessages: RawMessage[]): TranscriptLookup {
  const byId = new Map<string, RawMessage | null>();
  const byRoleTimestamp = new Map<string, RawMessage | null>();
  for (const message of transcriptMessages) {
    if (message.id) {
      addUniqueTranscriptMatch(byId, message.id, message);
    }
    addUniqueTranscriptMatch(byRoleTimestamp, roleTimestampMatchKey(message), message);
  }
  return { byId, byRoleTimestamp };
}

function findUniquePrefixMatch(
  message: RawMessage,
  transcriptMessages: RawMessage[],
): RawMessage | undefined {
  // Large media can make the Gateway omit whole records, so array positions
  // are not a reliable identity. Only a unique visible prefix may bridge IDs
  // and timestamps that changed across an OpenClaw upgrade.
  const gatewayText = getMessageText(message.content);
  const prefix = stripTruncationSuffix(gatewayText);
  if (!isTruncatedHistoryText(gatewayText) || prefix.length < MINIMUM_SAFE_PREFIX_LENGTH) {
    return undefined;
  }

  let match: RawMessage | undefined;
  for (const transcriptMessage of transcriptMessages) {
    if (transcriptMessage.role !== message.role) continue;
    if (!getMessageText(transcriptMessage.content).startsWith(prefix)) continue;
    if (match) return undefined;
    match = transcriptMessage;
  }
  return match;
}

function findTranscriptMatch(
  message: RawMessage,
  lookup: TranscriptLookup,
  transcriptMessages: RawMessage[],
): RawMessage | undefined {
  if (message.id) {
    const idMatch = lookup.byId.get(message.id);
    if (idMatch) return idMatch;
  }

  const roleTimestampMatch = lookup.byRoleTimestamp.get(roleTimestampMatchKey(message));
  if (roleTimestampMatch) return roleTimestampMatch;

  // Do not fall back to the absolute message index: the two sources can have
  // different record counts around omitted images and tool results.
  return findUniquePrefixMatch(message, transcriptMessages);
}

export function gatewayHistoryNeedsTranscriptHydration(messages: RawMessage[]): boolean {
  return messages.some((message) => isTruncatedHistoryText(getMessageText(message.content)));
}

export function mergeGatewayHistoryWithTranscript(
  gatewayMessages: RawMessage[],
  transcriptMessages: RawMessage[],
): RawMessage[] {
  if (gatewayMessages.length === 0 || transcriptMessages.length === 0) {
    return gatewayMessages;
  }

  const lookup = buildTranscriptLookup(transcriptMessages);
  return gatewayMessages.map((message) => {
    const transcriptMatch = findTranscriptMatch(message, lookup, transcriptMessages);
    if (!transcriptMatch) return message;

    const nextContent = replaceTruncatedContent(message.content, transcriptMatch.content);
    if (nextContent === message.content) return message;
    return { ...message, content: nextContent };
  });
}
