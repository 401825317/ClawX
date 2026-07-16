import {
  asyncTaskEvidenceMatches,
  mergeAsyncTaskLedgerEntry,
} from '../../stores/chat/helpers';
import type { AsyncTaskLedgerEntry, ChatRuntimeRunState } from '../../stores/chat/types';
import { sanitizeRuntimeDisplayText } from '../../lib/runtime-display-sanitizer';
import { unresolvedRuntimeTasks } from '../../stores/chat/runtime-task-recovery';

function toTimestampMs(value: number | undefined | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < 1e12 ? value * 1000 : value;
}

function getRuntimeEventMs(event: ChatRuntimeRunState['events'][number]): number | null {
  const direct = toTimestampMs(event.ts);
  if (direct != null) return direct;
  if (event.type === 'run.started') return toTimestampMs(event.startedAt);
  if (event.type === 'run.ended') return toTimestampMs(event.endedAt);
  return null;
}

function getRunFirstEventMs(run: ChatRuntimeRunState): number | null {
  const startedAt = toTimestampMs(run.startedAt);
  const eventTimes = run.events
    .map(getRuntimeEventMs)
    .filter((value): value is number => value != null);
  const firstEventAt = eventTimes.length > 0 ? Math.min(...eventTimes) : null;
  if (startedAt == null) return firstEventAt;
  if (firstEventAt == null) return startedAt;
  return Math.min(startedAt, firstEventAt);
}

function getRunLastEventMs(run: ChatRuntimeRunState): number | null {
  const lastEventAt = toTimestampMs(run.lastEventAt);
  const endedAt = toTimestampMs(run.endedAt);
  const eventTimes = run.events
    .map(getRuntimeEventMs)
    .filter((value): value is number => value != null);
  const latest = [lastEventAt, endedAt, ...eventTimes]
    .filter((value): value is number => value != null);
  return latest.length > 0 ? Math.max(...latest) : null;
}

function getRunTerminalMs(run: ChatRuntimeRunState): number | null {
  const matchingTerminalTimes = run.events
    .filter((event) => event.type === 'run.ended' && event.status === run.status)
    .map(getRuntimeEventMs)
    .filter((value): value is number => value != null);
  if (matchingTerminalTimes.length > 0) return Math.max(...matchingTerminalTimes);
  return toTimestampMs(run.endedAt) ?? toTimestampMs(run.lastEventAt);
}

function taskSignalsAbort(task: NonNullable<ChatRuntimeRunState['tasks']>[number]): boolean {
  return [task.sourceStatus, task.terminalOutcome]
    .some((value) => /^(?:aborted|cancelled|canceled)$/iu.test(value?.trim() ?? ''));
}

function resolveMergedRunStatus(
  runs: ChatRuntimeRunState[],
  authoritativeRunId: string | undefined,
): ChatRuntimeRunState['status'] {
  const unresolvedTasks = unresolvedRuntimeTasks(runs.flatMap((run) => run.tasks ?? []));
  const detachedTaskIds = new Set(
    runs
      .flatMap((run) => Object.values(run.asyncTaskLedger ?? {}))
      .map((entry) => entry.taskId)
      .filter((taskId): taskId is string => Boolean(taskId)),
  );
  const detachedProblems = unresolvedTasks.filter((task) => (
    detachedTaskIds.has(task.taskId)
    && (task.status === 'error' || task.status === 'partial' || taskSignalsAbort(task))
  ));
  if (detachedProblems.some((task) => task.status === 'error')) return 'error';
  if (detachedProblems.some((task) => task.status === 'partial')) return 'error';
  if (detachedProblems.some(taskSignalsAbort)) return 'aborted';
  if (runs.some((run) => run.status === 'running')) return 'running';

  const authoritativeRun = runs.find((run) => run.runId === authoritativeRunId) ?? runs[0]!;
  if (authoritativeRun.status !== 'completed') return authoritativeRun.status;

  const completedAt = getRunTerminalMs(authoritativeRun);
  if (completedAt == null) return authoritativeRun.status;

  const unresolvedTaskIds = new Set(
    unresolvedTasks
      .filter((task) => task.status === 'error' || task.status === 'partial' || taskSignalsAbort(task))
      .map((task) => task.taskId),
  );
  const laterProblems = runs
    .filter((run) => run.runId !== authoritativeRun.runId)
    .filter((run) => run.status === 'error' || run.status === 'aborted')
    .filter((run) => (getRunTerminalMs(run) ?? Number.NEGATIVE_INFINITY) > completedAt)
    .filter((run) => {
      const problemTasks = (run.tasks ?? []).filter((task) => (
        task.status === 'error' || task.status === 'partial' || taskSignalsAbort(task)
      ));
      return problemTasks.length === 0
        || problemTasks.some((task) => unresolvedTaskIds.has(task.taskId));
    })
    .sort((left, right) => (
      (getRunTerminalMs(right) ?? Number.NEGATIVE_INFINITY)
      - (getRunTerminalMs(left) ?? Number.NEGATIVE_INFINITY)
    ));
  return laterProblems[0]?.status ?? 'completed';
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  return items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item));
}

function upsertRuntimeTask(
  items: NonNullable<ChatRuntimeRunState['tasks']>,
  next: NonNullable<ChatRuntimeRunState['tasks']>[number],
): NonNullable<ChatRuntimeRunState['tasks']> {
  const index = items.findIndex((item) => item.taskId === next.taskId);
  if (index === -1) return [...items, next];
  return items.map((item, itemIndex) => {
    if (itemIndex !== index) return item;
    const existingUpdatedAt = typeof item.updatedAt === 'number' ? item.updatedAt : 0;
    const nextUpdatedAt = typeof next.updatedAt === 'number' ? next.updatedAt : 0;
    const existingTerminal = item.status === 'completed' || item.status === 'error';
    const nextTerminal = next.status === 'completed' || next.status === 'error';
    const keepExisting = (existingTerminal && !nextTerminal) || nextUpdatedAt < existingUpdatedAt;
    return keepExisting
      ? { ...next, ...item, updatedAt: Math.max(existingUpdatedAt, nextUpdatedAt) || undefined }
      : { ...item, ...next, updatedAt: Math.max(existingUpdatedAt, nextUpdatedAt) || undefined };
  });
}

function upsertAsyncTaskLedgerEntry(
  entries: Record<string, AsyncTaskLedgerEntry>,
  key: string,
  next: AsyncTaskLedgerEntry,
): Record<string, AsyncTaskLedgerEntry> {
  const matchedKey = entries[key]
    ? key
    : Object.entries(entries).find(([, entry]) => asyncTaskEvidenceMatches(entry, next))?.[0];
  const targetKey = matchedKey ?? key;
  return {
    ...entries,
    [targetKey]: mergeAsyncTaskLedgerEntry(entries[targetKey], next),
  };
}

function synchronizeProgressWithTasks(
  entries: NonNullable<ChatRuntimeRunState['progressEntries']>,
  tasks: NonNullable<ChatRuntimeRunState['tasks']>,
): NonNullable<ChatRuntimeRunState['progressEntries']> {
  const nextEntries = [...entries];
  for (const task of tasks) {
    const actionIndex = nextEntries.findIndex((entry) => (
      entry.kind === 'action' && entry.taskId === task.taskId
    ));
    if (actionIndex < 0) continue;
    const action = nextEntries[actionIndex]!;
    const sourceStatus = task.sourceStatus?.toLowerCase();
    const terminalOutcome = task.terminalOutcome?.toLowerCase();
    const aborted = sourceStatus === 'aborted'
      || sourceStatus === 'cancelled'
      || sourceStatus === 'canceled'
      || terminalOutcome === 'aborted'
      || terminalOutcome === 'cancelled'
      || terminalOutcome === 'canceled';
    const status = aborted
      ? 'aborted'
      : task.status === 'error'
        ? 'error'
        : task.status === 'partial' || task.status === 'waiting_approval'
          || terminalOutcome === 'partial' || terminalOutcome === 'blocked'
          ? 'blocked'
          : task.status === 'completed'
            ? 'completed'
            : 'running';
    const label = action.toolLabel ?? action.toolName ?? 'tool';
    const text = status === 'error'
      ? `执行失败：${label}`
      : status === 'aborted'
        ? `已停止：${label}`
        : task.status === 'waiting_approval'
          ? `等待批准：${label}`
          : task.status === 'partial' || terminalOutcome === 'partial' || terminalOutcome === 'blocked'
            ? `部分完成：${label}`
          : status === 'completed'
            ? `已完成：${label}`
            : action.text;
    nextEntries[actionIndex] = {
      ...action,
      text,
      status,
      translationKey: status === 'error'
        ? 'runtimeProgress.toolFailed'
        : status === 'aborted'
          ? 'runtimeProgress.toolAborted'
          : task.status === 'waiting_approval'
            ? 'runtimeProgress.toolWaitingApproval'
          : task.status === 'partial' || terminalOutcome === 'partial' || terminalOutcome === 'blocked'
              ? 'runtimeProgress.toolPartial'
            : status === 'completed'
              ? 'runtimeProgress.toolCompleted'
              : action.translationKey,
    };
    if (status === 'completed' || status === 'blocked' || status === 'error') {
      // The command on the initial async entry is requested input, not
      // authoritative output. Remove it once the detached task terminates;
      // the terminal detail carries actual provider facts instead.
      nextEntries[actionIndex] = { ...nextEntries[actionIndex]!, command: '' };
    }
    const existingDetailIndex = nextEntries.findIndex((entry) => entry.id === `${action.id}:task-status`);
    if (task.detail && existingDetailIndex < 0) {
      nextEntries.push({
        id: `${action.id}:task-status`,
        kind: 'status',
        text: sanitizeRuntimeDisplayText(task.detail),
        status: status === 'aborted' ? 'aborted' : status,
        toolCallId: action.toolCallId,
        taskId: task.taskId,
        source: 'derived',
      });
    } else if (task.detail && existingDetailIndex >= 0) {
      nextEntries[existingDetailIndex] = {
        ...nextEntries[existingDetailIndex]!,
        text: sanitizeRuntimeDisplayText(task.detail),
        status: status === 'aborted' ? 'aborted' : status,
      };
    }
  }
  return nextEntries;
}

function runtimeTaskAliases(run: ChatRuntimeRunState): Set<string> {
  const aliases = new Set<string>();
  const add = (value: string | undefined): void => {
    if (!value) return;
    aliases.add(value);
    const leaf = value.split(':').pop();
    if (leaf) aliases.add(leaf);
  };
  const addDistinctChildSession = (value: string | undefined): void => {
    if (!value) return;
    const sessionKey = run.sessionKey?.trim();
    const childSessionKey = value.trim();
    if (!childSessionKey) return;
    const sessionLeaf = sessionKey?.split(':').pop();
    const childLeaf = childSessionKey.split(':').pop();
    if (
      sessionKey
      && (childSessionKey === sessionKey || (sessionLeaf && childLeaf === sessionLeaf))
    ) {
      return;
    }
    add(childSessionKey);
  };
  for (const entry of Object.values(run.asyncTaskLedger ?? {})) {
    add(entry.taskId);
    add(entry.runId);
    addDistinctChildSession(entry.childSessionKey);
    add(entry.childSessionId);
  }
  for (const task of run.tasks ?? []) {
    add(task.taskId);
    addDistinctChildSession(task.childSessionKey);
  }
  return aliases;
}

export function runtimeRunsShareTaskIdentity(
  left: ChatRuntimeRunState,
  right: ChatRuntimeRunState,
): boolean {
  const leftAliases = runtimeTaskAliases(left);
  if (leftAliases.size === 0) return false;
  return [...runtimeTaskAliases(right)].some((alias) => leftAliases.has(alias));
}

export function mergeRuntimeRunStates(
  runId: string,
  sessionKey: string,
  runs: ChatRuntimeRunState[],
  authoritativeRunId?: string,
): ChatRuntimeRunState | null {
  if (runs.length === 0) return null;
  if (runs.length === 1) return runs[0];

  const sortedRuns = [...runs].sort((left, right) => {
    const leftStart = getRunFirstEventMs(left) ?? Number.MAX_SAFE_INTEGER;
    const rightStart = getRunFirstEventMs(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftStart !== rightStart) return leftStart - rightStart;
    return left.runId.localeCompare(right.runId);
  });
  const events = sortedRuns
    .flatMap((run) => run.events)
    .sort((left, right) => {
      const leftTs = getRuntimeEventMs(left) ?? Number.MAX_SAFE_INTEGER;
      const rightTs = getRuntimeEventMs(right) ?? Number.MAX_SAFE_INTEGER;
      if (leftTs !== rightTs) return leftTs - rightTs;
      return left.runId.localeCompare(right.runId);
    });
  const startedAt = sortedRuns
    .map(getRunFirstEventMs)
    .filter((value): value is number => value != null)
    .sort((left, right) => left - right)[0];
  const lastEventAt = sortedRuns
    .map(getRunLastEventMs)
    .filter((value): value is number => value != null)
    .sort((left, right) => right - left)[0];
  const status = resolveMergedRunStatus(sortedRuns, authoritativeRunId);

  return {
    runId,
    sessionKey,
    status,
    startedAt,
    lastEventAt,
    endedAt: status === 'running' ? undefined : lastEventAt,
    objective: sortedRuns.find((run) => run.objective)?.objective,
    planSummary: [...sortedRuns].reverse().find((run) => run.planSummary)?.planSummary,
    planSteps: sortedRuns.flatMap((run) => run.planSteps ?? []).reduce(
      (items, step) => upsertById(items, step),
      [] as NonNullable<ChatRuntimeRunState['planSteps']>,
    ),
    tasks: sortedRuns.flatMap((run) => run.tasks ?? []).reduce(
      (items, task) => upsertRuntimeTask(items, task),
      [] as NonNullable<ChatRuntimeRunState['tasks']>,
    ),
    artifacts: sortedRuns.flatMap((run) => run.artifacts ?? []).reduce(
      (items, artifact) => upsertById(items, artifact),
      [] as NonNullable<ChatRuntimeRunState['artifacts']>,
    ),
    verifications: sortedRuns.flatMap((run) => run.verifications ?? []).reduce(
      (items, verification) => upsertById(items, verification),
      [] as NonNullable<ChatRuntimeRunState['verifications']>,
    ),
    assistantText: sortedRuns.map((run) => run.assistantText).filter(Boolean).join('\n\n'),
    thinkingText: sortedRuns.map((run) => run.thinkingText).filter(Boolean).join('\n\n'),
    progressEntries: synchronizeProgressWithTasks(
      sortedRuns.flatMap((run) => run.progressEntries ?? []).reduce(
        (items, entry) => upsertById(items, entry),
        [] as NonNullable<ChatRuntimeRunState['progressEntries']>,
      ),
      sortedRuns.flatMap((run) => run.tasks ?? []).reduce(
        (items, task) => upsertRuntimeTask(items, task),
        [] as NonNullable<ChatRuntimeRunState['tasks']>,
      ),
    ),
    asyncTaskLedger: sortedRuns
      .flatMap((run) => Object.entries(run.asyncTaskLedger ?? {}))
      .reduce(
        (entries, [key, entry]) => upsertAsyncTaskLedgerEntry(entries, key, entry),
        {} as Record<string, AsyncTaskLedgerEntry>,
      ),
    events,
  };
}
