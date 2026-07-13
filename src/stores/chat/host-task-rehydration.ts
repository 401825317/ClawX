import type {
  ChatRuntimeArtifact,
  ChatRuntimeEvent,
  ChatRuntimeProgressEntryStatus,
  ChatRuntimeStepStatus,
  ChatRuntimeTaskStatus,
  ChatRuntimeVerification,
} from '../../../shared/chat-runtime-events';
import { CHAT_RUNTIME_CONTRACT_VERSION } from '../../../shared/chat-runtime-events';

export const HOST_TASK_BRIDGE_SCHEMA = 'uclaw.host-task/v1';

export type HostTaskBridgeStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'timed_out'
  | 'lost';

export type HostTaskBridgeTask = {
  schema: typeof HOST_TASK_BRIDGE_SCHEMA;
  taskId: string;
  kind: string;
  title: string;
  status: HostTaskBridgeStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
  correlation: {
    sessionKey: string;
    runId: string;
    toolCallId: string;
    idempotencyKey: string;
  };
  progress: Array<{
    id: string;
    stage?: string;
    status?: string;
    label?: string;
    detail?: string;
    percent?: number;
    timestampMs?: number;
  }>;
  artifacts: ChatRuntimeArtifact[];
  verifications: ChatRuntimeVerification[];
  lifecycle: {
    operations: Array<{
      kind: string;
      status: string;
      attempt: number;
      startedAt: number;
      finishedAt?: number;
      error?: string;
    }>;
  };
};

export type HostTaskRehydrationOptions = {
  /**
   * Supplying the current run ids allows active Host tasks without an existing
   * transcript projection to seed a run.started event. Terminal task-only runs
   * deliberately omit run.started so task.updated can restore their terminal
   * state without resurrecting the run as active.
   */
  existingRunIds?: Iterable<string>;
};

const HOST_TASK_STATUSES = new Set<HostTaskBridgeStatus>([
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
  'timed_out',
  'lost',
]);
const TERMINAL_HOST_TASK_STATUSES = new Set<HostTaskBridgeStatus>([
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
  'timed_out',
  'lost',
]);
const VERIFICATION_STATUSES = new Set<ChatRuntimeVerification['status']>([
  'passed',
  'failed',
  'blocked',
  'skipped',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeArtifact(value: unknown): ChatRuntimeArtifact | null {
  const item = record(value);
  const id = text(item?.id);
  if (!item || !id) return null;
  return {
    id,
    ...(text(item.kind) ? { kind: text(item.kind) } : {}),
    ...(text(item.title) ? { title: text(item.title) } : {}),
    ...(text(item.filePath) ? { filePath: text(item.filePath) } : {}),
    ...(text(item.url) ? { url: text(item.url) } : {}),
    ...(text(item.mimeType) ? { mimeType: text(item.mimeType) } : {}),
    ...(number(item.sizeBytes) !== undefined ? { sizeBytes: number(item.sizeBytes) } : {}),
    ...(text(item.stepId) ? { stepId: text(item.stepId) } : {}),
    ...(text(item.taskId) ? { taskId: text(item.taskId) } : {}),
    ...(text(item.sourceToolCallId) ? { sourceToolCallId: text(item.sourceToolCallId) } : {}),
    ...(text(item.source) ? { source: text(item.source) } : {}),
  };
}

function normalizeVerification(value: unknown): ChatRuntimeVerification | null {
  const item = record(value);
  const id = text(item?.id);
  const status = text(item?.status) as ChatRuntimeVerification['status'] | undefined;
  if (!item || !id || !status || !VERIFICATION_STATUSES.has(status)) return null;
  return {
    id,
    status,
    ...(text(item.kind) ? { kind: text(item.kind) } : {}),
    ...(typeof item.required === 'boolean' ? { required: item.required } : {}),
    ...(text(item.severity) ? { severity: text(item.severity) as ChatRuntimeVerification['severity'] } : {}),
    ...(text(item.title) ? { title: text(item.title) } : {}),
    ...(text(item.detail) ? { detail: text(item.detail) } : {}),
    ...(text(item.targetId) ? { targetId: text(item.targetId) } : {}),
    ...(text(item.artifactId) ? { artifactId: text(item.artifactId) } : {}),
    ...(text(item.taskId) ? { taskId: text(item.taskId) } : {}),
    ...(text(item.evidence) ? { evidence: text(item.evidence) } : {}),
    ...(text(item.source) ? { source: text(item.source) } : {}),
  };
}

function normalizeProgress(value: unknown): HostTaskBridgeTask['progress'][number] | null {
  const item = record(value);
  const id = text(item?.id);
  if (!item || !id) return null;
  return {
    id,
    ...(text(item.stage) ? { stage: text(item.stage) } : {}),
    ...(text(item.status) ? { status: text(item.status) } : {}),
    ...(text(item.label) ? { label: text(item.label) } : {}),
    ...(text(item.detail) ? { detail: text(item.detail) } : {}),
    ...(number(item.percent) !== undefined ? { percent: number(item.percent) } : {}),
    ...(number(item.timestampMs) !== undefined ? { timestampMs: number(item.timestampMs) } : {}),
  };
}

function normalizeLifecycleOperation(value: unknown): HostTaskBridgeTask['lifecycle']['operations'][number] | null {
  const item = record(value);
  const kind = text(item?.kind);
  const status = text(item?.status);
  const attempt = number(item?.attempt);
  const startedAt = number(item?.startedAt);
  if (!item || !kind || !status || attempt === undefined || startedAt === undefined) return null;
  return {
    kind,
    status,
    attempt,
    startedAt,
    ...(number(item.finishedAt) !== undefined ? { finishedAt: number(item.finishedAt) } : {}),
    ...(text(item.error) ? { error: text(item.error) } : {}),
  };
}

function normalizeHostTask(value: unknown): HostTaskBridgeTask | null {
  const item = record(value);
  const correlation = record(item?.correlation);
  const lifecycle = record(item?.lifecycle);
  const schema = text(item?.schema);
  const taskId = text(item?.taskId);
  const kind = text(item?.kind);
  const title = text(item?.title);
  const status = text(item?.status) as HostTaskBridgeStatus | undefined;
  const revision = number(item?.revision);
  const createdAt = number(item?.createdAt);
  const updatedAt = number(item?.updatedAt);
  const sessionKey = text(correlation?.sessionKey);
  const runId = text(correlation?.runId);
  const toolCallId = text(correlation?.toolCallId);
  const idempotencyKey = text(correlation?.idempotencyKey);
  if (
    !item
    || schema !== HOST_TASK_BRIDGE_SCHEMA
    || !taskId
    || !kind
    || !title
    || !status
    || !HOST_TASK_STATUSES.has(status)
    || revision === undefined
    || revision < 1
    || createdAt === undefined
    || updatedAt === undefined
    || !sessionKey
    || !runId
    || !toolCallId
    || !idempotencyKey
  ) {
    return null;
  }
  return {
    schema: HOST_TASK_BRIDGE_SCHEMA,
    taskId,
    kind,
    title,
    status,
    revision: Math.floor(revision),
    createdAt,
    updatedAt,
    ...(text(item.error) ? { error: text(item.error) } : {}),
    correlation: { sessionKey, runId, toolCallId, idempotencyKey },
    progress: Array.isArray(item.progress) ? item.progress.flatMap((entry) => normalizeProgress(entry) ?? []) : [],
    artifacts: Array.isArray(item.artifacts) ? item.artifacts.flatMap((entry) => normalizeArtifact(entry) ?? []) : [],
    verifications: Array.isArray(item.verifications) ? item.verifications.flatMap((entry) => normalizeVerification(entry) ?? []) : [],
    lifecycle: {
      operations: Array.isArray(lifecycle?.operations)
        ? lifecycle.operations.flatMap((entry) => normalizeLifecycleOperation(entry) ?? [])
        : [],
    },
  };
}

/** Parses only the current Host Task bridge response; legacy task snapshots are ignored. */
export function parseHostTaskBridgeTasks(payload: unknown): HostTaskBridgeTask[] {
  const response = record(payload);
  if (!response || response.success !== true || !Array.isArray(response.tasks)) return [];
  return response.tasks.flatMap((task) => normalizeHostTask(task) ?? []);
}

function isTerminal(status: HostTaskBridgeStatus): boolean {
  return TERMINAL_HOST_TASK_STATUSES.has(status);
}

function taskStatus(status: HostTaskBridgeStatus): ChatRuntimeTaskStatus {
  if (status === 'queued') return 'pending';
  if (status === 'running') return 'running';
  if (status === 'waiting') return 'waiting_approval';
  if (status === 'succeeded') return 'completed';
  return 'error';
}

function stepStatus(status: HostTaskBridgeStatus): ChatRuntimeStepStatus {
  if (status === 'queued') return 'pending';
  if (status === 'running') return 'running';
  if (status === 'waiting' || status === 'blocked') return 'blocked';
  if (status === 'succeeded') return 'completed';
  return 'error';
}

function progressStatus(status: HostTaskBridgeStatus): ChatRuntimeProgressEntryStatus {
  if (status === 'succeeded') return 'completed';
  if (status === 'waiting' || status === 'blocked') return 'blocked';
  if (status === 'failed' || status === 'cancelled' || status === 'timed_out' || status === 'lost') return 'error';
  return 'running';
}

function fnv1a32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function eventSequence(task: HostTaskBridgeTask, key: string): number {
  return fnv1a32(`${task.taskId}:${task.revision}:${key}`);
}

function latestProgressDetail(task: HostTaskBridgeTask): string | undefined {
  for (let index = task.progress.length - 1; index >= 0; index -= 1) {
    const detail = task.progress[index]?.detail?.trim();
    if (detail) return detail;
  }
  return undefined;
}

function operationStartedAt(task: HostTaskBridgeTask): number {
  return task.lifecycle.operations.reduce(
    (earliest, operation) => Math.min(earliest, operation.startedAt),
    task.createdAt,
  );
}

function terminalDurationMs(task: HostTaskBridgeTask): number | undefined {
  if (!isTerminal(task.status)) return undefined;
  return Math.max(0, task.updatedAt - operationStartedAt(task));
}

function eventBase(task: HostTaskBridgeTask, key: string) {
  return {
    contractVersion: CHAT_RUNTIME_CONTRACT_VERSION,
    producer: 'uclaw-host-task',
    runId: task.correlation.runId,
    sessionKey: task.correlation.sessionKey,
    taskId: task.taskId,
    taskStatus: taskStatus(task.status),
    seq: eventSequence(task, key),
    ts: task.updatedAt,
  } as const;
}

/**
 * Reprojects durable Host Task snapshots into the same runtime graph used by
 * live events. Events carry stable ids, timestamps and seq values so applying
 * an unchanged snapshot repeatedly is a no-op.
 */
export function buildHostTaskRehydrationEvents(
  tasks: readonly HostTaskBridgeTask[],
  options: HostTaskRehydrationOptions = {},
): ChatRuntimeEvent[] {
  const knownRunIds = options.existingRunIds ? new Set(options.existingRunIds) : null;
  const events: ChatRuntimeEvent[] = [];
  const orderedTasks = [...tasks].sort((left, right) => (
    left.updatedAt - right.updatedAt
    || left.createdAt - right.createdAt
    || left.taskId.localeCompare(right.taskId)
  ));

  for (const task of orderedTasks) {
    const terminal = isTerminal(task.status);
    const detail = task.error ?? latestProgressDetail(task);
    const common = eventBase(task, 'task');

    if (!terminal && knownRunIds && !knownRunIds.has(task.correlation.runId)) {
      events.push({
        ...eventBase(task, 'run.started'),
        type: 'run.started',
        startedAt: operationStartedAt(task),
        objective: task.title,
      });
      knownRunIds.add(task.correlation.runId);
    }

    events.push({
      ...common,
      type: 'task.updated',
      task: {
        taskId: task.taskId,
        kind: task.kind,
        runtime: 'uclaw-host-task',
        title: task.title,
        detail,
        sessionKey: task.correlation.sessionKey,
        status: taskStatus(task.status),
        sourceStatus: task.status,
        ...(terminal ? { terminalOutcome: task.status } : {}),
        ...(task.status === 'succeeded' ? { deliveryStatus: 'delivered' } : {}),
        createdAt: task.createdAt,
        startedAt: operationStartedAt(task),
        updatedAt: task.updatedAt,
        ...(terminal ? { endedAt: task.updatedAt } : {}),
      },
    });

    events.push({
      ...eventBase(task, 'step'),
      type: 'run.step.updated',
      step: {
        id: `host-task:${task.taskId}`,
        title: task.title,
        kind: `host.${task.kind}`,
        status: stepStatus(task.status),
        detail,
        taskId: task.taskId,
        toolCallId: task.correlation.toolCallId,
      },
    });
    events.push({
      ...eventBase(task, 'progress'),
      type: 'progress.update',
      entry: {
        id: `host-task:${task.taskId}:state`,
        kind: 'status',
        text: latestProgressDetail(task) ?? task.title,
        status: progressStatus(task.status),
        detail: task.error,
        toolCallId: task.correlation.toolCallId,
        taskId: task.taskId,
        source: 'native',
      },
    });

    // Host validation makes succeeded authoritative. Partial files from
    // failed, blocked or still-running work are not user-deliverable media.
    if (task.status === 'succeeded') {
      for (const artifact of task.artifacts) {
        events.push({
          ...eventBase(task, `artifact:${artifact.id}`),
          type: 'artifact.produced',
          artifact: {
            ...artifact,
            taskId: task.taskId,
            sourceToolCallId: task.correlation.toolCallId,
            source: artifact.source ?? 'uclaw-host-task',
          },
          toolCallId: task.correlation.toolCallId,
        });
      }
    }
    for (const verification of task.verifications) {
      events.push({
        ...eventBase(task, `verification:${verification.id}`),
        type: 'verification.completed',
        verification: {
          ...verification,
          taskId: task.taskId,
          source: verification.source ?? 'uclaw-host-task',
        },
        toolCallId: task.correlation.toolCallId,
      });
    }

    if (terminal) {
      events.push({
        ...eventBase(task, 'tool.completed'),
        type: 'tool.completed',
        toolCallId: task.correlation.toolCallId,
        name: `host.${task.kind}`,
        result: {
          taskId: task.taskId,
          status: task.status,
          artifactCount: task.status === 'succeeded' ? task.artifacts.length : 0,
          verificationCount: task.verifications.length,
          ...(task.error ? { error: task.error } : {}),
        },
        durationMs: terminalDurationMs(task),
        isError: task.status !== 'succeeded',
      });
    }
  }

  return events;
}
