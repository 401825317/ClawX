/**
 * Stable wire contract for a Host Task completion turn. OpenClaw must receive
 * this context to resume the originating session, but it is never user text.
 */
export const HOST_TASK_COMPLETION_WAKE_SCHEMA = 'uclaw.host-task.completion-batch/v1';

export type HostTaskCompletionWakeEnvelope = {
  schema: typeof HOST_TASK_COMPLETION_WAKE_SCHEMA;
  taskIds: string[];
};

function parseEnvelope(value: unknown): HostTaskCompletionWakeEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as { schema?: unknown; taskIds?: unknown };
  if (envelope.schema !== HOST_TASK_COMPLETION_WAKE_SCHEMA || !Array.isArray(envelope.taskIds)) {
    return null;
  }

  const taskIds = [...new Set(envelope.taskIds
    .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.trim().length > 0)
    .map((taskId) => taskId.trim()))];
  return taskIds.length > 0 ? { schema: HOST_TASK_COMPLETION_WAKE_SCHEMA, taskIds } : null;
}

/**
 * The current producer writes a concise instruction line followed by one JSON
 * envelope. Parse the schema instead of matching mutable explanatory prose.
 */
export function parseHostTaskCompletionWakeText(text: string): HostTaskCompletionWakeEnvelope | null {
  for (const line of text.split(/\r?\n/u)) {
    const candidate = line.trim();
    if (!candidate.startsWith('{') || !candidate.includes(HOST_TASK_COMPLETION_WAKE_SCHEMA)) continue;
    try {
      const envelope = parseEnvelope(JSON.parse(candidate));
      if (envelope) return envelope;
    } catch {
      // A normal chat message can contain incomplete JSON; it is not an envelope.
    }
  }
  return null;
}

export function isHostTaskCompletionWakeText(text: string): boolean {
  return parseHostTaskCompletionWakeText(text) !== null;
}
