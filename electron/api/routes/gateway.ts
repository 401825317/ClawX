import type { IncomingMessage, ServerResponse } from 'http';
import { CHAT_SEND_RPC_TIMEOUT_MS } from '../../../shared/chat-timeouts';
import { isArtifactCapabilityQuestion, isArtifactCreationRequest } from '../../../shared/artifact-intent';
import { PORTS } from '../../utils/config';
import { scheduleControlUiDeviceAutoApproval } from '../../utils/control-ui-device-pairing';
import { buildOpenClawControlUiUrl } from '../../utils/openclaw-control-ui';
import { getSetting } from '../../utils/store';
import { logger } from '../../utils/logger';
import { agentTurnPreferenceStore, normalizeUClawTurnPreferences } from '../../services/agent-runtime/turn-preference-store';
import { ensureJunFeiAIProviderSeeded } from '../../services/junfeiai/junfeiai-service';
import {
  buildOpenClawInlineImageAttachment,
  OPENCLAW_INLINE_IMAGE_SAFE_MAX_BYTES,
  OPENCLAW_VISION_MIME_TYPES,
} from '../../utils/openclaw-inline-image';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

async function runGatewayRpc<T>(ctx: HostApiContext, method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  return await ctx.gatewayManager.rpc<T>(method, params, timeoutMs);
}

type ChatSendRpcParams = {
  sessionKey: string;
  message: string;
  deliver: boolean;
  idempotencyKey: string;
  thinking?: string;
  attachments?: Array<{ content: string; mimeType: string; fileName: string }>;
};

type ChatSendSessionTail = {
  abortVersion: number;
  promise: Promise<void>;
};

const CHAT_ABORT_SETTLE_MS = 750;
const CHAT_SEND_CONFLICT_RETRY_TIMEOUT_MS = 30_000;
const CHAT_SEND_CONFLICT_RETRY_DELAY_MS = 1_000;
const chatSendSessionTails = new Map<string, ChatSendSessionTail>();
const chatAbortSessionTails = new Map<string, Promise<void>>();
const chatAbortSettleUntil = new Map<string, number>();
const chatAbortSessionVersions = new Map<string, number>();
const inFlightChatSendByIdempotencyKey = new Map<string, Promise<{ runId?: string }>>();
const CJK_RE = /[\u3400-\u9fff]/u;
const SIMPLE_GREETING_RE = /^(?:hi|hello|hey|yo|嗨|哈喽|你好|您好|在吗|在不在|你在吗|早上好|早|下午好|晚上好|hi[,， ]*codex|hello[,， ]*codex)[.!?。！？~～\s]*$/iu;
const SIMPLE_IDENTITY_RE = /^(?:你是谁|你是啥|你是什么|介绍一下你自己|who are you|what are you)[?？.!。！\s]*$/iu;
const SIMPLE_CAPABILITY_RE = /^(?:你|uclaw|clawx|codex|助手|这个)?\s*(?:能|可以|会|支持|能不能|可不可以|会不会).{0,24}(?:做什么|干什么|帮我什么|帮忙做什么|有什么(?:能力|功能|用)|有哪些(?:能力|功能)|什么(?:能力|功能)|what can you do|what do you do)[?？.!。！\s]*$/iu;
const LIGHTWEIGHT_CHAT_MAX_CHARS = 80;
const CHAT_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'adaptive']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractChatSendText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    return message
      .flatMap((part) => {
        if (!isRecord(part)) return [];
        const type = typeof part.type === 'string' ? part.type.toLowerCase() : '';
        const text = typeof part.text === 'string' ? part.text : '';
        return type === 'text' && text ? [text] : [];
      })
      .join('\n');
  }
  if (isRecord(message)) {
    const nested = message.content ?? message.text ?? message.message;
    if (nested !== message) {
      return extractChatSendText(nested);
    }
  }
  return '';
}

function buildChatSendDiagnostic(message: unknown, options: { media: boolean; mediaCount?: number; deliver?: boolean }) {
  const normalized = extractChatSendText(message);
  return {
    messageChars: Array.from(normalized).length,
    containsCjk: CJK_RE.test(normalized),
    artifactIntent: isArtifactCreationRequest(normalized),
    media: options.media,
    mediaCount: options.mediaCount ?? 0,
    deliver: options.deliver ?? false,
  };
}

function normalizeThinkingLevelOverride(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return CHAT_THINKING_LEVELS.has(normalized) ? normalized : undefined;
}

function resolveChatSendThinkingOverride(message: unknown, explicitThinking?: unknown): { thinking: string; reason: string } | null {
  const explicit = normalizeThinkingLevelOverride(explicitThinking);
  if (explicit) {
    return { thinking: explicit, reason: 'explicit' };
  }

  const normalized = extractChatSendText(message).replace(/\s+/gu, ' ').trim();
  if (!normalized || Array.from(normalized).length > LIGHTWEIGHT_CHAT_MAX_CHARS) {
    return null;
  }
  if (isArtifactCreationRequest(normalized)) {
    return null;
  }

  if (SIMPLE_GREETING_RE.test(normalized)) {
    return { thinking: 'xhigh', reason: 'simple_greeting' };
  }
  if (SIMPLE_IDENTITY_RE.test(normalized)) {
    return { thinking: 'xhigh', reason: 'simple_identity' };
  }
  if (SIMPLE_CAPABILITY_RE.test(normalized) || isArtifactCapabilityQuestion(normalized)) {
    return { thinking: 'xhigh', reason: 'capability_question' };
  }

  return null;
}

function isChatSessionInitializationConflict(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes('session initialization')
    || message.includes('reply session')
    || message.includes('repy session')
  ) && (
    message.includes('conflict')
    || message.includes('conflicted')
    || message.includes('conffict')
    || message.includes('confficted')
  );
}

async function waitForChatAbortSettle(sessionKey: string): Promise<void> {
  const settleUntil = chatAbortSettleUntil.get(sessionKey) ?? 0;
  const remainingMs = settleUntil - Date.now();
  if (remainingMs <= 0) {
    chatAbortSettleUntil.delete(sessionKey);
    return;
  }
  await sleep(remainingMs);
  if ((chatAbortSettleUntil.get(sessionKey) ?? 0) <= Date.now()) {
    chatAbortSettleUntil.delete(sessionKey);
  }
}

async function runChatSendRpcWithConflictRetry(
  ctx: HostApiContext,
  sessionKey: string,
  params: ChatSendRpcParams,
): Promise<{ runId?: string }> {
  const startedAt = Date.now();
  let attempt = 0;
  while (true) {
    try {
      return await runGatewayRpc<{ runId?: string }>(ctx, 'chat.send', params, CHAT_SEND_RPC_TIMEOUT_MS);
    } catch (error) {
      if (!isChatSessionInitializationConflict(error)) {
        throw error;
      }
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= CHAT_SEND_CONFLICT_RETRY_TIMEOUT_MS) {
        throw error;
      }
      attempt += 1;
      logger.warn('[chat.send] Session initialization conflict; retrying after abort settle', {
        sessionKey,
        attempt,
        elapsedMs,
      });
      chatAbortSettleUntil.set(sessionKey, Date.now() + CHAT_SEND_CONFLICT_RETRY_DELAY_MS);
      await waitForChatAbortSettle(sessionKey);
    }
  }
}

async function runSerializedChatSendRpc(
  ctx: HostApiContext,
  params: ChatSendRpcParams,
): Promise<{ runId?: string }> {
  const sessionKey = params.sessionKey.trim() || 'unknown';
  const idempotencyKey = params.idempotencyKey.trim();
  const inFlightKey = idempotencyKey ? `${sessionKey}:${idempotencyKey}` : '';
  const existing = inFlightKey ? inFlightChatSendByIdempotencyKey.get(inFlightKey) : undefined;
  if (existing) {
    logger.info('[chat.send] Reusing in-flight idempotent request', { sessionKey });
    return existing;
  }

  const abortVersion = chatAbortSessionVersions.get(sessionKey) ?? 0;
  const previousSendTail = chatSendSessionTails.get(sessionKey);
  const previousSendPromise = previousSendTail?.abortVersion === abortVersion
    ? previousSendTail.promise
    : Promise.resolve();
  const previousAbortTail = chatAbortSessionTails.get(sessionKey) ?? Promise.resolve();
  const previousTail = Promise.all([
    previousSendPromise.catch(() => undefined),
    previousAbortTail.catch(() => undefined),
  ]).then(() => waitForChatAbortSettle(sessionKey));
  const promise = previousTail
    .catch(() => undefined)
    .then(() => runChatSendRpcWithConflictRetry(ctx, sessionKey, params))
    .finally(() => {
      if (inFlightKey && inFlightChatSendByIdempotencyKey.get(inFlightKey) === promise) {
        inFlightChatSendByIdempotencyKey.delete(inFlightKey);
      }
    });
  const currentTail = promise.then(() => undefined, () => undefined);
  chatSendSessionTails.set(sessionKey, { abortVersion, promise: currentTail });
  currentTail.finally(() => {
    if (chatSendSessionTails.get(sessionKey)?.promise === currentTail) {
      chatSendSessionTails.delete(sessionKey);
    }
  });

  if (inFlightKey) {
    inFlightChatSendByIdempotencyKey.set(inFlightKey, promise);
  }
  return promise;
}

async function runSerializedChatAbortRpc(
  ctx: HostApiContext,
  sessionKeyRaw: string,
  options: { runId?: string; taskIds?: string[] } = {},
): Promise<Record<string, unknown>> {
  const sessionKey = sessionKeyRaw.trim() || 'unknown';
  const runId = typeof options.runId === 'string' && options.runId.trim() ? options.runId.trim() : undefined;
  const taskIds = [...new Set((options.taskIds ?? [])
    .map((taskId) => typeof taskId === 'string' ? taskId.trim() : '')
    .filter(Boolean))].slice(0, 100);
  chatAbortSessionVersions.set(sessionKey, (chatAbortSessionVersions.get(sessionKey) ?? 0) + 1);
  const previousAbortTail = chatAbortSessionTails.get(sessionKey) ?? Promise.resolve();
  const promise = previousAbortTail
    .catch(() => undefined)
    .then(async () => {
      const taskCancellations = await Promise.all(taskIds.map(async (taskId) => {
        try {
          const result = await runGatewayRpc<Record<string, unknown>>(ctx, 'tasks.cancel', {
            taskId,
            reason: 'Cancelled from the UClaw chat composer.',
          }, 15_000);
          return { taskId, ok: true, result };
        } catch (error) {
          logger.warn('[chat.abort] Failed to cancel detached task', { taskId, error: String(error) });
          return { taskId, ok: false, error: String(error) };
        }
      }));
      const chat = await runGatewayRpc<Record<string, unknown>>(ctx, 'chat.abort', {
        sessionKey: sessionKeyRaw,
        ...(runId ? { runId } : {}),
      });
      return { ...chat, taskCancellations };
    })
    .finally(() => {
      chatAbortSettleUntil.set(sessionKey, Date.now() + CHAT_ABORT_SETTLE_MS);
    });
  const currentTail = promise.then(() => undefined, () => undefined);
  chatAbortSessionTails.set(sessionKey, currentTail);
  currentTail.finally(() => {
    if (chatAbortSessionTails.get(sessionKey) === currentTail) {
      chatAbortSessionTails.delete(sessionKey);
    }
  });
  return promise;
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
      await ensureJunFeiAIProviderSeeded({
        gatewayManager: ctx.gatewayManager,
        syncRuntime: true,
        syncRuntimeOnAuthChange: true,
      });
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
      await ensureJunFeiAIProviderSeeded({
        gatewayManager: ctx.gatewayManager,
        syncRuntime: true,
        syncRuntimeOnAuthChange: true,
      });
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
        message: unknown;
        deliver?: boolean;
        idempotencyKey: string;
        thinking?: string | null;
        clientPreferences?: unknown;
      }>(req);
      sessionKeyForLog = body.sessionKey;
      const messageText = extractChatSendText(body.message);
      const sendDiagnostic = buildChatSendDiagnostic(body.message, {
        media: false,
        deliver: body.deliver ?? false,
      });
      const thinkingOverride = resolveChatSendThinkingOverride(body.message, body.thinking);
      logger.info('[diagnostic] chat.send.request', {
        sessionKey: sessionKeyForLog,
        ...sendDiagnostic,
        ...(thinkingOverride
          ? {
              thinkingOverride: thinkingOverride.thinking,
              thinkingOverrideReason: thinkingOverride.reason,
            }
          : {}),
      });
      const rpcParams: ChatSendRpcParams = {
        sessionKey: body.sessionKey,
        message: messageText,
        deliver: body.deliver ?? false,
        idempotencyKey: body.idempotencyKey,
      };
      if (thinkingOverride) {
        rpcParams.thinking = thinkingOverride.thinking;
      }
      const preferences = normalizeUClawTurnPreferences(body.clientPreferences);
      const preferenceEntry = preferences
        ? agentTurnPreferenceStore.enqueue({
            sessionKey: body.sessionKey,
            idempotencyKey: body.idempotencyKey,
            message: messageText,
            preferences,
          })
        : undefined;
      let result: { runId?: string };
      try {
        result = await runSerializedChatSendRpc(ctx, rpcParams);
      } catch (error) {
        agentTurnPreferenceStore.discard(preferenceEntry?.id);
        throw error;
      }
      logger.info('[metric] chat.send.rpc', {
        sessionKey: sessionKeyForLog,
        elapsedMs: Date.now() - startedAt,
        runId: result.runId ?? null,
        ...sendDiagnostic,
        ...(thinkingOverride
          ? {
              thinkingOverride: thinkingOverride.thinking,
              thinkingOverrideReason: thinkingOverride.reason,
            }
          : {}),
        ...(preferences?.mode ? { clientPreferenceMode: preferences.mode } : {}),
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
      const body = await parseJsonBody<{ sessionKey: string; runId?: string; taskIds?: string[] }>(req);
      const result = await runSerializedChatAbortRpc(ctx, body.sessionKey, {
        runId: body.runId,
        taskIds: Array.isArray(body.taskIds) ? body.taskIds : [],
      });
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
        message: unknown;
        deliver?: boolean;
        idempotencyKey: string;
        thinking?: string | null;
        inlineAttachments?: boolean;
        clientPreferences?: unknown;
        media?: Array<{ filePath: string; mimeType: string; fileName: string }>;
      }>(req);
      sessionKeyForLog = body.sessionKey;
      const imageAttachments: Array<{ content: string; mimeType: string; fileName: string }> = [];
      const fileReferences: string[] = [];
      const shouldInlineAttachments = body.inlineAttachments !== false;
      if (body.media && body.media.length > 0) {
        for (const m of body.media) {
          fileReferences.push(`[media attached: ${m.filePath} (${m.mimeType}) | ${m.filePath}]`);
          if (shouldInlineAttachments && OPENCLAW_VISION_MIME_TYPES.has(m.mimeType)) {
            const inlineImage = await buildOpenClawInlineImageAttachment(m);
            if (!inlineImage.attachment) {
              logger.warn('[chat.send] Skipping inline image attachment above OpenClaw safe inline cap', {
                sessionKey: sessionKeyForLog,
                fileName: m.fileName,
                bytes: inlineImage.inputBytes,
                limitBytes: OPENCLAW_INLINE_IMAGE_SAFE_MAX_BYTES,
                reason: inlineImage.skippedReason,
              });
              continue;
            }
            if (inlineImage.resized) {
              logger.info('[chat.send] Resized inline image attachment for OpenClaw parser safety', {
                sessionKey: sessionKeyForLog,
                fileName: m.fileName,
                inputBytes: inlineImage.inputBytes,
                outputBytes: inlineImage.outputBytes,
                outputMimeType: inlineImage.outputMimeType,
                limitBytes: OPENCLAW_INLINE_IMAGE_SAFE_MAX_BYTES,
              });
            }
            imageAttachments.push(inlineImage.attachment);
          } else if (!shouldInlineAttachments && OPENCLAW_VISION_MIME_TYPES.has(m.mimeType)) {
            logger.info('[chat.send] Using media path reference without inline attachment', {
              sessionKey: sessionKeyForLog,
              fileName: m.fileName,
              mimeType: m.mimeType,
            });
          }
        }
      }

      const baseMessage = extractChatSendText(body.message);
      const message = fileReferences.length > 0
        ? [baseMessage, ...fileReferences].filter(Boolean).join('\n')
        : baseMessage;
      const sendDiagnostic = buildChatSendDiagnostic(message, {
        media: true,
        mediaCount: body.media?.length ?? 0,
        deliver: body.deliver ?? false,
      });
      const thinkingOverride = resolveChatSendThinkingOverride(message, body.thinking);
      logger.info('[diagnostic] chat.send.request', {
        sessionKey: sessionKeyForLog,
        ...sendDiagnostic,
        inlineAttachments: shouldInlineAttachments,
        ...(thinkingOverride
          ? {
              thinkingOverride: thinkingOverride.thinking,
              thinkingOverrideReason: thinkingOverride.reason,
            }
          : {}),
      });
      const rpcParams: Record<string, unknown> = {
        sessionKey: body.sessionKey,
        message,
        deliver: body.deliver ?? false,
        idempotencyKey: body.idempotencyKey,
      };
      if (thinkingOverride) {
        rpcParams.thinking = thinkingOverride.thinking;
      }
      if (imageAttachments.length > 0) {
        rpcParams.attachments = imageAttachments;
      }
      const preferences = normalizeUClawTurnPreferences(body.clientPreferences);
      const preferenceEntry = preferences
        ? agentTurnPreferenceStore.enqueue({
            sessionKey: body.sessionKey,
            idempotencyKey: body.idempotencyKey,
            message,
            preferences,
          })
        : undefined;
      let result: { runId?: string };
      try {
        result = await runSerializedChatSendRpc(ctx, rpcParams as ChatSendRpcParams);
      } catch (error) {
        agentTurnPreferenceStore.discard(preferenceEntry?.id);
        throw error;
      }
      logger.info('[metric] chat.send.rpc', {
        sessionKey: sessionKeyForLog,
        elapsedMs: Date.now() - startedAt,
        runId: result.runId ?? null,
        ...sendDiagnostic,
        ...(thinkingOverride
          ? {
              thinkingOverride: thinkingOverride.thinking,
              thinkingOverrideReason: thinkingOverride.reason,
            }
          : {}),
        ...(preferences?.mode ? { clientPreferenceMode: preferences.mode } : {}),
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
