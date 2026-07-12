import type { ChatRuntimeTaskProjection } from '../../../shared/chat-runtime-events';

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
