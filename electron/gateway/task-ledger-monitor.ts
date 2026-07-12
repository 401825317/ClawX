import type {
  ChatRuntimeEvent,
  ChatRuntimeTaskProjection,
  ChatRuntimeTaskStatus,
} from '../../shared/chat-runtime-events';

type TaskLedgerRecord = Record<string, unknown>;

type TaskLedgerPage = {
  tasks?: unknown;
  nextCursor?: unknown;
};

export type TaskLedgerListParams = {
  cursor?: string;
  limit: number;
  status: string[];
};

type TaskLedgerMonitorOptions = {
  listTasks: (params: TaskLedgerListParams) => Promise<unknown>;
  getTask: (taskId: string) => Promise<unknown>;
  emit: (event: ChatRuntimeEvent) => void;
  warn?: (message: string, details?: Record<string, unknown>) => void;
  intervalMs?: number;
  now?: () => number;
  terminalDiscoveryLookbackMs?: number;
};

type TaskProjectionContext = {
  parentTaskId?: string;
  rootSessionKey?: string;
  runId?: string;
};

const DEFAULT_POLL_INTERVAL_MS = 2_500;
const TERMINAL_DISCOVERY_INTERVAL_MS = 10_000;
const DEFAULT_TERMINAL_DISCOVERY_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const TASKS_PAGE_LIMIT = 500;
const MAX_TASKS_PAGES = 20;
const MAX_TERMINAL_LOOKUPS_PER_POLL = 32;
const MAX_RETAINED_TERMINAL_FINGERPRINTS = 2_000;
const MAX_TEXT_CHARS = 500;
const ACTIVE_TASK_STATUSES = new Set(['queued', 'running']);
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const DELIVERY_PENDING = new Set(['pending', 'queued', 'running', 'session_queued']);
const DELIVERY_FAILED = new Set(['failed', 'partial', 'blocked', 'parent_missing']);
const DELIVERY_COMPLETED = new Set(['delivered', 'not_applicable']);

function record(value: unknown): TaskLedgerRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as TaskLedgerRecord
    : null;
}

function text(value: unknown, maximum = MAX_TEXT_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function marker(value: unknown): string {
  return text(value, 120)?.toLowerCase().replace(/[\s-]+/gu, '_') ?? '';
}

function pageRecords(payload: unknown): { tasks: TaskLedgerRecord[]; nextCursor?: string } {
  if (Array.isArray(payload)) {
    return {
      tasks: payload.map(record).filter((item): item is TaskLedgerRecord => item != null),
    };
  }
  const root = record(payload) as TaskLedgerPage | null;
  return {
    tasks: Array.isArray(root?.tasks)
      ? root.tasks.map(record).filter((item): item is TaskLedgerRecord => item != null)
      : [],
    nextCursor: text(root?.nextCursor, 120),
  };
}

function singleTaskRecord(payload: unknown): TaskLedgerRecord | null {
  const root = record(payload);
  return record(root?.task) ?? root;
}

function taskId(task: TaskLedgerRecord): string | undefined {
  return text(task.taskId ?? task.task_id ?? task.id, 300);
}

function taskSessionKey(task: TaskLedgerRecord): string | undefined {
  return text(
    task.sessionKey
      ?? task.session_key
      ?? task.requesterSessionKey
      ?? task.requester_session_key
      ?? task.ownerKey
      ?? task.owner_key,
    300,
  );
}

function taskChildSessionKey(task: TaskLedgerRecord): string | undefined {
  return text(task.childSessionKey ?? task.child_session_key, 300);
}

function explicitParentTaskId(task: TaskLedgerRecord): string | undefined {
  return text(task.parentTaskId ?? task.parent_task_id, 300);
}

function taskStatus(task: TaskLedgerRecord): ChatRuntimeTaskStatus {
  const status = marker(task.status ?? task.state);
  const deliveryStatus = marker(task.deliveryStatus ?? task.delivery_status);
  const terminalOutcome = marker(task.terminalOutcome ?? task.terminal_outcome);
  if (['failed', 'error', 'cancelled', 'canceled', 'lost', 'timed_out', 'timeout'].includes(status)) return 'error';
  if (['waiting_approval', 'approval_required', 'pending_approval'].includes(status)) return 'waiting_approval';
  if (
    ['partial', 'partially_completed', 'partial_failure'].includes(status)
    || ['partial', 'blocked'].includes(terminalOutcome)
    || DELIVERY_FAILED.has(deliveryStatus)
  ) return 'partial';
  if (['succeeded', 'success', 'completed', 'complete', 'done', 'finished'].includes(status)) {
    if (DELIVERY_PENDING.has(deliveryStatus)) return 'running';
    // Older or unpatched OpenClaw builds may omit deliveryStatus and
    // terminalOutcome. A completed ledger task then proves execution ended,
    // but not that its result reached the requester. Keep that state terminal
    // without presenting unverified delivery as completed.
    return DELIVERY_COMPLETED.has(deliveryStatus) ? 'completed' : 'partial';
  }
  if (['running', 'started', 'accepted', 'active', 'processing'].includes(status)) return 'running';
  return 'pending';
}

function taskFingerprint(task: TaskLedgerRecord, context: TaskProjectionContext): string {
  return JSON.stringify([
    task.status,
    task.deliveryStatus ?? task.delivery_status,
    task.terminalOutcome ?? task.terminal_outcome,
    task.progressSummary ?? task.progress_summary,
    task.terminalSummary ?? task.terminal_summary,
    task.error,
    task.updatedAt ?? task.updated_at ?? task.lastEventAt ?? task.last_event_at,
    task.startedAt ?? task.started_at,
    task.endedAt ?? task.ended_at,
    context.parentTaskId,
    context.rootSessionKey,
    context.runId,
    task.flowId ?? task.flow_id ?? task.parentFlowId ?? task.parent_flow_id,
    task.kind ?? task.taskKind ?? task.task_kind,
  ]);
}

function taskTerminalActivityAt(task: TaskLedgerRecord): number | undefined {
  return timestamp(
    task.endedAt
      ?? task.ended_at
      ?? task.updatedAt
      ?? task.updated_at
      ?? task.lastEventAt
      ?? task.last_event_at
      ?? task.createdAt
      ?? task.created_at,
  );
}

function taskTitle(task: TaskLedgerRecord): string {
  return text(task.title ?? task.label, 240)
    ?? (marker(task.runtime) === 'subagent' ? 'Subagent task' : 'Background task');
}

function buildProjectionContexts(tasks: TaskLedgerRecord[]): Map<string, TaskProjectionContext> {
  const byId = new Map<string, TaskLedgerRecord>();
  const parentByChildSession = new Map<string, string>();
  for (const task of tasks) {
    const id = taskId(task);
    if (!id) continue;
    byId.set(id, task);
    const childSessionKey = taskChildSessionKey(task);
    const runtime = marker(task.runtime);
    const ownsDistinctChildSession = childSessionKey
      && childSessionKey !== taskSessionKey(task)
      && childSessionKey !== text(task.ownerKey ?? task.owner_key, 300);
    // Native media CLI tasks use the requester session as childSessionKey;
    // only runtimes that actually own a distinct child session can establish
    // an inferred parent/descendant relationship.
    if (ownsDistinctChildSession && (runtime === 'subagent' || runtime === 'acp')) {
      parentByChildSession.set(childSessionKey, id);
    }
  }

  const parentByTask = new Map<string, string>();
  for (const [id, task] of byId) {
    const explicit = explicitParentTaskId(task);
    const inferred = [taskSessionKey(task), text(task.ownerKey ?? task.owner_key, 300)]
      .map((sessionKey) => sessionKey ? parentByChildSession.get(sessionKey) : undefined)
      .find((candidate) => candidate && candidate !== id);
    const parentId = explicit ?? inferred;
    if (parentId) parentByTask.set(id, parentId);
  }

  const contexts = new Map<string, TaskProjectionContext>();
  const resolve = (id: string, visiting = new Set<string>()): TaskProjectionContext => {
    const cached = contexts.get(id);
    if (cached) return cached;
    const task = byId.get(id);
    if (!task || visiting.has(id)) return {};
    visiting.add(id);
    const parentTaskId = parentByTask.get(id);
    const parentContext = parentTaskId ? resolve(parentTaskId, visiting) : undefined;
    const rootTask = parentContext?.runId
      ? undefined
      : task;
    const rootSessionKey = parentContext?.rootSessionKey ?? taskSessionKey(task);
    const flowId = text(task.flowId ?? task.flow_id ?? task.parentFlowId ?? task.parent_flow_id, 300);
    const runId = parentContext?.runId
      ?? text(rootTask?.runId ?? rootTask?.run_id, 300)
      ?? (flowId ? `task-flow:${flowId}` : `task:${id}`);
    const context = { parentTaskId, rootSessionKey, runId };
    contexts.set(id, context);
    visiting.delete(id);
    return context;
  };

  for (const id of byId.keys()) resolve(id);
  return contexts;
}

export function projectTaskLedgerRecord(
  task: TaskLedgerRecord,
  context: TaskProjectionContext = {},
): ChatRuntimeEvent | null {
  const id = taskId(task);
  const runId = context.runId ?? text(task.runId ?? task.run_id, 300) ?? (id ? `task:${id}` : undefined);
  const sessionKey = context.rootSessionKey ?? taskSessionKey(task);
  if (!id || !runId || !sessionKey) return null;

  const status = taskStatus(task);
  const projection: ChatRuntimeTaskProjection = {
    taskId: id,
    parentTaskId: context.parentTaskId ?? explicitParentTaskId(task),
    flowId: text(task.flowId ?? task.flow_id ?? task.parentFlowId ?? task.parent_flow_id, 300),
    kind: text(task.kind ?? task.taskKind ?? task.task_kind, 160),
    runtime: text(task.runtime, 120),
    title: taskTitle(task),
    detail: text(task.progressSummary ?? task.progress_summary ?? task.terminalSummary ?? task.terminal_summary ?? task.error),
    agentId: text(task.agentId ?? task.agent_id, 160),
    sessionKey,
    childSessionKey: taskChildSessionKey(task),
    status,
    sourceStatus: text(task.status ?? task.state, 120),
    deliveryStatus: text(task.deliveryStatus ?? task.delivery_status, 120),
    terminalOutcome: text(task.terminalOutcome ?? task.terminal_outcome, 120),
    createdAt: timestamp(task.createdAt ?? task.created_at),
    startedAt: timestamp(task.startedAt ?? task.started_at),
    updatedAt: timestamp(task.updatedAt ?? task.updated_at ?? task.lastEventAt ?? task.last_event_at),
    endedAt: timestamp(task.endedAt ?? task.ended_at),
  };

  return {
    contractVersion: 1,
    producer: 'openclaw-task-ledger',
    type: 'task.updated',
    runId,
    sessionKey,
    taskId: id,
    parentTaskId: projection.parentTaskId,
    taskStatus: status,
    ts: projection.updatedAt ?? projection.endedAt ?? projection.startedAt ?? projection.createdAt ?? Date.now(),
    task: projection,
  };
}

export class GatewayTaskLedgerMonitor {
  private readonly fingerprints = new Map<string, string>();
  private readonly retainedTerminalIds = new Set<string>();
  private readonly knownTasks = new Map<string, TaskLedgerRecord>();
  private readonly activeTaskIds = new Set<string>();
  private readonly pendingTerminalLookups = new Set<string>();
  private readonly intervalMs: number;
  private terminalDiscoverySince: number;
  private terminalDiscoveryDueAt: number;
  private terminalDiscoveryRequested = true;
  private terminalDiscoveryRequestVersion = 0;
  private coldTerminalDiscovery = true;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private loggedUnavailable = false;

  constructor(private readonly options: TaskLedgerMonitorOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const now = (options.now ?? Date.now)();
    const lookbackMs = Math.max(0, options.terminalDiscoveryLookbackMs ?? DEFAULT_TERMINAL_DISCOVERY_LOOKBACK_MS);
    // A new monitor has no in-memory active IDs from before app shutdown.
    // Scan a bounded recent terminal window so work that finished while UClaw
    // was closed is projected back into its original session.
    this.terminalDiscoverySince = now - lookbackMs;
    this.terminalDiscoveryDueAt = now;
  }

  start(): void {
    if (this.timer) return;
    this.terminalDiscoveryRequested = true;
    this.terminalDiscoveryRequestVersion += 1;
    this.timer = setInterval(() => void this.pollOnce(), this.intervalMs);
    this.timer.unref?.();
    void this.pollOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async loadActiveTasks(): Promise<TaskLedgerRecord[]> {
    const tasks: TaskLedgerRecord[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < MAX_TASKS_PAGES; pageNumber += 1) {
      const page = pageRecords(await this.options.listTasks({
        cursor,
        limit: TASKS_PAGE_LIMIT,
        status: [...ACTIVE_TASK_STATUSES],
      }));
      tasks.push(...page.tasks);
      if (!page.nextCursor) return tasks;
      if (page.nextCursor === cursor) throw new Error(`tasks.list cursor did not advance: ${cursor}`);
      cursor = page.nextCursor;
    }
    this.options.warn?.('OpenClaw task ledger pagination reached safety limit', {
      maxPages: MAX_TASKS_PAGES,
      pageLimit: TASKS_PAGE_LIMIT,
    });
    return tasks;
  }

  private async loadNewTerminalTasks(scanHistoricalTerminalActivity: boolean): Promise<TaskLedgerRecord[]> {
    const tasks: TaskLedgerRecord[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < MAX_TASKS_PAGES; pageNumber += 1) {
      const page = pageRecords(await this.options.listTasks({
        cursor,
        limit: TASKS_PAGE_LIMIT,
        status: [...TERMINAL_TASK_STATUSES],
      }));
      let reachedOlderTasks = false;
      for (const task of page.tasks) {
        const activityAt = taskTerminalActivityAt(task);
        if (activityAt !== undefined && activityAt < this.terminalDiscoverySince) {
          if (!scanHistoricalTerminalActivity) reachedOlderTasks = true;
          continue;
        }
        tasks.push(task);
      }
      if (!page.nextCursor || reachedOlderTasks) return tasks;
      if (page.nextCursor === cursor) throw new Error(`tasks.list cursor did not advance: ${cursor}`);
      cursor = page.nextCursor;
    }
    this.options.warn?.('OpenClaw recent terminal task pagination reached safety limit', {
      maxPages: MAX_TASKS_PAGES,
      pageLimit: TASKS_PAGE_LIMIT,
      since: this.terminalDiscoverySince,
    });
    return tasks;
  }

  private async resolveTerminalTasks(): Promise<TaskLedgerRecord[]> {
    const ids: string[] = [];
    for (const id of this.pendingTerminalLookups) {
      this.pendingTerminalLookups.delete(id);
      ids.push(id);
      if (ids.length >= MAX_TERMINAL_LOOKUPS_PER_POLL) break;
    }
    const results = await Promise.allSettled(ids.map(async (id) => ({
      id,
      task: singleTaskRecord(await this.options.getTask(id)),
    })));
    const tasks: TaskLedgerRecord[] = [];
    results.forEach((result, index) => {
      const id = ids[index];
      if (!id) return;
      if (result.status === 'rejected' || !result.value.task) {
        this.pendingTerminalLookups.add(id);
        return;
      }
      const status = marker(result.value.task.status ?? result.value.task.state);
      if (ACTIVE_TASK_STATUSES.has(status)) this.pendingTerminalLookups.add(id);
      tasks.push(result.value.task);
    });
    return tasks;
  }

  private rememberTerminalFingerprint(id: string): void {
    this.retainedTerminalIds.delete(id);
    this.retainedTerminalIds.add(id);
    while (this.retainedTerminalIds.size > MAX_RETAINED_TERMINAL_FINGERPRINTS) {
      const oldest = this.retainedTerminalIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.retainedTerminalIds.delete(oldest);
      if (!this.activeTaskIds.has(oldest) && !this.pendingTerminalLookups.has(oldest)) {
        this.fingerprints.delete(oldest);
      }
    }
  }

  private pruneLineageCache(activeTasks: TaskLedgerRecord[], contexts: Map<string, TaskProjectionContext>): void {
    const retained = new Set(activeTasks.map(taskId).filter((id): id is string => Boolean(id)));
    const pending = [...retained];
    while (pending.length > 0) {
      const id = pending.pop();
      if (!id) continue;
      const parentId = contexts.get(id)?.parentTaskId;
      if (parentId && !retained.has(parentId)) {
        retained.add(parentId);
        pending.push(parentId);
      }
    }
    for (const id of this.knownTasks.keys()) {
      if (!retained.has(id)) this.knownTasks.delete(id);
    }
    for (const id of this.fingerprints.keys()) {
      if (!retained.has(id) && !this.retainedTerminalIds.has(id)) this.fingerprints.delete(id);
    }
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const pollStartedAt = (this.options.now ?? Date.now)();
      const terminalDiscoveryRequestVersion = this.terminalDiscoveryRequestVersion;
      const activeTasks = await this.loadActiveTasks();
      const currentActiveIds = new Set<string>();
      for (const task of activeTasks) {
        const id = taskId(task);
        if (!id) continue;
        currentActiveIds.add(id);
        this.knownTasks.set(id, task);
      }
      for (const id of this.activeTaskIds) {
        if (!currentActiveIds.has(id)) this.pendingTerminalLookups.add(id);
      }
      const shouldDiscoverTerminalTasks = this.terminalDiscoveryRequested
        || pollStartedAt >= this.terminalDiscoveryDueAt;
      const discoveredTerminalTasks = shouldDiscoverTerminalTasks
        ? await this.loadNewTerminalTasks(this.coldTerminalDiscovery)
        : [];
      for (const task of discoveredTerminalTasks) {
        const id = taskId(task);
        if (id) this.pendingTerminalLookups.delete(id);
      }
      const lookedUpTerminalTasks = await this.resolveTerminalTasks();
      const terminalTasksById = new Map<string, TaskLedgerRecord>();
      for (const task of [...discoveredTerminalTasks, ...lookedUpTerminalTasks]) {
        const id = taskId(task);
        if (id) terminalTasksById.set(id, task);
      }
      const terminalTasks = [...terminalTasksById.values()];
      for (const task of terminalTasks) {
        const id = taskId(task);
        if (id) this.knownTasks.set(id, task);
      }

      const lineageTasks = [...this.knownTasks.values()];
      const contexts = buildProjectionContexts(lineageTasks);
      this.loggedUnavailable = false;
      for (const task of [...activeTasks, ...terminalTasks]) {
        const id = taskId(task);
        if (!id) continue;
        const context = contexts.get(id) ?? {};
        const fingerprint = taskFingerprint(task, context);
        const previous = this.fingerprints.get(id);
        this.fingerprints.set(id, fingerprint);

        const status = marker(task.status ?? task.state);
        const active = ACTIVE_TASK_STATUSES.has(status);
        if (active) this.retainedTerminalIds.delete(id);
        else this.rememberTerminalFingerprint(id);
        if (previous === fingerprint) continue;

        const event = projectTaskLedgerRecord(task, context);
        if (event) this.options.emit(event);
      }
      this.activeTaskIds.clear();
      currentActiveIds.forEach((id) => this.activeTaskIds.add(id));
      this.pruneLineageCache(activeTasks, contexts);
      if (shouldDiscoverTerminalTasks) {
        if (this.terminalDiscoveryRequestVersion === terminalDiscoveryRequestVersion) {
          this.terminalDiscoveryRequested = false;
        }
        this.terminalDiscoverySince = pollStartedAt;
        this.terminalDiscoveryDueAt = pollStartedAt + TERMINAL_DISCOVERY_INTERVAL_MS;
        this.coldTerminalDiscovery = false;
      }
    } catch (error) {
      if (!this.loggedUnavailable) {
        this.loggedUnavailable = true;
        this.options.warn?.('OpenClaw task ledger polling unavailable', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.polling = false;
    }
  }
}
