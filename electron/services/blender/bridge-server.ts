import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { blenderJobService } from './job-service';
import type {
  BlenderJobRequest,
  BlenderJobSnapshot,
  BlenderRepairPatch,
} from './types';

const BRIDGE_HOST = '127.0.0.1';
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_WAIT_MS = 90_000;

export type BlenderBridgeEnvironment = {
  CLAWX_HOST_API_ORIGIN: string;
  CLAWX_HOST_API_TOKEN: string;
};

type BlenderBridgeJobService = {
  capabilities: () => Promise<unknown>;
  create: (request: BlenderJobRequest) => Promise<{ job: BlenderJobSnapshot; idempotent: boolean }>;
  waitForTerminal: (jobId: string, waitMs: number) => Promise<BlenderJobSnapshot | undefined>;
  get: (jobId: string) => Promise<BlenderJobSnapshot | undefined>;
  repair: (
    jobId: string,
    baseRevision: number,
    patches: BlenderRepairPatch[],
    clientRequestId: string,
  ) => Promise<{ job: BlenderJobSnapshot; idempotent: boolean }>;
  shutdown: () => Promise<void> | void;
};

type ActiveBlenderBridge = {
  server: Server;
  environment: BlenderBridgeEnvironment;
  jobService: BlenderBridgeJobService;
};

class JsonBodyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let activeBridge: ActiveBlenderBridge | undefined;
let startPromise: Promise<BlenderBridgeEnvironment> | undefined;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseWaitMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(MAX_WAIT_MS, Math.max(0, Math.floor(value)));
}

function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function hasJsonContentType(req: IncomingMessage): boolean {
  return /^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] ?? '');
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const rawChunk of req) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) {
      req.resume();
      throw new JsonBodyError('JSON body exceeds 1 MiB', 413);
    }
    chunks.push(chunk);
  }

  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new JsonBodyError('JSON body must be an object', 400);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof JsonBodyError) throw error;
    throw new JsonBodyError('Invalid JSON body', 400);
  }
}

function decodePathSegments(pathname: string): string[] | null {
  try {
    return pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  jobService: BlenderBridgeJobService,
): Promise<void> {
  if (!isAuthorized(req, token)) {
    sendJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
  const segments = decodePathSegments(requestUrl.pathname);
  if (!segments) {
    sendJson(res, 400, { success: false, error: 'Invalid request path' });
    return;
  }

  try {
    if (req.method === 'GET' && requestUrl.pathname === '/api/blender/capabilities') {
      sendJson(res, 200, { success: true, capabilities: await jobService.capabilities() });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/blender/jobs') {
      if (!hasJsonContentType(req)) {
        sendJson(res, 415, { success: false, error: 'Content-Type must be application/json' });
        return;
      }
      const body = await parseJsonBody(req);
      const created = await jobService.create(body as BlenderJobRequest);
      const job = await jobService.waitForTerminal(created.job.jobId, parseWaitMs(body.waitMs));
      sendJson(res, created.idempotent ? 200 : 202, {
        success: true,
        idempotent: created.idempotent,
        job: job ?? created.job,
      });
      return;
    }

    if (req.method === 'GET' && segments.length === 4
      && segments[0] === 'api' && segments[1] === 'blender' && segments[2] === 'jobs') {
      const job = await jobService.get(segments[3]!);
      sendJson(res, job ? 200 : 404, job
        ? { success: true, job }
        : { success: false, error: 'Blender job not found' });
      return;
    }

    if (req.method === 'POST' && segments.length === 5
      && segments[0] === 'api' && segments[1] === 'blender'
      && segments[2] === 'jobs' && segments[4] === 'repair') {
      if (!hasJsonContentType(req)) {
        sendJson(res, 415, { success: false, error: 'Content-Type must be application/json' });
        return;
      }
      const body = await parseJsonBody(req);
      const created = await jobService.repair(
        segments[3]!,
        Number(body.baseRevision),
        Array.isArray(body.patches) ? body.patches as BlenderRepairPatch[] : [],
        typeof body.clientRequestId === 'string' && body.clientRequestId.trim()
          ? body.clientRequestId.trim()
          : `repair:${segments[3]}:${Date.now()}`,
      );
      const job = await jobService.waitForTerminal(created.job.jobId, parseWaitMs(body.waitMs));
      sendJson(res, created.idempotent ? 200 : 202, {
        success: true,
        idempotent: created.idempotent,
        job: job ?? created.job,
      });
      return;
    }

    sendJson(res, 404, { success: false, error: `No route for ${req.method ?? 'UNKNOWN'} ${requestUrl.pathname}` });
  } catch (error) {
    const status = error instanceof JsonBodyError ? error.status : 400;
    sendJson(res, status, { success: false, error: errorMessage(error) });
  }
}

async function startServer(jobService: BlenderBridgeJobService): Promise<BlenderBridgeEnvironment> {
  const token = randomBytes(32).toString('hex');
  const server = createServer((req, res) => {
    void handleRequest(req, res, token, jobService).catch((error) => {
      sendJson(res, 500, { success: false, error: errorMessage(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, BRIDGE_HOST, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address.port !== 'number') {
    server.close();
    throw new Error('Blender bridge did not receive a loopback port');
  }
  const environment = {
    CLAWX_HOST_API_ORIGIN: `http://${BRIDGE_HOST}:${address.port}`,
    CLAWX_HOST_API_TOKEN: token,
  };
  activeBridge = { server, environment, jobService };
  return { ...environment };
}

/** Start the private loopback bridge used only by the bundled Blender plugin. */
export async function startBlenderBridgeServer(options: {
  jobService?: BlenderBridgeJobService;
} = {}): Promise<BlenderBridgeEnvironment> {
  if (activeBridge) return { ...activeBridge.environment };
  if (startPromise) return await startPromise;
  startPromise = startServer(options.jobService ?? blenderJobService);
  try {
    return await startPromise;
  } finally {
    startPromise = undefined;
  }
}

/** Return launch-only Gateway variables without mutating the parent environment. */
export function getBlenderBridgeEnvironment(): Partial<BlenderBridgeEnvironment> {
  return activeBridge ? { ...activeBridge.environment } : {};
}

/** Stop accepting jobs and terminate the active trusted Blender process. */
export async function stopBlenderBridgeServer(): Promise<void> {
  if (!activeBridge && startPromise) await startPromise.catch(() => undefined);
  const bridge = activeBridge;
  activeBridge = undefined;
  if (!bridge) return;

  await Promise.allSettled([
    Promise.resolve(bridge.jobService.shutdown()),
    new Promise<void>((resolve) => {
      bridge.server.close(() => resolve());
      bridge.server.closeAllConnections?.();
    }),
  ]);
}
