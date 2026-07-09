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

const MEDIA_INTENT_PLANNER_TIMEOUT_MS = 15_000;
const MEDIA_INTENT_PLANNER_MIN_CONFIDENCE = 0.55;
const MAX_PLANNER_IMAGES = 5;
const MAX_RECENT_MESSAGES = 8;
const MAX_LOG_TEXT_CHARS = 800;
const MAX_COMPOSITE_TASKS_PER_KIND = 5;

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

export function isMediaSideEffectAction(action: MediaIntentAction | undefined): boolean {
  return action === 'image_generate'
    || action === 'image_edit'
    || action === 'video_generate'
    || action === 'desktop_screenshot';
}

export function isCurrentTurnMediaSideEffectAuthorized(plan: Pick<MediaIntentPlan, 'action' | 'intentKind' | 'currentTurnMediaRequest'>): boolean {
  return isMediaSideEffectAction(plan.action)
    && plan.intentKind === 'current_media_task'
    && plan.currentTurnMediaRequest === true;
}

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

function mergeImageRefs(
  primary: MediaGenerationInputImageRef[],
  fallback: MediaGenerationInputImageRef[],
): MediaGenerationInputImageRef[] {
  const seenPaths = new Set<string>();
  return [...primary, ...fallback].filter((image) => {
    if (seenPaths.has(image.filePath)) return false;
    seenPaths.add(image.filePath);
    return true;
  });
}

function getMostRecentAssistantImages(
  messages: MediaIntentRecentMessage[] | undefined,
): MediaGenerationInputImageRef[] {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages?.[index];
    if (message?.role !== 'assistant') continue;
    const images = normalizeImageRefs(message.images);
    if (images.length > 0) return images;
  }
  return [];
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
  const rawCompositeTasks = raw.composite_tasks ?? raw.compositeTasks;
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
    composite_tasks: Array.isArray(rawCompositeTasks)
      ? rawCompositeTasks.slice(0, 35).map((task) => {
        if (!task || typeof task !== 'object' || Array.isArray(task)) return task;
        const record = task as Record<string, unknown>;
        return {
          id: record.id,
          kind: record.kind,
          title: record.title,
          prompt: typeof record.prompt === 'string' ? truncateForLog(record.prompt, 300) : record.prompt,
          requires_artifact: record.requires_artifact ?? record.requiresArtifact,
          depends_on: record.depends_on ?? record.dependsOn,
          fallback: record.fallback,
          selected_image_source: record.selected_image_source ?? record.selectedImageSource,
          selected_image_index: record.selected_image_index ?? record.selectedImageIndex,
        };
      })
      : rawCompositeTasks,
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

function isCompositeTaskKind(value: unknown): value is MediaIntentCompositeTaskKind {
  return value === 'image_generate'
    || value === 'presentation'
    || value === 'spreadsheet'
    || value === 'video_generate'
    || value === 'image_edit'
    || value === 'mini_program'
    || value === 'copywriting';
}

function isVisualQuestionCuePrompt(prompt: string): boolean {
  return /(?:美吗|美嘛|好看吗|漂亮吗|丑吗|怎么样|咋样|如何|评价|点评|审美|哪里.*(?:好|不好|优化|改进)|看一下|看看|帮我看|分析一下|what do you think|look good|beautiful|pretty|rate|review|critique|analy[sz]e)/i.test(prompt);
}

function isVisualQuestionPrompt(prompt: string): boolean {
  const referencesImage = /(?:这张|这幅|这个图|这图|图片|照片|画面|上一张|上一个|刚才|刚生成|previous|last|this image|this picture|this photo|the image|the picture)/i.test(prompt);
  return referencesImage && isVisualQuestionCuePrompt(prompt);
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

function fallbackPlan(
  reason: string,
  prompt = '',
): MediaIntentPlan {
  return {
    action: 'chat',
    source: 'fallback',
    intentKind: 'ordinary_chat',
    currentTurnMediaRequest: false,
    confidence: 1,
    reason,
    selectedImageSource: 'none',
    prompt: prompt.trim(),
  };
}

function localChatPlan(reason: string, prompt: string, intentKind: MediaIntentKind = 'ordinary_chat'): MediaIntentPlan {
  return {
    action: 'chat',
    source: 'fallback',
    intentKind,
    currentTurnMediaRequest: false,
    confidence: 1,
    reason,
    selectedImageSource: 'none',
    prompt: prompt.trim(),
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

function compositePlan(
  tasks: MediaIntentCompositeTask[],
  options: {
    source?: 'planner' | 'fallback';
    confidence?: number;
    reason?: string;
  } = {},
): MediaIntentPlan {
  const hasMediaTask = tasks.some((task) => (
    task.kind === 'image_generate'
    || task.kind === 'image_edit'
    || task.kind === 'video_generate'
  ));
  return {
    action: 'chat',
    source: options.source ?? 'fallback',
    intentKind: hasMediaTask ? 'current_media_task' : 'current_non_media_task',
    currentTurnMediaRequest: hasMediaTask,
    confidence: options.confidence ?? 1,
    reason: options.reason ?? 'composite_intent_local',
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

type CompositeTaskMatch = {
  spec: {
    kind: MediaIntentCompositeTaskKind;
    title: string;
    pattern: RegExp;
    needsImage?: boolean;
    prompt: string;
  };
  specIndex: number;
  matchIndex: number;
  matchText: string;
};

function compositePromptClause(
  prompt: string,
  match: CompositeTaskMatch,
  allMatches: CompositeTaskMatch[],
): string {
  const separators = /[、,，;；。\n]+|(?:以及|并且|同时|顺便|再(?:帮我)?|然后|另外|还有)|\b(?:and|then|also)\b/giu;
  let start = 0;
  let end = prompt.length;
  for (const separator of prompt.matchAll(separators)) {
    const separatorIndex = separator.index ?? 0;
    if (separatorIndex < match.matchIndex) {
      start = separatorIndex + separator[0].length;
      continue;
    }
    end = separatorIndex;
    break;
  }
  const matchesInClause = allMatches.filter((candidate) => (
    candidate.matchIndex >= start && candidate.matchIndex < end
  ));
  const clause = prompt.slice(start, end).trim();
  if (clause && matchesInClause.length === 1) return clause;
  return match.matchText.trim() || match.spec.prompt;
}

function videoTaskNeedsImageDependency(prompt: string): boolean {
  return /(?:图生视频|图片?生成视频|照片生成视频|让(?:这张|图片|照片).{0,16}(?:动起来|生成视频)|基于.{0,20}(?:图|图片|照片)|用.{0,20}(?:图|图片|照片)|这张|这幅|这个图|刚生成|上一张|修图后|编辑后|image[- ]?to[- ]?video|animate (?:this|the) image)/iu.test(prompt);
}

function hasCompositeBatchExecutionDirective(prompt: string): boolean {
  return /(?:每(?:个|种|项|件)(?:事(?:儿)?|任务)?|各(?:个|种|项|自)|分别|一一|全都|都).{0,32}(?:给我|帮我|请)?(?:随便)?(?:来|做|制作|生成|创建|写|出)(?:.{0,12})?(?:一个|一份|一版|一下)?/iu.test(prompt)
    || /(?:来|做|制作|生成|创建|写|出)(?:一个|一份|一版).{0,24}(?:每(?:个|种|项)|各(?:个|种|项|自)|分别)/iu.test(prompt);
}

function isCompositeKnowledgeQuestion(prompt: string): boolean {
  return /(?:有什么区别|区别是什么|如何|怎么|怎样|为什么|是什么|能不能|能否|是否|可以吗|支持吗|有哪些|介绍一下|解释一下|教程|流程|原理|优缺点|哪个好|怎么选)|\b(?:can|could|would|what|which|how|why|do you support|are you able)\b/iu.test(prompt);
}

function hasImmediateExecutionDirective(prompt: string): boolean {
  return /(?:帮我|给我|请|直接|现在|马上|立刻|替我|来)(?:.{0,20})(?:生成|生图|出图|画|制作|创建|开发|搭建|修图|改图|写|撰写|整理)/iu.test(prompt)
    || /^(?:生成|生图|出图|画|制作|创建|开发|搭建|修图|改图|写|撰写|整理)(?:.{0,24})/iu.test(prompt.trim())
    || /(?:please|now|directly|go ahead and).{0,20}(?:generate|create|make|build|edit|write)/iu.test(prompt)
    || /^(?:generate|create|make|build|edit|write)\b/iu.test(prompt.trim());
}

function isCapabilityOrKnowledgeOnlyPrompt(prompt: string): boolean {
  const mentionsPlannableCapability = /(?:图|图片|图像|照片|生图|修图|视频|动画|ppt|powerpoint|slides?|幻灯片|excel|xlsx|spreadsheet|表格|小程序|文案|截图|image|picture|photo|video|mini\s*program|copywriting|screenshot)/iu.test(prompt);
  if (!mentionsPlannableCapability) return false;
  const explicitlyAsksCapability = /(?:你|当前|现在|目前)?(?:能不能|能否|是否|可不可以|可以吗|支持吗|会不会|会吗)|你(?:能|会|可以).{0,30}(?:吗|么|？|\?)|(?:能力|功能|支持).{0,16}(?:哪些|什么|吗|么)|\b(?:can|could|would)\s+you\b|\bdo\s+you\s+support\b|\bare\s+you\s+able\b/iu.test(prompt);
  if (explicitlyAsksCapability) return !hasImmediateExecutionDirective(prompt);
  return isCompositeKnowledgeQuestion(prompt) && !hasImmediateExecutionDirective(prompt);
}

function normalizeExplicitTaskCount(value: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  const chineseCounts: Record<string, number> = {
    '二': 2,
    '两': 2,
    '三': 3,
    '四': 4,
    '五': 5,
    '六': 6,
    '七': 7,
    '八': 8,
    '九': 9,
    '十': 10,
  };
  const parsed = chineseCounts[normalized] ?? Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 2) return undefined;
  return Math.min(MAX_COMPOSITE_TASKS_PER_KIND, parsed);
}

function explicitCompositeTaskCount(
  prompt: string,
  match: CompositeTaskMatch,
): number {
  const countToken = '([2-9][0-9]*|[\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341])';
  const nounByKind: Record<MediaIntentCompositeTaskKind, string> = {
    image_generate: '(?:\u56fe|\u56fe\u7247|\u7167\u7247|\u6d77\u62a5|\u63d2\u753b|\u5934\u50cf|\u58c1\u7eb8|images?|pictures?|posters?|illustrations?)',
    image_edit: '(?:\u56fe|\u56fe\u7247|\u7167\u7247|images?|pictures?|photos?)',
    presentation: '(?:ppt|powerpoints?|slides?|\u5e7b\u706f\u7247|\u6f14\u793a\u6587\u7a3f|\u6c47\u62a5\u6750\u6599)',
    spreadsheet: '(?:excel|xlsx|spreadsheets?|\u8868\u683c|\u7535\u5b50\u8868\u683c|\u6570\u636e\u8868)',
    video_generate: '(?:\u89c6\u9891|\u52a8\u753b|videos?|animations?)',
    mini_program: '(?:\u5c0f\u7a0b\u5e8f|mini\\s*programs?|wechat\\s+mini)',
    copywriting: '(?:\u6587\u6848|\u5ba3\u4f20\u8bed|\u6807\u9898|slogans?|copywriting|ad\\s+cop(?:y|ies))',
  };
  const unitsByKind: Record<MediaIntentCompositeTaskKind, string> = {
    image_generate: '(?:\u5f20|\u5e45|\u4e2a)?',
    image_edit: '(?:\u5f20|\u5e45|\u4e2a)?',
    presentation: '(?:\u4efd|\u5957|\u4e2a)?',
    spreadsheet: '(?:\u4efd|\u5957|\u5f20|\u4e2a)?',
    video_generate: '(?:\u4e2a|\u6bb5|\u6761)?',
    mini_program: '(?:\u4e2a|\u5957)?',
    copywriting: '(?:\u4efd|\u7248|\u6761|\u7bc7|\u4e2a)?',
  };
  const pattern = new RegExp(`${countToken}\\s*${unitsByKind[match.spec.kind]}\\s*${nounByKind[match.spec.kind]}`, 'iu');
  const matchTextCount = match.matchText.match(pattern)?.[1];
  if (matchTextCount) return normalizeExplicitTaskCount(matchTextCount) ?? 1;

  const actionCountPattern = new RegExp(
    `(?:生成|创建|制作|做|画|来|出|generate|create|make)\\s*${countToken}\\s*${unitsByKind[match.spec.kind]}`,
    'iu',
  );
  const actionCount = prompt.match(actionCountPattern)?.[1];
  if (actionCount) return normalizeExplicitTaskCount(actionCount) ?? 1;

  const contextStart = Math.max(0, match.matchIndex - 24);
  const contextEnd = Math.min(prompt.length, match.matchIndex + match.matchText.length + 24);
  const contextCount = prompt.slice(contextStart, contextEnd).match(pattern)?.[1];
  return contextCount ? (normalizeExplicitTaskCount(contextCount) ?? 1) : 1;
}

function explicitlyRequestsCompositeTask(prompt: string, kind: MediaIntentCompositeTaskKind): boolean {
  if (kind === 'image_generate' || kind === 'image_edit' || kind === 'video_generate') {
    return true;
  }
  if (kind === 'presentation') {
    return /(?:帮我|给我|请|直接|现在|马上|立刻|来|做|制作|生成|创建|出).{0,18}(?:ppt|powerpoint|slides?|幻灯片|演示文稿|路演稿|汇报材料)|(?:ppt|powerpoint|slides?|幻灯片|演示文稿|路演稿|汇报材料).{0,18}(?:来|做|制作|生成|创建|出)(?:一个|一份|一版)?/iu.test(prompt);
  }
  if (kind === 'spreadsheet') {
    return /(?:帮我|给我|请|直接|现在|马上|立刻|来|做|制作|生成|创建|整理|出).{0,18}(?:excel|xlsx|spreadsheet|表格|电子表格|数据表)|(?:excel|xlsx|spreadsheet|表格|电子表格|数据表).{0,18}(?:来|做|制作|生成|创建|整理|出)(?:一个|一份|一版)?/iu.test(prompt);
  }
  if (kind === 'mini_program') {
    return /(?:帮我|给我|请|直接|现在|马上|立刻|来|做|制作|生成|创建|开发|搭建).{0,18}(?:小程序|mini\s*program|wechat mini)|(?:小程序|mini\s*program|wechat mini).{0,18}(?:来|做|制作|生成|创建|开发|搭建)(?:一个|一份|一版)?/iu.test(prompt);
  }
  return /(?:帮我|给我|请|直接|现在|马上|立刻|来|写|撰写|生成|创作|出).{0,18}(?:文案|宣传语|标题|slogan|海报词|卖点|推广语|营销文|广告语|copywriting|ad copy)|(?:文案|宣传语|标题|slogan|海报词|卖点|推广语|营销文|广告语|copywriting|ad copy).{0,18}(?:来|写|撰写|生成|创作|出)(?:一个|一份|一版)?/iu.test(prompt);
}

function isNegatedCompositeTaskPrompt(prompt: string, kind: MediaIntentCompositeTaskKind): boolean {
  if (kind === 'image_generate') {
    return /(?:先)?(?:别|不要|不用|无需|不想|不是要|不是让你|暂时不|现在不).{0,18}(?:生图|生成(?:一张|几张|个|些)?(?:图|图片|照片|海报|插画|头像|壁纸|主视觉)|出图|画(?:一张|个|幅|图)?|做(?:一张)?(?:海报|插画|图片|主视觉)|generate.{0,12}(?:image|picture|poster|illustration)|create.{0,12}(?:image|picture|poster|illustration)|draw|paint)/i.test(prompt);
  }
  if (kind === 'video_generate') {
    return /(?:先)?(?:别|不要|不用|无需|不想|不是要|不是让你|暂时不|现在不).{0,18}(?:生视频|生成(?:一段|一个|个)?视频|做(?:一段|一个|个)?视频|视频生成|图生视频|generate.{0,12}video|create.{0,12}video)/i.test(prompt);
  }
  return false;
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

function setCompositeTaskImageSelection(
  task: MediaIntentCompositeTask,
  selection: ReturnType<typeof selectImage>,
): void {
  task.selectedImageSource = selection.selectedImageSource;
  if (typeof selection.selectedImageIndex === 'number') {
    task.selectedImageIndex = selection.selectedImageIndex;
  } else {
    delete task.selectedImageIndex;
  }
  if (selection.sourceImages?.length) {
    task.sourceImages = selection.sourceImages;
  } else {
    delete task.sourceImages;
  }
}

function setCompositeTaskImageDependency(
  tasks: MediaIntentCompositeTask[],
  taskIndex: number,
  dependency: MediaIntentCompositeTask,
): void {
  const task = tasks[taskIndex]!;
  const taskById = new Map(tasks.slice(0, taskIndex).map((candidate) => [candidate.id, candidate]));
  const nonImageDependencies = (task.dependsOn ?? []).filter((dependencyId) => {
    const dependencyTask = taskById.get(dependencyId);
    return dependencyTask?.kind !== 'image_generate' && dependencyTask?.kind !== 'image_edit';
  });
  task.dependsOn = Array.from(new Set([...nonImageDependencies, dependency.id]));
  setCompositeTaskImageSelection(task, { selectedImageSource: 'none' });
}

function prioritizeCompositeImageSources(params: {
  tasks: MediaIntentCompositeTask[];
  prompt: string;
  explicitImages: MediaGenerationInputImageRef[];
  candidateImages: MediaGenerationInputImageRef[];
}): MediaIntentCompositeTask[] {
  const taskOrdinals = new Map<MediaIntentCompositeTaskKind, number>();

  for (const [taskIndex, task] of params.tasks.entries()) {
    const ordinal = taskOrdinals.get(task.kind) ?? 0;
    taskOrdinals.set(task.kind, ordinal + 1);
    if (task.kind !== 'image_edit' && task.kind !== 'video_generate') continue;

    const priorImageTasks = params.tasks.slice(0, taskIndex).filter((candidate) => (
      candidate.kind === 'image_generate' || candidate.kind === 'image_edit'
    ));
    const hasImageDependency = (task.dependsOn ?? []).some((dependencyId) => (
      priorImageTasks.some((candidate) => candidate.id === dependencyId)
    ));
    const requiresImage = task.kind === 'image_edit'
      || videoTaskNeedsImageDependency(task.prompt)
      || task.selectedImageSource === 'explicit'
      || task.selectedImageSource === 'candidate'
      || hasImageDependency;
    if (!requiresImage) continue;

    const explicitSelection = selectImage({
      selectedImageSource: 'explicit',
      selectedImageIndex: task.selectedImageSource === 'explicit'
        ? task.selectedImageIndex
        : Math.min(ordinal, Math.max(0, params.explicitImages.length - 1)),
      explicitImages: params.explicitImages,
      candidateImages: [],
    });
    if (explicitSelection.sourceImages?.length) {
      setCompositeTaskImageSelection(task, explicitSelection);
      continue;
    }

    const dependency = priorImageTasks[priorImageTasks.length - 1];
    if (dependency) {
      setCompositeTaskImageDependency(params.tasks, taskIndex, dependency);
      task.fallback = task.fallback || (task.kind === 'video_generate'
        ? '优先使用最近的本轮前序图片生成或修图子任务结果作为视频输入；仍不可用时按文本生成视频。'
        : '优先使用最近的本轮前序图片生成或修图子任务结果作为修图输入；仍不可用时标记该子任务待补输入。');
      continue;
    }

    if (promptReferencesExistingImage(task.prompt) || promptReferencesExistingImage(params.prompt)) {
      const candidateSelection = selectImage({
        selectedImageSource: 'candidate',
        selectedImageIndex: task.selectedImageSource === 'candidate' ? task.selectedImageIndex : 0,
        explicitImages: [],
        candidateImages: params.candidateImages,
      });
      if (candidateSelection.sourceImages?.length) {
        setCompositeTaskImageSelection(task, candidateSelection);
        continue;
      }
    }

    setCompositeTaskImageSelection(task, { selectedImageSource: 'none' });
  }

  return params.tasks;
}

function detectCompositeTasks(params: {
  prompt: string;
  requestedMode: 'chat' | 'image' | 'video';
  explicitImages: MediaGenerationInputImageRef[];
  candidateImages: MediaGenerationInputImageRef[];
}): MediaIntentCompositeTask[] {
  const prompt = params.prompt.trim();
  if (!prompt) return [];
  const batchExecutionRequested = hasCompositeBatchExecutionDirective(prompt);
  if (isCapabilityOrKnowledgeOnlyPrompt(prompt)) return [];

  const normalized = prompt.toLowerCase();
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
      pattern: /(?:根据|基于|用|把|将|给)?(?:这张|这幅|这个图|上一张|图片|照片|image|picture|photo).*(?:修图|改图|精修|修亮|调亮|提亮|变亮|调暗|调整|优化|编辑|改成|换成|变成|换背景|去背景|抠图|加上|去掉|edit|retouch|modify)|(?:修图|改图|精修|edit image|image edit|retouch)/i,
      needsImage: true,
      prompt: taskPrompt(prompt, '根据图片修图'),
    },
    {
      kind: 'image_generate',
      title: '生成图片',
      pattern: /(?:生图|生成(?:(?:[1-9][0-9]*|[一二两三四五六七八九十])\s*(?:张|幅|个)?|几张|个|些)?[^，,、。；;\n]{0,24}(?:图|图片|照片|海报|插画|头像|壁纸|主视觉)|画(?:一张|1\s*张|个)?|出图|做(?:一张|1\s*张)?(?:海报|插画|图片)|来(?:[^，,、。；;\n]{0,12})?(?:图|图片|照片|海报|插画)|image generation|(?:generate|create|make)\s+(?:[1-9][0-9]*\s+|an?\s+|some\s+)?(?:images?|pictures?|posters?|illustrations?))/i,
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
      pattern: /(?:生视频|生成(?:[^，,、。；;\n]{0,16})?视频|做(?:[^，,、。；;\n]{0,16})?视频|来(?:[^，,、。；;\n]{0,12})?视频|视频生成|图生视频|基于[^，,、。；;\n]{0,24}(?:图|图片|照片)[^，,、。；;\n]{0,24}(?:生成|做)[^，,、。；;\n]{0,16}视频|动画|动起来|video generation|(?:generate|create|make)\s+(?:[1-9][0-9]*\s+|a\s+|some\s+)?(?:videos?|animations?))/i,
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

  const matches: CompositeTaskMatch[] = specs
    .map((spec, specIndex) => {
      if (isNegatedCompositeTaskPrompt(prompt, spec.kind)) return null;
      const match = normalized.match(spec.pattern);
      return match
        ? {
          spec,
          specIndex,
          matchIndex: match.index ?? Number.MAX_SAFE_INTEGER,
          matchText: match[0] || spec.prompt,
        }
        : null;
    })
    .filter((match): match is CompositeTaskMatch => Boolean(match))
    .filter((match) => batchExecutionRequested || explicitlyRequestsCompositeTask(prompt, match.spec.kind))
    .sort((left, right) => (left.matchIndex - right.matchIndex) || (left.specIndex - right.specIndex));

  const expandedMatches = matches.flatMap((match) => {
    const count = explicitCompositeTaskCount(prompt, match);
    return Array.from({ length: count }, (_, ordinal) => ({ match, count, ordinal }));
  });
  const hasExplicitMultiplicity = expandedMatches.some(({ count }) => count > 1);

  const tasks = expandedMatches.map(({ match, count, ordinal }, index) => {
    const imageSelection = match.spec.needsImage
      ? selectImage({
          selectedImageSource: 'explicit',
          selectedImageIndex: Math.min(ordinal, Math.max(0, params.explicitImages.length - 1)),
          explicitImages: params.explicitImages,
          candidateImages: [],
        })
      : undefined;
    const basePrompt = compositePromptClause(prompt, match, matches);
    return buildCompositeTask({
      index,
      kind: match.spec.kind,
      title: count > 1 ? `${match.spec.title} ${ordinal + 1}/${count}` : match.spec.title,
      prompt: count > 1
        ? `${basePrompt}\n这是同类交付中的第 ${ordinal + 1}/${count} 项，请让内容、构图或方案与其他项有明确差异。`
        : basePrompt,
      imageSelection: match.spec.needsImage ? imageSelection : undefined,
      fallback: match.spec.needsImage
        ? '没有显式输入图时，优先使用本轮前序图片生成子任务的结果；仍不可用时标记该子任务待补输入，并继续执行其他子任务。'
        : undefined,
    });
  });

  prioritizeCompositeImageSources({
    tasks,
    prompt,
    explicitImages: params.explicitImages,
    candidateImages: params.candidateImages,
  });

  if (tasks.length === 0) return [];
  if (tasks.length === 1) return [];
  return hasExplicitMultiplicity || containsCompositeSeparator(prompt) ? tasks : [];
}

function isImageLookupPrompt(prompt: string): boolean {
  return /(?:搜索|搜一下|找几张|找一些|参考图|参考图片|素材图|网上找|网上获取|search|find).*(?:图|图片|照片|image|picture|photo)/i.test(prompt)
    && !/(?:生成|生图|出图|画|做(?:一张)?(?:海报|图片|插画)|generate|create|draw|paint)/i.test(prompt);
}

function isImageGenerationPrompt(prompt: string): boolean {
  return /(?:生图|出图|生成(?:(?:[1-9][0-9]*|[一二两三四五六七八九十])\s*(?:张|幅|个)?|几张|个|些)?(?:图|图片|照片|海报|插画|头像|壁纸|主视觉)|画(?:一张|1\s*张|个|幅)?|做(?:一张|1\s*张)?(?:海报|插画|图片|主视觉)|generate (?:[1-9][0-9]* |an? |some )?(?:images?|pictures?|posters?|illustrations?)|create (?:[1-9][0-9]* |an? |some )?(?:images?|pictures?|posters?|illustrations?)|draw|paint)/i.test(prompt);
}

function promptReferencesExistingImage(prompt: string): boolean {
  return /(?:这张|这幅|这个图|这图|图片上|照片上|上一张|上一个|刚才(?:那张|生成的)?|刚生成|根据(?:这张|图片|照片|上一个|上一张)|基于(?:这张|图片|照片|上一个|上一张)|用(?:这张|图片|照片|上一个|上一张)|previous image|last image|this image|this picture|the image|the picture)/i.test(prompt);
}

function canUseCandidateImagesForPrompt(prompt: string): boolean {
  return promptReferencesExistingImage(prompt);
}

function canUseCandidateImagesForVisualPrompt(prompt: string): boolean {
  return canUseCandidateImagesForPrompt(prompt) || isVisualQuestionCuePrompt(prompt);
}

function isImageEditPrompt(prompt: string): boolean {
  return /(?:修图|改图|精修|编辑图片|图片编辑|调整图片|优化图片|换背景|去背景|抠图|加上|去掉|删除|移除|把.+改成|把.+换成|logo|remove|edit image|image edit|retouch|modify)/i.test(prompt)
    || (promptReferencesExistingImage(prompt) && /(?:改|修|换|加|去|删|调整|优化|编辑|变成|edit|modify|remove|replace|add)/i.test(prompt));
}

function isImageRevisionFeedbackPrompt(prompt: string): boolean {
  return /(?:不喜欢|不行|不对|不好看|不够|太(?:丑|差|暗|亮|大|小|普通)|换成|改成|变成|再.{0,12}一点|加(?:上|一个)?|去掉|删掉|移除|重新(?:做|生成|来)|重做|换一(?:张|版)|美化|优化|调整|redo|regenerate|change|replace|make (?:it )?(?:more|less)|add|remove)/i.test(prompt);
}

function isVideoGenerationPrompt(prompt: string): boolean {
  return /(?:生视频|生成(?:(?:[1-9][0-9]*|[一二两三四五六七八九十])\s*(?:段|个|条)?|一段|一个|个)?视频|做(?:(?:[1-9][0-9]*|[一二两三四五六七八九十])\s*(?:段|个|条)?|一段|一个|个)?视频|视频生成|图生视频|动起来|动画|animate|video generation|generate (?:[1-9][0-9]* |a )?videos?|create (?:[1-9][0-9]* |a )?videos?)/i.test(prompt);
}

function isMediaMetaQuestionPrompt(prompt: string): boolean {
  const mentionsMedia = /(?:图片|图像|照片|生图|修图|视频|媒体|image|picture|photo|video|media)/i.test(prompt);
  const mentionsConfiguration = /(?:模型|配置|参数|能力|功能|支持|入口|模式|设置|选项|默认|当前|用的|provider|model|config|setting|option|capabilit|support)/i.test(prompt);
  const asksOrLooksUp = /(?:什么|啥|哪个|哪些|怎么|如何|为什么|区别|解释|说明|是否|能不能|可不可以|查|看|当前|现在|默认|用的|what|which|how|why|support|lookup|check|explain|difference)/i.test(prompt);
  return mentionsMedia && mentionsConfiguration && asksOrLooksUp;
}

function isNegatedMediaGenerationPrompt(prompt: string): boolean {
  const negatesGeneration = /(?:先)?(?:别|不要|不用|无需|不想|不是要|不是让你|暂时不|现在不|no|not|without).{0,18}(?:生成|生图|出图|画|做(?:一张)?(?:海报|图片|视频)|生视频|图生视频|generate|create|draw|paint|video)/i.test(prompt);
  const redirectsToGeneration = /(?:而是|改为|换成|只生成|只要生成|直接生成).{0,18}(?:生成|生图|出图|画|做(?:一张)?(?:海报|图片|视频)|生视频|图生视频|generate|create|draw|paint|video)?/i.test(prompt);
  return negatesGeneration && !redirectsToGeneration;
}

function isMediaPromptDraftingPrompt(prompt: string): boolean {
  const referencesMediaCreation = /(?:生图|生成(?:图|图片|照片|海报)|出图|画图|视频|生视频|图生视频|image|picture|poster|video)/i.test(prompt);
  const asksForText = /(?:提示词|prompt|分镜|脚本|文案|朋友圈文案|标题|说明|解释|怎么写|写(?:一段|几个|几条)?|改写|润色|copy|caption|script)/i.test(prompt);
  const alsoRequestsExecution = /(?:并|同时|顺便|然后|再)(?:帮我)?(?:生成|生图|出图|做视频)/i.test(prompt);
  return referencesMediaCreation && asksForText && !alsoRequestsExecution;
}

function isTextOnlyRequestInMediaMode(prompt: string): boolean {
  return /(?:文案|朋友圈|标题|脚本|提示词|prompt|解释|区别|说明|参数|怎么写|写(?:一段|几个|几条)?|copy|caption|script|explain)/i.test(prompt)
    && !/(?:并|同时|顺便|然后|再)(?:帮我)?(?:生成|生图|出图|做视频)/i.test(prompt);
}

function isUiDesignDiscussionPrompt(prompt: string): boolean {
  return /(?:页面|界面|客户端|应用|app|网站|网页|UI|ux|交互|布局|聊天页|聊天页面|composer|sidebar|面板).{0,40}(?:太丑|丑|不好看|难看|咋办|怎么办|怎么改|如何改|优化|改进|美化|设计)|(?:太丑|丑|不好看|难看|优化|改进|美化|设计).{0,40}(?:页面|界面|客户端|应用|app|网站|网页|UI|ux|交互|布局|聊天页|聊天页面|composer|sidebar|面板)/i.test(prompt);
}

function isPreferenceOrMemoryPrompt(prompt: string): boolean {
  return /(?:以后|下次|默认|记住|记一下|保存在记忆|偏好|以后我说|以后如果|from now on|remember|preference|default)/i.test(prompt);
}

function isUseDefaultSettingsExecutionPrompt(
  prompt: string,
  requestedMode: 'chat' | 'image' | 'video',
): boolean {
  const usesDefaults = /(?:用|使用|按|采用).{0,16}默认(?:模型|尺寸|大小|参数|配置|设置)?(?:\s*[\/、和与]\s*默认?(?:模型|尺寸|大小|参数|配置|设置)?)?|(?:use|using|with)\s+(?:the\s+)?defaults?/iu.test(prompt);
  const executesNow = /(?:生成|生图|出图|画|制作|创建|做视频|生视频|generate|create|make)/iu.test(prompt);
  const futureOnly = /(?:以后|下次|每次|今后|从今以后|将来|未来|from now on|next time|in the future)/iu.test(prompt);
  const hasMediaTarget = isImageGenerationPrompt(prompt) || isVideoGenerationPrompt(prompt);
  return usesDefaults
    && executesNow
    && !futureOnly
    && (requestedMode !== 'chat' || hasMediaTarget);
}

function isPreferenceOnlyPrompt(
  prompt: string,
  requestedMode: 'chat' | 'image' | 'video' = 'chat',
): boolean {
  if (!isPreferenceOrMemoryPrompt(prompt)) return false;
  if (isUseDefaultSettingsExecutionPrompt(prompt, requestedMode)) return false;
  return !/(?:现在|这次|本次|马上|立刻|先|当前).{0,40}(?:生成|生图|出图|做视频|修图|制作|创建|开发|写)|(?:生成|生图|出图|做视频|修图|制作|创建|开发|写).{0,24}(?:现在|这次|本次|马上|立刻)/iu.test(prompt);
}

function isPlainConversationalPrompt(prompt: string): boolean {
  const normalized = prompt.trim();
  if (!normalized || normalized.length > 32) return false;
  return /^(?:hi|hello|hey|yo|你好|您好|哈喽|嗨|在吗|你在吗|早上好|中午好|晚上好|晚安|谢谢|谢了|thanks|thank you)[\s。！!？?~～,.，]*$/i.test(normalized);
}

function isLookupOrResearchPrompt(prompt: string): boolean {
  return /(?:查一下|查下|帮我查|你查一下|搜一下|搜索一下|找一下|帮我看|看一下|看看|lookup|check|search|find out)/i.test(prompt);
}

function isGeneralQuestionPrompt(prompt: string): boolean {
  const normalized = prompt.trim();
  return /[?？]\s*$/.test(normalized)
    || /^(?:什么|啥|哪个|哪些|怎么|如何|为什么|为啥|谁|哪里|哪儿|是否|能不能|可不可以|what|which|how|why|who|where|can|could|is|are)\b/i.test(normalized);
}

function isPotentialCurrentMediaSideEffectPrompt(prompt: string): boolean {
  return isVisualQuestionPrompt(prompt)
    || isImageEditPrompt(prompt)
    || isImageRevisionFeedbackPrompt(prompt)
    || isVideoGenerationPrompt(prompt)
    || (!isImageLookupPrompt(prompt) && isImageGenerationPrompt(prompt));
}

function needsRemoteMediaPlanner(params: {
  prompt: string;
  requestedMode: 'chat' | 'image' | 'video';
  explicitImages: MediaGenerationInputImageRef[];
  candidateImages: MediaGenerationInputImageRef[];
}): boolean {
  if (params.requestedMode !== 'chat') return true;
  if (params.explicitImages.length > 0) return true;
  if (params.candidateImages.length > 0 && canUseCandidateImagesForPrompt(params.prompt)) return true;
  return isPotentialCurrentMediaSideEffectPrompt(params.prompt);
}

function recentContextLooksLikeMediaMetaLookup(messages: MediaIntentRecentMessage[] | undefined): boolean {
  const recentText = (messages ?? [])
    .slice(-4)
    .map((message) => message.text?.trim() || '')
    .filter(Boolean)
    .join('\n');
  if (!recentText) return false;
  return isMediaMetaQuestionPrompt(recentText)
    || (
      /(?:图片|图像|照片|生图|修图|视频|媒体|image|picture|photo|video|media)/i.test(recentText)
      && /(?:模型|配置|参数|能力|功能|支持|入口|模式|设置|选项|默认|当前|用的|provider|model|config|setting|option|capabilit|support)/i.test(recentText)
      && /(?:查|看|确认|列表|当前|默认|精确|lookup|check|inspect|confirm)/i.test(recentText)
    );
}

function isMetaLookupContinuationPrompt(prompt: string): boolean {
  return /^(?:(?:好|好的|嗯|可以|行|对|是|ok|okay|yes)[\s，,]*)?(?:查|查一下|查下|你查一下|帮我查一下|那你查一下|继续查|看一下|看看)(?:吧|一下|下)?[\s。！!？?~～,.，]*$/i.test(prompt.trim())
    || /^(?:好|好的|嗯|可以|行|对|是|ok|okay|yes)(?:吧|一下|下)?[\s。！!？?~～,.，]*$/i.test(prompt.trim());
}

function localNonMediaChatPlan(params: {
  prompt: string;
  requestedMode: 'chat' | 'image' | 'video';
  explicitImages: MediaGenerationInputImageRef[];
  candidateImages: MediaGenerationInputImageRef[];
  recentMessages?: MediaIntentRecentMessage[];
}): MediaIntentPlan | null {
  const prompt = params.prompt.trim();
  if (!prompt) return null;

  if (isPreferenceOnlyPrompt(prompt, params.requestedMode)) {
    return localChatPlan('local_non_media_preference_update', prompt, 'preference_or_memory_update');
  }
  if (isCapabilityOrKnowledgeOnlyPrompt(prompt)) {
    return localChatPlan('local_non_media_capability_or_knowledge_question', prompt, 'current_non_media_task');
  }
  if (isMediaMetaQuestionPrompt(prompt)) {
    return localChatPlan('local_non_media_media_meta_question', prompt, 'current_non_media_task');
  }
  if (isNegatedMediaGenerationPrompt(prompt) || isMediaPromptDraftingPrompt(prompt)) {
    return localChatPlan(
      'local_non_media_media_reference_instruction',
      prompt,
      isPreferenceOrMemoryPrompt(prompt) ? 'preference_or_memory_update' : 'current_non_media_task',
    );
  }
  if (isPlainConversationalPrompt(prompt)) {
    return localChatPlan('local_non_media_plain_conversation', prompt, 'ordinary_chat');
  }
  if (
    params.requestedMode === 'chat'
    && params.explicitImages.length === 0
    && !canUseCandidateImagesForPrompt(prompt)
    && isUiDesignDiscussionPrompt(prompt)
  ) {
    return localChatPlan('local_non_media_ui_design_discussion_without_image', prompt, 'current_non_media_task');
  }
  if (isMetaLookupContinuationPrompt(prompt) && recentContextLooksLikeMediaMetaLookup(params.recentMessages)) {
    return localChatPlan('local_non_media_meta_lookup_continuation', prompt, 'current_non_media_task');
  }

  const potentialMediaSideEffect = isPotentialCurrentMediaSideEffectPrompt(prompt)
    || (
      (params.explicitImages.length > 0 || params.candidateImages.length > 0)
      && isVisualQuestionCuePrompt(prompt)
    );
  if (!potentialMediaSideEffect && isImageLookupPrompt(prompt)) {
    return localChatPlan('local_non_media_image_lookup_request', prompt, 'current_non_media_task');
  }
  if (!potentialMediaSideEffect && isLookupOrResearchPrompt(prompt)) {
    return localChatPlan('local_non_media_lookup_or_research', prompt, 'current_non_media_task');
  }
  if (params.requestedMode !== 'chat' && !potentialMediaSideEffect && isGeneralQuestionPrompt(prompt)) {
    return localChatPlan('local_non_media_question_in_media_mode', prompt, 'ordinary_chat');
  }
  if (params.requestedMode !== 'chat' && !potentialMediaSideEffect && isTextOnlyRequestInMediaMode(prompt)) {
    return localChatPlan('local_non_media_text_request_in_media_mode', prompt, 'ordinary_chat');
  }

  return null;
}

function localSelectedImageForPrompt(params: {
  prompt: string;
  explicitImages: MediaGenerationInputImageRef[];
  candidateImages: MediaGenerationInputImageRef[];
  allowImplicitExplicitImage?: boolean;
}): ReturnType<typeof selectPreferredImage> {
  if (params.explicitImages.length > 0 && (params.allowImplicitExplicitImage || promptReferencesExistingImage(params.prompt) || isImageEditPrompt(params.prompt))) {
    return selectImage({
      selectedImageSource: 'explicit',
      selectedImageIndex: 0,
      explicitImages: params.explicitImages,
      candidateImages: params.candidateImages,
    });
  }
  if (params.candidateImages.length > 0 && canUseCandidateImagesForPrompt(params.prompt)) {
    return selectImage({
      selectedImageSource: 'candidate',
      selectedImageIndex: 0,
      explicitImages: params.explicitImages,
      candidateImages: params.candidateImages,
    });
  }
  return { selectedImageSource: 'none' };
}

function localFastPathPlan(params: {
  prompt: string;
  requestedMode: 'chat' | 'image' | 'video';
  explicitImages: MediaGenerationInputImageRef[];
  candidateImages: MediaGenerationInputImageRef[];
}): MediaIntentPlan | null {
  const prompt = params.prompt.trim();
  if (!prompt) return null;

  if (params.requestedMode === 'image') {
    const visualQuestion = isVisualQuestionPrompt(prompt)
      || (
        (params.explicitImages.length > 0 || params.candidateImages.length > 0)
        && isVisualQuestionCuePrompt(prompt)
      );
    const editPrompt = isImageEditPrompt(prompt);
    const revisionFeedback = isImageRevisionFeedbackPrompt(prompt);
    const imageSelection = visualQuestion || revisionFeedback
      ? selectPreferredImage({
        selectedImageSource: params.explicitImages.length > 0 ? 'explicit' : 'candidate',
        selectedImageIndex: 0,
        explicitImages: params.explicitImages,
        candidateImages: params.candidateImages,
      })
      : localSelectedImageForPrompt({
        prompt,
        explicitImages: params.explicitImages,
        candidateImages: params.candidateImages,
        allowImplicitExplicitImage: true,
      });
    const hasSourceImage = Boolean(imageSelection.sourceImages?.length);
    if (visualQuestion && hasSourceImage) {
      return {
        action: 'vision_chat',
        source: 'fallback',
        intentKind: 'current_media_task',
        currentTurnMediaRequest: true,
        confidence: 1,
        reason: 'local_fast_path_image_mode_visual_question',
        selectedImageSource: imageSelection.selectedImageSource,
        selectedImageIndex: imageSelection.selectedImageIndex,
        sourceImages: imageSelection.sourceImages,
        prompt,
      };
    }
    if (editPrompt || (hasSourceImage && revisionFeedback)) {
      if (!hasSourceImage) {
        return clarificationPlan('local_fast_path_image_edit_missing_input_image');
      }
      return {
        action: 'image_edit',
        source: 'fallback',
        intentKind: 'current_media_task',
        currentTurnMediaRequest: true,
        confidence: 1,
        reason: 'local_fast_path_image_mode_edit',
        selectedImageSource: imageSelection.selectedImageSource,
        selectedImageIndex: imageSelection.selectedImageIndex,
        sourceImages: imageSelection.sourceImages,
        prompt,
      };
    }
    if (
      (
        (!isImageLookupPrompt(prompt) && isImageGenerationPrompt(prompt))
        || isUseDefaultSettingsExecutionPrompt(prompt, params.requestedMode)
      )
      && !isNegatedCompositeTaskPrompt(prompt, 'image_generate')
    ) {
      return {
        action: 'image_generate',
        source: 'fallback',
        intentKind: 'current_media_task',
        currentTurnMediaRequest: true,
        confidence: 1,
        reason: 'local_fast_path_image_mode_generate',
        selectedImageSource: 'none',
        sourceImages: [],
        prompt,
      };
    }
    return null;
  }

  if (params.requestedMode === 'video') {
    const imageSelection = localSelectedImageForPrompt({
      prompt,
      explicitImages: params.explicitImages,
      candidateImages: params.candidateImages,
      allowImplicitExplicitImage: true,
    });
    const hasSourceImage = Boolean(imageSelection.sourceImages?.length);
    const shouldEditFirst = hasSourceImage && isImageEditPrompt(prompt);
    if (
      !isVideoGenerationPrompt(prompt)
      && !isUseDefaultSettingsExecutionPrompt(prompt, params.requestedMode)
    ) return null;
    return {
      action: 'video_generate',
      source: 'fallback',
      intentKind: 'current_media_task',
      currentTurnMediaRequest: true,
      confidence: 1,
      reason: 'local_fast_path_video_mode_generate',
      selectedImageSource: imageSelection.selectedImageSource,
      selectedImageIndex: imageSelection.selectedImageIndex,
      sourceImages: imageSelection.sourceImages,
      prompt,
      videoMode: shouldEditFirst ? 'edit_image_then_video' : (hasSourceImage ? 'image_to_video' : 'text_to_video'),
      videoPrompt: prompt,
      imageEditPrompt: shouldEditFirst ? prompt : undefined,
    };
  }

  if (
    (
      isVisualQuestionPrompt(prompt)
      || (
        (params.explicitImages.length > 0 || params.candidateImages.length > 0)
        && isVisualQuestionCuePrompt(prompt)
      )
    )
    && (params.explicitImages.length > 0 || params.candidateImages.length > 0)
  ) {
    const imageSelection = selectPreferredImage({
      selectedImageSource: params.explicitImages.length > 0 ? 'explicit' : 'candidate',
      selectedImageIndex: 0,
      explicitImages: params.explicitImages,
      candidateImages: params.candidateImages,
    });
    if (imageSelection.sourceImages?.length) {
      return {
        action: 'vision_chat',
        source: 'fallback',
        intentKind: 'current_media_task',
        currentTurnMediaRequest: true,
        confidence: 1,
        reason: 'local_fast_path_visual_question',
        selectedImageSource: imageSelection.selectedImageSource,
        selectedImageIndex: imageSelection.selectedImageIndex,
        sourceImages: imageSelection.sourceImages,
        prompt,
      };
    }
  }

  if (isImageEditPrompt(prompt)) {
    const imageSelection = localSelectedImageForPrompt({
      prompt,
      explicitImages: params.explicitImages,
      candidateImages: params.candidateImages,
      allowImplicitExplicitImage: true,
    });
    if (!imageSelection.sourceImages?.length) {
      return clarificationPlan('local_fast_path_image_edit_missing_input_image');
    }
    return {
      action: 'image_edit',
      source: 'fallback',
      intentKind: 'current_media_task',
      currentTurnMediaRequest: true,
      confidence: 1,
      reason: 'local_fast_path_image_edit',
      selectedImageSource: imageSelection.selectedImageSource,
      selectedImageIndex: imageSelection.selectedImageIndex,
      sourceImages: imageSelection.sourceImages,
      prompt,
    };
  }

  if (!isImageLookupPrompt(prompt) && isImageGenerationPrompt(prompt) && !isNegatedCompositeTaskPrompt(prompt, 'image_generate')) {
    return {
      action: 'image_generate',
      source: 'fallback',
      intentKind: 'current_media_task',
      currentTurnMediaRequest: true,
      confidence: 1,
      reason: 'local_fast_path_image_generate',
      selectedImageSource: 'none',
      sourceImages: [],
      prompt,
    };
  }

  if (isVideoGenerationPrompt(prompt)) {
    const imageSelection = localSelectedImageForPrompt({
      prompt,
      explicitImages: params.explicitImages,
      candidateImages: params.candidateImages,
      allowImplicitExplicitImage: false,
    });
    const hasSourceImage = Boolean(imageSelection.sourceImages?.length);
    const shouldEditFirst = hasSourceImage && isImageEditPrompt(prompt);
    return {
      action: 'video_generate',
      source: 'fallback',
      intentKind: 'current_media_task',
      currentTurnMediaRequest: true,
      confidence: 1,
      reason: 'local_fast_path_video_generate',
      selectedImageSource: imageSelection.selectedImageSource,
      selectedImageIndex: imageSelection.selectedImageIndex,
      sourceImages: imageSelection.sourceImages,
      prompt,
      videoMode: shouldEditFirst ? 'edit_image_then_video' : (hasSourceImage ? 'image_to_video' : 'text_to_video'),
      videoPrompt: prompt,
      imageEditPrompt: shouldEditFirst ? prompt : undefined,
    };
  }

  return null;
}

function normalizeCompositeTaskId(value: unknown, fallback: string, usedIds: Set<string>): string {
  const requested = typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.trim())
    ? value.trim()
    : fallback;
  let id = requested;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${requested}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

function defaultCompositeTaskTitle(kind: MediaIntentCompositeTaskKind): string {
  const titles: Record<MediaIntentCompositeTaskKind, string> = {
    image_generate: '生成图片',
    presentation: '制作 PPT',
    spreadsheet: '制作 Excel',
    video_generate: '生成视频',
    image_edit: '根据图片修图',
    mini_program: '制作小程序',
    copywriting: '撰写文案',
  };
  return titles[kind];
}

function normalizePlannerCompositeTasks(params: {
  raw: Record<string, unknown>;
  prompt: string;
  explicitImages: MediaGenerationInputImageRef[];
  candidateImages: MediaGenerationInputImageRef[];
}): MediaIntentCompositeTask[] {
  const rawTasks = params.raw.composite_tasks ?? params.raw.compositeTasks;
  if (!Array.isArray(rawTasks)) return [];

  const kindCounts = new Map<MediaIntentCompositeTaskKind, number>();
  const usedIds = new Set<string>();
  const rawIdToNormalizedId = new Map<string, string>();
  const normalized: Array<{
    task: MediaIntentCompositeTask;
    rawDependencies: string[];
  }> = [];

  for (const rawTask of rawTasks) {
    if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) continue;
    const record = rawTask as Record<string, unknown>;
    if (!isCompositeTaskKind(record.kind)) continue;

    const kindCount = kindCounts.get(record.kind) ?? 0;
    if (kindCount >= MAX_COMPOSITE_TASKS_PER_KIND) continue;
    kindCounts.set(record.kind, kindCount + 1);

    const fallbackId = `task-${normalized.length + 1}-${record.kind}`;
    const id = normalizeCompositeTaskId(record.id, fallbackId, usedIds);
    const rawId = typeof record.id === 'string' ? record.id.trim() : '';
    if (rawId && !rawIdToNormalizedId.has(rawId)) rawIdToNormalizedId.set(rawId, id);

    const sourceSelection = record.source_selection && typeof record.source_selection === 'object' && !Array.isArray(record.source_selection)
      ? record.source_selection as Record<string, unknown>
      : undefined;
    const selectedImageSource = record.selected_image_source
      ?? record.selectedImageSource
      ?? sourceSelection?.source;
    const selectedImageIndex = record.selected_image_index
      ?? record.selectedImageIndex
      ?? sourceSelection?.index;
    const canSelectImage = record.kind === 'image_edit' || record.kind === 'video_generate';
    let imageSelection: ReturnType<typeof selectImage> = canSelectImage
      ? selectImage({
          selectedImageSource,
          selectedImageIndex,
          explicitImages: params.explicitImages,
          candidateImages: params.candidateImages,
        })
      : { selectedImageSource: 'none' as const };
    if (
      imageSelection.selectedImageSource === 'candidate'
      && !canUseCandidateImagesForPrompt(params.prompt)
    ) {
      imageSelection = { selectedImageSource: 'none' };
    }

    const task: MediaIntentCompositeTask = {
      id,
      kind: record.kind,
      title: normalizeOptionalText(record.title) ?? defaultCompositeTaskTitle(record.kind),
      prompt: normalizePrompt(record.prompt, params.prompt),
      requiresArtifact: normalizeOptionalBoolean(record.requires_artifact ?? record.requiresArtifact) ?? true,
      ...(normalizeOptionalText(record.fallback) ? { fallback: normalizeOptionalText(record.fallback) } : {}),
      ...(imageSelection.selectedImageSource !== 'none'
        ? {
          selectedImageSource: imageSelection.selectedImageSource,
          selectedImageIndex: imageSelection.selectedImageIndex,
          sourceImages: imageSelection.sourceImages,
        }
        : {}),
    };
    const rawDependsOn = record.depends_on ?? record.dependsOn;
    const rawDependencies = Array.isArray(rawDependsOn)
      ? rawDependsOn.filter((dependency): dependency is string => typeof dependency === 'string' && Boolean(dependency.trim()))
      : [];
    normalized.push({ task, rawDependencies });
  }

  const normalizedTaskIndex = new Map(normalized.map(({ task }, index) => [task.id, index]));
  for (const [index, entry] of normalized.entries()) {
    const dependsOn = entry.rawDependencies
      .map((dependency) => rawIdToNormalizedId.get(dependency.trim()) ?? dependency.trim())
      .filter((dependency, dependencyIndex, allDependencies) => (
        dependency !== entry.task.id
        && normalizedTaskIndex.has(dependency)
        && (normalizedTaskIndex.get(dependency) ?? index) < index
        && allDependencies.indexOf(dependency) === dependencyIndex
      ));
    if (dependsOn.length > 0) entry.task.dependsOn = dependsOn;
  }

  return prioritizeCompositeImageSources({
    tasks: normalized.map(({ task }) => task),
    prompt: params.prompt,
    explicitImages: params.explicitImages,
    candidateImages: params.candidateImages,
  });
}

function normalizePlannerDecision(params: {
  raw: Record<string, unknown>;
  prompt: string;
  requestedMode: 'chat' | 'image' | 'video';
  explicitImages: MediaGenerationInputImageRef[];
  candidateImages: MediaGenerationInputImageRef[];
}): MediaIntentPlan | null {
  if (isPreferenceOnlyPrompt(params.prompt, params.requestedMode)) {
    return localChatPlan('planner_guard_preference_update', params.prompt, 'preference_or_memory_update');
  }
  if (isCapabilityOrKnowledgeOnlyPrompt(params.prompt)) {
    return localChatPlan('planner_guard_capability_or_knowledge_question', params.prompt, 'current_non_media_task');
  }

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

  const plannerAuthorizesCurrentMedia = intentKind === 'current_media_task'
    && currentTurnMediaRequest === true;
  const compositeTasks = normalizePlannerCompositeTasks(params);
  if (compositeTasks.length >= 2) {
    const hasMediaTask = compositeTasks.some((task) => (
      task.kind === 'image_generate'
      || task.kind === 'image_edit'
      || task.kind === 'video_generate'
    ));
    if (hasMediaTask && !plannerAuthorizesCurrentMedia) {
      return localChatPlan('planner_composite_missing_current_media_authorization', params.prompt, intentKind);
    }
    return compositePlan(compositeTasks, {
      source: 'planner',
      confidence,
      reason: reason || 'composite_intent_planner',
    });
  }
  if (isMediaSideEffectAction(action) && !plannerAuthorizesCurrentMedia) {
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
    if (imageSelection.selectedImageSource === 'candidate' && !canUseCandidateImagesForVisualPrompt(params.prompt)) {
      return {
        action: 'chat',
        source: 'planner',
        intentKind: 'current_non_media_task',
        currentTurnMediaRequest: false,
        confidence,
        reason: reason || 'candidate_image_not_explicitly_referenced',
        selectedImageSource: 'none',
        prompt,
      };
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
    if (imageSelection.selectedImageSource === 'candidate' && !canUseCandidateImagesForPrompt(params.prompt)) {
      return clarificationPlan('image_edit_candidate_not_explicitly_referenced', normalizeOptionalText(params.raw.clarification));
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
    if (imageSelection.selectedImageSource === 'candidate' && !canUseCandidateImagesForPrompt(params.prompt)) {
      return {
        action,
        source: 'planner',
        intentKind,
        currentTurnMediaRequest,
        confidence,
        reason: reason || 'video_generate_candidate_image_not_explicitly_referenced',
        selectedImageSource: 'none',
        sourceImages: [],
        prompt,
        videoMode: 'text_to_video',
        videoSize,
        videoDurationSeconds,
        videoPrompt,
      };
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
    && (
      isVisualQuestionPrompt(params.prompt)
      || (
        (params.explicitImages.length > 0 || params.candidateImages.length > 0)
        && isVisualQuestionCuePrompt(params.prompt)
      )
    )
    && (params.explicitImages.length > 0 || params.candidateImages.length > 0)
  ) {
    const imageSelection = selectPreferredImage({
      selectedImageSource,
      selectedImageIndex,
      explicitImages: params.explicitImages,
      candidateImages: params.candidateImages,
    });
    if (imageSelection.sourceImages?.length) {
      if (imageSelection.selectedImageSource === 'candidate' && !canUseCandidateImagesForVisualPrompt(params.prompt)) {
        return {
          action: 'chat',
          source: 'planner',
          intentKind,
          currentTurnMediaRequest,
          confidence,
          reason: reason || 'candidate_image_not_explicitly_referenced',
          selectedImageSource: 'none',
          prompt,
        };
      }
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
        'Your job is to decide whether the next step should be normal chat, visual chat about an existing image, still-image generation, still-image editing, video generation, desktop screenshot capture, a clarification question, or a structured multi-deliverable task DAG.',
        'Do not answer the user. Do not execute tools. Only produce the route plan.',
        'First decide whether the user is requesting an immediate media side effect in this current turn.',
        'Set intent_kind to one of: current_media_task, current_non_media_task, preference_or_memory_update, ordinary_chat, clarification.',
        'Set current_turn_media_request=true only when the current user message itself asks to create, edit, inspect, capture, or animate media now.',
        'Future/default behavior, memory/profile/preference updates, and instructions about how to source images or public data for later generated works are preference_or_memory_update with current_turn_media_request=false.',
        'Actions: chat, vision_chat, image_generate, image_edit, video_generate, desktop_screenshot, clarify.',
        'Only choose image_generate, image_edit, video_generate, or desktop_screenshot when intent_kind=current_media_task and current_turn_media_request=true.',
        'Use chat for explanations, research/search requests, planning, automation workflows, coding, and requests that do not require immediate media tool execution.',
        'Use chat for preference_or_memory_update even when the text mentions images, web sources, public data, or generated works.',
        'A capability question such as "can you generate images or videos?" is chat. A polite command such as "can you help me generate one image now?" is an immediate media request.',
        'A request to generate now using the default model, size, or parameters is a current media task, not a preference update. The image/video UI mode determines the media family only when the prompt does not name one.',
        'Use vision_chat when the user asks to inspect, evaluate, describe, compare, rate, or suggest improvements for an existing image. vision_chat MUST select exactly one explicit_images or candidate_images item.',
        'Use image_generate only when the user wants a new still image from text.',
        'Use image_edit only when the user wants to change an existing image. image_edit MUST select exactly one explicit_images or candidate_images item.',
        'If the user asks to edit "this image", "it", "the previous image", or similar but no usable image exists, use clarify. Never downgrade image_edit to image_generate.',
        'Use explicit_images before current-turn dependent image artifacts, then candidate_images. In composite tasks, express a current-turn artifact through depends_on instead of candidate_images.',
        'Use candidate_images when the user clearly refers to current/recent/previous image context using words like this image, previous image, 上一张, 这张图, 图片上, or 刚生成. A short visual follow-up such as 好看吗 or 你觉得美嘛 may use the most recent assistant image even without repeating the image noun. Do not use candidate_images merely because the user says this page, this client, this UI, design, ugly, or pretty.',
        'Use video_generate only when the user wants video creation, animation, or image-to-video.',
        'For video_generate, also choose video_mode: text_to_video, image_to_video, or edit_image_then_video.',
        'Use edit_image_then_video when the image should be changed first, then animated.',
        'Use image_to_video when the selected image should be animated or used as the visual base without a separate still-image edit.',
        'Use desktop_screenshot only for a direct request to capture the current desktop/screen. Use chat for broader browser automation or local workflow tasks.',
        'For a current-turn request containing two or more deliverables, return action=chat plus composite_tasks in execution order. Each task must contain id, kind, title, prompt, requires_artifact, depends_on, fallback, selected_image_source, and selected_image_index.',
        'Allowed composite task kinds: image_generate, presentation, spreadsheet, video_generate, image_edit, mini_program, copywriting.',
        'When the user explicitly requests 2-5 outputs of the same kind, emit that many independent tasks. Never emit more than 5 tasks of one kind. For quantities above 5, emit only 5.',
        'Do not use composite_tasks for a single presentation, spreadsheet, or mini_program request; keep action=chat and let the default agent handle it.',
        'depends_on may reference only task ids that appear earlier in composite_tasks. Use it only when a task consumes an earlier task output, such as editing a generated image or animating it into a video.',
        'When a composite video consumes a current-turn image, depend on the nearest compatible earlier image_edit or image_generate task, preferring the edited image.',
        'For image_edit or image-based video tasks, set selected_image_source to explicit or candidate and select an index only when that input really comes from the supplied image lists. Otherwise use none and express an earlier generated-image dependency through depends_on.',
        'Never emit composite_tasks for capability questions, explanations, comparisons, planning-only requests, future/default preferences, memory updates, or hypothetical examples.',
        'If any composite task creates or edits media, intent_kind must be current_media_task and current_turn_media_request must be true. Otherwise no media composite task is authorized.',
        'Extract media parameters only when the user explicitly asks for them: image_size, image_quality, video_size, video_duration_seconds. Leave them null otherwise.',
        'Never invent model names. Use only the user-requested size/quality/duration values you can infer from the text.',
        'requested_mode is a UI hint, not a substitute for reasoning. Respect image/video mode when it is compatible with the prompt; otherwise choose clarify or chat.',
        'Return JSON schema: {"action":"chat|vision_chat|image_generate|image_edit|video_generate|desktop_screenshot|clarify","intent_kind":"current_media_task|current_non_media_task|preference_or_memory_update|ordinary_chat|clarification","current_turn_media_request":boolean,"confidence":0-1,"selected_image_source":"explicit|candidate|none","selected_image_index":number|null,"prompt":string|null,"image_size":string|null,"image_quality":"low|medium|high|null,"video_mode":"text_to_video|image_to_video|edit_image_then_video|null,"video_size":string|null,"video_duration_seconds":number|null,"video_prompt":string|null,"image_edit_prompt":string|null,"clarification":string|null,"reason":string,"composite_tasks":[{"id":string,"kind":"image_generate|presentation|spreadsheet|video_generate|image_edit|mini_program|copywriting","title":string,"prompt":string,"requires_artifact":boolean,"depends_on":string[],"fallback":string|null,"selected_image_source":"explicit|candidate|none","selected_image_index":number|null}]}',
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
  const candidateImages = mergeImageRefs(
    normalizeImageRefs(params.candidateImages),
    getMostRecentAssistantImages(params.recentMessages),
  );

  logger.info('[media-intent-planner] start', {
    timeoutMs: MEDIA_INTENT_PLANNER_TIMEOUT_MS,
    requestedMode,
    prompt: truncateForLog(prompt),
    explicitImages: summarizeImagesForLog(explicitImages),
    candidateImages: summarizeImagesForLog(candidateImages),
  });

  const preCompositeNonMediaPlan = isPreferenceOnlyPrompt(prompt, requestedMode) || isLookupOrResearchPrompt(prompt)
    ? localNonMediaChatPlan({
        prompt,
        requestedMode,
        explicitImages,
        candidateImages,
        recentMessages: params.recentMessages,
      })
    : null;
  if (preCompositeNonMediaPlan) {
    logger.info('[media-intent-planner] local_non_media', {
      durationMs: Date.now() - startedAt,
      plan: summarizePlanForLog(preCompositeNonMediaPlan),
    });
    return preCompositeNonMediaPlan;
  }

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

  const localNonMediaPlan = localNonMediaChatPlan({
    prompt,
    requestedMode,
    explicitImages,
    candidateImages,
    recentMessages: params.recentMessages,
  });
  if (localNonMediaPlan) {
    logger.info('[media-intent-planner] local_non_media', {
      durationMs: Date.now() - startedAt,
      plan: summarizePlanForLog(localNonMediaPlan),
    });
    return localNonMediaPlan;
  }

  const localPlan = localFastPathPlan({
    prompt,
    requestedMode,
    explicitImages,
    candidateImages,
  });
  if (localPlan) {
    logger.info('[media-intent-planner] local_fast_path', {
      durationMs: Date.now() - startedAt,
      plan: summarizePlanForLog(localPlan),
    });
    return localPlan;
  }

  if (!needsRemoteMediaPlanner({
    prompt,
    requestedMode,
    explicitImages,
    candidateImages,
  })) {
    const plan = localChatPlan('local_no_media_planning_signal', prompt, 'ordinary_chat');
    logger.info('[media-intent-planner] local_chat', {
      durationMs: Date.now() - startedAt,
      plan: summarizePlanForLog(plan),
    });
    return plan;
  }

  try {
    const secret = await getProviderSecret(JUNFEIAI_PROVIDER_ID);
    const apiKey = getApiKey(secret);
    if (!apiKey) {
      const plan = fallbackPlan('planner_api_key_unavailable', prompt);
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
          max_tokens: 1200,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const plan = fallbackPlan(`planner_http_${response.status}`, prompt);
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
        const plan = fallbackPlan('planner_invalid_json', prompt);
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
        requestedMode,
        explicitImages,
        candidateImages,
      });
      if (!planned) {
        const plan = fallbackPlan('planner_low_confidence_or_invalid_action', prompt);
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
    const plan = fallbackPlan('planner_exception', prompt);
    logger.warn('[media-intent-planner] exception', {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      plan: summarizePlanForLog(plan),
    });
    return plan;
  }
}
