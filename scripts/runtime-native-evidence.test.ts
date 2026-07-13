import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatRuntimeEvent } from '../shared/chat-runtime-events.ts';
import {
  buildRuntimeArtifactEventsFromAttachedFiles,
  buildRuntimeStartEvents,
  hasDeliveredArtifactEvidence,
} from '../src/stores/chat/runtime-evidence.ts';
import { applyRuntimeEventToRuns } from '../src/stores/chat/runtime-graph.ts';
import type { ChatRuntimeRunState } from '../src/stores/chat/types.ts';

const runId = 'run-native-lifecycle';
const sessionKey = 'agent:main:native-lifecycle';

function apply(events: ChatRuntimeEvent[]): ChatRuntimeRunState {
  let runs: Record<string, ChatRuntimeRunState> = {};
  for (const event of events) runs = applyRuntimeEventToRuns(runs, event);
  return runs[runId]!;
}

test('renderer seeds only observable native run state', () => {
  const events = buildRuntimeStartEvents(undefined, {
    runId,
    sessionKey,
    objective: '用三句话解释 RAG，并写一页发布会文案',
    mode: 'chat',
    ts: 1,
  });

  assert.deepEqual(events.map((event) => event.type), ['run.started']);
});

test('artifact tracking emits only artifact and verification evidence', () => {
  const events = buildRuntimeArtifactEventsFromAttachedFiles({
    runId,
    sessionKey,
    ts: 2,
  }, [{
    fileName: 'deck.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    fileSize: 1024,
    preview: null,
    filePath: '/tmp/deck.pptx',
  }]);

  assert.deepEqual(events.map((event) => event.type), ['artifact.produced', 'verification.completed']);
});

test('a native terminal event ends the run even when an earlier unrelated tool failed', () => {
  const run = apply([
    ...buildRuntimeStartEvents(undefined, { runId, sessionKey, ts: 1 }),
    {
      type: 'tool.completed',
      runId,
      sessionKey,
      ts: 2,
      toolCallId: 'failed-search',
      name: 'web_fetch',
      isError: true,
      result: { error: 'temporary failure' },
    },
    {
      type: 'tool.completed',
      runId,
      sessionKey,
      ts: 3,
      toolCallId: 'successful-fallback',
      name: 'read',
      isError: false,
      result: { ok: true },
    },
    {
      type: 'run.ended',
      runId,
      sessionKey,
      ts: 4,
      endedAt: 4,
      status: 'completed',
    },
  ]);

  assert.equal(run.status, 'completed');
  assert.equal(run.endedAt, 4);
});

test('empty final delivery requires an attachment or passed artifact verification', () => {
  const executionOnlyRun = apply([
    ...buildRuntimeStartEvents(undefined, { runId, sessionKey, ts: 1 }),
    {
      type: 'tool.completed',
      runId,
      sessionKey,
      ts: 2,
      toolCallId: 'mkdir-only',
      name: 'exec',
      isError: false,
    },
  ]);
  assert.equal(hasDeliveredArtifactEvidence(executionOnlyRun, []), false);

  const blockedRun = apply([
    ...executionOnlyRun.events,
    {
      type: 'artifact.produced',
      runId,
      sessionKey,
      ts: 3,
      artifact: { id: 'artifact:test', filePath: '/missing/test.png' },
    },
    {
      type: 'verification.completed',
      runId,
      sessionKey,
      ts: 4,
      verification: {
        id: 'verification:artifact:test',
        artifactId: 'artifact:test',
        status: 'blocked',
        required: true,
      },
    },
  ]);
  assert.equal(hasDeliveredArtifactEvidence(blockedRun, []), false);

  const passedRun = apply([
    ...blockedRun.events,
    {
      type: 'verification.completed',
      runId,
      sessionKey,
      ts: 5,
      verification: {
        id: 'verification:artifact:test:passed',
        artifactId: 'artifact:test',
        status: 'passed',
        required: true,
      },
    },
  ]);
  assert.equal(hasDeliveredArtifactEvidence(passedRun, []), true);
  assert.equal(hasDeliveredArtifactEvidence(undefined, [{
    fileName: 'missing.png',
    mimeType: 'image/png',
    fileSize: 0,
    preview: null,
    filePath: '/missing/generated.png',
  }]), false);
  assert.equal(hasDeliveredArtifactEvidence(undefined, [{
    fileName: 'generated.png',
    mimeType: 'image/png',
    fileSize: 1,
    preview: null,
    filePath: '/tmp/generated.png',
  }]), true);
});
