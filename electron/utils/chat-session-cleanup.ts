import { promises as fsP } from 'node:fs';
import { join } from 'node:path';
import { getOpenClawConfigDir } from './paths';
import {
  removeSessionEntry,
  resolveSessionTranscriptPath,
  sweepSessionArtefacts,
} from './session-files';
import { logger } from './logger';

const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export async function deleteLocalChatSession(sessionKey: string): Promise<void> {
  if (!sessionKey.startsWith('agent:')) return;
  const parts = sessionKey.split(':');
  if (parts.length < 3) return;
  const agentId = parts[1];
  const sessionSuffix = parts.slice(2).join(':');
  if (!SAFE_SESSION_SEGMENT.test(agentId) || !SAFE_SESSION_SEGMENT.test(sessionSuffix)) return;

  const sessionsDir = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions');
  const sessionsJsonPath = join(sessionsDir, 'sessions.json');

  let sessionsJson: Record<string, unknown>;
  try {
    const raw = await fsP.readFile(sessionsJsonPath, 'utf8');
    sessionsJson = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : '';
    if (code === 'ENOENT') return;
    throw error;
  }

  const resolution = resolveSessionTranscriptPath(sessionsJson, sessionsDir, sessionKey);
  if (resolution.ok) {
    const sweep = await sweepSessionArtefacts(resolution.sessionsDirAbs, resolution.baseId);
    for (const { path: failedPath, error } of sweep.errors) {
      logger.warn(`[chat-session-cleanup] Failed to unlink ${failedPath}: ${String(error)}`);
    }
  } else if (resolution.failure.kind === 'not-found') {
    const sweep = await sweepSessionArtefacts(sessionsDir, sessionSuffix);
    for (const { path: failedPath, error } of sweep.errors) {
      logger.warn(`[chat-session-cleanup] Failed to unlink ${failedPath}: ${String(error)}`);
    }
  } else {
    logger.warn(`[chat-session-cleanup] Refusing out-of-scope path for "${sessionKey}": ${resolution.failure.resolvedPath}`);
  }

  removeSessionEntry(sessionsJson, sessionKey);
  await fsP.writeFile(sessionsJsonPath, JSON.stringify(sessionsJson, null, 2), 'utf8');
}
