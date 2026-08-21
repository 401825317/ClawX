import { create } from 'zustand';
import type {
  AcpChatLoadPayload,
  AcpChatOperationResult,
  AcpChatPromptPayload,
  AcpChatRespondPermissionPayload,
  AcpPermissionRequestEnvelope,
  AcpSessionUpdateEnvelope,
} from '@shared/acp-chat/types';
import {
  normalizeAcpChatError,
  type AcpChatErrorCode,
  type AcpChatErrorDetails,
} from '@shared/acp-chat/errors';
import type {
  MediaThumbnailResult,
  ResolveAttachmentPayload,
  ResolveAttachmentResult,
  SessionTurnTimingCandidate,
} from '@shared/host-api/contract';
import {
  UCLAW_IMAGE_GENERATION_TIMEOUT_MS,
  UCLAW_VIDEO_GENERATION_TIMEOUT_MS,
} from '@shared/junfeiai-endpoints';
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
  extractVideoGenerationTerminalFromAcpEnvelope,
  extractVideoGenerationTerminalTaskIdFromGatewayChatMessage,
  extractVideoGenerationTerminalTaskIdFromRuntimeEvent,
} from '@/lib/acp/video-generation-status';
import {
  applyAttachmentResolution,
  attachmentRequestFingerprint,
  collectPendingAttachments,
  createPendingAttachment,
  type PendingAttachmentLocation,
} from '@/lib/acp/attachments';
import { restoreBackgroundMediaProjections } from '@/lib/acp/background-media-projections';
import {
  appendSyntheticAssistantMessage,
  applyAcpSessionUpdate,
  createEmptyAcpTimeline,
  upsertSyntheticTurnAttachments,
} from '@/lib/acp/reducer';
import {
  AcpSessionTimelineCoordinator,
  type SessionTimelineIdentity,
  type SessionTimelineRecord,
} from '@/lib/acp/session-timeline-coordinator';
import {
  acpUserTurns,
  hashOpenClawMediaDiagnostic,
  type OpenClawMediaCandidate,
} from '@/lib/acp/openclaw-media-compat';
import { openClawResourceLinkPromptText } from '@/lib/acp/openclaw-prompt-compat';
import {
  fetchFailedOpenClawTurnSupplement,
  fetchOpenClawTranscriptSupplement,
} from '@/lib/acp/transcript-supplement';
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
const IMAGE_GENERATION_PENDING_TIMEOUT_MS = UCLAW_IMAGE_GENERATION_TIMEOUT_MS + 15_000;
const VIDEO_GENERATION_PENDING_TIMEOUT_MS = UCLAW_VIDEO_GENERATION_TIMEOUT_MS + 15_000;
const VIDEO_GENERATION_TRANSCRIPT_RETRY_DELAYS_MS = [500, 1500, 3000, 5000, 8000];
const LIVE_TEXT_BATCH_WINDOW_MS = 32;
const LIVE_TEXT_BATCH_MAX_UPDATES = 128;
const MAX_SETTLED_BACKGROUND_SNAPSHOTS = 3;
const MAX_CACHED_TURN_TIMING_SESSIONS = 32;

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
const browserFailureCancelOperationIds = new Set<number>();
const browserFailureCancelPromises = new Map<string, Promise<boolean>>();
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
  /** Background media committed after navigation and not yet restored into a fresh ACP replay. */
  unconsumedTimelineUpdate: boolean;
};
const liveSessionSnapshots = new Map<string, LiveSessionSnapshot>();
const completedLiveTurnTimings = new Map<string, SessionTurnTimingCandidate[]>();
const sessionTimelineCoordinator = new AcpSessionTimelineCoordinator({ maxUnretainedRecords: 3 });
const imageGenerationTaskTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
  const pendingImageGenerationTaskIds = start
    && !event.historical
    && !snapshot.pendingImageGenerationTaskIds.includes(start.taskId)
    ? [...snapshot.pendingImageGenerationTaskIds, start.taskId]
    : snapshot.pendingImageGenerationTaskIds;
  if (start && !event.historical) {
    scheduleImageGenerationTaskTimeout(snapshot.sessionKey, start.taskId);
  }
  return { ...snapshot, deferredImageUpdates, pendingImageGenerationTaskIds };
}

type TranscriptSupplementOperation = {
  id: number;
  key: string;
  sessionKey: string;
  generation: number;
  executionCwd: string;
  retainOwner: string;
  attempt: number;
  retryIndex: number;
  imageTaskIds: Set<string>;
  completedTaskIds: Set<string>;
  videoTaskIds: Set<string>;
  completedVideoTaskIds: Set<string>;
  videoRequesterProbe: boolean;
  videoRetryIndex: number;
  videoRetryEpoch: number;
  started: boolean;
  terminal: boolean;
  cancelled: boolean;
  mediaCandidateSeen: boolean;
  authorizedMediaDelivered: boolean;
  browserReleased: boolean;
  inFlight?: Promise<number>;
  liveUserMessageId?: string;
  retryTimer?: ReturnType<typeof setTimeout>;
  videoRetryTimer?: ReturnType<typeof setTimeout>;
};

let transcriptSupplementSeq = 0;
const transcriptSupplements = new Map<string, TranscriptSupplementOperation>();
let imageProjectionSeq = 0;
type PendingLiveTextBatch = {
  key: string;
  events: AcpSessionUpdateEnvelope[];
  timer: ReturnType<typeof setTimeout>;
};
let pendingLiveTextBatch: PendingLiveTextBatch | undefined;

type ImageGenerationProjectionOptions = {
  isCurrent?: () => boolean;
  staleReason?: string;
  transcriptMessageId?: string;
  reservationOwner?: string;
  /** Session generation that owns a transcript completion after navigation. */
  owner?: SessionTimelineIdentity;
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

function sessionIdentity(sessionKey: string, generation: number): SessionTimelineIdentity {
  return { sessionKey, generation };
}

/** Keeps the coordinator synchronized without creating revisions for identical snapshots. */
function syncTimelineRecord(input: {
  sessionKey: string;
  generation: number;
  workspaceRoot: string | null;
  cwd: string | null;
  timeline: AcpTimelineSnapshot;
}): SessionTimelineRecord {
  const identity = sessionIdentity(input.sessionKey, input.generation);
  const existing = sessionTimelineCoordinator.read(identity);
  if (
    existing
    && existing.timeline === input.timeline
    && existing.workspaceRoot === input.workspaceRoot
    && existing.cwd === input.cwd
  ) return existing;
  return sessionTimelineCoordinator.replace(input);
}

function hasTranscriptSupplementWork(sessionKey: string, generation: number): boolean {
  return [...transcriptSupplements.values()].some((operation) => (
    operation.sessionKey === sessionKey
    && operation.generation === generation
    && !operation.cancelled
    && !operation.terminal
  ));
}

/** Retains exact completed live timings independently from short-lived media snapshots. */
function rememberCompletedLiveTurnTimings(snapshot: Pick<
  LiveSessionSnapshot,
  'sessionKey' | 'timeline' | 'turnTimingsByUserMessageId'
>): void {
  const candidates = acpUserTurns(snapshot.timeline).flatMap((turn) => {
    const timing = snapshot.turnTimingsByUserMessageId[turn.turnId];
    if (timing?.source !== 'live' || timing.status !== 'complete') return [];
    return [{
      normalizedUserText: turn.normalizedUserText,
      userOccurrenceFromTail: turn.userOccurrenceFromTail,
      durationMs: timing.durationMs,
    }];
  });
  if (candidates.length === 0) return;

  // Map insertion order acts as a bounded LRU for renderer-session lifetime.
  completedLiveTurnTimings.delete(snapshot.sessionKey);
  completedLiveTurnTimings.set(snapshot.sessionKey, candidates);
  while (completedLiveTurnTimings.size > MAX_CACHED_TURN_TIMING_SESSIONS) {
    const oldestSessionKey = completedLiveTurnTimings.keys().next().value;
    if (typeof oldestSessionKey !== 'string') break;
    completedLiveTurnTimings.delete(oldestSessionKey);
  }
}

/** Rebinds exact live timings to replayed message ids and gives them precedence over transcript estimates. */
function restoreCompletedLiveTurnTimings(
  sessionKey: string,
  timeline: AcpTimelineSnapshot,
  fallback: Record<string, AcpTurnTiming>,
): Record<string, AcpTurnTiming> {
  const candidates = completedLiveTurnTimings.get(sessionKey);
  if (!candidates?.length) return fallback;
  const aligned = alignHistoricalTurnTimings(timeline, candidates);
  if (Object.keys(aligned).length === 0) return fallback;

  const exact = Object.fromEntries(Object.entries(aligned).flatMap(([messageId, timing]) => (
    timing.status === 'complete'
      ? [[
        messageId,
        { source: 'live', status: 'complete', durationMs: timing.durationMs } satisfies AcpTurnTiming,
      ]]
      : []
  )));
  return { ...fallback, ...exact };
}

/** Keeps current live timers authoritative when a delayed transcript supplement arrives. */
function mergeHistoricalTurnTimings(
  sessionKey: string,
  timeline: AcpTimelineSnapshot,
  current: Record<string, AcpTurnTiming>,
  historical: SessionTurnTimingCandidate[],
): Record<string, AcpTurnTiming> {
  const fallback = restoreCompletedLiveTurnTimings(
    sessionKey,
    timeline,
    alignHistoricalTurnTimings(timeline, historical),
  );
  const live = Object.fromEntries(acpUserTurns(timeline).flatMap((turn) => {
    const timing = current[turn.turnId];
    return timing?.source === 'live' ? [[turn.turnId, timing]] : [];
  }));
  return { ...fallback, ...live };
}

function captureLiveSession(state: AcpChatSessionState): void {
  if (!state.activeSessionKey) return;
  const existing = liveSessionSnapshots.get(state.activeSessionKey);
  const snapshot: LiveSessionSnapshot = {
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
    unconsumedTimelineUpdate: existing?.unconsumedTimelineUpdate ?? false,
  };
  syncTimelineRecord(snapshot);
  storeLiveSessionSnapshot(snapshot);
}

function hasLiveSessionSnapshotWork(snapshot: LiveSessionSnapshot): boolean {
  return hasRequiredLiveSessionSnapshotWork(snapshot)
    || snapshot.unconsumedTimelineUpdate;
}

function hasRequiredLiveSessionSnapshotWork(snapshot: LiveSessionSnapshot): boolean {
  return snapshot.sending
    || hasPendingBackgroundMediaSnapshotWork(snapshot)
    || hasTranscriptSupplementWork(snapshot.sessionKey, snapshot.generation)
    || Boolean(sessionTimelineCoordinator.read(sessionIdentity(
      snapshot.sessionKey,
      snapshot.generation,
    ))?.retained);
}

function hasBackgroundMediaSnapshotWork(snapshot: LiveSessionSnapshot): boolean {
  return hasPendingBackgroundMediaSnapshotWork(snapshot)
    || snapshot.unconsumedTimelineUpdate;
}

function hasPendingBackgroundMediaSnapshotWork(snapshot: LiveSessionSnapshot): boolean {
  return snapshot.pendingImageGenerationTaskIds.length > 0
    || snapshot.pendingVideoGenerationTaskIds.length > 0
    || snapshot.deferredImageUpdates.length > 0
    || snapshot.deferredImageCompletions.length > 0;
}

function hasImageSnapshotWork(snapshot: LiveSessionSnapshot): boolean {
  return snapshot.pendingImageGenerationTaskIds.length > 0
    || snapshot.deferredImageUpdates.length > 0
    || snapshot.deferredImageCompletions.length > 0;
}

function deleteLiveSessionSnapshot(sessionKey: string, generation: number): void {
  if (liveSessionSnapshots.get(sessionKey)?.generation === generation) {
    liveSessionSnapshots.delete(sessionKey);
  }
}

/** Bounds settled compatibility overlays without evicting accepted in-flight delivery. */
function pruneSettledBackgroundSnapshots(): void {
  const settled = [...liveSessionSnapshots.entries()].filter(([, snapshot]) => (
    snapshot.unconsumedTimelineUpdate && !hasRequiredLiveSessionSnapshotWork(snapshot)
  ));
  while (settled.length > MAX_SETTLED_BACKGROUND_SNAPSHOTS) {
    const oldest = settled.shift();
    if (oldest) liveSessionSnapshots.delete(oldest[0]);
  }
}

function storeLiveSessionSnapshot(snapshot: LiveSessionSnapshot): void {
  rememberCompletedLiveTurnTimings(snapshot);
  syncTimelineRecord(snapshot);
  if (hasLiveSessionSnapshotWork(snapshot)) {
    // Map insertion order is the LRU clock for settled, not-yet-consumed overlays.
    liveSessionSnapshots.delete(snapshot.sessionKey);
    liveSessionSnapshots.set(snapshot.sessionKey, snapshot);
    pruneSettledBackgroundSnapshots();
    return;
  }
  liveSessionSnapshots.delete(snapshot.sessionKey);
}

function pruneSettledActiveSnapshot(state: AcpChatSessionState): void {
  if (!state.activeSessionKey) return;
  const snapshot = liveSessionSnapshots.get(state.activeSessionKey);
  if (snapshot?.generation !== state.generation) return;
  storeLiveSessionSnapshot({
    ...snapshot,
    sending: state.sending,
    pendingImageGenerationTaskIds: state.pendingImageGenerationTaskIds,
    pendingVideoGenerationTaskIds: state.pendingVideoGenerationTaskIds,
    timeline: state.timeline,
    turnTimingsByUserMessageId: state.turnTimingsByUserMessageId,
  });
}

function normalizedImageProjectionKey(
  evidence: ImageGenerationCompletionEvidence,
  sessionKey: string,
): string {
  const taskId = evidence.taskId ?? imageGenerationTaskIdFromSessionKey(evidence.sessionKey);
  return imageGenerationEvidenceKey({
    ...evidence,
    sessionKey,
    ...(taskId ? { taskId } : {}),
  });
}

/** Consumes only the deferred evidence represented by a successfully committed projection. */
function consumeDeferredImageProjection(input: {
  sessionKey: string;
  generation: number;
  evidence: ImageGenerationCompletionEvidence;
  correlatedTaskId: string | undefined;
}): void {
  const snapshot = liveSessionSnapshots.get(input.sessionKey);
  if (snapshot?.generation !== input.generation) return;

  const rawEvidenceKey = imageGenerationEvidenceKey(input.evidence);
  const projectionKey = normalizedImageProjectionKey(input.evidence, input.sessionKey);
  const matchesEvidence = (candidate: ImageGenerationCompletionEvidence): boolean => (
    imageGenerationEvidenceKey(candidate) === rawEvidenceKey
    || normalizedImageProjectionKey(candidate, input.sessionKey) === projectionKey
  );
  const deferredImageUpdates = snapshot.deferredImageUpdates.filter(({ event }) => {
    const start = extractImageGenerationStartFromAcpEnvelope(event);
    if (input.correlatedTaskId && start?.taskId === input.correlatedTaskId) return false;
    const evidence = extractImageGenerationCompletionFromAcpEnvelope(event);
    return !evidence || !matchesEvidence(evidence);
  });
  const deferredImageCompletions = snapshot.deferredImageCompletions.filter(
    ({ evidence }) => !matchesEvidence(evidence),
  );
  storeLiveSessionSnapshot({
    ...snapshot,
    deferredImageUpdates,
    deferredImageCompletions,
  });
}

function applyVideoGenerationUpdateToSnapshot(
  snapshot: LiveSessionSnapshot,
  event: AcpSessionUpdateEnvelope,
): LiveSessionSnapshot {
  if (event.historical) return snapshot;
  const terminal = extractVideoGenerationTerminalFromAcpEnvelope(event);
  const start = extractVideoGenerationStartFromAcpEnvelope(event);
  let pendingVideoGenerationTaskIds = snapshot.pendingVideoGenerationTaskIds;
  let timeline = snapshot.timeline;
  if (terminal) {
    clearVideoGenerationTaskTimeout(terminal.taskId);
    pendingVideoGenerationTaskIds = pendingVideoGenerationTaskIds.filter((taskId) => taskId !== terminal.taskId);
    if (terminal.status === 'failed') timeline = appendVideoGenerationFailure(timeline, terminal.taskId);
  }
  if (start && !pendingVideoGenerationTaskIds.includes(start.taskId)) {
    scheduleVideoGenerationTaskTimeout(snapshot.sessionKey, snapshot.generation, start.taskId);
    pendingVideoGenerationTaskIds = [...pendingVideoGenerationTaskIds, start.taskId];
  }
  return pendingVideoGenerationTaskIds === snapshot.pendingVideoGenerationTaskIds && timeline === snapshot.timeline
    ? snapshot
    : { ...snapshot, pendingVideoGenerationTaskIds, timeline };
}

/** Adds one deterministic user-visible failure without exposing internal provider details. */
function appendVideoGenerationFailure(
  timeline: AcpTimelineSnapshot,
  taskId: string,
): AcpTimelineSnapshot {
  const evidenceId = `video-generation:${taskId}:failed`;
  return appendSyntheticAssistantMessage(timeline, {
    messageId: `compat:${evidenceId}`,
    evidenceId,
    source: 'video-generation',
    parts: [{ kind: 'error', message: i18n.t('chat:videoGeneration.failed') }],
  });
}

/** Starts one deadline for the task's stable session owner across generation reloads. */
function scheduleImageGenerationTaskTimeout(sessionKey: string, taskId: string): void {
  const existing = imageGenerationTaskTimers.get(taskId);
  if (existing) return;
  const timer = setTimeout(() => {
    imageGenerationTaskTimers.delete(taskId);
    expireImageGenerationTask(sessionKey, taskId);
  }, IMAGE_GENERATION_PENDING_TIMEOUT_MS);
  imageGenerationTaskTimers.set(taskId, timer);
}

function clearImageGenerationTaskTimeout(taskId: string): void {
  const timer = imageGenerationTaskTimers.get(taskId);
  if (timer) clearTimeout(timer);
  imageGenerationTaskTimers.delete(taskId);
}

function scheduleVideoGenerationTaskTimeout(
  sessionKey: string,
  generation: number,
  taskId: string,
): void {
  const existing = videoGenerationTaskTimers.get(taskId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    videoGenerationTaskTimers.delete(taskId);
    expireVideoGenerationTask(sessionKey, generation, taskId);
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

function transcriptSupplementKey(
  sessionKey: string,
  generation: number,
  liveUserMessageId?: string,
): string {
  return JSON.stringify([sessionKey, generation, liveUserMessageId ?? 'history']);
}

function operationTimeline(operation: TranscriptSupplementOperation): AcpTimelineSnapshot | undefined {
  const state = useAcpChatSessionStore.getState();
  if (isCurrentAction(state, operation.sessionKey, operation.generation)) return state.timeline;
  const snapshot = liveSessionSnapshots.get(operation.sessionKey);
  if (snapshot?.generation === operation.generation) return snapshot.timeline;
  return sessionTimelineCoordinator.read(sessionIdentity(operation.sessionKey, operation.generation))?.timeline;
}

/** Releases only one Turn operation; unrelated sessions and Turns remain active. */
function invalidateTranscriptSupplement(operation: TranscriptSupplementOperation): void {
  if (transcriptSupplements.get(operation.key)?.id !== operation.id) return;
  operation.cancelled = true;
  operation.terminal = true;
  if (operation.retryTimer) clearTimeout(operation.retryTimer);
  if (operation.videoRetryTimer) clearTimeout(operation.videoRetryTimer);
  operation.retryTimer = undefined;
  operation.videoRetryTimer = undefined;
  transcriptSupplements.delete(operation.key);
  sessionTimelineCoordinator.release(
    sessionIdentity(operation.sessionKey, operation.generation),
    operation.retainOwner,
  );
  const snapshot = liveSessionSnapshots.get(operation.sessionKey);
  if (snapshot?.generation === operation.generation) storeLiveSessionSnapshot(snapshot);
}

function liveTranscriptOperations(sessionKey: string, generation?: number): TranscriptSupplementOperation[] {
  return [...transcriptSupplements.values()]
    .filter((operation) => (
      operation.liveUserMessageId
      && operation.sessionKey === sessionKey
      && (generation == null || operation.generation === generation)
      && !operation.cancelled
    ))
    .sort((left, right) => left.id - right.id);
}

function latestLiveTranscriptOperation(
  sessionKey: string,
  generation: number,
): TranscriptSupplementOperation | undefined {
  return liveTranscriptOperations(sessionKey, generation).at(-1);
}

/** Ends the expired task at its current generation without crossing the owning session boundary. */
function expireImageGenerationTask(sessionKey: string, taskId: string): void {
  const state = useAcpChatSessionStore.getState();
  if (
    state.activeSessionKey === sessionKey
    && state.pendingImageGenerationTaskIds.includes(taskId)
  ) {
    useAcpChatSessionStore.setState((current) => (
      current.activeSessionKey === sessionKey
      && current.pendingImageGenerationTaskIds.includes(taskId)
        ? {
          pendingImageGenerationTaskIds: current.pendingImageGenerationTaskIds.filter(
            (pendingTaskId) => pendingTaskId !== taskId,
          ),
        }
        : {}
    ));
  } else {
    const snapshot = liveSessionSnapshots.get(sessionKey);
    if (snapshot?.pendingImageGenerationTaskIds.includes(taskId)) {
      storeLiveSessionSnapshot({
        ...snapshot,
        pendingImageGenerationTaskIds: snapshot.pendingImageGenerationTaskIds.filter(
          (pendingTaskId) => pendingTaskId !== taskId,
        ),
      });
    }
  }

  for (const operation of liveTranscriptOperations(sessionKey)) {
    if (!operation.imageTaskIds.has(taskId)) continue;
    operation.completedTaskIds.add(taskId);
    const hasPendingImage = [...operation.imageTaskIds]
      .some((pendingTaskId) => !operation.completedTaskIds.has(pendingTaskId));
    const hasPendingVideo = [...operation.videoTaskIds]
      .some((pendingTaskId) => !operation.completedVideoTaskIds.has(pendingTaskId));
    if (!hasPendingImage && !hasPendingVideo) invalidateTranscriptSupplement(operation);
  }

  const latest = useAcpChatSessionStore.getState();
  if (latest.activeSessionKey === sessionKey) pruneSettledActiveSnapshot(latest);
}

/** Releases a video Turn only when its generation deadline expires before delivery. */
function expireVideoGenerationTask(sessionKey: string, generation: number, taskId: string): void {
  useAcpChatSessionStore.getState().settleVideoGenerationTask(taskId);
  for (const operation of liveTranscriptOperations(sessionKey, generation)) {
    if (!operation.videoTaskIds.has(taskId)) continue;
    operation.completedVideoTaskIds.add(taskId);
    const hasPendingImage = [...operation.imageTaskIds]
      .some((pendingTaskId) => !operation.completedTaskIds.has(pendingTaskId));
    const hasPendingVideo = [...operation.videoTaskIds]
      .some((pendingTaskId) => !operation.completedVideoTaskIds.has(pendingTaskId));
    if (!hasPendingImage && !hasPendingVideo) invalidateTranscriptSupplement(operation);
  }
}

/** Settles the task's original transcript operation after its snapshot generation is rebound. */
function stopLiveTranscriptSupplementRetry(sessionKey: string, taskId?: string): void {
  if (!taskId) return;
  clearImageGenerationTaskTimeout(taskId);
  for (const operation of liveTranscriptOperations(sessionKey)) {
    if (!operation.imageTaskIds.has(taskId)) continue;
    operation.completedTaskIds.add(taskId);
    if ([...operation.imageTaskIds].some((id) => !operation.completedTaskIds.has(id))) continue;
    operation.terminal = true;
    if (operation.retryTimer) clearTimeout(operation.retryTimer);
    operation.retryTimer = undefined;
    const hasPendingVideo = [...operation.videoTaskIds]
      .some((id) => !operation.completedVideoTaskIds.has(id));
    if (!hasPendingVideo) invalidateTranscriptSupplement(operation);
  }
}

function beginTranscriptSupplement(
  sessionKey: string,
  generation: number,
  executionCwd: string,
  liveUserMessageId?: string,
): TranscriptSupplementOperation {
  const key = transcriptSupplementKey(sessionKey, generation, liveUserMessageId);
  const previous = transcriptSupplements.get(key);
  if (previous) invalidateTranscriptSupplement(previous);
  transcriptSupplementSeq += 1;
  const retainOwner = `transcript:${transcriptSupplementSeq}`;
  const operation: TranscriptSupplementOperation = {
    id: transcriptSupplementSeq,
    key,
    sessionKey,
    generation,
    executionCwd,
    retainOwner,
    attempt: 0,
    retryIndex: 0,
    imageTaskIds: new Set<string>(),
    completedTaskIds: new Set<string>(),
    videoTaskIds: new Set<string>(),
    completedVideoTaskIds: new Set<string>(),
    videoRequesterProbe: false,
    videoRetryIndex: 0,
    videoRetryEpoch: 0,
    started: false,
    terminal: false,
    cancelled: false,
    mediaCandidateSeen: false,
    authorizedMediaDelivered: false,
    browserReleased: false,
    ...(liveUserMessageId ? { liveUserMessageId } : {}),
  };
  const state = useAcpChatSessionStore.getState();
  if (isCurrentAction(state, sessionKey, generation)) {
    syncTimelineRecord({
      sessionKey,
      generation,
      workspaceRoot: state.workspaceRoot,
      cwd: state.cwd,
      timeline: state.timeline,
    });
  }
  transcriptSupplements.set(key, operation);
  sessionTimelineCoordinator.retain(sessionIdentity(sessionKey, generation), retainOwner);
  return operation;
}

function isCurrentTranscriptSupplement(
  state: AcpChatSessionState,
  operation: TranscriptSupplementOperation,
): boolean {
  if (
    operation.cancelled
    || transcriptSupplements.get(operation.key)?.id !== operation.id
  ) return false;
  const timeline = isCurrentAction(state, operation.sessionKey, operation.generation)
    ? state.timeline
    : operationTimeline(operation);
  return Boolean(timeline)
    && (!operation.liveUserMessageId || timeline!.itemOrder.some((itemId) => {
      const item = timeline!.itemsById[itemId];
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
  const currentOwner = session.reservations.get(key);
  if (currentOwner) {
    // Retries and navigation restores may replace an older attempt from the
    // same source, but must not steal another source's in-flight projection.
    const currentSource = currentOwner.split(':', 1)[0];
    const nextSource = owner.split(':', 1)[0];
    if (!allowSupersede || currentSource !== nextSource) return false;
  }
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
    storeLiveSessionSnapshot({ ...snapshot, deferredImageCompletions });
    return true;
  }
  return false;
}

function resolveImageGenerationProjectionSession(
  state: AcpChatSessionState,
  evidence: ImageGenerationCompletionEvidence,
  owner?: SessionTimelineIdentity,
): string | null {
  const sessionKey = owner?.sessionKey ?? state.activeSessionKey;
  if (!sessionKey) return null;
  const session = imageGenerationCompatSessions.get(sessionKey);
  const taskIds = usesReplayImageGenerationContext(evidence)
    ? session?.replayTaskIds
    : session?.taskIds;
  const taskId = evidence.taskId ?? imageGenerationTaskIdFromSessionKey(evidence.sessionKey);
  if (taskId) return taskIds?.has(taskId) ? sessionKey : null;
  if (!evidence.sessionKey || evidence.sessionKey === sessionKey) return sessionKey;
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

function existingToolAnchorId(timeline: AcpTimelineSnapshot, toolCallId: string | undefined): string | undefined {
  if (!toolCallId) return undefined;
  const itemId = `tool:${toolCallId}`;
  return timeline.itemsById[itemId]?.kind === 'tool-call' ? itemId : undefined;
}

function imageGenerationAnchorItemId(
  timeline: AcpTimelineSnapshot,
  sessionKey: string,
  evidence: ImageGenerationCompletionEvidence,
  correlatedTaskId: string | undefined,
): string | undefined {
  const session = imageGenerationCompatSessions.get(sessionKey);
  const replay = usesReplayImageGenerationContext(evidence);
  const taskToolCallId = correlatedTaskId
    ? (replay ? session?.replayTaskToolCallIds : session?.taskToolCallIds)?.get(correlatedTaskId)
    : undefined;
  // The delivery tool follows the native caption, so anchor matching to the originating image task.
  const candidates = [
    taskToolCallId,
    evidence.toolCallId,
    replay ? session?.lastReplayToolCallId : session?.lastTaskToolCallId,
  ];

  for (const candidate of candidates) {
    const anchorId = existingToolAnchorId(timeline, candidate);
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
  preferredMessageId?: string,
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
    if (preferredMessageId && item.messageId === preferredMessageId) return { itemId };
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
  preferredMessageId?: string,
): string | undefined {
  return findAcpImageCompletionMatch(
    timeline,
    afterItemId,
    caption,
    sessionKey,
    taskId,
    evidenceId,
    preferredMessageId,
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

function removeMessageSegmentItem(
  timeline: AcpTimelineSnapshot,
  itemId: string,
): AcpTimelineSnapshot {
  const item = timeline.itemsById[itemId];
  if (item?.kind !== 'message-segment') return timeline;
  const itemsById = { ...timeline.itemsById };
  const openMessageSegments = { ...timeline.openMessageSegments };
  const segmentCounts = { ...timeline.segmentCounts };
  delete itemsById[itemId];
  if (openMessageSegments[item.messageId] === itemId) delete openMessageSegments[item.messageId];
  if (!Object.values(itemsById).some((candidate) => (
    candidate.kind === 'message-segment' && candidate.messageId === item.messageId
  ))) delete segmentCounts[item.messageId];
  return {
    ...timeline,
    itemOrder: timeline.itemOrder.filter((candidateId) => candidateId !== itemId),
    itemsById,
    openMessageSegments,
    segmentCounts,
  };
}

function assistantMarkdownText(item: MessageSegmentItem): string {
  return item.parts
    .flatMap((part) => part.kind === 'markdown' ? [part.text] : [])
    .join('')
    .trim();
}

/** Settles only a media Turn's trailing Assistant prefix from its persisted final reply. */
function reconcileSuccessfulMediaAssistant(
  timeline: AcpTimelineSnapshot,
  userMessageId: string,
  text: string,
): AcpTimelineSnapshot {
  const persistedText = text.trim();
  if (!persistedText) return timeline;

  const turnItems: Array<{ id: string; item: TimelineItem }> = [];
  let insideTurn = false;
  for (const itemId of timeline.itemOrder) {
    const item = timeline.itemsById[itemId];
    if (item?.kind === 'message-segment' && item.role === 'user') {
      if (!insideTurn) {
        insideTurn = item.messageId === userMessageId;
        continue;
      }
      if (item.messageId !== userMessageId) break;
    }
    if (insideTurn && item) turnItems.push({ id: itemId, item });
  }
  if (turnItems.length === 0) return timeline;

  let lastToolIndex = -1;
  for (const [index, entry] of turnItems.entries()) {
    if (entry.item.kind === 'tool-call') lastToolIndex = index;
  }
  const assistantItems = turnItems.flatMap((entry, index) => (
    entry.item.kind === 'message-segment' && entry.item.role === 'assistant'
      ? [{ id: entry.id, item: entry.item, index, text: assistantMarkdownText(entry.item) }]
      : []
  ));
  const exact = assistantItems.find((entry) => entry.text === persistedText);
  const target = assistantItems
    .filter((entry) => !entry.item.compat && entry.index > lastToolIndex)
    .at(-1);
  const targetIsStrictPrefix = Boolean(
    target
    && target.text.length > 0
    && target.text.length < persistedText.length
    && persistedText.startsWith(target.text),
  );

  // A complete generated-image reply already owns the caption and media; remove only its trailing mirror.
  if (exact) {
    return target && targetIsStrictPrefix && target.index > exact.index
      ? removeMessageSegmentItem(timeline, target.id)
      : timeline;
  }

  if (!target || !targetIsStrictPrefix) return timeline;
  const firstMarkdownIndex = target.item.parts.findIndex((part) => part.kind === 'markdown');
  if (firstMarkdownIndex < 0) return timeline;
  const parts: RenderPart[] = [];
  for (const [index, part] of target.item.parts.entries()) {
    if (part.kind !== 'markdown') parts.push(part);
    else if (index === firstMarkdownIndex) parts.push({ kind: 'markdown', text: persistedText });
  }
  return {
    ...timeline,
    itemsById: {
      ...timeline.itemsById,
      [target.id]: { ...target.item, parts },
    },
  };
}

/** Removes the text-only mirror OpenClaw writes beside an authoritative image message. */
function dedupeAcpImageCompletionMirrors(
  timeline: AcpTimelineSnapshot,
  options?: { allowSyntheticTarget?: boolean },
): AcpTimelineSnapshot {
  let next = timeline;
  for (const targetId of timeline.itemOrder) {
    const target = next.itemsById[targetId];
    if (
      target?.kind !== 'message-segment'
      || target.role !== 'assistant'
      || target.compat?.source !== 'image-generation'
      || (!options?.allowSyntheticTarget && target.messageId.startsWith('compat:image-generation:'))
      || !target.parts.some((part) => part.kind === 'image')
    ) continue;
    const caption = target.parts
      .flatMap((part) => part.kind === 'markdown' ? [part.text] : [])
      .join('\n')
      .trim();
    if (!caption) continue;
    const targetIndex = next.itemOrder.indexOf(targetId);
    const duplicateIds: string[] = [];
    for (const direction of [-1, 1] as const) {
      for (let index = targetIndex + direction; index >= 0 && index < next.itemOrder.length; index += direction) {
        const candidateId = next.itemOrder[index];
        const candidate = candidateId ? next.itemsById[candidateId] : undefined;
        if (candidate?.kind === 'tool-call') break;
        if (candidate?.kind === 'message-segment' && candidate.role === 'user') break;
        if (candidate?.kind !== 'message-segment' || candidate.role !== 'assistant') continue;
        const candidateText = candidate.parts
          .flatMap((part) => part.kind === 'markdown' ? [part.text] : [])
          .join('\n')
          .trim();
        const captionOnly = candidate.parts.length > 0
          && candidate.parts.every((part) => part.kind === 'markdown');
        const exactMirror = candidateText === caption;
        // A failed live stream can leave only a prefix of the model's trailing
        // MEDIA mirror. Limit prefix removal to messages after the image.
        const truncatedTrailingMirror = direction === 1
          && candidateText.length < caption.length
          && caption.startsWith(candidateText);
        if (!candidate.compat && captionOnly && (exactMirror || truncatedTrailingMirror)) {
          duplicateIds.push(candidateId);
        }
      }
    }
    for (const duplicateId of duplicateIds) next = removeMessageSegmentItem(next, duplicateId);
  }
  return next;
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

function releaseUnrestoredImageProjection(sessionKey: string, evidenceId: string): void {
  const session = imageGenerationCompatSessions.get(sessionKey);
  if (!session) return;
  session.delivered.delete(evidenceId);
  session.reservations.delete(evidenceId);
  session.syntheticCompletions.delete(evidenceId);
}

function isLiveMessageUpdate(event: AcpSessionUpdateEnvelope): boolean {
  if (event.historical) return false;
  const update = event.notification.update as unknown as { sessionUpdate?: unknown };
  return update.sessionUpdate === 'agent_message'
    || update.sessionUpdate === 'agent_message_chunk'
    || update.sessionUpdate === 'user_message'
    || update.sessionUpdate === 'user_message_chunk';
}

/** Keeps OpenClaw's task-control envelope out of the user-visible Turn timeline. */
function applyVisibleAcpSessionUpdate(
  timeline: AcpTimelineSnapshot,
  event: AcpSessionUpdateEnvelope,
): AcpTimelineSnapshot {
  const update = event.notification.update as unknown as Record<string, unknown>;
  const internalVideoTerminal = update.sessionUpdate === 'user_message_chunk'
    && (typeof update.messageId !== 'string' || !update.messageId)
    && Boolean(extractVideoGenerationTerminalFromAcpEnvelope(event));
  return internalVideoTerminal
    ? timeline
    : applyAcpSessionUpdate(timeline, event.notification, { historical: !!event.historical });
}

function liveTextChunkBatchKey(event: AcpSessionUpdateEnvelope): string | null {
  if (event.historical) return null;
  const update = event.notification.update as unknown as Record<string, unknown>;
  const kind = update.sessionUpdate;
  if (kind !== 'agent_message_chunk' && kind !== 'user_message_chunk') return null;
  const content = update.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const block = content as Record<string, unknown>;
  if (block.type !== 'text' || typeof block.text !== 'string') return null;
  const messageId = typeof update.messageId === 'string' && update.messageId
    ? update.messageId
    : '__fallback__';
  return JSON.stringify([event.sessionKey, event.generation, kind, messageId]);
}

type RecoverableBrowserToolFailure = Pick<AcpChatErrorDetails, 'code' | 'message'> & { retryable: true };

function browserToolFailureStrings(value: unknown, strings: string[], seen: Set<object>, depth = 0): void {
  if (strings.length >= 16 || depth > 3) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) strings.push(trimmed.slice(0, 1000));
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) browserToolFailureStrings(entry, strings, seen, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['error', 'message', 'detail', 'details', 'reason', 'rawOutput', 'output', 'content']) {
    browserToolFailureStrings(record[key], strings, seen, depth + 1);
  }
}

/**
 * Browser failures are recoverable only when OpenClaw has already marked the
 * Browser tool terminal. Do not infer failures from browser-looking output.
 */
function recoverableBrowserToolFailure(event: AcpSessionUpdateEnvelope): RecoverableBrowserToolFailure | null {
  if (event.historical) return null;
  const update = event.notification.update as unknown as Record<string, unknown>;
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return null;
  const status = typeof update.status === 'string' ? update.status.toLowerCase() : '';
  if (status !== 'failed' && status !== 'error') return null;

  const toolIdentity = [update.title, update.kind]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (!/(?:^|\b)browser(?:\b|$)/u.test(toolIdentity)) return null;

  const strings: string[] = [];
  browserToolFailureStrings(update, strings, new Set());
  const detail = strings.join('\n').toLowerCase();
  if (/unsupported\s+(?:file\s+)?protocol\s*["']?file:|navigation\s+blocked[^\n]*file:/iu.test(detail)) {
    return {
      code: 'INVALID_REQUEST',
      message: 'Browser cannot open file:// directly. The task was released; open the workspace preview or retry with the local preview URL.',
      retryable: true,
    };
  }
  if (/\b(?:timed?\s*out|timeout|deadline\s+exceeded)\b/iu.test(detail)) {
    return {
      code: 'TIMEOUT',
      message: 'Browser timed out. The task was released; retry the browser step or continue with the next request.',
      retryable: true,
    };
  }
  if (/(?:target|session)(?:id)?[^\n]{0,80}\bmismatch\b|\bmismatch\b[^\n]{0,80}(?:target|session)(?:id)?/iu.test(detail)) {
    return {
      code: 'INVALID_REQUEST',
      message: 'Browser target changed or no longer matches this session. The task was released; retry the browser step.',
      retryable: true,
    };
  }
  if (/(?:localhost|127\.0\.0\.1|\[::1\]|private\s+network)[^\n]{0,100}(?:ssrf|block(?:ed)?|denied)|(?:ssrf|block(?:ed)?|denied)[^\n]{0,100}(?:localhost|127\.0\.0\.1|\[::1\]|private\s+network)/iu.test(detail)) {
    return {
      code: 'PERMISSION_DENIED',
      message: 'Browser blocked the local address for safety. The task was released; use the approved workspace preview URL.',
      retryable: true,
    };
  }
  return null;
}

function turnHasVisibleOutput(timeline: AcpTimelineSnapshot, liveUserMessageId: string): boolean {
  const userIndex = timeline.itemOrder.findIndex((itemId) => {
    const item = timeline.itemsById[itemId];
    return item?.kind === 'message-segment'
      && item.role === 'user'
      && item.messageId === liveUserMessageId;
  });
  if (userIndex < 0) return false;

  for (let index = userIndex + 1; index < timeline.itemOrder.length; index += 1) {
    const itemId = timeline.itemOrder[index];
    const item = itemId ? timeline.itemsById[itemId] : undefined;
    if (item?.kind === 'message-segment' && item.role === 'user') break;
    if (item?.kind === 'message-segment' && item.role === 'assistant') {
      if (item.parts.some((part) => (
        part.kind === 'image'
        || part.kind === 'attachment'
        || (part.kind === 'markdown' && part.text.trim().length > 0)
      ))) return true;
    }
    if (item?.kind === 'tool-call' && item.status === 'completed') return true;
  }
  return false;
}

function browserCancelKey(sessionKey: string, generation: number): string {
  return JSON.stringify([sessionKey, generation]);
}

function pendingBrowserRelease(sessionKey: string, generation: number): Promise<boolean> | undefined {
  return browserFailureCancelPromises.get(browserCancelKey(sessionKey, generation));
}

/** Cancels a known-stuck Browser turn once so ACP releases its active work and queue. */
function releaseRecoverableBrowserToolFailure(event: AcpSessionUpdateEnvelope): void {
  const failure = recoverableBrowserToolFailure(event);
  if (!failure) return;
  const state = useAcpChatSessionStore.getState();
  if (!state.sending || !isCurrentAction(state, event.sessionKey, event.generation)) return;
  const operation = latestLiveTranscriptOperation(event.sessionKey, event.generation);
  if (!operation?.liveUserMessageId || browserFailureCancelOperationIds.has(operation.id)) return;
  if (turnHasVisibleOutput(state.timeline, operation.liveUserMessageId)) return;

  browserFailureCancelOperationIds.add(operation.id);
  operation.browserReleased = true;
  const timing = state.turnTimingsByUserMessageId[operation.liveUserMessageId];
  const startedAtMs = timing?.status === 'running' ? timing.startedAtMs : Date.now();
  const settledAtMs = Date.now();
  useAcpChatSessionStore.setState((current) => {
    if (!isCurrentAction(current, event.sessionKey, event.generation)) return {};
    return {
      cancelling: true,
      error: null,
      timeline: appendPromptFailure(current.timeline, operation.liveUserMessageId!, failure),
      turnTimingsByUserMessageId: settledPromptTurnTimings(current.turnTimingsByUserMessageId, {
        messageId: operation.liveUserMessageId!, success: false, startedAtMs, settledAtMs,
      }),
    };
  });

  const cancelKey = browserCancelKey(event.sessionKey, event.generation);
  const cancellation = hostApi.chat.cancelAcpSession({ sessionKey: event.sessionKey })
    .then((result) => {
      useAcpChatSessionStore.setState((current) => {
        if (!isCurrentAction(current, event.sessionKey, event.generation)) return {};
        return result.success
          ? { cancelling: false, sending: false, ...applyOperationGeneration(current, result) }
          : {
            cancelling: false,
            sending: false,
            error: failedOperationMessage(result, 'Browser task release failed'),
          };
      });
      return result.success;
    })
    .catch((error) => {
      useAcpChatSessionStore.setState((current) => (
        isCurrentAction(current, event.sessionKey, event.generation)
          ? {
            cancelling: false,
            sending: false,
            error: errorMessage(error, 'Browser task release failed'),
          }
          : {}
      ));
      return false;
    })
    .finally(() => {
      browserFailureCancelOperationIds.delete(operation.id);
      if (browserFailureCancelPromises.get(cancelKey) === cancellation) {
        browserFailureCancelPromises.delete(cancelKey);
      }
      if (isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation) && !operation.started) {
        startLiveTranscriptSupplement(operation);
      }
    });
  browserFailureCancelPromises.set(cancelKey, cancellation);
}

function applySessionUpdateSideEffects(event: AcpSessionUpdateEnvelope): void {
  const state = useAcpChatSessionStore.getState();
  state.recordImageGenerationStart(event);
  state.recordVideoGenerationUpdate(event);
  const evidence = extractImageGenerationCompletionFromAcpEnvelope(event);
  if (evidence) void state.projectImageGenerationCompletion(evidence);
  releaseRecoverableBrowserToolFailure(event);
}

/** Publishes buffered adjacent text events in one timeline commit. */
function applyLiveTextUpdateBatch(events: AcpSessionUpdateEnvelope[]): void {
  const first = events[0];
  if (!first) return;
  const state = useAcpChatSessionStore.getState();
  if (state.loading) {
    if (first.sessionKey === state.activeSessionKey) {
      const updates = pendingLoadUpdates.get(first.generation) ?? [];
      pendingLoadUpdates.set(first.generation, [...updates, ...events]);
      return;
    }
    const liveSnapshot = liveSessionSnapshots.get(first.sessionKey);
    if (liveSnapshot?.generation !== first.generation) return;
    commitInactiveSessionUpdates(liveSnapshot, events);
    return;
  }

  if (first.sessionKey !== state.activeSessionKey || first.generation !== state.generation) {
    const liveSnapshot = liveSessionSnapshots.get(first.sessionKey);
    if (liveSnapshot?.generation !== first.generation) return;
    commitInactiveSessionUpdates(liveSnapshot, events);
    return;
  }

  let timeline = state.timeline;
  for (const event of events) {
    timeline = applyVisibleAcpSessionUpdate(timeline, event);
  }
  timeline = dedupeAcpImageCompletionMirrors(
    reconcileLateAcpImageCompletions(timeline, first.sessionKey, first.generation),
  );
  commitSessionTimeline(first.sessionKey, first.generation, () => timeline);
  for (const event of events) applySessionUpdateSideEffects(event);
}

function flushPendingLiveTextBatch(): void {
  const batch = pendingLiveTextBatch;
  if (!batch) return;
  pendingLiveTextBatch = undefined;
  clearTimeout(batch.timer);
  applyLiveTextUpdateBatch(batch.events);
}

/** Keeps the first chunk visible and batches only adjacent chunks from the same message. */
function enqueueSessionUpdate(event: AcpSessionUpdateEnvelope): void {
  const key = liveTextChunkBatchKey(event);
  if (!key) {
    flushPendingLiveTextBatch();
    useAcpChatSessionStore.getState().applyUpdateEnvelope(event);
    return;
  }
  if (pendingLiveTextBatch?.key === key) {
    pendingLiveTextBatch.events.push(event);
    if (pendingLiveTextBatch.events.length >= LIVE_TEXT_BATCH_MAX_UPDATES) {
      flushPendingLiveTextBatch();
    }
    return;
  }

  flushPendingLiveTextBatch();
  useAcpChatSessionStore.getState().applyUpdateEnvelope(event);
  pendingLiveTextBatch = {
    key,
    events: [],
    timer: setTimeout(flushPendingLiveTextBatch, LIVE_TEXT_BATCH_WINDOW_MS),
  };
}

function isCurrentAction(
  state: AcpChatSessionState,
  sessionKey: string,
  generation: number,
): boolean {
  return state.activeSessionKey === sessionKey && state.generation === generation;
}

/** Serializes one timeline mutation to its owning active or retained background session. */
function commitSessionTimeline(
  sessionKey: string,
  generation: number,
  reduce: (timeline: AcpTimelineSnapshot) => AcpTimelineSnapshot,
  options: { retainForReplay?: boolean } = {},
): AcpTimelineSnapshot | undefined {
  const identity = sessionIdentity(sessionKey, generation);
  const state = useAcpChatSessionStore.getState();
  if (isCurrentAction(state, sessionKey, generation)) {
    syncTimelineRecord({
      sessionKey,
      generation,
      workspaceRoot: state.workspaceRoot,
      cwd: state.cwd,
      timeline: state.timeline,
    });
    const updated = sessionTimelineCoordinator.update(identity, reduce);
    if (!updated) return undefined;
    if (updated.timeline !== state.timeline) {
      useAcpChatSessionStore.setState((current) => (
        isCurrentAction(current, sessionKey, generation)
          ? { timeline: updated.timeline }
          : {}
      ));
    }
    const snapshot = liveSessionSnapshots.get(sessionKey);
    if (snapshot?.generation === generation) {
      storeLiveSessionSnapshot({ ...snapshot, timeline: updated.timeline });
    }
    return updated.timeline;
  }

  const snapshot = liveSessionSnapshots.get(sessionKey);
  if (snapshot?.generation === generation) syncTimelineRecord(snapshot);
  const updated = sessionTimelineCoordinator.update(identity, reduce);
  if (!updated) return undefined;
  if (snapshot?.generation === generation) {
    storeLiveSessionSnapshot({
      ...snapshot,
      timeline: updated.timeline,
      unconsumedTimelineUpdate:
        snapshot.unconsumedTimelineUpdate || options.retainForReplay === true,
    });
  }
  return updated.timeline;
}

/** Reduces background events in receive order, then commits their timeline through one owner. */
function commitInactiveSessionUpdates(
  snapshot: LiveSessionSnapshot,
  events: AcpSessionUpdateEnvelope[],
): void {
  let reduced = snapshot;
  let retainForReplay = false;
  for (const event of events) {
    reduced = applyVideoGenerationUpdateToSnapshot(deferInactiveImageUpdate({
      ...reduced,
      timeline: applyVisibleAcpSessionUpdate(reduced.timeline, event),
    }, event), event);
    retainForReplay ||= extractVideoGenerationTerminalFromAcpEnvelope(event)?.status === 'failed';
  }

  const timeline = commitSessionTimeline(
    snapshot.sessionKey,
    snapshot.generation,
    () => reduced.timeline,
    { retainForReplay },
  );
  if (!timeline) return;
  const latest = liveSessionSnapshots.get(snapshot.sessionKey);
  if (latest?.generation !== snapshot.generation) return;
  storeLiveSessionSnapshot({
    ...latest,
    pendingImageGenerationTaskIds: reduced.pendingImageGenerationTaskIds,
    pendingVideoGenerationTaskIds: reduced.pendingVideoGenerationTaskIds,
    deferredImageUpdates: reduced.deferredImageUpdates,
    deferredImageCompletions: reduced.deferredImageCompletions,
    timeline,
  });
}

/** Rejects only a superseded generation of the same session; navigation keeps the owner valid. */
function hasSessionTimelineOwner(sessionKey: string, generation: number): boolean {
  const state = useAcpChatSessionStore.getState();
  if (state.activeSessionKey === sessionKey) return state.generation === generation;
  return liveSessionSnapshots.get(sessionKey)?.generation === generation
    && Boolean(sessionTimelineCoordinator.read(sessionIdentity(sessionKey, generation)));
}

/** Commits image timeline and pending-task state to one active or retained background session. */
function commitImageProjectionToOwner(input: {
  sessionKey: string;
  generation: number;
  reduce: (timeline: AcpTimelineSnapshot) => AcpTimelineSnapshot;
  updatePending?: (taskIds: string[]) => string[];
}): AcpTimelineSnapshot | undefined {
  const state = useAcpChatSessionStore.getState();
  const active = isCurrentAction(state, input.sessionKey, input.generation);
  if (state.activeSessionKey === input.sessionKey && !active) return undefined;
  const snapshot = active ? undefined : liveSessionSnapshots.get(input.sessionKey);
  if (!active && snapshot?.generation !== input.generation) return undefined;

  const timeline = commitSessionTimeline(
    input.sessionKey,
    input.generation,
    input.reduce,
    { retainForReplay: true },
  );
  if (!timeline || !input.updatePending) return timeline;

  if (active) {
    useAcpChatSessionStore.setState((current) => {
      if (!isCurrentAction(current, input.sessionKey, input.generation)) return {};
      const pendingImageGenerationTaskIds = input.updatePending!(current.pendingImageGenerationTaskIds);
      return pendingImageGenerationTaskIds === current.pendingImageGenerationTaskIds
        ? {}
        : { pendingImageGenerationTaskIds };
    });
    return timeline;
  }

  const latestSnapshot = liveSessionSnapshots.get(input.sessionKey);
  if (latestSnapshot?.generation !== input.generation) return undefined;
  const pendingImageGenerationTaskIds = input.updatePending(latestSnapshot.pendingImageGenerationTaskIds);
  storeLiveSessionSnapshot({
    ...latestSnapshot,
    timeline,
    pendingImageGenerationTaskIds,
    unconsumedTimelineUpdate: true,
  });
  return timeline;
}

function releaseTimelineRetention(
  sessionKey: string,
  generation: number,
  owner: string,
): void {
  sessionTimelineCoordinator.release(sessionIdentity(sessionKey, generation), owner);
  const state = useAcpChatSessionStore.getState();
  if (isCurrentAction(state, sessionKey, generation)) {
    pruneSettledActiveSnapshot(state);
    return;
  }
  const snapshot = liveSessionSnapshots.get(sessionKey);
  if (snapshot?.generation === generation) storeLiveSessionSnapshot(snapshot);
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

type ResolvedOpenClawMediaCandidate = {
  authorized: boolean;
  localVideoIdentity?: string;
};

async function resolveOpenClawMediaCandidate(
  operation: TranscriptSupplementOperation,
  attempt: number,
  turnId: string,
  candidate: OpenClawMediaCandidate,
  options: { projectUnavailable?: boolean } = {},
): Promise<ResolvedOpenClawMediaCandidate> {
  const isCurrent = () => operation.attempt === attempt
    && isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation);
  if (!isCurrent()) return { authorized: false };

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
    return { authorized: false };
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

  // A failed prompt has no user-visible success state to attach an unavailable
  // candidate to. Keep its failure visible and do not disclose an unapproved URI.
  if (!result.ok && options.projectUnavailable === false) {
    recordOpenClawMediaTrace(operation, 'openclaw-media:projection-withheld', {
      reason: result.error,
      evidenceHash,
    });
    return { authorized: false };
  }

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
  commitSessionTimeline(operation.sessionKey, operation.generation, (currentTimeline) => {
    if (!isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation)) return currentTimeline;
    const upserted = upsertSyntheticTurnAttachments(currentTimeline, {
      turnId,
      evidenceId: candidate.evidenceId,
      attachments: [pending],
      source: 'openclaw-media',
    });
    const nextTimeline = applyAttachmentResolution(upserted, {
      attachmentId: pending.attachmentId,
      expectedFingerprint: fingerprint,
      result,
    });
    projected = Object.values(nextTimeline.itemsById).some((item) => (
      item.kind === 'message-segment'
      && item.parts.some((part) => part.kind === 'attachment' && part.attachmentId === pending.attachmentId)
    ));
    return nextTimeline;
  }, { retainForReplay: true });
  recordOpenClawMediaTrace(
    operation,
    projected ? 'openclaw-media:projection-appended' : 'openclaw-media:projection-deduped',
    { reason: projected ? 'projected' : 'identity-priority', evidenceHash, attachmentCount: projected ? 1 : 0 },
  );
  return {
    authorized: result.ok,
    ...(result.ok
    && result.target.kind === 'local'
    && result.mimeType.startsWith('video/')
      ? { localVideoIdentity: result.identity }
      : {}),
  };
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
      executionCwd: operation.executionCwd,
      snapshot: () => operationTimeline(operation) ?? state.timeline,
    ...(operation.liveUserMessageId ? { liveUserMessageId: operation.liveUserMessageId } : {}),
    isCurrent,
  });
  if (!result || !isCurrent()) return 0;
  operation.mediaCandidateSeen ||= result.imageGeneration.starts.length > 0
    || result.imageGeneration.completions.length > 0
    || result.media.some((supplement) => supplement.candidates.length > 0);

  if (!operation.liveUserMessageId && result.turnTimings.length > 0) {
    useAcpChatSessionStore.setState((current) => (
      isCurrentTranscriptSupplement(current, operation)
        ? {
          turnTimingsByUserMessageId: mergeHistoricalTurnTimings(
            operation.sessionKey,
            current.timeline,
            current.turnTimingsByUserMessageId,
            result.turnTimings,
          ),
        }
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
      owner: sessionIdentity(operation.sessionKey, operation.generation),
      ...(completion.transcriptMessageId ? { transcriptMessageId: completion.transcriptMessageId } : {}),
    });
  }
  const localVideoIdentities = new Set<string>();
  for (const supplement of result.media) {
    for (const candidate of supplement.candidates) {
      if (!isCurrent()) return 0;
      operation.mediaCandidateSeen = true;
      const resolved = await resolveOpenClawMediaCandidate(
        operation,
        attempt,
        supplement.acpTurnId,
        candidate,
      );
      operation.authorizedMediaDelivered ||= resolved.authorized;
      if (resolved.localVideoIdentity) localVideoIdentities.add(resolved.localVideoIdentity);
    }
    if (supplement.finalAssistant && isCurrent()) {
      commitSessionTimeline(operation.sessionKey, operation.generation, (timeline) => (
        reconcileSuccessfulMediaAssistant(
          timeline,
          supplement.acpTurnId,
          supplement.finalAssistant!.text,
        )
      ), { retainForReplay: true });
    }
  }
  return localVideoIdentities.size;
}

function runTranscriptSupplementSerialized(operation: TranscriptSupplementOperation): Promise<number> {
  if (operation.inFlight) return operation.inFlight;
  const execution = runTranscriptSupplement(operation).finally(() => {
    if (operation.inFlight === execution) operation.inFlight = undefined;
  });
  operation.inFlight = execution;
  return execution;
}

function startHistoricalTranscriptSupplement(
  sessionKey: string,
  generation: number,
  executionCwd: string,
): void {
  const operation = beginTranscriptSupplement(sessionKey, generation, executionCwd);
  void runTranscriptSupplementSerialized(operation).finally(() => {
    if (transcriptSupplements.get(operation.key)?.id === operation.id) {
      invalidateTranscriptSupplement(operation);
    }
  });
}

function scheduleLiveTranscriptSupplement(operation: TranscriptSupplementOperation): void {
  if (
    operation.retryTimer
    || operation.terminal
    || !isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation)
  ) return;
  const hasImageTask = operation.imageTaskIds.size > 0;
  const hasVideoTask = operation.videoTaskIds.size > 0;
  const stopNonImagePolling = hasVideoTask
    ? operation.retryIndex > 0
    : (!operation.mediaCandidateSeen || operation.retryIndex > 0);
  if (!hasImageTask && stopNonImagePolling) {
    if (operation.videoTaskIds.size === 0) invalidateTranscriptSupplement(operation);
    return;
  }
  const delay = IMAGE_GENERATION_TRANSCRIPT_RETRY_DELAYS_MS[operation.retryIndex];
  if (delay === undefined) {
    operation.terminal = true;
    const hasPendingImage = [...operation.imageTaskIds]
      .some((taskId) => !operation.completedTaskIds.has(taskId));
    if (!hasPendingImage && operation.videoTaskIds.size === 0) invalidateTranscriptSupplement(operation);
    return;
  }
  operation.retryIndex += 1;
  operation.retryTimer = setTimeout(() => {
    operation.retryTimer = undefined;
    void runLiveTranscriptSupplement(operation);
  }, delay);
}

async function runLiveTranscriptSupplement(operation: TranscriptSupplementOperation): Promise<void> {
  if (operation.terminal || !isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation)) return;
  await runTranscriptSupplementSerialized(operation);
  if (
    operation.authorizedMediaDelivered
    && operation.imageTaskIds.size === 0
    && operation.videoTaskIds.size === 0
  ) {
    invalidateTranscriptSupplement(operation);
    return;
  }
  if (!operation.terminal && isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation)) {
    scheduleLiveTranscriptSupplement(operation);
  }
}

function startLiveTranscriptSupplement(operation: TranscriptSupplementOperation): void {
  operation.started = true;
  const hasCompletedVideoTask = operation.completedVideoTaskIds.size > 0
    || operation.videoRequesterProbe;
  if (hasCompletedVideoTask) {
    if (!operation.terminal && operation.imageTaskIds.size > 0) {
      scheduleLiveTranscriptSupplement(operation);
    }
    startVideoCompletionTranscriptSupplement(operation);
    return;
  }
  if (!operation.terminal) {
    void runLiveTranscriptSupplement(operation);
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
    const hasPendingImage = [...operation.imageTaskIds]
      .some((taskId) => !operation.completedTaskIds.has(taskId));
    const hasPendingVideo = [...operation.videoTaskIds]
      .some((taskId) => !operation.completedVideoTaskIds.has(taskId));
    if (!hasPendingImage && !hasPendingVideo) invalidateTranscriptSupplement(operation);
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
  const localVideoCount = await runTranscriptSupplementSerialized(operation);
  if (
    operation.videoRetryEpoch !== epoch
    || !isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation)
  ) return;
  const expectedTaskIds = operation.completedVideoTaskIds.size > 0
    ? operation.completedVideoTaskIds
    : (operation.videoRequesterProbe ? operation.videoTaskIds : new Set<string>());
  if (expectedTaskIds.size > 0 && localVideoCount >= expectedTaskIds.size) {
    for (const taskId of expectedTaskIds) {
      useAcpChatSessionStore.getState().settleVideoGenerationTask(taskId);
    }
    operation.videoRequesterProbe = false;
    recordProjectionTrace({
      event: 'video-generation:completion-transcript-projected',
      sessionKey: operation.sessionKey,
      generation: operation.generation,
      details: {
        completedTaskCount: expectedTaskIds.size,
        localVideoCount,
      },
    });
    const hasPendingImage = [...operation.imageTaskIds]
      .some((taskId) => !operation.completedTaskIds.has(taskId));
    if (!hasPendingImage) invalidateTranscriptSupplement(operation);
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
  for (const operation of transcriptSupplements.values()) {
    if (
      !operation.liveUserMessageId
      || !operation.videoTaskIds.has(taskId)
      || operation.completedVideoTaskIds.has(taskId)
      || !isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation)
    ) continue;
    operation.completedVideoTaskIds.add(taskId);
    recordProjectionTrace({
      event: 'video-generation:completion-transcript-started',
      sessionKey: operation.sessionKey,
      generation: operation.generation,
      details: { taskId },
    });
    if (operation.started) startVideoCompletionTranscriptSupplement(operation);
  }
}

/** Re-reads the active Turn when OpenClaw ends a media completion agent on the requester session. */
function refreshPendingMediaTranscriptForRequesterSession(sessionKey: string | undefined): void {
  if (!sessionKey) return;
  for (const operation of liveTranscriptOperations(sessionKey)) {
    if (!isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation)) continue;
    const state = useAcpChatSessionStore.getState();
    const snapshot = liveSessionSnapshots.get(operation.sessionKey);
    const pendingImageTaskIds = isCurrentAction(state, operation.sessionKey, operation.generation)
      ? state.pendingImageGenerationTaskIds
      : snapshot?.generation === operation.generation ? snapshot.pendingImageGenerationTaskIds : [];
    const pendingVideoTaskIds = isCurrentAction(state, operation.sessionKey, operation.generation)
      ? state.pendingVideoGenerationTaskIds
      : snapshot?.generation === operation.generation ? snapshot.pendingVideoGenerationTaskIds : [];
    const pendingImageTaskCount = [...operation.imageTaskIds]
      .filter((taskId) => pendingImageTaskIds.includes(taskId)).length;
    if (pendingImageTaskCount > 0) {
      operation.terminal = false;
      operation.retryIndex = 0;
      if (operation.retryTimer) clearTimeout(operation.retryTimer);
      operation.retryTimer = undefined;
      recordProjectionTrace({
        event: 'image-generation:requester-run-transcript-started',
        sessionKey: operation.sessionKey,
        generation: operation.generation,
        details: { pendingTaskCount: pendingImageTaskCount },
      });
      if (operation.started) void runLiveTranscriptSupplement(operation);
    }

    const pendingVideoTaskCount = [...operation.videoTaskIds]
      .filter((taskId) => pendingVideoTaskIds.includes(taskId)).length;
    if (pendingVideoTaskCount > 0) {
      operation.videoRequesterProbe = true;
      recordProjectionTrace({
        event: 'video-generation:requester-run-transcript-started',
        sessionKey: operation.sessionKey,
        generation: operation.generation,
        details: { pendingTaskCount: pendingVideoTaskCount },
      });
      if (operation.started) startVideoCompletionTranscriptSupplement(operation);
    }
  }
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
    const retainOwner = `attachment:${inFlightKey}`;
    sessionTimelineCoordinator.retain(sessionIdentity(sessionKey, generation), retainOwner);

    void hostApi.files.resolveAttachment(attachmentResolvePayload(sessionKey, generation, location))
      .catch((): ResolveAttachmentResult => ({
        ok: false,
        displayName: location.attachment.reference.name,
        error: 'operationFailed',
      }))
      .then((result) => {
        commitSessionTimeline(
          sessionKey,
          generation,
          (timeline) => applyAttachmentResolution(timeline, {
            attachmentId,
            expectedFingerprint,
            result,
          }),
          { retainForReplay: true },
        );
      })
      .finally(() => {
        attachmentResolutionsInFlight.delete(inFlightKey);
        releaseTimelineRetention(sessionKey, generation, retainOwner);
      });
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

function settleOptimisticUserSegment(
  timeline: AcpTimelineSnapshot,
  messageId: string,
): AcpTimelineSnapshot {
  const itemId = timeline.openMessageSegments[messageId];
  const item = itemId ? timeline.itemsById[itemId] : undefined;
  if (item?.kind !== 'message-segment' || item.role !== 'user') return timeline;
  const { [messageId]: _closedSegment, ...openMessageSegments } = timeline.openMessageSegments;
  return {
    ...timeline,
    itemsById: {
      ...timeline.itemsById,
      [itemId]: {
        ...item,
        optimistic: false,
        userPromptTextBlocksOptimistic: false,
      },
    },
    openMessageSegments,
  };
}

const KNOWN_ACP_CHAT_ERROR_CODES = new Set<AcpChatErrorCode>([
  'INSUFFICIENT_QUOTA', 'AUTH_INVALID', 'RATE_LIMIT', 'PERMISSION_DENIED',
  'TIMEOUT', 'NETWORK', 'GATEWAY_UNAVAILABLE', 'SERVICE_UNAVAILABLE',
  'CONTEXT_OVERFLOW', 'SESSION_LOCKED', 'MODEL_UNAVAILABLE', 'CONTENT_POLICY',
  'CONVERSATION_INVALID', 'IMAGE_TOO_LARGE', 'INVALID_REQUEST', 'CANCELLED', 'UNKNOWN',
]);

function operationFailure(
  result: AcpChatOperationResult,
  fallback = 'ACP prompt failed',
): AcpChatErrorDetails {
  const normalized = normalizeAcpChatError({
    message: result.error || fallback,
    code: result.upstreamCode ?? result.errorCode,
    status: result.httpStatus,
  }, fallback);
  return {
    ...normalized,
    ...(result.errorCode && KNOWN_ACP_CHAT_ERROR_CODES.has(result.errorCode) ? { code: result.errorCode } : {}),
    ...(result.retryable != null ? { retryable: result.retryable } : {}),
  };
}

function appendPromptFailure(
  timeline: AcpTimelineSnapshot,
  messageId: string,
  failure: AcpChatErrorDetails,
): AcpTimelineSnapshot {
  const settled = settleOptimisticUserSegment(timeline, messageId);
  if (failure.code === 'CANCELLED') return settled;
  const id = `turn-failure:${messageId}`;
  if (settled.itemsById[id]?.kind === 'turn-failure') return settled;
  return {
    ...settled,
    itemOrder: settled.itemOrder.includes(id) ? settled.itemOrder : [...settled.itemOrder, id],
    itemsById: {
      ...settled.itemsById,
      [id]: { kind: 'turn-failure', id, userMessageId: messageId, failure },
    },
  };
}

function settledPromptTurnTimings(
  timings: Record<string, AcpTurnTiming>,
  input: {
    messageId: string;
    success: boolean;
    startedAtMs: number;
    settledAtMs: number;
  },
): Record<string, AcpTurnTiming> {
  if (input.success) {
    const completed: AcpTurnTiming = {
      source: 'live',
      status: 'complete',
      durationMs: Math.max(0, input.settledAtMs - input.startedAtMs),
    };
    return { ...timings, [input.messageId]: completed };
  }
  const { [input.messageId]: _removedTiming, ...remaining } = timings;
  return remaining;
}

/** Finalizes a prompt that settled after navigation without dropping pending media work. */
function settleBackgroundPromptSnapshot(input: {
  sessionKey: string;
  generation: number;
  messageId: string;
  startedAtMs: number;
  settledAtMs: number;
  success: boolean;
  resultGeneration?: number;
  failure?: AcpChatErrorDetails;
}): void {
  const snapshot = liveSessionSnapshots.get(input.sessionKey);
  if (snapshot?.generation !== input.generation) return;

  const generation = input.success
    ? input.resultGeneration ?? snapshot.generation
    : snapshot.generation;
  const timeline = input.success
    ? snapshot.timeline
    : appendPromptFailure(
        snapshot.timeline,
        input.messageId,
        input.failure ?? normalizeAcpChatError('ACP prompt failed'),
      );
  storeLiveSessionSnapshot({
    ...snapshot,
    generation,
    sending: false,
    timeline: generation === snapshot.generation
      ? timeline
      : { ...timeline, loadGeneration: generation },
    turnTimingsByUserMessageId: settledPromptTurnTimings(
      snapshot.turnTimingsByUserMessageId,
      input,
    ),
  });
}

function reconcileFailedAssistantSegment(
  timeline: AcpTimelineSnapshot,
  liveUserMessageId: string,
  transcriptMessageId: string | undefined,
  text: string,
): AcpTimelineSnapshot {
  const userIndex = timeline.itemOrder.findIndex((itemId) => {
    const item = timeline.itemsById[itemId];
    return item?.kind === 'message-segment'
      && item.role === 'user'
      && item.messageId === liveUserMessageId;
  });
  if (userIndex < 0) return timeline;

  const candidates: MessageSegmentItem[] = [];
  for (let index = userIndex + 1; index < timeline.itemOrder.length; index += 1) {
    const itemId = timeline.itemOrder[index];
    const item = itemId ? timeline.itemsById[itemId] : undefined;
    if (item?.kind === 'message-segment' && item.role === 'user') break;
    if (item?.kind === 'message-segment' && item.role === 'assistant') candidates.push(item);
  }
  const target = transcriptMessageId
    ? candidates.find((item) => item.messageId === transcriptMessageId)
    : undefined;
  const resolvedTarget = target ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!resolvedTarget) return timeline;

  const currentText = resolvedTarget.parts
    .flatMap((part) => part.kind === 'markdown' ? [part.text] : [])
    .join('')
    .trim();
  const persistedText = text.trim();
  if (!persistedText || persistedText.length <= currentText.length || !persistedText.startsWith(currentText)) {
    return timeline;
  }
  const firstMarkdownIndex = resolvedTarget.parts.findIndex((part) => part.kind === 'markdown');
  if (firstMarkdownIndex < 0) return timeline;
  const parts: RenderPart[] = [];
  for (const [index, part] of resolvedTarget.parts.entries()) {
    if (part.kind !== 'markdown') parts.push(part);
    else if (index === firstMarkdownIndex) parts.push({ kind: 'markdown', text: persistedText });
  }
  return {
    ...timeline,
    itemsById: {
      ...timeline.itemsById,
      [resolvedTarget.id]: { ...resolvedTarget, parts },
    },
  };
}

function isMediaSummaryRecoveryFailure(failure: AcpChatErrorDetails): boolean {
  return failure.code === 'SERVICE_UNAVAILABLE';
}

function isFailedTurnTextRecoveryFailure(failure: AcpChatErrorDetails): boolean {
  return isMediaSummaryRecoveryFailure(failure)
    || failure.code === 'NETWORK'
    || failure.code === 'TIMEOUT'
    || failure.code === 'UNKNOWN';
}

/** Removes only the exact failure card once this same failed turn has an authorized media result. */
function removeResolvedPromptFailure(
  timeline: AcpTimelineSnapshot,
  userMessageId: string,
): AcpTimelineSnapshot {
  const id = `turn-failure:${userMessageId}`;
  if (timeline.itemsById[id]?.kind !== 'turn-failure') return timeline;
  const itemsById = { ...timeline.itemsById };
  delete itemsById[id];
  return {
    ...timeline,
    itemOrder: timeline.itemOrder.filter((itemId) => itemId !== id),
    itemsById,
  };
}

async function reconcileFailedPromptTurn(
  operation: TranscriptSupplementOperation,
  options: { recoverMedia: boolean },
): Promise<void> {
  const attempt = operation.attempt + 1;
  operation.attempt = attempt;
  const isCurrent = () => operation.attempt === attempt
    && isCurrentTranscriptSupplement(useAcpChatSessionStore.getState(), operation);
  if (!operation.liveUserMessageId || !isCurrent()) return;
  const supplement = await fetchFailedOpenClawTurnSupplement({
    sessionKey: operation.sessionKey,
    executionCwd: operation.executionCwd,
    snapshot: () => operationTimeline(operation)!,
    liveUserMessageId: operation.liveUserMessageId,
    isCurrent,
  });
  if (!supplement || !isCurrent()) return;
  let candidateCount = 0;
  let authorizedCount = 0;
  for (const mediaTurn of options.recoverMedia ? supplement.media : []) {
    for (const candidate of mediaTurn.candidates) {
      if (!isCurrent()) return;
      candidateCount += 1;
      const resolved = await resolveOpenClawMediaCandidate(
        operation,
        attempt,
        mediaTurn.acpTurnId,
        candidate,
        { projectUnavailable: false },
      );
      if (resolved.authorized) authorizedCount += 1;
    }
  }
  if (!isCurrent()) return;
  commitSessionTimeline(operation.sessionKey, operation.generation, (timeline) => {
    const reconciled = reconcileFailedAssistantSegment(
      timeline,
      operation.liveUserMessageId!,
      supplement.transcriptMessageId,
      supplement.text,
    );
    return candidateCount > 0 && authorizedCount === candidateCount
      ? removeResolvedPromptFailure(reconciled, operation.liveUserMessageId!)
      : reconciled;
  }, { retainForReplay: true });
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
    flushPendingLiveTextBatch();
    captureLiveSession(get());
    completedLiveTurnTimings.delete(input.sessionKey);
    loadRequestSeq += 1;
    pendingLoadUpdates.clear();
    const generation = get().generation;
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
    captureLiveSession(get());
  },

  async loadSession(input) {
    flushPendingLiveTextBatch();
    captureLiveSession(get());
    const requestId = loadRequestSeq + 1;
    loadRequestSeq = requestId;
    pendingLoadUpdates.clear();
    const generation = get().generation;
    const liveSnapshot = liveSessionSnapshots.get(input.sessionKey);
    if (
      (!liveSnapshot || !hasImageSnapshotWork(liveSnapshot))
      && !hasTranscriptSupplementWork(input.sessionKey, liveSnapshot?.generation ?? generation)
    ) {
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
    syncTimelineRecord({
      sessionKey: input.sessionKey,
      generation,
      workspaceRoot: input.workspaceRoot,
      cwd: input.cwd,
      timeline: get().timeline,
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
      if (
        result.resumedActivePrompt
        && (
          !resumedSnapshot
          || resumedSnapshot.generation !== result.generation
          || !resumedSnapshot.sending
        )
      ) {
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
      const replayUpdates = (result.sessionUpdates ?? []).filter((event) => (
        event.sessionKey === input.sessionKey && event.generation === generation
      ));
      const concurrentUpdates = (pendingLoadUpdates.get(generation) ?? []).filter((event) => (
        event.sessionKey === input.sessionKey && event.generation === generation
      ));
      pendingLoadUpdates.clear();
      const currentResumedSnapshot = result.resumedActivePrompt
        ? liveSessionSnapshots.get(input.sessionKey)
        : undefined;
      // A resumed live snapshot already owns received history; only events buffered during this load extend it.
      const sessionUpdates = currentResumedSnapshot?.generation === generation
        ? concurrentUpdates
        : [...replayUpdates, ...concurrentUpdates];
      const currentBackgroundSnapshot = !result.resumedActivePrompt
        ? liveSessionSnapshots.get(input.sessionKey)
        : undefined;
      const restorableBackgroundSnapshot = currentBackgroundSnapshot
        && currentBackgroundSnapshot.sessionKey === input.sessionKey
        && currentBackgroundSnapshot.workspaceRoot === input.workspaceRoot
        && currentBackgroundSnapshot.cwd === input.cwd
        && hasBackgroundMediaSnapshotWork(currentBackgroundSnapshot)
        ? currentBackgroundSnapshot
        : undefined;
      if (currentBackgroundSnapshot && !restorableBackgroundSnapshot) {
        resetImageGenerationCompatSession(input.sessionKey);
      }
      let timeline = currentResumedSnapshot?.generation === generation
        ? currentResumedSnapshot.timeline
        : createEmptyAcpTimeline(input.sessionKey, generation);
      for (const event of sessionUpdates) {
        timeline = applyVisibleAcpSessionUpdate(timeline, event);
      }
      if (restorableBackgroundSnapshot) {
        const restored = restoreBackgroundMediaProjections({
          replay: timeline,
          previous: restorableBackgroundSnapshot.timeline,
          sessionKey: input.sessionKey,
          generation,
        });
        timeline = restored.timeline;
        for (const evidenceId of restored.unrestoredImageEvidenceIds) {
          releaseUnrestoredImageProjection(input.sessionKey, evidenceId);
        }
      }
      const pendingAttachments = newPendingAttachments(
        createEmptyAcpTimeline(input.sessionKey, generation),
        timeline,
      );
      const restoredTurnTimings = restoreCompletedLiveTurnTimings(
        input.sessionKey,
        timeline,
        currentResumedSnapshot?.turnTimingsByUserMessageId
          ?? restorableBackgroundSnapshot?.turnTimingsByUserMessageId
          ?? {},
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
        turnTimingsByUserMessageId: restoredTurnTimings,
      });
      syncTimelineRecord({
        sessionKey: input.sessionKey,
        generation,
        workspaceRoot: input.workspaceRoot,
        cwd: input.cwd,
        timeline,
      });
      const restoredSnapshot = currentResumedSnapshot ?? restorableBackgroundSnapshot;
      if (restoredSnapshot) {
        const activeState = get();
        storeLiveSessionSnapshot({
          ...restoredSnapshot,
          generation,
          sending: activeState.sending,
          pendingImageGenerationTaskIds: activeState.pendingImageGenerationTaskIds,
          pendingVideoGenerationTaskIds: activeState.pendingVideoGenerationTaskIds,
          timeline,
          turnTimingsByUserMessageId: activeState.turnTimingsByUserMessageId,
          unconsumedTimelineUpdate: false,
        });
      } else {
        liveSessionSnapshots.delete(input.sessionKey);
      }
      resolvePendingAttachments(input.sessionKey, generation, pendingAttachments);
      const deferredProjectionOwner = `deferred-load:${requestId}:${generation}`;
      for (const { event } of restoredSnapshot?.deferredImageUpdates ?? []) {
        const reboundEvent = event.generation === generation ? event : { ...event, generation };
        get().recordImageGenerationStart(reboundEvent);
        get().recordVideoGenerationUpdate(reboundEvent);
        const evidence = extractImageGenerationCompletionFromAcpEnvelope(reboundEvent);
        if (evidence) {
          void get().projectImageGenerationCompletion(evidence, {
            reservationOwner: deferredProjectionOwner,
          });
        }
      }
      for (const { evidence } of restoredSnapshot?.deferredImageCompletions ?? []) {
        void get().projectImageGenerationCompletion(evidence, {
          reservationOwner: deferredProjectionOwner,
        });
      }
      for (const event of sessionUpdates) {
        get().recordImageGenerationStart(event);
        get().recordVideoGenerationUpdate(event);
        const evidence = extractImageGenerationCompletionFromAcpEnvelope(event);
        if (evidence) void get().projectImageGenerationCompletion(evidence);
      }
      if (!input.createIfMissing) {
        startHistoricalTranscriptSupplement(input.sessionKey, generation, input.cwd);
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
    flushPendingLiveTextBatch();
    const sessionKey = input.sessionKey;
    const queuedGeneration = get().generation;
    const browserRelease = pendingBrowserRelease(sessionKey, queuedGeneration);
    if (browserRelease && !await browserRelease) return false;
    const startState = get();
    const generation = startState.generation;
    if (startState.activeSessionKey !== sessionKey) return false;

    const startedAtMs = Date.now();
    const messageId = input.messageId ?? createOptimisticMessageId();
    const payload = { ...input, messageId, clientStartedAtMs: startedAtMs };
    const transcriptOperation = beginTranscriptSupplement(sessionKey, generation, input.cwd, messageId);

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
      flushPendingLiveTextBatch();
      const state = get();
      const settledAtMs = Date.now();
      const failure = result.success ? null : operationFailure(result);
      if (transcriptOperation.browserReleased) return result.success;
      if (!isCurrentAction(state, sessionKey, generation)) {
        settleBackgroundPromptSnapshot({
          sessionKey,
          generation,
          messageId,
          startedAtMs,
          settledAtMs,
          success: result.success,
          resultGeneration: result.generation,
          ...(failure ? { failure } : {}),
        });
        if (result.success && isCurrentTranscriptSupplement(get(), transcriptOperation)) {
          startLiveTranscriptSupplement(transcriptOperation);
        } else if (
          failure
          && isFailedTurnTextRecoveryFailure(failure)
          && transcriptSupplements.get(transcriptOperation.key)?.id === transcriptOperation.id
        ) {
          void reconcileFailedPromptTurn(transcriptOperation, {
            recoverMedia: isMediaSummaryRecoveryFailure(failure),
          }).finally(() => {
            invalidateTranscriptSupplement(transcriptOperation);
          });
        } else if (transcriptSupplements.get(transcriptOperation.key)?.id === transcriptOperation.id) {
          invalidateTranscriptSupplement(transcriptOperation);
        }
        return result.success;
      }
      deleteLiveSessionSnapshot(sessionKey, generation);
      const failedTimeline = result.success
        ? state.timeline
        : appendPromptFailure(state.timeline, messageId, failure!);
      set({
        sending: false,
        turnTimingsByUserMessageId: settledPromptTurnTimings(
          state.turnTimingsByUserMessageId,
          { messageId, success: result.success, startedAtMs, settledAtMs },
        ),
        ...(result.success
          ? applyOperationGeneration(state, result)
          : { error: null, timeline: failedTimeline }),
      });
      if (result.success) {
        const current = get();
        if (
          current.activeSessionKey === sessionKey
          && current.generation === transcriptOperation.generation
          && isCurrentTranscriptSupplement(current, transcriptOperation)
        ) {
          startLiveTranscriptSupplement(transcriptOperation);
        } else if (transcriptSupplements.get(transcriptOperation.key)?.id === transcriptOperation.id) {
          invalidateTranscriptSupplement(transcriptOperation);
        }
      } else if (
        failure
        && isFailedTurnTextRecoveryFailure(failure)
        && transcriptSupplements.get(transcriptOperation.key)?.id === transcriptOperation.id
      ) {
        void reconcileFailedPromptTurn(transcriptOperation, {
          recoverMedia: isMediaSummaryRecoveryFailure(failure),
        }).finally(() => {
          invalidateTranscriptSupplement(transcriptOperation);
        });
      } else if (transcriptSupplements.get(transcriptOperation.key)?.id === transcriptOperation.id) {
        invalidateTranscriptSupplement(transcriptOperation);
      }
      return result.success;
    } catch (error) {
      flushPendingLiveTextBatch();
      const state = get();
      const settledAtMs = Date.now();
      const failure = normalizeAcpChatError(error);
      if (transcriptOperation.browserReleased) return false;
      if (!isCurrentAction(state, sessionKey, generation)) {
        settleBackgroundPromptSnapshot({
          sessionKey,
          generation,
          messageId,
          startedAtMs,
          settledAtMs,
          success: false,
          failure,
        });
      } else {
        deleteLiveSessionSnapshot(sessionKey, generation);
      }
      set((current) => (
        isCurrentAction(current, sessionKey, generation)
          ? (() => {
            return {
              sending: false,
              error: null,
              timeline: appendPromptFailure(current.timeline, messageId, failure),
              turnTimingsByUserMessageId: settledPromptTurnTimings(
                current.turnTimingsByUserMessageId,
                { messageId, success: false, startedAtMs, settledAtMs },
              ),
            };
          })()
          : {}
      ));
      if (
        isFailedTurnTextRecoveryFailure(failure)
        && transcriptSupplements.get(transcriptOperation.key)?.id === transcriptOperation.id
      ) {
        void reconcileFailedPromptTurn(transcriptOperation, {
          recoverMedia: isMediaSummaryRecoveryFailure(failure),
        }).finally(() => {
          invalidateTranscriptSupplement(transcriptOperation);
        });
      } else {
        invalidateTranscriptSupplement(transcriptOperation);
      }
      return false;
    }
  },

  async cancel() {
    flushPendingLiveTextBatch();
    const startState = get();
    const sessionKey = startState.activeSessionKey;
    const generation = startState.generation;
    if (!sessionKey) return;
    const operation = latestLiveTranscriptOperation(sessionKey, generation);
    if (operation) invalidateTranscriptSupplement(operation);

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
    flushPendingLiveTextBatch();
    const startState = get();
    const sessionKey = startState.activeSessionKey;
    const generation = startState.generation;
    if (!sessionKey) return;
    if (!getPendingPermission(startState.timeline, requestId)) return;

    const outcome = permissionOutcome(optionId);
    try {
      const result = await hostApi.chat.respondAcpPermission({ sessionKey, requestId, outcome });
      if (result.success && result.generation != null && result.generation !== generation) {
        for (const operation of liveTranscriptOperations(sessionKey, generation)) {
          invalidateTranscriptSupplement(operation);
        }
      }
      if (result.success) {
        commitSessionTimeline(sessionKey, generation, (timeline) => (
          getPendingPermission(timeline, requestId)
            ? updatePermissionStatus(timeline, requestId, permissionStatus(outcome))
            : timeline
        ));
      }
      set((state) => {
        if (!isCurrentAction(state, sessionKey, generation)) return {};
        if (!result.success) {
          return { error: failedOperationMessage(result, 'ACP permission failed') };
        }
        const nextGeneration = result.generation ?? state.generation;
        return {
          error: null,
          generation: nextGeneration,
          timeline: result.generation == null
            ? state.timeline
            : { ...state.timeline, loadGeneration: nextGeneration },
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
      scheduleImageGenerationTaskTimeout(start.sessionKey, start.taskId);
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
      const operation = latestLiveTranscriptOperation(start.sessionKey, event.generation);
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
    const terminal = extractVideoGenerationTerminalFromAcpEnvelope(event);
    if (terminal) {
      if (terminal.status === 'failed') {
        expireVideoGenerationTask(event.sessionKey, event.generation, terminal.taskId);
        commitSessionTimeline(
          event.sessionKey,
          event.generation,
          (timeline) => appendVideoGenerationFailure(timeline, terminal.taskId),
          { retainForReplay: true },
        );
      } else {
        completeVideoGenerationTask(terminal.taskId);
      }
      return;
    }

    const state = get();
    if (event.sessionKey !== state.activeSessionKey || event.generation !== state.generation) return;
    const start = extractVideoGenerationStartFromAcpEnvelope(event);
    if (!start) return;
    const operation = latestLiveTranscriptOperation(event.sessionKey, event.generation);
    if (
      operation?.liveUserMessageId
      && operation.sessionKey === event.sessionKey
      && operation.generation === event.generation
    ) {
      operation.videoTaskIds.add(start.taskId);
    }
    scheduleVideoGenerationTaskTimeout(event.sessionKey, event.generation, start.taskId);
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
    pruneSettledActiveSnapshot(get());
    for (const snapshot of liveSessionSnapshots.values()) {
      if (!snapshot.pendingVideoGenerationTaskIds.includes(taskId)) continue;
      storeLiveSessionSnapshot({
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
        sessionKey: options.owner?.sessionKey ?? state.activeSessionKey ?? evidence.sessionKey ?? null,
        generation: options.owner?.generation ?? state.generation,
        details: projectionTraceDetails(evidence, { reason: options.staleReason ?? 'stale-projection' }),
      });
      return;
    }
    const sessionKey = resolveImageGenerationProjectionSession(state, evidence, options?.owner);
    const generation = options?.owner?.generation ?? state.generation;
    if (!sessionKey) {
      recordProjectionTrace({
        event: 'image-generation:projection-rejected',
        sessionKey: options?.owner?.sessionKey ?? state.activeSessionKey ?? evidence.sessionKey ?? null,
        generation,
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
        generation,
        details: projectionTraceDetails(evidence, { reason: 'no-fresh-context' }),
      });
      return;
    }
    if (options?.isCurrent && !options.isCurrent()) {
      recordProjectionTrace({
        event: 'image-generation:projection-rejected',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, { reason: options.staleReason ?? 'stale-projection' }),
      });
      return;
    }
    if (evidence.candidates.length === 0 && !evidence.authoritativeCaption) {
      recordProjectionTrace({
        event: 'image-generation:projection-rejected',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, { reason: 'no-candidates' }),
      });
      return;
    }

    const compat = compatSession(sessionKey);
    const correlatedTaskId = evidence.taskId
      ?? imageGenerationTaskIdFromSessionKey(evidence.sessionKey)
      ?? (usesReplayImageGenerationContext(evidence) ? compat.lastReplayTaskId : compat.lastTaskId);
    const settlePendingTask = (taskIds: string[]): string[] => {
      if (!correlatedTaskId) {
        return usesReplayImageGenerationContext(evidence)
          ? taskIds
          : [];
      }
      return taskIds.filter((taskId) => taskId !== correlatedTaskId);
    };
    const key = imageGenerationEvidenceKey({
      ...evidence,
      sessionKey,
      ...(correlatedTaskId ? { taskId: correlatedTaskId } : {}),
    });
    const finalizeProjection = (committed: boolean): void => {
      if (committed) {
        consumeDeferredImageProjection({
          sessionKey,
          generation,
          evidence,
          correlatedTaskId,
        });
        return;
      }
      const current = get();
      if (isCurrentAction(current, sessionKey, generation)) pruneSettledActiveSnapshot(current);
    };
    const reconcileSyntheticCompletion = (trackingKey: string): void => {
      const ownerTimeline = sessionTimelineCoordinator.read(sessionIdentity(sessionKey, generation))?.timeline;
      if (!ownerTimeline) return;
      const afterItemId = imageGenerationAnchorItemId(ownerTimeline, sessionKey, evidence, correlatedTaskId);
      if (!trackSyntheticImageCompletion(
        ownerTimeline,
        sessionKey,
        trackingKey,
        correlatedTaskId,
        afterItemId,
      )) return;
      if (!compat.authoritativeCaptions.has(trackingKey)) return;
      commitImageProjectionToOwner({
        sessionKey,
        generation,
        reduce: (timeline) => reconcileLateAcpImageCompletions(timeline, sessionKey, generation),
      });
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
        commitImageProjectionToOwner({
          sessionKey,
          generation,
          reduce: (timeline) => replaceSyntheticImageCaption(timeline, key, preferredCaption),
          ...(compat.delivered.has(key) ? { updatePending: settlePendingTask } : {}),
        });
        reconcileSyntheticCompletion(key);
      }
      recordProjectionTrace({
        event: 'image-generation:projection-deduped',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence),
      });
      if (compat.delivered.has(key)) {
        if (!evidence.authoritativeCaption) {
          commitImageProjectionToOwner({
            sessionKey,
            generation,
            reduce: (timeline) => timeline,
            updatePending: settlePendingTask,
          });
        }
        stopLiveTranscriptSupplementRetry(sessionKey, correlatedTaskId);
        finalizeProjection(true);
      }
      return;
    }

    const retentionOwner = `image-projection:${reservationOwner}:${key}`;
    const activeOwner = isCurrentAction(state, sessionKey, generation);
    const ownerSnapshot = activeOwner ? undefined : liveSessionSnapshots.get(sessionKey);
    if (!activeOwner && ownerSnapshot?.generation !== generation) {
      releaseDelivery(sessionKey, key, reservationOwner);
      recordProjectionTrace({
        event: 'image-generation:projection-dropped',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, { reason: options?.staleReason ?? 'stale-owner' }),
      });
      return;
    }
    syncTimelineRecord({
      sessionKey,
      generation,
      workspaceRoot: activeOwner ? state.workspaceRoot : ownerSnapshot!.workspaceRoot,
      cwd: activeOwner ? state.cwd : ownerSnapshot!.cwd,
      timeline: activeOwner ? state.timeline : ownerSnapshot!.timeline,
    });
    sessionTimelineCoordinator.retain(sessionIdentity(sessionKey, generation), retentionOwner);
    if (activeOwner) captureLiveSession(state);

    try {
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
          || !hasSessionTimelineOwner(sessionKey, generation)
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

      if (
        !ownsDeliveryReservation(sessionKey, key, reservationOwner)
        || (options?.isCurrent && !options.isCurrent())
        || !hasSessionTimelineOwner(sessionKey, generation)
      ) {
        releaseDelivery(sessionKey, key, reservationOwner);
        recordProjectionTrace({
          event: 'image-generation:projection-dropped',
          sessionKey,
          generation,
          details: projectionTraceDetails(evidence, {
            reason: options?.staleReason ?? 'stale-projection',
            latestGeneration: get().generation,
          }),
        });
        return;
      }

      const ownerTimeline = sessionTimelineCoordinator.read(sessionIdentity(sessionKey, generation))?.timeline;
      if (!ownerTimeline) {
        releaseDelivery(sessionKey, key, reservationOwner);
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
      const afterItemId = imageGenerationAnchorItemId(ownerTimeline, sessionKey, evidence, correlatedTaskId);
      const matchingAcpItemId = authoritativeCaption
        ? matchingAcpImageCompletionItemId(
            ownerTimeline,
            afterItemId,
            caption,
            sessionKey,
            correlatedTaskId,
            key,
            options?.transcriptMessageId,
          )
        : undefined;
      if (matchingAcpItemId) {
        const committed = commitImageProjectionToOwner({
          sessionKey,
          generation,
          reduce: (timeline) => dedupeAcpImageCompletionMirrors(
            mergeImageCompletionIntoAcpItem(timeline, matchingAcpItemId, key, imageParts),
          ),
          updatePending: settlePendingTask,
        });
        if (!committed) {
          releaseDelivery(sessionKey, key, reservationOwner);
          return;
        }
        if (missingCount === 0) commitDelivery(sessionKey, key, reservationOwner);
        else releaseDelivery(sessionKey, key, reservationOwner);
        recordProjectionTrace({
          event: 'image-generation:projection-merged',
          sessionKey,
          generation,
          details: projectionTraceDetails(evidence, { reason: 'matching-acp-reply' }),
        });
        if (missingCount === 0) stopLiveTranscriptSupplementRetry(sessionKey, correlatedTaskId);
        finalizeProjection(missingCount === 0);
        return;
      }
      const duplicateItemId = matchingSyntheticImageItemId(ownerTimeline, imageParts);
      if (duplicateItemId) {
        const existingItem = ownerTimeline.itemsById[duplicateItemId];
        const existingKey = existingItem?.kind === 'message-segment' ? existingItem.compat?.evidenceId : undefined;
        const captions = imageGenerationCompatSessions.get(sessionKey)?.authoritativeCaptions;
        const currentCaption = captions?.get(key);
        const existingCaption = existingKey ? captions?.get(existingKey) : undefined;
        const replaceCaption = Boolean(
          existingKey
          && currentCaption
          && (!existingCaption || currentCaption.priority > existingCaption.priority),
        );
        if (replaceCaption) captions?.set(existingKey!, currentCaption!);
        const committed = commitImageProjectionToOwner({
          sessionKey,
          generation,
          reduce: replaceCaption
            ? (timeline) => replaceSyntheticImageCaptionAtItem(timeline, duplicateItemId, currentCaption!.text)
            : (timeline) => timeline,
          updatePending: settlePendingTask,
        });
        if (!committed) {
          releaseDelivery(sessionKey, key, reservationOwner);
          return;
        }
        if (replaceCaption) reconcileSyntheticCompletion(existingKey!);
        if (missingCount === 0) commitDelivery(sessionKey, key, reservationOwner);
        else releaseDelivery(sessionKey, key, reservationOwner);
        recordProjectionTrace({
          event: 'image-generation:projection-deduped',
          sessionKey,
          generation,
          details: projectionTraceDetails(evidence, { reason: 'resolved-media-identity' }),
        });
        if (missingCount === 0) stopLiveTranscriptSupplementRetry(sessionKey, correlatedTaskId);
        finalizeProjection(missingCount === 0);
        return;
      }
      const parts: RenderPart[] = [{ kind: 'markdown', text: caption }, ...imageParts];
      const ownerState = get();
      const ownerSending = isCurrentAction(ownerState, sessionKey, generation)
        ? ownerState.sending
        : liveSessionSnapshots.get(sessionKey)?.sending ?? false;
      const committed = commitImageProjectionToOwner({
        sessionKey,
        generation,
        reduce: (timeline) => {
          const appended = appendSyntheticAssistantMessage(timeline, {
            messageId: messageIdFromEvidence(key),
            evidenceId: key,
            parts,
            afterItemId,
          });
          return evidence.historical && !ownerSending
            ? dedupeAcpImageCompletionMirrors(appended, { allowSyntheticTarget: true })
            : appended;
        },
        updatePending: settlePendingTask,
      });
      if (!committed) {
        releaseDelivery(sessionKey, key, reservationOwner);
        return;
      }
      reconcileSyntheticCompletion(key);
      if (missingCount === 0) commitDelivery(sessionKey, key, reservationOwner);
      recordProjectionTrace({
        event: 'image-generation:projection-appended',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, { imageCount: imageParts.length, missingCount }),
      });
      if (missingCount === 0) stopLiveTranscriptSupplementRetry(sessionKey, correlatedTaskId);
      finalizeProjection(missingCount === 0);
    } finally {
      releaseTimelineRetention(sessionKey, generation, retentionOwner);
    }
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
          commitInactiveSessionUpdates(liveSnapshot, [event]);
        }
      }
      return;
    }
    if (event.sessionKey !== state.activeSessionKey || event.generation !== state.generation) {
      const liveSnapshot = liveSessionSnapshots.get(event.sessionKey);
      if (liveSnapshot?.generation === event.generation) {
        commitInactiveSessionUpdates(liveSnapshot, [event]);
      }
      return;
    }
    const updatedTimeline = applyVisibleAcpSessionUpdate(state.timeline, event);
    const reconciledTimeline = isLiveMessageUpdate(event)
      ? reconcileLateAcpImageCompletions(updatedTimeline, event.sessionKey, event.generation)
      : updatedTimeline;
    const timeline = isLiveMessageUpdate(event)
      ? dedupeAcpImageCompletionMirrors(reconciledTimeline)
      : reconciledTimeline;
    const pending = newPendingAttachments(state.timeline, timeline);
    commitSessionTimeline(event.sessionKey, event.generation, () => timeline);
    resolvePendingAttachments(event.sessionKey, event.generation, pending);
    applySessionUpdateSideEffects(event);
  },

  applyPermissionRequest(event) {
    const state = get();
    if (event.sessionKey !== state.activeSessionKey || event.generation !== state.generation) {
      const liveSnapshot = liveSessionSnapshots.get(event.sessionKey);
      if (liveSnapshot?.generation !== event.generation) return;
    }

    commitSessionTimeline(
      event.sessionKey,
      event.generation,
      (timeline) => applyPermissionRequestToTimeline(timeline, event),
    );
  },

  clearError() {
    set({ error: null });
  },
}));

let acpChatSubscribed = false;
let acpChatUnsubscribers: Array<() => void> = [];

/** Stops process-local ACP work so a replacement Store cannot receive stale callbacks. */
export function disposeAcpChatSessionRuntime(): void {
  loadRequestSeq += 1;
  pendingLoadUpdates.clear();

  if (pendingLiveTextBatch) {
    clearTimeout(pendingLiveTextBatch.timer);
    pendingLiveTextBatch = undefined;
  }
  for (const timer of imageGenerationTaskTimers.values()) clearTimeout(timer);
  imageGenerationTaskTimers.clear();
  for (const timer of videoGenerationTaskTimers.values()) clearTimeout(timer);
  videoGenerationTaskTimers.clear();

  for (const operation of transcriptSupplements.values()) {
    operation.cancelled = true;
    operation.terminal = true;
    if (operation.retryTimer) clearTimeout(operation.retryTimer);
    if (operation.videoRetryTimer) clearTimeout(operation.videoRetryTimer);
    operation.retryTimer = undefined;
    operation.videoRetryTimer = undefined;
  }
  transcriptSupplements.clear();

  for (const unsubscribe of acpChatUnsubscribers.splice(0)) {
    try {
      unsubscribe();
    } catch {
      // Teardown must continue so one stale listener cannot retain the Store.
    }
  }
  acpChatSubscribed = false;

  imageGenerationCompatSessions.clear();
  browserFailureCancelOperationIds.clear();
  browserFailureCancelPromises.clear();
  liveSessionSnapshots.clear();
  completedLiveTurnTimings.clear();
  attachmentResolutionsInFlight.clear();
  sessionTimelineCoordinator.clear();
}

export function ensureAcpChatSubscriptions(): void {
  if (acpChatSubscribed) return;
  acpChatSubscribed = true;
  acpChatUnsubscribers.push(hostEvents.onAcpSessionUpdate((event) => {
    enqueueSessionUpdate(event);
  }));
  acpChatUnsubscribers.push(hostEvents.onAcpPermissionRequest((event) => {
    flushPendingLiveTextBatch();
    useAcpChatSessionStore.getState().applyPermissionRequest(event);
  }));
  acpChatUnsubscribers.push(hostEvents.onGatewayChatMessage((event) => {
    flushPendingLiveTextBatch();
    const videoTaskId = extractVideoGenerationTerminalTaskIdFromGatewayChatMessage(event);
    const evidence = extractImageGenerationCompletionFromGatewayChatMessage(event);
    const state = useAcpChatSessionStore.getState();
    if (videoTaskId) completeVideoGenerationTask(videoTaskId);
    if (
      evidence
      && !deferInactiveImageGenerationCompletion(state.activeSessionKey, evidence)
    ) void state.projectImageGenerationCompletion(evidence);
  }));
  acpChatUnsubscribers.push(hostEvents.onChatRuntimeEvent((event) => {
    flushPendingLiveTextBatch();
    const videoTaskId = extractVideoGenerationTerminalTaskIdFromRuntimeEvent(event);
    const evidence = extractImageGenerationCompletionFromRuntimeEvent(event);
    const state = useAcpChatSessionStore.getState();
    if (videoTaskId) completeVideoGenerationTask(videoTaskId);
    else if (event.type === 'run.ended') {
      refreshPendingMediaTranscriptForRequesterSession(event.sessionKey);
    }
    if (
      evidence
      && !deferInactiveImageGenerationCompletion(state.activeSessionKey, evidence)
    ) void state.projectImageGenerationCompletion(evidence);
  }));
}
