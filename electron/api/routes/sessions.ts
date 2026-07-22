import type { IncomingMessage, ServerResponse } from 'http';
import { open, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { getOpenClawConfigDir } from '../../utils/paths';
import { deleteLocalChatSession } from '../../utils/chat-session-cleanup';
import { logger } from '../../utils/logger';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const RECENT_TRANSCRIPT_INITIAL_READ_BYTES = 256 * 1024;
const RECENT_TRANSCRIPT_MAX_READ_BYTES = 8 * 1024 * 1024;
const RECENT_TRANSCRIPT_MAX_SCAN_LINES = 5_000;
const SESSION_SUMMARY_MAX_KEYS = 80;
const SESSION_SUMMARY_CONCURRENCY = 2;
const SESSION_SUMMARY_RECENT_MESSAGE_LIMIT = 500;
const TRANSCRIPT_CACHE_TTL_MS = 2_000;
const TRANSCRIPT_CACHE_MAX_ENTRIES = 96;
const TRANSCRIPT_FILE_READ_CONCURRENCY = 2;
const SESSION_TRANSCRIPT_FAMILY_MAX_FILES = 32;

type SessionSummary = {
  sessionKey: string;
  firstUserText: string | null;
  lastTimestamp: number | null;
};

type TranscriptMessage = {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
};

type TranscriptCacheEntry = {
  mtimeMs: number;
  size: number;
  messages: TranscriptMessage[];
  createdAt: number;
};

type ParsedTranscriptLine = {
  type?: string;
  message?: TranscriptMessage;
};

const transcriptMessageCache = new Map<string, TranscriptCacheEntry>();
let transcriptFileReadsInFlight = 0;
const transcriptFileReadQueue: Array<() => void> = [];

function transcriptCacheKey(kind: 'head' | 'tail', transcriptPath: string, limit: number): string {
  return `${kind}:${limit}:${transcriptPath}`;
}

function pruneTranscriptMessageCache(now = Date.now()): void {
  for (const [key, entry] of transcriptMessageCache) {
    if (now - entry.createdAt > TRANSCRIPT_CACHE_TTL_MS) {
      transcriptMessageCache.delete(key);
    }
  }

  while (transcriptMessageCache.size > TRANSCRIPT_CACHE_MAX_ENTRIES) {
    const oldestKey = transcriptMessageCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    transcriptMessageCache.delete(oldestKey);
  }
}

async function acquireTranscriptFileReadSlot(): Promise<void> {
  if (transcriptFileReadsInFlight < TRANSCRIPT_FILE_READ_CONCURRENCY) {
    transcriptFileReadsInFlight += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    transcriptFileReadQueue.push(resolve);
  });
}

function releaseTranscriptFileReadSlot(): void {
  const next = transcriptFileReadQueue.shift();
  if (next) {
    next();
    return;
  }

  transcriptFileReadsInFlight = Math.max(0, transcriptFileReadsInFlight - 1);
}

async function withTranscriptFileReadLimit<T>(task: () => Promise<T>): Promise<T> {
  await acquireTranscriptFileReadSlot();
  try {
    return await task();
  } finally {
    releaseTranscriptFileReadSlot();
  }
}

async function getCachedTranscriptMessages(
  key: string,
  stat: { mtimeMs: number; size: number },
): Promise<TranscriptMessage[] | null> {
  const entry = transcriptMessageCache.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (
    now - entry.createdAt > TRANSCRIPT_CACHE_TTL_MS
    || entry.mtimeMs !== stat.mtimeMs
    || entry.size !== stat.size
  ) {
    transcriptMessageCache.delete(key);
    return null;
  }
  transcriptMessageCache.delete(key);
  transcriptMessageCache.set(key, entry);
  return entry.messages.map((message) => ({ ...message }));
}

function setCachedTranscriptMessages(
  key: string,
  stat: { mtimeMs: number; size: number },
  messages: TranscriptMessage[],
): void {
  transcriptMessageCache.set(key, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    messages: messages.map((message) => ({ ...message })),
    createdAt: Date.now(),
  });
  pruneTranscriptMessageCache();
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: unknown; text?: unknown }>)
    .filter((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim())
    .map((block) => String(block.text))
    .join('\n')
    .trim();
}

function cleanSummaryUserText(text: string): string {
  return text
    .replace(/^Sender\s*\([^)]*\)\s*:\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
    .replace(/^Sender\s*\([^)]*\)\s*:\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/^Sender\s*\([^)]*\)\s*:[^\n]*(?:\n\s*)*/i, '')
    .replace(/^Sender\s*:\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
    .replace(/^Sender\s*:\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/^Sender\s*:[^\n]*(?:\n\s*)*/i, '')
    .replace(/^```json\n[\s\S]*?```\s*/i, '')
    .replace(/^\{[\s\S]*?\}\s*/i, '')
    .replace(/\s*\[media attached:[^\]]*\]/g, '')
    .replace(/\s*\[message_id:\s*[^\]]+\]/g, '')
    .replace(/^Conversation info\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
    .replace(/^Conversation info\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\]]+\]\s*/i, '')
    .trim();
}

function isInternalSummaryText(text: string): boolean {
  if (!text) return true;
  if (/^\s*System\s*\(untrusted\)\s*:/i.test(text)) return true;
  if (
    /An async command you ran earlier has completed/i.test(text)
    && /Do not relay it to the user unless explicitly requested/i.test(text)
  ) {
    return true;
  }
  if (
    /^\s*Current time\s*:/i.test(text)
    && /^\s*Current time\s*:[^\n]*\/\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+UTC\s*$/i.test(text)
  ) {
    return true;
  }
  return false;
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseMessageLine(line: string): TranscriptMessage | null {
  try {
    const entry = JSON.parse(line) as ParsedTranscriptLine;
    if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') {
      return null;
    }
    return entry.message;
  } catch {
    return null;
  }
}

function parseRecentMessagesFromTailChunk(chunk: string, readStart: number, limit: number): TranscriptMessage[] {
  const lines = chunk.split(/\r?\n/);
  if (readStart > 0) lines.shift();

  const collected: TranscriptMessage[] = [];
  let scanned = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.trim()) continue;
    scanned += 1;
    if (scanned > RECENT_TRANSCRIPT_MAX_SCAN_LINES) break;
    const message = parseMessageLine(line);
    if (message) {
      collected.push(message);
      if (collected.length >= limit) break;
    }
  }
  return collected.reverse();
}

function parseMessagesFromHeadChunk(chunk: string, readEnd: number, fileSize: number, limit: number): TranscriptMessage[] {
  const lines = chunk.split(/\r?\n/);
  if (readEnd < fileSize) lines.pop();

  const collected: TranscriptMessage[] = [];
  for (const line of lines) {
    if (!line?.trim()) continue;
    const message = parseMessageLine(line);
    if (message) {
      collected.push(message);
      if (collected.length >= limit) break;
    }
  }
  return collected;
}

async function readRecentTranscriptMessages(transcriptPath: string, limit: number): Promise<TranscriptMessage[]> {
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
  return await withTranscriptFileReadLimit(async () => {
    const handle = await open(transcriptPath, 'r');
    try {
      const stat = await handle.stat();
      const size = stat.size;
      const cacheKey = transcriptCacheKey('tail', transcriptPath, boundedLimit);
      const cached = await getCachedTranscriptMessages(cacheKey, stat);
      if (cached) return cached;
      if (size === 0) return [];

      let readBytes = Math.min(size, Math.max(RECENT_TRANSCRIPT_INITIAL_READ_BYTES, boundedLimit * 2048));
      while (readBytes <= size) {
        const readStart = Math.max(0, size - readBytes);
        const readLen = size - readStart;
        const buffer = Buffer.allocUnsafe(readLen);
        await handle.read(buffer, 0, readLen, readStart);
        const messages = parseRecentMessagesFromTailChunk(buffer.toString('utf8'), readStart, boundedLimit);
        if (
          messages.length >= boundedLimit
          || readStart === 0
          || readBytes >= RECENT_TRANSCRIPT_MAX_READ_BYTES
        ) {
          setCachedTranscriptMessages(cacheKey, stat, messages);
          return messages;
        }
        readBytes = Math.min(size, readBytes * 2);
      }
      return [];
    } finally {
      await handle.close();
    }
  });
}

async function readTranscriptHeadMessages(transcriptPath: string, limit: number): Promise<TranscriptMessage[]> {
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
  return await withTranscriptFileReadLimit(async () => {
    const handle = await open(transcriptPath, 'r');
    try {
      const stat = await handle.stat();
      const size = stat.size;
      const cacheKey = transcriptCacheKey('head', transcriptPath, boundedLimit);
      const cached = await getCachedTranscriptMessages(cacheKey, stat);
      if (cached) return cached;
      if (size === 0) return [];

      const readLen = Math.min(size, RECENT_TRANSCRIPT_INITIAL_READ_BYTES);
      const buffer = Buffer.allocUnsafe(readLen);
      await handle.read(buffer, 0, readLen, 0);
      const messages = parseMessagesFromHeadChunk(buffer.toString('utf8'), readLen, size, boundedLimit);
      setCachedTranscriptMessages(cacheKey, stat, messages);
      return messages;
    } finally {
      await handle.close();
    }
  });
}

function getTranscriptMessageIdentity(message: TranscriptMessage): string | null {
  const record = message as Record<string, unknown>;
  const id = record.id ?? record.messageId ?? record.idempotencyKey;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

async function readRecentTranscriptMessagesFromPaths(
  transcriptPaths: string[],
  limit: number,
): Promise<TranscriptMessage[]> {
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
  const rows: Array<{ message: TranscriptMessage; sourceIndex: number; messageIndex: number; timestamp: number | null }> = [];

  await Promise.all(transcriptPaths.map(async (transcriptPath, sourceIndex) => {
    try {
      const messages = await readRecentTranscriptMessages(transcriptPath, boundedLimit);
      messages.forEach((message, messageIndex) => {
        rows.push({
          message,
          sourceIndex,
          messageIndex,
          timestamp: normalizeTimestamp(message.timestamp),
        });
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return;
      }
      logger.debug('Failed to read transcript family member:', {
        transcriptPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));

  rows.sort((a, b) => {
    if (a.timestamp != null && b.timestamp != null && a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    if (a.timestamp != null && b.timestamp == null) return -1;
    if (a.timestamp == null && b.timestamp != null) return 1;
    if (a.sourceIndex !== b.sourceIndex) return a.sourceIndex - b.sourceIndex;
    return a.messageIndex - b.messageIndex;
  });

  const byIdentity = new Map<string, typeof rows[number]>();
  const anonymousRows: typeof rows = [];
  for (const row of rows) {
    const identity = getTranscriptMessageIdentity(row.message);
    if (identity) {
      byIdentity.set(identity, row);
    } else {
      anonymousRows.push(row);
    }
  }

  return [...byIdentity.values(), ...anonymousRows]
    .sort((a, b) => {
      if (a.timestamp != null && b.timestamp != null && a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      if (a.timestamp != null && b.timestamp == null) return -1;
      if (a.timestamp == null && b.timestamp != null) return 1;
      if (a.sourceIndex !== b.sourceIndex) return a.sourceIndex - b.sourceIndex;
      return a.messageIndex - b.messageIndex;
    })
    .slice(-boundedLimit)
    .map((row) => row.message);
}

function summarizeTranscriptMessages(
  sessionKey: string,
  firstMessages: TranscriptMessage[],
  recentMessages: TranscriptMessage[],
): SessionSummary {
  let firstUserText: string | null = null;
  let lastTimestamp: number | null = null;

  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    const message = recentMessages[index];
    const normalizedTs = normalizeTimestamp(message.timestamp);
    if (normalizedTs != null) {
      lastTimestamp = normalizedTs;
      break;
    }
  }

  for (const message of firstMessages) {
    if (message.role !== 'user') {
      continue;
    }
    const text = cleanSummaryUserText(extractMessageText(message.content));
    if (text && !isInternalSummaryText(text)) {
      firstUserText = text;
      break;
    }
  }

  if (firstUserText == null) {
    for (const message of recentMessages) {
      if (message.role !== 'user') {
        continue;
      }
      const text = cleanSummaryUserText(extractMessageText(message.content));
      if (text && !isInternalSummaryText(text)) {
        firstUserText = text;
        break;
      }
    }
  }

  return { sessionKey, firstUserText, lastTimestamp };
}

function parseSessionKey(sessionKey: string): { agentId: string; suffix: string } | null {
  if (!sessionKey.startsWith('agent:')) return null;
  const parts = sessionKey.split(':');
  if (parts.length < 3) return null;
  const agentId = parts[1] || '';
  const suffix = parts.slice(2).join(':');
  if (!SAFE_SESSION_SEGMENT.test(agentId) || !suffix) return null;
  return { agentId, suffix };
}

async function readSessionsJson(agentId: string): Promise<Record<string, unknown>> {
  const fsP = await import('node:fs/promises');
  const sessionsJsonPath = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions', 'sessions.json');
  const raw = await fsP.readFile(sessionsJsonPath, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function findSessionEntryByKey(
  sessionKey: string,
  sessionsJson: Record<string, unknown>,
): Record<string, unknown> | null {
  if (Array.isArray(sessionsJson.sessions)) {
    const entry = (sessionsJson.sessions as Array<Record<string, unknown>>)
      .find((session) => session.key === sessionKey || session.sessionKey === sessionKey);
    if (entry) return entry;
  }

  const value = sessionsJson[sessionKey];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function transcriptBaseIdFromPath(transcriptPath: string): string {
  return basename(transcriptPath).replace(/\.jsonl$/, '');
}

function resolveUsageFamilyBaseIds(
  sessionKey: string,
  sessionsJson: Record<string, unknown>,
  fallbackBaseId: string,
): string[] {
  const entry = findSessionEntryByKey(sessionKey, sessionsJson);
  const rawFamilyIds = Array.isArray(entry?.usageFamilySessionIds)
    ? entry.usageFamilySessionIds
    : [];
  const baseIds = rawFamilyIds
    .filter((value): value is string => typeof value === 'string' && SAFE_SESSION_SEGMENT.test(value));
  if (SAFE_SESSION_SEGMENT.test(fallbackBaseId)) {
    baseIds.push(fallbackBaseId);
  }
  return Array.from(new Set(baseIds));
}

async function listTranscriptFilesForBaseId(sessionsDir: string, baseId: string): Promise<string[]> {
  if (!SAFE_SESSION_SEGMENT.test(baseId)) return [];

  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const liveName = `${baseId}.jsonl`;
  const resetNames = names
    .filter((name) => name.startsWith(`${liveName}.reset.`))
    .sort((a, b) => a.localeCompare(b));
  const orderedNames = [
    ...resetNames,
    ...(names.includes(liveName) ? [liveName] : []),
  ];
  return orderedNames.map((name) => join(sessionsDir, name));
}

async function resolveSessionTranscriptPathsByKey(
  sessionKey: string,
  sessionsDir: string,
  sessionsJson: Record<string, unknown>,
  includeFamily: boolean,
): Promise<string[] | null> {
  const transcriptPath = resolveSessionTranscriptPathByKey(sessionKey, sessionsDir, sessionsJson);
  if (!transcriptPath) return null;
  if (!includeFamily) return [transcriptPath];

  const fallbackBaseId = transcriptBaseIdFromPath(transcriptPath);
  const familyBaseIds = resolveUsageFamilyBaseIds(sessionKey, sessionsJson, fallbackBaseId);
  const paths: string[] = [];
  for (const baseId of familyBaseIds) {
    paths.push(...await listTranscriptFilesForBaseId(sessionsDir, baseId));
  }
  if (paths.length === 0) paths.push(transcriptPath);

  return Array.from(new Set(paths)).slice(-SESSION_TRANSCRIPT_FAMILY_MAX_FILES);
}

function resolveSessionTranscriptPathByKey(
  sessionKey: string,
  sessionsDir: string,
  sessionsJson: Record<string, unknown>,
): string | null {
  let resolvedSrcPath: string | undefined;
  let fileName: string | undefined;

  if (Array.isArray(sessionsJson.sessions)) {
    const entry = (sessionsJson.sessions as Array<Record<string, unknown>>)
      .find((session) => session.key === sessionKey || session.sessionKey === sessionKey);
    if (entry) {
      fileName = (entry.file ?? entry.fileName ?? entry.path) as string | undefined;
      if (!fileName && typeof entry.id === 'string') {
        fileName = `${entry.id}.jsonl`;
      }
      const absFile = (entry.sessionFile ?? entry.absolutePath) as string | undefined;
      if (absFile && (absFile.startsWith('/') || absFile.match(/^[A-Za-z]:\\/))) {
        resolvedSrcPath = absFile;
      }
    }
  }

  if (!fileName && !resolvedSrcPath && sessionsJson[sessionKey] != null) {
    const value = sessionsJson[sessionKey];
    if (typeof value === 'string') {
      fileName = value;
    } else if (typeof value === 'object' && value !== null) {
      const entry = value as Record<string, unknown>;
      const absFile = (entry.sessionFile ?? entry.file ?? entry.fileName ?? entry.path) as string | undefined;
      if (absFile) {
        if (absFile.startsWith('/') || absFile.match(/^[A-Za-z]:\\/)) {
          resolvedSrcPath = absFile;
        } else {
          fileName = absFile;
        }
      } else {
        const id = (entry.id ?? entry.sessionId) as string | undefined;
        if (id) fileName = id.endsWith('.jsonl') ? id : `${id}.jsonl`;
      }
    }
  }

  if (!resolvedSrcPath && fileName) {
    resolvedSrcPath = join(sessionsDir, fileName.endsWith('.jsonl') ? fileName : `${fileName}.jsonl`);
  }

  return resolvedSrcPath ?? null;
}

async function loadSessionSummary(sessionKey: string): Promise<SessionSummary> {
  const parsed = parseSessionKey(sessionKey);
  if (!parsed) {
    return { sessionKey, firstUserText: null, lastTimestamp: null };
  }

  try {
    const sessionsDir = join(getOpenClawConfigDir(), 'agents', parsed.agentId, 'sessions');
    const sessionsJson = await readSessionsJson(parsed.agentId);
    const transcriptPath = resolveSessionTranscriptPathByKey(sessionKey, sessionsDir, sessionsJson);
    if (!transcriptPath) {
      return { sessionKey, firstUserText: null, lastTimestamp: null };
    }

    const [firstMessages, recentMessages] = await Promise.all([
      readTranscriptHeadMessages(transcriptPath, SESSION_SUMMARY_RECENT_MESSAGE_LIMIT),
      readRecentTranscriptMessages(transcriptPath, SESSION_SUMMARY_RECENT_MESSAGE_LIMIT),
    ]);
    return summarizeTranscriptMessages(sessionKey, firstMessages, recentMessages);
  } catch {
    return { sessionKey, firstUserText: null, lastTimestamp: null };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }));

  return results;
}

async function loadSessionTranscriptByKey(
  sessionKey: string,
  limit: number,
  includeFamily = false,
): Promise<unknown[] | null> {
  const parsed = parseSessionKey(sessionKey);
  if (!parsed) return null;

  try {
    const sessionsDir = join(getOpenClawConfigDir(), 'agents', parsed.agentId, 'sessions');
    const sessionsJson = await readSessionsJson(parsed.agentId);
    const transcriptPaths = await resolveSessionTranscriptPathsByKey(
      sessionKey,
      sessionsDir,
      sessionsJson,
      includeFamily,
    );
    if (!transcriptPaths?.length) return null;

    return includeFamily
      ? await readRecentTranscriptMessagesFromPaths(transcriptPaths, limit)
      : await readRecentTranscriptMessages(transcriptPaths[0]!, limit);
  } catch {
    return null;
  }
}

export async function handleSessionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/sessions/summaries' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ sessionKeys?: string[] }>(req);
      const sessionKeys = Array.isArray(body.sessionKeys)
        ? body.sessionKeys.filter((value): value is string => typeof value === 'string' && value.startsWith('agent:'))
        : [];
      const boundedSessionKeys = Array.from(new Set(sessionKeys)).slice(0, SESSION_SUMMARY_MAX_KEYS);
      if (boundedSessionKeys.length === 0) {
        sendJson(res, 200, { success: true, summaries: [] });
        return true;
      }

      const summaries = await mapWithConcurrency(
        boundedSessionKeys,
        SESSION_SUMMARY_CONCURRENCY,
        loadSessionSummary,
      );
      sendJson(res, 200, { success: true, summaries });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/sessions/transcript' && req.method === 'GET') {
    try {
      const sessionKey = url.searchParams.get('sessionKey')?.trim() || '';
      const limitRaw = Number(url.searchParams.get('limit') ?? '200');
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 1000) : 200;
      const includeFamily = ['1', 'true', 'yes'].includes(
        (url.searchParams.get('includeFamily') ?? '').trim().toLowerCase(),
      );

      if (sessionKey) {
        const messages = await loadSessionTranscriptByKey(sessionKey, limit, includeFamily);
        if (!messages) {
          sendJson(res, 404, { success: false, error: 'Transcript not found' });
          return true;
        }
        sendJson(res, 200, { success: true, messages });
        return true;
      }

      const agentId = url.searchParams.get('agentId')?.trim() || '';
      const sessionId = url.searchParams.get('sessionId')?.trim() || '';
      if (!agentId || !sessionId) {
        sendJson(res, 400, { success: false, error: 'agentId and sessionId are required' });
        return true;
      }
      if (!SAFE_SESSION_SEGMENT.test(agentId) || !SAFE_SESSION_SEGMENT.test(sessionId)) {
        sendJson(res, 400, { success: false, error: 'Invalid transcript identifier' });
        return true;
      }

      const transcriptPath = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions', `${sessionId}.jsonl`);
      const messages = await readRecentTranscriptMessages(transcriptPath, limit);

      sendJson(res, 200, { success: true, messages });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        sendJson(res, 404, { success: false, error: 'Transcript not found' });
      } else {
        sendJson(res, 500, { success: false, error: 'Failed to load transcript' });
      }
    }
    return true;
  }

  // POST /api/sessions/delete — HTTP mirror of the `session:delete` IPC.
  // Both surfaces first settle OpenClaw runtime ownership, then share the same
  // cleanup helper for the live transcript, legacy `.deleted.jsonl`, current
  // `.jsonl.deleted.*`, `.jsonl.reset.*`, and the trajectory sidecar pair
  // (`<id>.trajectory.jsonl` + `<id>.trajectory-path.json`) and — when the
  // pointer points outside sessions/ (the OPENCLAW_TRAJECTORY_DIR case) —
  // the off-disk runtime trajectory it references.
  if (url.pathname === '/api/sessions/delete' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ sessionKey: string }>(req);
      const sessionKey = body.sessionKey;
      if (!sessionKey || !sessionKey.startsWith('agent:')) {
        sendJson(res, 400, { success: false, error: `Invalid sessionKey: ${sessionKey}` });
        return true;
      }
      const parts = sessionKey.split(':');
      if (parts.length < 3) {
        sendJson(res, 400, { success: false, error: `sessionKey has too few parts: ${sessionKey}` });
        return true;
      }
      const agentId = parts[1];
      // Defence-in-depth: agentId becomes a path segment under
      // ~/.openclaw/agents/. The sibling /api/sessions/transcript route
      // applies the same check to its sessionId; mirror it here so a
      // malformed key can never steer the unlink loop into another folder.
      if (!SAFE_SESSION_SEGMENT.test(agentId)) {
        sendJson(res, 400, { success: false, error: `Invalid agentId: ${agentId}` });
        return true;
      }
      const deletion = await deleteLocalChatSession(sessionKey, ctx.gatewayManager);
      logger.info(
        `[api/sessions/delete] Removed session=${sessionKey} lifecycle=${deletion.lifecycle} files=${deletion.removedFiles.length} hostTasks=${deletion.removedHostTasks}`,
      );
      sendJson(res, 200, {
        success: true,
        lifecycle: deletion.lifecycle,
        removedHostTasks: deletion.removedHostTasks,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  // POST /api/sessions/rename — update session label in sessions.json.
  if (url.pathname === '/api/sessions/rename' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ sessionKey: string; label: string }>(req);
      const { sessionKey, label } = body;
      if (!sessionKey || !sessionKey.startsWith('agent:')) {
        sendJson(res, 400, { success: false, error: `Invalid sessionKey: ${sessionKey}` });
        return true;
      }
      if (!label || typeof label !== 'string' || !label.trim()) {
        sendJson(res, 400, { success: false, error: 'Label cannot be empty' });
        return true;
      }
      const parts = sessionKey.split(':');
      if (parts.length < 3) {
        sendJson(res, 400, { success: false, error: `sessionKey has too few parts: ${sessionKey}` });
        return true;
      }
      const agentId = parts[1];
      if (!SAFE_SESSION_SEGMENT.test(agentId)) {
        sendJson(res, 400, { success: false, error: `Invalid agentId: ${agentId}` });
        return true;
      }
      const sessionsDir = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions');
      const sessionsJsonPath = join(sessionsDir, 'sessions.json');
      const fsP = await import('node:fs/promises');
      const raw = await fsP.readFile(sessionsJsonPath, 'utf8');
      const sessionsJson = JSON.parse(raw) as Record<string, unknown>;

      const trimmedLabel = label.trim();
      let found = false;

      // Object-keyed format
      if (sessionsJson[sessionKey] && typeof sessionsJson[sessionKey] === 'object') {
        (sessionsJson[sessionKey] as Record<string, unknown>).label = trimmedLabel;
        found = true;
      }
      // Array format
      if (Array.isArray(sessionsJson.sessions)) {
        for (const entry of sessionsJson.sessions as Array<Record<string, unknown>>) {
          if (entry.key === sessionKey || entry.sessionKey === sessionKey) {
            entry.label = trimmedLabel;
            found = true;
          }
        }
      }

      if (!found) {
        sendJson(res, 404, { success: false, error: `Session not found: ${sessionKey}` });
        return true;
      }

      await fsP.writeFile(sessionsJsonPath, JSON.stringify(sessionsJson, null, 2), 'utf8');
      logger.info(`[api/sessions/rename] key=${sessionKey} label=${trimmedLabel}`);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
