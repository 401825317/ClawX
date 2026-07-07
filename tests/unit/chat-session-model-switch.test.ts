import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { gatewayRpcMock, hostApiFetchMock, agentsState } = vi.hoisted(() => ({
  gatewayRpcMock: vi.fn(),
  hostApiFetchMock: vi.fn(),
  agentsState: {
    agents: [] as Array<Record<string, unknown>>,
    defaultModelRef: null as string | null,
  },
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      rpc: gatewayRpcMock,
    }),
  },
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => agentsState,
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

describe('chat session model switching', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    window.localStorage.clear();

    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'model-alpha',
        modelRef: 'custom-alpha123/model-alpha',
        overrideModelRef: 'custom-alpha123/model-alpha',
        inheritedModel: false,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    agentsState.defaultModelRef = 'custom-alpha123/model-alpha';

    gatewayRpcMock.mockReset();
    hostApiFetchMock.mockReset();

    gatewayRpcMock.mockImplementation(async (method: string) => {
      if (method === 'chat.history') {
        return { messages: [] };
      }
      if (method === 'sessions.list') {
        return { sessions: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    hostApiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/chat/sessions') {
        return { success: true, result: { sessions: [] } };
      }
      throw new Error(`Unexpected host API call: ${url}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates only the targeted session model via sessions.patch', async () => {
    gatewayRpcMock.mockImplementation(async (method: string, _params?: unknown) => {
      if (method === 'sessions.patch') {
        return {
          ok: true,
          key: 'agent:main:session-a',
          entry: {},
          resolved: {
            modelProvider: 'custom-beta5678',
            model: 'model-beta',
          },
        };
      }
      if (method === 'chat.history') {
        return { messages: [] };
      }
      if (method === 'sessions.list') {
        return { sessions: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:session-a',
      currentAgentId: 'main',
      sessions: [
        { key: 'agent:main:session-a', model: 'custom-alpha123/model-alpha' },
        { key: 'agent:main:session-b', model: 'custom-alpha123/model-alpha' },
      ],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().updateSessionModel('agent:main:session-a', 'custom-beta5678/model-beta');

    expect(gatewayRpcMock).toHaveBeenCalledWith('sessions.patch', {
      key: 'agent:main:session-a',
      model: 'custom-beta5678/model-beta',
    });

    const sessions = useChatStore.getState().sessions;
    expect(sessions.find((session) => session.key === 'agent:main:session-a')?.model).toBe('custom-beta5678/model-beta');
    expect(sessions.find((session) => session.key === 'agent:main:session-b')?.model).toBe('custom-alpha123/model-alpha');
  });

  it('applies the selected session model optimistically and rolls back on persistence failure', async () => {
    let rejectPatch!: (reason?: unknown) => void;
    gatewayRpcMock.mockImplementation((method: string) => {
      if (method === 'sessions.patch') {
        return new Promise((_resolve, reject) => {
          rejectPatch = reject;
        });
      }
      if (method === 'chat.history') {
        return Promise.resolve({ messages: [] });
      }
      if (method === 'sessions.list') {
        return Promise.resolve({ sessions: [] });
      }
      return Promise.reject(new Error(`Unexpected gateway RPC: ${method}`));
    });

    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:session-a',
      currentAgentId: 'main',
      sessions: [
        { key: 'agent:main:session-a', model: 'custom-alpha123/model-alpha' },
        { key: 'agent:main:session-b', model: 'custom-alpha123/model-alpha' },
      ],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
    });

    const pendingUpdate = useChatStore.getState()
      .updateSessionModel('agent:main:session-a', 'custom-beta5678/model-beta');

    expect(useChatStore.getState().sessions.find((session) => session.key === 'agent:main:session-a')?.model)
      .toBe('custom-beta5678/model-beta');
    expect(useChatStore.getState().sessions.find((session) => session.key === 'agent:main:session-b')?.model)
      .toBe('custom-alpha123/model-alpha');

    rejectPatch(new Error('patch failed'));
    await expect(pendingUpdate).rejects.toThrow('patch failed');

    expect(useChatStore.getState().sessions.find((session) => session.key === 'agent:main:session-a')?.model)
      .toBe('custom-alpha123/model-alpha');
  });

  it('creates a pending local session before persisting its model override', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main', model: 'custom-alpha123/model-alpha' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
    });

    useChatStore.getState().newSession();
    const newSessionKey = useChatStore.getState().currentSessionKey;

    gatewayRpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.create') {
        return {
          ok: true,
          key: newSessionKey,
          entry: {
            providerOverride: 'custom-beta5678',
            modelOverride: 'model-beta',
            updatedAt: Date.now(),
          },
        };
      }
      if (method === 'chat.history') {
        return { messages: [] };
      }
      if (method === 'sessions.list') {
        return { sessions: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    await useChatStore.getState().updateSessionModel(newSessionKey, 'custom-beta5678/model-beta');

    expect(gatewayRpcMock).toHaveBeenCalledWith('sessions.create', {
      key: newSessionKey,
      agentId: 'main',
      model: 'custom-beta5678/model-beta',
    });
    expect(useChatStore.getState().sessions.find((session) => session.key === newSessionKey)?.model).toBe('custom-beta5678/model-beta');

    await useChatStore.getState().loadSessions();

    expect(useChatStore.getState().sessions.find((session) => session.key === newSessionKey)?.model).toBe('custom-beta5678/model-beta');
  });

  it('keeps the newer local session model when a stale sessions.list row arrives later', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:session-b',
      currentAgentId: 'main',
      sessions: [
        { key: 'agent:main:session-b', model: 'custom-beta5678/model-beta', updatedAt: 2_000_000_000_000 },
      ],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
    });

    hostApiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/chat/sessions') {
        return {
          success: true,
          result: {
            sessions: [
              {
                key: 'agent:main:session-b',
                modelProvider: 'custom-alpha123',
                model: 'model-alpha',
                updatedAt: 1_000_000_000_000,
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected host API call: ${url}`);
    });

    await useChatStore.getState().loadSessions();

    const session = useChatStore.getState().sessions.find((entry) => entry.key === 'agent:main:session-b');
    expect(session?.model).toBe('custom-beta5678/model-beta');
    expect(session?.updatedAt).toBe(2_000_000_000_000);
  });

  it('normalizes sessions.list modelProvider + model into a full model ref', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:session-b',
      currentAgentId: 'main',
      sessions: [],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
    });

    hostApiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/chat/sessions') {
        return {
          success: true,
          result: {
            sessions: [
              {
                key: 'agent:main:session-b',
                modelProvider: 'custom-beta5678',
                model: 'provider/model-beta',
                updatedAt: 3000,
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected host API call: ${url}`);
    });

    await useChatStore.getState().loadSessions();

    expect(useChatStore.getState().sessions.find((entry) => entry.key === 'agent:main:session-b')?.model)
      .toBe('custom-beta5678/provider/model-beta');
  });

  it('self-heals stale managed session models to the client-config text default', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:session-a',
      currentAgentId: 'main',
      sessions: [
        { key: 'agent:main:session-a', model: 'lingzhiwuxian/gpt-5.5' },
        { key: 'agent:main:session-b', model: 'custom-alpha123/model-alpha' },
      ],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
    });

    useChatStore.getState().healManagedTextModels();

    expect(useChatStore.getState().sessions.find((entry) => entry.key === 'agent:main:session-a')?.model)
      .toBe('lingzhiwuxian/smart-latest');
    expect(useChatStore.getState().sessions.find((entry) => entry.key === 'agent:main:session-b')?.model)
      .toBe('custom-alpha123/model-alpha');
  });

  it('repairs a stale managed model before sending a chat request', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'gpt-5.5',
        modelRef: 'lingzhiwuxian/gpt-5.5',
        overrideModelRef: 'lingzhiwuxian/gpt-5.5',
        inheritedModel: false,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    agentsState.defaultModelRef = 'lingzhiwuxian/gpt-5.5';

    gatewayRpcMock.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'sessions.patch') {
        return {
          ok: true,
          key: 'agent:main:main',
          entry: {},
          resolved: {
            modelProvider: 'lingzhiwuxian',
            model: 'smart-latest',
          },
        };
      }
      if (method === 'chat.history') {
        return { messages: [] };
      }
      if (method === 'sessions.list') {
        return { sessions: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method} ${JSON.stringify(params)}`);
    });

    hostApiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/chat/send') {
        return { success: true, result: { runId: 'run-1' } };
      }
      if (url === '/api/chat/sessions') {
        return { success: true, result: { sessions: [] } };
      }
      throw new Error(`Unexpected host API call: ${url}`);
    });

    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main', model: 'lingzhiwuxian/gpt-5.5' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage('hello');

    expect(gatewayRpcMock).toHaveBeenCalledWith('sessions.patch', {
      key: 'agent:main:main',
      model: 'lingzhiwuxian/smart-latest',
    });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/chat/send', expect.objectContaining({
      method: 'POST',
    }));
    expect(useChatStore.getState().sessions.find((entry) => entry.key === 'agent:main:main')?.model)
      .toBe('lingzhiwuxian/smart-latest');
  });
});
