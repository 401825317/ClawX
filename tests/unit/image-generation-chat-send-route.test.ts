import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const generateImageForChatSessionMock = vi.fn();

const testOpenClawConfigDir = join(tmpdir(), 'clawx-tests', 'image-generation-chat-send-route-openclaw');

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
  generateImageForChatSession: (...args: unknown[]) => generateImageForChatSessionMock(...args),
  getImageGenerationSettingsSnapshot: vi.fn(),
  listImageGenerationProvidersFromRuntime: vi.fn(),
  runImageGenerationTest: vi.fn(),
  setImageGenerationConfig: vi.fn(),
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

describe('handleMediaRoutes — POST /api/media/image-generation/chat-send', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
    mkdirSync(join(testOpenClawConfigDir, 'agents', 'main', 'sessions'), { recursive: true });
    generateImageForChatSessionMock.mockResolvedValue({
      ok: true,
      capability: 'image.generate',
      transport: 'local',
      provider: 'clawx-openai-image',
      model: 'gpt-image-2',
      attempts: [],
      outputs: [
        {
          path: '/tmp/generated/city.png',
          mimeType: 'image/png',
          size: 123,
          width: 1024,
          height: 1024,
        },
      ],
      ignoredOverrides: [],
    });
  });

  afterAll(() => {
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
  });

  it('creates or updates the session transcript with prompt and MEDIA output refs', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      sessionKey: 'agent:main:main',
      prompt: '画一张夜景城市海报',
    });

    const { handleMediaRoutes } = await import('@electron/api/routes/media');
    const handled = await handleMediaRoutes(
      makeReq(),
      makeRes(),
      new URL('http://127.0.0.1:13210/api/media/image-generation/chat-send'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(generateImageForChatSessionMock).toHaveBeenCalledWith({
      sessionKey: 'agent:main:main',
      prompt: '画一张夜景城市海报',
      model: undefined,
    });
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ success: true }),
    );

    const sessionsJsonPath = join(testOpenClawConfigDir, 'agents', 'main', 'sessions', 'sessions.json');
    expect(existsSync(sessionsJsonPath)).toBe(true);
    const sessionsJson = JSON.parse(readFileSync(sessionsJsonPath, 'utf8')) as Record<string, Record<string, unknown>>;
    const sessionEntry = sessionsJson['agent:main:main'];
    expect(sessionEntry).toBeDefined();
    expect(typeof sessionEntry.sessionId).toBe('string');
    expect(typeof sessionEntry.sessionFile).toBe('string');

    const transcriptPath = String(sessionEntry.sessionFile);
    expect(existsSync(transcriptPath)).toBe(true);
    const transcript = readFileSync(transcriptPath, 'utf8');
    expect(transcript).toContain('"type":"session"');
    expect(transcript).toContain('"role":"user"');
    expect(transcript).toContain('画一张夜景城市海报');
    expect(transcript).toContain('"role":"assistant"');
    expect(transcript).toContain('图片已生成。');
    expect(transcript).toContain('MEDIA:/tmp/generated/city.png');
  });
});
