import type { ChatRuntimeArtifact } from '../../../../shared/chat-runtime-events';
import type { ConversationMessageSnapshot } from '../../../../shared/conversation-events';
import type { ArtifactGroupItem } from '../../../stores/conversation/types';
import type { ContentBlock } from '../../../stores/chat/types';

type SnapshotAttachment = NonNullable<ConversationMessageSnapshot['attachments']>[number];
type ArtifactOwner = Pick<ArtifactGroupItem, 'artifacts' | 'changes'>;

const MEDIA_BLOCK_TYPES = new Set<ContentBlock['type']>(['image', 'video', 'audio', 'file']);

type PreviewIdentity = {
  mimeType: string;
  payload: string;
  start: number;
  end: number;
  fingerprint?: string;
};

type MediaIdentity = {
  strongKeys: Set<string>;
  preview?: PreviewIdentity;
};

function normalizePath(value: string): string {
  const normalized = value.trim().replace(/\\/gu, '/');
  return /^[A-Za-z]:\//u.test(normalized)
    ? `${normalized[0].toLowerCase()}${normalized.slice(1)}`
    : normalized;
}

function isAsciiWhitespace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

function trimmedRange(value: string): { start: number; end: number } {
  let start = 0;
  let end = value.length;
  while (start < end && isAsciiWhitespace(value.charCodeAt(start))) start += 1;
  while (end > start && isAsciiWhitespace(value.charCodeAt(end - 1))) end -= 1;
  return { start, end };
}

function startsWithDataScheme(value: string, start: number): boolean {
  return value.length - start >= 5 && value.slice(start, start + 5).toLowerCase() === 'data:';
}

function normalizeMimeType(value: string | undefined, fallback: string): string {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || fallback;
}

function dataUriPreviewIdentity(value: string): PreviewIdentity | null {
  const { start, end } = trimmedRange(value);
  if (!startsWithDataScheme(value, start)) return null;
  const comma = value.indexOf(',', start + 5);
  if (comma < 0 || comma >= end || comma - start > 1_024) return null;
  const header = value.slice(start + 5, comma).toLowerCase();
  const parts = header.split(';');
  if (parts.at(-1) !== 'base64') return null;
  return {
    mimeType: normalizeMimeType(parts[0], 'application/octet-stream'),
    payload: value,
    start: comma + 1,
    end,
  };
}

function rawPreviewIdentity(value: string, mimeType: string): PreviewIdentity {
  const { start, end } = trimmedRange(value);
  return { mimeType, payload: value, start, end };
}

/** Compare base64 ranges without copying or retaining the full payload as a selector key. */
function samePreview(left: PreviewIdentity, right: PreviewIdentity): boolean {
  if (left.mimeType !== right.mimeType) return false;
  if (left.payload === right.payload && left.start === right.start && left.end === right.end) return true;
  const leftLength = left.end - left.start;
  const rightLength = right.end - right.start;
  if (leftLength !== rightLength) return false;
  // Full scans of multi-megabyte inline previews visibly block the renderer.
  // A length plus evenly distributed samples is sufficient for display ownership;
  // the artifact remains visible even in the unlikely event of a fingerprint collision.
  if (leftLength > 1_048_576) {
    const fingerprint = (identity: PreviewIdentity): string => {
      if (identity.fingerprint) return identity.fingerprint;
      const length = identity.end - identity.start;
      let hash = 0x811c9dc5;
      const sampleCount = Math.min(64, length);
      for (let index = 0; index < sampleCount; index += 1) {
        const offset = sampleCount === 1
          ? 0
          : Math.floor(index * (length - 1) / (sampleCount - 1));
        hash ^= identity.payload.charCodeAt(identity.start + offset);
        hash = Math.imul(hash, 0x01000193);
      }
      identity.fingerprint = `${length.toString(36)}:${(hash >>> 0).toString(36)}`;
      return identity.fingerprint;
    };
    return fingerprint(left) === fingerprint(right);
  }
  let leftIndex = left.start;
  let rightIndex = right.start;
  while (true) {
    while (leftIndex < left.end && isAsciiWhitespace(left.payload.charCodeAt(leftIndex))) leftIndex += 1;
    while (rightIndex < right.end && isAsciiWhitespace(right.payload.charCodeAt(rightIndex))) rightIndex += 1;
    if (leftIndex >= left.end || rightIndex >= right.end) {
      return leftIndex >= left.end && rightIndex >= right.end;
    }
    if (left.payload.charCodeAt(leftIndex) !== right.payload.charCodeAt(rightIndex)) return false;
    leftIndex += 1;
    rightIndex += 1;
  }
}

function addPathKey(keys: Set<string>, value: string | undefined): void {
  const normalized = value ? normalizePath(value) : '';
  if (!normalized) return;
  if (/^https?:\/\//iu.test(normalized)) {
    keys.add(`url:${normalized}`);
    return;
  }
  keys.add(`path:${normalized}`);
}

function addUrlKey(keys: Set<string>, value: string | undefined): void {
  const normalized = value?.trim();
  if (normalized) keys.add(`url:${normalized}`);
}

function addPreviewIdentity(
  identity: MediaIdentity,
  value: string | null | undefined,
  mimeType: string | undefined,
): void {
  if (!value) return;
  const range = trimmedRange(value);
  if (range.start === range.end) return;
  const dataIdentity = dataUriPreviewIdentity(value);
  if (dataIdentity) {
    identity.preview = dataIdentity;
    return;
  }
  if (startsWithDataScheme(value, range.start)) return;
  const normalized = value.slice(range.start, range.end);
  if (/^(?:https?:\/\/|blob:|\/)/iu.test(normalized)) {
    addUrlKey(identity.strongKeys, normalized);
    return;
  }
  identity.preview = rawPreviewIdentity(
    value,
    normalizeMimeType(mimeType, 'application/octet-stream'),
  );
}

function attachmentMediaIdentity(file: SnapshotAttachment): MediaIdentity {
  const identity: MediaIdentity = { strongKeys: new Set<string>() };
  addPathKey(identity.strongKeys, file.filePath);
  addUrlKey(identity.strongKeys, file.gatewayUrl);
  addPreviewIdentity(identity, file.preview, file.mimeType);
  return identity;
}

function artifactMediaIdentity(artifact: ChatRuntimeArtifact): MediaIdentity {
  const identity: MediaIdentity = { strongKeys: new Set<string>() };
  addPathKey(identity.strongKeys, artifact.filePath);
  addUrlKey(identity.strongKeys, artifact.url);
  addPreviewIdentity(identity, artifact.preview, artifact.mimeType);
  return identity;
}

function contentBlockMediaIdentity(value: unknown): MediaIdentity {
  const identity: MediaIdentity = { strongKeys: new Set<string>() };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return identity;
  const block = value as ContentBlock;
  if (!MEDIA_BLOCK_TYPES.has(block.type)) return identity;

  addPathKey(identity.strongKeys, block.filePath);
  addUrlKey(identity.strongKeys, block.url);
  addUrlKey(identity.strongKeys, block.openUrl);
  addUrlKey(identity.strongKeys, block.source?.url);

  const data = block.source?.data ?? block.data;
  if (data) {
    const defaultMimeType = block.type === 'video'
      ? 'video/mp4'
      : block.type === 'audio'
        ? 'audio/mpeg'
        : block.type === 'file'
          ? 'application/octet-stream'
          : 'image/jpeg';
    const mimeType = normalizeMimeType(
      block.source?.media_type ?? block.mimeType,
      defaultMimeType,
    );
    const dataIdentity = dataUriPreviewIdentity(data);
    identity.preview = dataIdentity ?? rawPreviewIdentity(data, mimeType);
  }
  return identity;
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const key of left) {
    if (right.has(key)) return true;
  }
  return false;
}

function artifactOwnsMedia(
  identity: MediaIdentity,
  ownedStrongKeys: Set<string>,
  ownedPreviews: readonly PreviewIdentity[],
): boolean {
  if (intersects(identity.strongKeys, ownedStrongKeys)) return true;
  return identity.strongKeys.size === 0
    && Boolean(identity.preview && ownedPreviews.some((preview) => samePreview(identity.preview!, preview)));
}

function isMediaDirectiveBoundary(value: string, index: number): boolean {
  if (index >= value.length) return true;
  const char = value[index];
  if (/\s/u.test(char)) return true;
  if (!/["'`()[\]{},<>，。；;!?]/u.test(char)) return false;
  const next = value[index + 1];
  return next == null || /\s|["'`()[\]{},<>，。；;!?]/u.test(next);
}

function ownedMediaDirectiveEnd(
  value: string,
  pathStart: number,
  ownedStrongKeys: Set<string>,
): number | null {
  for (const key of ownedStrongKeys) {
    const separator = key.indexOf(':');
    const ownedValue = key.slice(separator + 1);
    const candidateEnd = pathStart + ownedValue.length;
    if (candidateEnd > value.length || !isMediaDirectiveBoundary(value, candidateEnd)) continue;

    const candidate = value.slice(pathStart, candidateEnd);
    const candidateKey = key.startsWith('path:')
      ? `path:${normalizePath(candidate)}`
      : `url:${candidate.trim()}`;
    if (candidateKey === key) return candidateEnd;
  }
  return null;
}

/** Remove only explicit MEDIA references whose path or URL is rendered by an artifact item. */
function stripArtifactOwnedMediaDirectives(
  value: string,
  ownedStrongKeys: Set<string>,
): string {
  const marker = /(^|[\s([{>])MEDIA:[ \t]*/giu;
  const removals: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = marker.exec(value)) !== null) {
    const lead = match[1];
    const directiveStart = match.index + lead.length;
    const pathStart = marker.lastIndex;
    const directiveEnd = ownedMediaDirectiveEnd(value, pathStart, ownedStrongKeys);
    if (directiveEnd == null) continue;

    const lineStart = value.lastIndexOf('\n', directiveStart - 1) + 1;
    const lineEndIndex = value.indexOf('\n', directiveEnd);
    const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex;
    const isStandalone = value.slice(lineStart, directiveStart).trim().length === 0
      && value.slice(directiveEnd, lineEnd).trim().length === 0;
    if (isStandalone) {
      if (lineEndIndex >= 0) {
        removals.push({ start: lineStart, end: lineEndIndex + 1 });
      } else {
        const previousLineBreak = lineStart > 0 && value[lineStart - 1] === '\n'
          ? lineStart - (lineStart > 1 && value[lineStart - 2] === '\r' ? 2 : 1)
          : lineStart;
        removals.push({ start: previousLineBreak, end: lineEnd });
      }
    } else {
      removals.push({ start: directiveStart, end: directiveEnd });
    }
  }

  if (removals.length === 0) return value;
  const mergedRemovals: Array<{ start: number; end: number }> = [];
  for (const removal of removals) {
    const previous = mergedRemovals.at(-1);
    if (previous && removal.start <= previous.end) {
      previous.end = Math.max(previous.end, removal.end);
    } else {
      mergedRemovals.push({ ...removal });
    }
  }
  let result = '';
  let cursor = 0;
  for (const removal of mergedRemovals) {
    result += value.slice(cursor, removal.start);
    cursor = removal.end;
  }
  return result + value.slice(cursor);
}

/** Keep produced media in artifact items while preserving final text and input references. */
export function projectArtifactOwnedFinalMessage(
  message: ConversationMessageSnapshot,
  artifactGroups: readonly ArtifactOwner[],
): ConversationMessageSnapshot {
  const visibleMessage = message.attachments?.some((file) => file.disposition === 'intermediate')
    ? { ...message, attachments: message.attachments.filter((file) => file.disposition !== 'intermediate') }
    : message;
  const ownedStrongKeys = new Set<string>();
  const ownedPreviews: PreviewIdentity[] = [];
  for (const group of artifactGroups) {
    for (const artifact of group.artifacts) {
      const identity = artifactMediaIdentity(artifact);
      identity.strongKeys.forEach((key) => ownedStrongKeys.add(key));
      if (identity.preview) ownedPreviews.push(identity.preview);
    }
    for (const change of group.changes) addPathKey(ownedStrongKeys, change.filePath);
  }
  if (ownedStrongKeys.size === 0 && ownedPreviews.length === 0) return visibleMessage;

  let attachmentsChanged = false;
  const attachments = visibleMessage.attachments?.filter((file) => {
    if (file.disposition === 'input-reference' || file.source === 'user-upload') return true;
    const owned = artifactOwnsMedia(
      attachmentMediaIdentity(file),
      ownedStrongKeys,
      ownedPreviews,
    );
    if (owned) attachmentsChanged = true;
    return !owned;
  });

  let contentChanged = false;
  let content = visibleMessage.content;
  if (typeof visibleMessage.content === 'string') {
    content = stripArtifactOwnedMediaDirectives(visibleMessage.content, ownedStrongKeys);
    contentChanged = content !== visibleMessage.content;
  } else if (Array.isArray(visibleMessage.content)) {
    content = visibleMessage.content.flatMap((block) => {
      const owned = artifactOwnsMedia(
        contentBlockMediaIdentity(block),
        ownedStrongKeys,
        ownedPreviews,
      );
      if (owned) {
        contentChanged = true;
        return [];
      }
      if (!block || typeof block !== 'object' || Array.isArray(block)) return [block];
      const contentBlock = block as ContentBlock;
      if (contentBlock.type !== 'text' || typeof contentBlock.text !== 'string') return [block];
      const text = stripArtifactOwnedMediaDirectives(contentBlock.text, ownedStrongKeys);
      if (text === contentBlock.text) return [block];
      contentChanged = true;
      return [{ ...contentBlock, text }];
    });
  }

  if (!attachmentsChanged && !contentChanged) return visibleMessage;
  return {
    ...visibleMessage,
    content,
    ...(visibleMessage.attachments ? { attachments } : {}),
  };
}
