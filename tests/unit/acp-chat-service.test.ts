import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_EVENT_CHANNELS } from '@shared/host-events/contract';
import { UCLAW_VIDEO_GENERATION_MAX_INPUT_IMAGE_BYTES } from '@shared/junfeiai-endpoints';

const acpSdkMock = vi.hoisted(() => {
  const state = { connectionForSpawn: undefined as unknown };
  return {
    state,
    ClientSideConnection: vi.fn(function () {
      return state.connectionForSpawn;
    }),
    ndJsonStream: vi.fn(() => ({})),
  };
});

const childProcessMock = vi.hoisted(() => {
  const state = { child: undefined as unknown };
  return {
    state,
    spawn: vi.fn(() => state.child),
    fork: vi.fn(() => state.child),
  };
});

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@electron/utils/logger', () => ({
  logger: loggerMock,
}));

vi.mock('@electron/utils/control-ui-device-pairing', () => ({
  approvePendingLocalDeviceRequests: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@agentclientprotocol/sdk', () => ({
  ClientSideConnection: acpSdkMock.ClientSideConnection,
  ndJsonStream: acpSdkMock.ndJsonStream,
  PROTOCOL_VERSION: 1,
}));

vi.mock('node:child_process', () => ({
  default: { spawn: childProcessMock.spawn, fork: childProcessMock.fork },
  spawn: childProcessMock.spawn,
  fork: childProcessMock.fork,
}));

function createConnection() {
  return {
    initialize: vi.fn().mockResolvedValue({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
    newSession: vi.fn().mockResolvedValue({ sessionId: 'acp-session-1' }),
    loadSession: vi.fn().mockResolvedValue({}),
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
}

function createPassthroughAccessRegistry() {
  let activeGrant: {
    sessionKey: string;
    generation: number;
    workspaceRoot: string;
    executionCwd: string;
  } | null = null;
  return {
    prepareGrant: vi.fn(async (input) => ({ ...input })),
    snapshot: vi.fn(() => activeGrant ? { ...activeGrant } : null),
    commitGrant: vi.fn((context) => { activeGrant = { ...context }; }),
    restore: vi.fn((snapshot) => { activeGrant = snapshot ? { ...snapshot } : null; }),
    get: vi.fn((sessionKey, generation) => (
      activeGrant?.sessionKey === sessionKey && activeGrant.generation === generation
        ? { ...activeGrant }
        : null
    )),
  };
}

async function createService(
  connection = createConnection(),
  accessRegistry = createPassthroughAccessRegistry(),
  turnImagePreferenceStore?: {
    enqueue: ReturnType<typeof vi.fn>;
    discard: ReturnType<typeof vi.fn>;
  },
  turnVideoPreferenceStore?: {
    enqueue: ReturnType<typeof vi.fn>;
    discard: ReturnType<typeof vi.fn>;
  },
) {
  const send = vi.fn();
  const { AcpChatService } = await import('../../electron/services/acp-chat-service');
  const service = new AcpChatService(
    { webContents: { send } } as never,
    accessRegistry as never,
    connection as never,
    undefined,
    turnImagePreferenceStore as never,
    turnVideoPreferenceStore as never,
  );
  return { service, connection, send, accessRegistry };
}

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

async function createSpawnedService(
  connection = createConnection(),
  gateway?: { getStatus: () => { port?: number }; getGatewayToken?: () => Promise<string> },
) {
  const send = vi.fn();
  const child = createFakeChild();
  acpSdkMock.state.connectionForSpawn = connection;
  childProcessMock.state.child = child;
  const { AcpChatService } = await import('../../electron/services/acp-chat-service');
  const service = new AcpChatService(
    { webContents: { send } } as never,
    createPassthroughAccessRegistry() as never,
    undefined,
    gateway as never,
  );
  return { service, connection, send, child };
}

async function expectCancelledSoon(promise: Promise<unknown>) {
  await expect(Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 25)),
  ])).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
}

function createInitResponse() {
  return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe('AcpChatService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acpSdkMock.state.connectionForSpawn = undefined;
    childProcessMock.state.child = undefined;
  });

  it('forks the embedded OpenClaw entry for ACP instead of spawning a public CLI wrapper', async () => {
    const { service } = await createSpawnedService();

    await expect(service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' })).resolves.toEqual({
      success: true,
      generation: 1,
    });

    expect(childProcessMock.spawn).not.toHaveBeenCalled();
    expect(childProcessMock.fork).toHaveBeenCalledWith(
      expect.stringContaining('openclaw.mjs'),
      ['acp'],
      expect.objectContaining({
        cwd: expect.stringContaining('openclaw'),
        execArgv: [],
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
        env: expect.objectContaining({
          OPENCLAW_NO_RESPAWN: '1',
          OPENCLAW_EMBEDDED_IN: 'ClawX',
          OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
        }),
      }),
    );
  });

  it('routes ACP through the active isolated Gateway port', async () => {
    const gateway = {
      getStatus: vi.fn(() => ({
        state: 'running' as const,
        gatewayReady: true,
        port: 60792,
        pid: 42,
        connectedAt: 1_786_545_000_000,
      })),
      getGatewayToken: vi.fn().mockResolvedValue('test-gateway-token'),
    };
    const { service } = await createSpawnedService(createConnection(), gateway);

    await expect(service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' })).resolves.toEqual({
      success: true,
      generation: 1,
    });

    expect(childProcessMock.fork).toHaveBeenCalledWith(
      expect.stringContaining('openclaw.mjs'),
      ['acp'],
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:60792',
          OPENCLAW_GATEWAY_TOKEN: 'test-gateway-token',
        }),
      }),
    );
  });

  it('waits for a restarting Gateway to become ready before spawning ACP', async () => {
    vi.useFakeTimers();
    const gateway = {
      getStatus: vi.fn()
        .mockReturnValueOnce({ port: 60792, state: 'starting', gatewayReady: false })
        .mockReturnValueOnce({ port: 60792, state: 'running', gatewayReady: true })
        .mockReturnValue({ port: 60792, state: 'running', gatewayReady: true }),
      getGatewayToken: vi.fn().mockResolvedValue('test-gateway-token'),
    };
    const { service } = await createSpawnedService(createConnection(), gateway);

    try {
      const load = service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
      expect(childProcessMock.fork).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      await expect(load).resolves.toMatchObject({ success: true, generation: 1 });
      expect(gateway.getStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(childProcessMock.fork).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an in-flight session load when the Gateway runtime identity changes', async () => {
    const status = {
      state: 'running' as const, gatewayReady: true, port: 60792, pid: 42, connectedAt: 100,
    };
    const gateway = {
      getStatus: vi.fn(() => ({ ...status })),
      getGatewayToken: vi.fn().mockResolvedValue('test-gateway-token'),
    };
    const connection = createConnection();
    const pendingLoad = createDeferred<unknown>();
    connection.loadSession.mockReturnValueOnce(pendingLoad.promise);
    const { service } = await createSpawnedService(connection, gateway);

    const load = service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await vi.waitFor(() => expect(connection.loadSession).toHaveBeenCalledTimes(1));
    status.pid = 43;
    status.connectedAt = 200;
    pendingLoad.resolve({});

    await expect(load).resolves.toMatchObject({
      success: false, errorCode: 'GATEWAY_UNAVAILABLE', retryable: true,
    });
  });

  it('does not retry a prompt when the Gateway runtime changes during submission', async () => {
    const status = {
      state: 'running' as const, gatewayReady: true, port: 60792, pid: 42, connectedAt: 100,
    };
    const gateway = {
      getStatus: vi.fn(() => ({ ...status })),
      getGatewayToken: vi.fn().mockResolvedValue('test-gateway-token'),
    };
    const connection = createConnection();
    const pendingPrompt = createDeferred<unknown>();
    connection.prompt.mockReturnValueOnce(pendingPrompt.promise);
    const { service } = await createSpawnedService(connection, gateway);
    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    const prompt = service.sendPrompt({ sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'hello' });
    await vi.waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(1));
    status.connectedAt = 200;
    pendingPrompt.resolve({});

    await expect(prompt).resolves.toMatchObject({
      success: false, errorCode: 'GATEWAY_UNAVAILABLE', retryable: true,
    });
    expect(connection.prompt).toHaveBeenCalledTimes(1);
  });

  it('warms the ACP connection once and reuses it for the first session load', async () => {
    const { service, connection } = await createSpawnedService();

    await expect(service.warmupConnection()).resolves.toBeUndefined();

    expect(connection.initialize).toHaveBeenCalledTimes(1);
    expect(connection.loadSession).not.toHaveBeenCalled();
    expect(connection.newSession).not.toHaveBeenCalled();

    await expect(service.loadSession({
      sessionKey: 'agent:pi:s1',
      workspaceRoot: '/repo',
      cwd: '/repo',
    })).resolves.toEqual({ success: true, generation: 1 });

    expect(connection.initialize).toHaveBeenCalledTimes(1);
    expect(childProcessMock.fork).toHaveBeenCalledTimes(1);
    expect(connection.loadSession).toHaveBeenCalledTimes(1);
  });

  it('filters non-JSON stdout diagnostics before the ACP SDK parser sees them', async () => {
    const { service, child } = await createSpawnedService();

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    const output = acpSdkMock.ndJsonStream.mock.calls[0]?.[1] as ReadableStream<Uint8Array>;
    const reader = output.getReader();
    const nextChunk = reader.read();
    child.stdout.write('│ startup doctor note\n{"jsonrpc":"2.0","id":1,"result":{}}\n');

    const { done, value } = await nextChunk;
    reader.releaseLock();

    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect(loggerMock.info).toHaveBeenCalledWith('[acp-chat] [stdout] │ startup doctor note');
  });

  it('loads historical sessions without explicit routing metadata so replay can resolve by session key', async () => {
    const { service, connection } = await createService();

    await expect(service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' })).resolves.toEqual({
      success: true,
      generation: 1,
    });

    expect(connection.initialize).toHaveBeenCalledWith({
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(connection.loadSession).toHaveBeenCalledWith({
      sessionId: 'agent:pi:s1',
      cwd: '/repo',
      mcpServers: [],
    });
    expect(connection.newSession).not.toHaveBeenCalled();
  });

  it('creates fresh generated sessions with ACP session/new so replay ledgers are complete', async () => {
    const { service, connection } = await createService();

    await expect(service.loadSession({ sessionKey: 'agent:pi:session-123', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true })).resolves.toEqual({
      success: true,
      generation: 1,
    });

    expect(connection.newSession).toHaveBeenCalledWith({
      cwd: '/repo',
      mcpServers: [],
      _meta: { sessionKey: 'agent:pi:session-123', prefixCwd: true },
    });
    expect(connection.loadSession).not.toHaveBeenCalled();
  });

  it('routes fresh-session prompts through the ACP session id returned by session/new', async () => {
    const { service, connection } = await createService();

    await service.loadSession({ sessionKey: 'agent:pi:session-123', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true });
    await expect(service.sendPrompt({
      sessionKey: 'agent:pi:session-123',
      cwd: '/repo',
      message: 'hello',
      messageId: 'msg-1',
    })).resolves.toEqual({ success: true, generation: 1 });

    expect(connection.prompt).toHaveBeenCalledWith({
      sessionId: 'acp-session-1',
      prompt: [{ type: 'text', text: 'hello' }],
      messageId: 'msg-1',
      _meta: { sessionKey: 'agent:pi:session-123', prefixCwd: true },
    });
  });

  it('queues image composer options without changing the ACP prompt text', async () => {
    const turnImagePreferenceStore = {
      enqueue: vi.fn().mockResolvedValue({ id: 'image-pref-1' }),
      discard: vi.fn().mockResolvedValue(undefined),
    };
    const { service, connection } = await createService(
      createConnection(),
      createPassthroughAccessRegistry(),
      turnImagePreferenceStore,
    );

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await expect(service.sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'Create a blue coffee cup on a white table.',
      imageOptions: { size: '3840x2160', quality: 'medium' },
    })).resolves.toEqual({ success: true, generation: 1 });

    expect(turnImagePreferenceStore.enqueue).toHaveBeenCalledWith({
      sessionKey: 'agent:pi:s1',
      message: 'Create a blue coffee cup on a white table.',
      imageOptions: { size: '3840x2160', quality: 'medium' },
    });
    expect(connection.prompt).toHaveBeenCalledWith(expect.objectContaining({
      prompt: [{ type: 'text', text: 'Create a blue coffee cup on a white table.' }],
    }));
  });

  it('discards an unclaimed image preference when ACP rejects the prompt', async () => {
    const connection = createConnection();
    connection.prompt.mockRejectedValueOnce(new Error('ACP unavailable'));
    const turnImagePreferenceStore = {
      enqueue: vi.fn().mockResolvedValue({ id: 'image-pref-2' }),
      discard: vi.fn().mockResolvedValue(undefined),
    };
    const { service } = await createService(
      connection,
      createPassthroughAccessRegistry(),
      turnImagePreferenceStore,
    );

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await expect(service.sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'Create an image.',
      imageOptions: { size: '1024x1024', quality: 'medium' },
    })).resolves.toEqual({ success: false, error: 'ACP unavailable' });

    expect(turnImagePreferenceStore.discard).toHaveBeenCalledWith('image-pref-2');
  });

  it('preserves structured terminal provider errors from ACP prompt rejection', async () => {
    const connection = createConnection();
    connection.prompt.mockRejectedValueOnce({
      message: '用户额度不足',
      code: 'insufficient_user_quota',
      status: 403,
    });
    const { service } = await createService(connection);
    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    await expect(service.sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'continue',
    })).resolves.toEqual({
      success: false,
      error: '用户额度不足',
      errorCode: 'INSUFFICIENT_QUOTA',
      retryable: false,
      httpStatus: 403,
      upstreamCode: 'insufficient_user_quota',
    });
  });

  it('retries a pre-tool upstream 503 with bounded exponential backoff', async () => {
    const connection = createConnection();
    connection.prompt
      .mockRejectedValueOnce({ status: 503, type: 'service_unavailable_error', message: 'Our servers are currently overloaded.' })
      .mockRejectedValueOnce({ status: 503, type: 'upstream_error', message: 'Upstream service temporarily unavailable.' })
      .mockResolvedValueOnce({ stopReason: 'end_turn' });
    const { service } = await createService(connection);
    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    vi.useFakeTimers();

    try {
      const result = service.sendPrompt({
        sessionKey: 'agent:pi:s1',
        cwd: '/repo',
        message: 'create the report',
        messageId: 'msg-overload',
      });
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toEqual({ success: true, generation: 1 });
      expect(connection.prompt).toHaveBeenCalledTimes(3);
      expect(connection.prompt.mock.calls[0]?.[0]).toMatchObject({
        prompt: [{ type: 'text', text: 'create the report' }],
        messageId: 'msg-overload',
      });
      expect(connection.prompt.mock.calls[1]?.[0]).toMatchObject({
        messageId: 'msg-overload:upstream-retry:2',
        prompt: [{ type: 'text', text: expect.stringContaining('latest unresolved user request already recorded') }],
      });
      expect(connection.prompt.mock.calls[2]?.[0]).toMatchObject({
        messageId: 'msg-overload:upstream-retry:3',
      });
      expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('after 500ms'));
      expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('after 1000ms'));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [{ status: 429, type: 'rate_limit_error', message: 'Too many requests.' }, 'RATE_LIMIT'],
    [{ type: 'service_unavailable', message: 'The provider is unavailable.' }, 'SERVICE_UNAVAILABLE'],
    [{ type: 'upstream_error', message: 'The upstream failed.' }, 'SERVICE_UNAVAILABLE'],
  ] as const)('retries Responses upstream failure shape %j', async (upstreamError, expectedCode) => {
    const connection = createConnection();
    connection.prompt
      .mockRejectedValueOnce(upstreamError)
      .mockRejectedValueOnce(upstreamError)
      .mockRejectedValueOnce(upstreamError);
    const { service } = await createService(connection);
    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    vi.useFakeTimers();

    try {
      const result = service.sendPrompt({
        sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'continue', messageId: 'msg-responses-shape',
      });
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(result).resolves.toMatchObject({
        success: false,
        errorCode: expectedCode,
        retryable: true,
      });
      expect(connection.prompt).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits one terminal failure reply when bounded upstream retries are exhausted', async () => {
    const connection = createConnection();
    connection.prompt.mockRejectedValue({ type: 'upstream_error', message: 'Upstream service failed.' });
    const { service, send } = await createService(connection);
    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    vi.useFakeTimers();

    try {
      const result = service.sendPrompt({
        sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'continue', messageId: 'msg-final-failure',
      });
      await vi.advanceTimersByTimeAsync(500 + 1_000);
      await expect(result).resolves.toMatchObject({
        success: false,
        errorCode: 'SERVICE_UNAVAILABLE',
        retryable: true,
      });
      expect(connection.prompt).toHaveBeenCalledTimes(3);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(HOST_EVENT_CHANNELS.chat.acpSessionUpdate, expect.objectContaining({
        notification: expect.objectContaining({
          sessionId: 'agent:pi:s1',
          update: expect.objectContaining({
            sessionUpdate: 'uclaw_turn_failure',
            userMessageId: 'msg-final-failure',
            errorCode: 'SERVICE_UNAVAILABLE',
            retryable: true,
          }),
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replay an upstream 503 after a tool call has started', async () => {
    const connection = createConnection();
    const pendingPrompt = createDeferred<unknown>();
    connection.prompt.mockReturnValueOnce(pendingPrompt.promise);
    const { service } = await createService(connection);
    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    const result = service.sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'edit the workbook',
      messageId: 'msg-post-tool',
    });
    await vi.waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(1));
    await service.client.sessionUpdate({
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-side-effect',
        title: 'Write workbook',
        status: 'in_progress',
      },
    } as never);
    pendingPrompt.reject({ status: 503, type: 'upstream_error', message: 'Upstream service temporarily unavailable.' });

    await expect(result).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('did not replay the turn'),
      errorCode: 'SERVICE_UNAVAILABLE',
      retryable: true,
      httpStatus: 503,
    });
    expect(connection.prompt).toHaveBeenCalledTimes(1);
  });

  it('settles a hung prompt from its terminal event and completes a replay-safe retry', async () => {
    const connection = createConnection();
    const firstPrompt = createDeferred<unknown>();
    connection.prompt
      .mockReturnValueOnce(firstPrompt.promise)
      .mockResolvedValueOnce({ stopReason: 'end_turn' });
    const { service, send } = await createService(connection);
    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    vi.useFakeTimers();

    try {
      const result = service.sendPrompt({
        sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'continue', messageId: 'msg-terminal-retry',
      });
      await vi.waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(1));
      await service.client.sessionUpdate({
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'uclaw_turn_failure',
          userMessageId: 'msg-terminal-retry',
          errorMessage: 'Upstream service temporarily unavailable.',
        },
      } as never);

      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toEqual({ success: true, generation: 1 });
      expect(send).not.toHaveBeenCalledWith(HOST_EVENT_CHANNELS.chat.acpSessionUpdate, expect.objectContaining({
        notification: expect.objectContaining({
          update: expect.objectContaining({ sessionUpdate: 'uclaw_turn_failure' }),
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a structured OpenClaw fallback summary for one context recovery attempt', async () => {
    const structuredSummary = [
      '## Decisions', 'Keep the accepted dress dimensions.',
      '## Open TODOs', 'Generate the DXF.',
      '## Constraints/Rules', 'Do not repeat completed tools.',
      '## Pending user asks', 'Finish the CAD pattern.',
      '## Exact identifiers', 'DXF-2026-08-19.',
    ].join('\n');
    const connection = createConnection();
    connection.prompt
      .mockRejectedValueOnce({
        message: 'Context is too large and auto-compaction could not recover this turn.',
        data: { recoverySummary: structuredSummary },
      })
      .mockResolvedValueOnce({ stopReason: 'end_turn' });
    const { service } = await createService(connection);
    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    vi.useFakeTimers();

    try {
      const result = service.sendPrompt({
        sessionKey: 'agent:pi:s1',
        cwd: '/repo',
        message: 'finish the CAD pattern',
        messageId: 'msg-context',
      });
      await vi.advanceTimersByTimeAsync(500);

      await expect(result).resolves.toEqual({ success: true, generation: 1 });
      expect(connection.prompt).toHaveBeenCalledTimes(2);
      expect(connection.prompt.mock.calls[1]?.[0]).toMatchObject({
        messageId: 'msg-context:context-recovery:2',
        prompt: [{ type: 'text', text: expect.stringContaining(structuredSummary) }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds a minimal recovery summary when compaction returns no summary', async () => {
    const connection = createConnection();
    connection.prompt
      .mockRejectedValueOnce({ message: 'Context limit exceeded; compaction failed.' })
      .mockResolvedValueOnce({ stopReason: 'end_turn' });
    const { service } = await createService(connection);
    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    vi.useFakeTimers();

    try {
      const result = service.sendPrompt({
        sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'continue', messageId: 'msg-minimal-recovery',
      });
      await vi.advanceTimersByTimeAsync(500);

      await expect(result).resolves.toEqual({ success: true, generation: 1 });
      expect(connection.prompt).toHaveBeenCalledTimes(2);
      const recoveryText = connection.prompt.mock.calls[1]?.[0].prompt[0];
      expect(recoveryText).toMatchObject({ type: 'text' });
      expect((recoveryText as { text: string }).text).toEqual(expect.stringContaining('## Exact identifiers'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns an explicit context error when the single recovery attempt fails', async () => {
    const connection = createConnection();
    connection.prompt.mockRejectedValue({
      message: 'Preflight compaction required but failed: summarizer unavailable',
    });
    const { service } = await createService(connection);
    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    vi.useFakeTimers();

    try {
      const result = service.sendPrompt({
        sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'continue', messageId: 'msg-context-failed',
      });
      await vi.advanceTimersByTimeAsync(500);

      await expect(result).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('Automatic context recovery failed after one replay-safe attempt'),
        errorCode: 'CONTEXT_OVERFLOW',
        retryable: true,
      });
      expect(connection.prompt).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a non-retryable provider request error', async () => {
    const connection = createConnection();
    connection.prompt.mockRejectedValueOnce({
      status: 400,
      code: 'invalid_request',
      message: 'Unsupported parameter: max_output_tokens',
    });
    const { service } = await createService(connection);
    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    await expect(service.sendPrompt({
      sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'hello', messageId: 'msg-invalid',
    })).resolves.toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
      retryable: false,
      httpStatus: 400,
    });
    expect(connection.prompt).toHaveBeenCalledTimes(1);
  });

  it('queues video composer options without changing the ACP prompt text', async () => {
    const turnVideoPreferenceStore = {
      enqueue: vi.fn().mockResolvedValue({ id: 'video-pref-1' }),
      discard: vi.fn().mockResolvedValue(undefined),
    };
    const { service, connection } = await createService(
      createConnection(),
      createPassthroughAccessRegistry(),
      undefined,
      turnVideoPreferenceStore,
    );

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await expect(service.sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'Create a six-second product video.',
      videoOptions: {
        aspectRatio: '16:9',
        resolution: '480P',
        durationSeconds: 6,
      },
    })).resolves.toEqual({ success: true, generation: 1 });

    expect(turnVideoPreferenceStore.enqueue).toHaveBeenCalledWith({
      sessionKey: 'agent:pi:s1',
      message: 'Create a six-second product video.',
      videoOptions: {
        aspectRatio: '16:9',
        resolution: '480P',
        durationSeconds: 6,
      },
    });
    expect(connection.prompt).toHaveBeenCalledWith(expect.objectContaining({
      prompt: [{ type: 'text', text: 'Create a six-second product video.' }],
    }));
  });

  it('sends and stores the same bounded video reference bytes while retaining the original attachment identity', async () => {
    const imagePath = join(tmpdir(), `clawx-video-reference-${Date.now()}.png`);
    const pixels = randomBytes(700 * 700 * 3);
    await sharp(pixels, { raw: { width: 700, height: 700, channels: 3 } }).png().toFile(imagePath);
    const turnVideoPreferenceStore = {
      enqueue: vi.fn().mockResolvedValue({ id: 'video-pref-reference' }),
      discard: vi.fn().mockResolvedValue(undefined),
    };

    try {
      const { service, connection } = await createService(
        createConnection(),
        createPassthroughAccessRegistry(),
        undefined,
        turnVideoPreferenceStore,
      );
      await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

      await expect(service.sendPrompt({
        sessionKey: 'agent:pi:s1',
        cwd: '/repo',
        message: 'Animate this product image.',
        videoOptions: { aspectRatio: '16:9', resolution: '480P', durationSeconds: 6 },
        media: [{
          filePath: imagePath,
          stagingId: 'staged-video-reference',
          fileName: 'product.png',
          mimeType: 'image/png',
        }],
      })).resolves.toEqual({ success: true, generation: 1 });

      const enqueueInput = turnVideoPreferenceStore.enqueue.mock.calls[0]?.[0] as {
        referenceImage: { buffer: Buffer; fileName: string; mimeType: string };
      };
      const promptInput = connection.prompt.mock.calls[0]?.[0] as {
        prompt: Array<Record<string, unknown>>;
      };
      const imageBlock = promptInput.prompt[1] as {
        data: string;
        mimeType: string;
        uri: string;
        _meta: unknown;
      };
      const deliveredBytes = Buffer.from(imageBlock.data, 'base64');

      expect(deliveredBytes.byteLength).toBeLessThanOrEqual(UCLAW_VIDEO_GENERATION_MAX_INPUT_IMAGE_BYTES);
      expect(enqueueInput.referenceImage).toMatchObject({
        fileName: 'product.jpg',
        mimeType: 'image/jpeg',
      });
      expect(enqueueInput.referenceImage.buffer).toEqual(deliveredBytes);
      expect(imageBlock).toMatchObject({
        mimeType: 'image/jpeg',
        uri: imagePath,
        _meta: { clawx: { stagingId: 'staged-video-reference', fileName: 'product.png' } },
      });
    } finally {
      rmSync(imagePath, { force: true });
    }
  }, 15_000);

  it('discards an unclaimed video preference when ACP rejects the prompt', async () => {
    const connection = createConnection();
    connection.prompt.mockRejectedValueOnce(new Error('ACP unavailable'));
    const turnVideoPreferenceStore = {
      enqueue: vi.fn().mockResolvedValue({ id: 'video-pref-2' }),
      discard: vi.fn().mockResolvedValue(undefined),
    };
    const { service } = await createService(
      connection,
      createPassthroughAccessRegistry(),
      undefined,
      turnVideoPreferenceStore,
    );

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await expect(service.sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'Create a video.',
      videoOptions: {
        aspectRatio: '16:9',
        resolution: '720P',
        durationSeconds: 10,
      },
    })).resolves.toEqual({ success: false, error: 'ACP unavailable' });

    expect(turnVideoPreferenceStore.discard).toHaveBeenCalledWith('video-pref-2');
  });

  it('rejects video mode with more than one image before delivering an ACP prompt', async () => {
    const firstImagePath = join(tmpdir(), `clawx-video-reference-${Date.now()}-one.png`);
    const secondImagePath = join(tmpdir(), `clawx-video-reference-${Date.now()}-two.png`);
    writeFileSync(firstImagePath, 'first image');
    writeFileSync(secondImagePath, 'second image');

    try {
      const { service, connection } = await createService();
      await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

      await expect(service.sendPrompt({
        sessionKey: 'agent:pi:s1',
        cwd: '/repo',
        message: 'Animate these images.',
        videoOptions: { aspectRatio: '16:9', resolution: '480P', durationSeconds: 6 },
        media: [
          { filePath: firstImagePath, stagingId: 'staged-one', mimeType: 'image/png' },
          { filePath: secondImagePath, stagingId: 'staged-two', mimeType: 'image/png' },
        ],
      })).resolves.toEqual({
        success: false,
        error: 'Video generation supports at most one reference image.',
      });

      expect(connection.prompt).not.toHaveBeenCalled();
    } finally {
      rmSync(firstImagePath, { force: true });
      rmSync(secondImagePath, { force: true });
    }
  });

  it('rewrites fresh-session ACP updates to the ClawX session key for the renderer', async () => {
    const { service, send } = await createService();

    await service.loadSession({ sessionKey: 'agent:pi:session-123', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true });
    await service.client.sessionUpdate({
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read file',
        status: 'completed',
      },
    } as never);

    expect(send).toHaveBeenCalledWith(HOST_EVENT_CHANNELS.chat.acpSessionUpdate, {
      sessionKey: 'agent:pi:session-123',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:session-123',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Read file',
          status: 'completed',
        },
      },
    });
  });

  it('emits raw ACP session updates with sessionKey and generation for the active session', async () => {
    const { service, send } = await createService();

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await service.sendPrompt({ sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'live', messageId: 'msg-live' });
    send.mockClear();
    await service.client.sessionUpdate({
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-1',
        content: { type: 'text', text: 'hello' },
      },
    } as never);
    await service.client.sessionUpdate({
      sessionId: 'agent:other:s2',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-2',
        content: { type: 'text', text: 'ignored' },
      },
    } as never);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(HOST_EVENT_CHANNELS.chat.acpSessionUpdate, {
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: 'hello' },
        },
      },
    });
  });

  it('keeps routing an in-flight prompt while another session is viewed and reactivates it without replay', async () => {
    const connection = createConnection();
    const prompt = createDeferred<{ stopReason: string }>();
    connection.prompt.mockReturnValueOnce(prompt.promise);
    const { service, send } = await createService(connection);

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    const sendPrompt = service.sendPrompt({
      sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'keep streaming', messageId: 'msg-user',
    });
    await vi.waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(1));

    await service.client.sessionUpdate({
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-assistant',
        content: { type: 'text', text: 'before switch ' },
      },
    } as never);
    await service.loadSession({ sessionKey: 'agent:pi:s2', workspaceRoot: '/repo', cwd: '/repo' });
    await service.client.sessionUpdate({
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-assistant',
        content: { type: 'text', text: 'while away ' },
      },
    } as never);

    await expect(service.loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    })).resolves.toEqual({ success: true, generation: 1, resumedActivePrompt: true });
    await service.client.sessionUpdate({
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-assistant',
        content: { type: 'text', text: 'after return' },
      },
    } as never);

    const routedChunks = send.mock.calls
      .filter(([channel, envelope]) => (
        channel === HOST_EVENT_CHANNELS.chat.acpSessionUpdate
        && envelope.sessionKey === 'agent:pi:s1'
        && envelope.notification.update.sessionUpdate === 'agent_message_chunk'
      ))
      .map(([, envelope]) => ({
        generation: envelope.generation,
        text: envelope.notification.update.content.text,
      }));
    expect(routedChunks).toEqual([
      { generation: 1, text: 'before switch ' },
      { generation: 1, text: 'while away ' },
      { generation: 1, text: 'after return' },
    ]);
    expect(connection.loadSession).toHaveBeenCalledTimes(2);

    prompt.resolve({ stopReason: 'end_turn' });
    await expect(sendPrompt).resolves.toEqual({ success: true, generation: 1 });
    await expect(service.loadSession({
      sessionKey: 'agent:pi:s2', workspaceRoot: '/repo', cwd: '/repo',
    })).resolves.toEqual({ success: true, generation: 3 });
  });

  it('records ACP session load and forwarded update trace entries', async () => {
    const { clearAcpTraceForTests, getAcpTraceSnapshot } = await import('../../electron/services/acp-trace');
    clearAcpTraceForTests();
    const { service } = await createService();

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await service.client.sessionUpdate({
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-1',
        content: { type: 'text', text: 'hello' },
      },
    } as never);

    expect(getAcpTraceSnapshot().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'main',
        event: 'session/load:start',
        sessionKey: 'agent:pi:s1',
      }),
      expect.objectContaining({
        source: 'main',
        event: 'session/load:success',
        sessionKey: 'agent:pi:s1',
        generation: 1,
      }),
      expect.objectContaining({
        source: 'main',
        event: 'session-update:received',
        direction: 'upstream',
      }),
      expect.objectContaining({
        source: 'main',
        event: 'session-update:forwarded',
        direction: 'downstream',
      }),
    ]));
  });

  it('records one content-free first-text timing entry for a live prompt', async () => {
    const { clearAcpTraceForTests, getAcpTraceSnapshot } = await import('../../electron/services/acp-trace');
    clearAcpTraceForTests();
    const connection = createConnection();
    const prompt = createDeferred<{ stopReason: string }>();
    connection.prompt.mockReturnValueOnce(prompt.promise);
    const { service } = await createService(connection);

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    const sendPrompt = service.sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'private latency probe',
      messageId: 'msg-user',
      clientStartedAtMs: Date.now() - 25,
    });
    await vi.waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(1));

    const assistantUpdate = {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-assistant',
        content: { type: 'text', text: 'hello' },
      },
    } as never;
    await service.client.sessionUpdate(assistantUpdate);
    await service.client.sessionUpdate(assistantUpdate);

    prompt.resolve({ stopReason: 'end_turn' });
    await expect(sendPrompt).resolves.toEqual({ success: true, generation: 1 });

    const entries = getAcpTraceSnapshot().entries;
    const firstTextEntries = entries.filter((entry) => entry.event === 'session/prompt:first-text');
    expect(firstTextEntries).toHaveLength(1);
    expect(firstTextEntries[0]).toEqual(expect.objectContaining({
      source: 'main',
      direction: 'downstream',
      sessionKey: 'agent:pi:s1',
      generation: 1,
      details: expect.objectContaining({
        clientToMainMs: expect.any(Number),
        mainToDispatchMs: expect.any(Number),
        dispatchToFirstTextMs: expect.any(Number),
        clientToFirstTextMs: expect.any(Number),
      }),
    }));
    expect(JSON.stringify(firstTextEntries[0]?.details)).not.toContain('private latency probe');
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'session/prompt:complete',
        details: expect.objectContaining({
          requestId: 'msg-user',
          outcome: 'success',
          firstTextObserved: true,
          connectionPromptWaitMs: expect.any(Number),
          preDispatchPhases: expect.objectContaining({
            readyGatewayMs: expect.any(Number),
            ensureConnectionMs: expect.any(Number),
            promptBuildMs: expect.any(Number),
            preferenceEnqueueMs: expect.any(Number),
          }),
          clientToCompleteMs: expect.any(Number),
          firstTextToCompleteMs: expect.any(Number),
        }),
      }),
    ]));
  });

  it('records ignored ACP session updates with a mismatch reason', async () => {
    const { clearAcpTraceForTests, getAcpTraceSnapshot } = await import('../../electron/services/acp-trace');
    clearAcpTraceForTests();
    const { service } = await createService();

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await service.client.sessionUpdate({
      sessionId: 'agent:other:s2',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-2',
        content: { type: 'text', text: 'ignored' },
      },
    } as never);

    expect(getAcpTraceSnapshot().entries).toContainEqual(expect.objectContaining({
      source: 'main',
      event: 'session-update:ignored',
      direction: 'upstream',
      sessionKey: 'agent:pi:s1',
      details: expect.objectContaining({ reason: 'session-mismatch' }),
    }));
  });

  it('marks ACP session updates from historical loads until the next live prompt starts', async () => {
    const { service, send } = await createService();

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await service.client.sessionUpdate({
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'history-tool',
        title: 'Historical tool',
        status: 'completed',
      },
    } as never);

    expect(send).toHaveBeenCalledWith(HOST_EVENT_CHANNELS.chat.acpSessionUpdate, {
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'history-tool',
          title: 'Historical tool',
          status: 'completed',
        },
      },
    });

    await service.sendPrompt({ sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'live', messageId: 'live-message' });
    send.mockClear();
    await service.client.sessionUpdate({
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'live-tool',
        title: 'Live tool',
        status: 'completed',
      },
    } as never);

    expect(send).toHaveBeenCalledWith(HOST_EVENT_CHANNELS.chat.acpSessionUpdate, expect.not.objectContaining({
      historical: true,
    }));
  });

  it('emits permission requests separately and resolves them from respondPermission', async () => {
    const connection = createConnection();
    const prompt = createDeferred<{ stopReason: string }>();
    connection.prompt.mockReturnValueOnce(prompt.promise);
    const { service, send } = await createService(connection);

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    const sendPrompt = service.sendPrompt({ sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'edit the file' });
    await vi.waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(1));
    send.mockClear();

    const pending = service.client.requestPermission({
      sessionId: 'agent:pi:s1',
      toolCall: { toolCallId: 'tool-1', title: 'Edit file', status: 'pending' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);
    const envelope = send.mock.calls[0]?.[1];

    expect(send).toHaveBeenCalledWith(HOST_EVENT_CHANNELS.chat.acpPermissionRequest, {
      sessionKey: 'agent:pi:s1',
      generation: 1,
      requestId: expect.any(String),
      request: {
        sessionId: 'agent:pi:s1',
        toolCall: { toolCallId: 'tool-1', title: 'Edit file', status: 'pending' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      },
    });
    expect(send).not.toHaveBeenCalledWith(HOST_EVENT_CHANNELS.chat.acpSessionUpdate, expect.anything());

    await expect(service.respondPermission({
      sessionKey: 'agent:pi:s1',
      requestId: envelope.requestId,
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    })).resolves.toEqual({ success: true, generation: 1 });
    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    prompt.resolve({ stopReason: 'end_turn' });
    await sendPrompt;
  });

  it('responds to an inactive live prompt permission with its original generation', async () => {
    const connection = createConnection();
    const prompt = createDeferred<{ stopReason: string }>();
    connection.prompt.mockReturnValueOnce(prompt.promise);
    const { service, send } = await createService(connection);

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    const sendPrompt = service.sendPrompt({ sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'edit' });
    await vi.waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(1));
    const pending = service.client.requestPermission({
      sessionId: 'agent:pi:s1',
      toolCall: { toolCallId: 'tool-1', title: 'Edit file', status: 'pending' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);
    const requestId = send.mock.calls.at(-1)?.[1].requestId;

    await service.loadSession({ sessionKey: 'agent:pi:s2', workspaceRoot: '/repo', cwd: '/repo' });
    await expect(service.respondPermission({
      sessionKey: 'agent:pi:s1',
      requestId,
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    })).resolves.toEqual({ success: true, generation: 1 });
    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });

    prompt.resolve({ stopReason: 'end_turn' });
    await sendPrompt;
  });

  it('returns cancelled for permission requests from non-active sessions', async () => {
    const { service, send } = await createService();

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    send.mockClear();

    await expectCancelledSoon(service.client.requestPermission({
      sessionId: 'agent:other:s2',
      toolCall: { toolCallId: 'tool-1', title: 'Edit file', status: 'pending' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never));

    expect(send).not.toHaveBeenCalled();
  });

  it('cancels pending permission requests when switching sessions', async () => {
    const { service, send } = await createService();

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await service.sendPrompt({ sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'edit the file' });
    send.mockClear();
    const pending = service.client.requestPermission({
      sessionId: 'agent:pi:s1',
      toolCall: { toolCallId: 'tool-1', title: 'Edit file', status: 'pending' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);

    await expect(service.loadSession({ sessionKey: 'agent:pi:s2', workspaceRoot: '/repo', cwd: '/repo' })).resolves.toEqual({
      success: true,
      generation: 2,
    });

    await expectCancelledSoon(pending);
  });

  it('cancels pending permission requests when reloading the same session', async () => {
    const { service, send } = await createService();

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await service.sendPrompt({ sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'edit the file' });
    send.mockClear();
    const pending = service.client.requestPermission({
      sessionId: 'agent:pi:s1',
      toolCall: { toolCallId: 'tool-1', title: 'Edit file', status: 'pending' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    await expectCancelledSoon(pending);
  });

  it('cancels permission requests received while session/load is in progress', async () => {
    const connection = createConnection();
    const load = createDeferred<unknown>();
    connection.loadSession.mockReturnValueOnce(load.promise);
    const { service, send } = await createService(connection);
    const loadPromise = service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await vi.waitFor(() => expect(connection.loadSession).toHaveBeenCalledTimes(1));
    send.mockClear();

    await expectCancelledSoon(service.client.requestPermission({
      sessionId: 'agent:pi:s1',
      toolCall: { toolCallId: 'tool-load', title: 'Unexpected load permission', status: 'pending' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never));
    expect(send).not.toHaveBeenCalledWith(HOST_EVENT_CHANNELS.chat.acpPermissionRequest, expect.anything());

    load.resolve({});
    await loadPromise;
  });

  it('cancels permission requests after load until the current session starts a prompt', async () => {
    const { service, send } = await createService();
    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    send.mockClear();

    await expectCancelledSoon(service.client.requestPermission({
      sessionId: 'agent:pi:s1',
      toolCall: { toolCallId: 'tool-handoff', title: 'Late load permission', status: 'pending' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never));
    expect(send).not.toHaveBeenCalledWith(HOST_EVENT_CHANNELS.chat.acpPermissionRequest, expect.anything());
  });

  it('cancels pending permission requests and drops the connection when the ACP child exits', async () => {
    const firstConnection = createConnection();
    const { service, child } = await createSpawnedService(firstConnection);

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await service.sendPrompt({ sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'edit the file' });
    const pending = service.client.requestPermission({
      sessionId: 'agent:pi:s1',
      toolCall: { toolCallId: 'tool-1', title: 'Edit file', status: 'pending' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);
    const secondConnection = createConnection();
    acpSdkMock.state.connectionForSpawn = secondConnection;
    childProcessMock.state.child = createFakeChild();

    child.emit('exit', 1);

    await expectCancelledSoon(pending);
    await service.loadSession({ sessionKey: 'agent:pi:s2', workspaceRoot: '/repo', cwd: '/repo' });
    expect(childProcessMock.fork).toHaveBeenCalledTimes(2);
    expect(secondConnection.initialize).toHaveBeenCalledTimes(1);
  });

  it('cancels pending permission requests and drops the connection when the ACP child errors', async () => {
    const firstConnection = createConnection();
    const { service, child } = await createSpawnedService(firstConnection);

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await service.sendPrompt({ sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'edit the file' });
    const pending = service.client.requestPermission({
      sessionId: 'agent:pi:s1',
      toolCall: { toolCallId: 'tool-1', title: 'Edit file', status: 'pending' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);
    const secondConnection = createConnection();
    acpSdkMock.state.connectionForSpawn = secondConnection;
    childProcessMock.state.child = createFakeChild();

    child.emit('error', new Error('spawn failed'));

    await expectCancelledSoon(pending);
    await service.loadSession({ sessionKey: 'agent:pi:s2', workspaceRoot: '/repo', cwd: '/repo' });
    expect(childProcessMock.fork).toHaveBeenCalledTimes(2);
    expect(secondConnection.initialize).toHaveBeenCalledTimes(1);
  });

  it('shares one initialize call for simultaneous session loads', async () => {
    const connection = createConnection();
    const initialized = createDeferred<ReturnType<typeof createInitResponse>>();
    connection.initialize.mockReturnValue(initialized.promise);
    const { service } = await createService(connection);

    const firstLoad = service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    const secondLoad = service.loadSession({ sessionKey: 'agent:pi:s2', workspaceRoot: '/repo', cwd: '/repo' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connection.initialize).toHaveBeenCalledTimes(1);

    initialized.resolve(createInitResponse());
    await expect(Promise.all([firstLoad, secondLoad])).resolves.toHaveLength(2);
  });

  it('serializes overlapping session loads on the shared ACP connection', async () => {
    const connection = createConnection();
    const firstLoad = createDeferred<unknown>();
    connection.loadSession
      .mockReturnValueOnce(firstLoad.promise)
      .mockResolvedValueOnce({});
    const { service } = await createService(connection);

    const first = service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await vi.waitFor(() => expect(connection.loadSession).toHaveBeenCalledTimes(1));
    const second = service.loadSession({ sessionKey: 'agent:pi:s2', workspaceRoot: '/repo', cwd: '/repo' });
    await Promise.resolve();

    expect(connection.loadSession).toHaveBeenCalledTimes(1);
    firstLoad.resolve({});
    await expect(first).resolves.toMatchObject({ success: true, generation: 1 });
    await expect(second).resolves.toMatchObject({ success: true, generation: 2 });
    expect(connection.loadSession).toHaveBeenCalledTimes(2);
  });

  it('returns session/load replay as one batch without forwarding incremental events', async () => {
    const connection = createConnection();
    const { service, send } = await createService(connection);
    connection.loadSession.mockImplementationOnce(async () => {
      await service.client.sessionUpdate({
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'history-message',
          content: { type: 'text', text: 'complete history' },
        },
      } as never);
      return {};
    });

    await expect(service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' })).resolves.toEqual({
      success: true,
      generation: 1,
      sessionUpdates: [{
        sessionKey: 'agent:pi:s1',
        generation: 1,
        historical: true,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'history-message',
            content: { type: 'text', text: 'complete history' },
          },
        },
      }],
    });
    expect(send).not.toHaveBeenCalledWith(HOST_EVENT_CHANNELS.chat.acpSessionUpdate, expect.anything());
  });

  it('filters old-session updates received before session/new returns its ACP id', async () => {
    const connection = createConnection();
    const { service } = await createService(connection);
    connection.newSession.mockImplementationOnce(async () => {
      await service.client.sessionUpdate({
        sessionId: 'acp-old-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'stale-message',
          content: { type: 'text', text: 'old session tail' },
        },
      } as never);
      return { sessionId: 'acp-new-session' };
    });

    await expect(service.loadSession({
      sessionKey: 'agent:pi:session-new',
      workspaceRoot: '/repo',
      cwd: '/repo',
      createIfMissing: true,
    })).resolves.toEqual({ success: true, generation: 1 });
  });

  it('rejects prompts before any ACP session has loaded', async () => {
    const { service, connection } = await createService();

    await expect(service.sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'hello',
    })).resolves.toEqual({ success: false, error: 'No active ACP session' });

    expect(connection.prompt).not.toHaveBeenCalled();
  });

  it('rejects prompts for inactive ACP sessions', async () => {
    const { service, connection } = await createService();
    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    connection.prompt.mockClear();

    await expect(service.sendPrompt({
      sessionKey: 'agent:pi:s2',
      cwd: '/repo',
      message: 'wrong session',
    })).resolves.toEqual({ success: false, error: 'ACP prompt session is not active' });

    expect(connection.prompt).not.toHaveBeenCalled();
  });

  it('rejects prompts while a session load is still in progress', async () => {
    const connection = createConnection();
    const load = createDeferred<unknown>();
    connection.loadSession.mockReturnValueOnce(load.promise);
    const { service, connection: activeConnection } = await createService(connection);

    const loadPromise = service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await vi.waitFor(() => expect(connection.loadSession).toHaveBeenCalledTimes(1));

    await expect(service.sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'too early',
    })).resolves.toEqual({ success: false, error: 'ACP session is not loaded' });

    expect(activeConnection.prompt).not.toHaveBeenCalled();
    load.resolve({});
    await loadPromise;
  });

  it('rolls back active session and generation when loadSession fails', async () => {
    const { service, connection, send } = await createService();

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    connection.loadSession.mockRejectedValueOnce(new Error('load failed'));

    await expect(service.loadSession({ sessionKey: 'agent:pi:s2', workspaceRoot: '/repo', cwd: '/repo' })).resolves.toEqual({
      success: false,
      error: 'load failed',
    });
    await service.client.sessionUpdate({
      sessionId: 'agent:pi:s2',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-2',
        content: { type: 'text', text: 'ignored' },
      },
    } as never);
    await service.client.sessionUpdate({
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-1',
        content: { type: 'text', text: 'still active' },
      },
    } as never);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(HOST_EVENT_CHANNELS.chat.acpSessionUpdate, {
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: 'still active' },
        },
      },
    });
  });

  it.each([
    { createIfMissing: false, operation: 'loadSession' as const },
    { createIfMissing: true, operation: 'newSession' as const },
  ])('commits a canonical access grant only after $operation resolves', async ({ createIfMissing, operation }) => {
    const parent = mkdtempSync(join(tmpdir(), 'clawx-acp-service-access-'));
    const workspaceRoot = join(parent, 'workspace');
    const executionCwd = join(workspaceRoot, 'nested');
    mkdirSync(executionCwd, { recursive: true });
    const connection = createConnection();
    const pending = createDeferred<unknown>();
    connection[operation].mockReturnValueOnce(pending.promise);

    try {
      const { AcpSessionAccessRegistry } = await import('../../electron/services/acp-session-access-registry');
      const accessRegistry = new AcpSessionAccessRegistry();
      const { service } = await createService(connection, accessRegistry);
      const load = service.loadSession({
        sessionKey: 'agent:pi:grant',
        workspaceRoot: join(workspaceRoot, '.'),
        cwd: join(executionCwd, '.'),
        ...(createIfMissing ? { createIfMissing: true } : {}),
      });
      await vi.waitFor(() => expect(connection[operation]).toHaveBeenCalledTimes(1));

      expect(accessRegistry.get('agent:pi:grant', 1)).toBeNull();
      pending.resolve(createIfMissing ? { sessionId: 'created-session' } : {});
      await expect(load).resolves.toEqual({ success: true, generation: 1 });

      expect(accessRegistry.get('agent:pi:grant', 1)).toEqual({
        sessionKey: 'agent:pi:grant',
        generation: 1,
        workspaceRoot: await realpath(workspaceRoot),
        executionCwd: await realpath(executionCwd),
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('loads and prompts from the default workspace in the isolated OpenClaw state directory', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'clawx-acp-service-portable-'));
    const stateDir = join(parent, 'openclaw-state');
    const workspaceRoot = join(stateDir, 'workspace');
    mkdirSync(workspaceRoot, { recursive: true });
    vi.stubEnv('OPENCLAW_STATE_DIR', stateDir);

    try {
      const { AcpSessionAccessRegistry } = await import('../../electron/services/acp-session-access-registry');
      const { service, connection } = await createService(createConnection(), new AcpSessionAccessRegistry());

      await expect(service.loadSession({
        sessionKey: 'agent:pi:portable',
        workspaceRoot: '~/.openclaw/workspace',
        cwd: '~/.openclaw/workspace',
      })).resolves.toEqual({ success: true, generation: 1 });
      await expect(service.sendPrompt({
        sessionKey: 'agent:pi:portable',
        cwd: '~/.openclaw/workspace',
        message: 'hello',
      })).resolves.toEqual({ success: true, generation: 1 });

      expect(connection.loadSession).toHaveBeenCalledWith({
        sessionId: 'agent:pi:portable',
        cwd: await realpath(workspaceRoot),
        mcpServers: [],
      });
      expect(connection.prompt).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('restores the previous access grant when a later load fails', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'clawx-acp-service-rollback-'));
    const firstRoot = join(parent, 'first');
    const secondRoot = join(parent, 'second');
    mkdirSync(firstRoot);
    mkdirSync(secondRoot);

    try {
      const { AcpSessionAccessRegistry } = await import('../../electron/services/acp-session-access-registry');
      const accessRegistry = new AcpSessionAccessRegistry();
      const { service, connection } = await createService(createConnection(), accessRegistry);
      await service.loadSession({ sessionKey: 'agent:pi:first', workspaceRoot: firstRoot, cwd: firstRoot });
      connection.loadSession.mockRejectedValueOnce(new Error('load failed'));

      await expect(service.loadSession({
        sessionKey: 'agent:pi:second', workspaceRoot: secondRoot, cwd: secondRoot,
      })).resolves.toEqual({ success: false, error: 'load failed' });

      expect(accessRegistry.get('agent:pi:first', 1)).toEqual({
        sessionKey: 'agent:pi:first',
        generation: 1,
        workspaceRoot: await realpath(firstRoot),
        executionCwd: await realpath(firstRoot),
      });
      expect(accessRegistry.get('agent:pi:second', 2)).toBeNull();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects a prompt cwd that differs from the registered execution cwd', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'clawx-acp-service-prompt-cwd-'));

    try {
      const { AcpSessionAccessRegistry } = await import('../../electron/services/acp-session-access-registry');
      const { service, connection } = await createService(createConnection(), new AcpSessionAccessRegistry());
      await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot, cwd: workspaceRoot });

      await expect(service.sendPrompt({
        sessionKey: 'agent:pi:s1',
        cwd: join(workspaceRoot, 'replacement'),
        message: 'wrong cwd',
      })).resolves.toEqual({
        success: false,
        error: 'ACP prompt cwd does not match the registered execution cwd',
      });
      expect(connection.prompt).not.toHaveBeenCalled();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('continues with a queued session load after the older load fails', async () => {
    const { service, connection, send, accessRegistry } = await createService();
    const firstLoad = createDeferred<unknown>();

    connection.loadSession
      .mockReturnValueOnce(firstLoad.promise)
      .mockResolvedValueOnce({});

    const older = service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await vi.waitFor(() => expect(connection.loadSession).toHaveBeenCalledTimes(1));

    const newer = service.loadSession({ sessionKey: 'agent:pi:s2', workspaceRoot: '/repo', cwd: '/repo' });
    firstLoad.reject(new Error('older load failed'));
    await expect(older).resolves.toEqual({ success: false, error: 'older load failed' });
    await expect(newer).resolves.toEqual({ success: true, generation: 1 });
    expect(accessRegistry.get('agent:pi:s2', 1)).toEqual({
      sessionKey: 'agent:pi:s2',
      generation: 1,
      workspaceRoot: '/repo',
      executionCwd: '/repo',
    });

    await service.client.sessionUpdate({
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-1',
        content: { type: 'text', text: 'old ignored' },
      },
    } as never);
    await service.client.sessionUpdate({
      sessionId: 'agent:pi:s2',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-2',
        content: { type: 'text', text: 'new active' },
      },
    } as never);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(HOST_EVENT_CHANNELS.chat.acpSessionUpdate, {
      sessionKey: 'agent:pi:s2',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s2',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-2',
          content: { type: 'text', text: 'new active' },
        },
      },
    });
  });

  it.each(['success', 'failure'] as const)(
    'serializes deferred access preparation and keeps the later grant after older %s',
    async (olderOutcome) => {
      type AccessContext = {
        sessionKey: string;
        generation: number;
        workspaceRoot: string;
        executionCwd: string;
      };
      const preparations: Array<{
        input: AccessContext;
        deferred: ReturnType<typeof createDeferred<AccessContext>>;
      }> = [];
      let activeGrant: AccessContext | null = null;
      const accessRegistry = {
        prepareGrant: vi.fn((input: AccessContext) => {
          const deferred = createDeferred<AccessContext>();
          preparations.push({ input, deferred });
          return deferred.promise;
        }),
        snapshot: vi.fn(() => activeGrant ? { ...activeGrant } : null),
        commitGrant: vi.fn((context: AccessContext) => { activeGrant = { ...context }; }),
        restore: vi.fn((snapshot: AccessContext | null) => { activeGrant = snapshot ? { ...snapshot } : null; }),
        get: vi.fn((sessionKey: string, generation: number) => (
          activeGrant?.sessionKey === sessionKey && activeGrant.generation === generation
            ? { ...activeGrant }
            : null
        )),
      };
      const connection = createConnection();
      const { service } = await createService(connection, accessRegistry);

      const olderLoad = service.loadSession({
        sessionKey: 'agent:pi:older', workspaceRoot: '/older', cwd: '/older',
      });
      await vi.waitFor(() => expect(preparations).toHaveLength(1));
      const laterLoad = service.loadSession({
        sessionKey: 'agent:pi:later', workspaceRoot: '/later', cwd: '/later',
      });
      await Promise.resolve();
      expect(preparations).toHaveLength(1);

      if (olderOutcome === 'success') {
        preparations[0].deferred.resolve(preparations[0].input);
        await expect(olderLoad).resolves.toEqual({ success: true, generation: 1 });
      } else {
        preparations[0].deferred.reject(new Error('older preparation failed'));
        await expect(olderLoad).resolves.toEqual({
          success: false,
          error: 'older preparation failed',
        });
      }

      await vi.waitFor(() => expect(preparations).toHaveLength(2));
      const laterGeneration = olderOutcome === 'success' ? 2 : 1;
      expect(preparations.map(({ input }) => input.generation)).toEqual([1, laterGeneration]);
      preparations[1].deferred.resolve(preparations[1].input);
      await expect(laterLoad).resolves.toEqual({ success: true, generation: laterGeneration });

      expect(accessRegistry.get('agent:pi:later', laterGeneration)).toEqual({
        sessionKey: 'agent:pi:later',
        generation: laterGeneration,
        workspaceRoot: '/later',
        executionCwd: '/later',
      });
      expect(accessRegistry.get('agent:pi:older', 1)).toBeNull();
      expect(connection.loadSession).toHaveBeenCalledWith({
        sessionId: 'agent:pi:later',
        cwd: '/later',
        mcpServers: [],
      });
      expect(accessRegistry.restore).not.toHaveBeenCalled();
    },
  );

  it('cancels the ACP session and resolves pending permission requests for that session', async () => {
    const { service, connection, send } = await createService();

    await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await service.sendPrompt({ sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'edit the file' });
    send.mockClear();

    const pending = service.client.requestPermission({
      sessionId: 'agent:pi:s1',
      toolCall: { toolCallId: 'tool-1', title: 'Edit file', status: 'pending' },
      options: [{ optionId: 'reject', name: 'Reject', kind: 'reject' }],
    } as never);

    await expect(service.cancelSession({ sessionKey: 'agent:pi:s1' })).resolves.toEqual({
      success: true,
      generation: 1,
    });

    expect(connection.cancel).toHaveBeenCalledWith({ sessionId: 'agent:pi:s1' });
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('builds ACP prompt blocks from message and media', async () => {
    const imagePath = join(tmpdir(), `clawx-acp-service-${Date.now()}.png`);
    const filePath = join(tmpdir(), `clawx-acp-service-${Date.now()}.txt`);
    writeFileSync(imagePath, 'fake-image');
    writeFileSync(filePath, 'plain text');

    try {
      const { service, connection } = await createService();

      await service.loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
      await expect(service.sendPrompt({
        sessionKey: 'agent:pi:s1',
        cwd: '/repo',
        message: 'Inspect attachments',
        messageId: 'msg-user-1',
        media: [
          { filePath: imagePath, stagingId: 'staged-image', mimeType: 'image/png', fileName: 'image.png' },
          { filePath, stagingId: 'staged-notes', mimeType: 'text/plain', fileName: 'notes.txt' },
        ],
      })).resolves.toEqual({ success: true, generation: 1 });

      expect(connection.prompt).toHaveBeenCalledWith({
        sessionId: 'agent:pi:s1',
        messageId: 'msg-user-1',
        prompt: [
          { type: 'text', text: 'Inspect attachments' },
          {
            type: 'image',
            data: Buffer.from('fake-image').toString('base64'),
            mimeType: 'image/png',
            uri: imagePath,
            _meta: { clawx: { stagingId: 'staged-image', fileName: 'image.png' } },
          },
          {
            type: 'resource_link',
            uri: filePath,
            name: 'notes.txt',
            mimeType: 'text/plain',
            _meta: { clawx: { stagingId: 'staged-notes' } },
          },
        ],
        _meta: { sessionKey: 'agent:pi:s1', prefixCwd: true },
      });
    } finally {
      rmSync(imagePath, { force: true });
      rmSync(filePath, { force: true });
    }
  });
});
