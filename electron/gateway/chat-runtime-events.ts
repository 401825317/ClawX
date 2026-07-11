import type {
  ChatRuntimeEvent,
  ChatRuntimeGateDecision,
  ChatRuntimeGateEvaluation,
  ChatRuntimeGateIssue,
  ChatRuntimeIssueSeverity,
  ChatRuntimeProgressEntry,
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
    ?? nestedRecord(resultDetails, 'task')
    ?? nestedRecord(meta, 'task')
    ?? nestedRecord(payload, 'task');
  const records = [payload, data, task, details, result, resultDetails, meta];
  const explicitTaskId = readFirstString(records, ['taskId', 'task_id']);
  const taskLooksNative = Boolean(task && (
    readString(task.taskKind)
    || readString(task.task_kind)
    || readString(task.deliveryStatus)
    || readString(task.delivery_status)
    || readString(task.requesterSessionKey)
    || readString(task.requester_session_key)
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
  return {
    id: readString(record.id) ?? `progress:${kind}:${text}`,
    kind,
    text,
    status: status === 'running' || status === 'completed' || status === 'blocked' || status === 'error'
      ? status
      : undefined,
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

type NativeTaskLifecycle = 'pending' | 'running' | 'completed' | 'error' | 'waiting_approval' | 'partial';

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
    || readString(record.deliveryStatus)
    || readString(record.delivery_status)
    || readString(record.requesterSessionKey)
    || readString(record.requester_session_key),
  );
  return hasTaskShape && Boolean(readString(record.id) ?? readString(record.runId) ?? readString(record.run_id));
}

function resolveNativeTaskRecord(payload: Record<string, unknown>): Record<string, unknown> | null {
  const context = resolveRuntimeTaskContext(payload);
  if (isNativeTaskRecord(context.task)) return context.task;
  if (isNativeTaskRecord(context.data)) return context.data;
  return null;
}

function nativeTaskLifecycle(task: Record<string, unknown>, data: Record<string, unknown>): NativeTaskLifecycle {
  const records = [task, data];
  const status = normalizeMarker(readFirstString(records, ['status', 'state', 'phase']));
  const deliveryStatus = normalizeMarker(readFirstString(records, ['deliveryStatus', 'delivery_status']));
  const terminalOutcome = normalizeMarker(readFirstString(records, ['terminalOutcome', 'terminal_outcome']));
  const approvalStatus = normalizeMarker(readFirstString(records, [
    'approvalStatus',
    'approval_status',
    'approvalState',
    'approval_state',
  ]));

  if (
    ['waiting_approval', 'approval_required', 'requires_approval', 'pending_approval'].includes(status)
    || ['waiting', 'pending', 'required'].includes(approvalStatus)
  ) return 'waiting_approval';
  if (
    ['partial', 'partially_completed', 'partial_failure'].includes(status)
    || ['partial', 'blocked'].includes(terminalOutcome)
    || ['partial', 'failed'].includes(deliveryStatus)
  ) return 'partial';
  if (['failed', 'failure', 'error', 'aborted', 'cancelled', 'canceled', 'lost'].includes(status)) return 'error';
  if (['succeeded', 'success', 'completed', 'complete', 'done', 'finished'].includes(status)) {
    return ['pending', 'queued', 'running'].includes(deliveryStatus) ? 'running' : 'completed';
  }
  if (['running', 'started', 'active', 'processing'].includes(status)) return 'running';
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
  return readFirstString([task, data], [
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
    'taskKind',
    'task_kind',
    'sourceId',
    'source_id',
  ]) ?? taskId;
}

function nativeTaskDetail(task: Record<string, unknown>, data: Record<string, unknown>): string | undefined {
  return readFirstString([task, data], [
    'progressSummary',
    'progress_summary',
    'terminalSummary',
    'terminal_summary',
    'error',
    'message',
    'summary',
  ]);
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
  const internalEvents = [data.internalEvents, data.internal_events, result?.internalEvents, result?.internal_events]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .map((value) => asRecord(value))
    .filter((value): value is Record<string, unknown> => value != null);
  const mediaRecords = [
    nestedRecord(task, 'media'),
    nestedRecord(data, 'media'),
    nestedRecord(result, 'media'),
    nestedRecord(resultDetails, 'media'),
  ];
  const entries: unknown[] = [];
  const records = [task, data, result, resultDetails, ...internalEvents];
  for (const record of records) {
    if (!record) continue;
    for (const key of ['artifact', 'artifacts', 'attachment', 'attachments', 'paths', 'mediaUrls', 'media_urls', 'outputPath', 'output_path', 'filePath', 'path']) {
      entries.push(...nativeTaskArtifactEntries(record[key]));
    }
  }
  for (const media of mediaRecords) {
    if (!media) continue;
    for (const key of ['artifact', 'artifacts', 'attachment', 'attachments', 'paths', 'mediaUrls', 'media_urls', 'url']) {
      entries.push(...nativeTaskArtifactEntries(media[key]));
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

  const base = withBase('run.step.updated', raw);
  if (!base) return [];
  const lifecycle = nativeTaskLifecycle(task, context.data);
  const nativeBase = { ...base, taskStatus: lifecycle };
  const taskId = context.taskId;
  const title = nativeTaskTitle(task, context.data, taskId);
  const detail = nativeTaskDetail(task, context.data);
  const toolCallId = readFirstString([task, context.data], ['toolCallId', 'tool_call_id']);
  const stepId = `task:${taskId}`;
  const events: ChatRuntimeEvent[] = [{
    ...nativeBase,
    type: 'run.step.updated',
    step: {
      id: stepId,
      title,
      status: nativeTaskStepStatus(lifecycle),
      detail,
      kind: readFirstString([task, context.data], ['taskKind', 'task_kind']),
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

  const verificationIds = new Set<string>();
  for (const entry of collectNativeTaskVerifications(task, context.data)) {
    const verification = normalizeVerification(entry);
    if (!verification) continue;
    verificationIds.add(verification.id);
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

  if (lifecycle === 'completed') {
    for (const artifact of artifactMap.values()) {
      const verificationId = `verification:task:${taskId}:${artifact.id}`;
      if (verificationIds.has(verificationId)) continue;
      events.push({
        ...nativeBase,
        type: 'verification.completed',
        verification: {
          id: verificationId,
          status: 'passed',
          kind: 'artifact.availability',
          required: true,
          title: artifact.title ?? artifact.id,
          targetId: artifact.id,
          artifactId: artifact.id,
          taskId,
          evidence: context.runId,
          source: 'openclaw.task',
        },
        toolCallId,
        itemId: taskId,
      });
    }
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

  if (lifecycle === 'completed' || lifecycle === 'error' || lifecycle === 'partial') {
    events.push({
      ...nativeBase,
      type: 'run.ended',
      status: lifecycle === 'completed' ? 'completed' : 'error',
      endedAt: readNumber(task.endedAt) ?? readNumber(context.data.endedAt),
      error: lifecycle === 'completed' ? undefined : detail,
      stopReason: lifecycle === 'partial' ? 'partial_task_completion' : undefined,
    });
  }

  return events;
}

function runtimeEventIdentity(event: ChatRuntimeEvent): string {
  if (event.type === 'run.step.updated') return `${event.type}:${event.runId}:${event.step.id}:${event.step.status}`;
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
