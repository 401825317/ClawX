import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatRuntimeEvent } from '../shared/chat-runtime-events.ts';
import {
  buildRuntimeStartEventsForRun,
  clearPendingRuntimeIntent,
  isDuplicateChatEvent,
  rememberPendingRuntimeIntent,
  updateCachedSessionRunStateFromRuntimeEvent,
} from '../src/stores/chat/runtime-control.ts';
import {
  captureSessionRunState,
  clearCachedSessionRunState,
  DEFAULT_SESSION_RUN_STATE,
} from '../src/stores/chat/session-controller.ts';
import type { ChatState } from '../src/stores/chat/types.ts';

test('second-based run.ended settles a background untracked send', () => {
  const sessionKey = 'agent:main:runtime-control-second-terminal';
  const runId = 'run-second-terminal';
  const lastUserMessageAt = 1_700_000_000_000;
  const eventTimestampSeconds = (lastUserMessageAt + 1_000) / 1_000;
  const event: ChatRuntimeEvent = {
    runId,
    sessionKey,
    ts: eventTimestampSeconds,
    type: 'run.ended',
    status: 'completed',
  };
  const runtimeRuns: ChatState['runtimeRuns'] = {
    [runId]: {
      runId,
      sessionKey,
      status: 'completed',
      startedAt: eventTimestampSeconds,
      lastEventAt: eventTimestampSeconds,
      endedAt: eventTimestampSeconds,
      assistantText: '',
      thinkingText: '',
      events: [event],
    },
  };

  captureSessionRunState(sessionKey, {
    ...DEFAULT_SESSION_RUN_STATE,
    sending: true,
    lastUserMessageAt,
  });

  try {
    assert.equal(
      updateCachedSessionRunStateFromRuntimeEvent(event, runtimeRuns),
      sessionKey,
    );
  } finally {
    clearCachedSessionRunState(sessionKey);
  }
});

test('remembering a new runtime intent prunes expired session intents', (t) => {
  const expiredSessionKey = 'agent:main:runtime-control-expired-intent';
  const freshSessionKey = 'agent:main:runtime-control-fresh-intent';
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);

  rememberPendingRuntimeIntent(expiredSessionKey, {
    objective: 'expired objective',
    mode: 'chat',
  });
  now += 10 * 60 * 1_000;
  rememberPendingRuntimeIntent(freshSessionKey, {
    objective: 'fresh objective',
    mode: 'chat',
  });

  try {
    const expiredStart = buildRuntimeStartEventsForRun({}, {
      runId: 'run-expired-intent',
      sessionKey: expiredSessionKey,
      ts: now,
    });
    const freshStart = buildRuntimeStartEventsForRun({}, {
      runId: 'run-fresh-intent',
      sessionKey: freshSessionKey,
      ts: now,
    });

    assert.equal(expiredStart[0]?.type, 'run.started');
    assert.equal(expiredStart[0]?.objective, undefined);
    assert.equal(freshStart[0]?.type, 'run.started');
    assert.equal(freshStart[0]?.objective, 'fresh objective');
  } finally {
    clearPendingRuntimeIntent(expiredSessionKey);
    clearPendingRuntimeIntent(freshSessionKey);
  }
});

test('pending runtime intents stay bounded and retain the newest session', () => {
  const sessionKeys = Array.from(
    { length: 256 },
    (_, index) => `agent:main:runtime-control-bounded-intent-${index}`,
  );

  for (const [index, sessionKey] of sessionKeys.entries()) {
    rememberPendingRuntimeIntent(sessionKey, {
      objective: `objective-${index}`,
      mode: 'chat',
    });
  }

  try {
    const oldestStart = buildRuntimeStartEventsForRun({}, {
      runId: 'run-oldest-bounded-intent',
      sessionKey: sessionKeys[0],
    });
    const newestStart = buildRuntimeStartEventsForRun({}, {
      runId: 'run-newest-bounded-intent',
      sessionKey: sessionKeys.at(-1),
    });

    assert.equal(oldestStart[0]?.objective, undefined);
    assert.equal(newestStart[0]?.objective, 'objective-255');
  } finally {
    for (const sessionKey of sessionKeys) clearPendingRuntimeIntent(sessionKey);
  }
});

test('chat event dedupe stays bounded and retains the newest event', () => {
  const eventCount = 9_000;
  const eventState = 'runtime';
  const eventForIndex = (index: number): Record<string, unknown> => ({
    runId: `runtime-control-dedupe-${index}`,
    sessionKey: 'agent:main:runtime-control-dedupe',
    seq: index,
  });

  for (let index = 0; index < eventCount; index += 1) {
    assert.equal(isDuplicateChatEvent(eventState, eventForIndex(index)), false);
  }

  assert.equal(isDuplicateChatEvent(eventState, eventForIndex(eventCount - 1)), true);
  assert.equal(isDuplicateChatEvent(eventState, eventForIndex(0)), false);
});
