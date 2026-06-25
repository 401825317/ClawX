import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

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
      size: '1280x720',
      durationSeconds: 4,
      inputImages: undefined,
    });
    expect(enqueueMediaGenerationJobMock).toHaveBeenCalledWith({
      kind: 'video',
      sessionKey: 'agent:main:main',
      prompt: 'make a short product video',
      size: '1280x720',
      durationSeconds: 4,
      inputImages: undefined,
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
      inputImages: [
        {
          fileName: 'frame.png',
          mimeType: 'image/png',
          filePath: '/tmp/frame.png',
        },
      ],
    }));
    expect(enqueueMediaGenerationJobMock.mock.calls[0]?.[0]).not.toHaveProperty('model');
  });
});
