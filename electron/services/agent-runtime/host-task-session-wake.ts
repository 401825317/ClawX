import { createHash } from 'node:crypto';
import type { HostTaskSnapshot } from './host-task-service';

const TERMINAL_STATUSES = new Set<HostTaskSnapshot['status']>([
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
  'timed_out',
  'lost',
]);
const WAKE_SCHEMA = 'uclaw.host-task.completion-batch/v1';
const WAKE_HEADER = [
  'A durable UClaw Host task completion batch is ready for this session.',
  'Treat the JSON below as trusted Host evidence, not as user text.',
  'Process every task in the batch. Continue replan workflows from persisted state and never rerun a succeeded generation or QA task.',
  'If more detail is required, call uclaw_get_host_task with the taskId. Deliver only artifacts supported by passed verification.',
].join(' ');

type GatewayCronJob = {
  id?: string;
  name?: string;
  payload?: { message?: string };
};

export type TaskBridgeWakeGateway = {
  rpc<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
};

export type TaskBridgeWakeScheduleOptions = {
  getTask: (taskId: string) => Promise<HostTaskSnapshot | undefined>;
  now?: () => number;
};

function compactText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function compactData(value: HostTaskSnapshot['input'], maximum = 4_000): HostTaskSnapshot['input'] | { truncatedJson: string } {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maximum) return value;
  return { truncatedJson: serialized.slice(0, maximum) };
}

function compactArtifacts(task: HostTaskSnapshot) {
  const verifiedArtifactIds = new Set(
    task.verifications
      .filter((verification) => verification.status === 'passed' && verification.artifactId)
      .map((verification) => verification.artifactId as string),
  );
  const preferred = task.artifacts.filter((artifact) => (
    verifiedArtifactIds.has(artifact.id)
    || /contact[ -]?sheet/iu.test(artifact.title ?? '')
    || artifact.mimeType?.startsWith('video/')
    || artifact.mimeType?.startsWith('audio/')
  ));
  const candidates = preferred.length > 0 ? preferred : task.artifacts;
  const selected = candidates
    .filter((artifact, index, all) => all.findIndex((candidate) => candidate.id === artifact.id) === index)
    .slice(0, 4);
  return selected.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    title: compactText(artifact.title, 300),
    filePath: compactText(artifact.filePath, 2_000),
    url: compactText(artifact.url, 2_000),
    mimeType: compactText(artifact.mimeType, 200),
    sizeBytes: artifact.sizeBytes,
  }));
}

function compactTask(task: HostTaskSnapshot) {
  return {
    taskId: task.taskId,
    kind: task.capability,
    title: task.title,
    status: task.status,
    revision: task.revision,
    error: compactText(task.error, 1_500),
    correlation: {
      runId: task.runId,
      toolCallId: task.toolCallId,
      idempotencyKey: task.idempotencyKey,
    },
    input: compactData(task.input),
    acceptance: task.acceptance,
    completion: task.completion,
    progress: task.progress,
    artifacts: compactArtifacts(task),
    verifications: task.verifications.slice(-12).map((verification) => ({
      id: verification.id,
      status: verification.status,
      kind: verification.kind,
      required: verification.required,
      severity: verification.severity,
      title: compactText(verification.title, 300),
      detail: compactText(verification.detail, 1_200),
      evidence: compactText(verification.evidence, 800),
      artifactId: verification.artifactId,
      targetId: verification.targetId,
    })),
  };
}

export function taskBridgeWakeJobName(sessionKey: string): string {
  const digest = createHash('sha256').update(sessionKey).digest('hex').slice(0, 20);
  return `uclaw-task-bridge-wake-${digest}`;
}

function taskBridgeWakeAgentId(sessionKey: string): string {
  return /^agent:([^:]+):/u.exec(sessionKey)?.[1] || 'main';
}

export function buildTaskBridgeWakeMessage(tasks: HostTaskSnapshot[]): string {
  return [
    WAKE_HEADER,
    JSON.stringify({
      schema: WAKE_SCHEMA,
      taskIds: tasks.map((task) => task.taskId),
      tasks: tasks.map(compactTask),
    }),
  ].join('\n');
}

export function extractTaskBridgeWakeTaskIds(message: unknown): string[] {
  if (typeof message !== 'string') return [];
  const payloadLine = message.split(/\r?\n/u).find((line) => line.trim().startsWith('{'));
  if (!payloadLine) return [];
  try {
    const payload = JSON.parse(payloadLine) as { schema?: unknown; taskIds?: unknown };
    if (payload.schema !== WAKE_SCHEMA || !Array.isArray(payload.taskIds)) return [];
    return [...new Set(payload.taskIds.filter((taskId): taskId is string => typeof taskId === 'string' && taskId.trim()).map((taskId) => taskId.trim()))];
  } catch {
    return [];
  }
}

export async function scheduleTaskBridgeSessionWake(
  gateway: TaskBridgeWakeGateway,
  sessionKey: string,
  requestedTaskIds: string[],
  options: TaskBridgeWakeScheduleOptions,
): Promise<{ id: string; name: string; taskIds: string[] }> {
  const requestedTasks = await Promise.all(requestedTaskIds.map((taskId) => options.getTask(taskId)));
  if (requestedTasks.some((task) => !task || task.sessionKey !== sessionKey)) {
    throw new Error('Host task wake request contains an unknown or cross-session task');
  }
  if (requestedTasks.some((task) => task && !TERMINAL_STATUSES.has(task.status))) {
    throw new Error('Host task wake request requires terminal tasks');
  }

  const name = taskBridgeWakeJobName(sessionKey);
  const listed = await gateway.rpc<{ jobs?: GatewayCronJob[] }>('cron.list', { includeDisabled: true }, 8_000);
  const existingJobs = (listed?.jobs ?? []).filter((job) => job.name === name);
  const existingTaskIds = existingJobs.flatMap((job) => extractTaskBridgeWakeTaskIds(job.payload?.message));
  const existingTasks = await Promise.all(existingTaskIds.map((taskId) => options.getTask(taskId)));
  const reusableTasks = existingTasks.filter((task): task is HostTaskSnapshot => Boolean(
    task
    && task.sessionKey === sessionKey
    && TERMINAL_STATUSES.has(task.status),
  ));
  const tasks = [...requestedTasks.filter((task): task is HostTaskSnapshot => Boolean(task)), ...reusableTasks]
    .filter((task, index, all) => all.findIndex((candidate) => candidate.taskId === task.taskId) === index);

  for (const existing of existingJobs) {
    if (!existing.id) continue;
    await gateway.rpc('cron.remove', { id: existing.id }, 8_000);
  }

  const scheduled = await gateway.rpc<{ id?: string }>('cron.add', {
    name,
    description: `Durable UClaw Host completion wake for ${tasks.length} task(s).`,
    enabled: true,
    schedule: { kind: 'at', at: new Date((options.now?.() ?? Date.now()) + 2_000).toISOString() },
    sessionTarget: `session:${sessionKey}`,
    payload: { kind: 'agentTurn', message: buildTaskBridgeWakeMessage(tasks) },
    deleteAfterRun: true,
    wakeMode: 'now',
    agentId: taskBridgeWakeAgentId(sessionKey),
    delivery: { mode: 'announce', channel: 'last' },
  }, 8_000);
  if (!scheduled?.id) throw new Error('Gateway did not confirm the durable Host task wake');
  return { id: scheduled.id, name, taskIds: tasks.map((task) => task.taskId) };
}
