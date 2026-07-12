/**
 * Chat Page
 * Native React implementation communicating with OpenClaw Gateway
 * via gateway:rpc IPC. Session selector, thinking toggle, and refresh
 * are in the toolbar; messages render with markdown + streaming.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, Loader2, RotateCcw } from 'lucide-react';
import { useChatStore, type ChatRuntimeRunState, type RawMessage } from '@/stores/chat';
import {
  buildStreamingAssistantMessageFromRuntimeRun,
  isInternalMessage,
  runtimeRunHasPendingAsyncTasks,
} from '@/stores/chat/helpers';
import { buildBaselineRunKey, getBaseline } from '@/stores/baseline-cache';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { useArtifactPanel } from '@/stores/artifact-panel';
import { useSettingsStore } from '@/stores/settings';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ChatMessage } from './ChatMessage';
import { ChatInput, type ImageEditReference } from './ChatInput';
import { ExecutionGraphCard } from './ExecutionGraphCard';
import { RunProgressCard, shouldUseRunProgressTranscript } from './RunProgressCard';
import { ReasoningPanel } from './ReasoningPanel';
import { ChatToolbar } from './ChatToolbar';
import { projectReasoningPanels } from './reasoning-projection';
import { extractImages, extractText, extractThinking, extractToolUse, isInternalAssistantReplyText, isInternalProcessNarration, normalizeMessageRole, stripProcessMessagePrefix } from './message-utils';
import {
  deriveRuntimeTaskSteps,
  deriveTaskSteps,
  findReplyMessageIndex,
  getPostTriggerSegmentMessages,
  getRunSegmentMessages,
  hasActiveStreamingReplyInRun,
  isVisibleRuntimePlanStep,
  parseSubagentCompletionInfo,
  segmentHasFinalReply,
  type TaskStep,
} from './task-visualization';
import { hasDeliveredImageGenerationResult, isImageGenerationPending } from './image-generation-status';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useStickToBottomInstant } from '@/hooks/use-stick-to-bottom-instant';
import { useMinLoading } from '@/hooks/use-min-loading';
import { extractGeneratedFiles, generatedFileHasDiffPayload, isHtmlPreviewExt, type GeneratedFile } from '@/lib/generated-files';
import { GeneratedFilesPanel } from '@/components/file-preview/GeneratedFilesPanel';
import type { FilePreviewTarget } from '@/components/file-preview/types';
import { buildPreviewTarget } from '@/components/file-preview/build-preview-target';
import type { AttachedFileMeta } from '@/stores/chat/types';
import { mergeRuntimeRunStates, runtimeRunsShareTaskIdentity } from './runtime-run-merge';
import { DEFAULT_AGENT_AVATAR_SRC, getAgentAvatar } from '@/lib/agent-avatars';
import { toast } from 'sonner';

const ArtifactPanelLazy = lazy(() =>
  import('@/components/file-preview/ArtifactPanel').then((m) => ({ default: m.ArtifactPanel })),
);
const PanelResizeDividerLazy = lazy(() =>
  import('@/components/file-preview/PanelResizeDivider').then((m) => ({ default: m.PanelResizeDivider })),
);

type GraphStepCacheEntry = {
  steps: ReturnType<typeof deriveTaskSteps>;
  agentLabel: string;
  sessionLabel: string;
  segmentEnd: number;
  replyIndex: number | null;
  triggerIndex: number;
};

type UserRunCard = {
  triggerIndex: number;
  replyIndex: number | null;
  active: boolean;
  agentLabel: string;
  sessionLabel: string;
  segmentEnd: number;
  runtimeRun: ChatRuntimeRunState | null;
  steps: TaskStep[];
  messageStepTexts: string[];
  streamingReplyText: string | null;
  liveText: string | null;
  elapsedStartedAtMs: number | null;
  elapsedCompletedMs: number | null;
  /**
   * Whether the trailing "Thinking..." indicator should be hidden for this
   * card. True only when the run's live stream is currently rendered AS a
   * streaming step inside the graph (the step itself already signals
   * liveness, so the extra indicator would be redundant). False in all
   * other cases — including when the stream is promoted to a bubble
   * below the graph, or when there is no streaming content at all (the
   * gap between tool rounds), because the graph has no visible activity
   * of its own in those windows and the indicator is what tells the user
   * "work is still in progress".
   */
  suppressThinking: boolean;
};

type RunSurfaceState = {
  shouldShowTranscript: boolean;
  shouldShowRunStatus: boolean;
  shouldRenderExecutionGraph: boolean;
};

type QuestionDirectoryItem = {
  index: number;
  ordinal: number;
  title: string;
};

const QUESTION_DIRECTORY_RENDER_LIMIT = 300;
const CHILD_TRANSCRIPT_LOAD_LIMIT = 3;

type Translate = (key: string, params?: Record<string, unknown>) => string;
type RunCompactKind = 'task-flow' | 'image' | 'video' | 'artifact' | 'generic';

type TaskFlowCompactProgress = {
  total: number;
  completed: number;
  running: number;
  blocked: number;
  failed: number;
  aborted: number;
};

const PROBLEM_STEP_STATUSES = new Set<TaskStep['status']>(['error', 'blocked', 'failed', 'aborted']);
const USER_FACING_RUNTIME_TOOLS = new Set([
  'create_designed_pptx_file',
  'create_docx_file',
  'create_html_app_file',
  'create_pptx_file',
  'create_text_file',
  'create_xlsx_file',
  'image_edit',
  'image_generate',
  'video_generate',
]);

function getPrimaryMessageStepTexts(steps: TaskStep[]): string[] {
  return steps
    .filter((step) => step.kind === 'message' && step.parentId === 'agent-run' && !!step.detail)
    .map((step) => step.detail!);
}

function sanitizeGraphSteps(steps: TaskStep[]): TaskStep[] {
  return steps.filter((step) => {
    if (step.kind === 'thinking') return false;
    if (step.kind === 'message' && step.detail && isInternalProcessNarration(step.detail)) return false;
    return true;
  });
}

function runCardHasProblem(card: UserRunCard): boolean {
  return card.steps.some((step) => PROBLEM_STEP_STATUSES.has(step.status));
}

function normalizeRunToken(value: string | undefined | null): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function taskStepLooksLikeUserFacingArtifact(step: TaskStep): boolean {
  if (step.id.startsWith('artifact:')) return true;
  if (step.id.startsWith('verification:') && step.parentId?.startsWith('artifact:')) return true;

  const runtimeKind = normalizeRunToken(step.runtimeKind);
  if (runtimeKind === 'composite' || runtimeKind === 'composite-task' || runtimeKind.startsWith('media.')) {
    return true;
  }

  if (step.kind === 'tool' && USER_FACING_RUNTIME_TOOLS.has(normalizeRunToken(step.label))) {
    return true;
  }

  return false;
}

function problemStepLooksUserFacing(step: TaskStep): boolean {
  if (taskStepLooksLikeUserFacingArtifact(step)) return true;
  const searchText = taskStepSearchText(step);
  return /\b(image_generate|image_edit|video_generate|create_(?:docx|html_app|pptx|text|xlsx)_file)\b/i.test(searchText)
    || /(artifact|media|pptx?|xlsx?|docx?|html?|video|image|产物|媒体|图片|图像|修图|视频|文档|表格|小程序)/i.test(searchText);
}

function runCardHasUserFacingActivity(card: UserRunCard, generatedFiles: GeneratedFile[]): boolean {
  if (generatedFiles.length > 0) return true;
  if (getTaskFlowCompactProgress(card.steps)) return true;
  return card.steps.some(taskStepLooksLikeUserFacingArtifact);
}

function runCardHasUserFacingProblem(card: UserRunCard, generatedFiles: GeneratedFile[]): boolean {
  if (!runCardHasProblem(card)) return false;
  if (runCardHasUserFacingActivity(card, generatedFiles)) return true;
  return card.steps.some((step) =>
    PROBLEM_STEP_STATUSES.has(step.status) && problemStepLooksUserFacing(step),
  );
}

function getRuntimeTaskProblemStatus(run: ChatRuntimeRunState | null): TaskStep['status'] | null {
  const tasks = run?.tasks ?? [];
  if (tasks.some((task) => task.status === 'error')) return 'error';
  if (tasks.some((task) => task.status === 'partial' || task.status === 'waiting_approval')) return 'blocked';
  return null;
}

function getRunCompactStatus(card: UserRunCard): TaskStep['status'] {
  const runtimeStatus = card.runtimeRun?.status;
  const taskFlowProgress = getTaskFlowCompactProgress(card.steps);
  const taskFlowProblemStatus = getTaskFlowProblemStatus(taskFlowProgress)
    ?? getRuntimeTaskProblemStatus(card.runtimeRun);
  if (runtimeStatus === 'completed') {
    const gateDecision = card.runtimeRun?.gateResult?.decision;
    if (gateDecision === 'blocked_needs_user' || gateDecision === 'continue_required') return 'blocked';
    if (taskFlowProblemStatus) return taskFlowProblemStatus;
    if ((taskFlowProgress?.running ?? 0) > 0 || runtimeRunHasPendingAsyncTasks(card.runtimeRun ?? undefined)) {
      return 'running';
    }
    return 'completed';
  }
  if (card.active) {
    if (runtimeStatus === 'aborted') return 'aborted';
    if (runtimeStatus === 'error') return 'error';
    if (card.runtimeRun?.gateResult?.decision === 'blocked_needs_user') return 'blocked';
    if (taskFlowProgress && taskFlowProgress.running === 0 && taskFlowProblemStatus) {
      return taskFlowProblemStatus;
    }
    return 'running';
  }
  if (runtimeStatus === 'aborted') return 'aborted';
  if (runtimeStatus === 'error') return 'error';
  const problemStep = card.steps.find((step) => PROBLEM_STEP_STATUSES.has(step.status));
  if (problemStep) return problemStep.status;
  return 'completed';
}

function isCompositeResultReplyMessage(message: RawMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (message.localArtifactResultKind === 'composite') return true;
  if (typeof message.id === 'string' && message.id.startsWith('composite-result:')) return true;
  const text = extractText(message);
  return (message._attachedFiles?.length ?? 0) > 0
    && /随机示例包/.test(text)
    && /(?:统一)?产物清单/.test(text);
}

function taskStepSearchText(step: TaskStep): string {
  return `${step.label}\n${step.detail ?? ''}`.toLowerCase();
}

function isTaskFlowCompactStep(step: TaskStep): boolean {
  if (step.taskId && step.flowId && step.id === `plan-step:task:${step.taskId}`) return true;
  if (step.id === 'plan-step:uclaw.composite') return false;
  const runtimeKind = typeof step.runtimeKind === 'string' ? step.runtimeKind.trim().toLowerCase() : '';
  if (runtimeKind) return runtimeKind === 'composite-task';
  return step.id.startsWith('plan-step:uclaw.composite.');
}

function getTaskFlowCompactProgress(steps: TaskStep[]): TaskFlowCompactProgress | null {
  const taskStepsById = new Map<string, TaskStep>();
  for (const step of steps) {
    if (!isTaskFlowCompactStep(step)) continue;
    taskStepsById.set(step.taskId ?? step.id, step);
  }
  if (taskStepsById.size === 0) return null;
  const taskSteps = [...taskStepsById.values()];
  return {
    total: taskSteps.length,
    completed: taskSteps.filter((step) => step.status === 'completed').length,
    running: taskSteps.filter((step) => step.status === 'running').length,
    blocked: taskSteps.filter((step) => step.status === 'blocked').length,
    failed: taskSteps.filter((step) => step.status === 'failed' || step.status === 'error').length,
    aborted: taskSteps.filter((step) => step.status === 'aborted').length,
  };
}

function getTaskFlowProblemStatus(progress: TaskFlowCompactProgress | null): TaskStep['status'] | null {
  if (!progress) return null;
  if (progress.failed > 0) return 'error';
  if (progress.aborted > 0) return 'aborted';
  if (progress.blocked > 0) return 'blocked';
  return null;
}

function formatRunElapsedDuration(durationMs: number | null | undefined): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return null;
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function getRunDurationStepElapsedMs(steps: TaskStep[]): number | null {
  const durationStep = steps.find((step) => step.id === 'run-duration' && typeof step.durationMs === 'number');
  return durationStep?.durationMs ?? null;
}

function getRunCardElapsedMs(card: UserRunCard, nowMs: number): number | null {
  if (card.active && card.elapsedStartedAtMs != null) {
    return Math.max(0, nowMs - card.elapsedStartedAtMs);
  }
  if (card.runtimeRun?.events.some((event) => event.producer === 'history')) {
    return null;
  }
  return card.elapsedCompletedMs ?? getRunDurationStepElapsedMs(card.steps);
}

function getCompletedRunElapsedMs(run: ChatRuntimeRunState | null, startedAtMs: number | null): number | null {
  if (!run || startedAtMs == null) return null;
  const terminalEvent = [...run.events].reverse().find((event) => event.type === 'run.ended');
  const endedAtMs = toTimestampMs(run.endedAt)
    ?? (terminalEvent?.type === 'run.ended'
      ? toTimestampMs(terminalEvent.endedAt) ?? toTimestampMs(terminalEvent.ts)
      : null);
  if (endedAtMs == null || endedAtMs < startedAtMs) return null;
  return endedAtMs - startedAtMs;
}

function hasFinalAssistantDeltaAfterLatestTool(run: ChatRuntimeRunState | null): boolean {
  if (!run) return false;
  let latestToolIndex = -1;
  let latestAssistantIndex = -1;
  let latestAssistantPhase = '';

  run.events.forEach((event, index) => {
    if (event.type === 'tool.started' || event.type === 'tool.updated' || event.type === 'tool.completed') {
      latestToolIndex = index;
      return;
    }
    if (event.type !== 'assistant.delta') return;
    const text = event.text ?? event.delta ?? '';
    if (!text.trim()) return;
    latestAssistantIndex = index;
    latestAssistantPhase = event.phase?.trim().toLowerCase() ?? '';
  });

  if (latestAssistantIndex <= latestToolIndex) return false;
  return !['analysis', 'commentary', 'preamble', 'progress', 'thinking'].includes(latestAssistantPhase);
}

function inferRunCompactKind(card: UserRunCard, generatedFiles: GeneratedFile[]): RunCompactKind {
  if (getTaskFlowCompactProgress(card.steps)) return 'task-flow';
  const structuredStepText = card.steps
    .map((step) => `${step.label}\n${step.runtimeKind ?? ''}`)
    .join('\n');
  const artifactKinds = (card.runtimeRun?.artifacts ?? [])
    .map((artifact) => `${artifact.kind ?? ''}\n${artifact.mimeType ?? ''}`)
    .join('\n');
  if (/(?:video_generate|video generation|media\.video|video\/|^video$|视频任务)/im.test(`${structuredStepText}\n${artifactKinds}`)) return 'video';
  if (/(?:image_generate|image_edit|image generation|media\.image|image\/|^image$|图片任务|修图任务)/im.test(`${structuredStepText}\n${artifactKinds}`)) return 'image';
  if (generatedFiles.length > 0 || /(?:artifact|presentation|spreadsheet|document|pdf|产物任务|文档任务|表格任务|小程序任务)/i.test(`${structuredStepText}\n${artifactKinds}`)) {
    return 'artifact';
  }
  return 'generic';
}

function buildRunCompactSummary(card: UserRunCard, generatedFiles: GeneratedFile[], t: Translate, nowMs: number): string {
  const status = getRunCompactStatus(card);
  const withElapsed = (summary: string): string => {
    const elapsed = formatRunElapsedDuration(getRunCardElapsedMs(card, nowMs));
    return elapsed ? `${summary} · ${elapsed}` : summary;
  };
  if (status === 'blocked') return withElapsed(t('executionGraph.compact.blocked'));
  if (status === 'failed' || status === 'error') return withElapsed(t('executionGraph.compact.failed'));
  if (status === 'aborted') return withElapsed(t('executionGraph.compact.aborted'));

  const kind = inferRunCompactKind(card, generatedFiles);
  const taskFlowProgress = kind === 'task-flow' ? getTaskFlowCompactProgress(card.steps) : null;
  if (status === 'running') {
    if (kind === 'task-flow') {
      return withElapsed(t('executionGraph.compact.workingTaskFlow', {
        completedCount: taskFlowProgress?.completed ?? 0,
        totalCount: taskFlowProgress?.total ?? generatedFiles.length,
      }));
    }
    if (kind === 'image') return withElapsed(t('executionGraph.compact.generatingImage'));
    if (kind === 'video') return withElapsed(t('executionGraph.compact.generatingVideo'));
    if (kind === 'artifact') return withElapsed(t('executionGraph.compact.workingArtifact'));
    return withElapsed(t('executionGraph.compact.working'));
  }

  if (kind === 'task-flow') {
    return withElapsed(t('executionGraph.compact.taskFlowDone', {
      totalCount: taskFlowProgress?.total ?? generatedFiles.length,
    }));
  }
  if (kind === 'image') return withElapsed(t('executionGraph.compact.imageDone'));
  if (kind === 'video') return withElapsed(t('executionGraph.compact.videoDone'));
  if (kind === 'artifact') return withElapsed(t('executionGraph.compact.artifactDone'));
  return withElapsed(t('executionGraph.compact.done'));
}

function buildRunTranscriptSummary(card: UserRunCard, nowMs: number): string {
  const elapsed = formatRunElapsedDuration(getRunCardElapsedMs(card, nowMs));
  const status = getRunCompactStatus(card);
  if (status === 'running') return elapsed ? `处理中 · ${elapsed}` : '处理中';
  if (status === 'completed') return elapsed ? `已处理 ${elapsed}` : '处理完成';
  if (status === 'blocked') return elapsed ? `任务需要补充处理 · ${elapsed}` : '任务需要补充处理';
  if (status === 'failed' || status === 'error') return elapsed ? `任务执行失败 · ${elapsed}` : '任务执行失败';
  if (status === 'aborted') return elapsed ? `任务已停止 · ${elapsed}` : '任务已停止';
  return elapsed ? `已处理 ${elapsed}` : '处理中';
}

function buildQuestionDirectoryTitle(message: RawMessage, fallback: string): string {
  const normalized = extractText(message).replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  return normalized.length > 64 ? `${normalized.slice(0, 64)}…` : normalized;
}

function isRealUserMessage(msg: RawMessage): boolean {
  if (normalizeMessageRole(msg.role) !== 'user') return false;
  if (isInternalMessage(msg)) return false;
  const content = msg.content;
  if (!Array.isArray(content)) return true;
  // If every block in the content is a tool_result, this is a Gateway
  // tool-result wrapper, not a real user message.
  const blocks = content as Array<{ type?: string }>;
  return blocks.length === 0 || !blocks.every((b) => b.type === 'tool_result' || b.type === 'toolResult');
}

function findLatestRealUserMessage(messages: RawMessage[]): { message: RawMessage; index: number } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isRealUserMessage(message)) {
      return { message, index };
    }
  }
  return null;
}

function hasUserFacingMediaAttachments(msg: RawMessage): boolean {
  return (msg._attachedFiles ?? []).some((file) => (
    file.mimeType.startsWith('image/')
    || file.mimeType.startsWith('video/')
    || file.mimeType.startsWith('audio/')
  ));
}

function hasRenderableChatMessageContent(
  msg: RawMessage,
  options: { suppressAssistantText: boolean; suppressToolCards: boolean },
): boolean {
  const role = normalizeMessageRole(msg.role);
  if (role === 'toolresult' || role === 'tool_result') return false;
  const hasText = !(options.suppressAssistantText && role === 'assistant')
    && extractText(msg).trim().length > 0;
  const hasImages = extractImages(msg).length > 0;
  const hasAttachments = (msg._attachedFiles?.length ?? 0) > 0;
  return hasText || hasImages || hasAttachments;
}

function defaultRunSurfaceState(): RunSurfaceState {
  return {
    shouldShowTranscript: false,
    shouldShowRunStatus: false,
    shouldRenderExecutionGraph: false,
  };
}

function generatedFileToTarget(file: GeneratedFile): FilePreviewTarget {
  return {
    filePath: file.filePath,
    fileName: file.fileName,
    ext: file.ext,
    mimeType: file.mimeType,
    contentType: file.contentType,
    action: file.action,
    fullContent: file.fullContent,
    baseline: file.baseline,
    edits: file.edits,
  };
}

function hasRunningRuntimeTool(run: ChatRuntimeRunState | null): boolean {
  if (!run) return false;
  const toolStatuses = new Map<string, 'running' | 'completed' | 'error'>();
  for (const event of run.events) {
    if (event.type === 'tool.started' || event.type === 'tool.updated') {
      toolStatuses.set(event.toolCallId, 'running');
      continue;
    }
    if (event.type === 'tool.completed') {
      toolStatuses.set(event.toolCallId, event.isError ? 'error' : 'completed');
    }
  }
  return Array.from(toolStatuses.values()).some((status) => status === 'running');
}

function isFilteredRuntimeToolName(name: string | undefined | null): boolean {
  const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
  return normalized === 'process';
}

function gateHasVisibleRuntimeWork(gate: NonNullable<ChatRuntimeRunState['gateResult']>): boolean {
  return gate.artifactCount > 0
    || gate.requiredVerificationCount > 0
    || gate.blockingIssueCount > 0
    || gate.warningIssueCount > 0
    || gate.issues.length > 0
    || gate.decision !== 'deliverable';
}

function hasRuntimeGraphActivity(run: ChatRuntimeRunState | null): boolean {
  return Boolean(run?.events.some((event) =>
    (event.type === 'run.plan.updated' && event.steps.some(isVisibleRuntimePlanStep))
    || (event.type === 'run.step.updated' && isVisibleRuntimePlanStep(event.step))
    || (event.type === 'tool.started' && !isFilteredRuntimeToolName(event.name))
    || (event.type === 'tool.updated' && !isFilteredRuntimeToolName(event.name))
    || (event.type === 'tool.completed' && !isFilteredRuntimeToolName(event.name))
    || event.type === 'artifact.produced'
    || event.type === 'verification.completed'
    || event.type === 'gate.issue'
    || event.type === 'run.checkpoint'
    || (event.type === 'gate.evaluated' && gateHasVisibleRuntimeWork(event.gate))
    || (event.type === 'command.output' && !isFilteredRuntimeToolName(event.name))
    || event.type === 'patch.completed'
    || event.type === 'approval.updated',
  ));
}

function historicalRunIdFromKey(sessionKey: string, key: string | number): string {
  return `history:${sessionKey}:${key}`;
}

function historicalTimestampKeys(timestamp: number | undefined): Array<string | number> {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return [];
  const keys: Array<string | number> = [timestamp];
  const timestampMs = toTimestampMs(timestamp);
  if (timestampMs != null && timestampMs !== timestamp) keys.push(timestampMs);
  return keys;
}

function buildHistoricalRunIdsForMessage(sessionKey: string, triggerMessage: RawMessage, index: number): string[] {
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

function buildHistoricalRunIdForMessage(sessionKey: string, triggerMessage: RawMessage, index: number): string {
  return buildHistoricalRunIdsForMessage(sessionKey, triggerMessage, index)[0] ?? historicalRunIdFromKey(sessionKey, index);
}

function toTimestampMs(value: number | undefined | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < 1e12 ? value * 1000 : value;
}

function getRuntimeEventMs(event: ChatRuntimeRunState['events'][number]): number | null {
  const direct = toTimestampMs(event.ts);
  if (direct != null) return direct;
  if (event.type === 'run.started') return toTimestampMs(event.startedAt);
  if (event.type === 'run.ended') return toTimestampMs(event.endedAt);
  return null;
}

function getRunFirstEventMs(run: ChatRuntimeRunState): number | null {
  const startedAt = toTimestampMs(run.startedAt);
  const eventTimes = run.events
    .map(getRuntimeEventMs)
    .filter((value): value is number => value != null);
  const firstEventAt = eventTimes.length > 0 ? Math.min(...eventTimes) : null;
  if (startedAt == null) return firstEventAt;
  if (firstEventAt == null) return startedAt;
  return Math.min(startedAt, firstEventAt);
}

function getSegmentStartMs(triggerMessage: RawMessage, lastUserMessageAt: number | null): number | null {
  return toTimestampMs(triggerMessage.timestamp) ?? toTimestampMs(lastUserMessageAt);
}

export function mergeRuntimeRunsForSegment(
  sessionKey: string,
  triggerMessage: RawMessage,
  triggerIndex: number,
  runs: ChatRuntimeRunState[],
): ChatRuntimeRunState | null {
  return mergeRuntimeRunStates(
    `segment:${buildHistoricalRunIdForMessage(sessionKey, triggerMessage, triggerIndex)}`,
    sessionKey,
    runs,
  );
}

function canMergeRuntimeRunIntoActiveSegment(
  run: ChatRuntimeRunState,
  sessionKey: string,
  activeRunId: string | null,
): boolean {
  if (activeRunId && run.runId === activeRunId) return true;
  if (!run.sessionKey) return false;
  return run.sessionKey === sessionKey;
}

export function getRuntimeRunForSegment(
  runtimeRuns: Record<string, ChatRuntimeRunState>,
  sessionKey: string,
  triggerMessage: RawMessage,
  triggerIndex: number,
  activeRunId: string | null,
  isLatestRunSegment: boolean,
  lastUserMessageAt: number | null,
): ChatRuntimeRunState | null {
  if (isLatestRunSegment && activeRunId) {
    const activeRun = runtimeRuns[activeRunId] ?? null;
    const activeRunStartMs = activeRun ? getRunFirstEventMs(activeRun) : null;
    const segmentStartMs = getSegmentStartMs(triggerMessage, lastUserMessageAt);
    const startBoundaryMs = activeRunStartMs ?? segmentStartMs;
    const sameTurnRuns = Object.values(runtimeRuns).filter((run) => {
      if (run.runId.startsWith('history:')) return false;
      if (!canMergeRuntimeRunIntoActiveSegment(run, sessionKey, activeRunId)) return false;
      if (startBoundaryMs == null) return false;
      const firstEventMs = getRunFirstEventMs(run);
      if (firstEventMs == null) return false;
      return firstEventMs >= startBoundaryMs - 5_000;
    });
    const mergedRun = mergeRuntimeRunsForSegment(sessionKey, triggerMessage, triggerIndex, sameTurnRuns);
    if (mergedRun) return mergedRun;
  }

  const historicalRun = buildHistoricalRunIdsForMessage(sessionKey, triggerMessage, triggerIndex)
    .map((runId) => runtimeRuns[runId])
    .find((run): run is ChatRuntimeRunState => Boolean(run && run.sessionKey === sessionKey));
  if (historicalRun?.sessionKey === sessionKey) {
    const relatedTaskRuns = Object.values(runtimeRuns).filter((run) => (
      run !== historicalRun
      && !run.runId.startsWith('history:')
      && run.sessionKey === sessionKey
      && runtimeRunsShareTaskIdentity(historicalRun, run)
    ));
    return relatedTaskRuns.length > 0
      ? mergeRuntimeRunsForSegment(
          sessionKey,
          triggerMessage,
          triggerIndex,
          [historicalRun, ...relatedTaskRuns],
        )
      : historicalRun;
  }

  return null;
}

// Keep the last non-empty execution-graph snapshot per session/run outside
// React state so `loadHistory` refreshes can still fall back to the previous
// steps without tripping React's set-state-in-effect lint rule.
const graphStepCacheStore = new Map<string, Record<string, GraphStepCacheEntry>>();
const streamingTimestampStore = new Map<string, number>();
const CHAT_SESSION_CACHE_MAX_SESSIONS = 16;
const EMPTY_CHILD_TRANSCRIPTS: Record<string, RawMessage[]> = {};
const EMPTY_GRAPH_STEP_CACHE: Record<string, GraphStepCacheEntry> = {};

function setBoundedSessionEntry<K, V>(map: Map<K, V>, key: K, value: V, maxEntries = CHAT_SESSION_CACHE_MAX_SESSIONS): void {
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

export function Chat() {
  const { t } = useTranslation('chat');
  const gatewayStatus = useGatewayStore((s) => s.status);
  const isGatewayRunning = gatewayStatus.state === 'running';

  const messages = useChatStore((s) => s.messages);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const sessions = useChatStore((s) => s.sessions);
  const sessionLabels = useChatStore((s) => s.sessionLabels);
  const loading = useChatStore((s) => s.loading);
  const loadingMoreHistory = useChatStore((s) => s.loadingMoreHistory);
  const hasMoreHistory = useChatStore((s) => s.hasMoreHistory);
  const loadMoreHistory = useChatStore((s) => s.loadMoreHistory);
  const sending = useChatStore((s) => s.sending);
  const pendingImageGenerationLocal = useChatStore((s) => s.pendingImageGenerationLocal);
  const pendingVideoGenerationLocal = useChatStore((s) => s.pendingVideoGenerationLocal);
  const error = useChatStore((s) => s.error);
  const runError = useChatStore((s) => s.runError);
  const streamingMessage = useChatStore((s) => s.streamingMessage);
  const streamingTools = useChatStore((s) => s.streamingTools);
  const pendingFinal = useChatStore((s) => s.pendingFinal);
  const activeRunId = useChatStore((s) => s.activeRunId);
  const runtimeRuns = useChatStore((s) => s.runtimeRuns ?? {});
  const sendMessage = useChatStore((s) => s.sendMessage);
  const abortRun = useChatStore((s) => s.abortRun);
  const retryLastRun = useChatStore((s) => s.retryLastRun);
  const clearError = useChatStore((s) => s.clearError);
  const devModeUnlocked = useSettingsStore((s) => s.devModeUnlocked);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const agents = useAgentsStore((s) => s.agents);

  const cleanupEmptySession = useChatStore((s) => s.cleanupEmptySession);
  const lastUserMessageAt = useChatStore((s) => s.lastUserMessageAt);
  const agentsList = useAgentsStore((s) => s.agents);
  const currentAgent = useMemo(
    () => (agentsList ?? []).find((a) => a.id === currentAgentId) ?? null,
    [agentsList, currentAgentId],
  );
  const currentSession = sessions.find((session) => session.key === currentSessionKey);
  const currentWorkspace = currentSession?.cwd
    || currentAgent?.workspace
    || '';
  const currentReasoningLevel = currentSession?.reasoningLevel ?? 'on';
  const currentAgentAvatarSrc = currentAgent?.profile?.avatarId
    ? getAgentAvatar(currentAgent.profile.avatarId).src
    : DEFAULT_AGENT_AVATAR_SRC;
  const [imageEditReference, setImageEditReference] = useState<ImageEditReference | null>(null);
  const [runtimeNowMs, setRuntimeNowMs] = useState(() => Date.now());
  const panelOpen = useArtifactPanel((s) => s.open);
  const panelWidthPct = useArtifactPanel((s) => s.widthPct);
  const openChanges = useArtifactPanel((s) => s.openChanges);
  const openPreview = useArtifactPanel((s) => s.openPreview);
  const closeArtifactPanel = useArtifactPanel((s) => s.close);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  // Close the panel when the session changes — its contents would otherwise
  // be stale (file list belongs to the previous chat).
  useEffect(() => {
    closeArtifactPanel();
  }, [currentSessionKey, closeArtifactPanel]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setImageEditReference(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [currentSessionKey]);
  const [childTranscriptsBySession, setChildTranscriptsBySession] = useState<Record<string, Record<string, RawMessage[]>>>({});
  const [questionDirectoryOpenSessionKey, setQuestionDirectoryOpenSessionKey] = useState<string | null>(null);
  const childTranscripts = childTranscriptsBySession[currentSessionKey] ?? EMPTY_CHILD_TRANSCRIPTS;

  // Callback for file cards in chat messages — opens the in-app preview
  // panel instead of the system default editor.
  const handleOpenAttachedFile = useCallback((file: AttachedFileMeta) => {
    if (!file.filePath) return;
    if (/^https?:\/\//i.test(file.filePath.trim())) {
      void invokeIpc('shell:openExternal', file.filePath);
      return;
    }
    if (file.mimeType === 'application/x-directory') {
      void invokeIpc('shell:openPath', file.filePath)
        .then((error) => {
          if (typeof error === 'string' && error) {
            toast.error(error);
          }
        })
        .catch(() => {
          toast.error(t('filePreview.errors.openInFinderFailed'));
        });
      return;
    }
    const target = buildPreviewTarget(file.filePath, file.fileName, file.fileSize);
    openPreview(target);
  }, [openPreview, t]);

  const handleUseImageAsReference = useCallback((file: AttachedFileMeta) => {
    if (!file.filePath || !file.mimeType.startsWith('image/')) return;
    setImageEditReference({
      fileName: file.fileName,
      mimeType: file.mimeType,
      fileSize: file.fileSize,
      filePath: file.filePath,
      preview: file.preview,
    });
  }, []);
  // Persistent per-run override for the Execution Graph's expanded/collapsed
  // state. Keyed by a stable run id (trigger message id, or a fallback of
  // `${sessionKey}:${triggerIdx}`) so user toggles survive the `loadHistory`
  // refresh that runs after every final event — otherwise the card would
  // remount and reset. `undefined` values mean "user hasn't toggled, let the
  // card pick a default from its own `active` prop."
  const [graphExpandedOverrides, setGraphExpandedOverrides] = useState<Record<string, boolean>>({});
  const graphStepCache: Record<string, GraphStepCacheEntry> = graphStepCacheStore.get(currentSessionKey) ?? EMPTY_GRAPH_STEP_CACHE;
  const minLoading = useMinLoading(loading && messages.length > 0);
  const { contentRef, scrollRef, scrollToBottom, isAtBottom } = useStickToBottomInstant(currentSessionKey, sending);

  // Load data when gateway is running.
  // When the store already holds messages for this session (i.e. the user
  // is navigating *back* to Chat), use quiet mode so the existing messages
  // stay visible while fresh data loads in the background.  This avoids
  // an unnecessary messages → spinner → messages flicker.
  useEffect(() => {
    return () => {
      // If the user navigates away without sending any messages, remove the
      // empty session so it doesn't linger as a ghost entry in the sidebar.
      cleanupEmptySession();
    };
  }, [cleanupEmptySession]);

  useEffect(() => {
    if (agents.length > 0) return;
    const timer = window.setTimeout(() => {
      void fetchAgents({ quiet: true });
    }, 750);
    return () => window.clearTimeout(timer);
  }, [agents.length, fetchAgents]);

  useEffect(() => {
    const completions = messages
      .map((message) => parseSubagentCompletionInfo(message))
      .filter((value): value is NonNullable<typeof value> => value != null);
    const missing = completions
      .filter((completion) => !childTranscripts[completion.sessionId])
      .slice(0, CHILD_TRANSCRIPT_LOAD_LIMIT);
    if (missing.length === 0) return;

    let cancelled = false;
    void Promise.all(
      missing.map(async (completion) => {
        try {
          const result = await hostApiFetch<{ success: boolean; messages?: RawMessage[] }>(
            `/api/sessions/transcript?agentId=${encodeURIComponent(completion.agentId)}&sessionId=${encodeURIComponent(completion.sessionId)}`,
          );
          if (!result.success) {
            console.warn('Failed to load child transcript:', {
              agentId: completion.agentId,
              sessionId: completion.sessionId,
              result,
            });
            return null;
          }
          return { sessionId: completion.sessionId, messages: result.messages || [] };
        } catch (error) {
          console.warn('Failed to load child transcript:', {
            agentId: completion.agentId,
            sessionId: completion.sessionId,
            error,
          });
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setChildTranscriptsBySession((current) => {
        const currentSessionTranscripts = current[currentSessionKey] ?? {};
        let changed = false;
        const nextSessionTranscripts = { ...currentSessionTranscripts };
        for (const result of results) {
          if (!result) continue;
          nextSessionTranscripts[result.sessionId] = result.messages;
          changed = true;
        }
        if (!changed) return current;
        const next = {
          ...current,
          [currentSessionKey]: nextSessionTranscripts,
        };
        const sessionKeys = Object.keys(next);
        while (sessionKeys.length > CHAT_SESSION_CACHE_MAX_SESSIONS) {
          const oldestKey = sessionKeys.shift();
          if (!oldestKey) break;
          delete next[oldestKey];
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [messages, childTranscripts, currentSessionKey]);

  const streamMsg = streamingMessage && typeof streamingMessage === 'object'
    ? streamingMessage as unknown as { role?: string; content?: unknown; timestamp?: number }
    : null;
  const latestRealUserMessage = findLatestRealUserMessage(messages);
  const currentRuntimeRun = activeRunId
    ? mergeRuntimeRunsForSegment(
      currentSessionKey,
      latestRealUserMessage?.message ?? { role: 'user', content: '' },
      latestRealUserMessage?.index ?? 0,
      Object.values(runtimeRuns).filter((run) => {
        if (run.runId.startsWith('history:')) return false;
        if (!canMergeRuntimeRunIntoActiveSegment(run, currentSessionKey, activeRunId)) return false;
        const activeRun = runtimeRuns[activeRunId];
        const activeStartMs = activeRun ? getRunFirstEventMs(activeRun) : null;
        const firstEventMs = getRunFirstEventMs(run);
        return activeStartMs != null && firstEventMs != null && firstEventMs >= activeStartMs - 5_000;
      }),
    )
    : null;
  const effectiveStreamMsg = useMemo(() => (
    buildStreamingAssistantMessageFromRuntimeRun(
      currentRuntimeRun,
      streamMsg as RawMessage | null,
      { timestamp: currentRuntimeRun?.lastEventAt },
    ) as (RawMessage & { timestamp?: number }) | null
  ), [currentRuntimeRun, streamMsg]);
  const streamTimestamp = typeof effectiveStreamMsg?.timestamp === 'number' ? effectiveStreamMsg.timestamp : 0;
  useEffect(() => {
    if (!sending) {
      streamingTimestampStore.delete(currentSessionKey);
      return;
    }
    if (!streamingTimestampStore.has(currentSessionKey)) {
      setBoundedSessionEntry(streamingTimestampStore, currentSessionKey, streamTimestamp || Date.now() / 1000);
    }
  }, [currentSessionKey, sending, streamTimestamp]);

  const streamingTimestamp = sending
    ? (streamingTimestampStore.get(currentSessionKey) ?? streamTimestamp)
    : 0;
  const streamText = effectiveStreamMsg
    ? extractText(effectiveStreamMsg)
    : (typeof streamingMessage === 'string' ? streamingMessage : '');
  const hasStreamText = streamText.trim().length > 0;
  // Whether the streaming chunk currently carries a `thinking` block. Used as
  // a liveness signal so the run stays "active" (and the ExecutionGraphCard
  // keeps showing its trailing "Thinking..." indicator) during the brief window
  // between a tool finishing and the next text/tool chunk arriving — that gap
  // is normally only filled by streamed thinking. NOT included in
  // `shouldRenderStreaming`: a thinking-only stream chunk should not produce
  // a chat bubble (thinking is rendered exclusively inside the ExecutionGraph).
  const streamThinking = effectiveStreamMsg ? extractThinking(effectiveStreamMsg) : null;
  const hasStreamThinking = !!streamThinking && streamThinking.trim().length > 0;
  const streamTools = effectiveStreamMsg ? extractToolUse(effectiveStreamMsg) : [];
  const hasStreamTools = streamTools.length > 0;
  const streamImages = effectiveStreamMsg ? extractImages(effectiveStreamMsg) : [];
  const hasStreamImages = streamImages.length > 0;
  const hasStreamToolStatus = streamingTools.length > 0;
  const hasRunningStreamToolStatus = streamingTools.some((tool) => tool.status === 'running');
  const currentRuntimeHasToolActivity = hasRuntimeGraphActivity(currentRuntimeRun);
  const hasRunningRuntimeToolStatus = hasRunningRuntimeTool(currentRuntimeRun);
  const shouldRenderStreaming = sending && (hasStreamText || hasStreamTools || hasStreamImages || hasStreamToolStatus);
  const hasAnyStreamContent = hasStreamText || hasStreamThinking || hasStreamTools || hasStreamImages || hasStreamToolStatus;
  const hasHistoryCompletionBlockingStream = hasStreamText
    || hasStreamImages
    || hasRunningStreamToolStatus
    || streamTools.length > 0;

  const isEmpty = messages.length === 0 && !sending;
  const showScrollToLatest = !isEmpty && !isAtBottom;
  const subagentCompletionInfos = useMemo(
    () => messages.map((message) => parseSubagentCompletionInfo(message)),
    [messages],
  );
  // Build an index of the *next* real user message after each position.
  // Gateway history may contain `role: 'user'` messages that are actually
  // tool-result wrappers (Anthropic API format).  These must NOT split
  // the run into multiple segments — only genuine user-authored messages
  // should act as run boundaries.
  const nextUserMessageIndexes = useMemo(() => {
    const indexes = new Array<number>(messages.length).fill(-1);
    let nextUserMessageIndex = -1;
    for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
      indexes[idx] = nextUserMessageIndex;
      if (isRealUserMessage(messages[idx]) && !subagentCompletionInfos[idx]) {
        nextUserMessageIndex = idx;
      }
    }
    return indexes;
  }, [messages, subagentCompletionInfos]);

  const questionDirectoryItems = useMemo<QuestionDirectoryItem[]>(() => {
    const items: QuestionDirectoryItem[] = [];
    let questionOrdinal = 0;
    messages.forEach((message, index) => {
      if (!isRealUserMessage(message) || subagentCompletionInfos[index]) return;
      questionOrdinal += 1;
      items.push({
        index,
        ordinal: questionOrdinal,
        title: buildQuestionDirectoryTitle(message, t('questionDirectory.fallback', { number: questionOrdinal })),
      });
    });
    return items;
  }, [messages, subagentCompletionInfos, t]);

  const questionDirectoryVisible = questionDirectoryOpenSessionKey === currentSessionKey && questionDirectoryItems.length > 1;

  const isRunTrigger = useCallback(
    (message: RawMessage, index: number) => isRealUserMessage(message) && !subagentCompletionInfos[index],
    [subagentCompletionInfos],
  );

  const {
    userRunCards,
    userRunCardsByTriggerIndex,
  } = useMemo(() => {
    // Indices of intermediate assistant process messages that are represented
    // in the ExecutionGraphCard (narration text and/or thinking). We suppress
    // them from the chat stream so they don't appear duplicated below the graph.
    const userRunCards = messages.flatMap((message, idx): UserRunCard[] => {
    if (!isRealUserMessage(message) || subagentCompletionInfos[idx]) return [];

    const runKey = message.id
      ? `msg-${message.id}`
      : `${currentSessionKey}:trigger-${idx}`;
    const nextUserIndex = nextUserMessageIndexes[idx];
    const segmentEnd = nextUserIndex === -1 ? messages.length : nextUserIndex;
    // Orphans from paginated history are folded into the graph only — they must
    // not participate in run lifecycle (hasFinalReply / replyIndex) or a prior
    // turn's assistant reply is mistaken for the current run's answer (#1048).
    const postTriggerMessages = getPostTriggerSegmentMessages(messages, idx, nextUserIndex);
    const segmentMessages = getRunSegmentMessages(messages, idx, nextUserIndex, isRunTrigger);
    const completionInfos = subagentCompletionInfos
      .slice(idx + 1, segmentEnd)
      .filter((value): value is NonNullable<typeof value> => value != null);
    // A run is considered "open" (still active) when it's the last segment
    // AND at least one of:
    //  - sending/pendingFinal/streaming data (normal streaming path)
    //  - segment has tool calls but no pure-text final reply yet (server-side
    //    tool execution — Gateway fires phase "end" per tool round which
    //    briefly clears sending, but the run is still in progress)
    const isLatestRunSegment = nextUserIndex === -1;
    const segmentRuntimeRun = getRuntimeRunForSegment(
      runtimeRuns,
      currentSessionKey,
      message,
      idx,
      activeRunId,
      isLatestRunSegment,
      lastUserMessageAt,
    );
    const runtimeHasToolActivity = hasRuntimeGraphActivity(segmentRuntimeRun);
    const runtimeHasRunningTool = hasRunningRuntimeTool(segmentRuntimeRun);
    const hasToolActivity = runtimeHasToolActivity || postTriggerMessages.some((m) =>
      m.role === 'assistant' && extractToolUse(m).length > 0,
    );
    const hasFinalReply = segmentHasFinalReply(postTriggerMessages);
    const pendingImageGeneration = isLatestRunSegment
      && (pendingImageGenerationLocal || isImageGenerationPending(postTriggerMessages, streamingTools, {
        runtimeRun: segmentRuntimeRun,
      }));
    const imageGenerationSettledInHistory = isLatestRunSegment
      && hasDeliveredImageGenerationResult(postTriggerMessages)
      && !pendingImageGeneration;
    const runStillExecutingTools = hasToolActivity && !hasFinalReply;
    const runtimeKeepsRunOpen = isLatestRunSegment
      && segmentRuntimeRun?.status === 'running'
      && !hasFinalReply
      && (runtimeHasToolActivity
        || runtimeHasRunningTool
        || (segmentRuntimeRun?.progressEntries?.length ?? 0) > 0);
    // runStillExecutingTools bridges the brief gap between tool rounds when
    // Gateway temporarily clears sending.  However, after an explicit abort
    // (which clears activeRunId), we must NOT keep the run "open" — so we
    // gate it on activeRunId being present. We also bail out as soon as a
    // terminal model error has been surfaced so the run doesn't appear active.
    // History may already contain the final answer while lifecycle flags are
    // still armed (missing Gateway terminal phase, blocked chat.send RPC, etc.).
    // Treat the run as closed for graph/input UI when the transcript is done
    // and no user-visible reply/tool stream is active. Require prior tool activity
    // so an early narration-only history snapshot does not collapse the graph
    // mid-chain. Thinking-only stale stream content should not keep image
    // generation runs open after history already contains the final media.
    const streamBlocksHistoryCompletion = hasHistoryCompletionBlockingStream && !imageGenerationSettledInHistory;
    const runCompletedInHistory = imageGenerationSettledInHistory || (hasFinalReply
      && !pendingImageGeneration
      && !streamBlocksHistoryCompletion
      && (hasToolActivity || !sending));
    const isLatestOpenRun = isLatestRunSegment
      && !runError
      && !runCompletedInHistory
      && (
        sending
        || pendingFinal
        || pendingImageGeneration
        || hasAnyStreamContent
        || runtimeKeepsRunOpen
        || (runStillExecutingTools && !!activeRunId)
      );

    const buildSteps = (omitLastStreamingMessageSegment: boolean): TaskStep[] => {
      let builtSteps = deriveTaskSteps({
        messages: segmentMessages,
        streamingMessage: isLatestOpenRun ? streamingMessage : null,
        streamingTools: isLatestOpenRun ? streamingTools : [],
        omitLastStreamingMessageSegment: isLatestOpenRun ? omitLastStreamingMessageSegment : false,
      });

      for (const completion of completionInfos) {
        const childMessages = childTranscripts[completion.sessionId];
        if (!childMessages || childMessages.length === 0) continue;
        const branchRootId = `subagent:${completion.sessionId}`;
        const childSteps = deriveTaskSteps({
          messages: childMessages,
          streamingMessage: null,
          streamingTools: [],
        }).map((step) => ({
          ...step,
          id: `${completion.sessionId}:${step.id}`,
          depth: step.depth + 1,
          parentId: branchRootId,
        }));

        builtSteps = [
          ...builtSteps,
          {
            id: branchRootId,
            label: `${completion.agentId} subagent`,
            status: 'completed',
            kind: 'system' as const,
            detail: completion.sessionKey,
            depth: 1,
            parentId: 'agent-run',
          },
          ...childSteps,
        ];
      }

      return builtSteps;
    };

    // Show the streaming response as a separate bubble (not inside the
    // execution graph) once tool activity has happened and the CURRENT stream
    // chunk carries no tool_use block.
    //
    // Runtime commentary arrives through progress entries. Once a newer
    // assistant delta follows the latest tool event, it is the final response
    // stream and can render incrementally without waiting for run.ended.
    const runtimeReachedTerminal = segmentRuntimeRun?.status !== undefined
      && segmentRuntimeRun.status !== 'running';
    const hasFreshFinalAssistantDelta = hasFinalAssistantDeltaAfterLatestTool(segmentRuntimeRun);
    const canPromoteStreamToBubble = !hasToolActivity
      ? (hasStreamText || hasStreamImages)
      : (hasFreshFinalAssistantDelta || pendingFinal || runtimeReachedTerminal);
    const rawStreamingReplyCandidate = isLatestOpenRun
      && canPromoteStreamToBubble
      && (hasStreamText || hasStreamImages)
      && streamTools.length === 0
      && !hasRunningStreamToolStatus
      && !runtimeHasRunningTool;

    let steps = segmentRuntimeRun && runtimeHasToolActivity
      ? sanitizeGraphSteps(deriveRuntimeTaskSteps(segmentRuntimeRun))
      : sanitizeGraphSteps(buildSteps(rawStreamingReplyCandidate));
    let streamingReplyText: string | null = null;
    if (rawStreamingReplyCandidate) {
      const trimmedReplyText = stripProcessMessagePrefix(streamText, getPrimaryMessageStepTexts(steps));
      const hasReplyText = trimmedReplyText.trim().length > 0
        && !isInternalAssistantReplyText(trimmedReplyText);
      if (hasReplyText || hasStreamImages) {
        streamingReplyText = hasReplyText ? trimmedReplyText : '';
      } else {
        steps = segmentRuntimeRun && runtimeHasToolActivity
          ? sanitizeGraphSteps(deriveRuntimeTaskSteps(segmentRuntimeRun))
          : sanitizeGraphSteps(buildSteps(false));
      }
    }

    const hasActiveStreamingReply = hasActiveStreamingReplyInRun(
      isLatestOpenRun,
      hasAnyStreamContent,
      streamingReplyText,
    );
    const replyIndexOffset = findReplyMessageIndex(postTriggerMessages, hasActiveStreamingReply);
    const replyIndex = replyIndexOffset === -1 ? null : idx + 1 + replyIndexOffset;

    const segmentAgentId = currentAgentId;
    const segmentAgentLabel = agents.find((agent) => agent.id === segmentAgentId)?.name || segmentAgentId;
    const segmentSessionLabel = sessionLabels[currentSessionKey] || currentSessionKey;
    const elapsedStartedAtMs = segmentRuntimeRun
      ? (getRunFirstEventMs(segmentRuntimeRun) ?? getSegmentStartMs(message, lastUserMessageAt))
      : getSegmentStartMs(message, lastUserMessageAt);
    const elapsedCompletedMs = isLatestOpenRun
      ? null
      : getCompletedRunElapsedMs(segmentRuntimeRun, elapsedStartedAtMs);
    const hasRuntimeProgressEntries = (segmentRuntimeRun?.progressEntries?.length ?? 0) > 0;

    if (steps.length === 0) {
      if (hasRuntimeProgressEntries) {
        const progressCardActive = isLatestOpenRun;
        const liveText = progressCardActive && streamingReplyText == null
          ? (() => {
            const trimmedLiveText = stripProcessMessagePrefix(streamText, []).trim();
            if (!trimmedLiveText || isInternalAssistantReplyText(trimmedLiveText)) return null;
            return trimmedLiveText;
          })()
          : null;
        return [{
          triggerIndex: idx,
          replyIndex,
          active: progressCardActive,
          agentLabel: segmentAgentLabel,
          sessionLabel: segmentSessionLabel,
          segmentEnd: nextUserIndex === -1 ? messages.length - 1 : nextUserIndex - 1,
          runtimeRun: segmentRuntimeRun,
          steps: [],
          messageStepTexts: [],
          streamingReplyText,
          liveText,
          elapsedStartedAtMs,
          elapsedCompletedMs: progressCardActive ? null : elapsedCompletedMs,
          suppressThinking: false,
        }];
      }
      if (isLatestOpenRun && streamingReplyText == null) {
        const historyReplyOffset = findReplyMessageIndex(postTriggerMessages, false);
        // History can contain the final answer while `sending` is still true
        // (blocked chat.send RPC, slow provider). Do not show an empty graph
        // that hides the reply behind "Thinking..." (#1048).
        if (historyReplyOffset >= 0 && !hasActiveStreamingReply) {
          return [];
        }
        if (!hasToolActivity && !hasStreamTools && !hasStreamToolStatus) {
          return [];
        }
        return [{
          triggerIndex: idx,
          replyIndex,
          active: true,
          agentLabel: segmentAgentLabel,
          sessionLabel: segmentSessionLabel,
          segmentEnd: nextUserIndex === -1 ? messages.length - 1 : nextUserIndex - 1,
          runtimeRun: segmentRuntimeRun,
          steps: [],
          messageStepTexts: [],
          streamingReplyText: null,
          liveText: null,
          elapsedStartedAtMs,
          elapsedCompletedMs: null,
          suppressThinking: false,
        }];
      }
      const cached = graphStepCache[runKey];
      if (!cached) return [];
      // The cache was captured during streaming and may contain stream-
      // generated message steps that include accumulated narration + reply
      // text.  Strip these out — historical message steps (from messages[])
      // will be properly recomputed on the next render with fresh data.
      const cleanedSteps = sanitizeGraphSteps(cached.steps.filter(
        (s) => !(s.kind === 'message' && s.id.startsWith('stream-message')),
      ));
      return [{
        triggerIndex: idx,
        replyIndex: cached.replyIndex,
        active: false,
        agentLabel: cached.agentLabel,
        sessionLabel: cached.sessionLabel,
        segmentEnd: nextUserIndex === -1 ? messages.length - 1 : nextUserIndex - 1,
        runtimeRun: segmentRuntimeRun,
        steps: cleanedSteps,
        messageStepTexts: getPrimaryMessageStepTexts(cleanedSteps),
        streamingReplyText: null,
        liveText: null,
        elapsedStartedAtMs: null,
        elapsedCompletedMs: segmentRuntimeRun
          ? elapsedCompletedMs
          : getRunDurationStepElapsedMs(cleanedSteps),
        suppressThinking: false,
      }];
    }

    const cardActive = isLatestOpenRun;

    // Mark intermediate assistant messages whose process output should be folded into
    // the ExecutionGraphCard. We fold the text regardless of whether the
    // message ALSO carries tool calls (mixed `text + toolCall` messages are
    // common — e.g. "waiting for the page to load…" followed by a `wait`
    // tool call). This keeps the in-progress run compact while the graph is
    // live. Once the run completes, keep the process visible in the chat
    // stream so the user can inspect the full execution after the fact.
    //
    // While the live stream carries the answer, fold assistant history into the
    // graph. If the reply is already in history but not streaming, keep it in
    // the chat stream (do not pass `isLatestOpenRun` alone — that folds all).
    // The graph should stay "active" (expanded, can show trailing thinking)
    // for the entire duration of the run — not just until a streaming reply
    // appears.  Tying active to streamingReplyText caused a flicker: a brief
    // active→false→true transition collapsed the graph via ExecutionGraphCard's
    // uncontrolled path before the controlled `expanded` override could kick in.

    // Suppress the trailing "Thinking..." indicator only when the live stream is
    // currently rendered AS a streaming step inside this card's graph. In
    // that case the streaming step itself is the activity signal, and the
    // separate trailing indicator would be redundant.
    //   - streamingReplyText != null: stream is promoted to a bubble → graph
    //     has no live step of its own → DO show the trailing indicator so the
    //     user still sees progress in the graph (indicator rendered above the
    //     bubble).
    //   - no stream content at all (the gap between tool rounds): graph also
    //     has no live step → DO show the indicator — this is the very case
    //     the indicator exists for.
    //   - tool execution is visible in the graph: still show the trailing
    //     indicator as a separate liveness signal so the user sees both
    //     "tool is running" and "agent is still thinking".
    const streamVisiblyActiveInGraph = hasStreamText
      || hasStreamThinking
      || hasStreamImages;
    const streamIsInGraph =
      isLatestOpenRun && streamingReplyText == null && streamVisiblyActiveInGraph;
    const suppressThinking = streamIsInGraph;
    const liveText = isLatestOpenRun && streamingReplyText == null
      ? (() => {
        const trimmedLiveText = stripProcessMessagePrefix(streamText, getPrimaryMessageStepTexts(steps)).trim();
        if (!trimmedLiveText || isInternalAssistantReplyText(trimmedLiveText)) return null;
        return trimmedLiveText;
      })()
      : null;

    return [{
      triggerIndex: idx,
      replyIndex,
      active: cardActive,
      agentLabel: segmentAgentLabel,
      sessionLabel: segmentSessionLabel,
      segmentEnd: nextUserIndex === -1 ? messages.length - 1 : nextUserIndex - 1,
      runtimeRun: segmentRuntimeRun,
      steps,
      messageStepTexts: getPrimaryMessageStepTexts(steps),
      streamingReplyText,
      liveText,
      elapsedStartedAtMs,
      elapsedCompletedMs: cardActive
        ? null
        : segmentRuntimeRun
          ? elapsedCompletedMs
          : getRunDurationStepElapsedMs(steps),
      suppressThinking,
    }];
    });
    const userRunCardsByTriggerIndex = new Map<number, UserRunCard[]>();
    for (const card of userRunCards) {
      const existing = userRunCardsByTriggerIndex.get(card.triggerIndex);
      if (existing) {
        existing.push(card);
      } else {
        userRunCardsByTriggerIndex.set(card.triggerIndex, [card]);
      }
    }
    return {
      userRunCards,
      userRunCardsByTriggerIndex,
    };
  }, [messages, subagentCompletionInfos, currentSessionKey, streamingMessage, streamingTools, pendingFinal, sending, pendingImageGenerationLocal, hasAnyStreamContent, hasStreamText, hasStreamThinking, hasStreamImages, hasStreamTools, hasStreamToolStatus, streamText, streamTools.length, hasRunningStreamToolStatus, hasHistoryCompletionBlockingStream, childTranscripts, currentAgentId, agents, sessionLabels, graphStepCache, runError, isRunTrigger, nextUserMessageIndexes, activeRunId, runtimeRuns, lastUserMessageAt]);

  const reasoningPanelsByTriggerIndex = useMemo(() => {
    const panels = new Map<number, ReturnType<typeof projectReasoningPanels>[number]>();
    messages.forEach((message, triggerIndex) => {
      if (!isRunTrigger(message, triggerIndex)) return;
      const nextUserIndex = nextUserMessageIndexes[triggerIndex];
      const segmentEnd = nextUserIndex === -1 ? messages.length - 1 : nextUserIndex - 1;
      const runCard = userRunCardsByTriggerIndex.get(triggerIndex)?.[0];
      const activeTurn = runCard?.active ?? (nextUserIndex === -1 && sending);
      const panel = projectReasoningPanels({
        reasoningLevel: currentReasoningLevel,
        historyMessages: messages.slice(triggerIndex + 1, segmentEnd + 1),
        historyStartIndex: triggerIndex + 1,
        runtimeRun: runCard?.runtimeRun ?? (activeTurn ? currentRuntimeRun : null),
        streamMessage: activeTurn ? effectiveStreamMsg : null,
        activeTurn,
        turnId: message.id || `${currentSessionKey}:trigger-${triggerIndex}`,
      })[0];
      if (panel) panels.set(triggerIndex, panel);
    });
    return panels;
  }, [
    currentReasoningLevel,
    currentRuntimeRun,
    currentSessionKey,
    effectiveStreamMsg,
    isRunTrigger,
    messages,
    nextUserMessageIndexes,
    sending,
    userRunCardsByTriggerIndex,
  ]);
  let latestRunSegmentCompletion = { hasFinalReply: false, hasToolActivity: false };
  let pendingImageGeneration = false;
  let pendingVideoGeneration = false;
  let imageGenerationSettledInHistory = false;
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    if (!isRealUserMessage(messages[idx]) || subagentCompletionInfos[idx]) continue;
    const nextUserIndex = nextUserMessageIndexes[idx];
    const postTrigger = getPostTriggerSegmentMessages(messages, idx, nextUserIndex);
    latestRunSegmentCompletion = {
      hasFinalReply: segmentHasFinalReply(postTrigger),
      hasToolActivity: postTrigger.some((m) =>
        m.role === 'assistant' && extractToolUse(m).length > 0,
      ),
    };
    pendingImageGeneration = (nextUserIndex === -1 && pendingImageGenerationLocal)
      || isImageGenerationPending(
        postTrigger,
        nextUserIndex === -1 ? streamingTools : [],
        { runtimeRun: currentRuntimeRun },
      );
    pendingVideoGeneration = nextUserIndex === -1 && pendingVideoGenerationLocal;
    imageGenerationSettledInHistory = nextUserIndex === -1
      && hasDeliveredImageGenerationResult(postTrigger)
      && !pendingImageGeneration;
    break;
  }
  const streamBlocksHistoryCompletion = hasHistoryCompletionBlockingStream && !imageGenerationSettledInHistory;
  const runSettledInHistory = imageGenerationSettledInHistory || (latestRunSegmentCompletion.hasFinalReply
    && !pendingImageGeneration
    && !pendingVideoGeneration
    && !streamBlocksHistoryCompletion
    && (
      latestRunSegmentCompletion.hasToolActivity
      || currentRuntimeHasToolActivity
      || !sending
    ));
  const shouldClearStoreLifecycleFromHistory = sending
    && runSettledInHistory
    && (
      imageGenerationSettledInHistory
      || (!hasRunningRuntimeToolStatus && !hasRunningStreamToolStatus)
    );
  useEffect(() => {
    if (!shouldClearStoreLifecycleFromHistory) return;
    useChatStore.setState({
      sending: false,
      activeRunId: null,
      pendingFinal: false,
      lastUserMessageAt: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingToolImages: [],
      runError: null,
    });
  }, [shouldClearStoreLifecycleFromHistory]);

  const replyTextOverrides = useMemo(() => {
    const map = new Map<number, string>();
    for (const card of userRunCards) {
      if (card.replyIndex == null) continue;
      const replyMessage = messages[card.replyIndex];
      if (!replyMessage || replyMessage.role !== 'assistant') continue;
      const fullReplyText = extractText(replyMessage);
      const trimmedReplyText = stripProcessMessagePrefix(fullReplyText, card.messageStepTexts);
      if (trimmedReplyText !== fullReplyText) {
        map.set(card.replyIndex, trimmedReplyText);
      }
    }
    return map;
  }, [userRunCards, messages]);
  const streamingReplyText = userRunCards.find((card) => card.streamingReplyText != null)?.streamingReplyText ?? null;

  // Derive the set of run keys that should be auto-collapsed (run finished
  // streaming or has a reply override) during render instead of in an effect,
  // so we don't violate react-hooks/set-state-in-effect. Explicit user toggles
  // still win via `graphExpandedOverrides` and are merged in at the call site.
  // Pre-compute generated files per run (memoised so the cards and the
  // ArtifactPanel can both read them without re-parsing tool calls every
  // render).
  const filesByRun = useMemo(() => {
    const map = new Map<number, GeneratedFile[]>();
    for (const card of userRunCards) {
      const userTurnOrdinal = messages
        .slice(0, card.triggerIndex + 1)
        .filter((msg) => msg.role === 'user' && (!Array.isArray(msg.content) || !(msg.content as Array<{ type?: string }>).every((b) => b.type === 'tool_result' || b.type === 'toolResult')))
        .length;
      const runKey = buildBaselineRunKey(currentSessionKey, userTurnOrdinal);
      const raw = extractGeneratedFiles(
        messages,
        card.triggerIndex,
        card.segmentEnd,
        runKey ? (filePath) => getBaseline(runKey, filePath) : undefined,
      );
      map.set(card.triggerIndex, raw.filter(generatedFileHasDiffPayload));
    }
    return map;
  }, [currentSessionKey, userRunCards, messages]);
  const allGeneratedFiles = useMemo(() => {
    const all: GeneratedFile[] = [];
    for (const files of filesByRun.values()) all.push(...files);
    return all;
  }, [filesByRun]);

  const runSurfaceStates = useMemo(() => {
    const map = new Map<number, RunSurfaceState>();
    for (const card of userRunCards) {
      const generatedFiles = filesByRun.get(card.triggerIndex) ?? [];
      const segmentMessages = messages.slice(card.triggerIndex + 1, card.segmentEnd + 1);
      const hasCompositeResultReply = segmentMessages.some(isCompositeResultReplyMessage);
      const hasUserFacingActivity = runCardHasUserFacingActivity(card, generatedFiles);
      const hasProblem = runCardHasUserFacingProblem(card, generatedFiles);
      const hasElapsedSummary = getRunCardElapsedMs(card, runtimeNowMs) != null;
      const hasExecutionGraphDetails = card.steps.length > 0;
      const hasVisibleProcessActivity = card.steps.length > 0 || (card.runtimeRun?.progressEntries?.length ?? 0) > 0;
      const hasToolSteps = card.steps.some((step) => step.kind === 'tool');
      const hasNarrationSteps = card.steps.some((step) => step.kind === 'message');
      const hasRuntimeProgressEntries = (card.runtimeRun?.progressEntries?.length ?? 0) > 0;
      const hasNativeTaskFlow = getTaskFlowCompactProgress(card.steps) != null
        || (card.runtimeRun?.tasks?.length ?? 0) > 0;
      const shouldShowTranscript = shouldUseRunProgressTranscript(
        card.steps,
        generatedFiles.length,
        card.runtimeRun?.progressEntries,
      ) && (
        !!card.liveText
        || card.streamingReplyText != null
        || hasNarrationSteps
        || hasRuntimeProgressEntries
        || (!card.active && hasToolSteps && !card.runtimeRun)
      );
      const hasTextFirstSurface = shouldShowTranscript || card.streamingReplyText != null;
      const shouldExposeActiveGenericProcess = card.active && hasVisibleProcessActivity && !shouldShowTranscript;
      const hasCanonicalProgressTranscript = hasRuntimeProgressEntries || !!card.liveText;
      const shouldHideExecutionGraphBehindTranscript = shouldShowTranscript
        && hasCanonicalProgressTranscript
        && !hasNativeTaskFlow
        && !devModeUnlocked
        && !hasProblem;
      const shouldRenderExecutionGraph = hasExecutionGraphDetails
        && !shouldHideExecutionGraphBehindTranscript
        && (
          devModeUnlocked
          || hasProblem
          || hasTextFirstSurface
          || hasUserFacingActivity
          || shouldExposeActiveGenericProcess
        );
      const shouldShowRunStatus = shouldRenderExecutionGraph
        || (hasUserFacingActivity || hasTextFirstSurface || shouldExposeActiveGenericProcess)
        && (
          card.active
          || hasProblem
          || (!hasCompositeResultReply && (generatedFiles.length > 0 || hasElapsedSummary || hasVisibleProcessActivity))
        );
      map.set(card.triggerIndex, {
        shouldShowTranscript,
        shouldShowRunStatus,
        shouldRenderExecutionGraph,
      });
    }
    return map;
  }, [devModeUnlocked, filesByRun, messages, runtimeNowMs, userRunCards]);

  const hasVisibleActiveExecutionGraph = userRunCards.some((card) => (
    card.active && Boolean(runSurfaceStates.get(card.triggerIndex)?.shouldRenderExecutionGraph)
  ));
  const hasVisibleActiveRunTranscriptLiveText = userRunCards.some((card) => (
    card.active
    && !!card.liveText
    && Boolean(runSurfaceStates.get(card.triggerIndex)?.shouldShowTranscript)
  ));
  const hasVisibleActiveRunSurface = userRunCards.some((card) => {
    if (!card.active) return false;
    const surface = runSurfaceStates.get(card.triggerIndex);
    return Boolean(surface?.shouldRenderExecutionGraph || surface?.shouldShowTranscript || surface?.shouldShowRunStatus);
  });

  useEffect(() => {
    if (!hasVisibleActiveRunSurface) return;
    const tick = () => {
      setRuntimeNowMs(Date.now());
    };
    const immediateTimer = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(immediateTimer);
      window.clearInterval(timer);
    };
  }, [hasVisibleActiveRunSurface]);

  const graphFoldedNarrationIndices = useMemo(() => {
    const indices = new Set<number>();
    for (const card of userRunCards) {
      if (!card.active) continue;
      if (!runSurfaceStates.get(card.triggerIndex)?.shouldRenderExecutionGraph) continue;
      for (let index = card.triggerIndex + 1; index <= card.segmentEnd; index += 1) {
        if (index === card.replyIndex) continue;
        const candidate = messages[index];
        if (!candidate || candidate.role !== 'assistant') continue;
        const hasNarrationText = extractText(candidate).trim().length > 0;
        const hasThinking = !!extractThinking(candidate);
        if (!hasNarrationText && !hasThinking) continue;
        indices.add(index);
      }
    }
    return indices;
  }, [messages, runSurfaceStates, userRunCards]);

  const graphFoldedProcessMessageIndices = useMemo(() => {
    const indices = new Set<number>();
    for (const card of userRunCards) {
      if (!runSurfaceStates.get(card.triggerIndex)?.shouldRenderExecutionGraph) continue;
      if (!card.active && card.streamingReplyText == null) continue;
      for (let index = card.triggerIndex + 1; index <= card.segmentEnd; index += 1) {
        indices.add(index);
      }
    }
    return indices;
  }, [runSurfaceStates, userRunCards]);
  const inputRunActive = sending || pendingImageGeneration || pendingVideoGeneration || (hasVisibleActiveExecutionGraph && !runSettledInHistory);
  const shouldShowThinkingActivity = inputRunActive
    && hasStreamThinking
    && !hasStreamText
    && !hasStreamTools
    && !hasStreamImages
    && !hasStreamToolStatus
    && !hasVisibleActiveExecutionGraph;

  const transcriptRunKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const card of userRunCards) {
      const generatedFiles = filesByRun.get(card.triggerIndex) ?? [];
      if (!shouldUseRunProgressTranscript(card.steps, generatedFiles.length, card.runtimeRun?.progressEntries)) continue;
      keys.add(`${currentSessionKey}:${card.triggerIndex}`);
    }
    return keys;
  }, [currentSessionKey, filesByRun, userRunCards]);

  const transcriptFoldedMessageIndices = useMemo(() => {
    const indices = new Set<number>();
    for (const card of userRunCards) {
      if (!transcriptRunKeys.has(`${currentSessionKey}:${card.triggerIndex}`)) continue;
      for (let index = card.triggerIndex + 1; index <= card.segmentEnd; index += 1) {
        if (index === card.replyIndex) continue;
        if (messages[index]?.role !== 'assistant') continue;
        indices.add(index);
      }
    }
    return indices;
  }, [currentSessionKey, messages, transcriptRunKeys, userRunCards]);

  const refreshSignal = useMemo(() => {
    if (sending) return undefined;
    return lastUserMessageAt ?? 0;
  }, [sending, lastUserMessageAt]);

  useEffect(() => {
    if (userRunCards.length === 0) return;
    const current = graphStepCacheStore.get(currentSessionKey) ?? {};
    let changed = false;
    const next = { ...current };
    for (const card of userRunCards) {
      if (card.steps.length === 0) continue;
      const triggerMsg = messages[card.triggerIndex];
      const runKey = triggerMsg?.id
        ? `msg-${triggerMsg.id}`
        : `${currentSessionKey}:trigger-${card.triggerIndex}`;
      const existing = current[runKey];
      const sameSteps = !!existing
        && existing.steps.length === card.steps.length
        && existing.steps.every((step, index) => {
          const nextStep = card.steps[index];
          return nextStep
            && step.id === nextStep.id
            && step.label === nextStep.label
            && step.status === nextStep.status
            && step.kind === nextStep.kind
            && step.detail === nextStep.detail
            && step.depth === nextStep.depth
            && step.parentId === nextStep.parentId;
        });
      if (
        sameSteps
        && existing?.agentLabel === card.agentLabel
        && existing?.sessionLabel === card.sessionLabel
        && existing?.segmentEnd === card.segmentEnd
        && existing?.replyIndex === card.replyIndex
        && existing?.triggerIndex === card.triggerIndex
      ) {
        continue;
      }
      next[runKey] = {
        steps: card.steps,
        agentLabel: card.agentLabel,
        sessionLabel: card.sessionLabel,
        segmentEnd: card.segmentEnd,
        replyIndex: card.replyIndex,
        triggerIndex: card.triggerIndex,
      };
      changed = true;
    }
    if (changed) {
      setBoundedSessionEntry(graphStepCacheStore, currentSessionKey, next);
    }
  }, [userRunCards, messages, currentSessionKey]);

  const platform = window.electron?.platform;
  const isMac = platform === 'darwin';
  const isWindows = platform === 'win32';

  return (
    <div
      ref={splitContainerRef}
      data-testid="chat-page"
      className={cn(
        'relative flex min-h-0 -m-6 overflow-hidden transition-colors duration-500',
        'bg-background',
        // Stack above MainLayout's mac-main-drag-region (z-10) so the right-hand
        // artifact/preview pane stays clickable; window drag is handled by the
        // sidebar + chat-toolbar drag strips instead.
        isMac && 'z-20 rounded-tl-2xl shadow-[inset_1px_1px_0_hsl(var(--border)/0.55)]',
        isWindows && 'rounded-tl-2xl',
      )}
      style={{ height: isMac ? '100vh' : 'calc(100vh - 2.5rem)' }}
    >
      {/* Left column: chat */}
      <div className="flex min-w-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="relative flex shrink-0 items-center justify-end px-4 py-2">
        <div data-testid="chat-toolbar-drag-region" className="drag-region absolute inset-0 z-0" aria-hidden="true" />
        <div data-testid="chat-toolbar-actions" className="no-drag relative z-10">
          <ChatToolbar
            questionDirectoryOpen={questionDirectoryVisible}
            questionDirectoryCount={questionDirectoryItems.length}
            onToggleQuestionDirectory={() =>
              setQuestionDirectoryOpenSessionKey((openSessionKey) =>
                openSessionKey === currentSessionKey ? null : currentSessionKey,
              )
            }
          />
        </div>
      </div>

      {/* Messages Area */}
      <div className="relative min-h-0 flex-1 overflow-hidden px-4 py-4">
        <div className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col gap-4 lg:flex-row lg:items-stretch">
          <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="chat-scroll-container">
            <div
              ref={contentRef}
              className={cn(
                "mx-auto space-y-4",
                isEmpty ? "w-full max-w-3xl" : "max-w-4xl",
              )}
            >
              {isEmpty ? (
                <WelcomeScreen />
              ) : (
                <>
                  {hasMoreHistory && (
                    <div className="flex justify-center pt-2">
                      <button
                        type="button"
                        onClick={() => void loadMoreHistory()}
                        disabled={loadingMoreHistory}
                        className="inline-flex items-center gap-2 rounded-full border border-border bg-background/80 px-3 py-1.5 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                        data-testid="chat-load-more-history"
                      >
                        {loadingMoreHistory && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {loadingMoreHistory ? t('loadingMoreHistory') : t('loadMoreHistory')}
                      </button>
                    </div>
                  )}
                  {messages.map((msg, idx) => {
                    if (isInternalMessage(msg) && !hasUserFacingMediaAttachments(msg)) return null;
                    const isTranscriptFolded = transcriptFoldedMessageIndices.has(idx);
                    const isFoldedNarration = graphFoldedNarrationIndices.has(idx) || isTranscriptFolded;
                    if (isFoldedNarration && !hasUserFacingMediaAttachments(msg)) return null;
                    const suppressToolCards = graphFoldedProcessMessageIndices.has(idx) || isTranscriptFolded;
                    const isToolOnlyAssistant = normalizeMessageRole(msg.role) === 'assistant'
                      && extractToolUse(msg).length > 0
                      && extractText(msg).trim().length === 0
                      && !extractThinking(msg);
                    if (suppressToolCards && isToolOnlyAssistant && !(msg._attachedFiles?.length)) {
                      return null;
                    }
                    const runCardsForMessage = userRunCardsByTriggerIndex.get(idx) ?? [];
                    const reasoningPanel = reasoningPanelsByTriggerIndex.get(idx);
                    const hasVisibleRunSurface = Boolean(reasoningPanel) || runCardsForMessage.some((card) => {
                      const generatedFiles = filesByRun.get(card.triggerIndex) ?? [];
                      const segmentMessages = messages.slice(card.triggerIndex + 1, card.segmentEnd + 1);
                      const hasCompositeResultReply = segmentMessages.some(isCompositeResultReplyMessage);
                      const surfaceState = runSurfaceStates.get(card.triggerIndex) ?? defaultRunSurfaceState();
                      return surfaceState.shouldShowTranscript
                        || surfaceState.shouldRenderExecutionGraph
                        || (generatedFiles.length > 0 && !hasCompositeResultReply);
                    });
                    if (!hasVisibleRunSurface && !hasRenderableChatMessageContent(msg, {
                      suppressAssistantText: isFoldedNarration,
                      suppressToolCards,
                    })) {
                      return null;
                    }
                    return (
                    <div
                      key={msg.id || `msg-${idx}`}
                      className="space-y-3"
                      id={`chat-message-${idx}`}
                      data-testid={`chat-message-${idx}`}
                    >
                      <ChatMessage
                        message={msg}
                        textOverride={replyTextOverrides.get(idx)}
                        assistantAvatarSrc={currentAgentAvatarSrc}
                        suppressAssistantText={isFoldedNarration}
                        suppressToolCards={suppressToolCards}
                        suppressProcessAttachments={suppressToolCards}
                        onOpenFile={handleOpenAttachedFile}
                        onUseImageAsReference={handleUseImageAsReference}
                      />
                      {reasoningPanel && (
                        <ReasoningPanel
                          text={reasoningPanel.text}
                          live={reasoningPanel.displayMode === 'live'}
                        />
                      )}
                      {runCardsForMessage.map((card) => {
                          const triggerMsg = messages[card.triggerIndex];
                          const runKey = triggerMsg?.id
                            ? `msg-${triggerMsg.id}`
                            : `${currentSessionKey}:trigger-${card.triggerIndex}`;
                          const userOverride = graphExpandedOverrides[runKey];
                          const generatedFiles = filesByRun.get(card.triggerIndex) ?? [];
                          const segmentMessages = messages.slice(card.triggerIndex + 1, card.segmentEnd + 1);
                          const hasCompositeResultReply = segmentMessages.some(isCompositeResultReplyMessage);
                          const compactStatus = getRunCompactStatus(card);
                          // The graph stays secondary by default, but it still
                          // needs to be inspectable in normal chat mode.
                          const detailsEnabled = true;
                          const surfaceState = runSurfaceStates.get(card.triggerIndex) ?? defaultRunSurfaceState();
                          const { shouldShowTranscript, shouldRenderExecutionGraph } = surfaceState;
                          if (!shouldShowTranscript && !shouldRenderExecutionGraph && generatedFiles.length === 0) return null;
                          // Keep the run surface compact by default. User toggles
                          // persist across history refreshes through this controlled
                          // prop; developer diagnostics remain one click away.
                          const expanded = detailsEnabled ? (userOverride ?? false) : false;
                          const compactSummary = buildRunCompactSummary(card, generatedFiles, t, runtimeNowMs);
                          const transcriptSummary = buildRunTranscriptSummary(card, runtimeNowMs);
                          return (
                            <div key={`run-${currentSessionKey}:${card.triggerIndex}`} className="space-y-3">
                              {shouldShowTranscript && (
                                <RunProgressCard
                                  summary={transcriptSummary}
                                  status={compactStatus}
                                  steps={card.steps}
                                  progressEntries={card.runtimeRun?.progressEntries}
                                  liveText={card.liveText}
                                />
                              )}
                              {shouldRenderExecutionGraph && (
                                <ExecutionGraphCard
                                  key={`graph-${currentSessionKey}:${card.triggerIndex}`}
                                  agentLabel={card.agentLabel}
                                  steps={card.steps}
                                  active={card.active}
                                  compactSummary={compactSummary}
                                  compactStatus={compactStatus}
                                  detailsEnabled={detailsEnabled}
                                  suppressThinking={card.suppressThinking}
                                  expanded={expanded}
                                  onExpandedChange={(next) =>
                                    setGraphExpandedOverrides((prev) => ({ ...prev, [runKey]: next }))
                                  }
                                />
                              )}
                              {generatedFiles.length > 0 && !hasCompositeResultReply && (
                                <GeneratedFilesPanel
                                  files={generatedFiles}
                                  onOpen={(file) => {
                                    const target = generatedFileToTarget(file);
                                    if (isHtmlPreviewExt(file.ext)) {
                                      openPreview(target);
                                      return;
                                    }
                                    openChanges(target);
                                  }}
                                />
                              )}
                            </div>
                          );
                        })}
                    </div>
                    );
                  })}

                  {/* Streaming message — render when reply text is separated from graph,
                      OR when there's streaming content without an active graph */}
                  {shouldRenderStreaming && (
                    !hasVisibleActiveRunTranscriptLiveText
                    && (
                      streamingReplyText != null
                      || !hasVisibleActiveExecutionGraph
                      || (hasStreamText && streamTools.length === 0 && !hasRunningStreamToolStatus && !hasRunningRuntimeToolStatus)
                    )
                  ) && (
                    <ChatMessage
                        suppressToolCards={hasVisibleActiveExecutionGraph || graphFoldedProcessMessageIndices.size > 0}
                        assistantAvatarSrc={currentAgentAvatarSrc}
                      message={(() => {
                        const base = effectiveStreamMsg
                          ? {
                              ...(effectiveStreamMsg as unknown as Record<string, unknown>),
                              role: (typeof effectiveStreamMsg.role === 'string' ? effectiveStreamMsg.role : 'assistant') as RawMessage['role'],
                              content: effectiveStreamMsg.content ?? streamText,
                              timestamp: effectiveStreamMsg.timestamp ?? streamingTimestamp,
                            }
                          : {
                              role: 'assistant' as const,
                              content: streamText,
                              timestamp: streamingTimestamp,
                            };
                        // When the reply renders as a separate bubble, strip
                        // thinking blocks from the message — they belong to
                        // the execution phase and are already omitted from
                        // the graph via omitLastStreamingMessageSegment.
                        if (streamingReplyText != null && Array.isArray(base.content)) {
                          return {
                            ...base,
                            content: (base.content as Array<{ type?: string }>).filter(
                              (block) => block.type !== 'thinking',
                            ),
                          } as RawMessage;
                        }
                        return base as RawMessage;
                      })()}
                      textOverride={streamingReplyText ?? undefined}
                      isStreaming
                      streamingTools={streamingReplyText != null || hasVisibleActiveExecutionGraph ? [] : streamingTools}
                      onOpenFile={handleOpenAttachedFile}
                      onUseImageAsReference={handleUseImageAsReference}
                    />
                  )}

                  {shouldShowThinkingActivity && (
                    <ActivityIndicator phase="thinking" />
                  )}

                  {/* Activity indicator: waiting for next AI turn after tool execution */}
                  {inputRunActive && pendingFinal && !shouldRenderStreaming && !hasVisibleActiveExecutionGraph && (
                    <ActivityIndicator phase="tool_processing" />
                  )}

                  {pendingImageGeneration && !hasVisibleActiveExecutionGraph && (
                    <ImageGeneratingIndicator />
                  )}

                  {pendingVideoGeneration && !hasVisibleActiveExecutionGraph && (
                    <VideoGeneratingIndicator />
                  )}

                  {/* Typing indicator when sending but no stream content yet */}
                  {inputRunActive && !pendingFinal && !hasAnyStreamContent && !hasVisibleActiveExecutionGraph && !pendingImageGeneration && !pendingVideoGeneration && (
                    <TypingIndicator />
                  )}
                </>
              )}
            </div>
          </div>
          {showScrollToLatest && (
            <button
              type="button"
              onClick={() => void scrollToBottom({ animation: 'smooth', ignoreEscapes: true })}
              className="absolute bottom-4 right-4 z-20 inline-flex items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-medium text-foreground shadow-lg shadow-black/10 backdrop-blur transition-colors hover:bg-black/5 dark:hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:shadow-black/30"
              aria-label={t('scrollToLatest')}
              title={t('scrollToLatest')}
              data-testid="chat-scroll-to-latest"
            >
              <ArrowDownToLine className="h-3.5 w-3.5" />
              <span>{t('scrollToLatest')}</span>
            </button>
          )}

          {!isEmpty && questionDirectoryVisible && (
            <QuestionDirectory items={questionDirectoryItems} />
          )}

        </div>
      </div>

      {/* Run error callout */}
      {runError && (
        <div className="px-4 pt-2" data-testid="chat-run-error">
          <div className="max-w-4xl mx-auto rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3">
            <p className="text-sm font-medium text-destructive flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              {t('runError.title')}
            </p>
            <p className="mt-1 text-sm text-destructive/90 break-words">
              {runError}
            </p>
            <button
              type="button"
              onClick={() => void retryLastRun()}
              data-testid="chat-run-retry"
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-destructive hover:underline"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t('runError.retry')}
            </button>
          </div>
        </div>
      )}

      {/* Error bar */}
      {error && (
        <div className="px-4 py-2 bg-destructive/10 border-t border-destructive/20">
          <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
            <p className="text-sm text-destructive flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              {error}
            </p>
            <div className="flex shrink-0 items-center gap-3">
              <button
                type="button"
                onClick={() => void retryLastRun()}
                data-testid="chat-error-retry"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive hover:underline"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t('runError.retry')}
              </button>
              <button
                type="button"
                onClick={clearError}
                className="text-xs text-destructive/60 hover:text-destructive underline"
              >
                {t('common:actions.dismiss')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input Area */}
      <ChatInput
        onSend={sendMessage}
        onStop={abortRun}
        disabled={!isGatewayRunning}
        sending={inputRunActive}
        imageEditReference={imageEditReference}
        onClearImageEditReference={() => setImageEditReference(null)}
      />
      </div>

      {/* Right column: artifact / file preview panel (WorkBuddy-style) */}
      {panelOpen && (
        <>
          <Suspense fallback={null}>
            <PanelResizeDividerLazy containerRef={splitContainerRef} />
          </Suspense>
          <aside
            data-testid="artifact-panel-aside"
            className={cn(
              'relative z-20 hidden shrink-0 border-l border-black/5 dark:border-white/10 lg:flex lg:flex-col',
              isMac && 'no-drag',
            )}
            style={{ width: `${panelWidthPct}%` }}
          >
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <LoadingSpinner size="md" />
                </div>
              }
            >
              <ArtifactPanelLazy
                files={allGeneratedFiles}
                agent={currentAgent}
                workspace={currentWorkspace}
                runStartedAt={lastUserMessageAt ?? null}
                refreshSignal={refreshSignal}
              />
            </Suspense>
          </aside>
        </>
      )}

      {/* Transparent loading overlay */}
      {minLoading && !sending && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/20 backdrop-blur-[1px] rounded-xl pointer-events-auto">
          <div className="bg-background shadow-lg rounded-full p-2.5 border border-border">
            <LoadingSpinner size="md" />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Question Directory ─────────────────────────────────────────

function QuestionDirectory({ items }: { items: QuestionDirectoryItem[] }) {
  const { t } = useTranslation('chat');
  const scrollRef = useRef<HTMLElement | null>(null);
  const visibleItems = items.slice(0, QUESTION_DIRECTORY_RENDER_LIMIT);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }, [visibleItems.length]);

  const handleJumpToMessage = (index: number) => {
    document.getElementById(`chat-message-${index}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  };

  return (
    <aside
      data-testid="chat-question-directory"
      className="w-full shrink-0 lg:w-64 xl:w-72"
      aria-label={t('questionDirectory.title')}
    >
      <div className="sticky top-2 max-h-full overflow-hidden rounded-2xl border border-black/5 bg-black/[0.02] p-3 shadow-sm dark:border-white/10 dark:bg-white/[0.03]">
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('questionDirectory.title')}
          </h2>
          <span className="rounded-full bg-black/5 px-2 py-0.5 text-2xs font-medium text-muted-foreground dark:bg-white/10">
            {items.length}
          </span>
        </div>
        <nav ref={scrollRef} className="max-h-[calc(100vh-13rem)] space-y-1 overflow-y-auto pr-1">
          {visibleItems.map((item) => (
            <button
              key={item.index}
              type="button"
              data-testid={`chat-question-directory-item-${item.index}`}
              onClick={() => handleJumpToMessage(item.index)}
              className={cn(
                'group flex w-full items-start gap-2 rounded-xl px-2 py-2 text-left transition-colors',
                'text-foreground/70 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10',
              )}
              title={item.title}
            >
              <span className="line-clamp-2 min-w-0 text-xs leading-5">
                {item.title}
              </span>
            </button>
          ))}
          {hiddenCount > 0 && (
            <div className="px-2 py-2 text-xs leading-5 text-muted-foreground">
              {t('questionDirectory.moreHint', { count: hiddenCount })}
            </div>
          )}
        </nav>
      </div>
    </aside>
  );
}

// ── Welcome Screen ──────────────────────────────────────────────

function WelcomeScreen() {
  const { t } = useTranslation('chat');
  const quickActions = [
    { key: 'askQuestions', label: t('welcome.askQuestions') },
    { key: 'creativeTasks', label: t('welcome.creativeTasks') },
    { key: 'brainstorming', label: t('welcome.brainstorming') },
  ];

  return (
    <div className="flex flex-col items-center justify-center text-center h-[60vh]">
      <h1 className="text-4xl md:text-5xl font-serif text-foreground/80 mb-8 font-normal tracking-tight">
        {t('welcome.subtitle')}
      </h1>

      <div className="flex flex-wrap items-center justify-center gap-2.5 max-w-lg w-full">
        {quickActions.map(({ key, label }) => (
          <button 
            key={key}
            className="px-4 py-1.5 rounded-full border border-black/10 dark:border-white/10 text-meta font-medium text-foreground/70 hover:bg-black/5 dark:hover:bg-white/5 transition-colors bg-black/[0.02]"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Typing Indicator ────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex gap-3" data-testid="chat-typing-indicator">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full mt-1 bg-black/5 dark:bg-white/5 text-foreground">
        <img src={DEFAULT_AGENT_AVATAR_SRC} alt="" className="h-full w-full rounded-full object-cover" />
      </div>
      <div className="bg-black/5 dark:bg-white/5 text-foreground rounded-2xl px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span>我先看下这条请求。</span>
        </div>
      </div>
    </div>
  );
}

// ── Activity Indicator (shown between tool cycles / thinking-only stream) ─────────────

function ActivityIndicator({ phase }: { phase: 'tool_processing' | 'thinking' }) {
  const label = phase === 'thinking' ? '正在思考…' : '正在整理执行结果…';
  return (
    <div className="flex gap-3" data-testid="chat-activity-indicator">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full mt-1 bg-black/5 dark:bg-white/5 text-foreground">
        <img src={DEFAULT_AGENT_AVATAR_SRC} alt="" className="h-full w-full rounded-full object-cover" />
      </div>
      <div className="bg-black/5 dark:bg-white/5 text-foreground rounded-2xl px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span>{label}</span>
        </div>
      </div>
    </div>
  );
}

function ImageGeneratingIndicator() {
  const { t } = useTranslation('chat');
  return (
    <div className="flex gap-3" data-testid="chat-image-generating-indicator">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full mt-1 bg-black/5 dark:bg-white/5 text-foreground">
        <img src={DEFAULT_AGENT_AVATAR_SRC} alt="" className="h-full w-full rounded-full object-cover" />
      </div>
      <div className="bg-black/5 dark:bg-white/5 text-foreground rounded-2xl px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span>{t('imageGeneration.generating')}</span>
        </div>
      </div>
    </div>
  );
}

function VideoGeneratingIndicator() {
  const { t } = useTranslation('chat');
  return (
    <div className="flex gap-3" data-testid="chat-video-generating-indicator">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full mt-1 bg-black/5 dark:bg-white/5 text-foreground">
        <img src={DEFAULT_AGENT_AVATAR_SRC} alt="" className="h-full w-full rounded-full object-cover" />
      </div>
      <div className="bg-black/5 dark:bg-white/5 text-foreground rounded-2xl px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span>{t('videoGeneration.generating', 'Generating video...')}</span>
        </div>
      </div>
    </div>
  );
}

export default Chat;
