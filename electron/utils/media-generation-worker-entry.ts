import {
  generateImageForChatSession,
} from './openclaw-image-generation';
import {
  generateVideoForChatSession,
} from './openclaw-video-generation';
import { basename } from 'node:path';
import type {
  ImageGenerationJobPayload,
  MediaGenerationInputImageRef,
  VideoGenerationJobPayload,
  MediaGenerationWorkerRequest,
  MediaGenerationWorkerResponse,
} from './media-generation-types';
import {
  countVideoPromptCharacters,
  getVideoPromptLengthError,
} from './video-generation-prompt-limits';

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

function summarizeInputImagesForLog(images: MediaGenerationInputImageRef[] | undefined): Array<Record<string, unknown>> {
  return (images ?? []).map((image, index) => ({
    index,
    fileName: image.fileName || null,
    mimeType: image.mimeType || null,
    filePath: image.filePath,
  }));
}

function logWorkerEvent(event: string, details: Record<string, unknown>): void {
  console.error(`[media-generation-worker] ${event} ${JSON.stringify(details)}`);
}

function getFirstOutputImageRef(result: unknown): MediaGenerationInputImageRef | null {
  const outputs = typeof result === 'object' && result !== null && Array.isArray((result as { outputs?: unknown }).outputs)
    ? (result as { outputs: unknown[] }).outputs
    : [];
  for (const output of outputs) {
    if (!output || typeof output !== 'object') continue;
    const record = output as { path?: unknown; mimeType?: unknown; fileName?: unknown };
    if (typeof record.path === 'string' && record.path.trim()) {
      const filePath = record.path.trim();
      return {
        filePath,
        mimeType: typeof record.mimeType === 'string' && record.mimeType.trim()
          ? record.mimeType.trim()
          : 'image/png',
        fileName: typeof record.fileName === 'string' && record.fileName.trim()
          ? record.fileName.trim()
          : basename(filePath),
      };
    }
  }
  return null;
}

async function runVideoPayload(payload: VideoGenerationJobPayload): Promise<unknown> {
  if (payload.route?.mode !== 'edit_image_then_video') {
    const promptLengthError = getVideoPromptLengthError(payload.prompt);
    if (promptLengthError) {
      throw new Error(promptLengthError);
    }

    const startedAt = Date.now();
    logWorkerEvent('video_start', {
      sessionKey: payload.sessionKey,
      mode: payload.route?.mode ?? 'direct_video',
      promptChars: countVideoPromptCharacters(payload.prompt),
      size: payload.size,
      durationSeconds: payload.durationSeconds,
      inputImages: summarizeInputImagesForLog(payload.inputImages),
    });
    const result = await generateVideoForChatSession({
      sessionKey: payload.sessionKey,
      prompt: payload.prompt,
      model: payload.model,
      size: payload.size,
      durationSeconds: payload.durationSeconds,
      inputImages: payload.inputImages,
    }, { skipManagedRelayPreparation: true });
    logWorkerEvent('video_done', {
      sessionKey: payload.sessionKey,
      mode: payload.route?.mode ?? 'direct_video',
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  const pipelineStartedAt = Date.now();
  logWorkerEvent('pipeline_start', {
    sessionKey: payload.sessionKey,
    mode: payload.route.mode,
    selectedImageSource: payload.route.selectedImageSource,
    selectedImageIndex: payload.route.selectedImageIndex,
    size: payload.size,
    durationSeconds: payload.durationSeconds,
    inputImages: summarizeInputImagesForLog(payload.inputImages),
    routeSourceImages: summarizeInputImagesForLog(payload.route.sourceImages),
  });

  const sourceImages = payload.route.sourceImages?.length
    ? payload.route.sourceImages
    : payload.inputImages;
  const sourceImage = sourceImages?.[0];
  if (!sourceImage) {
    logWorkerEvent('pipeline_missing_source_image', {
      sessionKey: payload.sessionKey,
      mode: payload.route.mode,
    });
    throw new Error('edit_image_then_video requires one source image.');
  }

  const imageEditPrompt = payload.route.imageEditPrompt?.trim()
    || payload.originalPrompt?.trim()
    || payload.prompt;
  const videoPrompt = payload.route.videoPrompt?.trim() || payload.prompt;
  const promptLengthError = getVideoPromptLengthError(videoPrompt);
  if (promptLengthError) {
    throw new Error(promptLengthError);
  }

  const imageStartedAt = Date.now();
  logWorkerEvent('pipeline_image_edit_start', {
    sessionKey: payload.sessionKey,
    sourceImage,
    promptChars: countVideoPromptCharacters(imageEditPrompt),
  });
  const imageResult = await generateImageForChatSession({
    sessionKey: payload.sessionKey,
    prompt: imageEditPrompt,
    inputImages: [sourceImage],
  }, { skipManagedRelayPreparation: true });
  const editedImage = getFirstOutputImageRef(imageResult);
  logWorkerEvent('pipeline_image_edit_done', {
    sessionKey: payload.sessionKey,
    durationMs: Date.now() - imageStartedAt,
    editedImage,
  });
  if (!editedImage) {
    throw new Error('Image edit completed without a local output image.');
  }

  const videoStartedAt = Date.now();
  logWorkerEvent('pipeline_video_start', {
    sessionKey: payload.sessionKey,
    editedImage,
    promptChars: countVideoPromptCharacters(videoPrompt),
    size: payload.size,
    durationSeconds: payload.durationSeconds,
  });
  const videoResult = await generateVideoForChatSession({
    sessionKey: payload.sessionKey,
    prompt: videoPrompt,
    model: payload.model,
    size: payload.size,
    durationSeconds: payload.durationSeconds,
    inputImages: [editedImage],
  }, { skipManagedRelayPreparation: true });
  logWorkerEvent('pipeline_video_done', {
    sessionKey: payload.sessionKey,
    durationMs: Date.now() - videoStartedAt,
    totalDurationMs: Date.now() - pipelineStartedAt,
  });

  return {
    ...(typeof videoResult === 'object' && videoResult !== null ? videoResult : {}),
    pipeline: {
      mode: 'edit_image_then_video',
      imageEditPrompt,
      videoPrompt,
      sourceImages: [sourceImage],
      intermediateImage: imageResult,
    },
  };
}

async function runImagePayload(payload: ImageGenerationJobPayload): Promise<unknown> {
  const startedAt = Date.now();
  logWorkerEvent('image_start', {
    sessionKey: payload.sessionKey,
    promptChars: payload.prompt.length,
    model: payload.model,
    size: payload.size,
    quality: payload.quality,
    batchIndex: payload.batchIndex,
    batchTotal: payload.batchTotal,
    inputImages: summarizeInputImagesForLog(payload.inputImages),
  });
  const result = await generateImageForChatSession({
    sessionKey: payload.sessionKey,
    prompt: payload.prompt,
    model: payload.model,
    size: payload.size,
    quality: payload.quality,
    inputImages: payload.inputImages,
  }, { skipManagedRelayPreparation: true });
  logWorkerEvent('image_done', {
    sessionKey: payload.sessionKey,
    durationMs: Date.now() - startedAt,
    batchIndex: payload.batchIndex,
    batchTotal: payload.batchTotal,
  });
  return result;
}

async function handleRun(message: MediaGenerationWorkerRequest): Promise<void> {
  try {
    const result = message.payload.kind === 'image'
      ? await runImagePayload(message.payload)
      : await runVideoPayload(message.payload);

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
