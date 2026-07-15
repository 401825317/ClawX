import type {
  ChatRuntimeArtifact,
  ChatRuntimeTaskProjection,
} from '../../../shared/chat-runtime-events';
import type { ConversationMessageSnapshot } from '../../../shared/conversation-events';
import type {
  ConversationState,
  ConversationTurn,
  FinalAnswerItem,
  UserMessageItem,
} from './types';
import { isActiveTurnStatus } from './types';

const ACTIVE_TASK_STATUSES = new Set<ChatRuntimeTaskProjection['status']>([
  'pending',
  'running',
  'waiting_approval',
]);
const TERMINAL_TASK_SIGNALS = new Set([
  'aborted',
  'cancelled',
  'canceled',
  'completed',
  'delivered',
  'error',
  'failed',
  'failure',
  'partial',
  'stopped',
  'succeeded',
  'success',
  'terminated',
  'timed_out',
  'timeout',
]);
const RUNNING_BACKEND_SESSION_STATUSES = new Set([
  'running',
  'active',
  'queued',
  'in_progress',
  'processing',
]);
const COMPLETION_WAKE_RUN_ID_RE = /^(?:image_generate|image_edit|video_generate|music_generate):([^:]+):([^:]+)$/iu;

export type ConversationOwnerIdentity = {
  sessionKey?: string | null;
  runId?: string | null;
  taskId?: string | null;
};

export type CompletionWakeIdentity = {
  runId: string;
  rootRunId?: string | null;
  sessionKey?: string | null;
  taskId?: string | null;
};

export type CompletionWakeCorrelation = {
  turnId: string;
  runId: string;
  rootRunId: string;
  sessionKey: string;
  taskId: string;
};

export type CanonicalEventSessionCorrelation = {
  sessionKey: string;
  turnId?: string;
  rootRunId?: string;
};

export type CancellableTaskSelection = {
  tasks: ChatRuntimeTaskProjection[];
  hostTasks: ChatRuntimeTaskProjection[];
  nativeTasks: ChatRuntimeTaskProjection[];
  taskIds: string[];
  hostTaskIds: string[];
  nativeTaskIds: string[];
};

export type ConversationImageReference = {
  turnId: string;
  itemId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  filePath: string;
  preview: string | null;
  source: 'user-trigger' | 'final-answer' | 'artifact';
};

export type BackendSessionActivity = {
  key: string;
  status?: string;
  hasActiveRun?: boolean;
};

function normalized(value: string | null | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

function turnOwnsRun(turn: ConversationTurn, runId: string): boolean {
  return turn.rootRunId === runId || turn.runAliases.includes(runId);
}

function turnOwnsTask(turn: ConversationTurn, taskId: string): boolean {
  return turn.taskIds.includes(taskId) || Boolean(turn.taskById[taskId]);
}

function matchingTurnOwners(
  state: ConversationState,
  identity: ConversationOwnerIdentity,
): ConversationTurn[] {
  const sessionKey = normalized(identity.sessionKey);
  const runId = normalized(identity.runId);
  const taskId = normalized(identity.taskId);
  if (!runId && !taskId) return [];

  return Object.values(state.turnsById).filter((turn) => (
    (!sessionKey || turn.sessionKey === sessionKey)
    && (!runId || turnOwnsRun(turn, runId))
    && (!taskId || turnOwnsTask(turn, taskId))
  ));
}

/** Resolve explicit session/run/task evidence only when it identifies one canonical owner. */
export function resolveUniqueTurnOwner(
  state: ConversationState,
  identity: ConversationOwnerIdentity,
): ConversationTurn | null {
  const owners = matchingTurnOwners(state, identity);
  return owners.length === 1 ? owners[0]! : null;
}

function uniquePendingLocalOwner(state: ConversationState): ConversationTurn | null {
  const pendingTurnIds = [...new Set(Object.values(state.aliases.pendingLocalBySession))];
  const pendingTurns = pendingTurnIds
    .map((turnId) => state.turnsById[turnId])
    .filter((turn): turn is ConversationTurn => Boolean(turn && isActiveTurnStatus(turn.status)));
  return pendingTurns.length === 1 ? pendingTurns[0]! : null;
}

function canonicalIdentityOwner(
  state: ConversationState,
  rootRunId: string | undefined,
  runId: string | undefined,
  taskId: string | undefined,
): ConversationTurn | null {
  const candidates: ConversationOwnerIdentity[] = [
    ...(rootRunId ? [{ runId: rootRunId, taskId }] : []),
    ...(runId && taskId ? [{ runId, taskId }] : []),
    ...(rootRunId ? [{ runId: rootRunId }] : []),
    ...(runId ? [{ runId }] : []),
    ...(taskId ? [{ taskId }] : []),
  ];
  for (const candidate of candidates) {
    const owner = resolveUniqueTurnOwner(state, candidate);
    if (owner) return owner;
  }
  return null;
}

/** Route a general event only from explicit identity, canonical ownership, or one pending local Turn. */
export function resolveCanonicalEventSession(
  state: ConversationState,
  identity: ConversationOwnerIdentity & { rootRunId?: string | null },
  options?: { allowPendingLocal?: boolean },
): CanonicalEventSessionCorrelation | null {
  const sessionKey = normalized(identity.sessionKey);
  const rootRunId = normalized(identity.rootRunId);
  const runId = normalized(identity.runId);
  const taskId = normalized(identity.taskId);

  if (sessionKey) {
    const owner = canonicalIdentityOwner(state, rootRunId, runId, taskId);
    if (owner && owner.sessionKey !== sessionKey) return null;
    return {
      sessionKey,
      ...(owner ? { turnId: owner.id, rootRunId: owner.rootRunId ?? rootRunId ?? runId } : {}),
    };
  }

  const owner = canonicalIdentityOwner(state, rootRunId, runId, taskId);
  if (owner) {
    return {
      sessionKey: owner.sessionKey,
      turnId: owner.id,
      rootRunId: owner.rootRunId ?? rootRunId ?? runId,
    };
  }

  if (!options?.allowPendingLocal) return null;
  const pendingOwner = uniquePendingLocalOwner(state);
  return pendingOwner
    ? {
        sessionKey: pendingOwner.sessionKey,
        turnId: pendingOwner.id,
        ...(pendingOwner.rootRunId ? { rootRunId: pendingOwner.rootRunId } : {}),
      }
    : null;
}

/** Extract the detached task encoded by a media completion-wake run ID. */
export function completionWakeTaskIdFromRunId(runId: string): string | null {
  return COMPLETION_WAKE_RUN_ID_RE.exec(runId.trim())?.[1] ?? null;
}

function completionWakeTaskId(identity: CompletionWakeIdentity): string | undefined {
  const explicitTaskId = normalized(identity.taskId);
  const encodedTaskId = completionWakeTaskIdFromRunId(identity.runId) ?? undefined;
  if (explicitTaskId && encodedTaskId && explicitTaskId !== encodedTaskId) return undefined;
  return explicitTaskId ?? encodedTaskId;
}

function ownerRunId(turn: ConversationTurn, childRunId: string, explicitRootRunId?: string): string | undefined {
  if (explicitRootRunId) return explicitRootRunId;
  if (turn.rootRunId && turn.rootRunId !== childRunId) return turn.rootRunId;
  return turn.runAliases.find((runId) => runId !== childRunId);
}

/** Correlate a completion wake without replacing its child run identity. */
export function resolveCompletionWakeCorrelation(
  state: ConversationState,
  identity: CompletionWakeIdentity,
): CompletionWakeCorrelation | null {
  const childRunId = normalized(identity.runId);
  const sessionKey = normalized(identity.sessionKey);
  const explicitRootRunId = normalized(identity.rootRunId);
  const taskId = completionWakeTaskId(identity);
  if (!childRunId || !taskId) return null;

  let owner: ConversationTurn | null;
  if (explicitRootRunId) {
    // Explicit lineage owns routing. A known task owner may corroborate it,
    // but contradictory task evidence must reject the event.
    owner = resolveUniqueTurnOwner(state, { sessionKey, runId: explicitRootRunId });
    if (!owner) return null;
    const taskOwners = matchingTurnOwners(state, { sessionKey, taskId });
    if (taskOwners.length > 0 && !taskOwners.some((candidate) => candidate.id === owner?.id)) return null;
  } else {
    owner = resolveUniqueTurnOwner(state, { sessionKey, taskId });
  }
  if (!owner) return null;

  const rootRunId = ownerRunId(owner, childRunId, explicitRootRunId);
  if (!rootRunId) return null;
  return {
    turnId: owner.id,
    runId: childRunId,
    rootRunId,
    sessionKey: owner.sessionKey,
    taskId,
  };
}

function scopedActiveTurn(
  state: ConversationState,
  sessionKey: string,
  turnId: string | undefined,
): ConversationTurn | null {
  const turn = turnId ? state.turnsById[turnId] : undefined;
  return turn?.sessionKey === sessionKey && isActiveTurnStatus(turn.status) ? turn : null;
}

/** Select the canonical Turn that currently owns interactive work for a session. */
export function selectActiveTurn(state: ConversationState, rawSessionKey: string): ConversationTurn | null {
  const sessionKey = rawSessionKey.trim();
  if (!sessionKey) return null;

  const indexed = scopedActiveTurn(state, sessionKey, state.aliases.activeBySession[sessionKey])
    ?? scopedActiveTurn(state, sessionKey, state.aliases.pendingLocalBySession[sessionKey]);
  if (indexed) return indexed;

  const turnIds = state.turnOrderBySession[sessionKey] ?? [];
  for (let index = turnIds.length - 1; index >= 0; index -= 1) {
    const turn = scopedActiveTurn(state, sessionKey, turnIds[index]);
    if (turn) return turn;
  }
  return null;
}

/** Report whether canonical state still contains interactive work for a session. */
export function selectSessionBusy(state: ConversationState, sessionKey: string): boolean {
  return selectActiveTurn(state, sessionKey) !== null;
}

function taskHasTerminalSignal(task: ChatRuntimeTaskProjection): boolean {
  if (!ACTIVE_TASK_STATUSES.has(task.status)) return true;
  if (task.endedAt != null) return true;
  return [task.sourceStatus, task.terminalOutcome, task.deliveryStatus]
    .map((value) => value?.trim().toLowerCase())
    .some((value) => Boolean(value && TERMINAL_TASK_SIGNALS.has(value)));
}

function orderedTurnTasks(turn: ConversationTurn): ChatRuntimeTaskProjection[] {
  const orderedIds = [
    ...turn.taskIds,
    ...Object.keys(turn.taskById).filter((taskId) => !turn.taskIds.includes(taskId)),
  ];
  return orderedIds
    .map((taskId) => turn.taskById[taskId])
    .filter((task): task is ChatRuntimeTaskProjection => Boolean(task));
}

/** Collect non-terminal tasks and split Host tasks from native OpenClaw tasks. */
export function collectCancellableTasks(turn: ConversationTurn | null | undefined): CancellableTaskSelection {
  const tasks = turn ? orderedTurnTasks(turn).filter((task) => !taskHasTerminalSignal(task)) : [];
  const hostTasks = tasks.filter((task) => task.runtime === 'uclaw-host-task');
  const nativeTasks = tasks.filter((task) => task.runtime !== 'uclaw-host-task');
  return {
    tasks,
    hostTasks,
    nativeTasks,
    taskIds: tasks.map((task) => task.taskId),
    hostTaskIds: hostTasks.map((task) => task.taskId),
    nativeTaskIds: nativeTasks.map((task) => task.taskId),
  };
}

function hasRetryableContent(value: unknown, depth = 0): boolean {
  if (depth > 4 || value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((entry) => hasRetryableContent(entry, depth + 1));
  if (typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return hasRetryableContent(record.text, depth + 1)
    || hasRetryableContent(record.content, depth + 1);
}

function triggerCanRetry(trigger: UserMessageItem): boolean {
  const message = trigger.message;
  if (message.role !== 'user') return false;
  if (hasRetryableContent(message.content)) return true;
  return (message.attachments ?? []).some((file) => Boolean(file.filePath?.trim()));
}

/** Select the latest user trigger whose text or local attachments can be sent again. */
export function selectLastRetryableUserTrigger(
  state: ConversationState,
  rawSessionKey: string,
): UserMessageItem | null {
  const sessionKey = rawSessionKey.trim();
  const turnIds = state.turnOrderBySession[sessionKey] ?? [];
  for (let index = turnIds.length - 1; index >= 0; index -= 1) {
    const turn = state.turnsById[turnIds[index]!];
    if (turn?.sessionKey === sessionKey && triggerCanRetry(turn.trigger)) return turn.trigger;
  }
  return null;
}

/** Expose retry only for the latest failed Turn in the selected session. */
export function selectLatestRecoverableErrorTurnId(
  state: ConversationState,
  rawSessionKey: string,
): string | null {
  const sessionKey = rawSessionKey.trim();
  const turnIds = state.turnOrderBySession[sessionKey] ?? [];
  const turnId = turnIds.at(-1);
  const turn = turnId ? state.turnsById[turnId] : undefined;
  if (!turn || turn.sessionKey !== sessionKey || turn.status !== 'error') return null;
  return turn.items.some((item) => item.kind === 'error' && item.recoverable)
    ? turn.id
    : null;
}

function timestampMs(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value < 100_000_000_000 ? value * 1_000 : value;
}

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/u).at(-1)?.trim() || 'image';
}

function inferredImageMimeType(filePath: string): string | undefined {
  const extension = /\.([^.\\/?#]+)(?:[?#].*)?$/u.exec(filePath)?.[1]?.toLowerCase();
  const mimeByExtension: Record<string, string> = {
    avif: 'image/avif',
    bmp: 'image/bmp',
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    webp: 'image/webp',
  };
  return extension ? mimeByExtension[extension] : undefined;
}

function attachmentImageReference(
  turnId: string,
  itemId: string,
  file: NonNullable<ConversationMessageSnapshot['attachments']>[number],
  source: ConversationImageReference['source'],
): ConversationImageReference | null {
  const filePath = normalized(file.filePath);
  if (!filePath || !file.mimeType.startsWith('image/')) return null;
  return {
    turnId,
    itemId,
    fileName: normalized(file.fileName) ?? fileNameFromPath(filePath),
    mimeType: file.mimeType,
    fileSize: Number.isFinite(file.fileSize) ? file.fileSize : 0,
    filePath,
    preview: file.preview ?? null,
    source,
  };
}

function artifactImageReference(
  turnId: string,
  itemId: string,
  artifact: ChatRuntimeArtifact,
): ConversationImageReference | null {
  const filePath = normalized(artifact.filePath);
  if (
    !filePath
    || artifact.error
    || (artifact.availability != null && artifact.availability !== 'available')
  ) {
    return null;
  }
  const mimeType = normalized(artifact.mimeType) ?? inferredImageMimeType(filePath);
  if (!mimeType?.startsWith('image/')) return null;
  return {
    turnId,
    itemId,
    fileName: normalized(artifact.title) ?? fileNameFromPath(filePath),
    mimeType,
    fileSize: Number.isFinite(artifact.sizeBytes) ? artifact.sizeBytes! : 0,
    filePath,
    preview: artifact.preview ?? null,
    source: 'artifact',
  };
}

type TimedImageReference = {
  reference: ConversationImageReference;
  occurredAt: number;
  order: number;
};

function laterImage(
  current: TimedImageReference | null,
  candidate: TimedImageReference,
): TimedImageReference {
  if (!current) return candidate;
  if (candidate.occurredAt !== current.occurredAt) {
    return candidate.occurredAt > current.occurredAt ? candidate : current;
  }
  return candidate.order > current.order ? candidate : current;
}

function finalAnswerImageCandidates(turn: ConversationTurn, item: FinalAnswerItem): ConversationImageReference[] {
  return (item.message.attachments ?? [])
    .filter((file) => file.disposition !== 'input-reference' && file.source !== 'user-upload')
    .map((file) => attachmentImageReference(turn.id, item.id, file, 'final-answer'))
    .filter((file): file is ConversationImageReference => Boolean(file));
}

/** Select the chronologically latest local image that can be reused by an image request. */
export function selectLatestUsableImage(
  state: ConversationState,
  rawSessionKey: string,
): ConversationImageReference | null {
  const sessionKey = rawSessionKey.trim();
  const turnIds = state.turnOrderBySession[sessionKey] ?? [];
  let latest: TimedImageReference | null = null;
  let order = 0;

  for (const turnId of turnIds) {
    const turn = state.turnsById[turnId];
    if (!turn || turn.sessionKey !== sessionKey) continue;

    // A user upload is a new chronological image source for subsequent edits.
    for (const file of turn.trigger.message.attachments ?? []) {
      const reference = attachmentImageReference(turn.id, turn.trigger.id, file, 'user-trigger');
      if (!reference) continue;
      latest = laterImage(latest, {
        reference,
        occurredAt: timestampMs(turn.trigger.message.timestamp, turn.trigger.updatedAt),
        order: order++,
      });
    }

    for (const item of turn.items) {
      if (item.kind === 'artifact-group') {
        for (const artifact of item.artifacts) {
          const reference = artifactImageReference(turn.id, item.id, artifact);
          if (!reference) continue;
          latest = laterImage(latest, { reference, occurredAt: item.updatedAt, order: order++ });
        }
      } else if (item.kind === 'final-answer') {
        for (const reference of finalAnswerImageCandidates(turn, item)) {
          latest = laterImage(latest, {
            reference,
            occurredAt: timestampMs(item.message.timestamp, item.updatedAt),
            order: order++,
          });
        }
      }
    }
  }
  return latest?.reference ?? null;
}

function normalizeAgentId(value: string | undefined): string {
  return value?.trim().toLowerCase() || 'main';
}

function agentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  return normalizeAgentId(sessionKey.split(':')[1]);
}

function backendSessionIsRunning(session: BackendSessionActivity): boolean {
  if (session.hasActiveRun === true) return true;
  const status = session.status?.trim().toLowerCase();
  return Boolean(status && RUNNING_BACKEND_SESSION_STATUSES.has(status));
}

/** Merge backend liveness with canonical active Turns to identify busy agents. */
export function selectRunningAgentIds(
  state: ConversationState,
  backendSessions: readonly BackendSessionActivity[],
): string[] {
  const agentIds = new Set<string>();
  for (const session of backendSessions) {
    if (backendSessionIsRunning(session)) agentIds.add(agentIdFromSessionKey(session.key));
  }

  const canonicalSessionKeys = new Set([
    ...Object.keys(state.turnOrderBySession),
    ...Object.keys(state.aliases.activeBySession),
    ...Object.keys(state.aliases.pendingLocalBySession),
    ...Object.values(state.turnsById).map((turn) => turn.sessionKey),
  ]);
  for (const sessionKey of canonicalSessionKeys) {
    if (selectSessionBusy(state, sessionKey)) agentIds.add(agentIdFromSessionKey(sessionKey));
  }
  return [...agentIds].sort();
}
