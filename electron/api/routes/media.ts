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
  generateImageForChatSession,
  getImageGenerationSettingsSnapshot,
  listImageGenerationProvidersFromRuntime,
  runImageGenerationTest,
  setImageGenerationConfig,
  type ImageGenerationModelConfig,
} from '../../utils/openclaw-image-generation';
import {
  applyOpenAiVideoRelaySettings,
  generateVideoForChatSession,
  getVideoGenerationSettingsSnapshot,
  listVideoGenerationProvidersFromRuntime,
  runVideoGenerationTest,
  setVideoGenerationConfig,
  type VideoGenerationModelConfig,
} from '../../utils/openclaw-video-generation';
import { appendImageGenerationConversation } from '../../utils/chat-session-image-message';

export async function handleMediaRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
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
        prompt?: string;
        model?: string;
        size?: string;
        quality?: 'low' | 'medium' | 'high';
        inputImages?: Array<{
          fileName?: string;
          mimeType?: string;
          filePath?: string;
        }>;
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
      const inputImages = Array.isArray(body.inputImages)
        ? body.inputImages
          .filter((image) => typeof image?.filePath === 'string' && image.filePath.trim())
          .map((image) => ({
            fileName: typeof image.fileName === 'string' ? image.fileName.trim() : undefined,
            mimeType: typeof image.mimeType === 'string' ? image.mimeType.trim() : undefined,
            filePath: image.filePath!.trim(),
          }))
        : undefined;

      const result = await generateImageForChatSession({
        sessionKey,
        prompt,
        model: body.model?.trim(),
        size: body.size?.trim(),
        quality: body.quality,
        inputImages,
      });
      const outputPaths = result.outputs.map((output) => output.path);
      const inputPaths = (inputImages ?? []).map((image) => image.filePath);
      const usedEditInput = inputPaths.length > 0;

      await appendImageGenerationConversation({
        sessionKey,
        prompt,
        outputPaths,
        inputPaths,
        summaryText: usedEditInput ? '图片已修改。' : '图片已生成。',
      });

      sendJson(res, 200, { success: true, result });
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
        prompt?: string;
        model?: string;
        size?: string;
        durationSeconds?: number;
        inputImages?: Array<{
          fileName?: string;
          mimeType?: string;
          filePath?: string;
        }>;
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
      const inputImages = Array.isArray(body.inputImages)
        ? body.inputImages
          .filter((image) => typeof image?.filePath === 'string' && image.filePath.trim())
          .map((image) => ({
            fileName: typeof image.fileName === 'string' ? image.fileName.trim() : undefined,
            mimeType: typeof image.mimeType === 'string' ? image.mimeType.trim() : undefined,
            filePath: image.filePath!.trim(),
          }))
        : undefined;

      const result = await generateVideoForChatSession({
        sessionKey,
        prompt,
        model: body.model?.trim(),
        size: body.size?.trim(),
        durationSeconds: typeof body.durationSeconds === 'number' && Number.isFinite(body.durationSeconds)
          ? Math.max(1, Math.floor(body.durationSeconds))
          : undefined,
        inputImages,
      });
      const outputLocations = result.outputs
        .map((output) => output.path || output.url || '')
        .filter((value) => value.trim().length > 0);
      const inputPaths = (inputImages ?? []).map((image) => image.filePath);
      const usedImageInput = inputPaths.length > 0;

      await appendImageGenerationConversation({
        sessionKey,
        prompt,
        outputPaths: outputLocations,
        inputPaths,
        summaryText: usedImageInput ? '已基于参考图生成视频。' : '视频已生成。',
      });

      sendJson(res, 200, { success: true, result });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
