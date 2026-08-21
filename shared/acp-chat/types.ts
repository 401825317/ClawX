import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AcpChatErrorCode } from './errors';

export type AcpJsonRecord = Record<string, unknown>;

export type AcpSessionKeyPayload = {
  sessionKey: string;
};

export type AcpChatLoadPayload = AcpSessionKeyPayload & {
  workspaceRoot: string;
  cwd: string;
  createIfMissing?: boolean;
};

export type AcpPromptMediaItem = {
  filePath: string;
  stagingId: string;
  fileName?: string;
  mimeType?: string;
};

/** Per-turn image constraints selected in the composer. */
export type AcpImageGenerationOptions = {
  modelId: string;
  size: string;
  quality: string;
  preset?: 'ecommerce-main-image';
};

/** Per-turn video constraints selected in the composer. */
export type AcpVideoGenerationOptions = {
  modelId: string;
  /** Exact upstream dimensions; display resolution must never replace this value. */
  size: string;
  mode: string;
  aspectRatio: string;
  resolution?: string;
  durationSeconds: number;
};

export type AcpChatPromptPayload = AcpSessionKeyPayload & {
  cwd: string;
  message?: string;
  media?: AcpPromptMediaItem[];
  messageId?: string;
  /** Renderer-observed prompt start used only for bounded latency diagnostics. */
  clientStartedAtMs?: number;
  /** Applied only if the model elects to call OpenClaw's image_generate tool. */
  imageOptions?: AcpImageGenerationOptions;
  /** Applied only if the model elects to call OpenClaw's video_generate tool. */
  videoOptions?: AcpVideoGenerationOptions;
};

export type AcpChatCancelPayload = AcpSessionKeyPayload;

export type AcpChatRespondPermissionPayload = AcpSessionKeyPayload & {
  requestId: string;
  outcome: RequestPermissionResponse['outcome'];
};

export type AcpChatOperationResult = {
  success: boolean;
  error?: string;
  /** Stable failure category used by the renderer to choose copy and recovery actions. */
  errorCode?: AcpChatErrorCode;
  /** True only when repeating the request can reasonably recover without user configuration changes. */
  retryable?: boolean;
  httpStatus?: number;
  upstreamCode?: string;
  generation?: number;
  /** The requested session still has a live prompt and was reactivated without history replay. */
  resumedActivePrompt?: boolean;
  /** Raw notifications collected while session/load is in progress. */
  sessionUpdates?: AcpSessionUpdateEnvelope[];
};

export type AcpSessionUpdateEnvelope = {
  sessionKey: string;
  generation: number;
  /** True for ACP updates emitted while session/load is replaying history. */
  historical?: boolean;
  notification: SessionNotification;
};

export type AcpPermissionRequestEnvelope = {
  sessionKey: string;
  generation: number;
  requestId: string;
  request: RequestPermissionRequest;
};

export type AcpPromptContentBlock = ContentBlock;

/** Terminal failure update emitted when ACP rejects a prompt without recording one. */
export type AcpTurnFailureUpdate = {
  sessionUpdate: 'uclaw_turn_failure';
  userMessageId: string;
  errorMessage: string;
  errorCode?: AcpChatErrorCode;
  retryable?: boolean;
  httpStatus?: number;
  upstreamCode?: string;
};
