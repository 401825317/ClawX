import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeStatus = {
  state: 'running',
  port: 18789,
  connectedAt: 0,
};

const { gatewayRpcMock } = vi.hoisted(() => ({
  gatewayRpcMock: vi.fn(),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      status: runtimeStatus,
      rpc: gatewayRpcMock,
    }),
  },
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => ({ agents: [] }),
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn().mockResolvedValue({ success: true, summaries: [] }),
}));

describe('chat store loadSessions startup selection', () => {
  beforeEach(() => {
    vi.resetModules();
    gatewayRpcMock.mockReset();
    runtimeStatus.connectedAt = Date.now();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens the latest non-cron session instead of a cron heartbeat session', async () => {
    gatewayRpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              key: 'agent:main:cron:heartbeat',
              label: 'Main Agent heartbeat',
              updatedAt: 9_000,
            },
            {
              key: 'agent:main:session-a',
              displayName: 'PDF summary',
              updatedAt: 5_000,
            },
          ],
        };
      }
      if (method === 'chat.history') {
        return { messages: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
    });

    await useChatStore.getState().loadSessions();

    expect(useChatStore.getState().currentSessionKey).toBe('agent:main:session-a');
  });

  it('clears the prior conversation when loadSessions retargets to another session', async () => {
    gatewayRpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              key: 'agent:main:cron:heartbeat',
              label: 'Main Agent heartbeat',
              updatedAt: 9_000,
            },
            {
              key: 'agent:main:session-b',
              displayName: 'Other chat',
              updatedAt: 5_000,
            },
          ],
        };
      }
      if (method === 'chat.history') {
        return { messages: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [],
      messages: [{ role: 'user', content: 'question from another chat' }],
      sessionLabels: {},
      sessionLastActivity: {},
    });

    await useChatStore.getState().loadSessions();

    expect(useChatStore.getState().currentSessionKey).toBe('agent:main:session-b');
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it('keeps the default main ghost session when only cron sessions exist', async () => {
    gatewayRpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              key: 'agent:main:cron:heartbeat',
              label: 'Main Agent heartbeat',
              updatedAt: 9_000,
            },
          ],
        };
      }
      if (method === 'chat.history') {
        return { messages: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
    });

    await useChatStore.getState().loadSessions();

    expect(useChatStore.getState().currentSessionKey).toBe('agent:main:main');
    expect(useChatStore.getState().sessions.some((session) => session.key === 'agent:main:main')).toBe(true);
  });

  it('hides internal agent profile generation sessions from the sidebar state', async () => {
    gatewayRpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              key: 'agent:main:uclaw-profile-20260626-temp123',
              displayName: '0723e8d3 (2026-06-26)',
              updatedAt: 9_000,
            },
            {
              key: 'agent:uclaw3d:main',
              displayName: 'UClaw 3D 建模助手',
              updatedAt: 8_000,
            },
          ],
        };
      }
      if (method === 'chat.history') {
        return { messages: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:uclaw3d:main',
      currentAgentId: 'uclaw3d',
      sessions: [],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
    });

    await useChatStore.getState().loadSessions();

    expect(useChatStore.getState().sessions.map((session) => session.key)).toEqual(['agent:uclaw3d:main']);
  });

  it('closes a stuck lifecycle when sessions.list says the current run already failed', async () => {
    const lastUserAt = 1_783_630_000_000;
    const sessionUpdatedAt = 1_783_630_005_000;
    gatewayRpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              key: 'agent:main:session-failed',
              displayName: 'Interrupted chat',
              updatedAt: sessionUpdatedAt,
              status: 'failed',
              hasActiveRun: false,
            },
          ],
        };
      }
      if (method === 'chat.history') {
        return { messages: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:session-failed',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:session-failed' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: 'run-stuck',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: lastUserAt,
      pendingToolImages: [],
      runtimeRuns: {
        'run-stuck': {
          runId: 'run-stuck',
          sessionKey: 'agent:main:session-failed',
          status: 'running',
          startedAt: lastUserAt,
          lastEventAt: sessionUpdatedAt - 1_000,
          assistantText: '',
          thinkingText: '',
          events: [],
        },
      },
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().loadSessions();

    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    expect(state.runtimeRuns['run-stuck']).toEqual(expect.objectContaining({
      status: 'error',
      endedAt: sessionUpdatedAt,
    }));
  });
});
