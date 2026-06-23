import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const enqueueMediaGenerationJobMock = vi.fn();
const getMediaGenerationJobMock = vi.fn();

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
  getMediaGenerationJob: (...args: unknown[]) => getMediaGenerationJobMock(...args),
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

describe('handleMediaRoutes POST /api/media/image-generation/chat-send', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    enqueueMediaGenerationJobMock.mockReturnValue({
      id: 'job-image-1',
      kind: 'image',
      sessionKey: 'agent:main:main',
      status: 'queued',
      createdAt: 1,
      updatedAt: 1,
    });
  });

  it('enqueues an image generation job and returns immediately', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      sessionKey: 'agent:main:main',
      prompt: 'draw a night city poster',
      size: '2048x2048',
      quality: 'high',
    });

    const { handleMediaRoutes } = await import('@electron/api/routes/media');
    const handled = await handleMediaRoutes(
      makeReq(),
      makeRes(),
      new URL('http://127.0.0.1:13210/api/media/image-generation/chat-send'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(enqueueMediaGenerationJobMock).toHaveBeenCalledWith({
      kind: 'image',
      sessionKey: 'agent:main:main',
      prompt: 'draw a night city poster',
      model: undefined,
      size: '2048x2048',
      quality: 'high',
      inputImages: undefined,
    });
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      202,
      expect.objectContaining({ success: true, jobId: 'job-image-1' }),
    );
  });

  it('forwards image edit references to the queued job', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      sessionKey: 'agent:main:main',
      prompt: 'make the dot red',
      inputImages: [
        {
          fileName: 'dot.png',
          mimeType: 'image/png',
          filePath: '/tmp/generated/dot.png',
        },
      ],
    });

    const { handleMediaRoutes } = await import('@electron/api/routes/media');
    const handled = await handleMediaRoutes(
      makeReq(),
      makeRes(),
      new URL('http://127.0.0.1:13210/api/media/image-generation/chat-send'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(enqueueMediaGenerationJobMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image',
      sessionKey: 'agent:main:main',
      prompt: 'make the dot red',
      inputImages: [
        {
          fileName: 'dot.png',
          mimeType: 'image/png',
          filePath: '/tmp/generated/dot.png',
        },
      ],
    }));
  });

  it('returns queued job status by id', async () => {
    getMediaGenerationJobMock.mockReturnValueOnce({
      id: 'job-image-1',
      kind: 'image',
      sessionKey: 'agent:main:main',
      status: 'succeeded',
      createdAt: 1,
      updatedAt: 2,
    });

    const { handleMediaRoutes } = await import('@electron/api/routes/media');
    const handled = await handleMediaRoutes(
      makeReq('GET'),
      makeRes(),
      new URL('http://127.0.0.1:13210/api/media/generation-jobs/job-image-1'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(getMediaGenerationJobMock).toHaveBeenCalledWith('job-image-1');
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ success: true, job: expect.objectContaining({ status: 'succeeded' }) }),
    );
  });
});
