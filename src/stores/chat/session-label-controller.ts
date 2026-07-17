import { hostApiFetch } from '@/lib/host-api';
import type { ChatSession, ChatState } from './types';

type ChatSet = (
  partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>),
  replace?: false,
) => void;

type ChatGet = () => ChatState;

const SESSION_RENAME_DEDUPE_TTL_MS = 60_000;
const sessionRenameInFlight = new Map<string, Promise<void>>();
const sessionRenameLastPersisted = new Map<string, { label: string; at: number }>();

export type SessionLabelSummary = {
  sessionKey: string;
  firstUserText: string | null;
  lastTimestamp: number | null;
};

/** Resolve the activity timestamp used to prioritize label hydration. */
export function getSessionLabelHydrationActivityMs(
  session: ChatSession,
  sessionLastActivity: Record<string, number>,
): number {
  const localActivity = sessionLastActivity[session.key];
  if (typeof localActivity === 'number' && Number.isFinite(localActivity)) return localActivity;
  return typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)
    ? session.updatedAt
    : 0;
}

function cleanSessionLabelText(text: string): string {
  return text
    .replace(/^Sender\s*\([^)]*\)\s*:\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
    .replace(/^Sender\s*\([^)]*\)\s*:\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/^Sender\s*\([^)]*\)\s*:\s*[^\n]*(?:\n\s*)*/i, '')
    .replace(/^Sender\s*:\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
    .replace(/^Sender\s*:\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/^Sender\s*:\s*[^\n]*(?:\n\s*)*/i, '')
    .replace(/^```json\n[\s\S]*?```\s*/i, '')
    .replace(/^\{[\s\S]*?\}\s*/i, '')
    .replace(/\s*\[media attached:[^\]]*\]/g, '')
    .replace(/\s*\[message_id:\s*[^\]]+\]/g, '')
    .replace(/^Conversation info\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
    .replace(/^Conversation info\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\]]+\]\s*/i, '')
    .trim();
}

/** Convert transcript user text into the compact sidebar label format. */
export function toSessionLabel(text: string, maxLength = 50): string {
  const cleaned = cleanSessionLabelText(text).trim();
  if (!cleaned) return '';
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

function getSessionBackendLabel(session: ChatSession): string {
  return toSessionLabel(session.label || session.derivedTitle || '');
}

/** Seed missing local labels from authoritative session rows without overwriting user labels. */
export function applySessionBackendLabels(set: ChatSet, sessions: ChatSession[]): void {
  const labels = Object.fromEntries(
    sessions
      .filter((session) => !session.key.endsWith(':main'))
      .map((session) => [session.key, getSessionBackendLabel(session)] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  if (Object.keys(labels).length === 0) return;
  set((state) => ({
    sessionLabels: {
      ...state.sessionLabels,
      ...Object.fromEntries(Object.entries(labels).filter(([key]) => !state.sessionLabels[key])),
    },
  }));
}

/** Persist one rename while deduplicating concurrent and recently completed requests. */
export async function persistSessionRenameOnce(key: string, label: string): Promise<void> {
  const cacheKey = `${key}\n${label}`;
  const now = Date.now();
  const recent = sessionRenameLastPersisted.get(key);
  if (recent?.label === label && now - recent.at < SESSION_RENAME_DEDUPE_TTL_MS) return;

  const existing = sessionRenameInFlight.get(cacheKey);
  if (existing) {
    await existing;
    return;
  }

  const promise = (async () => {
    const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/sessions/rename', {
      method: 'POST',
      body: JSON.stringify({ sessionKey: key, label }),
    });
    if (!result.success) throw new Error(result.error || 'Failed to rename session');
    sessionRenameLastPersisted.set(key, { label, at: Date.now() });
  })().finally(() => {
    sessionRenameInFlight.delete(cacheKey);
  });

  sessionRenameInFlight.set(cacheKey, promise);
  await promise;
}

/** Read first-user labels and last activity for a bounded session set. */
export async function fetchSessionLabelSummaries(sessionKeys: string[]): Promise<SessionLabelSummary[]> {
  if (sessionKeys.length === 0) return [];
  const response = await hostApiFetch<{ success?: boolean; summaries?: SessionLabelSummary[] }>(
    '/api/sessions/summaries',
    {
      method: 'POST',
      body: JSON.stringify({ sessionKeys }),
    },
  );
  return Array.isArray(response?.summaries) ? response.summaries : [];
}

/** Merge transcript summaries without replacing an existing user or backend label. */
export function applySessionLabelSummaries(set: ChatSet, summaries: SessionLabelSummary[]): void {
  if (summaries.length === 0) return;
  set((state) => {
    let nextLabels = state.sessionLabels;
    let nextActivity = state.sessionLastActivity;
    let changed = false;

    for (const summary of summaries) {
      const labelText = toSessionLabel(summary.firstUserText || '');
      const existingLabel = nextLabels[summary.sessionKey]?.trim();
      if (labelText && !existingLabel) {
        if (nextLabels === state.sessionLabels) nextLabels = { ...state.sessionLabels };
        nextLabels[summary.sessionKey] = labelText;
        changed = true;
      }

      if (typeof summary.lastTimestamp === 'number' && Number.isFinite(summary.lastTimestamp)) {
        if (nextActivity[summary.sessionKey] !== summary.lastTimestamp) {
          if (nextActivity === state.sessionLastActivity) nextActivity = { ...state.sessionLastActivity };
          nextActivity[summary.sessionKey] = summary.lastTimestamp;
          changed = true;
        }
      }
    }

    return changed
      ? { sessionLabels: nextLabels, sessionLastActivity: nextActivity }
      : {};
  });
}

/** Refresh summaries only for sessions that remain visible when the response returns. */
export async function refreshVisibleSessionSummaries(
  set: ChatSet,
  get: ChatGet,
  sessionKeys?: string[],
): Promise<void> {
  const sessions = get().sessions;
  const currentSessionKey = get().currentSessionKey;
  const knownSessionKeys = new Set(sessions.map((session) => session.key));
  const targetKeys = (sessionKeys?.length ? sessionKeys : sessions.map((session) => session.key))
    .filter((key) => key && !key.endsWith(':main') && key !== currentSessionKey);
  if (targetKeys.length === 0) return;

  try {
    const summaries = await fetchSessionLabelSummaries(targetKeys);
    const currentKnownSessionKeys = new Set(get().sessions.map((session) => session.key));
    applySessionLabelSummaries(
      set,
      summaries.filter((summary) => (
        knownSessionKeys.has(summary.sessionKey)
        && currentKnownSessionKeys.has(summary.sessionKey)
      )),
    );
  } catch (error) {
    console.warn('[session summaries] refresh failed:', error);
  }
}
