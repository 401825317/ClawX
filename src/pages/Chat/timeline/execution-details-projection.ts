import type {
  ChatRuntimeArtifact,
  ChatRuntimePlanStep,
  ChatRuntimeTaskProjection,
  ChatRuntimeVerification,
} from '../../../../shared/chat-runtime-events';
import type { ConversationEvent } from '../../../../shared/conversation-events';
import {
  sanitizeRuntimeDisplayText,
  stringifyRuntimeDisplayValue,
} from '@/lib/runtime-display-sanitizer';
import type {
  ConversationTurn,
  TimelineItemStatus,
  ToolEntry,
} from '@/stores/conversation/types';
import {
  isVisibleRuntimePlanStep,
  type TaskStep,
  type TaskStepStatus,
} from '../runtime-task-visualization';

export interface ExecutionDetailsLabels {
  approval: string;
  artifact: string;
  plan: string;
  verification: string;
  taskFlow: string;
  toolInput: string;
  toolOutput: string;
}

const CANCELLATION_MARKERS = new Set(['aborted', 'cancelled', 'canceled']);

function taskStepId(taskId: string): string {
  return `plan-step:task:${taskId}`;
}

function taskFlowStepId(flowId: string): string {
  return `plan-step:task-flow:${flowId}`;
}

function itemStatus(status: TimelineItemStatus): TaskStepStatus {
  if (status === 'completed') return 'completed';
  if (status === 'error') return 'error';
  if (status === 'blocked') return 'blocked';
  return 'running';
}

function taskStatus(task: ChatRuntimeTaskProjection): TaskStepStatus {
  const lifecycle = [task.sourceStatus, task.deliveryStatus, task.terminalOutcome]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
  if (lifecycle.some((value) => CANCELLATION_MARKERS.has(value))) return 'aborted';
  if (task.status === 'completed') return 'completed';
  if (task.status === 'error') return 'error';
  if (task.status === 'waiting_approval' || task.status === 'partial') return 'blocked';
  return 'running';
}

function verificationStatus(verification: ChatRuntimeVerification): TaskStepStatus {
  if (verification.status === 'passed' || verification.status === 'skipped') return 'completed';
  if (verification.status === 'blocked') return 'blocked';
  return 'error';
}

function approvalStatus(status: string | undefined, fallback: TimelineItemStatus): TaskStepStatus {
  const normalized = status?.trim().toLowerCase();
  if (normalized && CANCELLATION_MARKERS.has(normalized)) return 'aborted';
  if (normalized && /reject|denied|error|failed/u.test(normalized)) return 'error';
  if (normalized && /approved|completed|resolved/u.test(normalized)) return 'completed';
  if (normalized && /pending|waiting|requested/u.test(normalized)) return 'blocked';
  return itemStatus(fallback);
}

function taskDuration(task: ChatRuntimeTaskProjection): number | undefined {
  if (task.startedAt == null || task.endedAt == null) return undefined;
  return Math.max(0, task.endedAt - task.startedAt);
}

function toolDetail(entry: ToolEntry, labels: ExecutionDetailsLabels): string | undefined {
  return toolInputOutputDetail(entry.args, entry.result ?? entry.partialResult, labels);
}

function toolInputOutputDetail(
  inputValue: unknown,
  outputValue: unknown,
  labels: ExecutionDetailsLabels,
): string | undefined {
  const input = stringifyRuntimeDisplayValue(inputValue);
  const output = stringifyRuntimeDisplayValue(outputValue);
  const sections = [
    input ? `${labels.toolInput}\n${input}` : undefined,
    output ? `${labels.toolOutput}\n${output}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

function runtimeStepStatus(status: ChatRuntimePlanStep['status']): TaskStepStatus {
  if (status === 'completed' || status === 'skipped') return 'completed';
  if (status === 'error') return 'error';
  if (status === 'blocked') return 'blocked';
  return 'running';
}

function safeNavigationUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = sanitizeRuntimeDisplayText(value);
  if (sanitized !== value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function toolUrl(entry: ToolEntry): string | undefined {
  if (entry.name !== 'web_fetch' || !entry.args || typeof entry.args !== 'object') return undefined;
  const url = (entry.args as { url?: unknown }).url;
  return typeof url === 'string' ? safeNavigationUrl(url) : undefined;
}

function displayReference(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return sanitizeRuntimeDisplayText(value)
    .replace(/^\/Users\/[^/]+(?=\/|$)/u, '~')
    .replace(/^\/home\/[^/]+(?=\/|$)/u, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/u, '~');
}

function sanitizeExecutionStep(step: TaskStep): TaskStep {
  return {
    ...step,
    label: sanitizeRuntimeDisplayText(step.label),
    detail: step.detail ? sanitizeRuntimeDisplayText(step.detail) : undefined,
    url: safeNavigationUrl(step.url),
  };
}

function artifactDetail(artifact: ChatRuntimeArtifact): string | undefined {
  const lines = [
    artifact.availability,
    displayReference(artifact.filePath),
    displayReference(artifact.url),
    artifact.mimeType,
    typeof artifact.sizeBytes === 'number' ? `${artifact.sizeBytes} bytes` : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function verificationDetail(verification: ChatRuntimeVerification): string | undefined {
  const lines = [verification.detail, verification.evidence]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return lines.length > 0 ? sanitizeRuntimeDisplayText(lines.join('\n')) : undefined;
}

function flowStatus(tasks: ChatRuntimeTaskProjection[], flowId: string): TaskStepStatus {
  const statuses = tasks.filter((task) => task.flowId === flowId).map(taskStatus);
  if (statuses.some((status) => status === 'running')) return 'running';
  if (statuses.some((status) => status === 'blocked')) return 'blocked';
  if (statuses.some((status) => status === 'error' || status === 'failed')) return 'error';
  if (statuses.some((status) => status === 'aborted')) return 'aborted';
  return statuses.length > 0 ? 'completed' : 'running';
}

function normalizeTopology(steps: TaskStep[]): TaskStep[] {
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const depthById = new Map<string, number>();
  const resolveDepth = (step: TaskStep, visiting = new Set<string>()): number => {
    const cached = depthById.get(step.id);
    if (cached != null) return cached;
    if (!step.parentId || step.parentId === 'agent-run' || visiting.has(step.id)) {
      depthById.set(step.id, Math.max(1, step.depth));
      return Math.max(1, step.depth);
    }
    const parent = stepById.get(step.parentId);
    if (!parent) {
      const depth = Math.max(2, step.depth);
      depthById.set(step.id, depth);
      return depth;
    }
    const nextVisiting = new Set(visiting).add(step.id);
    const depth = Math.max(step.depth, resolveDepth(parent, nextVisiting) + 1);
    depthById.set(step.id, depth);
    return depth;
  };
  return steps.map((step) => ({ ...step, depth: resolveDepth(step) }));
}

type OwnedAuthoritativeDiagnosticStep = {
  step: ChatRuntimePlanStep;
  taskId: string;
  toolCallId: string;
};

/**
 * Raw diagnostics cannot create user-visible graph nodes. The sole exception
 * is authoritative Host Task evidence that is owned by an already-reduced
 * canonical task or tool, which supplies that owner's lazy execution detail.
 */
function ownedAuthoritativeDiagnosticStep(
  event: ConversationEvent,
  knownTaskIds: ReadonlySet<string>,
): OwnedAuthoritativeDiagnosticStep | null {
  if (
    event.type !== 'step.updated'
    || event.timelineVisibility !== 'diagnostics'
    || event.source !== 'task-ledger'
    || event.authority !== 'authoritative'
  ) {
    return null;
  }
  const step = (event.data as { step?: ChatRuntimePlanStep }).step;
  const taskId = event.taskId ?? step?.taskId;
  const toolCallId = event.toolCallId ?? step?.toolCallId;
  if (!step || !taskId || !toolCallId) return null;
  if (!knownTaskIds.has(taskId)) return null;
  return { step, taskId, toolCallId };
}

/**
 * Projects one reduced canonical Turn into execution-graph steps. Canonical
 * items own identity, status, ordering and topology; legacy runtime state is
 * intentionally not consulted.
 */
export function deriveConversationExecutionSteps(
  turn: ConversationTurn | undefined,
  labels: ExecutionDetailsLabels,
  events: readonly ConversationEvent[] = [],
): TaskStep[] {
  if (!turn) return [];

  const canonicalSteps: TaskStep[] = [];
  const stepIndex = new Map<string, number>();
  const ownerRank = new Map<string, number>();
  const tasksById = new Map<string, ChatRuntimeTaskProjection>(
    Object.values(turn.taskById).map((task) => [task.taskId, task]),
  );
  for (const item of turn.items) {
    if (item.kind !== 'subtask') continue;
    for (const task of item.tasks) {
      if (!tasksById.has(task.taskId)) tasksById.set(task.taskId, task);
    }
  }
  const tasks = [...tasksById.values()];
  const knownTaskIds = new Set(tasksById.keys());

  const upsertCanonical = (step: TaskStep, rank: number): void => {
    const sanitizedStep = sanitizeExecutionStep(step);
    const existingIndex = stepIndex.get(step.id);
    if (existingIndex == null) {
      stepIndex.set(step.id, canonicalSteps.length);
      ownerRank.set(step.id, rank);
      canonicalSteps.push(sanitizedStep);
      return;
    }
    if (rank < (ownerRank.get(step.id) ?? 0)) return;
    const existing = canonicalSteps[existingIndex];
    canonicalSteps[existingIndex] = {
      ...existing,
      ...sanitizedStep,
      detail: sanitizedStep.detail ?? existing.detail,
      durationMs: sanitizedStep.durationMs ?? existing.durationMs,
      url: sanitizedStep.url ?? existing.url,
    };
    ownerRank.set(step.id, rank);
  };
  const ensureTaskFlow = (flowId: string): void => {
    upsertCanonical({
      id: taskFlowStepId(flowId),
      label: labels.taskFlow,
      status: flowStatus(tasks, flowId),
      kind: 'system',
      runtimeKind: 'task-flow',
      depth: 1,
      parentId: 'agent-run',
      flowId,
    }, 2);
  };
  const projectTask = (task: ChatRuntimeTaskProjection): void => {
    if (task.flowId) ensureTaskFlow(task.flowId);
    upsertCanonical({
      id: taskStepId(task.taskId),
      label: task.title,
      status: taskStatus(task),
      kind: 'system',
      runtimeKind: task.kind ?? task.runtime,
      detail: task.detail ?? task.terminalOutcome ?? task.deliveryStatus,
      durationMs: taskDuration(task),
      depth: task.parentTaskId ? (task.flowId ? 3 : 2) : (task.flowId ? 2 : 1),
      parentId: task.parentTaskId
        ? taskStepId(task.parentTaskId)
        : task.flowId
          ? taskFlowStepId(task.flowId)
          : 'agent-run',
      taskId: task.taskId,
      flowId: task.flowId,
    }, 3);
  };

  // Preserve canonical item chronology while collapsing companion plan/task/tool facts by stable ID.
  for (const item of turn.items) {
    switch (item.kind) {
      case 'plan': {
        const visibleSteps = item.steps.filter(isVisibleRuntimePlanStep);
        if (visibleSteps.length === 0 && !item.objective && !item.summary) break;
        upsertCanonical({
          id: 'run-plan',
          label: labels.plan,
          status: itemStatus(item.status),
          kind: 'system',
          detail: [item.objective, item.summary].filter(Boolean).join('\n') || undefined,
          depth: 1,
          parentId: 'agent-run',
        }, 1);
        for (const step of visibleSteps) {
          const id = step.taskId
            ? taskStepId(step.taskId)
            : step.toolCallId
              ? step.toolCallId
              : `plan-step:${step.id}`;
          upsertCanonical({
            id,
            label: step.title,
            status: step.status === 'skipped' ? 'completed' : itemStatus(step.status ?? 'running'),
            kind: step.toolCallId ? 'tool' : 'system',
            runtimeKind: step.kind,
            detail: step.detail,
            durationMs: step.durationMs,
            depth: step.parentId ? 2 : 1,
            parentId: step.parentId ? `plan-step:${step.parentId}` : 'run-plan',
            taskId: step.taskId,
          }, 1);
        }
        break;
      }
      case 'subtask':
        for (const task of item.tasks) projectTask(tasksById.get(task.taskId) ?? task);
        break;
      case 'tool-group':
        for (const entry of item.entries) {
          if (entry.name.trim().toLowerCase() === 'process') continue;
          const owningTaskId = entry.taskId ?? entry.parentTaskId;
          upsertCanonical({
            id: entry.toolCallId,
            label: entry.name,
            status: entry.status,
            kind: 'tool',
            detail: toolDetail(entry, labels),
            durationMs: entry.durationMs,
            depth: owningTaskId ? 2 : 1,
            parentId: owningTaskId ? taskStepId(owningTaskId) : 'agent-run',
            taskId: owningTaskId,
            url: toolUrl(entry),
          }, 3);
        }
        break;
      case 'approval':
        upsertCanonical({
          id: item.id,
          label: item.title || item.approvalKind || item.legacyKind || labels.approval,
          status: approvalStatus(item.approvalStatus ?? item.phase, item.status),
          kind: 'system',
          detail: item.message,
          depth: item.taskId ? 2 : 1,
          parentId: item.taskId ? taskStepId(item.taskId) : 'agent-run',
          taskId: item.taskId,
        }, 3);
        break;
      case 'artifact-group':
        for (const artifact of item.artifacts) {
          const parentId = artifact.sourceToolCallId
            ?? (artifact.taskId ? taskStepId(artifact.taskId) : 'agent-run');
          upsertCanonical({
            id: `artifact:${artifact.id}`,
            label: artifact.title || artifact.filePath?.split(/[\\/]/u).pop() || artifact.kind || labels.artifact,
            status: itemStatus(item.status),
            kind: 'system',
            detail: artifactDetail(artifact),
            depth: parentId === 'agent-run' ? 1 : 2,
            parentId,
            taskId: artifact.taskId,
          }, 3);
        }
        break;
      case 'verification-summary':
        for (const verification of item.verifications) {
          const parentId = verification.artifactId
            ? `artifact:${verification.artifactId}`
            : verification.taskId
              ? taskStepId(verification.taskId)
              : 'agent-run';
          upsertCanonical({
            id: `verification:${verification.id}`,
            label: verification.title || verification.kind || labels.verification,
            status: verificationStatus(verification),
            kind: 'system',
            detail: verificationDetail(verification),
            depth: parentId === 'agent-run' ? 1 : 2,
            parentId,
            taskId: verification.taskId,
          }, 3);
        }
        break;
      case 'error':
        upsertCanonical({
          id: `turn-error:${item.id}`,
          label: item.message,
          status: 'error',
          kind: 'system',
          depth: 1,
          parentId: 'agent-run',
        }, 3);
        break;
      default:
        break;
    }
  }

  // A task can be retained in canonical task state even when its compact timeline item is absent.
  for (const task of tasks) projectTask(task);

  for (const event of events) {
    const ownedStep = ownedAuthoritativeDiagnosticStep(event, knownTaskIds);
    if (!ownedStep) continue;
    const { step, taskId, toolCallId } = ownedStep;
    upsertCanonical({
      id: toolCallId,
      label: step.kind ?? step.title,
      status: runtimeStepStatus(step.status),
      kind: 'tool',
      runtimeKind: step.kind,
      detail: step.detail,
      durationMs: step.durationMs,
      depth: 2,
      parentId: taskStepId(taskId),
      taskId,
    }, 2);
  }

  return normalizeTopology(canonicalSteps);
}
