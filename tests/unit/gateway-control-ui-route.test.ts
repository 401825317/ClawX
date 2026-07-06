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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitForHandlers(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  it('serializes concurrent chat.send RPCs for the same session', async () => {
    const first = deferred<{ runId: string }>();
    const rpc = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ runId: 'run-route-second' });
    const firstResponse = createResponse<{ success: boolean; result: { runId: string } }>();
    const secondResponse = createResponse<{ success: boolean; result: { runId: string } }>();

    const firstRequest = handleGatewayRoutes(
      createJsonRequest('POST', {
        sessionKey: 'agent:main:main',
        message: 'first',
        idempotencyKey: 'idem-first',
      }),
      firstResponse.res,
      new URL('http://127.0.0.1/api/chat/send'),
      createContext(rpc),
    );
    const secondRequest = handleGatewayRoutes(
      createJsonRequest('POST', {
        sessionKey: 'agent:main:main',
        message: 'second',
        idempotencyKey: 'idem-second',
      }),
      secondResponse.res,
      new URL('http://127.0.0.1/api/chat/send'),
      createContext(rpc),
    );

    await waitForHandlers();
    expect(rpc).toHaveBeenCalledTimes(1);

    first.resolve({ runId: 'run-route-first' });
    await Promise.all([firstRequest, secondRequest]);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(firstResponse.json).toEqual({ success: true, result: { runId: 'run-route-first' } });
    expect(secondResponse.json).toEqual({ success: true, result: { runId: 'run-route-second' } });
    expect(rpc.mock.calls[1]).toEqual([
      'chat.send',
      {
        sessionKey: 'agent:main:main',
        message: 'second',
        deliver: false,
        idempotencyKey: 'idem-second',
      },
      CHAT_SEND_RPC_TIMEOUT_MS,
    ]);
  });

  it('reuses an in-flight chat.send with the same idempotency key', async () => {
    const first = deferred<{ runId: string }>();
    const rpc = vi.fn().mockReturnValue(first.promise);
    const firstResponse = createResponse<{ success: boolean; result: { runId: string } }>();
    const secondResponse = createResponse<{ success: boolean; result: { runId: string } }>();

    const firstRequest = handleGatewayRoutes(
      createJsonRequest('POST', {
        sessionKey: 'agent:main:main',
        message: 'hello',
        idempotencyKey: 'idem-repeat',
      }),
      firstResponse.res,
      new URL('http://127.0.0.1/api/chat/send'),
      createContext(rpc),
    );
    const secondRequest = handleGatewayRoutes(
      createJsonRequest('POST', {
        sessionKey: 'agent:main:main',
        message: 'hello',
        idempotencyKey: 'idem-repeat',
      }),
      secondResponse.res,
      new URL('http://127.0.0.1/api/chat/send'),
      createContext(rpc),
    );

    await waitForHandlers();
    expect(rpc).toHaveBeenCalledTimes(1);

    first.resolve({ runId: 'run-route-repeat' });
    await Promise.all([firstRequest, secondRequest]);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(firstResponse.json).toEqual({ success: true, result: { runId: 'run-route-repeat' } });
    expect(secondResponse.json).toEqual({ success: true, result: { runId: 'run-route-repeat' } });
  });

  it('waits for in-flight chat.abort before forwarding the next chat.send for the same session', async () => {
    const abort = deferred<Record<string, unknown>>();
    const rpc = vi.fn((method: string) => {
      if (method === 'chat.abort') {
        return abort.promise;
      }
      return Promise.resolve({ runId: 'run-route-after-abort' });
    });
    const abortResponse = createResponse<{ success: boolean; result: Record<string, unknown> }>();
    const sendResponse = createResponse<{ success: boolean; result: { runId: string } }>();

    const abortRequest = handleGatewayRoutes(
      createJsonRequest('POST', { sessionKey: 'agent:main:main' }),
      abortResponse.res,
      new URL('http://127.0.0.1/api/chat/abort'),
      createContext(rpc),
    );
    await waitForHandlers();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]?.[0]).toBe('chat.abort');

    const sendRequest = handleGatewayRoutes(
      createJsonRequest('POST', {
        sessionKey: 'agent:main:main',
        message: 'next',
        idempotencyKey: 'idem-after-abort',
      }),
      sendResponse.res,
      new URL('http://127.0.0.1/api/chat/send'),
      createContext(rpc),
    );
    await waitForHandlers();
    expect(rpc).toHaveBeenCalledTimes(1);

    abort.resolve({ aborted: true });
    await abortRequest;
    await sleep(800);
    await sendRequest;

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]?.[0]).toBe('chat.send');
    expect(sendResponse.json).toEqual({ success: true, result: { runId: 'run-route-after-abort' } });
  });

  it('does not wait for a superseded chat.send after chat.abort starts', async () => {
    const firstSend = deferred<{ runId: string }>();
    const rpc = vi.fn((method: string, params?: unknown) => {
      const record = params as Record<string, unknown> | undefined;
      if (method === 'chat.send' && record?.message === 'first') {
        return firstSend.promise;
      }
      if (method === 'chat.abort') {
        return Promise.resolve({ aborted: true });
      }
      return Promise.resolve({ runId: 'run-route-after-abort' });
    });
    const firstResponse = createResponse<{ success: boolean; result: { runId: string } }>();
    const abortResponse = createResponse<{ success: boolean; result: Record<string, unknown> }>();
    const secondResponse = createResponse<{ success: boolean; result: { runId: string } }>();

    void handleGatewayRoutes(
      createJsonRequest('POST', {
        sessionKey: 'agent:main:main',
        message: 'first',
        idempotencyKey: 'idem-first',
      }),
      firstResponse.res,
      new URL('http://127.0.0.1/api/chat/send'),
      createContext(rpc),
    );
    await waitForHandlers();
    expect(rpc).toHaveBeenCalledTimes(1);

    await handleGatewayRoutes(
      createJsonRequest('POST', { sessionKey: 'agent:main:main' }),
      abortResponse.res,
      new URL('http://127.0.0.1/api/chat/abort'),
      createContext(rpc),
    );

    const secondRequest = handleGatewayRoutes(
      createJsonRequest('POST', {
        sessionKey: 'agent:main:main',
        message: 'next',
        idempotencyKey: 'idem-next',
      }),
      secondResponse.res,
      new URL('http://127.0.0.1/api/chat/send'),
      createContext(rpc),
    );
    await sleep(800);
    await secondRequest;

    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[2]?.[0]).toBe('chat.send');
    expect(secondResponse.json).toEqual({ success: true, result: { runId: 'run-route-after-abort' } });
  });

  it('retries transient reply session initialization conflicts before responding', async () => {
    const rpc = vi.fn()
      .mockRejectedValueOnce(new Error('reply session initialization conflicted for agent:main:main'))
      .mockResolvedValueOnce({ runId: 'run-route-retry-ok' });
    const response = createResponse<{ success: boolean; result: { runId: string } }>();

    const handled = await handleGatewayRoutes(
      createJsonRequest('POST', {
        sessionKey: 'agent:main:main',
        message: 'next',
        idempotencyKey: 'idem-conflict-retry',
      }),
      response.res,
      new URL('http://127.0.0.1/api/chat/send'),
      createContext(rpc),
    );

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({ success: true, result: { runId: 'run-route-retry-ok' } });
    expect(rpc).toHaveBeenCalledTimes(2);
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
