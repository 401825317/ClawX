import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Agents } from '../../src/pages/Agents/index';
import { clearChannelsAccountsCacheForTests } from '@/pages/Channels/channel-accounts-cache';
import { toast } from 'sonner';

const hostApiFetchMock = vi.fn();
const subscribeHostEventMock = vi.fn();
const fetchAgentsMock = vi.fn();
const updateAgentMock = vi.fn();
const updateAgentModelMock = vi.fn();
const createAgentMock = vi.fn();
const generateAgentProfileMock = vi.fn();
const refreshProviderSnapshotMock = vi.fn();
const switchSessionMock = vi.fn();
const loadSessionsMock = vi.fn();

const { gatewayState, agentsState, providersState, chatState } = vi.hoisted(() => ({
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
  chatState: {
    sessions: [] as Array<Record<string, unknown>>,
    currentSessionKey: 'agent:main:main',
    currentAgentId: 'main',
    sending: false,
    activeRunId: null as string | null,
    pendingFinal: false,
    runtimeRuns: {} as Record<string, Record<string, unknown>>,
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
  useChatStore: (selector: (state: typeof chatState & {
    switchSession: typeof switchSessionMock;
    loadSessions: typeof loadSessionsMock;
  }) => unknown) => selector({
    ...chatState,
    switchSession: switchSessionMock,
    loadSessions: loadSessionsMock,
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
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: (...args: unknown[]) => subscribeHostEventMock(...args),
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

function renderAgents() {
  return render(
    <MemoryRouter>
      <Agents />
    </MemoryRouter>,
  );
}

describe('Agents page status refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearChannelsAccountsCacheForTests();
    gatewayState.status = { state: 'running', port: 18789 };
    agentsState.agents = [];
    agentsState.defaultModelRef = null;
    providersState.accounts = [];
    providersState.statuses = [];
    providersState.vendors = [];
    providersState.defaultAccountId = '';
    chatState.sessions = [];
    chatState.currentSessionKey = 'agent:main:main';
    chatState.currentAgentId = 'main';
    chatState.sending = false;
    chatState.activeRunId = null;
    chatState.pendingFinal = false;
    chatState.runtimeRuns = {};
    loadSessionsMock.mockResolvedValue(undefined);
    fetchAgentsMock.mockResolvedValue(undefined);
    updateAgentMock.mockResolvedValue(undefined);
    updateAgentModelMock.mockResolvedValue(undefined);
    createAgentMock.mockResolvedValue(null);
    generateAgentProfileMock.mockResolvedValue({
      roleName: 'Research',
      personaName: 'Research Agent',
      responsibility: 'Research work',
      capabilities: [],
      boundaries: [],
      workspaceInstructions: '',
      welcomeMessage: '',
      avatarId: 'analyst',
    });
    refreshProviderSnapshotMock.mockResolvedValue(undefined);
    hostApiFetchMock.mockResolvedValue({
      success: true,
      channels: [],
    });
  });

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
      expect(fetchAgentsMock).toHaveBeenCalledWith({ quiet: false });
      expect(loadSessionsMock).not.toHaveBeenCalled();
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/channels/accounts?mode=config');
    });
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:channel-status', expect.any(Function));

    await act(async () => {
      channelStatusHandler?.();
    });

    const channelFetchCalls = hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/channels/accounts?mode=config');
    expect(channelFetchCalls).toHaveLength(1);
  });

  it('defers channel account refresh while chat work is active', async () => {
    chatState.sending = true;
    let channelStatusHandler: (() => void) | undefined;
    subscribeHostEventMock.mockImplementation((eventName: string, handler: () => void) => {
      if (eventName === 'gateway:channel-status') {
        channelStatusHandler = handler;
      }
      return vi.fn();
    });

    const { rerender } = render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>,
    );

    expect(hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/channels/accounts?mode=config')).toHaveLength(0);

    await act(async () => {
      channelStatusHandler?.();
    });

    expect(hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/channels/accounts?mode=config')).toHaveLength(0);

    chatState.sending = false;
    await act(async () => {
      rerender(
        <MemoryRouter>
          <Agents />
        </MemoryRouter>,
      );
    });

    await waitFor(() => {
      expect(hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/channels/accounts?mode=config')).toHaveLength(1);
    });
  });

  it('refetches channel accounts when the gateway transitions to running after mount', async () => {
    gatewayState.status = { state: 'starting', port: 18789 };

    const { rerender } = render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(fetchAgentsMock).toHaveBeenCalledWith({ quiet: false });
      expect(loadSessionsMock).not.toHaveBeenCalled();
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/channels/accounts?mode=config');
    });

    gatewayState.status = { state: 'running', port: 18789 };
    await act(async () => {
      rerender(
        <MemoryRouter>
          <Agents />
        </MemoryRouter>,
      );
    });

    const channelFetchCalls = hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/channels/accounts?mode=config');
    expect(channelFetchCalls).toHaveLength(1);
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
      expect(fetchAgentsMock).toHaveBeenCalledWith({ quiet: true });
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

  it('opens the selected agent main session from the agent card', async () => {
    agentsState.agents = [
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
    ];

    renderAgents();

    await waitFor(() => {
      expect(fetchAgentsMock).toHaveBeenCalledWith({ quiet: true });
    });

    fireEvent.click(screen.getByRole('button', { name: 'openChatWithAgent' }));

    expect(switchSessionMock).toHaveBeenCalledWith('agent:research:main');
  });

  it('does not turn post-create session open failures into create failures', async () => {
    createAgentMock.mockResolvedValue({
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
    });
    switchSessionMock.mockImplementation(() => {
      throw new Error('RPC timeout: chat.history');
    });

    renderAgents();

    fireEvent.click(screen.getByTestId('agents-add-button'));
    fireEvent.change(screen.getByTestId('agent-create-role-name'), { target: { value: 'Research' } });
    fireEvent.change(screen.getByTestId('agent-create-responsibility'), { target: { value: 'Research work' } });
    await waitFor(() => {
      expect(screen.getByTestId('agent-create-submit')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('agent-create-submit'));

    await waitFor(() => {
      expect(generateAgentProfileMock).toHaveBeenCalledTimes(1);
      expect(createAgentMock).toHaveBeenCalledTimes(1);
    });
    expect(toast.success).toHaveBeenCalledWith('toast.agentCreated');
    expect(toast.error).not.toHaveBeenCalledWith(
      'toast.agentCreateFailed',
      expect.anything(),
    );
    expect(screen.queryByTestId('agent-create-dialog')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(switchSessionMock).toHaveBeenCalledWith('agent:research:main');
    });
    expect(toast.error).not.toHaveBeenCalledWith(
      'toast.agentCreateFailed',
      expect.anything(),
    );
  });

  it('shows per-agent work status from chat sessions', async () => {
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
    ];
    chatState.sessions = [
      { key: 'agent:research:main', status: 'running', hasActiveRun: true },
      { key: 'agent:main:main', status: 'completed', hasActiveRun: false },
    ];

    renderAgents();

    expect(await screen.findByText('workStatus.running')).toBeInTheDocument();
    expect(screen.getByText('workStatus.completed')).toBeInTheDocument();
  });

  it('does not keep an agent running from a stale runtime run', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1773281731000);
    agentsState.agents = [
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
    ];
    chatState.runtimeRuns = {
      'run-stale': {
        runId: 'run-stale',
        sessionKey: 'agent:research:main',
        status: 'running',
        startedAt: 1773281431000,
        lastEventAt: 1773281431000,
        assistantText: '',
        thinkingText: '',
        events: [],
      },
    };

    renderAgents();

    expect(await screen.findByText('Research')).toBeInTheDocument();
    expect(screen.queryByText('workStatus.running')).not.toBeInTheDocument();
    expect(screen.getByText('workStatus.completed')).toBeInTheDocument();
    nowSpy.mockRestore();
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

    const { rerender } = render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>,
    );

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

  it('keeps the page interactive while the initial refresh is pending', async () => {
    agentsState.loading = true;
    fetchAgentsMock.mockImplementation(() => new Promise(() => {}));
    refreshProviderSnapshotMock.mockImplementation(() => new Promise(() => {}));
    hostApiFetchMock.mockImplementation(() => new Promise(() => {}));

    renderAgents();

    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'refresh' })).toBeInTheDocument();
    expect(screen.getByTestId('agents-add-button')).toBeInTheDocument();
  });
});
