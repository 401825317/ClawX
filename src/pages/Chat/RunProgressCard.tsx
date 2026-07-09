import { AlertCircle, CheckCircle2, Loader2, TerminalSquare } from 'lucide-react';
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

function extractOpenAppName(command: string): string | undefined {
  const byApp = command.match(/\bopen\s+-a\s+["']?([^"'\n]+)["']?/iu);
  if (byApp?.[1]) return byApp[1].trim();
  const byPath = command.match(/\bopen\s+((?:\/|~\/)[^\n]+)/u);
  if (!byPath?.[1]) return undefined;
  const normalized = byPath[1].trim();
  return normalized.split(/[\\/]/u).pop()?.replace(/\.app$/iu, '') || normalized;
}

function inferToolNarration(step: TaskStep): { key: string; text: string } | null {
  const label = step.label.trim().toLowerCase();
  if (label === 'exec') {
    const command = extractCommandPreview(step);
    if (!command) return { key: 'exec', text: '我先继续执行当前步骤。' };
    if (/\b(?:mdfind|find|lsregister|locate|rg|ls)\b/iu.test(command) && /(?:Applications|Desktop|Music|音乐|QQ|Netease|qq|netease)/iu.test(command)) {
      return { key: 'search-local-app', text: '我先在本机查找相关应用和快捷方式。' };
    }
    if (/\bopen\b/iu.test(command)) {
      const appName = extractOpenAppName(command);
      return appName
        ? { key: `open:${appName.toLowerCase()}`, text: `我先尝试打开 ${appName}。` }
        : { key: 'open-app', text: '我先尝试启动相关应用。' };
    }
    if (/\bosascript\b/iu.test(command) && /\b(?:keystroke|key\s+code|activate)\b/iu.test(command)) {
      return { key: 'desktop-next-action', text: '我尝试继续执行应用里的下一步操作。' };
    }
    if (/\b(?:pgrep|ps)\b/iu.test(command)) {
      return { key: 'confirm-process', text: '我再确认应用是否仍在运行。' };
    }
    if (/\b(?:cat|sed|awk|jq|plutil|defaults)\b/iu.test(command)) {
      return { key: 'inspect-context', text: '我先查看相关信息。' };
    }
    return null;
  }

  if (label === 'web_fetch' || label === 'browser') {
    return { key: label, text: '我先继续查看相关页面和内容。' };
  }
  if (label === 'read') {
    return { key: label, text: '我先查看相关内容。' };
  }
  if (label === 'edit' || label === 'apply_patch') {
    return { key: label, text: '我先修改相关内容。' };
  }
  return null;
}

function buildActionEntry(step: TaskStep): RunProgressEntry {
  const command = extractCommandPreview(step);
  const label = step.label.trim().toLowerCase();
  const text = (() => {
    if (step.status === 'running') return '正在执行';
    if (PROBLEM_STATUSES.has(step.status)) return '执行失败';
    if (label === 'web_fetch' && command) return '已访问相关页面';
    if (label === 'read' && command) return '已读取相关内容';
    if (label === 'edit' || label === 'apply_patch') return '已修改相关内容';
    return '已运行';
  })();
  return {
    id: `${step.id}:action`,
    kind: 'action',
    text,
    command,
    status: step.status,
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
    return [{
      id: 'live-text',
      kind: 'narration',
      text: normalizedLiveText,
    }, ...entries];
  }

  const entries: RunProgressEntry[] = [];
  let lastNarrationKey: string | null = null;

  for (const step of steps) {
    if (shouldKeepNarration(step)) {
      entries.push({
        id: `${step.id}:narration`,
        kind: 'narration',
        text: step.detail!.trim(),
      });
      lastNarrationKey = null;
      continue;
    }

    if (step.kind === 'tool') {
      const syntheticNarration = inferToolNarration(step);
      const lastEntry = entries.at(-1);
      if (
        syntheticNarration
        && lastNarrationKey !== syntheticNarration.key
        && lastEntry?.kind !== 'narration'
      ) {
        entries.push({
          id: `${step.id}:synthetic-narration`,
          kind: 'narration',
          text: syntheticNarration.text,
        });
        lastNarrationKey = syntheticNarration.key;
      }
      entries.push(buildActionEntry(step));
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
      entries.unshift({
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
  const normalizedText = normalizeText(entry.text);
  if (!normalizedText) return false;
  return normalizedText !== '已运行' && normalizedText !== '已调用相关工具';
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
  const entries = buildRunProgressEntries(steps, progressEntries, liveText).filter(shouldRenderEntry);
  if (entries.length === 0) return null;

  return (
    <div
      data-testid="chat-run-progress"
      className="rounded-xl border border-black/6 bg-black/[0.015] px-3.5 py-2.5 dark:border-white/10 dark:bg-white/[0.025]"
    >
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="shrink-0">
          <ActionStatusIcon status={status} />
        </span>
        <span className="truncate">{summary}</span>
      </div>

      <div className="space-y-2.5">
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
                className="flex items-start gap-2 rounded-lg border border-amber-500/15 bg-amber-500/[0.055] px-2.5 py-1.5 text-xs text-amber-700 dark:border-amber-300/15 dark:bg-amber-300/[0.07] dark:text-amber-200/85"
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
                'flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-xs',
                PROBLEM_STATUSES.has(entry.status)
                  ? 'border border-destructive/15 bg-destructive/5 text-destructive/85'
                  : 'bg-black/[0.025] text-muted-foreground dark:bg-white/[0.035]',
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
                    <code className="max-w-full break-all rounded-md bg-black/[0.045] px-1.5 py-0.5 font-mono text-[11px] leading-5 text-foreground/75 dark:bg-white/[0.08] dark:text-foreground/75">
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
