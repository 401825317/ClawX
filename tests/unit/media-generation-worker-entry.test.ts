import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaGenerationWorkerRequest } from '@electron/utils/media-generation-types';
import { MAX_VIDEO_GENERATION_PROMPT_CHARS } from '@electron/utils/video-generation-prompt-limits';

const generateImageForChatSessionMock = vi.fn();
const generateVideoForChatSessionMock = vi.fn();

vi.mock('@electron/utils/openclaw-image-generation', () => ({
  generateImageForChatSession: (...args: unknown[]) => generateImageForChatSessionMock(...args),
}));

vi.mock('@electron/utils/openclaw-video-generation', () => ({
  generateVideoForChatSession: (...args: unknown[]) => generateVideoForChatSessionMock(...args),
}));

type MockParentPort = {
  on: ReturnType<typeof vi.fn<(event: string, listener: (messageEvent: unknown) => void) => void>>;
  postMessage: ReturnType<typeof vi.fn>;
};

type WorkerMessageListener = (messageEvent: unknown) => void;

function setMockParentPort(parentPort: MockParentPort | undefined): void {
  const mutableProcess = process as NodeJS.Process & { parentPort?: MockParentPort };
  if (parentPort) {
    mutableProcess.parentPort = parentPort;
  } else {
    delete mutableProcess.parentPort;
  }
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('media generation worker entry', () => {
  beforeEach(() => {
    vi.resetModules();
    generateImageForChatSessionMock.mockReset();
    generateVideoForChatSessionMock.mockReset();
    setMockParentPort(undefined);
  });

  it.each([
    ['MessageEvent.data payload', (message: MediaGenerationWorkerRequest) => ({ data: message })],
    ['raw payload fallback', (message: MediaGenerationWorkerRequest) => message],
  ])('uses process.parentPort %s from Electron utilityProcess', async (_label, wrapMessage) => {
    let onMessage: WorkerMessageListener | null = null;
    const parentPort: MockParentPort = {
      on: vi.fn((event: string, listener: (messageEvent: unknown) => void) => {
        if (event === 'message') {
          onMessage = listener;
        }
      }),
      postMessage: vi.fn(),
    };
    setMockParentPort(parentPort);
    generateImageForChatSessionMock.mockResolvedValue({
      outputs: [{ path: '/tmp/generated.png' }],
    });

    await import('@electron/utils/media-generation-worker-entry');
    expect(parentPort.on).toHaveBeenCalledWith('message', expect.any(Function));

    onMessage?.(wrapMessage({
        type: 'run',
        jobId: 'job-1',
        payload: {
          kind: 'image',
          sessionKey: 'agent:main:main',
          prompt: 'draw a city',
          size: '1024x1024',
          quality: 'medium',
        },
      } satisfies MediaGenerationWorkerRequest));
    await flushMicrotasks();

    expect(generateImageForChatSessionMock).toHaveBeenCalledWith({
      sessionKey: 'agent:main:main',
      prompt: 'draw a city',
      model: undefined,
      size: '1024x1024',
      quality: 'medium',
      inputImages: undefined,
    }, { skipManagedRelayPreparation: true });
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'result',
      jobId: 'job-1',
      success: true,
      result: {
        outputs: [{ path: '/tmp/generated.png' }],
      },
    });
  });

  it('returns a provider error summary with stack and cause details', async () => {
    let onMessage: WorkerMessageListener | null = null;
    const parentPort: MockParentPort = {
      on: vi.fn((event: string, listener: (messageEvent: unknown) => void) => {
        if (event === 'message') {
          onMessage = listener;
        }
      }),
      postMessage: vi.fn(),
    };
    setMockParentPort(parentPort);
    generateVideoForChatSessionMock.mockRejectedValue(new Error('Provider request failed', {
      cause: {
        status: 502,
        code: 'upstream_bad_gateway',
        error: { message: 'Upstream access forbidden' },
      },
    }));

    await import('@electron/utils/media-generation-worker-entry');
    onMessage?.({
      data: {
        type: 'run',
        jobId: 'job-video-1',
        payload: {
          kind: 'video',
          sessionKey: 'agent:main:main',
          prompt: 'make a product video',
        },
      } satisfies MediaGenerationWorkerRequest,
    });
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'result',
      jobId: 'job-video-1',
      success: false,
      error: expect.stringContaining('Provider request failed'),
    }));
    const response = parentPort.postMessage.mock.calls[0]?.[0] as { error?: string };
    expect(response.error).toContain('Caused by:');
    expect(response.error).toContain('status: 502');
    expect(response.error).toContain('code: upstream_bad_gateway');
    expect(response.error).toContain('error.message: Upstream access forbidden');
    expect(response.error?.length).toBeLessThanOrEqual(4200);
  });

  it('rejects over-limit video prompts before calling the video runtime', async () => {
    let onMessage: WorkerMessageListener | null = null;
    const parentPort: MockParentPort = {
      on: vi.fn((event: string, listener: (messageEvent: unknown) => void) => {
        if (event === 'message') {
          onMessage = listener;
        }
      }),
      postMessage: vi.fn(),
    };
    setMockParentPort(parentPort);

    await import('@electron/utils/media-generation-worker-entry');
    onMessage?.({
      data: {
        type: 'run',
        jobId: 'job-video-long-prompt',
        payload: {
          kind: 'video',
          sessionKey: 'agent:main:main',
          prompt: '画'.repeat(MAX_VIDEO_GENERATION_PROMPT_CHARS + 1),
        },
      } satisfies MediaGenerationWorkerRequest,
    });
    await flushMicrotasks();

    expect(generateVideoForChatSessionMock).not.toHaveBeenCalled();
    expect(parentPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'result',
      jobId: 'job-video-long-prompt',
      success: false,
      error: expect.stringContaining('Video prompt is too long'),
    }));
  });

  it('runs image edit before video for edit-image-then-video payloads', async () => {
    let onMessage: WorkerMessageListener | null = null;
    const parentPort: MockParentPort = {
      on: vi.fn((event: string, listener: (messageEvent: unknown) => void) => {
        if (event === 'message') {
          onMessage = listener;
        }
      }),
      postMessage: vi.fn(),
    };
    setMockParentPort(parentPort);
    generateImageForChatSessionMock.mockResolvedValue({
      outputs: [{ path: '/tmp/edited-frame.png', mimeType: 'image/png' }],
    });
    generateVideoForChatSessionMock.mockResolvedValue({
      outputs: [{ path: '/tmp/final-video.mp4', mimeType: 'video/mp4' }],
    });

    await import('@electron/utils/media-generation-worker-entry');
    onMessage?.({
      data: {
        type: 'run',
        jobId: 'job-video-pipeline-1',
        payload: {
          kind: 'video',
          sessionKey: 'agent:main:main',
          prompt: '让蓝色调画面缓慢推进并带有电影感。',
          originalPrompt: '用上一张图改成蓝色调，然后给我出视频',
          durationSeconds: 6,
          inputImages: [
            {
              fileName: 'old-frame.png',
              mimeType: 'image/png',
              filePath: '/tmp/old-frame.png',
            },
          ],
          route: {
            mode: 'edit_image_then_video',
            source: 'router',
            confidence: 0.92,
            selectedImageSource: 'candidate',
            selectedImageIndex: 0,
            imageEditPrompt: '把参考图改成蓝色调。',
            videoPrompt: '让蓝色调画面缓慢推进并带有电影感。',
            sourceImages: [
              {
                fileName: 'old-frame.png',
                mimeType: 'image/png',
                filePath: '/tmp/old-frame.png',
              },
            ],
          },
        },
      } satisfies MediaGenerationWorkerRequest,
    });
    await flushMicrotasks();

    expect(generateImageForChatSessionMock).toHaveBeenCalledWith({
      sessionKey: 'agent:main:main',
      prompt: '把参考图改成蓝色调。',
      inputImages: [
        {
          fileName: 'old-frame.png',
          mimeType: 'image/png',
          filePath: '/tmp/old-frame.png',
        },
      ],
    }, { skipManagedRelayPreparation: true });
    expect(generateVideoForChatSessionMock).toHaveBeenCalledWith({
      sessionKey: 'agent:main:main',
      prompt: '让蓝色调画面缓慢推进并带有电影感。',
      size: undefined,
      durationSeconds: 6,
      inputImages: [
        {
          fileName: 'edited-frame.png',
          mimeType: 'image/png',
          filePath: '/tmp/edited-frame.png',
        },
      ],
    }, { skipManagedRelayPreparation: true });
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'result',
      jobId: 'job-video-pipeline-1',
      success: true,
      result: expect.objectContaining({
        outputs: [{ path: '/tmp/final-video.mp4', mimeType: 'video/mp4' }],
        pipeline: expect.objectContaining({
          mode: 'edit_image_then_video',
          imageEditPrompt: '把参考图改成蓝色调。',
        }),
      }),
    });
  });
});
