import type { AttachmentFileRef } from '@shared/host-api/contract';
import { dedupeTimelineAttachments } from './attachments';
import { acpUserTurns, turnMatchKey } from './openclaw-media-compat';
import type {
  AcpTimelineSnapshot,
  MessageSegmentItem,
  RenderPart,
  TimelineItem,
} from './timeline-types';

type RendererMediaProjectionItem = MessageSegmentItem & {
  compat: {
    source: 'image-generation' | 'openclaw-media' | 'video-generation';
    evidenceId: string;
  };
};

type ReplayTurn = {
  endItemId: string;
  mediaIdentities: Set<string>;
  assistantItemsByCaption: Map<string, string[]>;
};

export type BackgroundMediaProjectionResult = {
  timeline: AcpTimelineSnapshot;
  unrestoredImageEvidenceIds: string[];
};

function itemParts(item: TimelineItem): RenderPart[] {
  if (item.kind === 'message-segment' || item.kind === 'thought') return item.parts;
  if (item.kind === 'tool-call') return item.outputParts;
  return [];
}

function mediaIdentity(part: RenderPart): string | undefined {
  if (part.kind === 'image') {
    return part.mediaIdentity ?? `${part.mimeType ?? ''}:${part.source}`;
  }
  if (part.kind === 'attachment' && part.access.status === 'available') {
    return part.access.identity;
  }
  return undefined;
}

function markdownText(item: MessageSegmentItem): string {
  return item.parts
    .flatMap((part) => part.kind === 'markdown' ? [part.text] : [])
    .join('\n')
    .trim();
}

function rendererMediaProjection(item: TimelineItem | undefined): item is RendererMediaProjectionItem {
  return item?.kind === 'message-segment'
    && (
      item.compat?.source === 'image-generation'
      || item.compat?.source === 'openclaw-media'
      || item.compat?.source === 'video-generation'
    );
}

function isSyntheticImageProjection(item: RendererMediaProjectionItem): boolean {
  return item.compat.source === 'image-generation'
    && item.messageId.startsWith('compat:image-generation:');
}

function rebindRef(ref: AttachmentFileRef, sessionKey: string, generation: number): AttachmentFileRef {
  return { ...ref, sessionKey, generation };
}

function rebindPart(part: RenderPart, sessionKey: string, generation: number): RenderPart {
  if (part.kind === 'image' && part.attachmentFileRef) {
    return {
      ...part,
      attachmentFileRef: rebindRef(part.attachmentFileRef, sessionKey, generation),
    };
  }
  if (part.kind !== 'attachment' || part.access.status !== 'available') return part;
  return {
    ...part,
    access: {
      ...part.access,
      target: {
        ...part.access.target,
        ref: rebindRef(part.access.target.ref, sessionKey, generation),
      },
    },
  };
}

function userTurnKeyByMessageId(timeline: AcpTimelineSnapshot): Map<string, string> {
  const keys = new Map<string, string>();
  for (const turn of acpUserTurns(timeline)) {
    const key = turnMatchKey(turn);
    for (const messageId of turn.messageIds) keys.set(messageId, key);
  }
  return keys;
}

function replayTurnIndex(timeline: AcpTimelineSnapshot): Map<string, ReplayTurn> {
  const turnKeyByMessageId = userTurnKeyByMessageId(timeline);
  const turns = new Map<string, ReplayTurn>();
  let currentTurn: ReplayTurn | undefined;

  for (const itemId of timeline.itemOrder) {
    const item = timeline.itemsById[itemId];
    if (!item) continue;
    if (item.kind === 'message-segment' && item.role === 'user') {
      const key = turnKeyByMessageId.get(item.messageId);
      if (!key) {
        currentTurn = undefined;
        continue;
      }
      currentTurn = turns.get(key) ?? {
        endItemId: itemId,
        mediaIdentities: new Set<string>(),
        assistantItemsByCaption: new Map<string, string[]>(),
      };
      turns.set(key, currentTurn);
      // User attachments are prompt input, not evidence that assistant output is already present.
      continue;
    }
    if (!currentTurn) continue;
    currentTurn.endItemId = itemId;
    for (const part of itemParts(item)) {
      const identity = mediaIdentity(part);
      if (identity) currentTurn.mediaIdentities.add(identity);
    }
    if (item.kind === 'message-segment' && item.role === 'assistant' && !item.compat) {
      const caption = markdownText(item);
      if (!caption) continue;
      const matches = currentTurn.assistantItemsByCaption.get(caption) ?? [];
      matches.push(itemId);
      currentTurn.assistantItemsByCaption.set(caption, matches);
    }
  }
  return turns;
}

function projectionTurns(timeline: AcpTimelineSnapshot): Array<{
  item: RendererMediaProjectionItem;
  turnKey: string | undefined;
}> {
  const turnKeyByMessageId = userTurnKeyByMessageId(timeline);
  const projections: Array<{ item: RendererMediaProjectionItem; turnKey: string | undefined }> = [];
  let currentTurnKey: string | undefined;

  for (const itemId of timeline.itemOrder) {
    const item = timeline.itemsById[itemId];
    if (item?.kind === 'message-segment' && item.role === 'user') {
      currentTurnKey = turnKeyByMessageId.get(item.messageId);
    }
    if (rendererMediaProjection(item)) projections.push({ item, turnKey: currentTurnKey });
  }
  return projections;
}

function existingProjectionEvidence(timeline: AcpTimelineSnapshot): Set<string> {
  const evidence = new Set<string>();
  for (const item of Object.values(timeline.itemsById)) {
    if (rendererMediaProjection(item)) evidence.add(`${item.compat.source}:${item.compat.evidenceId}`);
  }
  return evidence;
}

function mergeImagesIntoReplayItem(
  itemsById: Record<string, TimelineItem>,
  itemId: string,
  evidenceId: string,
  images: RenderPart[],
  turn: ReplayTurn,
): void {
  const item = itemsById[itemId];
  if (item?.kind !== 'message-segment' || item.role !== 'assistant') return;
  const missingImages = images.filter((part) => {
    if (part.kind !== 'image') return false;
    const identity = mediaIdentity(part);
    if (identity && turn.mediaIdentities.has(identity)) return false;
    if (identity) turn.mediaIdentities.add(identity);
    return true;
  });
  if (missingImages.length === 0) return;
  itemsById[itemId] = {
    ...item,
    parts: [...item.parts, ...missingImages],
    compat: { source: 'image-generation', evidenceId },
  };
}

/**
 * Reapplies only bounded Renderer media projections after an authoritative ACP replay.
 * Turn keys are content-and-occurrence based because ACP item ids are not durable across loads.
 */
export function restoreBackgroundMediaProjections(input: {
  replay: AcpTimelineSnapshot;
  previous: AcpTimelineSnapshot;
  sessionKey: string;
  generation: number;
}): BackgroundMediaProjectionResult {
  const replayTurns = replayTurnIndex(input.replay);
  const evidence = existingProjectionEvidence(input.replay);
  const itemsById = { ...input.replay.itemsById };
  const segmentCounts = { ...input.replay.segmentCounts };
  const insertionsByAnchor = new Map<string, MessageSegmentItem[]>();
  const unrestoredImageEvidenceIds = new Set<string>();

  for (const { item, turnKey } of projectionTurns(input.previous)) {
    const evidenceKey = `${item.compat.source}:${item.compat.evidenceId}`;
    if (evidence.has(evidenceKey)) continue;
    const replayTurn = turnKey ? replayTurns.get(turnKey) : undefined;
    if (!replayTurn) {
      if (item.compat.source === 'image-generation') {
        unrestoredImageEvidenceIds.add(item.compat.evidenceId);
      }
      continue;
    }

    const reboundParts = item.parts.map((part) => rebindPart(part, input.sessionKey, input.generation));
    if (item.compat.source === 'image-generation') {
      if (!reboundParts.some((part) => part.kind === 'image')) {
        unrestoredImageEvidenceIds.add(item.compat.evidenceId);
        continue;
      }
      const captionMatches = replayTurn.assistantItemsByCaption.get(markdownText(item)) ?? [];
      if (captionMatches.length === 1) {
        mergeImagesIntoReplayItem(
          itemsById,
          captionMatches[0]!,
          item.compat.evidenceId,
          reboundParts,
          replayTurn,
        );
        evidence.add(evidenceKey);
        continue;
      }
      if (!isSyntheticImageProjection(item)) {
        const imageIdentities = reboundParts.flatMap((part) => {
          if (part.kind !== 'image') return [];
          const identity = mediaIdentity(part);
          return identity ? [identity] : [];
        });
        if (
          imageIdentities.length > 0
          && imageIdentities.every((identity) => replayTurn.mediaIdentities.has(identity))
        ) {
          evidence.add(evidenceKey);
          continue;
        }
        unrestoredImageEvidenceIds.add(item.compat.evidenceId);
        continue;
      }
    }

    const mediaParts = reboundParts.filter((part) => part.kind === 'image' || part.kind === 'attachment');
    const missingParts = reboundParts.filter((part) => {
      if (part.kind !== 'image' && part.kind !== 'attachment') return true;
      const identity = mediaIdentity(part);
      if (identity && replayTurn.mediaIdentities.has(identity)) return false;
      if (identity) replayTurn.mediaIdentities.add(identity);
      return true;
    });
    if (mediaParts.length > 0 && missingParts.every((part) => part.kind !== 'image' && part.kind !== 'attachment')) {
      evidence.add(evidenceKey);
      continue;
    }
    if (itemsById[item.id]) {
      if (item.compat.source === 'image-generation') {
        unrestoredImageEvidenceIds.add(item.compat.evidenceId);
      }
      continue;
    }

    const restoredItem = { ...item, parts: missingParts };
    itemsById[restoredItem.id] = restoredItem;
    segmentCounts[restoredItem.messageId] = Math.max(
      segmentCounts[restoredItem.messageId] ?? 0,
      restoredItem.segmentIndex + 1,
    );
    const insertions = insertionsByAnchor.get(replayTurn.endItemId) ?? [];
    insertions.push(restoredItem);
    insertionsByAnchor.set(replayTurn.endItemId, insertions);
    evidence.add(evidenceKey);
  }

  const itemOrder = input.replay.itemOrder.flatMap((itemId) => [
    itemId,
    ...(insertionsByAnchor.get(itemId) ?? []).map((item) => item.id),
  ]);
  return {
    timeline: dedupeTimelineAttachments({
      ...input.replay,
      itemOrder,
      itemsById,
      segmentCounts,
    }),
    unrestoredImageEvidenceIds: [...unrestoredImageEvidenceIds],
  };
}
