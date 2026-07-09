/**
 * Chat Message Component
 * Renders user / assistant / system / toolresult messages
 * with markdown and images. Tool steps render in ExecutionGraphCard;
 * streaming runs may show a compact ToolStatusBar. Thinking output is
 * surfaced via ExecutionGraphCard, not inside message bubbles.
 */
import { useState, useCallback, useEffect, memo } from 'react';
import { Copy, Check, Wrench, FileText, Film, Music, FileArchive, File, X, FolderOpen, ZoomIn, Loader2, CheckCircle2, AlertCircle, ImagePlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { invokeIpc, readBinaryFile, statFile } from '@/lib/api-client';
import { createAuthenticatedHostApiUrl } from '@/lib/host-api';
import { DEFAULT_AGENT_AVATAR_SRC } from '@/lib/agent-avatars';
import type { RawMessage, AttachedFileMeta, CompositeArtifactManifest } from '@/stores/chat';
import { extractText, extractImages, formatTimestamp, isUnresolvableImageUrl } from './message-utils';
import { copyImageToClipboard, type ImageCopyTarget } from './copy-image';

interface ChatMessageProps {
  message: RawMessage;
  textOverride?: string;
  assistantAvatarSrc?: string | null;
  suppressToolCards?: boolean;
  suppressProcessAttachments?: boolean;
  /**
   * When true, hides the assistant text bubble (and any thinking block that
   * would be shown above it). Used when the message's text is being folded
   * into an ExecutionGraphCard as a narration step, to prevent the same text
   * from appearing both inside the graph and as an orphan bubble in the chat
   * stream.
   */
  suppressAssistantText?: boolean;
  isStreaming?: boolean;
  streamingTools?: Array<{
    id?: string;
    toolCallId?: string;
    name: string;
    status: 'running' | 'completed' | 'error';
    durationMs?: number;
    summary?: string;
  }>;
  /**
   * Optional callback invoked when a non-image file card is clicked.
   * When provided, the file opens in the in-app preview panel instead of
   * the system default editor.
   */
  onOpenFile?: (file: AttachedFileMeta) => void;
  onUseImageAsReference?: (file: AttachedFileMeta) => void;
}

interface ExtractedImage { url?: string; data?: string; mimeType: string; width?: number; height?: number; }

const DIRECTORY_MIME_TYPE = 'application/x-directory';

function isRemoteHttpUrl(filePath: string | undefined): boolean {
  const trimmed = filePath?.trim();
  return !!trimmed && /^https?:\/\//i.test(trimmed);
}

function attachmentOpenTarget(file: AttachedFileMeta): string | undefined {
  return file.filePath?.trim() || file.gatewayUrl?.trim() || undefined;
}

function isCompositeResultMessage(message: RawMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (message.localArtifactResultKind === 'composite') return true;
  if (typeof message.id === 'string' && message.id.startsWith('composite-result:')) return true;
  const text = extractText(message);
  return (message._attachedFiles?.length ?? 0) > 0
    && /随机示例包/.test(text)
    && /(?:统一)?产物清单/.test(text);
}

function isChatPreviewDocument(file: AttachedFileMeta): boolean {
  const name = file.fileName.toLowerCase();
  const mime = file.mimeType.toLowerCase();
  return (
    mime === 'application/pdf'
    || mime === 'application/msword'
    || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || mime === 'application/vnd.ms-powerpoint'
    || mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    || mime === 'application/vnd.ms-excel'
    || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || name.endsWith('.pdf')
    || name.endsWith('.doc')
    || name.endsWith('.docx')
    || name.endsWith('.ppt')
    || name.endsWith('.pptx')
    || name.endsWith('.xls')
    || name.endsWith('.xlsx')
  );
}

function isSupportedMediaAttachment(file: AttachedFileMeta): boolean {
  return (
    file.mimeType.startsWith('image/')
    || file.mimeType.startsWith('video/')
    || file.mimeType.startsWith('audio/')
  );
}

function isDirectoryAttachment(file: AttachedFileMeta): boolean {
  return file.mimeType === DIRECTORY_MIME_TYPE;
}

function getAttachedFileDedupeKeys(file: AttachedFileMeta): string[] {
  const keys: string[] = [];
  const filePath = file.filePath?.trim();
  if (filePath) {
    keys.push(isRemoteHttpUrl(filePath) ? `url:${filePath}` : `path:${filePath}`);
  }
  const gatewayUrl = file.gatewayUrl?.trim();
  if (gatewayUrl) keys.push(`url:${gatewayUrl}`);
  if (keys.length === 0) {
    keys.push(`meta:${file.fileName}|${file.mimeType}|${file.fileSize}|${file.preview ?? ''}`);
  }
  return keys;
}

function dedupeAttachedFiles(files: AttachedFileMeta[]): AttachedFileMeta[] {
  const seen = new Set<string>();
  const next: AttachedFileMeta[] = [];
  for (const file of files) {
    const keys = getAttachedFileDedupeKeys(file);
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    next.push(file);
  }
  return next;
}

function isSkillFileAttachment(file: AttachedFileMeta): boolean {
  const path = file.filePath ?? '';
  return (
    /(?:^|[\\/])\.openclaw[\\/]skills[\\/][^\\/]+[\\/].+\.[A-Za-z0-9]+$/i.test(path)
    || /(?:^|[\\/])skills[\\/][^\\/]+[\\/]SKILL\.md$/i.test(path)
  );
}

function isHtmlOrMarkdownPreview(file: AttachedFileMeta): boolean {
  const name = file.fileName.toLowerCase();
  const mime = file.mimeType.toLowerCase();
  return (
    mime === 'text/html'
    || mime === 'text/markdown'
    || name.endsWith('.html')
    || name.endsWith('.htm')
    || name.endsWith('.md')
    || name.endsWith('.markdown')
  );
}

/** User-facing artifacts that must stay visible when process output is folded into the graph. */
function isUserFacingAttachmentWhenFolded(file: AttachedFileMeta): boolean {
  if (file.mimeType.startsWith('image/')) return true;
  if (file.mimeType.startsWith('video/')) return true;
  if (file.mimeType.startsWith('audio/')) return true;
  if (isDirectoryAttachment(file)) return true;
  if (isSkillFileAttachment(file)) return true;
  if (isSupportedMediaAttachment(file)) return true;
  if (isChatPreviewDocument(file)) return true;
  // Paths parsed from the assistant reply (e.g. "/workspace/demo.html") are
  // intentional user-facing links. Generic tool-result markdown attachments
  // (e.g. CHECKLIST.md emitted mid-run) stay folded into the execution graph.
  if (file.source === 'message-ref' && isHtmlOrMarkdownPreview(file)) return true;
  return false;
}

function validationKindForAttachment(file: AttachedFileMeta): 'file' | 'dir' | null {
  if (!file.filePath) return null;
  if (isRemoteHttpUrl(file.filePath)) return null;
  // User-selected uploads and already enriched attachments are trusted enough
  // for immediate display. Regex-derived message refs start at size 0/null and
  // are validated through main-process stat before becoming clickable cards.
  if (file.source !== 'message-ref' && file.source !== 'tool-result') return null;
  if (file.fileSize > 0 || file.preview) return null;
  return isDirectoryAttachment(file) ? 'dir' : 'file';
}

function pathForExtension(filePath: string): string {
  const trimmed = filePath.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).pathname;
    } catch {
      return trimmed.split(/[?#]/)[0] || trimmed;
    }
  }
  return trimmed.split(/[?#]/)[0] || trimmed;
}

function previewMimeFromPath(filePath: string, taggedMedia = false): string | null {
  const lower = pathForExtension(filePath).toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.avif')) return 'image/avif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.avi')) return 'video/x-msvideo';
  if (lower.endsWith('.mkv')) return 'video/x-matroska';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.aac')) return 'audio/aac';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.doc')) return 'application/msword';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.ppt')) return 'application/vnd.ms-powerpoint';
  if (lower.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (taggedMedia && /^https?:\/\//i.test(filePath.trim())) return 'video/mp4';
  return null;
}

function fileNameFromPath(filePath: string): string {
  if (/^https?:\/\//i.test(filePath.trim())) {
    try {
      const url = new URL(filePath);
      const name = url.pathname.split('/').filter(Boolean).pop();
      return name || 'media';
    } catch {
      // Fall through to path splitting.
    }
  }
  return filePath.split(/[\\/]/).pop() || 'file';
}

function previewForMediaPath(filePath: string, mimeType: string): string | null {
  if (!mimeType.startsWith('image/')) return null;
  if (isRemoteHttpUrl(filePath)) return filePath;
  return null;
}

function rawTextForPreviewExtraction(message: RawMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block.type === 'text' && block.text ? block.text : ''))
      .filter(Boolean)
      .join('\n\n');
  }
  const fallback = (message as { text?: unknown }).text;
  return typeof fallback === 'string' ? fallback : '';
}

function trimPathTerminators(filePath: string): string {
  return filePath.replace(/[，。；;,.!?]+$/u, '');
}

function extractPreviewDocumentPaths(text: string): AttachedFileMeta[] {
  if (!text) return [];
  const refs: AttachedFileMeta[] = [];
  const seen = new Set<string>();
  const pushRef = (filePath: string, mimeType: string) => {
    const normalizedPath = trimPathTerminators(filePath);
    if (!normalizedPath || seen.has(normalizedPath)) return;
    seen.add(normalizedPath);
    refs.push({
      fileName: fileNameFromPath(normalizedPath),
      mimeType,
      fileSize: 0,
      preview: previewForMediaPath(normalizedPath, mimeType),
      filePath: normalizedPath,
      source: 'message-ref',
    });
  };
  // Deliberately narrow this render-layer fallback to user-facing artifacts:
  // media, HTML / Markdown / Office / PDF previews, and OpenClaw skill directories.
  // The store-level extractor still handles broad file categories; this keeps
  // visible outputs clickable even before history enrichment runs.
  const exts = 'png|jpe?g|gif|webp|bmp|avif|svg|mp4|mov|avi|mkv|webm|m4v|mp3|wav|ogg|aac|flac|m4a|html?|md|markdown|pdf|docx?|pptx?|xlsx?|PNG|JPE?G|GIF|WEBP|BMP|AVIF|SVG|MP4|MOV|AVI|MKV|WEBM|M4V|MP3|WAV|OGG|AAC|FLAC|M4A|HTML?|MD|MARKDOWN|PDF|DOCX?|PPTX?|XLSX?';
  const taggedRegex = new RegExp(`(?:^|[\\s(\\[{>])(?:MEDIA|media):((?:\\/|~\\/)[^\\n"'()\\[\\],<>]*?\\.(?:${exts}))`, 'g');
  const remoteTaggedRegex = new RegExp(`(?:^|[\\s(\\[{>])(?:MEDIA|media):(https?:\\/\\/[^\\s\\n"'()\\[\\],<>` + '`' + `]+)`, 'g');
  const unixRegex = new RegExp('(?<![\\w./:])((?:\\/|~\\/)[^\\s\\n"\'`()\\[\\],<>]*?\\.(?:' + exts + '))', 'g');
  const skillPathBoundary = '(?=$|\\s|[\\x5b\\x5d"\'`(),<>，。；;,.!?])';
  const skillPathPart = '[^\\\\/\\s\\n"\'`()\\x5b\\x5d,<>]+';
  const skillPathTail = '[^\\s\\n"\'`()\\x5b\\x5d,<>]*?';
  const skillDirRegex = new RegExp(
    `(?<![\\w./:])((?:~[\\\\/]\\.openclaw[\\\\/]skills[\\\\/]${skillPathPart})|(?:(?:\\/|[A-Za-z]:\\\\)${skillPathTail}[\\\\/]\\.openclaw[\\\\/]skills[\\\\/]${skillPathPart}))${skillPathBoundary}`,
    'gi',
  );
  const skillMarkdownRegex = new RegExp(
    `(?<![\\w./:])((?:~[\\\\/]\\.openclaw[\\\\/]skills[\\\\/]${skillPathTail}\\.md)|(?:(?:\\/|[A-Za-z]:\\\\)${skillPathTail}[\\\\/]\\.openclaw[\\\\/]skills[\\\\/]${skillPathTail}\\.md))${skillPathBoundary}`,
    'gi',
  );

  let workingText = text;
  let taggedMatch: RegExpExecArray | null;
  while ((taggedMatch = remoteTaggedRegex.exec(text)) !== null) {
    const filePath = taggedMatch[1];
    const mimeType = previewMimeFromPath(filePath, true);
    if (mimeType) pushRef(filePath, mimeType);
    const start = taggedMatch.index;
    const end = start + taggedMatch[0].length;
    workingText = workingText.slice(0, start) + ' '.repeat(end - start) + workingText.slice(end);
  }
  while ((taggedMatch = taggedRegex.exec(text)) !== null) {
    const filePath = taggedMatch[1];
    const mimeType = previewMimeFromPath(filePath);
    if (mimeType) pushRef(filePath, mimeType);
    const start = taggedMatch.index;
    const end = start + taggedMatch[0].length;
    workingText = workingText.slice(0, start) + ' '.repeat(end - start) + workingText.slice(end);
  }

  for (const regex of [unixRegex, skillMarkdownRegex, skillDirRegex]) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(workingText)) !== null) {
      const filePath = match[1];
      const mimeType = regex === skillDirRegex ? DIRECTORY_MIME_TYPE : previewMimeFromPath(filePath);
      if (mimeType) pushRef(filePath, mimeType);
    }
  }

  return refs;
}

/**
 * Normalize LaTeX delimiters so `remark-math` can detect them.
 *
 * Many LLMs emit LaTeX using `\(` / `\)` for inline math and `\[` / `\]`
 * for block math (OpenAI style), which are NOT recognized by remark-math.
 * remark-math only parses `$...$` and `$$...$$`.
 *
 * We convert the backslash-paren/bracket forms to dollar-sign forms so the
 * math is rendered regardless of which convention the model uses.
 *
 * Transformations are skipped inside fenced/inline code spans to avoid
 * clobbering code samples that legitimately contain `\(` etc.
 */
function normalizeLatexDelimiters(input: string): string {
  if (!input || (input.indexOf('\\(') === -1 && input.indexOf('\\[') === -1)) {
    return input;
  }

  const parts = input.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (part.startsWith('```') || part.startsWith('`')) continue;
    let next = part.replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `\n$$\n${body.trim()}\n$$\n`);
    next = next.replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$${body}$`);
    parts[i] = next;
  }
  return parts.join('');
}

/** Resolve an ExtractedImage to a displayable src string, or null if not possible. */
function imageSrc(img: ExtractedImage): string | null {
  if (img.url) return isUnresolvableImageUrl(img.url) ? null : img.url;
  if (img.data) return `data:${img.mimeType};base64,${img.data}`;
  return null;
}

export const ChatMessage = memo(function ChatMessage({
  message,
  textOverride,
  assistantAvatarSrc,
  suppressProcessAttachments = false,
  suppressAssistantText = false,
  isStreaming = false,
  streamingTools = [],
  onOpenFile,
  onUseImageAsReference,
}: ChatMessageProps) {
  const isUser = message.role === 'user';
  const isCompositeResult = isCompositeResultMessage(message);
  const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
  const isToolResult = role === 'toolresult' || role === 'tool_result';
  const text = textOverride ?? extractText(message);
  // When text is folded into an ExecutionGraphCard, treat the message as
  // having no text for rendering purposes. Keeping this behind a flag (vs
  // blanking `text` outright) lets future hover affordances still read the
  // original content without surfacing the bubble.
  const hideAssistantText = suppressAssistantText && !isUser;
  const hasText = !hideAssistantText && text.trim().length > 0;
  const images = extractImages(message);
  const resolvableContentImages = images.filter((img) => imageSrc(img) != null);
  const [validatedPaths, setValidatedPaths] = useState<Record<string, boolean>>({});
  const rawAttachedFiles = dedupeAttachedFiles(message._attachedFiles || []);
  const textPreviewFiles = isUser ? [] : extractPreviewDocumentPaths(textOverride ?? rawTextForPreviewExtraction(message));
  const rawAttachedPaths = new Set(rawAttachedFiles.map((file) => file.filePath).filter(Boolean));
  const derivedAttachedFiles = dedupeAttachedFiles([
    ...rawAttachedFiles,
    ...textPreviewFiles.filter((file) => !file.filePath || !rawAttachedPaths.has(file.filePath)),
  ]);
  const validationTargets = derivedAttachedFiles
    .map((file) => {
      const kind = validationKindForAttachment(file);
      return kind && file.filePath ? { filePath: file.filePath, kind } : null;
    })
    .filter((target): target is { filePath: string; kind: 'file' | 'dir' } => !!target);
  const validationKey = validationTargets
    .map((target) => `${target.kind}:${target.filePath}`)
    .sort()
    .join('\n');
  useEffect(() => {
    if (!validationKey) return;
    const pendingTargets = validationTargets.filter((target) => validatedPaths[target.filePath] === undefined);
    if (pendingTargets.length === 0) return;

    let cancelled = false;
    void Promise.all(
      pendingTargets.map(async (target) => {
        try {
          const stat = await statFile(target.filePath);
          return {
            filePath: target.filePath,
            exists: !!stat.ok && (target.kind === 'dir' ? !!stat.isDir : !!stat.isFile),
          };
        } catch {
          return { filePath: target.filePath, exists: false };
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setValidatedPaths((current) => {
        const next = { ...current };
        for (const result of results) next[result.filePath] = result.exists;
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [validationKey, validationTargets, validatedPaths]);
  const existingDerivedAttachedFiles = derivedAttachedFiles.filter((file) => {
    const kind = validationKindForAttachment(file);
    if (!kind || !file.filePath) return true;
    return validatedPaths[file.filePath] === true;
  });
  const filteredProcessAttachments = derivedAttachedFiles.filter((file) => {
    if (file.source !== 'tool-result' && file.source !== 'message-ref') return true;
    // Runtime-produced user-facing artifacts (images, HTML/Markdown/PDF/XLSX,
    // skill directories, ...) must remain visible in the reply bubble even
    // when generic process attachments are folded into the execution graph.
    // The graph card itself does not render `_attachedFiles`, so dropping
    // them here would leave the user with no way to open previews from chat.
    return isUserFacingAttachmentWhenFolded(file);
  });
  // When a message is attachment-only, keep those attachments visible even if
  // process attachments are generally suppressed for this run segment —
  // otherwise the reply disappears entirely.
  const processVisibleAttachments = filteredProcessAttachments.filter((file) => {
    const kind = validationKindForAttachment(file);
    if (!kind || !file.filePath) return true;
    return validatedPaths[file.filePath] === true;
  });
  const attachedFiles = suppressProcessAttachments && (hasText || resolvableContentImages.length > 0)
    ? processVisibleAttachments
    : existingDerivedAttachedFiles;
  const imageCopyTarget = resolvePrimaryImageCopyTarget(resolvableContentImages, attachedFiles);
  const showAssistantHoverBar = !isUser && (hasText || imageCopyTarget != null);
  const [lightboxImg, setLightboxImg] = useState<{ src: string; fileName: string; filePath?: string; base64?: string; mimeType?: string } | null>(null);

  // Never render tool result messages in chat UI
  if (isToolResult) return null;

  const hasStreamingToolStatus = isStreaming && streamingTools.length > 0;
  if (!hasText && resolvableContentImages.length === 0 && attachedFiles.length === 0 && !hasStreamingToolStatus) return null;

  return (
    <div
      className={cn(
        'flex gap-3 group',
        isUser ? 'flex-row-reverse' : 'flex-row',
      )}
    >
      {/* Avatar — vertical center aligned with the first line of the reply.
          The outer slot is sized to one prose-sm line (h-6 = 24px) so its
          midpoint coincides with the first text line's midpoint; the 32px
          avatar inside is centered within that slot and intentionally
          overflows ±4px above/below the line, which mirrors how chat avatars
          sit alongside a single line of text. */}
      {!isUser && (
        <div className="flex h-6 shrink-0 items-center">
          <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-black/5 dark:bg-white/5 text-foreground">
            {assistantAvatarSrc ? (
              <img src={assistantAvatarSrc} alt="" data-testid="assistant-agent-avatar" className="h-full w-full object-cover" />
            ) : (
              <img src={DEFAULT_AGENT_AVATAR_SRC} alt="" data-testid="assistant-agent-avatar" className="h-full w-full object-cover" />
            )}
          </div>
        </div>
      )}

      {/* Content */}
      <div
        className={cn(
          'flex flex-col w-full min-w-0 max-w-[80%] space-y-2',
          isUser ? 'items-end' : 'items-start',
        )}
      >
        {isStreaming && !isUser && streamingTools.length > 0 && (
          <ToolStatusBar tools={streamingTools} />
        )}

        {/* Images — rendered ABOVE text bubble for user messages */}
        {/* Images from content blocks (Gateway session data / channel push photos) */}
        {isUser && resolvableContentImages.length > 0 && (
          <div className="flex flex-wrap items-start gap-2">
            {resolvableContentImages.map((img, i) => {
              const src = imageSrc(img);
              if (!src) return null;
              return (
                <ImageThumbnail
                  key={`content-${i}`}
                  src={src}
                  fileName="image"
                  base64={img.data}
                  mimeType={img.mimeType}
                  width={img.width}
                  height={img.height}
                  onPreview={() => setLightboxImg({ src, fileName: 'image', base64: img.data, mimeType: img.mimeType })}
                />
              );
            })}
          </div>
        )}

        {/* File attachments — images above text for user, file cards below */}
        {isUser && attachedFiles.length > 0 && (
          <div className="flex flex-wrap items-start gap-2">
            {attachedFiles.map((file, i) => {
              const isImage = file.mimeType.startsWith('image/');
              const isVideo = file.mimeType.startsWith('video/');
              // Skip image attachments if we already have images from content blocks
              if (isImage && resolvableContentImages.length > 0) return null;
              if (isImage) {
                return file.preview ? (
                  <ImageThumbnail
                    key={`local-${i}`}
                    src={file.preview}
                    fileName={file.fileName}
                    filePath={file.filePath}
                    mimeType={file.mimeType}
                    width={file.width}
                    height={file.height}
                    onPreview={() => setLightboxImg({ src: file.preview!, fileName: file.fileName, filePath: file.filePath, mimeType: file.mimeType })}
                    onUseAsReference={file.filePath ? () => onUseImageAsReference?.(file) : undefined}
                  />
                ) : file.filePath ? (
                  <AsyncImageAttachmentCard
                    key={`local-${i}`}
                    file={file}
                    variant="thumbnail"
                    onPreview={(src) => setLightboxImg({ src, fileName: file.fileName, filePath: file.filePath, mimeType: file.mimeType })}
                    onUseAsReference={file.filePath ? () => onUseImageAsReference?.(file) : undefined}
                  />
                ) : (
                  <ImagePreviewPlaceholder key={`local-${i}`} file={file} />
                );
              }
              // Non-image files → file card
              if (isVideo) {
                return <VideoPreviewCard key={`local-${i}`} file={file} onOpen={onOpenFile} />;
              }
              return <FileCard key={`local-${i}`} file={file} onOpen={onOpenFile} />;
            })}
          </div>
        )}

        {/* Main text */}
        {hasText && (
          isUser ? (
            <UserMessageBubble text={text} />
          ) : (
            <AssistantMarkdown text={text} isStreaming={isStreaming} />
          )
        )}

        {/* Images from content blocks — assistant messages (below text) */}
        {!isUser && resolvableContentImages.length > 0 && (
          <div className="flex flex-wrap items-start gap-2">
            {resolvableContentImages.map((img, i) => {
              const src = imageSrc(img);
              if (!src) return null;
              const referenceFile = attachedFiles.find((file) => (
                file.mimeType.startsWith('image/')
                && !!file.filePath
                && (file.gatewayUrl === img.url || file.preview === src)
              ));
              return (
                <ImagePreviewCard
                  key={`content-${i}`}
                  src={src}
                  fileName="image"
                  base64={img.data}
                  mimeType={img.mimeType}
                  width={referenceFile?.width ?? img.width}
                  height={referenceFile?.height ?? img.height}
                  onPreview={() => setLightboxImg({
                    src,
                    fileName: referenceFile?.fileName ?? 'image',
                    filePath: referenceFile?.filePath,
                    base64: img.data,
                    mimeType: referenceFile?.mimeType ?? img.mimeType,
                  })}
                  onUseAsReference={referenceFile ? () => onUseImageAsReference?.(referenceFile) : undefined}
                />
              );
            })}
          </div>
        )}

        {/* Composite result attachments — compact Codex-style manifest. */}
        {!isUser && isCompositeResult && (
          attachedFiles.length > 0 || (message.compositeArtifactManifest?.tasks.length ?? 0) > 0
        ) && (
          <CompositeArtifactGrid
            files={attachedFiles}
            manifest={message.compositeArtifactManifest}
            onOpenFile={onOpenFile}
            onPreviewImage={(file, src) => setLightboxImg({
              src,
              fileName: file.fileName,
              filePath: file.filePath,
              mimeType: file.mimeType,
            })}
          />
        )}

        {/* File attachments — assistant messages (below text) */}
        {!isUser && !isCompositeResult && attachedFiles.length > 0 && (
          <div className="flex flex-wrap items-start gap-2">
            {attachedFiles.map((file, i) => {
              const isImage = file.mimeType.startsWith('image/');
              const isVideo = file.mimeType.startsWith('video/');
              if (isImage && resolvableContentImages.length > 0) return null;
              if (isImage && file.preview) {
                return (
                  <ImagePreviewCard
                    key={`local-${i}`}
                    src={file.preview}
                    fileName={file.fileName}
                    filePath={file.filePath}
                    mimeType={file.mimeType}
                    width={file.width}
                    height={file.height}
                    onPreview={() => setLightboxImg({ src: file.preview!, fileName: file.fileName, filePath: file.filePath, mimeType: file.mimeType })}
                    onUseAsReference={file.filePath ? () => onUseImageAsReference?.(file) : undefined}
                  />
                );
              }
              if (isImage && file.filePath) {
                return (
                  <AsyncImageAttachmentCard
                    key={`local-${i}`}
                    file={file}
                    variant="preview"
                    onPreview={(src) => setLightboxImg({ src, fileName: file.fileName, filePath: file.filePath, mimeType: file.mimeType })}
                    onUseAsReference={file.filePath ? () => onUseImageAsReference?.(file) : undefined}
                  />
                );
              }
              if (isImage && !file.preview) {
                return <ImagePreviewPlaceholder key={`local-${i}`} file={file} />;
              }
              if (isVideo) {
                return <VideoPreviewCard key={`local-${i}`} file={file} onOpen={onOpenFile} />;
              }
              return <FileCard key={`local-${i}`} file={file} onOpen={onOpenFile} />;
            })}
          </div>
        )}

        {/* Hover row for user messages — timestamp only */}
        {isUser && message.timestamp && (
          <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-200 select-none">
            {formatTimestamp(message.timestamp)}
          </span>
        )}

        {/* Hover row for assistant messages */}
        {showAssistantHoverBar && (
          <AssistantHoverBar text={text} timestamp={message.timestamp} imageCopyTarget={imageCopyTarget} />
        )}
      </div>

      {/* Image lightbox portal */}
      {lightboxImg && (
        <ImageLightbox
          src={lightboxImg.src}
          fileName={lightboxImg.fileName}
          filePath={lightboxImg.filePath}
          base64={lightboxImg.base64}
          mimeType={lightboxImg.mimeType}
          onClose={() => setLightboxImg(null)}
        />
      )}
    </div>
  );
});

function formatDuration(durationMs?: number): string | null {
  if (!durationMs || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function ToolStatusBar({
  tools,
}: {
  tools: Array<{
    id?: string;
    toolCallId?: string;
    name: string;
    status: 'running' | 'completed' | 'error';
    durationMs?: number;
    summary?: string;
  }>;
}) {
  return (
    <div className="w-full space-y-1" data-testid="chat-streaming-tool-status-bar">
      {tools.map((tool) => {
        const duration = formatDuration(tool.durationMs);
        const isRunning = tool.status === 'running';
        const isError = tool.status === 'error';
        return (
          <div
            key={tool.toolCallId || tool.id || tool.name}
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors',
              isRunning && 'border-primary/30 bg-primary/5 text-foreground',
              !isRunning && !isError && 'border-border/50 bg-surface-input/20 text-muted-foreground',
              isError && 'border-destructive/30 bg-destructive/5 text-destructive',
            )}
          >
            {isRunning && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />}
            {!isRunning && !isError && <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />}
            {isError && <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />}
            <Wrench className="h-3 w-3 shrink-0 opacity-60" />
            <span className="font-mono text-xs font-medium">{tool.name}</span>
            {duration && <span className="text-tiny opacity-60">{tool.summary ? `(${duration})` : duration}</span>}
            {tool.summary && (
              <span className="truncate text-tiny opacity-70">{tool.summary}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function artifactTypeLabel(file: AttachedFileMeta, t: (key: string) => string): string {
  const mime = file.mimeType.toLowerCase();
  const name = file.fileName.toLowerCase();
  if (mime.startsWith('image/')) return t('artifactManifest.types.image');
  if (mime.startsWith('video/')) return t('artifactManifest.types.video');
  if (name.endsWith('.ppt') || name.endsWith('.pptx')) return t('artifactManifest.types.presentation');
  if (name.endsWith('.xls') || name.endsWith('.xlsx')) return t('artifactManifest.types.spreadsheet');
  if (name.endsWith('.html') || name.endsWith('.htm')) return t('artifactManifest.types.miniProgram');
  if (name.endsWith('.md') || name.endsWith('.markdown') || mime === 'text/markdown') return t('artifactManifest.types.copywriting');
  return t('artifactManifest.types.file');
}

function openAttachment(file: AttachedFileMeta, onOpenFile?: (file: AttachedFileMeta) => void): void {
  const target = attachmentOpenTarget(file);
  if (!target) return;
  if (onOpenFile && file.filePath) {
    onOpenFile(file);
    return;
  }
  if (isRemoteHttpUrl(target)) {
    void invokeIpc('shell:openExternal', target);
  } else {
    void invokeIpc('shell:openPath', target);
  }
}

function useResolvedMediaSrc(target: string | undefined): string | null {
  const key = target ?? '';
  const immediate = immediateMediaSrcFromFilePath(target);
  const [resolved, setResolved] = useState<{ key: string; src: string | null }>(() => ({
    key,
    src: immediate,
  }));

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(immediate ?? mediaSrcFromFilePath(target))
      .then((src) => {
        if (!cancelled) setResolved({ key, src });
      })
      .catch(() => {
        if (!cancelled) setResolved({ key, src: null });
      });
    return () => {
      cancelled = true;
    };
  }, [key, immediate, target]);

  return resolved.key === key ? resolved.src : immediate;
}

function CompactImageArtifact({
  file,
  onPreview,
}: {
  file: AttachedFileMeta;
  onPreview: (src: string) => void;
}) {
  const src = useResolvedMediaSrc(attachmentOpenTarget(file));

  if (!src) {
    return (
      <div className="flex h-14 w-16 shrink-0 items-center justify-center rounded-md bg-black/5 dark:bg-white/10">
        <FileIcon mimeType={file.mimeType} className="h-4 w-4 text-muted-foreground" />
      </div>
    );
  }

  return (
    <button
      type="button"
      className="h-14 w-16 shrink-0 overflow-hidden rounded-md bg-black/5 dark:bg-white/10"
      onClick={() => onPreview(src)}
      title={file.fileName}
    >
      <img src={src} alt="" className="h-full w-full object-cover" />
    </button>
  );
}

function CompositeArtifactGrid({
  files,
  manifest,
  onOpenFile,
  onPreviewImage,
}: {
  files: AttachedFileMeta[];
  manifest?: CompositeArtifactManifest;
  onOpenFile?: (file: AttachedFileMeta) => void;
  onPreviewImage: (file: AttachedFileMeta, src: string) => void;
}) {
  const { t } = useTranslation('chat');
  const visibleFiles = dedupeAttachedFiles(files).filter((file) => attachmentOpenTarget(file));
  const manifestTasks = manifest?.tasks ?? [];
  const referencedTargets = new Set<string>();
  const rows: Array<{
    id: string;
    title: string;
    status: 'completed' | 'failed' | 'blocked';
    detail?: string;
    file?: AttachedFileMeta;
  }> = manifestTasks.flatMap((task) => {
    const refs = new Set(task.artifactRefs.map((ref) => ref.trim()).filter(Boolean));
    const taskFiles = visibleFiles.filter((file) => {
      const target = attachmentOpenTarget(file);
      const matches = Boolean(
        (target && refs.has(target))
        || refs.has(file.fileName)
        || (file.filePath && refs.has(file.filePath))
        || (file.gatewayUrl && refs.has(file.gatewayUrl)),
      );
      if (matches && target) referencedTargets.add(target);
      return matches;
    });
    if (taskFiles.length === 0) {
      return [{ id: task.id, title: task.title, status: task.status, detail: task.detail }];
    }
    return taskFiles.map((file, index) => ({
      id: `${task.id}:${index}`,
      title: task.title,
      status: task.status,
      detail: task.detail,
      file,
    }));
  });
  for (const [index, file] of visibleFiles.entries()) {
    const target = attachmentOpenTarget(file);
    if (target && referencedTargets.has(target)) continue;
    rows.push({
      id: `artifact:${index}:${target ?? file.fileName}`,
      title: artifactTypeLabel(file, t),
      status: 'completed',
      file,
    });
  }
  if (rows.length === 0) return null;
  const hasProblems = rows.some((row) => row.status !== 'completed');
  const statusLabel = (status: 'completed' | 'failed' | 'blocked') => t(`artifactManifest.${status}`);

  return (
    <div className="w-full max-w-2xl space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-foreground/80">
        {hasProblems
          ? <AlertCircle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />}
        <span>{t('artifactManifest.title')}</span>
        <span className="text-muted-foreground">{t('artifactManifest.count', { count: manifestTasks.length || rows.length })}</span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="list">
        {rows.map((row) => {
          const file = row.file;
          if (!file) {
            const completedWithoutFile = row.status === 'completed';
            return (
              <div
                key={row.id}
                className={cn(
                  'flex min-w-0 items-start gap-2 rounded-lg border p-3',
                  completedWithoutFile
                    ? 'border-emerald-500/15 bg-emerald-500/[0.035]'
                    : 'border-amber-500/20 bg-amber-500/[0.04]',
                )}
                role="listitem"
              >
                {completedWithoutFile
                  ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />}
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-foreground">{row.title}</p>
                  <p className="mt-0.5 text-2xs text-muted-foreground">
                    {statusLabel(row.status)}
                    {(row.detail || !completedWithoutFile) && (
                      <> · {row.detail || t('artifactManifest.noArtifact')}</>
                    )}
                  </p>
                </div>
              </div>
            );
          }
          const isImage = file.mimeType.startsWith('image/');
          const isVideo = file.mimeType.startsWith('video/');
          const target = attachmentOpenTarget(file);
          return (
            <div
              key={row.id}
              className="group/artifact flex min-w-0 items-center gap-3 rounded-lg border border-black/8 bg-background/70 p-2 transition-colors hover:bg-black/[0.04] dark:border-white/10 dark:bg-white/[0.035] dark:hover:bg-white/[0.06]"
              role="listitem"
            >
              {isImage ? (
                <CompactImageArtifact
                  file={file}
                  onPreview={(src) => onPreviewImage(file, src)}
                />
              ) : (
                <button
                  type="button"
                  className="flex h-14 w-16 shrink-0 items-center justify-center rounded-md bg-black/5 text-muted-foreground transition-colors hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
                  onClick={() => openAttachment(file, onOpenFile)}
                  title={target}
                >
                  <FileIcon mimeType={file.mimeType} className="h-5 w-5" />
                </button>
              )}
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  if (!isImage) openAttachment(file, onOpenFile);
                }}
                title={target}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground dark:bg-white/10">
                    {artifactTypeLabel(file, t)}
                  </span>
                  {isVideo && (
                    <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground dark:bg-white/10">
                      {t('artifactManifest.playable')}
                    </span>
                  )}
                  <span className="shrink-0 text-[10px] text-muted-foreground">{statusLabel(row.status)}</span>
                </div>
                <p className="mt-1 truncate text-xs font-medium text-foreground">{row.title}</p>
                <p className="mt-0.5 truncate text-2xs text-foreground/70">{file.fileName}</p>
                <p className="mt-0.5 truncate text-2xs text-muted-foreground">
                  {file.fileSize > 0
                    ? formatFileSize(file.fileSize)
                    : (isVideo ? t('artifactManifest.videoLink') : t('artifactManifest.generated'))}
                </p>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function resolvePrimaryImageCopyTarget(
  images: Array<{ mimeType: string; data?: string; url?: string }>,
  attachedFiles: AttachedFileMeta[],
): ImageCopyTarget | null {
  for (const file of attachedFiles) {
    if (!file.mimeType.startsWith('image/')) continue;
    if (file.filePath || file.preview?.startsWith('data:')) {
      return {
        filePath: file.filePath,
        preview: file.preview,
        mimeType: file.mimeType,
      };
    }
  }

  for (const image of images) {
    if (image.data) {
      return { base64: image.data, mimeType: image.mimeType };
    }
    if (image.url?.startsWith('data:')) {
      return { preview: image.url, mimeType: image.mimeType };
    }
  }

  return null;
}

// ── Assistant hover bar (timestamp + copy, shown on group hover) ─

function AssistantHoverBar({
  text,
  timestamp,
  imageCopyTarget,
}: {
  text: string;
  timestamp?: number;
  imageCopyTarget?: ImageCopyTarget | null;
}) {
  const [copied, setCopied] = useState(false);

  const copyContent = useCallback(async () => {
    if (imageCopyTarget) {
      const copiedImage = await copyImageToClipboard(imageCopyTarget);
      if (copiedImage) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        return;
      }
    }
    if (!text.trim()) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text, imageCopyTarget]);

  return (
    <div className="flex items-center justify-between w-full opacity-0 group-hover:opacity-100 transition-opacity duration-200 select-none px-1">
      <span className="text-xs text-muted-foreground">
        {timestamp ? formatTimestamp(timestamp) : ''}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={copyContent}
      >
        {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      </Button>
    </div>
  );
}

// ── User Message Bubble ─────────────────────────────────────────

function UserMessageBubble({
  text,
}: {
  text: string;
}) {
  return (
    <div className="relative rounded-2xl px-4 py-3 bg-brand text-white shadow-sm">
      <p className="whitespace-pre-wrap break-words text-sm">{text}</p>
    </div>
  );
}

// ── Assistant Markdown ──────────────────────────────────────────

function AssistantMarkdown({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) {
  return (
    <div className="prose prose-sm dark:prose-invert w-full max-w-none break-words text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false, output: 'html' }]]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const isInline = !match && !className;
            if (isInline) {
              return (
                <code className="bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded text-sm font-mono break-words break-all" {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className={cn('text-sm font-mono', className)} {...props}>
                {children}
              </code>
            );
          },
          pre({ children, ...props }) {
            return (
              <pre
                className="bg-black/5 dark:bg-white/5 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-words"
                {...props}
              >
                {children}
              </pre>
            );
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-words break-all">
                {children}
              </a>
            );
          },
          img({ src, alt }) {
            if (!src || isUnresolvableImageUrl(String(src))) return null;
            return (
              <img src={String(src)} alt={typeof alt === 'string' ? alt : 'image'} className="max-w-full rounded-lg" />
            );
          },
        }}
      >
        {normalizeLatexDelimiters(text)}
      </ReactMarkdown>
      {isStreaming && (
        <span className="inline-block w-2 h-4 bg-foreground/50 animate-pulse ml-0.5" />
      )}
    </div>
  );
}

// ── File Card (for user-uploaded non-image files) ───────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType === DIRECTORY_MIME_TYPE) return <FolderOpen className={className} />;
  if (mimeType.startsWith('video/')) return <Film className={className} />;
  if (mimeType.startsWith('audio/')) return <Music className={className} />;
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return <FileText className={className} />;
  if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('archive') || mimeType.includes('tar') || mimeType.includes('rar') || mimeType.includes('7z')) return <FileArchive className={className} />;
  if (mimeType === 'application/pdf') return <FileText className={className} />;
  return <File className={className} />;
}

function FileCard({ file, onOpen }: { file: AttachedFileMeta; onOpen?: (file: AttachedFileMeta) => void }) {
  const handleOpen = useCallback(() => {
    const target = attachmentOpenTarget(file);
    if (!target) return;
    if (onOpen && file.filePath) {
      onOpen(file);
    } else if (isRemoteHttpUrl(target)) {
      void invokeIpc('shell:openExternal', target);
    } else {
      void invokeIpc('shell:openPath', target);
    }
  }, [file, onOpen]);

  return (
    <div 
      className={cn(
        "flex items-center gap-3 rounded-xl border border-black/10 dark:border-white/10 px-3 py-2.5 bg-black/5 dark:bg-white/5 max-w-[220px]",
        attachmentOpenTarget(file) && "cursor-pointer hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
      )}
      onClick={handleOpen}
      title={attachmentOpenTarget(file) ? "Open file" : undefined}
    >
      <FileIcon mimeType={file.mimeType} className="h-5 w-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 overflow-hidden">
        <p className="text-xs font-medium truncate">{file.fileName}</p>
        <p className="text-2xs text-muted-foreground">
          {file.mimeType === DIRECTORY_MIME_TYPE ? '文件夹' : file.fileSize > 0 ? formatFileSize(file.fileSize) : 'File'}
        </p>
      </div>
    </div>
  );
}

function localPathFromMediaFilePath(filePath: string): string | null {
  if (/^file:\/\//i.test(filePath)) {
    try {
      return decodeURIComponent(new URL(filePath).pathname);
    } catch {
      return filePath.replace(/^file:\/\/\/?/i, '');
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filePath)) return null;
  return filePath;
}

async function mediaSrcFromFilePath(filePath: string | undefined): Promise<string | null> {
  if (!filePath) return null;
  const trimmed = filePath.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const localPath = localPathFromMediaFilePath(trimmed);
  if (!localPath) return trimmed;
  return createAuthenticatedHostApiUrl(`/api/files/local-media?path=${encodeURIComponent(localPath)}`);
}

function immediateMediaSrcFromFilePath(filePath: string | undefined): string | null {
  const trimmed = filePath?.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function VideoPreviewCard({ file, onOpen }: { file: AttachedFileMeta; onOpen?: (file: AttachedFileMeta) => void }) {
  const mediaTarget = attachmentOpenTarget(file);
  const src = useResolvedMediaSrc(mediaTarget);

  const handleOpen = useCallback(() => {
    const target = attachmentOpenTarget(file);
    if (!target) return;
    if (onOpen && file.filePath) {
      onOpen(file);
    } else if (isRemoteHttpUrl(target)) {
      void invokeIpc('shell:openExternal', target);
    } else {
      void invokeIpc('shell:openPath', target);
    }
  }, [file, onOpen]);

  if (!src) {
    return <FileCard file={file} onOpen={onOpen} />;
  }

  return (
    <div className="group flex w-full max-w-[360px] flex-col overflow-hidden rounded-xl border border-black/10 bg-black/5 dark:border-white/10 dark:bg-white/5">
      <video
        src={src}
        controls
        preload="metadata"
        className="aspect-video w-full bg-black object-contain"
      />
      <button
        type="button"
        onClick={handleOpen}
        className="flex items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
        title={file.filePath}
      >
        <Film className="h-4 w-4 shrink-0" />
        <span className="truncate">{file.fileName}</span>
      </button>
    </div>
  );
}

function AsyncImageAttachmentCard({
  file,
  variant,
  onPreview,
  onUseAsReference,
}: {
  file: AttachedFileMeta;
  variant: 'thumbnail' | 'preview';
  onPreview: (src: string) => void;
  onUseAsReference?: () => void;
}) {
  const [src, setSrc] = useState<string | null>(() => immediateMediaSrcFromFilePath(file.filePath));
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const immediate = immediateMediaSrcFromFilePath(file.filePath);
    setSrc(immediate);
    setUnavailable(false);
    if (immediate) {
      return () => {
        cancelled = true;
      };
    }
    void mediaSrcFromFilePath(file.filePath)
      .then((resolved) => {
        if (cancelled) return;
        setSrc(resolved);
        setUnavailable(!resolved);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [file.filePath]);

  if (!src) {
    return (
      <ImagePreviewPlaceholder
        file={unavailable ? { ...file, previewStatus: 'unavailable' } : file}
      />
    );
  }

  if (variant === 'thumbnail') {
    return (
      <ImageThumbnail
        src={src}
        fileName={file.fileName}
        filePath={file.filePath}
        mimeType={file.mimeType}
        width={file.width}
        height={file.height}
        onPreview={() => onPreview(src)}
        onUseAsReference={onUseAsReference}
      />
    );
  }

  return (
    <ImagePreviewCard
      src={src}
      fileName={file.fileName}
      filePath={file.filePath}
      mimeType={file.mimeType}
      width={file.width}
      height={file.height}
      onPreview={() => onPreview(src)}
      onUseAsReference={onUseAsReference}
    />
  );
}

function ImagePreviewPlaceholder({ file }: { file: AttachedFileMeta }) {
  const { t } = useTranslation('chat');
  const unavailable = file.previewStatus === 'unavailable';
  const label = unavailable
    ? t('imageGeneration.previewUnavailable')
    : t('imageGeneration.previewLoading');

  return (
    <div
      className={cn(
        'flex h-36 w-36 flex-col items-center justify-center gap-2 rounded-xl border border-black/10 bg-black/5 px-3 text-center text-muted-foreground dark:border-white/10 dark:bg-white/5',
        unavailable && 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400',
      )}
      data-testid={unavailable ? 'image-preview-unavailable' : 'image-preview-loading'}
      title={file.fileName}
    >
      {unavailable ? (
        <AlertCircle className="h-5 w-5 shrink-0" />
      ) : (
        <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />
      )}
      <span className="text-xs leading-4">{label}</span>
    </div>
  );
}

// ── Image Thumbnail (user bubble — square crop with zoom hint) ──

function ImageThumbnail({
  src,
  fileName,
  filePath,
  base64,
  mimeType,
  width,
  height,
  onPreview,
  onUseAsReference,
}: {
  src: string;
  fileName: string;
  filePath?: string;
  base64?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  onPreview: () => void;
  onUseAsReference?: () => void;
}) {
  void filePath; void base64; void mimeType;
  return (
    <div
      className="relative h-36 w-36 self-start rounded-xl border border-black/10 bg-black/5 overflow-hidden group/img cursor-zoom-in dark:border-white/10 dark:bg-white/5"
      onClick={onPreview}
      data-testid="chat-image-thumbnail"
    >
      <img src={src} alt={fileName} width={width} height={height} className="h-full w-full object-cover" />
      <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/25 transition-colors flex items-center justify-center">
        <ZoomIn className="h-6 w-6 text-white opacity-0 group-hover/img:opacity-100 transition-opacity drop-shadow" />
      </div>
      {onUseAsReference && (
        <ImageReferenceButton onUseAsReference={onUseAsReference} />
      )}
    </div>
  );
}

// ── Image Preview Card (assistant bubble — natural size with overlay actions) ──

function ImagePreviewCard({
  src,
  fileName,
  filePath,
  base64,
  mimeType,
  width,
  height,
  onPreview,
  onUseAsReference,
}: {
  src: string;
  fileName: string;
  filePath?: string;
  base64?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  onPreview: () => void;
  onUseAsReference?: () => void;
}) {
  void filePath; void base64; void mimeType;
  return (
    <div
      className="relative max-w-xs self-start rounded-xl border border-black/10 bg-black/5 overflow-hidden group/img cursor-zoom-in dark:border-white/10 dark:bg-white/5"
      onClick={onPreview}
      data-testid="chat-image-preview-card"
    >
      <img src={src} alt={fileName} width={width} height={height} className="block h-auto w-full" />
      <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/20 transition-colors flex items-center justify-center">
        <ZoomIn className="h-6 w-6 text-white opacity-0 group-hover/img:opacity-100 transition-opacity drop-shadow" />
      </div>
      {onUseAsReference && (
        <ImageReferenceButton onUseAsReference={onUseAsReference} />
      )}
    </div>
  );
}

function ImageReferenceButton({
  onUseAsReference,
}: {
  onUseAsReference: () => void;
}) {
  return (
    <button
      type="button"
      className="absolute bottom-2 right-2 inline-flex h-7 items-center gap-1 rounded-lg bg-white/95 px-2 text-xs font-medium text-foreground opacity-0 shadow-sm transition-opacity hover:bg-white focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/img:opacity-100 dark:bg-black/80 dark:hover:bg-black"
      onClick={(event) => {
        event.stopPropagation();
        onUseAsReference();
      }}
      title="修改图片"
      aria-label="修改图片"
      data-testid="image-edit-reference-button"
    >
      <ImagePlus className="h-3.5 w-3.5" />
      <span>修改图片</span>
    </button>
  );
}

// ── Image Lightbox ───────────────────────────────────────────────

function ImageLightbox({
  src,
  fileName,
  filePath,
  base64,
  mimeType,
  onClose,
}: {
  src: string;
  fileName: string;
  filePath?: string;
  base64?: string;
  mimeType?: string;
  onClose: () => void;
}) {
  void base64;
  const [originalSrc, setOriginalSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!filePath || isRemoteHttpUrl(filePath)) {
      setOriginalSrc(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setOriginalSrc(null);
    void (async () => {
      try {
        const result = await readBinaryFile(filePath);
        if (cancelled || !result.ok || !result.data) return;
        const bytes = new Uint8Array(result.data.byteLength);
        bytes.set(result.data);
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.mimeType || mimeType || 'image/png' }));
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setOriginalSrc(objectUrl);
      } catch {
        if (!cancelled) setOriginalSrc(null);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filePath, mimeType]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleShowInFolder = useCallback(() => {
    if (filePath) {
      invokeIpc('shell:showItemInFolder', filePath);
    }
  }, [filePath]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Image + buttons stacked */}
      <div
        className="flex flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={originalSrc ?? src}
          alt={fileName}
          className="max-w-[90vw] max-h-[85vh] rounded-lg shadow-2xl object-contain"
        />

        {/* Action buttons below image */}
        <div className="flex items-center gap-2">
          {filePath && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 bg-white/10 hover:bg-white/20 text-white"
              onClick={handleShowInFolder}
              title="在文件夹中显示"
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 bg-white/10 hover:bg-white/20 text-white"
            onClick={onClose}
            title="关闭"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
