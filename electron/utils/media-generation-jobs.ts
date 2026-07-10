import { randomUUID } from 'node:crypto';
import { existsSync, promises as fsP } from 'fs';
import path from 'node:path';
import { app, utilityProcess } from 'electron';
import { appendImageGenerationConversation } from './chat-session-image-message';
import { getElectronStoreUserDataEnvKey } from './electron-store-options';
import { logger } from './logger';
import {
  getMediaGenerationJobJournalPath,
  loadMediaGenerationJobJournal,
  writeMediaGenerationJobJournal,
  type MediaGenerationJournalEntry,
} from './media-generation-job-journal';
import type {
  MediaGenerationKind,
  MediaGenerationJobCancelResult,
  MediaGenerationJobDeliveryRetryResult,
  MediaGenerationJobEnqueueResult,
  MediaGenerationJobPayload,
  MediaGenerationJobOutput,
  MediaGenerationProgressEvent,
  MediaGenerationJobSnapshot,
  MediaGenerationWorkerRequest,
  MediaGenerationWorkerResponse,
} from './media-generation-types';
import { ensureManagedOpenAiImageRelay } from './openclaw-image-generation';
import { ensureManagedOpenAiVideoRelay } from './openclaw-video-generation';
import { getOpenClawDir } from './paths';

type InternalMediaGenerationJob = MediaGenerationJobSnapshot & {
  payload: MediaGenerationJobPayload;
  cancelRequested?: boolean;
  worker?: ReturnType<typeof utilityProcess.fork>;
};

const jobs = new Map<string, InternalMediaGenerationJob>();
const jobIdByClientRequest = new Map<string, string>();
const activeDeliveryRetryJobIds = new Set<string>();
const queues: Record<MediaGenerationKind, string[]> = {
  image: [],
  video: [],
};
const MAX_JOB_HISTORY = 50;
const TERMINAL_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const JOURNAL_WRITE_DEBOUNCE_MS = 100;
const JOURNAL_COMPACTION_INTERVAL_MS = 15 * 60 * 1000;
const MAX_WORKER_OUTPUT_CHARS = 4096;
const MAX_WORKER_LOG_CHARS = 1024;
const MAX_JOB_ERROR_CHARS = 12_000;
const MAX_JOB_PROGRESS_EVENTS = 80;
const USER_FACING_UPSTREAM_MEDIA_ERROR: Record<MediaGenerationKind, string> = {
  image: '图片生成暂时没成功，请稍后再试。',
  video: '视频生成暂时没成功，请稍后再试。',
};
const MEDIA_GENERATION_CONCURRENCY: Record<MediaGenerationKind, number> = {
  image: 1,
  video: 5,
};
const MEDIA_GENERATION_WATCHDOG_MS: Record<MediaGenerationKind, number> = {
  image: 30 * 60 * 1000,
  video: 20 * 60 * 1000,
};

const activeJobIds: Record<MediaGenerationKind, Set<string>> = {
  image: new Set<string>(),
  video: new Set<string>(),
};

let jobJournalLoaded = false;
let jobJournalDirty = false;
let jobJournalWriteTimer: ReturnType<typeof setTimeout> | undefined;
let jobJournalCompactionTimer: ReturnType<typeof setInterval> | undefined;
let jobJournalWriteChain = Promise.resolve();
let jobJournalWritesInFlight = 0;
let jobJournalClosing = false;
let allowQuitAfterJournalFlush = false;

function isTerminalJob(job: InternalMediaGenerationJob): boolean {
  return job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled';
}

function getJobJournalEntries(): MediaGenerationJournalEntry[] {
  return [...jobs.values()].map((job) => ({
    payload: job.payload,
    snapshot: cloneSnapshot(job),
  }));
}

function flushJobJournal(): Promise<void> {
  if (!jobJournalLoaded) return jobJournalWriteChain;
  if (jobJournalWriteTimer) {
    clearTimeout(jobJournalWriteTimer);
    jobJournalWriteTimer = undefined;
  }
  if (!jobJournalDirty) return jobJournalWriteChain;
  jobJournalDirty = false;
  const entries = getJobJournalEntries();
  const filePath = getMediaGenerationJobJournalPath(app.getPath('userData'));
  jobJournalWritesInFlight += 1;
  jobJournalWriteChain = jobJournalWriteChain
    .catch(() => undefined)
    .then(() => writeMediaGenerationJobJournal(filePath, entries))
    .catch((error) => {
      logger.warn('[media-generation] unable to persist job journal', {
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      jobJournalWritesInFlight = Math.max(0, jobJournalWritesInFlight - 1);
    });
  return jobJournalWriteChain;
}

function scheduleJobJournalPersist(immediate = false): void {
  if (!jobJournalLoaded || jobJournalClosing) return;
  jobJournalDirty = true;
  if (jobJournalWriteTimer && !immediate) return;
  if (jobJournalWriteTimer) clearTimeout(jobJournalWriteTimer);
  jobJournalWriteTimer = setTimeout(() => {
    jobJournalWriteTimer = undefined;
    void flushJobJournal();
  }, immediate ? 0 : JOURNAL_WRITE_DEBOUNCE_MS);
  jobJournalWriteTimer.unref?.();
}

function markInterruptedByRestart(job: InternalMediaGenerationJob, previousStatus: 'queued' | 'running'): void {
  const recoveredAt = Date.now();
  const message = previousStatus === 'running'
    ? '应用主进程已重启，无法确认上一次媒体请求是否仍在提供方执行。为避免重复生成或扣费，本任务未自动续跑，请重试。'
    : '应用主进程已重启，上一次排队任务没有自动续跑，以避免重复生成，请重试。';
  job.status = 'failed';
  job.updatedAt = recoveredAt;
  job.completedAt = recoveredAt;
  job.error = message;
  job.deliveryStatus = 'skipped';
  job.deliveryError = undefined;
  job.recoverable = true;
  job.restartRecovery = {
    previousStatus,
    recoveredAt,
    reason: 'main_process_restart',
  };
  job.progressEvents = (job.progressEvents ?? []).map((event) => (
    event.status === 'running'
      ? {
          ...event,
          status: 'error' as const,
          event: 'interrupted_by_restart',
          detail: event.detail ? `${event.detail}\n${message}` : message,
        }
      : event
  ));
  recordJobProgress(job, {
    id: 'job:restart-recovery',
    event: 'interrupted_by_restart',
    label: job.kind === 'image' ? '图片任务因应用重启中断' : '视频任务因应用重启中断',
    status: 'error',
    timestampMs: recoveredAt,
    detail: message,
  });
}

function restoreJournalEntry(entry: MediaGenerationJournalEntry): InternalMediaGenerationJob {
  const job: InternalMediaGenerationJob = {
    ...entry.snapshot,
    ...(entry.snapshot.clientRequestId || entry.payload.clientRequestId
      ? { clientRequestId: entry.snapshot.clientRequestId || entry.payload.clientRequestId }
      : {}),
    payload: entry.payload,
    ...(entry.snapshot.outputs?.length
      ? { result: { ok: true, outputs: entry.snapshot.outputs } }
      : {}),
  };
  if (job.status === 'queued' || job.status === 'running') {
    markInterruptedByRestart(job, job.status);
  }
  return job;
}

function resumeRecoveredStandaloneDelivery(job: InternalMediaGenerationJob): void {
  const availableOutputs = job.outputs?.filter((output) => {
    const localPath = typeof output.path === 'string' ? output.path.trim() : '';
    if (localPath && existsSync(localPath)) return true;
    const remoteUrl = typeof output.url === 'string' ? output.url.trim() : '';
    return /^https?:\/\//iu.test(remoteUrl);
  }) ?? [];
  if (availableOutputs.length === 0) {
    const now = Date.now();
    job.status = 'failed';
    job.updatedAt = now;
    job.completedAt = now;
    job.error = '应用重启后未找到可恢复的媒体产物，无法恢复交付，请重新生成。';
    job.deliveryStatus = 'skipped';
    job.deliveryError = undefined;
    job.recoverable = true;
    recordJobProgress(job, {
      id: 'job:restart-recovery',
      event: 'artifact_missing_after_restart',
      label: '重启后未找到媒体产物',
      status: 'error',
      timestampMs: now,
      detail: job.error,
    });
    return;
  }
  job.outputs = availableOutputs;
  job.result = { ok: true, outputs: availableOutputs };
  job.deliveryStatus = 'pending';
  job.deliveryError = undefined;
  job.recoverable = true;
  recordJobProgress(job, {
    id: 'job:delivery',
    event: 'delivery_resumed_after_restart',
    label: '恢复媒体结果到会话',
    status: 'running',
    timestampMs: Date.now(),
    detail: '媒体文件已在本地找到，正在幂等恢复会话记录。',
  });
  setImmediate(() => void retryCompletedConversationDelivery(job));
}

function initializeJobJournal(): void {
  if (jobJournalLoaded) return;
  jobJournalLoaded = true;
  const filePath = getMediaGenerationJobJournalPath(app.getPath('userData'));
  try {
    const entries = loadMediaGenerationJobJournal(filePath);
    for (const entry of entries) {
      const job = restoreJournalEntry(entry);
      jobs.set(job.id, job);
      if (job.clientRequestId && !jobIdByClientRequest.has(job.clientRequestId)) {
        jobIdByClientRequest.set(job.clientRequestId, job.id);
      }
    }
    const changedByCompaction = compactJobHistory();
    const recoveredDeliveries = [...jobs.values()].filter((job) => (
      job.ownerKind === 'standalone'
      && job.status === 'succeeded'
      && (job.deliveryStatus === 'pending' || job.deliveryStatus === 'failed')
    ));
    for (const job of recoveredDeliveries) resumeRecoveredStandaloneDelivery(job);
    if (entries.some((entry) => entry.snapshot.status === 'queued' || entry.snapshot.status === 'running')
      || recoveredDeliveries.length > 0
      || changedByCompaction) {
      scheduleJobJournalPersist(true);
    }
    logger.info('[media-generation] job journal loaded', {
      jobs: jobs.size,
      interrupted: [...jobs.values()].filter((job) => job.restartRecovery?.reason === 'main_process_restart').length,
      deliveryRecoveries: recoveredDeliveries.length,
    });
  } catch (error) {
    logger.warn('[media-generation] unable to load job journal', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  jobJournalCompactionTimer = setInterval(() => {
    if (compactJobHistory()) scheduleJobJournalPersist(true);
  }, JOURNAL_COMPACTION_INTERVAL_MS);
  jobJournalCompactionTimer.unref?.();

  if (typeof app.on === 'function') {
    app.on('before-quit', (event) => {
      if (
        allowQuitAfterJournalFlush
        || (!jobJournalDirty && !jobJournalWriteTimer && jobJournalWritesInFlight === 0)
      ) return;
      event.preventDefault();
      jobJournalClosing = true;
      jobJournalDirty = true;
      void flushJobJournal().finally(() => {
        allowQuitAfterJournalFlush = true;
        app.quit();
      });
    });
  }
}

function ensureJobJournalInitialized(): void {
  if (!jobJournalLoaded) initializeJobJournal();
}

function resolveMainStaticScript(name: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar', 'dist-electron', 'main', name);
  }
  const candidates = [
    path.join(__dirname, name),
    path.join(__dirname, '..', name),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function getMediaWorkerWrapperPath(): string {
  return resolveMainStaticScript('media-generation-worker.cjs');
}

function getMediaWorkerEntryPath(): string {
  const builtEntry = resolveMainStaticScript('media-generation-worker-entry.js');
  if (existsSync(builtEntry) || app.isPackaged) {
    return builtEntry;
  }
  return path.join(__dirname, 'media-generation-worker-entry.ts');
}

function cloneSnapshot(job: InternalMediaGenerationJob): MediaGenerationJobSnapshot {
  const {
    payload: _payload,
    cancelRequested: _cancelRequested,
    worker: _worker,
    ...snapshot
  } = job;
  const queueIndex = job.status === 'queued' ? queues[job.kind].indexOf(job.id) : -1;
  const startedAt = typeof job.startedAt === 'number' ? job.startedAt : undefined;
  const completedAt = typeof job.completedAt === 'number' ? job.completedAt : undefined;
  return {
    ...snapshot,
    activeJobs: activeJobIds[job.kind].size,
    maxActiveJobs: MEDIA_GENERATION_CONCURRENCY[job.kind],
    queuePosition: queueIndex >= 0 ? queueIndex + 1 : undefined,
    queueWaitMs: startedAt ? Math.max(0, startedAt - job.createdAt) : undefined,
    runDurationMs: startedAt
      ? Math.max(0, (completedAt ?? Date.now()) - startedAt)
      : undefined,
    progressEvents: [...(job.progressEvents ?? [])],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function formatDurationMs(ms: unknown): string | undefined {
  const durationMs = readNumber(ms);
  if (durationMs == null) return undefined;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${Math.round(durationMs / 1000)}s`;
}

function formatByteSize(bytes: unknown): string | undefined {
  const size = readNumber(bytes);
  if (size == null || size < 0) return undefined;
  if (size < 1024) return `${Math.round(size)}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

function compactDetail(lines: Array<string | undefined>): string | undefined {
  const detail = lines.filter((line): line is string => Boolean(line && line.trim())).join('\n');
  return detail || undefined;
}

function buildProgressEvent(input: Omit<MediaGenerationProgressEvent, 'timestampMs'> & {
  timestampMs?: number;
}): MediaGenerationProgressEvent {
  return {
    ...input,
    timestampMs: input.timestampMs ?? Date.now(),
  };
}

function upsertProgressEvent(job: InternalMediaGenerationJob, event: MediaGenerationProgressEvent): void {
  const current = job.progressEvents ?? [];
  const existingIndex = current.findIndex((item) => item.id === event.id);
  const next = existingIndex >= 0
    ? current.map((item, index) => (index === existingIndex ? { ...item, ...event } : item))
    : [...current, event];
  job.progressEvents = next.slice(-MAX_JOB_PROGRESS_EVENTS);
  job.updatedAt = Date.now();
  scheduleJobJournalPersist();
}

function recordJobProgress(job: InternalMediaGenerationJob, event: Omit<MediaGenerationProgressEvent, 'source' | 'timestampMs'> & {
  timestampMs?: number;
}): void {
  upsertProgressEvent(job, buildProgressEvent({
    source: 'job',
    ...event,
  }));
}

function stringifyMetadata(details: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of keys) {
    const value = details[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      metadata[key] = value;
    }
  }
  return metadata;
}

function progressForStructuredWorkerEvent(
  job: InternalMediaGenerationJob,
  source: 'worker' | 'runtime' | 'plugin',
  eventName: string,
  details: Record<string, unknown>,
): MediaGenerationProgressEvent | null {
  const requestId = readString(details.requestId) ?? job.id;
  const index = readNumber(details.index) ?? readNumber(details.outputIndex) ?? 0;
  const durationMs = readNumber(details.durationMs) ?? readNumber(details.totalDurationMs);
  const durationText = formatDurationMs(durationMs);
  const bytesText = formatByteSize(details.bytes);
  const model = readString(details.model);
  const size = readString(details.size);
  const quality = readString(details.quality);
  const statusCode = readNumber(details.status);
  const host = readString(details.host);

  if (source === 'worker') {
    switch (eventName) {
      case 'image_start':
        return buildProgressEvent({
          id: 'worker:image',
          source,
          event: eventName,
          label: '图片生成执行',
          status: 'running',
          detail: compactDetail([
            model ? `模型：${model}` : undefined,
            size ? `尺寸：${size}` : undefined,
            quality ? `质量：${quality}` : undefined,
            `参考图：${readNumber(details.inputImageCount) ?? 0} 张`,
          ]),
          metadata: stringifyMetadata(details, ['model', 'size', 'quality', 'promptChars']),
        });
      case 'image_done':
        return buildProgressEvent({
          id: 'worker:image',
          source,
          event: eventName,
          label: '图片生成执行',
          status: 'completed',
          detail: compactDetail([durationText ? `总耗时：${durationText}` : undefined]),
          durationMs,
        });
      case 'video_start':
      case 'pipeline_video_start':
        return buildProgressEvent({
          id: eventName === 'video_start' ? 'worker:video' : 'worker:pipeline-video',
          source,
          event: eventName,
          label: eventName === 'video_start' ? '视频生成执行' : '生成视频阶段',
          status: 'running',
          detail: compactDetail([
            size ? `尺寸：${size}` : undefined,
            readNumber(details.durationSeconds) ? `时长：${details.durationSeconds}s` : undefined,
          ]),
          metadata: stringifyMetadata(details, ['size', 'durationSeconds', 'promptChars']),
        });
      case 'video_done':
      case 'pipeline_video_done':
        return buildProgressEvent({
          id: eventName === 'video_done' ? 'worker:video' : 'worker:pipeline-video',
          source,
          event: eventName,
          label: eventName === 'video_done' ? '视频生成执行' : '生成视频阶段',
          status: 'completed',
          detail: compactDetail([
            durationText ? `阶段耗时：${durationText}` : undefined,
            formatDurationMs(details.totalDurationMs) ? `总耗时：${formatDurationMs(details.totalDurationMs)}` : undefined,
          ]),
          durationMs,
        });
      case 'pipeline_start':
        return buildProgressEvent({
          id: 'worker:pipeline',
          source,
          event: eventName,
          label: '图像到视频流水线',
          status: 'running',
          detail: compactDetail([
            readString(details.mode) ? `模式：${readString(details.mode)}` : undefined,
            size ? `尺寸：${size}` : undefined,
            readNumber(details.durationSeconds) ? `时长：${details.durationSeconds}s` : undefined,
          ]),
          metadata: stringifyMetadata(details, ['mode', 'size', 'durationSeconds']),
        });
      case 'pipeline_image_edit_start':
        return buildProgressEvent({
          id: 'worker:pipeline-image-edit',
          source,
          event: eventName,
          label: '先修图',
          status: 'running',
          detail: compactDetail([readNumber(details.promptChars) ? `提示词：${details.promptChars} 字符` : undefined]),
          metadata: stringifyMetadata(details, ['promptChars']),
        });
      case 'pipeline_image_edit_done':
        return buildProgressEvent({
          id: 'worker:pipeline-image-edit',
          source,
          event: eventName,
          label: '先修图',
          status: 'completed',
          detail: compactDetail([durationText ? `阶段耗时：${durationText}` : undefined]),
          durationMs,
        });
      default:
        return null;
    }
  }

  if (source === 'runtime') {
    switch (eventName) {
      case 'start':
        return buildProgressEvent({
          id: 'runtime:image',
          source,
          event: eventName,
          label: '图片运行时',
          status: 'running',
          detail: compactDetail([
            model ? `模型：${model}` : undefined,
            size ? `尺寸：${size}` : undefined,
            quality ? `质量：${quality}` : undefined,
          ]),
          metadata: stringifyMetadata(details, ['model', 'size', 'quality', 'timeoutMs']),
        });
      case 'provider_done':
        return buildProgressEvent({
          id: 'runtime:provider',
          source,
          event: eventName,
          label: '图片提供方返回',
          status: 'completed',
          detail: compactDetail([
            durationText ? `耗时：${durationText}` : undefined,
            readNumber(details.outputImages) ? `输出：${details.outputImages} 张` : undefined,
          ]),
          durationMs,
          metadata: stringifyMetadata(details, ['provider', 'model', 'outputImages']),
        });
      case 'output_saved':
        return buildProgressEvent({
          id: `runtime:save:${index}`,
          source,
          event: eventName,
          label: '保存本地产物',
          status: 'completed',
          detail: compactDetail([
            formatDurationMs(details.saveDurationMs) ? `保存：${formatDurationMs(details.saveDurationMs)}` : undefined,
            formatDurationMs(details.metadataDurationMs) ? `元数据：${formatDurationMs(details.metadataDurationMs)}` : undefined,
            bytesText ? `大小：${bytesText}` : undefined,
            readNumber(details.width) && readNumber(details.height) ? `分辨率：${details.width}x${details.height}` : undefined,
            readString(details.path) ? `路径：${readString(details.path)}` : undefined,
          ]),
          durationMs: readNumber(details.saveDurationMs),
          metadata: stringifyMetadata(details, ['outputIndex', 'bytes', 'mimeType', 'width', 'height']),
        });
      case 'done':
        return buildProgressEvent({
          id: 'runtime:image',
          source,
          event: eventName,
          label: '图片运行时',
          status: 'completed',
          detail: compactDetail([
            formatDurationMs(details.totalDurationMs) ? `总耗时：${formatDurationMs(details.totalDurationMs)}` : undefined,
            readNumber(details.outputImages) ? `输出：${details.outputImages} 张` : undefined,
          ]),
          durationMs: readNumber(details.totalDurationMs),
          metadata: stringifyMetadata(details, ['provider', 'model', 'outputImages']),
        });
      case 'failed':
        return buildProgressEvent({
          id: 'runtime:image',
          source,
          event: eventName,
          label: '图片运行时',
          status: 'error',
          detail: compactDetail([
            durationText ? `耗时：${durationText}` : undefined,
            readString(details.error) ? `错误：${readString(details.error)}` : undefined,
          ]),
          durationMs,
        });
      default:
        return null;
    }
  }

  switch (eventName) {
    case 'request_start':
      return buildProgressEvent({
        id: `plugin:${requestId}:request`,
        source,
        event: eventName,
        label: '请求图片后台',
        status: 'running',
        detail: compactDetail([
          model ? `模型：${model}` : undefined,
          size ? `尺寸：${size}` : undefined,
          quality ? `质量：${quality}` : undefined,
          readString(details.mode) ? `模式：${readString(details.mode)}` : undefined,
        ]),
        metadata: stringifyMetadata(details, ['mode', 'model', 'size', 'quality', 'count', 'inputImageCount']),
      });
    case 'response_headers':
      return buildProgressEvent({
        id: `plugin:${requestId}:headers`,
        source,
        event: eventName,
        label: '后台开始响应',
        status: statusCode && statusCode >= 400 ? 'error' : 'completed',
        detail: compactDetail([
          statusCode ? `HTTP：${statusCode}` : undefined,
          durationText ? `耗时：${durationText}` : undefined,
        ]),
        durationMs,
        metadata: stringifyMetadata(details, ['status']),
      });
    case 'response_json_parsed':
      return buildProgressEvent({
        id: `plugin:${requestId}:json`,
        source,
        event: eventName,
        label: '解析后台响应',
        status: 'completed',
        detail: compactDetail([
          durationText ? `耗时：${durationText}` : undefined,
          readNumber(details.responseItems) ? `响应项：${details.responseItems}` : undefined,
        ]),
        durationMs,
        metadata: stringifyMetadata(details, ['responseItems']),
      });
    case 'image_url_fetch_start':
      return buildProgressEvent({
        id: `plugin:${requestId}:download:${index}`,
        source,
        event: eventName,
        label: '下载生成图片',
        status: 'running',
        detail: compactDetail([host ? `Host：${host}` : undefined]),
        metadata: host ? { host } : undefined,
      });
    case 'image_url_fetch_done':
      return buildProgressEvent({
        id: `plugin:${requestId}:download:${index}`,
        source,
        event: eventName,
        label: '下载生成图片',
        status: 'completed',
        detail: compactDetail([
          durationText ? `耗时：${durationText}` : undefined,
          bytesText ? `大小：${bytesText}` : undefined,
          statusCode ? `HTTP：${statusCode}` : undefined,
        ]),
        durationMs,
        metadata: stringifyMetadata(details, ['status', 'bytes', 'mimeType']),
      });
    case 'image_url_fetch_failed':
    case 'request_failed':
      return buildProgressEvent({
        id: eventName === 'request_failed' ? `plugin:${requestId}:request` : `plugin:${requestId}:download:${index}`,
        source,
        event: eventName,
        label: eventName === 'request_failed' ? '请求图片后台' : '下载生成图片',
        status: 'error',
        detail: compactDetail([
          durationText ? `耗时：${durationText}` : undefined,
          readString(details.error) ? `错误：${readString(details.error)}` : undefined,
        ]),
        durationMs,
      });
    case 'image_payload_decoded':
      return buildProgressEvent({
        id: `plugin:${requestId}:decode:${index}`,
        source,
        event: eventName,
        label: '解码图片数据',
        status: 'completed',
        detail: compactDetail([
          durationText ? `耗时：${durationText}` : undefined,
          bytesText ? `大小：${bytesText}` : undefined,
          readString(details.source) ? `来源：${readString(details.source)}` : undefined,
        ]),
        durationMs,
        metadata: stringifyMetadata(details, ['source', 'bytes', 'mimeType']),
      });
    case 'images_parsed':
      return buildProgressEvent({
        id: `plugin:${requestId}:images`,
        source,
        event: eventName,
        label: '整理图片响应',
        status: 'completed',
        detail: compactDetail([
          durationText ? `耗时：${durationText}` : undefined,
          readNumber(details.outputImages) ? `输出：${details.outputImages} 张` : undefined,
        ]),
        durationMs,
        metadata: stringifyMetadata(details, ['responseItems', 'outputImages']),
      });
    case 'request_done':
      return buildProgressEvent({
        id: `plugin:${requestId}:request`,
        source,
        event: eventName,
        label: '请求图片后台',
        status: 'completed',
        detail: compactDetail([
          formatDurationMs(details.totalDurationMs) ? `总耗时：${formatDurationMs(details.totalDurationMs)}` : undefined,
          readNumber(details.outputImages) ? `输出：${details.outputImages} 张` : undefined,
        ]),
        durationMs: readNumber(details.totalDurationMs),
        metadata: stringifyMetadata(details, ['mode', 'outputImages']),
      });
    default:
      return null;
  }
}

function compactJobHistory(): boolean {
  let changed = false;
  const expirationCutoff = Date.now() - TERMINAL_JOB_RETENTION_MS;
  for (const job of jobs.values()) {
    if (isTerminalJob(job) && job.updatedAt < expirationCutoff) {
      removeJobFromHistory(job);
      changed = true;
    }
  }
  if (jobs.size <= MAX_JOB_HISTORY) return changed;
  const removable = [...jobs.values()]
    .filter((job) => isTerminalJob(job) && job.recoverable !== true)
    .sort((a, b) => a.updatedAt - b.updatedAt);
  for (const job of removable) {
    if (jobs.size <= MAX_JOB_HISTORY) break;
    removeJobFromHistory(job);
    changed = true;
  }
  return changed;
}

function removeJobFromHistory(job: InternalMediaGenerationJob): void {
  jobs.delete(job.id);
  activeDeliveryRetryJobIds.delete(job.id);
  if (job.clientRequestId && jobIdByClientRequest.get(job.clientRequestId) === job.id) {
    jobIdByClientRequest.delete(job.clientRequestId);
  }
}

function markJobCancelled(job: InternalMediaGenerationJob): void {
  if (job.status === 'cancelled') return;
  const now = Date.now();
  job.cancelRequested = true;
  job.status = 'cancelled';
  job.updatedAt = now;
  job.completedAt = now;
  job.error = undefined;
  job.deliveryStatus = 'skipped';
  job.deliveryError = undefined;
  job.recoverable = false;
  recordJobProgress(job, {
    id: 'job:cancelled',
    event: 'cancelled',
    label: job.kind === 'image' ? '图片任务已停止' : '视频任务已停止',
    status: 'completed',
    timestampMs: now,
    durationMs: job.startedAt ? now - job.startedAt : undefined,
  });
  logger.info('[media-generation] job_cancelled', {
    jobId: job.id,
    kind: job.kind,
    sessionKey: job.sessionKey,
    previousQueueWaitMs: job.startedAt ? job.startedAt - job.createdAt : undefined,
    runDurationMs: job.startedAt ? now - job.startedAt : undefined,
  });
  scheduleJobJournalPersist(true);
}

function markJobFailed(job: InternalMediaGenerationJob, error: string): void {
  const now = Date.now();
  logger.warn(`[media-generation] ${job.kind} job ${job.id} failed: ${truncateText(error, MAX_JOB_ERROR_CHARS)}`);
  logger.warn('[media-generation] job_failed', {
    jobId: job.id,
    kind: job.kind,
    sessionKey: job.sessionKey,
    ...(job.payload.kind === 'image' && job.payload.batchTotal
      ? { batchIndex: job.payload.batchIndex, batchTotal: job.payload.batchTotal }
      : {}),
    queueWaitMs: job.startedAt ? job.startedAt - job.createdAt : undefined,
    runDurationMs: job.startedAt ? now - job.startedAt : undefined,
  });
  job.status = 'failed';
  job.updatedAt = now;
  job.completedAt = now;
  job.error = normalizeUserFacingMediaGenerationError(job.kind, error);
  job.deliveryStatus = 'skipped';
  job.deliveryError = undefined;
  job.recoverable = false;
  recordJobProgress(job, {
    id: 'job:failed',
    event: 'failed',
    label: job.kind === 'image' ? '图片任务失败' : '视频任务失败',
    status: 'error',
    timestampMs: now,
    detail: job.error,
    durationMs: job.startedAt ? now - job.startedAt : undefined,
    metadata: {
      queueWaitMs: job.startedAt ? job.startedAt - job.createdAt : undefined,
      runDurationMs: job.startedAt ? now - job.startedAt : undefined,
    },
  });
  scheduleJobJournalPersist(true);
}

function markJobSucceeded(job: InternalMediaGenerationJob): void {
  const completedAt = Date.now();
  const outputCount = job.outputs?.length ?? 0;
  job.status = 'succeeded';
  job.updatedAt = completedAt;
  job.completedAt = completedAt;
  job.error = undefined;
  recordJobProgress(job, {
    id: 'job:started',
    event: 'completed',
    label: job.kind === 'image' ? '图片任务执行完成' : '视频任务执行完成',
    status: 'completed',
    timestampMs: completedAt,
    detail: `执行：${formatDurationMs(job.startedAt ? completedAt - job.startedAt : undefined) ?? '0ms'}，产物：${outputCount}`,
    durationMs: job.startedAt ? completedAt - job.startedAt : undefined,
    metadata: {
      queueWaitMs: job.startedAt ? job.startedAt - job.createdAt : undefined,
      runDurationMs: job.startedAt ? completedAt - job.startedAt : undefined,
      outputs: outputCount,
    },
  });
  logger.info('[media-generation] job_succeeded', {
    jobId: job.id,
    kind: job.kind,
    sessionKey: job.sessionKey,
    ...(job.payload.kind === 'image' && job.payload.batchTotal
      ? { batchIndex: job.payload.batchIndex, batchTotal: job.payload.batchTotal }
      : {}),
    queueWaitMs: job.startedAt ? job.startedAt - job.createdAt : undefined,
    runDurationMs: job.startedAt ? completedAt - job.startedAt : undefined,
    outputs: outputCount,
  });
  scheduleJobJournalPersist(true);
}

function markDeliverySucceeded(job: InternalMediaGenerationJob): void {
  if (job.cancelRequested || job.status === 'cancelled') return;
  const now = Date.now();
  job.updatedAt = now;
  job.deliveryStatus = 'succeeded';
  job.deliveryError = undefined;
  job.recoverable = false;
  recordJobProgress(job, {
    id: 'job:delivery',
    event: 'delivery_completed',
    label: '写入会话历史',
    status: 'completed',
    timestampMs: now,
  });
  scheduleJobJournalPersist(true);
}

function markDeliveryFailed(job: InternalMediaGenerationJob, error: string): void {
  const now = Date.now();
  job.updatedAt = now;
  const deliveryError = truncateText(error, MAX_JOB_ERROR_CHARS);
  job.deliveryStatus = 'failed';
  job.deliveryError = deliveryError;
  job.recoverable = true;
  recordJobProgress(job, {
    id: 'job:delivery',
    event: 'delivery_failed',
    label: '产物已生成，历史同步待恢复',
    status: 'error',
    timestampMs: now,
    detail: deliveryError,
  });
  logger.warn('[media-generation] delivery_failed', {
    jobId: job.id,
    kind: job.kind,
    sessionKey: job.sessionKey,
    error: deliveryError,
  });
  scheduleJobJournalPersist(true);
}

async function retryCompletedConversationDelivery(job: InternalMediaGenerationJob): Promise<void> {
  if (activeDeliveryRetryJobIds.has(job.id)) return;
  activeDeliveryRetryJobIds.add(job.id);
  try {
    for (const delayMs of [500, 1500, 4000]) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      if (
        job.cancelRequested
        || job.status !== 'succeeded'
        || (job.deliveryStatus !== 'pending' && job.deliveryStatus !== 'failed')
      ) return;
      try {
        await appendCompletedConversation(job);
        markDeliverySucceeded(job);
        return;
      } catch (error) {
        markDeliveryFailed(job, error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    activeDeliveryRetryJobIds.delete(job.id);
  }
}

function chunkToText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return String(data);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function isUpstreamMediaGenerationError(error: string): boolean {
  const normalized = error.toLowerCase();
  return normalized.includes('providerhttperror')
    || normalized.includes('uclaw openai image generation failed')
    || normalized.includes('uclaw openai image edit failed')
    || normalized.includes('upstream')
    || normalized.includes('rate_limit')
    || normalized.includes('rate limit')
    || normalized.includes('http 429')
    || normalized.includes('http 5');
}

function normalizeUserFacingMediaGenerationError(kind: MediaGenerationKind, error: string): string {
  if (isUpstreamMediaGenerationError(error)) {
    return USER_FACING_UPSTREAM_MEDIA_ERROR[kind];
  }
  return truncateText(error, MAX_JOB_ERROR_CHARS);
}

function normalizeCapturedText(text: string): string {
  return text.replace(/\0/g, '').trim();
}

function createBoundedOutputCapture(maxChars: number) {
  let text = '';
  let omittedChars = 0;

  return {
    append(data: unknown): void {
      const chunk = chunkToText(data);
      if (!chunk) return;
      const overflow = text.length + chunk.length - maxChars;
      if (overflow <= 0) {
        text += chunk;
        return;
      }

      omittedChars += overflow;
      text = chunk.length >= maxChars
        ? chunk.slice(-maxChars)
        : `${text}${chunk}`.slice(-maxChars);
    },
    format(label: string): string | null {
      const normalized = normalizeCapturedText(text);
      if (!normalized) return null;
      const suffix = omittedChars > 0
        ? ` (last ${maxChars} chars; truncated ${omittedChars} chars)`
        : '';
      return `${label}${suffix}:\n${normalized}`;
    },
  };
}

function formatWorkerLogChunk(data: unknown): string {
  return truncateText(normalizeCapturedText(chunkToText(data)), MAX_WORKER_LOG_CHARS);
}

function parseStructuredWorkerLogLine(line: string): {
  source: 'worker' | 'runtime' | 'plugin';
  eventName: string;
  details: Record<string, unknown>;
} | null {
  const normalized = line.trim();
  const match = normalized.match(/^\[(media-generation-worker|openclaw-image-runtime|clawx-openai-image)\]\s+([a-z0-9_]+)\s+(\{.*\})$/iu);
  if (!match) return null;
  const source = match[1] === 'media-generation-worker'
    ? 'worker'
    : match[1] === 'openclaw-image-runtime'
      ? 'runtime'
      : 'plugin';
  try {
    const details = JSON.parse(match[3] ?? '{}');
    const record = asRecord(details);
    if (!record) return null;
    return {
      source,
      eventName: match[2] ?? 'unknown',
      details: record,
    };
  } catch {
    return null;
  }
}

function recordStructuredWorkerProgress(job: InternalMediaGenerationJob, data: unknown): void {
  const text = chunkToText(data);
  if (!text.trim()) return;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseStructuredWorkerLogLine(line);
    if (!parsed) continue;
    const progress = progressForStructuredWorkerEvent(job, parsed.source, parsed.eventName, parsed.details);
    if (progress) {
      upsertProgressEvent(job, progress);
    }
  }
}

function appendWorkerOutputToError(
  error: string,
  output: {
    stdout: ReturnType<typeof createBoundedOutputCapture>;
    stderr: ReturnType<typeof createBoundedOutputCapture>;
  },
): string {
  const sections = [error || 'Media generation failed'];
  const stderr = output.stderr.format('Worker stderr');
  if (stderr) sections.push(stderr);
  const stdout = output.stdout.format('Worker stdout');
  if (stdout) sections.push(stdout);
  return truncateText(sections.join('\n\n'), MAX_JOB_ERROR_CHARS);
}

function getOutputLocations(result: unknown): string[] {
  return getOutputs(result)
    .map((output) => {
      return typeof output.path === 'string' && output.path.trim()
        ? output.path.trim()
        : (typeof output.url === 'string' && output.url.trim() ? output.url.trim() : '');
    })
    .filter(Boolean);
}

function getOutputs(result: unknown): MediaGenerationJobOutput[] {
  const outputs = typeof result === 'object' && result !== null && Array.isArray((result as { outputs?: unknown }).outputs)
    ? (result as { outputs: unknown[] }).outputs
    : [];
  return outputs
    .filter((output): output is Record<string, unknown> => Boolean(output && typeof output === 'object'))
    .map((output) => ({ ...output } as MediaGenerationJobOutput));
}

async function hydrateLocalOutputSizes(outputs: MediaGenerationJobOutput[]): Promise<MediaGenerationJobOutput[]> {
  return await Promise.all(outputs.map(async (output) => {
    if (typeof output.size === 'number' && Number.isFinite(output.size) && output.size > 0) {
      return output;
    }
    const filePath = typeof output.path === 'string' && output.path.trim() ? output.path.trim() : '';
    if (!filePath) return output;
    try {
      const stat = await fsP.stat(filePath);
      return stat.isFile() && stat.size > 0 ? { ...output, size: stat.size } : output;
    } catch {
      return output;
    }
  }));
}

function getOutputFiles(result: unknown, hydratedOutputs?: MediaGenerationJobOutput[]): Array<{
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  filePath?: string;
  gatewayUrl?: string;
  source?: 'tool-result';
}> {
  return (hydratedOutputs ?? getOutputs(result)).flatMap((record) => {
    const filePath = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    const gatewayUrl = typeof record.url === 'string' && record.url.trim() ? record.url.trim() : undefined;
    if (!filePath && !gatewayUrl) return [];
    return [{
      ...(typeof record.fileName === 'string' && record.fileName.trim() ? { fileName: record.fileName.trim() } : {}),
      ...(typeof record.mimeType === 'string' && record.mimeType.trim() ? { mimeType: record.mimeType.trim() } : {}),
      ...(typeof record.size === 'number' && Number.isFinite(record.size) && record.size > 0
        ? { fileSize: Math.floor(record.size) }
        : {}),
      ...(typeof record.width === 'number' && Number.isFinite(record.width) && record.width > 0
        ? { width: Math.floor(record.width) }
        : {}),
      ...(typeof record.height === 'number' && Number.isFinite(record.height) && record.height > 0
        ? { height: Math.floor(record.height) }
        : {}),
      ...(filePath ? { filePath } : {}),
      ...(gatewayUrl ? { gatewayUrl } : {}),
      source: 'tool-result' as const,
    }];
  });
}

async function appendCompletedConversation(job: InternalMediaGenerationJob): Promise<void> {
  const outputPaths = getOutputLocations(job.result);
  if (outputPaths.length === 0) {
    throw new Error('Media generation completed without output paths');
  }
  const outputFiles = getOutputFiles(job.result, job.outputs);

  if (job.payload.suppressConversationAppend === true) {
    return;
  }

  const inputPaths = (job.payload.inputImages ?? []).map((image) => image.filePath);
  const userInputPaths = (job.payload.userInputImages ?? job.payload.inputImages ?? []).map((image) => image.filePath);
  if (job.payload.kind === 'image') {
    await appendImageGenerationConversation({
      sessionKey: job.payload.sessionKey,
      prompt: job.payload.originalPrompt || job.payload.prompt,
      outputPaths,
      outputFiles,
      inputPaths: userInputPaths,
      summaryText: inputPaths.length > 0 ? '图片已修改。' : '图片已生成。',
      userTimestampMs: job.payload.userMessageTimestampMs,
      assistantMessageId: `media-result:${job.id}`,
      assistantResultKind: 'image',
      shouldAbort: () => job.cancelRequested === true || job.status === 'cancelled',
      mediaGenerationSnapshot: cloneSnapshot(job),
    });
    return;
  }

  await appendImageGenerationConversation({
    sessionKey: job.payload.sessionKey,
    prompt: job.payload.originalPrompt || job.payload.prompt,
    outputPaths,
    outputFiles,
    inputPaths: userInputPaths,
    summaryText: job.payload.route?.mode === 'edit_image_then_video'
      ? '已先修改参考图并生成视频。'
      : (inputPaths.length > 0 ? '已基于参考图生成视频。' : '视频已生成。'),
    userTimestampMs: job.payload.userMessageTimestampMs,
    assistantMessageId: `media-result:${job.id}`,
    assistantResultKind: 'video',
    shouldAbort: () => job.cancelRequested === true || job.status === 'cancelled',
    mediaGenerationSnapshot: cloneSnapshot(job),
  });
}

async function runJob(job: InternalMediaGenerationJob): Promise<void> {
  if (job.cancelRequested || job.status === 'cancelled') return;
  activeJobIds[job.kind].add(job.id);
  const now = Date.now();
  job.status = 'running';
  job.startedAt = now;
  job.updatedAt = now;
  recordJobProgress(job, {
    id: 'job:queued',
    event: 'queue_completed',
    label: '队列等待',
    status: 'completed',
    timestampMs: now,
    detail: `等待：${formatDurationMs(now - job.createdAt) ?? '0ms'}，并发：${activeJobIds[job.kind].size}/${MEDIA_GENERATION_CONCURRENCY[job.kind]}`,
    durationMs: now - job.createdAt,
    metadata: {
      queueWaitMs: now - job.createdAt,
      activeJobs: activeJobIds[job.kind].size,
      maxActiveJobs: MEDIA_GENERATION_CONCURRENCY[job.kind],
    },
  });
  recordJobProgress(job, {
    id: 'job:started',
    event: 'started',
    label: job.kind === 'image' ? '开始图片任务' : '开始视频任务',
    status: 'running',
    timestampMs: now,
    detail: `并发：${activeJobIds[job.kind].size}/${MEDIA_GENERATION_CONCURRENCY[job.kind]}`,
    metadata: {
      activeJobs: activeJobIds[job.kind].size,
      maxActiveJobs: MEDIA_GENERATION_CONCURRENCY[job.kind],
    },
  });
  logger.info('[media-generation] job_started', {
    jobId: job.id,
    kind: job.kind,
    sessionKey: job.sessionKey,
    ...(job.payload.kind === 'image' && job.payload.batchTotal
      ? { batchIndex: job.payload.batchIndex, batchTotal: job.payload.batchTotal }
      : {}),
    queueWaitMs: now - job.createdAt,
    activeJobs: activeJobIds[job.kind].size,
    queuedJobs: queues[job.kind].length,
    maxActiveJobs: MEDIA_GENERATION_CONCURRENCY[job.kind],
  });
  scheduleJobJournalPersist(true);

  const prepareStartedAt = Date.now();
  recordJobProgress(job, {
    id: 'job:prepare',
    event: 'prepare_started',
    label: '媒体运行时准备',
    status: 'running',
    timestampMs: prepareStartedAt,
    detail: job.kind === 'image' ? '同步图片生成运行时配置。' : '同步视频生成运行时配置。',
  });
  try {
    await prepareMediaGenerationJob(job.payload);
    if (job.cancelRequested) {
      activeJobIds[job.kind].delete(job.id);
      return;
    }
    const preparedAt = Date.now();
    recordJobProgress(job, {
      id: 'job:prepare',
      event: 'prepare_completed',
      label: '媒体运行时准备',
      status: 'completed',
      timestampMs: preparedAt,
      detail: `耗时：${formatDurationMs(preparedAt - prepareStartedAt) ?? '0ms'}`,
      durationMs: preparedAt - prepareStartedAt,
    });
  } catch (error) {
    if (job.cancelRequested) {
      activeJobIds[job.kind].delete(job.id);
      return;
    }
    markJobFailed(job, error instanceof Error ? error.message : String(error));
    activeJobIds[job.kind].delete(job.id);
    return;
  }

  const wrapperPath = getMediaWorkerWrapperPath();
  const entryPath = getMediaWorkerEntryPath();
  if (!existsSync(wrapperPath)) {
    markJobFailed(job, `Media generation worker wrapper not found at ${wrapperPath}`);
    activeJobIds[job.kind].delete(job.id);
    return;
  }
  if (!existsSync(entryPath)) {
    markJobFailed(job, `Media generation worker entry not found at ${entryPath}`);
    activeJobIds[job.kind].delete(job.id);
    return;
  }

  await new Promise<void>((resolve) => {
    const workerOutput = {
      stdout: createBoundedOutputCapture(MAX_WORKER_OUTPUT_CHARS),
      stderr: createBoundedOutputCapture(MAX_WORKER_OUTPUT_CHARS),
    };
    const child = utilityProcess.fork(wrapperPath, [], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: {
        ...process.env,
        CLAWX_MEDIA_GENERATION_WORKER_ENTRY: entryPath,
        CLAWX_OPENCLAW_DIR: getOpenClawDir(),
        [getElectronStoreUserDataEnvKey()]: app.getPath('userData'),
      } as NodeJS.ProcessEnv,
      serviceName: 'UClaw Media Generation',
    });
    job.worker = child;

    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const finish = async (response: MediaGenerationWorkerResponse): Promise<void> => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      try {
        child.kill();
      } catch {
        // ignore
      }
      job.worker = undefined;

      if (job.cancelRequested) {
        markJobCancelled(job);
        resolve();
        return;
      }

      if (!response.success) {
        markJobFailed(job, appendWorkerOutputToError(
          response.error || 'Media generation failed',
          workerOutput,
        ));
        resolve();
        return;
      }

      job.result = response.result;
      job.outputs = await hydrateLocalOutputSizes(getOutputs(response.result));
      if (job.cancelRequested || job.status === 'cancelled') {
        markJobCancelled(job);
        resolve();
        return;
      }
      if (getOutputLocations(job.result).length === 0) {
        markJobFailed(job, 'Media generation completed without output paths');
        resolve();
        return;
      }
      const missingLocalOutput = job.outputs.some((output) => (
        typeof output.path === 'string'
        && output.path.trim().length > 0
        && !(typeof output.size === 'number' && Number.isFinite(output.size) && output.size > 0)
      ));
      if (missingLocalOutput) {
        markJobFailed(job, 'Media generation returned a local output path that is not readable');
        resolve();
        return;
      }

      markJobSucceeded(job);
      if (job.cancelRequested) {
        markJobCancelled(job);
        resolve();
        return;
      }
      if (job.payload.suppressConversationAppend === true) {
        job.deliveryStatus = 'skipped';
        job.deliveryError = undefined;
        job.recoverable = false;
        scheduleJobJournalPersist(true);
        resolve();
        return;
      }

      recordJobProgress(job, {
        id: 'job:delivery',
        event: 'delivery_started',
        label: '写入会话历史',
        status: 'running',
        timestampMs: Date.now(),
      });
      try {
        await appendCompletedConversation(job);
        markDeliverySucceeded(job);
      } catch (error) {
        markDeliveryFailed(job, error instanceof Error ? error.message : String(error));
        void retryCompletedConversationDelivery(job);
      }
      resolve();
    };

    child.on('spawn', () => {
      if (job.cancelRequested || job.status === 'cancelled') {
        try {
          child.kill();
        } catch {
          // ignore
        }
        return;
      }
      child.postMessage({
        type: 'run',
        jobId: job.id,
        payload: job.payload,
      } satisfies MediaGenerationWorkerRequest);
    });

    child.on('message', (message: MediaGenerationWorkerResponse) => {
      if (message?.type !== 'result' || message.jobId !== job.id) {
        return;
      }
      void finish(message);
    });

    child.on('exit', (code: number | null) => {
      if (settled) return;
      if (watchdog) clearTimeout(watchdog);
      job.worker = undefined;
      if (job.cancelRequested || job.status === 'cancelled') {
        markJobCancelled(job);
        settled = true;
        resolve();
        return;
      }
      markJobFailed(job, appendWorkerOutputToError(
        `Media generation worker exited before completion (code=${code})`,
        workerOutput,
      ));
      settled = true;
      resolve();
    });

    child.on('error', (...args: unknown[]) => {
      if (settled) return;
      if (watchdog) clearTimeout(watchdog);
      job.worker = undefined;
      if (job.cancelRequested || job.status === 'cancelled') {
        markJobCancelled(job);
        settled = true;
        resolve();
        return;
      }
      markJobFailed(job, appendWorkerOutputToError(
        `Media generation worker error: ${args.map((arg) => arg instanceof Error ? arg.message : String(arg)).join(' ')}`,
        workerOutput,
      ));
      settled = true;
      resolve();
    });

    child.stdout?.on('data', (data) => {
      workerOutput.stdout.append(data);
    });

    child.stderr?.on('data', (data) => {
      workerOutput.stderr.append(data);
      recordStructuredWorkerProgress(job, data);
      const line = formatWorkerLogChunk(data);
      if (line) {
        logger.warn(`[media-generation-worker] ${line}`);
      }
    });

    watchdog = setTimeout(() => {
      void finish({
        type: 'result',
        jobId: job.id,
        success: false,
        error: `${job.kind} generation worker exceeded ${MEDIA_GENERATION_WATCHDOG_MS[job.kind]}ms watchdog`,
      });
    }, MEDIA_GENERATION_WATCHDOG_MS[job.kind]);
  });

  activeJobIds[job.kind].delete(job.id);
}

function pumpQueue(kind: MediaGenerationKind): void {
  const activeJobs = activeJobIds[kind];
  const maxActiveJobs = MEDIA_GENERATION_CONCURRENCY[kind];
  while (activeJobs.size < maxActiveJobs) {
    const nextJobId = queues[kind].shift();
    if (!nextJobId) return;
    const job = jobs.get(nextJobId);
    if (!job || job.status !== 'queued') {
      continue;
    }
    void runJob(job)
      .catch((error) => {
        activeJobIds[kind].delete(job.id);
        markJobFailed(job, error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (compactJobHistory()) scheduleJobJournalPersist(true);
        setImmediate(() => pumpQueue(kind));
      });
  }
}

export function enqueueMediaGenerationJobWithResult(
  payload: MediaGenerationJobPayload,
): MediaGenerationJobEnqueueResult {
  ensureJobJournalInitialized();
  const clientRequestId = payload.clientRequestId?.trim();
  if (clientRequestId) {
    const existingJobId = jobIdByClientRequest.get(clientRequestId);
    const existingJob = existingJobId ? jobs.get(existingJobId) : undefined;
    if (existingJob) {
      return { job: cloneSnapshot(existingJob), idempotent: true };
    }
    jobIdByClientRequest.delete(clientRequestId);
  }
  const normalizedPayload = {
    ...payload,
    ...(clientRequestId ? { clientRequestId } : {}),
  } as MediaGenerationJobPayload;
  const now = Date.now();
  const job: InternalMediaGenerationJob = {
    id: randomUUID(),
    kind: normalizedPayload.kind,
    sessionKey: normalizedPayload.sessionKey,
    ...(clientRequestId ? { clientRequestId } : {}),
    ...(normalizedPayload.runId ? { runId: normalizedPayload.runId } : {}),
    ownerKind: normalizedPayload.suppressConversationAppend === true ? 'composite' : 'standalone',
    status: 'queued',
    deliveryStatus: 'pending',
    createdAt: now,
    updatedAt: now,
    payload: normalizedPayload,
    progressEvents: [{
      id: 'job:queued',
      source: 'job',
      event: 'queued',
      label: '队列等待',
      status: 'running',
      timestampMs: now,
      detail: `排队位置：${queues[normalizedPayload.kind].length + 1}，并发：${activeJobIds[normalizedPayload.kind].size}/${MEDIA_GENERATION_CONCURRENCY[normalizedPayload.kind]}`,
      metadata: {
        queuePosition: queues[normalizedPayload.kind].length + 1,
        activeJobs: activeJobIds[normalizedPayload.kind].size,
        maxActiveJobs: MEDIA_GENERATION_CONCURRENCY[normalizedPayload.kind],
      },
    }],
  };
  jobs.set(job.id, job);
  if (clientRequestId) jobIdByClientRequest.set(clientRequestId, job.id);
  queues[normalizedPayload.kind].push(job.id);
  logger.info('[media-generation] job_enqueued', {
    jobId: job.id,
    kind: job.kind,
    sessionKey: job.sessionKey,
    ...(normalizedPayload.kind === 'image' && normalizedPayload.batchTotal
      ? { batchIndex: normalizedPayload.batchIndex, batchTotal: normalizedPayload.batchTotal }
      : {}),
    queuePosition: queues[normalizedPayload.kind].length,
    activeJobs: activeJobIds[normalizedPayload.kind].size,
    maxActiveJobs: MEDIA_GENERATION_CONCURRENCY[normalizedPayload.kind],
  });
  scheduleJobJournalPersist(true);
  setImmediate(() => pumpQueue(normalizedPayload.kind));
  return { job: cloneSnapshot(job), idempotent: false };
}

export function enqueueMediaGenerationJob(payload: MediaGenerationJobPayload): MediaGenerationJobSnapshot {
  return enqueueMediaGenerationJobWithResult(payload).job;
}

export function getMediaGenerationJob(jobId: string): MediaGenerationJobSnapshot | null {
  ensureJobJournalInitialized();
  const job = jobs.get(jobId);
  return job ? cloneSnapshot(job) : null;
}

export function getMediaGenerationJobsForSession(
  sessionKey: string,
  options: { activeOnly?: boolean } = {},
): MediaGenerationJobSnapshot[] {
  ensureJobJournalInitialized();
  return [...jobs.values()]
    .filter((job) => job.sessionKey === sessionKey)
    // The renderer uses activeOnly for recovery discovery, so actionable
    // restart/delivery failures must remain visible even after becoming terminal.
    .filter((job) => !options.activeOnly || (
      job.status === 'queued'
      || job.status === 'running'
      || (job.status === 'succeeded' && job.deliveryStatus === 'pending')
      || job.recoverable === true
    ))
    .sort((left, right) => left.createdAt - right.createdAt)
    .map(cloneSnapshot);
}

export function cancelMediaGenerationJobWithResult(jobId: string): MediaGenerationJobCancelResult {
  ensureJobJournalInitialized();
  const job = jobs.get(jobId);
  if (!job) return { outcome: 'not_found' };
  if (job.status === 'cancelled') return { outcome: 'already_cancelled', job: cloneSnapshot(job) };
  if (job.status === 'failed' || (job.status === 'succeeded' && job.deliveryStatus !== 'pending')) {
    return { outcome: 'already_terminal', job: cloneSnapshot(job) };
  }

  const wasQueued = job.status === 'queued';
  job.cancelRequested = true;
  const queue = queues[job.kind];
  const queueIndex = queue.indexOf(job.id);
  if (queueIndex >= 0) queue.splice(queueIndex, 1);
  markJobCancelled(job);
  try {
    job.worker?.kill();
  } catch {
    // ignore
  }
  job.worker = undefined;
  if (wasQueued) setImmediate(() => pumpQueue(job.kind));
  return { outcome: 'cancelled', job: cloneSnapshot(job) };
}

export function cancelMediaGenerationJob(jobId: string): boolean {
  return cancelMediaGenerationJobWithResult(jobId).outcome === 'cancelled';
}

export function retryMediaGenerationJobDelivery(jobId: string): MediaGenerationJobDeliveryRetryResult {
  ensureJobJournalInitialized();
  const job = jobs.get(jobId);
  if (!job) return { outcome: 'not_found' };
  if (activeDeliveryRetryJobIds.has(job.id) || job.deliveryStatus === 'pending') {
    return { outcome: 'already_in_progress', job: cloneSnapshot(job) };
  }
  if (
    job.ownerKind !== 'standalone'
    || job.status !== 'succeeded'
    || job.deliveryStatus !== 'failed'
  ) {
    return { outcome: 'not_retryable', job: cloneSnapshot(job) };
  }

  job.deliveryStatus = 'pending';
  job.deliveryError = undefined;
  job.recoverable = true;
  recordJobProgress(job, {
    id: 'job:delivery',
    event: 'manual_delivery_retry_started',
    label: '重新写入会话历史',
    status: 'running',
    timestampMs: Date.now(),
    detail: '仅重试已有产物的会话交付，不会重新请求媒体提供方。',
  });
  activeDeliveryRetryJobIds.add(job.id);
  scheduleJobJournalPersist(true);
  setImmediate(() => {
    void appendCompletedConversation(job)
      .then(() => markDeliverySucceeded(job))
      .catch((error) => markDeliveryFailed(job, error instanceof Error ? error.message : String(error)))
      .finally(() => activeDeliveryRetryJobIds.delete(job.id));
  });
  return { outcome: 'retry_started', job: cloneSnapshot(job) };
}

export function cancelMediaGenerationJobsForSession(sessionKey: string): string[] {
  ensureJobJournalInitialized();
  const cancelledJobIds: string[] = [];
  for (const job of jobs.values()) {
    if (job.sessionKey !== sessionKey) continue;
    if (cancelMediaGenerationJob(job.id)) cancelledJobIds.push(job.id);
  }
  return cancelledJobIds;
}

export function cancelMediaGenerationJobsForRun(runId: string, sessionKey?: string): string[] {
  ensureJobJournalInitialized();
  const normalizedRunId = runId.trim();
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedRunId) return [];

  const cancelledJobIds: string[] = [];
  for (const job of jobs.values()) {
    if (job.runId !== normalizedRunId) continue;
    if (normalizedSessionKey && job.sessionKey !== normalizedSessionKey) continue;
    if (cancelMediaGenerationJob(job.id)) cancelledJobIds.push(job.id);
  }
  return cancelledJobIds;
}

export async function prepareMediaGenerationJob(payload: MediaGenerationJobPayload): Promise<void> {
  if (payload.kind === 'image') {
    await ensureManagedOpenAiImageRelay();
    return;
  }
  if (payload.route?.mode === 'edit_image_then_video') {
    await ensureManagedOpenAiImageRelay();
  }
  await ensureManagedOpenAiVideoRelay();
}

if (typeof app.whenReady === 'function') {
  void app.whenReady()
    .then(() => initializeJobJournal())
    .catch((error) => {
      logger.warn('[media-generation] unable to initialize job journal at startup', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
