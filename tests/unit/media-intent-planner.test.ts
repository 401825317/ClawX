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

  it('keeps a single PPT artifact request on the local chat path', async () => {
    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '做一个 8 页 PPT：《AI 工作流如何提升团队效率》，要有目录、痛点、方案、案例、ROI、落地计划',
      requestedMode: 'chat',
    });

    expect(getProviderSecretMock).not.toHaveBeenCalled();
    expect(getProviderAccountMock).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      action: 'chat',
      source: 'fallback',
      currentTurnMediaRequest: false,
      selectedImageSource: 'none',
      reason: 'local_no_media_planning_signal',
    }));
    expect(plan.compositeTasks).toBeUndefined();
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

  it('prefers the current composite image output over historical candidate images for sample-pack edits', async () => {
    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '生图，PPT，Excel，生视频，根据图片修图，做小程序，生成文案，每个事儿都随便给我来一个',
      requestedMode: 'chat',
      candidateImages: [
        {
          fileName: 'old-result.png',
          mimeType: 'image/png',
          filePath: '/tmp/old-result.png',
        },
      ],
    });

    expect(getProviderSecretMock).not.toHaveBeenCalled();
    expect(getProviderAccountMock).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan.compositeTasks?.[4]).toEqual(expect.objectContaining({
      kind: 'image_edit',
      selectedImageSource: 'none',
      dependsOn: ['task-1-image_generate'],
      fallback: expect.stringContaining('本轮前序图片生成子任务'),
    }));
    expect(plan.compositeTasks?.[4].sourceImages).toBeUndefined();
  });

  it('chains composite image generation, image edit, and image-to-video dependencies in order', async () => {
    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '生成一张图，然后把这张图改成赛博朋克风，再基于改后的图生成 15 秒视频',
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
      'image_edit',
      'video_generate',
    ]);
    expect(plan.compositeTasks?.[1]).toEqual(expect.objectContaining({
      kind: 'image_edit',
      dependsOn: ['task-1-image_generate'],
    }));
    expect(plan.compositeTasks?.[2]).toEqual(expect.objectContaining({
      kind: 'video_generate',
      dependsOn: ['task-2-image_edit'],
      fallback: expect.stringContaining('前序图片生成或修图子任务'),
    }));
  });

  it('keeps composite sample packs from being swallowed by an image/video mode hint', async () => {
    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '生图，PPT，Excel，生视频，根据图片修图，做小程序，生成文案，每个事儿都随便给我来一个',
      requestedMode: 'video',
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
      reason: 'local_fast_path_image_mode_generate',
      prompt: '画一张城市夜景',
    }));
    expect(plan.compositeTasks).toBeUndefined();
  });

  it('keeps plain chat in image mode on chat without calling the LLM planner', async () => {
    const { planMediaIntent, isCurrentTurnMediaSideEffectAuthorized } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: 'hi',
      requestedMode: 'image',
    });

    expect(getProviderSecretMock).not.toHaveBeenCalled();
    expect(getProviderAccountMock).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      action: 'chat',
      source: 'fallback',
      intentKind: 'ordinary_chat',
      currentTurnMediaRequest: false,
      reason: 'local_non_media_plain_conversation',
      selectedImageSource: 'none',
      prompt: 'hi',
    }));
    expect(isCurrentTurnMediaSideEffectAuthorized(plan)).toBe(false);
  });

  it('keeps ambiguous media side effects on chat locally without remote planning', async () => {
    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '给我一个城市夜景视觉素材',
      requestedMode: 'chat',
    });

    expect(getProviderSecretMock).not.toHaveBeenCalled();
    expect(getProviderAccountMock).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      action: 'chat',
      source: 'fallback',
      reason: 'local_no_media_planning_signal',
      currentTurnMediaRequest: false,
      selectedImageSource: 'none',
    }));
  });

  it('keeps future sourcing preferences on chat without remote media planning', async () => {
    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '以后生成作品的时候，如果需要图片就从网上获取，如果需要公开数据就从网上获取。保存在记忆体里',
      requestedMode: 'chat',
    });

    expect(getProviderSecretMock).not.toHaveBeenCalled();
    expect(getProviderAccountMock).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      action: 'chat',
      source: 'fallback',
      currentTurnMediaRequest: false,
      reason: 'local_no_media_planning_signal',
      selectedImageSource: 'none',
    }));
  });

  it('keeps media model and capability questions on chat locally', async () => {
    const { planMediaIntent, isCurrentTurnMediaSideEffectAuthorized } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '我问你的是你用的生图模型是什么？',
      requestedMode: 'chat',
    });

    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      action: 'chat',
      source: 'fallback',
      intentKind: 'current_non_media_task',
      currentTurnMediaRequest: false,
      reason: 'local_non_media_media_meta_question',
      selectedImageSource: 'none',
    }));
    expect(isCurrentTurnMediaSideEffectAuthorized(plan)).toBe(false);
  });

  it('keeps image-mode capability lookup continuations on chat locally', async () => {
    const { planMediaIntent, isCurrentTurnMediaSideEffectAuthorized } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '好的 你查一下吧',
      requestedMode: 'image',
      recentMessages: [
        {
          role: 'user',
          text: '你用的生图模型是什么',
        },
        {
          role: 'assistant',
          text: '如果你要精确到模型 ID，我需要查一下当前 UClaw/OpenClaw 的生图配置或可用模型列表。',
        },
      ],
    });

    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      action: 'chat',
      source: 'fallback',
      intentKind: 'current_non_media_task',
      currentTurnMediaRequest: false,
      reason: 'local_non_media_meta_lookup_continuation',
      selectedImageSource: 'none',
    }));
    expect(isCurrentTurnMediaSideEffectAuthorized(plan)).toBe(false);
  });

  it.each([
    {
      prompt: '先别生成图片，帮我写 3 条适合生图的提示词',
      requestedMode: 'chat' as const,
      reason: 'local_non_media_media_reference_instruction',
      intentKind: 'current_non_media_task',
    },
    {
      prompt: '解释一下图片模式和普通聊天有什么区别',
      requestedMode: 'image' as const,
      reason: 'local_non_media_media_meta_question',
      intentKind: 'current_non_media_task',
    },
    {
      prompt: '我现在不生成视频，只想知道默认视频参数是什么',
      requestedMode: 'video' as const,
      reason: 'local_non_media_media_meta_question',
      intentKind: 'current_non_media_task',
    },
    {
      prompt: '以后我说做海报时，默认先找参考图，但这次别生成',
      requestedMode: 'chat' as const,
      reason: 'local_non_media_media_reference_instruction',
      intentKind: 'preference_or_memory_update',
    },
    {
      prompt: '图片模式里帮我写一段朋友圈文案',
      requestedMode: 'image' as const,
      reason: 'local_non_media_text_request_in_media_mode',
      intentKind: 'ordinary_chat',
    },
  ])('keeps mode-hint non-media prompt on chat: $prompt', async ({ prompt, requestedMode, reason, intentKind }) => {
    const { planMediaIntent, isCurrentTurnMediaSideEffectAuthorized } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt,
      requestedMode,
    });

    expect(getProviderSecretMock).not.toHaveBeenCalled();
    expect(getProviderAccountMock).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      action: 'chat',
      source: 'fallback',
      intentKind,
      currentTurnMediaRequest: false,
      reason,
      selectedImageSource: 'none',
      prompt,
    }));
    expect(isCurrentTurnMediaSideEffectAuthorized(plan)).toBe(false);
  });

  it('does not suppress an explicit redirected media request after a negated one', async () => {
    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '不要生成图片，只生成视频',
      requestedMode: 'chat',
    });

    expect(getProviderSecretMock).not.toHaveBeenCalled();
    expect(getProviderAccountMock).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      action: 'video_generate',
      source: 'fallback',
      intentKind: 'current_media_task',
      currentTurnMediaRequest: true,
      reason: 'local_fast_path_video_generate',
      selectedImageSource: 'none',
      videoMode: 'text_to_video',
      prompt: '不要生成图片，只生成视频',
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
      reason: 'local_fast_path_image_mode_edit',
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

  it('keeps ordinary chat local before checking planner credentials', async () => {
    getProviderSecretMock.mockResolvedValueOnce(null);

    const { planMediaIntent } = await import('@electron/utils/media-intent-planner');
    const plan = await planMediaIntent({
      prompt: '给我分析一下这个需求',
      requestedMode: 'chat',
    });

    expect(getProviderSecretMock).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(plan).toEqual(expect.objectContaining({
      action: 'chat',
      source: 'fallback',
      reason: 'local_no_media_planning_signal',
      currentTurnMediaRequest: false,
      selectedImageSource: 'none',
    }));
  });

});
