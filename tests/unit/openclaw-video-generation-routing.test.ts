import { beforeEach, describe, expect, it, vi } from 'vitest';

const readOpenClawConfigMock = vi.fn();
const listAgentsSnapshotMock = vi.fn();
const getProviderApiKeyFromOpenClawMock = vi.fn();
const readOpenAiCompatibleVideoRelayStateMock = vi.fn();
const syncOpenAiCompatibleVideoRelayMock = vi.fn();
const getProviderSecretMock = vi.fn();
const generateVideoInProcessMock = vi.fn();

vi.mock('@electron/utils/channel-config', () => ({
  readOpenClawConfig: (...args: unknown[]) => readOpenClawConfigMock(...args),
  writeOpenClawConfig: vi.fn(),
}));

vi.mock('@electron/utils/config-mutex', () => ({
  withConfigLock: async (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@electron/utils/agent-config', () => ({
  listAgentsSnapshot: (...args: unknown[]) => listAgentsSnapshotMock(...args),
}));

vi.mock('@electron/utils/openclaw-auth', () => ({
  getOAuthTokenFromOpenClaw: vi.fn(),
  getProviderApiKeyFromOpenClaw: (...args: unknown[]) => getProviderApiKeyFromOpenClawMock(...args),
  readOpenAiCompatibleVideoRelayState: (...args: unknown[]) => readOpenAiCompatibleVideoRelayStateMock(...args),
  syncOpenAiCompatibleVideoRelay: (...args: unknown[]) => syncOpenAiCompatibleVideoRelayMock(...args),
}));

vi.mock('@electron/utils/paths', () => ({
  expandPath: (value: string) => value,
  expandOpenClawPath: (value: string) => value,
}));

vi.mock('@electron/services/secrets/secret-store', () => ({
  getProviderSecret: (...args: unknown[]) => getProviderSecretMock(...args),
}));

vi.mock('@electron/utils/junfeiai-distribution', () => ({
  getJunFeiAIDefaultBaseUrl: () => 'https://zz-cn.lingzhiwuxian.com/v1',
  JUNFEIAI_PROVIDER_ID: 'lingzhiwuxian',
}));

vi.mock('@electron/utils/openclaw-video-generation-runtime', () => ({
  generateVideoInProcess: (...args: unknown[]) => generateVideoInProcessMock(...args),
  listVideoGenerationProvidersInProcess: vi.fn(),
}));

describe('generateVideoForChatSession routing', () => {
  beforeEach(() => {
    vi.resetModules();
    readOpenClawConfigMock.mockReset();
    listAgentsSnapshotMock.mockReset();
    getProviderApiKeyFromOpenClawMock.mockReset();
    readOpenAiCompatibleVideoRelayStateMock.mockReset();
    syncOpenAiCompatibleVideoRelayMock.mockReset();
    getProviderSecretMock.mockReset();
    generateVideoInProcessMock.mockReset();

    readOpenClawConfigMock.mockResolvedValue({
      agents: {
        defaults: {
          videoGenerationModel: {
            primary: 'openai/grok-image-video',
            timeoutMs: 600_000,
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
            modelIds: ['grok-image-video', 'grok-video-1.5'],
          },
        },
      },
    });
    listAgentsSnapshotMock.mockResolvedValue({
      agents: [{
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: '智能路由',
        modelRef: null,
        overrideModelRef: null,
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      }],
      defaultAgentId: 'main',
      defaultModelRef: null,
      configuredChannelTypes: [],
      channelOwners: {},
      channelAccountOwners: {},
    });
    readOpenAiCompatibleVideoRelayStateMock.mockReturnValue({
      enabled: true,
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      providerKey: 'openai',
    });
    getProviderSecretMock.mockResolvedValue({
      type: 'api_key',
      accountId: 'lingzhiwuxian',
      apiKey: 'relay-key',
    });
    generateVideoInProcessMock.mockResolvedValue({
      ok: true,
      capability: 'video.generate',
      transport: 'local',
      provider: 'openai',
      model: 'grok-video-1.5',
      attempts: [],
      outputs: [],
      ignoredOverrides: [],
    });
  });

  it('uses grok-video-1.5 for reference images even when a stale text-video model is passed', async () => {
    const { generateVideoForChatSession } = await import('@electron/utils/openclaw-video-generation');

    await generateVideoForChatSession({
      sessionKey: 'agent:main:main',
      prompt: 'animate this frame',
      model: 'openai/grok-image-video',
      inputImages: [{ filePath: '/tmp/frame.png', mimeType: 'image/png', fileName: 'frame.png' }],
    });

    expect(generateVideoInProcessMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openai/grok-video-1.5',
      inputImages: [expect.objectContaining({ filePath: '/tmp/frame.png' })],
    }));
  });

  it('uses grok-image-video for text-only video even when a stale image-video model is passed', async () => {
    const { generateVideoForChatSession } = await import('@electron/utils/openclaw-video-generation');

    await generateVideoForChatSession({
      sessionKey: 'agent:main:main',
      prompt: 'make a text video',
      model: 'openai/grok-video-1.5',
    });

    expect(generateVideoInProcessMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openai/grok-image-video',
      inputImages: [],
    }));
  });
});
