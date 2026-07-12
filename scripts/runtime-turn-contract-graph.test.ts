import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatRuntimeEvent, ChatRuntimeTaskProjection } from '../shared/chat-runtime-events.ts';
import { normalizeGatewayChatRuntimeEvents } from '../electron/gateway/chat-runtime-events.ts';
import { deriveRuntimeTaskSteps } from '../src/pages/Chat/runtime-task-visualization.ts';
import { applyRuntimeEventToRuns } from '../src/stores/chat/runtime-graph.ts';

const RUN_ID = 'run-task-graph';
const SESSION_KEY = 'agent:main:task-graph';

function taskEvent(task: ChatRuntimeTaskProjection, ts = task.updatedAt): ChatRuntimeEvent {
  return {
    type: 'task.updated',
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    taskId: task.taskId,
    taskStatus: task.status,
    ts,
    task,
  };
}

function applyEvents(events: ChatRuntimeEvent[]) {
  return events.reduce(applyRuntimeEventToRuns, {});
}

const partialIssue = {
  id: 'issue:task:task-partial:partial',
  code: 'task.partial',
  severity: 'blocking' as const,
  title: 'Task needs recovery',
  targetId: 'task-partial',
  recoverable: true,
};

test('a turn contract event is retained on the originating runtime run', () => {
  const runs = applyRuntimeEventToRuns({}, {
    contractVersion: 1,
    producer: 'plugin',
    runId: 'run-contract-graph',
    sessionKey: 'agent:main:contract',
    ts: 1,
    type: 'run.contract.updated',
    contract: {
      version: 1,
      intent: 'media',
      toolRequirement: 'required',
      sideEffect: 'remote_generation',
      sideEffectAuthorized: true,
      capabilityRefs: ['image-generation'],
      acceptance: {
        requiresArtifact: true,
        requiresVerification: true,
        requiresApproval: false,
        requiresToolEvidence: true,
      },
    },
  });

  assert.equal(runs['run-contract-graph']?.turnContract?.intent, 'media');
  assert.equal(runs['run-contract-graph']?.events[0]?.type, 'run.contract.updated');
});

test('task projections are ordered by updatedAt and cannot regress from a terminal state', () => {
  const runs = applyEvents([
    taskEvent({ taskId: 'task-order', title: 'Ordered task', status: 'running', updatedAt: 100 }, 100),
    taskEvent({ taskId: 'task-order', title: 'Ordered task', status: 'completed', updatedAt: 300 }, 300),
    taskEvent({ taskId: 'task-order', title: 'Stale task title', status: 'running', updatedAt: 200 }, 400),
    taskEvent({ taskId: 'task-order', title: 'Terminal regression', status: 'running', updatedAt: 500 }, 500),
  ]);

  const run = runs[RUN_ID];
  assert.equal(run?.tasks?.[0]?.status, 'completed');
  assert.equal(run?.tasks?.[0]?.title, 'Ordered task');
  assert.equal(run?.tasks?.[0]?.updatedAt, 300);
  assert.equal(run?.events.filter((event) => event.type === 'task.updated').length, 2);
});

test('same-seq gateway fan-out retains every entity and remains idempotent on replay', () => {
  const events = normalizeGatewayChatRuntimeEvents({
    seq: 42,
    runId: 'run-same-seq',
    sessionKey: SESSION_KEY,
    ts: 4200,
    data: {
      task: {
        id: 'task-same-seq',
        taskId: 'task-same-seq',
        title: 'Fan-out task',
        status: 'completed',
        deliveryStatus: 'delivered',
        terminalOutcome: 'succeeded',
        updatedAt: 4200,
        endedAt: 4200,
      },
      artifacts: [
        { id: 'artifact-one', kind: 'document', filePath: '/tmp/one.md' },
        { id: 'artifact-two', kind: 'document', filePath: '/tmp/two.md' },
      ],
      verifications: [
        { id: 'verify-one', status: 'passed', artifactId: 'artifact-one', kind: 'artifact.availability' },
        { id: 'verify-two', status: 'passed', artifactId: 'artifact-two', kind: 'artifact.availability' },
      ],
    },
  });
  const progressEvents: ChatRuntimeEvent[] = [{
    type: 'progress.update',
    runId: 'run-same-seq',
    sessionKey: SESSION_KEY,
    seq: 42,
    ts: 4200,
    entry: { id: 'progress-one', kind: 'action', text: 'First', status: 'completed' },
  }, {
    type: 'progress.update',
    runId: 'run-same-seq',
    sessionKey: SESSION_KEY,
    seq: 42,
    ts: 4200,
    entry: { id: 'progress-two', kind: 'status', text: 'Second', status: 'completed' },
  }];

  let runs = [...events, ...progressEvents].reduce(applyRuntimeEventToRuns, {});
  const first = runs['run-same-seq'];
  assert.equal(first?.tasks?.length, 1);
  assert.deepEqual(first?.artifacts?.map((artifact) => artifact.id).sort(), ['artifact-one', 'artifact-two']);
  assert.deepEqual(first?.verifications?.map((verification) => verification.id).sort(), ['verify-one', 'verify-two']);
  assert.deepEqual(first?.progressEntries?.map((entry) => entry.id).sort(), ['progress-one', 'progress-two']);
  const eventCount = first?.events.length;

  runs = [...events, ...progressEvents].reduce(applyRuntimeEventToRuns, runs);
  const replayed = runs['run-same-seq'];
  assert.equal(replayed?.events.length, eventCount);
  assert.equal(replayed?.artifacts?.length, 2);
  assert.equal(replayed?.verifications?.length, 2);
  assert.equal(replayed?.progressEntries?.length, 2);
});

test('a task-ledger-only run follows the detached task terminal state', () => {
  const completed = applyRuntimeEventToRuns({}, {
    type: 'task.updated',
    runId: 'tool:detached:completed',
    sessionKey: SESSION_KEY,
    ts: 300,
    task: {
      taskId: 'task-detached-completed',
      title: 'Detached completed task',
      status: 'completed',
      updatedAt: 300,
      endedAt: 300,
    },
  });
  const failed = applyRuntimeEventToRuns({}, {
    type: 'task.updated',
    runId: 'tool:detached:failed',
    sessionKey: SESSION_KEY,
    ts: 400,
    task: {
      taskId: 'task-detached-failed',
      title: 'Detached failed task',
      status: 'error',
      updatedAt: 400,
      endedAt: 400,
    },
  });

  assert.equal(completed['tool:detached:completed']?.status, 'completed');
  assert.equal(completed['tool:detached:completed']?.endedAt, 300);
  assert.equal(failed['tool:detached:failed']?.status, 'error');
  assert.equal(failed['tool:detached:failed']?.endedAt, 400);
});

test('a new run attempt clears stale issues, checkpoints, and gate state', () => {
  const gate = {
    id: 'gate:old-attempt',
    decision: 'continue_required' as const,
    artifactCount: 0,
    requiredVerificationCount: 0,
    passedRequiredVerificationCount: 0,
    blockingIssueCount: 1,
    warningIssueCount: 0,
    verificationCoverage: 0,
    issues: [partialIssue],
  };
  const runs = applyEvents([
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, ts: 1, startedAt: 1 },
    { type: 'gate.issue', runId: RUN_ID, sessionKey: SESSION_KEY, ts: 2, issue: partialIssue },
    {
      type: 'run.checkpoint',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      ts: 3,
      checkpoint: {
        id: 'checkpoint:old-attempt',
        summary: 'Old checkpoint',
        taskId: 'task-partial',
        kind: 'partial',
        recoverable: true,
      },
    },
    { type: 'gate.evaluated', runId: RUN_ID, sessionKey: SESSION_KEY, ts: 4, gate },
    { type: 'run.started', runId: RUN_ID, sessionKey: SESSION_KEY, ts: 5, startedAt: 5 },
  ]);

  const run = runs[RUN_ID];
  assert.deepEqual(run?.issues, []);
  assert.deepEqual(run?.checkpoints, []);
  assert.deepEqual(run?.gateEvaluations, []);
  assert.equal(run?.gateResult, undefined);
});

test('recovering a partial task removes its stale partial gate state', () => {
  const gate = {
    id: 'gate:partial',
    decision: 'continue_required' as const,
    artifactCount: 0,
    requiredVerificationCount: 0,
    passedRequiredVerificationCount: 0,
    blockingIssueCount: 1,
    warningIssueCount: 0,
    verificationCoverage: 0,
    issues: [partialIssue],
  };
  const runs = applyEvents([
    taskEvent({ taskId: 'task-partial', title: 'Recover task', status: 'partial', updatedAt: 100 }, 100),
    { type: 'gate.issue', runId: RUN_ID, sessionKey: SESSION_KEY, ts: 101, issue: partialIssue },
    {
      type: 'run.checkpoint',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      ts: 102,
      checkpoint: {
        id: 'checkpoint:task:task-partial:partial',
        summary: 'Recover task',
        taskId: 'task-partial',
        kind: 'partial',
        recoverable: true,
      },
    },
    { type: 'gate.evaluated', runId: RUN_ID, sessionKey: SESSION_KEY, ts: 103, gate },
    taskEvent({ taskId: 'task-partial', title: 'Recover task', status: 'completed', updatedAt: 200 }, 200),
  ]);

  const run = runs[RUN_ID];
  assert.equal(run?.tasks?.[0]?.status, 'completed');
  assert.deepEqual(run?.issues, []);
  assert.deepEqual(run?.checkpoints, []);
  assert.equal(run?.gateResult, undefined);
});

test('task.updated topology and terminal status remain authoritative over companion plan steps', () => {
  const events: ChatRuntimeEvent[] = [
    taskEvent({
      taskId: 'task-flow-root',
      flowId: 'flow-release',
      title: 'Coordinate release',
      status: 'completed',
      updatedAt: 300,
      endedAt: 300,
    }, 300),
    {
      type: 'run.step.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      taskId: 'task-flow-root',
      taskStatus: 'running',
      ts: 200,
      step: {
        id: 'task:task-flow-root',
        taskId: 'task-flow-root',
        title: 'Coordinate release',
        status: 'running',
      },
    },
    taskEvent({
      taskId: 'task-flow-root',
      flowId: 'flow-release',
      title: 'Coordinate release',
      status: 'running',
      updatedAt: 200,
    }, 400),
  ];
  const steps = deriveRuntimeTaskSteps({
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    status: 'completed',
    assistantText: '',
    thinkingText: '',
    events,
  });

  const task = steps.find((step) => step.taskId === 'task-flow-root');
  const flow = steps.find((step) => step.id === 'plan-step:task-flow:flow-release');
  assert.equal(task?.parentId, 'plan-step:task-flow:flow-release');
  assert.equal(task?.status, 'completed');
  assert.equal(flow?.status, 'completed');
});

test('cancelled task and approval projections use aborted semantics', () => {
  const events: ChatRuntimeEvent[] = [
    taskEvent({
      taskId: 'task-cancelled',
      flowId: 'flow-cancelled',
      title: 'Cancelled task',
      status: 'error',
      sourceStatus: 'cancelled',
      terminalOutcome: 'aborted',
      updatedAt: 500,
      endedAt: 500,
    }, 500),
    {
      type: 'run.step.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      taskId: 'task-cancelled',
      taskStatus: 'error',
      ts: 500,
      step: {
        id: 'task:task-cancelled',
        taskId: 'task-cancelled',
        title: 'Cancelled task',
        status: 'error',
      },
    },
    {
      type: 'approval.updated',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      taskId: 'task-cancelled',
      ts: 501,
      itemId: 'cancelled-approval',
      title: 'Cancelled approval',
      status: 'cancelled',
      phase: 'resolved',
    },
  ];
  const steps = deriveRuntimeTaskSteps({
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    status: 'aborted',
    assistantText: '',
    thinkingText: '',
    events,
  });

  assert.equal(steps.find((step) => step.id === 'plan-step:task:task-cancelled')?.status, 'aborted');
  assert.equal(steps.find((step) => step.id === 'plan-step:task-flow:flow-cancelled')?.status, 'aborted');
  assert.equal(steps.find((step) => step.id === 'approval:cancelled-approval')?.status, 'aborted');
});
