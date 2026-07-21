import type { ConversationEvent } from '../../../shared/conversation-events';
import {
  buildHostTaskRehydrationEvents,
  type HostTaskBridgeTask,
  type HostTaskRehydrationOptions,
} from '../chat/host-task-rehydration';
import { createTurnId } from './identity';
import { runtimeEventToConversationEvent } from './runtime-adapter';

/** Replay durable Host Task snapshots through the canonical runtime adapter. */
export function hostTasksToConversationEvents(
  tasks: readonly HostTaskBridgeTask[],
  options: HostTaskRehydrationOptions = {},
): ConversationEvent[] {
  const ownerByTaskId = new Map(tasks.map((task) => [task.taskId, task]));
  const ownerByRunId = new Map(tasks.map((task) => [task.correlation.runId, task]));

  return buildHostTaskRehydrationEvents(tasks, options).flatMap((runtimeEvent) => {
    const canonical = runtimeEventToConversationEvent(runtimeEvent);
    if (!canonical) return [];
    const owner = (runtimeEvent.taskId ? ownerByTaskId.get(runtimeEvent.taskId) : undefined)
      ?? ownerByRunId.get(runtimeEvent.runId);
    if (!owner) return [];
    const turnId = createTurnId({
      sessionKey: owner.correlation.sessionKey,
      idempotencyKey: owner.correlation.idempotencyKey,
      runId: owner.correlation.runId,
      timestamp: owner.createdAt,
      content: owner.title,
    });
    return [{
      ...canonical,
      source: 'task-ledger' as const,
      authority: 'authoritative' as const,
      turnId,
      replayed: true,
    }];
  });
}
