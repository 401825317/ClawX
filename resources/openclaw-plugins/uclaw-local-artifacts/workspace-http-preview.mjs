import { randomBytes } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_IDLE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_LIFETIME_MS = 10 * 60 * 1000;
const MAX_HTML_BYTES = 20 * 1024 * 1024;
const MAX_ACTIVE_PREVIEWS = 8;
const MAX_ACTIVE_BYTES = 64 * 1024 * 1024;
const activePreviews = new Set();
const activePreviewRecords = new Map();
let activePreviewBytes = 0;
let startQueue = Promise.resolve();

export class WorkspacePreviewError extends Error {
  constructor(code, message, recovery) {
    super(message);
    this.name = 'WorkspacePreviewError';
    this.code = code;
    this.recoverable = true;
    this.restartGateway = false;
    this.recovery = recovery;
  }
}

function previewError(code, message, recovery) {
  return new WorkspacePreviewError(code, message, recovery);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function optionalIdentity(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeOwner(owner) {
  return {
    runId: optionalIdentity(owner?.runId),
    sessionKey: optionalIdentity(owner?.sessionKey),
    sessionId: optionalIdentity(owner?.sessionId),
  };
}

function recordBelongsToOwner(record, owner, { includeUnowned = false } = {}) {
  const expected = normalizeOwner(owner);
  const actual = record.owner;
  let compared = false;
  for (const key of ['runId', 'sessionKey', 'sessionId']) {
    if (!expected[key] || !actual[key]) continue;
    compared = true;
    if (expected[key] !== actual[key]) return false;
  }
  if (compared) return true;
  const actualOwned = Boolean(actual.runId || actual.sessionKey || actual.sessionId);
  const expectedOwned = Boolean(expected.runId || expected.sessionKey || expected.sessionId);
  return !actualOwned && (!expectedOwned || includeUnowned);
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){0,3}$/u.test(normalized);
}

function normalizePreviewCandidate(value) {
  try {
    const parsed = new URL(String(value ?? '').trim());
    if (
      parsed.protocol !== 'http:'
      || parsed.hostname !== LOOPBACK_HOST
      || !parsed.port
      || parsed.username
      || parsed.password
      || parsed.search
    ) return null;
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

export function isLoopbackBrowserUrl(value) {
  try {
    const parsed = new URL(String(value ?? '').trim());
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function isAuthorizedWorkspaceHtmlPreviewUrl(value, owner) {
  const candidate = normalizePreviewCandidate(value);
  if (!candidate) return false;
  for (const record of activePreviewRecords.values()) {
    if (!record.closed() && record.browserUrl === candidate && recordBelongsToOwner(record, owner)) {
      return true;
    }
  }
  return false;
}

function inputPath(workspaceDir, value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw previewError('workspace_preview_path_required', 'A local HTML path is required', 'Create the HTML artifact first, then retry with its absolute path.');
  if (/^file:/iu.test(raw)) {
    try {
      return fileURLToPath(new URL(raw));
    } catch {
      throw previewError('workspace_preview_file_url_invalid', 'The local file URL is invalid', 'Use the absolute path returned by the artifact tool.');
    }
  }
  // Windows drive paths such as C:\workspace\app.html contain a colon but are
  // filesystem paths, not custom URL schemes.
  if (path.isAbsolute(raw)) return path.resolve(raw);
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw)) {
    throw previewError('workspace_preview_protocol_unsupported', 'Only a local path or file URL can be converted to a workspace preview', 'Pass an HTTP or HTTPS URL directly to browser; use this tool only for workspace HTML.');
  }
  return path.resolve(workspaceDir, raw);
}

async function loadAuthorizedHtml(workspaceDir, requestedPath) {
  let workspaceReal;
  let fileReal;
  try {
    [workspaceReal, fileReal] = await Promise.all([realpath(workspaceDir), realpath(requestedPath)]);
  } catch {
    throw previewError('workspace_preview_not_found', 'The workspace or HTML file no longer exists', 'Regenerate the artifact and use the new path.');
  }
  if (!isInside(workspaceReal, fileReal)) {
    throw previewError('workspace_preview_outside_workspace', 'The HTML file is outside the active workspace', 'Move or regenerate the file inside the active workspace.');
  }
  if (path.extname(fileReal).toLowerCase() !== '.html' && path.extname(fileReal).toLowerCase() !== '.htm') {
    throw previewError('workspace_preview_not_html', 'Only an HTML artifact can be served by the local preview', 'Use the matching artifact viewer for this file type.');
  }
  const handle = await open(fileReal, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw previewError('workspace_preview_not_file', 'The requested preview target is not a file', 'Select one HTML file inside the workspace.');
    }
    if (before.size > MAX_HTML_BYTES) {
      throw previewError('workspace_preview_too_large', `The HTML artifact exceeds the ${MAX_HTML_BYTES} byte preview limit`, 'Reduce the single-file artifact size or open it with an external browser.');
    }
    const body = await handle.readFile();
    const [after, fileRealAfterRead] = await Promise.all([handle.stat(), realpath(fileReal)]);
    if (
      body.length > MAX_HTML_BYTES
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ino !== after.ino
      || fileRealAfterRead !== fileReal
    ) {
      throw previewError('workspace_preview_file_changed', 'The HTML artifact changed while it was being authorized', 'Wait for the file write to finish, then retry once with the latest artifact path.');
    }
    return { workspaceReal, fileReal, body, mtimeMs: after.mtimeMs };
  } finally {
    await handle.close();
  }
}

async function reservePreviewCapacity(bodyLength) {
  while (
    activePreviews.size >= MAX_ACTIVE_PREVIEWS
    || (activePreviews.size > 0 && activePreviewBytes + bodyLength > MAX_ACTIVE_BYTES)
  ) {
    const oldest = activePreviews.values().next().value;
    if (!oldest) break;
    await oldest('capacity_replaced');
  }
  if (bodyLength > MAX_ACTIVE_BYTES) {
    throw previewError('workspace_preview_capacity_exceeded', 'The HTML artifact exceeds the total preview memory budget', 'Reduce the artifact size and retry.');
  }
}

function securityHeaders(bodyLength) {
  return {
    'Cache-Control': 'no-store, max-age=0',
    'Content-Length': String(bodyLength),
    'Content-Security-Policy': "default-src 'self' data: blob:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' blob:",
    'Content-Type': 'text/html; charset=utf-8',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

async function startWorkspaceHtmlPreviewInternal(options) {
  const workspaceDir = path.resolve(String(options?.workspaceDir ?? ''));
  const requestedPath = inputPath(workspaceDir, options?.filePath);
  if (options?.signal?.aborted) {
    throw previewError('workspace_preview_aborted', 'The preview request was cancelled', 'Retry only if the user still wants to open this artifact.');
  }
  const authorized = await loadAuthorizedHtml(workspaceDir, requestedPath);
  if (options?.signal?.aborted) {
    throw previewError('workspace_preview_aborted', 'The preview request was cancelled', 'Retry only if the user still wants to open this artifact.');
  }
  await reservePreviewCapacity(authorized.body.length);
  if (options?.signal?.aborted) {
    throw previewError('workspace_preview_aborted', 'The preview request was cancelled', 'Retry only if the user still wants to open this artifact.');
  }
  const token = randomBytes(32).toString('base64url');
  const route = `/${token}/index.html`;
  const idleTtlMs = Math.max(50, Number(options?.idleTtlMs) || DEFAULT_IDLE_TTL_MS);
  const maxLifetimeMs = Math.max(idleTtlMs, Number(options?.maxLifetimeMs) || DEFAULT_MAX_LIFETIME_MS);
  const sockets = new Set();
  let idleTimer;
  let lifetimeTimer;
  let closed = false;
  let listening = false;
  let closePromise;
  let closeReason = null;
  let settleListen;
  let listenSettled = false;
  const listenSettlement = new Promise((resolve) => { settleListen = resolve; });
  const markListenSettled = () => {
    if (listenSettled) return;
    listenSettled = true;
    settleListen();
  };

  const server = createServer((request, response) => {
    request.setTimeout(5000, () => request.destroy());
    let pathname = '';
    try {
      pathname = new URL(request.url || '/', `http://${LOOPBACK_HOST}`).pathname;
    } catch {
      response.writeHead(400, { 'Cache-Control': 'no-store', Connection: 'close' });
      response.end();
      return;
    }
    if (pathname !== route) {
      response.writeHead(404, { 'Cache-Control': 'no-store', Connection: 'close' });
      response.end();
      return;
    }
    const address = server.address();
    const expectedHost = address && typeof address !== 'string'
      ? `${LOOPBACK_HOST}:${address.port}`
      : '';
    if (request.headers.host !== expectedHost) {
      response.writeHead(400, { 'Cache-Control': 'no-store', Connection: 'close' });
      response.end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store', Connection: 'close' });
      response.end();
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void close('idle_timeout'), idleTtlMs);
    idleTimer.unref?.();
    response.writeHead(200, securityHeaders(authorized.body.length));
    response.end(request.method === 'HEAD' ? undefined : authorized.body);
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.keepAliveTimeout = 2000;

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.setTimeout(10_000, () => socket.destroy());
    socket.unref?.();
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  const close = async (reason = 'closed') => {
    if (closePromise) return closePromise;
    closed = true;
    closeReason = reason;
    clearTimeout(idleTimer);
    clearTimeout(lifetimeTimer);
    options?.signal?.removeEventListener?.('abort', onAbort);
    if (activePreviews.delete(close)) activePreviewBytes -= authorized.body.length;
    activePreviewRecords.delete(close);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    closePromise = (async () => {
      await listenSettlement;
      if (!listening) return;
      await new Promise((resolve) => server.close(() => resolve()));
      listening = false;
    })();
    return closePromise;
  };
  const onAbort = () => void close('aborted');
  options?.signal?.addEventListener?.('abort', onAbort, { once: true });
  if (options?.signal?.aborted) onAbort();

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      markListenSettled();
      reject(error);
    };
    const onListening = () => {
      listening = true;
      server.off('error', onError);
      markListenSettled();
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(0, LOOPBACK_HOST);
    } catch (error) {
      onError(error);
    }
  }).catch(async () => {
    options?.signal?.removeEventListener?.('abort', onAbort);
    await close('listen_failed');
    throw previewError('workspace_preview_listen_failed', 'The loopback preview could not start', 'Open the artifact with the external-browser action or retry once.');
  });

  if (closed) {
    await close();
    throw previewError('workspace_preview_aborted', 'The preview request was cancelled', 'Retry only if the user still wants to open this artifact.');
  }

  server.unref();
  const address = server.address();
  if (!address || typeof address === 'string') {
    await close('invalid_address');
    throw previewError('workspace_preview_listen_failed', 'The loopback preview did not receive a TCP address', 'Open the artifact with the external-browser action or retry once.');
  }
  activePreviews.add(close);
  activePreviewBytes += authorized.body.length;
  const browserUrl = `http://${LOOPBACK_HOST}:${address.port}${route}`;
  activePreviewRecords.set(close, {
    browserUrl,
    owner: normalizeOwner(options?.owner),
    closed: () => closed,
  });
  idleTimer = setTimeout(() => void close('idle_timeout'), idleTtlMs);
  lifetimeTimer = setTimeout(() => void close('max_lifetime'), maxLifetimeMs);
  idleTimer.unref?.();
  lifetimeTimer.unref?.();

  return {
    browserUrl,
    host: LOOPBACK_HOST,
    port: address.port,
    filePath: authorized.fileReal,
    workspacePath: authorized.workspaceReal,
    fileSize: authorized.body.length,
    mtimeMs: authorized.mtimeMs,
    expiresAt: new Date(Date.now() + maxLifetimeMs).toISOString(),
    close,
    get closed() { return closed; },
    get closeReason() { return closeReason; },
  };
}

export async function startWorkspaceHtmlPreview(options) {
  const previous = startQueue;
  let release;
  startQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await startWorkspaceHtmlPreviewInternal(options);
  } finally {
    release();
  }
}

export async function closeAllWorkspaceHtmlPreviews(reason = 'plugin_cleanup') {
  await Promise.all([...activePreviews].map((close) => close(reason)));
}

export async function closeWorkspaceHtmlPreviewsForOwner(owner, reason = 'owner_cleanup') {
  const matches = [];
  for (const [close, record] of activePreviewRecords) {
    if (recordBelongsToOwner(record, owner, { includeUnowned: true })) matches.push(close);
  }
  await Promise.all(matches.map((close) => close(reason)));
}

export function serializeWorkspacePreviewError(error) {
  if (error instanceof WorkspacePreviewError) {
    return {
      code: error.code,
      message: error.message,
      recoverable: true,
      restartGateway: false,
      recovery: error.recovery,
    };
  }
  return {
    code: 'workspace_preview_failed',
    message: 'The workspace preview could not be prepared',
    recoverable: true,
    restartGateway: false,
    recovery: 'Retry once with the latest workspace HTML path; do not restart Gateway.',
  };
}

export const __test = {
  activePreviews,
  activePreviewRecords,
  get activePreviewBytes() { return activePreviewBytes; },
  inputPath,
  isInside,
  loadAuthorizedHtml,
};
