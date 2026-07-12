import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HostTaskService,
  type HostTaskLifecycleExecutor,
} from '../electron/services/agent-runtime/host-task-service.ts';

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for Host task lifecycle condition');
}

function createRequest(idempotencyKey: string, input: unknown = {}) {
  return {
    sessionKey: 'agent:main:test-session',
    runId: 'run-test',
    toolCallId: `tool-${idempotencyKey}`,
    idempotencyKey,
    capability: 'example.safe-observe',
    title: `Task ${idempotencyKey}`,
    input,
  };
}

test('Host task lifecycle persists bounded input/checkpoint and delegates start, cancel, and safe resume once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-host-task-'));
  const serviceOptions = { rootDir: path.join(root, 'host-tasks') };
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  try {
    let starts = 0;
    let cancels = 0;
    let resumes = 0;
    const executor: HostTaskLifecycleExecutor = {
      async start(context) {
        starts += 1;
        assert.deepEqual(context.input, { request: { target: 'screen' } });
        await context.update({
          status: 'running',
          checkpoint: { phase: 'observing', cursor: 1 },
          progress: { detail: 'observing' },
        });
      },
      async cancel(context) {
        cancels += 1;
        assert.equal(context.reason, 'stop test work');
        await context.update({ checkpoint: { phase: 'cancelled', cursor: 1 } });
      },
      async resume(context) {
        resumes += 1;
        assert.deepEqual(context.input, { request: { target: 'screen' } });
        assert.deepEqual(context.checkpoint, { phase: 'interrupted', cursor: 7 });
        await context.update({
          status: 'running',
          checkpoint: { phase: 'observing', cursor: 8 },
          progress: { detail: 'resumed' },
        });
        await context.update({
          status: 'succeeded',
          checkpoint: { phase: 'completed', cursor: 8 },
          progress: { completed: 1, total: 1, detail: 'done' },
        });
      },
    };

    const service = new HostTaskService(serviceOptions);
    const created = await service.create(createRequest('start-once', { request: { target: 'screen' } }));
    assert.equal(created.task.version, 2);
    assert.deepEqual(created.task.input, { request: { target: 'screen' } });

    const firstStart = await service.dispatchStart(created.task.taskId, executor);
    assert.equal(firstStart.dispatched, true);
    await waitUntil(async () => (await service.get(created.task.taskId))?.lifecycle.operations.at(-1)?.status === 'completed');
    const duplicateStart = await service.dispatchStart(created.task.taskId, executor);
    assert.equal(duplicateStart.dispatched, false);
    assert.equal(starts, 1);

    const persistedRunning = await service.get(created.task.taskId);
    assert.deepEqual(persistedRunning?.checkpoint, { phase: 'observing', cursor: 1 });
    const cancel = await service.requestCancel(created.task.taskId, executor, 'stop test work');
    assert.equal(cancel.dispatched, true);
    const cancelled = await service.waitForTerminal(created.task.taskId, 2_000);
    assert.equal(cancelled?.status, 'cancelled');
    assert.deepEqual(cancelled?.checkpoint, { phase: 'cancelled', cursor: 1 });
    const duplicateCancel = await service.requestCancel(created.task.taskId, executor, 'stop test work');
    assert.equal(duplicateCancel.dispatched, false);
    assert.equal(cancels, 1);
    const cancelledRevision = cancelled?.revision;
    await assert.rejects(
      service.update(created.task.taskId, {
        progress: { detail: 'late worker callback' },
        checkpoint: { phase: 'late' },
        artifacts: [{ id: 'late-terminal-artifact', filePath: '/tmp/late-terminal.txt' }],
      }),
      /already terminal/,
    );
    const afterLateUpdate = await service.get(created.task.taskId);
    assert.equal(afterLateUpdate?.revision, cancelledRevision);
    assert.equal(afterLateUpdate?.artifacts.some((artifact) => artifact.id === 'late-terminal-artifact'), false);

    const recoverable = await service.create(createRequest('resume-once', { request: { target: 'screen' } }));
    await service.update(recoverable.task.taskId, {
      status: 'lost',
      checkpoint: { phase: 'interrupted', cursor: 7 },
      error: 'simulated host restart',
    });

    const restartedService = new HostTaskService(serviceOptions);
    const recovered = await restartedService.recover(recoverable.task.taskId, 'resume_if_safe', executor);
    assert.equal(recovered.dispatched, true);
    const resumed = await restartedService.waitForTerminal(recoverable.task.taskId, 2_000);
    assert.equal(resumed?.status, 'succeeded');
    assert.deepEqual(resumed?.checkpoint, { phase: 'completed', cursor: 8 });
    assert.equal(resumes, 1);
    const duplicateResume = await restartedService.recover(recoverable.task.taskId, 'resume_if_safe', executor);
    assert.equal(duplicateResume.dispatched, false);
    assert.equal(resumes, 1);

    const exactReplay = await restartedService.create(createRequest('resume-once', { request: { target: 'screen' } }));
    assert.equal(exactReplay.idempotent, true);
    await assert.rejects(
      restartedService.create(createRequest('resume-once', { request: { target: 'different' } })),
      /idempotency key was reused/,
    );
    await assert.rejects(
      restartedService.create(createRequest('invalid-json', { value: 1n })),
      /JSON-compatible/,
    );
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellation fences late updates from an older start operation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-host-task-cancel-fence-'));
  const serviceOptions = { rootDir: path.join(root, 'host-tasks') };
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  try {
    let releaseStart!: () => void;
    let markStartEntered!: () => void;
    const startEntered = new Promise<void>((resolve) => { markStartEntered = resolve; });
    const startRelease = new Promise<void>((resolve) => { releaseStart = resolve; });
    const executor: HostTaskLifecycleExecutor = {
      async start(context) {
        markStartEntered();
        await startRelease;
        await context.update({
          checkpoint: { phase: 'late' },
          artifacts: [{ id: 'late-artifact', filePath: '/tmp/late.txt' }],
        });
      },
      async cancel() {},
    };

    const service = new HostTaskService(serviceOptions);
    const created = await service.create(createRequest('cancel-fence'));
    assert.equal((await service.dispatchStart(created.task.taskId, executor)).dispatched, true);
    await startEntered;
    assert.equal((await service.requestCancel(created.task.taskId, executor, 'cancel fence test')).dispatched, true);
    const cancelled = await service.waitForTerminal(created.task.taskId, 2_000);
    assert.equal(cancelled?.status, 'cancelled');
    const cancelledRevision = cancelled?.revision;

    releaseStart();
    await waitUntil(async () => (
      (await service.get(created.task.taskId))?.lifecycle.operations
        .some((operation) => operation.kind === 'start' && operation.status === 'failed') === true
    ));
    const final = await service.get(created.task.taskId);
    assert.equal(final?.status, 'cancelled');
    assert.equal(final?.revision, cancelledRevision);
    assert.deepEqual(final?.artifacts, []);
    assert.equal(final?.checkpoint, undefined);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await rm(root, { recursive: true, force: true });
  }
});

test('a public update cannot bypass an in-flight cancellation claim', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-host-task-public-update-fence-'));
  const serviceOptions = { rootDir: path.join(root, 'host-tasks') };
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  try {
    let releaseCancel!: () => void;
    let markCancelEntered!: () => void;
    const cancelEntered = new Promise<void>((resolve) => { markCancelEntered = resolve; });
    const cancelRelease = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const executor: HostTaskLifecycleExecutor = {
      async start(context) {
        await context.update({ status: 'running', checkpoint: { phase: 'working' } });
      },
      async cancel() {
        markCancelEntered();
        await cancelRelease;
      },
    };

    const service = new HostTaskService(serviceOptions);
    const created = await service.create(createRequest('public-update-fence'));
    await service.dispatchStart(created.task.taskId, executor);
    await waitUntil(async () => (
      (await service.get(created.task.taskId))?.lifecycle.operations.at(-1)?.status === 'completed'
    ));
    await service.requestCancel(created.task.taskId, executor, 'cancel in progress');
    await cancelEntered;

    await assert.rejects(
      service.update(created.task.taskId, {
        status: 'succeeded',
        artifacts: [{ id: 'bypass-artifact', filePath: '/tmp/bypass.txt' }],
      }),
      /operation token/,
    );
    assert.equal((await service.get(created.task.taskId))?.status, 'running');

    releaseCancel();
    const cancelled = await service.waitForTerminal(created.task.taskId, 2_000);
    assert.equal(cancelled?.status, 'cancelled');
    assert.equal(cancelled?.artifacts.some((artifact) => artifact.id === 'bypass-artifact'), false);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await rm(root, { recursive: true, force: true });
  }
});

test('a new Host owner marks an interrupted claim lost and only resumes through a safe executor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-host-task-start-reclaim-'));
  const serviceOptions = { rootDir: path.join(root, 'host-tasks') };
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  try {
    let firstStartEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstStartEntered = resolve; });
    const neverCompletes = new Promise<void>(() => {});
    const firstExecutor: HostTaskLifecycleExecutor = {
      async start() {
        firstStartEntered();
        await neverCompletes;
      },
    };
    let safeResumes = 0;
    const reclaimedExecutor: HostTaskLifecycleExecutor = {
      async start() {
        throw new Error('start must not replay after a persisted claim');
      },
      async resume(context) {
        safeResumes += 1;
        await context.update({ status: 'succeeded', checkpoint: { phase: 'reclaimed' } });
      },
    };

    const firstHost = new HostTaskService(serviceOptions);
    const created = await firstHost.create(createRequest('start-reclaim'));
    assert.equal((await firstHost.dispatchStart(created.task.taskId, firstExecutor)).dispatched, true);
    await firstStarted;
    assert.equal((await firstHost.get(created.task.taskId))?.lifecycle.operations[0]?.status, 'running');

    const restartedHost = new HostTaskService(serviceOptions);
    const interrupted = await restartedHost.get(created.task.taskId);
    assert.equal(interrupted?.status, 'lost');
    assert.equal(interrupted?.lifecycle.operations[0]?.status, 'interrupted');
    assert.equal((await restartedHost.dispatchStart(created.task.taskId, reclaimedExecutor)).dispatched, false);
    const reclaimed = await restartedHost.recover(created.task.taskId, 'resume_if_safe', reclaimedExecutor);
    assert.equal(reclaimed.dispatched, true);
    const completed = await restartedHost.waitForTerminal(created.task.taskId, 2_000);
    assert.equal(completed?.status, 'succeeded');
    assert.equal(safeResumes, 1);
    await waitUntil(async () => (
      (await restartedHost.get(created.task.taskId))?.lifecycle.operations.at(-1)?.status === 'completed'
    ));
    const settled = await restartedHost.get(created.task.taskId);
    assert.deepEqual(settled?.lifecycle.operations.map(({ kind, status }) => ({ kind, status })), [
      { kind: 'start', status: 'interrupted' },
      { kind: 'resume', status: 'completed' },
    ]);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await rm(root, { recursive: true, force: true });
  }
});
