export type MediaGenerationKind = 'image' | 'video';

export type MediaGenerationInputImageRef = {
  fileName?: string;
  mimeType?: string;
  filePath: string;
};

export type VideoGenerationRouteMode =
  | 'text_to_video'
  | 'image_to_video'
  | 'edit_image_then_video';

export type VideoGenerationImageSource =
  | 'explicit'
  | 'candidate'
  | 'none';

export type VideoGenerationRouteDecision = {
  mode: VideoGenerationRouteMode;
  confidence?: number;
  reason?: string;
  source?: 'router' | 'fallback';
  selectedImageSource?: VideoGenerationImageSource;
  selectedImageIndex?: number;
  videoPrompt?: string;
  imageEditPrompt?: string;
  sourceImages?: MediaGenerationInputImageRef[];
};

export type ImageGenerationJobPayload = {
  kind: 'image';
  sessionKey: string;
  clientRequestId?: string;
  originalPrompt?: string;
  prompt: string;
  model?: string;
  size?: string;
  quality?: 'low' | 'medium' | 'high';
  inputImages?: MediaGenerationInputImageRef[];
  userInputImages?: MediaGenerationInputImageRef[];
  userMessageTimestampMs?: number;
  suppressConversationAppend?: boolean;
  runId?: string;
};

export type VideoGenerationJobPayload = {
  kind: 'video';
  sessionKey: string;
  clientRequestId?: string;
  prompt: string;
  originalPrompt?: string;
  model?: string;
  size?: string;
  durationSeconds?: number;
  inputImages?: MediaGenerationInputImageRef[];
  userInputImages?: MediaGenerationInputImageRef[];
  userMessageTimestampMs?: number;
  route?: VideoGenerationRouteDecision;
  suppressConversationAppend?: boolean;
  runId?: string;
};

export type MediaGenerationJobPayload = ImageGenerationJobPayload | VideoGenerationJobPayload;

// Kept as the generation lifecycle for existing API consumers.
export type MediaGenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type MediaGenerationDeliveryStatus = 'pending' | 'succeeded' | 'failed' | 'skipped';

export type MediaGenerationProgressEvent = {
  id: string;
  source: 'job' | 'worker' | 'runtime' | 'plugin';
  event: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  timestampMs: number;
  detail?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
};

export type MediaGenerationJobOutput = {
  path?: string;
  url?: string;
  mimeType?: string;
  size?: number;
  fileName?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  metadata?: Record<string, unknown>;
  outputIndex?: number;
};

export type MediaGenerationJobResult = {
  ok?: boolean;
  outputs?: MediaGenerationJobOutput[];
  metadata?: Record<string, unknown>;
};

export type MediaGenerationRestartRecovery = {
  previousStatus: 'queued' | 'running';
  recoveredAt: number;
  reason: 'main_process_restart';
};

export type MediaGenerationJobCancelOutcome =
  | 'cancelled'
  | 'already_cancelled'
  | 'already_terminal'
  | 'not_found';

export type MediaGenerationJobCancelResult = {
  outcome: MediaGenerationJobCancelOutcome;
  job?: MediaGenerationJobSnapshot;
};

export type MediaGenerationJobDeliveryRetryOutcome =
  | 'retry_started'
  | 'already_in_progress'
  | 'not_retryable'
  | 'not_found';

export type MediaGenerationJobDeliveryRetryResult = {
  outcome: MediaGenerationJobDeliveryRetryOutcome;
  job?: MediaGenerationJobSnapshot;
};

export type MediaGenerationJobEnqueueResult = {
  job: MediaGenerationJobSnapshot;
  idempotent: boolean;
};

export type MediaGenerationWorkerRequest = {
  type: 'run';
  jobId: string;
  payload: MediaGenerationJobPayload;
};

export type MediaGenerationWorkerResponse = {
  type: 'result';
  jobId: string;
  success: boolean;
  result?: unknown;
  error?: string;
};

export type MediaGenerationJobSnapshot = {
  id: string;
  kind: MediaGenerationKind;
  sessionKey: string;
  clientRequestId?: string;
  runId?: string;
  ownerKind?: 'standalone' | 'composite';
  status: MediaGenerationJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  queuePosition?: number;
  activeJobs?: number;
  maxActiveJobs?: number;
  queueWaitMs?: number;
  runDurationMs?: number;
  progressEvents?: MediaGenerationProgressEvent[];
  error?: string;
  deliveryStatus?: MediaGenerationDeliveryStatus;
  deliveryError?: string;
  recoverable?: boolean;
  restartRecovery?: MediaGenerationRestartRecovery;
  outputs?: MediaGenerationJobOutput[];
  result?: MediaGenerationJobResult | unknown;
};
