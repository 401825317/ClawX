import type {
  ChatRuntimeArtifact,
  ChatRuntimeEvent,
  ChatRuntimeEventProducer,
  ChatRuntimeVerification,
} from '../../../shared/chat-runtime-events';
import { CHAT_RUNTIME_CONTRACT_VERSION } from '../../../shared/chat-runtime-events';
import type { AttachedFileMeta, ChatRuntimeRunState, ChatSendMode } from './types';

type RuntimeEventBase = {
  runId: string;
  rootRunId?: string;
  sessionKey?: string;
  taskId?: string;
  parentTaskId?: string;
  toolCallId?: string;
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

/** Keep path-like prose renderable without promoting it to canonical output evidence. */
export function hasCanonicalArtifactEvidence(file: AttachedFileMeta): boolean {
  if (
    file.disposition === 'input-reference'
    || file.disposition === 'intermediate'
    || file.source === 'user-upload'
  ) return false;
  const hasLocation = Boolean(
    normalizeText(file.filePath)
    || normalizeText(file.gatewayUrl)
    || normalizeText(file.preview),
  );
  if (!hasLocation) return false;
  if (file.source === 'gateway-media') return true;
  if (file.source === 'message-ref' || file.source === 'tool-result') {
    return file.fileSize > 0 || Boolean(normalizeText(file.preview));
  }
  return file.fileSize > 0
    || Boolean(normalizeText(file.preview))
    || Boolean(normalizeText(file.gatewayUrl))
    || Boolean(normalizeText(file.filePath));
}

export function hasDeliveredArtifactEvidence(
  run: ChatRuntimeRunState | undefined,
  pendingFiles: AttachedFileMeta[],
): boolean {
  const hasPendingAttachment = pendingFiles.some((file) => (
    hasCanonicalArtifactEvidence(file)
    && !file.error
    && (
      file.availability === 'available'
      || file.fileSize > 0
      || Boolean(normalizeText(file.gatewayUrl))
      || Boolean(normalizeText(file.preview))
    )
  ));
  if (hasPendingAttachment) return true;

  const passedArtifactIds = new Set(
    (run?.verifications ?? [])
      .filter((verification) => verification.status === 'passed' && verification.artifactId)
      .map((verification) => verification.artifactId as string),
  );
  return (run?.artifacts ?? []).some((artifact) => passedArtifactIds.has(artifact.id));
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

function buildBase(
  base: RuntimeEventBase,
): Pick<
  ChatRuntimeEvent,
  | 'contractVersion'
  | 'producer'
  | 'runId'
  | 'rootRunId'
  | 'sessionKey'
  | 'taskId'
  | 'parentTaskId'
  | 'toolCallId'
  | 'ts'
> {
  return {
    contractVersion: CHAT_RUNTIME_CONTRACT_VERSION,
    producer: base.producer ?? 'renderer',
    runId: base.runId,
    rootRunId: base.rootRunId,
    sessionKey: base.sessionKey,
    taskId: base.taskId,
    parentTaskId: base.parentTaskId,
    toolCallId: base.toolCallId,
    ts: base.ts ?? Date.now(),
  };
}

/**
 * Seeds only observable run state. Completion is owned by the native run/task
 * lifecycle, not by renderer-authored completion authority.
 */
export function buildRuntimeStartEvents(
  run: ChatRuntimeRunState | undefined,
  base: RuntimeEventBase & {
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

  return events;
}

export function buildRuntimeArtifactEventsFromAttachedFiles(
  base: RuntimeEventBase & {
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
    if (!hasCanonicalArtifactEvidence(file)) continue;
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
      availability: file.error
        ? 'error'
        : file.availability
        ?? (file.fileSize > 0 || file.gatewayUrl || file.preview ? 'available' : 'registered'),
      error: file.error,
      stepId: normalizeText(base.stepId),
      taskId: normalizeText(base.taskId),
      sourceToolCallId: normalizeText(base.toolCallId),
      source: file.source,
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
        ? (base.verificationDetail ?? '产物已进入 UClaw 的消息产物卡片，等待可用性验证。')
        : '已识别产物路径，等待可用性验证。',
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
  base: RuntimeEventBase,
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
      taskId: input.artifact.taskId ?? runBase.taskId,
      evidence: input.evidence,
      source: input.artifact.source ?? runBase.producer,
    },
  };
}
