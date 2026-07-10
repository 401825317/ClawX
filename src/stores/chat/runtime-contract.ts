import type {
  ChatRuntimeArtifact,
  ChatRuntimeEvent,
  ChatRuntimeEventProducer,
  ChatRuntimeGateIssue,
  ChatRuntimePlanStep,
  ChatRuntimeVerification,
} from '../../../shared/chat-runtime-events';
import { CHAT_RUNTIME_CONTRACT_VERSION } from '../../../shared/chat-runtime-events';
import type { AttachedFileMeta, ChatRuntimeRunState, ChatSendMode } from './types';
import {
  type CompletionGateReport,
  artifactRequiredPlanSteps,
  buildTerminalGateReport,
  gateDecisionForReport,
  gateIssueId,
  runRequiresArtifact,
  summarizeCompletionGateReport,
} from './gate-policy';

type RuntimeContractBase = {
  runId: string;
  sessionKey?: string;
  ts?: number;
  producer?: ChatRuntimeEventProducer;
};

type RuntimeArtifactVerificationInput = {
  artifact: ChatRuntimeArtifact;
  status: ChatRuntimeVerification['status'];
  kind?: ChatRuntimeVerification['kind'];
  required?: boolean;
  severity?: ChatRuntimeVerification['severity'];
  detail?: string;
  evidence?: string;
};

const RUNTIME_PLAN_STEP_IDS = {
  objective: 'uclaw.objective',
  execute: 'uclaw.execute',
  verify: 'uclaw.verify',
  deliver: 'uclaw.deliver',
} as const;

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

function normalizeText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function artifactDedupeKey(file: AttachedFileMeta): string {
  return file.filePath?.trim()
    || file.gatewayUrl?.trim()
    || `${file.fileName}|${file.mimeType}|${file.fileSize}|${file.preview ?? ''}`;
}

function inferArtifactKind(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType === 'text/csv') return 'spreadsheet';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'presentation';
  if (mimeType.includes('wordprocessing') || mimeType.includes('msword') || mimeType === 'text/markdown') return 'document';
  if (mimeType === 'application/x-directory') return 'directory';
  return 'file';
}

function modeExecutionTitle(mode: ChatSendMode | undefined): string {
  if (mode === 'image') return '执行图片任务';
  if (mode === 'video') return '执行视频任务';
  return '执行任务';
}

function buildBase(
  base: RuntimeContractBase,
): Pick<ChatRuntimeEvent, 'contractVersion' | 'producer' | 'runId' | 'sessionKey' | 'ts'> {
  return {
    contractVersion: CHAT_RUNTIME_CONTRACT_VERSION,
    producer: base.producer ?? 'renderer',
    runId: base.runId,
    sessionKey: base.sessionKey,
    ts: base.ts ?? Date.now(),
  };
}

function isBuiltInGateStep(stepId: string): boolean {
  return Object.values(RUNTIME_PLAN_STEP_IDS).includes(stepId as typeof RUNTIME_PLAN_STEP_IDS[keyof typeof RUNTIME_PLAN_STEP_IDS]);
}

function completionGateStatus(report: CompletionGateReport): ChatRuntimePlanStep['status'] {
  if (report.failedStepCount > 0 || report.blockingCheckpointCount > 0) return 'error';
  if (report.blockingIssueCount > 0) return 'blocked';
  return 'completed';
}

function artifactLabel(artifact: ChatRuntimeArtifact): string {
  return artifact.title || artifact.filePath || artifact.url || artifact.id;
}

function verificationLabel(verification: ChatRuntimeVerification): string {
  return verification.title || verification.artifactId || verification.targetId || verification.id;
}

function stepIdEquals(value: string | undefined, stepId: string | undefined): boolean {
  const normalizedValue = normalizeText(value);
  const normalizedStepId = normalizeText(stepId);
  return Boolean(normalizedValue && normalizedStepId && normalizedValue === normalizedStepId);
}

function artifactMatchesRequiredStep(artifact: ChatRuntimeArtifact, step: ChatRuntimePlanStep): boolean {
  const structuredStepId = normalizeText(artifact.stepId);
  if (structuredStepId) return stepIdEquals(structuredStepId, step.id);
  if (stepIdEquals(artifact.sourceToolCallId, step.id)) return true;
  const haystack = [
    artifact.id,
    artifact.title,
    artifact.filePath,
    artifact.url,
    artifact.source,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .toLowerCase();
  return Boolean(step.id && haystack.includes(step.id.toLowerCase()));
}

function missingArtifactRequiredSteps(
  steps: ChatRuntimePlanStep[],
  artifacts: ChatRuntimeArtifact[],
): ChatRuntimePlanStep[] {
  if (steps.length === 0) return [];
  const unmatchedArtifacts = [...artifacts];
  const missing: ChatRuntimePlanStep[] = [];

  for (const step of steps) {
    const matchedIndex = unmatchedArtifacts.findIndex((artifact) => artifactMatchesRequiredStep(artifact, step));
    if (matchedIndex !== -1) {
      unmatchedArtifacts.splice(matchedIndex, 1);
      continue;
    }
    missing.push(step);
  }

  return missing;
}

function requiredVerificationFailed(verification: ChatRuntimeVerification): boolean {
  if (verification.required === false) return false;
  return verification.status === 'blocked' || verification.status === 'failed' || verification.status === 'skipped';
}

function runtimeEventDetail(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (value == null) return undefined;
  try {
    const rendered = JSON.stringify(value, null, 2);
    return rendered.length > 1000 ? `${rendered.slice(0, 1000)}...` : rendered;
  } catch {
    return String(value);
  }
}

function dedupeGateIssues(issues: ChatRuntimeGateIssue[]): ChatRuntimeGateIssue[] {
  const seen = new Set<string>();
  const deduped: ChatRuntimeGateIssue[] = [];
  for (const issue of issues) {
    const key = issue.id || `${issue.code}:${issue.targetId ?? ''}:${issue.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
  }
  return deduped;
}

function commandOutputFailed(event: ChatRuntimeEvent): event is Extract<ChatRuntimeEvent, { type: 'command.output' }> {
  if (event.type !== 'command.output') return false;
  if (event.status === 'failed' || event.status === 'error') return true;
  return typeof event.exitCode === 'number' && event.exitCode !== 0;
}

function approvalFailed(event: ChatRuntimeEvent): event is Extract<ChatRuntimeEvent, { type: 'approval.updated' }> {
  if (event.type !== 'approval.updated') return false;
  return event.status === 'denied'
    || event.status === 'rejected'
    || event.status === 'failed'
    || event.status === 'error';
}

function isMediaObservationStep(step: ChatRuntimePlanStep): boolean {
  return typeof step.kind === 'string' && step.kind.trim().toLowerCase().startsWith('media.');
}

const ACTIONABLE_OBJECTIVE_RE = /(?:打开|启动|播放|发送|查找|搜索|运行|执行|尝试|点开|操作|打开.*并|帮我.*(?:打开|启动|播放|发送|查找|搜索|运行|执行)|open|launch|play|send|search|find|run|execute|click|operate)/iu;

function runNeedsConcreteAttempt(run: ChatRuntimeRunState | undefined): boolean {
  const objective = normalizeText(run?.objective);
  if (!objective) return false;
  return ACTIONABLE_OBJECTIVE_RE.test(objective);
}

function runHasConcreteExecutionEvidence(run: ChatRuntimeRunState | undefined): boolean {
  return (run?.events ?? []).some((event) =>
    event.type === 'tool.started'
    || event.type === 'tool.completed'
    || event.type === 'command.output'
    || event.type === 'patch.completed'
    || event.type === 'artifact.produced'
    || event.type === 'approval.updated',
  );
}

export function buildRuntimeCompletionGateReport(
  run: ChatRuntimeRunState | undefined,
  pendingVerifications: ChatRuntimeVerification[] = [],
): CompletionGateReport {
  const artifacts = run?.artifacts ?? [];
  const verifications = [...(run?.verifications ?? []), ...pendingVerifications];
  const steps = run?.planSteps ?? [];
  const checkpoints = run?.checkpoints ?? [];

  const issues: ChatRuntimeGateIssue[] = [];
  const artifactRequiredSteps = artifactRequiredPlanSteps(run);
  const missingArtifactSteps = missingArtifactRequiredSteps(artifactRequiredSteps, artifacts);
  const verifiedArtifactIds = new Set(
    verifications
      .filter((verification) => verification.artifactId && verification.required !== false && verification.status === 'passed')
      .map((verification) => verification.artifactId as string),
  );

  if (artifactRequiredSteps.length === 0 && runRequiresArtifact(run) && artifacts.length === 0) {
    issues.push({
      id: gateIssueId(run?.runId, 'artifact.required.missing', run?.objective ?? run?.runId ?? 'objective'),
      code: 'artifact.required.missing',
      severity: 'blocking',
      title: '任务需要产物，但没有产生产物',
      detail: '用户目标需要图片、视频、文档、表格、代码文件或其他可交付产物，但运行事实中没有 artifact.produced 事件。',
      targetId: run?.runId,
      recoverable: true,
      suggestedRecovery: '继续执行实际生成步骤，并在最终回复前落地 artifact.produced 与 verification.completed。',
    });
  }

  if (runNeedsConcreteAttempt(run) && !runHasConcreteExecutionEvidence(run) && artifacts.length === 0) {
    issues.push({
      id: gateIssueId(run?.runId, 'execution.unattempted', run?.objective ?? run?.runId ?? 'objective'),
      code: 'execution.unattempted',
      severity: 'blocking',
      title: '当前回复还没有进入实际执行',
      detail: '用户请求已经明确要求执行动作，但本轮运行里没有看到实际工具调用、命令执行、文件修改或产物落地。',
      targetId: run?.runId,
      recoverable: true,
      suggestedRecovery: '不要只停在能力说明或下一步建议，先沿当前可行路径执行一轮，再交付结果。',
    });
  }

  for (const [index, step] of missingArtifactSteps.entries()) {
    issues.push({
      id: gateIssueId(run?.runId, 'artifact.required.missing', step.id, index),
      code: 'artifact.required.missing',
      severity: 'blocking',
      title: `${step.title} 缺少必需产物`,
      detail: 'composite plan 中该子任务标记了 requiresArtifact，但运行事实中没有足够的 artifact.produced 与之对应。',
      stepId: step.id,
      targetId: step.id,
      recoverable: true,
      suggestedRecovery: '继续执行该子任务，产出 artifact.produced，并补齐对应 verification.completed。',
    });
  }

  for (const [index, artifact] of artifacts.entries()) {
    if (verifications.some((verification) => verification.artifactId === artifact.id && verification.required !== false)) continue;
    issues.push({
      id: gateIssueId(run?.runId, 'artifact.verification.missing', artifact.id, index),
      code: 'artifact.verification.missing',
      severity: 'blocking',
      title: `${artifactLabel(artifact)} 缺少产物验证`,
      detail: '产物已经进入执行上下文，但最终交付前没有对应 verification.completed 事件。',
      artifactId: artifact.id,
      targetId: artifact.id,
      recoverable: true,
    });
  }

  for (const [index, verification] of verifications.entries()) {
    if (!requiredVerificationFailed(verification)) continue;
    const targetId = verification.artifactId ?? verification.targetId ?? verification.kind ?? verification.id;
    issues.push({
      id: gateIssueId(run?.runId, 'verification.required.failed', verification.id, index),
      code: 'verification.required.failed',
      severity: verification.severity === 'warning' ? 'warning' : 'blocking',
      title: `${verificationLabel(verification)} 未通过`,
      detail: verification.detail ?? verification.evidence,
      artifactId: verification.artifactId,
      targetId,
      verificationId: verification.id,
      recoverable: true,
    });
  }

  for (const [index, step] of steps.entries()) {
    if (isBuiltInGateStep(step.id)) continue;
    if (isMediaObservationStep(step)) continue;
    if (step.status === 'error' || step.status === 'blocked') {
      issues.push({
        id: gateIssueId(run?.runId, 'step.failed', step.id, index),
        code: 'step.failed',
        severity: 'blocking',
        title: `${step.title} 失败或阻塞`,
        detail: step.detail,
        stepId: step.id,
        targetId: step.id,
        recoverable: step.status !== 'error',
      });
    }
    if (step.status === 'running' || step.status === 'pending') {
      issues.push({
        id: gateIssueId(run?.runId, 'step.unfinished', step.id, index),
        code: 'step.unfinished',
        severity: 'blocking',
        title: `${step.title} 尚未结束`,
        detail: step.detail,
        stepId: step.id,
        targetId: step.id,
        recoverable: true,
      });
    }
  }

  for (const [index, checkpoint] of checkpoints.entries()) {
    if (checkpoint.recoverable !== false) continue;
    issues.push({
      id: gateIssueId(run?.runId, 'checkpoint.nonrecoverable', checkpoint.id, index),
      code: 'checkpoint.nonrecoverable',
      severity: 'blocking',
      title: checkpoint.summary || '存在不可恢复 checkpoint',
      detail: checkpoint.reason,
      targetId: checkpoint.id,
      recoverable: false,
    });
  }

  for (const [index, event] of (run?.events ?? []).entries()) {
    if (event.type === 'tool.completed' && event.isError) {
      issues.push({
        id: gateIssueId(run?.runId, 'tool.failed', event.toolCallId, index),
        code: 'tool.failed',
        severity: 'blocking',
        title: `${event.name} 工具执行失败`,
        detail: runtimeEventDetail(event.result) ?? runtimeEventDetail(event.meta),
        targetId: event.toolCallId,
        stepId: event.toolCallId,
        recoverable: true,
      });
    }

    if (commandOutputFailed(event)) {
      const targetId = event.itemId || event.toolCallId || event.name || `command-${index}`;
      issues.push({
        id: gateIssueId(run?.runId, 'command.failed', targetId, index),
        code: 'command.failed',
        severity: 'blocking',
        title: `${event.title || event.name || '命令'} 执行失败`,
        detail: runtimeEventDetail(event.output) ?? (typeof event.exitCode === 'number' ? `exitCode=${event.exitCode}` : undefined),
        targetId,
        stepId: event.toolCallId,
        recoverable: true,
      });
    }

    if (approvalFailed(event)) {
      const targetId = event.itemId || event.toolCallId || `approval-${index}`;
      issues.push({
        id: gateIssueId(run?.runId, 'approval.denied', targetId, index),
        code: 'approval.denied',
        severity: 'blocking',
        title: event.title || '审批未通过',
        detail: event.message,
        targetId,
        stepId: event.toolCallId,
        recoverable: false,
        suggestedRecovery: '需要用户重新确认授权或调整执行方式。',
      });
    }
  }

  const uniqueIssues = dedupeGateIssues(issues);
  const requiredVerificationCount = verifications.filter((verification) => verification.required !== false).length;
  const passedRequiredVerificationCount = verifications.filter((verification) =>
    verification.required !== false && verification.status === 'passed',
  ).length;
  const missingRequiredArtifactCount = uniqueIssues.filter((issue) => issue.code === 'artifact.required.missing').length;
  const missingVerificationCount = uniqueIssues.filter((issue) => issue.code === 'artifact.verification.missing').length;
  const blockedVerificationCount = uniqueIssues.filter((issue) => issue.code === 'verification.required.failed' && issue.severity === 'blocking').length;
  const failedStepCount = uniqueIssues.filter((issue) => issue.code === 'step.failed' || issue.code === 'tool.failed' || issue.code === 'command.failed' || issue.code === 'approval.denied').length;
  const runningStepCount = uniqueIssues.filter((issue) => issue.code === 'step.unfinished').length;
  const blockingCheckpointCount = uniqueIssues.filter((issue) => issue.code === 'checkpoint.nonrecoverable').length;
  const blockingIssueCount = uniqueIssues.filter((issue) => issue.severity === 'blocking').length;
  const warningIssueCount = uniqueIssues.filter((issue) => issue.severity === 'warning').length;

  const reasons = [
    missingRequiredArtifactCount > 0 ? '任务需要产物但没有产生产物' : undefined,
    uniqueIssues.some((issue) => issue.code === 'execution.unattempted') ? '任务还没有进入实际执行' : undefined,
    missingVerificationCount > 0 ? `${missingVerificationCount} 个产物缺少验证结果` : undefined,
    blockedVerificationCount > 0 ? `${blockedVerificationCount} 个产物验证未通过` : undefined,
    failedStepCount > 0 ? `${failedStepCount} 个执行步骤失败或阻塞` : undefined,
    runningStepCount > 0 ? `${runningStepCount} 个执行步骤仍未结束` : undefined,
    blockingCheckpointCount > 0 ? `${blockingCheckpointCount} 个不可恢复 checkpoint` : undefined,
  ].filter((reason): reason is string => Boolean(reason));

  return {
    artifactCount: artifacts.length,
    missingRequiredArtifactCount,
    missingVerificationCount,
    blockedVerificationCount,
    failedStepCount,
    runningStepCount,
    blockingCheckpointCount,
    blockingIssueCount,
    warningIssueCount,
    requiredVerificationCount,
    passedRequiredVerificationCount,
    verificationCoverage: artifacts.length === 0 ? (missingRequiredArtifactCount > 0 ? 0 : 1) : verifiedArtifactIds.size / artifacts.length,
    hasBlockingIssues: blockingIssueCount > 0,
    reasons,
    issues: uniqueIssues,
  };
}

export function buildRuntimeStartContractEvents(
  run: ChatRuntimeRunState | undefined,
  base: RuntimeContractBase & {
    objective?: string;
    mode?: ChatSendMode;
    includeStarted?: boolean;
  },
): ChatRuntimeEvent[] {
  const runBase = buildBase(base);
  const objective = normalizeText(base.objective) ?? run?.objective;
  const events: ChatRuntimeEvent[] = [];

  const hasStarted = run?.events.some((event) => event.type === 'run.started') === true;
  if (base.includeStarted !== false && !hasStarted) {
    events.push({
      ...runBase,
      type: 'run.started',
      startedAt: run?.startedAt ?? runBase.ts,
      objective,
    });
  }

  const hasPlan = (run?.planSteps?.length ?? 0) > 0
    || run?.events.some((event) => event.type === 'run.plan.updated') === true;
  if (!hasPlan) {
    events.push({
      ...runBase,
      type: 'run.plan.updated',
      objective,
      summary: objective ? 'UClaw 已接管本轮任务执行。' : 'UClaw 已接管本轮任务。',
      steps: [
        {
          id: RUNTIME_PLAN_STEP_IDS.objective,
          title: '理解目标',
          status: 'completed',
          detail: objective,
          kind: 'objective',
          order: 0,
        },
        {
          id: RUNTIME_PLAN_STEP_IDS.execute,
          title: modeExecutionTitle(base.mode),
          status: 'running',
          kind: 'execution',
          order: 1,
        },
        {
          id: RUNTIME_PLAN_STEP_IDS.verify,
          title: '验证结果',
          status: 'pending',
          kind: 'verification',
          order: 2,
        },
        {
          id: RUNTIME_PLAN_STEP_IDS.deliver,
          title: '交付回复',
          status: 'pending',
          kind: 'delivery',
          order: 3,
        },
      ],
    });
  }

  return events;
}

export function buildRuntimeArtifactEventsFromAttachedFiles(
  base: RuntimeContractBase & {
    toolCallId?: string;
    itemId?: string;
    stepId?: string;
    verificationDetail?: string;
  },
  files: AttachedFileMeta[],
): ChatRuntimeEvent[] {
  const runBase = buildBase(base);
  const seen = new Set<string>();
  const events: ChatRuntimeEvent[] = [];

  for (const file of files) {
    const key = artifactDedupeKey(file);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const filePath = normalizeText(file.filePath);
    const gatewayUrl = normalizeText(file.gatewayUrl);
    const previewUrl = file.preview && /^https?:\/\//i.test(file.preview) ? file.preview : undefined;
    if (!filePath && !gatewayUrl && !previewUrl) continue;

    const artifact: ChatRuntimeArtifact = {
      id: `artifact:${hashString(key)}`,
      kind: inferArtifactKind(file.mimeType),
      title: normalizeText(file.fileName),
      filePath,
      url: gatewayUrl ?? previewUrl,
      mimeType: normalizeText(file.mimeType),
      sizeBytes: file.fileSize > 0 ? file.fileSize : undefined,
      stepId: normalizeText(base.stepId),
      sourceToolCallId: normalizeText(base.toolCallId),
    };

    events.push({
      ...runBase,
      type: 'artifact.produced',
      artifact,
      toolCallId: base.toolCallId,
      itemId: base.itemId,
    });

    const hasRegisteredEvidence = file.fileSize > 0 || Boolean(file.preview) || Boolean(file.gatewayUrl) || Boolean(filePath);
    events.push(buildRuntimeArtifactVerificationEvent(runBase, {
      artifact,
      status: hasRegisteredEvidence ? 'passed' : 'blocked',
      kind: 'artifact.registration',
      required: false,
      severity: 'info',
      detail: hasRegisteredEvidence
        ? (base.verificationDetail ?? '产物已进入 UClaw 的消息产物卡片，等待本地可用性验证。')
        : '已识别产物路径，等待本地可用性验证。',
      evidence: file.fileSize > 0
        ? `sizeBytes=${file.fileSize}`
        : file.gatewayUrl
          ? 'gateway media url registered'
          : file.preview
            ? 'preview metadata registered'
            : filePath
              ? `filePath=${filePath}`
            : undefined,
    }));
  }

  return events;
}

export function buildRuntimeArtifactVerificationEvent(
  base: RuntimeContractBase,
  input: RuntimeArtifactVerificationInput,
): Extract<ChatRuntimeEvent, { type: 'verification.completed' }> {
  const runBase = buildBase(base);
  const kind = input.kind ?? 'artifact.availability';
  const suffix = kind === 'artifact.availability'
    ? 'availability'
    : kind.replace(/[^a-z0-9._-]+/gi, '-');
  return {
    ...runBase,
    type: 'verification.completed',
    verification: {
      id: `verification:${input.artifact.id}:${suffix}`,
      status: input.status,
      kind,
      required: input.required ?? true,
      severity: input.severity ?? (input.status === 'passed' ? 'info' : 'blocking'),
      title: input.artifact.title ? `验证 ${input.artifact.title}` : '验证产物',
      detail: input.detail,
      targetId: input.artifact.id,
      artifactId: input.artifact.id,
      evidence: input.evidence,
      source: input.artifact.source ?? runBase.producer,
    },
  };
}

export function buildRuntimeCheckpointEvent(
  base: RuntimeContractBase & {
    id: string;
    summary: string;
    reason?: string;
    recoverable?: boolean;
    issues?: ChatRuntimeGateIssue[];
  },
): Extract<ChatRuntimeEvent, { type: 'run.checkpoint' }> {
  return {
    ...buildBase(base),
    type: 'run.checkpoint',
    checkpoint: {
      id: base.id,
      summary: base.summary,
      reason: base.reason,
      recoverable: base.recoverable,
      issues: 'issues' in base && Array.isArray(base.issues) ? base.issues : undefined,
    },
  };
}

function buildRuntimeGateIssueEvents(
  base: RuntimeContractBase,
  issues: ChatRuntimeGateIssue[],
): Array<Extract<ChatRuntimeEvent, { type: 'gate.issue' }>> {
  const runBase = buildBase(base);
  return issues.map((issue) => ({
    ...runBase,
    type: 'gate.issue',
    issue,
  }));
}

function buildRuntimeGateEvaluatedEvent(
  base: RuntimeContractBase & {
    status: Extract<ChatRuntimeEvent, { type: 'run.ended' }>['status'];
    summary?: string;
  },
  report: CompletionGateReport,
): Extract<ChatRuntimeEvent, { type: 'gate.evaluated' }> {
  const decision = gateDecisionForReport(base.status, report);
  return {
    ...buildBase(base),
    type: 'gate.evaluated',
    gate: {
      id: `gate:${base.runId}:completion`,
      decision,
      summary: base.summary ?? (decision === 'deliverable' ? '完成门禁已通过。' : undefined),
      artifactCount: report.artifactCount,
      requiredVerificationCount: report.requiredVerificationCount,
      passedRequiredVerificationCount: report.passedRequiredVerificationCount,
      blockingIssueCount: report.blockingIssueCount,
      warningIssueCount: report.warningIssueCount,
      verificationCoverage: report.verificationCoverage,
      issues: report.issues,
    },
  };
}

export function buildRuntimeCompletionGateEvents(
  run: ChatRuntimeRunState | undefined,
  base: RuntimeContractBase & {
    status: Extract<ChatRuntimeEvent, { type: 'run.ended' }>['status'];
    error?: string;
  },
): ChatRuntimeEvent[] {
  const runBase = buildBase(base);
  const gateBase = { ...runBase, producer: 'gate' as const };
  const artifacts = run?.artifacts ?? [];
  const verifications = run?.verifications ?? [];
  const events: ChatRuntimeEvent[] = [];

  if (base.status === 'error' || base.status === 'aborted') {
    const terminalReport = buildTerminalGateReport({
      runId: base.runId,
      status: base.status,
      error: base.error,
      artifactCount: artifacts.length,
    });
    const terminalSummary = summarizeCompletionGateReport(terminalReport);
    events.push({
      ...gateBase,
      type: 'run.step.updated',
      step: {
        id: RUNTIME_PLAN_STEP_IDS.execute,
        title: '执行任务',
        status: base.status === 'aborted' ? 'blocked' : 'error',
        detail: base.error,
        kind: 'execution',
        order: 1,
      },
    });
    events.push(...buildRuntimeGateIssueEvents(gateBase, terminalReport.issues));
    events.push(buildRuntimeGateEvaluatedEvent({
      ...gateBase,
      status: base.status,
      summary: terminalSummary,
    }, terminalReport));
    events.push(buildRuntimeCheckpointEvent({
      ...gateBase,
      id: `checkpoint:${base.runId}:terminal`,
      summary: base.status === 'aborted' ? '任务已停止。' : '任务执行失败。',
      reason: base.error,
      recoverable: base.status === 'aborted',
      issues: terminalReport.issues,
    }));
    return events;
  }

  events.push({
    ...gateBase,
    type: 'run.step.updated',
    step: {
      id: RUNTIME_PLAN_STEP_IDS.execute,
      title: '执行任务',
      status: 'completed',
      kind: 'execution',
      order: 1,
    },
  });

  const missingVerificationArtifacts = artifacts.filter((artifact) =>
    !verifications.some((verification) => verification.artifactId === artifact.id),
  );
  const pendingVerifications: ChatRuntimeVerification[] = [];
  for (const artifact of missingVerificationArtifacts) {
    const event = buildRuntimeArtifactVerificationEvent(gateBase, {
      artifact,
      status: 'blocked',
      kind: 'artifact.availability',
      required: true,
      severity: 'blocking',
      detail: '完成门禁检查时还没有发现该产物的本地验证结果。',
      evidence: artifact.filePath ?? artifact.url,
    });
    pendingVerifications.push(event.verification);
    events.push(event);
  }

  const gateReport = buildRuntimeCompletionGateReport(run, pendingVerifications);
  const verifyStatus = gateReport.artifactCount === 0
    && gateReport.missingRequiredArtifactCount === 0
    && gateReport.blockedVerificationCount === 0
    && gateReport.missingVerificationCount === 0
    ? 'skipped'
    : gateReport.missingRequiredArtifactCount > 0
      || gateReport.blockedVerificationCount > 0
      || gateReport.missingVerificationCount > 0
      ? 'blocked'
      : 'completed';
  const deliveryStatus = completionGateStatus(gateReport);
  const gateSummary = summarizeCompletionGateReport(gateReport);

  events.push({
    ...runBase,
    producer: 'gate',
    type: 'run.step.updated',
    step: {
      id: RUNTIME_PLAN_STEP_IDS.verify,
      title: '验证结果',
      status: verifyStatus,
      detail: gateReport.artifactCount === 0 && gateReport.missingRequiredArtifactCount === 0
        ? '本轮没有需要落地验证的产物。'
        : gateSummary,
      kind: 'verification',
      order: 2,
    },
  });
  events.push({
    ...runBase,
    producer: 'gate',
    type: 'run.step.updated',
    step: {
      id: RUNTIME_PLAN_STEP_IDS.deliver,
      title: '交付回复',
      status: deliveryStatus,
      detail: gateSummary,
      kind: 'delivery',
      order: 3,
    },
  });
  events.push(...buildRuntimeGateIssueEvents(gateBase, gateReport.issues));
  events.push(buildRuntimeGateEvaluatedEvent({
    ...gateBase,
    status: base.status,
    summary: gateSummary,
  }, gateReport));

  if (gateReport.hasBlockingIssues) {
    events.push(buildRuntimeCheckpointEvent({
      ...gateBase,
      id: `checkpoint:${base.runId}:completion-gate`,
      summary: '完成门禁发现执行结果尚未满足交付条件。',
      reason: gateSummary,
      recoverable: true,
      issues: gateReport.issues,
    }));
  }

  return events;
}
