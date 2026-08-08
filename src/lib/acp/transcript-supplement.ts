import type { RawMessage } from '@shared/chat/types';
import type { SessionTurnTimingCandidate } from '@shared/host-api/contract';
import type { ImageGenerationCompletionEvidence, ImageGenerationTranscriptSupplement } from './image-generation-compat';
import { extractImageGenerationTranscriptSupplement } from './image-generation-compat';
import { hostApi } from '../host-api';
import {
  alignOpenClawMediaTurns,
  extractOpenClawMediaTurns,
  selectOpenClawTranscriptTurn,
  type OpenClawMediaTurnSupplement,
} from './openclaw-media-compat';
import type { AcpTimelineSnapshot } from './timeline-types';

export type CoordinatedImageGenerationCompletion = ImageGenerationCompletionEvidence & {
  transcriptMessageId?: string;
};

export type CoordinatedImageGenerationSupplement = Omit<ImageGenerationTranscriptSupplement, 'completions'> & {
  completions: CoordinatedImageGenerationCompletion[];
};

export type TranscriptSupplementResult = {
  imageGeneration: CoordinatedImageGenerationSupplement;
  media: OpenClawMediaTurnSupplement[];
  transcriptMediaTurnCount: number;
  turnTimings: SessionTurnTimingCandidate[];
};

export type FailedAssistantTurnSupplement = {
  text: string;
  transcriptMessageId?: string;
};

type TranscriptSupplementInput = {
  sessionKey: string;
  generation: number;
  executionCwd: string;
  snapshot: AcpTimelineSnapshot | (() => AcpTimelineSnapshot);
  liveUserMessageId?: string;
  isCurrent: () => boolean;
};

function recordTrace(input: TranscriptSupplementInput, event: string, details: Record<string, unknown>): void {
  void hostApi.diagnostics.recordAcpTrace({
    event,
    direction: 'projection',
    sessionKey: input.sessionKey,
    generation: input.generation,
    details,
  }).catch(() => undefined);
}

function transcriptMessageId(
  completion: ImageGenerationCompletionEvidence,
  messages: RawMessage[],
  sessionKey: string,
): string | undefined {
  if (completion.source !== 'transcript-history') return undefined;
  const prefix = `transcript:${sessionKey}:`;
  return messages
    .filter((message): message is RawMessage & { id: string } => typeof message.id === 'string' && message.id.length > 0)
    .sort((left, right) => right.id.length - left.id.length)
    .find((message) => completion.evidenceId.startsWith(`${prefix}${message.id}:`))
    ?.id;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const block = value as Record<string, unknown>;
    return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  }).join('\n');
}

function failedAssistantTurn(messages: RawMessage[]): FailedAssistantTurnSupplement | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || String(message.role).toLowerCase() !== 'assistant') continue;
    const failed = (message.stopReason ?? message.stop_reason)?.toLowerCase() === 'error'
      || Boolean(message.errorMessage ?? message.error_message);
    if (!failed) continue;
    const text = messageText(message.content).trim();
    if (!text) return null;
    return { text, ...(message.id ? { transcriptMessageId: message.id } : {}) };
  }
  return null;
}

/** Reads one failed live turn without replaying transcript history into the timeline. */
export async function fetchFailedOpenClawTurnSupplement(
  input: Pick<TranscriptSupplementInput, 'sessionKey' | 'snapshot' | 'liveUserMessageId' | 'isCurrent'>,
): Promise<FailedAssistantTurnSupplement | null> {
  if (!input.liveUserMessageId || !input.isCurrent()) return null;
  const response = await hostApi.sessions.history({ sessionKey: input.sessionKey, limit: 1000 }).catch(() => null);
  if (!response?.success || !Array.isArray(response.messages) || !input.isCurrent()) return null;
  const snapshot = typeof input.snapshot === 'function' ? input.snapshot() : input.snapshot;
  const messages = selectOpenClawTranscriptTurn(response.messages, snapshot, input.liveUserMessageId);
  return failedAssistantTurn(messages);
}

// OpenClaw ACP currently projects only assistant text/thought content and strips MEDIA
// directives from the visible reply. This bounded transcript read recovers only missing
// resource blocks; it is not a second Chat history source. Remove it when distributed
// OpenClaw ACP emits assistant resource_link/resource content. Architecture rationale:
// harness/reference/acp-generated-media-and-diagnostics.md
export async function fetchOpenClawTranscriptSupplement(
  input: TranscriptSupplementInput,
): Promise<TranscriptSupplementResult | null> {
  recordTrace(input, 'openclaw-media:history-request-started', {
    source: 'openclaw-media',
    reason: input.liveUserMessageId ? 'live' : 'historical',
  });

  const [historyResult, timingResult] = await Promise.allSettled([
    hostApi.sessions.history({ sessionKey: input.sessionKey, limit: 1000 }),
    input.liveUserMessageId
      ? Promise.resolve(null)
      : hostApi.sessions.turnTimings({ sessionKey: input.sessionKey, limit: 1000 }),
  ]);
  const response = historyResult.status === 'fulfilled' ? historyResult.value : null;
  const timingResponse = timingResult.status === 'fulfilled' ? timingResult.value : null;
  const turnTimings = timingResponse?.success && Array.isArray(timingResponse.timings)
    ? timingResponse.timings
    : [];
  if (!response?.success || !Array.isArray(response.messages)) {
    if (input.isCurrent()) {
      recordTrace(input, 'openclaw-media:history-request-failed', {
        source: 'openclaw-media',
        reason: 'request-failed',
      });
    } else {
      recordTrace(input, 'openclaw-media:projection-stale', {
        source: 'openclaw-media',
        reason: 'history-failure-stale',
      });
    }
    if (turnTimings.length === 0 || !input.isCurrent()) return null;
  }

  if (!input.isCurrent()) {
    recordTrace(input, 'openclaw-media:projection-stale', {
      source: 'openclaw-media',
      reason: 'history-response-stale',
    });
    return null;
  }
  const messages = response?.success && Array.isArray(response.messages) ? response.messages : [];
  const snapshot = typeof input.snapshot === 'function' ? input.snapshot() : input.snapshot;
  const imageMessages = input.liveUserMessageId
    ? selectOpenClawTranscriptTurn(messages, snapshot, input.liveUserMessageId)
    : messages;
  const extractedImages = extractImageGenerationTranscriptSupplement(imageMessages, input.sessionKey);
  const imageGeneration: CoordinatedImageGenerationSupplement = {
    starts: extractedImages.starts,
    completions: extractedImages.completions.map((completion) => {
      const messageId = transcriptMessageId(completion, imageMessages, input.sessionKey);
      return { ...completion, ...(messageId ? { transcriptMessageId: messageId } : {}) };
    }),
  };
  const suppressedUris = new Set(
    imageGeneration.completions.flatMap((completion) => completion.candidates.map((candidate) => candidate.key)),
  );
  const transcriptMediaTurns = extractOpenClawMediaTurns(messages, {
    executionCwd: input.executionCwd,
    suppressedUris,
  });
  const media = alignOpenClawMediaTurns(snapshot, transcriptMediaTurns, {
    ...(input.liveUserMessageId ? { liveUserMessageId: input.liveUserMessageId } : {}),
  });
  const transcriptMediaTurnCount = transcriptMediaTurns.filter((turn) => turn.candidates.length > 0).length;

  recordTrace(input, 'openclaw-media:history-request-succeeded', {
    source: 'openclaw-media',
    candidateCount: transcriptMediaTurns.reduce((count, turn) => count + turn.candidates.length, 0),
    matchedCount: media.length,
    rejectedCount: Math.max(0, transcriptMediaTurnCount - media.length),
  });
  if (transcriptMediaTurnCount > media.length) {
    recordTrace(input, 'openclaw-media:turn-rejected', {
      source: 'openclaw-media',
      reason: 'unmatched-user-anchor',
      rejectedCount: transcriptMediaTurnCount - media.length,
    });
  }
  for (const supplement of media) {
    recordTrace(input, 'openclaw-media:turn-matched', {
      source: 'openclaw-media',
      reason: input.liveUserMessageId ? 'live-user-identity' : 'reverse-user-occurrence',
      candidateCount: supplement.candidates.length,
    });
  }

  return { imageGeneration, media, transcriptMediaTurnCount, turnTimings };
}
