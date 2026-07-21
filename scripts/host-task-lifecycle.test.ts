import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ChatRuntimeEvent } from '../shared/chat-runtime-events.ts';
import {
  HostTaskService,
  type HostTaskLifecycleExecutor,
} from '../electron/services/agent-runtime/host-task-service.ts';
import { applyRuntimeEventToRuns } from '../src/stores/chat/runtime-graph.ts';

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
    acceptance: {
      source: 'host_capability' as const,
      requiresArtifact: false,
      requiresVerification: false,
      requiredVerificationKinds: [],
    },
    completion: { mode: 'direct' as const },
  };
}

test('Host task persistence preserves an internal composition-step completion mode', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-host-task-internal-step-'));
  const serviceOptions = { rootDir: path.join(root, 'host-tasks') };
  try {
    const service = new HostTaskService(serviceOptions);
    const created = await service.create({
      ...createRequest('internal-compose-step'),
      completion: { mode: 'internal' },
    });
    assert.equal(created.task.completion.mode, 'internal');

    const restarted = new HostTaskService(serviceOptions);
    const restored = await restarted.get(created.task.taskId);
    assert.equal(restored?.completion.mode, 'internal');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Host task persistence pins the default state root after initialization', async () => {
  const initialStateDir = await mkdtemp(path.join(os.tmpdir(), 'uclaw-host-task-root-initial-'));
  const redirectedStateDir = await mkdtemp(path.join(os.tmpdir(), 'uclaw-host-task-root-redirected-'));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = initialStateDir;
  try {
    const service = new HostTaskService();
    const created = await service.create(createRequest('root-pinning'));

    process.env.OPENCLAW_STATE_DIR = redirectedStateDir;
    await service.update(created.task.taskId, {
      status: 'running',
      progress: { detail: 'persist after environment restoration' },
    });

    const persisted = JSON.parse(await readFile(path.join(
      initialStateDir,
      'uclaw-runtime',
      'host-tasks',
      'jobs',
      created.task.taskId,
      'task.json',
    ), 'utf8')) as { status?: string; progress?: { detail?: string } };
    assert.equal(persisted.status, 'running');
    assert.equal(persisted.progress?.detail, 'persist after environment restoration');
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await Promise.all([
      rm(initialStateDir, { recursive: true, force: true }),
      rm(redirectedStateDir, { recursive: true, force: true }),
    ]);
  }
});

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
    assert.equal(created.task.version, 3);
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

test('Host task success is blocked until capability-derived artifact and verification evidence pass', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-host-task-acceptance-'));
  const service = new HostTaskService({ rootDir: path.join(root, 'host-tasks') });
  const acceptance = {
    source: 'host_capability' as const,
    requiresArtifact: true,
    requiresVerification: true,
    requiredVerificationKinds: ['artifact.availability'],
  };
  try {
    const blocked = await service.create({
      ...createRequest('acceptance-blocked'),
      acceptance,
    });
    const blockedExecutor: HostTaskLifecycleExecutor = {
      async start(context) {
        await context.update({ status: 'succeeded' });
      },
    };
    await service.dispatchStart(blocked.task.taskId, blockedExecutor);
    const blockedResult = await service.waitForTerminal(blocked.task.taskId, 2_000);
    assert.equal(blockedResult?.status, 'blocked');
    assert.match(blockedResult?.error ?? '', /requires an output artifact/);

    const artifactPath = path.join(root, 'verified.txt');
    await writeFile(artifactPath, 'verified output');
    const missingVerification = await service.create({
      ...createRequest('acceptance-missing-verification'),
      acceptance,
    });
    const missingVerificationExecutor: HostTaskLifecycleExecutor = {
      async start(context) {
        await context.update({
          status: 'succeeded',
          artifacts: [{ id: 'artifact-unverified', kind: 'file', filePath: artifactPath }],
        });
      },
    };
    await service.dispatchStart(missingVerification.task.taskId, missingVerificationExecutor);
    const missingVerificationResult = await service.waitForTerminal(missingVerification.task.taskId, 2_000);
    assert.equal(missingVerificationResult?.status, 'blocked');
    assert.match(missingVerificationResult?.error ?? '', /requires a passed artifact\.availability verification/);

    const unrelatedVerification = await service.create({
      ...createRequest('acceptance-unrelated-verification'),
      acceptance,
    });
    await service.dispatchStart(unrelatedVerification.task.taskId, {
      async start(context) {
        await context.update({
          status: 'succeeded',
          artifacts: [{ id: 'artifact-target', kind: 'file', filePath: artifactPath }],
          verifications: [{
            id: 'verification-unrelated',
            status: 'passed',
            kind: 'artifact.availability',
            required: true,
            artifactId: 'artifact-other',
          }],
        });
      },
    });
    const unrelatedVerificationResult = await service.waitForTerminal(unrelatedVerification.task.taskId, 2_000);
    assert.equal(unrelatedVerificationResult?.status, 'blocked');
    assert.match(unrelatedVerificationResult?.error ?? '', /requires a passed artifact\.availability verification/);

    const passed = await service.create({
      ...createRequest('acceptance-passed'),
      acceptance,
    });
    const passedExecutor: HostTaskLifecycleExecutor = {
      async start(context) {
        const artifactId = 'artifact-verified';
        await context.update({
          status: 'succeeded',
          artifacts: [{ id: artifactId, kind: 'file', filePath: artifactPath }],
          verifications: [{
            id: 'verification-verified',
            status: 'passed',
            kind: 'artifact.availability',
            required: true,
            artifactId,
          }],
        });
      },
    };
    await service.dispatchStart(passed.task.taskId, passedExecutor);
    const passedResult = await service.waitForTerminal(passed.task.taskId, 2_000);
    assert.equal(passedResult?.status, 'succeeded');
    assert.equal(passedResult?.artifacts[0]?.sizeBytes, 15);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Host task completion settlement persists abandonment and explicit redelivery opens a new revision', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-host-task-delivery-'));
  const hostRoot = path.join(root, 'host-tasks');
  try {
    const service = new HostTaskService({ rootDir: hostRoot });
    const created = await service.create(createRequest('completion-delivery'));
    const artifactPath = path.join(root, 'delivery.txt');
    await writeFile(artifactPath, 'delivery evidence');
    const completed = await service.update(created.task.taskId, {
      status: 'succeeded',
      artifacts: [{ id: 'delivery-artifact', kind: 'file', filePath: artifactPath }],
    });
    assert.equal(completed?.status, 'succeeded');
    const deliveryKey = `uclaw-task-bridge:completion:${created.task.taskId}:${completed?.revision}`;
    const acknowledged = await service.acknowledgeCompletion(created.task.taskId, deliveryKey, {
      outcome: 'abandoned',
      kind: 'openclaw_runtime_events',
      attempts: 5,
      firstAttemptAt: 1_000,
      lastAttemptAt: 2_000,
      reason: 'runtime_event_delivery_failed',
      details: { reason: 'session unavailable' },
    });
    assert.deepEqual(acknowledged?.completionAcks, [deliveryKey]);
    assert.equal(acknowledged?.completionDeliveries[0]?.outcome, 'abandoned');
    assert.equal(acknowledged?.completionDeliveries[0]?.attempts, 5);

    const restarted = new HostTaskService({ rootDir: hostRoot });
    const persisted = await restarted.get(created.task.taskId);
    assert.equal(persisted?.completionDeliveries[0]?.reason, 'runtime_event_delivery_failed');
    assert.deepEqual(persisted?.completionDeliveries[0]?.details, { reason: 'session unavailable' });
    const journal = await readFile(
      path.join(hostRoot, 'jobs', created.task.taskId, 'journal.jsonl'),
      'utf8',
    );
    assert.match(journal, /task\.completion_abandoned/);
    assert.match(journal, /runtime_event_delivery_failed/);

    const redelivery = await restarted.recover(created.task.taskId, 'redeliver_existing_artifacts');
    assert.equal(redelivery.task?.revision, (completed?.revision ?? 0) + 1);
    assert.deepEqual(redelivery.task?.completionAcks, []);
    assert.deepEqual(redelivery.task?.completionDeliveries, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Host task v3 store does not load legacy v2 snapshots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-host-task-v3-only-'));
  const hostRoot = path.join(root, 'host-tasks');
  const legacyTaskId = 'legacy-v2-task';
  const legacyDir = path.join(hostRoot, 'jobs', legacyTaskId);
  await mkdir(legacyDir, { recursive: true });
  await writeFile(path.join(legacyDir, 'task.json'), JSON.stringify({
    version: 2,
    taskId: legacyTaskId,
    sessionKey: 'agent:main:legacy',
    runId: 'run-legacy',
    toolCallId: 'tool-legacy',
    idempotencyKey: 'legacy-key',
    capability: 'legacy.capability',
    title: 'Legacy task',
    input: {},
    status: 'succeeded',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    artifacts: [],
    verifications: [],
    completionAcks: [],
    lifecycle: { operations: [] },
  }));
  try {
    const service = new HostTaskService({ rootDir: hostRoot });
    assert.equal(await service.get(legacyTaskId), undefined);
    assert.deepEqual(await service.list(), []);
  } finally {
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
    await waitUntil(async () => (
      (await service.get(created.task.taskId))?.lifecycle.operations
        .some((operation) => operation.kind === 'cancel' && operation.status === 'completed') === true
    ));
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await rm(root, { recursive: true, force: true });
  }
});

test('live Host task cancellation publishes aborted runtime semantics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-host-task-live-cancel-'));
  const service = new HostTaskService({ rootDir: path.join(root, 'host-tasks') });
  const events: ChatRuntimeEvent[] = [];
  service.setPublisher((event) => events.push(event));
  const executor: HostTaskLifecycleExecutor = {
    async start(context) {
      await context.update({ status: 'running', progress: { detail: 'working' } });
    },
    async cancel() {},
  };

  try {
    const created = await service.create(createRequest('live-cancel'));
    await service.dispatchStart(created.task.taskId, executor);
    await waitUntil(async () => (
      (await service.get(created.task.taskId))?.lifecycle.operations.at(-1)?.status === 'completed'
    ));

    const cancelStartIndex = events.length;
    assert.equal((await service.requestCancel(created.task.taskId, executor, 'stop live work')).dispatched, true);
    assert.equal((await service.waitForTerminal(created.task.taskId, 2_000))?.status, 'cancelled');
    await waitUntil(async () => (
      (await service.get(created.task.taskId))?.lifecycle.operations.at(-1)?.status === 'completed'
    ));

    const cancellationEvents = events.slice(cancelStartIndex);
    const taskEvent = cancellationEvents.findLast((event) => event.type === 'task.updated');
    const stepEvent = cancellationEvents.findLast((event) => event.type === 'run.step.updated');
    const progressEvent = cancellationEvents.findLast((event) => event.type === 'progress.update');

    assert.equal(taskEvent?.task.status, 'aborted');
    assert.equal(taskEvent?.task.sourceStatus, 'cancelled');
    assert.equal(taskEvent?.task.terminalOutcome, 'cancelled');
    assert.equal(stepEvent?.step.status, 'aborted');
    assert.equal(progressEvent?.entry.status, 'aborted');
    assert.equal(cancellationEvents.some((event) => event.type === 'tool.completed'), false);
    assert.equal(events.reduce((runs, event) => applyRuntimeEventToRuns(runs, event), {})['run-test']?.status, 'aborted');
  } finally {
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
