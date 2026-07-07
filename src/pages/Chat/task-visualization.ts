import {
  extractImages,
  extractText,
  extractTextSegments,
  extractToolUse,
  isGeneratingStatusNarration,
  isInternalAssistantReplyText,
  isInternalProcessNarration,
} from './message-utils';
import { isInternalMessage } from '@/stores/chat/helpers';
import type { RawMessage, ToolStatus } from '@/stores/chat';
import type { ChatRuntimeRunState } from '@/stores/chat/types';
import { appendToolErrorHint, normalizeToolErrorMessage } from '@/lib/tool-error-messages';

export type TaskStepStatus = 'running' | 'completed' | 'error' | 'blocked' | 'failed' | 'aborted';

export interface TaskStep {
  id: string;
  label: string;
  status: TaskStepStatus;
  kind: 'thinking' | 'tool' | 'system' | 'message';
  detail?: string;
  depth: number;
  parentId?: string;
  /** Extracted URL for web_fetch tool, used to render a clickable link icon. */
  url?: string;
}

function isFilteredExecutionGraphTool(name: string | undefined | null): boolean {
  const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
  return normalized === 'process';
}

/**
 * Detects the index of the "final reply" assistant message in a run segment.
 *
 * The reply is the last assistant message that carries non-empty text
 * content, regardless of whether it ALSO carries tool calls. (Mixed
 * `text + toolCall` replies are rare but real — the model can emit a parting
 * text block alongside a final tool call. Treating such a message as the
 * reply avoids mis-protecting an earlier narration as the "answer" and
 * leaking the actual last text into the fold.)
 *
 * When this returns a non-negative index, the caller should avoid folding
 * that message's text into the graph (it is the answer the user sees in the
 * chat stream). When the run is still active (streaming) the final reply is
 * produced via `streamingMessage` instead, so callers pass
 * `hasStreamingReply = true` to skip protection and let every assistant-with-
 * text message in history be folded into the graph as narration.
 */
export function findReplyMessageIndex(messages: RawMessage[], hasStreamingReply: boolean): number {
  if (hasStreamingReply) return -1;
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const message = messages[idx];
    if (!message || message.role !== 'assistant') continue;
    const replyText = extractText(message).trim();
    if (messageHasUserVisibleImage(message)) return idx;
    if (replyText.length === 0 || isInternalAssistantReplyText(replyText)) continue;
    if (isGeneratingStatusNarration(replyText)) continue;
    return idx;
  }
  return -1;
}

function messageHasUserVisibleImage(message: RawMessage): boolean {
  if ((message._attachedFiles ?? []).some((file) => file.mimeType.startsWith('image/'))) {
    return true;
  }
  return extractImages(message).length > 0;
}

/**
 * When true, assistant history in the run segment should be folded into the
 * execution graph because the live answer is (or will be) shown via streaming.
 * When false but the run is still open, a final reply already in history must
 * stay visible in the chat stream (history poll can beat stream teardown).
 */
export function hasActiveStreamingReplyInRun(
  isLatestOpenRun: boolean,
  hasAnyStreamContent: boolean,
  streamingReplyText: string | null,
): boolean {
  return isLatestOpenRun && (hasAnyStreamContent || streamingReplyText != null);
}

/**
 * Message indices that belong to an agent run segment (strictly after a run
 * trigger user message up to the next real user message). Used to fold tool
 * cards and process attachments into ExecutionGraphCard without depending on
 * whether a graph card was successfully materialized (e.g. after history
 * reload when the step cache is empty).
 */
export function buildRunSegmentMessageIndices(
  messages: RawMessage[],
  nextUserMessageIndexes: number[],
  isRunTrigger: (message: RawMessage, index: number) => boolean,
): Set<number> {
  const indices = new Set<number>();
  messages.forEach((message, triggerIndex) => {
    if (!isRunTrigger(message, triggerIndex)) return;
    const nextUserIndex = nextUserMessageIndexes[triggerIndex];
    const segmentEnd = nextUserIndex === -1 ? messages.length - 1 : nextUserIndex - 1;
    for (let idx = triggerIndex + 1; idx <= segmentEnd; idx += 1) {
      indices.add(idx);
    }
  });

  // History pagination loads a suffix of the transcript. When the triggering
  // user turn fell off the window, assistant tool steps remain at the top of
  // `messages[]` without a preceding user row — fold them into the first run.
  let firstTriggerIndex = -1;
  for (let idx = 0; idx < messages.length; idx += 1) {
    if (isRunTrigger(messages[idx], idx)) {
      firstTriggerIndex = idx;
      break;
    }
  }
  if (firstTriggerIndex > 0) {
    for (let idx = 0; idx < firstTriggerIndex; idx += 1) {
      if (messages[idx]?.role === 'assistant') {
        indices.add(idx);
      }
    }
  }

  return indices;
}

/**
 * Messages strictly after the triggering user turn up to the next user.
 * Use this for run lifecycle (final reply detection, reply index, open-run
 * state) — never count paginated orphan assistants from a prior turn.
 */
export function getPostTriggerSegmentMessages(
  messages: RawMessage[],
  triggerIndex: number,
  nextUserIndex: number,
): RawMessage[] {
  const segmentEnd = nextUserIndex === -1 ? messages.length : nextUserIndex;
  return messages.slice(triggerIndex + 1, segmentEnd);
}

/**
 * Slice messages for a user-triggered run, including leading assistant orphans
 * that belong to the same run but were separated by paginated history.
 */
export function getRunSegmentMessages(
  messages: RawMessage[],
  triggerIndex: number,
  nextUserIndex: number,
  isRunTrigger: (message: RawMessage, index: number) => boolean,
): RawMessage[] {
  const segmentEnd = nextUserIndex === -1 ? messages.length : nextUserIndex;
  const core = messages.slice(triggerIndex + 1, segmentEnd);
  const hasEarlierUser = messages.some((message, index) => index < triggerIndex && isRunTrigger(message, index));
  if (hasEarlierUser || triggerIndex === 0) return core;
  const orphans = messages.slice(0, triggerIndex).filter((message) => message.role === 'assistant');
  return [...orphans, ...core];
}

/**
 * True when a run segment already contains a conclusive assistant reply: the
 * last assistant message with user-visible text that appears after all tool
 * calls (if any). Intermediate narration before tools does not count.
 */
export function segmentHasFinalReply(segmentMessages: RawMessage[]): boolean {
  let lastToolUseOffset = -1;
  for (let i = segmentMessages.length - 1; i >= 0; i -= 1) {
    const message = segmentMessages[i];
    if (message.role === 'assistant' && extractToolUse(message).length > 0) {
      lastToolUseOffset = i;
      break;
    }
  }
  return segmentMessages.some((message, index) => {
    if (index <= lastToolUseOffset) return false;
    if (message.role !== 'assistant') return false;
    if (messageHasUserVisibleImage(message)) return true;
    const replyText = extractText(message).trim();
    if (replyText.length === 0 || isInternalAssistantReplyText(replyText)) return false;
    if (isGeneratingStatusNarration(replyText)) return false;
    const content = message.content;
    if (!Array.isArray(content)) return true;
    return !(content as Array<{ type?: string }>).some(
      (block) => block.type === 'tool_use' || block.type === 'toolCall',
    );
  });
}

interface DeriveTaskStepsInput {
  messages: RawMessage[];
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  omitLastStreamingMessageSegment?: boolean;
}

export interface SubagentCompletionInfo {
  sessionKey: string;
  sessionId: string;
  agentId: string;
}

function normalizeText(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/[ \t]+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized;
}

function makeToolId(prefix: string, name: string, index: number): string {
  return `${prefix}:${name}:${index}`;
}

export function parseAgentIdFromSessionKey(sessionKey: string): string | null {
  const parts = sessionKey.split(':');
  if (parts.length < 2 || parts[0] !== 'agent') return null;
  return parts[1] || null;
}

export function parseSubagentCompletionInfo(message: RawMessage): SubagentCompletionInfo | null {
  const text = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((block) => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('\n')
      : '';
  if (!text.includes('[Internal task completion event]')) return null;

  const sessionKeyMatch = text.match(/session_key:\s*(.+)/);
  const sessionIdMatch = text.match(/session_id:\s*(.+)/);
  const sessionKey = sessionKeyMatch?.[1]?.trim();
  const sessionId = sessionIdMatch?.[1]?.trim();
  if (!sessionKey || !sessionId) return null;
  const agentId = parseAgentIdFromSessionKey(sessionKey);
  if (!agentId) return null;
  return { sessionKey, sessionId, agentId };
}

function isSpawnLikeStep(label: string): boolean {
  return /(spawn|subagent|delegate|parallel)/i.test(label);
}

function tryParseJsonObject(detail: string | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function extractBranchAgent(step: TaskStep): string | null {
  const parsed = tryParseJsonObject(step.detail);
  const agentId = parsed?.agentId;
  if (typeof agentId === 'string' && agentId.trim()) return agentId.trim();

  const message = typeof parsed?.message === 'string' ? parsed.message : step.detail;
  if (!message) return null;
  const match = message.match(/\b(coder|reviewer|project-manager|manager|planner|researcher|worker|subagent)\b/i);
  return match ? match[1] : null;
}

function attachTopology(steps: TaskStep[]): TaskStep[] {
  const withTopology: TaskStep[] = [];
  let activeBranchNodeId: string | null = null;

  for (const step of steps) {
    if (step.kind === 'system') {
      activeBranchNodeId = null;
      withTopology.push({
        ...step,
        depth: step.parentId ? step.depth : 1,
        parentId: step.parentId ?? 'agent-run',
      });
      continue;
    }

    if (/sessions_spawn/i.test(step.label)) {
      const branchAgent = extractBranchAgent(step) || 'subagent';
      const branchNodeId = `${step.id}:branch`;
      withTopology.push({ ...step, depth: 1, parentId: 'agent-run' });
      withTopology.push({
        id: branchNodeId,
        label: `${branchAgent} run`,
        status: step.status,
        kind: 'system',
        detail: `Spawned branch for ${branchAgent}`,
        depth: 2,
        parentId: step.id,
      });
      activeBranchNodeId = branchNodeId;
      continue;
    }

    if (/sessions_yield/i.test(step.label)) {
      withTopology.push({
        ...step,
        depth: activeBranchNodeId ? 3 : 1,
        parentId: activeBranchNodeId ?? 'agent-run',
      });
      activeBranchNodeId = null;
      continue;
    }

    if (step.kind === 'thinking' || step.kind === 'message') {
      withTopology.push({
        ...step,
        depth: activeBranchNodeId ? 3 : 1,
        parentId: activeBranchNodeId ?? 'agent-run',
      });
      continue;
    }

    if (isSpawnLikeStep(step.label)) {
      activeBranchNodeId = step.id;
      withTopology.push({
        ...step,
        depth: 1,
        parentId: 'agent-run',
      });
      continue;
    }

    withTopology.push({
      ...step,
      depth: activeBranchNodeId ? 3 : 1,
      parentId: activeBranchNodeId ?? 'agent-run',
    });
  }

  return withTopology;
}

function appendDetailSegments(
  segments: string[],
  options: {
    idPrefix: string;
    label: string;
    kind: Extract<TaskStep['kind'], 'thinking' | 'message'>;
    running: boolean;
    upsertStep: (step: TaskStep) => void;
  },
): void {
  const normalizedSegments = segments
    .map((segment) => normalizeText(segment))
    .filter((segment): segment is string => !!segment)
    .filter((segment) => !isInternalProcessNarration(segment));

  normalizedSegments.forEach((detail, index) => {
    options.upsertStep({
      id: `${options.idPrefix}-${index}`,
      label: options.label,
      status: options.running && index === normalizedSegments.length - 1 ? 'running' : 'completed',
      kind: options.kind,
      detail,
      depth: 1,
    });
  });
}

function runtimeDetail(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (value == null) return undefined;
  try {
    const rendered = JSON.stringify(value, null, 2);
    return rendered.length > 4000 ? `${rendered.slice(0, 4000)}…` : rendered;
  } catch {
    return String(value);
  }
}

function parseJsonObjectText(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function firstTextBlock(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue;
    const text = (entry as { text?: unknown }).text;
    if (typeof text === 'string' && text.trim()) {
      return text.trim();
    }
  }
  return undefined;
}

function extractToolErrorText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = parseJsonObjectText(trimmed);
    if (parsed) {
      return extractToolErrorText(parsed) ?? trimmed;
    }
    return trimmed;
  }
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  const details = record.details;
  if (details && typeof details === 'object') {
    const detailsError = extractToolErrorText((details as Record<string, unknown>).error);
    if (detailsError) return detailsError;
    const detailsMessage = extractToolErrorText((details as Record<string, unknown>).message);
    if (detailsMessage) return detailsMessage;
  }

  const directError = extractToolErrorText(record.error);
  if (directError) return directError;
  const directMessage = extractToolErrorText(record.message);
  if (directMessage) return directMessage;

  const contentText = firstTextBlock(record.content);
  if (contentText) {
    const parsed = parseJsonObjectText(contentText);
    if (parsed) return extractToolErrorText(parsed) ?? contentText;
    return contentText;
  }

  return undefined;
}

function getToolErrorDetail(value: unknown): string | undefined {
  const rendered = extractToolErrorText(value) ?? runtimeDetail(value);
  return appendToolErrorHint(rendered, 'zh');
}

function getToolSummaryDetail(tool: ToolStatus): string | undefined {
  if (tool.status === 'error') {
    return normalizeToolErrorMessage(tool.summary, 'zh') ?? normalizeText(tool.summary);
  }
  return normalizeText(tool.summary);
}

function runtimeStepStatus(status: string | undefined): TaskStepStatus {
  if (status === 'completed' || status === 'passed' || status === 'skipped') return 'completed';
  if (status === 'blocked') return 'blocked';
  if (status === 'failed') return 'failed';
  if (status === 'aborted') return 'aborted';
  if (status === 'error') return 'error';
  return 'running';
}

function artifactDetail(artifact: NonNullable<ChatRuntimeRunState['artifacts']>[number]): string | undefined {
  const lines = [
    artifact.filePath,
    artifact.url,
    artifact.mimeType,
    typeof artifact.sizeBytes === 'number' ? `${artifact.sizeBytes} bytes` : undefined,
  ].filter((line): line is string => typeof line === 'string' && line.trim().length > 0);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function verificationDetail(verification: NonNullable<ChatRuntimeRunState['verifications']>[number]): string | undefined {
  const meta = [
    verification.kind ? `kind=${verification.kind}` : undefined,
    verification.required === false ? 'optional' : verification.required === true ? 'required' : undefined,
    verification.severity ? `severity=${verification.severity}` : undefined,
  ].filter(Boolean).join(' · ');
  const lines = [
    meta || undefined,
    verification.detail,
    verification.evidence,
  ].filter((line): line is string => typeof line === 'string' && line.trim().length > 0);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function checkpointDetail(checkpoint: NonNullable<ChatRuntimeRunState['checkpoints']>[number]): string | undefined {
  const issueLines = (checkpoint.issues ?? []).map((issue, index) => {
    const meta = [
      issue.severity,
      `code=${issue.code}`,
      typeof issue.recoverable === 'boolean' ? `recoverable=${issue.recoverable}` : undefined,
    ].filter(Boolean).join(' · ');
    const prefix = `${index + 1}. [${meta}] ${issue.title}`;
    return [
      issue.detail ? `${prefix}: ${issue.detail}` : prefix,
      issue.suggestedRecovery ? `recovery=${issue.suggestedRecovery}` : undefined,
    ].filter((line): line is string => typeof line === 'string' && line.trim().length > 0).join('\n');
  });
  const lines = [
    `checkpoint=${checkpoint.id}`,
    typeof checkpoint.recoverable === 'boolean' ? `recoverable=${checkpoint.recoverable}` : undefined,
    checkpoint.summary,
    checkpoint.reason,
    ...issueLines,
  ].filter((line): line is string => typeof line === 'string' && line.trim().length > 0);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function gateIssueDetail(issue: NonNullable<ChatRuntimeRunState['issues']>[number]): string | undefined {
  const lines = [
    `code=${issue.code}`,
    typeof issue.recoverable === 'boolean' ? `recoverable=${issue.recoverable}` : undefined,
    issue.detail,
    issue.suggestedRecovery ? `recovery=${issue.suggestedRecovery}` : undefined,
  ].filter((line): line is string => typeof line === 'string' && line.trim().length > 0);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function gateEvaluationStatus(decision: NonNullable<ChatRuntimeRunState['gateResult']>['decision']): TaskStepStatus {
  if (decision === 'deliverable') return 'completed';
  if (decision === 'continue_required' || decision === 'blocked_needs_user') return 'blocked';
  if (decision === 'failed') return 'failed';
  if (decision === 'aborted') return 'aborted';
  return 'error';
}

function gateEvaluationDetail(gate: NonNullable<ChatRuntimeRunState['gateResult']>): string | undefined {
  const lines = [
    gate.summary,
    `decision=${gate.decision}`,
    `artifacts=${gate.artifactCount}`,
    `required_verifications=${gate.passedRequiredVerificationCount}/${gate.requiredVerificationCount}`,
    `blocking=${gate.blockingIssueCount}`,
    `warnings=${gate.warningIssueCount}`,
    `coverage=${Math.round(gate.verificationCoverage * 100)}%`,
  ].filter((line): line is string => typeof line === 'string' && line.trim().length > 0);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function gateIssueStatus(issue: NonNullable<ChatRuntimeRunState['issues']>[number]): TaskStepStatus {
  if (issue.severity !== 'blocking') return 'completed';
  return issue.recoverable === false ? 'failed' : 'blocked';
}

function checkpointStatus(checkpoint: NonNullable<ChatRuntimeRunState['checkpoints']>[number]): TaskStepStatus {
  if (checkpoint.recoverable === false) return 'failed';
  if (checkpoint.recoverable === true || (checkpoint.issues?.length ?? 0) > 0 || checkpoint.reason) return 'blocked';
  return 'completed';
}

export function deriveRuntimeTaskSteps(runState: ChatRuntimeRunState | null | undefined): TaskStep[] {
  if (!runState) return [];

  const steps: TaskStep[] = [];
  const stepIndexById = new Map<string, number>();
  const upsertStep = (step: TaskStep): void => {
    const existingIndex = stepIndexById.get(step.id);
    if (existingIndex == null) {
      stepIndexById.set(step.id, steps.length);
      steps.push(step);
      return;
    }
    const existing = steps[existingIndex];
    steps[existingIndex] = {
      ...existing,
      ...step,
      detail: step.detail ?? existing.detail,
      url: step.url ?? existing.url,
    };
  };

  for (const event of runState.events) {
    switch (event.type) {
      case 'run.plan.updated': {
        upsertStep({
          id: 'run-plan',
          label: 'Plan',
          status: event.steps.some((step) => step.status === 'running') ? 'running' : 'completed',
          kind: 'system',
          detail: [event.objective, event.summary].filter(Boolean).join('\n') || undefined,
          depth: 1,
        });
        for (const planStep of event.steps) {
          upsertStep({
            id: `plan-step:${planStep.id}`,
            label: planStep.title,
            status: runtimeStepStatus(planStep.status),
            kind: 'system',
            detail: planStep.detail,
            depth: planStep.parentId ? 2 : 1,
            parentId: planStep.parentId ? `plan-step:${planStep.parentId}` : 'run-plan',
          });
        }
        break;
      }
      case 'run.step.updated': {
        upsertStep({
          id: `plan-step:${event.step.id}`,
          label: event.step.title,
          status: runtimeStepStatus(event.step.status),
          kind: 'system',
          detail: event.step.detail,
          depth: event.step.parentId ? 2 : 1,
          parentId: event.step.parentId ? `plan-step:${event.step.parentId}` : 'run-plan',
        });
        break;
      }
      case 'tool.started': {
        if (isFilteredExecutionGraphTool(event.name)) {
          break;
        }
        const input = event.args as Record<string, unknown> | undefined;
        const url = event.name === 'web_fetch' && typeof input?.url === 'string' ? input.url : undefined;
        upsertStep({
          id: event.toolCallId,
          label: event.name,
          status: 'running',
          kind: 'tool',
          detail: runtimeDetail(event.args),
          depth: 1,
          url,
        });
        break;
      }
      case 'tool.updated': {
        if (isFilteredExecutionGraphTool(event.name)) {
          break;
        }
        upsertStep({
          id: event.toolCallId,
          label: event.name,
          status: 'running',
          kind: 'tool',
          detail: runtimeDetail(event.partialResult),
          depth: 1,
        });
        break;
      }
      case 'tool.completed': {
        if (isFilteredExecutionGraphTool(event.name)) {
          break;
        }
        upsertStep({
          id: event.toolCallId,
          label: event.name,
          status: event.isError ? 'error' : 'completed',
          kind: 'tool',
          detail: event.isError ? getToolErrorDetail(event.result) : runtimeDetail(event.result),
          depth: 1,
        });
        break;
      }
      case 'artifact.produced': {
        upsertStep({
          id: `artifact:${event.artifact.id}`,
          label: event.artifact.title || event.artifact.kind || 'Artifact',
          status: 'completed',
          kind: 'system',
          detail: artifactDetail(event.artifact),
          depth: 1,
        });
        break;
      }
      case 'verification.completed': {
        upsertStep({
          id: `verification:${event.verification.id}`,
          label: event.verification.title || 'Verification',
          status: runtimeStepStatus(event.verification.status),
          kind: 'system',
          detail: verificationDetail(event.verification),
          depth: event.verification.artifactId ? 2 : 1,
          parentId: event.verification.artifactId ? `artifact:${event.verification.artifactId}` : undefined,
        });
        break;
      }
      case 'gate.issue': {
        upsertStep({
          id: `gate-issue:${event.issue.id}`,
          label: event.issue.title,
          status: gateIssueStatus(event.issue),
          kind: 'system',
          detail: gateIssueDetail(event.issue),
          depth: 2,
          parentId: 'gate-result',
        });
        break;
      }
      case 'run.checkpoint': {
        upsertStep({
          id: `checkpoint:${event.checkpoint.id}`,
          label: 'Checkpoint',
          status: checkpointStatus(event.checkpoint),
          kind: 'message',
          detail: checkpointDetail(event.checkpoint),
          depth: 1,
        });
        break;
      }
      case 'gate.evaluated': {
        upsertStep({
          id: 'gate-result',
          label: 'Gate',
          status: gateEvaluationStatus(event.gate.decision),
          kind: 'system',
          detail: gateEvaluationDetail(event.gate),
          depth: 1,
        });
        for (const issue of event.gate.issues) {
          upsertStep({
            id: `gate-issue:${issue.id}`,
            label: issue.title,
            status: gateIssueStatus(issue),
            kind: 'system',
            detail: gateIssueDetail(issue),
            depth: 2,
            parentId: 'gate-result',
          });
        }
        break;
      }
      case 'command.output': {
        if (isFilteredExecutionGraphTool(event.name)) {
          break;
        }
        const id = event.itemId || `${event.toolCallId || event.name || 'command'}:output`;
        upsertStep({
          id,
          label: event.title || `${event.name || 'Command'} output`,
          status: event.status === 'failed' || event.status === 'error' ? 'error' : event.phase === 'end' ? 'completed' : 'running',
          kind: 'message',
          detail: runtimeDetail(event.output),
          depth: 1,
        });
        break;
      }
      case 'patch.completed': {
        const id = event.itemId || `${event.toolCallId || event.name || 'patch'}:patch`;
        upsertStep({
          id,
          label: event.title || event.name || 'Patch',
          status: 'completed',
          kind: 'system',
          detail: runtimeDetail(event.summary),
          depth: 1,
        });
        break;
      }
      case 'approval.updated': {
        const id = event.itemId || `${event.toolCallId || 'approval'}:approval`;
        upsertStep({
          id,
          label: event.title || 'Approval',
          status: event.status === 'denied' || event.status === 'failed' ? 'error' : event.phase === 'resolved' ? 'completed' : 'running',
          kind: 'system',
          detail: runtimeDetail(event.message),
          depth: 1,
        });
        break;
      }
      default:
        break;
    }
  }

  return attachTopology(steps);
}

export function deriveTaskSteps({
  messages,
  streamingMessage,
  streamingTools,
  omitLastStreamingMessageSegment = false,
}: DeriveTaskStepsInput): TaskStep[] {
  const steps: TaskStep[] = [];
  const stepIndexById = new Map<string, number>();

  const upsertStep = (step: TaskStep): void => {
    const existingIndex = stepIndexById.get(step.id);
    if (existingIndex == null) {
      stepIndexById.set(step.id, steps.length);
      steps.push(step);
      return;
    }
    const existing = steps[existingIndex];
    steps[existingIndex] = {
      ...existing,
      ...step,
      detail: step.detail ?? existing.detail,
    };
  };

  const streamMessage = streamingMessage && typeof streamingMessage === 'object'
    ? streamingMessage as RawMessage
    : null;

  // The final answer the user sees as a chat bubble. We avoid folding it into
  // the graph to prevent duplication. When a run is still streaming, the
  // reply lives in `streamingMessage`, so every pure-text assistant message in
  // `messages` is treated as intermediate narration.
  const replyIndex = findReplyMessageIndex(messages, streamMessage != null);

  for (const [messageIndex, message] of messages.entries()) {
    if (!message || message.role !== 'assistant') continue;

    const toolUses = extractToolUse(message);
    if (!isInternalMessage(message)) {
      // Fold any intermediate assistant text into the graph as a narration
      // step — including text that lives on a mixed `text + toolCall` message.
      // The narration step is emitted BEFORE the tool steps so the graph
      // preserves the original ordering (the assistant "thinks out loud" and
      // then invokes the tool).
      const narrationSegments = extractTextSegments(message);
      const graphNarrationSegments = messageIndex === replyIndex
        ? narrationSegments.slice(0, -1)
        : narrationSegments;
      appendDetailSegments(graphNarrationSegments, {
        idPrefix: `history-message-${message.id || messageIndex}`,
        label: 'Message',
        kind: 'message',
        running: false,
        upsertStep,
      });
    } else if (toolUses.length === 0) {
      continue;
    }

    toolUses.forEach((tool, index) => {
      if (isFilteredExecutionGraphTool(tool.name)) {
        return;
      }
      const input = tool.input as Record<string, unknown>;
      const url = tool.name === 'web_fetch' && typeof input?.url === 'string' ? input.url : undefined;
      upsertStep({
        id: tool.id || makeToolId(`history-tool-${message.id || messageIndex}`, tool.name, index),
        label: tool.name,
        status: 'completed',
        kind: 'tool',
        detail: normalizeText(JSON.stringify(tool.input, null, 2)),
        depth: 1,
        url,
      });
    });
  }

  if (streamMessage) {
    // Stream-time narration should also appear in the execution graph so that
    // intermediate process output stays in P1 instead of leaking into the
    // assistant reply area.
    const streamNarrationSegments = extractTextSegments(streamMessage);
    const graphStreamNarrationSegments = omitLastStreamingMessageSegment
      ? streamNarrationSegments.slice(0, -1)
      : streamNarrationSegments;
    appendDetailSegments(graphStreamNarrationSegments, {
      idPrefix: 'stream-message',
      label: 'Message',
      kind: 'message',
      running: !omitLastStreamingMessageSegment,
      upsertStep,
    });
  }

  const activeToolIds = new Set<string>();
  const activeToolNamesWithoutIds = new Set<string>();
  streamingTools.forEach((tool, index) => {
    if (isFilteredExecutionGraphTool(tool.name)) {
      return;
    }
    const id = tool.toolCallId || tool.id || makeToolId('stream-status', tool.name, index);
    activeToolIds.add(id);
    if (!tool.toolCallId && !tool.id) {
      activeToolNamesWithoutIds.add(tool.name);
    }
    upsertStep({
      id,
      label: tool.name,
      status: tool.status,
      kind: 'tool',
      detail: getToolSummaryDetail(tool),
      depth: 1,
    });
  });

  if (streamMessage) {
    extractToolUse(streamMessage).forEach((tool, index) => {
      if (isFilteredExecutionGraphTool(tool.name)) {
        return;
      }
      const id = tool.id || makeToolId('stream-tool', tool.name, index);
      if (activeToolIds.has(id) || activeToolNamesWithoutIds.has(tool.name)) return;
      const input = tool.input as Record<string, unknown>;
      const url = tool.name === 'web_fetch' && typeof input?.url === 'string' ? input.url : undefined;
      upsertStep({
        id,
        label: tool.name,
        status: 'running',
        kind: 'tool',
        detail: normalizeText(JSON.stringify(tool.input, null, 2)),
        depth: 1,
        url,
      });
    });
  }

  return attachTopology(steps);
}
