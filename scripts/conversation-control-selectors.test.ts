import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatRuntimeTaskProjection } from '../shared/chat-runtime-events.ts';
import type { ConversationMessageSnapshot } from '../shared/conversation-events.ts';
import {
  collectCancellableTasks,
  resolveCanonicalEventSession,
  resolveCompletionWakeCorrelation,
  resolveUniqueTurnOwner,
  selectActiveTurn,
  selectLastRetryableUserTrigger,
  selectLatestRecoverableErrorTurnId,
  selectLatestUsableImage,
  selectRunningAgentIds,
  selectSessionBusy,
} from '../src/stores/conversation/control-selectors.ts';
import {
  createEmptyConversationState,
  EMPTY_TURN_EVIDENCE,
  type ConversationState,
  type ConversationTurn,
  type TimelineItem,
  type TurnStatus,
} from '../src/stores/conversation/types.ts';

function task(
  taskId: string,
  status: ChatRuntimeTaskProjection['status'],
  overrides: Partial<ChatRuntimeTaskProjection> = {},
): ChatRuntimeTaskProjection {
  return {
    taskId,
    title: taskId,
    status,
    ...overrides,
  };
}

function turn(input: {
  id: string;
  sessionKey: string;
  rootRunId?: string;
  status?: TurnStatus;
  message?: ConversationMessageSnapshot;
  tasks?: ChatRuntimeTaskProjection[];
  items?: TimelineItem[];
  createdAt?: number;
}): ConversationTurn {
  const createdAt = input.createdAt ?? 100;
  const triggerId = `${input.id}:trigger`;
  const trigger = {
    id: triggerId,
    turnId: input.id,
    kind: 'user-message' as const,
    status: 'completed' as const,
    firstSeenAt: createdAt,
    updatedAt: createdAt,
    sourceEventIds: [`${triggerId}:event`],
    revision: 1,
    message: input.message ?? { role: 'user', content: input.id, timestamp: createdAt },
  };
  const tasks = input.tasks ?? [];
  const items = input.items ?? [trigger];
  return {
    id: input.id,
    sessionKey: input.sessionKey,
    trigger,
    status: input.status ?? 'running',
    rootRunId: input.rootRunId,
    runAliases: input.rootRunId ? [input.rootRunId] : [],
    taskIds: tasks.map((entry) => entry.taskId),
    items,
    itemIndex: Object.fromEntries(items.map((item, index) => [item.id, index])),
    toolItemByCallId: {},
    toolMergeByCallId: {},
    approvalMergeById: {},
    taskItemById: {},
    taskById: Object.fromEntries(tasks.map((entry) => [entry.taskId, entry])),
    taskMergeById: {},
    artifactEntityByAlias: {},
    artifactItemByEntity: {},
    artifactMergeByEntity: {},
    verificationEntityByAlias: {},
    verificationItemByEntity: {},
    verificationMergeByEntity: {},
    finalMerge: { fields: {} },
    sequenceWatermarks: {},
    hasLiveEvidence: true,
    evidence: { ...EMPTY_TURN_EVIDENCE },
    createdAt,
    updatedAt: Math.max(createdAt, ...items.map((item) => item.updatedAt)),
    revision: 1,
  };
}

function conversationState(turns: ConversationTurn[]): ConversationState {
  const state = createEmptyConversationState();
  for (const entry of turns) {
    state.turnsById[entry.id] = entry;
    state.turnOrderBySession[entry.sessionKey] = [
      ...(state.turnOrderBySession[entry.sessionKey] ?? []),
      entry.id,
    ];
  }
  return state;
}

test('background completion wake resolves a unique task owner without borrowing the selected session', () => {
  const backgroundSession = 'agent:media:background-owner';
  const taskId = 'task-background-image';
  const owner = turn({
    id: 'turn-background-owner',
    sessionKey: backgroundSession,
    rootRunId: 'run-background-owner',
    status: 'running',
    tasks: [task(taskId, 'running', { runtime: 'image_generate' })],
  });
  const state = conversationState([
    turn({ id: 'turn-selected', sessionKey: 'agent:main:selected', rootRunId: 'run-selected' }),
    owner,
  ]);
  const before = JSON.stringify(state);
  const childRunId = `image_generate:${taskId}:final`;

  assert.equal(resolveUniqueTurnOwner(state, { taskId })?.id, owner.id);
  assert.deepEqual(resolveCompletionWakeCorrelation(state, { runId: childRunId }), {
    turnId: owner.id,
    runId: childRunId,
    rootRunId: 'run-background-owner',
    sessionKey: backgroundSession,
    taskId,
  });
  assert.equal(JSON.stringify(state), before);
});

test('owner resolution rejects cross-session ambiguity and contradictory explicit identities', () => {
  const sharedTaskId = 'task-shared-across-sessions';
  const left = turn({
    id: 'turn-left',
    sessionKey: 'agent:left:main',
    rootRunId: 'run-left',
    tasks: [task(sharedTaskId, 'running')],
  });
  const right = turn({
    id: 'turn-right',
    sessionKey: 'agent:right:main',
    rootRunId: 'run-right',
    tasks: [task(sharedTaskId, 'running'), task('task-right-only', 'running')],
  });
  const state = conversationState([left, right]);

  assert.equal(resolveUniqueTurnOwner(state, { taskId: sharedTaskId }), null);
  assert.equal(resolveCompletionWakeCorrelation(state, {
    runId: `video_generate:${sharedTaskId}:final`,
  }), null);
  assert.equal(resolveUniqueTurnOwner(state, {
    sessionKey: left.sessionKey,
    taskId: sharedTaskId,
  })?.id, left.id);
  assert.equal(resolveUniqueTurnOwner(state, {
    sessionKey: left.sessionKey,
    runId: 'run-left',
    taskId: 'task-right-only',
  }), null);
  assert.equal(resolveCompletionWakeCorrelation(state, {
    runId: `image_generate:${sharedTaskId}:final`,
    sessionKey: left.sessionKey,
    taskId: 'task-right-only',
  }), null);
  assert.equal(resolveCompletionWakeCorrelation(state, {
    runId: 'image_generate:task-missing:final',
    sessionKey: left.sessionKey,
  }), null);
});

test('completion wake rejects multiple canonical owners even inside one explicit session', () => {
  const sessionKey = 'agent:main:ambiguous';
  const taskId = 'task-ambiguous';
  const state = conversationState([
    turn({
      id: 'turn-ambiguous-left',
      sessionKey,
      rootRunId: 'run-ambiguous-left',
      tasks: [task(taskId, 'running')],
    }),
    turn({
      id: 'turn-ambiguous-right',
      sessionKey,
      rootRunId: 'run-ambiguous-right',
      tasks: [task(taskId, 'running')],
    }),
  ]);

  assert.equal(resolveCompletionWakeCorrelation(state, {
    runId: `video_generate:${taskId}:final`,
    sessionKey,
  }), null);
});

test('general event routing uses canonical owners and only one pending local Turn', () => {
  const owner = turn({
    id: 'turn-general-owner',
    sessionKey: 'agent:worker:owned',
    rootRunId: 'run-general-owner',
  });
  const pending = turn({
    id: 'turn-general-pending',
    sessionKey: 'agent:main:pending',
  });
  const state = conversationState([owner, pending]);
  state.aliases.pendingLocalBySession[pending.sessionKey] = pending.id;

  assert.deepEqual(resolveCanonicalEventSession(state, { runId: owner.rootRunId }), {
    sessionKey: owner.sessionKey,
    turnId: owner.id,
    rootRunId: owner.rootRunId,
  });
  assert.deepEqual(resolveCanonicalEventSession(state, {
    sessionKey: 'agent:remote:explicit',
    runId: 'run-first-seen',
  }), {
    sessionKey: 'agent:remote:explicit',
  });
  assert.equal(resolveCanonicalEventSession(state, {
    sessionKey: 'agent:remote:contradiction',
    runId: owner.rootRunId,
  }), null);
  assert.equal(resolveCanonicalEventSession(state, { runId: 'run-unknown' }), null);
  assert.deepEqual(resolveCanonicalEventSession(
    state,
    { runId: 'run-first-local-event' },
    { allowPendingLocal: true },
  ), {
    sessionKey: pending.sessionKey,
    turnId: pending.id,
  });

  const secondPending = turn({
    id: 'turn-general-pending-second',
    sessionKey: 'agent:other:pending',
  });
  state.turnsById[secondPending.id] = secondPending;
  state.turnOrderBySession[secondPending.sessionKey] = [secondPending.id];
  state.aliases.pendingLocalBySession[secondPending.sessionKey] = secondPending.id;
  assert.equal(resolveCanonicalEventSession(
    state,
    { runId: 'run-ambiguous-local-event' },
    { allowPendingLocal: true },
  ), null);
});

test('abort selection separates Host tasks and excludes every terminal task signal', () => {
  const activeTurn = turn({
    id: 'turn-abort',
    sessionKey: 'agent:main:abort',
    rootRunId: 'run-abort',
    tasks: [
      task('host-running', 'running', { runtime: 'uclaw-host-task' }),
      task('native-pending', 'pending', { runtime: 'video_generate' }),
      task('native-approval', 'waiting_approval'),
      task('host-completed', 'completed', { runtime: 'uclaw-host-task' }),
      task('native-error', 'error'),
      task('host-cancelled', 'running', { runtime: 'uclaw-host-task', sourceStatus: 'cancelled' }),
      task('native-ended', 'running', { endedAt: 900 }),
      task('native-delivered', 'running', { deliveryStatus: 'delivered' }),
    ],
  });

  const selected = collectCancellableTasks(activeTurn);
  assert.deepEqual(selected.taskIds, ['host-running', 'native-pending', 'native-approval']);
  assert.deepEqual(selected.hostTaskIds, ['host-running']);
  assert.deepEqual(selected.nativeTaskIds, ['native-pending', 'native-approval']);
});

test('active Turn selection drives canonical busy state and repairs stale indexes by order', () => {
  const sessionKey = 'agent:main:busy';
  const completed = turn({ id: 'turn-completed', sessionKey, status: 'completed', createdAt: 100 });
  const running = turn({ id: 'turn-running', sessionKey, status: 'waiting_approval', createdAt: 200 });
  const state = conversationState([completed, running]);
  state.aliases.activeBySession[sessionKey] = completed.id;

  assert.equal(selectActiveTurn(state, sessionKey)?.id, running.id);
  assert.equal(selectSessionBusy(state, sessionKey), true);

  const terminal = conversationState([completed]);
  terminal.aliases.activeBySession[sessionKey] = completed.id;
  assert.equal(selectActiveTurn(terminal, sessionKey), null);
  assert.equal(selectSessionBusy(terminal, sessionKey), false);
});

test('retry and image selectors stay session-scoped and skip unusable recent evidence', () => {
  const sessionKey = 'agent:main:retry-image';
  const first = turn({
    id: 'turn-first',
    sessionKey,
    status: 'completed',
    createdAt: 100,
    message: {
      role: 'user',
      content: 'Initial image request',
      timestamp: 100,
      attachments: [{
        fileName: 'input.png',
        mimeType: 'image/png',
        fileSize: 10,
        filePath: '/tmp/input.png',
        preview: null,
        source: 'user-upload',
        disposition: 'input-reference',
      }],
    },
  });
  const secondBase = turn({
    id: 'turn-second',
    sessionKey,
    status: 'completed',
    createdAt: 300,
    message: { role: 'user', content: 'Retry this latest real request', timestamp: 300 },
  });
  const finalAnswer: TimelineItem = {
    id: 'turn-second:final',
    turnId: secondBase.id,
    kind: 'final-answer',
    status: 'completed',
    firstSeenAt: 400,
    updatedAt: 400,
    sourceEventIds: ['final-event'],
    revision: 1,
    authoritative: true,
    message: {
      role: 'assistant',
      content: 'Generated image',
      timestamp: 400,
      attachments: [{
        fileName: 'final.png',
        mimeType: 'image/png',
        fileSize: 20,
        filePath: '/tmp/final.png',
        preview: null,
        source: 'gateway-media',
        disposition: 'output-delivery',
      }],
    },
  };
  const second = { ...secondBase, items: [secondBase.trigger, finalAnswer], updatedAt: 400 };
  const emptyBase = turn({
    id: 'turn-empty',
    sessionKey,
    status: 'completed',
    createdAt: 500,
    message: { role: 'user', content: '', timestamp: 500 },
  });
  const unavailableArtifact: TimelineItem = {
    id: 'turn-empty:artifact',
    turnId: emptyBase.id,
    kind: 'artifact-group',
    status: 'blocked',
    firstSeenAt: 600,
    updatedAt: 600,
    sourceEventIds: ['artifact-event'],
    revision: 1,
    artifacts: [{
      id: 'unavailable-image',
      filePath: '/tmp/unavailable.png',
      mimeType: 'image/png',
      availability: 'unavailable',
    }],
    changes: [],
  };
  const registeredArtifact: TimelineItem = {
    ...unavailableArtifact,
    id: 'turn-empty:registered-artifact',
    status: 'pending',
    artifacts: [{
      id: 'registered-image',
      filePath: '/tmp/registered.png',
      mimeType: 'image/png',
      availability: 'registered',
    }],
  };
  const carriedInput: TimelineItem = {
    id: 'turn-empty:final',
    turnId: emptyBase.id,
    kind: 'final-answer',
    status: 'completed',
    firstSeenAt: 700,
    updatedAt: 700,
    sourceEventIds: ['carried-input-event'],
    revision: 1,
    authoritative: true,
    message: {
      role: 'assistant',
      content: '',
      timestamp: 700,
      attachments: [{
        fileName: 'input.png',
        mimeType: 'image/png',
        fileSize: 10,
        filePath: '/tmp/input.png',
        preview: null,
        source: 'user-upload',
        disposition: 'input-reference',
      }],
    },
  };
  const empty = {
    ...emptyBase,
    items: [emptyBase.trigger, unavailableArtifact, registeredArtifact, carriedInput],
    updatedAt: 700,
  };
  const otherSession = turn({
    id: 'turn-other-session',
    sessionKey: 'agent:other:main',
    status: 'completed',
    createdAt: 1_000,
    message: {
      role: 'user',
      content: 'Other session',
      attachments: [{
        fileName: 'other.png',
        mimeType: 'image/png',
        fileSize: 30,
        filePath: '/tmp/other.png',
        preview: null,
      }],
    },
  });
  const state = conversationState([first, second, empty, otherSession]);

  assert.equal(selectLastRetryableUserTrigger(state, sessionKey)?.turnId, second.id);
  assert.deepEqual(selectLatestUsableImage(state, sessionKey), {
    turnId: second.id,
    itemId: finalAnswer.id,
    fileName: 'final.png',
    mimeType: 'image/png',
    fileSize: 20,
    filePath: '/tmp/final.png',
    preview: null,
    source: 'final-answer',
  });
});

test('retry command selector exposes only the latest recoverable failed Turn', () => {
  const sessionKey = 'agent:main:recoverable-error';
  const recoverableBase = turn({
    id: 'turn-recoverable-error',
    sessionKey,
    status: 'error',
    createdAt: 100,
  });
  const recoverableError: TimelineItem = {
    id: 'error:turn-recoverable-error',
    turnId: recoverableBase.id,
    kind: 'error',
    status: 'error',
    firstSeenAt: 101,
    updatedAt: 101,
    sourceEventIds: ['recoverable-error-event'],
    revision: 1,
    message: 'connection reset',
    recoverable: true,
  };
  const recoverable = turn({
    ...recoverableBase,
    items: [recoverableBase.trigger, recoverableError],
  });
  const state = conversationState([recoverable]);

  assert.equal(selectLatestRecoverableErrorTurnId(state, sessionKey), recoverable.id);

  const laterSuccess = turn({
    id: 'turn-later-success',
    sessionKey,
    status: 'completed',
    createdAt: 200,
  });
  state.turnsById[laterSuccess.id] = laterSuccess;
  state.turnOrderBySession[sessionKey].push(laterSuccess.id);
  assert.equal(selectLatestRecoverableErrorTurnId(state, sessionKey), null);

  const nonRecoverableBase = turn({
    id: 'turn-non-recoverable-error',
    sessionKey,
    status: 'error',
    createdAt: 300,
  });
  const nonRecoverable = turn({
    ...nonRecoverableBase,
    items: [nonRecoverableBase.trigger, {
      ...recoverableError,
      id: 'error:turn-non-recoverable-error',
      turnId: nonRecoverableBase.id,
      message: 'provider quota exceeded',
      recoverable: false,
    }],
  });
  state.turnsById[nonRecoverable.id] = nonRecoverable;
  state.turnOrderBySession[sessionKey].push(nonRecoverable.id);
  assert.equal(selectLatestRecoverableErrorTurnId(state, sessionKey), null);
});

test('running agent ids combine backend sessions with active canonical Turns', () => {
  const beta = turn({
    id: 'turn-beta-running',
    sessionKey: 'agent:beta:main',
    status: 'running',
  });
  const gamma = turn({
    id: 'turn-gamma-completed',
    sessionKey: 'agent:gamma:main',
    status: 'completed',
  });
  const state = conversationState([beta, gamma]);
  state.aliases.activeBySession[beta.sessionKey] = beta.id;

  assert.deepEqual(selectRunningAgentIds(state, [
    { key: 'agent:alpha:main', hasActiveRun: true },
    { key: 'agent:beta:main', status: 'idle' },
    { key: 'external-session', status: 'processing' },
    { key: 'agent:gamma:main', status: 'completed' },
  ]), ['alpha', 'beta', 'main']);
});
