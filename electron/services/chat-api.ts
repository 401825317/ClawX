import type { BrowserWindow } from 'electron';
import {
  addChatMediaImageToBudget,
  CHAT_MEDIA_MAX_ITEMS,
  CHAT_MEDIA_MAX_TOTAL_IMAGE_BYTES,
  CHAT_PROMPT_MAX_UTF8_BYTES,
  EMPTY_CHAT_MEDIA_IMAGE_BUDGET,
  chatMediaCountLimitError,
  chatMediaImageByteLimitError,
  chatPromptByteLimitError,
} from '@shared/chat/media-limits';
import type { GatewayManager } from '../gateway/manager';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import { logger } from '../utils/logger';
import { createAcpChatService } from './acp-chat-service';
import type { AcpSessionAccessRegistry } from './acp-session-access-registry';
import { isRecord } from './payload-utils';

const VISION_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/bmp',
  'image/webp',
]);

type ChatSendWithMediaPayload = {
  sessionKey?: unknown;
  message?: unknown;
  deliver?: unknown;
  idempotencyKey?: unknown;
  media?: unknown;
};

type MediaPayload = {
  filePath?: unknown;
  mimeType?: unknown;
  fileName?: unknown;
};

function normalizeMedia(media: unknown): Array<{ filePath: string; mimeType: string; fileName: string }> {
  if (!Array.isArray(media)) return [];
  return media.flatMap((entry): Array<{ filePath: string; mimeType: string; fileName: string }> => {
    if (!isRecord(entry)) return [];
    const item = entry as MediaPayload;
    if (typeof item.filePath !== 'string' || !item.filePath) return [];
    return [{
      filePath: item.filePath,
      mimeType: typeof item.mimeType === 'string' && item.mimeType ? item.mimeType : 'application/octet-stream',
      fileName: typeof item.fileName === 'string' && item.fileName ? item.fileName : item.filePath.split(/[\\/]/).pop() || 'file',
    }];
  });
}

function assertPromptWithinLimit(message: string): void {
  if (Buffer.byteLength(message, 'utf8') > CHAT_PROMPT_MAX_UTF8_BYTES) throw chatPromptByteLimitError();
}

async function readImageFileWithinLimit(filePath: string, maxBytes: number): Promise<Buffer> {
  const fsP = await import('node:fs/promises');
  const handle = await fsP.open(filePath, 'r');
  try {
    const initialStat = await handle.stat();
    if (!initialStat.isFile()) throw new Error('Attached image is not a regular file.');
    if (!Number.isSafeInteger(initialStat.size) || initialStat.size > maxBytes) {
      throw chatMediaImageByteLimitError();
    }

    // Read only the size observed on the open handle.  Unlike readFile(), this
    // cannot follow an attachment that grows beyond the remaining request
    // budget while it is being read.
    const buffer = Buffer.allocUnsafe(initialStat.size);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const finalStat = await handle.stat();
    if (offset !== buffer.byteLength || finalStat.size !== initialStat.size) {
      throw new Error('Attached image changed while it was being read. Try again.');
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

export function createChatApi({
  gatewayManager,
  mainWindow,
  acpSessionAccessRegistry,
}: {
  gatewayManager: GatewayManager;
  mainWindow: BrowserWindow;
  acpSessionAccessRegistry: AcpSessionAccessRegistry;
}): CompleteHostServiceRegistry['chat'] {
  const acpChat = createAcpChatService(mainWindow, acpSessionAccessRegistry, gatewayManager);
  if (typeof gatewayManager.getStatus === 'function') {
    void acpChat.warmupConnection();
  }

  return {
    sendWithMedia: async (payload) => {
      const body = isRecord(payload) ? payload as ChatSendWithMediaPayload : {};
      const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey : '';
      const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
      if (!sessionKey || !idempotencyKey) {
        return { success: false, error: 'Invalid chat send payload' };
      }

      try {
        let message = typeof body.message === 'string' ? body.message : '';
        assertPromptWithinLimit(message);
        const imageAttachments: Array<Record<string, unknown>> = [];
        const fileReferences: string[] = [];
        const media = normalizeMedia(body.media);

        if (media.length > 0) {
          if (media.length > CHAT_MEDIA_MAX_ITEMS) throw chatMediaCountLimitError();
          const fsP = await import('node:fs/promises');
          let imageBudget = EMPTY_CHAT_MEDIA_IMAGE_BUDGET;
          for (const item of media) {
            const exists = await fsP.access(item.filePath).then(() => true, () => false);
            logger.info(
              `[chat:sendWithMedia] Processing media: name=${item.fileName}, mimeType=${item.mimeType}, exists=${exists}, isVision=${VISION_MIME_TYPES.has(item.mimeType)}`,
            );

            fileReferences.push(
              `[media attached: ${item.filePath} (${item.mimeType}) | ${item.filePath}]`,
            );

            if (VISION_MIME_TYPES.has(item.mimeType)) {
              const fileBuffer = await readImageFileWithinLimit(
                item.filePath,
                CHAT_MEDIA_MAX_TOTAL_IMAGE_BYTES - imageBudget.imageBytes,
              );
              imageBudget = addChatMediaImageToBudget(imageBudget, fileBuffer.byteLength);
              const base64Data = fileBuffer.toString('base64');
              logger.info(`[chat:sendWithMedia] Read ${fileBuffer.length} bytes, base64 length: ${base64Data.length}`);
              imageAttachments.push({
                content: base64Data,
                mimeType: item.mimeType,
                fileName: item.fileName,
              });
            }
          }
        }

        if (fileReferences.length > 0) {
          const refs = fileReferences.join('\n');
          message = message ? `${message}\n\n${refs}` : refs;
          assertPromptWithinLimit(message);
        }

        const rpcParams: Record<string, unknown> = {
          sessionKey,
          message,
          deliver: body.deliver ?? false,
          idempotencyKey,
        };
        if (imageAttachments.length > 0) {
          rpcParams.attachments = imageAttachments;
        }

        logger.info(
          `[chat:sendWithMedia] Sending: messageLength=${message.length}, attachments=${imageAttachments.length}, fileRefs=${fileReferences.length}`,
        );
        const result = await gatewayManager.rpc('chat.send', rpcParams, 120000);
        const hasRunId = isRecord(result) && typeof result.runId === 'string';
        logger.info(`[chat:sendWithMedia] RPC result: runId=${hasRunId ? 'present' : 'absent'}`);
        const response = hasRunId
          ? { runId: result.runId as string }
          : undefined;
        return { success: true, ...(response ? { result: response } : {}) };
      } catch (error) {
        logger.error(`[chat:sendWithMedia] Error: ${String(error)}`);
        return { success: false, error: String(error) };
      }
    },
    loadAcpSession: (payload) => acpChat.loadSession(payload),
    sendAcpPrompt: (payload) => acpChat.sendPrompt(payload),
    cancelAcpSession: (payload) => acpChat.cancelSession(payload),
    respondAcpPermission: (payload) => acpChat.respondPermission(payload),
  };
}
