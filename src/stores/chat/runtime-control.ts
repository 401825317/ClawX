import type { ChatRuntimeEvent } from '../../../shared/chat-runtime-events';
import {
  applyAsyncTaskEvidenceToRuns,
} from './helpers';
import {
  applyCompletionWakeEvidenceEventToOwners,
  applyRuntimeEventToRuns,
  applyRuntimeTaskEventToOwners,
} from './runtime-graph';
import { buildRuntimeProgressEvents } from './runtime-progress';
import { buildRuntimeStartEvents } from './runtime-evidence';
import {
  findCachedSessionKeyForRunId,
  getCachedSessionRunState,
  mergeSessionRunStatePatch,
  peekCachedSessionRunState,
  replaceCachedSessionRunState,
} from './session-controller';
import type { ChatSendMode, ChatState } from './types';

type RuntimeRuns = ChatState['runtimeRuns'];
type RuntimeRun = RuntimeRuns[string];

export const LLM_IDLE_HINT_MS = 120_000;
export const NO_RESPONSE_SAFETY_TIMEOUT_MS = 130_000;

const ACTIVE_TURN_BOUNDARY_SKEW_MS = 5_000;
const USER_INITIATED_RUN_MAX_AGE_MS = 10 * 60 * 1000;
const CHAT_EVENT_DEDUPE_TTL_MS = 30_000;
const PENDING_RUNTIME_INTENT_TTL_MS = LLM_IDLE_HINT_MS + NO_RESPONSE_SAFETY_TIMEOUT_MS;
const PENDING_RUNTIME_INTENT_MAX_ENTRIES = 128;
const CHAT_EVENT_DEDUPE_MAX_ENTRIES = 8_192;

type PendingRuntimeIntent = {
  objective?: string;
  mode: ChatSendMode;
  createdAt: number;
};

const pendingRuntimeIntentBySession = new Map<string, PendingRuntimeIntent>();
const chatEventDedupe = new Map<string, number>();

function setBoundedMapEntry<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value as K | undefined;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function prunePendingRuntimeIntents(now: number): void {
  for (const [sessionKey, intent] of pendingRuntimeIntentBySession.entries()) {
    if (now - intent.createdAt > PENDING_RUNTIME_INTENT_TTL_MS) {
      pendingRuntimeIntentBySession.delete(sessionKey);
    }
  }
}

/** Normalizes OpenClaw timestamps that may be expressed in seconds or milliseconds. */
export function toMs(timestamp: number): number {
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

export function optionalToMs(timestamp: number | undefined | null): number | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  return toMs(timestamp);
}

function getRuntimeEventTimestampMs(event: ChatRuntimeEvent): number | null {
  const direct = optionalToMs(event.ts);
  if (direct != null) return direct;
  if (event.type === 'run.started') return optionalToMs(event.startedAt);
  if (event.type === 'run.ended') return optionalToMs(event.endedAt);
  return null;
}

function getRuntimeRunFirstEventMs(run: RuntimeRun | undefined): number | null {
  if (!run) return null;
  const startedAt = optionalToMs(run.startedAt);
  const eventTimes = run.events
    .map(getRuntimeEventTimestampMs)
    .filter((value): value is number => value != null);
  const firstEventAt = eventTimes.length > 0 ? Math.min(...eventTimes) : null;
  if (startedAt == null) return firstEventAt;
  if (firstEventAt == null) return startedAt;
  return Math.min(startedAt, firstEventAt);
}

/** Rejects stale run evidence that predates the currently owned user turn. */
export function runtimeRunStartedBeforeActiveTurn(
  state: Pick<ChatState, 'activeRunId' | 'lastUserMessageAt' | 'runtimeRuns'>,
  runId: string,
): boolean {
  if (state.activeRunId === runId) return false;
  const activeRunStartMs = state.activeRunId
    ? getRuntimeRunFirstEventMs(state.runtimeRuns[state.activeRunId])
    : null;
  const boundaryMs = activeRunStartMs ?? optionalToMs(state.lastUserMessageAt);
  const candidateRunStartMs = getRuntimeRunFirstEventMs(state.runtimeRuns[runId]);
  return boundaryMs != null
    && candidateRunStartMs != null
    && candidateRunStartMs < boundaryMs - ACTIVE_TURN_BOUNDARY_SKEW_MS;
}

/** Correlates a runtime event to the active renderer turn using session, run, and time evidence. */
export function runtimeEventBelongsToActiveTurn(
  state: Pick<ChatState, 'currentSessionKey' | 'sending' | 'activeRunId' | 'pendingFinal' | 'lastUserMessageAt' | 'runtimeRuns'>,
  event: ChatRuntimeEvent,
  eventSessionKey: string | null,
): boolean {
  if (!eventSessionKey || eventSessionKey !== state.currentSessionKey) return false;
  if (!state.sending && state.activeRunId == null && !state.pendingFinal) return false;
  if (state.activeRunId && event.runId === state.activeRunId) return true;
  if (runtimeRunStartedBeforeActiveTurn(state, event.runId)) return false;

  const activeRunStartMs = state.activeRunId
    ? getRuntimeRunFirstEventMs(state.runtimeRuns[state.activeRunId])
    : null;
  const boundaryMs = activeRunStartMs ?? optionalToMs(state.lastUserMessageAt);
  if (boundaryMs == null) return false;

  const eventMs = getRuntimeEventTimestampMs(event)
    ?? getRuntimeRunFirstEventMs(state.runtimeRuns[event.runId]);
  return eventMs != null && eventMs >= boundaryMs - ACTIVE_TURN_BOUNDARY_SKEW_MS;
}

function chatRunLooksRecentlyActive(run: RuntimeRun, now: number): boolean {
  if (run.status !== 'running') return false;
  if (typeof run.lastEventAt === 'number' && Number.isFinite(run.lastEventAt)) {
    return now - toMs(run.lastEventAt) < LLM_IDLE_HINT_MS + NO_RESPONSE_SAFETY_TIMEOUT_MS;
  }
  const lastEventTs = run.events.reduce<number | null>((latest, event) => {
    const timestamp = typeof event.ts === 'number' ? toMs(event.ts) : null;
    if (timestamp == null || !Number.isFinite(timestamp)) return latest;
    return latest == null ? timestamp : Math.max(latest, timestamp);
  }, null);
  const activityTs = lastEventTs
    ?? (typeof run.startedAt === 'number' ? toMs(run.startedAt) : null);
  if (activityTs == null) return true;
  return now - activityTs < LLM_IDLE_HINT_MS + NO_RESPONSE_SAFETY_TIMEOUT_MS;
}

export function hasRecentRuntimeActivityForSend(
  state: Pick<ChatState, 'activeRunId' | 'runtimeRuns'>,
  sessionKey: string,
  now = Date.now(),
): boolean {
  return Object.values(state.runtimeRuns).some((run) => {
    if (!chatRunLooksRecentlyActive(run, now)) return false;
    if (state.activeRunId && run.runId === state.activeRunId) return true;
    return run.sessionKey === sessionKey;
  });
}

/** Resolves run ownership without borrowing the currently selected session. */
export function inferSessionKeyForRun(
  state: Pick<ChatState, 'activeRunId' | 'currentSessionKey' | 'runtimeRuns'>,
  runId: string | null,
  explicitSessionKey: string | null,
): string | null {
  if (explicitSessionKey) return explicitSessionKey;
  if (!runId) return null;
  const runtimeSessionKey = state.runtimeRuns[runId]?.sessionKey;
  if (runtimeSessionKey) return runtimeSessionKey;
  if (state.activeRunId === runId) return state.currentSessionKey;
  return findCachedSessionKeyForRunId(runId);
}

export function rememberPendingRuntimeIntent(
  sessionKey: string,
  intent: { objective?: string; mode: ChatSendMode },
): void {
  const now = Date.now();
  prunePendingRuntimeIntents(now);
  setBoundedMapEntry(pendingRuntimeIntentBySession, sessionKey, {
    ...intent,
    objective: intent.objective?.trim() || undefined,
    createdAt: now,
  }, PENDING_RUNTIME_INTENT_MAX_ENTRIES);
}

function getPendingRuntimeIntent(sessionKey: string | undefined | null): PendingRuntimeIntent | undefined {
  if (!sessionKey) return undefined;
  const intent = pendingRuntimeIntentBySession.get(sessionKey);
  if (!intent) return undefined;
  if (Date.now() - intent.createdAt > PENDING_RUNTIME_INTENT_TTL_MS) {
    pendingRuntimeIntentBySession.delete(sessionKey);
    return undefined;
  }
  return intent;
}

export function clearPendingRuntimeIntent(sessionKey: string | undefined | null): void {
  if (sessionKey) pendingRuntimeIntentBySession.delete(sessionKey);
}

/** Applies runtime facts and their canonical owner/progress companions in one orchestration path. */
export function applyRuntimeContractEvents(
  currentRuns: RuntimeRuns,
  events: ChatRuntimeEvent[],
): RuntimeRuns {
  if (events.length === 0) return currentRuns;
  let nextRuns = currentRuns;
  for (const event of events) {
    const appliedEvents: ChatRuntimeEvent[] = [];
    if (event.type === 'task.updated') {
      const applied = applyRuntimeTaskEventToOwners(nextRuns, event);
      nextRuns = applied.runtimeRuns;
      appliedEvents.push(...applied.appliedEvents);
    } else if (event.type === 'artifact.produced' || event.type === 'verification.completed') {
      const applied = applyCompletionWakeEvidenceEventToOwners(nextRuns, event);
      nextRuns = applied.runtimeRuns;
      appliedEvents.push(...applied.appliedEvents);
    } else {
      const previousRuns = nextRuns;
      nextRuns = applyRuntimeEventToRuns(nextRuns, event);
      if (nextRuns !== previousRuns) appliedEvents.push(event);
    }
    if (appliedEvents.length === 0) continue;

    if (event.type === 'task.updated') {
      const ledgerStatus = event.task.status === 'completed'
        ? 'completed'
        : event.task.status === 'error' || event.task.status === 'partial'
          ? 'error'
          : 'pending';
      nextRuns = applyAsyncTaskEvidenceToRuns(nextRuns, event.runId, [{
        id: `task:${event.task.taskId}`,
        taskId: event.task.taskId,
        runId: event.runId,
        childSessionKey: event.task.childSessionKey,
        status: ledgerStatus,
        source: ledgerStatus === 'pending' ? 'tool-result' : 'task-completion',
        updatedAt: event.task.updatedAt ?? event.ts ?? Date.now(),
      }], event.sessionKey);
    }

    for (const appliedEvent of appliedEvents) {
      if (appliedEvent.type === 'progress.update') continue;
      const progressEvents = buildRuntimeProgressEvents(nextRuns[appliedEvent.runId], appliedEvent);
      for (const progressEvent of progressEvents) {
        nextRuns = applyRuntimeEventToRuns(nextRuns, progressEvent);
      }
    }
  }
  return nextRuns;
}

export function buildRuntimeStartEventsForRun(
  runtimeRuns: RuntimeRuns,
  params: {
    runId: string;
    sessionKey?: string;
    objective?: string;
    mode?: ChatSendMode;
    ts?: number;
    includeStarted?: boolean;
  },
): ChatRuntimeEvent[] {
  if (!params.runId) return [];
  const intent = getPendingRuntimeIntent(params.sessionKey);
  return buildRuntimeStartEvents(runtimeRuns[params.runId], {
    runId: params.runId,
    sessionKey: params.sessionKey,
    objective: params.objective ?? intent?.objective,
    mode: params.mode ?? intent?.mode,
    ts: params.ts,
    includeStarted: params.includeStarted,
  });
}

/**
 * Updates a background session's cached controls from runtime lifecycle evidence.
 * Returns the session that chat.ts must settle and schedule for terminal refresh.
 */
export function updateCachedSessionRunStateFromRuntimeEvent(
  event: ChatRuntimeEvent,
  runtimeRuns: RuntimeRuns,
  holdForAsyncTask = false,
): string | null {
  const sessionKey = event.sessionKey;
  if (!sessionKey) return null;
  const cached = peekCachedSessionRunState(sessionKey);
  if (!cached) return null;

  const next = mergeSessionRunStatePatch(cached, {});
  const matchesCachedRun = next.activeRunId != null && event.runId === next.activeRunId;
  const cachedTurnStartMs = optionalToMs(next.lastUserMessageAt);
  const eventRunStartMs = getRuntimeRunFirstEventMs(runtimeRuns[event.runId]);
  const eventTimestampMs = optionalToMs(event.ts);
  const eventRunPredatesCachedTurn = cachedTurnStartMs != null
    && eventRunStartMs != null
    && eventRunStartMs < cachedTurnStartMs - ACTIVE_TURN_BOUNDARY_SKEW_MS;
  const isCurrentUntrackedSend = next.activeRunId == null
    && next.sending
    && !eventRunPredatesCachedTurn
    && (
      eventTimestampMs == null
      || cachedTurnStartMs == null
      || eventTimestampMs >= cachedTurnStartMs - 1_000
    );

  if (event.type === 'run.started') {
    if (next.activeRunId == null || matchesCachedRun) {
      next.activeRunId = event.runId;
      next.sending = true;
    }
    replaceCachedSessionRunState(sessionKey, next);
    return null;
  }

  if (event.type !== 'run.ended' || (!matchesCachedRun && !isCurrentUntrackedSend)) return null;
  if (holdForAsyncTask) {
    next.sending = true;
    next.activeRunId = event.runId;
    next.pendingFinal = true;
    replaceCachedSessionRunState(sessionKey, next);
    return null;
  }
  return sessionKey;
}

export function shouldTrackInboundRunLifecycle(
  state: Pick<ChatState, 'lastUserMessageAt' | 'sending' | 'activeRunId' | 'pendingFinal'>,
  sessionKey?: string,
  now = Date.now(),
): boolean {
  if (state.sending || state.activeRunId != null || state.pendingFinal) return true;
  if (sessionKey) {
    const cached = getCachedSessionRunState(sessionKey);
    if (cached.sending || cached.activeRunId != null || cached.pendingFinal) return true;
  }
  if (!state.lastUserMessageAt) return false;
  return now - toMs(state.lastUserMessageAt) <= USER_INITIATED_RUN_MAX_AGE_MS;
}

export function isRecoverableRuntimeError(errorMessage: string): boolean {
  const normalized = errorMessage.trim().toLowerCase();
  if (!normalized) return false;
  return /\bterminated\b/.test(normalized)
    || /\baborted\b/.test(normalized)
    || normalized.includes('econnreset')
    || normalized.includes('connection reset');
}

export function isReplySessionInitializationConflictError(errorMessage: string): boolean {
  const normalized = errorMessage.trim().toLowerCase();
  return normalized.includes('reply session initialization conflicted')
    || (
      normalized.includes('reply session')
      && normalized.includes('initialization')
      && (normalized.includes('conflict') || normalized.includes('conflicted'))
    );
}

export function normalizeChatRunErrorMessage(errorMessage: string): string {
  const normalized = errorMessage.trim();
  const lower = normalized.toLowerCase();
  if (!normalized) return 'The task ended without a model response. Please retry.';
  if (isReplySessionInitializationConflictError(normalized)) {
    return 'UClaw hit a reply session handoff conflict while the previous turn was still settling. The conversation was refreshed; retry this message.';
  }
  if (
    lower.includes('context overflow')
    || lower.includes('prompt too large')
    || lower.includes('context size exceeds')
    || lower.includes('context length')
  ) {
    return 'The task context became too large for the model. Start a new conversation or ask UClaw to summarize and continue.';
  }
  if (
    lower.includes('non_deliverable_terminal_turn')
    || lower.includes('non-deliverable terminal')
  ) {
    return 'The task reached a terminal state but the final reply was not delivered. Refreshing the conversation history may show the result.';
  }
  return normalized;
}

export function buildNoResponseSafetyMessage(): string {
  return 'The task has not produced new visible progress for a while. UClaw stopped waiting to keep the app responsive. Refresh the conversation or retry if the task did not finish.';
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

function pruneChatEventDedupe(now: number): void {
  for (const [key, timestamp] of chatEventDedupe.entries()) {
    if (now - timestamp > CHAT_EVENT_DEDUPE_TTL_MS) chatEventDedupe.delete(key);
  }
}

function buildChatEventDedupeKey(eventState: string, event: Record<string, unknown>): string | null {
  const runId = event.runId != null ? String(event.runId) : '';
  const sessionKey = event.sessionKey != null ? String(event.sessionKey) : '';
  const seq = event.seq != null ? String(event.seq) : '';
  if (eventState === 'final' && !seq) {
    const message = event.message && typeof event.message === 'object'
      ? event.message as Record<string, unknown>
      : null;
    const messageId = message?.id != null ? String(message.id) : '';
    const fingerprint = hashString(JSON.stringify(message ?? event));
    return ['final-nosq', runId, sessionKey, messageId || fingerprint].join('|');
  }
  if (eventState === 'delta' && !seq) return null;
  if (runId || sessionKey || seq || eventState) return [runId, sessionKey, seq, eventState].join('|');

  const message = event.message && typeof event.message === 'object'
    ? event.message as Record<string, unknown>
    : null;
  if (!message) return null;
  const messageId = message.id != null ? String(message.id) : '';
  const stopReason = message.stopReason ?? message.stop_reason;
  return messageId || stopReason
    ? `msg|${messageId}|${String(stopReason ?? '')}|${eventState}`
    : null;
}

function getFinalMessageIdDedupeKey(eventState: string, event: Record<string, unknown>): string | null {
  if (eventState !== 'final') return null;
  const message = event.message && typeof event.message === 'object'
    ? event.message as Record<string, unknown>
    : null;
  return message?.id != null ? `final-msgid|${String(message.id)}` : null;
}

/** Deduplicates transport retries while preserving legitimate no-sequence deltas. */
export function isDuplicateChatEvent(eventState: string, event: Record<string, unknown>): boolean {
  const key = buildChatEventDedupeKey(eventState, event);
  const messageKey = getFinalMessageIdDedupeKey(eventState, event);
  if (!key && !messageKey) return false;
  const now = Date.now();
  pruneChatEventDedupe(now);
  if ((key && chatEventDedupe.has(key)) || (messageKey && chatEventDedupe.has(messageKey))) return true;
  if (key) setBoundedMapEntry(chatEventDedupe, key, now, CHAT_EVENT_DEDUPE_MAX_ENTRIES);
  if (messageKey) setBoundedMapEntry(chatEventDedupe, messageKey, now, CHAT_EVENT_DEDUPE_MAX_ENTRIES);
  return false;
}
