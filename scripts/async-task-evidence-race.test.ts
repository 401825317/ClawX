import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyAsyncTaskEvidenceToRuns,
  collectRunDetachedTaskIdsForAbort,
} from '../src/stores/chat/helpers.ts';
import type { ChatRuntimeRunState } from '../src/stores/chat/types.ts';

function run(runId: string): ChatRuntimeRunState {
  return {
    runId,
    sessionKey: 'agent:main:session-1',
    status: 'running',
    lastEventAt: 1,
    assistantText: '',
    thinkingText: '',
    events: [],
  };
}

test('late spawn evidence binds an already observed ledger task back to the main run', () => {
  const taskEvidence = {
    id: 'task:task-1',
    taskId: 'task-1',
    runId: 'child-run',
    childSessionKey: 'agent:main:subagent:child',
    status: 'pending' as const,
    source: 'task-completion' as const,
    updatedAt: 10,
  };
  let runs = applyAsyncTaskEvidenceToRuns(
    { 'child-run': run('child-run') },
    'child-run',
    [taskEvidence],
    'agent:main:session-1',
  );
  runs = applyAsyncTaskEvidenceToRuns(
    { ...runs, 'main-run': run('main-run') },
    'main-run',
    [{ ...taskEvidence, source: 'tool-result', updatedAt: 20 }],
    'agent:main:session-1',
  );

  assert.equal(runs['main-run']?.asyncTaskLedger?.['task:task-1']?.taskId, 'task-1');
  assert.equal(runs['main-run']?.asyncTaskLedger?.['task:task-1']?.status, 'pending');
});

test('abort only selects detached tasks explicitly bound to the active run', () => {
  const current = run('run-current');
  current.asyncTaskLedger = {
    image: {
      id: 'image',
      taskId: 'task-current-image',
      status: 'pending',
      source: 'tool-result',
      updatedAt: 20,
    },
  };
  current.tasks = [{
    taskId: 'task-current-subagent',
    title: 'current child',
    status: 'running',
  }];

  const previous = run('run-previous');
  previous.asyncTaskLedger = {
    video: {
      id: 'video',
      taskId: 'task-previous-video',
      status: 'pending',
      source: 'tool-result',
      updatedAt: 19,
    },
  };
  previous.tasks = [{
    taskId: 'task-previous-subagent',
    title: 'previous child',
    status: 'waiting_approval',
  }];

  assert.deepEqual(
    collectRunDetachedTaskIdsForAbort({
      'run-current': current,
      'run-previous': previous,
    }, 'run-current'),
    ['task-current-image', 'task-current-subagent'],
  );
});

test('a terminal ledger update propagates from a detached run back to a pending main ledger', () => {
  const pending = {
    id: 'task:video-1',
    taskId: 'video-1',
    runId: 'child-run',
    status: 'pending' as const,
    source: 'tool-result' as const,
    updatedAt: 20,
  };
  let runs = applyAsyncTaskEvidenceToRuns(
    { 'main-run': run('main-run') },
    'main-run',
    [pending],
    'agent:main:session-1',
  );
  runs = applyAsyncTaskEvidenceToRuns(
    { ...runs, 'child-run': run('child-run') },
    'child-run',
    [{ ...pending, status: 'completed', source: 'task-completion', updatedAt: 30 }],
    'agent:main:session-1',
  );
  assert.equal(runs['main-run']?.asyncTaskLedger?.['task:video-1']?.status, 'completed');
  assert.equal(runs['main-run']?.asyncTaskLedger?.['task:video-1']?.updatedAt, 30);

  runs = applyAsyncTaskEvidenceToRuns(
    runs,
    'main-run',
    [pending],
    'agent:main:session-1',
  );
  assert.equal(runs['main-run']?.asyncTaskLedger?.['task:video-1']?.status, 'completed');
  assert.equal(runs['main-run']?.asyncTaskLedger?.['task:video-1']?.updatedAt, 30);
});

test('newer terminal evidence wins while older terminal evidence cannot overwrite it', () => {
  const baseEvidence = {
    id: 'task:race',
    taskId: 'race',
    status: 'error' as const,
    source: 'task-completion' as const,
    updatedAt: 30,
  };
  let runs = applyAsyncTaskEvidenceToRuns(
    { 'main-run': run('main-run') },
    'main-run',
    [baseEvidence],
    'agent:main:session-1',
  );
  runs = applyAsyncTaskEvidenceToRuns(
    runs,
    'main-run',
    [{ ...baseEvidence, status: 'completed', updatedAt: 20 }],
    'agent:main:session-1',
  );
  assert.equal(runs['main-run']?.asyncTaskLedger?.['task:race']?.status, 'error');

  runs = applyAsyncTaskEvidenceToRuns(
    runs,
    'main-run',
    [{ ...baseEvidence, status: 'completed', updatedAt: 40 }],
    'agent:main:session-1',
  );
  assert.equal(runs['main-run']?.asyncTaskLedger?.['task:race']?.status, 'completed');
});
