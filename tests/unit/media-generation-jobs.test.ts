import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaGenerationWorkerRequest } from '@electron/utils/media-generation-types';

const forkMock = vi.fn();
const testOpenClawConfigDir = join(tmpdir(), 'clawx-tests', 'media-generation-jobs-openclaw');

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
  },
  utilityProcess: {
    fork: (...args: unknown[]) => forkMock(...args),
  },
}));

vi.mock('@electron/utils/paths', () => ({
  getOpenClawConfigDir: () => testOpenClawConfigDir,
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

    const sessionsJsonPath = join(testOpenClawConfigDir, 'agents', 'main', 'sessions', 'sessions.json');
    expect(existsSync(sessionsJsonPath)).toBe(true);
    const sessionsJson = JSON.parse(readFileSync(sessionsJsonPath, 'utf8')) as Record<string, Record<string, unknown>>;
    const transcriptPath = String(sessionsJson['agent:main:main']?.sessionFile);
    const transcript = readFileSync(transcriptPath, 'utf8');
    expect(transcript).toContain('draw a city');
    expect(transcript).toContain('图片已生成。');
    expect(transcript).toContain('MEDIA:/tmp/generated/city.png');
  });
});
