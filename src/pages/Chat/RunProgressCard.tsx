import { AlertCircle, CheckCircle2, Loader2, TerminalSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
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
      generic?: boolean;
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

const NOISY_MESSAGE_LABELS = new Set(['gate', 'checkpoint']);
const PROBLEM_STATUSES = new Set<TaskStep['status']>(['blocked', 'error', 'failed', 'aborted']);

function normalizeText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
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
  return truncateText(candidate || command, 160);
}

function summarizePathLike(value: string): string {
  return truncateText(value, 140);
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
    return truncateText(record.url, 160);
  }
  if (typeof step.url === 'string' && step.url.trim()) {
    return truncateText(step.url, 160);
  }
  return undefined;
}

function buildActionEntry(step: TaskStep, t: (key: string) => string): RunProgressEntry {
  const command = extractCommandPreview(step);
  const label = step.label.trim().toLowerCase();
  let generic = false;
  const text = (() => {
    if (step.status === 'running') return t('runtimeProgress.executing');
    if (PROBLEM_STATUSES.has(step.status)) return t('runtimeProgress.failed');
    if (label === 'web_fetch' && command) return t('runtimeProgress.visited');
    if (label === 'read' && command) return t('runtimeProgress.read');
    if (label === 'edit' || label === 'apply_patch') return t('runtimeProgress.edited');
    generic = true;
    return t('runtimeProgress.ran');
  })();
  return {
    id: `${step.id}:action`,
    kind: 'action',
    text,
    command,
    status: step.status,
    generic,
  };
}

function buildStatusEntry(step: TaskStep): RunProgressEntry | null {
  if (!PROBLEM_STATUSES.has(step.status)) return null;
  const detail = normalizeText(step.detail);
  if (!detail) return null;
  return {
    id: `${step.id}:status`,
    kind: 'status',
    status: step.status,
    text: truncateText(detail, 180),
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
  t: (key: string) => string,
): RunProgressEntry[] {
  if ((progressEntries?.length ?? 0) > 0) {
    const entries = progressEntries!.map((entry): RunProgressEntry => {
      if (entry.kind === 'commentary') {
        return {
          id: entry.id,
          kind: 'narration',
          text: entry.text,
        };
      }
      if (entry.kind === 'status') {
        return {
          id: entry.id,
          kind: 'status',
          text: entry.text,
          status: entry.status ?? 'completed',
        };
      }
      return {
        id: entry.id,
        kind: 'action',
        text: entry.text,
        command: entry.command,
        status: entry.status ?? 'completed',
      };
    });
    const normalizedLiveText = normalizeText(liveText);
    if (!normalizedLiveText) return entries;
    const alreadyPresent = entries.some((entry) => normalizeText(entry.text) === normalizedLiveText);
    if (alreadyPresent) return entries;
    return [...entries, {
      id: 'live-text',
      kind: 'narration',
      text: normalizedLiveText,
    }];
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

    if (step.kind === 'system' && NOISY_MESSAGE_LABELS.has(step.label.trim().toLowerCase())) {
      const statusEntry = buildStatusEntry(step);
      if (statusEntry) entries.push(statusEntry);
    }
  }

  const normalizedLiveText = normalizeText(liveText);
  if (normalizedLiveText) {
    const alreadyPresent = entries.some((entry) => normalizeText(entry.text) === normalizedLiveText);
    if (!alreadyPresent) {
      entries.push({
        id: 'live-text',
        kind: 'narration',
        text: normalizedLiveText,
      });
    }
  }

  return entries;
}

function shouldRenderEntry(entry: RunProgressEntry): boolean {
  if (entry.kind !== 'action') return true;
  if (normalizeText(entry.command)) return true;
  if (entry.status === 'running') return true;
  if (PROBLEM_STATUSES.has(entry.status)) return true;
  return !entry.generic && Boolean(normalizeText(entry.text));
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
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  if (PROBLEM_STATUSES.has(status)) return <AlertCircle className="h-3.5 w-3.5" />;
  return <CheckCircle2 className="h-3.5 w-3.5" />;
}

export function RunProgressCard({ summary, status, steps, progressEntries, liveText }: RunProgressCardProps) {
  const { t } = useTranslation('chat');
  const entries = buildRunProgressEntries(steps, progressEntries, liveText, t).filter(shouldRenderEntry);
  if (entries.length === 0) return null;

  return (
    <div
      data-testid="chat-run-progress"
      className="w-full py-0.5"
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] leading-5 text-muted-foreground">
        <span className="shrink-0">
          <ActionStatusIcon status={status} />
        </span>
        <span className="truncate">{summary}</span>
      </div>

      <div className="space-y-2">
        {entries.map((entry) => {
          if (entry.kind === 'narration') {
            return (
              <p key={entry.id} className="text-sm leading-6 text-foreground/90 dark:text-foreground/85">
                {entry.text}
              </p>
            );
          }

          if (entry.kind === 'status') {
            return (
              <div
                key={entry.id}
                className="flex items-start gap-1.5 text-xs text-destructive/85"
              >
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 break-words leading-5">{entry.text}</span>
              </div>
            );
          }

          return (
            <div
              key={entry.id}
              className={cn(
                'flex min-w-0 items-start gap-1.5 text-[11px] leading-5',
                PROBLEM_STATUSES.has(entry.status)
                  ? 'text-destructive/85'
                  : 'text-muted-foreground',
              )}
            >
              <div className="mt-0.5 shrink-0">
                {PROBLEM_STATUSES.has(entry.status) ? (
                  <AlertCircle className="h-3.5 w-3.5" />
                ) : entry.status === 'running' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <TerminalSquare className="h-3.5 w-3.5" />
                )}
              </div>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span>{entry.text}</span>
                  {entry.command ? (
                    <code
                      className="max-w-full break-all rounded bg-black/[0.045] px-1.5 py-0.5 font-mono text-[11px] leading-4 text-foreground/75 dark:bg-white/[0.08] dark:text-foreground/75"
                      title={entry.command}
                    >
                      {entry.command}
                    </code>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
