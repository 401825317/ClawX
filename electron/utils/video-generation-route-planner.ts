import { getProviderAccount } from '../services/providers/provider-store';
import { getProviderSecret } from '../services/secrets/secret-store';
import {
  getJunFeiAIProviderBaseUrl,
  JUNFEIAI_DEFAULT_API_PROTOCOL,
  JUNFEIAI_DEFAULT_MODEL,
  JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID,
} from './junfeiai-distribution';
import { logger } from './logger';
import type {
  MediaGenerationInputImageRef,
  VideoGenerationImageSource,
  VideoGenerationRouteDecision,
  VideoGenerationRouteMode,
} from './media-generation-types';
import {
  extractOpenAiPlannerText,
  fetchOpenAiPlannerResponse,
} from './openai-planner-request';
import {
  countVideoPromptCharacters,
  MAX_VIDEO_GENERATION_PROMPT_CHARS,
} from './video-generation-prompt-limits';

const VIDEO_ROUTE_PLANNER_TIMEOUT_MS = 60_000;
const VIDEO_ROUTE_PLANNER_MIN_CONFIDENCE = 0.6;
const MAX_ROUTE_PLANNER_IMAGES = 4;
const MAX_LOG_TEXT_CHARS = 800;

type VideoGenerationRoutePlannerParams = {
  prompt: string;
  inputImages?: MediaGenerationInputImageRef[];
  candidateImages?: MediaGenerationInputImageRef[];
};

type PlannerImageSource = Exclude<VideoGenerationImageSource, 'none'>;

function truncateForLog(text: string, maxChars = MAX_LOG_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function summarizeImagesForLog(images: MediaGenerationInputImageRef[]): Array<Record<string, unknown>> {
  return images.map((image, index) => ({
    index,
    fileName: image.fileName || null,
    mimeType: image.mimeType || null,
    filePath: image.filePath,
  }));
}

function summarizeDecisionForLog(route: VideoGenerationRouteDecision): Record<string, unknown> {
  return {
    mode: route.mode,
    source: route.source,
    confidence: route.confidence,
    reason: route.reason ? truncateForLog(route.reason, 300) : undefined,
    selectedImageSource: route.selectedImageSource,
    selectedImageIndex: route.selectedImageIndex,
    videoPrompt: route.videoPrompt ? truncateForLog(route.videoPrompt) : undefined,
    imageEditPrompt: route.imageEditPrompt ? truncateForLog(route.imageEditPrompt) : undefined,
    sourceImages: summarizeImagesForLog(route.sourceImages ?? []),
  };
}

function summarizeRawPlannerJsonForLog(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: raw.mode,
    confidence: raw.confidence,
    selected_image_source: raw.selected_image_source ?? raw.selectedImageSource,
    selected_image_index: raw.selected_image_index ?? raw.selectedImageIndex,
    video_prompt: typeof (raw.video_prompt ?? raw.videoPrompt) === 'string'
      ? truncateForLog(String(raw.video_prompt ?? raw.videoPrompt))
      : raw.video_prompt ?? raw.videoPrompt,
    image_edit_prompt: typeof (raw.image_edit_prompt ?? raw.imageEditPrompt) === 'string'
      ? truncateForLog(String(raw.image_edit_prompt ?? raw.imageEditPrompt))
      : raw.image_edit_prompt ?? raw.imageEditPrompt,
    reason: typeof raw.reason === 'string' ? truncateForLog(raw.reason, 300) : raw.reason,
  };
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

function clampConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizePrompt(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : fallback.trim();
}

function isRouteMode(value: unknown): value is VideoGenerationRouteMode {
  return value === 'text_to_video'
    || value === 'image_to_video'
    || value === 'edit_image_then_video';
}

function isImageSource(value: unknown): value is PlannerImageSource {
  return value === 'explicit' || value === 'candidate';
}

function getApiKey(secret: Awaited<ReturnType<typeof getProviderSecret>>): string | null {
  if (!secret) return null;
  if (secret.type === 'api_key' && secret.apiKey?.trim()) {
    return secret.apiKey.trim();
  }
  if (secret.type === 'local' && secret.apiKey?.trim()) {
    return secret.apiKey.trim();
  }
  return null;
}

function toChatCompletionsEndpoint(baseUrl: string): string {
  let normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    normalized = getJunFeiAIProviderBaseUrl().replace(/\/+$/, '');
  }
  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }
  if (/\/responses?$/i.test(normalized)) {
    return normalized.replace(/\/responses?$/i, '/chat/completions');
  }
  if (!/\/v1$/i.test(normalized)) {
    normalized = `${normalized}/v1`;
  }
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
  if (start < 0 || end <= start) {
    return null;
  }

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
  return images.slice(0, MAX_ROUTE_PLANNER_IMAGES).map((image, index) => ({
    index,
    fileName: image.fileName || null,
    mimeType: image.mimeType || null,
  }));
}

function makeFallbackRoute(params: {
  prompt: string;
  inputImages: MediaGenerationInputImageRef[];
  reason: string;
}): VideoGenerationRouteDecision {
  if (params.inputImages.length > 0) {
    return {
      mode: 'image_to_video',
      source: 'fallback',
      confidence: 1,
      reason: params.reason,
      selectedImageSource: 'explicit',
      selectedImageIndex: 0,
      videoPrompt: params.prompt.trim(),
      sourceImages: [params.inputImages[0]!],
    };
  }

  return {
    mode: 'text_to_video',
    source: 'fallback',
    confidence: 1,
    reason: params.reason,
    selectedImageSource: 'none',
    videoPrompt: params.prompt.trim(),
  };
}

function selectRouteImage(params: {
  selectedImageSource: unknown;
  selectedImageIndex: unknown;
  inputImages: MediaGenerationInputImageRef[];
  candidateImages: MediaGenerationInputImageRef[];
}): {
  selectedImageSource: VideoGenerationImageSource;
  selectedImageIndex?: number;
  sourceImages?: MediaGenerationInputImageRef[];
} {
  if (!isImageSource(params.selectedImageSource)) {
    const fallbackSource = params.inputImages.length > 0
      ? 'explicit'
      : (params.candidateImages.length > 0 ? 'candidate' : 'none');
    if (fallbackSource === 'none') {
      return { selectedImageSource: 'none' };
    }
    const fallbackImages = fallbackSource === 'explicit' ? params.inputImages : params.candidateImages;
    return {
      selectedImageSource: fallbackSource,
      selectedImageIndex: 0,
      sourceImages: [fallbackImages[0]!],
    };
  }

  const images = params.selectedImageSource === 'explicit'
    ? params.inputImages
    : params.candidateImages;
  if (images.length === 0) {
    return { selectedImageSource: 'none' };
  }

  const rawIndex = typeof params.selectedImageIndex === 'number' && Number.isFinite(params.selectedImageIndex)
    ? Math.floor(params.selectedImageIndex)
    : 0;
  const index = rawIndex >= 0 && rawIndex < Math.min(images.length, MAX_ROUTE_PLANNER_IMAGES)
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
  inputImages: MediaGenerationInputImageRef[];
  candidateImages: MediaGenerationInputImageRef[];
}): VideoGenerationRouteDecision | null {
  const mode = params.raw.mode;
  if (!isRouteMode(mode)) {
    return null;
  }

  const confidence = clampConfidence(params.raw.confidence) ?? 0;
  if (confidence < VIDEO_ROUTE_PLANNER_MIN_CONFIDENCE) {
    return null;
  }

  if (mode === 'text_to_video') {
    return {
      mode,
      source: 'router',
      confidence,
      reason: normalizePrompt(params.raw.reason, ''),
      selectedImageSource: 'none',
      videoPrompt: normalizePrompt(params.raw.video_prompt ?? params.raw.videoPrompt, params.prompt),
    };
  }

  const imageSelection = selectRouteImage({
    selectedImageSource: params.raw.selected_image_source ?? params.raw.selectedImageSource,
    selectedImageIndex: params.raw.selected_image_index ?? params.raw.selectedImageIndex,
    inputImages: params.inputImages,
    candidateImages: params.candidateImages,
  });
  if (!imageSelection.sourceImages?.length) {
    return null;
  }

  const videoPrompt = normalizePrompt(params.raw.video_prompt ?? params.raw.videoPrompt, params.prompt);
  const imageEditPrompt = normalizePrompt(
    params.raw.image_edit_prompt ?? params.raw.imageEditPrompt,
    params.prompt,
  );

  return {
    mode,
    source: 'router',
    confidence,
    reason: normalizePrompt(params.raw.reason, ''),
    selectedImageSource: imageSelection.selectedImageSource,
    selectedImageIndex: imageSelection.selectedImageIndex,
    videoPrompt,
    imageEditPrompt: mode === 'edit_image_then_video' ? imageEditPrompt : undefined,
    sourceImages: imageSelection.sourceImages,
  };
}

function buildPlannerMessages(params: {
  prompt: string;
  inputImages: MediaGenerationInputImageRef[];
  candidateImages: MediaGenerationInputImageRef[];
}): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: [
        'You are UClaw video intent router. Return strict JSON only.',
        'Choose mode: text_to_video, image_to_video, or edit_image_then_video.',
        'explicit_images are attached to the current send and are strong evidence.',
        'candidate_images are recent chat images; use them only when the user clearly refers to a previous/current/reference image or asks to continue from it.',
        'Use edit_image_then_video when the image should be changed first, then animated.',
        'Use image_to_video when the selected image should be animated or used as the visual base without a separate still-image edit.',
        'Use text_to_video when no image should influence the result, or when no usable image is available.',
        'Never invent model names. Select at most one image.',
        `Keep video_prompt concise and no more than ${MAX_VIDEO_GENERATION_PROMPT_CHARS} Unicode characters while preserving the user's core visual intent.`,
        'JSON schema: {"mode":"text_to_video|image_to_video|edit_image_then_video","confidence":0-1,"selected_image_source":"explicit|candidate|none","selected_image_index":number|null,"image_edit_prompt":string|null,"video_prompt":string,"reason":string}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        prompt: params.prompt,
        explicit_images: describeImages(params.inputImages),
        candidate_images: describeImages(params.candidateImages),
      }),
    },
  ];
}

export async function planVideoGenerationRoute(
  params: VideoGenerationRoutePlannerParams,
): Promise<VideoGenerationRouteDecision> {
  const startedAt = Date.now();
  const prompt = params.prompt.trim();
  const inputImages = normalizeImageRefs(params.inputImages);
  const candidateImages = normalizeImageRefs(params.candidateImages);
  logger.info('[video-route-planner] start', {
    timeoutMs: VIDEO_ROUTE_PLANNER_TIMEOUT_MS,
    prompt: truncateForLog(prompt),
    inputImages: summarizeImagesForLog(inputImages),
    candidateImages: summarizeImagesForLog(candidateImages),
  });
  const fallback = (reason: string) => {
    const route = makeFallbackRoute({ prompt, inputImages, reason });
    logger.warn('[video-route-planner] fallback', {
      reason,
      durationMs: Date.now() - startedAt,
      route: summarizeDecisionForLog(route),
    });
    return route;
  };

  if (!prompt) {
    return fallback('empty_prompt');
  }

  try {
    const secret = await getProviderSecret(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
    const apiKey = getApiKey(secret);
    if (!apiKey) {
      return fallback('router_api_key_unavailable');
    }

    const account = await getProviderAccount(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
    const apiProtocol = JUNFEIAI_DEFAULT_API_PROTOCOL;
    const model = account?.model?.trim() || JUNFEIAI_DEFAULT_MODEL;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VIDEO_ROUTE_PLANNER_TIMEOUT_MS);
    logger.info('[video-route-planner] request', {
      endpoint,
      model,
      promptChars: countVideoPromptCharacters(prompt),
      inputImageCount: inputImages.length,
      candidateImageCount: candidateImages.length,
    });

    try {
      const response = await fetchOpenAiPlannerResponse({
        baseUrl: account?.baseUrl || getJunFeiAIProviderBaseUrl(),
        fallbackBaseUrl: getJunFeiAIProviderBaseUrl(),
        headers: {
          ...(account?.headers ?? {}),
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        model,
        messages: buildPlannerMessages({ prompt, inputImages, candidateImages }),
        protocol: apiProtocol,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn('[video-route-planner] response_not_ok', {
          status: response.status,
          durationMs: Date.now() - startedAt,
          body: body ? truncateForLog(body) : undefined,
        });
        return fallback(`router_http_${response.status}`);
      }

      const content = extractOpenAiPlannerText(await response.json());
      const parsed = content ? parseJsonObject(content) : null;
      if (!parsed) {
        logger.warn('[video-route-planner] invalid_json', {
          durationMs: Date.now() - startedAt,
          content: typeof content === 'string' ? truncateForLog(content) : content,
        });
        return fallback('router_invalid_json');
      }
      logger.info('[video-route-planner] raw_decision', {
        durationMs: Date.now() - startedAt,
        raw: summarizeRawPlannerJsonForLog(parsed),
      });

      const planned = normalizePlannerDecision({
        raw: parsed,
        prompt,
        inputImages,
        candidateImages,
      });
      if (!planned) {
        return fallback('router_low_confidence_or_invalid_route');
      }
      logger.info('[video-route-planner] planned', {
        durationMs: Date.now() - startedAt,
        route: summarizeDecisionForLog(planned),
      });
      return planned;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    logger.warn('[video-route-planner] exception', {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback('router_exception');
  }
}
