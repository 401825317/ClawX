import type { IncomingMessage, ServerResponse } from 'http';
import { CHAT_SEND_RPC_TIMEOUT_MS } from '../../../shared/chat-timeouts';
import { PORTS } from '../../utils/config';
import { scheduleControlUiDeviceAutoApproval } from '../../utils/control-ui-device-pairing';
import { buildOpenClawControlUiUrl } from '../../utils/openclaw-control-ui';
import { getSetting } from '../../utils/store';
import { logger } from '../../utils/logger';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

async function runGatewayRpc<T>(ctx: HostApiContext, method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  return await ctx.gatewayManager.rpc<T>(method, params, timeoutMs);
}

export async function handleGatewayRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/app/gateway-info' && req.method === 'GET') {
    const status = ctx.gatewayManager.getStatus();
    const token = await getSetting('gatewayToken');
    const port = status.port || PORTS.OPENCLAW_GATEWAY;
    sendJson(res, 200, {
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      token,
      port,
    });
    return true;
  }

  if (url.pathname === '/api/gateway/status' && req.method === 'GET') {
    sendJson(res, 200, ctx.gatewayManager.getStatus());
    return true;
  }

  if (url.pathname === '/api/gateway/health' && req.method === 'GET') {
    const health = await ctx.gatewayManager.checkHealth({
      probe: url.searchParams.get('probe') === '1' || url.searchParams.get('probe') === 'true',
    });
    sendJson(res, 200, health);
    return true;
  }

  if (url.pathname === '/api/gateway/start' && req.method === 'POST') {
    try {
      await ctx.gatewayManager.start({
        reason: 'api-gateway-start',
        source: '/api/gateway/start',
      });
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/stop' && req.method === 'POST') {
    try {
      await ctx.gatewayManager.stop({
        reason: 'api-gateway-stop',
        source: '/api/gateway/stop',
      });
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/restart' && req.method === 'POST') {
    try {
      await ctx.gatewayManager.restart({
        reason: 'api-gateway-restart',
        source: '/api/gateway/restart',
      });
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/control-ui' && req.method === 'GET') {
    try {
      const status = ctx.gatewayManager.getStatus();
      const token = await getSetting('gatewayToken');
      const port = status.port || PORTS.OPENCLAW_GATEWAY;
      const view = url.searchParams.get('view') === 'dreams' ? 'dreams' : undefined;
      const urlValue = buildOpenClawControlUiUrl(port, token, { view });
      scheduleControlUiDeviceAutoApproval(ctx.gatewayManager);
      sendJson(res, 200, { success: true, url: urlValue, token, port });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/chat/sessions' && req.method === 'GET') {
    try {
      const result = await runGatewayRpc<Record<string, unknown>>(ctx, 'sessions.list', {
        includeDerivedTitles: true,
        includeLastMessage: true,
      });
      sendJson(res, 200, { success: true, result });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/chat/history' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        sessionKey: string;
        limit?: number;
        maxChars?: number;
        timeoutMs?: number;
      }>(req);
      const params: Record<string, unknown> = {
        sessionKey: body.sessionKey,
        ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
        ...(typeof body.maxChars === 'number' ? { maxChars: body.maxChars } : {}),
      };
      const result = await runGatewayRpc<Record<string, unknown>>(
        ctx,
        'chat.history',
        params,
        typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      );
      sendJson(res, 200, { success: true, result });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/chat/send' && req.method === 'POST') {
    const startedAt = Date.now();
    let sessionKeyForLog = 'unknown';
    try {
      const body = await parseJsonBody<{
        sessionKey: string;
        message: string;
        deliver?: boolean;
        idempotencyKey: string;
      }>(req);
      sessionKeyForLog = body.sessionKey;
      const result = await runGatewayRpc<{ runId?: string }>(
        ctx,
        'chat.send',
        {
          sessionKey: body.sessionKey,
          message: body.message,
          deliver: body.deliver ?? false,
          idempotencyKey: body.idempotencyKey,
        },
        CHAT_SEND_RPC_TIMEOUT_MS,
      );
      logger.info('[metric] chat.send.rpc', {
        sessionKey: sessionKeyForLog,
        elapsedMs: Date.now() - startedAt,
        runId: result.runId ?? null,
        media: false,
      });
      sendJson(res, 200, { success: true, result });
    } catch (error) {
      logger.warn('[metric] chat.send.rpc.failed', {
        sessionKey: sessionKeyForLog,
        elapsedMs: Date.now() - startedAt,
        media: false,
        error: String(error),
      });
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/chat/abort' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ sessionKey: string }>(req);
      const result = await runGatewayRpc<Record<string, unknown>>(ctx, 'chat.abort', { sessionKey: body.sessionKey });
      sendJson(res, 200, { success: true, result });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/chat/send-with-media' && req.method === 'POST') {
    const startedAt = Date.now();
    let sessionKeyForLog = 'unknown';
    try {
      const body = await parseJsonBody<{
        sessionKey: string;
        message: string;
        deliver?: boolean;
        idempotencyKey: string;
        media?: Array<{ filePath: string; mimeType: string; fileName: string }>;
      }>(req);
      sessionKeyForLog = body.sessionKey;
      const VISION_MIME_TYPES = new Set([
        'image/png', 'image/jpeg', 'image/bmp', 'image/webp',
      ]);
      const imageAttachments: Array<{ content: string; mimeType: string; fileName: string }> = [];
      const fileReferences: string[] = [];
      if (body.media && body.media.length > 0) {
        const fsP = await import('node:fs/promises');
        for (const m of body.media) {
          fileReferences.push(`[media attached: ${m.filePath} (${m.mimeType}) | ${m.filePath}]`);
          if (VISION_MIME_TYPES.has(m.mimeType)) {
            const fileBuffer = await fsP.readFile(m.filePath);
            imageAttachments.push({
              content: fileBuffer.toString('base64'),
              mimeType: m.mimeType,
              fileName: m.fileName,
            });
          }
        }
      }

      const message = fileReferences.length > 0
        ? [body.message, ...fileReferences].filter(Boolean).join('\n')
        : body.message;
      const rpcParams: Record<string, unknown> = {
        sessionKey: body.sessionKey,
        message,
        deliver: body.deliver ?? false,
        idempotencyKey: body.idempotencyKey,
      };
      if (imageAttachments.length > 0) {
        rpcParams.attachments = imageAttachments;
      }
      const result = await runGatewayRpc<{ runId?: string }>(ctx, 'chat.send', rpcParams, CHAT_SEND_RPC_TIMEOUT_MS);
      logger.info('[metric] chat.send.rpc', {
        sessionKey: sessionKeyForLog,
        elapsedMs: Date.now() - startedAt,
        runId: result.runId ?? null,
        media: true,
        mediaCount: body.media?.length ?? 0,
      });
      sendJson(res, 200, { success: true, result });
    } catch (error) {
      logger.warn('[metric] chat.send.rpc.failed', {
        sessionKey: sessionKeyForLog,
        elapsedMs: Date.now() - startedAt,
        media: true,
        error: String(error),
      });
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
