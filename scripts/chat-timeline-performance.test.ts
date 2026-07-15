import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONVERSATION_EVENT_CONTRACT_VERSION,
  type ConversationEvent,
} from '../shared/conversation-events';
import {
  enqueueConversationEvents,
  resetConversationDeltaBuffer,
} from '../src/stores/conversation/delta-buffer';
import { historyMessagesToConversationEvents } from '../src/stores/conversation/history-adapter';
import {
  assertConversationState,
  NO_SEQUENCE_DEDUPE_LIMIT,
  reduceConversationEvents,
} from '../src/stores/conversation/reducer';
import {
  CONVERSATION_SESSION_CACHE_LIMIT,
  useConversationStore,
} from '../src/stores/conversation/store';
import { createEmptyConversationState } from '../src/stores/conversation/types';
import {
  getConversationPerformanceSnapshot,
  recordConversationStoreCommit,
  recordTimelineItemRender,
  resetConversationPerformanceMetrics,
} from '../src/stores/conversation/metrics';
import type { RawMessage } from '../src/stores/chat/types';

const SESSION_KEY = 'agent:main:timeline-performance';

/** Build deterministic user/assistant history pairs without relying on wall time. */
function buildHistory(messageCount: number): RawMessage[] {
  return Array.from({ length: messageCount }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    id: `message-${index}`,
    timestamp: 1_700_000_000 + index,
    content: index % 2 === 0 ? `Question ${index / 2}` : `Answer ${(index - 1) / 2}`,
  }));
}

/** Create one replace-style assistant update for a known turn. */
function assistantEvent(turnId: string, index: number): ConversationEvent {
  return {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: `performance:assistant:${index}`,
    type: 'assistant.content',
    source: 'openclaw-runtime',
    authority: 'corroborating',
    sessionKey: SESSION_KEY,
    turnId,
    runId: 'performance-run',
    occurredAt: 1_800_000_000_000 + index,
    receivedAt: 1_800_000_000_000 + index,
    replayed: false,
    data: { text: `Streaming ${index}`, replace: true },
  };
}

test('500-message history replay stays bounded and creates 250 stable turns', () => {
  const startedAt = performance.now();
  const state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(SESSION_KEY, buildHistory(500)),
  );
  const elapsedMs = performance.now() - startedAt;

  assertConversationState(state);
  assert.equal(state.turnOrderBySession[SESSION_KEY].length, 250);
  assert.ok(elapsedMs < 5_000, `500-message replay took ${elapsedMs.toFixed(1)}ms`);
  for (const turnId of state.turnOrderBySession[SESSION_KEY]) {
    const turn = state.turnsById[turnId];
    assert.equal(turn.items.filter((item) => item.kind === 'final-answer').length, 1);
  }
});

test('updating the active turn preserves completed-turn object identity', () => {
  const initial = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(SESSION_KEY, buildHistory(3)),
  );
  const [completedTurnId, activeTurnId] = initial.turnOrderBySession[SESSION_KEY];
  const completedTurn = initial.turnsById[completedTurnId];
  const next = reduceConversationEvents(initial, [assistantEvent(activeTurnId, 1)]);

  assert.equal(next.turnsById[completedTurnId], completedTurn);
  assert.notEqual(next.turnsById[activeTurnId], initial.turnsById[activeTurnId]);
});

test('one event batch avoids per-event copies of the large turn index', () => {
  const initial = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(SESSION_KEY, buildHistory(500)),
  );
  const activeTurnId = initial.turnOrderBySession[SESSION_KEY].at(-1);
  assert.ok(activeTurnId);
  const events = Array.from({ length: 400 }, (_, index) => assistantEvent(activeTurnId, index));
  reduceConversationEvents(initial, events.slice(0, 10));

  const batchStartedAt = performance.now();
  reduceConversationEvents(initial, events);
  const batchMs = performance.now() - batchStartedAt;

  const sequentialStartedAt = performance.now();
  events.reduce((state, event) => reduceConversationEvents(state, [event]), initial);
  const sequentialMs = performance.now() - sequentialStartedAt;

  assert.ok(
    batchMs * 1.5 < sequentialMs,
    `batch ${batchMs.toFixed(1)}ms should materially beat sequential ${sequentialMs.toFixed(1)}ms`,
  );
});

test('canonical event retention stays bounded for active and completed turns', () => {
  const turnId = 'turn:bounded-retention';
  const sequenced = Array.from({ length: 600 }, (_, index): ConversationEvent => ({
    ...assistantEvent(turnId, index),
    eventId: `performance:sequenced:${index}`,
    seq: index + 1,
    data: { delta: 'x' },
  }));
  let state = reduceConversationEvents(createEmptyConversationState(), sequenced);
  assert.ok(state.eventsByTurnId[turnId].length <= 256);
  assert.equal(state.eventRetentionByTurnId[turnId].totalEventCount, 600);
  assert.ok(state.eventRetentionByTurnId[turnId].droppedEventCount > 0);

  const terminal: ConversationEvent = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'performance:terminal',
    type: 'run.ended',
    source: 'openclaw-runtime',
    authority: 'authoritative',
    sessionKey: SESSION_KEY,
    turnId,
    runId: 'performance-run',
    seq: 601,
    occurredAt: 1_800_000_001_000,
    receivedAt: 1_800_000_001_000,
    replayed: false,
    data: { status: 'completed' },
  };
  state = reduceConversationEvents(state, [terminal]);
  assert.ok(state.eventsByTurnId[turnId].length <= 64);
  assert.equal(state.eventRetentionByTurnId[turnId].totalEventCount, 601);

  const noSequence = Array.from({ length: 3_000 }, (_, index): ConversationEvent => ({
    ...assistantEvent('turn:bounded-no-seq', index),
    eventId: `performance:no-seq:${index}`,
    runId: 'performance-no-seq-run',
    occurredAt: 1_900_000_000_000 + index,
    receivedAt: 1_900_000_000_000 + index,
    data: { delta: 'y' },
  }));
  state = reduceConversationEvents(state, noSequence);
  assert.ok(Object.values(state.noSequenceDedupeByScope).every(
    (bucket) => bucket.eventOrder.length <= NO_SEQUENCE_DEDUPE_LIMIT,
  ));
  assert.ok(state.eventsByTurnId['turn:bounded-no-seq'].length <= 256);

  const historyFinal: ConversationEvent = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'performance:history-final',
    type: 'final.message',
    source: 'history',
    authority: 'authoritative',
    sessionKey: SESSION_KEY,
    turnId: 'turn:bounded-no-seq',
    occurredAt: 1_900_000_004_000,
    receivedAt: 1_900_000_004_000,
    replayed: true,
    data: { message: { role: 'assistant', content: 'History complete.' } },
  };
  const checkpoint: ConversationEvent = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'performance:history-checkpoint',
    type: 'history.checkpoint',
    source: 'history',
    authority: 'authoritative',
    sessionKey: SESSION_KEY,
    occurredAt: 1_900_000_004_001,
    receivedAt: 1_900_000_004_001,
    replayed: true,
    data: { messageCount: 2, reason: 'initial-load' },
  };
  const backendIdle: ConversationEvent = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'performance:history-backend-idle',
    type: 'session.activity',
    source: 'host',
    authority: 'authoritative',
    sessionKey: SESSION_KEY,
    turnId: 'turn:bounded-no-seq',
    runId: 'performance-no-seq-run',
    occurredAt: 1_900_000_004_002,
    receivedAt: 1_900_000_004_002,
    replayed: false,
    data: { active: false },
  };
  state = reduceConversationEvents(state, [historyFinal, checkpoint, backendIdle]);
  assert.ok(state.eventsByTurnId['turn:bounded-no-seq'].length <= 64);
});

test('high-frequency deltas schedule one flush through requestAnimationFrame', () => {
  resetConversationDeltaBuffer();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const frameCallbacks: FrameRequestCallback[] = [];
  let flushCount = 0;
  let flushedEventCount = 0;
  const events = Array.from({ length: 120 }, (_, index) => assistantEvent('turn:buffered', index));

  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          frameCallbacks.push(callback);
          return frameCallbacks.length;
        },
      },
    });

    for (const event of events) {
      enqueueConversationEvents([event], (batch) => {
        flushCount += 1;
        flushedEventCount += batch.length;
      });
    }

    assert.equal(flushCount, 0);
    assert.equal(frameCallbacks.length, 1);
    frameCallbacks[0](performance.now());
    assert.equal(flushCount, 1);
    assert.equal(flushedEventCount, events.length);
  } finally {
    resetConversationDeltaBuffer();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('long-running session navigation keeps canonical store indexes bounded and supports replay on revisit', () => {
  const store = useConversationStore.getState();
  const sessionCount = CONVERSATION_SESSION_CACHE_LIMIT * 4;
  store.reset();
  store.setMode('timeline');
  try {
    const startedAt = performance.now();
    for (let index = 0; index < sessionCount; index += 1) {
      store.replaceHistory(`agent:main:performance-session-${index}`, buildHistory(2));
    }
    const elapsedMs = performance.now() - startedAt;
    let state = useConversationStore.getState();
    const retainedTurnIds = new Set(Object.values(state.turnOrderBySession).flat());

    assert.equal(state.sessionAccessOrder.length, CONVERSATION_SESSION_CACHE_LIMIT);
    assert.equal(Object.keys(state.turnOrderBySession).length, CONVERSATION_SESSION_CACHE_LIMIT);
    assert.equal(Object.keys(state.turnsById).length, retainedTurnIds.size);
    assert.equal(Object.keys(state.eventsByTurnId).length, retainedTurnIds.size);
    assert.equal(Object.keys(state.eventRetentionByTurnId).length, retainedTurnIds.size);
    assert.equal(state.turnOrderBySession['agent:main:performance-session-0'], undefined);
    assert.ok(elapsedMs < 5_000, `session cache replay took ${elapsedMs.toFixed(1)}ms`);
    Object.values(state.aliases).forEach((aliases) => {
      Object.values(aliases).forEach((turnId) => assert.ok(retainedTurnIds.has(turnId)));
    });

    const revisitedSession = 'agent:main:performance-session-0';
    store.setCurrentSession(revisitedSession);
    store.replaceHistory(revisitedSession, buildHistory(2));
    state = useConversationStore.getState();
    assert.equal(state.sessionAccessOrder.length, CONVERSATION_SESSION_CACHE_LIMIT);
    assert.equal(state.sessionAccessOrder.at(-1), revisitedSession);
    assert.equal(state.turnOrderBySession[revisitedSession].length, 1);
    assert.equal(state.turnsById[state.turnOrderBySession[revisitedSession][0]].items
      .filter((item) => item.kind === 'final-answer').length, 1);
  } finally {
    useConversationStore.getState().reset();
  }
});

test('runtime instrumentation records projection cost without retaining event payloads', () => {
  const before = getConversationPerformanceSnapshot();
  reduceConversationEvents(createEmptyConversationState(), [assistantEvent('turn:instrumented', 1)]);
  const after = getConversationPerformanceSnapshot();

  assert.equal(after.projection.count, before.projection.count + 1);
  assert.ok(after.projection.lastMs >= 0);
  assert.deepEqual(Object.keys(after).sort(), [
    'adapter',
    'averageFps',
    'historyReplay',
    'ingressEvents',
    'itemRenders',
    'itemRendersByItemId',
    'itemRendersByTurnId',
    'longTaskObserverSupported',
    'longTasks',
    'maxMountedRows',
    'maxScrollCorrectionPx',
    'maxStoreCommitsPerFrame',
    'mountedRows',
    'projection',
    'reducer',
    'sampledFrames',
    'scrollCorrections',
    'slowFrames',
    'storeCommits',
  ]);
});

test('performance metrics reset and attribute renders by turn and item', () => {
  resetConversationPerformanceMetrics();
  recordTimelineItemRender('turn:completed', 'item:completed');
  recordTimelineItemRender('turn:active', 'item:active');
  recordTimelineItemRender('turn:active', 'item:active');
  recordConversationStoreCommit();
  recordConversationStoreCommit();

  const measured = getConversationPerformanceSnapshot();
  assert.equal(measured.itemRenders, 3);
  assert.deepEqual(measured.itemRendersByTurnId, {
    'turn:completed': 1,
    'turn:active': 2,
  });
  assert.deepEqual(measured.itemRendersByItemId, {
    'item:completed': 1,
    'item:active': 2,
  });
  assert.equal(measured.storeCommits, 2);
  assert.equal(measured.maxStoreCommitsPerFrame, 2);

  resetConversationPerformanceMetrics();
  const reset = getConversationPerformanceSnapshot();
  assert.equal(reset.itemRenders, 0);
  assert.deepEqual(reset.itemRendersByTurnId, {});
  assert.deepEqual(reset.itemRendersByItemId, {});
  assert.equal(reset.storeCommits, 0);
  assert.equal(reset.maxStoreCommitsPerFrame, 0);
});
