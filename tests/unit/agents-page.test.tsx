import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Agents } from '../../src/pages/Agents/index';

const channelsAccountsMock = vi.fn();
const subscribeHostEventMock = vi.fn();
const fetchAgentsMock = vi.fn();
const updateAgentMock = vi.fn();
const updateAgentModelMock = vi.fn();
const createAgentMock = vi.fn();
const generateAgentProfileMock = vi.fn();
const refreshProviderSnapshotMock = vi.fn();
const switchSessionMock = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const { gatewayState, agentsState, providersState } = vi.hoisted(() => ({
  gatewayState: {
    status: { state: 'running', port: 18789 },
  },
  agentsState: {
    agents: [] as Array<Record<string, unknown>>,
    defaultModelRef: null as string | null,
    loading: false,
    error: null as string | null,
  },
  providersState: {
    accounts: [] as Array<Record<string, unknown>>,
    statuses: [] as Array<Record<string, unknown>>,
    vendors: [] as Array<Record<string, unknown>>,
    defaultAccountId: '' as string,
  },
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: (selector?: (state: typeof agentsState & {
    fetchAgents: typeof fetchAgentsMock;
    updateAgent: typeof updateAgentMock;
    updateAgentModel: typeof updateAgentModelMock;
    createAgent: typeof createAgentMock;
    generateAgentProfile: typeof generateAgentProfileMock;
    deleteAgent: ReturnType<typeof vi.fn>;
  }) => unknown) => {
    const state = {
      ...agentsState,
      fetchAgents: fetchAgentsMock,
      updateAgent: updateAgentMock,
      updateAgentModel: updateAgentModelMock,
      createAgent: createAgentMock,
      generateAgentProfile: generateAgentProfileMock,
      deleteAgent: vi.fn(),
    };
    return typeof selector === 'function' ? selector(state) : state;
  },
}));

vi.mock('@/stores/chat', () => ({
  useChatStore: (selector: (state: { switchSession: typeof switchSessionMock }) => unknown) => selector({
    switchSession: switchSessionMock,
  }),
}));

vi.mock('@/stores/providers', () => ({
  useProviderStore: (selector: (state: typeof providersState & {
    refreshProviderSnapshot: typeof refreshProviderSnapshotMock;
  }) => unknown) => {
    const state = {
      ...providersState,
      refreshProviderSnapshot: refreshProviderSnapshotMock,
    };
    return selector(state);
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    channels: {
      accounts: (...args: unknown[]) => channelsAccountsMock(...args),
    },
  },
}));

vi.mock('@/lib/host-events', () => ({
  hostEvents: {
    onGatewayChannelStatus: (handler: unknown) => subscribeHostEventMock('gateway:channel-status', handler),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

describe('Agents page status refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gatewayState.status = { state: 'running', port: 18789 };
    agentsState.agents = [];
    agentsState.defaultModelRef = null;
    agentsState.loading = false;
    agentsState.error = null;
    providersState.accounts = [];
    providersState.statuses = [];
    providersState.vendors = [];
    providersState.defaultAccountId = '';
    fetchAgentsMock.mockResolvedValue(undefined);
    updateAgentMock.mockResolvedValue(undefined);
    updateAgentModelMock.mockResolvedValue(undefined);
    createAgentMock.mockResolvedValue({
      id: 'research',
      name: 'Research Agent',
      isDefault: false,
      modelDisplay: 'gpt-5',
      inheritedModel: true,
      workspace: '~/.openclaw/workspace-research',
      agentDir: '~/.openclaw/agents/research/agent',
      mainSessionKey: 'agent:research:main',
      channelTypes: [],
    });
    generateAgentProfileMock.mockResolvedValue({
      roleName: 'Research',
      personaName: 'Research Agent',
      responsibility: 'Research work',
      capabilities: ['Research'],
      boundaries: ['No fabrication'],
      workspaceInstructions: 'Verify sources.',
      welcomeMessage: 'Ready to research.',
      avatarId: 'strategist',
    });
    refreshProviderSnapshotMock.mockResolvedValue(undefined);
    channelsAccountsMock.mockResolvedValue({
      success: true,
      channels: [],
    });
  });

  function renderAgents() {
    return render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>,
    );
  }

  it('refetches channel accounts when gateway channel-status events arrive', async () => {
    let channelStatusHandler: (() => void) | undefined;
    subscribeHostEventMock.mockImplementation((eventName: string, handler: () => void) => {
      if (eventName === 'gateway:channel-status') {
        channelStatusHandler = handler;
      }
      return vi.fn();
    });

    renderAgents();

    await waitFor(() => {
      expect(fetchAgentsMock).toHaveBeenCalledTimes(1);
      expect(channelsAccountsMock).toHaveBeenCalledWith();
    });
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:channel-status', expect.any(Function));

    await act(async () => {
      channelStatusHandler?.();
    });

    await waitFor(() => {
      expect(channelsAccountsMock).toHaveBeenCalledTimes(2);
    });
  });

  it('refetches channel accounts when the gateway transitions to running after mount', async () => {
    gatewayState.status = { state: 'starting', port: 18789 };

    const { rerender } = renderAgents();

    await waitFor(() => {
      expect(fetchAgentsMock).toHaveBeenCalledTimes(1);
      expect(channelsAccountsMock).toHaveBeenCalledWith();
    });

    gatewayState.status = { state: 'running', port: 18789 };
    await act(async () => {
      rerender(
        <MemoryRouter>
          <Agents />
        </MemoryRouter>,
      );
    });

    await waitFor(() => {
      expect(channelsAccountsMock).toHaveBeenCalledTimes(2);
    });
  });

  it('does not render the legacy gateway warning during transient stopped status', async () => {
    gatewayState.status = { state: 'stopped', port: 18789 };

    renderAgents();

    await waitFor(() => {
      expect(fetchAgentsMock).toHaveBeenCalledTimes(1);
    });

    expect(screen.queryByText('gatewayWarning')).not.toBeInTheDocument();
  });

  it('uses "Use default model" as form fill only and disables it when already default', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'claude-opus-4.6',
        modelRef: 'openrouter/anthropic/claude-opus-4.6',
        overrideModelRef: null,
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:desk',
        channelTypes: [],
      },
    ];
    agentsState.defaultModelRef = 'openrouter/anthropic/claude-opus-4.6';
    providersState.accounts = [
      {
        id: 'openrouter-default',
        label: 'OpenRouter',
        vendorId: 'openrouter',
        authMode: 'api_key',
        model: 'openrouter/anthropic/claude-opus-4.6',
        enabled: true,
        createdAt: '2026-03-24T00:00:00.000Z',
        updatedAt: '2026-03-24T00:00:00.000Z',
      },
    ];
    providersState.statuses = [{ id: 'openrouter-default', hasKey: true }];
    providersState.vendors = [
      { id: 'openrouter', name: 'OpenRouter', modelIdPlaceholder: 'anthropic/claude-opus-4.6' },
    ];
    providersState.defaultAccountId = 'openrouter-default';

    renderAgents();

    await waitFor(() => {
      expect(fetchAgentsMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByTitle('settings'));
    fireEvent.click(screen.getByText('settingsDialog.modelLabel').closest('button') as HTMLButtonElement);

    const useDefaultButton = await screen.findByRole('button', { name: 'settingsDialog.useDefaultModel' });
    const modelIdInput = screen.getByLabelText('settingsDialog.modelIdLabel');
    const saveButton = screen.getByRole('button', { name: 'common:actions.save' });

    expect(useDefaultButton).toBeDisabled();

    fireEvent.change(modelIdInput, { target: { value: 'anthropic/claude-sonnet-4.5' } });
    expect(useDefaultButton).toBeEnabled();
    expect(saveButton).toBeEnabled();

    fireEvent.click(useDefaultButton);

    expect(updateAgentModelMock).not.toHaveBeenCalled();
    expect((modelIdInput as HTMLInputElement).value).toBe('anthropic/claude-opus-4.6');
    expect(useDefaultButton).toBeDisabled();
  });

  it('keeps the last agent snapshot visible while a refresh is in flight', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'gpt-5',
        modelRef: 'openai/gpt-5',
        overrideModelRef: null,
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];

    const { rerender } = renderAgents();

    expect(await screen.findByText('Main')).toBeInTheDocument();

    agentsState.loading = true;
    await act(async () => {
      rerender(
        <MemoryRouter>
          <Agents />
        </MemoryRouter>,
      );
    });

    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps the blocking spinner during the initial load before any stable snapshot exists', async () => {
    agentsState.loading = true;
    fetchAgentsMock.mockImplementation(() => new Promise(() => {}));
    refreshProviderSnapshotMock.mockImplementation(() => new Promise(() => {}));
    channelsAccountsMock.mockImplementation(() => new Promise(() => {}));

    const { container } = renderAgents();

    expect(container.querySelector('svg.animate-spin')).toBeTruthy();
    expect(screen.queryByText('title')).not.toBeInTheDocument();
  });

  it('generates a profile from required fields and preserves the selected avatar', async () => {
    renderAgents();

    fireEvent.click(screen.getByTestId('agents-add-button'));
    const submit = screen.getByTestId('agent-create-submit');
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId('agent-create-role-name'), { target: { value: 'Research' } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId('agent-create-responsibility'), { target: { value: 'Research work' } });
    fireEvent.click(screen.getByTestId('agent-create-avatar-analyst'));
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);

    await waitFor(() => {
      expect(generateAgentProfileMock).toHaveBeenCalledWith({
        roleName: 'Research',
        responsibility: 'Research work',
        avatarId: 'analyst',
        locale: 'zh-CN',
      });
      expect(createAgentMock).toHaveBeenCalledWith('Research Agent', {
        inheritWorkspace: false,
        profile: expect.objectContaining({ avatarId: 'analyst' }),
      });
    });
  });

  it('keeps entered values when profile generation fails', async () => {
    generateAgentProfileMock.mockRejectedValueOnce(new Error('generation failed'));
    renderAgents();

    fireEvent.click(screen.getByTestId('agents-add-button'));
    const roleInput = screen.getByTestId('agent-create-role-name');
    const responsibilityInput = screen.getByTestId('agent-create-responsibility');
    fireEvent.change(roleInput, { target: { value: 'Writer' } });
    fireEvent.change(responsibilityInput, { target: { value: 'Write launch copy' } });
    fireEvent.click(screen.getByTestId('agent-create-submit'));

    await waitFor(() => {
      expect(generateAgentProfileMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('agent-create-dialog')).toBeInTheDocument();
    });
    expect(roleInput).toHaveValue('Writer');
    expect(responsibilityInput).toHaveValue('Write launch copy');
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it('prevents closing the dialog while profile generation is running', async () => {
    const pendingProfile = deferred<never>();
    generateAgentProfileMock.mockReturnValueOnce(pendingProfile.promise);
    renderAgents();

    fireEvent.click(screen.getByTestId('agents-add-button'));
    fireEvent.change(screen.getByTestId('agent-create-role-name'), { target: { value: 'Writer' } });
    fireEvent.change(screen.getByTestId('agent-create-responsibility'), { target: { value: 'Write launch copy' } });
    fireEvent.click(screen.getByTestId('agent-create-submit'));

    const closeButton = screen.getByTestId('agent-create-close');
    await waitFor(() => expect(closeButton).toBeDisabled());
    fireEvent.click(closeButton);
    expect(screen.getByTestId('agent-create-dialog')).toBeInTheDocument();

    await act(async () => {
      pendingProfile.reject(new Error('generation failed'));
    });
    await waitFor(() => expect(closeButton).not.toBeDisabled());
  });

  it('renders profile details and opens the Agent main session from its card', async () => {
    agentsState.agents = [{
      id: 'research',
      name: 'Research Agent',
      isDefault: false,
      modelDisplay: 'gpt-5',
      inheritedModel: true,
      workspace: '~/.openclaw/workspace-research',
      agentDir: '~/.openclaw/agents/research/agent',
      mainSessionKey: 'agent:research:main',
      channelTypes: [],
      profile: {
        roleName: 'Research lead',
        personaName: 'Atlas',
        responsibility: 'Find and verify primary sources.',
        capabilities: [],
        boundaries: [],
        workspaceInstructions: '',
        welcomeMessage: '',
        avatarId: 'analyst',
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:00.000Z',
      },
    }];

    renderAgents();

    expect(await screen.findByText('Atlas')).toBeInTheDocument();
    expect(screen.getByText('Find and verify primary sources.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agent-card-research'));

    expect(switchSessionMock).toHaveBeenCalledWith('agent:research:main');
  });
});
