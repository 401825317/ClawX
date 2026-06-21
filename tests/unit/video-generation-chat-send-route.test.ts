import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const generateVideoForChatSessionMock = vi.fn();

const testOpenClawConfigDir = join(tmpdir(), 'clawx-tests', 'video-generation-chat-send-route-openclaw');

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('@electron/utils/paths', () => ({
  getOpenClawConfigDir: () => testOpenClawConfigDir,
  getOpenClawDir: () => testOpenClawConfigDir,
  getOpenClawResolvedDir: () => testOpenClawConfigDir,
}));

vi.mock('@electron/utils/openclaw-image-generation', () => ({
  applyOpenAiImageRelaySettings: vi.fn(),
  generateImageForChatSession: vi.fn(),
  getImageGenerationSettingsSnapshot: vi.fn(),
  listImageGenerationProvidersFromRuntime: vi.fn(),
  runImageGenerationTest: vi.fn(),
  setImageGenerationConfig: vi.fn(),
}));

vi.mock('@electron/utils/openclaw-video-generation', () => ({
  applyOpenAiVideoRelaySettings: vi.fn(),
  generateVideoForChatSession: (...args: unknown[]) => generateVideoForChatSessionMock(...args),
  getVideoGenerationSettingsSnapshot: vi.fn(),
  listVideoGenerationProvidersFromRuntime: vi.fn(),
  runVideoGenerationTest: vi.fn(),
  setVideoGenerationConfig: vi.fn(),
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
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
    mkdirSync(join(testOpenClawConfigDir, 'agents', 'main', 'sessions'), { recursive: true });
    generateVideoForChatSessionMock.mockResolvedValue({
      ok: true,
      capability: 'video.generate',
      transport: 'local',
      provider: 'openai',
      model: 'grok-image-video',
      attempts: [],
      outputs: [
        {
          url: 'https://zz-cn.lingzhiwuxian.com/v1/videos/task_abc/content?expires=86400&signature=xyz',
          mimeType: 'video/mp4',
          size: 456,
        },
      ],
      ignoredOverrides: [],
    });
  });

  afterAll(() => {
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
  });

  it('writes prompt and remote MEDIA video refs into the session transcript', async () => {
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
    expect(generateVideoForChatSessionMock).toHaveBeenCalledWith({
      sessionKey: 'agent:main:main',
      prompt: 'make a short product video',
      model: undefined,
      size: '1280x720',
      durationSeconds: 4,
      inputImages: undefined,
    });
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ success: true }),
    );

    const sessionsJsonPath = join(testOpenClawConfigDir, 'agents', 'main', 'sessions', 'sessions.json');
    expect(existsSync(sessionsJsonPath)).toBe(true);
    const sessionsJson = JSON.parse(readFileSync(sessionsJsonPath, 'utf8')) as Record<string, Record<string, unknown>>;
    const transcriptPath = String(sessionsJson['agent:main:main']?.sessionFile);
    expect(existsSync(transcriptPath)).toBe(true);
    const transcript = readFileSync(transcriptPath, 'utf8');
    expect(transcript).toContain('make a short product video');
    expect(transcript).toContain('Video generated.');
    expect(transcript).toContain('MEDIA:https://zz-cn.lingzhiwuxian.com/v1/videos/task_abc/content?expires=86400&signature=xyz');
  });

  it('forwards image references for image-to-video requests', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      sessionKey: 'agent:main:main',
      prompt: 'animate this frame',
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
    expect(generateVideoForChatSessionMock).toHaveBeenCalledWith(expect.objectContaining({
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

    const sessionsJsonPath = join(testOpenClawConfigDir, 'agents', 'main', 'sessions', 'sessions.json');
    const sessionsJson = JSON.parse(readFileSync(sessionsJsonPath, 'utf8')) as Record<string, Record<string, unknown>>;
    const transcriptPath = String(sessionsJson['agent:main:main']?.sessionFile);
    const transcript = readFileSync(transcriptPath, 'utf8');
    expect(transcript).toContain('Video generated from image.');
  });
});
