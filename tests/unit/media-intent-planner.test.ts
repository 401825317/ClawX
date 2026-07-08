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

  it('returns a local composite chat plan for multi-deliverable requests without calling the LLM planner', async () => {
    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '帮我生图、做PPT、整理Excel、生视频、根据这张图片修图、做小程序、写文案',
      requestedMode: 'chat',
      explicitImages: [
        {
          fileName: 'input.png',
          mimeType: 'image/png',
          filePath: '/tmp/input.png',
        },
      ],
    });

    expect(getProviderSecretMock).not.toHaveBeenCalled();
    expect(getProviderAccountMock).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      action: 'chat',
      source: 'fallback',
      reason: 'composite_intent_local',
      selectedImageSource: 'none',
    }));
    expect(plan.compositeTasks?.map((task) => task.kind)).toEqual([
      'image_generate',
      'presentation',
      'spreadsheet',
      'video_generate',
      'image_edit',
      'mini_program',
      'copywriting',
    ]);
    expect(plan.compositeTasks?.[4]).toEqual(expect.objectContaining({
      kind: 'image_edit',
      selectedImageSource: 'explicit',
      selectedImageIndex: 0,
      sourceImages: [
        {
          fileName: 'input.png',
          mimeType: 'image/png',
          filePath: '/tmp/input.png',
        },
      ],
    }));
  });

  it('keeps image-edit in a composite sample pack even without an input image', async () => {
    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '生图，PPT，Excel，生视频，根据图片修图，做小程序，生成文案，每个事儿都随便给我来一个',
      requestedMode: 'chat',
    });

    expect(getProviderSecretMock).not.toHaveBeenCalled();
    expect(getProviderAccountMock).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      action: 'chat',
      source: 'fallback',
      reason: 'composite_intent_local',
    }));
    expect(plan.compositeTasks?.map((task) => task.kind)).toEqual([
      'image_generate',
      'presentation',
      'spreadsheet',
      'video_generate',
      'image_edit',
      'mini_program',
      'copywriting',
    ]);
    expect(plan.compositeTasks?.[4]).toEqual(expect.objectContaining({
      kind: 'image_edit',
      selectedImageSource: 'none',
      dependsOn: ['task-1-image_generate'],
      fallback: expect.stringContaining('本轮前序图片生成子任务'),
    }));
  });

  it('routes explicit image mode locally without calling the LLM planner', async () => {
    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '画一张城市夜景',
      requestedMode: 'image',
    });

    expect(getProviderSecretMock).not.toHaveBeenCalled();
    expect(getProviderAccountMock).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      action: 'image_generate',
      source: 'fallback',
      intentKind: 'current_media_task',
      currentTurnMediaRequest: true,
      reason: 'local_fast_path_explicit_image_mode',
      prompt: '画一张城市夜景',
    }));
    expect(plan.compositeTasks).toBeUndefined();
  });

  it('keeps ambiguous media side effects on chat when planner omits current-turn authorization', async () => {
    proxyAwareFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: 'image_generate',
                confidence: 0.9,
                selected_image_source: 'none',
                prompt: '画一张城市夜景。',
              }),
            },
          },
        ],
      }),
    });

    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '给我一个城市夜景视觉素材',
      requestedMode: 'chat',
    });

    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(1);
    expect(plan).toEqual(expect.objectContaining({
      action: 'chat',
      source: 'planner',
      reason: 'planner_missing_current_media_authorization',
      selectedImageSource: 'none',
    }));
  });

  it('keeps future sourcing preferences on chat even when the planner proposes image generation', async () => {
    proxyAwareFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: 'image_generate',
                intent_kind: 'preference_or_memory_update',
                current_turn_media_request: false,
                confidence: 0.9,
                selected_image_source: 'none',
                prompt: '以后生成作品的时候，如果需要图片就从网上获取，如果需要公开数据就从网上获取。保存在记忆体里',
                reason: '用户是在设置后续生成作品的素材来源偏好，而不是要求当前回合生成图片。',
              }),
            },
          },
        ],
      }),
    });

    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '以后生成作品的时候，如果需要图片就从网上获取，如果需要公开数据就从网上获取。保存在记忆体里',
      requestedMode: 'chat',
    });

    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(1);
    expect(plan).toEqual(expect.objectContaining({
      action: 'chat',
      source: 'planner',
      intentKind: 'preference_or_memory_update',
      currentTurnMediaRequest: false,
      selectedImageSource: 'none',
    }));
  });

  it('routes explicit image-mode edits locally to the candidate image', async () => {
    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '这个图片上能不能加一条狗？',
      requestedMode: 'image',
      candidateImages: [
        {
          fileName: 'room.png',
          mimeType: 'image/png',
          filePath: '/tmp/room.png',
        },
      ],
    });

    expect(getProviderSecretMock).not.toHaveBeenCalled();
    expect(getProviderAccountMock).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      action: 'image_edit',
      source: 'fallback',
      reason: 'local_fast_path_explicit_image_mode',
      selectedImageSource: 'candidate',
      selectedImageIndex: 0,
      prompt: '这个图片上能不能加一条狗？',
      sourceImages: [
        {
          fileName: 'room.png',
          mimeType: 'image/png',
          filePath: '/tmp/room.png',
        },
      ],
    }));
  });

  it('turns explicit image-mode edit requests without an image into a local clarification', async () => {
    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '这个图片上能不能加一条狗？',
      requestedMode: 'image',
    });

    expect(getProviderSecretMock).not.toHaveBeenCalled();
    expect(getProviderAccountMock).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      action: 'clarify',
      source: 'planner',
      clarification: '你想编辑哪张图片？请上传或选中一张图片。',
    }));
  });

  it('upgrades visual chat about a recent image locally into vision_chat with the candidate image', async () => {
    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '你觉得美嘛？',
      requestedMode: 'chat',
      candidateImages: [
        {
          fileName: 'beauty.png',
          mimeType: 'image/png',
          filePath: '/tmp/beauty.png',
        },
      ],
    });

    expect(getProviderSecretMock).not.toHaveBeenCalled();
    expect(getProviderAccountMock).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      action: 'vision_chat',
      source: 'fallback',
      selectedImageSource: 'candidate',
      selectedImageIndex: 0,
      sourceImages: [
        {
          fileName: 'beauty.png',
          mimeType: 'image/png',
          filePath: '/tmp/beauty.png',
        },
      ],
    }));
  });

  it('falls back to chat instead of guessing a media route when planner credentials are unavailable', async () => {
    getProviderSecretMock.mockResolvedValueOnce(null);

    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '给我分析一下这个需求',
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
