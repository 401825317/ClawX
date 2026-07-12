import assert from 'node:assert/strict';
import test from 'node:test';

import { HostCapabilityRegistry } from '../electron/services/agent-runtime/host-capability-registry.ts';

test('Host capability registry reports assessed availability and preserves executor ownership', async () => {
  const registry = new HostCapabilityRegistry();
  let starts = 0;
  let resumes = 0;
  registry.register({
    descriptor: {
      kind: 'example.observe',
      label: 'Example observation',
      description: 'Safe test executor',
      sideEffect: 'none',
      requiresApproval: false,
    },
    async assess() {
      return { availability: 'available' };
    },
    async start() {
      starts += 1;
    },
    async resume() {
      resumes += 1;
    },
  });

  const resolved = await registry.get('example.observe');
  assert.equal(resolved?.capability.availability, 'available');
  assert.equal(resolved?.capability.sideEffect, 'none');
  assert.deepEqual(resolved?.capability.operations, { start: true, cancel: false, resume: true });
  await resolved?.executor.start({
    task: {
      version: 2,
      taskId: 'task-example',
      sessionKey: 'agent:main:test',
      runId: 'run-test',
      toolCallId: 'tool-test',
      idempotencyKey: 'test-key',
      capability: 'example.observe',
      title: 'Example',
      input: {},
      status: 'queued',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      artifacts: [],
      verifications: [],
      completionAcks: [],
      lifecycle: { operations: [] },
    },
    input: {},
    async update() {
      return undefined;
    },
  });
  assert.equal(starts, 1);
  await resolved?.executor.resume?.({
    task: {
      version: 2,
      taskId: 'task-example',
      sessionKey: 'agent:main:test',
      runId: 'run-test',
      toolCallId: 'tool-test',
      idempotencyKey: 'test-key',
      capability: 'example.observe',
      title: 'Example',
      input: {},
      status: 'lost',
      createdAt: 1,
      updatedAt: 2,
      revision: 2,
      artifacts: [],
      verifications: [],
      completionAcks: [],
      lifecycle: { operations: [] },
    },
    input: {},
    async update() {
      return undefined;
    },
  });
  assert.equal(resumes, 1);
});

test('Host capability registry rejects duplicate and malformed capability names', () => {
  const registry = new HostCapabilityRegistry();
  const executor = {
    descriptor: {
      kind: 'example.task',
      label: 'Example',
      description: 'Example',
      sideEffect: 'none' as const,
      requiresApproval: false,
    },
    async start() {},
  };
  registry.register(executor);
  assert.throws(() => registry.register(executor), /already registered/);
  assert.throws(() => registry.register({
    ...executor,
    descriptor: { ...executor.descriptor, kind: 'invalid space' },
  }), /Invalid/);
});
