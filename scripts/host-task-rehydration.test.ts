import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatRuntimeEvent } from '../shared/chat-runtime-events.ts';
import {
  buildHostTaskRehydrationEvents,
  parseHostTaskBridgeTasks,
} from '../src/stores/chat/host-task-rehydration.ts';
import { applyRuntimeEventToRuns } from '../src/stores/chat/runtime-graph.ts';
import type { ChatRuntimeRunState } from '../src/stores/chat/types.ts';

function payload(status: string, overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    tasks: [{
      schema: 'uclaw.host-task/v1',
      taskId: 'task-1',
      kind: 'local.presentation.render',
      title: 'Render the presentation',
      status,
      revision: 4,
      createdAt: 100,
      updatedAt: 400,
      correlation: {
        sessionKey: 'agent:main:session-1',
        runId: 'run-1',
        toolCallId: 'tool-1',
        idempotencyKey: 'idem-1',
      },
      progress: [{
        id: 'progress:task-1:4',
        detail: 'Presentation rendered',
        timestampMs: 400,
      }],
      artifacts: [{
        id: 'artifact-1',
        kind: 'presentation',
        title: 'Launch deck',
        filePath: '/tmp/launch-deck.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        sizeBytes: 4096,
        role: 'presentation',
      }],
      verifications: [{
        id: 'verification-1',
        status: 'passed',
        kind: 'artifact.integrity',
        required: true,
        artifactId: 'artifact-1',
      }],
      lifecycle: {
        operations: [{
          kind: 'start',
          status: 'completed',
          attempt: 1,
          startedAt: 120,
          finishedAt: 400,
        }],
      },
      ...overrides,
    }],
  };
}

function apply(events: ChatRuntimeEvent[]): Record<string, ChatRuntimeRunState> {
  return events.reduce<Record<string, ChatRuntimeRunState>>(
    (runs, event) => applyRuntimeEventToRuns(runs, event),
    {},
  );
}

test('rehydrates a succeeded Host task with stable native terminal evidence', () => {
  const tasks = parseHostTaskBridgeTasks(payload('succeeded'));
  assert.equal(tasks.length, 1);
  const events = buildHostTaskRehydrationEvents(tasks);
  assert.deepEqual(events.map((event) => event.type), [
    'task.updated',
    'run.step.updated',
    'progress.update',
    'artifact.produced',
    'verification.completed',
    'tool.completed',
  ]);
  assert.ok(events.every((event) => event.runId === 'run-1'));
  assert.ok(events.every((event) => event.sessionKey === 'agent:main:session-1'));
  assert.ok(events.every((event) => event.taskId === 'task-1'));
  assert.equal(new Set(events.map((event) => event.seq)).size, events.length);

  const taskEvent = events.find((event) => event.type === 'task.updated');
  assert.equal(taskEvent?.task.status, 'completed');
  assert.equal(taskEvent?.task.sourceStatus, 'succeeded');
  assert.equal(taskEvent?.task.deliveryStatus, 'delivered');
  const artifactEvent = events.find((event) => event.type === 'artifact.produced');
  assert.equal(artifactEvent?.toolCallId, 'tool-1');
  assert.equal(artifactEvent?.artifact.taskId, 'task-1');
  assert.equal(artifactEvent?.artifact.sourceToolCallId, 'tool-1');
  const toolEvent = events.find((event) => event.type === 'tool.completed');
  assert.equal(toolEvent?.toolCallId, 'tool-1');
  assert.equal(toolEvent?.isError, false);

  const once = apply(events);
  const twice = events.reduce((runs, event) => applyRuntimeEventToRuns(runs, event), once);
  assert.deepEqual(twice, once);
  assert.equal(once['run-1']?.status, 'completed');
  assert.equal(once['run-1']?.tasks?.length, 1);
  assert.equal(once['run-1']?.artifacts?.length, 1);
  assert.equal(once['run-1']?.verifications?.length, 1);
});

test('failed and blocked Host tasks never rehydrate deliverable artifacts or successful tools', () => {
  for (const status of ['failed', 'blocked']) {
    const tasks = parseHostTaskBridgeTasks(payload(status, { error: `${status} by Host validation` }));
    const events = buildHostTaskRehydrationEvents(tasks);
    assert.equal(events.some((event) => event.type === 'artifact.produced'), false);
    assert.equal(events.some((event) => event.type === 'assistant.delta'), false);
    const taskEvent = events.find((event) => event.type === 'task.updated');
    assert.equal(taskEvent?.task.status, 'error');
    assert.equal(taskEvent?.task.terminalOutcome, status);
    assert.equal(taskEvent?.task.deliveryStatus, undefined);
    const toolEvent = events.find((event) => event.type === 'tool.completed');
    assert.equal(toolEvent?.isError, true);
    assert.deepEqual(toolEvent?.result, {
      taskId: 'task-1',
      status,
      artifactCount: 0,
      verificationCount: 1,
      error: `${status} by Host validation`,
    });
    assert.equal(JSON.stringify(events).includes('MEDIA:'), false);
    assert.equal(apply(events)['run-1']?.status, 'error');
  }
});

test('an active task only seeds run.started when the caller reports that its run is missing', () => {
  const tasks = parseHostTaskBridgeTasks(payload('running'));
  const missingRunEvents = buildHostTaskRehydrationEvents(tasks, { existingRunIds: [] });
  assert.equal(missingRunEvents[0]?.type, 'run.started');
  assert.equal(missingRunEvents.filter((event) => event.type === 'run.started').length, 1);
  assert.equal(missingRunEvents.some((event) => event.type === 'tool.completed'), false);

  const knownRunEvents = buildHostTaskRehydrationEvents(tasks, { existingRunIds: ['run-1'] });
  assert.equal(knownRunEvents.some((event) => event.type === 'run.started'), false);
  assert.equal(apply(knownRunEvents)['run-1']?.status, 'running');

  const terminalEvents = buildHostTaskRehydrationEvents(
    parseHostTaskBridgeTasks(payload('succeeded')),
    { existingRunIds: [] },
  );
  assert.equal(terminalEvents.some((event) => event.type === 'run.started'), false);
  assert.equal(apply(terminalEvents)['run-1']?.status, 'completed');
});

test('ignores legacy, malformed and cross-schema task snapshots', () => {
  const current = payload('succeeded');
  const currentTask = current.tasks[0];
  assert.ok(currentTask);
  assert.deepEqual(parseHostTaskBridgeTasks({
    success: true,
    tasks: [
      { ...currentTask, schema: 'uclaw.host-task/v2' },
      { ...currentTask, correlation: { ...currentTask.correlation, runId: '' } },
      currentTask,
    ],
  }).map((task) => task.taskId), ['task-1']);
  assert.deepEqual(parseHostTaskBridgeTasks({ success: false, tasks: [currentTask] }), []);
});
