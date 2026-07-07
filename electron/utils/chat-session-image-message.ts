import { randomUUID } from 'node:crypto';
import { promises as fsP } from 'node:fs';
import { dirname, join } from 'node:path';
import { getOpenClawConfigDir } from './paths';
import { resolveSessionTranscriptPath } from './session-files';

const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

type SessionsJson = Record<string, unknown>;
type SessionRecord = Record<string, unknown>;

function parseAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) {
    throw new Error(`Invalid sessionKey: ${sessionKey}`);
  }
  const parts = sessionKey.split(':');
  if (parts.length < 3) {
    throw new Error(`Malformed sessionKey: ${sessionKey}`);
  }
  const agentId = parts[1]?.trim() || '';
  if (!SAFE_SESSION_SEGMENT.test(agentId)) {
    throw new Error(`Invalid agentId in sessionKey: ${sessionKey}`);
  }
  return agentId;
}

async function readSessionsJson(path: string): Promise<SessionsJson> {
  try {
    const raw = await fsP.readFile(path, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as SessionsJson
      : {};
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : '';
    if (code === 'ENOENT') return {};
    throw error;
  }
}

function findExistingSessionRecord(
  sessionsJson: SessionsJson,
  sessionKey: string,
): SessionRecord | null {
  const direct = sessionsJson[sessionKey];
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as SessionRecord;
  }

  if (Array.isArray(sessionsJson.sessions)) {
    const entry = (sessionsJson.sessions as Array<Record<string, unknown>>)
      .find((value) => value.key === sessionKey || value.sessionKey === sessionKey);
    if (entry && typeof entry === 'object') {
      return entry;
    }
  }

  return null;
}

function upsertSessionRecord(
  sessionsJson: SessionsJson,
  sessionKey: string,
  nextRecord: SessionRecord,
): void {
  if (Array.isArray(sessionsJson.sessions)) {
    const entries = sessionsJson.sessions as Array<Record<string, unknown>>;
    const index = entries.findIndex((value) => value.key === sessionKey || value.sessionKey === sessionKey);
    if (index >= 0) {
      entries[index] = { ...entries[index], ...nextRecord, key: sessionKey };
      return;
    }
    entries.push({ key: sessionKey, ...nextRecord });
    return;
  }

  sessionsJson[sessionKey] = nextRecord;
}

async function readLastTranscriptMessageId(transcriptPath: string): Promise<string | null> {
  try {
    const raw = await fsP.readFile(transcriptPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const entry = JSON.parse(lines[index] || '') as { type?: unknown; id?: unknown };
        if (entry.type === 'message' && typeof entry.id === 'string' && entry.id.trim()) {
          return entry.id;
        }
      } catch {
        continue;
      }
    }
    return null;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : '';
    if (code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureTranscriptHeader(
  transcriptPath: string,
  sessionId: string,
): Promise<void> {
  await fsP.mkdir(dirname(transcriptPath), { recursive: true });
  try {
    const stat = await fsP.stat(transcriptPath);
    if (stat.size > 0) return;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : '';
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  const header = {
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  await fsP.writeFile(transcriptPath, `${JSON.stringify(header)}\n`, 'utf8');
}

function buildAssistantText(summaryText: string | undefined, outputPaths: string[]): string {
  const lines: string[] = [];
  const summary = summaryText?.trim();
  if (summary) {
    lines.push(summary);
  }
  for (const outputPath of outputPaths) {
    const trimmed = outputPath.trim();
    if (trimmed) {
      lines.push(`MEDIA:${trimmed}`);
    }
  }
  return lines.join('\n\n');
}

function buildUserText(prompt: string, inputPaths: string[]): string {
  const lines = [prompt];
  for (const inputPath of inputPaths) {
    const trimmed = inputPath.trim();
    if (trimmed) {
      lines.push(`[media attached: ${trimmed} (image/png) | ${trimmed}]`);
    }
  }
  return lines.join('\n\n');
}

function buildMessageEntry(params: {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant';
  content: string;
  timestampMs: number;
  idempotencySuffix: 'user' | 'assistant';
}): string {
  return JSON.stringify({
    type: 'message',
    id: params.id,
    parentId: params.parentId,
    timestamp: new Date(params.timestampMs).toISOString(),
    message: {
      role: params.role,
      content: params.content,
      timestamp: params.timestampMs,
      idempotencyKey: `${params.id}:${params.idempotencySuffix}`,
    },
  });
}

export async function appendImageGenerationConversation(params: {
  sessionKey: string;
  prompt: string;
  outputPaths: string[];
  inputPaths?: string[];
  summaryText?: string;
  userTimestampMs?: number;
}): Promise<void> {
  const sessionKey = params.sessionKey.trim();
  const prompt = params.prompt.trim();
  const outputPaths = params.outputPaths.map((value) => value.trim()).filter(Boolean);
  const inputPaths = (params.inputPaths ?? []).map((value) => value.trim()).filter(Boolean);
  if (!sessionKey || !prompt) {
    throw new Error('sessionKey and prompt are required');
  }
  if (outputPaths.length === 0) {
    throw new Error('outputPaths cannot be empty');
  }

  const agentId = parseAgentIdFromSessionKey(sessionKey);
  const sessionsDir = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions');
  const sessionsJsonPath = join(sessionsDir, 'sessions.json');
  const sessionsJson = await readSessionsJson(sessionsJsonPath);
  const existingRecord = findExistingSessionRecord(sessionsJson, sessionKey);
  const resolution = resolveSessionTranscriptPath(sessionsJson, sessionsDir, sessionKey);

  const existingSessionId = typeof existingRecord?.sessionId === 'string' && existingRecord.sessionId.trim()
    ? existingRecord.sessionId.trim()
    : (typeof existingRecord?.id === 'string' && existingRecord.id.trim() ? existingRecord.id.trim() : null);
  const sessionId = existingSessionId || (resolution.ok ? resolution.baseId : randomUUID());
  const transcriptPath = resolution.ok
    ? resolution.resolvedSrcPath
    : join(sessionsDir, `${sessionId}.jsonl`);

  await ensureTranscriptHeader(transcriptPath, sessionId);

  const priorMessageId = await readLastTranscriptMessageId(transcriptPath);
  const nowMs = Date.now();
  const userTimestampMs = typeof params.userTimestampMs === 'number' && Number.isFinite(params.userTimestampMs)
    ? Math.floor(params.userTimestampMs)
    : nowMs;
  const assistantTimestampMs = Math.max(nowMs, userTimestampMs + 1);
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const userText = buildUserText(prompt, inputPaths);
  const assistantText = buildAssistantText(params.summaryText, outputPaths);

  const nextLines = [
    buildMessageEntry({
      id: userMessageId,
      parentId: priorMessageId,
      role: 'user',
      content: userText,
      timestampMs: userTimestampMs,
      idempotencySuffix: 'user',
    }),
    buildMessageEntry({
      id: assistantMessageId,
      parentId: userMessageId,
      role: 'assistant',
      content: assistantText,
      timestampMs: assistantTimestampMs,
      idempotencySuffix: 'assistant',
    }),
  ].join('\n');
  await fsP.appendFile(transcriptPath, `${nextLines}\n`, 'utf8');

  const nextRecord: SessionRecord = {
    ...(existingRecord ?? {}),
    sessionId,
    sessionStartedAt: typeof existingRecord?.sessionStartedAt === 'number'
      ? existingRecord.sessionStartedAt
      : nowMs,
    lastInteractionAt: nowMs,
    updatedAt: nowMs,
    sessionFile: transcriptPath,
    chatType: typeof existingRecord?.chatType === 'string' && existingRecord.chatType.trim()
      ? existingRecord.chatType
      : 'direct',
    status: 'completed',
  };

  await fsP.mkdir(sessionsDir, { recursive: true });
  upsertSessionRecord(sessionsJson, sessionKey, nextRecord);
  await fsP.writeFile(sessionsJsonPath, JSON.stringify(sessionsJson, null, 2), 'utf8');
}
