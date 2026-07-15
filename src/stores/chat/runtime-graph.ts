import type { ChatRuntimeEvent } from '../../../shared/chat-runtime-events';
import {
  extractImagesAsAttachedFiles,
  extractMediaRefs,
  extractRawFilePaths,
  getMessageText,
  makeAttachedFile,
} from './helpers';
import type { AttachedFileMeta, ChatRuntimeRunState } from './types';
import { unresolvedRuntimeTasks } from './runtime-task-recovery';

type RuntimeTaskUpdateEvent = Extract<ChatRuntimeEvent, { type: 'task.updated' }>;
type CompletionWakeEvidenceEvent = Extract<ChatRuntimeEvent, {
  type: 'artifact.produced' | 'verification.completed';
}>;

const COMPLETION_WAKE_RUN_ID_RE = /^(?:image_generate|image_edit|video_generate|music_generate):([^:]+):([^:]+)$/iu;

function completionWakeRunParts(runId: string): { taskId: string; outcome: string } | null {
  const match = COMPLETION_WAKE_RUN_ID_RE.exec(runId.trim());
  return match ? { taskId: match[1]!, outcome: match[2]!.trim().toLowerCase() } : null;
}

export function completionWakeTaskIdFromRunId(runId: string): string | null {
  return completionWakeRunParts(runId)?.taskId ?? null;
}

export function runtimeRunOwnsTaskId(
  run: ChatRuntimeRunState | undefined,
  taskId: string,
): boolean {
  if (!run || !taskId) return false;
  if ((run.tasks ?? []).some((task) => task.taskId === taskId)) return true;
  if ((run.progressEntries ?? []).some((entry) => entry.taskId === taskId)) return true;
  return Object.values(run.asyncTaskLedger ?? {}).some((entry) => entry.taskId === taskId);
}

function completionWakeOwnerScore(runId: string, run: ChatRuntimeRunState, taskId: string): number {
  let score = 0;
  if ((run.progressEntries ?? []).some((entry) => entry.kind === 'action' && entry.taskId === taskId)) score += 8;
  if (Object.values(run.asyncTaskLedger ?? {}).some((entry) => entry.taskId === taskId)) score += 4;
  if ((run.tasks ?? []).some((task) => task.taskId === taskId)) score += 2;
  if (!runId.startsWith('tool:')) score += 1;
  return score;
}

export function resolveCompletionWakeOwnerRunId(params: {
  runtimeRuns: Record<string, ChatRuntimeRunState>;
  activeRunId: string | null;
  eventRunId: string;
  currentSessionKey: string;
  eventSessionKey: string | null;
}): string | null {
  if (params.eventSessionKey && params.eventSessionKey !== params.currentSessionKey) return null;
  const taskId = completionWakeTaskIdFromRunId(params.eventRunId);
  if (!taskId) return null;
  const belongsToCurrentSession = (run: ChatRuntimeRunState): boolean => (
    !run.sessionKey || run.sessionKey === params.currentSessionKey
  );
  const activeRun = params.activeRunId ? params.runtimeRuns[params.activeRunId] : undefined;
  if (
    params.activeRunId
    && params.activeRunId !== params.eventRunId
    && activeRun
    && belongsToCurrentSession(activeRun)
    && runtimeRunOwnsTaskId(activeRun, taskId)
  ) {
    return params.activeRunId;
  }

  const owners = Object.entries(params.runtimeRuns)
    .filter(([runId, run]) => (
      runId !== params.eventRunId
      && belongsToCurrentSession(run)
      && runtimeRunOwnsTaskId(run, taskId)
    ))
    .sort(([leftId, left], [rightId, right]) => (
      completionWakeOwnerScore(rightId, right, taskId) - completionWakeOwnerScore(leftId, left, taskId)
    ));
  return owners[0]?.[0] ?? null;
}

/** Resolve a completion wake against its target session, including background sessions. */
export function resolveCompletionWakeOwnerContext(params: {
  runtimeRuns: Record<string, ChatRuntimeRunState>;
  activeRunId: string | null;
  currentSessionKey: string;
  eventRunId: string;
  eventSessionKey: string | null;
}): { ownerRunId: string; taskId: string; sessionKey: string } | null {
  const taskId = completionWakeTaskIdFromRunId(params.eventRunId);
  if (!taskId) return null;
  let sessionKey = params.eventSessionKey?.trim();
  if (!sessionKey) {
    const ownerSessionKeys = [...new Set(
      Object.entries(params.runtimeRuns)
        .filter(([runId, run]) => runId !== params.eventRunId && runtimeRunOwnsTaskId(run, taskId))
        .map(([, run]) => run.sessionKey?.trim())
        .filter((value): value is string => Boolean(value)),
    )];
    if (ownerSessionKeys.length === 1) {
      [sessionKey] = ownerSessionKeys;
    } else if (
      ownerSessionKeys.length === 0
      && params.activeRunId
      && runtimeRunOwnsTaskId(params.runtimeRuns[params.activeRunId], taskId)
    ) {
      sessionKey = params.currentSessionKey;
    }
  }
  if (!sessionKey) return null;
  const ownerRunId = resolveCompletionWakeOwnerRunId({
    runtimeRuns: params.runtimeRuns,
    activeRunId: sessionKey === params.currentSessionKey ? params.activeRunId : null,
    eventRunId: params.eventRunId,
    currentSessionKey: sessionKey,
    eventSessionKey: sessionKey,
  });
  return ownerRunId ? { ownerRunId, taskId, sessionKey } : null;
}

/** Preserve child wake identity while attaching runtime evidence to its owning conversation run. */
export function correlateCompletionWakeRuntimeEvent(params: {
  runtimeRuns: Record<string, ChatRuntimeRunState>;
  activeRunId: string | null;
  currentSessionKey: string;
  eventSessionKey: string | null;
  event: ChatRuntimeEvent;
}): ChatRuntimeEvent {
  const owner = resolveCompletionWakeOwnerContext({
    runtimeRuns: params.runtimeRuns,
    activeRunId: params.activeRunId,
    currentSessionKey: params.currentSessionKey,
    eventRunId: params.event.runId,
    eventSessionKey: params.eventSessionKey,
  });
  if (!owner) return params.event;
  return {
    ...params.event,
    rootRunId: params.event.rootRunId ?? owner.ownerRunId,
    sessionKey: params.event.sessionKey ?? owner.sessionKey,
    taskId: params.event.taskId ?? owner.taskId,
  };
}

export function buildCompletionWakeTerminalTaskEvent(params: {
  runtimeRuns: Record<string, ChatRuntimeRunState>;
  ownerRunId: string;
  eventRunId: string;
  sessionKey?: string;
  state: 'final' | 'error' | 'aborted';
  error?: string;
  ts?: number;
}): RuntimeTaskUpdateEvent | null {
  const parts = completionWakeRunParts(params.eventRunId);
  if (!parts || !runtimeRunOwnsTaskId(params.runtimeRuns[params.ownerRunId], parts.taskId)) return null;
  const existing = params.runtimeRuns[params.ownerRunId]?.tasks?.find((task) => task.taskId === parts.taskId);
  const outcomeSignalsAbort = /^(?:abort|aborted|cancel|cancelled|canceled|stop|stopped)$/iu.test(parts.outcome);
  const outcomeSignalsError = /^(?:error|err|fail|failed|failure|timeout|timed_out|timed-out)$/iu.test(parts.outcome);
  const terminalState = params.state === 'aborted' || outcomeSignalsAbort
    ? 'aborted'
    : params.state === 'error' || outcomeSignalsError
      ? 'error'
      : 'completed';
  const ts = params.ts ?? Date.now();
  return {
    contractVersion: 1,
    producer: 'renderer',
    type: 'task.updated',
    runId: params.eventRunId,
    sessionKey: params.sessionKey ?? params.runtimeRuns[params.ownerRunId]?.sessionKey,
    taskId: parts.taskId,
    taskStatus: terminalState === 'completed' ? 'completed' : 'error',
    ts,
    task: {
      ...existing,
      taskId: parts.taskId,
      title: existing?.title ?? 'Background task',
      status: terminalState === 'completed' ? 'completed' : 'error',
      sourceStatus: terminalState,
      deliveryStatus: terminalState === 'completed' ? 'delivered' : existing?.deliveryStatus,
      terminalOutcome: terminalState === 'completed' ? 'succeeded' : terminalState,
      detail: params.error?.trim() || existing?.detail,
      updatedAt: ts,
      endedAt: ts,
    },
  };
}

export function applyCompletionWakeEvidenceEventToOwners(
  currentRuns: Record<string, ChatRuntimeRunState>,
  event: CompletionWakeEvidenceEvent,
): {
  runtimeRuns: Record<string, ChatRuntimeRunState>;
  appliedEvents: CompletionWakeEvidenceEvent[];
} {
  const taskId = completionWakeTaskIdFromRunId(event.runId);
  const ownerRunIds = taskId
    ? Object.entries(currentRuns)
        .filter(([runId, run]) => (
          runId !== event.runId
          && (!event.sessionKey || !run.sessionKey || run.sessionKey === event.sessionKey)
          && runtimeRunOwnsTaskId(run, taskId)
        ))
        .map(([runId]) => runId)
    : [];
  const candidateEvents: CompletionWakeEvidenceEvent[] = [
    event,
    ...ownerRunIds.map((runId): CompletionWakeEvidenceEvent => {
      const common = {
        ...event,
        runId,
        sessionKey: currentRuns[runId]?.sessionKey ?? event.sessionKey,
        taskId: event.taskId ?? taskId ?? undefined,
      };
      return event.type === 'artifact.produced'
        ? {
            ...common,
            type: 'artifact.produced',
            artifact: {
              ...event.artifact,
              taskId: event.artifact.taskId ?? taskId ?? undefined,
            },
          }
        : {
            ...common,
            type: 'verification.completed',
            verification: {
              ...event.verification,
              taskId: event.verification.taskId ?? taskId ?? undefined,
            },
          };
    }),
  ];

  let runtimeRuns = currentRuns;
  const appliedEvents: CompletionWakeEvidenceEvent[] = [];
  for (const candidate of candidateEvents) {
    const previous = runtimeRuns;
    runtimeRuns = applyRuntimeEventToRuns(runtimeRuns, candidate);
    if (runtimeRuns !== previous) appliedEvents.push(candidate);
  }
  return { runtimeRuns, appliedEvents };
}

export function applyRuntimeTaskEventToOwners(
  currentRuns: Record<string, ChatRuntimeRunState>,
  event: RuntimeTaskUpdateEvent,
): {
  runtimeRuns: Record<string, ChatRuntimeRunState>;
  appliedEvents: RuntimeTaskUpdateEvent[];
} {
  const ownerRunIds = Object.entries(currentRuns)
    .filter(([runId, run]) => (
      runId !== event.runId
      && (!event.sessionKey || !run.sessionKey || run.sessionKey === event.sessionKey)
      && runtimeRunOwnsTaskId(run, event.task.taskId)
    ))
    .map(([runId]) => runId);
  const candidateEvents: RuntimeTaskUpdateEvent[] = [
    event,
    ...ownerRunIds.map((runId) => ({
      ...event,
      runId,
      sessionKey: currentRuns[runId]?.sessionKey ?? event.sessionKey,
    })),
  ];

  let runtimeRuns = currentRuns;
  const appliedEvents: RuntimeTaskUpdateEvent[] = [];
  for (const candidate of candidateEvents) {
    const previous = runtimeRuns;
    runtimeRuns = applyRuntimeEventToRuns(runtimeRuns, candidate);
    if (runtimeRuns !== previous) appliedEvents.push(candidate);
  }
  return { runtimeRuns, appliedEvents };
}

function runtimeTaskWasAborted(task: RuntimeTaskUpdateEvent['task']): boolean {
  const sourceStatus = task.sourceStatus?.trim().toLowerCase();
  const terminalOutcome = task.terminalOutcome?.trim().toLowerCase();
  return sourceStatus === 'aborted'
    || sourceStatus === 'cancelled'
    || sourceStatus === 'canceled'
    || sourceStatus === 'stopped'
    || sourceStatus === 'terminated'
    || terminalOutcome === 'aborted'
    || terminalOutcome === 'cancelled'
    || terminalOutcome === 'canceled';
}

export function settledRuntimeRunStatus(
  run: ChatRuntimeRunState | undefined,
): Extract<ChatRuntimeRunState['status'], 'completed' | 'error' | 'aborted'> | null {
  if (!run) return null;
  const tasks = unresolvedRuntimeTasks(run.tasks ?? []);
  const ledgerEntries = Object.values(run.asyncTaskLedger ?? {});
  const hasPendingTask = tasks.some((task) => (
    task.status === 'pending'
    || task.status === 'running'
    || task.status === 'waiting_approval'
  ));
  if (hasPendingTask || ledgerEntries.some((entry) => entry.status === 'pending')) return null;

  const failedTask = tasks.find((task) => (
    !runtimeTaskWasAborted(task)
    && (task.status === 'error'
      || task.status === 'partial'
      || task.terminalOutcome?.trim().toLowerCase() === 'blocked')
  ));
  const taskIds = new Set(tasks.map((task) => task.taskId));
  const hasUnprojectedLedgerError = ledgerEntries.some((entry) => (
    entry.status === 'error' && (!entry.taskId || !taskIds.has(entry.taskId))
  ));
  if (failedTask || hasUnprojectedLedgerError) return 'error';
  if (tasks.some(runtimeTaskWasAborted)) return 'aborted';
  return 'completed';
}

export function settledRuntimeRunError(run: ChatRuntimeRunState | undefined): string | undefined {
  const failedTask = unresolvedRuntimeTasks(run?.tasks ?? []).find((task) => (
    !runtimeTaskWasAborted(task)
    && (task.status === 'error'
      || task.status === 'partial'
      || task.terminalOutcome?.trim().toLowerCase() === 'blocked')
  ));
  if (failedTask?.detail?.trim()) return failedTask.detail.trim();
  if (failedTask?.title?.trim()) return `任务“${failedTask.title.trim()}”执行失败。`;
  if (Object.values(run?.asyncTaskLedger ?? {}).some((entry) => entry.status === 'error')) {
    return '异步任务执行失败。';
  }
  return undefined;
}

export function shouldFilterRuntimeExecutionGraphEvent(event: ChatRuntimeEvent): boolean {
  if (event.type === 'tool.started' || event.type === 'tool.updated' || event.type === 'tool.completed') {
    return event.name.trim().toLowerCase() === 'process';
  }
  if (event.type === 'command.output') {
    return event.name?.trim().toLowerCase() === 'process';
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function cloneRunState(runId: string, event: ChatRuntimeEvent): ChatRuntimeRunState {
  const eventTs = typeof event.ts === 'number' ? event.ts : Date.now();
  return {
    runId,
    sessionKey: event.sessionKey,
    status: event.type === 'run.ended' ? event.status : 'running',
    startedAt: event.type === 'run.started' ? event.startedAt : undefined,
    lastEventAt: eventTs,
    endedAt: event.type === 'run.ended' ? event.endedAt : undefined,
    objective: event.type === 'run.started' ? event.objective : undefined,
    planSummary: undefined,
    planSteps: [],
    tasks: [],
    artifacts: [],
    verifications: [],
    assistantText: '',
    thinkingText: '',
    progressEntries: [],
    events: [],
  };
}

function stableRuntimeFingerprint(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) return `[${value.map(stableRuntimeFingerprint).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableRuntimeFingerprint(child)}`)
    .join(',')}}`;
}

function sameRuntimeEvent(left: ChatRuntimeEvent | undefined, right: ChatRuntimeEvent): boolean {
  if (!left) return false;
  if (left.runId !== right.runId || left.type !== right.type) return false;
  if (left.type === 'tool.started') {
    return right.type === left.type && right.toolCallId === left.toolCallId;
  }
  if (left.type === 'tool.updated') {
    return right.type === left.type
      && right.toolCallId === left.toolCallId
      && stableRuntimeFingerprint(right.partialResult) === stableRuntimeFingerprint(left.partialResult);
  }
  if (left.type === 'tool.completed') {
    return right.type === left.type
      && right.toolCallId === left.toolCallId
      && right.isError === left.isError
      && stableRuntimeFingerprint(right.result) === stableRuntimeFingerprint(left.result)
      && stableRuntimeFingerprint(right.meta) === stableRuntimeFingerprint(left.meta);
  }
  if (left.type === 'command.output') {
    return right.type === left.type
      && right.toolCallId === left.toolCallId
      && right.itemId === left.itemId
      && right.phase === left.phase
      && right.output === left.output;
  }
  if (left.type === 'patch.completed') {
    return right.type === left.type && right.toolCallId === left.toolCallId && right.summary === left.summary;
  }
  if (left.type === 'approval.updated') {
    return right.type === left.type
      && right.toolCallId === left.toolCallId
      && right.status === left.status
      && right.phase === left.phase
      && right.message === left.message;
  }
  if (left.type === 'assistant.delta') {
    return right.type === left.type && right.text === left.text && right.delta === left.delta;
  }
  if (left.type === 'thinking.delta') {
    return right.type === left.type && right.text === left.text && right.delta === left.delta;
  }
  if (left.type === 'progress.update') {
    return right.type === left.type
      && stableRuntimeFingerprint(right.entry) === stableRuntimeFingerprint(left.entry);
  }
  if (left.type === 'run.started') return right.type === left.type;
  if (left.type === 'run.plan.updated') {
    return right.type === left.type
      && right.objective === left.objective
      && right.summary === left.summary
      && stableRuntimeFingerprint(right.steps) === stableRuntimeFingerprint(left.steps);
  }
  if (left.type === 'run.step.updated') {
    return right.type === left.type
      && stableRuntimeFingerprint(right.step) === stableRuntimeFingerprint(left.step);
  }
  if (left.type === 'task.updated') {
    return right.type === left.type
      && stableRuntimeFingerprint(right.task) === stableRuntimeFingerprint(left.task);
  }
  if (left.type === 'artifact.produced') {
    return right.type === left.type
      && stableRuntimeFingerprint(right.artifact) === stableRuntimeFingerprint(left.artifact);
  }
  if (left.type === 'verification.completed') {
    return right.type === left.type
      && stableRuntimeFingerprint(right.verification) === stableRuntimeFingerprint(left.verification);
  }
  if (left.type === 'run.ended') return right.type === left.type && right.status === left.status && right.endedAt === left.endedAt;
  return false;
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === next.id);
  if (existingIndex === -1) return [...items, next];
  return items.map((item, index) => (index === existingIndex ? { ...item, ...next } : item));
}

function upsertProgressEntry(
  items: NonNullable<ChatRuntimeRunState['progressEntries']>,
  next: NonNullable<ChatRuntimeRunState['progressEntries']>[number],
): NonNullable<ChatRuntimeRunState['progressEntries']> {
  const canMatchToolKind = Boolean(
    next.toolCallId && (next.kind === 'action' || next.kind === 'commentary'),
  );
  const existingIndex = items.findIndex((item) => (
    item.id === next.id
    || (canMatchToolKind && item.toolCallId === next.toolCallId && item.kind === next.kind)
  ));
  if (existingIndex === -1) return [...items, next];
  const existing = items[existingIndex]!;
  if (existing.source === 'native' && next.source !== 'native') return items;
  if (
    next.kind === 'action'
    && next.status === 'running'
    && (
      (existing.status != null && existing.status !== 'running')
      || (
        next.translationKey === 'runtimeProgress.toolRunning'
        && existing.translationKey === 'runtimeProgress.toolSubmitted'
      )
    )
  ) {
    return items;
  }
  const existingTerminal = existing.status != null && existing.status !== 'running';
  const nextRunning = next.status === 'running';
  const existingSubmitted = existing.status === 'running'
    && (existing.translationKey === 'runtimeProgress.toolSubmitted' || Boolean(existing.taskId));
  const nextPlainRunning = nextRunning
    && next.translationKey === 'runtimeProgress.toolRunning'
    && !next.taskId;
  if ((existingTerminal && nextRunning) || (existingSubmitted && nextPlainRunning)) return items;
  const merged = { ...existing };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  merged.id = existing.id;
  return items.map((item, index) => (index === existingIndex ? merged : item));
}

type RuntimeTaskProjection = NonNullable<ChatRuntimeRunState['tasks']>[number];

const TERMINAL_TASK_STATUSES = new Set<RuntimeTaskProjection['status']>(['completed', 'error', 'partial']);

function taskUpdatedAt(task: RuntimeTaskProjection, fallback?: number): number | undefined {
  if (typeof task.updatedAt === 'number' && Number.isFinite(task.updatedAt)) return task.updatedAt;
  if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback;
  return undefined;
}

function shouldApplyTaskUpdate(
  existing: RuntimeTaskProjection | undefined,
  incoming: RuntimeTaskProjection,
  eventTs?: number,
): boolean {
  if (!existing) return true;
  const existingUpdatedAt = taskUpdatedAt(existing);
  const incomingUpdatedAt = taskUpdatedAt(incoming, eventTs);
  if (existingUpdatedAt != null && incomingUpdatedAt != null && incomingUpdatedAt < existingUpdatedAt) {
    return false;
  }
  if (TERMINAL_TASK_STATUSES.has(existing.status) && !TERMINAL_TASK_STATUSES.has(incoming.status)) {
    return false;
  }
  return true;
}

function mergeTaskProjection(
  existing: RuntimeTaskProjection | undefined,
  incoming: RuntimeTaskProjection,
  eventTs?: number,
): RuntimeTaskProjection {
  const merged = { ...existing } as RuntimeTaskProjection;
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  merged.updatedAt = taskUpdatedAt(incoming, eventTs) ?? existing?.updatedAt;
  return merged;
}

function upsertTaskProjection(
  items: RuntimeTaskProjection[],
  next: RuntimeTaskProjection,
  eventTs?: number,
): RuntimeTaskProjection[] {
  const existingIndex = items.findIndex((item) => item.taskId === next.taskId);
  if (existingIndex === -1) return [...items, mergeTaskProjection(undefined, next, eventTs)];
  return items.map((item, index) => (
    index === existingIndex ? mergeTaskProjection(item, next, eventTs) : item
  ));
}

function updateTaskOnlyRunStatus(run: ChatRuntimeRunState): void {
  const hasExplicitRunLifecycle = run.events.some((event) => (
    event.type === 'run.started' || event.type === 'run.ended'
  ));
  if (hasExplicitRunLifecycle) return;
  const tasks = run.tasks ?? [];
  if (tasks.length === 0) return;
  const hasActiveTask = tasks.some((task) => (
    task.status === 'pending'
    || task.status === 'running'
    || task.status === 'waiting_approval'
  ));
  if (hasActiveTask) {
    run.status = 'running';
    run.endedAt = undefined;
    return;
  }
  run.status = tasks.some((task) => task.status === 'error') ? 'error' : 'completed';
  run.endedAt = Math.max(
    ...tasks.map((task) => task.endedAt ?? task.updatedAt ?? 0),
    run.lastEventAt ?? 0,
  ) || undefined;
}

function sortPlanSteps(steps: NonNullable<ChatRuntimeRunState['planSteps']>): NonNullable<ChatRuntimeRunState['planSteps']> {
  return [...steps].sort((left, right) => {
    const leftOrder = typeof left.order === 'number' ? left.order : Number.MAX_SAFE_INTEGER;
    const rightOrder = typeof right.order === 'number' ? right.order : Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.id.localeCompare(right.id);
  });
}

export function applyRuntimeEventToRuns(
  currentRuns: Record<string, ChatRuntimeRunState>,
  event: ChatRuntimeEvent,
): Record<string, ChatRuntimeRunState> {
  if (shouldFilterRuntimeExecutionGraphEvent(event)) {
    return currentRuns;
  }
  const existing = currentRuns[event.runId] ?? cloneRunState(event.runId, event);
  if (
    typeof event.seq === 'number'
    && existing.events.some((existingEvent) => (
      existingEvent.seq === event.seq && sameRuntimeEvent(existingEvent, event)
    ))
  ) {
    return currentRuns;
  }
  const eventTs = typeof event.ts === 'number' ? event.ts : Date.now();
  const existingTask = event.type === 'task.updated'
    ? existing.tasks?.find((task) => task.taskId === event.task.taskId)
    : undefined;
  if (
    event.type === 'task.updated'
    && !shouldApplyTaskUpdate(existingTask, event.task, eventTs)
  ) {
    return currentRuns;
  }
  const nextRun: ChatRuntimeRunState = {
    ...existing,
    sessionKey: event.sessionKey ?? existing.sessionKey,
    lastEventAt: Math.max(existing.lastEventAt ?? eventTs, eventTs),
    events: sameRuntimeEvent(existing.events.at(-1), event)
      ? existing.events
      : [...existing.events, event],
  };

  switch (event.type) {
    case 'run.started':
      nextRun.status = 'running';
      nextRun.startedAt = event.startedAt ?? nextRun.startedAt;
      nextRun.objective = event.objective ?? nextRun.objective;
      nextRun.endedAt = undefined;
      break;
    case 'run.plan.updated':
      nextRun.objective = event.objective ?? nextRun.objective;
      nextRun.planSummary = event.summary ?? nextRun.planSummary;
      nextRun.planSteps = sortPlanSteps(event.steps);
      break;
    case 'run.step.updated':
      nextRun.planSteps = sortPlanSteps(upsertById(nextRun.planSteps ?? [], event.step));
      break;
    case 'task.updated':
      nextRun.tasks = upsertTaskProjection(nextRun.tasks ?? [], event.task, eventTs);
      updateTaskOnlyRunStatus(nextRun);
      break;
    case 'run.ended':
      nextRun.status = event.status;
      nextRun.endedAt = event.endedAt ?? event.ts ?? Date.now();
      break;
    case 'artifact.produced':
      nextRun.artifacts = upsertById(nextRun.artifacts ?? [], {
        ...event.artifact,
        sourceToolCallId: event.artifact.sourceToolCallId ?? event.toolCallId,
      });
      break;
    case 'verification.completed':
      nextRun.verifications = upsertById(nextRun.verifications ?? [], event.verification);
      break;
    case 'assistant.delta': {
      const incoming = event.text ?? event.delta ?? '';
      if (incoming) {
        if (event.replace) {
          nextRun.assistantText = incoming;
        } else if (event.text) {
          nextRun.assistantText = event.text.startsWith(nextRun.assistantText)
            ? event.text
            : event.text;
        } else {
          nextRun.assistantText = `${nextRun.assistantText}${event.delta ?? ''}`;
        }
      }
      break;
    }
    case 'thinking.delta': {
      const incoming = event.text ?? event.delta ?? '';
      if (incoming) {
        if (event.text) {
          nextRun.thinkingText = event.text.startsWith(nextRun.thinkingText)
            ? event.text
            : event.text;
        } else {
          nextRun.thinkingText = `${nextRun.thinkingText}${event.delta ?? ''}`;
        }
      }
      break;
    }
    case 'progress.update':
      nextRun.progressEntries = upsertProgressEntry(nextRun.progressEntries ?? [], event.entry);
      break;
    default:
      break;
  }

  return {
    ...currentRuns,
    [event.runId]: nextRun,
  };
}

function collectRuntimeResultTexts(result: unknown, depth = 0, seen = new Set<object>()): string[] {
  const texts: string[] = [];
  if (depth > 4) return texts;
  if (typeof result === 'string' && result.trim()) {
    texts.push(result);
  }
  if (Array.isArray(result)) {
    const text = getMessageText(result);
    if (text.trim()) texts.push(text);
    for (const item of result) texts.push(...collectRuntimeResultTexts(item, depth + 1, seen));
  }
  const record = asRecord(result);
  if (!record) return texts;
  if (seen.has(record)) return texts;
  seen.add(record);
  try {
    const serialized = JSON.stringify(record);
    if (/(?:MEDIA:\s*|"(?:filePath|outputPath|media)"\s*:)/iu.test(serialized)) texts.push(serialized);
  } catch {
    // Continue with structured fields when a runtime result is not JSON-safe.
  }

  const candidates = [record.content, record.output, record.summary, record.error, record.stdout, record.stderr];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      texts.push(candidate);
      continue;
    }
    const text = getMessageText(candidate);
    if (text.trim()) texts.push(text);
  }
  for (const candidate of [record.result, record.details, record.meta]) {
    texts.push(...collectRuntimeResultTexts(candidate, depth + 1, seen));
  }

  return [...new Set(texts)];
}

function isTranscriptCompactionResult(value: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  const record = asRecord(value);
  if (!record) return false;
  if (record.summarizedForModel === true || record.summaryKind === 'tool_result_transcript_compaction') {
    return true;
  }
  return ['details', 'meta', 'result'].some((key) => isTranscriptCompactionResult(record[key], depth + 1));
}

const RAW_PATH_PRODUCER_TOOLS = /(?:write|create|edit|patch|save|export|generate|image|video|artifact|presentation|spreadsheet|document|ppt|excel|word|pdf)/iu;
const EXPLICIT_OUTPUT_CUE_RE = /(?:已(?:生成|创建|导出|保存|写入|制作)|产物(?:路径|文件)?|输出(?:到|文件|路径)|保存(?:到|为)|写入(?:到)?|(?:saved|wrote|written|created|generated|exported)\b)/iu;

export function extractToolCompletedFiles(event: ChatRuntimeEvent): AttachedFileMeta[] {
  if (event.type !== 'tool.completed') return [];
  if (isTranscriptCompactionResult(event.result) || isTranscriptCompactionResult(event.meta)) return [];

  const files: AttachedFileMeta[] = extractImagesAsAttachedFiles(event.result)
    .filter((file) => !file.mimeType.startsWith('image/'))
    .map((file) => (file.source ? file : { ...file, source: 'tool-result' as const }));

  const seenPaths = new Set(files.map((file) => file.filePath).filter(Boolean));
  const resultTexts = collectRuntimeResultTexts(event.result);
  const allowRawPaths = RAW_PATH_PRODUCER_TOOLS.test(event.name)
    || resultTexts.some((text) => EXPLICIT_OUTPUT_CUE_RE.test(text) || /\bMEDIA\s*:/iu.test(text));
  for (const text of resultTexts) {
    const mediaRefs = extractMediaRefs(text);
    const mediaRefPaths = new Set(mediaRefs.map((ref) => ref.filePath));
    for (const ref of mediaRefs) {
      if (seenPaths.has(ref.filePath)) continue;
      const file = makeAttachedFile(ref, 'tool-result');
      seenPaths.add(ref.filePath);
      files.push(file);
    }
    if (!allowRawPaths) continue;
    for (const ref of extractRawFilePaths(text)) {
      if (ref.mimeType.startsWith('image/')) continue;
      if (mediaRefPaths.has(ref.filePath) || seenPaths.has(ref.filePath)) continue;
      const file = makeAttachedFile(ref, 'tool-result');
      seenPaths.add(ref.filePath);
      files.push(file);
    }
  }

  return files;
}
