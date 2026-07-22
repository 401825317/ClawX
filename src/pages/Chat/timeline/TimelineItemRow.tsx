import { memo, useMemo, useState } from 'react';
import {
  AlertCircle,
  Activity,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  ClipboardCheck,
  CircleStop,
  FileCheck2,
  GitBranch,
  Loader2,
  RotateCcw,
  Search,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import type { GeneratedFile } from '@/lib/generated-files';
import { sanitizeRuntimeDisplayText, stringifyRuntimeDisplayValue } from '@/lib/runtime-display-sanitizer';
import { cn } from '@/lib/utils';
import { GeneratedFilesPanel } from '@/components/file-preview/GeneratedFilesPanel';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { ChatMessage } from '../ChatMessage';
import { resolveTimelineApproval } from '@/lib/approval-actions';
import { snapshotToRawMessage } from '@/stores/conversation/history-adapter';
import { useConversationStore } from '@/stores/conversation/store';
import { recordTimelineItemRender } from '@/stores/conversation/metrics';
import type { AttachedFileMeta } from '@/stores/chat';
import type { ApprovalItem, SubtaskItem, TimelineItem, ToolCategory, ToolGroupItem } from '@/stores/conversation/types';
import { projectArtifactOwnedFinalMessage } from './media-ownership';
import { TimelineMarkdown } from './TimelineMarkdown';

interface TimelineItemRowProps {
  turnId: string;
  itemId: string;
  assistantAvatarSrc?: string | null;
  onOpenFile?: (file: AttachedFileMeta) => void;
  onUseImageAsReference?: (file: AttachedFileMeta) => void;
  onOpenGeneratedFile?: (file: GeneratedFile) => void;
  showExecutionDetails?: boolean;
  onOpenExecutionDetails?: (turnId: string) => void;
  retryable?: boolean;
  onRetryTurn?: (turnId: string) => Promise<void> | void;
}

function categoryIcon(category: ToolCategory, running: boolean) {
  if (running) return <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />;
  if (category === 'read' || category === 'search') return <Search className="h-3.5 w-3.5" aria-hidden="true" />;
  if (category === 'command') return <Terminal className="h-3.5 w-3.5" aria-hidden="true" />;
  if (category === 'edit') return <FileCheck2 className="h-3.5 w-3.5" aria-hidden="true" />;
  if (category === 'subagent') return <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />;
  return <Wrench className="h-3.5 w-3.5" aria-hidden="true" />;
}

function ToolGroupBlock({ item }: { item: ToolGroupItem }) {
  const { t } = useTranslation('chat');
  const expanded = useConversationStore((state) => Boolean(state.expandedItemIds[item.id]));
  const setItemExpanded = useConversationStore((state) => state.setItemExpanded);
  const running = item.status === 'running';
  const terminalInternalFailure = item.status === 'error';

  return (
    <section className="ml-1 border-l border-border/70 pl-4" data-testid="timeline-tool-group" data-status={item.status}>
      <div className="flex min-h-8 items-center">
        <button
          type="button"
          className="group flex min-w-0 items-center gap-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => {
            if (!terminalInternalFailure) setItemExpanded(item.id, !expanded);
          }}
          aria-expanded={terminalInternalFailure ? undefined : expanded}
          data-testid="timeline-tool-group-toggle"
        >
          <span className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center',
            terminalInternalFailure && 'text-red-700 dark:text-red-400',
          )}>
            {terminalInternalFailure
              ? <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
              : categoryIcon(item.category, running)}
          </span>
          <span className="min-w-0 truncate font-medium">
            {terminalInternalFailure
              ? t('timeline.outcome.failed')
              : t(item.summaryKey, {
                  ...item.summaryParams,
                  category: t(`timeline.toolCategory.${item.category}`),
                })}
          </span>
          {!terminalInternalFailure && (
            <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
          )}
        </button>
      </div>
      {expanded && !terminalInternalFailure && (
        <div className="space-y-2 pb-2 pt-1" data-testid="timeline-tool-details">
          {item.entries.map((entry) => {
            const input = stringifyRuntimeDisplayValue(entry.args);
            const output = stringifyRuntimeDisplayValue(entry.result ?? entry.partialResult);
            return (
              <div key={entry.toolCallId} className="rounded-md bg-surface-input px-3 py-2">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate font-medium text-foreground/80">{entry.name}</span>
                  <span className={cn(
                    'shrink-0 text-2xs text-muted-foreground',
                    entry.status === 'error' && 'text-red-700 dark:text-red-400',
                  )}>
                    {t(`timeline.toolStatus.${entry.status}`)}
                    {entry.durationMs != null ? ` · ${Math.max(0, entry.durationMs / 1000).toFixed(1)}s` : ''}
                  </span>
                </div>
                {(input || output) && (
                  <div className="mt-1.5 space-y-2">
                    {input && (
                      <div>
                        <div className="text-2xs font-medium text-foreground/60">{t('timeline.toolInput')}</div>
                        <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-words text-2xs leading-5 text-muted-foreground">{input}</pre>
                      </div>
                    )}
                    {output && (
                      <div>
                        <div className="text-2xs font-medium text-foreground/60">{t('timeline.toolOutput')}</div>
                        <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-words text-2xs leading-5 text-muted-foreground">{output}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SubtaskBlock({ item }: { item: SubtaskItem }) {
  const { t } = useTranslation('chat');
  const expanded = useConversationStore((state) => Boolean(state.expandedItemIds[item.id]));
  const setItemExpanded = useConversationStore((state) => state.setItemExpanded);
  const running = item.status === 'running';
  const terminalInternalFailure = item.status === 'error';

  return (
    <section className="ml-1 border-l border-border/70 pl-4" data-testid="timeline-subtasks" data-status={item.status}>
      <div className="flex min-h-8 items-center">
        <button
          type="button"
          className="group flex min-w-0 items-center gap-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => {
            if (!terminalInternalFailure) setItemExpanded(item.id, !expanded);
          }}
          aria-expanded={terminalInternalFailure ? undefined : expanded}
          data-testid="timeline-subtasks-toggle"
        >
          <span className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center',
            terminalInternalFailure && 'text-red-700 dark:text-red-400',
            item.status === 'aborted' && 'text-muted-foreground',
          )}>
            {running
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              : terminalInternalFailure
                ? <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                : item.status === 'aborted'
                  ? <CircleStop className="h-3.5 w-3.5" aria-hidden="true" />
                : <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />}
          </span>
          <span className="min-w-0 truncate font-medium">
            {terminalInternalFailure ? t('timeline.outcome.failed') : t(item.summaryKey, item.summaryParams)}
          </span>
          {!terminalInternalFailure && (
            <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
          )}
        </button>
      </div>
      {expanded && !terminalInternalFailure && (
        <div className="space-y-2 pb-2 pt-1" data-testid="timeline-subtask-details">
          {item.tasks.map((task) => {
            const detail = stringifyRuntimeDisplayValue(task.detail ?? task.terminalOutcome ?? task.deliveryStatus);
            return (
              <div key={task.taskId} className="rounded-md bg-surface-input px-3 py-2">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate font-medium text-foreground/80">{task.title}</span>
                  <span className={cn(
                    'shrink-0 text-2xs text-muted-foreground',
                    (task.status === 'error' || task.status === 'partial') && 'text-red-700 dark:text-red-400',
                    task.status === 'aborted' && 'text-muted-foreground',
                  )}>
                    {t(`timeline.subtaskStatus.${task.status}`)}
                  </span>
                </div>
                {detail && <p className="mt-1.5 whitespace-pre-wrap break-words text-2xs leading-5 text-muted-foreground">{detail}</p>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ApprovalBlock({ item }: { item: ApprovalItem }) {
  const { t } = useTranslation('chat');
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = item.status === 'blocked';
  const failed = item.status === 'error';
  const stopped = item.status === 'aborted';
  const normalizedStatus = (item.decision ?? item.approvalStatus)?.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_');
  const statusLabel = normalizedStatus
    ? t(`timeline.approvalStatus.${normalizedStatus}`, { defaultValue: item.decision ?? item.approvalStatus })
    : pending
      ? t('timeline.approvalStatus.pending')
      : failed
        ? t('timeline.approvalStatus.cancelled')
        : t('timeline.approvalStatus.completed');
  const actionable = pending
    && item.actionable
    && Boolean(item.approvalId)
    && (item.approvalKind === 'exec' || item.approvalKind === 'plugin' || item.approvalKind === 'desktop');

  const submit = async (decision: ApprovalItem['allowedDecisions'][number]): Promise<void> => {
    if (!actionable || !item.approvalId || !item.approvalKind || submitting) return;
    setSubmitting(decision);
    setError(null);
    try {
      await resolveTimelineApproval({
        approvalId: item.approvalId,
        approvalKind: item.approvalKind,
        decision,
      });
    } catch (approvalError) {
      void approvalError;
      setError(t('timeline.approvalActionFailed'));
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <section
      className={cn(
        'rounded-md border px-3 py-2',
        pending && 'border-yellow-500/20 bg-yellow-500/10',
        failed && 'border-red-500/20 bg-red-500/10',
        stopped && 'border-border bg-surface-input',
        !pending && !failed && !stopped && 'border-green-500/20 bg-green-500/10',
      )}
      data-testid="timeline-approval"
      data-status={item.status}
      data-approval-id={item.approvalId}
    >
      <div className={cn(
        'flex items-center gap-2 text-sm font-medium',
        pending && 'text-yellow-700 dark:text-yellow-400',
        failed && 'text-red-700 dark:text-red-400',
        stopped && 'text-muted-foreground',
        !pending && !failed && !stopped && 'text-green-700 dark:text-green-400',
      )}>
        {stopped
          ? <CircleStop className="h-4 w-4" aria-hidden="true" />
          : pending || failed
            ? <AlertCircle className="h-4 w-4" aria-hidden="true" />
            : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
        <span className="min-w-0 flex-1">{item.title || t('timeline.approval')}</span>
        <span className="shrink-0 text-2xs font-normal opacity-80">{statusLabel}</span>
      </div>
      {item.message && <p className="mt-1 text-xs text-muted-foreground">{item.message}</p>}
      {actionable && (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {item.allowedDecisions.includes('allow-once') && (
            <Button
              size="sm"
              onClick={() => void submit('allow-once')}
              disabled={Boolean(submitting)}
              data-testid="timeline-approval-allow-once"
            >
              {submitting === 'allow-once' && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {t('timeline.approvalActions.allowOnce')}
            </Button>
          )}
          {item.allowedDecisions.includes('allow-always') && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void submit('allow-always')}
              disabled={Boolean(submitting)}
              data-testid="timeline-approval-allow-always"
            >
              {submitting === 'allow-always' && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {t('timeline.approvalActions.allowAlways')}
            </Button>
          )}
          {item.allowedDecisions.includes('deny') && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void submit('deny')}
              disabled={Boolean(submitting)}
              data-testid="timeline-approval-deny"
            >
              <X className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('timeline.approvalActions.deny')}
            </Button>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-700 dark:text-red-400" role="alert" data-testid="timeline-approval-error">{error}</p>}
    </section>
  );
}

function ArtifactBlock({
  item,
  assistantAvatarSrc,
  onOpenFile,
  onUseImageAsReference,
  onOpenGeneratedFile,
}: {
  item: Extract<TimelineItem, { kind: 'artifact-group' }>;
  assistantAvatarSrc?: string | null;
  onOpenFile?: (file: AttachedFileMeta) => void;
  onUseImageAsReference?: (file: AttachedFileMeta) => void;
  onOpenGeneratedFile?: (file: GeneratedFile) => void;
}) {
  const { t } = useTranslation('chat');
  const changedPaths = new Set(item.changes.map((change) => change.filePath));
  const unavailableArtifacts = item.artifacts.filter((artifact) => (
    artifact.availability === 'unavailable' || artifact.availability === 'error'
  ));
  const attachments: AttachedFileMeta[] = item.artifacts
    .filter((artifact) => (
      artifact.availability !== 'unavailable'
      && artifact.availability !== 'error'
      && (!artifact.filePath || !changedPaths.has(artifact.filePath))
    ))
    .map((artifact) => ({
      fileName: artifact.title || artifact.filePath?.split(/[\\/]/u).pop() || artifact.id,
      mimeType: artifact.mimeType || 'application/octet-stream',
      fileSize: artifact.sizeBytes ?? 0,
      preview: artifact.preview ?? null,
      previewStatus: artifact.previewStatus,
      availability: artifact.availability,
      error: artifact.error,
      width: artifact.width,
      height: artifact.height,
      durationSeconds: artifact.durationSeconds,
      hasAudio: artifact.hasAudio,
      filePath: artifact.filePath,
      gatewayUrl: artifact.url,
      source: 'tool-result',
      disposition: 'output-delivery',
    }));
  return (
    <div className="space-y-3" data-testid="timeline-artifacts">
      {item.changes.length > 0 && onOpenGeneratedFile && (
        <GeneratedFilesPanel files={item.changes as GeneratedFile[]} onOpen={onOpenGeneratedFile} />
      )}
      {attachments.length > 0 && (
        <ChatMessage
          message={{ role: 'assistant', content: '', _attachedFiles: attachments, id: item.id, timestamp: item.updatedAt }}
          assistantAvatarSrc={assistantAvatarSrc}
          onOpenFile={onOpenFile}
          onUseImageAsReference={onUseImageAsReference}
        />
      )}
      {unavailableArtifacts.map((artifact) => {
        const status = artifact.availability === 'error' ? 'error' : 'unavailable';
        return (
          <div
            key={`artifact-status:${artifact.id}`}
            className={cn(
              'flex items-start gap-2 border px-3 py-2 text-xs',
              status === 'error'
                ? 'border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-400'
                : 'border-yellow-500/20 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
            )}
            data-testid="timeline-artifact-status"
            data-status={status}
          >
            {status === 'error'
              ? <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              : <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
            <span className="min-w-0">
              <span className="font-medium">{artifact.title || artifact.filePath?.split(/[\\/]/u).pop() || artifact.id}</span>
              <span className="ml-2 opacity-80">
                {t(`timeline.artifactStatus.${status}`)}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FinalAnswerBlock({
  item,
  assistantAvatarSrc,
  onOpenFile,
  onUseImageAsReference,
}: {
  item: Extract<TimelineItem, { kind: 'final-answer' }>;
  assistantAvatarSrc?: string | null;
  onOpenFile?: (file: AttachedFileMeta) => void;
  onUseImageAsReference?: (file: AttachedFileMeta) => void;
}) {
  const artifactGroups = useConversationStore(useShallow((state) => {
    const turn = state.turnsById[item.turnId];
    if (!turn) return [];
    return turn.items.filter((candidate): candidate is Extract<TimelineItem, { kind: 'artifact-group' }> => (
      candidate.kind === 'artifact-group'
    ));
  }));
  const message = useMemo(() => snapshotToRawMessage(
    projectArtifactOwnedFinalMessage(item.message, artifactGroups),
  ), [artifactGroups, item.message]);

  return (
    <ChatMessage
      message={message}
      assistantAvatarSrc={assistantAvatarSrc}
      isStreaming={item.status === 'running'}
      onOpenFile={onOpenFile}
      onUseImageAsReference={onUseImageAsReference}
    />
  );
}

function ErrorBlock({
  item,
  retryable,
  onRetryTurn,
}: {
  item: Extract<TimelineItem, { kind: 'error' }>;
  retryable?: boolean;
  onRetryTurn?: (turnId: string) => Promise<void> | void;
}) {
  const { t } = useTranslation('chat');
  const [retrying, setRetrying] = useState(false);
  const canRetry = item.recoverable && retryable && Boolean(onRetryTurn);
  const message = canRetry ? t('timeline.outcome.retryableFailure') : t('timeline.outcome.failed');

  const retry = async (): Promise<void> => {
    if (!canRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetryTurn?.(item.turnId);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <section
      className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400"
      data-testid="timeline-error"
      data-recoverable={item.recoverable ? 'true' : 'false'}
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words">{message}</span>
      </div>
      {canRetry && (
        <button
          type="button"
          onClick={() => void retry()}
          disabled={retrying}
          className="mt-2 inline-flex min-h-7 items-center gap-1.5 text-xs font-medium hover:underline disabled:cursor-wait disabled:opacity-60"
          data-testid="timeline-error-retry"
          data-turn-id={item.turnId}
          aria-label={t('runError.retry')}
        >
          {retrying
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            : <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
          <span>{t('runError.retry')}</span>
        </button>
      )}
    </section>
  );
}

function ItemContent(props: TimelineItemRowProps & { item: TimelineItem }) {
  const { item, assistantAvatarSrc, onOpenFile, onUseImageAsReference, onOpenGeneratedFile } = props;
  const { t } = useTranslation('chat');
  const expanded = useConversationStore((state) => Boolean(state.expandedItemIds[item.id]));
  const setItemExpanded = useConversationStore((state) => state.setItemExpanded);

  switch (item.kind) {
    case 'user-message':
      return <ChatMessage message={snapshotToRawMessage(item.message)} onOpenFile={onOpenFile} onUseImageAsReference={onUseImageAsReference} />;
    case 'final-answer':
      return (
        <FinalAnswerBlock
          item={item}
          assistantAvatarSrc={assistantAvatarSrc}
          onOpenFile={onOpenFile}
          onUseImageAsReference={onUseImageAsReference}
        />
      );
    case 'commentary': {
      const text = item.translationKey
        ? t(item.translationKey, { ...item.translationParams, defaultValue: item.text })
        : item.text;
      return (
        <section className="ml-1 border-l border-foreground/15 pl-4" data-testid="timeline-commentary">
          {item.status === 'running'
            ? <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{text}</p>
            : <TimelineMarkdown text={text} />}
        </section>
      );
    }
    case 'thinking':
      return (
        <section className="ml-1 border-l border-border/70 pl-4" data-testid="timeline-thinking">
          <button
            type="button"
            onClick={() => setItemExpanded(item.id, !expanded)}
            className="flex min-h-7 items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
          >
            <CircleDashed className={cn('h-3.5 w-3.5', item.status === 'running' && 'animate-spin')} aria-hidden="true" />
            <span className="font-medium">{item.status === 'running' ? t('reasoning.live') : t('reasoning.title')}</span>
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
          </button>
          {expanded && (
            <div className="pb-1 pt-1.5 text-xs leading-5 text-muted-foreground whitespace-pre-wrap break-words">
              {sanitizeRuntimeDisplayText(item.text)}
            </div>
          )}
        </section>
      );
    case 'tool-group':
      return <ToolGroupBlock item={item} />;
    case 'subtask':
      return <SubtaskBlock item={item} />;
    case 'plan':
      return (
        <section className="ml-1 border-l border-border/70 pl-4" data-testid="timeline-plan">
          <button
            type="button"
            onClick={() => setItemExpanded(item.id, !expanded)}
            className="flex min-h-7 items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
          >
            <ClipboardCheck className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="font-medium">{item.summary || item.objective || t('timeline.plan')}</span>
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
          </button>
          {expanded && (
            <ol className="space-y-1 pb-2 pt-1 text-xs text-muted-foreground">
              {item.steps.map((step) => <li key={step.id}>{step.title}</li>)}
            </ol>
          )}
        </section>
      );
    case 'approval':
      return <ApprovalBlock item={item} />;
    case 'artifact-group':
      return (
        <ArtifactBlock
          item={item}
          assistantAvatarSrc={assistantAvatarSrc}
          onOpenFile={onOpenFile}
          onUseImageAsReference={onUseImageAsReference}
          onOpenGeneratedFile={onOpenGeneratedFile}
        />
      );
    case 'verification-summary': {
      return (
        <section
          className="ml-1 flex items-start gap-2 border-l border-red-500/30 pl-4 text-xs text-red-700 dark:text-red-400"
          data-testid="timeline-verification"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5" />
          <span>{t('timeline.outcome.resultUnavailable')}</span>
        </section>
      );
    }
    case 'error':
      return <ErrorBlock item={item} retryable={props.retryable} onRetryTurn={props.onRetryTurn} />;
  }
}

export const TimelineItemRow = memo(function TimelineItemRow(props: TimelineItemRowProps) {
  recordTimelineItemRender(props.turnId, props.itemId);
  const { t } = useTranslation('chat');
  const item = useConversationStore((state) => {
    const turn = state.turnsById[props.turnId];
    const index = turn?.itemIndex[props.itemId];
    return index == null ? undefined : turn.items[index];
  });
  const stableMessage = useMemo(() => item, [item]);
  if (!stableMessage) return null;
  return (
    <div className={cn('relative', props.showExecutionDetails && 'pr-9')}>
      <ItemContent {...props} item={stableMessage} />
      {props.showExecutionDetails && props.onOpenExecutionDetails && (
        <Tooltip>
          <TooltipTrigger
            type="button"
            onClick={() => props.onOpenExecutionDetails?.(props.turnId)}
            className="absolute right-0 top-0 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
            data-testid="timeline-execution-details"
            data-turn-id={props.turnId}
            aria-label={t('timeline.executionDetails')}
          >
            <Activity className="h-3.5 w-3.5" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent><p>{t('timeline.executionDetails')}</p></TooltipContent>
        </Tooltip>
      )}
    </div>
  );
});
