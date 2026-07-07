import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_VIDEO_GENERATION_PROMPT_CHARS } from '@electron/utils/video-generation-prompt-limits';

const getProviderSecretMock = vi.fn();
const getProviderAccountMock = vi.fn();
const proxyAwareFetchMock = vi.fn();

vi.mock('@electron/services/secrets/secret-store', () => ({
  getProviderSecret: (...args: unknown[]) => getProviderSecretMock(...args),
}));

vi.mock('@electron/services/providers/provider-store', () => ({
  getProviderAccount: (...args: unknown[]) => getProviderAccountMock(...args),
}));

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: (...args: unknown[]) => proxyAwareFetchMock(...args),
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('planVideoGenerationRoute', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getProviderSecretMock.mockResolvedValue({
      type: 'api_key',
      accountId: 'lingzhiwuxian',
      apiKey: 'sk-test',
    });
    getProviderAccountMock.mockResolvedValue({
      id: 'lingzhiwuxian',
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      model: 'smart-latest',
      headers: { 'X-Test': '1' },
    });
  });

  it('uses router JSON to plan edit-image-then-video from a candidate image', async () => {
    proxyAwareFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mode: 'edit_image_then_video',
                confidence: 0.91,
                selected_image_source: 'candidate',
                selected_image_index: 0,
                image_edit_prompt: '把参考图改成蓝色调。',
                video_prompt: '让蓝色调画面缓慢推进。',
                reason: '用户要求先改图再出视频。',
              }),
            },
          },
        ],
      }),
    });

    const { planVideoGenerationRoute } = await import('@electron/utils/video-generation-route-planner');
    const plan = await planVideoGenerationRoute({
      prompt: '用上一张图改成蓝色调，然后给我出视频',
      candidateImages: [
        {
          fileName: 'old-frame.png',
          mimeType: 'image/png',
          filePath: '/tmp/old-frame.png',
        },
      ],
    });

    expect(proxyAwareFetchMock).toHaveBeenCalledWith(
      'https://zz-cn.lingzhiwuxian.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
          'Content-Type': 'application/json',
          'X-Test': '1',
        }),
      }),
    );
    const requestBody = JSON.parse(proxyAwareFetchMock.mock.calls[0]?.[1]?.body as string);
    expect(requestBody.messages[0].content).toContain(
      `no more than ${MAX_VIDEO_GENERATION_PROMPT_CHARS} Unicode characters`,
    );
    expect(plan).toEqual(expect.objectContaining({
      mode: 'edit_image_then_video',
      source: 'router',
      selectedImageSource: 'candidate',
      selectedImageIndex: 0,
      imageEditPrompt: '把参考图改成蓝色调。',
      videoPrompt: '让蓝色调画面缓慢推进。',
      sourceImages: [
        {
          fileName: 'old-frame.png',
          mimeType: 'image/png',
          filePath: '/tmp/old-frame.png',
        },
      ],
    }));
  });

  it('falls back to text-to-video when router confidence is low and only candidate images exist', async () => {
    proxyAwareFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mode: 'image_to_video',
                confidence: 0.2,
                selected_image_source: 'candidate',
                selected_image_index: 0,
                video_prompt: '生成视频。',
              }),
            },
          },
        ],
      }),
    });

    const { planVideoGenerationRoute } = await import('@electron/utils/video-generation-route-planner');
    const plan = await planVideoGenerationRoute({
      prompt: '生成一段城市夜景视频',
      candidateImages: [
        {
          fileName: 'old-frame.png',
          mimeType: 'image/png',
          filePath: '/tmp/old-frame.png',
        },
      ],
    });

    expect(plan).toEqual(expect.objectContaining({
      mode: 'text_to_video',
      source: 'fallback',
      selectedImageSource: 'none',
    }));
  });

  it('falls back to explicit-image image-to-video when router credentials are unavailable', async () => {
    getProviderSecretMock.mockResolvedValueOnce(null);

    const { planVideoGenerationRoute } = await import('@electron/utils/video-generation-route-planner');
    const plan = await planVideoGenerationRoute({
      prompt: '让这张图动起来',
      inputImages: [
        {
          fileName: 'frame.png',
          mimeType: 'image/png',
          filePath: '/tmp/frame.png',
        },
      ],
    });

    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      mode: 'image_to_video',
      source: 'fallback',
      selectedImageSource: 'explicit',
      selectedImageIndex: 0,
      sourceImages: [
        {
          fileName: 'frame.png',
          mimeType: 'image/png',
          filePath: '/tmp/frame.png',
        },
      ],
    }));
  });
});
