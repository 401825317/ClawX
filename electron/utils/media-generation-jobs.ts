import { randomUUID } from 'node:crypto';
import { existsSync } from 'fs';
import path from 'node:path';
import { app, utilityProcess } from 'electron';
import { appendImageGenerationConversation } from './chat-session-image-message';
import { getElectronStoreUserDataEnvKey } from './electron-store-options';
import { logger } from './logger';
import type {
  MediaGenerationKind,
  MediaGenerationJobPayload,
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
};

const jobs = new Map<string, InternalMediaGenerationJob>();
const queues: Record<MediaGenerationKind, string[]> = {
  image: [],
  video: [],
};
const MAX_JOB_HISTORY = 50;
const MAX_WORKER_OUTPUT_CHARS = 4096;
const MAX_WORKER_LOG_CHARS = 1024;
const MAX_JOB_ERROR_CHARS = 12_000;
const MAX_JOB_PROGRESS_EVENTS = 80;
const USER_FACING_UPSTREAM_MEDIA_ERROR = '上游渠道报错，生成失败了，请稍后重试。';
const MEDIA_GENERATION_CONCURRENCY: Record<MediaGenerationKind, number> = {
  image: 5,
  video: 5,
};

const activeJobIds: Record<MediaGenerationKind, Set<string>> = {
  image: new Set<string>(),
  video: new Set<string>(),
};

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
  const { payload: _payload, ...snapshot } = job;
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

function compactJobHistory(): void {
  if (jobs.size <= MAX_JOB_HISTORY) return;
  const removable = [...jobs.values()]
    .filter((job) => job.status === 'succeeded' || job.status === 'failed')
    .sort((a, b) => a.updatedAt - b.updatedAt);
  for (const job of removable) {
    if (jobs.size <= MAX_JOB_HISTORY) break;
    jobs.delete(job.id);
  }
}

function markJobFailed(job: InternalMediaGenerationJob, error: string): void {
  const now = Date.now();
  logger.warn(`[media-generation] ${job.kind} job ${job.id} failed: ${truncateText(error, MAX_JOB_ERROR_CHARS)}`);
  logger.warn('[media-generation] job_failed', {
    jobId: job.id,
    kind: job.kind,
    sessionKey: job.sessionKey,
    queueWaitMs: job.startedAt ? job.startedAt - job.createdAt : undefined,
    runDurationMs: job.startedAt ? now - job.startedAt : undefined,
  });
  job.status = 'failed';
  job.updatedAt = now;
  job.completedAt = now;
  job.error = normalizeUserFacingMediaGenerationError(error);
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
    || normalized.includes('upstream')
    || normalized.includes('rate_limit')
    || normalized.includes('rate limit')
    || normalized.includes('http 429')
    || normalized.includes('http 5');
}

function normalizeUserFacingMediaGenerationError(error: string): string {
  if (isUpstreamMediaGenerationError(error)) {
    return USER_FACING_UPSTREAM_MEDIA_ERROR;
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
  const outputs = typeof result === 'object' && result !== null && Array.isArray((result as { outputs?: unknown }).outputs)
    ? (result as { outputs: unknown[] }).outputs
    : [];
  return outputs
    .map((output) => {
      if (!output || typeof output !== 'object') return '';
      const record = output as { path?: unknown; url?: unknown };
      return typeof record.path === 'string' && record.path.trim()
        ? record.path.trim()
        : (typeof record.url === 'string' && record.url.trim() ? record.url.trim() : '');
    })
    .filter(Boolean);
}

async function appendCompletedConversation(job: InternalMediaGenerationJob): Promise<void> {
  const outputPaths = getOutputLocations(job.result);
  if (outputPaths.length === 0) {
    throw new Error('Media generation completed without output paths');
  }

  const inputPaths = (job.payload.inputImages ?? []).map((image) => image.filePath);
  const userInputPaths = (job.payload.userInputImages ?? job.payload.inputImages ?? []).map((image) => image.filePath);
  if (job.payload.kind === 'image') {
    await appendImageGenerationConversation({
      sessionKey: job.payload.sessionKey,
      prompt: job.payload.originalPrompt || job.payload.prompt,
      outputPaths,
      inputPaths: userInputPaths,
      summaryText: inputPaths.length > 0 ? '图片已修改。' : '图片已生成。',
      userTimestampMs: job.payload.userMessageTimestampMs,
    });
    return;
  }

  await appendImageGenerationConversation({
    sessionKey: job.payload.sessionKey,
    prompt: job.payload.originalPrompt || job.payload.prompt,
    outputPaths,
    inputPaths: userInputPaths,
    summaryText: job.payload.route?.mode === 'edit_image_then_video'
      ? '已先修改参考图并生成视频。'
      : (inputPaths.length > 0 ? '已基于参考图生成视频。' : '视频已生成。'),
    userTimestampMs: job.payload.userMessageTimestampMs,
  });
}

async function runJob(job: InternalMediaGenerationJob): Promise<void> {
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
    queueWaitMs: now - job.createdAt,
    activeJobs: activeJobIds[job.kind].size,
    queuedJobs: queues[job.kind].length,
    maxActiveJobs: MEDIA_GENERATION_CONCURRENCY[job.kind],
  });

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

    let settled = false;
    const finish = async (response: MediaGenerationWorkerResponse): Promise<void> => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // ignore
      }

      if (!response.success) {
        markJobFailed(job, appendWorkerOutputToError(
          response.error || 'Media generation failed',
          workerOutput,
        ));
        resolve();
        return;
      }

      try {
        job.result = response.result;
        await appendCompletedConversation(job);
        const completedAt = Date.now();
        job.status = 'succeeded';
        job.updatedAt = completedAt;
        job.completedAt = completedAt;
        recordJobProgress(job, {
          id: 'job:started',
          event: 'completed',
          label: job.kind === 'image' ? '图片任务执行完成' : '视频任务执行完成',
          status: 'completed',
          timestampMs: completedAt,
          detail: `执行：${formatDurationMs(job.startedAt ? completedAt - job.startedAt : undefined) ?? '0ms'}，产物：${getOutputLocations(job.result).length}`,
          durationMs: job.startedAt ? completedAt - job.startedAt : undefined,
          metadata: {
            queueWaitMs: job.startedAt ? job.startedAt - job.createdAt : undefined,
            runDurationMs: job.startedAt ? completedAt - job.startedAt : undefined,
            outputs: getOutputLocations(job.result).length,
          },
        });
        logger.info('[media-generation] job_succeeded', {
          jobId: job.id,
          kind: job.kind,
          sessionKey: job.sessionKey,
          queueWaitMs: job.startedAt ? job.startedAt - job.createdAt : undefined,
          runDurationMs: job.startedAt ? completedAt - job.startedAt : undefined,
          outputs: getOutputLocations(job.result).length,
        });
      } catch (error) {
        markJobFailed(job, error instanceof Error ? error.message : String(error));
      }
      resolve();
    };

    child.on('spawn', () => {
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
      markJobFailed(job, appendWorkerOutputToError(
        `Media generation worker exited before completion (code=${code})`,
        workerOutput,
      ));
      settled = true;
      resolve();
    });

    child.on('error', (...args: unknown[]) => {
      if (settled) return;
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
        compactJobHistory();
        setImmediate(() => pumpQueue(kind));
      });
  }
}

export function enqueueMediaGenerationJob(payload: MediaGenerationJobPayload): MediaGenerationJobSnapshot {
  const now = Date.now();
  const job: InternalMediaGenerationJob = {
    id: randomUUID(),
    kind: payload.kind,
    sessionKey: payload.sessionKey,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    payload,
    progressEvents: [{
      id: 'job:queued',
      source: 'job',
      event: 'queued',
      label: '队列等待',
      status: 'running',
      timestampMs: now,
      detail: `排队位置：${queues[payload.kind].length + 1}，并发：${activeJobIds[payload.kind].size}/${MEDIA_GENERATION_CONCURRENCY[payload.kind]}`,
      metadata: {
        queuePosition: queues[payload.kind].length + 1,
        activeJobs: activeJobIds[payload.kind].size,
        maxActiveJobs: MEDIA_GENERATION_CONCURRENCY[payload.kind],
      },
    }],
  };
  jobs.set(job.id, job);
  queues[payload.kind].push(job.id);
  logger.info('[media-generation] job_enqueued', {
    jobId: job.id,
    kind: job.kind,
    sessionKey: job.sessionKey,
    queuePosition: queues[payload.kind].length,
    activeJobs: activeJobIds[payload.kind].size,
    maxActiveJobs: MEDIA_GENERATION_CONCURRENCY[payload.kind],
  });
  setImmediate(() => pumpQueue(payload.kind));
  return cloneSnapshot(job);
}

export function getMediaGenerationJob(jobId: string): MediaGenerationJobSnapshot | null {
  const job = jobs.get(jobId);
  return job ? cloneSnapshot(job) : null;
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
