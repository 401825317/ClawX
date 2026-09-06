import type { ContentBlock, ToolCallContent } from '@agentclientprotocol/sdk';
import { stripAcpWorkingDirectoryPrefix } from '@shared/chat/session-title';
import { ACP_INLINE_IMAGE_MAX_DATA_URI_CHARS } from '@shared/chat/media-limits';
import { createPendingAttachment } from './attachments';
import type { RenderPart } from './timeline-types';

/**
 * Keep the renderer projection bounded before it reaches the reducer. ACP
 * payloads are supplied by a child process, so a malformed provider must not
 * be able to make us allocate one RenderPart for every item in an enormous
 * array and only then discard most of them.
 */
export const ACP_RENDER_CONTENT_MAX_BLOCKS = 512;
export const ACP_RENDER_TEXT_MAX_CHARS = 256 * 1024;
const ACP_RENDER_TEXT_TRUNCATION_MARKER = '\n\n[UClaw: content truncated for memory safety]';
const ACP_ATTACHMENT_URI_MAX_CHARS = 16 * 1024;
const ACP_ATTACHMENT_NAME_MAX_CHARS = 4 * 1024;
const ACP_ATTACHMENT_ID_MAX_CHARS = 1_024;

export type ContentBlockRenderContext = {
  role: 'user' | 'assistant';
  messageId: string;
  segmentIndex: number;
  blockIndex: number;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function boundedText(value: string, maxChars = ACP_RENDER_TEXT_MAX_CHARS): string {
  if (value.length <= maxChars) return value;
  const available = Math.max(0, maxChars - ACP_RENDER_TEXT_TRUNCATION_MARKER.length);
  return `${value.slice(0, available)}${ACP_RENDER_TEXT_TRUNCATION_MARKER}`;
}

function boundedCount(value: number | undefined, fallback: number): number {
  if (!Number.isInteger(value) || value === undefined || value < 1) return fallback;
  return Math.min(value, ACP_RENDER_CONTENT_MAX_BLOCKS);
}

function nonEmptyString(value: unknown): string | undefined {
  const string = optionalString(value);
  return string?.trim() ? string : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function unsupportedContent(message: string): RenderPart {
  return { kind: 'error', message };
}

function isSafeImageUri(value: string | undefined): value is string {
  if (!value) return false;
  return /^(https?:|blob:|file:|data:image\/)/i.test(value.trim());
}

function imageDataSource(mimeType: string | undefined, data: string | undefined): string | undefined {
  if (!mimeType || !data) return undefined;
  return `data:${mimeType};base64,${data}`;
}

function exceedsInlineImageLimit(
  uri: string | undefined,
  data: string | undefined,
  mimeType: string | undefined,
): boolean {
  if (uri && uri.length > ACP_INLINE_IMAGE_MAX_DATA_URI_CHARS) return true;
  if (uri?.trim().toLowerCase().startsWith('data:image/')) return false;
  if (isSafeImageUri(uri) || typeof data !== 'string') return false;
  const prefixLength = mimeType ? `data:${mimeType};base64,`.length : 0;
  return prefixLength + data.length > ACP_INLINE_IMAGE_MAX_DATA_URI_CHARS;
}

function uriBasename(uri: string): string {
  const withoutQuery = uri.split(/[?#]/, 1)[0] ?? uri;
  return withoutQuery.split(/[\\/]/).filter(Boolean).at(-1) ?? uri;
}

function clawxUserMetadata(block: ContentBlock, role: ContentBlockRenderContext['role']): {
  stagingId?: string;
  fileName?: string;
} {
  if (role !== 'user') return {};
  const meta = recordValue(block._meta);
  const clawx = recordValue(meta?.clawx);
  const stagingId = nonEmptyString(clawx?.stagingId);
  const fileName = nonEmptyString(clawx?.fileName);
  return {
    ...(stagingId ? { stagingId } : {}),
    ...(fileName ? { fileName } : {}),
  };
}

function attachmentPart(input: {
  context: ContentBlockRenderContext;
  uri: string;
  name?: string;
  displayPath?: string;
  title?: string;
  mimeType?: string;
  size?: number;
  stagingId?: string;
  unavailable?: boolean;
}): RenderPart {
  const uri = boundedText(input.uri, ACP_ATTACHMENT_URI_MAX_CHARS);
  const name = boundedText(input.name ?? input.title ?? (uri ? uriBasename(uri) : ''), ACP_ATTACHMENT_NAME_MAX_CHARS);
  return createPendingAttachment({
    ...input.context,
    uri,
    name,
    ...(input.displayPath ? { displayPath: boundedText(input.displayPath, ACP_ATTACHMENT_URI_MAX_CHARS) } : {}),
    ...(input.mimeType ? { mimeType: boundedText(input.mimeType, 256) } : {}),
    ...(typeof input.size === 'number' ? { size: input.size } : {}),
    ...(input.stagingId ? { stagingId: boundedText(input.stagingId, ACP_ATTACHMENT_ID_MAX_CHARS) } : {}),
    ...(input.unavailable ? { unavailableReason: 'invalidReference' as const } : {}),
  });
}

export function contentBlockToRenderPart(block: ContentBlock, context: ContentBlockRenderContext): RenderPart {
  switch (block.type) {
    case 'text': {
      const rawText = typeof block.text === 'string' ? block.text : '';
      const text = boundedText(rawText);
      return {
        kind: 'markdown',
        text: context.role === 'user' && context.blockIndex === 0
          ? stripAcpWorkingDirectoryPrefix(text)
          : text,
      };
    }
    case 'image': {
      const uri = optionalString(block.uri);
      const clawx = clawxUserMetadata(block, context.role);
      if (context.role === 'user' && uri) {
        return attachmentPart({
          context,
          uri,
          name: clawx.fileName,
          mimeType: block.mimeType,
          stagingId: clawx.stagingId,
        });
      }
      const data = optionalString(block.data);
      if (exceedsInlineImageLimit(uri, data, block.mimeType)) {
        return unsupportedContent('ACP inline image exceeded the renderer memory safety limit.');
      }
      const source = isSafeImageUri(uri)
        ? uri
        : imageDataSource(block.mimeType, data) ?? uri ?? '';
      return { kind: 'image', source, mimeType: block.mimeType };
    }
    case 'resource_link': {
      const clawx = clawxUserMetadata(block, context.role);
      return attachmentPart({
        context,
        uri: block.uri,
        name: nonEmptyString(block.name),
        title: nonEmptyString(block.title),
        mimeType: block.mimeType ?? undefined,
        size: block.size ?? undefined,
        stagingId: clawx.stagingId,
      });
    }
    case 'resource': {
      const resource = recordValue(block.resource);
      const uri = nonEmptyString(resource?.uri) ?? '';
      return attachmentPart({
        context,
        uri,
        name: nonEmptyString(resource?.name),
        title: nonEmptyString(resource?.title),
        mimeType: nonEmptyString(resource?.mimeType),
        size: optionalNumber(resource?.size),
        unavailable: !uri,
      });
    }
    default:
      return unsupportedContent(`Unsupported ACP content block: ${boundedText(String(block.type), 256)}`);
  }
}

export function contentBlocksToRenderParts(
  blocks: readonly ContentBlock[] | undefined | null,
  context: Omit<ContentBlockRenderContext, 'blockIndex'>,
  options?: { maxBlocks?: number },
): RenderPart[] {
  const source = blocks ?? [];
  const maxBlocks = boundedCount(options?.maxBlocks, ACP_RENDER_CONTENT_MAX_BLOCKS);
  const start = Math.max(0, source.length - maxBlocks);
  const parts: RenderPart[] = [];
  for (let blockIndex = start; blockIndex < source.length; blockIndex += 1) {
    const block = source[blockIndex];
    if (block) parts.push(contentBlockToRenderPart(block, { ...context, blockIndex }));
  }
  return parts;
}

export function toolContentToRenderPart(entry: ToolCallContent, context?: ContentBlockRenderContext): RenderPart {
  switch (entry.type) {
    case 'content':
      return contentBlockToRenderPart(entry.content, context ?? {
        role: 'assistant', messageId: 'tool-content', segmentIndex: 0, blockIndex: 0,
      });
    case 'diff':
      return {
        kind: 'markdown',
        text: `Diff: ${boundedText(entry.path, ACP_ATTACHMENT_URI_MAX_CHARS)}\n\n${boundedText(entry.newText)}`,
      };
    case 'terminal':
      return { kind: 'markdown', text: `Terminal: ${boundedText(entry.terminalId, ACP_ATTACHMENT_ID_MAX_CHARS)}` };
    default:
      return unsupportedContent('Unsupported ACP tool content');
  }
}

export function toolContentToRenderParts(
  content: readonly ToolCallContent[] | undefined | null,
  context?: Omit<ContentBlockRenderContext, 'blockIndex'>,
  options?: { maxBlocks?: number },
): RenderPart[] {
  const source = content ?? [];
  const maxBlocks = boundedCount(options?.maxBlocks, ACP_RENDER_CONTENT_MAX_BLOCKS);
  const start = Math.max(0, source.length - maxBlocks);
  const parts: RenderPart[] = [];
  for (let blockIndex = start; blockIndex < source.length; blockIndex += 1) {
    const entry = source[blockIndex];
    if (entry) {
      parts.push(toolContentToRenderPart(entry, context
        ? { ...context, blockIndex }
        : undefined));
    }
  }
  return parts;
}
