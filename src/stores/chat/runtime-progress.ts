import type {
  ChatRuntimeEvent,
  ChatRuntimeProgressEntry,
} from '../../../shared/chat-runtime-events';
import type { ChatRuntimeRunState } from './types';
import { sanitizeRuntimeDisplayText } from '../../lib/runtime-display-sanitizer';

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

type RuntimeToolEvent = Extract<ChatRuntimeEvent, { type: 'tool.started' | 'tool.completed' }>;

type RuntimeToolProgressContext = {
  outerName: string;
  name: string;
  label?: string;
  params: Record<string, unknown>;
  details: Record<string, unknown>;
  hidden: boolean;
  asyncStarted: boolean;
  taskId?: string;
};

const HIDDEN_TOOL_PROGRESS_NAMES = new Set([
  'tool_describe',
  'tool_search',
  'update_plan',
  'uclaw_get_runtime_capabilities',
  'uclaw_get_task_bridge_capabilities',
  'uclaw_get_host_task',
  'uclaw_list_host_tasks',
]);

const ASYNC_STARTED_STATUSES = new Set([
  'accepted',
  'pending',
  'queued',
  'running',
  'started',
  'submitted',
]);

function canonicalToolName(value: string | undefined | null): string {
  const normalized = normalizeText(value)?.toLowerCase() ?? '';
  return normalized.split(':').filter(Boolean).at(-1) ?? normalized;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  const normalized = value.trim();
  if (!normalized.startsWith('{')) return null;
  try {
    return asRecord(JSON.parse(normalized));
  } catch {
    return null;
  }
}

function structuredRecordFromUnknown(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') return parseJsonRecord(value);
  const record = asRecord(value);
  if (!record) return null;

  if (typeof record.summary === 'string') {
    const parsedSummary = parseJsonRecord(record.summary);
    if (parsedSummary) return parsedSummary;
  }
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      const partRecord = asRecord(part);
      if (typeof partRecord?.text !== 'string') continue;
      const parsedText = parseJsonRecord(partRecord.text);
      if (parsedText) return parsedText;
    }
  }
  return record;
}

function matchingToolStart(
  run: ChatRuntimeRunState | undefined,
  toolCallId: string,
): Extract<ChatRuntimeEvent, { type: 'tool.started' }> | undefined {
  const events = run?.events ?? [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    if (candidate?.type === 'tool.started' && candidate.toolCallId === toolCallId) return candidate;
  }
  return undefined;
}

function matchingDelegatedParentToolStart(
  run: ChatRuntimeRunState | undefined,
  delegatedParentToolCallId: string,
): Extract<ChatRuntimeEvent, { type: 'tool.started' }> | undefined {
  const exact = matchingToolStart(run, delegatedParentToolCallId);
  if (exact) return exact;

  const events = run?.events ?? [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    if (
      candidate?.type === 'tool.started'
      && candidate.toolCallId.replaceAll('|', '_') === delegatedParentToolCallId
    ) {
      return candidate;
    }
  }
  return undefined;
}

function firstRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const candidate = asRecord(record[key]);
    if (candidate) return candidate;
  }
  return null;
}

function firstString(record: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const candidate = normalizeText(typeof record[key] === 'string' ? record[key] as string : undefined);
    if (candidate) return candidate;
  }
  return undefined;
}

function resolveRuntimeToolProgressContext(
  run: ChatRuntimeRunState | undefined,
  event: RuntimeToolEvent,
): RuntimeToolProgressContext {
  const started = event.type === 'tool.started' ? event : matchingToolStart(run, event.toolCallId);
  const outerName = canonicalToolName(started?.name ?? event.name);
  const invocationArgs = asRecord(started?.args) ?? {};
  const wrapperParams = firstRecord(invocationArgs, ['args', 'arguments', 'params', 'input']);
  const params = outerName === 'tool_call' && wrapperParams ? wrapperParams : invocationArgs;

  const resultEnvelope = event.type === 'tool.completed'
    ? structuredRecordFromUnknown(event.result)
    : null;
  const metaEnvelope = event.type === 'tool.completed'
    ? structuredRecordFromUnknown(event.meta)
    : null;
  const completionEnvelope = resultEnvelope ?? metaEnvelope;
  const delegatedResult = completionEnvelope
    ? asRecord(completionEnvelope.result) ?? completionEnvelope
    : null;
  const toolRecord = completionEnvelope
    ? asRecord(completionEnvelope.tool)
      ?? asRecord(delegatedResult?.tool)
      ?? asRecord(metaEnvelope?.tool)
    : null;
  const rootDetails = (record: Record<string, unknown> | null): Record<string, unknown> | null => (
    record && ['async', 'status', 'state', 'taskId', 'task_id'].some((key) => key in record)
      ? record
      : null
  );
  const details = delegatedResult
    ? asRecord(delegatedResult.details)
      ?? asRecord(completionEnvelope?.details)
      ?? asRecord(asRecord(delegatedResult.result)?.details)
      ?? asRecord(metaEnvelope?.details)
      ?? rootDetails(metaEnvelope)
      ?? rootDetails(delegatedResult)
      ?? {}
    : {};

  const wrapperTarget = outerName === 'tool_call'
    ? firstString(invocationArgs, ['id', 'toolName', 'tool_name', 'name'])
    : undefined;
  const name = canonicalToolName(
    firstString(toolRecord, ['name', 'id', 'toolName', 'tool_name'])
      ?? wrapperTarget
      ?? outerName,
  );
  const label = firstString(toolRecord, ['label', 'title']);
  const status = firstString(details, ['status', 'state'])?.toLowerCase();
  const asyncStarted = details.async === true && Boolean(status && ASYNC_STARTED_STATUSES.has(status));
  const action = firstString(params, ['action'])?.toLowerCase();

  return {
    outerName,
    name,
    label,
    params,
    details,
    hidden: outerName === 'tool_describe'
      || outerName === 'tool_search'
      || (name === 'video_generate' && action === 'list')
      || HIDDEN_TOOL_PROGRESS_NAMES.has(name),
    asyncStarted,
    taskId: firstString(details, ['taskId', 'task_id']),
  };
}

function truncateText(value: string, maxChars = 140): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
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

function commandFromRecord(record: Record<string, unknown>): string | undefined {
  const command = normalizeText(typeof record.command === 'string' ? record.command : undefined)
    ?? normalizeText(typeof record.cmd === 'string' ? record.cmd : undefined)
    ?? normalizeText(typeof record.script === 'string' ? record.script : undefined);
  if (command) return summarizeShellCommand(command);

  const path = normalizeText(typeof record.path === 'string' ? record.path : undefined)
    ?? normalizeText(typeof record.filePath === 'string' ? record.filePath : undefined)
    ?? normalizeText(typeof record.url === 'string' ? record.url : undefined);
  if (path) {
    if (/^https?:\/\//iu.test(path)) return truncateText(sanitizeRuntimeDisplayText(path), 160);
    return summarizePathLike(path);
  }

  const nestedArgs = asRecord(record.args);
  if (nestedArgs) return commandFromRecord(nestedArgs);
  const nestedInput = asRecord(record.input);
  if (nestedInput) return commandFromRecord(nestedInput);
  return undefined;
}

function mediaProgressSummary(
  params: Record<string, unknown>,
  details: Record<string, unknown>,
): string | undefined {
  const values = { ...params, ...details };
  const parts: string[] = [];
  if (typeof values.durationSeconds === 'number' && Number.isFinite(values.durationSeconds)) {
    parts.push(`${Math.max(1, Math.round(values.durationSeconds))}s`);
  }
  const size = firstString(values, ['size']);
  const resolution = firstString(values, ['resolution']);
  const aspectRatio = firstString(values, ['aspectRatio', 'aspect_ratio']);
  if (size) parts.push(size);
  if (resolution && resolution.toLowerCase() !== size?.toLowerCase()) parts.push(resolution);
  if (aspectRatio) parts.push(aspectRatio);
  if (values.audio === true) parts.push('audio');
  if (values.audio === false) parts.push('no audio');
  return parts.length > 0 ? truncateText(parts.join(' · '), 140) : undefined;
}

function buildToolProgressCommand(context: RuntimeToolProgressContext): string | undefined {
  const command = commandFromRecord(context.params);
  if (command) return command;

  const query = firstString(context.params, ['query', 'searchQuery', 'search_query']);
  if (query) return truncateText(sanitizeRuntimeDisplayText(query), 160);

  if (context.name === 'image_generate' || context.name === 'image_edit' || context.name === 'video_generate') {
    return mediaProgressSummary(context.params, context.details);
  }

  const filename = firstString(context.details, ['filename', 'fileName', 'file_name'])
    ?? firstString(context.params, ['filename', 'fileName', 'file_name']);
  return filename ? summarizePathLike(filename) : undefined;
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

function canonicalProgressToolCallId(
  run: ChatRuntimeRunState | undefined,
  event: RuntimeToolEvent,
): string {
  const nested = /^tool_search_code:(.+):([^:]+):\d+$/u.exec(event.toolCallId);
  if (!nested) return event.toolCallId;
  const parentStart = matchingDelegatedParentToolStart(run, nested[1]);
  if (!parentStart) return event.toolCallId;
  const parentContext = resolveRuntimeToolProgressContext(run, parentStart);
  const childToolName = canonicalToolName(nested[2]);
  return parentContext.outerName === 'tool_call' && parentContext.name === childToolName
    ? parentStart.toolCallId
    : event.toolCallId;
}

function hasNativeToolProgress(
  run: ChatRuntimeRunState | undefined,
  event: RuntimeToolEvent,
): boolean {
  const canonicalToolCallId = canonicalProgressToolCallId(run, event);
  return (run?.progressEntries ?? []).some((entry) => (
    entry.toolCallId === canonicalToolCallId && entry.kind === 'action' && entry.source === 'native'
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

type ToolProgressSemanticState =
  | 'running'
  | 'completed'
  | 'submitted'
  | 'error'
  | 'blocked'
  | 'aborted'
  | 'partial'
  | 'waitingApproval';

function fallbackToolLabel(context: RuntimeToolProgressContext): string {
  return context.label ?? (context.name.replace(/[_-]+/gu, ' ').trim() || 'tool');
}

function toolSemanticState(
  event: RuntimeToolEvent,
  context: RuntimeToolProgressContext,
): ToolProgressSemanticState {
  if (event.type === 'tool.started') return 'running';
  const status = firstString(context.details, ['status', 'state'])?.toLowerCase();
  if (status && /^(?:aborted|cancelled|canceled|stopped|terminated)$/u.test(status)) return 'aborted';
  if (status && /^(?:blocked|waiting_approval|approval_required|pending_approval)$/u.test(status)) return 'blocked';
  // Tool failures are retained in the runtime event stream for orchestration
  // and diagnostics, but the chat timeline only communicates that the tool ran.
  // The assistant's final reply is the user-facing place for any actionable
  // failure explanation.
  if (event.isError || (status && /^(?:error|failed|failure|timed_out|timeout)$/u.test(status))) return 'completed';
  if (context.asyncStarted) return 'submitted';
  return 'completed';
}

function semanticStateForTask(
  task: NonNullable<ChatRuntimeRunState['tasks']>[number],
): ToolProgressSemanticState | undefined {
  const sourceStatus = normalizeText(task.sourceStatus)?.toLowerCase();
  const terminalOutcome = normalizeText(task.terminalOutcome)?.toLowerCase();
  if (sourceStatus && /^(?:aborted|cancelled|canceled|stopped|terminated)$/u.test(sourceStatus)) return 'aborted';
  if (terminalOutcome && /^(?:aborted|cancelled|canceled)$/u.test(terminalOutcome)) return 'aborted';
  // OpenClaw can represent an intermediate artifact as a succeeded task with
  // terminalOutcome=blocked. The terminal outcome remains authoritative.
  if (terminalOutcome && /^(?:partial|blocked|partially_completed|partial_failure)$/u.test(terminalOutcome)) return 'partial';
  if (task.status === 'partial') return 'partial';
  if (task.status === 'completed') return 'completed';
  if (task.status === 'error') return 'error';
  if (task.status === 'waiting_approval') return 'waitingApproval';
  return undefined;
}

function progressStatusForSemanticState(state: ToolProgressSemanticState): ChatRuntimeProgressEntry['status'] {
  if (state === 'error') return 'error';
  if (state === 'aborted') return 'aborted';
  if (state === 'blocked' || state === 'partial' || state === 'waitingApproval') return 'blocked';
  if (state === 'running' || state === 'submitted') return 'running';
  return 'completed';
}

function translationKeyForSemanticState(state: ToolProgressSemanticState): string {
  if (state === 'error') return 'runtimeProgress.toolFailed';
  if (state === 'blocked') return 'runtimeProgress.toolBlocked';
  if (state === 'aborted') return 'runtimeProgress.toolAborted';
  if (state === 'partial') return 'runtimeProgress.toolPartial';
  if (state === 'waitingApproval') return 'runtimeProgress.toolWaitingApproval';
  if (state === 'submitted') return 'runtimeProgress.toolSubmitted';
  if (state === 'running') return 'runtimeProgress.toolRunning';
  return 'runtimeProgress.toolCompleted';
}

function fallbackTextForSemanticState(
  state: ToolProgressSemanticState,
  context: RuntimeToolProgressContext,
): string {
  const label = fallbackToolLabel(context);
  if (state === 'error') return `执行失败：${label}`;
  if (state === 'blocked') return `需要处理：${label}`;
  if (state === 'aborted') return `已停止：${label}`;
  if (state === 'partial') return `部分完成：${label}`;
  if (state === 'waitingApproval') return `等待批准：${label}`;
  if (state === 'submitted') return `已提交：${label}`;
  if (state === 'running') return `正在执行：${label}`;
  return `已完成：${label}`;
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
  const family = toolRecoveryFamily(resolveRuntimeToolProgressContext(run, event).name);
  if (!family) return [];
  const recovered = (run?.events ?? []).filter((candidate): candidate is Extract<ChatRuntimeEvent, { type: 'tool.completed' }> => (
    candidate.type === 'tool.completed'
    && candidate.isError === true
    && toolRecoveryFamily(resolveRuntimeToolProgressContext(run, candidate).name) === family
    && candidate.toolCallId !== event.toolCallId
  ));
  return recovered.flatMap((failedEvent) => {
    const progressToolCallId = canonicalProgressToolCallId(run, failedEvent);
    const existing = findProgressEntry(run, `progress:tool:${progressToolCallId}`);
    return [
      buildProgressEntryEvent(event, {
        id: `progress:tool:${progressToolCallId}`,
        kind: 'action',
        text: family === 'designed_pptx_file' ? '版式问题已修复' : '重试已成功',
        status: 'completed',
        command: existing?.command,
        toolCallId: progressToolCallId,
        source: 'derived',
      }),
      buildProgressEntryEvent(event, {
        id: `progress:tool:${progressToolCallId}:status`,
        kind: 'status',
        text: family === 'designed_pptx_file' ? '增量修复已通过完整质量检查' : '后续重试已恢复该步骤',
        status: 'completed',
        toolCallId: progressToolCallId,
        source: 'derived',
      }),
    ];
  });
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

function taskBoundToolProgressEntry(
  run: ChatRuntimeRunState | undefined,
  taskId: string,
): ChatRuntimeProgressEntry | undefined {
  const entries = run?.progressEntries ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === 'action' && entry.taskId === taskId && entry.toolName) return entry;
  }
  return undefined;
}

function buildTaskProgressEvents(
  run: ChatRuntimeRunState | undefined,
  event: Extract<ChatRuntimeEvent, { type: 'task.updated' }>,
): ChatRuntimeEvent[] {
  const task = run?.tasks?.find((candidate) => candidate.taskId === event.task.taskId);
  if (!task || task.status !== event.task.status) return [];
  const authoritativeUpdatedAt = typeof task.updatedAt === 'number' ? task.updatedAt : undefined;
  const incomingUpdatedAt = typeof event.task.updatedAt === 'number' ? event.task.updatedAt : undefined;
  if (authoritativeUpdatedAt != null && incomingUpdatedAt != null && incomingUpdatedAt < authoritativeUpdatedAt) {
    return [];
  }
  const existing = taskBoundToolProgressEntry(run, task.taskId);
  if (!existing) return [];
  const semanticState = semanticStateForTask(task);
  if (!semanticState) return [];
  const context: RuntimeToolProgressContext = {
    outerName: existing.toolName ?? 'tool',
    name: existing.toolName ?? 'tool',
    label: existing.toolLabel,
    params: {},
    details: {},
    hidden: false,
    asyncStarted: false,
    taskId: task.taskId,
  };
  const status = progressStatusForSemanticState(semanticState);
  const actionEvent = buildProgressEntryEvent(event, {
    ...existing,
    // The initial async tool event contains requested parameters. Once the
    // detached task reaches a terminal state, those values are not evidence
    // of what the provider actually produced. Keep the action readable and
    // show authoritative facts in the task-status detail below instead.
    ...(semanticState === 'completed' || semanticState === 'partial' || semanticState === 'error'
      ? { command: '' }
      : {}),
    text: fallbackTextForSemanticState(semanticState, context),
    status,
    translationKey: translationKeyForSemanticState(semanticState),
    source: existing.source,
  });
  const detail = normalizeText(task.detail);
  if (!detail || semanticState === 'completed') return [actionEvent];
  return [actionEvent, buildProgressEntryEvent(event, {
    id: `${existing.id}:task-status`,
    kind: 'status',
    text: truncateText(sanitizeRuntimeDisplayText(detail), 180),
    status,
    toolCallId: existing.toolCallId,
    taskId: event.task.taskId,
    source: 'derived',
  })];
}

export function buildRuntimeProgressEvents(
  run: ChatRuntimeRunState | undefined,
  event: ChatRuntimeEvent,
): ChatRuntimeEvent[] {
  if (event.type === 'progress.update') return [];

  if (event.type === 'task.updated') {
    return buildTaskProgressEvents(run, event);
  }

  if (event.type === 'tool.started' || event.type === 'tool.completed') {
    const recoveryEvents = event.type === 'tool.completed'
      ? recoveredToolProgressEvents(run, event)
      : [];
    const context = resolveRuntimeToolProgressContext(run, event);
    if (context.hidden) return recoveryEvents;
    if (hasNativeToolProgress(run, event)) return recoveryEvents;
    if (
      event.type === 'tool.started'
      && run?.events.some((candidate) => (
        candidate.type === 'tool.completed' && candidate.toolCallId === event.toolCallId
      ))
    ) {
      return recoveryEvents;
    }
    const progressToolCallId = canonicalProgressToolCallId(run, event);
    const command = buildToolProgressCommand(context)
      ?? findProgressEntry(run, `progress:tool:${progressToolCallId}`)?.command;
    const narration = event.type === 'tool.started'
      ? inferToolNarration(context.name, command)
      : null;
    const knownTask = context.taskId
      ? run?.tasks?.find((task) => task.taskId === context.taskId)
      : undefined;
    const semanticState = knownTask
      ? semanticStateForTask(knownTask) ?? toolSemanticState(event, context)
      : toolSemanticState(event, context);
    const nextEvents: ChatRuntimeEvent[] = [];
    if (narration && narration.key !== lastNarrationKey(run)) {
      nextEvents.push(buildProgressEntryEvent(event, {
        id: `progress:tool:${progressToolCallId}:commentary`,
        kind: 'commentary',
        text: narration.text,
        dedupeKey: narration.key,
        toolCallId: progressToolCallId,
        source: 'derived',
      }));
    }
    nextEvents.push(buildProgressEntryEvent(event, {
      id: `progress:tool:${progressToolCallId}`,
      kind: 'action',
      text: fallbackTextForSemanticState(semanticState, context),
      status: progressStatusForSemanticState(semanticState),
      translationKey: translationKeyForSemanticState(semanticState),
      translationParams: { tool: fallbackToolLabel(context) },
      toolName: context.name,
      toolLabel: context.label,
      command: undefined,
      toolCallId: progressToolCallId,
      taskId: context.taskId,
      source: 'derived',
    }));
    return [...recoveryEvents, ...nextEvents];
  }

  if (event.type === 'command.output') return [];

  if (event.type === 'approval.updated') {
    const normalized = normalizeText(event.status)?.toLowerCase();
    if (!normalized || !PROBLEM_PROGRESS_STATUSES.has(normalized)) return [];
    const detail = normalizeText(event.message) ?? normalizeText(event.title);
    if (!detail) return [];
    return [buildProgressEntryEvent(event, {
      id: `progress:approval:${event.itemId ?? event.toolCallId ?? event.title ?? 'runtime'}`,
      kind: 'status',
      text: truncateText(sanitizeRuntimeDisplayText(detail), 180),
      status: normalized as ChatRuntimeProgressEntry['status'],
      toolCallId: event.toolCallId,
      source: 'derived',
    })];
  }

  return [];
}
