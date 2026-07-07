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
  prompt: string;
  model?: string;
  size?: string;
  quality?: 'low' | 'medium' | 'high';
  inputImages?: MediaGenerationInputImageRef[];
};

export type VideoGenerationJobPayload = {
  kind: 'video';
  sessionKey: string;
  prompt: string;
  originalPrompt?: string;
  size?: string;
  durationSeconds?: number;
  inputImages?: MediaGenerationInputImageRef[];
  route?: VideoGenerationRouteDecision;
};

export type MediaGenerationJobPayload = ImageGenerationJobPayload | VideoGenerationJobPayload;

export type MediaGenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

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
  status: MediaGenerationJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: unknown;
};
