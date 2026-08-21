import { randomBytes } from 'crypto';
import { createServer, type Server } from 'http';
import type { Socket } from 'net';
import { normalizeWorkspaceHtmlPreviewCapabilityUrl } from '../../shared/web-browser';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_IDLE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_LIFETIME_MS = 10 * 60 * 1000;
export const MAX_WORKSPACE_HTML_BYTES = 20 * 1024 * 1024;
const MAX_ACTIVE_PREVIEWS = 4;
const MAX_TOTAL_PREVIEW_BYTES = 40 * 1024 * 1024;

type PreviewRecord = {
  filePath: string;
  browserUrl: string;
  bodyBytes: number;
  close: (reason?: string) => Promise<void>;
};

export type WorkspaceHtmlPreview = {
  browserUrl: string;
  close: (reason?: string) => Promise<void>;
};

type PreviewCapabilityRecord = {
  expiresAt: number;
  nonce: symbol;
};

class WorkspaceHtmlPreviewCapabilityRegistry {
  private readonly active = new Map<string, PreviewCapabilityRecord>();

  register(browserUrl: string, expiresAt: number): () => void {
    const normalized = normalizeWorkspaceHtmlPreviewCapabilityUrl(browserUrl);
    if (!normalized || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error('Invalid workspace HTML preview capability');
    }
    const nonce = Symbol('workspace-html-preview-capability');
    this.active.set(normalized, { expiresAt, nonce });
    let revoked = false;
    return () => {
      if (revoked) return;
      revoked = true;
      const current = this.active.get(normalized);
      if (current?.nonce === nonce) this.active.delete(normalized);
    };
  }

  isActive(input: string, now = Date.now()): boolean {
    const normalized = normalizeWorkspaceHtmlPreviewCapabilityUrl(input);
    if (!normalized) return false;
    const record = this.active.get(normalized);
    if (!record) return false;
    if (record.expiresAt <= now) {
      this.active.delete(normalized);
      return false;
    }
    return true;
  }

  get size(): number {
    return this.active.size;
  }
}

const workspaceHtmlPreviewCapabilities = new WorkspaceHtmlPreviewCapabilityRegistry();

export function registerWorkspaceHtmlPreviewCapability(
  browserUrl: string,
  expiresAt: number,
): () => void {
  return workspaceHtmlPreviewCapabilities.register(browserUrl, expiresAt);
}

export function isActiveWorkspaceHtmlPreviewUrl(input: string, now = Date.now()): boolean {
  return workspaceHtmlPreviewCapabilities.isActive(input, now);
}

function securityHeaders(bodyLength: number): Record<string, string> {
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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Serves one already-authorized HTML artifact through an unguessable loopback
 * URL. It deliberately has no directory serving, proxying, or file reads after
 * creation, so changing a path cannot widen what the browser may access.
 */
export class WorkspaceHtmlPreviewService {
  private readonly previewsByFile = new Map<string, PreviewRecord>();
  private operationTail: Promise<void> = Promise.resolve();
  private generation = 0;
  private totalBodyBytes = 0;

  async start(filePath: string, body: Buffer): Promise<WorkspaceHtmlPreview> {
    if (body.length > MAX_WORKSPACE_HTML_BYTES) {
      throw new Error('Workspace HTML preview exceeds the 20 MB limit');
    }
    const generation = this.generation;
    return this.serialize(() => this.startExclusive(filePath, body, generation));
  }

  private async startExclusive(
    filePath: string,
    body: Buffer,
    generation: number,
  ): Promise<WorkspaceHtmlPreview> {
    if (generation !== this.generation) {
      throw new Error('Workspace HTML preview was superseded by cleanup');
    }

    const previous = this.previewsByFile.get(filePath);
    await previous?.close('replaced');
    while (
      this.previewsByFile.size >= MAX_ACTIVE_PREVIEWS
      || this.totalBodyBytes + body.length > MAX_TOTAL_PREVIEW_BYTES
    ) {
      const oldest = this.previewsByFile.values().next().value as PreviewRecord | undefined;
      if (!oldest) break;
      await oldest.close('capacity_eviction');
    }

    const token = randomBytes(32).toString('base64url');
    const route = `/${token}/index.html`;
    const sockets = new Set<Socket>();
    let idleTimer: NodeJS.Timeout | undefined;
    let lifetimeTimer: NodeJS.Timeout | undefined;
    let closed = false;
    let listening = false;
    let closePromise: Promise<void> | undefined;
    let accounted = false;
    let revokeCapability: (() => void) | undefined;

    const server = createServer((request, response) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
      } catch {
        response.writeHead(400, { 'Cache-Control': 'no-store', Connection: 'close' });
        response.end();
        return;
      }
      if (parsedUrl.pathname !== route) {
        response.writeHead(404, { 'Cache-Control': 'no-store', Connection: 'close' });
        response.end();
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store', Connection: 'close' });
        response.end();
        return;
      }
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => void close('idle_timeout'), DEFAULT_IDLE_TTL_MS);
      idleTimer.unref?.();
      response.writeHead(200, securityHeaders(body.length));
      response.end(request.method === 'HEAD' ? undefined : body);
    });
    server.headersTimeout = 5_000;
    server.requestTimeout = 5_000;
    server.keepAliveTimeout = 2_000;
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.setTimeout(10_000, () => socket.destroy());
      socket.unref();
      socket.once('close', () => sockets.delete(socket));
    });
    server.on('clientError', (_error, socket) => socket.destroy());

    let record: PreviewRecord | undefined;
    const close = async (_reason = 'closed'): Promise<void> => {
      if (closePromise) return closePromise;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (lifetimeTimer) clearTimeout(lifetimeTimer);
      revokeCapability?.();
      revokeCapability = undefined;
      if (this.previewsByFile.get(filePath) === record) this.previewsByFile.delete(filePath);
      if (accounted) {
        accounted = false;
        this.totalBodyBytes = Math.max(0, this.totalBodyBytes - body.length);
      }
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      closePromise = listening ? closeServer(server) : Promise.resolve();
      return closePromise;
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          listening = true;
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, LOOPBACK_HOST);
      });
    } catch (error) {
      await close('listen_failed');
      throw error;
    }
    if (closed || generation !== this.generation) {
      await close('superseded');
      throw new Error('Workspace HTML preview was closed before it became available');
    }

    server.unref();
    const address = server.address();
    if (!address || typeof address === 'string') {
      await close('invalid_address');
      throw new Error('Workspace HTML preview did not receive a TCP address');
    }
    idleTimer = setTimeout(() => void close('idle_timeout'), DEFAULT_IDLE_TTL_MS);
    lifetimeTimer = setTimeout(() => void close('max_lifetime'), DEFAULT_MAX_LIFETIME_MS);
    idleTimer.unref?.();
    lifetimeTimer.unref?.();
    const browserUrl = `http://${LOOPBACK_HOST}:${address.port}${route}`;
    revokeCapability = registerWorkspaceHtmlPreviewCapability(
      browserUrl,
      Date.now() + DEFAULT_MAX_LIFETIME_MS,
    );
    record = { filePath, browserUrl, bodyBytes: body.length, close };
    accounted = true;
    this.totalBodyBytes += body.length;
    this.previewsByFile.set(filePath, record);
    return { browserUrl, close };
  }

  async closeAll(reason = 'application_cleanup'): Promise<void> {
    this.generation += 1;
    await this.serialize(async () => {
      await Promise.all([...this.previewsByFile.values()].map((preview) => preview.close(reason)));
    });
  }

  get activeCount(): number {
    return this.previewsByFile.size;
  }

  get activeCapabilityCount(): number {
    return workspaceHtmlPreviewCapabilities.size;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
