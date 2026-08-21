import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wsState = vi.hoisted(() => ({
  sockets: [] as unknown[],
  MockWebSocket: class MockWebSocket {
    static readonly OPEN = 1;
    readonly sentFrames: string[] = [];
    readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    readyState = 1;
    readonly close = vi.fn((code = 1000, reason = '') => {
      this.readyState = 3;
      queueMicrotask(() => {
        this.emit('close', code, Buffer.from(String(reason)));
      });
    });
    readonly terminate = vi.fn(() => {
      this.readyState = 3;
    });
    readonly send = vi.fn((payload: string) => {
      this.sentFrames.push(payload);
    });

    constructor(public readonly url: string) {
      wsState.sockets.push(this);
    }

    on(event: string, callback: (...args: unknown[]) => void): this {
      const current = this.listeners.get(event) ?? new Set();
      current.add(callback);
      this.listeners.set(event, current);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const callback of this.listeners.get(event) ?? []) {
        callback(...args);
      }
    }

    emitOpen(): void {
      this.emit('open');
    }

    emitJsonMessage(message: unknown): void {
      this.emit('message', Buffer.from(JSON.stringify(message)));
    }
  },
}));

type MockWebSocket = InstanceType<typeof wsState.MockWebSocket>;

vi.mock('ws', () => ({
  default: wsState.MockWebSocket,
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  GATEWAY_CONNECT_HANDSHAKE_TIMEOUT_MS,
  connectGatewaySocket,
  probeGatewayReady,
  waitForGatewayReady,
} from '@electron/gateway/ws-client';
import { logger } from '@electron/utils/logger';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function getLatestSocket(): MockWebSocket {
  const socket = wsState.sockets[wsState.sockets.length - 1];
  if (!socket) {
    throw new Error('Expected a mocked WebSocket instance');
  }
  return socket as MockWebSocket;
}

describe('connectGatewaySocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    wsState.sockets.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    wsState.sockets.length = 0;
  });

  it('keeps the handshake alive long enough for slower gateway restart responses', async () => {
    const pendingRequests = new Map();
    const onHandshakeComplete = vi.fn();

    const connectionPromise = connectGatewaySocket({
      port: 18789,
      deviceIdentity: null,
      platform: 'win32',
      pendingRequests,
      getToken: vi.fn().mockResolvedValue('token-123'),
      onHandshakeComplete,
      onMessage: (message) => {
        if (typeof message !== 'object' || message === null) return;
        const msg = message as { type?: string; id?: string; ok?: boolean; payload?: unknown; error?: unknown };
        if (msg.type !== 'res' || typeof msg.id !== 'string') return;
        const pending = pendingRequests.get(msg.id);
        if (!pending) return;
        if (msg.ok === false || msg.error) {
          pending.reject(new Error(String(msg.error ?? 'Gateway request failed')));
          return;
        }
        pending.resolve(msg.payload ?? msg);
      },
      onCloseAfterHandshake: vi.fn(),
    });

    const socket = getLatestSocket();
    socket.emitOpen();
    socket.emitJsonMessage({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'nonce-123' },
    });

    await flushMicrotasks();

    expect(socket.sentFrames).toHaveLength(1);
    const connectFrame = JSON.parse(socket.sentFrames[0]) as { id: string; method: string };
    expect(connectFrame.method).toBe('connect');
    expect((connectFrame as { params?: { minProtocol?: number; maxProtocol?: number } }).params).toMatchObject({
      minProtocol: 4,
      maxProtocol: 4,
    });
    expect(pendingRequests.size).toBe(1);

    await vi.advanceTimersByTimeAsync(GATEWAY_CONNECT_HANDSHAKE_TIMEOUT_MS - 1_000);
    expect(onHandshakeComplete).not.toHaveBeenCalled();

    socket.emitJsonMessage({
      type: 'res',
      id: connectFrame.id,
      ok: true,
      payload: { protocol: 3 },
    });

    await expect(connectionPromise).resolves.toBe(socket);
    expect(onHandshakeComplete).toHaveBeenCalledWith(socket);
    expect(pendingRequests.size).toBe(0);
  });

  it('still fails when the connect response exceeds the configured timeout', async () => {
    const pendingRequests = new Map();

    const connectionPromise = connectGatewaySocket({
      port: 18789,
      deviceIdentity: null,
      platform: 'win32',
      pendingRequests,
      getToken: vi.fn().mockResolvedValue('token-123'),
      onHandshakeComplete: vi.fn(),
      onMessage: vi.fn(),
      onCloseAfterHandshake: vi.fn(),
      connectTimeoutMs: 1_000,
    });
    const connectionErrorPromise = connectionPromise.then(
      () => null,
      (error) => error,
    );

    const socket = getLatestSocket();
    socket.emitOpen();
    socket.emitJsonMessage({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'nonce-123' },
    });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_001);

    const connectionError = await connectionErrorPromise;
    expect(connectionError).toBeInstanceOf(Error);
    expect((connectionError as Error).message).toBe('Connect handshake timeout');
    await flushMicrotasks();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(pendingRequests.size).toBe(0);
  });

  it('enforces the total handshake deadline while credentials are loading', async () => {
    const getToken = vi.fn(() => new Promise<string>(() => {}));
    const connectionPromise = connectGatewaySocket({
      port: 18789,
      deviceIdentity: null,
      platform: 'win32',
      pendingRequests: new Map(),
      getToken,
      onHandshakeComplete: vi.fn(),
      onMessage: vi.fn(),
      onCloseAfterHandshake: vi.fn(),
      handshakeTimeoutMs: 1_000,
    });
    const connectionErrorPromise = connectionPromise.then(() => null, (error) => error);
    const socket = getLatestSocket();

    socket.emitJsonMessage({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'nonce-123' },
    });
    await flushMicrotasks();
    expect(getToken).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(connectionErrorPromise).resolves.toMatchObject({
      message: 'Gateway handshake deadline exceeded',
    });
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects promptly when the socket closes while credentials are loading', async () => {
    let rejectToken: (error: Error) => void = () => {};
    const connectionPromise = connectGatewaySocket({
      port: 18789,
      deviceIdentity: null,
      platform: 'win32',
      pendingRequests: new Map(),
      getToken: () => new Promise<string>((_resolve, reject) => { rejectToken = reject; }),
      onHandshakeComplete: vi.fn(),
      onMessage: vi.fn(),
      onCloseAfterHandshake: vi.fn(),
      handshakeTimeoutMs: 10_000,
    });
    const connectionErrorPromise = connectionPromise.then(() => null, (error) => error);
    const socket = getLatestSocket();

    socket.emitJsonMessage({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'nonce-123' },
    });
    await flushMicrotasks();
    socket.emit('close', 1006, Buffer.from('closed'));
    await expect(connectionErrorPromise).resolves.toMatchObject({
      message: 'WebSocket closed before handshake (code=1006, reason=closed)',
    });

    rejectToken(new Error('credential storage unavailable'));
    await flushMicrotasks();
  });

  it('rejects without an unhandled rejection when credential loading fails', async () => {
    const connectionPromise = connectGatewaySocket({
      port: 18789,
      deviceIdentity: null,
      platform: 'win32',
      pendingRequests: new Map(),
      getToken: vi.fn().mockRejectedValue(new Error('credential storage unavailable')),
      onHandshakeComplete: vi.fn(),
      onMessage: vi.fn(),
      onCloseAfterHandshake: vi.fn(),
      handshakeTimeoutMs: 10_000,
    });
    const connectionErrorPromise = connectionPromise.then(() => null, (error) => error);
    const socket = getLatestSocket();

    socket.emitJsonMessage({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'nonce-123' },
    });

    await expect(connectionErrorPromise).resolves.toMatchObject({
      message: 'credential storage unavailable',
    });
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight handshake and clears its socket, request, and timers', async () => {
    const controller = new AbortController();
    const pendingRequests = new Map();
    const connectionPromise = connectGatewaySocket({
      port: 18789,
      deviceIdentity: null,
      platform: 'win32',
      pendingRequests,
      getToken: vi.fn().mockResolvedValue('token-123'),
      onHandshakeComplete: vi.fn(),
      onMessage: (message) => {
        if (typeof message !== 'object' || message === null) return;
        const msg = message as { type?: string; id?: string; ok?: boolean };
        if (msg.type !== 'res' || typeof msg.id !== 'string') return;
        const request = pendingRequests.get(msg.id);
        if (!request) return;
        if (msg.ok === false) request.reject(new Error('connect rejected'));
        else request.resolve(msg);
      },
      onCloseAfterHandshake: vi.fn(),
      handshakeTimeoutMs: 30_000,
      signal: controller.signal,
    });
    const connectionErrorPromise = connectionPromise.then(() => null, (error) => error);
    const socket = getLatestSocket();

    socket.emitJsonMessage({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'nonce-123' },
    });
    await flushMicrotasks();
    expect(pendingRequests.size).toBe(1);

    const abortReason = new Error('Gateway startup cancelled by stop');
    controller.abort(abortReason);

    await expect(connectionErrorPromise).resolves.toBe(abortReason);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(pendingRequests.size).toBe(0);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(vi.mocked(logger.error)).not.toHaveBeenCalledWith('Gateway connect handshake timed out');
    expect(vi.mocked(logger.error)).not.toHaveBeenCalledWith('Gateway handshake deadline exceeded');
  });

  it('terminates the pre-handshake socket when connect is rejected', async () => {
    const pendingRequests = new Map();

    const connectionPromise = connectGatewaySocket({
      port: 18789,
      deviceIdentity: null,
      platform: 'win32',
      pendingRequests,
      getToken: vi.fn().mockResolvedValue('token-123'),
      onHandshakeComplete: vi.fn(),
      onMessage: (message) => {
        if (typeof message !== 'object' || message === null) return;
        const msg = message as { type?: string; id?: string; ok?: boolean; error?: { message?: string } };
        if (msg.type !== 'res' || typeof msg.id !== 'string') return;
        const pending = pendingRequests.get(msg.id);
        if (!pending) return;
        pending.reject(new Error(msg.error?.message ?? 'Gateway request failed'));
      },
      onCloseAfterHandshake: vi.fn(),
    });
    const connectionErrorPromise = connectionPromise.then(
      () => null,
      (error) => error,
    );

    const socket = getLatestSocket();
    socket.emitOpen();
    socket.emitJsonMessage({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'nonce-123' },
    });

    await flushMicrotasks();

    const connectFrame = JSON.parse(socket.sentFrames[0]) as { id: string };
    socket.emitJsonMessage({
      type: 'res',
      id: connectFrame.id,
      ok: false,
      error: { message: 'gateway starting; retry shortly' },
    });

    const connectionError = await connectionErrorPromise;
    expect(connectionError).toBeInstanceOf(Error);
    expect((connectionError as Error).message).toBe('gateway starting; retry shortly');
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(pendingRequests.size).toBe(0);
  });
});

describe('probeGatewayReady', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    wsState.sockets.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    wsState.sockets.length = 0;
  });

  it('resolves true when connect.challenge message is received', async () => {
    const probePromise = probeGatewayReady(18789, 5000);
    const socket = getLatestSocket();

    socket.emitOpen();
    socket.emitJsonMessage({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'probe-nonce' },
    });

    await expect(probePromise).resolves.toBe(true);
    expect(socket.terminate).toHaveBeenCalled();
  });

  it('resolves false on WebSocket error', async () => {
    const probePromise = probeGatewayReady(18789, 5000);
    const socket = getLatestSocket();

    socket.emit('error', new Error('ECONNREFUSED'));

    await expect(probePromise).resolves.toBe(false);
    expect(socket.terminate).toHaveBeenCalled();
  });

  it('resolves false on timeout when no message is received', async () => {
    const probePromise = probeGatewayReady(18789, 2000);
    const socket = getLatestSocket();

    socket.emitOpen();
    // No message sent — just advance time past timeout
    await vi.advanceTimersByTimeAsync(2001);

    await expect(probePromise).resolves.toBe(false);
    expect(socket.terminate).toHaveBeenCalled();
  });

  it('resolves false when socket closes before challenge', async () => {
    const probePromise = probeGatewayReady(18789, 5000);
    const socket = getLatestSocket();

    socket.emitOpen();
    // Emit close directly (not through the mock's close() method)
    socket.emit('close', 1006, Buffer.from(''));

    await expect(probePromise).resolves.toBe(false);
    expect(socket.terminate).toHaveBeenCalled();
  });

  it('does NOT resolve true on plain open event (key behavioral change)', async () => {
    const probePromise = probeGatewayReady(18789, 500);
    const socket = getLatestSocket();

    // Only emit open — no connect.challenge message
    socket.emitOpen();

    // The old implementation would have resolved true here.
    // The new implementation waits for connect.challenge.
    await vi.advanceTimersByTimeAsync(501);

    await expect(probePromise).resolves.toBe(false);
  });

  it('uses terminate() instead of close() for cleanup to avoid Windows TIME_WAIT', async () => {
    const probePromise = probeGatewayReady(18789, 5000);
    const socket = getLatestSocket();

    socket.emitOpen();
    socket.emitJsonMessage({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'nonce-1' },
    });

    await expect(probePromise).resolves.toBe(true);

    // Must use terminate(), not close()
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('ignores non-challenge messages', async () => {
    const probePromise = probeGatewayReady(18789, 1000);
    const socket = getLatestSocket();

    socket.emitOpen();
    // Send a message that is NOT connect.challenge
    socket.emitJsonMessage({
      type: 'event',
      event: 'some.other.event',
      payload: {},
    });

    // Should still be waiting — not resolved yet
    await vi.advanceTimersByTimeAsync(1001);
    await expect(probePromise).resolves.toBe(false);
  });

  it('ignores malformed JSON messages', async () => {
    const probePromise = probeGatewayReady(18789, 1000);
    const socket = getLatestSocket();

    socket.emitOpen();
    // Send raw invalid JSON
    socket.emit('message', Buffer.from('not-json'));

    await vi.advanceTimersByTimeAsync(1001);
    await expect(probePromise).resolves.toBe(false);
  });
});

describe('waitForGatewayReady', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    wsState.sockets.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    wsState.sockets.length = 0;
  });

  it('uses a single cancellation check per probe and stops before opening a socket', async () => {
    const beforeProbe = vi.fn(() => {
      throw new Error('Gateway start superseded');
    });

    await expect(waitForGatewayReady({
      port: 18789,
      getProcessExitCode: () => null,
      beforeProbe,
      timeoutMs: 1_000,
    })).rejects.toThrow('Gateway start superseded');

    expect(beforeProbe).toHaveBeenCalledTimes(1);
    expect(wsState.sockets).toHaveLength(0);
  });

  it('reports retry_limit_exhausted separately from the deadline', async () => {
    const sensitiveProbeError = [
      'Z:\\private\\gateway\\openclaw.json',
      '\\\\fileserver\\private\\gateway.log',
      'ws://gateway.example.invalid/ws?token=secret-token-value',
      'Bearer secret-token-value',
    ].join(' ');
    const readyPromise = waitForGatewayReady({
      port: 18789,
      getProcessExitCode: () => null,
      retries: 2,
      intervalMs: 10,
      timeoutMs: 1_000,
      generation: 17,
    });
    const errorPromise = readyPromise.then(() => null, (error) => error);

    for (let index = 0; index < 2; index += 1) {
      getLatestSocket().emit('error', new Error(sensitiveProbeError));
      await vi.advanceTimersByTimeAsync(10);
    }

    await expect(errorPromise).resolves.toMatchObject({ code: 'retry_limit_exhausted' });
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Gateway readiness failed', {
      event: 'gateway_ready_failed',
      code: 'retry_limit_exhausted',
      attempts: 2,
      elapsedMs: 20,
      deadlineMs: 1_000,
      generation: 17,
    });

    const serializedLogs = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(serializedLogs).not.toContain('Z:\\\\private');
    expect(serializedLogs).not.toContain('fileserver');
    expect(serializedLogs).not.toContain('ws://');
    expect(serializedLogs).not.toContain('secret-token-value');
    expect(serializedLogs).not.toContain('Bearer');
  });

  it('truncates probe and sleep to the absolute ready deadline', async () => {
    const beforeProbe = vi.fn();
    const readyPromise = waitForGatewayReady({
      port: 18789,
      getProcessExitCode: () => null,
      intervalMs: 200,
      timeoutMs: 250,
      beforeProbe,
    });
    const errorPromise = readyPromise.then(() => null, (error) => error);

    const socket = getLatestSocket();
    await vi.advanceTimersByTimeAsync(251);
    await expect(errorPromise).resolves.toMatchObject({ code: 'ready_deadline_exceeded' });
    expect(beforeProbe).toHaveBeenCalledTimes(1);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Gateway readiness failed', {
      event: 'gateway_ready_failed',
      code: 'ready_deadline_exceeded',
      attempts: 1,
      elapsedMs: 250,
      deadlineMs: 250,
      generation: 0,
    });
  });
});
