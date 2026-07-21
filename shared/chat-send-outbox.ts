export const CHAT_SEND_OUTBOX_SCHEMA_VERSION = 1 as const;

export type ChatSendOutboxMode = 'chat' | 'image' | 'video';

export type ChatSendOutboxAttachment = {
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;
};

export type ChatSendOutboxItem = {
  version: typeof CHAT_SEND_OUTBOX_SCHEMA_VERSION;
  id: string;
  sessionKey: string;
  turnId: string;
  idempotencyKey: string;
  userMessageId: string;
  acceptedAt: number;
  expiresAt: number;
  text: string;
  targetAgentId?: string;
  mode: ChatSendOutboxMode;
  imageOptions?: {
    model?: string;
    size: string;
    quality: string;
  };
  videoOptions?: {
    model?: string;
    size: string;
    durationSeconds: number;
  };
  thinkingLevel?: string;
  attachments: ChatSendOutboxAttachment[];
  referenceImages: ChatSendOutboxAttachment[];
};

export type ChatSendOutboxRejectedItem = ChatSendOutboxItem & {
  error: string;
};

export type ChatSendOutboxListResult = {
  durable: boolean;
  items: ChatSendOutboxItem[];
  rejected: ChatSendOutboxRejectedItem[];
};
