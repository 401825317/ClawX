import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONVERSATION_EVENT_CONTRACT_VERSION,
  type ConversationEvent,
} from '../shared/conversation-events';
import {
  normalizeConversationTimelineMode,
  resolveConversationTimelineMode,
} from '../shared/conversation-rollout';
import type { ChatRuntimeEvent } from '../shared/chat-runtime-events';
import { historyMessagesToConversationEvents } from '../src/stores/conversation/history-adapter';
import { reduceConversationEvents } from '../src/stores/conversation/reducer';
import { runtimeEventToConversationEvent } from '../src/stores/conversation/runtime-adapter';
import {
  appendShadowComparison,
  createHistoryShadowComparison,
  createTerminalShadowComparison,
  shadowComparisonTelemetry,
  SHADOW_COMPARISON_RECORD_LIMIT,
  SHADOW_COMPARISON_SESSION_LIMIT,
  SHADOW_SNAPSHOT_ENTITY_LIMIT,
  SHADOW_SNAPSHOT_TURN_LIMIT,
} from '../src/stores/conversation/shadow-compare';
import { createEmptyConversationState } from '../src/stores/conversation/types';
import type { RawMessage } from '../src/stores/chat/types';

const SESSION_KEY = 'agent:main:shadow-test';

function historyFixture(options: { includeAttachment?: boolean } = {}): RawMessage[] {
  return [{
    id: 'shadow-user',
    role: 'user',
    content: 'private-user-prompt sk-live-user-secret',
    timestamp: 1_000,
  }, {
    id: 'shadow-tool',
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: 'shadow-tool-call',
      name: 'read_file',
      arguments: { token: 'sk-live-tool-argument' },
    }],
    timestamp: 1_001,
  }, {
    id: 'shadow-tool-result',
    role: 'toolresult',
    toolCallId: 'shadow-tool-call',
    toolName: 'read_file',
    content: 'sk-live-tool-result',
    timestamp: 1_002,
  }, {
    id: 'shadow-final',
    role: 'assistant',
    content: 'private-final-answer sk-live-final-secret',
    timestamp: 1_003,
    _attachedFiles: options.includeAttachment
      ? [{
          fileName: 'private-summary-value.txt',
          mimeType: 'text/plain',
          fileSize: 42,
          preview: 'https://private.example/preview?access_token=sk-live-preview-secret',
          filePath: '/Users/private/artifacts/sk-live-path-secret.txt',
          gatewayUrl: 'https://private.example/download?token=sk-live-url-secret',
          source: 'gateway-media',
          disposition: 'output-delivery',
        }]
      : undefined,
  }];
}

function richCanonicalState(messages: RawMessage[]) {
  let state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(SESSION_KEY, messages, { reason: 'initial-load' }),
  );
  const turnId = state.turnOrderBySession[SESSION_KEY][0];
  const runId = 'private-run-id-sk-live-run';
  const base = {
    version: CONVERSATION_EVENT_CONTRACT_VERSION,
    sessionKey: SESSION_KEY,
    turnId,
    rootRunId: runId,
    runId,
    receivedAt: 2_000,
    replayed: false,
  } as const;
  const events: ConversationEvent[] = [{
    ...base,
    eventId: 'private-event-tool-start',
    type: 'tool.started',
    source: 'openclaw-runtime',
    authority: 'authoritative',
    taskId: 'private-child-task-id',
    parentTaskId: 'private-parent-task-id',
    toolCallId: 'private-tool-call-id',
    occurredAt: 2_001,
    data: {
      toolCallId: 'private-tool-call-id',
      name: 'private-tool-name',
      args: { token: 'sk-live-private-tool-args' },
    },
  }, {
    ...base,
    eventId: 'private-event-tool-end',
    type: 'tool.completed',
    source: 'openclaw-runtime',
    authority: 'authoritative',
    taskId: 'private-child-task-id',
    parentTaskId: 'private-parent-task-id',
    toolCallId: 'private-tool-call-id',
    occurredAt: 2_002,
    data: {
      toolCallId: 'private-tool-call-id',
      name: 'private-tool-name',
      result: { secret: 'sk-live-private-tool-result' },
    },
  }, {
    ...base,
    eventId: 'private-event-task',
    type: 'task.updated',
    source: 'task-ledger',
    authority: 'authoritative',
    taskId: 'private-child-task-id',
    parentTaskId: 'private-parent-task-id',
    occurredAt: 2_003,
    data: {
      task: {
        taskId: 'private-child-task-id',
        parentTaskId: 'private-parent-task-id',
        title: 'private-task-title',
        detail: 'private-task-summary-value',
        status: 'completed',
        updatedAt: 2_003,
      },
    },
  }, {
    ...base,
    eventId: 'private-event-approval',
    type: 'approval.updated',
    source: 'openclaw-runtime',
    authority: 'authoritative',
    taskId: 'private-child-task-id',
    occurredAt: 2_004,
    data: {
      itemId: 'private-approval-id',
      title: 'private-approval-title',
      status: 'approved',
      message: 'sk-live-private-approval-message',
    },
  }, {
    ...base,
    eventId: 'private-event-artifact',
    type: 'artifact.updated',
    source: 'openclaw-runtime',
    authority: 'authoritative',
    taskId: 'private-child-task-id',
    occurredAt: 2_005,
    data: {
      artifact: {
        id: 'private-artifact-id',
        title: 'private-artifact-title',
        filePath: '/private/path/sk-live-artifact-path.txt',
        url: 'https://private.example/artifact?token=sk-live-artifact-url',
        mimeType: 'text/plain',
        sizeBytes: 64,
      },
    },
  }, {
    ...base,
    eventId: 'private-event-verification',
    type: 'verification.updated',
    source: 'plugin',
    authority: 'authoritative',
    taskId: 'private-child-task-id',
    occurredAt: 2_006,
    data: {
      verification: {
        id: 'private-verification-id',
        status: 'passed',
        title: 'private-verification-title',
        detail: 'private-verification-summary-value',
        evidence: 'sk-live-private-verification-evidence',
        artifactId: 'private-artifact-id',
        taskId: 'private-child-task-id',
      },
    },
  }, {
    ...base,
    eventId: 'private-event-terminal',
    type: 'run.ended',
    source: 'openclaw-runtime',
    authority: 'authoritative',
    occurredAt: 2_007,
    data: { status: 'completed' },
  }];
  state = reduceConversationEvents(state, events);
  return { state, turnId, runId };
}

test('normalizes only supported rollout modes', () => {
  assert.equal(normalizeConversationTimelineMode(' SHADOW '), 'shadow');
  assert.equal(normalizeConversationTimelineMode('legacy'), 'legacy');
  assert.equal(normalizeConversationTimelineMode('other'), null);
  assert.equal(resolveConversationTimelineMode(undefined, undefined), 'timeline');
  assert.equal(resolveConversationTimelineMode(undefined, 'shadow'), 'shadow');
  assert.equal(resolveConversationTimelineMode('legacy', 'timeline'), 'legacy');
});

test('history checkpoint compares semantic projection without retaining content or tool payloads', () => {
  const messages = historyFixture();
  const events = historyMessagesToConversationEvents(SESSION_KEY, messages, { reason: 'initial-load' });
  const state = reduceConversationEvents(createEmptyConversationState(), events);
  const comparison = createHistoryShadowComparison({
    state,
    sessionKey: SESSION_KEY,
    visibleMessages: messages,
    checkpointReason: 'initial-load',
    checkedAt: 10,
  });

  assert.equal(comparison.matched, true);
  assert.equal(comparison.legacy.turnCount, 1);
  assert.equal(comparison.canonical.finalAnswerCount, 1);

  const serialized = JSON.stringify(comparison);
  for (const secret of [
    'private-user-prompt',
    'sk-live-user-secret',
    'sk-live-tool-argument',
    'sk-live-tool-result',
    'private-final-answer',
    'sk-live-final-secret',
  ]) {
    assert.equal(serialized.includes(secret), false, `comparison leaked ${secret}`);
  }
});

test('history checkpoint reports structured semantic differences', () => {
  const messages = historyFixture();
  const state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(SESSION_KEY, messages, { reason: 'terminal-refresh' }),
  );
  const comparison = createHistoryShadowComparison({
    state,
    sessionKey: SESSION_KEY,
    visibleMessages: messages.slice(0, 3),
    checkpointReason: 'terminal-refresh',
  });

  assert.equal(comparison.matched, false);
  const differenceFields = comparison.differences.map((difference) => difference.field);
  for (const field of [
    'finalAnswerCount',
    'finalContent',
    'itemOrder',
    'itemStatus',
    'turnStatus',
    'terminalStatus',
    'terminalProvenance',
  ] as const) {
    assert.equal(differenceFields.includes(field), true, `missing semantic difference ${field}`);
  }
});

test('canonical snapshot covers entity relationships and authoritative terminal provenance', () => {
  const messages = historyFixture({ includeAttachment: true });
  const { state } = richCanonicalState(messages);
  const comparison = createHistoryShadowComparison({
    state,
    sessionKey: SESSION_KEY,
    visibleMessages: messages,
    checkpointReason: 'terminal-refresh',
  });
  const turn = comparison.canonicalSnapshot.turns[0];

  assert.ok(turn);
  assert.equal(turn.sessionRef, comparison.canonicalSnapshot.sessionRef);
  assert.equal(turn.tools.length >= 2, true);
  assert.equal(turn.tasks.length, 1);
  assert.equal(turn.artifacts.length >= 2, true);
  assert.equal(turn.verifications.length, 1);
  assert.equal(turn.approvals.length, 1);

  const task = turn.tasks[0];
  const relatedTool = turn.tools.find((tool) => tool.taskRef === task.ref);
  assert.ok(relatedTool);
  assert.match(task.ref, /^task:\d+$/u);
  assert.match(task.parentTaskRef ?? '', /^task:\d+$/u);
  assert.equal(relatedTool.parentTaskRef, task.parentTaskRef);
  assert.equal(turn.approvals[0].taskRef, task.ref);
  assert.deepEqual(turn.terminal, {
    status: 'completed',
    source: 'openclaw-runtime',
    authority: 'authoritative',
  });

  for (const field of [
    'sessionOwnership',
    'turnOwnership',
    'turnStatus',
    'itemOrder',
    'itemStatus',
    'tools',
    'tasks',
    'artifacts',
    'verifications',
    'approvals',
    'terminalStatus',
    'terminalProvenance',
  ] as const) {
    assert.equal(comparison.comparedFields.includes(field), true, `missing compared field ${field}`);
  }
});

test('comparison records and telemetry never retain raw content, payloads, paths, urls, or ids', () => {
  const messages = historyFixture({ includeAttachment: true });
  const { state } = richCanonicalState(messages);
  const comparison = createHistoryShadowComparison({
    state,
    sessionKey: SESSION_KEY,
    visibleMessages: messages,
    checkpointReason: 'terminal-refresh',
  });
  const serialized = JSON.stringify({
    comparison,
    telemetry: shadowComparisonTelemetry(comparison),
  });

  for (const sensitiveValue of [
    'private-user-prompt',
    'private-final-answer',
    'private-summary-value.txt',
    'private.example',
    '/Users/private/artifacts',
    '/private/path',
    'sk-live-',
    'private-tool-name',
    'private-task-title',
    'private-task-summary-value',
    'private-approval-title',
    'private-approval-message',
    'private-artifact-title',
    'private-verification-title',
    'private-verification-summary-value',
    'private-verification-evidence',
    'shadow-tool-call',
    'private-tool-call-id',
    'private-child-task-id',
    'private-parent-task-id',
    'private-artifact-id',
    'private-verification-id',
    'private-approval-id',
    'private-run-id',
    'private-event-',
  ]) {
    assert.equal(serialized.includes(sensitiveValue), false, `shadow diagnostics leaked ${sensitiveValue}`);
  }
});

test('authoritative terminal comparison uses run lifecycle only', () => {
  const runtimeEvents: ChatRuntimeEvent[] = [{
    type: 'run.started',
    producer: 'openclaw',
    runId: 'shadow-run',
    sessionKey: SESSION_KEY,
    startedAt: 2_000,
  }, {
    type: 'run.ended',
    producer: 'openclaw',
    runId: 'shadow-run',
    sessionKey: SESSION_KEY,
    status: 'completed',
    endedAt: 2_100,
  }];
  const canonicalEvents = runtimeEvents
    .map(runtimeEventToConversationEvent)
    .filter((event): event is NonNullable<typeof event> => Boolean(event));
  const state = reduceConversationEvents(createEmptyConversationState(), canonicalEvents);
  const matched = createTerminalShadowComparison({
    state,
    sessionKey: SESSION_KEY,
    runId: 'shadow-run',
    expectedStatus: 'completed',
    legacyRunStatus: 'completed',
  });
  const mismatched = createTerminalShadowComparison({
    state,
    sessionKey: SESSION_KEY,
    runId: 'shadow-run',
    expectedStatus: 'completed',
    legacyRunStatus: 'error',
  });

  assert.equal(matched?.matched, true);
  assert.equal(mismatched?.matched, false);
  assert.equal(mismatched?.differences[0]?.legacy, 'error');
});

test('shadow diagnostics stay bounded by session and record limits', () => {
  let cache = { bySession: {}, sessionOrder: [] };
  const comparison = createHistoryShadowComparison({
    state: createEmptyConversationState(),
    sessionKey: SESSION_KEY,
    visibleMessages: [],
  });

  for (let sessionIndex = 0; sessionIndex < SHADOW_COMPARISON_SESSION_LIMIT + 3; sessionIndex += 1) {
    const sessionKey = `session-${sessionIndex}`;
    for (let recordIndex = 0; recordIndex < SHADOW_COMPARISON_RECORD_LIMIT + 3; recordIndex += 1) {
      cache = appendShadowComparison(cache, sessionKey, { ...comparison, checkedAt: recordIndex });
    }
  }

  assert.equal(cache.sessionOrder.length, SHADOW_COMPARISON_SESSION_LIMIT);
  assert.equal(Object.keys(cache.bySession).length, SHADOW_COMPARISON_SESSION_LIMIT);
  assert.equal(cache.bySession[cache.sessionOrder.at(-1)!]?.length, SHADOW_COMPARISON_RECORD_LIMIT);
  assert.equal(cache.bySession['session-0'], undefined);
});

test('semantic snapshots preserve totals while bounding retained turns and entities', () => {
  const turnCount = SHADOW_SNAPSHOT_TURN_LIMIT + 5;
  const messages = Array.from({ length: turnCount }, (_, index): RawMessage[] => [{
    id: `bounded-user-${index}`,
    role: 'user',
    content: `bounded user ${index}`,
    timestamp: 10_000 + index * 2,
  }, {
    id: `bounded-final-${index}`,
    role: 'assistant',
    content: `bounded final ${index}`,
    timestamp: 10_001 + index * 2,
  }]).flat();
  const state = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(SESSION_KEY, messages, { reason: 'initial-load' }),
  );
  const comparison = createHistoryShadowComparison({
    state,
    sessionKey: SESSION_KEY,
    visibleMessages: messages,
  });

  assert.equal(comparison.canonicalSnapshot.turnCount, turnCount);
  assert.equal(comparison.canonicalSnapshot.turns.length, SHADOW_SNAPSHOT_TURN_LIMIT);
  assert.equal(comparison.canonicalSnapshot.omittedTurnCount, turnCount - SHADOW_SNAPSHOT_TURN_LIMIT);

  const toolCount = SHADOW_SNAPSHOT_ENTITY_LIMIT + 5;
  const toolMessages: RawMessage[] = [{
    id: 'bounded-tool-user',
    role: 'user',
    content: 'run bounded tools',
    timestamp: 20_000,
  }, {
    id: 'bounded-tool-starts',
    role: 'assistant',
    content: Array.from({ length: toolCount }, (_, index) => ({
      type: 'toolCall',
      id: `bounded-tool-${index}`,
      name: 'read_file',
      arguments: { index },
    })),
    timestamp: 20_001,
  }, ...Array.from({ length: toolCount }, (_, index): RawMessage => ({
    id: `bounded-tool-result-${index}`,
    role: 'toolresult',
    toolCallId: `bounded-tool-${index}`,
    toolName: 'read_file',
    content: `result ${index}`,
    timestamp: 20_002 + index,
  })), {
    id: 'bounded-tool-final',
    role: 'assistant',
    content: 'bounded tools completed',
    timestamp: 20_100,
  }];
  const toolState = reduceConversationEvents(
    createEmptyConversationState(),
    historyMessagesToConversationEvents(SESSION_KEY, toolMessages, { reason: 'initial-load' }),
  );
  const toolComparison = createHistoryShadowComparison({
    state: toolState,
    sessionKey: SESSION_KEY,
    visibleMessages: toolMessages,
  });
  const toolTurn = toolComparison.canonicalSnapshot.turns[0];

  assert.ok(toolTurn);
  assert.equal(toolTurn.toolCount, toolCount);
  assert.equal(toolTurn.tools.length, SHADOW_SNAPSHOT_ENTITY_LIMIT);
  assert.equal(toolTurn.omittedToolCount, toolCount - SHADOW_SNAPSHOT_ENTITY_LIMIT);
  assert.equal(toolTurn.tools[0].ref, 'tool:1');
  assert.equal(toolTurn.tools.at(-1)?.ref, `tool:${toolCount}`);
});
