/**
 * Chat State Store
 * Manages chat messages, sessions, and streaming state.
 * Chat RPC/control flows are Main-owned via Host API routes.
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import i18n from '@/i18n';
import { useGatewayStore } from './gateway';
import { useAgentsStore } from './agents';
import { getManagedAuthStateKey, isManagedAuthLocallyReady, isManagedAuthReady } from '@/lib/managed-auth';
import { normalizeManagedTextModelRef } from '@/lib/managed-model-options';
import { useClientConfigStore } from './client-config';
import { useManagedAuthStore } from './managed-auth';
import { useProviderStore } from './providers';
import type { ChatRuntimeArtifact, ChatRuntimeEvent, ChatRuntimePlanStep } from '../../shared/chat-runtime-events';
import type {
  CompositeRunApiResponse,
  CompositeRunRecord,
  CompositeRunTaskInput,
  CompositeRunTaskKind,
} from '../../shared/composite-run';
import { CHAT_SEND_RPC_TIMEOUT_MS } from '../../shared/chat-timeouts';
import { buildBaselineRunKey, captureBaseline, clearBaselines } from './baseline-cache';
import { buildCronSessionHistoryPath, isCronSessionKey } from './chat/cron-session-utils';
import {
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
import { applyRuntimeEventToRuns, extractToolCompletedFiles, shouldFilterRuntimeExecutionGraphEvent } from './chat/runtime-graph';
import { buildRuntimeProgressEvents } from './chat/runtime-progress';
import {
  buildRuntimeArtifactEventsFromAttachedFiles,
  buildRuntimeArtifactVerificationEvent,
  buildRuntimeCheckpointEvent,
  buildRuntimeCompletionGateEvents,
  buildRuntimeStartContractEvents,
} from './chat/runtime-contract';
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
  extractTextSegments,
  extractToolUse,
  isGeneratingStatusNarration,
  isInternalAssistantReplyText,
  isInternalProcessNarration,
  stripCompositeExecutionContractEnvelope,
} from '@/pages/Chat/message-utils';

export type {
  AttachedFileMeta,
  ChatSession,
  CompositeArtifactManifest,
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

type MediaIntentCompositeTaskKind = CompositeRunTaskKind;
type MediaIntentCompositeTask = CompositeRunTaskInput;

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

function isImageAttachmentFile(
  file: Pick<AttachedFileMeta, 'mimeType' | 'filePath' | 'fileName' | 'fileSize' | 'preview'> | undefined | null,
): file is Required<Pick<AttachedFileMeta, 'mimeType' | 'filePath' | 'fileName' | 'fileSize' | 'preview'>> {
  return Boolean(
    file
    && typeof file.mimeType === 'string'
    && file.mimeType.startsWith('image/')
    && typeof file.filePath === 'string'
    && file.filePath.trim().length > 0
    && typeof file.fileName === 'string'
    && typeof file.fileSize === 'number',
  );
}

function normalizePendingImageInput(
  file: Pick<AttachedFileMeta, 'mimeType' | 'filePath' | 'fileName' | 'fileSize' | 'preview'>,
): PendingImageInput {
  return {
    fileName: file.fileName,
    mimeType: file.mimeType,
    fileSize: file.fileSize,
    stagedPath: file.filePath || '',
    preview: file.preview,
  };
}

function resolveImageModeReferenceInputs(
  explicitAttachments: PendingImageInput[] | undefined,
  messages: RawMessage[],
): PendingImageInput[] {
  const explicitImages = (explicitAttachments ?? []).filter((file) => file.mimeType.startsWith('image/'));
  if (explicitImages.length > 0) {
    return explicitImages;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') continue;
    const imageFile = (message._attachedFiles ?? []).find((file) => isImageAttachmentFile(file));
    if (imageFile) {
      return [normalizePendingImageInput(imageFile)];
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const imageFile = (message._attachedFiles ?? []).find((file) => isImageAttachmentFile(file));
    if (imageFile) {
      return [normalizePendingImageInput(imageFile)];
    }
  }

  return [];
}

function shouldLoadFamilyImageReferences(prompt: string, mode: ChatSendMode): boolean {
  const referencesImage = /(?:这张|这幅|这个图|这图|这张图|这个图片|图片|照片|画面|上一张|上一个|刚才|刚生成|它|previous|last|this image|this picture|this photo|the image|the picture|it)/i.test(prompt);
  const asksAboutImage = /(?:美吗|美嘛|好看吗|漂亮吗|丑吗|怎么样|咋样|如何|评价|点评|审美|哪里.*(?:好|不好|优化|改进)|what do you think|look good|beautiful|pretty|rate|review|critique|analy[sz]e)/i.test(prompt);
  const editsImage = /(?:去掉|删除|移除|替换|添加|加一|加个|改成|修一下|调整|换成|美化|背景|动起来|animate|turn .* into video|make .* move|remove|replace|add|edit)/i.test(prompt);
  if (mode === 'image' || mode === 'video') {
    return referencesImage || asksAboutImage || editsImage;
  }
  return referencesImage;
}

async function loadFamilyImageReferenceInputs(
  sessionKey: string,
  prompt: string,
  mode: ChatSendMode,
): Promise<PendingImageInput[]> {
  if (!shouldLoadFamilyImageReferences(prompt, mode)) return [];

  try {
    const transcriptMessages = await withTimeout(
      loadSessionTranscriptFallback(sessionKey, PREVIEW_HYDRATION_MESSAGE_LIMIT, { includeFamily: true }),
      CHAT_HISTORY_DISK_FALLBACK_TIMEOUT_MS,
    );
    const messagesWithToolImages = enrichWithToolResultFiles(transcriptMessages);
    const enrichedMessages = enrichWithCachedImages(messagesWithToolImages);
    return resolveImageModeReferenceInputs([], enrichedMessages);
  } catch (error) {
    console.warn('[chat.media] family image reference fallback failed:', error);
    return [];
  }
}

function mergeGatewayImageReferences(
  explicitAttachments: ChatSendAttachment[] | undefined,
  references: PendingImageInput[],
): ChatSendAttachment[] {
  const byPath = new Map<string, ChatSendAttachment>();
  for (const attachment of explicitAttachments ?? []) {
    if (attachment.stagedPath.trim()) {
      byPath.set(attachment.stagedPath, attachment);
    }
  }
  for (const reference of references) {
    if (!reference.stagedPath.trim() || byPath.has(reference.stagedPath)) continue;
    byPath.set(reference.stagedPath, reference);
  }
  return [...byPath.values()];
}

function sanitizeCompositeTaskId(value: string, index: number): string {
  const cleaned = value.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
  return cleaned || `task-${index + 1}`;
}

function compositeTaskKindLabel(kind: MediaIntentCompositeTaskKind): string {
  switch (kind) {
    case 'image_generate':
      return '图片生成';
    case 'image_edit':
      return '图片编辑';
    case 'video_generate':
      return '视频生成';
    case 'presentation':
      return '演示文稿';
    case 'spreadsheet':
      return '表格';
    case 'mini_program':
      return '小程序';
    case 'copywriting':
      return '文案';
    default:
      return kind;
  }
}

function describeCompositeTaskImages(task: MediaIntentCompositeTask): string {
  const images = (task.sourceImages ?? []).filter((image) => image.filePath?.trim());
  if (images.length === 0) {
    return task.kind === 'image_edit'
      ? '参考图：未指定；如本轮前序子任务刚生成图片，优先使用该图片作为修图输入，否则把该子任务标记为待补输入。'
      : '参考图：无。';
  }
  return `参考图：${images.map((image, index) => {
    const name = image.fileName?.trim() || `image-${index + 1}`;
    return `${name} (${image.filePath})`;
  }).join('；')}`;
}

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

function looksLikeCompositeArtifactHistory(objective: string, artifactFiles: AttachedFileMeta[]): boolean {
  if (artifactFiles.length <= 1) return false;
  return artifactFiles.length >= 3
    || /(?:每个|各(?:来|做|生成)|生图|修图|图片|视频|ppt|powerpoint|excel|表格|小程序|文案|以及|并且|同时|顺便|然后|另外|还有|和|与|\band\b|\bthen\b|\balso\b)/i.test(objective);
}

type HistoricalCompositeTaskSummary = {
  title: string;
  status: 'completed' | 'blocked';
  detail?: string;
};

function isCompositeResultHistoryMessage(message: RawMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (message.localArtifactResultKind === 'composite') return true;
  if (typeof message.id === 'string' && message.id.startsWith('composite-result:')) return true;
  const text = getMessageText(message.content);
  return (message._attachedFiles?.length ?? 0) > 0
    && /随机示例包/.test(text)
    && /(?:统一)?产物清单/.test(text);
}

function extractMessageArtifactFiles(message: RawMessage): AttachedFileMeta[] {
  const files: AttachedFileMeta[] = [...(message._attachedFiles ?? [])];
  const text = getMessageText(message.content);
  if (!text) return dedupeAttachedFiles(files);

  const mediaRefs = extractMediaRefs(text);
  const mediaRefPaths = new Set(mediaRefs.map((ref) => ref.filePath));
  for (const ref of mediaRefs) {
    files.push({ ...makeAttachedFile(ref), source: 'message-ref' });
  }
  for (const ref of extractRawFilePaths(text)) {
    if (mediaRefPaths.has(ref.filePath)) continue;
    files.push({ ...makeAttachedFile(ref), source: 'message-ref' });
  }
  return dedupeAttachedFiles(files);
}

function parseHistoricalCompositeTasks(message: RawMessage): HistoricalCompositeTaskSummary[] {
  if (!isCompositeResultHistoryMessage(message)) return [];

  const manifestTasks = message.compositeArtifactManifest?.tasks;
  if (Array.isArray(manifestTasks) && manifestTasks.length > 0) {
    return manifestTasks.map((task) => ({
      title: task.title || task.kind || '产物任务',
      status: task.status === 'completed' ? 'completed' : 'blocked',
      ...(task.detail ? { detail: task.detail } : {}),
    }));
  }

  const lines = getMessageText(message.content)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const tasks: HistoricalCompositeTaskSummary[] = [];
  let section: 'completed' | 'blocked' | null = null;

  for (const line of lines) {
    if (/^已完成\s+\d+(?:\/\d+)?\s+项/u.test(line)) {
      section = 'completed';
      continue;
    }
    if (/^(?:需要补充处理|未完成)[:：]?$/u.test(line)) {
      section = 'blocked';
      continue;
    }
    if (!line.startsWith('-')) {
      if (/^(?:下面是|我也做了基础验证)/u.test(line)) {
        section = null;
      }
      continue;
    }
    if (!section) continue;

    const body = line.replace(/^-\s*/u, '').trim();
    if (!body) continue;
    if (section === 'completed') {
      tasks.push({ title: body, status: 'completed' });
      continue;
    }

    const [title, detail] = body.split(/[:：]/u, 2);
    tasks.push({
      title: title.trim(),
      status: 'blocked',
      detail: detail?.trim() || '需要补充处理。',
    });
  }

  return tasks;
}

function historicalCompositeTaskTitle(file: AttachedFileMeta, index: number): string {
  const mimeType = file.mimeType || '';
  const fileName = file.fileName || file.filePath?.split(/[\\/]/).pop() || '';
  const lowerName = fileName.toLowerCase();
  if (mimeType.startsWith('image/')) return '图片产物';
  if (mimeType.startsWith('video/')) return '视频产物';
  if (mimeType.includes('presentation') || /\.pptx?$/i.test(lowerName)) return 'PPT 产物';
  if (mimeType.includes('spreadsheet') || /\.xlsx?$/i.test(lowerName)) return 'Excel 产物';
  if (mimeType.includes('html') || /\.html?$/i.test(lowerName)) return '小程序/网页产物';
  if (mimeType.includes('markdown') || mimeType.startsWith('text/') || /\.md$/i.test(lowerName)) return '文案产物';
  return `产物 ${index + 1}`;
}

function buildHistoricalCompositePlanEvent(params: {
  runId: string;
  sessionKey: string;
  objective: string;
  artifactFiles: AttachedFileMeta[];
  taskSummaries?: HistoricalCompositeTaskSummary[];
  ts: number;
}): ChatRuntimeEvent {
  const inferredCompletedTasks = params.artifactFiles.map((file, index): HistoricalCompositeTaskSummary => ({
      title: historicalCompositeTaskTitle(file, index),
      status: 'completed',
    }));
  const providedTasks = params.taskSummaries ?? [];
  const taskSummaries = providedTasks.some((task) => task.status === 'completed')
    ? providedTasks
    : [...inferredCompletedTasks, ...providedTasks];
  const steps: ChatRuntimePlanStep[] = [
    {
      id: 'uclaw.composite',
      title: '执行组合任务',
      status: 'completed',
      detail: `${taskSummaries.length} 个历史子任务已从统一产物清单恢复。`,
      kind: 'composite',
      order: 1,
    },
    ...taskSummaries.map((task, index): ChatRuntimePlanStep => ({
      id: `uclaw.composite.history.${sanitizeCompositeTaskId(task.title, index)}`,
      title: task.title,
      status: task.status,
      detail: task.detail || '已从历史统一交付结果恢复。',
      kind: 'composite-task',
      order: 2 + index,
      parentId: 'uclaw.composite',
      requiresArtifact: false,
    })),
  ];
  return {
    contractVersion: 1,
    producer: 'history',
    runId: params.runId,
    sessionKey: params.sessionKey,
    ts: params.ts,
    type: 'run.plan.updated',
    objective: params.objective,
    summary: '从历史产物恢复组合任务摘要。',
    steps,
  };
}

function collapseSupersededCompositeHistoryReplies(messages: RawMessage[]): RawMessage[] {
  const result: RawMessage[] = [];
  let segmentStart = 0;

  const pushCollapsedSegment = (segment: RawMessage[]) => {
    if (segment.length === 0) return;
    const compositeIndex = (() => {
      for (let index = segment.length - 1; index >= 0; index -= 1) {
        if (isCompositeResultHistoryMessage(segment[index]!)) return index;
      }
      return -1;
    })();
    if (compositeIndex < 0) {
      result.push(...segment);
      return;
    }

    const canonicalArtifacts = extractMessageArtifactFiles(segment[compositeIndex]!);
    const canonicalKeys = new Set(canonicalArtifacts.map(attachedFileKey));
    if (canonicalKeys.size === 0) {
      result.push(...segment);
      return;
    }

    result.push(...segment.filter((message, index) => {
      if (index >= compositeIndex) return true;
      if (message.role !== 'assistant') return true;
      const artifacts = extractMessageArtifactFiles(message);
      if (artifacts.length === 0) return true;
      return !artifacts.every((artifact) => canonicalKeys.has(attachedFileKey(artifact)));
    }));
  };

  for (let index = 0; index < messages.length; index += 1) {
    if (index > segmentStart && isRealUserBoundaryMessage(messages[index]!)) {
      pushCollapsedSegment(messages.slice(segmentStart, index));
      segmentStart = index;
    }
  }
  pushCollapsedSegment(messages.slice(segmentStart));
  return result;
}

function shouldDropMessageFromRuntimeReplay(message: RawMessage): boolean {
  if (isToolResultRole(message.role)) return false;
  if (hasPendingToolUse(message) || isToolOnlyMessage(message)) return false;
  return isInternalMessage(message);
}

function buildRuntimeReplayMessages(messages: RawMessage[]): RawMessage[] {
  return collapseSupersededCompositeHistoryReplies(
    dedupeRedundantAssistantReplies(
      enrichWithCachedImages(
        messages.filter((message, index) => (
          !shouldDropMessageFromRuntimeReplay(message) || shouldRetainAssistantHistorySummary(messages, index)
        )),
      ),
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

  const events = buildRuntimeStartContractEvents(undefined, {
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

function applyHistoricalRuntimeRunsFromMessages(
  runtimeRuns: ChatState['runtimeRuns'],
  sessionKey: string,
  messages: RawMessage[],
): ChatState['runtimeRuns'] {
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
    const compositeResultMessage = [...segment].reverse().find((message) => isCompositeResultHistoryMessage(message)) ?? null;
    const mediaResultMessage = [...segment].reverse().find((message) => (
      (message.localArtifactResultKind === 'image' || message.localArtifactResultKind === 'video')
      && message.mediaGenerationSnapshot
    ));
    const mediaGenerationSnapshot = mediaResultMessage?.mediaGenerationSnapshot
      && typeof mediaResultMessage.mediaGenerationSnapshot === 'object'
      ? mediaResultMessage.mediaGenerationSnapshot as MediaGenerationJobSnapshot
      : undefined;
    const mediaRunStartedAt = optionalToMs(mediaGenerationSnapshot?.startedAt) ?? null;
    const mediaRunCompletedAt = optionalToMs(mediaGenerationSnapshot?.completedAt) ?? null;
    const artifactFiles = compositeResultMessage
      ? extractMessageArtifactFiles(compositeResultMessage)
      : segment
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => extractMessageArtifactFiles(message));
    const uniqueArtifactFiles = dedupeAttachedFiles(artifactFiles);
    const objective = getMessageText(trigger.content).trim();
    const ts = trigger.timestamp ? toMs(trigger.timestamp) : Date.now();
    const runId = buildHistoricalRunId(sessionKey, trigger, index);
    const historicalAsyncEvidence = segment.flatMap((message) => extractAsyncTaskEvidence(message));
    const finalizedRuntimeEvents = compositeResultMessage?.compositeArtifactManifest?.runtimeEvents;
    if (Array.isArray(finalizedRuntimeEvents) && finalizedRuntimeEvents.length > 0) {
      const replayEvents = finalizedRuntimeEvents.map((event): ChatRuntimeEvent => ({
        ...event,
        runId,
        sessionKey,
        producer: 'history',
      }));
      nextRuns = applyRuntimeContractEvents(nextRuns, replayEvents);
      nextRuns = applyAsyncTaskEvidenceToRuns(nextRuns, runId, historicalAsyncEvidence, sessionKey);
      continue;
    }

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
      const toolRun = nextRuns[runId];
      const toolRunEnded = toolRun?.events.some((event) => event.type === 'run.ended') === true;
      if (toolRunEnded && !runtimeRunHasPendingAsyncTasks(toolRun)) {
        const completedStatus: Extract<ChatRuntimeEvent, { type: 'run.ended' }>['status'] = toolRun?.status === 'error'
          ? 'error'
          : toolRun?.status === 'aborted'
            ? 'aborted'
            : 'completed';
        nextRuns = applyRuntimeContractEvents(
          nextRuns,
          buildRuntimeCompletionGateEvents(toolRun, {
            runId,
            sessionKey,
            ts: toolRun.endedAt ?? toolRun.lastEventAt ?? ts,
            status: completedStatus,
          }),
        );
      }
      continue;
    }

    const historicalCompositeTasks = compositeResultMessage
      ? parseHistoricalCompositeTasks(compositeResultMessage)
      : [];
    const restoreCompositePlan = historicalCompositeTasks.length > 0
      || looksLikeCompositeArtifactHistory(objective, uniqueArtifactFiles);
    const mode = restoreCompositePlan ? 'chat' : inferHistoricalRunMode(uniqueArtifactFiles);
    const historicalToolEvents = buildHistoricalToolRuntimeEventsFromSegment({
      runId,
      sessionKey,
      objective,
      segment,
      ts,
    }).filter((event) => event.type !== 'run.started' && event.type !== 'run.ended');
    const historicalMediaProgressEvents = mediaGenerationSnapshot
      ? buildMediaRuntimeProgressEvents({ runId, sessionKey, job: mediaGenerationSnapshot })
      : [];
    const startEvents = buildRuntimeStartContractEvents(undefined, {
      runId,
      sessionKey,
      objective,
      mode,
      ts: mediaRunStartedAt ?? ts,
      producer: 'history',
    });
    const artifactEvents = buildRuntimeArtifactEventsFromAttachedFiles({
      runId,
      sessionKey,
      ts,
      producer: 'history',
      verificationDetail: '从历史消息产物卡片恢复的产物。',
    }, uniqueArtifactFiles);
    const restoredArtifacts = artifactEvents
      .filter((event): event is Extract<ChatRuntimeEvent, { type: 'artifact.produced' }> =>
        event.type === 'artifact.produced')
      .map((event) => event.artifact);
    const historicalAvailabilityEvents = restoredArtifacts.map((artifact) => buildRuntimeArtifactVerificationEvent({
      runId,
      sessionKey,
      ts,
      producer: 'history',
    }, {
      artifact,
      status: 'passed',
      kind: 'artifact.availability',
      required: true,
      severity: 'info',
      detail: '已从历史消息恢复产物引用，按历史交付记录视为可交付。',
      evidence: artifact.filePath ?? artifact.url,
    }));
    nextRuns = applyRuntimeContractEvents(nextRuns, [
      ...startEvents,
      ...(restoreCompositePlan
        ? [buildHistoricalCompositePlanEvent({
          runId,
          sessionKey,
          objective,
          artifactFiles: uniqueArtifactFiles,
          taskSummaries: historicalCompositeTasks,
          ts,
        })]
        : []),
      ...historicalToolEvents,
      ...historicalMediaProgressEvents,
      ...artifactEvents,
      ...historicalAvailabilityEvents,
      {
        contractVersion: 1,
        producer: 'history',
        runId,
        sessionKey,
        ts: mediaRunCompletedAt ?? ts,
        type: 'run.ended',
        ...(mediaRunCompletedAt != null ? { endedAt: mediaRunCompletedAt } : {}),
        status: 'completed',
      },
    ]);
    nextRuns = applyAsyncTaskEvidenceToRuns(nextRuns, runId, historicalAsyncEvidence, sessionKey);
    nextRuns = applyRuntimeContractEvents(
      nextRuns,
      buildRuntimeCompletionGateEvents(nextRuns[runId], {
        runId,
        sessionKey,
        ts: mediaRunCompletedAt ?? ts,
        status: 'completed',
      }),
    );
  }
  return nextRuns;
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
  const files = dedupeAttachedFiles(
    segment
      .filter((message) => message.role === 'assistant' && !hasPendingToolUse(message))
      .flatMap((message) => extractMessageArtifactFiles(message)),
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
const LOCALLY_ABORTED_RUN_TTL_MS = 30 * 60 * 1000;
const _locallyAbortedRunIds = new Map<string, number>();

function rememberLocallyAbortedRun(runId: string | null): void {
  if (!runId) return;
  const now = Date.now();
  _locallyAbortedRunIds.set(runId, now);
  for (const [candidateRunId, abortedAt] of _locallyAbortedRunIds) {
    if (now - abortedAt > LOCALLY_ABORTED_RUN_TTL_MS) {
      _locallyAbortedRunIds.delete(candidateRunId);
    }
  }
}

function wasLocallyAbortedRun(runId: string | null | undefined): boolean {
  if (!runId) return false;
  const abortedAt = _locallyAbortedRunIds.get(runId);
  if (abortedAt == null) return false;
  if (Date.now() - abortedAt <= LOCALLY_ABORTED_RUN_TTL_MS) return true;
  _locallyAbortedRunIds.delete(runId);
  return false;
}
type PendingRuntimeIntent = {
  objective?: string;
  mode: ChatSendMode;
  compositeTasks?: MediaIntentCompositeTask[];
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
  compositeClientRequestId?: string;
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
const _pendingCompositeClientRequestIdBySession = new Map<string, string>();

type MediaGenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
type MediaGenerationProgressEvent = {
  id: string;
  source: 'job' | 'worker' | 'runtime' | 'plugin';
  event: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  timestampMs: number;
  detail?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
};
type MediaGenerationJobSnapshot = {
  id: string;
  kind?: 'image' | 'video';
  sessionKey?: string;
  runId?: string;
  ownerKind?: 'standalone' | 'composite';
  status: MediaGenerationJobStatus;
  createdAt?: number;
  startedAt?: number;
  completedAt?: number;
  queuePosition?: number;
  activeJobs?: number;
  maxActiveJobs?: number;
  queueWaitMs?: number;
  runDurationMs?: number;
  progressEvents?: MediaGenerationProgressEvent[];
  error?: string;
  deliveryStatus?: 'pending' | 'succeeded' | 'failed' | 'skipped';
  deliveryError?: string;
  recoverable?: boolean;
  outputs?: Array<Record<string, unknown>>;
  result?: unknown;
};
const MEDIA_GENERATION_JOB_FAST_POLL_INTERVAL_MS = 500;
const MEDIA_GENERATION_JOB_SLOW_POLL_INTERVAL_MS = 1500;
const MEDIA_GENERATION_JOB_FAST_POLL_WINDOW_MS = 180_000;
const _mediaRuntimeProgressSignatureByRun = new Map<string, Map<string, string>>();
const _observedMediaGenerationJobIds = new Set<string>();

class LocalRunCancelledError extends Error {
  constructor() {
    super('Local run cancelled');
    this.name = 'LocalRunCancelledError';
  }
}

function isLocalRunCancelledError(error: unknown): error is LocalRunCancelledError {
  return error instanceof LocalRunCancelledError;
}

function activeSendGenerationMatches(sessionKey: string, sendGeneration: number): boolean {
  return _activeSendGenerationBySession.get(sessionKey) === sendGeneration;
}

async function cancelMediaGenerationJobs(params: { jobId?: string; sessionKey?: string; runId?: string }): Promise<void> {
  await hostApiFetch<{ success: boolean; error?: string; cancelledJobIds?: string[] }>(
    '/api/media/generation-jobs/cancel',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
  );
}

function mediaProgressSignature(progress: MediaGenerationProgressEvent): string {
  return JSON.stringify({
    id: progress.id,
    event: progress.event,
    status: progress.status,
    detail: progress.detail,
    durationMs: progress.durationMs,
    timestampMs: progress.timestampMs,
  });
}

function changedMediaProgressEvents(runId: string, job: MediaGenerationJobSnapshot | undefined): MediaGenerationProgressEvent[] {
  if (!job?.progressEvents?.length) return [];
  const signatures = _mediaRuntimeProgressSignatureByRun.get(runId) ?? new Map<string, string>();
  const changed: MediaGenerationProgressEvent[] = [];
  for (const progress of job.progressEvents) {
    const key = `${job.id}:${progress.id}`;
    const signature = mediaProgressSignature(progress);
    if (signatures.get(key) === signature) continue;
    signatures.set(key, signature);
    changed.push(progress);
  }
  _mediaRuntimeProgressSignatureByRun.set(runId, signatures);
  return changed;
}

function shouldDisplayMediaProgress(progress: MediaGenerationProgressEvent): boolean {
  if (progress.status === 'error') return true;
  if (progress.source === 'worker') return true;
  if (progress.source !== 'job') return false;
  if (progress.event !== 'queue_completed') return false;
  const metadata = progress.metadata ?? {};
  const queueWaitMs = typeof metadata.queueWaitMs === 'number' && Number.isFinite(metadata.queueWaitMs)
    ? metadata.queueWaitMs
    : progress.durationMs;
  const activeJobs = typeof metadata.activeJobs === 'number' && Number.isFinite(metadata.activeJobs)
    ? metadata.activeJobs
    : undefined;
  const maxActiveJobs = typeof metadata.maxActiveJobs === 'number' && Number.isFinite(metadata.maxActiveJobs)
    ? metadata.maxActiveJobs
    : undefined;
  return (queueWaitMs ?? 0) >= 1000 || (activeJobs != null && maxActiveJobs != null && activeJobs >= maxActiveJobs);
}

async function waitForMediaGenerationJob(
  jobId: string,
  options?: {
    onProgress?: (job: MediaGenerationJobSnapshot) => void;
    isCancelled?: () => boolean;
  },
): Promise<MediaGenerationJobSnapshot> {
  const startedAt = Date.now();
  _observedMediaGenerationJobIds.add(jobId);
  try {
    for (;;) {
    if (options?.isCancelled?.()) {
      void cancelMediaGenerationJobs({ jobId }).catch((error) => {
        console.warn('[media-generation] failed to cancel stale job:', error);
      });
      throw new LocalRunCancelledError();
    }
    const response = await hostApiFetch<{ success: boolean; error?: string; job?: MediaGenerationJobSnapshot }>(
      `/api/media/generation-jobs/${encodeURIComponent(jobId)}`,
    );
    if (options?.isCancelled?.()) {
      void cancelMediaGenerationJobs({ jobId }).catch((error) => {
        console.warn('[media-generation] failed to cancel stale job:', error);
      });
      throw new LocalRunCancelledError();
    }
    if (response.success === false) {
      throw new Error(response.error || 'Failed to check media generation job');
    }
    if (!response.job) {
      throw new Error('Media generation job response missing job');
    }
    options?.onProgress?.(response.job);
    if (response.job.status === 'succeeded' && response.job.deliveryStatus !== 'pending') {
      return response.job;
    }
    if (response.job.status === 'failed') {
      throw new Error(response.job.error || 'Media generation failed');
    }
    if (response.job.status === 'cancelled') {
      throw new LocalRunCancelledError();
    }
    const pollInterval = Date.now() - startedAt < MEDIA_GENERATION_JOB_FAST_POLL_WINDOW_MS
      ? MEDIA_GENERATION_JOB_FAST_POLL_INTERVAL_MS
      : MEDIA_GENERATION_JOB_SLOW_POLL_INTERVAL_MS;
      await sleep(pollInterval);
    }
  } finally {
    _observedMediaGenerationJobIds.delete(jobId);
  }
}

async function resumeStandaloneMediaJobsForSession(
  set: ChatSet,
  get: ChatGet,
  sessionKey: string,
): Promise<void> {
  if (_sessionsCancelling.has(sessionKey)) return;
  let response: { success: boolean; jobs?: MediaGenerationJobSnapshot[] };
  try {
    response = await hostApiFetch<{ success: boolean; jobs?: MediaGenerationJobSnapshot[] }>(
      `/api/media/generation-jobs?sessionKey=${encodeURIComponent(sessionKey)}&activeOnly=true`,
    );
  } catch (error) {
    console.warn('[media-generation] failed to discover resumable jobs:', error);
    return;
  }
  const jobs = (response.jobs ?? []).filter((job) => (
    job.ownerKind === 'standalone'
    && Boolean(job.runId)
    && !_observedMediaGenerationJobIds.has(job.id)
  ));
  for (const job of jobs) {
    if (_observedMediaGenerationJobIds.has(job.id)) continue;
    const runId = job.runId!;
    const kind = job.kind === 'video' ? 'video' : 'image';
    set((state) => ({
      runtimeRuns: applyRuntimeContractEvents(
        state.runtimeRuns,
        buildRuntimeStartEventsForRun(state.runtimeRuns, {
          runId,
          sessionKey,
          mode: kind,
          ts: job.createdAt ?? Date.now(),
        }),
      ),
    }));
    commitSessionRunState(set, get, sessionKey, {
      sending: true,
      activeRunId: runId,
      pendingFinal: true,
      pendingImageGenerationLocal: kind === 'image',
      pendingVideoGenerationLocal: kind === 'video',
    });
    applyMediaRuntimeProgress({ runId, sessionKey, job });

    void waitForMediaGenerationJob(job.id, {
      onProgress: (snapshot) => applyMediaRuntimeProgress({ runId, sessionKey, job: snapshot }),
      isCancelled: () => wasLocallyAbortedRun(runId) || _sessionsCancelling.has(sessionKey),
    }).then((completedJob) => {
      if (wasLocallyAbortedRun(runId)) return;
      const { decision, artifacts } = applyMediaRuntimeSuccess({
        runId,
        sessionKey,
        job: completedJob,
        kind,
      });
      if (artifacts.length > 0) scheduleRuntimeArtifactVerification(runId, sessionKey, artifacts);
      if (completedJob.deliveryStatus === 'failed') {
        appendMediaGenerationResultMessage({ set, get, sessionKey, job: completedJob, kind });
      }
      const shouldIdle = gateDecisionAllowsTerminalIdle(decision);
      commitSessionRunState(set, get, sessionKey, {
        sending: !shouldIdle,
        pendingImageGenerationLocal: false,
        pendingVideoGenerationLocal: false,
        activeRunId: shouldIdle ? null : runId,
        pendingFinal: !shouldIdle,
        lastUserMessageAt: shouldIdle ? null : get().lastUserMessageAt,
      });
      if (shouldIdle) markSessionRunIdle(sessionKey);
      if (get().currentSessionKey === sessionKey) {
        forceNextHistoryLoad(sessionKey);
        void get().loadHistory(true);
      } else {
        markSessionNeedsTerminalHistoryRefresh(sessionKey);
      }
    }).catch((error) => {
      if (isLocalRunCancelledError(error) || wasLocallyAbortedRun(runId)) return;
      applyMediaRuntimeFailure({ runId, sessionKey, error: error instanceof Error ? error.message : String(error) });
      commitSessionRunState(set, get, sessionKey, {
        sending: false,
        pendingImageGenerationLocal: false,
        pendingVideoGenerationLocal: false,
        activeRunId: null,
        pendingFinal: false,
        lastUserMessageAt: null,
      });
      markSessionRunIdle(sessionKey);
    });
  }
}

const COMPOSITE_RUN_POLL_INTERVAL_MS = 500;
const _observedCompositeRunIds = new Set<string>();
const _compositeRunObservers = new Map<string, Promise<CompositeRunRecord>>();
const _compositeRecoveryScans = new Map<string, Promise<void>>();

function compositeRunAttachedFiles(run: CompositeRunRecord): AttachedFileMeta[] {
  return dedupeAttachedFiles(run.artifacts.map((artifact) => ({
    fileName: artifact.title || artifact.filePath?.split(/[\\/]/u).pop() || 'artifact',
    mimeType: artifact.mimeType || 'application/octet-stream',
    fileSize: typeof artifact.sizeBytes === 'number' ? artifact.sizeBytes : 0,
    preview: null,
    filePath: artifact.filePath,
    gatewayUrl: artifact.url,
    source: 'tool-result' as const,
  })).filter((file) => Boolean(file.filePath || file.gatewayUrl)));
}

function compositeRunDeliveryMessage(run: CompositeRunRecord): string {
  const persistedText = run.delivery.text?.trim();
  if (persistedText) return persistedText;
  const completed = run.tasks.filter((task) => task.status === 'completed');
  const incomplete = run.tasks.filter((task) => task.status !== 'completed');
  const lines = [i18n.t('chat:runtimeDelivery.compositeSummary', {
    completedCount: completed.length,
    totalCount: run.tasks.length,
  })];
  if (incomplete.length > 0) {
    lines.push('', i18n.t('chat:runtimeDelivery.incompleteHeading'));
    lines.push(...incomplete.map((task) => (
      `- ${task.title}：${task.error || i18n.t('chat:runtimeDelivery.missingInputOrFailed')}`
    )));
  }
  if (completed.length > 0) {
    lines.push('', i18n.t('chat:runtimeDelivery.verificationComplete'));
  }
  return lines.join('\n');
}

function applyCompositeRunSnapshot(set: ChatSet, get: ChatGet, run: CompositeRunRecord): void {
  set((state) => ({
    runtimeRuns: applyRuntimeContractEvents(state.runtimeRuns, run.runtimeEvents ?? []),
  }));

  if (run.delivery.status !== 'succeeded' || !run.manifest) return;
  const messageId = run.delivery.assistantMessageId || `composite-result:${run.runId}`;
  const finalMessage: RawMessage = {
    role: 'assistant',
    content: compositeRunDeliveryMessage(run),
    timestamp: (run.delivery.persistedAt ?? run.updatedAt) / 1000,
    id: messageId,
    localArtifactResultKind: 'composite',
    compositeArtifactManifest: run.manifest,
    _attachedFiles: compositeRunAttachedFiles(run),
  };
  appendLocalMessageForSession(set, get, run.sessionKey, finalMessage);
}

function compositeRunTerminalForRenderer(run: CompositeRunRecord): boolean {
  if (run.delivery.status === 'succeeded' || run.delivery.status === 'failed') return true;
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
}

async function waitForCompositeRun(params: {
  set: ChatSet;
  get: ChatGet;
  runId: string;
  sessionKey: string;
  isCancelled?: () => boolean;
}): Promise<CompositeRunRecord> {
  const existingObserver = _compositeRunObservers.get(params.runId);
  if (existingObserver) return await existingObserver;

  const observer = (async (): Promise<CompositeRunRecord> => {
    _observedCompositeRunIds.add(params.runId);
    try {
      for (;;) {
        if (
          params.isCancelled?.()
          || wasLocallyAbortedRun(params.runId)
          || _sessionsCancelling.has(params.sessionKey)
        ) {
          throw new LocalRunCancelledError();
        }
        const response = await hostApiFetch<CompositeRunApiResponse>(
          `/api/composite-runs/${encodeURIComponent(params.runId)}`,
        );
        if (!response.success || !response.run) {
          throw new Error(response.error || 'Composite run not found');
        }
        applyCompositeRunSnapshot(params.set, params.get, response.run);
        if (compositeRunTerminalForRenderer(response.run)) return response.run;
        await sleep(COMPOSITE_RUN_POLL_INTERVAL_MS);
      }
    } finally {
      _observedCompositeRunIds.delete(params.runId);
    }
  })();
  _compositeRunObservers.set(params.runId, observer);
  try {
    return await observer;
  } finally {
    if (_compositeRunObservers.get(params.runId) === observer) {
      _compositeRunObservers.delete(params.runId);
    }
  }
}

function settleCompositeRunLifecycle(
  set: ChatSet,
  get: ChatGet,
  run: CompositeRunRecord,
): void {
  const deliveryFailed = run.delivery.status === 'failed';
  const taskFailure = run.tasks.find((task) => task.status === 'failed' || task.status === 'blocked');
  const runError = deliveryFailed
    ? (run.delivery.error || i18n.t('chat:runtimeDelivery.historySyncFailedDetail'))
    : (run.delivery.status === 'succeeded' ? null : taskFailure?.error || null);
  const settledActiveRun = commitSessionRunStateIfActiveRun(set, get, run.sessionKey, run.runId, {
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
  if (!settledActiveRun) return;
  if (get().currentSessionKey === run.sessionKey) {
    set({ runError });
  }
  markSessionRunIdle(run.sessionKey);
  clearPendingRuntimeIntent(run.sessionKey);
  if (run.delivery.status === 'succeeded') {
    if (get().currentSessionKey === run.sessionKey) {
      forceNextHistoryLoad(run.sessionKey);
      void get().loadHistory(true);
    } else {
      markSessionNeedsTerminalHistoryRefresh(run.sessionKey);
    }
  }
}

async function resumeCompositeRunsForSession(
  set: ChatSet,
  get: ChatGet,
  sessionKey: string,
): Promise<void> {
  const existingScan = _compositeRecoveryScans.get(sessionKey);
  if (existingScan) return await existingScan;

  const scan = (async (): Promise<void> => {
    if (_sessionsCancelling.has(sessionKey)) return;
    let response: CompositeRunApiResponse;
    try {
      response = await hostApiFetch<CompositeRunApiResponse>(
        `/api/composite-runs?sessionKey=${encodeURIComponent(sessionKey)}&activeOnly=true`,
      );
    } catch (error) {
      console.warn('[composite-run] failed to discover active runs:', error);
      return;
    }
    const runs = (response.runs ?? []).filter((run) => !_observedCompositeRunIds.has(run.runId));
    for (const run of runs) {
      applyCompositeRunSnapshot(set, get, run);
      const sessionState = get().currentSessionKey === sessionKey
        ? get()
        : _sessionRunStateCache.get(sessionKey);
      if (sessionState?.activeRunId == null || sessionState.activeRunId === run.runId) {
        commitSessionRunState(set, get, sessionKey, {
          sending: true,
          activeRunId: run.runId,
          pendingFinal: true,
        });
      }
      void waitForCompositeRun({
        set,
        get,
        runId: run.runId,
        sessionKey,
        isCancelled: () => wasLocallyAbortedRun(run.runId) || _sessionsCancelling.has(sessionKey),
      }).then((completed) => {
        if (!wasLocallyAbortedRun(run.runId)) settleCompositeRunLifecycle(set, get, completed);
      }).catch((error) => {
        if (isLocalRunCancelledError(error) || wasLocallyAbortedRun(run.runId)) return;
        const clearedActiveRun = commitSessionRunStateIfActiveRun(set, get, sessionKey, run.runId, {
          sending: false,
          activeRunId: null,
          pendingFinal: false,
        });
        if (!clearedActiveRun) return;
        if (get().currentSessionKey === sessionKey) {
          set({ runError: error instanceof Error ? error.message : String(error) });
        }
        markSessionRunIdle(sessionKey);
      });
    }
  })();
  _compositeRecoveryScans.set(sessionKey, scan);
  try {
    await scan;
  } finally {
    if (_compositeRecoveryScans.get(sessionKey) === scan) {
      _compositeRecoveryScans.delete(sessionKey);
    }
  }
}

function mediaOutputRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function mediaResultOutputs(result: unknown): Record<string, unknown>[] {
  const record = mediaOutputRecord(result);
  const outputs = Array.isArray(record?.outputs) ? record.outputs : [];
  return outputs
    .map(mediaOutputRecord)
    .filter((output): output is Record<string, unknown> => output !== null);
}

function mediaJobOutputs(job: MediaGenerationJobSnapshot | undefined): Record<string, unknown>[] {
  if (Array.isArray(job?.outputs) && job.outputs.length > 0) {
    return job.outputs
      .map(mediaOutputRecord)
      .filter((output): output is Record<string, unknown> => output !== null);
  }
  return mediaResultOutputs(job?.result);
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function basenameFromPathOrUrl(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return parsed.pathname.split('/').filter(Boolean).pop()?.split(/[?#]/)[0] || fallback;
    } catch {
      // Fall through to path parsing.
    }
  }
  return trimmed.split(/[\\/]/).pop()?.split(/[?#]/)[0] || fallback;
}

function attachedFilesFromMediaGenerationJob(
  job: MediaGenerationJobSnapshot | undefined,
  fallbackKind: 'image' | 'video',
): AttachedFileMeta[] {
  if (!job) return [];
  const files: AttachedFileMeta[] = [];
  const outputs = mediaJobOutputs(job);
  for (const [index, output] of outputs.entries()) {
    const path = typeof output.path === 'string' && output.path.trim() ? output.path.trim() : undefined;
    const url = typeof output.url === 'string' && output.url.trim() ? output.url.trim() : undefined;
    if (!path && !url) continue;
    const mimeType = typeof output.mimeType === 'string' && output.mimeType.trim()
      ? output.mimeType.trim()
      : (fallbackKind === 'image' ? 'image/png' : 'video/mp4');
    const size = typeof output.size === 'number' && Number.isFinite(output.size) && output.size > 0
      ? Math.floor(output.size)
      : 0;
    const title = typeof output.fileName === 'string' && output.fileName.trim()
      ? output.fileName.trim()
      : basenameFromPathOrUrl(path ?? url ?? '', `${fallbackKind}-${index + 1}`);
    files.push({
      fileName: title,
      mimeType,
      fileSize: size,
      preview: null,
      width: readPositiveNumber(output.width),
      height: readPositiveNumber(output.height),
      filePath: path,
      gatewayUrl: url,
      source: 'tool-result',
    });
  }
  return dedupeAttachedFiles(files);
}

function appendMediaGenerationResultMessage(params: {
  set: ChatSet;
  get: ChatGet;
  sessionKey: string;
  job: MediaGenerationJobSnapshot | undefined;
  kind: 'image' | 'video';
}): void {
  const attachedFiles = attachedFilesFromMediaGenerationJob(params.job, params.kind);
  if (attachedFiles.length === 0) return;
  const message: RawMessage = {
    role: 'assistant',
    content: params.kind === 'image' ? '图片已生成。' : '视频已生成。',
    timestamp: Date.now() / 1000,
    id: params.job?.id ? `media-result:${params.job.id}` : crypto.randomUUID(),
    _attachedFiles: attachedFiles,
  };
  appendLocalMessageForSession(params.set, params.get, params.sessionKey, message);
}

function isOptimisticMediaResultMessage(message: RawMessage): boolean {
  return message.role === 'assistant'
    && typeof message.id === 'string'
    && (message.id.startsWith('media-result:') || message.id.startsWith('composite-result:'))
    && (message._attachedFiles?.length ?? 0) > 0;
}

function preserveOptimisticMediaResultMessages(
  currentMessages: RawMessage[],
  loadedMessages: RawMessage[],
): RawMessage[] {
  const pendingMediaResults = currentMessages.filter(isOptimisticMediaResultMessage);
  if (pendingMediaResults.length === 0) return loadedMessages;

  const loadedAttachmentKeys = new Set(
    loadedMessages
      .flatMap((message) => message._attachedFiles ?? [])
      .map((file) => file.filePath || file.gatewayUrl || `${file.fileName}|${file.mimeType}|${file.fileSize}`)
      .filter(Boolean),
  );
  const loadedIds = new Set(loadedMessages.map((message) => message.id).filter(Boolean));
  const missingResults = pendingMediaResults.filter((message) => {
    if (message.id && loadedIds.has(message.id)) return false;
    const files = message._attachedFiles ?? [];
    return files.some((file) => {
      const key = file.filePath || file.gatewayUrl || `${file.fileName}|${file.mimeType}|${file.fileSize}`;
      return key && !loadedAttachmentKeys.has(key);
    });
  });
  if (missingResults.length === 0) return loadedMessages;
  return [...loadedMessages, ...missingResults].sort((left, right) => {
    const leftTs = typeof left.timestamp === 'number' ? toMs(left.timestamp) : 0;
    const rightTs = typeof right.timestamp === 'number' ? toMs(right.timestamp) : 0;
    return leftTs - rightTs;
  });
}

function buildMediaMetadataVerificationEvents(params: {
  runId: string;
  sessionKey: string;
  ts: number;
  job: MediaGenerationJobSnapshot | undefined;
  artifacts: ChatRuntimeArtifact[];
  kind: 'image' | 'video';
}): ChatRuntimeEvent[] {
  if (!params.job || params.artifacts.length === 0) return [];
  const outputs = mediaJobOutputs(params.job);
  return params.artifacts.flatMap((artifact, index): ChatRuntimeEvent[] => {
    const output = outputs[index];
    if (!output) return [];
    const width = readPositiveNumber(output.width);
    const height = readPositiveNumber(output.height);
    const rawDurationSeconds = typeof output.durationSeconds === 'number' && Number.isFinite(output.durationSeconds)
      ? output.durationSeconds
      : undefined;
    const durationSeconds = readPositiveNumber(output.durationSeconds);
    const metadata = mediaOutputRecord(output.metadata);
    const hasInvalidVideoDuration = params.kind === 'video'
      && rawDurationSeconds !== undefined
      && rawDurationSeconds <= 0;
    const hasExpectedMetadata = params.kind === 'image'
      ? Boolean(width || height || metadata)
      : Boolean(width || height || durationSeconds || metadata);
    const remoteOnlyArtifact = !artifact.filePath && Boolean(artifact.url);
    const details = [
      width && height ? `${Math.round(width)}x${Math.round(height)}` : undefined,
      durationSeconds ? `${durationSeconds}s` : undefined,
      metadata ? 'metadata present' : undefined,
    ].filter(Boolean).join('; ');
    const status = hasInvalidVideoDuration
      ? 'blocked'
      : (hasExpectedMetadata ? 'passed' : 'skipped');
    return [{
      contractVersion: 1,
      producer: 'media',
      runId: params.runId,
      sessionKey: params.sessionKey,
      ts: params.ts,
      type: 'verification.completed',
      toolCallId: params.job?.id,
      verification: {
        id: `verification:${artifact.id}:media.metadata`,
        status,
        kind: 'media.metadata',
        required: hasInvalidVideoDuration || remoteOnlyArtifact,
        severity: hasInvalidVideoDuration ? 'blocking' : (hasExpectedMetadata ? 'info' : 'warning'),
        title: params.kind === 'image' ? '图片元数据' : '视频元数据',
        detail: hasInvalidVideoDuration
          ? '视频生成结果返回的时长为 0 秒，暂不满足可播放交付条件。'
          : (details || '生成结果未返回可展示的媒体元数据。'),
        artifactId: artifact.id,
        targetId: artifact.id,
        evidence: JSON.stringify({
          width,
          height,
          durationSeconds,
          metadata,
        }),
        source: 'media-generation-job',
      },
    }];
  });
}

function buildMediaAvailabilityVerificationEvents(params: {
  runId: string;
  sessionKey: string;
  ts: number;
  artifacts: ChatRuntimeArtifact[];
  kind: 'image' | 'video';
}): ChatRuntimeEvent[] {
  return params.artifacts.flatMap((artifact): ChatRuntimeEvent[] => {
    const filePath = artifact.filePath?.trim();
    if (!filePath) return [];
    const hasVerifiedLocalFile = typeof artifact.sizeBytes === 'number' && artifact.sizeBytes > 0;
    return [buildRuntimeArtifactVerificationEvent({
      runId: params.runId,
      sessionKey: params.sessionKey,
      ts: params.ts,
      producer: 'media',
    }, {
      artifact,
      status: hasVerifiedLocalFile ? 'passed' : 'blocked',
      kind: 'artifact.availability',
      required: true,
      severity: hasVerifiedLocalFile ? 'info' : 'blocking',
      detail: hasVerifiedLocalFile
        ? (params.kind === 'image'
            ? '图片生成 job 已保存可读取的本地产物。'
            : '视频生成 job 已保存可读取的本地产物。')
        : '媒体生成返回了本地路径，但文件大小验证未通过。',
      evidence: `filePath=${filePath}; sizeBytes=${artifact.sizeBytes ?? 0}`,
    })];
  });
}

function gateDecisionAllowsTerminalIdle(decision: string | undefined): boolean {
  return decision === 'deliverable'
    || decision === 'blocked_needs_user'
    || decision === 'failed'
    || decision === 'aborted';
}

function applyMediaRuntimeFailure(params: {
  runId: string;
  sessionKey: string;
  error: string;
}): void {
  const ts = Date.now();
  useChatStore.setState((state) => ({
    runtimeRuns: applyRuntimeContractEvents(
      state.runtimeRuns,
      buildRuntimeCompletionGateEvents(state.runtimeRuns[params.runId], {
        runId: params.runId,
        sessionKey: params.sessionKey,
        ts,
        status: 'error',
        error: params.error,
      }),
    ),
  }));
}

function buildMediaRuntimeProgressEvents(params: {
  runId: string;
  sessionKey: string;
  job: MediaGenerationJobSnapshot | undefined;
}): ChatRuntimeEvent[] {
  const changedEvents = changedMediaProgressEvents(params.runId, params.job)
    .filter(shouldDisplayMediaProgress);
  if (changedEvents.length === 0) return [];
  const allProgressEvents = params.job?.progressEvents ?? [];
  return changedEvents.map((progress, fallbackIndex) => {
    const originalIndex = allProgressEvents.findIndex((item) => item.id === progress.id);
    const order = 10 + (originalIndex >= 0 ? originalIndex : fallbackIndex);
    return {
      runId: params.runId,
      sessionKey: params.sessionKey,
      producer: 'media',
      ts: progress.timestampMs || Date.now(),
      type: 'run.step.updated',
      step: {
        id: `media.${params.job?.id ?? 'job'}.${progress.id}`,
        title: progress.label,
        status: progress.status,
        detail: progress.detail,
        durationMs: progress.durationMs,
        kind: `media.${progress.source}.${progress.event}`,
        order,
        parentId: 'uclaw.execute',
      },
    } satisfies ChatRuntimeEvent;
  });
}

function applyMediaRuntimeProgress(params: {
  runId: string;
  sessionKey: string;
  job: MediaGenerationJobSnapshot | undefined;
}): void {
  const events = buildMediaRuntimeProgressEvents(params);
  if (events.length === 0) return;
  useChatStore.setState((state) => ({
    runtimeRuns: applyRuntimeContractEvents(state.runtimeRuns, events),
  }));
}

function applyMediaRuntimeSuccess(params: {
  runId: string;
  sessionKey: string;
  job: MediaGenerationJobSnapshot | undefined;
  kind: 'image' | 'video';
  stepId?: string;
  sourceToolCallId?: string;
  completeRun?: boolean;
}): { decision?: string; artifacts: ChatRuntimeArtifact[] } {
  const ts = Date.now();
  const completedAt = optionalToMs(params.job?.completedAt) ?? ts;
  const attachedFiles = attachedFilesFromMediaGenerationJob(params.job, params.kind);
  let artifacts: ChatRuntimeArtifact[] = [];
  let decision: string | undefined;
  useChatStore.setState((state) => {
    const artifactEvents = buildRuntimeArtifactEventsFromAttachedFiles({
      runId: params.runId,
      sessionKey: params.sessionKey,
      ts,
      producer: 'media',
      toolCallId: params.sourceToolCallId ?? params.job?.id,
      stepId: params.stepId,
      verificationDetail: params.kind === 'image'
        ? '图片生成 job 已返回产物输出。'
        : '视频生成 job 已返回产物输出。',
    }, attachedFiles);
    artifacts = artifactEvents
      .filter((runtimeEvent): runtimeEvent is Extract<ChatRuntimeEvent, { type: 'artifact.produced' }> =>
        runtimeEvent.type === 'artifact.produced')
      .map((runtimeEvent) => runtimeEvent.artifact);
    const metadataEvents = buildMediaMetadataVerificationEvents({
      runId: params.runId,
      sessionKey: params.sessionKey,
      ts,
      job: params.job,
      artifacts,
      kind: params.kind,
    });
    const availabilityEvents = buildMediaAvailabilityVerificationEvents({
      runId: params.runId,
      sessionKey: params.sessionKey,
      ts,
      artifacts,
      kind: params.kind,
    });
    let runtimeRuns = applyRuntimeContractEvents(
      state.runtimeRuns,
      [...artifactEvents, ...availabilityEvents, ...metadataEvents],
    );
    if (params.completeRun !== false) {
      runtimeRuns = applyRuntimeContractEvents(
        runtimeRuns,
        [
          ...buildRuntimeCompletionGateEvents(runtimeRuns[params.runId], {
            runId: params.runId,
            sessionKey: params.sessionKey,
            ts: completedAt,
            status: 'completed',
          }),
          {
            runId: params.runId,
            sessionKey: params.sessionKey,
            producer: 'media',
            ts: completedAt,
            type: 'run.ended' as const,
            endedAt: completedAt,
            status: 'completed' as const,
          },
        ],
      );
    }
    decision = runtimeRuns[params.runId]?.gateResult?.decision;
    return { runtimeRuns };
  });
  return { decision, artifacts };
}

function getActiveCompletionGateDecision(state: Pick<ChatState, 'activeRunId' | 'runtimeRuns'>): string | undefined {
  const runId = state.activeRunId;
  return runId ? state.runtimeRuns[runId]?.gateResult?.decision : undefined;
}

function applyHistoryCompletionGateForActiveRun(sessionKey: string): string | undefined {
  let decision: string | undefined;
  useChatStore.setState((state) => {
    const runId = state.activeRunId;
    if (!runId) return {};
    const runtimeRuns = applyRuntimeContractEvents(
      state.runtimeRuns,
      buildRuntimeCompletionGateEvents(state.runtimeRuns[runId], {
        runId,
        sessionKey,
        ts: Date.now(),
        status: 'completed',
      }),
    );
    decision = runtimeRuns[runId]?.gateResult?.decision;
    return { runtimeRuns };
  });
  return decision;
}

function shouldHoldActiveRunForCompletionGate(sessionKey: string): boolean {
  const currentState = useChatStore.getState();
  const activeRun = currentState.activeRunId
    ? currentState.runtimeRuns[currentState.activeRunId]
    : undefined;
  const decision = runtimeRunHasPendingAsyncTasks(activeRun)
    ? 'continue_required'
    : applyHistoryCompletionGateForActiveRun(sessionKey);
  if (decision !== 'continue_required') return false;
  useChatStore.setState((state) => ({
    messages: suppressPrematureAssistantFinals(state.messages, state.lastUserMessageAt),
    sending: true,
    activeRunId: state.activeRunId,
    pendingFinal: true,
    pendingImageGenerationLocal: false,
    pendingVideoGenerationLocal: false,
    streamingText: '',
    streamingMessage: null,
    runError: null,
  }));
  return true;
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
  return stripCompositeExecutionContractEnvelope(text)
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
    compositeTasks: intent.compositeTasks?.length ? intent.compositeTasks : undefined,
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
    nextRuns = applyRuntimeEventToRuns(nextRuns, event);
    if (event.type === 'progress.update') continue;
    const progressEvents = buildRuntimeProgressEvents(nextRuns[event.runId], event);
    for (const progressEvent of progressEvents) {
      nextRuns = applyRuntimeEventToRuns(nextRuns, progressEvent);
    }
  }
  return nextRuns;
}

function reevaluateWithheldFinalDelivery(runId: string): void {
  const withheld = _withheldFinalDeliveryByRun.get(runId);
  if (!withheld || wasLocallyAbortedRun(runId)) {
    _withheldFinalDeliveryByRun.delete(runId);
    return;
  }

  let released = false;
  let controlsActiveLifecycle = false;
  useChatStore.setState((state) => {
    const run = state.runtimeRuns[runId];
    if (!run || runtimeRunHasPendingAsyncTasks(run)) return {};
    const runtimeRuns = applyRuntimeContractEvents(
      state.runtimeRuns,
      buildRuntimeCompletionGateEvents(run, {
        runId,
        sessionKey: withheld.sessionKey,
        ts: Date.now(),
        status: 'completed',
      }),
    );
    const decision = runtimeRuns[runId]?.gateResult?.decision;
    if (!gateDecisionAllowsTerminalIdle(decision)) {
      return { runtimeRuns };
    }

    released = true;
    const isCurrentSession = state.currentSessionKey === withheld.sessionKey;
    controlsActiveLifecycle = isCurrentSession
      && (state.activeRunId === runId || (state.activeRunId == null && state.pendingFinal));
    const alreadyExists = state.messages.some((message) => message.id === withheld.message.id);
    return {
      runtimeRuns,
      ...(isCurrentSession && !alreadyExists
        ? { messages: [...state.messages, withheld.message] }
        : {}),
      ...(controlsActiveLifecycle
        ? {
            sending: false,
            activeRunId: null,
            pendingFinal: false,
            lastUserMessageAt: null,
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            pendingToolImages: [],
          }
        : {}),
    };
  });

  if (!released) return;
  _withheldFinalDeliveryByRun.delete(runId);
  clearPendingRuntimeIntent(withheld.sessionKey);
  if (controlsActiveLifecycle) markSessionRunIdle(withheld.sessionKey);
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
    compositeTasks?: MediaIntentCompositeTask[];
    ts?: number;
    includeStarted?: boolean;
  },
): ChatRuntimeEvent[] {
  if (!params.runId) return [];
  const intent = getPendingRuntimeIntent(params.sessionKey);
  const objective = params.objective ?? intent?.objective;
  const compositeTasks = params.compositeTasks ?? intent?.compositeTasks;
  const events = buildRuntimeStartContractEvents(runtimeRuns[params.runId], {
    runId: params.runId,
    sessionKey: params.sessionKey,
    objective,
    mode: params.mode ?? intent?.mode,
    ts: params.ts,
    includeStarted: params.includeStarted,
  });
  if ((compositeTasks?.length ?? 0) > 0 && !runtimeRuns[params.runId]?.planSteps?.some((step) => step.kind === 'composite-task')) {
    const baseTs = params.ts ?? Date.now();
    events.push({
      runId: params.runId,
      sessionKey: params.sessionKey,
      ts: baseTs,
      type: 'run.plan.updated',
      objective,
      summary: 'UClaw 已接管组合任务，将按顺序执行所有子任务并逐项交付产物。',
      steps: [
        {
          id: 'uclaw.objective',
          title: '理解组合目标',
          status: 'completed',
          detail: objective,
          kind: 'objective',
          order: 0,
        },
        {
          id: 'uclaw.composite',
          title: '执行组合任务',
          status: 'running',
          detail: '按合同顺序执行，不要求用户选择先做哪个。',
          kind: 'composite',
          order: 1,
        },
        ...compositeTasks!.map((task, index) => ({
          id: `uclaw.composite.${sanitizeCompositeTaskId(task.id, index)}`,
          title: task.title || `子任务 ${index + 1}`,
          status: 'pending' as const,
          detail: [
            `${compositeTaskKindLabel(task.kind)}：${task.prompt}`,
            describeCompositeTaskImages(task),
            '必须产出该子任务自己的可交付产物。',
          ].join('\n'),
          kind: 'composite-task',
          parentId: 'uclaw.composite',
          requiresArtifact: task.requiresArtifact !== false,
          order: 2 + index,
        })),
        {
          id: 'uclaw.verify',
          title: '验证每项产物',
          status: 'pending',
          kind: 'verification',
          order: 2 + compositeTasks!.length,
        },
        {
          id: 'uclaw.deliver',
          title: '交付组合结果',
          status: 'pending',
          kind: 'delivery',
          order: 3 + compositeTasks!.length,
        },
      ],
    });
  }
  return events;
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
          runtimeRuns: (() => {
            let runtimeRuns = applyRuntimeContractEvents(state.runtimeRuns, events);
            const run = runtimeRuns[runId];
            if (run?.status === 'completed') {
              runtimeRuns = applyRuntimeContractEvents(
                runtimeRuns,
                buildRuntimeCompletionGateEvents(run, {
                  runId,
                  sessionKey,
                  ts,
                  status: 'completed',
                }),
              );
            }
            return runtimeRuns;
          })(),
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
        runtimeRuns: (() => {
          let runtimeRuns = applyRuntimeContractEvents(state.runtimeRuns, events);
          const run = runtimeRuns[runId];
          if (run?.status === 'completed') {
            runtimeRuns = applyRuntimeContractEvents(
              runtimeRuns,
              buildRuntimeCompletionGateEvents(run, {
                runId,
                sessionKey,
                ts,
                status: 'completed',
              }),
            );
          }
          return runtimeRuns;
        })(),
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
          if (shouldTrustBackendSessionIdle(backendSession, get().lastUserMessageAt)) {
            _runtimeBackendIdleProbeGeneration.delete(sessionKey);
            reconcileCurrentSessionIdleFromBackend(set, get, latestSessions);
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

function beginSessionBackendIdleSettlement(sessionKey: string): void {
  const generation = (_sessionBackendIdleSettlementGeneration.get(sessionKey) ?? 0) + 1;
  _sessionBackendIdleSettlementGeneration.set(sessionKey, generation);
  _sessionsAwaitingBackendIdle.add(sessionKey);
  clearActiveSendGeneration(sessionKey);
  captureSessionRunState(sessionKey, DEFAULT_SESSION_RUN_STATE);
  if (useChatStore.getState().currentSessionKey === sessionKey) {
    useChatStore.setState(DEFAULT_SESSION_RUN_STATE);
  }

  void (async () => {
    const startedAt = Date.now();
    let delayMs = 50;
    while (
      _sessionBackendIdleSettlementGeneration.get(sessionKey) === generation
      && Date.now() - startedAt < 30_000
    ) {
      try {
        const data = await fetchChatSessionsList();
        if (gatewaySessionIsIdle(data, sessionKey)) break;
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
    markSessionRunIdle(sessionKey);
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
  _pendingCompositeClientRequestIdBySession.delete(sessionKey);
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
    if (next.compositeClientRequestId) {
      _pendingCompositeClientRequestIdBySession.set(sessionKey, next.compositeClientRequestId);
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

function commitSessionRunStateIfActiveRun(
  set: ChatSet,
  get: ChatGet,
  sessionKey: string,
  expectedRunId: string,
  patch: Partial<SessionRunState>,
): boolean {
  if (get().currentSessionKey === sessionKey) {
    let committed = false;
    set((state) => {
      if (state.currentSessionKey !== sessionKey || state.activeRunId !== expectedRunId) {
        return {};
      }
      committed = true;
      return patch;
    });
    return committed;
  }

  const cached = _sessionRunStateCache.get(sessionKey);
  if (!cached || cached.activeRunId !== expectedRunId) return false;
  captureSessionRunState(sessionKey, mergeSessionRunStatePatch(cached, patch));
  return true;
}

function appendLocalMessageForSession(
  set: ChatSet,
  get: ChatGet,
  sessionKey: string,
  message: RawMessage,
): void {
  if (get().currentSessionKey === sessionKey) {
    const state = get();
    const nextMessages = [...state.messages, message];
    set({ messages: nextMessages });
    cacheSessionHistory(sessionKey, nextMessages, state.thinkingLevel ?? null);
    return;
  }

  const cached = getCachedSessionHistory(sessionKey);
  cacheSessionHistory(
    sessionKey,
    [...(cached?.messages ?? []), message],
    cached?.thinkingLevel ?? null,
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
    stripCompositeExecutionContractEnvelope(text)
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
): AttachedFileMeta {
  if (looksLikeRemoteMediaUrl(ref.filePath)) {
    return {
      fileName: fileNameFromMediaRef(ref.filePath, ref.mimeType),
      mimeType: ref.mimeType,
      fileSize: 0,
      preview: null,
      gatewayUrl: ref.filePath,
      source,
    };
  }
  const cached = _imageCache.get(ref.filePath);
  if (cached) return { ...cached, filePath: ref.filePath, source };
  const fileName = fileNameFromMediaRef(ref.filePath, ref.mimeType);
  return { fileName, mimeType: ref.mimeType, fileSize: 0, preview: null, filePath: ref.filePath, source };
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

  return messages.map((msg, idx) => {
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

    // Path 2: Raw file paths.
    // For assistant messages: scan own text AND the nearest preceding user message text,
    // but only for non-tool-only assistant messages (i.e. the final answer turn).
    let rawRefs: Array<{ filePath: string; mimeType: string }> = [];
    if (msg.role === 'assistant' && !isToolOnlyMessage(msg)) {
      // Own text
      const ownRawRefs = extractRawFilePaths(text).filter(r => !mediaRefPaths.has(r.filePath));
      rawRefs = ownRawRefs;

      // Nearest preceding user message text (look back up to 5 messages)
      if (!ownRawRefs.some((ref) => ref.mimeType.startsWith('image/'))) {
        const seenPaths = new Set(rawRefs.map(r => r.filePath));
        for (let i = idx - 1; i >= Math.max(0, idx - 5); i--) {
          const prev = messages[i];
          if (!prev) break;
          if (prev.role === 'user') {
            const prevText = getMessageText(prev.content);
            for (const ref of extractRawFilePaths(prevText)) {
              if (!mediaRefPaths.has(ref.filePath) && !seenPaths.has(ref.filePath)) {
                seenPaths.add(ref.filePath);
                rawRefs.push(ref);
              }
            }
            break; // only use the nearest user message
          }
        }
      }
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
      .map(ref => makeAttachedFile(ref, 'message-ref'));
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
  thumbnails: Record<string, { preview: string | null; fileSize: number; filePath?: string; width?: number; height?: number }>,
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
      const thumbnails = await hostApiFetch<Record<string, { preview: string | null; fileSize: number; filePath?: string; width?: number; height?: number }>>(
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
  if (session.hasActiveRun === false) {
    return { idle: true, terminalStatus };
  }
  if (terminalStatus) {
    return { idle: true, terminalStatus };
  }
  return { idle: false };
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
  let nextRuns = applyRuntimeContractEvents(runtimeRuns, [{
    runId: runningRun.runId,
    sessionKey,
    ts,
    type: 'run.ended',
    status: terminalStatus,
  } satisfies ChatRuntimeEvent]);
  nextRuns = applyRuntimeContractEvents(
    nextRuns,
    buildRuntimeCompletionGateEvents(nextRuns[runningRun.runId], {
      runId: runningRun.runId,
      sessionKey,
      ts: nextRuns[runningRun.runId]?.endedAt ?? nextRuns[runningRun.runId]?.lastEventAt ?? ts,
      status: terminalStatus,
    }),
  );
  return nextRuns;
}

function reconcileCurrentSessionIdleFromBackend(
  set: (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
  sessions: ChatSession[],
): void {
  const state = get();
  if (!state.sending && state.activeRunId == null && !state.pendingFinal) return;
  const pendingAsyncRun = state.activeRunId
    ? state.runtimeRuns[state.activeRunId]
    : Object.values(state.runtimeRuns).find((run) => (
        run.sessionKey === state.currentSessionKey && runtimeRunHasPendingAsyncTasks(run)
      ));
  if (runtimeRunHasPendingAsyncTasks(pendingAsyncRun)) return;

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

async function sendChatMessageViaHostApi(params: {
  sessionKey: string;
  message: string;
  deliver?: boolean;
  idempotencyKey: string;
  thinking?: string | null;
  clientPreferences?: GatewayTurnPreferences;
}): Promise<{ runId?: string }> {
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
    return await useGatewayStore.getState().rpc<{ runId?: string }>('chat.send', params, CHAT_SEND_RPC_TIMEOUT_MS);
  }
}

async function abortChatRunViaHostApi(sessionKey: string): Promise<void> {
  try {
    const response = await hostApiFetch<{
      success: boolean;
      error?: string;
    }>('/api/chat/abort', {
      method: 'POST',
      body: JSON.stringify({ sessionKey }),
    });
    if (!response.success) {
      throw new Error(response.error || 'Failed to abort chat run');
    }
  } catch {
    await useGatewayStore.getState().rpc('chat.abort', { sessionKey });
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
    // Only actual image output disqualifies a tool-only message.
    // Thinking blocks are internal reasoning that can accompany tool_use  - they
    // should NOT prevent the message from being treated as an intermediate tool step.
    if (block.type === 'image') {
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

function isTextOnlyAssistantFinal(message: RawMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (hasPendingToolUse(message) || isToolOnlyMessage(message)) return false;
  if (!messageHasDeliverableContent(message)) return false;
  if ((message._attachedFiles ?? []).length > 0) return false;
  const text = getMessageText(message.content);
  if (extractMediaRefs(text).length > 0 || extractRawFilePaths(text).length > 0) return false;
  return !messageHasImageContent(message);
}

function suppressPrematureAssistantFinals(messages: RawMessage[], lastUserMessageAt: number | null): RawMessage[] {
  if (messages.length === 0) return messages;
  const userMsTs = lastUserMessageAt != null ? toMs(lastUserMessageAt) : null;
  const lastUserIndex = userMsTs == null
    ? (() => {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index].role === 'user') return index;
        }
        return -1;
      })()
    : -1;
  return messages.filter((message, index) => {
    if (!isTextOnlyAssistantFinal(message)) return true;
    const isAfterUser = userMsTs != null
      ? (message.timestamp != null && toMs(message.timestamp) >= userMsTs)
      : index > lastUserIndex;
    return !isAfterUser;
  });
}

function normalizeAssistantReplyForDedupe(message: RawMessage): string {
  if (!isTextOnlyAssistantFinal(message)) return '';
  if (isInternalMessage(message)) return '';
  return getMessageText(message.content)
    .replace(/\bMEDIA:\s*\S+/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function areRedundantAssistantReplies(left: RawMessage, right: RawMessage): boolean {
  const leftText = normalizeAssistantReplyForDedupe(left);
  const rightText = normalizeAssistantReplyForDedupe(right);
  if (!leftText || !rightText) return false;
  if (leftText === rightText) return true;
  const shorter = leftText.length <= rightText.length ? leftText : rightText;
  const longer = leftText.length > rightText.length ? leftText : rightText;
  return shorter.length >= 16 && longer.startsWith(shorter);
}

function mergeRedundantAssistantReplies(left: RawMessage, right: RawMessage): RawMessage {
  const leftText = normalizeAssistantReplyForDedupe(left);
  const rightText = normalizeAssistantReplyForDedupe(right);
  const keepRight = rightText.length >= leftText.length;
  const base = keepRight ? right : left;
  const attachedFiles = dedupeAttachedFiles([
    ...(left._attachedFiles ?? []),
    ...(right._attachedFiles ?? []),
  ]);
  return attachedFiles.length > 0 ? { ...base, _attachedFiles: attachedFiles } : base;
}

function dedupeRedundantAssistantReplies(messages: RawMessage[]): RawMessage[] {
  const result: RawMessage[] = [];
  let lastAssistantIndexInTurn = -1;

  for (const message of messages) {
    if (isRealUserBoundaryMessage(message)) {
      result.push(message);
      lastAssistantIndexInTurn = -1;
      continue;
    }

    if (message.role !== 'assistant' || !isTextOnlyAssistantFinal(message)) {
      result.push(message);
      continue;
    }

    if (
      lastAssistantIndexInTurn >= 0
      && areRedundantAssistantReplies(result[lastAssistantIndexInTurn]!, message)
    ) {
      result[lastAssistantIndexInTurn] = mergeRedundantAssistantReplies(
        result[lastAssistantIndexInTurn]!,
        message,
      );
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
      if (block.type === 'image') return true;
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

function dedupeAttachedFiles(files: AttachedFileMeta[]): AttachedFileMeta[] {
  const seen = new Set<string>();
  const next: AttachedFileMeta[] = [];
  for (const file of files) {
    const keys: string[] = [];
    const filePath = file.filePath?.trim();
    if (filePath) {
      keys.push(looksLikeRemoteMediaUrl(filePath) ? `url:${filePath}` : `path:${filePath}`);
    }
    const gatewayUrl = file.gatewayUrl?.trim();
    if (gatewayUrl) keys.push(`url:${gatewayUrl}`);
    if (keys.length === 0) {
      keys.push(`meta:${file.fileName}|${file.mimeType}|${file.fileSize}|${file.preview || ''}`);
    }
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
  const filePath = file.filePath?.trim();
  if (filePath) return `path:${filePath}`;
  const gatewayUrl = file.gatewayUrl?.trim();
  if (gatewayUrl) return `gateway:${gatewayUrl}`;
  return `meta:${file.fileName}|${file.mimeType}|${file.fileSize}|${file.preview || ''}`;
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
              label: s.label ? String(s.label) : undefined,
              displayName: s.displayName ? String(s.displayName) : undefined,
              derivedTitle: s.derivedTitle ? String(s.derivedTitle) : undefined,
              lastMessagePreview: s.lastMessagePreview ? String(s.lastMessagePreview) : undefined,
              thinkingLevel: s.thinkingLevel ? String(s.thinkingLevel) : undefined,
              model: buildSessionModelRef(s.model, s.modelProvider),
              cwd: typeof s.cwd === 'string' && s.cwd.trim() ? s.cwd.trim() : undefined,
              updatedAt: parseSessionUpdatedAtMs(s.updatedAt),
              status: parseSessionStatus(s.status),
              hasActiveRun: typeof s.hasActiveRun === 'boolean' ? s.hasActiveRun : undefined,
            };
            return mergeSessionRowWithLocalState(nextSession, localSessionByKey.get(nextSession.key));
          }).filter((s: ChatSession) => s.key && !isInternalTemporarySessionKey(s.key));

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
            const hasLocalPendingSession = localSessions.some((session) => session.key === nextSessionKey);
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
          reconcileCurrentSessionIdleFromBackend(set, get, sessionsWithCurrent);
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

      const applyLoadedMessages = (rawMessages: RawMessage[], thinkingLevel: string | null) => {
      // Guard: if the user switched sessions while this async load was in
      // flight, discard the result to prevent overwriting the new session's
      // messages with stale data from the old session.
      if (!isCurrentSession()) return false;

      // Before filtering: attach images/files from tool_result messages to the next assistant message
      const messagesWithToolImages = enrichWithToolResultFiles(rawMessages);
      const messagesWithToolAttachments = enrichWithToolCallAttachments(messagesWithToolImages);
      const filteredMessages = filterHistoryMessagesForUi(messagesWithToolAttachments);
      // Restore file attachments for user/assistant messages (from cache + text patterns)
      const enrichedMessages = dedupeRedundantAssistantReplies(enrichWithCachedImages(filteredMessages));
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
      finalMessages = preserveOptimisticMediaResultMessages(get().messages, finalMessages);
      finalMessages = preserveExistingAttachmentPreviews(get().messages, finalMessages);
      finalMessages = collapseSupersededCompositeHistoryReplies(finalMessages);
      finalMessages = dedupeRedundantAssistantReplies(finalMessages);

      const currentSessionRow = get().sessions.find((session) => session.key === currentSessionKey);
      const backendSessionIdle = shouldTrustBackendSessionIdle(currentSessionRow, get().lastUserMessageAt);
      const { pendingFinal, lastUserMessageAt, sending: isSendingNow } = get();
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
      const activeRuntimeRun = stateBeforeHistoryCommit.activeRunId
        ? stateBeforeHistoryCommit.runtimeRuns[stateBeforeHistoryCommit.activeRunId]
        : undefined;
      const hasPendingAsyncTask = runtimeRunHasPendingAsyncTasks(activeRuntimeRun);
      const hasConclusiveAssistantReply = openRunSegment.some((message) => (
        message.role === 'assistant'
        && !hasPendingToolUse(message)
        && messageHasDeliverableContent(message)
      ));
      const backendSessionCanClose = backendSessionIdle
        && !hasPendingAsyncTask
        && (!isSendingNow || hasConclusiveAssistantReply || Boolean(latestTerminalAssistantErrorMessage));
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

      let nextRuntimeRuns = applyHistoricalRuntimeRunsFromMessages(
        get().runtimeRuns,
        currentSessionKey,
        runtimeHistoryMessages,
      );
      nextRuntimeRuns = applyActiveRunArtifactEvidenceFromHistory(nextRuntimeRuns, {
        runId: stateBeforeHistoryCommit.activeRunId,
        sessionKey: currentSessionKey,
        messages: finalMessages,
        lastUserMessageAt: stateBeforeHistoryCommit.lastUserMessageAt,
      });
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

      set({
        messages: finalMessages,
        thinkingLevel,
        loading: false,
        runError: historyErrorIsTransient || terminalArtifactFallbackMessage
          ? null
          : normalizedTerminalAssistantErrorMessage,
        runtimeRuns: nextRuntimeRuns,
      });
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
        clearHistoryPoll();
        set({
          sending: false,
          pendingImageGenerationLocal: false,
          pendingVideoGenerationLocal: false,
          activeRunId: null,
          pendingFinal: false,
          lastUserMessageAt: null,
        });
        markSessionRunIdle(currentSessionKey);
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
          if (shouldHoldActiveRunForCompletionGate(currentSessionKey)) {
            return true;
          }
          clearHistoryPoll();
          set({
            sending: false,
            pendingImageGenerationLocal: false,
            pendingVideoGenerationLocal: false,
            activeRunId: null,
            pendingFinal: false,
            runError: null,
          });
          markSessionRunIdle(currentSessionKey);
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
          if (shouldHoldActiveRunForCompletionGate(currentSessionKey)) {
            return true;
          }
          clearHistoryPoll();
          set({
            sending: false,
            pendingImageGenerationLocal: false,
            pendingVideoGenerationLocal: false,
            activeRunId: null,
            pendingFinal: false,
            lastUserMessageAt: null,
            runError: null,
            streamingMessage: null,
            streamingText: '',
            streamingTools: [],
            pendingToolImages: [],
          });
          markSessionRunIdle(currentSessionKey);
        } else if (hasConclusiveReply && !segmentHasOpenToolRun(openSegment)) {
          if (shouldHoldActiveRunForCompletionGate(currentSessionKey)) {
            return true;
          }
          clearHistoryPoll();
          set({
            sending: false,
            pendingImageGenerationLocal: false,
            pendingVideoGenerationLocal: false,
            activeRunId: null,
            pendingFinal: false,
            lastUserMessageAt: null,
            runError: null,
          });
          markSessionRunIdle(currentSessionKey);
        }
        // Also unstick when all tool calls are resolved but the model's
        // terminal response was thinking-only (no visible content). The
        // `segmentHasOpenToolRun` update above detects this, but we still
        // need an explicit conclusive-reply fallback for the case where
        // hasConclusiveReply is false (thinking-only terminal turn).
        if (!hasConclusiveReply && !segmentHasOpenToolRun(openSegment) && openSegment.length > 0) {
          if (shouldHoldActiveRunForCompletionGate(currentSessionKey)) {
            return true;
          }
          clearHistoryPoll();
          set({
            sending: false,
            pendingImageGenerationLocal: false,
            pendingVideoGenerationLocal: false,
            activeRunId: null,
            pendingFinal: false,
            lastUserMessageAt: null,
            runError: null,
          });
          markSessionRunIdle(currentSessionKey);
        }
      }

      // After session switch the renderer may have reset run lifecycle flags even
      // though the Gateway is still executing a user-initiated turn. Re-arm only
      // when this session had an active cached run (e.g. user switched away
      // mid-send). Do not re-arm from stale :main heartbeat/tool history alone.
      if (!get().sending && !latestTerminalAssistantErrorMessage) {
        const cachedRunState = getCachedSessionRunState(currentSessionKey);
        const cachedOpenSegment = postUserSegmentMessages(filteredMessages);
        const shouldRearmFromCachedRun = (
          cachedRunState.sending
          || cachedRunState.activeRunId != null
          || cachedRunState.pendingFinal
        ) && segmentHasOpenToolRun(cachedOpenSegment);
        const inferredOpenRun = inferredHistoricalOpenRun;
        const shouldRearmFromInferredRun = inferredOpenRun != null && (
          !currentSessionKey.endsWith(':main')
          || shouldTrackInboundRunLifecycle({
            sending: false,
            activeRunId: null,
            pendingFinal: false,
            lastUserMessageAt: inferredOpenRun.lastUserMessageAt,
          }, currentSessionKey)
        );
        if (shouldRearmFromCachedRun || shouldRearmFromInferredRun) {
          _lastChatEventAt = Date.now();
          set({
            sending: true,
            activeRunId: shouldRearmFromInferredRun ? inferredOpenRun!.runId : cachedRunState.activeRunId,
            pendingFinal: true,
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
        && getActiveCompletionGateDecision(get()) !== 'continue_required'
        && !shouldTrackInboundRunLifecycle(get(), currentSessionKey)
      ) {
        clearHistoryPoll();
        set({
          sending: false,
          pendingImageGenerationLocal: false,
          pendingVideoGenerationLocal: false,
          activeRunId: null,
          pendingFinal: false,
          lastUserMessageAt: null,
        });
        markSessionRunIdle(currentSessionKey);
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

        const applied = applyLoadedMessages(fallbackMessages, null);
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

        for (let attempt = 0; attempt <= CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS.length; attempt += 1) {
          if (!isCurrentSession()) {
            break;
          }

          try {
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

          const applied = applyLoadedMessages(rawMessages, thinkingLevel);
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
            ? applyLoadedMessages(fallbackMessages, null)
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
      if (get().currentSessionKey === currentSessionKey) {
        void resumeCompositeRunsForSession(set, get, currentSessionKey);
        void resumeStandaloneMediaJobsForSession(set, get, currentSessionKey);
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
      const enrichedMessages = dedupeRedundantAssistantReplies(enrichWithCachedImages(filteredMessages));
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
    const retriedCompositeClientRequestId = _pendingCompositeClientRequestIdBySession.get(targetSessionKey);
    _pendingCompositeClientRequestIdBySession.delete(targetSessionKey);

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
        compositeClientRequestId: retriedCompositeClientRequestId,
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
        compositeClientRequestId: retriedCompositeClientRequestId,
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
      compositeClientRequestId: retriedCompositeClientRequestId,
      enqueuedAt: Date.now(),
    });

    const currentSessionKey = targetSessionKey;
    const currentMessages = get().messages;
    const explicitPendingImages = (attachments ?? [])
      .filter((file) => file.mimeType.startsWith('image/') && file.stagedPath.trim().length > 0)
      .map((file) => ({
        fileName: file.fileName,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        stagedPath: file.stagedPath,
        preview: file.preview,
      }));

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

    const referencesPriorImage = mode === 'image' || mode === 'video';
    let candidateImageInputs = referencesPriorImage
      ? resolveImageModeReferenceInputs([], currentMessages)
      : [];
    if (referencesPriorImage && candidateImageInputs.length === 0 && explicitPendingImages.length === 0) {
      candidateImageInputs = await loadFamilyImageReferenceInputs(currentSessionKey, trimmed, mode);
    }
    if (!sendGenerationIsCurrent()) return;
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

    // Every new turn belongs to the native OpenClaw agent loop. The legacy
    // planner/composite coordinator remains only for already-started jobs;
    // it must not turn a fresh user message into a synthetic user contract.
    const gatewayReferenceImages = referencesPriorImage ? candidateImageInputs : [];
    const compositeTasks: MediaIntentCompositeTask[] | undefined = undefined;
    const runtimeMessage = trimmed;
    const effectiveMode: ChatSendMode = mode;
    rememberPendingRuntimeIntent(currentSessionKey, {
      objective: trimmed,
      mode: effectiveMode,
      compositeTasks,
    });
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
      const noResponseEvents = noResponseRunId
        ? [
            buildRuntimeCheckpointEvent({
              runId: noResponseRunId,
              sessionKey: currentSessionKey,
              ts: Date.now(),
              id: `checkpoint:${noResponseRunId}:no-response`,
              summary: '执行侧长时间没有产生新的可见进展。',
              reason: buildNoResponseSafetyMessage(),
              recoverable: true,
            }),
            {
              runId: noResponseRunId,
              sessionKey: currentSessionKey,
              ts: Date.now(),
              type: 'run.ended' as const,
              status: 'error' as const,
              error: buildNoResponseSafetyMessage(),
              stopReason: 'no_response_safety_timeout',
            },
          ]
        : [];
      set({
        runtimeRuns: applyRuntimeContractEvents(state.runtimeRuns, noResponseEvents),
        error: buildNoResponseSafetyMessage(),
        sending: false,
        pendingImageGenerationLocal: false,
        pendingVideoGenerationLocal: false,
        activeRunId: null,
        lastUserMessageAt: null,
        pendingFinal: false,
        streamingMessage: null,
        streamingText: '',
      });
      markSessionRunIdle(currentSessionKey);
      clearPendingRuntimeIntent(currentSessionKey);
    };
    setTimeout(checkStuck, 30_000);

    const applySendFailure = (errorMsg: string) => {
      const latest = get();
      const sendStillCurrent = _activeSendGenerationBySession.get(currentSessionKey) === sendGeneration;
      const canApplyToCurrentSession = latest.currentSessionKey === currentSessionKey
        && latest.lastUserMessageAt === nowMs;

      if (sendStillCurrent && canApplyToCurrentSession) {
        clearSendGenerationIfCurrent();
        clearHistoryPoll();
        set({ error: errorMsg, sending: false });
        markSessionRunIdle(currentSessionKey);
        return;
      }

      if (sendStillCurrent && latest.currentSessionKey !== currentSessionKey) {
        const cached = _sessionRunStateCache.get(currentSessionKey);
        if (cached?.lastUserMessageAt === nowMs) {
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
      const idempotencyKey = crypto.randomUUID();
      const thinkingLevel = get().thinkingLevel ?? undefined;
      const chatMediaAttachments = compositeTasks
        ? []
        : mergeGatewayImageReferences(attachments, gatewayReferenceImages);
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
          console.warn(`[sendMessage] Recoverable chat.send timeout, keeping poll alive: ${errorMsg}`);
        } else {
          applySendFailure(errorMsg);
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
      const errStr = String(err);
      if (isRecoverableChatSendTimeout(errStr)) {
        console.warn(`[sendMessage] Recoverable chat.send timeout, keeping poll alive: ${errStr}`);
      } else {
        applySendFailure(errStr);
      }
    }
  },

  // ── Abort active run ──

  abortRun: async () => {
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    const { currentSessionKey, activeRunId } = get();
    _sessionsCancelling.add(currentSessionKey);
    _activeSendGenerationBySession.delete(currentSessionKey);
    rememberLocallyAbortedRun(activeRunId);
    set({
      runtimeRuns: activeRunId
        ? applyRuntimeContractEvents(
            get().runtimeRuns,
            [
              buildRuntimeCheckpointEvent({
                runId: activeRunId,
                sessionKey: currentSessionKey,
                ts: Date.now(),
                id: `checkpoint:${activeRunId}:user-abort`,
                summary: '用户停止了当前任务。',
                recoverable: true,
              }),
              {
                runId: activeRunId,
                sessionKey: currentSessionKey,
                ts: Date.now(),
                type: 'run.ended',
                status: 'aborted',
              } satisfies ChatRuntimeEvent,
            ],
          )
        : get().runtimeRuns,
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
    });
    set({ streamingTools: [] });
    clearPendingRuntimeIntent(currentSessionKey);

    try {
      if (activeRunId) {
        await hostApiFetch<CompositeRunApiResponse>(
          `/api/composite-runs/${encodeURIComponent(activeRunId)}/cancel`,
          { method: 'POST', body: JSON.stringify({ source: 'chat_composer_stop' }) },
        ).catch((err) => {
          console.warn('[abortRun] Failed to cancel composite run:', err);
        });
      }
      await cancelMediaGenerationJobs({ sessionKey: currentSessionKey, runId: activeRunId ?? undefined });
    } catch (err) {
      console.warn('[abortRun] Failed to cancel local media jobs:', err);
    }

    try {
      await abortChatRunViaHostApi(currentSessionKey);
    } catch (err) {
      set({ error: String(err) });
    } finally {
      _sessionsCancelling.delete(currentSessionKey);
      markSessionRunIdle(currentSessionKey);
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
    if (previous.compositeClientRequestId) {
      _pendingCompositeClientRequestIdBySession.set(sessionKey, previous.compositeClientRequestId);
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
    const runId = String(event.runId || '');
    if (wasLocallyAbortedRun(runId)) return;
    const eventState = String(event.state || '');
    const rawEventSessionKey = event.sessionKey != null ? String(event.sessionKey) : null;
    const initialState = get();
    const eventSessionKey = inferSessionKeyForRun(initialState, runId || null, rawEventSessionKey);
    const { activeRunId, currentSessionKey } = initialState;
    const terminalEvent = eventState === 'final'
      || eventState === 'error'
      || eventState === 'aborted'
      || (event.message && typeof event.message === 'object'
        && getMessageStopReason(event.message as Record<string, unknown>) != null);
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
              sending: false,
              pendingImageGenerationLocal: false,
              pendingVideoGenerationLocal: false,
              activeRunId: null,
              pendingFinal: false,
              streamingTools: [],
              pendingToolImages: [],
            });
            clearHistoryPoll();
            markSessionRunIdle(sessionKeyForReload);
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
          let terminalGateDecision: string | undefined;
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
            const knownArtifacts = currentRuntimeRun?.artifacts ?? [];
            const hasSuccessfulExecutionEvidence = (currentRuntimeRun?.events ?? []).some((runtimeEvent) => (
              (runtimeEvent.type === 'tool.completed' && runtimeEvent.isError !== true)
              || (runtimeEvent.type === 'command.output'
                && (typeof runtimeEvent.exitCode !== 'number' || runtimeEvent.exitCode === 0))
              || runtimeEvent.type === 'patch.completed'
              || runtimeEvent.type === 'artifact.produced'
            ));
            const synthesizedFinalText = isEmptyTerminalResponse
              ? ((pendingImgs.length > 0 || knownArtifacts.length > 0)
                  ? i18n.t('chat:executionGraph.compact.artifactDone')
                  : (hasSuccessfulExecutionEvidence ? i18n.t('chat:executionGraph.compact.done') : ''))
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
            if (runId && clearLifecycle && !toolOnly) {
              runtimeRuns = applyRuntimeContractEvents(
                runtimeRuns,
                [
                  ...buildRuntimeCompletionGateEvents(runtimeRuns[runId], {
                    runId,
                    sessionKey: eventSessionKey ?? currentSessionKey,
                    ts: Date.now(),
                    status: emptyTerminalFailure ? 'error' : 'completed',
                    ...(emptyTerminalFailure ? { error: emptyTerminalFailure } : {}),
                  }),
                  ...(emptyTerminalFailure ? [{
                    runId,
                    sessionKey: eventSessionKey ?? currentSessionKey,
                    ts: Date.now(),
                    type: 'run.ended' as const,
                    status: 'error' as const,
                    error: emptyTerminalFailure,
                    stopReason: 'empty_final_delivery',
                  }] : []),
                ],
              );
              terminalGateDecision = runtimeRuns[runId]?.gateResult?.decision;
            }
            const shouldHoldForContinuation = clearLifecycle
              && !toolOnly
              && (terminalGateDecision === 'continue_required' || hasPendingAsyncTask);
            const shouldClearTerminalLifecycle = clearLifecycle
              && !toolOnly
              && !hasPendingAsyncTask
              && (!terminalGateDecision || gateDecisionAllowsTerminalIdle(terminalGateDecision));
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
                sending: false,
                activeRunId: null,
                pendingFinal: false,
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
                sending: shouldClearTerminalLifecycle ? false : s.sending,
                activeRunId: shouldClearTerminalLifecycle ? null : s.activeRunId,
                pendingFinal: shouldClearTerminalLifecycle ? false : true,
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
              sending: shouldClearTerminalLifecycle ? false : s.sending,
              activeRunId: shouldClearTerminalLifecycle ? null : s.activeRunId,
              pendingFinal: shouldClearTerminalLifecycle ? false : true,
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
          // After the final response, quietly reload history to surface all intermediate
          // tool-use turns (thinking + tool blocks) from the Gateway's authoritative record.
          // Also reload for empty terminal responses (thinking-only) so the
          // delayed follow-up can pick up the Gateway's `assistant-media`
          // bubble that may still be getting written.
          const shouldIdleAfterGate = !terminalGateDecision || gateDecisionAllowsTerminalIdle(terminalGateDecision);
          if (clearLifecycle && !toolOnly && shouldIdleAfterGate) {
            const sessionKeyAtFinal = eventSessionKey ?? currentSessionKey;
            clearHistoryPoll();
            beginSessionBackendIdleSettlement(sessionKeyAtFinal);
            markSessionNeedsTerminalHistoryRefresh(sessionKeyAtFinal);
            clearPendingRuntimeIntent(sessionKeyAtFinal);
            void get().loadHistory(true);

            // OpenClaw's gateway processes `MEDIA:/path` markers in the
            // assistant reply asynchronously, in the `dispatch.deliver` of
            // the `final` payload (see openclaw/dist/chat-DM9hSaNV.js's
            // `appendWebchatAgentMediaTranscriptIfNeeded`):
            //   1. copy the original file under
            //      `~/.openclaw/media/outgoing/originals/<uuid>`
            //   2. write the record JSON under
            //      `~/.openclaw/media/outgoing/records/<id>.json`
            //   3. `appendAssistantTranscriptMessage` writes a follow-up
            //      `assistant-media` message to the session JSONL, with
            //      `idempotencyKey: "<runId>:assistant-media"`.
            // That follow-up message is **only persisted**  - it is NOT
            // re-broadcast as a streaming event. The streaming `final`
            // we just consumed only contains the agent's text. The
            // assistant-media bubble can only be retrieved via
            // `chat.history`, and the persistence runs on the order of
            // ~400-500ms after the streaming final.
            //
            // The immediate `loadHistory(true)` above therefore races the
            // gateway's write and almost always misses the bubble.
            //
            // CRITICAL: we cannot detect from the streaming final alone
            // whether the agent emitted a `MEDIA:/path` marker  - OpenClaw's
            // `splitTrailingDirective` (selection-D8_ELZa7.js line ~904)
            // strips `MEDIA:/...` lines from the broadcast text BEFORE it
            // reaches the client, so the streaming `final` text is always
            // the user-facing prose without the marker. The MEDIA: marker
            // only appears in the persisted JSONL transcript (msg N) and
            // its companion `assistant-media` bubble (msg N+1).
            //
            // We therefore unconditionally schedule ONE follow-up quiet
            // reload ~1500ms after every assistant `final`. The cost is
            // a single extra in-process RPC per assistant turn (cheap);
            // when there's no media the second reload returns the same
            // history snapshot and is a no-op for the UI.
            // `forceNextHistoryLoad` bypasses `HISTORY_LOAD_MIN_INTERVAL_MS`
            // so the call is not suppressed by the throttle.
            setTimeout(() => {
              if (get().currentSessionKey !== sessionKeyAtFinal) {
                return;
              }
              forceNextHistoryLoad(sessionKeyAtFinal);
              void get().loadHistory(true);
            }, 1500);
          }
        } else {
          const sessionKeyAtFinal = eventSessionKey ?? currentSessionKey;
          const latestState = get();
          const terminalRunId = runId || latestState.activeRunId;
          const terminalRun = terminalRunId ? latestState.runtimeRuns[terminalRunId] : undefined;
          const hasPendingAsyncTask = runtimeRunHasPendingAsyncTasks(terminalRun);
          const backendAlreadyTerminal = Boolean(terminalRun && terminalRun.status !== 'running');
          const lifecycleAlreadyIdle = !latestState.sending
            && latestState.activeRunId == null
            && !latestState.pendingFinal;
          if (lifecycleAlreadyIdle || (backendAlreadyTerminal && !hasPendingAsyncTask)) {
            set({
              streamingText: '',
              streamingMessage: null,
              streamingTools: [],
              sending: false,
              activeRunId: null,
              pendingFinal: false,
              lastUserMessageAt: null,
            });
            markSessionRunIdle(sessionKeyAtFinal);
            clearPendingRuntimeIntent(sessionKeyAtFinal);
          } else {
            set({ streamingText: '', streamingMessage: null, pendingFinal: true });
          }
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
          const errorSnapshot = snapshotStreamingAssistantMessage(
            currentStream,
            get().messages,
            `error-${runId || Date.now()}`,
          );
          if (errorSnapshot.length > 0) {
            set((s) => ({
              messages: [...s.messages, ...errorSnapshot],
            }));
          }

          set({
            runtimeRuns: runId
              ? applyRuntimeContractEvents(
                  get().runtimeRuns,
                  [
                    ...buildRuntimeCompletionGateEvents(get().runtimeRuns[runId], {
                      runId,
                      sessionKey: sessionKeyAtError,
                      ts: Date.now(),
                      status: 'error',
                      error: normalizedErrorMsg,
                    }),
                    {
                      runId,
                      sessionKey: sessionKeyAtError,
                      ts: Date.now(),
                      type: 'run.ended',
                      status: 'error',
                      error: normalizedErrorMsg,
                    } satisfies ChatRuntimeEvent,
                  ],
                )
              : get().runtimeRuns,
            error: terminalAssistantError || replySessionInitConflict ? null : normalizedErrorMsg,
            runError: terminalAssistantError || replySessionInitConflict ? normalizedErrorMsg : null,
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
                [
                  ...buildRuntimeCompletionGateEvents(get().runtimeRuns[runId], {
                    runId,
                    sessionKey: eventSessionKey ?? currentSessionKey,
                    ts: Date.now(),
                    status: 'aborted',
                  }),
                  {
                    runId,
                    sessionKey: eventSessionKey ?? currentSessionKey,
                    ts: Date.now(),
                    type: 'run.ended',
                    status: 'aborted',
                  } satisfies ChatRuntimeEvent,
                ],
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
    if (wasLocallyAbortedRun(event.runId)) return;
    const initialState = get();
    const { activeRunId, currentSessionKey } = initialState;
    const eventSessionKey = inferSessionKeyForRun(initialState, event.runId, event.sessionKey ?? null);
    const eventForSession: ChatRuntimeEvent = eventSessionKey && event.sessionKey !== eventSessionKey
      ? { ...event, sessionKey: eventSessionKey }
      : event;
    const matchesCurrentSession = eventSessionKey != null && eventSessionKey === currentSessionKey;
    const matchesActiveRun = activeRunId != null && event.runId === activeRunId;
    const matchesActiveTurn = runtimeEventBelongsToActiveTurn(initialState, eventForSession, eventSessionKey);

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
    const nextPatch: Partial<ChatState> = { runtimeRuns };
    const appliesToActiveUi = matchesActiveRun || matchesActiveTurn || (activeRunId == null && matchesCurrentSession);
    let completedToolFiles: AttachedFileMeta[] = [];

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
      runtimeRuns = applyRuntimeContractEvents(
        runtimeRuns,
        buildRuntimeCompletionGateEvents(runtimeRuns[eventForSession.runId], {
          runId: eventForSession.runId,
          sessionKey: eventSessionKey ?? (appliesToActiveUi ? currentSessionKey : undefined),
          ts: eventForSession.endedAt ?? eventForSession.ts ?? Date.now(),
          status: eventForSession.status,
          error: eventForSession.error,
        }),
      );
      nextPatch.runtimeRuns = runtimeRuns;
      const terminalGateDecision = runtimeRuns[eventForSession.runId]?.gateResult?.decision;
      if (terminalGateDecision === 'continue_required') {
        if (appliesToActiveUi) {
          nextPatch.pendingFinal = true;
        }
      } else {
        clearPendingRuntimeIntent(eventSessionKey);
      }
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
        const terminalGateDecision = runtimeRuns[eventForSession.runId]?.gateResult?.decision;
        const shouldHoldForContinuation = terminalGateDecision === 'continue_required'
          || runtimeRunHasPendingAsyncTasks(runtimeRuns[eventForSession.runId]);
        const shouldAwaitFinalDelivery = eventForSession.status === 'completed' && !shouldHoldForContinuation;
        const shouldKeepLifecycle = shouldHoldForContinuation || shouldAwaitFinalDelivery;
        nextPatch.sending = shouldKeepLifecycle;
        nextPatch.activeRunId = shouldKeepLifecycle ? eventForSession.runId : null;
        nextPatch.pendingFinal = shouldKeepLifecycle;
        nextPatch.lastUserMessageAt = shouldKeepLifecycle ? latestState.lastUserMessageAt : null;
        nextPatch.streamingTools = shouldKeepLifecycle ? latestState.streamingTools : [];
        if (eventForSession.status === 'error' && eventForSession.error) {
          nextPatch.error = null;
          nextPatch.runError = normalizeChatRunErrorMessage(eventForSession.error);
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
        } else if (matchesCurrentSession) {
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
