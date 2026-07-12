import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatRuntimeEvent, ChatRuntimeTaskProjection } from '../shared/chat-runtime-events.ts';
import { normalizeGatewayChatRuntimeEvents } from '../electron/gateway/chat-runtime-events.ts';
import { deriveRuntimeTaskSteps } from '../src/pages/Chat/runtime-task-visualization.ts';
import { buildRuntimeCompletionGateEvents } from '../src/stores/chat/runtime-contract.ts';
import {
  applyCompletionWakeEvidenceEventToOwners,
  applyRuntimeEventToRuns,
  applyRuntimeTaskEventToOwners,
  buildCompletionWakeTerminalTaskEvent,
  completionWakeTaskIdFromRunId,
  resolveCompletionWakeOwnerRunId,
  settledRuntimeRunError,
  settledRuntimeRunStatus,
} from '../src/stores/chat/runtime-graph.ts';

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

test('detached task terminal updates fan out to the owning chat run and completion wake resolves to it', () => {
  const ownerRunId = 'run-owner-video';
  const taskId = 'ed0c981b-1925-4913-9799-04fb351a3fe5';
  let runtimeRuns = applyRuntimeEventToRuns({}, {
    type: 'run.started',
    runId: ownerRunId,
    sessionKey: SESSION_KEY,
    ts: 100,
    startedAt: 100,
  });
  runtimeRuns = applyRuntimeEventToRuns(runtimeRuns, {
    type: 'task.updated',
    runId: ownerRunId,
    sessionKey: SESSION_KEY,
    ts: 110,
    task: {
      taskId,
      runtime: 'video_generate',
      title: 'Generate video',
      status: 'running',
      updatedAt: 110,
    },
  });

  const terminalEvent: Extract<ChatRuntimeEvent, { type: 'task.updated' }> = {
    type: 'task.updated',
    runId: `tool:video_generate:${taskId}`,
    sessionKey: SESSION_KEY,
    ts: 120,
    task: {
      taskId,
      runtime: 'video_generate',
      title: 'Generate video',
      status: 'error',
      detail: 'No available channel for model sora-2-pro',
      updatedAt: 120,
      endedAt: 120,
    },
  };
  const applied = applyRuntimeTaskEventToOwners(runtimeRuns, terminalEvent);
  runtimeRuns = applied.runtimeRuns;

  assert.deepEqual(applied.appliedEvents.map((event) => event.runId), [
    `tool:video_generate:${taskId}`,
    ownerRunId,
  ]);
  assert.equal(runtimeRuns[ownerRunId]?.tasks?.[0]?.status, 'error');
  assert.equal(runtimeRuns[`tool:video_generate:${taskId}`]?.status, 'error');
  assert.equal(settledRuntimeRunStatus(runtimeRuns[ownerRunId]), 'error');
  assert.match(settledRuntimeRunError(runtimeRuns[ownerRunId]) ?? '', /No available channel/u);

  const wakeRunId = `video_generate:${taskId}:error`;
  assert.equal(completionWakeTaskIdFromRunId(wakeRunId), taskId);
  assert.equal(resolveCompletionWakeOwnerRunId({
    runtimeRuns,
    activeRunId: ownerRunId,
    eventRunId: wakeRunId,
    currentSessionKey: SESSION_KEY,
    eventSessionKey: SESSION_KEY,
  }), ownerRunId);
  assert.equal(resolveCompletionWakeOwnerRunId({
    runtimeRuns,
    activeRunId: ownerRunId,
    eventRunId: 'video_generate:11111111-1111-4111-8111-111111111111:error',
    currentSessionKey: SESSION_KEY,
    eventSessionKey: SESSION_KEY,
  }), null);
});

test('a successful retry settles only the matching logical video segment failure', () => {
  const recoveredTitle = 'video-segment:{"parentTaskId":"promo-120s","segmentId":"scene-001"}';
  const unresolvedTitle = 'video-segment:{"parentTaskId":"promo-120s","segmentId":"scene-002"}';
  const base = {
    runId: 'run-video-segment-task-recovery',
    sessionKey: SESSION_KEY,
    status: 'completed' as const,
    assistantText: '',
    thinkingText: '',
    events: [],
    artifacts: [],
    verifications: [],
  };
  const recoveredRun = {
    ...base,
    tasks: [
      {
        taskId: 'scene-001-attempt-1',
        runtime: 'video_generate',
        title: recoveredTitle,
        status: 'error' as const,
        detail: 'first attempt failed',
        updatedAt: 10,
        endedAt: 10,
      },
      {
        taskId: 'scene-001-attempt-2',
        runtime: 'video_generate',
        title: recoveredTitle,
        status: 'completed' as const,
        updatedAt: 20,
        endedAt: 20,
      },
    ],
  };
  assert.equal(settledRuntimeRunStatus(recoveredRun), 'completed');
  assert.equal(settledRuntimeRunError(recoveredRun), undefined);

  const unresolvedRun = {
    ...recoveredRun,
    tasks: [
      ...recoveredRun.tasks,
      {
        taskId: 'scene-002-attempt-1',
        runtime: 'video_generate',
        title: unresolvedTitle,
        status: 'error' as const,
        detail: 'second segment failed',
        updatedAt: 30,
        endedAt: 30,
      },
    ],
  };
  assert.equal(settledRuntimeRunStatus(unresolvedRun), 'error');
  assert.match(settledRuntimeRunError(unresolvedRun) ?? '', /second segment failed/u);
});

test('successful image completion wake closes the owner task and projects artifact evidence to the owner run', () => {
  const ownerRunId = 'run-owner-image';
  const taskId = '1ac62e1d-85fa-4fae-b2ac-ae5f94487639';
  const wakeRunId = `image_generate:${taskId}:ok`;
  let runtimeRuns = applyRuntimeEventToRuns({}, {
    type: 'run.started',
    runId: ownerRunId,
    sessionKey: SESSION_KEY,
    ts: 100,
    startedAt: 100,
  });
  runtimeRuns = applyRuntimeEventToRuns(runtimeRuns, {
    type: 'run.contract.updated',
    runId: ownerRunId,
    sessionKey: SESSION_KEY,
    ts: 101,
    contract: {
      version: 1,
      intent: 'media',
      toolRequirement: 'required',
      sideEffect: 'remote_generation',
      sideEffectAuthorized: true,
      capabilityRefs: ['image_generate'],
      acceptance: {
        requiresArtifact: true,
        requiresVerification: true,
        requiresApproval: false,
        requiresToolEvidence: true,
      },
    },
  });
  runtimeRuns = applyRuntimeEventToRuns(runtimeRuns, {
    type: 'tool.completed',
    runId: ownerRunId,
    sessionKey: SESSION_KEY,
    ts: 105,
    toolCallId: 'call-image-generate',
    name: 'image_generate',
    result: { async: true, taskId },
    isError: false,
  });
  runtimeRuns = applyRuntimeEventToRuns(runtimeRuns, {
    type: 'task.updated',
    runId: ownerRunId,
    sessionKey: SESSION_KEY,
    ts: 110,
    task: {
      taskId,
      runtime: 'image_generate',
      title: 'Generate image',
      status: 'running',
      updatedAt: 110,
    },
  });
  runtimeRuns = buildRuntimeCompletionGateEvents(runtimeRuns[ownerRunId], {
    runId: ownerRunId,
    sessionKey: SESSION_KEY,
    ts: 120,
    status: 'completed',
  }).reduce(applyRuntimeEventToRuns, runtimeRuns);
  assert.equal(runtimeRuns[ownerRunId]?.gateResult?.decision, 'continue_required');
  assert.ok(runtimeRuns[ownerRunId]?.gateResult?.issues.some((issue) => issue.code === 'task.unfinished'));
  assert.ok(runtimeRuns[ownerRunId]?.gateResult?.issues.some((issue) => issue.code === 'artifact.required.missing'));

  const terminalTaskEvent = buildCompletionWakeTerminalTaskEvent({
    runtimeRuns,
    ownerRunId,
    eventRunId: wakeRunId,
    sessionKey: SESSION_KEY,
    state: 'final',
    ts: 200,
  });
  assert.ok(terminalTaskEvent);
  runtimeRuns = applyRuntimeTaskEventToOwners(runtimeRuns, terminalTaskEvent).runtimeRuns;
  assert.equal(runtimeRuns[ownerRunId]?.tasks?.[0]?.status, 'completed');
  assert.equal(runtimeRuns[ownerRunId]?.tasks?.[0]?.deliveryStatus, 'delivered');
  assert.equal(settledRuntimeRunStatus(runtimeRuns[ownerRunId]), 'completed');

  const artifactId = 'artifact:image:moonlight-whale';
  runtimeRuns = applyCompletionWakeEvidenceEventToOwners(runtimeRuns, {
    type: 'artifact.produced',
    runId: wakeRunId,
    sessionKey: SESSION_KEY,
    ts: 210,
    artifact: {
      id: artifactId,
      kind: 'image',
      filePath: '/tmp/moonlight-whale.png',
      mimeType: 'image/png',
    },
  }).runtimeRuns;
  runtimeRuns = applyCompletionWakeEvidenceEventToOwners(runtimeRuns, {
    type: 'verification.completed',
    runId: wakeRunId,
    sessionKey: SESSION_KEY,
    ts: 220,
    verification: {
      id: `verification:${artifactId}`,
      artifactId,
      kind: 'artifact.availability',
      status: 'passed',
      required: true,
    },
  }).runtimeRuns;

  assert.equal(runtimeRuns[ownerRunId]?.artifacts?.[0]?.taskId, taskId);
  assert.equal(runtimeRuns[ownerRunId]?.artifacts?.[0]?.filePath, '/tmp/moonlight-whale.png');
  assert.equal(runtimeRuns[ownerRunId]?.verifications?.[0]?.taskId, taskId);
  assert.equal(runtimeRuns[ownerRunId]?.verifications?.[0]?.status, 'passed');
  assert.equal(runtimeRuns[wakeRunId]?.artifacts?.[0]?.id, artifactId);

  runtimeRuns = buildRuntimeCompletionGateEvents(runtimeRuns[ownerRunId], {
    runId: ownerRunId,
    sessionKey: SESSION_KEY,
    ts: 230,
    status: 'completed',
  }).reduce(applyRuntimeEventToRuns, runtimeRuns);
  assert.equal(runtimeRuns[ownerRunId]?.gateResult?.decision, 'deliverable');
  assert.equal(runtimeRuns[ownerRunId]?.gateResult?.issues.length, 0);
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
