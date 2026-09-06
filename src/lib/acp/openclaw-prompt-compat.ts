import type { ContentBlock } from '@agentclientprotocol/sdk';

/**
 * This projection is retained in renderer state for media/transcript
 * correlation. Keep it bounded at the point where ACP blocks are flattened;
 * otherwise a hostile provider can make the temporary array itself larger
 * than the later reducer limit.
 */
export const OPENCLAW_PROMPT_TEXT_MAX_BLOCKS = 128;
export const OPENCLAW_PROMPT_TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const OPENCLAW_PROMPT_TEXT_MAX_CHARS = 256 * 1024;
const PROMPT_TRUNCATION_MARKER = '\n\n[UClaw: content truncated for memory safety]';

const INLINE_CONTROL_ESCAPE_MAP: Readonly<Record<string, string>> = {
  '\0': '\\0',
  '\r': '\\r',
  '\n': '\\n',
  '\t': '\\t',
  '\v': '\\v',
  '\f': '\\f',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

function escapeInlineControlChars(value: string): string {
  const chunks: string[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    const isInlineControl = codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x2028
      || codePoint === 0x2029;
    if (!isInlineControl) {
      chunks.push(character);
      continue;
    }
    chunks.push(INLINE_CONTROL_ESCAPE_MAP[character]
      ?? (codePoint <= 0xff
        ? `\\x${codePoint.toString(16).padStart(2, '0')}`
        : `\\u${codePoint.toString(16).padStart(4, '0')}`));
  }
  return chunks.join('');
}

function escapeResourceTitle(value: string): string {
  return escapeInlineControlChars(value).replace(/[()[\]]/g, (character) => `\\${character}`);
}

function boundedPromptText(value: string, maxChars = OPENCLAW_PROMPT_TEXT_MAX_CHARS): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= PROMPT_TRUNCATION_MARKER.length) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - PROMPT_TRUNCATION_MARKER.length)}${PROMPT_TRUNCATION_MARKER}`;
}

export function openClawResourceLinkPromptText(uri: string, title?: string): string {
  const boundedUri = boundedPromptText(typeof uri === 'string' ? uri : '');
  const boundedTitle = typeof title === 'string' ? boundedPromptText(title, 64 * 1024) : undefined;
  const titleSuffix = boundedTitle ? ` (${escapeResourceTitle(boundedTitle)})` : '';
  const escapedUri = boundedUri ? escapeInlineControlChars(boundedUri) : '';
  const result = escapedUri
    ? `[Resource link${titleSuffix}] ${escapedUri}`
    : `[Resource link${titleSuffix}]`;
  return boundedPromptText(result);
}

export function openClawPromptTextBlocks(blocks: readonly ContentBlock[]): string[] {
  const textBlocks: string[] = [];
  let retainedBytes = 0;
  const start = Math.max(0, blocks.length - OPENCLAW_PROMPT_TEXT_MAX_BLOCKS);
  const append = (value: string): void => {
    // Bound each candidate before concatenating/escaping it.  A queue-style
    // append then evicts the oldest retained blocks when the aggregate budget
    // is crossed, so a large early block cannot prevent newer prompt content
    // from being retained.
    const bounded = boundedPromptText(value, OPENCLAW_PROMPT_TEXT_MAX_CHARS);
    const bytes = bounded.length * 2 + 8;
    if (bytes > OPENCLAW_PROMPT_TEXT_MAX_BYTES) return;
    while (textBlocks.length > 0 && retainedBytes + bytes > OPENCLAW_PROMPT_TEXT_MAX_BYTES) {
      const removed = textBlocks.shift();
      if (removed !== undefined) retainedBytes = Math.max(0, retainedBytes - (removed.length * 2 + 8));
    }
    if (retainedBytes + bytes <= OPENCLAW_PROMPT_TEXT_MAX_BYTES) {
      textBlocks.push(bounded);
      retainedBytes += bytes;
    }
  };

  for (let index = start; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    if (block.type === 'text') {
      append(block.text);
      continue;
    }
    if (block.type === 'resource') {
      const resource = block.resource && typeof block.resource === 'object'
        ? block.resource as unknown as Record<string, unknown>
        : undefined;
      if (typeof resource?.text === 'string') append(resource.text);
      continue;
    }
    if (block.type === 'resource_link') {
      append(openClawResourceLinkPromptText(
        block.uri,
        typeof block.title === 'string' ? block.title : undefined,
      ));
    }
  }
  return textBlocks;
}
