import {
  generateImageForChatSession,
} from './openclaw-image-generation';
import {
  generateVideoForChatSession,
} from './openclaw-video-generation';
import type {
  MediaGenerationWorkerRequest,
  MediaGenerationWorkerResponse,
} from './media-generation-types';

const MAX_WORKER_ENTRY_ERROR_CHARS = 4096;

function truncateText(text: string, maxChars = MAX_WORKER_ENTRY_ERROR_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function formatErrorLikeObject(error: Record<string, unknown>): string {
  const fields: string[] = [];
  for (const key of ['name', 'message', 'code', 'status', 'statusCode', 'type']) {
    const value = error[key];
    if (typeof value === 'string' && value.trim()) {
      fields.push(`${key}: ${value.trim()}`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      fields.push(`${key}: ${String(value)}`);
    }
  }

  const nestedError = error.error;
  if (nestedError && typeof nestedError === 'object' && !Array.isArray(nestedError)) {
    const message = (nestedError as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      fields.push(`error.message: ${message.trim()}`);
    }
  }

  return fields.join('\n');
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const parts = [
      error.stack || `${error.name}: ${error.message}`,
    ];
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause) {
      parts.push(`Caused by: ${toErrorMessage(cause)}`);
    }
    return truncateText(parts.join('\n'));
  }

  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const formatted = formatErrorLikeObject(error as Record<string, unknown>);
    if (formatted) {
      return truncateText(formatted);
    }
  }

  return truncateText(String(error));
}

type UtilityProcessParentPort = {
  on(event: 'message', listener: (messageEvent: unknown) => void): void;
  postMessage(message: unknown): void;
};

function getParentPort(): UtilityProcessParentPort {
  const parentPort = (process as NodeJS.Process & { parentPort?: UtilityProcessParentPort }).parentPort;
  if (!parentPort) {
    throw new Error('Electron utility process parentPort is unavailable');
  }
  return parentPort;
}

const parentPort = getParentPort();

function getMessageData(messageEvent: unknown): unknown {
  if (messageEvent && typeof messageEvent === 'object' && 'data' in messageEvent) {
    return (messageEvent as { data?: unknown }).data;
  }
  return messageEvent;
}

async function handleRun(message: MediaGenerationWorkerRequest): Promise<void> {
  try {
    const result = message.payload.kind === 'image'
      ? await generateImageForChatSession({
        sessionKey: message.payload.sessionKey,
        prompt: message.payload.prompt,
        model: message.payload.model,
        size: message.payload.size,
        quality: message.payload.quality,
        inputImages: message.payload.inputImages,
      })
      : await generateVideoForChatSession({
        sessionKey: message.payload.sessionKey,
        prompt: message.payload.prompt,
        size: message.payload.size,
        durationSeconds: message.payload.durationSeconds,
        inputImages: message.payload.inputImages,
      });

    parentPort.postMessage({
      type: 'result',
      jobId: message.jobId,
      success: true,
      result,
    } satisfies MediaGenerationWorkerResponse);
  } catch (error) {
    parentPort.postMessage({
      type: 'result',
      jobId: message.jobId,
      success: false,
      error: toErrorMessage(error),
    } satisfies MediaGenerationWorkerResponse);
  }
}

parentPort.on('message', (messageEvent) => {
  const request = getMessageData(messageEvent) as MediaGenerationWorkerRequest;
  if (request?.type !== 'run') {
    return;
  }
  void handleRun(request);
});
