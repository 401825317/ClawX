import { randomUUID } from 'node:crypto';
import { promises as fsP, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ImageGenerationJobPayload,
  MediaGenerationInputImageRef,
  MediaGenerationJobOutput,
  MediaGenerationJobPayload,
  MediaGenerationJobSnapshot,
  MediaGenerationProgressEvent,
  VideoGenerationJobPayload,
  VideoGenerationRouteDecision,
} from './media-generation-types';

const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_FILE_NAME = 'media-generation-jobs.json';
const MAX_TEXT_CHARS = 100_000;
const MAX_DIAGNOSTIC_CHARS = 12_000;
const SENSITIVE_FIELD_PARTS = [
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'password',
  'secret',
  'signature',
  'token',
];

export type MediaGenerationJournalEntry = {
  payload: MediaGenerationJobPayload;
  snapshot: MediaGenerationJobSnapshot;
};

type MediaGenerationJournalFile = {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  updatedAt: number;
  jobs: MediaGenerationJournalEntry[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown, maxChars = MAX_TEXT_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxChars) : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function redactSensitiveText(value: unknown, maxChars = MAX_TEXT_CHARS): string | undefined {
  const text = readString(value, maxChars);
  if (!text) return undefined;
  return text
    .replace(/\b(?:sk|sess)-[a-z0-9_-]{12,}\b/giu, '[redacted-key]')
    .replace(/\b(bearer\s+)[a-z0-9._~+/-]{8,}/giu, '$1[redacted]')
    .replace(/\b(api[-_]?key|authorization|cookie|credential|password|secret|signature|sig|token)\s*[:=]\s*([^\s,;]+)/giu, '$1=[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/giu, (urlText) => {
      const queryIndex = urlText.search(/[?#]/u);
      return queryIndex >= 0 ? `${urlText.slice(0, queryIndex)}?[redacted]` : urlText;
    });
}

function readLocalPath(value: unknown): string | undefined {
  const candidate = readString(value, 4096);
  if (!candidate || /^https?:\/\//iu.test(candidate) || /^file:/iu.test(candidate)) return undefined;
  if (path.isAbsolute(candidate) || /^[a-z]:[\\/]/iu.test(candidate)) return candidate;
  return undefined;
}

function readRedactedRemoteUrl(value: unknown): string | undefined {
  const candidate = readString(value, 16_384);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    const hadSensitiveSuffix = Boolean(parsed.search || parsed.hash || parsed.username || parsed.password);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    const base = redactSensitiveText(parsed.toString(), 16_384);
    return base ? `${base}${hadSensitiveSuffix ? '?[redacted]' : ''}` : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeInputImage(value: unknown): MediaGenerationInputImageRef | null {
  const record = asRecord(value);
  const filePath = readLocalPath(record?.filePath);
  if (!record || !filePath) return null;
  return {
    filePath,
    ...(redactSensitiveText(record.fileName, 512) ? { fileName: redactSensitiveText(record.fileName, 512) } : {}),
    ...(readString(record.mimeType, 128) ? { mimeType: readString(record.mimeType, 128) } : {}),
  };
}

function sanitizeInputImages(value: unknown): MediaGenerationInputImageRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const images = value
    .map(sanitizeInputImage)
    .filter((image): image is MediaGenerationInputImageRef => image != null);
  return images.length > 0 ? images : [];
}

function sanitizeVideoRoute(value: unknown): VideoGenerationRouteDecision | undefined {
  const record = asRecord(value);
  if (!record || !['text_to_video', 'image_to_video', 'edit_image_then_video'].includes(String(record.mode))) {
    return undefined;
  }
  const selectedImageSource = ['explicit', 'candidate', 'none'].includes(String(record.selectedImageSource))
    ? record.selectedImageSource as VideoGenerationRouteDecision['selectedImageSource']
    : undefined;
  const source = ['router', 'fallback'].includes(String(record.source))
    ? record.source as VideoGenerationRouteDecision['source']
    : undefined;
  return {
    mode: record.mode as VideoGenerationRouteDecision['mode'],
    ...(readNumber(record.confidence) != null ? { confidence: readNumber(record.confidence) } : {}),
    ...(redactSensitiveText(record.reason, MAX_DIAGNOSTIC_CHARS) ? { reason: redactSensitiveText(record.reason, MAX_DIAGNOSTIC_CHARS) } : {}),
    ...(source ? { source } : {}),
    ...(selectedImageSource ? { selectedImageSource } : {}),
    ...(readNumber(record.selectedImageIndex) != null ? { selectedImageIndex: readNumber(record.selectedImageIndex) } : {}),
    ...(redactSensitiveText(record.videoPrompt) ? { videoPrompt: redactSensitiveText(record.videoPrompt) } : {}),
    ...(redactSensitiveText(record.imageEditPrompt) ? { imageEditPrompt: redactSensitiveText(record.imageEditPrompt) } : {}),
    ...(sanitizeInputImages(record.sourceImages) != null ? { sourceImages: sanitizeInputImages(record.sourceImages) } : {}),
  };
}

function sanitizePayload(value: unknown): MediaGenerationJobPayload | null {
  const record = asRecord(value);
  const kind = record?.kind;
  const sessionKey = readString(record?.sessionKey, 4096);
  const prompt = redactSensitiveText(record?.prompt);
  if (!record || (kind !== 'image' && kind !== 'video') || !sessionKey || !prompt) return null;

  const common = {
    sessionKey,
    prompt,
    ...(readString(record.clientRequestId, 4096) ? { clientRequestId: readString(record.clientRequestId, 4096) } : {}),
    ...(redactSensitiveText(record.originalPrompt) ? { originalPrompt: redactSensitiveText(record.originalPrompt) } : {}),
    ...(readString(record.model, 512) ? { model: readString(record.model, 512) } : {}),
    ...(readString(record.size, 128) ? { size: readString(record.size, 128) } : {}),
    ...(sanitizeInputImages(record.inputImages) != null ? { inputImages: sanitizeInputImages(record.inputImages) } : {}),
    ...(sanitizeInputImages(record.userInputImages) != null ? { userInputImages: sanitizeInputImages(record.userInputImages) } : {}),
    ...(readNumber(record.userMessageTimestampMs) != null ? { userMessageTimestampMs: readNumber(record.userMessageTimestampMs) } : {}),
    ...(readBoolean(record.suppressConversationAppend) != null ? { suppressConversationAppend: readBoolean(record.suppressConversationAppend) } : {}),
    ...(readString(record.runId, 4096) ? { runId: readString(record.runId, 4096) } : {}),
  };

  if (kind === 'image') {
    const quality = ['low', 'medium', 'high'].includes(String(record.quality))
      ? record.quality as ImageGenerationJobPayload['quality']
      : undefined;
    return {
      kind,
      ...common,
      ...(quality ? { quality } : {}),
    } satisfies ImageGenerationJobPayload;
  }

  return {
    kind,
    ...common,
    ...(readNumber(record.durationSeconds) != null ? { durationSeconds: readNumber(record.durationSeconds) } : {}),
    ...(sanitizeVideoRoute(record.route) ? { route: sanitizeVideoRoute(record.route) } : {}),
  } satisfies VideoGenerationJobPayload;
}

function sanitizeMetadata(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const metadata: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const normalizedKey = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
    if (SENSITIVE_FIELD_PARTS.some((part) => normalizedKey.includes(part))) continue;
    if (typeof entry === 'number' && Number.isFinite(entry)) metadata[key] = entry;
    else if (typeof entry === 'boolean') metadata[key] = entry;
    else if (typeof entry === 'string') metadata[key] = redactSensitiveText(entry, 4096);
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function sanitizeProgressEvent(value: unknown): MediaGenerationProgressEvent | null {
  const record = asRecord(value);
  const id = readString(record?.id, 4096);
  const event = readString(record?.event, 512);
  const label = redactSensitiveText(record?.label, 4096);
  const timestampMs = readNumber(record?.timestampMs);
  if (!record || !id || !event || !label || timestampMs == null) return null;
  if (!['job', 'worker', 'runtime', 'plugin'].includes(String(record.source))) return null;
  if (!['pending', 'running', 'completed', 'error'].includes(String(record.status))) return null;
  return {
    id,
    source: record.source as MediaGenerationProgressEvent['source'],
    event,
    label,
    status: record.status as MediaGenerationProgressEvent['status'],
    timestampMs,
    ...(redactSensitiveText(record.detail, MAX_DIAGNOSTIC_CHARS) ? { detail: redactSensitiveText(record.detail, MAX_DIAGNOSTIC_CHARS) } : {}),
    ...(readNumber(record.durationMs) != null ? { durationMs: readNumber(record.durationMs) } : {}),
    ...(sanitizeMetadata(record.metadata) ? { metadata: sanitizeMetadata(record.metadata) } : {}),
  };
}

function sanitizeOutput(value: unknown): MediaGenerationJobOutput | null {
  const record = asRecord(value);
  const filePath = readLocalPath(record?.path);
  const url = readRedactedRemoteUrl(record?.url);
  if (!record || (!filePath && !url)) return null;
  return {
    ...(filePath ? { path: filePath } : {}),
    ...(url ? { url } : {}),
    ...(redactSensitiveText(record.fileName, 512) ? { fileName: redactSensitiveText(record.fileName, 512) } : {}),
    ...(readString(record.mimeType, 128) ? { mimeType: readString(record.mimeType, 128) } : {}),
    ...(readNumber(record.size) != null ? { size: readNumber(record.size) } : {}),
    ...(readNumber(record.width) != null ? { width: readNumber(record.width) } : {}),
    ...(readNumber(record.height) != null ? { height: readNumber(record.height) } : {}),
    ...(readNumber(record.durationSeconds) != null ? { durationSeconds: readNumber(record.durationSeconds) } : {}),
    ...(sanitizeMetadata(record.metadata) ? { metadata: sanitizeMetadata(record.metadata) } : {}),
    ...(readNumber(record.outputIndex) != null ? { outputIndex: readNumber(record.outputIndex) } : {}),
  };
}

function sanitizeSnapshot(value: unknown): MediaGenerationJobSnapshot | null {
  const record = asRecord(value);
  const id = readString(record?.id, 4096);
  const sessionKey = readString(record?.sessionKey, 4096);
  const createdAt = readNumber(record?.createdAt);
  const updatedAt = readNumber(record?.updatedAt);
  if (!record || !id || !sessionKey || createdAt == null || updatedAt == null) return null;
  if (!['image', 'video'].includes(String(record.kind))) return null;
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(record.status))) return null;
  const progressEvents = Array.isArray(record.progressEvents)
    ? record.progressEvents.map(sanitizeProgressEvent).filter((event): event is MediaGenerationProgressEvent => event != null)
    : undefined;
  const outputs = Array.isArray(record.outputs)
    ? record.outputs.map(sanitizeOutput).filter((output): output is MediaGenerationJobOutput => output != null)
    : undefined;
  const restartRecovery = asRecord(record.restartRecovery);
  return {
    id,
    kind: record.kind as MediaGenerationJobSnapshot['kind'],
    sessionKey,
    ...(readString(record.clientRequestId, 4096) ? { clientRequestId: readString(record.clientRequestId, 4096) } : {}),
    ...(readString(record.runId, 4096) ? { runId: readString(record.runId, 4096) } : {}),
    ...(['standalone', 'composite'].includes(String(record.ownerKind))
      ? { ownerKind: record.ownerKind as MediaGenerationJobSnapshot['ownerKind'] }
      : {}),
    status: record.status as MediaGenerationJobSnapshot['status'],
    createdAt,
    updatedAt,
    ...(readNumber(record.startedAt) != null ? { startedAt: readNumber(record.startedAt) } : {}),
    ...(readNumber(record.completedAt) != null ? { completedAt: readNumber(record.completedAt) } : {}),
    ...(progressEvents ? { progressEvents } : {}),
    ...(redactSensitiveText(record.error, MAX_DIAGNOSTIC_CHARS) ? { error: redactSensitiveText(record.error, MAX_DIAGNOSTIC_CHARS) } : {}),
    ...(['pending', 'succeeded', 'failed', 'skipped'].includes(String(record.deliveryStatus))
      ? { deliveryStatus: record.deliveryStatus as MediaGenerationJobSnapshot['deliveryStatus'] }
      : {}),
    ...(redactSensitiveText(record.deliveryError, MAX_DIAGNOSTIC_CHARS) ? { deliveryError: redactSensitiveText(record.deliveryError, MAX_DIAGNOSTIC_CHARS) } : {}),
    ...(readBoolean(record.recoverable) != null ? { recoverable: readBoolean(record.recoverable) } : {}),
    ...(restartRecovery
      && ['queued', 'running'].includes(String(restartRecovery.previousStatus))
      && readNumber(restartRecovery.recoveredAt) != null
      && restartRecovery.reason === 'main_process_restart'
      ? {
          restartRecovery: {
            previousStatus: restartRecovery.previousStatus as 'queued' | 'running',
            recoveredAt: readNumber(restartRecovery.recoveredAt)!,
            reason: 'main_process_restart' as const,
          },
        }
      : {}),
    ...(outputs ? { outputs } : {}),
  };
}

function sanitizeEntry(value: unknown): MediaGenerationJournalEntry | null {
  const record = asRecord(value);
  const payload = sanitizePayload(record?.payload);
  const snapshot = sanitizeSnapshot(record?.snapshot);
  if (!record || !payload || !snapshot) return null;
  if (payload.kind !== snapshot.kind || payload.sessionKey !== snapshot.sessionKey) return null;
  return { payload, snapshot };
}

function buildJournal(entries: MediaGenerationJournalEntry[]): MediaGenerationJournalFile {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    updatedAt: Date.now(),
    jobs: entries.map(sanitizeEntry).filter((entry): entry is MediaGenerationJournalEntry => entry != null),
  };
}

async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const directory = await fsP.open(directoryPath, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Directory fsync is not supported on every platform/filesystem.
  }
}

export function getMediaGenerationJobJournalPath(userDataDir: string): string {
  return path.join(userDataDir, JOURNAL_FILE_NAME);
}

export function loadMediaGenerationJobJournal(filePath: string): MediaGenerationJournalEntry[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed = asRecord(JSON.parse(raw));
  if (!parsed || parsed.schemaVersion !== JOURNAL_SCHEMA_VERSION || !Array.isArray(parsed.jobs)) {
    throw new Error('Unsupported media generation job journal schema');
  }
  return parsed.jobs.map(sanitizeEntry).filter((entry): entry is MediaGenerationJournalEntry => entry != null);
}

export async function writeMediaGenerationJobJournal(
  filePath: string,
  entries: MediaGenerationJournalEntry[],
): Promise<void> {
  const directoryPath = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify(buildJournal(entries), null, 2)}\n`;
  await fsP.mkdir(directoryPath, { recursive: true });
  try {
    const handle = await fsP.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsP.rename(temporaryPath, filePath);
    try {
      await fsP.chmod(filePath, 0o600);
    } catch {
      // Best effort on filesystems that do not expose POSIX permissions.
    }
    await syncDirectory(directoryPath);
  } finally {
    await fsP.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
