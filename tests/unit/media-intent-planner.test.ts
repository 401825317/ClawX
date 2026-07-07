import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('planMediaIntent', () => {
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

  it('uses planner JSON to route a current-image edit to the candidate image', async () => {
    proxyAwareFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: 'image_edit',
                confidence: 0.94,
                selected_image_source: 'candidate',
                selected_image_index: 0,
                prompt: '在图片右侧添加一条狗。',
                reason: '用户明确指代当前图片并要求添加对象。',
              }),
            },
          },
        ],
      }),
    });

    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '这个图片上能不能加一条狗？',
      requestedMode: 'chat',
      candidateImages: [
        {
          fileName: 'room.png',
          mimeType: 'image/png',
          filePath: '/tmp/room.png',
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
    expect(plan).toEqual(expect.objectContaining({
      action: 'image_edit',
      source: 'planner',
      selectedImageSource: 'candidate',
      selectedImageIndex: 0,
      prompt: '在图片右侧添加一条狗。',
      sourceImages: [
        {
          fileName: 'room.png',
          mimeType: 'image/png',
          filePath: '/tmp/room.png',
        },
      ],
    }));
  });

  it('turns image-edit decisions without an image into clarification', async () => {
    proxyAwareFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: 'image_edit',
                confidence: 0.92,
                selected_image_source: 'candidate',
                selected_image_index: 0,
                prompt: '加一条狗。',
              }),
            },
          },
        ],
      }),
    });

    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '这个图片上能不能加一条狗？',
      requestedMode: 'chat',
    });

    expect(plan).toEqual(expect.objectContaining({
      action: 'clarify',
      source: 'planner',
      clarification: '你想编辑哪张图片？请上传或选中一张图片。',
    }));
  });

  it('falls back to chat instead of guessing a media route when planner credentials are unavailable', async () => {
    getProviderSecretMock.mockResolvedValueOnce(null);

    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '这个图片上能不能加一条狗？',
      requestedMode: 'chat',
    });

    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      action: 'chat',
      source: 'fallback',
      reason: 'planner_api_key_unavailable',
    }));
  });
});
