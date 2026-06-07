import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import {
  checkJunFeiAIActivation,
  createJunFeiAITopupOrder,
  ensureJunFeiAIProviderSeeded,
  getJunFeiAITopupOrderStatus,
  getJunFeiAITopupOverview,
  listJunFeiAIModels,
  loginJunFeiAI,
  logoutJunFeiAI,
  registerJunFeiAI,
  sendJunFeiAIVerificationCode,
  storeJunFeiAIRelayToken,
  verifyJunFeiAIAuth,
} from '../../services/junfeiai/junfeiai-service';

export async function handleJunFeIAIRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/junfeiai/status' && req.method === 'GET') {
    sendJson(res, 200, await ensureJunFeiAIProviderSeeded({
      gatewayManager: ctx.gatewayManager,
      syncRuntime: false,
    }));
    return true;
  }

  if (url.pathname === '/api/junfeiai/bootstrap' && req.method === 'POST') {
    sendJson(res, 200, await ensureJunFeiAIProviderSeeded({
      gatewayManager: ctx.gatewayManager,
    }));
    return true;
  }

  if (url.pathname === '/api/junfeiai/activation/check' && req.method === 'POST') {
    sendJson(res, 200, await checkJunFeiAIActivation(await parseJsonBody<Record<string, unknown>>(req)));
    return true;
  }

  if (url.pathname === '/api/junfeiai/login' && req.method === 'POST') {
    sendJson(res, 200, await loginJunFeiAI(await parseJsonBody<Record<string, unknown>>(req), ctx.gatewayManager));
    return true;
  }

  if (url.pathname === '/api/junfeiai/register' && req.method === 'POST') {
    sendJson(res, 200, await registerJunFeiAI(await parseJsonBody<Record<string, unknown>>(req), ctx.gatewayManager));
    return true;
  }

  if (url.pathname === '/api/junfeiai/verification/send-code' && req.method === 'POST') {
    sendJson(res, 200, await sendJunFeiAIVerificationCode(await parseJsonBody<Record<string, unknown>>(req)));
    return true;
  }

  if (url.pathname === '/api/junfeiai/auth/verify' && req.method === 'POST') {
    sendJson(res, 200, await verifyJunFeiAIAuth(await parseJsonBody<Record<string, unknown>>(req)));
    return true;
  }

  if (url.pathname === '/api/junfeiai/topup/overview' && req.method === 'GET') {
    sendJson(res, 200, await getJunFeiAITopupOverview());
    return true;
  }

  if (url.pathname === '/api/junfeiai/topup/order' && req.method === 'POST') {
    sendJson(res, 200, await createJunFeiAITopupOrder(await parseJsonBody<Record<string, unknown>>(req)));
    return true;
  }

  if (url.pathname === '/api/junfeiai/topup/order/status' && req.method === 'GET') {
    sendJson(res, 200, await getJunFeiAITopupOrderStatus({
      tradeNo: url.searchParams.get('tradeNo') ?? url.searchParams.get('trade_no') ?? '',
      sync: url.searchParams.get('sync') ?? false,
    }));
    return true;
  }

  if (url.pathname === '/api/junfeiai/models' && req.method === 'GET') {
    sendJson(res, 200, await listJunFeiAIModels());
    return true;
  }

  if (url.pathname === '/api/junfeiai/relay-token' && req.method === 'POST') {
    const body = await parseJsonBody<{ token?: string; bootstrap?: Record<string, unknown> }>(req);
    if (!body.token?.trim()) {
      sendJson(res, 400, { success: false, error: 'relay token is required' });
      return true;
    }
    sendJson(res, 200, {
      success: true,
      account: await storeJunFeiAIRelayToken(body.token, body.bootstrap ?? {}, ctx.gatewayManager),
    });
    return true;
  }

  if (url.pathname === '/api/junfeiai/logout' && req.method === 'POST') {
    await logoutJunFeiAI();
    sendJson(res, 200, { success: true });
    return true;
  }

  return false;
}
