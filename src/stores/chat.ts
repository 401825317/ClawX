/**
 * Chat State Store
 * Manages chat messages, sessions, and streaming state.
 * Chat RPC/control flows are Main-owned via Host API routes.
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import i18n from '@/i18n';
import { isGatewayReadyForChatSend, useGatewayStore } from './gateway';
import { useAgentsStore } from './agents';
import { getManagedAuthStateKey, isManagedAuthLocallyReady, isManagedAuthReady } from '@/lib/managed-auth';
import { normalizeManagedTextModelRef } from '@/lib/managed-model-options';
import { useClientConfigStore } from './client-config';
import { useManagedAuthStore } from './managed-auth';
import { useProviderStore } from './providers';
import {
  CHAT_SYNTHETIC_TERMINAL_PRODUCER,
  type ChatRuntimeArtifact,
  type ChatRuntimeEvent,
} from '../../shared/chat-runtime-events';
import type { VideoAttachmentMetadata } from '../../shared/video-attachment-metadata';
import type { GatewayStatus } from '../types/gateway';
import { CHAT_SEND_RPC_TIMEOUT_MS } from '../../shared/chat-timeouts';
import { buildBaselineRunKey, captureBaseline, clearBaselines } from './baseline-cache';
import { buildCronSessionHistoryPath, isCronSessionKey } from './chat/cron-session-utils';
import {
  isInternalHeartbeatSession,
  persistCurrentSessionKey,
  pickStartupSessionFallback,
  readPersistedCurrentSessionKey,
} from './chat/session-selection';
import {
  CHAT_HISTORY_DISK_FALLBACK_TIMEOUT_MS,
  CHAT_HISTORY_STARTUP_FALLBACK_RACE_MS,
  CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS,
  classifyHistoryStartupRetryError,
  getHistoryLoadingSafetyTimeout,
  getStartupHistoryTimeoutOverride,
  shouldRetryStartupHistoryLoad,
  sleep,
} from './chat/history-startup-retry';
import {
  buildChatHistoryRpcParams,
  getChatHistoryMaxChars,
} from './chat/history-rpc-params';
import { loadSessionTranscriptFallback } from './chat/history-transcript-fallback';
import { hydrateGatewayHistoryFromTranscript } from './chat/history-transcript-hydrate';
import {
  LABEL_FETCH_RETRY_DELAYS_MS,
  abandonSessionLabelHydration,
  beginSessionLabelHydration,
  clearSessionLabelHydrationTracking,
  finishSessionLabelHydration,
  getSessionLabelHydrationCandidate,
  getSessionLabelHydrationVersion,
} from './chat/session-label-hydration';
import {
  DEFAULT_CANONICAL_PREFIX,
  DEFAULT_SESSION_KEY,
  type AsyncTaskEvidence,
  type AttachedFileMeta,
  type ChatImageSendOptions,
  type ChatSendAttachment,
  type ChatSendMode,
  type ChatSession,
  type ChatState,
  type ChatVideoSendOptions,
  type ContentBlock,
  type RawMessage,
  type ToolStatus,
} from './chat/types';
import {
  applyCompletionWakeEvidenceEventToOwners,
  applyRuntimeEventToRuns,
  applyRuntimeTaskEventToOwners,
  buildCompletionWakeTerminalTaskEvent,
  completionWakeTaskIdFromRunId,
  extractToolCompletedFiles,
  resolveCompletionWakeOwnerRunId,
  shouldFilterRuntimeExecutionGraphEvent,
} from './chat/runtime-graph';
import { buildRuntimeProgressEvents } from './chat/runtime-progress';
import {
  buildHostTaskRehydrationEvents,
  parseHostTaskBridgeTasks,
} from './chat/host-task-rehydration';
import {
  buildRuntimeArtifactEventsFromAttachedFiles,
  buildRuntimeArtifactVerificationEvent,
  buildRuntimeStartEvents,
  hasDeliveredArtifactEvidence,
} from './chat/runtime-evidence';
import {
  applyAsyncTaskEvidenceToRuns,
  buildStreamingAssistantMessageFromRuntimeRun,
  collectRunDetachedTaskIdsForAbort,
  collectRunHostTaskIdsForAbort,
  enrichWithToolCallAttachments,
  extractAsyncTaskEvidence,
  isInternalMessage as isHistoryInternalMessage,
  messageHasDeliverableContent,
  runtimeRunHasPendingAsyncTasks,
  shouldDropMessageFromHistory,
} from './chat/helpers';
import {
  extractTextSegments,
  extractToolUse,
  isGeneratingStatusNarration,
  isInternalAssistantReplyText,
  isInternalProcessNarration,
} from '@/pages/Chat/message-utils';

export type {
  AttachedFileMeta,
  ChatSession,
  ContentBlock,
  RawMessage,
  ToolStatus,
  ChatRuntimeRunState,
} from './chat/types';

type ChatSet = (
  partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>),
  replace?: false,
) => void;

type ChatGet = () => ChatState;

// Module-level timestamp tracking the last chat event received.
// Used by the safety timeout to avoid false-positive "no response" errors
// during tool-use conversations where streamingMessage is temporarily cleared
// between tool-result finals and the next delta.
let _lastChatEventAt = 0;
let _managedAuthBackgroundVerifyInFlight: Promise<void> | null = null;
let _lastManagedAuthBackgroundVerifyAt = 0;
const MANAGED_AUTH_BACKGROUND_VERIFY_MIN_INTERVAL_MS = 60_000;

function managedAuthSendErrorMessage(stateKey: string, detail?: string | null): string {
  if (stateKey === 'loggedOut') {
    return 'Please sign in before sending messages.';
  }
  if (stateKey === 'activationRequired') {
    return 'Please activate this device before sending messages.';
  }
  if (stateKey === 'relayMissing') {
    return 'The model service key is not ready. Sign in again or refresh account status.';
  }
  if (stateKey === 'error') {
    return `Unable to verify sign-in status${detail ? `: ${detail}` : '.'}`;
  }
  return 'Your sign-in session has expired. Please sign in again before sending messages.';
}

function scheduleManagedAuthBackgroundVerify(refreshStatus: () => Promise<unknown>): void {
  const now = Date.now();
  if (
    _managedAuthBackgroundVerifyInFlight
    || now - _lastManagedAuthBackgroundVerifyAt < MANAGED_AUTH_BACKGROUND_VERIFY_MIN_INTERVAL_MS
  ) {
    return;
  }

  _lastManagedAuthBackgroundVerifyAt = now;
  _managedAuthBackgroundVerifyInFlight = refreshStatus()
    .then(() => undefined)
    .catch((error) => {
      console.warn('[managed-auth] background status refresh failed:', error);
    })
    .finally(() => {
      _managedAuthBackgroundVerifyInFlight = null;
    });
}

function ensureManagedAuthReadyForSend(): Promise<void> | null {
  const store = useManagedAuthStore.getState();
  const providerState = useProviderStore.getState();
  const providerAccounts = Array.isArray(providerState.accounts) ? providerState.accounts : [];
  const shouldEnforce = store.status?.managed === true
    || providerState.defaultAccountId === 'lingzhiwuxian'
    || providerAccounts.some((account) => account.id === 'lingzhiwuxian');
  if (!shouldEnforce) {
    return null;
  }

  if (isManagedAuthReady(store.status) || isManagedAuthLocallyReady(store.status)) {
    scheduleManagedAuthBackgroundVerify(store.refreshStatus);
    return null;
  }

  return (async () => {
    try {
      const status = await store.refreshStatus();
      if (isManagedAuthReady(status)) {
        return;
      }
      throw new Error(managedAuthSendErrorMessage(getManagedAuthStateKey(status), status.authError));
    } catch (error) {
      const state = useManagedAuthStore.getState();
      const stateKey = getManagedAuthStateKey(state.status, {
        loading: state.loading,
        error: state.error,
      });
      throw new Error(
        managedAuthSendErrorMessage(stateKey, state.error || (error instanceof Error ? error.message : String(error))),
        { cause: error },
      );
    }
  })();
}

type PendingImageInput = {
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;
  preview: string | null;
};

function toPendingImageInput(file: NonNullable<RawMessage['_attachedFiles']>[number]): PendingImageInput | null {
  const stagedPath = file.filePath?.trim();
  if (!file.mimeType.startsWith('image/') || !stagedPath) return null;
  return {
    fileName: file.fileName || stagedPath.split(/[\\/]/).pop() || 'image',
    mimeType: file.mimeType,
    fileSize: file.fileSize,
    stagedPath,
    preview: file.preview,
  };
}

/** Resolve the chronologically latest usable image in the current session. */
function findLatestSessionImage(messages: RawMessage[]): PendingImageInput | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const files = messages[messageIndex]?._attachedFiles ?? [];
    for (let fileIndex = files.length - 1; fileIndex >= 0; fileIndex -= 1) {
      const image = toPendingImageInput(files[fileIndex]!);
      if (image) return image;
    }
  }
  return null;
}

/** Restrict implicit media reuse to clear requests that edit an existing image. */
function isImageEditRequest(prompt: string): boolean {
  const normalized = prompt.trim();
  if (!normalized) return false;
  const editAction = /(?:修改|编辑|修图|美化|重绘|去掉|删除|移除|替换|改成|调整|换成|变成|edit|modify|retouch|remove|replace|change|adjust)/i;
  const addAction = /(?:添加|加上|add)/i;
  const imageTarget = /(?:图片|图像|照片|画面|这张图|这幅图|上一张图|刚才的图|这张照片|上一张照片|image|picture|photo|this image|this picture|this photo|previous image|last image)/i;
  const chinesePriorReference = /(?:这张|这幅|上一张|刚才那张|它)/;
  const englishPriorReference = /\b(?:this|that|previous|last|it)\b/i;
  const refersToExistingImage = chinesePriorReference.test(normalized) || englishPriorReference.test(normalized);
  return (editAction.test(normalized) && (imageTarget.test(normalized) || refersToExistingImage))
    || (addAction.test(normalized) && imageTarget.test(normalized) && refersToExistingImage);
}

type GatewayTurnPreferences = {
  mode: ChatSendMode;
  image?: {
    model?: string;
    size?: string;
    quality?: 'low' | 'medium' | 'high';
  };
  video?: ChatVideoSendOptions;
  selectedArtifacts?: Array<{
    filePath: string;
    mimeType: string;
    title: string;
  }>;
};

function dimensionArea(value: string): number {
  const match = value.match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!match) return 0;
  return Number(match[1]) * Number(match[2]);
}

function strongestSize(sizes: string[] | undefined, fallback: string): string {
  const candidates = (sizes ?? []).filter(Boolean);
  if (candidates.length === 0) return fallback;
  return candidates.reduce((best, current) => (
    dimensionArea(current) > dimensionArea(best) ? current : best
  ), candidates[0]!);
}

function strongestDuration(durations: number[] | undefined, fallback: number): number {
  const candidates = (durations ?? []).filter((value) => Number.isFinite(value) && value > 0);
  if (candidates.length === 0) return fallback;
  return Math.max(...candidates);
}

function normalizeOptionValue<T extends string | number>(
  requested: T | undefined,
  allowed: T[] | undefined,
  fallback: T,
): T {
  return requested !== undefined && (allowed ?? []).includes(requested) ? requested : fallback;
}

function preferredOptionValue<T extends string | number>(
  requested: T | undefined,
  allowed: T[] | undefined,
  fallback: T,
): T {
  const options = allowed ?? [];
  if (requested !== undefined && options.includes(requested)) return requested;
  if (options.includes(fallback)) return fallback;
  return options[0] ?? fallback;
}

function parseExplicitDimension(prompt: string): string | undefined {
  const match = prompt.match(/(\d{3,4})\s*[xX×]\s*(\d{3,4})/);
  return match ? `${match[1]}x${match[2]}` : undefined;
}

function parseImageSizeHint(prompt: string, allowedSizes: string[], fallback: string): string | undefined {
  const explicit = parseExplicitDimension(prompt);
  if (explicit && allowedSizes.includes(explicit)) return explicit;
  if (/(?:4k|超清|最高|最大|最强)/i.test(prompt)) {
    return strongestSize(allowedSizes, fallback);
  }
  if (/(?:2k|高清)/i.test(prompt)) {
    return allowedSizes.includes('2048x2048') ? '2048x2048' : undefined;
  }
  if (/(?:1k|普通)/i.test(prompt)) {
    return allowedSizes.includes('1024x1024') ? '1024x1024' : undefined;
  }
  return undefined;
}

function parseImageQualityHint(prompt: string, allowedQualities: string[], fallback: string): string | undefined {
  if (/(?:high|高清|高质量|最高|最强|精细)/i.test(prompt)) return normalizeOptionValue('high', allowedQualities, fallback);
  if (/(?:medium|标准|中等)/i.test(prompt)) return normalizeOptionValue('medium', allowedQualities, fallback);
  if (/(?:low|草稿|低)/i.test(prompt)) return normalizeOptionValue('low', allowedQualities, fallback);
  return undefined;
}

function parseVideoSizeHint(prompt: string, allowedSizes: string[], fallback: string): string | undefined {
  const explicit = parseExplicitDimension(prompt);
  if (explicit && allowedSizes.includes(explicit)) return explicit;
  if (/(?:9\s*:\s*16|竖屏|竖版|portrait|vertical)/i.test(prompt)) {
    return allowedSizes.find((size) => {
      const match = size.match(/^(\d+)x(\d+)$/);
      return match ? Number(match[2]) > Number(match[1]) : false;
    });
  }
  if (/(?:16\s*:\s*9|横屏|横版|landscape|wide)/i.test(prompt)) {
    return allowedSizes.find((size) => {
      const match = size.match(/^(\d+)x(\d+)$/);
      return match ? Number(match[1]) > Number(match[2]) : false;
    });
  }
  if (/(?:1\s*:\s*1|方形|正方形|square)/i.test(prompt)) {
    return allowedSizes.find((size) => {
      const match = size.match(/^(\d+)x(\d+)$/);
      return match ? Number(match[1]) === Number(match[2]) : false;
    });
  }
  if (/(?:最高|最大|最强)/i.test(prompt)) {
    return strongestSize(allowedSizes, fallback);
  }
  return undefined;
}

function parseVideoDurationHint(prompt: string, allowedDurations: number[], fallback: number): number | undefined {
  const match = prompt.match(/(\d{1,2})\s*(?:秒|s|sec|secs|second|seconds)/i);
  if (!match) return undefined;
  const requested = Number(match[1]);
  return normalizeOptionValue(requested, allowedDurations, fallback);
}

function resolveDefaultChatImageOptions(): ChatImageSendOptions {
  const options = useClientConfigStore.getState().modelOptions.image;
  const model = options.models.find((entry) => entry.id === options.defaultModel) ?? options.models[0];
  const size = preferredOptionValue(model?.defaultSize ?? options.defaultSize, model?.sizes, options.defaultSize);
  const quality = preferredOptionValue(model?.defaultQuality ?? options.defaultQuality, model?.qualities, options.defaultQuality);
  return {
    model: model?.id ?? options.defaultModel,
    size,
    quality,
  };
}

function resolveDefaultChatVideoOptions(hasSourceImage = false): ChatVideoSendOptions {
  const options = useClientConfigStore.getState().modelOptions.video;
  const model = hasSourceImage
    ? options.models.find((entry) => entry.requiresImage) ?? options.models.find((entry) => entry.id === options.defaultModel) ?? options.models[0]
    : options.models.find((entry) => entry.id === options.defaultModel) ?? options.models[0];
  const size = strongestSize(model?.sizes, model?.defaultSize ?? options.defaultSize);
  const durationSeconds = strongestDuration(model?.durations, model?.defaultDurationSeconds ?? options.defaultDurationSeconds);
  return {
    model: model?.id ?? options.defaultModel,
    size: model?.sizes.includes(size) ? size : options.defaultSize,
    durationSeconds: model?.durations.includes(durationSeconds) ? durationSeconds : options.defaultDurationSeconds,
  };
}

function resolveChatImageOptions(prompt: string, overrides?: ChatImageSendOptions): ChatImageSendOptions {
  const base = { ...resolveDefaultChatImageOptions(), ...overrides };
  const options = useClientConfigStore.getState().modelOptions.image;
  const model = options.models.find((entry) => entry.id === base.model) ?? options.models.find((entry) => entry.id === options.defaultModel) ?? options.models[0];
  const sizes = model?.sizes ?? [];
  const qualities = model?.qualities ?? [];
  const strongest = resolveDefaultChatImageOptions();
  const requestedSize = parseImageSizeHint(prompt, sizes, strongest.size);
  const requestedQuality = parseImageQualityHint(prompt, qualities, strongest.quality);
  return {
    model: model?.id ?? base.model,
    size: normalizeOptionValue(requestedSize, sizes, base.size),
    quality: normalizeOptionValue(requestedQuality, qualities, base.quality) as ChatImageSendOptions['quality'],
  };
}

function resolveChatVideoOptions(
  prompt: string,
  hasSourceImage: boolean,
  overrides?: ChatVideoSendOptions,
): ChatVideoSendOptions {
  const base = { ...resolveDefaultChatVideoOptions(hasSourceImage), ...overrides };
  const options = useClientConfigStore.getState().modelOptions.video;
  const model = options.models.find((entry) => entry.id === base.model) ?? options.models.find((entry) => entry.id === options.defaultModel) ?? options.models[0];
  const sizes = model?.sizes ?? [];
  const durations = model?.durations ?? [];
  const strongest = resolveDefaultChatVideoOptions(hasSourceImage);
  const requestedSize = parseVideoSizeHint(prompt, sizes, strongest.size);
  const requestedDuration = parseVideoDurationHint(prompt, durations, strongest.durationSeconds);
  return {
    model: model?.id ?? base.model,
    size: normalizeOptionValue(requestedSize, sizes, base.size),
    durationSeconds: normalizeOptionValue(requestedDuration, durations, base.durationSeconds),
  };
}

function buildGatewayTurnPreferences(params: {
  mode: ChatSendMode;
  prompt: string;
  hasSourceImage: boolean;
  imageOptions?: ChatImageSendOptions;
  videoOptions?: ChatVideoSendOptions;
  selectedArtifacts?: PendingImageInput[];
}): GatewayTurnPreferences {
  const selectedArtifacts = (params.selectedArtifacts ?? []).map((artifact) => ({
    filePath: artifact.stagedPath,
    mimeType: artifact.mimeType,
    title: artifact.fileName,
  }));
  if (params.mode === 'image') {
    const image = resolveChatImageOptions(params.prompt, params.imageOptions);
    return {
      mode: 'image',
      image: {
        model: image.model,
        size: image.size,
        quality: image.quality === 'low' || image.quality === 'medium' || image.quality === 'high'
          ? image.quality
          : undefined,
      },
      ...(selectedArtifacts.length > 0 ? { selectedArtifacts } : {}),
    };
  }
  if (params.mode === 'video') {
    return {
      mode: 'video',
      video: resolveChatVideoOptions(params.prompt, params.hasSourceImage, params.videoOptions),
      ...(selectedArtifacts.length > 0 ? { selectedArtifacts } : {}),
    };
  }
  return selectedArtifacts.length > 0
    ? { mode: 'chat', selectedArtifacts }
    : { mode: 'chat' };
}

function historicalRunIdFromKey(sessionKey: string, key: string | number): string {
  return `history:${sessionKey}:${key}`;
}

function historicalTimestampKeys(timestamp: number | undefined): Array<string | number> {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return [];
  const keys: Array<string | number> = [timestamp];
  const timestampMs = toMs(timestamp);
  if (timestampMs !== timestamp) keys.push(timestampMs);
  return keys;
}

function buildHistoricalRunIds(sessionKey: string, triggerMessage: RawMessage, index: number): string[] {
  const keys: Array<string | number> = [
    ...(triggerMessage.id ? [triggerMessage.id] : []),
    ...historicalTimestampKeys(triggerMessage.timestamp),
    index,
  ];
  const seen = new Set<string>();
  return keys
    .map((key) => historicalRunIdFromKey(sessionKey, key))
    .filter((runId) => {
      if (seen.has(runId)) return false;
      seen.add(runId);
      return true;
    });
}

function buildHistoricalRunId(sessionKey: string, triggerMessage: RawMessage, index: number): string {
  return buildHistoricalRunIds(sessionKey, triggerMessage, index)[0] ?? historicalRunIdFromKey(sessionKey, index);
}

function inferHistoricalRunMode(artifactFiles: AttachedFileMeta[]): ChatSendMode {
  const mimeTypes = artifactFiles
    .map((file) => file.mimeType)
    .filter((mimeType): mimeType is string => Boolean(mimeType));
  if (mimeTypes.some((mimeType) => mimeType.startsWith('video/'))) return 'video';
  if (mimeTypes.length > 0 && mimeTypes.every((mimeType) => mimeType.startsWith('image/'))) return 'image';
  return 'chat';
}

function extractExplicitMessageArtifactFiles(
  message: RawMessage,
  inputAttachmentKeys: ReadonlySet<string>,
): AttachedFileMeta[] {
  const files: AttachedFileMeta[] = [];
  const text = getMessageText(message.content);
  if (!text) return files;

  const mediaRefs = extractMediaRefs(text);
  const mediaRefPaths = new Set(mediaRefs.map((ref) => ref.filePath));
  for (const ref of mediaRefs) {
    files.push(makeAttachedFile(ref, 'message-ref', 'output-delivery'));
  }
  for (const ref of extractRawFilePaths(text)) {
    if (mediaRefPaths.has(ref.filePath)) continue;
    const file = makeAttachedFile(ref, 'message-ref', 'output-delivery');
    const matchesInput = getAttachedFileNormalizedIdentityKeys(file).some((key) => inputAttachmentKeys.has(key));
    if (matchesInput && !hasExplicitMediaDeliveryDirective(text, ref.filePath)) continue;
    files.push(file);
  }
  return dedupeAttachedFiles(files);
}

function collectMessageAttachmentIdentityKeys(message: RawMessage): Set<string> {
  const keys = new Set<string>();
  const remember = (file: AttachedFileMeta): void => {
    for (const key of getAttachedFileNormalizedIdentityKeys(file)) keys.add(key);
  };
  for (const file of message._attachedFiles ?? []) remember(file);

  const text = getMessageText(message.content);
  const mediaRefs = extractMediaRefs(text);
  const mediaRefPaths = new Set(mediaRefs.map((ref) => ref.filePath));
  for (const ref of mediaRefs) remember(makeAttachedFile(ref, 'user-upload', 'input-reference'));
  for (const ref of extractRawFilePaths(text)) {
    if (!mediaRefPaths.has(ref.filePath)) remember(makeAttachedFile(ref, 'user-upload', 'input-reference'));
  }
  return keys;
}

function extractMessageArtifactFiles(
  message: RawMessage,
  inputAttachmentKeys: ReadonlySet<string> = new Set(),
): AttachedFileMeta[] {
  const explicitFiles = extractExplicitMessageArtifactFiles(message, inputAttachmentKeys);
  const explicitKeys = new Set(explicitFiles.flatMap(getAttachedFileNormalizedIdentityKeys));
  const carriedFiles = (message._attachedFiles ?? []).filter((file) => {
    if (file.disposition === 'input-reference' || file.source === 'user-upload') return false;
    const keys = getAttachedFileNormalizedIdentityKeys(file);
    if (!keys.some((key) => inputAttachmentKeys.has(key))) return true;
    if (file.source === 'gateway-media' || file.source === 'tool-result') return true;
    return keys.some((key) => explicitKeys.has(key));
  });
  return dedupeAttachedFiles([...carriedFiles, ...explicitFiles]);
}

function shouldDropMessageFromRuntimeReplay(message: RawMessage): boolean {
  if (isToolResultRole(message.role)) return false;
  if (hasPendingToolUse(message) || isToolOnlyMessage(message)) return false;
  return isInternalMessage(message);
}

function buildRuntimeReplayMessages(messages: RawMessage[]): RawMessage[] {
  return dedupeAssistantRepliesForDisplay(
    enrichWithCachedImages(
      messages.filter((message, index) => (
        !shouldDropMessageFromRuntimeReplay(message) || shouldRetainAssistantHistorySummary(messages, index)
      )),
    ),
  );
}

function stripHistoricalRunsForSession(
  runtimeRuns: ChatState['runtimeRuns'],
  sessionKey: string,
): ChatState['runtimeRuns'] {
  const historicalPrefix = `history:${sessionKey}:`;
  return Object.fromEntries(
    Object.entries(runtimeRuns).filter(([runId, run]) => (
      !(runId.startsWith(historicalPrefix)
        && run?.sessionKey === sessionKey
        && run.events.some((event) => event.producer === 'history'))
    )),
  );
}

function messageHasHistoricalToolResult(message: RawMessage): boolean {
  if (isToolResultRole(message.role)) return true;
  if (!Array.isArray(message.content)) return false;
  return (message.content as ContentBlock[]).some((block) => (
    block.type === 'tool_result' || block.type === 'toolResult'
  ));
}

function messageHasHistoricalToolActivity(message: RawMessage): boolean {
  if (message.role === 'assistant' && extractToolUse(message).length > 0) return true;
  return messageHasHistoricalToolResult(message);
}

function textMentionsBackgroundHeartbeat(value: unknown): boolean {
  if (typeof value === 'string') {
    return /(?:^|[\\/])HEARTBEAT\.md\b/i.test(value) || /\bheartbeat\b/i.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => textMentionsBackgroundHeartbeat(item));
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => textMentionsBackgroundHeartbeat(item));
  }
  return false;
}

function messageLooksLikeBackgroundHeartbeatToolActivity(message: RawMessage): boolean {
  if (message.role === 'assistant') {
    const toolUses = extractToolUse(message);
    return toolUses.length > 0 && toolUses.every((tool) => (
      tool.name.trim().toLowerCase() === 'read'
      && textMentionsBackgroundHeartbeat(tool.input)
    ));
  }
  if (messageHasHistoricalToolResult(message)) {
    return textMentionsBackgroundHeartbeat(message.details)
      || textMentionsBackgroundHeartbeat(getMessageText(message.content));
  }
  return false;
}

function segmentLooksLikeBackgroundHeartbeatRun(sessionKey: string, segment: RawMessage[]): boolean {
  if (!sessionKey.endsWith(':main') || segment.length === 0) return false;

  let sawHeartbeatActivity = false;
  for (const message of segment) {
    if (message.role === 'assistant' && extractToolUse(message).length > 0) {
      if (!messageLooksLikeBackgroundHeartbeatToolActivity(message)) return false;
      sawHeartbeatActivity = true;
      continue;
    }
    if (messageHasHistoricalToolResult(message)) {
      if (!messageLooksLikeBackgroundHeartbeatToolActivity(message)) return false;
      sawHeartbeatActivity = true;
      continue;
    }
    if (message.role === 'assistant' && messageHasDeliverableContent(message)) {
      return false;
    }
  }

  return sawHeartbeatActivity;
}

function looksLikeHistoricalAssistantResultSummary(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^(?:继续收尾[：:]|继续(?:执行|处理|推进)[：:])/u.test(trimmed)) return false;
  if (/^(?:图片(?:正在)?生成中|正在生成(?:图片|图像)|生成中)/i.test(trimmed)) return false;
  if (/稍等(片刻|一下)?/u.test(trimmed) && /(?:生成|制作|执行|处理)/u.test(trimmed)) return false;
  return /(?:已(?:经)?|可以|能(?:够)?|支持|完成|如下|包括|这里是|结果|文档|表格|演示文稿|PPT|Excel|图片|视频|文件|产物)/u.test(trimmed);
}

function shouldRetainAssistantHistorySummary(messages: RawMessage[], index: number): boolean {
  const message = messages[index];
  if (!message || message.role !== 'assistant') return false;
  if (!isInternalMessage(message)) return false;
  if (hasPendingToolUse(message) || isToolOnlyMessage(message)) return false;
  if (!messageHasDeliverableContent(message)) return false;

  const text = getMessageText(message.content).trim();
  if (!looksLikeHistoricalAssistantResultSummary(text)) return false;

  for (let offset = index - 1; offset >= 0; offset -= 1) {
    const previous = messages[offset];
    if (isRealUserBoundaryMessage(previous)) break;
    if (messageHasHistoricalToolActivity(previous)) {
      return true;
    }
  }

  return false;
}

function filterHistoryMessagesForUi(messages: RawMessage[]): RawMessage[] {
  return messages.filter((message, index) => (
    !shouldDropMessageFromHistory(message) || shouldRetainAssistantHistorySummary(messages, index)
  ));
}

function buildHistoricalProgressEvent(
  runId: string,
  sessionKey: string,
  ts: number,
  entry: Extract<ChatRuntimeEvent, { type: 'progress.update' }>['entry'],
): Extract<ChatRuntimeEvent, { type: 'progress.update' }> {
  return {
    contractVersion: 1,
    producer: 'history',
    runId,
    sessionKey,
    ts,
    type: 'progress.update',
    entry,
  };
}

function summarizeHistoricalToolCallId(
  toolCallId: string | undefined,
  toolName: string,
  message: RawMessage,
  segmentIndex: number,
  toolIndex: number,
): string {
  const normalized = toolCallId?.trim();
  if (normalized) return normalized;
  if (typeof message.id === 'string' && message.id.trim()) {
    return `${toolName || 'tool'}:${message.id.trim()}:${segmentIndex}:${toolIndex}`;
  }
  if (typeof message.timestamp === 'number') {
    return `${toolName || 'tool'}:${Math.floor(toMs(message.timestamp))}:${segmentIndex}:${toolIndex}`;
  }
  return `${toolName || 'tool'}:${segmentIndex}:${toolIndex}`;
}

function buildHistoricalToolCompletedEvents(
  message: RawMessage,
  runId: string,
  sessionKey: string,
  segmentIndex: number,
): Array<Extract<ChatRuntimeEvent, { type: 'tool.completed' }>> {
  const baseTs = message.timestamp ? toMs(message.timestamp) : Date.now();
  const events: Array<Extract<ChatRuntimeEvent, { type: 'tool.completed' }>> = [];

  const pushCompletedEvent = (
    toolCallId: string | undefined,
    toolName: string | undefined,
    result: unknown,
    meta: unknown,
    isError: boolean | undefined,
    offset: number,
  ) => {
    const name = (toolName || toolCallId || 'tool').trim() || 'tool';
    events.push({
      contractVersion: 1,
      producer: 'history',
      runId,
      sessionKey,
      ts: baseTs + offset,
      type: 'tool.completed',
      toolCallId: summarizeHistoricalToolCallId(toolCallId, name, message, segmentIndex, offset),
      name,
      result,
      meta,
      isError,
    });
  };

  if (isToolResultRole(message.role)) {
    const detailRecord = message.details && typeof message.details === 'object'
      ? message.details as Record<string, unknown>
      : undefined;
    const detailStatus = typeof detailRecord?.status === 'string' ? detailRecord.status.toLowerCase() : '';
    const contentText = getMessageText(message.content).trim();
    pushCompletedEvent(
      typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
      typeof message.toolName === 'string' ? message.toolName : undefined,
      contentText ? { summary: contentText } : undefined,
      detailRecord ?? message.details,
      message.isError === true || detailStatus === 'error' || detailStatus === 'failed',
      0,
    );
    return events;
  }

  if (!Array.isArray(message.content)) return events;
  let toolResultIndex = 0;
  for (const block of message.content as ContentBlock[]) {
    if (block.type !== 'tool_result' && block.type !== 'toolResult') continue;
    const contentText = getMessageText(block.content ?? block.text ?? '').trim();
    pushCompletedEvent(
      block.id,
      block.name,
      contentText ? { summary: contentText } : undefined,
      undefined,
      false,
      toolResultIndex,
    );
    toolResultIndex += 1;
  }
  return events;
}

function buildHistoricalToolRuntimeEventsFromSegment(params: {
  runId: string;
  sessionKey: string;
  objective: string;
  segment: RawMessage[];
  ts: number;
}): ChatRuntimeEvent[] {
  const openToolRun = segmentHasOpenToolRun(params.segment);
  const terminalAssistantError = [...params.segment].reverse().find((message) => (
    message.role === 'assistant'
    && (getMessageStopReason(message) === 'error' || isFailedAssistantTurnMessage(message))
  ));
  const terminalAssistantErrorMessage = terminalAssistantError
    ? (getMessageErrorMessage(terminalAssistantError)
      ?? (isFailedAssistantTurnMessage(terminalAssistantError)
        ? getMessageText(terminalAssistantError.content).trim()
        : undefined))
    : undefined;
  const lastToolActivityIndex = (() => {
    for (let index = params.segment.length - 1; index >= 0; index -= 1) {
      if (messageHasHistoricalToolActivity(params.segment[index]!)) return index;
    }
    return -1;
  })();
  if (lastToolActivityIndex < 0) return [];

  const events = buildRuntimeStartEvents(undefined, {
    runId: params.runId,
    sessionKey: params.sessionKey,
    objective: params.objective,
    mode: 'chat',
    ts: params.ts,
    producer: 'history',
  });

  for (let segmentIndex = 0; segmentIndex < params.segment.length; segmentIndex += 1) {
    const message = params.segment[segmentIndex]!;
    const baseTs = message.timestamp ? toMs(message.timestamp) : params.ts;

    if (
      message.role === 'assistant'
      && segmentIndex < lastToolActivityIndex
      && extractToolUse(message).length === 0
      && !messageHasHistoricalToolResult(message)
    ) {
      const segments = extractTextSegments(message).filter((segmentText) => {
        const trimmed = segmentText.trim();
        if (!trimmed) return false;
        if (isInternalAssistantReplyText(trimmed)) return false;
        if (isGeneratingStatusNarration(trimmed)) return false;
        if (isInternalProcessNarration(trimmed)) return false;
        return true;
      });
      segments.forEach((segmentText, textIndex) => {
        events.push(buildHistoricalProgressEvent(
          params.runId,
          params.sessionKey,
          baseTs + textIndex,
          {
            id: `history:progress:${segmentIndex}:${textIndex}`,
            kind: 'commentary',
            text: segmentText,
            source: 'history',
          },
        ));
      });
    }

    if (message.role === 'assistant') {
      const toolUses = extractToolUse(message);
      toolUses.forEach((tool, toolIndex) => {
        const toolCallId = summarizeHistoricalToolCallId(tool.id, tool.name, message, segmentIndex, toolIndex);
        events.push({
          contractVersion: 1,
          producer: 'history',
          runId: params.runId,
          sessionKey: params.sessionKey,
          ts: baseTs + toolIndex,
          type: 'tool.started',
          toolCallId,
          name: tool.name,
          args: tool.input,
        });
      });
    }

    events.push(...buildHistoricalToolCompletedEvents(
      message,
      params.runId,
      params.sessionKey,
      segmentIndex,
    ));
  }

  if (!openToolRun) {
    const endTs = params.segment.reduce((latest, message) => {
      const messageTs = message.timestamp ? toMs(message.timestamp) : latest;
      return Math.max(latest, messageTs);
    }, params.ts);
    events.push({
      contractVersion: 1,
      producer: 'history',
      runId: params.runId,
      sessionKey: params.sessionKey,
      ts: endTs,
      type: 'run.ended',
      status: terminalAssistantErrorMessage ? 'error' : 'completed',
      ...(terminalAssistantErrorMessage ? { error: terminalAssistantErrorMessage } : {}),
    });
  }

  return events;
}

function collectTerminalAsyncTaskEvidence(
  runtimeRuns: ChatState['runtimeRuns'],
  sessionKey: string,
): AsyncTaskEvidence[] {
  const evidenceByTask = new Map<string, AsyncTaskEvidence>();
  const remember = (evidence: AsyncTaskEvidence): void => {
    const existing = evidenceByTask.get(evidence.id);
    if (!existing || evidence.updatedAt >= existing.updatedAt) {
      evidenceByTask.set(evidence.id, { ...evidence });
    }
  };

  for (const run of Object.values(runtimeRuns)) {
    if (run.sessionKey !== sessionKey) continue;
    for (const evidence of Object.values(run.asyncTaskLedger ?? {})) {
      if (evidence.status !== 'pending') remember(evidence);
    }
    for (const task of run.tasks ?? []) {
      if (task.status !== 'completed' && task.status !== 'error' && task.status !== 'partial') continue;
      remember({
        id: `task:${task.taskId}`,
        taskId: task.taskId,
        childSessionKey: task.childSessionKey,
        status: task.status === 'completed' ? 'completed' : 'error',
        source: 'task-completion',
        updatedAt: task.updatedAt ?? task.endedAt ?? run.lastEventAt ?? Date.now(),
      });
    }
  }

  return [...evidenceByTask.values()];
}

function applyHistoricalRuntimeRunsFromMessages(
  runtimeRuns: ChatState['runtimeRuns'],
  sessionKey: string,
  messages: RawMessage[],
): ChatState['runtimeRuns'] {
  const terminalTaskEvidence = collectTerminalAsyncTaskEvidence(runtimeRuns, sessionKey);
  let nextRuns = stripHistoricalRunsForSession(runtimeRuns, sessionKey);
  for (let index = 0; index < messages.length; index += 1) {
    const trigger = messages[index];
    if (!trigger || !isRealUserBoundaryMessage(trigger)) continue;
    const nextUserIndex = messages.findIndex((message, candidateIndex) => (
      candidateIndex > index && isRealUserBoundaryMessage(message)
    ));
    const segmentEnd = nextUserIndex === -1 ? messages.length : nextUserIndex;
    const segment = messages.slice(index + 1, segmentEnd);
    if (segmentLooksLikeBackgroundHeartbeatRun(sessionKey, segment)) continue;
    const inputAttachmentKeys = collectMessageAttachmentIdentityKeys(trigger);
    const artifactFiles = segment
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => extractMessageArtifactFiles(message, inputAttachmentKeys));
    const uniqueArtifactFiles = dedupeAttachedFiles(artifactFiles);
    const objective = getMessageText(trigger.content).trim();
    const ts = trigger.timestamp ? toMs(trigger.timestamp) : Date.now();
    const runId = buildHistoricalRunId(sessionKey, trigger, index);
    const historicalAsyncEvidence = segment.flatMap((message) => extractAsyncTaskEvidence(message));
    if (uniqueArtifactFiles.length === 0) {
      const historicalToolEvents = buildHistoricalToolRuntimeEventsFromSegment({
        runId,
        sessionKey,
        objective,
        segment,
        ts,
      });
      if (historicalToolEvents.length === 0) continue;
      nextRuns = applyRuntimeContractEvents(nextRuns, historicalToolEvents);
      nextRuns = applyAsyncTaskEvidenceToRuns(nextRuns, runId, historicalAsyncEvidence, sessionKey);
      continue;
    }

    const mode = inferHistoricalRunMode(uniqueArtifactFiles);
    const historicalToolEvents = buildHistoricalToolRuntimeEventsFromSegment({
      runId,
      sessionKey,
      objective,
      segment,
      ts,
    }).filter((event) => event.type !== 'run.started' && event.type !== 'run.ended');
    const startEvents = buildRuntimeStartEvents(undefined, {
      runId,
      sessionKey,
      objective,
      mode,
      ts,
      producer: 'history',
    });
    const artifactEvents = buildRuntimeArtifactEventsFromAttachedFiles({
      runId,
      sessionKey,
      ts,
      producer: 'history',
      verificationDetail: '从历史消息产物卡片恢复的产物。',
    }, uniqueArtifactFiles);
    nextRuns = applyRuntimeContractEvents(nextRuns, [
      ...startEvents,
      ...historicalToolEvents,
      ...artifactEvents,
      {
        contractVersion: 1,
        producer: 'history',
        runId,
        sessionKey,
        ts,
        type: 'run.ended',
        status: 'completed',
      },
    ]);
    nextRuns = applyAsyncTaskEvidenceToRuns(nextRuns, runId, historicalAsyncEvidence, sessionKey);
  }
  return applyAsyncTaskEvidenceToRuns(
    nextRuns,
    null,
    terminalTaskEvidence,
    sessionKey,
  );
}

function applyActiveRunArtifactEvidenceFromHistory(
  runtimeRuns: ChatState['runtimeRuns'],
  params: {
    runId: string | null;
    sessionKey: string;
    messages: RawMessage[];
    lastUserMessageAt: number | null;
  },
): ChatState['runtimeRuns'] {
  if (!params.runId || params.lastUserMessageAt == null || !runtimeRuns[params.runId]) return runtimeRuns;
  const segment = getOpenRunSegmentFromHistory(params.messages, params.lastUserMessageAt);
  const inputAttachmentKeys = collectMessageAttachmentIdentityKeys(
    findLastRealUserMessage(params.messages) ?? { role: 'user', content: '' },
  );
  const files = dedupeAttachedFiles(
    segment
      .filter((message) => message.role === 'assistant' && !hasPendingToolUse(message))
      .flatMap((message) => extractMessageArtifactFiles(message, inputAttachmentKeys)),
  );
  if (files.length === 0) return runtimeRuns;

  const ts = Date.now();
  const artifactEvents = buildRuntimeArtifactEventsFromAttachedFiles({
    runId: params.runId,
    sessionKey: params.sessionKey,
    ts,
    producer: 'history',
    verificationDetail: '从当前轮持久化最终回复回填的产物。',
  }, files);
  const artifacts = artifactEvents
    .filter((event): event is Extract<ChatRuntimeEvent, { type: 'artifact.produced' }> => (
      event.type === 'artifact.produced'
    ))
    .map((event) => event.artifact);
  const verificationEvents = artifacts.map((artifact) => buildRuntimeArtifactVerificationEvent({
    runId: params.runId!,
    sessionKey: params.sessionKey,
    ts,
    producer: 'history',
  }, {
    artifact,
    status: 'passed',
    kind: 'artifact.availability',
    required: true,
    severity: 'info',
    detail: '当前轮最终回复已持久化该产物引用。',
    evidence: artifact.filePath ?? artifact.url,
  }));
  return applyRuntimeContractEvents(runtimeRuns, [...artifactEvents, ...verificationEvents]);
}

/** Normalize a timestamp to milliseconds. Handles both seconds and ms. */
function toMs(ts: number): number {
  // Timestamps < 1e12 are in seconds (before ~2033); >= 1e12 are milliseconds
  return ts < 1e12 ? ts * 1000 : ts;
}

function optionalToMs(ts: number | undefined | null): number | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  return toMs(ts);
}

function getRuntimeEventTimestampMs(event: ChatRuntimeEvent): number | null {
  const direct = optionalToMs(event.ts);
  if (direct != null) return direct;
  if (event.type === 'run.started') return optionalToMs(event.startedAt);
  if (event.type === 'run.ended') return optionalToMs(event.endedAt);
  return null;
}

function getRuntimeRunFirstEventMs(run: ChatState['runtimeRuns'][string] | undefined): number | null {
  if (!run) return null;
  const startedAt = optionalToMs(run.startedAt);
  const eventTimes = run.events
    .map(getRuntimeEventTimestampMs)
    .filter((value): value is number => value != null);
  const firstEventAt = eventTimes.length > 0 ? Math.min(...eventTimes) : null;
  if (startedAt == null) return firstEventAt;
  if (firstEventAt == null) return startedAt;
  return Math.min(startedAt, firstEventAt);
}

const ACTIVE_TURN_BOUNDARY_SKEW_MS = 5_000;

function runtimeRunStartedBeforeActiveTurn(
  state: Pick<ChatState, 'activeRunId' | 'lastUserMessageAt' | 'runtimeRuns'>,
  runId: string,
): boolean {
  if (state.activeRunId === runId) return false;
  const activeRunStartMs = state.activeRunId
    ? getRuntimeRunFirstEventMs(state.runtimeRuns[state.activeRunId])
    : null;
  const boundaryMs = activeRunStartMs ?? optionalToMs(state.lastUserMessageAt);
  const candidateRunStartMs = getRuntimeRunFirstEventMs(state.runtimeRuns[runId]);
  return boundaryMs != null
    && candidateRunStartMs != null
    && candidateRunStartMs < boundaryMs - ACTIVE_TURN_BOUNDARY_SKEW_MS;
}

function runtimeEventBelongsToActiveTurn(
  state: Pick<ChatState, 'currentSessionKey' | 'sending' | 'activeRunId' | 'pendingFinal' | 'lastUserMessageAt' | 'runtimeRuns'>,
  event: ChatRuntimeEvent,
  eventSessionKey: string | null,
): boolean {
  if (!eventSessionKey || eventSessionKey !== state.currentSessionKey) return false;
  if (!state.sending && state.activeRunId == null && !state.pendingFinal) return false;
  if (state.activeRunId && event.runId === state.activeRunId) return true;
  if (runtimeRunStartedBeforeActiveTurn(state, event.runId)) return false;

  const activeRunStartMs = state.activeRunId
    ? getRuntimeRunFirstEventMs(state.runtimeRuns[state.activeRunId])
    : null;
  const userTurnStartMs = optionalToMs(state.lastUserMessageAt);
  const boundaryMs = activeRunStartMs ?? userTurnStartMs;
  if (boundaryMs == null) return false;

  const eventMs = getRuntimeEventTimestampMs(event)
    ?? getRuntimeRunFirstEventMs(state.runtimeRuns[event.runId]);
  if (eventMs == null) return false;
  return eventMs >= boundaryMs - ACTIVE_TURN_BOUNDARY_SKEW_MS;
}

// Timer for fallback history polling during active sends.
// If no streaming events arrive within a few seconds, we periodically
// poll chat.history to surface intermediate tool-call turns.
let _historyPollTimer: ReturnType<typeof setTimeout> | null = null;

// Timer for delayed error finalization. When the Gateway reports a mid-stream
// error (e.g. "terminated"), it may retry internally and recover. We wait
// before committing the error to give the recovery path a chance.
let _errorRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let _loadSessionsInFlight: Promise<void> | null = null;
let _lastLoadSessionsAt = 0;
const _historyLoadInFlight = new Map<string, Promise<void>>();
const _lastHistoryLoadAtBySession = new Map<string, number>();
const _forceNextHistoryLoadBySession = new Set<string>();
const _foregroundHistoryLoadSeen = new Set<string>();
const _sessionHistoryCache = new Map<string, { messages: RawMessage[]; thinkingLevel: string | null }>();
const _historyLoadGenerationBySession = new Map<string, number>();
let _historyLoadGenerationCounter = 0;
let _deferredHistoryLoadTimer: ReturnType<typeof setTimeout> | null = null;
const _sessionsNeedingTerminalHistoryRefresh = new Set<string>();
const _pendingLocalSessionKeys = new Set<string>();
const _sessionCwdMutations = new Map<string, Promise<void>>();

type SessionRunState = Pick<
  ChatState,
  | 'sending'
  | 'pendingImageGenerationLocal'
  | 'pendingVideoGenerationLocal'
  | 'activeRunId'
  | 'pendingFinal'
  | 'lastUserMessageAt'
  | 'streamingText'
  | 'streamingMessage'
  | 'streamingTools'
  | 'pendingToolImages'
>;

const DEFAULT_SESSION_RUN_STATE: SessionRunState = {
  sending: false,
  pendingImageGenerationLocal: false,
  pendingVideoGenerationLocal: false,
  activeRunId: null,
  pendingFinal: false,
  lastUserMessageAt: null,
  streamingText: '',
  streamingMessage: null,
  streamingTools: [],
  pendingToolImages: [],
};

const _sessionRunStateCache = new Map<string, SessionRunState>();
let _sendGenerationCounter = 0;
const _activeSendGenerationBySession = new Map<string, number>();

function activeSendGenerationMatches(sessionKey: string, sendGeneration: number): boolean {
  return _activeSendGenerationBySession.get(sessionKey) === sendGeneration;
}

type PendingRuntimeIntent = {
  objective?: string;
  mode: ChatSendMode;
  createdAt: number;
};
const _pendingRuntimeIntentBySession = new Map<string, PendingRuntimeIntent>();
const _runtimeArtifactVerificationInFlight = new Set<string>();
type WithheldFinalDelivery = {
  runId: string;
  sessionKey: string;
  message: RawMessage;
};
const _withheldFinalDeliveryByRun = new Map<string, WithheldFinalDelivery>();
type QueuedChatSend = {
  text: string;
  attachments?: ChatSendAttachment[];
  targetAgentId?: string | null;
  mode: ChatSendMode;
  imageOptions?: ChatImageSendOptions;
  videoOptions?: ChatVideoSendOptions;
  enqueuedAt: number;
};
const MAX_QUEUED_SENDS_PER_SESSION = 20;
const _queuedChatSendsBySession = new Map<string, QueuedChatSend[]>();
const _queuedChatSendFlushScheduled = new Set<string>();
const _sessionsCancelling = new Set<string>();
const _sessionsAwaitingBackendIdle = new Set<string>();
const _sessionBackendIdleSettlementGeneration = new Map<string, number>();
const _runtimeBackendIdleProbeGeneration = new Map<string, number>();
const _lastAttemptedChatSendBySession = new Map<string, QueuedChatSend>();

function shouldHoldActiveRunForPendingTasks(): boolean {
  const currentState = useChatStore.getState();
  const activeRun = currentState.activeRunId
    ? currentState.runtimeRuns[currentState.activeRunId]
    : undefined;
  return runtimeRunHasPendingAsyncTasks(activeRun);
}
const SESSION_LOAD_MIN_INTERVAL_MS = 1_200;
const SESSION_LABEL_HYDRATION_BATCH_SIZE = 40;
const HISTORY_LOAD_MIN_INTERVAL_MS = 800;
const CHAT_EVENT_DEDUPE_TTL_MS = 30_000;
const HISTORY_PAGE_SIZE = 100;
const HISTORY_MAX_RENDERED_MESSAGES = 500;
const SESSION_SWITCH_RESTORE_MESSAGE_LIMIT = 24;
const PREVIEW_HYDRATION_MESSAGE_LIMIT = 80;
const SESSION_HISTORY_CACHE_MAX_SESSIONS = 16;
const SESSION_RUN_STATE_CACHE_MAX_SESSIONS = 32;
const _chatEventDedupe = new Map<string, number>();
const OPTIMISTIC_USER_MESSAGE_TTL_MS = 30 * 60 * 1000;
/** Max skew between the renderer optimistic send time and Gateway transcript timestamps. */
const OPTIMISTIC_USER_TIMESTAMP_MATCH_MS = 120_000;
/** Grace period before surfacing mid-run Gateway errors that often self-recover. */
const ERROR_RECOVERY_DELAY_MS = 12_000;
/** OpenClaw LLM idle timeout before an internal retry. */
const LLM_IDLE_HINT_MS = 120_000;
/** Wait past one LLM idle window before declaring a hard no-response failure. */
const NO_RESPONSE_SAFETY_TIMEOUT_MS = 130_000;
const SESSION_RENAME_DEDUPE_TTL_MS = 60_000;
const INTERNAL_TEMPORARY_SESSION_PATTERNS = [
  /^agent:main:uclaw-profile-[A-Za-z0-9_-]+/,
];

type PendingOptimisticUserMessage = {
  message: RawMessage;
  timestampMs: number;
  createdAtMs: number;
};

function isInternalTemporarySessionKey(sessionKey: string): boolean {
  return INTERNAL_TEMPORARY_SESSION_PATTERNS.some((pattern) => pattern.test(sessionKey));
}

const _pendingOptimisticUserMessages = new Map<string, PendingOptimisticUserMessage[]>();
const _sessionRenameInFlight = new Map<string, Promise<void>>();
const _sessionRenameLastPersisted = new Map<string, { label: string; at: number }>();

type SessionLabelSummary = {
  sessionKey: string;
  firstUserText: string | null;
  lastTimestamp: number | null;
};

function getSessionLabelHydrationActivityMs(
  session: ChatSession,
  sessionLastActivity: Record<string, number>,
): number {
  const localActivity = sessionLastActivity[session.key];
  if (typeof localActivity === 'number' && Number.isFinite(localActivity)) {
    return localActivity;
  }
  return typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)
    ? session.updatedAt
    : 0;
}

function getSessionBackendLabel(session: ChatSession): string {
  return toSessionLabel(session.label || session.derivedTitle || '');
}

function applySessionBackendLabels(set: ChatSet, sessions: ChatSession[]): void {
  const labels = Object.fromEntries(
    sessions
      .filter((session) => !session.key.endsWith(':main'))
      .map((session) => [session.key, getSessionBackendLabel(session)] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  if (Object.keys(labels).length === 0) return;
  set((state) => ({
    sessionLabels: {
      ...state.sessionLabels,
      ...Object.fromEntries(
        Object.entries(labels).filter(([key]) => !state.sessionLabels[key]),
      ),
    },
  }));
}

async function persistSessionRenameOnce(key: string, label: string): Promise<void> {
  const cacheKey = `${key}\n${label}`;
  const now = Date.now();
  const recent = _sessionRenameLastPersisted.get(key);
  if (recent?.label === label && now - recent.at < SESSION_RENAME_DEDUPE_TTL_MS) {
    return;
  }

  const existing = _sessionRenameInFlight.get(cacheKey);
  if (existing) {
    await existing;
    return;
  }

  const promise = (async () => {
    const result = await hostApiFetch<{
      success: boolean;
      error?: string;
    }>('/api/sessions/rename', {
      method: 'POST',
      body: JSON.stringify({ sessionKey: key, label }),
    });
    if (!result.success) {
      throw new Error(result.error || 'Failed to rename session');
    }
    _sessionRenameLastPersisted.set(key, { label, at: Date.now() });
  })().finally(() => {
    _sessionRenameInFlight.delete(cacheKey);
  });

  _sessionRenameInFlight.set(cacheKey, promise);
  await promise;
}

async function fetchSessionLabelSummaries(sessionKeys: string[]): Promise<SessionLabelSummary[]> {
  if (sessionKeys.length === 0) return [];
  const response = await hostApiFetch<{
    success?: boolean;
    summaries?: SessionLabelSummary[];
  }>('/api/sessions/summaries', {
    method: 'POST',
    body: JSON.stringify({ sessionKeys }),
  });
  return Array.isArray(response?.summaries) ? response.summaries : [];
}

function applySessionLabelSummaries(
  set: ChatSet,
  summaries: SessionLabelSummary[],
): void {
  if (summaries.length === 0) return;
  set((state) => {
    let nextLabels = state.sessionLabels;
    let nextActivity = state.sessionLastActivity;
    let changed = false;

    for (const summary of summaries) {
      const labelText = toSessionLabel(summary.firstUserText || '');
      // Only auto-hydrate missing labels. Existing entries include user renames
      // and must not be overwritten by transcript-derived titles.
      const existingLabel = nextLabels[summary.sessionKey]?.trim();
      if (labelText && !existingLabel) {
        if (nextLabels === state.sessionLabels) {
          nextLabels = { ...state.sessionLabels };
        }
        nextLabels[summary.sessionKey] = labelText;
        changed = true;
      }

      if (typeof summary.lastTimestamp === 'number' && Number.isFinite(summary.lastTimestamp)) {
        if (nextActivity[summary.sessionKey] !== summary.lastTimestamp) {
          if (nextActivity === state.sessionLastActivity) {
            nextActivity = { ...state.sessionLastActivity };
          }
          nextActivity[summary.sessionKey] = summary.lastTimestamp;
          changed = true;
        }
      }
    }

    return changed
      ? {
        sessionLabels: nextLabels,
        sessionLastActivity: nextActivity,
      }
      : {};
  });
}

async function refreshVisibleSessionSummaries(
  set: ChatSet,
  get: ChatGet,
  sessionKeys?: string[],
): Promise<void> {
  const sessions = get().sessions;
  const currentSessionKey = get().currentSessionKey;
  const knownSessionKeys = new Set(sessions.map((session) => session.key));
  const targetKeys = (sessionKeys && sessionKeys.length > 0
    ? sessionKeys
    : sessions.map((session) => session.key)
  )
    .filter((key) => key && !key.endsWith(':main') && key !== currentSessionKey);
  if (targetKeys.length === 0) return;

  try {
    const summaries = await fetchSessionLabelSummaries(targetKeys);
    const currentKnownSessionKeys = new Set(get().sessions.map((session) => session.key));
    applySessionLabelSummaries(
      set,
      summaries.filter((summary) => (
        knownSessionKeys.has(summary.sessionKey)
        && currentKnownSessionKeys.has(summary.sessionKey)
      )),
    );
  } catch (error) {
    console.warn('[session summaries] refresh failed:', error);
  }
}

function cleanSessionLabelText(text: string): string {
  return text
    .replace(/^Sender\s*\([^)]*\)\s*:\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
    .replace(/^Sender\s*\([^)]*\)\s*:\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/^Sender\s*\([^)]*\)\s*:\s*[^\n]*(?:\n\s*)*/i, '')
    .replace(/^Sender\s*:\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
    .replace(/^Sender\s*:\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/^Sender\s*:\s*[^\n]*(?:\n\s*)*/i, '')
    .replace(/^```json\n[\s\S]*?```\s*/i, '')
    .replace(/^\{[\s\S]*?\}\s*/i, '')
    .replace(/\s*\[media attached:[^\]]*\]/g, '')
    .replace(/\s*\[message_id:\s*[^\]]+\]/g, '')
    .replace(/^Conversation info\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
    .replace(/^Conversation info\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\]]+\]\s*/i, '')
    .trim();
}

function toSessionLabel(text: string, maxLength = 50): string {
  const cleaned = cleanSessionLabelText(text).trim();
  if (!cleaned) return '';
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadLocalHistoryFallback(
  sessionKey: string,
  limit = HISTORY_PAGE_SIZE,
  options: { timeoutMs?: number; logTimeout?: boolean } = {},
): Promise<RawMessage[]> {
  const fallbackPromise = isCronSessionKey(sessionKey)
    ? loadCronFallbackMessages(sessionKey, limit)
    : loadSessionTranscriptFallback(sessionKey, limit);
  const timeoutMs = options.timeoutMs ?? CHAT_HISTORY_DISK_FALLBACK_TIMEOUT_MS;
  if (timeoutMs <= 0) {
    return [];
  }
  return withTimeout(fallbackPromise, timeoutMs).catch((error) => {
    if (options.logTimeout !== false) {
      console.warn('[chat.history] local fallback timed out:', error);
    }
    return [];
  });
}

function clearErrorRecoveryTimer(): void {
  if (_errorRecoveryTimer) {
    clearTimeout(_errorRecoveryTimer);
    _errorRecoveryTimer = null;
  }
}

function isRecoverableRuntimeError(errorMessage: string): boolean {
  const normalized = errorMessage.trim().toLowerCase();
  if (!normalized) return false;
  return /\bterminated\b/.test(normalized)
    || /\baborted\b/.test(normalized)
    || normalized.includes('econnreset')
    || normalized.includes('connection reset');
}

function isReplySessionInitializationConflictError(errorMessage: string): boolean {
  const normalized = errorMessage.trim().toLowerCase();
  return normalized.includes('reply session initialization conflicted')
    || (
      normalized.includes('reply session')
      && normalized.includes('initialization')
      && (normalized.includes('conflict') || normalized.includes('conflicted'))
    );
}

function normalizeChatRunErrorMessage(errorMessage: string): string {
  const normalized = errorMessage.trim();
  const lower = normalized.toLowerCase();
  if (!normalized) return 'The task ended without a model response. Please retry.';
  if (isReplySessionInitializationConflictError(normalized)) {
    return 'UClaw hit a reply session handoff conflict while the previous turn was still settling. The conversation was refreshed; retry this message.';
  }
  if (
    lower.includes('context overflow')
    || lower.includes('prompt too large')
    || lower.includes('context size exceeds')
    || lower.includes('context length')
  ) {
    return 'The task context became too large for the model. Start a new conversation or ask UClaw to summarize and continue.';
  }
  if (
    lower.includes('non_deliverable_terminal_turn')
    || lower.includes('non-deliverable terminal')
  ) {
    return 'The task reached a terminal state but the final reply was not delivered. Refreshing the conversation history may show the result.';
  }
  return normalized;
}

function buildNoResponseSafetyMessage(): string {
  return 'The task has not produced new visible progress for a while. UClaw stopped waiting to keep the app responsive. Refresh the conversation or retry if the task did not finish.';
}

function scheduleRecoverableRuntimeError(commit: () => void): void {
  clearErrorRecoveryTimer();
  _errorRecoveryTimer = setTimeout(() => {
    _errorRecoveryTimer = null;
    commit();
  }, ERROR_RECOVERY_DELAY_MS);
}

function clearHistoryPoll(): void {
  if (_historyPollTimer) {
    clearTimeout(_historyPollTimer);
    _historyPollTimer = null;
  }
}

function nextHistoryLoadGeneration(sessionKey: string): number {
  _historyLoadGenerationCounter += 1;
  _historyLoadGenerationBySession.set(sessionKey, _historyLoadGenerationCounter);
  return _historyLoadGenerationCounter;
}

function isCurrentHistoryLoad(sessionKey: string, generation: number): boolean {
  return _historyLoadGenerationBySession.get(sessionKey) === generation;
}

function deferHistoryLoad(get: ChatGet, quiet = false): void {
  if (_deferredHistoryLoadTimer) {
    clearTimeout(_deferredHistoryLoadTimer);
  }
  _deferredHistoryLoadTimer = setTimeout(() => {
    _deferredHistoryLoadTimer = null;
    void get().loadHistory(quiet);
  }, 50);
}

function deferSessionSwitchHistoryLoad(get: ChatGet): void {
  if (_deferredHistoryLoadTimer) {
    clearTimeout(_deferredHistoryLoadTimer);
  }
  _deferredHistoryLoadTimer = setTimeout(() => {
    _deferredHistoryLoadTimer = null;
    void get().loadHistory(true);
  }, 120);
}

function chatRunLooksRecentlyActive(run: ChatState['runtimeRuns'][string], now = Date.now()): boolean {
  if (run.status !== 'running') return false;
  if (typeof run.lastEventAt === 'number' && Number.isFinite(run.lastEventAt)) {
    return now - toMs(run.lastEventAt) < LLM_IDLE_HINT_MS + NO_RESPONSE_SAFETY_TIMEOUT_MS;
  }
  const lastEventTs = run.events.reduce<number | null>((latest, event) => {
    const ts = typeof event.ts === 'number' ? toMs(event.ts) : null;
    if (ts == null || !Number.isFinite(ts)) return latest;
    return latest == null ? ts : Math.max(latest, ts);
  }, null);
  const activityTs = lastEventTs
    ?? (typeof run.startedAt === 'number' ? toMs(run.startedAt) : null);
  if (activityTs == null) return true;
  return now - activityTs < LLM_IDLE_HINT_MS + NO_RESPONSE_SAFETY_TIMEOUT_MS;
}

function hasRecentRuntimeActivityForSend(
  state: ChatState,
  sessionKey: string,
  now = Date.now(),
): boolean {
  return Object.values(state.runtimeRuns).some((run) => {
    if (!chatRunLooksRecentlyActive(run, now)) return false;
    if (state.activeRunId && run.runId === state.activeRunId) return true;
    return run.sessionKey === sessionKey;
  });
}

function inferSessionKeyForRun(
  state: Pick<ChatState, 'activeRunId' | 'currentSessionKey' | 'runtimeRuns'>,
  runId: string | null,
  explicitSessionKey: string | null,
): string | null {
  if (explicitSessionKey) return explicitSessionKey;
  if (!runId) return null;

  const runtimeSessionKey = state.runtimeRuns[runId]?.sessionKey;
  if (runtimeSessionKey) return runtimeSessionKey;

  if (state.activeRunId === runId) return state.currentSessionKey;

  for (const [sessionKey, runState] of _sessionRunStateCache.entries()) {
    if (runState.activeRunId === runId) return sessionKey;
  }

  return null;
}

function rememberPendingRuntimeIntent(sessionKey: string, intent: Omit<PendingRuntimeIntent, 'createdAt'>): void {
  _pendingRuntimeIntentBySession.set(sessionKey, {
    ...intent,
    objective: intent.objective?.trim() || undefined,
    createdAt: Date.now(),
  });
}

function getPendingRuntimeIntent(sessionKey: string | undefined | null): PendingRuntimeIntent | undefined {
  if (!sessionKey) return undefined;
  const intent = _pendingRuntimeIntentBySession.get(sessionKey);
  if (!intent) return undefined;
  if (Date.now() - intent.createdAt > NO_RESPONSE_SAFETY_TIMEOUT_MS + LLM_IDLE_HINT_MS) {
    _pendingRuntimeIntentBySession.delete(sessionKey);
    return undefined;
  }
  return intent;
}

function clearPendingRuntimeIntent(sessionKey: string | undefined | null): void {
  if (!sessionKey) return;
  _pendingRuntimeIntentBySession.delete(sessionKey);
}

function applyRuntimeContractEvents(
  currentRuns: ChatState['runtimeRuns'],
  events: ChatRuntimeEvent[],
): ChatState['runtimeRuns'] {
  if (events.length === 0) return currentRuns;
  let nextRuns = currentRuns;
  for (const event of events) {
    const appliedEvents: ChatRuntimeEvent[] = [];
    if (event.type === 'task.updated') {
      const applied = applyRuntimeTaskEventToOwners(nextRuns, event);
      nextRuns = applied.runtimeRuns;
      appliedEvents.push(...applied.appliedEvents);
    } else if (event.type === 'artifact.produced' || event.type === 'verification.completed') {
      const applied = applyCompletionWakeEvidenceEventToOwners(nextRuns, event);
      nextRuns = applied.runtimeRuns;
      appliedEvents.push(...applied.appliedEvents);
    } else {
      const previousRuns = nextRuns;
      nextRuns = applyRuntimeEventToRuns(nextRuns, event);
      if (nextRuns !== previousRuns) appliedEvents.push(event);
    }
    if (appliedEvents.length === 0) continue;
    if (event.type === 'task.updated') {
      const ledgerStatus = event.task.status === 'completed'
        ? 'completed'
        : event.task.status === 'error' || event.task.status === 'partial'
          ? 'error'
          : 'pending';
      nextRuns = applyAsyncTaskEvidenceToRuns(nextRuns, event.runId, [{
        id: `task:${event.task.taskId}`,
        taskId: event.task.taskId,
        runId: event.runId,
        childSessionKey: event.task.childSessionKey,
        status: ledgerStatus,
        source: ledgerStatus === 'pending' ? 'tool-result' : 'task-completion',
        updatedAt: event.task.updatedAt ?? event.ts ?? Date.now(),
      }], event.sessionKey);
    }
    for (const appliedEvent of appliedEvents) {
      if (appliedEvent.type === 'progress.update') continue;
      const progressEvents = buildRuntimeProgressEvents(nextRuns[appliedEvent.runId], appliedEvent);
      for (const progressEvent of progressEvents) {
        nextRuns = applyRuntimeEventToRuns(nextRuns, progressEvent);
      }
    }
  }
  return nextRuns;
}

function reevaluateWithheldFinalDelivery(runId: string): void {
  const withheld = _withheldFinalDeliveryByRun.get(runId);
  if (!withheld) {
    _withheldFinalDeliveryByRun.delete(runId);
    return;
  }

  let released = false;
  let controlsActiveLifecycle = false;
  useChatStore.setState((state) => {
    const run = state.runtimeRuns[runId];
    if (!run || runtimeRunHasPendingAsyncTasks(run)) return {};
    released = true;
    const isCurrentSession = state.currentSessionKey === withheld.sessionKey;
    controlsActiveLifecycle = isCurrentSession
      && (state.activeRunId === runId || (state.activeRunId == null && state.pendingFinal));
    const alreadyExists = state.messages.some((message) => message.id === withheld.message.id);
    return {
      ...(isCurrentSession && !alreadyExists
        ? { messages: [...state.messages, withheld.message] }
        : {}),
      ...(controlsActiveLifecycle
        ? {
            pendingFinal: true,
            streamingText: '',
            streamingMessage: null,
          }
        : {}),
    };
  });

  if (!released) return;
  _withheldFinalDeliveryByRun.delete(runId);
  if (controlsActiveLifecycle) beginSessionBackendIdleSettlement(withheld.sessionKey, runId);
  if (useChatStore.getState().currentSessionKey === withheld.sessionKey) {
    forceNextHistoryLoad(withheld.sessionKey);
    void useChatStore.getState().loadHistory(true);
  } else {
    markSessionNeedsTerminalHistoryRefresh(withheld.sessionKey);
  }
}

function scheduleWithheldFinalReevaluationForSession(sessionKey: string | null | undefined): void {
  queueMicrotask(() => {
    for (const withheld of _withheldFinalDeliveryByRun.values()) {
      if (sessionKey && withheld.sessionKey !== sessionKey) continue;
      reevaluateWithheldFinalDelivery(withheld.runId);
    }
  });
}

function buildRuntimeStartEventsForRun(
  runtimeRuns: ChatState['runtimeRuns'],
  params: {
    runId: string;
    sessionKey?: string;
    objective?: string;
    mode?: ChatSendMode;
    ts?: number;
    includeStarted?: boolean;
  },
): ChatRuntimeEvent[] {
  if (!params.runId) return [];
  const intent = getPendingRuntimeIntent(params.sessionKey);
  const objective = params.objective ?? intent?.objective;
  return buildRuntimeStartEvents(runtimeRuns[params.runId], {
    runId: params.runId,
    sessionKey: params.sessionKey,
    objective,
    mode: params.mode ?? intent?.mode,
    ts: params.ts,
    includeStarted: params.includeStarted,
  });
}

type ThumbnailVerificationResult = {
  preview: string | null;
  fileSize: number;
  filePath?: string;
  width?: number;
  height?: number;
};

function scheduleRuntimeArtifactVerification(
  runId: string,
  sessionKey: string | undefined,
  artifacts: ChatRuntimeArtifact[],
): void {
  const requests = artifacts
    .map((artifact) => {
      const filePath = artifact.filePath?.trim();
      const gatewayUrl = artifact.url?.startsWith('/api/chat/media/') ? artifact.url : undefined;
      if (!filePath && !gatewayUrl) return null;
      const key = `${runId}|${artifact.id}|${filePath ?? gatewayUrl}`;
      if (_runtimeArtifactVerificationInFlight.has(key)) return null;
      _runtimeArtifactVerificationInFlight.add(key);
      return {
        key,
        artifact,
        request: {
          filePath,
          gatewayUrl,
          mimeType: artifact.mimeType ?? 'application/octet-stream',
        },
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry != null);

  if (requests.length === 0) return;

  void hostApiFetch<Record<string, ThumbnailVerificationResult>>('/api/files/thumbnails', {
    method: 'POST',
    body: JSON.stringify({ paths: requests.map((entry) => entry.request) }),
  })
    .then((results) => {
      const events: ChatRuntimeEvent[] = [];
      const ts = Date.now();
      for (const entry of requests) {
        const resultKey = entry.request.filePath ?? entry.request.gatewayUrl ?? '';
        const result = resultKey ? results[resultKey] : undefined;
        const verifiedPath = result?.filePath ?? entry.artifact.filePath;
        const verifiedArtifact = result && result.fileSize > 0
          ? {
              ...entry.artifact,
              filePath: verifiedPath,
              sizeBytes: result.fileSize,
            }
          : entry.artifact;
        if (result && result.fileSize > 0) {
          events.push({
            runId,
            sessionKey,
            ts,
            type: 'artifact.produced',
            artifact: verifiedArtifact,
          });
        }
        events.push(buildRuntimeArtifactVerificationEvent({ runId, sessionKey, ts }, {
          artifact: verifiedArtifact,
          status: result && result.fileSize > 0 ? 'passed' : 'blocked',
          detail: result && result.fileSize > 0
            ? '本地文件存在性验证已通过。'
            : '没有在本地找到可读取的产物文件。',
          evidence: result && result.fileSize > 0
            ? `filePath=${verifiedPath ?? resultKey}; sizeBytes=${result.fileSize}`
            : resultKey,
        }));
      }

      if (events.length > 0) {
        useChatStore.setState((state) => ({
          runtimeRuns: applyRuntimeContractEvents(state.runtimeRuns, events),
        }));
        reevaluateWithheldFinalDelivery(runId);
      }
    })
    .catch((error) => {
      const ts = Date.now();
      const events = requests.map((entry) => buildRuntimeArtifactVerificationEvent({ runId, sessionKey, ts }, {
        artifact: entry.artifact,
        status: 'blocked',
        detail: '本地文件存在性验证请求失败。',
        evidence: error instanceof Error ? error.message : String(error),
      }));
      useChatStore.setState((state) => ({
        runtimeRuns: applyRuntimeContractEvents(state.runtimeRuns, events),
      }));
    })
    .finally(() => {
      for (const entry of requests) {
        _runtimeArtifactVerificationInFlight.delete(entry.key);
      }
    });
}

function clearActiveSendGeneration(sessionKey: string): void {
  _activeSendGenerationBySession.delete(sessionKey);
}

function markSessionRunIdle(sessionKey: string): void {
  _runtimeBackendIdleProbeGeneration.delete(sessionKey);
  clearActiveSendGeneration(sessionKey);
  captureSessionRunState(sessionKey, DEFAULT_SESSION_RUN_STATE);
  scheduleQueuedChatSendFlush(sessionKey);
}

function gatewaySessionIsIdle(data: Record<string, unknown>, sessionKey: string): boolean {
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const session = sessions.find((candidate) => (
    candidate != null
    && typeof candidate === 'object'
    && String((candidate as Record<string, unknown>).key ?? '') === sessionKey
  ));
  if (!session || typeof session !== 'object') return false;
  const row = session as Record<string, unknown>;
  if (row.hasActiveRun === true) return false;
  if (row.hasActiveRun === false) return true;
  return getSessionTerminalRuntimeStatus(parseSessionStatus(row.status)) != null;
}

function parseGatewaySessionProbe(data: Record<string, unknown>, sessionKey: string): ChatSession | undefined {
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const row = sessions.find((candidate) => (
    candidate != null
    && typeof candidate === 'object'
    && String((candidate as Record<string, unknown>).key ?? '') === sessionKey
  ));
  if (!row || typeof row !== 'object') return undefined;
  const record = row as Record<string, unknown>;
  return {
    key: sessionKey,
    updatedAt: parseSessionUpdatedAtMs(record.updatedAt),
    status: parseSessionStatus(record.status),
    hasActiveRun: typeof record.hasActiveRun === 'boolean' ? record.hasActiveRun : undefined,
  };
}

function mergeBackendSessionProbe(
  sessions: ChatSession[],
  session: ChatSession,
): ChatSession[] {
  let matched = false;
  const next = sessions.map((candidate) => {
    if (candidate.key !== session.key) return candidate;
    matched = true;
    return mergeSessionRowWithLocalState({ ...candidate, ...session }, candidate);
  });
  return matched ? next : [...next, session];
}

function scheduleRuntimeBackendIdleReconciliation(
  set: ChatSet,
  get: ChatGet,
  sessionKey: string,
  runId: string,
): void {
  const generation = (_runtimeBackendIdleProbeGeneration.get(sessionKey) ?? 0) + 1;
  _runtimeBackendIdleProbeGeneration.set(sessionKey, generation);

  void (async () => {
    const startedAt = Date.now();
    let delayMs = 0;
    while (
      _runtimeBackendIdleProbeGeneration.get(sessionKey) === generation
      && Date.now() - startedAt < 30_000
    ) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const latestBeforeProbe = get();
      if (latestBeforeProbe.currentSessionKey !== sessionKey) return;
      if (latestBeforeProbe.activeRunId != null && latestBeforeProbe.activeRunId !== runId) return;
      if (!latestBeforeProbe.sending && latestBeforeProbe.activeRunId == null && !latestBeforeProbe.pendingFinal) return;

      try {
        const data = await fetchChatSessionsList();
        const backendSession = parseGatewaySessionProbe(data, sessionKey);
        if (backendSession) {
          const latestSessions = mergeBackendSessionProbe(get().sessions, backendSession);
          set({ sessions: latestSessions });
          reconcileCurrentSessionLifecycleFromBackend(set, get, latestSessions);
          if (shouldTrustBackendSessionIdle(backendSession, get().lastUserMessageAt)) {
            _runtimeBackendIdleProbeGeneration.delete(sessionKey);
            return;
          }
        }
      } catch (error) {
        console.warn('[chat.runtime] backend idle probe failed', {
          sessionKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      delayMs = delayMs === 0 ? 50 : Math.min(1_000, Math.round(delayMs * 1.7));
    }

    if (_runtimeBackendIdleProbeGeneration.get(sessionKey) === generation) {
      _runtimeBackendIdleProbeGeneration.delete(sessionKey);
    }
  })();
}

/** Keeps the local controls active until OpenClaw confirms this session is idle. */
function beginSessionBackendIdleSettlement(sessionKey: string, expectedRunId?: string | null): void {
  const generation = (_sessionBackendIdleSettlementGeneration.get(sessionKey) ?? 0) + 1;
  _sessionBackendIdleSettlementGeneration.set(sessionKey, generation);
  _sessionsAwaitingBackendIdle.add(sessionKey);
  clearActiveSendGeneration(sessionKey);

  void (async () => {
    const startedAt = Date.now();
    let delayMs = 50;
    let backendConfirmedIdle = false;
    let confirmedSessions: ChatSession[] | null = null;
    while (
      _sessionBackendIdleSettlementGeneration.get(sessionKey) === generation
      && Date.now() - startedAt < 30_000
    ) {
      try {
        const data = await fetchChatSessionsList();
        const backendSession = parseGatewaySessionProbe(data, sessionKey);
        if (backendSession) {
          const sessions = mergeBackendSessionProbe(useChatStore.getState().sessions, backendSession);
          useChatStore.setState({ sessions });
          reconcileCurrentSessionLifecycleFromBackend(
            useChatStore.setState,
            useChatStore.getState,
            sessions,
          );
          if (gatewaySessionIsIdle(data, sessionKey)) {
            backendConfirmedIdle = true;
            confirmedSessions = sessions;
            break;
          }
        }
      } catch (error) {
        console.warn('[chat.queue] backend idle probe failed', {
          sessionKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(1_000, Math.round(delayMs * 1.7));
    }

    if (_sessionBackendIdleSettlementGeneration.get(sessionKey) !== generation) return;
    _sessionBackendIdleSettlementGeneration.delete(sessionKey);
    _sessionsAwaitingBackendIdle.delete(sessionKey);
    if (!backendConfirmedIdle) return;

    const state = useChatStore.getState();
    const settledRunState = state.currentSessionKey === sessionKey
      ? state
      : _sessionRunStateCache.get(sessionKey);
    if (
      expectedRunId
      && settledRunState?.activeRunId != null
      && settledRunState.activeRunId !== expectedRunId
    ) {
      return;
    }
    if (state.currentSessionKey !== sessionKey) {
      markSessionRunIdle(sessionKey);
      markSessionNeedsTerminalHistoryRefresh(sessionKey);
      clearPendingRuntimeIntent(sessionKey);
      return;
    }
    reconcileCurrentSessionLifecycleFromBackend(
      useChatStore.setState,
      useChatStore.getState,
      confirmedSessions ?? useChatStore.getState().sessions,
    );
    forceNextHistoryLoad(sessionKey);
    void useChatStore.getState().loadHistory(true);
  })();
}

function sessionExecutionIsBusy(state: ChatState, sessionKey: string): boolean {
  if (_sessionsCancelling.has(sessionKey) || _sessionsAwaitingBackendIdle.has(sessionKey)) return true;
  const runState = sessionKey === state.currentSessionKey
    ? state
    : _sessionRunStateCache.get(sessionKey);
  return Boolean(runState?.sending || runState?.activeRunId != null || runState?.pendingFinal);
}

function cloneQueuedAttachments(attachments: ChatSendAttachment[] | undefined): ChatSendAttachment[] | undefined {
  return attachments?.map((attachment) => ({ ...attachment }));
}

function enqueueChatSendForSession(
  sessionKey: string,
  item: Omit<QueuedChatSend, 'enqueuedAt'>,
): boolean {
  const queue = _queuedChatSendsBySession.get(sessionKey) ?? [];
  if (queue.length >= MAX_QUEUED_SENDS_PER_SESSION) {
    console.warn('[chat.queue] queue limit reached; preserving existing queued turns', {
      sessionKey,
      queueLength: queue.length,
    });
    if (useChatStore.getState().currentSessionKey === sessionKey) {
      useChatStore.setState({
        error: i18n.t('chat:chatInput.queueLimitReached', { count: queue.length }),
      });
    }
    return false;
  }
  queue.push({
    ...item,
    attachments: cloneQueuedAttachments(item.attachments),
    imageOptions: item.imageOptions ? { ...item.imageOptions } : undefined,
    videoOptions: item.videoOptions ? { ...item.videoOptions } : undefined,
    enqueuedAt: Date.now(),
  });
  _queuedChatSendsBySession.set(sessionKey, queue);
  return true;
}

function hasQueuedChatSends(sessionKey: string): boolean {
  return (_queuedChatSendsBySession.get(sessionKey)?.length ?? 0) > 0;
}

function clearQueuedChatSends(sessionKey: string): void {
  _queuedChatSendsBySession.delete(sessionKey);
  _queuedChatSendFlushScheduled.delete(sessionKey);
}

function currentSessionCanFlushQueuedSend(sessionKey: string): boolean {
  const state = useChatStore.getState();
  return state.currentSessionKey === sessionKey
    && !_sessionsAwaitingBackendIdle.has(sessionKey)
    && !state.sending
    && state.activeRunId == null
    && !state.pendingFinal;
}

function scheduleQueuedChatSendFlush(sessionKey: string): void {
  if (!hasQueuedChatSends(sessionKey) || _queuedChatSendFlushScheduled.has(sessionKey)) return;
  _queuedChatSendFlushScheduled.add(sessionKey);
  queueMicrotask(() => {
    _queuedChatSendFlushScheduled.delete(sessionKey);
    if (!currentSessionCanFlushQueuedSend(sessionKey)) return;
    const queue = _queuedChatSendsBySession.get(sessionKey) ?? [];
    const next = queue?.shift();
    if (!next) {
      _queuedChatSendsBySession.delete(sessionKey);
      return;
    }
    if (queue.length > 0) {
      _queuedChatSendsBySession.set(sessionKey, queue);
    } else {
      _queuedChatSendsBySession.delete(sessionKey);
    }
    void useChatStore.getState().sendMessage(
      next.text,
      cloneQueuedAttachments(next.attachments),
      next.targetAgentId,
      next.mode,
      next.imageOptions ? { ...next.imageOptions } : undefined,
      next.videoOptions ? { ...next.videoOptions } : undefined,
    );
  });
}

function mergeSessionRunStatePatch(
  base: SessionRunState,
  patch: Partial<SessionRunState>,
): SessionRunState {
  return {
    sending: patch.sending ?? base.sending,
    pendingImageGenerationLocal: patch.pendingImageGenerationLocal ?? base.pendingImageGenerationLocal,
    pendingVideoGenerationLocal: patch.pendingVideoGenerationLocal ?? base.pendingVideoGenerationLocal,
    activeRunId: patch.activeRunId !== undefined ? patch.activeRunId : base.activeRunId,
    pendingFinal: patch.pendingFinal ?? base.pendingFinal,
    lastUserMessageAt: patch.lastUserMessageAt !== undefined ? patch.lastUserMessageAt : base.lastUserMessageAt,
    streamingText: patch.streamingText ?? base.streamingText,
    streamingMessage: patch.streamingMessage !== undefined ? patch.streamingMessage : base.streamingMessage,
    streamingTools: patch.streamingTools ? [...patch.streamingTools] : [...base.streamingTools],
    pendingToolImages: patch.pendingToolImages
      ? patch.pendingToolImages.map((file) => ({ ...file }))
      : base.pendingToolImages.map((file) => ({ ...file })),
  };
}

function commitSessionRunState(
  set: ChatSet,
  get: ChatGet,
  sessionKey: string,
  patch: Partial<SessionRunState>,
): void {
  if (get().currentSessionKey === sessionKey) {
    set(patch);
    return;
  }

  captureSessionRunState(
    sessionKey,
    mergeSessionRunStatePatch(getCachedSessionRunState(sessionKey), patch),
  );
}

function markSessionNeedsTerminalHistoryRefresh(sessionKey: string): void {
  _sessionsNeedingTerminalHistoryRefresh.add(sessionKey);
  forceNextHistoryLoad(sessionKey);
}

function consumeSessionNeedsTerminalHistoryRefresh(sessionKey: string): boolean {
  return _sessionsNeedingTerminalHistoryRefresh.delete(sessionKey);
}

function forceNextHistoryLoad(sessionKey: string): void {
  _forceNextHistoryLoadBySession.add(sessionKey);
}

function cloneHistoryMessages(messages: RawMessage[]): RawMessage[] {
  return messages.map((message) => ({
    ...message,
    _attachedFiles: message._attachedFiles?.map((file) => ({ ...file })),
  }));
}

function setBoundedMapEntry<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value as K | undefined;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function getBoundedMapEntry<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key);
  if (value === undefined) return undefined;
  map.delete(key);
  map.set(key, value);
  return value;
}

function cacheSessionHistory(sessionKey: string, messages: RawMessage[], thinkingLevel: string | null): void {
  setBoundedMapEntry(
    _sessionHistoryCache,
    sessionKey,
    {
      messages: cloneHistoryMessages(messages),
      thinkingLevel,
    },
    SESSION_HISTORY_CACHE_MAX_SESSIONS,
  );
}

function getCachedSessionHistory(sessionKey: string): { messages: RawMessage[]; thinkingLevel: string | null } | null {
  const cached = getBoundedMapEntry(_sessionHistoryCache, sessionKey);
  if (!cached) return null;
  return {
    messages: cloneHistoryMessages(cached.messages),
    thinkingLevel: cached.thinkingLevel,
  };
}

function clearCachedSessionHistory(sessionKey: string): void {
  _sessionHistoryCache.delete(sessionKey);
  _sessionsNeedingTerminalHistoryRefresh.delete(sessionKey);
}

function captureSessionRunState(sessionKey: string, state: SessionRunState): void {
  setBoundedMapEntry(
    _sessionRunStateCache,
    sessionKey,
    {
      sending: state.sending,
      pendingImageGenerationLocal: state.pendingImageGenerationLocal,
      pendingVideoGenerationLocal: state.pendingVideoGenerationLocal,
      activeRunId: state.activeRunId,
      pendingFinal: state.pendingFinal,
      lastUserMessageAt: state.lastUserMessageAt,
      streamingText: state.streamingText,
      streamingMessage: state.streamingMessage,
      streamingTools: [...state.streamingTools],
      pendingToolImages: state.pendingToolImages.map((file) => ({ ...file })),
    },
    SESSION_RUN_STATE_CACHE_MAX_SESSIONS,
  );
}

function getCachedSessionRunState(sessionKey: string): SessionRunState {
  const cached = getBoundedMapEntry(_sessionRunStateCache, sessionKey);
  if (!cached) return DEFAULT_SESSION_RUN_STATE;
  return {
    sending: cached.sending,
    pendingImageGenerationLocal: cached.pendingImageGenerationLocal,
    pendingVideoGenerationLocal: cached.pendingVideoGenerationLocal,
    activeRunId: cached.activeRunId,
    pendingFinal: cached.pendingFinal,
    lastUserMessageAt: cached.lastUserMessageAt,
    streamingText: cached.streamingText,
    streamingMessage: cached.streamingMessage,
    streamingTools: [...cached.streamingTools],
    pendingToolImages: cached.pendingToolImages.map((file) => ({ ...file })),
  };
}

function clearCachedSessionRunState(sessionKey: string): void {
  _sessionRunStateCache.delete(sessionKey);
  _sessionsNeedingTerminalHistoryRefresh.delete(sessionKey);
}

function cloneSessionRunState(state: SessionRunState): SessionRunState {
  return {
    sending: state.sending,
    pendingImageGenerationLocal: state.pendingImageGenerationLocal,
    pendingVideoGenerationLocal: state.pendingVideoGenerationLocal,
    activeRunId: state.activeRunId,
    pendingFinal: state.pendingFinal,
    lastUserMessageAt: state.lastUserMessageAt,
    streamingText: state.streamingText,
    streamingMessage: state.streamingMessage,
    streamingTools: [...state.streamingTools],
    pendingToolImages: state.pendingToolImages.map((file) => ({ ...file })),
  };
}

function updateCachedSessionRunStateFromRuntimeEvent(
  event: ChatRuntimeEvent,
  runtimeRuns: ChatState['runtimeRuns'],
  holdForAsyncTask = false,
): void {
  const sessionKey = event.sessionKey;
  if (!sessionKey) return;
  const cached = _sessionRunStateCache.get(sessionKey);
  if (!cached) return;

  const next = cloneSessionRunState(cached);
  const matchesCachedRun = next.activeRunId != null && event.runId === next.activeRunId;
  const cachedTurnStartMs = optionalToMs(next.lastUserMessageAt);
  const eventRunStartMs = getRuntimeRunFirstEventMs(runtimeRuns[event.runId]);
  const eventRunPredatesCachedTurn = cachedTurnStartMs != null
    && eventRunStartMs != null
    && eventRunStartMs < cachedTurnStartMs - ACTIVE_TURN_BOUNDARY_SKEW_MS;
  const isCurrentUntrackedSend = next.activeRunId == null
    && next.sending
    && !eventRunPredatesCachedTurn
    && (
      typeof event.ts !== 'number'
      || next.lastUserMessageAt == null
      || event.ts >= next.lastUserMessageAt - 1_000
    );

  if (event.type === 'run.started') {
    if (next.activeRunId == null || matchesCachedRun) {
      next.activeRunId = event.runId;
      next.sending = true;
    }
    _sessionRunStateCache.set(sessionKey, next);
    return;
  }

  if (event.type === 'run.ended' && (matchesCachedRun || isCurrentUntrackedSend)) {
    if (holdForAsyncTask) {
      next.sending = true;
      next.activeRunId = event.runId;
      next.pendingFinal = true;
      _sessionRunStateCache.set(sessionKey, next);
      return;
    }
    markSessionRunIdle(sessionKey);
    markSessionNeedsTerminalHistoryRefresh(sessionKey);
  }
}

function getHistoryForegroundLoadKey(sessionKey: string): string {
  const gatewayState = useGatewayStore.getState?.() as { status?: { pid?: number; connectedAt?: number; port?: number } } | undefined;
  const gatewayStatus = gatewayState?.status;
  const gatewayRuntimeKey = `${gatewayStatus?.pid ?? 'none'}:${gatewayStatus?.connectedAt ?? 'none'}:${gatewayStatus?.port ?? 'none'}`;
  return `${gatewayRuntimeKey}|${sessionKey}`;
}

function pruneChatEventDedupe(now: number): void {
  for (const [key, ts] of _chatEventDedupe.entries()) {
    if (now - ts > CHAT_EVENT_DEDUPE_TTL_MS) {
      _chatEventDedupe.delete(key);
    }
  }
}

function buildChatEventDedupeKey(eventState: string, event: Record<string, unknown>): string | null {
  const runId = event.runId != null ? String(event.runId) : '';
  const sessionKey = event.sessionKey != null ? String(event.sessionKey) : '';
  const seq = event.seq != null ? String(event.seq) : '';
  if (eventState === 'final' && !seq) {
    const message = event.message && typeof event.message === 'object'
      ? event.message as Record<string, unknown>
      : null;
    const messageId = message?.id != null ? String(message.id) : '';
    const fingerprint = hashStringForLocalMessageId(JSON.stringify(message ?? event));
    return ['final-nosq', runId, sessionKey, messageId || fingerprint].join('|');
  }
  // Some gateways emit multiple `delta` updates without a monotonically
  // increasing `seq`. Deduping those by just `runId + sessionKey + state`
  // collapses legitimate stream progression, so only seq-backed deltas are
  // safe to dedupe generically.
  if (eventState === 'delta' && !seq) {
    return null;
  }
  if (runId || sessionKey || seq || eventState) {
    return [runId, sessionKey, seq, eventState].join('|');
  }
  const msg = (event.message && typeof event.message === 'object')
    ? event.message as Record<string, unknown>
    : null;
  if (msg) {
    const messageId = msg.id != null ? String(msg.id) : '';
    const stopReason = msg.stopReason ?? msg.stop_reason;
    if (messageId || stopReason) {
      return `msg|${messageId}|${String(stopReason ?? '')}|${eventState}`;
    }
  }
  return null;
}

function getFinalMessageIdDedupeKey(eventState: string, event: Record<string, unknown>): string | null {
  if (eventState !== 'final') return null;
  const msg = (event.message && typeof event.message === 'object')
    ? event.message as Record<string, unknown>
    : null;
  if (msg?.id != null) return `final-msgid|${String(msg.id)}`;
  return null;
}

function isDuplicateChatEvent(eventState: string, event: Record<string, unknown>): boolean {
  const key = buildChatEventDedupeKey(eventState, event);
  const msgKey = getFinalMessageIdDedupeKey(eventState, event);
  if (!key && !msgKey) return false;
  const now = Date.now();
  pruneChatEventDedupe(now);
  if ((key && _chatEventDedupe.has(key)) || (msgKey && _chatEventDedupe.has(msgKey))) {
    return true;
  }
  if (key) _chatEventDedupe.set(key, now);
  if (msgKey) _chatEventDedupe.set(msgKey, now);
  return false;
}

// ── Local image cache ─────────────────────────────────────────
// The Gateway doesn't store image attachments in session content blocks,
// so we cache them locally keyed by staged file path (which appears in the
// [media attached: <path> ...] reference in the Gateway's user message text).
// Keying by path avoids the race condition of keying by runId (which is only
// available after the RPC returns, but history may load before that).
const IMAGE_CACHE_KEY = 'clawx:image-cache';
const IMAGE_CACHE_MAX = 100; // max entries to prevent unbounded growth

function loadImageCache(): Map<string, AttachedFileMeta> {
  try {
    const raw = localStorage.getItem(IMAGE_CACHE_KEY);
    if (raw) {
      const entries = JSON.parse(raw) as Array<[string, AttachedFileMeta]>;
      return new Map(entries);
    }
  } catch { /* ignore parse errors */ }
  return new Map();
}

function saveImageCache(cache: Map<string, AttachedFileMeta>): void {
  try {
    // Evict oldest entries if over limit
    const entries = Array.from(cache.entries());
    const trimmed = entries.length > IMAGE_CACHE_MAX
      ? entries.slice(entries.length - IMAGE_CACHE_MAX)
      : entries;
    localStorage.setItem(IMAGE_CACHE_KEY, JSON.stringify(trimmed));
  } catch { /* ignore quota errors */ }
}

const _imageCache = loadImageCache();

function normalizeBlockText(text: string | undefined): string {
  return typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '';
}

function compactProgressiveTextParts(parts: string[]): string[] {
  const compacted: string[] = [];

  for (const part of parts) {
    const current = normalizeBlockText(part);
    if (!current) continue;

    const previous = compacted.at(-1);
    if (!previous) {
      compacted.push(part);
      continue;
    }

    const normalizedPrevious = normalizeBlockText(previous);
    if (!normalizedPrevious) {
      compacted[compacted.length - 1] = part;
      continue;
    }

    if (current === normalizedPrevious || normalizedPrevious.startsWith(current)) {
      continue;
    }

    if (current.startsWith(normalizedPrevious)) {
      compacted[compacted.length - 1] = part;
      continue;
    }

    compacted.push(part);
  }

  return compacted;
}

function normalizeLiveContentBlocks(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) => ({ ...block }));
}

function normalizeStreamingMessage(message: unknown): unknown {
  if (!message || typeof message !== 'object') return message;

  const rawMessage = message as RawMessage;
  const rawContent = rawMessage.content;
  if (!Array.isArray(rawContent)) return rawMessage;

  const normalizedContent = normalizeLiveContentBlocks(rawContent as ContentBlock[]);
  const didChange = normalizedContent.some((block, index) => block !== rawContent[index])
    || normalizedContent.length !== rawContent.length;

  return didChange
    ? { ...rawMessage, content: normalizedContent }
    : rawMessage;
}

/**
 * Strip Gateway-injected metadata that does NOT exist on the renderer's
 * optimistic user message but is echoed back when the Gateway persists it:
 *   - leading sender metadata `Sender (untrusted metadata): ...`
 *   - leading timestamp `[Wed 2026-04-22 10:30 GMT+8] `
 *   - `[message_id: uuid]` tags sprinkled throughout the text
 *   - `[media attached: path (mime) | path]` references appended when the
 *     renderer sends attachments via `chat:sendWithMedia`
 *   - Gateway-injected "Conversation info (untrusted metadata): ..." blocks
 *
 * Keeping this aligned with `cleanUserText` in `pages/Chat/message-utils.ts`
 * is important: the user bubble renders the cleaned text, so the comparison
 * used to dedupe optimistic vs server echoes must operate on the same
 * cleaned form  - otherwise the same visible message renders twice.
 *
 * Order matters: the `[media attached: ...]` lines are commonly emitted
 * BETWEEN the Sender block and the `[Mon ... GMT+8]` timestamp prefix.
 * If we strip the timestamp before the media-attached lines, the timestamp
 * regex (`^\s*\[(?:Mon|...)]`) can never match because the leading `[` is
 * `[media attached:` instead  - leaving the timestamp in the normalized
 * comparison text and breaking optimistic-vs-echo dedupe.
 */
function stripInboundMediaVisionEnvelope(text: string): string {
  if (!/\[Image\]/i.test(text) && !/^User text:/im.test(text) && !/\nDescription:\s*\n/i.test(text)) {
    return text;
  }

  let result = text.replace(/^\s*\[Image\]\s*\n?/i, '');

  const userTextBlock = result.match(/^User text:\s*\n([\s\S]*?)(?:\n\s*Description:\s*\n[\s\S]*)?\s*$/i);
  if (userTextBlock) {
    const userText = userTextBlock[1].trim();
    return /^Process the attached file\(s\)\.\s*$/i.test(userText) ? '' : userText;
  }

  return result.replace(/\n\s*Description:\s*\n[\s\S]*$/i, '').trim();
}

function stripGatewayUserMetadata(text: string): string {
  return stripInboundMediaVisionEnvelope(
    text
    .replace(/\s*\[media attached:[^\]]*\]/g, '')
    .replace(/\s*\[message_id:\s*[^\]]+\]/g, '')
    .replace(/^Sender\s*\([^)]*\)\s*:\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
    .replace(/^Sender\s*\([^)]*\)\s*:\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/^Sender\s*\([^)]*\)\s*:\s*[^\n]*(?:\n\s*)*/i, '')
    .replace(/^Sender\s*:\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
    .replace(/^Sender\s*:\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/^Sender\s*:\s*[^\n]*(?:\n\s*)*/i, '')
    .replace(/^Conversation info\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
    .replace(/^Conversation info\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/^\s*\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\]]+\]\s*/i, ''),
  );
}

function normalizeComparableUserText(content: unknown): string {
  const text = stripGatewayUserMetadata(getMessageText(content))
    .replace(/\s+/g, ' ')
    .trim();
  if (/^\(file attached\)$/i.test(text)) return '';
  return text;
}

function getComparableAttachmentSignature(message: Pick<RawMessage, '_attachedFiles'>): string {
  const files = (message._attachedFiles || [])
    .map((file) => file.filePath || `${file.fileName}|${file.mimeType}|${file.fileSize}`)
    .filter(Boolean)
    .sort();
  return files.join('::');
}

function matchesOptimisticUserMessage(
  candidate: RawMessage,
  optimistic: RawMessage,
  optimisticTimestampMs: number,
): boolean {
  if (candidate.role !== 'user') return false;

  const optimisticText = normalizeComparableUserText(optimistic.content);
  const candidateText = normalizeComparableUserText(candidate.content);
  const sameText = optimisticText.length > 0 && optimisticText === candidateText;

  const optimisticAttachments = getComparableAttachmentSignature(optimistic);
  const candidateAttachments = getComparableAttachmentSignature(candidate);
  const sameAttachments = optimisticAttachments.length > 0 && optimisticAttachments === candidateAttachments;

  const hasOptimisticTimestamp = Number.isFinite(optimisticTimestampMs) && optimisticTimestampMs > 0;
  const hasCandidateTimestamp = candidate.timestamp != null;
  const timestampMatches = hasOptimisticTimestamp && hasCandidateTimestamp
    ? Math.abs(toMs(candidate.timestamp as number) - optimisticTimestampMs) < OPTIMISTIC_USER_TIMESTAMP_MATCH_MS
    : false;

  if (sameText && sameAttachments) return true;
  if (sameText && (!optimisticAttachments || !candidateAttachments) && (timestampMatches || !hasCandidateTimestamp)) return true;
  if (sameAttachments && (!optimisticText || !candidateText) && (timestampMatches || !hasCandidateTimestamp)) return true;

  const optimisticHadAttachmentsOnly = optimisticAttachments.length > 0 && !optimisticText;
  const candidateIsAttachmentEcho = !candidateText
    && /\[(?:media attached:|\s*Image\s*\])/i.test(getMessageText(candidate.content));
  if (optimisticHadAttachmentsOnly && candidateIsAttachmentEcho && (timestampMatches || !hasCandidateTimestamp)) {
    return true;
  }
  return false;
}

function rememberPendingOptimisticUserMessage(sessionKey: string, message: RawMessage, timestampMs: number): void {
  const now = Date.now();
  const existing = (_pendingOptimisticUserMessages.get(sessionKey) || [])
    .filter((entry) => now - entry.createdAtMs <= OPTIMISTIC_USER_MESSAGE_TTL_MS);
  existing.push({ message, timestampMs, createdAtMs: now });
  _pendingOptimisticUserMessages.set(sessionKey, existing);
}

function clearPendingOptimisticUserMessages(sessionKey: string): void {
  _pendingOptimisticUserMessages.delete(sessionKey);
}

function discardPendingOptimisticUserMessage(sessionKey: string, messageId: string | undefined): void {
  if (!messageId) return;

  const remaining = (_pendingOptimisticUserMessages.get(sessionKey) || [])
    .filter((entry) => entry.message.id !== messageId);
  if (remaining.length > 0) {
    _pendingOptimisticUserMessages.set(sessionKey, remaining);
  } else {
    _pendingOptimisticUserMessages.delete(sessionKey);
  }

  const cached = _sessionHistoryCache.get(sessionKey);
  if (cached) {
    cacheSessionHistory(
      sessionKey,
      cached.messages.filter((message) => message.id !== messageId),
      cached.thinkingLevel,
    );
  }
}

function mergePendingOptimisticUserMessages(sessionKey: string, loadedMessages: RawMessage[]): RawMessage[] {
  const pending = _pendingOptimisticUserMessages.get(sessionKey);
  if (!pending || pending.length === 0) return loadedMessages;

  const now = Date.now();
  let merged = loadedMessages;
  const stillPending: PendingOptimisticUserMessage[] = [];

  for (const entry of pending) {
    if (now - entry.createdAtMs > OPTIMISTIC_USER_MESSAGE_TTL_MS) {
      continue;
    }

    const hasServerEcho = hasOptimisticServerEcho(loadedMessages, entry.message, entry.timestampMs);
    if (hasServerEcho) {
      continue;
    }

    const alreadyRendered = merged.some((message) =>
      message.id === entry.message.id || matchesOptimisticUserMessage(message, entry.message, entry.timestampMs),
    );
    if (!alreadyRendered) {
      const insertAt = merged.findIndex((message) =>
        typeof message.timestamp === 'number' && toMs(message.timestamp) > entry.timestampMs,
      );
      merged = insertAt === -1
        ? [...merged, entry.message]
        : [...merged.slice(0, insertAt), entry.message, ...merged.slice(insertAt)];
    }

    stillPending.push(entry);
  }

  if (stillPending.length > 0) {
    _pendingOptimisticUserMessages.set(sessionKey, stillPending);
  } else {
    _pendingOptimisticUserMessages.delete(sessionKey);
  }

  return merged;
}

function snapshotStreamingAssistantMessage(
  currentStream: RawMessage | null,
  existingMessages: RawMessage[],
  runId: string,
): RawMessage[] {
  if (!currentStream) return [];

  const normalizedStream = normalizeStreamingMessage(currentStream) as RawMessage;
  const streamRole = normalizedStream.role;
  if (streamRole !== 'assistant' && streamRole !== undefined) return [];

  const snapId = normalizedStream.id || `${runId || 'run'}-turn-${existingMessages.length}`;
  if (existingMessages.some((message) => message.id === snapId)) return [];

  return [{
    ...normalizedStream,
    role: 'assistant',
    id: snapId,
  }];
}

function getLatestOptimisticUserMessage(messages: RawMessage[], userTimestampMs: number): RawMessage | undefined {
  return [...messages].reverse().find(
    (message) => message.role === 'user'
      && (!message.timestamp || Math.abs(toMs(message.timestamp) - userTimestampMs) < OPTIMISTIC_USER_TIMESTAMP_MATCH_MS),
  );
}

function hasOptimisticServerEcho(
  loadedMessages: RawMessage[],
  optimistic: RawMessage,
  optimisticTimestampMs: number,
): boolean {
  if (loadedMessages.some((message) =>
    matchesOptimisticUserMessage(message, optimistic, optimisticTimestampMs),
  )) {
    return true;
  }

  const optimisticText = normalizeComparableUserText(optimistic.content);
  if (!optimisticText) return false;

  const matchingUsers = loadedMessages.filter(
    (message) => message.role === 'user'
      && normalizeComparableUserText(message.content) === optimisticText,
  );
  if (matchingUsers.length !== 1) return false;

  const candidate = matchingUsers[0]!;
  if (candidate.timestamp == null) return true;

  return Math.abs(toMs(candidate.timestamp as number) - optimisticTimestampMs) < OPTIMISTIC_USER_TIMESTAMP_MATCH_MS;
}

function dropRedundantOptimisticUserMessages(sessionKey: string, messages: RawMessage[]): RawMessage[] {
  const pending = _pendingOptimisticUserMessages.get(sessionKey);
  if (!pending?.length) return messages;

  const pendingIds = new Set(
    pending
      .map((entry) => entry.message.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  if (pendingIds.size === 0) return messages;

  return messages.filter((message) => {
    if (message.role !== 'user' || !message.id || !pendingIds.has(message.id)) {
      return true;
    }
    const entry = pending.find((candidate) => candidate.message.id === message.id);
    if (!entry) return true;
    return !hasOptimisticServerEcho(
      messages.filter((candidate) => candidate !== message),
      entry.message,
      entry.timestampMs,
    );
  });
}

/** Extract plain text from message content (string or content blocks) */
function getMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = (content as Array<{ type?: string; text?: string }>)
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!);
    return compactProgressiveTextParts(parts).join('\n');
  }
  return '';
}

function getMessageStopReason(message: RawMessage | unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  const rawStopReason = msg.stopReason ?? msg.stop_reason;
  if (typeof rawStopReason !== 'string') return null;
  const normalized = rawStopReason.trim().toLowerCase();
  return normalized || null;
}

function getMessageErrorMessage(message: RawMessage | unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  const rawError = msg.errorMessage ?? msg.error_message;
  if (typeof rawError !== 'string') return null;
  const normalized = rawError.trim();
  return normalized || null;
}

function isTerminalAssistantErrorMessage(message: RawMessage | unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const msg = message as Record<string, unknown>;
  return msg.role === 'assistant' && getMessageStopReason(message) === 'error';
}

/** Extract media file refs from [media attached: <path> (<mime>) | ...] patterns */
function extractMediaRefs(text: string): Array<{ filePath: string; mimeType: string }> {
  const refs: Array<{ filePath: string; mimeType: string }> = [];
  const regex = /\[media attached:\s*([^\s(]+)\s*\(([^)]+)\)\s*\|[^\]]*\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    refs.push({ filePath: match[1], mimeType: match[2] });
  }
  return refs;
}

/** Map common file extensions to MIME types */
function mimeFromExtension(filePath: string): string {
  let pathForExtension = filePath.trim();
  if (/^https?:\/\//i.test(pathForExtension)) {
    try {
      pathForExtension = new URL(pathForExtension).pathname;
    } catch {
      pathForExtension = pathForExtension.split(/[?#]/)[0] || pathForExtension;
    }
  } else {
    pathForExtension = pathForExtension.split(/[?#]/)[0] || pathForExtension;
  }
  const ext = pathForExtension.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    // Images
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'bmp': 'image/bmp',
    'avif': 'image/avif',
    'svg': 'image/svg+xml',
    // Documents
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'txt': 'text/plain',
    'csv': 'text/csv',
    'md': 'text/markdown',
    'rtf': 'application/rtf',
    'epub': 'application/epub+zip',
    // Archives
    'zip': 'application/zip',
    'tar': 'application/x-tar',
    'gz': 'application/gzip',
    'rar': 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    // Audio
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg',
    'aac': 'audio/aac',
    'flac': 'audio/flac',
    'm4a': 'audio/mp4',
    // Video
    'mp4': 'video/mp4',
    'mov': 'video/quicktime',
    'avi': 'video/x-msvideo',
    'mkv': 'video/x-matroska',
    'webm': 'video/webm',
    'm4v': 'video/mp4',
  };
  return map[ext] || 'application/octet-stream';
}

function mimeFromTaggedMediaRef(filePath: string): string {
  const mimeType = mimeFromExtension(filePath);
  if (mimeType !== 'application/octet-stream') return mimeType;
  return /^https?:\/\//i.test(filePath.trim()) ? 'video/mp4' : mimeType;
}

function extractFilePathsFromToolArgs(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const direct = args.file_path ?? args.filePath ?? args.path ?? args.file;
  if (typeof direct === 'string' && direct.trim()) paths.push(direct.trim());

  const attachments = args.attachments;
  if (Array.isArray(attachments)) {
    for (const item of attachments) {
      if (!item || typeof item !== 'object') continue;
      const att = item as Record<string, unknown>;
      const filePath = att.filePath ?? att.file_path ?? att.path ?? att.file;
      if (typeof filePath === 'string' && filePath.trim()) {
        paths.push(filePath.trim());
      }
    }
  }

  return paths;
}

const DIRECTORY_MIME_TYPE = 'application/x-directory';

function looksLikeRemoteMediaUrl(filePath: string): boolean {
  return /^https?:\/\//i.test(filePath.trim());
}

function fileNameFromMediaRef(filePath: string, mimeType: string): string {
  if (looksLikeRemoteMediaUrl(filePath)) {
    try {
      const remoteName = decodeURIComponent(new URL(filePath).pathname.split('/').filter(Boolean).pop() || '');
      if (remoteName.includes('.')) return remoteName;
    } catch {
      // Fall through to a stable MIME-based name.
    }
    if (mimeType.startsWith('video/')) return 'video.mp4';
    if (mimeType.startsWith('audio/')) return 'audio.mp3';
    if (mimeType.startsWith('image/')) return 'image';
    return 'remote-file';
  }
  return filePath.split(/[\\/]/).pop()?.split(/[?#]/)[0] || 'file';
}

function trimPathTerminators(filePath: string): string {
  return filePath.replace(/[，。；;,.!?]+$/u, '');
}

/**
 * Extract raw file paths from message text.
 * Detects absolute paths (Unix: / or ~/, Windows: C:\ etc.) ending with common file extensions.
 * Handles both image and non-image files, consistent with channel push message behavior.
 *
 * Also recognises the `MEDIA:` / `media:` prefix the OpenClaw runtime
 * emits for produced artifacts (e.g.
 * `MEDIA:/tmp/desktop_screenshot.png`, `MEDIA:C:\Users\me\out.svg`)  - without this the leading colon
 * trips the URL guard on the unix regex below and the artifact never
 * surfaces as an attachment. Mirrors `chat/helpers.ts::extractRawFilePaths`.
 */
function extractRawFilePaths(text: string): Array<{ filePath: string; mimeType: string }> {
  const refs: Array<{ filePath: string; mimeType: string }> = [];
  const seen = new Set<string>();
  const exts = 'png|jpe?g|gif|webp|bmp|avif|svg|pdf|docx?|xlsx?|pptx?|html?|txt|csv|md|rtf|epub|zip|tar|gz|rar|7z|mp3|wav|ogg|aac|flac|m4a|mp4|mov|avi|mkv|webm|m4v';
  // Tagged media references (MEDIA:/path, media:~/path, MEDIA:C:\path, ...). The agent
  // runtime uses this prefix as an explicit "this is an artifact" marker,
  // so we want them recognised even though the leading colon would
  // normally look like a URL scheme. After matching we punch the entire
  // `MEDIA:<path>` span out of the working text so the generic unix
  // regex below doesn't double-count the bare `/path` suffix.
  // The character class deliberately allows ASCII spaces inside the path so
  // that macOS' default screenshot filename ("截屏 2026-05-06 17.46.51.png")
  // and other space-containing paths the agent emits with the explicit
  // `MEDIA:` marker still resolve. Newline and quote characters remain
  // path terminators so we don't accidentally swallow trailing prose.
  const taggedRegex = new RegExp(`(?:^|[\\s(\\[{>])(?:MEDIA|media):((?:\\/|~\\/|[A-Za-z]:\\\\)[^\\n"'()\\[\\],<>` + '`' + `]*?\\.(?:${exts}))(?=$|[\\s\\n"'()\\[\\],<>` + '`' + `]|[，。；;,.!?])`, 'g');
  let workingText = text;
  let taggedMatch: RegExpExecArray | null;
  const taggedRemoteRegex = new RegExp(`(?:^|[\\s(\\[{>])(?:MEDIA|media):(https?:\\/\\/[^\\s\\n"'()\\[\\],<>` + '`' + `]+)`, 'g');
  while ((taggedMatch = taggedRemoteRegex.exec(text)) !== null) {
    const p = trimPathTerminators(taggedMatch[1] || '');
    if (p && !seen.has(p)) {
      seen.add(p);
      refs.push({ filePath: p, mimeType: mimeFromTaggedMediaRef(p) });
    }
    const start = taggedMatch.index;
    const end = start + taggedMatch[0].length;
    workingText = workingText.slice(0, start) + ' '.repeat(end - start) + workingText.slice(end);
  }
  while ((taggedMatch = taggedRegex.exec(text)) !== null) {
    const p = taggedMatch[1];
    if (p && !seen.has(p)) {
      seen.add(p);
      refs.push({ filePath: p, mimeType: mimeFromExtension(p) });
    }
    // Mask the matched span so subsequent regexes can't re-discover the
    // same path (e.g. `/two.xlsx` from `MEDIA:~/two.xlsx`).
    const start = taggedMatch.index;
    const end = start + taggedMatch[0].length;
    workingText = workingText.slice(0, start) + ' '.repeat(end - start) + workingText.slice(end);
  }
  // Unix absolute paths (/... or ~/...)  - lookbehind rejects mid-token slashes
  // (e.g. "path/to/file.mp4", "https://example.com/file.mp4")
  const unixRegex = new RegExp(`(?<![\\w./:])((?:\\/|~\\/)[^\\s\\n"'()\`\\[\\],<>]*?\\.(?:${exts}))`, 'gi');
  // Windows absolute paths (C:\... D:\...)  - lookbehind rejects drive letter glued to a word
  const winRegex = new RegExp(`(?<![\\w])([A-Za-z]:\\\\[^\\s\\n"'()\`\\[\\],<>]*?\\.(?:${exts}))`, 'gi');
  const skillPathBoundary = '(?=$|\\s|[\\x5b\\x5d"\'`(),<>，。；;,.!?])';
  const skillPathPart = '[^\\\\/\\s\\n"\'`()\\x5b\\x5d,<>]+';
  const skillPathTail = '[^\\s\\n"\'`()\\x5b\\x5d,<>]*?';
  const skillDirRegex = new RegExp(
    `(?<![\\w./:])((?:~[\\\\/]\\.openclaw[\\\\/]skills[\\\\/]${skillPathPart})|(?:(?:\\/|[A-Za-z]:\\\\)${skillPathTail}[\\\\/]\\.openclaw[\\\\/]skills[\\\\/]${skillPathPart}))${skillPathBoundary}`,
    'gi',
  );
  for (const regex of [unixRegex, winRegex, skillDirRegex]) {
    let match;
    while ((match = regex.exec(workingText)) !== null) {
      const p = trimPathTerminators(match[1]);
      if (p && !seen.has(p)) {
        seen.add(p);
        refs.push({
          filePath: p,
          mimeType: regex === skillDirRegex ? DIRECTORY_MIME_TYPE : mimeFromExtension(p),
        });
      }
    }
  }
  return refs;
}

function hasExplicitMediaDeliveryDirective(text: string, filePath: string): boolean {
  const normalizedText = text.toLowerCase();
  const normalizedPath = filePath.trim().toLowerCase();
  return normalizedText.includes(`media:${normalizedPath}`)
    || normalizedText.includes(`media: ${normalizedPath}`);
}

/**
 * Extract images from a content array (including nested tool_result content).
 * Converts them to AttachedFileMeta entries with preview set to data URL or remote URL.
 */
function extractImagesAsAttachedFiles(content: unknown): AttachedFileMeta[] {
  if (!Array.isArray(content)) return [];
  const files: AttachedFileMeta[] = [];

  for (const block of content as ContentBlock[]) {
    if (block.type === 'image') {
      // Path 1: Anthropic source-wrapped format {source: {type, media_type, data}}
      if (block.source) {
        const src = block.source;
        const mimeType = src.media_type || 'image/jpeg';

        if (src.type === 'base64' && src.data) {
          files.push({
            fileName: 'image',
            mimeType,
            fileSize: 0,
            preview: `data:${mimeType};base64,${src.data}`,
          });
        } else if (src.type === 'url' && src.url) {
          files.push({
            fileName: 'image',
            mimeType,
            fileSize: 0,
            preview: src.url,
          });
        }
      }
      // Path 2: Flat format from Gateway tool results {data, mimeType}
      else if (block.data) {
        const mimeType = block.mimeType || 'image/jpeg';
        files.push({
          fileName: 'image',
          mimeType,
          fileSize: 0,
          preview: `data:${mimeType};base64,${block.data}`,
        });
      }
      // Path 3: Flat URL form from Gateway-injected assistant-media messages.
      // See `src/stores/chat/helpers.ts` for the canonical implementation.
      else if (block.url) {
        const mimeType = block.mimeType || 'image/jpeg';
        const fileName = typeof block.alt === 'string' && block.alt
          ? block.alt
          : 'image';
        files.push({
          fileName,
          mimeType,
          fileSize: 0,
          preview: null,
          gatewayUrl: block.url,
          source: 'gateway-media',
          disposition: 'output-delivery',
        });
      }
    }
    if (block.type === 'video' || block.type === 'audio' || block.type === 'file') {
      const url = block.url || block.source?.url;
      const filePath = block.filePath;
      if (url || filePath) {
        const defaultMime = block.type === 'video'
          ? 'video/mp4'
          : block.type === 'audio' ? 'audio/mpeg' : 'application/octet-stream';
        const target = filePath || url || '';
        files.push({
          fileName: block.fileName || block.alt || target.split(/[\\/]/u).pop() || block.type,
          mimeType: block.mimeType || block.source?.media_type || defaultMime,
          fileSize: 0,
          preview: null,
          ...(filePath ? { filePath } : { gatewayUrl: url }),
          source: url ? 'gateway-media' : 'message-ref',
          disposition: 'output-delivery',
        });
      }
    }
    // Recurse into tool_result content blocks
    if ((block.type === 'tool_result' || block.type === 'toolResult') && block.content) {
      files.push(...extractImagesAsAttachedFiles(block.content));
    }
  }
  return files;
}

/**
 * Build an AttachedFileMeta entry for a file ref, using cache if available.
 */
function makeAttachedFile(
  ref: { filePath: string; mimeType: string },
  source: AttachedFileMeta['source'] = 'message-ref',
  disposition: AttachedFileMeta['disposition'] = 'output-delivery',
): AttachedFileMeta {
  if (looksLikeRemoteMediaUrl(ref.filePath)) {
    return {
      fileName: fileNameFromMediaRef(ref.filePath, ref.mimeType),
      mimeType: ref.mimeType,
      fileSize: 0,
      preview: null,
      gatewayUrl: ref.filePath,
      source,
      disposition,
    };
  }
  const cached = _imageCache.get(ref.filePath);
  if (cached) return { ...cached, filePath: ref.filePath, source, disposition };
  const fileName = fileNameFromMediaRef(ref.filePath, ref.mimeType);
  return { fileName, mimeType: ref.mimeType, fileSize: 0, preview: null, filePath: ref.filePath, source, disposition };
}

/**
 * Extract file path from a tool call's arguments by toolCallId.
 * Searches common argument names: file_path, filePath, path, file.
 */
function getToolCallFilePath(msg: RawMessage, toolCallId: string): string | undefined {
  if (!toolCallId) return undefined;

  // Anthropic/normalized format  - toolCall blocks in content array
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if ((block.type === 'tool_use' || block.type === 'toolCall') && block.id === toolCallId) {
        const args = (block.input ?? block.arguments) as Record<string, unknown> | undefined;
        if (args) {
          const paths = extractFilePathsFromToolArgs(args);
          if (paths[0]) return paths[0];
        }
      }
    }
  }

  // OpenAI format  - tool_calls array on the message itself
  const msgAny = msg as unknown as Record<string, unknown>;
  const toolCalls = msgAny.tool_calls ?? msgAny.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls as Array<Record<string, unknown>>) {
      if (tc.id !== toolCallId) continue;
      const fn = (tc.function ?? tc) as Record<string, unknown>;
      let args: Record<string, unknown> | undefined;
      try {
        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments ?? fn.input) as Record<string, unknown>;
      } catch { /* ignore */ }
      if (args) {
        const paths = extractFilePathsFromToolArgs(args);
        if (paths[0]) return paths[0];
      }
    }
  }

  return undefined;
}

/**
 * Collect all tool call file paths from a message into a Map<toolCallId, filePath>.
 */
function collectToolCallPaths(msg: RawMessage, paths: Map<string, string>): void {
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if ((block.type === 'tool_use' || block.type === 'toolCall') && block.id) {
        const args = (block.input ?? block.arguments) as Record<string, unknown> | undefined;
        if (args) {
          const filePaths = extractFilePathsFromToolArgs(args);
          if (filePaths[0]) paths.set(block.id, filePaths[0]);
        }
      }
    }
  }
  const msgAny = msg as unknown as Record<string, unknown>;
  const toolCalls = msgAny.tool_calls ?? msgAny.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls as Array<Record<string, unknown>>) {
      const id = typeof tc.id === 'string' ? tc.id : '';
      if (!id) continue;
      const fn = (tc.function ?? tc) as Record<string, unknown>;
      let args: Record<string, unknown> | undefined;
      try {
        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments ?? fn.input) as Record<string, unknown>;
      } catch { /* ignore */ }
      if (args) {
        const filePaths = extractFilePathsFromToolArgs(args);
        if (filePaths[0]) paths.set(id, filePaths[0]);
      }
    }
  }
}

function selectExplicitlyDeliveredToolFiles(
  pending: AttachedFileMeta[],
  assistantMessage: RawMessage,
): AttachedFileMeta[] {
  const text = getMessageText(assistantMessage.content);
  if (!text) return pending;
  const deliveredPaths = new Set([
    ...extractMediaRefs(text).map((ref) => ref.filePath),
    ...extractRawFilePaths(text).map((ref) => ref.filePath),
  ]);
  if (deliveredPaths.size === 0) return pending;
  const explicitlyDelivered = pending.filter((file) => file.filePath && deliveredPaths.has(file.filePath));
  return explicitlyDelivered.length > 0 ? explicitlyDelivered : pending;
}

/**
 * Before filtering tool_result messages from history, scan them for any file/image
 * content and attach those to the immediately following assistant message.
 * This mirrors channel push message behavior where tool outputs surface files to the UI.
 * Handles:
 *   - Image content blocks (base64 / url)
 *   - [media attached: path (mime) | path] text patterns in tool result output
 *   - Raw file paths in tool result text
 */
function enrichWithToolResultFiles(messages: RawMessage[]): RawMessage[] {
  const pending: AttachedFileMeta[] = [];
  const toolCallPaths = new Map<string, string>();

  return messages.map((msg) => {
    // Track file paths from assistant tool call arguments for later matching
    if (msg.role === 'assistant') {
      collectToolCallPaths(msg, toolCallPaths);
    }

    if (isToolResultRole(msg.role)) {
      // Resolve file path from the matching tool call
      const matchedPath = msg.toolCallId ? toolCallPaths.get(msg.toolCallId) : undefined;

      // 1. Image/file content blocks in the structured content array.
      //    Images embedded inside a tool result are the model's vision data
      //    (e.g. `read /tmp/foo.png` re-encoded as JPEG so the model can "see"
      //    the file)  - they are NOT user-facing artifacts. The agent surfaces
      //    user-facing images through `MEDIA:/path` text + the Gateway's
      //    `assistant-media` injection. Surfacing the vision data here would
      //    duplicate every screenshot the agent inspects.
      const imageFiles = extractImagesAsAttachedFiles(msg.content)
        .filter(file => !file.mimeType.startsWith('image/'));
      if (matchedPath) {
        for (const f of imageFiles) {
          if (!f.filePath) {
            f.filePath = matchedPath;
            f.fileName = matchedPath.split(/[\\/]/).pop() || 'image';
          }
        }
      }
      // Tag all files from tool results so ChatMessage can suppress them
      // in segments that already have an ExecutionGraphCard.
      for (const f of imageFiles) f.source = 'tool-result';
      pending.push(...imageFiles);

      // 2. [media attached: ...] patterns in tool result text output
      const text = getMessageText(msg.content);
      if (text) {
        const mediaRefs = extractMediaRefs(text);
        const mediaRefPaths = new Set(mediaRefs.map(r => r.filePath));
        for (const ref of mediaRefs) {
          pending.push({ ...makeAttachedFile(ref), source: 'tool-result' });
        }
        // 3. Raw NON-image file paths in tool result text (documents,
        //    audio, video, ...). Image paths are deliberately ignored:
        //    `ls -la /tmp/foo.png`, `sips ... && ls -la *.jpg`, etc.
        //    spam intermediate paths that the user does not want to see
        //    rendered as separate cards. The canonical user-facing image
        //    is whatever the agent later emits via `MEDIA:/path` (which
        //    the Gateway turns into a dedicated assistant-media bubble).
        for (const ref of extractRawFilePaths(text)) {
          if (mediaRefPaths.has(ref.filePath)) continue;
          if (ref.mimeType.startsWith('image/')) continue;
          pending.push({ ...makeAttachedFile(ref), source: 'tool-result' });
        }
      }

      return msg; // will be filtered later
    }

    if (msg.role === 'assistant' && pending.length > 0) {
      if (hasPendingToolUse(msg) || isToolOnlyMessage(msg) || isInternalMessage(msg)) {
        return msg;
      }
      const toAttach = selectExplicitlyDeliveredToolFiles(pending.splice(0), msg);
      const existingFiles = msg._attachedFiles || [];
      const attachedFiles = dedupeAttachedFiles([...existingFiles, ...toAttach]);
      if (attachedFiles.length === existingFiles.length) return msg;
      return {
        ...msg,
        _attachedFiles: attachedFiles,
      };
    }

    return msg;
  });
}

/**
 * Restore _attachedFiles for messages loaded from history.
 * Handles:
 *   1. [media attached: path (mime) | path] patterns (attachment-button flow)
 *   2. Raw image file paths typed in message text (e.g. /Users/.../image.png)
 * Uses local cache for previews when available; missing previews are loaded async.
 */
function enrichWithCachedImages(messages: RawMessage[]): RawMessage[] {
  // Pre-compute, per index, whether the *next* assistant message is a
  // Gateway-injected `assistant-media` bubble (i.e. has at least one
  // `image` content block carrying a flat URL). When that bubble exists,
  // the canonical user-facing rendering of the artifact is the bubble
  // itself  - anything the agent emitted via `MEDIA:/path` in its prior
  // text turn would just duplicate the same image, so image-typed raw
  // refs on that prior message should be dropped here.
  const nextHasGatewayMediaBubble = messages.map((_, idx) => {
    const next = messages[idx + 1];
    if (!next || next.role !== 'assistant') return false;
    return extractImagesAsAttachedFiles(next.content).some(f => f.gatewayUrl);
  });

  let currentUserInputPaths = new Set<string>();
  return messages.map((rawMessage, idx) => {
    const msg = rawMessage.role === 'user' && rawMessage._attachedFiles?.some((file) => (
      file.disposition !== 'input-reference'
    ))
      ? {
        ...rawMessage,
        _attachedFiles: rawMessage._attachedFiles.map((file) => ({
          ...file,
          source: file.source ?? 'user-upload',
          disposition: 'input-reference' as const,
        })),
      }
      : rawMessage;
    // Only process user and assistant messages.
    if (msg.role !== 'user' && msg.role !== 'assistant') return msg;
    const text = getMessageText(msg.content);

    // Path 0: Gateway-injected outgoing media on this same message
    // (an `assistant-media` bubble  - image block with flat `url`).
    const gatewayMediaFiles: AttachedFileMeta[] = msg.role === 'assistant'
      ? extractImagesAsAttachedFiles(msg.content).filter(file => file.gatewayUrl)
      : [];

    // Path 1: [media attached: path (mime) | path]  - guaranteed format from attachment button
    const mediaRefs = extractMediaRefs(text);
    const mediaRefPaths = new Set(mediaRefs.map(r => r.filePath));
    if (msg.role === 'user') {
      currentUserInputPaths = new Set([
        ...mediaRefs.map((ref) => ref.filePath.trim()),
        ...extractRawFilePaths(text).map((ref) => ref.filePath.trim()),
        ...(msg._attachedFiles ?? []).map((file) => file.filePath?.trim() ?? '').filter(Boolean),
      ]);
    }

    // Path 2: Raw file paths explicitly present in this assistant message.
    // Never inherit paths from the preceding user turn: those are inputs.
    let rawRefs: Array<{ filePath: string; mimeType: string }> = [];
    if (msg.role === 'assistant' && !isToolOnlyMessage(msg)) {
      // Own text
      const ownRawRefs = extractRawFilePaths(text).filter((ref) => (
        !mediaRefPaths.has(ref.filePath)
        && (
          !currentUserInputPaths.has(ref.filePath.trim())
          || hasExplicitMediaDeliveryDirective(text, ref.filePath)
        )
      ));
      rawRefs = ownRawRefs;

    }

    // Dedup vs Gateway-injected bubble: if the very next assistant message
    // is a Gateway `assistant-media` bubble, drop image-typed raw refs on
    // *this* message  - the bubble already covers them.
    if (msg.role === 'assistant' && nextHasGatewayMediaBubble[idx]) {
      rawRefs = rawRefs.filter(r => !r.mimeType.startsWith('image/'));
    }

    const allRefs = [...mediaRefs, ...rawRefs];
    if (allRefs.length === 0 && gatewayMediaFiles.length === 0) {
      // Preserve any previously-attached `_attachedFiles` (e.g. set by
      // `enrichWithToolResultFiles` for non-image artifacts). When nothing
      // new applies, returning `msg` unmodified keeps those attachments.
      return msg;
    }

    const existingFiles = msg._attachedFiles || [];
    const existingPaths = new Set(existingFiles.map(file => file.filePath).filter(Boolean));
    const existingGatewayUrls = new Set(
      existingFiles.map(file => file.gatewayUrl).filter(Boolean) as string[],
    );
    const files: AttachedFileMeta[] = allRefs
      .filter(ref => !existingPaths.has(ref.filePath))
      .filter(ref => !looksLikeRemoteMediaUrl(ref.filePath) || !existingGatewayUrls.has(ref.filePath))
      .map(ref => makeAttachedFile(
        ref,
        msg.role === 'user' ? 'user-upload' : 'message-ref',
        msg.role === 'user' ? 'input-reference' : 'output-delivery',
      ));
    const dedupedGatewayMedia = gatewayMediaFiles.filter(
      file => file.gatewayUrl && !existingGatewayUrls.has(file.gatewayUrl),
    );
    if (files.length === 0 && dedupedGatewayMedia.length === 0) return msg;
    return {
      ...msg,
      _attachedFiles: dedupeAttachedFiles([...existingFiles, ...files, ...dedupedGatewayMedia]),
    };
  });
}

type PreviewRef = { filePath?: string; gatewayUrl?: string; mimeType: string };

const IMAGE_PREVIEW_RETRY_DELAYS_MS = [300, 900, 1800];

function waitForPreviewRetry(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectMissingPreviewRefs(messages: RawMessage[]): PreviewRef[] {
  const needPreview: PreviewRef[] = [];
  const seenKeys = new Set<string>();

  for (const msg of messages) {
    if (!msg._attachedFiles) continue;

    // Path 1: files with explicit filePath OR gatewayUrl
    for (const file of msg._attachedFiles) {
      const key = file.filePath || file.gatewayUrl;
      if (!key || seenKeys.has(key)) continue;
      const needsLoad = file.mimeType.startsWith('image/')
        ? !file.preview && file.previewStatus !== 'unavailable'
        : file.fileSize === 0;
      if (!needsLoad) continue;
      seenKeys.add(key);
      if (file.filePath) {
        needPreview.push({ filePath: file.filePath, mimeType: file.mimeType });
      } else if (file.gatewayUrl) {
        needPreview.push({ gatewayUrl: file.gatewayUrl, mimeType: file.mimeType });
      }
    }

    // Path 2: [media attached: ...] patterns (legacy  - in case filePath wasn't stored)
    if (msg.role === 'user') {
      const text = getMessageText(msg.content);
      const refs = extractMediaRefs(text);
      for (let i = 0; i < refs.length; i++) {
        const file = msg._attachedFiles[i];
        const ref = refs[i];
        if (!file || !ref || seenKeys.has(ref.filePath)) continue;
        const needsLoad = ref.mimeType.startsWith('image/')
          ? !file.preview && file.previewStatus !== 'unavailable'
          : file.fileSize === 0;
        if (needsLoad) {
          seenKeys.add(ref.filePath);
          needPreview.push({ filePath: ref.filePath, mimeType: ref.mimeType });
        }
      }
    }
  }

  return needPreview;
}

function applyPreviewResults(
  messages: RawMessage[],
  thumbnails: Record<string, { preview: string | null; fileSize: number; filePath?: string } & VideoAttachmentMetadata>,
): boolean {
  let updated = false;
  for (const msg of messages) {
    if (!msg._attachedFiles) continue;

    // Update files that have filePath OR gatewayUrl
    for (const file of msg._attachedFiles) {
      const key = file.filePath || file.gatewayUrl;
      if (!key) continue;
      const thumb = thumbnails[key];
      if (thumb && (thumb.preview || thumb.fileSize)) {
        if (thumb.preview) file.preview = thumb.preview;
        if (thumb.fileSize) file.fileSize = thumb.fileSize;
        if (thumb.filePath) file.filePath = thumb.filePath;
        if (thumb.width) file.width = thumb.width;
        if (thumb.height) file.height = thumb.height;
        if (typeof thumb.durationSeconds === 'number') file.durationSeconds = thumb.durationSeconds;
        if (typeof thumb.hasAudio === 'boolean') file.hasAudio = thumb.hasAudio;
        delete file.previewStatus;
        if (file.filePath) {
          _imageCache.set(file.filePath, { ...file });
        }
        updated = true;
      }
    }

    // Legacy: update by index for [media attached: ...] refs
    if (msg.role === 'user') {
      const text = getMessageText(msg.content);
      const refs = extractMediaRefs(text);
      for (let i = 0; i < refs.length; i++) {
        const file = msg._attachedFiles[i];
        const ref = refs[i];
        if (!file || !ref || file.filePath) continue; // skip if already handled via filePath
        const thumb = thumbnails[ref.filePath];
        if (thumb && (thumb.preview || thumb.fileSize)) {
          if (thumb.preview) file.preview = thumb.preview;
          if (thumb.fileSize) file.fileSize = thumb.fileSize;
          if (thumb.filePath) file.filePath = thumb.filePath;
          if (thumb.width) file.width = thumb.width;
          if (thumb.height) file.height = thumb.height;
          if (typeof thumb.durationSeconds === 'number') file.durationSeconds = thumb.durationSeconds;
          if (typeof thumb.hasAudio === 'boolean') file.hasAudio = thumb.hasAudio;
          delete file.previewStatus;
          _imageCache.set(ref.filePath, { ...file });
          updated = true;
        }
      }
    }
  }

  if (updated) saveImageCache(_imageCache);
  return updated;
}

function markMissingImagePreviewsUnavailable(messages: RawMessage[]): boolean {
  let updated = false;
  for (const msg of messages) {
    if (!msg._attachedFiles) continue;
    for (const file of msg._attachedFiles) {
      if (!file.mimeType.startsWith('image/')) continue;
      if (file.preview || file.previewStatus === 'unavailable') continue;
      if (!file.filePath && !file.gatewayUrl) continue;
      file.previewStatus = 'unavailable';
      updated = true;
    }
  }
  return updated;
}

/**
 * Async: load missing previews from disk via IPC for messages that have
 * _attachedFiles with null previews. Updates messages in-place and triggers re-render.
 * Handles both [media attached: ...] patterns and raw filePath entries.
 */
async function loadMissingPreviews(messages: RawMessage[]): Promise<boolean> {
  // See helpers.ts loadMissingPreviews for the canonical comment block  -
  // this monolithic copy is kept in sync so legacy chat.ts callers also
  // resolve Gateway-injected outgoing media URLs into local previews.
  let updatedAny = false;
  let attempt = 0;

  while (true) {
    const needPreview = collectMissingPreviewRefs(messages);
    if (needPreview.length === 0) return updatedAny;
    if (attempt > 0) {
      const delayMs = IMAGE_PREVIEW_RETRY_DELAYS_MS[attempt - 1];
      if (delayMs) await waitForPreviewRetry(delayMs);
    }

    try {
      const thumbnails = await hostApiFetch<Record<string, { preview: string | null; fileSize: number; filePath?: string } & VideoAttachmentMetadata>>(
        '/api/files/thumbnails',
        {
          method: 'POST',
          body: JSON.stringify({ paths: needPreview }),
        },
      );
      if (applyPreviewResults(messages, thumbnails)) {
        updatedAny = true;
      }
    } catch (err) {
      console.warn('[loadMissingPreviews] Failed:', err);
      return updatedAny;
    }

    if (!collectMissingPreviewRefs(messages).some((ref) => ref.mimeType.startsWith('image/'))) {
      return updatedAny;
    }
    if (attempt >= IMAGE_PREVIEW_RETRY_DELAYS_MS.length) {
      return markMissingImagePreviewsUnavailable(messages) || updatedAny;
    }
    attempt += 1;
  }
}

function getCanonicalPrefixFromSessions(sessions: ChatSession[]): string | null {
  const canonical = sessions.find((s) => s.key.startsWith('agent:'))?.key;
  if (!canonical) return null;
  const parts = canonical.split(':');
  if (parts.length < 2) return null;
  return `${parts[0]}:${parts[1]}`;
}

function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  const parts = sessionKey.split(':');
  return parts[1] || 'main';
}

function parseSessionUpdatedAtMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return toMs(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseSessionStatus(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}

type GatewayHistorySessionAuthority = {
  session: ChatSession;
  inFlightRunId?: string;
  requestStartedAt: number;
  explicitlyActive: boolean;
  explicitlyIdle: boolean;
};

function parseGatewayHistorySessionAuthority(
  data: Record<string, unknown>,
  sessionKey: string,
  requestStartedAt: number,
): GatewayHistorySessionAuthority | undefined {
  const sessionInfo = data.sessionInfo && typeof data.sessionInfo === 'object' && !Array.isArray(data.sessionInfo)
    ? data.sessionInfo as Record<string, unknown>
    : undefined;
  const inFlightRun = data.inFlightRun && typeof data.inFlightRun === 'object' && !Array.isArray(data.inFlightRun)
    ? data.inFlightRun as Record<string, unknown>
    : undefined;
  const inFlightRunId = typeof inFlightRun?.runId === 'string' && inFlightRun.runId.trim()
    ? inFlightRun.runId.trim()
    : undefined;
  const reportedActive = typeof sessionInfo?.hasActiveRun === 'boolean'
    ? sessionInfo.hasActiveRun
    : undefined;
  const status = parseSessionStatus(sessionInfo?.status);
  const statusReportsActive = reportedActive == null && (status === 'running' || status === 'active');
  const terminalStatus = getSessionTerminalRuntimeStatus(status);
  const explicitlyActive = Boolean(inFlightRunId || reportedActive === true || statusReportsActive);
  const explicitlyIdle = !explicitlyActive
    && (reportedActive === false || (reportedActive == null && terminalStatus != null));
  if (!sessionInfo && !inFlightRunId) return undefined;

  const updatedAt = parseSessionUpdatedAtMs(sessionInfo?.updatedAt);
  return {
    session: {
      key: sessionKey,
      ...(updatedAt != null ? { updatedAt } : {}),
      ...(status ? { status } : {}),
      ...(reportedActive != null || inFlightRunId
        ? { hasActiveRun: explicitlyActive }
        : {}),
    },
    inFlightRunId,
    requestStartedAt,
    explicitlyActive,
    explicitlyIdle,
  };
}

function getSessionTerminalRuntimeStatus(
  status: string | undefined,
): Extract<ChatRuntimeEvent, { type: 'run.ended' }>['status'] | undefined {
  if (status === 'done' || status === 'completed' || status === 'finished') return 'completed';
  if (status === 'failed' || status === 'error') return 'error';
  if (status === 'aborted' || status === 'cancelled') return 'aborted';
  return undefined;
}

function getBackendSessionLifecycle(session: ChatSession | undefined): {
  idle: boolean;
  terminalStatus?: Extract<ChatRuntimeEvent, { type: 'run.ended' }>['status'];
} {
  if (!session) return { idle: false };
  const terminalStatus = getSessionTerminalRuntimeStatus(session.status);
  if (session.hasActiveRun === true) {
    return { idle: false };
  }
  if (session.hasActiveRun === false) {
    return { idle: true, terminalStatus };
  }
  if (session.status === 'running' || session.status === 'active') {
    return { idle: false };
  }
  if (terminalStatus) {
    return { idle: true, terminalStatus };
  }
  return { idle: false };
}

function backendSessionReportsActive(session: ChatSession | undefined): boolean {
  if (!session) return false;
  if (session.hasActiveRun === true) return true;
  if (session.hasActiveRun === false) return false;
  return session.status === 'running' || session.status === 'active';
}

function shouldTrustBackendSessionIdle(
  session: ChatSession | undefined,
  lastUserMessageAt: number | null,
): boolean {
  const lifecycle = getBackendSessionLifecycle(session);
  if (!lifecycle.idle) return false;
  if (
    lastUserMessageAt != null
    && typeof session?.updatedAt === 'number'
    && session.updatedAt < toMs(lastUserMessageAt)
  ) {
    return false;
  }
  return true;
}

function findRunningRuntimeRunForSession(
  runtimeRuns: ChatState['runtimeRuns'],
  sessionKey: string,
  preferredRunId?: string | null,
): ChatState['runtimeRuns'][string] | undefined {
  const preferredRun = preferredRunId ? runtimeRuns[preferredRunId] : undefined;
  if (preferredRun?.sessionKey === sessionKey && preferredRun.status === 'running') {
    return preferredRun;
  }

  let latestRunningRun: ChatState['runtimeRuns'][string] | undefined;
  let latestRunningRunActivity = -Infinity;
  for (const run of Object.values(runtimeRuns)) {
    if (run.sessionKey !== sessionKey || run.status !== 'running') continue;
    const activityAt = optionalToMs(run.lastEventAt) ?? optionalToMs(run.startedAt) ?? 0;
    if (!latestRunningRun || activityAt >= latestRunningRunActivity) {
      latestRunningRun = run;
      latestRunningRunActivity = activityAt;
    }
  }

  return latestRunningRun;
}

function alignRuntimeRunsWithBackendSessionTerminalState(
  runtimeRuns: ChatState['runtimeRuns'],
  sessionKey: string,
  session: ChatSession | undefined,
  preferredRunId?: string | null,
): ChatState['runtimeRuns'] {
  const { terminalStatus } = getBackendSessionLifecycle(session);
  if (!terminalStatus) return runtimeRuns;

  const runningRun = findRunningRuntimeRunForSession(runtimeRuns, sessionKey, preferredRunId);
  if (!runningRun) return runtimeRuns;
  if (runtimeRunHasPendingAsyncTasks(runningRun)) return runtimeRuns;

  const ts = session?.updatedAt ?? Date.now();
  return applyRuntimeContractEvents(runtimeRuns, [{
    runId: runningRun.runId,
    sessionKey,
    ts,
    type: 'run.ended',
    status: terminalStatus,
  } satisfies ChatRuntimeEvent]);
}

function reconcileCurrentSessionIdleFromBackend(
  set: (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
  sessions: ChatSession[],
): void {
  const state = get();
  if (!state.sending && state.activeRunId == null && !state.pendingFinal) return;
  const current = sessions.find((session) => session.key === state.currentSessionKey);
  if (!shouldTrustBackendSessionIdle(current, state.lastUserMessageAt)) return;

  const runtimeRuns = alignRuntimeRunsWithBackendSessionTerminalState(
    state.runtimeRuns,
    state.currentSessionKey,
    current,
    state.activeRunId,
  );

  set({
    runtimeRuns,
    sending: false,
    pendingImageGenerationLocal: false,
    pendingVideoGenerationLocal: false,
    activeRunId: null,
    pendingFinal: false,
    lastUserMessageAt: null,
    streamingText: '',
    streamingMessage: null,
    streamingTools: [],
    pendingToolImages: [],
  });
  markSessionRunIdle(state.currentSessionKey);
  clearPendingRuntimeIntent(state.currentSessionKey);
}

/** Reconciles the visible session lifecycle from OpenClaw's authoritative session row. */
function reconcileCurrentSessionLifecycleFromBackend(
  set: (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
  sessions: ChatSession[],
): void {
  const state = get();
  const current = sessions.find((session) => session.key === state.currentSessionKey);
  if (backendSessionReportsActive(current)) {
    if (state.sending || state.activeRunId != null || state.pendingFinal) return;
    set({
      sending: true,
      lastUserMessageAt: state.lastUserMessageAt ?? current?.updatedAt ?? Date.now(),
      error: null,
      runError: null,
    });
    captureSessionRunState(state.currentSessionKey, get());
    return;
  }

  reconcileCurrentSessionIdleFromBackend(set, get, sessions);
}

async function loadCronFallbackMessages(sessionKey: string, limit = 200): Promise<RawMessage[]> {
  if (!isCronSessionKey(sessionKey)) return [];
  try {
    const response = await hostApiFetch<{ messages?: RawMessage[] }>(
      buildCronSessionHistoryPath(sessionKey, limit),
    );
    return Array.isArray(response.messages) ? response.messages : [];
  } catch (error) {
    console.warn('Failed to load cron fallback history:', error);
    return [];
  }
}

async function fetchChatSessionsList(): Promise<Record<string, unknown>> {
  try {
    const response = await hostApiFetch<{
      success: boolean;
      result?: Record<string, unknown>;
      error?: string;
    }>('/api/chat/sessions');
    if (response.success && response.result) {
      return response.result;
    }
    throw new Error(response.error || 'Failed to load chat sessions');
  } catch {
    return await useGatewayStore.getState().rpc<Record<string, unknown>>('sessions.list', {
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
  }
}

type GatewaySessionMutationResult = {
  ok?: boolean;
  key?: string;
  entry?: Record<string, unknown>;
  resolved?: {
    modelProvider?: unknown;
    model?: unknown;
  };
};

function buildEffectiveSessionCwd(result: GatewaySessionMutationResult | null | undefined): string | null {
  const cwd = result?.entry?.cwd;
  return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null;
}

function buildSessionModelRef(
  model: unknown,
  modelProvider?: unknown,
): string | undefined {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) return undefined;
  const normalizedProvider = typeof modelProvider === 'string' ? modelProvider.trim() : '';
  const modelRef = !normalizedProvider ? normalizedModel : normalizedModel.startsWith(`${normalizedProvider}/`)
    ? normalizedModel
    : `${normalizedProvider}/${normalizedModel}`;
  return normalizeChatManagedModelRef(modelRef) ?? undefined;
}

function normalizeChatManagedModelRef(
  modelRef: string | null | undefined,
  options?: { fallbackEmpty?: boolean },
): string | null {
  return normalizeManagedTextModelRef(
    modelRef,
    useClientConfigStore.getState().modelOptions,
    options,
  );
}

function resolveEffectiveAgentModelRefForSession(sessionKey: string): string | null {
  const agentId = getAgentIdFromSessionKey(sessionKey);
  const { agents, defaultModelRef } = useAgentsStore.getState();
  const agent = agents.find((entry) => entry.id === agentId);
  const agentModelRef = typeof agent?.modelRef === 'string' ? agent.modelRef.trim() : '';
  const fallbackModelRef = typeof defaultModelRef === 'string' ? defaultModelRef.trim() : '';
  return normalizeChatManagedModelRef(agentModelRef || fallbackModelRef || null, { fallbackEmpty: true });
}

function buildEffectiveSessionModelRef(result: GatewaySessionMutationResult | null | undefined): string | null {
  const resolvedModelRef = buildSessionModelRef(result?.resolved?.model, result?.resolved?.modelProvider);
  if (resolvedModelRef) return resolvedModelRef;

  const entry = result?.entry;
  const entryModelRef = buildSessionModelRef(entry?.model, entry?.modelProvider);
  if (entryModelRef) return entryModelRef;

  const overrideModelRef = buildSessionModelRef(entry?.modelOverride, entry?.providerOverride);
  if (overrideModelRef) return overrideModelRef;

  return normalizeChatManagedModelRef(null);
}

function upsertSessionWithModel(
  sessions: ChatSession[],
  sessionKey: string,
  modelRef: string | null,
  updatedAt: number,
): ChatSession[] {
  const nextModelRef = normalizeChatManagedModelRef(
    modelRef ?? resolveEffectiveAgentModelRefForSession(sessionKey) ?? null,
    { fallbackEmpty: true },
  ) ?? undefined;
  let found = false;
  const nextSessions = sessions.map((session) => {
    if (session.key !== sessionKey) return session;
    found = true;
    return {
      ...session,
      model: nextModelRef,
      updatedAt,
    };
  });

  if (found) return nextSessions;

  return [
    ...nextSessions,
    {
      key: sessionKey,
      displayName: sessionKey,
      model: nextModelRef,
      updatedAt,
    },
  ];
}

function upsertSessionWithThinking(
  sessions: ChatSession[],
  sessionKey: string,
  thinkingLevel: string | null,
  updatedAt: number,
): ChatSession[] {
  const normalizedThinkingLevel = thinkingLevel?.trim() || undefined;
  let found = false;
  const nextSessions = sessions.map((session) => {
    if (session.key !== sessionKey) return session;
    found = true;
    return { ...session, thinkingLevel: normalizedThinkingLevel, updatedAt };
  });
  return found
    ? nextSessions
    : [...nextSessions, { key: sessionKey, displayName: sessionKey, thinkingLevel: normalizedThinkingLevel, updatedAt }];
}

function upsertSessionWithCwd(
  sessions: ChatSession[],
  sessionKey: string,
  cwd: string | null,
  updatedAt: number,
): ChatSession[] {
  const normalizedCwd = cwd?.trim() || undefined;
  let found = false;
  const nextSessions = sessions.map((session) => {
    if (session.key !== sessionKey) return session;
    found = true;
    return { ...session, cwd: normalizedCwd, updatedAt };
  });
  return found
    ? nextSessions
    : [...nextSessions, { key: sessionKey, displayName: sessionKey, cwd: normalizedCwd, updatedAt }];
}

async function persistSessionCwdSelection(sessionKey: string, cwd: string | null): Promise<string | null> {
  const normalizedCwd = cwd?.trim() || null;
  if (_pendingLocalSessionKeys.has(sessionKey)) {
    const created = await useGatewayStore.getState().rpc<GatewaySessionMutationResult>('sessions.create', {
      key: sessionKey,
      agentId: getAgentIdFromSessionKey(sessionKey),
      cwd: normalizedCwd,
    });
    _pendingLocalSessionKeys.delete(sessionKey);
    return buildEffectiveSessionCwd(created) ?? normalizedCwd;
  }
  const patched = await useGatewayStore.getState().rpc<GatewaySessionMutationResult>('sessions.patch', {
    key: sessionKey,
    cwd: normalizedCwd,
  });
  return buildEffectiveSessionCwd(patched) ?? normalizedCwd;
}

async function persistSessionModelSelection(
  sessionKey: string,
  modelRef: string | null,
): Promise<string | null> {
  const normalizedModelRef = normalizeChatManagedModelRef(modelRef);
  if (_pendingLocalSessionKeys.has(sessionKey)) {
    const created = await useGatewayStore.getState().rpc<GatewaySessionMutationResult>('sessions.create', {
      key: sessionKey,
      agentId: getAgentIdFromSessionKey(sessionKey),
      ...(normalizedModelRef ? { model: normalizedModelRef } : {}),
    });
    _pendingLocalSessionKeys.delete(sessionKey);
    return buildEffectiveSessionModelRef(created) ?? normalizedModelRef ?? resolveEffectiveAgentModelRefForSession(sessionKey);
  }

  const patched = await useGatewayStore.getState().rpc<GatewaySessionMutationResult>('sessions.patch', {
    key: sessionKey,
    model: normalizedModelRef,
  });
  return buildEffectiveSessionModelRef(patched) ?? normalizedModelRef ?? resolveEffectiveAgentModelRefForSession(sessionKey);
}

async function persistSessionThinkingSelection(
  sessionKey: string,
  thinkingLevel: string | null,
): Promise<string | null> {
  const normalizedThinkingLevel = thinkingLevel?.trim() || null;
  if (_pendingLocalSessionKeys.has(sessionKey)) {
    // OpenClaw creates the session before it accepts a thinking-level override.
    await useGatewayStore.getState().rpc<GatewaySessionMutationResult>('sessions.create', {
      key: sessionKey,
      agentId: getAgentIdFromSessionKey(sessionKey),
    });
    _pendingLocalSessionKeys.delete(sessionKey);
  }

  const patched = await useGatewayStore.getState().rpc<GatewaySessionMutationResult>('sessions.patch', {
    key: sessionKey,
    thinkingLevel: normalizedThinkingLevel,
  });
  const resolved = patched.entry?.thinkingLevel;
  return typeof resolved === 'string' && resolved.trim() ? resolved.trim() : normalizedThinkingLevel;
}

function mergeSessionRowWithLocalState(
  nextSession: ChatSession,
  localSession: ChatSession | undefined,
): ChatSession {
  const normalizedNextSession = {
    ...nextSession,
    model: normalizeChatManagedModelRef(nextSession.model) ?? undefined,
    cwd: nextSession.cwd?.trim() || undefined,
  };
  if (!localSession) return normalizedNextSession;

  const localUpdatedAt = typeof localSession.updatedAt === 'number' ? localSession.updatedAt : undefined;
  const nextUpdatedAt = typeof normalizedNextSession.updatedAt === 'number' ? normalizedNextSession.updatedAt : undefined;
  const normalizedLocalModel = normalizeChatManagedModelRef(localSession.model) ?? undefined;
  const normalizedLocalCwd = localSession.cwd?.trim() || undefined;
  const shouldPreserveLocalModel = Boolean(
    normalizedLocalModel
    && (
      !normalizedNextSession.model
      || (localUpdatedAt != null && nextUpdatedAt != null && localUpdatedAt > nextUpdatedAt)
    ),
  );
  const shouldPreserveLocalCwd = Boolean(
    (!normalizedNextSession.cwd && normalizedLocalCwd)
    || (localUpdatedAt != null && nextUpdatedAt != null && localUpdatedAt > nextUpdatedAt),
  );

  return {
    ...normalizedNextSession,
    model: shouldPreserveLocalModel ? normalizedLocalModel : normalizedNextSession.model,
    cwd: shouldPreserveLocalCwd ? normalizedLocalCwd : normalizedNextSession.cwd,
    updatedAt: shouldPreserveLocalModel || shouldPreserveLocalCwd ? localUpdatedAt : nextUpdatedAt,
  };
}

async function ensureSessionManagedTextModelAllowed(
  get: ChatGet,
  sessionKey: string,
): Promise<void> {
  const currentSessionModel = get().sessions.find((session) => session.key === sessionKey)?.model ?? null;
  const currentModelRef = currentSessionModel || resolveEffectiveAgentModelRefForSession(sessionKey);
  const normalizedModelRef = normalizeChatManagedModelRef(currentModelRef, { fallbackEmpty: true });
  if (!normalizedModelRef || normalizedModelRef === currentModelRef) {
    return;
  }
  await get().updateSessionModel(sessionKey, normalizedModelRef);
}

async function fetchChatHistory(
  sessionKey: string,
  limit: number,
  maxChars?: number,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const params = {
    sessionKey,
    limit,
    ...(typeof maxChars === 'number' ? { maxChars } : {}),
  };
  try {
    const response = await hostApiFetch<{
      success: boolean;
      result?: Record<string, unknown>;
      error?: string;
    }>('/api/chat/history', {
      method: 'POST',
      body: JSON.stringify({
        ...params,
        ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
      }),
    });
    if (response.success && response.result) {
      return response.result;
    }
    throw new Error(response.error || 'Failed to load chat history');
  } catch {
    return await useGatewayStore.getState().rpc<Record<string, unknown>>('chat.history', params, timeoutMs);
  }
}

class GatewayNotReadyForChatSendError extends Error {
  readonly status: GatewayStatus | null;

  constructor(message: string, status: GatewayStatus | null = null) {
    super(message);
    this.name = 'GatewayNotReadyForChatSendError';
    this.status = status;
  }
}

function gatewayNotReadySendMessage(detail?: string): string {
  return i18n.t('chat:gatewaySend.notConnected', {
    defaultValue: 'Gateway is not connected. Your message was not sent. Reconnect Gateway and retry.',
    ...(detail ? { detail } : {}),
  });
}

/**
 * Renderer lifecycle events are advisory. Before accepting a user turn, read
 * the Main-process lifecycle state so a stale "running" event cannot create
 * a message bubble for a request that cannot be delivered.
 */
async function assertGatewayReadyForChatSend(): Promise<GatewayStatus> {
  let status: GatewayStatus;
  try {
    status = await useGatewayStore.getState().refreshStatus();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GatewayNotReadyForChatSendError(gatewayNotReadySendMessage(detail));
  }

  if (!isGatewayReadyForChatSend(status)) {
    throw new GatewayNotReadyForChatSendError(gatewayNotReadySendMessage(), status);
  }
  return status;
}

async function gatewayIsUnavailableForChatSend(): Promise<boolean> {
  try {
    const status = await useGatewayStore.getState().refreshStatus();
    return !isGatewayReadyForChatSend(status);
  } catch {
    // Status cannot be verified, so do not present a successful send state.
    return true;
  }
}

async function sendChatMessageViaHostApi(params: {
  sessionKey: string;
  message: string;
  deliver?: boolean;
  idempotencyKey: string;
  thinking?: string | null;
  clientPreferences?: GatewayTurnPreferences;
}): Promise<{ runId?: string }> {
  await assertGatewayReadyForChatSend();
  try {
    const response = await hostApiFetch<{
      success: boolean;
      result?: { runId?: string };
      error?: string;
    }>('/api/chat/send', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    if (!response.success) {
      throw new Error(response.error || 'Failed to send chat message');
    }
    return response.result ?? {};
  } catch {
    await assertGatewayReadyForChatSend();
    return await useGatewayStore.getState().rpc<{ runId?: string }>('chat.send', params, CHAT_SEND_RPC_TIMEOUT_MS);
  }
}

async function abortChatRunViaHostApi(sessionKey: string, runId?: string | null, taskIds: string[] = []): Promise<void> {
  try {
    const response = await hostApiFetch<{
      success: boolean;
      error?: string;
    }>('/api/chat/abort', {
      method: 'POST',
      body: JSON.stringify({
        sessionKey,
        ...(runId ? { runId } : {}),
        ...(taskIds.length > 0 ? { taskIds } : {}),
      }),
    });
    if (!response.success) {
      throw new Error(response.error || 'Failed to abort chat run');
    }
  } catch {
    await Promise.allSettled(taskIds.map((taskId) => useGatewayStore.getState().rpc('tasks.cancel', {
      taskId,
      reason: 'Cancelled from the UClaw chat composer.',
    })));
    await useGatewayStore.getState().rpc('chat.abort', { sessionKey, ...(runId ? { runId } : {}) });
  }
}

function normalizeAgentId(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase() || 'main';
}

function buildFallbackMainSessionKey(agentId: string): string {
  return `agent:${normalizeAgentId(agentId)}:main`;
}

function resolveMainSessionKeyForAgent(agentId: string | undefined | null): string | null {
  if (!agentId) return null;
  const normalizedAgentId = normalizeAgentId(agentId);
  const summary = useAgentsStore.getState().agents.find((agent) => agent.id === normalizedAgentId);
  return summary?.mainSessionKey || buildFallbackMainSessionKey(normalizedAgentId);
}

function ensureSessionEntry(sessions: ChatSession[], sessionKey: string): ChatSession[] {
  if (sessions.some((session) => session.key === sessionKey)) {
    return sessions;
  }
  return [...sessions, { key: sessionKey, displayName: sessionKey }];
}

function clearSessionEntryFromMap<T extends Record<string, unknown>>(entries: T, sessionKey: string): T {
  return Object.fromEntries(Object.entries(entries).filter(([key]) => key !== sessionKey)) as T;
}

function buildSessionSwitchPatch(
  state: Pick<
    ChatState,
    | 'currentSessionKey'
    | 'messages'
    | 'sessions'
    | 'sessionLabels'
    | 'sessionLastActivity'
    | 'thinkingLevel'
    | 'sending'
    | 'pendingImageGenerationLocal'
    | 'pendingVideoGenerationLocal'
    | 'activeRunId'
    | 'pendingFinal'
    | 'lastUserMessageAt'
    | 'streamingText'
    | 'streamingMessage'
    | 'streamingTools'
    | 'pendingToolImages'
  >,
  nextSessionKey: string,
): Partial<ChatState> {
  captureSessionRunState(state.currentSessionKey, state);
  if (state.messages.length > 0) {
    cacheSessionHistory(
      state.currentSessionKey,
      cloneHistoryMessages(state.messages),
      state.thinkingLevel ?? null,
    );
  }
  // Only treat sessions with no history records and no activity timestamp as empty.
  // Relying solely on messages.length is unreliable because switchSession clears
  // the current messages before loadHistory runs, creating a race condition that
  // could cause sessions with real history to be incorrectly removed from the sidebar.
  const leavingEmpty = !state.currentSessionKey.endsWith(':main')
    && state.messages.length === 0
    && !state.sessionLastActivity[state.currentSessionKey]
    && !state.sessionLabels[state.currentSessionKey];
  if (leavingEmpty) {
    _pendingLocalSessionKeys.delete(state.currentSessionKey);
  }

  const nextSessions = leavingEmpty
    ? state.sessions.filter((session) => session.key !== state.currentSessionKey)
    : state.sessions;
  const cachedNextSession = getCachedSessionHistory(nextSessionKey);
  const cachedMessages = cachedNextSession?.messages ?? [];
  const restoredCachedMessages = cachedMessages.length > SESSION_SWITCH_RESTORE_MESSAGE_LIMIT
    ? cachedMessages.slice(-SESSION_SWITCH_RESTORE_MESSAGE_LIMIT)
    : cachedMessages;
  const cachedRunState = getCachedSessionRunState(nextSessionKey);

  return {
    currentSessionKey: nextSessionKey,
    currentAgentId: getAgentIdFromSessionKey(nextSessionKey),
    sessions: ensureSessionEntry(nextSessions, nextSessionKey),
    sessionLabels: leavingEmpty
      ? clearSessionEntryFromMap(state.sessionLabels, state.currentSessionKey)
      : state.sessionLabels,
    sessionLastActivity: leavingEmpty
      ? clearSessionEntryFromMap(state.sessionLastActivity, state.currentSessionKey)
      : state.sessionLastActivity,
    messages: restoredCachedMessages,
    hasMoreHistory: cachedNextSession
      ? cachedNextSession.messages.length >= HISTORY_PAGE_SIZE
        || cachedNextSession.messages.length > restoredCachedMessages.length
      : false,
    loadingMoreHistory: false,
    thinkingLevel: cachedNextSession?.thinkingLevel ?? state.thinkingLevel ?? null,
    ...cachedRunState,
    error: null,
    runError: null,
  };
}

function getCanonicalPrefixFromSessionKey(sessionKey: string): string | null {
  if (!sessionKey.startsWith('agent:')) return null;
  const parts = sessionKey.split(':');
  if (parts.length < 2) return null;
  return `${parts[0]}:${parts[1]}`;
}

function isUserVisibleMediaBlockType(type: ContentBlock['type']): boolean {
  return type === 'image' || type === 'video' || type === 'audio' || type === 'file';
}

function isToolOnlyMessage(message: RawMessage | undefined): boolean {
  if (!message) return false;
  if (isToolResultRole(message.role)) return true;

  const msg = message as unknown as Record<string, unknown>;
  const content = message.content;

  // Check OpenAI-format tool_calls field (real-time streaming from OpenAI-compatible models)
  const toolCalls = msg.tool_calls ?? msg.toolCalls;
  const hasOpenAITools = Array.isArray(toolCalls) && toolCalls.length > 0;

  if (!Array.isArray(content)) {
    // Content is not an array  - check if there's OpenAI-format tool_calls
    if (hasOpenAITools) {
      // Has tool calls but content might be empty/string  - treat as tool-only
      // if there's no meaningful text content
      const textContent = typeof content === 'string' ? content.trim() : '';
      return textContent.length === 0;
    }
    return false;
  }

  let hasTool = hasOpenAITools;
  let hasText = false;
  let hasNonToolContent = false;

  for (const block of content as ContentBlock[]) {
    if (block.type === 'tool_use' || block.type === 'tool_result' || block.type === 'toolCall' || block.type === 'toolResult') {
      hasTool = true;
      continue;
    }
    if (block.type === 'text' && block.text && block.text.trim()) {
      hasText = true;
      continue;
    }
    // User-visible media output disqualifies a tool-only message.
    // Thinking blocks are internal reasoning that can accompany tool_use  - they
    // should NOT prevent the message from being treated as an intermediate tool step.
    if (isUserVisibleMediaBlockType(block.type)) {
      hasNonToolContent = true;
    }
  }

  return hasTool && !hasText && !hasNonToolContent;
}

function isToolResultRole(role: unknown): boolean {
  if (!role) return false;
  const normalized = String(role).toLowerCase();
  return normalized === 'toolresult' || normalized === 'tool_result';
}

/** True for internal plumbing messages that should never be shown in the UI. */
function isInternalMessage(msg: { role?: unknown; content?: unknown; idempotencyKey?: unknown; model?: unknown; text?: unknown }): boolean {
  return isHistoryInternalMessage(msg);
}

// ── Write tool_use baseline capture ─────────────────────────────
//
// Tool name sets mirror generated-files.ts so we detect the same tools.
const BASELINE_WRITE_TOOLS = new Set([
  'Write', 'write_file', 'create_file', 'WriteFile', 'createFile', 'write',
]);
const BASELINE_EDIT_TOOLS = new Set([
  'Edit', 'edit', 'edit_file', 'EditFile',
  'StrReplace', 'str_replace', 'str_replace_editor',
  'MultiEdit', 'multi_edit', 'multiEdit',
]);
const BASELINE_FILE_PATH_KEYS = ['file_path', 'filepath', 'path', 'fileName', 'file_name', 'target_path'];

function pickFilePathFromInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  for (const key of BASELINE_FILE_PATH_KEYS) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Scan a streaming message for Write/Edit tool_use blocks and trigger
 * async baseline reads from disk for each target file.  Called on every
 * `delta` event; `captureBaseline` is idempotent  - duplicate calls for
 * the same path are no-ops.
 */
function isBaselineRealUserMessage(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'user') return false;
  if (isInternalMessage(message)) return false;
  const content = message.content;
  if (!Array.isArray(content)) return true;
  const blocks = content as Array<{ type?: string }>;
  return blocks.length === 0 || !blocks.every((block) => block.type === 'tool_result' || block.type === 'toolResult');
}

function countBaselineRealUserMessages(messages: RawMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (isBaselineRealUserMessage(message)) count += 1;
  }
  return count;
}

function getBaselineRunKeyForMessages(sessionKey: string, messages: RawMessage[]): string | null {
  const userTurnOrdinal = countBaselineRealUserMessages(messages);
  return buildBaselineRunKey(sessionKey, userTurnOrdinal);
}

function captureBaselinesFromMessage(message: unknown, runKey: string | null): void {
  if (!runKey || !message || typeof message !== 'object') return;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return;
  for (const block of content as ContentBlock[]) {
    if (block.type !== 'tool_use' && block.type !== 'toolCall') continue;
    const name = typeof block.name === 'string' ? block.name : '';
    if (!name) continue;
    if (!BASELINE_WRITE_TOOLS.has(name) && !BASELINE_EDIT_TOOLS.has(name)) continue;
    const input = block.input ?? block.arguments;
    const filePath = pickFilePathFromInput(input);
    if (filePath) captureBaseline(runKey, filePath);
  }
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function summarizeToolOutput(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  const summaryLines = lines.slice(0, 2);
  let summary = summaryLines.join(' / ');
  if (summary.length > 160) {
    summary = `${summary.slice(0, 157)}...`;
  }
  return summary;
}

function normalizeToolStatus(rawStatus: unknown, fallback: 'running' | 'completed'): ToolStatus['status'] {
  const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';
  if (status === 'error' || status === 'failed') return 'error';
  if (status === 'completed' || status === 'success' || status === 'done') return 'completed';
  return fallback;
}

function parseDurationMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractToolUseUpdates(message: unknown): ToolStatus[] {
  if (!message || typeof message !== 'object') return [];
  const msg = message as Record<string, unknown>;
  const updates: ToolStatus[] = [];

  // Path 1: Anthropic/normalized format  - tool blocks inside content array
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if ((block.type !== 'tool_use' && block.type !== 'toolCall') || !block.name) continue;
      updates.push({
        id: block.id || block.name,
        toolCallId: block.id,
        name: block.name,
        status: 'running',
        updatedAt: Date.now(),
      });
    }
  }

  // Path 2: OpenAI format  - tool_calls array on the message itself
  if (updates.length === 0) {
    const toolCalls = msg.tool_calls ?? msg.toolCalls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls as Array<Record<string, unknown>>) {
        const fn = (tc.function ?? tc) as Record<string, unknown>;
        const name = typeof fn.name === 'string' ? fn.name : '';
        if (!name) continue;
        const id = typeof tc.id === 'string' ? tc.id : name;
        updates.push({
          id,
          toolCallId: typeof tc.id === 'string' ? tc.id : undefined,
          name,
          status: 'running',
          updatedAt: Date.now(),
        });
      }
    }
  }

  return updates;
}

function extractToolResultBlocks(message: unknown, eventState: string): ToolStatus[] {
  if (!message || typeof message !== 'object') return [];
  const msg = message as Record<string, unknown>;
  const content = msg.content;
  if (!Array.isArray(content)) return [];

  const updates: ToolStatus[] = [];
  for (const block of content as ContentBlock[]) {
    if (block.type !== 'tool_result' && block.type !== 'toolResult') continue;
    const outputText = extractTextFromContent(block.content ?? block.text ?? '');
    const summary = summarizeToolOutput(outputText);
    updates.push({
      id: block.id || block.name || 'tool',
      toolCallId: block.id,
      name: block.name || block.id || 'tool',
      status: normalizeToolStatus(undefined, eventState === 'delta' ? 'running' : 'completed'),
      summary,
      updatedAt: Date.now(),
    });
  }

  return updates;
}

function extractToolResultUpdate(message: unknown, eventState: string): ToolStatus | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  const role = typeof msg.role === 'string' ? msg.role.toLowerCase() : '';
  if (!isToolResultRole(role)) return null;

  const toolName = typeof msg.toolName === 'string' ? msg.toolName : (typeof msg.name === 'string' ? msg.name : '');
  const toolCallId = typeof msg.toolCallId === 'string' ? msg.toolCallId : undefined;
  const details = (msg.details && typeof msg.details === 'object') ? msg.details as Record<string, unknown> : undefined;
  const rawStatus = (msg.status ?? details?.status);
  const fallback = eventState === 'delta' ? 'running' : 'completed';
  const status = normalizeToolStatus(rawStatus, fallback);
  const durationMs = parseDurationMs(details?.durationMs ?? details?.duration ?? (msg as Record<string, unknown>).durationMs);

  const outputText = (details && typeof details.aggregated === 'string')
    ? details.aggregated
    : extractTextFromContent(msg.content);
  const summary = summarizeToolOutput(outputText) ?? summarizeToolOutput(String(details?.error ?? msg.error ?? ''));

  const name = toolName || toolCallId || 'tool';
  const id = toolCallId || name;

  return {
    id,
    toolCallId,
    name,
    status,
    durationMs,
    summary,
    updatedAt: Date.now(),
  };
}

function mergeToolStatus(existing: ToolStatus['status'], incoming: ToolStatus['status']): ToolStatus['status'] {
  const order: Record<ToolStatus['status'], number> = { running: 0, completed: 1, error: 2 };
  return order[incoming] >= order[existing] ? incoming : existing;
}

function upsertToolStatuses(current: ToolStatus[], updates: ToolStatus[]): ToolStatus[] {
  if (updates.length === 0) return current;
  const next = [...current];
  for (const update of updates) {
    const key = update.toolCallId || update.id || update.name;
    if (!key) continue;
    const index = next.findIndex((tool) => (tool.toolCallId || tool.id || tool.name) === key);
    if (index === -1) {
      next.push(update);
      continue;
    }
    const existing = next[index];
    next[index] = {
      ...existing,
      ...update,
      name: update.name || existing.name,
      status: mergeToolStatus(existing.status, update.status),
      durationMs: update.durationMs ?? existing.durationMs,
      summary: update.summary ?? existing.summary,
      updatedAt: update.updatedAt || existing.updatedAt,
    };
  }
  return next;
}

/**
 * Only treat an explicit chat.send ack timeout as recoverable.
 * Gateway stopped / Gateway not connected are hard failures that
 * should still terminate the send immediately.
 */
function isRecoverableChatSendTimeout(error: string): boolean {
  return error.includes('RPC timeout: chat.send');
}

function collectToolUpdates(message: unknown, eventState: string): ToolStatus[] {
  const updates: ToolStatus[] = [];
  const toolResultUpdate = extractToolResultUpdate(message, eventState);
  if (toolResultUpdate) updates.push(toolResultUpdate);
  updates.push(...extractToolResultBlocks(message, eventState));
  updates.push(...extractToolUseUpdates(message));
  return updates;
}

/**
 * True when an assistant message carries user-visible final output (text or
 * image). NOTE: `thinking` blocks are intentionally excluded  - they are the
 * model's internal monologue and frequently precede tool calls in models like
 * MiniMax-M2.7 and gpt-5.5. Treating thinking as "final content" causes the
 * history-poll closer in applyLoadedMessages and the runtime final handler to
 * misclassify intermediate `[thinking, toolCall]` turns as completed replies,
 * which prematurely tears down the `sending` / `activeRunId` / `pendingFinal`
 * lifecycle flags and makes the Thinking indicator vanish mid-tool-chain.
 */
function messageHasImageContent(message: RawMessage | undefined): boolean {
  if (!message) return false;
  if ((message._attachedFiles ?? []).some((file) => file.mimeType.startsWith('image/'))) return true;
  const content = message.content;
  return Array.isArray(content) && (content as ContentBlock[]).some((block) => block.type === 'image');
}

/**
 * True when an assistant message is still waiting on a tool result, i.e. it
 * represents an intermediate tool-use turn rather than a finished reply.
 * Detected via:
 *   - explicit stop_reason = "tool_use" / "toolUse"
 *   - any tool_use / toolCall block in `content`
 *   - OpenAI-format `tool_calls` array
 * Used by applyLoadedMessages and the runtime `final` handler to keep the
 * `sending` / `activeRunId` / `pendingFinal` flags armed across tool rounds.
 */
function hasPendingToolUse(message: RawMessage | undefined): boolean {
  if (!message) return false;
  const reason = getMessageStopReason(message);
  if (reason === 'tool_use' || reason === 'tooluse') return true;

  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (block.type === 'tool_use' || block.type === 'toolCall') return true;
    }
  }

  const msg = message as unknown as Record<string, unknown>;
  const toolCalls = msg.tool_calls ?? msg.toolCalls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return true;

  return false;
}

function isDeduplicableAssistantFinal(message: RawMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (hasPendingToolUse(message) || isToolOnlyMessage(message)) return false;
  if (isTerminalAssistantErrorMessage(message)) return false;
  if (!messageHasDeliverableContent(message)) return false;
  return !isInternalMessage(message);
}

function normalizeAssistantReplyForDedupe(message: RawMessage): string {
  if (!isDeduplicableAssistantFinal(message)) return '';
  return getMessageText(message.content)
    .replace(/(?:^|\n)\s*MEDIA:[^\n]*/giu, ' ')
    .replace(/\[media attached:[^\]]*\]/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function getAssistantReplyArtifactFiles(message: RawMessage): AttachedFileMeta[] {
  if (!isDeduplicableAssistantFinal(message)) return [];
  return extractMessageArtifactFiles(message);
}

function attachmentGroupsOverlap(
  left: AttachedFileMeta[],
  right: AttachedFileMeta[],
): boolean {
  if (left.length === 0 || right.length === 0) return false;

  const leftGroups = left.map((file) => new Set(getAttachedFileNormalizedIdentityKeys(file)));
  const rightGroups = right.map((file) => new Set(getAttachedFileNormalizedIdentityKeys(file)));
  const smaller = leftGroups.length <= rightGroups.length ? leftGroups : rightGroups;
  const larger = leftGroups.length <= rightGroups.length ? rightGroups : leftGroups;
  const matched = new Set<number>();

  return smaller.every((group) => {
    const matchIndex = larger.findIndex((candidate, index) => (
      !matched.has(index) && [...group].some((key) => candidate.has(key))
    ));
    if (matchIndex < 0) return false;
    matched.add(matchIndex);
    return true;
  });
}

function areRedundantAssistantReplies(left: RawMessage, right: RawMessage): boolean {
  if (!isDeduplicableAssistantFinal(left) || !isDeduplicableAssistantFinal(right)) return false;
  const leftArtifacts = getAssistantReplyArtifactFiles(left);
  const rightArtifacts = getAssistantReplyArtifactFiles(right);
  if (leftArtifacts.length > 0 && rightArtifacts.length > 0) {
    return attachmentGroupsOverlap(leftArtifacts, rightArtifacts);
  }

  const leftText = normalizeAssistantReplyForDedupe(left);
  const rightText = normalizeAssistantReplyForDedupe(right);
  if (!leftText || !rightText) return false;
  if (leftText === rightText) return true;
  const shorter = leftText.length <= rightText.length ? leftText : rightText;
  const longer = leftText.length > rightText.length ? leftText : rightText;
  return shorter.length >= 16 && longer.startsWith(shorter);
}

function attachedFileCompletenessScore(file: AttachedFileMeta): number {
  let score = 0;
  if (file.filePath?.trim()) score += 8;
  if (file.gatewayUrl?.trim()) score += 8;
  if (file.fileSize > 0) score += 4;
  if (file.preview) score += 4;
  if (file.width && file.width > 0) score += 1;
  if (file.height && file.height > 0) score += 1;
  if (file.mimeType && file.mimeType !== 'application/octet-stream') score += 1;
  if (file.source && file.source !== 'message-ref') score += 1;
  return score;
}

function mergeAssistantReplyAttachments(left: RawMessage, right: RawMessage): AttachedFileMeta[] {
  return dedupeAttachedFiles([
    ...getAssistantReplyArtifactFiles(right),
    ...getAssistantReplyArtifactFiles(left),
  ].sort((a, b) => attachedFileCompletenessScore(b) - attachedFileCompletenessScore(a)));
}

function mergeRedundantAssistantReplies(left: RawMessage, right: RawMessage): RawMessage {
  const leftText = normalizeAssistantReplyForDedupe(left);
  const rightText = normalizeAssistantReplyForDedupe(right);
  const keepRight = rightText.length >= leftText.length;
  const contentSource = keepRight ? right : left;
  const attachedFiles = mergeAssistantReplyAttachments(left, right);
  const merged: RawMessage = {
    ...left,
    ...right,
    content: contentSource.content,
  };
  return attachedFiles.length > 0 ? { ...merged, _attachedFiles: attachedFiles } : merged;
}

export function dedupeAssistantRepliesForDisplay(messages: RawMessage[]): RawMessage[] {
  const result: RawMessage[] = [];
  let lastAssistantIndexInTurn = -1;

  for (const message of messages) {
    if (isRealUserBoundaryMessage(message)) {
      result.push(message);
      lastAssistantIndexInTurn = -1;
      continue;
    }

    if (message.role !== 'assistant' || !isDeduplicableAssistantFinal(message)) {
      result.push(message);
      continue;
    }

    if (
      lastAssistantIndexInTurn >= 0
      && areRedundantAssistantReplies(result[lastAssistantIndexInTurn]!, message)
    ) {
      const merged = mergeRedundantAssistantReplies(
        result[lastAssistantIndexInTurn]!,
        message,
      );
      result.splice(lastAssistantIndexInTurn, 1);
      result.push(merged);
      lastAssistantIndexInTurn = result.length - 1;
      continue;
    }

    result.push(message);
    lastAssistantIndexInTurn = result.length - 1;
  }

  return result;
}

function isRealUserBoundaryMessage(msg: RawMessage): boolean {
  if (msg.role !== 'user') return false;
  if (isInternalMessage(msg)) return false;
  if (!Array.isArray(msg.content)) return true;
  const blocks = msg.content as Array<{ type?: string }>;
  return blocks.length === 0 || !blocks.every((block) => block.type === 'tool_result' || block.type === 'toolResult');
}

function segmentHasMeaningfulAssistantProgress(segment: RawMessage[]): boolean {
  return segment.some((msg) => {
    if (msg.role !== 'assistant') return false;
    if (isTerminalAssistantErrorMessage(msg)) return true;
    if (hasPendingToolUse(msg) || isToolOnlyMessage(msg)) return true;
    return messageHasDeliverableContent(msg);
  });
}

/** True when the post-user segment has real run output (not a thinking-only stub). */
function hasMeaningfulAssistantProgressAfterLastUser(messages: RawMessage[]): boolean {
  return segmentHasMeaningfulAssistantProgress(postUserSegmentMessages(messages));
}

/** True when streaming state carries visible progress (not a role-only placeholder). */
function hasMeaningfulStreamingActivity(
  streamingMessage: unknown | null,
  streamingText: string,
  streamingTools: ToolStatus[],
): boolean {
  if (streamingText.trim()) return true;
  if (streamingTools.length > 0) return true;
  if (!streamingMessage || typeof streamingMessage !== 'object') return false;

  const msg = streamingMessage as RawMessage;
  if (typeof msg.content === 'string' && msg.content.trim()) return true;

  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (block.type === 'text' && block.text?.trim()) return true;
      if (block.type === 'thinking' && block.thinking?.trim()) return true;
      if (block.type === 'tool_use' || block.type === 'toolCall') return true;
      if (isUserVisibleMediaBlockType(block.type)) return true;
    }
  }

  const raw = msg as unknown as Record<string, unknown>;
  if (typeof raw.text === 'string' && raw.text.trim()) return true;
  const toolCalls = raw.tool_calls ?? raw.toolCalls;
  return Array.isArray(toolCalls) && toolCalls.length > 0;
}

function hasAssistantProgressSinceSend(messages: RawMessage[], lastUserMessageAt: number | null): boolean {
  if (!lastUserMessageAt) return false;
  const normalized = [...messages];
  while (normalized.length > 0) {
    const last = normalized[normalized.length - 1];
    if (last.role === 'user' && !last.timestamp) {
      normalized.pop();
      continue;
    }
    break;
  }
  return hasMeaningfulAssistantProgressAfterLastUser(normalized);
}

function postUserSegmentMessages(filteredMessages: RawMessage[]): RawMessage[] {
  for (let i = filteredMessages.length - 1; i >= 0; i -= 1) {
    if (isRealUserBoundaryMessage(filteredMessages[i])) {
      return filteredMessages.slice(i + 1);
    }
  }
  return [];
}

/** A tool failure is non-blocking only after the same turn has produced a visible final reply. */
function hasToolActivityAfterLastUser(messages: RawMessage[]): boolean {
  return postUserSegmentMessages(messages).some((message) => (
    message.role === 'assistant'
    && (hasPendingToolUse(message) || isToolOnlyMessage(message))
  ));
}

function hasUserVisibleFinalReplyAfterLastUser(messages: RawMessage[]): boolean {
  return postUserSegmentMessages(messages).some((message) => (
    message.role === 'assistant'
    && !hasPendingToolUse(message)
    && !isToolOnlyMessage(message)
    && !isInternalMessage(message)
    && messageHasDeliverableContent(message)
  ));
}

function shouldSuppressToolTerminalError(
  messages: RawMessage[],
  streamingMessage: RawMessage | null,
  runId: string,
): boolean {
  const streamSnapshot = snapshotStreamingAssistantMessage(streamingMessage, messages, runId);
  const messagesWithStreamSnapshot = streamSnapshot.length > 0
    ? [...messages, ...streamSnapshot]
    : messages;
  return hasToolActivityAfterLastUser(messagesWithStreamSnapshot)
    && hasUserVisibleFinalReplyAfterLastUser(messagesWithStreamSnapshot);
}

/** Segment after the user turn that matches the in-flight send (not prior history). */
function getOpenRunSegmentFromHistory(
  filteredMessages: RawMessage[],
  lastUserMessageAt: number | null,
): RawMessage[] {
  if (lastUserMessageAt == null) {
    return postUserSegmentMessages(filteredMessages);
  }
  const userMsTs = toMs(lastUserMessageAt);
  const CLOCK_SKEW_MS = 5_000;
  for (let i = filteredMessages.length - 1; i >= 0; i -= 1) {
    const message = filteredMessages[i];
    if (!isRealUserBoundaryMessage(message)) continue;
    const ts = message.timestamp ? toMs(message.timestamp as number) : null;
    if (ts == null) continue;
    if (ts + CLOCK_SKEW_MS >= userMsTs && ts <= userMsTs + OPTIMISTIC_USER_TIMESTAMP_MATCH_MS) {
      return filteredMessages.slice(i + 1);
    }
  }
  return [];
}

/** Only treat inbound runs as user-visible for this long after the last user send. */
const USER_INITIATED_RUN_MAX_AGE_MS = 10 * 60 * 1000;

function hasCachedActiveUserRun(sessionKey: string): boolean {
  const cached = getCachedSessionRunState(sessionKey);
  return cached.sending || cached.activeRunId != null || cached.pendingFinal;
}

function shouldTrackInboundRunLifecycle(
  state: Pick<ChatState, 'lastUserMessageAt' | 'sending' | 'activeRunId' | 'pendingFinal'>,
  sessionKey?: string,
): boolean {
  if (state.sending || state.activeRunId != null || state.pendingFinal) return true;
  if (sessionKey && hasCachedActiveUserRun(sessionKey)) return true;
  if (!state.lastUserMessageAt) return false;
  return Date.now() - toMs(state.lastUserMessageAt) <= USER_INITIATED_RUN_MAX_AGE_MS;
}

function isFailedAssistantTurnMessage(message: RawMessage | unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const msg = message as RawMessage;
  if (msg.role !== 'assistant') return false;
  return /\[assistant turn failed/i.test(getMessageText(msg.content));
}

function segmentHasOpenToolRun(segmentMessages: RawMessage[]): boolean {
  if (segmentMessages.length === 0) return false;
  const hasToolActivity = segmentMessages.some(
    (message) => message.role === 'assistant' && (hasPendingToolUse(message) || isToolOnlyMessage(message)),
  );
  if (!hasToolActivity) return false;

  let lastToolUseOffset = -1;
  for (let i = segmentMessages.length - 1; i >= 0; i -= 1) {
    const message = segmentMessages[i];
    if (message.role === 'assistant' && (hasPendingToolUse(message) || isToolOnlyMessage(message))) {
      lastToolUseOffset = i;
      break;
    }
  }

  // The tool run is closed if any assistant message after the last tool call
  // is a non-tool response  - either with visible content or a thinking-only
  // terminal turn (the model ended without producing more tool calls).
  return !segmentMessages.some((message, index) => {
    if (index <= lastToolUseOffset) return false;
    if (message.role !== 'assistant') return false;
    if (hasPendingToolUse(message)) return false;
    if (messageHasDeliverableContent(message)) return true;
    return !isToolOnlyMessage(message);
  });
}

function findLastRealUserMessage(messages: RawMessage[]): RawMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isRealUserBoundaryMessage(messages[i])) {
      return messages[i];
    }
  }
  return null;
}

function findLastRealUserBoundaryIndex(messages: RawMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isRealUserBoundaryMessage(messages[i])) return i;
  }
  return -1;
}

function inferHistoricalOpenRunState(
  runtimeRuns: ChatState['runtimeRuns'],
  sessionKey: string,
  messages: RawMessage[],
  options: { allowEmptySegment?: boolean } = {},
): { runId: string; lastUserMessageAt: number; segment: RawMessage[] } | null {
  const lastUserIndex = findLastRealUserBoundaryIndex(messages);
  if (lastUserIndex < 0) return null;

  const lastUser = messages[lastUserIndex];
  if (!lastUser) return null;

  const segment = messages.slice(lastUserIndex + 1);
  if (segment.length === 0 && !options.allowEmptySegment) return null;
  if (segmentLooksLikeBackgroundHeartbeatRun(sessionKey, segment)) return null;

  const hasConclusiveReply = segment.some((message) => {
    if (message.role !== 'assistant') return false;
    if (hasPendingToolUse(message)) return false;
    return messageHasDeliverableContent(message);
  });
  if (hasConclusiveReply) return null;

  const runId = buildHistoricalRunId(sessionKey, lastUser, lastUserIndex);
  const runtimeRun = runtimeRuns[runId];
  const runtimeStillRunning = runtimeRun?.sessionKey === sessionKey && runtimeRun.status === 'running';
  if (!runtimeStillRunning && segment.length > 0 && !segmentHasOpenToolRun(segment)) return null;

  return {
    runId,
    lastUserMessageAt: lastUser.timestamp ? toMs(lastUser.timestamp) : Date.now(),
    segment,
  };
}

function normalizeLocalAttachmentPath(value: string): string {
  let normalized = trimPathTerminators(value.trim()).normalize('NFC');
  if (/^file:\/\//i.test(normalized)) {
    try {
      const parsed = new URL(normalized);
      normalized = decodeURIComponent(parsed.pathname);
      if (parsed.hostname) normalized = `//${parsed.hostname}${normalized}`;
      if (/^\/[A-Za-z]:\//u.test(normalized)) normalized = normalized.slice(1);
    } catch {
      normalized = normalized.replace(/^file:\/\//i, '');
    }
  }

  normalized = normalized.replace(/\\/gu, '/');
  const isUncPath = normalized.startsWith('//');
  const hasRoot = normalized.startsWith('/');
  const segments = normalized.split('/');
  const compacted: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..' && compacted.length > 0 && compacted.at(-1) !== '..') {
      compacted.pop();
      continue;
    }
    compacted.push(segment);
  }

  normalized = `${isUncPath ? '//' : hasRoot ? '/' : ''}${compacted.join('/')}`;
  if (/^[A-Za-z]:\//u.test(normalized)) normalized = normalized.toLowerCase();
  return normalized;
}

function normalizeRemoteAttachmentUrl(value: string): string {
  const trimmed = trimPathTerminators(value.trim()).normalize('NFC');
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    parsed.pathname = normalizeLocalAttachmentPath(parsed.pathname);
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function normalizeAttachmentMetadataPart(value: string | number | null | undefined): string {
  return String(value ?? '').trim().normalize('NFC').toLowerCase();
}

function getAttachedFileNormalizedIdentityKeys(file: AttachedFileMeta): string[] {
  const keys: string[] = [];
  const addLocation = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    keys.push(looksLikeRemoteMediaUrl(trimmed)
      ? `url:${normalizeRemoteAttachmentUrl(trimmed)}`
      : `path:${normalizeLocalAttachmentPath(trimmed)}`);
  };

  addLocation(file.filePath);
  addLocation(file.gatewayUrl);
  if (keys.length === 0) {
    keys.push([
      'meta',
      normalizeAttachmentMetadataPart(file.fileName),
      normalizeAttachmentMetadataPart(file.mimeType),
      normalizeAttachmentMetadataPart(file.fileSize),
      normalizeAttachmentMetadataPart(file.preview),
    ].join(':'));
  }
  return [...new Set(keys)];
}

function dedupeAttachedFiles(files: AttachedFileMeta[]): AttachedFileMeta[] {
  const seen = new Set<string>();
  const next: AttachedFileMeta[] = [];
  for (const file of files) {
    const keys = getAttachedFileNormalizedIdentityKeys(file);
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    next.push(file);
  }
  return next;
}

function hashStringForLocalMessageId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

function attachedFileKey(file: AttachedFileMeta): string {
  return getAttachedFileNormalizedIdentityKeys(file)[0]!;
}

function collectAssistantArtifactsForFallback(segmentMessages: RawMessage[]): AttachedFileMeta[] {
  const files: AttachedFileMeta[] = [];

  for (const message of segmentMessages) {
    if (message.role !== 'assistant') continue;
    if (isTerminalAssistantErrorMessage(message) || isFailedAssistantTurnMessage(message)) continue;
    files.push(...(message._attachedFiles ?? []));

    const text = getMessageText(message.content);
    if (!text) continue;

    const mediaRefs = extractMediaRefs(text);
    const mediaRefPaths = new Set(mediaRefs.map((ref) => ref.filePath));
    for (const ref of mediaRefs) {
      files.push({ ...makeAttachedFile(ref), source: 'message-ref' });
    }
    for (const ref of extractRawFilePaths(text)) {
      if (mediaRefPaths.has(ref.filePath)) continue;
      files.push({ ...makeAttachedFile(ref), source: 'message-ref' });
    }
  }

  return dedupeAttachedFiles(files).filter((file) => (
    Boolean(file.filePath?.trim())
    || Boolean(file.gatewayUrl?.trim())
    || Boolean(file.preview)
  ));
}

function artifactKindLabel(file: AttachedFileMeta): string {
  const mimeType = file.mimeType.toLowerCase();
  if (mimeType.startsWith('image/')) return '图片';
  if (mimeType.startsWith('video/')) return '视频';
  if (mimeType.includes('presentation') || /\.pptx?$/iu.test(file.fileName)) return 'PPT';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || /\.xlsx?$/iu.test(file.fileName)) return 'Excel';
  if (mimeType.includes('html') || /\.html?$/iu.test(file.fileName)) return '网页';
  if (mimeType.includes('pdf') || /\.pdf$/iu.test(file.fileName)) return 'PDF';
  if (mimeType.includes('word') || /\.docx?$/iu.test(file.fileName)) return '文档';
  return '文件';
}

function buildArtifactFallbackAssistantMessage(segmentMessages: RawMessage[]): RawMessage | null {
  const attachedFiles = collectAssistantArtifactsForFallback(segmentMessages);
  if (attachedFiles.length === 0) return null;

  const latestTimestamp = segmentMessages.reduce((latest, message) => {
    if (message.timestamp == null) return latest;
    return Math.max(latest, toMs(message.timestamp));
  }, 0);
  const timestamp = latestTimestamp > 0 ? latestTimestamp + 1 : Date.now();
  const digest = hashStringForLocalMessageId(attachedFiles.map(attachedFileKey).join('|'));
  const fileLines = attachedFiles.map((file, index) => (
    `${index + 1}. ${artifactKindLabel(file)}：${file.fileName || '已生成文件'}`
  ));

  return {
    role: 'assistant',
    id: `local-artifact-fallback:${timestamp}:${digest}`,
    timestamp,
    content: [
      '文件已生成，但最终文字回复没有成功送达。我先把已落地的产物交付给你。',
      '',
      ...fileLines,
    ].join('\n'),
    _attachedFiles: attachedFiles,
  };
}

function dropTerminalAssistantErrorsFromLatestSegment(messages: RawMessage[]): RawMessage[] {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRealUserBoundaryMessage(messages[index])) {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return messages;

  return messages.filter((message, index) => {
    if (index <= latestUserIndex) return true;
    if (message.role !== 'assistant') return true;
    return !(isTerminalAssistantErrorMessage(message) || isFailedAssistantTurnMessage(message));
  });
}

function runtimeToolEventToStatus(event: ChatRuntimeEvent): ToolStatus | null {
  if (event.type === 'tool.started') {
    return {
      id: event.toolCallId,
      toolCallId: event.toolCallId,
      name: event.name,
      status: 'running',
      summary: typeof event.args === 'string' ? event.args : undefined,
      updatedAt: event.ts ?? Date.now(),
    };
  }
  if (event.type === 'tool.updated') {
    return {
      id: event.toolCallId,
      toolCallId: event.toolCallId,
      name: event.name,
      status: 'running',
      summary: typeof event.partialResult === 'string' ? event.partialResult : undefined,
      updatedAt: event.ts ?? Date.now(),
    };
  }
  if (event.type === 'tool.completed') {
    return {
      id: event.toolCallId,
      toolCallId: event.toolCallId,
      name: event.name,
      status: event.isError ? 'error' : 'completed',
      summary: typeof event.result === 'string' ? event.result : undefined,
      updatedAt: event.ts ?? Date.now(),
    };
  }
  return null;
}

// ── Store ────────────────────────────────────────────────────────

const initialCurrentSessionKey = readPersistedCurrentSessionKey() ?? DEFAULT_SESSION_KEY;

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  loading: false,
  loadingMoreHistory: false,
  hasMoreHistory: false,
  error: null,
  runError: null,

  sending: false,
  pendingImageGenerationLocal: false,
  pendingVideoGenerationLocal: false,
  activeRunId: null,
  streamingText: '',
  streamingMessage: null,
  streamingTools: [],
  pendingFinal: false,
  lastUserMessageAt: null,
  pendingToolImages: [],
  runtimeRuns: {},

  sessions: [],
  currentSessionKey: initialCurrentSessionKey,
  currentAgentId: getAgentIdFromSessionKey(initialCurrentSessionKey),
  sessionLabels: {},
  sessionLastActivity: {},

  thinkingLevel: null,

  // ── Load sessions via sessions.list ──

  loadSessions: async () => {
    const now = Date.now();
    if (_loadSessionsInFlight) {
      await _loadSessionsInFlight;
      return;
    }
    if (now - _lastLoadSessionsAt < SESSION_LOAD_MIN_INTERVAL_MS) {
      return;
    }

    _loadSessionsInFlight = (async () => {
      try {
        const data = await fetchChatSessionsList();
        if (data) {
          const rawSessions = Array.isArray(data.sessions) ? data.sessions : [];
          const { currentSessionKey, sessions: localSessions } = get();
          const localSessionByKey = new Map(localSessions.map((session) => [session.key, session] as const));
          const sessions: ChatSession[] = rawSessions.map((s: Record<string, unknown>) => {
            const id = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : undefined;
            const sessionId = typeof s.sessionId === 'string' && s.sessionId.trim() ? s.sessionId.trim() : id;
            const sessionFile = typeof s.sessionFile === 'string' && s.sessionFile.trim()
              ? s.sessionFile.trim()
              : typeof s.absolutePath === 'string' && s.absolutePath.trim()
                ? s.absolutePath.trim()
                : typeof s.path === 'string' && s.path.trim()
                  ? s.path.trim()
                  : undefined;
            const fileName = typeof s.fileName === 'string' && s.fileName.trim()
              ? s.fileName.trim()
              : typeof s.file === 'string' && s.file.trim()
                ? s.file.trim()
                : undefined;
            const nextSession: ChatSession = {
              key: String(s.key || ''),
              id,
              sessionId,
              sessionFile,
              fileName,
              heartbeatIsolatedBaseSessionKey: typeof s.heartbeatIsolatedBaseSessionKey === 'string'
                && s.heartbeatIsolatedBaseSessionKey.trim()
                ? s.heartbeatIsolatedBaseSessionKey.trim()
                : undefined,
              label: s.label ? String(s.label) : undefined,
              displayName: s.displayName ? String(s.displayName) : undefined,
              derivedTitle: s.derivedTitle ? String(s.derivedTitle) : undefined,
              lastMessagePreview: s.lastMessagePreview ? String(s.lastMessagePreview) : undefined,
              thinkingLevel: s.thinkingLevel ? String(s.thinkingLevel) : undefined,
              thinkingLevels: Array.isArray(s.thinkingLevels)
                ? s.thinkingLevels.flatMap((level) => {
                    if (typeof level === 'string' && level.trim()) return [{ id: level.trim() }];
                    if (level && typeof level === 'object' && typeof (level as { id?: unknown }).id === 'string') {
                      const id = (level as { id: string }).id.trim();
                      if (!id) return [];
                      const label = typeof (level as { label?: unknown }).label === 'string'
                        ? (level as { label: string }).label.trim()
                        : undefined;
                      return [{ id, ...(label ? { label } : {}) }];
                    }
                    return [];
                  })
                : undefined,
              thinkingDefault: typeof s.thinkingDefault === 'string' && s.thinkingDefault.trim()
                ? s.thinkingDefault.trim()
                : undefined,
              reasoningLevel: s.reasoningLevel ? String(s.reasoningLevel) : undefined,
              model: buildSessionModelRef(s.model, s.modelProvider),
              cwd: typeof s.cwd === 'string' && s.cwd.trim() ? s.cwd.trim() : undefined,
              updatedAt: parseSessionUpdatedAtMs(s.updatedAt),
              status: parseSessionStatus(s.status),
              hasActiveRun: typeof s.hasActiveRun === 'boolean' ? s.hasActiveRun : undefined,
            };
            return mergeSessionRowWithLocalState(nextSession, localSessionByKey.get(nextSession.key));
          }).filter((s: ChatSession) => (
            s.key
            && !isInternalTemporarySessionKey(s.key)
            && !isInternalHeartbeatSession(s)
          ));

          const canonicalBySuffix = new Map<string, string>();
          for (const session of sessions) {
            if (!session.key.startsWith('agent:')) continue;
            const parts = session.key.split(':');
            if (parts.length < 3) continue;
            const suffix = parts.slice(2).join(':');
            if (suffix && !canonicalBySuffix.has(suffix)) {
              canonicalBySuffix.set(suffix, session.key);
            }
          }

          // Deduplicate: if both short and canonical existed, keep canonical only
          const seen = new Set<string>();
          const dedupedSessions = sessions.filter((s) => {
            if (!s.key.startsWith('agent:') && canonicalBySuffix.has(s.key)) return false;
            if (seen.has(s.key)) return false;
            seen.add(s.key);
            return true;
          });
          for (const session of dedupedSessions) {
            _pendingLocalSessionKeys.delete(session.key);
          }

          let nextSessionKey = currentSessionKey || DEFAULT_SESSION_KEY;
          if (!nextSessionKey.startsWith('agent:')) {
            const canonicalMatch = canonicalBySuffix.get(nextSessionKey);
            if (canonicalMatch) {
              nextSessionKey = canonicalMatch;
            }
          }
          if (!dedupedSessions.find((s) => s.key === nextSessionKey)) {
            // Preserve only locally-created pending sessions. On initial boot the
            // default ghost key (`agent:main:main`) should yield to real history.
            const hasLocalPendingSession = _pendingLocalSessionKeys.has(nextSessionKey)
              && !isInternalHeartbeatSession(nextSessionKey);
            if (!hasLocalPendingSession) {
              nextSessionKey = pickStartupSessionFallback(nextSessionKey, dedupedSessions) ?? DEFAULT_SESSION_KEY;
            }
          }

          const localCurrentSession = localSessions.find((session) => session.key === nextSessionKey);
          const sessionsWithCurrent = !dedupedSessions.find((s) => s.key === nextSessionKey) && nextSessionKey
            ? [
              ...dedupedSessions,
              localCurrentSession ? { ...localCurrentSession } : { key: nextSessionKey, displayName: nextSessionKey },
            ]
            : dedupedSessions;

          const discoveredActivity = Object.fromEntries(
            sessionsWithCurrent
              .filter((session) => typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt))
              .map((session) => [session.key, session.updatedAt!]),
          );

          const previousSessionKey = currentSessionKey;
          if (previousSessionKey !== nextSessionKey) {
            // Mirror switchSession: stop in-flight history polls and swap cached
            // history/run state immediately. Without this, a background loadSessions
            // can retarget currentSessionKey (e.g. to a cron heartbeat session)
            // while messages[] still holds the prior conversation until
            // chat.history returns  - which looks like cross-session contamination.
            clearHistoryPoll();
            set((state) => ({
              ...buildSessionSwitchPatch(state, nextSessionKey),
              sessions: sessionsWithCurrent,
              sessionLastActivity: {
                ...state.sessionLastActivity,
                ...discoveredActivity,
              },
            }));
          } else {
            set((state) => ({
              sessions: sessionsWithCurrent,
              currentSessionKey: nextSessionKey,
              currentAgentId: getAgentIdFromSessionKey(nextSessionKey),
              sessionLastActivity: {
                ...state.sessionLastActivity,
                ...discoveredActivity,
              },
            }));
          }
          reconcileCurrentSessionLifecycleFromBackend(set, get, sessionsWithCurrent);
          applySessionBackendLabels(set, sessionsWithCurrent);

          // Background: fetch first user message for every non-main session to populate labels upfront.
          // This uses the Host API local transcript summary route, not Gateway
          // chat.history, so it can run immediately without starving the
          // foreground history load during startup/restart.
          const existingSessionLabels = get().sessionLabels;
          const existingSessionActivity = get().sessionLastActivity;
          const sessionsToLabel = sessionsWithCurrent
            .map((session) => ({
              session,
              candidate: getSessionLabelHydrationCandidate(
                session,
                existingSessionLabels,
                existingSessionActivity,
              ),
            }))
            .filter((entry) => entry.candidate != null)
            .sort((left, right) => (
              getSessionLabelHydrationActivityMs(right.session, existingSessionActivity)
              - getSessionLabelHydrationActivityMs(left.session, existingSessionActivity)
            ))
            .slice(0, SESSION_LABEL_HYDRATION_BATCH_SIZE)
            .map((entry) => ({
              session: entry.session,
              version: entry.candidate!.version,
            }));
          if (sessionsToLabel.length > 0) {
            void (async () => {
              let pending = sessionsToLabel.filter(({ session, version }) => beginSessionLabelHydration(session.key, version));
              for (let attempt = 0; attempt <= LABEL_FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
                try {
                  const summaries = await fetchSessionLabelSummaries(
                    pending.map(({ session }) => session.key),
                  );
                  applySessionLabelSummaries(set, summaries);
                  const summaryBySessionKey = new Map(
                    summaries.map((summary) => [summary.sessionKey, summary]),
                  );

                  for (const { session, version } of pending) {
                    const summary = summaryBySessionKey.get(session.key);
                    const labelText = toSessionLabel(summary?.firstUserText || '');
                    finishSessionLabelHydration(session.key, version, labelText ? 'labeled' : 'empty');
                  }
                  break;
                } catch (err) {
                  const retryableStartup = classifyHistoryStartupRetryError(err) === 'gateway_startup';
                  for (const { session, version } of pending) {
                    if (retryableStartup) {
                      abandonSessionLabelHydration(session.key, version);
                    } else {
                      finishSessionLabelHydration(session.key, version, 'error');
                    }
                  }
                  if (!retryableStartup || attempt >= LABEL_FETCH_RETRY_DELAYS_MS.length) {
                    break;
                  }
                  await sleep(LABEL_FETCH_RETRY_DELAYS_MS[attempt]!);
                  pending = pending.filter(({ session, version }) => beginSessionLabelHydration(session.key, version));
                  if (pending.length === 0) break;
                }
              }
            })();
          }

          if (previousSessionKey !== nextSessionKey) {
            deferHistoryLoad(get);
          }
        }
      } catch (err) {
        console.warn('Failed to load sessions:', err);
      } finally {
        _lastLoadSessionsAt = Date.now();
      }
    })();

    try {
      await _loadSessionsInFlight;
    } finally {
      _loadSessionsInFlight = null;
    }
  },

  // ── Switch session ──

  switchSession: (key: string) => {
    if (isInternalHeartbeatSession(key)) return;
    if (key === get().currentSessionKey) return;
    // Stop any background polling for the old session before switching.
    // This prevents the poll timer from firing after the switch and loading
    // the wrong session's history into the new session's view.
    clearHistoryPoll();
    clearBaselines();
    set((s) => buildSessionSwitchPatch(s, key));
    deferSessionSwitchHistoryLoad(get);
    scheduleQueuedChatSendFlush(key);
  },

  // ── Delete session ──
  //
  // NOTE: The OpenClaw Gateway does NOT expose a sessions.delete (or equivalent)
  // RPC  - confirmed by inspecting client.ts, protocol.ts and the full codebase.
  // Deletion is therefore performed locally: the renderer drops the session
  // from the sidebar / labels / activity maps and the Main process hard-deletes
  // the on-disk transcript so it stops appearing in sessions.list and stops
  // contributing to the Dashboard token-usage history.

  deleteSession: async (key: string) => {
    clearCachedSessionHistory(key);
    clearCachedSessionRunState(key);
    clearActiveSendGeneration(key);
    clearQueuedChatSends(key);
    clearSessionLabelHydrationTracking(key);
    clearPendingOptimisticUserMessages(key);
    // Hard-delete the session's JSONL transcript on disk.
    // The main process unlinks <id>.jsonl plus any leftover
    // <id>.deleted.jsonl and <id>.jsonl.reset.* siblings, then removes the
    // entry from sessions.json so sessions.list stops surfacing it.
    try {
      const result = await hostApiFetch<{
        success: boolean;
        error?: string;
      }>('/api/sessions/delete', {
        method: 'POST',
        body: JSON.stringify({ sessionKey: key }),
      });
      if (!result.success) {
        console.warn(`[deleteSession] IPC reported failure for ${key}:`, result.error);
      }
    } catch (err) {
      console.warn(`[deleteSession] IPC call failed for ${key}:`, err);
    }

    const { currentSessionKey, sessions } = get();
    const remaining = sessions.filter((s) => s.key !== key);

    if (currentSessionKey === key) {
      const nextSessionKey = pickStartupSessionFallback(currentSessionKey, remaining) ?? DEFAULT_SESSION_KEY;
      set((s) => ({
        sessions: remaining,
        sessionLabels: Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== key)),
        sessionLastActivity: Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== key)),
        messages: [],
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        activeRunId: null,
        pendingImageGenerationLocal: false,
        pendingVideoGenerationLocal: false,
        error: null,
        runError: null,
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
        currentSessionKey: nextSessionKey,
        currentAgentId: getAgentIdFromSessionKey(nextSessionKey),
      }));
      if (remaining.some((session) => session.key === nextSessionKey)) {
        get().loadHistory();
      }
    } else {
      set((s) => ({
        sessions: remaining,
        sessionLabels: Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== key)),
        sessionLastActivity: Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== key)),
      }));
    }
    _pendingLocalSessionKeys.delete(key);
  },

  // ── New session ──

  newSession: () => {
    // Generate a new unique session key and switch to it.
    // NOTE: We intentionally do NOT call sessions.reset on the old session.
    // sessions.reset archives (renames) the session JSONL file, making old
    // conversation history inaccessible when the user switches back to it.
    const { currentSessionKey, sessions } = get();
    const prefix = getCanonicalPrefixFromSessionKey(currentSessionKey)
      ?? getCanonicalPrefixFromSessions(sessions)
      ?? DEFAULT_CANONICAL_PREFIX;
    const newKey = `${prefix}:session-${Date.now()}`;
    _pendingLocalSessionKeys.add(newKey);

    // Use the same switch patch as explicit sidebar switching so a running
    // source session keeps its cached lifecycle. Without this, New Chat clears
    // the active run globally; switching back to the still-running session then
    // shows only the local transcript snapshot and loses the live execution UI.
    clearHistoryPoll();
    clearBaselines();
    set((s) => buildSessionSwitchPatch(s, newKey));
  },

  // ── Rename session ──

  renameSession: async (key: string, label: string) => {
    const normalized = label.trim();
    if (!normalized) {
      throw new Error('Session label cannot be empty');
    }

    const current = get();
    const session = current.sessions.find((entry) => entry.key === key);
    const currentLabel = toSessionLabel(
      current.sessionLabels[key] || session?.label || session?.derivedTitle || '',
      50,
    );
    if (currentLabel === normalized) {
      set((s) => ({
        sessions: s.sessions.map((entry) =>
          entry.key === key && entry.label !== normalized ? { ...entry, label: normalized } : entry,
        ),
        sessionLabels: s.sessionLabels[key] === normalized
          ? s.sessionLabels
          : { ...s.sessionLabels, [key]: normalized },
      }));
      return;
    }

    try {
      await persistSessionRenameOnce(key, normalized);
    } catch (err) {
      console.error(`[renameSession] API call failed for ${key}:`, err);
      throw err;
    }

    const updatedSession = get().sessions.find((entry) => entry.key === key);
    if (updatedSession) {
      finishSessionLabelHydration(
        key,
        getSessionLabelHydrationVersion(updatedSession, get().sessionLastActivity),
        'backend-label',
      );
    }

    set((s) => ({
      sessions: s.sessions.map((entry) =>
        entry.key === key ? { ...entry, label: normalized } : entry,
      ),
      sessionLabels: { ...s.sessionLabels, [key]: normalized },
    }));
  },

  updateSessionModel: async (key: string, modelRef: string | null) => {
    const normalizedModelRef = normalizeChatManagedModelRef(modelRef) ?? '';
    const updatedAt = Date.now();
    const previousSessions = get().sessions;
    const optimisticModelRef = normalizedModelRef || resolveEffectiveAgentModelRefForSession(key);

    set((state) => ({
      sessions: upsertSessionWithModel(state.sessions, key, optimisticModelRef, updatedAt),
    }));

    try {
      const effectiveModelRef = await persistSessionModelSelection(key, normalizedModelRef || null);
      set((state) => ({
        sessions: upsertSessionWithModel(state.sessions, key, effectiveModelRef, Date.now()),
      }));
    } catch (error) {
      set({ sessions: previousSessions });
      throw error;
    }
  },

  updateSessionThinking: async (key: string, thinkingLevel: string | null) => {
    const normalizedThinkingLevel = thinkingLevel?.trim() || null;
    const previousSessions = get().sessions;
    const previousThinkingLevel = get().thinkingLevel;
    set((state) => ({
      sessions: upsertSessionWithThinking(state.sessions, key, normalizedThinkingLevel, Date.now()),
      ...(state.currentSessionKey === key ? { thinkingLevel: normalizedThinkingLevel } : {}),
    }));

    try {
      const effectiveThinkingLevel = await persistSessionThinkingSelection(key, normalizedThinkingLevel);
      set((state) => ({
        sessions: upsertSessionWithThinking(state.sessions, key, effectiveThinkingLevel, Date.now()),
        ...(state.currentSessionKey === key ? { thinkingLevel: effectiveThinkingLevel } : {}),
      }));
    } catch (error) {
      set({ sessions: previousSessions, thinkingLevel: previousThinkingLevel });
      throw error;
    }
  },

  updateSessionCwd: async (key: string, cwd: string | null) => {
    const normalizedCwd = cwd?.trim() || null;
    const previousSessions = get().sessions;
    set((state) => ({
      sessions: upsertSessionWithCwd(state.sessions, key, normalizedCwd, Date.now()),
    }));

    const mutation = persistSessionCwdSelection(key, normalizedCwd)
      .then((effectiveCwd) => {
        set((state) => ({
          sessions: upsertSessionWithCwd(state.sessions, key, effectiveCwd, Date.now()),
        }));
      })
      .catch((error) => {
        set({ sessions: previousSessions });
        throw error;
      });
    _sessionCwdMutations.set(key, mutation);
    try {
      await mutation;
    } finally {
      if (_sessionCwdMutations.get(key) === mutation) _sessionCwdMutations.delete(key);
    }
  },

  healManagedTextModels: () => {
    set((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        model: normalizeChatManagedModelRef(session.model, { fallbackEmpty: true }) ?? undefined,
      })),
    }));
  },

  // ── Cleanup empty session on navigate away ──

  cleanupEmptySession: () => {
    const { currentSessionKey, messages, sessionLastActivity, sessionLabels } = get();
    // Only remove non-main sessions that were never used (no messages sent).
    // This mirrors the "leavingEmpty" logic in switchSession so that creating
    // a new session and immediately navigating away doesn't leave a ghost entry
    // in the sidebar.
    // Also check sessionLastActivity and sessionLabels comprehensively to prevent
    // falsely treating sessions with history as empty due to switchSession clearing messages early.
    const isEmptyNonMain = !currentSessionKey.endsWith(':main')
      && messages.length === 0
      && !sessionLastActivity[currentSessionKey]
      && !sessionLabels[currentSessionKey];
    if (!isEmptyNonMain) return;
      set((s) => ({
        sessions: s.sessions.filter((sess) => sess.key !== currentSessionKey),
        sessionLabels: Object.fromEntries(
          Object.entries(s.sessionLabels).filter(([k]) => k !== currentSessionKey),
        ),
        sessionLastActivity: Object.fromEntries(
          Object.entries(s.sessionLastActivity).filter(([k]) => k !== currentSessionKey),
        ),
      }));
      _pendingLocalSessionKeys.delete(currentSessionKey);
    },

  // ── Load chat history ──

  loadHistory: async (quiet = false) => {
    const { currentSessionKey } = get();
    const foregroundLoadKey = getHistoryForegroundLoadKey(currentSessionKey);
    const isInitialForegroundLoad = !quiet && !_foregroundHistoryLoadSeen.has(foregroundLoadKey);
    const historyTimeoutOverride = getStartupHistoryTimeoutOverride(isInitialForegroundLoad);
    const forceLoadRequested = _forceNextHistoryLoadBySession.has(currentSessionKey)
      || _sessionsNeedingTerminalHistoryRefresh.has(currentSessionKey);
    const existingLoad = _historyLoadInFlight.get(currentSessionKey);
    const shouldShowForegroundLoading = !quiet && get().messages.length === 0;
    if (existingLoad) {
      await existingLoad;
      if (!forceLoadRequested) {
        return;
      }
      if (get().currentSessionKey !== currentSessionKey) {
        return;
      }
    }

    const forcedByExplicitRequest = _forceNextHistoryLoadBySession.delete(currentSessionKey);
    const forcedByTerminalRefresh = consumeSessionNeedsTerminalHistoryRefresh(currentSessionKey);
    const forceLoad = forcedByExplicitRequest || forcedByTerminalRefresh;

    const lastLoadAt = _lastHistoryLoadAtBySession.get(currentSessionKey) || 0;
    if (!forceLoad && quiet && Date.now() - lastLoadAt < HISTORY_LOAD_MIN_INTERVAL_MS) {
      return;
    }

    const historyLoadGeneration = nextHistoryLoadGeneration(currentSessionKey);
    const isCurrentLoad = () => (
      get().currentSessionKey === currentSessionKey
      && isCurrentHistoryLoad(currentSessionKey, historyLoadGeneration)
    );
    if (shouldShowForegroundLoading) set({ loading: true, error: null, runError: null });

    // Safety guard: if history loading takes too long, force loading to false
    // to prevent the UI from being stuck in a spinner forever.
    let loadingTimedOut = false;
    const loadingSafetyTimer = shouldShowForegroundLoading ? setTimeout(() => {
      loadingTimedOut = true;
      if (isCurrentLoad()) set({ loading: false });
    }, getHistoryLoadingSafetyTimeout(isInitialForegroundLoad)) : null;

    const loadPromise = (async () => {
      const isCurrentSession = isCurrentLoad;
      const hostTaskBridgePayloadPromise = hostApiFetch<unknown>(
        `/api/task-bridge/tasks?activeOnly=false&sessionKey=${encodeURIComponent(currentSessionKey)}`,
      ).catch((error) => {
        console.warn('[chat.history] failed to load durable Host tasks:', error);
        return null;
      });
      const getPreviewMergeKey = (message: RawMessage): string => (
        `${message.id ?? ''}|${message.role}|${message.timestamp ?? ''}|${getMessageText(message.content)}`
      );
      const mergeHydratedMessages = (
        currentMessages: RawMessage[],
        hydratedMessages: RawMessage[],
      ): RawMessage[] => {
        const hydratedFilesByKey = new Map(
          hydratedMessages
            .filter((message) => message._attachedFiles?.length)
            .map((message) => [
              getPreviewMergeKey(message),
              message._attachedFiles!.map((file) => ({ ...file })),
            ]),
        );

        return currentMessages.map((message) => {
          const attachedFiles = hydratedFilesByKey.get(getPreviewMergeKey(message));
          return attachedFiles
            ? { ...message, _attachedFiles: attachedFiles }
            : message;
        });
      };
      type AttachedFile = NonNullable<RawMessage['_attachedFiles']>[number];
      const getAttachmentMergeKey = (file: AttachedFile): string | null => (
        file.filePath || file.gatewayUrl || null
      );
      const preserveExistingAttachmentPreviews = (
        currentMessages: RawMessage[],
        nextMessages: RawMessage[],
      ): RawMessage[] => {
        const currentFilesByMessageKey = new Map<string, Map<string, AttachedFile>>();
        for (const message of currentMessages) {
          if (!message._attachedFiles?.length) continue;
          const filesByKey = new Map<string, AttachedFile>();
          for (const file of message._attachedFiles) {
            const key = getAttachmentMergeKey(file);
            if (!key) continue;
            if (!file.preview && !file.fileSize && !file.previewStatus) continue;
            filesByKey.set(key, file);
          }
          if (filesByKey.size > 0) {
            currentFilesByMessageKey.set(getPreviewMergeKey(message), filesByKey);
          }
        }

        if (currentFilesByMessageKey.size === 0) return nextMessages;

        return nextMessages.map((message) => {
          if (!message._attachedFiles?.length) return message;
          const currentFiles = currentFilesByMessageKey.get(getPreviewMergeKey(message));
          if (!currentFiles) return message;

          let changed = false;
          const attachedFiles = message._attachedFiles.map((file) => {
            const key = getAttachmentMergeKey(file);
            const currentFile = key ? currentFiles.get(key) : undefined;
            if (!currentFile) return file;

            let nextFile = file;
            if (!nextFile.preview && currentFile.preview) {
              nextFile = { ...nextFile, preview: currentFile.preview };
              changed = true;
            }
            if (!nextFile.fileSize && currentFile.fileSize) {
              nextFile = { ...nextFile, fileSize: currentFile.fileSize };
              changed = true;
            }
            if (!nextFile.previewStatus && currentFile.previewStatus) {
              nextFile = { ...nextFile, previewStatus: currentFile.previewStatus };
              changed = true;
            }
            return nextFile;
          });

          return changed ? { ...message, _attachedFiles: attachedFiles } : message;
        });
      };

      const applyLoadFailure = (errorMessage: string | null) => {
        if (!isCurrentSession()) return;
        set((state) => {
          const mergedMessages = mergePendingOptimisticUserMessages(currentSessionKey, state.messages);
          return {
            loading: false,
            error: shouldShowForegroundLoading && errorMessage ? errorMessage : state.error,
            ...(mergedMessages.length > 0 ? { messages: mergedMessages } : { messages: [] as RawMessage[] }),
          };
        });
      };

      const applyLoadedMessages = async (
        rawMessages: RawMessage[],
        thinkingLevel: string | null,
        reasoningLevel: string | null,
        historyAuthority?: GatewayHistorySessionAuthority,
      ): Promise<boolean> => {
      // Guard: if the user switched sessions while this async load was in
      // flight, discard the result to prevent overwriting the new session's
      // messages with stale data from the old session.
      if (!isCurrentSession()) return false;

      // Before filtering: attach images/files from tool_result messages to the next assistant message
      const messagesWithToolImages = enrichWithToolResultFiles(rawMessages);
      const messagesWithToolAttachments = enrichWithToolCallAttachments(messagesWithToolImages);
      const filteredMessages = filterHistoryMessagesForUi(messagesWithToolAttachments);
      // Restore file attachments for user/assistant messages (from cache + text patterns)
      const enrichedMessages = dedupeAssistantRepliesForDisplay(enrichWithCachedImages(filteredMessages));
      const runtimeHistoryMessages = buildRuntimeReplayMessages(messagesWithToolAttachments);

      // Preserve optimistic user messages independently from sending state.
      // Gateway phase=end can clear sending before chat.history has persisted
      // the user turn; without this, an early quiet reload briefly removes it.
      let finalMessages = mergePendingOptimisticUserMessages(currentSessionKey, enrichedMessages);
      const userMsgAt = get().lastUserMessageAt;
      if (get().sending && userMsgAt) {
        const userMsMs = toMs(userMsgAt);
        const optimistic = getLatestOptimisticUserMessage(get().messages, userMsMs);
        const hasMatchingUser = optimistic
          ? hasOptimisticServerEcho(finalMessages, optimistic, userMsMs)
          : false;
        if (optimistic && !hasMatchingUser) {
          finalMessages = [...finalMessages, optimistic];
        }
      }
      finalMessages = dropRedundantOptimisticUserMessages(currentSessionKey, finalMessages);
      finalMessages = preserveExistingAttachmentPreviews(get().messages, finalMessages);
      finalMessages = dedupeAssistantRepliesForDisplay(finalMessages);

      const { pendingFinal, lastUserMessageAt, sending: isSendingNow } = get();
      const listedSessionRow = get().sessions.find((session) => session.key === currentSessionKey);
      const currentSessionRow = historyAuthority
        ? { ...listedSessionRow, ...historyAuthority.session, key: currentSessionKey }
        : listedSessionRow;
      const historyIdleMatchesCurrentTurn = historyAuthority?.explicitlyIdle === true
        && (
          lastUserMessageAt == null
          || toMs(lastUserMessageAt) <= historyAuthority.requestStartedAt
        );
      const backendSessionIdle = historyAuthority?.explicitlyActive
        ? false
        : historyAuthority?.explicitlyIdle
          ? historyIdleMatchesCurrentTurn
          : shouldTrustBackendSessionIdle(currentSessionRow, lastUserMessageAt);
      const backendSessionActive = historyAuthority?.explicitlyIdle
        ? false
        : historyAuthority?.explicitlyActive === true || backendSessionReportsActive(currentSessionRow);
      const userMsTs = lastUserMessageAt != null ? toMs(lastUserMessageAt) : 0;
      const isAfterUserMsg = (msg: RawMessage): boolean => {
        if (lastUserMessageAt == null) return true;
        if (!msg.timestamp) return false;
        return toMs(msg.timestamp) >= userMsTs;
      };
      const isRealUserBoundary = (msg: RawMessage): boolean => {
        if (msg.role !== 'user') return false;
        if (isInternalMessage(msg)) return false;
        if (!Array.isArray(msg.content)) return true;
        const blocks = msg.content as Array<{ type?: string }>;
        return blocks.length === 0 || !blocks.every((block) => block.type === 'tool_result' || block.type === 'toolResult');
      };
      const openRunSegment = isSendingNow && lastUserMessageAt != null
        ? getOpenRunSegmentFromHistory(filteredMessages, lastUserMessageAt)
        : postUserSegmentMessages(filteredMessages);
      const postBoundaryMessages = isSendingNow && lastUserMessageAt != null
        ? openRunSegment
        : (lastUserMessageAt != null
          ? filteredMessages.filter((msg) => isAfterUserMsg(msg))
          : (() => {
              for (let i = filteredMessages.length - 1; i >= 0; i -= 1) {
                if (isRealUserBoundary(filteredMessages[i])) {
                  return filteredMessages.slice(i + 1);
                }
              }
              return filteredMessages;
            })());
        const lastAssistantAfterBoundary = [...postBoundaryMessages].reverse().find((msg) => msg.role === 'assistant');
        const latestTerminalAssistantErrorMessage = lastAssistantAfterBoundary
          && (getMessageStopReason(lastAssistantAfterBoundary) === 'error'
            || isFailedAssistantTurnMessage(lastAssistantAfterBoundary))
          ? (getMessageErrorMessage(lastAssistantAfterBoundary)
            ?? (isFailedAssistantTurnMessage(lastAssistantAfterBoundary)
              ? getMessageText(lastAssistantAfterBoundary.content)
              : null))
          : null;
      const historyErrorIsTransient = Boolean(
        latestTerminalAssistantErrorMessage
        && isSendingNow
        && isRecoverableRuntimeError(latestTerminalAssistantErrorMessage),
      );
      const normalizedTerminalAssistantErrorMessage = latestTerminalAssistantErrorMessage
        ? normalizeChatRunErrorMessage(latestTerminalAssistantErrorMessage)
        : null;
      const stateBeforeHistoryCommit = get();
      let nextRuntimeRuns = applyHistoricalRuntimeRunsFromMessages(
        stateBeforeHistoryCommit.runtimeRuns,
        currentSessionKey,
        runtimeHistoryMessages,
      );
      nextRuntimeRuns = applyActiveRunArtifactEvidenceFromHistory(nextRuntimeRuns, {
        runId: stateBeforeHistoryCommit.activeRunId,
        sessionKey: currentSessionKey,
        messages: finalMessages,
        lastUserMessageAt: stateBeforeHistoryCommit.lastUserMessageAt,
      });
      const hostTasks = parseHostTaskBridgeTasks(await hostTaskBridgePayloadPromise);
      nextRuntimeRuns = applyRuntimeContractEvents(
        nextRuntimeRuns,
        buildHostTaskRehydrationEvents(hostTasks, {
          existingRunIds: Object.keys(nextRuntimeRuns),
        }),
      );
      const hasConclusiveAssistantReply = openRunSegment.some((message) => (
        message.role === 'assistant'
        && !hasPendingToolUse(message)
        && messageHasDeliverableContent(message)
      ));
      const hasRendererOwnedSend = _activeSendGenerationBySession.has(currentSessionKey);
      const backendSessionCanClose = backendSessionIdle
        && (
          !isSendingNow
          || !hasRendererOwnedSend
          || hasConclusiveAssistantReply
          || Boolean(latestTerminalAssistantErrorMessage)
        );
      const terminalArtifactFallbackMessage = latestTerminalAssistantErrorMessage && !historyErrorIsTransient
        ? buildArtifactFallbackAssistantMessage(
            isSendingNow && lastUserMessageAt != null
              ? getOpenRunSegmentFromHistory(finalMessages, lastUserMessageAt)
              : postUserSegmentMessages(finalMessages),
          )
        : null;
      if (terminalArtifactFallbackMessage) {
        finalMessages = [
          ...dropTerminalAssistantErrorsFromLatestSegment(finalMessages),
          terminalArtifactFallbackMessage,
        ];
      }

      if (backendSessionCanClose) {
        nextRuntimeRuns = alignRuntimeRunsWithBackendSessionTerminalState(
          nextRuntimeRuns,
          currentSessionKey,
          currentSessionRow,
          get().activeRunId,
        );
      }
      const inferredHistoricalOpenRun = !backendSessionCanClose && !isSendingNow && !latestTerminalAssistantErrorMessage
        ? inferHistoricalOpenRunState(nextRuntimeRuns, currentSessionKey, filteredMessages, {
            allowEmptySegment: currentSessionRow?.hasActiveRun === true,
          })
        : null;
      if (inferredHistoricalOpenRun && !nextRuntimeRuns[inferredHistoricalOpenRun.runId]) {
        nextRuntimeRuns = applyRuntimeContractEvents(
          nextRuntimeRuns,
          buildRuntimeStartEventsForRun(nextRuntimeRuns, {
            runId: inferredHistoricalOpenRun.runId,
            sessionKey: currentSessionKey,
            objective: getMessageText(findLastRealUserMessage(filteredMessages)?.content).trim(),
            mode: 'chat',
            ts: inferredHistoricalOpenRun.lastUserMessageAt,
          }),
        );
      }
      const authoritativeActiveRunId = backendSessionActive
        ? historyAuthority?.inFlightRunId
        : undefined;
      if (authoritativeActiveRunId && !nextRuntimeRuns[authoritativeActiveRunId]) {
        const lastUser = findLastRealUserMessage(filteredMessages);
        nextRuntimeRuns = applyRuntimeContractEvents(
          nextRuntimeRuns,
          buildRuntimeStartEventsForRun(nextRuntimeRuns, {
            runId: authoritativeActiveRunId,
            sessionKey: currentSessionKey,
            objective: getMessageText(lastUser?.content).trim(),
            mode: 'chat',
            ts: optionalToMs(lastUser?.timestamp ?? null) ?? Date.now(),
          }),
        );
      }

      set({
        messages: finalMessages,
        thinkingLevel,
        ...(reasoningLevel ? {
          sessions: get().sessions.map((session) => (
            session.key === currentSessionKey ? { ...session, reasoningLevel } : session
          )),
        } : {}),
        loading: false,
        runError: historyErrorIsTransient || terminalArtifactFallbackMessage
          ? null
          : normalizedTerminalAssistantErrorMessage,
        runtimeRuns: nextRuntimeRuns,
      });
      scheduleWithheldFinalReevaluationForSession(currentSessionKey);
      for (const run of Object.values(nextRuntimeRuns)) {
        const artifacts = run.artifacts ?? [];
        if (run.sessionKey !== currentSessionKey || artifacts.length === 0) continue;
        const needsAvailabilityCheck = (run.verifications ?? []).some((verification) => (
          verification.kind === 'artifact.availability'
          && verification.status === 'blocked'
          && verification.severity === 'warning'
        ));
        if (needsAvailabilityCheck) {
          scheduleRuntimeArtifactVerification(run.runId, currentSessionKey, artifacts);
        }
      }
      cacheSessionHistory(currentSessionKey, finalMessages, thinkingLevel);

      // Seed a missing label from immutable history only. Once a label exists
      // for a session, do not rewrite it during later history refreshes; users
      // perceive the sidebar title as a stable conversation identifier, not a
      // live summary of the latest turn.
      const isMainSession = currentSessionKey.endsWith(':main');
      if (!isMainSession && !get().sessionLabels[currentSessionKey]) {
        const firstUserMsg = finalMessages.find((m) => m.role === 'user');
        if (firstUserMsg) {
          const labelText = toSessionLabel(getMessageText(firstUserMsg.content));
          if (labelText) {
            set((s) => (
              s.sessionLabels[currentSessionKey]
                ? {}
                : { sessionLabels: { ...s.sessionLabels, [currentSessionKey]: labelText } }
            ));
          }
        }
      }

      // Record last activity time from the last message in history
      const lastMsg = finalMessages[finalMessages.length - 1];
      if (lastMsg?.timestamp) {
        const lastAt = toMs(lastMsg.timestamp);
        set((s) => ({
          sessionLastActivity: { ...s.sessionLastActivity, [currentSessionKey]: lastAt },
        }));
      }

      // Async: load missing image previews from disk (updates in background)
      const previewHydrationMessages = finalMessages.slice(-PREVIEW_HYDRATION_MESSAGE_LIMIT);
      loadMissingPreviews(previewHydrationMessages).then((updated) => {
        if (!isCurrentSession()) return;
        if (updated) {
          set((state) => ({
            ...(() => {
              const messages = mergeHydratedMessages(state.messages, previewHydrationMessages);
              const runtimeRuns = (() => {
                const nextRuntimeRuns = applyHistoricalRuntimeRunsFromMessages(
                  state.runtimeRuns,
                  currentSessionKey,
                  runtimeHistoryMessages,
                );
                return backendSessionCanClose
                  ? alignRuntimeRunsWithBackendSessionTerminalState(
                      nextRuntimeRuns,
                      currentSessionKey,
                      currentSessionRow,
                      state.activeRunId,
                    )
                  : nextRuntimeRuns;
              })();
              return {
                messages,
                runtimeRuns,
              };
            })(),
          }));
        }
      });

      if (latestTerminalAssistantErrorMessage && !historyErrorIsTransient) {
        beginSessionBackendIdleSettlement(currentSessionKey, get().activeRunId);
        return true;
      }

      if (backendSessionCanClose) {
        clearHistoryPoll();
        set({
          sending: false,
          pendingImageGenerationLocal: false,
          pendingVideoGenerationLocal: false,
          activeRunId: null,
          pendingFinal: false,
          lastUserMessageAt: null,
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          pendingToolImages: [],
        });
        markSessionRunIdle(currentSessionKey);
        clearPendingRuntimeIntent(currentSessionKey);
        return true;
      }

      // History poll is the fallback when Gateway streaming events are missing
      // (WS disconnect, console-only runs, etc.). Any assistant turn after the
      // user's message counts as progress so the safety timeout does not emit a
      // false "No response received" error while tool chains are still running.
      const progressSegment = openRunSegment;
      if (isSendingNow && segmentHasMeaningfulAssistantProgress(progressSegment)) {
        _lastChatEventAt = Date.now();
        if (get().error || get().runError) {
          set({ error: null, runError: null });
        }
      }

      // Promote pendingFinal only when there's a *final-looking* assistant
      // message after the user  - i.e. one that has actual user-visible output
      // (text/image) AND is not still waiting on a tool result. This used to
      // promote on *any* assistant message after the user, which fired on the
      // very first `[thinking, toolCall]` intermediate turn and then paired
      // with the closer below to clobber the entire run state.
      if (isSendingNow && !pendingFinal) {
        const hasFinalLikeAssistant = openRunSegment.some((msg) => {
          if (msg.role !== 'assistant') return false;
          if (hasPendingToolUse(msg)) return false;
          return messageHasDeliverableContent(msg);
        });
        if (hasFinalLikeAssistant) {
          set({ pendingFinal: true });
        }
      }

      // If pendingFinal, check whether the AI produced a final text response.
      // CRITICAL: reject intermediate tool turns (thinking+tool_use, mixed
      // thinking+text+tool_use, etc.) so the run stays "open" across all tool
      // rounds. Without `hasPendingToolUse` the closer matches the first
      // `[thinking, toolCall]` intermediate turn (because thinking *used to*
      // count as non-tool content), clears `sending` / `activeRunId` /
    // `pendingFinal`, and makes the Thinking indicator vanish mid-chain.
      if (pendingFinal || get().pendingFinal) {
        const recentAssistant = [...openRunSegment].reverse().find((msg) => {
          if (msg.role !== 'assistant') return false;
          if (hasPendingToolUse(msg)) return false;
          return messageHasDeliverableContent(msg);
        });
        if (recentAssistant) {
          if (shouldHoldActiveRunForPendingTasks()) {
            return true;
          }
          beginSessionBackendIdleSettlement(currentSessionKey, get().activeRunId);
          return true;
        }
      }

      // Unstick lifecycle when history already has a conclusive reply but the
      // Gateway never emitted a terminal phase event (WS drop, console run, etc.).
      // Allow unsticking when streamingTools is empty OR all entries are completed
      // (completed tool entries linger after tool rounds and must not block this).
      const noRunningTools = !get().streamingTools.some((t) => t.status === 'running');
      if (isSendingNow && !get().streamingMessage && noRunningTools) {
        const openSegment = openRunSegment;
        const hasConclusiveReply = openSegment.some((message) => {
          if (message.role !== 'assistant') return false;
          if (hasPendingToolUse(message)) return false;
          return messageHasDeliverableContent(message);
        });
        const hasDeliveredImageReply = openSegment.some((message) => message.role === 'assistant' && messageHasImageContent(message));
        if (hasDeliveredImageReply && !segmentHasOpenToolRun(openSegment)) {
          if (shouldHoldActiveRunForPendingTasks()) {
            return true;
          }
          beginSessionBackendIdleSettlement(currentSessionKey, get().activeRunId);
          return true;
        } else if (hasConclusiveReply && !segmentHasOpenToolRun(openSegment)) {
          if (shouldHoldActiveRunForPendingTasks()) {
            return true;
          }
          beginSessionBackendIdleSettlement(currentSessionKey, get().activeRunId);
          return true;
        }
        // Also unstick when all tool calls are resolved but the model's
        // terminal response was thinking-only (no visible content). The
        // `segmentHasOpenToolRun` update above detects this, but we still
        // need an explicit conclusive-reply fallback for the case where
        // hasConclusiveReply is false (thinking-only terminal turn).
        if (!hasConclusiveReply && !segmentHasOpenToolRun(openSegment) && openSegment.length > 0) {
          if (shouldHoldActiveRunForPendingTasks()) {
            return true;
          }
          beginSessionBackendIdleSettlement(currentSessionKey, get().activeRunId);
          return true;
        }
      }

      // Immutable transcript gaps describe an interrupted historical turn, not
      // current liveness. Re-arm from them only when the current Gateway reports
      // an active run; same-process session switches may also use the bounded
      // in-memory cache while the backend signal is unavailable.
      if (!get().sending && !latestTerminalAssistantErrorMessage) {
        const cachedRunState = getCachedSessionRunState(currentSessionKey);
        const cachedOpenSegment = postUserSegmentMessages(filteredMessages);
        const shouldRearmFromCachedRun = (
          cachedRunState.sending
          || cachedRunState.activeRunId != null
          || cachedRunState.pendingFinal
        ) && !backendSessionIdle
          && segmentHasOpenToolRun(cachedOpenSegment);
        const inferredOpenRun = inferredHistoricalOpenRun;
        const shouldRearmFromInferredRun = inferredOpenRun != null && backendSessionActive;
        if (shouldRearmFromCachedRun || backendSessionActive) {
          const restoredActiveRunId = authoritativeActiveRunId
            ?? (shouldRearmFromInferredRun ? inferredOpenRun!.runId : cachedRunState.activeRunId);
          _lastChatEventAt = Date.now();
          set({
            sending: true,
            activeRunId: restoredActiveRunId,
            pendingFinal: cachedRunState.pendingFinal
              || shouldRearmFromInferredRun
              || hasConclusiveAssistantReply,
            lastUserMessageAt: (shouldRearmFromInferredRun ? inferredOpenRun!.lastUserMessageAt : null)
              ?? cachedRunState.lastUserMessageAt
              ?? optionalToMs(findLastRealUserMessage(filteredMessages)?.timestamp ?? null)
              ?? Date.now(),
            runError: null,
          });
          captureSessionRunState(currentSessionKey, get());
        }
      }

      if (
        get().sending
        && !latestTerminalAssistantErrorMessage
        && !shouldTrackInboundRunLifecycle(get(), currentSessionKey)
      ) {
        beginSessionBackendIdleSettlement(currentSessionKey, get().activeRunId);
        return true;
      }
      return true;
      };

      let localFallbackApplied = false;
      let gatewayHistorySettled = false;

      const applyLocalFallbackMessages = async (
        options: { onlyWhileGatewayPending?: boolean; logTimeout?: boolean } = {},
      ): Promise<boolean> => {
        const fallbackMessages = await loadLocalHistoryFallback(currentSessionKey, HISTORY_PAGE_SIZE, {
          logTimeout: options.logTimeout,
        });
        if (
          fallbackMessages.length === 0
          || !isCurrentSession()
          || (options.onlyWhileGatewayPending && gatewayHistorySettled)
        ) {
          return false;
        }

        const applied = await applyLoadedMessages(fallbackMessages, null, null);
        if (!applied) return false;

        localFallbackApplied = true;
        if (isCurrentSession()) {
          set({ hasMoreHistory: fallbackMessages.length >= HISTORY_PAGE_SIZE });
        }
        if (isInitialForegroundLoad) {
          _foregroundHistoryLoadSeen.add(foregroundLoadKey);
          void refreshVisibleSessionSummaries(set, get);
        }
        return true;
      };

      const applyStartupFallbackAfterGrace = async (): Promise<'fallback' | 'none'> => {
        if (!isInitialForegroundLoad || !shouldShowForegroundLoading) {
          return 'none';
        }
        await sleep(CHAT_HISTORY_STARTUP_FALLBACK_RACE_MS);
        if (!isCurrentSession() || gatewayHistorySettled) {
          return 'none';
        }
        const applied = await applyLocalFallbackMessages({
          onlyWhileGatewayPending: true,
          logTimeout: false,
        });
        return applied ? 'fallback' : 'none';
      };

      const loadGatewayHistory = async (): Promise<void> => {
      try {
        const fallbackMessages: RawMessage[] = [];
        const chatHistoryParams = buildChatHistoryRpcParams(
          currentSessionKey,
          HISTORY_PAGE_SIZE,
          getChatHistoryMaxChars(),
        );

        let data: Record<string, unknown> | null = null;
        let lastError: unknown = null;
        let historyRequestStartedAt = Date.now();

        for (let attempt = 0; attempt <= CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS.length; attempt += 1) {
          if (!isCurrentSession()) {
            break;
          }

          try {
            historyRequestStartedAt = Date.now();
            data = await fetchChatHistory(
              currentSessionKey,
              HISTORY_PAGE_SIZE,
              chatHistoryParams.maxChars,
              historyTimeoutOverride,
            );
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
          }

          if (!isCurrentSession()) {
            break;
          }

          const errorKind = classifyHistoryStartupRetryError(lastError);
          const shouldRetry = isInitialForegroundLoad
            && attempt < CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS.length
            && shouldRetryStartupHistoryLoad(useGatewayStore.getState().status, errorKind);

          if (!shouldRetry) {
            break;
          }

          console.warn('[chat.history] startup retry scheduled', {
            sessionKey: currentSessionKey,
            attempt: attempt + 1,
            gatewayState: useGatewayStore.getState().status.state,
            errorKind,
            error: String(lastError),
          });
          await sleep(CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS[attempt]!);
        }

        if (data) {
          let rawMessages = Array.isArray(data.messages) ? data.messages as RawMessage[] : [];
          const thinkingLevel = data.thinkingLevel ? String(data.thinkingLevel) : null;
          const reasoningLevel = data.reasoningLevel ? String(data.reasoningLevel) : null;
          const historyAuthority = parseGatewayHistorySessionAuthority(
            data,
            currentSessionKey,
            historyRequestStartedAt,
          );
          if (rawMessages.length === 0 && isCronSessionKey(currentSessionKey)) {
            rawMessages = fallbackMessages.length > 0
              ? fallbackMessages
              : await loadLocalHistoryFallback(currentSessionKey, HISTORY_PAGE_SIZE);
          } else {
            rawMessages = await hydrateGatewayHistoryFromTranscript(
              currentSessionKey,
              rawMessages,
              HISTORY_PAGE_SIZE,
              get().messages,
            );
          }

          if (rawMessages.length === 0 && localFallbackApplied && !isCronSessionKey(currentSessionKey)) {
            if (isCurrentSession()) set({ loading: false });
            return;
          }

          const applied = await applyLoadedMessages(
            rawMessages,
            thinkingLevel,
            reasoningLevel,
            historyAuthority,
          );
          if (applied) {
            if (isCurrentSession()) set({ hasMoreHistory: rawMessages.length >= HISTORY_PAGE_SIZE });
          }
          if (applied && isInitialForegroundLoad) {
            _foregroundHistoryLoadSeen.add(foregroundLoadKey);
            void refreshVisibleSessionSummaries(set, get);
          }
        } else {
          const errorKind = classifyHistoryStartupRetryError(lastError);
          if (isCurrentSession() && isInitialForegroundLoad && errorKind) {
            console.warn('[chat.history] startup retry exhausted', {
              sessionKey: currentSessionKey,
              gatewayState: useGatewayStore.getState().status.state,
              error: String(lastError),
            });
          }

          const appliedLateFallback = fallbackMessages.length > 0
            ? await applyLoadedMessages(fallbackMessages, null, null)
            : await applyLocalFallbackMessages();
          if (appliedLateFallback) {
            if (fallbackMessages.length > 0) {
              localFallbackApplied = true;
              if (isCurrentSession()) {
                set({ hasMoreHistory: fallbackMessages.length >= HISTORY_PAGE_SIZE });
              }
              if (isInitialForegroundLoad) {
                _foregroundHistoryLoadSeen.add(foregroundLoadKey);
                void refreshVisibleSessionSummaries(set, get);
              }
            }
          } else if (localFallbackApplied) {
            if (isCurrentSession()) set({ loading: false });
          } else if (errorKind === 'timeout' && isInitialForegroundLoad) {
            // Keep startup usable while Gateway RPC routing catches up.  The
            // Sidebar/gateway event refreshes will retry quietly instead of
            // showing a transient "RPC timeout: chat.history" error.
            if (isCurrentSession()) set({ loading: false });
          } else {
            applyLoadFailure(
              (lastError instanceof Error ? lastError.message : String(lastError))
              || 'Failed to load chat history',
            );
          }
        }
      } catch (err) {
        console.warn('Failed to load chat history:', err);
        const applied = await applyLocalFallbackMessages();
        if (!applied && localFallbackApplied) {
          if (isCurrentSession()) set({ loading: false });
        } else if (!applied) {
          applyLoadFailure(String(err));
        }
      } finally {
        gatewayHistorySettled = true;
      }
      };

      const gatewayLoadPromise = loadGatewayHistory();
      if (isInitialForegroundLoad && shouldShowForegroundLoading) {
        await Promise.race([
          gatewayLoadPromise.then(() => 'gateway' as const),
          applyStartupFallbackAfterGrace(),
        ]);
      }
      await gatewayLoadPromise;
    })();

    _historyLoadInFlight.set(currentSessionKey, loadPromise);
    try {
      await loadPromise;
    } finally {
      // Clear the safety timer on normal completion
      if (loadingSafetyTimer) clearTimeout(loadingSafetyTimer);
      if (!loadingTimedOut) {
        // Only update load time if we actually didn't time out and the
        // completed request still belongs to the selected session.  Stale
        // loads from a session switch must not debounce the next foreground
        // startup attempt for that same session.
        if (get().currentSessionKey === currentSessionKey) {
          _lastHistoryLoadAtBySession.set(currentSessionKey, Date.now());
        }
      }

      const active = _historyLoadInFlight.get(currentSessionKey);
      if (active === loadPromise) {
        _historyLoadInFlight.delete(currentSessionKey);
      }
    }
  },

  loadMoreHistory: async () => {
    const { currentSessionKey, messages, loadingMoreHistory, hasMoreHistory } = get();
    if (loadingMoreHistory || !hasMoreHistory || messages.length === 0) return;

    set({ loadingMoreHistory: true, error: null });
    try {
      const nextLimit = Math.min(messages.length + HISTORY_PAGE_SIZE, HISTORY_MAX_RENDERED_MESSAGES);
      const rawMessages = await loadLocalHistoryFallback(currentSessionKey, nextLimit);
      if (get().currentSessionKey !== currentSessionKey) return;
      if (rawMessages.length === 0) {
        set({ hasMoreHistory: false, loadingMoreHistory: false });
        return;
      }

      // Reuse the normal history application path by replacing the visible
      // window with a larger suffix from the transcript.  This keeps render
      // cost bounded while allowing long conversations to page backwards.
      const messagesWithToolImages = enrichWithToolResultFiles(rawMessages);
      const messagesWithToolAttachments = enrichWithToolCallAttachments(messagesWithToolImages);
      const filteredMessages = filterHistoryMessagesForUi(messagesWithToolAttachments);
      const enrichedMessages = dedupeAssistantRepliesForDisplay(enrichWithCachedImages(filteredMessages));
      const runtimeHistoryMessages = buildRuntimeReplayMessages(messagesWithToolAttachments);
      set((state) => ({
        messages: enrichedMessages,
        loadingMoreHistory: false,
        hasMoreHistory: rawMessages.length >= nextLimit && nextLimit < HISTORY_MAX_RENDERED_MESSAGES,
        runtimeRuns: applyHistoricalRuntimeRunsFromMessages(state.runtimeRuns, currentSessionKey, runtimeHistoryMessages),
      }));
      cacheSessionHistory(currentSessionKey, enrichedMessages, get().thinkingLevel);
      const previewHydrationMessages = enrichedMessages.slice(-PREVIEW_HYDRATION_MESSAGE_LIMIT);
      void loadMissingPreviews(previewHydrationMessages).then((updated) => {
        if (!updated || get().currentSessionKey !== currentSessionKey) return;
        set((state) => ({
          ...(() => {
            const messages = state.messages.map((message) => {
            const match = previewHydrationMessages.find((candidate) => (
              `${candidate.id ?? ''}|${candidate.role}|${candidate.timestamp ?? ''}|${getMessageText(candidate.content)}`
              === `${message.id ?? ''}|${message.role}|${message.timestamp ?? ''}|${getMessageText(message.content)}`
            ));
            return match?._attachedFiles?.length ? { ...message, _attachedFiles: match._attachedFiles } : message;
            });
            return {
              messages,
              runtimeRuns: applyHistoricalRuntimeRunsFromMessages(
                state.runtimeRuns,
                currentSessionKey,
                runtimeHistoryMessages,
              ),
            };
          })(),
        }));
      });
    } catch (error) {
      console.warn('Failed to load more history:', error);
      set({ loadingMoreHistory: false, error: String(error) });
    } finally {
      if (get().currentSessionKey === currentSessionKey) {
        set({ loadingMoreHistory: false });
      }
    }
  },

  // ── Send message ──

  sendMessage: async (
    text: string,
    attachments?: ChatSendAttachment[],
    targetAgentId?: string | null,
    mode: ChatSendMode = 'chat',
    imageOptions?: ChatImageSendOptions,
    videoOptions?: ChatVideoSendOptions,
  ) => {
    const trimmed = text.trim();
    if (!trimmed && (!attachments || attachments.length === 0)) return;

    const targetSessionKey = resolveMainSessionKeyForAgent(targetAgentId)
      ?? get().currentSessionKey;
    if (!attachments?.length && isInternalMessage({ role: 'user', content: trimmed })) {
      console.info('[sendMessage] Dropping internal user message before gateway send', {
        sessionKey: targetSessionKey,
        text: trimmed,
      });
      return;
    }

    const pendingCwdMutation = _sessionCwdMutations.get(targetSessionKey);
    if (pendingCwdMutation) {
      try {
        await pendingCwdMutation;
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
    }

    // Same-session sends must stay ordered. The renderer owns a single active
    // run slot, so queue follow-up turns instead of dropping them or racing the
    // current run state.
    if (sessionExecutionIsBusy(get(), targetSessionKey)) {
      enqueueChatSendForSession(targetSessionKey, {
        text,
        attachments,
        targetAgentId,
        mode,
        imageOptions,
        videoOptions,
      });
      return;
    }

    const managedAuthReady = ensureManagedAuthReadyForSend();
    if (managedAuthReady) {
      try {
        await managedAuthReady;
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          sending: false,
        });
        return;
      }
    }

    // Auth/provider checks are asynchronous. Re-check the target session so a
    // run that started while they were pending cannot absorb this turn.
    if (sessionExecutionIsBusy(get(), targetSessionKey)) {
      enqueueChatSendForSession(targetSessionKey, {
        text,
        attachments,
        targetAgentId,
        mode,
        imageOptions,
        videoOptions,
      });
      return;
    }

    if (targetSessionKey !== get().currentSessionKey) {
      set((s) => buildSessionSwitchPatch(s, targetSessionKey));
      deferHistoryLoad(get, true);
    }

    _lastAttemptedChatSendBySession.set(targetSessionKey, {
      text,
      attachments: cloneQueuedAttachments(attachments),
      targetAgentId,
      mode,
      imageOptions: imageOptions ? { ...imageOptions } : undefined,
      videoOptions: videoOptions ? { ...videoOptions } : undefined,
      enqueuedAt: Date.now(),
    });

    try {
      await assertGatewayReadyForChatSend();
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        runError: null,
        sending: false,
      });
      return;
    }

    const currentSessionKey = targetSessionKey;
    const explicitPendingImages = (attachments ?? [])
      .filter((file) => file.mimeType.startsWith('image/') && file.stagedPath.trim().length > 0)
      .map((file) => ({
        fileName: file.fileName,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        stagedPath: file.stagedPath,
        preview: file.preview,
      }));
    const requestedImageEdit = isImageEditRequest(trimmed);
    const latestSessionImage = requestedImageEdit && explicitPendingImages.length === 0
      ? findLatestSessionImage(enrichWithCachedImages(get().messages))
      : null;

    // Add user message optimistically before planner/tool routing so the UI
    // acknowledges the submitted intent immediately.
    const nowMs = Date.now();
    const userMsg: RawMessage = {
      role: 'user',
      content: trimmed || (attachments?.length ? '(file attached)' : ''),
      timestamp: nowMs / 1000,
      id: crypto.randomUUID(),
      _attachedFiles: attachments?.map(a => ({
        fileName: a.fileName,
        mimeType: a.mimeType,
        fileSize: a.fileSize,
        preview: a.preview,
        filePath: a.stagedPath,
        source: 'user-upload',
        disposition: 'input-reference',
      })),
    };
    rememberPendingOptimisticUserMessage(currentSessionKey, userMsg, nowMs);
    set((s) => ({
      messages: [...s.messages, userMsg],
      sending: true,
      error: null,
      runError: null,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: nowMs,
    }));
    const sendGeneration = ++_sendGenerationCounter;
    _activeSendGenerationBySession.set(currentSessionKey, sendGeneration);
    const sendGenerationIsCurrent = () => activeSendGenerationMatches(currentSessionKey, sendGeneration);
    const clearSendGenerationIfCurrent = () => {
      if (sendGenerationIsCurrent()) {
        _activeSendGenerationBySession.delete(currentSessionKey);
      }
    };

    if (requestedImageEdit && explicitPendingImages.length === 0 && !latestSessionImage) {
      const { default: i18n } = await import('@/i18n');
      const assistantMsg: RawMessage = {
        role: 'assistant',
        content: i18n.t('composer.imageEditMissingReference', { ns: 'chat' }),
        timestamp: Date.now() / 1000,
        id: crypto.randomUUID(),
      };
      set((state) => ({
        messages: [...state.messages, assistantMsg],
        sending: false,
        pendingImageGenerationLocal: false,
        pendingVideoGenerationLocal: false,
        activeRunId: null,
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
      }));
      clearSendGenerationIfCurrent();
      markSessionRunIdle(currentSessionKey);
      return;
    }

    rememberPendingRuntimeIntent(currentSessionKey, {
      objective: trimmed,
      mode,
    });

    const { sessionLabels, messages } = get();
    const isFirstMessage = !messages.slice(0, -1).some((m) => m.role === 'user');
    if (!currentSessionKey.endsWith(':main') && isFirstMessage && !sessionLabels[currentSessionKey] && trimmed) {
      const labelText = toSessionLabel(trimmed);
      if (labelText) {
        set((s) => ({ sessionLabels: { ...s.sessionLabels, [currentSessionKey]: labelText } }));
      }
    }

    set((s) => ({ sessionLastActivity: { ...s.sessionLastActivity, [currentSessionKey]: nowMs } }));

    // Every new turn belongs to the native OpenClaw agent loop.
    const gatewayReferenceImages = explicitPendingImages.length > 0
      ? explicitPendingImages
      : (latestSessionImage ? [latestSessionImage] : []);
    const runtimeMessage = trimmed;
    const effectiveMode: ChatSendMode = mode;
    commitSessionRunState(set, get, currentSessionKey, {
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
    });

    try {
      await ensureSessionManagedTextModelAllowed(get, currentSessionKey);
    } catch (error) {
      if (!sendGenerationIsCurrent()) return;
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (get().currentSessionKey === currentSessionKey) {
        set({ error: errorMessage });
      }
      commitSessionRunState(set, get, currentSessionKey, {
        sending: false,
      });
      clearSendGenerationIfCurrent();
      return;
    }
    if (!sendGenerationIsCurrent()) return;

    // Runtime progress now comes from Main-owned streamed events. We still
    // keep the no-response safety timeout, but history polling is no longer
    // the primary active-run path.
    _lastChatEventAt = Date.now();
    clearHistoryPoll();
    clearErrorRecoveryTimer();

    const checkStuck = () => {
      const state = get();
      if (state.currentSessionKey !== currentSessionKey) {
        if (getCachedSessionRunState(currentSessionKey).sending) {
          setTimeout(checkStuck, 10_000);
        }
        return;
      }
      if (!state.sending) return;

      const hasStream = hasMeaningfulStreamingActivity(
        state.streamingMessage,
        state.streamingText,
        state.streamingTools,
      );
      if (hasStream) {
        setTimeout(checkStuck, 10_000);
        return;
      }

      // Gateway run-start / model-switch deltas can set `{ role: 'assistant' }`
      // with no payload. That placeholder must not block the safety timeout.
      if (state.streamingMessage || state.streamingText) {
        set({ streamingMessage: null, streamingText: '' });
      }

      const sendAgeMs = state.lastUserMessageAt
        ? Date.now() - toMs(state.lastUserMessageAt)
        : 0;
      const hasProgress = hasAssistantProgressSinceSend(state.messages, state.lastUserMessageAt);

      if (sendAgeMs >= LLM_IDLE_HINT_MS && !state.runError && !hasProgress) {
        console.info('[sendMessage] Model call exceeded one idle window; keeping run active for gateway/runtime retry', {
          sessionKey: currentSessionKey,
          sendAgeMs,
          activeRunId: state.activeRunId,
        });
      }

      if (state.pendingFinal) {
        if (hasProgress) {
          setTimeout(checkStuck, 10_000);
          return;
        }
        set({ pendingFinal: false });
      }

      if (hasProgress) {
        _lastChatEventAt = Date.now();
        if (state.error || state.runError) {
          set({ error: null, runError: null });
        }
        setTimeout(checkStuck, 10_000);
        return;
      }

      if (hasRecentRuntimeActivityForSend(state, currentSessionKey)) {
        _lastChatEventAt = Date.now();
        if (state.error || state.runError) {
          set({ error: null, runError: null });
        }
        setTimeout(checkStuck, 10_000);
        return;
      }

      if (Date.now() - _lastChatEventAt < NO_RESPONSE_SAFETY_TIMEOUT_MS) {
        setTimeout(checkStuck, 10_000);
        return;
      }

      clearHistoryPoll();
      const noResponseRunId = state.activeRunId;
      set({
        error: buildNoResponseSafetyMessage(),
        pendingFinal: true,
        streamingMessage: null,
        streamingText: '',
      });
      beginSessionBackendIdleSettlement(currentSessionKey, noResponseRunId);
    };
    setTimeout(checkStuck, 30_000);

    const applySendFailure = (errorMsg: string, discardOptimisticMessage = false) => {
      const latest = get();
      const sendStillCurrent = _activeSendGenerationBySession.get(currentSessionKey) === sendGeneration;
      const canApplyToCurrentSession = latest.currentSessionKey === currentSessionKey
        && latest.lastUserMessageAt === nowMs;

      if (sendStillCurrent && canApplyToCurrentSession) {
        clearSendGenerationIfCurrent();
        clearHistoryPoll();
        if (discardOptimisticMessage) {
          discardPendingOptimisticUserMessage(currentSessionKey, userMsg.id);
          set((state) => ({
            messages: state.messages.filter((message) => message.id !== userMsg.id),
            error: errorMsg,
            sending: false,
          }));
        } else {
          set({ error: errorMsg, sending: false });
        }
        markSessionRunIdle(currentSessionKey);
        return;
      }

      if (sendStillCurrent && latest.currentSessionKey !== currentSessionKey) {
        const cached = _sessionRunStateCache.get(currentSessionKey);
        if (cached?.lastUserMessageAt === nowMs) {
          if (discardOptimisticMessage) {
            discardPendingOptimisticUserMessage(currentSessionKey, userMsg.id);
          }
          markSessionRunIdle(currentSessionKey);
          return;
        }
      }

      console.warn('[sendMessage] Ignoring stale chat.send failure', {
        error: errorMsg,
        sessionKey: currentSessionKey,
      });
    };

    try {
      // Provider/model persistence above can take long enough for a just-
      // restarted Gateway to disconnect. Check Main-process truth again right
      // before the host/RPC send path accepts the turn.
      await assertGatewayReadyForChatSend();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      applySendFailure(errorMessage, error instanceof GatewayNotReadyForChatSendError);
      return;
    }

    try {
      const idempotencyKey = crypto.randomUUID();
      const thinkingLevel = get().thinkingLevel ?? undefined;
      const chatMediaAttachments = [
        ...(attachments ?? []),
        ...gatewayReferenceImages
          .filter((image) => !(attachments ?? []).some((attachment) => attachment.stagedPath === image.stagedPath))
          .map((image) => ({
            fileName: image.fileName,
            mimeType: image.mimeType,
            fileSize: image.fileSize,
            stagedPath: image.stagedPath,
            preview: image.preview,
          })),
      ];
      const hasMedia = chatMediaAttachments.length > 0;
      const clientPreferences = buildGatewayTurnPreferences({
        mode: effectiveMode,
        prompt: trimmed,
        hasSourceImage: chatMediaAttachments.some((attachment) => attachment.mimeType.startsWith('image/')),
        imageOptions,
        videoOptions,
        selectedArtifacts: gatewayReferenceImages,
      });

      // Cache image attachments BEFORE the IPC call to avoid race condition:
      // history may reload (via Gateway event) before the RPC returns.
      // Keyed by staged file path which appears in [media attached: <path> ...].
      if (hasMedia) {
        for (const a of chatMediaAttachments) {
          _imageCache.set(a.stagedPath, {
            fileName: a.fileName,
            mimeType: a.mimeType,
            fileSize: a.fileSize,
            preview: a.preview,
            source: 'user-upload',
            disposition: 'input-reference',
          });
        }
        saveImageCache(_imageCache);
      }

      let result: { success: boolean; result?: { runId?: string }; error?: string };

      if (hasMedia) {
        result = await hostApiFetch<{ success: boolean; result?: { runId?: string }; error?: string }>(
          '/api/chat/send-with-media',
          {
            method: 'POST',
            body: JSON.stringify({
              sessionKey: currentSessionKey,
              message: runtimeMessage || 'Process the attached file(s).',
              deliver: false,
              idempotencyKey,
              ...(thinkingLevel ? { thinking: thinkingLevel } : {}),
              clientPreferences,
              inlineAttachments: Boolean(attachments?.length),
              media: chatMediaAttachments.map((a) => ({
                filePath: a.stagedPath,
                mimeType: a.mimeType,
                fileName: a.fileName,
              })),
            }),
          },
        );
      } else {
        const rpcResult = await sendChatMessageViaHostApi({
          sessionKey: currentSessionKey,
          message: runtimeMessage,
          deliver: false,
          idempotencyKey,
          thinking: thinkingLevel,
          clientPreferences,
        });
        result = { success: true, result: rpcResult };
      }

      if (!result.success) {
        const errorMsg = result.error || 'Failed to send message';
        if (isRecoverableChatSendTimeout(errorMsg)) {
          if (await gatewayIsUnavailableForChatSend()) {
            applySendFailure(errorMsg, true);
          } else {
            console.warn(`[sendMessage] Recoverable chat.send timeout, keeping poll alive: ${errorMsg}`);
          }
        } else {
          applySendFailure(errorMsg, await gatewayIsUnavailableForChatSend());
        }
      } else if (result.result?.runId) {
        const returnedRunId = result.result.runId;
        const latest = get();
        const sendStillCurrent = _activeSendGenerationBySession.get(currentSessionKey) === sendGeneration;
        const canAttachToCurrentSession = latest.currentSessionKey === currentSessionKey
          && latest.sending
          && latest.lastUserMessageAt === nowMs
          && (latest.activeRunId == null || latest.activeRunId === returnedRunId);

        if (sendStillCurrent && canAttachToCurrentSession) {
          clearSendGenerationIfCurrent();
          set((state) => ({
            activeRunId: returnedRunId,
            runtimeRuns: applyRuntimeContractEvents(
              state.runtimeRuns,
              buildRuntimeStartEventsForRun(state.runtimeRuns, {
                runId: returnedRunId,
                sessionKey: currentSessionKey,
                ts: Date.now(),
              }),
            ),
          }));
        } else if (sendStillCurrent && latest.currentSessionKey !== currentSessionKey) {
          const cached = _sessionRunStateCache.get(currentSessionKey);
          if (cached?.sending
            && cached.lastUserMessageAt === nowMs
            && (cached.activeRunId == null || cached.activeRunId === returnedRunId)) {
            clearSendGenerationIfCurrent();
            captureSessionRunState(currentSessionKey, { ...cached, activeRunId: returnedRunId });
            set((state) => ({
              runtimeRuns: applyRuntimeContractEvents(
                state.runtimeRuns,
                buildRuntimeStartEventsForRun(state.runtimeRuns, {
                  runId: returnedRunId,
                  sessionKey: currentSessionKey,
                  ts: Date.now(),
                }),
              ),
            }));
          }
        } else {
          console.warn('[sendMessage] Ignoring stale chat.send runId', {
            runId: returnedRunId,
            sessionKey: currentSessionKey,
          });
        }
      } else {
        clearSendGenerationIfCurrent();
      }
    } catch (err) {
      const errStr = err instanceof Error ? err.message : String(err);
      if (isRecoverableChatSendTimeout(errStr)) {
        if (await gatewayIsUnavailableForChatSend()) {
          applySendFailure(errStr, true);
        } else {
          console.warn(`[sendMessage] Recoverable chat.send timeout, keeping poll alive: ${errStr}`);
        }
      } else {
        applySendFailure(
          errStr,
          err instanceof GatewayNotReadyForChatSendError || await gatewayIsUnavailableForChatSend(),
        );
      }
    }
  },

  // ── Abort active run ──

  abortRun: async () => {
    const stateAtAbort = get();
    const { currentSessionKey, activeRunId } = stateAtAbort;
    if (_sessionsCancelling.has(currentSessionKey)) return;

    clearErrorRecoveryTimer();
    const detachedTaskIds = collectRunDetachedTaskIdsForAbort(stateAtAbort.runtimeRuns, activeRunId);
    const hostTaskIds = collectRunHostTaskIdsForAbort(stateAtAbort.runtimeRuns, activeRunId);
    const hostTaskIdSet = new Set(hostTaskIds);
    const nativeDetachedTaskIds = detachedTaskIds.filter((taskId) => !hostTaskIdSet.has(taskId));
    _sessionsCancelling.add(currentSessionKey);
    _activeSendGenerationBySession.delete(currentSessionKey);
    // Cancellation is only a request. Keep the controls in the running state
    // until OpenClaw emits a terminal lifecycle event or reports an idle session.
    set({ sending: true, pendingFinal: true });

    try {
      const hostCancellationResults = await Promise.allSettled(hostTaskIds.map(async (taskId) => {
        await hostApiFetch(
          `/api/task-bridge/tasks/${encodeURIComponent(taskId)}/cancel`,
          {
            method: 'POST',
            body: JSON.stringify({
              reason: 'Cancelled from the UClaw composer.',
              correlation: { sessionKey: currentSessionKey },
            }),
          },
        );
      }));
      const failedHostCancellations = hostCancellationResults.filter((result) => result.status === 'rejected');
      if (failedHostCancellations.length > 0) {
        console.warn('[abortRun] Some Host tasks could not be cancelled:', failedHostCancellations.length);
      }
    } catch (err) {
      console.warn('[abortRun] Failed to cancel one or more Host tasks:', err);
    }

    try {
      await abortChatRunViaHostApi(currentSessionKey, activeRunId, nativeDetachedTaskIds);
    } catch (err) {
      set({ error: String(err) });
    } finally {
      _sessionsCancelling.delete(currentSessionKey);
      beginSessionBackendIdleSettlement(currentSessionKey, activeRunId);
    }
  },

  retryLastRun: async () => {
    const sessionKey = get().currentSessionKey;
    const previous: QueuedChatSend | undefined = _lastAttemptedChatSendBySession.get(sessionKey) ?? (() => {
      const lastUserMessage = findLastRealUserMessage(get().messages);
      if (!lastUserMessage) return undefined;
      const text = getMessageText(lastUserMessage.content).trim();
      const attachments = (lastUserMessage._attachedFiles ?? [])
        .filter((file) => Boolean(file.filePath?.trim()))
        .map((file): ChatSendAttachment => ({
          fileName: file.fileName,
          mimeType: file.mimeType,
          fileSize: file.fileSize,
          stagedPath: file.filePath!,
          preview: file.preview,
        }));
      if (!text && attachments.length === 0) return undefined;
      return {
        text,
        attachments: attachments.length > 0 ? attachments : undefined,
        targetAgentId: get().currentAgentId,
        mode: 'chat' as const,
        imageOptions: undefined,
        videoOptions: undefined,
        enqueuedAt: Date.now(),
      };
    })();
    if (!previous) {
      set({ runError: i18n.t('chat:runError.retryUnavailable') });
      return;
    }
    set({ error: null, runError: null });
    await get().sendMessage(
      previous.text,
      cloneQueuedAttachments(previous.attachments),
      previous.targetAgentId,
      previous.mode,
      previous.imageOptions ? { ...previous.imageOptions } : undefined,
      previous.videoOptions ? { ...previous.videoOptions } : undefined,
    );
  },

  // ── Handle incoming chat events from Gateway ──

  handleChatEvent: (event: Record<string, unknown>) => {
    const eventRunId = String(event.runId || '');
    const eventState = String(event.state || '');
    const rawEventSessionKey = event.sessionKey != null ? String(event.sessionKey) : null;
    const initialState = get();
    const eventSessionKey = inferSessionKeyForRun(initialState, eventRunId || null, rawEventSessionKey);
    const { activeRunId, currentSessionKey } = initialState;
    const terminalEvent = eventState === 'final'
      || eventState === 'error'
      || eventState === 'aborted'
      || (event.message && typeof event.message === 'object'
        && getMessageStopReason(event.message as Record<string, unknown>) != null);
    const completionWakeOwnerRunId = resolveCompletionWakeOwnerRunId({
      runtimeRuns: initialState.runtimeRuns,
      activeRunId,
      eventRunId,
      currentSessionKey,
      eventSessionKey,
    });
    const correlatedCompletionWake = completionWakeOwnerRunId != null;
    const runId = completionWakeOwnerRunId ?? eventRunId;
    const asyncTaskEvidence = extractAsyncTaskEvidence(event.message ?? event);
    if (asyncTaskEvidence.length > 0) {
      const ownerRunId = runId || activeRunId;
      set((state) => ({
        runtimeRuns: applyAsyncTaskEvidenceToRuns(
          state.runtimeRuns,
          ownerRunId,
          asyncTaskEvidence,
          eventSessionKey ?? currentSessionKey,
        ),
      }));
      scheduleWithheldFinalReevaluationForSession(eventSessionKey ?? currentSessionKey);
    }
    if (completionWakeOwnerRunId && terminalEvent) {
      const stopReason = event.message && typeof event.message === 'object'
        ? getMessageStopReason(event.message as Record<string, unknown>)
        : null;
      const completionWakeIsTerminal = eventState === 'final'
        || eventState === 'error'
        || eventState === 'aborted'
        || (stopReason != null && !/^(?:tool[_-]?use|tooluse)$/iu.test(stopReason));
      if (completionWakeIsTerminal) {
        set((state) => {
          const taskEvent = buildCompletionWakeTerminalTaskEvent({
            runtimeRuns: state.runtimeRuns,
            ownerRunId: completionWakeOwnerRunId,
            eventRunId,
            sessionKey: eventSessionKey ?? currentSessionKey,
            state: eventState === 'error' ? 'error' : eventState === 'aborted' ? 'aborted' : 'final',
            error: typeof event.errorMessage === 'string'
              ? event.errorMessage
              : event.message && typeof event.message === 'object'
                ? getMessageErrorMessage(event.message as Record<string, unknown>) ?? undefined
                : undefined,
            ts: Date.now(),
          });
          return taskEvent
            ? { runtimeRuns: applyRuntimeContractEvents(state.runtimeRuns, [taskEvent]) }
            : {};
        });
      }
    }

    // Only process events for the current session (when sessionKey is present)
    if (eventSessionKey != null && eventSessionKey !== currentSessionKey) {
      if (terminalEvent) {
        const ownerRunId = _sessionRunStateCache.get(eventSessionKey)?.activeRunId || runId;
        const ownerRun = ownerRunId ? get().runtimeRuns[ownerRunId] : undefined;
        if (!runtimeRunHasPendingAsyncTasks(ownerRun)) {
          markSessionRunIdle(eventSessionKey);
        }
        markSessionNeedsTerminalHistoryRefresh(eventSessionKey);
      }
      console.info('[handleChatEvent] Routed non-current chat event to session cache', {
        runId,
        eventSessionKey,
        currentSessionKey,
        state: eventState,
        terminalEvent,
      });
      return;
    }

    // Only process events for the active run (or if no active run set).
    // Inbound channel traffic (Feishu/Telegram/etc.) on the current session uses a
    // different runId than a stale desktop activeRunId  - still refresh history on finals.
    if (activeRunId && runId && runId !== activeRunId) {
      const isCurrentSession = eventSessionKey == null || eventSessionKey === currentSessionKey;
      if (isCurrentSession && terminalEvent) {
        void get().loadHistory(true);
      }
      return;
    }

    if (isDuplicateChatEvent(eventState, event)) {
      return;
    }

    _lastChatEventAt = Date.now();

    // Defensive: if state is missing but we have a message, try to infer state.
    let resolvedState = eventState;
    if (!resolvedState && event.message && typeof event.message === 'object') {
      const msg = event.message as Record<string, unknown>;
        const stopReason = getMessageStopReason(msg);
        if (stopReason === 'error') {
          resolvedState = 'error';
        } else if (stopReason) {
          resolvedState = 'final';
      } else if (msg.role || msg.content) {
        resolvedState = 'delta';
      }
    }

    // Only pause the history poll when we receive actual streaming data.
    // The gateway sends "agent" events with { phase, startedAt } that carry
    // no message  - these must NOT kill the poll, since the poll is our only
    // way to track progress when the gateway doesn't stream intermediate turns.
    const hasUsefulData = resolvedState === 'delta' || resolvedState === 'final'
      || resolvedState === 'error' || resolvedState === 'aborted';
    if (hasUsefulData) {
      clearHistoryPoll();
      // Adopt run started from another client only for user-initiated turns.
      // Background :main heartbeat runs must not surface "Thinking..." in the UI.
      const { sending } = get();
      if (!sending && runId && shouldTrackInboundRunLifecycle(get(), currentSessionKey)) {
        set({ sending: true, activeRunId: runId, error: null, runError: null });
      }
    }

    switch (resolvedState) {
      case 'started': {
        const { sending: currentSending } = get();
        if (runId) {
          set((state) => ({
            ...(!currentSending && shouldTrackInboundRunLifecycle(state, currentSessionKey)
              ? { sending: true, activeRunId: runId, error: null, runError: null }
              : {}),
            runtimeRuns: applyRuntimeContractEvents(
              state.runtimeRuns,
              buildRuntimeStartEventsForRun(state.runtimeRuns, {
                runId,
                sessionKey: eventSessionKey ?? currentSessionKey,
                ts: Date.now(),
              }),
            ),
          }));
        }
        break;
      }
      case 'delta': {
        // Clear any stale error (including RPC timeout) when new data arrives.
        if (_errorRecoveryTimer) {
          clearErrorRecoveryTimer();
        }
        if (get().error || get().runError) {
          set({ error: null, runError: null });
        }
        const updates = collectToolUpdates(event.message, resolvedState);
        // Capture baseline file content from disk before the runtime
        // executes Write tool calls  - enables proper before/after diff.
        captureBaselinesFromMessage(
          event.message,
          getBaselineRunKeyForMessages(currentSessionKey, get().messages),
        );
        set((s) => ({
          streamingMessage: (() => {
            if (event.message && typeof event.message === 'object') {
              const msgRole = (event.message as RawMessage).role;
              if (isToolResultRole(msgRole)) return s.streamingMessage;
            }
            return normalizeStreamingMessage(event.message ?? s.streamingMessage);
          })(),
          streamingTools: updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools,
        }));
        break;
      }
      case 'final': {
        clearErrorRecoveryTimer();
        if (get().error || get().runError) set({ error: null, runError: null });
        // Message complete - add to history and clear streaming
        const finalMsg = event.message as RawMessage | undefined;
        if (finalMsg) {
          const normalizedFinalMessage = normalizeStreamingMessage(finalMsg) as RawMessage;
          if (isTerminalAssistantErrorMessage(normalizedFinalMessage)) {
            get().handleChatEvent({
              ...event,
              state: 'error',
              errorMessage: getMessageErrorMessage(normalizedFinalMessage) ?? event.errorMessage,
              message: normalizedFinalMessage,
            });
            break;
          }
          const updates = collectToolUpdates(normalizedFinalMessage, resolvedState);
          // Filter out internal-only final responses (NO_REPLY, HEARTBEAT_OK, etc.)
          // before adding to messages. Without this guard, the internal token appears
          // briefly in the UI until loadHistory replaces the message list  - and if the
          // quiet-mode reload is debounced away, the token can stay visible permanently.
          if (isInternalMessage(normalizedFinalMessage)) {
            const sessionKeyForReload = get().currentSessionKey;
            set({
              streamingText: '',
              streamingMessage: null,
              pendingFinal: true,
              streamingTools: [],
            });
            clearHistoryPoll();
            beginSessionBackendIdleSettlement(sessionKeyForReload, runId ?? get().activeRunId);
            forceNextHistoryLoad(sessionKeyForReload);
            void get().loadHistory(true);
            break;
          }
          if (isToolResultRole(normalizedFinalMessage.role)) {
            // Resolve file path from the streaming assistant message's matching tool call
            const currentStreamForPath = get().streamingMessage as RawMessage | null;
            const matchedPath = (currentStreamForPath && normalizedFinalMessage.toolCallId)
              ? getToolCallFilePath(currentStreamForPath, normalizedFinalMessage.toolCallId)
              : undefined;

            // Mirror `enrichWithToolResultFiles`: collect non-image artifacts
            // for the next assistant message. Images embedded inside a tool
            // result (read tool's vision data) and raw image paths in the
            // tool's stdout (sips / ls / file output) are NOT user-facing  -
            // the canonical render is the Gateway-injected `assistant-media`
            // bubble that follows the agent's `MEDIA:` text. Surfacing those
            // intermediate images here would duplicate every screenshot the
            // agent inspects on its way to the final artifact.
            const toolFiles: AttachedFileMeta[] = extractImagesAsAttachedFiles(
              normalizedFinalMessage.content,
            ).filter(file => !file.mimeType.startsWith('image/'));
            if (matchedPath) {
              for (const f of toolFiles) {
                if (!f.filePath) {
                  f.filePath = matchedPath;
                  f.fileName = matchedPath.split(/[\\/]/).pop() || 'image';
                }
              }
            }
            const text = getMessageText(normalizedFinalMessage.content);
            if (text) {
              const mediaRefs = extractMediaRefs(text);
              const mediaRefPaths = new Set(mediaRefs.map(r => r.filePath));
              for (const ref of mediaRefs) toolFiles.push(makeAttachedFile(ref));
              for (const ref of extractRawFilePaths(text)) {
                if (mediaRefPaths.has(ref.filePath)) continue;
                if (ref.mimeType.startsWith('image/')) continue;
                toolFiles.push(makeAttachedFile(ref));
              }
            }
            const toolArtifactEvents = runId && toolFiles.length > 0
              ? buildRuntimeArtifactEventsFromAttachedFiles({
                  runId,
                  sessionKey: eventSessionKey ?? currentSessionKey,
                  ts: Date.now(),
                  toolCallId: normalizedFinalMessage.toolCallId,
                  verificationDetail: '工具结果中的产物已进入 UClaw 产物跟踪。',
                }, toolFiles)
              : [];
            const toolArtifacts = toolArtifactEvents
              .filter((runtimeEvent): runtimeEvent is Extract<ChatRuntimeEvent, { type: 'artifact.produced' }> =>
                runtimeEvent.type === 'artifact.produced')
              .map((runtimeEvent) => runtimeEvent.artifact);
            set((s) => {
              // Preserve the assistant turn that requested the tool before the
              // tool result clears streaming state. Runtime events render the
              // live execution graph, but the legacy chat-event path still
              // needs this snapshot for providers/transports that do not emit
              // complete runtime tool events.
              const currentStream = s.streamingMessage as RawMessage | null;
              const snapshotMsgs = snapshotStreamingAssistantMessage(currentStream, s.messages, runId);
              return {
                messages: snapshotMsgs.length > 0 ? [...s.messages, ...snapshotMsgs] : s.messages,
                streamingText: '',
                streamingMessage: null,
                pendingFinal: true,
                pendingToolImages: toolFiles.length > 0
                  ? dedupeAttachedFiles([...s.pendingToolImages, ...toolFiles])
                  : s.pendingToolImages,
                streamingTools: updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools,
                runtimeRuns: applyRuntimeContractEvents(s.runtimeRuns, toolArtifactEvents),
              };
            });
            if (toolArtifacts.length > 0) {
              scheduleRuntimeArtifactVerification(runId, eventSessionKey ?? currentSessionKey, toolArtifacts);
            }
            break;
          }
          // Mixed `[thinking, text, toolCall]` messages with stop_reason="tool_use"
          // (some MiniMax / gpt-5.5 variants emit these) are still intermediate
          // turns even though they carry user-visible text. Treat them as
          // tool-only for lifecycle purposes so the run stays "open" until the
          // truly final reply (without a pending tool call) arrives.
          const pendingTool = hasPendingToolUse(normalizedFinalMessage);
          const toolOnly = isToolOnlyMessage(normalizedFinalMessage) || pendingTool;
          const hasOutput = !pendingTool && messageHasDeliverableContent(normalizedFinalMessage);
          // When the model ends its turn with only `thinking` blocks (no text,
          // no images, no tool calls), `hasOutput` is false and `toolOnly` is
          // false. This is a valid terminal state (the model decided not to
          // produce user-visible content  - common after image_generate +
          // message-send tool chains on MiniMax-M2.7). Without this flag the
          // lifecycle stays armed indefinitely, leaving the UI stuck on
          // "Thinking..." even though the run is complete.
          const isEmptyTerminalResponse = !toolOnly && !hasOutput && !pendingTool;
          const clearLifecycle = hasOutput || isEmptyTerminalResponse;
          const msgId = normalizedFinalMessage.id || (toolOnly ? `run-${runId}-tool-${Date.now()}` : `run-${runId}`);
          let finalArtifactsToVerify: ChatRuntimeArtifact[] = [];
          let withheldFinalMessage: RawMessage | undefined;
          let emptyTerminalFailure: string | undefined;
          set((s) => {
            const nextTools = updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools;
            const streamingTools = clearLifecycle ? [] : nextTools;

            // Note: it would be tempting to also surface `MEDIA:/path`
            // markers from `normalizedFinalMessage.content`'s text here, so
            // the agent's reply could attach the original file directly
            // (`/tmp/...png`) without waiting for the post-final history
            // reload. However, OpenClaw's `splitTrailingDirective`
            // (selection-D8_ELZa7.js ~line 904) strips `MEDIA:/...` lines
            // out of the streaming text BEFORE it reaches the client, so
            // the `final` event we get here never contains the marker.
            // Image surfacing is fully handled by the post-final reload
            // below + `enrichWithCachedImages` (which dereferences the
            // assistant-media bubble's `block.url`).
            const pendingImgs = s.pendingToolImages;
            const currentRuntimeRun = runId ? s.runtimeRuns[runId] : undefined;
            const hasArtifactDelivery = hasDeliveredArtifactEvidence(currentRuntimeRun, pendingImgs);
            const synthesizedFinalText = isEmptyTerminalResponse
              ? (hasArtifactDelivery ? i18n.t('chat:executionGraph.compact.artifactDone') : '')
              : '';
            emptyTerminalFailure = isEmptyTerminalResponse && !synthesizedFinalText
              ? i18n.t('chat:runError.emptyFinal')
              : undefined;
            const effectiveFinalMessage = synthesizedFinalText
              ? { ...normalizedFinalMessage, content: synthesizedFinalText }
              : normalizedFinalMessage;
            const shouldAttachPendingFiles = pendingImgs.length > 0 && !pendingTool;
            const msgWithImages: RawMessage = shouldAttachPendingFiles
              ? {
                ...effectiveFinalMessage,
                role: (effectiveFinalMessage.role || 'assistant') as RawMessage['role'],
                id: msgId,
                _attachedFiles: dedupeAttachedFiles([
                  ...(effectiveFinalMessage._attachedFiles || []),
                  ...pendingImgs,
                ]),
              }
              : { ...effectiveFinalMessage, role: (effectiveFinalMessage.role || 'assistant') as RawMessage['role'], id: msgId };
            const clearPendingImages = pendingTool
              ? {}
              : { pendingToolImages: [] as AttachedFileMeta[] };
            const finalArtifactEvents = runId && (msgWithImages._attachedFiles?.length ?? 0) > 0
              ? buildRuntimeArtifactEventsFromAttachedFiles({
                  runId,
                  sessionKey: eventSessionKey ?? currentSessionKey,
                  ts: Date.now(),
                  verificationDetail: '最终回复中的产物已进入 UClaw 产物卡片。',
                }, msgWithImages._attachedFiles ?? [])
              : [];
            finalArtifactsToVerify = finalArtifactEvents
              .filter((runtimeEvent): runtimeEvent is Extract<ChatRuntimeEvent, { type: 'artifact.produced' }> =>
                runtimeEvent.type === 'artifact.produced')
              .map((runtimeEvent) => runtimeEvent.artifact);
            let runtimeRuns = applyRuntimeContractEvents(s.runtimeRuns, finalArtifactEvents);
            const hasPendingAsyncTask = runId
              ? runtimeRunHasPendingAsyncTasks(runtimeRuns[runId])
              : false;
            const shouldHoldForContinuation = clearLifecycle
              && !toolOnly
              && hasPendingAsyncTask;
            const shouldAwaitBackendIdle = clearLifecycle
              && !toolOnly
              && !hasPendingAsyncTask;
            if (shouldHoldForContinuation) {
              withheldFinalMessage = msgWithImages;
              return {
                streamingText: '',
                streamingMessage: null,
                pendingFinal: true,
                streamingTools,
                runtimeRuns,
                ...clearPendingImages,
              };
            }
            if (emptyTerminalFailure) {
              return {
                streamingText: '',
                streamingMessage: null,
                pendingFinal: true,
                streamingTools: [],
                runtimeRuns,
                runError: emptyTerminalFailure,
                ...clearPendingImages,
              };
            }
            // Check if message already exists (prevent duplicates)
            const alreadyExists = s.messages.some(m => m.id === msgId);
            if (alreadyExists) {
              return toolOnly ? {
                streamingText: '',
                streamingMessage: null,
                pendingFinal: true,
                streamingTools,
                runtimeRuns,
                ...clearPendingImages,
              } : {
                streamingText: '',
                streamingMessage: null,
                sending: s.sending,
                activeRunId: s.activeRunId,
                pendingFinal: shouldAwaitBackendIdle || s.pendingFinal,
                streamingTools,
                runtimeRuns,
                ...clearPendingImages,
              };
            }
            return toolOnly ? {
              messages: [...s.messages, msgWithImages],
              streamingText: '',
              streamingMessage: null,
              pendingFinal: true,
              streamingTools,
              runtimeRuns,
              ...clearPendingImages,
            } : {
              messages: [...s.messages, msgWithImages],
              streamingText: '',
              streamingMessage: null,
              sending: s.sending,
              activeRunId: s.activeRunId,
              pendingFinal: shouldAwaitBackendIdle || s.pendingFinal,
              streamingTools,
              runtimeRuns,
              ...clearPendingImages,
            };
          });
          if (runId && withheldFinalMessage) {
            _withheldFinalDeliveryByRun.set(runId, {
              runId,
              sessionKey: eventSessionKey ?? currentSessionKey,
              message: withheldFinalMessage,
            });
          } else if (runId) {
            _withheldFinalDeliveryByRun.delete(runId);
          }
          if (runId && finalArtifactsToVerify.length > 0) {
            scheduleRuntimeArtifactVerification(runId, eventSessionKey ?? currentSessionKey, finalArtifactsToVerify);
          }
          // Defer the transcript refresh until OpenClaw confirms the session is idle.
          // A snapshot fetched while the final payload is still being persisted can
          // otherwise erase the live final reply from the renderer.
          const sessionKeyAtFinal = eventSessionKey ?? currentSessionKey;
          if (clearLifecycle && !toolOnly && !withheldFinalMessage) {
            clearHistoryPoll();
            beginSessionBackendIdleSettlement(sessionKeyAtFinal, runId ?? get().activeRunId);
            markSessionNeedsTerminalHistoryRefresh(sessionKeyAtFinal);

          } else if (clearLifecycle && !toolOnly && correlatedCompletionWake) {
            // Completion-wake finals have their MEDIA directives removed from
            // the live chat payload. Keep the gate closed, but reload the
            // authoritative transcript so the original run can recover the
            // persisted artifact and verification evidence before reevaluation.
            clearHistoryPoll();
            markSessionNeedsTerminalHistoryRefresh(sessionKeyAtFinal);
            [0, 500, 1500].forEach((delayMs) => {
              setTimeout(() => {
                if (get().currentSessionKey !== sessionKeyAtFinal) return;
                forceNextHistoryLoad(sessionKeyAtFinal);
                void get().loadHistory(true);
              }, delayMs);
            });
          }
        } else {
          const sessionKeyAtFinal = eventSessionKey ?? currentSessionKey;
          const latestState = get();
          const terminalRunId = runId || latestState.activeRunId;
          set({ streamingText: '', streamingMessage: null, pendingFinal: true });
          beginSessionBackendIdleSettlement(sessionKeyAtFinal, terminalRunId);
          markSessionNeedsTerminalHistoryRefresh(sessionKeyAtFinal);
          [0, 500, 1500, 4000].forEach((delayMs) => {
            setTimeout(() => {
              if (get().currentSessionKey !== sessionKeyAtFinal) return;
              forceNextHistoryLoad(sessionKeyAtFinal);
              void get().loadHistory(true);
            }, delayMs);
          });
        }
        break;
      }
      case 'error': {
        const errorMsg = String(
          event.errorMessage
          || getMessageErrorMessage(event.message)
          || 'An error occurred',
        );
        const normalizedErrorMsg = normalizeChatRunErrorMessage(errorMsg);
        const terminalAssistantError = isTerminalAssistantErrorMessage(event.message);
        const wasSending = get().sending;
        const sessionKeyAtError = eventSessionKey ?? currentSessionKey;
        const recoverable = wasSending && isRecoverableRuntimeError(errorMsg);
        const replySessionInitConflict = isReplySessionInitializationConflictError(errorMsg);

        const commitRuntimeError = () => {
          const currentStream = get().streamingMessage as RawMessage | null;
          const currentMessages = get().messages;
          const errorSnapshot = snapshotStreamingAssistantMessage(
            currentStream,
            currentMessages,
            `error-${runId || Date.now()}`,
          );
          const messagesWithErrorSnapshot = errorSnapshot.length > 0
            ? [...currentMessages, ...errorSnapshot]
            : currentMessages;
          const suppressGlobalError = !terminalAssistantError
            && !replySessionInitConflict
            && shouldSuppressToolTerminalError(messagesWithErrorSnapshot, null, `error-${runId || Date.now()}`);

          set({
            ...(errorSnapshot.length > 0 ? { messages: messagesWithErrorSnapshot } : {}),
            runtimeRuns: runId
              ? applyRuntimeContractEvents(
                  get().runtimeRuns,
                  [{
                      runId,
                      sessionKey: sessionKeyAtError,
                      ts: Date.now(),
                      type: 'run.ended',
                      status: 'error',
                      error: normalizedErrorMsg,
                  } satisfies ChatRuntimeEvent],
                )
              : get().runtimeRuns,
            error: suppressGlobalError || terminalAssistantError || replySessionInitConflict ? null : normalizedErrorMsg,
            runError: suppressGlobalError
              ? null
              : terminalAssistantError || replySessionInitConflict
                ? normalizedErrorMsg
                : null,
            sending: false,
            pendingImageGenerationLocal: false,
            pendingVideoGenerationLocal: false,
            activeRunId: null,
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            pendingFinal: false,
            lastUserMessageAt: null,
            pendingToolImages: [],
          });

          clearHistoryPoll();
          clearErrorRecoveryTimer();
          markSessionRunIdle(sessionKeyAtError);
          clearPendingRuntimeIntent(sessionKeyAtError);
          if (wasSending) {
            markSessionNeedsTerminalHistoryRefresh(sessionKeyAtError);
            void get().loadHistory(true);
          }
        };

        if (recoverable) {
          scheduleRecoverableRuntimeError(() => {
            if (get().currentSessionKey !== sessionKeyAtError) return;
            if (runId && get().activeRunId && get().activeRunId !== runId) return;
            if (!get().sending && !get().error && !get().runError) return;
            commitRuntimeError();
          });
          break;
        }

        commitRuntimeError();
        break;
      }
      case 'aborted': {
        clearHistoryPoll();
        clearErrorRecoveryTimer();
        set({
          runtimeRuns: runId
            ? applyRuntimeContractEvents(
                get().runtimeRuns,
                [{
                    runId,
                    sessionKey: eventSessionKey ?? currentSessionKey,
                    ts: Date.now(),
                    type: 'run.ended',
                    status: 'aborted',
                } satisfies ChatRuntimeEvent],
              )
            : get().runtimeRuns,
          sending: false,
          pendingImageGenerationLocal: false,
          pendingVideoGenerationLocal: false,
          activeRunId: null,
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          pendingFinal: false,
          lastUserMessageAt: null,
          pendingToolImages: [],
        });
        const sessionKeyAtAbort = eventSessionKey ?? currentSessionKey;
        markSessionRunIdle(sessionKeyAtAbort);
        clearPendingRuntimeIntent(sessionKeyAtAbort);
        break;
      }
      default: {
        // Unknown or empty state  - if we're currently sending and receive an event
        // with a message, attempt to process it as streaming data. This handles
        // edge cases where the Gateway sends events without a state field.
        const { sending } = get();
        if (sending && event.message && typeof event.message === 'object') {
          console.warn(`[handleChatEvent] Unknown event state "${resolvedState}", treating message as streaming delta. Event keys:`, Object.keys(event));
          const updates = collectToolUpdates(event.message, 'delta');
          set((s) => ({
            streamingMessage: event.message ?? s.streamingMessage,
            streamingTools: updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools,
          }));
        }
        break;
      }
    }
  },

  handleRuntimeEvent: (event: ChatRuntimeEvent) => {
    const initialState = get();
    const { activeRunId, currentSessionKey } = initialState;
    const eventSessionKey = inferSessionKeyForRun(initialState, event.runId, event.sessionKey ?? null);
    const eventForSession: ChatRuntimeEvent = eventSessionKey && event.sessionKey !== eventSessionKey
      ? { ...event, sessionKey: eventSessionKey }
      : event;
    const matchesCurrentSession = eventSessionKey != null && eventSessionKey === currentSessionKey;
    const matchesActiveRun = activeRunId != null && event.runId === activeRunId;
    const isCompletionWake = completionWakeTaskIdFromRunId(eventForSession.runId) != null;
    const completionWakeOwnerRunId = resolveCompletionWakeOwnerRunId({
      runtimeRuns: initialState.runtimeRuns,
      activeRunId,
      eventRunId: eventForSession.runId,
      currentSessionKey,
      eventSessionKey,
    });
    const matchesActiveTurn = !isCompletionWake
      && runtimeEventBelongsToActiveTurn(initialState, eventForSession, eventSessionKey);

    if (shouldFilterRuntimeExecutionGraphEvent(eventForSession)) {
      if (matchesCurrentSession || matchesActiveRun || matchesActiveTurn) {
        _lastChatEventAt = Date.now();
      }
      return;
    }

    let runtimeRuns = applyRuntimeContractEvents(initialState.runtimeRuns, [eventForSession]);
    const asyncTaskEvidence = extractAsyncTaskEvidence(eventForSession);
    if (asyncTaskEvidence.length > 0) {
      runtimeRuns = applyAsyncTaskEvidenceToRuns(
        runtimeRuns,
        eventForSession.runId,
        asyncTaskEvidence,
        eventSessionKey ?? currentSessionKey,
      );
      scheduleWithheldFinalReevaluationForSession(eventSessionKey ?? currentSessionKey);
    }
    if (eventForSession.type === 'run.started') {
      runtimeRuns = applyRuntimeContractEvents(
        runtimeRuns,
        buildRuntimeStartEventsForRun(runtimeRuns, {
          runId: eventForSession.runId,
          sessionKey: eventSessionKey ?? currentSessionKey,
          objective: eventForSession.objective,
          ts: eventForSession.ts ?? eventForSession.startedAt ?? Date.now(),
          includeStarted: false,
        }),
      );
    }
    if (eventForSession.type === 'run.ended' && completionWakeOwnerRunId) {
      const terminalTaskEvent = buildCompletionWakeTerminalTaskEvent({
        runtimeRuns,
        ownerRunId: completionWakeOwnerRunId,
        eventRunId: eventForSession.runId,
        sessionKey: eventSessionKey ?? currentSessionKey,
        state: eventForSession.status === 'error'
          ? 'error'
          : eventForSession.status === 'aborted'
            ? 'aborted'
            : 'final',
        error: eventForSession.error,
        ts: eventForSession.ts ?? eventForSession.endedAt ?? Date.now(),
      });
      if (terminalTaskEvent) {
        runtimeRuns = applyRuntimeContractEvents(runtimeRuns, [terminalTaskEvent]);
      }
    }
    const nextPatch: Partial<ChatState> = { runtimeRuns };
    const appliesToActiveUi = completionWakeOwnerRunId != null
      || matchesActiveRun
      || matchesActiveTurn
      || (activeRunId == null && matchesCurrentSession && !isCompletionWake);
    let completedToolFiles: AttachedFileMeta[] = [];

    if (eventForSession.type === 'artifact.produced' || eventForSession.type === 'verification.completed') {
      scheduleWithheldFinalReevaluationForSession(eventSessionKey ?? currentSessionKey);
    }

    if (eventForSession.type === 'artifact.produced') {
      scheduleRuntimeArtifactVerification(
        eventForSession.runId,
        eventSessionKey ?? (appliesToActiveUi ? currentSessionKey : undefined),
        [eventForSession.artifact],
      );
    }

    if (eventForSession.type === 'tool.completed') {
      completedToolFiles = extractToolCompletedFiles(eventForSession);
      if (completedToolFiles.length > 0) {
        const artifactEvents = buildRuntimeArtifactEventsFromAttachedFiles({
          runId: eventForSession.runId,
          sessionKey: eventSessionKey ?? (appliesToActiveUi ? currentSessionKey : undefined),
          ts: eventForSession.ts ?? Date.now(),
          toolCallId: eventForSession.toolCallId,
          verificationDetail: '工具结果中的产物已进入 UClaw 产物跟踪。',
        }, completedToolFiles);
        runtimeRuns = applyRuntimeContractEvents(runtimeRuns, artifactEvents);
        nextPatch.runtimeRuns = runtimeRuns;
        scheduleRuntimeArtifactVerification(
          eventForSession.runId,
          eventSessionKey ?? (appliesToActiveUi ? currentSessionKey : undefined),
          artifactEvents
            .filter((runtimeEvent): runtimeEvent is Extract<ChatRuntimeEvent, { type: 'artifact.produced' }> =>
              runtimeEvent.type === 'artifact.produced')
            .map((runtimeEvent) => runtimeEvent.artifact),
        );
      }
    }

    if (eventForSession.type === 'run.ended') {
      const hasPendingAsyncTask = runtimeRunHasPendingAsyncTasks(runtimeRuns[eventForSession.runId]);
      if (hasPendingAsyncTask) {
        if (appliesToActiveUi) nextPatch.pendingFinal = true;
      } else {
        clearPendingRuntimeIntent(eventSessionKey);
      }
    }

    // Always retain structured runtime events, even for inactive sessions.
    // When the user switches away during a run and returns later, the Chat page
    // must be able to reconstruct the live execution graph from runtimeRuns
    // instead of relying only on the on-disk transcript snapshot.
    // Session-less runtime events are only safe to apply to active UI when they
    // match the active run; otherwise they are stored but do not affect the
    // current composer/graph state.
    if (!matchesCurrentSession && !matchesActiveRun) {
      updateCachedSessionRunStateFromRuntimeEvent(
        eventForSession,
        runtimeRuns,
        runtimeRunHasPendingAsyncTasks(runtimeRuns[eventForSession.runId]),
      );
      set(nextPatch);
      return;
    }

    _lastChatEventAt = Date.now();

    if (eventForSession.type === 'run.started') {
      if (isCompletionWake) {
        set(nextPatch);
        return;
      }
      const activeRunIsHistoricalPlaceholder = Boolean(activeRunId?.startsWith(`history:${currentSessionKey}:`));
      if (matchesCurrentSession && (activeRunId == null || matchesActiveRun || activeRunIsHistoricalPlaceholder)) {
        nextPatch.activeRunId = eventForSession.runId;
        nextPatch.error = null;
        nextPatch.runError = null;
        if (!initialState.sending && shouldTrackInboundRunLifecycle(initialState, currentSessionKey)) {
          nextPatch.sending = true;
        }
      }
      set(nextPatch);
      return;
    }

    if (eventForSession.type === 'assistant.delta' || eventForSession.type === 'thinking.delta') {
      if (appliesToActiveUi && (initialState.error || initialState.runError)) {
        nextPatch.error = null;
        nextPatch.runError = null;
      }
      if (appliesToActiveUi) {
        const runtimeStreamMessage = buildStreamingAssistantMessageFromRuntimeRun(
          runtimeRuns[eventForSession.runId],
          initialState.streamingMessage as RawMessage | null,
          { timestamp: eventForSession.ts },
        );
        if (runtimeStreamMessage) {
          nextPatch.streamingMessage = runtimeStreamMessage;
          nextPatch.streamingText = runtimeRuns[eventForSession.runId]?.assistantText ?? '';
        }
        if (!initialState.sending && matchesCurrentSession && shouldTrackInboundRunLifecycle(initialState, currentSessionKey)) {
          nextPatch.sending = true;
        }
      }
      set(nextPatch);
      return;
    }

    const toolStatus = runtimeToolEventToStatus(eventForSession);
    if (toolStatus && appliesToActiveUi && (initialState.error || initialState.runError)) {
      nextPatch.error = null;
      nextPatch.runError = null;
    }

    if (eventForSession.type === 'tool.completed' && appliesToActiveUi) {
      if (completedToolFiles.length > 0) {
        nextPatch.pendingToolImages = dedupeAttachedFiles([
          ...initialState.pendingToolImages,
          ...completedToolFiles,
        ]);
      }
    }

    if (eventForSession.type === 'run.ended') {
      const sessionKeyAtTerminal = eventSessionKey ?? currentSessionKey;
      if (matchesCurrentSession && eventForSession.producer !== CHAT_SYNTHETIC_TERMINAL_PRODUCER) {
        // Gateway terminal events can arrive before, or instead of, the final
        // assistant payload. Rehydrate the persisted transcript so normal
        // replies and completion-wake replies share the same delivery path.
        markSessionNeedsTerminalHistoryRefresh(sessionKeyAtTerminal);
        [0, 500, 1500, 4000].forEach((delayMs) => {
          setTimeout(() => {
            if (get().currentSessionKey !== sessionKeyAtTerminal) return;
            forceNextHistoryLoad(sessionKeyAtTerminal);
            void get().loadHistory(true);
          }, delayMs);
        });
      }
      if (isCompletionWake) {
        set(nextPatch);
        return;
      }
      const latestState = get();
      const terminalMatchesActiveRun = latestState.activeRunId != null && eventForSession.runId === latestState.activeRunId;
      const terminalIsForCurrentUntrackedSend = latestState.activeRunId == null
        && matchesCurrentSession
        && latestState.sending
        && !runtimeRunStartedBeforeActiveTurn(latestState, eventForSession.runId)
        && (
          typeof eventForSession.ts !== 'number'
          || latestState.lastUserMessageAt == null
          || eventForSession.ts >= latestState.lastUserMessageAt - 1_000
        );
      const terminalMatchesActiveTurn = !terminalMatchesActiveRun
        && !terminalIsForCurrentUntrackedSend
        && runtimeEventBelongsToActiveTurn(latestState, eventForSession, eventSessionKey);
      const shouldClearActiveRun = terminalMatchesActiveRun || terminalIsForCurrentUntrackedSend || terminalMatchesActiveTurn;

      if (shouldClearActiveRun) {
        const shouldHoldForContinuation = runtimeRunHasPendingAsyncTasks(runtimeRuns[eventForSession.runId]);
        const shouldAwaitFinalDelivery = eventForSession.status === 'completed' && !shouldHoldForContinuation;
        const shouldKeepLifecycle = shouldHoldForContinuation || shouldAwaitFinalDelivery;
        nextPatch.sending = shouldKeepLifecycle;
        nextPatch.activeRunId = shouldKeepLifecycle ? eventForSession.runId : null;
        nextPatch.pendingFinal = shouldKeepLifecycle;
        nextPatch.lastUserMessageAt = shouldKeepLifecycle ? latestState.lastUserMessageAt : null;
        nextPatch.streamingTools = shouldKeepLifecycle ? latestState.streamingTools : [];
        if (eventForSession.status === 'completed') {
          nextPatch.error = null;
          nextPatch.runError = null;
        }
        if (eventForSession.status === 'error' && eventForSession.error) {
          nextPatch.error = null;
          nextPatch.runError = shouldSuppressToolTerminalError(
            latestState.messages,
            latestState.streamingMessage as RawMessage | null,
            eventForSession.runId,
          )
            ? null
            : normalizeChatRunErrorMessage(eventForSession.error);
        }
        if (eventForSession.status === 'aborted') {
          nextPatch.streamingMessage = null;
          nextPatch.streamingText = '';
          nextPatch.pendingToolImages = [];
        }
        if (!shouldKeepLifecycle) {
          markSessionRunIdle(currentSessionKey);
          markSessionNeedsTerminalHistoryRefresh(currentSessionKey);
          clearPendingRuntimeIntent(currentSessionKey);
        } else if (matchesCurrentSession && eventForSession.producer !== CHAT_SYNTHETIC_TERMINAL_PRODUCER) {
          scheduleRuntimeBackendIdleReconciliation(
            set,
            get,
            currentSessionKey,
            latestState.activeRunId ?? eventForSession.runId,
          );
        }
      }
    }

    set(nextPatch);
  },

  // ── Refresh: reload history + sessions ──

  refresh: async () => {
    const { loadHistory, loadSessions } = get();
    await Promise.all([loadHistory(), loadSessions()]);
  },

  clearError: () => set({ error: null, runError: null }),
}));

useChatStore.subscribe((state, previousState) => {
  if (state.currentSessionKey !== previousState.currentSessionKey) {
    persistCurrentSessionKey(state.currentSessionKey);
  }
});

export function syncCachedSessionRunIdle(sessionKey: string): void {
  markSessionRunIdle(sessionKey);
}

export function hasActiveChatWork(state: Pick<
  ChatState,
  'sending' | 'activeRunId' | 'pendingFinal' | 'runtimeRuns'
>): boolean {
  return state.sending
    || state.activeRunId != null
    || state.pendingFinal
    || Object.values(state.runtimeRuns).some((run) => chatRunLooksRecentlyActive(run));
}
