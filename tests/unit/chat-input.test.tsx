import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatInput } from '@/pages/Chat/ChatInput';
import { TooltipProvider } from '@/components/ui/tooltip';
const hostApiFetchMock = vi.hoisted(() => vi.fn());
const hostApiDialogOpenMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const { agentsState, chatState, gatewayState, providersState, managedClientConfigState, artifactPanelMocks } = vi.hoisted(() => ({
  agentsState: {
    agents: [] as Array<Record<string, unknown>>,
    defaultModelRef: null as string | null,
  },
  chatState: {
    currentAgentId: 'main',
    currentSessionKey: 'agent:main:main',
    sessions: [] as Array<Record<string, unknown>>,
    pendingSessionModelUpdates: {} as Record<string, boolean>,
    updateSessionModel: vi.fn(),
    waitForSessionModelUpdate: vi.fn(),
  },
  gatewayState: {
    status: { state: 'running', port: 18789 },
  },
  providersState: {
    accounts: [] as Array<Record<string, unknown>>,
    statuses: [] as Array<Record<string, unknown>>,
    defaultAccountId: null as string | null,
    error: null as string | null,
    refreshProviderSnapshot: vi.fn(),
  },
  managedClientConfigState: {
    textModelPolicy: {
      defaultModel: 'smart-latest',
      models: [
        { id: 'smart-latest', label: 'Smart' },
        { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      ],
    },
    initialized: true,
    loading: false,
    loadTextModels: vi.fn(),
  },
  artifactPanelMocks: {
    openPreview: vi.fn(),
  },
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

vi.mock('@/stores/chat', () => ({
  useChatStore: (selector: (state: typeof chatState) => unknown) => selector(chatState),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/stores/providers', () => ({
  useProviderStore: (selector: (state: typeof providersState) => unknown) => selector(providersState),
}));

vi.mock('@/stores/managed-client-config', () => ({
  useManagedClientConfigStore: (selector: (state: typeof managedClientConfigState) => unknown) => (
    selector(managedClientConfigState)
  ),
}));

vi.mock('@/stores/artifact-panel', () => ({
  useArtifactPanel: (selector: (state: typeof artifactPanelMocks) => unknown) => selector(artifactPanelMocks),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: hostApiFetchMock,
  hostApi: {
    files: {
      stagePaths: (input: unknown) => hostApiFetchMock('/api/files/stage-paths', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
      stageBuffer: (input: unknown) => hostApiFetchMock('/api/files/stage-buffer', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    },
    skills: {
      quickAccess: (input: unknown) => hostApiFetchMock('/api/skills/quick-access', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    },
    dialog: {
      open: hostApiDialogOpenMock,
    },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
  },
}));

function translate(key: string, vars?: Record<string, unknown>): string {
  switch (key) {
    case 'composer.attachFiles':
      return 'Attach files';
    case 'composer.pickSkill':
      return 'Choose skill';
    case 'composer.skillButton':
      return 'Skill';
    case 'composer.skillPickerTitle':
      return `Quick skill access for ${String(vars?.agent ?? '')}`;
    case 'composer.skillSearchPlaceholder':
      return 'Search skills';
    case 'composer.skillLoading':
      return 'Loading skills...';
    case 'composer.skillEmpty':
      return 'No matching skills found';
    case 'composer.pickAgent':
      return 'Choose agent';
    case 'composer.clearTarget':
      return 'Clear target agent';
    case 'composer.targetChip':
      return `@${String(vars?.agent ?? '')}`;
    case 'composer.agentPickerTitle':
      return 'Route the next message to another agent';
    case 'composer.gatewayDisconnectedPlaceholder':
      return 'Gateway not connected...';
    case 'composer.send':
      return 'Send';
    case 'composer.stop':
      return 'Stop';
    case 'composer.thinking':
      return 'Thinking…';
    case 'imageGeneration.generating':
      return 'Generating image, please wait…';
    case 'composer.gatewayConnected':
      return 'connected';
    case 'composer.gatewayStarting':
      return 'starting';
    case 'composer.gatewayStatus':
      return `gateway ${String(vars?.state ?? '')} | port: ${String(vars?.port ?? '')} ${String(vars?.pid ?? '')}`.trim();
    case 'composer.retryFailedAttachments':
      return 'Retry failed attachments';
    case 'composer.workspacePrefix':
      return String(vars?.workspace ?? '');
    case 'composer.defaultWorkspaceOption':
      return 'Default workspace';
    case 'composer.chooseOtherWorkspaceOption':
      return 'Choose another folder...';
    case 'composer.workspacePickerTitle':
      return 'Select workspace folder';
    case 'composer.workspacePickerButton':
      return 'Use workspace';
    case 'composer.workspacePickerFailed':
      return 'Could not open workspace picker';
    case 'composer.skillPreviewTooltip':
      return 'Preview SKILL.md';
    case 'composer.skillPreviewNotFound':
      return 'Skill not found';
    default:
      return key;
  }
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translate,
  }),
}));

function renderChatInput(onSend = vi.fn()) {
  return render(
    <TooltipProvider>
      <ChatInput onSend={onSend} />
    </TooltipProvider>,
  );
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function configureAgentAndModelPickers() {
  const now = '2025-01-01T00:00:00.000Z';
  agentsState.agents = [
    {
      id: 'main',
      name: 'Main',
      isDefault: true,
      modelDisplay: 'MiniMax',
      modelRef: 'openai/smart-latest',
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
      modelDisplay: 'Claude',
      inheritedModel: false,
      workspace: '~/.openclaw/workspace-research',
      agentDir: '~/.openclaw/agents/research/agent',
      mainSessionKey: 'agent:research:desk',
      channelTypes: [],
    },
  ];
  agentsState.defaultModelRef = 'custom-aaaaaaaa/gpt-a';
  chatState.sessions = [{ key: chatState.currentSessionKey, model: 'openai/smart-latest' }];
  providersState.accounts = [
    {
      id: 'aaaaaaaa',
      vendorId: 'custom',
      label: 'Alpha',
      authMode: 'api_key',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'custom-aaaaaaaa/gpt-a',
      enabled: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'bbbbbbbb',
      vendorId: 'custom',
      label: 'Beta',
      authMode: 'api_key',
      baseUrl: 'http://127.0.0.1:2/v1',
      model: 'custom-bbbbbbbb/gpt-b',
      enabled: true,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    },
  ];
  providersState.statuses = [
    { id: 'aaaaaaaa', name: 'Alpha', type: 'custom', hasKey: true, keyMasked: 'sk-***', enabled: true, createdAt: now, updatedAt: now },
    { id: 'bbbbbbbb', name: 'Beta', type: 'custom', hasKey: true, keyMasked: 'sk-***', enabled: true, createdAt: now, updatedAt: now },
  ];
  providersState.defaultAccountId = 'aaaaaaaa';
  vi.mocked(hostApiFetchMock).mockResolvedValue({ success: true, skills: [] });
}

describe('ChatInput agent targeting', () => {
  beforeEach(() => {
    agentsState.agents = [];
    agentsState.defaultModelRef = null;
    chatState.currentAgentId = 'main';
    chatState.currentSessionKey = 'agent:main:main';
    chatState.sessions = [];
    chatState.pendingSessionModelUpdates = {};
    chatState.updateSessionModel.mockReset();
    chatState.updateSessionModel.mockResolvedValue(undefined);
    chatState.waitForSessionModelUpdate.mockReset();
    chatState.waitForSessionModelUpdate.mockResolvedValue(undefined);
    gatewayState.status = { state: 'running', port: 18789 };
    providersState.accounts = [];
    providersState.statuses = [];
    providersState.defaultAccountId = null;
    providersState.error = null;
    providersState.refreshProviderSnapshot.mockReset();
    managedClientConfigState.textModelPolicy = {
      defaultModel: 'smart-latest',
      models: [
        { id: 'smart-latest', label: 'Smart' },
        { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      ],
    };
    managedClientConfigState.initialized = true;
    managedClientConfigState.loadTextModels.mockReset();
    managedClientConfigState.loadTextModels.mockResolvedValue(managedClientConfigState.textModelPolicy);
    vi.mocked(hostApiFetchMock).mockReset();
    vi.mocked(hostApiDialogOpenMock).mockReset();
    toastErrorMock.mockReset();
    artifactPanelMocks.openPreview.mockReset();
  });

  it('renders a dot pulse and visible thinking label while a message is sending', () => {
    render(
      <TooltipProvider>
        <ChatInput onSend={vi.fn()} sending />
      </TooltipProvider>,
    );

    const indicator = screen.getByRole('status', { name: 'Thinking…' });
    expect(indicator).toHaveAttribute('data-testid', 'chat-composer-working-indicator');
    expect(indicator).toHaveTextContent('Thinking…');
    expect(indicator).toHaveAttribute('aria-label', 'Thinking…');
    expect(indicator).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('chat-composer-dot-pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-composer-zoomies')).not.toBeInTheDocument();
  });

  it('shows an image-generation indicator without locking the composer for background work', () => {
    render(
      <TooltipProvider>
        <ChatInput onSend={vi.fn()} imageGenerating />
      </TooltipProvider>,
    );

    const indicator = screen.getByRole('status', { name: 'Generating image, please wait…' });
    expect(indicator).toHaveAttribute('data-testid', 'chat-composer-image-generation-indicator');
    expect(screen.queryByTestId('chat-composer-working-indicator')).not.toBeInTheDocument();
    const input = screen.getByTestId('chat-composer-input');
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: 'Queue this after the image' } });
    expect(screen.getByTestId('chat-composer-send')).toBeDisabled();
  });

  it('keeps the existing thinking indicator while sending even when image generation has started', () => {
    render(
      <TooltipProvider>
        <ChatInput onSend={vi.fn()} sending imageGenerating />
      </TooltipProvider>,
    );

    expect(screen.getByRole('status', { name: 'Thinking…' })).toHaveAttribute(
      'data-testid',
      'chat-composer-working-indicator',
    );
    expect(screen.queryByTestId('chat-composer-image-generation-indicator')).not.toBeInTheDocument();
  });

  it('shows only text models supplied by managed client-config', () => {
    configureAgentAndModelPickers();

    renderChatInput();
    fireEvent.click(screen.getByTestId('chat-model-picker-button'));

    expect(screen.getByTestId('chat-model-picker-menu')).toHaveTextContent('Smart');
    expect(screen.getByTestId('chat-model-picker-menu')).toHaveTextContent('DeepSeek V4 Pro');
    expect(screen.getByTestId('chat-model-picker-menu')).not.toHaveTextContent('Alpha');
    expect(screen.getByTestId('chat-model-picker-menu')).not.toHaveTextContent('Beta');
  });

  it('persists a model selection only for the current session', async () => {
    configureAgentAndModelPickers();

    renderChatInput();
    fireEvent.click(screen.getByTestId('chat-model-picker-button'));
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek V4 Pro' }));

    await waitFor(() => {
      expect(chatState.updateSessionModel).toHaveBeenCalledWith(
        'agent:main:main',
        'openai/deepseek-v4-pro',
      );
    });
    expect(screen.getByTestId('chat-model-picker-button')).toHaveTextContent('DeepSeek V4 Pro');
  });

  it('blocks sending until the selected model is persisted', async () => {
    const modelUpdate = createDeferred<void>();
    const onSend = vi.fn();
    configureAgentAndModelPickers();
    const trackedUpdate = modelUpdate.promise.finally(() => {
      delete chatState.pendingSessionModelUpdates['agent:main:main'];
    });
    chatState.updateSessionModel.mockImplementationOnce((sessionKey: string) => {
      chatState.pendingSessionModelUpdates[sessionKey] = true;
      return trackedUpdate;
    });
    chatState.waitForSessionModelUpdate.mockImplementation(() => trackedUpdate);

    const view = renderChatInput(onSend);
    fireEvent.change(screen.getByTestId('chat-composer-input'), {
      target: { value: 'Use the newly selected model' },
    });
    fireEvent.click(screen.getByTestId('chat-model-picker-button'));
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek V4 Pro' }));

    await waitFor(() => {
      expect(chatState.updateSessionModel).toHaveBeenCalledWith(
        'agent:main:main',
        'openai/deepseek-v4-pro',
      );
    });
    expect(screen.getByTestId('chat-composer-send')).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => {
      modelUpdate.resolve();
      await trackedUpdate;
    });
    view.rerender(
      <TooltipProvider>
        <ChatInput onSend={onSend} />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('chat-composer-send')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('chat-composer-send'));
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('Use the newly selected model', undefined, null);
    });
  });

  it('does not send a queued draft after switching sessions during model persistence', async () => {
    const modelUpdate = createDeferred<void>();
    const onSend = vi.fn();
    configureAgentAndModelPickers();
    const trackedUpdate = modelUpdate.promise.finally(() => {
      delete chatState.pendingSessionModelUpdates['agent:main:main'];
    });
    chatState.updateSessionModel.mockImplementationOnce((sessionKey: string) => {
      chatState.pendingSessionModelUpdates[sessionKey] = true;
      return trackedUpdate;
    });
    chatState.waitForSessionModelUpdate.mockImplementation(() => trackedUpdate);

    const view = renderChatInput(onSend);
    const input = screen.getByTestId('chat-composer-input');
    fireEvent.change(input, { target: { value: 'Keep this draft in the original session' } });
    fireEvent.click(screen.getByTestId('chat-model-picker-button'));
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek V4 Pro' }));
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    chatState.currentSessionKey = 'agent:main:other';
    chatState.sessions = [
      ...chatState.sessions,
      { key: chatState.currentSessionKey, model: 'openai/smart-latest' },
    ];
    view.rerender(
      <TooltipProvider>
        <ChatInput onSend={onSend} />
      </TooltipProvider>,
    );

    await act(async () => {
      modelUpdate.resolve();
      await trackedUpdate;
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-composer-input')).toHaveValue(
      'Keep this draft in the original session',
    );
  });

  it('reads pending model persistence after remount and sends only once after it settles', async () => {
    const modelUpdate = createDeferred<void>();
    const onSend = vi.fn();
    configureAgentAndModelPickers();
    chatState.pendingSessionModelUpdates['agent:main:main'] = true;
    chatState.waitForSessionModelUpdate.mockImplementation(() => modelUpdate.promise);

    const firstMount = renderChatInput(onSend);
    expect(screen.getByTestId('chat-composer-send')).toBeDisabled();
    fireEvent.change(screen.getByTestId('chat-composer-input'), {
      target: { value: 'Do not send from the unmounted instance' },
    });
    fireEvent.keyDown(screen.getByTestId('chat-composer-input'), { key: 'Enter', code: 'Enter' });
    firstMount.unmount();

    renderChatInput(onSend);
    const input = screen.getByTestId('chat-composer-input');
    fireEvent.change(input, { target: { value: 'Send after persistence' } });
    expect(screen.getByTestId('chat-composer-send')).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await act(async () => {
      delete chatState.pendingSessionModelUpdates['agent:main:main'];
      modelUpdate.resolve();
      await modelUpdate.promise;
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('Send after persistence', undefined, null);
  });

  it('does not revive an older send after an A to B to A session switch', async () => {
    const modelUpdate = createDeferred<void>();
    const onSend = vi.fn();
    configureAgentAndModelPickers();
    chatState.pendingSessionModelUpdates['agent:main:main'] = true;
    chatState.waitForSessionModelUpdate.mockImplementation(() => modelUpdate.promise);

    const view = renderChatInput(onSend);
    let input = screen.getByTestId('chat-composer-input');
    fireEvent.change(input, { target: { value: 'Stale A draft' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    chatState.currentSessionKey = 'agent:main:other';
    chatState.sessions = [
      ...chatState.sessions,
      { key: chatState.currentSessionKey, model: 'openai/smart-latest' },
    ];
    view.rerender(
      <TooltipProvider>
        <ChatInput onSend={onSend} />
      </TooltipProvider>,
    );
    chatState.currentSessionKey = 'agent:main:main';
    view.rerender(
      <TooltipProvider>
        <ChatInput onSend={onSend} />
      </TooltipProvider>,
    );

    input = screen.getByTestId('chat-composer-input');
    fireEvent.change(input, { target: { value: 'Current A draft' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await act(async () => {
      delete chatState.pendingSessionModelUpdates['agent:main:main'];
      modelUpdate.resolve();
      await modelUpdate.promise;
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('Current A draft', undefined, null);
  });

  it('keeps the latest model visible when an earlier selection fails late', async () => {
    const firstUpdate = createDeferred<void>();
    const finalUpdate = createDeferred<void>();
    configureAgentAndModelPickers();
    managedClientConfigState.textModelPolicy = {
      defaultModel: 'smart-latest',
      models: [
        { id: 'smart-latest', label: 'Smart' },
        { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
        { id: 'glm-5', label: 'GLM 5' },
      ],
    };
    chatState.updateSessionModel
      .mockReturnValueOnce(firstUpdate.promise)
      .mockReturnValueOnce(finalUpdate.promise);

    renderChatInput();
    fireEvent.click(screen.getByTestId('chat-model-picker-button'));
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek V4 Pro' }));
    fireEvent.click(screen.getByTestId('chat-model-picker-button'));
    fireEvent.click(screen.getByRole('button', { name: 'GLM 5' }));

    expect(screen.getByTestId('chat-model-picker-button')).toHaveTextContent('GLM 5');

    await act(async () => {
      finalUpdate.resolve();
      await finalUpdate.promise;
      firstUpdate.reject(new Error('older model update failed'));
      await firstUpdate.promise.catch(() => undefined);
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
    expect(screen.getByTestId('chat-model-picker-button')).toHaveTextContent('GLM 5');
  });

  it('clears the current session override when selecting the managed default model', async () => {
    configureAgentAndModelPickers();
    chatState.sessions = [{
      key: chatState.currentSessionKey,
      model: 'openai/deepseek-v4-pro',
    }];

    renderChatInput();
    fireEvent.click(screen.getByTestId('chat-model-picker-button'));
    fireEvent.click(screen.getByRole('button', { name: 'Smart' }));

    await waitFor(() => {
      expect(chatState.updateSessionModel).toHaveBeenCalledWith('agent:main:main', null);
    });
  });

  it('repairs a removed session model before sending', async () => {
    configureAgentAndModelPickers();
    chatState.sessions = [{ key: chatState.currentSessionKey, model: 'openai/removed-model' }];
    const onSend = vi.fn();

    renderChatInput(onSend);
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('chat-composer-send'));

    await waitFor(() => {
      expect(chatState.updateSessionModel).toHaveBeenCalledWith(
        'agent:main:main',
        'openai/smart-latest',
      );
      expect(onSend).toHaveBeenCalledWith('Hello', undefined, null);
    });
  });

  it('does not duplicate a send while repairing a removed session model', async () => {
    const repair = createDeferred<void>();
    const onSend = vi.fn();
    configureAgentAndModelPickers();
    chatState.sessions = [{ key: chatState.currentSessionKey, model: 'openai/removed-model' }];
    chatState.updateSessionModel.mockReturnValueOnce(repair.promise);

    renderChatInput(onSend);
    const input = screen.getByTestId('chat-composer-input');
    fireEvent.change(input, { target: { value: 'Repair once' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(chatState.updateSessionModel).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      repair.resolve();
      await repair.promise;
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('Repair once', undefined, null);
  });

  it('does not send when repairing a removed session model fails', async () => {
    configureAgentAndModelPickers();
    chatState.sessions = [{ key: chatState.currentSessionKey, model: 'openai/removed-model' }];
    chatState.updateSessionModel.mockRejectedValueOnce(new Error('session patch failed'));
    const onSend = vi.fn();

    renderChatInput(onSend);
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('chat-composer-send'));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('renders editable workspace selector in the composer footer', () => {
    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          workspaceLabel="~/workspace/ClawX"
          workspacePath="/Users/alex/workspace/ClawX"
          workspaceReadOnly={false}
          onSelectWorkspace={vi.fn()}
        />
      </TooltipProvider>,
    );

    const button = screen.getByTestId('chat-workspace-selector');
    expect(button).toHaveTextContent('~/workspace/ClawX');
    expect(button).toHaveAttribute('title', '/Users/alex/workspace/ClawX');
    expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('places workspace selector before the gateway status in the composer footer', () => {
    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          workspaceLabel="~/workspace/ClawX"
          workspacePath="/Users/alex/workspace/ClawX"
          workspaceReadOnly={false}
          onSelectWorkspace={vi.fn()}
        />
      </TooltipProvider>,
    );

    const workspaceSelector = screen.getByTestId('chat-workspace-selector');
    const gatewayStatus = screen.getByText(/gateway connected \| port: 18789/i);

    expect(workspaceSelector.compareDocumentPosition(gatewayStatus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders read-only workspace selector for bound sessions', () => {
    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          workspaceLabel="默认工作空间"
          workspacePath="~/.openclaw/workspace"
          workspaceReadOnly
          onSelectWorkspace={vi.fn()}
        />
      </TooltipProvider>,
    );

    const button = screen.getByTestId('chat-workspace-selector');
    expect(button).toHaveTextContent('默认工作空间');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveClass('border-transparent');
    expect(button).not.toHaveClass('border-black/10');

    fireEvent.click(button);

    expect(screen.queryByTestId('chat-workspace-menu')).not.toBeInTheDocument();
  });

  it('workspace selector opens a native directory picker for editable sessions', async () => {
    const onSelectWorkspace = vi.fn();
    vi.mocked(hostApiDialogOpenMock).mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/alex/next-project'],
    });

    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          workspaceLabel="Project workspace"
          workspacePath="/Users/alex/project"
          workspaceReadOnly={false}
          onSelectWorkspace={onSelectWorkspace}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByTestId('chat-workspace-selector'));
    expect(screen.getByTestId('chat-workspace-menu')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chat-workspace-choose-other'));

    await waitFor(() => {
      expect(hostApiDialogOpenMock).toHaveBeenCalledWith({
        title: 'Select workspace folder',
        buttonLabel: 'Use workspace',
        defaultPath: '/Users/alex/project',
        properties: ['openDirectory', 'createDirectory'],
      });
    });
    expect(onSelectWorkspace).toHaveBeenCalledWith('/Users/alex/next-project');
  });

  it('uses disclosure semantics for workspace options instead of menu roles', () => {
    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          workspaceLabel="Project workspace"
          workspacePath="/Users/alex/project"
          workspaceReadOnly={false}
          onSelectWorkspace={vi.fn()}
        />
      </TooltipProvider>,
    );

    const button = screen.getByTestId('chat-workspace-selector');
    fireEvent.click(button);

    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).not.toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.getByTestId('chat-workspace-menu')).not.toHaveAttribute('role', 'menu');
    expect(screen.getByTestId('chat-workspace-default')).not.toHaveAttribute('role', 'menuitem');
    expect(screen.getByTestId('chat-workspace-choose-other')).not.toHaveAttribute('role', 'menuitem');
  });

  it('closes the workspace menu with Escape', () => {
    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          workspaceLabel="~/workspace/ClawX"
          workspacePath="/Users/alex/workspace/ClawX"
          workspaceReadOnly={false}
          onSelectWorkspace={vi.fn()}
        />
      </TooltipProvider>,
    );

    const button = screen.getByTestId('chat-workspace-selector');
    fireEvent.click(button);
    expect(screen.getByTestId('chat-workspace-menu')).toBeInTheDocument();

    fireEvent.keyDown(button, { key: 'Escape' });

    expect(screen.queryByTestId('chat-workspace-menu')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the workspace menu when Escape is pressed outside the selector', () => {
    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          workspaceLabel="~/workspace/ClawX"
          workspacePath="/Users/alex/workspace/ClawX"
          workspaceReadOnly={false}
          onSelectWorkspace={vi.fn()}
        />
      </TooltipProvider>,
    );

    const button = screen.getByTestId('chat-workspace-selector');
    fireEvent.click(button);
    expect(screen.getByTestId('chat-workspace-menu')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByTestId('chat-workspace-menu')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps workspace menu ancestors from clipping the dropdown', () => {
    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          workspaceLabel="~/workspace/ClawX"
          workspacePath="/Users/alex/workspace/ClawX"
          workspaceReadOnly={false}
          onSelectWorkspace={vi.fn()}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByTestId('chat-workspace-selector'));

    const ancestorClasses: string[] = [];
    let element = screen.getByTestId('chat-workspace-menu').parentElement;
    while (element && element !== document.body) {
      ancestorClasses.push(element.className);
      element = element.parentElement;
    }

    expect(ancestorClasses.some((className) => className.split(/\s+/).includes('overflow-hidden'))).toBe(false);
  });

  it('keeps the workspace menu closed after the selector is disabled and re-enabled', () => {
    const onSelectWorkspace = vi.fn();
    const { rerender } = render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          workspaceLabel="Project workspace"
          workspacePath="/Users/alex/project"
          workspaceReadOnly={false}
          onSelectWorkspace={onSelectWorkspace}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByTestId('chat-workspace-selector'));
    expect(screen.getByTestId('chat-workspace-menu')).toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          disabled
          workspaceLabel="Project workspace"
          workspacePath="/Users/alex/project"
          workspaceReadOnly={false}
          onSelectWorkspace={onSelectWorkspace}
        />
      </TooltipProvider>,
    );
    expect(screen.queryByTestId('chat-workspace-menu')).not.toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          workspaceLabel="Project workspace"
          workspacePath="/Users/alex/project"
          workspaceReadOnly={false}
          onSelectWorkspace={onSelectWorkspace}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByTestId('chat-workspace-menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-workspace-selector')).toHaveAttribute('aria-expanded', 'false');
  });

  it('workspace selector can choose the default workspace from the menu', () => {
    const onSelectWorkspace = vi.fn();

    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          workspaceLabel="~/workspace/ClawX"
          workspacePath="/Users/alex/workspace/ClawX"
          workspaceReadOnly={false}
          onSelectWorkspace={onSelectWorkspace}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByTestId('chat-workspace-selector'));
    fireEvent.click(screen.getByTestId('chat-workspace-default'));

    expect(onSelectWorkspace).toHaveBeenCalledWith('~/.openclaw/workspace');
    expect(hostApiDialogOpenMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('chat-workspace-menu')).not.toBeInTheDocument();
  });

  it('closes the workspace menu on outside click', () => {
    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          workspaceLabel="~/workspace/ClawX"
          workspacePath="/Users/alex/workspace/ClawX"
          workspaceReadOnly={false}
          onSelectWorkspace={vi.fn()}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByTestId('chat-workspace-selector'));
    expect(screen.getByTestId('chat-workspace-menu')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByTestId('chat-workspace-menu')).not.toBeInTheDocument();
  });

  it('keeps composer popovers from overlapping the workspace menu', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
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
        modelDisplay: 'Claude',
        inheritedModel: false,
        workspace: '~/.openclaw/workspace-research',
        agentDir: '~/.openclaw/agents/research/agent',
        mainSessionKey: 'agent:research:desk',
        channelTypes: [],
      },
    ];
    vi.mocked(hostApiFetchMock).mockResolvedValue({ success: true, skills: [] });

    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          workspaceLabel="~/workspace/ClawX"
          workspacePath="/Users/alex/workspace/ClawX"
          workspaceReadOnly={false}
          onSelectWorkspace={vi.fn()}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByTestId('chat-workspace-selector'));
    expect(screen.getByTestId('chat-workspace-menu')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-composer-agent'));
    expect(screen.queryByTestId('chat-workspace-menu')).not.toBeInTheDocument();
    expect(screen.getByText('Research')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-workspace-selector'));
    expect(screen.queryByText('Research')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-workspace-menu')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-composer-skill'));
    expect(screen.queryByTestId('chat-workspace-menu')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search skills')).toBeInTheDocument();
    expect(await screen.findByText('No matching skills found')).toBeInTheDocument();
  });

  it('closes an open model picker when opening the agent picker', () => {
    configureAgentAndModelPickers();

    renderChatInput();

    fireEvent.click(screen.getByTestId('chat-model-picker-button'));
    expect(screen.getByTestId('chat-model-picker-menu')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-composer-agent'));

    expect(screen.queryByTestId('chat-model-picker-menu')).not.toBeInTheDocument();
    expect(screen.getByText('Research')).toBeInTheDocument();
  });

  it('closes an open model picker when opening the skill picker', async () => {
    configureAgentAndModelPickers();

    renderChatInput();

    fireEvent.click(screen.getByTestId('chat-model-picker-button'));
    expect(screen.getByTestId('chat-model-picker-menu')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-composer-skill'));

    expect(screen.queryByTestId('chat-model-picker-menu')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search skills')).toBeInTheDocument();
    expect(await screen.findByText('No matching skills found')).toBeInTheDocument();
  });

  it('closes the focused skill picker search with Escape', async () => {
    configureAgentAndModelPickers();

    renderChatInput();

    fireEvent.click(screen.getByTestId('chat-composer-skill'));
    const searchInput = screen.getByPlaceholderText('Search skills');
    searchInput.focus();
    expect(searchInput).toHaveFocus();

    fireEvent.keyDown(searchInput, { key: 'Escape' });

    expect(screen.queryByPlaceholderText('Search skills')).not.toBeInTheDocument();
    expect(await screen.findByText('gateway connected | port: 18789')).toBeInTheDocument();
  });

  it('read-only workspace selector does not open the native picker', () => {
    const onSelectWorkspace = vi.fn();

    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          workspaceLabel="Default workspace"
          workspacePath="~/.openclaw/workspace"
          workspaceReadOnly
          onSelectWorkspace={onSelectWorkspace}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByTestId('chat-workspace-selector'));

    expect(screen.queryByTestId('chat-workspace-menu')).not.toBeInTheDocument();
    expect(hostApiDialogOpenMock).not.toHaveBeenCalled();
    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });

  it('disabled workspace selector is announced disabled and does not open the native picker', () => {
    const onSelectWorkspace = vi.fn();

    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          disabled
          workspaceLabel="Project workspace"
          workspacePath="/Users/alex/project"
          workspaceReadOnly={false}
          onSelectWorkspace={onSelectWorkspace}
        />
      </TooltipProvider>,
    );

    const button = screen.getByTestId('chat-workspace-selector');
    expect(button).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(button);

    expect(screen.queryByTestId('chat-workspace-menu')).not.toBeInTheDocument();
    expect(hostApiDialogOpenMock).not.toHaveBeenCalled();
    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });

  it('sending workspace selector is announced disabled and does not open the native picker', () => {
    const onSelectWorkspace = vi.fn();

    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          sending
          workspaceLabel="Project workspace"
          workspacePath="/Users/alex/project"
          workspaceReadOnly={false}
          onSelectWorkspace={onSelectWorkspace}
        />
      </TooltipProvider>,
    );

    const button = screen.getByTestId('chat-workspace-selector');
    expect(button).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(button);

    expect(screen.queryByTestId('chat-workspace-menu')).not.toBeInTheDocument();
    expect(hostApiDialogOpenMock).not.toHaveBeenCalled();
    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });

  it('workspace selector without a selection callback is announced disabled and does not open the native picker', () => {
    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          workspaceLabel="Project workspace"
          workspacePath="/Users/alex/project"
          workspaceReadOnly={false}
        />
      </TooltipProvider>,
    );

    const button = screen.getByTestId('chat-workspace-selector');
    expect(button).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(button);

    expect(screen.queryByTestId('chat-workspace-menu')).not.toBeInTheDocument();
    expect(hostApiDialogOpenMock).not.toHaveBeenCalled();
  });

  it('workspace selector reports dialog failures without selecting a workspace', async () => {
    const onSelectWorkspace = vi.fn();
    vi.mocked(hostApiDialogOpenMock).mockRejectedValue(new Error('dialog failed'));

    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          workspaceLabel="Project workspace"
          workspacePath="/Users/alex/project"
          workspaceReadOnly={false}
          onSelectWorkspace={onSelectWorkspace}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByTestId('chat-workspace-selector'));
    fireEvent.click(screen.getByTestId('chat-workspace-choose-other'));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('Could not open workspace picker');
    });
    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });

  it('hides the @agent picker when only one agent is configured', () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];

    renderChatInput();

    expect(screen.queryByTitle('Choose agent')).not.toBeInTheDocument();
  });

  it('uses native textarea rendering when no skill token is present', () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];

    renderChatInput();

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: '我没有填写Skill' } });

    expect(textbox).toHaveValue('我没有填写Skill');
    expect(screen.queryByTestId('chat-composer-skill-token')).not.toBeInTheDocument();
    expect(textbox.className).not.toContain('text-transparent');
  });

  it('lets the user select an agent target and sends it with the message', async () => {
    const onSend = vi.fn();
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
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
        modelDisplay: 'Claude',
        inheritedModel: false,
        workspace: '~/.openclaw/workspace-research',
        agentDir: '~/.openclaw/agents/research/agent',
        mainSessionKey: 'agent:research:desk',
        channelTypes: [],
      },
    ];

    renderChatInput(onSend);

    fireEvent.click(screen.getByTitle('Choose agent'));
    fireEvent.click(screen.getByText('Research'));

    expect(screen.getByText('@Research')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello direct agent' } });
    fireEvent.click(screen.getByTitle('Send'));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('Hello direct agent', undefined, 'research');
    });
  });

  it('keeps the ACP composer enabled while gateway is running but not yet ready', async () => {
    const onSend = vi.fn();
    gatewayState.status = { state: 'running', port: 18789, gatewayReady: false };
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    agentsState.defaultModelRef = 'custom-aaaaaaaa/gpt-a';
    const now = '2025-01-01T00:00:00.000Z';
    providersState.accounts = [
      {
        id: 'aaaaaaaa',
        vendorId: 'custom',
        label: 'Alpha',
        authMode: 'api_key',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'custom-aaaaaaaa/gpt-a',
        enabled: true,
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'bbbbbbbb',
        vendorId: 'custom',
        label: 'Beta',
        authMode: 'api_key',
        baseUrl: 'http://127.0.0.1:2/v1',
        model: 'custom-bbbbbbbb/gpt-b',
        enabled: true,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      },
    ];
    providersState.statuses = [
      { id: 'aaaaaaaa', name: 'Alpha', type: 'custom', hasKey: true, keyMasked: 'sk-***', enabled: true, createdAt: now, updatedAt: now },
      { id: 'bbbbbbbb', name: 'Beta', type: 'custom', hasKey: true, keyMasked: 'sk-***', enabled: true, createdAt: now, updatedAt: now },
    ];
    providersState.defaultAccountId = 'aaaaaaaa';

    renderChatInput(onSend);

    const input = screen.getByTestId('chat-composer-input');
    expect(input).not.toBeDisabled();
    expect(screen.getByTestId('chat-composer-skill')).not.toBeDisabled();
    expect(screen.getByTestId('chat-model-picker-button')).not.toBeDisabled();

    fireEvent.change(input, { target: { value: 'Send through ACP' } });
    fireEvent.click(screen.getByTitle('Send'));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('Send through ACP', undefined, null);
    });
  });

  it('shows starting status while gateway is running but not yet ready', () => {
    gatewayState.status = { state: 'running', port: 18789, gatewayReady: false };
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];

    renderChatInput();

    expect(screen.getByText(/gateway starting \| port: 18789/i)).toBeInTheDocument();
  });

  it('renders the skill trigger after the @ agent picker', () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
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
        modelDisplay: 'Claude',
        inheritedModel: false,
        workspace: '~/.openclaw/workspace-research',
        agentDir: '~/.openclaw/agents/research/agent',
        mainSessionKey: 'agent:research:desk',
        channelTypes: [],
      },
    ];

    renderChatInput();

    const agentTrigger = screen.getByTestId('chat-composer-agent');
    const skillTrigger = screen.getByTestId('chat-composer-skill');

    expect(skillTrigger).toHaveTextContent('Skill');
    expect(agentTrigger.compareDocumentPosition(skillTrigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('inserts the selected skill at the current cursor position and prefixes sends', async () => {
    const onSend = vi.fn();
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    vi.mocked(hostApiFetchMock).mockResolvedValue({
      success: true,
      skills: [
        {
          name: 'create-skill',
          description: 'Create and refine reusable skills.',
          source: 'workspace',
          sourceLabel: 'Workspace',
          manifestPath: '/tmp/workspace/skill/create-skill/SKILL.md',
          baseDir: '/tmp/workspace/skill/create-skill',
        },
      ],
    });

    renderChatInput(onSend);

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: 'Draft a new helper' } });
    textbox.focus();
    textbox.setSelectionRange('Draft '.length, 'Draft '.length);

    fireEvent.click(screen.getByTitle('Choose skill'));
    expect(await screen.findByText('/create-skill')).toBeInTheDocument();

    fireEvent.click(screen.getByText('/create-skill'));
    expect(screen.getByTestId('chat-composer-skill')).toHaveTextContent('Skill');
    expect(textbox).toHaveValue('Draft /create-skill  a new helper');
    expect(screen.getByTestId('chat-composer-skill-token')).toHaveTextContent('/create-skill');

    fireEvent.click(screen.getByTitle('Send'));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('Draft /create-skill  a new helper', undefined, null);
    });
    expect(hostApiFetchMock).toHaveBeenCalledWith(
      '/api/skills/quick-access',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );
  });

  it('removes the full inline skill token with one backspace', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    vi.mocked(hostApiFetchMock).mockResolvedValue({
      success: true,
      skills: [
        {
          name: 'create-skill',
          description: 'Create and refine reusable skills.',
          source: 'workspace',
          sourceLabel: 'Workspace',
          manifestPath: '/tmp/workspace/skill/create-skill/SKILL.md',
          baseDir: '/tmp/workspace/skill/create-skill',
        },
      ],
    });

    renderChatInput();

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: 'Draft a new helper' } });
    textbox.focus();
    textbox.setSelectionRange('Draft '.length, 'Draft '.length);

    fireEvent.click(screen.getByTitle('Choose skill'));
    fireEvent.click(await screen.findByText('/create-skill'));

    expect(textbox).toHaveValue('Draft /create-skill  a new helper');
    textbox.setSelectionRange('Draft /create-skill  '.length, 'Draft /create-skill  '.length);
    fireEvent.keyDown(textbox, { key: 'Backspace' });

    expect(textbox).toHaveValue('Draft a new helper');
  });

  it('skips across the inline skill block with arrow keys', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    vi.mocked(hostApiFetchMock).mockResolvedValue({
      success: true,
      skills: [
        {
          name: 'create-skill',
          description: 'Create and refine reusable skills.',
          source: 'workspace',
          sourceLabel: 'Workspace',
          manifestPath: '/tmp/workspace/skill/create-skill/SKILL.md',
          baseDir: '/tmp/workspace/skill/create-skill',
        },
      ],
    });

    renderChatInput();

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: 'Draft a new helper' } });
    textbox.focus();
    textbox.setSelectionRange('Draft '.length, 'Draft '.length);

    fireEvent.click(screen.getByTitle('Choose skill'));
    fireEvent.click(await screen.findByText('/create-skill'));

    textbox.setSelectionRange('Draft '.length, 'Draft '.length);
    fireEvent.keyDown(textbox, { key: 'ArrowRight' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(textbox.selectionStart).toBe('Draft /create-skill  '.length);

    fireEvent.keyDown(textbox, { key: 'ArrowLeft' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(textbox.selectionStart).toBe('Draft '.length);
  });

  it('adds left spacing when inserting a skill after adjacent text', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    vi.mocked(hostApiFetchMock).mockResolvedValue({
      success: true,
      skills: [
        {
          name: 'docx',
          description: 'Work with Word documents.',
          source: 'legacy',
          sourceLabel: 'Legacy',
          manifestPath: '/tmp/openclaw/skills/docx/SKILL.md',
          baseDir: '/tmp/openclaw/skills/docx',
        },
      ],
    });

    renderChatInput();

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: '哈哈哈哈你好' } });
    textbox.focus();
    textbox.setSelectionRange('哈哈哈哈'.length, '哈哈哈哈'.length);

    fireEvent.click(screen.getByTitle('Choose skill'));
    fireEvent.click(await screen.findByText('/docx'));

    expect(textbox).toHaveValue('哈哈哈哈 /docx  你好');
  });

  it('allows inserting the same skill multiple times as separate blocks', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    vi.mocked(hostApiFetchMock).mockResolvedValue({
      success: true,
      skills: [
        {
          name: 'create-rule',
          description: 'Create Cursor rules.',
          source: 'workspace',
          sourceLabel: 'Workspace',
          manifestPath: '/tmp/workspace/skill/create-rule/SKILL.md',
          baseDir: '/tmp/workspace/skill/create-rule',
        },
      ],
    });

    renderChatInput();

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.click(screen.getByTitle('Choose skill'));
    fireEvent.click(await screen.findByTestId('chat-composer-skill-option-create-rule'));

    textbox.setSelectionRange(textbox.value.length, textbox.value.length);
    fireEvent.click(screen.getByTitle('Choose skill'));
    fireEvent.click(await screen.findByTestId('chat-composer-skill-option-create-rule'));

    expect(textbox).toHaveValue('/create-rule  /create-rule  ');
    expect(screen.getAllByTestId('chat-composer-skill-token')).toHaveLength(2);
  });

  it('opens the artifact preview panel when the inline skill token is clicked', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    vi.mocked(hostApiFetchMock).mockResolvedValue({
      success: true,
      skills: [
        {
          name: 'create-skill',
          description: 'Create and refine reusable skills.',
          source: 'workspace',
          sourceLabel: 'Workspace',
          manifestPath: '/tmp/workspace/skill/create-skill/SKILL.md',
          baseDir: '/tmp/workspace/skill/create-skill',
        },
      ],
    });

    renderChatInput();

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: 'Draft a new helper' } });
    textbox.focus();
    textbox.setSelectionRange('Draft '.length, 'Draft '.length);

    fireEvent.click(screen.getByTitle('Choose skill'));
    fireEvent.click(await screen.findByText('/create-skill'));

    fireEvent.click(screen.getByTestId('chat-composer-skill-token'));

    expect(artifactPanelMocks.openPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/workspace/skill/create-skill/SKILL.md',
        fileName: 'SKILL.md',
      }),
    );
  });

  it('stages dropped folders via disk path instead of buffer upload', async () => {
    vi.mocked(hostApiFetchMock).mockResolvedValueOnce([{
      id: 'folder-id',
      fileName: 'Archive',
      mimeType: 'application/x-directory',
      fileSize: 0,
      stagedPath: '/tmp/project-folder',
      preview: null,
    }]);

    const folderFile = new File([new Uint8Array(192)], 'Archive', { type: 'application/zip' });
    Object.defineProperty(folderFile, 'path', { value: '/tmp/project-folder' });

    const { container } = renderChatInput();
    fireEvent.drop(container.firstElementChild as Element, {
      dataTransfer: {
        items: [{
          kind: 'file',
          getAsFile: () => folderFile,
          webkitGetAsEntry: () => ({ isDirectory: true, isFile: false }),
        }],
        files: [folderFile],
      },
    });

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/files/stage-paths', {
        method: 'POST',
        body: JSON.stringify({ filePaths: ['/tmp/project-folder'] }),
      });
    });
    expect(await screen.findByText('Archive')).toBeInTheDocument();
  });
});
