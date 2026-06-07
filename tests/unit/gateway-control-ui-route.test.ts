import type { IncomingMessage, ServerResponse } from 'http';
import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostApiContext } from '@electron/api/context';
import { handleGatewayRoutes } from '@electron/api/routes/gateway';
import { scheduleControlUiDeviceAutoApproval } from '@electron/utils/control-ui-device-pairing';
import { CHAT_SEND_RPC_TIMEOUT_MS } from '../../shared/chat-timeouts';

vi.mock('@electron/utils/store', () => ({
  getSetting: vi.fn(async () => 'clawx-route-token'),
}));

vi.mock('@electron/utils/control-ui-device-pairing', () => ({
  scheduleControlUiDeviceAutoApproval: vi.fn(),
}));

function createResponse<T = { success: boolean; url: string; token: string; port: number }>() {
  const headers = new Map<string, string>();
  let body = '';
  const res = {
    statusCode: 0,
    setHeader: (name: string, value: string) => {
      headers.set(name, value);
    },
    end: (value: string) => {
      body = value;
    },
  } as unknown as ServerResponse;

  return {
    res,
    get json() {
      return JSON.parse(body) as T;
    },
    get statusCode() {
      return (res as ServerResponse).statusCode;
    },
    headers,
  };
}

function createJsonRequest(method: string, payload: unknown): IncomingMessage {
  const req = Readable.from([JSON.stringify(payload)]) as IncomingMessage;
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  return req;
}

function createContext(rpc: HostApiContext['gatewayManager']['rpc'] = vi.fn()): HostApiContext {
  return {
    gatewayManager: {
      getStatus: () => ({ port: 19001 }),
      rpc,
    },
    clawHubService: {},
    eventBus: {},
    mainWindow: null,
  } as unknown as HostApiContext;
}

describe('GET /api/gateway/control-ui', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the default Control UI URL', async () => {
    const response = createResponse();
    const handled = await handleGatewayRoutes(
      { method: 'GET' } as IncomingMessage,
      response.res,
      new URL('http://127.0.0.1/api/gateway/control-ui'),
      createContext(),
    );

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.json).toMatchObject({
      success: true,
      url: 'http://127.0.0.1:19001/#token=clawx-route-token',
      token: 'clawx-route-token',
      port: 19001,
    });
    expect(scheduleControlUiDeviceAutoApproval).toHaveBeenCalledOnce();
  });

  it('returns the Dreams Control UI URL', async () => {
    const response = createResponse();
    const handled = await handleGatewayRoutes(
      { method: 'GET' } as IncomingMessage,
      response.res,
      new URL('http://127.0.0.1/api/gateway/control-ui?view=dreams'),
      createContext(),
    );

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.json).toMatchObject({
      success: true,
      url: 'http://127.0.0.1:19001/dreaming#token=clawx-route-token',
      token: 'clawx-route-token',
      port: 19001,
    });
  });

  it('falls back to the default Control UI URL for unknown views', async () => {
    const response = createResponse();
    await handleGatewayRoutes(
      { method: 'GET' } as IncomingMessage,
      response.res,
      new URL('http://127.0.0.1/api/gateway/control-ui?view=unknown'),
      createContext(),
    );

    expect(response.json.url).toBe('http://127.0.0.1:19001/#token=clawx-route-token');
  });
});

describe('POST /api/chat/send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards chat.send with the long Gateway RPC timeout', async () => {
    const rpc = vi.fn().mockResolvedValue({ runId: 'run-route-text' });
    const response = createResponse<{ success: boolean; result: { runId: string } }>();
    const handled = await handleGatewayRoutes(
      createJsonRequest('POST', {
        sessionKey: 'agent:main:main',
        message: 'hello route',
        idempotencyKey: 'idem-route',
      }),
      response.res,
      new URL('http://127.0.0.1/api/chat/send'),
      createContext(rpc),
    );

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({ success: true, result: { runId: 'run-route-text' } });
    expect(rpc).toHaveBeenCalledWith(
      'chat.send',
      {
        sessionKey: 'agent:main:main',
        message: 'hello route',
        deliver: false,
        idempotencyKey: 'idem-route',
      },
      CHAT_SEND_RPC_TIMEOUT_MS,
    );
  });
});

describe('POST /api/chat/send-with-media', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards chat.send with the long Gateway RPC timeout', async () => {
    const rpc = vi.fn().mockResolvedValue({ runId: 'run-route-media' });
    const response = createResponse<{ success: boolean; result: { runId: string } }>();
    const handled = await handleGatewayRoutes(
      createJsonRequest('POST', {
        sessionKey: 'agent:main:main',
        message: 'read this',
        idempotencyKey: 'idem-media',
        media: [
          {
            filePath: 'C:\\tmp\\notes.txt',
            mimeType: 'text/plain',
            fileName: 'notes.txt',
          },
        ],
      }),
      response.res,
      new URL('http://127.0.0.1/api/chat/send-with-media'),
      createContext(rpc),
    );

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({ success: true, result: { runId: 'run-route-media' } });
    expect(rpc).toHaveBeenCalledWith(
      'chat.send',
      {
        sessionKey: 'agent:main:main',
        message: 'read this\n[media attached: C:\\tmp\\notes.txt (text/plain) | C:\\tmp\\notes.txt]',
        deliver: false,
        idempotencyKey: 'idem-media',
      },
      CHAT_SEND_RPC_TIMEOUT_MS,
    );
  });
});
