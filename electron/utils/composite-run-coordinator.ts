import { createHash, randomUUID } from 'node:crypto';
import { promises as fsP } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type {
  ChatRuntimeArtifact,
  ChatRuntimeEvent,
  ChatRuntimeGateEvaluation,
  ChatRuntimeGateIssue,
  ChatRuntimeVerification,
} from '../../shared/chat-runtime-events';
import {
  COMPOSITE_RUN_SCHEMA_VERSION,
  isLocalArtifactTaskKind,
  isSupportedCompositeRunTaskSet,
  isCompositeRunTerminal,
  type CompositeRunApiResponse,
  type CompositeRunCancelResult,
  type CompositeRunJournalEvent,
  type CompositeRunManifest,
  type CompositeRunRecord,
  type CompositeRunRetryRequest,
  type CompositeRunRetryResult,
  type CompositeRunStartRequest,
  type CompositeRunTaskInput,
  type CompositeRunTaskRecord,
} from '../../shared/composite-run';
import { appendCompositeArtifactConversation } from './chat-session-image-message';
import {
  cancelMediaGenerationJob,
  cancelMediaGenerationJobsForRun,
  enqueueMediaGenerationJob,
  getMediaGenerationJob,
} from './media-generation-jobs';
import type {
  MediaGenerationJobOutput,
  MediaGenerationJobSnapshot,
} from './media-generation-types';
import {
  createLocalArtifact,
  type LocalArtifactCreateRequest,
  type LocalArtifactCreateResult,
} from './local-artifact-runtime';
import {
  verifyLocalArtifactOpenability,
  type LocalArtifactOpenabilityResult,
} from './local-artifact-openability';
import {
  planLocalArtifactBatch,
  type LocalArtifactPlanItem,
} from './local-artifact-planner';
import { logger } from './logger';
import { getOpenClawConfigDir } from './paths';

const MAX_COMPOSITE_TASKS = 35;
const MAX_SAFE_AUTOMATIC_RETRIES = 1;
const MEDIA_JOB_POLL_MS = 500;
const DELIVERY_APPEND_RETRY_DELAYS_MS = [500, 1_500, 4_000] as const;
const RUN_DIR_NAME = 'uclaw-runtime/composite-runs';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const TERMINAL_JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const COMPOSITE_TASK_KINDS = new Set([
  'image_generate',
  'presentation',
  'spreadsheet',
  'video_generate',
  'image_edit',
  'mini_program',
  'copywriting',
]);

type RuntimePublisher = (event: ChatRuntimeEvent) => void;

type RuntimeEventInput = ChatRuntimeEvent extends infer Event
  ? Event extends ChatRuntimeEvent
    ? Omit<Event, 'runId' | 'sessionKey' | 'producer' | 'contractVersion' | 'seq' | 'ts'>
    : never
  : never;

type PersistedConversationFile = {
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  filePath?: string;
  gatewayUrl?: string;
  source?: 'tool-result';
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function safeId(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (cleaned === value && cleaned.length <= 96) return cleaned;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${cleaned.slice(0, 72) || 'id'}-${digest}`;
}

function deliveryIdentity(runId: string, generation: number): {
  generation: number;
  assistantMessageId: string;
  appendRunId: string;
} {
  const normalizedGeneration = Math.max(1, Math.floor(generation));
  const appendRunId = normalizedGeneration === 1
    ? runId
    : `${runId}:delivery:${normalizedGeneration}`;
  return {
    generation: normalizedGeneration,
    assistantMessageId: `composite-result:${appendRunId}`,
    appendRunId,
  };
}

function taskStepId(taskId: string): string {
  return `uclaw.composite.${safeId(taskId)}`;
}

function artifactId(runId: string, taskId: string, index: number): string {
  return `artifact:${safeId(runId)}:${safeId(taskId)}:${index + 1}`;
}

function verificationId(artifact: ChatRuntimeArtifact, kind: string): string {
  return `verification:${artifact.id}:${safeId(kind)}`;
}

function artifactRef(artifact: ChatRuntimeArtifact): string {
  return artifact.filePath || artifact.url || artifact.title || artifact.id;
}

function outputMimeType(output: MediaGenerationJobOutput, kind: 'image' | 'video'): string {
  return output.mimeType?.trim() || (kind === 'image' ? 'image/png' : 'video/mp4');
}

function outputTitle(output: MediaGenerationJobOutput, index: number, kind: 'image' | 'video'): string {
  const location = output.path?.trim() || output.url?.trim() || '';
  return output.fileName?.trim() || location.split(/[\\/]/u).pop()?.split(/[?#]/u)[0] || `${kind}-${index + 1}`;
}

function localTaskRequest(task: CompositeRunTaskInput, originalPrompt: string, cwd?: string): LocalArtifactCreateRequest {
  const common = {
    title: task.title,
    sourcePrompt: task.prompt,
    originalPrompt,
    ...(cwd ? { outputDir: path.join(cwd, 'outputs') } : {}),
  };
  if (task.kind === 'presentation') return { kind: 'presentation', ...common };
  if (task.kind === 'spreadsheet') return { kind: 'spreadsheet', ...common };
  if (task.kind === 'mini_program') return { kind: 'mini_program', ...common };
  return { kind: 'copywriting', ...common };
}

function isLocalTask(task: CompositeRunTaskRecord): boolean {
  return isLocalArtifactTaskKind(task.kind);
}

function isMediaTask(task: CompositeRunTaskRecord): boolean {
  return task.kind === 'image_generate' || task.kind === 'image_edit' || task.kind === 'video_generate';
}

function failedLocalRepairableVerification(
  run: CompositeRunRecord,
  task: CompositeRunTaskRecord,
): ChatRuntimeVerification | undefined {
  const artifactIds = new Set(task.artifactIds);
  return [...run.verifications].reverse().find((verification) => (
    Boolean(verification.artifactId && artifactIds.has(verification.artifactId))
    && (verification.source === 'local-artifact-runtime' || verification.source === 'local-artifact-openability')
    && verification.kind !== 'artifact.availability'
    && verification.required !== false
    && verification.status !== 'passed'
  ));
}

function terminalTask(task: CompositeRunTaskRecord): boolean {
  return task.status === 'completed'
    || task.status === 'failed'
    || task.status === 'blocked'
    || task.status === 'cancelled';
}

function normalizeTask(task: CompositeRunTaskInput, index: number): CompositeRunTaskRecord {
  return {
    id: task.id.trim() || `task-${index + 1}`,
    kind: task.kind,
    title: task.title.trim() || `子任务 ${index + 1}`,
    prompt: task.prompt.trim(),
    requiresArtifact: task.requiresArtifact !== false,
    dependsOn: [...new Set((task.dependsOn ?? []).map((item) => item.trim()).filter(Boolean))],
    fallback: task.fallback?.trim() || undefined,
    selectedImageSource: task.selectedImageSource,
    selectedImageIndex: task.selectedImageIndex,
    sourceImages: task.sourceImages?.filter((image) => image.filePath?.trim()).map((image) => ({ ...image, filePath: image.filePath.trim() })),
    status: 'pending',
    attempt: 0,
    automaticRetryCount: 0,
    artifactIds: [],
  };
}

function validateStartRequest(request: CompositeRunStartRequest): void {
  if (!request.clientRequestId?.trim()) throw new Error('clientRequestId is required');
  if (!request.sessionKey?.trim()) throw new Error('sessionKey is required');
  if (!request.prompt?.trim()) throw new Error('prompt is required');
  if (!Array.isArray(request.tasks) || !isSupportedCompositeRunTaskSet(request.tasks)) {
    throw new Error('A run requires either one local artifact task or at least two composite tasks');
  }
  if (request.tasks.length > MAX_COMPOSITE_TASKS) throw new Error(`Composite task count exceeds ${MAX_COMPOSITE_TASKS}`);
  const ids = new Set<string>();
  for (const task of request.tasks) {
    if (!task.id?.trim() || ids.has(task.id.trim())) throw new Error(`Invalid or duplicate composite task id: ${task.id ?? ''}`);
    if (!COMPOSITE_TASK_KINDS.has(task.kind)) throw new Error(`Unsupported composite task kind: ${String(task.kind)}`);
    if (!task.prompt?.trim()) throw new Error(`Composite task ${task.id} is missing prompt`);
    ids.add(task.id.trim());
  }
  for (const task of request.tasks) {
    for (const dependencyId of task.dependsOn ?? []) {
      if (!ids.has(dependencyId)) throw new Error(`Composite task ${task.id} depends on missing task ${dependencyId}`);
      if (dependencyId === task.id) throw new Error(`Composite task ${task.id} cannot depend on itself`);
    }
  }
  const taskById = new Map(request.tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) throw new Error(`Composite task dependency cycle detected at ${taskId}`);
    visiting.add(taskId);
    for (const dependencyId of taskById.get(taskId)?.dependsOn ?? []) visit(dependencyId);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  request.tasks.forEach((task) => visit(task.id));
}

function buildIssue(run: CompositeRunRecord, task: CompositeRunTaskRecord, index: number): ChatRuntimeGateIssue {
  const blocked = task.status === 'blocked';
  return {
    id: `gate:${run.runId}:${task.id}:${index}`,
    code: blocked ? 'task.blocked' : 'task.failed',
    severity: 'blocking',
    title: `${task.title}${blocked ? ' 被阻塞' : ' 执行失败'}`,
    detail: task.error,
    targetId: task.id,
    stepId: taskStepId(task.id),
    recoverable: task.recoverable !== false,
    suggestedRecovery: task.recoverable === false ? '需要用户补充输入后重新发起。' : '可重试该子任务。',
  };
}

function evaluateGate(run: CompositeRunRecord): ChatRuntimeGateEvaluation {
  const issues: ChatRuntimeGateIssue[] = [];
  run.tasks.forEach((task, index) => {
    if (task.status === 'failed' || task.status === 'blocked') issues.push(buildIssue(run, task, index));
    if (task.status === 'completed' && task.requiresArtifact !== false && task.artifactIds.length === 0) {
      issues.push({
        id: `gate:${run.runId}:artifact-missing:${task.id}`,
        code: 'artifact.required.missing',
        severity: 'blocking',
        title: `${task.title} 缺少必需产物`,
        targetId: task.id,
        stepId: taskStepId(task.id),
        recoverable: true,
      });
    }
  });
  for (const artifact of run.artifacts) {
    const passed = run.verifications.some((verification) => (
      verification.artifactId === artifact.id
      && verification.required !== false
      && verification.status === 'passed'
    ));
    if (!passed) {
      issues.push({
        id: `gate:${run.runId}:verification-missing:${artifact.id}`,
        code: 'artifact.verification.missing',
        severity: 'blocking',
        title: `${artifact.title || artifact.id} 缺少必需验证`,
        artifactId: artifact.id,
        targetId: artifact.id,
        recoverable: true,
      });
    }
  }
  const pending = run.tasks.some((task) => !terminalTask(task));
  const blocking = issues.filter((issue) => issue.severity === 'blocking');
  const nonRecoverable = blocking.some((issue) => issue.recoverable === false);
  const decision = pending || (blocking.length > 0 && !nonRecoverable)
    ? 'continue_required'
    : blocking.length > 0
      ? 'blocked_needs_user'
      : 'deliverable';
  const requiredVerifications = run.verifications.filter((verification) => verification.required !== false);
  const passedVerifications = requiredVerifications.filter((verification) => verification.status === 'passed');
  return {
    id: `gate:${run.runId}:completion`,
    decision,
    summary: decision === 'deliverable'
      ? '完成门禁已通过。'
      : `${blocking.length} 个阻断项尚未解决。`,
    artifactCount: run.artifacts.length,
    requiredVerificationCount: requiredVerifications.length,
    passedRequiredVerificationCount: passedVerifications.length,
    blockingIssueCount: blocking.length,
    warningIssueCount: issues.filter((issue) => issue.severity === 'warning').length,
    verificationCoverage: run.artifacts.length === 0 ? (blocking.length > 0 ? 0 : 1) : passedVerifications.length / run.artifacts.length,
    issues,
  };
}

function toManifestStatus(task: CompositeRunTaskRecord): 'completed' | 'failed' | 'blocked' {
  if (task.status === 'completed') return 'completed';
  if (task.status === 'failed') return 'failed';
  return 'blocked';
}

function buildManifest(run: CompositeRunRecord, trailingEvents: ChatRuntimeEvent[] = []): CompositeRunManifest {
  const hasPartialFailure = run.tasks.some((task) => task.status !== 'completed');
  return {
    version: 2,
    runId: run.runId,
    requestedTaskCount: run.tasks.length,
    runStatus: run.status === 'cancelled'
      ? 'aborted'
      : hasPartialFailure || run.status === 'partial' || run.status === 'failed' || run.status === 'blocked'
        ? 'error'
        : run.status === 'completed' || run.status === 'finalizing'
          ? 'completed'
          : run.status === 'running' || run.status === 'planned'
            ? 'running'
            : 'error',
    runtimeEvents: [...run.runtimeEvents, ...trailingEvents].map((event) => clone(event)),
    tasks: run.tasks.map((task) => ({
      id: task.id,
      kind: task.kind,
      title: task.title,
      status: toManifestStatus(task),
      ...(task.error ? { detail: task.error } : {}),
      artifactRefs: task.artifactIds
        .map((id) => run.artifacts.find((artifact) => artifact.id === id))
        .filter((artifact): artifact is ChatRuntimeArtifact => Boolean(artifact))
        .map(artifactRef),
    })),
  };
}

function deliveryText(run: CompositeRunRecord): string {
  const completed = run.tasks.filter((task) => task.status === 'completed');
  const incomplete = run.tasks.filter((task) => task.status !== 'completed');
  const lines = [`已完成 ${completed.length}/${run.tasks.length} 项，产物已整理如下。`];
  if (incomplete.length > 0) {
    lines.push('', '需要补充处理：', ...incomplete.map((task) => `- ${task.title}：${task.error || '未完成'}`));
  }
  if (completed.length > 0) {
    lines.push('', '基础验证已完成：本地文件已检查内容和可用性，媒体产物已检查文件或元数据证据。');
  }
  return lines.join('\n');
}

export class CompositeRunCoordinator {
  private readonly runs = new Map<string, CompositeRunRecord>();
  private readonly runIdByClientRequest = new Map<string, string>();
  private readonly runLocks = new Map<string, Promise<void>>();
  private readonly activeDrivers = new Set<string>();
  private readonly pendingDriverKicks = new Set<string>();
  private readonly activeTasks = new Set<string>();
  private readonly localPlanning = new Map<string, Promise<void>>();
  private initializePromise: Promise<void> | null = null;
  private createLock: Promise<void> = Promise.resolve();
  private publisher: RuntimePublisher | null = null;

  setPublisher(publisher: RuntimePublisher): void {
    this.publisher = publisher;
  }

  async initialize(): Promise<void> {
    if (!this.initializePromise) this.initializePromise = this.loadAndRecover();
    await this.initializePromise;
  }

  async start(request: CompositeRunStartRequest): Promise<CompositeRunApiResponse> {
    validateStartRequest(request);
    const cwd = request.cwd?.trim();
    if (cwd && !path.isAbsolute(cwd)) throw new Error('Composite run cwd must be an absolute path');
    if (cwd) {
      const stat = await fsP.stat(cwd).catch(() => null);
      if (!stat?.isDirectory()) throw new Error('Composite run cwd is not an accessible directory');
    }
    await this.initialize();
    let release!: () => void;
    const previous = this.createLock;
    this.createLock = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      const clientRequestId = request.clientRequestId.trim();
      const existingRunId = this.runIdByClientRequest.get(clientRequestId);
      if (existingRunId) {
        const existing = this.runs.get(existingRunId);
        if (existing) return { success: true, run: clone(existing), idempotent: true };
      }
      const now = Date.now();
      const runId = randomUUID();
      const initialDelivery = deliveryIdentity(runId, 1);
      const run: CompositeRunRecord = {
        version: COMPOSITE_RUN_SCHEMA_VERSION,
        revision: 0,
        runId,
        clientRequestId,
        sessionKey: request.sessionKey.trim(),
        prompt: request.prompt.trim(),
        ...(cwd ? { cwd } : {}),
        requestedMode: request.requestedMode ?? 'chat',
        userMessageTimestampMs: Number.isFinite(request.userMessageTimestampMs) ? Math.floor(request.userMessageTimestampMs!) : now,
        imageOptions: request.imageOptions ? { ...request.imageOptions } : undefined,
        videoOptions: request.videoOptions ? { ...request.videoOptions } : undefined,
        status: 'planned',
        tasks: request.tasks.map(normalizeTask),
        artifacts: [],
        verifications: [],
        delivery: {
          status: 'pending',
          generation: initialDelivery.generation,
          assistantMessageId: initialDelivery.assistantMessageId,
          attempts: 0,
        },
        runtimeEvents: [],
        lastSeq: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.runs.set(runId, run);
      this.runIdByClientRequest.set(clientRequestId, runId);
      await this.record(run, 'run.created', { taskCount: run.tasks.length });
      await this.emitRuntime(run, {
        type: 'run.started',
        objective: run.prompt,
        startedAt: now,
      });
      await this.emitRuntime(run, {
        type: 'run.plan.updated',
        objective: run.prompt,
        summary: 'UClaw Main 已接管组合任务。',
        steps: [
          {
            id: 'uclaw.composite',
            title: '执行组合任务',
            status: 'running',
            kind: 'composite',
            order: 1,
          },
          ...run.tasks.map((task, index) => ({
            id: taskStepId(task.id),
            title: task.title,
            status: 'pending' as const,
            detail: task.prompt,
            kind: 'composite-task',
            parentId: 'uclaw.composite',
            requiresArtifact: task.requiresArtifact !== false,
            order: index + 2,
          })),
        ],
      });
      run.status = 'running';
      await this.record(run, 'run.running');
      this.kick(runId);
      return { success: true, run: clone(run), idempotent: false };
    } finally {
      release();
    }
  }

  async get(runId: string): Promise<CompositeRunRecord | null> {
    await this.initialize();
    const run = this.runs.get(runId);
    return run ? clone(run) : null;
  }

  async list(sessionKey?: string, activeOnly = false): Promise<CompositeRunRecord[]> {
    await this.initialize();
    return [...this.runs.values()]
      .filter((run) => !sessionKey || run.sessionKey === sessionKey)
      .filter((run) => !activeOnly || !isCompositeRunTerminal(run.status))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((run) => clone(run));
  }

  async cancel(runId: string): Promise<CompositeRunCancelResult> {
    await this.initialize();
    const outcome = await this.mutate(runId, async (current) => {
      if (isCompositeRunTerminal(current.status)) return 'already_terminal' as const;
      current.status = 'cancelled';
      for (const task of current.tasks) {
        if (!terminalTask(task)) {
          task.status = 'cancelled';
          task.recoverable = false;
          task.autoRetrySafe = false;
          task.error = '用户已停止本轮任务。';
          task.completedAt = Date.now();
        }
      }
      current.delivery.status = 'skipped';
      current.delivery.error = undefined;
      await this.emitRuntime(current, { type: 'run.ended', status: 'aborted', error: '用户已停止本轮任务。' });
      current.manifest = buildManifest(current);
      await this.record(current, 'run.cancelled');
      return 'cancelled' as const;
    });
    if (outcome === null) return { outcome: 'not_found' };
    const run = this.runs.get(runId)!;
    if (outcome === 'cancelled') cancelMediaGenerationJobsForRun(runId, run.sessionKey);
    return { outcome, run: clone(run) };
  }

  async retry(runId: string, request: CompositeRunRetryRequest = {}): Promise<CompositeRunRetryResult> {
    await this.initialize();
    const result = await this.mutate(runId, async (current): Promise<Omit<CompositeRunRetryResult, 'run'>> => {
      if (
        current.status === 'cancelled'
        || (current.status === 'completed' && current.delivery.status === 'succeeded')
      ) return { outcome: 'not_retryable' };
      const requested = new Set((request.taskIds ?? []).map((id) => id.trim()).filter(Boolean));
      const retryAll = requested.size === 0;
      const resetIds = new Set<string>();
      for (const task of current.tasks) {
        if ((retryAll || requested.has(task.id)) && (task.status === 'failed' || task.status === 'blocked')) {
          resetIds.add(task.id);
        }
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const task of current.tasks) {
          if (task.status !== 'blocked' || resetIds.has(task.id)) continue;
          if ((task.dependsOn ?? []).some((dependencyId) => resetIds.has(dependencyId))) {
            resetIds.add(task.id);
            changed = true;
          }
        }
      }
      if (resetIds.size === 0) {
        const canRetryDelivery = retryAll
          && current.delivery.status === 'failed'
          && current.tasks.every(terminalTask);
        if (!canRetryDelivery) {
          return { outcome: 'no_match', retriedTaskIds: [] };
        }
        current.status = 'running';
        current.delivery.status = 'pending';
        current.delivery.error = undefined;
        current.delivery.persistedAt = undefined;
        current.manifest = undefined;
        await this.record(current, 'run.delivery_retry_requested', {
          generation: current.delivery.generation,
        });
        return {
          outcome: 'retry_started',
          retriedTaskIds: [],
          deliveryOnly: true,
        };
      }
      const removedArtifactIds = new Set<string>();
      for (const task of current.tasks) {
        if (!resetIds.has(task.id)) continue;
        task.artifactIds.forEach((id) => removedArtifactIds.add(id));
        task.status = 'pending';
        task.recoverable = undefined;
        task.error = undefined;
        task.jobId = undefined;
        task.artifactIds = [];
        task.automaticRetryCount = 0;
        task.autoRetrySafe = undefined;
        task.startedAt = undefined;
        task.completedAt = undefined;
      }
      current.artifacts = current.artifacts.filter((artifact) => !removedArtifactIds.has(artifact.id));
      current.verifications = current.verifications.filter((verification) => !verification.artifactId || !removedArtifactIds.has(verification.artifactId));
      current.gate = undefined;
      current.manifest = undefined;
      current.status = 'running';
      const nextDelivery = deliveryIdentity(
        current.runId,
        Math.max(1, current.delivery.generation || 1) + 1,
      );
      current.delivery = {
        status: 'pending',
        generation: nextDelivery.generation,
        assistantMessageId: nextDelivery.assistantMessageId,
        attempts: 0,
      };
      const retriedTaskIds = [...resetIds];
      await this.record(current, 'run.retry_requested', {
        taskIds: retriedTaskIds,
        deliveryGeneration: nextDelivery.generation,
        assistantMessageId: nextDelivery.assistantMessageId,
      });
      return { outcome: 'retry_started', retriedTaskIds, deliveryOnly: false };
    });
    if (result === null) return { outcome: 'not_found' };
    const run = this.runs.get(runId)!;
    if (result.outcome === 'retry_started') this.kick(runId);
    return { ...result, run: clone(run) };
  }

  private async loadAndRecover(): Promise<void> {
    if (!app.isReady()) await app.whenReady();
    await this.ensureRunDir();
    const entries = await fsP.readdir(this.runDir(), { withFileTypes: true }).catch(() => []);
    const loadedRuns = new Map<string, CompositeRunRecord>();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        let run: CompositeRunRecord | null = null;
        if (entry.name.endsWith('.events.jsonl')) {
          run = await this.readLatestJournalSnapshot(path.join(this.runDir(), entry.name));
        } else if (entry.name.endsWith('.json')) {
          const raw = await fsP.readFile(path.join(this.runDir(), entry.name), 'utf8');
          run = JSON.parse(raw) as CompositeRunRecord;
        }
        if (!run || run.version !== COMPOSITE_RUN_SCHEMA_VERSION || !run.runId || !run.clientRequestId) continue;
        const existing = loadedRuns.get(run.runId);
        if (!existing || run.revision > existing.revision) loadedRuns.set(run.runId, run);
      } catch (error) {
        logger.warn('[composite-run] failed to load snapshot', { file: entry.name, error: String(error) });
      }
    }
    for (const run of loadedRuns.values()) {
      for (const task of run.tasks) {
        task.automaticRetryCount ??= 0;
      }
      const recoveredDelivery = deliveryIdentity(run.runId, run.delivery.generation || 1);
      run.delivery.generation = recoveredDelivery.generation;
      run.delivery.assistantMessageId ||= recoveredDelivery.assistantMessageId;
      this.runs.set(run.runId, run);
      this.runIdByClientRequest.set(run.clientRequestId, run.runId);
    }
    await this.maintainTerminalJournals();
    for (const run of this.runs.values()) {
      if (isCompositeRunTerminal(run.status)) continue;
      await this.recoverRun(run);
      this.kick(run.runId);
    }
  }

  private async recoverRun(run: CompositeRunRecord): Promise<void> {
    let changed = false;
    const resumableMediaJobs: Array<{ taskId: string; jobId: string }> = [];
    if (run.status === 'finalizing' || run.delivery.status === 'writing') {
      run.status = 'running';
      run.delivery.status = 'pending';
      run.delivery.error = undefined;
      changed = true;
    }
    for (const task of run.tasks) {
      if (task.status !== 'running') continue;
      if (isMediaTask(task)) {
        const job = task.jobId ? getMediaGenerationJob(task.jobId) : null;
        if (!job || job.restartRecovery?.reason === 'main_process_restart') {
          task.status = 'blocked';
          task.recoverable = true;
          task.autoRetrySafe = false;
          task.error = job?.error || 'Main 重启后无法确认原媒体任务状态；为避免重复生成，已暂停并等待显式重试。';
          task.completedAt = Date.now();
          changed = true;
        } else {
          resumableMediaJobs.push({ taskId: task.id, jobId: job.id });
        }
      } else {
        task.status = 'pending';
        task.startedAt = undefined;
        changed = true;
      }
    }
    if (changed) {
      run.status = 'running';
      await this.record(run, 'run.recovered');
      for (const task of run.tasks.filter((candidate) => candidate.status === 'blocked')) {
        await this.emitTaskStep(run, task);
      }
    }
    for (const resumable of resumableMediaJobs) {
      this.resumeMediaMonitor(run.runId, resumable.taskId, resumable.jobId);
    }
  }

  private resumeMediaMonitor(runId: string, taskId: string, jobId: string): void {
    const executionKey = `${runId}:${taskId}`;
    if (this.activeTasks.has(executionKey)) return;
    this.activeTasks.add(executionKey);
    void this.monitorMediaJob(runId, taskId, jobId)
      .catch(async (error) => {
        await this.failTask(runId, taskId, error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.activeTasks.delete(executionKey);
        this.kick(runId);
      });
  }

  private kick(runId: string): void {
    this.pendingDriverKicks.add(runId);
    if (this.activeDrivers.has(runId)) return;
    this.activeDrivers.add(runId);
    void (async () => {
      while (this.pendingDriverKicks.delete(runId)) {
        try {
          await this.drive(runId);
        } catch (error) {
          logger.error('[composite-run] driver failed', { runId, error: String(error) });
        }
      }
    })().finally(() => {
      this.activeDrivers.delete(runId);
      if (this.pendingDriverKicks.has(runId)) this.kick(runId);
    });
  }

  private async drive(runId: string): Promise<void> {
    for (;;) {
      const run = this.runs.get(runId);
      if (!run || isCompositeRunTerminal(run.status) || run.status === 'finalizing') return;
      if (await this.scheduleSafeAutomaticRetries(runId)) continue;
      await this.propagateDependencyBlocks(runId);
      const current = this.runs.get(runId);
      if (!current) return;
      const ready = current.tasks.filter((task) => (
        task.status === 'pending'
        && (task.dependsOn ?? []).every((dependencyId) => current.tasks.find((candidate) => candidate.id === dependencyId)?.status === 'completed')
      ));
      if (ready.length > 0) {
        if (ready.some((task) => isLocalTask(task) && !task.plannedRequest)) {
          await this.ensureLocalPlans(runId);
          continue;
        }
        await Promise.all(ready.map((task) => this.runTask(runId, task.id)));
        continue;
      }
      if (current.tasks.some((task) => task.status === 'running')) return;
      if (current.tasks.every(terminalTask)) {
        await this.finalize(runId);
      }
      return;
    }
  }

  private async scheduleSafeAutomaticRetries(runId: string): Promise<boolean> {
    const snapshot = this.runs.get(runId);
    const localRetryItems: LocalArtifactPlanItem[] = snapshot?.tasks
      .filter((task) => (
        isLocalTask(task)
        && task.status === 'failed'
        && task.recoverable === true
        && task.autoRetrySafe === true
        && task.automaticRetryCount < MAX_SAFE_AUTOMATIC_RETRIES
        && Boolean(task.plannedRequest)
      ))
      .flatMap((task) => {
        const verification = failedLocalRepairableVerification(snapshot, task);
        if (!verification) return [];
        return [{
          id: task.id,
          request: clone(task.plannedRequest) as LocalArtifactCreateRequest,
          verificationFeedback: {
            detail: verification.detail,
            evidence: verification.evidence,
          },
        }];
      }) ?? [];
    const replacementRequests = new Map<string, LocalArtifactCreateRequest>();
    let retryPlanSource: 'model' | 'fallback' | undefined;
    let retryPlanError: string | undefined;
    if (localRetryItems.length > 0) {
      const result = await planLocalArtifactBatch(localRetryItems);
      retryPlanSource = result.source;
      retryPlanError = result.error;
      for (const item of result.items) replacementRequests.set(item.id, item.request);
    }

    let scheduled = false;
    await this.mutate(runId, async (run) => {
      const retryableTasks = run.tasks.filter((task) => (
        task.status === 'failed'
        && task.recoverable === true
        && task.autoRetrySafe === true
        && task.automaticRetryCount < MAX_SAFE_AUTOMATIC_RETRIES
        && (!isLocalTask(task) || replacementRequests.has(task.id))
      ));
      if (retryableTasks.length === 0) return;
      scheduled = true;
      const removedArtifactIds = new Set<string>();
      for (const task of retryableTasks) {
        task.artifactIds.forEach((id) => removedArtifactIds.add(id));
      }
      run.artifacts = run.artifacts.filter((artifact) => !removedArtifactIds.has(artifact.id));
      run.verifications = run.verifications.filter((verification) => (
        !verification.artifactId || !removedArtifactIds.has(verification.artifactId)
      ));
      for (const task of retryableTasks) {
        const replacementRequest = replacementRequests.get(task.id);
        if (replacementRequest) task.plannedRequest = clone(replacementRequest) as Record<string, unknown>;
        task.status = 'pending';
        task.automaticRetryCount += 1;
        task.recoverable = undefined;
        task.autoRetrySafe = undefined;
        task.error = undefined;
        task.jobId = undefined;
        task.artifactIds = [];
        task.startedAt = undefined;
        task.completedAt = undefined;
        await this.record(run, 'task.auto_retry_scheduled', {
          automaticRetryCount: task.automaticRetryCount,
          maxAutomaticRetries: MAX_SAFE_AUTOMATIC_RETRIES,
          ...(replacementRequest ? {
            replanned: true,
            plannerSource: retryPlanSource,
            plannerError: retryPlanError,
          } : {}),
        }, task.id);
        await this.emitTaskStep(run, task);
        await this.emitProgress(run, task, `${task.title}准备自动重试`, 'running');
      }
    });
    return scheduled;
  }

  private async propagateDependencyBlocks(runId: string): Promise<void> {
    await this.mutate(runId, async (run) => {
      let changed = true;
      while (changed) {
        changed = false;
        for (const task of run.tasks) {
          if (task.status !== 'pending') continue;
          const failedDependency = (task.dependsOn ?? [])
            .map((id) => run.tasks.find((candidate) => candidate.id === id))
            .find((dependency) => dependency && (dependency.status === 'failed' || dependency.status === 'blocked' || dependency.status === 'cancelled'));
          if (!failedDependency) continue;
          task.status = 'blocked';
          task.recoverable = failedDependency.recoverable !== false;
          task.autoRetrySafe = false;
          task.error = `依赖任务“${failedDependency.title}”未成功，当前任务未执行。`;
          task.completedAt = Date.now();
          await this.record(run, 'task.blocked_by_dependency', { dependencyId: failedDependency.id }, task.id);
          await this.emitTaskStep(run, task);
          changed = true;
        }
      }
    });
  }

  private async runTask(runId: string, taskId: string): Promise<void> {
    const executionKey = `${runId}:${taskId}`;
    if (this.activeTasks.has(executionKey)) return;
    this.activeTasks.add(executionKey);
    try {
      const task = await this.mutate(runId, async (run) => {
        const current = run.tasks.find((candidate) => candidate.id === taskId);
        if (!current || current.status !== 'pending') return;
        current.status = 'running';
        current.attempt += 1;
        current.startedAt = Date.now();
        current.completedAt = undefined;
        current.error = undefined;
        current.recoverable = undefined;
        await this.record(run, 'task.started', { attempt: current.attempt }, taskId);
        await this.emitTaskStep(run, current);
        await this.emitProgress(run, current, `正在执行${current.title}`, 'running');
        return clone(current);
      });
      if (!task) return;
      try {
        if (isLocalTask(task)) await this.executeLocalTask(runId, taskId);
        else await this.executeMediaTask(runId, taskId);
      } catch (error) {
        await this.failTask(runId, taskId, error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.activeTasks.delete(executionKey);
    }
  }

  private async ensureLocalPlans(runId: string): Promise<void> {
    const existing = this.localPlanning.get(runId);
    if (existing) return await existing;
    const promise = (async () => {
      const run = this.runs.get(runId);
      if (!run) return;
      const items: LocalArtifactPlanItem[] = run.tasks
        .filter((task) => isLocalTask(task) && !task.plannedRequest)
        .map((task) => ({ id: task.id, request: localTaskRequest(task, run.prompt, run.cwd) }));
      if (items.length === 0) return;
      await this.mutate(runId, async (current) => {
        await this.record(current, 'local.plan.started', { plannedItemCount: items.length });
        await this.emitRuntime(current, {
          type: 'progress.update',
          entry: {
            id: `progress:${current.runId}:local-plan`,
            kind: 'commentary',
            text: `正在规划 ${items.length} 个文件产物`,
            status: 'running',
            detail: '正在统一主题、内容结构和交付格式。',
            stepId: 'uclaw.composite',
            source: 'native',
          },
        });
      });
      const result = await planLocalArtifactBatch(items);
      await this.mutate(runId, async (current) => {
        const plannedById = new Map(result.items.map((item) => [item.id, item.request]));
        for (const item of items) {
          const task = current.tasks.find((candidate) => candidate.id === item.id);
          const plannedRequest = plannedById.get(item.id) ?? item.request;
          if (task && !task.plannedRequest) task.plannedRequest = clone(plannedRequest) as Record<string, unknown>;
        }
        await this.record(current, 'local.plan.completed', {
          source: result.source,
          durationMs: result.durationMs,
          error: result.error,
          plannedItemCount: items.length,
        });
        await this.emitRuntime(current, {
          type: 'progress.update',
          entry: {
            id: `progress:${current.runId}:local-plan`,
            kind: 'commentary',
            text: `已完成 ${items.length} 个文件产物的规划`,
            status: 'completed',
            detail: result.source === 'model'
              ? '已生成可执行内容计划。'
              : result.error === 'artifact_planner_single_artifact_fast_path'
                ? '已使用本地可执行快路径生成内容计划。'
                : '模型规划不可用，已切换本地可执行保底方案。',
            stepId: 'uclaw.composite',
            source: 'native',
          },
        });
      });
    })().finally(() => this.localPlanning.delete(runId));
    this.localPlanning.set(runId, promise);
    await promise;
  }

  private async executeLocalTask(runId: string, taskId: string): Promise<void> {
    await this.ensureLocalPlans(runId);
    const run = this.runs.get(runId);
    const task = run?.tasks.find((candidate) => candidate.id === taskId);
    if (!run || !task || task.status !== 'running') return;
    if (!task.plannedRequest) throw new Error('本地产物模型规划未返回有效内容。');
    const result = await createLocalArtifact(task.plannedRequest as LocalArtifactCreateRequest);
    const openability = await verifyLocalArtifactOpenability({ filePath: result.filePath });
    await this.completeLocalTask(runId, taskId, result, openability);
  }

  private async completeLocalTask(
    runId: string,
    taskId: string,
    result: LocalArtifactCreateResult,
    openability: LocalArtifactOpenabilityResult,
  ): Promise<void> {
    await this.mutate(runId, async (run) => {
      const task = run.tasks.find((candidate) => candidate.id === taskId);
      if (!task || task.status !== 'running' || run.status === 'cancelled') return;
      const artifact: ChatRuntimeArtifact = {
        id: artifactId(run.runId, task.id, task.artifactIds.length),
        kind: result.kind,
        title: result.fileName,
        filePath: result.filePath,
        mimeType: result.mimeType,
        sizeBytes: result.fileSize,
        stepId: taskStepId(task.id),
        source: 'local-artifact-runtime',
      };
      const availabilityVerification: ChatRuntimeVerification = {
        id: verificationId(artifact, 'artifact.availability'),
        status: result.filePath && result.fileSize > 0 ? 'passed' : 'failed',
        kind: 'artifact.availability',
        required: true,
        severity: result.filePath && result.fileSize > 0 ? 'info' : 'blocking',
        title: `验证 ${result.fileName}`,
        detail: result.filePath && result.fileSize > 0 ? '本地产物文件可用性验证已通过。' : '本地产物文件不可用。',
        evidence: `filePath=${result.filePath}; sizeBytes=${result.fileSize}`,
        targetId: artifact.id,
        artifactId: artifact.id,
        source: 'local-artifact-runtime',
      };
      const contentVerification: ChatRuntimeVerification = {
        id: verificationId(artifact, result.verification.kind),
        status: result.verification.status,
        kind: result.verification.kind,
        required: result.verification.required,
        severity: result.verification.severity,
        title: `验证 ${result.fileName}`,
        detail: result.verification.detail,
        evidence: result.verification.evidence,
        targetId: artifact.id,
        artifactId: artifact.id,
        source: 'local-artifact-runtime',
      };
      const openabilityVerification: ChatRuntimeVerification = {
        id: verificationId(artifact, openability.kind),
        status: openability.status,
        kind: openability.kind,
        required: openability.required,
        severity: openability.severity,
        title: `打开验证 ${result.fileName}`,
        detail: openability.detail,
        evidence: [
          openability.evidence,
          `verifier=${openability.verifier}`,
          `durationMs=${openability.durationMs}`,
        ].filter(Boolean).join('; '),
        targetId: artifact.id,
        artifactId: artifact.id,
        source: 'local-artifact-openability',
      };
      const taskVerifications = [availabilityVerification, contentVerification, openabilityVerification];
      run.artifacts.push(artifact);
      run.verifications.push(...taskVerifications);
      task.artifactIds.push(artifact.id);
      const requiredVerificationFailed = taskVerifications
        .some((verification) => verification.required !== false && verification.status !== 'passed');
      if (requiredVerificationFailed) {
        task.status = 'failed';
        task.recoverable = true;
        task.autoRetrySafe = taskVerifications.some((verification) => (
          verification.kind !== 'artifact.availability'
          && verification.required !== false
          && verification.status !== 'passed'
        ));
        task.error = taskVerifications
          .find((verification) => verification.required !== false && verification.status !== 'passed')?.detail
          || '本地产物验证未通过。';
      } else {
        task.status = 'completed';
        task.recoverable = false;
        task.autoRetrySafe = false;
      }
      task.completedAt = Date.now();
      await this.record(run, 'task.completed', { status: task.status }, task.id);
      await this.emitArtifact(run, artifact);
      await this.emitVerification(run, availabilityVerification);
      await this.emitVerification(run, contentVerification);
      await this.emitVerification(run, openabilityVerification);
      await this.emitTaskStep(run, task);
      await this.emitProgress(run, task, task.status === 'completed' ? `${task.title}已完成` : `${task.title}验证未通过`, task.status === 'completed' ? 'completed' : 'error');
    });
  }

  private resolveTaskImages(run: CompositeRunRecord, task: CompositeRunTaskRecord): Array<{ fileName?: string; mimeType?: string; filePath: string }> {
    const explicit = (task.sourceImages ?? []).filter((image) => image.filePath?.trim());
    if (explicit.length > 0) return explicit.map((image) => ({ ...image }));
    for (const dependencyId of [...(task.dependsOn ?? [])].reverse()) {
      const dependency = run.tasks.find((candidate) => candidate.id === dependencyId);
      if (!dependency) continue;
      for (const id of [...dependency.artifactIds].reverse()) {
        const artifact = run.artifacts.find((candidate) => candidate.id === id);
        if (artifact?.filePath && artifact.mimeType?.startsWith('image/')) {
          return [{ fileName: artifact.title, mimeType: artifact.mimeType, filePath: artifact.filePath }];
        }
      }
    }
    return [];
  }

  private async executeMediaTask(runId: string, taskId: string): Promise<void> {
    const run = this.runs.get(runId);
    const task = run?.tasks.find((candidate) => candidate.id === taskId);
    if (!run || !task || task.status !== 'running') return;
    const inputImages = this.resolveTaskImages(run, task);
    if (task.kind === 'image_edit' && inputImages.length === 0) {
      await this.blockTask(runId, taskId, '缺少可用于修图的图片输入。', false);
      return;
    }
    const isVideo = task.kind === 'video_generate';
    const snapshot = enqueueMediaGenerationJob(isVideo
      ? {
          kind: 'video',
          sessionKey: run.sessionKey,
          runId: run.runId,
          originalPrompt: run.prompt,
          prompt: task.prompt,
          model: run.videoOptions?.model,
          size: run.videoOptions?.size,
          durationSeconds: run.videoOptions?.durationSeconds,
          inputImages: inputImages.length > 0 ? inputImages : undefined,
          route: {
            mode: inputImages.length > 0 ? 'image_to_video' : 'text_to_video',
            source: 'router',
            selectedImageSource: inputImages.length > 0 ? (task.selectedImageSource ?? 'explicit') : 'none',
            selectedImageIndex: task.selectedImageIndex,
            videoPrompt: task.prompt,
            sourceImages: inputImages.length > 0 ? inputImages : undefined,
          },
          suppressConversationAppend: true,
        }
      : {
          kind: 'image',
          sessionKey: run.sessionKey,
          runId: run.runId,
          originalPrompt: run.prompt,
          prompt: task.prompt,
          model: run.imageOptions?.model,
          size: run.imageOptions?.size,
          quality: run.imageOptions?.quality,
          inputImages: inputImages.length > 0 ? inputImages : undefined,
          suppressConversationAppend: true,
        });
    await this.mutate(runId, async (current) => {
      const currentTask = current.tasks.find((candidate) => candidate.id === taskId);
      if (!currentTask || currentTask.status !== 'running') {
        cancelMediaGenerationJob(snapshot.id);
        return;
      }
      currentTask.jobId = snapshot.id;
      await this.record(current, 'task.media_enqueued', { jobId: snapshot.id, kind: snapshot.kind }, taskId);
    });
    await this.monitorMediaJob(runId, taskId, snapshot.id);
  }

  private async monitorMediaJob(runId: string, taskId: string, jobId: string): Promise<void> {
    let lastProgressSignature = '';
    for (;;) {
      const run = this.runs.get(runId);
      const task = run?.tasks.find((candidate) => candidate.id === taskId);
      if (!run || !task || task.status !== 'running' || run.status === 'cancelled') return;
      const job = getMediaGenerationJob(jobId);
      if (!job) {
        await this.blockTask(runId, taskId, '媒体任务状态不可确认；为避免重复生成，已暂停并等待显式重试。', true);
        return;
      }
      const progress = job.progressEvents?.at(-1);
      const signature = progress ? `${progress.id}:${progress.status}:${progress.detail ?? ''}` : job.status;
      if (signature !== lastProgressSignature) {
        lastProgressSignature = signature;
        await this.mutate(runId, async (current) => {
          const currentTask = current.tasks.find((candidate) => candidate.id === taskId);
          if (!currentTask || currentTask.status !== 'running') return;
          await this.record(current, 'task.media_progress', {
            jobId,
            status: job.status,
            label: progress?.label,
            detail: progress?.detail,
          }, taskId);
          await this.emitProgress(current, currentTask, progress?.label || `正在执行${currentTask.title}`, progress?.status === 'error' ? 'error' : 'running', progress?.detail);
        });
      }
      if (job.status === 'succeeded' && job.deliveryStatus !== 'pending') {
        await this.completeMediaTask(runId, taskId, job);
        return;
      }
      if (job.status === 'failed') throw new Error(job.error || '媒体任务执行失败。');
      if (job.status === 'cancelled') throw new Error('媒体任务已取消。');
      await new Promise<void>((resolve) => setTimeout(resolve, MEDIA_JOB_POLL_MS));
    }
  }

  private async completeMediaTask(runId: string, taskId: string, job: MediaGenerationJobSnapshot): Promise<void> {
    await this.mutate(runId, async (run) => {
      const task = run.tasks.find((candidate) => candidate.id === taskId);
      if (!task || task.status !== 'running' || run.status === 'cancelled') return;
      const kind = task.kind === 'video_generate' ? 'video' : 'image';
      const outputs = Array.isArray(job.outputs) ? job.outputs : [];
      if (outputs.length === 0) throw new Error('媒体任务完成但没有返回产物。');
      outputs.forEach((output, index) => {
        const artifact: ChatRuntimeArtifact = {
          id: artifactId(run.runId, task.id, task.artifactIds.length),
          kind,
          title: outputTitle(output, index, kind),
          filePath: output.path?.trim() || undefined,
          url: output.url?.trim() || undefined,
          mimeType: outputMimeType(output, kind),
          sizeBytes: typeof output.size === 'number' && output.size > 0 ? output.size : undefined,
          stepId: taskStepId(task.id),
          sourceToolCallId: job.id,
          source: 'media-generation-job',
        };
        const available = Boolean((artifact.filePath && artifact.sizeBytes) || artifact.url);
        const invalidDuration = kind === 'video'
          && typeof output.durationSeconds === 'number'
          && output.durationSeconds <= 0;
        const verification: ChatRuntimeVerification = {
          id: verificationId(artifact, 'artifact.availability'),
          status: available && !invalidDuration ? 'passed' : 'failed',
          kind: 'artifact.availability',
          required: true,
          severity: available && !invalidDuration ? 'info' : 'blocking',
          title: `验证 ${artifact.title || artifact.id}`,
          detail: invalidDuration
            ? '视频时长为 0 秒，不满足可播放交付条件。'
            : available ? '媒体产物可用性验证已通过。' : '媒体产物没有可用的本地文件或远端地址。',
          artifactId: artifact.id,
          targetId: artifact.id,
          evidence: artifact.filePath || artifact.url,
          source: 'media-generation-job',
        };
        run.artifacts.push(artifact);
        run.verifications.push(verification);
        task.artifactIds.push(artifact.id);
      });
      const taskVerifications = run.verifications.filter((verification) => task.artifactIds.includes(verification.artifactId || ''));
      const passed = taskVerifications.length > 0 && taskVerifications.every((verification) => verification.status === 'passed');
      task.status = passed ? 'completed' : 'failed';
      task.recoverable = !passed;
      task.autoRetrySafe = false;
      task.error = passed ? undefined : taskVerifications.find((verification) => verification.status !== 'passed')?.detail;
      task.completedAt = Date.now();
      await this.record(run, 'task.completed', { status: task.status, jobId: job.id }, task.id);
      for (const artifact of run.artifacts.filter((candidate) => task.artifactIds.includes(candidate.id))) await this.emitArtifact(run, artifact);
      for (const verification of taskVerifications) await this.emitVerification(run, verification);
      await this.emitTaskStep(run, task);
      await this.emitProgress(run, task, passed ? `${task.title}已完成` : `${task.title}验证未通过`, passed ? 'completed' : 'error');
    });
  }

  private async failTask(runId: string, taskId: string, message: string): Promise<void> {
    await this.mutate(runId, async (run) => {
      const task = run.tasks.find((candidate) => candidate.id === taskId);
      if (!task || task.status !== 'running' || run.status === 'cancelled') return;
      task.status = 'failed';
      task.recoverable = true;
      task.autoRetrySafe = isLocalTask(task) || (isMediaTask(task) && !task.jobId);
      task.error = message;
      task.completedAt = Date.now();
      await this.record(run, 'task.failed', { error: message }, task.id);
      await this.emitTaskStep(run, task);
      await this.emitProgress(run, task, `${task.title}执行失败`, 'error', message);
    });
  }

  private async blockTask(runId: string, taskId: string, message: string, recoverable: boolean): Promise<void> {
    await this.mutate(runId, async (run) => {
      const task = run.tasks.find((candidate) => candidate.id === taskId);
      if (!task || terminalTask(task) || run.status === 'cancelled') return;
      task.status = 'blocked';
      task.recoverable = recoverable;
      task.autoRetrySafe = false;
      task.error = message;
      task.completedAt = Date.now();
      await this.record(run, 'task.blocked', { error: message, recoverable }, task.id);
      await this.emitTaskStep(run, task);
      await this.emitProgress(run, task, `${task.title}已阻塞`, 'blocked', message);
    });
  }

  private async finalize(runId: string): Promise<void> {
    let shouldDeliver = false;
    let partialDelivery = false;
    let deliveryManifest: CompositeRunManifest | undefined;
    await this.mutate(runId, async (run) => {
      if (!run.tasks.every(terminalTask) || run.status === 'cancelled' || run.delivery.status === 'succeeded') return;
      const taskUpdates: CompositeRunTaskRecord[] = [];
      for (const task of run.tasks) {
        const taskArtifacts = task.artifactIds
          .map((artifactId) => run.artifacts.find((artifact) => artifact.id === artifactId))
          .filter((artifact): artifact is ChatRuntimeArtifact => Boolean(artifact));
        const missingRequiredVerification = taskArtifacts.some((artifact) => !run.verifications.some((verification) => (
          verification.artifactId === artifact.id
          && verification.required !== false
          && verification.status === 'passed'
        )));
        if (
          task.status === 'completed'
          && task.requiresArtifact !== false
          && (taskArtifacts.length === 0 || missingRequiredVerification)
        ) {
          task.status = 'failed';
          task.recoverable = true;
          task.autoRetrySafe = false;
          task.error = taskArtifacts.length === 0
            ? '任务已结束，但缺少必需产物，需要用户处理。'
            : '任务产物缺少必需验证，需要用户处理。';
        }
        if (task.status === 'failed' || task.status === 'blocked') {
          task.autoRetrySafe = false;
          task.recoverable ??= true;
          if (!task.error) task.error = '任务未完成，需要用户处理。';
          else if (!/需要用户/u.test(task.error)) task.error = `${task.error} 需要用户处理。`;
          taskUpdates.push(task);
        }
      }
      for (const task of taskUpdates) await this.emitTaskStep(run, task);
      partialDelivery = run.tasks.some((task) => task.status !== 'completed');
      run.gate = evaluateGate(run);
      await this.emitRuntime(run, { type: 'gate.evaluated', gate: clone(run.gate) });
      shouldDeliver = run.gate.decision === 'deliverable' || run.gate.decision === 'blocked_needs_user';
      if (!shouldDeliver) {
        run.gate = { ...run.gate, decision: 'blocked_needs_user', issues: run.gate.issues };
        shouldDeliver = true;
        partialDelivery = true;
        await this.emitRuntime(run, { type: 'gate.evaluated', gate: clone(run.gate) });
      }
      run.status = 'finalizing';
      run.delivery.status = 'writing';
      run.delivery.attempts += 1;
      run.delivery.text = deliveryText(run);
      run.delivery.error = undefined;
      const terminalEvent: ChatRuntimeEvent = {
        contractVersion: 1,
        producer: 'composite-coordinator',
        runId: run.runId,
        sessionKey: run.sessionKey,
        ts: Date.now(),
        type: 'run.ended',
        status: partialDelivery ? 'error' : 'completed',
        ...(partialDelivery ? { error: '部分任务未完成，已交付当前可用产物和待处理项。' } : {}),
      };
      deliveryManifest = buildManifest(run, [terminalEvent]);
      await this.record(run, 'run.delivery_started', { attempt: run.delivery.attempts });
    });
    if (!shouldDeliver) return;

    if (!this.runs.has(runId) || !deliveryManifest) return;
    try {
      await this.appendConversationWithRetry(runId, deliveryManifest);
      await this.mutate(runId, async (current) => {
        if (current.status === 'cancelled') return;
        await this.emitRuntime(current, {
          type: 'run.ended',
          status: partialDelivery ? 'error' : 'completed',
          ...(partialDelivery ? { error: '部分任务未完成，已交付当前可用产物和待处理项。' } : {}),
        });
        current.status = partialDelivery ? 'partial' : 'completed';
        current.delivery.status = 'succeeded';
        current.delivery.persistedAt = Date.now();
        current.delivery.error = undefined;
        current.manifest = buildManifest(current);
        await this.record(current, 'run.delivery_succeeded');
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.mutate(runId, async (current) => {
        if (current.status === 'cancelled') return;
        current.status = 'failed';
        current.delivery.status = 'failed';
        current.delivery.error = message;
        await this.emitRuntime(current, {
          type: 'run.step.updated',
          step: {
            id: 'uclaw.deliver',
            title: '交付组合结果',
            status: 'error',
            detail: message,
            kind: 'delivery',
          },
        });
        await this.emitRuntime(current, {
          type: 'progress.update',
          entry: {
            id: `progress:${current.runId}:delivery`,
            kind: 'status',
            text: '结果写入会话失败，任务尚未完成',
            status: 'error',
            detail: message,
            source: 'native',
          },
        });
        await this.emitRuntime(current, {
          type: 'run.checkpoint',
          checkpoint: {
            id: `checkpoint:${current.runId}:delivery-failed`,
            summary: '组合任务产物已生成，但最终结果尚未写入会话。',
            reason: message,
            recoverable: true,
          },
        });
        await this.record(current, 'run.delivery_failed', { error: message });
      });
    }
  }

  private async appendConversationWithRetry(
    runId: string,
    manifest: CompositeRunManifest,
  ): Promise<void> {
    for (let attemptIndex = 0; ; attemptIndex += 1) {
      const run = this.runs.get(runId);
      if (!run || run.status === 'cancelled') throw new Error('Conversation delivery cancelled');
      try {
        const files = this.conversationFiles(run);
        await appendCompositeArtifactConversation({
          sessionKey: run.sessionKey,
          prompt: run.prompt,
          summaryText: run.delivery.text || deliveryText(run),
          runId: deliveryIdentity(run.runId, run.delivery.generation || 1).appendRunId,
          files,
          outputPaths: files.map((file) => file.filePath || file.gatewayUrl || '').filter(Boolean),
          inputPaths: run.tasks.flatMap((task) => (task.sourceImages ?? []).map((image) => image.filePath)),
          userTimestampMs: run.userMessageTimestampMs,
          manifest,
          shouldAbort: () => this.runs.get(runId)?.status === 'cancelled',
        });
        return;
      } catch (error) {
        if (this.runs.get(runId)?.status === 'cancelled') throw error;
        const retryDelayMs = DELIVERY_APPEND_RETRY_DELAYS_MS[attemptIndex];
        if (retryDelayMs === undefined) throw error;
        const message = error instanceof Error ? error.message : String(error);
        await this.mutate(runId, async (current) => {
          if (current.status === 'cancelled' || current.delivery.status !== 'writing') return;
          current.delivery.error = message;
          await this.record(current, 'run.delivery_retry_scheduled', {
            nextAttempt: current.delivery.attempts + 1,
            delayMs: retryDelayMs,
          });
        });
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
        const retryStarted = await this.mutate(runId, async (current) => {
          if (current.status === 'cancelled' || current.delivery.status !== 'writing') return false;
          current.delivery.attempts += 1;
          await this.record(current, 'run.delivery_retry_started', {
            attempt: current.delivery.attempts,
            delayMs: retryDelayMs,
          });
          return true;
        });
        if (!retryStarted) throw new Error('Conversation delivery cancelled', { cause: error });
      }
    }
  }

  private conversationFiles(run: CompositeRunRecord): PersistedConversationFile[] {
    const deliverableArtifactIds = new Set(run.tasks
      .filter((task) => task.status === 'completed')
      .flatMap((task) => task.artifactIds));
    return run.artifacts.filter((artifact) => deliverableArtifactIds.has(artifact.id)).map((artifact) => ({
      fileName: artifact.title,
      mimeType: artifact.mimeType,
      fileSize: artifact.sizeBytes,
      filePath: artifact.filePath,
      gatewayUrl: artifact.url,
      source: 'tool-result' as const,
    })).filter((file) => file.filePath || file.gatewayUrl);
  }

  private async emitTaskStep(run: CompositeRunRecord, task: CompositeRunTaskRecord): Promise<void> {
    const status = task.status === 'failed'
      ? 'error'
      : task.status === 'cancelled'
        ? 'skipped'
        : task.status;
    await this.emitRuntime(run, {
      type: 'run.step.updated',
      step: {
        id: taskStepId(task.id),
        title: task.title,
        status,
        detail: task.error || task.prompt,
        kind: 'composite-task',
        parentId: 'uclaw.composite',
        requiresArtifact: task.requiresArtifact !== false,
      },
    });
  }

  private async emitProgress(
    run: CompositeRunRecord,
    task: CompositeRunTaskRecord,
    text: string,
    status: 'running' | 'completed' | 'blocked' | 'error',
    detail?: string,
  ): Promise<void> {
    await this.emitRuntime(run, {
      type: 'progress.update',
      entry: {
        id: `progress:${run.runId}:${task.id}`,
        kind: 'action',
        text,
        status,
        detail,
        stepId: taskStepId(task.id),
        source: 'native',
      },
    });
  }

  private async emitArtifact(run: CompositeRunRecord, artifact: ChatRuntimeArtifact): Promise<void> {
    await this.emitRuntime(run, { type: 'artifact.produced', artifact: clone(artifact) });
  }

  private async emitVerification(run: CompositeRunRecord, verification: ChatRuntimeVerification): Promise<void> {
    await this.emitRuntime(run, { type: 'verification.completed', verification: clone(verification) });
  }

  private async emitRuntime(
    run: CompositeRunRecord,
    event: RuntimeEventInput,
  ): Promise<void> {
    const seq = run.lastSeq + 1;
    const runtimeEvent = {
      ...event,
      contractVersion: 1 as const,
      producer: 'composite-coordinator',
      runId: run.runId,
      sessionKey: run.sessionKey,
      seq,
      ts: Date.now(),
    } as ChatRuntimeEvent;
    run.lastSeq = seq;
    run.runtimeEvents.push(runtimeEvent);
    await this.record(run, 'runtime.event', undefined, undefined, runtimeEvent);
    this.publisher?.(clone(runtimeEvent));
  }

  private async mutate<T>(runId: string, operation: (run: CompositeRunRecord) => Promise<T>): Promise<T | null> {
    const previous = this.runLocks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.runLocks.set(runId, current);
    await previous.catch(() => undefined);
    try {
      const run = this.runs.get(runId);
      if (!run) return null;
      const result = await operation(run);
      return result;
    } finally {
      release();
      if (this.runLocks.get(runId) === current) this.runLocks.delete(runId);
    }
  }

  private async record(
    run: CompositeRunRecord,
    type: string,
    data?: Record<string, unknown>,
    taskId?: string,
    runtimeEvent?: ChatRuntimeEvent,
  ): Promise<void> {
    const eventSeq = runtimeEvent?.seq ?? run.lastSeq + 1;
    if (!runtimeEvent) run.lastSeq = eventSeq;
    run.revision += 1;
    run.updatedAt = Date.now();
    const event: CompositeRunJournalEvent = {
      version: 1,
      runId: run.runId,
      seq: eventSeq,
      ts: run.updatedAt,
      type,
      taskId,
      data,
      runtimeEvent,
      snapshot: clone(run),
    };
    await this.ensureRunDir();
    const journalPath = this.journalPath(run.runId);
    await fsP.appendFile(journalPath, `${JSON.stringify(event)}\n`, {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE,
    });
    await this.enforcePrivateFileMode(journalPath);
    await this.writeSnapshot(run);
    if (isCompositeRunTerminal(run.status)) {
      await this.compactTerminalJournal(run, event);
    }
  }

  private async writeSnapshot(run: CompositeRunRecord): Promise<void> {
    const target = this.snapshotPath(run.runId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsP.writeFile(temporary, JSON.stringify(run, null, 2), {
        encoding: 'utf8',
        mode: PRIVATE_FILE_MODE,
      });
      await fsP.rename(temporary, target);
      await this.enforcePrivateFileMode(target);
    } catch (error) {
      await fsP.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async compactTerminalJournal(
    run: CompositeRunRecord,
    latestEvent?: CompositeRunJournalEvent,
  ): Promise<void> {
    const target = this.journalPath(run.runId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const compactedEvent: CompositeRunJournalEvent = {
      version: 1,
      runId: run.runId,
      seq: latestEvent?.seq ?? run.lastSeq,
      ts: latestEvent?.ts ?? run.updatedAt,
      type: 'run.journal.compacted',
      data: {
        terminalStatus: run.status,
        compactedAt: Date.now(),
        ...(latestEvent ? { latestEventType: latestEvent.type } : {}),
      },
      snapshot: clone(run),
    };
    try {
      await fsP.writeFile(temporary, `${JSON.stringify(compactedEvent)}\n`, {
        encoding: 'utf8',
        mode: PRIVATE_FILE_MODE,
      });
      await fsP.rename(temporary, target);
      await this.enforcePrivateFileMode(target);
    } catch (error) {
      await fsP.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async maintainTerminalJournals(): Promise<void> {
    const expiresBefore = Date.now() - TERMINAL_JOURNAL_RETENTION_MS;
    for (const run of this.runs.values()) {
      await this.enforcePrivateFileMode(this.snapshotPath(run.runId), true);
      await this.enforcePrivateFileMode(this.journalPath(run.runId), true);
      if (!isCompositeRunTerminal(run.status)) continue;
      if (run.updatedAt <= expiresBefore) {
        await this.writeSnapshot(run);
        await fsP.rm(this.journalPath(run.runId), { force: true });
        continue;
      }
      await this.compactTerminalJournal(run);
    }
  }

  private async ensureRunDir(): Promise<void> {
    const directory = this.runDir();
    await fsP.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    if (process.platform !== 'win32') await fsP.chmod(directory, PRIVATE_DIRECTORY_MODE);
  }

  private async enforcePrivateFileMode(filePath: string, allowMissing = false): Promise<void> {
    if (process.platform === 'win32') return;
    try {
      await fsP.chmod(filePath, PRIVATE_FILE_MODE);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private async readLatestJournalSnapshot(journalPath: string): Promise<CompositeRunRecord | null> {
    const raw = await fsP.readFile(journalPath, 'utf8');
    const lines = raw.split(/\r?\n/u).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const event = JSON.parse(lines[index]!) as CompositeRunJournalEvent;
        if (event.snapshot) return event.snapshot;
      } catch {
        continue;
      }
    }
    return null;
  }

  private runDir(): string {
    return path.join(getOpenClawConfigDir(), RUN_DIR_NAME);
  }

  private snapshotPath(runId: string): string {
    return path.join(this.runDir(), `${safeId(runId)}.json`);
  }

  private journalPath(runId: string): string {
    return path.join(this.runDir(), `${safeId(runId)}.events.jsonl`);
  }
}

export const compositeRunCoordinator = new CompositeRunCoordinator();

void compositeRunCoordinator.initialize().catch((error) => {
  logger.error('[composite-run] startup recovery failed', error);
});
