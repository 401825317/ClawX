import { randomUUID } from 'node:crypto';
import { promises as fsP } from 'node:fs';
import { dirname, join } from 'node:path';
import { getOpenClawConfigDir } from './paths';
import { resolveSessionTranscriptPath } from './session-files';

const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

type SessionsJson = Record<string, unknown>;
type SessionRecord = Record<string, unknown>;
type PersistedArtifactResultKind = 'image' | 'video' | 'composite';
type PersistedConversationFile = {
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  filePath?: string;
  gatewayUrl?: string;
  source?: 'user-upload' | 'tool-result' | 'message-ref' | 'gateway-media';
};

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

function dedupePersistedConversationFiles(files: PersistedConversationFile[]): PersistedConversationFile[] {
  const seen = new Set<string>();
  const next: PersistedConversationFile[] = [];
  for (const file of files) {
    const filePath = file.filePath?.trim();
    const gatewayUrl = file.gatewayUrl?.trim();
    const key = filePath
      ? `path:${filePath}`
      : gatewayUrl
        ? `gateway:${gatewayUrl}`
        : `meta:${file.fileName ?? ''}|${file.mimeType ?? ''}|${file.fileSize ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({
      ...file,
      ...(filePath ? { filePath } : {}),
      ...(gatewayUrl ? { gatewayUrl } : {}),
    });
  }
  return next;
}

function isRemoteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function basenameFromPathOrUrl(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (isRemoteHttpUrl(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return parsed.pathname.split('/').filter(Boolean).pop()?.split(/[?#]/u)[0] || fallback;
    } catch {
      return fallback;
    }
  }
  return trimmed.split(/[\\/]/u).pop()?.split(/[?#]/u)[0] || fallback;
}

function extensionFromPathOrUrl(value: string): string {
  const base = basenameFromPathOrUrl(value, '').toLowerCase();
  const index = base.lastIndexOf('.');
  return index >= 0 ? base.slice(index) : '';
}

function mimeFromPathOrUrl(value: string): string {
  switch (extensionFromPathOrUrl(value)) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.bmp': return 'image/bmp';
    case '.avif': return 'image/avif';
    case '.mp4': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.webm': return 'video/webm';
    case '.mkv': return 'video/x-matroska';
    case '.avi': return 'video/x-msvideo';
    case '.ppt': return 'application/vnd.ms-powerpoint';
    case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case '.xls': return 'application/vnd.ms-excel';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.doc': return 'application/msword';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.pdf': return 'application/pdf';
    case '.html':
    case '.htm': return 'text/html';
    case '.md': return 'text/markdown';
    case '.csv': return 'text/csv';
    case '.txt': return 'text/plain';
    default: return 'application/octet-stream';
  }
}

async function statFileSize(filePath: string): Promise<number> {
  try {
    const stat = await fsP.stat(filePath);
    return Number.isFinite(stat.size) && stat.size > 0 ? stat.size : 0;
  } catch {
    return 0;
  }
}

async function buildAssistantAttachedFiles(params: {
  files?: PersistedConversationFile[];
  outputPaths?: string[];
}): Promise<PersistedConversationFile[]> {
  const normalizedFromFiles = (params.files ?? [])
    .map((file) => {
      const filePath = file.filePath?.trim();
      const gatewayUrl = file.gatewayUrl?.trim();
      const target = filePath || gatewayUrl || '';
      if (!target) return null;
      return {
        fileName: file.fileName?.trim() || basenameFromPathOrUrl(target, 'artifact'),
        mimeType: file.mimeType?.trim() || mimeFromPathOrUrl(target),
        fileSize: typeof file.fileSize === 'number' && Number.isFinite(file.fileSize) && file.fileSize > 0
          ? Math.floor(file.fileSize)
          : undefined,
        width: typeof file.width === 'number' && Number.isFinite(file.width) && file.width > 0
          ? Math.floor(file.width)
          : undefined,
        height: typeof file.height === 'number' && Number.isFinite(file.height) && file.height > 0
          ? Math.floor(file.height)
          : undefined,
        ...(filePath ? { filePath } : {}),
        ...(gatewayUrl ? { gatewayUrl } : {}),
        source: file.source ?? 'tool-result',
      } satisfies PersistedConversationFile;
    })
    .filter((file): file is PersistedConversationFile => file != null);
  const fallbackFiles = (params.outputPaths ?? [])
    .map((value, index) => value.trim())
    .filter(Boolean)
    .map((target, index) => ({
      fileName: basenameFromPathOrUrl(target, `artifact-${index + 1}`),
      mimeType: mimeFromPathOrUrl(target),
      ...(isRemoteHttpUrl(target) ? { gatewayUrl: target } : { filePath: target }),
      source: 'tool-result' as const,
    }));
  const deduped = dedupePersistedConversationFiles([...normalizedFromFiles, ...fallbackFiles]);
  return await Promise.all(deduped.map(async (file) => {
    const filePath = file.filePath?.trim();
    const fileSize = typeof file.fileSize === 'number' && Number.isFinite(file.fileSize) && file.fileSize > 0
      ? Math.floor(file.fileSize)
      : (filePath ? await statFileSize(filePath) : 0);
    return {
      ...file,
      fileSize,
    };
  }));
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
  syntheticLocalArtifactConversation?: boolean;
  messageId?: string;
  attachedFiles?: PersistedConversationFile[];
  localArtifactResultKind?: PersistedArtifactResultKind;
}): string {
  return JSON.stringify({
    type: 'message',
    id: params.id,
    parentId: params.parentId,
    timestamp: new Date(params.timestampMs).toISOString(),
    message: {
      role: params.role,
      ...(params.messageId ? { id: params.messageId } : {}),
      content: params.content,
      timestamp: params.timestampMs,
      idempotencyKey: `${params.id}:${params.idempotencySuffix}`,
      ...(params.attachedFiles?.length ? {
        _attachedFiles: params.attachedFiles.map((file) => ({
          fileName: file.fileName ?? 'artifact',
          mimeType: file.mimeType ?? 'application/octet-stream',
          fileSize: typeof file.fileSize === 'number' && Number.isFinite(file.fileSize) && file.fileSize > 0
            ? Math.floor(file.fileSize)
            : 0,
          preview: null,
          ...(typeof file.width === 'number' ? { width: file.width } : {}),
          ...(typeof file.height === 'number' ? { height: file.height } : {}),
          ...(file.filePath ? { filePath: file.filePath } : {}),
          ...(file.gatewayUrl ? { gatewayUrl: file.gatewayUrl } : {}),
          source: file.source ?? 'tool-result',
        })),
      } : {}),
      ...(params.localArtifactResultKind ? { localArtifactResultKind: params.localArtifactResultKind } : {}),
      ...(params.syntheticLocalArtifactConversation ? { syntheticLocalArtifactConversation: true } : {}),
    },
  });
}

async function appendConversationEntries(params: {
  sessionKey: string;
  prompt: string;
  assistantText: string;
  assistantMessageId?: string;
  assistantResultKind?: PersistedArtifactResultKind;
  assistantFiles?: PersistedConversationFile[];
  outputPaths?: string[];
  inputPaths?: string[];
  userTimestampMs?: number;
}): Promise<void> {
  const sessionKey = params.sessionKey.trim();
  const prompt = params.prompt.trim();
  const inputPaths = (params.inputPaths ?? []).map((value) => value.trim()).filter(Boolean);
  const assistantText = params.assistantText.trim();
  if (!sessionKey || !prompt) {
    throw new Error('sessionKey and prompt are required');
  }
  if (!assistantText) {
    throw new Error('assistantText is required');
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
  const assistantMessageId = params.assistantMessageId?.trim() || randomUUID();
  const userText = buildUserText(prompt, inputPaths);
  const assistantFiles = await buildAssistantAttachedFiles({
    files: params.assistantFiles,
    outputPaths: params.outputPaths,
  });

  const nextLines = [
    buildMessageEntry({
      id: userMessageId,
      parentId: priorMessageId,
      role: 'user',
      content: userText,
      timestampMs: userTimestampMs,
      idempotencySuffix: 'user',
      syntheticLocalArtifactConversation: true,
      messageId: userMessageId,
    }),
    buildMessageEntry({
      id: assistantMessageId,
      parentId: userMessageId,
      role: 'assistant',
      content: assistantText,
      timestampMs: assistantTimestampMs,
      idempotencySuffix: 'assistant',
      messageId: assistantMessageId,
      attachedFiles: assistantFiles,
      localArtifactResultKind: params.assistantResultKind,
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

export async function appendImageGenerationConversation(params: {
  sessionKey: string;
  prompt: string;
  outputPaths: string[];
  outputFiles?: PersistedConversationFile[];
  inputPaths?: string[];
  summaryText?: string;
  userTimestampMs?: number;
  assistantMessageId?: string;
  assistantResultKind?: PersistedArtifactResultKind;
}): Promise<void> {
  const outputPaths = params.outputPaths.map((value) => value.trim()).filter(Boolean);
  if (outputPaths.length === 0) {
    throw new Error('outputPaths cannot be empty');
  }
  await appendConversationEntries({
    sessionKey: params.sessionKey,
    prompt: params.prompt,
    assistantText: buildAssistantText(params.summaryText, outputPaths),
    assistantMessageId: params.assistantMessageId,
    assistantResultKind: params.assistantResultKind,
    assistantFiles: params.outputFiles,
    outputPaths,
    inputPaths: params.inputPaths,
    userTimestampMs: params.userTimestampMs,
  });
}

export async function appendCompositeArtifactConversation(params: {
  sessionKey: string;
  prompt: string;
  summaryText: string;
  runId?: string;
  files?: PersistedConversationFile[];
  outputPaths?: string[];
  inputPaths?: string[];
  userTimestampMs?: number;
}): Promise<void> {
  const outputPaths = (params.outputPaths ?? []).map((value) => value.trim()).filter(Boolean);
  await appendConversationEntries({
    sessionKey: params.sessionKey,
    prompt: params.prompt,
    assistantText: buildAssistantText(params.summaryText, outputPaths),
    assistantMessageId: params.runId?.trim() ? `composite-result:${params.runId.trim()}` : undefined,
    assistantResultKind: 'composite',
    assistantFiles: params.files,
    outputPaths,
    inputPaths: params.inputPaths,
    userTimestampMs: params.userTimestampMs,
  });
}
