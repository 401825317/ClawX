import assert from 'node:assert/strict';
import test from 'node:test';

import { applyAsyncTaskEvidenceToRuns } from '../src/stores/chat/helpers.ts';
import type { AsyncTaskEvidence, ChatRuntimeRunState } from '../src/stores/chat/types.ts';

function runtimeRun(evidence: AsyncTaskEvidence): Record<string, ChatRuntimeRunState> {
  return {
    'history:session-a:run-1': {
      runId: 'history:session-a:run-1',
      sessionKey: 'session-a',
      status: 'running',
      lastEventAt: evidence.updatedAt,
      assistantText: '',
      thinkingText: '',
      events: [],
      asyncTaskLedger: {
        [evidence.id]: evidence,
      },
    },
  };
}

const pendingEvidence: AsyncTaskEvidence = {
  id: 'task:video-task-1',
  taskId: 'video-task-1',
  status: 'pending',
  source: 'tool-result',
  updatedAt: 300,
};

const terminalEvidence: AsyncTaskEvidence = {
  id: 'task:video-task-1',
  taskId: 'video-task-1',
  status: 'error',
  source: 'task-completion',
  updatedAt: 200,
};

test('terminal task evidence overrides a newer pending history snapshot', () => {
  const runs = applyAsyncTaskEvidenceToRuns(
    runtimeRun(pendingEvidence),
    null,
    [terminalEvidence],
    'session-a',
  );

  assert.equal(
    runs['history:session-a:run-1']?.asyncTaskLedger?.['task:video-task-1']?.status,
    'error',
  );
});

test('a replayed pending snapshot cannot downgrade terminal task evidence', () => {
  const terminalRuns = runtimeRun(terminalEvidence);
  const runs = applyAsyncTaskEvidenceToRuns(
    terminalRuns,
    null,
    [{ ...pendingEvidence, updatedAt: 400 }],
    'session-a',
  );

  assert.equal(
    runs['history:session-a:run-1']?.asyncTaskLedger?.['task:video-task-1']?.status,
    'error',
  );
});
