import { AlertCircle, CheckCircle2, ChevronRight, CircleAlert, CircleStop, Loader2 } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { sanitizeRuntimeDisplayText } from '@/lib/runtime-display-sanitizer';
import type { TaskStep } from './task-visualization';
import type { ChatRuntimeProgressEntry } from '../../../shared/chat-runtime-events';

type RunProgressEntry =
  | {
      id: string;
      kind: 'narration';
      text: string;
    }
  | {
      id: string;
      kind: 'action';
      text: string;
      command?: string;
      status: TaskStep['status'];
      identity?: string;
    }
  | {
      id: string;
      kind: 'status';
      text: string;
      status: TaskStep['status'];
    };

interface RunProgressCardProps {
  summary: string;
  status: TaskStep['status'];
  steps: TaskStep[];
  progressEntries?: ChatRuntimeProgressEntry[];
  liveText?: string | null;
}

const PROBLEM_STATUSES = new Set<TaskStep['status']>(['blocked', 'error', 'failed', 'aborted']);
const MEANINGLESS_ACTION_TEXTS = new Set([
  '已运行',
  '运行完成',
  '工具步骤已完成',
  'ran',
  'executed',
  'tool step completed',
  '実行済み',
  'ツールの処理が完了しました',
  'выполнено',
  'шаг инструмента завершён',
]);

function normalizeText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function canonicalToolName(value: string | undefined): string | undefined {
  const normalized = normalizeText(value)?.toLowerCase();
  if (!normalized) return undefined;
  const leaf = normalized.split(':').filter(Boolean).at(-1) ?? normalized;
  return leaf.replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '') || undefined;
}

function humanizeToolName(value: string | undefined): string {
  const normalized = normalizeText(value);
  if (!normalized) return 'Tool';
  const leaf = normalized.split(':').filter(Boolean).at(-1) ?? normalized;
  return leaf.replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim() || 'Tool';
}

function translateToolLabel(entry: ChatRuntimeProgressEntry, t: TFunction): string {
  const toolName = canonicalToolName(entry.toolName);
  const fallback = normalizeText(entry.toolLabel) ?? humanizeToolName(entry.toolName);
  if (!toolName) return fallback;
  return t(`runtimeProgress.toolLabels.${toolName}`, { defaultValue: fallback });
}

function translateProgressEntryText(entry: ChatRuntimeProgressEntry, t: TFunction): string {
  if (!entry.translationKey) return entry.text;
  return t(entry.translationKey, {
    ...entry.translationParams,
    tool: translateToolLabel(entry, t),
    defaultValue: entry.text,
  });
}

function translationKeyForStatus(status: TaskStep['status']): string {
  if (status === 'running') return 'runtimeProgress.toolRunning';
  if (status === 'aborted') return 'runtimeProgress.toolAborted';
  if (status === 'blocked') return 'runtimeProgress.toolBlocked';
  if (status === 'error' || status === 'failed') return 'runtimeProgress.toolFailed';
  return 'runtimeProgress.toolCompleted';
}

function semanticActionText(entry: ChatRuntimeProgressEntry, t: TFunction): string {
  const toolName = normalizeText(entry.toolName) ?? normalizeText(entry.toolLabel);
  const command = normalizeText(entry.command);
  if (entry.translationKey && toolName) return translateProgressEntryText(entry, t);
  if (entry.translationKey && !entry.translationKey.startsWith('runtimeProgress.tool')) {
    return translateProgressEntryText(entry, t);
  }
  if (toolName || command) {
    const tool = toolName
      ? translateToolLabel(entry, t)
      : t('runtimeProgress.toolLabels.command');
    const translationKey = entry.translationKey ?? translationKeyForStatus(entry.status ?? 'completed');
    return t(translationKey, { ...entry.translationParams, tool, defaultValue: entry.text });
  }
  const text = entry.text.trim();
  const normalizedText = text.toLowerCase().replace(/[。.!！:：]+$/gu, '');
  return MEANINGLESS_ACTION_TEXTS.has(normalizedText) ? '' : text;
}

function truncateText(value: string, maxChars = 140): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function parseDetailRecord(detail: string | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function summarizeShellCommand(command: string): string {
  const candidate = command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => !/^(?:set\s+-[A-Za-z]+|printf\b|echo\b|#|true$|false$)/u.test(line));
  return truncateText(sanitizeRuntimeDisplayText(candidate || command), 160);
}

function summarizePathLike(value: string): string {
  return truncateText(sanitizeRuntimeDisplayText(value), 140);
}

function extractCommandPreview(step: TaskStep): string | undefined {
  const record = parseDetailRecord(step.detail);
  if (record && typeof record.command === 'string' && record.command.trim()) {
    return summarizeShellCommand(record.command);
  }
  if (record && typeof record.path === 'string' && record.path.trim()) {
    return summarizePathLike(record.path);
  }
  if (record && typeof record.filePath === 'string' && record.filePath.trim()) {
    return summarizePathLike(record.filePath);
  }
  if (record && typeof record.url === 'string' && record.url.trim()) {
    return truncateText(sanitizeRuntimeDisplayText(record.url), 160);
  }
  if (typeof step.url === 'string' && step.url.trim()) {
    return truncateText(sanitizeRuntimeDisplayText(step.url), 160);
  }
  return undefined;
}

function buildActionEntry(step: TaskStep, t: TFunction): RunProgressEntry {
  const command = extractCommandPreview(step);
  const toolName = canonicalToolName(step.label);
  const fallback = humanizeToolName(step.label);
  const tool = toolName
    ? t(`runtimeProgress.toolLabels.${toolName}`, { defaultValue: fallback })
    : fallback;
  return {
    id: `${step.id}:action`,
    kind: 'action',
    text: t(translationKeyForStatus(step.status), { tool }),
    command,
    status: step.status,
    identity: `step:${step.id}`,
  };
}

function shouldKeepNarration(step: TaskStep): boolean {
  if (step.kind !== 'message') return false;
  if (step.label !== 'Message') return false;
  const detail = normalizeText(step.detail);
  return Boolean(detail);
}

function buildRunProgressEntries(
  steps: TaskStep[],
  progressEntries: ChatRuntimeProgressEntry[] | undefined,
  liveText: string | null | undefined,
  t: TFunction,
): RunProgressEntry[] {
  if ((progressEntries?.length ?? 0) > 0) {
    const entries = progressEntries!.map((entry): RunProgressEntry => {
      if (entry.kind === 'commentary') {
        return {
          id: entry.id,
          kind: 'narration',
          text: sanitizeRuntimeDisplayText(translateProgressEntryText(entry, t)),
        };
      }
      if (entry.kind === 'status') {
        return {
          id: entry.id,
          kind: 'status',
          text: sanitizeRuntimeDisplayText(translateProgressEntryText(entry, t)),
          status: entry.status ?? 'completed',
        };
      }
      return {
        id: entry.id,
        kind: 'action',
        text: sanitizeRuntimeDisplayText(semanticActionText(entry, t)),
        command: entry.command ? sanitizeRuntimeDisplayText(entry.command) : undefined,
        status: entry.status ?? 'completed',
        identity: entry.dedupeKey
          ?? entry.toolCallId
          ?? entry.stepId
          ?? entry.taskId
          ?? undefined,
      };
    });
    const normalizedLiveText = normalizeText(liveText);
    if (!normalizedLiveText) return dedupeProgressEntries(entries);
    const alreadyPresent = entries.some((entry) => normalizeText(entry.text) === normalizedLiveText);
    if (alreadyPresent) return dedupeProgressEntries(entries);
    return dedupeProgressEntries([...entries, {
      id: 'live-text',
      kind: 'narration',
      text: sanitizeRuntimeDisplayText(normalizedLiveText),
    }]);
  }

  const entries: RunProgressEntry[] = [];

  for (const step of steps) {
    if (shouldKeepNarration(step)) {
      entries.push({
        id: `${step.id}:narration`,
        kind: 'narration',
        text: step.detail!.trim(),
      });
      continue;
    }

    if (step.kind === 'tool') {
      entries.push(buildActionEntry(step, t));
      continue;
    }

  }

  const normalizedLiveText = normalizeText(liveText);
  if (normalizedLiveText) {
    const alreadyPresent = entries.some((entry) => normalizeText(entry.text) === normalizedLiveText);
    if (!alreadyPresent) {
      entries.push({
        id: 'live-text',
        kind: 'narration',
        text: sanitizeRuntimeDisplayText(normalizedLiveText),
      });
    }
  }

  return dedupeProgressEntries(entries);
}

function dedupeProgressEntries(entries: RunProgressEntry[]): RunProgressEntry[] {
  const result: RunProgressEntry[] = [];
  const actionIndexes = new Map<string, number>();

  for (const entry of entries) {
    if (!normalizeText(entry.text)) continue;
    if (entry.kind !== 'action') {
      const previous = result.at(-1);
      if (previous?.kind === entry.kind && normalizeText(previous.text) === normalizeText(entry.text)) continue;
      result.push(entry);
      continue;
    }

    const identity = normalizeText(entry.identity);
    if (!identity) {
      result.push(entry);
      continue;
    }
    const existingIndex = actionIndexes.get(identity);
    if (existingIndex == null) {
      actionIndexes.set(identity, result.length);
      result.push(entry);
      continue;
    }
    result[existingIndex] = entry;
  }

  return result;
}

export function shouldUseRunProgressTranscript(
  steps: TaskStep[],
  generatedFilesCount: number,
  progressEntries?: ChatRuntimeProgressEntry[],
): boolean {
  if ((progressEntries?.length ?? 0) > 0) return true;
  if (generatedFilesCount > 0) return false;
  return steps.some((step) => step.kind === 'tool' || shouldKeepNarration(step));
}

function ActionStatusIcon({ status }: { status: TaskStep['status'] }) {
  if (status === 'running') return <Loader2 data-status-icon="running" className="h-3.5 w-3.5 animate-spin" />;
  if (status === 'aborted') return <CircleStop data-status-icon="aborted" className="h-3.5 w-3.5" />;
  if (status === 'blocked') return <CircleAlert data-status-icon="blocked" className="h-3.5 w-3.5" />;
  if (status === 'error' || status === 'failed') return <AlertCircle data-status-icon={status} className="h-3.5 w-3.5" />;
  return <CheckCircle2 data-status-icon="completed" className="h-3.5 w-3.5" />;
}

function ProblemStatusIcon({ status }: { status: TaskStep['status'] }) {
  if (status === 'aborted') return <CircleStop data-status-icon="aborted" className="h-3.5 w-3.5" />;
  if (status === 'blocked') return <CircleAlert data-status-icon="blocked" className="h-3.5 w-3.5" />;
  return <AlertCircle data-status-icon={status} className="h-3.5 w-3.5" />;
}

function problemTextClass(status: TaskStep['status']): string {
  if (status === 'aborted') return 'text-muted-foreground';
  if (status === 'blocked') return 'text-amber-700 dark:text-amber-400';
  return 'text-destructive/85';
}

export function RunProgressCard({ summary, status, steps, progressEntries, liveText }: RunProgressCardProps) {
  const { t } = useTranslation('chat');
  const entries = buildRunProgressEntries(steps, progressEntries, liveText, t);
  if (entries.length === 0) return null;

  return (
    <div
      data-testid="chat-run-progress"
      className="w-full py-0.5"
    >
      <div className="mb-2 flex items-center gap-1.5 text-[11px] leading-5 text-muted-foreground">
        <span className="shrink-0">
          <ActionStatusIcon status={status} />
        </span>
        <span className="font-medium text-foreground/70">{t('runtimeProgress.title')}</span>
        <span aria-hidden="true">·</span>
        <span className="truncate">{summary}</span>
      </div>

      <div className="relative ml-[7px] border-l border-border/70">
        {entries.map((entry) => {
          if (entry.kind === 'narration') {
            return (
              <div key={entry.id} className="relative pb-2.5 pl-5 last:pb-0">
                <span className="absolute -left-[3px] top-[9px] h-1.5 w-1.5 rounded-full bg-muted-foreground/55 ring-4 ring-background" />
                <p className="text-sm leading-6 text-foreground/90 dark:text-foreground/85">
                  {entry.text}
                </p>
              </div>
            );
          }

          if (entry.kind === 'status') {
            return (
              <div
                key={entry.id}
                className={cn('relative flex items-start gap-1.5 pb-2.5 pl-5 text-xs last:pb-0', problemTextClass(entry.status))}
              >
                <span className="absolute -left-[7px] top-0.5 shrink-0 bg-background">
                  <ProblemStatusIcon status={entry.status} />
                </span>
                <span className="min-w-0 break-words leading-5">{entry.text}</span>
              </div>
            );
          }

          return (
            <div
              key={entry.id}
              data-testid="chat-run-progress-action"
              aria-current={entry.status === 'running' ? 'step' : undefined}
              className={cn(
                'relative min-w-0 pb-2.5 pl-5 text-xs leading-5 last:pb-0',
                PROBLEM_STATUSES.has(entry.status)
                  ? problemTextClass(entry.status)
                  : entry.status === 'running'
                    ? 'text-foreground/90'
                    : 'text-muted-foreground',
              )}
            >
              <div className="absolute -left-[7px] top-0.5 shrink-0 bg-background">
                {PROBLEM_STATUSES.has(entry.status) ? (
                  <ProblemStatusIcon status={entry.status} />
                ) : entry.status === 'running' ? (
                  <Loader2 data-status-icon="running" className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 data-status-icon="completed" className="h-3.5 w-3.5" />
                )}
              </div>
              <div className="min-w-0">
                <div className="break-words">{entry.text}</div>
                {entry.command ? (
                  <details className="group/details mt-0.5">
                    <summary className="flex w-fit cursor-pointer list-none items-center gap-0.5 text-[11px] text-muted-foreground/80 outline-none hover:text-foreground [&::-webkit-details-marker]:hidden">
                      <ChevronRight className="h-3 w-3 transition-transform group-open/details:rotate-90" />
                      {t('runtimeProgress.commandDetails')}
                    </summary>
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all border-l border-border pl-2 font-mono text-[11px] leading-4 text-foreground/70">
                      {entry.command}
                    </pre>
                  </details>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
