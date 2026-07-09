import type { IncomingMessage, ServerResponse } from 'http';
import { promises as fsP } from 'node:fs';
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
  cancelMediaGenerationJob,
  cancelMediaGenerationJobsForRun,
  cancelMediaGenerationJobsForSession,
  enqueueMediaGenerationJob,
  getMediaGenerationJob,
  getMediaGenerationJobsForSession,
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
import {
  isLocalArtifactKind,
  planLocalArtifactBatch,
  type LocalArtifactPlanItem,
} from '../../utils/local-artifact-planner';
import {
  appendCompositeArtifactConversation,
  type PersistedCompositeArtifactManifest,
} from '../../utils/chat-session-image-message';
import {
  compositeRunCoordinator,
} from '../../utils/composite-run-coordinator';
import type {
  CompositeRunRetryRequest,
  CompositeRunStartRequest,
} from '../../../shared/composite-run';

const CANCELLED_LOCAL_RUN_TTL_MS = 30 * 60 * 1000;
const cancelledLocalRunIds = new Map<string, number>();

function rememberCancelledLocalRun(runId: string): void {
  if (!runId) return;
  const now = Date.now();
  cancelledLocalRunIds.set(runId, now);
  for (const [candidateRunId, cancelledAt] of cancelledLocalRunIds) {
    if (now - cancelledAt > CANCELLED_LOCAL_RUN_TTL_MS) {
      cancelledLocalRunIds.delete(candidateRunId);
    }
  }
}

function localRunWasCancelled(runId: string): boolean {
  const cancelledAt = cancelledLocalRunIds.get(runId);
  return cancelledAt != null && Date.now() - cancelledAt <= CANCELLED_LOCAL_RUN_TTL_MS;
}

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
  ctx: HostApiContext,
): Promise<boolean> {
  compositeRunCoordinator.setPublisher((event) => {
    ctx.eventBus.emit('chat:runtime-event', event);
    const mainWindow = ctx.mainWindow;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat:runtime-event', event);
    }
  });

  if (url.pathname === '/api/composite-runs' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<CompositeRunStartRequest>(req);
      const result = await compositeRunCoordinator.start(body);
      sendJson(res, result.idempotent ? 200 : 202, result);
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/composite-runs' && req.method === 'GET') {
    try {
      const sessionKey = url.searchParams.get('sessionKey')?.trim() || undefined;
      const activeOnly = url.searchParams.get('activeOnly') === 'true';
      const runs = await compositeRunCoordinator.list(sessionKey, activeOnly);
      sendJson(res, 200, { success: true, runs });
    } catch (error) {
      sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/composite-runs/')) {
    const suffix = url.pathname.slice('/api/composite-runs/'.length);
    const segments = suffix.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
    const runId = segments[0]?.trim() || '';
    const action = segments[1]?.trim() || '';

    if (runId && !action && req.method === 'GET') {
      const run = await compositeRunCoordinator.get(runId);
      sendJson(res, run ? 200 : 404, run
        ? { success: true, run }
        : { success: false, error: 'Composite run not found' });
      return true;
    }

    if (runId && action === 'cancel' && req.method === 'POST') {
      const run = await compositeRunCoordinator.cancel(runId);
      sendJson(res, run ? 200 : 404, run
        ? { success: true, run }
        : { success: false, error: 'Composite run not found' });
      return true;
    }

    if (runId && action === 'retry' && req.method === 'POST') {
      try {
        const body = await parseJsonBody<CompositeRunRetryRequest>(req);
        const run = await compositeRunCoordinator.retry(runId, body);
        sendJson(res, run ? 202 : 404, run
          ? { success: true, run }
          : { success: false, error: 'Composite run not found' });
      } catch (error) {
        sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
  }

  if (url.pathname === '/api/local-artifacts/plan-batch' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ items?: LocalArtifactPlanItem[]; runId?: string }>(req);
      const runId = body.runId?.trim() || '';
      if (runId && localRunWasCancelled(runId)) {
        sendJson(res, 409, { success: false, error: 'Local artifact planning cancelled' });
        return true;
      }
      const items = (Array.isArray(body.items) ? body.items : [])
        .filter((item) => (
          typeof item?.id === 'string'
          && item.request
          && isLocalArtifactKind(item.request.kind)
        ));
      const result = await planLocalArtifactBatch(items);
      if (runId && localRunWasCancelled(runId)) {
        sendJson(res, 409, { success: false, error: 'Local artifact planning cancelled' });
        return true;
      }
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/local-artifacts/create' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<LocalArtifactCreateRequest & { runId?: string }>(req);
      const runId = body.runId?.trim() || '';
      if (runId && localRunWasCancelled(runId)) {
        sendJson(res, 409, { success: false, error: 'Local artifact creation cancelled' });
        return true;
      }
      const artifact = await createLocalArtifact(body);
      if (runId && localRunWasCancelled(runId)) {
        await fsP.rm(artifact.filePath, { force: true }).catch(() => undefined);
        sendJson(res, 409, { success: false, error: 'Local artifact creation cancelled' });
        return true;
      }
      sendJson(res, 200, { success: true, artifact });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/local-artifacts/append-conversation' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        sessionKey?: string;
        prompt?: string;
        runId?: string;
        summaryText?: string;
        files?: Array<{
          fileName?: string;
          mimeType?: string;
          fileSize?: number;
          width?: number;
          height?: number;
          filePath?: string;
          gatewayUrl?: string;
          source?: 'user-upload' | 'tool-result' | 'message-ref' | 'gateway-media';
        }>;
        outputPaths?: string[];
        inputPaths?: string[];
        userMessageTimestampMs?: number;
        manifest?: PersistedCompositeArtifactManifest;
      }>(req);
      const sessionKey = body.sessionKey?.trim() || '';
      const prompt = body.prompt?.trim() || '';
      const runId = body.runId?.trim() || '';
      const summaryText = body.summaryText?.trim() || '';
      if (!sessionKey) {
        sendJson(res, 400, { success: false, error: 'sessionKey is required' });
        return true;
      }
      if (!prompt) {
        sendJson(res, 400, { success: false, error: 'prompt is required' });
        return true;
      }
      if (!summaryText) {
        sendJson(res, 400, { success: false, error: 'summaryText is required' });
        return true;
      }
      const userMessageTimestampMs = typeof body.userMessageTimestampMs === 'number' && Number.isFinite(body.userMessageTimestampMs)
        ? Math.floor(body.userMessageTimestampMs)
        : undefined;
      await appendCompositeArtifactConversation({
        sessionKey,
        prompt,
        summaryText,
        ...(runId ? { runId } : {}),
        files: Array.isArray(body.files) ? body.files : undefined,
        outputPaths: Array.isArray(body.outputPaths) ? body.outputPaths : undefined,
        inputPaths: Array.isArray(body.inputPaths) ? body.inputPaths : undefined,
        ...(userMessageTimestampMs !== undefined ? { userTimestampMs: userMessageTimestampMs } : {}),
        manifest: body.manifest,
        shouldAbort: () => Boolean(runId && localRunWasCancelled(runId)),
      });
      sendJson(res, 200, { success: true });
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

  if (url.pathname === '/api/media/generation-jobs' && req.method === 'GET') {
    const sessionKey = url.searchParams.get('sessionKey')?.trim() || '';
    if (!sessionKey) {
      sendJson(res, 400, { success: false, error: 'sessionKey is required' });
      return true;
    }
    const activeOnly = url.searchParams.get('activeOnly') !== 'false';
    sendJson(res, 200, {
      success: true,
      jobs: getMediaGenerationJobsForSession(sessionKey, { activeOnly }),
    });
    return true;
  }

  if (url.pathname === '/api/media/generation-jobs/cancel' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ jobId?: string; sessionKey?: string; runId?: string }>(req);
      const jobId = body.jobId?.trim() || '';
      const sessionKey = body.sessionKey?.trim() || '';
      const runId = body.runId?.trim() || '';
      if (!jobId && !sessionKey && !runId) {
        sendJson(res, 400, { success: false, error: 'jobId, sessionKey, or runId is required' });
        return true;
      }
      rememberCancelledLocalRun(runId);
      const cancelledJobIds = jobId
        ? (cancelMediaGenerationJob(jobId) ? [jobId] : [])
        : runId
          ? cancelMediaGenerationJobsForRun(runId, sessionKey || undefined)
          : cancelMediaGenerationJobsForSession(sessionKey);
      sendJson(res, 200, { success: true, cancelledJobIds });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
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
        runId?: string;
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
        ...(body.runId?.trim() ? { runId: body.runId.trim() } : {}),
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
        runId?: string;
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
        ...(body.runId?.trim() ? { runId: body.runId.trim() } : {}),
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
