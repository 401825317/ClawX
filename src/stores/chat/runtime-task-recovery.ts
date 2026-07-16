import type { ChatRuntimeTaskProjection } from '../../../shared/chat-runtime-events';
import type { ChatRuntimeRunState } from './types';

const VIDEO_SEGMENT_TASK_PREFIX = 'video-segment:';

function taskTimestamp(task: ChatRuntimeTaskProjection): number {
  return task.endedAt ?? task.updatedAt ?? task.startedAt ?? task.createdAt ?? 0;
}

export function runtimeTaskLogicalRecoveryKey(
  task: ChatRuntimeTaskProjection,
): string | undefined {
  if (task.runtime && task.runtime.trim().toLowerCase() !== 'video_generate') return undefined;
  const title = task.title.trim();
  if (!title.startsWith(VIDEO_SEGMENT_TASK_PREFIX)) return undefined;
  return title;
}

function isSuccessfulTask(task: ChatRuntimeTaskProjection): boolean {
  return task.status === 'completed'
    && task.terminalOutcome?.trim().toLowerCase() !== 'blocked';
}

export function runtimeTaskSupersededByLaterSuccess(
  task: ChatRuntimeTaskProjection,
  tasks: ChatRuntimeTaskProjection[],
): boolean {
  const recoveryKey = runtimeTaskLogicalRecoveryKey(task);
  if (!recoveryKey) return false;
  const failedAt = taskTimestamp(task);
  return tasks.some((candidate) => (
    candidate.taskId !== task.taskId
    && runtimeTaskLogicalRecoveryKey(candidate) === recoveryKey
    && isSuccessfulTask(candidate)
    && taskTimestamp(candidate) >= failedAt
  ));
}

export function unresolvedRuntimeTasks(
  tasks: ChatRuntimeTaskProjection[],
): ChatRuntimeTaskProjection[] {
  return tasks.filter((task) => !runtimeTaskSupersededByLaterSuccess(task, tasks));
}

function toTimestampMs(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < 1e12 ? value * 1000 : value;
}

function successfulRunCompletionAt(run: ChatRuntimeRunState): number | null {
  for (let index = run.events.length - 1; index >= 0; index -= 1) {
    const event = run.events[index];
    if (event?.type !== 'run.ended' || event.status !== 'completed') continue;
    return toTimestampMs(event.endedAt) ?? toTimestampMs(event.ts);
  }
  return run.status === 'completed' ? toTimestampMs(run.endedAt) : null;
}

export function runtimeRunTaskProblemStatus(
  run: ChatRuntimeRunState | null | undefined,
): 'error' | 'blocked' | null {
  if (!run) return null;
  const completionAt = successfulRunCompletionAt(run);
  const detachedTaskIds = new Set(
    Object.values(run.asyncTaskLedger ?? {})
      .map((entry) => entry.taskId)
      .filter((taskId): taskId is string => Boolean(taskId)),
  );
  const tasks = unresolvedRuntimeTasks(run.tasks ?? []).filter((task) => {
    if (detachedTaskIds.has(task.taskId)) return true;
    if (completionAt == null) return true;
    const updatedAt = toTimestampMs(task.endedAt)
      ?? toTimestampMs(task.updatedAt)
      ?? toTimestampMs(task.startedAt)
      ?? toTimestampMs(task.createdAt);
    return updatedAt == null || updatedAt > completionAt;
  });
  if (tasks.some((task) => task.status === 'error')) return 'error';
  if (tasks.some((task) => task.status === 'partial' || task.status === 'waiting_approval')) return 'blocked';
  return null;
}
