import { randomUUID } from 'node:crypto';
import { existsSync } from 'fs';
import path from 'node:path';
import { app, utilityProcess } from 'electron';
import { appendImageGenerationConversation } from './chat-session-image-message';
import { logger } from './logger';
import type {
  MediaGenerationJobPayload,
  MediaGenerationJobSnapshot,
  MediaGenerationWorkerRequest,
  MediaGenerationWorkerResponse,
} from './media-generation-types';

type InternalMediaGenerationJob = MediaGenerationJobSnapshot & {
  payload: MediaGenerationJobPayload;
};

const jobs = new Map<string, InternalMediaGenerationJob>();
const queue: string[] = [];
const MAX_JOB_HISTORY = 50;

let activeJobId: string | null = null;

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
  job.status = 'failed';
  job.updatedAt = now;
  job.completedAt = now;
  job.error = error;
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
    prompt: job.payload.prompt,
    outputPaths,
    inputPaths,
    summaryText: inputPaths.length > 0 ? '已基于参考图生成视频。' : '视频已生成。',
  });
}

async function runJob(job: InternalMediaGenerationJob): Promise<void> {
  activeJobId = job.id;
  const now = Date.now();
  job.status = 'running';
  job.startedAt = now;
  job.updatedAt = now;

  const wrapperPath = getMediaWorkerWrapperPath();
  const entryPath = getMediaWorkerEntryPath();
  if (!existsSync(wrapperPath)) {
    markJobFailed(job, `Media generation worker wrapper not found at ${wrapperPath}`);
    activeJobId = null;
    return;
  }
  if (!existsSync(entryPath)) {
    markJobFailed(job, `Media generation worker entry not found at ${entryPath}`);
    activeJobId = null;
    return;
  }

  await new Promise<void>((resolve) => {
    const child = utilityProcess.fork(wrapperPath, [], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: {
        ...process.env,
        CLAWX_MEDIA_GENERATION_WORKER_ENTRY: entryPath,
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
        markJobFailed(job, response.error || 'Media generation failed');
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

    child.on('exit', (code: number) => {
      if (settled) return;
      markJobFailed(job, `Media generation worker exited before completion (code=${code})`);
      settled = true;
      resolve();
    });

    child.on('error', (...args: unknown[]) => {
      if (settled) return;
      markJobFailed(job, `Media generation worker error: ${args.map(String).join(' ')}`);
      settled = true;
      resolve();
    });

    child.stderr?.on('data', (data) => {
      logger.warn(`[media-generation-worker] ${String(data).trim()}`);
    });
  });

  activeJobId = null;
}

function pumpQueue(): void {
  if (activeJobId) return;
  const nextJobId = queue.shift();
  if (!nextJobId) return;
  const job = jobs.get(nextJobId);
  if (!job || job.status !== 'queued') {
    setImmediate(pumpQueue);
    return;
  }
  void runJob(job)
    .catch((error) => {
      markJobFailed(job, error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      compactJobHistory();
      setImmediate(pumpQueue);
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
  queue.push(job.id);
  setImmediate(pumpQueue);
  return cloneSnapshot(job);
}

export function getMediaGenerationJob(jobId: string): MediaGenerationJobSnapshot | null {
  const job = jobs.get(jobId);
  return job ? cloneSnapshot(job) : null;
}
