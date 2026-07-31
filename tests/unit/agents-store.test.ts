import { beforeEach, describe, expect, it, vi } from 'vitest';

const agentsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  generateProfile: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateModel: vi.fn(),
  delete: vi.fn(),
  assignChannel: vi.fn(),
  removeChannel: vi.fn(),
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: { agents: agentsApiMock },
}));

import { useAgentsStore } from '@/stores/agents';

const profile = {
  roleName: 'Research',
  personaName: 'Atlas',
  responsibility: 'Research work',
  capabilities: ['Research'],
  boundaries: ['No fabrication'],
  workspaceInstructions: 'Verify sources.',
  welcomeMessage: 'Ready to research.',
  avatarId: 'analyst',
};

describe('agents store profile management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentsStore.setState({
      agents: [],
      defaultAgentId: 'main',
      defaultModelRef: null,
      configuredChannelTypes: [],
      channelOwners: {},
      channelAccountOwners: {},
      loading: false,
      error: null,
    });
  });

  it('forwards profile generation through the typed Host API', async () => {
    agentsApiMock.generateProfile.mockResolvedValue({ success: true, profile });

    await expect(useAgentsStore.getState().generateAgentProfile({
      roleName: 'Research',
      responsibility: 'Research work',
      avatarId: 'analyst',
      locale: 'zh-CN',
    })).resolves.toEqual(profile);
  });

  it('returns the Agent identified by createdAgentId after creation', async () => {
    const createdAgent = {
      id: 'atlas',
      name: 'Atlas',
      isDefault: false,
      modelDisplay: 'gpt-5',
      inheritedModel: true,
      workspace: '~/.openclaw/workspace-atlas',
      agentDir: '~/.openclaw/agents/atlas/agent',
      mainSessionKey: 'agent:atlas:main',
      channelTypes: [],
      profile: { ...profile, createdAt: '2026-07-31T00:00:00.000Z', updatedAt: '2026-07-31T00:00:00.000Z' },
    };
    agentsApiMock.create.mockResolvedValue({
      agents: [createdAgent],
      defaultAgentId: 'main',
      configuredChannelTypes: [],
      channelOwners: {},
      channelAccountOwners: {},
      createdAgentId: 'atlas',
    });

    await expect(useAgentsStore.getState().createAgent('Atlas', {
      inheritWorkspace: true,
      profile,
    })).resolves.toEqual(createdAgent);
    expect(agentsApiMock.create).toHaveBeenCalledWith({
      name: 'Atlas',
      inheritWorkspace: true,
      profile,
    });
  });
});
