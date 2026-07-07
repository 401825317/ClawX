import { getProviderAccount } from '../services/providers/provider-store';
import { getProviderSecret } from '../services/secrets/secret-store';
import {
  getJunFeiAIProviderBaseUrl,
  JUNFEIAI_DEFAULT_MODEL,
  JUNFEIAI_PROVIDER_ID,
} from './junfeiai-distribution';
import { logger } from './logger';
import type { MediaGenerationInputImageRef } from './media-generation-types';
import { proxyAwareFetch } from './proxy-fetch';

const MEDIA_INTENT_PLANNER_TIMEOUT_MS = 60_000;
const MEDIA_INTENT_PLANNER_MIN_CONFIDENCE = 0.55;
const MAX_PLANNER_IMAGES = 5;
const MAX_RECENT_MESSAGES = 8;
const MAX_LOG_TEXT_CHARS = 800;

export type MediaIntentAction =
  | 'chat'
  | 'image_generate'
  | 'image_edit'
  | 'video_generate'
  | 'desktop_screenshot'
  | 'clarify';

export type MediaIntentImageSource = 'explicit' | 'candidate' | 'none';

export type MediaIntentRecentMessage = {
  role: 'user' | 'assistant' | 'system' | 'toolresult';
  text?: string;
  images?: MediaGenerationInputImageRef[];
};

export type MediaIntentPlan = {
  action: MediaIntentAction;
  source: 'planner' | 'fallback';
  confidence?: number;
  reason?: string;
  selectedImageSource?: MediaIntentImageSource;
  selectedImageIndex?: number;
  sourceImages?: MediaGenerationInputImageRef[];
  prompt?: string;
  clarification?: string;
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
    confidence: plan.confidence,
    reason: plan.reason ? truncateForLog(plan.reason, 300) : undefined,
    selectedImageSource: plan.selectedImageSource,
    selectedImageIndex: plan.selectedImageIndex,
    sourceImages: summarizeImagesForLog(plan.sourceImages ?? []),
    prompt: plan.prompt ? truncateForLog(plan.prompt) : undefined,
    clarification: plan.clarification ? truncateForLog(plan.clarification, 300) : undefined,
  };
}

function summarizeRawPlannerJsonForLog(raw: Record<string, unknown>): Record<string, unknown> {
  const prompt = raw.prompt ?? raw.rewritten_prompt ?? raw.rewrittenPrompt;
  return {
    action: raw.action,
    confidence: raw.confidence,
    selected_image_source: raw.selected_image_source ?? raw.selectedImageSource,
    selected_image_index: raw.selected_image_index ?? raw.selectedImageIndex,
    prompt: typeof prompt === 'string' ? truncateForLog(prompt) : prompt,
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

function isIntentAction(value: unknown): value is MediaIntentAction {
  return value === 'chat'
    || value === 'image_generate'
    || value === 'image_edit'
    || value === 'video_generate'
    || value === 'desktop_screenshot'
    || value === 'clarify';
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

  const reason = normalizeOptionalText(params.raw.reason);
  const selectedImageSource = params.raw.selected_image_source ?? params.raw.selectedImageSource;
  const selectedImageIndex = params.raw.selected_image_index ?? params.raw.selectedImageIndex;
  const prompt = normalizePrompt(
    params.raw.prompt ?? params.raw.rewritten_prompt ?? params.raw.rewrittenPrompt,
    params.prompt,
  );

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
      confidence,
      reason,
      selectedImageSource: imageSelection.selectedImageSource,
      selectedImageIndex: imageSelection.selectedImageIndex,
      sourceImages: imageSelection.sourceImages,
      prompt,
    };
  }

  if (action === 'video_generate') {
    const imageSelection = selectImage({
      selectedImageSource,
      selectedImageIndex,
      explicitImages: params.explicitImages,
      candidateImages: params.candidateImages,
    });
    return {
      action,
      source: 'planner',
      confidence,
      reason,
      selectedImageSource: imageSelection.selectedImageSource,
      selectedImageIndex: imageSelection.selectedImageIndex,
      sourceImages: imageSelection.sourceImages,
      prompt,
    };
  }

  if (action === 'clarify') {
    return clarificationPlan(reason || 'planner_requested_clarification', normalizeOptionalText(params.raw.clarification));
  }

  return {
    action,
    source: 'planner',
    confidence,
    reason,
    selectedImageSource: 'none',
    prompt,
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
        'Your job is to decide whether the next step should be normal chat, still-image generation, still-image editing, video generation, desktop screenshot capture, or a clarification question.',
        'Do not answer the user. Do not execute tools. Only produce the route plan.',
        'Actions: chat, image_generate, image_edit, video_generate, desktop_screenshot, clarify.',
        'Use chat for explanations, research/search requests, planning, automation workflows, coding, and requests that do not require immediate media tool execution.',
        'Use image_generate only when the user wants a new still image from text.',
        'Use image_edit only when the user wants to change an existing image. image_edit MUST select exactly one explicit_images or candidate_images item.',
        'If the user asks to edit "this image", "it", "the previous image", or similar but no usable image exists, use clarify. Never downgrade image_edit to image_generate.',
        'Use explicit_images before candidate_images. Use candidate_images only when the user clearly refers to current/recent/previous image context.',
        'Use video_generate only when the user wants video creation, animation, or image-to-video.',
        'Use desktop_screenshot only for a direct request to capture the current desktop/screen. Use chat for broader computer-use/browser automation tasks.',
        'requested_mode is a UI hint, not a substitute for reasoning. Respect image/video mode when it is compatible with the prompt; otherwise choose clarify or chat.',
        'Return JSON schema: {"action":"chat|image_generate|image_edit|video_generate|desktop_screenshot|clarify","confidence":0-1,"selected_image_source":"explicit|candidate|none","selected_image_index":number|null,"prompt":string|null,"clarification":string|null,"reason":string}',
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
