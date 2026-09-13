import type { BrowserWindow } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { HOST_EVENT_CHANNELS } from '@shared/host-events/contract';
import {
  UCLAW_DEFAULT_FALLBACK_MODEL,
  UCLAW_MANAGED_PROVIDER_ID,
  UCLAW_VIDEO_GENERATION_MAX_INPUT_IMAGE_BYTES,
} from '@shared/junfeiai-endpoints';
import {
  addChatMediaImageToBudget,
  ACP_INLINE_IMAGE_MAX_DATA_URI_CHARS,
  CHAT_MEDIA_MAX_ITEMS,
  CHAT_PROMPT_MAX_UTF8_BYTES,
  EMPTY_CHAT_MEDIA_IMAGE_BUDGET,
  chatMediaCountLimitError,
  chatPromptByteLimitError,
} from '@shared/chat/media-limits';
import type {
  AcpChatCancelPayload,
  AcpChatLoadPayload,
  AcpChatOperationResult,
  AcpChatPromptPayload,
  AcpChatRespondPermissionPayload,
  AcpPermissionRequestEnvelope,
  AcpSessionUpdateEnvelope,
  AcpTurnFailureUpdate,
  AcpTurnRetryCancelledUpdate,
  AcpTurnRetryReplacement,
  AcpTurnRetryUpdate,
} from '@shared/acp-chat/types';
import {
  normalizeAcpChatError,
  type AcpChatErrorCode,
} from '@shared/acp-chat/errors';
import {
  BoundedEventQueue,
  estimateValueBytes,
} from '@shared/acp-chat/bounded-event-queue';
import { getOpenClawEmbeddedForkSpec } from '../utils/openclaw-cli';
import {
  acpProcessRetryDelayMs,
  classifyAcpProcessFailure,
  type AcpProcessFailureKind,
} from '../utils/acp-process-failure';
import {
  approvePendingLocalDeviceRequests,
  type GatewayPairingRpcClient,
} from '../utils/control-ui-device-pairing';
import { logger } from '../utils/logger';
import { recordAcpTrace } from './acp-trace';
import { AcpSessionAccessRegistry, type AcpSessionAccessContext } from './acp-session-access-registry';
import {
  acpTurnImagePreferenceStore,
  type AcpTurnImagePreferenceStore,
} from './acp-turn-image-preference-store';
import {
  acpTurnVideoPreferenceStore,
  type AcpTurnVideoPreferenceStore,
} from './acp-turn-video-preference-store';
import { resolveOpenClawStateDir, resolveOpenClawWorkspacePath } from '../utils/paths';
import { prepareAcpChatImage, prepareVideoReferenceImage } from '../utils/video-reference-image';
import { artifactTaskService } from './artifact-task-service';

type AcpConnection = Pick<
  ClientSideConnection,
  | 'initialize'
  | 'newSession'
  | 'loadSession'
  | 'prompt'
  | 'cancel'
  | 'setSessionConfigOption'
  | 'unstable_setSessionModel'
>;
type MainWindowLike = {
  webContents: Pick<BrowserWindow['webContents'], 'send'>;
};
type PermissionWaiter = {
  sessionKey: string;
  generation: number;
  resolve: (response: RequestPermissionResponse) => void;
};
type AcpSessionLoadEntry = {
  acpSessionId: string;
  envelope: AcpSessionUpdateEnvelope;
};

type AcpSessionLoadBatch = {
  sessionKey: string;
  generation: number;
  sessionUpdates: BoundedEventQueue<AcpSessionLoadEntry>;
};
type AcpLivePromptContext = {
  sessionKey: string;
  acpSessionId: string;
  userMessageId: string;
  generation: number;
  accessGrant: AcpSessionAccessContext;
  clientStartedAtMs: number;
  mainReceivedAtMs: number;
  dispatchedAtMs: number | null;
  firstTextAtMs: number | null;
  attempt: number;
  /** A tool call is valid output for the current attempt, but remains replay-unsafe. */
  attemptToolCallObserved: boolean;
  /** Non-text ACP output (media/resource) or a permission request is valid progress. */
  attemptOutputObserved: boolean;
  retryStatusPending: boolean;
  retryReplacementPending: boolean;
  toolCallObserved: boolean;
  replayUnsafeObserved: boolean;
  userCancelRequested: boolean;
  retryAbortController: AbortController;
  pendingTerminalFailure: SessionNotification | null;
  /** Rejects the current prompt wait when ACP has already emitted a terminal failure. */
  terminalFailureReject: ((reason?: unknown) => void) | null;
};
type AcpChildProcess = ChildProcess & {
  stdin: NonNullable<ChildProcess['stdin']>;
  stdout: NonNullable<ChildProcess['stdout']>;
  stderr: NonNullable<ChildProcess['stderr']>;
};
type AcpChildDiagnostics = {
  resourceFailure: boolean;
  stderrTail: string;
  spawnedAtMs: number;
  initializeStartedAtMs?: number;
  firstProtocolResponseAtMs?: number;
  termination?: AcpChildTermination;
};
type AcpChildTermination = {
  event: 'error' | 'exit' | 'close' | 'timeout';
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: unknown;
};
type AcpChildTerminationWaiter = {
  promise: Promise<AcpChildTermination>;
  cancel: () => void;
};
type SpawnedAcpConnection = {
  connection: ClientSideConnection;
  child: AcpChildProcess;
};
type AcpPromptBuildResult = {
  blocks: ContentBlock[];
  videoReferenceImage?: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  };
};
type InlineImageMaterializationContext = {
  materializedBytes: number;
};

const ACP_GATEWAY_READY_WAIT_TIMEOUT_MS = 90_000;
const ACP_GATEWAY_READY_POLL_INTERVAL_MS = 250;
const ACP_CONNECTION_RETRY_BASE_DELAY_MS = 250;
const ACP_CONNECTION_RETRY_MAX_DELAY_MS = 2_000;
/** A hard protocol-handshake budget for slow packaged ACP startup. */
export const ACP_INITIALIZATION_TIMEOUT_MS = 45_000;
const ACP_PROMPT_RETRY_BASE_DELAY_MS = 500;
const ACP_PROMPT_RETRY_MAX_DELAY_MS = 4_000;
const ACP_PROMPT_TRANSIENT_MAX_ATTEMPTS = 5;
const ACP_PROMPT_CONTEXT_RECOVERY_MAX_ATTEMPTS = 2;
const ACP_RECOVERY_SUMMARY_MAX_CHARS = 12_000;
const ACP_PROMPT_FALLBACK_MODEL_REF = `${UCLAW_MANAGED_PROVIDER_ID}/${UCLAW_DEFAULT_FALLBACK_MODEL}`;
// OpenClaw replay is bounded to 1,000 messages. Leave room for more than one
// notification per message while keeping the byte budget as the hard limit.
const ACP_SESSION_LOAD_MAX_UPDATES = 4_096;
const ACP_SESSION_LOAD_MAX_BYTES = 8 * 1024 * 1024;
const ACP_MANAGED_INLINE_IMAGE_MAX_BYTES = 24 * 1024 * 1024;
const ACP_MANAGED_INLINE_IMAGE_MAX_PIXELS = 100 * 1024 * 1024;
type ManagedInlineImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
const ACP_MANAGED_INLINE_IMAGE_MIME_TYPES = new Map<ManagedInlineImageMimeType, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
] as const);
const ACP_RECOVERY_SUMMARY_HEADINGS = [
  '## Decisions',
  '## Open TODOs',
  '## Constraints/Rules',
  '## Pending user asks',
  '## Exact identifiers',
] as const;

function gatewayNeedsReadinessWait(status: ReturnType<NonNullable<GatewayPairingRpcClient['getStatus']>>): boolean {
  return status?.state === 'stopped'
    || status?.state === 'starting'
    || status?.state === 'reconnecting'
    || (status?.state === 'running' && status.gatewayReady === false);
}

function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve(true);
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

const GATEWAY_TRANSITION_ERROR = 'Gateway is starting or reconnecting. Please wait and try again.';

function childTerminationMessage(
  termination: AcpChildTermination,
  resourceFailure: boolean,
): string {
  const suffix = resourceFailure ? ' (resource exhaustion)' : '';
  switch (termination.event) {
    case 'error': {
      const detail = termination.error instanceof Error
        ? termination.error.message
        : String(termination.error ?? 'unknown spawn error');
      return `ACP process failed before initialization: ${detail}${suffix}`;
    }
    case 'timeout':
      return `ACP process did not initialize or exit within ${ACP_INITIALIZATION_TIMEOUT_MS}ms${suffix}`;
    case 'close':
      return `ACP process exited with code ${String(termination.code)} (close event)${suffix}`;
    case 'exit':
      return `ACP process exited with code ${String(termination.code)}${suffix}`;
  }
}

function ok(generation?: number, sessionUpdates?: AcpSessionUpdateEnvelope[]): AcpChatOperationResult {
  return {
    success: true,
    ...(generation != null ? { generation } : {}),
    ...(sessionUpdates?.length ? { sessionUpdates } : {}),
  };
}

function fail(error: unknown): AcpChatOperationResult {
  const failure = normalizeAcpChatError(error);
  return {
    success: false,
    error: failure.message,
    ...(failure.code !== 'UNKNOWN' ? {
      errorCode: failure.code,
      retryable: failure.retryable,
    } : {}),
    ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}),
    ...(failure.upstreamCode ? { upstreamCode: failure.upstreamCode } : {}),
  };
}

function cancelledPermissionResponse(): RequestPermissionResponse {
  return { outcome: { outcome: 'cancelled' } };
}

function isValidSessionKey(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('agent:') && value.length > 'agent:'.length;
}

function sessionUpdateType(notification: SessionNotification): string | undefined {
  const update = (notification as { update?: { sessionUpdate?: unknown } }).update;
  return typeof update?.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
}

function isProtectedSessionLoadEntry(entry: AcpSessionLoadEntry): boolean {
  if (entry.envelope.retryReplacement) return true;
  const update = entry.envelope.notification as unknown as { update?: Record<string, unknown> };
  const updateRecord = update.update;
  const updateType = typeof updateRecord?.sessionUpdate === 'string' ? updateRecord.sessionUpdate : '';
  if (updateType === 'uclaw_turn_failure' || updateType === 'plan') return true;
  if (updateType === 'tool_call' || updateType === 'tool_call_update') {
    const status = typeof updateRecord?.status === 'string' ? updateRecord.status : '';
    return status === 'completed' || status === 'failed' || status === 'cancelled'
      || typeof updateRecord?.error === 'string';
  }
  // Keep complete/state updates and shed only intermediate stream chunks when
  // a load exceeds its budget.
  return !updateType.endsWith('_chunk');
}

function createAcpSessionLoadQueue(): BoundedEventQueue<AcpSessionLoadEntry> {
  return new BoundedEventQueue<AcpSessionLoadEntry>({
    maxEntries: ACP_SESSION_LOAD_MAX_UPDATES,
    maxBytes: ACP_SESSION_LOAD_MAX_BYTES,
    estimateBytes: (entry, budget) => estimateValueBytes(entry, budget),
    isProtected: isProtectedSessionLoadEntry,
  });
}

function normalizedClientStartedAtMs(value: unknown, mainReceivedAtMs: number): number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && value <= mainReceivedAtMs
    ? value
    : mainReceivedAtMs;
}

function elapsedMs(startedAtMs: number, endedAtMs: number): number {
  return Math.max(0, Math.round(endedAtMs - startedAtMs));
}

function isVisibleAgentText(notification: SessionNotification): boolean {
  const update = (notification as {
    update?: {
      sessionUpdate?: unknown;
      content?: unknown;
    };
  }).update;
  if (update?.sessionUpdate !== 'agent_message_chunk' && update?.sessionUpdate !== 'agent_message') return false;
  const content = Array.isArray(update.content) ? update.content : [update.content];
  return content.some((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
    const record = block as { type?: unknown; text?: unknown };
    return record.type === 'text' && typeof record.text === 'string' && record.text.trim().length > 0;
  });
}

function hasReplayUnsafeAgentContent(notification: SessionNotification): boolean {
  const update = (notification as { update?: { sessionUpdate?: unknown; content?: unknown } }).update;
  if (update?.sessionUpdate !== 'agent_message_chunk' && update?.sessionUpdate !== 'agent_message') return false;
  const content = Array.isArray(update.content) ? update.content : [update.content];
  return content.some((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
    return (block as { type?: unknown }).type !== 'text';
  });
}

function artifactToolUpdate(notification: SessionNotification): {
  toolCallId?: string;
  title?: string;
  status?: string;
  rawOutput?: unknown;
} | null {
  const update = (notification as { update?: Record<string, unknown> }).update;
  if (!update || (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')) return null;
  return {
    ...(typeof update.toolCallId === 'string' ? { toolCallId: update.toolCallId } : {}),
    ...(typeof update.title === 'string' ? { title: update.title } : {}),
    ...(typeof update.status === 'string' ? { status: update.status } : {}),
    ...('rawOutput' in update ? { rawOutput: update.rawOutput } : {}),
  };
}

function isTerminalPromptFailure(notification: SessionNotification): boolean {
  return sessionUpdateType(notification) === 'uclaw_turn_failure';
}

function inlineImagePayload(block: Record<string, unknown>): {
  data: string;
  mimeType: string;
} | null {
  const declaredMimeType = typeof block.mimeType === 'string'
    ? block.mimeType.split(';', 1)[0]?.trim().toLowerCase()
    : undefined;
  if (typeof block.data === 'string') {
    return declaredMimeType ? { data: block.data, mimeType: declaredMimeType } : null;
  }
  if (typeof block.uri !== 'string') return null;
  const match = block.uri.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]+=*)$/i);
  if (!match?.[1] || !match[2]) return null;
  return { data: match[2], mimeType: declaredMimeType ?? match[1].toLowerCase() };
}

function isManagedInlineImageMimeType(value: string): value is ManagedInlineImageMimeType {
  return ACP_MANAGED_INLINE_IMAGE_MIME_TYPES.has(value as ManagedInlineImageMimeType);
}

function imageHeaderMatchesMime(buffer: Buffer, mimeType: ManagedInlineImageMimeType): boolean {
  switch (mimeType) {
    case 'image/png':
      return buffer.length >= 24
        && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'image/jpeg':
      return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'image/webp':
      return buffer.length >= 16 && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    case 'image/gif':
      return buffer.length >= 10 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a'
        || buffer.subarray(0, 6).toString('ascii') === 'GIF89a');
    default:
      return false;
  }
}

function imageDimensions(buffer: Buffer, mimeType: ManagedInlineImageMimeType): { width: number; height: number } | null {
  if (mimeType === 'image/png' && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === 'image/gif' && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mimeType === 'image/jpeg') {
    for (let offset = 2; offset + 9 < buffer.length;) {
      if (buffer[offset] !== 0xff) return null;
      while (buffer[offset] === 0xff) offset += 1;
      const marker = buffer[offset] ?? 0;
      offset += 1;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 2 > buffer.length) return null;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) return null;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  return null;
}

function isSafeInlineImageBuffer(buffer: Buffer, mimeType: ManagedInlineImageMimeType): boolean {
  if (buffer.length === 0
    || buffer.length > ACP_MANAGED_INLINE_IMAGE_MAX_BYTES || !imageHeaderMatchesMime(buffer, mimeType)) {
    return false;
  }
  const dimensions = imageDimensions(buffer, mimeType);
  return !dimensions || (dimensions.width > 0 && dimensions.height > 0
    && dimensions.width * dimensions.height <= ACP_MANAGED_INLINE_IMAGE_MAX_PIXELS);
}

function hasOversizedInlineImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasOversizedInlineImage);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'image') {
    if (typeof record.data === 'string') {
      const mimeType = typeof record.mimeType === 'string' ? record.mimeType : '';
      return `data:${mimeType};base64,`.length + record.data.length > ACP_INLINE_IMAGE_MAX_DATA_URI_CHARS;
    }
    return typeof record.uri === 'string'
      && /^data:image\//i.test(record.uri)
      && record.uri.length > ACP_INLINE_IMAGE_MAX_DATA_URI_CHARS;
  }
  return Object.values(record).some(hasOversizedInlineImage);
}

function isPromptRetryableUpstreamError(failure: ReturnType<typeof normalizeAcpChatError>): boolean {
  if (!failure.retryable) return false;
  const { code } = failure;
  return code === 'RATE_LIMIT'
    || code === 'SERVICE_UNAVAILABLE'
    || code === 'TIMEOUT'
    || code === 'NETWORK'
    || code === 'MODEL_UNAVAILABLE';
}

function errorRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

const ACP_PROMPT_SUCCESS_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
]);
const ACP_PROMPT_TOOL_STOP_REASONS = new Set([
  'tooluse',
  'tool_use',
  'tool_calls',
  'tool_call',
]);

function promptResultMessage(value: unknown): string | null {
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  let inspected = 0;

  while (queue.length > 0 && inspected < 24) {
    const candidate = queue.shift();
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
      continue;
    }
    const record = errorRecord(candidate);
    if (!record || seen.has(record)) continue;
    seen.add(record);
    inspected += 1;

    for (const key of ['errorMessage', 'message', 'error', 'detail', 'reason', 'failure']) {
      const nested = record[key];
      if (typeof nested === 'string' && nested.trim()) return nested.trim();
      if (nested && typeof nested === 'object') queue.push(nested);
    }
    for (const key of ['data', 'details', 'response', 'result']) {
      if (record[key] != null) queue.push(record[key]);
    }
  }
  return null;
}

function promptResultHasExplicitFailure(value: unknown): boolean {
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  let inspected = 0;

  while (queue.length > 0 && inspected < 24) {
    const candidate = queue.shift();
    const record = errorRecord(candidate);
    if (!record || seen.has(record)) continue;
    seen.add(record);
    inspected += 1;

    if (record.success === false || record.ok === false) return true;
    for (const key of ['status', 'statusCode', 'httpStatus']) {
      const status = Number(record[key]);
      if (Number.isInteger(status) && status >= 400 && status <= 599) return true;
    }
    for (const key of ['status', 'state']) {
      const status = typeof record[key] === 'string' ? record[key].trim().toLowerCase() : '';
      if (status === 'failed' || status === 'error') return true;
    }
    for (const key of ['error', 'errorMessage', 'failure', 'failureMessage']) {
      const nested = record[key];
      if (typeof nested === 'string' && nested.trim()) return true;
      if (nested && typeof nested === 'object') return true;
    }
    for (const key of ['data', 'details', 'response', 'result']) {
      if (record[key] != null) queue.push(record[key]);
    }
  }
  return false;
}

function promptResultHasToolCall(value: unknown): boolean {
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  let inspected = 0;

  while (queue.length > 0 && inspected < 24) {
    const candidate = queue.shift();
    const record = errorRecord(candidate);
    if (!record || seen.has(record)) continue;
    seen.add(record);
    inspected += 1;

    for (const key of ['toolCall', 'tool_call']) {
      if (record[key] != null) return true;
    }
    for (const key of ['toolCalls', 'tool_calls']) {
      const calls = record[key];
      if (Array.isArray(calls) ? calls.length > 0 : calls != null) return true;
    }
    const content = record.content;
    if (Array.isArray(content) && content.some((block) => {
      const blockRecord = errorRecord(block);
      const type = typeof blockRecord?.type === 'string' ? blockRecord.type.toLowerCase() : '';
      return type === 'toolcall' || type === 'tool_call' || type === 'tool_use';
    })) {
      return true;
    }
    for (const key of ['content', 'data', 'details', 'response', 'result']) {
      if (record[key] != null) queue.push(record[key]);
    }
  }
  return false;
}

function promptResultHasOutput(value: unknown): boolean {
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  let inspected = 0;

  while (queue.length > 0 && inspected < 24) {
    const candidate = queue.shift();
    const record = errorRecord(candidate);
    if (!record || seen.has(record)) continue;
    seen.add(record);
    inspected += 1;

    const content = record.content;
    if (Array.isArray(content) && content.some((block) => {
      const blockRecord = errorRecord(block);
      if (!blockRecord) return false;
      if (blockRecord.type === 'text') {
        return typeof blockRecord.text === 'string' && blockRecord.text.trim().length > 0;
      }
      return typeof blockRecord.type === 'string' && blockRecord.type.trim().length > 0;
    })) {
      return true;
    }
    for (const key of ['content', 'data', 'details', 'response', 'result']) {
      if (record[key] != null) queue.push(record[key]);
    }
  }
  return false;
}

function promptCompletionError(value: unknown, fallback: string): Error {
  const detail = promptResultMessage(value);
  return new Error(detail ? `${fallback}: ${detail}` : fallback, { cause: value });
}

function hasAgentReplyContent(notification: SessionNotification): boolean {
  const update = (notification as {
    update?: {
      sessionUpdate?: unknown;
      content?: unknown;
    };
  }).update;
  if (update?.sessionUpdate !== 'agent_message_chunk' && update?.sessionUpdate !== 'agent_message') return false;
  const content = Array.isArray(update.content) ? update.content : [update.content];
  return content.some((block) => {
    const record = errorRecord(block);
    if (!record) return false;
    if (record.type === 'text') return typeof record.text === 'string' && record.text.trim().length > 0;
    return typeof record.type === 'string' && record.type.trim().length > 0;
  });
}

function inspectPromptCompletionResult(
  result: unknown,
  promptContext: AcpLivePromptContext,
): Error | null {
  const record = errorRecord(result);
  if (!record) {
    return promptCompletionError(result, 'ACP prompt returned no valid completion.');
  }

  if (promptResultHasExplicitFailure(result)) {
    return promptCompletionError(result, 'ACP prompt returned a failed completion.');
  }

  const stopReason = typeof record.stopReason === 'string'
    ? record.stopReason.trim().toLowerCase()
    : '';
  if (stopReason === 'cancelled' || stopReason === 'aborted') {
    return promptContext.userCancelRequested
      ? null
      : promptCompletionError(result, `ACP prompt was ${stopReason} before completion.`);
  }
  if (stopReason === 'error') {
    return promptCompletionError(result, 'ACP prompt returned an error completion.');
  }
  if (!stopReason) {
    return promptCompletionError(result, 'ACP prompt returned no valid completion.');
  }

  // A refusal is already a user-facing model decision. Do not turn it into a
  // provider failover just because the ACP adapter carried no text payload.
  if (stopReason === 'refusal') return null;
  if (ACP_PROMPT_TOOL_STOP_REASONS.has(stopReason)) {
    return promptContext.attemptToolCallObserved || promptResultHasToolCall(result)
      ? null
      : promptCompletionError(result, `ACP prompt returned an unexpected stop reason: ${stopReason}.`);
  }
  if (!ACP_PROMPT_SUCCESS_STOP_REASONS.has(stopReason)) {
    return promptCompletionError(result, `ACP prompt returned an unexpected stop reason: ${stopReason}.`);
  }
  if (promptContext.attemptOutputObserved || promptResultHasOutput(result)) return null;

  return promptCompletionError(result, 'ACP prompt completed without a visible assistant response.');
}

function findStructuredRecoverySummary(value: unknown): string | null {
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  let inspected = 0;

  while (queue.length > 0 && inspected < 24) {
    const candidate = queue.shift();
    const record = errorRecord(candidate);
    if (!record || seen.has(record)) continue;
    seen.add(record);
    inspected += 1;

    for (const key of ['recoverySummary', 'fallbackSummary', 'compactionSummary', 'summary']) {
      const summary = record[key];
      if (typeof summary !== 'string') continue;
      const trimmed = summary.trim();
      if (trimmed && ACP_RECOVERY_SUMMARY_HEADINGS.every((heading) => trimmed.includes(heading))) {
        return trimmed.slice(0, ACP_RECOVERY_SUMMARY_MAX_CHARS);
      }
    }
    for (const key of ['cause', 'data', 'details', 'response', 'error']) {
      if (record[key] != null) queue.push(record[key]);
    }
  }
  return null;
}

function buildMinimalStructuredRecoverySummary(): string {
  return [
    '## Decisions',
    'Preserve the current session and continue from its recorded state.',
    '',
    '## Open TODOs',
    'Complete the latest unresolved user request.',
    '',
    '## Constraints/Rules',
    'Do not repeat completed tool actions or invent missing results.',
    '',
    '## Pending user asks',
    'Use the latest user request already recorded in this session.',
    '',
    '## Exact identifiers',
    'Recover exact identifiers from the recorded request and session state.',
  ].join('\n');
}

function buildContextRecoveryPrompt(error: unknown): ContentBlock[] {
  const summary = findStructuredRecoverySummary(error) ?? buildMinimalStructuredRecoverySummary();
  return [{
    type: 'text',
    text: [
      '[UClaw automatic context recovery]',
      'Continue the latest unresolved user request already recorded in this session.',
      'Use the structured recovery summary below and do not repeat completed tool actions.',
      '',
      summary,
    ].join('\n'),
  }];
}

function buildTransientRetryPrompt(replacingPartialText: boolean): ContentBlock[] {
  return [{
    type: 'text',
    text: (replacingPartialText ? [
      '[UClaw automatic upstream retry]',
      'The previous attempt was interrupted after visible assistant text.',
      'Restart the complete answer from the beginning without mentioning this retry.',
      'Return text only and do not call tools or repeat any side effect.',
      'Use the latest unresolved user request already recorded in this session.',
    ] : [
      '[UClaw automatic upstream retry]',
      'Continue the latest unresolved user request already recorded in this session.',
      'The previous attempt stopped before any tool call or visible assistant reply.',
    ]).join('\n'),
  }];
}

function buildSideEffectSafeContinuationPrompt(failure: ReturnType<typeof normalizeAcpChatError>): ContentBlock[] {
  const errorLabel = failure.httpStatus != null
    ? `${failure.code} (HTTP ${failure.httpStatus})`
    : failure.code;
  return [{
    type: 'text',
    text: [
      '[UClaw automatic upstream recovery]',
      `The previous attempt hit a retryable upstream/model availability error: ${errorLabel}.`,
      'Continue the latest unresolved user request from the recorded session state.',
      'Do not repeat completed tool actions, completed media generation jobs, file writes, or permission requests.',
      'Reuse existing tool results, generated media, task IDs, and files already visible in the session when they are relevant.',
      'If a required side effect is uncertain, inspect the recorded state first and then continue; do not restart the whole task.',
    ].join('\n'),
  }];
}

function promptRecoveryError(message: string, cause: unknown): Error {
  return new Error(message, { cause });
}

function promptRetryDelay(attempt: number): number {
  return Math.min(
    ACP_PROMPT_RETRY_MAX_DELAY_MS,
    ACP_PROMPT_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 2)),
  );
}

function terminalFailureNotification(
  sessionId: string,
  userMessageId: string,
  failure: ReturnType<typeof normalizeAcpChatError>,
): SessionNotification {
  const update: AcpTurnFailureUpdate = {
    sessionUpdate: 'uclaw_turn_failure',
    userMessageId,
    errorMessage: failure.message,
    errorCode: failure.code,
    retryable: failure.retryable,
    ...(failure.httpStatus != null ? { httpStatus: failure.httpStatus } : {}),
    ...(failure.upstreamCode ? { upstreamCode: failure.upstreamCode } : {}),
  };
  return { sessionId, update } as unknown as SessionNotification;
}

function retryingNotification(
  sessionId: string,
  userMessageId: string,
  attempt: number,
  maxAttempts: number,
  delayMs: number,
  errorCode: AcpChatErrorCode,
): SessionNotification {
  const update: AcpTurnRetryUpdate = {
    sessionUpdate: 'uclaw_turn_retrying',
    userMessageId,
    attempt,
    maxAttempts,
    delayMs,
    errorCode,
  };
  return { sessionId, update } as unknown as SessionNotification;
}

function retryCancelledNotification(sessionId: string, userMessageId: string): SessionNotification {
  const update: AcpTurnRetryCancelledUpdate = {
    sessionUpdate: 'uclaw_turn_retry_cancelled',
    userMessageId,
  };
  return { sessionId, update } as unknown as SessionNotification;
}

function terminalFailureError(notification: SessionNotification): Record<string, unknown> {
  const update = (notification as {
    update?: {
      errorMessage?: unknown;
      errorCode?: unknown;
      httpStatus?: unknown;
      upstreamCode?: unknown;
    };
  }).update;
  return {
    message: typeof update?.errorMessage === 'string' ? update.errorMessage : 'ACP turn failed',
    ...(typeof update?.errorCode === 'string' ? { code: update.errorCode } : {}),
    ...(typeof update?.httpStatus === 'number' ? { status: update.httpStatus } : {}),
    ...(typeof update?.upstreamCode === 'string' ? { upstreamCode: update.upstreamCode } : {}),
  };
}

function promptCompletionDurations(context: AcpLivePromptContext, completedAtMs: number): Record<string, unknown> {
  return {
    clientToMainMs: elapsedMs(context.clientStartedAtMs, context.mainReceivedAtMs),
    ...(context.dispatchedAtMs != null ? {
      mainToDispatchMs: elapsedMs(context.mainReceivedAtMs, context.dispatchedAtMs),
      dispatchToCompleteMs: elapsedMs(context.dispatchedAtMs, completedAtMs),
      clientToCompleteMs: elapsedMs(context.clientStartedAtMs, completedAtMs),
    } : {}),
  };
}

// OpenClaw can emit clack/doctor diagnostics to stdout during ACP startup.
// Keep those lines away from the SDK's strict NDJSON parser.
// Upstream fixed this in https://github.com/openclaw/openclaw/pull/89997 .
function filterAcpStdoutDiagnostics(
  output: ReadableStream<Uint8Array>,
  onProtocolResponse?: () => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = output.getReader();
      let buffered = '';

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;

          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;
            if (trimmedLine.startsWith('{')) {
              onProtocolResponse?.();
              controller.enqueue(encoder.encode(`${line}\n`));
            } else {
              logger.info(`[acp-chat] [stdout] ${line}`);
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

export class AcpChatService {
  private child: AcpChildProcess | null = null;
  private readonly childDiagnostics = new WeakMap<AcpChildProcess, AcpChildDiagnostics>();
  /** One bounded terminal-event watcher per child, even across init retries. */
  private readonly childTerminationWaiters = new WeakMap<
    AcpChildProcess,
    AcpChildTerminationWaiter
  >();
  private connection: AcpConnection | null;
  private initializing: Promise<AcpConnection> | null = null;
  /** Invalidates an initialization only when the Gateway runtime changes. */
  private initializationEpoch = 0;
  private initialized = false;
  /** A Gateway gets at most one ACP-timeout recovery attempt per runtime identity. */
  private recoveredStalledGatewayIdentity: string | null = null;
  private connectionRuntimeIdentity: string | null = null;
  private generation = 0;
  private generationSeq = 0;
  private activeSessionKey: string | null = null;
  private activeAcpSessionId: string | null = null;
  private loadedSessionKey: string | null = null;
  private loadedAcpSessionId: string | null = null;
  private historicalSessionKey: string | null = null;
  private historicalGeneration: number | null = null;
  private permissionsEnabled = false;
  private loadQueue: Promise<void> | null = null;
  private activeLoadBatch: AcpSessionLoadBatch | null = null;
  private readonly livePrompts = new Map<string, AcpLivePromptContext>();
  private permissionSeq = 0;
  private readonly permissionWaiters = new Map<string, PermissionWaiter>();
  readonly client: Client;

  constructor(
    private readonly mainWindow: MainWindowLike,
    private readonly accessRegistry: AcpSessionAccessRegistry,
    injectedConnection?: AcpConnection,
    private readonly gateway?: GatewayPairingRpcClient,
    private readonly turnImagePreferenceStore: AcpTurnImagePreferenceStore = acpTurnImagePreferenceStore,
    private readonly turnVideoPreferenceStore: AcpTurnVideoPreferenceStore = acpTurnVideoPreferenceStore,
  ) {
    this.connection = injectedConnection ?? null;
    this.client = {
      sessionUpdate: async (notification) => this.emitSessionUpdate(notification),
      requestPermission: async (request) => this.requestPermission(request),
    };
  }

  private trace(
    event: string,
    input: { direction?: string; sessionKey?: string | null; generation?: number; details?: unknown } = {},
  ): void {
    try {
      const sessionKey = input.sessionKey === null
        ? undefined
        : input.sessionKey ?? this.activeSessionKey ?? undefined;
      const generation = input.generation ?? (this.generation > 0 ? this.generation : undefined);
      recordAcpTrace({
        source: 'main',
        event,
        ...(input.direction ? { direction: input.direction } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        ...(generation != null ? { generation } : {}),
        ...(input.details !== undefined ? { details: input.details } : {}),
      });
    } catch (error) {
      logger.warn(`[acp-chat] trace failed: ${String(error)}`);
    }
  }

  private async trySwitchPromptToFallbackModel(
    connection: AcpConnection,
    acpSessionId: string,
    promptContext: AcpLivePromptContext,
    failure: ReturnType<typeof normalizeAcpChatError>,
  ): Promise<void> {
    if (typeof connection.unstable_setSessionModel !== 'function') {
      this.trace('session/prompt:fallback-model-unavailable', {
        sessionKey: promptContext.sessionKey,
        generation: promptContext.generation,
        details: {
          requestId: promptContext.userMessageId,
          attempt: promptContext.attempt,
          reason: failure.code,
          modelId: ACP_PROMPT_FALLBACK_MODEL_REF,
          cause: 'unsupported-acp-method',
        },
      });
      return;
    }
    try {
      await connection.unstable_setSessionModel({
        sessionId: acpSessionId,
        modelId: ACP_PROMPT_FALLBACK_MODEL_REF,
      });
      this.trace('session/prompt:fallback-model-set', {
        sessionKey: promptContext.sessionKey,
        generation: promptContext.generation,
        details: {
          requestId: promptContext.userMessageId,
          attempt: promptContext.attempt,
          reason: failure.code,
          modelId: ACP_PROMPT_FALLBACK_MODEL_REF,
        },
      });
    } catch (error) {
      logger.warn(`[acp-chat] Could not switch to fallback model ${ACP_PROMPT_FALLBACK_MODEL_REF}: ${String(error)}`);
      this.trace('session/prompt:fallback-model-failed', {
        sessionKey: promptContext.sessionKey,
        generation: promptContext.generation,
        details: {
          requestId: promptContext.userMessageId,
          attempt: promptContext.attempt,
          reason: failure.code,
          modelId: ACP_PROMPT_FALLBACK_MODEL_REF,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async warmupConnection(): Promise<void> {
    this.trace('connection/warmup:start', { sessionKey: null });
    try {
      const runtimeIdentity = await this.requireReadyGatewayRuntime();
      await this.ensureConnection(runtimeIdentity);
      this.requireSameGatewayRuntime(runtimeIdentity);
      this.trace('connection/warmup:success', { sessionKey: null });
    } catch (error) {
      logger.warn(`[acp-chat] ACP connection warmup failed; normal session loading will retry: ${String(error)}`);
      this.trace('connection/warmup:failed', {
        sessionKey: null,
        details: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  /** Stop the direct ACP child before its owning Gateway is stopped on app quit. */
  async shutdown(): Promise<void> {
    this.initializationEpoch += 1;
    this.resolveAllPermissionWaiters(cancelledPermissionResponse());
    this.activeLoadBatch = null;
    const child = this.child;
    this.trace('connection/process:shutdown', {
      details: { pid: child?.pid ?? null, hadChild: Boolean(child) },
    });
    if (!child) {
      this.connection = null;
      this.initialized = false;
      return;
    }
    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_500);
      timer.unref?.();
      const settled = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once('exit', settled);
      child.once('close', settled);
    });
    try {
      child.kill();
    } catch (error) {
      logger.warn(`[acp-chat] ACP shutdown signal failed: ${String(error)}`);
    }
    await exited;
    this.dropConnectionForChild(child);
  }

  loadSession(payload: AcpChatLoadPayload): Promise<AcpChatOperationResult> {
    const previousLoad = this.loadQueue;
    let releaseLoad!: () => void;
    const currentLoad = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    this.loadQueue = currentLoad;

    const run = async () => {
      if (previousLoad) await previousLoad;
      try {
        return await this.performLoadSession(payload);
      } finally {
        releaseLoad();
        if (this.loadQueue === currentLoad) this.loadQueue = null;
      }
    };
    return run();
  }

  private async performLoadSession(payload: AcpChatLoadPayload): Promise<AcpChatOperationResult> {
    if (!isValidSessionKey(payload.sessionKey) || !payload.workspaceRoot || !payload.cwd) {
      return fail('Invalid ACP session load payload');
    }
    const previousPermissionsEnabled = this.permissionsEnabled;
    this.permissionsEnabled = false;
    this.trace('session/load:start', {
      sessionKey: payload.sessionKey,
      details: { createIfMissing: !!payload.createIfMissing, cwdPresent: Boolean(payload.cwd) },
    });

    let previousSessionKey = this.activeSessionKey;
    let previousAcpSessionId = this.activeAcpSessionId;
    let previousLoadedSessionKey = this.loadedSessionKey;
    let previousLoadedAcpSessionId = this.loadedAcpSessionId;
    let previousHistoricalSessionKey = this.historicalSessionKey;
    let previousHistoricalGeneration = this.historicalGeneration;
    let previousGeneration = this.generation;
    let nextGeneration = this.generationSeq + 1;
    let stateAdvanced = false;
    let loadBatch: AcpSessionLoadBatch | null = null;
    let previousAccessGrant: AcpSessionAccessContext | null = null;

    try {
      const runtimeIdentity = await this.requireReadyGatewayRuntime();
      const connection = await this.ensureConnection(runtimeIdentity);
      this.requireSameGatewayRuntime(runtimeIdentity);
      const livePrompt = this.livePrompts.get(payload.sessionKey);
      if (livePrompt) {
        const preparedAccessGrant = await this.accessRegistry.prepareGrant({
          sessionKey: payload.sessionKey,
          generation: livePrompt.generation,
          workspaceRoot: payload.workspaceRoot,
          executionCwd: payload.cwd,
        });
        if (
          preparedAccessGrant.workspaceRoot !== livePrompt.accessGrant.workspaceRoot
          || preparedAccessGrant.executionCwd !== livePrompt.accessGrant.executionCwd
        ) {
          throw new Error('Cannot change workspace while an ACP prompt is active');
        }
        this.generation = livePrompt.generation;
        this.activeSessionKey = livePrompt.sessionKey;
        this.activeAcpSessionId = livePrompt.acpSessionId;
        this.loadedSessionKey = livePrompt.sessionKey;
        this.loadedAcpSessionId = livePrompt.acpSessionId;
        this.historicalSessionKey = null;
        this.historicalGeneration = null;
        this.permissionsEnabled = true;
        this.accessRegistry.commitGrant(livePrompt.accessGrant);
        this.trace('session/load:resumed-active-prompt', {
          sessionKey: livePrompt.sessionKey,
          generation: livePrompt.generation,
          details: { acpSessionId: livePrompt.acpSessionId },
        });
        return {
          success: true,
          generation: livePrompt.generation,
          resumedActivePrompt: true,
        };
      }
      previousSessionKey = this.activeSessionKey;
      previousAcpSessionId = this.activeAcpSessionId;
      previousLoadedSessionKey = this.loadedSessionKey;
      previousLoadedAcpSessionId = this.loadedAcpSessionId;
      previousHistoricalSessionKey = this.historicalSessionKey;
      previousHistoricalGeneration = this.historicalGeneration;
      previousGeneration = this.generation;
      nextGeneration = this.generationSeq + 1;
      previousAccessGrant = this.accessRegistry.snapshot();
      const preparedAccessGrant = await this.accessRegistry.prepareGrant({
        sessionKey: payload.sessionKey,
        generation: nextGeneration,
        workspaceRoot: payload.workspaceRoot,
        executionCwd: payload.cwd,
      });
      this.requireSameGatewayRuntime(runtimeIdentity);

      this.generation = nextGeneration;
      this.activeSessionKey = payload.sessionKey;
      this.activeAcpSessionId = payload.createIfMissing ? null : payload.sessionKey;
      this.loadedSessionKey = null;
      this.loadedAcpSessionId = null;
      this.historicalSessionKey = payload.createIfMissing ? null : payload.sessionKey;
      this.historicalGeneration = payload.createIfMissing ? null : nextGeneration;
      loadBatch = {
        sessionKey: payload.sessionKey,
        generation: nextGeneration,
        sessionUpdates: createAcpSessionLoadQueue(),
      };
      this.activeLoadBatch = loadBatch;
      stateAdvanced = true;
      if (previousSessionKey && !this.livePrompts.has(previousSessionKey)) {
        this.resolvePermissionWaitersForSession(previousSessionKey, cancelledPermissionResponse());
      }

      let acpSessionId = payload.sessionKey;
      if (payload.createIfMissing) {
        const created = await connection.newSession({
          cwd: preparedAccessGrant.executionCwd,
          mcpServers: [],
          _meta: { sessionKey: payload.sessionKey, prefixCwd: true },
        });
        acpSessionId = created.sessionId;
      } else {
        await connection.loadSession({
          sessionId: payload.sessionKey,
          cwd: preparedAccessGrant.executionCwd,
          mcpServers: [],
        });
      }
      this.requireSameGatewayRuntime(runtimeIdentity);
      this.activeAcpSessionId = acpSessionId;
      this.loadedSessionKey = payload.sessionKey;
      this.loadedAcpSessionId = acpSessionId;
      this.generationSeq = nextGeneration;
      this.accessRegistry.commitGrant(preparedAccessGrant);
      this.trace('session/load:success', {
        sessionKey: payload.sessionKey,
        generation: nextGeneration,
        details: { createIfMissing: !!payload.createIfMissing, acpSessionId },
      });
      if (this.activeLoadBatch === loadBatch) this.activeLoadBatch = null;
      return ok(
        nextGeneration,
        loadBatch.sessionUpdates
          .toArray()
          .filter((entry) => entry.acpSessionId === acpSessionId)
          .map((entry) => entry.envelope),
      );
    } catch (error) {
      if (this.activeLoadBatch === loadBatch) this.activeLoadBatch = null;
      this.resolvePermissionWaitersForSession(payload.sessionKey, cancelledPermissionResponse());
      if (
        stateAdvanced
        && this.activeSessionKey === payload.sessionKey
        && this.generation === nextGeneration
      ) {
        this.generation = previousGeneration;
        this.activeSessionKey = previousSessionKey;
        this.activeAcpSessionId = previousAcpSessionId;
        this.loadedSessionKey = previousLoadedSessionKey;
        this.loadedAcpSessionId = previousLoadedAcpSessionId;
        this.historicalSessionKey = previousHistoricalSessionKey;
        this.historicalGeneration = previousHistoricalGeneration;
        this.permissionsEnabled = previousPermissionsEnabled;
        this.accessRegistry.restore(previousAccessGrant);
      }
      logger.error(`[acp-chat] loadSession failed: ${String(error)}`);
      this.trace('session/load:failed', {
        sessionKey: payload.sessionKey,
        generation: previousGeneration,
        details: { error: error instanceof Error ? error.message : String(error) },
      });
      return fail(error);
    }
  }

  async sendPrompt(payload: AcpChatPromptPayload): Promise<AcpChatOperationResult> {
    const mainReceivedAtMs = Date.now();
    const phaseDurations: Record<string, number> = {};
    let connectionPromptWaitMs = 0;
    if (!isValidSessionKey(payload.sessionKey) || !payload.cwd) return fail('Invalid ACP prompt payload');
    if (!this.activeSessionKey) return fail('No active ACP session');
    if (payload.sessionKey !== this.activeSessionKey) return fail('ACP prompt session is not active');
    if (this.loadedSessionKey !== payload.sessionKey || !this.loadedAcpSessionId) return fail('ACP session is not loaded');
    if (this.livePrompts.has(payload.sessionKey)) return fail('ACP prompt is already active');
    const generation = this.generation;
    const acpSessionId = this.loadedAcpSessionId;
    const userMessageId = payload.messageId ?? randomUUID();
    const accessGrant = this.accessRegistry.get(payload.sessionKey, generation);
    if (!accessGrant) return fail('ACP session access grant is not active');
    const clientStartedAtMs = normalizedClientStartedAtMs(payload.clientStartedAtMs, mainReceivedAtMs);
    const promptContext: AcpLivePromptContext = {
      sessionKey: payload.sessionKey,
      acpSessionId,
      userMessageId,
      generation,
      accessGrant,
      clientStartedAtMs,
      mainReceivedAtMs,
      dispatchedAtMs: null,
      firstTextAtMs: null,
      attempt: 1,
      attemptToolCallObserved: false,
      attemptOutputObserved: false,
      retryStatusPending: false,
      retryReplacementPending: false,
      toolCallObserved: false,
      replayUnsafeObserved: false,
      userCancelRequested: false,
      retryAbortController: new AbortController(),
      pendingTerminalFailure: null,
      terminalFailureReject: null,
    };
    this.livePrompts.set(payload.sessionKey, promptContext);
    let imagePreferenceId: string | undefined;
    let videoPreferenceId: string | undefined;
    try {
      let phaseStartedAtMs = Date.now();
      const runtimeIdentity = await this.requireReadyGatewayRuntime();
      phaseDurations.readyGatewayMs = Date.now() - phaseStartedAtMs;
      const promptCwd = payload.cwd === accessGrant.executionCwd
        ? payload.cwd
        : await import('node:fs/promises')
          .then((fsP) => fsP.realpath(resolveOpenClawWorkspacePath(payload.cwd)))
          .catch(() => null);
      if (promptCwd !== accessGrant.executionCwd) {
        return fail('ACP prompt cwd does not match the registered execution cwd');
      }
      this.trace('session/prompt:start', {
        sessionKey: payload.sessionKey,
        generation,
        details: {
          messageLength: payload.message?.length ?? 0,
          mediaCount: payload.media?.length ?? 0,
          clientToMainMs: elapsedMs(clientStartedAtMs, mainReceivedAtMs),
        },
      });
      phaseStartedAtMs = Date.now();
      const connection = await this.ensureConnection(runtimeIdentity);
      phaseDurations.ensureConnectionMs = Date.now() - phaseStartedAtMs;
      this.requireSameGatewayRuntime(runtimeIdentity);
      phaseStartedAtMs = Date.now();
      const promptBuild = await this.buildPromptBlocks(payload);
      phaseDurations.promptBuildMs = Date.now() - phaseStartedAtMs;
      const prompt = promptBuild.blocks;
      const artifactPolicy = artifactTaskService.getPolicy(payload.sessionKey);
      if (artifactPolicy) {
        phaseStartedAtMs = Date.now();
        const controls = [
          connection.setSessionConfigOption({
            sessionId: acpSessionId,
            configId: 'thought_level',
            value: artifactPolicy.thinkingLevel,
          }),
          connection.setSessionConfigOption({
            sessionId: acpSessionId,
            configId: 'fast_mode',
            value: artifactPolicy.fastMode ? 'on' : 'off',
          }),
          connection.unstable_setSessionModel({
            sessionId: acpSessionId,
            modelId: artifactPolicy.modelAlias,
          }),
        ];
        const results = await Promise.allSettled(controls);
        const rejected = results.filter((result) => result.status === 'rejected');
        phaseDurations.sessionControlsMs = Date.now() - phaseStartedAtMs;
        if (rejected.length > 0) {
          logger.warn(`[artifact-task] ${rejected.length} ACP session control(s) were rejected; runtime plugin policy remains active`);
        }
      }
      const message = payload.message?.trim();
      phaseStartedAtMs = Date.now();
      if (payload.imageOptions && message) {
        const preference = await this.turnImagePreferenceStore.enqueue({
          sessionKey: payload.sessionKey,
          message,
          imageOptions: payload.imageOptions,
        }).catch((error) => {
          // Composer preferences must never prevent a normal ACP prompt from running.
          logger.warn(`[acp-chat] Could not queue image generation preferences: ${String(error)}`);
          return null;
        });
        imagePreferenceId = preference?.id;
      }
      if (payload.videoOptions && message) {
        const preference = await this.turnVideoPreferenceStore.enqueue({
          sessionKey: payload.sessionKey,
          message,
          videoOptions: payload.videoOptions,
          ...(promptBuild.videoReferenceImage
            ? { referenceImage: promptBuild.videoReferenceImage }
            : {}),
        }).catch((error) => {
          // Composer preferences must never prevent a normal ACP prompt from running.
          logger.warn(`[acp-chat] Could not queue video generation preferences: ${String(error)}`);
          return null;
        });
        videoPreferenceId = preference?.id;
      }
      phaseDurations.preferenceEnqueueMs = Date.now() - phaseStartedAtMs;
      if (this.historicalSessionKey === payload.sessionKey) {
        this.historicalSessionKey = null;
        this.historicalGeneration = null;
      }
      this.permissionsEnabled = true;
      this.requireSameGatewayRuntime(runtimeIdentity);
      artifactTaskService.markDispatched(payload.sessionKey);
      promptContext.dispatchedAtMs = Date.now();
      this.trace('session/prompt:dispatched', {
        sessionKey: payload.sessionKey,
        generation,
        details: {
          requestId: userMessageId,
          clientToMainMs: elapsedMs(clientStartedAtMs, mainReceivedAtMs),
          mainToDispatchMs: elapsedMs(mainReceivedAtMs, promptContext.dispatchedAtMs),
          clientToDispatchMs: elapsedMs(clientStartedAtMs, promptContext.dispatchedAtMs),
          preDispatchPhases: phaseDurations,
        },
      });
      const originalMessageId = userMessageId;
      let attempt = 1;
      let attemptPrompt = prompt;
      let attemptMessageId = originalMessageId;
      let contextRecoveryAttempted = false;
      while (true) {
        promptContext.attempt = attempt;
        promptContext.attemptToolCallObserved = false;
        promptContext.attemptOutputObserved = false;
        promptContext.pendingTerminalFailure = null;
        let rejectTerminalFailure: ((reason?: unknown) => void) | null = null;
        const terminalFailureWait = new Promise<never>((_, reject) => {
          rejectTerminalFailure = reject;
        });
        promptContext.terminalFailureReject = rejectTerminalFailure;
        const promptWaiter = promptContext.terminalFailureReject;
        const promptAttemptStartedAtMs = Date.now();
        try {
          const promptResult = await Promise.race([
            connection.prompt({
              sessionId: acpSessionId,
              prompt: attemptPrompt,
              messageId: attemptMessageId,
              _meta: { sessionKey: payload.sessionKey, prefixCwd: true },
            }),
            terminalFailureWait,
          ]);
          const promptCompletionFailure = inspectPromptCompletionResult(promptResult, promptContext);
          if (promptCompletionFailure) throw promptCompletionFailure;
          connectionPromptWaitMs += Date.now() - promptAttemptStartedAtMs;
          if (attempt > 1) {
            this.trace('session/prompt:recovered', {
              sessionKey: payload.sessionKey,
              generation,
              details: { requestId: userMessageId, attempt, contextRecoveryAttempted },
            });
          }
          promptContext.pendingTerminalFailure = null;
          break;
        } catch (attemptError) {
          connectionPromptWaitMs += Date.now() - promptAttemptStartedAtMs;
          this.requireSameGatewayRuntime(runtimeIdentity);
          const failure = normalizeAcpChatError(attemptError);
          if (promptContext.userCancelRequested || failure.code === 'CANCELLED') break;
          const replaySafe = !promptContext.toolCallObserved && !promptContext.replayUnsafeObserved;
          const isContextRecovery = failure.code === 'CONTEXT_OVERFLOW';
          const isTransientUpstream = isPromptRetryableUpstreamError(failure);
          const maxAttempts = isContextRecovery
            ? ACP_PROMPT_CONTEXT_RECOVERY_MAX_ATTEMPTS
            : ACP_PROMPT_TRANSIENT_MAX_ATTEMPTS;

          const contextRecoverySafe = replaySafe && promptContext.firstTextAtMs == null;
          if (!contextRecoverySafe && isContextRecovery) {
            throw promptRecoveryError(
              promptContext.toolCallObserved
                ? 'The upstream request failed after a tool started. UClaw did not replay the turn to avoid repeating side effects.'
                : 'The upstream request failed after non-text output started. UClaw did not replay the turn to avoid repeating side effects.',
              attemptError,
            );
          }

          if (isContextRecovery && !contextRecoveryAttempted && attempt < maxAttempts) {
            contextRecoveryAttempted = true;
            attempt += 1;
            attemptPrompt = buildContextRecoveryPrompt(attemptError);
            attemptMessageId = `${originalMessageId}:context-recovery:${attempt}`;
            const delayMs = ACP_PROMPT_RETRY_BASE_DELAY_MS;
            this.trace('session/prompt:retry', {
              sessionKey: payload.sessionKey,
              generation,
              details: { requestId: userMessageId, attempt, delayMs, reason: failure.code, recovery: 'structured-summary' },
            });
            logger.warn(`[acp-chat] Context recovery retry ${attempt}/${maxAttempts} scheduled after ${delayMs}ms`);
            const continueRetry = await waitForDelay(delayMs, promptContext.retryAbortController.signal);
            if (!continueRetry) break;
            this.requireSameGatewayRuntime(runtimeIdentity);
            continue;
          }

          if (isTransientUpstream && attempt < maxAttempts) {
            const replacingPartialText = replaySafe && promptContext.firstTextAtMs != null;
            attempt += 1;
            promptContext.attempt = attempt;
            attemptPrompt = replaySafe
              ? buildTransientRetryPrompt(replacingPartialText)
              : buildSideEffectSafeContinuationPrompt(failure);
            attemptMessageId = replaySafe
              ? `${originalMessageId}:upstream-retry:${attempt}`
              : `${originalMessageId}:upstream-continuation:${attempt}`;
            const delayMs = promptRetryDelay(attempt);
            promptContext.retryStatusPending = true;
            promptContext.retryReplacementPending = replacingPartialText;
            void this.emitSessionUpdate(retryingNotification(
              acpSessionId,
              userMessageId,
              attempt,
              maxAttempts,
              delayMs,
              failure.code,
            ));
            this.trace('session/prompt:retry', {
              sessionKey: payload.sessionKey,
              generation,
              details: {
                requestId: userMessageId,
                attempt,
                delayMs,
                reason: failure.code,
                recovery: replaySafe ? 'continue-recorded-request' : 'side-effect-safe-continuation',
              },
            });
            logger.warn(`[acp-chat] Upstream recovery ${attempt}/${maxAttempts} scheduled after ${delayMs}ms`);
            const continueRetry = await waitForDelay(delayMs, promptContext.retryAbortController.signal);
            if (!continueRetry) break;
            this.requireSameGatewayRuntime(runtimeIdentity);
            await this.trySwitchPromptToFallbackModel(connection, acpSessionId, promptContext, failure);
            this.requireSameGatewayRuntime(runtimeIdentity);
            continue;
          }

          if (isContextRecovery && contextRecoveryAttempted) {
            throw promptRecoveryError(
              'Automatic context recovery failed after one replay-safe attempt. The current session and original request were preserved.',
              attemptError,
            );
          }
          if (isTransientUpstream && attempt >= maxAttempts) {
            throw promptRecoveryError(
              `The upstream service remained unavailable after ${attempt} automatic recovery attempts. Please try again later.`,
              attemptError,
            );
          }
          throw attemptError;
        } finally {
          if (promptContext.terminalFailureReject === promptWaiter) {
            promptContext.terminalFailureReject = null;
          }
        }
      }
      if (promptContext.retryStatusPending) {
        promptContext.retryStatusPending = false;
        promptContext.retryReplacementPending = false;
        void this.emitSessionUpdate(retryCancelledNotification(acpSessionId, userMessageId));
      }
      this.requireSameGatewayRuntime(runtimeIdentity);
      const completedAtMs = Date.now();
      this.trace('session/prompt:complete', {
        sessionKey: payload.sessionKey,
        generation,
        details: {
          requestId: userMessageId,
          outcome: 'success',
          firstTextObserved: promptContext.firstTextAtMs != null,
          connectionPromptWaitMs,
          preDispatchPhases: phaseDurations,
          ...promptCompletionDurations(promptContext, completedAtMs),
          ...(promptContext.firstTextAtMs != null ? {
            firstTextToCompleteMs: elapsedMs(promptContext.firstTextAtMs, completedAtMs),
          } : {}),
        },
      });
      this.trace('session/prompt:success', {
        sessionKey: payload.sessionKey,
        generation,
        details: { requestId: userMessageId, blockCount: prompt.length, acpSessionId },
      });
      artifactTaskService.complete(payload.sessionKey, 'success');
      return ok(generation);
    } catch (error) {
      const failure = normalizeAcpChatError(error);
      promptContext.retryStatusPending = false;
      promptContext.retryReplacementPending = false;
      const terminalFailure = promptContext.pendingTerminalFailure
        ?? terminalFailureNotification(acpSessionId, userMessageId, failure);
      promptContext.pendingTerminalFailure = null;
      if (terminalFailure.update && typeof (terminalFailure.update as { userMessageId?: unknown }).userMessageId === 'string') {
        void this.emitSessionUpdate(terminalFailure, { forwardTerminalFailure: true });
      }
      if (imagePreferenceId) {
        await this.turnImagePreferenceStore.discard(imagePreferenceId).catch((discardError) => {
          logger.warn(`[acp-chat] Could not discard image generation preferences: ${String(discardError)}`);
        });
      }
      if (videoPreferenceId) {
        await this.turnVideoPreferenceStore.discard(videoPreferenceId).catch((discardError) => {
          logger.warn(`[acp-chat] Could not discard video generation preferences: ${String(discardError)}`);
        });
      }
      logger.error(`[acp-chat] prompt failed: ${String(error)}`);
      const completedAtMs = Date.now();
      this.trace('session/prompt:complete', {
        sessionKey: payload.sessionKey,
        generation,
        details: {
          requestId: userMessageId,
          outcome: 'failure',
          firstTextObserved: promptContext.firstTextAtMs != null,
          ...promptCompletionDurations(promptContext, completedAtMs),
          ...(promptContext.firstTextAtMs != null ? {
            firstTextToCompleteMs: elapsedMs(promptContext.firstTextAtMs, completedAtMs),
          } : {}),
        },
      });
      this.trace('session/prompt:failed', {
        sessionKey: payload.sessionKey,
        details: { requestId: userMessageId, error: error instanceof Error ? error.message : String(error) },
      });
      artifactTaskService.reportFailure(payload.sessionKey, error);
      artifactTaskService.complete(payload.sessionKey, 'failure');
      return fail(error);
    } finally {
      if (this.livePrompts.get(payload.sessionKey) === promptContext) {
        this.livePrompts.delete(payload.sessionKey);
        this.resolvePermissionWaitersForSession(payload.sessionKey, cancelledPermissionResponse());
      }
      this.permissionsEnabled = this.activeSessionKey != null && this.livePrompts.has(this.activeSessionKey);
    }
  }

  async cancelSession(payload: AcpChatCancelPayload): Promise<AcpChatOperationResult> {
    if (!isValidSessionKey(payload.sessionKey)) return fail('Invalid ACP cancel payload');
    if (payload.sessionKey !== this.activeSessionKey || !this.loadedAcpSessionId) return fail('ACP session is not loaded');

    try {
      this.trace('session/cancel:start', { sessionKey: payload.sessionKey });
      const livePrompt = this.livePrompts.get(payload.sessionKey);
      if (livePrompt) {
        livePrompt.userCancelRequested = true;
        livePrompt.retryAbortController.abort();
        if (livePrompt.retryStatusPending) {
          livePrompt.retryStatusPending = false;
          livePrompt.retryReplacementPending = false;
          void this.emitSessionUpdate(retryCancelledNotification(livePrompt.acpSessionId, livePrompt.userMessageId));
        }
      }
      const runtimeIdentity = await this.requireReadyGatewayRuntime();
      const connection = await this.ensureConnection(runtimeIdentity);
      this.requireSameGatewayRuntime(runtimeIdentity);
      await connection.cancel({ sessionId: this.loadedAcpSessionId });
      this.permissionsEnabled = false;
      this.resolvePermissionWaitersForSession(payload.sessionKey, cancelledPermissionResponse());
      this.trace('session/cancel:success', { sessionKey: payload.sessionKey });
      return ok(this.generation);
    } catch (error) {
      logger.error(`[acp-chat] cancel failed: ${String(error)}`);
      this.trace('session/cancel:failed', {
        sessionKey: payload.sessionKey,
        details: { error: error instanceof Error ? error.message : String(error) },
      });
      return fail(error);
    }
  }

  async respondPermission(payload: AcpChatRespondPermissionPayload): Promise<AcpChatOperationResult> {
    const waiter = this.permissionWaiters.get(payload.requestId);
    if (!waiter || waiter.sessionKey !== payload.sessionKey) return fail('Unknown ACP permission request');

    waiter.resolve({ outcome: payload.outcome });
    this.permissionWaiters.delete(payload.requestId);
    this.trace('permission/responded', {
      sessionKey: payload.sessionKey,
      details: { requestId: payload.requestId, outcome: payload.outcome.outcome },
    });
    return ok(waiter.generation);
  }

  private getReadyGatewayRuntimeIdentity(): string | null {
    if (!this.gateway) return null;
    const status = this.gateway.getStatus?.();
    // `gatewayReady` was added after the original running-state contract. An
    // older Gateway (or a compatible host bridge) may omit it; only an
    // explicit false means that the runtime is still transitioning. The
    // GatewayManager in current builds sets false while booting and true once
    // its readiness event/probe succeeds, so this preserves the strict path
    // without deadlocking legacy status payloads.
    if (!status || status.state !== 'running' || status.gatewayReady === false) {
      throw new Error(GATEWAY_TRANSITION_ERROR);
    }
    return `${status.pid ?? 'none'}:${status.connectedAt ?? 'none'}:${status.port}`;
  }

  private async requireReadyGatewayRuntime(): Promise<string | null> {
    await this.waitForGatewayReady();
    return this.getReadyGatewayRuntimeIdentity();
  }

  private requireSameGatewayRuntime(expectedIdentity: string | null): void {
    const currentIdentity = this.getReadyGatewayRuntimeIdentity();
    if (currentIdentity !== expectedIdentity) {
      this.invalidateConnectionForGatewayTransition();
      throw new Error(GATEWAY_TRANSITION_ERROR);
    }
  }

  private invalidateConnectionForGatewayTransition(): void {
    this.initializationEpoch += 1;
    const child = this.child;
    if (child) {
      try {
        child.kill();
      } catch {
        // The child may already be exiting after its Gateway disappeared.
      }
      this.dropConnectionForChild(child);
      return;
    }
    this.initialized = false;
    this.connection = null;
    this.connectionRuntimeIdentity = null;
  }

  private async ensureConnection(runtimeIdentity: string | null): Promise<AcpConnection> {
    if (this.connection && this.initialized) {
      if (this.connectionRuntimeIdentity === runtimeIdentity) return this.connection;
      this.invalidateConnectionForGatewayTransition();
    }
    if (this.initializing) return this.initializing;

    const initializationEpoch = ++this.initializationEpoch;
    const initialization = this.initializeConnection(runtimeIdentity, initializationEpoch);
    this.initializing = initialization;
    try {
      return await initialization;
    } finally {
      // A Gateway transition or a future implementation may replace the
      // promise while this one is unwinding. Never clear the replacement.
      if (this.initializing === initialization) this.initializing = null;
    }
  }

  private async initializeConnection(
    runtimeIdentity: string | null,
    initializationEpoch: number,
  ): Promise<AcpConnection> {
    if (this.initializationEpoch !== initializationEpoch) {
      throw new Error(GATEWAY_TRANSITION_ERROR);
    }
    this.requireSameGatewayRuntime(runtimeIdentity);
    await this.approveLocalDeviceRequests();
    if (this.initializationEpoch !== initializationEpoch) {
      throw new Error(GATEWAY_TRANSITION_ERROR);
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const connection = await this.initializeConnectionOnce(attempt, initializationEpoch);
        this.requireSameGatewayRuntime(runtimeIdentity);
        this.connectionRuntimeIdentity = runtimeIdentity;
        return connection;
      } catch (error) {
        if (this.isInitializationTimeout(error)) {
          const recovered = await this.recoverStalledGateway(runtimeIdentity, error);
          if (recovered) throw new Error(GATEWAY_TRANSITION_ERROR, { cause: error });
          // Spawning another ACP child against the same unresponsive Gateway
          // only repeats the visible loading delay. Wait for a real runtime
          // transition before retrying this protocol handshake.
          throw error;
        }
        if (attempt >= 2) throw error;
        const failureKind: AcpProcessFailureKind = classifyAcpProcessFailure(error);
        const delayMs = failureKind === 'resource' || failureKind === 'process-exit'
          ? acpProcessRetryDelayMs(attempt)
          : Math.min(
            ACP_CONNECTION_RETRY_MAX_DELAY_MS,
            ACP_CONNECTION_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)),
          );
        logger.info(
          `[acp-chat] ACP connect failed on attempt ${attempt}; retrying after ${delayMs}ms (${failureKind}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.trace('connection/initialize:retry', {
          details: { attempt, nextAttempt: attempt + 1, delayMs, failureKind },
        });
        // A process that ran out of memory or crashed during startup must be
        // given time to release native/V8 allocations before a replacement is
        // spawned.  The loop is intentionally bounded to one retry.
        await waitForDelay(delayMs);
        if (this.initializationEpoch !== initializationEpoch) {
          throw new Error(GATEWAY_TRANSITION_ERROR, { cause: error });
        }
        await this.approveLocalDeviceRequests();
      }
    }

    throw new Error('ACP connection failed');
  }

  private isInitializationTimeout(error: unknown): boolean {
    return typeof error === 'object' && error != null
      && 'code' in error
      && (error as { code?: unknown }).code === 'ACP_INITIALIZATION_TIMEOUT';
  }

  private async recoverStalledGateway(runtimeIdentity: string | null, error: unknown): Promise<boolean> {
    if (
      !runtimeIdentity
      || !this.gateway?.restartForAcpInitializationFailure
      || this.recoveredStalledGatewayIdentity === runtimeIdentity
    ) {
      return false;
    }
    this.recoveredStalledGatewayIdentity = runtimeIdentity;
    this.trace('connection/initialize:gateway-recovery:start', {
      details: { reason: 'acp-initialization-timeout' },
    });
    try {
      // No ACP prompt has been dispatched during initialize, so restarting the
      // stale local runtime cannot replay a provider-side operation.
      const restarted = await this.gateway.restartForAcpInitializationFailure();
      if (!restarted) {
        this.trace('connection/initialize:gateway-recovery:skipped', {
          details: { reason: 'gateway-not-owned' },
        });
        return false;
      }
      this.trace('connection/initialize:gateway-recovery:success', {
        details: { reason: 'acp-initialization-timeout' },
      });
      return true;
    } catch (restartError) {
      logger.warn(`[acp-chat] Gateway recovery after ACP initialization timeout failed: ${String(restartError)}`);
      this.trace('connection/initialize:gateway-recovery:failed', {
        details: {
          reason: 'acp-initialization-timeout',
          error: restartError instanceof Error ? restartError.message : String(restartError),
          timeoutError: error instanceof Error ? error.message : String(error),
        },
      });
      return false;
    }
  }

  private async initializeConnectionOnce(attempt: number, initializationEpoch: number): Promise<AcpConnection> {
    if (this.initializationEpoch !== initializationEpoch) {
      throw new Error(GATEWAY_TRANSITION_ERROR);
    }
    let connection = this.connection;
    let child = this.child;
    if (!connection) {
      // Keep the child returned by spawnConnection in a local variable.  On
      // Windows an ENOENT/ENOMEM spawn error can be emitted on the nextTick
      // before the `await spawnConnection()` continuation runs; the
      // permanent error listener then clears `this.child`.  Relying only on
      // `this.child` here would turn that real failure into a never-settling
      // waitForChildExit(null) branch.
      const spawned = await this.spawnConnection();
      connection = spawned.connection;
      child = spawned.child;
      if (this.initializationEpoch !== initializationEpoch) {
        throw new Error(GATEWAY_TRANSITION_ERROR);
      }
      this.connection = connection;
    }
    if (!connection) throw new Error('ACP connection was not created');

    const diagnostics = child ? this.childDiagnostics.get(child) : undefined;
    if (diagnostics) diagnostics.initializeStartedAtMs = Date.now();
    this.trace('connection/initialize:start', {
      details: { attempt, pid: child?.pid ?? null },
    });
    const initOutcome = await Promise.race([
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      }).then((result) => ({ kind: 'initialized' as const, result })),
      this.waitForChildExit(child).then((termination) => ({ kind: 'terminated' as const, termination })),
    ]).catch((error: unknown) => {
      if (child) this.cancelWaitForChildExit(child);
      throw error;
    });

    if (initOutcome.kind === 'terminated') {
      const diagnostics = child ? this.childDiagnostics.get(child) : undefined;
      if (child && initOutcome.termination.event === 'timeout') {
        try {
          child.kill();
        } catch {
          // The child may already be exiting after the timeout was observed.
        }
      }
      if (child) {
        this.dropConnectionForChild(child);
        // The permanent listener may have observed the terminal event before
        // the spawn promise continuation assigned `this.connection`.  In
        // that ordering dropConnectionForChild is intentionally a no-op
        // (the current child is already null), so clear this stale reference
        // explicitly before the bounded retry.
        if (this.connection === connection && this.child !== child) this.connection = null;
      }
      const message = childTerminationMessage(initOutcome.termination, diagnostics?.resourceFailure === true);
      const failure = new Error(
        message,
        initOutcome.termination.error instanceof Error
          ? { cause: initOutcome.termination.error }
          : undefined,
      );
      const resourceFailure = diagnostics?.resourceFailure === true
        || classifyAcpProcessFailure(initOutcome.termination.error) === 'resource';
      if (resourceFailure) {
        Object.assign(failure, { code: 'ACP_RESOURCE_EXHAUSTED' });
      }
      if (initOutcome.termination.event === 'timeout') {
        Object.assign(failure, { code: 'ACP_INITIALIZATION_TIMEOUT' });
      }
      throw failure;
    }

    // The process survived initialization.  The termination watcher only
    // exists to win this startup race; the permanent process listeners below
    // continue to own lifecycle cleanup after this point.
    if (child) this.cancelWaitForChildExit(child);
    const result = initOutcome.result;
    if (this.initializationEpoch !== initializationEpoch || this.connection !== connection) {
      throw new Error('ACP connection closed during initialization');
    }
    if (!result.agentCapabilities?.loadSession) {
      this.trace('connection/initialize:failed', { details: { reason: 'missing-loadSession-capability' } });
      throw new Error('ACP agent does not support session/load');
    }
    this.initialized = true;
    this.trace('connection/initialize:success', { details: { protocolVersion: PROTOCOL_VERSION, attempt } });

    return connection;
  }

  private async approveLocalDeviceRequests(): Promise<void> {
    if (!this.gateway) return;
    try {
      await approvePendingLocalDeviceRequests(this.gateway);
    } catch (error) {
      logger.debug(`[acp-chat] Local device auto-approve skipped: ${String(error)}`);
    }
  }

  private async waitForGatewayReady(): Promise<void> {
    if (!this.gateway?.getStatus) return;

    const initialStatus = this.gateway.getStatus();
    if (!gatewayNeedsReadinessWait(initialStatus)) return;

    const startedAt = Date.now();
    this.trace('connection/wait-for-gateway-ready:start', {
      details: {
        state: initialStatus?.state,
        gatewayReady: initialStatus?.gatewayReady,
      },
    });

    while (Date.now() - startedAt < ACP_GATEWAY_READY_WAIT_TIMEOUT_MS) {
      await waitForDelay(ACP_GATEWAY_READY_POLL_INTERVAL_MS);
      const status = this.gateway.getStatus();
      if (gatewayNeedsReadinessWait(status)) continue;

      this.trace('connection/wait-for-gateway-ready:success', {
        details: {
          waitedMs: Date.now() - startedAt,
          state: status?.state,
          gatewayReady: status?.gatewayReady,
        },
      });
      return;
    }

    const status = this.gateway.getStatus();
    this.trace('connection/wait-for-gateway-ready:timeout', {
      details: {
        waitedMs: Date.now() - startedAt,
        state: status?.state,
        gatewayReady: status?.gatewayReady,
      },
    });
  }

  private waitForChildExit(child: AcpChildProcess | null): Promise<AcpChildTermination> {
    // An injected connection has no child process to supervise. It must not win
    // the initialization race as a synthetic process-exit event.
    if (!child) return new Promise<AcpChildTermination>(() => {});
    const recordedTermination = this.childDiagnostics.get(child)?.termination;
    if (recordedTermination) return Promise.resolve(recordedTermination);
    if (child.exitCode != null || child.signalCode != null) {
      return Promise.resolve({
        event: 'exit',
        code: child.exitCode ?? null,
        signal: child.signalCode ?? null,
      });
    }

    const existing = this.childTerminationWaiters.get(child);
    if (existing) return existing.promise;

    let cancel!: () => void;
    let pending!: Promise<AcpChildTermination>;
    pending = new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        child.off('error', onError);
        child.off('exit', onExit);
        child.off('close', onClose);
        clearTimeout(timeout);
        if (this.childTerminationWaiters.get(child)?.promise === pending) {
          this.childTerminationWaiters.delete(child);
        }
      };
      const settle = (termination: AcpChildTermination) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(termination);
      };
      cancel = () => {
        if (settled) return;
        settled = true;
        cleanup();
      };
      const onError = (error: Error) => settle({
        event: 'error',
        code: child.exitCode ?? null,
        signal: child.signalCode ?? null,
        error,
      });
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => settle({
        event: 'exit',
        code,
        signal,
      });
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => settle({
        event: 'close',
        code,
        signal,
      });
      const timeout = setTimeout(() => {
        const diagnostics = this.childDiagnostics.get(child);
        const now = Date.now();
        this.trace('connection/initialize:timeout', {
          details: {
            pid: child.pid ?? null,
            spawnToTimeoutMs: diagnostics ? now - diagnostics.spawnedAtMs : null,
            initializeStarted: diagnostics?.initializeStartedAtMs != null,
            initializeToTimeoutMs: diagnostics?.initializeStartedAtMs == null
              ? null
              : now - diagnostics.initializeStartedAtMs,
            firstProtocolResponse: diagnostics?.firstProtocolResponseAtMs != null,
          },
        });
        settle({
          event: 'timeout',
          code: child.exitCode ?? null,
          signal: child.signalCode ?? null,
        });
      }, ACP_INITIALIZATION_TIMEOUT_MS);
      timeout.unref?.();

      // ChildProcess can emit `error` without ever emitting `exit` (for
      // example, ENOENT/ENOMEM during spawn).  Listen to all terminal events,
      // but clean up every listener on the first one to avoid duplicate work.
      child.on('error', onError);
      child.on('exit', onExit);
      child.on('close', onClose);
    });
    this.childTerminationWaiters.set(child, { promise: pending, cancel });
    return pending;
  }

  private cancelWaitForChildExit(child: AcpChildProcess): void {
    this.childTerminationWaiters.get(child)?.cancel();
  }

  private async spawnConnection(): Promise<SpawnedAcpConnection> {
    const gatewayPort = this.gateway?.getStatus?.().port;
    const gatewayUrl = typeof gatewayPort === 'number'
      && Number.isInteger(gatewayPort)
      && gatewayPort > 0
      && gatewayPort <= 65_535
      ? `ws://127.0.0.1:${gatewayPort}`
      : undefined;
    const spec = getOpenClawEmbeddedForkSpec(['acp']);
    const gatewayToken = await this.gateway?.getGatewayToken?.();
    if (gatewayUrl || gatewayToken) {
      spec.options.env = {
        ...spec.options.env,
        ...(gatewayUrl ? { OPENCLAW_GATEWAY_URL: gatewayUrl } : {}),
        ...(gatewayToken ? { OPENCLAW_GATEWAY_TOKEN: gatewayToken } : {}),
      };
    }
    const forked = fork(spec.modulePath, spec.args, spec.options);
    if (!forked.stdin || !forked.stdout || !forked.stderr) {
      forked.kill();
      throw new Error('ACP process did not expose stdio pipes');
    }
    this.child = forked as AcpChildProcess;

    const child = this.child;
    this.childDiagnostics.set(child, {
      resourceFailure: false,
      stderrTail: '',
      spawnedAtMs: Date.now(),
    });
    this.trace('connection/process:spawned', {
      details: {
        pid: child.pid ?? null,
        execPath: spec.options.execPath ?? null,
        execArgv: spec.options.execArgv ?? [],
      },
    });
    logger.info('[acp-chat] ACP process spawned', {
      pid: child.pid ?? null,
      execPath: spec.options.execPath ?? null,
      execArgv: spec.options.execArgv ?? [],
    });

    child.stderr.on('data', (chunk) => {
      const message = String(chunk).trimEnd();
      if (message) {
        const diagnostics = this.childDiagnostics.get(child);
        if (diagnostics) {
          // stderr chunk boundaries are arbitrary; keep a short in-memory tail
          // so "out of memory" split across two chunks is still classified.
          diagnostics.stderrTail = `${diagnostics.stderrTail}${message}`.slice(-2_048);
          if (!diagnostics.resourceFailure && classifyAcpProcessFailure(diagnostics.stderrTail) === 'resource') {
            diagnostics.resourceFailure = true;
            this.trace('connection/process:resource-pressure', {
              details: { pid: child.pid ?? null },
            });
          }
        }
        logger.info(`[acp-chat] ${message}`);
      }
    });
    child.on('error', (error) => {
      logger.error(`[acp-chat] ACP process error: ${String(error)}`);
      const diagnostics = this.childDiagnostics.get(child);
      if (diagnostics) {
        if (classifyAcpProcessFailure(error) === 'resource') diagnostics.resourceFailure = true;
        diagnostics.termination ??= {
          event: 'error',
          code: child.exitCode ?? null,
          signal: child.signalCode ?? null,
          error,
        };
      }
      this.dropConnectionForChild(child);
    });
    child.on('exit', (code, signal) => {
      logger.info(`[acp-chat] ACP process exited with code ${String(code)}`);
      const diagnostics = this.childDiagnostics.get(child);
      if (diagnostics) {
        diagnostics.termination ??= { event: 'exit', code, signal };
      }
      this.dropConnectionForChild(child);
    });
    child.on('close', (code, signal) => {
      // Node normally emits close after exit, but an early spawn failure may
      // only surface close/error. Keep the connection state from pointing at
      // a child whose stdio has already gone away; dropConnection is idempotent
      // when both events arrive for the same process.
      logger.info(
        `[acp-chat] ACP process stdio closed with code ${String(code)} signal ${String(signal)}`,
      );
      const diagnostics = this.childDiagnostics.get(child);
      if (diagnostics) {
        diagnostics.termination ??= { event: 'close', code, signal };
      }
      this.dropConnectionForChild(child);
    });

    const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const output = filterAcpStdoutDiagnostics(
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      () => {
        const diagnostics = this.childDiagnostics.get(child);
        if (!diagnostics || diagnostics.firstProtocolResponseAtMs != null) return;
        diagnostics.firstProtocolResponseAtMs = Date.now();
        this.trace('connection/protocol:first-response', {
          details: {
            pid: child.pid ?? null,
            spawnToResponseMs: diagnostics.firstProtocolResponseAtMs - diagnostics.spawnedAtMs,
            initializeToResponseMs: diagnostics.initializeStartedAtMs == null
              ? null
              : diagnostics.firstProtocolResponseAtMs - diagnostics.initializeStartedAtMs,
          },
        });
      },
    );
    const stream = ndJsonStream(input, output);
    return {
      connection: new ClientSideConnection(() => this.client, stream),
      child,
    };
  }

  private dropConnectionForChild(child: AcpChildProcess): void {
    if (this.child !== child) return;
    this.trace('connection/dropped', { details: { pendingPermissionCount: this.permissionWaiters.size } });
    this.resolveAllPermissionWaiters(cancelledPermissionResponse());
    this.initialized = false;
    // Do not clear an in-flight initialization here.  If the child exits
    // during its handshake, initializeConnection() owns the promise and will
    // perform the single delayed retry. Clearing it would let a concurrent
    // warmup/load spawn a second ACP child before that retry, briefly doubling
    // the memory pressure that caused the exit.
    this.connection = null;
    this.connectionRuntimeIdentity = null;
    this.child = null;
    this.loadedSessionKey = null;
    this.loadedAcpSessionId = null;
    this.historicalSessionKey = null;
    this.historicalGeneration = null;
    this.permissionsEnabled = false;
    this.livePrompts.clear();
  }

  private async materializeInlineImageBlock(
    block: Record<string, unknown>,
    sessionKey: string,
    generation: number,
    context: InlineImageMaterializationContext,
    transcriptMessageId?: string,
  ): Promise<Record<string, unknown>> {
    const source = inlineImagePayload(block);
    const declaredMimeType = typeof block.mimeType === 'string' ? block.mimeType : '';
    const sourceLength = typeof block.data === 'string'
      ? `data:${declaredMimeType};base64,`.length + block.data.length
      : typeof block.uri === 'string' ? block.uri.length : 0;
    if (sourceLength <= ACP_INLINE_IMAGE_MAX_DATA_URI_CHARS) return block;
    if (!source || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.data) || source.data.length % 4 !== 0) {
      return { type: 'text', text: '[Image omitted: invalid inline image data.]' };
    }

    if (!isManagedInlineImageMimeType(source.mimeType)) {
      return { type: 'text', text: '[Image omitted: unsupported inline image type.]' };
    }
    const extension = ACP_MANAGED_INLINE_IMAGE_MIME_TYPES.get(source.mimeType);
    const buffer = Buffer.from(source.data, 'base64');
    if (!extension || !isSafeInlineImageBuffer(buffer, source.mimeType)
      || context.materializedBytes + buffer.length > ACP_MANAGED_INLINE_IMAGE_MAX_BYTES) {
      return { type: 'text', text: '[Image omitted: inline image exceeds safe media limits.]' };
    }
    if (!this.accessRegistry.get(sessionKey, generation)) {
      return { type: 'text', text: '[Image omitted: its session is no longer active.]' };
    }

    const attachmentId = `acp-inline-${randomUUID()}`;
    const stateDir = resolveOpenClawStateDir();
    const originalsDir = join(stateDir, 'media', 'outgoing', 'originals');
    const recordsDir = join(stateDir, 'media', 'outgoing', 'records');
    const originalPath = join(originalsDir, `${attachmentId}.${extension}`);
    const recordPath = join(recordsDir, `${attachmentId}.json`);
    const recordTempPath = join(recordsDir, `.${attachmentId}.json.tmp`);
    let originalWritten = false;
    let recordWritten = false;
    context.materializedBytes += buffer.length;
    try {
      await Promise.all([
        mkdir(originalsDir, { recursive: true }),
        mkdir(recordsDir, { recursive: true }),
      ]);
      await writeFile(originalPath, buffer, { flag: 'wx' });
      originalWritten = true;
      if (!this.accessRegistry.get(sessionKey, generation)) throw new Error('stale ACP session generation');
      await writeFile(recordTempPath, JSON.stringify({
        attachmentId,
        sessionKey,
        ...(transcriptMessageId ? { messageId: transcriptMessageId } : {}),
        original: {
          path: originalPath,
          contentType: source.mimeType,
          sizeBytes: buffer.length,
        },
      }), { flag: 'wx' });
      await rename(recordTempPath, recordPath);
      recordWritten = true;
      if (!this.accessRegistry.get(sessionKey, generation)) throw new Error('stale ACP session generation');
      return {
        type: 'resource_link',
        uri: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
        name: `generated-image.${extension}`,
        mimeType: source.mimeType,
        size: buffer.length,
        _meta: { clawx: transcriptMessageId ? { transcriptMessageId } : {} },
      };
    } catch (error) {
      context.materializedBytes -= buffer.length;
      logger.warn(`[acp-chat] unable to materialize oversized inline image: ${String(error)}`);
      await Promise.all([
        ...(recordWritten ? [rm(recordPath, { force: true })] : []),
        ...(originalWritten ? [rm(originalPath, { force: true })] : []),
        rm(recordTempPath, { force: true }),
      ]).catch(() => undefined);
      return { type: 'text', text: '[Image omitted: unable to store its original safely.]' };
    }
  }

  private async materializeInlineImages(
    value: unknown,
    sessionKey: string,
    generation: number,
    context: InlineImageMaterializationContext,
    transcriptMessageId?: string,
  ): Promise<unknown> {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const entry of value) {
        result.push(await this.materializeInlineImages(entry, sessionKey, generation, context, transcriptMessageId));
      }
      return result;
    }
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    if (record.type === 'image') {
      return this.materializeInlineImageBlock(record, sessionKey, generation, context, transcriptMessageId);
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      result[key] = await this.materializeInlineImages(entry, sessionKey, generation, context, transcriptMessageId);
    }
    return result;
  }

  private async materializeSessionNotification(
    notification: SessionNotification,
    sessionKey: string,
    generation: number,
  ): Promise<SessionNotification> {
    const update = (notification as unknown as { update?: Record<string, unknown> }).update;
    const transcriptMessageId = typeof update?.messageId === 'string' ? update.messageId : undefined;
    return this.materializeInlineImages(notification, sessionKey, generation, {
      materializedBytes: 0,
    }, transcriptMessageId) as Promise<SessionNotification>;
  }

  private async emitSessionUpdate(
    notification: SessionNotification,
    options: { forwardTerminalFailure?: boolean } = {},
  ): Promise<void> {
    const acpSessionId = notification.sessionId;
    const livePrompt = [...this.livePrompts.values()].find((context) => context.acpSessionId === acpSessionId);
    const sessionKey = livePrompt?.sessionKey ?? this.activeSessionKey;
    const generation = livePrompt?.generation ?? this.generation;
    const updateType = sessionUpdateType(notification);
    this.trace('session-update:received', {
      direction: 'upstream',
      sessionKey: sessionKey ?? null,
      details: { acpSessionId, updateType },
    });
    if (!sessionKey) {
      this.trace('session-update:ignored', {
        direction: 'upstream',
        sessionKey: null,
        details: { reason: 'no-active-session', acpSessionId, updateType },
      });
      return;
    }
    if (!livePrompt && this.activeAcpSessionId && acpSessionId !== this.activeAcpSessionId) {
      this.trace('session-update:ignored', {
        direction: 'upstream',
        sessionKey,
        details: { reason: 'session-mismatch', acpSessionId, activeAcpSessionId: this.activeAcpSessionId, updateType },
      });
      return;
    }
    if (livePrompt && isTerminalPromptFailure(notification) && !options.forwardTerminalFailure) {
      livePrompt.pendingTerminalFailure = notification;
      livePrompt.terminalFailureReject?.(terminalFailureError(notification));
      this.trace('session-update:buffered', {
        direction: 'downstream',
        sessionKey,
        details: { acpSessionId, updateType, reason: 'retryable-terminal-failure' },
      });
      return;
    }

    const toolUpdate = artifactToolUpdate(notification);
    if (livePrompt && toolUpdate) {
      livePrompt.toolCallObserved = true;
      livePrompt.replayUnsafeObserved = true;
      livePrompt.attemptToolCallObserved = true;
      livePrompt.attemptOutputObserved = true;
      artifactTaskService.recordTool(sessionKey, toolUpdate);
    }
    if (livePrompt && hasReplayUnsafeAgentContent(notification)) {
      livePrompt.replayUnsafeObserved = true;
    }
    if (livePrompt && hasAgentReplyContent(notification)) {
      livePrompt.attemptOutputObserved = true;
    }
    if (livePrompt && hasReplayUnsafeAgentContent(notification)) {
      livePrompt.attemptOutputObserved = true;
    }
    const visibleAgentText = livePrompt ? isVisibleAgentText(notification) : false;
    let retryReplacement: AcpTurnRetryReplacement | undefined;
    if (livePrompt && visibleAgentText) {
      livePrompt.retryStatusPending = false;
      if (livePrompt.retryReplacementPending && livePrompt.attempt > 1) {
        retryReplacement = {
          userMessageId: livePrompt.userMessageId,
          attempt: livePrompt.attempt,
        };
        livePrompt.retryReplacementPending = false;
      }
    }

    const materializedInlineImage = hasOversizedInlineImage(notification);
    const safeNotification = materializedInlineImage
      ? await this.materializeSessionNotification(notification, sessionKey, generation)
      : notification;
    if (materializedInlineImage && !this.accessRegistry.get(sessionKey, generation)) {
      this.trace('session-update:ignored', {
        direction: 'upstream',
        sessionKey,
        details: { reason: 'stale-generation-after-media-materialization', acpSessionId, updateType },
      });
      return;
    }
    const envelope: AcpSessionUpdateEnvelope = {
      sessionKey,
      generation,
      ...(!livePrompt && this.historicalSessionKey === sessionKey && this.historicalGeneration === generation
        ? { historical: true }
        : {}),
      ...(retryReplacement ? { retryReplacement } : {}),
      notification: { ...safeNotification, sessionId: sessionKey },
    };
    const loadBatch = this.activeLoadBatch;
    if (loadBatch?.sessionKey === sessionKey && loadBatch.generation === generation) {
      loadBatch.sessionUpdates.push({ acpSessionId, envelope });
      this.trace('session-update:buffered', {
        direction: 'downstream',
        sessionKey,
        details: { acpSessionId, updateType, historical: !!envelope.historical },
      });
      return;
    }
    this.mainWindow.webContents.send(HOST_EVENT_CHANNELS.chat.acpSessionUpdate, envelope);
    if (
      livePrompt
      && livePrompt.dispatchedAtMs != null
      && livePrompt.firstTextAtMs == null
      && visibleAgentText
    ) {
      const firstTextAtMs = Date.now();
      livePrompt.firstTextAtMs = firstTextAtMs;
      artifactTaskService.markFirstText(sessionKey);
      this.trace('session/prompt:first-text', {
        direction: 'downstream',
        sessionKey,
        generation,
        details: {
          clientToMainMs: elapsedMs(livePrompt.clientStartedAtMs, livePrompt.mainReceivedAtMs),
          mainToDispatchMs: elapsedMs(livePrompt.mainReceivedAtMs, livePrompt.dispatchedAtMs),
          dispatchToFirstTextMs: elapsedMs(livePrompt.dispatchedAtMs, firstTextAtMs),
          clientToFirstTextMs: elapsedMs(livePrompt.clientStartedAtMs, firstTextAtMs),
        },
      });
    }
    this.trace('session-update:forwarded', {
      direction: 'downstream',
      sessionKey,
      details: { acpSessionId, updateType, historical: !!envelope.historical },
    });
  }

  private requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const acpSessionId = request.sessionId;
    const livePrompt = [...this.livePrompts.values()].find((context) => context.acpSessionId === acpSessionId);
    const sessionKey = livePrompt?.sessionKey ?? this.activeSessionKey;
    const generation = livePrompt?.generation ?? this.generation;
    if (livePrompt) {
      livePrompt.replayUnsafeObserved = true;
      livePrompt.attemptOutputObserved = true;
    }
    if (!livePrompt && !this.permissionsEnabled) {
      this.trace('permission:ignored', {
        direction: 'upstream',
        sessionKey: sessionKey ?? null,
        details: { reason: 'no-active-prompt', acpSessionId },
      });
      return Promise.resolve(cancelledPermissionResponse());
    }
    if (this.activeLoadBatch && !livePrompt) {
      this.trace('permission:ignored', {
        direction: 'upstream',
        sessionKey: sessionKey ?? null,
        details: { reason: 'session-loading', acpSessionId },
      });
      return Promise.resolve(cancelledPermissionResponse());
    }
    if (!sessionKey || (!livePrompt && this.activeAcpSessionId && acpSessionId !== this.activeAcpSessionId)) {
      this.trace('permission:ignored', {
        direction: 'upstream',
        sessionKey: sessionKey ?? null,
        details: {
          reason: !sessionKey ? 'no-active-session' : 'session-mismatch',
          acpSessionId,
          activeAcpSessionId: this.activeAcpSessionId,
        },
      });
      return Promise.resolve(cancelledPermissionResponse());
    }

    const requestId = `acp-permission-${Date.now()}-${this.permissionSeq += 1}`;
    const envelope: AcpPermissionRequestEnvelope = {
      sessionKey,
      generation,
      requestId,
      request: { ...request, sessionId: sessionKey },
    };
    this.mainWindow.webContents.send(HOST_EVENT_CHANNELS.chat.acpPermissionRequest, envelope);
    this.trace('permission:forwarded', {
      direction: 'downstream',
      sessionKey,
      details: { requestId, acpSessionId, optionCount: request.options.length },
    });

    return new Promise((resolve) => {
      this.permissionWaiters.set(requestId, { sessionKey, generation, resolve });
    });
  }

  private resolvePermissionWaitersForSession(sessionKey: string, response: RequestPermissionResponse): void {
    for (const [requestId, waiter] of this.permissionWaiters) {
      if (waiter.sessionKey !== sessionKey) continue;
      waiter.resolve(response);
      this.permissionWaiters.delete(requestId);
    }
  }

  private resolveAllPermissionWaiters(response: RequestPermissionResponse): void {
    for (const [requestId, waiter] of this.permissionWaiters) {
      waiter.resolve(response);
      this.permissionWaiters.delete(requestId);
    }
  }

  private async buildPromptBlocks(payload: AcpChatPromptPayload): Promise<AcpPromptBuildResult> {
    const blocks: ContentBlock[] = [];
    let videoReferenceImage: AcpPromptBuildResult['videoReferenceImage'];
    if (payload.message && Buffer.byteLength(payload.message, 'utf8') > CHAT_PROMPT_MAX_UTF8_BYTES) {
      throw chatPromptByteLimitError();
    }
    const text = payload.message?.trim();
    if (text) blocks.push({ type: 'text', text });

    const media = payload.media ?? [];
    if (media.length > 0) {
      if (media.length > CHAT_MEDIA_MAX_ITEMS) throw chatMediaCountLimitError();
      const imageCount = media.filter((item) => (item.mimeType || '').startsWith('image/')).length;
      if (payload.videoOptions && imageCount > 1) {
        throw new Error('Video generation supports at most one reference image.');
      }

      let imageBudget = EMPTY_CHAT_MEDIA_IMAGE_BUDGET;
      for (const item of media) {
        const mimeType = item.mimeType || 'application/octet-stream';
        if (mimeType.startsWith('image/')) {
          const prepared = payload.videoOptions
            ? await prepareVideoReferenceImage({
              filePath: item.filePath,
              fileName: item.fileName,
              mimeType,
              maxBytes: UCLAW_VIDEO_GENERATION_MAX_INPUT_IMAGE_BYTES,
            })
            : await prepareAcpChatImage({
              filePath: item.filePath,
              fileName: item.fileName,
              mimeType,
            });
          imageBudget = addChatMediaImageToBudget(imageBudget, prepared.buffer.byteLength);
          const data = prepared.buffer.toString('base64');
          if (prepared.compressed) {
            logger.info(
              `[acp-chat] Compressed ${payload.videoOptions ? 'video reference' : 'chat'} image from ${prepared.inputBytes} to ${prepared.outputBytes} bytes`,
            );
          }
          if (payload.videoOptions) {
            videoReferenceImage = {
              buffer: prepared.buffer,
              fileName: prepared.fileName,
              mimeType: prepared.mimeType,
            };
          }
          blocks.push({
            type: 'image',
            data,
            mimeType: prepared.mimeType,
            uri: item.filePath,
            _meta: {
              clawx: {
                stagingId: item.stagingId,
                ...(item.fileName ? { fileName: item.fileName } : {}),
              },
            },
          });
        } else {
          blocks.push({
            type: 'resource_link',
            uri: item.filePath,
            name: item.fileName ?? item.filePath,
            mimeType: item.mimeType,
            _meta: {
              clawx: {
                stagingId: item.stagingId,
              },
            },
          });
        }
      }
    }

    if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
    return {
      blocks,
      ...(videoReferenceImage ? { videoReferenceImage } : {}),
    };
  }
}

export function createAcpChatService(
  mainWindow: MainWindowLike,
  accessRegistry: AcpSessionAccessRegistry,
  gateway?: GatewayPairingRpcClient,
): AcpChatService {
  return new AcpChatService(mainWindow, accessRegistry, undefined, gateway);
}
