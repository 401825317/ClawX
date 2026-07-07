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
const USER_FACING_UPSTREAM_MEDIA_ERROR = '上游渠道报错，生成失败了，请稍后重试。';

const activeJobIds: Record<MediaGenerationKind, string | null> = {
  image: null,
  video: null,
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
  return { ...snapshot };
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
  job.status = 'failed';
  job.updatedAt = now;
  job.completedAt = now;
  job.error = normalizeUserFacingMediaGenerationError(error);
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
  if (job.payload.kind === 'image') {
    await appendImageGenerationConversation({
      sessionKey: job.payload.sessionKey,
      prompt: job.payload.prompt,
      outputPaths,
      inputPaths,
      summaryText: inputPaths.length > 0 ? '图片已修改。' : '图片已生成。',
    });
    return;
  }

  await appendImageGenerationConversation({
    sessionKey: job.payload.sessionKey,
    prompt: job.payload.originalPrompt || job.payload.prompt,
    outputPaths,
    inputPaths,
    summaryText: job.payload.route?.mode === 'edit_image_then_video'
      ? '已先修改参考图并生成视频。'
      : (inputPaths.length > 0 ? '已基于参考图生成视频。' : '视频已生成。'),
  });
}

async function runJob(job: InternalMediaGenerationJob): Promise<void> {
  activeJobIds[job.kind] = job.id;
  const now = Date.now();
  job.status = 'running';
  job.startedAt = now;
  job.updatedAt = now;

  const wrapperPath = getMediaWorkerWrapperPath();
  const entryPath = getMediaWorkerEntryPath();
  if (!existsSync(wrapperPath)) {
    markJobFailed(job, `Media generation worker wrapper not found at ${wrapperPath}`);
    activeJobIds[job.kind] = null;
    return;
  }
  if (!existsSync(entryPath)) {
    markJobFailed(job, `Media generation worker entry not found at ${entryPath}`);
    activeJobIds[job.kind] = null;
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
      const line = formatWorkerLogChunk(data);
      if (line) {
        logger.warn(`[media-generation-worker] ${line}`);
      }
    });
  });

  activeJobIds[job.kind] = null;
}

function pumpQueue(kind: MediaGenerationKind): void {
  if (activeJobIds[kind]) return;
  const nextJobId = queues[kind].shift();
  if (!nextJobId) return;
  const job = jobs.get(nextJobId);
  if (!job || job.status !== 'queued') {
    setImmediate(() => pumpQueue(kind));
    return;
  }
  void runJob(job)
    .catch((error) => {
      activeJobIds[kind] = null;
      markJobFailed(job, error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      compactJobHistory();
      setImmediate(() => pumpQueue(kind));
    });
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
  };
  jobs.set(job.id, job);
  queues[payload.kind].push(job.id);
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
