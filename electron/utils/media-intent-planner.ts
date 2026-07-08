import { getProviderAccount } from '../services/providers/provider-store';
import { getProviderSecret } from '../services/secrets/secret-store';
import {
  getJunFeiAIProviderBaseUrl,
  JUNFEIAI_DEFAULT_MODEL,
  JUNFEIAI_PROVIDER_ID,
} from './junfeiai-distribution';
import { logger } from './logger';
import type {
  MediaGenerationInputImageRef,
  VideoGenerationRouteMode,
} from './media-generation-types';
import { proxyAwareFetch } from './proxy-fetch';

const MEDIA_INTENT_PLANNER_TIMEOUT_MS = 60_000;
const MEDIA_INTENT_PLANNER_MIN_CONFIDENCE = 0.55;
const MAX_PLANNER_IMAGES = 5;
const MAX_RECENT_MESSAGES = 8;
const MAX_LOG_TEXT_CHARS = 800;

export type MediaIntentAction =
  | 'chat'
  | 'vision_chat'
  | 'image_generate'
  | 'image_edit'
  | 'video_generate'
  | 'desktop_screenshot'
  | 'clarify';

export type MediaIntentImageSource = 'explicit' | 'candidate' | 'none';
export type MediaIntentKind =
  | 'current_media_task'
  | 'current_non_media_task'
  | 'preference_or_memory_update'
  | 'ordinary_chat'
  | 'clarification';

export type MediaIntentCompositeTaskKind =
  | 'image_generate'
  | 'presentation'
  | 'spreadsheet'
  | 'video_generate'
  | 'image_edit'
  | 'mini_program'
  | 'copywriting';

export type MediaIntentCompositeTask = {
  id: string;
  kind: MediaIntentCompositeTaskKind;
  title: string;
  prompt: string;
  requiresArtifact?: boolean;
  dependsOn?: string[];
  fallback?: string;
  selectedImageSource?: MediaIntentImageSource;
  selectedImageIndex?: number;
  sourceImages?: MediaGenerationInputImageRef[];
};

export type MediaIntentRecentMessage = {
  role: 'user' | 'assistant' | 'system' | 'toolresult';
  text?: string;
  images?: MediaGenerationInputImageRef[];
};

export type MediaIntentPlan = {
  action: MediaIntentAction;
  source: 'planner' | 'fallback';
  intentKind?: MediaIntentKind;
  currentTurnMediaRequest?: boolean;
  confidence?: number;
  reason?: string;
  selectedImageSource?: MediaIntentImageSource;
  selectedImageIndex?: number;
  sourceImages?: MediaGenerationInputImageRef[];
  prompt?: string;
  imageSize?: string;
  imageQuality?: 'low' | 'medium' | 'high';
  videoMode?: VideoGenerationRouteMode;
  videoSize?: string;
  videoDurationSeconds?: number;
  videoPrompt?: string;
  imageEditPrompt?: string;
  clarification?: string;
  compositeTasks?: MediaIntentCompositeTask[];
};

type MediaIntentPlannerParams = {
  prompt: string;
  requestedMode?: 'chat' | 'image' | 'video';
  explicitImages?: MediaGenerationInputImageRef[];
  candidateImages?: MediaGenerationInputImageRef[];
  recentMessages?: MediaIntentRecentMessage[];
};

type PlannerImageSource = Exclude<MediaIntentImageSource, 'none'>;

function truncateForLog(text: string, maxChars = MAX_LOG_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function normalizeImageRefs(images: MediaGenerationInputImageRef[] | undefined): MediaGenerationInputImageRef[] {
  return (images ?? [])
    .filter((image) => typeof image?.filePath === 'string' && image.filePath.trim())
    .map((image) => ({
      fileName: image.fileName?.trim() || undefined,
      mimeType: image.mimeType?.trim() || undefined,
      filePath: image.filePath.trim(),
    }));
}

function summarizeImagesForLog(images: MediaGenerationInputImageRef[]): Array<Record<string, unknown>> {
  return images.map((image, index) => ({
    index,
    fileName: image.fileName || null,
    mimeType: image.mimeType || null,
    filePath: image.filePath,
  }));
}

function summarizePlanForLog(plan: MediaIntentPlan): Record<string, unknown> {
  return {
    action: plan.action,
    source: plan.source,
    intentKind: plan.intentKind,
    currentTurnMediaRequest: plan.currentTurnMediaRequest,
    confidence: plan.confidence,
    reason: plan.reason ? truncateForLog(plan.reason, 300) : undefined,
    selectedImageSource: plan.selectedImageSource,
    selectedImageIndex: plan.selectedImageIndex,
    sourceImages: summarizeImagesForLog(plan.sourceImages ?? []),
    prompt: plan.prompt ? truncateForLog(plan.prompt) : undefined,
    imageSize: plan.imageSize,
    imageQuality: plan.imageQuality,
    videoMode: plan.videoMode,
    videoSize: plan.videoSize,
    videoDurationSeconds: plan.videoDurationSeconds,
    videoPrompt: plan.videoPrompt ? truncateForLog(plan.videoPrompt) : undefined,
    imageEditPrompt: plan.imageEditPrompt ? truncateForLog(plan.imageEditPrompt) : undefined,
    clarification: plan.clarification ? truncateForLog(plan.clarification, 300) : undefined,
    compositeTasks: plan.compositeTasks?.map((task) => ({
      id: task.id,
      kind: task.kind,
      title: task.title,
      prompt: truncateForLog(task.prompt, 300),
      requiresArtifact: task.requiresArtifact,
      dependsOn: task.dependsOn,
      fallback: task.fallback,
      selectedImageSource: task.selectedImageSource,
      selectedImageIndex: task.selectedImageIndex,
      sourceImages: summarizeImagesForLog(task.sourceImages ?? []),
    })),
  };
}

function summarizeRawPlannerJsonForLog(raw: Record<string, unknown>): Record<string, unknown> {
  const prompt = raw.prompt ?? raw.rewritten_prompt ?? raw.rewrittenPrompt;
  return {
    action: raw.action,
    intent_kind: raw.intent_kind ?? raw.intentKind,
    current_turn_media_request: raw.current_turn_media_request ?? raw.currentTurnMediaRequest,
    confidence: raw.confidence,
    selected_image_source: raw.selected_image_source ?? raw.selectedImageSource,
    selected_image_index: raw.selected_image_index ?? raw.selectedImageIndex,
    prompt: typeof prompt === 'string' ? truncateForLog(prompt) : prompt,
    image_size: raw.image_size ?? raw.imageSize,
    image_quality: raw.image_quality ?? raw.imageQuality,
    video_mode: raw.video_mode ?? raw.videoMode,
    video_size: raw.video_size ?? raw.videoSize,
    video_duration_seconds: raw.video_duration_seconds ?? raw.videoDurationSeconds,
    video_prompt: raw.video_prompt ?? raw.videoPrompt,
    image_edit_prompt: raw.image_edit_prompt ?? raw.imageEditPrompt,
    clarification: typeof raw.clarification === 'string'
      ? truncateForLog(raw.clarification, 300)
      : raw.clarification,
    reason: typeof raw.reason === 'string' ? truncateForLog(raw.reason, 300) : raw.reason,
  };
}

function clampConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function normalizePrompt(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : fallback.trim();
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeImageQuality(value: unknown): 'low' | 'medium' | 'high' | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeVideoMode(value: unknown): VideoGenerationRouteMode | undefined {
  return value === 'text_to_video'
    || value === 'image_to_video'
    || value === 'edit_image_then_video'
    ? value
    : undefined;
}

function isIntentAction(value: unknown): value is MediaIntentAction {
  return value === 'chat'
    || value === 'vision_chat'
    || value === 'image_generate'
    || value === 'image_edit'
    || value === 'video_generate'
    || value === 'desktop_screenshot'
    || value === 'clarify';
}

function normalizeIntentKind(value: unknown): MediaIntentKind | undefined {
  return value === 'current_media_task'
    || value === 'current_non_media_task'
    || value === 'preference_or_memory_update'
    || value === 'ordinary_chat'
    || value === 'clarification'
    ? value
    : undefined;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isVisualQuestionPrompt(prompt: string): boolean {
  const referencesImage = /(?:这张|这幅|这个图|这图|图片|照片|画面|上一张|上一个|刚才|刚生成|previous|last|this image|this picture|this photo|the image|the picture)/i.test(prompt);
  const asksAboutImage = /(?:美吗|美嘛|好看吗|漂亮吗|丑吗|怎么样|咋样|如何|评价|点评|审美|哪里.*(?:好|不好|优化|改进)|what do you think|look good|beautiful|pretty|rate|review|critique|analy[sz]e)/i.test(prompt);
  return asksAboutImage || (referencesImage && /(?:看|分析|评价|点评|怎么样|如何|哪里|review|critique|analy[sz]e)/i.test(prompt));
}

function isImageSource(value: unknown): value is PlannerImageSource {
  return value === 'explicit' || value === 'candidate';
}

function getApiKey(secret: Awaited<ReturnType<typeof getProviderSecret>>): string | null {
  if (!secret) return null;
  if (secret.type === 'api_key' && secret.apiKey?.trim()) return secret.apiKey.trim();
  if (secret.type === 'local' && secret.apiKey?.trim()) return secret.apiKey.trim();
  return null;
}

function toChatCompletionsEndpoint(baseUrl: string): string {
  let normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    normalized = getJunFeiAIProviderBaseUrl().replace(/\/+$/, '');
  }
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  if (/\/responses?$/i.test(normalized)) return normalized.replace(/\/responses?$/i, '/chat/completions');
  if (!/\/v1$/i.test(normalized)) normalized = `${normalized}/v1`;
  return `${normalized}/chat/completions`;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function describeImages(images: MediaGenerationInputImageRef[]): Array<Record<string, unknown>> {
  return images.slice(0, MAX_PLANNER_IMAGES).map((image, index) => ({
    index,
    fileName: image.fileName || null,
    mimeType: image.mimeType || null,
  }));
}

function describeRecentMessages(messages: MediaIntentRecentMessage[] | undefined): Array<Record<string, unknown>> {
  return (messages ?? []).slice(-MAX_RECENT_MESSAGES).map((message) => ({
    role: message.role,
    text: message.text?.trim() ? message.text.trim().slice(0, 600) : '',
    images: describeImages(normalizeImageRefs(message.images)),
  }));
}

function fallbackPlan(reason: string): MediaIntentPlan {
  return {
    action: 'chat',
    source: 'fallback',
    confidence: 1,
    reason,
    selectedImageSource: 'none',
  };
}

function clarificationPlan(reason: string, clarification?: string): MediaIntentPlan {
  return {
    action: 'clarify',
    source: 'planner',
    confidence: 1,
    reason,
    selectedImageSource: 'none',
    clarification: clarification?.trim() || '你想编辑哪张图片？请上传或选中一张图片。',
  };
}

function compositePlan(tasks: MediaIntentCompositeTask[]): MediaIntentPlan {
  return {
    action: 'chat',
    source: 'fallback',
    confidence: 1,
    reason: 'composite_intent_local',
    selectedImageSource: 'none',
    compositeTasks: tasks,
  };
}

function selectImage(params: {
  selectedImageSource: unknown;
  selectedImageIndex: unknown;
  explicitImages: MediaGenerationInputImageRef[];
  candidateImages: MediaGenerationInputImageRef[];
}): {
  selectedImageSource: MediaIntentImageSource;
  selectedImageIndex?: number;
  sourceImages?: MediaGenerationInputImageRef[];
} {
  if (!isImageSource(params.selectedImageSource)) {
    return { selectedImageSource: 'none' };
  }

  const images = params.selectedImageSource === 'explicit'
    ? params.explicitImages
    : params.candidateImages;
  if (images.length === 0) {
    return { selectedImageSource: 'none' };
  }

  const rawIndex = typeof params.selectedImageIndex === 'number' && Number.isFinite(params.selectedImageIndex)
    ? Math.floor(params.selectedImageIndex)
    : 0;
  const index = rawIndex >= 0 && rawIndex < Math.min(images.length, MAX_PLANNER_IMAGES)
    ? rawIndex
    : 0;

  return {
    selectedImageSource: params.selectedImageSource,
    selectedImageIndex: index,
    sourceImages: [images[index]!],
  };
}

function selectPreferredImage(params: {
  selectedImageSource: unknown;
  selectedImageIndex: unknown;
  explicitImages: MediaGenerationInputImageRef[];
  candidateImages: MediaGenerationInputImageRef[];
}): {
  selectedImageSource: MediaIntentImageSource;
  selectedImageIndex?: number;
  sourceImages?: MediaGenerationInputImageRef[];
} {
  const selected = selectImage(params);
  if (selected.sourceImages?.length) return selected;
  const fallbackSource: MediaIntentImageSource = params.explicitImages.length > 0
    ? 'explicit'
    : (params.candidateImages.length > 0 ? 'candidate' : 'none');
  if (fallbackSource === 'none') return { selectedImageSource: 'none' };
  return selectImage({
    ...params,
    selectedImageSource: fallbackSource,
    selectedImageIndex: 0,
  });
}

function containsCompositeSeparator(prompt: string): boolean {
  return /[、,，;；]/.test(prompt)
    || /(?:以及|并且|同时|顺便|再(?:帮我)?|然后|另外|还有|和|与|\band\b|\bthen\b|\balso\b)/i.test(prompt);
}

function taskPrompt(prompt: string, fallback: string): string {
  return prompt.trim() || fallback;
}

function buildCompositeTask(params: {
  index: number;
  kind: MediaIntentCompositeTaskKind;
  title: string;
  prompt: string;
  requiresArtifact?: boolean;
  dependsOn?: string[];
  fallback?: string;
  imageSelection?: ReturnType<typeof selectPreferredImage>;
}): MediaIntentCompositeTask {
  return {
    id: `task-${params.index + 1}-${params.kind}`,
    kind: params.kind,
    title: params.title,
    prompt: params.prompt,
    requiresArtifact: params.requiresArtifact ?? true,
    ...(params.dependsOn?.length ? { dependsOn: params.dependsOn } : {}),
    ...(params.fallback ? { fallback: params.fallback } : {}),
    ...(params.imageSelection
      ? {
        selectedImageSource: params.imageSelection.selectedImageSource,
        ...(typeof params.imageSelection.selectedImageIndex === 'number'
          ? { selectedImageIndex: params.imageSelection.selectedImageIndex }
          : {}),
        ...(params.imageSelection.sourceImages?.length
          ? { sourceImages: params.imageSelection.sourceImages }
          : {}),
      }
      : {}),
  };
}

function detectCompositeTasks(params: {
  prompt: string;
  requestedMode: 'chat' | 'image' | 'video';
  explicitImages: MediaGenerationInputImageRef[];
  candidateImages: MediaGenerationInputImageRef[];
}): MediaIntentCompositeTask[] {
  if (params.requestedMode !== 'chat') return [];
  const prompt = params.prompt.trim();
  if (!prompt) return [];

  const normalized = prompt.toLowerCase();
  const imageSelection = selectPreferredImage({
    selectedImageSource: params.explicitImages.length > 0 ? 'explicit' : 'candidate',
    selectedImageIndex: 0,
    explicitImages: params.explicitImages,
    candidateImages: params.candidateImages,
  });
  const specs: Array<{
    kind: MediaIntentCompositeTaskKind;
    title: string;
    pattern: RegExp;
    needsImage?: boolean;
    prompt: string;
  }> = [
    {
      kind: 'image_edit',
      title: '根据图片修图',
      pattern: /(?:根据|基于|用|把|将|给)?(?:这张|这幅|这个图|图片|照片|image|picture|photo).*(?:修图|改图|精修|调整|优化|编辑|换背景|去背景|抠图|加上|去掉|edit|retouch|modify)|(?:修图|改图|精修|edit image|image edit|retouch)/i,
      needsImage: true,
      prompt: taskPrompt(prompt, '根据图片修图'),
    },
    {
      kind: 'image_generate',
      title: '生成图片',
      pattern: /(?:生图|生成(?:一张|几张)?图|画(?:一张|个)?|出图|做(?:一张)?(?:海报|插画|图片)|image generation|generate (?:an? )?image|create (?:an? )?image)/i,
      prompt: taskPrompt(prompt, '生成图片'),
    },
    {
      kind: 'presentation',
      title: '制作 PPT',
      pattern: /(?:ppt|powerpoint|slides?|幻灯片|演示文稿|路演稿|汇报材料|做(?:一份)?(?:PPT|ppt|幻灯片))/i,
      prompt: taskPrompt(prompt, '制作 PPT'),
    },
    {
      kind: 'spreadsheet',
      title: '制作 Excel',
      pattern: /(?:excel|xlsx|spreadsheet|表格|电子表格|数据表|做(?:一份)?(?:Excel|excel|表格)|整理(?:成)?表)/i,
      prompt: taskPrompt(prompt, '制作 Excel 表格'),
    },
    {
      kind: 'video_generate',
      title: '生成视频',
      pattern: /(?:生视频|生成(?:一段|个)?视频|做(?:一段|个)?视频|视频生成|图生视频|动画|动起来|video generation|generate (?:a )?video|create (?:a )?video)/i,
      prompt: taskPrompt(prompt, '生成视频'),
    },
    {
      kind: 'mini_program',
      title: '制作小程序',
      pattern: /(?:小程序|微信小程序|支付宝小程序|mini\s*program|wechat mini)/i,
      prompt: taskPrompt(prompt, '制作小程序'),
    },
    {
      kind: 'copywriting',
      title: '撰写文案',
      pattern: /(?:文案|宣传语|标题|slogan|海报词|卖点|推广语|营销文|广告语|copywriting|copywriter|write copy|ad copy)/i,
      prompt: taskPrompt(prompt, '撰写文案'),
    },
  ];

  const matches = specs
    .map((spec, specIndex) => {
      const match = normalized.match(spec.pattern);
      return match
        ? { spec, specIndex, matchIndex: match.index ?? Number.MAX_SAFE_INTEGER }
        : null;
    })
    .filter((match): match is NonNullable<typeof match> => Boolean(match))
    .sort((left, right) => (left.matchIndex - right.matchIndex) || (left.specIndex - right.specIndex));

  const tasks = matches.map(({ spec }, index) => buildCompositeTask({
      index,
      kind: spec.kind,
      title: spec.title,
      prompt: spec.prompt,
      imageSelection: spec.needsImage ? imageSelection : undefined,
      fallback: spec.needsImage
        ? '没有显式输入图时，优先使用本轮前序图片生成子任务的结果；仍不可用时标记该子任务待补输入，并继续执行其他子任务。'
        : undefined,
    }));

  for (const [index, task] of tasks.entries()) {
    if (task.kind !== 'image_edit' || task.sourceImages?.length) continue;
    let dependency: MediaIntentCompositeTask | undefined;
    for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const candidate = tasks[candidateIndex];
      if (candidate?.kind === 'image_generate') {
        dependency = candidate;
        break;
      }
    }
    if (dependency) {
      task.dependsOn = [dependency.id];
    }
  }

  if (tasks.length < 2) return [];
  return containsCompositeSeparator(prompt) ? tasks : [];
}

function normalizePlannerDecision(params: {
  raw: Record<string, unknown>;
  prompt: string;
  explicitImages: MediaGenerationInputImageRef[];
  candidateImages: MediaGenerationInputImageRef[];
}): MediaIntentPlan | null {
  const action = params.raw.action;
  if (!isIntentAction(action)) return null;

  const confidence = clampConfidence(params.raw.confidence) ?? 0;
  if (confidence < MEDIA_INTENT_PLANNER_MIN_CONFIDENCE) return null;

  const intentKind = normalizeIntentKind(params.raw.intent_kind ?? params.raw.intentKind);
  const currentTurnMediaRequest = normalizeOptionalBoolean(
    params.raw.current_turn_media_request ?? params.raw.currentTurnMediaRequest,
  );
  const reason = normalizeOptionalText(params.raw.reason);
  const selectedImageSource = params.raw.selected_image_source ?? params.raw.selectedImageSource;
  const selectedImageIndex = params.raw.selected_image_index ?? params.raw.selectedImageIndex;
  const prompt = normalizePrompt(
    params.raw.prompt ?? params.raw.rewritten_prompt ?? params.raw.rewrittenPrompt,
    params.prompt,
  );
  const imageSize = normalizeOptionalText(params.raw.image_size ?? params.raw.imageSize);
  const imageQuality = normalizeImageQuality(params.raw.image_quality ?? params.raw.imageQuality);
  const videoSize = normalizeOptionalText(params.raw.video_size ?? params.raw.videoSize);
  const videoDurationSeconds = normalizePositiveInteger(
    params.raw.video_duration_seconds ?? params.raw.videoDurationSeconds,
  );
  const rawVideoMode = normalizeVideoMode(params.raw.video_mode ?? params.raw.videoMode);
  const videoPrompt = normalizePrompt(params.raw.video_prompt ?? params.raw.videoPrompt, prompt);
  const imageEditPrompt = normalizePrompt(
    params.raw.image_edit_prompt ?? params.raw.imageEditPrompt,
    prompt,
  );

  const isMediaSideEffectAction = action === 'image_generate'
    || action === 'image_edit'
    || action === 'video_generate'
    || action === 'desktop_screenshot';
  const plannerAuthorizesCurrentMedia = intentKind === 'current_media_task'
    && currentTurnMediaRequest === true;
  if (isMediaSideEffectAction && !plannerAuthorizesCurrentMedia) {
    return {
      action: 'chat',
      source: 'planner',
      intentKind,
      currentTurnMediaRequest,
      confidence,
      reason: reason || 'planner_missing_current_media_authorization',
      selectedImageSource: 'none',
      prompt,
    };
  }

  if (action === 'vision_chat') {
    const imageSelection = selectPreferredImage({
      selectedImageSource,
      selectedImageIndex,
      explicitImages: params.explicitImages,
      candidateImages: params.candidateImages,
    });
    if (!imageSelection.sourceImages?.length) {
      return clarificationPlan('vision_chat_missing_input_image', normalizeOptionalText(params.raw.clarification));
    }
    return {
      action,
      source: 'planner',
      intentKind,
      currentTurnMediaRequest,
      confidence,
      reason,
      selectedImageSource: imageSelection.selectedImageSource,
      selectedImageIndex: imageSelection.selectedImageIndex,
      sourceImages: imageSelection.sourceImages,
      prompt,
    };
  }

  if (action === 'image_edit') {
    const imageSelection = selectImage({
      selectedImageSource,
      selectedImageIndex,
      explicitImages: params.explicitImages,
      candidateImages: params.candidateImages,
    });
    if (!imageSelection.sourceImages?.length) {
      return clarificationPlan('image_edit_missing_input_image', normalizeOptionalText(params.raw.clarification));
    }
    return {
      action,
      source: 'planner',
      intentKind,
      currentTurnMediaRequest,
      confidence,
      reason,
      selectedImageSource: imageSelection.selectedImageSource,
      selectedImageIndex: imageSelection.selectedImageIndex,
      sourceImages: imageSelection.sourceImages,
      prompt,
      imageSize,
      imageQuality,
    };
  }

  if (action === 'video_generate') {
    const imageSelection = selectImage({
      selectedImageSource,
      selectedImageIndex,
      explicitImages: params.explicitImages,
      candidateImages: params.candidateImages,
    });
    const videoMode = rawVideoMode
      ?? (imageSelection.sourceImages?.length ? 'image_to_video' : 'text_to_video');
    if (videoMode !== 'text_to_video' && !imageSelection.sourceImages?.length) {
      return clarificationPlan('video_generate_missing_input_image', normalizeOptionalText(params.raw.clarification));
    }
    return {
      action,
      source: 'planner',
      intentKind,
      currentTurnMediaRequest,
      confidence,
      reason,
      selectedImageSource: imageSelection.selectedImageSource,
      selectedImageIndex: imageSelection.selectedImageIndex,
      sourceImages: imageSelection.sourceImages,
      prompt,
      videoMode,
      videoSize,
      videoDurationSeconds,
      videoPrompt,
      imageEditPrompt: videoMode === 'edit_image_then_video' ? imageEditPrompt : undefined,
    };
  }

  if (action === 'clarify') {
    return clarificationPlan(reason || 'planner_requested_clarification', normalizeOptionalText(params.raw.clarification));
  }

  if (
    action === 'chat'
    && isVisualQuestionPrompt(params.prompt)
    && (params.explicitImages.length > 0 || params.candidateImages.length > 0)
  ) {
    const imageSelection = selectPreferredImage({
      selectedImageSource,
      selectedImageIndex,
      explicitImages: params.explicitImages,
      candidateImages: params.candidateImages,
    });
    if (imageSelection.sourceImages?.length) {
      return {
        action: 'vision_chat',
        source: 'planner',
        intentKind,
        currentTurnMediaRequest,
        confidence,
        reason: reason || 'chat_with_referenced_image',
        selectedImageSource: imageSelection.selectedImageSource,
        selectedImageIndex: imageSelection.selectedImageIndex,
        sourceImages: imageSelection.sourceImages,
        prompt,
      };
    }
  }

  return {
    action,
    source: 'planner',
    intentKind,
    currentTurnMediaRequest,
    confidence,
    reason,
    selectedImageSource: 'none',
    prompt,
    imageSize,
    imageQuality,
    videoSize,
    videoDurationSeconds,
  };
}

function buildPlannerMessages(params: {
  prompt: string;
  requestedMode: 'chat' | 'image' | 'video';
  explicitImages: MediaGenerationInputImageRef[];
  candidateImages: MediaGenerationInputImageRef[];
  recentMessages?: MediaIntentRecentMessage[];
}): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: [
        'You are UClaw media/tool intent planner. Return strict JSON only.',
        'Your job is to decide whether the next step should be normal chat, visual chat about an existing image, still-image generation, still-image editing, video generation, desktop screenshot capture, or a clarification question.',
        'Do not answer the user. Do not execute tools. Only produce the route plan.',
        'First decide whether the user is requesting an immediate media side effect in this current turn.',
        'Set intent_kind to one of: current_media_task, current_non_media_task, preference_or_memory_update, ordinary_chat, clarification.',
        'Set current_turn_media_request=true only when the current user message itself asks to create, edit, inspect, capture, or animate media now.',
        'Future/default behavior, memory/profile/preference updates, and instructions about how to source images or public data for later generated works are preference_or_memory_update with current_turn_media_request=false.',
        'Actions: chat, vision_chat, image_generate, image_edit, video_generate, desktop_screenshot, clarify.',
        'Only choose image_generate, image_edit, video_generate, or desktop_screenshot when intent_kind=current_media_task and current_turn_media_request=true.',
        'Use chat for explanations, research/search requests, planning, automation workflows, coding, and requests that do not require immediate media tool execution.',
        'Use chat for preference_or_memory_update even when the text mentions images, web sources, public data, or generated works.',
        'Use vision_chat when the user asks to inspect, evaluate, describe, compare, rate, or suggest improvements for an existing image. vision_chat MUST select exactly one explicit_images or candidate_images item.',
        'Use image_generate only when the user wants a new still image from text.',
        'Use image_edit only when the user wants to change an existing image. image_edit MUST select exactly one explicit_images or candidate_images item.',
        'If the user asks to edit "this image", "it", "the previous image", or similar but no usable image exists, use clarify. Never downgrade image_edit to image_generate.',
        'Use explicit_images before candidate_images. Use candidate_images only when the user clearly refers to current/recent/previous image context.',
        'Use video_generate only when the user wants video creation, animation, or image-to-video.',
        'For video_generate, also choose video_mode: text_to_video, image_to_video, or edit_image_then_video.',
        'Use edit_image_then_video when the image should be changed first, then animated.',
        'Use image_to_video when the selected image should be animated or used as the visual base without a separate still-image edit.',
        'Use desktop_screenshot only for a direct request to capture the current desktop/screen. Use chat for broader browser automation or local workflow tasks.',
        'Extract media parameters only when the user explicitly asks for them: image_size, image_quality, video_size, video_duration_seconds. Leave them null otherwise.',
        'Never invent model names. Use only the user-requested size/quality/duration values you can infer from the text.',
        'requested_mode is a UI hint, not a substitute for reasoning. Respect image/video mode when it is compatible with the prompt; otherwise choose clarify or chat.',
        'Return JSON schema: {"action":"chat|vision_chat|image_generate|image_edit|video_generate|desktop_screenshot|clarify","intent_kind":"current_media_task|current_non_media_task|preference_or_memory_update|ordinary_chat|clarification","current_turn_media_request":boolean,"confidence":0-1,"selected_image_source":"explicit|candidate|none","selected_image_index":number|null,"prompt":string|null,"image_size":string|null,"image_quality":"low|medium|high|null","video_mode":"text_to_video|image_to_video|edit_image_then_video|null","video_size":string|null,"video_duration_seconds":number|null,"video_prompt":string|null,"image_edit_prompt":string|null,"clarification":string|null,"reason":string}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        prompt: params.prompt,
        requested_mode: params.requestedMode,
        explicit_images: describeImages(params.explicitImages),
        candidate_images: describeImages(params.candidateImages),
        recent_messages: describeRecentMessages(params.recentMessages),
      }),
    },
  ];
}

export async function planMediaIntent(
  params: MediaIntentPlannerParams,
): Promise<MediaIntentPlan> {
  const startedAt = Date.now();
  const prompt = params.prompt.trim();
  const requestedMode = params.requestedMode ?? 'chat';
  const explicitImages = normalizeImageRefs(params.explicitImages);
  const candidateImages = normalizeImageRefs(params.candidateImages);

  logger.info('[media-intent-planner] start', {
    timeoutMs: MEDIA_INTENT_PLANNER_TIMEOUT_MS,
    requestedMode,
    prompt: truncateForLog(prompt),
    explicitImages: summarizeImagesForLog(explicitImages),
    candidateImages: summarizeImagesForLog(candidateImages),
  });

  const compositeTasks = detectCompositeTasks({
    prompt,
    requestedMode,
    explicitImages,
    candidateImages,
  });
  if (compositeTasks.length > 0) {
    const plan = compositePlan(compositeTasks);
    logger.info('[media-intent-planner] composite_local', {
      durationMs: Date.now() - startedAt,
      plan: summarizePlanForLog(plan),
    });
    return plan;
  }

  try {
    const secret = await getProviderSecret(JUNFEIAI_PROVIDER_ID);
    const apiKey = getApiKey(secret);
    if (!apiKey) {
      const plan = fallbackPlan('planner_api_key_unavailable');
      logger.warn('[media-intent-planner] fallback', {
        durationMs: Date.now() - startedAt,
        plan: summarizePlanForLog(plan),
      });
      return plan;
    }

    const account = await getProviderAccount(JUNFEIAI_PROVIDER_ID);
    const endpoint = toChatCompletionsEndpoint(account?.baseUrl || getJunFeiAIProviderBaseUrl());
    const model = account?.model?.trim() || JUNFEIAI_DEFAULT_MODEL;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MEDIA_INTENT_PLANNER_TIMEOUT_MS);
    logger.info('[media-intent-planner] request', {
      endpoint,
      model,
      requestedMode,
      promptChars: prompt.length,
      explicitImageCount: explicitImages.length,
      candidateImageCount: candidateImages.length,
    });

    try {
      const response = await proxyAwareFetch(endpoint, {
        method: 'POST',
        headers: {
          ...(account?.headers ?? {}),
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: buildPlannerMessages({
            prompt,
            requestedMode,
            explicitImages,
            candidateImages,
            recentMessages: params.recentMessages,
          }),
          temperature: 0,
          max_tokens: 350,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const plan = fallbackPlan(`planner_http_${response.status}`);
        logger.warn('[media-intent-planner] response_not_ok', {
          status: response.status,
          durationMs: Date.now() - startedAt,
          body: body ? truncateForLog(body) : undefined,
          plan: summarizePlanForLog(plan),
        });
        return plan;
      }

      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      const parsed = typeof content === 'string' ? parseJsonObject(content) : null;
      if (!parsed) {
        const plan = fallbackPlan('planner_invalid_json');
        logger.warn('[media-intent-planner] invalid_json', {
          durationMs: Date.now() - startedAt,
          content: typeof content === 'string' ? truncateForLog(content) : content,
          plan: summarizePlanForLog(plan),
        });
        return plan;
      }
      logger.info('[media-intent-planner] raw_decision', {
        durationMs: Date.now() - startedAt,
        raw: summarizeRawPlannerJsonForLog(parsed),
      });

      const planned = normalizePlannerDecision({
        raw: parsed,
        prompt,
        explicitImages,
        candidateImages,
      });
      if (!planned) {
        const plan = fallbackPlan('planner_low_confidence_or_invalid_action');
        logger.warn('[media-intent-planner] invalid_plan', {
          durationMs: Date.now() - startedAt,
          plan: summarizePlanForLog(plan),
        });
        return plan;
      }

      logger.info('[media-intent-planner] planned', {
        durationMs: Date.now() - startedAt,
        plan: summarizePlanForLog(planned),
      });
      return planned;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const plan = fallbackPlan('planner_exception');
    logger.warn('[media-intent-planner] exception', {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      plan: summarizePlanForLog(plan),
    });
    return plan;
  }
}
