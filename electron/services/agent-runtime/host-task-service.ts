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

export type HostTaskSnapshot = {
  version: 1;
  taskId: string;
  sessionKey: string;
  runId: string;
  toolCallId: string;
  idempotencyKey: string;
  capability: string;
  title: string;
  status: HostTaskStatus;
  createdAt: number;
  updatedAt: number;
  revision: number;
  progress?: { completed?: number; total?: number; detail?: string };
  error?: string;
  artifacts: ChatRuntimeArtifact[];
  verifications: ChatRuntimeVerification[];
  completionAcks: string[];
};

export type HostTaskCreateRequest = {
  sessionKey: string;
  runId: string;
  toolCallId: string;
  idempotencyKey: string;
  capability: string;
  title: string;
  status?: Extract<HostTaskStatus, 'queued' | 'running' | 'waiting'>;
};

export type HostTaskUpdateRequest = {
  status?: HostTaskStatus;
  progress?: { completed?: number; total?: number; detail?: string };
  error?: string;
  artifacts?: ChatRuntimeArtifact[];
  verifications?: ChatRuntimeVerification[];
};

type RuntimePublisher = (event: ChatRuntimeEvent) => void;

const TERMINAL = new Set<HostTaskStatus>(['succeeded', 'failed', 'blocked', 'cancelled', 'timed_out', 'lost']);
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function shortText(value: unknown, maximum = 1_000): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
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
  private initialized?: Promise<void>;
  private publisher?: RuntimePublisher;

  setPublisher(publisher: RuntimePublisher): void {
    this.publisher = publisher;
  }

  async create(input: HostTaskCreateRequest): Promise<{ task: HostTaskSnapshot; idempotent: boolean }> {
    await this.ensureInitialized();
    this.validateCreate(input);
    const key = `${input.sessionKey}:${input.idempotencyKey}`;
    const existingId = this.idempotency.get(key);
    const existing = existingId ? this.tasks.get(existingId) : undefined;
    if (existing) return { task: clone(existing), idempotent: true };

    const now = Date.now();
    const task: HostTaskSnapshot = {
      version: 1,
      taskId: randomUUID(),
      sessionKey: input.sessionKey.trim(),
      runId: input.runId.trim(),
      toolCallId: input.toolCallId.trim(),
      idempotencyKey: input.idempotencyKey.trim(),
      capability: input.capability.trim(),
      title: input.title.trim(),
      status: input.status ?? 'queued',
      createdAt: now,
      updatedAt: now,
      revision: 1,
      artifacts: [],
      verifications: [],
      completionAcks: [],
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

  async update(taskId: string, update: HostTaskUpdateRequest): Promise<HostTaskSnapshot | undefined> {
    await this.ensureInitialized();
    return this.withTaskLock(taskId, async (task) => {
      if (TERMINAL.has(task.status) && update.status && update.status !== task.status) {
        throw new Error(`Host task ${task.taskId} is already terminal`);
      }
      const artifactIdsBefore = new Set(task.artifacts.map((artifact) => artifact.id));
      const verificationIdsBefore = new Set(task.verifications.map((verification) => verification.id));
      const knownArtifactIds = new Set(artifactIdsBefore);
      const knownVerificationIds = new Set(verificationIdsBefore);
      if (update.status) task.status = update.status;
      const progress = normalizeProgress(update.progress);
      if (progress) task.progress = progress;
      const error = shortText(update.error);
      if (error) task.error = error;
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
      task.updatedAt = Date.now();
      task.revision += 1;
      await this.persist(task, 'task.updated');
      this.publishTaskUpdate(task, update, artifactIdsBefore, verificationIdsBefore);
      this.notify(task);
      return clone(task);
    });
  }

  async cancel(taskId: string, reason = 'Cancelled by user'): Promise<HostTaskSnapshot | undefined> {
    return this.update(taskId, { status: 'cancelled', error: reason });
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

  async recover(taskId: string, strategy: 'status_only' | 'resume_if_safe' | 'redeliver_existing_artifacts'): Promise<HostTaskSnapshot | undefined> {
    await this.ensureInitialized();
    return this.withTaskLock(taskId, async (task) => {
      if (strategy === 'redeliver_existing_artifacts' && task.artifacts.length > 0) {
        task.completionAcks = [];
        task.updatedAt = Date.now();
        task.revision += 1;
        await this.persist(task, 'task.redelivery_requested');
      }
      // Generic registration intentionally never retries a side effect by
      // itself. A concrete Host capability owns any safe resumption policy.
      return clone(task);
    });
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
    for (const [field, value] of Object.entries(input)) {
      if (field === 'status') continue;
      if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required for Host task`);
      if (value.length > 2_048) throw new Error(`${field} is too long for Host task`);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) this.initialized = this.load();
    await this.initialized;
  }

  private async load(): Promise<void> {
    const jobsRoot = path.join(taskRoot(), 'jobs');
    await fs.mkdir(jobsRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const entries = await fs.readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        const raw = await fs.readFile(path.join(jobsRoot, entry.name, 'task.json'), 'utf8');
        const task = JSON.parse(raw) as HostTaskSnapshot;
        if (!task?.taskId || !task.sessionKey || !task.runId || !task.idempotencyKey) return;
        task.completionAcks = Array.isArray(task.completionAcks) ? task.completionAcks : [];
        this.tasks.set(task.taskId, task);
        this.idempotency.set(`${task.sessionKey}:${task.idempotencyKey}`, task.taskId);
      } catch {
        // A corrupt orphan must not stop the app or invalidate other durable work.
      }
    }));
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
    const directory = path.join(taskRoot(), 'jobs', task.taskId);
    await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const target = path.join(directory, 'task.json');
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
    await fs.rename(temporary, target);
    await fs.appendFile(path.join(directory, 'journal.jsonl'), `${JSON.stringify({ version: 1, ts: Date.now(), type, revision: task.revision, status: task.status })}\n`, { mode: PRIVATE_FILE_MODE });
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
    if (TERMINAL.has(task.status)) {
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
