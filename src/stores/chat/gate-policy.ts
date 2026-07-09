import type {
  ChatRuntimeEvent,
  ChatRuntimeGateDecision,
  ChatRuntimeGateIssue,
  ChatRuntimePlanStep,
} from '../../../shared/chat-runtime-events';
import { isArtifactCapabilityQuestion } from '../../../shared/artifact-intent';
import type { ChatRuntimeRunState } from './types';

export type CompletionGateReport = {
  artifactCount: number;
  missingRequiredArtifactCount: number;
  missingVerificationCount: number;
  blockedVerificationCount: number;
  failedStepCount: number;
  runningStepCount: number;
  blockingCheckpointCount: number;
  blockingIssueCount: number;
  warningIssueCount: number;
  requiredVerificationCount: number;
  passedRequiredVerificationCount: number;
  verificationCoverage: number;
  hasBlockingIssues: boolean;
  reasons: string[];
  issues: ChatRuntimeGateIssue[];
};

const ARTIFACT_OBJECTIVE_RE = /(?:生成|创建|制作|导出|输出|保存|下载|写一份|做一份|做个|图片|图像|海报|视频|PPT|pptx?|Word|docx?|Excel|xlsx?|PDF|pdf|文档|报告|表格|网页|HTML|html|代码文件|压缩包|截图|create|make|generate|export|produce|save|download|image|video|document|report|presentation|spreadsheet|file|archive|screenshot)/iu;
const EXECUTE_STEP_ARTIFACT_RE = /(?:图片|视频|产物|文件|文档|报告|导出|生成)/iu;

export type ArtifactRequiredPlanStep = ChatRuntimePlanStep & {
  requiresArtifact?: boolean;
  requiredArtifact?: boolean;
  artifactRequired?: boolean;
  outputArtifactRequired?: boolean;
};

function planStepRequiresArtifact(step: ChatRuntimePlanStep): boolean {
  const record = step as ArtifactRequiredPlanStep;
  return record.requiresArtifact === true
    || record.requiredArtifact === true
    || record.artifactRequired === true
    || record.outputArtifactRequired === true;
}

export function artifactRequiredPlanSteps(run: ChatRuntimeRunState | undefined): ArtifactRequiredPlanStep[] {
  return (run?.planSteps ?? []).filter(planStepRequiresArtifact) as ArtifactRequiredPlanStep[];
}

export function gateIssueId(runId: string | undefined, code: string, target: string, index = 0): string {
  let hash = 2166136261;
  const value = `${target}:${index}`;
  for (let offset = 0; offset < value.length; offset += 1) {
    hash ^= value.charCodeAt(offset);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `gate:${runId ?? 'run'}:${code}:${hash.toString(36)}`;
}

export function runRequiresArtifact(run: ChatRuntimeRunState | undefined): boolean {
  if (!run) return false;
  const objective = `${run.objective ?? ''}\n${run.events
    .filter((event) => event.type === 'run.started' || event.type === 'run.plan.updated')
    .map((event) => {
      if (event.type === 'run.started') return event.objective ?? '';
      return `${event.objective ?? ''}\n${event.summary ?? ''}`;
    })
    .join('\n')}`;
  if (isArtifactCapabilityQuestion(objective)) return false;
  if (artifactRequiredPlanSteps(run).length > 0) return true;
  if ((run.artifacts ?? []).length > 0) return false;
  if ((run.planSteps ?? []).some((step) => {
    const stepText = `${step.title}\n${step.detail ?? ''}`;
    return step.id === 'uclaw.execute'
      && EXECUTE_STEP_ARTIFACT_RE.test(stepText)
      && !isArtifactCapabilityQuestion(stepText);
  })) {
    return true;
  }
  return ARTIFACT_OBJECTIVE_RE.test(objective);
}

export function summarizeCompletionGateReport(report: CompletionGateReport): string | undefined {
  if (report.issues.length === 0) return undefined;
  const blocking = report.issues.filter((issue) => issue.severity === 'blocking');
  const warning = report.issues.filter((issue) => issue.severity === 'warning');
  const groups = [
    blocking.length > 0 ? `阻断项 ${blocking.length} 个：${blocking.map((issue) => issue.title).join('；')}` : undefined,
    warning.length > 0 ? `提醒项 ${warning.length} 个：${warning.map((issue) => issue.title).join('；')}` : undefined,
  ].filter((item): item is string => Boolean(item));
  return groups.join('；') || report.reasons.join('；') || undefined;
}

export function gateDecisionForReport(
  status: Extract<ChatRuntimeEvent, { type: 'run.ended' }>['status'],
  report: CompletionGateReport,
): ChatRuntimeGateDecision {
  if (status === 'aborted') return 'aborted';
  if (status === 'error') return 'failed';
  if (!report.hasBlockingIssues) return 'deliverable';
  if (report.issues.some((issue) => issue.severity === 'blocking' && issue.recoverable === false)) {
    return 'blocked_needs_user';
  }
  return 'continue_required';
}

export function buildTerminalGateReport(params: {
  runId: string;
  status: Extract<ChatRuntimeEvent, { type: 'run.ended' }>['status'];
  error?: string;
}): CompletionGateReport {
  const issue: ChatRuntimeGateIssue = {
    id: gateIssueId(params.runId, params.status === 'aborted' ? 'run.aborted' : 'run.failed', params.runId),
    code: params.status === 'aborted' ? 'run.aborted' : 'run.failed',
    severity: 'blocking',
    title: params.status === 'aborted' ? '任务已停止' : '任务执行失败',
    detail: params.error,
    targetId: params.runId,
    recoverable: params.status === 'aborted',
  };
  return {
    artifactCount: 0,
    missingRequiredArtifactCount: 0,
    missingVerificationCount: 0,
    blockedVerificationCount: 0,
    failedStepCount: params.status === 'aborted' ? 0 : 1,
    runningStepCount: 0,
    blockingCheckpointCount: 0,
    blockingIssueCount: 1,
    warningIssueCount: 0,
    requiredVerificationCount: 0,
    passedRequiredVerificationCount: 0,
    verificationCoverage: 1,
    hasBlockingIssues: true,
    reasons: [params.status === 'aborted' ? '任务已停止' : '任务执行失败'],
    issues: [issue],
  };
}
