import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ListTree, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { toast } from 'sonner';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { buildPreviewTarget } from '@/components/file-preview/build-preview-target';
import type { FilePreviewTarget } from '@/components/file-preview/types';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { invokeIpc } from '@/lib/api-client';
import { DEFAULT_AGENT_AVATAR_SRC, getAgentAvatar } from '@/lib/agent-avatars';
import { isHtmlPreviewExt, type GeneratedFile } from '@/lib/generated-files';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/stores/agents';
import { useArtifactPanel } from '@/stores/artifact-panel';
import { useChatStore, type AttachedFileMeta } from '@/stores/chat';
import { selectLatestRecoverableErrorTurnId } from '@/stores/conversation/control-selectors';
import { useConversationStore } from '@/stores/conversation/store';
import { snapshotToRawMessage } from '@/stores/conversation/history-adapter';
import { isActiveTurnStatus } from '@/stores/conversation/types';
import { useGatewayStore } from '@/stores/gateway';
import { ChatInput, type ImageEditReference } from './ChatInput';
import { ChatToolbar } from './ChatToolbar';
import { extractText } from './message-utils';
import {
  ConversationTimeline,
  type ConversationTimelineHandle,
} from './timeline/ConversationTimeline';

const ArtifactPanelLazy = lazy(() =>
  import('@/components/file-preview/ArtifactPanel').then((module) => ({ default: module.ArtifactPanel })),
);
const PanelResizeDividerLazy = lazy(() =>
  import('@/components/file-preview/PanelResizeDivider').then((module) => ({ default: module.PanelResizeDivider })),
);
const EMPTY_GENERATED_FILES: GeneratedFile[] = [];

function generatedFileToTarget(file: GeneratedFile): FilePreviewTarget {
  return {
    filePath: file.filePath,
    fileName: file.fileName,
    ext: file.ext,
    mimeType: file.mimeType,
    contentType: file.contentType,
    action: file.action,
    fullContent: file.fullContent,
    baseline: file.baseline,
    edits: file.edits,
  };
}

function TimelineWelcome() {
  const { t } = useTranslation('chat');
  return (
    <div className="flex h-[60vh] flex-col items-center justify-center text-center">
      <h1 className="mb-8 font-serif text-4xl font-normal tracking-tight text-foreground/80 md:text-5xl">
        {t('welcome.subtitle')}
      </h1>
      <div className="flex w-full max-w-lg flex-wrap items-center justify-center gap-2.5">
        {['askQuestions', 'creativeTasks', 'brainstorming'].map((key) => (
          <span key={key} className="rounded-full border border-black/10 bg-black/[0.02] px-4 py-1.5 text-meta font-medium text-foreground/70 dark:border-white/10">
            {t(`welcome.${key}`)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function TimelineChatPage() {
  const { t } = useTranslation('chat');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const isGatewayRunning = gatewayStatus.state === 'running';
  const currentSessionKey = useChatStore((state) => state.currentSessionKey);
  const currentAgentId = useChatStore((state) => state.currentAgentId);
  const sessions = useChatStore((state) => state.sessions);
  const historyError = useChatStore((state) => state.historyError);
  const loading = useChatStore((state) => state.loading);
  const loadingMoreHistory = useChatStore((state) => state.loadingMoreHistory);
  const hasMoreHistory = useChatStore((state) => state.hasMoreHistory);
  const loadMoreHistory = useChatStore((state) => state.loadMoreHistory);
  const loadHistory = useChatStore((state) => state.loadHistory);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const abortRun = useChatStore((state) => state.abortRun);
  const retryLastRun = useChatStore((state) => state.retryLastRun);
  const clearHistoryError = useChatStore((state) => state.clearHistoryError);
  const cleanupEmptySession = useChatStore((state) => state.cleanupEmptySession);
  const agents = useAgentsStore((state) => state.agents);
  const fetchAgents = useAgentsStore((state) => state.fetchAgents);
  const currentAgent = agents.find((agent) => agent.id === currentAgentId) ?? null;
  const currentSession = sessions.find((session) => session.key === currentSessionKey);
  const currentWorkspace = currentSession?.cwd || currentAgent?.workspace || '';
  const avatar = currentAgent?.profile?.avatarId
    ? getAgentAvatar(currentAgent.profile.avatarId).src
    : DEFAULT_AGENT_AVATAR_SRC;
  const turnIds = useConversationStore(useShallow((state) => state.turnOrderBySession[currentSessionKey] ?? []));
  const retryableTurnId = useConversationStore((state) => (
    selectLatestRecoverableErrorTurnId(state, currentSessionKey)
  ));
  const timelineActivity = useConversationStore(useShallow((state) => {
    const activeTurnId = state.aliases.activeBySession[currentSessionKey]
      ?? state.aliases.pendingLocalBySession[currentSessionKey];
    const activeTurn = activeTurnId ? state.turnsById[activeTurnId] : undefined;
    const sessionTurnIds = state.turnOrderBySession[currentSessionKey] ?? [];
    const latestTurnId = sessionTurnIds[sessionTurnIds.length - 1];
    const latestTurn = latestTurnId ? state.turnsById[latestTurnId] : undefined;
    const busy = isActiveTurnStatus(activeTurn?.status);
    return {
      busy,
      latestTurnStartedAt: latestTurn?.createdAt ?? null,
      refreshSignal: busy ? undefined : latestTurn?.updatedAt ?? 0,
    };
  }));
  const directory = useMemo(() => turnIds.map((turnId) => {
    const turn = useConversationStore.getState().turnsById[turnId];
    return {
      turnId,
      title: turn ? extractText(snapshotToRawMessage(turn.trigger.message)).trim() : '',
    };
  }), [turnIds]);
  const panelOpen = useArtifactPanel((state) => state.open);
  const allGeneratedFiles = useConversationStore(useShallow((state) => {
    if (!panelOpen) return EMPTY_GENERATED_FILES;
    return turnIds.flatMap((turnId) => (
      state.turnsById[turnId]?.items.flatMap((item) => item.kind === 'artifact-group' ? item.changes : []) ?? []
    ));
  })) as GeneratedFile[];
  const panelWidthPct = useArtifactPanel((state) => state.widthPct);
  const openChanges = useArtifactPanel((state) => state.openChanges);
  const openPreview = useArtifactPanel((state) => state.openPreview);
  const closeArtifactPanel = useArtifactPanel((state) => state.close);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<ConversationTimelineHandle | null>(null);
  const [imageEditReferenceBySession, setImageEditReferenceBySession] = useState<Record<string, ImageEditReference>>({});
  const [directoryOpenBySession, setDirectoryOpenBySession] = useState<Record<string, true>>({});
  const [compactViewport, setCompactViewport] = useState(() => window.matchMedia('(max-width: 1023px)').matches);
  const imageEditReference = imageEditReferenceBySession[currentSessionKey] ?? null;
  const directoryOpen = Boolean(directoryOpenBySession[currentSessionKey]);
  const directoryVisible = directoryOpen && directory.length > 1;
  const platform = window.electron?.platform;
  const isMac = platform === 'darwin';
  const isWindows = platform === 'win32';

  useEffect(() => () => cleanupEmptySession(), [cleanupEmptySession]);
  useEffect(() => {
    if (!isGatewayRunning) return;
    const hasTimeline = (useConversationStore.getState().turnOrderBySession[currentSessionKey]?.length ?? 0) > 0;
    void loadHistory(hasTimeline);
  }, [currentSessionKey, isGatewayRunning, loadHistory]);
  useEffect(() => {
    if (agents.length > 0) return;
    const timer = window.setTimeout(() => void fetchAgents({ quiet: true }), 750);
    return () => window.clearTimeout(timer);
  }, [agents.length, fetchAgents]);
  useEffect(() => {
    closeArtifactPanel();
  }, [closeArtifactPanel, currentSessionKey]);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1023px)');
    const handleChange = (event: MediaQueryListEvent) => setCompactViewport(event.matches);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  const setImageEditReference = useCallback((reference: ImageEditReference | null) => {
    setImageEditReferenceBySession((current) => {
      if (reference) return { ...current, [currentSessionKey]: reference };
      if (!(currentSessionKey in current)) return current;
      const next = { ...current };
      delete next[currentSessionKey];
      return next;
    });
  }, [currentSessionKey]);

  const toggleDirectory = useCallback(() => {
    setDirectoryOpenBySession((current) => {
      if (!current[currentSessionKey]) return { ...current, [currentSessionKey]: true };
      const next = { ...current };
      delete next[currentSessionKey];
      return next;
    });
  }, [currentSessionKey]);

  const closeDirectory = useCallback(() => {
    setDirectoryOpenBySession((current) => {
      if (!(currentSessionKey in current)) return current;
      const next = { ...current };
      delete next[currentSessionKey];
      return next;
    });
  }, [currentSessionKey]);

  const jumpToDirectoryTurn = useCallback((turnId: string, closeAfterJump = false) => {
    timelineRef.current?.scrollToTurn(turnId);
    if (closeAfterJump) closeDirectory();
  }, [closeDirectory]);

  const handleOpenAttachedFile = useCallback((file: AttachedFileMeta) => {
    const targetPath = file.filePath || file.gatewayUrl;
    if (!targetPath) return;
    if (/^https?:\/\//iu.test(targetPath)) {
      void invokeIpc('shell:openExternal', targetPath);
      return;
    }
    if (file.mimeType === 'application/x-directory') {
      void invokeIpc<string>('shell:openPath', targetPath).then((message) => {
        if (message) toast.error(message);
      });
      return;
    }
    openPreview(buildPreviewTarget(targetPath, file.fileName, file.fileSize));
  }, [openPreview]);

  const handleUseImageAsReference = useCallback((file: AttachedFileMeta) => {
    if (!file.filePath || !file.mimeType.startsWith('image/')) return;
    setImageEditReference({
      fileName: file.fileName,
      mimeType: file.mimeType,
      fileSize: file.fileSize,
      filePath: file.filePath,
      preview: file.preview,
    });
  }, [setImageEditReference]);

  const handleOpenGeneratedFile = useCallback((file: GeneratedFile) => {
    const target = generatedFileToTarget(file);
    if (isHtmlPreviewExt(file.ext)) openPreview(target);
    else openChanges(target);
  }, [openChanges, openPreview]);

  const handleRetryTurn = useCallback(async (turnId: string): Promise<void> => {
    if (selectLatestRecoverableErrorTurnId(useConversationStore.getState(), currentSessionKey) !== turnId) return;
    try {
      await retryLastRun();
    } catch {
      toast.error(t('runError.retryUnavailable'));
      return;
    }
    const retryError = useChatStore.getState().runError;
    if (retryError === t('runError.retryUnavailable')) toast.error(retryError);
  }, [currentSessionKey, retryLastRun, t]);

  return (
    <div
      ref={splitContainerRef}
      data-testid="chat-page"
      data-timeline-mode="timeline"
      className={cn(
        'relative -m-6 flex min-h-0 overflow-hidden bg-background transition-colors duration-500',
        isMac && 'z-20 rounded-tl-2xl shadow-[inset_1px_1px_0_hsl(var(--border)/0.55)]',
        isWindows && 'rounded-tl-2xl',
      )}
      style={{ height: isMac ? '100vh' : 'calc(100vh - 2.5rem)' }}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative flex shrink-0 items-center justify-end px-4 py-2">
          <div data-testid="chat-toolbar-drag-region" className="drag-region absolute inset-0 z-0" aria-hidden="true" />
          <div data-testid="chat-toolbar-actions" className="no-drag relative z-10">
            <ChatToolbar
              runActive={timelineActivity.busy}
              questionDirectoryOpen={directoryVisible}
              questionDirectoryCount={directory.length}
              onToggleQuestionDirectory={toggleDirectory}
            />
          </div>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden px-4 py-4">
          <div className="mx-auto flex h-full min-h-0 w-full max-w-7xl gap-4">
            <div className="min-h-0 min-w-0 flex-1">
              <ConversationTimeline
                ref={timelineRef}
                sessionKey={currentSessionKey}
                assistantAvatarSrc={avatar}
                hasMoreHistory={hasMoreHistory}
                loadingMoreHistory={loadingMoreHistory}
                loadMoreHistory={loadMoreHistory}
                onOpenFile={handleOpenAttachedFile}
                onUseImageAsReference={handleUseImageAsReference}
                onOpenGeneratedFile={handleOpenGeneratedFile}
                retryableTurnId={retryableTurnId}
                onRetryTurn={handleRetryTurn}
                emptyState={<TimelineWelcome />}
              />
            </div>
            {!compactViewport && directoryVisible && (
              <aside
                id="chat-question-directory"
                className="w-64 shrink-0"
                data-testid="chat-question-directory"
                aria-label={t('questionDirectory.title')}
              >
                <div className="max-h-full overflow-hidden border-l border-border/70 pl-3">
                  <div className="mb-1 flex items-center justify-between gap-2 px-2 py-1">
                    <h2 className="text-xs font-medium text-foreground/75">{t('questionDirectory.title')}</h2>
                    <span className="text-2xs text-muted-foreground">{directory.length}</span>
                  </div>
                  <nav className="max-h-[calc(100vh-10rem)] overflow-y-auto">
                    {directory.map((entry, index) => (
                      <button
                        key={entry.turnId}
                        type="button"
                        onClick={() => jumpToDirectoryTurn(entry.turnId)}
                        className="block w-full rounded-md px-2 py-2 text-left text-xs leading-5 text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                        data-testid={`chat-question-directory-item-${index}`}
                      >
                        <span className="line-clamp-2">{entry.title || t('questionDirectory.title')}</span>
                      </button>
                    ))}
                  </nav>
                </div>
              </aside>
            )}
          </div>
          {loading && turnIds.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/20">
              <LoadingSpinner size="md" />
            </div>
          )}
        </div>
        {compactViewport && (
          <Sheet
            open={directoryVisible}
            onOpenChange={(open) => {
              if (!open) closeDirectory();
            }}
          >
            <SheetContent
              id="chat-question-directory"
              side="right"
              className="flex w-[min(88vw,22rem)] flex-col gap-0 p-0 sm:max-w-none"
              data-testid="chat-question-directory"
              aria-label={t('questionDirectory.title')}
            >
              <SheetHeader className="flex-row items-center justify-between border-b border-border/70 px-4 py-3 text-left">
                <div className="flex min-w-0 items-center gap-2">
                  <ListTree className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <SheetTitle className="truncate text-sm font-medium">{t('questionDirectory.title')}</SheetTitle>
                  <span className="text-2xs text-muted-foreground">{directory.length}</span>
                </div>
                <SheetClose asChild>
                  <button
                    type="button"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                    aria-label={t('common:actions.close')}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </SheetClose>
              </SheetHeader>
              <nav className="min-h-0 flex-1 overflow-y-auto p-2">
                {directory.map((entry, index) => (
                  <button
                    key={entry.turnId}
                    type="button"
                    onClick={() => jumpToDirectoryTurn(entry.turnId, true)}
                    className="block w-full rounded-md px-3 py-2.5 text-left text-sm leading-5 text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                    data-testid={`chat-question-directory-item-${index}`}
                  >
                    <span className="line-clamp-2">{entry.title || t('questionDirectory.title')}</span>
                  </button>
                ))}
              </nav>
            </SheetContent>
          </Sheet>
        )}
        {historyError && (
          <div className="border-t border-destructive/20 bg-destructive/10 px-4 py-2">
            <div className="mx-auto flex max-w-4xl items-center justify-between gap-3" data-testid="chat-history-error">
              <p className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{historyError}</p>
              <div className="flex shrink-0 items-center gap-3">
                <button type="button" onClick={() => void loadHistory()} className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive hover:underline">
                  <RotateCcw className="h-3.5 w-3.5" />{t('runError.retry')}
                </button>
                <button type="button" onClick={clearHistoryError} className="text-xs text-destructive/60 underline hover:text-destructive">{t('common:actions.dismiss')}</button>
              </div>
            </div>
          </div>
        )}
        <ChatInput
          onSend={sendMessage}
          onStop={abortRun}
          disabled={!isGatewayRunning}
          sending={timelineActivity.busy}
          imageEditReference={imageEditReference}
          onClearImageEditReference={() => setImageEditReference(null)}
        />
      </div>
      {panelOpen && (
        <>
          <Suspense fallback={null}><PanelResizeDividerLazy containerRef={splitContainerRef} /></Suspense>
          <aside
            data-testid="artifact-panel-aside"
            className={cn('relative z-20 hidden shrink-0 border-l border-black/5 dark:border-white/10 lg:flex lg:flex-col', isMac && 'no-drag')}
            style={{ width: `${panelWidthPct}%` }}
          >
            <Suspense fallback={<div className="flex h-full items-center justify-center"><LoadingSpinner size="md" /></div>}>
              <ArtifactPanelLazy
                files={allGeneratedFiles}
                agent={currentAgent}
                workspace={currentWorkspace}
                runStartedAt={timelineActivity.latestTurnStartedAt}
                refreshSignal={timelineActivity.refreshSignal}
              />
            </Suspense>
          </aside>
        </>
      )}
    </div>
  );
}
