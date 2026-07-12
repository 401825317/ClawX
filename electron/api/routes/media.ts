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
  cancelMediaGenerationJobWithResult,
  cancelMediaGenerationJobsForRun,
  cancelMediaGenerationJobsForSession,
  getMediaGenerationJob,
  getMediaGenerationJobsForSession,
  retryMediaGenerationJobDelivery,
} from '../../utils/media-generation-jobs';
import { logger } from '../../utils/logger';
import {
  compositeRunCoordinator,
} from '../../utils/composite-run-coordinator';
import type {
  CompositeRunCancelRequest,
  CompositeRunRetryRequest,
} from '../../../shared/composite-run';

const RETIRED_AGENT_BYPASS_PATHS = new Set([
  '/api/composite-runs',
  '/api/local-artifacts/plan-batch',
  '/api/local-artifacts/create',
  '/api/local-artifacts/append-conversation',
  '/api/media/intent-plan',
  '/api/media/image-generation/chat-send',
  '/api/media/video-generation/chat-send',
]);

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

  if (req.method === 'POST' && RETIRED_AGENT_BYPASS_PATHS.has(url.pathname)) {
    logger.warn('[media-route] retired_agent_bypass_blocked', {
      path: url.pathname,
      replacement: '/api/chat/send',
    });
    sendJson(res, 410, {
      success: false,
      code: 'media_agent_bypass_retired',
      error: 'This legacy media routing endpoint has been retired. Send the user turn through /api/chat/send with clientPreferences.',
      replacement: '/api/chat/send',
    });
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
      const body = await parseJsonBody<CompositeRunCancelRequest>(req).catch(() => ({}));
      const source = body.source?.trim().slice(0, 80) || 'unknown';
      logger.info('[composite-run-route] cancel received', { runId, source });
      const result = await compositeRunCoordinator.cancel(runId, { source });
      sendJson(res, result.outcome === 'not_found' ? 404 : 200, {
        success: result.outcome !== 'not_found',
        ...result,
        ...(result.outcome === 'not_found' ? { error: 'Composite run not found' } : {}),
      });
      return true;
    }

    if (runId && action === 'retry' && req.method === 'POST') {
      try {
        const body = await parseJsonBody<CompositeRunRetryRequest>(req);
        const result = await compositeRunCoordinator.retry(runId, body);
        const statusCode = result.outcome === 'retry_started'
          ? 202
          : result.outcome === 'not_found'
            ? 404
            : 409;
        sendJson(res, statusCode, {
          success: result.outcome === 'retry_started',
          ...result,
          ...(result.outcome === 'not_found'
            ? { error: 'Composite run not found' }
            : result.outcome === 'no_match'
              ? { error: 'No retryable composite tasks matched the request' }
              : result.outcome === 'not_retryable'
                ? { error: 'Composite run is not retryable' }
                : {}),
        });
      } catch (error) {
        sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
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
      if (jobId) {
        const result = cancelMediaGenerationJobWithResult(jobId);
        sendJson(res, result.outcome === 'not_found' ? 404 : 200, {
          success: result.outcome !== 'not_found',
          ...result,
          cancelledJobIds: result.outcome === 'cancelled' ? [jobId] : [],
          ...(result.outcome === 'not_found' ? { error: 'Media generation job not found' } : {}),
        });
        return true;
      }
      const cancelledJobIds = runId
        ? cancelMediaGenerationJobsForRun(runId, sessionKey || undefined)
        : cancelMediaGenerationJobsForSession(sessionKey);
      sendJson(res, 200, {
        success: true,
        outcome: cancelledJobIds.length > 0 ? 'cancelled' : 'no_match',
        cancelledJobIds,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/media/generation-jobs/retry' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ jobId?: string }>(req);
      const jobId = body.jobId?.trim() || '';
      if (!jobId) {
        sendJson(res, 400, { success: false, outcome: 'no_match', error: 'jobId is required' });
        return true;
      }
      const result = retryMediaGenerationJobDelivery(jobId);
      const statusCode = result.outcome === 'retry_started'
        ? 202
        : result.outcome === 'already_in_progress'
          ? 200
          : result.outcome === 'not_found'
            ? 404
            : 409;
      sendJson(res, statusCode, {
        success: result.outcome === 'retry_started' || result.outcome === 'already_in_progress',
        ...result,
        ...(result.outcome === 'not_found'
          ? { error: 'Media generation job not found' }
          : result.outcome === 'not_retryable'
            ? { error: 'Only failed standalone conversation delivery can be retried' }
            : {}),
      });
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

  return false;
}
