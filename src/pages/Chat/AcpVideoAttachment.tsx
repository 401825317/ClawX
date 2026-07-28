import { useEffect, useState } from 'react';
import { ExternalLink, FolderOpen, Loader2, VideoOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { formatFileSize } from '@/components/file-preview/format';
import type { AttachmentFileRef } from '@/lib/host-api';
import { hostApi } from '@/lib/host-api';

type PlaybackState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; streamId: string; url: string }
  | { key: string; status: 'error' };

export function AcpVideoAttachment({
  attachmentRef,
  name,
  size,
}: {
  attachmentRef: AttachmentFileRef;
  name: string;
  size: number;
}) {
  const { t } = useTranslation('chat');
  const { sessionKey, generation, uri, stagingId, transcriptMessageId } = attachmentRef;
  const playbackKey = JSON.stringify([
    sessionKey,
    generation,
    uri,
    stagingId ?? null,
    transcriptMessageId ?? null,
  ]);
  const [playback, setPlayback] = useState<PlaybackState>({
    key: playbackKey,
    status: 'loading',
  });
  const currentPlayback: PlaybackState = playback.key === playbackKey
    ? playback
    : { key: playbackKey, status: 'loading' };

  useEffect(() => {
    let active = true;
    let streamId: string | undefined;
    const ref = {
      sessionKey,
      generation,
      uri,
      ...(stagingId === undefined ? {} : { stagingId }),
      ...(transcriptMessageId === undefined ? {} : { transcriptMessageId }),
    };

    void hostApi.files.createAttachmentPlayback(ref).then((result) => {
      if (!result.ok) {
        if (active) setPlayback({ key: playbackKey, status: 'error' });
        return;
      }
      streamId = result.streamId;
      if (!active) {
        void hostApi.files.releaseAttachmentPlayback({ streamId });
        return;
      }
      setPlayback({ key: playbackKey, status: 'ready', streamId, url: result.url });
    }).catch(() => {
      if (active) setPlayback({ key: playbackKey, status: 'error' });
    });

    return () => {
      active = false;
      if (streamId) void hostApi.files.releaseAttachmentPlayback({ streamId });
    };
  }, [generation, playbackKey, sessionKey, stagingId, transcriptMessageId, uri]);

  const openVideo = async () => {
    try {
      const result = await hostApi.files.openAttachment(attachmentRef);
      if (!result.ok) toast.error(t('acp.attachment.openFailed'));
    } catch {
      toast.error(t('acp.attachment.openFailed'));
    }
  };

  const revealVideo = async () => {
    try {
      const result = await hostApi.files.revealAttachment(attachmentRef);
      if (!result.ok) toast.error(t('fileCard.revealFailed'));
    } catch {
      toast.error(t('fileCard.revealFailed'));
    }
  };

  const revealLabel = window.electron.platform === 'darwin'
    ? t('fileCard.showInFinder')
    : window.electron.platform === 'win32'
      ? t('fileCard.showInExplorer')
      : t('fileCard.showInFileManager');

  return (
    <figure
      data-testid="acp-video-attachment"
      className="w-full max-w-[560px] overflow-hidden rounded-lg border border-black/10 bg-surface-modal dark:border-white/10"
    >
      <div className="flex aspect-video w-full items-center justify-center bg-black">
        {currentPlayback.status === 'loading' ? (
          <div className="flex items-center gap-2 text-xs text-white/75">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>{t('acp.videoLoading')}</span>
          </div>
        ) : currentPlayback.status === 'ready' ? (
          <video
            data-testid="acp-video-player"
            src={currentPlayback.url}
            controls
            playsInline
            preload="metadata"
            className="h-full w-full object-contain"
            onError={() => setPlayback({ key: playbackKey, status: 'error' })}
          >
            {t('acp.videoLoadFailed')}
          </video>
        ) : (
          <div className="flex items-center gap-2 px-4 text-xs text-white/75">
            <VideoOff className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t('acp.videoLoadFailed')}</span>
          </div>
        )}
      </div>
      <figcaption className="flex min-w-0 items-center gap-2 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-foreground">{name}</span>
          {size > 0 ? (
            <span className="block text-2xs text-muted-foreground">{formatFileSize(size)}</span>
          ) : null}
        </span>
        <button
          type="button"
          data-testid="acp-video-reveal"
          aria-label={revealLabel}
          title={revealLabel}
          onClick={() => void revealVideo()}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/10"
        >
          <FolderOpen className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid="acp-video-open"
          aria-label={t('acp.attachment.open', { name })}
          title={t('acp.attachment.open', { name })}
          onClick={() => void openVideo()}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/10"
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </button>
      </figcaption>
    </figure>
  );
}
