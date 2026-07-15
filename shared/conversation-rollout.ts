export const CONVERSATION_TIMELINE_MODES = ['legacy', 'shadow', 'timeline'] as const;

export type ConversationTimelineMode = (typeof CONVERSATION_TIMELINE_MODES)[number];

export function normalizeConversationTimelineMode(value: unknown): ConversationTimelineMode | null {
  return typeof value === 'string'
    && CONVERSATION_TIMELINE_MODES.includes(value.trim().toLowerCase() as ConversationTimelineMode)
    ? value.trim().toLowerCase() as ConversationTimelineMode
    : null;
}

/** Main-owned startup override wins over remote rollout; Timeline is the safe default. */
export function resolveConversationTimelineMode(
  startupOverride: unknown,
  remoteRollout: unknown,
): ConversationTimelineMode {
  return normalizeConversationTimelineMode(startupOverride)
    ?? normalizeConversationTimelineMode(remoteRollout)
    ?? 'timeline';
}
