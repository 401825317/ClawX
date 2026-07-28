import { randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type {
  AttachmentAccessError,
  AttachmentFileRef,
} from '@shared/host-api/contract';
import type { AcpSessionAccessRegistry } from './acp-session-access-registry';

export const ATTACHMENT_VIDEO_STREAM_SCHEME = 'uclaw-media';
export const ATTACHMENT_VIDEO_STREAM_HOST = 'attachment';

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_STREAM_ID_LENGTH = 128;
const STREAM_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const ATTACHMENT_ACCESS_ERRORS = new Set<AttachmentAccessError>([
  'invalidReference',
  'staleSession',
  'unavailable',
  'notFile',
  'unsafeUrl',
  'operationFailed',
]);

type AttachmentVideoStreamHandle = Pick<FileHandle, 'close' | 'createReadStream'>;

export type AttachmentVideoStreamSource = {
  handle: AttachmentVideoStreamHandle;
  size: number;
  mimeType: string;
};

export type AttachmentVideoStreamError = AttachmentAccessError | 'unsupportedMedia';

export type AttachmentVideoStreamCreateResult =
  | {
      ok: true;
      streamId: string;
      url: string;
      mimeType: string;
      size: number;
    }
  | { ok: false; error: AttachmentVideoStreamError };

export type AttachmentVideoStreamRequest = {
  method: string;
  url: string;
  headers: { get: (name: string) => string | null };
  signal: {
    readonly aborted: boolean;
    addEventListener: (type: 'abort', listener: () => void, options?: { once?: boolean }) => void;
    removeEventListener: (type: 'abort', listener: () => void) => void;
  };
};

export type AttachmentVideoStreamService = {
  create: (ref: AttachmentFileRef) => Promise<AttachmentVideoStreamCreateResult>;
  release: (streamId: string) => boolean;
  handle: (request: unknown) => Promise<Response>;
  dispose: () => void;
};

type AttachmentVideoStreamDependencies = {
  accessRegistry: Pick<AcpSessionAccessRegistry, 'get' | 'subscribe'>;
  openSource: (ref: AttachmentFileRef) => Promise<AttachmentVideoStreamSource>;
  maxEntries?: number;
  idleTtlMs?: number;
  now?: () => number;
  randomToken?: () => string;
};

type StreamEntry = {
  ref: AttachmentFileRef;
  expiresAt: number;
  activeStreams: Set<Readable>;
};

type ByteRange = { start: number; end: number };

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function cloneRef(ref: AttachmentFileRef): AttachmentFileRef {
  return {
    sessionKey: ref.sessionKey,
    generation: ref.generation,
    uri: ref.uri,
    ...(ref.stagingId ? { stagingId: ref.stagingId } : {}),
    ...(ref.transcriptMessageId ? { transcriptMessageId: ref.transcriptMessageId } : {}),
  };
}

function normalizedVideoMimeType(value: string): string | null {
  const mimeType = value.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  return mimeType.startsWith('video/') ? mimeType : null;
}

function validSourceSize(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function attachmentError(error: unknown): AttachmentVideoStreamError {
  const candidate = typeof error === 'string'
    ? error
    : error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof candidate === 'string' && ATTACHMENT_ACCESS_ERRORS.has(candidate as AttachmentAccessError)
    ? candidate as AttachmentAccessError
    : 'operationFailed';
}

function parseRange(value: string | null, size: number): ByteRange | null | 'invalid' {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return 'invalid';

  const parseNumber = (input: string): number | null => {
    const parsed = Number(input);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  };
  if (!match[1]) {
    const suffixLength = parseNumber(match[2] ?? '');
    if (suffixLength === null || suffixLength === 0) return 'invalid';
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = parseNumber(match[1]);
  if (start === null || start >= size) return 'invalid';
  if (!match[2]) return { start, end: size - 1 };

  const requestedEnd = parseNumber(match[2]);
  if (requestedEnd === null || requestedEnd < start) return 'invalid';
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function parseStreamId(requestUrl: string): string | null {
  try {
    const url = new URL(requestUrl);
    if (
      url.protocol !== `${ATTACHMENT_VIDEO_STREAM_SCHEME}:`
      || url.hostname !== ATTACHMENT_VIDEO_STREAM_HOST
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
    ) return null;
    const streamId = url.pathname.startsWith('/') ? url.pathname.slice(1) : '';
    return streamId.length > 0
      && streamId.length <= MAX_STREAM_ID_LENGTH
      && STREAM_ID_PATTERN.test(streamId)
      ? streamId
      : null;
  } catch {
    return null;
  }
}

function isAttachmentVideoStreamRequest(value: unknown): value is AttachmentVideoStreamRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as {
    method?: unknown;
    url?: unknown;
    headers?: { get?: unknown };
    signal?: {
      aborted?: unknown;
      addEventListener?: unknown;
      removeEventListener?: unknown;
    };
  };
  return typeof request.method === 'string'
    && typeof request.url === 'string'
    && typeof request.headers?.get === 'function'
    && typeof request.signal?.aborted === 'boolean'
    && typeof request.signal.addEventListener === 'function'
    && typeof request.signal.removeEventListener === 'function';
}

function unavailableResponse(): Response {
  return new Response(null, {
    status: 404,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function methodNotAllowedResponse(): Response {
  return new Response(null, {
    status: 405,
    headers: {
      Allow: 'GET, HEAD',
      'Cache-Control': 'no-store',
    },
  });
}

function rangeNotSatisfiableResponse(size: number): Response {
  return new Response(null, {
    status: 416,
    headers: {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': '0',
      'Content-Range': `bytes */${size}`,
    },
  });
}

async function closeSource(source: AttachmentVideoStreamSource | undefined): Promise<void> {
  await source?.handle.close().catch(() => undefined);
}

/**
 * Creates a Main-owned, revocable video stream service. The returned URL is a
 * routing token only; every protocol request reopens and reauthorizes its ref.
 */
export function createAttachmentVideoStreamService(
  dependencies: AttachmentVideoStreamDependencies,
): AttachmentVideoStreamService {
  const maxEntries = positiveInteger(dependencies.maxEntries, DEFAULT_MAX_ENTRIES);
  const idleTtlMs = positiveInteger(dependencies.idleTtlMs, DEFAULT_IDLE_TTL_MS);
  const now = dependencies.now ?? Date.now;
  const randomToken = dependencies.randomToken ?? (() => randomBytes(32).toString('base64url'));
  const entries = new Map<string, StreamEntry>();
  let disposed = false;

  const releaseEntry = (streamId: string): boolean => {
    const entry = entries.get(streamId);
    if (!entry) return false;
    entries.delete(streamId);
    const activeStreams = Array.from(entry.activeStreams);
    entry.activeStreams.clear();
    for (const stream of activeStreams) stream.destroy();
    return true;
  };

  const pruneExpired = (currentTime: number): void => {
    for (const [streamId, entry] of entries) {
      if (entry.expiresAt <= currentTime) releaseEntry(streamId);
    }
  };

  const hasCurrentGrant = (ref: AttachmentFileRef): boolean => (
    dependencies.accessRegistry.get(ref.sessionKey, ref.generation) !== null
  );

  const touchEntry = (streamId: string, entry: StreamEntry, currentTime: number): void => {
    entry.expiresAt = currentTime + idleTtlMs;
    entries.delete(streamId);
    entries.set(streamId, entry);
  };

  const nextStreamId = (): string | null => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = randomToken();
      if (
        candidate.length > 0
        && candidate.length <= MAX_STREAM_ID_LENGTH
        && STREAM_ID_PATTERN.test(candidate)
        && !entries.has(candidate)
      ) return candidate;
    }
    return null;
  };

  const unsubscribe = dependencies.accessRegistry.subscribe((context) => {
    for (const [streamId, entry] of entries) {
      if (
        !context
        || entry.ref.sessionKey !== context.sessionKey
        || entry.ref.generation !== context.generation
      ) releaseEntry(streamId);
    }
  });

  const create = async (ref: AttachmentFileRef): Promise<AttachmentVideoStreamCreateResult> => {
    if (disposed) return { ok: false, error: 'operationFailed' };
    const currentTime = now();
    pruneExpired(currentTime);
    if (!hasCurrentGrant(ref)) return { ok: false, error: 'staleSession' };

    let source: AttachmentVideoStreamSource | undefined;
    try {
      source = await dependencies.openSource(ref);
      const mimeType = normalizedVideoMimeType(source.mimeType);
      if (!mimeType || !validSourceSize(source.size)) {
        return { ok: false, error: mimeType ? 'operationFailed' : 'unsupportedMedia' };
      }
      if (!hasCurrentGrant(ref)) return { ok: false, error: 'staleSession' };

      const streamId = nextStreamId();
      if (!streamId) return { ok: false, error: 'operationFailed' };
      if (disposed || !hasCurrentGrant(ref)) return { ok: false, error: 'staleSession' };
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value as string | undefined;
        if (!oldest) break;
        releaseEntry(oldest);
      }
      const entryTime = now();
      entries.set(streamId, {
        ref: cloneRef(ref),
        expiresAt: entryTime + idleTtlMs,
        activeStreams: new Set(),
      });
      return {
        ok: true,
        streamId,
        url: `${ATTACHMENT_VIDEO_STREAM_SCHEME}://${ATTACHMENT_VIDEO_STREAM_HOST}/${streamId}`,
        mimeType,
        size: source.size,
      };
    } catch (error) {
      return { ok: false, error: attachmentError(error) };
    } finally {
      await closeSource(source);
    }
  };

  const handle = async (input: unknown): Promise<Response> => {
    if (!isAttachmentVideoStreamRequest(input)) return unavailableResponse();
    const request = input;
    if (disposed) return unavailableResponse();
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowedResponse();
    const streamId = parseStreamId(request.url);
    if (!streamId) return unavailableResponse();

    const currentTime = now();
    pruneExpired(currentTime);
    const entry = entries.get(streamId);
    if (!entry) return unavailableResponse();
    if (!hasCurrentGrant(entry.ref)) {
      releaseEntry(streamId);
      return unavailableResponse();
    }

    let source: AttachmentVideoStreamSource | undefined;
    try {
      source = await dependencies.openSource(entry.ref);
    } catch {
      return unavailableResponse();
    }
    const mimeType = normalizedVideoMimeType(source.mimeType);
    if (!mimeType || !validSourceSize(source.size)) {
      await closeSource(source);
      return unavailableResponse();
    }
    if (
      disposed
      || entries.get(streamId) !== entry
      || entry.expiresAt <= now()
      || !hasCurrentGrant(entry.ref)
      || request.signal.aborted
    ) {
      await closeSource(source);
      releaseEntry(streamId);
      return unavailableResponse();
    }

    const range = parseRange(request.headers.get('range'), source.size);
    if (range === 'invalid') {
      await closeSource(source);
      return rangeNotSatisfiableResponse(source.size);
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, source.size - 1);
    const contentLength = source.size === 0 ? 0 : end - start + 1;
    const headers: Record<string, string> = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': String(contentLength),
      'Content-Type': mimeType,
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${source.size}`;
    const status = range ? 206 : 200;
    touchEntry(streamId, entry, now());

    if (method === 'HEAD' || source.size === 0) {
      await closeSource(source);
      return new Response(null, { status, headers });
    }

    let stream: Readable;
    try {
      stream = source.handle.createReadStream({ start, end, autoClose: true });
    } catch {
      await closeSource(source);
      return unavailableResponse();
    }
    entry.activeStreams.add(stream);
    const abort = () => stream.destroy();
    const cleanup = () => {
      entry.activeStreams.delete(stream);
      request.signal.removeEventListener('abort', abort);
      void source.handle.close().catch(() => undefined);
    };
    stream.once('close', cleanup);
    stream.once('error', cleanup);
    request.signal.addEventListener('abort', abort, { once: true });

    try {
      const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
      return new Response(body, { status, headers });
    } catch {
      stream.destroy();
      return unavailableResponse();
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    for (const streamId of Array.from(entries.keys())) releaseEntry(streamId);
  };

  return {
    create,
    release: releaseEntry,
    handle,
    dispose,
  };
}
