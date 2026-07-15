import type {
  ChatSendAttachment,
  ChatSendMode,
  ChatSendReplayIntent,
  GatewayTurnPreferences,
} from './types';

/** Immutable input snapshot used only to repeat a user send exactly. */
export type ChatSendIntent = ChatSendReplayIntent & {
  text: string;
  attachments?: ChatSendAttachment[];
  targetAgentId?: string | null;
  mode: ChatSendMode;
  recordedAt: number;
};

export type ChatSendIntentInput = Omit<ChatSendIntent, 'recordedAt'> & {
  recordedAt?: number;
};

function cloneAttachments(attachments: ChatSendAttachment[] | undefined): ChatSendAttachment[] | undefined {
  return attachments?.map((attachment) => ({ ...attachment }));
}

export function cloneGatewayTurnPreferences(
  preferences: GatewayTurnPreferences,
): GatewayTurnPreferences {
  return {
    ...preferences,
    image: preferences.image ? { ...preferences.image } : undefined,
    video: preferences.video ? { ...preferences.video } : undefined,
    selectedArtifacts: preferences.selectedArtifacts?.map((artifact) => ({ ...artifact })),
  };
}

export function cloneChatSendReplayIntent(intent: ChatSendReplayIntent): ChatSendReplayIntent {
  return {
    imageOptions: intent.imageOptions ? { ...intent.imageOptions } : undefined,
    videoOptions: intent.videoOptions ? { ...intent.videoOptions } : undefined,
    thinkingLevel: intent.thinkingLevel,
    referenceImages: cloneAttachments(intent.referenceImages) ?? [],
    clientPreferences: cloneGatewayTurnPreferences(intent.clientPreferences),
  };
}

/** Copy all mutable send inputs while deliberately excluding runtime lifecycle state. */
export function createChatSendIntent(input: ChatSendIntentInput): ChatSendIntent {
  const replay = cloneChatSendReplayIntent(input);
  return {
    text: input.text,
    attachments: cloneAttachments(input.attachments),
    targetAgentId: input.targetAgentId,
    mode: input.mode,
    ...replay,
    recordedAt: input.recordedAt ?? Date.now(),
  };
}

export function cloneChatSendIntent(intent: ChatSendIntent): ChatSendIntent {
  return createChatSendIntent(intent);
}
