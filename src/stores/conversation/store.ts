import { create } from 'zustand';
import {
  CONVERSATION_EVENT_CONTRACT_VERSION,
  type ConversationEvent,
  type ConversationMessageSnapshot,
} from '../../../shared/conversation-events';
import type { ChatRuntimeEvent } from '../../../shared/chat-runtime-events';
import { resolveConversationTimelineMode } from '../../../shared/conversation-rollout';
import { trackUiEvent } from '../../lib/telemetry';
import type { RawMessage } from '../chat/types';
import { chatEventToConversationEvents } from './chat-adapter';
import { enqueueConversationEvents, flushConversationEvents, resetConversationDeltaBuffer } from './delta-buffer';
import { historyMessagesToConversationEvents } from './history-adapter';
import { createEventId, createTurnId, sessionAliasKeyBelongsTo } from './identity';
import {
  conversationPerformanceNow,
  recordConversationDuration,
  recordConversationIngress,
  recordConversationStoreCommit,
} from './metrics';
import {
  reduceConversationEvents,
  removeConversationSession,
  replaceSessionTurns,
} from './reducer';
import { runtimeEventToConversationEvents } from './runtime-adapter';
import {
  appendShadowComparison,
  createHistoryShadowComparison,
  createTerminalShadowComparison,
  shadowComparisonTelemetry,
  type ShadowComparisonRecord,
} from './shadow-compare';
import {
  createEmptyConversationState,
  type ConversationState,
  type ConversationTimelineMode,
  type ConversationTurn,
} from './types';

type ConversationActions = {
  mode: ConversationTimelineMode;
  expandedItemIds: Record<string, true>;
  followModeBySession: Record<string, 'following' | 'detached'>;
  shadowComparisonsBySession: Record<string, ShadowComparisonRecord[]>;
  shadowComparisonSessionOrder: string[];
  currentSessionKey: string | null;
  sessionAccessOrder: string[];
  setMode: (mode: ConversationTimelineMode) => void;
  setCurrentSession: (sessionKey: string) => void;
  setItemExpanded: (itemId: string, expanded: boolean) => void;
  setFollowMode: (sessionKey: string, mode: 'following' | 'detached') => void;
  ingestEvents: (events: ConversationEvent[], options?: { buffered?: boolean }) => void;
  ingestRuntimeEvent: (event: ChatRuntimeEvent) => void;
  ingestChatEvent: (
    event: Record<string, unknown>,
    context: { sessionKey: string; activeRunId?: string | null; rootRunId?: string; turnId?: string },
  ) => void;
  replaceHistory: (
    sessionKey: string,
    messages: RawMessage[],
    options?: {
      reason?: 'initial-load' | 'terminal-refresh' | 'manual-refresh';
      transcriptMtime?: number;
      additionalEvents?: ConversationEvent[];
      legacyMessages?: RawMessage[];
    },
  ) => void;
  beginLocalTurn: (input: {
    sessionKey: string;
    message: ConversationMessageSnapshot;
    mode?: 'chat' | 'image' | 'video';
  }) => string;
  bindRun: (turnId: string, sessionKey: string, runId: string, objective?: string) => void;
  markSessionActivity: (sessionKey: string, active: boolean, runId?: string) => void;
  compareAuthoritativeTerminal: (input: {
    sessionKey: string;
    runId: string;
    status: 'completed' | 'error' | 'aborted';
    legacyRunStatus?: 'completed' | 'error' | 'aborted';
  }) => void;
  removeSession: (sessionKey: string) => void;
  reset: () => void;
};

export type ConversationStore = ConversationState & ConversationActions;

export const CONVERSATION_SESSION_CACHE_LIMIT = 16;

const TERMINAL_TURN_STATUSES = new Set<ConversationTurn['status']>([
  'completed',
  'partial',
  'error',
  'aborted',
]);

function nonBufferedEvent(event: ConversationEvent): boolean {
  return event.type !== 'assistant.content'
    && event.type !== 'thinking.content'
    && event.type !== 'commentary.append'
    && event.type !== 'progress.updated'
    && event.type !== 'tool.updated';
}

function stateSlice(state: ConversationStore): ConversationState {
  return {
    noSequenceDedupeByScope: state.noSequenceDedupeByScope,
    quarantineBySession: state.quarantineBySession,
    ingressDiagnosticsBySession: state.ingressDiagnosticsBySession,
    eventsByTurnId: state.eventsByTurnId,
    eventRetentionByTurnId: state.eventRetentionByTurnId,
    turnOrderBySession: state.turnOrderBySession,
    turnsById: state.turnsById,
    aliases: state.aliases,
  };
}

function sessionHasCachedState(state: ConversationStore, sessionKey: string): boolean {
  return Object.hasOwn(state.turnOrderBySession, sessionKey)
    || Object.hasOwn(state.quarantineBySession, sessionKey)
    || Object.hasOwn(state.ingressDiagnosticsBySession, sessionKey)
    || Object.hasOwn(state.aliases.activeBySession, sessionKey)
    || Object.hasOwn(state.aliases.pendingLocalBySession, sessionKey)
    || Object.hasOwn(state.followModeBySession, sessionKey)
    || Object.hasOwn(state.shadowComparisonsBySession, sessionKey)
    || Object.keys(state.noSequenceDedupeByScope).some((scopeKey) => (
      sessionAliasKeyBelongsTo(scopeKey, sessionKey)
    ));
}

function sessionHasUnfinishedTurn(state: ConversationStore, sessionKey: string): boolean {
  if (state.aliases.activeBySession[sessionKey] || state.aliases.pendingLocalBySession[sessionKey]) {
    return true;
  }
  return (state.turnOrderBySession[sessionKey] ?? []).some((turnId) => {
    const turn = state.turnsById[turnId];
    return Boolean(turn && !TERMINAL_TURN_STATUSES.has(turn.status));
  });
}

function removeSessionFromStore(state: ConversationStore, sessionKey: string): ConversationStore {
  const canonical = removeConversationSession(stateSlice(state), sessionKey);
  const retainedItemIds = new Set(
    Object.values(canonical.turnsById).flatMap((turn) => turn.items.map((item) => item.id)),
  );
  return {
    ...state,
    ...canonical,
    expandedItemIds: Object.fromEntries(
      Object.entries(state.expandedItemIds).filter(([itemId]) => retainedItemIds.has(itemId)),
    ),
    followModeBySession: Object.fromEntries(
      Object.entries(state.followModeBySession).filter(([key]) => key !== sessionKey),
    ),
    shadowComparisonsBySession: Object.fromEntries(
      Object.entries(state.shadowComparisonsBySession).filter(([key]) => key !== sessionKey),
    ),
    shadowComparisonSessionOrder: state.shadowComparisonSessionOrder.filter((key) => key !== sessionKey),
    currentSessionKey: state.currentSessionKey === sessionKey ? null : state.currentSessionKey,
    sessionAccessOrder: state.sessionAccessOrder.filter((key) => key !== sessionKey),
  };
}

/** Touch sessions in deterministic ingress order and evict the oldest inactive entries. */
function retainBoundedSessions(
  state: ConversationStore,
  touchedSessionKeys: readonly string[],
): ConversationStore {
  const touched = [...new Set(touchedSessionKeys.filter(Boolean))];
  const touchedSet = new Set(touched);
  const nextOrder = state.sessionAccessOrder.filter((sessionKey) => (
    !touchedSet.has(sessionKey) && sessionHasCachedState(state, sessionKey)
  ));
  touched.forEach((sessionKey) => {
    if (sessionHasCachedState(state, sessionKey)) nextOrder.push(sessionKey);
  });
  const orderChanged = nextOrder.length !== state.sessionAccessOrder.length
    || nextOrder.some((sessionKey, index) => sessionKey !== state.sessionAccessOrder[index]);
  let next = orderChanged ? { ...state, sessionAccessOrder: nextOrder } : state;

  while (next.sessionAccessOrder.length > CONVERSATION_SESSION_CACHE_LIMIT) {
    const candidate = next.sessionAccessOrder.find((sessionKey) => (
      sessionKey !== next.currentSessionKey && !sessionHasUnfinishedTurn(next, sessionKey)
    ));
    // Current and unfinished sessions are protected. Terminal updates make a
    // temporarily oversized cache eligible for deterministic convergence.
    if (!candidate) break;
    next = removeSessionFromStore(next, candidate);
  }
  return next;
}

export const useConversationStore = create<ConversationStore>((set, get) => {
  const apply = (events: ConversationEvent[]) => {
    if (events.length === 0) return;
    set((state) => {
      const current = stateSlice(state);
      const startedAt = conversationPerformanceNow();
      const next = reduceConversationEvents(current, events);
      recordConversationDuration('reducer', conversationPerformanceNow() - startedAt);
      const reduced = next === current ? state : { ...state, ...next };
      const retained = retainBoundedSessions(reduced, events.map((event) => event.sessionKey));
      if (retained === state) return state;
      recordConversationStoreCommit();
      return retained;
    });
  };
  const ingestEvents = (events: ConversationEvent[], options?: { buffered?: boolean }) => {
    if (events.length === 0) return;
    recordConversationIngress(events.length);
    if (options?.buffered !== false && events.every((event) => !nonBufferedEvent(event))) {
      enqueueConversationEvents(events, apply);
      return;
    }
    flushConversationEvents(apply);
    apply(events);
  };
  const recordShadowComparison = (sessionKey: string, comparison: ShadowComparisonRecord) => {
    set((state) => {
      const next = appendShadowComparison({
        bySession: state.shadowComparisonsBySession,
        sessionOrder: state.shadowComparisonSessionOrder,
      }, sessionKey, comparison);
      return retainBoundedSessions({
        ...state,
        shadowComparisonsBySession: next.bySession,
        shadowComparisonSessionOrder: next.sessionOrder,
      }, [sessionKey]);
    });
    trackUiEvent('conversation.shadow_compare', shadowComparisonTelemetry(comparison));
  };

  return {
    ...createEmptyConversationState(),
    mode: resolveConversationTimelineMode(
      typeof window !== 'undefined' ? window.electron?.chatTimelineModeOverride : null,
      null,
    ),
    expandedItemIds: {},
    followModeBySession: {},
    shadowComparisonsBySession: {},
    shadowComparisonSessionOrder: [],
    currentSessionKey: null,
    sessionAccessOrder: [],
    setMode: (mode) => set({ mode }),
    setCurrentSession: (sessionKey) => set((state) => {
      const selected = state.currentSessionKey === sessionKey
        ? state
        : { ...state, currentSessionKey: sessionKey };
      return retainBoundedSessions(selected, [sessionKey]);
    }),
    setItemExpanded: (itemId, expanded) => set((state) => ({
      expandedItemIds: expanded
        ? { ...state.expandedItemIds, [itemId]: true }
        : Object.fromEntries(Object.entries(state.expandedItemIds).filter(([id]) => id !== itemId)),
    })),
    setFollowMode: (sessionKey, mode) => set((state) => {
      if ((state.followModeBySession[sessionKey] ?? 'following') === mode) return state;
      return retainBoundedSessions({
        ...state,
        followModeBySession: { ...state.followModeBySession, [sessionKey]: mode },
      }, [sessionKey]);
    }),
    ingestEvents,
    ingestRuntimeEvent: (event) => {
      const startedAt = conversationPerformanceNow();
      const canonical = runtimeEventToConversationEvents(event);
      recordConversationDuration('adapter', conversationPerformanceNow() - startedAt);
      ingestEvents(canonical);
    },
    ingestChatEvent: (event, context) => {
      const startedAt = conversationPerformanceNow();
      const canonical = chatEventToConversationEvents(event, context);
      recordConversationDuration('adapter', conversationPerformanceNow() - startedAt);
      ingestEvents(canonical);
    },
    replaceHistory: (sessionKey, messages, options) => {
      flushConversationEvents(apply);
      const adapterStartedAt = conversationPerformanceNow();
      const events = historyMessagesToConversationEvents(sessionKey, messages, options);
      const additionalEvents = (options?.additionalEvents ?? [])
        .filter((event) => event.sessionKey === sessionKey);
      const replayEvents = [...events, ...additionalEvents]
        .map((event, transcriptOrder) => ({ event, transcriptOrder }))
        .sort((left, right) => (
          left.event.occurredAt - right.event.occurredAt
          || left.event.receivedAt - right.event.receivedAt
          || left.transcriptOrder - right.transcriptOrder
          || left.event.eventId.localeCompare(right.event.eventId)
        ))
        .map(({ event }) => event);
      recordConversationDuration('adapter', conversationPerformanceNow() - adapterStartedAt);
      recordConversationIngress(replayEvents.length);
      const replayStartedAt = conversationPerformanceNow();
      set((state) => {
        const current = stateSlice(state);
        const next = replaceSessionTurns(current, sessionKey, replayEvents);
        const reduced = next === current ? state : { ...state, ...next };
        const retained = retainBoundedSessions(reduced, [sessionKey]);
        if (retained === state) return state;
        recordConversationStoreCommit();
        return retained;
      });
      recordConversationDuration('historyReplay', conversationPerformanceNow() - replayStartedAt);
      const state = get();
      if (state.mode === 'shadow') {
        recordShadowComparison(sessionKey, createHistoryShadowComparison({
          state: stateSlice(state),
          sessionKey,
          visibleMessages: options?.legacyMessages ?? messages,
          checkpointReason: options?.reason,
        }));
      }
    },
    beginLocalTurn: ({ sessionKey, message, mode }) => {
      const turnId = createTurnId({
        sessionKey,
        messageId: message.id,
        idempotencyKey: message.idempotencyKey,
        timestamp: message.timestamp,
        content: message.content,
      });
      const occurredAt = typeof message.timestamp === 'number'
        ? (message.timestamp < 100_000_000_000 ? message.timestamp * 1_000 : message.timestamp)
        : Date.now();
      const event: ConversationEvent = {
        version: CONVERSATION_EVENT_CONTRACT_VERSION,
        eventId: createEventId({ source: 'host', type: 'turn.requested', messageId: message.id ?? turnId, occurredAt, data: message.content }),
        type: 'turn.requested',
        source: 'host',
        authority: 'authoritative',
        sessionKey,
        turnId,
        messageId: message.id,
        occurredAt,
        receivedAt: Date.now(),
        replayed: false,
        data: { message, mode },
      };
      ingestEvents([event], { buffered: false });
      return turnId;
    },
    bindRun: (turnId, sessionKey, runId, objective) => {
      const occurredAt = Date.now();
      ingestEvents([{
        version: CONVERSATION_EVENT_CONTRACT_VERSION,
        eventId: createEventId({ source: 'host', type: 'run.started', runId, phase: 'started', occurredAt, data: objective }),
        type: 'run.started',
        source: 'host',
        authority: 'corroborating',
        sessionKey,
        turnId,
        rootRunId: runId,
        runId,
        occurredAt,
        receivedAt: occurredAt,
        replayed: false,
        data: { startedAt: occurredAt, objective },
      }], { buffered: false });
    },
    markSessionActivity: (sessionKey, active, runId) => {
      const occurredAt = Date.now();
      ingestEvents([{
        version: CONVERSATION_EVENT_CONTRACT_VERSION,
        eventId: createEventId({ source: 'host', type: 'session.activity', runId, phase: active ? 'active' : 'idle', occurredAt }),
        type: 'session.activity',
        source: 'host',
        authority: 'authoritative',
        sessionKey,
        rootRunId: runId,
        runId,
        occurredAt,
        receivedAt: occurredAt,
        replayed: false,
        data: { active },
      }], { buffered: false });
    },
    compareAuthoritativeTerminal: ({ sessionKey, runId, status, legacyRunStatus }) => {
      const state = get();
      if (state.mode !== 'shadow') return;
      const comparison = createTerminalShadowComparison({
        state: stateSlice(state),
        sessionKey,
        runId,
        expectedStatus: status,
        legacyRunStatus,
      });
      if (comparison) recordShadowComparison(sessionKey, comparison);
    },
    removeSession: (sessionKey) => {
      set((state) => removeSessionFromStore(state, sessionKey));
    },
    reset: () => {
      resetConversationDeltaBuffer();
      set({
        ...createEmptyConversationState(),
        expandedItemIds: {},
        followModeBySession: {},
        shadowComparisonsBySession: {},
        shadowComparisonSessionOrder: [],
        currentSessionKey: null,
        sessionAccessOrder: [],
      });
    },
  };
});

export function getSessionTurns(state: ConversationStore, sessionKey: string): ConversationTurn[] {
  return (state.turnOrderBySession[sessionKey] ?? [])
    .map((turnId) => state.turnsById[turnId])
    .filter((turn): turn is ConversationTurn => Boolean(turn));
}
