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
import { conversationMessageSnapshot } from './conversation/chat-adapter';
import { projectRuntimeArtifactVerificationEvents } from './conversation/artifact-verification-adapter';
import { hostTasksToConversationEvents } from './conversation/host-task-adapter';
import { useConversationStore } from './conversation/store';
import { isActiveTurnStatus } from './conversation/types';
import {
  collectCancellableTasks,
  completionWakeTaskIdFromRunId,
  resolveCompletionWakeCorrelation,
  selectActiveTurn,
  selectLastRetryableUserTrigger,
  selectLatestUsableImage,
} from './conversation/control-selectors';
import {
  CHAT_SYNTHETIC_TERMINAL_PRODUCER,
  type ChatRuntimeArtifact,
  type ChatRuntimeEvent,
} from '../../shared/chat-runtime-events';
import type { VideoAttachmentMetadata } from '../../shared/video-attachment-metadata';
import type { GatewayStatus } from '../types/gateway';
import {
  CHAT_SEND_OUTBOX_SCHEMA_VERSION,
  type ChatSendOutboxItem,
  type ChatSendOutboxListResult,
} from '../../shared/chat-send-outbox';
import { clearBaselines } from './baseline-cache';
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
  type ChatQueuedTurnOwnership,
  type ChatSendAttachment,
  type ChatSendMode,
  type ChatSendReplayIntent,
  type ChatSession,
  type ChatState,
  type ChatVideoSendOptions,
  type ContentBlock,
  type GatewayTurnPreferences,
  type RawMessage,
  type ToolStatus,
} from './chat/types';
import {
  buildCompletionWakeTerminalTaskEvent,
  extractToolCompletedFiles,
  shouldFilterRuntimeExecutionGraphEvent,
} from './chat/runtime-graph';
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
  enrichWithToolCallAttachments,
  extractAsyncTaskEvidence,
  isInternalMessage as isHistoryInternalMessage,
  messageHasDeliverableContent,
  runtimeRunHasPendingAsyncTasks,
  shouldDropMessageFromHistory,
} from './chat/helpers';
import {
  cloneChatSendIntent,
  cloneChatSendReplayIntent,
  cloneGatewayTurnPreferences,
  createChatSendIntent,
  type ChatSendIntent,
} from './chat/send-intent';
import {
  buildGatewayTurnPreferences,
  isImageEditRequest,
  resolveChatImageOptions,
  resolveChatVideoOptions,
} from './chat/media-send-preferences';
import {
  applySessionBackendLabels,
  applySessionLabelSummaries,
  fetchSessionLabelSummaries,
  getSessionLabelHydrationActivityMs,
  persistSessionRenameOnce,
  refreshVisibleSessionSummaries,
  toSessionLabel,
} from './chat/session-label-controller';
import {
  captureBaselinesFromMessage,
  collectToolUpdates,
  getBaselineRunKeyForMessages,
  isRecoverableChatSendTimeout,
  isToolResultRole,
  upsertToolStatuses,
} from './chat/tool-status';
import {
  OPTIMISTIC_USER_TIMESTAMP_MATCH_MS,
  clearPendingOptimisticUserMessages,
  discardPendingOptimisticUserMessage,
  dropRedundantOptimisticUserMessages,
  getLatestOptimisticUserMessage,
  getMessageText,
  hasOptimisticServerEcho,
  mergePendingOptimisticUserMessages,
  normalizeStreamingMessage,
  rememberPendingOptimisticUserMessage,
  snapshotStreamingAssistantMessage,
} from './chat/optimistic-message-reconciliation';
import {
  attachedFileKey,
  cacheAttachedFiles,
  collectToolCallPaths,
  dedupeAttachedFiles,
  extractImagesAsAttachedFiles,
  extractMediaRefs,
  extractRawFilePaths,
  getAttachedFileNormalizedIdentityKeys,
  getToolCallFilePath,
  hasExplicitMediaDeliveryDirective,
  looksLikeRemoteMediaUrl,
  makeAttachedFile,
} from './chat/media-evidence';
import {
  DEFAULT_SESSION_RUN_STATE,
  alignRuntimeRunsWithBackendSessionTerminalState as alignRuntimeRunsWithBackendTerminal,
  backendSessionReportsActive,
  buildSessionSwitchPatch as buildSessionSwitchStatePatch,
  captureSessionRunState,
  clearCachedSessionRunState as clearSessionRunStateCache,
  gatewaySessionIsIdle,
  getAgentIdFromSessionKey,
  getCachedSessionRunState,
  getCanonicalPrefixFromSessionKey,
  getCanonicalPrefixFromSessions,
  mergeBackendSessionProbe as mergeBackendSessionProbeWithModel,
  mergeSessionRowWithLocalState as mergeSessionRowWithLocalModel,
  mergeSessionRunStatePatch,
  parseGatewayHistorySessionAuthority,
  parseGatewaySessionProbe,
  parseSessionStatus,
  parseSessionUpdatedAtMs,
  peekCachedSessionRunState,
  shouldTrustBackendSessionIdle,
  type GatewayHistorySessionAuthority,
  type SessionRunState,
  type SessionSwitchState,
} from './chat/session-controller';
import {
  LLM_IDLE_HINT_MS,
  NO_RESPONSE_SAFETY_TIMEOUT_MS,
  applyRuntimeContractEvents,
  buildNoResponseSafetyMessage,
  buildRuntimeStartEventsForRun,
  clearPendingRuntimeIntent,
  hasRecentRuntimeActivityForSend,
  inferSessionKeyForRun,
  isDuplicateChatEvent,
  isRecoverableRuntimeError,
  isReplySessionInitializationConflictError,
  normalizeChatRunErrorMessage,
  optionalToMs,
  rememberPendingRuntimeIntent,
  runtimeEventBelongsToActiveTurn,
  runtimeRunStartedBeforeActiveTurn,
  shouldTrackInboundRunLifecycle,
  toMs,
  updateCachedSessionRunStateFromRuntimeEvent,
} from './chat/runtime-control';
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

export { inferSessionKeyForRun };

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

type PendingImageInput = ChatSendAttachment;

/** Resolve reusable image evidence from the canonical session timeline. */
function findLatestCanonicalSessionImage(sessionKey: string): PendingImageInput | null {
  const image = selectLatestUsableImage(useConversationStore.getState(), sessionKey);
  if (!image) return null;
  return {
    fileName: image.fileName,
    mimeType: image.mimeType,
    fileSize: image.fileSize,
    stagedPath: image.filePath,
    preview: image.preview,
  };
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
      if (
        task.status !== 'completed'
        && task.status !== 'aborted'
        && task.status !== 'error'
        && task.status !== 'partial'
      ) continue;
      remember({
        id: `task:${task.taskId}`,
        taskId: task.taskId,
        childSessionKey: task.childSessionKey,
        status: task.status === 'completed'
          ? 'completed'
          : task.status === 'aborted'
            ? 'aborted'
            : 'error',
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

let _sendGenerationCounter = 0;
const _activeSendGenerationBySession = new Map<string, number>();

function activeSendGenerationMatches(sessionKey: string, sendGeneration: number): boolean {
  return _activeSendGenerationBySession.get(sessionKey) === sendGeneration;
}

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
  replayIntent?: ChatSendReplayIntent;
  ownership: ChatQueuedTurnOwnership;
  enqueuedAt: number;
};
const MAX_QUEUED_SENDS_PER_SESSION = 20;
const CHAT_SEND_OUTBOX_TTL_MS = 24 * 60 * 60 * 1_000;
const _queuedChatSendsBySession = new Map<string, QueuedChatSend[]>();
const _queuedChatSendFlushScheduled = new Set<string>();
const _queuedChatSendDispatchLeaseBySession = new Map<string, string>();
const _sessionsCancelling = new Set<string>();
const _sessionsAwaitingBackendIdle = new Set<string>();
const _sessionBackendIdleSettlementGeneration = new Map<string, number>();
const _runtimeBackendIdleProbeGeneration = new Map<string, number>();
const _lastSendIntentBySession = new Map<string, ChatSendIntent>();
let _chatSendOutboxRestoreInFlight: Promise<void> | null = null;
let _chatSendOutboxRestoreCompleted = false;

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
const HISTORY_PAGE_SIZE = 100;
const HISTORY_MAX_RENDERED_MESSAGES = 500;
const SESSION_SWITCH_RESTORE_MESSAGE_LIMIT = 24;
const PREVIEW_HYDRATION_MESSAGE_LIMIT = 80;
const SESSION_HISTORY_CACHE_MAX_SESSIONS = 16;
const SESSION_RUN_STATE_CACHE_MAX_SESSIONS = 32;
/** Grace period before surfacing mid-run Gateway errors that often self-recover. */
const ERROR_RECOVERY_DELAY_MS = 12_000;
const INTERNAL_TEMPORARY_SESSION_PATTERNS = [
  /^agent:main:uclaw-profile-[A-Za-z0-9_-]+/,
];

function isInternalTemporarySessionKey(sessionKey: string): boolean {
  return INTERNAL_TEMPORARY_SESSION_PATTERNS.some((pattern) => pattern.test(sessionKey));
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
  if (useChatStore.getState().currentSessionKey !== withheld.sessionKey) {
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

type ThumbnailVerificationResult = {
  preview: string | null;
  fileSize: number;
  filePath?: string;
  width?: number;
  height?: number;
};

type RuntimeArtifactVerificationContext = {
  runId: string;
  rootRunId?: string;
  sessionKey?: string;
  taskId?: string;
  parentTaskId?: string;
  toolCallId?: string;
};

type RuntimeArtifactVerificationEvent = Extract<ChatRuntimeEvent, {
  type: 'artifact.produced' | 'verification.completed';
}>;

/** Mirror local availability evidence into the existing canonical Turn only. */
function ingestCanonicalRuntimeArtifactVerificationEvents(
  events: RuntimeArtifactVerificationEvent[],
): void {
  const store = useConversationStore.getState();
  const projection = projectRuntimeArtifactVerificationEvents(store, events);
  if (projection.rejected.length > 0) {
    console.warn('[conversation-timeline] Rejected unowned artifact verification evidence', {
      rejected: projection.rejected.map((event) => ({
        type: event.type,
        runId: event.runId,
        rootRunId: event.rootRunId,
        sessionKey: event.sessionKey,
        taskId: event.taskId,
        toolCallId: event.toolCallId,
        artifactId: event.type === 'artifact.produced'
          ? event.artifact.id
          : event.verification.artifactId ?? event.verification.targetId,
      })),
    });
  }
  if (projection.events.length > 0) {
    store.ingestEvents(projection.events, { buffered: false });
  }
}

function scheduleRuntimeArtifactVerification(
  context: RuntimeArtifactVerificationContext,
  artifacts: ChatRuntimeArtifact[],
): void {
  const requests = artifacts
    .map((artifact) => {
      const filePath = artifact.filePath?.trim();
      const gatewayUrl = artifact.url?.startsWith('/api/chat/media/') ? artifact.url : undefined;
      if (!filePath && !gatewayUrl) return null;
      const identity = {
        ...context,
        taskId: artifact.taskId ?? context.taskId,
        toolCallId: artifact.sourceToolCallId ?? context.toolCallId,
      };
      const key = [
        identity.sessionKey ?? 'sessionless',
        identity.rootRunId ?? context.runId,
        context.runId,
        identity.taskId ?? 'taskless',
        artifact.id,
        filePath ?? gatewayUrl,
      ].join('|');
      if (_runtimeArtifactVerificationInFlight.has(key)) return null;
      _runtimeArtifactVerificationInFlight.add(key);
      return {
        key,
        artifact,
        identity,
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
      const events: RuntimeArtifactVerificationEvent[] = [];
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
              taskId: entry.artifact.taskId ?? entry.identity.taskId,
              sourceToolCallId: entry.artifact.sourceToolCallId ?? entry.identity.toolCallId,
            }
          : {
              ...entry.artifact,
              taskId: entry.artifact.taskId ?? entry.identity.taskId,
              sourceToolCallId: entry.artifact.sourceToolCallId ?? entry.identity.toolCallId,
            };
        // Re-emit the registered artifact on both outcomes so canonical
        // availability never depends on a legacy-only registration path.
        events.push({
          ...entry.identity,
          producer: 'uclaw-artifact-guard',
          ts,
          type: 'artifact.produced',
          artifact: verifiedArtifact,
        });
        events.push(buildRuntimeArtifactVerificationEvent({
          ...entry.identity,
          producer: 'uclaw-artifact-guard',
          ts,
        }, {
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
        ingestCanonicalRuntimeArtifactVerificationEvents(events);
        reevaluateWithheldFinalDelivery(context.runId);
      }
    })
    .catch((error) => {
      const ts = Date.now();
      const events = requests.flatMap((entry): RuntimeArtifactVerificationEvent[] => {
        const artifact = {
          ...entry.artifact,
          taskId: entry.artifact.taskId ?? entry.identity.taskId,
          sourceToolCallId: entry.artifact.sourceToolCallId ?? entry.identity.toolCallId,
        };
        const base = {
          ...entry.identity,
          producer: 'uclaw-artifact-guard',
          ts,
        };
        return [{
          ...base,
          type: 'artifact.produced',
          artifact,
        }, buildRuntimeArtifactVerificationEvent(base, {
          artifact,
          status: 'blocked',
          detail: '本地文件存在性验证请求失败。',
          evidence: error instanceof Error ? error.message : String(error),
        })];
      });
      useChatStore.setState((state) => ({
        runtimeRuns: applyRuntimeContractEvents(state.runtimeRuns, events),
      }));
      ingestCanonicalRuntimeArtifactVerificationEvents(events);
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
          const latestSessions = mergeBackendSessionProbeWithModel(
            get().sessions,
            backendSession,
            normalizeChatManagedModelRef,
          );
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
          const sessions = mergeBackendSessionProbeWithModel(
            useChatStore.getState().sessions,
            backendSession,
            normalizeChatManagedModelRef,
          );
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
      : peekCachedSessionRunState(sessionKey);
    if (
      expectedRunId
      && settledRunState?.activeRunId != null
      && settledRunState.activeRunId !== expectedRunId
    ) {
      return;
    }
    if (state.currentSessionKey !== sessionKey) {
      // Settle the canonical Turn before a session switch can restore stale busy UI.
      syncCanonicalSessionActivity(sessionKey, false);
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
  })();
}

function sessionExecutionIsBusy(
  state: ChatState,
  sessionKey: string,
  ignoredTurnIds: ReadonlySet<string> = new Set(),
): boolean {
  if (_sessionsCancelling.has(sessionKey) || _sessionsAwaitingBackendIdle.has(sessionKey)) return true;
  const dispatchLeaseTurnId = _queuedChatSendDispatchLeaseBySession.get(sessionKey);
  if (dispatchLeaseTurnId && !ignoredTurnIds.has(dispatchLeaseTurnId)) return true;
  const conversation = useConversationStore.getState();
  const activeTurn = selectActiveTurn(conversation, sessionKey);
  if (activeTurn && !ignoredTurnIds.has(activeTurn.id)) return true;
  return backendSessionReportsActive(state.sessions.find((session) => session.key === sessionKey));
}

function cloneQueuedAttachments(attachments: ChatSendAttachment[] | undefined): ChatSendAttachment[] | undefined {
  return attachments?.map((attachment) => ({ ...attachment }));
}

function cloneQueuedTurnOwnership(
  ownership: ChatQueuedTurnOwnership,
  dequeuedFromQueue = false,
): ChatQueuedTurnOwnership {
  return {
    ...ownership,
    userMessage: {
      ...ownership.userMessage,
      _attachedFiles: ownership.userMessage._attachedFiles?.map((file) => ({ ...file })),
    },
    ...(dequeuedFromQueue ? { dequeuedFromQueue: true } : { dequeuedFromQueue: undefined }),
  };
}

/** Create the stable canonical ownership that follows one accepted local send through the queue. */
function beginChatSendTurn(
  sessionKey: string,
  text: string,
  attachments: ChatSendAttachment[] | undefined,
  mode: ChatSendMode,
  activate: boolean,
): ChatQueuedTurnOwnership {
  const acceptedAt = Date.now();
  const idempotencyKey = crypto.randomUUID();
  const userMessage: RawMessage = {
    role: 'user',
    content: text || (attachments?.length ? '(file attached)' : ''),
    timestamp: acceptedAt / 1000,
    id: crypto.randomUUID(),
    idempotencyKey,
    _attachedFiles: attachments?.map((attachment) => ({
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
      preview: attachment.preview,
      filePath: attachment.stagedPath,
      source: 'user-upload',
      disposition: 'input-reference',
    })),
  };
  const turnId = useConversationStore.getState().beginLocalTurn({
    sessionKey,
    message: conversationMessageSnapshot(userMessage),
    mode,
    activate,
  });
  return { sessionKey, turnId, userMessage, idempotencyKey, acceptedAt };
}

/** Reserve a deferred queued Turn as the sole pending local owner before dispatch. */
function activateQueuedChatSendTurn(
  ownership: ChatQueuedTurnOwnership,
  mode: ChatSendMode,
): void {
  const turnId = useConversationStore.getState().beginLocalTurn({
    sessionKey: ownership.sessionKey,
    message: conversationMessageSnapshot(ownership.userMessage),
    mode,
    activate: true,
  });
  if (turnId !== ownership.turnId) {
    console.error('[chat.queue] queued Turn identity changed during activation', {
      sessionKey: ownership.sessionKey,
      queuedTurnId: ownership.turnId,
      activatedTurnId: turnId,
    });
  }
}

function failQueuedChatSendTurn(ownership: ChatQueuedTurnOwnership, errorMessage: string): void {
  useConversationStore.getState().ingestChatEvent({
    state: 'error',
    sessionKey: ownership.sessionKey,
    errorMessage,
  }, {
    sessionKey: ownership.sessionKey,
    turnId: ownership.turnId,
  });
}

function locallyQueuedTurnIds(sessionKey: string, additionalTurnId?: string): Set<string> {
  const turnIds = new Set(
    (_queuedChatSendsBySession.get(sessionKey) ?? []).map((item) => item.ownership.turnId),
  );
  if (additionalTurnId) turnIds.add(additionalTurnId);
  return turnIds;
}

function outboxAttachment(attachment: ChatSendAttachment) {
  return {
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    fileSize: attachment.fileSize,
    stagedPath: attachment.stagedPath,
  };
}

function queuedChatSendToOutboxItem(item: QueuedChatSend): ChatSendOutboxItem {
  const replayIntent = item.replayIntent;
  return {
    version: CHAT_SEND_OUTBOX_SCHEMA_VERSION,
    id: item.ownership.idempotencyKey,
    sessionKey: item.ownership.sessionKey,
    turnId: item.ownership.turnId,
    idempotencyKey: item.ownership.idempotencyKey,
    userMessageId: item.ownership.userMessage.id ?? item.ownership.idempotencyKey,
    acceptedAt: item.ownership.acceptedAt,
    expiresAt: item.ownership.acceptedAt + CHAT_SEND_OUTBOX_TTL_MS,
    text: item.text,
    targetAgentId: item.targetAgentId ?? undefined,
    mode: item.mode,
    imageOptions: replayIntent?.imageOptions ?? item.imageOptions,
    videoOptions: replayIntent?.videoOptions ?? item.videoOptions,
    thinkingLevel: replayIntent?.thinkingLevel ?? undefined,
    attachments: (item.attachments ?? []).map(outboxAttachment),
    referenceImages: (replayIntent?.referenceImages ?? []).map(outboxAttachment),
  };
}

async function persistQueuedChatSend(item: QueuedChatSend): Promise<void> {
  const result = await hostApiFetch<{ success?: boolean; durable?: boolean; error?: string }>(
    '/api/chat/outbox',
    {
      method: 'POST',
      body: JSON.stringify({ item: queuedChatSendToOutboxItem(item) }),
    },
  );
  if (result.success === false) throw new Error(result.error || 'Failed to persist queued send');
  if (result.durable === false) {
    console.warn('[chat.queue] safe storage unavailable; queued send is memory-only', {
      sessionKey: item.ownership.sessionKey,
      turnId: item.ownership.turnId,
    });
  }
}

async function acknowledgeQueuedChatSend(ownership: ChatQueuedTurnOwnership | undefined): Promise<void> {
  if (!ownership?.dequeuedFromQueue) return;
  await hostApiFetch(`/api/chat/outbox/${encodeURIComponent(ownership.idempotencyKey)}/ack`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

async function cancelSessionQueuedChatSends(sessionKey: string): Promise<void> {
  await hostApiFetch('/api/chat/outbox/session/cancel', {
    method: 'POST',
    body: JSON.stringify({ sessionKey }),
  });
}

async function enqueueChatSendForSession(
  sessionKey: string,
  item: Omit<QueuedChatSend, 'enqueuedAt'>,
  options: { front?: boolean } = {},
): Promise<boolean> {
  const initialQueueLength = _queuedChatSendsBySession.get(sessionKey)?.length ?? 0;
  if (initialQueueLength >= MAX_QUEUED_SENDS_PER_SESSION) {
    console.warn('[chat.queue] queue limit reached; preserving existing queued turns', {
      sessionKey,
      queueLength: initialQueueLength,
    });
    if (useChatStore.getState().currentSessionKey === sessionKey) {
      useChatStore.setState({ error: i18n.t('chat:chatInput.queueLimitReached', { count: initialQueueLength }) });
    }
    return false;
  }
  const queuedItem: QueuedChatSend = {
    ...item,
    attachments: cloneQueuedAttachments(item.attachments),
    imageOptions: item.imageOptions ? { ...item.imageOptions } : undefined,
    videoOptions: item.videoOptions ? { ...item.videoOptions } : undefined,
    replayIntent: item.replayIntent ? cloneChatSendReplayIntent(item.replayIntent) : undefined,
    ownership: cloneQueuedTurnOwnership(item.ownership),
    enqueuedAt: Date.now(),
  };
  try {
    // Main owns durable acceptance; renderer memory remains the active dispatch cache.
    await persistQueuedChatSend(queuedItem);
  } catch (error) {
    console.warn('[chat.queue] durable enqueue failed; preserving the in-process intent', {
      sessionKey,
      turnId: queuedItem.ownership.turnId,
      error: String(error),
    });
  }
  // Concurrent durable writes can settle out of order. Re-read the live queue
  // after persistence, then restore acceptance order by the stable timestamp.
  const queue = _queuedChatSendsBySession.get(sessionKey) ?? [];
  if (queue.length >= MAX_QUEUED_SENDS_PER_SESSION) {
    void hostApiFetch(`/api/chat/outbox/${encodeURIComponent(queuedItem.ownership.idempotencyKey)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'renderer-session-cap' }),
    }).catch(() => undefined);
    return false;
  }
  if (options.front) queue.unshift(queuedItem);
  else {
    queue.push(queuedItem);
    queue.sort((left, right) => left.ownership.acceptedAt - right.ownership.acceptedAt);
  }
  _queuedChatSendsBySession.set(sessionKey, queue);
  return true;
}

function hasQueuedChatSends(sessionKey: string): boolean {
  return (_queuedChatSendsBySession.get(sessionKey)?.length ?? 0) > 0;
}

function clearQueuedChatSends(sessionKey: string): void {
  _queuedChatSendsBySession.delete(sessionKey);
  _queuedChatSendFlushScheduled.delete(sessionKey);
  _queuedChatSendDispatchLeaseBySession.delete(sessionKey);
}

function releaseQueuedChatSendDispatchLease(ownership: ChatQueuedTurnOwnership | undefined): void {
  if (!ownership?.dequeuedFromQueue) return;
  if (_queuedChatSendDispatchLeaseBySession.get(ownership.sessionKey) === ownership.turnId) {
    _queuedChatSendDispatchLeaseBySession.delete(ownership.sessionKey);
  }
}

function currentSessionCanFlushQueuedSend(sessionKey: string): boolean {
  const state = useChatStore.getState();
  return state.currentSessionKey === sessionKey
    && !sessionExecutionIsBusy(state, sessionKey, locallyQueuedTurnIds(sessionKey));
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
    _queuedChatSendDispatchLeaseBySession.set(sessionKey, next.ownership.turnId);
    void useChatStore.getState().sendMessage(
      next.text,
      cloneQueuedAttachments(next.attachments),
      next.targetAgentId,
      next.mode,
      next.imageOptions ? { ...next.imageOptions } : undefined,
      next.videoOptions ? { ...next.videoOptions } : undefined,
      next.replayIntent ? cloneChatSendReplayIntent(next.replayIntent) : undefined,
      cloneQueuedTurnOwnership(next.ownership, true),
    );
  });
}

function outboxItemToQueuedChatSend(item: ChatSendOutboxItem): QueuedChatSend {
  const attachments = item.attachments.map((attachment): ChatSendAttachment => ({
    ...attachment,
    preview: null,
  }));
  const referenceImages = item.referenceImages.map((attachment): ChatSendAttachment => ({
    ...attachment,
    preview: null,
  }));
  const selectedArtifacts = [...attachments, ...referenceImages]
    .filter((attachment) => attachment.mimeType.startsWith('image/'));
  const replayIntent: ChatSendReplayIntent = {
    imageOptions: item.imageOptions ? { ...item.imageOptions } : undefined,
    videoOptions: item.videoOptions ? { ...item.videoOptions } : undefined,
    thinkingLevel: item.thinkingLevel,
    referenceImages,
    clientPreferences: buildGatewayTurnPreferences({
      mode: item.mode,
      prompt: item.text.trim(),
      hasSourceImage: selectedArtifacts.length > 0,
      imageOptions: item.imageOptions,
      videoOptions: item.videoOptions,
      selectedArtifacts,
    }),
  };
  const userMessage: RawMessage = {
    role: 'user',
    id: item.userMessageId,
    idempotencyKey: item.idempotencyKey,
    timestamp: item.acceptedAt / 1_000,
    content: item.text || (attachments.length > 0 ? '(file attached)' : ''),
    _attachedFiles: attachments.map((attachment) => ({
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
      preview: null,
      filePath: attachment.stagedPath,
      source: 'user-upload',
      disposition: 'input-reference',
    })),
  };
  return {
    text: item.text,
    attachments,
    targetAgentId: item.targetAgentId ?? null,
    mode: item.mode,
    imageOptions: item.imageOptions ? { ...item.imageOptions } : undefined,
    videoOptions: item.videoOptions ? { ...item.videoOptions } : undefined,
    replayIntent,
    ownership: {
      sessionKey: item.sessionKey,
      turnId: item.turnId,
      userMessage,
      idempotencyKey: item.idempotencyKey,
      acceptedAt: item.acceptedAt,
    },
    enqueuedAt: item.acceptedAt,
  };
}

function transcriptContainsOutboxIntent(messages: RawMessage[], item: ChatSendOutboxItem): boolean {
  return messages.some((message) => (
    message.role === 'user'
    && (
      message.idempotencyKey === item.idempotencyKey
      || message.id === item.idempotencyKey
    )
  ));
}

function restoreQueuedChatSendToMemory(item: ChatSendOutboxItem): void {
  const queue = _queuedChatSendsBySession.get(item.sessionKey) ?? [];
  if (queue.some((candidate) => candidate.ownership.idempotencyKey === item.idempotencyKey)) return;
  if (queue.length >= MAX_QUEUED_SENDS_PER_SESSION) return;
  const queuedItem = outboxItemToQueuedChatSend(item);
  const restoredTurnId = useConversationStore.getState().beginLocalTurn({
    sessionKey: item.sessionKey,
    message: conversationMessageSnapshot(queuedItem.ownership.userMessage),
    mode: item.mode,
    activate: false,
  });
  if (restoredTurnId !== item.turnId) {
    console.error('[chat.queue] restored outbox Turn identity changed', {
      sessionKey: item.sessionKey,
      persistedTurnId: item.turnId,
      restoredTurnId,
    });
  }
  queue.push(queuedItem);
  queue.sort((left, right) => left.enqueuedAt - right.enqueuedAt);
  _queuedChatSendsBySession.set(item.sessionKey, queue);
}

function rejectRestoredChatSend(item: ChatSendOutboxItem, errorMessage: string): void {
  const queuedItem = outboxItemToQueuedChatSend(item);
  useConversationStore.getState().beginLocalTurn({
    sessionKey: item.sessionKey,
    message: conversationMessageSnapshot(queuedItem.ownership.userMessage),
    mode: item.mode,
    activate: false,
  });
  failQueuedChatSendTurn(queuedItem.ownership, errorMessage);
}

/** Reconcile encrypted Main outbox records with local transcripts before retry. */
async function restoreChatSendOutbox(): Promise<void> {
  if (_chatSendOutboxRestoreCompleted) return;
  if (_chatSendOutboxRestoreInFlight) return _chatSendOutboxRestoreInFlight;
  _chatSendOutboxRestoreInFlight = (async () => {
    const response = await hostApiFetch<Partial<ChatSendOutboxListResult> & { success?: boolean; error?: string }>(
      '/api/chat/outbox',
    );
    if (response.success === false) throw new Error(response.error || 'Failed to restore queued sends');
    const items = Array.isArray(response.items) ? response.items : [];
    const rejected = Array.isArray(response.rejected) ? response.rejected : [];
    rejected.forEach((item) => rejectRestoredChatSend(item, item.error));

    const transcriptBySession = new Map<string, RawMessage[]>();
    await Promise.all([...new Set(items.map((item) => item.sessionKey))].map(async (sessionKey) => {
      transcriptBySession.set(sessionKey, await loadSessionTranscriptFallback(sessionKey, 200));
    }));
    for (const item of items) {
      const transcript = transcriptBySession.get(item.sessionKey) ?? [];
      if (transcriptContainsOutboxIntent(transcript, item)) {
        await hostApiFetch(`/api/chat/outbox/${encodeURIComponent(item.id)}/ack`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'transcript-reconciled' }),
        });
        continue;
      }
      restoreQueuedChatSendToMemory(item);
    }
    _chatSendOutboxRestoreCompleted = true;
    scheduleQueuedChatSendFlush(useChatStore.getState().currentSessionKey);
  })();
  try {
    await _chatSendOutboxRestoreInFlight;
  } finally {
    _chatSendOutboxRestoreInFlight = null;
  }
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

function clearCachedSessionRunState(sessionKey: string): void {
  clearSessionRunStateCache(sessionKey);
  _sessionsNeedingTerminalHistoryRefresh.delete(sessionKey);
}

function getHistoryForegroundLoadKey(sessionKey: string): string {
  const gatewayState = useGatewayStore.getState?.() as { status?: { pid?: number; connectedAt?: number; port?: number } } | undefined;
  const gatewayStatus = gatewayState?.status;
  const gatewayRuntimeKey = `${gatewayStatus?.pid ?? 'none'}:${gatewayStatus?.connectedAt ?? 'none'}:${gatewayStatus?.port ?? 'none'}`;
  return `${gatewayRuntimeKey}|${sessionKey}`;
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
  const cacheEntries: Array<[string, AttachedFileMeta]> = [];
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
          cacheEntries.push([file.filePath, { ...file }]);
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
          cacheEntries.push([ref.filePath, { ...file }]);
          updated = true;
        }
      }
    }
  }

  if (updated) cacheAttachedFiles(cacheEntries);
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

function reconcileCurrentSessionIdleFromBackend(
  set: (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
  sessions: ChatSession[],
): void {
  const state = get();
  if (!state.sending && state.activeRunId == null && !state.pendingFinal) return;
  // A renderer-owned send remains authoritative for the current live slot
  // until terminal evidence or explicit settlement clears its generation.
  // A sessions.list snapshot from the preceding run must not close it.
  if (_activeSendGenerationBySession.has(state.currentSessionKey)) return;
  const current = sessions.find((session) => session.key === state.currentSessionKey);
  if (!shouldTrustBackendSessionIdle(current, state.lastUserMessageAt)) return;

  const runtimeRuns = alignRuntimeRunsWithBackendTerminal(
    state.runtimeRuns,
    state.currentSessionKey,
    current,
    state.activeRunId,
    applyRuntimeContractEvents,
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

/** Mirrors authoritative OpenClaw session liveness into the canonical Turn once per real transition. */
function syncCanonicalSessionActivity(
  sessionKey: string,
  active: boolean,
  runId?: string,
): void {
  const conversation = useConversationStore.getState();
  const activeTurnId = conversation.aliases.activeBySession[sessionKey]
    ?? conversation.aliases.pendingLocalBySession[sessionKey];
  const sessionTurnIds = conversation.turnOrderBySession[sessionKey] ?? [];
  const latestTurnId = sessionTurnIds[sessionTurnIds.length - 1];
  const turn = conversation.turnsById[activeTurnId ?? latestTurnId];
  if (!turn) return;

  // A visible local outbox Turn has not claimed the interactive run slot yet.
  // Session-wide idle from the preceding run must release the queue without
  // completing this next Turn before it is dispatched.
  const deferredQueuedTurn = turn.status === 'queued'
    && turn.runAliases.length === 0;
  if (!active && deferredQueuedTurn) return;
  if (!active && _activeSendGenerationBySession.has(sessionKey)) return;

  if (active) {
    if (isActiveTurnStatus(turn.status) && !turn.evidence.backendIdle) return;
    // Only history-checkpoint completion is intentionally correctable by later
    // backend-active evidence. Native terminal evidence remains monotonic.
    const canReopenHistoryTurn = turn.status === 'completed'
      && turn.evidence.historyCheckpointed
      && !turn.hasLiveEvidence
      && turn.evidence.runTerminal == null;
    if (!canReopenHistoryTurn) return;
    conversation.markSessionActivity(sessionKey, true, runId);
    return;
  }

  if (!isActiveTurnStatus(turn.status) || turn.evidence.backendIdle) return;
  // Idle is session-scoped so an unavailable or stale run id cannot quarantine
  // authoritative backend settlement.
  conversation.markSessionActivity(sessionKey, false);
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
    syncCanonicalSessionActivity(state.currentSessionKey, true);
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

  if (shouldTrustBackendSessionIdle(current, state.lastUserMessageAt)) {
    syncCanonicalSessionActivity(state.currentSessionKey, false);
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

function buildSessionSwitchPatch(
  state: SessionSwitchState,
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

  const result = buildSessionSwitchStatePatch({
    state,
    nextSessionKey,
    cachedNextSession: getCachedSessionHistory(nextSessionKey),
    cachedRunState: getCachedSessionRunState(nextSessionKey),
    restoreMessageLimit: SESSION_SWITCH_RESTORE_MESSAGE_LIMIT,
    historyPageSize: HISTORY_PAGE_SIZE,
  });
  if (result.leavingEmpty) _pendingLocalSessionKeys.delete(state.currentSessionKey);
  return result.patch;
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

/** True for internal plumbing messages that should never be shown in the UI. */
function isInternalMessage(msg: { role?: unknown; content?: unknown; idempotencyKey?: unknown; model?: unknown; text?: unknown }): boolean {
  return isHistoryInternalMessage(msg);
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

function hashStringForLocalMessageId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
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
  historyError: null,

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

  reconcileGatewayRecovery: async () => {
    // The previous Gateway process can no longer own this local send. Backend
    // liveness from the new process generation decides whether it remains open.
    clearActiveSendGeneration(get().currentSessionKey);
    await get().loadSessions(true);
    forceNextHistoryLoad(get().currentSessionKey);
    await get().loadHistory(true);
  },

  loadSessions: async (force = false) => {
    const now = Date.now();
    if (_loadSessionsInFlight) {
      await _loadSessionsInFlight;
      if (!force) return;
    }
    if (!force && now - _lastLoadSessionsAt < SESSION_LOAD_MIN_INTERVAL_MS) {
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
            return mergeSessionRowWithLocalModel(
              nextSession,
              localSessionByKey.get(nextSession.key),
              normalizeChatManagedModelRef,
            );
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
        await restoreChatSendOutbox();
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
    forceNextHistoryLoad(key);
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
    _lastSendIntentBySession.delete(key);
    clearSessionLabelHydrationTracking(key);
    clearPendingOptimisticUserMessages(key);
    useConversationStore.getState().removeSession(key);
    try {
      await cancelSessionQueuedChatSends(key);
    } catch (error) {
      console.warn('[deleteSession] Failed to clear durable queued sends:', {
        sessionKey: key,
        error: String(error),
      });
    }
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
        historyError: null,
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
            historyError: errorMessage,
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
      const canonicalHistoryMessages = enrichWithCachedImages(messagesWithToolAttachments);
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
      const hostTaskRehydrationOptions = {
        existingRunIds: Object.keys(nextRuntimeRuns),
      };
      nextRuntimeRuns = applyRuntimeContractEvents(
        nextRuntimeRuns,
        buildHostTaskRehydrationEvents(hostTasks, hostTaskRehydrationOptions),
      );
      const hostTaskConversationEvents = hostTasksToConversationEvents(hostTasks, hostTaskRehydrationOptions);
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
        nextRuntimeRuns = alignRuntimeRunsWithBackendTerminal(
          nextRuntimeRuns,
          currentSessionKey,
          currentSessionRow,
          get().activeRunId,
          applyRuntimeContractEvents,
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
        historyError: null,
        runError: historyErrorIsTransient || terminalArtifactFallbackMessage
          ? null
          : normalizedTerminalAssistantErrorMessage,
        runtimeRuns: nextRuntimeRuns,
      });
      try {
        useConversationStore.getState().replaceHistory(
          currentSessionKey,
          canonicalHistoryMessages,
          {
            reason: forcedByTerminalRefresh ? 'terminal-refresh' : 'initial-load',
            additionalEvents: hostTaskConversationEvents,
          },
        );
        if (backendSessionActive) {
          syncCanonicalSessionActivity(currentSessionKey, true, authoritativeActiveRunId);
        } else if (backendSessionCanClose) {
          syncCanonicalSessionActivity(currentSessionKey, false);
        }
      } catch (error) {
        console.warn('[conversation-timeline] Failed to replay chat history:', error);
        if (isCurrentSession()) set({ historyError: String(error) });
      }
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
          scheduleRuntimeArtifactVerification({
            runId: run.runId,
            sessionKey: currentSessionKey,
          }, artifacts);
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
                  ? alignRuntimeRunsWithBackendTerminal(
                      nextRuntimeRuns,
                      currentSessionKey,
                      currentSessionRow,
                      state.activeRunId,
                      applyRuntimeContractEvents,
                    )
                  : nextRuntimeRuns;
              })();
              return {
                messages,
                runtimeRuns,
              };
            })(),
          }));
          // Preview hydration mutates attachment evidence after the first replay;
          // refresh the canonical projection so media availability matches history.
          try {
            useConversationStore.getState().replaceHistory(
              currentSessionKey,
              mergeHydratedMessages(canonicalHistoryMessages, previewHydrationMessages),
              {
                reason: forcedByTerminalRefresh ? 'terminal-refresh' : 'initial-load',
                additionalEvents: hostTaskConversationEvents,
              },
            );
          } catch (error) {
            console.warn('[conversation-timeline] Failed to replay hydrated chat history:', error);
            if (isCurrentSession()) set({ historyError: String(error) });
          }
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

    set({ loadingMoreHistory: true, error: null, historyError: null });
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
      const canonicalHistoryMessages = enrichWithCachedImages(messagesWithToolAttachments);
      const runtimeHistoryMessages = buildRuntimeReplayMessages(messagesWithToolAttachments);
      set((state) => ({
        messages: enrichedMessages,
        loadingMoreHistory: false,
        hasMoreHistory: rawMessages.length >= nextLimit && nextLimit < HISTORY_MAX_RENDERED_MESSAGES,
        runtimeRuns: applyHistoricalRuntimeRunsFromMessages(state.runtimeRuns, currentSessionKey, runtimeHistoryMessages),
      }));
      try {
        useConversationStore.getState().replaceHistory(
          currentSessionKey,
          canonicalHistoryMessages,
          { reason: 'manual-refresh', prependMissingTurns: true },
        );
      } catch (error) {
        console.warn('[conversation-timeline] Failed to replay paged chat history:', error);
        if (get().currentSessionKey === currentSessionKey) set({ historyError: String(error) });
      }
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
        try {
          const hydratedCanonicalMessages = canonicalHistoryMessages.map((message) => {
            const match = previewHydrationMessages.find((candidate) => (
              `${candidate.id ?? ''}|${candidate.role}|${candidate.timestamp ?? ''}|${getMessageText(candidate.content)}`
              === `${message.id ?? ''}|${message.role}|${message.timestamp ?? ''}|${getMessageText(message.content)}`
            ));
            return match?._attachedFiles?.length
              ? { ...message, _attachedFiles: match._attachedFiles.map((file) => ({ ...file })) }
              : message;
          });
          useConversationStore.getState().replaceHistory(
            currentSessionKey,
            hydratedCanonicalMessages,
            { reason: 'manual-refresh', prependMissingTurns: true },
          );
        } catch (error) {
          console.warn('[conversation-timeline] Failed to replay hydrated paged history:', error);
          if (get().currentSessionKey === currentSessionKey) set({ historyError: String(error) });
        }
      });
    } catch (error) {
      console.warn('Failed to load more history:', error);
      set({ loadingMoreHistory: false, error: String(error), historyError: String(error) });
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
    replayIntent?: ChatSendReplayIntent,
    queuedOwnership?: ChatQueuedTurnOwnership,
  ) => {
    const trimmed = text.trim();
    if (!trimmed && (!attachments || attachments.length === 0)) return;

    const targetSessionKey = resolveMainSessionKeyForAgent(targetAgentId)
      ?? get().currentSessionKey;
    if (!attachments?.length && isInternalMessage({ role: 'user', content: trimmed })) {
      console.info('[sendMessage] Dropping internal user message before gateway send', {
        sessionKey: targetSessionKey,
        textChars: Array.from(trimmed).length,
      });
      return;
    }

    let ownership = queuedOwnership
      ? cloneQueuedTurnOwnership(queuedOwnership, queuedOwnership.dequeuedFromQueue === true)
      : undefined;
    if (ownership && ownership.sessionKey !== targetSessionKey) {
      const errorMessage = 'Queued chat ownership no longer matches its target session.';
      failQueuedChatSendTurn(ownership, errorMessage);
      releaseQueuedChatSendDispatchLease(ownership);
      set({ error: errorMessage });
      return;
    }
    const enqueueForBusySession = async () => {
      const acceptedOwnership = ownership ?? beginChatSendTurn(
        targetSessionKey,
        trimmed,
        attachments,
        mode,
        false,
      );
      ownership = acceptedOwnership;
      const queuedReferenceImages = (attachments ?? []).filter((attachment) => attachment.mimeType.startsWith('image/'));
      const hasQueuedSourceImage = queuedReferenceImages.length > 0;
      const queuedImageOptions = replayIntent?.imageOptions
        ?? (mode === 'image' ? resolveChatImageOptions(trimmed, imageOptions) : undefined);
      const queuedVideoOptions = replayIntent?.videoOptions
        ?? (mode === 'video' ? resolveChatVideoOptions(trimmed, hasQueuedSourceImage, videoOptions) : undefined);
      const durableReplayIntent = replayIntent ?? {
        imageOptions: queuedImageOptions,
        videoOptions: queuedVideoOptions,
        thinkingLevel: get().thinkingLevel,
        referenceImages: [],
        clientPreferences: buildGatewayTurnPreferences({
          mode,
          prompt: trimmed,
          hasSourceImage: hasQueuedSourceImage,
          imageOptions: queuedImageOptions,
          videoOptions: queuedVideoOptions,
          selectedArtifacts: queuedReferenceImages,
        }),
      };
      const enqueued = await enqueueChatSendForSession(targetSessionKey, {
        text,
        attachments,
        targetAgentId,
        mode,
        imageOptions,
        videoOptions,
        replayIntent: durableReplayIntent,
        ownership: acceptedOwnership,
      }, { front: acceptedOwnership.dequeuedFromQueue === true });
      if (!enqueued) {
        failQueuedChatSendTurn(
          acceptedOwnership,
          i18n.t('chat:chatInput.queueLimitReached', { count: MAX_QUEUED_SENDS_PER_SESSION }),
        );
        releaseQueuedChatSendDispatchLease(acceptedOwnership);
        return;
      }
      releaseQueuedChatSendDispatchLease(acceptedOwnership);
      scheduleQueuedChatSendFlush(targetSessionKey);
    };

    const pendingCwdMutation = _sessionCwdMutations.get(targetSessionKey);
    if (pendingCwdMutation) {
      try {
        await pendingCwdMutation;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (ownership) failQueuedChatSendTurn(ownership, errorMessage);
        releaseQueuedChatSendDispatchLease(ownership);
        set({ error: errorMessage });
        return;
      }
    }

    // Same-session sends must stay ordered. The renderer owns a single active
    // run slot, so queue follow-up turns instead of dropping them or racing the
    // current run state.
    if (
      (!ownership && hasQueuedChatSends(targetSessionKey))
      || sessionExecutionIsBusy(
        get(),
        targetSessionKey,
        locallyQueuedTurnIds(targetSessionKey, ownership?.turnId),
      )
    ) {
      await enqueueForBusySession();
      return;
    }

    const managedAuthReady = ensureManagedAuthReadyForSend();
    if (managedAuthReady) {
      try {
        await managedAuthReady;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (ownership) failQueuedChatSendTurn(ownership, errorMessage);
        releaseQueuedChatSendDispatchLease(ownership);
        set({
          error: errorMessage,
          sending: false,
        });
        return;
      }
    }

    // Auth/provider checks are asynchronous. Re-check the target session so a
    // run that started while they were pending cannot absorb this turn.
    if (
      (!ownership && hasQueuedChatSends(targetSessionKey))
      || sessionExecutionIsBusy(
        get(),
        targetSessionKey,
        locallyQueuedTurnIds(targetSessionKey, ownership?.turnId),
      )
    ) {
      await enqueueForBusySession();
      return;
    }

    if (targetSessionKey !== get().currentSessionKey) {
      set((s) => buildSessionSwitchPatch(s, targetSessionKey));
      deferHistoryLoad(get, true);
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
    const replayReferenceImages = replayIntent
      ? cloneQueuedAttachments(replayIntent.referenceImages) ?? []
      : null;
    const latestSessionImage = requestedImageEdit && explicitPendingImages.length === 0
      ? (replayReferenceImages !== null
          ? replayReferenceImages[0] ?? null
          : findLatestCanonicalSessionImage(currentSessionKey))
      : null;
    const gatewayReferenceImages = explicitPendingImages.length > 0
      ? explicitPendingImages
      : (latestSessionImage ? [latestSessionImage] : []);
    const effectiveMode: ChatSendMode = mode;
    const hasSourceImage = [...(attachments ?? []), ...gatewayReferenceImages]
      .some((attachment) => attachment.mimeType.startsWith('image/'));
    const resolvedImageOptions = replayIntent?.imageOptions
      ? { ...replayIntent.imageOptions }
      : effectiveMode === 'image'
        ? resolveChatImageOptions(trimmed, imageOptions)
        : undefined;
    const resolvedVideoOptions = replayIntent?.videoOptions
      ? { ...replayIntent.videoOptions }
      : effectiveMode === 'video'
        ? resolveChatVideoOptions(trimmed, hasSourceImage, videoOptions)
        : undefined;
    const clientPreferences = replayIntent
      ? cloneGatewayTurnPreferences(replayIntent.clientPreferences)
      : buildGatewayTurnPreferences({
          mode: effectiveMode,
          prompt: trimmed,
          hasSourceImage,
          imageOptions: resolvedImageOptions,
          videoOptions: resolvedVideoOptions,
          selectedArtifacts: gatewayReferenceImages,
        });
    const thinkingLevel = replayIntent
      ? replayIntent.thinkingLevel ?? undefined
      : get().thinkingLevel ?? undefined;

    setBoundedMapEntry(
      _lastSendIntentBySession,
      currentSessionKey,
      createChatSendIntent({
        text,
        attachments,
        targetAgentId,
        mode: effectiveMode,
        imageOptions: resolvedImageOptions,
        videoOptions: resolvedVideoOptions,
        thinkingLevel,
        referenceImages: gatewayReferenceImages,
        clientPreferences,
      }),
      SESSION_RUN_STATE_CACHE_MAX_SESSIONS,
    );

    if (ownership) {
      activateQueuedChatSendTurn(ownership, mode);
      releaseQueuedChatSendDispatchLease(ownership);
    }
    else ownership = beginChatSendTurn(currentSessionKey, trimmed, attachments, mode, true);
    const nowMs = ownership.acceptedAt;
    const idempotencyKey = ownership.idempotencyKey;
    const userMsg = ownership.userMessage;
    const timelineTurnId = ownership.turnId;
    const failTimelineTurn = (errorMessage: string) => {
      useConversationStore.getState().ingestChatEvent({
        state: 'error',
        sessionKey: currentSessionKey,
        errorMessage,
      }, {
        sessionKey: currentSessionKey,
        activeRunId: get().activeRunId,
        turnId: timelineTurnId,
      });
    };
    // Legacy rollback state is appended only when dispatch begins; canonical
    // Timeline already owns the visible queued user request.
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
      useConversationStore.getState().ingestChatEvent({
        state: 'final',
        sessionKey: currentSessionKey,
        message: assistantMsg,
      }, {
        sessionKey: currentSessionKey,
        turnId: timelineTurnId,
      });
      // This local validation path never starts an OpenClaw run, so close the
      // canonical Turn with the same authoritative idle evidence as the legacy state.
      useConversationStore.getState().markSessionActivity(currentSessionKey, false);
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
    const runtimeMessage = trimmed;
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
      failTimelineTurn(errorMessage);
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
          discardPendingOptimisticUserMessage(currentSessionKey, userMsg);
          useConversationStore.getState().discardLocalTurn(currentSessionKey, timelineTurnId);
          set((state) => ({
            messages: state.messages.filter((message) => (
              message !== userMsg && (!userMsg.id || message.id !== userMsg.id)
            )),
            error: errorMsg,
            sending: false,
          }));
        } else {
          set({ error: errorMsg, sending: false });
        }
        failTimelineTurn(errorMsg);
        markSessionRunIdle(currentSessionKey);
        return;
      }

      if (sendStillCurrent && latest.currentSessionKey !== currentSessionKey) {
        const cached = peekCachedSessionRunState(currentSessionKey);
        if (cached?.lastUserMessageAt === nowMs) {
          if (discardOptimisticMessage) {
            discardPendingOptimisticUserMessage(currentSessionKey, userMsg);
            useConversationStore.getState().discardLocalTurn(currentSessionKey, timelineTurnId);
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
      // Cache image attachments BEFORE the IPC call to avoid race condition:
      // history may reload (via Gateway event) before the RPC returns.
      // Keyed by staged file path which appears in [media attached: <path> ...].
      if (hasMedia) {
        cacheAttachedFiles(chatMediaAttachments.map((attachment): [string, AttachedFileMeta] => [
          attachment.stagedPath,
          {
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            fileSize: attachment.fileSize,
            preview: attachment.preview,
            source: 'user-upload',
            disposition: 'input-reference',
          },
        ]));
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

      if (result.success) {
        try {
          await acknowledgeQueuedChatSend(ownership);
        } catch (error) {
          // Keep the durable record for transcript reconciliation on restart.
          console.warn('[chat.queue] failed to acknowledge dispatched outbox intent', {
            sessionKey: currentSessionKey,
            turnId: timelineTurnId,
            error: String(error),
          });
        }
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

        if (sendStillCurrent) {
          useConversationStore.getState().bindRun(
            timelineTurnId,
            currentSessionKey,
            returnedRunId,
            trimmed,
          );
        }

        if (sendStillCurrent && canAttachToCurrentSession) {
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
          const cached = peekCachedSessionRunState(currentSessionKey);
          if (cached?.sending
            && cached.lastUserMessageAt === nowMs
            && (cached.activeRunId == null || cached.activeRunId === returnedRunId)) {
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
    const { currentSessionKey } = stateAtAbort;
    if (_sessionsCancelling.has(currentSessionKey)) return;

    clearErrorRecoveryTimer();
    const activeTurn = selectActiveTurn(useConversationStore.getState(), currentSessionKey);
    const activeRunId = activeTurn?.rootRunId ?? activeTurn?.runAliases[0] ?? null;
    const cancellableTasks = collectCancellableTasks(activeTurn);
    const hostTaskIds = cancellableTasks.hostTaskIds;
    const nativeTaskIds = cancellableTasks.nativeTaskIds;
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
      await abortChatRunViaHostApi(currentSessionKey, activeRunId, nativeTaskIds);
    } catch (err) {
      set({ error: String(err) });
    } finally {
      _sessionsCancelling.delete(currentSessionKey);
      beginSessionBackendIdleSettlement(currentSessionKey, activeRunId);
    }
  },

  retryLastRun: async () => {
    const sessionKey = get().currentSessionKey;
    const previous = getBoundedMapEntry(_lastSendIntentBySession, sessionKey);
    if (previous) {
      const intent = cloneChatSendIntent(previous);
      set({ error: null, runError: null });
      await get().sendMessage(
        intent.text,
        cloneQueuedAttachments(intent.attachments),
        intent.targetAgentId,
        intent.mode,
        intent.imageOptions ? { ...intent.imageOptions } : undefined,
        intent.videoOptions ? { ...intent.videoOptions } : undefined,
        cloneChatSendReplayIntent(intent),
      );
      return;
    }

    const trigger = selectLastRetryableUserTrigger(useConversationStore.getState(), sessionKey);
    const fallback = trigger ? (() => {
      const text = getMessageText(trigger.message.content).trim();
      const attachments = (trigger.message.attachments ?? [])
        .filter((file) => Boolean(file.filePath?.trim()))
        .map((file): ChatSendAttachment => ({
          fileName: file.fileName,
          mimeType: file.mimeType,
          fileSize: file.fileSize,
          stagedPath: file.filePath!,
          preview: file.preview,
        }));
      if (!text && attachments.length === 0) return undefined;
      return { text, attachments: attachments.length > 0 ? attachments : undefined };
    })() : undefined;
    if (!fallback) {
      set({ runError: i18n.t('chat:runError.retryUnavailable') });
      return;
    }
    set({ error: null, runError: null });
    await get().sendMessage(
      fallback.text,
      cloneQueuedAttachments(fallback.attachments),
      get().currentAgentId,
      'chat',
    );
  },

  // ── Handle incoming chat events from Gateway ──

  handleChatEvent: (event: Record<string, unknown>) => {
    const eventRunId = String(event.runId || '');
    const eventState = String(event.state || '');
    const rawEventSessionKey = event.sessionKey != null ? String(event.sessionKey) : null;
    const initialState = get();
    const completionTaskId = completionWakeTaskIdFromRunId(eventRunId);
    const completionWakeOwner = completionTaskId
      ? resolveCompletionWakeCorrelation(useConversationStore.getState(), {
          runId: eventRunId,
          rootRunId: typeof event.rootRunId === 'string' ? event.rootRunId : undefined,
          sessionKey: rawEventSessionKey,
          taskId: typeof event.taskId === 'string' ? event.taskId : completionTaskId,
        })
      : null;
    if (completionTaskId && !completionWakeOwner) {
      console.warn('[handleChatEvent] Ignoring completion wake without a unique canonical owner', {
        eventRunId,
        sessionKey: rawEventSessionKey,
        taskId: completionTaskId,
      });
      return;
    }
    const inferredEventSessionKey = inferSessionKeyForRun(initialState, eventRunId || null, rawEventSessionKey);
    const { activeRunId, currentSessionKey } = initialState;
    const terminalEvent = eventState === 'final'
      || eventState === 'error'
      || eventState === 'aborted'
      || (event.message && typeof event.message === 'object'
        && getMessageStopReason(event.message as Record<string, unknown>) != null);
    const eventSessionKey = completionWakeOwner?.sessionKey ?? inferredEventSessionKey;
    const completionWakeOwnerRunId = completionWakeOwner?.rootRunId;
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
        const ownerRunId = peekCachedSessionRunState(eventSessionKey)?.activeRunId || runId;
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
    // Inbound channel traffic (Feishu/Telegram/etc.) on the current session can use
    // a different runId than a stale desktop activeRunId. Its live events remain
    // independent and must not trigger a transcript replay into the visible stream.
    if (activeRunId && runId && runId !== activeRunId) {
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
          // before they enter the visible message stream.
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
              scheduleRuntimeArtifactVerification({
                runId,
                sessionKey: eventSessionKey ?? currentSessionKey,
                toolCallId: normalizedFinalMessage.toolCallId,
              }, toolArtifacts);
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
            scheduleRuntimeArtifactVerification({
              runId,
              sessionKey: eventSessionKey ?? currentSessionKey,
            }, finalArtifactsToVerify);
          }
          // Keep controls active until OpenClaw confirms the session is idle. The
          // visible Timeline remains owned by live events and is not replayed here.
          const sessionKeyAtFinal = eventSessionKey ?? currentSessionKey;
          if (clearLifecycle && !toolOnly && !withheldFinalMessage) {
            clearHistoryPoll();
            beginSessionBackendIdleSettlement(sessionKeyAtFinal, runId ?? get().activeRunId);
          }
        } else {
          const sessionKeyAtFinal = eventSessionKey ?? currentSessionKey;
          const latestState = get();
          const terminalRunId = runId || latestState.activeRunId;
          set({ streamingText: '', streamingMessage: null, pendingFinal: true });
          beginSessionBackendIdleSettlement(sessionKeyAtFinal, terminalRunId);
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
    const completionTaskId = completionWakeTaskIdFromRunId(event.runId);
    const completionWakeOwner = completionTaskId
      ? resolveCompletionWakeCorrelation(useConversationStore.getState(), {
          runId: event.runId,
          rootRunId: event.rootRunId,
          sessionKey: event.sessionKey,
          taskId: event.taskId ?? completionTaskId,
        })
      : null;
    if (completionTaskId && !completionWakeOwner) {
      console.warn('[handleRuntimeEvent] Ignoring completion wake without a unique canonical owner', {
        runId: event.runId,
        sessionKey: event.sessionKey,
        taskId: completionTaskId,
      });
      return;
    }
    const inferredEventSessionKey = inferSessionKeyForRun(initialState, event.runId, event.sessionKey ?? null);
    const eventSessionKey = completionWakeOwner?.sessionKey ?? inferredEventSessionKey;
    const eventForSession: ChatRuntimeEvent = completionWakeOwner
      ? {
          ...event,
          sessionKey: completionWakeOwner.sessionKey,
          rootRunId: completionWakeOwner.rootRunId,
          taskId: event.taskId ?? completionWakeOwner.taskId,
        }
      : eventSessionKey && event.sessionKey !== eventSessionKey
        ? { ...event, sessionKey: eventSessionKey }
        : event;
    const matchesCurrentSession = eventSessionKey != null && eventSessionKey === currentSessionKey;
    const matchesActiveRun = activeRunId != null && event.runId === activeRunId;
    const isCompletionWake = completionTaskId != null;
    const completionWakeOwnerRunId = completionWakeOwner?.rootRunId;
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
    const appliesToActiveUi = (completionWakeOwnerRunId != null && matchesCurrentSession)
      || matchesActiveRun
      || matchesActiveTurn
      || (activeRunId == null && matchesCurrentSession && !isCompletionWake);
    let completedToolFiles: AttachedFileMeta[] = [];

    if (eventForSession.type === 'artifact.produced' || eventForSession.type === 'verification.completed') {
      scheduleWithheldFinalReevaluationForSession(eventSessionKey ?? currentSessionKey);
    }

    if (eventForSession.type === 'artifact.produced') {
      scheduleRuntimeArtifactVerification(
        {
          runId: eventForSession.runId,
          rootRunId: eventForSession.rootRunId,
          sessionKey: eventForSession.sessionKey,
          taskId: eventForSession.taskId,
          parentTaskId: eventForSession.parentTaskId,
          toolCallId: eventForSession.toolCallId,
        },
        [eventForSession.artifact],
      );
    }

    if (eventForSession.type === 'tool.completed') {
      completedToolFiles = extractToolCompletedFiles(eventForSession);
      if (completedToolFiles.length > 0) {
        const artifactEvents = buildRuntimeArtifactEventsFromAttachedFiles({
          runId: eventForSession.runId,
          rootRunId: eventForSession.rootRunId,
          sessionKey: eventSessionKey ?? (appliesToActiveUi ? currentSessionKey : undefined),
          taskId: eventForSession.taskId,
          parentTaskId: eventForSession.parentTaskId,
          ts: eventForSession.ts ?? Date.now(),
          toolCallId: eventForSession.toolCallId,
          verificationDetail: '工具结果中的产物已进入 UClaw 产物跟踪。',
        }, completedToolFiles);
        runtimeRuns = applyRuntimeContractEvents(runtimeRuns, artifactEvents);
        nextPatch.runtimeRuns = runtimeRuns;
        scheduleRuntimeArtifactVerification(
          {
            runId: eventForSession.runId,
            rootRunId: eventForSession.rootRunId,
            sessionKey: eventForSession.sessionKey,
            taskId: eventForSession.taskId,
            parentTaskId: eventForSession.parentTaskId,
            toolCallId: eventForSession.toolCallId,
          },
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
      const terminalSessionKey = updateCachedSessionRunStateFromRuntimeEvent(
        eventForSession,
        runtimeRuns,
        runtimeRunHasPendingAsyncTasks(runtimeRuns[eventForSession.runId]),
      );
      if (terminalSessionKey) {
        markSessionRunIdle(terminalSessionKey);
        markSessionNeedsTerminalHistoryRefresh(terminalSessionKey);
      }
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

  clearError: () => set({ error: null, runError: null, historyError: null }),
  clearHistoryError: () => set({ historyError: null }),
}));

useChatStore.subscribe((state, previousState) => {
  if (state.currentSessionKey !== previousState.currentSessionKey) {
    persistCurrentSessionKey(state.currentSessionKey);
    useConversationStore.getState().setCurrentSession(state.currentSessionKey);
  }
});

useConversationStore.getState().setCurrentSession(useChatStore.getState().currentSessionKey);

export function syncCachedSessionRunIdle(sessionKey: string): void {
  markSessionRunIdle(sessionKey);
}
