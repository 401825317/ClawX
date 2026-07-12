import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatRuntimeRunState } from '../src/stores/chat/types.ts';
import {
  mergeRuntimeRunStates,
  runtimeRunsShareTaskIdentity,
} from '../src/pages/Chat/runtime-run-merge.ts';

const sessionKey = 'agent:main:session-merge';

function run(
  runId: string,
  status: ChatRuntimeRunState['status'],
  lastEventAt: number,
): ChatRuntimeRunState {
  return {
    runId,
    sessionKey,
    status,
    lastEventAt,
    assistantText: '',
    thinkingText: '',
    events: [],
  };
}

test('terminal task evidence wins over a later-loaded pending history alias', () => {
  const historyRun = run('history:session:message-1', 'completed', 20);
  historyRun.turnContract = {
    version: 1,
    intent: 'media',
    toolRequirement: 'required',
    sideEffect: 'remote_generation',
    sideEffectAuthorized: true,
    acceptance: {
      requiresArtifact: true,
      requiresVerification: true,
      requiresApproval: false,
      requiresToolEvidence: true,
    },
  };
  historyRun.asyncTaskLedger = {
    'child:video': {
      id: 'child:video',
      taskId: 'video-task-1',
      runId: 'tool:video_generate:1',
      status: 'pending',
      source: 'tool-result',
      updatedAt: 20,
    },
  };

  const taskRun = run('tool:video_generate:1', 'completed', 30);
  taskRun.tasks = [{
    taskId: 'video-task-1',
    runtime: 'video_generate',
    title: 'Generate video',
    status: 'completed',
    updatedAt: 30,
    endedAt: 30,
  }];
  taskRun.asyncTaskLedger = {
    'task:video-task-1': {
      id: 'task:video-task-1',
      taskId: 'video-task-1',
      runId: 'tool:video_generate:1',
      status: 'completed',
      source: 'task-completion',
      updatedAt: 30,
    },
  };

  assert.equal(runtimeRunsShareTaskIdentity(historyRun, taskRun), true);
  const forward = mergeRuntimeRunStates('segment:message-1', sessionKey, [historyRun, taskRun]);
  const reverse = mergeRuntimeRunStates('segment:message-1', sessionKey, [taskRun, historyRun]);

  for (const merged of [forward, reverse]) {
    assert.equal(merged?.status, 'completed');
    assert.equal(merged?.turnContract?.intent, 'media');
    assert.equal(merged?.tasks?.[0]?.status, 'completed');
    assert.equal(Object.keys(merged?.asyncTaskLedger ?? {}).length, 1);
    assert.equal(Object.values(merged?.asyncTaskLedger ?? {})[0]?.status, 'completed');
    assert.equal(Object.values(merged?.asyncTaskLedger ?? {})[0]?.updatedAt, 30);
  }
});

test('unrelated task aliases never merge by session alone', () => {
  const first = run('history:session:message-1', 'completed', 20);
  first.asyncTaskLedger = {
    first: {
      id: 'first',
      taskId: 'task-first',
      status: 'completed',
      source: 'task-completion',
      updatedAt: 20,
    },
  };
  const second = run('tool:other', 'completed', 30);
  second.tasks = [{
    taskId: 'task-second',
    title: 'Other task',
    status: 'completed',
    updatedAt: 30,
  }];

  assert.equal(runtimeRunsShareTaskIdentity(first, second), false);
});

test('a terminal task error makes the merged user turn terminal error', () => {
  const mainRun = run('run-main', 'completed', 20);
  const taskRun = run('tool:video_generate:failed', 'error', 30);
  taskRun.tasks = [{
    taskId: 'video-task-failed',
    title: 'Generate video',
    status: 'error',
    detail: 'provider unavailable',
    updatedAt: 30,
    endedAt: 30,
  }];

  const merged = mergeRuntimeRunStates('segment:failed', sessionKey, [mainRun, taskRun]);
  assert.equal(merged?.status, 'error');
  assert.equal(merged?.tasks?.[0]?.detail, 'provider unavailable');
});
