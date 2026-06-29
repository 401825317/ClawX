import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalPlatform = process.platform;

const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(),
}));

vi.mock('child_process', () => ({
  exec: mockExec,
  default: {
    exec: mockExec,
  },
}));

vi.mock('@electron/utils/agent-config', () => ({
  assignChannelToAgent: vi.fn(),
  clearChannelBinding: vi.fn(),
  createAgent: vi.fn(),
  deleteAgentConfig: vi.fn(),
  listAgentsSnapshot: vi.fn(),
  removeAgentWorkspaceDirectory: vi.fn(),
  resolveAccountIdForAgent: vi.fn(),
  updateAgentModel: vi.fn(),
  updateAgentName: vi.fn(),
}));

vi.mock('@electron/utils/channel-config', () => ({
  deleteChannelAccountConfig: vi.fn(),
}));

vi.mock('@electron/services/providers/provider-runtime-sync', () => ({
  getOpenClawProviderKey: vi.fn((type: string, id: string) => type === 'custom' ? id : type),
  normalizeProviderModelRef: vi.fn((_provider: { model?: string }, runtimeProviderKey: string, modelRef?: string) => (
    modelRef === 'lingzhiwuxian/qwen-latest'
      ? 'lingzhiwuxian/smart-latest'
      : modelRef || `${runtimeProviderKey}/smart-latest`
  )),
  syncAllProviderAuthToRuntime: vi.fn(() => Promise.resolve()),
  syncAgentModelOverrideToRuntime: vi.fn(),
}));

vi.mock('@electron/utils/secure-storage', () => ({
  getAllProviders: vi.fn(() => Promise.resolve([])),
  getDefaultProvider: vi.fn(() => Promise.resolve(undefined)),
  getProvider: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@electron/utils/openclaw-workspace', () => ({
  ensureClawXContext: vi.fn(),
}));

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock('@electron/utils/chat-session-cleanup', () => ({
  deleteLocalChatSession: vi.fn(() => Promise.resolve()),
}));

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, writable: true });
}

describe('restartGatewayForAgentDeletion', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    mockExec.mockImplementation((_cmd: string, _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      cb(null, '');
      return {} as never;
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  it('uses taskkill tree strategy on Windows when gateway pid is known', async () => {
    setPlatform('win32');
    const { restartGatewayForAgentDeletion } = await import('@electron/api/routes/agents');

    const restart = vi.fn().mockResolvedValue(undefined);
    const getStatus = vi.fn(() => ({ pid: 4321, port: 18789 }));

    await restartGatewayForAgentDeletion({
      gatewayManager: {
        getStatus,
        restart,
      },
    } as never);

    expect(mockExec).toHaveBeenCalledWith(
      'taskkill /F /PID 4321 /T',
      expect.any(Function),
    );
    expect(restart).toHaveBeenCalledTimes(1);
  });
});

describe('handleAgentRoutes model updates', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  it.each(['linux', 'darwin', 'win32'])(
    'updates model config without gateway reload or restart on %s',
    async (platform) => {
      setPlatform(platform);
      const routeUtils = await import('@electron/api/route-utils');
      const agentConfig = await import('@electron/utils/agent-config');
      const runtimeSync = await import('@electron/services/providers/provider-runtime-sync');
      const { handleAgentRoutes } = await import('@electron/api/routes/agents');

      vi.mocked(routeUtils.parseJsonBody).mockResolvedValue({ modelRef: 'custom-alpha/model-alpha' });
      vi.mocked(agentConfig.updateAgentModel).mockResolvedValue({
        agents: [],
        defaultAgentId: 'main',
        defaultModelRef: 'custom-alpha/model-alpha',
        configuredChannelTypes: [],
        channelOwners: {},
        channelAccountOwners: {},
      });
      vi.mocked(runtimeSync.syncAllProviderAuthToRuntime).mockResolvedValue(undefined);
      vi.mocked(runtimeSync.syncAgentModelOverrideToRuntime).mockResolvedValue(undefined);

      const gatewayManager = {
        getStatus: vi.fn(() => ({ state: 'running', pid: 1234, port: 18789 })),
        debouncedReload: vi.fn(),
        debouncedRestart: vi.fn(),
        restart: vi.fn(),
      };

      const handled = await handleAgentRoutes(
        { method: 'PUT' } as never,
        {} as never,
        new URL('http://127.0.0.1/api/agents/main/model'),
        { gatewayManager } as never,
      );

      expect(handled).toBe(true);
      expect(agentConfig.updateAgentModel).toHaveBeenCalledWith('main', 'custom-alpha/model-alpha');
      expect(runtimeSync.syncAllProviderAuthToRuntime).toHaveBeenCalledTimes(1);
      expect(runtimeSync.syncAgentModelOverrideToRuntime).toHaveBeenCalledWith('main');
      expect(gatewayManager.debouncedReload).not.toHaveBeenCalled();
      expect(gatewayManager.debouncedRestart).not.toHaveBeenCalled();
      expect(gatewayManager.restart).not.toHaveBeenCalled();
      expect(routeUtils.sendJson).toHaveBeenCalledWith(
        {},
        200,
        expect.objectContaining({ success: true }),
      );
    },
  );
});

describe('handleAgentRoutes agent creation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  it('returns the created snapshot before running post-create gateway work', async () => {
    const routeUtils = await import('@electron/api/route-utils');
    const agentConfig = await import('@electron/utils/agent-config');
    const runtimeSync = await import('@electron/services/providers/provider-runtime-sync');
    const workspace = await import('@electron/utils/openclaw-workspace');
    const { handleAgentRoutes } = await import('@electron/api/routes/agents');

    vi.mocked(routeUtils.parseJsonBody).mockResolvedValue({
      name: 'Research',
      inheritWorkspace: true,
      profile: { personaName: 'Research' },
    });
    vi.mocked(agentConfig.createAgent).mockResolvedValue({
      agents: [
        {
          id: 'research',
          name: 'Research',
          isDefault: false,
          modelDisplay: 'gpt-5',
          modelRef: 'openai/gpt-5',
          overrideModelRef: null,
          inheritedModel: false,
          workspace: '~/.openclaw/workspace-research',
          agentDir: '~/.openclaw/agents/research/agent',
          mainSessionKey: 'agent:research:main',
          channelTypes: [],
        },
      ],
      defaultAgentId: 'main',
      defaultModelRef: 'openai/gpt-5',
      configuredChannelTypes: [],
      channelOwners: {},
      channelAccountOwners: {},
      createdAgentId: 'research',
    });
    vi.mocked(runtimeSync.syncAllProviderAuthToRuntime).mockResolvedValue(undefined);
    vi.mocked(workspace.ensureClawXContext).mockResolvedValue(undefined);

    const gatewayManager = {
      getStatus: vi.fn(() => ({ state: 'running', pid: 1234, port: 18789 })),
      debouncedReload: vi.fn(),
    };

    const handled = await handleAgentRoutes(
      { method: 'POST' } as never,
      {} as never,
      new URL('http://127.0.0.1/api/agents'),
      { gatewayManager } as never,
    );

    expect(handled).toBe(true);
    expect(agentConfig.createAgent).toHaveBeenCalledWith('Research', {
      inheritWorkspace: true,
      profile: { personaName: 'Research' },
    });
    expect(routeUtils.sendJson).toHaveBeenCalledWith(
      {},
      200,
      expect.objectContaining({
        success: true,
        createdAgentId: 'research',
      }),
    );
    expect(runtimeSync.syncAllProviderAuthToRuntime).not.toHaveBeenCalled();
    expect(gatewayManager.debouncedReload).not.toHaveBeenCalled();
    expect(workspace.ensureClawXContext).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(runtimeSync.syncAllProviderAuthToRuntime).toHaveBeenCalledTimes(1);
    expect(gatewayManager.debouncedReload).toHaveBeenCalledTimes(1);
    expect(workspace.ensureClawXContext).toHaveBeenCalledWith({ waitForAllConfiguredWorkspaces: true });
  });
});

describe('handleAgentRoutes profile generation', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();
    const runtimeSync = await import('@electron/services/providers/provider-runtime-sync');
    vi.mocked(runtimeSync.syncAllProviderAuthToRuntime).mockResolvedValue(undefined);
  });

  it('uses a local fallback profile when chat.history times out', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const routeUtils = await import('@electron/api/route-utils');
      const { handleAgentRoutes } = await import('@electron/api/routes/agents');

      vi.mocked(routeUtils.parseJsonBody).mockResolvedValue({
        roleName: 'Research',
        responsibility: 'Research work',
        avatarId: 'strategist',
        locale: 'en-US',
      });

      const gatewayManager = {
        rpc: vi.fn(async (method: string) => {
          if (method === 'chat.send') return { runId: 'run-1' };
          if (method === 'chat.history') throw new Error('RPC timeout: chat.history');
          if (method === 'chat.abort') return {};
          throw new Error(`Unexpected rpc method ${method}`);
        }),
      };

      const handledPromise = handleAgentRoutes(
        { method: 'POST' } as never,
        {} as never,
        new URL('http://127.0.0.1/api/agents/generate-profile'),
        { gatewayManager } as never,
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      const handled = await handledPromise;

      expect(handled).toBe(true);
      expect(gatewayManager.rpc).toHaveBeenCalledWith(
        'chat.history',
        expect.objectContaining({
          sessionKey: expect.stringMatching(/^agent:main:uclaw-profile-/),
          limit: 20,
          maxChars: 80_000,
        }),
        6_000,
      );
      expect(gatewayManager.rpc).toHaveBeenCalledWith(
        'chat.abort',
        expect.objectContaining({
          sessionKey: expect.stringMatching(/^agent:main:uclaw-profile-/),
        }),
        15_000,
      );
      expect(routeUtils.sendJson).toHaveBeenCalledWith(
        {},
        200,
        {
          success: true,
          profile: expect.objectContaining({
            roleName: 'Research',
            personaName: 'Research',
            responsibility: 'Research work',
            avatarId: 'strategist',
          }),
        },
      );
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('surfaces assistant errorMessage instead of reporting invalid JSON', async () => {
    const routeUtils = await import('@electron/api/route-utils');
    const { handleAgentRoutes } = await import('@electron/api/routes/agents');

    vi.mocked(routeUtils.parseJsonBody).mockResolvedValue({
      roleName: '营销专家',
      responsibility: '帮我处理营销内容',
      avatarId: 'strategist',
      locale: 'zh-CN',
    });

    const gatewayManager = {
      rpc: vi.fn(async (method: string) => {
        if (method === 'chat.send') return { runId: 'run-1' };
        if (method === 'chat.history') {
          return {
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'text', text: '[assistant turn failed before producing content]' }],
                stopReason: 'error',
                errorMessage: '503 No available channel for model qwen-latest under group default',
              },
            ],
          };
        }
        if (method === 'chat.abort') return {};
        throw new Error(`Unexpected rpc method ${method}`);
      }),
    };

    const handled = await handleAgentRoutes(
      { method: 'POST' } as never,
      {} as never,
      new URL('http://127.0.0.1/api/agents/generate-profile'),
      { gatewayManager } as never,
    );

    expect(handled).toBe(true);
    expect(routeUtils.sendJson).toHaveBeenCalledWith(
      {},
      500,
      {
        success: false,
        error: '503 No available channel for model qwen-latest under group default',
      },
    );
  });

  it('sets a normalized temporary session model before generating a profile', async () => {
    vi.useFakeTimers();
    try {
      const routeUtils = await import('@electron/api/route-utils');
      const agentConfig = await import('@electron/utils/agent-config');
      const secureStorage = await import('@electron/utils/secure-storage');
      const runtimeSync = await import('@electron/services/providers/provider-runtime-sync');
      const { handleAgentRoutes } = await import('@electron/api/routes/agents');

      vi.mocked(routeUtils.parseJsonBody).mockResolvedValue({
        roleName: 'Research',
        responsibility: 'Research work',
        avatarId: 'strategist',
        locale: 'en-US',
      });
      vi.mocked(agentConfig.listAgentsSnapshot).mockResolvedValue({
        agents: [],
        defaultAgentId: 'main',
        defaultModelRef: 'lingzhiwuxian/qwen-latest',
        configuredChannelTypes: [],
        channelOwners: {},
        channelAccountOwners: {},
      });
      vi.mocked(secureStorage.getDefaultProvider).mockResolvedValue('lingzhiwuxian');
      vi.mocked(secureStorage.getProvider).mockResolvedValue({
        id: 'lingzhiwuxian',
        name: '零至无限',
        type: 'lingzhiwuxian',
        model: 'qwen-latest',
        baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
        metadata: {
          managedDefaultModel: 'smart-latest',
          managedAllowedModels: ['smart-latest'],
        },
        enabled: true,
        createdAt: '2026-06-29T00:00:00.000Z',
        updatedAt: '2026-06-29T00:00:00.000Z',
      } as never);
      vi.mocked(runtimeSync.syncAllProviderAuthToRuntime).mockResolvedValue(undefined);
      vi.mocked(runtimeSync.normalizeProviderModelRef).mockReturnValue('lingzhiwuxian/smart-latest');

      const gatewayManager = {
        rpc: vi.fn(async (method: string) => {
          if (method === 'sessions.create') return {};
          if (method === 'chat.send') return { runId: 'run-1' };
          if (method === 'chat.history') {
            return {
              messages: [
                {
                  role: 'assistant',
                  content: [{
                    type: 'text',
                    text: JSON.stringify({
                      roleName: 'Research',
                      personaName: 'Research',
                      responsibility: 'Research work',
                      capabilities: ['Plan research', 'Summarize findings', 'Review sources'],
                      boundaries: ['Ask when scope is unclear'],
                      welcomeMessage: 'Ready.',
                      workspaceInstructions: 'You are Research.',
                    }),
                  }],
                },
              ],
            };
          }
          if (method === 'sessions.list') {
            return { sessions: [{ key: expect.any(String), status: 'idle', hasActiveRun: false }] };
          }
          if (method === 'chat.abort') return {};
          throw new Error(`Unexpected rpc method ${method}`);
        }),
      };

      const handledPromise = handleAgentRoutes(
        { method: 'POST' } as never,
        {} as never,
        new URL('http://127.0.0.1/api/agents/generate-profile'),
        { gatewayManager } as never,
      );

      await vi.advanceTimersByTimeAsync(1_000);
      const handled = await handledPromise;

      expect(handled).toBe(true);
      expect(runtimeSync.syncAllProviderAuthToRuntime).toHaveBeenCalledTimes(1);
      expect(gatewayManager.rpc).toHaveBeenCalledWith(
        'sessions.create',
        expect.objectContaining({
          key: expect.stringMatching(/^agent:main:uclaw-profile-/),
          agentId: 'main',
          model: 'lingzhiwuxian/smart-latest',
        }),
        15_000,
      );
      expect(gatewayManager.rpc).toHaveBeenCalledWith(
        'chat.send',
        expect.objectContaining({
          sessionKey: expect.stringMatching(/^agent:main:uclaw-profile-/),
        }),
        expect.any(Number),
      );
      expect(routeUtils.sendJson).toHaveBeenCalledWith(
        {},
        200,
        expect.objectContaining({ success: true }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
