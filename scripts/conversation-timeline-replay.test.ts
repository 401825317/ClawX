import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGatewayChatRuntimeEvents } from '../electron/gateway/chat-runtime-events';
import { projectTaskLedgerRecord } from '../electron/gateway/task-ledger-monitor';
import { CHAT_SYNTHETIC_TERMINAL_PRODUCER, type ChatRuntimeEvent } from '../shared/chat-runtime-events';
import {
  CONVERSATION_EVENT_CONTRACT_VERSION,
  type ConversationEvent,
} from '../shared/conversation-events';
import {
  chatEventToConversationEvents,
  createChatEventContext,
  normalizeGatewayChatEnvelope,
} from '../src/stores/conversation/chat-adapter';
import {
  collectCancellableTasks,
  selectActiveTurn,
} from '../src/stores/conversation/control-selectors';
import { historyMessagesToConversationEvents } from '../src/stores/conversation/history-adapter';
import { hostTasksToConversationEvents } from '../src/stores/conversation/host-task-adapter';
import {
  createSessionAliasKey,
  createTurnId,
  sessionAliasKeyBelongsTo,
} from '../src/stores/conversation/identity';
import {
  assertConversationState,
  NO_SEQUENCE_DEDUPE_LIMIT,
  QUARANTINE_EVENT_LIMIT,
  reduceConversationEvents,
  removeConversationSession,
  replaceSessionTurns,
} from '../src/stores/conversation/reducer';
import {
  runtimeEventToConversationEvent,
  runtimeEventToConversationEvents,
} from '../src/stores/conversation/runtime-adapter';
import { projectRuntimeArtifactVerificationEvents } from '../src/stores/conversation/artifact-verification-adapter';
import {
  CONVERSATION_SESSION_CACHE_LIMIT,
  useConversationStore,
} from '../src/stores/conversation/store';
import { createEmptyConversationState } from '../src/stores/conversation/types';
import {
  buildRuntimeArtifactEventsFromAttachedFiles,
  buildRuntimeArtifactVerificationEvent,
} from '../src/stores/chat/runtime-evidence';
import {
  correlateCompletionWakeRuntimeEvent,
  resolveCompletionWakeOwnerContext,
} from '../src/stores/chat/runtime-graph';
import type { RawMessage } from '../src/stores/chat/types';

const SESSION_KEY = 'agent:main:timeline-replay';
const RUN_ID = 'run-timeline-replay';

function runtime(events: ChatRuntimeEvent[]) {
  return events.map(runtimeEventToConversationEvent).filter((event): event is NonNullable<typeof event> => Boolean(event));
}

function completedHistory(sessionKey: string, revision = 'initial'): RawMessage[] {
  return [{
    role: 'user',
    id: `${sessionKey}:user:${revision}`,
    idempotencyKey: `${sessionKey}:request:${revision}`,
    timestamp: 1_700_000_000,
    content: `Question ${revision}`,
  }, {
    role: 'assistant',
    id: `${sessionKey}:assistant:${revision}`,
    timestamp: 1_700_000_001,
    content: `Answer ${revision}`,
  }];
}

function timelineKinds(messages: RawMessage[]) {
  const state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(SESSION_KEY, messages),
  );
  assertConversationState(state);
  const turnId = state.turnOrderBySession[SESSION_KEY][0];
  return state.turnsById[turnId].items.map((item) => item.kind);
}

test('gateway chat envelope normalization supports modern nested and legacy final shapes', () => {
  const modernMessage = {
    role: 'assistant',
    id: 'modern-final-message',
    timestamp: 1_000,
    content: 'Modern final answer.',
  } satisfies RawMessage;
  const modern = normalizeGatewayChatEnvelope({
    sessionKey: 'agent:main:modern-wrapper',
    runId: 'run-modern-wrapper',
    message: {
      state: 'final',
      seq: 7,
      message: modernMessage,
    },
  });
  assert.ok(modern);
  assert.equal(modern.state, 'final');
  assert.equal(modern.seq, 7);
  assert.equal(modern.sessionKey, 'agent:main:modern-wrapper');
  assert.equal(modern.runId, 'run-modern-wrapper');
  assert.equal(modern.message, modernMessage);

  const legacyDirect = {
    state: 'final',
    sessionKey: 'agent:main:legacy-direct',
    runId: 'run-legacy-direct',
    message: {
      role: 'assistant',
      id: 'legacy-direct-final',
      timestamp: 1_001,
      content: 'Legacy direct final answer.',
    } satisfies RawMessage,
  };
  assert.equal(normalizeGatewayChatEnvelope(legacyDirect), legacyDirect);

  const rawFinal = {
    role: 'assistant',
    id: 'legacy-raw-final',
    timestamp: 1_002,
    content: 'Legacy raw final answer.',
  } satisfies RawMessage;
  const normalizedRawFinal = normalizeGatewayChatEnvelope(rawFinal);
  assert.ok(normalizedRawFinal);
  assert.equal(normalizedRawFinal.state, 'final');
  assert.equal(normalizedRawFinal.message, rawFinal);

  const modernEvents = chatEventToConversationEvents(modern, {
    sessionKey: 'agent:main:fallback',
  });
  assert.equal(modernEvents.length, 1);
  assert.equal(modernEvents[0].type, 'final.message');
  assert.equal(modernEvents[0].sessionKey, 'agent:main:modern-wrapper');
  assert.equal(modernEvents[0].runId, 'run-modern-wrapper');
  assert.equal(modernEvents[0].messageId, 'modern-final-message');
});

test('gateway mixed assistant preamble and tool call stays commentary instead of becoming a final answer', () => {
  const events = chatEventToConversationEvents({
    state: 'final',
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    message: {
      role: 'assistant',
      id: 'media-preamble-with-tool-call',
      timestamp: 1_700_000_000,
      content: [{
        type: 'text',
        text: 'I will generate a natural summer lifestyle scene.',
      }, {
        type: 'toolCall',
        id: 'media-preamble-tool-call',
        name: 'image_generate',
        arguments: { prompt: 'Generate the image.' },
      }],
    },
  }, { sessionKey: SESSION_KEY, activeRunId: RUN_ID });

  assert.equal(events[0]?.type, 'assistant.content');
  assert.deepEqual(events[0]?.data, {
    text: 'I will generate a natural summer lifestyle scene.',
    replace: true,
    phase: 'final',
  });
});

test('Gateway agent thinking preview normalizes into canonical reasoning evidence', () => {
  const events = normalizeGatewayChatRuntimeEvents({
    stream: 'thinking',
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    seq: 4,
    ts: 1_700_000_000_004,
    data: {
      delta: 'Inspect the current state.',
    },
  });

  assert.deepEqual(events, [{
    contractVersion: 1,
    producer: 'gateway',
    type: 'thinking.delta',
    runId: RUN_ID,
    rootRunId: undefined,
    sessionKey: SESSION_KEY,
    taskId: undefined,
    parentTaskId: undefined,
    taskStatus: undefined,
    seq: 4,
    ts: 1_700_000_000_004,
    text: undefined,
    delta: 'Inspect the current state.',
  }]);
});

test('idempotency key owns turn identity across local and history message ids', () => {
  const idempotencyKey = 'request-idempotency-key';
  const localTurnId = createTurnId({
    sessionKey: SESSION_KEY,
    messageId: 'local-message-id',
    idempotencyKey,
  });
  const historyEvents = historyMessagesToConversationEvents(SESSION_KEY, [{
    role: 'user',
    id: 'persisted-message-id',
    idempotencyKey,
    timestamp: 1_000,
    content: 'Keep one turn after history reload.',
  }]);
  const historyTurn = historyEvents.find((event) => event.type === 'turn.requested');

  assert.ok(historyTurn);
  assert.equal(historyTurn.turnId, localTurnId);
});

test('history without an idempotency key aligns to the unique local turn by content and time', () => {
  const sessionKey = 'agent:main:history-align-local';
  const localTurnId = createTurnId({ sessionKey, idempotencyKey: 'local-request-id' });
  const requested: ConversationEvent = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'history-align:requested',
    type: 'turn.requested',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    turnId: localTurnId,
    messageId: 'local-message-id',
    occurredAt: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    replayed: false,
    data: {
      message: {
        role: 'user',
        id: 'local-message-id',
        idempotencyKey: 'local-request-id',
        timestamp: 1_700_000_000,
        content: 'Keep this request in one Turn.',
      },
    },
  };
  let state = reduceConversationEvents(createEmptyConversationState(), [requested]);
  const history = historyMessagesToConversationEvents(sessionKey, [{
    role: 'user',
    id: 'persisted-message-id',
    timestamp: 1_700_000_001,
    content: 'Keep this request in one Turn.',
  }, {
    role: 'assistant',
    id: 'persisted-answer-id',
    timestamp: 1_700_000_002,
    content: 'One durable answer.',
  }]);

  state = replaceSessionTurns(state, sessionKey, history);

  assert.deepEqual(state.turnOrderBySession[sessionKey], [localTurnId]);
  assert.equal(state.turnsById[localTurnId].trigger.message.id, 'persisted-message-id');
  assert.equal(state.turnsById[localTurnId].items.filter((item) => item.kind === 'final-answer').length, 1);
  assert.equal(state.aliases.byMessageId[createSessionAliasKey(sessionKey, 'local-message-id')], localTurnId);
  assert.equal(state.aliases.byMessageId[createSessionAliasKey(sessionKey, 'persisted-message-id')], localTurnId);
  assert.equal(
    state.ingressDiagnosticsBySession[sessionKey].assignments.some((entry) => (
      entry.turnId === localTurnId
      && entry.basis === 'history-content-time'
      && entry.confidence === 'medium'
    )),
    true,
  );
});

test('history without ids or timestamps replays deterministically and keeps repeated prompts distinct', () => {
  const sessionKey = 'agent:main:history-stable-location';
  const messages: RawMessage[] = [{
    role: 'user',
    content: 'Repeat this request.',
  }, {
    role: 'assistant',
    content: 'First answer.',
  }, {
    role: 'user',
    content: 'Repeat this request.',
  }, {
    role: 'assistant',
    content: 'Second answer.',
  }];
  const originalNow = Date.now;
  let first: ConversationEvent[];
  let second: ConversationEvent[];
  try {
    Date.now = () => 1_000;
    first = historyMessagesToConversationEvents(sessionKey, messages);
    Date.now = () => 9_000;
    second = historyMessagesToConversationEvents(sessionKey, messages);
  } finally {
    Date.now = originalNow;
  }

  assert.deepEqual(second, first);
  const state = reduceConversationEvents(createEmptyConversationState(), first);
  assert.equal(state.turnOrderBySession[sessionKey].length, 2);
  assert.notEqual(state.turnOrderBySession[sessionKey][0], state.turnOrderBySession[sessionKey][1]);
  assert.deepEqual(
    state.turnOrderBySession[sessionKey].map((turnId) => (
      state.turnsById[turnId].items.find((item) => item.kind === 'final-answer')?.kind
    )),
    ['final-answer', 'final-answer'],
  );
});

test('history store replay preserves transcript order when persisted times tie or are missing', () => {
  const sessionKey = 'agent:main:history-stable-store-order';
  const messages: RawMessage[] = [{
    role: 'user',
    id: 'history-order-user-1',
    timestamp: 1_000,
    content: 'First request.',
  }, {
    role: 'assistant',
    id: 'history-order-answer-1',
    content: 'First answer.',
  }, {
    role: 'user',
    id: 'history-order-user-2',
    timestamp: 1_000,
    content: 'Second request.',
  }, {
    role: 'assistant',
    id: 'history-order-answer-2',
    timestamp: 1_000,
    content: 'Second answer.',
  }];
  const store = useConversationStore.getState();
  store.reset();
  try {
    store.replaceHistory(sessionKey, messages);
    const state = useConversationStore.getState();
    const turns = state.turnOrderBySession[sessionKey].map((turnId) => state.turnsById[turnId]);

    assert.deepEqual(turns.map((turn) => turn.trigger.message.content), [
      'First request.',
      'Second request.',
    ]);
    assert.deepEqual(turns.map((turn) => (
      turn.items.find((item) => item.kind === 'final-answer')?.message.content
    )), [
      'First answer.',
      'Second answer.',
    ]);
  } finally {
    useConversationStore.getState().reset();
  }
});

test('deferred local send stays queued without owning the run slot and activates the same Turn', () => {
  const sessionKey = 'agent:main:deferred-local-send';
  const message = {
    role: 'user' as const,
    id: 'deferred-local-user',
    idempotencyKey: 'deferred-local-intent',
    timestamp: 1_700_000_100,
    content: 'Run this after the current same-session work.',
  };
  const store = useConversationStore.getState();
  store.reset();
  try {
    const queuedTurnId = store.beginLocalTurn({
      sessionKey,
      message,
      mode: 'video',
      activate: false,
    });
    let state = useConversationStore.getState();
    assert.equal(state.turnsById[queuedTurnId].status, 'queued');
    assert.equal(state.aliases.pendingLocalBySession[sessionKey], undefined);
    assert.equal(state.aliases.activeBySession[sessionKey], undefined);

    const activatedTurnId = state.beginLocalTurn({
      sessionKey,
      message,
      mode: 'video',
      activate: true,
    });
    state = useConversationStore.getState();
    assert.equal(activatedTurnId, queuedTurnId);
    assert.deepEqual(state.turnOrderBySession[sessionKey], [queuedTurnId]);
    assert.equal(state.aliases.pendingLocalBySession[sessionKey], queuedTurnId);
    assert.equal(state.aliases.activeBySession[sessionKey], queuedTurnId);
    assert.equal(state.turnsById[queuedTurnId].status, 'queued');
    assert.equal(state.turnsById[queuedTurnId].items.filter((item) => item.kind === 'user-message').length, 1);
  } finally {
    useConversationStore.getState().reset();
  }
});

test('session idle from the preceding run cannot settle a deferred local Turn', () => {
  const sessionKey = 'agent:main:deferred-local-idle-isolation';
  const queuedMessage = {
    role: 'user' as const,
    id: 'deferred-idle-user',
    idempotencyKey: 'deferred-idle-intent',
    timestamp: 1_700_000_200,
    content: 'Run only after the preceding work releases the session.',
  };
  const store = useConversationStore.getState();
  store.reset();
  try {
    const queuedTurnId = store.beginLocalTurn({
      sessionKey,
      message: queuedMessage,
      mode: 'chat',
      activate: false,
    });

    store.markSessionActivity(sessionKey, false);
    let state = useConversationStore.getState();
    assert.equal(state.turnsById[queuedTurnId].status, 'queued');
    assert.equal(state.turnsById[queuedTurnId].evidence.backendIdle, false);

    store.beginLocalTurn({
      sessionKey,
      message: queuedMessage,
      mode: 'chat',
      activate: true,
    });
    store.bindRun(queuedTurnId, sessionKey, 'run:deferred-idle-owner');
    store.markSessionActivity(sessionKey, false, 'run:deferred-idle-owner');
    state = useConversationStore.getState();
    assert.equal(state.turnsById[queuedTurnId].status, 'completed');
    assert.equal(state.turnsById[queuedTurnId].evidence.backendIdle, true);
  } finally {
    useConversationStore.getState().reset();
  }
});

test('chat events from another session cannot inherit the selected session active run', () => {
  const otherSessionKey = 'agent:main:other-session';
  const context = createChatEventContext({
    sessionKey: otherSessionKey,
    currentSessionKey: SESSION_KEY,
    activeRunId: RUN_ID,
  });
  const events = chatEventToConversationEvents({
    state: 'final',
    sessionKey: otherSessionKey,
    message: {
      role: 'assistant',
      id: 'other-session-final',
      timestamp: 1_001,
      content: 'Background session answer.',
    } satisfies RawMessage,
  }, context);

  assert.equal(context.activeRunId, undefined);
  assert.equal(events[0].sessionKey, otherSessionKey);
  assert.equal(events[0].runId, undefined);
});

test('an explicit chat run cannot inherit a different stale active root run', () => {
  const sessionKey = `${SESSION_KEY}:explicit-run-owner`;
  const staleRunId = `${RUN_ID}:stale-active`;
  const incomingRunId = `${RUN_ID}:incoming`;
  let state = reduceConversationEvents(createEmptyConversationState(), runtime([{
    type: 'run.started',
    runId: staleRunId,
    sessionKey,
    seq: 1,
    ts: 1_000,
    producer: 'openclaw',
  }]));
  const staleTurnId = state.turnOrderBySession[sessionKey][0];
  const context = createChatEventContext({
    sessionKey,
    currentSessionKey: sessionKey,
    activeRunId: staleRunId,
  });
  const events = chatEventToConversationEvents({
    state: 'final',
    sessionKey,
    runId: incomingRunId,
    message: {
      role: 'assistant',
      id: 'incoming-final',
      timestamp: 1_001,
      content: 'This final belongs to another run.',
    } satisfies RawMessage,
  }, context);

  assert.equal(events[0].rootRunId, incomingRunId);
  state = reduceConversationEvents(state, events);
  assert.equal(
    state.turnsById[staleTurnId].items.some((item) => item.kind === 'final-answer'),
    false,
  );
  assert.equal(state.quarantineBySession[sessionKey]?.records.at(-1)?.runId, incomingRunId);
});

test('turn aliases and explicit turn ids stay isolated by session', () => {
  const sessionA = 'agent:main:alias-a';
  const sessionB = 'agent:main:alias-b';
  const sharedRunId = 'reused-run-id';
  let state = reduceConversationEvents(createEmptyConversationState(), runtime([
    { type: 'run.started', runId: sharedRunId, sessionKey: sessionA, seq: 1, ts: 1_000 },
    { type: 'run.started', runId: sharedRunId, sessionKey: sessionB, seq: 1, ts: 1_001 },
    { type: 'tool.started', runId: sharedRunId, sessionKey: sessionA, seq: 3, ts: 1_002, toolCallId: 'tool-a', name: 'read' },
    { type: 'tool.started', runId: sharedRunId, sessionKey: sessionB, seq: 3, ts: 1_003, toolCallId: 'tool-b', name: 'read' },
  ]));

  const sessionATurnId = state.turnOrderBySession[sessionA][0];
  const sessionBTurnId = state.turnOrderBySession[sessionB][0];
  assert.notEqual(sessionATurnId, sessionBTurnId);
  assert.equal(state.turnsById[sessionATurnId].sessionKey, sessionA);
  assert.equal(state.turnsById[sessionBTurnId].sessionKey, sessionB);
  assert.deepEqual(Object.keys(state.turnsById[sessionATurnId].toolItemByCallId), ['tool-a']);
  assert.deepEqual(Object.keys(state.turnsById[sessionBTurnId].toolItemByCallId), ['tool-b']);

  const explicitTurnId = 'turn:explicit-shared';
  const explicitA = runtimeEventToConversationEvent({
    type: 'run.started',
    runId: 'explicit-run-a',
    sessionKey: sessionA,
    seq: 10,
    ts: 1_010,
  });
  const explicitB = runtimeEventToConversationEvent({
    type: 'run.started',
    runId: 'explicit-run-b',
    sessionKey: sessionB,
    seq: 11,
    ts: 1_011,
  });
  assert.ok(explicitA && explicitB);
  state = reduceConversationEvents(state, [
    { ...explicitA, turnId: explicitTurnId },
    { ...explicitB, turnId: explicitTurnId },
  ]);

  assert.equal(state.turnsById[explicitTurnId].sessionKey, sessionA);
  assert.notEqual(state.turnOrderBySession[sessionB].at(-1), explicitTurnId);
  assert.equal(state.turnsById[state.turnOrderBySession[sessionB].at(-1)!].sessionKey, sessionB);
});

test('only a local pending turn may claim the first unknown run while unrelated run evidence is isolated', () => {
  const sessionKey = 'agent:main:pending-owner';
  const turnId = createTurnId({ sessionKey, idempotencyKey: 'pending-owner-request' });
  const requested: ConversationEvent = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'pending-owner:requested',
    type: 'turn.requested',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    turnId,
    messageId: 'pending-owner-message',
    occurredAt: 1_100,
    receivedAt: 1_100,
    replayed: false,
    data: {
      message: {
        role: 'user',
        id: 'pending-owner-message',
        idempotencyKey: 'pending-owner-request',
        content: 'Bind only my run.',
      },
    },
  };
  const ownerStart = runtimeEventToConversationEvent({
    type: 'run.started',
    runId: 'pending-owner-run',
    sessionKey,
    ts: 1_101,
  });
  assert.ok(ownerStart);

  let state = reduceConversationEvents(createEmptyConversationState(), [requested, ownerStart]);
  assert.deepEqual(state.turnOrderBySession[sessionKey], [turnId]);
  assert.equal(
    state.aliases.byRunId[createSessionAliasKey(sessionKey, 'pending-owner-run')],
    turnId,
  );
  assert.equal(state.aliases.pendingLocalBySession[sessionKey], undefined);

  const unrelatedTool = runtimeEventToConversationEvent({
    type: 'tool.started',
    runId: 'unrelated-unknown-run',
    sessionKey,
    ts: 1_102,
    toolCallId: 'unrelated-unknown-tool',
    name: 'exec',
    args: { command: 'private command must not enter diagnostics' },
  });
  assert.ok(unrelatedTool);
  state = reduceConversationEvents(state, [unrelatedTool]);
  assert.deepEqual(state.turnOrderBySession[sessionKey], [turnId]);
  assert.equal(state.turnsById[turnId].toolItemByCallId['unrelated-unknown-tool'], undefined);
  assert.equal(state.quarantineBySession[sessionKey].records[0].runId, 'unrelated-unknown-run');
  assert.equal(JSON.stringify(state.quarantineBySession[sessionKey]).includes('private command'), false);

  const unrelatedStart = runtimeEventToConversationEvent({
    type: 'run.started',
    runId: 'unrelated-unknown-run',
    sessionKey,
    ts: 1_103,
  });
  assert.ok(unrelatedStart);
  state = reduceConversationEvents(state, [unrelatedStart]);
  assert.equal(state.turnOrderBySession[sessionKey].length, 2);
  const isolatedTurnId = state.aliases.byRunId[createSessionAliasKey(sessionKey, 'unrelated-unknown-run')];
  assert.ok(isolatedTurnId);
  assert.notEqual(isolatedTurnId, turnId);
});

test('native approval fallback is limited to the active turn in the same session', () => {
  const ownerSession = 'agent:main:native-approval-owner';
  const otherSession = 'agent:main:native-approval-other';
  const ownerRunId = 'native-approval-owner-run';
  const ownerStart = runtimeEventToConversationEvent({
    type: 'run.started',
    runId: ownerRunId,
    sessionKey: ownerSession,
    seq: 1,
    ts: 1_200,
  });
  const ownerApproval = runtimeEventToConversationEvent({
    type: 'approval.updated',
    producer: 'openclaw',
    runId: 'approval:exec:same-session',
    sessionKey: ownerSession,
    itemId: 'same-session',
    status: 'pending',
  });
  const otherApproval = runtimeEventToConversationEvent({
    type: 'approval.updated',
    producer: 'openclaw',
    runId: 'approval:exec:other-session',
    sessionKey: otherSession,
    itemId: 'other-session',
    status: 'pending',
  });
  assert.ok(ownerStart && ownerApproval && otherApproval);

  let state = reduceConversationEvents(createEmptyConversationState(), [ownerStart, ownerApproval]);
  const ownerTurnId = state.turnOrderBySession[ownerSession][0];
  assert.equal(state.turnOrderBySession[ownerSession].length, 1);
  assert.equal(state.turnsById[ownerTurnId].items.filter((item) => item.kind === 'approval').length, 1);

  state = reduceConversationEvents(state, [otherApproval]);
  assert.equal(state.turnOrderBySession[otherSession], undefined);
  assert.equal(state.quarantineBySession[otherSession].records.length, 1);
  assert.equal(state.turnsById[ownerTurnId].items.filter((item) => item.kind === 'approval').length, 1);
});

test('no-sequence dedupe eviction is bounded independently per session and turn', () => {
  const sessionA = 'agent:main:dedupe-a';
  const sessionB = 'agent:main:dedupe-b';
  const turnA = 'turn:dedupe-a';
  const turnB = 'turn:dedupe-b';
  const turnC = 'turn:dedupe-c';
  const event = (sessionKey: string, turnId: string, eventId: string, index: number): ConversationEvent => ({
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId,
    type: 'assistant.content',
    source: 'openclaw-runtime',
    authority: 'corroborating',
    sessionKey,
    turnId,
    occurredAt: 2_000 + index,
    receivedAt: 2_000 + index,
    replayed: false,
    data: { text: `update-${index}`, replace: true },
  });
  const original = event(sessionA, turnA, 'dedupe:original', 0);
  const crossSessionFlood = Array.from({ length: NO_SEQUENCE_DEDUPE_LIMIT + 1 }, (_, index) => (
    event(sessionB, turnB, `dedupe:session-b:${index}`, index + 1)
  ));
  const sameSessionFlood = Array.from({ length: NO_SEQUENCE_DEDUPE_LIMIT + 1 }, (_, index) => (
    event(sessionA, turnC, `dedupe:turn-c:${index}`, index + NO_SEQUENCE_DEDUPE_LIMIT + 2)
  ));
  const state = reduceConversationEvents(
    createEmptyConversationState(),
    [original, ...crossSessionFlood, ...sameSessionFlood],
  );
  assertConversationState(state);
  assert.ok(Object.values(state.noSequenceDedupeByScope).every(
    (bucket) => bucket.eventOrder.length <= NO_SEQUENCE_DEDUPE_LIMIT,
  ));
  assert.equal(
    state.noSequenceDedupeByScope[createSessionAliasKey(sessionA, `turn:${turnA}`)]
      .eventIds[original.eventId],
    true,
  );
  const originalTurn = state.turnsById[turnA];
  const duplicateState = reduceConversationEvents(state, [original]);
  assert.notEqual(duplicateState, state);
  assert.equal(duplicateState.turnsById[turnA], originalTurn);
  assert.equal(duplicateState.ingressDiagnosticsBySession[sessionA].duplicateCount, 1);
  assert.ok(duplicateState.ingressDiagnosticsBySession[sessionA].assignments.length <= 128);
});

test('unknown-run quarantine keeps only a bounded sanitized diagnostic tail', () => {
  const sessionKey = 'agent:main:bounded-quarantine';
  const owner = runtimeEventToConversationEvent({
    type: 'run.started',
    runId: 'bounded-quarantine-owner',
    sessionKey,
    ts: 2_999,
  });
  assert.ok(owner);
  const events = runtime(Array.from({ length: QUARANTINE_EVENT_LIMIT + 16 }, (_, index) => ({
    type: 'tool.started' as const,
    runId: `unknown-quarantine-run-${index}`,
    sessionKey,
    ts: 3_000 + index,
    toolCallId: `unknown-quarantine-tool-${index}`,
    name: 'exec',
    args: { command: `secret-command-${index}` },
  })));
  const state = reduceConversationEvents(createEmptyConversationState(), [owner, ...events]);
  assertConversationState(state);
  assert.equal(state.turnOrderBySession[sessionKey].length, 1);
  assert.equal(state.quarantineBySession[sessionKey].records.length, QUARANTINE_EVENT_LIMIT);
  assert.equal(state.quarantineBySession[sessionKey].droppedCount, 16);
  assert.equal(JSON.stringify(state.quarantineBySession[sessionKey]).includes('secret-command'), false);
  assert.equal(state.ingressDiagnosticsBySession[sessionKey].quarantineCount, QUARANTINE_EVENT_LIMIT + 16);
  assert.ok(state.ingressDiagnosticsBySession[sessionKey].assignments.length <= 128);
  assert.equal(JSON.stringify(state.ingressDiagnosticsBySession[sessionKey]).includes('secret-command'), false);
});

test('removing a canonical session clears every scoped index without disturbing another session', () => {
  const removedSession = 'agent:main:remove-canonical-session';
  const retainedSession = 'agent:main:retain-canonical-session';
  const ownerRunId = 'remove-canonical-owner';
  let state = reduceConversationEvents(
    createEmptyConversationState(),
    [
      ...historyMessagesToConversationEvents(removedSession, completedHistory(removedSession)),
      ...historyMessagesToConversationEvents(retainedSession, completedHistory(retainedSession)),
      ...runtime([{
        type: 'run.started',
        runId: ownerRunId,
        sessionKey: removedSession,
        ts: 4_000,
      }, {
        type: 'tool.started',
        runId: ownerRunId,
        sessionKey: removedSession,
        ts: 4_001,
        taskId: 'remove-canonical-task',
        toolCallId: 'remove-canonical-tool',
        name: 'read',
      }]),
    ],
  );
  const unknownTool = runtimeEventToConversationEvent({
    type: 'tool.started',
    runId: 'remove-canonical-unknown-run',
    sessionKey: removedSession,
    ts: 4_002,
    toolCallId: 'remove-canonical-unknown-tool',
    name: 'exec',
  });
  assert.ok(unknownTool);
  state = reduceConversationEvents(state, [unknownTool]);
  const removedTurnIds = new Set(state.turnOrderBySession[removedSession]);
  const retainedTurnId = state.turnOrderBySession[retainedSession][0];
  assert.ok(state.quarantineBySession[removedSession]);
  assert.ok(Object.keys(state.noSequenceDedupeByScope).some((key) => (
    sessionAliasKeyBelongsTo(key, removedSession)
  )));

  const next = removeConversationSession(state, removedSession);

  assertConversationState(next);
  assert.equal(next.turnOrderBySession[removedSession], undefined);
  assert.equal(next.quarantineBySession[removedSession], undefined);
  assert.equal(next.ingressDiagnosticsBySession[removedSession], undefined);
  assert.ok(Object.keys(next.noSequenceDedupeByScope).every((key) => (
    !sessionAliasKeyBelongsTo(key, removedSession)
  )));
  removedTurnIds.forEach((turnId) => {
    assert.equal(next.turnsById[turnId], undefined);
    assert.equal(next.eventsByTurnId[turnId], undefined);
    assert.equal(next.eventRetentionByTurnId[turnId], undefined);
  });
  Object.values(next.aliases).forEach((aliases) => {
    Object.entries(aliases).forEach(([key, turnId]) => {
      assert.equal(key === removedSession || sessionAliasKeyBelongsTo(key, removedSession), false);
      assert.equal(removedTurnIds.has(turnId), false);
    });
  });
  assert.equal(next.turnsById[retainedTurnId], state.turnsById[retainedTurnId]);
  assert.deepEqual(next.turnOrderBySession[retainedSession], [retainedTurnId]);
});

test('same no-sequence runtime delta at different source times stays distinct', () => {
  const first = runtimeEventToConversationEvent({
    type: 'assistant.delta',
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    ts: 2_000,
    delta: 'Repeated chunk',
  });
  const secondInput: ChatRuntimeEvent = {
    type: 'assistant.delta',
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    ts: 2_001,
    delta: 'Repeated chunk',
  };
  const second = runtimeEventToConversationEvent(secondInput);
  const retransmittedSecond = runtimeEventToConversationEvent({ ...secondInput });

  assert.ok(first && second && retransmittedSecond);
  assert.notEqual(first.eventId, second.eventId);
  assert.equal(second.eventId, retransmittedSecond.eventId);

  const state = reduceConversationEvents(createEmptyConversationState(), [first, second, retransmittedSecond]);
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  const commentary = turn.items.find((item) => item.kind === 'commentary');
  assert.ok(commentary && commentary.kind === 'commentary');
  assert.equal(commentary.text, 'Repeated chunkRepeated chunk');
});

test('late lower sequence replacement cannot overwrite the accepted stream watermark', () => {
  const events = runtime([
    {
      type: 'assistant.delta',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 2,
      ts: 2_002,
      producer: 'openclaw',
      text: 'Newest replacement',
      replace: true,
    },
    {
      type: 'assistant.delta',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 1,
      ts: 2_001,
      producer: 'openclaw',
      text: 'Stale replacement',
      replace: true,
    },
  ]);
  const state = reduceConversationEvents(createEmptyConversationState(), events);
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  const commentary = turn.items.find((item) => item.kind === 'commentary');

  assert.ok(commentary && commentary.kind === 'commentary');
  assert.equal(commentary.text, 'Newest replacement');
});

test('same message id keeps distinct chat deltas while exact retransmissions stay idempotent', () => {
  const context = {
    sessionKey: SESSION_KEY,
    activeRunId: RUN_ID,
    turnId: 'turn:chat-delta-identity',
  };
  const first = chatEventToConversationEvents({
    state: 'delta',
    sessionKey: SESSION_KEY,
    runId: RUN_ID,
    message: {
      role: 'assistant',
      id: 'stream-message',
      timestamp: 2_000,
      content: 'First chunk',
    } satisfies RawMessage,
  }, context)[0];
  const second = chatEventToConversationEvents({
    state: 'delta',
    sessionKey: SESSION_KEY,
    runId: RUN_ID,
    message: {
      role: 'assistant',
      id: 'stream-message',
      timestamp: 2_001,
      content: 'First chunk plus second chunk',
    } satisfies RawMessage,
  }, context)[0];
  const retransmittedSecond = chatEventToConversationEvents({
    state: 'delta',
    sessionKey: SESSION_KEY,
    runId: RUN_ID,
    message: {
      role: 'assistant',
      id: 'stream-message',
      timestamp: 2_001,
      content: 'First chunk plus second chunk',
    } satisfies RawMessage,
  }, context)[0];

  assert.notEqual(first.eventId, second.eventId);
  assert.equal(second.eventId, retransmittedSecond.eventId);
  const state = reduceConversationEvents(
    createEmptyConversationState(),
    [first, second, retransmittedSecond],
  );
  const turn = state.turnsById[context.turnId];
  const commentary = turn.items.find((item) => item.kind === 'commentary');
  assert.ok(commentary && commentary.kind === 'commentary');
  assert.equal(commentary.text, 'First chunk plus second chunk');
  assert.deepEqual(commentary.sourceEventIds, [first.eventId, second.eventId]);
});

test('no-sequence runtime stages sharing one tool call remain distinct and replay idempotently', () => {
  const toolCallId = 'shared-no-seq-tool-call';
  const stages: ChatRuntimeEvent[] = [
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      producer: 'openclaw',
      toolCallId,
      itemId: 'approval-shared-tool',
      status: 'pending',
      message: 'Approve command execution.',
    },
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      producer: 'openclaw',
      toolCallId,
      itemId: 'approval-shared-tool',
      status: 'approved',
      message: 'Command execution approved.',
    },
    {
      type: 'command.output',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      producer: 'openclaw',
      toolCallId,
      phase: 'running',
      output: 'Building...',
    },
    {
      type: 'command.output',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      producer: 'openclaw',
      toolCallId,
      phase: 'end',
      status: 'completed',
      exitCode: 0,
      output: 'Build complete.',
    },
    {
      type: 'artifact.produced',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      producer: 'openclaw',
      toolCallId,
      artifact: {
        id: 'artifact-shared-tool',
        title: 'dist.zip',
        filePath: '/tmp/dist.zip',
      },
    },
    {
      type: 'verification.completed',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      producer: 'openclaw',
      toolCallId,
      verification: {
        id: 'verification-shared-tool',
        status: 'passed',
        kind: 'build',
        title: 'Build verification',
      },
    },
  ];
  const firstDelivery = runtime(stages);
  const retransmission = runtime(stages);
  assert.equal(firstDelivery.length, stages.length);
  assert.equal(new Set(firstDelivery.map((event) => event.eventId)).size, stages.length);
  assert.deepEqual(
    retransmission.map((event) => event.eventId),
    firstDelivery.map((event) => event.eventId),
  );

  const state = reduceConversationEvents(
    createEmptyConversationState(),
    [...firstDelivery, ...retransmission],
  );
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  assert.equal(state.eventsByTurnId[turn.id].length, stages.length);
  assert.equal(turn.items.filter((item) => item.kind === 'approval').length, 1);
  assert.equal(turn.items.filter((item) => item.kind === 'artifact-group').length, 1);
  assert.equal(turn.items.filter((item) => item.kind === 'verification-summary').length, 1);
  const toolGroup = turn.items.find((item) => item.kind === 'tool-group');
  assert.ok(toolGroup && toolGroup.kind === 'tool-group');
  assert.equal(toolGroup.entries.length, 1);
  assert.equal(toolGroup.entries[0].status, 'completed');
});

test('chat-only aborted delivery projects an authoritative aborted run terminal', () => {
  const normalized = normalizeGatewayChatEnvelope({
    state: 'aborted',
    sessionKey: SESSION_KEY,
    runId: RUN_ID,
    errorMessage: 'Stopped by user.',
  });
  assert.ok(normalized);
  const events = chatEventToConversationEvents(normalized, {
    sessionKey: SESSION_KEY,
    activeRunId: RUN_ID,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'run.ended');
  assert.equal(events[0].authority, 'authoritative');
  assert.deepEqual(events[0].data, {
    status: 'aborted',
    endedAt: events[0].occurredAt,
    error: 'Stopped by user.',
  });

  const state = reduceConversationEvents(createEmptyConversationState(), events);
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  assert.equal(turn.status, 'aborted');
});

test('history tool request preamble without a later assistant answer is not promoted to final', () => {
  const messages: RawMessage[] = [
    {
      role: 'user',
      id: 'user-tool-preamble',
      timestamp: 3_000,
      content: 'Inspect the file.',
    },
    {
      role: 'assistant',
      id: 'assistant-tool-preamble',
      timestamp: 3_001,
      content: [
        { type: 'text', text: 'I will inspect the file first.' },
        { type: 'tool_use', id: 'tool-preamble-read', name: 'read_file', input: { path: 'a.ts' } },
      ],
    },
    {
      role: 'toolresult',
      id: 'tool-preamble-result',
      timestamp: 3_002,
      toolCallId: 'tool-preamble-read',
      toolName: 'read_file',
      content: 'file contents',
    },
  ];
  const state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(SESSION_KEY, messages),
  );
  assertConversationState(state);
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  assert.equal(turn.items.filter((item) => item.kind === 'final-answer').length, 0);
  assert.equal(turn.items.filter((item) => item.kind === 'commentary').length, 1);
  assert.equal(turn.items.filter((item) => item.kind === 'tool-group').length, 1);
});

test('assistant-only history creates an orphan turn without a visible synthetic user item', () => {
  const message: RawMessage = {
    role: 'assistant',
    id: 'assistant-orphan-final',
    timestamp: 3_100,
    content: 'The persisted terminal reply remains visible after restart.',
  };
  const events = historyMessagesToConversationEvents(SESSION_KEY, [message]);
  assert.equal(events.some((event) => event.type === 'turn.requested'), false);

  const state = reduceConversationEvents(createEmptyConversationState(), events);
  assertConversationState(state);
  const turnIds = state.turnOrderBySession[SESSION_KEY];
  assert.equal(turnIds.length, 1);
  const turn = state.turnsById[turnIds[0]];
  assert.equal(turn.trigger.message.content, '');
  assert.equal(turn.items.some((item) => item.kind === 'user-message'), false);
  assert.equal(turn.status, 'completed');
  const final = turn.items.find((item) => item.kind === 'final-answer');
  assert.ok(final && final.kind === 'final-answer');
  assert.equal(final.message.content, message.content);
});

test('assistant-only media history preserves canonical preview availability evidence', () => {
  const history: RawMessage[] = [{
    role: 'assistant',
    id: 'assistant-orphan-media',
    timestamp: 3_200,
    content: '',
    _attachedFiles: [{
      fileName: 'generated.png',
      mimeType: 'image/png',
      fileSize: 0,
      preview: null,
      previewStatus: 'unavailable',
      gatewayUrl: '/api/chat/media/outgoing/generated.png',
      source: 'gateway-media',
      disposition: 'output-delivery',
    }, {
      fileName: 'japan-kansai-4d3n-plan.svg',
      mimeType: 'image/svg+xml',
      fileSize: 73,
      preview: 'data:image/svg+xml;base64,PHN2Zy8+',
      filePath: String.raw`C:\Users\Administrator\.openclaw\workspace\japan-kansai-4d3n-plan.svg`,
      source: 'message-ref',
      disposition: 'output-delivery',
    }],
  }];
  const state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(SESSION_KEY, history),
  );
  assertConversationState(state);
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  assert.equal(turn.items.some((item) => item.kind === 'user-message'), false);
  const artifacts = turn.items.find((item) => item.kind === 'artifact-group');
  assert.ok(artifacts && artifacts.kind === 'artifact-group');
  assert.equal(artifacts.artifacts.length, 2);
  assert.equal(artifacts.artifacts[0].previewStatus, 'unavailable');
  assert.equal(artifacts.artifacts[0].availability, 'available');
  assert.equal(artifacts.artifacts[0].url, '/api/chat/media/outgoing/generated.png');
  assert.equal(artifacts.artifacts[1].preview, 'data:image/svg+xml;base64,PHN2Zy8+');
  assert.equal(
    artifacts.artifacts[1].filePath,
    String.raw`C:\Users\Administrator\.openclaw\workspace\japan-kansai-4d3n-plan.svg`,
  );
});

test('path-like assistant prose and tool stdout never become canonical artifacts', () => {
  const messages: RawMessage[] = [{
    role: 'user',
    id: 'path-prose-user',
    timestamp: 3_300,
    content: 'Tell me where the report was written.',
  }, {
    role: 'assistant',
    id: 'path-prose-tool-call',
    timestamp: 3_301,
    content: [{
      type: 'tool_use',
      id: 'path-prose-tool',
      name: 'exec',
      input: { command: 'printf /tmp/tool-stdout.zip' },
    }],
  }, {
    role: 'toolresult',
    id: 'path-prose-tool-result',
    timestamp: 3_302,
    toolCallId: 'path-prose-tool',
    toolName: 'exec',
    content: '/tmp/tool-stdout.zip',
    _attachedFiles: [{
      fileName: 'tool-stdout.zip',
      mimeType: 'application/zip',
      fileSize: 0,
      preview: null,
      filePath: '/tmp/tool-stdout.zip',
      source: 'tool-result',
      disposition: 'output-delivery',
    }],
  }, {
    role: 'assistant',
    id: 'path-prose-final',
    timestamp: 3_303,
    content: 'The report path is /tmp/report.pdf.',
    _attachedFiles: [{
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      fileSize: 0,
      preview: null,
      filePath: '/tmp/report.pdf',
      source: 'message-ref',
      disposition: 'output-delivery',
    }],
  }];
  const state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(SESSION_KEY, messages),
  );
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  assert.equal(turn.items.some((item) => item.kind === 'artifact-group'), false);
  assert.deepEqual(buildRuntimeArtifactEventsFromAttachedFiles({
    runId: 'path-prose-runtime',
    sessionKey: SESSION_KEY,
  }, [
    messages[2]._attachedFiles![0],
    messages[3]._attachedFiles![0],
  ]), []);
});

test('structured Gateway media and Host Task artifacts remain canonical', () => {
  const idempotencyKey = 'structured-artifact-positive';
  const history = historyMessagesToConversationEvents(SESSION_KEY, [{
    role: 'user',
    id: 'structured-artifact-user',
    idempotencyKey,
    timestamp: 3_400,
    content: 'Create the deliverables.',
  }, {
    role: 'assistant',
    id: 'structured-gateway-media',
    timestamp: 3_401,
    content: 'The generated image is ready.',
    _attachedFiles: [{
      fileName: 'gateway-image.png',
      mimeType: 'image/png',
      fileSize: 0,
      preview: null,
      previewStatus: 'unavailable',
      gatewayUrl: '/api/chat/media/outgoing/gateway-image.png',
      source: 'gateway-media',
      disposition: 'output-delivery',
    }],
  }]);
  const host = hostTasksToConversationEvents([{
    schema: 'uclaw.host-task/v1',
    taskId: 'structured-host-task',
    kind: 'local.document.render',
    title: 'Render the Host document',
    status: 'succeeded',
    revision: 1,
    createdAt: 3_400_000,
    updatedAt: 3_401_000,
    correlation: {
      sessionKey: SESSION_KEY,
      runId: 'structured-host-run',
      toolCallId: 'structured-host-tool',
      idempotencyKey,
    },
    progress: [],
    artifacts: [{
      id: 'structured-host-artifact',
      kind: 'document',
      title: 'Host report',
      filePath: '/tmp/host-report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
    }],
    verifications: [{
      id: 'structured-host-verification',
      status: 'passed',
      kind: 'artifact.integrity',
      required: true,
      artifactId: 'structured-host-artifact',
    }],
    lifecycle: {
      operations: [{
        kind: 'render',
        status: 'completed',
        attempt: 1,
        startedAt: 3_400_000,
        finishedAt: 3_401_000,
      }],
    },
  }]);
  const state = reduceConversationEvents(createEmptyConversationState(), [...history, ...host]);
  assertConversationState(state);
  const turnIds = state.turnOrderBySession[SESSION_KEY];
  assert.equal(turnIds.length, 1);
  const artifacts = state.turnsById[turnIds[0]].items.flatMap((item) => (
    item.kind === 'artifact-group' ? item.artifacts : []
  ));
  assert.equal(artifacts.some((artifact) => artifact.url?.includes('gateway-image.png')), true);
  assert.equal(artifacts.some((artifact) => artifact.id === 'structured-host-artifact'), true);
});

test('history replay creates one stable turn with commentary, grouped tools, and one final answer', () => {
  const messages: RawMessage[] = [
    { role: 'user', id: 'user-1', timestamp: 1_000, content: 'Inspect and fix the timeline.' },
    { role: 'assistant', id: 'assistant-commentary', timestamp: 1_001, content: [{ type: 'text', text: 'I am checking the event path.' }] },
    {
      role: 'assistant',
      id: 'assistant-tools',
      timestamp: 1_002,
      content: [
        { type: 'tool_use', id: 'tool-read-1', name: 'read_file', input: { path: 'a.ts' } },
        { type: 'tool_use', id: 'tool-read-2', name: 'read_file', input: { path: 'b.ts' } },
      ],
    },
    { role: 'toolresult', id: 'result-1', timestamp: 1_003, toolCallId: 'tool-read-1', toolName: 'read_file', content: 'a' },
    { role: 'toolresult', id: 'result-2', timestamp: 1_004, toolCallId: 'tool-read-2', toolName: 'read_file', content: 'b' },
    { role: 'assistant', id: 'assistant-final', timestamp: 1_005, content: [{ type: 'text', text: 'The timeline is fixed.' }] },
  ];
  const state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(SESSION_KEY, messages),
  );
  assertConversationState(state);
  assert.equal(state.turnOrderBySession[SESSION_KEY].length, 1);
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.items.filter((item) => item.kind === 'commentary').length, 1);
  assert.equal(turn.items.filter((item) => item.kind === 'final-answer').length, 1);
  const toolGroups = turn.items.filter((item) => item.kind === 'tool-group');
  assert.equal(toolGroups.length, 1);
  assert.deepEqual(toolGroups[0].toolCallIds, ['tool-read-1', 'tool-read-2']);
  assert.deepEqual(timelineKinds(messages), ['user-message', 'commentary', 'tool-group', 'final-answer']);
});

test('late commentary splits a compatible tool group at its canonical boundary', () => {
  const sessionKey = `${SESSION_KEY}:late-tool-boundary`;
  const turnId = 'turn:late-tool-boundary';
  const event = (
    eventId: string,
    type: ConversationEvent['type'],
    occurredAt: number,
    data: ConversationEvent['data'],
    extra: Partial<ConversationEvent> = {},
  ): ConversationEvent => ({
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId,
    type,
    source: type === 'turn.requested' ? 'host' : 'openclaw-runtime',
    authority: 'authoritative',
    sessionKey,
    turnId,
    runId: 'run:late-tool-boundary',
    occurredAt,
    receivedAt: occurredAt,
    replayed: false,
    data,
    ...extra,
  });
  const state = reduceConversationEvents(createEmptyConversationState(), [
    event('late-tool-boundary:user', 'turn.requested', 1_000, {
      message: { role: 'user', id: 'late-tool-boundary:user', content: 'Read two files.' },
    }),
    event('late-tool-boundary:first-start', 'tool.started', 1_010, {
      toolCallId: 'late-tool-boundary:first', name: 'read_file', args: { path: '/tmp/first' },
    }, { toolCallId: 'late-tool-boundary:first' }),
    event('late-tool-boundary:first-end', 'tool.completed', 1_020, {
      toolCallId: 'late-tool-boundary:first', name: 'read_file', result: 'first',
    }, { toolCallId: 'late-tool-boundary:first' }),
    event('late-tool-boundary:second-start', 'tool.started', 1_040, {
      toolCallId: 'late-tool-boundary:second', name: 'read_file', args: { path: '/tmp/second' },
    }, { toolCallId: 'late-tool-boundary:second' }),
    event('late-tool-boundary:second-end', 'tool.completed', 1_050, {
      toolCallId: 'late-tool-boundary:second', name: 'read_file', result: 'second',
    }, { toolCallId: 'late-tool-boundary:second' }),
    // Transport delivered this preamble after both tool facts.
    event('late-tool-boundary:commentary', 'assistant.content', 1_040, {
      text: 'Now I will read the second file.', replace: true,
    }, { messageId: 'late-tool-boundary:commentary' }),
  ]);

  assertConversationState(state);
  const turn = state.turnsById[turnId];
  assert.deepEqual(turn.items.map((item) => item.kind), [
    'user-message',
    'tool-group',
    'commentary',
    'tool-group',
  ]);
  assert.deepEqual(
    turn.items.filter((item) => item.kind === 'tool-group').map((group) => group.entries.map((entry) => entry.toolCallId)),
    [['late-tool-boundary:first'], ['late-tool-boundary:second']],
  );
});

test('history replay folds Tool Search target projections into their outer tool calls', () => {
  const firstParent = 'call_state|fc_history_state';
  const secondParent = 'call_action|fc_history_action';
  const firstChild = 'tool_search_code:call_state_fc_history_state:desktop_get_app_state:1';
  const secondChild = 'tool_search_code:call_action_fc_history_action:desktop_request_action:2';
  const messages: RawMessage[] = [
    { role: 'user', id: 'tool-search-history-user', timestamp: 2_000, content: 'Request approval.' },
    {
      role: 'assistant',
      id: 'tool-search-history-state-outer',
      timestamp: 2_001,
      content: [{ type: 'toolCall', id: firstParent, name: 'tool_call', arguments: { id: 'desktop_get_app_state', args: {} } }],
    },
    { role: 'toolresult', id: 'tool-search-history-state-outer-result', timestamp: 2_002, toolCallId: firstParent, toolName: 'tool_call', content: '{}' },
    {
      role: 'assistant',
      id: 'tool-search-history-state-child',
      timestamp: 2_003,
      content: [{ type: 'toolCall', id: firstChild, name: 'desktop_get_app_state', arguments: {} }],
    },
    { role: 'toolresult', id: 'tool-search-history-state-child-result', timestamp: 2_004, toolCallId: firstChild, toolName: 'desktop_get_app_state', content: '{}' },
    {
      role: 'assistant',
      id: 'tool-search-history-action-outer',
      timestamp: 2_005,
      content: [{ type: 'toolCall', id: secondParent, name: 'tool_call', arguments: { id: 'desktop_request_action', args: {} } }],
    },
    { role: 'toolresult', id: 'tool-search-history-action-outer-result', timestamp: 2_006, toolCallId: secondParent, toolName: 'tool_call', content: '{}' },
    {
      role: 'assistant',
      id: 'tool-search-history-action-child',
      timestamp: 2_007,
      content: [{ type: 'toolCall', id: secondChild, name: 'desktop_request_action', arguments: {} }],
    },
    { role: 'toolresult', id: 'tool-search-history-action-child-result', timestamp: 2_008, toolCallId: secondChild, toolName: 'desktop_request_action', content: '{}' },
    { role: 'assistant', id: 'tool-search-history-final', timestamp: 2_009, content: 'Waiting for approval.' },
  ];
  const state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(SESSION_KEY, messages),
  );
  assertConversationState(state);
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  const entries = turn.items.flatMap((item) => item.kind === 'tool-group' ? item.entries : []);
  assert.deepEqual(entries.map((entry) => entry.toolCallId), [firstParent, secondParent]);
  assert.deepEqual(entries.map((entry) => entry.name), ['desktop_get_app_state', 'desktop_request_action']);
});

test('live Tool Search targets dedupe and desktop approval resolves by child tool ownership', () => {
  const sessionKey = `${SESSION_KEY}:tool-search-approval-owner`;
  const runId = `${RUN_ID}:tool-search-approval-owner`;
  const wrongLegacyRunId = 'legacy-session-uuid-used-as-run';
  const stateParent = 'call_state|fc_live_state';
  const actionParent = 'call_action|fc_live_action';
  const stateChild = 'tool_search_code:call_state_fc_live_state:desktop_get_app_state:1';
  const actionChild = 'tool_search_code:call_action_fc_live_action:desktop_request_action:2';
  const state = reduceConversationEvents(createEmptyConversationState(), runtime([
    { type: 'run.started', runId, sessionKey, seq: 1, ts: 3_000, producer: 'openclaw' },
    { type: 'tool.started', runId, sessionKey, seq: 2, ts: 3_001, producer: 'openclaw', toolCallId: stateParent, name: 'tool_call', args: { id: 'desktop_get_app_state', args: {} } },
    { type: 'tool.started', runId, sessionKey, seq: 3, ts: 3_002, producer: 'openclaw', toolCallId: stateChild, name: 'desktop_get_app_state', args: {} },
    { type: 'tool.completed', runId, sessionKey, seq: 4, ts: 3_003, producer: 'openclaw', toolCallId: stateChild, name: 'desktop_get_app_state', result: {} },
    { type: 'tool.started', runId, sessionKey, seq: 5, ts: 3_004, producer: 'openclaw', toolCallId: actionParent, name: 'tool_call', args: { id: 'desktop_request_action', args: {} } },
    { type: 'tool.started', runId, sessionKey, seq: 6, ts: 3_005, producer: 'openclaw', toolCallId: actionChild, name: 'desktop_request_action', args: {} },
    { type: 'tool.completed', runId, sessionKey, seq: 7, ts: 3_006, producer: 'openclaw', toolCallId: actionChild, name: 'desktop_request_action', result: { status: 'approval_required' } },
    {
      type: 'approval.updated',
      runId: wrongLegacyRunId,
      sessionKey,
      ts: 3_007,
      producer: 'uclaw-desktop-approval',
      toolCallId: actionChild,
      approvalId: 'tool-search-desktop-approval',
      approvalKind: 'desktop',
      allowedDecisions: ['allow-once', 'deny'],
      actionable: true,
      resolutionSource: 'desktop-broker',
      itemId: 'tool-search-desktop-approval',
      phase: 'requested',
      status: 'pending',
    },
  ]));

  assertConversationState(state);
  assert.equal(state.turnOrderBySession[sessionKey].length, 1);
  const turn = state.turnsById[state.turnOrderBySession[sessionKey][0]];
  const entries = turn.items.flatMap((item) => item.kind === 'tool-group' ? item.entries : []);
  const approval = turn.items.find((item) => item.kind === 'approval');
  assert.deepEqual(entries.map((entry) => entry.toolCallId), [stateParent, actionParent]);
  assert.deepEqual(entries.map((entry) => entry.name), ['desktop_get_app_state', 'desktop_request_action']);
  assert.ok(approval && approval.kind === 'approval');
  assert.equal(approval.actionable, true);
  assert.equal(turn.status, 'waiting_approval');
  assert.equal(state.quarantineBySession[sessionKey], undefined);
});

test('live and history replay remove the same ordered process prefix from the final answer', () => {
  const sessionKey = `${SESSION_KEY}:live-history-final-prefix`;
  const turnId = createTurnId({ sessionKey, idempotencyKey: 'live-history-final-prefix' });
  const firstProcess = 'Inspecting the current implementation.';
  const secondProcess = 'Verifying the relevant regression tests.';
  const finalAnswer = 'The implementation and regression tests are consistent.';
  const foldedFinal = `${firstProcess}\n\n${secondProcess}\n\n${finalAnswer}`;
  const occurredAt = 1_700_000_050_000;
  const event = (
    type: ConversationEvent['type'],
    offset: number,
    data: ConversationEvent['data'],
    extra: Partial<ConversationEvent> = {},
  ): ConversationEvent => ({
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: `live-history-final-prefix:${offset}:${type}`,
    type,
    source: type === 'turn.requested' ? 'host' : type === 'final.message' ? 'openclaw-chat' : 'openclaw-runtime',
    authority: type === 'turn.requested' || type === 'run.ended' ? 'authoritative' : 'corroborating',
    sessionKey,
    turnId,
    runId: 'run-live-history-final-prefix',
    occurredAt: occurredAt + offset,
    receivedAt: occurredAt + offset,
    replayed: false,
    data,
    ...extra,
  });
  const liveState = reduceConversationEvents(createEmptyConversationState(), [
    event('turn.requested', 0, {
      message: {
        role: 'user',
        id: 'live-history-final-prefix-user',
        idempotencyKey: 'live-history-final-prefix',
        content: 'Inspect and verify the implementation.',
      },
    }, { messageId: 'live-history-final-prefix-user' }),
    event('run.started', 1, { startedAt: occurredAt + 1 }),
    event('assistant.content', 2, { text: firstProcess, replace: true }, { messageId: 'live-process-1' }),
    event('tool.started', 3, { toolCallId: 'live-prefix-tool', name: 'read_file' }, { toolCallId: 'live-prefix-tool' }),
    event('tool.completed', 4, { toolCallId: 'live-prefix-tool', name: 'read_file', result: 'done' }, { toolCallId: 'live-prefix-tool' }),
    event('assistant.content', 5, { text: secondProcess, replace: true }, { messageId: 'live-process-2' }),
    event('final.message', 6, {
      message: { role: 'assistant', id: 'live-prefix-final', content: foldedFinal },
    }, { messageId: 'live-prefix-final' }),
    event('run.ended', 7, { status: 'completed', endedAt: occurredAt + 7 }),
  ]);
  const historyState = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(sessionKey, [{
      role: 'user',
      id: 'history-prefix-user',
      idempotencyKey: 'live-history-final-prefix',
      content: 'Inspect and verify the implementation.',
      timestamp: occurredAt / 1_000,
    }, {
      role: 'assistant',
      id: 'history-process-1',
      content: firstProcess,
      timestamp: (occurredAt + 2) / 1_000,
    }, {
      role: 'assistant',
      id: 'history-prefix-tool',
      content: [{ type: 'toolCall', id: 'history-prefix-tool-call', name: 'read_file', arguments: {} }],
      timestamp: (occurredAt + 3) / 1_000,
    }, {
      role: 'toolresult',
      id: 'history-prefix-result',
      toolCallId: 'history-prefix-tool-call',
      toolName: 'read_file',
      content: 'done',
      timestamp: (occurredAt + 4) / 1_000,
    }, {
      role: 'assistant',
      id: 'history-process-2',
      content: secondProcess,
      timestamp: (occurredAt + 5) / 1_000,
    }, {
      role: 'assistant',
      id: 'history-prefix-final',
      content: foldedFinal,
      timestamp: (occurredAt + 6) / 1_000,
    }]),
  );
  const visibleProjection = (state: ReturnType<typeof createEmptyConversationState>) => {
    const projectedTurn = state.turnsById[state.turnOrderBySession[sessionKey][0]];
    const final = projectedTurn.items.find((item) => item.kind === 'final-answer');
    assert.ok(final && final.kind === 'final-answer');
    return {
      commentary: projectedTurn.items.flatMap((item) => item.kind === 'commentary' ? [item.text] : []),
      final: final.message.content,
    };
  };

  assert.deepEqual(visibleProjection(liveState), {
    commentary: [firstProcess, secondProcess],
    final: finalAnswer,
  });
  assert.deepEqual(visibleProjection(historyState), visibleProjection(liveState));
});

test('history replay preserves each user boundary as a distinct turn', () => {
  const messages: RawMessage[] = [
    { role: 'user', id: 'user-turn-1', timestamp: 2_000, content: 'First question.' },
    { role: 'assistant', id: 'assistant-turn-1', timestamp: 2_001, content: 'First answer.' },
    { role: 'user', id: 'user-turn-2', timestamp: 2_002, content: 'Second question.' },
    { role: 'assistant', id: 'assistant-turn-2', timestamp: 2_003, content: 'Second answer.' },
  ];
  const state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(SESSION_KEY, messages),
  );
  assertConversationState(state);
  const turnIds = state.turnOrderBySession[SESSION_KEY];
  assert.equal(turnIds.length, 2);
  assert.deepEqual(
    turnIds.map((turnId) => state.turnsById[turnId].trigger.message.id),
    ['user-turn-1', 'user-turn-2'],
  );
  assert.deepEqual(
    turnIds.map((turnId) => state.turnsById[turnId].items.filter((item) => item.kind === 'final-answer').length),
    [1, 1],
  );
});

test('history restart keeps failed and cancelled assistant terminals out of successful finals', () => {
  const cases: Array<{
    name: string;
    terminal: RawMessage;
    expectedStatus: 'error' | 'aborted';
    expectedError: string;
  }> = [
    {
      name: 'gateway error metadata',
      terminal: {
        role: 'assistant',
        id: 'assistant-history-error',
        timestamp: 2_101,
        content: 'The provider rejected this request.',
        stopReason: 'error',
        errorMessage: 'Provider quota exceeded. Please retry later.',
      },
      expectedStatus: 'error',
      expectedError: 'Provider quota exceeded. Please retry later.',
    },
    {
      name: 'assistant failed marker',
      terminal: {
        role: 'assistant',
        id: 'assistant-history-failed-marker',
        timestamp: 2_101,
        content: '[assistant turn failed] HTTP 429 from provider',
        isFailed: true,
      } as RawMessage & { isFailed: boolean },
      expectedStatus: 'error',
      expectedError: 'HTTP 429 from provider',
    },
    {
      name: 'user cancellation',
      terminal: {
        role: 'assistant',
        id: 'assistant-history-cancelled',
        timestamp: 2_101,
        content: 'Stopping the current run.',
        stopReason: 'cancelled',
        errorMessage: 'Stopped by user.',
      },
      expectedStatus: 'aborted',
      expectedError: 'Stopped by user.',
    },
  ];

  for (const replayCase of cases) {
    const sessionKey = `${SESSION_KEY}:${replayCase.name.replaceAll(' ', '-')}`;
    const events = historyMessagesToConversationEvents(sessionKey, [
      { role: 'user', id: `user-${replayCase.name}`, timestamp: 2_100, content: 'Please run this task.' },
      { role: 'assistant', id: `progress-${replayCase.name}`, timestamp: 2_100.5, content: 'Working on the request.' },
      replayCase.terminal,
    ]);
    const terminal = events.find((event) => event.type === 'run.ended');
    assert.ok(terminal, replayCase.name);
    assert.equal(terminal.runId, undefined, replayCase.name);
    assert.equal(terminal.authority, 'authoritative', replayCase.name);
    assert.equal((terminal.data as { status: string }).status, replayCase.expectedStatus, replayCase.name);
    assert.equal(events.some((event) => event.type === 'final.message'), false, replayCase.name);
    assert.equal(events.some((event) => event.type === 'turn.error'), true, replayCase.name);

    const state = reduceConversationEvents(createEmptyConversationState(), events);
    assertConversationState(state);
    const turn = state.turnsById[state.turnOrderBySession[sessionKey][0]];
    assert.equal(turn.status, replayCase.expectedStatus, replayCase.name);
    assert.equal(turn.items.some((item) => item.kind === 'final-answer'), false, replayCase.name);
    const error = turn.items.find((item) => item.kind === 'error');
    assert.ok(error && error.kind === 'error', replayCase.name);
    assert.equal(error.message, replayCase.expectedError, replayCase.name);
  }
});

test('history internal completion messages stay inside one parent turn', () => {
  const messages: RawMessage[] = [
    { role: 'user', id: 'parent-user', timestamp: 2_200, content: 'Delegate this task.' },
    {
      role: 'assistant',
      id: 'parent-tool-call',
      timestamp: 2_201,
      content: [
        { type: 'text', text: 'Delegating the research.' },
        { type: 'tool_use', id: 'delegate-tool', name: 'sessions_spawn', input: { agentId: 'researcher' } },
      ],
    },
    {
      role: 'user',
      id: 'internal-completion-text',
      timestamp: 2_202,
      content: [
        '[Internal task completion event]',
        'session_key: agent:researcher:child-session',
        'session_id: child-session',
        'The delegated task completed.',
      ].join('\n'),
    },
    {
      role: 'user',
      id: 'internal-completion-provenance',
      timestamp: 2_203,
      provenance: { kind: 'inter_session', sourceSessionKey: 'agent:researcher:child-session' },
      content: 'Internal child delivery evidence.',
    },
    {
      role: 'user',
      id: 'internal-completion-structured',
      timestamp: 2_204,
      content: [{ type: 'task_completion', text: 'Structured completion evidence.' }],
    },
    {
      role: 'user',
      id: 'delegate-tool-result',
      timestamp: 2_205,
      content: [{ type: 'tool_result', tool_use_id: 'delegate-tool', content: 'Research complete.' }],
    },
    {
      role: 'assistant',
      id: 'parent-final',
      timestamp: 2_206,
      content: 'The delegated research is complete.',
      _attachedFiles: [{
        fileName: 'research.txt',
        mimeType: 'text/plain',
        fileSize: 32,
        preview: null,
        filePath: '/tmp/research.txt',
        disposition: 'output-delivery',
      }],
    },
  ];
  const events = historyMessagesToConversationEvents(SESSION_KEY, messages);
  assert.equal(events.filter((event) => event.type === 'turn.requested').length, 1);

  const state = reduceConversationEvents(createEmptyConversationState(), events);
  assertConversationState(state);
  const turnIds = state.turnOrderBySession[SESSION_KEY];
  assert.equal(turnIds.length, 1);
  const turn = state.turnsById[turnIds[0]];
  assert.equal(turn.trigger.message.id, 'parent-user');
  assert.equal(turn.items.filter((item) => item.kind === 'user-message').length, 1);
  assert.equal(turn.items.filter((item) => item.kind === 'final-answer').length, 1);
  const tools = turn.items.find((item) => item.kind === 'tool-group');
  assert.ok(tools && tools.kind === 'tool-group');
  assert.equal(tools.entries.length, 1);
  assert.equal(tools.entries[0].status, 'completed');
  const artifacts = turn.items.find((item) => item.kind === 'artifact-group');
  assert.ok(artifacts && artifacts.kind === 'artifact-group');
  assert.equal(artifacts.artifacts.length, 1);
});

test('duplicate runtime deliveries are idempotent and completed tools never revive', () => {
  const base: ChatRuntimeEvent[] = [
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 1, ts: 1_000, producer: 'openclaw' },
    { type: 'tool.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 2, ts: 1_001, producer: 'openclaw', toolCallId: 'tool-1', name: 'exec', args: { command: 'true' } },
    { type: 'tool.completed', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 3, ts: 1_002, producer: 'openclaw', toolCallId: 'tool-1', name: 'exec', result: 'ok' },
  ];
  const events = runtime([
    ...base,
    ...base,
    base[1],
    { type: 'tool.updated', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 4, ts: 1_003, producer: 'openclaw', toolCallId: 'tool-1', name: 'exec', partialResult: 'late' },
    { type: 'tool.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 5, ts: 1_004, producer: 'openclaw', toolCallId: 'tool-1', name: 'exec', args: { command: 'late' } },
  ]);
  const state = reduceConversationEvents(createEmptyConversationState(), events);
  assertConversationState(state);
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  const toolGroup = turn.items.find((item) => item.kind === 'tool-group');
  assert.ok(toolGroup && toolGroup.kind === 'tool-group');
  assert.equal(toolGroup.entries.length, 1);
  assert.equal(toolGroup.entries[0].status, 'completed');
});

test('run completion uses a weak tool fallback that a late native tool error can correct', () => {
  const events = runtime([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 70, ts: 7_000, producer: 'openclaw' },
    {
      type: 'tool.started',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 71,
      ts: 7_001,
      producer: 'openclaw',
      toolCallId: 'late-native-error',
      name: 'exec',
    },
    {
      type: 'assistant.delta',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 72,
      ts: 7_002,
      producer: 'openclaw',
      text: 'Run delivery completed before the tool terminal arrived.',
      replace: true,
    },
    { type: 'run.ended', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 73, ts: 7_003, producer: 'openclaw', status: 'completed' },
    {
      type: 'tool.completed',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 74,
      ts: 7_004,
      producer: 'openclaw',
      toolCallId: 'late-native-error',
      name: 'exec',
      result: 'exit code 1',
      isError: true,
    },
  ]);
  let state = reduceConversationEvents(createEmptyConversationState(), events.slice(0, -1));
  const turnId = state.turnOrderBySession[SESSION_KEY][0];
  assert.equal(state.turnsById[turnId].toolMergeByCallId['late-native-error'].fields.status.domain, 'run-fallback');

  state = reduceConversationEvents(state, events.slice(-1));
  const turn = state.turnsById[turnId];
  const toolGroup = turn.items.find((item) => item.kind === 'tool-group');

  assert.ok(toolGroup && toolGroup.kind === 'tool-group');
  assert.equal(toolGroup.entries[0].status, 'error');
  assert.equal(toolGroup.entries[0].result, 'exit code 1');
  assert.equal(turn.toolMergeByCallId['late-native-error'].fields.status.domain, 'tool');
});

test('native completed run terminal outranks a later history error terminal', () => {
  const events = runtime([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 80, ts: 8_000, producer: 'openclaw' },
    {
      type: 'assistant.delta',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 81,
      ts: 8_001,
      producer: 'openclaw',
      text: 'Native completion wins.',
      replace: true,
    },
    { type: 'run.ended', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 82, ts: 8_002, producer: 'openclaw', status: 'completed' },
    {
      type: 'run.ended',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 83,
      ts: 8_003,
      producer: 'history',
      status: 'error',
      error: 'Stale replay error',
    },
  ]);
  const state = reduceConversationEvents(createEmptyConversationState(), events);
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];

  assert.equal(turn.evidence.runTerminal, 'completed');
  assert.equal(turn.evidence.runTerminalSource, 'openclaw-runtime');
  assert.equal(turn.status, 'completed');
});

test('artifact verification and final entities keep stronger fields without duplicate aliases', () => {
  const turnId = 'turn:authority-entities';
  const base = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    sessionKey: SESSION_KEY,
    turnId,
    rootRunId: RUN_ID,
    runId: RUN_ID,
    receivedAt: 9_000_000,
    replayed: false,
  } as const;
  const events: ConversationEvent[] = [
    {
      ...base,
      eventId: 'entity:turn',
      type: 'turn.requested',
      source: 'host',
      authority: 'authoritative',
      messageId: 'entity-user',
      occurredAt: 9_000_000,
      data: { message: { role: 'user', id: 'entity-user', content: 'Merge the result once.' } },
    },
    {
      ...base,
      eventId: 'entity:artifact:native',
      type: 'artifact.updated',
      source: 'openclaw-runtime',
      authority: 'authoritative',
      occurredAt: 9_000_001,
      data: {
        artifact: {
          id: 'native-artifact-id',
          title: 'Native output.zip',
          filePath: '/tmp/authority-output.zip',
          mimeType: 'application/zip',
          sizeBytes: 100,
        },
      },
    },
    {
      ...base,
      eventId: 'entity:verification:native',
      type: 'verification.updated',
      source: 'openclaw-runtime',
      authority: 'authoritative',
      occurredAt: 9_000_002,
      data: {
        verification: {
          id: 'native-verification-id',
          targetId: '/tmp/authority-output.zip',
          kind: 'artifact.integrity',
          status: 'passed',
          title: 'Native verification',
        },
      },
    },
    {
      ...base,
      eventId: 'entity:artifact:host',
      type: 'artifact.updated',
      source: 'host',
      authority: 'authoritative',
      occurredAt: 9_000_003,
      data: {
        artifact: {
          id: 'host-artifact-id',
          title: 'Host observed output.zip',
          filePath: '/tmp/authority-output.zip',
          mimeType: 'application/zip',
          sizeBytes: 456,
        },
      },
    },
    {
      ...base,
      eventId: 'entity:verification:host',
      type: 'verification.updated',
      source: 'host',
      authority: 'authoritative',
      occurredAt: 9_000_004,
      data: {
        verification: {
          id: 'host-verification-id',
          targetId: '/tmp/authority-output.zip',
          kind: 'artifact.integrity',
          status: 'failed',
          title: 'Host verification',
        },
      },
    },
    {
      ...base,
      eventId: 'entity:final:native',
      type: 'final.message',
      source: 'openclaw-chat',
      authority: 'corroborating',
      messageId: 'native-final',
      occurredAt: 9_000_005,
      data: { message: { role: 'assistant', id: 'native-final', content: 'Native final answer.' } },
    },
    {
      ...base,
      eventId: 'entity:artifact:history',
      type: 'artifact.updated',
      source: 'history',
      authority: 'authoritative',
      occurredAt: 9_000_006,
      replayed: true,
      data: {
        artifact: {
          id: 'history-artifact-id',
          title: 'Stale history output.zip',
          filePath: '/tmp/authority-output.zip',
          mimeType: 'application/octet-stream',
          sizeBytes: 123,
        },
      },
    },
    {
      ...base,
      eventId: 'entity:verification:history',
      type: 'verification.updated',
      source: 'history',
      authority: 'authoritative',
      occurredAt: 9_000_007,
      replayed: true,
      data: {
        verification: {
          id: 'history-verification-id',
          targetId: '/tmp/authority-output.zip',
          kind: 'artifact.integrity',
          status: 'failed',
          title: 'Stale history verification',
          detail: 'History can fill this missing detail.',
        },
      },
    },
    {
      ...base,
      eventId: 'entity:final:history',
      type: 'final.message',
      source: 'history',
      authority: 'authoritative',
      messageId: 'history-final',
      occurredAt: 9_000_008,
      replayed: true,
      data: { message: { role: 'assistant', id: 'history-final', content: 'Persisted transcript final.' } },
    },
  ];
  const state = reduceConversationEvents(createEmptyConversationState(), events);
  const turn = state.turnsById[turnId];
  const artifactItem = turn.items.find((item) => item.kind === 'artifact-group');
  const verificationItem = turn.items.find((item) => item.kind === 'verification-summary');
  const finalItem = turn.items.find((item) => item.kind === 'final-answer');

  assert.ok(artifactItem && artifactItem.kind === 'artifact-group');
  assert.equal(artifactItem.artifacts.length, 1);
  assert.equal(artifactItem.artifacts[0].title, 'Native output.zip');
  assert.equal(artifactItem.artifacts[0].mimeType, 'application/zip');
  assert.equal(artifactItem.artifacts[0].sizeBytes, 456);
  assert.ok(verificationItem && verificationItem.kind === 'verification-summary');
  assert.equal(verificationItem.verifications.length, 1);
  assert.equal(verificationItem.verifications[0].status, 'failed');
  assert.equal(verificationItem.verifications[0].title, 'Native verification');
  assert.equal(verificationItem.verifications[0].detail, 'History can fill this missing detail.');
  assert.ok(finalItem && finalItem.kind === 'final-answer');
  assert.equal(finalItem.message.content, 'Persisted transcript final.');
});

test('artifact bridge aliases union existing path and URL entities in either arrival order', () => {
  const replay = (reverse: boolean) => {
    const sessionKey = `agent:main:artifact-bridge-${reverse ? 'url-first' : 'path-first'}`;
    const turnId = `turn:artifact-bridge-${reverse ? 'url-first' : 'path-first'}`;
    const path = '/tmp/artifact-bridge-output.png';
    const url = '/api/chat/media/outgoing/artifact-bridge-output';
    const occurredAt = 9_100_000;
    const event = (
      eventId: string,
      offset: number,
      taskId: string,
      artifact: Record<string, unknown>,
      source: ConversationEvent['source'] = 'history',
      authority: ConversationEvent['authority'] = 'authoritative',
    ): ConversationEvent => ({
      version: CONVERSATION_EVENT_CONTRACT_VERSION,
      eventId,
      type: 'artifact.updated',
      source,
      authority,
      sessionKey,
      turnId,
      runId: `run:${turnId}`,
      taskId,
      occurredAt: occurredAt + offset,
      receivedAt: occurredAt + offset,
      replayed: source === 'history',
      data: { artifact },
    });
    const pathOnly = event('artifact-bridge:path', 1, 'task-path', {
      id: 'path-only-id',
      title: 'Strong path title',
      filePath: path,
      mimeType: 'image/png',
      availability: 'available',
    }, 'host');
    const urlOnly = event('artifact-bridge:url', 2, 'task-url', {
      id: 'url-only-id',
      title: 'History URL title',
      url,
      preview: 'data:image/png;base64,c2FtZQ==',
    });
    const bridge = event('artifact-bridge:both', 3, 'task-path', {
      id: 'bridge-id',
      filePath: path,
      url,
    }, 'openclaw-runtime');
    const lateDonor = event('artifact-bridge:late-donor', 4, 'task-url', {
      id: 'url-only-id',
      url,
      title: 'Late weaker history title',
    });
    const requested: ConversationEvent = {
      version: CONVERSATION_EVENT_CONTRACT_VERSION,
      eventId: 'artifact-bridge:requested',
      type: 'turn.requested',
      source: 'host',
      authority: 'authoritative',
      sessionKey,
      turnId,
      messageId: 'artifact-bridge:user',
      occurredAt,
      receivedAt: occurredAt,
      replayed: false,
      data: {
        message: {
          role: 'user',
          id: 'artifact-bridge:user',
          content: 'Create one durable image artifact.',
        },
      },
    };
    const ordered = reverse ? [urlOnly, pathOnly] : [pathOnly, urlOnly];
    const state = reduceConversationEvents(
      createEmptyConversationState(),
      [requested, ...ordered, bridge, lateDonor],
    );
    assertConversationState(state);
    return { state, turn: state.turnsById[turnId], path, url };
  };

  for (const reverse of [false, true]) {
    const { state, turn, path, url } = replay(reverse);
    const artifactGroups = turn.items.filter((item) => item.kind === 'artifact-group');
    const artifacts = artifactGroups.flatMap((item) => item.artifacts);
    assert.equal(artifactGroups.length, 1);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].filePath, path);
    assert.equal(artifacts[0].url, url);
    assert.equal(artifacts[0].preview, 'data:image/png;base64,c2FtZQ==');
    assert.equal(artifacts[0].title, 'Strong path title');
    assert.equal(artifacts[0].mimeType, 'image/png');
    assert.equal(artifacts[0].availability, 'available');

    const entities = new Set([
      turn.artifactEntityByAlias['id:path-only-id'],
      turn.artifactEntityByAlias['id:url-only-id'],
      turn.artifactEntityByAlias['id:bridge-id'],
      turn.artifactEntityByAlias[`path:${path}`],
      turn.artifactEntityByAlias[`url:${url}`],
    ]);
    assert.equal(entities.size, 1);
    assert.equal(Object.keys(turn.artifactItemByEntity).length, 1);
    assert.equal(Object.keys(turn.artifactMergeByEntity).length, 1);
    assert.equal(state.turnOrderBySession[turn.sessionKey].length, 1);
  }
});

test('an older history snapshot cannot replace newer final message content', () => {
  const turnId = 'turn:stale-history-final';
  const live = chatEventToConversationEvents({
    state: 'final',
    sessionKey: SESSION_KEY,
    runId: RUN_ID,
    message: {
      role: 'assistant',
      id: 'newer-live-final',
      timestamp: 12_000,
      content: 'Newer live final.',
    } satisfies RawMessage,
  }, { sessionKey: SESSION_KEY, activeRunId: RUN_ID, turnId });
  const staleHistory: ConversationEvent = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'stale-history-final',
    type: 'final.message',
    source: 'history',
    authority: 'authoritative',
    sessionKey: SESSION_KEY,
    turnId,
    messageId: 'older-history-final',
    occurredAt: 11_000_000,
    receivedAt: 12_001_000,
    replayed: true,
    data: { message: { role: 'assistant', id: 'older-history-final', content: 'Older history final.' } },
  };
  const state = reduceConversationEvents(createEmptyConversationState(), [...live, staleHistory]);
  const final = state.turnsById[turnId].items.find((item) => item.kind === 'final-answer');

  assert.ok(final && final.kind === 'final-answer');
  assert.equal(final.message.content, 'Newer live final.');
});

test('history replacement preserves compacted live projection without the full raw event log', () => {
  const user: RawMessage = {
    role: 'user',
    id: 'compacted-user',
    idempotencyKey: 'compacted-idempotency',
    timestamp: 10_000,
    content: 'Preserve live evidence.',
  };
  const history = historyMessagesToConversationEvents(SESSION_KEY, [user]);
  const turnId = history.find((event) => event.type === 'turn.requested')?.turnId;
  assert.ok(turnId);
  const liveEvents = runtime([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 90, ts: 10_001, producer: 'openclaw' },
    {
      type: 'tool.started',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 91,
      ts: 10_002,
      producer: 'openclaw',
      toolCallId: 'compacted-tool',
      name: 'exec',
    },
    {
      type: 'tool.completed',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 92,
      ts: 10_003,
      producer: 'openclaw',
      toolCallId: 'compacted-tool',
      name: 'exec',
      result: 'kept result',
    },
    {
      type: 'assistant.delta',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 93,
      ts: 10_004,
      producer: 'openclaw',
      text: 'Kept live final.',
      replace: true,
    },
    { type: 'run.ended', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 94, ts: 10_005, producer: 'openclaw', status: 'completed' },
  ]).map((event) => ({ ...event, turnId }));
  let state = reduceConversationEvents(createEmptyConversationState(), [
    ...history,
    ...liveEvents,
  ]);
  state = {
    ...state,
    eventsByTurnId: {
      ...state.eventsByTurnId,
      [turnId]: state.eventsByTurnId[turnId].slice(-1),
    },
  };

  const replaced = replaceSessionTurns(
    state,
    SESSION_KEY,
    historyMessagesToConversationEvents(SESSION_KEY, [user], { reason: 'manual-refresh' }),
  );
  const turn = replaced.turnsById[turnId];
  const toolGroup = turn.items.find((item) => item.kind === 'tool-group');
  const final = turn.items.find((item) => item.kind === 'final-answer');

  assert.ok(toolGroup && toolGroup.kind === 'tool-group');
  assert.equal(toolGroup.entries[0].result, 'kept result');
  assert.ok(final && final.kind === 'final-answer');
  assert.equal(final.message.content, 'Kept live final.');
});

test('replacing identical history returns the original state and Turn references', () => {
  const sessionKey = `${SESSION_KEY}:history-replace-idempotent`;
  const messages: RawMessage[] = [{
    role: 'user',
    id: 'history-replace-idempotent-user',
    idempotencyKey: 'history-replace-idempotent-key',
    timestamp: 10_100,
    content: 'Replay this history without rebuilding it.',
  }, {
    role: 'assistant',
    id: 'history-replace-idempotent-final',
    timestamp: 10_101,
    content: 'Stable completed Turn.',
  }];
  const first = replaceSessionTurns(
    createEmptyConversationState(),
    sessionKey,
    historyMessagesToConversationEvents(sessionKey, messages),
  );
  const turnId = first.turnOrderBySession[sessionKey][0];
  const turn = first.turnsById[turnId];
  const second = replaceSessionTurns(
    first,
    sessionKey,
    historyMessagesToConversationEvents(sessionKey, messages, { reason: 'manual-refresh' }),
  );

  assert.equal(second, first);
  assert.equal(second.turnsById[turnId], turn);
});

test('appending a history Turn preserves every unchanged completed Turn reference', () => {
  const sessionKey = `${SESSION_KEY}:history-append-reference`;
  const firstMessages: RawMessage[] = [{
    role: 'user',
    id: 'history-append-first-user',
    idempotencyKey: 'history-append-first-key',
    timestamp: 10_200,
    content: 'First request.',
  }, {
    role: 'assistant',
    id: 'history-append-first-final',
    timestamp: 10_201,
    content: 'First answer.',
  }];
  const first = replaceSessionTurns(
    createEmptyConversationState(),
    sessionKey,
    historyMessagesToConversationEvents(sessionKey, firstMessages),
  );
  const firstTurnId = first.turnOrderBySession[sessionKey][0];
  const firstTurn = first.turnsById[firstTurnId];
  const appended = replaceSessionTurns(
    first,
    sessionKey,
    historyMessagesToConversationEvents(sessionKey, [...firstMessages, {
      role: 'user',
      id: 'history-append-second-user',
      idempotencyKey: 'history-append-second-key',
      timestamp: 10_202,
      content: 'Second request.',
    }, {
      role: 'assistant',
      id: 'history-append-second-final',
      timestamp: 10_203,
      content: 'Second answer.',
    }]),
  );

  assert.notEqual(appended, first);
  assert.equal(appended.turnOrderBySession[sessionKey].length, 2);
  assert.equal(appended.turnsById[firstTurnId], firstTurn);
  assert.equal(appended.turnsById[firstTurnId].revision, firstTurn.revision);
});

test('assistant-only history replacement keeps its orphan Turn reference stable', () => {
  const sessionKey = `${SESSION_KEY}:history-orphan-idempotent`;
  const messages: RawMessage[] = [{
    role: 'assistant',
    id: 'history-orphan-idempotent-final',
    timestamp: 10_300,
    content: 'Recovered assistant-only answer.',
  }];
  const first = replaceSessionTurns(
    createEmptyConversationState(),
    sessionKey,
    historyMessagesToConversationEvents(sessionKey, messages),
  );
  const turnId = first.turnOrderBySession[sessionKey][0];
  const second = replaceSessionTurns(
    first,
    sessionKey,
    historyMessagesToConversationEvents(sessionKey, messages),
  );

  assert.equal(second, first);
  assert.equal(second.turnsById[turnId], first.turnsById[turnId]);
});

test('high-frequency item source references keep first provenance and a bounded recent tail', () => {
  const runtimeEvents: ChatRuntimeEvent[] = [
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 100, ts: 10_000, producer: 'openclaw' },
    ...Array.from({ length: 100 }, (_, index) => ({
      type: 'assistant.delta' as const,
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 101 + index,
      ts: 10_001 + index,
      producer: 'openclaw',
      delta: 'x',
    })),
  ];
  const events = runtime(runtimeEvents);
  const state = reduceConversationEvents(createEmptyConversationState(), events);
  assertConversationState(state);
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  const commentary = turn.items.find((item) => item.kind === 'commentary');
  assert.ok(commentary && commentary.kind === 'commentary');
  assert.equal(commentary.text.length, 100);
  assert.equal(commentary.sourceEventIds.length, 64);
  assert.equal(commentary.sourceEventIds[0], events[1].eventId);
  assert.equal(commentary.sourceEventIds.at(-1), events.at(-1)?.eventId);
});

test('live final and authoritative history reconcile to one final item until backend idle settles the turn', () => {
  const user: RawMessage = {
    role: 'user',
    id: 'user-live',
    idempotencyKey: 'idem-live',
    timestamp: 1_000,
    content: 'Answer once.',
  };
  const history = [
    user,
    { role: 'assistant', id: 'answer-live', timestamp: 1_010, content: 'One answer.' } satisfies RawMessage,
  ];
  const historyEvents = historyMessagesToConversationEvents(SESSION_KEY, history);
  const turnRequested = historyEvents.find((event) => event.type === 'turn.requested');
  assert.ok(turnRequested);
  const live = chatEventToConversationEvents({
    state: 'final',
    sessionKey: SESSION_KEY,
    runId: RUN_ID,
    message: history[1],
  }, { sessionKey: SESSION_KEY, activeRunId: RUN_ID, turnId: turnRequested.turnId });
  let state = reduceConversationEvents(
    createEmptyConversationState(),
    [turnRequested, ...live, ...historyEvents],
  );
  assertConversationState(state);
  const turnId = state.turnOrderBySession[SESSION_KEY][0];
  let turn = state.turnsById[turnId];
  assert.equal(turn.items.filter((item) => item.kind === 'final-answer').length, 1);
  assert.equal(turn.status, 'running');

  state = reduceConversationEvents(state, [{
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'live-history-final:backend-idle',
    type: 'session.activity',
    source: 'host',
    authority: 'authoritative',
    sessionKey: SESSION_KEY,
    occurredAt: 1_011_000,
    receivedAt: 1_011_000,
    data: { active: false },
  }]);
  assertConversationState(state);
  turn = state.turnsById[turnId];
  assert.equal(turn.items.filter((item) => item.kind === 'final-answer').length, 1);
  assert.equal(turn.status, 'completed');
});

test('completion wake sequence restarts do not suppress the newer final narrative', () => {
  const sessionKey = `${SESSION_KEY}:sequence-scope`;
  const ownerRunId = 'run-sequence-owner';
  const wakeRunId = 'image_generate:sequence-task:ok';
  const turnId = createTurnId({ sessionKey, idempotencyKey: 'sequence-request' });
  const requested: ConversationEvent = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'sequence-scope:requested',
    type: 'turn.requested',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    turnId,
    occurredAt: 1_000_000,
    receivedAt: 1_000_000,
    replayed: false,
    data: {
      message: {
        role: 'user',
        id: 'sequence-scope:user',
        idempotencyKey: 'sequence-request',
        timestamp: 1_000,
        content: 'Generate one image.',
      },
    },
  };
  const ownerFinal = chatEventToConversationEvents({
    state: 'final',
    sessionKey,
    runId: ownerRunId,
    seq: 12,
    message: {
      role: 'assistant',
      id: 'owner-final',
      timestamp: 1_001,
      content: 'The task was queued.',
    },
  }, {
    sessionKey,
    currentSessionKey: sessionKey,
    activeRunId: ownerRunId,
    turnId,
  });
  const wakeFinal = chatEventToConversationEvents({
    state: 'final',
    sessionKey,
    runId: wakeRunId,
    seq: 1,
    message: {
      role: 'assistant',
      id: 'wake-final',
      timestamp: 1_002,
      content: 'The generated image is ready.',
    },
  }, createChatEventContext({
    sessionKey,
    currentSessionKey: sessionKey,
    activeRunId: ownerRunId,
    ownerRunId,
  }));
  let state = reduceConversationEvents(createEmptyConversationState(), [requested, ...ownerFinal, ...wakeFinal]);
  assertConversationState(state);
  const turn = state.turnsById[turnId];
  const finalItems = turn.items.filter((item) => item.kind === 'final-answer');
  assert.equal(finalItems.length, 1);
  assert.equal(finalItems[0]?.kind === 'final-answer' ? finalItems[0].message.content : null, 'The generated image is ready.');
  assert.equal(state.ingressDiagnosticsBySession[sessionKey]?.staleSequenceCount ?? 0, 0);
  assert.ok(Object.keys(turn.sequenceWatermarks).some((key) => key.includes(ownerRunId)));
  assert.ok(Object.keys(turn.sequenceWatermarks).some((key) => key.includes(wakeRunId)));
});

test('completion wake sequence restarts update the same artifact identity', () => {
  const sessionKey = `${SESSION_KEY}:artifact-sequence-restart`;
  const ownerRunId = 'run-artifact-sequence-owner';
  const wakeRunId = 'image_generate:artifact-sequence-task:ok';
  const turnId = 'turn:artifact-sequence-restart';
  const ownerArtifact: ConversationEvent = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'artifact-sequence:owner',
    type: 'artifact.updated',
    source: 'openclaw-runtime',
    authority: 'authoritative',
    sessionKey,
    turnId,
    rootRunId: ownerRunId,
    runId: ownerRunId,
    seq: 12,
    occurredAt: 1_700_000_100_000,
    receivedAt: 1_700_000_100_000,
    replayed: false,
    data: {
      artifact: {
        id: 'artifact-sequence-output',
        title: 'Queued image',
        filePath: '/tmp/artifact-sequence-output.png',
        availability: 'registered',
      },
    },
  };
  const wakeArtifact: ConversationEvent = {
    ...ownerArtifact,
    eventId: 'artifact-sequence:wake',
    rootRunId: ownerRunId,
    runId: wakeRunId,
    seq: 1,
    occurredAt: 1_700_000_100_001,
    receivedAt: 1_700_000_100_001,
    data: {
      artifact: {
        ...ownerArtifact.data.artifact,
        title: 'Ready image',
        availability: 'available',
      },
    },
  };

  const state = reduceConversationEvents(createEmptyConversationState(), [ownerArtifact, wakeArtifact]);
  const turn = state.turnsById[turnId];
  const artifactItem = turn.items.find((item) => item.kind === 'artifact-group');
  assert.ok(artifactItem && artifactItem.kind === 'artifact-group');
  assert.equal(artifactItem.artifacts[0]?.title, 'Ready image');
  assert.equal(artifactItem.artifacts[0]?.availability, 'available');
  assert.equal(state.ingressDiagnosticsBySession[sessionKey]?.staleSequenceCount ?? 0, 0);
  assert.ok(Object.keys(turn.sequenceWatermarks).some((key) => key.includes(ownerRunId)));
  assert.ok(Object.keys(turn.sequenceWatermarks).some((key) => key.includes(wakeRunId)));
});

test('ordinary and completion wake evidence keep the original Turn across history refresh', () => {
  const cases: Array<{
    name: string;
    eventRunId: string;
    ownerRunId: string;
    taskId?: string;
    background?: boolean;
    missingSession?: boolean;
  }> = [
    { name: 'ordinary final', eventRunId: 'run-final-owner', ownerRunId: 'run-final-owner' },
    {
      name: 'image completion wake final',
      eventRunId: 'image_generate:image-task-owner:ok',
      ownerRunId: 'run-image-owner',
      taskId: 'image-task-owner',
    },
    {
      name: 'background image completion wake final',
      eventRunId: 'image_generate:background-image-task-owner:ok',
      ownerRunId: 'run-background-image-owner',
      taskId: 'background-image-task-owner',
      background: true,
      missingSession: true,
    },
  ];

  for (const replayCase of cases) {
    const sessionKey = `${SESSION_KEY}:${replayCase.name.replaceAll(' ', '-')}`;
    const idempotencyKey = `${replayCase.ownerRunId}:request`;
    const user: RawMessage = {
      role: 'user',
      id: `${replayCase.ownerRunId}:user`,
      idempotencyKey,
      timestamp: 2_000,
      content: 'Generate one image and keep this request in one Turn.',
    };
    const turnId = createTurnId({ sessionKey, idempotencyKey });
    const requestedAt = 2_000_000;
    let state = reduceConversationEvents(createEmptyConversationState(), [{
      version: CONVERSATION_EVENT_CONTRACT_VERSION,
      eventId: `${replayCase.ownerRunId}:requested`,
      type: 'turn.requested',
      source: 'host',
      authority: 'authoritative',
      sessionKey,
      turnId,
      messageId: user.id,
      occurredAt: requestedAt,
      receivedAt: requestedAt,
      replayed: false,
      data: { message: user },
    }, ...runtime([{
      type: 'run.started',
      runId: replayCase.ownerRunId,
      sessionKey,
      seq: 1,
      ts: 2_001,
      producer: 'openclaw',
    }]).map((event) => ({ ...event, turnId }))]);

    const idleAt = 2_002_000;
    state = reduceConversationEvents(state, [{
      version: CONVERSATION_EVENT_CONTRACT_VERSION,
      eventId: `${replayCase.ownerRunId}:idle`,
      type: 'session.activity',
      source: 'host',
      authority: 'authoritative',
      sessionKey,
      rootRunId: replayCase.ownerRunId,
      runId: replayCase.ownerRunId,
      occurredAt: idleAt,
      receivedAt: idleAt,
      replayed: false,
      data: { active: false },
    }]);
    assert.equal(state.turnsById[turnId].status, 'completed', replayCase.name);

    const finalMessage: RawMessage = {
      role: 'assistant',
      id: `${replayCase.eventRunId}:final`,
      timestamp: 2_006,
      content: 'The generated image is ready.',
    };
    const runtimeRuns: Parameters<typeof resolveCompletionWakeOwnerContext>[0]['runtimeRuns'] =
      replayCase.taskId
        ? {
            [replayCase.ownerRunId]: {
              runId: replayCase.ownerRunId,
              sessionKey,
              status: 'completed',
              assistantText: '',
              thinkingText: '',
              events: [],
              tasks: [{
                taskId: replayCase.taskId,
                title: 'Generate image',
                status: 'running',
              }],
            },
          }
        : {};
    const currentSessionKey = replayCase.background
      ? `${SESSION_KEY}:selected-elsewhere`
      : sessionKey;
    const owner = resolveCompletionWakeOwnerContext({
      runtimeRuns,
      activeRunId: null,
      eventRunId: replayCase.eventRunId,
      currentSessionKey,
      eventSessionKey: replayCase.missingSession ? null : sessionKey,
    });
    assert.equal(
      owner?.ownerRunId ?? null,
      replayCase.taskId ? replayCase.ownerRunId : null,
      replayCase.name,
    );
    if (replayCase.taskId) {
      const artifactId = `${replayCase.taskId}:artifact`;
      const wakeRuntimeEvents = [
        correlateCompletionWakeRuntimeEvent({
          runtimeRuns,
          activeRunId: null,
          currentSessionKey,
          eventSessionKey: replayCase.missingSession ? null : sessionKey,
          event: {
            type: 'artifact.produced',
            producer: 'media',
            runId: replayCase.eventRunId,
            ...(replayCase.missingSession ? {} : { sessionKey }),
            seq: 2,
            ts: 2_003,
            artifact: {
              id: artifactId,
              kind: 'image',
              title: 'Generated image',
              mimeType: 'image/png',
              url: `/api/chat/media/outgoing/${artifactId}.png`,
            },
          },
        }),
        correlateCompletionWakeRuntimeEvent({
          runtimeRuns,
          activeRunId: null,
          currentSessionKey,
          eventSessionKey: replayCase.missingSession ? null : sessionKey,
          event: {
            type: 'verification.completed',
            producer: 'media',
            runId: replayCase.eventRunId,
            ...(replayCase.missingSession ? {} : { sessionKey }),
            seq: 3,
            ts: 2_004,
            verification: {
              id: `${artifactId}:availability`,
              status: 'passed',
              kind: 'artifact.availability',
              required: true,
              artifactId,
            },
          },
        }),
        correlateCompletionWakeRuntimeEvent({
          runtimeRuns,
          activeRunId: null,
          currentSessionKey,
          eventSessionKey: replayCase.missingSession ? null : sessionKey,
          event: {
            type: 'run.ended',
            producer: CHAT_SYNTHETIC_TERMINAL_PRODUCER,
            runId: replayCase.eventRunId,
            ...(replayCase.missingSession ? {} : { sessionKey }),
            seq: 4,
            ts: 2_005,
            status: 'completed',
          },
        }),
      ];
      wakeRuntimeEvents.forEach((event) => {
        assert.equal(event.rootRunId, replayCase.ownerRunId, replayCase.name);
        assert.equal(event.taskId, replayCase.taskId, replayCase.name);
        assert.equal(event.sessionKey, sessionKey, replayCase.name);
      });
      state = reduceConversationEvents(state, runtime(wakeRuntimeEvents));
    }
    const contextInput = {
      sessionKey,
      currentSessionKey,
      activeRunId: null,
      ownerRunId: owner?.ownerRunId,
    };
    state = reduceConversationEvents(state, chatEventToConversationEvents({
      state: 'final',
      ...(replayCase.missingSession ? {} : { sessionKey }),
      runId: replayCase.eventRunId,
      message: finalMessage,
    }, createChatEventContext(contextInput)));
    state = replaceSessionTurns(
      state,
      sessionKey,
      historyMessagesToConversationEvents(sessionKey, [user, finalMessage]),
    );

    assert.deepEqual(state.turnOrderBySession[sessionKey], [turnId], replayCase.name);
    assert.equal(
      state.turnsById[turnId].items.filter((item) => item.kind === 'final-answer').length,
      1,
      replayCase.name,
    );
    assert.equal(
      state.aliases.byRunId[createSessionAliasKey(sessionKey, replayCase.eventRunId)],
      turnId,
      replayCase.name,
    );
    assert.equal(state.quarantineBySession[sessionKey]?.records.length ?? 0, 0, replayCase.name);
    if (replayCase.taskId) {
      const turn = state.turnsById[turnId];
      assert.equal(
        turn.items.flatMap((item) => item.kind === 'artifact-group' ? item.artifacts : []).length,
        1,
        replayCase.name,
      );
      assert.equal(
        turn.items.flatMap((item) => item.kind === 'verification-summary' ? item.verifications : []).length,
        1,
        replayCase.name,
      );
      assert.equal(
        state.aliases.byTaskId[createSessionAliasKey(sessionKey, replayCase.taskId)],
        turnId,
        replayCase.name,
      );
    }
  }
});

test('backend idle settles interrupted history tools without fabricating a final answer', () => {
  const sessionKey = `${SESSION_KEY}:idle-interrupted-tool`;
  let state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(sessionKey, [{
      role: 'user',
      id: 'idle-interrupted-tool-user',
      timestamp: 5_200,
      content: 'Start a tool and restore this session later.',
    }, {
      role: 'assistant',
      id: 'idle-interrupted-tool-call',
      timestamp: 5_201,
      content: [{
        type: 'toolCall',
        id: 'idle-interrupted-tool-call-id',
        name: 'video_generate',
        arguments: { prompt: 'snow mountain' },
      }],
    }]),
  );
  const turnId = state.turnOrderBySession[sessionKey][0];
  let turn = state.turnsById[turnId];
  assert.equal(turn.status, 'running');
  assert.equal(turn.items.some((item) => item.kind === 'final-answer'), false);
  assert.equal(
    turn.items.some((item) => item.kind === 'tool-group' && item.entries.some((entry) => entry.status === 'running')),
    true,
  );

  state = reduceConversationEvents(state, [{
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'idle-interrupted-tool:backend-idle',
    type: 'session.activity',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    occurredAt: 5_202_000,
    receivedAt: 5_202_000,
    replayed: false,
    data: { active: false },
  }]);
  assertConversationState(state);
  turn = state.turnsById[turnId];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.items.some((item) => item.kind === 'final-answer'), false);
  assert.equal(
    turn.items.some((item) => item.kind === 'tool-group' && item.entries.some((entry) => entry.status === 'running')),
    false,
  );
  assert.equal(state.aliases.activeBySession[sessionKey], undefined);
});

test('backend idle weakly settles history-only async tasks and native terminal evidence corrects them', () => {
  const sessionKey = `${SESSION_KEY}:idle-interrupted-history-task`;
  const taskId = 'idle-interrupted-history-task-id';
  let state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(sessionKey, [{
      role: 'user',
      id: 'idle-interrupted-history-task-user',
      timestamp: 5_210,
      content: 'Start a detached video task and restore this session later.',
    }, {
      role: 'assistant',
      id: 'idle-interrupted-history-task-call',
      timestamp: 5_211,
      content: [{
        type: 'toolCall',
        id: 'idle-interrupted-history-task-call-id',
        name: 'video_generate',
        arguments: { prompt: 'snow mountain' },
      }],
    }, {
      role: 'toolResult',
      toolCallId: 'idle-interrupted-history-task-call-id',
      toolName: 'video_generate',
      content: [{ type: 'text', text: 'render process disconnected' }],
      details: {
        async: true,
        status: 'started',
        taskId,
      },
      isError: false,
      timestamp: 5_212,
    }]),
  );
  const turnId = state.turnOrderBySession[sessionKey][0];
  let turn = state.turnsById[turnId];
  assert.equal(turn.status, 'running');
  assert.equal(turn.taskById[taskId]?.status, 'running');
  assert.equal(selectActiveTurn(state, sessionKey)?.id, turnId);
  assert.deepEqual(collectCancellableTasks(turn).taskIds, [taskId]);

  state = reduceConversationEvents(state, [{
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'idle-interrupted-history-task:backend-active',
    type: 'session.activity',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    occurredAt: 5_212_500,
    receivedAt: 5_212_500,
    replayed: false,
    data: { active: true },
  }]);
  turn = state.turnsById[turnId];
  assert.equal(turn.status, 'running');
  assert.equal(turn.taskById[taskId]?.status, 'running');
  assert.equal(selectActiveTurn(state, sessionKey)?.id, turnId);

  state = reduceConversationEvents(state, [{
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'idle-interrupted-history-task:backend-idle',
    type: 'session.activity',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    occurredAt: 5_213_000,
    receivedAt: 5_213_000,
    replayed: false,
    data: { active: false },
  }]);
  assertConversationState(state);
  turn = state.turnsById[turnId];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.taskById[taskId]?.status, 'error');
  assert.equal(turn.taskById[taskId]?.terminalOutcome, 'interrupted');
  assert.equal(turn.taskMergeById[taskId]?.source, 'synthetic');
  assert.equal(turn.taskMergeById[taskId]?.authority, 'inferred');
  assert.equal(selectActiveTurn(state, sessionKey), null);
  assert.equal(state.aliases.activeBySession[sessionKey], undefined);
  assert.deepEqual(collectCancellableTasks(turn).taskIds, []);

  state = reduceConversationEvents(state, runtime([{
    type: 'task.updated',
    runId: `${RUN_ID}:idle-interrupted-history-task`,
    sessionKey,
    taskId,
    seq: 1,
    ts: 5_214_000,
    producer: 'openclaw-task-ledger',
    task: {
      taskId,
      title: 'Recovered video task',
      status: 'completed',
      updatedAt: 5_214_000,
    },
  }]));
  assertConversationState(state);
  turn = state.turnsById[turnId];
  assert.equal(turn.taskById[taskId]?.status, 'completed');
  assert.equal(turn.taskById[taskId]?.sourceStatus, undefined);
  assert.equal(turn.taskById[taskId]?.terminalOutcome, undefined);
  assert.equal(turn.taskById[taskId]?.endedAt, undefined);
  assert.equal(turn.taskMergeById[taskId]?.source, 'task-ledger');
  assert.equal(turn.status, 'completed');
});

test('authoritative run completion weakly settles a history-only async task', () => {
  const sessionKey = `${SESSION_KEY}:terminal-history-task`;
  const runId = `${RUN_ID}:terminal-history-task`;
  const taskId = 'terminal-history-task-id';
  let state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(sessionKey, [{
      role: 'user',
      id: 'terminal-history-task-user',
      timestamp: 5_215,
      content: 'Start a task and finish the parent run.',
    }, {
      role: 'toolResult',
      toolCallId: 'terminal-history-task-call-id',
      toolName: 'video_generate',
      content: [{ type: 'text', text: 'task accepted' }],
      details: {
        async: true,
        status: 'started',
        taskId,
      },
      isError: false,
      timestamp: 5_216,
    }, {
      role: 'assistant',
      id: 'terminal-history-task-final',
      content: 'The parent run has finished.',
      timestamp: 5_217,
    }]),
  );
  const turnId = state.turnOrderBySession[sessionKey][0];
  assert.equal(state.turnsById[turnId].status, 'running');

  state = reduceConversationEvents(state, [{
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'terminal-history-task:run-completed',
    type: 'run.ended',
    source: 'openclaw-runtime',
    authority: 'authoritative',
    sessionKey,
    turnId,
    rootRunId: runId,
    runId,
    occurredAt: 5_218_000,
    receivedAt: 5_218_000,
    replayed: false,
    data: { status: 'completed', endedAt: 5_218_000 },
  }]);
  assertConversationState(state);
  const turn = state.turnsById[turnId];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.taskById[taskId]?.status, 'error');
  assert.equal(turn.taskById[taskId]?.terminalOutcome, 'interrupted');
  assert.equal(turn.taskMergeById[taskId]?.source, 'synthetic');
  assert.equal(turn.taskMergeById[taskId]?.authority, 'inferred');
  assert.equal(selectActiveTurn(state, sessionKey), null);
  assert.deepEqual(collectCancellableTasks(turn).taskIds, []);
});

test('backend idle does not terminate a pending task with native lifecycle evidence', () => {
  const sessionKey = `${SESSION_KEY}:idle-native-task`;
  const runId = `${RUN_ID}:idle-native-task`;
  const taskId = 'idle-native-task-id';
  let state = reduceConversationEvents(createEmptyConversationState(), runtime([{
    type: 'run.started',
    runId,
    sessionKey,
    seq: 1,
    ts: 5_220_000,
    producer: 'openclaw',
  }, {
    type: 'task.updated',
    runId,
    sessionKey,
    taskId,
    seq: 2,
    ts: 5_221_000,
    producer: 'openclaw-task-ledger',
    task: {
      taskId,
      title: 'Native detached task',
      status: 'running',
      sourceStatus: 'running',
      updatedAt: 5_221_000,
    },
  }]));
  const turnId = state.turnOrderBySession[sessionKey][0];

  state = reduceConversationEvents(state, [{
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'idle-native-task:backend-idle',
    type: 'session.activity',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    occurredAt: 5_222_000,
    receivedAt: 5_222_000,
    replayed: false,
    data: { active: false },
  }]);
  assertConversationState(state);
  const turn = state.turnsById[turnId];
  assert.equal(turn.taskById[taskId]?.status, 'running');
  assert.equal(turn.taskMergeById[taskId]?.source, 'task-ledger');
  assert.equal(turn.status, 'running');
  assert.equal(selectActiveTurn(state, sessionKey)?.id, turnId);
  assert.deepEqual(collectCancellableTasks(turn).taskIds, [taskId]);
});

test('run terminal waits for background tasks and only settles after final delivery evidence', () => {
  const events = runtime([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 1, ts: 1_000, producer: 'openclaw' },
    {
      type: 'task.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 2,
      ts: 1_001,
      producer: 'openclaw',
      taskId: 'video-task',
      task: { taskId: 'video-task', title: 'Generate video', status: 'running', updatedAt: 1_001 },
    },
    { type: 'run.ended', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 3, ts: 1_002, producer: 'openclaw', status: 'completed' },
  ]);
  let state = reduceConversationEvents(createEmptyConversationState(), events);
  const turnId = state.turnOrderBySession[SESSION_KEY][0];
  assert.equal(state.turnsById[turnId].status, 'running');
  assert.equal(state.turnsById[turnId].evidence.runTerminal, 'completed');
  assert.deepEqual(state.turnsById[turnId].evidence.terminalPendingTaskIds, ['video-task']);
  state = reduceConversationEvents(state, runtime([{
    type: 'task.updated',
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    seq: 4,
    ts: 1_003,
    producer: 'openclaw',
    taskId: 'video-task',
    task: {
      taskId: 'video-task',
      title: 'Generate video',
      status: 'completed',
      deliveryStatus: 'delivered',
      updatedAt: 1_003,
    },
  }]));
  assert.equal(state.turnsById[turnId].status, 'error');
  const finalEvents = chatEventToConversationEvents({
    state: 'final',
    sessionKey: SESSION_KEY,
    runId: RUN_ID,
    message: { role: 'assistant', id: 'video-final', timestamp: 1_004, content: 'Video ready.' },
  }, { sessionKey: SESSION_KEY, activeRunId: RUN_ID, turnId });
  const artifactEvents = runtime([{
    type: 'artifact.produced',
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    seq: 5,
    ts: 1_004,
    producer: 'openclaw',
    taskId: 'video-task',
    artifact: { id: 'video-output', title: 'video.mp4', filePath: '/tmp/video.mp4', mimeType: 'video/mp4' },
  }]);
  const checkpoint = historyMessagesToConversationEvents(SESSION_KEY, []).at(-1);
  assert.ok(checkpoint);
  state = reduceConversationEvents(state, [...artifactEvents, ...finalEvents, checkpoint]);
  assert.equal(state.turnsById[turnId].status, 'completed');
});

test('media completion keeps process text as commentary and reveals final only after the artifact', () => {
  const sessionKey = `${SESSION_KEY}:media-final-order`;
  const ownerRunId = `${RUN_ID}:media-final-order`;
  const taskId = 'media-final-order-task';
  let state = reduceConversationEvents(createEmptyConversationState(), runtime([{
    type: 'run.started',
    runId: ownerRunId,
    sessionKey,
    seq: 1,
    ts: 6_000,
    producer: 'openclaw',
  }, {
    type: 'task.updated',
    runId: ownerRunId,
    sessionKey,
    taskId,
    seq: 2,
    ts: 6_001,
    producer: 'openclaw',
    task: {
      taskId,
      title: 'Generate product image',
      runtime: 'image_generate',
      status: 'running',
      updatedAt: 6_001,
    },
  }]));
  const turnId = state.turnOrderBySession[sessionKey][0];

  state = reduceConversationEvents(state, chatEventToConversationEvents({
    state: 'final',
    sessionKey,
    runId: ownerRunId,
    message: {
      role: 'assistant',
      id: 'media-process-text',
      timestamp: 6_002,
      content: 'I will generate the image with clean product lighting.',
    },
  }, { sessionKey, activeRunId: ownerRunId, rootRunId: ownerRunId, turnId }));
  state = reduceConversationEvents(state, runtime([{
    type: 'run.ended',
    runId: ownerRunId,
    sessionKey,
    seq: 3,
    ts: 6_003,
    producer: 'openclaw',
    status: 'completed',
  }]));
  let turn = state.turnsById[turnId];
  assert.deepEqual(turn.items.filter((item) => item.kind === 'commentary').map((item) => item.text), [
    'I will generate the image with clean product lighting.',
  ]);
  assert.equal(turn.items.some((item) => item.kind === 'final-answer'), false);

  const completionRunId = `image_generate:${taskId}:ok`;
  const completionMediaEvents = runtimeEventToConversationEvents({
    type: 'assistant.delta',
    runId: completionRunId,
    rootRunId: ownerRunId,
    sessionKey,
    taskId,
    seq: 1,
    ts: 6_004,
    producer: 'openclaw',
    text: 'The blue coffee cup product photo is ready.',
    replace: true,
    phase: 'final',
    mediaUrls: ['/tmp/blue-coffee-cup.png'],
  });
  assert.deepEqual(completionMediaEvents.map((event) => event.type), ['artifact.updated']);
  assert.deepEqual(completionMediaEvents[0]?.data, {
    artifact: {
      id: completionMediaEvents[0]?.type === 'artifact.updated'
        ? completionMediaEvents[0].data.artifact.id
        : undefined,
      kind: 'image',
      title: 'blue-coffee-cup.png',
      filePath: '/tmp/blue-coffee-cup.png',
      mimeType: 'image/png',
      availability: 'available',
      taskId,
      source: 'gateway-media',
    },
  });
  state = reduceConversationEvents(state, completionMediaEvents);
  turn = state.turnsById[turnId];
  assert.deepEqual(turn.items.filter((item) => item.kind === 'commentary').map((item) => item.text), [
    'I will generate the image with clean product lighting.',
  ]);
  assert.equal(turn.items.some((item) => item.kind === 'final-answer'), false);

  state = reduceConversationEvents(state, chatEventToConversationEvents({
    state: 'final',
    sessionKey,
    runId: completionRunId,
    message: {
      role: 'assistant',
      id: 'media-completion-final',
      timestamp: 6_005,
      content: 'The blue coffee cup product photo is ready.',
    },
  }, { sessionKey, activeRunId: ownerRunId, rootRunId: ownerRunId, turnId }));
  turn = state.turnsById[turnId];
  assert.equal(turn.items.some((item) => item.kind === 'final-answer'), false);
  assert.equal(turn.deferredFinal?.runId, completionRunId);

  state = reduceConversationEvents(state, runtime([{
    type: 'task.updated',
    runId: ownerRunId,
    sessionKey,
    taskId,
    seq: 4,
    ts: 6_006,
    producer: 'openclaw-task-ledger',
    task: {
      taskId,
      title: 'Generate product image',
      runtime: 'image_generate',
      status: 'completed',
      deliveryStatus: 'delivered',
      updatedAt: 6_006,
    },
  }]));
  assertConversationState(state);
  turn = state.turnsById[turnId];
  const artifactIndex = turn.items.findIndex((item) => item.kind === 'artifact-group');
  const finalIndex = turn.items.findIndex((item) => item.kind === 'final-answer');
  assert.ok(artifactIndex >= 0);
  assert.ok(finalIndex > artifactIndex);
  assert.equal(turn.deferredFinal, undefined);
  assert.equal(turn.items[finalIndex].kind === 'final-answer'
    ? turn.items[finalIndex].message.content
    : undefined, 'The blue coffee cup product photo is ready.');
});

test('history projects a final message artifact before its final answer', () => {
  const sessionKey = `${SESSION_KEY}:history-media-final-order`;
  const events = historyMessagesToConversationEvents(sessionKey, [{
    role: 'user',
    id: 'history-media-user',
    timestamp: 7_000,
    content: 'Generate an image.',
  }, {
    role: 'assistant',
    id: 'history-media-final',
    timestamp: 7_001,
    content: 'The image is ready.',
    _attachedFiles: [{
      fileName: 'history-image.png',
      mimeType: 'image/png',
      fileSize: 128,
      filePath: '/tmp/history-image.png',
      availability: 'available',
      source: 'gateway-media',
      disposition: 'output-delivery',
    }],
  }]);
  const artifactIndex = events.findIndex((event) => event.type === 'artifact.updated');
  const finalIndex = events.findIndex((event) => event.type === 'final.message');

  assert.ok(artifactIndex >= 0);
  assert.ok(finalIndex > artifactIndex);
});

test('real async image and video transcripts keep process, media, then final order', () => {
  const sessionKey = `${SESSION_KEY}:real-media-transcript-order`;
  const mediaCases = [{
    prompt: 'Generate a person eating watermelon image.',
    processText: 'I will generate a natural summer lifestyle scene.',
    taskId: 'real-image-task',
    toolName: 'image_generate',
    fileName: 'watermelon.png',
    filePath: '/tmp/watermelon.png',
    mimeType: 'image/png',
    finalText: 'The image is ready.',
  }, {
    prompt: 'Turn the image into a four-second video.',
    processText: 'I will add natural motion and a gentle camera push.',
    taskId: 'real-video-task',
    toolName: 'video_generate',
    fileName: 'watermelon.mp4',
    filePath: '/tmp/watermelon.mp4',
    mimeType: 'video/mp4',
    finalText: 'The four-second video is ready.',
  }];

  const messages: RawMessage[] = mediaCases.flatMap((media, index) => {
    const timestamp = 9_000 + (index * 100);
    const toolCallId = `real-media-tool-${index}`;
    return [{
      role: 'user' as const,
      id: `real-media-user-${index}`,
      timestamp,
      content: media.prompt,
    }, {
      role: 'assistant' as const,
      id: `real-media-process-${index}`,
      timestamp: timestamp + 1,
      content: [{ type: 'text', text: media.processText }, {
        type: 'toolCall',
        id: toolCallId,
        name: media.toolName,
        arguments: { prompt: media.prompt },
      }],
    }, {
      role: 'toolresult' as const,
      id: `real-media-result-${index}`,
      timestamp: timestamp + 2,
      toolCallId,
      toolName: media.toolName,
      content: [{
        type: 'text',
        text: `Background task started for ${media.toolName} (${media.taskId}).`,
      }],
      details: {
        async: true,
        status: 'started',
        taskId: media.taskId,
        runId: `tool:${media.toolName}:${media.taskId}`,
      },
    }, {
      role: 'assistant' as const,
      id: `real-media-final-${index}`,
      timestamp: timestamp + 3,
      content: `${media.finalText}\n\nMEDIA:${media.filePath}`,
      _attachedFiles: [{
        fileName: media.fileName,
        mimeType: media.mimeType,
        fileSize: 128,
        filePath: media.filePath,
        availability: 'available' as const,
        source: 'message-ref' as const,
        disposition: 'output-delivery' as const,
      }],
    }];
  });

  const events = historyMessagesToConversationEvents(sessionKey, messages);
  const state = replaceSessionTurns(createEmptyConversationState(), sessionKey, events);
  const turns = (state.turnOrderBySession[sessionKey] ?? []).map((turnId) => state.turnsById[turnId]);

  assert.equal(turns.length, 2);
  turns.forEach((turn, index) => {
    assert.deepEqual(turn.items.map((item) => item.kind).filter((kind) => kind !== 'user-message' && kind !== 'thinking'), [
      'commentary',
      'subtask',
      'artifact-group',
      'final-answer',
    ]);
    const commentary = turn.items.find((item) => item.kind === 'commentary');
    const artifactIndex = turn.items.findIndex((item) => item.kind === 'artifact-group');
    const finalIndex = turn.items.findIndex((item) => item.kind === 'final-answer');
    assert.equal(commentary?.kind === 'commentary' ? commentary.text : undefined, mediaCases[index].processText);
    assert.ok(artifactIndex >= 0);
    assert.ok(finalIndex > artifactIndex);
  });
});

test('live reducer and history replacement preserve media timeline order when transport delivery is late', () => {
  const sessionKey = `${SESSION_KEY}:history-repairs-live-media-order`;
  const turnId = 'turn:history-repairs-live-media-order';
  const occurredAt = 8_000_000;
  const event = (
    source: ConversationEvent['source'],
    type: ConversationEvent['type'],
    offset: number,
    data: ConversationEvent['data'],
  ): ConversationEvent => ({
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: `${source}:${type}:${offset}`,
    type,
    source,
    authority: source === 'history' ? 'authoritative' : 'corroborating',
    sessionKey,
    turnId,
    runId: 'run:history-repairs-live-media-order',
    messageId: type === 'commentary.append'
      ? 'history-repairs-live-media-order:commentary'
      : type === 'final.message'
        ? 'history-repairs-live-media-order:final'
        : undefined,
    occurredAt: occurredAt + offset,
    receivedAt: occurredAt + offset,
    replayed: source === 'history',
    data,
  });
  const requestedData = {
    message: {
      role: 'user' as const,
      id: 'history-repairs-live-media-order:user',
      content: 'Generate media.',
    },
  };
  const commentaryData = { text: 'I will generate a natural scene.', replace: true };
  const artifactData = {
    artifact: {
      id: 'history-repairs-live-media-order:artifact',
      title: 'generated.mp4',
      filePath: '/tmp/generated.mp4',
      mimeType: 'video/mp4',
      availability: 'available' as const,
    },
  };
  const finalData = {
    message: {
      role: 'assistant' as const,
      id: 'history-repairs-live-media-order:final',
      content: 'The media is ready.',
    },
  };
  const liveEvents = [
    event('host', 'turn.requested', 0, requestedData),
    event('openclaw-chat', 'final.message', 3, finalData),
    event('openclaw-runtime', 'artifact.updated', 3, artifactData),
    // The preamble occurred first but its transport envelope arrived last.
    event('openclaw-runtime', 'commentary.append', 1, commentaryData),
  ];
  let state = reduceConversationEvents(createEmptyConversationState(), liveEvents);
  assert.deepEqual(state.turnsById[turnId].items.map((item) => item.kind), [
    'user-message',
    'commentary',
    'artifact-group',
    'final-answer',
  ]);

  const historyEvents = [
    event('history', 'turn.requested', 0, requestedData),
    event('history', 'commentary.append', 1, commentaryData),
    event('history', 'artifact.updated', 3, artifactData),
    event('history', 'final.message', 3, finalData),
  ];
  state = replaceSessionTurns(state, sessionKey, historyEvents);
  assertConversationState(state);
  assert.deepEqual(state.turnsById[turnId].items.map((item) => item.kind), [
    'user-message',
    'commentary',
    'artifact-group',
    'final-answer',
  ]);

  const repairedTurn = state.turnsById[turnId];
  const staleItems = [
    repairedTurn.items.find((item) => item.kind === 'user-message'),
    repairedTurn.items.find((item) => item.kind === 'final-answer'),
    repairedTurn.items.find((item) => item.kind === 'artifact-group'),
    repairedTurn.items.find((item) => item.kind === 'commentary'),
  ]
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map((item) => ({
      ...item,
      sourceEventIds: item.sourceEventIds.filter((eventId) => !eventId.startsWith('history:')),
    }));
  state = {
    ...state,
    turnsById: {
      ...state.turnsById,
      [turnId]: {
        ...repairedTurn,
        items: staleItems,
        itemIndex: Object.fromEntries(staleItems.map((item, index) => [item.id, index])),
      },
    },
  };
  state = replaceSessionTurns(state, sessionKey, historyEvents);
  assert.deepEqual(state.turnsById[turnId].items.map((item) => item.kind), [
    'user-message',
    'commentary',
    'artifact-group',
    'final-answer',
  ]);
});

test('history replacement reuses an identical sealed live commentary', () => {
  const sessionKey = `${SESSION_KEY}:history-reuses-sealed-commentary`;
  const turnId = 'turn:history-reuses-sealed-commentary';
  const liveEvents: ConversationEvent[] = [{
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'host:sealed-commentary:requested',
    type: 'turn.requested',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    turnId,
    occurredAt: 8_100_000,
    receivedAt: 8_100_000,
    data: {
      message: {
        role: 'user',
        id: 'sealed-commentary-user',
        content: 'Generate an image.',
      },
    },
  }, {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'openclaw-chat:sealed-commentary:live',
    type: 'assistant.content',
    source: 'openclaw-chat',
    authority: 'corroborating',
    sessionKey,
    turnId,
    occurredAt: 8_100_001,
    receivedAt: 8_100_001,
    data: { text: 'The image task was queued.', replace: true },
  }, {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'openclaw-runtime:sealed-commentary:artifact',
    type: 'artifact.updated',
    source: 'openclaw-runtime',
    authority: 'corroborating',
    sessionKey,
    turnId,
    occurredAt: 8_100_002,
    receivedAt: 8_100_002,
    data: {
      artifact: {
        id: 'sealed-commentary-artifact',
        title: 'sealed-commentary.png',
        filePath: '/tmp/sealed-commentary.png',
        mimeType: 'image/png',
        availability: 'available',
      },
    },
  }, {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'openclaw-chat:sealed-commentary:final',
    type: 'final.message',
    source: 'openclaw-chat',
    authority: 'authoritative',
    sessionKey,
    turnId,
    occurredAt: 8_100_003,
    receivedAt: 8_100_003,
    data: {
      message: {
        role: 'assistant',
        id: 'sealed-commentary-final',
        content: 'The image is ready.',
      },
    },
  }];
  let state = reduceConversationEvents(createEmptyConversationState(), liveEvents);
  const liveCommentary = state.turnsById[turnId].items.find((item) => item.kind === 'commentary');
  assert.ok(liveCommentary && liveCommentary.kind === 'commentary');
  assert.equal(liveCommentary.sealed, true);

  const historyEvents = historyMessagesToConversationEvents(sessionKey, [{
    role: 'user',
    id: 'sealed-commentary-user',
    timestamp: 8_100,
    content: 'Generate an image.',
  }, {
    role: 'assistant',
    id: 'sealed-commentary-history-process',
    timestamp: 8_100.001,
    content: [{
      type: 'text',
      text: 'The image task was queued.',
    }, {
      type: 'toolCall',
      id: 'sealed-commentary-tool',
      name: 'image_generate',
      arguments: { prompt: 'Generate an image.' },
    }],
  }, {
    role: 'assistant',
    id: 'sealed-commentary-history-final',
    timestamp: 8_100.003,
    content: 'The image is ready.\n\nMEDIA:/tmp/sealed-commentary.png',
    _attachedFiles: [{
      fileName: 'sealed-commentary.png',
      mimeType: 'image/png',
      fileSize: 128,
      filePath: '/tmp/sealed-commentary.png',
      availability: 'available',
      source: 'message-ref',
      disposition: 'output-delivery',
    }],
  }]);
  state = replaceSessionTurns(state, sessionKey, historyEvents);
  assertConversationState(state);
  const commentaries = state.turnsById[turnId].items.filter((item) => item.kind === 'commentary');
  assert.equal(commentaries.length, 1);
  assert.equal(commentaries[0].id, liveCommentary.id);
  assert.ok(commentaries[0].sourceEventIds.some((eventId) => eventId.startsWith('history:')));
});

test('chat tool payload promotes the first structured image task with owner lineage', () => {
  const sessionKey = `${SESSION_KEY}:derived-image-task`;
  const ownerRunId = `${RUN_ID}:derived-image-owner`;
  const events = chatEventToConversationEvents({
    state: 'delta',
    sessionKey,
    runId: ownerRunId,
    seq: 7,
    message: {
      role: 'toolresult',
      id: 'derived-image-tool-result',
      timestamp: 1_010,
      toolCallId: 'derived-image-tool-call',
      toolName: 'image_generate',
      content: 'Background task accepted.',
      details: {
        async: true,
        status: 'started',
        taskId: 'derived-image-task',
        runId: 'tool:image_generate:derived-image-task',
        parentTaskId: 'derived-media-parent',
        runtime: 'image_generate',
      },
    },
  }, {
    sessionKey,
    activeRunId: ownerRunId,
    rootRunId: ownerRunId,
    turnId: 'turn:derived-image-task',
  });

  assert.equal(events.length, 1);
  const taskEvent = events[0];
  assert.equal(taskEvent.type, 'task.updated');
  assert.equal(taskEvent.source, 'derived');
  assert.equal(taskEvent.authority, 'corroborating');
  assert.equal(taskEvent.sessionKey, sessionKey);
  assert.equal(taskEvent.rootRunId, ownerRunId);
  assert.equal(taskEvent.runId, 'tool:image_generate:derived-image-task');
  assert.equal(taskEvent.taskId, 'derived-image-task');
  assert.equal(taskEvent.parentTaskId, 'derived-media-parent');
  assert.equal(taskEvent.toolCallId, 'derived-image-tool-call');
  assert.deepEqual((taskEvent.data as { task: unknown }).task, {
    taskId: 'derived-image-task',
    parentTaskId: 'derived-media-parent',
    runtime: 'image_generate',
    title: 'image_generate',
    sessionKey,
    status: 'running',
    sourceStatus: 'started',
    updatedAt: 1_010_000,
  });
});

test('runtime tool payload promotes structured video completion after the tool fact', () => {
  const sessionKey = `${SESSION_KEY}:derived-video-task`;
  const ownerRunId = `${RUN_ID}:derived-video-owner`;
  const events = runtimeEventToConversationEvents({
    type: 'tool.completed',
    runId: ownerRunId,
    sessionKey,
    seq: 12,
    ts: 1_020,
    producer: 'openclaw',
    toolCallId: 'derived-video-tool-call',
    name: 'tool_call',
    result: {
      tool: { name: 'video_generate', label: 'Video Generation' },
      result: {
        details: {
          async: true,
          status: 'completed',
          taskId: 'derived-video-task',
          runId: 'tool:video_generate:derived-video-task',
          parentTaskId: 'derived-media-parent',
        },
      },
    },
  });

  assert.deepEqual(events.map((event) => event.type), ['tool.completed', 'task.updated']);
  const taskEvent = events[1];
  const task = (taskEvent.data as { task: { runtime?: string; status: string; sourceStatus?: string } }).task;
  assert.equal(taskEvent.source, 'derived');
  assert.equal(taskEvent.authority, 'corroborating');
  assert.equal(taskEvent.sessionKey, sessionKey);
  assert.equal(taskEvent.rootRunId, ownerRunId);
  assert.equal(taskEvent.runId, 'tool:video_generate:derived-video-task');
  assert.equal(taskEvent.taskId, 'derived-video-task');
  assert.equal(taskEvent.parentTaskId, 'derived-media-parent');
  assert.equal(taskEvent.toolCallId, 'derived-video-tool-call');
  assert.equal(task.runtime, 'video_generate');
  assert.equal(task.status, 'completed');
  assert.equal(task.sourceStatus, 'completed');
});

test('runtime tool payload preserves structured task cancellation as aborted', () => {
  const sessionKey = `${SESSION_KEY}:derived-cancelled-task`;
  const ownerRunId = `${RUN_ID}:derived-cancelled-owner`;
  const events = runtimeEventToConversationEvents({
    type: 'tool.completed',
    runId: ownerRunId,
    sessionKey,
    seq: 13,
    ts: 1_021,
    producer: 'openclaw',
    toolCallId: 'derived-cancelled-tool-call',
    name: 'tool_call',
    result: {
      tool: { name: 'video_generate', label: 'Video Generation' },
      result: {
        details: {
          async: true,
          status: 'cancelled',
          taskId: 'derived-cancelled-task',
          runId: 'tool:video_generate:derived-cancelled-task',
        },
      },
    },
  });

  const taskEvent = events.find((event) => event.type === 'task.updated');
  const task = (taskEvent?.data as { task?: { status?: string; sourceStatus?: string } })?.task;
  assert.equal(task?.status, 'aborted');
  assert.equal(task?.sourceStatus, 'cancelled');
});

test('diagnostic and evidence runtime facts do not synthesize async task lifecycle updates', () => {
  const sessionKey = `${SESSION_KEY}:task-evidence-boundary`;
  const runId = `${RUN_ID}:task-evidence-boundary`;
  const taskId = 'release-review';
  const startedAt = 1_025_000;
  const authoritativeTask: ChatRuntimeEvent = {
    type: 'task.updated',
    producer: 'openclaw',
    runId,
    sessionKey,
    taskId,
    task: {
      taskId,
      title: 'Review release evidence',
      status: 'running',
      updatedAt: startedAt + 1,
    },
    ts: startedAt + 1,
  };
  const companionFacts: ChatRuntimeEvent[] = [{
    type: 'run.step.updated',
    producer: 'uclaw-host-task',
    runId,
    sessionKey,
    taskId,
    timelineVisibility: 'diagnostics',
    step: {
      id: 'owned-diagnostics-step',
      title: 'Owned canonical diagnostics step',
      status: 'completed',
      taskId,
      toolCallId: 'owned-diagnostics-tool',
    },
    ts: startedAt + 2,
  }, {
    type: 'artifact.produced',
    producer: 'uclaw-host-task',
    runId,
    sessionKey,
    taskId,
    artifact: {
      id: 'release-review-artifact',
      title: 'Release review artifact',
      taskId,
      filePath: '/tmp/release-review.txt',
    },
    ts: startedAt + 3,
  }, {
    type: 'verification.completed',
    producer: 'uclaw-host-task',
    runId,
    sessionKey,
    taskId,
    verification: {
      id: 'release-review-verification',
      title: 'Release review verification',
      taskId,
      status: 'passed',
    },
    ts: startedAt + 4,
  }, {
    type: 'progress.update',
    producer: 'uclaw-host-task',
    runId,
    sessionKey,
    taskId,
    entry: {
      id: 'release-review-progress',
      kind: 'status',
      text: 'Release review evidence inspected.',
      status: 'completed',
      taskId,
    },
    ts: startedAt + 5,
  }];

  for (const fact of companionFacts) {
    const adapted = runtimeEventToConversationEvents(fact);
    assert.deepEqual(adapted.map((event) => event.type), [runtimeEventToConversationEvent(fact)?.type]);
    assert.equal(adapted.some((event) => event.type === 'task.updated'), false);
  }

  const events = [authoritativeTask, ...companionFacts]
    .flatMap(runtimeEventToConversationEvents);
  const state = reduceConversationEvents(createEmptyConversationState(), events);
  assertConversationState(state);
  const turnId = state.turnOrderBySession[sessionKey][0];
  const task = state.turnsById[turnId].taskById[taskId];
  assert.equal(task.title, 'Review release evidence');
  assert.equal(task.status, 'running');
});

test('async markers without taskId and task-like prose do not create canonical tasks', () => {
  const sessionKey = `${SESSION_KEY}:missing-derived-task-id`;
  const chatEvents = chatEventToConversationEvents({
    state: 'delta',
    sessionKey,
    runId: 'missing-derived-task-owner',
    message: {
      role: 'toolresult',
      id: 'missing-derived-task-result',
      timestamp: 1_030,
      toolCallId: 'missing-derived-task-tool-call',
      toolName: 'image_generate',
      content: 'taskId=fake-task /tmp/taskId-fake-output.png',
      details: { async: true, status: 'started', runId: 'tool:image_generate:missing-task' },
    },
  }, { sessionKey, activeRunId: 'missing-derived-task-owner' });
  assert.equal(chatEvents.some((event) => event.type === 'task.updated'), false);

  const runtimeEvents = runtimeEventToConversationEvents({
    type: 'tool.completed',
    runId: 'missing-derived-task-owner',
    sessionKey,
    toolCallId: 'missing-derived-runtime-tool-call',
    name: 'video_generate',
    result: { details: { async: true, status: 'started' } },
  });
  assert.equal(runtimeEvents.filter((event) => event.type === 'task.updated').length, 0);
});

test('history replay keeps structured background task projection idempotent', () => {
  const sessionKey = `${SESSION_KEY}:derived-task-history`;
  const taskId = 'derived-history-video-task';
  const messages: RawMessage[] = [{
    role: 'user',
    id: 'derived-history-user',
    timestamp: 1_040,
    content: 'Generate a background video.',
  }, {
    role: 'toolresult',
    id: 'derived-history-tool-result',
    timestamp: 1_041,
    toolCallId: 'derived-history-tool-call',
    toolName: 'video_generate',
    content: 'Background task started.',
    details: {
      async: true,
      status: 'started',
      taskId,
      runId: `tool:video_generate:${taskId}`,
      parentTaskId: 'derived-history-parent',
      runtime: 'video_generate',
    },
  }, {
    role: 'user',
    id: 'derived-history-completion',
    timestamp: 1_042,
    content: [{
      type: 'task_completion',
      taskId,
      runId: `tool:video_generate:${taskId}`,
      parentTaskId: 'derived-history-parent',
      runtime: 'video_generate',
      status: 'completed',
    }],
  }, {
    role: 'assistant',
    id: 'derived-history-final',
    timestamp: 1_043,
    content: 'Video generation completed.',
  }];

  const firstEvents = historyMessagesToConversationEvents(sessionKey, messages);
  const replayEvents = historyMessagesToConversationEvents(sessionKey, messages);
  const firstTaskEvents = firstEvents.filter((event) => event.type === 'task.updated');
  const replayTaskEvents = replayEvents.filter((event) => event.type === 'task.updated');
  assert.equal(firstTaskEvents.length, 2);
  assert.ok(firstTaskEvents.every((event) => event.source === 'history' && event.authority === 'corroborating'));
  assert.deepEqual(
    replayTaskEvents.map((event) => event.eventId),
    firstTaskEvents.map((event) => event.eventId),
  );

  const firstState = replaceSessionTurns(createEmptyConversationState(), sessionKey, firstEvents);
  const replayedState = replaceSessionTurns(firstState, sessionKey, replayEvents);
  assertConversationState(replayedState);
  const turn = replayedState.turnsById[replayedState.turnOrderBySession[sessionKey][0]];
  assert.deepEqual(turn.taskIds, [taskId]);
  assert.equal(turn.taskById[taskId].status, 'completed');
  assert.equal(turn.taskById[taskId].runtime, 'video_generate');
  assert.equal(turn.items.filter((item) => item.kind === 'subtask').length, 1);
});

test('authoritative run completion promotes runtime-only assistant content to one final answer', () => {
  const events = runtime([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 20, ts: 2_000, producer: 'openclaw' },
    {
      type: 'progress.update',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 21,
      ts: 2_001,
      producer: 'openclaw',
      entry: { id: 'progress-runtime-only', kind: 'commentary', text: 'Checking the runtime path.' },
    },
    {
      type: 'assistant.delta',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 22,
      ts: 2_002,
      producer: 'openclaw',
      text: 'This answer only arrived through runtime events.',
      replace: true,
    },
    { type: 'run.ended', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 23, ts: 2_003, producer: 'openclaw', status: 'completed' },
  ]);
  const state = reduceConversationEvents(createEmptyConversationState(), events);
  assertConversationState(state);
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  const finals = turn.items.filter((item) => item.kind === 'final-answer');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].message.content, 'This answer only arrived through runtime events.');
  assert.equal(turn.items.filter((item) => item.kind === 'commentary').length, 1);
  assert.equal(turn.status, 'completed');
});

test('chat final replaces only an identical assistant narrative after synthetic terminal ordering', () => {
  const initialEvents = runtime([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 24, ts: 2_100, producer: 'openclaw' },
    {
      type: 'progress.update',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 25,
      ts: 2_101,
      producer: 'openclaw',
      entry: { id: 'progress-before-final', kind: 'commentary', text: 'I am checking the final delivery.' },
    },
    {
      type: 'assistant.delta',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 26,
      ts: 2_102,
      producer: 'openclaw',
      text: 'The final delivery is ready.',
      replace: true,
    },
    {
      type: 'run.ended',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 27,
      ts: 2_103,
      producer: CHAT_SYNTHETIC_TERMINAL_PRODUCER,
      status: 'completed',
    },
  ]);
  let state = reduceConversationEvents(createEmptyConversationState(), initialEvents);
  const turnId = state.turnOrderBySession[SESSION_KEY][0];
  const finalEvents = chatEventToConversationEvents({
    state: 'final',
    sessionKey: SESSION_KEY,
    runId: RUN_ID,
    message: {
      role: 'assistant',
      id: 'chat-final-after-synthetic-terminal',
      timestamp: 2_104,
      content: 'The final delivery is ready.',
    },
  }, { sessionKey: SESSION_KEY, activeRunId: RUN_ID, turnId });
  state = reduceConversationEvents(state, finalEvents);
  assertConversationState(state);
  const turn = state.turnsById[turnId];
  assert.equal(turn.items.filter((item) => item.kind === 'final-answer').length, 1);
  const commentary = turn.items.filter((item) => item.kind === 'commentary');
  assert.equal(commentary.length, 1);
  assert.equal(commentary[0].text, 'I am checking the final delivery.');
});

test('history checkpoint cannot close a live final before lifecycle or backend idle', () => {
  const sessionKey = `${SESSION_KEY}:live-final-checkpoint`;
  const runId = `${RUN_ID}:live-final-checkpoint`;
  let state = reduceConversationEvents(createEmptyConversationState(), runtime([{
    type: 'run.started',
    runId,
    sessionKey,
    seq: 1,
    ts: 3_000,
    producer: 'openclaw',
  }]));
  const turnId = state.turnOrderBySession[sessionKey][0];
  state = reduceConversationEvents(state, chatEventToConversationEvents({
    state: 'final',
    sessionKey,
    runId,
    message: {
      role: 'assistant',
      id: 'live-final-before-checkpoint',
      timestamp: 3_001,
      content: 'Visible before lifecycle completion.',
    } satisfies RawMessage,
  }, { sessionKey, activeRunId: runId, turnId }));

  const checkpoint = historyMessagesToConversationEvents(sessionKey, []).at(-1);
  assert.ok(checkpoint);
  state = reduceConversationEvents(state, [checkpoint]);
  assert.equal(state.turnsById[turnId].status, 'running');
  assert.equal(state.turnsById[turnId].evidence.historyCheckpointed, false);

  const idleAt = 3_002_000;
  state = reduceConversationEvents(state, [{
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'live-final-checkpoint:idle',
    type: 'session.activity',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    turnId,
    rootRunId: runId,
    runId,
    occurredAt: idleAt,
    receivedAt: idleAt,
    replayed: false,
    data: { active: false },
  }]);
  assert.equal(state.turnsById[turnId].status, 'completed');
});

test('history-first live run reuses the latest owning Turn instead of creating an empty sibling', () => {
  const sessionKey = `${SESSION_KEY}:history-first-run`;
  const runId = `${RUN_ID}:history-first-run`;
  let state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(sessionKey, [{
      role: 'user',
      id: 'history-first-run-user',
      idempotencyKey: 'history-first-run-idempotency',
      timestamp: 4_000,
      content: 'Keep this Turn active while the backend run is still live.',
    }, {
      role: 'assistant',
      id: 'history-first-run-final',
      timestamp: 4_001,
      content: 'The visible answer arrived before lifecycle settlement.',
    }]),
  );
  const turnId = state.turnOrderBySession[sessionKey][0];
  assert.equal(state.turnsById[turnId].status, 'completed');

  state = reduceConversationEvents(state, runtime([{
    type: 'run.started',
    runId,
    sessionKey,
    seq: 1,
    ts: 4_002,
    producer: 'openclaw',
  }]));

  assert.deepEqual(state.turnOrderBySession[sessionKey], [turnId]);
  assert.equal(state.turnsById[turnId].status, 'running');
  assert.equal(state.turnsById[turnId].hasLiveEvidence, true);
  assert.equal(state.aliases.byRunId[createSessionAliasKey(sessionKey, runId)], turnId);
  assert.equal(state.turnsById[turnId].items.some((item) => item.kind === 'final-answer'), true);
});

test('run-scoped active liveness reuses checkpointed history and never creates an empty Turn', () => {
  const sessionKey = `${SESSION_KEY}:history-first-activity`;
  const runId = `${RUN_ID}:history-first-activity`;
  let state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(sessionKey, [{
      role: 'user',
      id: 'history-first-activity-user',
      idempotencyKey: 'history-first-activity-idempotency',
      timestamp: 5_000,
      content: 'Restore the active backend owner.',
    }, {
      role: 'assistant',
      id: 'history-first-activity-final',
      timestamp: 5_001,
      content: 'Visible while backend settlement is pending.',
    }]),
  );
  const turnId = state.turnOrderBySession[sessionKey][0];
  const activeAt = 5_002_000;
  state = reduceConversationEvents(state, [{
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'history-first-activity:active',
    type: 'session.activity',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    rootRunId: runId,
    runId,
    occurredAt: activeAt,
    receivedAt: activeAt,
    replayed: false,
    data: { active: true },
  }]);

  assert.deepEqual(state.turnOrderBySession[sessionKey], [turnId]);
  assert.equal(state.turnsById[turnId].status, 'running');
  assert.equal(state.aliases.byRunId[createSessionAliasKey(sessionKey, runId)], turnId);

  const ownerlessSession = `${sessionKey}:ownerless`;
  const ownerless = reduceConversationEvents(createEmptyConversationState(), [{
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'history-first-activity:ownerless',
    type: 'session.activity',
    source: 'host',
    authority: 'authoritative',
    sessionKey: ownerlessSession,
    rootRunId: `${runId}:ownerless`,
    runId: `${runId}:ownerless`,
    occurredAt: activeAt,
    receivedAt: activeAt,
    replayed: false,
    data: { active: true },
  }]);
  assert.deepEqual(ownerless.turnOrderBySession[ownerlessSession] ?? [], []);
  assert.equal(ownerless.quarantineBySession[ownerlessSession]?.records.length, 1);
});

test('session-scoped active liveness corrects only the latest checkpoint-completed history Turn', () => {
  const sessionKey = `${SESSION_KEY}:session-scoped-history-active`;
  let state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(sessionKey, [{
      role: 'user',
      id: 'session-scoped-history-active-user',
      idempotencyKey: 'session-scoped-history-active-idempotency',
      timestamp: 5_100,
      content: 'Restore this history Turn from backend activity.',
    }, {
      role: 'assistant',
      id: 'session-scoped-history-active-final',
      timestamp: 5_101,
      content: 'Visible answer awaiting backend settlement.',
    }]),
  );
  const turnId = state.turnOrderBySession[sessionKey][0];
  const activeAt = 5_102_000;
  state = reduceConversationEvents(state, [{
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'session-scoped-history-active:active',
    type: 'session.activity',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    occurredAt: activeAt,
    receivedAt: activeAt,
    replayed: false,
    data: { active: true },
  }]);

  assert.deepEqual(state.turnOrderBySession[sessionKey], [turnId]);
  assert.equal(state.turnsById[turnId].status, 'running');
  assert.equal(state.turnsById[turnId].hasLiveEvidence, true);
  assert.equal(state.aliases.activeBySession[sessionKey], turnId);
});

test('unknown run activity cannot reopen old history while another Turn is already active', () => {
  const sessionKey = `${SESSION_KEY}:active-turn-blocks-history-reopen`;
  const oldHistory = historyMessagesToConversationEvents(sessionKey, [{
    role: 'user',
    id: 'active-turn-blocks-history-reopen-old-user',
    idempotencyKey: 'active-turn-blocks-history-reopen-old-key',
    timestamp: 5_200,
    content: 'Old completed request.',
  }, {
    role: 'assistant',
    id: 'active-turn-blocks-history-reopen-old-final',
    timestamp: 5_201,
    content: 'Old completed answer.',
  }]);
  let state = reduceConversationEvents(createEmptyConversationState(), oldHistory);
  const oldTurnId = state.turnOrderBySession[sessionKey][0];
  const activeTurnId = createTurnId({
    sessionKey,
    idempotencyKey: 'active-turn-blocks-history-reopen-new-key',
  });
  const activeRunId = `${RUN_ID}:active-turn-blocks-history-reopen-current`;
  state = reduceConversationEvents(state, runtime([{
    type: 'run.started',
    runId: activeRunId,
    sessionKey,
    seq: 1,
    ts: 5_202,
    producer: 'openclaw',
  }]).map((event) => ({ ...event, turnId: activeTurnId })));

  const unknownRunId = `${RUN_ID}:active-turn-blocks-history-reopen-unknown`;
  const activeAt = 5_203_000;
  state = reduceConversationEvents(state, [{
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'active-turn-blocks-history-reopen:unknown-active',
    type: 'session.activity',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    rootRunId: unknownRunId,
    runId: unknownRunId,
    occurredAt: activeAt,
    receivedAt: activeAt,
    replayed: false,
    data: { active: true },
  }]);

  assert.equal(state.turnsById[oldTurnId].status, 'completed');
  assert.equal(state.turnsById[activeTurnId].status, 'running');
  assert.equal(state.aliases.byRunId[createSessionAliasKey(sessionKey, unknownRunId)], undefined);
  assert.equal(state.quarantineBySession[sessionKey]?.records.at(-1)?.runId, unknownRunId);
});

test('authoritative run terminal cannot be reopened by later active liveness', () => {
  const sessionKey = `${SESSION_KEY}:terminal-stays-closed`;
  const runId = `${RUN_ID}:terminal-stays-closed`;
  let state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(sessionKey, [{
      role: 'user',
      id: 'terminal-stays-closed-user',
      idempotencyKey: 'terminal-stays-closed-idempotency',
      timestamp: 6_000,
      content: 'Keep native completion authoritative.',
    }, {
      role: 'assistant',
      id: 'terminal-stays-closed-final',
      timestamp: 6_001,
      content: 'Completed answer.',
    }]),
  );
  const turnId = state.turnOrderBySession[sessionKey][0];
  const terminal = runtimeEventToConversationEvent({
    type: 'run.ended',
    runId,
    sessionKey,
    seq: 1,
    ts: 6_002,
    producer: 'openclaw',
    status: 'completed',
  });
  assert.ok(terminal);
  state = reduceConversationEvents(state, [{ ...terminal, turnId }]);

  const activeAt = 6_003_000;
  state = reduceConversationEvents(state, [{
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'terminal-stays-closed:active',
    type: 'session.activity',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    rootRunId: runId,
    runId,
    occurredAt: activeAt,
    receivedAt: activeAt,
    replayed: false,
    data: { active: true },
  }]);

  assert.deepEqual(state.turnOrderBySession[sessionKey], [turnId]);
  assert.equal(state.turnsById[turnId].status, 'completed');
  assert.equal(state.turnsById[turnId].evidence.runTerminal, 'completed');
});

test('terminal approvals ignore replayed pending state and accept stronger terminal correction', () => {
  const events = runtime([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 40, ts: 4_000, producer: 'openclaw' },
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 41,
      ts: 4_001,
      producer: 'history',
      itemId: 'approval-monotonic',
      status: 'approved',
    },
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 42,
      ts: 4_002,
      producer: 'openclaw',
      itemId: 'approval-monotonic',
      status: 'rejected',
    },
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 43,
      ts: 4_003,
      producer: 'history',
      itemId: 'approval-monotonic',
      status: 'pending',
    },
  ]);
  const state = reduceConversationEvents(createEmptyConversationState(), events);
  assertConversationState(state);
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  const approvals = turn.items.filter((item) => item.kind === 'approval');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, 'error');
  assert.equal(approvals[0].approvalStatus, 'rejected');
  assert.equal(turn.evidence.pendingApprovalCount, 0);
});

test('native terminal approval decision cannot be overwritten by lower-authority history', () => {
  const approvalId = 'approval-native-decision';
  const state = reduceConversationEvents(createEmptyConversationState(), runtime([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 44, ts: 4_100, producer: 'openclaw' },
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 45,
      ts: 4_101,
      producer: 'openclaw',
      approvalId,
      approvalKind: 'exec',
      decision: 'allow-once',
      itemId: approvalId,
      phase: 'resolved',
      status: 'allow-once',
    },
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 46,
      ts: 4_102,
      producer: 'history',
      approvalId,
      approvalKind: 'exec',
      decision: 'allow-always',
      itemId: approvalId,
      title: 'History-only approval title',
      phase: 'resolved',
      status: 'allow-always',
    },
  ]));
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  const approval = turn.items.find((item) => item.kind === 'approval');
  assert.ok(approval && approval.kind === 'approval');
  assert.equal(approval.decision, 'allow-once');
  assert.equal(approval.title, 'History-only approval title');
  assert.equal(approval.source, 'openclaw-runtime');
  assert.equal(approval.authority, 'authoritative');
  assert.equal(approval.sourceEventIds.length, 2);
});

test('history terminal closes a native pending approval without downgrading native request fields', () => {
  const approvalId = 'approval-history-terminal';
  const state = reduceConversationEvents(createEmptyConversationState(), runtime([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 47, ts: 4_200, producer: 'openclaw' },
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 48,
      ts: 4_201,
      producer: 'openclaw',
      approvalId,
      approvalKind: 'exec',
      allowedDecisions: ['allow-once', 'deny'],
      actionable: true,
      request: { command: 'pwd' },
      itemId: approvalId,
      phase: 'requested',
      status: 'pending',
    },
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 49,
      ts: 4_202,
      producer: 'history',
      approvalId,
      approvalKind: 'exec',
      decision: 'allow-once',
      itemId: approvalId,
      phase: 'resolved',
      status: 'allow-once',
    },
  ]));
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  const approval = turn.items.find((item) => item.kind === 'approval');
  assert.ok(approval && approval.kind === 'approval');
  assert.equal(approval.status, 'completed');
  assert.equal(approval.decision, 'allow-once');
  assert.deepEqual(approval.request, { command: 'pwd' });
  assert.equal(approval.actionable, false);
});

test('structured approval requests resolve through the closed decision set or expire', () => {
  const cases: Array<{
    name: string;
    decision?: 'allow-once' | 'allow-always' | 'deny';
    status: string;
    expectedStatus: 'completed' | 'error';
  }> = [
    { name: 'allow-once', decision: 'allow-once', status: 'allow-once', expectedStatus: 'completed' },
    { name: 'allow-always', decision: 'allow-always', status: 'allow-always', expectedStatus: 'completed' },
    { name: 'deny', decision: 'deny', status: 'deny', expectedStatus: 'error' },
    { name: 'expired', status: 'expired', expectedStatus: 'error' },
  ];

  for (const approvalCase of cases) {
    const sessionKey = `${SESSION_KEY}:${approvalCase.name}`;
    const runId = `${RUN_ID}:${approvalCase.name}`;
    const approvalId = `approval-${approvalCase.name}`;
    let state = reduceConversationEvents(createEmptyConversationState(), runtime([
      { type: 'run.started', runId, sessionKey, seq: 1, ts: 10_000, producer: 'openclaw' },
      {
        type: 'approval.updated',
        runId,
        sessionKey,
        seq: 2,
        ts: 10_001,
        producer: 'openclaw',
        approvalId,
        approvalKind: 'exec',
        allowedDecisions: ['allow-once', 'allow-always', 'deny'],
        actionable: true,
        requestedAt: 10_001,
        expiresAt: 20_000,
        itemId: approvalId,
        phase: 'requested',
        status: 'pending',
      },
    ]));
    const turnId = state.turnOrderBySession[sessionKey][0];
    let approval = state.turnsById[turnId].items.find((item) => item.kind === 'approval');
    assert.ok(approval && approval.kind === 'approval');
    assert.equal(state.turnsById[turnId].status, 'waiting_approval');
    assert.equal(approval.actionable, true);
    assert.deepEqual(approval.allowedDecisions, ['allow-once', 'allow-always', 'deny']);

    state = reduceConversationEvents(state, runtime([{
      type: 'approval.updated',
      runId,
      sessionKey,
      seq: 3,
      ts: 10_002,
      producer: approvalCase.name === 'expired' ? 'gateway-approval-expiry' : 'openclaw',
      approvalId,
      approvalKind: 'exec',
      decision: approvalCase.decision,
      actionable: false,
      resolutionSource: 'gateway',
      itemId: approvalId,
      phase: 'resolved',
      status: approvalCase.status,
    }]));
    approval = state.turnsById[turnId].items.find((item) => item.kind === 'approval');
    assert.ok(approval && approval.kind === 'approval');
    assert.equal(state.turnsById[turnId].status, 'running');
    assert.equal(approval.status, approvalCase.expectedStatus);
    assert.equal(approval.decision, approvalCase.decision);
    assert.equal(approval.actionable, false);
  }
});

test('terminal desktop broker denial closes a turn after the waiting reply', () => {
  const sessionKey = `${SESSION_KEY}:desktop-denied`;
  const runId = `${RUN_ID}:desktop-denied`;
  const approvalId = 'approval-desktop-denied';
  let state = reduceConversationEvents(createEmptyConversationState(), runtime([
    { type: 'run.started', runId, sessionKey, seq: 1, ts: 11_000, producer: 'openclaw' },
    {
      type: 'approval.updated',
      runId,
      sessionKey,
      seq: 2,
      ts: 11_001,
      producer: 'uclaw-desktop-approval',
      approvalId,
      approvalKind: 'desktop',
      allowedDecisions: ['allow-once', 'deny'],
      actionable: true,
      resolutionSource: 'desktop-broker',
      itemId: approvalId,
      phase: 'requested',
      status: 'pending',
    },
  ]));
  const turnId = state.turnOrderBySession[sessionKey][0];
  const context = createChatEventContext({
    sessionKey,
    currentSessionKey: sessionKey,
    activeRunId: runId,
  });
  state = reduceConversationEvents(state, chatEventToConversationEvents({
    state: 'final',
    sessionKey,
    runId,
    seq: 3,
    message: {
      role: 'assistant',
      id: 'desktop-denied-waiting-final',
      timestamp: 11.002,
      content: 'Waiting for approval.',
    } satisfies RawMessage,
  }, context));
  assert.equal(state.turnsById[turnId].status, 'waiting_approval');

  state = reduceConversationEvents(state, runtime([{
    type: 'run.ended',
    runId,
    sessionKey,
    seq: 4,
    ts: 11_002.5,
    producer: 'openclaw',
    status: 'completed',
  }]));
  let pendingApproval = state.turnsById[turnId].items.find((item) => item.kind === 'approval');
  assert.ok(pendingApproval && pendingApproval.kind === 'approval');
  assert.equal(state.turnsById[turnId].status, 'waiting_approval');
  assert.equal(pendingApproval.status, 'blocked');
  assert.equal(pendingApproval.actionable, true);

  state = reduceConversationEvents(state, runtime([{
    type: 'approval.updated',
    runId,
    sessionKey,
    seq: 5,
    ts: 11_003,
    producer: 'uclaw-desktop-approval',
    approvalId,
    approvalKind: 'desktop',
    decision: 'deny',
    actionable: false,
    resolutionSource: 'desktop-broker',
    itemId: approvalId,
    phase: 'resolved',
    status: 'denied',
  }]));

  const turn = state.turnsById[turnId];
  const approval = turn.items.find((item) => item.kind === 'approval');
  assert.ok(approval && approval.kind === 'approval');
  assert.equal(turn.status, 'completed');
  assert.equal(turn.evidence.pendingApprovalCount, 0);
  assert.equal(approval.status, 'error');
  assert.equal(approval.approvalStatus, 'denied');
  assert.equal(approval.actionable, false);
  assert.equal(state.aliases.activeBySession[sessionKey], undefined);
  assert.equal(selectActiveTurn(state, sessionKey), null);
});

test('history checkpoint cancels a non-actionable stale approval after restart', () => {
  const sessionKey = `${SESSION_KEY}:history-stale-approval`;
  const messages: RawMessage[] = [{
    role: 'user',
    id: 'history-stale-approval-user',
    timestamp: 12,
    content: 'Request a desktop action.',
  }, {
    role: 'assistant',
    id: 'history-stale-approval-final',
    timestamp: 12.002,
    content: 'Waiting for approval.',
  }];
  const historyEvents = historyMessagesToConversationEvents(sessionKey, messages);
  const checkpointIndex = historyEvents.findIndex((event) => event.type === 'history.checkpoint');
  assert.notEqual(checkpointIndex, -1);
  const turnId = historyEvents.find((event) => event.type === 'turn.requested')?.turnId;
  assert.ok(turnId);
  const approvalAt = 12_001;
  const approvalEvent: ConversationEvent = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'history-stale-approval:pending',
    type: 'approval.updated',
    source: 'history',
    authority: 'corroborating',
    sessionKey,
    turnId,
    occurredAt: approvalAt,
    receivedAt: approvalAt,
    replayed: true,
    data: {
      approvalId: 'history-stale-approval',
      approvalKind: 'desktop',
      actionable: false,
      itemId: 'history-stale-approval',
      phase: 'requested',
      status: 'pending',
    },
  };
  const state = reduceConversationEvents(createEmptyConversationState(), [
    ...historyEvents.slice(0, checkpointIndex),
    approvalEvent,
    ...historyEvents.slice(checkpointIndex),
  ]);

  const turn = state.turnsById[turnId];
  const approval = turn.items.find((item) => item.kind === 'approval');
  assert.ok(approval && approval.kind === 'approval');
  assert.equal(turn.status, 'completed');
  assert.equal(turn.evidence.pendingApprovalCount, 0);
  assert.equal(approval.status, 'error');
  assert.equal(approval.approvalStatus, 'cancelled');
  assert.equal(approval.resolutionSource, 'history-checkpoint');
  assert.equal(state.aliases.activeBySession[sessionKey], undefined);
  assert.equal(selectActiveTurn(state, sessionKey), null);
});

test('completed run keeps an actionable native approval pending until resolution', () => {
  const approvalId = 'late-native-approval';
  const sessionKey = `${SESSION_KEY}:late-native-approval`;
  const runId = `${RUN_ID}:late-native-approval`;
  let state = reduceConversationEvents(createEmptyConversationState(), runtime([
    { type: 'run.started', runId, sessionKey, seq: 1, ts: 20_000, producer: 'openclaw' },
    {
      type: 'approval.updated',
      runId,
      sessionKey,
      seq: 2,
      ts: 20_001,
      producer: 'openclaw',
      approvalId,
      approvalKind: 'exec',
      allowedDecisions: ['allow-once', 'deny'],
      actionable: true,
      itemId: approvalId,
      phase: 'requested',
      status: 'pending',
    },
    { type: 'run.ended', runId, sessionKey, seq: 3, ts: 20_002, producer: 'openclaw', status: 'completed' },
  ]));
  const turnId = state.turnOrderBySession[sessionKey][0];
  let approval = state.turnsById[turnId].items.find((item) => item.kind === 'approval');
  assert.ok(approval && approval.kind === 'approval');
  assert.equal(state.turnsById[turnId].status, 'waiting_approval');
  assert.equal(approval.resolutionSource, undefined);
  assert.equal(approval.status, 'blocked');
  assert.equal(approval.actionable, true);

  state = reduceConversationEvents(state, runtime([{
    type: 'approval.updated',
    runId,
    sessionKey,
    seq: 4,
    ts: 20_003,
    producer: 'openclaw',
    approvalId,
    approvalKind: 'exec',
    decision: 'allow-once',
    actionable: false,
    resolutionSource: 'gateway',
    itemId: approvalId,
    phase: 'resolved',
    status: 'allow-once',
  }]));
  approval = state.turnsById[turnId].items.find((item) => item.kind === 'approval');
  assert.ok(approval && approval.kind === 'approval');
  assert.equal(approval.status, 'completed');
  assert.equal(approval.decision, 'allow-once');
  assert.equal(approval.resolutionSource, 'gateway');
});

test('task-only approval fallback closes on task transition without inventing a decision', () => {
  const taskId = 'task-fallback-approval';
  const approvalId = `${taskId}:approval`;
  const state = reduceConversationEvents(createEmptyConversationState(), runtime([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 70, ts: 7_000, producer: 'openclaw' },
    {
      type: 'task.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 71,
      ts: 7_001,
      producer: 'openclaw',
      taskId,
      task: { taskId, title: 'Fallback approval task', status: 'waiting_approval', updatedAt: 7_001 },
    },
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 71,
      ts: 7_001,
      producer: 'openclaw',
      taskId,
      approvalId,
      approvalKind: 'task',
      allowedDecisions: [],
      actionable: false,
      itemId: approvalId,
      phase: 'requested',
      status: 'pending',
    },
    {
      type: 'task.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 72,
      ts: 7_002,
      producer: 'openclaw',
      taskId,
      task: { taskId, title: 'Fallback approval task', status: 'running', updatedAt: 7_002 },
    },
  ]));
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  const approval = turn.items.find((item) => item.kind === 'approval');
  assert.ok(approval && approval.kind === 'approval');
  assert.equal(approval.status, 'completed');
  assert.equal(approval.decision, undefined);
  assert.equal(approval.actionable, false);
  assert.equal(approval.source, 'derived');
  assert.equal(approval.authority, 'corroborating');
  assert.equal(approval.resolutionSource, 'task-state-transition');
});

test('task-only approval fallback becomes stopped when its task is aborted', () => {
  const taskId = 'task-aborted-fallback-approval';
  const approvalId = `${taskId}:approval`;
  const state = reduceConversationEvents(createEmptyConversationState(), runtime([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 73, ts: 7_100, producer: 'openclaw' },
    {
      type: 'task.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 74,
      ts: 7_101,
      producer: 'openclaw',
      taskId,
      task: { taskId, title: 'Abort fallback approval', status: 'waiting_approval', updatedAt: 7_101 },
    },
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 74,
      ts: 7_101,
      producer: 'openclaw',
      taskId,
      approvalId,
      approvalKind: 'task',
      allowedDecisions: [],
      actionable: false,
      itemId: approvalId,
      phase: 'requested',
      status: 'pending',
    },
    {
      type: 'task.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 75,
      ts: 7_102,
      producer: 'openclaw',
      taskId,
      task: { taskId, title: 'Abort fallback approval', status: 'aborted', updatedAt: 7_102 },
    },
  ]));
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  const approval = turn.items.find((item) => item.kind === 'approval');
  assert.ok(approval && approval.kind === 'approval');
  assert.equal(approval.status, 'aborted');
  assert.equal(approval.approvalStatus, 'cancelled');
  assert.equal(approval.decision, undefined);
  assert.equal(approval.actionable, false);
});

test('explicit resolved approval replaces the unique pending task fallback for the same task', () => {
  const sessionKey = `${SESSION_KEY}:task-approval-alias`;
  const runId = `${RUN_ID}:task-approval-alias`;
  const taskId = 'task-approval-alias';
  const fallbackApprovalId = `task:${taskId}:approval`;
  const explicitApprovalId = taskId;
  const state = reduceConversationEvents(createEmptyConversationState(), runtime([
    { type: 'run.started', runId, sessionKey, seq: 1, ts: 7_100, producer: 'openclaw' },
    {
      type: 'task.updated',
      runId,
      sessionKey,
      seq: 2,
      ts: 7_101,
      producer: 'openclaw',
      taskId,
      task: { taskId, title: 'Publish release notes', status: 'waiting_approval', updatedAt: 7_101 },
    },
    {
      type: 'approval.updated',
      runId,
      sessionKey,
      seq: 2,
      ts: 7_101,
      producer: 'openclaw',
      taskId,
      approvalId: fallbackApprovalId,
      approvalKind: 'task',
      allowedDecisions: [],
      actionable: false,
      itemId: fallbackApprovalId,
      title: 'Publish release notes',
      kind: 'external_action',
      phase: 'pending',
      status: 'pending',
    },
    {
      type: 'approval.updated',
      runId,
      sessionKey,
      seq: 3,
      ts: 7_102,
      producer: 'openclaw',
      taskId,
      approvalId: explicitApprovalId,
      itemId: explicitApprovalId,
      title: 'Publish release notes',
      kind: 'external_action',
      phase: 'resolved',
      status: 'approved',
      message: 'Approved in UClaw.',
    },
  ]));
  assertConversationState(state);
  const turn = state.turnsById[state.turnOrderBySession[sessionKey][0]];
  const approvals = turn.items.filter((item) => item.kind === 'approval');
  assert.equal(approvals.length, 1);
  const approval = approvals[0];
  assert.equal(approval.id, `approval:${explicitApprovalId}`);
  assert.equal(approval.approvalId, explicitApprovalId);
  assert.equal(approval.itemId, explicitApprovalId);
  assert.equal(approval.taskId, taskId);
  assert.equal(approval.status, 'completed');
  assert.equal(approval.approvalStatus, 'approved');
  assert.equal(approval.source, 'openclaw-runtime');
  assert.equal(approval.authority, 'authoritative');
  assert.deepEqual(approval.sourceEventIds.length, 2);
  assert.equal(turn.approvalMergeById[`approval:${fallbackApprovalId}`], undefined);
  assert.ok(turn.approvalMergeById[`approval:${explicitApprovalId}`]);
});

test('task approval alias convergence rejects ambiguity, cross-task identity, and history terminals', () => {
  const ambiguousSession = `${SESSION_KEY}:task-approval-alias-ambiguous`;
  const ambiguousRun = `${RUN_ID}:task-approval-alias-ambiguous`;
  const ambiguousTaskId = 'task-approval-alias-ambiguous';
  const ambiguous = reduceConversationEvents(createEmptyConversationState(), runtime([
    { type: 'run.started', runId: ambiguousRun, sessionKey: ambiguousSession, seq: 1, ts: 7_200, producer: 'openclaw' },
    ...['first', 'second'].map((suffix, index) => ({
      type: 'approval.updated' as const,
      runId: ambiguousRun,
      sessionKey: ambiguousSession,
      seq: index + 2,
      ts: 7_201 + index,
      producer: 'openclaw',
      taskId: ambiguousTaskId,
      approvalId: `task:${ambiguousTaskId}:approval:${suffix}`,
      approvalKind: 'task' as const,
      allowedDecisions: [],
      actionable: false,
      itemId: `task:${ambiguousTaskId}:approval:${suffix}`,
      title: 'Approve ambiguous task',
      phase: 'pending',
      status: 'pending',
    })),
    {
      type: 'approval.updated',
      runId: ambiguousRun,
      sessionKey: ambiguousSession,
      seq: 4,
      ts: 7_203,
      producer: 'openclaw',
      taskId: ambiguousTaskId,
      approvalId: 'explicit-ambiguous-approval',
      itemId: 'explicit-ambiguous-approval',
      title: 'Approve ambiguous task',
      phase: 'resolved',
      status: 'approved',
    },
  ]));
  assertConversationState(ambiguous);
  const ambiguousTurn = ambiguous.turnsById[ambiguous.turnOrderBySession[ambiguousSession][0]];
  assert.equal(ambiguousTurn.items.filter((item) => item.kind === 'approval').length, 3);

  const crossTaskSession = `${SESSION_KEY}:task-approval-alias-cross-task`;
  const crossTaskRun = `${RUN_ID}:task-approval-alias-cross-task`;
  const fallbackTaskId = 'task-approval-alias-owner';
  const explicitTaskId = 'task-approval-alias-other';
  const crossTask = reduceConversationEvents(createEmptyConversationState(), runtime([
    { type: 'run.started', runId: crossTaskRun, sessionKey: crossTaskSession, seq: 1, ts: 7_300, producer: 'openclaw' },
    {
      type: 'approval.updated',
      runId: crossTaskRun,
      sessionKey: crossTaskSession,
      seq: 2,
      ts: 7_301,
      producer: 'openclaw',
      taskId: fallbackTaskId,
      approvalId: `task:${fallbackTaskId}:approval`,
      approvalKind: 'task',
      allowedDecisions: [],
      actionable: false,
      itemId: `task:${fallbackTaskId}:approval`,
      title: 'Same visible approval title',
      phase: 'pending',
      status: 'pending',
    },
    {
      type: 'approval.updated',
      runId: crossTaskRun,
      sessionKey: crossTaskSession,
      seq: 3,
      ts: 7_302,
      producer: 'history',
      taskId: fallbackTaskId,
      approvalId: 'history-terminal-approval',
      itemId: 'history-terminal-approval',
      title: 'Same visible approval title',
      phase: 'resolved',
      status: 'approved',
    },
    {
      type: 'approval.updated',
      runId: crossTaskRun,
      sessionKey: crossTaskSession,
      seq: 4,
      ts: 7_303,
      producer: 'openclaw',
      taskId: explicitTaskId,
      approvalId: 'cross-task-terminal-approval',
      itemId: 'cross-task-terminal-approval',
      title: 'Same visible approval title',
      phase: 'resolved',
      status: 'approved',
    },
  ]));
  assertConversationState(crossTask);
  const crossTaskTurn = crossTask.turnsById[crossTask.turnOrderBySession[crossTaskSession][0]];
  const crossTaskApprovals = crossTaskTurn.items.filter((item) => item.kind === 'approval');
  assert.equal(crossTaskApprovals.length, 3);
  assert.equal(crossTaskApprovals.filter((item) => item.status === 'blocked').length, 1);
  assert.equal(crossTaskApprovals.some((item) => item.approvalId === `task:${fallbackTaskId}:approval`), true);
});

test('approval aliases without native run ids stay scoped to their explicit session', () => {
  const sessionA = `${SESSION_KEY}:approval-a`;
  const sessionB = `${SESSION_KEY}:approval-b`;
  const approvalA = 'missing-run-approval-a';
  const approvalB = 'missing-run-approval-b';
  let state = reduceConversationEvents(createEmptyConversationState(), runtime([
    { type: 'run.started', runId: 'active-run-a', sessionKey: sessionA, seq: 1, ts: 8_000, producer: 'openclaw' },
    { type: 'run.started', runId: 'active-run-b', sessionKey: sessionB, seq: 1, ts: 8_000, producer: 'openclaw' },
    {
      type: 'approval.updated',
      runId: `approval:exec:${approvalA}`,
      sessionKey: sessionA,
      ts: 8_001,
      producer: 'openclaw',
      approvalId: approvalA,
      approvalKind: 'exec',
      allowedDecisions: ['allow-once', 'allow-always', 'deny'],
      actionable: true,
      itemId: approvalA,
      phase: 'requested',
      status: 'pending',
    },
    {
      type: 'approval.updated',
      runId: `approval:exec:${approvalB}`,
      sessionKey: sessionB,
      ts: 8_001,
      producer: 'openclaw',
      approvalId: approvalB,
      approvalKind: 'exec',
      allowedDecisions: ['allow-once', 'allow-always', 'deny'],
      actionable: true,
      itemId: approvalB,
      phase: 'requested',
      status: 'pending',
    },
  ]));
  state = reduceConversationEvents(state, runtime([{
    type: 'approval.updated',
    runId: `approval:exec:${approvalA}`,
    sessionKey: sessionA,
    ts: 8_002,
    producer: 'openclaw',
    approvalId: approvalA,
    approvalKind: 'exec',
    decision: 'allow-once',
    actionable: false,
    itemId: approvalA,
    phase: 'resolved',
    status: 'allow-once',
  }]));

  const turnA = state.turnsById[state.turnOrderBySession[sessionA][0]];
  const turnB = state.turnsById[state.turnOrderBySession[sessionB][0]];
  const itemA = turnA.items.find((item) => item.kind === 'approval');
  const itemB = turnB.items.find((item) => item.kind === 'approval');
  assert.ok(itemA && itemA.kind === 'approval');
  assert.ok(itemB && itemB.kind === 'approval');
  assert.equal(itemA.approvalId, approvalA);
  assert.equal(itemA.decision, 'allow-once');
  assert.equal(itemB.approvalId, approvalB);
  assert.equal(itemB.status, 'blocked');
  assert.equal(turnA.items.some((item) => item.kind === 'approval' && item.approvalId === approvalB), false);
  assert.equal(turnB.items.some((item) => item.kind === 'approval' && item.approvalId === approvalA), false);
});

test('legacy and task-only approval rows cannot expose user actions', () => {
  const state = reduceConversationEvents(createEmptyConversationState(), runtime([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 80, ts: 9_000, producer: 'openclaw' },
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 81,
      ts: 9_001,
      producer: 'openclaw',
      itemId: 'legacy-actionable-approval',
      allowedDecisions: ['allow-once', 'deny'],
      actionable: true,
      status: 'pending',
    },
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 82,
      ts: 9_002,
      producer: 'openclaw',
      approvalId: 'task-actionable-approval',
      approvalKind: 'task',
      itemId: 'task-actionable-approval',
      allowedDecisions: ['allow-once', 'deny'],
      actionable: true,
      status: 'pending',
    },
  ]));
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  const approvals = turn.items.filter((item) => item.kind === 'approval');
  assert.equal(approvals.length, 2);
  assert.equal(approvals.every((approval) => approval.actionable === false), true);
});

test('authoritative terminal locks the turn against late pending tool, task, and approval events', () => {
  const baseTime = 1_700_000_100_000;
  const terminalEvents = runtime([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 50, ts: baseTime, producer: 'openclaw' },
    {
      type: 'tool.started',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 51,
      ts: baseTime + 1,
      producer: 'openclaw',
      toolCallId: 'terminal-owned-tool',
      name: 'exec',
    },
    {
      type: 'assistant.delta',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 52,
      ts: baseTime + 2,
      producer: 'openclaw',
      text: 'The locked turn is complete.',
      replace: true,
    },
    { type: 'run.ended', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 53, ts: baseTime + 3, producer: 'openclaw', status: 'completed' },
  ]);
  let state = reduceConversationEvents(createEmptyConversationState(), terminalEvents);
  const turnId = state.turnOrderBySession[SESSION_KEY][0];
  assert.equal(state.turnsById[turnId].status, 'completed');
  state = reduceConversationEvents(state, runtime([
    {
      type: 'tool.started',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 54,
      ts: baseTime + 4,
      producer: 'openclaw',
      toolCallId: 'late-tool',
      name: 'exec',
    },
    {
      type: 'task.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 55,
      ts: baseTime + 5,
      producer: 'openclaw',
      taskId: 'late-task',
      task: { taskId: 'late-task', title: 'Late task', status: 'running', updatedAt: baseTime + 5 },
    },
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 56,
      ts: baseTime + 6,
      producer: 'history',
      itemId: 'late-approval',
      status: 'pending',
    },
  ]));
  const turn = state.turnsById[turnId];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.evidence.pendingToolCount, 0);
  assert.equal(turn.evidence.pendingTaskCount, 0);
  assert.equal(turn.evidence.pendingApprovalCount, 0);
  assert.equal(turn.items.some((item) => item.kind === 'approval'), false);
  assert.equal(turn.taskById['late-task'], undefined);
  const toolGroup = turn.items.find((item) => item.kind === 'tool-group');
  assert.ok(toolGroup && toolGroup.kind === 'tool-group');
  assert.deepEqual(toolGroup.toolCallIds, ['terminal-owned-tool']);
  assert.equal(toolGroup.status, 'completed');
});

test('authoritative abort closes an existing approval and replay cannot reopen it', () => {
  const events = runtime([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 60, ts: 6_000, producer: 'openclaw' },
    {
      type: 'tool.started',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 61,
      ts: 6_001,
      producer: 'openclaw',
      toolCallId: 'tool-before-abort',
      name: 'exec',
    },
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 62,
      ts: 6_002,
      producer: 'openclaw',
      itemId: 'approval-before-abort',
      status: 'pending',
    },
    {
      type: 'task.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 63,
      ts: 6_003,
      producer: 'openclaw',
      taskId: 'task-before-abort',
      task: { taskId: 'task-before-abort', title: 'Task before abort', status: 'running', updatedAt: 6_003 },
    },
    { type: 'run.ended', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 64, ts: 6_004, producer: 'openclaw', status: 'aborted' },
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 65,
      ts: 6_005,
      producer: 'history',
      itemId: 'approval-before-abort',
      status: 'pending',
    },
  ]);
  const state = reduceConversationEvents(createEmptyConversationState(), events);
  assertConversationState(state);
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  const approval = turn.items.find((item) => item.kind === 'approval');
  assert.ok(approval && approval.kind === 'approval');
  assert.equal(turn.status, 'aborted');
  assert.equal(approval.status, 'aborted');
  assert.equal(approval.approvalStatus, 'cancelled');
  assert.equal(turn.taskById['task-before-abort'].status, 'aborted');
  const subtask = turn.items.find((item) => item.kind === 'subtask');
  assert.ok(subtask && subtask.kind === 'subtask');
  assert.equal(subtask.status, 'aborted');
  const toolGroup = turn.items.find((item) => item.kind === 'tool-group');
  assert.ok(toolGroup && toolGroup.kind === 'tool-group');
  assert.equal(toolGroup.status, 'aborted');
  assert.equal(toolGroup.entries[0]?.status, 'aborted');
  assert.equal(turn.evidence.pendingApprovalCount, 0);
});

test('subtask groups prioritize failure, keep active work running, and preserve pure aborts', () => {
  const sessionKey = `${SESSION_KEY}:subtask-aborted-precedence`;
  const runId = `${RUN_ID}:subtask-aborted-precedence`;
  const reduceTasks = (statuses: Array<'completed' | 'aborted' | 'running' | 'error'>) => {
    const started = statuses.map((_, index): ChatRuntimeEvent => ({
      type: 'task.updated',
      producer: 'openclaw',
      runId,
      sessionKey,
      taskId: `precedence-${index}`,
      ts: 7_000 + index,
      task: {
        taskId: `precedence-${index}`,
        parentTaskId: 'precedence-parent',
        title: `Precedence task ${index}`,
        status: 'running',
        updatedAt: 7_000 + index,
      },
    }));
    const terminal = statuses.flatMap((status, index): ChatRuntimeEvent[] => status === 'running' ? [] : [{
      type: 'task.updated',
      producer: 'openclaw',
      runId,
      sessionKey,
      taskId: `precedence-${index}`,
      ts: 8_000 + index,
      task: {
        taskId: `precedence-${index}`,
        parentTaskId: 'precedence-parent',
        title: `Precedence task ${index}`,
        status,
        updatedAt: 8_000 + index,
        endedAt: 8_000 + index,
      },
    }]);
    const events = [...started, ...terminal];
    const state = reduceConversationEvents(createEmptyConversationState(), runtime(events));
    const turn = state.turnsById[state.turnOrderBySession[sessionKey][0]];
    const subtask = turn.items.find((item) => item.kind === 'subtask');
    assert.ok(subtask && subtask.kind === 'subtask');
    return subtask;
  };

  assert.equal(reduceTasks(['completed', 'aborted']).status, 'aborted');
  assert.equal(reduceTasks(['completed', 'aborted', 'running']).status, 'running');
  assert.equal(reduceTasks(['completed', 'aborted', 'error']).status, 'error');
  assert.equal(reduceTasks(['completed', 'aborted', 'running', 'error']).status, 'error');
});

test('task-ledger child runs use owner lineage or the active Turn without creating a top-level Turn', () => {
  const sessionKey = 'agent:main:ledger-child-owner';
  const turnId = createTurnId({ sessionKey, idempotencyKey: 'ledger-owner-request' });
  const requested: ConversationEvent = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'ledger-owner:requested',
    type: 'turn.requested',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    turnId,
    messageId: 'ledger-owner-message',
    occurredAt: 20_000,
    receivedAt: 20_000,
    replayed: false,
    data: {
      message: {
        role: 'user',
        id: 'ledger-owner-message',
        idempotencyKey: 'ledger-owner-request',
        timestamp: 20,
        content: 'Run child tasks.',
      },
    },
  };
  const started = runtimeEventToConversationEvent({
    type: 'run.started',
    producer: 'openclaw',
    runId: 'ledger-owner-run',
    sessionKey,
    seq: 1,
    ts: 20_001,
  });
  assert.ok(started);
  let state = reduceConversationEvents(createEmptyConversationState(), [
    requested,
    { ...started, turnId },
  ]);

  const explicitOwner = projectTaskLedgerRecord({
    id: 'ledger-explicit-child',
    runtime: 'subagent',
    sessionKey,
    runId: 'ledger-child-run',
    ownerRunId: 'ledger-owner-run',
    title: 'Explicit child',
    status: 'running',
    createdAt: 20_002,
    updatedAt: 20_003,
  });
  const activeFallback = projectTaskLedgerRecord({
    id: 'ledger-active-child',
    runtime: 'subagent',
    sessionKey,
    runId: 'ledger-another-child-run',
    title: 'Active child',
    status: 'running',
    createdAt: 20_004,
    updatedAt: 20_005,
  });
  const parentOwned = projectTaskLedgerRecord({
    id: 'ledger-nested-child',
    runtime: 'subagent',
    sessionKey,
    runId: 'ledger-nested-child-run',
    parentTaskId: 'ledger-explicit-child',
    title: 'Nested child',
    status: 'running',
    createdAt: 20_006,
    updatedAt: 20_007,
  });
  assert.ok(explicitOwner && activeFallback && parentOwned);
  const explicitCanonical = runtimeEventToConversationEvent(explicitOwner);
  const fallbackCanonical = runtimeEventToConversationEvent(activeFallback);
  const parentCanonical = runtimeEventToConversationEvent(parentOwned);
  assert.ok(explicitCanonical && fallbackCanonical && parentCanonical);
  assert.equal(explicitCanonical.rootRunId, 'ledger-owner-run');

  state = reduceConversationEvents(state, [explicitCanonical, fallbackCanonical, parentCanonical]);

  assert.deepEqual(state.turnOrderBySession[sessionKey], [turnId]);
  assert.deepEqual(state.turnsById[turnId].taskIds, [
    'ledger-explicit-child',
    'ledger-active-child',
    'ledger-nested-child',
  ]);
  assert.equal(state.quarantineBySession[sessionKey], undefined);
  const assignments = state.ingressDiagnosticsBySession[sessionKey].assignments;
  assert.equal(assignments.some((entry) => (
    entry.eventId === explicitCanonical.eventId && entry.basis === 'root-run-alias' && entry.confidence === 'high'
  )), true);
  assert.equal(assignments.some((entry) => (
    entry.eventId === fallbackCanonical.eventId && entry.basis === 'active-task-ledger' && entry.confidence === 'medium'
  )), true);
  assert.equal(assignments.some((entry) => (
    entry.eventId === parentCanonical.eventId && entry.basis === 'parent-task-alias' && entry.confidence === 'high'
  )), true);
});

test('an unowned task-ledger run is quarantined instead of creating an orphan top-level Turn', () => {
  const sessionKey = 'agent:main:ledger-unowned';
  let state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(sessionKey, [{
      role: 'user',
      id: 'ledger-unowned-user',
      timestamp: 30,
      content: 'Earlier request.',
    }, {
      role: 'assistant',
      id: 'ledger-unowned-answer',
      timestamp: 31,
      content: 'Earlier answer.',
    }]),
  );
  const originalTurnId = state.turnOrderBySession[sessionKey][0];
  const taskRuntime = projectTaskLedgerRecord({
    id: 'ledger-unowned-task',
    runtime: 'subagent',
    sessionKey,
    runId: 'ledger-unowned-child-run',
    title: 'Unowned task',
    status: 'completed',
    deliveryStatus: 'delivered',
    terminalOutcome: 'succeeded',
    createdAt: 32_000,
    updatedAt: 33_000,
  });
  assert.ok(taskRuntime);
  const taskEvent = runtimeEventToConversationEvent(taskRuntime);
  assert.ok(taskEvent);

  state = reduceConversationEvents(state, [taskEvent]);

  assert.deepEqual(state.turnOrderBySession[sessionKey], [originalTurnId]);
  assert.equal(state.turnsById[originalTurnId].taskIds.length, 0);
  assert.equal(state.quarantineBySession[sessionKey]?.records[0]?.taskId, 'ledger-unowned-task');
  assert.equal(state.ingressDiagnosticsBySession[sessionKey].quarantineCount, 1);
  assert.equal(state.ingressDiagnosticsBySession[sessionKey].assignments.at(-1)?.basis, 'quarantine');
});

test('an old unowned ledger task cannot claim a newer pending local Turn', () => {
  const sessionKey = 'agent:main:ledger-stale-pending';
  const turnId = 'turn:ledger-stale-pending';
  const requested: ConversationEvent = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'ledger-stale-pending:requested',
    type: 'turn.requested',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    turnId,
    occurredAt: 100_000,
    receivedAt: 100_000,
    replayed: false,
    data: { message: { role: 'user', content: 'A newer pending request.', timestamp: 100 } },
  };
  const oldTaskRuntime = projectTaskLedgerRecord({
    id: 'ledger-old-pending-task',
    runtime: 'subagent',
    sessionKey,
    runId: 'ledger-old-pending-child-run',
    title: 'Old pending-window work',
    status: 'running',
    createdAt: 1,
    updatedAt: 101_000,
  });
  assert.ok(oldTaskRuntime);
  const oldTask = runtimeEventToConversationEvent(oldTaskRuntime);
  assert.ok(oldTask);

  const state = reduceConversationEvents(createEmptyConversationState(), [requested, oldTask]);

  assert.deepEqual(state.turnOrderBySession[sessionKey], [turnId]);
  assert.deepEqual(state.turnsById[turnId].taskIds, []);
  assert.equal(state.quarantineBySession[sessionKey]?.records[0]?.taskId, 'ledger-old-pending-task');
  assert.equal(state.ingressDiagnosticsBySession[sessionKey].assignments.at(-1)?.basis, 'quarantine');
});

test('an old unowned ledger task cannot attach to a newer unrelated active Turn', () => {
  const sessionKey = 'agent:main:ledger-stale-active';
  const turnId = 'turn:ledger-stale-active';
  const requested: ConversationEvent = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'ledger-stale:requested',
    type: 'turn.requested',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    turnId,
    occurredAt: 100_000,
    receivedAt: 100_000,
    replayed: false,
    data: { message: { role: 'user', content: 'A newer request.', timestamp: 100 } },
  };
  const started = runtimeEventToConversationEvent({
    type: 'run.started',
    producer: 'openclaw',
    runId: 'ledger-stale-owner-run',
    sessionKey,
    seq: 1,
    ts: 101,
  });
  assert.ok(started);
  const oldTaskRuntime = projectTaskLedgerRecord({
    id: 'ledger-old-task',
    runtime: 'subagent',
    sessionKey,
    runId: 'ledger-old-child-run',
    title: 'Old background work',
    status: 'running',
    createdAt: 1,
    updatedAt: 101_000,
  });
  assert.ok(oldTaskRuntime);
  const oldTask = runtimeEventToConversationEvent(oldTaskRuntime);
  assert.ok(oldTask);

  const state = reduceConversationEvents(createEmptyConversationState(), [
    requested,
    { ...started, turnId },
    oldTask,
  ]);

  assert.deepEqual(state.turnOrderBySession[sessionKey], [turnId]);
  assert.deepEqual(state.turnsById[turnId].taskIds, []);
  assert.equal(state.quarantineBySession[sessionKey]?.records[0]?.taskId, 'ledger-old-task');
});

test('task updates render one compact subtask item and terminal task states never revive', () => {
  const baseTime = 1_700_000_000_000;
  const taskEvents: ChatRuntimeEvent[] = [
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 30, ts: baseTime, producer: 'openclaw' },
    {
      type: 'task.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 31,
      ts: baseTime + 1,
      producer: 'openclaw',
      taskId: 'research-task',
      task: {
        taskId: 'research-task',
        parentTaskId: 'parent-task',
        title: 'Research implementation',
        runtime: 'subagent',
        status: 'running',
        updatedAt: baseTime + 1,
      },
    },
    {
      type: 'task.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 32,
      ts: baseTime + 2,
      producer: 'openclaw',
      taskId: 'review-task',
      task: {
        taskId: 'review-task',
        parentTaskId: 'parent-task',
        title: 'Review implementation',
        runtime: 'subagent',
        status: 'running',
        updatedAt: baseTime + 2,
      },
    },
    {
      type: 'task.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 33,
      ts: baseTime + 3,
      producer: 'openclaw',
      taskId: 'research-task',
      task: {
        taskId: 'research-task',
        parentTaskId: 'parent-task',
        title: 'Research implementation',
        runtime: 'subagent',
        status: 'completed',
        updatedAt: baseTime + 3,
      },
    },
    {
      type: 'task.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 34,
      ts: baseTime + 4,
      producer: 'openclaw',
      taskId: 'review-task',
      task: {
        taskId: 'review-task',
        parentTaskId: 'parent-task',
        title: 'Review implementation',
        runtime: 'subagent',
        status: 'completed',
        updatedAt: baseTime + 4,
      },
    },
    {
      type: 'task.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 35,
      ts: baseTime + 5,
      producer: 'history',
      taskId: 'research-task',
      task: {
        taskId: 'research-task',
        parentTaskId: 'parent-task',
        title: 'Stale history result',
        runtime: 'subagent',
        status: 'error',
        updatedAt: baseTime + 5,
      },
    },
    {
      type: 'task.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 36,
      ts: baseTime + 6,
      producer: 'openclaw',
      taskId: 'review-task',
      task: {
        taskId: 'review-task',
        parentTaskId: 'parent-task',
        title: 'Review implementation',
        runtime: 'subagent',
        status: 'running',
        updatedAt: baseTime + 6,
      },
    },
  ];
  const adapted = taskEvents.map(runtimeEventToConversationEvent);
  assert.equal(adapted[1]?.parentTaskId, 'parent-task');
  const state = reduceConversationEvents(
    createEmptyConversationState(),
    adapted.filter((event): event is NonNullable<typeof event> => Boolean(event)),
  );
  assertConversationState(state);
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  assert.equal(turn.taskById['research-task'].status, 'completed');
  assert.equal(turn.taskById['review-task'].status, 'completed');
  const subtasks = turn.items.filter((item) => item.kind === 'subtask');
  assert.equal(subtasks.length, 1);
  assert.equal(subtasks[0].tasks.length, 2);
  assert.equal(subtasks[0].status, 'completed');
  assert.equal(subtasks[0].parentTaskId, 'parent-task');
  assert.deepEqual(subtasks[0].tasks.map((task) => task.parentTaskId), ['parent-task', 'parent-task']);
});

test('native task snapshot fan-out keeps one default task owner and retains diagnostic companions', () => {
  const nativeRunId = 'run-native-task-owner';
  const nativeToolCallId = 'tool-native-task-owner';
  const events = normalizeGatewayChatRuntimeEvents({
    stream: 'tool',
    runId: nativeRunId,
    sessionKey: SESSION_KEY,
    seq: 50,
    ts: 1_700_000_100_000,
    data: {
      phase: 'end',
      toolCallId: nativeToolCallId,
      name: 'image_generate',
      result: { status: 'completed' },
      task: {
        taskId: 'native-task-owner',
        taskKind: 'image_generation',
        title: 'Generate the release image',
        status: 'completed',
        deliveryStatus: 'delivered',
        terminalOutcome: 'succeeded',
        progressSummary: 'Release image generated',
        updatedAt: 1_700_000_100_000,
        endedAt: 1_700_000_100_000,
      },
      artifacts: [{
        id: 'native-task-artifact',
        kind: 'image',
        title: 'release-image.png',
        filePath: '/tmp/release-image.png',
      }],
      verifications: [{
        id: 'native-task-verification',
        status: 'passed',
        kind: 'artifact.availability',
        artifactId: 'native-task-artifact',
      }],
    },
  });
  const taskEvent = events.find((event) => event.type === 'task.updated');
  const stepEvent = events.find((event) => event.type === 'run.step.updated');
  const progressEvent = events.find((event) => event.type === 'progress.update');
  assert.equal(taskEvent?.toolCallId, nativeToolCallId);
  assert.equal(stepEvent?.timelineVisibility, 'diagnostics');
  assert.equal(progressEvent?.timelineVisibility, 'diagnostics');

  const state = reduceConversationEvents(createEmptyConversationState(), runtime(events));
  assertConversationState(state);
  const turnId = state.turnOrderBySession[SESSION_KEY][0];
  const turn = state.turnsById[turnId];
  assert.equal(turn.items.filter((item) => item.kind === 'subtask').length, 1);
  assert.equal(turn.items.some((item) => item.kind === 'plan'), false);
  assert.equal(turn.items.some((item) => item.kind === 'tool-group'), false);
  assert.equal(turn.items.some((item) => item.kind === 'artifact-group'), true);
  assert.equal(turn.items.some((item) => item.kind === 'verification-summary'), true);
  assert.equal(
    state.eventsByTurnId[turnId].filter((event) => event.timelineVisibility === 'diagnostics').length,
    2,
  );
});

test('diagnostic tool ownership transfer removes only the linked default tool entry', () => {
  const events = runtime([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 60, ts: 1_700_000_200_000 },
    {
      type: 'tool.started',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 61,
      ts: 1_700_000_200_001,
      toolCallId: 'owned-tool',
      name: 'exec',
    },
    {
      type: 'tool.started',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 62,
      ts: 1_700_000_200_002,
      toolCallId: 'unrelated-tool',
      name: 'exec',
    },
    {
      type: 'task.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 63,
      ts: 1_700_000_200_003,
      taskId: 'owner-task',
      task: {
        taskId: 'owner-task',
        title: 'Own the durable execution',
        status: 'running',
      },
    },
    {
      type: 'tool.completed',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 64,
      ts: 1_700_000_200_004,
      taskId: 'owner-task',
      timelineVisibility: 'diagnostics',
      toolCallId: 'owned-tool',
      name: 'exec',
      result: { status: 'delegated' },
    },
  ]);
  const state = reduceConversationEvents(createEmptyConversationState(), events);
  assertConversationState(state);
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  const groups = turn.items.filter((item) => item.kind === 'tool-group');
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].entries.map((entry) => entry.toolCallId), ['unrelated-tool']);
  assert.equal(turn.toolItemByCallId['owned-tool'], undefined);
  assert.equal(turn.toolMergeByCallId['owned-tool'], undefined);
  assert.equal(turn.items.filter((item) => item.kind === 'subtask').length, 1);
});

test('ownerless action and status progress project compactly while diagnostic and owned progress stay hidden', () => {
  const events = runtime([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, seq: 70, ts: 1_700_000_300_000 },
    {
      type: 'progress.update',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 71,
      ts: 1_700_000_300_001,
      entry: { id: 'ownerless-progress', kind: 'action', text: 'Preparing the workspace', status: 'running' },
    },
    {
      type: 'progress.update',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 72,
      ts: 1_700_000_300_002,
      entry: { id: 'ownerless-progress', kind: 'status', text: 'Workspace prepared', status: 'completed' },
    },
    {
      type: 'progress.update',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 73,
      ts: 1_700_000_300_003,
      timelineVisibility: 'diagnostics',
      entry: { id: 'diagnostic-progress', kind: 'status', text: 'Internal task state', status: 'completed' },
    },
    {
      type: 'progress.update',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: 74,
      ts: 1_700_000_300_004,
      entry: {
        id: 'tool-owned-progress',
        kind: 'action',
        text: 'Running the owned tool',
        status: 'running',
        toolCallId: 'owned-progress-tool',
      },
    },
  ]);
  const state = reduceConversationEvents(createEmptyConversationState(), events);
  assertConversationState(state);
  const turn = state.turnsById[state.turnOrderBySession[SESSION_KEY][0]];
  const progressItems = turn.items.filter((item) => item.kind === 'commentary' && item.id.startsWith('progress:'));
  assert.equal(progressItems.length, 1);
  assert.equal(progressItems[0].id, 'progress:ownerless-progress');
  assert.equal(progressItems[0].text, 'Workspace prepared');
  assert.equal(progressItems[0].status, 'completed');
});

test('runtime producer mapping keeps ledger and plugin provenance explicit and unknown producers inferred', () => {
  const ledger = runtimeEventToConversationEvent({
    type: 'task.updated',
    producer: 'openclaw-task-ledger',
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    seq: 80,
    task: { taskId: 'ledger-task', title: 'Ledger task', status: 'running' },
  });
  const plugin = runtimeEventToConversationEvent({
    type: 'artifact.produced',
    producer: 'plugin',
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    seq: 81,
    artifact: { id: 'plugin-artifact', title: 'Plugin artifact' },
  });
  const concretePlugin = runtimeEventToConversationEvent({
    type: 'verification.completed',
    producer: 'uclaw-artifact-guard',
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    seq: 82,
    verification: { id: 'plugin-verification', status: 'passed' },
  });
  const unknown = runtimeEventToConversationEvent({
    type: 'run.started',
    producer: 'unregistered-runtime-producer',
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    seq: 83,
  });
  assert.equal(ledger?.source, 'task-ledger');
  assert.equal(ledger?.authority, 'authoritative');
  assert.equal(plugin?.source, 'plugin');
  assert.equal(plugin?.authority, 'authoritative');
  assert.equal(concretePlugin?.source, 'plugin');
  assert.equal(unknown?.source, 'derived');
  assert.equal(unknown?.authority, 'inferred');
});

test('same-sequence runtime fan-out uses entity identity instead of sequence identity', () => {
  const shared = { runId: RUN_ID, sessionKey: SESSION_KEY, seq: 90, ts: 1_700_000_400_000 } as const;
  const events = runtime([
    {
      ...shared,
      type: 'task.updated',
      task: { taskId: 'entity-task-a', title: 'Task A', status: 'running' },
    },
    {
      ...shared,
      type: 'task.updated',
      task: { taskId: 'entity-task-b', title: 'Task B', status: 'running' },
    },
    { ...shared, type: 'artifact.produced', artifact: { id: 'entity-artifact-a', title: 'Artifact A' } },
    { ...shared, type: 'artifact.produced', artifact: { id: 'entity-artifact-b', title: 'Artifact B' } },
    {
      ...shared,
      type: 'verification.completed',
      verification: { id: 'entity-verification-a', status: 'passed' },
    },
    {
      ...shared,
      type: 'verification.completed',
      verification: { id: 'entity-verification-b', status: 'passed' },
    },
    { ...shared, type: 'approval.updated', itemId: 'entity-approval-a', status: 'pending' },
    { ...shared, type: 'approval.updated', itemId: 'entity-approval-b', status: 'pending' },
  ]);
  assert.equal(events.length, 8);
  assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
  assert.ok(events.some((event) => event.eventId.includes('artifact:entity-artifact-a')));
  assert.ok(events.some((event) => event.eventId.includes('verification:entity-verification-b')));
  assert.ok(events.some((event) => event.eventId.includes('approval:entity-approval-a')));

  const artifactUpdate = runtimeEventToConversationEvent({
    ...shared,
    seq: 91,
    type: 'artifact.produced',
    artifact: { id: 'entity-artifact-a', title: 'Artifact A', filePath: '/tmp/artifact-a.txt' },
  });
  const hydratedArtifactUpdate = runtimeEventToConversationEvent({
    ...shared,
    seq: 92,
    type: 'artifact.produced',
    artifact: {
      id: 'entity-artifact-a',
      title: 'Artifact A',
      filePath: '/tmp/artifact-a.txt',
      preview: 'hydrated-preview',
    },
  });
  assert.ok(artifactUpdate && hydratedArtifactUpdate);
  assert.notEqual(artifactUpdate.eventId, hydratedArtifactUpdate.eventId);
});

test('artifact availability verification drives registered, unavailable, and available states out of order', () => {
  const sessionKey = 'agent:main:artifact-availability';
  const runId = 'run-artifact-availability';
  const turnId = 'turn:artifact-availability';
  const base = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    sessionKey,
    turnId,
    rootRunId: runId,
    runId,
    replayed: false,
    receivedAt: 1_700_000_500_000,
  } as const;
  const unavailableVerification: ConversationEvent = {
    ...base,
    eventId: 'artifact-availability:failed',
    type: 'verification.updated',
    source: 'plugin',
    authority: 'authoritative',
    occurredAt: 1_700_000_500_001,
    data: {
      verification: {
        id: 'artifact-availability-check',
        artifactId: 'artifact-availability-output',
        kind: 'artifact.availability',
        status: 'failed',
        required: true,
      },
    },
  };
  const registeredArtifact: ConversationEvent = {
    ...base,
    eventId: 'artifact-availability:registered',
    type: 'artifact.updated',
    source: 'openclaw-runtime',
    authority: 'authoritative',
    occurredAt: 1_700_000_500_002,
    data: {
      artifact: {
        id: 'artifact-availability-output',
        title: 'availability-output.txt',
        filePath: '/tmp/availability-output.txt',
        availability: 'registered',
      },
    },
  };
  let state = reduceConversationEvents(createEmptyConversationState(), [
    unavailableVerification,
    registeredArtifact,
  ]);
  let turn = state.turnsById[turnId];
  let artifactItem = turn.items.find((item) => item.kind === 'artifact-group');
  assert.ok(artifactItem && artifactItem.kind === 'artifact-group');
  assert.equal(artifactItem.artifacts[0].availability, 'unavailable');
  assert.equal(artifactItem.status, 'blocked');

  state = reduceConversationEvents(state, [{
    ...unavailableVerification,
    eventId: 'artifact-availability:passed',
    occurredAt: 1_700_000_500_003,
    data: {
      verification: {
        ...unavailableVerification.data.verification,
        status: 'passed',
      },
    },
  }]);
  turn = state.turnsById[turnId];
  artifactItem = turn.items.find((item) => item.kind === 'artifact-group');
  assert.ok(artifactItem && artifactItem.kind === 'artifact-group');
  assert.equal(artifactItem.artifacts[0].availability, 'available');
  assert.equal(artifactItem.status, 'completed');
  assertConversationState(state);
});

test('local artifact availability pass and failure enter their canonical owners idempotently', () => {
  const selectedSession = 'agent:main:artifact-verification-selected';
  const passSession = 'agent:media:artifact-verification-pass';
  const failSession = 'agent:worker:artifact-verification-fail';
  const passRootRunId = 'run-local-artifact-pass-owner';
  const passTaskId = 'task-local-artifact-pass';
  const passRunId = `image_generate:${passTaskId}:final`;
  const passToolCallId = 'tool-local-artifact-pass';
  const passArtifactId = 'artifact-local-availability-pass';
  const failRunId = 'run-local-artifact-fail-owner';
  const failArtifactId = 'artifact-local-availability-fail';
  const store = useConversationStore.getState();
  store.reset();
  store.setCurrentSession(selectedSession);

  try {
    [
      {
        type: 'run.started',
        producer: 'openclaw',
        runId: passRootRunId,
        sessionKey: passSession,
        ts: 40_000,
      },
      {
        type: 'task.updated',
        producer: 'openclaw-task-ledger',
        runId: passRootRunId,
        sessionKey: passSession,
        taskId: passTaskId,
        ts: 40_001,
        task: {
          taskId: passTaskId,
          title: 'Generate local artifact',
          status: 'running',
        },
      },
      {
        type: 'tool.started',
        producer: 'openclaw',
        runId: passRootRunId,
        sessionKey: passSession,
        taskId: passTaskId,
        toolCallId: passToolCallId,
        name: 'image_generate',
        ts: 40_002,
      },
      {
        type: 'artifact.produced',
        producer: 'media',
        runId: passRunId,
        rootRunId: passRootRunId,
        sessionKey: passSession,
        taskId: passTaskId,
        toolCallId: passToolCallId,
        ts: 40_003,
        artifact: {
          id: passArtifactId,
          title: 'pass.png',
          filePath: '/tmp/pass.png',
          mimeType: 'image/png',
          availability: 'registered',
          taskId: passTaskId,
          sourceToolCallId: passToolCallId,
        },
      },
      {
        type: 'run.started',
        producer: 'openclaw',
        runId: failRunId,
        sessionKey: failSession,
        ts: 41_000,
      },
      {
        type: 'artifact.produced',
        producer: 'media',
        runId: failRunId,
        sessionKey: failSession,
        ts: 41_001,
        artifact: {
          id: failArtifactId,
          title: 'fail.png',
          filePath: '/tmp/fail.png',
          mimeType: 'image/png',
          availability: 'registered',
        },
      },
    ].forEach((event) => store.ingestRuntimeEvent(event as ChatRuntimeEvent));

    const passArtifact: Extract<ChatRuntimeEvent, { type: 'artifact.produced' }> = {
      type: 'artifact.produced',
      producer: 'uclaw-artifact-guard',
      runId: passRunId,
      rootRunId: passRootRunId,
      taskId: passTaskId,
      toolCallId: passToolCallId,
      ts: 42_000,
      artifact: {
        id: passArtifactId,
        title: 'pass.png',
        filePath: '/tmp/pass.png',
        mimeType: 'image/png',
        sizeBytes: 512,
        availability: 'registered',
        taskId: passTaskId,
        sourceToolCallId: passToolCallId,
      },
    };
    const failArtifact: Extract<ChatRuntimeEvent, { type: 'artifact.produced' }> = {
      type: 'artifact.produced',
      producer: 'uclaw-artifact-guard',
      runId: failRunId,
      ts: 42_100,
      artifact: {
        id: failArtifactId,
        title: 'fail.png',
        filePath: '/tmp/fail.png',
        mimeType: 'image/png',
        availability: 'registered',
      },
    };
    const runtimeEvents = [
      passArtifact,
      buildRuntimeArtifactVerificationEvent(passArtifact, {
        artifact: passArtifact.artifact,
        status: 'passed',
        detail: 'Local artifact is readable.',
      }),
      failArtifact,
      buildRuntimeArtifactVerificationEvent(failArtifact, {
        artifact: failArtifact.artifact,
        status: 'blocked',
        detail: 'Local artifact is not readable.',
      }),
    ];
    const projection = projectRuntimeArtifactVerificationEvents(
      useConversationStore.getState(),
      runtimeEvents,
    );

    assert.equal(projection.rejected.length, 0);
    assert.equal(projection.events.length, 4);
    const passTurnId = useConversationStore.getState().turnOrderBySession[passSession][0];
    const failTurnId = useConversationStore.getState().turnOrderBySession[failSession][0];
    const passEvents = projection.events.filter((event) => event.turnId === passTurnId);
    assert.equal(passEvents.length, 2);
    passEvents.forEach((event) => {
      assert.equal(event.sessionKey, passSession);
      assert.equal(event.rootRunId, passRootRunId);
      assert.equal(event.runId, passRunId);
      assert.equal(event.taskId, passTaskId);
      assert.equal(event.toolCallId, passToolCallId);
      assert.equal(event.source, 'plugin');
      assert.equal(event.authority, 'authoritative');
    });

    store.ingestEvents(projection.events, { buffered: false });
    const firstPassTurn = structuredClone(useConversationStore.getState().turnsById[passTurnId]);
    const firstFailTurn = structuredClone(useConversationStore.getState().turnsById[failTurnId]);
    store.ingestEvents(projection.events, { buffered: false });
    const state = useConversationStore.getState();
    assert.deepEqual(state.turnsById[passTurnId], firstPassTurn);
    assert.deepEqual(state.turnsById[failTurnId], firstFailTurn);
    assert.equal(state.currentSessionKey, selectedSession);
    assert.equal(state.turnOrderBySession[selectedSession], undefined);

    const passTurn = state.turnsById[passTurnId];
    const passArtifactItem = passTurn.items.find((item) => item.kind === 'artifact-group');
    const passVerificationItem = passTurn.items.find((item) => item.kind === 'verification-summary');
    assert.ok(passArtifactItem && passArtifactItem.kind === 'artifact-group');
    assert.ok(passVerificationItem && passVerificationItem.kind === 'verification-summary');
    assert.equal(passArtifactItem.artifacts.length, 1);
    assert.equal(passArtifactItem.artifacts[0].availability, 'available');
    assert.equal(passArtifactItem.artifacts[0].sizeBytes, 512);
    assert.equal(passArtifactItem.artifacts[0].taskId, passTaskId);
    assert.equal(passArtifactItem.artifacts[0].sourceToolCallId, passToolCallId);
    assert.equal(passVerificationItem.verifications.length, 1);
    assert.equal(passVerificationItem.verifications[0].status, 'passed');
    assert.equal(passVerificationItem.verifications[0].taskId, passTaskId);

    const failTurn = state.turnsById[failTurnId];
    const failArtifactItem = failTurn.items.find((item) => item.kind === 'artifact-group');
    const failVerificationItem = failTurn.items.find((item) => item.kind === 'verification-summary');
    assert.ok(failArtifactItem && failArtifactItem.kind === 'artifact-group');
    assert.ok(failVerificationItem && failVerificationItem.kind === 'verification-summary');
    assert.equal(failArtifactItem.artifacts.length, 1);
    assert.equal(failArtifactItem.artifacts[0].availability, 'unavailable');
    assert.equal(failVerificationItem.verifications.length, 1);
    assert.equal(failVerificationItem.verifications[0].status, 'blocked');

    const unknown = projectRuntimeArtifactVerificationEvents(state, [{
      ...failArtifact,
      runId: 'run-local-artifact-unknown',
      artifact: { ...failArtifact.artifact, id: 'artifact-local-availability-unknown' },
    }]);
    assert.equal(unknown.events.length, 0);
    assert.equal(unknown.rejected.length, 1);

    const contradictory = projectRuntimeArtifactVerificationEvents(state, [{
      ...passArtifact,
      sessionKey: failSession,
    }]);
    assert.equal(contradictory.events.length, 0);
    assert.equal(contradictory.rejected.length, 1);

    const sharedArtifactId = 'artifact-local-availability-ambiguous';
    ['agent:left:artifact-ambiguous', 'agent:right:artifact-ambiguous'].forEach((sessionKey, index) => {
      store.ingestRuntimeEvent({
        type: 'artifact.produced',
        producer: 'media',
        runId: `run-artifact-ambiguous-${index}`,
        sessionKey,
        ts: 43_000 + index,
        artifact: { id: sharedArtifactId, filePath: `/tmp/ambiguous-${index}.png` },
      });
    });
    const ambiguous = projectRuntimeArtifactVerificationEvents(useConversationStore.getState(), [
      buildRuntimeArtifactVerificationEvent({
        runId: 'run-artifact-ambiguous-unknown',
        producer: 'uclaw-artifact-guard',
        ts: 43_100,
      }, {
        artifact: { id: sharedArtifactId },
        status: 'blocked',
      }),
    ]);
    assert.equal(ambiguous.events.length, 0);
    assert.equal(ambiguous.rejected.length, 1);
  } finally {
    useConversationStore.getState().reset();
  }
});

test('native artifact error state outranks stale available history evidence', () => {
  const turnId = 'turn:artifact-error-authority';
  const base = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    sessionKey: SESSION_KEY,
    turnId,
    rootRunId: RUN_ID,
    runId: RUN_ID,
    replayed: false,
    receivedAt: 1_700_000_600_000,
  } as const;
  const events: ConversationEvent[] = [{
    ...base,
    eventId: 'artifact-error:native',
    type: 'artifact.updated',
    source: 'openclaw-runtime',
    authority: 'authoritative',
    occurredAt: 1_700_000_600_001,
    data: {
      artifact: {
        id: 'artifact-error-output',
        filePath: '/tmp/artifact-error-output.txt',
        availability: 'error',
        error: 'Artifact generation failed.',
      },
    },
  }, {
    ...base,
    eventId: 'artifact-error:stale-history',
    type: 'artifact.updated',
    source: 'history',
    authority: 'authoritative',
    occurredAt: 1_700_000_600_002,
    replayed: true,
    data: {
      artifact: {
        id: 'artifact-error-output',
        filePath: '/tmp/artifact-error-output.txt',
        availability: 'available',
      },
    },
  }];
  const state = reduceConversationEvents(createEmptyConversationState(), events);
  const artifactItem = state.turnsById[turnId].items.find((item) => item.kind === 'artifact-group');
  assert.ok(artifactItem && artifactItem.kind === 'artifact-group');
  assert.equal(artifactItem.artifacts[0].availability, 'error');
  assert.equal(artifactItem.artifacts[0].error, 'Artifact generation failed.');
  assert.equal(artifactItem.status, 'error');
});

test('required blocked artifact availability prevents successful terminal completion', () => {
  const sessionKey = `${SESSION_KEY}:required-artifact-blocked`;
  const runId = `${RUN_ID}:required-artifact-blocked`;
  const events = runtime([
    { type: 'run.started', runId, sessionKey, seq: 1, ts: 30_000, producer: 'openclaw' },
    {
      type: 'artifact.produced',
      runId,
      sessionKey,
      seq: 2,
      ts: 30_001,
      producer: 'openclaw',
      artifact: {
        id: 'required-artifact-output',
        filePath: '/tmp/required-artifact-output.txt',
        availability: 'registered',
      },
    },
    {
      type: 'verification.completed',
      runId,
      sessionKey,
      seq: 3,
      ts: 30_002,
      producer: 'uclaw-artifact-guard',
      verification: {
        id: 'required-artifact-availability',
        artifactId: 'required-artifact-output',
        kind: 'artifact.availability',
        status: 'blocked',
        required: true,
        severity: 'blocking',
      },
    },
    { type: 'run.ended', runId, sessionKey, seq: 4, ts: 30_003, producer: 'openclaw', status: 'completed' },
  ]);
  const state = reduceConversationEvents(createEmptyConversationState(), events);
  const turn = state.turnsById[state.turnOrderBySession[sessionKey][0]];
  const artifactItem = turn.items.find((item) => item.kind === 'artifact-group');
  assert.ok(artifactItem && artifactItem.kind === 'artifact-group');
  assert.equal(artifactItem.artifacts[0].availability, 'unavailable');
  assert.equal(turn.evidence.requiredArtifactsSatisfied, false);
  assert.equal(turn.status, 'error');
});

test('skipped artifact availability verification does not downgrade an available artifact', () => {
  const sessionKey = `${SESSION_KEY}:artifact-availability-skipped`;
  const runId = `${RUN_ID}:artifact-availability-skipped`;
  const state = reduceConversationEvents(createEmptyConversationState(), runtime([
    { type: 'run.started', runId, sessionKey, seq: 1, ts: 31_000, producer: 'openclaw' },
    {
      type: 'artifact.produced',
      runId,
      sessionKey,
      seq: 2,
      ts: 31_001,
      producer: 'openclaw',
      artifact: {
        id: 'artifact-availability-skipped-output',
        filePath: '/tmp/artifact-availability-skipped-output.txt',
        availability: 'available',
      },
    },
    {
      type: 'verification.completed',
      runId,
      sessionKey,
      seq: 3,
      ts: 31_002,
      producer: 'uclaw-artifact-guard',
      verification: {
        id: 'artifact-availability-skipped-check',
        artifactId: 'artifact-availability-skipped-output',
        kind: 'artifact.availability',
        status: 'skipped',
        required: false,
        severity: 'warning',
      },
    },
  ]));
  const turn = state.turnsById[state.turnOrderBySession[sessionKey][0]];
  const artifactItem = turn.items.find((item) => item.kind === 'artifact-group');
  assert.ok(artifactItem && artifactItem.kind === 'artifact-group');
  assert.equal(artifactItem.artifacts[0].availability, 'available');
  assert.equal(artifactItem.status, 'completed');
});

test('native artifact snapshots without preview preserve hydrated history preview', () => {
  const sessionKey = `${SESSION_KEY}:artifact-preview-hydration`;
  const runId = `${RUN_ID}:artifact-preview-hydration`;
  const turnId = 'turn:artifact-preview-hydration';
  const historyArtifact: ConversationEvent = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'artifact-preview-hydration:history',
    type: 'artifact.updated',
    source: 'history',
    authority: 'authoritative',
    sessionKey,
    turnId,
    occurredAt: 32_000_000,
    receivedAt: 32_000_000,
    replayed: true,
    data: {
      artifact: {
        id: 'artifact-preview-hydration-output',
        filePath: '/tmp/artifact-preview-hydration-output.png',
        preview: 'data:image/png;base64,aGlzdG9yeQ==',
        availability: 'available',
      },
    },
  };
  const nativeRuntime = normalizeGatewayChatRuntimeEvents({
    stream: 'artifact',
    runId,
    sessionKey,
    seq: 1,
    ts: 32_001,
    data: {
      artifact: {
        id: 'artifact-preview-hydration-output',
        filePath: '/tmp/artifact-preview-hydration-output.png',
        availability: 'available',
      },
    },
  });
  const nativeArtifact = runtime(nativeRuntime);
  assert.equal(nativeArtifact.length, 1);
  assert.equal((nativeRuntime[0] as Extract<ChatRuntimeEvent, { type: 'artifact.produced' }>).artifact.preview, undefined);

  const state = reduceConversationEvents(createEmptyConversationState(), [
    historyArtifact,
    { ...nativeArtifact[0], turnId },
  ]);
  const artifactItem = state.turnsById[turnId].items.find((item) => item.kind === 'artifact-group');
  assert.ok(artifactItem && artifactItem.kind === 'artifact-group');
  assert.equal(artifactItem.artifacts[0].preview, 'data:image/png;base64,aGlzdG9yeQ==');
});

test('conversation store LRU protects the current and active sessions and replays an evicted visit cleanly', () => {
  const victimSession = 'agent:main:lru-victim';
  const activeSession = 'agent:main:lru-active';
  const selectedSession = 'agent:main:lru-selected';
  const store = useConversationStore.getState();
  store.reset();
  try {
    store.replaceHistory(victimSession, completedHistory(victimSession));
    const victimTurnId = useConversationStore.getState().turnOrderBySession[victimSession][0];
    const victimItemId = useConversationStore.getState().turnsById[victimTurnId].items[0].id;
    store.setItemExpanded(victimItemId, true);
    store.setFollowMode(victimSession, 'detached');

    store.ingestRuntimeEvent({
      type: 'run.started',
      runId: 'lru-active-run',
      sessionKey: activeSession,
      seq: 1,
      ts: 5_000,
    });
    store.setCurrentSession(selectedSession);
    store.replaceHistory(selectedSession, completedHistory(selectedSession));
    for (let index = 0; index < CONVERSATION_SESSION_CACHE_LIMIT; index += 1) {
      const sessionKey = `agent:main:lru-filler-${index}`;
      store.replaceHistory(sessionKey, completedHistory(sessionKey));
    }

    let state = useConversationStore.getState();
    assert.ok(state.sessionAccessOrder.length <= CONVERSATION_SESSION_CACHE_LIMIT);
    assert.ok(state.turnOrderBySession[selectedSession]?.length);
    assert.ok(state.turnOrderBySession[activeSession]?.length);
    assert.equal(state.turnOrderBySession[victimSession], undefined);
    assert.equal(state.expandedItemIds[victimItemId], undefined);
    assert.equal(state.followModeBySession[victimSession], undefined);

    store.setCurrentSession(victimSession);
    store.replaceHistory(victimSession, completedHistory(victimSession, 'revisited'));
    state = useConversationStore.getState();
    const revisitedTurnId = state.turnOrderBySession[victimSession][0];
    const revisitedFinal = state.turnsById[revisitedTurnId].items.find((item) => item.kind === 'final-answer');
    assert.ok(revisitedFinal && revisitedFinal.kind === 'final-answer');
    assert.equal(revisitedFinal.message.content, 'Answer revisited');
    assert.equal(state.currentSessionKey, victimSession);
    assert.equal(state.sessionAccessOrder.at(-1), victimSession);
    assert.ok(state.sessionAccessOrder.length <= CONVERSATION_SESSION_CACHE_LIMIT);
  } finally {
    useConversationStore.getState().reset();
  }
});

test('conversation store temporarily exceeds its cache limit only for protected sessions then converges', () => {
  const sessions = Array.from(
    { length: CONVERSATION_SESSION_CACHE_LIMIT + 2 },
    (_, index) => `agent:main:lru-protected-${index}`,
  );
  const store = useConversationStore.getState();
  store.reset();
  try {
    store.setCurrentSession(sessions[0]);
    sessions.forEach((sessionKey, index) => {
      store.ingestRuntimeEvent({
        type: 'run.started',
        runId: `lru-protected-run-${index}`,
        sessionKey,
        seq: 1,
        ts: 6_000 + index,
      });
    });

    let state = useConversationStore.getState();
    assert.equal(state.sessionAccessOrder.length, CONVERSATION_SESSION_CACHE_LIMIT + 2);
    assert.ok(sessions.every((sessionKey) => state.turnOrderBySession[sessionKey]?.length));

    sessions.slice(1, 3).forEach((sessionKey, index) => {
      store.ingestRuntimeEvent({
        type: 'run.ended',
        runId: `lru-protected-run-${index + 1}`,
        sessionKey,
        seq: 2,
        ts: 7_000 + index,
        status: 'aborted',
      });
    });

    state = useConversationStore.getState();
    assert.equal(state.sessionAccessOrder.length, CONVERSATION_SESSION_CACHE_LIMIT);
    assert.ok(state.turnOrderBySession[sessions[0]]?.length);
    assert.equal(state.currentSessionKey, sessions[0]);
    sessions.slice(3).forEach((sessionKey) => {
      assert.ok(state.turnOrderBySession[sessionKey]?.length);
    });
  } finally {
    useConversationStore.getState().reset();
  }
});

test('authoritative chat error closes active tool, task, and approval without late reopen', () => {
  const sessionKey = 'agent:main:chat-error-pending-work';
  const turnId = 'turn:chat-error-pending-work';
  const runId = 'run:chat-error-pending-work';
  const occurredAt = 1_700_000_800_000;
  const requested: ConversationEvent = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'chat-error-pending:requested',
    type: 'turn.requested',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    turnId,
    messageId: 'chat-error-pending:user',
    occurredAt,
    receivedAt: occurredAt,
    replayed: false,
    data: {
      message: {
        role: 'user',
        id: 'chat-error-pending:user',
        content: 'Start work that will fail while child work is pending.',
        timestamp: occurredAt,
      },
    },
  };
  const pending = runtime([
    { type: 'run.started', runId, sessionKey, seq: 1, ts: occurredAt + 1, producer: 'openclaw' },
    {
      type: 'tool.started',
      runId,
      sessionKey,
      seq: 2,
      ts: occurredAt + 2,
      producer: 'openclaw',
      toolCallId: 'chat-error-pending:tool',
      name: 'exec',
    },
    {
      type: 'task.updated',
      runId,
      sessionKey,
      seq: 3,
      ts: occurredAt + 3,
      producer: 'openclaw',
      taskId: 'chat-error-pending:task',
      task: {
        taskId: 'chat-error-pending:task',
        title: 'Pending child task',
        status: 'running',
        updatedAt: occurredAt + 3,
      },
    },
    {
      type: 'approval.updated',
      runId,
      sessionKey,
      seq: 4,
      ts: occurredAt + 4,
      producer: 'openclaw',
      approvalId: 'chat-error-pending:approval',
      approvalKind: 'exec',
      allowedDecisions: ['allow-once', 'deny'],
      actionable: true,
      itemId: 'chat-error-pending:approval',
      phase: 'requested',
      status: 'pending',
    },
  ]);
  const chatErrors = chatEventToConversationEvents({
    state: 'error',
    sessionKey,
    runId,
    seq: 5,
    errorMessage: 'Provider request failed while child work was pending.',
    message: {
      role: 'assistant',
      id: 'chat-error-pending:error',
      content: '',
      timestamp: (occurredAt + 5) / 1_000,
    },
  }, { sessionKey, turnId });

  assert.deepEqual(chatErrors.map((event) => event.type), ['run.ended', 'turn.error']);
  let state = reduceConversationEvents(createEmptyConversationState(), [requested, ...pending, ...chatErrors]);
  const terminalTurn = state.turnsById[turnId];
  const toolGroup = terminalTurn.items.find((item) => item.kind === 'tool-group');
  const subtask = terminalTurn.items.find((item) => item.kind === 'subtask');
  const approval = terminalTurn.items.find((item) => item.kind === 'approval');
  assert.ok(toolGroup && toolGroup.kind === 'tool-group');
  assert.ok(subtask && subtask.kind === 'subtask');
  assert.ok(approval && approval.kind === 'approval');
  assert.equal(terminalTurn.status, 'error');
  assert.equal(terminalTurn.evidence.runTerminal, 'error');
  assert.equal(terminalTurn.evidence.runTerminalAuthority, 'authoritative');
  assert.equal(terminalTurn.evidence.runTerminalSource, 'openclaw-chat');
  assert.equal(terminalTurn.evidence.pendingToolCount, 0);
  assert.equal(terminalTurn.evidence.pendingTaskCount, 0);
  assert.equal(terminalTurn.evidence.pendingApprovalCount, 0);
  assert.equal(state.aliases.activeBySession[sessionKey], undefined);
  assert.equal(toolGroup.status, 'error');
  assert.equal(toolGroup.entries[0]?.status, 'error');
  assert.equal(subtask.status, 'error');
  assert.equal(terminalTurn.taskById['chat-error-pending:task']?.status, 'error');
  assert.equal(approval.status, 'error');
  assert.equal(approval.approvalStatus, 'cancelled');
  assert.equal(approval.actionable, false);
  assert.equal(terminalTurn.items.filter((item) => item.kind === 'error').length, 1);

  state = reduceConversationEvents(state, chatErrors);
  assert.equal(state.turnsById[turnId], terminalTurn);
  assert.equal(state.turnsById[turnId].items.filter((item) => item.kind === 'error').length, 1);

  state = reduceConversationEvents(state, runtime([
    {
      type: 'tool.updated',
      runId,
      sessionKey,
      seq: 6,
      ts: occurredAt + 6,
      producer: 'openclaw',
      toolCallId: 'chat-error-pending:tool',
      name: 'exec',
      partialResult: 'late tool progress',
    },
    {
      type: 'task.updated',
      runId,
      sessionKey,
      seq: 7,
      ts: occurredAt + 7,
      producer: 'openclaw',
      taskId: 'chat-error-pending:task',
      task: {
        taskId: 'chat-error-pending:task',
        title: 'Pending child task',
        status: 'running',
        updatedAt: occurredAt + 7,
      },
    },
    {
      type: 'approval.updated',
      runId,
      sessionKey,
      seq: 8,
      ts: occurredAt + 8,
      producer: 'openclaw',
      approvalId: 'chat-error-pending:approval',
      approvalKind: 'exec',
      allowedDecisions: ['allow-once', 'deny'],
      actionable: true,
      itemId: 'chat-error-pending:approval',
      phase: 'requested',
      status: 'pending',
    },
  ]));
  const afterLateUpdates = state.turnsById[turnId];
  const lateToolGroup = afterLateUpdates.items.find((item) => item.kind === 'tool-group');
  const lateApproval = afterLateUpdates.items.find((item) => item.kind === 'approval');
  assert.ok(lateToolGroup && lateToolGroup.kind === 'tool-group');
  assert.ok(lateApproval && lateApproval.kind === 'approval');
  assert.equal(afterLateUpdates.status, 'error');
  assert.equal(afterLateUpdates.evidence.pendingToolCount, 0);
  assert.equal(afterLateUpdates.evidence.pendingTaskCount, 0);
  assert.equal(afterLateUpdates.evidence.pendingApprovalCount, 0);
  assert.equal(state.aliases.activeBySession[sessionKey], undefined);
  assert.equal(lateToolGroup.entries[0]?.status, 'error');
  assert.equal(afterLateUpdates.taskById['chat-error-pending:task']?.status, 'error');
  assert.equal(lateApproval.status, 'error');
  assert.equal(lateApproval.actionable, false);
});

test('live chat and runtime errors keep recoverability separate from Turn lifecycle', () => {
  const sessionKey = 'agent:main:retry-error-semantics';
  const turnId = 'turn:retry-error-semantics';
  const occurredAt = 8_000;
  const requested: ConversationEvent = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    eventId: 'retry-error:requested',
    type: 'turn.requested',
    source: 'host',
    authority: 'authoritative',
    sessionKey,
    turnId,
    messageId: 'retry-error:user',
    occurredAt,
    receivedAt: occurredAt,
    replayed: false,
    data: {
      message: {
        role: 'user',
        id: 'retry-error:user',
        content: 'Repeat this exact request after a transient failure.',
        timestamp: occurredAt,
      },
    },
  };
  const chatErrors = chatEventToConversationEvents({
    state: 'error',
    sessionKey,
    runId: 'retry-error:run',
    errorMessage: 'ECONNRESET while reading the provider response',
  }, {
    sessionKey,
    turnId,
  });
  assert.deepEqual(chatErrors.map((event) => event.type), ['run.ended', 'turn.error']);
  const state = reduceConversationEvents(createEmptyConversationState(), [requested, ...chatErrors]);
  const turn = state.turnsById[turnId];
  const errorItem = turn.items.find((item) => item.kind === 'error');

  assert.ok(errorItem && errorItem.kind === 'error');
  assert.equal(errorItem.recoverable, true);
  assert.equal(errorItem.status, 'error');
  assert.equal(turn.status, 'error');

  const runtimeErrors = runtimeEventToConversationEvents({
    type: 'run.ended',
    runId: 'retry-error:runtime-run',
    sessionKey,
    status: 'error',
    error: 'connection reset by peer',
    ts: occurredAt + 1,
  });
  const runtimeError = runtimeErrors.find((event) => event.type === 'turn.error');
  assert.ok(runtimeError);
  assert.deepEqual(runtimeError.data, {
    error: 'connection reset by peer',
    recoverable: true,
  });

  const quotaError = chatEventToConversationEvents({
    state: 'error',
    sessionKey,
    errorMessage: 'Provider quota exceeded',
  }, { sessionKey, turnId }).find((event) => event.type === 'turn.error');
  assert.ok(quotaError);
  assert.deepEqual(quotaError.data, {
    error: 'Provider quota exceeded',
    recoverable: false,
  });
});
