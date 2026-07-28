import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Download, FolderOpen, ImageIcon, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { RenderPart } from '@/lib/acp/timeline-types';
import { hostApi } from '@/lib/host-api';
import { FILE_PREVIEW_MAX_BINARY_BYTES } from '@shared/file-preview/limits';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { copyImageToClipboard } from './copy-image';

type ImageRenderPart = Extract<RenderPart, { kind: 'image' }>;

type FullSizePreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error' };

function safeImageSource(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^blob:/i.test(trimmed)) return trimmed;
  if (/^file:/i.test(trimmed)) return trimmed;
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) return trimmed;
  return null;
}

function imageExtension(mimeType?: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/svg+xml') return 'svg';
  const subtype = mimeType?.match(/^image\/([a-z0-9.+-]+)$/i)?.[1];
  return subtype ? subtype.split('+')[0] : 'png';
}

function filePathFromFileUrl(source: string): string | null {
  try {
    const url = new URL(source);
    if (url.protocol !== 'file:') return null;
    const path = decodeURIComponent(url.pathname);
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

function dataUrlParts(source: string): { base64: string; mimeType: string } | null {
  const match = source.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  return match?.[1] && match[2] ? { mimeType: match[1], base64: match[2] } : null;
}

export function isSafeAcpImageSource(source: string): boolean {
  return safeImageSource(source) != null;
}

export function AcpImagePart({
  part,
  className,
  variant = 'preview',
}: {
  part: ImageRenderPart;
  className?: string;
  variant?: 'preview' | 'thumbnail';
}) {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [fullSizePreview, setFullSizePreview] = useState<FullSizePreviewState>({ status: 'idle' });
  const src = safeImageSource(part.source);
  const mimeType = part.mimeType?.startsWith('image/') ? part.mimeType : (src ? dataUrlParts(src)?.mimeType : undefined) ?? 'image/png';
  const defaultFileName = `generated-image.${imageExtension(mimeType)}`;
  const handleCopy = useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!src) return;
    const filePath = filePathFromFileUrl(src) ?? undefined;
    const ok = await copyImageToClipboard({
      preview: src,
      filePath,
      mimeType,
    });
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [src, mimeType]);
  const handleSave = useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!src) return;
    const data = dataUrlParts(src);
    const filePath = filePathFromFileUrl(src);
    const payload = data
      ? { base64: data.base64, mimeType: data.mimeType, defaultFileName }
      : filePath
        ? { filePath, mimeType, defaultFileName }
        : null;
    if (!payload) return;
    const result = await hostApi.media.saveImage(payload);
    if (!result?.success) return;
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }, [src, mimeType, defaultFileName]);
  const openPreview = useCallback(() => setPreviewOpen(true), []);
  const handlePreviewKeyDown = useCallback((event: React.KeyboardEvent<HTMLImageElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openPreview();
  }, [openPreview]);
  const closePreview = useCallback(() => setPreviewOpen(false), []);
  const handleReveal = useCallback(async () => {
    if (!part.attachmentFileRef) return;
    try {
      const result = await hostApi.files.revealAttachment(part.attachmentFileRef);
      if (!result.ok) toast.error(t('fileCard.revealFailed'));
    } catch {
      toast.error(t('fileCard.revealFailed'));
    }
  }, [part.attachmentFileRef, t]);

  useEffect(() => {
    if (!previewOpen || !part.attachmentFileRef) {
      setFullSizePreview({ status: 'idle' });
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setFullSizePreview({ status: 'loading' });
    void hostApi.files.readAttachmentBinary({
      ref: part.attachmentFileRef,
      maxBytes: FILE_PREVIEW_MAX_BINARY_BYTES,
    }).then((result) => {
      if (cancelled) return;
      if (!result.ok || !result.data) {
        setFullSizePreview({ status: 'error' });
        return;
      }
      const copiedBytes = new Uint8Array(result.data.byteLength);
      copiedBytes.set(result.data);
      objectUrl = URL.createObjectURL(new Blob([copiedBytes], { type: result.mimeType || mimeType }));
      if (cancelled) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      setFullSizePreview({ status: 'ready', url: objectUrl });
    }).catch(() => {
      if (!cancelled) setFullSizePreview({ status: 'error' });
    });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [mimeType, part.attachmentFileRef, previewOpen]);

  if (!src) {
    return (
      <div
        data-testid="acp-image-part"
        className={cn(
          'flex items-center gap-2 rounded-xl border border-red-500/20 bg-surface-input px-3 py-2 text-sm text-red-700 dark:text-red-400',
          className,
        )}
      >
        <ImageIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{t('acp.unsupportedContent')}</span>
      </div>
    );
  }

  return (
    <figure
      data-testid="acp-image-part"
      data-variant={variant}
      className={cn(
        'group/acp-image relative inline-flex overflow-hidden rounded-xl border border-black/10 bg-black/5 dark:border-white/10 dark:bg-white/10',
        variant === 'thumbnail'
          ? 'aspect-square w-36 max-w-full self-end cursor-zoom-in'
          : 'max-w-full self-start',
        className,
      )}
    >
      <img
        src={src}
        alt={part.alt || t('acp.image')}
        className={cn(
          'block',
          variant === 'thumbnail'
            ? 'h-full w-full object-cover'
            : 'max-h-[420px] max-w-full object-contain',
        )}
        role={variant === 'thumbnail' ? 'button' : undefined}
        tabIndex={variant === 'thumbnail' ? 0 : undefined}
        aria-haspopup={variant === 'thumbnail' ? 'dialog' : undefined}
        onDoubleClick={openPreview}
        onKeyDown={variant === 'thumbnail' ? handlePreviewKeyDown : undefined}
      />
      <div className="absolute bottom-2 right-2 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/acp-image:opacity-100 group-focus-within/acp-image:opacity-100">
        <button
          type="button"
          data-testid="acp-image-copy"
          aria-label={copied ? t('acp.imageCopied') : t('acp.copyImage')}
          title={copied ? t('acp.imageCopied') : t('acp.copyImage')}
          onClick={(event) => void handleCopy(event)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-black/60 text-white shadow-sm transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 dark:bg-white/20 dark:hover:bg-white/30"
        >
          {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
        </button>
        <button
          type="button"
          data-testid="acp-image-save"
          aria-label={saved ? t('acp.imageSaved') : t('acp.saveImage')}
          title={saved ? t('acp.imageSaved') : t('acp.saveImage')}
          onClick={(event) => void handleSave(event)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-black/60 text-white shadow-sm transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 dark:bg-white/20 dark:hover:bg-white/30"
        >
          {saved ? <Check className="h-4 w-4" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
      <Dialog open={previewOpen} onOpenChange={(open) => !open && closePreview()}>
        <DialogContent
          data-testid="acp-image-preview-dialog"
          className="flex h-[min(90vh,900px)] w-[min(96vw,1200px)] max-w-none flex-col overflow-hidden rounded-lg border border-black/10 bg-surface-modal p-0 shadow-2xl dark:border-white/10"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-black/10 px-4 py-3 dark:border-white/10">
            <DialogTitle className="truncate text-sm font-medium">{part.alt || t('acp.image')}</DialogTitle>
            <DialogDescription className="sr-only">{t('acp.imagePreviewDescription')}</DialogDescription>
            <div className="flex shrink-0 items-center gap-1">
              {part.attachmentFileRef && (
                <button
                  type="button"
                  data-testid="acp-image-reveal"
                  aria-label={t('fileCard.showInFileManager')}
                  title={t('fileCard.showInFileManager')}
                  onClick={() => void handleReveal()}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/10"
                >
                  <FolderOpen className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                data-testid="acp-image-preview-close"
                aria-label={t('filePreview.actions.close')}
                title={t('filePreview.actions.close')}
                onClick={closePreview}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/10"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/5 p-4 dark:bg-black/40">
            {part.attachmentFileRef && fullSizePreview.status === 'loading' && (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={t('acp.imageLoading')} />
            )}
            {part.attachmentFileRef && fullSizePreview.status === 'ready' && (
              <img
                data-testid="acp-image-preview-full"
                src={fullSizePreview.url}
                alt={part.alt || t('acp.image')}
                className="max-h-full max-w-full object-contain"
              />
            )}
            {part.attachmentFileRef && fullSizePreview.status === 'error' && (
              <p className="text-sm text-destructive">{t('acp.imagePreviewFailed')}</p>
            )}
            {!part.attachmentFileRef && (
              <img
                data-testid="acp-image-preview-full"
                src={src}
                alt={part.alt || t('acp.image')}
                className="max-h-full max-w-full object-contain"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </figure>
  );
}
