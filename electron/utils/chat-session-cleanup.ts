import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { resolveOpenClawStateDir } from './paths';
import { logger } from './logger';
import { removeSessionEntry, resolveSessionTranscriptPath, sweepSessionArtefacts } from './session-files';

const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Remove a temporary local OpenClaw session and all transcript sidecars. */
export async function deleteLocalChatSession(sessionKey: string): Promise<void> {
  const parts = sessionKey.split(':');
  if (parts[0] !== 'agent' || parts.length < 3) return;
  const agentId = parts[1] || '';
  const sessionSuffix = parts.slice(2).join(':');
  if (!SAFE_SESSION_SEGMENT.test(agentId) || !SAFE_SESSION_SEGMENT.test(sessionSuffix)) return;

  const sessionsDir = join(resolveOpenClawStateDir(), 'agents', agentId, 'sessions');
  const sessionsJsonPath = join(sessionsDir, 'sessions.json');
  let sessions: Record<string, unknown>;
  try {
    sessions = JSON.parse(await fs.readFile(sessionsJsonPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : '';
    if (code === 'ENOENT') return;
    throw error;
  }

  // Resolve through sessions.json so UUID-backed transcripts are removed safely.
  const resolution = resolveSessionTranscriptPath(sessions, sessionsDir, sessionKey);
  const sweep = resolution.ok
    ? await sweepSessionArtefacts(resolution.sessionsDirAbs, resolution.baseId)
    : resolution.failure.kind === 'not-found'
      ? await sweepSessionArtefacts(sessionsDir, sessionSuffix)
      : null;
  if (!resolution.ok && resolution.failure.kind === 'path-outside-scope') {
    logger.warn(`[chat-session-cleanup] Refusing out-of-scope path for "${sessionKey}": ${resolution.failure.resolvedPath}`);
  }
  for (const failure of sweep?.errors ?? []) {
    logger.warn(`[chat-session-cleanup] Failed to unlink ${failure.path}: ${String(failure.error)}`);
  }

  removeSessionEntry(sessions, sessionKey);
  await fs.writeFile(sessionsJsonPath, `${JSON.stringify(sessions, null, 2)}\n`, 'utf8');
}
