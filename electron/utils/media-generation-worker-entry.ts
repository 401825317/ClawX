import { parentPort } from 'electron';
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

parentPort.on('message', (event) => {
  const message = event.data as MediaGenerationWorkerRequest;
  if (message?.type !== 'run') {
    return;
  }
  void handleRun(message);
});
