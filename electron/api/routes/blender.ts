import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { blenderJobService, type BlenderJobRequest, type BlenderRepairPatch } from '../../services/blender';

function parseWaitMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.floor(value)), 90_000);
}

export async function handleBlenderRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/blender/capabilities' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, capabilities: await blenderJobService.capabilities() });
    } catch (error) {
      sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/blender/jobs' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<BlenderJobRequest & { waitMs?: number }>(req);
      const created = await blenderJobService.create(body);
      const job = await blenderJobService.waitForTerminal(created.job.jobId, parseWaitMs(body.waitMs));
      sendJson(res, created.idempotent ? 200 : 202, { success: true, idempotent: created.idempotent, job });
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/blender/jobs' && req.method === 'GET') {
    try {
      const sessionKey = url.searchParams.get('sessionKey')?.trim() || undefined;
      sendJson(res, 200, { success: true, jobs: await blenderJobService.list(sessionKey) });
    } catch (error) {
      sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (!url.pathname.startsWith('/api/blender/jobs/')) return false;
  const segments = url.pathname.slice('/api/blender/jobs/'.length).split('/').filter(Boolean).map(decodeURIComponent);
  const jobId = segments[0]?.trim();
  const action = segments[1]?.trim();
  if (!jobId) return false;
  if (!action && req.method === 'GET') {
    const job = await blenderJobService.get(jobId);
    sendJson(res, job ? 200 : 404, job ? { success: true, job } : { success: false, error: 'Blender job not found' });
    return true;
  }
  if (action === 'cancel' && req.method === 'POST') {
    const body = await parseJsonBody<{ source?: string }>(req).catch(() => ({}));
    const job = await blenderJobService.cancel(jobId, body.source?.trim() || 'host-api');
    sendJson(res, job ? 200 : 404, job ? { success: true, job } : { success: false, error: 'Blender job not found' });
    return true;
  }
  if (action === 'repair' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ baseRevision?: number; patches?: BlenderRepairPatch[]; clientRequestId?: string; waitMs?: number }>(req);
      const created = await blenderJobService.repair(
        jobId,
        Number(body.baseRevision),
        Array.isArray(body.patches) ? body.patches : [],
        body.clientRequestId?.trim() || `repair:${jobId}:${Date.now()}`,
      );
      const job = await blenderJobService.waitForTerminal(created.job.jobId, parseWaitMs(body.waitMs));
      sendJson(res, created.idempotent ? 200 : 202, { success: true, idempotent: created.idempotent, job });
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  return false;
}
