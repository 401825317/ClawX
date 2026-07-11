import type {
  ChatRuntimeEvent,
  ChatRuntimeProgressEntry,
} from '../../../shared/chat-runtime-events';
import type { ChatRuntimeRunState } from './types';

const PROBLEM_PROGRESS_STATUSES = new Set(['blocked', 'error']);

function normalizeText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function truncateText(value: string, maxChars = 140): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function redactSensitivePreview(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential)\s*[:=]\s*)[^\s,;"']+/giu, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|signature|sig|secret|credential)=)[^&#\s]+/giu, '$1[REDACTED]')
    .replace(/(--(?:api[_-]?key|token|password|secret)(?:=|\s+))[^\s"']+/giu, '$1[REDACTED]');
}

function summarizeShellCommand(command: string): string {
  const candidate = command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => !/^(?:set\s+-[A-Za-z]+|printf\b|echo\b|#|true$|false$)/u.test(line));
  return truncateText(redactSensitivePreview(candidate || command), 160);
}

function summarizePathLike(value: string): string {
  return truncateText(redactSensitivePreview(value), 140);
}

function commandFromRecord(record: Record<string, unknown>): string | undefined {
  const command = normalizeText(typeof record.command === 'string' ? record.command : undefined)
    ?? normalizeText(typeof record.cmd === 'string' ? record.cmd : undefined)
    ?? normalizeText(typeof record.script === 'string' ? record.script : undefined);
  if (command) return summarizeShellCommand(command);

  const path = normalizeText(typeof record.path === 'string' ? record.path : undefined)
    ?? normalizeText(typeof record.filePath === 'string' ? record.filePath : undefined)
    ?? normalizeText(typeof record.url === 'string' ? record.url : undefined);
  if (path) {
    if (/^https?:\/\//iu.test(path)) return truncateText(redactSensitivePreview(path), 160);
    return summarizePathLike(path);
  }

  const nestedArgs = asRecord(record.args);
  if (nestedArgs) return commandFromRecord(nestedArgs);
  const nestedInput = asRecord(record.input);
  if (nestedInput) return commandFromRecord(nestedInput);
  return undefined;
}

function extractCommandPreviewFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() ? summarizeShellCommand(value) : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  return commandFromRecord(record);
}

function extractOpenAppName(command: string): string | undefined {
  const byApp = command.match(/\bopen\s+-a\s+["']?([^"'\n]+)["']?/iu);
  if (byApp?.[1]) return byApp[1].trim();
  const byPath = command.match(/\bopen\s+((?:\/|~\/)[^\n]+)/u);
  if (!byPath?.[1]) return undefined;
  const normalized = byPath[1].trim();
  return normalized.split(/[\\/]/u).pop()?.replace(/\.app$/iu, '') || normalized;
}

function inferToolNarration(name: string, command: string | undefined): { key: string; text: string } | null {
  const label = name.trim().toLowerCase();
  if (label === 'exec') {
    if (!command) return { key: 'exec', text: '我先继续执行当前步骤。' };
    if (/\b(?:mdfind|find|lsregister|locate|rg|ls)\b/iu.test(command) && /(?:\/Applications\b|\.app\b|kMDItemContentType\s*={1,2}\s*["']?com\.apple\.application)/iu.test(command)) {
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

function findProgressEntry(
  run: ChatRuntimeRunState | undefined,
  id: string,
): ChatRuntimeProgressEntry | undefined {
  return (run?.progressEntries ?? []).find((entry) => entry.id === id);
}

function hasNativeToolProgress(
  run: ChatRuntimeRunState | undefined,
  toolCallId: string,
): boolean {
  return (run?.progressEntries ?? []).some((entry) => (
    entry.toolCallId === toolCallId && entry.source === 'native'
  ));
}

function lastNarrationKey(run: ChatRuntimeRunState | undefined): string | undefined {
  const entries = run?.progressEntries ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === 'commentary' && entry.dedupeKey) return entry.dedupeKey;
  }
  return undefined;
}

function toolActionStatus(event: Extract<ChatRuntimeEvent, { type: 'tool.started' | 'tool.completed' }>): ChatRuntimeProgressEntry['status'] {
  if (event.type === 'tool.started') return 'running';
  return event.isError ? 'error' : 'completed';
}

function toolRecoveryFamily(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'create_designed_pptx_file' || normalized === 'repair_designed_pptx_file') {
    return 'designed_pptx_file';
  }
  return normalized;
}

function recoveredToolProgressEvents(
  run: ChatRuntimeRunState | undefined,
  event: Extract<ChatRuntimeEvent, { type: 'tool.completed' }>,
): ChatRuntimeEvent[] {
  if (event.isError) return [];
  const family = toolRecoveryFamily(event.name);
  if (!family) return [];
  const recovered = (run?.events ?? []).filter((candidate): candidate is Extract<ChatRuntimeEvent, { type: 'tool.completed' }> => (
    candidate.type === 'tool.completed'
    && candidate.isError === true
    && toolRecoveryFamily(candidate.name) === family
    && candidate.toolCallId !== event.toolCallId
  ));
  return recovered.flatMap((failedEvent) => {
    const existing = findProgressEntry(run, `progress:tool:${failedEvent.toolCallId}`);
    return [
      buildProgressEntryEvent(event, {
        id: `progress:tool:${failedEvent.toolCallId}`,
        kind: 'action',
        text: family === 'designed_pptx_file' ? '版式问题已修复' : '重试已成功',
        status: 'completed',
        command: existing?.command,
        toolCallId: failedEvent.toolCallId,
        source: 'derived',
      }),
      buildProgressEntryEvent(event, {
        id: `progress:tool:${failedEvent.toolCallId}:status`,
        kind: 'status',
        text: family === 'designed_pptx_file' ? '增量修复已通过完整质量检查' : '后续重试已恢复该步骤',
        status: 'completed',
        toolCallId: failedEvent.toolCallId,
        source: 'derived',
      }),
    ];
  });
}

function buildToolActionText(
  name: string,
  status: ChatRuntimeProgressEntry['status'],
  command: string | undefined,
): string {
  const label = name.trim().toLowerCase();
  if (status === 'running') {
    if (label === 'web_fetch' && command) return '正在查看页面';
    if (label === 'read' && command) return '正在读取相关内容';
    if (label === 'edit' || label === 'apply_patch') return '正在修改相关内容';
    return '正在执行';
  }
  if (status === 'error') return '执行失败';
  if (label === 'web_fetch' && command) return '已访问相关页面';
  if (label === 'read' && command) return '已读取相关内容';
  if (label === 'edit' || label === 'apply_patch') return '已修改相关内容';
  return '已运行';
}

function buildToolStatusDetail(event: Extract<ChatRuntimeEvent, { type: 'tool.completed' }>): string | undefined {
  if (!event.isError) return undefined;
  if (typeof event.result === 'string') return truncateText(event.result, 180);
  const record = asRecord(event.result);
  if (!record) return undefined;
  const detail = normalizeText(typeof record.error === 'string' ? record.error : undefined)
    ?? normalizeText(typeof record.message === 'string' ? record.message : undefined)
    ?? normalizeText(typeof record.detail === 'string' ? record.detail : undefined);
  return detail ? truncateText(redactSensitivePreview(detail), 180) : undefined;
}

function commandOutputStatus(event: Extract<ChatRuntimeEvent, { type: 'command.output' }>): ChatRuntimeProgressEntry['status'] {
  const normalized = normalizeText(event.status)?.toLowerCase();
  if (typeof event.exitCode === 'number') return event.exitCode === 0 ? 'completed' : 'error';
  if (normalized === 'failed' || normalized === 'failure' || normalized === 'error') return 'error';
  if (normalized === 'blocked') return 'blocked';
  if (normalized === 'passed' || normalized === 'success' || normalized === 'succeeded' || normalized === 'completed' || normalized === 'ok') return 'completed';
  const phase = normalizeText(event.phase)?.toLowerCase();
  if (phase === 'end' || phase === 'result' || phase === 'done' || phase === 'completed') return 'completed';
  return 'running';
}

function buildCommandTargetId(event: Extract<ChatRuntimeEvent, { type: 'command.output' }>): string {
  return event.itemId
    ?? event.name
    ?? event.title
    ?? `command:${event.seq ?? event.ts ?? 'runtime'}`;
}

function buildProgressEntryEvent(
  event: ChatRuntimeEvent,
  entry: ChatRuntimeProgressEntry,
): Extract<ChatRuntimeEvent, { type: 'progress.update' }> {
  return {
    contractVersion: event.contractVersion,
    producer: event.producer ?? 'renderer',
    runId: event.runId,
    sessionKey: event.sessionKey,
    ts: event.ts,
    type: 'progress.update',
    entry,
  };
}

export function buildRuntimeProgressEvents(
  run: ChatRuntimeRunState | undefined,
  event: ChatRuntimeEvent,
): ChatRuntimeEvent[] {
  if (event.type === 'progress.update') return [];

  if (event.type === 'tool.started' || event.type === 'tool.completed') {
    const recoveryEvents = event.type === 'tool.completed'
      ? recoveredToolProgressEvents(run, event)
      : [];
    if (hasNativeToolProgress(run, event.toolCallId)) return recoveryEvents;
    const command = extractCommandPreviewFromUnknown(
      event.type === 'tool.started'
        ? event.args
        : (event.result ?? event.meta),
    ) ?? findProgressEntry(run, `progress:tool:${event.toolCallId}`)?.command;
    const narration = event.type === 'tool.started'
      ? inferToolNarration(event.name, command)
      : null;
    const nextEvents: ChatRuntimeEvent[] = [];
    if (narration && narration.key !== lastNarrationKey(run)) {
      nextEvents.push(buildProgressEntryEvent(event, {
        id: `progress:tool:${event.toolCallId}:commentary`,
        kind: 'commentary',
        text: narration.text,
        dedupeKey: narration.key,
        toolCallId: event.toolCallId,
        source: 'derived',
      }));
    }
    nextEvents.push(buildProgressEntryEvent(event, {
      id: `progress:tool:${event.toolCallId}`,
      kind: 'action',
      text: buildToolActionText(event.name, toolActionStatus(event), command),
      status: toolActionStatus(event),
      command,
      toolCallId: event.toolCallId,
      source: 'derived',
    }));
    const detail = event.type === 'tool.completed' ? buildToolStatusDetail(event) : undefined;
    if (detail) {
      nextEvents.push(buildProgressEntryEvent(event, {
        id: `progress:tool:${event.toolCallId}:status`,
        kind: 'status',
        text: detail,
        status: 'error',
        toolCallId: event.toolCallId,
        source: 'derived',
      }));
    }
    return [...recoveryEvents, ...nextEvents];
  }

  if (event.type === 'command.output' && !event.toolCallId) {
    const command = normalizeText(event.title) ?? normalizeText(event.name);
    const summarizedCommand = command ? summarizeShellCommand(command) : undefined;
    const status = commandOutputStatus(event);
    return [buildProgressEntryEvent(event, {
      id: `progress:${buildCommandTargetId(event)}`,
      kind: 'action',
      text: status === 'error' ? '执行失败' : status === 'completed' ? '已运行' : '正在执行',
      status,
      command: summarizedCommand,
      source: 'derived',
    })];
  }

  if (event.type === 'approval.updated') {
    const normalized = normalizeText(event.status)?.toLowerCase();
    if (!normalized || !PROBLEM_PROGRESS_STATUSES.has(normalized)) return [];
    const detail = normalizeText(event.message) ?? normalizeText(event.title);
    if (!detail) return [];
    return [buildProgressEntryEvent(event, {
      id: `progress:approval:${event.itemId ?? event.toolCallId ?? event.title ?? 'runtime'}`,
      kind: 'status',
      text: truncateText(redactSensitivePreview(detail), 180),
      status: normalized as ChatRuntimeProgressEntry['status'],
      toolCallId: event.toolCallId,
      source: 'derived',
    })];
  }

  return [];
}
