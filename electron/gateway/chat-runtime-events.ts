import type {
  ChatRuntimeEvent,
  ChatRuntimeGateDecision,
  ChatRuntimeGateEvaluation,
  ChatRuntimeGateIssue,
  ChatRuntimeIssueSeverity,
  ChatRuntimeProgressEntry,
  ChatRuntimeTaskProjection,
  ChatRuntimeTaskStatus,
  ChatRuntimeVerificationKind,
} from '../../shared/chat-runtime-events';
import { CHAT_RUNTIME_CONTRACT_VERSION } from '../../shared/chat-runtime-events';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readTimestamp(value: unknown): number | undefined {
  const numeric = readNumber(value);
  if (numeric != null) return numeric;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readFirstString(records: Array<Record<string, unknown> | null | undefined>, keys: string[]): string | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = readString(record[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function nestedRecord(record: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  return record ? asRecord(record[key]) : null;
}

type RuntimeTaskContext = {
  data: Record<string, unknown>;
  task: Record<string, unknown> | null;
  taskId?: string;
  parentTaskId?: string;
  runId?: string;
  sessionKey?: string;
};

function resolveRuntimeTaskContext(payload: Record<string, unknown>): RuntimeTaskContext {
  const data = asRecord(payload.data) ?? payload;
  const details = nestedRecord(data, 'details');
  const result = nestedRecord(data, 'result');
  const resultDetails = nestedRecord(result, 'details');
  const meta = nestedRecord(data, 'meta');
  const task = nestedRecord(data, 'task')
    ?? nestedRecord(data, 'taskRun')
    ?? nestedRecord(data, 'task_run')
    ?? nestedRecord(details, 'task')
    ?? nestedRecord(result, 'task')
    ?? nestedRecord(resultDetails, 'task')
    ?? nestedRecord(meta, 'task')
    ?? nestedRecord(payload, 'task');
  const records = [payload, data, task, details, result, resultDetails, meta];
  const explicitTaskId = readFirstString(records, ['taskId', 'task_id']);
  const taskLooksNative = Boolean(task && (
    readString(task.taskKind)
    || readString(task.task_kind)
    || readString(task.runtime)
    || readString(task.kind)
    || readString(task.deliveryStatus)
    || readString(task.delivery_status)
    || readString(task.requesterSessionKey)
    || readString(task.requester_session_key)
    || readString(task.childSessionKey)
    || readString(task.parentTaskId)
    || readString(task.flowId)
  ));
  const taskId = explicitTaskId ?? (taskLooksNative ? readString(task?.id) : undefined);
  return {
    data,
    task,
    taskId,
    parentTaskId: readFirstString(records, ['parentTaskId', 'parent_task_id']),
    runId: readFirstString(records, ['runId', 'run_id']),
    sessionKey: readFirstString(records, [
      'sessionKey',
      'session_key',
      'requesterSessionKey',
      'requester_session_key',
      'ownerKey',
      'owner_key',
    ]),
  };
}

function withBase(
  type: ChatRuntimeEvent['type'],
  payload: Record<string, unknown>,
): Pick<ChatRuntimeEvent, 'contractVersion' | 'producer' | 'type' | 'runId' | 'sessionKey' | 'taskId' | 'parentTaskId' | 'taskStatus' | 'seq' | 'ts'> | null {
  const taskContext = resolveRuntimeTaskContext(payload);
  const runId = taskContext.runId ?? (taskContext.taskId ? `task:${taskContext.taskId}` : undefined);
  if (!runId) return null;
  return {
    contractVersion: CHAT_RUNTIME_CONTRACT_VERSION,
    producer: readFirstString([payload, taskContext.data, taskContext.task], ['producer', 'source']) ?? 'gateway',
    type,
    runId,
    sessionKey: taskContext.sessionKey,
    taskId: taskContext.taskId,
    parentTaskId: taskContext.parentTaskId,
    taskStatus: (() => {
      const task = resolveNativeTaskRecord(payload);
      return task ? nativeTaskLifecycle(task, taskContext.data) : undefined;
    })(),
    seq: readNumber(payload.seq),
    ts: readNumber(payload.ts),
  };
}

function readStatus(
  value: unknown,
  allowed: string[],
  fallback: string,
): string {
  const normalized = readString(value);
  return normalized && allowed.includes(normalized) ? normalized : fallback;
}

function readSeverity(value: unknown): ChatRuntimeIssueSeverity | undefined {
  const normalized = readString(value);
  return normalized === 'info' || normalized === 'warning' || normalized === 'blocking'
    ? normalized
    : undefined;
}

function readGateDecision(value: unknown): ChatRuntimeGateDecision | undefined {
  const normalized = readString(value);
  return normalized === 'deliverable'
    || normalized === 'continue_required'
    || normalized === 'blocked_needs_user'
    || normalized === 'failed'
    || normalized === 'aborted'
    ? normalized
    : undefined;
}

function normalizeGateIssue(value: unknown, index: number): ChatRuntimeGateIssue | null {
  const record = asRecord(value);
  if (!record) return null;
  const code = readString(record.code) ?? 'runtime.issue';
  const title = readString(record.title) ?? readString(record.summary) ?? readString(record.message);
  if (!title) return null;
  return {
    id: readString(record.id) ?? `issue-${index + 1}`,
    code,
    severity: readSeverity(record.severity) ?? 'blocking',
    title,
    detail: readString(record.detail) ?? readString(record.reason),
    targetId: readString(record.targetId),
    artifactId: readString(record.artifactId),
    stepId: readString(record.stepId),
    verificationId: readString(record.verificationId),
    recoverable: readBoolean(record.recoverable),
    suggestedRecovery: readString(record.suggestedRecovery),
  };
}

function normalizeGateIssues(value: unknown): ChatRuntimeGateIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues = value
    .map((issue, index) => normalizeGateIssue(issue, index))
    .filter((issue): issue is ChatRuntimeGateIssue => issue != null);
  return issues.length > 0 ? issues : undefined;
}

function normalizeGateEvaluation(value: unknown): ChatRuntimeGateEvaluation | null {
  const record = asRecord(value);
  if (!record) return null;
  const decision = readGateDecision(record.decision);
  if (!decision) return null;
  const issues = normalizeGateIssues(record.issues) ?? [];
  return {
    id: readString(record.id) ?? 'gate:evaluation',
    decision,
    summary: readString(record.summary),
    artifactCount: readNumber(record.artifactCount) ?? 0,
    requiredVerificationCount: readNumber(record.requiredVerificationCount) ?? 0,
    passedRequiredVerificationCount: readNumber(record.passedRequiredVerificationCount) ?? 0,
    blockingIssueCount: readNumber(record.blockingIssueCount) ?? issues.filter((issue) => issue.severity === 'blocking').length,
    warningIssueCount: readNumber(record.warningIssueCount) ?? issues.filter((issue) => issue.severity === 'warning').length,
    verificationCoverage: readNumber(record.verificationCoverage) ?? 0,
    issues,
  };
}

function normalizePlanStep(value: unknown, index: number): NonNullable<Extract<ChatRuntimeEvent, { type: 'run.step.updated' }>['step']> | null {
  const record = asRecord(value);
  if (!record) return null;
  const title = readString(record.title) ?? readString(record.label) ?? readString(record.name);
  if (!title) return null;
  const id = readString(record.id) ?? readString(record.stepId) ?? `step-${index + 1}`;
  const step: NonNullable<Extract<ChatRuntimeEvent, { type: 'run.step.updated' }>['step']> = {
    id,
    title,
    status: readStatus(record.status, ['pending', 'running', 'completed', 'error', 'blocked', 'skipped'], 'pending') as NonNullable<Extract<ChatRuntimeEvent, { type: 'run.step.updated' }>['step']>['status'],
    detail: readString(record.detail) ?? readString(record.summary),
    kind: readString(record.kind),
    order: readNumber(record.order) ?? index,
    parentId: readString(record.parentId) ?? readString(record.parentStepId),
    taskId: readString(record.taskId) ?? readString(record.task_id),
    toolCallId: readString(record.toolCallId) ?? readString(record.tool_call_id),
  };
  const requiresArtifact = readBoolean(record.requiresArtifact);
  const requiredArtifact = readBoolean(record.requiredArtifact);
  const artifactRequired = readBoolean(record.artifactRequired);
  const outputArtifactRequired = readBoolean(record.outputArtifactRequired);
  if (typeof requiresArtifact === 'boolean') step.requiresArtifact = requiresArtifact;
  if (typeof requiredArtifact === 'boolean') step.requiredArtifact = requiredArtifact;
  if (typeof artifactRequired === 'boolean') step.artifactRequired = artifactRequired;
  if (typeof outputArtifactRequired === 'boolean') step.outputArtifactRequired = outputArtifactRequired;
  return step;
}

function normalizeProgressEntry(value: unknown): ChatRuntimeProgressEntry | null {
  const record = asRecord(value);
  if (!record) return null;
  const text = readString(record.text) ?? readString(record.message) ?? readString(record.summary);
  if (!text) return null;
  const kind = readString(record.kind);
  if (kind !== 'commentary' && kind !== 'action' && kind !== 'status') return null;
  const status = readString(record.status);
  const translationParamsRecord = asRecord(record.translationParams ?? record.translation_params);
  const translationParams = translationParamsRecord
    ? Object.fromEntries(Object.entries(translationParamsRecord)
      .filter(([, entryValue]) => (
        (typeof entryValue === 'string' && entryValue.length <= 240)
        || (typeof entryValue === 'number' && Number.isFinite(entryValue))
      ))
      .slice(0, 16)) as Record<string, string | number>
    : undefined;
  return {
    id: readString(record.id) ?? `progress:${kind}:${text}`,
    kind,
    text,
    status: status === 'running' || status === 'completed' || status === 'blocked' || status === 'error' || status === 'aborted'
      ? status
      : undefined,
    translationKey: readString(record.translationKey) ?? readString(record.translation_key),
    translationParams: translationParams && Object.keys(translationParams).length > 0
      ? translationParams
      : undefined,
    toolName: readString(record.toolName) ?? readString(record.tool_name),
    toolLabel: readString(record.toolLabel) ?? readString(record.tool_label),
    command: readString(record.command),
    detail: readString(record.detail),
    dedupeKey: readString(record.dedupeKey),
    toolCallId: readString(record.toolCallId),
    stepId: readString(record.stepId),
    taskId: readString(record.taskId) ?? readString(record.task_id),
    source: readString(record.source),
  };
}

function normalizeArtifact(value: unknown): Extract<ChatRuntimeEvent, { type: 'artifact.produced' }>['artifact'] | null {
  const record = asRecord(value);
  if (!record) return null;
  const filePath = readString(record.filePath)
    ?? readString(record.outputPath)
    ?? readString(record.output_path)
    ?? readString(record.path)
    ?? readString(record.out);
  const url = readString(record.url) ?? readString(record.mediaUrl) ?? readString(record.media_url);
  const title = readString(record.title) ?? readString(record.name);
  const id = readString(record.id) ?? readString(record.artifactId) ?? filePath ?? url ?? title;
  if (!id) return null;
  return {
    id,
    kind: readString(record.kind) ?? readString(record.type),
    title,
    filePath,
    url,
    mimeType: readString(record.mimeType) ?? readString(record.mediaType),
    sizeBytes: readNumber(record.sizeBytes) ?? readNumber(record.fileSize),
    stepId: readString(record.stepId) ?? readString(record.requiredStepId) ?? readString(record.compositeTaskId),
    taskId: readString(record.taskId) ?? readString(record.task_id),
    sourceToolCallId: readString(record.sourceToolCallId) ?? readString(record.toolCallId),
    source: readString(record.source),
  };
}

function normalizeVerification(value: unknown): Extract<ChatRuntimeEvent, { type: 'verification.completed' }>['verification'] | null {
  const record = asRecord(value);
  if (!record) return null;
  const title = readString(record.title) ?? readString(record.name);
  const targetId = readString(record.targetId);
  const artifactId = readString(record.artifactId);
  const id = readString(record.id) ?? readString(record.verificationId) ?? targetId ?? artifactId ?? title;
  if (!id) return null;
  const status = readString(record.status);
  if (status !== 'passed' && status !== 'failed' && status !== 'blocked' && status !== 'skipped') return null;
  return {
    id,
    status,
    kind: (readString(record.kind) ?? readString(record.type) ?? readString(record.check)) as ChatRuntimeVerificationKind | undefined,
    required: readBoolean(record.required),
    severity: readSeverity(record.severity),
    title,
    detail: readString(record.detail) ?? readString(record.summary) ?? readString(record.message),
    targetId,
    artifactId,
    taskId: readString(record.taskId) ?? readString(record.task_id),
    evidence: readString(record.evidence),
    source: readString(record.source),
  };
}

type CommandOutputEvent = Extract<ChatRuntimeEvent, { type: 'command.output' }>;

function commandTargetId(event: CommandOutputEvent): string {
  return event.itemId
    ?? event.toolCallId
    ?? event.name
    ?? event.title
    ?? `command-${event.seq ?? event.ts ?? 'result'}`;
}

function commandVerificationStatus(event: CommandOutputEvent): Extract<ChatRuntimeEvent, { type: 'verification.completed' }>['verification']['status'] | null {
  const status = event.status?.trim().toLowerCase();
  if (typeof event.exitCode === 'number') return event.exitCode === 0 ? 'passed' : 'failed';
  if (status === 'passed' || status === 'success' || status === 'succeeded' || status === 'completed' || status === 'ok') return 'passed';
  if (status === 'failed' || status === 'failure' || status === 'error') return 'failed';
  if (status === 'blocked') return 'blocked';
  if (status === 'skipped') return 'skipped';
  return null;
}

function commandIsTerminal(event: CommandOutputEvent): boolean {
  const phase = event.phase?.trim().toLowerCase();
  return phase === 'end'
    || phase === 'result'
    || phase === 'completed'
    || phase === 'done'
    || typeof event.exitCode === 'number'
    || commandVerificationStatus(event) != null;
}

function commandVerificationKind(event: CommandOutputEvent): ChatRuntimeVerificationKind {
  const text = `${event.name ?? ''}\n${event.title ?? ''}\n${event.output ?? ''}`.toLowerCase();
  if (/\b(typecheck|type-check|tsc\s+--noemit|tsc\s+--no-emit)\b/.test(text)) return 'typecheck';
  if (/\b(test|vitest|jest|playwright|mocha|ava)\b/.test(text)) return 'test';
  if (/\b(build|vite build|electron-builder|webpack|rollup)\b/.test(text)) return 'build';
  return 'command.exit';
}

function commandVerificationTitle(event: CommandOutputEvent): string {
  return event.title ?? event.name ?? 'command';
}

function normalizeCommandVerificationEvents(event: ChatRuntimeEvent): ChatRuntimeEvent[] {
  if (event.type !== 'command.output' || !commandIsTerminal(event)) return [];

  const status = commandVerificationStatus(event);
  if (!status) return [];

  const targetId = commandTargetId(event);
  const verificationId = `verification:${targetId}`;
  const title = commandVerificationTitle(event);
  const verificationEvent: ChatRuntimeEvent = {
    contractVersion: CHAT_RUNTIME_CONTRACT_VERSION,
    producer: event.producer ?? 'gateway',
    type: 'verification.completed',
    runId: event.runId,
    sessionKey: event.sessionKey,
    ts: event.ts,
    toolCallId: event.toolCallId,
    itemId: event.itemId,
    verification: {
      id: verificationId,
      status,
      kind: commandVerificationKind(event),
      required: true,
      severity: status === 'passed' || status === 'skipped' ? undefined : 'blocking',
      title,
      detail: event.output,
      targetId,
      evidence: typeof event.exitCode === 'number' ? `exitCode=${event.exitCode}` : event.status,
      source: 'command.output',
    },
  };

  if (status === 'passed' || status === 'skipped') return [verificationEvent];

  const issue: ChatRuntimeGateIssue = {
    id: `issue:${verificationId}`,
    code: 'verification.command.failed',
    severity: 'blocking',
    title: `${title} 验证未通过`,
    detail: event.output ?? (typeof event.exitCode === 'number' ? `exitCode=${event.exitCode}` : event.status),
    targetId,
    stepId: event.toolCallId,
    verificationId,
    recoverable: true,
    suggestedRecovery: '修复命令失败原因后重新执行验证。',
  };

  return [
    verificationEvent,
    {
      contractVersion: CHAT_RUNTIME_CONTRACT_VERSION,
      producer: event.producer ?? 'gateway',
      type: 'gate.issue',
      runId: event.runId,
      sessionKey: event.sessionKey,
      ts: event.ts,
      issue,
    },
  ];
}

type NativeTaskLifecycle = ChatRuntimeTaskStatus;

function normalizeMarker(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[\s.-]+/g, '_')
    : '';
}

function isNativeTaskRecord(record: Record<string, unknown> | null): record is Record<string, unknown> {
  if (!record) return false;
  const taskId = readString(record.taskId) ?? readString(record.task_id);
  if (taskId) return true;
  const hasTaskShape = Boolean(
    readString(record.taskKind)
    || readString(record.task_kind)
    || readString(record.runtime)
    || readString(record.kind)
    || readString(record.deliveryStatus)
    || readString(record.delivery_status)
    || readString(record.requesterSessionKey)
    || readString(record.requester_session_key)
    || readString(record.childSessionKey)
    || readString(record.parentTaskId)
    || readString(record.flowId),
  );
  return hasTaskShape && Boolean(readString(record.id) ?? readString(record.runId) ?? readString(record.run_id));
}

function resolveNativeTaskRecord(payload: Record<string, unknown>): Record<string, unknown> | null {
  const context = resolveRuntimeTaskContext(payload);
  if (isNativeTaskRecord(context.task)) return context.task;
  if (isNativeTaskRecord(context.data)) return context.data;
  return null;
}

function nativeTaskStateRecords(
  task: Record<string, unknown>,
  data: Record<string, unknown>,
): Array<Record<string, unknown> | null> {
  const details = nestedRecord(data, 'details');
  const result = nestedRecord(data, 'result');
  const resultDetails = nestedRecord(result, 'details');
  const meta = nestedRecord(data, 'meta');
  return [
    task,
    data,
    details,
    result,
    resultDetails,
    meta,
    nestedRecord(task, 'approval'),
    nestedRecord(data, 'approval'),
    nestedRecord(details, 'approval'),
    nestedRecord(resultDetails, 'approval'),
  ];
}

function nativeTaskLifecycle(task: Record<string, unknown>, data: Record<string, unknown>): NativeTaskLifecycle {
  const records = nativeTaskStateRecords(task, data);
  const status = normalizeMarker(
    readFirstString(records, ['status', 'state'])
      ?? readFirstString([task, ...records.slice(2)], ['phase']),
  );
  const deliveryStatus = normalizeMarker(readFirstString(records, ['deliveryStatus', 'delivery_status']));
  const terminalOutcome = normalizeMarker(readFirstString(records, ['terminalOutcome', 'terminal_outcome']));
  const approvalStatus = normalizeMarker(
    readFirstString(records, [
      'approvalStatus',
      'approval_status',
      'approvalState',
      'approval_state',
    ]) ?? readFirstString(records.slice(6), ['status', 'state', 'phase']),
  );

  if (['failed', 'failure', 'error', 'aborted', 'cancelled', 'canceled', 'lost', 'timed_out', 'timeout'].includes(status)) return 'error';
  if (
    ['waiting_approval', 'approval_required', 'requires_approval', 'pending_approval'].includes(status)
    || ['waiting', 'pending', 'required'].includes(approvalStatus)
  ) return 'waiting_approval';
  if (
    ['partial', 'partially_completed', 'partial_failure'].includes(status)
    || ['partial', 'blocked'].includes(terminalOutcome)
    || ['partial', 'failed'].includes(deliveryStatus)
  ) return 'partial';
  if (['succeeded', 'success', 'completed', 'complete', 'done', 'finished'].includes(status)) {
    if (['pending', 'queued', 'running', 'session_queued'].includes(deliveryStatus)) return 'running';
    return ['delivered', 'not_applicable'].includes(deliveryStatus) ? 'completed' : 'partial';
  }
  if (['running', 'started', 'accepted', 'active', 'processing'].includes(status)) return 'running';
  return 'pending';
}

function nativeTaskStepStatus(lifecycle: NativeTaskLifecycle): NonNullable<Extract<ChatRuntimeEvent, { type: 'run.step.updated' }>['step']>['status'] {
  if (lifecycle === 'completed') return 'completed';
  if (lifecycle === 'error') return 'error';
  if (lifecycle === 'waiting_approval' || lifecycle === 'partial') return 'blocked';
  return lifecycle === 'running' ? 'running' : 'pending';
}

function nativeTaskProgressStatus(lifecycle: NativeTaskLifecycle): ChatRuntimeProgressEntry['status'] {
  if (lifecycle === 'completed') return 'completed';
  if (lifecycle === 'error') return 'error';
  if (lifecycle === 'waiting_approval' || lifecycle === 'partial') return 'blocked';
  return 'running';
}

function nativeTaskTitle(task: Record<string, unknown>, data: Record<string, unknown>, taskId: string): string {
  return readFirstString(nativeTaskStateRecords(task, data), [
    'label',
    'title',
    'task',
    'taskLabel',
    'task_label',
    'progressSummary',
    'progress_summary',
    'terminalSummary',
    'terminal_summary',
    'toolName',
    'tool_name',
    'name',
    'taskKind',
    'task_kind',
    'sourceId',
    'source_id',
  ]) ?? taskId;
}

function nativeTaskDetail(task: Record<string, unknown>, data: Record<string, unknown>): string | undefined {
  const records = nativeTaskStateRecords(task, data);
  const lifecycle = nativeTaskLifecycle(task, data);
  return readFirstString(records, lifecycle === 'running' || lifecycle === 'pending'
    ? ['progressSummary', 'progress_summary', 'terminalSummary', 'terminal_summary', 'error', 'message', 'summary']
    : ['terminalSummary', 'terminal_summary', 'error', 'progressSummary', 'progress_summary', 'message', 'summary']);
}

function nativeTaskProjection(
  task: Record<string, unknown>,
  data: Record<string, unknown>,
  taskId: string,
  lifecycle: NativeTaskLifecycle,
): ChatRuntimeTaskProjection {
  const records = nativeTaskStateRecords(task, data);
  return {
    taskId,
    parentTaskId: readFirstString(records, ['parentTaskId', 'parent_task_id']),
    flowId: readFirstString(records, ['flowId', 'flow_id', 'parentFlowId', 'parent_flow_id']),
    kind: readFirstString(records, ['taskKind', 'task_kind', 'kind']),
    runtime: readFirstString(records, ['runtime']),
    title: nativeTaskTitle(task, data, taskId),
    detail: nativeTaskDetail(task, data),
    agentId: readFirstString(records, ['agentId', 'agent_id']),
    sessionKey: readFirstString(records, [
      'sessionKey',
      'session_key',
      'requesterSessionKey',
      'requester_session_key',
      'ownerKey',
      'owner_key',
    ]),
    childSessionKey: readFirstString(records, ['childSessionKey', 'child_session_key']),
    status: lifecycle,
    sourceStatus: readFirstString(records, ['status', 'state', 'phase']),
    deliveryStatus: readFirstString(records, ['deliveryStatus', 'delivery_status']),
    terminalOutcome: readFirstString(records, ['terminalOutcome', 'terminal_outcome']),
    createdAt: readTimestamp(task.createdAt) ?? readTimestamp(data.createdAt),
    startedAt: readTimestamp(task.startedAt) ?? readTimestamp(data.startedAt),
    updatedAt: readTimestamp(task.updatedAt)
      ?? readTimestamp(task.lastEventAt)
      ?? readTimestamp(data.updatedAt)
      ?? readTimestamp(data.lastEventAt),
    endedAt: readTimestamp(task.endedAt) ?? readTimestamp(data.endedAt),
  };
}

function nativeTaskArtifactEntries(value: unknown): unknown[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => nativeTaskArtifactEntries(item));
  if (typeof value === 'string') {
    return [{
      ...(value.startsWith('http://') || value.startsWith('https://') ? { url: value } : { filePath: value }),
    }];
  }
  return [value];
}

function collectNativeTaskArtifactEntries(task: Record<string, unknown>, data: Record<string, unknown>): unknown[] {
  const result = asRecord(data.result);
  const resultDetails = nestedRecord(result, 'details');
  const entries: unknown[] = [];
  const records = [task, data, result, resultDetails];
  for (const record of records) {
    if (!record) continue;
    for (const key of ['artifacts', 'outputArtifacts', 'output_artifacts']) {
      entries.push(...nativeTaskArtifactEntries(record[key]));
    }
  }
  return entries;
}

function collectNativeTaskVerifications(task: Record<string, unknown>, data: Record<string, unknown>): unknown[] {
  const result = asRecord(data.result);
  const resultDetails = nestedRecord(result, 'details');
  const internalEvents = [data.internalEvents, data.internal_events, result?.internalEvents, result?.internal_events]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .map((value) => asRecord(value))
    .filter((value): value is Record<string, unknown> => value != null);
  const entries: unknown[] = [];
  for (const record of [task, data, result, resultDetails, ...internalEvents]) {
    if (!record) continue;
    for (const key of ['verification', 'verifications']) {
      const value = record[key];
      if (Array.isArray(value)) entries.push(...value);
      else if (value != null) entries.push(value);
    }
  }
  return entries;
}

function normalizeNativeTaskRuntimeEvents(payload: unknown): ChatRuntimeEvent[] {
  const raw = asRecord(payload);
  if (!raw) return [];
  const context = resolveRuntimeTaskContext(raw);
  const task = resolveNativeTaskRecord(raw);
  if (!task || !context.taskId) return [];

  const base = withBase('task.updated', raw);
  if (!base) return [];
  const lifecycle = nativeTaskLifecycle(task, context.data);
  const nativeBase = { ...base, taskStatus: lifecycle };
  const taskId = context.taskId;
  const title = nativeTaskTitle(task, context.data, taskId);
  const detail = nativeTaskDetail(task, context.data);
  const toolCallId = readFirstString(nativeTaskStateRecords(task, context.data), ['toolCallId', 'tool_call_id']);
  const stepId = `task:${taskId}`;
  const events: ChatRuntimeEvent[] = [{
    ...nativeBase,
    type: 'task.updated',
    task: nativeTaskProjection(task, context.data, taskId, lifecycle),
  }, {
    ...nativeBase,
    type: 'run.step.updated',
    step: {
      id: stepId,
      title,
      status: nativeTaskStepStatus(lifecycle),
      detail,
      kind: readFirstString(nativeTaskStateRecords(task, context.data), ['taskKind', 'task_kind', 'kind', 'runtime']),
      parentId: context.parentTaskId ? `task:${context.parentTaskId}` : undefined,
      taskId,
      toolCallId,
    },
  }];

  if (detail) {
    events.push({
      ...nativeBase,
      type: 'progress.update',
      entry: {
        id: `task:${taskId}:progress`,
        kind: lifecycle === 'error' || lifecycle === 'waiting_approval' || lifecycle === 'partial' ? 'status' : 'action',
        text: detail,
        status: nativeTaskProgressStatus(lifecycle),
        toolCallId,
        stepId,
        taskId,
        source: 'native',
      },
    });
  }

  const artifactMap = new Map<string, Extract<ChatRuntimeEvent, { type: 'artifact.produced' }>['artifact']>();
  for (const entry of collectNativeTaskArtifactEntries(task, context.data)) {
    const artifact = normalizeArtifact(entry);
    if (!artifact) continue;
    const normalized = {
      ...artifact,
      taskId: artifact.taskId ?? taskId,
      stepId: artifact.stepId ?? stepId,
      sourceToolCallId: artifact.sourceToolCallId ?? toolCallId,
      source: artifact.source ?? 'openclaw.task',
    };
    artifactMap.set(normalized.id, normalized);
  }
  for (const artifact of artifactMap.values()) {
    events.push({
      ...nativeBase,
      type: 'artifact.produced',
      artifact,
      toolCallId,
      itemId: taskId,
    });
  }

  for (const entry of collectNativeTaskVerifications(task, context.data)) {
    const verification = normalizeVerification(entry);
    if (!verification) continue;
    events.push({
      ...nativeBase,
      type: 'verification.completed',
      verification: {
        ...verification,
        taskId: verification.taskId ?? taskId,
        targetId: verification.targetId ?? verification.artifactId,
        source: verification.source ?? 'openclaw.task',
      },
      toolCallId,
      itemId: taskId,
    });
  }

  if (lifecycle === 'waiting_approval' || lifecycle === 'partial') {
    events.push({
      ...nativeBase,
      type: 'run.checkpoint',
      checkpoint: {
        id: `checkpoint:task:${taskId}:${lifecycle}`,
        summary: detail ?? title,
        reason: detail,
        taskId,
        kind: lifecycle === 'waiting_approval' ? 'approval' : 'partial',
        recoverable: true,
      },
    });
  }

  if (lifecycle === 'waiting_approval') {
    const approval = nestedRecord(task, 'approval') ?? nestedRecord(context.data, 'approval');
    events.push({
      ...nativeBase,
      type: 'approval.updated',
      itemId: taskId,
      toolCallId,
      title: readFirstString([approval, task, context.data], ['title', 'label', 'kind']) ?? title,
      kind: readFirstString([approval, task, context.data], ['kind', 'approvalKind', 'approval_kind']),
      phase: readFirstString([approval, task, context.data], ['phase', 'status', 'state']) ?? 'waiting',
      status: readFirstString([approval, task, context.data], ['status', 'state']) ?? 'pending',
      message: readFirstString([approval, task, context.data], ['message', 'reason', 'summary', 'progressSummary']) ?? detail,
    });
  }

  if (lifecycle === 'partial') {
    events.push({
      ...nativeBase,
      type: 'gate.issue',
      issue: {
        id: `issue:task:${taskId}:partial`,
        code: 'task.partial',
        severity: 'blocking',
        title,
        detail,
        targetId: taskId,
        stepId,
        recoverable: true,
      },
    });
  }

  return events;
}

function runtimeEventIdentity(event: ChatRuntimeEvent): string {
  if (event.type === 'run.step.updated') return `${event.type}:${event.runId}:${event.step.id}:${event.step.status}`;
  if (event.type === 'task.updated') return `${event.type}:${event.runId}:${event.task.taskId}:${event.task.status}:${event.task.updatedAt ?? ''}`;
  if (event.type === 'progress.update') return `${event.type}:${event.runId}:${event.entry.id}:${event.entry.status}`;
  if (event.type === 'artifact.produced') return `${event.type}:${event.runId}:${event.artifact.id}`;
  if (event.type === 'verification.completed') return `${event.type}:${event.runId}:${event.verification.id}:${event.verification.status}`;
  if (event.type === 'run.checkpoint') return `${event.type}:${event.runId}:${event.checkpoint.id}`;
  if (event.type === 'gate.issue') return `${event.type}:${event.runId}:${event.issue.id}`;
  if (event.type === 'approval.updated') return `${event.type}:${event.runId}:${event.itemId ?? ''}:${event.status ?? ''}:${event.phase ?? ''}`;
  if (event.type === 'tool.started' || event.type === 'tool.updated' || event.type === 'tool.completed') return `${event.type}:${event.runId}:${event.toolCallId}`;
  return `${event.type}:${event.runId}:${event.seq ?? event.ts ?? ''}`;
}

export function normalizeGatewayChatRuntimeEvent(payload: unknown): ChatRuntimeEvent | null {
  const raw = asRecord(payload);
  if (!raw) return null;

  const data = asRecord(raw.data) ?? raw;
  const stream = normalizeMarker(
    readString(raw.stream)
      ?? readString(data.stream)
      ?? readString(raw.eventType)
      ?? readString(data.eventType)
      ?? readString(raw.type)
      ?? readString(data.event),
  );

  if (stream === 'lifecycle') {
    const phase = readString(data.phase);
    if (phase === 'start') {
      const base = withBase('run.started', raw);
      return base
        ? {
            ...base,
            startedAt: readNumber(data.startedAt),
            objective: readString(data.objective) ?? readString(data.goal),
          }
        : null;
    }

    if (phase === 'completed' || phase === 'done' || phase === 'finished') {
      const base = withBase('run.ended', raw);
      return base
        ? {
            ...base,
            status: 'completed',
            endedAt: readNumber(data.endedAt),
            livenessState: readString(data.livenessState),
            replayInvalid: typeof data.replayInvalid === 'boolean' ? data.replayInvalid : undefined,
            stopReason: readString(data.stopReason),
          }
        : null;
    }

    if (phase === 'error' || phase === 'failed') {
      const base = withBase('run.ended', raw);
      return base
        ? {
            ...base,
            status: 'error',
            endedAt: readNumber(data.endedAt),
            error: readString(data.error),
            livenessState: readString(data.livenessState),
            replayInvalid: typeof data.replayInvalid === 'boolean' ? data.replayInvalid : undefined,
            stopReason: readString(data.stopReason),
          }
        : null;
    }

    if (phase === 'aborted' || phase === 'cancelled') {
      const base = withBase('run.ended', raw);
      return base
        ? {
            ...base,
            status: 'aborted',
            endedAt: readNumber(data.endedAt),
            error: readString(data.error),
            stopReason: readString(data.stopReason),
          }
        : null;
    }

    return null;
  }

  if (stream === 'plan' || stream === 'run_plan') {
    const stepsRaw = Array.isArray(data.steps) ? data.steps : [];
    const steps = stepsRaw
      .map((step, index) => normalizePlanStep(step, index))
      .filter((step): step is NonNullable<typeof step> => step != null);
    const base = withBase('run.plan.updated', raw);
    return base
      ? {
          ...base,
          objective: readString(data.objective) ?? readString(data.goal),
          summary: readString(data.summary),
          steps,
        }
      : null;
  }

  if (stream === 'step' || stream === 'run_step') {
    const step = normalizePlanStep(data.step ?? data, 0);
    const base = withBase('run.step.updated', raw);
    return base && step ? { ...base, step } : null;
  }

  if (stream === 'artifact') {
    const artifact = normalizeArtifact(data.artifact ?? data);
    const base = withBase('artifact.produced', raw);
    return base && artifact
      ? {
          ...base,
          artifact: {
            ...artifact,
            taskId: artifact.taskId ?? base.taskId,
          },
          toolCallId: readString(data.toolCallId),
          itemId: readString(data.itemId),
        }
      : null;
  }

  if (stream === 'verification') {
    const verification = normalizeVerification(data.verification ?? data);
    const base = withBase('verification.completed', raw);
    return base && verification
      ? {
          ...base,
          verification: {
            ...verification,
            taskId: verification.taskId ?? base.taskId,
          },
          toolCallId: readString(data.toolCallId),
          itemId: readString(data.itemId),
        }
      : null;
  }

  if (stream === 'issue' || stream === 'gate_issue') {
    const issue = normalizeGateIssue(data.issue ?? data, 0);
    const base = withBase('gate.issue', raw);
    return base && issue
      ? {
          ...base,
          issue,
        }
      : null;
  }

  if (stream === 'gate' || stream === 'run_gate' || stream === 'gate_evaluated') {
    const gate = normalizeGateEvaluation(data.gate ?? data);
    const base = withBase('gate.evaluated', raw);
    return base && gate
      ? {
          ...base,
          gate,
        }
      : null;
  }

  if (stream === 'checkpoint') {
    const summary = readString(data.summary) ?? readString(data.message);
    const base = withBase('run.checkpoint', raw);
    return base && summary
      ? {
          ...base,
          checkpoint: {
            id: readString(data.id) ?? readString(data.checkpointId) ?? `${base.runId}:${base.seq ?? base.ts ?? 'checkpoint'}`,
            summary,
            reason: readString(data.reason),
            recoverable: readBoolean(data.recoverable),
            issues: normalizeGateIssues(data.issues),
          },
        }
      : null;
  }

  if (stream === 'assistant') {
    const base = withBase('assistant.delta', raw);
    return base
      ? {
          ...base,
          text: readString(data.text),
          delta: readString(data.delta),
          replace: typeof data.replace === 'boolean' ? data.replace : undefined,
          phase: readString(data.phase),
          mediaUrls: Array.isArray(data.mediaUrls)
            ? data.mediaUrls.filter((value): value is string => typeof value === 'string' && value.length > 0)
            : undefined,
        }
      : null;
  }

  if (stream === 'thinking') {
    const base = withBase('thinking.delta', raw);
    return base
      ? {
          ...base,
          text: readString(data.text),
          delta: readString(data.delta),
        }
      : null;
  }

  if (stream === 'progress' || stream === 'progress_update') {
    const base = withBase('progress.update', raw);
    const entry = normalizeProgressEntry(data.entry ?? data);
    return base && entry
      ? {
          ...base,
          entry,
        }
      : null;
  }

  if (stream === 'tool') {
    const phase = readString(data.phase);
    const toolCallId = readString(data.toolCallId);
    const name = readString(data.name);
    if (!toolCallId || !name) return null;

    if (phase === 'start') {
      const base = withBase('tool.started', raw);
      return base ? { ...base, toolCallId, name, args: data.args } : null;
    }
    if (phase === 'update') {
      const base = withBase('tool.updated', raw);
      return base ? { ...base, toolCallId, name, partialResult: data.partialResult } : null;
    }
    if (phase === 'result' || phase === 'end') {
      const base = withBase('tool.completed', raw);
      const meta = asRecord(data.meta);
      return base
        ? {
            ...base,
            toolCallId,
            name,
            result: data.result,
            meta: data.meta,
            durationMs: readNumber(data.durationMs) ?? readNumber(meta?.durationMs),
            isError: typeof data.isError === 'boolean' ? data.isError : undefined,
          }
        : null;
    }
    return null;
  }

  if (stream === 'command_output') {
    const base = withBase('command.output', raw);
    return base
      ? {
          ...base,
          itemId: readString(data.itemId),
          toolCallId: readString(data.toolCallId),
          name: readString(data.name),
          title: readString(data.title),
          output: readString(data.output),
          status: readString(data.status),
          phase: readString(data.phase),
          exitCode: readNumber(data.exitCode),
          durationMs: readNumber(data.durationMs),
          cwd: readString(data.cwd),
        }
      : null;
  }

  if (stream === 'patch') {
    const base = withBase('patch.completed', raw);
    return base
      ? {
          ...base,
          itemId: readString(data.itemId),
          toolCallId: readString(data.toolCallId),
          name: readString(data.name),
          title: readString(data.title),
          summary: readString(data.summary),
          added: readNumber(data.added),
          modified: readNumber(data.modified),
          deleted: readNumber(data.deleted),
        }
      : null;
  }

  if (stream === 'approval') {
    const base = withBase('approval.updated', raw);
    return base
      ? {
          ...base,
          itemId: readString(data.itemId),
          toolCallId: readString(data.toolCallId),
          title: readString(data.title),
          kind: readString(data.kind),
          phase: readString(data.phase),
          status: readString(data.status),
          message: readString(data.message),
        }
      : null;
  }

  return null;
}

export function normalizeGatewayChatRuntimeEvents(payload: unknown): ChatRuntimeEvent[] {
  const event = normalizeGatewayChatRuntimeEvent(payload);
  const nativeTaskEvents = normalizeNativeTaskRuntimeEvents(payload);
  const events = event ? [event, ...normalizeCommandVerificationEvents(event), ...nativeTaskEvents] : nativeTaskEvents;
  const seen = new Set<string>();
  return events.filter((candidate) => {
    const identity = runtimeEventIdentity(candidate);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
