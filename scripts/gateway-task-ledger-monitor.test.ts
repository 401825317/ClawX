import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatRuntimeEvent } from '../shared/chat-runtime-events.ts';
import { GatewayTaskLedgerMonitor, projectTaskLedgerRecord } from '../electron/gateway/task-ledger-monitor.ts';

const ACTIVE_STATUSES = ['queued', 'running'];
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'timed_out'];

test('task ledger projection accepts the real OpenClaw gateway DTO', () => {
  const event = projectTaskLedgerRecord({
    id: 'task-child',
    runtime: 'subagent',
    kind: 'research',
    sessionKey: 'agent:main:session-1',
    childSessionKey: 'agent:researcher:subagent:child',
    parentTaskId: 'task-parent',
    flowId: 'flow-1',
    runId: 'run-child',
    title: 'Inspect evidence',
    status: 'running',
    createdAt: 10_000,
    updatedAt: 11_000,
  });
  assert.equal(event?.type, 'task.updated');
  if (event?.type !== 'task.updated') throw new Error('Expected task.updated');
  assert.equal(event.task.parentTaskId, 'task-parent');
  assert.equal(event.task.flowId, 'flow-1');
  assert.equal(event.task.kind, 'research');
  assert.equal(event.task.sessionKey, 'agent:main:session-1');
  assert.equal(event.task.status, 'running');
});

test('task ledger projection preserves explicit conversation owner run lineage', () => {
  const event = projectTaskLedgerRecord({
    id: 'task-owned-child',
    runtime: 'subagent',
    sessionKey: 'agent:main:session-1',
    runId: 'run-child',
    ownerRunId: 'run-conversation-owner',
    title: 'Owned child task',
    status: 'running',
    createdAt: 10_000,
    updatedAt: 11_000,
  });

  assert.equal(event?.runId, 'run-child');
  assert.equal(event?.rootRunId, 'run-conversation-owner');
});

test('public completed TaskSummary stays partial when delivery evidence is unavailable', () => {
  const event = projectTaskLedgerRecord({
    id: 'task-completed',
    runtime: 'subagent',
    sessionKey: 'agent:main:session-1',
    runId: 'run-completed',
    title: 'Completed execution',
    status: 'completed',
    createdAt: 10_000,
    updatedAt: 11_000,
    endedAt: 11_000,
    terminalSummary: 'Execution ended successfully.',
  });
  assert.equal(event?.type, 'task.updated');
  if (event?.type !== 'task.updated') throw new Error('Expected task.updated');
  assert.equal(event.task.sourceStatus, 'completed');
  assert.equal(event.task.deliveryStatus, undefined);
  assert.equal(event.task.terminalOutcome, undefined);
  assert.equal(event.task.status, 'partial');
});

test('patched TaskSummary uses explicit delivery and terminal outcome evidence', () => {
  const delivered = projectTaskLedgerRecord({
    id: 'task-delivered',
    runtime: 'subagent',
    sessionKey: 'agent:main:session-1',
    runId: 'run-delivered',
    title: 'Delivered task',
    status: 'completed',
    deliveryStatus: 'delivered',
    terminalOutcome: 'succeeded',
    updatedAt: 11_000,
  });
  const blocked = projectTaskLedgerRecord({
    id: 'task-blocked',
    runtime: 'subagent',
    sessionKey: 'agent:main:session-1',
    runId: 'run-blocked',
    title: 'Blocked task',
    status: 'completed',
    deliveryStatus: 'delivered',
    terminalOutcome: 'blocked',
    updatedAt: 11_000,
  });
  assert.equal(delivered?.taskStatus, 'completed');
  assert.equal(blocked?.taskStatus, 'partial');
});

test('monitor paginates, rebuilds nested lineage, and normalizes descendants to the root session', async () => {
  const events: ChatRuntimeEvent[] = [];
  const calls: Array<{ cursor?: string; limit: number; status: string[] }> = [];
  const monitor = new GatewayTaskLedgerMonitor({
    listTasks: async (params) => {
      calls.push(params);
      if (params.status[0] === 'completed') return { tasks: [] };
      if (!params.cursor) {
        return {
          tasks: [{
            id: 'root-task',
            runtime: 'subagent',
            kind: 'research',
            sessionKey: 'agent:main:session-1',
            childSessionKey: 'agent:main:subagent:child-1',
            runId: 'run-root-task',
            title: 'Root research',
            status: 'running',
            createdAt: 19_000,
            updatedAt: 19_500,
          }],
          nextCursor: '500',
        };
      }
      return {
        tasks: [{
          id: 'nested-task',
          runtime: 'subagent',
          kind: 'verification',
          sessionKey: 'agent:main:subagent:child-1',
          ownerKey: 'agent:main:subagent:child-1',
          childSessionKey: 'agent:main:subagent:child-2',
          runId: 'run-nested-task',
          title: 'Nested verification',
          status: 'running',
          createdAt: 19_200,
          updatedAt: 19_600,
        }],
      };
    },
    getTask: async () => { throw new Error('terminal lookup not expected'); },
    emit: (event) => events.push(event),
    now: () => 20_000,
    intervalMs: 60_000,
  });

  await monitor.pollOnce();
  assert.deepEqual(calls, [
    { cursor: undefined, limit: 500, status: ACTIVE_STATUSES },
    { cursor: '500', limit: 500, status: ACTIVE_STATUSES },
    { cursor: undefined, limit: 500, status: TERMINAL_STATUSES },
  ]);
  const nested = events.find((event) => event.taskId === 'nested-task');
  assert.equal(nested?.type, 'task.updated');
  if (nested?.type !== 'task.updated') throw new Error('Expected nested task.updated');
  assert.equal(nested.sessionKey, 'agent:main:session-1');
  assert.equal(nested.runId, 'run-root-task');
  assert.equal(nested.task.parentTaskId, 'root-task');
});

test('monitor suppresses unchanged active events and preserves terminal lookup across stop and restart', async () => {
  let now = 20_000;
  let snapshot: unknown = {
    tasks: [
      {
        id: 'active',
        runtime: 'subagent',
        sessionKey: 'agent:main:session-1',
        runId: 'run-active',
        title: 'Active task',
        status: 'running',
        createdAt: 19_000,
        updatedAt: 19_500,
      },
    ],
  };
  const events: ChatRuntimeEvent[] = [];
  const getCalls: string[] = [];
  const monitor = new GatewayTaskLedgerMonitor({
    listTasks: async (params) => {
      if (params.status[0] === 'completed') return { tasks: [] };
      assert.deepEqual(params.status, ACTIVE_STATUSES);
      return snapshot;
    },
    getTask: async (id) => {
      getCalls.push(id);
      return {
        task: {
          id,
          runtime: 'subagent',
          sessionKey: 'agent:main:session-1',
          runId: 'run-active',
          title: 'Active task',
          status: 'completed',
          deliveryStatus: 'delivered',
          terminalOutcome: 'succeeded',
          createdAt: 19_000,
          updatedAt: 20_900,
          endedAt: 20_900,
        },
      };
    },
    emit: (event) => events.push(event),
    now: () => now,
    intervalMs: 60_000,
  });

  await monitor.pollOnce();
  assert.deepEqual(events.map((event) => event.taskId), ['active']);
  assert.deepEqual(getCalls, []);

  await monitor.pollOnce();
  assert.deepEqual(events.map((event) => event.taskId), ['active']);

  monitor.stop();
  now = 21_000;
  snapshot = { tasks: [] };
  monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  monitor.stop();
  assert.deepEqual(getCalls, ['active']);
  const completed = events.at(-1);
  assert.equal(completed?.taskId, 'active');
  assert.equal(completed?.taskStatus, 'completed');
});

test('monitor emits a corrected owner lineage when task state and timestamps stay unchanged', async () => {
  let ownerRunId: string | undefined;
  const events: ChatRuntimeEvent[] = [];
  const monitor = new GatewayTaskLedgerMonitor({
    listTasks: async (params) => {
      if (params.status[0] === 'completed') return { tasks: [] };
      return {
        tasks: [{
          id: 'owner-corrected-task',
          runtime: 'subagent',
          sessionKey: 'agent:main:session-1',
          runId: 'run-owner-corrected-child',
          ownerRunId,
          title: 'Owner correction',
          status: 'running',
          createdAt: 19_000,
          updatedAt: 19_500,
        }],
      };
    },
    getTask: async () => { throw new Error('terminal lookup not expected'); },
    emit: (event) => events.push(event),
    now: () => 20_000,
  });

  await monitor.pollOnce();
  await monitor.pollOnce();
  assert.equal(events.length, 1);

  ownerRunId = 'run-conversation-owner';
  await monitor.pollOnce();
  assert.equal(events.length, 2);
  assert.equal(events.at(-1)?.rootRunId, 'run-conversation-owner');
});

test('monitor discovers tasks that start and finish between active polls', async () => {
  let now = 20_000;
  let terminalTasks: unknown[] = [];
  let terminalListCalls = 0;
  const events: ChatRuntimeEvent[] = [];
  const monitor = new GatewayTaskLedgerMonitor({
    listTasks: async (params) => {
      if (params.status[0] !== 'completed') return { tasks: [] };
      terminalListCalls += 1;
      return { tasks: terminalTasks };
    },
    getTask: async () => { throw new Error('terminal lookup not expected'); },
    emit: (event) => events.push(event),
    now: () => now,
  });

  await monitor.pollOnce();
  assert.equal(events.length, 0);
  assert.equal(terminalListCalls, 1);

  now = 21_000;
  terminalTasks = [{
    id: 'fast-task',
    runtime: 'cli',
    kind: 'image_generation',
    sessionKey: 'agent:main:session-1',
    runId: 'run-fast',
    title: 'Fast task',
    status: 'completed',
    deliveryStatus: 'not_applicable',
    terminalOutcome: 'succeeded',
    createdAt: 20_500,
    updatedAt: 20_900,
    endedAt: 20_900,
  }];
  await monitor.pollOnce();
  assert.equal(events.length, 0);
  assert.equal(terminalListCalls, 1);

  now = 30_000;
  await monitor.pollOnce();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.taskId, 'fast-task');
  assert.equal(events[0]?.taskStatus, 'completed');
  assert.equal(terminalListCalls, 2);

  now = 31_000;
  await monitor.pollOnce();
  assert.equal(events.length, 1);
  assert.equal(terminalListCalls, 2);
});

test('cold start restores recently ended long tasks and ignores truly old terminal tasks', async () => {
  const events: ChatRuntimeEvent[] = [];
  let terminalListCalls = 0;
  const monitor = new GatewayTaskLedgerMonitor({
    listTasks: async (params) => {
      if (params.status[0] !== 'completed') return { tasks: [] };
      terminalListCalls += 1;
      return {
        tasks: [{
          id: 'recent-long-task',
          runtime: 'subagent',
          sessionKey: 'agent:main:session-1',
          runId: 'run-recent-long',
          title: 'Recently ended long task',
          status: 'completed',
          deliveryStatus: 'delivered',
          terminalOutcome: 'succeeded',
          createdAt: 10_000,
          updatedAt: 99_000,
          endedAt: 99_000,
        }, {
          id: 'old-terminal-task',
          runtime: 'subagent',
          sessionKey: 'agent:main:session-1',
          runId: 'run-old-terminal',
          title: 'Old terminal task',
          status: 'completed',
          deliveryStatus: 'delivered',
          terminalOutcome: 'succeeded',
          createdAt: 10_000,
          updatedAt: 20_000,
          endedAt: 20_000,
        }],
      };
    },
    getTask: async () => { throw new Error('terminal lookup not expected'); },
    emit: (event) => events.push(event),
    now: () => 100_000,
    terminalDiscoveryLookbackMs: 10_000,
  });

  await monitor.pollOnce();
  assert.equal(terminalListCalls, 1);
  assert.deepEqual(events.map((event) => event.taskId), ['recent-long-task']);
  assert.equal(events[0]?.sessionKey, 'agent:main:session-1');
  assert.equal(events[0]?.runId, 'run-recent-long');

  await monitor.pollOnce();
  assert.equal(terminalListCalls, 1);
  assert.equal(events.length, 1);
});

test('reconnect forces terminal discovery without waiting for the throttle window', async () => {
  let now = 40_000;
  let terminalTasks: unknown[] = [];
  let terminalListCalls = 0;
  const events: ChatRuntimeEvent[] = [];
  const monitor = new GatewayTaskLedgerMonitor({
    listTasks: async (params) => {
      if (params.status[0] !== 'completed') return { tasks: [] };
      terminalListCalls += 1;
      return { tasks: terminalTasks };
    },
    getTask: async () => { throw new Error('terminal lookup not expected'); },
    emit: (event) => events.push(event),
    now: () => now,
    intervalMs: 60_000,
  });

  await monitor.pollOnce();
  assert.equal(terminalListCalls, 1);

  monitor.stop();
  now = 41_000;
  terminalTasks = [{
    id: 'reconnect-task',
    runtime: 'cli',
    sessionKey: 'agent:main:session-1',
    runId: 'run-reconnect',
    status: 'failed',
    createdAt: 40_500,
    updatedAt: 40_900,
    endedAt: 40_900,
    error: 'Generation failed.',
  }];
  monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  monitor.stop();

  assert.equal(terminalListCalls, 2);
  assert.equal(events.at(-1)?.taskId, 'reconnect-task');
  assert.equal(events.at(-1)?.taskStatus, 'error');
});

test('an in-flight poll cannot consume a newer reconnect discovery request', async () => {
  let terminalListCalls = 0;
  let releaseFirstScan!: () => void;
  let markFirstScanStarted!: () => void;
  const firstScanGate = new Promise<void>((resolve) => { releaseFirstScan = resolve; });
  const firstScanStarted = new Promise<void>((resolve) => { markFirstScanStarted = resolve; });
  const monitor = new GatewayTaskLedgerMonitor({
    listTasks: async (params) => {
      if (params.status[0] !== 'completed') return { tasks: [] };
      terminalListCalls += 1;
      if (terminalListCalls === 1) {
        markFirstScanStarted();
        await firstScanGate;
      }
      return { tasks: [] };
    },
    getTask: async () => { throw new Error('terminal lookup not expected'); },
    emit: () => {},
    now: () => 50_000,
    intervalMs: 60_000,
  });

  const firstPoll = monitor.pollOnce();
  await firstScanStarted;
  monitor.start();
  releaseFirstScan();
  await firstPoll;
  monitor.stop();

  await monitor.pollOnce();
  assert.equal(terminalListCalls, 2);
});

test('failed terminal lookups rotate so entries after the first 32 are not starved', async () => {
  let active = true;
  const getCalls: string[] = [];
  const tasks = Array.from({ length: 33 }, (_, index) => ({
    id: `task-${index + 1}`,
    runtime: 'subagent',
    sessionKey: 'agent:main:session-1',
    runId: `run-${index + 1}`,
    status: 'running',
    createdAt: 19_000 + index,
    updatedAt: 19_500 + index,
  }));
  const monitor = new GatewayTaskLedgerMonitor({
    listTasks: async (params) => params.status[0] === 'completed'
      ? { tasks: [] }
      : { tasks: active ? tasks : [] },
    getTask: async (id) => {
      getCalls.push(id);
      throw new Error('temporary lookup failure');
    },
    emit: () => {},
    now: () => 20_000,
  });

  await monitor.pollOnce();
  active = false;
  await monitor.pollOnce();
  assert.equal(getCalls.length, 32);
  assert.equal(getCalls.includes('task-33'), false);

  await monitor.pollOnce();
  assert.equal(getCalls[32], 'task-33');
});

test('same-session native media tasks never become parents of unrelated work', async () => {
  const events: ChatRuntimeEvent[] = [];
  const monitor = new GatewayTaskLedgerMonitor({
    listTasks: async (params) => params.status[0] === 'completed' ? { tasks: [] } : ({
      tasks: [
        {
          id: 'media-task',
          runtime: 'cli',
          kind: 'image_generation',
          sessionKey: 'agent:main:session-1',
          ownerKey: 'agent:main:session-1',
          childSessionKey: 'agent:main:session-1',
          runId: 'run-media',
          status: 'running',
          updatedAt: 19_000,
        },
        {
          id: 'independent-task',
          runtime: 'cli',
          kind: 'video_generation',
          sessionKey: 'agent:main:session-1',
          ownerKey: 'agent:main:session-1',
          childSessionKey: 'agent:main:session-1',
          runId: 'run-independent',
          status: 'running',
          updatedAt: 19_100,
        },
      ],
    }),
    getTask: async () => { throw new Error('terminal lookup not expected'); },
    emit: (event) => events.push(event),
    now: () => 20_000,
  });

  await monitor.pollOnce();
  const independent = events.find((event) => event.taskId === 'independent-task');
  assert.equal(independent?.parentTaskId, undefined);
  assert.equal(independent?.runId, 'run-independent');
});
