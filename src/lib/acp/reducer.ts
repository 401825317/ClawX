import type {
  ContentBlock,
  PlanEntry,
  SessionConfigOption,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk';
import {
  ACP_RENDER_CONTENT_MAX_BLOCKS,
  contentBlockToRenderPart,
  contentBlocksToRenderParts,
  toolContentToRenderPart,
  toolContentToRenderParts,
} from './content-blocks';
import { createPendingAttachment, dedupeTimelineAttachments, mergeMonotonicAttachment } from './attachments';
import { parseOfficeArtifactToolResult } from './artifact-tool-result';
import { openClawPromptTextBlocks } from './openclaw-prompt-compat';
import { normalizeAcpChatError } from '@shared/acp-chat/errors';
import type { AcpTurnRetryReplacement } from '@shared/acp-chat/types';
import { estimateValueBytes } from '@shared/acp-chat/bounded-event-queue';
import { ACP_INLINE_IMAGE_MAX_DATA_URI_CHARS } from '@shared/chat/media-limits';
import type { AcpTimelineSnapshot, AttachmentRenderPart, MessageSegmentItem, RenderPart, TimelineItem, ToolCallItem } from './timeline-types';

type UpdateRecord = Record<string, unknown> & {
  sessionUpdate?: unknown;
};

type ApplyUpdateOptions = {
  historical?: boolean;
};

type Role = MessageSegmentItem['role'];

/**
 * Renderer-side safety rails.  These are deliberately conservative enough to
 * preserve ordinary conversations while preventing one pathological stream
 * from retaining an unbounded amount of text/tool output in React state.
 */
export const ACP_TIMELINE_MAX_ITEMS = 1_000;
export const ACP_TIMELINE_MAX_BYTES = 4 * 1024 * 1024;
export const ACP_RENDER_PART_MAX_CHARS = 256 * 1024;
export const ACP_TOOL_OUTPUT_MAX_BYTES = 1 * 1024 * 1024;
const ACP_METADATA_MAX_BYTES = 256 * 1024;
const ACP_METADATA_MAX_ITEMS = 256;
const ACP_PERMISSION_MAX_OPTIONS = 64;
const ACP_PLAN_MAX_ENTRIES = 256;
const ACP_PLAN_ENTRY_MAX_CHARS = 16 * 1024;
const ACP_METADATA_STRING_MAX_CHARS = 32 * 1024;
const ACP_IDENTIFIER_MAX_CHARS = 1_024;
const ACP_PROMPT_TEXT_BLOCK_MAX_BYTES = 2 * 1024 * 1024;
const ACP_RENDER_PART_MAX_COUNT = 512;
const ACP_PROMPT_TEXT_BLOCK_MAX_COUNT = 128;
const ACP_CONFIG_OPTION_MAX_DEPTH = 8;
const ACP_TOOL_LOCATION_MAX_COUNT = 256;
const ACP_TOOL_LOCATION_PATH_MAX_CHARS = 8 * 1024;
const ACP_TOOL_LOCATION_META_MAX_BYTES = 16 * 1024;
const ACP_TOOL_LOCATION_META_MAX_ITEMS = 32;
const ACP_TOOL_LOCATION_META_KEY_MAX_CHARS = 256;
const ACP_TOOL_LOCATION_META_STRING_MAX_CHARS = 4 * 1024;
const ACP_TRUNCATION_MARKER = '\n\n[UClaw: content truncated for memory safety]';
const ACP_OMITTED_VALUE_MARKER = '[UClaw: value omitted after exceeding the memory safety budget]';

const timelineByteEstimates = new WeakMap<object, number>();
/**
 * A snapshot-level fast-path marker.  We must not use only the aggregate byte
 * count as proof that a snapshot is safe: one tool result can be 2 MiB while
 * the whole timeline is still below the 4 MiB aggregate limit.  The marker is
 * propagated only from snapshots that have already passed the full projection
 * (or from a mutation that bounds the newly-created item itself), so ordinary
 * streaming updates stay O(1) while imported/legacy snapshots are normalized
 * once before they can take the fast path.
 */
const boundedTimelineSnapshots = new WeakSet<object>();

function truncateText(value: string, maxChars = ACP_RENDER_PART_MAX_CHARS): string {
  if (value.length <= maxChars) return value;
  const available = Math.max(0, maxChars - ACP_TRUNCATION_MARKER.length);
  return `${value.slice(0, available)}${ACP_TRUNCATION_MARKER}`;
}

function boundRenderPart(part: RenderPart): RenderPart {
  if (part.kind === 'markdown') return { ...part, text: truncateText(part.text) };
  if (part.kind === 'error') return { ...part, message: truncateText(part.message, 64 * 1024) };
  if (part.kind === 'image' && /^data:/i.test(part.source) && part.source.length > ACP_INLINE_IMAGE_MAX_DATA_URI_CHARS) {
    return {
      kind: 'error',
      message: 'ACP inline image exceeded the renderer memory safety limit.',
    };
  }
  return part;
}

function boundRenderParts(
  parts: readonly RenderPart[],
  maxBytes: number,
  maxCount = ACP_RENDER_PART_MAX_COUNT,
): RenderPart[] {
  if (parts.length === 0) return [];
  const result: RenderPart[] = [];
  let bytes = 0;
  for (const input of parts) {
    const part = boundRenderPart(input);
    const partBytes = estimateValueBytes(part, maxBytes + 1);
    if (result.length < maxCount && bytes + partBytes <= maxBytes) {
      result.push(part);
      bytes += partBytes;
      continue;
    }
    // Terminal/error and attachment records are useful, but they must obey
    // the same count/byte limits.  A malformed attachment can itself contain
    // unbounded metadata, so silently omit it when it does not fit.
    // Intermediate markdown/image chunks are safe to omit because the
    // complete source remains on disk.
    if (part.kind === 'error' || part.kind === 'attachment') continue;
    if (result.length > 0 && result.at(-1)?.kind === 'markdown' && part.kind === 'markdown') {
      const previous = result.at(-1)!;
      if (previous.kind === 'markdown') {
        const previousBytes = estimateValueBytes(previous, maxBytes + 1);
        const available = Math.max(0, maxBytes - (bytes - previousBytes));
        const merged = {
          ...previous,
          text: truncateText(`${previous.text}${part.text}`, Math.min(
            ACP_RENDER_PART_MAX_CHARS,
            Math.max(1, Math.floor(available / 2)),
          )),
        };
        const mergedBytes = estimateValueBytes(merged, maxBytes + 1);
        if (mergedBytes <= available) {
          result[result.length - 1] = merged;
          bytes = bytes - previousBytes + mergedBytes;
        }
      }
    }
  }
  return result;
}

function boundedToolValue(value: unknown, maxBytes: number): unknown {
  if (estimateValueBytes(value, maxBytes + 1) <= maxBytes) return value;
  if (typeof value === 'string') return truncateText(value, Math.floor(maxBytes / 2));
  return {
    __uclawTruncated: true,
    preview: ACP_OMITTED_VALUE_MARKER,
  };
}

function boundedIdentifier(value: unknown, fallback: string): string {
  return typeof value === 'string'
    ? truncateText(value, ACP_IDENTIFIER_MAX_CHARS)
    : fallback;
}

function boundedPromptTextBlocks(value: readonly unknown[]): string[] {
  const result: string[] = [];
  let bytes = 0;
  const start = Math.max(0, value.length - ACP_PROMPT_TEXT_BLOCK_MAX_COUNT);
  for (let index = start; index < value.length; index += 1) {
    const raw = value[index];
    if (typeof raw !== 'string') continue;
    const maxChars = Math.min(
      ACP_RENDER_PART_MAX_CHARS,
      Math.max(1, Math.floor(Math.max(0, ACP_PROMPT_TEXT_BLOCK_MAX_BYTES - 8) / 2)),
    );
    const text = truncateText(raw, maxChars);
    const textBytes = estimateValueBytes(text, ACP_PROMPT_TEXT_BLOCK_MAX_BYTES + 1);
    if (textBytes > ACP_PROMPT_TEXT_BLOCK_MAX_BYTES) continue;
    // Keep the newest blocks when the aggregate byte budget is crossed. The
    // queue is capped at 128 entries, so shifting here remains bounded while
    // avoiding a large slice/map temporary allocation.
    while (result.length > 0 && bytes + textBytes > ACP_PROMPT_TEXT_BLOCK_MAX_BYTES) {
      const removed = result.shift();
      if (removed !== undefined) {
        bytes = Math.max(0, bytes - estimateValueBytes(removed, ACP_PROMPT_TEXT_BLOCK_MAX_BYTES + 1));
      }
    }
    if (bytes + textBytes > ACP_PROMPT_TEXT_BLOCK_MAX_BYTES) continue;
    result.push(text);
    bytes += textBytes;
  }
  return result;
}

function boundedPlanEntries(value: unknown): PlanEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-ACP_PLAN_MAX_ENTRIES).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const raw = entry as Record<string, unknown>;
    const priority = raw.priority === 'high' || raw.priority === 'medium' || raw.priority === 'low'
      ? raw.priority
      : 'medium';
    const status = raw.status === 'pending' || raw.status === 'in_progress' || raw.status === 'completed'
      ? raw.status
      : 'pending';
    return [{
      content: truncateText(typeof raw.content === 'string' ? raw.content : '', ACP_PLAN_ENTRY_MAX_CHARS),
      priority,
      status,
    } as PlanEntry];
  });
}

function boundedConfigSelectOptions(value: unknown, depth = 0): unknown[] {
  if (!Array.isArray(value)) return [];
  if (depth >= ACP_CONFIG_OPTION_MAX_DEPTH) return [];
  const result: unknown[] = [];
  const start = Math.max(0, value.length - ACP_METADATA_MAX_ITEMS);
  for (let index = start; index < value.length; index += 1) {
    const entry = value[index];
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const name = truncateText(typeof raw.name === 'string' ? raw.name : '', ACP_METADATA_STRING_MAX_CHARS);
    const description = typeof raw.description === 'string'
      ? truncateText(raw.description, ACP_METADATA_STRING_MAX_CHARS)
      : raw.description === null ? null : undefined;
    if (typeof raw.group === 'string' && Array.isArray(raw.options)) {
      result.push({
        group: boundedIdentifier(raw.group, ''),
        name,
        ...(description !== undefined ? { description } : {}),
        options: boundedConfigSelectOptions(raw.options, depth + 1),
      });
      continue;
    }
    result.push({
      value: boundedIdentifier(raw.value, ''),
      name,
      ...(description !== undefined ? { description } : {}),
    });
  }
  return result;
}

function boundedConfigOptions(value: unknown): SessionConfigOption[] {
  if (!Array.isArray(value)) return [];
  const result: SessionConfigOption[] = [];
  const start = Math.max(0, value.length - ACP_METADATA_MAX_ITEMS);
  for (let index = start; index < value.length; index += 1) {
    const option = value[index];
    if (!option || typeof option !== 'object') continue;
    const raw = option as Record<string, unknown>;
    const type = raw.type === 'select' || raw.type === 'boolean' ? raw.type : undefined;
    if (!type) continue;
    const id = boundedIdentifier(raw.id, 'unknown');
    const name = truncateText(typeof raw.name === 'string' ? raw.name : id, ACP_METADATA_STRING_MAX_CHARS);
    const description = typeof raw.description === 'string'
      ? truncateText(raw.description, ACP_METADATA_STRING_MAX_CHARS)
      : raw.description === null ? null : undefined;
    const category = typeof raw.category === 'string'
      ? truncateText(raw.category, 256)
      : raw.category === null ? null : undefined;
    const base = {
      type,
      id,
      name,
      ...(description !== undefined ? { description } : {}),
      ...(category !== undefined ? { category } : {}),
    };
    if (type === 'boolean') {
      result.push({ ...base, currentValue: raw.currentValue === true } as SessionConfigOption);
      continue;
    }
    result.push({
      ...base,
      currentValue: boundedIdentifier(raw.currentValue, ''),
      options: boundedConfigSelectOptions(raw.options, 0),
    } as SessionConfigOption);
  }
  return result;
}

function boundedMetadata(metadata: AcpTimelineSnapshot['metadata']): AcpTimelineSnapshot['metadata'] {
  const boundedCommands = metadata.availableCommands
    ? boundedToolValue(metadata.availableCommands.slice(-ACP_METADATA_MAX_ITEMS), ACP_METADATA_MAX_BYTES)
    : undefined;
  const next: AcpTimelineSnapshot['metadata'] = {
    ...(typeof metadata.currentModeId === 'string'
      ? { currentModeId: truncateText(metadata.currentModeId, ACP_IDENTIFIER_MAX_CHARS) }
      : {}),
    ...(typeof metadata.title === 'string'
      ? { title: truncateText(metadata.title, ACP_METADATA_STRING_MAX_CHARS) }
      : metadata.title === null ? { title: null } : {}),
    ...(typeof metadata.updatedAt === 'string'
      ? { updatedAt: truncateText(metadata.updatedAt, 2_048) }
      : metadata.updatedAt === null ? { updatedAt: null } : {}),
    ...(Array.isArray(boundedCommands) ? { availableCommands: boundedCommands } : {}),
    ...(metadata.configOptions
      ? { configOptions: boundedConfigOptions(metadata.configOptions) }
      : {}),
    ...(metadata.usage !== undefined
      ? { usage: boundedToolValue(metadata.usage, ACP_METADATA_MAX_BYTES) }
      : {}),
  };
  const bounded = estimateValueBytes(next, ACP_METADATA_MAX_BYTES + 1) <= ACP_METADATA_MAX_BYTES
    ? next
    : {
        ...(next.currentModeId ? { currentModeId: next.currentModeId } : {}),
        usage: { __uclawTruncated: true, preview: ACP_OMITTED_VALUE_MARKER },
      };
  return bounded;
}

function boundTimelineItem(item: TimelineItem): TimelineItem {
  const projected: TimelineItem = (() => {
    switch (item.kind) {
    case 'message-segment':
      return {
        ...item,
        parts: boundRenderParts(item.parts, ACP_TOOL_OUTPUT_MAX_BYTES),
        ...(item.userPromptTextBlocks
          ? {
              userPromptTextBlocks: boundedPromptTextBlocks(item.userPromptTextBlocks),
            }
          : {}),
      };
    case 'thought':
      return { ...item, parts: boundRenderParts(item.parts, ACP_TOOL_OUTPUT_MAX_BYTES) };
    case 'tool-call':
      return {
        ...item,
        input: boundedToolValue(item.input, ACP_TOOL_OUTPUT_MAX_BYTES),
        output: boundedToolValue(item.output, ACP_TOOL_OUTPUT_MAX_BYTES),
        outputParts: boundRenderParts(item.outputParts, ACP_TOOL_OUTPUT_MAX_BYTES),
        error: item.error ? truncateText(item.error, 64 * 1024) : item.error,
        locations: boundedToolLocations(item.locations),
      };
    case 'plan':
      return { ...item, entries: boundedPlanEntries(item.entries) };
    case 'permission':
      return {
        ...item,
        title: truncateText(item.title, ACP_METADATA_STRING_MAX_CHARS),
        options: item.options.slice(-ACP_PERMISSION_MAX_OPTIONS).map((option) => ({
          optionId: boundedIdentifier(option.optionId, ''),
          name: truncateText(option.name, ACP_METADATA_STRING_MAX_CHARS),
          kind: truncateText(option.kind, 256),
        })),
      };
    case 'turn-failure':
      return {
        ...item,
        failure: {
          ...item.failure,
          message: truncateText(item.failure.message, 64 * 1024),
          ...(item.failure.upstreamCode
            ? { upstreamCode: truncateText(item.failure.upstreamCode, 4_096) }
            : {}),
        },
      };
    case 'turn-retry':
      return {
        ...item,
        userMessageId: boundedIdentifier(item.userMessageId, 'message'),
        attempt: Math.max(1, Math.floor(item.attempt)),
        maxAttempts: Math.max(1, Math.floor(item.maxAttempts)),
      };
    default:
      return item;
    }
  })();

  if (estimateValueBytes(projected, ACP_TIMELINE_MAX_BYTES + 1) <= ACP_TIMELINE_MAX_BYTES) {
    return projected;
  }

  // A single malformed terminal record must not be allowed to defeat the
  // timeline budget.  Keep only the identity/status needed for the UI and a
  // short diagnostic marker; the complete protocol payload remains on disk.
  const id = boundedIdentifier(projected.id, 'uclaw:bounded-item');
  const compact: TimelineItem = (() => {
    switch (projected.kind) {
    case 'message-segment':
      return {
        kind: 'message-segment', id, role: projected.role,
        messageId: boundedIdentifier(projected.messageId, 'message'),
        segmentIndex: projected.segmentIndex, parts: [{ kind: 'error', message: ACP_OMITTED_VALUE_MARKER }],
        blockCount: 0,
      };
    case 'thought':
      return {
        kind: 'thought', id, messageId: boundedIdentifier(projected.messageId, 'thought'),
        parts: [{ kind: 'error', message: ACP_OMITTED_VALUE_MARKER }],
      };
    case 'tool-call':
      return {
        kind: 'tool-call', id, toolCallId: boundedIdentifier(projected.toolCallId, 'tool'),
        title: 'Tool output omitted for memory safety', status: projected.status,
        outputParts: [{ kind: 'error', message: ACP_OMITTED_VALUE_MARKER }], locations: [],
      };
    case 'permission':
      return {
        kind: 'permission', id, requestId: boundedIdentifier(projected.requestId, 'permission'),
        title: 'Permission request omitted for memory safety', options: [], status: projected.status,
      };
    case 'plan':
      return { kind: 'plan', id, entries: [] };
    case 'turn-failure':
      return {
        kind: 'turn-failure', id,
        userMessageId: boundedIdentifier(projected.userMessageId, 'message'),
        failure: { code: 'UNKNOWN', message: ACP_OMITTED_VALUE_MARKER, retryable: false },
      };
    case 'turn-retry':
      return {
        kind: 'turn-retry', id,
        userMessageId: boundedIdentifier(projected.userMessageId, 'message'),
        attempt: Math.max(1, Math.floor(projected.attempt)),
        maxAttempts: Math.max(1, Math.floor(projected.maxAttempts)),
      };
    }
  })();
  return compact;
}

/** Bounds a timeline item created by a store-side event path. */
export function boundAcpTimelineItem(item: TimelineItem): TimelineItem {
  return boundTimelineItem(item);
}

function timelineBytes(snapshot: AcpTimelineSnapshot): number {
  const cached = timelineByteEstimates.get(snapshot);
  if (cached !== undefined) return cached;
  // Estimate item-by-item so a value above the threshold does not collapse to
  // a single sentinel and make later eviction arithmetic inaccurate.
  // Use the raw metadata estimate here so an oversized metadata update cannot
  // take the fast path merely because its bounded projection is small.  The
  // projection is installed when the bounds are enforced below.
  let estimated = estimateValueBytes(snapshot.metadata, ACP_TIMELINE_MAX_BYTES + 1);
  for (const id of snapshot.itemOrder) {
    const item = snapshot.itemsById[id];
    if (item) {
      estimated += estimateValueBytes(item, ACP_TIMELINE_MAX_BYTES + 1);
    }
  }
  timelineByteEstimates.set(snapshot, estimated);
  return estimated;
}

function rememberTimelineBytes(
  snapshot: AcpTimelineSnapshot,
  bytes: number,
  source?: AcpTimelineSnapshot,
): AcpTimelineSnapshot {
  timelineByteEstimates.set(snapshot, Math.max(0, bytes));
  if (source && boundedTimelineSnapshots.has(source)) boundedTimelineSnapshots.add(snapshot);
  return snapshot;
}

function markTimelineAsBounded(snapshot: AcpTimelineSnapshot): AcpTimelineSnapshot {
  boundedTimelineSnapshots.add(snapshot);
  return snapshot;
}

function protectedTimelineItem(item: TimelineItem): boolean {
  if (item.kind === 'turn-failure' || item.kind === 'turn-retry' || item.kind === 'permission') return true;
  if (item.kind === 'tool-call') return item.status === 'completed' || item.status === 'failed';
  return false;
}

function enforceTimelineBounds(snapshot: AcpTimelineSnapshot, knownBytes?: number): AcpTimelineSnapshot {
  const bytes = knownBytes ?? timelineBytes(snapshot);
  if (
    boundedTimelineSnapshots.has(snapshot)
    && snapshot.itemOrder.length <= ACP_TIMELINE_MAX_ITEMS
    && bytes <= ACP_TIMELINE_MAX_BYTES
  ) {
    return rememberTimelineBytes(snapshot, bytes, snapshot);
  }

  const order: string[] = [];
  const itemsById: Record<string, TimelineItem> = {};
  let totalBytes = estimateValueBytes(boundedMetadata(snapshot.metadata), ACP_TIMELINE_MAX_BYTES + 1);
  for (const id of snapshot.itemOrder) {
    const item = snapshot.itemsById[id];
    if (!item || id in itemsById) continue;
    const bounded = boundTimelineItem(item);
    order.push(id);
    itemsById[id] = bounded;
    totalBytes += estimateValueBytes(bounded, ACP_TIMELINE_MAX_BYTES + 1);
  }
  const removeAt = (index: number): void => {
    const id = order[index];
    if (!id) return;
    const item = itemsById[id];
    if (item) totalBytes = Math.max(0, totalBytes - estimateValueBytes(item, ACP_TIMELINE_MAX_BYTES + 1));
    order.splice(index, 1);
    delete itemsById[id];
  };

  while (order.length > ACP_TIMELINE_MAX_ITEMS || totalBytes > ACP_TIMELINE_MAX_BYTES) {
    let index = order.findIndex((id) => {
      const item = itemsById[id];
      return item ? !protectedTimelineItem(item) : true;
    });
    if (index < 0) {
      // A stream made entirely of terminal records is unusual, but still must
      // have a hard bound.  If even the newest protected record cannot fit
      // beside bounded metadata, drop it as the final safety valve.
      if (order.length <= 1) {
        if (order.length === 1) removeAt(0);
        continue;
      }
      index = 0;
    }
    removeAt(index);
  }

  // Rebuild the identity indexes from retained items only. Besides removing
  // references to evicted segments, this avoids iterating/materializing a
  // potentially unbounded provider-supplied openMessageSegments map.
  const retainedMessageIds = new Set<string>();
  for (const id of order) {
    const item = itemsById[id];
    if (item?.kind === 'message-segment') retainedMessageIds.add(item.messageId);
  }
  const openMessageSegments: Record<string, string> = {};
  const segmentCounts: Record<string, number> = {};
  for (const messageId of retainedMessageIds) {
    const openId = snapshot.openMessageSegments[messageId];
    const openItem = openId ? itemsById[openId] : undefined;
    if (openItem?.kind === 'message-segment' && openItem.messageId === messageId) {
      openMessageSegments[messageId] = openId;
    }
    const count = snapshot.segmentCounts[messageId];
    if (Number.isInteger(count) && count >= 0) segmentCounts[messageId] = count;
  }
  const boundedSnapshot = {
    ...snapshot,
    itemOrder: order,
    itemsById,
    metadata: boundedMetadata(snapshot.metadata),
    openMessageSegments,
    segmentCounts,
  };
  boundedTimelineSnapshots.add(boundedSnapshot);
  return rememberTimelineBytes(boundedSnapshot, totalBytes, boundedSnapshot);
}

/** Applies the renderer timeline safety bounds to mutations outside the reducer. */
export function enforceAcpTimelineBounds(snapshot: AcpTimelineSnapshot): AcpTimelineSnapshot {
  return enforceTimelineBounds(snapshot);
}

export function createEmptyAcpTimeline(sessionId: string, loadGeneration: number): AcpTimelineSnapshot {
  return markTimelineAsBounded({
    sessionId,
    loadGeneration,
    itemOrder: [],
    itemsById: {},
    metadata: {},
    openMessageSegments: {},
    segmentCounts: {},
    fallbackMessageCounts: { user: 0, assistant: 0 },
  });
}

function appendItem(state: AcpTimelineSnapshot, item: TimelineItem): AcpTimelineSnapshot {
  const boundedItem = boundTimelineItem(item);
  const previousItem = state.itemsById[boundedItem.id];
  const hasItem = previousItem !== undefined;
  const next = {
    ...state,
    itemOrder: hasItem ? state.itemOrder : [...state.itemOrder, boundedItem.id],
    itemsById: { ...state.itemsById, [boundedItem.id]: boundedItem },
  };
  const previousBytes = timelineBytes(state);
  const nextBytes = Math.max(
    0,
    previousBytes
      - (previousItem ? estimateValueBytes(previousItem, ACP_TIMELINE_MAX_BYTES + 1) : 0)
      + estimateValueBytes(boundedItem, ACP_TIMELINE_MAX_BYTES + 1),
  );
  return next.itemOrder.length > ACP_TIMELINE_MAX_ITEMS || nextBytes > ACP_TIMELINE_MAX_BYTES
    ? enforceTimelineBounds(next, nextBytes)
    : rememberTimelineBytes(next, nextBytes, state);
}

function closeAllMessageSegments(state: AcpTimelineSnapshot): AcpTimelineSnapshot {
  if (Object.keys(state.openMessageSegments).length === 0) return state;
  const next = { ...state, openMessageSegments: {} };
  return boundedTimelineSnapshots.has(state) ? markTimelineAsBounded(next) : next;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toolKindValue(value: unknown): ToolKind | undefined {
  return typeof value === 'string' ? value as ToolKind : undefined;
}

function objectValue(value: unknown): UpdateRecord | undefined {
  return value && typeof value === 'object' ? value as UpdateRecord : undefined;
}

function contentArray(value: unknown): ContentBlock[] {
  return Array.isArray(value) ? value as ContentBlock[] : [];
}

function toolContentArray(value: unknown): ToolCallContent[] {
  return Array.isArray(value) ? value as ToolCallContent[] : [];
}

function boundedToolLocationMeta(value: unknown): ToolCallLocation['_meta'] | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  let bytes = estimateValueBytes(result, ACP_TOOL_LOCATION_META_MAX_BYTES + 1);
  let count = 0;
  // Iterate keys lazily. Object.keys(...) would first materialize every key of
  // a provider-supplied metadata object, defeating the bound for a malformed
  // location with millions of properties.
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (count >= ACP_TOOL_LOCATION_META_MAX_ITEMS) break;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const safeKey = truncateText(key, ACP_TOOL_LOCATION_META_KEY_MAX_CHARS);
    if (!safeKey || Object.prototype.hasOwnProperty.call(result, safeKey)) continue;
    const raw = source[key];
    let projected: unknown;
    if (raw === null || typeof raw === 'boolean') {
      projected = raw;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      projected = raw;
    } else if (typeof raw === 'string') {
      projected = truncateText(raw, ACP_TOOL_LOCATION_META_STRING_MAX_CHARS);
    } else {
      projected = {
        __uclawTruncated: true,
        preview: ACP_OMITTED_VALUE_MARKER,
      };
    }
    const candidate = { ...result, [safeKey]: projected };
    const candidateBytes = estimateValueBytes(candidate, ACP_TOOL_LOCATION_META_MAX_BYTES + 1);
    if (candidateBytes > ACP_TOOL_LOCATION_META_MAX_BYTES) continue;
    result[safeKey] = projected;
    bytes = candidateBytes;
    count += 1;
  }
  // Keep an explicit empty object distinct from an absent _meta field; ACP
  // allows both and callers may use null as a deliberate reset signal.
  return bytes <= ACP_TOOL_LOCATION_META_MAX_BYTES ? result : undefined;
}

function boundedToolLocations(value: unknown): ToolCallLocation[] {
  if (!Array.isArray(value)) return [];
  const result: ToolCallLocation[] = [];
  const start = Math.max(0, value.length - ACP_TOOL_LOCATION_MAX_COUNT);
  for (let index = start; index < value.length; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== 'object') continue;
    const location = raw as Record<string, unknown>;
    const path = typeof location.path === 'string'
      ? truncateText(location.path, ACP_TOOL_LOCATION_PATH_MAX_CHARS)
      : '';
    if (!path) continue;
    const line = typeof location.line === 'number' && Number.isFinite(location.line)
      ? Math.max(0, Math.floor(location.line))
      : undefined;
    const meta = boundedToolLocationMeta(location._meta);
    result.push({
      path,
      ...(line !== undefined ? { line } : {}),
      ...(meta !== undefined ? { _meta: meta } : {}),
    });
  }
  return result;
}

function propertyExists(record: UpdateRecord, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, property);
}

function fallbackMessageIdentity(
  state: AcpTimelineSnapshot,
  role: Role,
): { state: AcpTimelineSnapshot; messageId: string } {
  // Compatibility media is an overlay, not an ACP process boundary.
  let lastItem: TimelineItem | undefined;
  for (let index = state.itemOrder.length - 1; index >= 0; index -= 1) {
    const item = state.itemsById[state.itemOrder[index]!];
    if (item?.kind === 'message-segment' && item.compat) continue;
    lastItem = item;
    break;
  }
  if (
    lastItem?.kind === 'message-segment'
    && lastItem.role === role
    && state.openMessageSegments[lastItem.messageId] === lastItem.id
  ) {
    return { state, messageId: lastItem.messageId };
  }

  let sequence = state.fallbackMessageCounts[role] ?? 0;
  let messageId = `${role}:message:${sequence}`;
  while (state.segmentCounts[messageId] != null) {
    sequence += 1;
    messageId = `${role}:message:${sequence}`;
  }
  const nextState = {
    ...state,
    fallbackMessageCounts: {
      ...state.fallbackMessageCounts,
      [role]: sequence + 1,
    },
  };
  return {
    state: boundedTimelineSnapshots.has(state) ? markTimelineAsBounded(nextState) : nextState,
    messageId,
  };
}

function messageIdentity(
  state: AcpTimelineSnapshot,
  update: UpdateRecord,
  role: Role,
): { state: AcpTimelineSnapshot; messageId: string } {
  const messageId = stringValue(update.messageId);
  return messageId ? { state, messageId } : fallbackMessageIdentity(state, role);
}

function nextMessageSegment(
  state: AcpTimelineSnapshot,
  role: Role,
  messageId: string,
): { state: AcpTimelineSnapshot; item: MessageSegmentItem } {
  const openId = state.openMessageSegments[messageId];
  if (openId) {
    const existing = state.itemsById[openId];
    if (existing?.kind === 'message-segment' && existing.role === role) return { state, item: existing };
  }

  const segmentIndex = state.segmentCounts[messageId] ?? 0;
  const id = `${messageId}:${segmentIndex}`;
  const item = boundTimelineItem({
    kind: 'message-segment', id, role, messageId, segmentIndex, parts: [], blockCount: 0,
  }) as MessageSegmentItem;

  const nextState = {
    ...state,
    itemOrder: [...state.itemOrder, id],
    itemsById: { ...state.itemsById, [id]: item },
    openMessageSegments: { ...state.openMessageSegments, [messageId]: id },
    segmentCounts: { ...state.segmentCounts, [messageId]: segmentIndex + 1 },
  };
  const nextBytes = timelineBytes(state) + estimateValueBytes(item, ACP_TIMELINE_MAX_BYTES + 1);
  return {
    state: rememberTimelineBytes(nextState, nextBytes, state),
    item,
  };
}

function appendRenderPart(parts: RenderPart[], nextPart: RenderPart): RenderPart[] {
  const boundedNextPart = boundRenderPart(nextPart);
  const previous = parts[parts.length - 1];
  if (previous?.kind === 'markdown' && boundedNextPart.kind === 'markdown') {
    return [
      ...parts.slice(0, -1),
      { ...previous, text: truncateText(`${previous.text}${boundedNextPart.text}`) },
    ];
  }
  if (parts.length >= ACP_RENDER_PART_MAX_COUNT) {
    // Preserve the existing preview and terminal/error content; callers still
    // retain the complete protocol event on disk for later inspection.
    return parts;
  }
  return [...parts, boundedNextPart];
}

function preserveAvailableAttachment(
  previous: Extract<RenderPart, { kind: 'attachment' }>,
  next: Extract<RenderPart, { kind: 'attachment' }>,
): RenderPart {
  const sameReference = previous.reference.uri === next.reference.uri
    && previous.reference.stagingId === next.reference.stagingId;
  return sameReference && previous.access.status === 'available'
    ? {
        ...next,
        reference: {
          ...next.reference,
          ...(previous.reference.displayPath ? { displayPath: previous.reference.displayPath } : {}),
        },
        access: previous.access,
      }
    : next;
}

function appendMessageRenderPart(role: Role, parts: RenderPart[], nextPart: RenderPart): RenderPart[] {
  if (nextPart.kind === 'attachment') {
    const existingIndex = parts.findIndex((part) => (
      part.kind === 'attachment' && part.attachmentId === nextPart.attachmentId
    ));
    if (existingIndex >= 0) {
      return parts.map((part, index) => (
        index === existingIndex && part.kind === 'attachment'
          ? preserveAvailableAttachment(part, nextPart)
          : part
      ));
    }
  }
  if (role === 'user' && nextPart.kind === 'markdown') {
    const markdownIndex = parts.findIndex((part) => part.kind === 'markdown');
    if (markdownIndex >= 0 && markdownIndex !== parts.length - 1) {
      return parts.map((part, index) => (
        index === markdownIndex && part.kind === 'markdown'
          ? { ...part, text: truncateText(`${part.text}${nextPart.text}`) }
          : part
      ));
    }
  }
  return appendRenderPart(parts, nextPart);
}

function renderPartKey(part: RenderPart): string | null {
  if (part.kind === 'attachment') {
    return `attachment:${part.reference.uri}:${part.reference.name}:${part.reference.mimeType ?? ''}:${part.reference.stagingId ?? ''}`;
  }
  if (part.kind === 'image') return `image:${part.source}:${part.mimeType ?? ''}`;
  if (part.kind === 'error') return `error:${part.message}`;
  return null;
}

function mergeOptimisticUserEchoParts(optimisticParts: RenderPart[], echoParts: RenderPart[]): RenderPart[] {
  const reconciledEchoParts = echoParts.map((echoPart) => {
    if (echoPart.kind !== 'attachment') return echoPart;
    const previous = optimisticParts.find((part) => (
      part.kind === 'attachment' && renderPartKey(part) === renderPartKey(echoPart)
    ));
    return previous?.kind === 'attachment'
      ? preserveAvailableAttachment(previous, echoPart)
      : echoPart;
  });
  const echoPartKeys = new Set(reconciledEchoParts.map(renderPartKey).filter((key): key is string => Boolean(key)));
  const missingOptimisticMedia = optimisticParts.filter((part) => {
    if (part.kind === 'markdown') return false;
    const key = renderPartKey(part);
    return !key || !echoPartKeys.has(key);
  });
  return [...reconciledEchoParts, ...missingOptimisticMedia];
}

function findMessageSegmentId(state: AcpTimelineSnapshot, role: Role, messageId: string): string | undefined {
  return state.itemOrder.find((itemId) => {
    const item = state.itemsById[itemId];
    return item?.kind === 'message-segment' && item.role === role && item.messageId === messageId;
  });
}

function appendMessageChunk(
  state: AcpTimelineSnapshot,
  role: Role,
  update: UpdateRecord,
): AcpTimelineSnapshot {
  const content = update.content as ContentBlock | undefined;
  if (!content) return state;
  const identity = messageIdentity(state, update, role);
  const { messageId } = identity;
  const result = nextMessageSegment(identity.state, role, messageId);
  const blockIndex = result.item.blockCount ?? result.item.parts.length;
  const nextPart = contentBlockToRenderPart(content, {
    role,
    messageId,
    segmentIndex: result.item.segmentIndex,
    blockIndex,
  });
  const safeNextPart = boundRenderPart(nextPart);
  const parts = result.item.optimistic && role === 'user'
    ? mergeOptimisticUserEchoParts(result.item.parts, [safeNextPart])
    : appendMessageRenderPart(role, result.item.parts, safeNextPart);
  const nextItem = boundTimelineItem({
    ...result.item,
    blockCount: blockIndex + 1,
    optimistic: false,
    parts,
    ...(role === 'user'
      ? {
          userPromptTextBlocks: result.item.userPromptTextBlocksOptimistic
            ? result.item.userPromptTextBlocks
            : [
                ...(result.item.userPromptTextBlocks ?? []),
                ...openClawPromptTextBlocks([content]),
              ],
          ...(result.item.userPromptTextBlocksOptimistic
            ? { userPromptTextBlocksOptimistic: true }
            : {}),
        }
      : {}),
  }) as MessageSegmentItem;

  const nextState = {
    ...result.state,
    itemsById: { ...result.state.itemsById, [nextItem.id]: nextItem },
  };
  const previousBytes = timelineBytes(result.state);
  const nextBytes = Math.max(
    0,
    previousBytes
      - estimateValueBytes(result.item, ACP_TIMELINE_MAX_BYTES + 1)
      + estimateValueBytes(nextItem, ACP_TIMELINE_MAX_BYTES + 1),
  );
  return nextState.itemOrder.length > ACP_TIMELINE_MAX_ITEMS || nextBytes > ACP_TIMELINE_MAX_BYTES
    ? enforceTimelineBounds(nextState, nextBytes)
    : rememberTimelineBytes(nextState, nextBytes, result.state);
}

function replacementMessageParts(
  existing: MessageSegmentItem,
  replacement: RenderPart[],
): RenderPart[] {
  const next = replacement.map((part) => {
    if (part.kind !== 'attachment') return part;
    const previous = existing.parts.find((candidate) => (
      candidate.kind === 'attachment' && candidate.attachmentId === part.attachmentId
    ));
    return previous?.kind === 'attachment' ? preserveAvailableAttachment(previous, part) : part;
  });
  if (!existing.compat) return next;

  const imageIdentities = new Set(next.flatMap((part) => (
    part.kind === 'image' && part.mediaIdentity ? [part.mediaIdentity] : []
  )));
  const attachmentIds = new Set(next.flatMap((part) => (
    part.kind === 'attachment' ? [part.attachmentId] : []
  )));
  const overlays = existing.parts.filter((part) => {
    if (part.kind === 'image' && part.mediaIdentity) {
      if (imageIdentities.has(part.mediaIdentity)) return false;
      imageIdentities.add(part.mediaIdentity);
      return true;
    }
    if (part.kind === 'attachment' && part.source === 'openclaw-media') {
      if (attachmentIds.has(part.attachmentId)) return false;
      attachmentIds.add(part.attachmentId);
      return true;
    }
    return false;
  });
  return overlays.length > 0 ? [...next, ...overlays] : next;
}

function replaceMessage(
  state: AcpTimelineSnapshot,
  role: Role,
  messageId: string,
  content: unknown,
): AcpTimelineSnapshot {
  if (role === 'user') {
    const existingId = findMessageSegmentId(state, role, messageId);
    const existing = existingId ? state.itemsById[existingId] : undefined;
    if (existing?.kind === 'message-segment') {
      const blocks = contentArray(content);
      const parts = contentBlocksToRenderParts(blocks, {
        role,
        messageId,
        segmentIndex: existing.segmentIndex,
      }, { maxBlocks: ACP_RENDER_CONTENT_MAX_BLOCKS });
      const item = boundTimelineItem({
        ...existing,
        blockCount: blocks.length,
        optimistic: false,
        parts: existing.optimistic ? mergeOptimisticUserEchoParts(existing.parts, parts) : parts,
        userPromptTextBlocks: existing.userPromptTextBlocksOptimistic
          ? existing.userPromptTextBlocks
          : openClawPromptTextBlocks(blocks),
        userPromptTextBlocksOptimistic: undefined,
      }) as MessageSegmentItem;
      const nextState = {
        ...state,
        itemsById: { ...state.itemsById, [item.id]: item },
      };
      const previousBytes = timelineBytes(state);
      const nextBytes = Math.max(
        0,
        previousBytes
          - estimateValueBytes(existing, ACP_TIMELINE_MAX_BYTES + 1)
          + estimateValueBytes(item, ACP_TIMELINE_MAX_BYTES + 1),
      );
      return nextState.itemOrder.length > ACP_TIMELINE_MAX_ITEMS || nextBytes > ACP_TIMELINE_MAX_BYTES
        ? enforceTimelineBounds(nextState, nextBytes)
        : rememberTimelineBytes(nextState, nextBytes, state);
    }
  }

  const result = nextMessageSegment(state, role, messageId);
  const blocks = contentArray(content);
  const item = boundTimelineItem({
    ...result.item,
    blockCount: blocks.length,
    optimistic: false,
    parts: replacementMessageParts(
      result.item,
      contentBlocksToRenderParts(blocks, {
        role,
        messageId,
        segmentIndex: result.item.segmentIndex,
      }, { maxBlocks: ACP_RENDER_CONTENT_MAX_BLOCKS }),
    ),
    ...(role === 'user' ? { userPromptTextBlocks: openClawPromptTextBlocks(blocks) } : {}),
  }) as MessageSegmentItem;

  const nextState = {
    ...result.state,
    itemsById: { ...result.state.itemsById, [item.id]: item },
  };
  const previousBytes = timelineBytes(result.state);
  const nextBytes = Math.max(
    0,
    previousBytes - estimateValueBytes(result.item, ACP_TIMELINE_MAX_BYTES + 1)
      + estimateValueBytes(item, ACP_TIMELINE_MAX_BYTES + 1),
  );
  return nextState.itemOrder.length > ACP_TIMELINE_MAX_ITEMS || nextBytes > ACP_TIMELINE_MAX_BYTES
    ? enforceTimelineBounds(nextState, nextBytes)
    : rememberTimelineBytes(nextState, nextBytes, result.state);
}

export function appendSyntheticAssistantMessage(
  snapshot: AcpTimelineSnapshot,
  input: {
    messageId: string;
    evidenceId: string;
    parts: RenderPart[];
    afterItemId?: string;
    source?: 'image-generation' | 'video-generation';
  },
): AcpTimelineSnapshot {
  const id = `${input.messageId}:0`;
  const item = boundTimelineItem({
    kind: 'message-segment',
    id,
    role: 'assistant',
    messageId: input.messageId,
    segmentIndex: 0,
    blockCount: 0,
    parts: boundRenderParts(input.parts, ACP_TOOL_OUTPUT_MAX_BYTES),
    compat: { source: input.source ?? 'image-generation', evidenceId: input.evidenceId },
  }) as MessageSegmentItem;

  const nextOrder = (() => {
    if (snapshot.itemOrder.includes(id)) return snapshot.itemOrder;
    const anchorIndex = input.afterItemId ? snapshot.itemOrder.indexOf(input.afterItemId) : -1;
    if (anchorIndex < 0) return [...snapshot.itemOrder, id];
    return [
      ...snapshot.itemOrder.slice(0, anchorIndex + 1),
      id,
      ...snapshot.itemOrder.slice(anchorIndex + 1),
    ];
  })();

  const next = dedupeTimelineAttachments({
    ...snapshot,
    itemOrder: nextOrder,
    itemsById: { ...snapshot.itemsById, [id]: item },
    segmentCounts: { ...snapshot.segmentCounts, [input.messageId]: 1 },
  });
  return enforceTimelineBounds(next);
}

export function upsertSyntheticTurnAttachments(
  snapshot: AcpTimelineSnapshot,
  input: {
    turnId: string;
    evidenceId: string;
    attachments: AttachmentRenderPart[];
    source: 'openclaw-media';
  },
): AcpTimelineSnapshot {
  const messageId = `compat:openclaw-media:${input.evidenceId}`;
  const id = `${messageId}:0`;
  const existingId = snapshot.itemOrder.find((itemId) => {
    const item = snapshot.itemsById[itemId];
    return item?.kind === 'message-segment'
      && item.compat?.source === input.source
      && item.compat.evidenceId === input.evidenceId;
  });
  const anchorIndex = snapshot.itemOrder.findIndex((itemId) => {
    const item = snapshot.itemsById[itemId];
    return item?.kind === 'message-segment' && item.role === 'user' && item.messageId === input.turnId;
  });
  if (anchorIndex < 0) return snapshot;

  const item = boundTimelineItem({
    kind: 'message-segment',
    id,
    role: 'assistant',
    messageId,
    segmentIndex: 0,
    blockCount: 0,
    parts: input.attachments.map((attachment) => {
      const existing = existingId ? snapshot.itemsById[existingId] : undefined;
      const previous = existing?.kind === 'message-segment'
        ? existing.parts.find((part): part is AttachmentRenderPart => (
            part.kind === 'attachment' && part.attachmentId === attachment.attachmentId
          ))
        : undefined;
      return mergeMonotonicAttachment(previous, attachment);
    }),
    compat: { source: input.source, evidenceId: input.evidenceId },
  }) as MessageSegmentItem;
  const itemsById = { ...snapshot.itemsById };
  if (existingId && existingId !== id) delete itemsById[existingId];
  itemsById[id] = item;

  let itemOrder = snapshot.itemOrder.filter((itemId) => itemId !== existingId && itemId !== id);
  const nextUserIndex = itemOrder.findIndex((itemId, index) => {
    if (index <= anchorIndex) return false;
    const nextItem = itemsById[itemId];
    return nextItem?.kind === 'message-segment' && nextItem.role === 'user';
  });
  const insertionIndex = nextUserIndex < 0 ? itemOrder.length : nextUserIndex;
  itemOrder = [...itemOrder.slice(0, insertionIndex), id, ...itemOrder.slice(insertionIndex)];

  const next = dedupeTimelineAttachments({
    ...snapshot,
    itemOrder,
    itemsById,
    segmentCounts: { ...snapshot.segmentCounts, [messageId]: 1 },
  });
  return enforceTimelineBounds(next);
}

function normalizeToolStatus(status: ToolCallStatus | null | undefined): ToolCallItem['status'] {
  if (status === 'in_progress') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  return 'pending';
}

function existingToolCall(state: AcpTimelineSnapshot, id: string): ToolCallItem | undefined {
  const existing = state.itemsById[id];
  return existing?.kind === 'tool-call' ? existing : undefined;
}

function projectOfficeArtifactResult(
  toolCallId: string,
  status: ToolCallItem['status'],
  rawOutput: unknown,
  outputParts: RenderPart[],
  previousParts: RenderPart[],
): RenderPart[] {
  if (status !== 'completed') return outputParts;
  const artifact = parseOfficeArtifactToolResult(rawOutput);
  if (!artifact) return outputParts;

  const evidenceId = `uclaw-office-artifact:${toolCallId}`;
  const previous = previousParts.find((part): part is AttachmentRenderPart => (
    part.kind === 'attachment' && part.evidenceId === evidenceId
  ));
  const baseParts = outputParts.filter((part) => (
    part.kind !== 'attachment' || part.evidenceId !== evidenceId
  ));
  if (baseParts.some((part) => part.kind === 'attachment' && part.reference.uri === artifact.filePath)) {
    return baseParts;
  }

  const pending = createPendingAttachment({
    messageId: `tool-artifact:${toolCallId}`,
    segmentIndex: 0,
    blockIndex: 0,
    uri: artifact.filePath,
    name: artifact.fileName,
    mimeType: artifact.mimeType,
    ...(artifact.size !== undefined ? { size: artifact.size } : {}),
    source: 'acp-resource',
    evidenceId,
  });
  return [...baseParts, mergeMonotonicAttachment(previous, pending)];
}

function upsertToolCall(
  state: AcpTimelineSnapshot,
  update: UpdateRecord,
  options: ApplyUpdateOptions = {},
): AcpTimelineSnapshot {
  const toolCallId = stringValue(update.toolCallId);
  if (!toolCallId) return state;

  const id = `tool:${toolCallId}`;
  const prev = existingToolCall(state, id);
  const hasContent = propertyExists(update, 'content');
  const hasLocations = propertyExists(update, 'locations');
  const hasKind = propertyExists(update, 'kind');
  const hasRawInput = propertyExists(update, 'rawInput');
  const hasRawOutput = propertyExists(update, 'rawOutput');
  const rawStatus = update.status as ToolCallStatus | null | undefined;
  const rawTitle = stringValue(update.title);
  const rawError = stringValue(update.error);
  const status = propertyExists(update, 'status') ? normalizeToolStatus(rawStatus) : prev?.status ?? 'pending';
  const output = hasRawOutput ? update.rawOutput : prev?.output;
  const contentParts = hasContent
    ? boundRenderParts(toolContentToRenderParts(toolContentArray(update.content), {
        role: 'assistant', messageId: `tool:${toolCallId}`, segmentIndex: 0,
      }, { maxBlocks: ACP_RENDER_CONTENT_MAX_BLOCKS }), ACP_TOOL_OUTPUT_MAX_BYTES)
    : prev?.outputParts ?? [];
  const outputParts = boundRenderParts(projectOfficeArtifactResult(
    toolCallId,
    status,
    output,
    contentParts,
    prev?.outputParts ?? [],
  ), ACP_TOOL_OUTPUT_MAX_BYTES);

  return appendItem(closeAllMessageSegments(state), {
    kind: 'tool-call',
    id,
    toolCallId,
    title: rawTitle ?? prev?.title ?? toolCallId,
    toolKind: hasKind ? toolKindValue(update.kind) : prev?.toolKind,
    status,
    input: hasRawInput ? update.rawInput : prev?.input,
    output,
    outputParts,
    locations: hasLocations ? boundedToolLocations(update.locations) : prev?.locations ?? [],
    error: rawError ?? prev?.error,
    historical: !!prev?.historical || !!options.historical,
  });
}

function appendToolContentChunk(
  state: AcpTimelineSnapshot,
  update: UpdateRecord,
  options: ApplyUpdateOptions = {},
): AcpTimelineSnapshot {
  const toolCallId = stringValue(update.toolCallId);
  if (!toolCallId) return state;

  const id = `tool:${toolCallId}`;
  const prev = existingToolCall(state, id);
  const rawContent = objectValue(update.content);
  const nextPart = rawContent
    ? toolContentToRenderPart(rawContent as ToolCallContent, {
        role: 'assistant',
        messageId: `tool:${toolCallId}`,
        segmentIndex: 0,
        blockIndex: prev?.outputParts.length ?? 0,
      })
    : { kind: 'error' as const, message: 'Unsupported ACP tool content chunk' };

  return appendItem(closeAllMessageSegments(state), {
    kind: 'tool-call',
    id,
    toolCallId,
    title: prev?.title ?? toolCallId,
    toolKind: prev?.toolKind,
    status: prev?.status ?? 'running',
    input: prev?.input,
    output: prev?.output,
    outputParts: boundRenderParts([...(prev?.outputParts ?? []), nextPart], ACP_TOOL_OUTPUT_MAX_BYTES),
    locations: prev?.locations ?? [],
    error: prev?.error,
    historical: !!prev?.historical || !!options.historical,
  });
}

function appendThoughtChunk(state: AcpTimelineSnapshot, update: UpdateRecord): AcpTimelineSnapshot {
  const content = update.content as ContentBlock | undefined;
  if (!content) return state;
  const identity = messageIdentity(state, update, 'assistant');
  state = identity.state;
  const { messageId } = identity;
  const id = `thought:${messageId}`;
  const existing = state.itemsById[id];
  const parts = existing?.kind === 'thought' ? existing.parts : [];

  return appendItem(closeAllMessageSegments(state), {
    kind: 'thought',
    id,
    messageId,
    parts: boundRenderParts([...parts, contentBlockToRenderPart(content, {
      role: 'assistant',
      messageId: `thought:${messageId}`,
      segmentIndex: 0,
      blockIndex: parts.length,
    })], ACP_TOOL_OUTPUT_MAX_BYTES),
  });
}

function resolvedTurnUserMessageId(
  state: AcpTimelineSnapshot,
  requestedUserMessageId: string | undefined,
  fallbackToLatest = true,
): string | undefined {
  const requestedExists = requestedUserMessageId && state.itemOrder.some((itemId) => {
    const item = state.itemsById[itemId];
    return item?.kind === 'message-segment'
      && item.role === 'user'
      && item.messageId === requestedUserMessageId;
  });
  const latestUserMessage = [...state.itemOrder]
    .reverse()
    .map((itemId) => state.itemsById[itemId])
    .find((item) => item?.kind === 'message-segment' && item.role === 'user');
  if (requestedExists) return requestedUserMessageId;
  return fallbackToLatest && latestUserMessage?.kind === 'message-segment'
    ? latestUserMessage.messageId
    : undefined;
}

function removeTimelineItemIds(state: AcpTimelineSnapshot, removedIds: ReadonlySet<string>): AcpTimelineSnapshot {
  if (removedIds.size === 0) return state;
  const itemOrder = state.itemOrder.filter((itemId) => !removedIds.has(itemId));
  const itemsById = Object.fromEntries(itemOrder.flatMap((itemId) => {
    const item = state.itemsById[itemId];
    return item ? [[itemId, item]] : [];
  }));
  const remainingMessageIds = new Set(itemOrder.flatMap((itemId) => {
    const item = itemsById[itemId];
    return item?.kind === 'message-segment' ? [item.messageId] : [];
  }));
  const openMessageSegments = Object.fromEntries(Object.entries(state.openMessageSegments)
    .filter(([messageId, itemId]) => remainingMessageIds.has(messageId) && !removedIds.has(itemId)));
  const segmentCounts = Object.fromEntries(Object.entries(state.segmentCounts)
    .filter(([messageId]) => remainingMessageIds.has(messageId)));
  return enforceTimelineBounds({
    ...state,
    itemOrder,
    itemsById,
    openMessageSegments,
    segmentCounts,
  });
}

function removeTurnRetry(state: AcpTimelineSnapshot, userMessageId: string): AcpTimelineSnapshot {
  return removeTimelineItemIds(state, new Set([`turn-retry:${userMessageId}`]));
}

function appendTurnRetry(state: AcpTimelineSnapshot, update: UpdateRecord): AcpTimelineSnapshot {
  const userMessageId = resolvedTurnUserMessageId(state, stringValue(update.userMessageId), false);
  if (!userMessageId) return state;

  return appendItem(closeAllMessageSegments(state), {
    kind: 'turn-retry',
    id: `turn-retry:${userMessageId}`,
    userMessageId,
    attempt: Math.max(1, Number(update.attempt) || 1),
    maxAttempts: Math.max(1, Number(update.maxAttempts) || 1),
  });
}

function cancelTurnRetry(state: AcpTimelineSnapshot, update: UpdateRecord): AcpTimelineSnapshot {
  const userMessageId = resolvedTurnUserMessageId(state, stringValue(update.userMessageId), false);
  return userMessageId ? removeTurnRetry(state, userMessageId) : state;
}

/**
 * Drops only the interrupted, side-effect-free assistant projection. The new
 * visible update is applied by the Store in the same commit, so the user never
 * sees an empty turn between the old and replacement text.
 */
export function replaceRetryingTurn(
  state: AcpTimelineSnapshot,
  replacement: AcpTurnRetryReplacement,
): AcpTimelineSnapshot {
  const retryId = `turn-retry:${replacement.userMessageId}`;
  if (state.itemsById[retryId]?.kind !== 'turn-retry') return state;
  return supersedeRetryReplayTurn(state, replacement.userMessageId);
}

/** Collapses attempts identified by UClaw's own retry message id during ACP replay. */
export function supersedeRetryReplayTurn(
  state: AcpTimelineSnapshot,
  userMessageId: string,
): AcpTimelineSnapshot {
  let anchorIndex = -1;
  for (let index = state.itemOrder.length - 1; index >= 0; index -= 1) {
    const itemId = state.itemOrder[index];
    const item = state.itemsById[itemId];
    if (item?.kind === 'message-segment'
      && item.role === 'user'
      && item.messageId === userMessageId) {
      anchorIndex = index;
      break;
    }
  }
  if (anchorIndex < 0) return state;

  const turnIds: string[] = [];
  for (let index = anchorIndex + 1; index < state.itemOrder.length; index += 1) {
    const itemId = state.itemOrder[index];
    const item = state.itemsById[itemId];
    if (item?.kind === 'message-segment' && item.role === 'user') break;
    turnIds.push(itemId);
  }
  const containsReplayUnsafeItem = turnIds.some((itemId) => {
    const item = state.itemsById[itemId];
    return item?.kind === 'tool-call' || item?.kind === 'permission';
  });
  return containsReplayUnsafeItem ? state : removeTimelineItemIds(state, new Set(turnIds));
}

function appendTurnFailure(state: AcpTimelineSnapshot, update: UpdateRecord): AcpTimelineSnapshot {
  const userMessageId = resolvedTurnUserMessageId(state, stringValue(update.userMessageId));
  if (!userMessageId) return state;

  const id = `turn-failure:${userMessageId}`;
  return appendItem(closeAllMessageSegments(removeTurnRetry(state, userMessageId)), {
    kind: 'turn-failure',
    id,
    userMessageId,
    failure: normalizeAcpChatError({
      message: stringValue(update.errorMessage) ?? 'ACP prompt failed',
      code: update.errorCode,
      status: update.httpStatus,
    }),
  });
}

function updateSessionInfoMetadata(state: AcpTimelineSnapshot, update: UpdateRecord): AcpTimelineSnapshot {
  return enforceTimelineBounds({
    ...state,
    metadata: {
      ...state.metadata,
      ...(propertyExists(update, 'title') ? { title: update.title as string | null | undefined } : {}),
      ...(propertyExists(update, 'updatedAt') ? { updatedAt: update.updatedAt as string | null | undefined } : {}),
    },
  });
}

function usageMetadata(update: UpdateRecord): unknown {
  const { sessionUpdate: _sessionUpdate, ...usage } = update;
  return boundedToolValue(usage, ACP_METADATA_MAX_BYTES);
}

export function applyAcpSessionUpdate(
  snapshot: AcpTimelineSnapshot,
  notification: SessionNotification,
  options: ApplyUpdateOptions = {},
): AcpTimelineSnapshot {
  if (notification.sessionId !== snapshot.sessionId) return snapshot;

  const update = notification.update as unknown as UpdateRecord;
  switch (update.sessionUpdate) {
    case 'user_message': {
      const messageId = stringValue(update.messageId);
      return messageId ? replaceMessage(snapshot, 'user', messageId, update.content) : snapshot;
    }
    case 'agent_message': {
      const messageId = stringValue(update.messageId);
      return messageId ? replaceMessage(snapshot, 'assistant', messageId, update.content) : snapshot;
    }
    case 'tool_call_content_chunk':
      return appendToolContentChunk(snapshot, update, options);
    case 'user_message_chunk':
      return appendMessageChunk(snapshot, 'user', update);
    case 'agent_message_chunk':
      return appendMessageChunk(snapshot, 'assistant', update);
    case 'agent_thought_chunk':
      return appendThoughtChunk(snapshot, update);
    case 'uclaw_turn_retrying':
      return appendTurnRetry(snapshot, update);
    case 'uclaw_turn_retry_cancelled':
      return cancelTurnRetry(snapshot, update);
    case 'uclaw_turn_failure':
      return appendTurnFailure(snapshot, update);
    case 'tool_call':
    case 'tool_call_update':
      return upsertToolCall(snapshot, update, options);
    case 'plan':
      return appendItem(closeAllMessageSegments(snapshot), {
        kind: 'plan',
        id: 'plan:current',
        entries: boundedPlanEntries(update.entries),
      });
    case 'available_commands_update':
      return enforceTimelineBounds({
        ...snapshot,
        metadata: {
          ...snapshot.metadata,
          availableCommands: Array.isArray(update.availableCommands)
            ? update.availableCommands.slice(-ACP_METADATA_MAX_ITEMS)
            : [],
        },
      });
    case 'config_option_update':
      return enforceTimelineBounds({
        ...snapshot,
        metadata: { ...snapshot.metadata, configOptions: boundedConfigOptions(update.configOptions) },
      });
    case 'current_mode_update':
      return enforceTimelineBounds({
        ...snapshot,
        metadata: {
          ...snapshot.metadata,
          currentModeId: typeof update.currentModeId === 'string'
            ? truncateText(update.currentModeId, ACP_IDENTIFIER_MAX_CHARS)
            : undefined,
        },
      });
    case 'session_info_update':
      return updateSessionInfoMetadata(snapshot, update);
    case 'usage_update':
      return enforceTimelineBounds({
        ...snapshot,
        metadata: { ...snapshot.metadata, usage: usageMetadata(update) },
      });
    default:
      return snapshot;
  }
}
