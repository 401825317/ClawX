import { create } from 'zustand';
import type {
  AcpChatLoadPayload,
  AcpChatOperationResult,
  AcpChatPromptPayload,
  AcpChatRespondPermissionPayload,
  AcpPermissionRequestEnvelope,
  AcpSessionUpdateEnvelope,
} from '@shared/acp-chat/types';
import type {
  MediaThumbnailResult,
  ResolveAttachmentPayload,
  ResolveAttachmentResult,
} from '@shared/host-api/contract';
import { UCLAW_VIDEO_GENERATION_TIMEOUT_MS } from '@shared/junfeiai-endpoints';
import i18n from '@/i18n';
import {
  extractImageGenerationCompletionFromAcpEnvelope,
  extractImageGenerationCompletionFromGatewayChatMessage,
  extractImageGenerationCompletionFromRuntimeEvent,
  extractImageGenerationStartFromAcpEnvelope,
  imageGenerationEvidenceKey,
  type ImageGenerationCompletionEvidence,
  type ImageGenerationMediaCandidate,
  type ImageGenerationTaskStart,
} from '@/lib/acp/image-generation-compat';
import {
  extractVideoGenerationStartFromAcpEnvelope,
  extractVideoGenerationTerminalTaskIdFromAcpEnvelope,
  extractVideoGenerationTerminalTaskIdFromGatewayChatMessage,
  extractVideoGenerationTerminalTaskIdFromRuntimeEvent,
} from '@/lib/acp/video-generation-status';
import {
  applyAttachmentResolution,
  attachmentRequestFingerprint,
  collectPendingAttachments,
  createPendingAttachment,
  dedupeTimelineAttachments,
  type PendingAttachmentLocation,
} from '@/lib/acp/attachments';
import {
  appendSyntheticAssistantMessage,
  applyAcpSessionUpdate,
  createEmptyAcpTimeline,
  upsertSyntheticTurnAttachments,
} from '@/lib/acp/reducer';
import { hashOpenClawMediaDiagnostic, type OpenClawMediaCandidate } from '@/lib/acp/openclaw-media-compat';
import { openClawResourceLinkPromptText } from '@/lib/acp/openclaw-prompt-compat';
import { fetchOpenClawTranscriptSupplement } from '@/lib/acp/transcript-supplement';
import { alignHistoricalTurnTimings, type AcpTurnTiming } from '@/lib/acp/turn-timings';
import { hostApi } from '@/lib/host-api';
import { hostEvents } from '@/lib/host-events';
import type {
  AcpTimelineSnapshot,
  MessageSegmentItem,
  PermissionItem,
  RenderPart,
  TimelineItem,
} from '@/lib/acp/timeline-types';

const EMPTY_SESSION_ID = '';
const CANCEL_PERMISSION_OPTION_ID = '__cancelled__';
const IMAGE_GENERATION_COMPAT_WINDOW_MS = 195_000;
const IMAGE_GENERATION_TRANSCRIPT_RETRY_DELAYS_MS = [1500, 3000, 5000, 8000, 13_000, 21_000, 30_000, 30_000, 30_000, 30_000];
const VIDEO_GENERATION_PENDING_TIMEOUT_MS = UCLAW_VIDEO_GENERATION_TIMEOUT_MS + 15_000;
const VIDEO_GENERATION_TRANSCRIPT_RETRY_DELAYS_MS = [500, 1500, 3000, 5000, 8000];

type ImageGenerationCompatSession = {
  taskStartedAt: number;
  replayTaskStartedAt: number;
  taskIds: Set<string>;
  replayTaskIds: Set<string>;
  taskToolCallIds: Map<string, string>;
  replayTaskToolCallIds: Map<string, string>;
  lastTaskToolCallId?: string;
  lastReplayToolCallId?: string;
  lastTaskId?: string;
  lastReplayTaskId?: string;
  delivered: Set<string>;
  reservations: Map<string, string>;
  authoritativeCaptions: Map<string, { text: string; priority: number }>;
  syntheticCompletions: Map<string, { taskId: string; afterItemId: string; createdAt: number }>;
};

const imageGenerationCompatSessions = new Map<string, ImageGenerationCompatSession>();
const pendingLoadUpdates = new Map<number, AcpSessionUpdateEnvelope[]>();
type LiveSessionSnapshot = {
  sessionKey: string;
  workspaceRoot: string | null;
  cwd: string | null;
  generation: number;
  sending: boolean;
  pendingImageGenerationTaskIds: string[];
  pendingVideoGenerationTaskIds: string[];
  timeline: AcpTimelineSnapshot;
  turnTimingsByUserMessageId: Record<string, AcpTurnTiming>;
  deferredImageUpdates: Array<{ key: string; event: AcpSessionUpdateEnvelope }>;
  deferredImageCompletions: Array<{
    key: string;
    evidence: ImageGenerationCompletionEvidence;
  }>;
};
const liveSessionSnapshots = new Map<string, LiveSessionSnapshot>();
const videoGenerationTaskTimers = new Map<string, ReturnType<typeof setTimeout>>();
let loadRequestSeq = 0;
const attachmentResolutionsInFlight = new Set<string>();

function deferInactiveImageUpdate(
  snapshot: LiveSessionSnapshot,
  event: AcpSessionUpdateEnvelope,
): LiveSessionSnapshot {
  const start = extractImageGenerationStartFromAcpEnvelope(event);
  const evidence = extractImageGenerationCompletionFromAcpEnvelope(event);
  if (!start && !evidence) return snapshot;
  const key = start
    ? `start:${start.taskId}:${event.historical ? 'history' : 'live'}`
    : `completion:${imageGenerationEvidenceKey(evidence!)}`;
  const existingIndex = snapshot.deferredImageUpdates.findIndex((entry) => entry.key === key);
  const deferredImageUpdates = [...snapshot.deferredImageUpdates];
  const entry = { key, event };
  if (existingIndex >= 0) deferredImageUpdates[existingIndex] = entry;
  else deferredImageUpdates.push(entry);
  return { ...snapshot, deferredImageUpdates };
}

type TranscriptSupplementOperation = {
  id: number;
  sessionKey: string;
  generation: number;
  attempt: number;
  retryIndex: number;
  imageTaskIds: Set<string>;
  completedTaskIds: Set<string>;
  videoTaskIds: Set<string>;
  completedVideoTaskIds: Set<string>;
  videoRetryIndex: number;
  videoRetryEpoch: number;
  started: boolean;
  terminal: boolean;
  liveUserMessageId?: string;
  retryTimer?: ReturnType<typeof setTimeout>;
  videoRetryTimer?: ReturnType<typeof setTimeout>;
};

let transcriptSupplementSeq = 0;
let activeTranscriptSupplement: TranscriptSupplementOperation | null = null;
let imageProjectionSeq = 0;

type ImageGenerationProjectionOptions = {
  isCurrent?: () => boolean;
  staleReason?: string;
  transcriptMessageId?: string;
  reservationOwner?: string;
};

type PermissionOutcome = AcpChatRespondPermissionPayload['outcome'];

export type AcpChatSessionState = {
  activeSessionKey: string | null;
  workspaceRoot: string | null;
  cwd: string | null;
  generation: number;
  loading: boolean;
  sending: boolean;
  pendingImageGenerationTaskIds: string[];
  pendingVideoGenerationTaskIds: string[];
  cancelling: boolean;
  error: string | null;
  timeline: AcpTimelineSnapshot;
  turnTimingsByUserMessageId: Record<string, AcpTurnTiming>;
  prepareLocalSession: (input: AcpChatLoadPayload) => void;
  loadSession: (input: AcpChatLoadPayload) => Promise<boolean>;
  sendPrompt: (input: AcpChatPromptPayload) => Promise<boolean>;
  cancel: () => Promise<void>;
  respondPermission: (requestId: string, optionId: string) => Promise<void>;
  applyUpdateEnvelope: (event: AcpSessionUpdateEnvelope) => void;
  applyPermissionRequest: (event: AcpPermissionRequestEnvelope) => void;
  recordImageGenerationStart: (event: AcpSessionUpdateEnvelope) => void;
  recordVideoGenerationUpdate: (event: AcpSessionUpdateEnvelope) => void;
  settleVideoGenerationTask: (taskId: string) => void;
  projectImageGenerationCompletion: (event: ImageGenerationCompletionEvidence, options?: ImageGenerationProjectionOptions) => Promise<void>;
  clearError: () => void;
};

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

function failedOperationMessage(result: AcpChatOperationResult, fallback: string): string {
  return result.error || fallback;
}

function permissionOutcome(optionId: string): PermissionOutcome {
  return optionId === CANCEL_PERMISSION_OPTION_ID
    ? { outcome: 'cancelled' }
    : { outcome: 'selected', optionId };
}

function permissionStatus(outcome: PermissionOutcome): PermissionItem['status'] {
  return outcome.outcome === 'cancelled' ? 'cancelled' : 'selected';
}

function applyPermissionRequestToTimeline(
  timeline: AcpTimelineSnapshot,
  event: AcpPermissionRequestEnvelope,
): AcpTimelineSnapshot {
  const toolCallId = event.request.toolCall?.toolCallId;
  const id = `permission:${event.requestId}`;
  const item: PermissionItem = {
    kind: 'permission',
    id,
    requestId: event.requestId,
    toolCallId,
    title: event.request.toolCall?.title ?? toolCallId ?? 'Permission request',
    options: event.request.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
    status: 'pending',
  };
  return {
    ...timeline,
    itemOrder: timeline.itemOrder.includes(id) ? timeline.itemOrder : [...timeline.itemOrder, id],
    itemsById: { ...timeline.itemsById, [id]: item },
    openMessageSegments: {},
  };
}

function captureLiveSession(state: AcpChatSessionState): void {
  if (
    (
      !state.sending
      && state.pendingImageGenerationTaskIds.length === 0
      && state.pendingVideoGenerationTaskIds.length === 0
    )
    || !state.activeSessionKey
  ) return;
  const existing = liveSessionSnapshots.get(state.activeSessionKey);
  liveSessionSnapshots.set(state.activeSessionKey, {
    sessionKey: state.activeSessionKey,
    workspaceRoot: state.workspaceRoot,
    cwd: state.cwd,
    generation: state.generation,
    sending: state.sending,
    pendingImageGenerationTaskIds: state.pendingImageGenerationTaskIds,
    pendingVideoGenerationTaskIds: state.pendingVideoGenerationTaskIds,
    timeline: state.timeline,
    turnTimingsByUserMessageId: state.turnTimingsByUserMessageId,
    deferredImageUpdates: existing?.deferredImageUpdates ?? [],
    deferredImageCompletions: existing?.deferredImageCompletions ?? [],
  });
}

function applyVideoGenerationUpdateToSnapshot(
  snapshot: LiveSessionSnapshot,
  event: AcpSessionUpdateEnvelope,
): LiveSessionSnapshot {
  if (event.historical) return snapshot;
  const terminalTaskId = extractVideoGenerationTerminalTaskIdFromAcpEnvelope(event);
  const start = extractVideoGenerationStartFromAcpEnvelope(event);
  let pendingVideoGenerationTaskIds = snapshot.pendingVideoGenerationTaskIds;
  if (terminalTaskId) {
    clearVideoGenerationTaskTimeout(terminalTaskId);
    pendingVideoGenerationTaskIds = pendingVideoGenerationTaskIds.filter((taskId) => taskId !== terminalTaskId);
  }
  if (start && !pendingVideoGenerationTaskIds.includes(start.taskId)) {
    scheduleVideoGenerationTaskTimeout(start.taskId);
    pendingVideoGenerationTaskIds = [...pendingVideoGenerationTaskIds, start.taskId];
  }
  return pendingVideoGenerationTaskIds === snapshot.pendingVideoGenerationTaskIds
    ? snapshot
    : { ...snapshot, pendingVideoGenerationTaskIds };
}

function scheduleVideoGenerationTaskTimeout(taskId: string): void {
  const existing = videoGenerationTaskTimers.get(taskId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    videoGenerationTaskTimers.delete(taskId);
    useAcpChatSessionStore.getState().settleVideoGenerationTask(taskId);
  }, VIDEO_GENERATION_PENDING_TIMEOUT_MS);
  videoGenerationTaskTimers.set(taskId, timer);
}

function clearVideoGenerationTaskTimeout(taskId: string): void {
  const timer = videoGenerationTaskTimers.get(taskId);
  if (timer) clearTimeout(timer);
  videoGenerationTaskTimers.delete(taskId);
}

function compatSession(sessionKey: string): ImageGenerationCompatSession {
  const existing = imageGenerationCompatSessions.get(sessionKey);
  if (existing) return existing;

  const created: ImageGenerationCompatSession = {
    taskStartedAt: 0,
    replayTaskStartedAt: 0,
    taskIds: new Set<string>(),
    replayTaskIds: new Set<string>(),
    taskToolCallIds: new Map<string, string>(),
    replayTaskToolCallIds: new Map<string, string>(),
    delivered: new Set<string>(),
    reservations: new Map<string, string>(),
    authoritativeCaptions: new Map<string, { text: string; priority: number }>(),
    syntheticCompletions: new Map<string, { taskId: string; afterItemId: string; createdAt: number }>(),
  };
  imageGenerationCompatSessions.set(sessionKey, created);
  return created;
}

function resetImageGenerationCompatSession(sessionKey: string): void {
  imageGenerationCompatSessions.delete(sessionKey);
}

function invalidateTranscriptSupplement(): void {
  transcriptSupplementSeq += 1;
  if (activeTranscriptSupplement?.retryTimer) clearTimeout(activeTranscriptSupplement.retryTimer);
  if (activeTranscriptSupplement?.videoRetryTimer) clearTimeout(activeTranscriptSupplement.videoRetryTimer);
  activeTranscriptSupplement = null;
}

function stopLiveTranscriptSupplementRetry(sessionKey: string, generation: number, taskId?: string): void {
  const operation = activeTranscriptSupplement;
  if (
    !operation?.liveUserMessageId
    || operation.sessionKey !== sessionKey
    || operation.generation !== generation
    || !taskId
    || !operation.imageTaskIds.has(taskId)
  ) return;
  operation.completedTaskIds.add(taskId);
  if ([...operation.imageTaskIds].some((id) => !operation.completedTaskIds.has(id))) return;
  operation.terminal = true;
  if (operation.retryTimer) clearTimeout(operation.retryTimer);
  operation.retryTimer = undefined;
}

function beginTranscriptSupplement(
  sessionKey: string,
  generation: number,
  liveUserMessageId?: string,
): TranscriptSupplementOperation {
  invalidateTranscriptSupplement();
  const operation: TranscriptSupplementOperation = {
    id: transcriptSupplementSeq,
    sessionKey,
    generation,
    attempt: 0,
    retryIndex: 0,
    imageTaskIds: new Set<string>(),
    completedTaskIds: new Set<string>(),
    videoTaskIds: new Set<string>(),
    completedVideoTaskIds: new Set<string>(),
    videoRetryIndex: 0,
    videoRetryEpoch: 0,
    started: false,
    terminal: false,
    ...(liveUserMessageId ? { liveUserMessageId } : {}),
  };
  activeTranscriptSupplement = operation;
  return operation;
}

function isCurrentTranscriptSupplement(
  state: AcpChatSessionState,
  operation: TranscriptSupplementOperation,
): boolean {
  return activeTranscriptSupplement?.id === operation.id
    && isCurrentAction(state, operation.sessionKey, operation.generation)
    && (!operation.liveUserMessageId || state.timeline.itemOrder.some((itemId) => {
      const item = state.timeline.itemsById[itemId];
      return item?.kind === 'message-segment'
        && item.role === 'user'
        && item.messageId === operation.liveUserMessageId;
    }));
}

function hasFreshImageGenerationContext(
  sessionKey: string,
  now = Date.now(),
  includeReplay = false,
): boolean {
  const session = imageGenerationCompatSessions.get(sessionKey);
  if (!session) return false;
  const anchors = includeReplay ? [session.replayTaskStartedAt] : [session.taskStartedAt];
  return anchors.some((startedAt) => startedAt > 0 && now - startedAt <= IMAGE_GENERATION_COMPAT_WINDOW_MS);
}

function reserveDelivery(
  sessionKey: string,
  key: string,
  owner: string,
  allowSupersede: boolean,
): boolean {
  const session = compatSession(sessionKey);
  if (session.delivered.has(key)) return false;
  if (session.reservations.has(key) && !allowSupersede) return false;
  session.reservations.set(key, owner);
  return true;
}

function ownsDeliveryReservation(sessionKey: string, key: string, owner: string): boolean {
  return imageGenerationCompatSessions.get(sessionKey)?.reservations.get(key) === owner;
}

function releaseDelivery(sessionKey: string, key: string, owner: string): void {
  const session = imageGenerationCompatSessions.get(sessionKey);
  if (session?.reservations.get(key) === owner) session.reservations.delete(key);
}

function commitDelivery(sessionKey: string, key: string, owner: string): void {
  const session = imageGenerationCompatSessions.get(sessionKey);
  if (session?.reservations.get(key) !== owner) return;
  session.reservations.delete(key);
  session.delivered.add(key);
}

function imageGenerationTaskIdFromSessionKey(sessionKey: string | undefined): string | null {
  const match = sessionKey?.match(/^image_generate:([0-9a-f-]{36})(?::|$)/i);
  return match?.[1] ?? null;
}

function deferInactiveImageGenerationCompletion(
  activeSessionKey: string | null,
  evidence: ImageGenerationCompletionEvidence,
): boolean {
  const taskId = evidence.taskId ?? imageGenerationTaskIdFromSessionKey(evidence.sessionKey);
  if (!taskId) return false;
  for (const [sessionKey, snapshot] of liveSessionSnapshots) {
    if (
      sessionKey === activeSessionKey
      || !snapshot.pendingImageGenerationTaskIds.includes(taskId)
    ) continue;
    const key = imageGenerationEvidenceKey(evidence);
    const deferredImageCompletions = snapshot.deferredImageCompletions.filter(
      (entry) => entry.key !== key,
    );
    deferredImageCompletions.push({ key, evidence });
    liveSessionSnapshots.set(sessionKey, { ...snapshot, deferredImageCompletions });
    return true;
  }
  return false;
}

function resolveImageGenerationProjectionSession(
  state: AcpChatSessionState,
  evidence: ImageGenerationCompletionEvidence,
): string | null {
  const activeSessionKey = state.activeSessionKey;
  if (!activeSessionKey) return null;
  const session = imageGenerationCompatSessions.get(activeSessionKey);
  const taskIds = usesReplayImageGenerationContext(evidence)
    ? session?.replayTaskIds
    : session?.taskIds;
  const taskId = evidence.taskId ?? imageGenerationTaskIdFromSessionKey(evidence.sessionKey);
  if (taskId) return taskIds?.has(taskId) ? activeSessionKey : null;
  if (!evidence.sessionKey || evidence.sessionKey === activeSessionKey) return activeSessionKey;
  return null;
}

function imageGenerationCaptionPriority(source: ImageGenerationCompletionEvidence['source']): number {
  if (source === 'acp-session-update') return 3;
  if (source === 'transcript-history') return 1;
  return 2;
}

function usesReplayImageGenerationContext(evidence: ImageGenerationCompletionEvidence): boolean {
  return !!evidence.historical
    && (evidence.source === 'acp-session-update' || evidence.source === 'transcript-history');
}

function recordImageGenerationStartAnchor(
  session: ImageGenerationCompatSession,
  start: ImageGenerationTaskStart,
  replay: boolean,
): void {
  if (replay) {
    session.lastReplayTaskId = start.taskId;
    if (!start.toolCallId) return;
    session.replayTaskToolCallIds.set(start.taskId, start.toolCallId);
    session.lastReplayToolCallId = start.toolCallId;
    return;
  }
  session.lastTaskId = start.taskId;
  if (!start.toolCallId) return;
  session.taskToolCallIds.set(start.taskId, start.toolCallId);
  session.lastTaskToolCallId = start.toolCallId;
}

function existingToolAnchorId(state: AcpChatSessionState, toolCallId: string | undefined): string | undefined {
  if (!toolCallId) return undefined;
  const itemId = `tool:${toolCallId}`;
  return state.timeline.itemsById[itemId]?.kind === 'tool-call' ? itemId : undefined;
}

function imageGenerationAnchorItemId(
  state: AcpChatSessionState,
  sessionKey: string,
  evidence: ImageGenerationCompletionEvidence,
): string | undefined {
  const session = imageGenerationCompatSessions.get(sessionKey);
  const replay = usesReplayImageGenerationContext(evidence);
  const taskId = evidence.taskId ?? imageGenerationTaskIdFromSessionKey(evidence.sessionKey);
  const candidates = [
    evidence.toolCallId,
    taskId ? (replay ? session?.replayTaskToolCallIds : session?.taskToolCallIds)?.get(taskId) : undefined,
    replay ? session?.lastReplayToolCallId : session?.lastTaskToolCallId,
  ];

  for (const candidate of candidates) {
    const anchorId = existingToolAnchorId(state, candidate);
    if (anchorId) return anchorId;
  }
  return undefined;
}

function recordProjectionTrace(input: {
  event: string;
  sessionKey?: string | null;
  generation?: number;
  details?: Record<string, unknown>;
}): void {
  void hostApi.diagnostics.recordAcpTrace({
    event: input.event,
    direction: 'projection',
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    ...(typeof input.generation === 'number' ? { generation: input.generation } : {}),
    ...(input.details ? { details: input.details } : {}),
  }).catch(() => undefined);
}

function projectionTraceDetails(
  evidence: ImageGenerationCompletionEvidence,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const taskId = evidence.taskId ?? imageGenerationTaskIdFromSessionKey(evidence.sessionKey);
  return {
    source: evidence.source,
    historical: !!evidence.historical,
    candidateCount: evidence.candidates.length,
    ...(taskId ? { taskId } : {}),
    ...extra,
  };
}

function recordHistoricalImageGenerationStart(start: ImageGenerationTaskStart, generation: number): void {
  recordProjectionTrace({
    event: 'image-generation:start-detected',
    sessionKey: start.sessionKey,
    generation,
    details: {
      source: 'transcript-history',
      taskId: start.taskId,
      ...(start.toolCallId ? { toolCallId: start.toolCallId } : {}),
      historical: true,
    },
  });
  const session = compatSession(start.sessionKey);
  session.replayTaskStartedAt = Date.now();
  session.replayTaskIds.add(start.taskId);
  recordImageGenerationStartAnchor(session, start, true);
}

function messageIdFromEvidence(key: string): string {
  const encoded: string[] = [];
  for (let index = 0; index < key.length; index += 1) {
    encoded.push(key.charCodeAt(index).toString(16).padStart(4, '0'));
  }
  return `compat:image-generation:${encoded.join('')}`;
}

function replaceSyntheticImageCaptionAtItem(
  timeline: AcpTimelineSnapshot,
  itemId: string,
  caption: string,
): AcpTimelineSnapshot {
  const item = timeline.itemsById[itemId];
  if (item?.kind !== 'message-segment' || item.compat?.source !== 'image-generation') return timeline;
  const markdownIndex = item.parts.findIndex((part) => part.kind === 'markdown');
  const parts = markdownIndex < 0
    ? [{ kind: 'markdown' as const, text: caption }, ...item.parts]
    : item.parts.map((part, index) => (
        index === markdownIndex ? { kind: 'markdown' as const, text: caption } : part
      ));
  return {
    ...timeline,
    itemsById: {
      ...timeline.itemsById,
      [itemId]: { ...item, parts },
    },
  };
}

function replaceSyntheticImageCaption(
  timeline: AcpTimelineSnapshot,
  key: string,
  caption: string,
): AcpTimelineSnapshot {
  return replaceSyntheticImageCaptionAtItem(timeline, `${messageIdFromEvidence(key)}:0`, caption);
}

function matchingSyntheticImageItemId(
  timeline: AcpTimelineSnapshot,
  imageParts: RenderPart[],
): string | undefined {
  const identities = imageParts.flatMap((part) => (
    part.kind === 'image' && part.mediaIdentity ? [part.mediaIdentity] : []
  )).sort();
  if (identities.length === 0) return undefined;
  const identityKey = JSON.stringify(identities);
  return timeline.itemOrder.find((itemId) => {
    const item = timeline.itemsById[itemId];
    if (item?.kind !== 'message-segment' || item.compat?.source !== 'image-generation') return false;
    const existingIdentities = item.parts.flatMap((part) => (
      part.kind === 'image' && part.mediaIdentity ? [part.mediaIdentity] : []
    )).sort();
    return JSON.stringify(existingIdentities) === identityKey;
  });
}

type AcpImageCompletionMatch = {
  itemId?: string;
  closedReason?: 'missing-anchor' | 'task-anchor-mismatch' | 'competing-image-task' | 'user-turn-closed' | 'ambiguous-match';
};

/** Finds the native ACP reply owned by the same image task, never across task or user-turn boundaries. */
function findAcpImageCompletionMatch(
  timeline: AcpTimelineSnapshot,
  afterItemId: string | undefined,
  caption: string,
  sessionKey: string,
  taskId: string | undefined,
  evidenceId: string,
): AcpImageCompletionMatch {
  if (!afterItemId) return {};
  const normalizedCaption = caption.trim();
  const anchorIndex = timeline.itemOrder.indexOf(afterItemId);
  if (anchorIndex < 0) return { closedReason: 'missing-anchor' };

  const session = imageGenerationCompatSessions.get(sessionKey);
  const ownedAnchorItemIds = new Set<string>();
  const competingAnchorItemIds = new Set<string>();
  for (const taskAnchors of [session?.taskToolCallIds, session?.replayTaskToolCallIds]) {
    for (const [recordedTaskId, toolCallId] of taskAnchors ?? []) {
      const itemId = `tool:${toolCallId}`;
      if (taskId && recordedTaskId === taskId) ownedAnchorItemIds.add(itemId);
      else competingAnchorItemIds.add(itemId);
    }
  }
  if (ownedAnchorItemIds.size > 0 && !ownedAnchorItemIds.has(afterItemId)) {
    return { closedReason: 'task-anchor-mismatch' };
  }

  let matchingItemId: string | undefined;

  for (let index = anchorIndex + 1; index < timeline.itemOrder.length; index += 1) {
    const itemId = timeline.itemOrder[index];
    const item = itemId ? timeline.itemsById[itemId] : undefined;
    if (item?.kind === 'message-segment' && item.role === 'user') {
      return matchingItemId ? { itemId: matchingItemId } : { closedReason: 'user-turn-closed' };
    }
    if (itemId !== afterItemId && competingAnchorItemIds.has(itemId)) {
      return matchingItemId ? { itemId: matchingItemId } : { closedReason: 'competing-image-task' };
    }
    if (item?.kind !== 'message-segment' || item.role !== 'assistant') continue;
    if (item.messageId.startsWith('compat:image-generation:')) continue;
    if (item.compat && (
      item.compat.source !== 'image-generation'
      || item.compat.evidenceId !== evidenceId
    )) continue;
    if (!normalizedCaption) continue;
    const text = item.parts
      .flatMap((part) => part.kind === 'markdown' ? [part.text] : [])
      .join('\n')
      .trim();
    if (text !== normalizedCaption) continue;
    if (matchingItemId) return { closedReason: 'ambiguous-match' };
    matchingItemId = itemId;
  }
  return matchingItemId ? { itemId: matchingItemId } : {};
}

function matchingAcpImageCompletionItemId(
  timeline: AcpTimelineSnapshot,
  afterItemId: string | undefined,
  caption: string,
  sessionKey: string,
  taskId: string | undefined,
  evidenceId: string,
): string | undefined {
  return findAcpImageCompletionMatch(
    timeline,
    afterItemId,
    caption,
    sessionKey,
    taskId,
    evidenceId,
  ).itemId;
}

/** Adds compatibility-resolved images to an existing ACP reply without creating another message. */
function mergeImageCompletionIntoAcpItem(
  timeline: AcpTimelineSnapshot,
  itemId: string,
  evidenceId: string,
  imageParts: RenderPart[],
): AcpTimelineSnapshot {
  const item = timeline.itemsById[itemId];
  if (item?.kind !== 'message-segment' || item.role !== 'assistant') return timeline;
  const existingImages = new Set(item.parts.flatMap((part) => (
    part.kind === 'image' ? [part.mediaIdentity ?? `${part.mimeType ?? ''}:${part.source}`] : []
  )));
  const missingImages = imageParts.filter((part) => {
    if (part.kind !== 'image') return false;
    const identity = part.mediaIdentity ?? `${part.mimeType ?? ''}:${part.source}`;
    if (existingImages.has(identity)) return false;
    existingImages.add(identity);
    return true;
  });
  return {
    ...timeline,
    itemsById: {
      ...timeline.itemsById,
      [itemId]: {
        ...item,
        parts: [...item.parts, ...missingImages],
        compat: { source: 'image-generation', evidenceId },
      },
    },
  };
}

function removeSyntheticImageCompletionItem(
  timeline: AcpTimelineSnapshot,
  itemId: string,
): AcpTimelineSnapshot {
  const item = timeline.itemsById[itemId];
  if (item?.kind !== 'message-segment' || item.compat?.source !== 'image-generation') return timeline;
  const itemsById = { ...timeline.itemsById };
  const segmentCounts = { ...timeline.segmentCounts };
  const openMessageSegments = { ...timeline.openMessageSegments };
  delete itemsById[itemId];
  delete segmentCounts[item.messageId];
  if (openMessageSegments[item.messageId] === itemId) delete openMessageSegments[item.messageId];
  return {
    ...timeline,
    itemOrder: timeline.itemOrder.filter((candidateId) => candidateId !== itemId),
    itemsById,
    segmentCounts,
    openMessageSegments,
  };
}

/** Tracks one task-scoped synthetic projection until its authoritative ACP reply can be identified. */
function trackSyntheticImageCompletion(
  timeline: AcpTimelineSnapshot,
  sessionKey: string,
  key: string,
  taskId: string | undefined,
  afterItemId: string | undefined,
): boolean {
  if (!taskId || !afterItemId) return false;
  const syntheticItemId = `${messageIdFromEvidence(key)}:0`;
  const syntheticItem = timeline.itemsById[syntheticItemId];
  if (
    syntheticItem?.kind !== 'message-segment'
    || syntheticItem.compat?.source !== 'image-generation'
    || syntheticItem.compat.evidenceId !== key
  ) return false;
  const session = compatSession(sessionKey);
  const existing = session.syntheticCompletions.get(key);
  session.syntheticCompletions.set(key, {
    taskId: existing?.taskId ?? taskId,
    afterItemId: existing?.afterItemId ?? afterItemId,
    createdAt: existing?.createdAt ?? Date.now(),
  });
  return true;
}

/** Reconciles the inverse event order: compatibility media first, native ACP text later. */
function reconcileLateAcpImageCompletions(
  timeline: AcpTimelineSnapshot,
  sessionKey: string,
  generation: number,
): AcpTimelineSnapshot {
  const session = imageGenerationCompatSessions.get(sessionKey);
  if (!session || session.syntheticCompletions.size === 0) return timeline;

  const matches: Array<{
    key: string;
    taskId: string;
    syntheticItemId: string;
    nativeItemId: string;
  }> = [];
  const now = Date.now();
  for (const [key, projection] of session.syntheticCompletions) {
    if (now - projection.createdAt > IMAGE_GENERATION_COMPAT_WINDOW_MS) {
      session.syntheticCompletions.delete(key);
      continue;
    }
    const syntheticItemId = `${messageIdFromEvidence(key)}:0`;
    const syntheticItem = timeline.itemsById[syntheticItemId];
    if (
      syntheticItem?.kind !== 'message-segment'
      || syntheticItem.compat?.source !== 'image-generation'
      || syntheticItem.compat.evidenceId !== key
    ) {
      session.syntheticCompletions.delete(key);
      continue;
    }
    const caption = session.authoritativeCaptions.get(key)?.text ?? '';
    const match = findAcpImageCompletionMatch(
      timeline,
      projection.afterItemId,
      caption,
      sessionKey,
      projection.taskId,
      key,
    );
    if (match.closedReason) {
      session.syntheticCompletions.delete(key);
      recordProjectionTrace({
        event: 'image-generation:projection-reconciliation-stopped',
        sessionKey,
        generation,
        details: {
          taskId: projection.taskId,
          reason: match.closedReason,
        },
      });
      continue;
    }
    if (match.itemId) {
      matches.push({ key, taskId: projection.taskId, syntheticItemId, nativeItemId: match.itemId });
    }
  }

  const nativeMatchCounts = new Map<string, number>();
  for (const match of matches) {
    nativeMatchCounts.set(match.nativeItemId, (nativeMatchCounts.get(match.nativeItemId) ?? 0) + 1);
  }

  let nextTimeline = timeline;
  for (const match of matches) {
    if (nativeMatchCounts.get(match.nativeItemId) !== 1) {
      session.syntheticCompletions.delete(match.key);
      continue;
    }
    const syntheticItem = nextTimeline.itemsById[match.syntheticItemId];
    if (syntheticItem?.kind !== 'message-segment' || syntheticItem.compat?.evidenceId !== match.key) continue;
    const imageParts = syntheticItem.parts.filter((part) => part.kind === 'image');
    nextTimeline = mergeImageCompletionIntoAcpItem(
      nextTimeline,
      match.nativeItemId,
      match.key,
      imageParts,
    );
    nextTimeline = removeSyntheticImageCompletionItem(nextTimeline, match.syntheticItemId);
    session.syntheticCompletions.delete(match.key);
    recordProjectionTrace({
      event: 'image-generation:projection-merged',
      sessionKey,
      generation,
      details: {
        source: 'acp-session-update',
        taskId: match.taskId,
        reason: 'late-matching-acp-reply',
        candidateCount: imageParts.length,
      },
    });
  }
  return nextTimeline;
}

function timelineItemParts(item: TimelineItem): RenderPart[] {
  if (item.kind === 'message-segment' || item.kind === 'thought') return item.parts;
  if (item.kind === 'tool-call') return item.outputParts;
  return [];
}

function projectionMediaIdentity(part: RenderPart): string | undefined {
  if (part.kind === 'image') {
    return part.mediaIdentity ?? `${part.mimeType ?? ''}:${part.source}`;
  }
  if (part.kind === 'attachment' && part.access.status === 'available') {
    return part.access.identity;
  }
  return undefined;
}

function timelineMediaIdentities(timeline: AcpTimelineSnapshot): Set<string> {
  const identities = new Set<string>();
  for (const itemId of timeline.itemOrder) {
    const item = timeline.itemsById[itemId];
    if (!item) continue;
    for (const part of timelineItemParts(item)) {
      const identity = projectionMediaIdentity(part);
      if (identity) identities.add(identity);
    }
  }
  return identities;
}

function rebindProjectionPart(
  part: RenderPart,
  sessionKey: string,
  generation: number,
): RenderPart {
  if (part.kind === 'image' && part.attachmentFileRef) {
    return {
      ...part,
      attachmentFileRef: { ...part.attachmentFileRef, sessionKey, generation },
    };
  }
  if (part.kind !== 'attachment' || part.access.status !== 'available') return part;
  return {
    ...part,
    access: {
      ...part.access,
      target: {
        ...part.access.target,
        ref: { ...part.access.target.ref, sessionKey, generation },
      },
    },
  };
}

type RendererMediaProjectionItem = MessageSegmentItem & {
  compat: { source: 'image-generation' | 'openclaw-media'; evidenceId: string };
};

function rendererMediaProjection(item: TimelineItem | undefined): item is RendererMediaProjectionItem {
  return item?.kind === 'message-segment'
    && (item.compat?.source === 'image-generation' || item.compat?.source === 'openclaw-media');
}

function projectionEvidenceItemId(
  timeline: AcpTimelineSnapshot,
  item: MessageSegmentItem,
): string | undefined {
  return timeline.itemOrder.find((itemId) => {
    const candidate = timeline.itemsById[itemId];
    return rendererMediaProjection(candidate)
      && candidate.compat?.source === item.compat?.source
      && candidate.compat.evidenceId === item.compat?.evidenceId;
  });
}

type ProjectionAnchor = { itemId: string; placement: 'before' | 'after' };

function projectionAnchor(
  previous: AcpTimelineSnapshot,
  projectionIndex: number,
  timeline: AcpTimelineSnapshot,
): ProjectionAnchor | null {
  for (let index = projectionIndex - 1; index >= 0; index -= 1) {
    const itemId = previous.itemOrder[index];
    if (itemId && timeline.itemsById[itemId]) return { itemId, placement: 'after' };
  }
  for (let index = projectionIndex + 1; index < previous.itemOrder.length; index += 1) {
    const itemId = previous.itemOrder[index];
    if (itemId && timeline.itemsById[itemId]) return { itemId, placement: 'before' };
  }
  return null;
}

function itemMarkdownText(item: MessageSegmentItem): string {
  return item.parts
    .flatMap((part) => part.kind === 'markdown' ? [part.text] : [])
    .join('\n')
    .trim();
}

function matchingReplayCaptionItemId(
  timeline: AcpTimelineSnapshot,
  anchor: ProjectionAnchor,
  caption: string,
): string | undefined {
  if (!caption || anchor.placement !== 'after') return undefined;
  const anchorIndex = timeline.itemOrder.indexOf(anchor.itemId);
  if (anchorIndex < 0) return undefined;
  const matches: string[] = [];
  for (let index = anchorIndex + 1; index < timeline.itemOrder.length; index += 1) {
    const itemId = timeline.itemOrder[index];
    const item = itemId ? timeline.itemsById[itemId] : undefined;
    if (item?.kind === 'message-segment' && item.role === 'user') break;
    if (
      item?.kind === 'message-segment'
      && item.role === 'assistant'
      && !item.compat
      && itemMarkdownText(item) === caption
    ) matches.push(itemId!);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function insertRendererMediaProjection(
  timeline: AcpTimelineSnapshot,
  item: MessageSegmentItem,
  anchor: ProjectionAnchor,
): AcpTimelineSnapshot {
  const anchorIndex = timeline.itemOrder.indexOf(anchor.itemId);
  if (anchorIndex < 0 || timeline.itemsById[item.id]) return timeline;
  const insertionIndex = anchor.placement === 'after' ? anchorIndex + 1 : anchorIndex;
  return dedupeTimelineAttachments({
    ...timeline,
    itemOrder: [
      ...timeline.itemOrder.slice(0, insertionIndex),
      item.id,
      ...timeline.itemOrder.slice(insertionIndex),
    ],
    itemsById: { ...timeline.itemsById, [item.id]: item },
    segmentCounts: {
      ...timeline.segmentCounts,
      [item.messageId]: Math.max(timeline.segmentCounts[item.messageId] ?? 0, item.segmentIndex + 1),
    },
  });
}

function releaseUnrestoredImageProjection(sessionKey: string, evidenceId: string): void {
  const session = imageGenerationCompatSessions.get(sessionKey);
  if (!session) return;
  session.delivered.delete(evidenceId);
  session.reservations.delete(evidenceId);
  session.syntheticCompletions.delete(evidenceId);
}

/** Restores only Renderer-owned media omitted by ACP replay; replay remains authoritative for all other items. */
function restoreBackgroundMediaProjections(
  timeline: AcpTimelineSnapshot,
  snapshot: LiveSessionSnapshot,
  sessionKey: string,
  generation: number,
): AcpTimelineSnapshot {
  let nextTimeline = timeline;
  for (const [projectionIndex, itemId] of snapshot.timeline.itemOrder.entries()) {
    const previousItem = snapshot.timeline.itemsById[itemId];
    if (!rendererMediaProjection(previousItem)) continue;
    const evidenceId = previousItem.compat.evidenceId;
    if (projectionEvidenceItemId(nextTimeline, previousItem)) continue;

    const reboundParts = previousItem.parts.map((part) => (
      rebindProjectionPart(part, sessionKey, generation)
    ));
    const existingMedia = timelineMediaIdentities(nextTimeline);
    const mediaParts = reboundParts.filter((part) => part.kind === 'image' || part.kind === 'attachment');
    const missingParts = reboundParts.filter((part) => {
      if (part.kind !== 'image' && part.kind !== 'attachment') return true;
      const identity = projectionMediaIdentity(part);
      return !identity || !existingMedia.has(identity);
    });
    if (mediaParts.length > 0 && missingParts.every((part) => part.kind !== 'image' && part.kind !== 'attachment')) {
      continue;
    }

    const existingItem = nextTimeline.itemsById[previousItem.id];
    const missingImages = missingParts.filter((part) => part.kind === 'image');
    if (existingItem?.kind === 'message-segment' && existingItem.role === 'assistant') {
      if (missingImages.length > 0) {
        nextTimeline = mergeImageCompletionIntoAcpItem(
          nextTimeline,
          existingItem.id,
          evidenceId,
          missingImages,
        );
      }
      continue;
    }

    const anchor = projectionAnchor(snapshot.timeline, projectionIndex, nextTimeline);
    if (!anchor) {
      if (previousItem.compat?.source === 'image-generation') {
        releaseUnrestoredImageProjection(sessionKey, evidenceId);
      }
      continue;
    }

    if (previousItem.compat?.source === 'image-generation') {
      const replayCaptionItemId = matchingReplayCaptionItemId(
        nextTimeline,
        anchor,
        itemMarkdownText(previousItem),
      );
      if (replayCaptionItemId) {
        if (missingImages.length > 0) {
          nextTimeline = mergeImageCompletionIntoAcpItem(
            nextTimeline,
            replayCaptionItemId,
            evidenceId,
            missingImages,
          );
        }
        continue;
      }
    }

    nextTimeline = insertRendererMediaProjection(
      nextTimeline,
      { ...previousItem, parts: missingParts },
      anchor,
    );
  }
  return nextTimeline;
}

function isLiveMessageUpdate(event: AcpSessionUpdateEnvelope): boolean {
  if (event.historical) return false;
  const update = event.notification.update as unknown as { sessionUpdate?: unknown };
  return update.sessionUpdate === 'agent_message'
    || update.sessionUpdate === 'agent_message_chunk'
    || update.sessionUpdate === 'user_message'
    || update.sessionUpdate === 'user_message_chunk';
}

function isCurrentAction(
  state: AcpChatSessionState,
  sessionKey: string,
  generation: number,
): boolean {
  return state.activeSessionKey === sessionKey && state.generation === generation;
}

function imageCandidateUri(candidate: ImageGenerationMediaCandidate): string {
  return candidate.gatewayUrl ?? candidate.filePath ?? candidate.key;
}

function safeAttachmentName(uri: string): string {
  let value = uri;
  try {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(uri)) value = new URL(uri).pathname;
  } catch {
    value = uri;
  }
  const name = value.split(/[\\/]/).filter(Boolean).pop() ?? 'attachment';
  const clean = (candidate: string) => Array.from(candidate)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .slice(0, 200) || 'attachment';
  try {
    return clean(decodeURIComponent(name));
  } catch {
    return clean(name);
  }
}

function recordOpenClawMediaTrace(
  operation: TranscriptSupplementOperation,
  event: string,
  details: Record<string, unknown>,
): void {
  recordProjectionTrace({
    event,
    sessionKey: operation.sessionKey,
    generation: operation.generation,
    details: { source: 'openclaw-media', operationId: operation.id, ...details },
  });
}

async function resolveOpenClawMediaCandidate(
  operation: TranscriptSupplementOperation,
  attempt: number,
  turnId: string,
  candidate: OpenClawMediaCandidate,
): Promise<string | null> {
  const isCurrent = () => operation.attempt === attempt
    && isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation);
  if (!isCurrent()) return null;

  let result: ResolveAttachmentResult;
  try {
    result = await hostApi.files.resolveAttachment({
      ref: {
        sessionKey: operation.sessionKey,
        generation: operation.generation,
        uri: candidate.uri,
        ...(candidate.transcriptMessageId ? { transcriptMessageId: candidate.transcriptMessageId } : {}),
      },
      name: safeAttachmentName(candidate.uri),
    });
  } catch {
    result = { ok: false, displayName: safeAttachmentName(candidate.uri), error: 'operationFailed' };
  }

  const evidenceHash = hashOpenClawMediaDiagnostic(candidate.evidenceId);
  if (!isCurrent()) {
    recordOpenClawMediaTrace(operation, 'openclaw-media:projection-stale', {
      reason: 'attachment-resolution-stale',
      evidenceHash,
    });
    return null;
  }

  recordOpenClawMediaTrace(
    operation,
    result.ok ? 'openclaw-media:resolution-available' : 'openclaw-media:resolution-unavailable',
    {
      reason: result.ok ? 'available' : result.error,
      evidenceHash,
      ...(result.ok ? { identityHash: hashOpenClawMediaDiagnostic(result.identity) } : {}),
    },
  );

  const messageId = `compat:openclaw-media:${candidate.evidenceId}`;
  const pending = createPendingAttachment({
    messageId,
    segmentIndex: 0,
    blockIndex: candidate.order,
    uri: candidate.uri,
    name: safeAttachmentName(candidate.uri),
    ...(candidate.transcriptMessageId ? { transcriptMessageId: candidate.transcriptMessageId } : {}),
    source: 'openclaw-media',
    evidenceId: candidate.evidenceId,
  });
  const fingerprint = attachmentRequestFingerprint(pending);
  let projected = false;
  useAcpChatSessionStore.setState((state) => {
    if (!isCurrentTranscriptSupplement(state, operation)) return {};
    const upserted = upsertSyntheticTurnAttachments(state.timeline, {
      turnId,
      evidenceId: candidate.evidenceId,
      attachments: [pending],
      source: 'openclaw-media',
    });
    const timeline = applyAttachmentResolution(upserted, {
      attachmentId: pending.attachmentId,
      expectedFingerprint: fingerprint,
      result,
    });
    projected = Object.values(timeline.itemsById).some((item) => (
      item.kind === 'message-segment'
      && item.parts.some((part) => part.kind === 'attachment' && part.attachmentId === pending.attachmentId)
    ));
    return { timeline };
  });
  recordOpenClawMediaTrace(
    operation,
    projected ? 'openclaw-media:projection-appended' : 'openclaw-media:projection-deduped',
    { reason: projected ? 'projected' : 'identity-priority', evidenceHash, attachmentCount: projected ? 1 : 0 },
  );
  return result.ok
    && result.target.kind === 'local'
    && result.mimeType.startsWith('video/')
    ? result.identity
    : null;
}

async function runTranscriptSupplement(operation: TranscriptSupplementOperation): Promise<number> {
  const attempt = operation.attempt + 1;
  operation.attempt = attempt;
  const isCurrent = () => operation.attempt === attempt
    && isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation);
  if (!isCurrent()) return 0;
  const state = useAcpChatSessionStore.getState();
  const result = await fetchOpenClawTranscriptSupplement({
    sessionKey: operation.sessionKey,
    generation: operation.generation,
    executionCwd: state.cwd ?? '',
    snapshot: () => useAcpChatSessionStore.getState().timeline,
    ...(operation.liveUserMessageId ? { liveUserMessageId: operation.liveUserMessageId } : {}),
    isCurrent,
  });
  if (!result || !isCurrent()) return 0;

  if (!operation.liveUserMessageId && result.turnTimings.length > 0) {
    useAcpChatSessionStore.setState((current) => (
      isCurrentTranscriptSupplement(current, operation)
        ? { turnTimingsByUserMessageId: alignHistoricalTurnTimings(current.timeline, result.turnTimings) }
        : {}
    ));
  }

  for (const start of result.imageGeneration.starts) {
    if (!isCurrent()) return 0;
    recordHistoricalImageGenerationStart(start, operation.generation);
  }
  for (const completion of result.imageGeneration.completions) {
    if (!isCurrent()) return 0;
    await useAcpChatSessionStore.getState().projectImageGenerationCompletion(completion, {
      isCurrent,
      staleReason: 'stale-transcript-supplement',
      reservationOwner: `transcript:${operation.id}:${attempt}`,
      ...(completion.transcriptMessageId ? { transcriptMessageId: completion.transcriptMessageId } : {}),
    });
  }
  const localVideoIdentities = new Set<string>();
  for (const supplement of result.media) {
    for (const candidate of supplement.candidates) {
      if (!isCurrent()) return 0;
      const localVideoIdentity = await resolveOpenClawMediaCandidate(
        operation,
        attempt,
        supplement.acpTurnId,
        candidate,
      );
      if (localVideoIdentity) localVideoIdentities.add(localVideoIdentity);
    }
  }
  return localVideoIdentities.size;
}

function startHistoricalTranscriptSupplement(sessionKey: string, generation: number): void {
  const operation = beginTranscriptSupplement(sessionKey, generation);
  void runTranscriptSupplement(operation);
}

function scheduleLiveTranscriptSupplement(operation: TranscriptSupplementOperation): void {
  if (
    operation.retryTimer
    || operation.terminal
    || !isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation)
  ) return;
  const hasImageTask = operation.imageTaskIds.size > 0;
  if (!hasImageTask && operation.retryIndex > 0) return;
  const delay = IMAGE_GENERATION_TRANSCRIPT_RETRY_DELAYS_MS[operation.retryIndex];
  if (delay === undefined) {
    operation.terminal = true;
    return;
  }
  operation.retryIndex += 1;
  operation.retryTimer = setTimeout(() => {
    operation.retryTimer = undefined;
    void runLiveTranscriptSupplement(operation);
    scheduleLiveTranscriptSupplement(operation);
  }, delay);
}

async function runLiveTranscriptSupplement(operation: TranscriptSupplementOperation): Promise<void> {
  if (operation.terminal || !isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation)) return;
  await runTranscriptSupplement(operation);
}

function startLiveTranscriptSupplement(operation: TranscriptSupplementOperation): void {
  operation.started = true;
  const hasCompletedVideoTask = operation.completedVideoTaskIds.size > 0;
  if (hasCompletedVideoTask) {
    if (!operation.terminal && operation.imageTaskIds.size > 0) {
      scheduleLiveTranscriptSupplement(operation);
    }
    startVideoCompletionTranscriptSupplement(operation);
    return;
  }
  if (!operation.terminal) {
    void runLiveTranscriptSupplement(operation);
    scheduleLiveTranscriptSupplement(operation);
  }
}

function scheduleVideoCompletionTranscriptRetry(
  operation: TranscriptSupplementOperation,
  epoch: number,
  localVideoCount: number,
): void {
  if (
    operation.videoRetryTimer
    || operation.videoRetryEpoch !== epoch
    || !isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation)
  ) return;
  const delay = VIDEO_GENERATION_TRANSCRIPT_RETRY_DELAYS_MS[operation.videoRetryIndex];
  if (delay === undefined) {
    recordProjectionTrace({
      event: 'video-generation:completion-transcript-exhausted',
      sessionKey: operation.sessionKey,
      generation: operation.generation,
      details: {
        completedTaskCount: operation.completedVideoTaskIds.size,
        localVideoCount,
      },
    });
    return;
  }
  operation.videoRetryIndex += 1;
  operation.videoRetryTimer = setTimeout(() => {
    operation.videoRetryTimer = undefined;
    void runVideoCompletionTranscriptSupplement(operation, epoch);
  }, delay);
}

/** Re-reads only the original live Turn until its completed video is locally resolvable. */
async function runVideoCompletionTranscriptSupplement(
  operation: TranscriptSupplementOperation,
  epoch: number,
): Promise<void> {
  if (
    operation.videoRetryEpoch !== epoch
    || !isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation)
  ) return;
  const localVideoCount = await runTranscriptSupplement(operation);
  if (
    operation.videoRetryEpoch !== epoch
    || !isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation)
  ) return;
  if (localVideoCount >= operation.completedVideoTaskIds.size) {
    recordProjectionTrace({
      event: 'video-generation:completion-transcript-projected',
      sessionKey: operation.sessionKey,
      generation: operation.generation,
      details: {
        completedTaskCount: operation.completedVideoTaskIds.size,
        localVideoCount,
      },
    });
    return;
  }
  scheduleVideoCompletionTranscriptRetry(operation, epoch, localVideoCount);
}

function startVideoCompletionTranscriptSupplement(operation: TranscriptSupplementOperation): void {
  if (operation.imageTaskIds.size === 0 && operation.retryTimer) {
    clearTimeout(operation.retryTimer);
    operation.retryTimer = undefined;
  }
  operation.videoRetryEpoch += 1;
  operation.videoRetryIndex = 0;
  if (operation.videoRetryTimer) clearTimeout(operation.videoRetryTimer);
  operation.videoRetryTimer = undefined;
  void runVideoCompletionTranscriptSupplement(operation, operation.videoRetryEpoch);
}

function refreshCompletedVideoTranscript(taskId: string): void {
  const operation = activeTranscriptSupplement;
  if (
    !operation?.liveUserMessageId
    || !operation.videoTaskIds.has(taskId)
    || operation.completedVideoTaskIds.has(taskId)
    || !isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation)
  ) return;
  operation.completedVideoTaskIds.add(taskId);
  recordProjectionTrace({
    event: 'video-generation:completion-transcript-started',
    sessionKey: operation.sessionKey,
    generation: operation.generation,
    details: { taskId },
  });
  if (operation.started) startVideoCompletionTranscriptSupplement(operation);
}

function completeVideoGenerationTask(taskId: string): void {
  useAcpChatSessionStore.getState().settleVideoGenerationTask(taskId);
  refreshCompletedVideoTranscript(taskId);
}

function newPendingAttachments(
  previous: AcpTimelineSnapshot,
  next: AcpTimelineSnapshot,
): PendingAttachmentLocation[] {
  const previousRequests = new Set(
    collectPendingAttachments(previous).map(({ attachment, fingerprint }) => (
      JSON.stringify([attachment.attachmentId, fingerprint])
    )),
  );
  return collectPendingAttachments(next).filter(({ attachment, fingerprint }) => (
    !previousRequests.has(JSON.stringify([attachment.attachmentId, fingerprint]))
  ));
}

function attachmentResolvePayload(
  sessionKey: string,
  generation: number,
  location: PendingAttachmentLocation,
): ResolveAttachmentPayload {
  const { reference } = location.attachment;
  return {
    ref: {
      sessionKey,
      generation,
      uri: reference.uri,
      ...(reference.stagingId ? { stagingId: reference.stagingId } : {}),
      ...(reference.transcriptMessageId ? { transcriptMessageId: reference.transcriptMessageId } : {}),
    },
    ...(reference.name ? { name: reference.name } : {}),
    ...(reference.mimeType ? { mimeType: reference.mimeType } : {}),
    ...(typeof reference.size === 'number' ? { size: reference.size } : {}),
  };
}

function resolvePendingAttachments(
  sessionKey: string,
  generation: number,
  locations: PendingAttachmentLocation[],
): void {
  for (const location of locations) {
    const attachmentId = location.attachment.attachmentId;
    const expectedFingerprint = location.fingerprint;
    const inFlightKey = JSON.stringify([sessionKey, generation, attachmentId, expectedFingerprint]);
    if (attachmentResolutionsInFlight.has(inFlightKey)) continue;
    attachmentResolutionsInFlight.add(inFlightKey);

    void hostApi.files.resolveAttachment(attachmentResolvePayload(sessionKey, generation, location))
      .catch((): ResolveAttachmentResult => ({
        ok: false,
        displayName: location.attachment.reference.name,
        error: 'operationFailed',
      }))
      .then((result) => {
        useAcpChatSessionStore.setState((state) => {
          if (!isCurrentAction(state, sessionKey, generation)) return {};
          return {
            timeline: applyAttachmentResolution(state.timeline, {
              attachmentId,
              expectedFingerprint,
              result,
            }),
          };
        });
      })
      .finally(() => attachmentResolutionsInFlight.delete(inFlightKey));
  }
}

function getPendingPermission(
  timeline: AcpTimelineSnapshot,
  requestId: string,
): PermissionItem | null {
  const item = timeline.itemsById[`permission:${requestId}`];
  return item?.kind === 'permission' && item.status === 'pending' ? item : null;
}

function updatePermissionStatus(
  timeline: AcpTimelineSnapshot,
  requestId: string,
  status: PermissionItem['status'],
): AcpTimelineSnapshot {
  const id = `permission:${requestId}`;
  const item = timeline.itemsById[id];
  if (item?.kind !== 'permission') return timeline;

  return {
    ...timeline,
    itemsById: {
      ...timeline.itemsById,
      [id]: { ...item, status },
    },
  };
}

function createOptimisticMessageId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `user:${random}`;
}

function optimisticPromptParts(input: AcpChatPromptPayload, messageId: string): RenderPart[] {
  const parts: RenderPart[] = [];
  const text = input.message?.trim();
  if (text) parts.push({ kind: 'markdown', text });

  for (const [mediaIndex, item] of (input.media ?? []).entries()) {
    parts.push(createPendingAttachment({
      messageId,
      segmentIndex: 0,
      blockIndex: (text ? 1 : 0) + mediaIndex,
      uri: item.filePath,
      name: item.fileName ?? item.filePath,
      ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      stagingId: item.stagingId,
    }));
  }

  return parts.length > 0 ? parts : [{ kind: 'markdown', text: '' }];
}

function optimisticPromptTextBlocks(input: AcpChatPromptPayload): string[] {
  const text = input.message?.trim();
  return [
    ...(text ? [text] : []),
    ...(input.media ?? []).flatMap((item) => (
      item.mimeType?.startsWith('image/')
        ? []
        : [openClawResourceLinkPromptText(item.filePath)]
    )),
  ];
}

function appendOptimisticUserSegment(
  timeline: AcpTimelineSnapshot,
  input: AcpChatPromptPayload,
  messageId: string,
): AcpTimelineSnapshot {
  const existingId = timeline.itemOrder.find((itemId) => {
    const item = timeline.itemsById[itemId];
    return item?.kind === 'message-segment' && item.role === 'user' && item.messageId === messageId;
  });
  const id = existingId ?? `${messageId}:0`;
  const item: MessageSegmentItem = {
    kind: 'message-segment',
    id,
    role: 'user',
    messageId,
    segmentIndex: 0,
    parts: optimisticPromptParts(input, messageId),
    userPromptTextBlocks: optimisticPromptTextBlocks(input),
    userPromptTextBlocksOptimistic: true,
    blockCount: 0,
    optimistic: true,
  };

  return {
    ...timeline,
    itemOrder: timeline.itemOrder.includes(id) ? timeline.itemOrder : [...timeline.itemOrder, id],
    itemsById: { ...timeline.itemsById, [id]: item },
    openMessageSegments: { ...timeline.openMessageSegments, [messageId]: id },
    segmentCounts: { ...timeline.segmentCounts, [messageId]: Math.max(timeline.segmentCounts[messageId] ?? 0, 1) },
  };
}

function removePendingOptimisticUserSegment(
  timeline: AcpTimelineSnapshot,
  messageId: string,
): AcpTimelineSnapshot {
  const itemId = timeline.openMessageSegments[messageId];
  const item = itemId ? timeline.itemsById[itemId] : undefined;
  if (item?.kind !== 'message-segment' || item.role !== 'user' || !item.optimistic) return timeline;

  const { [itemId]: _removedItem, ...itemsById } = timeline.itemsById;
  const { [messageId]: _removedOpenSegment, ...openMessageSegments } = timeline.openMessageSegments;
  const { [messageId]: _removedSegmentCount, ...segmentCounts } = timeline.segmentCounts;

  return {
    ...timeline,
    itemOrder: timeline.itemOrder.filter((id) => id !== itemId),
    itemsById,
    openMessageSegments,
    segmentCounts,
  };
}

function applyOperationGeneration(
  state: AcpChatSessionState,
  result: AcpChatOperationResult,
): Pick<AcpChatSessionState, 'generation' | 'timeline'> | Record<string, never> {
  if (result.generation == null) return {};
  return {
    generation: result.generation,
    timeline: { ...state.timeline, loadGeneration: result.generation },
  };
}

export const useAcpChatSessionStore = create<AcpChatSessionState>((set, get) => ({
  activeSessionKey: null,
  workspaceRoot: null,
  cwd: null,
  generation: 0,
  loading: false,
  sending: false,
  pendingImageGenerationTaskIds: [],
  pendingVideoGenerationTaskIds: [],
  cancelling: false,
  error: null,
  timeline: createEmptyAcpTimeline(EMPTY_SESSION_ID, 0),
  turnTimingsByUserMessageId: {},

  prepareLocalSession(input) {
    captureLiveSession(get());
    loadRequestSeq += 1;
    pendingLoadUpdates.clear();
    const generation = get().generation;
    invalidateTranscriptSupplement();
    resetImageGenerationCompatSession(input.sessionKey);
    set({
      activeSessionKey: input.sessionKey,
      workspaceRoot: input.workspaceRoot,
      cwd: input.cwd,
      generation,
      loading: false,
      sending: false,
      pendingImageGenerationTaskIds: [],
      pendingVideoGenerationTaskIds: [],
      cancelling: false,
      error: null,
      timeline: createEmptyAcpTimeline(input.sessionKey, generation),
      turnTimingsByUserMessageId: {},
    });
  },

  async loadSession(input) {
    captureLiveSession(get());
    const requestId = loadRequestSeq + 1;
    loadRequestSeq = requestId;
    pendingLoadUpdates.clear();
    const generation = get().generation;
    const liveSnapshot = liveSessionSnapshots.get(input.sessionKey);
    invalidateTranscriptSupplement();
    if (!liveSnapshot?.pendingImageGenerationTaskIds.length) {
      resetImageGenerationCompatSession(input.sessionKey);
    }
    set({
      activeSessionKey: input.sessionKey,
      workspaceRoot: input.workspaceRoot,
      cwd: input.cwd,
      generation,
      loading: true,
      sending: liveSnapshot?.sending ?? false,
      pendingImageGenerationTaskIds: liveSnapshot?.pendingImageGenerationTaskIds ?? [],
      pendingVideoGenerationTaskIds: liveSnapshot?.pendingVideoGenerationTaskIds ?? [],
      cancelling: false,
      error: null,
      timeline: liveSnapshot?.timeline ?? createEmptyAcpTimeline(input.sessionKey, generation),
      turnTimingsByUserMessageId: liveSnapshot?.turnTimingsByUserMessageId ?? {},
    });

    try {
      let result = await hostApi.chat.loadAcpSession(input);
      let state = get();
      if (
        loadRequestSeq !== requestId
        || state.activeSessionKey !== input.sessionKey
        || state.workspaceRoot !== input.workspaceRoot
        || state.cwd !== input.cwd
      ) return false;
      if (!result.success) {
        pendingLoadUpdates.clear();
        set({
          activeSessionKey: null,
          workspaceRoot: null,
          cwd: null,
          loading: false,
          error: failedOperationMessage(result, 'ACP session load failed'),
        });
        return false;
      }

      const resumedSnapshot = result.resumedActivePrompt
        ? liveSessionSnapshots.get(input.sessionKey)
        : undefined;
      if (result.resumedActivePrompt && resumedSnapshot?.generation !== result.generation) {
        result = await hostApi.chat.loadAcpSession(input);
        state = get();
        if (
          loadRequestSeq !== requestId
          || state.activeSessionKey !== input.sessionKey
          || state.workspaceRoot !== input.workspaceRoot
          || state.cwd !== input.cwd
        ) return false;
        if (!result.success || result.resumedActivePrompt) {
          pendingLoadUpdates.clear();
          set({
            loading: false,
            sending: false,
            error: failedOperationMessage(result, 'ACP session load failed'),
          });
          return false;
        }
      }

      const generation = result.generation ?? state.generation;
      const sessionUpdates = [
        ...(result.sessionUpdates ?? []),
        ...(pendingLoadUpdates.get(generation) ?? []),
      ].filter((event) => (
        event.sessionKey === input.sessionKey && event.generation === generation
      ));
      pendingLoadUpdates.clear();
      const currentResumedSnapshot = result.resumedActivePrompt
        ? liveSessionSnapshots.get(input.sessionKey)
        : undefined;
      const currentBackgroundSnapshot = !result.resumedActivePrompt
        ? liveSessionSnapshots.get(input.sessionKey)
        : undefined;
      const restorableBackgroundSnapshot = currentBackgroundSnapshot
        && currentBackgroundSnapshot.sessionKey === input.sessionKey
        && currentBackgroundSnapshot.workspaceRoot === input.workspaceRoot
        && currentBackgroundSnapshot.cwd === input.cwd
        && (
          currentBackgroundSnapshot.pendingImageGenerationTaskIds.length > 0
          || currentBackgroundSnapshot.pendingVideoGenerationTaskIds.length > 0
        )
        ? currentBackgroundSnapshot
        : undefined;
      if (currentBackgroundSnapshot && !restorableBackgroundSnapshot) {
        resetImageGenerationCompatSession(input.sessionKey);
      }
      let timeline = currentResumedSnapshot?.generation === generation
        ? currentResumedSnapshot.timeline
        : createEmptyAcpTimeline(input.sessionKey, generation);
      for (const event of sessionUpdates) {
        timeline = applyAcpSessionUpdate(timeline, event.notification, { historical: !!event.historical });
      }
      if (restorableBackgroundSnapshot) {
        timeline = restoreBackgroundMediaProjections(
          timeline,
          restorableBackgroundSnapshot,
          input.sessionKey,
          generation,
        );
      }
      const pendingAttachments = newPendingAttachments(
        createEmptyAcpTimeline(input.sessionKey, generation),
        timeline,
      );
      set({
        loading: false,
        sending: currentResumedSnapshot?.sending ?? false,
        pendingImageGenerationTaskIds:
          currentResumedSnapshot?.pendingImageGenerationTaskIds
          ?? restorableBackgroundSnapshot?.pendingImageGenerationTaskIds
          ?? [],
        pendingVideoGenerationTaskIds:
          currentResumedSnapshot?.pendingVideoGenerationTaskIds
          ?? restorableBackgroundSnapshot?.pendingVideoGenerationTaskIds
          ?? [],
        error: null,
        generation,
        timeline,
        turnTimingsByUserMessageId:
          currentResumedSnapshot?.turnTimingsByUserMessageId ?? {},
      });
      if (currentResumedSnapshot) {
        liveSessionSnapshots.set(input.sessionKey, {
          ...currentResumedSnapshot,
          timeline,
          deferredImageUpdates: [],
          deferredImageCompletions: [],
        });
      } else {
        liveSessionSnapshots.delete(input.sessionKey);
      }
      resolvePendingAttachments(input.sessionKey, generation, pendingAttachments);
      const restoredSnapshot = currentResumedSnapshot ?? restorableBackgroundSnapshot;
      for (const { event } of restoredSnapshot?.deferredImageUpdates ?? []) {
        get().recordImageGenerationStart(event);
        get().recordVideoGenerationUpdate(event);
        const evidence = extractImageGenerationCompletionFromAcpEnvelope(event);
        if (evidence) void get().projectImageGenerationCompletion(evidence);
      }
      for (const { evidence } of restoredSnapshot?.deferredImageCompletions ?? []) {
        void get().projectImageGenerationCompletion(evidence);
      }
      for (const event of sessionUpdates) {
        get().recordImageGenerationStart(event);
        get().recordVideoGenerationUpdate(event);
        const evidence = extractImageGenerationCompletionFromAcpEnvelope(event);
        if (evidence) void get().projectImageGenerationCompletion(evidence);
      }
      if (!input.createIfMissing) {
        startHistoricalTranscriptSupplement(input.sessionKey, generation);
      }
      return true;
    } catch (error) {
      if (loadRequestSeq === requestId) pendingLoadUpdates.clear();
      set((state) => (
        loadRequestSeq === requestId
          && state.activeSessionKey === input.sessionKey
          && state.workspaceRoot === input.workspaceRoot
          && state.cwd === input.cwd
          ? {
            activeSessionKey: null,
            workspaceRoot: null,
            cwd: null,
            loading: false,
            error: errorMessage(error, 'ACP session load failed'),
          }
          : {}
      ));
      return false;
    }
  },

  async sendPrompt(input) {
    const startState = get();
    const sessionKey = input.sessionKey;
    const generation = startState.generation;
    if (startState.activeSessionKey !== sessionKey) return false;

    const messageId = input.messageId ?? createOptimisticMessageId();
    const payload = { ...input, messageId };
    const startedAtMs = Date.now();
    const transcriptOperation = beginTranscriptSupplement(sessionKey, generation, messageId);

    set((state) => (
      isCurrentAction(state, sessionKey, generation)
        ? {
          sending: true,
          error: null,
          timeline: appendOptimisticUserSegment(state.timeline, payload, messageId),
          turnTimingsByUserMessageId: {
            ...state.turnTimingsByUserMessageId,
            [messageId]: { source: 'live', status: 'running', startedAtMs },
          },
        }
        : {}
    ));
    const optimisticState = get();
    if (isCurrentAction(optimisticState, sessionKey, generation)) {
      captureLiveSession(optimisticState);
      resolvePendingAttachments(
        sessionKey,
        generation,
        newPendingAttachments(startState.timeline, optimisticState.timeline),
      );
    }
    try {
      const result = await hostApi.chat.sendAcpPrompt(payload);
      const state = get();
      liveSessionSnapshots.delete(sessionKey);
      if (!isCurrentAction(state, sessionKey, generation)) return result.success;
      const failedTimeline = result.success
        ? state.timeline
        : removePendingOptimisticUserSegment(state.timeline, messageId);
      const { [messageId]: _removedTiming, ...remainingTurnTimings } = state.turnTimingsByUserMessageId;
      set({
        sending: false,
        turnTimingsByUserMessageId: result.success
          ? {
            ...state.turnTimingsByUserMessageId,
            [messageId]: {
              source: 'live',
              status: 'complete',
              durationMs: Math.max(0, Date.now() - startedAtMs),
            },
          }
          : remainingTurnTimings,
        ...(result.success
          ? applyOperationGeneration(state, result)
          : { error: failedOperationMessage(result, 'ACP prompt failed'), timeline: failedTimeline }),
      });
      if (result.success) {
        const current = get();
        if (
          current.activeSessionKey === sessionKey
          && current.generation === transcriptOperation.generation
          && isCurrentTranscriptSupplement(current, transcriptOperation)
        ) {
          startLiveTranscriptSupplement(transcriptOperation);
        } else if (activeTranscriptSupplement === transcriptOperation) {
          invalidateTranscriptSupplement();
        }
      } else if (activeTranscriptSupplement === transcriptOperation) {
        invalidateTranscriptSupplement();
      }
      return result.success;
    } catch (error) {
      liveSessionSnapshots.delete(sessionKey);
      if (activeTranscriptSupplement === transcriptOperation) invalidateTranscriptSupplement();
      set((state) => (
        isCurrentAction(state, sessionKey, generation)
          ? (() => {
            const { [messageId]: _removedTiming, ...turnTimingsByUserMessageId } = state.turnTimingsByUserMessageId;
            return {
              sending: false,
              error: errorMessage(error, 'ACP prompt failed'),
              timeline: removePendingOptimisticUserSegment(state.timeline, messageId),
              turnTimingsByUserMessageId,
            };
          })()
          : {}
      ));
      return false;
    }
  },

  async cancel() {
    const startState = get();
    const sessionKey = startState.activeSessionKey;
    const generation = startState.generation;
    if (!sessionKey) return;
    invalidateTranscriptSupplement();

    set({ cancelling: true, error: null });
    try {
      const result = await hostApi.chat.cancelAcpSession({ sessionKey });
      set((state) => {
        if (!isCurrentAction(state, sessionKey, generation)) return {};
        return {
          cancelling: false,
          ...(result.success
            ? applyOperationGeneration(state, result)
            : { error: failedOperationMessage(result, 'ACP cancel failed') }),
        };
      });
    } catch (error) {
      set((state) => (
        isCurrentAction(state, sessionKey, generation)
          ? { cancelling: false, error: errorMessage(error, 'ACP cancel failed') }
          : {}
      ));
    }
  },

  async respondPermission(requestId, optionId) {
    const startState = get();
    const sessionKey = startState.activeSessionKey;
    const generation = startState.generation;
    if (!sessionKey) return;
    if (!getPendingPermission(startState.timeline, requestId)) return;

    const outcome = permissionOutcome(optionId);
    try {
      const result = await hostApi.chat.respondAcpPermission({ sessionKey, requestId, outcome });
      if (result.success && result.generation != null && result.generation !== generation) {
        invalidateTranscriptSupplement();
      }
      if (result.success) {
        const liveSnapshot = liveSessionSnapshots.get(sessionKey);
        if (liveSnapshot?.generation === generation && getPendingPermission(liveSnapshot.timeline, requestId)) {
          liveSessionSnapshots.set(sessionKey, {
            ...liveSnapshot,
            timeline: updatePermissionStatus(liveSnapshot.timeline, requestId, permissionStatus(outcome)),
          });
        }
      }
      set((state) => {
        if (!isCurrentAction(state, sessionKey, generation)) return {};
        if (!result.success) {
          return { error: failedOperationMessage(result, 'ACP permission failed') };
        }
        if (!getPendingPermission(state.timeline, requestId)) return {};
        const timeline = updatePermissionStatus(state.timeline, requestId, permissionStatus(outcome));
        const nextGeneration = result.generation ?? state.generation;
        return {
          error: null,
          generation: nextGeneration,
          timeline: result.generation == null ? timeline : { ...timeline, loadGeneration: nextGeneration },
        };
      });
    } catch (error) {
      set((state) => (
        isCurrentAction(state, sessionKey, generation)
          ? { error: errorMessage(error, 'ACP permission failed') }
          : {}
      ));
    }
  },

  recordImageGenerationStart(event) {
    const state = get();
    if (event.sessionKey !== state.activeSessionKey || event.generation !== state.generation) return;

    const start = extractImageGenerationStartFromAcpEnvelope(event);
    if (!start) return;
    recordProjectionTrace({
      event: 'image-generation:start-detected',
      sessionKey: start.sessionKey,
      generation: event.generation,
      details: {
        taskId: start.taskId,
        ...(start.toolCallId ? { toolCallId: start.toolCallId } : {}),
        historical: !!event.historical,
      },
    });
    const session = compatSession(start.sessionKey);
    if (event.historical) {
      session.replayTaskStartedAt = Date.now();
      session.replayTaskIds.add(start.taskId);
      recordImageGenerationStartAnchor(session, start, true);
    } else {
      session.taskStartedAt = Date.now();
      session.taskIds.add(start.taskId);
      recordImageGenerationStartAnchor(session, start, false);
      set((current) => (
        current.activeSessionKey === start.sessionKey
        && current.generation === event.generation
        && !current.pendingImageGenerationTaskIds.includes(start.taskId)
          ? {
            pendingImageGenerationTaskIds: [
              ...current.pendingImageGenerationTaskIds,
              start.taskId,
            ],
          }
          : {}
      ));
      const operation = activeTranscriptSupplement;
      if (
        operation?.liveUserMessageId
        && operation.sessionKey === start.sessionKey
        && operation.generation === event.generation
      ) {
        const isNewTask = !operation.imageTaskIds.has(start.taskId);
        operation.imageTaskIds.add(start.taskId);
        if (isNewTask && operation.terminal) {
          operation.terminal = false;
          operation.retryIndex = 0;
        }
        if (operation.started && !operation.retryTimer) {
          void runLiveTranscriptSupplement(operation);
          scheduleLiveTranscriptSupplement(operation);
        }
      }
    }
  },

  recordVideoGenerationUpdate(event) {
    if (event.historical) return;
    const terminalTaskId = extractVideoGenerationTerminalTaskIdFromAcpEnvelope(event);
    if (terminalTaskId) {
      completeVideoGenerationTask(terminalTaskId);
      return;
    }

    const state = get();
    if (event.sessionKey !== state.activeSessionKey || event.generation !== state.generation) return;
    const start = extractVideoGenerationStartFromAcpEnvelope(event);
    if (!start) return;
    const operation = activeTranscriptSupplement;
    if (
      operation?.liveUserMessageId
      && operation.sessionKey === event.sessionKey
      && operation.generation === event.generation
    ) {
      operation.videoTaskIds.add(start.taskId);
    }
    scheduleVideoGenerationTaskTimeout(start.taskId);
    set((current) => (
      current.activeSessionKey === event.sessionKey
      && current.generation === event.generation
      && !current.pendingVideoGenerationTaskIds.includes(start.taskId)
        ? {
          pendingVideoGenerationTaskIds: [
            ...current.pendingVideoGenerationTaskIds,
            start.taskId,
          ],
        }
        : {}
    ));
    recordProjectionTrace({
      event: 'video-generation:start-detected',
      sessionKey: event.sessionKey,
      generation: event.generation,
      details: {
        taskId: start.taskId,
        ...(start.toolCallId ? { toolCallId: start.toolCallId } : {}),
      },
    });
  },

  settleVideoGenerationTask(taskId) {
    if (!taskId) return;
    clearVideoGenerationTaskTimeout(taskId);
    set((current) => (
      current.pendingVideoGenerationTaskIds.includes(taskId)
        ? {
          pendingVideoGenerationTaskIds: current.pendingVideoGenerationTaskIds.filter(
            (pendingTaskId) => pendingTaskId !== taskId,
          ),
        }
        : {}
    ));
    for (const [sessionKey, snapshot] of liveSessionSnapshots) {
      if (!snapshot.pendingVideoGenerationTaskIds.includes(taskId)) continue;
      liveSessionSnapshots.set(sessionKey, {
        ...snapshot,
        pendingVideoGenerationTaskIds: snapshot.pendingVideoGenerationTaskIds.filter(
          (pendingTaskId) => pendingTaskId !== taskId,
        ),
      });
    }
  },

  async projectImageGenerationCompletion(evidence, options) {
    const state = get();
    if (options?.isCurrent && !options.isCurrent()) {
      recordProjectionTrace({
        event: 'image-generation:projection-rejected',
        sessionKey: state.activeSessionKey ?? evidence.sessionKey ?? null,
        generation: state.generation,
        details: projectionTraceDetails(evidence, { reason: options.staleReason ?? 'stale-projection' }),
      });
      return;
    }
    const sessionKey = resolveImageGenerationProjectionSession(state, evidence);
    if (!sessionKey) {
      recordProjectionTrace({
        event: 'image-generation:projection-rejected',
        sessionKey: state.activeSessionKey ?? evidence.sessionKey ?? null,
        generation: state.generation,
        details: projectionTraceDetails(evidence, { reason: 'no-session-match' }),
      });
      return;
    }
    if (!hasFreshImageGenerationContext(
      sessionKey,
      Date.now(),
      usesReplayImageGenerationContext(evidence),
    )) {
      recordProjectionTrace({
        event: 'image-generation:projection-rejected',
        sessionKey,
        generation: state.generation,
        details: projectionTraceDetails(evidence, { reason: 'no-fresh-context' }),
      });
      return;
    }
    if (options?.isCurrent && !options.isCurrent()) {
      recordProjectionTrace({
        event: 'image-generation:projection-rejected',
        sessionKey,
        generation: state.generation,
        details: projectionTraceDetails(evidence, { reason: options.staleReason ?? 'stale-projection' }),
      });
      return;
    }
    if (evidence.candidates.length === 0 && !evidence.authoritativeCaption) {
      recordProjectionTrace({
        event: 'image-generation:projection-rejected',
        sessionKey,
        generation: state.generation,
        details: projectionTraceDetails(evidence, { reason: 'no-candidates' }),
      });
      return;
    }

    const generation = state.generation;
    const compat = compatSession(sessionKey);
    const correlatedTaskId = evidence.taskId
      ?? imageGenerationTaskIdFromSessionKey(evidence.sessionKey)
      ?? (usesReplayImageGenerationContext(evidence) ? compat.lastReplayTaskId : compat.lastTaskId);
    const settlePendingTask = (current: AcpChatSessionState): string[] => {
      if (!correlatedTaskId) {
        return usesReplayImageGenerationContext(evidence)
          ? current.pendingImageGenerationTaskIds
          : [];
      }
      return current.pendingImageGenerationTaskIds.filter((taskId) => taskId !== correlatedTaskId);
    };
    const key = imageGenerationEvidenceKey({
      ...evidence,
      sessionKey,
      ...(correlatedTaskId ? { taskId: correlatedTaskId } : {}),
    });
    const reconcileSyntheticCompletion = (trackingKey: string): void => {
      const current = get();
      if (!isCurrentAction(current, sessionKey, generation)) return;
      const afterItemId = imageGenerationAnchorItemId(current, sessionKey, evidence);
      if (!trackSyntheticImageCompletion(
        current.timeline,
        sessionKey,
        trackingKey,
        correlatedTaskId,
        afterItemId,
      )) return;
      if (!compat.authoritativeCaptions.has(trackingKey)) return;
      set((latest) => (
        isCurrentAction(latest, sessionKey, generation)
          ? { timeline: reconcileLateAcpImageCompletions(latest.timeline, sessionKey, generation) }
          : {}
      ));
    };
    if (evidence.authoritativeCaption) {
      const captions = compat.authoritativeCaptions;
      const next = { text: evidence.caption, priority: imageGenerationCaptionPriority(evidence.source) };
      const previous = captions.get(key);
      if (!previous || next.priority > previous.priority) captions.set(key, next);
    }
    const reservationOwner = options?.reservationOwner ?? `projection:${imageProjectionSeq += 1}`;
    if (!reserveDelivery(sessionKey, key, reservationOwner, Boolean(options?.reservationOwner))) {
      if (evidence.authoritativeCaption) {
        const preferredCaption = compatSession(sessionKey).authoritativeCaptions.get(key)?.text ?? evidence.caption;
        set((current) => ({
          timeline: replaceSyntheticImageCaption(current.timeline, key, preferredCaption),
        }));
        reconcileSyntheticCompletion(key);
      }
      recordProjectionTrace({
        event: 'image-generation:projection-deduped',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence),
      });
      if (compat.delivered.has(key)) {
        set((current) => ({
          pendingImageGenerationTaskIds: settlePendingTask(current),
        }));
        stopLiveTranscriptSupplementRetry(sessionKey, generation, correlatedTaskId);
      }
      return;
    }

    const resolvedCandidates: Array<{
      candidate: ImageGenerationMediaCandidate;
      identity: string;
      mimeType: string;
      target: Extract<ResolveAttachmentResult, { ok: true }>['target'];
    }> = [];
    let unresolvedCandidateCount = 0;
    for (const candidate of evidence.candidates) {
      let result: ResolveAttachmentResult;
      try {
        result = await hostApi.files.resolveAttachment({
          ref: {
            sessionKey,
            generation,
            uri: imageCandidateUri(candidate),
            ...(options?.transcriptMessageId ? { transcriptMessageId: options.transcriptMessageId } : {}),
          },
          ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
        });
      } catch {
        result = { ok: false, displayName: safeAttachmentName(candidate.key), error: 'operationFailed' };
      }
      recordProjectionTrace({
        event: result.ok ? 'image-generation:resolution-available' : 'image-generation:resolution-unavailable',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, {
          reason: result.ok ? 'available' : result.error,
          evidenceHash: hashOpenClawMediaDiagnostic(evidence.evidenceId),
          ...(result.ok ? { identityHash: hashOpenClawMediaDiagnostic(result.identity) } : {}),
        }),
      });
      if (result.ok) {
        if (!resolvedCandidates.some((entry) => entry.identity === result.identity)) {
          resolvedCandidates.push({
            candidate,
            identity: result.identity,
            mimeType: result.mimeType,
            target: result.target,
          });
        }
      } else {
        unresolvedCandidateCount += 1;
      }
      if (
        !ownsDeliveryReservation(sessionKey, key, reservationOwner)
        || (options?.isCurrent && !options.isCurrent())
        || !isCurrentAction(get(), sessionKey, generation)
      ) {
        releaseDelivery(sessionKey, key, reservationOwner);
        recordProjectionTrace({
          event: 'image-generation:projection-dropped',
          sessionKey,
          generation,
          details: projectionTraceDetails(evidence, { reason: options?.staleReason ?? 'stale-resolution' }),
        });
        return;
      }
    }

    let thumbnails: MediaThumbnailResult = {};
    try {
      const paths = resolvedCandidates.flatMap(({ identity, mimeType, target }) => (
        target.kind === 'local'
          ? [{ attachmentFileRef: target.ref, key: identity, mimeType }]
          : []
      ));
      if (paths.length > 0) thumbnails = await hostApi.media.thumbnails({ paths });
      recordProjectionTrace({
        event: 'image-generation:thumbnail-result',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, {
          previewCount: resolvedCandidates.filter(({ identity }) => Boolean(thumbnails[identity]?.preview)).length,
        }),
      });
    } catch {
      thumbnails = {};
      recordProjectionTrace({
        event: 'image-generation:thumbnail-result',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, { previewCount: 0, error: true }),
      });
    }

    const latest = get();
    if (!ownsDeliveryReservation(sessionKey, key, reservationOwner) || (options?.isCurrent && !options.isCurrent())) {
      releaseDelivery(sessionKey, key, reservationOwner);
      recordProjectionTrace({
        event: 'image-generation:projection-dropped',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, { reason: options?.staleReason ?? 'stale-projection' }),
      });
      return;
    }
    if (latest.activeSessionKey !== sessionKey || latest.generation !== generation) {
      releaseDelivery(sessionKey, key, reservationOwner);
      recordProjectionTrace({
        event: 'image-generation:projection-dropped',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, {
          reason: 'stale-generation',
          latestGeneration: latest.generation,
        }),
      });
      return;
    }

    const imageParts: RenderPart[] = [];
    for (const { candidate, identity, mimeType, target } of resolvedCandidates) {
      const resolved = thumbnails[identity];
      if (!resolved?.preview) continue;
      imageParts.push({
        kind: 'image',
        source: resolved.preview,
        mimeType: candidate.mimeType ?? mimeType,
        alt: i18n.t('chat:acp.image'),
        mediaIdentity: identity,
        ...(target.kind === 'local' ? { attachmentFileRef: target.ref } : {}),
      });
    }

    const missingCount = unresolvedCandidateCount + resolvedCandidates.length - imageParts.length;
    if (missingCount > 0) releaseDelivery(sessionKey, key, reservationOwner);
    const authoritativeCaption = imageGenerationCompatSessions.get(sessionKey)?.authoritativeCaptions.get(key)?.text;
    const caption = authoritativeCaption
      ? authoritativeCaption
      : imageParts.length === 0
        ? i18n.t('chat:imageGeneration.previewUnavailable')
        : missingCount > 0
          ? i18n.t('chat:imageGeneration.generatedReadyWithMissing')
          : i18n.t('chat:imageGeneration.generatedReady');
    const afterItemId = imageGenerationAnchorItemId(latest, sessionKey, evidence);
    const matchingAcpItemId = authoritativeCaption
      ? matchingAcpImageCompletionItemId(
          latest.timeline,
          afterItemId,
          caption,
          sessionKey,
          correlatedTaskId,
          key,
        )
      : undefined;
    if (matchingAcpItemId) {
      set((current) => ({
        timeline: mergeImageCompletionIntoAcpItem(current.timeline, matchingAcpItemId, key, imageParts),
        pendingImageGenerationTaskIds: settlePendingTask(current),
      }));
      if (missingCount === 0) commitDelivery(sessionKey, key, reservationOwner);
      else releaseDelivery(sessionKey, key, reservationOwner);
      recordProjectionTrace({
        event: 'image-generation:projection-merged',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, { reason: 'matching-acp-reply' }),
      });
      stopLiveTranscriptSupplementRetry(sessionKey, generation, correlatedTaskId);
      return;
    }
    const duplicateItemId = matchingSyntheticImageItemId(latest.timeline, imageParts);
    if (duplicateItemId) {
      const existingItem = latest.timeline.itemsById[duplicateItemId];
      const existingKey = existingItem?.kind === 'message-segment' ? existingItem.compat?.evidenceId : undefined;
      const captions = imageGenerationCompatSessions.get(sessionKey)?.authoritativeCaptions;
      const currentCaption = captions?.get(key);
      const existingCaption = existingKey ? captions?.get(existingKey) : undefined;
      if (existingKey && currentCaption && (!existingCaption || currentCaption.priority > existingCaption.priority)) {
        captions?.set(existingKey, currentCaption);
        set((current) => ({
          timeline: replaceSyntheticImageCaptionAtItem(current.timeline, duplicateItemId, currentCaption.text),
          pendingImageGenerationTaskIds: settlePendingTask(current),
        }));
        reconcileSyntheticCompletion(existingKey);
      }
      set((current) => ({
        pendingImageGenerationTaskIds: settlePendingTask(current),
      }));
      if (missingCount === 0) commitDelivery(sessionKey, key, reservationOwner);
      else releaseDelivery(sessionKey, key, reservationOwner);
      recordProjectionTrace({
        event: 'image-generation:projection-deduped',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, { reason: 'resolved-media-identity' }),
      });
      stopLiveTranscriptSupplementRetry(sessionKey, generation, correlatedTaskId);
      return;
    }
    const parts: RenderPart[] = [{ kind: 'markdown', text: caption }, ...imageParts];

    set((current) => {
      if (current.activeSessionKey !== sessionKey || current.generation !== generation) return {};
      return {
        timeline: appendSyntheticAssistantMessage(current.timeline, {
          messageId: messageIdFromEvidence(key),
          evidenceId: key,
          parts,
          afterItemId,
        }),
        pendingImageGenerationTaskIds: settlePendingTask(current),
      };
    });
    reconcileSyntheticCompletion(key);
    if (missingCount === 0) commitDelivery(sessionKey, key, reservationOwner);
    recordProjectionTrace({
      event: 'image-generation:projection-appended',
      sessionKey,
      generation,
      details: projectionTraceDetails(evidence, { imageCount: imageParts.length, missingCount }),
    });
    stopLiveTranscriptSupplementRetry(sessionKey, generation, correlatedTaskId);
  },

  applyUpdateEnvelope(event) {
    const state = get();
    if (state.loading) {
      if (event.sessionKey === state.activeSessionKey) {
        const updates = pendingLoadUpdates.get(event.generation) ?? [];
        pendingLoadUpdates.set(event.generation, [...updates, event]);
      } else {
        const liveSnapshot = liveSessionSnapshots.get(event.sessionKey);
        if (liveSnapshot?.generation === event.generation) {
          liveSessionSnapshots.set(event.sessionKey, applyVideoGenerationUpdateToSnapshot(deferInactiveImageUpdate({
            ...liveSnapshot,
            timeline: applyAcpSessionUpdate(
              liveSnapshot.timeline,
              event.notification,
              { historical: !!event.historical },
            ),
          }, event), event));
        }
      }
      return;
    }
    if (event.sessionKey !== state.activeSessionKey || event.generation !== state.generation) {
      const liveSnapshot = liveSessionSnapshots.get(event.sessionKey);
      if (liveSnapshot?.generation === event.generation) {
        liveSessionSnapshots.set(event.sessionKey, applyVideoGenerationUpdateToSnapshot(deferInactiveImageUpdate({
          ...liveSnapshot,
          timeline: applyAcpSessionUpdate(
            liveSnapshot.timeline,
            event.notification,
            { historical: !!event.historical },
          ),
        }, event), event));
      }
      return;
    }
    const updatedTimeline = applyAcpSessionUpdate(state.timeline, event.notification, { historical: !!event.historical });
    const timeline = isLiveMessageUpdate(event)
      ? reconcileLateAcpImageCompletions(updatedTimeline, event.sessionKey, event.generation)
      : updatedTimeline;
    const pending = newPendingAttachments(state.timeline, timeline);
    set({ timeline });
    if (state.sending) {
      const liveSnapshot = liveSessionSnapshots.get(event.sessionKey);
      if (liveSnapshot?.generation === event.generation) {
        liveSessionSnapshots.set(event.sessionKey, { ...liveSnapshot, timeline });
      }
    }
    resolvePendingAttachments(event.sessionKey, event.generation, pending);
    get().recordImageGenerationStart(event);
    get().recordVideoGenerationUpdate(event);
    const evidence = extractImageGenerationCompletionFromAcpEnvelope(event);
    if (evidence) void get().projectImageGenerationCompletion(evidence);
  },

  applyPermissionRequest(event) {
    const state = get();
    if (event.sessionKey !== state.activeSessionKey || event.generation !== state.generation) {
      const liveSnapshot = liveSessionSnapshots.get(event.sessionKey);
      if (liveSnapshot?.generation === event.generation) {
        liveSessionSnapshots.set(event.sessionKey, {
          ...liveSnapshot,
          timeline: applyPermissionRequestToTimeline(liveSnapshot.timeline, event),
        });
      }
      return;
    }

    const timeline = applyPermissionRequestToTimeline(state.timeline, event);
    set({ timeline });
    if (state.sending) {
      const liveSnapshot = liveSessionSnapshots.get(event.sessionKey);
      if (liveSnapshot?.generation === event.generation) {
        liveSessionSnapshots.set(event.sessionKey, { ...liveSnapshot, timeline });
      }
    }
  },

  clearError() {
    set({ error: null });
  },
}));

let acpChatSubscribed = false;

export function ensureAcpChatSubscriptions(): void {
  if (acpChatSubscribed) return;
  acpChatSubscribed = true;
  hostEvents.onAcpSessionUpdate((event) => {
    useAcpChatSessionStore.getState().applyUpdateEnvelope(event);
  });
  hostEvents.onAcpPermissionRequest((event) => {
    useAcpChatSessionStore.getState().applyPermissionRequest(event);
  });
  hostEvents.onGatewayChatMessage((event) => {
    const videoTaskId = extractVideoGenerationTerminalTaskIdFromGatewayChatMessage(event);
    const evidence = extractImageGenerationCompletionFromGatewayChatMessage(event);
    const state = useAcpChatSessionStore.getState();
    if (videoTaskId) completeVideoGenerationTask(videoTaskId);
    if (
      evidence
      && !deferInactiveImageGenerationCompletion(state.activeSessionKey, evidence)
    ) void state.projectImageGenerationCompletion(evidence);
  });
  hostEvents.onChatRuntimeEvent((event) => {
    const videoTaskId = extractVideoGenerationTerminalTaskIdFromRuntimeEvent(event);
    const evidence = extractImageGenerationCompletionFromRuntimeEvent(event);
    const state = useAcpChatSessionStore.getState();
    if (videoTaskId) completeVideoGenerationTask(videoTaskId);
    if (
      evidence
      && !deferInactiveImageGenerationCompletion(state.activeSessionKey, evidence)
    ) void state.projectImageGenerationCompletion(evidence);
  });
}
