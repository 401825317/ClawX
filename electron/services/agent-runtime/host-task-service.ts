import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ChatRuntimeArtifact,
  ChatRuntimeEvent,
  ChatRuntimeVerification,
} from '../../../shared/chat-runtime-events';
import { getOpenClawConfigDir } from '../../utils/paths';

export type HostTaskStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'timed_out' | 'lost';
export type HostTaskData = null | boolean | number | string | HostTaskData[] | { [key: string]: HostTaskData };
export type HostTaskOperationKind = 'start' | 'resume' | 'cancel';
export type HostTaskOperationStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export type HostTaskAcceptance = {
  source: 'host_capability';
  requiresArtifact: boolean;
  requiresVerification: boolean;
  requiredVerificationKinds: string[];
  outputDescription?: string;
};

export type HostTaskCompletion = {
  // Internal tasks are durable Host steps that must finish before a later
  // task can produce a user-visible artifact. They are acknowledged by the
  // bridge without injecting a completion turn.
  mode: 'direct' | 'replan' | 'internal';
  reason?: string;
};

export type HostTaskOperation = {
  operationId: string;
  kind: HostTaskOperationKind;
  status: HostTaskOperationStatus;
  ownerId: string;
  attempt: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

export type HostTaskSnapshot = {
  version: 3;
  taskId: string;
  sessionKey: string;
  runId: string;
  toolCallId: string;
  idempotencyKey: string;
  capability: string;
  title: string;
  input: HostTaskData;
  acceptance: HostTaskAcceptance;
  completion: HostTaskCompletion;
  checkpoint?: HostTaskData;
  status: HostTaskStatus;
  createdAt: number;
  updatedAt: number;
  revision: number;
  progress?: { completed?: number; total?: number; detail?: string };
  error?: string;
  artifacts: ChatRuntimeArtifact[];
  verifications: ChatRuntimeVerification[];
  completionAcks: string[];
  lifecycle: { operations: HostTaskOperation[] };
};

export type HostTaskCreateRequest = {
  sessionKey: string;
  runId: string;
  toolCallId: string;
  idempotencyKey: string;
  capability: string;
  title: string;
  input?: unknown;
  acceptance: HostTaskAcceptance;
  completion?: HostTaskCompletion;
  status?: Extract<HostTaskStatus, 'queued' | 'running' | 'waiting'>;
};

export type HostTaskUpdateRequest = {
  status?: HostTaskStatus;
  progress?: { completed?: number; total?: number; detail?: string };
  checkpoint?: unknown;
  error?: string;
  artifacts?: ChatRuntimeArtifact[];
  verifications?: ChatRuntimeVerification[];
};

export type HostTaskExecutorContext = {
  task: HostTaskSnapshot;
  input: HostTaskData;
  checkpoint?: HostTaskData;
  update: (update: HostTaskUpdateRequest) => Promise<HostTaskSnapshot | undefined>;
};

export type HostTaskLifecycleExecutor = {
  start: (context: HostTaskExecutorContext) => Promise<void>;
  resume?: (context: HostTaskExecutorContext) => Promise<void>;
  cancel?: (context: HostTaskExecutorContext & { reason: string }) => Promise<void>;
};

export type HostTaskServiceOptions = {
  rootDir?: string;
};

type RuntimePublisher = (event: ChatRuntimeEvent) => void;
type DispatchResult = { task?: HostTaskSnapshot; dispatched: boolean };

const TERMINAL = new Set<HostTaskStatus>(['succeeded', 'failed', 'blocked', 'cancelled', 'timed_out', 'lost']);
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_TASK_DATA_BYTES = 64 * 1024;
const MAX_TASK_DATA_DEPTH = 12;
const MAX_TASK_DATA_NODES = 4_096;
const MAX_TASK_DATA_STRING = 16_384;
const MAX_TASK_DATA_ITEMS = 512;
const MAX_LIFECYCLE_OPERATIONS = 64;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function shortText(value: unknown, maximum = 1_000): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function normalizeTaskData(value: unknown, label: string, allowUndefined = false): HostTaskData | undefined {
  if (value === undefined) {
    if (allowUndefined) return undefined;
    value = {};
  }
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): HostTaskData => {
    nodes += 1;
    if (nodes > MAX_TASK_DATA_NODES) throw new Error(`${label} is too complex`);
    if (depth > MAX_TASK_DATA_DEPTH) throw new Error(`${label} is too deeply nested`);
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error(`${label} contains a non-finite number`);
      return current;
    }
    if (typeof current === 'string') {
      if (current.length > MAX_TASK_DATA_STRING) throw new Error(`${label} contains an oversized string`);
      return current;
    }
    if (!current || typeof current !== 'object') throw new Error(`${label} must contain JSON-compatible values only`);
    if (seen.has(current)) throw new Error(`${label} contains a circular reference`);
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > MAX_TASK_DATA_ITEMS) throw new Error(`${label} contains too many array items`);
      const result = current.map((item) => visit(item, depth + 1));
      seen.delete(current);
      return result;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must contain plain objects only`);
    const entries = Object.entries(current as Record<string, unknown>);
    if (entries.length > MAX_TASK_DATA_ITEMS) throw new Error(`${label} contains too many object fields`);
    const result: Record<string, HostTaskData> = {};
    for (const [key, item] of entries) {
      if (!key || key.length > 256 || FORBIDDEN_KEYS.has(key)) throw new Error(`${label} contains an invalid object field`);
      result[key] = visit(item, depth + 1);
    }
    seen.delete(current);
    return result;
  };
  const normalized = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_TASK_DATA_BYTES) throw new Error(`${label} exceeds 64 KiB`);
  return normalized;
}

function normalizeProgress(value: HostTaskUpdateRequest['progress']): HostTaskSnapshot['progress'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const completed = typeof value.completed === 'number' && Number.isFinite(value.completed)
    ? Math.max(0, Math.floor(value.completed))
    : undefined;
  const total = typeof value.total === 'number' && Number.isFinite(value.total)
    ? Math.max(0, Math.floor(value.total))
    : undefined;
  const detail = shortText(value.detail);
  return completed !== undefined || total !== undefined || detail
    ? { completed, total, detail }
    : undefined;
}

function normalizeAcceptance(value: HostTaskAcceptance): HostTaskAcceptance {
  if (!value || value.source !== 'host_capability') throw new Error('Host task acceptance must come from a Host capability');
  const requiredVerificationKinds = [...new Set(
    (Array.isArray(value.requiredVerificationKinds) ? value.requiredVerificationKinds : [])
      .map((kind) => shortText(kind, 160))
      .filter((kind): kind is string => Boolean(kind)),
  )];
  const requiresVerification = value.requiresVerification === true || requiredVerificationKinds.length > 0;
  return {
    source: 'host_capability',
    requiresArtifact: value.requiresArtifact === true,
    requiresVerification,
    requiredVerificationKinds,
    ...(shortText(value.outputDescription, 1_000) ? { outputDescription: shortText(value.outputDescription, 1_000) } : {}),
  };
}

function normalizeCompletion(value: HostTaskCompletion | undefined): HostTaskCompletion {
  const mode = value?.mode === 'replan'
    ? 'replan'
    : value?.mode === 'internal'
      ? 'internal'
      : 'direct';
  const reason = shortText(value?.reason, 1_000);
  if (mode === 'replan' && !reason) throw new Error('Host task replan completion requires a reason');
  return { mode, ...(reason ? { reason } : {}) };
}

function normalizeLifecycle(value: unknown): HostTaskSnapshot['lifecycle'] {
  const operations = value && typeof value === 'object' && Array.isArray((value as { operations?: unknown }).operations)
    ? (value as { operations: unknown[] }).operations
    : [];
  return {
    operations: operations.slice(-MAX_LIFECYCLE_OPERATIONS).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Partial<HostTaskOperation>;
      if (!record.operationId || !record.ownerId || !record.kind || !record.status || !record.startedAt) return [];
      if (!['start', 'resume', 'cancel'].includes(record.kind)) return [];
      if (!['running', 'completed', 'failed', 'interrupted'].includes(record.status)) return [];
      return [{
        operationId: record.operationId,
        kind: record.kind,
        status: record.status,
        ownerId: record.ownerId,
        attempt: typeof record.attempt === 'number' && Number.isFinite(record.attempt) ? Math.max(1, Math.floor(record.attempt)) : 1,
        startedAt: record.startedAt,
        ...(typeof record.finishedAt === 'number' ? { finishedAt: record.finishedAt } : {}),
        ...(shortText(record.error) ? { error: shortText(record.error) } : {}),
      } satisfies HostTaskOperation];
    }),
  };
}

function runtimeStatus(status: HostTaskStatus): 'pending' | 'running' | 'completed' | 'error' | 'blocked' {
  if (status === 'queued') return 'pending';
  if (status === 'running') return 'running';
  if (status === 'succeeded') return 'completed';
  if (status === 'waiting' || status === 'blocked') return 'blocked';
  return 'error';
}

function runtimeProgressStatus(status: HostTaskStatus): 'running' | 'completed' | 'blocked' | 'error' {
  if (status === 'succeeded') return 'completed';
  if (status === 'waiting' || status === 'blocked') return 'blocked';
  if (status === 'failed' || status === 'cancelled' || status === 'timed_out' || status === 'lost') return 'error';
  return 'running';
}

function taskRoot(): string {
  return path.join(getOpenClawConfigDir(), 'uclaw-runtime', 'host-tasks');
}

/**
 * Durable executor facts for OpenClaw-owned tool calls. This service never
 * chooses a capability or manufactures assistant text; it tracks an executor
 * that was explicitly started by an OpenClaw plugin tool.
 */
export class HostTaskService {
  private readonly tasks = new Map<string, HostTaskSnapshot>();
  private readonly idempotency = new Map<string, string>();
  private readonly waiters = new Map<string, Set<(snapshot: HostTaskSnapshot) => void>>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly ownerId = randomUUID();
  private readonly configuredRootDir?: string;
  private initialized?: Promise<void>;
  private publisher?: RuntimePublisher;

  constructor(options: HostTaskServiceOptions = {}) {
    this.configuredRootDir = options.rootDir;
  }

  private getRootDir(): string {
    return this.configuredRootDir ?? taskRoot();
  }

  setPublisher(publisher: RuntimePublisher): void {
    this.publisher = publisher;
  }

  async create(input: HostTaskCreateRequest): Promise<{ task: HostTaskSnapshot; idempotent: boolean }> {
    await this.ensureInitialized();
    this.validateCreate(input);
    const normalizedInput = normalizeTaskData(input.input, 'Host task input') ?? {};
    const acceptance = normalizeAcceptance(input.acceptance);
    const completion = normalizeCompletion(input.completion);
    const key = `${input.sessionKey.trim()}:${input.idempotencyKey.trim()}`;
    const existingId = this.idempotency.get(key);
    const existing = existingId ? this.tasks.get(existingId) : undefined;
    if (existing) {
      this.assertIdempotentReplay(existing, input, normalizedInput, acceptance, completion);
      return { task: clone(existing), idempotent: true };
    }

    const now = Date.now();
    const task: HostTaskSnapshot = {
      version: 3,
      taskId: randomUUID(),
      sessionKey: input.sessionKey.trim(),
      runId: input.runId.trim(),
      toolCallId: input.toolCallId.trim(),
      idempotencyKey: input.idempotencyKey.trim(),
      capability: input.capability.trim(),
      title: input.title.trim(),
      input: normalizedInput,
      acceptance,
      completion,
      status: input.status ?? 'queued',
      createdAt: now,
      updatedAt: now,
      revision: 1,
      artifacts: [],
      verifications: [],
      completionAcks: [],
      lifecycle: { operations: [] },
    };
    this.tasks.set(task.taskId, task);
    this.idempotency.set(key, task.taskId);
    await this.persist(task, 'task.created');
    this.publish(task, [
      {
        type: 'run.step.updated',
        step: { id: `host-task:${task.taskId}`, title: task.title, kind: `host.${task.capability}`, status: runtimeStatus(task.status) },
      },
      {
        type: 'progress.update',
        entry: {
          id: `host-task:${task.taskId}:state`,
          kind: 'status',
          text: task.title,
          status: runtimeProgressStatus(task.status),
          toolCallId: task.toolCallId,
          source: 'native',
        },
      },
    ]);
    return { task: clone(task), idempotent: false };
  }

  async dispatchStart(taskId: string, executor: HostTaskLifecycleExecutor): Promise<DispatchResult> {
    const claim = await this.claimOperation(taskId, 'start');
    if (!claim.task || !claim.operation) return { task: claim.task, dispatched: false };
    void this.executeOperation(taskId, claim.operation.operationId, 'start', executor);
    return { task: claim.task, dispatched: true };
  }

  async requestCancel(taskId: string, executor: HostTaskLifecycleExecutor, reason = 'Cancelled by user'): Promise<DispatchResult> {
    if (!executor.cancel) throw new Error('Host capability does not support cancellation');
    const normalizedReason = shortText(reason) ?? 'Cancelled by user';
    const claim = await this.claimOperation(taskId, 'cancel', normalizedReason);
    if (!claim.task || !claim.operation) return { task: claim.task, dispatched: false };
    void this.executeOperation(taskId, claim.operation.operationId, 'cancel', executor, normalizedReason);
    return { task: claim.task, dispatched: true };
  }

  async update(taskId: string, update: HostTaskUpdateRequest): Promise<HostTaskSnapshot | undefined> {
    return this.applyUpdate(taskId, update, undefined, true);
  }

  private async applyUpdate(
    taskId: string,
    update: HostTaskUpdateRequest,
    operationId?: string,
    external = false,
  ): Promise<HostTaskSnapshot | undefined> {
    await this.ensureInitialized();
    return this.withTaskLock(taskId, async (task) => {
      if (operationId) {
        const operation = task.lifecycle.operations.find((candidate) => candidate.operationId === operationId);
        const cancellationClaimed = task.lifecycle.operations.some((candidate) => (
          candidate.kind === 'cancel'
          && candidate.status === 'running'
          && candidate.operationId !== operationId
        ));
        if (
          !operation
          || operation.ownerId !== this.ownerId
          || operation.status !== 'running'
          || (operation.kind !== 'cancel' && (TERMINAL.has(task.status) || cancellationClaimed))
        ) {
          throw new Error(`Host task ${task.taskId} rejected an update from a stale ${operation?.kind ?? 'unknown'} operation`);
        }
      }
      // Execution updates are immutable after a terminal snapshot. Completion
      // acknowledgements and explicit redelivery use dedicated methods below;
      // accepting a late progress/artifact callback here would resurrect a
      // cancelled operation and schedule a second terminal delivery revision.
      if (TERMINAL.has(task.status)) {
        throw new Error(`Host task ${task.taskId} is already terminal`);
      }
      if (external && task.lifecycle.operations.length > 0) {
        throw new Error(`Host task ${task.taskId} requires an active executor operation token`);
      }
      const artifactIdsBefore = new Set(task.artifacts.map((artifact) => artifact.id));
      const verificationIdsBefore = new Set(task.verifications.map((verification) => verification.id));
      const knownArtifactIds = new Set(artifactIdsBefore);
      const knownVerificationIds = new Set(verificationIdsBefore);
      const progress = normalizeProgress(update.progress);
      if (progress) task.progress = progress;
      if (Object.hasOwn(update, 'checkpoint')) {
        task.checkpoint = normalizeTaskData(update.checkpoint, 'Host task checkpoint', true);
      }
      if (Array.isArray(update.artifacts)) {
        for (const artifact of update.artifacts) {
          if (!artifact?.id || knownArtifactIds.has(artifact.id)) continue;
          task.artifacts.push(clone(artifact));
          knownArtifactIds.add(artifact.id);
        }
      }
      if (Array.isArray(update.verifications)) {
        for (const verification of update.verifications) {
          if (!verification?.id || knownVerificationIds.has(verification.id)) continue;
          task.verifications.push(clone(verification));
          knownVerificationIds.add(verification.id);
        }
      }
      const requestedError = shortText(update.error);
      const acceptanceError = update.status === 'succeeded'
        ? await this.validateCompletion(task)
        : undefined;
      if (update.status) {
        task.status = acceptanceError ? 'blocked' : update.status;
        if ((update.status === 'running' || update.status === 'succeeded') && !requestedError && !acceptanceError) {
          task.error = undefined;
        }
      }
      if (requestedError) task.error = requestedError;
      if (acceptanceError) task.error = acceptanceError;
      task.updatedAt = Date.now();
      task.revision += 1;
      await this.persist(task, 'task.updated');
      this.publishTaskUpdate(task, update, artifactIdsBefore, verificationIdsBefore);
      this.notify(task);
      return clone(task);
    });
  }

  private async validateCompletion(task: HostTaskSnapshot): Promise<string | undefined> {
    const acceptance = task.acceptance;
    if (acceptance.requiresArtifact && task.artifacts.length === 0) {
      return `Host capability ${task.capability} requires an output artifact, but none was produced.`;
    }

    if (acceptance.requiresArtifact) {
      for (const artifact of task.artifacts) {
        if (!artifact.filePath) {
          return `Host capability ${task.capability} requires a local artifact path for ${artifact.id}.`;
        }
        try {
          const stat = await fs.stat(artifact.filePath);
          if (!stat.isFile() || stat.size <= 0) {
            return `Host artifact ${artifact.id} is missing or empty.`;
          }
          if (!artifact.sizeBytes) artifact.sizeBytes = stat.size;
        } catch {
          return `Host artifact ${artifact.id} is not available at ${artifact.filePath}.`;
        }
      }
    }

    const artifactIds = new Set(task.artifacts.map((artifact) => artifact.id));
    const verificationMatchesProducedArtifact = (verification: ChatRuntimeVerification): boolean => (
      !acceptance.requiresArtifact
      || Boolean(verification.artifactId && artifactIds.has(verification.artifactId))
    );
    if (acceptance.requiresVerification && acceptance.requiredVerificationKinds.length === 0) {
      const anyPassed = task.verifications.some((verification) => (
        verification.status === 'passed'
        && verificationMatchesProducedArtifact(verification)
      ));
      if (!anyPassed) return `Host capability ${task.capability} requires passed verification evidence.`;
    }
    for (const kind of acceptance.requiredVerificationKinds) {
      const passed = task.verifications.some((verification) => (
        verification.kind === kind
        && verification.status === 'passed'
        && verification.required !== false
        && verificationMatchesProducedArtifact(verification)
      ));
      if (!passed) return `Host capability ${task.capability} requires a passed ${kind} verification.`;
    }
    return undefined;
  }

  async acknowledgeCompletion(taskId: string, deliveryKey: string): Promise<HostTaskSnapshot | undefined> {
    const normalizedKey = shortText(deliveryKey, 512);
    if (!normalizedKey) throw new Error('deliveryKey is required');
    await this.ensureInitialized();
    return this.withTaskLock(taskId, async (task) => {
      if (!task.completionAcks.includes(normalizedKey)) {
        task.completionAcks.push(normalizedKey);
        task.updatedAt = Date.now();
        await this.persist(task, 'task.completion_ack');
      }
      return clone(task);
    });
  }

  async recover(
    taskId: string,
    strategy: 'status_only' | 'resume_if_safe' | 'redeliver_existing_artifacts',
    executor?: HostTaskLifecycleExecutor,
  ): Promise<DispatchResult> {
    await this.ensureInitialized();
    if (strategy === 'resume_if_safe') {
      if (!executor?.resume) throw new Error('Host capability does not support safe resume');
      const claim = await this.claimOperation(taskId, 'resume');
      if (!claim.task || !claim.operation) return { task: claim.task, dispatched: false };
      void this.executeOperation(taskId, claim.operation.operationId, 'resume', executor);
      return { task: claim.task, dispatched: true };
    }
    const task = await this.withTaskLock(taskId, async (current) => {
      if (strategy === 'redeliver_existing_artifacts') {
        if (current.artifacts.length === 0) throw new Error('Host task has no existing artifacts to redeliver');
        current.completionAcks = [];
        current.updatedAt = Date.now();
        current.revision += 1;
        await this.persist(current, 'task.redelivery_requested');
        this.notify(current);
      }
      return clone(current);
    });
    return { task, dispatched: false };
  }

  async get(taskId: string): Promise<HostTaskSnapshot | undefined> {
    await this.ensureInitialized();
    const task = this.tasks.get(taskId);
    return task ? clone(task) : undefined;
  }

  async list(sessionKey?: string): Promise<HostTaskSnapshot[]> {
    await this.ensureInitialized();
    return [...this.tasks.values()]
      .filter((task) => !sessionKey || task.sessionKey === sessionKey)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(clone);
  }

  async waitForTerminal(taskId: string, timeoutMs: number): Promise<HostTaskSnapshot | undefined> {
    const current = await this.get(taskId);
    if (!current || TERMINAL.has(current.status) || timeoutMs <= 0) return current;
    return await new Promise((resolve) => {
      const listeners = this.waiters.get(taskId) ?? new Set<(snapshot: HostTaskSnapshot) => void>();
      this.waiters.set(taskId, listeners);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const listener = (snapshot: HostTaskSnapshot) => {
        if (TERMINAL.has(snapshot.status)) finish(snapshot);
      };
      const finish = (snapshot: HostTaskSnapshot | undefined) => {
        if (timeout) clearTimeout(timeout);
        listeners.delete(listener);
        if (listeners.size === 0) this.waiters.delete(taskId);
        resolve(snapshot ? clone(snapshot) : undefined);
      };
      listeners.add(listener);
      timeout = setTimeout(() => finish(this.tasks.get(taskId)), Math.min(timeoutMs, 90_000));
    });
  }

  private validateCreate(input: HostTaskCreateRequest): void {
    for (const field of ['sessionKey', 'runId', 'toolCallId', 'idempotencyKey', 'capability', 'title'] as const) {
      const value = input[field];
      if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required for Host task`);
      if (value.length > 2_048) throw new Error(`${field} is too long for Host task`);
    }
  }

  private assertIdempotentReplay(
    existing: HostTaskSnapshot,
    input: HostTaskCreateRequest,
    normalizedInput: HostTaskData,
    acceptance: HostTaskAcceptance,
    completion: HostTaskCompletion,
  ): void {
    const matches = existing.runId === input.runId.trim()
      && existing.toolCallId === input.toolCallId.trim()
      && existing.capability === input.capability.trim()
      && existing.title === input.title.trim()
      && JSON.stringify(existing.input) === JSON.stringify(normalizedInput)
      && JSON.stringify(existing.acceptance) === JSON.stringify(acceptance)
      && JSON.stringify(existing.completion) === JSON.stringify(completion);
    if (!matches) throw new Error('Host task idempotency key was reused with a different request');
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) this.initialized = this.load();
    await this.initialized;
  }

  private async load(): Promise<void> {
    const jobsRoot = path.join(this.getRootDir(), 'jobs');
    await fs.mkdir(jobsRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const entries = await fs.readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(jobsRoot, entry.name, 'task.json'), 'utf8')) as Partial<HostTaskSnapshot> & { version?: number };
        if (raw.version !== 3 || !raw?.taskId || !raw.sessionKey || !raw.runId || !raw.idempotencyKey || !raw.capability || !raw.title) return;
        const task: HostTaskSnapshot = {
          ...(raw as HostTaskSnapshot),
          version: 3,
          input: normalizeTaskData(raw.input, 'Persisted Host task input') ?? {},
          acceptance: normalizeAcceptance(raw.acceptance as HostTaskAcceptance),
          completion: normalizeCompletion(raw.completion),
          checkpoint: normalizeTaskData(raw.checkpoint, 'Persisted Host task checkpoint', true),
          artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
          verifications: Array.isArray(raw.verifications) ? raw.verifications : [],
          completionAcks: Array.isArray(raw.completionAcks) ? raw.completionAcks : [],
          lifecycle: normalizeLifecycle(raw.lifecycle),
        };
        const now = Date.now();
        let interruptedOwnerOperation = false;
        for (const operation of task.lifecycle.operations) {
          if (operation.status !== 'running' || operation.ownerId === this.ownerId) continue;
          operation.status = 'interrupted';
          operation.finishedAt = now;
          operation.error = 'Host process stopped before this operation completed.';
          interruptedOwnerOperation = true;
        }
        if (interruptedOwnerOperation && ['queued', 'running', 'waiting'].includes(task.status)) {
          task.status = 'lost';
          task.error = 'Host process stopped before the claimed operation completed.';
          task.updatedAt = now;
          task.revision += 1;
        }
        this.tasks.set(task.taskId, task);
        this.idempotency.set(`${task.sessionKey}:${task.idempotencyKey}`, task.taskId);
        if (interruptedOwnerOperation) await this.persist(task, 'task.owner_interrupted');
      } catch {
        // A corrupt orphan must not stop the app or invalidate other durable work.
      }
    }));
  }

  private async claimOperation(
    taskId: string,
    kind: HostTaskOperationKind,
    detail?: string,
  ): Promise<{ task?: HostTaskSnapshot; operation?: HostTaskOperation }> {
    await this.ensureInitialized();
    return await this.withTaskLock(taskId, async (task) => {
      if (kind === 'start' && TERMINAL.has(task.status)) return { task: clone(task) };
      if (kind === 'cancel' && TERMINAL.has(task.status)) return { task: clone(task) };
      if (kind === 'resume' && !['failed', 'blocked', 'timed_out', 'lost'].includes(task.status)) {
        return { task: clone(task) };
      }

      const now = Date.now();
      for (const operation of task.lifecycle.operations) {
        if (operation.status !== 'running') continue;
        if (operation.ownerId !== this.ownerId) {
          operation.status = 'interrupted';
          operation.finishedAt = now;
          operation.error = 'Host process stopped before this operation completed.';
          continue;
        }
        if (operation.kind === kind || kind !== 'cancel') return { task: clone(task) };
      }
      if (kind === 'start' && task.lifecycle.operations.some((operation) => (
        operation.kind === 'start'
        && operation.status !== 'failed'
        && operation.status !== 'interrupted'
      ))) {
        return { task: clone(task) };
      }
      const attempt = task.lifecycle.operations.filter((operation) => operation.kind === kind).length + 1;
      const operation: HostTaskOperation = {
        operationId: randomUUID(),
        kind,
        status: 'running',
        ownerId: this.ownerId,
        attempt,
        startedAt: now,
      };
      task.lifecycle.operations.push(operation);
      task.lifecycle.operations = task.lifecycle.operations.slice(-MAX_LIFECYCLE_OPERATIONS);
      if (kind === 'resume') {
        task.status = 'queued';
        task.error = undefined;
        task.completionAcks = [];
        task.progress = { ...task.progress, detail: detail ?? 'Safe resume was delegated to the registered Host executor.' };
      } else if (kind === 'cancel') {
        task.progress = { ...task.progress, detail: detail ?? 'Cancellation was delegated to the registered Host executor.' };
      }
      task.updatedAt = now;
      task.revision += 1;
      await this.persist(task, `task.${kind}.claimed`);
      this.publishTaskUpdate(task, { progress: task.progress }, new Set(task.artifacts.map((artifact) => artifact.id)), new Set(task.verifications.map((verification) => verification.id)));
      this.notify(task);
      return { task: clone(task), operation: clone(operation) };
    }) ?? {};
  }

  private async executeOperation(
    taskId: string,
    operationId: string,
    kind: HostTaskOperationKind,
    executor: HostTaskLifecycleExecutor,
    reason?: string,
  ): Promise<void> {
    try {
      const task = await this.get(taskId);
      if (!task) return;
      const context: HostTaskExecutorContext = {
        task,
        input: clone(task.input),
        checkpoint: task.checkpoint === undefined ? undefined : clone(task.checkpoint),
        update: async (update) => await this.applyUpdate(taskId, update, operationId),
      };
      if (kind === 'start') await executor.start(context);
      else if (kind === 'resume') await executor.resume?.(context);
      else await executor.cancel?.({ ...context, reason: reason ?? 'Cancelled by user' });

      if (kind === 'cancel') {
        const current = await this.get(taskId);
        if (current && !TERMINAL.has(current.status)) {
          await this.applyUpdate(
            taskId,
            { status: 'cancelled', error: reason ?? 'Cancelled by user' },
            operationId,
          );
        }
      }
      await this.finishOperation(taskId, operationId, 'completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = await this.get(taskId).catch(() => undefined);
      if (current && !TERMINAL.has(current.status)) {
        const status = kind === 'start' ? 'failed' : kind === 'resume' ? 'blocked' : undefined;
        await this.applyUpdate(taskId, {
          ...(status ? { status } : {}),
          error: message,
          progress: { ...current.progress, detail: `${kind} failed: ${message}` },
        }, operationId).catch(() => undefined);
      }
      await this.finishOperation(taskId, operationId, 'failed', message).catch(() => undefined);
    }
  }

  private async finishOperation(taskId: string, operationId: string, status: 'completed' | 'failed', error?: string): Promise<void> {
    await this.withTaskLock(taskId, async (task) => {
      const operation = task.lifecycle.operations.find((candidate) => candidate.operationId === operationId);
      if (!operation || operation.status !== 'running') return;
      operation.status = status;
      operation.finishedAt = Date.now();
      operation.error = shortText(error);
      task.updatedAt = operation.finishedAt;
      // Terminal delivery is keyed by revision. Completing the executor claim
      // after the terminal state must not create a second delivery revision.
      if (!TERMINAL.has(task.status)) task.revision += 1;
      await this.persist(task, `task.${operation.kind}.${status}`);
      this.notify(task);
    });
  }

  private async withTaskLock<T>(taskId: string, operation: (task: HostTaskSnapshot) => Promise<T>): Promise<T | undefined> {
    const previous = this.locks.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(taskId, current);
    await previous.catch(() => undefined);
    try {
      const task = this.tasks.get(taskId);
      return task ? await operation(task) : undefined;
    } finally {
      release();
      if (this.locks.get(taskId) === current) this.locks.delete(taskId);
    }
  }

  private async persist(task: HostTaskSnapshot, type: string): Promise<void> {
    const directory = path.join(this.getRootDir(), 'jobs', task.taskId);
    await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const target = path.join(directory, 'task.json');
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
    await fs.rename(temporary, target);
    const operation = task.lifecycle.operations.at(-1);
    await fs.appendFile(path.join(directory, 'journal.jsonl'), `${JSON.stringify({
      version: 3,
      ts: Date.now(),
      type,
      revision: task.revision,
      status: task.status,
      ...(operation ? { operation: { kind: operation.kind, status: operation.status, attempt: operation.attempt } } : {}),
    })}\n`, { mode: PRIVATE_FILE_MODE });
  }

  private publishTaskUpdate(
    task: HostTaskSnapshot,
    update: HostTaskUpdateRequest,
    artifactIdsBefore: Set<string>,
    verificationIdsBefore: Set<string>,
  ): void {
    const events: Array<Omit<ChatRuntimeEvent, 'contractVersion' | 'producer' | 'runId' | 'sessionKey' | 'seq' | 'ts'>> = [
      {
        type: 'run.step.updated',
        step: {
          id: `host-task:${task.taskId}`,
          title: task.title,
          kind: `host.${task.capability}`,
          status: runtimeStatus(task.status),
          detail: task.progress?.detail ?? task.error,
        },
      },
      {
        type: 'progress.update',
        entry: {
          id: `host-task:${task.taskId}:state`,
          kind: 'status',
          text: task.progress?.detail || task.title,
          status: runtimeProgressStatus(task.status),
          detail: task.error,
          toolCallId: task.toolCallId,
          source: 'native',
        },
      },
    ];
    for (const artifact of task.artifacts) {
      if (!artifactIdsBefore.has(artifact.id)) events.push({ type: 'artifact.produced', artifact, toolCallId: task.toolCallId });
    }
    for (const verification of task.verifications) {
      if (!verificationIdsBefore.has(verification.id)) events.push({ type: 'verification.completed', verification, toolCallId: task.toolCallId });
    }
    if (update.status && TERMINAL.has(task.status)) {
      events.push({
        type: 'tool.completed',
        toolCallId: task.toolCallId,
        name: `host.${task.capability}`,
        result: { taskId: task.taskId, status: task.status, artifactCount: task.artifacts.length },
        isError: task.status !== 'succeeded',
      });
    }
    this.publish(task, events);
  }

  private publish(
    task: HostTaskSnapshot,
    events: Array<Omit<ChatRuntimeEvent, 'contractVersion' | 'producer' | 'runId' | 'sessionKey' | 'seq' | 'ts'>>,
  ): void {
    for (const event of events) {
      this.publisher?.({
        ...event,
        contractVersion: 1,
        producer: 'uclaw-host-task',
        runId: task.runId,
        sessionKey: task.sessionKey,
        ts: Date.now(),
      } as ChatRuntimeEvent);
    }
  }

  private notify(task: HostTaskSnapshot): void {
    for (const listener of this.waiters.get(task.taskId) ?? []) listener(clone(task));
  }
}

export const hostTaskService = new HostTaskService();
