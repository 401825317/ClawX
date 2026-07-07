import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_VIDEO_GENERATION_PROMPT_CHARS } from '@electron/utils/video-generation-prompt-limits';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const prepareMediaGenerationJobMock = vi.fn();
const enqueueMediaGenerationJobMock = vi.fn();

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('@electron/utils/openclaw-image-generation', () => ({
  applyOpenAiImageRelaySettings: vi.fn(),
  getImageGenerationSettingsSnapshot: vi.fn(),
  listImageGenerationProvidersFromRuntime: vi.fn(),
  runImageGenerationTest: vi.fn(),
  setImageGenerationConfig: vi.fn(),
}));

vi.mock('@electron/utils/openclaw-video-generation', () => ({
  applyOpenAiVideoRelaySettings: vi.fn(),
  getVideoGenerationSettingsSnapshot: vi.fn(),
  listVideoGenerationProvidersFromRuntime: vi.fn(),
  runVideoGenerationTest: vi.fn(),
  setVideoGenerationConfig: vi.fn(),
}));

vi.mock('@electron/utils/media-generation-jobs', () => ({
  enqueueMediaGenerationJob: (...args: unknown[]) => enqueueMediaGenerationJobMock(...args),
  prepareMediaGenerationJob: (...args: unknown[]) => prepareMediaGenerationJobMock(...args),
  getMediaGenerationJob: vi.fn(),
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

function makeReq(method = 'POST'): IncomingMessage {
  return { method } as IncomingMessage;
}

function makeRes(): ServerResponse {
  return {
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
}

describe('handleMediaRoutes POST /api/media/video-generation/chat-send', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    enqueueMediaGenerationJobMock.mockReturnValue({
      id: 'job-video-1',
      kind: 'video',
      sessionKey: 'agent:main:main',
      status: 'queued',
      createdAt: 1,
      updatedAt: 1,
    });
    prepareMediaGenerationJobMock.mockResolvedValue(undefined);
  });

  it('enqueues a video generation job and returns immediately', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      sessionKey: 'agent:main:main',
      prompt: 'make a short product video',
      size: '1280x720',
      durationSeconds: 4,
    });

    const { handleMediaRoutes } = await import('@electron/api/routes/media');
    const handled = await handleMediaRoutes(
      makeReq(),
      makeRes(),
      new URL('http://127.0.0.1:13210/api/media/video-generation/chat-send'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(prepareMediaGenerationJobMock).toHaveBeenCalledWith({
      kind: 'video',
      sessionKey: 'agent:main:main',
      prompt: 'make a short product video',
      originalPrompt: 'make a short product video',
      size: '1280x720',
      durationSeconds: 4,
      inputImages: undefined,
      route: expect.objectContaining({
        mode: 'text_to_video',
        selectedImageSource: 'none',
      }),
    });
    expect(enqueueMediaGenerationJobMock).toHaveBeenCalledWith({
      kind: 'video',
      sessionKey: 'agent:main:main',
      prompt: 'make a short product video',
      originalPrompt: 'make a short product video',
      size: '1280x720',
      durationSeconds: 4,
      inputImages: undefined,
      route: expect.objectContaining({
        mode: 'text_to_video',
        selectedImageSource: 'none',
      }),
    });
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      202,
      expect.objectContaining({ success: true, jobId: 'job-video-1' }),
    );
  });

  it('forwards image references for image-to-video requests', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      sessionKey: 'agent:main:main',
      prompt: 'animate this frame',
      model: 'grok-image-video',
      inputImages: [
        {
          fileName: 'frame.png',
          mimeType: 'image/png',
          filePath: '/tmp/frame.png',
        },
      ],
    });

    const { handleMediaRoutes } = await import('@electron/api/routes/media');
    const handled = await handleMediaRoutes(
      makeReq(),
      makeRes(),
      new URL('http://127.0.0.1:13210/api/media/video-generation/chat-send'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(prepareMediaGenerationJobMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'video',
      sessionKey: 'agent:main:main',
      prompt: 'animate this frame',
      inputImages: [
        {
          fileName: 'frame.png',
          mimeType: 'image/png',
          filePath: '/tmp/frame.png',
        },
      ],
    }));
    expect(enqueueMediaGenerationJobMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'video',
      sessionKey: 'agent:main:main',
      prompt: 'animate this frame',
      model: 'grok-image-video',
      inputImages: [
        {
          fileName: 'frame.png',
          mimeType: 'image/png',
          filePath: '/tmp/frame.png',
        },
      ],
    }));
  });

  it('enqueues an edit-image-then-video pipeline from the unified media route', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      sessionKey: 'agent:main:main',
      prompt: '用上一张图改成蓝色调，然后给我出视频',
      durationSeconds: 6,
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
    });

    const { handleMediaRoutes } = await import('@electron/api/routes/media');
    const handled = await handleMediaRoutes(
      makeReq(),
      makeRes(),
      new URL('http://127.0.0.1:13210/api/media/video-generation/chat-send'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(enqueueMediaGenerationJobMock).toHaveBeenCalledWith(expect.objectContaining({
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
      route: expect.objectContaining({
        mode: 'edit_image_then_video',
        imageEditPrompt: '把参考图改成蓝色调。',
      }),
    }));
  });

  it('rejects final video prompts that exceed the local xAI safety limit before enqueueing', async () => {
    const longVideoPrompt = '镜'.repeat(MAX_VIDEO_GENERATION_PROMPT_CHARS + 1);
    parseJsonBodyMock.mockResolvedValueOnce({
      sessionKey: 'agent:main:main',
      prompt: '生成一段短视频',
      durationSeconds: 6,
      route: {
        mode: 'text_to_video',
        source: 'router',
        confidence: 0.98,
        selectedImageSource: 'none',
        videoPrompt: longVideoPrompt,
      },
    });

    const { handleMediaRoutes } = await import('@electron/api/routes/media');
    const handled = await handleMediaRoutes(
      makeReq(),
      makeRes(),
      new URL('http://127.0.0.1:13210/api/media/video-generation/chat-send'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(prepareMediaGenerationJobMock).not.toHaveBeenCalled();
    expect(enqueueMediaGenerationJobMock).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('Video prompt is too long'),
        promptChars: MAX_VIDEO_GENERATION_PROMPT_CHARS + 1,
        maxPromptChars: MAX_VIDEO_GENERATION_PROMPT_CHARS,
      }),
    );
  });
});
