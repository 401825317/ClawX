import type { ConversationEvent } from '../../../shared/conversation-events';
import type { ChatRuntimeEvent } from '../../../shared/chat-runtime-events';
import { runtimeEventToConversationEvent } from './runtime-adapter';
import type { ConversationState, ConversationTurn } from './types';

type RuntimeArtifactVerificationEvent = Extract<ChatRuntimeEvent, {
  type: 'artifact.produced' | 'verification.completed';
}>;

export type RuntimeArtifactVerificationProjection = {
  events: ConversationEvent[];
  rejected: RuntimeArtifactVerificationEvent[];
};

function normalized(value: string | null | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

function artifactIdFor(event: RuntimeArtifactVerificationEvent): string | undefined {
  return event.type === 'artifact.produced'
    ? normalized(event.artifact.id)
    : normalized(event.verification.artifactId ?? event.verification.targetId);
}

function taskIdFor(event: RuntimeArtifactVerificationEvent): string | undefined {
  return normalized(
    event.taskId
    ?? (event.type === 'artifact.produced' ? event.artifact.taskId : event.verification.taskId),
  );
}

function toolCallIdFor(event: RuntimeArtifactVerificationEvent): string | undefined {
  return normalized(
    event.toolCallId
    ?? (event.type === 'artifact.produced' ? event.artifact.sourceToolCallId : undefined),
  );
}

function turnOwnsRun(turn: ConversationTurn, runId: string): boolean {
  return turn.rootRunId === runId || turn.runAliases.includes(runId);
}

function turnOwnsTask(turn: ConversationTurn, taskId: string): boolean {
  return turn.taskIds.includes(taskId) || Boolean(turn.taskById[taskId]);
}

function turnOwnsTool(turn: ConversationTurn, toolCallId: string): boolean {
  if (turn.toolItemByCallId[toolCallId]) return true;
  return turn.items.some((item) => (
    item.kind === 'artifact-group'
    && item.artifacts.some((artifact) => artifact.sourceToolCallId === toolCallId)
  ));
}

function turnOwnsArtifact(turn: ConversationTurn, artifactId: string): boolean {
  return turn.items.some((item) => (
    item.kind === 'artifact-group'
    && item.artifacts.some((artifact) => artifact.id === artifactId)
  ));
}

/** Resolve only explicit structured identities; unknown or ambiguous evidence is rejected. */
function resolveOwner(
  state: ConversationState,
  event: RuntimeArtifactVerificationEvent,
): ConversationTurn | null {
  const sessionKey = normalized(event.sessionKey);
  const turns = Object.values(state.turnsById);
  const identityMatches: ConversationTurn[][] = [];
  const rootRunId = normalized(event.rootRunId);
  const runId = normalized(event.runId);
  const taskId = taskIdFor(event);
  const toolCallId = toolCallIdFor(event);
  const artifactId = artifactIdFor(event);

  let knownOwnerIdentityCount = 0;
  if (sessionKey) {
    const sessionMatches = turns.filter((turn) => turn.sessionKey === sessionKey);
    if (sessionMatches.length === 0) return null;
    identityMatches.push(sessionMatches);
  }
  const addKnownOwnerMatches = (matches: ConversationTurn[]) => {
    if (matches.length === 0) return;
    knownOwnerIdentityCount += 1;
    identityMatches.push(matches);
  };
  if (rootRunId) addKnownOwnerMatches(turns.filter((turn) => turnOwnsRun(turn, rootRunId)));
  if (runId) addKnownOwnerMatches(turns.filter((turn) => turnOwnsRun(turn, runId)));
  if (taskId) addKnownOwnerMatches(turns.filter((turn) => turnOwnsTask(turn, taskId)));
  if (toolCallId) addKnownOwnerMatches(turns.filter((turn) => turnOwnsTool(turn, toolCallId)));
  if (artifactId) addKnownOwnerMatches(turns.filter((turn) => turnOwnsArtifact(turn, artifactId)));
  if (knownOwnerIdentityCount === 0) return null;

  const ownerIds = identityMatches
    .slice(1)
    .reduce(
      (intersection, matches) => {
        const ids = new Set(matches.map((turn) => turn.id));
        return new Set([...intersection].filter((turnId) => ids.has(turnId)));
      },
      new Set(identityMatches[0]!.map((turn) => turn.id)),
    );
  if (ownerIds.size !== 1) return null;
  const [ownerId] = ownerIds;
  return state.turnsById[ownerId!] ?? null;
}

function attachOwnerIdentity(
  event: RuntimeArtifactVerificationEvent,
  owner: ConversationTurn,
): RuntimeArtifactVerificationEvent {
  const taskId = taskIdFor(event);
  const toolCallId = toolCallIdFor(event);
  const common = {
    ...event,
    sessionKey: owner.sessionKey,
    rootRunId: owner.rootRunId ?? normalized(event.rootRunId) ?? event.runId,
    taskId,
    toolCallId,
  };
  return event.type === 'artifact.produced'
    ? {
        ...common,
        type: 'artifact.produced',
        artifact: {
          ...event.artifact,
          taskId: event.artifact.taskId ?? taskId,
          sourceToolCallId: event.artifact.sourceToolCallId ?? toolCallId,
        },
      }
    : {
        ...common,
        type: 'verification.completed',
        verification: {
          ...event.verification,
          taskId: event.verification.taskId ?? taskId,
        },
      };
}

/** Project local availability evidence into its existing canonical Turn without creating an orphan Turn. */
export function projectRuntimeArtifactVerificationEvents(
  state: ConversationState,
  runtimeEvents: RuntimeArtifactVerificationEvent[],
): RuntimeArtifactVerificationProjection {
  const events: ConversationEvent[] = [];
  const rejected: RuntimeArtifactVerificationEvent[] = [];

  for (const runtimeEvent of runtimeEvents) {
    const owner = resolveOwner(state, runtimeEvent);
    if (!owner) {
      rejected.push(runtimeEvent);
      continue;
    }
    const ownedEvent = attachOwnerIdentity(runtimeEvent, owner);
    const event = runtimeEventToConversationEvent(ownedEvent);
    if (event) events.push({ ...event, turnId: owner.id });
  }
  return { events, rejected };
}
