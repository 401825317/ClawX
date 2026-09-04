/**
 * Logger Utility
 * Centralized logging with levels, file output, and log retrieval for UI.
 *
 * File writes use an async buffered writer so that high-frequency logging
 * (e.g. during gateway startup) never blocks the Electron main thread.
 * Only the final `process.on('exit')` handler uses synchronous I/O to
 * guarantee the last few messages are flushed before the process exits.
 */
import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'path';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'fs';
import { appendFile, open, readdir, stat, unlink } from 'fs/promises';

/**
 * Log levels
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * Current log level (can be changed at runtime)
 */
// Default to INFO in packaged builds to reduce sync-like overhead from
// high-volume DEBUG logging.  In dev mode, keep DEBUG for diagnostics.
// Note: app.isPackaged may not be available before app.isReady(), but the
// logger is initialised after that point so this is safe.
let currentLevel = LogLevel.DEBUG;

/**
 * Log file path
 */
let logFilePath: string | null = null;
let logDir: string | null = null;
let logDate = '';
let logSequence = 0;

const MAX_LOG_FILE_BYTES = 20 * 1024 * 1024;
const MAX_LOG_DIRECTORY_BYTES = 100 * 1024 * 1024;
const MAX_PENDING_LOG_BYTES = 2 * 1024 * 1024;
const MAX_RECENT_LOG_BYTES = 2 * 1024 * 1024;
const MAX_IN_MEMORY_LOG_LINE_BYTES = 256 * 1024;
const MEMORY_TRUNCATED_LOG_MARKER = '\n[log entry truncated in memory]\n';
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const OWNED_LOG_FILE_PATTERN = /^clawx-\d{4}-\d{2}-\d{2}(?:-\d+)?\.log$/u;
const TRUNCATED_LOG_MARKER = '\n[log entry truncated at 20MB]\n';
const RAW_PARAMS_KEY_PATTERN = /(?:(['"])(raw_params|rawParams)\1|\b(raw_params|rawParams)\b)\s*([=:])\s*/gu;
const FOLLOWING_DIAGNOSTIC_FIELD_PATTERN = /\s+(?=(?:eventId|event_id|traceId|trace_id|runId|run_id|requestId|request_id|attempt|code|status|statusCode|outcome|reason|provider|model|durationMs|errorCode|errorName)\s*[:=])/iu;
const SENSITIVE_LOG_KEY_PATTERN = /(?:authorization|cookie|token|api[_-]?key|secret|password|passwd|credential|prompt|instruction|message|content|input|arguments|request[_-]?body|response[_-]?body)/iu;
const SENSITIVE_TEXT_KEY_PATTERN = /(?<![?&])(?:(['"])(?:authorization|cookie|token|api[_-]?key|secret|password|passwd|credential|prompt|instruction|message|content|input|arguments|request[_-]?body|response[_-]?body)\1|\b(?:authorization|cookie|token|api[_-]?key|secret|password|passwd|credential|prompt|instruction|message|content|input|arguments|request[_-]?body|response[_-]?body)\b)\s*([=:])\s*/giu;
const AUTHORIZATION_VALUE_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/giu;
const SENSITIVE_QUERY_VALUE_PATTERN = /([?&](?:access(?:[_-]|%5f|%2d)?token|refresh(?:[_-]|%5f|%2d)?token|relay(?:[_-]|%5f|%2d)?token|authorization|api(?:[_-]|%5f|%2d)?key|token|key|secret|password|passwd|signature|sig)=)[^&\s]+/giu;
const URL_CREDENTIALS_PATTERN = /(\b(?:https?|wss?):\/\/)(?:[^/\s?#@]+(?::[^/\s?#@]*)?)@/giu;
const COMMON_SECRET_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{12,})\b/gu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const FILE_URL_PATTERN = /\b(file:\/\/\/?)[^\s"'`<>]+/giu;
const ABSOLUTE_URL_PATTERN = /\b(?![A-Z]:\/\/)[A-Z][A-Z0-9+.-]*:\/\/[^\s"'`<>]+/giu;
const QUOTED_ABSOLUTE_PATH_PATTERN = /(["'`])((?:[A-Z]:[\\/]+|\\{2,}(?:[?.][\\/]+)?|\/{2}(?!\/)|\/(?!\/))(?:(?!\1)[^\r\n])*)\1/giu;
const UNQUOTED_ABSOLUTE_PATH_PATTERN = /(^|[\s=(:,{}\x5B])((?:[A-Z]:[\\/]+|\\{2,}(?:[?.][\\/]+)?|\/{2}(?!\/)|\/(?!\/))(?:(?!\s+[A-Z_][A-Z0-9_.-]*=)[^\r\n"'`<>\x5B\x5D{},;)])*)/gimu;
const DUPLICATE_ERROR_WINDOW_MS = 30_000;
const DUPLICATE_ERROR_IDLE_FLUSH_MS = 1_000;

interface RedactedValueSummary {
  redacted: true;
  bytes: number;
  sha256: string;
}

interface LogCorrelation {
  eventId: string;
  traceId?: string;
  runId?: string;
  attempt?: number;
}

interface PendingRepeatedError {
  fingerprint: string;
  first: string;
  last: string;
  count: number;
  firstAt: number;
  lastAt: number;
}

/**
 * In-memory ring buffer for recent logs (useful for UI display)
 */
const RING_BUFFER_SIZE = 500;
const recentLogs: string[] = [];
let recentLogBytes = 0;

// ── Async write buffer ───────────────────────────────────────────

/** Pending log lines waiting to be flushed to disk. */
let writeBuffer: string[] = [];
/** Timer for the next scheduled flush. */
let flushTimer: NodeJS.Timeout | null = null;
/** Whether a flush is currently in progress. */
let flushing = false;
/** Batch currently owned by an asynchronous write. Retained for exit-time recovery. */
let inFlightBatch: string[] | null = null;
let writeBufferBytes = 0;
let inFlightBatchBytes = 0;
/** Consecutive automatic retries for the current unwritten buffer. */
let flushRetryCount = 0;
let pendingRepeatedError: PendingRepeatedError | null = null;
let duplicateErrorTimer: NodeJS.Timeout | null = null;
let droppedLogCount = 0;
let droppedLogBytes = 0;

const FLUSH_INTERVAL_MS = 500;
const FLUSH_SIZE_THRESHOLD = 20;
const FLUSH_RETRY_LIMIT = 2;

export type ConsoleSink = 'debug' | 'info' | 'warn' | 'error';

const CONSOLE_SINK_STATE = Symbol.for('uclaw.logger.console-sink-state');
const CONSOLE_STREAM_GUARD = Symbol.for('uclaw.logger.console-stream-guard');
const processState = process as unknown as Record<symbol, unknown>;
const consoleSinkEnabled = (processState[CONSOLE_SINK_STATE] as Record<ConsoleSink, boolean> | undefined) ?? {
  debug: true,
  info: true,
  warn: true,
  error: true,
};
processState[CONSOLE_SINK_STATE] = consoleSinkEnabled;

function isBrokenPipeError(error: unknown): boolean {
  let current = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current === 'EPIPE') return true;
    if (typeof current !== 'object' || current === null) return false;
    try {
      if (seen.has(current)) return false;
      seen.add(current);
      const candidate = current as { code?: unknown; errno?: unknown; cause?: unknown };
      if (candidate.code === 'EPIPE' || candidate.errno === 'EPIPE' || candidate.errno === -32) return true;
      current = candidate.cause;
    } catch {
      // A hostile error object must not make the stream error handler throw.
      return true;
    }
  }
  return false;
}

function guardConsoleStream(
  stream: NodeJS.WriteStream | undefined,
  sinks: readonly ConsoleSink[],
): void {
  if (!stream) return;
  try {
    const guardedStream = stream as NodeJS.WriteStream & { [CONSOLE_STREAM_GUARD]?: boolean };
    if (guardedStream[CONSOLE_STREAM_GUARD]) return;
    guardedStream[CONSOLE_STREAM_GUARD] = true;
    stream.on('error', (error) => {
      if (!isBrokenPipeError(error)) return;
      for (const sink of sinks) consoleSinkEnabled[sink] = false;
    });
  } catch {
    for (const sink of sinks) consoleSinkEnabled[sink] = false;
  }
}

export function installConsoleEpipeGuards(): void {
  guardConsoleStream(process.stdout, ['debug', 'info']);
  guardConsoleStream(process.stderr, ['warn', 'error']);
}

installConsoleEpipeGuards();

/** Console output is optional. It must never be able to terminate Main. */
export function safeConsoleWrite(sink: ConsoleSink, formatted: string): void {
  if (!consoleSinkEnabled[sink]) return;
  try {
    console[sink](formatted);
  } catch {
    consoleSinkEnabled[sink] = false;
    // Ignore all console failures. File logging remains authoritative.
  }
}

function formatIsoTimestampWithOffset(date: Date, offsetMinutes: number): string {
  const normalizedOffset = Math.trunc(offsetMinutes);
  const localTimestamp = new Date(
    date.getTime() + normalizedOffset * 60_000,
  ).toISOString().slice(0, -1);
  const sign = normalizedOffset >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(normalizedOffset);
  const hours = String(Math.floor(absoluteOffset / 60)).padStart(2, '0');
  const minutes = String(absoluteOffset % 60).padStart(2, '0');
  return `${localTimestamp}${sign}${hours}:${minutes}`;
}

function formatLocalIsoTimestamp(date = new Date()): string {
  return formatIsoTimestampWithOffset(date, -date.getTimezoneOffset());
}

function buildLogFilePath(sequence: number): string | null {
  if (!logDir || !logDate) return null;
  const suffix = sequence === 0 ? '' : `-${sequence}`;
  return join(logDir, `clawx-${logDate}${suffix}.log`);
}

function selectInitialLogFile(requiredBytes: number): void {
  if (!logDir) return;
  const escapedDate = logDate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`^clawx-${escapedDate}(?:-(\\d+))?\\.log$`);
  let highestSequence = 0;

  for (const name of readdirSync(logDir)) {
    const match = matcher.exec(name);
    if (!match) continue;
    highestSequence = Math.max(highestSequence, match[1] ? Number(match[1]) : 0);
  }

  logSequence = highestSequence;
  logFilePath = buildLogFilePath(logSequence);
  if (
    logFilePath
    && existsSync(logFilePath)
    && statSync(logFilePath).size + requiredBytes > MAX_LOG_FILE_BYTES
  ) {
    rotateLogFile(requiredBytes);
  }
}

function rotateLogFile(requiredBytes = 0): boolean {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const nextSequence = logSequence + 1;
    const nextPath = buildLogFilePath(nextSequence);
    if (!nextPath) {
      logSequence = nextSequence;
      logFilePath = null;
      return false;
    }

    let existingBytes = 0;
    try {
      if (existsSync(nextPath)) existingBytes = statSync(nextPath).size;
    } catch {
      // A path that cannot be inspected will be tried by the append itself.
    }
    if (existingBytes === 0 || existingBytes + requiredBytes <= MAX_LOG_FILE_BYTES) {
      logSequence = nextSequence;
      logFilePath = nextPath;
      void pruneLogFiles();
      return true;
    }
    logSequence = nextSequence;
  }
  return false;
}

function utf8PrefixAtMost(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maxBytes) return value;

  let end = Math.max(0, maxBytes);
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return encoded.subarray(0, end).toString('utf8');
}

function scheduleDuplicateErrorFlush(): void {
  if (duplicateErrorTimer) clearTimeout(duplicateErrorTimer);
  duplicateErrorTimer = setTimeout(() => {
    duplicateErrorTimer = null;
    flushRepeatedError();
  }, DUPLICATE_ERROR_IDLE_FLUSH_MS);
  duplicateErrorTimer.unref?.();
}

function boundedLogLine(
  originalLine: string,
  maxBytes = MAX_LOG_FILE_BYTES,
  truncatedMarker = TRUNCATED_LOG_MARKER,
): { line: string; byteLength: number } {
  const originalBytes = Buffer.byteLength(originalLine);
  if (originalBytes <= maxBytes) {
    return { line: originalLine, byteLength: originalBytes };
  }
  const markerBytes = Buffer.byteLength(truncatedMarker);
  const contentLimit = Math.max(0, maxBytes - markerBytes);
  const line = `${utf8PrefixAtMost(originalLine, contentLimit)}${truncatedMarker}`;
  return { line, byteLength: Buffer.byteLength(line) };
}

async function appendLinesWithRotation(lines: string[]): Promise<void> {
  let writtenLines = 0;
  for (const originalLine of lines) {
    if (!logFilePath) return;
    const { line, byteLength: lineBytes } = boundedLogLine(originalLine);

    let currentSize = 0;
    try {
      currentSize = (await stat(logFilePath)).size;
    } catch {
      // The file may not exist yet.
    }
    if (currentSize > 0 && currentSize + lineBytes > MAX_LOG_FILE_BYTES) {
      if (!rotateLogFile(lineBytes)) {
        throw Object.assign(new Error('No writable log rotation target'), { writtenLines });
      }
    }
    if (logFilePath) {
      if (!await ensureLogDirectoryCapacity(lineBytes)) {
        throw Object.assign(new Error('Log directory size limit reached'), { writtenLines });
      }
      try {
        await appendFile(logFilePath, line);
        writtenLines += 1;
      } catch (error) {
        const failure = Object.assign(new Error('Log append failed'), {
          cause: error,
          writtenLines,
        });
        throw failure;
      }
    }
  }
}

interface OwnedLogFile {
  path: string;
  size: number;
  modifiedAt: number;
}

async function getOwnedLogFiles(): Promise<OwnedLogFile[]> {
  if (!logDir) return [];
  const entries: OwnedLogFile[] = [];
  for (const name of await readdir(logDir)) {
    if (!OWNED_LOG_FILE_PATTERN.test(name)) continue;
    try {
      const path = join(logDir, name);
      const fileStat = await stat(path);
      entries.push({ path, size: fileStat.size, modifiedAt: fileStat.mtimeMs });
    } catch {
      // Files removed between readdir and stat do not count toward the limit.
    }
  }
  return entries;
}

async function deleteOwnedLogFile(entry: OwnedLogFile): Promise<boolean> {
  try {
    await unlink(entry.path);
    return true;
  } catch {
    return false;
  }
}

async function ensureLogDirectoryCapacity(requiredBytes: number): Promise<boolean> {
  if (!logDir || requiredBytes > MAX_LOG_DIRECTORY_BYTES) return false;
  const entries = await getOwnedLogFiles();
  let totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (totalBytes + requiredBytes <= MAX_LOG_DIRECTORY_BYTES) return true;

  const candidates = entries
    .filter(entry => entry.path !== logFilePath)
    .sort((a, b) => a.modifiedAt - b.modifiedAt);
  for (const entry of candidates) {
    if (!await deleteOwnedLogFile(entry)) continue;
    totalBytes -= entry.size;
    if (totalBytes + requiredBytes <= MAX_LOG_DIRECTORY_BYTES) return true;
  }
  return totalBytes + requiredBytes <= MAX_LOG_DIRECTORY_BYTES;
}

function ensureLogDirectoryCapacitySync(requiredBytes: number): boolean {
  if (!logDir || requiredBytes > MAX_LOG_DIRECTORY_BYTES) return false;
  let entries: OwnedLogFile[];
  try {
    entries = readdirSync(logDir)
      .filter(name => OWNED_LOG_FILE_PATTERN.test(name))
      .flatMap((name) => {
        try {
          const path = join(logDir!, name);
          const fileStat = statSync(path);
          return [{ path, size: fileStat.size, modifiedAt: fileStat.mtimeMs }];
        } catch {
          return [];
        }
      });
  } catch {
    return false;
  }

  let totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (totalBytes + requiredBytes <= MAX_LOG_DIRECTORY_BYTES) return true;
  for (const entry of entries
    .filter(candidate => candidate.path !== logFilePath)
    .sort((a, b) => a.modifiedAt - b.modifiedAt)) {
    try {
      unlinkSync(entry.path);
      totalBytes -= entry.size;
    } catch {
      // Failed deletes remain part of the real byte total.
    }
    if (totalBytes + requiredBytes <= MAX_LOG_DIRECTORY_BYTES) return true;
  }
  return false;
}

async function pruneLogFiles(): Promise<void> {
  try {
    const now = Date.now();
    const entries = await getOwnedLogFiles();
    for (const entry of entries) {
      if (entry.path !== logFilePath && now - entry.modifiedAt > LOG_RETENTION_MS) {
        await deleteOwnedLogFile(entry);
      }
    }

    const retained = (await getOwnedLogFiles()).sort((a, b) => b.modifiedAt - a.modifiedAt);
    let totalBytes = retained.reduce((total, entry) => total + entry.size, 0);
    for (let index = retained.length - 1; index >= 0 && totalBytes > MAX_LOG_DIRECTORY_BYTES; index -= 1) {
      const entry = retained[index];
      if (entry.path === logFilePath) continue;
      if (await deleteOwnedLogFile(entry)) totalBytes -= entry.size;
    }
  } catch {
    // Log maintenance is best effort and must not affect application startup.
  }
}

function scheduleFlush(delayMs = FLUSH_INTERVAL_MS): void {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushBuffer();
  }, delayMs);
}

async function flushBuffer(): Promise<void> {
  if (flushing || writeBuffer.length === 0 || !logFilePath) return;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushing = true;
  const batch = writeBuffer;
  writeBuffer = [];
  writeBufferBytes = 0;
  inFlightBatch = batch;
  inFlightBatchBytes = batch.reduce((total, line) => total + Buffer.byteLength(line), 0);
  try {
    await appendLinesWithRotation(batch);
    if (inFlightBatch === batch) {
      inFlightBatch = null;
      inFlightBatchBytes = 0;
      flushRetryCount = 0;
    }
  } catch (error) {
    // Keep the failed batch ahead of newly queued lines so a transient write
    // failure cannot silently discard or reorder diagnostics.
    if (inFlightBatch === batch) {
      inFlightBatch = null;
      inFlightBatchBytes = 0;
      let writtenLines = 0;
      try {
        const descriptor = typeof error === 'object' && error !== null
          ? Object.getOwnPropertyDescriptor(error, 'writtenLines')
          : undefined;
        if (descriptor && 'value' in descriptor && Number.isInteger(descriptor.value)) {
          writtenLines = Math.max(0, Math.min(batch.length, Number(descriptor.value)));
        }
      } catch { /* Retry the full batch when failure metadata is unreadable. */ }
      const retryLines = [...batch.slice(writtenLines), ...writeBuffer];
      writeBuffer = [];
      writeBufferBytes = 0;
      for (const line of retryLines) {
        const lineBytes = Buffer.byteLength(line);
        if (writeBufferBytes + lineBytes <= MAX_PENDING_LOG_BYTES) {
          writeBuffer.push(line);
          writeBufferBytes += lineBytes;
        } else {
          recordDroppedLog(line);
        }
      }
      flushRetryCount += 1;
      if (flushRetryCount <= FLUSH_RETRY_LIMIT) {
        scheduleFlush();
      }
    }
  } finally {
    flushing = false;
    if (writeBuffer.length > 0 && !flushTimer && flushRetryCount === 0) {
      scheduleFlush();
    }
  }
}

/** Synchronous flush for the `exit` handler — guaranteed to write. */
function flushBufferSync(): void {
  if (!logFilePath) return;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  // process.exit can run while appendFile is still pending. Reclaim that
  // batch before its promise settles, then write it before newer log lines.
  const pendingLines = [...(inFlightBatch ?? []), ...writeBuffer];
  inFlightBatch = null;
  inFlightBatchBytes = 0;
  writeBuffer = [];
  writeBufferBytes = 0;
  const failedLines: string[] = [];
  for (const originalLine of pendingLines) {
    try {
      if (!logFilePath) break;
      const { line, byteLength: lineBytes } = boundedLogLine(originalLine);
      const currentSize = existsSync(logFilePath) ? statSync(logFilePath).size : 0;
      if (currentSize > 0 && currentSize + lineBytes > MAX_LOG_FILE_BYTES) {
        if (!rotateLogFile(lineBytes)) {
          failedLines.push(originalLine);
          continue;
        }
      }
      if (logFilePath && ensureLogDirectoryCapacitySync(lineBytes)) {
        appendFileSync(logFilePath, line);
      } else {
        failedLines.push(originalLine);
      }
    } catch {
      // Continue attempting later lines; retain failures for callers that
      // invoke the synchronous drain before the process actually exits.
      failedLines.push(originalLine);
    }
  }
  writeBuffer = failedLines;
  writeBufferBytes = failedLines.reduce((total, line) => total + Buffer.byteLength(line), 0);
  if (failedLines.length === 0) flushRetryCount = 0;
}

/** Ensure pending aggregation and buffered data reach disk before exit. */
function flushForExit(): void {
  if (duplicateErrorTimer) {
    clearTimeout(duplicateErrorTimer);
    duplicateErrorTimer = null;
  }
  flushRepeatedError();
  flushBufferSync();
  flushDroppedSummaryToBuffer();
  flushBufferSync();
}

process.on('exit', flushForExit);

// ── Initialisation ───────────────────────────────────────────────

/**
 * Initialize logger — safe to call before app.isReady()
 */
export function initLogger(): void {
  try {
    // In production, default to INFO to reduce log volume and overhead.
    if (app.isPackaged && currentLevel < LogLevel.INFO) {
      currentLevel = LogLevel.INFO;
    }

    // Electron exposes a dedicated logs path. Portable mode assigns it to the
    // removable-media-independent Runtime directory before this initializer
    // runs; using userData here would silently put logs back on the USB disk.
    try {
      logDir = app.getPath('logs');
    } catch {
      // Keep logger initialization usable in minimal test/early-bootstrap
      // environments where Electron has not exposed the logs path yet.
      logDir = join(app.getPath('userData'), 'logs');
    }

    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    // Write a separator for new session (sync is OK — happens once at startup)
    const sessionTimestamp = formatLocalIsoTimestamp();
    const sessionHeader = `\n${'='.repeat(80)}\n[${sessionTimestamp}] === ClawX Session Start (v${app.getVersion()}) ===\n${'='.repeat(80)}\n`;
    logDate = sessionTimestamp.slice(0, 10);
    selectInitialLogFile(Buffer.byteLength(sessionHeader));
    if (logFilePath && ensureLogDirectoryCapacitySync(Buffer.byteLength(sessionHeader))) {
      appendFileSync(logFilePath, sessionHeader);
    }
    void pruneLogFiles();
  } catch (error) {
    safeConsoleWrite('error', formatMessage('ERROR', 'Failed to initialize logger:', error));
  }
}

// ── Level / path accessors ───────────────────────────────────────

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogDir(): string | null {
  return logDir;
}

export function getLogFilePath(): string | null {
  return logFilePath;
}

// ── Formatting ───────────────────────────────────────────────────

function stableSerializeForDigest(
  value: unknown,
  seen = new WeakMap<object, number>(),
  nextId = { value: 0 },
): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  }
  if (typeof value === 'bigint') return JSON.stringify(`${value}n`);
  if (typeof value === 'undefined') return '"[undefined]"';
  if (typeof value === 'symbol') return JSON.stringify(String(value));
  if (typeof value === 'function') return JSON.stringify(`[function ${value.name || 'anonymous'}]`);

  if (Buffer.isBuffer(value)) {
    return JSON.stringify({ type: 'Buffer', base64: value.toString('base64') });
  }
  if (value instanceof Uint8Array) {
    return JSON.stringify({
      type: value.constructor.name,
      base64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'),
    });
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());

  const existingId = seen.get(value);
  if (existingId !== undefined) return JSON.stringify(`[Circular#${existingId}]`);
  const objectId = nextId.value;
  nextId.value += 1;
  seen.set(value, objectId);

  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      entries.push(descriptor && 'value' in descriptor
        ? stableSerializeForDigest(descriptor.value, seen, nextId)
        : '"[accessor]"');
    }
    return `[${entries.join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record).sort().map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    const serialized = descriptor && 'value' in descriptor
      ? stableSerializeForDigest(descriptor.value, seen, nextId)
      : '"[accessor]"';
    return `${JSON.stringify(key)}:${serialized}`;
  });
  return `{${entries.join(',')}}`;
}

function valueBytesForDigest(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.from(stableSerializeForDigest(value), 'utf8');
}

function summarizeSensitiveValue(value: unknown): RedactedValueSummary {
  const bytes = valueBytesForDigest(value);
  return {
    redacted: true,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function findStructuredTextValueEnd(value: string, start: number): number | null {
  const opening = value[start];
  if (opening !== '{' && opening !== '[') return null;

  const expectedClosers: string[] = [opening === '{' ? '}' : ']'];
  let quote = '';
  let escaped = false;

  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') expectedClosers.push('}');
    else if (character === '[') expectedClosers.push(']');
    else if (character === expectedClosers.at(-1)) {
      expectedClosers.pop();
      if (expectedClosers.length === 0) return index + 1;
    }
  }
  return null;
}

function findQuotedTextValueEnd(value: string, start: number): number | null {
  const quote = value[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === quote) {
      return index + 1;
    }
  }
  return null;
}

function findRawParamsTextValueEnd(value: string, start: number): number {
  const quotedEnd = findQuotedTextValueEnd(value, start);
  if (quotedEnd !== null) return quotedEnd;

  const structuredEnd = findStructuredTextValueEnd(value, start);
  if (structuredEnd !== null) return structuredEnd;

  const remaining = value.slice(start);
  const lineEndOffset = remaining.search(/[\r\n]/u);
  const lineEnd = lineEndOffset < 0 ? value.length : start + lineEndOffset;
  const nextField = FOLLOWING_DIAGNOSTIC_FIELD_PATTERN.exec(value.slice(start, lineEnd));
  return nextField ? start + nextField.index : lineEnd;
}

function parseRawParamsTextValue(rawValue: string): unknown {
  try {
    return JSON.parse(rawValue) as unknown;
  } catch {
    if (
      rawValue.length >= 2
      && ((rawValue.startsWith("'") && rawValue.endsWith("'"))
        || (rawValue.startsWith('`') && rawValue.endsWith('`')))
    ) {
      return rawValue.slice(1, -1);
    }
    return rawValue;
  }
}

function redactLocalAbsolutePaths(value: string): string {
  return value
    .replace(QUOTED_ABSOLUTE_PATH_PATTERN, '$1[UserPath]$1')
    .replace(UNQUOTED_ABSOLUTE_PATH_PATTERN, '$1[UserPath]');
}

const SENSITIVE_URL_QUERY_KEYS = new Set([
  'accesstoken',
  'apikey',
  'auth',
  'authorization',
  'cookie',
  'credential',
  'key',
  'passwd',
  'password',
  'refreshtoken',
  'relaytoken',
  'secret',
  'sig',
  'signature',
  'token',
]);

function decodePercentEncoding(value: string): string | null {
  let decoded = value;
  for (let pass = 0; pass < 3 && decoded.includes('%'); pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return null;
    }
  }
  return decoded;
}

function isSensitiveUrlQueryKey(rawKey: string): boolean {
  const decoded = decodePercentEncoding(rawKey);
  if (decoded === null) return false;
  return SENSITIVE_URL_QUERY_KEYS.has(decoded.toLowerCase().replace(/[^a-z0-9]/gu, ''));
}

function isEncodedAbsolutePath(rawValue: string): boolean {
  if (!rawValue.includes('%')) return false;
  const decoded = decodePercentEncoding(rawValue);
  if (decoded === null || decoded === rawValue) return false;
  return /^(?:[A-Z]:[\\/]+|\\{2}|\/{1,2}(?!\/)|file:\/{2,})/iu.test(decoded);
}

function redactUrlQueryValues(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return url;
  const fragmentStart = url.indexOf('#', queryStart + 1);
  const queryEnd = fragmentStart < 0 ? url.length : fragmentStart;
  const query = url.slice(queryStart + 1, queryEnd);
  const redactedQuery = query.split('&').map((parameter) => {
    const equals = parameter.indexOf('=');
    if (equals < 0) return parameter;
    const key = parameter.slice(0, equals);
    const rawValue = parameter.slice(equals + 1);
    if (isSensitiveUrlQueryKey(key)) return `${key}=[redacted]`;
    if (isEncodedAbsolutePath(rawValue)) return `${key}=[UserPath]`;
    return parameter;
  }).join('&');
  return `${url.slice(0, queryStart + 1)}${redactedQuery}${url.slice(queryEnd)}`;
}

function redactAbsoluteUrlQueries(value: string): string {
  return value.replace(ABSOLUTE_URL_PATTERN, match => redactUrlQueryValues(match));
}

function redactAbsolutePaths(value: string): string {
  // File URLs identify local files, so retain the scheme while removing the
  // path. Other URLs are kept intact and excluded from filesystem matching.
  const fileUrlsRedacted = value.replace(FILE_URL_PATTERN, '$1[UserPath]');
  ABSOLUTE_URL_PATTERN.lastIndex = 0;
  let cursor = 0;
  let redacted = '';
  let match: RegExpExecArray | null;
  while ((match = ABSOLUTE_URL_PATTERN.exec(fileUrlsRedacted)) !== null) {
    redacted += redactLocalAbsolutePaths(fileUrlsRedacted.slice(cursor, match.index));
    redacted += match[0];
    cursor = match.index + match[0].length;
  }
  redacted += redactLocalAbsolutePaths(fileUrlsRedacted.slice(cursor));
  return redacted;
}

function sanitizeStructuredValue(value: unknown, seen = new WeakSet<object>()): unknown {
  try {
    if (typeof value === 'string') return redactSensitiveText(value);
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'undefined') return '[undefined]';
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (typeof value === 'symbol') return String(value);
    if (typeof value !== 'object' || value === null) {
      return typeof value === 'number' && !Number.isFinite(value) ? '[NonFiniteNumber]' : value;
    }
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return summarizeSensitiveValue(value);
    if (value instanceof Uint8Array) return summarizeSensitiveValue(value);
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (value instanceof Error) {
      const readErrorText = (key: 'name' | 'message' | 'stack'): string | undefined => {
        try {
          const candidate = Reflect.get(value, key);
          return typeof candidate === 'string' ? redactSensitiveText(candidate) : undefined;
        } catch {
          return undefined;
        }
      };
      const sanitizedError: Record<string, unknown> = {
        name: readErrorText('name') ?? 'Error',
        message: readErrorText('message') ?? '[Unserializable]',
        stack: readErrorText('stack'),
      };
      for (const key of Object.keys(value).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const propertyValue = descriptor && 'value' in descriptor ? descriptor.value : '[accessor]';
        sanitizedError[key] = key === 'raw_params' || key === 'rawParams'
          ? summarizeSensitiveValue(propertyValue)
          : SENSITIVE_LOG_KEY_PATTERN.test(key)
            ? '[redacted]'
            : sanitizeStructuredValue(propertyValue, seen);
      }
      return sanitizedError;
    }

    if (Array.isArray(value)) {
      const sanitized: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        sanitized.push(descriptor && 'value' in descriptor
          ? sanitizeStructuredValue(descriptor.value, seen)
          : '[accessor]');
      }
      return sanitized;
    }

    const sanitized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const propertyValue = descriptor && 'value' in descriptor ? descriptor.value : '[accessor]';
      sanitized[key] = key === 'raw_params' || key === 'rawParams'
        ? summarizeSensitiveValue(propertyValue)
        : SENSITIVE_LOG_KEY_PATTERN.test(key)
          ? '[redacted]'
          : sanitizeStructuredValue(propertyValue, seen);
    }
    return sanitized;
  } catch {
    return '[Unserializable]';
  }
}

function formatError(errorValue: Error): string {
  let message = '[Unserializable]';
  let stack = '';
  try {
    if (typeof errorValue.message === 'string') message = redactSensitiveText(errorValue.message);
  } catch { /* Best effort. */ }
  try {
    if (typeof errorValue.stack === 'string') stack = redactSensitiveText(errorValue.stack);
  } catch { /* Best effort. */ }
  return stack ? `${message}\n${stack}` : message;
}

function safeString(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    if (typeof value === 'bigint') return `${value}n`;
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    return String(value);
  } catch {
    return '[Unserializable]';
  }
}

function formatLogArgument(value: unknown): string {
  try {
    if (value instanceof Error) return formatError(value);
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(sanitizeStructuredValue(value), null, 2) ?? '[Unserializable]';
    }
    return redactSensitiveText(safeString(value));
  } catch {
    return '[Unserializable]';
  }
}

function redactSensitiveText(value: string): string {
  const redactMatches = (
    source: string,
    pattern: RegExp,
    replacement: (rawValue: string) => string,
  ): string => {
    pattern.lastIndex = 0;
    let result = '';
    let cursor = 0;
    while (pattern.exec(source) !== null) {
      const valueStart = pattern.lastIndex;
      const valueEnd = findRawParamsTextValueEnd(source, valueStart);
      result += source.slice(cursor, valueStart);
      result += replacement(source.slice(valueStart, valueEnd));
      cursor = valueEnd;
      pattern.lastIndex = valueEnd;
    }
    return cursor === 0 ? source : result + source.slice(cursor);
  };

  const rawParamsRedacted = redactMatches(value, RAW_PARAMS_KEY_PATTERN, rawValue => (
    JSON.stringify(summarizeSensitiveValue(parseRawParamsTextValue(rawValue)))
  ));
  const text = redactMatches(rawParamsRedacted, SENSITIVE_TEXT_KEY_PATTERN, () => '[redacted]');
  return redactAbsolutePaths(redactAbsoluteUrlQueries(text)
    .replace(URL_CREDENTIALS_PATTERN, '$1[credentials-redacted]@')
    .replace(AUTHORIZATION_VALUE_PATTERN, '[authorization redacted]')
    .replace(SENSITIVE_QUERY_VALUE_PATTERN, '$1[redacted]')
    .replace(COMMON_SECRET_PATTERN, '[secret-redacted]')
    .replace(JWT_PATTERN, '[secret-redacted]'));
}

function normalizeCorrelationValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:/+@~-]{0,127}$/u.test(trimmed) ? trimmed : undefined;
}

function extractLogCorrelation(args: unknown[]): LogCorrelation {
  const correlation: LogCorrelation = { eventId: randomUUID() };
  const seen = new WeakSet<object>();
  const inspect = (value: unknown, depth = 0): void => {
    if (depth > 2 || !value || typeof value !== 'object') return;
    try {
      if (seen.has(value)) return;
      seen.add(value);
      const record = value as Record<string, unknown>;
      const read = (key: string): unknown => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        return descriptor && 'value' in descriptor ? descriptor.value : undefined;
      };
      correlation.traceId ??= normalizeCorrelationValue(read('traceId') ?? read('trace_id'));
      correlation.runId ??= normalizeCorrelationValue(read('runId') ?? read('run_id'));
      const attempt = read('attempt');
      if (correlation.attempt === undefined && typeof attempt === 'number' && Number.isInteger(attempt) && attempt >= 0 && attempt <= 1_000_000) {
        correlation.attempt = attempt;
      }
      for (const key of Object.keys(record).slice(0, 32)) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (descriptor && 'value' in descriptor) inspect(descriptor.value, depth + 1);
      }
    } catch {
      // Correlation is optional and must never make logging fatal.
    }
  };
  for (const arg of args) inspect(arg);
  return correlation;
}

function formatCorrelation(correlation: LogCorrelation): string {
  const fields = [`eventId=${correlation.eventId}`];
  if (correlation.traceId) fields.push(`traceId=${redactSensitiveText(correlation.traceId)}`);
  if (correlation.runId) fields.push(`runId=${redactSensitiveText(correlation.runId)}`);
  if (correlation.attempt !== undefined) fields.push(`attempt=${correlation.attempt}`);
  return fields.join(' ');
}

function errorFingerprint(level: string, message: string, args: unknown[]): string {
  const normalized = (() => {
    try {
      return JSON.stringify(sanitizeStructuredValue({ level, message, args })) ?? '[Unserializable]';
    } catch {
      return '[Unserializable]';
    }
  })();
  return createHash('sha256').update(normalized).digest('hex');
}

function flushRepeatedError(): void {
  const pending = pendingRepeatedError;
  pendingRepeatedError = null;
  if (!pending || pending.count < 2) return;
  const summary = `[duplicate-error] eventId=${randomUUID()} count=${pending.count} windowMs=${pending.lastAt - pending.firstAt} first=${pending.first} last=${pending.last}`;
  safeConsoleWrite('error', summary);
  writeLog(summary);
}

function writeErrorWithAggregation(formatted: string, fingerprint: string): void {
  const now = Date.now();
  const pending = pendingRepeatedError;
  if (pending && pending.fingerprint === fingerprint && now - pending.firstAt <= DUPLICATE_ERROR_WINDOW_MS) {
    pending.count += 1;
    pending.last = formatted;
    pending.lastAt = now;
    scheduleDuplicateErrorFlush();
    return;
  }

  flushRepeatedError();
  pendingRepeatedError = {
    fingerprint,
    first: formatted,
    last: formatted,
    count: 1,
    firstAt: now,
    lastAt: now,
  };
  scheduleDuplicateErrorFlush();
  safeConsoleWrite('error', formatted);
  writeLog(formatted);
}

function formatMessage(level: string, message: string, ...args: unknown[]): string {
  const timestamp = formatLocalIsoTimestamp();
  const correlation = extractLogCorrelation(args);
  const formattedArgs = args.length > 0 ? ` ${args.map(formatLogArgument).join(' ')}` : '';

  return `[${timestamp}] [${level.padEnd(5)}] ${formatCorrelation(correlation)} ${redactSensitiveText(safeString(message))}${formattedArgs}`;
}

// ── Core write ───────────────────────────────────────────────────

function formatDroppedLogSummary(): string {
  return `[log-buffer] dropped count=${droppedLogCount} bytes=${droppedLogBytes}`;
}

function recordDroppedLog(line: string): void {
  droppedLogCount = Math.min(Number.MAX_SAFE_INTEGER, droppedLogCount + 1);
  droppedLogBytes = Math.min(Number.MAX_SAFE_INTEGER, droppedLogBytes + Buffer.byteLength(line));
}

function addRecentLog(formatted: string): void {
  const bounded = boundedLogLine(
    formatted,
    MAX_IN_MEMORY_LOG_LINE_BYTES,
    MEMORY_TRUNCATED_LOG_MARKER,
  ).line;
  recentLogs.push(bounded);
  recentLogBytes += Buffer.byteLength(bounded);
  while (recentLogs.length > RING_BUFFER_SIZE || recentLogBytes > MAX_RECENT_LOG_BYTES) {
    const removed = recentLogs.shift();
    if (removed !== undefined) recentLogBytes -= Buffer.byteLength(removed);
  }
}

function queueLogLine(line: string, countDrop: boolean): boolean {
  const bounded = boundedLogLine(
    line,
    MAX_IN_MEMORY_LOG_LINE_BYTES,
    MEMORY_TRUNCATED_LOG_MARKER,
  ).line;
  const lineBytes = Buffer.byteLength(bounded);
  if (writeBufferBytes + inFlightBatchBytes + lineBytes > MAX_PENDING_LOG_BYTES) {
    if (countDrop) recordDroppedLog(line);
    return false;
  }
  writeBuffer.push(bounded);
  writeBufferBytes += lineBytes;
  return true;
}

function flushDroppedSummaryToBuffer(): void {
  if (droppedLogCount === 0 || !logFilePath) return;
  const summary = formatDroppedLogSummary();
  if (!queueLogLine(`${summary}\n`, false)) return;
  addRecentLog(summary);
  droppedLogCount = 0;
  droppedLogBytes = 0;
}

/**
 * Write to ring buffer + schedule an async flush to disk.
 */
function writeLog(formatted: string): void {
  flushDroppedSummaryToBuffer();
  addRecentLog(formatted);

  // Async file write via buffer
  if (logFilePath) {
    queueLogLine(`${formatted}\n`, true);
    if (writeBuffer.length >= FLUSH_SIZE_THRESHOLD) {
      // Buffer is large enough — flush immediately (non-blocking)
      void flushBuffer();
    } else if (!flushTimer && !flushing) {
      // Schedule a flush after a short delay
      scheduleFlush();
    }
  }
}

// ── Public log methods ───────────────────────────────────────────

export function debug(message: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.DEBUG) {
    const formatted = formatMessage('DEBUG', message, ...args);
    safeConsoleWrite('debug', formatted);
    writeLog(formatted);
  }
}

export function info(message: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.INFO) {
    const formatted = formatMessage('INFO', message, ...args);
    safeConsoleWrite('info', formatted);
    writeLog(formatted);
  }
}

export function warn(message: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.WARN) {
    const formatted = formatMessage('WARN', message, ...args);
    safeConsoleWrite('warn', formatted);
    writeLog(formatted);
  }
}

export function error(message: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.ERROR) {
    const formatted = formatMessage('ERROR', message, ...args);
    writeErrorWithAggregation(formatted, errorFingerprint('ERROR', message, args));
  }
}

// ── Log retrieval (for UI / diagnostics) ─────────────────────────

export function getRecentLogs(count?: number, minLevel?: LogLevel): string[] {
  const source = droppedLogCount > 0 ? [...recentLogs, formatDroppedLogSummary()] : recentLogs;
  const filtered = minLevel != null
    ? source.filter(line => {
      if (minLevel <= LogLevel.DEBUG) return true;
      if (minLevel === LogLevel.INFO) return !line.includes('] [DEBUG');
      if (minLevel === LogLevel.WARN) return line.includes('] [WARN') || line.includes('] [ERROR');
      return line.includes('] [ERROR');
    })
    : source;

  return count ? filtered.slice(-count) : [...filtered];
}

/**
 * Read the current day's log file content (last N lines).
 * Uses async I/O to avoid blocking.
 */
export async function readLogFile(tailLines = 200): Promise<string> {
  if (!logFilePath) return '(No log file found)';
  const safeTailLines = Math.max(1, Math.floor(tailLines));
  try {
    const file = await open(logFilePath, 'r');
    try {
      const fileStat = await file.stat();
      if (fileStat.size === 0) return '';

      const chunkSize = 64 * 1024;
      let position = fileStat.size;
      let lineCount = 0;
      const chunks: Buffer[] = [];

      while (position > 0 && lineCount <= safeTailLines) {
        const bytesToRead = Math.min(chunkSize, position);
        position -= bytesToRead;
        const buffer = Buffer.allocUnsafe(bytesToRead);
        await file.read(buffer, 0, bytesToRead, position);
        chunks.unshift(buffer);
        for (const byte of buffer) {
          if (byte === 0x0a) lineCount += 1;
        }
      }

      const combined = Buffer.concat(chunks);
      let utf8Start = 0;
      if (position > 0) {
        while (utf8Start < combined.length && (combined[utf8Start] & 0xc0) === 0x80) {
          utf8Start += 1;
        }
      }
      const content = combined.subarray(utf8Start).toString('utf8');
      const lines = content.split('\n');
      if (lines.length <= safeTailLines) return content;
      return lines.slice(-safeTailLines).join('\n');
    } finally {
      await file.close();
    }
  } catch (err) {
    return `(Failed to read log file: ${err})`;
  }
}

/**
 * List available log files.
 * Uses async I/O to avoid blocking.
 */
export async function listLogFiles(): Promise<Array<{ name: string; path: string; size: number; modified: string }>> {
  if (!logDir) return [];
  try {
    const files = await readdir(logDir);
    const results: Array<{ name: string; path: string; size: number; modified: string }> = [];
    for (const f of files) {
      if (!f.endsWith('.log')) continue;
      const fullPath = join(logDir, f);
      const s = await stat(fullPath);
      results.push({
        name: f,
        path: fullPath,
        size: s.size,
        modified: s.mtime.toISOString(),
      });
    }
    return results.sort((a, b) => b.modified.localeCompare(a.modified));
  } catch {
    return [];
  }
}

/**
 * Logger namespace export
 */
export const logger = {
  debug,
  info,
  warn,
  error,
  setLevel: setLogLevel,
  init: initLogger,
  getLogDir,
  getLogFilePath,
  getRecentLogs,
  readLogFile,
  listLogFiles,
};

export const __test = {
  maxLogFileBytes: MAX_LOG_FILE_BYTES,
  maxLogDirectoryBytes: MAX_LOG_DIRECTORY_BYTES,
  maxPendingLogBytes: MAX_PENDING_LOG_BYTES,
  maxRecentLogBytes: MAX_RECENT_LOG_BYTES,
  boundedLogLine,
  formatIsoTimestampWithOffset,
  redactSensitiveText,
  flushRepeatedError,
  flushForExit,
  flushBuffer,
  flushBufferSync,
  getFlushState: () => ({
    bufferedLines: [...writeBuffer],
    inFlightLines: inFlightBatch ? [...inFlightBatch] : [],
    bufferedBytes: writeBufferBytes,
    inFlightBytes: inFlightBatchBytes,
    recentBytes: recentLogBytes,
    droppedCount: droppedLogCount,
    droppedBytes: droppedLogBytes,
    retryCount: flushRetryCount,
  }),
};
