import type {
  ChatRuntimeArtifact,
  ChatRuntimeEvent,
  ChatRuntimeGateEvaluation,
  ChatRuntimeVerification,
} from './chat-runtime-events';

export const COMPOSITE_RUN_SCHEMA_VERSION = 1;

export type CompositeRunTaskKind =
  | 'image_generate'
  | 'presentation'
  | 'spreadsheet'
  | 'video_generate'
  | 'image_edit'
  | 'mini_program'
  | 'copywriting'
  | 'blender_scene';

const LOCAL_ARTIFACT_TASK_KINDS = new Set<CompositeRunTaskKind>([
  'presentation',
  'spreadsheet',
  'mini_program',
  'copywriting',
]);

export function isLocalArtifactTaskKind(kind: CompositeRunTaskKind): boolean {
  return LOCAL_ARTIFACT_TASK_KINDS.has(kind);
}

/**
 * Blender is a deterministic artifact producer, but it owns a separate
 * Main-process queue because rendering competes for GPU and memory.
 */
export function isBlenderSceneTaskKind(kind: CompositeRunTaskKind): boolean {
  return kind === 'blender_scene';
}

export function isDeterministicArtifactTaskKind(kind: CompositeRunTaskKind): boolean {
  return isLocalArtifactTaskKind(kind) || isBlenderSceneTaskKind(kind);
}

export function isSupportedCompositeRunTaskSet(
  tasks: ReadonlyArray<Pick<CompositeRunTaskInput, 'kind'>>,
): boolean {
  if (tasks.length >= 2) return true;
  return tasks.length === 1 && isDeterministicArtifactTaskKind(tasks[0].kind);
}

export type CompositeRunImageRef = {
  fileName?: string;
  mimeType?: string;
  filePath: string;
};

export type CompositeRunTextLengthRequirement = {
  unit: 'characters';
  targetCharacters: number;
  minimumCharacters: number;
  approximate: boolean;
};

export type CompositeRunTaskInput = {
  id: string;
  kind: CompositeRunTaskKind;
  title: string;
  prompt: string;
  requiresArtifact?: boolean;
  dependsOn?: string[];
  fallback?: string;
  textLengthRequirement?: CompositeRunTextLengthRequirement;
  selectedImageSource?: 'explicit' | 'candidate' | 'none';
  selectedImageIndex?: number;
  sourceImages?: CompositeRunImageRef[];
  /** Untrusted planner output; the Blender Main-process validator is authoritative. */
  sceneSpec?: Record<string, unknown>;
};

export type CompositeRunImageOptions = {
  model?: string;
  size?: string;
  quality?: 'low' | 'medium' | 'high';
};

export type CompositeRunVideoOptions = {
  model?: string;
  size?: string;
  durationSeconds?: number;
};

export type CompositeRunStartRequest = {
  clientRequestId: string;
  sessionKey: string;
  prompt: string;
  cwd?: string;
  requestedMode?: 'chat' | 'image' | 'video';
  userMessageTimestampMs?: number;
  tasks: CompositeRunTaskInput[];
  imageOptions?: CompositeRunImageOptions;
  videoOptions?: CompositeRunVideoOptions;
};

export type CompositeRunTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export type CompositeRunTaskRecord = CompositeRunTaskInput & {
  status: CompositeRunTaskStatus;
  attempt: number;
  automaticRetryCount: number;
  autoRetrySafe?: boolean;
  recoverable?: boolean;
  error?: string;
  jobId?: string;
  plannedRequest?: Record<string, unknown>;
  artifactIds: string[];
  startedAt?: number;
  completedAt?: number;
};

export type CompositeRunStatus =
  | 'planned'
  | 'running'
  | 'finalizing'
  | 'completed'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type CompositeRunDeliveryState = {
  status: 'pending' | 'writing' | 'succeeded' | 'failed' | 'skipped';
  generation: number;
  assistantMessageId: string;
  attempts: number;
  text?: string;
  error?: string;
  persistedAt?: number;
};

export type CompositeRunManifest = {
  version: 2;
  runId: string;
  requestedTaskCount: number;
  runStatus: 'running' | 'completed' | 'error' | 'aborted';
  runtimeEvents: ChatRuntimeEvent[];
  tasks: Array<{
    id: string;
    kind: string;
    title: string;
    status: 'completed' | 'failed' | 'blocked';
    detail?: string;
    artifactRefs: string[];
  }>;
};

export type CompositeRunRecord = {
  version: typeof COMPOSITE_RUN_SCHEMA_VERSION;
  revision: number;
  runId: string;
  clientRequestId: string;
  sessionKey: string;
  prompt: string;
  cwd?: string;
  requestedMode: 'chat' | 'image' | 'video';
  userMessageTimestampMs: number;
  imageOptions?: CompositeRunImageOptions;
  videoOptions?: CompositeRunVideoOptions;
  status: CompositeRunStatus;
  tasks: CompositeRunTaskRecord[];
  artifacts: ChatRuntimeArtifact[];
  verifications: ChatRuntimeVerification[];
  gate?: ChatRuntimeGateEvaluation;
  delivery: CompositeRunDeliveryState;
  manifest?: CompositeRunManifest;
  runtimeEvents: ChatRuntimeEvent[];
  lastSeq: number;
  createdAt: number;
  updatedAt: number;
};

export type CompositeRunJournalEvent = {
  version: 1;
  runId: string;
  seq: number;
  ts: number;
  type: string;
  taskId?: string;
  data?: Record<string, unknown>;
  runtimeEvent?: ChatRuntimeEvent;
  snapshot?: CompositeRunRecord;
};

export type CompositeRunRetryRequest = {
  taskIds?: string[];
};

export type CompositeRunCancelRequest = {
  source?: string;
};

export type CompositeRunCancelOutcome = 'cancelled' | 'already_terminal' | 'not_found';

export type CompositeRunCancelResult = {
  outcome: CompositeRunCancelOutcome;
  run?: CompositeRunRecord;
};

export type CompositeRunRetryOutcome = 'retry_started' | 'no_match' | 'not_retryable' | 'not_found';

export type CompositeRunRetryResult = {
  outcome: CompositeRunRetryOutcome;
  run?: CompositeRunRecord;
  retriedTaskIds?: string[];
  deliveryOnly?: boolean;
};

export type CompositeRunApiResponse = {
  success: boolean;
  run?: CompositeRunRecord;
  runs?: CompositeRunRecord[];
  idempotent?: boolean;
  outcome?: CompositeRunCancelOutcome | CompositeRunRetryOutcome;
  retriedTaskIds?: string[];
  deliveryOnly?: boolean;
  error?: string;
};

export function isCompositeRunTerminal(status: CompositeRunStatus): boolean {
  return status === 'completed' || status === 'partial' || status === 'failed' || status === 'cancelled';
}
