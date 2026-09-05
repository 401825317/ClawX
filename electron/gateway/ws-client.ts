import WebSocket from 'ws';
import type { DeviceIdentity } from '../utils/device-identity';
import type { PendingGatewayRequest } from './request-store';
import {
  buildDeviceAuthPayload,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from '../utils/device-identity';
import { logger } from '../utils/logger';
import {
  isGatewayWsTraceEnabled,
  redactGatewayFrameForTrace,
  summarizeGatewayFrameForTrace,
} from './ws-trace';

export const GATEWAY_CHALLENGE_TIMEOUT_MS = 10_000;
export const GATEWAY_CONNECT_HANDSHAKE_TIMEOUT_MS = 20_000;
export const GATEWAY_READY_TIMEOUT_MS = 120_000;
const GATEWAY_READY_PROBE_TIMEOUT_MS = 1_500;

export type GatewayReadyFailureCode = 'retry_limit_exhausted' | 'ready_deadline_exceeded';

export class GatewayReadyError extends Error {
  readonly code: GatewayReadyFailureCode;

  constructor(options: {
    code: GatewayReadyFailureCode;
    port: number;
    attempts: number;
    timeoutMs: number;
  }) {
    super(
      options.code === 'retry_limit_exhausted'
        ? `Gateway failed to become ready: retry_limit_exhausted after ${options.attempts} attempt(s) (port ${options.port})`
        : `Gateway failed to become ready: ready_deadline_exceeded after ${options.timeoutMs}ms (port ${options.port})`,
    );
    this.name = 'GatewayReadyError';
    this.code = options.code;
  }
}

export async function probeGatewayReady(
  port: number,
  timeoutMs = 1500,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const testWs = new WebSocket(`ws://localhost:${port}/ws`);
    let settled = false;

    const resolveOnce = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        // Use terminate() (TCP RST) instead of close() (WS close handshake)
        // to avoid leaving TIME_WAIT connections on Windows. These probe
        // WebSockets are short-lived and don't need a graceful close.
        testWs.terminate();
      } catch {
        // ignore
      }
      resolve(value);
    };

    const timeout = setTimeout(() => {
      resolveOnce(false);
    }, timeoutMs);

    testWs.on('open', () => {
      // Do not resolve on plain socket open. The gateway can accept the TCP/WebSocket
      // connection before it is ready to issue protocol challenges, which previously
      // caused a false "ready" result and then a full connect() stall.
    });

    testWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as { type?: string; event?: string };
        if (message.type === 'event' && message.event === 'connect.challenge') {
          resolveOnce(true);
        }
      } catch {
        // ignore malformed probe payloads
      }
    });

    testWs.on('error', () => {
      resolveOnce(false);
    });

    testWs.on('close', () => {
      resolveOnce(false);
    });
  });
}

export async function waitForGatewayReady(options: {
  port: number;
  getProcessExitCode: () => number | null;
  retries?: number;
  intervalMs?: number;
  timeoutMs?: number;
  generation?: number;
  beforeProbe?: () => void;
}): Promise<void> {
  const retries = options.retries ?? Number.POSITIVE_INFINITY;
  const intervalMs = options.intervalMs ?? 200;
  const timeoutMs = options.timeoutMs ?? GATEWAY_READY_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadlineAt = startedAt + timeoutMs;
  let attempts = 0;

  while (attempts < retries) {
    const remainingBeforeProbeMs = deadlineAt - Date.now();
    if (remainingBeforeProbeMs <= 0) {
      break;
    }

    // This is intentionally the only lifecycle/cancellation check in an
    // iteration. A superseded lifecycle throws here before touching the socket.
    options.beforeProbe?.();
    const exitCode = options.getProcessExitCode();
    if (exitCode !== null) {
      logger.error(`Gateway process exited before ready (code=${exitCode})`);
      throw new Error(`Gateway process exited before becoming ready (code=${exitCode})`);
    }

    attempts += 1;
    try {
      const ready = await probeGatewayReady(
        options.port,
        Math.min(GATEWAY_READY_PROBE_TIMEOUT_MS, remainingBeforeProbeMs),
      );
      if (ready && Date.now() <= deadlineAt) {
        logger.debug(`Gateway ready after ${attempts} attempt(s)`);
        return;
      }
    } catch {
      // Gateway not ready yet.
    }

    if (attempts > 1 && attempts % 10 === 0) {
      logger.debug(`Still waiting for Gateway... (attempt ${attempts}/${retries})`);
    }

    const remainingBeforeSleepMs = deadlineAt - Date.now();
    if (remainingBeforeSleepMs <= 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingBeforeSleepMs)));
  }

  const elapsedMs = Date.now() - startedAt;
  const code: GatewayReadyFailureCode = attempts >= retries
    ? 'retry_limit_exhausted'
    : 'ready_deadline_exceeded';
  const generation = Number.isSafeInteger(options.generation) && (options.generation ?? 0) >= 0
    ? options.generation ?? 0
    : 0;
  logger.error('Gateway readiness failed', {
    event: 'gateway_ready_failed',
    code,
    attempts,
    elapsedMs,
    deadlineMs: timeoutMs,
    generation,
  });
  throw new GatewayReadyError({ code, port: options.port, attempts, timeoutMs });
}

const GATEWAY_PROTOCOL_VERSION = 4;

export function buildGatewayConnectFrame(options: {
  challengeNonce: string;
  token: string;
  deviceIdentity: DeviceIdentity | null;
  platform: string;
}): { connectId: string; frame: Record<string, unknown> } {
  const connectId = `connect-${Date.now()}`;
  const role = 'operator';
  const scopes = ['operator.admin'];
  const signedAtMs = Date.now();
  const clientId = 'gateway-client';
  const clientMode = 'ui';

  const device = (() => {
    if (!options.deviceIdentity) return undefined;

    const payload = buildDeviceAuthPayload({
      deviceId: options.deviceIdentity.deviceId,
      clientId,
      clientMode,
      role,
      scopes,
      signedAtMs,
      token: options.token ?? null,
      nonce: options.challengeNonce,
    });
    const signature = signDevicePayload(options.deviceIdentity.privateKeyPem, payload);
    return {
      id: options.deviceIdentity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(options.deviceIdentity.publicKeyPem),
      signature,
      signedAt: signedAtMs,
      nonce: options.challengeNonce,
    };
  })();

  return {
    connectId,
    frame: {
      type: 'req',
      id: connectId,
      method: 'connect',
      params: {
        minProtocol: GATEWAY_PROTOCOL_VERSION,
        maxProtocol: GATEWAY_PROTOCOL_VERSION,
        client: {
          id: clientId,
          displayName: 'UClaw',
          version: '0.1.0',
          platform: options.platform,
          mode: clientMode,
        },
        auth: {
          token: options.token,
        },
        caps: ['tool-events'],
        role,
        scopes,
        device,
      },
    },
  };
}

export async function connectGatewaySocket(options: {
  port: number;
  deviceIdentity: DeviceIdentity | null;
  platform: string;
  pendingRequests: Map<string, PendingGatewayRequest>;
  getToken: () => Promise<string>;
  onHandshakeComplete: (ws: WebSocket) => void;
  onMessage: (message: unknown) => void;
  onCloseAfterHandshake: (code: number) => void;
  challengeTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Total deadline from WebSocket creation through connect RPC completion. */
  handshakeTimeoutMs?: number;
  /** Cancels an in-flight startup handshake when its lifecycle is superseded. */
  signal?: AbortSignal;
}): Promise<WebSocket> {
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error('Gateway WebSocket connection aborted');
  }
  logger.debug(`Connecting Gateway WebSocket (ws://localhost:${options.port}/ws)`);
  const challengeTimeoutMs = options.challengeTimeoutMs ?? GATEWAY_CHALLENGE_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? GATEWAY_CONNECT_HANDSHAKE_TIMEOUT_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? challengeTimeoutMs + connectTimeoutMs;

  return await new Promise<WebSocket>((resolve, reject) => {
    const wsUrl = `ws://localhost:${options.port}/ws`;
    const handshakeStartedAt = Date.now();
    const ws = new WebSocket(wsUrl);
    const handshakeDeadlineAt = handshakeStartedAt + handshakeTimeoutMs;
    let handshakeComplete = false;
    let connectId: string | null = null;
    let handshakeTimeout: NodeJS.Timeout | null = null;
    let challengeTimer: NodeJS.Timeout | null = null;
    let overallHandshakeTimer: NodeJS.Timeout | null = null;
    let challengeReceived = false;
    let settled = false;
    let abortHandler: (() => void) | null = null;

    const cleanupHandshakeRequest = () => {
      if (challengeTimer) {
        clearTimeout(challengeTimer);
        challengeTimer = null;
      }
      if (handshakeTimeout) {
        clearTimeout(handshakeTimeout);
        handshakeTimeout = null;
      }
      if (overallHandshakeTimer) {
        clearTimeout(overallHandshakeTimer);
        overallHandshakeTimer = null;
      }
      if (abortHandler && options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
        abortHandler = null;
      }
      if (connectId && options.pendingRequests.has(connectId)) {
        const request = options.pendingRequests.get(connectId);
        if (request) {
          clearTimeout(request.timeout);
        }
        options.pendingRequests.delete(connectId);
      }
    };

    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      cleanupHandshakeRequest();
      resolve(ws);
    };

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanupHandshakeRequest();
      if (!handshakeComplete) {
        try {
          ws.terminate();
        } catch {
          // ignore cleanup errors during failed startup handshakes
        }
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const sendConnectHandshake = async (challengeNonce: string) => {
      logger.debug('Sending connect handshake with challenge nonce');

      const currentToken = await options.getToken();
      if (settled) return;
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error('Gateway WebSocket closed while loading handshake credentials');
      }
      const remainingHandshakeMs = handshakeDeadlineAt - Date.now();
      if (remainingHandshakeMs <= 0) {
        throw new Error('Gateway handshake deadline exceeded');
      }
      const connectPayload = buildGatewayConnectFrame({
        challengeNonce,
        token: currentToken,
        deviceIdentity: options.deviceIdentity,
        platform: options.platform,
      });
      connectId = connectPayload.connectId;

      if (isGatewayWsTraceEnabled()) {
        logger.debug('[gateway-ws-trace] send', {
          summary: summarizeGatewayFrameForTrace(connectPayload.frame),
          frame: redactGatewayFrameForTrace(connectPayload.frame),
        });
      }
      ws.send(JSON.stringify(connectPayload.frame));
      if (settled) return;

      const requestTimeout = setTimeout(() => {
        if (!handshakeComplete) {
          logger.error('Gateway connect handshake timed out');
          ws.close();
          rejectOnce(new Error('Connect handshake timeout'));
        }
      }, Math.min(connectTimeoutMs, remainingHandshakeMs));
      handshakeTimeout = requestTimeout;

      options.pendingRequests.set(connectId, {
        resolve: () => {
          handshakeComplete = true;
          logger.debug('Gateway connect handshake completed');
          options.onHandshakeComplete(ws);
          resolveOnce();
        },
        reject: (error) => {
          logger.error('Gateway connect handshake failed:', error);
          rejectOnce(error);
        },
        timeout: requestTimeout,
      });
    };

    overallHandshakeTimer = setTimeout(() => {
      if (!settled) {
        logger.error('Gateway handshake deadline exceeded');
        rejectOnce(new Error('Gateway handshake deadline exceeded'));
      }
    }, Math.max(0, handshakeDeadlineAt - Date.now()));

    challengeTimer = setTimeout(() => {
      if (!challengeReceived && !settled) {
        logger.error('Gateway connect.challenge not received within timeout');
        ws.close();
        rejectOnce(new Error('Timed out waiting for connect.challenge from Gateway'));
      }
    }, challengeTimeoutMs);

    ws.on('open', () => {
      logger.debug('Gateway WebSocket opened, waiting for connect.challenge...');
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (isGatewayWsTraceEnabled()) {
          logger.debug('[gateway-ws-trace] recv', {
            summary: summarizeGatewayFrameForTrace(message),
            frame: redactGatewayFrameForTrace(message),
          });
        }
        if (
          !challengeReceived &&
          typeof message === 'object' && message !== null &&
          message.type === 'event' && message.event === 'connect.challenge'
        ) {
          challengeReceived = true;
          if (challengeTimer) {
            clearTimeout(challengeTimer);
            challengeTimer = null;
          }
          const nonce = message.payload?.nonce as string | undefined;
          if (!nonce) {
            rejectOnce(new Error('Gateway connect.challenge missing nonce'));
            return;
          }
          logger.debug('Received connect.challenge, sending handshake');
          void sendConnectHandshake(nonce).catch((error) => {
            logger.error('Gateway connect handshake preparation failed:', error);
            rejectOnce(error);
          });
          return;
        }

        options.onMessage(message);
      } catch (error) {
        logger.debug('Failed to parse Gateway WebSocket message:', error);
      }
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || 'unknown';
      logger.warn(`Gateway WebSocket closed (code=${code}, reason=${reasonStr}, handshake=${handshakeComplete ? 'ok' : 'pending'})`);
      if (!handshakeComplete) {
        rejectOnce(new Error(`WebSocket closed before handshake (code=${code}, reason=${reasonStr})`));
        return;
      }
      cleanupHandshakeRequest();
      options.onCloseAfterHandshake(code);
    });

    ws.on('error', (error) => {
      if (error.message?.includes('closed before handshake') || (error as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        logger.debug(`Gateway WebSocket connection error (transient): ${error.message}`);
      } else {
        logger.error('Gateway WebSocket error:', error);
      }
      if (!handshakeComplete) {
        rejectOnce(error);
      }
    });

    if (options.signal) {
      abortHandler = () => {
        rejectOnce(options.signal?.reason ?? new Error('Gateway WebSocket connection aborted'));
      };
      options.signal.addEventListener('abort', abortHandler, { once: true });
      if (options.signal.aborted) {
        abortHandler();
      }
    }
  });
}
