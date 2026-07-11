import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { desktopRunCoordinator } from '../../services/computer';
import type {
  DesktopActionRequest,
  DesktopObservationRequest,
  DesktopRunContext,
} from '../../services/computer';

function readContext(body: Record<string, unknown>): DesktopRunContext {
  return {
    sessionKey: typeof body.sessionKey === 'string' ? body.sessionKey.trim() : '',
    runId: typeof body.runId === 'string' ? body.runId.trim() : '',
  };
}

function responseStatusForAction(result: Awaited<ReturnType<typeof desktopRunCoordinator.requestAction>>): number {
  if (result.status === 'approval_required') return 202;
  if (result.status === 'completed') return 200;
  return result.error.retryable ? 409 : 400;
}

export async function handleComputerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/computer/capabilities' && req.method === 'GET') {
    sendJson(res, 200, { success: true, result: await desktopRunCoordinator.getCapabilities() });
    return true;
  }

  if (url.pathname === '/api/computer/apps' && req.method === 'GET') {
    sendJson(res, 200, { success: true, result: { apps: await desktopRunCoordinator.listApps() } });
    return true;
  }

  if ((url.pathname === '/api/computer/state' || url.pathname === '/api/computer/desktop-screenshot') && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      const context = readContext(body);
      const request: DesktopObservationRequest = {
        target: body.target && typeof body.target === 'object'
          ? body.target as DesktopObservationRequest['target']
          : undefined,
        maxScreenshotSide: typeof body.maxScreenshotSide === 'number' ? body.maxScreenshotSide : undefined,
      };
      const state = await desktopRunCoordinator.observe(context, request);
      sendJson(res, state.error ? 409 : 200, { success: !state.error, result: state, state, ...(state.error ? { error: state.error.message } : {}) });
    } catch (routeError) {
      sendJson(res, 400, { success: false, error: routeError instanceof Error ? routeError.message : String(routeError) });
    }
    return true;
  }

  if (url.pathname === '/api/computer/actions' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<DesktopActionRequest>(req);
      const result = await desktopRunCoordinator.requestAction(body);
      sendJson(res, responseStatusForAction(result), { success: result.status !== 'blocked', result });
    } catch (routeError) {
      sendJson(res, 400, { success: false, error: routeError instanceof Error ? routeError.message : String(routeError) });
    }
    return true;
  }

  if (url.pathname === '/api/computer/approvals' && req.method === 'GET') {
    const sessionKey = url.searchParams.get('sessionKey')?.trim() || undefined;
    const runId = url.searchParams.get('runId')?.trim() || undefined;
    sendJson(res, 200, { success: true, approvals: desktopRunCoordinator.approvals.listPending({ sessionKey, runId }) });
    return true;
  }

  if (url.pathname.startsWith('/api/computer/approvals/') && req.method === 'GET') {
    const id = decodeURIComponent(url.pathname.slice('/api/computer/approvals/'.length)).trim();
    const approval = id ? desktopRunCoordinator.approvals.get(id) : null;
    sendJson(res, approval ? 200 : 404, approval ? { success: true, approval } : { success: false, error: 'Approval not found' });
    return true;
  }

  if (url.pathname.startsWith('/api/computer/approvals/') && url.pathname.endsWith('/deny') && req.method === 'POST') {
    const encoded = url.pathname.slice('/api/computer/approvals/'.length, -'/deny'.length);
    const approval = desktopRunCoordinator.denyApproval(decodeURIComponent(encoded).trim());
    sendJson(res, approval ? 200 : 404, approval ? { success: true, approval } : { success: false, error: 'Approval not found' });
    return true;
  }

  if (url.pathname.startsWith('/api/computer/approvals/') && url.pathname.endsWith('/resolve') && req.method === 'POST') {
    sendJson(res, 403, {
      success: false,
      error: 'Desktop approvals must be resolved by the trusted Electron UI IPC bridge, not by an OpenClaw tool call.',
    });
    return true;
  }

  return false;
}
