import type { AttachedFileMeta, ContentBlock, RawMessage } from './types';

const IMAGE_CACHE_KEY = 'clawx:image-cache';
const IMAGE_CACHE_MAX = 100;
const DIRECTORY_MIME_TYPE = 'application/x-directory';

function loadImageCache(): Map<string, AttachedFileMeta> {
  try {
    const raw = localStorage.getItem(IMAGE_CACHE_KEY);
    if (raw) {
      const entries = JSON.parse(raw) as Array<[string, AttachedFileMeta]>;
      return new Map(entries);
    }
  } catch {
    // Ignore corrupt cache entries and rebuild them from authoritative media evidence.
  }
  return new Map();
}

function saveImageCache(cache: Map<string, AttachedFileMeta>): void {
  try {
    const entries = Array.from(cache.entries());
    const trimmed = entries.length > IMAGE_CACHE_MAX
      ? entries.slice(entries.length - IMAGE_CACHE_MAX)
      : entries;
    localStorage.setItem(IMAGE_CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    // A full or unavailable localStorage must not block message delivery.
  }
}

const imageCache = loadImageCache();

/** Stores resolved attachment metadata before history or preview hydration can race it. */
export function cacheAttachedFiles(entries: Iterable<readonly [string, AttachedFileMeta]>): void {
  for (const [filePath, file] of entries) {
    imageCache.set(filePath, { ...file });
  }
  saveImageCache(imageCache);
}

/** Extract media file refs from Gateway `[media attached: ...]` text. */
export function extractMediaRefs(text: string): Array<{ filePath: string; mimeType: string }> {
  const refs: Array<{ filePath: string; mimeType: string }> = [];
  const regex = /\[media attached:\s*([^\s(]+)\s*\(([^)]+)\)\s*\|[^\]]*\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    refs.push({ filePath: match[1], mimeType: match[2] });
  }
  return refs;
}

/** Maps supported file extensions to their MIME type. */
function mimeFromExtension(filePath: string): string {
  let pathForExtension = filePath.trim();
  if (/^https?:\/\//i.test(pathForExtension)) {
    try {
      pathForExtension = new URL(pathForExtension).pathname;
    } catch {
      pathForExtension = pathForExtension.split(/[?#]/)[0] || pathForExtension;
    }
  } else {
    pathForExtension = pathForExtension.split(/[?#]/)[0] || pathForExtension;
  }
  const ext = pathForExtension.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
    md: 'text/markdown',
    rtf: 'application/rtf',
    epub: 'application/epub+zip',
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    aac: 'audio/aac',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    m4v: 'video/mp4',
  };
  return map[ext] || 'application/octet-stream';
}

function mimeFromTaggedMediaRef(filePath: string): string {
  const mimeType = mimeFromExtension(filePath);
  if (mimeType !== 'application/octet-stream') return mimeType;
  return /^https?:\/\//i.test(filePath.trim()) ? 'video/mp4' : mimeType;
}

function extractFilePathsFromToolArgs(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const direct = args.file_path ?? args.filePath ?? args.path ?? args.file;
  if (typeof direct === 'string' && direct.trim()) paths.push(direct.trim());

  const attachments = args.attachments;
  if (Array.isArray(attachments)) {
    for (const item of attachments) {
      if (!item || typeof item !== 'object') continue;
      const attachment = item as Record<string, unknown>;
      const filePath = attachment.filePath ?? attachment.file_path ?? attachment.path ?? attachment.file;
      if (typeof filePath === 'string' && filePath.trim()) paths.push(filePath.trim());
    }
  }

  return paths;
}

export function looksLikeRemoteMediaUrl(filePath: string): boolean {
  return /^https?:\/\//i.test(filePath.trim());
}

function fileNameFromMediaRef(filePath: string, mimeType: string): string {
  if (looksLikeRemoteMediaUrl(filePath)) {
    try {
      const remoteName = decodeURIComponent(new URL(filePath).pathname.split('/').filter(Boolean).pop() || '');
      if (remoteName.includes('.')) return remoteName;
    } catch {
      // Fall through to a stable MIME-based name.
    }
    if (mimeType.startsWith('video/')) return 'video.mp4';
    if (mimeType.startsWith('audio/')) return 'audio.mp3';
    if (mimeType.startsWith('image/')) return 'image';
    return 'remote-file';
  }
  return filePath.split(/[\\/]/).pop()?.split(/[?#]/)[0] || 'file';
}

function trimPathTerminators(filePath: string): string {
  return filePath.replace(/[，。；;,.!?]+$/u, '');
}

/** Extracts explicit local and remote artifact paths from user-displayable text. */
export function extractRawFilePaths(text: string): Array<{ filePath: string; mimeType: string }> {
  const refs: Array<{ filePath: string; mimeType: string }> = [];
  const seen = new Set<string>();
  const exts = 'png|jpe?g|gif|webp|bmp|avif|svg|pdf|docx?|xlsx?|pptx?|html?|txt|csv|md|rtf|epub|zip|tar|gz|rar|7z|mp3|wav|ogg|aac|flac|m4a|mp4|mov|avi|mkv|webm|m4v';
  const taggedRegex = new RegExp(`(?:^|[\\s(\\[{>])(?:MEDIA|media):((?:\\/|~\\/|[A-Za-z]:\\\\)[^\\n"'()\\[\\],<>` + '`' + `]*?\\.(?:${exts}))(?=$|[\\s\\n"'()\\[\\],<>` + '`' + `]|[，。；;,.!?])`, 'g');
  let workingText = text;
  let taggedMatch: RegExpExecArray | null;
  const taggedRemoteRegex = new RegExp(`(?:^|[\\s(\\[{>])(?:MEDIA|media):(https?:\\/\\/[^\\s\\n"'()\\[\\],<>` + '`' + `]+)`, 'g');
  while ((taggedMatch = taggedRemoteRegex.exec(text)) !== null) {
    const filePath = trimPathTerminators(taggedMatch[1] || '');
    if (filePath && !seen.has(filePath)) {
      seen.add(filePath);
      refs.push({ filePath, mimeType: mimeFromTaggedMediaRef(filePath) });
    }
    const start = taggedMatch.index;
    const end = start + taggedMatch[0].length;
    workingText = workingText.slice(0, start) + ' '.repeat(end - start) + workingText.slice(end);
  }
  while ((taggedMatch = taggedRegex.exec(text)) !== null) {
    const filePath = taggedMatch[1];
    if (filePath && !seen.has(filePath)) {
      seen.add(filePath);
      refs.push({ filePath, mimeType: mimeFromExtension(filePath) });
    }
    const start = taggedMatch.index;
    const end = start + taggedMatch[0].length;
    workingText = workingText.slice(0, start) + ' '.repeat(end - start) + workingText.slice(end);
  }

  const unixRegex = new RegExp(`(?<![\\w./:])((?:\\/|~\\/)[^\\s\\n"'()\`\\[\\],<>]*?\\.(?:${exts}))`, 'gi');
  const winRegex = new RegExp(`(?<![\\w])([A-Za-z]:\\\\[^\\s\\n"'()\`\\[\\],<>]*?\\.(?:${exts}))`, 'gi');
  const skillPathBoundary = '(?=$|\\s|[\\x5b\\x5d"\'`(),<>，。；;,.!?])';
  const skillPathPart = '[^\\\\/\\s\\n"\'`()\\x5b\\x5d,<>]+';
  const skillPathTail = '[^\\s\\n"\'`()\\x5b\\x5d,<>]*?';
  const skillDirRegex = new RegExp(
    `(?<![\\w./:])((?:~[\\\\/]\\.openclaw[\\\\/]skills[\\\\/]${skillPathPart})|(?:(?:\\/|[A-Za-z]:\\\\)${skillPathTail}[\\\\/]\\.openclaw[\\\\/]skills[\\\\/]${skillPathPart}))${skillPathBoundary}`,
    'gi',
  );
  for (const regex of [unixRegex, winRegex, skillDirRegex]) {
    let match;
    while ((match = regex.exec(workingText)) !== null) {
      const filePath = trimPathTerminators(match[1]);
      if (filePath && !seen.has(filePath)) {
        seen.add(filePath);
        refs.push({
          filePath,
          mimeType: regex === skillDirRegex ? DIRECTORY_MIME_TYPE : mimeFromExtension(filePath),
        });
      }
    }
  }
  return refs;
}

export function hasExplicitMediaDeliveryDirective(text: string, filePath: string): boolean {
  const normalizedText = text.toLowerCase();
  const normalizedPath = filePath.trim().toLowerCase();
  return normalizedText.includes(`media:${normalizedPath}`)
    || normalizedText.includes(`media: ${normalizedPath}`);
}

/** Converts structured media blocks, including nested tool results, to attachment evidence. */
export function extractImagesAsAttachedFiles(content: unknown): AttachedFileMeta[] {
  if (!Array.isArray(content)) return [];
  const files: AttachedFileMeta[] = [];

  for (const block of content as ContentBlock[]) {
    if (block.type === 'image') {
      if (block.source) {
        const source = block.source;
        const mimeType = source.media_type || 'image/jpeg';
        if (source.type === 'base64' && source.data) {
          files.push({
            fileName: 'image',
            mimeType,
            fileSize: 0,
            preview: `data:${mimeType};base64,${source.data}`,
          });
        } else if (source.type === 'url' && source.url) {
          files.push({ fileName: 'image', mimeType, fileSize: 0, preview: source.url });
        }
      } else if (block.data) {
        const mimeType = block.mimeType || 'image/jpeg';
        files.push({
          fileName: 'image',
          mimeType,
          fileSize: 0,
          preview: `data:${mimeType};base64,${block.data}`,
        });
      } else if (block.url) {
        const mimeType = block.mimeType || 'image/jpeg';
        files.push({
          fileName: typeof block.alt === 'string' && block.alt ? block.alt : 'image',
          mimeType,
          fileSize: 0,
          preview: null,
          gatewayUrl: block.url,
          source: 'gateway-media',
          disposition: 'output-delivery',
        });
      }
    }

    if (block.type === 'video' || block.type === 'audio' || block.type === 'file') {
      const url = block.url || block.source?.url;
      const filePath = block.filePath;
      if (url || filePath) {
        const defaultMime = block.type === 'video'
          ? 'video/mp4'
          : block.type === 'audio' ? 'audio/mpeg' : 'application/octet-stream';
        const target = filePath || url || '';
        files.push({
          fileName: block.fileName || block.alt || target.split(/[\\/]/u).pop() || block.type,
          mimeType: block.mimeType || block.source?.media_type || defaultMime,
          fileSize: 0,
          preview: null,
          ...(filePath ? { filePath } : { gatewayUrl: url }),
          source: url ? 'gateway-media' : 'message-ref',
          disposition: 'output-delivery',
        });
      }
    }

    if ((block.type === 'tool_result' || block.type === 'toolResult') && block.content) {
      files.push(...extractImagesAsAttachedFiles(block.content));
    }
  }
  return files;
}

/** Builds attachment metadata from a structured file reference and cached preview evidence. */
export function makeAttachedFile(
  ref: { filePath: string; mimeType: string },
  source: AttachedFileMeta['source'] = 'message-ref',
  disposition: AttachedFileMeta['disposition'] = 'output-delivery',
): AttachedFileMeta {
  if (looksLikeRemoteMediaUrl(ref.filePath)) {
    return {
      fileName: fileNameFromMediaRef(ref.filePath, ref.mimeType),
      mimeType: ref.mimeType,
      fileSize: 0,
      preview: null,
      gatewayUrl: ref.filePath,
      source,
      disposition,
    };
  }
  const cached = imageCache.get(ref.filePath);
  if (cached) return { ...cached, filePath: ref.filePath, source, disposition };
  return {
    fileName: fileNameFromMediaRef(ref.filePath, ref.mimeType),
    mimeType: ref.mimeType,
    fileSize: 0,
    preview: null,
    filePath: ref.filePath,
    source,
    disposition,
  };
}

/** Finds the first file argument owned by a specific tool call. */
export function getToolCallFilePath(msg: RawMessage, toolCallId: string): string | undefined {
  if (!toolCallId) return undefined;

  if (Array.isArray(msg.content)) {
    for (const block of msg.content as ContentBlock[]) {
      if ((block.type === 'tool_use' || block.type === 'toolCall') && block.id === toolCallId) {
        const args = (block.input ?? block.arguments) as Record<string, unknown> | undefined;
        const filePath = args ? extractFilePathsFromToolArgs(args)[0] : undefined;
        if (filePath) return filePath;
      }
    }
  }

  const message = msg as unknown as Record<string, unknown>;
  const toolCalls = message.tool_calls ?? message.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const toolCall of toolCalls as Array<Record<string, unknown>>) {
      if (toolCall.id !== toolCallId) continue;
      const fn = (toolCall.function ?? toolCall) as Record<string, unknown>;
      let args: Record<string, unknown> | undefined;
      try {
        args = typeof fn.arguments === 'string'
          ? JSON.parse(fn.arguments)
          : (fn.arguments ?? fn.input) as Record<string, unknown>;
      } catch {
        // Invalid arguments cannot provide attachment ownership evidence.
      }
      const filePath = args ? extractFilePathsFromToolArgs(args)[0] : undefined;
      if (filePath) return filePath;
    }
  }
  return undefined;
}

/** Records tool-call/file ownership for later tool-result correlation. */
export function collectToolCallPaths(msg: RawMessage, paths: Map<string, string>): void {
  if (Array.isArray(msg.content)) {
    for (const block of msg.content as ContentBlock[]) {
      if ((block.type === 'tool_use' || block.type === 'toolCall') && block.id) {
        const args = (block.input ?? block.arguments) as Record<string, unknown> | undefined;
        const filePath = args ? extractFilePathsFromToolArgs(args)[0] : undefined;
        if (filePath) paths.set(block.id, filePath);
      }
    }
  }

  const message = msg as unknown as Record<string, unknown>;
  const toolCalls = message.tool_calls ?? message.toolCalls;
  if (!Array.isArray(toolCalls)) return;
  for (const toolCall of toolCalls as Array<Record<string, unknown>>) {
    const id = typeof toolCall.id === 'string' ? toolCall.id : '';
    if (!id) continue;
    const fn = (toolCall.function ?? toolCall) as Record<string, unknown>;
    let args: Record<string, unknown> | undefined;
    try {
      args = typeof fn.arguments === 'string'
        ? JSON.parse(fn.arguments)
        : (fn.arguments ?? fn.input) as Record<string, unknown>;
    } catch {
      // Invalid arguments cannot provide attachment ownership evidence.
    }
    const filePath = args ? extractFilePathsFromToolArgs(args)[0] : undefined;
    if (filePath) paths.set(id, filePath);
  }
}

function normalizeLocalAttachmentPath(value: string): string {
  let normalized = trimPathTerminators(value.trim()).normalize('NFC');
  if (/^file:\/\//i.test(normalized)) {
    try {
      const parsed = new URL(normalized);
      normalized = decodeURIComponent(parsed.pathname);
      if (parsed.hostname) normalized = `//${parsed.hostname}${normalized}`;
      if (/^\/[A-Za-z]:\//u.test(normalized)) normalized = normalized.slice(1);
    } catch {
      normalized = normalized.replace(/^file:\/\//i, '');
    }
  }

  normalized = normalized.replace(/\\/gu, '/');
  const isUncPath = normalized.startsWith('//');
  const hasRoot = normalized.startsWith('/');
  const segments = normalized.split('/');
  const compacted: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..' && compacted.length > 0 && compacted.at(-1) !== '..') {
      compacted.pop();
      continue;
    }
    compacted.push(segment);
  }

  normalized = `${isUncPath ? '//' : hasRoot ? '/' : ''}${compacted.join('/')}`;
  if (/^[A-Za-z]:\//u.test(normalized)) normalized = normalized.toLowerCase();
  return normalized;
}

function normalizeRemoteAttachmentUrl(value: string): string {
  const trimmed = trimPathTerminators(value.trim()).normalize('NFC');
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    parsed.pathname = normalizeLocalAttachmentPath(parsed.pathname);
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function normalizeAttachmentMetadataPart(value: string | number | null | undefined): string {
  return String(value ?? '').trim().normalize('NFC').toLowerCase();
}

/** Returns stable path/URL-first identities used for attachment ownership and dedupe. */
export function getAttachedFileNormalizedIdentityKeys(file: AttachedFileMeta): string[] {
  const keys: string[] = [];
  const addLocation = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    keys.push(looksLikeRemoteMediaUrl(trimmed)
      ? `url:${normalizeRemoteAttachmentUrl(trimmed)}`
      : `path:${normalizeLocalAttachmentPath(trimmed)}`);
  };

  addLocation(file.filePath);
  addLocation(file.gatewayUrl);
  if (keys.length === 0) {
    keys.push([
      'meta',
      normalizeAttachmentMetadataPart(file.fileName),
      normalizeAttachmentMetadataPart(file.mimeType),
      normalizeAttachmentMetadataPart(file.fileSize),
      normalizeAttachmentMetadataPart(file.preview),
    ].join(':'));
  }
  return [...new Set(keys)];
}

/** Deduplicates attachments without collapsing distinct path or URL ownership. */
export function dedupeAttachedFiles(files: AttachedFileMeta[]): AttachedFileMeta[] {
  const seen = new Set<string>();
  const next: AttachedFileMeta[] = [];
  for (const file of files) {
    const keys = getAttachedFileNormalizedIdentityKeys(file);
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    next.push(file);
  }
  return next;
}

export function attachedFileKey(file: AttachedFileMeta): string {
  return getAttachedFileNormalizedIdentityKeys(file)[0]!;
}
