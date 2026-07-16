import { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, CircleAlert, CircleDashed, CircleStop, GitBranch, Link, Loader2, MessageSquare, Wrench, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { sanitizeRuntimeDisplayText } from '@/lib/runtime-display-sanitizer';
import type { TaskStep } from './task-visualization';

interface ExecutionGraphCardProps {
  agentLabel: string;
  steps: TaskStep[];
  active: boolean;
  compactSummary?: string;
  compactStatus?: TaskStep['status'];
  detailsEnabled?: boolean;
  /** Hide the trailing "Thinking ..." indicator even when active. */
  suppressThinking?: boolean;
  /**
   * When provided, the card becomes fully controlled: the parent owns the
   * expand state (e.g. to persist across remounts) and toggling goes through
   * `onExpandedChange`. When omitted, the card manages its own local state.
   */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

const TOOL_ROW_EXTRA_INDENT_PX = 8;
const STEP_DETAIL_PREVIEW_MAX_CHARS = 110;

function truncateStepPreviewText(value: string, maxChars = STEP_DETAIL_PREVIEW_MAX_CHARS): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function summarizePreviewLine(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ? truncateStepPreviewText(line) : undefined;
}

function summarizeStepDetail(step: TaskStep): string | undefined {
  const detail = step.detail ? sanitizeRuntimeDisplayText(step.detail) : undefined;
  if (!detail) return undefined;
  try {
    const parsed = JSON.parse(detail) as unknown;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const command = typeof record.command === 'string' ? record.command : undefined;
      if (command?.trim()) return summarizePreviewLine(command);
      const filePath = typeof record.filePath === 'string' ? record.filePath : undefined;
      if (filePath?.trim()) return summarizePreviewLine(filePath);
      const path = typeof record.path === 'string' ? record.path : undefined;
      if (path?.trim()) return summarizePreviewLine(path);
      const action = typeof record.action === 'string' ? record.action : undefined;
      if (step.label === 'read' && action?.trim()) return summarizePreviewLine(action);
      const directText = typeof record.text === 'string' ? record.text : undefined;
      if (directText?.trim()) return summarizePreviewLine(directText);
      const message = typeof record.message === 'string' ? record.message : undefined;
      if (message?.trim()) return summarizePreviewLine(message);
      const output = typeof record.output === 'string' ? record.output : undefined;
      if (output?.trim()) return summarizePreviewLine(output);
      const stdout = typeof record.stdout === 'string' ? record.stdout : undefined;
      if (stdout?.trim()) return summarizePreviewLine(stdout);
      const stderr = typeof record.stderr === 'string' ? record.stderr : undefined;
      if (stderr?.trim()) return summarizePreviewLine(stderr);
      const content = Array.isArray(record.content) ? record.content : [];
      const firstContentText = content
        .map((entry) => (entry && typeof entry === 'object' ? (entry as { text?: unknown }).text : undefined))
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (firstContentText) {
        const prefix = action ? `${action}: ` : '';
        return summarizePreviewLine(`${prefix}${firstContentText}`);
      }
      if (action?.trim()) return summarizePreviewLine(action);
      return truncateStepPreviewText(JSON.stringify(parsed));
    }
  } catch {
    // fall through to plain-text summary
  }
  return summarizePreviewLine(detail);
}

function formatDuration(durationMs?: number): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${Math.round(durationMs / 1000)}s`;
}

function AnimatedDots({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-0.5 leading-none text-muted-foreground', className)} aria-hidden="true">
      <span className="inline-block animate-bounce [animation-delay:0ms]">.</span>
      <span className="inline-block animate-bounce [animation-delay:150ms]">.</span>
      <span className="inline-block animate-bounce [animation-delay:300ms]">.</span>
    </span>
  );
}

function GraphStatusIcon({ status }: { status: TaskStep['status'] }) {
  if (status === 'completed') return <CheckCircle2 data-status-icon="completed" className="h-4 w-4" />;
  if (status === 'aborted') return <CircleStop data-status-icon="aborted" className="h-4 w-4" />;
  if (status === 'blocked') return <CircleAlert data-status-icon="blocked" className="h-4 w-4" />;
  if (status === 'error' || status === 'failed') return <XCircle data-status-icon={status} className="h-4 w-4" />;
  return <CircleDashed data-status-icon={status} className="h-4 w-4" />;
}

function CompactStatusIcon({ status }: { status: TaskStep['status'] }) {
  if (status === 'running') return <Loader2 data-status-icon="running" className="h-3.5 w-3.5 animate-spin" />;
  if (status === 'completed') return <CheckCircle2 data-status-icon="completed" className="h-3.5 w-3.5" />;
  if (status === 'aborted') return <CircleStop data-status-icon="aborted" className="h-3.5 w-3.5" />;
  if (status === 'blocked') return <CircleAlert data-status-icon="blocked" className="h-3.5 w-3.5" />;
  if (status === 'error' || status === 'failed') return <XCircle data-status-icon={status} className="h-3.5 w-3.5" />;
  return <CircleDashed data-status-icon={status} className="h-3.5 w-3.5" />;
}

function StepDetailCard({ step }: { step: TaskStep }) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const safeDetail = step.detail ? sanitizeRuntimeDisplayText(step.detail) : undefined;
  const hasDetail = !!safeDetail;
  // Narration steps (intermediate pure-text assistant messages folded from
  // the chat stream) are rendered without a label/status pill: the message
  // text IS the primary content.
  const isNarration = step.kind === 'message';
  const isTool = step.kind === 'tool';
  const isThinking = step.kind === 'thinking';
  const displayToolLabel = isTool && step.label === 'image_generate'
    ? t('executionGraph.imageGenerateLabel')
    : step.label;
  // System steps (subagent branch roots etc.) share the tool row layout:
  // bold label + truncated single-line detail preview + click-to-expand,
  // i.e. no rounded card / no separate detail line below the title.
  const isSystem = step.kind === 'system';
  const isFlatRow = isTool || isSystem;
  const showRunningDots = (isTool || isThinking) && step.status === 'running';
  const hideStatusText = (isTool || isSystem) && step.status === 'completed';
  const detailPreview = summarizeStepDetail(step);
  const duration = formatDuration(step.durationMs);
  const canExpand = hasDetail;
    const displayLabel = isThinking ? t('executionGraph.thinkingLabel') : (isTool ? displayToolLabel : step.label);

  return (
    <div
      className={cn(
        'min-w-0 flex-1 text-muted-foreground',
        isFlatRow || isNarration || isThinking
          ? 'px-0 py-0'
          : 'rounded-xl border border-black/10 bg-white/40 px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]',
      )}
    >
      <button
        type="button"
        className={cn(
          'flex w-full gap-2 text-left',
          isFlatRow ? 'items-center' : 'items-start',
          canExpand ? 'cursor-pointer' : 'cursor-default',
        )}
        onClick={() => {
          if (!canExpand) return;
          setExpanded((value) => !value);
        }}
      >
        <div className="min-w-0 flex-1">
          {(!isNarration && !isThinking || expanded) && (
            <div className="flex min-w-0 items-center gap-2">
              <p className="shrink-0 text-sm font-medium text-muted-foreground">{displayLabel}</p>
              {isTool && step.label === 'web_fetch' && step.url && (
                <a
                  href={step.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  title={sanitizeRuntimeDisplayText(step.url)}
                >
                  <Link className="h-3.5 w-3.5" />
                </a>
              )}
              {isFlatRow && detailPreview && !expanded && (
                <p className="min-w-0 truncate text-xs leading-4 text-muted-foreground/80">
                  {detailPreview}
                </p>
              )}
              {duration && (
                <span className="shrink-0 whitespace-nowrap rounded-full bg-black/5 px-2 py-0.5 text-2xs font-medium text-muted-foreground dark:bg-white/10">
                  {duration}
                </span>
              )}
              {!hideStatusText && !showRunningDots && (
                <span className="shrink-0 whitespace-nowrap rounded-full bg-black/5 px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground dark:bg-white/10">
                  {t(`taskPanel.stepStatus.${step.status}`)}
                </span>
              )}
              {showRunningDots && (
                <AnimatedDots className="text-sm" />
              )}
            </div>
          )}
          {safeDetail && !expanded && !isFlatRow && (
            <p
              className={cn(
                'text-muted-foreground',
                isThinking
                  ? 'mt-0.5 text-meta leading-5 line-clamp-2'
                  : 'text-meta leading-6 text-muted-foreground line-clamp-2',
              )}
            >
              {safeDetail}
            </p>
          )}
        </div>
        {canExpand && (
          <span className="mt-0.5 shrink-0 text-muted-foreground">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </span>
        )}
      </button>
      {safeDetail && expanded && canExpand && isFlatRow && (() => {
            // Tool inputs are typically JSON; system payloads (e.g. subagent
            // session keys) are usually plain strings. Pretty-print if the
            // detail parses as JSON, otherwise fall back to the raw text so
            // session keys render unchanged.
            let formatted = safeDetail;
            try {
              formatted = JSON.stringify(JSON.parse(safeDetail), null, 2);
            } catch { /* not valid JSON */ }
            return (
              <div className="mt-3 rounded-lg border border-black/10 bg-black/[0.03] px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]">
                <pre
                  className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground"
                >
                  {formatted}
                </pre>
              </div>
            );
          })()}
          {safeDetail && expanded && canExpand && (isNarration || isThinking) && (
            <div className="mt-3 rounded-lg border border-black/10 bg-black/[0.03] px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]">
              <pre
                className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground"
              >
                {safeDetail}
              </pre>
            </div>
          )}
    </div>
  );
}

export function ExecutionGraphCard({
  agentLabel,
  steps,
  active,
  compactSummary,
  compactStatus,
  detailsEnabled = true,
  suppressThinking = false,
  expanded: controlledExpanded,
  onExpandedChange,
}: ExecutionGraphCardProps) {
  const { t } = useTranslation('chat');

  // Keep the default surface compact. The full graph is a diagnostic detail,
  // not the normal chat experience.
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(false);
  const [prevActive, setPrevActive] = useState(active);
  if (prevActive !== active) {
    setPrevActive(active);
    if (controlledExpanded == null && uncontrolledExpanded) {
      setUncontrolledExpanded(false);
    }
  }

  const isControlled = controlledExpanded != null;
  const expanded = isControlled ? controlledExpanded : uncontrolledExpanded;
  const setExpanded = (next: boolean) => {
    if (!isControlled) setUncontrolledExpanded(next);
    onExpandedChange?.(next);
  };

  const toolCount = steps.filter((step) => step.kind === 'tool').length;
  const processCount = steps.length - toolCount;
  const shouldShowTrailingThinking = active && !suppressThinking;
  const collapsedSummary = compactSummary || t('executionGraph.collapsedSummary', { toolCount, processCount });
  const collapsedStatus = compactStatus || (active ? 'running' : 'completed');
  const canExpandDetails = detailsEnabled && steps.length > 0;
  const showDetailsAction = Boolean(compactSummary) && canExpandDetails;

  if (!expanded || !canExpandDetails) {
    const collapsedContent = (
      <>
        <span className="shrink-0 text-muted-foreground">
          <CompactStatusIcon status={collapsedStatus} />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {collapsedSummary}
        </span>
        {showDetailsAction && (
          <span className="shrink-0 whitespace-nowrap rounded-full bg-black/5 px-2 py-0.5 text-2xs font-medium text-muted-foreground opacity-80 transition-opacity group-hover:opacity-100 dark:bg-white/10">
            {t('executionGraph.detailsAction')}
          </span>
        )}
        {canExpandDetails && (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
        )}
      </>
    );
    if (!canExpandDetails) {
      return (
        <div
          data-testid="chat-execution-graph"
          data-collapsed="true"
          data-compact-status={collapsedStatus}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground"
        >
          {collapsedContent}
        </div>
      );
    }
    return (
      <button
        type="button"
        data-testid="chat-execution-graph"
        data-collapsed="true"
        data-compact-status={collapsedStatus}
        onClick={() => setExpanded(true)}
        className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-black/5 hover:text-muted-foreground dark:hover:bg-white/5"
      >
        {collapsedContent}
      </button>
    );
  }

  return (
    <div
      data-testid="chat-execution-graph"
      data-collapsed="false"
      data-compact-status={collapsedStatus}
      className="w-full px-0 py-0 text-muted-foreground"
    >
      <button
        type="button"
        data-testid="chat-execution-graph-collapse"
        onClick={() => setExpanded(false)}
        className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-black/5 hover:text-muted-foreground dark:hover:bg-white/5"
        aria-label={t('executionGraph.collapseAction')}
        title={t('executionGraph.collapseAction')}
      >
        <ChevronRight className="h-3.5 w-3.5 shrink-0 rotate-90" />
        <span className="truncate">{t('executionGraph.title')}</span>
      </button>

      <div className="mt-0 px-0 py-0">
        <div className="mt-0.5 flex items-center gap-0.5" style={{ marginLeft: `${TOOL_ROW_EXTRA_INDENT_PX}px` }}>
          <div className="flex w-6 shrink-0 justify-center">
            <div className="flex h-6 w-6 items-center justify-center text-muted-foreground">
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <span className="truncate text-sm font-medium text-muted-foreground">
              {t('executionGraph.agentRun', { agent: agentLabel })}
            </span>
          </div>
        </div>

        {steps.map((step) => {
          const alignedIndentOffset = (
            step.kind === 'tool'
            || step.kind === 'message'
            || step.kind === 'thinking'
          ) ? TOOL_ROW_EXTRA_INDENT_PX : 0;
          const rowMarginLeft = (Math.max(step.depth - 1, 0) * 24) + alignedIndentOffset;
          return (
          <div key={step.id} className="mt-0.5">
            <div
              className="pl-3"
              style={{ marginLeft: `${rowMarginLeft}px` }}
            >
              <div className="ml-3 h-1 w-px bg-border" />
            </div>
            <div
              className="flex items-start gap-0.5"
              data-testid="chat-execution-step"
              data-task-id={step.taskId}
              data-parent-id={step.parentId}
              data-step-kind={step.kind}
              data-step-status={step.status}
              style={{ marginLeft: `${rowMarginLeft}px` }}
            >
              <div className="flex w-6 shrink-0 justify-center">
                <div className="relative flex items-center justify-center">
                  {step.depth > 1 && (
                    <div className="absolute -left-3 top-1/2 h-px w-3 -translate-y-1/2 bg-border" />
                  )}
                  <div
                    className={cn(
                      'flex h-6 w-6 items-center justify-center text-muted-foreground',
                    )}
                  >
                    {step.kind === 'thinking'
                      ? <MessageSquare className="h-3.5 w-3.5" />
                      : step.kind === 'tool'
                        ? <Wrench className="h-3.5 w-3.5" />
                        : step.kind === 'message'
                          ? <MessageSquare className="h-3.5 w-3.5" />
                          : <GraphStatusIcon status={step.status} />}
                  </div>
                </div>
              </div>
              <StepDetailCard step={step} />
            </div>
          </div>
        )})}
        {shouldShowTrailingThinking && (
          <div className="mt-0.5">
            <div className="pl-3" style={{ marginLeft: `${TOOL_ROW_EXTRA_INDENT_PX}px` }}>
              <div className="ml-3 h-1 w-px bg-border" />
            </div>
            <div
              className="flex items-center gap-0.5"
              data-testid="chat-execution-step-thinking-trailing"
              style={{ marginLeft: `${TOOL_ROW_EXTRA_INDENT_PX}px` }}
            >
              <div className="w-6 shrink-0" />
              <div className="min-w-0 flex-1 text-sm text-muted-foreground">
                <span className="font-medium">{t('executionGraph.thinkingLabel')}</span>
                <AnimatedDots className="ml-1 inline-flex text-sm" />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
