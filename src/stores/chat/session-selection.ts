import { isCronSessionKey } from './cron-session-utils';
import type { ChatSession } from './types';

export const CURRENT_SESSION_STORAGE_KEY = 'clawx:chat:current-session-key';
const MAX_SESSION_KEY_LENGTH = 2_048;
const INTERNAL_HEARTBEAT_SESSION_KEY_RE = /^agent:[^:\s]+:[^:\s]+(?::[^:\s]+)*:heartbeat$/;

export function isCanonicalSessionKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_SESSION_KEY_LENGTH
    && /^agent:[^:\s]+:[^:\s]+(?::[^:\s]+)*$/.test(value);
}

export function isInternalHeartbeatSession(
  session: string | Pick<ChatSession, 'key' | 'heartbeatIsolatedBaseSessionKey'>,
): boolean {
  const key = typeof session === 'string' ? session : session.key;
  if (INTERNAL_HEARTBEAT_SESSION_KEY_RE.test(key)) return true;
  return typeof session !== 'string'
    && typeof session.heartbeatIsolatedBaseSessionKey === 'string'
    && session.heartbeatIsolatedBaseSessionKey.trim().length > 0;
}

function getLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readPersistedCurrentSessionKey(): string | null {
  const storage = getLocalStorage();
  if (!storage) return null;

  try {
    const value = storage.getItem(CURRENT_SESSION_STORAGE_KEY);
    if (value == null) return null;
    if (isCanonicalSessionKey(value) && !isInternalHeartbeatSession(value)) return value;
    storage.removeItem(CURRENT_SESSION_STORAGE_KEY);
  } catch {
    // localStorage can be unavailable in restricted renderer contexts.
  }
  return null;
}

export function persistCurrentSessionKey(sessionKey: string): void {
  const storage = getLocalStorage();
  if (!storage) return;

  try {
    if (isCanonicalSessionKey(sessionKey) && !isInternalHeartbeatSession(sessionKey)) {
      storage.setItem(CURRENT_SESSION_STORAGE_KEY, sessionKey);
    } else {
      storage.removeItem(CURRENT_SESSION_STORAGE_KEY);
    }
  } catch {
    // Session selection must keep working when localStorage is unavailable.
  }
}

function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  const [, agentId] = sessionKey.split(':');
  return agentId || 'main';
}

function sortByUpdatedAtDesc(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/**
 * When the current session key is missing from `sessions.list`, pick a safer
 * replacement than `sessions[0]`. Cron/heartbeat sessions must never become
 * the implicit startup target just because they sort first in the gateway list.
 */
export function pickStartupSessionFallback(
  currentSessionKey: string,
  sessions: ChatSession[],
): string | null {
  const visibleSessions = sessions.filter((session) => !isInternalHeartbeatSession(session));
  if (visibleSessions.length === 0) return null;

  const agentId = getAgentIdFromSessionKey(currentSessionKey);
  const agentMainKey = `agent:${agentId}:main`;
  const agentMain = visibleSessions.find((session) => session.key === agentMainKey);
  if (agentMain) return agentMain.key;

  const agentNonCron = sortByUpdatedAtDesc(
    visibleSessions.filter((session) => session.key.startsWith(`agent:${agentId}:`) && !isCronSessionKey(session.key)),
  );
  if (agentNonCron.length > 0) return agentNonCron[0]!.key;

  const nonCron = sortByUpdatedAtDesc(visibleSessions.filter((session) => !isCronSessionKey(session.key)));
  if (nonCron.length > 0) return nonCron[0]!.key;

  return null;
}
