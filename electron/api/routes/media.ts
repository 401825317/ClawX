import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import {
  CLAWX_OPENAI_IMAGE_DEFAULT_MODEL,
  CLAWX_OPENAI_IMAGE_PROVIDER_KEY,
} from '../../utils/openclaw-image-relay-constants';
import {
  CLAWX_OPENAI_VIDEO_DEFAULT_MODEL,
  CLAWX_OPENAI_VIDEO_PROVIDER_KEY,
  normalizeClawXOpenAiVideoModelId,
} from '../../utils/openclaw-video-relay-constants';
import { parseJsonBody, sendJson } from '../route-utils';
import {
  applyOpenAiImageRelaySettings,
  getImageGenerationSettingsSnapshot,
  listImageGenerationProvidersFromRuntime,
  runImageGenerationTest,
  setImageGenerationConfig,
  type ImageGenerationModelConfig,
} from '../../utils/openclaw-image-generation';
import {
  applyOpenAiVideoRelaySettings,
  getVideoGenerationSettingsSnapshot,
  listVideoGenerationProvidersFromRuntime,
  runVideoGenerationTest,
  setVideoGenerationConfig,
  type VideoGenerationModelConfig,
} from '../../utils/openclaw-video-generation';
import {
  enqueueMediaGenerationJob,
  getMediaGenerationJob,
} from '../../utils/media-generation-jobs';
import {
  planMediaIntent,
  type MediaIntentRecentMessage,
} from '../../utils/media-intent-planner';
import { logger } from '../../utils/logger';
import type {
  MediaGenerationInputImageRef,
  VideoGenerationRouteDecision,
  VideoGenerationRouteMode,
} from '../../utils/media-generation-types';
import {
  countVideoPromptCharacters,
  getVideoPromptLengthError,
  MAX_VIDEO_GENERATION_PROMPT_CHARS,
} from '../../utils/video-generation-prompt-limits';
import {
  createLocalArtifact,
  type LocalArtifactCreateRequest,
} from '../../utils/local-artifact-runtime';

function normalizeMediaInputImageRefs(
  images: Array<{
    fileName?: string;
    mimeType?: string;
    filePath?: string;
  }> | undefined,
): MediaGenerationInputImageRef[] | undefined {
  return Array.isArray(images)
    ? images
      .filter((image) => typeof image?.filePath === 'string' && image.filePath.trim())
      .map((image) => ({
        fileName: typeof image.fileName === 'string' ? image.fileName.trim() : undefined,
        mimeType: typeof image.mimeType === 'string' ? image.mimeType.trim() : undefined,
        filePath: image.filePath!.trim(),
      }))
    : undefined;
}

function isVideoRouteMode(value: unknown): value is VideoGenerationRouteMode {
  return value === 'text_to_video'
    || value === 'image_to_video'
    || value === 'edit_image_then_video';
}

function normalizeVideoRouteDecision(
  rawRoute: unknown,
  params: {
    prompt: string;
    inputImages?: MediaGenerationInputImageRef[];
  },
): VideoGenerationRouteDecision {
  const route = rawRoute && typeof rawRoute === 'object'
    ? rawRoute as Record<string, unknown>
    : {};
  const rawMode = route.mode;
  const mode = isVideoRouteMode(rawMode)
    ? rawMode
    : ((params.inputImages?.length ?? 0) > 0 ? 'image_to_video' : 'text_to_video');
  const routeSourceImages = normalizeMediaInputImageRefs(route.sourceImages as Array<{
    fileName?: string;
    mimeType?: string;
    filePath?: string;
  }> | undefined);
  const sourceImages = routeSourceImages?.length
    ? routeSourceImages
    : (mode === 'text_to_video' ? undefined : params.inputImages);
  const selectedImageSource = route.selectedImageSource === 'candidate' || route.selectedImageSource === 'explicit'
    ? route.selectedImageSource
    : (sourceImages?.length ? 'explicit' : 'none');
  const selectedImageIndex = typeof route.selectedImageIndex === 'number' && Number.isFinite(route.selectedImageIndex)
    ? Math.max(0, Math.floor(route.selectedImageIndex))
    : (sourceImages?.length ? 0 : undefined);

  return {
    mode: sourceImages?.length ? mode : 'text_to_video',
    source: route.source === 'fallback' ? 'fallback' : 'router',
    confidence: typeof route.confidence === 'number' && Number.isFinite(route.confidence)
      ? Math.max(0, Math.min(1, route.confidence))
      : undefined,
    reason: typeof route.reason === 'string' ? route.reason : undefined,
    selectedImageSource: sourceImages?.length ? selectedImageSource : 'none',
    selectedImageIndex,
    videoPrompt: typeof route.videoPrompt === 'string' && route.videoPrompt.trim()
      ? route.videoPrompt.trim()
      : params.prompt,
    imageEditPrompt: typeof route.imageEditPrompt === 'string' && route.imageEditPrompt.trim()
      ? route.imageEditPrompt.trim()
      : undefined,
    sourceImages,
  };
}

export async function handleMediaRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/local-artifacts/create' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<LocalArtifactCreateRequest>(req);
      const artifact = await createLocalArtifact(body);
      sendJson(res, 200, { success: true, artifact });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/media/intent-plan' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        prompt?: string;
        requestedMode?: 'chat' | 'image' | 'video';
        explicitImages?: Array<{
          fileName?: string;
          mimeType?: string;
          filePath?: string;
        }>;
        candidateImages?: Array<{
          fileName?: string;
          mimeType?: string;
          filePath?: string;
        }>;
        recentMessages?: MediaIntentRecentMessage[];
      }>(req);
      const plan = await planMediaIntent({
        prompt: body.prompt?.trim() || '',
        requestedMode: body.requestedMode,
        explicitImages: normalizeMediaInputImageRefs(body.explicitImages),
        candidateImages: normalizeMediaInputImageRefs(body.candidateImages),
        recentMessages: Array.isArray(body.recentMessages) ? body.recentMessages : undefined,
      });
      logger.info('[media-intent-route] planned', {
        requestedMode: body.requestedMode || 'chat',
        action: plan.action,
        source: plan.source,
        confidence: plan.confidence,
        selectedImageSource: plan.selectedImageSource,
        selectedImageIndex: plan.selectedImageIndex,
        sourceImageCount: plan.sourceImages?.length ?? 0,
        compositeTaskCount: plan.compositeTasks?.length ?? 0,
      });
      sendJson(res, 200, { success: true, plan });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/media/generation-jobs/') && req.method === 'GET') {
    const jobId = decodeURIComponent(url.pathname.slice('/api/media/generation-jobs/'.length)).trim();
    const job = jobId ? getMediaGenerationJob(jobId) : null;
    if (!job) {
      sendJson(res, 404, { success: false, error: 'Media generation job not found' });
      return true;
    }
    sendJson(res, 200, { success: true, job });
    return true;
  }

  if (url.pathname === '/api/media/image-generation' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, ...(await getImageGenerationSettingsSnapshot()) });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/media/image-generation' && req.method === 'PUT') {
    try {
      const body = await parseJsonBody<{
        timeoutMs?: number | null;
        openAiRelayEnabled?: boolean;
        openAiRelayBaseUrl?: string | null;
        openAiRelayModel?: string | null;
        openAiRelayApiKey?: string;
      }>(req);

      const current = await getImageGenerationSettingsSnapshot();
      const normalizeRelayModel = (value: unknown): string => {
        const raw = typeof value === 'string' && value.trim()
          ? value.trim()
          : (current.openAiRelay.model || CLAWX_OPENAI_IMAGE_DEFAULT_MODEL);
        const slash = raw.indexOf('/');
        return (slash > 0 ? raw.slice(slash + 1) : raw).trim() || CLAWX_OPENAI_IMAGE_DEFAULT_MODEL;
      };
      const relayModel = normalizeRelayModel(body.openAiRelayModel);
      let nextPrimary = current.config.primary;
      if (body.openAiRelayEnabled === true) {
        nextPrimary = `${CLAWX_OPENAI_IMAGE_PROVIDER_KEY}/${relayModel}`;
      } else if (body.openAiRelayEnabled === false) {
        nextPrimary = null;
      }
      const next: ImageGenerationModelConfig = {
        primary: nextPrimary,
        fallbacks: [],
        timeoutMs: body.timeoutMs !== undefined
          ? (typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? Math.floor(body.timeoutMs) : null)
          : current.config.timeoutMs,
      };

      if (typeof body.openAiRelayEnabled === 'boolean') {
        await applyOpenAiImageRelaySettings({
          enabled: body.openAiRelayEnabled,
          baseUrl: body.openAiRelayBaseUrl,
          apiKey: body.openAiRelayApiKey,
          model: relayModel,
        });
      }

      const config = await setImageGenerationConfig(next);
      const snapshot = await getImageGenerationSettingsSnapshot();
      sendJson(res, 200, {
        success: true,
        ...snapshot,
        config,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/media/image-generation/providers' && req.method === 'GET') {
    try {
      const providers = await listImageGenerationProvidersFromRuntime();
      sendJson(res, 200, { success: true, providers });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/media/image-generation/test' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        agentId?: string;
        prompt?: string;
        model?: string;
      }>(req);
      const result = await runImageGenerationTest(body);
      sendJson(res, result.success ? 200 : 500, result);
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/media/image-generation/chat-send' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        sessionKey?: string;
        originalPrompt?: string;
        prompt?: string;
        model?: string;
        size?: string;
        quality?: 'low' | 'medium' | 'high';
        inputImages?: Array<{
          fileName?: string;
          mimeType?: string;
          filePath?: string;
        }>;
        userInputImages?: Array<{
          fileName?: string;
          mimeType?: string;
          filePath?: string;
        }>;
        userMessageTimestampMs?: number;
        suppressConversationAppend?: boolean;
      }>(req);
      const sessionKey = body.sessionKey?.trim() || '';
      const prompt = body.prompt?.trim() || '';
      const originalPrompt = body.originalPrompt?.trim();
      if (!sessionKey) {
        sendJson(res, 400, { success: false, error: 'sessionKey is required' });
        return true;
      }
      if (!prompt) {
        sendJson(res, 400, { success: false, error: 'prompt is required' });
        return true;
      }
      const inputImages = Array.isArray(body.inputImages)
        ? body.inputImages
          .filter((image) => typeof image?.filePath === 'string' && image.filePath.trim())
          .map((image) => ({
            fileName: typeof image.fileName === 'string' ? image.fileName.trim() : undefined,
            mimeType: typeof image.mimeType === 'string' ? image.mimeType.trim() : undefined,
            filePath: image.filePath!.trim(),
          }))
        : undefined;
      const userInputImages = normalizeMediaInputImageRefs(body.userInputImages);
      const userMessageTimestampMs = typeof body.userMessageTimestampMs === 'number' && Number.isFinite(body.userMessageTimestampMs)
        ? Math.floor(body.userMessageTimestampMs)
        : undefined;

      const payload = {
        kind: 'image' as const,
        sessionKey,
        prompt,
        model: body.model?.trim(),
        size: body.size?.trim(),
        quality: body.quality,
        inputImages,
        ...(originalPrompt ? { originalPrompt } : {}),
        ...(userInputImages ? { userInputImages } : {}),
        ...(userMessageTimestampMs !== undefined ? { userMessageTimestampMs } : {}),
        ...(body.suppressConversationAppend === true ? { suppressConversationAppend: true } : {}),
      };
      const job = enqueueMediaGenerationJob(payload);
      sendJson(res, 202, { success: true, jobId: job.id, job });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/media/video-generation' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, ...(await getVideoGenerationSettingsSnapshot()) });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/media/video-generation' && req.method === 'PUT') {
    try {
      const body = await parseJsonBody<{
        timeoutMs?: number | null;
        openAiRelayEnabled?: boolean;
        openAiRelayBaseUrl?: string | null;
        openAiRelayModel?: string | null;
        openAiRelayApiKey?: string;
      }>(req);

      const current = await getVideoGenerationSettingsSnapshot();
      const relayModel = normalizeClawXOpenAiVideoModelId(
        typeof body.openAiRelayModel === 'string' && body.openAiRelayModel.trim()
          ? body.openAiRelayModel
          : (current.openAiRelay.model || CLAWX_OPENAI_VIDEO_DEFAULT_MODEL),
      );
      let nextPrimary = current.config.primary;
      let nextFallbacks = current.config.fallbacks;
      if (body.openAiRelayEnabled === true) {
        nextPrimary = `${CLAWX_OPENAI_VIDEO_PROVIDER_KEY}/${relayModel}`;
        nextFallbacks = [];
      } else if (body.openAiRelayEnabled === false) {
        nextPrimary = null;
        nextFallbacks = [];
      }
      const next: VideoGenerationModelConfig = {
        primary: nextPrimary,
        fallbacks: nextFallbacks,
        timeoutMs: body.timeoutMs !== undefined
          ? (typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? Math.floor(body.timeoutMs) : null)
          : current.config.timeoutMs,
      };

      if (typeof body.openAiRelayEnabled === 'boolean') {
        await applyOpenAiVideoRelaySettings({
          enabled: body.openAiRelayEnabled,
          baseUrl: body.openAiRelayBaseUrl,
          apiKey: body.openAiRelayApiKey,
          model: relayModel,
          timeoutMs: next.timeoutMs,
        });
      }

      const config = await setVideoGenerationConfig(next);
      const snapshot = await getVideoGenerationSettingsSnapshot();
      sendJson(res, 200, {
        success: true,
        ...snapshot,
        config,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/media/video-generation/providers' && req.method === 'GET') {
    try {
      const providers = await listVideoGenerationProvidersFromRuntime();
      sendJson(res, 200, { success: true, providers });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/media/video-generation/test' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        agentId?: string;
        prompt?: string;
        model?: string;
      }>(req);
      const result = await runVideoGenerationTest(body);
      sendJson(res, result.success ? 200 : 500, result);
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/media/video-generation/chat-send' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        sessionKey?: string;
        originalPrompt?: string;
        prompt?: string;
        model?: string;
        size?: string;
        durationSeconds?: number;
        inputImages?: Array<{
          fileName?: string;
          mimeType?: string;
          filePath?: string;
        }>;
        userInputImages?: Array<{
          fileName?: string;
          mimeType?: string;
          filePath?: string;
        }>;
        userMessageTimestampMs?: number;
        candidateImages?: Array<{
          fileName?: string;
          mimeType?: string;
          filePath?: string;
        }>;
        route?: unknown;
        suppressConversationAppend?: boolean;
      }>(req);
      const sessionKey = body.sessionKey?.trim() || '';
      const prompt = body.prompt?.trim() || '';
      if (!sessionKey) {
        sendJson(res, 400, { success: false, error: 'sessionKey is required' });
        return true;
      }
      if (!prompt) {
        sendJson(res, 400, { success: false, error: 'prompt is required' });
        return true;
      }
      const inputImages = normalizeMediaInputImageRefs(body.inputImages);
      const userInputImages = normalizeMediaInputImageRefs(body.userInputImages);
      const originalPrompt = body.originalPrompt?.trim() || prompt;
      const userMessageTimestampMs = typeof body.userMessageTimestampMs === 'number' && Number.isFinite(body.userMessageTimestampMs)
        ? Math.floor(body.userMessageTimestampMs)
        : undefined;
      logger.info('[video-generation-route] chat_send_received', {
        sessionKey,
        promptChars: countVideoPromptCharacters(prompt),
        model: body.model?.trim(),
        size: body.size?.trim(),
        durationSeconds: body.durationSeconds,
        inputImageCount: inputImages?.length ?? 0,
      });
      const route = normalizeVideoRouteDecision(body.route, {
        prompt,
        inputImages,
      });
      logger.info('[video-generation-route] chat_send_planned', {
        sessionKey,
        mode: route.mode,
        source: route.source,
        confidence: route.confidence,
        selectedImageSource: route.selectedImageSource,
        selectedImageIndex: route.selectedImageIndex,
        sourceImageCount: route.sourceImages?.length ?? 0,
      });

      const finalVideoPrompt = route.videoPrompt?.trim() || prompt;
      const finalVideoPromptChars = countVideoPromptCharacters(finalVideoPrompt);
      const promptLengthError = getVideoPromptLengthError(finalVideoPrompt);
      if (promptLengthError) {
        logger.warn('[video-generation-route] chat_send_prompt_too_long', {
          sessionKey,
          mode: route.mode,
          source: route.source,
          promptChars: finalVideoPromptChars,
          maxPromptChars: MAX_VIDEO_GENERATION_PROMPT_CHARS,
        });
        sendJson(res, 400, {
          success: false,
          error: promptLengthError,
          promptChars: finalVideoPromptChars,
          maxPromptChars: MAX_VIDEO_GENERATION_PROMPT_CHARS,
        });
        return true;
      }

      const payload = {
        kind: 'video' as const,
        sessionKey,
        prompt: finalVideoPrompt,
        originalPrompt,
        ...(body.model?.trim() ? { model: body.model.trim() } : {}),
        size: body.size?.trim(),
        durationSeconds: typeof body.durationSeconds === 'number' && Number.isFinite(body.durationSeconds)
          ? Math.max(1, Math.floor(body.durationSeconds))
          : undefined,
        inputImages: route.mode === 'text_to_video' ? undefined : route.sourceImages,
        ...(userInputImages ? { userInputImages } : {}),
        ...(userMessageTimestampMs !== undefined ? { userMessageTimestampMs } : {}),
        route,
        ...(body.suppressConversationAppend === true ? { suppressConversationAppend: true } : {}),
      };
      const job = enqueueMediaGenerationJob(payload);
      logger.info('[video-generation-route] chat_send_enqueued', {
        jobId: job.id,
        sessionKey,
        mode: route.mode,
        status: job.status,
      });

      sendJson(res, 202, { success: true, jobId: job.id, job });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
