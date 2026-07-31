import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveOpenClawStateDir } from './paths';
import { resolveSessionTranscriptPath } from './session-files';

const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
type SessionsJson = Record<string, unknown>;
type SessionRecord = Record<string, unknown>;

function parseAgentIdFromSessionKey(sessionKey: string): string {
  const parts = sessionKey.split(':');
  const agentId = parts[0] === 'agent' && parts.length >= 3 ? parts[1]?.trim() || '' : '';
  if (!SAFE_SESSION_SEGMENT.test(agentId)) throw new Error(`Invalid sessionKey: ${sessionKey}`);
  return agentId;
}

async function readSessionsJson(path: string): Promise<SessionsJson> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SessionsJson : {};
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : '';
    if (code === 'ENOENT') return {};
    throw error;
  }
}

function findExistingSessionRecord(sessions: SessionsJson, sessionKey: string): SessionRecord | null {
  const direct = sessions[sessionKey];
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as SessionRecord;
  if (!Array.isArray(sessions.sessions)) return null;
  return (sessions.sessions as SessionRecord[])
    .find((entry) => entry.key === sessionKey || entry.sessionKey === sessionKey) ?? null;
}

function upsertSessionRecord(sessions: SessionsJson, sessionKey: string, record: SessionRecord): void {
  if (!Array.isArray(sessions.sessions)) {
    sessions[sessionKey] = record;
    return;
  }
  const entries = sessions.sessions as SessionRecord[];
  const index = entries.findIndex((entry) => entry.key === sessionKey || entry.sessionKey === sessionKey);
  if (index >= 0) {
    entries[index] = { ...entries[index], ...record, key: sessionKey };
    return;
  }
  entries.push({ key: sessionKey, ...record });
}

async function readLastTranscriptMessageId(transcriptPath: string): Promise<string | null> {
  try {
    const lines = (await fs.readFile(transcriptPath, 'utf8')).split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const entry = JSON.parse(lines[index]) as { type?: unknown; id?: unknown };
        if (entry.type === 'message' && typeof entry.id === 'string' && entry.id.trim()) return entry.id;
      } catch {
        // Ignore malformed historical lines and preserve the valid transcript tail.
      }
    }
    return null;
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : '';
    if (code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureTranscriptHeader(transcriptPath: string, sessionId: string): Promise<void> {
  await fs.mkdir(dirname(transcriptPath), { recursive: true });
  try {
    if ((await fs.stat(transcriptPath)).size > 0) return;
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : '';
    if (code !== 'ENOENT') throw error;
  }
  await fs.writeFile(transcriptPath, `${JSON.stringify({
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  })}\n`, 'utf8');
}

/** Append the generated welcome text to the Agent's canonical main session. */
export async function appendAgentWelcomeMessage(params: {
  sessionKey: string;
  content: string;
  label?: string;
}): Promise<void> {
  const sessionKey = params.sessionKey.trim();
  const content = params.content.trim();
  if (!sessionKey || !content) throw new Error('sessionKey and content are required');

  const agentId = parseAgentIdFromSessionKey(sessionKey);
  const sessionsDir = join(resolveOpenClawStateDir(), 'agents', agentId, 'sessions');
  const sessionsJsonPath = join(sessionsDir, 'sessions.json');
  const sessions = await readSessionsJson(sessionsJsonPath);
  const existing = findExistingSessionRecord(sessions, sessionKey);
  const resolution = resolveSessionTranscriptPath(sessions, sessionsDir, sessionKey);
  const existingId = typeof existing?.sessionId === 'string' && existing.sessionId.trim()
    ? existing.sessionId.trim()
    : typeof existing?.id === 'string' && existing.id.trim() ? existing.id.trim() : null;
  const sessionId = existingId || (resolution.ok ? resolution.baseId : randomUUID());
  const transcriptPath = resolution.ok ? resolution.resolvedSrcPath : join(sessionsDir, `${sessionId}.jsonl`);

  // Keep the transcript compatible with OpenClaw's v3 JSONL shape.
  await ensureTranscriptHeader(transcriptPath, sessionId);
  const parentId = await readLastTranscriptMessageId(transcriptPath);
  const timestamp = Date.now();
  const messageId = randomUUID();
  await fs.appendFile(transcriptPath, `${JSON.stringify({
    type: 'message',
    id: messageId,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    source: 'uclaw-agent-welcome',
    message: {
      role: 'assistant',
      content,
      timestamp,
      idempotencyKey: `${messageId}:uclaw-agent-welcome`,
    },
  })}\n`, 'utf8');

  const label = params.label?.trim();
  upsertSessionRecord(sessions, sessionKey, {
    ...(existing ?? {}),
    sessionId,
    sessionStartedAt: typeof existing?.sessionStartedAt === 'number' ? existing.sessionStartedAt : timestamp,
    lastInteractionAt: timestamp,
    updatedAt: timestamp,
    sessionFile: transcriptPath,
    chatType: typeof existing?.chatType === 'string' && existing.chatType.trim() ? existing.chatType : 'direct',
    ...(label ? { label } : {}),
    status: 'completed',
  });
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(sessionsJsonPath, `${JSON.stringify(sessions, null, 2)}\n`, 'utf8');
}
