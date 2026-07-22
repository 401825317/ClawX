import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatRuntimeEvent, ChatRuntimeTaskProjection } from '../shared/chat-runtime-events.ts';
import { normalizeGatewayChatRuntimeEvents } from '../electron/gateway/chat-runtime-events.ts';
import { deriveRuntimeTaskSteps } from '../src/pages/Chat/runtime-task-visualization.ts';
import { buildRuntimeProgressEvents } from '../src/stores/chat/runtime-progress.ts';
import {
  applyCompletionWakeEvidenceEventToOwners,
  applyRuntimeEventToRuns,
  applyRuntimeTaskEventToOwners,
  buildCompletionWakeTerminalTaskEvent,
  completionWakeTaskIdFromRunId,
  RUNTIME_STREAM_EVENT_TAIL_LIMIT,
  resolveCompletionWakeOwnerRunId,
  settledRuntimeRunError,
  settledRuntimeRunStatus,
} from '../src/stores/chat/runtime-graph.ts';
import { runtimeRunTaskProblemStatus } from '../src/stores/chat/runtime-task-recovery.ts';

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

test('runtime stream evidence stays bounded while accumulated text remains complete', () => {
  const assistantChunks = RUNTIME_STREAM_EVENT_TAIL_LIMIT + 80;
  const thinkingChunks = RUNTIME_STREAM_EVENT_TAIL_LIMIT + 40;
  let runtimeRuns = applyRuntimeEventToRuns({}, {
    type: 'run.started',
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    ts: 1,
    startedAt: 1,
  });

  for (let index = 0; index < assistantChunks; index += 1) {
    runtimeRuns = applyRuntimeEventToRuns(runtimeRuns, {
      type: 'assistant.delta',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: index + 2,
      ts: index + 2,
      delta: 'a',
    });
  }
  for (let index = 0; index < thinkingChunks; index += 1) {
    runtimeRuns = applyRuntimeEventToRuns(runtimeRuns, {
      type: 'thinking.delta',
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      seq: assistantChunks + index + 2,
      ts: assistantChunks + index + 2,
      delta: 't',
    });
  }

  const run = runtimeRuns[RUN_ID]!;
  const retainedAssistant = run.events.filter((event) => event.type === 'assistant.delta');
  const retainedThinking = run.events.filter((event) => event.type === 'thinking.delta');
  assert.equal(run.assistantText, 'a'.repeat(assistantChunks));
  assert.equal(run.thinkingText, 't'.repeat(thinkingChunks));
  assert.equal(retainedAssistant.length, RUNTIME_STREAM_EVENT_TAIL_LIMIT);
  assert.equal(retainedThinking.length, RUNTIME_STREAM_EVENT_TAIL_LIMIT);
  assert.equal(retainedAssistant[0]?.seq, 2);
  assert.equal(retainedAssistant.at(-1)?.seq, assistantChunks + 1);
  assert.equal(retainedThinking[0]?.seq, assistantChunks + 2);
  assert.equal(retainedThinking.at(-1)?.seq, assistantChunks + thinkingChunks + 1);
  assert.equal(run.events.some((event) => event.type === 'run.started'), true);
});

test('detached task terminal updates fan out to the owning chat run', () => {
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

  runtimeRuns = applyRuntimeEventToRuns(runtimeRuns, {
    type: 'run.started',
    runId: wakeRunId,
    sessionKey: SESSION_KEY,
    ts: 130,
    startedAt: 130,
  });
  assert.equal(resolveCompletionWakeOwnerRunId({
    runtimeRuns,
    activeRunId: wakeRunId,
    eventRunId: wakeRunId,
    currentSessionKey: SESSION_KEY,
    eventSessionKey: SESSION_KEY,
  }), ownerRunId);
});

test('successful video completion wake settles the submitted progress entry', () => {
  const ownerRunId = 'run-owner-video-success';
  const taskId = '90c29618-f41f-4dd5-bd0a-eecf49df08e6';
  const toolCallId = 'call-video-generate';
  const wakeRunId = `video_generate:${taskId}:ok`;
  let runtimeRuns = applyRuntimeEventToRuns({}, {
    type: 'run.started',
    runId: ownerRunId,
    sessionKey: SESSION_KEY,
    ts: 100,
    startedAt: 100,
  });

  const applyWithProgress = (event: ChatRuntimeEvent): void => {
    runtimeRuns = applyRuntimeEventToRuns(runtimeRuns, event);
    for (const progressEvent of buildRuntimeProgressEvents(runtimeRuns[event.runId], event)) {
      runtimeRuns = applyRuntimeEventToRuns(runtimeRuns, progressEvent);
    }
  };

  applyWithProgress({
    type: 'tool.started',
    runId: ownerRunId,
    sessionKey: SESSION_KEY,
    ts: 105,
    toolCallId,
    name: 'tool_call',
    args: {
      id: 'video_generate',
      args: { action: 'generate', size: '720x1280', durationSeconds: 15 },
    },
  });
  applyWithProgress({
    type: 'tool.completed',
    runId: ownerRunId,
    sessionKey: SESSION_KEY,
    ts: 110,
    toolCallId,
    name: 'tool_call',
    result: {
      tool: { name: 'video_generate', label: 'Video Generation' },
      result: { details: { async: true, status: 'started', taskId } },
    },
    isError: false,
  });
  const submitted = runtimeRuns[ownerRunId]?.progressEntries?.find((entry) => entry.taskId === taskId);
  assert.equal(submitted?.status, 'running');
  assert.equal(submitted?.translationKey, 'runtimeProgress.toolSubmitted');

  const terminalTaskEvent = buildCompletionWakeTerminalTaskEvent({
    runtimeRuns,
    ownerRunId,
    eventRunId: wakeRunId,
    sessionKey: SESSION_KEY,
    state: 'final',
    ts: 200,
  });
  assert.ok(terminalTaskEvent);
  const applied = applyRuntimeTaskEventToOwners(runtimeRuns, terminalTaskEvent);
  runtimeRuns = applied.runtimeRuns;
  for (const appliedEvent of applied.appliedEvents) {
    for (const progressEvent of buildRuntimeProgressEvents(runtimeRuns[appliedEvent.runId], appliedEvent)) {
      runtimeRuns = applyRuntimeEventToRuns(runtimeRuns, progressEvent);
    }
  }

  const completed = runtimeRuns[ownerRunId]?.progressEntries?.find((entry) => entry.taskId === taskId);
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.translationKey, 'runtimeProgress.toolCompleted');
  assert.equal(completed?.command, '');
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

  const projectedRun = applyEvents(recoveredRun.tasks.map((task) => taskEvent(task)));
  assert.equal(projectedRun[RUN_ID]?.status, 'completed');

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

test('a successful run completion supersedes earlier task failures but not failures that arrive later', () => {
  const failedTask = {
    taskId: 'local-compose-attempt',
    runtime: 'uclaw-host-task',
    title: 'Compose locally',
    status: 'error' as const,
    detail: 'local encoder failed',
    updatedAt: 200,
    endedAt: 200,
  };
  const completedAfterFailure = {
    runId: 'run-completed-after-fallback',
    sessionKey: SESSION_KEY,
    status: 'completed' as const,
    endedAt: 300,
    assistantText: 'Recovered with a verified fallback output.',
    thinkingText: '',
    tasks: [failedTask],
    events: [{
      type: 'run.ended' as const,
      runId: 'run-completed-after-fallback',
      sessionKey: SESSION_KEY,
      status: 'completed' as const,
      ts: 300,
      endedAt: 300,
    }],
  };
  assert.equal(runtimeRunTaskProblemStatus(completedAfterFailure), null);

  const failedAfterCompletion = {
    ...completedAfterFailure,
    tasks: [{ ...failedTask, updatedAt: 400, endedAt: 400 }],
  };
  assert.equal(runtimeRunTaskProblemStatus(failedAfterCompletion), 'error');
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

test('gateway runtime normalization preserves explicit owner run lineage', () => {
  const events = normalizeGatewayChatRuntimeEvents({
    stream: 'artifact',
    runId: 'image_generate:lineage-task:ok',
    rootRunId: 'run-lineage-owner',
    sessionKey: SESSION_KEY,
    artifact: { id: 'lineage-artifact', kind: 'image', filePath: '/tmp/lineage.png' },
  });
  assert.ok(events.length > 0);
  assert.equal(events[0]?.rootRunId, 'run-lineage-owner');
});

test('gateway runtime normalization preserves cancelled tasks as aborted', () => {
  const events = normalizeGatewayChatRuntimeEvents({
    stream: 'tool',
    runId: 'run-native-cancelled',
    sessionKey: SESSION_KEY,
    ts: 4300,
    data: {
      task: {
        taskId: 'task-native-cancelled',
        title: 'Cancelled native task',
        status: 'cancelled',
        terminalOutcome: 'cancelled',
        terminalSummary: 'Cancelled by user',
        updatedAt: 4300,
        endedAt: 4300,
      },
    },
  });

  const taskEvent = events.find((event) => event.type === 'task.updated');
  const stepEvent = events.find((event) => event.type === 'run.step.updated');
  const progressEvent = events.find((event) => event.type === 'progress.update');
  assert.equal(taskEvent?.taskStatus, 'aborted');
  assert.equal(taskEvent?.type === 'task.updated' ? taskEvent.task.status : undefined, 'aborted');
  assert.equal(stepEvent?.type === 'run.step.updated' ? stepEvent.step?.status : undefined, 'aborted');
  assert.equal(progressEvent?.type === 'progress.update' ? progressEvent.entry.status : undefined, 'aborted');
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
      status: 'aborted',
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
      taskStatus: 'aborted',
      ts: 500,
      step: {
        id: 'task:task-cancelled',
        taskId: 'task-cancelled',
        title: 'Cancelled task',
        status: 'aborted',
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

test('tool failures and command output stay out of the visible execution graph', () => {
  const steps = deriveRuntimeTaskSteps({
    runId: 'run-hidden-tool-result',
    sessionKey: SESSION_KEY,
    status: 'completed',
    assistantText: '',
    thinkingText: '',
    events: [{
      type: 'tool.started',
      runId: 'run-hidden-tool-result',
      sessionKey: SESSION_KEY,
      ts: 10,
      toolCallId: 'failed-shell',
      name: 'exec',
      args: { command: 'ls /tmp/missing-file' },
    }, {
      type: 'tool.completed',
      runId: 'run-hidden-tool-result',
      sessionKey: SESSION_KEY,
      ts: 20,
      toolCallId: 'failed-shell',
      name: 'exec',
      isError: true,
      result: 'ls: /tmp/missing-file: No such file or directory',
    }, {
      type: 'command.output',
      runId: 'run-hidden-tool-result',
      sessionKey: SESSION_KEY,
      ts: 21,
      name: 'exec',
      title: 'Command output',
      output: 'No such file or directory',
      status: 'error',
      exitCode: 1,
    }, {
      type: 'run.step.updated',
      runId: 'run-hidden-tool-result',
      sessionKey: SESSION_KEY,
      ts: 22,
      step: {
        id: 'command-show-missing-file',
        title: 'command show /tmp/missing-file (agent)',
        kind: 'command',
        status: 'error',
        detail: 'cat: /tmp/missing-file: No such file or directory',
      },
    }],
  });

  const tool = steps.find((step) => step.id === 'failed-shell');
  assert.equal(tool?.status, 'completed');
  assert.equal(tool?.detail, undefined);
  assert.equal(steps.some((step) => /Command output|No such file/i.test(`${step.label}\n${step.detail ?? ''}`)), false);
  const commandStep = steps.find((step) => step.id === 'plan-step:command-show-missing-file');
  assert.equal(commandStep?.status, 'completed');
  assert.equal(commandStep?.detail, undefined);
});
