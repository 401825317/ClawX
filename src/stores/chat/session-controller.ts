import type { ChatRuntimeEvent } from '../../../shared/chat-runtime-events';
import { runtimeRunHasPendingAsyncTasks } from './helpers';
import type { ChatSession, ChatState, RawMessage } from './types';

type RuntimeRuns = ChatState['runtimeRuns'];
type RuntimeRun = RuntimeRuns[string];
type RunTerminalStatus = Extract<ChatRuntimeEvent, { type: 'run.ended' }>['status'];

export type SessionRunState = Pick<
  ChatState,
  | 'sending'
  | 'pendingImageGenerationLocal'
  | 'pendingVideoGenerationLocal'
  | 'activeRunId'
  | 'pendingFinal'
  | 'lastUserMessageAt'
  | 'streamingText'
  | 'streamingMessage'
  | 'streamingTools'
  | 'pendingToolImages'
>;

export const DEFAULT_SESSION_RUN_STATE: SessionRunState = {
  sending: false,
  pendingImageGenerationLocal: false,
  pendingVideoGenerationLocal: false,
  activeRunId: null,
  pendingFinal: false,
  lastUserMessageAt: null,
  streamingText: '',
  streamingMessage: null,
  streamingTools: [],
  pendingToolImages: [],
};

const SESSION_RUN_STATE_CACHE_MAX_SESSIONS = 32;
const sessionRunStateCache = new Map<string, SessionRunState>();

/** Keeps the newest raw messages within the inactive-session cache budget. */
export function boundSessionHistoryMessages(messages: RawMessage[], maxMessages: number): RawMessage[] {
  if (maxMessages <= 0) return [];
  return messages.length > maxMessages ? messages.slice(-maxMessages) : messages;
}

/** Advances an explicit transcript page without exceeding the Renderer budget. */
export function nextHistoryMessageLimit(
  currentLimit: number,
  pageSize: number,
  maxMessages: number,
): number {
  return Math.min(currentLimit + pageSize, maxMessages);
}

function toMs(timestamp: number): number {
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

function optionalToMs(timestamp: number | undefined | null): number | null {
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? toMs(timestamp) : null;
}

function cloneSessionRunState(state: SessionRunState): SessionRunState {
  return {
    sending: state.sending,
    pendingImageGenerationLocal: state.pendingImageGenerationLocal,
    pendingVideoGenerationLocal: state.pendingVideoGenerationLocal,
    activeRunId: state.activeRunId,
    pendingFinal: state.pendingFinal,
    lastUserMessageAt: state.lastUserMessageAt,
    streamingText: state.streamingText,
    streamingMessage: state.streamingMessage,
    streamingTools: [...state.streamingTools],
    pendingToolImages: state.pendingToolImages.map((file) => ({ ...file })),
  };
}

function setBoundedSessionRunState(sessionKey: string, state: SessionRunState): void {
  if (sessionRunStateCache.has(sessionKey)) sessionRunStateCache.delete(sessionKey);
  sessionRunStateCache.set(sessionKey, state);
  while (sessionRunStateCache.size > SESSION_RUN_STATE_CACHE_MAX_SESSIONS) {
    const oldestKey = sessionRunStateCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    sessionRunStateCache.delete(oldestKey);
  }
}

/** Captures one session's transient composer/run state in the bounded session cache. */
export function captureSessionRunState(sessionKey: string, state: SessionRunState): void {
  setBoundedSessionRunState(sessionKey, cloneSessionRunState(state));
}

/** Reads and refreshes one cached session state for session-switch restoration. */
export function getCachedSessionRunState(sessionKey: string): SessionRunState {
  const cached = sessionRunStateCache.get(sessionKey);
  if (!cached) return DEFAULT_SESSION_RUN_STATE;
  sessionRunStateCache.delete(sessionKey);
  sessionRunStateCache.set(sessionKey, cached);
  return cloneSessionRunState(cached);
}

/** Reads a cached state without changing its LRU position. */
export function peekCachedSessionRunState(sessionKey: string): SessionRunState | undefined {
  return sessionRunStateCache.get(sessionKey);
}

/** Replaces an existing cached state without changing its LRU position. */
export function replaceCachedSessionRunState(sessionKey: string, state: SessionRunState): void {
  sessionRunStateCache.set(sessionKey, state);
}

export function clearCachedSessionRunState(sessionKey: string): void {
  sessionRunStateCache.delete(sessionKey);
}

export function findCachedSessionKeyForRunId(runId: string): string | null {
  for (const [sessionKey, runState] of sessionRunStateCache.entries()) {
    if (runState.activeRunId === runId) return sessionKey;
  }
  return null;
}

export function mergeSessionRunStatePatch(
  base: SessionRunState,
  patch: Partial<SessionRunState>,
): SessionRunState {
  return {
    sending: patch.sending ?? base.sending,
    pendingImageGenerationLocal: patch.pendingImageGenerationLocal ?? base.pendingImageGenerationLocal,
    pendingVideoGenerationLocal: patch.pendingVideoGenerationLocal ?? base.pendingVideoGenerationLocal,
    activeRunId: patch.activeRunId !== undefined ? patch.activeRunId : base.activeRunId,
    pendingFinal: patch.pendingFinal ?? base.pendingFinal,
    lastUserMessageAt: patch.lastUserMessageAt !== undefined ? patch.lastUserMessageAt : base.lastUserMessageAt,
    streamingText: patch.streamingText ?? base.streamingText,
    streamingMessage: patch.streamingMessage !== undefined ? patch.streamingMessage : base.streamingMessage,
    streamingTools: patch.streamingTools ? [...patch.streamingTools] : [...base.streamingTools],
    pendingToolImages: patch.pendingToolImages
      ? patch.pendingToolImages.map((file) => ({ ...file }))
      : base.pendingToolImages.map((file) => ({ ...file })),
  };
}

export function parseSessionUpdatedAtMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return toMs(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function parseSessionStatus(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}

export function getSessionTerminalRuntimeStatus(status: string | undefined): RunTerminalStatus | undefined {
  if (status === 'done' || status === 'completed' || status === 'finished') return 'completed';
  if (status === 'failed' || status === 'error') return 'error';
  if (status === 'aborted' || status === 'cancelled') return 'aborted';
  return undefined;
}

export function getBackendSessionLifecycle(session: ChatSession | undefined): {
  idle: boolean;
  terminalStatus?: RunTerminalStatus;
} {
  if (!session) return { idle: false };
  const terminalStatus = getSessionTerminalRuntimeStatus(session.status);
  if (session.hasActiveRun === true) return { idle: false };
  if (session.hasActiveRun === false) return { idle: true, terminalStatus };
  if (session.status === 'running' || session.status === 'active') return { idle: false };
  if (terminalStatus) return { idle: true, terminalStatus };
  return { idle: false };
}

export function backendSessionReportsActive(session: ChatSession | undefined): boolean {
  if (!session) return false;
  if (session.hasActiveRun === true) return true;
  if (session.hasActiveRun === false) return false;
  return session.status === 'running' || session.status === 'active';
}

export function shouldTrustBackendSessionIdle(
  session: ChatSession | undefined,
  lastUserMessageAt: number | null,
): boolean {
  const lifecycle = getBackendSessionLifecycle(session);
  if (!lifecycle.idle) return false;
  if (
    lastUserMessageAt != null
    && typeof session?.updatedAt === 'number'
    && session.updatedAt < toMs(lastUserMessageAt)
  ) {
    return false;
  }
  return true;
}

function findGatewaySessionRow(
  data: Record<string, unknown>,
  sessionKey: string,
): Record<string, unknown> | undefined {
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const row = sessions.find((candidate) => (
    candidate != null
    && typeof candidate === 'object'
    && String((candidate as Record<string, unknown>).key ?? '') === sessionKey
  ));
  return row && typeof row === 'object' ? row as Record<string, unknown> : undefined;
}

export function gatewaySessionIsIdle(data: Record<string, unknown>, sessionKey: string): boolean {
  const row = findGatewaySessionRow(data, sessionKey);
  if (!row) return false;
  if (row.hasActiveRun === true) return false;
  if (row.hasActiveRun === false) return true;
  return getSessionTerminalRuntimeStatus(parseSessionStatus(row.status)) != null;
}

export function parseGatewaySessionProbe(
  data: Record<string, unknown>,
  sessionKey: string,
): ChatSession | undefined {
  const record = findGatewaySessionRow(data, sessionKey);
  if (!record) return undefined;
  return {
    key: sessionKey,
    updatedAt: parseSessionUpdatedAtMs(record.updatedAt),
    status: parseSessionStatus(record.status),
    hasActiveRun: typeof record.hasActiveRun === 'boolean' ? record.hasActiveRun : undefined,
  };
}

export type GatewayHistorySessionAuthority = {
  session: ChatSession;
  inFlightRunId?: string;
  requestStartedAt: number;
  explicitlyActive: boolean;
  explicitlyIdle: boolean;
};

export function parseGatewayHistorySessionAuthority(
  data: Record<string, unknown>,
  sessionKey: string,
  requestStartedAt: number,
): GatewayHistorySessionAuthority | undefined {
  const sessionInfo = data.sessionInfo && typeof data.sessionInfo === 'object' && !Array.isArray(data.sessionInfo)
    ? data.sessionInfo as Record<string, unknown>
    : undefined;
  const inFlightRun = data.inFlightRun && typeof data.inFlightRun === 'object' && !Array.isArray(data.inFlightRun)
    ? data.inFlightRun as Record<string, unknown>
    : undefined;
  const inFlightRunId = typeof inFlightRun?.runId === 'string' && inFlightRun.runId.trim()
    ? inFlightRun.runId.trim()
    : undefined;
  const reportedActive = typeof sessionInfo?.hasActiveRun === 'boolean'
    ? sessionInfo.hasActiveRun
    : undefined;
  const status = parseSessionStatus(sessionInfo?.status);
  const statusReportsActive = reportedActive == null && (status === 'running' || status === 'active');
  const terminalStatus = getSessionTerminalRuntimeStatus(status);
  const explicitlyActive = Boolean(inFlightRunId || reportedActive === true || statusReportsActive);
  const explicitlyIdle = !explicitlyActive
    && (reportedActive === false || (reportedActive == null && terminalStatus != null));
  if (!sessionInfo && !inFlightRunId) return undefined;

  const updatedAt = parseSessionUpdatedAtMs(sessionInfo?.updatedAt);
  return {
    session: {
      key: sessionKey,
      ...(updatedAt != null ? { updatedAt } : {}),
      ...(status ? { status } : {}),
      ...(reportedActive != null || inFlightRunId ? { hasActiveRun: explicitlyActive } : {}),
    },
    inFlightRunId,
    requestStartedAt,
    explicitlyActive,
    explicitlyIdle,
  };
}

export function findRunningRuntimeRunForSession(
  runtimeRuns: RuntimeRuns,
  sessionKey: string,
  preferredRunId?: string | null,
): RuntimeRun | undefined {
  const preferredRun = preferredRunId ? runtimeRuns[preferredRunId] : undefined;
  if (preferredRun?.sessionKey === sessionKey && preferredRun.status === 'running') return preferredRun;

  let latestRunningRun: RuntimeRun | undefined;
  let latestRunningRunActivity = -Infinity;
  for (const run of Object.values(runtimeRuns)) {
    if (run.sessionKey !== sessionKey || run.status !== 'running') continue;
    const activityAt = optionalToMs(run.lastEventAt) ?? optionalToMs(run.startedAt) ?? 0;
    if (!latestRunningRun || activityAt >= latestRunningRunActivity) {
      latestRunningRun = run;
      latestRunningRunActivity = activityAt;
    }
  }
  return latestRunningRun;
}

type ApplyRuntimeEvents = (runtimeRuns: RuntimeRuns, events: ChatRuntimeEvent[]) => RuntimeRuns;

export function alignRuntimeRunsWithBackendSessionTerminalState(
  runtimeRuns: RuntimeRuns,
  sessionKey: string,
  session: ChatSession | undefined,
  preferredRunId: string | null | undefined,
  applyRuntimeEvents: ApplyRuntimeEvents,
): RuntimeRuns {
  const { terminalStatus } = getBackendSessionLifecycle(session);
  if (!terminalStatus) return runtimeRuns;

  const runningRun = findRunningRuntimeRunForSession(runtimeRuns, sessionKey, preferredRunId);
  if (!runningRun || runtimeRunHasPendingAsyncTasks(runningRun)) return runtimeRuns;

  return applyRuntimeEvents(runtimeRuns, [{
    runId: runningRun.runId,
    sessionKey,
    ts: session?.updatedAt ?? Date.now(),
    type: 'run.ended',
    status: terminalStatus,
  } satisfies ChatRuntimeEvent]);
}

export type NormalizeSessionModelRef = (modelRef: string | null | undefined) => string | null;

export function mergeSessionRowWithLocalState(
  nextSession: ChatSession,
  localSession: ChatSession | undefined,
  normalizeModelRef: NormalizeSessionModelRef,
): ChatSession {
  const normalizedNextSession = {
    ...nextSession,
    model: normalizeModelRef(nextSession.model) ?? undefined,
    cwd: nextSession.cwd?.trim() || undefined,
  };
  if (!localSession) return normalizedNextSession;

  const localUpdatedAt = typeof localSession.updatedAt === 'number' ? localSession.updatedAt : undefined;
  const nextUpdatedAt = typeof normalizedNextSession.updatedAt === 'number'
    ? normalizedNextSession.updatedAt
    : undefined;
  const normalizedLocalModel = normalizeModelRef(localSession.model) ?? undefined;
  const normalizedLocalCwd = localSession.cwd?.trim() || undefined;
  const shouldPreserveLocalModel = Boolean(
    normalizedLocalModel
    && (
      !normalizedNextSession.model
      || (localUpdatedAt != null && nextUpdatedAt != null && localUpdatedAt > nextUpdatedAt)
    ),
  );
  const shouldPreserveLocalCwd = Boolean(
    (!normalizedNextSession.cwd && normalizedLocalCwd)
    || (localUpdatedAt != null && nextUpdatedAt != null && localUpdatedAt > nextUpdatedAt),
  );

  return {
    ...normalizedNextSession,
    model: shouldPreserveLocalModel ? normalizedLocalModel : normalizedNextSession.model,
    cwd: shouldPreserveLocalCwd ? normalizedLocalCwd : normalizedNextSession.cwd,
    updatedAt: shouldPreserveLocalModel || shouldPreserveLocalCwd ? localUpdatedAt : nextUpdatedAt,
  };
}

export function mergeBackendSessionProbe(
  sessions: ChatSession[],
  session: ChatSession,
  normalizeModelRef: NormalizeSessionModelRef,
): ChatSession[] {
  let matched = false;
  const next = sessions.map((candidate) => {
    if (candidate.key !== session.key) return candidate;
    matched = true;
    return mergeSessionRowWithLocalState({ ...candidate, ...session }, candidate, normalizeModelRef);
  });
  return matched ? next : [...next, session];
}

export function getCanonicalPrefixFromSessions(sessions: ChatSession[]): string | null {
  const canonical = sessions.find((session) => session.key.startsWith('agent:'))?.key;
  if (!canonical) return null;
  const parts = canonical.split(':');
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : null;
}

export function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  return sessionKey.split(':')[1] || 'main';
}

export function getCanonicalPrefixFromSessionKey(sessionKey: string): string | null {
  if (!sessionKey.startsWith('agent:')) return null;
  const parts = sessionKey.split(':');
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : null;
}

export type SessionSwitchState = Pick<
  ChatState,
  | 'currentSessionKey'
  | 'messages'
  | 'sessions'
  | 'sessionLabels'
  | 'sessionLastActivity'
  | 'thinkingLevel'
  | 'sending'
  | 'pendingImageGenerationLocal'
  | 'pendingVideoGenerationLocal'
  | 'activeRunId'
  | 'pendingFinal'
  | 'lastUserMessageAt'
  | 'streamingText'
  | 'streamingMessage'
  | 'streamingTools'
  | 'pendingToolImages'
>;

type CachedSessionHistory = {
  messages: RawMessage[];
  thinkingLevel: string | null;
};

function ensureSessionEntry(sessions: ChatSession[], sessionKey: string): ChatSession[] {
  return sessions.some((session) => session.key === sessionKey)
    ? sessions
    : [...sessions, { key: sessionKey, displayName: sessionKey }];
}

function clearSessionEntryFromMap<T extends Record<string, unknown>>(entries: T, sessionKey: string): T {
  return Object.fromEntries(Object.entries(entries).filter(([key]) => key !== sessionKey)) as T;
}

/** Builds the pure session-switch patch after chat.ts has handled cache side effects. */
export function buildSessionSwitchPatch(params: {
  state: SessionSwitchState;
  nextSessionKey: string;
  cachedNextSession: CachedSessionHistory | null;
  cachedRunState: SessionRunState;
  restoreMessageLimit: number;
  historyPageSize: number;
}): { patch: Partial<ChatState>; leavingEmpty: boolean } {
  const {
    state,
    nextSessionKey,
    cachedNextSession,
    cachedRunState,
    restoreMessageLimit,
    historyPageSize,
  } = params;
  const leavingEmpty = !state.currentSessionKey.endsWith(':main')
    && state.messages.length === 0
    && !state.sessionLastActivity[state.currentSessionKey]
    && !state.sessionLabels[state.currentSessionKey];
  const nextSessions = leavingEmpty
    ? state.sessions.filter((session) => session.key !== state.currentSessionKey)
    : state.sessions;
  const cachedMessages = cachedNextSession?.messages ?? [];
  const restoredCachedMessages = cachedMessages.length > restoreMessageLimit
    ? cachedMessages.slice(-restoreMessageLimit)
    : cachedMessages;

  return {
    leavingEmpty,
    patch: {
      currentSessionKey: nextSessionKey,
      currentAgentId: getAgentIdFromSessionKey(nextSessionKey),
      sessions: ensureSessionEntry(nextSessions, nextSessionKey),
      sessionLabels: leavingEmpty
        ? clearSessionEntryFromMap(state.sessionLabels, state.currentSessionKey)
        : state.sessionLabels,
      sessionLastActivity: leavingEmpty
        ? clearSessionEntryFromMap(state.sessionLastActivity, state.currentSessionKey)
        : state.sessionLastActivity,
      messages: restoredCachedMessages,
      hasMoreHistory: cachedNextSession
        ? cachedNextSession.messages.length >= historyPageSize
          || cachedNextSession.messages.length > restoredCachedMessages.length
        : false,
      historyMessageLimit: historyPageSize,
      loadingMoreHistory: false,
      thinkingLevel: cachedNextSession?.thinkingLevel ?? state.thinkingLevel ?? null,
      ...cachedRunState,
      error: null,
      runError: null,
      historyError: null,
    },
  };
}
