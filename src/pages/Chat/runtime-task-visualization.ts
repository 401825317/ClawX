import { appendToolErrorHint } from '../../lib/tool-error-messages';
import { stringifyRuntimeDisplayValue } from '../../lib/runtime-display-sanitizer';
import type { ChatRuntimeRunState } from '../../stores/chat/types';

export type TaskStepStatus = 'running' | 'completed' | 'error' | 'blocked' | 'failed' | 'aborted';

export type RuntimePlanStep = NonNullable<ChatRuntimeRunState['planSteps']>[number];
type RuntimeTaskProjection = NonNullable<ChatRuntimeRunState['tasks']>[number];

export interface TaskStep {
  id: string;
  label: string;
  status: TaskStepStatus;
  kind: 'thinking' | 'tool' | 'system' | 'message';
  runtimeKind?: string;
  detail?: string;
  durationMs?: number;
  depth: number;
  parentId?: string;
  taskId?: string;
  flowId?: string;
  /** Extracted URL for web_fetch tool, used to render a clickable link icon. */
  url?: string;
}

const RUNTIME_SCAFFOLD_PLAN_STEP_IDS = new Set([
  'uclaw.objective',
  'uclaw.execute',
  'uclaw.verify',
  'uclaw.deliver',
]);

const RUNTIME_SCAFFOLD_PLAN_STEP_KINDS = new Set([
  'objective',
  'execution',
  'verification',
  'delivery',
]);

const TERMINAL_TASK_STATUSES = new Set<RuntimeTaskProjection['status']>(['completed', 'error']);
const TERMINAL_STEP_STATUSES = new Set<TaskStepStatus>(['completed', 'error', 'failed', 'aborted']);
const CANCELLATION_MARKERS = new Set(['aborted', 'cancelled', 'canceled']);

function isFilteredExecutionGraphTool(name: string | undefined | null): boolean {
  const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
  return normalized === 'process';
}

function runtimeStepRequiresArtifact(step: RuntimePlanStep): boolean {
  return step.requiresArtifact === true
    || step.requiredArtifact === true
    || step.artifactRequired === true
    || step.outputArtifactRequired === true;
}

function isRuntimeScaffoldPlanStep(step: RuntimePlanStep): boolean {
  const kind = typeof step.kind === 'string' ? step.kind.trim().toLowerCase() : '';
  return RUNTIME_SCAFFOLD_PLAN_STEP_IDS.has(step.id)
    && (kind.length === 0 || RUNTIME_SCAFFOLD_PLAN_STEP_KINDS.has(kind));
}

export function isVisibleRuntimePlanStep(step: RuntimePlanStep): boolean {
  const kind = typeof step.kind === 'string' ? step.kind.trim().toLowerCase() : '';
  if (kind === 'composite' || kind === 'composite-task' || kind.startsWith('media.')) return true;
  if (runtimeStepRequiresArtifact(step)) return true;
  if (step.status === 'blocked' || step.status === 'error') return true;
  return !isRuntimeScaffoldPlanStep(step);
}

function normalizeText(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/[ \t]+/g, ' ').trim();
  return normalized || undefined;
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
  return typeof agentId === 'string' && agentId.trim() ? agentId.trim() : null;
}

function attachTopology(steps: TaskStep[]): TaskStep[] {
  const withTopology: TaskStep[] = [];
  let activeBranchNodeId: string | null = null;

  for (const step of steps) {
    if (step.parentId) {
      withTopology.push(step);
      continue;
    }
    if (step.kind === 'system') {
      activeBranchNodeId = null;
      withTopology.push({ ...step, depth: 1, parentId: 'agent-run' });
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
    withTopology.push({
      ...step,
      depth: activeBranchNodeId ? 3 : 1,
      parentId: activeBranchNodeId ?? 'agent-run',
    });
  }

  return withTopology;
}

function runtimeDetail(value: unknown): string | undefined {
  const rendered = stringifyRuntimeDisplayValue(value)?.trim();
  if (!rendered) return undefined;
  return rendered.length > 4000 ? `${rendered.slice(0, 4000)}…` : rendered;
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
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return undefined;
}

function extractToolErrorText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = parseJsonObjectText(trimmed);
    return parsed ? extractToolErrorText(parsed) ?? trimmed : trimmed;
  }
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  const details = record.details;
  if (details && typeof details === 'object') {
    const detailsRecord = details as Record<string, unknown>;
    const detailsError = extractToolErrorText(detailsRecord.error);
    if (detailsError) return detailsError;
    const detailsMessage = extractToolErrorText(detailsRecord.message);
    if (detailsMessage) return detailsMessage;
  }
  const directError = extractToolErrorText(record.error);
  if (directError) return directError;
  const directMessage = extractToolErrorText(record.message);
  if (directMessage) return directMessage;
  const contentText = firstTextBlock(record.content);
  if (!contentText) return undefined;
  const parsed = parseJsonObjectText(contentText);
  return parsed ? extractToolErrorText(parsed) ?? contentText : contentText;
}

function getToolErrorDetail(value: unknown): string | undefined {
  return appendToolErrorHint(extractToolErrorText(value) ?? runtimeDetail(value), 'zh');
}

function formatDuration(durationMs: number | undefined): string | undefined {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${Math.round(durationMs / 1000)}s`;
}

function runElapsedMs(runState: ChatRuntimeRunState): number | undefined {
  const startedAt = typeof runState.startedAt === 'number' ? runState.startedAt : undefined;
  if (startedAt == null) return undefined;
  const endAt = typeof runState.endedAt === 'number'
    ? runState.endedAt
    : typeof runState.lastEventAt === 'number'
      ? runState.lastEventAt
      : Date.now();
  const elapsed = endAt - startedAt;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
}

function runtimeStepStatus(status: string | undefined): TaskStepStatus {
  const normalized = status?.trim().toLowerCase();
  if (normalized === 'completed' || normalized === 'passed' || normalized === 'skipped') return 'completed';
  if (normalized === 'blocked' || normalized === 'partial' || normalized === 'waiting_approval') return 'blocked';
  if (normalized === 'failed') return 'failed';
  if (normalized && CANCELLATION_MARKERS.has(normalized)) return 'aborted';
  if (normalized === 'error') return 'error';
  return 'running';
}

function taskWasCancelled(task: RuntimeTaskProjection): boolean {
  return [task.sourceStatus, task.deliveryStatus, task.terminalOutcome]
    .some((value) => typeof value === 'string' && CANCELLATION_MARKERS.has(value.trim().toLowerCase()));
}

function runtimeTaskStatus(task: RuntimeTaskProjection): TaskStepStatus {
  return taskWasCancelled(task) ? 'aborted' : runtimeStepStatus(task.status);
}

function runtimeTaskStepId(taskId: string): string {
  return `plan-step:task:${taskId}`;
}

function runtimeTaskFlowStepId(flowId: string): string {
  return `plan-step:task-flow:${flowId}`;
}

function aggregateTaskFlowStatus(steps: TaskStep[], flowId: string): TaskStepStatus {
  const statuses = steps
    .filter((step) => step.flowId === flowId && Boolean(step.taskId))
    .map((step) => step.status);
  if (statuses.some((status) => status === 'running')) return 'running';
  if (statuses.some((status) => status === 'blocked')) return 'blocked';
  if (statuses.some((status) => status === 'error' || status === 'failed')) return 'error';
  if (statuses.some((status) => status === 'aborted')) return 'aborted';
  return statuses.length > 0 ? 'completed' : 'running';
}

function taskUpdatedAt(task: RuntimeTaskProjection, fallback?: number): number | undefined {
  if (typeof task.updatedAt === 'number' && Number.isFinite(task.updatedAt)) return task.updatedAt;
  if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback;
  return undefined;
}

function shouldApplyTaskProjection(
  existing: RuntimeTaskProjection | undefined,
  incoming: RuntimeTaskProjection,
  eventTs?: number,
): boolean {
  if (!existing) return true;
  const existingUpdatedAt = taskUpdatedAt(existing);
  const incomingUpdatedAt = taskUpdatedAt(incoming, eventTs);
  if (existingUpdatedAt != null && incomingUpdatedAt != null && incomingUpdatedAt < existingUpdatedAt) return false;
  if (TERMINAL_TASK_STATUSES.has(existing.status) && !TERMINAL_TASK_STATUSES.has(incoming.status)) return false;
  return true;
}

function mergeTaskProjection(
  existing: RuntimeTaskProjection | undefined,
  incoming: RuntimeTaskProjection,
  eventTs?: number,
): RuntimeTaskProjection {
  const merged = { ...existing } as RuntimeTaskProjection;
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  merged.updatedAt = taskUpdatedAt(incoming, eventTs) ?? existing?.updatedAt;
  return merged;
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
  const lines = [meta || undefined, verification.detail, verification.evidence]
    .filter((line): line is string => typeof line === 'string' && line.trim().length > 0);
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

function sanitizeRuntimePlanSummary(summary: string | undefined): string | undefined {
  const text = normalizeText(summary);
  if (!text) return undefined;
  if (text === 'UClaw 已接管本轮任务。' || text === 'UClaw 已接管本轮任务执行。') return undefined;
  if (text === 'UClaw 已接管组合任务，将按顺序执行所有子任务并逐项交付产物。') {
    return '按顺序执行所有子任务并逐项交付产物。';
  }
  return text;
}

function runtimePlanDetail(objective: string | undefined, summary: string | undefined): string | undefined {
  const lines = [normalizeText(objective), sanitizeRuntimePlanSummary(summary)]
    .filter((line): line is string => typeof line === 'string' && line.length > 0);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

export function deriveRuntimeTaskSteps(runState: ChatRuntimeRunState | null | undefined): TaskStep[] {
  if (!runState) return [];

  const steps: TaskStep[] = [];
  const stepIndexById = new Map<string, number>();
  const toolStartedAt = new Map<string, number>();
  const failedToolStepIdsByFamily = new Map<string, Set<string>>();
  const taskProjections = new Map<string, RuntimeTaskProjection>();
  const elapsedMs = runElapsedMs(runState);
  const rebuildStepIndex = (): void => {
    stepIndexById.clear();
    steps.forEach((step, index) => stepIndexById.set(step.id, index));
  };
  const removeSteps = (predicate: (step: TaskStep) => boolean): void => {
    const retained = steps.filter((step) => !predicate(step));
    if (retained.length === steps.length) return;
    steps.splice(0, steps.length, ...retained);
    rebuildStepIndex();
  };
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
      durationMs: step.durationMs ?? existing.durationMs,
      url: step.url ?? existing.url,
    };
  };
  const refreshTaskFlow = (flowId: string | undefined): void => {
    if (!flowId) return;
    const flowStepId = runtimeTaskFlowStepId(flowId);
    upsertStep({
      id: flowStepId,
      label: 'Task Flow',
      status: aggregateTaskFlowStatus(steps, flowId),
      kind: 'system',
      runtimeKind: 'task-flow',
      detail: `flowId=${flowId}`,
      depth: 1,
      parentId: 'agent-run',
      flowId,
    });
  };
  const applyTaskProjection = (incoming: RuntimeTaskProjection, eventTs?: number): void => {
    const existingProjection = taskProjections.get(incoming.taskId);
    if (!shouldApplyTaskProjection(existingProjection, incoming, eventTs)) return;
    const task = mergeTaskProjection(existingProjection, incoming, eventTs);
    taskProjections.set(task.taskId, task);
    const flowStepId = task.flowId ? runtimeTaskFlowStepId(task.flowId) : undefined;
    if (task.flowId && flowStepId && !stepIndexById.has(flowStepId)) {
      upsertStep({
        id: flowStepId,
        label: 'Task Flow',
        status: 'running',
        kind: 'system',
        runtimeKind: 'task-flow',
        detail: `flowId=${task.flowId}`,
        depth: 1,
        parentId: 'agent-run',
        flowId: task.flowId,
      });
    }
    const taskStatus = runtimeTaskStatus(task);
    upsertStep({
      id: runtimeTaskStepId(task.taskId),
      label: task.title,
      status: taskStatus,
      kind: 'system',
      runtimeKind: task.kind ?? task.runtime,
      detail: task.detail,
      durationMs: task.startedAt != null && task.endedAt != null
        ? Math.max(0, task.endedAt - task.startedAt)
        : undefined,
      depth: task.parentTaskId ? (task.flowId ? 3 : 2) : (task.flowId ? 2 : 1),
      parentId: task.parentTaskId
        ? runtimeTaskStepId(task.parentTaskId)
        : flowStepId ?? 'agent-run',
      taskId: task.taskId,
      flowId: task.flowId,
    });
    refreshTaskFlow(task.flowId);
    if (!['pending', 'running', 'waiting_approval'].includes(task.status)) {
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        if (step.taskId !== task.taskId || step.id === runtimeTaskStepId(task.taskId)) continue;
        if (step.status !== 'running' && step.status !== 'blocked') continue;
        steps[index] = { ...step, status: taskStatus };
      }
    }
  };

  for (const event of runState.events) {
    switch (event.type) {
      case 'run.started':
        removeSteps((step) => step.id === 'gate-result'
          || step.id.startsWith('gate-issue:')
          || step.id.startsWith('checkpoint:'));
        break;
      case 'tool.started': {
        toolStartedAt.set(event.toolCallId, typeof event.ts === 'number' ? event.ts : Date.now());
        if (isFilteredExecutionGraphTool(event.name)) break;
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
      case 'run.plan.updated': {
        const visiblePlanSteps = event.steps.filter(isVisibleRuntimePlanStep);
        if (visiblePlanSteps.length === 0) break;
        upsertStep({
          id: 'run-plan',
          label: '计划',
          status: visiblePlanSteps.some((step) => step.status === 'running') ? 'running' : 'completed',
          kind: 'system',
          detail: runtimePlanDetail(event.objective, event.summary),
          depth: 1,
        });
        for (const planStep of visiblePlanSteps) {
          upsertStep({
            id: `plan-step:${planStep.id}`,
            label: planStep.title,
            status: runtimeStepStatus(planStep.status),
            kind: 'system',
            runtimeKind: typeof planStep.kind === 'string' ? planStep.kind : undefined,
            detail: planStep.detail,
            durationMs: planStep.durationMs,
            depth: planStep.parentId ? 2 : 1,
            parentId: planStep.parentId ? `plan-step:${planStep.parentId}` : 'run-plan',
          });
        }
        break;
      }
      case 'run.step.updated': {
        if (!isVisibleRuntimePlanStep(event.step)) break;
        if (event.step.taskId && taskProjections.has(event.step.taskId)) {
          // task.updated is the authoritative task-ledger projection. The
          // companion plan step must not flatten its Task Flow topology or
          // regress its terminal/cancellation state.
          break;
        }
        const isTaskProjection = Boolean(event.step.taskId);
        const existingIndex = event.step.taskId
          ? stepIndexById.get(runtimeTaskStepId(event.step.taskId))
          : undefined;
        const existingStatus = existingIndex != null ? steps[existingIndex]?.status : undefined;
        const incomingStatus = runtimeStepStatus(event.step.status);
        const status = existingStatus && TERMINAL_STEP_STATUSES.has(existingStatus)
          && !TERMINAL_STEP_STATUSES.has(incomingStatus)
          ? existingStatus
          : incomingStatus;
        upsertStep({
          id: isTaskProjection && event.step.taskId
            ? runtimeTaskStepId(event.step.taskId)
            : `plan-step:${event.step.id}`,
          label: event.step.title,
          status,
          kind: 'system',
          runtimeKind: typeof event.step.kind === 'string' ? event.step.kind : undefined,
          detail: event.step.detail,
          durationMs: event.step.durationMs,
          depth: event.step.parentId ? 2 : 1,
          parentId: event.step.parentId
            ? `plan-step:${event.step.parentId}`
            : isTaskProjection
              ? 'agent-run'
              : 'run-plan',
          taskId: event.step.taskId,
        });
        break;
      }
      case 'task.updated':
        applyTaskProjection(event.task, event.ts);
        break;
      case 'tool.updated':
        if (!isFilteredExecutionGraphTool(event.name)) {
          upsertStep({
            id: event.toolCallId,
            label: event.name,
            status: 'running',
            kind: 'tool',
            detail: runtimeDetail(event.partialResult),
            depth: 1,
          });
        }
        break;
      case 'tool.completed': {
        if (isFilteredExecutionGraphTool(event.name)) break;
        const existingIndex = stepIndexById.get(event.toolCallId);
        const previousDetail = existingIndex != null ? steps[existingIndex]?.detail : undefined;
        const startedAt = toolStartedAt.get(event.toolCallId);
        const completedAt = typeof event.ts === 'number' ? event.ts : Date.now();
        const inferredDurationMs = startedAt != null && completedAt >= startedAt ? completedAt - startedAt : undefined;
        const normalizedToolName = event.name.trim().toLowerCase();
        const recoveryFamily = normalizedToolName === 'create_designed_pptx_file' || normalizedToolName === 'repair_designed_pptx_file'
          ? 'designed_pptx_file'
          : normalizedToolName;
        const nextDetail = event.isError
          ? getToolErrorDetail(event.result)
          : normalizedToolName === 'exec'
            ? previousDetail ?? runtimeDetail(event.result)
            : runtimeDetail(event.result) ?? previousDetail;
        upsertStep({
          id: event.toolCallId,
          label: event.name,
          status: event.isError ? 'error' : 'completed',
          kind: 'tool',
          detail: nextDetail,
          durationMs: event.durationMs ?? inferredDurationMs,
          depth: 1,
        });
        if (event.isError) {
          const failedIds = failedToolStepIdsByFamily.get(recoveryFamily) ?? new Set<string>();
          failedIds.add(event.toolCallId);
          failedToolStepIdsByFamily.set(recoveryFamily, failedIds);
        } else {
          for (const failedId of failedToolStepIdsByFamily.get(recoveryFamily) ?? []) {
            const failedIndex = stepIndexById.get(failedId);
            if (failedIndex == null || !steps[failedIndex]) continue;
            steps[failedIndex] = {
              ...steps[failedIndex],
              status: 'completed',
              detail: recoveryFamily === 'designed_pptx_file'
                ? '版式问题已由增量修复恢复，并通过完整质量检查。'
                : '后续重试已恢复该步骤。',
            };
          }
          failedToolStepIdsByFamily.delete(recoveryFamily);
        }
        break;
      }
      case 'artifact.produced': {
        const parentTaskId = event.artifact.taskId ?? event.taskId;
        upsertStep({
          id: `artifact:${event.artifact.id}`,
          label: event.artifact.title || event.artifact.kind || 'Artifact',
          status: 'completed',
          kind: 'system',
          detail: artifactDetail(event.artifact),
          depth: parentTaskId ? 2 : 1,
          parentId: parentTaskId ? runtimeTaskStepId(parentTaskId) : 'agent-run',
          taskId: parentTaskId,
        });
        break;
      }
      case 'verification.completed': {
        const parentTaskId = event.verification.taskId ?? event.taskId;
        upsertStep({
          id: `verification:${event.verification.id}`,
          label: event.verification.title || 'Verification',
          status: runtimeStepStatus(event.verification.status),
          kind: 'system',
          detail: verificationDetail(event.verification),
          depth: event.verification.artifactId || parentTaskId ? 2 : 1,
          parentId: event.verification.artifactId
            ? `artifact:${event.verification.artifactId}`
            : parentTaskId
              ? runtimeTaskStepId(parentTaskId)
              : 'agent-run',
          taskId: parentTaskId,
        });
        break;
      }
      case 'gate.issue': {
        const issueTaskId = event.issue.code.startsWith('task.') ? event.issue.targetId : undefined;
        upsertStep({
          id: `gate-issue:${event.issue.id}`,
          label: event.issue.title,
          status: gateIssueStatus(event.issue),
          kind: 'system',
          detail: gateIssueDetail(event.issue),
          depth: 2,
          parentId: 'gate-result',
          taskId: issueTaskId,
        });
        break;
      }
      case 'run.checkpoint': {
        const parentTaskId = event.checkpoint.taskId ?? event.taskId;
        upsertStep({
          id: `checkpoint:${event.checkpoint.id}`,
          label: 'Checkpoint',
          status: checkpointStatus(event.checkpoint),
          kind: 'message',
          detail: checkpointDetail(event.checkpoint),
          depth: parentTaskId ? 2 : 1,
          parentId: parentTaskId ? runtimeTaskStepId(parentTaskId) : 'agent-run',
          taskId: parentTaskId,
        });
        break;
      }
      case 'gate.evaluated': {
        const currentIssueIds = new Set(event.gate.issues.map((issue) => `gate-issue:${issue.id}`));
        for (let index = 0; index < steps.length; index += 1) {
          const step = steps[index];
          if (!step.id.startsWith('gate-issue:') || currentIssueIds.has(step.id)) continue;
          if (step.status === 'running' || step.status === 'blocked' || step.status === 'error') {
            steps[index] = { ...step, status: 'completed', detail: step.detail ?? '已解决' };
          }
        }
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
        if (isFilteredExecutionGraphTool(event.name)) break;
        const id = event.itemId || `${event.toolCallId || event.name || 'command'}:output`;
        const statusMarker = event.status?.trim().toLowerCase();
        upsertStep({
          id,
          label: event.title || `${event.name || 'Command'} output`,
          status: statusMarker && CANCELLATION_MARKERS.has(statusMarker)
            ? 'aborted'
            : statusMarker === 'failed' || statusMarker === 'error'
              ? 'error'
              : event.phase === 'end'
                ? 'completed'
                : 'running',
          kind: 'message',
          detail: runtimeDetail(event.output),
          durationMs: event.durationMs,
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
        const parentTaskId = event.taskId;
        const id = `approval:${event.itemId || event.toolCallId || parentTaskId || 'runtime'}`;
        const approvalStatus = event.status?.trim().toLowerCase();
        const approvalPhase = event.phase?.trim().toLowerCase();
        upsertStep({
          id,
          label: event.title || 'Approval',
          status: approvalStatus && CANCELLATION_MARKERS.has(approvalStatus)
            ? 'aborted'
            : approvalStatus === 'denied' || approvalStatus === 'failed'
              ? 'error'
              : approvalPhase === 'resolved' || approvalStatus === 'approved' || approvalStatus === 'completed'
                ? 'completed'
                : 'blocked',
          kind: 'system',
          detail: runtimeDetail(event.message),
          depth: parentTaskId ? 2 : 1,
          parentId: parentTaskId ? runtimeTaskStepId(parentTaskId) : 'agent-run',
          taskId: parentTaskId,
        });
        break;
      }
      default:
        break;
    }
  }

  // The store's accepted projections have already applied updatedAt ordering
  // and terminal monotonicity. Re-applying them last makes replayed raw events
  // unable to regress the visible task state.
  for (const task of runState.tasks ?? []) applyTaskProjection(task, task.updatedAt);

  const shouldShowElapsed = elapsedMs !== undefined
    && steps.length > 0
    && (runState.status !== 'running' || elapsedMs >= 1000);
  const elapsedLabel = formatDuration(elapsedMs);
  const visibleSteps = shouldShowElapsed
    ? [{
      id: 'run-duration',
      label: '整体耗时',
      status: runState.status === 'running' ? 'running' : runtimeStepStatus(runState.status),
      kind: 'system' as const,
      detail: elapsedLabel ? `耗时：${elapsedLabel}` : undefined,
      durationMs: elapsedMs,
      depth: 1,
    }, ...steps]
    : steps;

  return attachTopology(visibleSteps);
}
