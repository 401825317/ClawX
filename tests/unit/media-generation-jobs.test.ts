import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaGenerationWorkerRequest } from '@electron/utils/media-generation-types';

const forkMock = vi.fn();
const testOpenClawConfigDir = join(tmpdir(), 'clawx-tests', 'media-generation-jobs-openclaw');
const testOpenClawRuntimeDir = join(tmpdir(), 'clawx-tests', 'media-generation-jobs-openclaw-runtime');

class MockUtilityProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 1234;
  killed = false;
  postMessage = vi.fn((message: MediaGenerationWorkerRequest) => {
    queueMicrotask(() => {
      this.emit('message', {
        type: 'result',
        jobId: message.jobId,
        success: true,
        result: message.payload.kind === 'image'
          ? {
            ok: true,
            outputs: [{ path: '/tmp/generated/city.png' }],
          }
          : {
            ok: true,
            outputs: [{ url: 'https://example.test/video.mp4' }],
          },
      });
    });
  });
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn((name: string) => name === 'userData' ? '/tmp/uclaw-test-user-data' : '/tmp/uclaw-test-other'),
  },
  utilityProcess: {
    fork: (...args: unknown[]) => forkMock(...args),
  },
}));

vi.mock('@electron/utils/paths', () => ({
  getOpenClawConfigDir: () => testOpenClawConfigDir,
  getOpenClawDir: () => testOpenClawRuntimeDir,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (path: string) => {
      if (path.endsWith('media-generation-worker.cjs') || path.endsWith('media-generation-worker-entry.js')) {
        return true;
      }
      return actual.existsSync(path);
    },
  };
});

async function waitForJobStatus(jobId: string, status: string): Promise<unknown> {
  const { getMediaGenerationJob } = await import('@electron/utils/media-generation-jobs');
  for (let i = 0; i < 20; i += 1) {
    const job = getMediaGenerationJob(jobId);
    if (job?.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return getMediaGenerationJob(jobId);
}

describe('media generation jobs', () => {
  beforeEach(async () => {
    vi.resetModules();
    forkMock.mockReset();
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
    mkdirSync(join(testOpenClawConfigDir, 'agents', 'main', 'sessions'), { recursive: true });
    forkMock.mockImplementation(() => {
      const child = new MockUtilityProcess();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
  });

  it('runs image generation in a utility process and appends the completed transcript', async () => {
    const { enqueueMediaGenerationJob } = await import('@electron/utils/media-generation-jobs');
    const queued = enqueueMediaGenerationJob({
      kind: 'image',
      sessionKey: 'agent:main:main',
      prompt: 'draw a city',
    });

    const completed = await waitForJobStatus(queued.id, 'succeeded');
    expect(completed).toEqual(expect.objectContaining({ status: 'succeeded' }));
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(forkMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      env: expect.objectContaining({
        CLAWX_ELECTRON_STORE_CWD: '/tmp/uclaw-test-user-data',
        CLAWX_OPENCLAW_DIR: testOpenClawRuntimeDir,
      }),
    }));

    const sessionsJsonPath = join(testOpenClawConfigDir, 'agents', 'main', 'sessions', 'sessions.json');
    expect(existsSync(sessionsJsonPath)).toBe(true);
    const sessionsJson = JSON.parse(readFileSync(sessionsJsonPath, 'utf8')) as Record<string, Record<string, unknown>>;
    const transcriptPath = String(sessionsJson['agent:main:main']?.sessionFile);
    const transcript = readFileSync(transcriptPath, 'utf8');
    expect(transcript).toContain('draw a city');
    expect(transcript).toContain('图片已生成。');
    expect(transcript).toContain('MEDIA:/tmp/generated/city.png');
  });

  it('includes bounded worker stdout and stderr when the worker exits before completion', async () => {
    let child: MockUtilityProcess | null = null;
    forkMock.mockImplementationOnce(() => {
      child = new MockUtilityProcess();
      child.postMessage = vi.fn();
      queueMicrotask(() => child?.emit('spawn'));
      return child;
    });

    const { enqueueMediaGenerationJob } = await import('@electron/utils/media-generation-jobs');
    const queued = enqueueMediaGenerationJob({
      kind: 'video',
      sessionKey: 'agent:main:main',
      prompt: 'make a short clip',
    });

    await vi.waitFor(() => {
      expect(child?.postMessage).toHaveBeenCalledTimes(1);
    });

    child?.stdout.emit('data', Buffer.from('provider selected: openai/grok-image-video\n'));
    child?.stderr.emit('data', Buffer.from(`provider failure: ${'x'.repeat(5000)} quota exhausted\n`));
    child?.emit('exit', 1);

    const failed = await waitForJobStatus(queued.id, 'failed') as { error?: string };
    expect(failed.error).toContain('Media generation worker exited before completion (code=1)');
    expect(failed.error).toContain('Worker stderr (last 4096 chars; truncated');
    expect(failed.error).toContain('quota exhausted');
    expect(failed.error).toContain('Worker stdout:');
    expect(failed.error).toContain('provider selected: openai/grok-image-video');
    expect(failed.error?.length).toBeLessThanOrEqual(12_050);
  });

  it('shows a concise user-facing message for upstream provider failures', async () => {
    let child: MockUtilityProcess | null = null;
    forkMock.mockImplementationOnce(() => {
      child = new MockUtilityProcess();
      child.postMessage = vi.fn((message: MediaGenerationWorkerRequest) => {
        queueMicrotask(() => {
          child?.emit('message', {
            type: 'result',
            jobId: message.jobId,
            success: false,
            error: [
              'ProviderHttpError: UClaw OpenAI image generation failed (HTTP 429):',
              'Upstream rate limit exceeded, please retry later [type=rate_limit_error]',
              'at createProviderHttpError (...stack...)',
            ].join(' '),
          });
        });
      });
      queueMicrotask(() => child?.emit('spawn'));
      return child;
    });

    const { enqueueMediaGenerationJob } = await import('@electron/utils/media-generation-jobs');
    const queued = enqueueMediaGenerationJob({
      kind: 'image',
      sessionKey: 'agent:main:main',
      prompt: 'draw a sunny beach',
    });

    const failed = await waitForJobStatus(queued.id, 'failed') as { error?: string };
    expect(failed.error).toBe('上游渠道报错，生成失败了，请稍后重试。');
    expect(failed.error).not.toContain('ProviderHttpError');
    expect(failed.error).not.toContain('stack');
  });
});
