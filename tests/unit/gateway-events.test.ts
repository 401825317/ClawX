import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.fn();
const subscribeHostEventMock = vi.fn();

function flushAsyncImports(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function importRealChatStore() {
  vi.doUnmock('@/stores/chat');
  return vi.importActual<typeof import('../../src/stores/chat')>('../../src/stores/chat');
}

async function importRealGatewayStore() {
  vi.doUnmock('@/stores/gateway');
  return vi.importActual<typeof import('../../src/stores/gateway')>('../../src/stores/gateway');
}

async function importRealManagedAuthStore() {
  vi.doUnmock('@/stores/managed-auth');
  return vi.importActual<typeof import('../../src/stores/managed-auth')>('../../src/stores/managed-auth');
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

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: (...args: unknown[]) => subscribeHostEventMock(...args),
}));

vi.unmock('@/stores/chat');
vi.unmock('@/stores/gateway');
vi.unmock('@/stores/managed-auth');

describe('gateway store event wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    hostApiFetchMock.mockResolvedValue({ state: 'running', port: 18789 });
  });

  it('subscribes to host events through subscribeHostEvent on init', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:status', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:error', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:notification', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:health', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:presence', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:chat-message', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('chat:runtime-event', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:channel-status', expect.any(Function));

    handlers.get('gateway:status')?.({ state: 'stopped', port: 18789 });
    expect(useGatewayStore.getState().status.state).toBe('stopped');

    handlers.get('gateway:health')?.({ ok: true, ts: 1 });
    expect(useGatewayStore.getState().health?.openclawHealth).toEqual({ ok: true, ts: 1 });

    handlers.get('gateway:presence')?.([{ mode: 'gateway', ts: 2 }]);
    expect(useGatewayStore.getState().health?.presence).toEqual([{ mode: 'gateway', ts: 2 }]);
  });

  it('propagates gatewayReady field from status events', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789, gatewayReady: false });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    // Initially gatewayReady=false from the status fetch
    expect(useGatewayStore.getState().status.gatewayReady).toBe(false);

    // Simulate gateway.ready event setting gatewayReady=true
    handlers.get('gateway:status')?.({ state: 'running', port: 18789, gatewayReady: true });
    expect(useGatewayStore.getState().status.gatewayReady).toBe(true);
  });

  it('treats undefined gatewayReady as ready for backwards compatibility', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    const status = useGatewayStore.getState().status;
    // gatewayReady is undefined (old gateway version) — should be treated as ready
    expect(status.gatewayReady).toBeUndefined();
    expect(status.state === 'running' && status.gatewayReady !== false).toBe(true);
  });

  it('does not clear chat sending state on non-terminal runtime events', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    const { useManagedAuthStore } = await importRealManagedAuthStore();
    const readyAuthStatus = {
      managed: true,
      hasAuthToken: true,
      hasRelayToken: true,
      authValid: true,
    };
    useManagedAuthStore.setState({
      status: readyAuthStatus,
      initialized: true,
      loading: false,
      verifying: false,
      error: null,
      refreshStatus: vi.fn(async () => readyAuthStatus),
    });

    const { useChatStore } = await importRealChatStore();
    const loadHistory = vi.fn(async () => {});
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main' }],
      sending: true,
      activeRunId: 'run-1',
      pendingFinal: true,
      lastUserMessageAt: 1773281731000,
      loadHistory,
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    handlers.get('chat:runtime-event')?.({
      type: 'tool.completed',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      ts: 1773281731500,
      toolCallId: 'call-1',
      name: 'read',
      result: { summary: 'done' },
      isError: false,
    });
    await flushAsyncImports();
    await flushAsyncImports();

    expect(loadHistory).not.toHaveBeenCalled();
    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().activeRunId).toBe('run-1');
    expect(useChatStore.getState().pendingFinal).toBe(true);
    expect(useChatStore.getState().lastUserMessageAt).toBe(1773281731000);
    expect(useChatStore.getState().streamingTools).toEqual([]);
    expect(useChatStore.getState().runtimeRuns['run-1']?.lastEventAt).toBe(1773281731500);
    expect(useChatStore.getState().runtimeRuns['run-1']?.events).toEqual([
      expect.objectContaining({ type: 'tool.completed', toolCallId: 'call-1', name: 'read' }),
    ]);
  });

  it('stores gate issue and evaluation events without clearing the active send', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    const { useManagedAuthStore } = await importRealManagedAuthStore();
    const readyAuthStatus = {
      managed: true,
      hasAuthToken: true,
      hasRelayToken: true,
      authValid: true,
    };
    useManagedAuthStore.setState({
      status: readyAuthStatus,
      initialized: true,
      loading: false,
      verifying: false,
      error: null,
      refreshStatus: vi.fn(async () => readyAuthStatus),
    });

    const { useChatStore } = await importRealChatStore();
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main' }],
      sending: true,
      activeRunId: 'run-gate-nonterminal',
      pendingFinal: true,
      lastUserMessageAt: 1773281731000,
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    handlers.get('chat:runtime-event')?.({
      type: 'gate.issue',
      runId: 'run-gate-nonterminal',
      sessionKey: 'agent:main:main',
      issue: {
        id: 'issue-1',
        code: 'tool.failed',
        severity: 'blocking',
        title: '工具失败',
        recoverable: true,
      },
    });
    handlers.get('chat:runtime-event')?.({
      type: 'gate.evaluated',
      runId: 'run-gate-nonterminal',
      sessionKey: 'agent:main:main',
      gate: {
        id: 'gate:run-gate-nonterminal:completion',
        decision: 'continue_required',
        artifactCount: 0,
        requiredVerificationCount: 0,
        passedRequiredVerificationCount: 0,
        blockingIssueCount: 1,
        warningIssueCount: 0,
        verificationCoverage: 1,
        issues: [{
          id: 'issue-1',
          code: 'tool.failed',
          severity: 'blocking',
          title: '工具失败',
          recoverable: true,
        }],
      },
    });
    await flushAsyncImports();

    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().activeRunId).toBe('run-gate-nonterminal');
    expect(useChatStore.getState().runtimeRuns['run-gate-nonterminal']?.gateResult).toEqual(expect.objectContaining({
      decision: 'continue_required',
      blockingIssueCount: 1,
    }));
  });

  it('does not let a stale send RPC re-arm a completed run after a newer send starts', async () => {
    let now = 1773281731000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const firstSend = deferred<{ success: boolean; result?: { runId?: string } }>();
    const secondSend = deferred<{ success: boolean; result?: { runId?: string } }>();
    const sendPromises = [firstSend.promise, secondSend.promise];
    hostApiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/chat/send') return sendPromises.shift();
      return Promise.resolve({ success: true, result: {} });
    });

    const { useManagedAuthStore } = await importRealManagedAuthStore();
    const readyAuthStatus = {
      managed: true,
      hasAuthToken: true,
      hasRelayToken: true,
      authValid: true,
    };
    useManagedAuthStore.setState({
      status: readyAuthStatus,
      initialized: true,
      loading: false,
      verifying: false,
      error: null,
      refreshStatus: vi.fn(async () => readyAuthStatus),
    });

    const { useChatStore } = await importRealChatStore();
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sending: false,
      activeRunId: null,
      pendingFinal: false,
      lastUserMessageAt: null,
    });

    const first = useChatStore.getState().sendMessage('first prompt');
    await flushAsyncImports();
    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().lastUserMessageAt).toBe(1773281731000);

    // History/media delivery can prove the first run is complete before the
    // blocking chat.send RPC returns. The composer is then allowed to send a
    // second turn; the late first ack must not overwrite that newer lifecycle.
    useChatStore.setState({
      sending: false,
      activeRunId: null,
      pendingFinal: false,
      lastUserMessageAt: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingToolImages: [],
    });
    now = 1773281732000;
    const second = useChatStore.getState().sendMessage('second prompt');
    await flushAsyncImports();
    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().lastUserMessageAt).toBe(1773281732000);

    firstSend.resolve({ success: true, result: { runId: 'run-first' } });
    await first;
    expect(useChatStore.getState().activeRunId).not.toBe('run-first');
    expect(useChatStore.getState().lastUserMessageAt).toBe(1773281732000);

    secondSend.resolve({ success: true, result: { runId: 'run-second' } });
    await second;
    expect(useChatStore.getState().activeRunId).toBe('run-second');

    nowSpy.mockRestore();
  });

  it('preserves a running session lifecycle when creating a new chat and switching back', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1773281731555);
    const { useChatStore } = await importRealChatStore();
    const loadHistory = vi.fn(async () => {});
    useChatStore.setState({
      currentSessionKey: 'agent:main:a',
      sessions: [{ key: 'agent:main:a' }],
      messages: [{ role: 'user', content: 'run in a' }],
      sending: true,
      activeRunId: 'run-a',
      pendingFinal: false,
      lastUserMessageAt: 1773281731000,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingToolImages: [],
      loadHistory,
    });

    useChatStore.getState().newSession();
    expect(useChatStore.getState().currentSessionKey).toBe('agent:main:session-1773281731555');
    expect(useChatStore.getState().sending).toBe(false);

    useChatStore.getState().switchSession('agent:main:a');

    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().activeRunId).toBe('run-a');
    expect(useChatStore.getState().messages).toEqual([{ role: 'user', content: 'run in a' }]);
    nowSpy.mockRestore();
  });

  it('retains inactive-session runtime events for graph reconstruction after switching back', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    const { useChatStore } = await importRealChatStore();
    const loadHistory = vi.fn(async () => {});
    useChatStore.setState({
      currentSessionKey: 'agent:main:a',
      sessions: [{ key: 'agent:main:a' }, { key: 'agent:main:b' }],
      messages: [{ role: 'user', content: 'run in a' }],
      sending: true,
      activeRunId: 'run-a',
      pendingFinal: false,
      lastUserMessageAt: 1773281731000,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingToolImages: [],
      loadHistory,
    });
    useChatStore.getState().switchSession('agent:main:b');
    await flushAsyncImports();
    loadHistory.mockClear();

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    handlers.get('chat:runtime-event')?.({
      type: 'tool.started',
      runId: 'run-a',
      sessionKey: 'agent:main:a',
      toolCallId: 'call-read',
      name: 'read',
      args: { path: '/tmp/input.txt' },
    });
    await flushAsyncImports();

    expect(useChatStore.getState().currentSessionKey).toBe('agent:main:b');
    expect(useChatStore.getState().runtimeRuns['run-a']?.events).toEqual([
      expect.objectContaining({ type: 'tool.started', toolCallId: 'call-read', name: 'read' }),
    ]);

    useChatStore.getState().switchSession('agent:main:a');

    expect(useChatStore.getState().activeRunId).toBe('run-a');
    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().runtimeRuns['run-a']?.events).toEqual([
      expect.objectContaining({ type: 'tool.started', toolCallId: 'call-read', name: 'read' }),
    ]);
  });

  it('does not apply a session-less final chat event to the foreground task when runId belongs to another session', async () => {
    const { useChatStore } = await importRealChatStore();
    useChatStore.setState({
      currentSessionKey: 'agent:main:a',
      sessions: [{ key: 'agent:main:a' }, { key: 'agent:main:b' }],
      messages: [{ role: 'user', content: 'run in a' }],
      sending: true,
      activeRunId: 'run-a',
      pendingFinal: true,
      lastUserMessageAt: 1773281731000,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingToolImages: [],
      runtimeRuns: {},
    });
    useChatStore.getState().switchSession('agent:main:b');
    useChatStore.setState({
      messages: [{ role: 'user', content: 'run in b' }],
      sending: true,
      activeRunId: 'run-b',
      pendingFinal: true,
      lastUserMessageAt: 1773281732000,
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-a',
      message: { role: 'assistant', content: 'A finished' },
    });

    expect(useChatStore.getState().currentSessionKey).toBe('agent:main:b');
    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().activeRunId).toBe('run-b');
    expect(useChatStore.getState().messages).toEqual([{ role: 'user', content: 'run in b' }]);

    useChatStore.getState().switchSession('agent:main:a');
    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
    expect(useChatStore.getState().messages).toEqual([{ role: 'user', content: 'run in a' }]);
  });

  it('clears cached inactive-session run state when run.ended arrives while another session is selected', async () => {
    hostApiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/chat/sessions') {
        return Promise.resolve({
          success: true,
          result: {
            sessions: [
              { key: 'agent:main:a' },
              { key: 'agent:main:b' },
            ],
          },
        });
      }
      return Promise.resolve({ state: 'running', port: 18789 });
    });
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    const { useChatStore } = await importRealChatStore();
    const loadHistory = vi.fn(async () => {});
    useChatStore.setState({
      currentSessionKey: 'agent:main:a',
      sessions: [{ key: 'agent:main:a' }, { key: 'agent:main:b' }],
      messages: [{ role: 'user', content: 'run in a' }],
      sending: true,
      activeRunId: 'run-a',
      pendingFinal: true,
      lastUserMessageAt: 1773281731000,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingToolImages: [],
      loadHistory,
    });
    useChatStore.getState().switchSession('agent:main:b');
    await flushAsyncImports();
    loadHistory.mockClear();

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    handlers.get('chat:runtime-event')?.({
      type: 'run.ended',
      runId: 'run-a',
      sessionKey: 'agent:main:a',
      status: 'completed',
      endedAt: 1773281732000,
    });
    await flushAsyncImports();

    useChatStore.getState().switchSession('agent:main:a');

    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
    expect(useChatStore.getState().runtimeRuns['run-a']?.status).toBe('completed');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it('clears chat sending state on terminal run.ended runtime event', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    const { useChatStore } = await importRealChatStore();
    const loadHistory = vi.fn(async () => {});
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main' }],
      sending: true,
      activeRunId: 'run-2',
      pendingFinal: true,
      lastUserMessageAt: 1773281731000,
      loadHistory,
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    handlers.get('chat:runtime-event')?.({
      type: 'run.ended',
      runId: 'run-2',
      sessionKey: 'agent:main:main',
      status: 'completed',
      endedAt: 123,
    });
    await flushAsyncImports();

    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
    expect(useChatStore.getState().pendingFinal).toBe(false);
    expect(useChatStore.getState().lastUserMessageAt).toBeNull();
  });

  it('does not clear the active send when a stale run.ended arrives for the same session', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    const { useChatStore } = await importRealChatStore();
    const loadHistory = vi.fn(async () => {});
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main' }],
      sending: true,
      activeRunId: 'run-active',
      pendingFinal: true,
      lastUserMessageAt: 1773281731000,
      loadHistory,
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    handlers.get('chat:runtime-event')?.({
      type: 'run.ended',
      runId: 'run-stale',
      sessionKey: 'agent:main:main',
      status: 'completed',
      endedAt: 123,
    });
    await flushAsyncImports();

    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().activeRunId).toBe('run-active');
    expect(useChatStore.getState().pendingFinal).toBe(true);
    expect(useChatStore.getState().lastUserMessageAt).toBe(1773281731000);
  });

  it('clears the active send when a same-turn continuation run ends successfully', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    const { useChatStore } = await importRealChatStore();
    const loadHistory = vi.fn(async () => {});
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main' }],
      sending: true,
      activeRunId: 'run-main',
      pendingFinal: true,
      lastUserMessageAt: 1773281731000,
      runtimeRuns: {
        'run-main': {
          runId: 'run-main',
          sessionKey: 'agent:main:main',
          status: 'running',
          startedAt: 1773281731000,
          lastEventAt: 1773281731000,
          assistantText: '',
          thinkingText: '',
          events: [{
            type: 'run.started',
            runId: 'run-main',
            sessionKey: 'agent:main:main',
            startedAt: 1773281731000,
            ts: 1773281731000,
          }],
        },
      },
      loadHistory,
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    handlers.get('chat:runtime-event')?.({
      type: 'run.ended',
      runId: 'video_generate:job-1:ok',
      sessionKey: 'agent:main:main',
      status: 'completed',
      endedAt: 1773281733000,
      ts: 1773281733000,
    });
    await flushAsyncImports();

    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
    expect(useChatStore.getState().pendingFinal).toBe(false);
    expect(useChatStore.getState().runtimeRuns['video_generate:job-1:ok']?.gateResult).toEqual(expect.objectContaining({
      decision: 'deliverable',
    }));
  });

  it('ignores session-less runtime terminals that do not match the active run', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    const { useChatStore } = await importRealChatStore();
    const loadHistory = vi.fn(async () => {});
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main' }],
      sending: true,
      activeRunId: 'run-active',
      pendingFinal: true,
      lastUserMessageAt: 1773281731000,
      loadHistory,
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    handlers.get('chat:runtime-event')?.({
      type: 'run.ended',
      runId: 'run-background',
      status: 'completed',
      endedAt: 123,
    });
    await flushAsyncImports();

    expect(loadHistory).not.toHaveBeenCalled();
    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().activeRunId).toBe('run-active');
    expect(useChatStore.getState().pendingFinal).toBe(true);
  });

  it('tracks a current-session run.started even when the optimistic send is already active', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    const { useChatStore } = await importRealChatStore();
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main' }],
      sending: true,
      activeRunId: null,
      pendingFinal: false,
      lastUserMessageAt: 1773281731000,
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    handlers.get('chat:runtime-event')?.({
      type: 'run.started',
      runId: 'run-started-before-rpc-return',
      sessionKey: 'agent:main:main',
      startedAt: 1773281731001,
    });
    await flushAsyncImports();

    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().activeRunId).toBe('run-started-before-rpc-return');
    expect(useChatStore.getState().runtimeRuns['run-started-before-rpc-return']?.planSteps).toEqual([
      expect.objectContaining({ id: 'uclaw.objective', status: 'completed' }),
      expect.objectContaining({ id: 'uclaw.execute', status: 'running' }),
      expect.objectContaining({ id: 'uclaw.verify', status: 'pending' }),
      expect.objectContaining({ id: 'uclaw.deliver', status: 'pending' }),
    ]);
  });

  it('produces artifact and verification runtime events from completed tool outputs', async () => {
    hostApiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/files/thumbnails') {
        return Promise.resolve({
          '/tmp/uclaw-report.pdf': {
            preview: null,
            fileSize: 2048,
            filePath: '/tmp/uclaw-report.pdf',
          },
        });
      }
      return Promise.resolve({ state: 'running', port: 18789 });
    });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    const { useChatStore } = await importRealChatStore();
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main' }],
      sending: true,
      activeRunId: 'run-artifact',
      pendingFinal: true,
      lastUserMessageAt: 1773281731000,
      pendingToolImages: [],
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    handlers.get('chat:runtime-event')?.({
      type: 'tool.completed',
      runId: 'run-artifact',
      sessionKey: 'agent:main:main',
      toolCallId: 'call-create-report',
      name: 'write_report',
      result: { stdout: 'created MEDIA:/tmp/uclaw-report.pdf' },
      isError: false,
    });
    await flushAsyncImports();
    await flushAsyncImports();

    const run = useChatStore.getState().runtimeRuns['run-artifact'];
    expect(run?.artifacts).toEqual([
      expect.objectContaining({
        filePath: '/tmp/uclaw-report.pdf',
        mimeType: 'application/pdf',
        sourceToolCallId: 'call-create-report',
      }),
    ]);
    expect(run?.verifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifactId: run?.artifacts?.[0]?.id,
        kind: 'artifact.registration',
        required: false,
        status: 'passed',
      }),
      expect.objectContaining({
        artifactId: run?.artifacts?.[0]?.id,
        kind: 'artifact.availability',
        required: true,
        status: 'passed',
        evidence: expect.stringContaining('sizeBytes=2048'),
      }),
    ]));
    expect(useChatStore.getState().pendingToolImages).toEqual([
      expect.objectContaining({ filePath: '/tmp/uclaw-report.pdf' }),
    ]);
  });

  it('runs completion gate before holding a completed runtime run with unverified artifacts', async () => {
    hostApiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/files/thumbnails') {
        return Promise.resolve({
          '/tmp/missing-deck.pptx': {
            preview: null,
            fileSize: 0,
          },
        });
      }
      return Promise.resolve({ state: 'running', port: 18789 });
    });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    const { useChatStore } = await importRealChatStore();
    const loadHistory = vi.fn(async () => {});
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main' }],
      sending: true,
      activeRunId: 'run-gate',
      pendingFinal: true,
      lastUserMessageAt: 1773281731000,
      loadHistory,
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    handlers.get('chat:runtime-event')?.({
      type: 'artifact.produced',
      runId: 'run-gate',
      sessionKey: 'agent:main:main',
      artifact: {
        id: 'artifact:deck',
        kind: 'presentation',
        title: 'missing-deck.pptx',
        filePath: '/tmp/missing-deck.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      },
    });
    handlers.get('chat:runtime-event')?.({
      type: 'run.ended',
      runId: 'run-gate',
      sessionKey: 'agent:main:main',
      status: 'completed',
      endedAt: 1773281732000,
    });
    await flushAsyncImports();
    await flushAsyncImports();

    const run = useChatStore.getState().runtimeRuns['run-gate'];
    expect(run?.status).toBe('completed');
    expect(run?.verifications).toEqual([
      expect.objectContaining({
        artifactId: 'artifact:deck',
        status: 'blocked',
      }),
    ]);
    expect(run?.planSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'uclaw.verify', status: 'blocked' }),
      expect.objectContaining({ id: 'uclaw.deliver', status: 'blocked' }),
    ]));
    expect(run?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'verification.required.failed',
        severity: 'blocking',
      }),
    ]));
    expect(run?.gateResult).toEqual(expect.objectContaining({
      decision: 'continue_required',
      blockingIssueCount: 1,
      requiredVerificationCount: 1,
      passedRequiredVerificationCount: 0,
    }));
    expect(run?.checkpoints).toEqual([
      expect.objectContaining({
        id: 'checkpoint:run-gate:completion-gate',
        recoverable: true,
      }),
    ]);
    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().activeRunId).toBe('run-gate');
    expect(useChatStore.getState().pendingFinal).toBe(true);
  });

  it('holds completed composite runs when any required-artifact subtask is missing output', async () => {
    hostApiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/files/thumbnails') {
        return Promise.resolve({
          '/tmp/image.png': {
            preview: null,
            fileSize: 1024,
            filePath: '/tmp/image.png',
          },
        });
      }
      return Promise.resolve({ state: 'running', port: 18789 });
    });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    const { useChatStore } = await importRealChatStore();
    const loadHistory = vi.fn(async () => {});
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main' }],
      sending: true,
      activeRunId: 'run-composite-gate',
      pendingFinal: true,
      lastUserMessageAt: 1773281731000,
      loadHistory,
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    handlers.get('chat:runtime-event')?.({
      type: 'run.plan.updated',
      runId: 'run-composite-gate',
      sessionKey: 'agent:main:main',
      objective: '生成图片和 PPT',
      steps: [
        { id: 'task:image', title: '生成图片', status: 'completed', requiresArtifact: true, order: 1 },
        { id: 'task:ppt', title: '生成 PPT', status: 'completed', requiresArtifact: true, order: 2 },
      ],
    });
    handlers.get('chat:runtime-event')?.({
      type: 'artifact.produced',
      runId: 'run-composite-gate',
      sessionKey: 'agent:main:main',
      artifact: {
        id: 'artifact:image',
        kind: 'image',
        title: '图片',
        filePath: '/tmp/image.png',
        sourceToolCallId: 'task:image',
      },
    });
    handlers.get('chat:runtime-event')?.({
      type: 'verification.completed',
      runId: 'run-composite-gate',
      sessionKey: 'agent:main:main',
      verification: {
        id: 'verify-image',
        status: 'passed',
        artifactId: 'artifact:image',
      },
    });
    handlers.get('chat:runtime-event')?.({
      type: 'run.ended',
      runId: 'run-composite-gate',
      sessionKey: 'agent:main:main',
      status: 'completed',
      endedAt: 1773281732000,
    });
    await flushAsyncImports();
    await flushAsyncImports();

    const run = useChatStore.getState().runtimeRuns['run-composite-gate'];
    expect(run?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'artifact.required.missing',
        stepId: 'task:ppt',
      }),
    ]));
    expect(run?.gateResult).toEqual(expect.objectContaining({
      decision: 'continue_required',
      artifactCount: 1,
      blockingIssueCount: 1,
    }));
    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().activeRunId).toBe('run-composite-gate');
  });

  it('forces a terminal history reload when the runtime emits run.ended', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    const { useChatStore } = await importRealChatStore();
    const loadHistory = vi.fn(async () => {});
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main' }],
      sending: true,
      activeRunId: 'run-terminal-refresh',
      pendingFinal: true,
      lastUserMessageAt: 1773281731000,
      loadHistory,
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    handlers.get('chat:runtime-event')?.({
      type: 'tool.completed',
      runId: 'run-terminal-refresh',
      sessionKey: 'agent:main:main',
      toolCallId: 'call-2',
      name: 'grep',
      result: { summary: 'done' },
      isError: false,
    });
    await flushAsyncImports();
    handlers.get('chat:runtime-event')?.({
      type: 'run.ended',
      runId: 'run-terminal-refresh',
      sessionKey: 'agent:main:main',
      status: 'completed',
      endedAt: 456,
    });
    await flushAsyncImports();

    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
  });

  it('surfaces reply session init conflicts that arrive after chat.send ack as run errors', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    const { useChatStore } = await importRealChatStore();
    const loadHistory = vi.fn(async () => {});
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main' }],
      sending: true,
      activeRunId: 'run-conflict',
      pendingFinal: true,
      lastUserMessageAt: 1773281731000,
      loadHistory,
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    handlers.get('gateway:chat-message')?.({
      message: {
        state: 'error',
        runId: 'run-conflict',
        sessionKey: 'agent:main:main',
        errorMessage: 'Error: reply session initialization conflicted for agent:main:main',
      },
    });
    await flushAsyncImports();

    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
    expect(useChatStore.getState().error).toBeNull();
    expect(useChatStore.getState().runError).toContain('reply session handoff conflict');
  });

  it('forwards normalized chat runtime events through the dedicated host event channel', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await importRealChatStore();
    const handleRuntimeEvent = vi.fn();
    const loadHistory = vi.fn(async () => {});
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main' }],
      activeRunId: 'run-runtime',
      handleRuntimeEvent,
      loadHistory,
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    handlers.get('chat:runtime-event')?.({
      type: 'tool.started',
      runId: 'run-runtime',
      sessionKey: 'agent:main:main',
      toolCallId: 'call-1',
      name: 'read',
      args: { filePath: '/tmp/demo.md' },
    });
    await flushAsyncImports();

    expect(handleRuntimeEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool.started',
      runId: 'run-runtime',
      toolCallId: 'call-1',
    }));
    expect(loadHistory).not.toHaveBeenCalled();

    handlers.get('chat:runtime-event')?.({
      type: 'run.ended',
      runId: 'run-runtime',
      sessionKey: 'agent:main:main',
      status: 'completed',
      endedAt: 123,
    });
    await flushAsyncImports();

    expect(handleRuntimeEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run.ended',
      runId: 'run-runtime',
      status: 'completed',
    }));
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it('passes progressive delta notifications without seq through to chat store', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await importRealChatStore();
    const handleChatEvent = vi.fn();
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main' }],
      handleChatEvent,
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    handlers.get('gateway:chat-message')?.({
      message: {
        runId: 'run-no-seq',
        sessionKey: 'agent:main:main',
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
      },
    });
    handlers.get('gateway:chat-message')?.({
      message: {
        runId: 'run-no-seq',
        sessionKey: 'agent:main:main',
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'first second' }] },
      },
    });
    await flushAsyncImports();

    expect(handleChatEvent).toHaveBeenCalledTimes(2);
    expect(handleChatEvent.mock.calls[0]?.[0]).toMatchObject({
      runId: 'run-no-seq',
      state: 'delta',
      message: { content: [{ text: 'first' }] },
    });
    expect(handleChatEvent.mock.calls[1]?.[0]).toMatchObject({
      runId: 'run-no-seq',
      state: 'delta',
      message: { content: [{ text: 'first second' }] },
    });
  });

  it('dedupes exact replayed delta notifications without seq', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await importRealChatStore();
    const handleChatEvent = vi.fn();
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main' }],
      handleChatEvent,
    });

    const { useGatewayStore } = await importRealGatewayStore();
    await useGatewayStore.getState().init();

    const replayedDelta = {
      message: {
        runId: 'run-no-seq-replay',
        sessionKey: 'agent:main:main',
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'same' }] },
      },
    };

    handlers.get('gateway:chat-message')?.(replayedDelta);
    handlers.get('gateway:chat-message')?.(replayedDelta);
    await flushAsyncImports();

    expect(handleChatEvent).toHaveBeenCalledTimes(1);
  });
});
