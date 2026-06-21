import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const proxyAwareFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: proxyAwareFetchMock,
}));

describe('generateVideoInProcess direct OpenAI-compatible video path', () => {
  const testDir = join(tmpdir(), 'clawx-video-runtime-direct-tests');

  afterEach(async () => {
    proxyAwareFetchMock.mockReset();
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns the backend result URL without waiting for status=completed or downloading content', async () => {
    proxyAwareFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'task_abc',
        status: 'queued',
        model: 'grok-image-video',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'task_abc',
        status: 'processing',
        result_url: 'https://zz-cn.lingzhiwuxian.com/video/grok/task_abc?exp=86400&sig=xyz',
        model: 'grok-image-video',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const { generateVideoInProcess } = await import('@electron/utils/openclaw-video-generation-runtime');
    const result = await generateVideoInProcess({
      config: {},
      agentDir: '/tmp/openclaw-agent',
      prompt: 'make a four-second neon motorcycle video',
      model: 'openai/grok-image-video',
      timeoutMs: 60_000,
      size: '1280x720',
      durationSeconds: 15,
      directOpenAiCompatible: {
        baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
        apiKey: 'test-key',
      },
    });

    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(2);
    expect(proxyAwareFetchMock.mock.calls[0]?.[0]).toBe('https://zz-cn.lingzhiwuxian.com/v1/videos');
    expect(proxyAwareFetchMock.mock.calls[1]?.[0]).toBe('https://zz-cn.lingzhiwuxian.com/v1/videos/task_abc');
    expect(proxyAwareFetchMock.mock.calls.some((call) => String(call[0]).includes('/content'))).toBe(false);
    expect(JSON.parse(String(proxyAwareFetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      prompt: 'make a four-second neon motorcycle video',
      model: 'grok-image-video',
      size: '1280x720',
      seconds: '15',
    });
    expect(result.outputs).toEqual([
      expect.objectContaining({
        url: 'https://zz-cn.lingzhiwuxian.com/video/grok/task_abc?exp=86400&sig=xyz',
        mimeType: 'video/mp4',
      }),
    ]);
  });

  it('sends one reference image for grok-video-1.5 image-to-video requests', async () => {
    await mkdir(testDir, { recursive: true });
    const imagePath = join(testDir, 'frame.png');
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    proxyAwareFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'task_img',
      status: 'completed',
      result_url: 'https://zz-cn.lingzhiwuxian.com/video/grok/task_img?exp=86400&sig=xyz',
      model: 'grok-video-1.5',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const { generateVideoInProcess } = await import('@electron/utils/openclaw-video-generation-runtime');
    await generateVideoInProcess({
      config: {},
      agentDir: '/tmp/openclaw-agent',
      prompt: 'animate this frame',
      model: 'openai/grok-video-1.5',
      timeoutMs: 60_000,
      size: '1280x720',
      durationSeconds: 4,
      inputImages: [{ filePath: imagePath, mimeType: 'image/png', fileName: 'frame.png' }],
      directOpenAiCompatible: {
        baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
        apiKey: 'test-key',
      },
    });

    const body = JSON.parse(String(proxyAwareFetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      prompt: 'animate this frame',
      model: 'grok-video-1.5',
    });
    expect(typeof body.input_reference).toBe('string');
    expect(body.input_reference).toMatch(/^data:image\/png;base64,/);
  });

  it('rejects grok-video-1.5 without exactly one reference image before calling the backend', async () => {
    const { generateVideoInProcess } = await import('@electron/utils/openclaw-video-generation-runtime');

    await expect(generateVideoInProcess({
      config: {},
      agentDir: '/tmp/openclaw-agent',
      prompt: 'make a text-only video',
      model: 'openai/grok-video-1.5',
      timeoutMs: 60_000,
      size: '1280x720',
      durationSeconds: 4,
      directOpenAiCompatible: {
        baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
        apiKey: 'test-key',
      },
    })).rejects.toThrow('grok-video-1.5 requires exactly one reference image.');

    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
  });
});
