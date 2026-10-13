import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatInput } from '@/pages/Chat/ChatInput';
import { TooltipProvider } from '@/components/ui/tooltip';
import { rendererExtensionRegistry } from '@/extensions/registry';
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
    thinkingLevel: null as string | null,
    pendingSessionModelUpdates: {} as Record<string, boolean>,
    pendingSessionThinkingUpdates: {} as Record<string, boolean>,
    updateSessionModel: vi.fn(),
    waitForSessionModelUpdate: vi.fn(),
    updateSessionThinking: vi.fn(),
    waitForSessionThinkingUpdate: vi.fn(),
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
    runtimeConfig: {
      observability: {
        enabled: false,
        tunnelPath: '/api/clawx/observability/envelope',
        crashSampleRate: 1,
        handledErrorSampleRate: 0.2,
        tracesSampleRate: 0.05,
        artifactSampleRate: 0.2,
        maxEventsPerHour: 30,
      },
      features: {
        artifacts: {
          enabled: false,
          rolloutPercentage: 0,
          modelAlias: 'uclaw-artifact-v1',
          policyVersion: 'v1',
        },
        ecommerceMainImage: {
          enabled: false,
          rolloutPercentage: 0,
          skillVersion: 'v1',
        },
      },
    },
    textModelPolicy: {
      defaultModel: 'smart-latest',
      defaultThinkingLevel: 'medium',
      models: [
        { id: 'smart-latest', label: 'Smart' },
        { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      ],
    },
    imageModelPolicy: {
      defaultModel: 'gpt-image-2',
      defaultSize: '1024x1024',
      defaultQuality: 'medium',
      models: [{
        id: 'gpt-image-2',
        sizes: ['1024x1536', '1536x1024', '1024x1024', '2160x3840', '3840x2160'],
        qualities: ['low', 'medium', 'high'],
        defaultSize: '1024x1024',
        defaultQuality: 'medium',
      }],
    },
    videoModelPolicy: {
      defaultModel: 'grok-image-video',
      defaultSize: '1280x720',
      defaultAspectRatio: '16:9',
      defaultResolution: '720P',
      defaultDurationSeconds: 10,
      models: [
        {
          id: 'grok-image-video',
          label: 'Grok Video',
          modes: ['text-to-video'],
          sizes: [
            '480x720', '720x480', '480x480', '480x854', '854x480',
            '720x1080', '1080x720', '720x720', '720x1280', '1280x720',
          ],
          aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
          resolutions: ['480P', '720P'],
          durations: [6, 10, 15],
          defaultSize: '1280x720',
          defaultAspectRatio: '16:9',
          defaultResolution: '720P',
          defaultDurationSeconds: 10,
          requiresImage: false,
        },
        {
          id: 'grok-video-1.5',
          label: 'Grok Video 1.5',
          modes: ['image-to-video'],
          sizes: [
            '480x720', '720x480', '480x480', '480x854', '854x480',
            '720x1080', '1080x720', '720x720', '720x1280', '1280x720',
          ],
          aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
          resolutions: ['480P', '720P'],
          durations: [6, 10, 15],
          defaultSize: '1280x720',
          defaultAspectRatio: '16:9',
          defaultResolution: '720P',
          defaultDurationSeconds: 10,
          requiresImage: true,
        },
      ],
    },
    initialized: true,
    loading: false,
    loadTextModels: vi.fn(),
    loadImageModels: vi.fn(),
    loadVideoModels: vi.fn(),
    loadRuntimeConfig: vi.fn().mockResolvedValue(undefined),
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
    case 'composer.mediaAttachmentLimit':
      return `A message can include at most ${String(vars?.count ?? '')} attachments`;
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
    case 'composer.pickThinking':
      return 'Choose reasoning level';
    case 'composer.settingsSummary':
      return `Model: ${String(vars?.model ?? '')}, reasoning: ${String(vars?.thinking ?? '')}`;
    case 'composer.resetSettings':
      return 'Reset to defaults';
    case 'composer.modelSetting':
      return 'Model';
    case 'composer.thinkingSetting':
      return 'Reasoning level';
    case 'composer.thinkingInherit':
      return `Inherit (${String(vars?.level ?? '')})`;
    case 'composer.thinkingSwitchFailed':
      return `Failed to switch reasoning level: ${String(vars?.error ?? '')}`;
    case 'composer.thinkingLevels.off':
      return 'Off';
    case 'composer.thinkingLevels.minimal':
      return 'Minimal';
    case 'composer.thinkingLevels.low':
      return 'Low';
    case 'composer.thinkingLevels.medium':
      return 'Medium';
    case 'composer.thinkingLevels.high':
      return 'High';
    case 'composer.thinkingLevels.xhigh':
      return 'Extra high';
    case 'composer.imageMode':
      return 'Image mode';
    case 'composer.videoMode':
      return 'Video mode';
    case 'composer.videoReferenceImageLimit':
      return 'Video generation supports one reference image at a time';
    case 'composer.videoResolutionLabel':
      return 'Video resolution';
    case 'composer.videoDurationLabel':
      return 'Video duration';
    case 'composer.imageSizeLabel':
      return 'Image size';
    case 'composer.imageAspectTall':
      return 'Tall';
    case 'composer.imageAspectWide':
      return 'Wide';
    case 'composer.imageAspectSquare':
      return 'Square';
    case 'composer.imageAspectVertical':
      return 'Vertical';
    case 'composer.imageAspectWidescreen':
      return 'Widescreen';
    case 'composer.imageQualityLabel':
      return 'Quality';
    case 'composer.imageQualityLow':
      return 'Low';
    case 'composer.imageQualityMedium':
      return 'Medium';
    case 'composer.imageQualityHigh':
      return 'High';
    case 'composer.clearTarget':
      return 'Clear target agent';
    case 'composer.targetChip':
      return `@${String(vars?.agent ?? '')}`;
    case 'composer.agentPickerTitle':
      return 'Route the next message to another agent';
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
    case 'composer.gatewayRetrying':
      return `retrying connection (${String(vars?.attempt ?? '')}/${String(vars?.maxAttempts ?? '')})`;
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
    case 'videoGeneration.generating':
      return 'Generating video, please wait…';
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

function stagedAttachment(fileName: string) {
  return {
    id: `staged-${fileName}`,
    fileName,
    mimeType: 'text/plain',
    fileSize: 10,
    stagedPath: `/tmp/staged-${fileName}`,
    preview: null,
  };
}

function dropAttachments(container: HTMLElement, files: File[]) {
  fireEvent.drop(container.firstElementChild as Element, {
    dataTransfer: { files },
  });
}

function pasteAttachments(files: File[]) {
  fireEvent.paste(screen.getByTestId('chat-composer-input'), {
    clipboardData: {
      items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
    },
  });
}

function removeAttachmentByName(fileName: string) {
  const preview = screen.getByText(fileName).closest('div.relative');
  fireEvent.click(preview!.querySelector('button')!);
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

function openSettingsPicker() {
  fireEvent.pointerDown(screen.getByTestId('chat-settings-picker-button'), {
    button: 0,
    ctrlKey: false,
  });
}

function openComposerOptionsSubmenu(triggerTestId: string, rowTestId: string) {
  fireEvent.pointerDown(screen.getByTestId(triggerTestId), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByTestId(rowTestId));
}

function openModelSettingsPicker() {
  openSettingsPicker();
  fireEvent.click(screen.getByTestId('chat-settings-model-row'));
}

function openThinkingSettingsPicker() {
  openSettingsPicker();
  fireEvent.click(screen.getByTestId('chat-settings-thinking-row'));
}

describe('ChatInput agent targeting', () => {
  beforeEach(() => {
    agentsState.agents = [];
    agentsState.defaultModelRef = null;
    chatState.currentAgentId = 'main';
    chatState.currentSessionKey = 'agent:main:main';
    chatState.sessions = [];
    chatState.thinkingLevel = null;
    chatState.pendingSessionModelUpdates = {};
    chatState.pendingSessionThinkingUpdates = {};
    chatState.updateSessionModel.mockReset();
    chatState.updateSessionModel.mockResolvedValue(undefined);
    chatState.waitForSessionModelUpdate.mockReset();
    chatState.waitForSessionModelUpdate.mockResolvedValue(undefined);
    chatState.updateSessionThinking.mockReset();
    chatState.updateSessionThinking.mockResolvedValue(undefined);
    chatState.waitForSessionThinkingUpdate.mockReset();
    chatState.waitForSessionThinkingUpdate.mockResolvedValue(undefined);
    gatewayState.status = { state: 'running', port: 18789, gatewayReady: true };
    providersState.accounts = [];
    providersState.statuses = [];
    providersState.defaultAccountId = null;
    providersState.error = null;
    providersState.refreshProviderSnapshot.mockReset();
    managedClientConfigState.textModelPolicy = {
      defaultModel: 'smart-latest',
      defaultThinkingLevel: 'medium',
      models: [
        { id: 'smart-latest', label: 'Smart' },
        { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      ],
    };
    managedClientConfigState.initialized = true;
    managedClientConfigState.loadTextModels.mockReset();
    managedClientConfigState.loadTextModels.mockResolvedValue(managedClientConfigState.textModelPolicy);
    managedClientConfigState.loadVideoModels.mockReset();
    managedClientConfigState.loadVideoModels.mockResolvedValue(managedClientConfigState.videoModelPolicy);
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

  it('keeps stop available while sending even when gateway and composer are disabled', () => {
    gatewayState.status = { state: 'running', port: 18789, gatewayReady: false };
    const onStop = vi.fn();
    render(
      <TooltipProvider>
        <ChatInput onSend={vi.fn()} onStop={onStop} sending disabled />
      </TooltipProvider>,
    );

    const stopButton = screen.getByTestId('chat-composer-send');
    expect(stopButton).not.toBeDisabled();
    fireEvent.click(stopButton);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('disables stop only when its independent cancellation guard is set', () => {
    const onStop = vi.fn();
    render(
      <TooltipProvider>
        <ChatInput onSend={vi.fn()} onStop={onStop} sending stopDisabled />
      </TooltipProvider>,
    );
    const stopButton = screen.getByTestId('chat-composer-send');
    expect(stopButton).toBeDisabled();
    fireEvent.click(stopButton);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('shows the actual disabled reason instead of claiming the gateway is disconnected', () => {
    render(
      <TooltipProvider>
        <ChatInput
          onSend={vi.fn()}
          disabled
          disabledPlaceholder="Loading conversation..."
        />
      </TooltipProvider>,
    );

    const input = screen.getByTestId('chat-composer-input');
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('placeholder', 'Loading conversation...');
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

  it('shows a video-generation indicator and blocks another send while keeping the draft editable', () => {
    render(
      <TooltipProvider>
        <ChatInput onSend={vi.fn()} videoGenerating />
      </TooltipProvider>,
    );

    const indicator = screen.getByRole('status', { name: 'Generating video, please wait…' });
    expect(indicator).toHaveAttribute('data-testid', 'chat-composer-video-generation-indicator');
    expect(screen.queryByTestId('chat-composer-working-indicator')).not.toBeInTheDocument();
    const input = screen.getByTestId('chat-composer-input');
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: 'Queue this after the video' } });
    expect(input).toHaveValue('Queue this after the video');
    expect(screen.getByTestId('chat-composer-send')).toBeDisabled();
  });

  it('keeps the thinking indicator while the foreground turn and video generation overlap', () => {
    render(
      <TooltipProvider>
        <ChatInput onSend={vi.fn()} sending videoGenerating />
      </TooltipProvider>,
    );

    expect(screen.getByRole('status', { name: 'Thinking…' })).toHaveAttribute(
      'data-testid',
      'chat-composer-working-indicator',
    );
    expect(screen.queryByTestId('chat-composer-video-generation-indicator')).not.toBeInTheDocument();
  });

  it('sends per-session image size and quality preferences only while image mode is active', async () => {
    const onSend = vi.fn();
    const view = renderChatInput(onSend);

    expect(screen.queryByTestId('chat-image-options')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chat-composer-mode-image'));
    expect(screen.getByTestId('chat-image-options-trigger')).toHaveTextContent('1:1');
    expect(screen.getByTestId('chat-image-options-trigger')).toHaveTextContent('Medium');

    openComposerOptionsSubmenu('chat-image-options-trigger', 'chat-image-aspect-row');
    fireEvent.click(screen.getByTestId('chat-image-size-3840x2160'));
    openComposerOptionsSubmenu('chat-image-options-trigger', 'chat-image-quality-row');
    fireEvent.click(screen.getByTestId('chat-image-quality-option-high'));
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Create a product photo.' } });
    fireEvent.click(screen.getByTestId('chat-composer-send'));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(
        'Create a product photo.',
        undefined,
        null,
        { size: '3840x2160', quality: 'high' },
      );
    });

    chatState.currentSessionKey = 'agent:main:other';
    view.rerender(
      <TooltipProvider>
        <ChatInput onSend={onSend} />
      </TooltipProvider>,
    );
    expect(screen.queryByTestId('chat-image-options')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-composer-mode-image'));
    expect(screen.getByTestId('chat-image-options-trigger')).toHaveTextContent('1:1');
    expect(screen.getByTestId('chat-image-options-trigger')).toHaveTextContent('Medium');
  });

  it('keeps image controls in the leading action group after the model selector', () => {
    configureAgentAndModelPickers();
    renderChatInput();

    fireEvent.click(screen.getByTestId('chat-composer-mode-image'));

    const leadingActions = screen.getByTestId('chat-composer-leading-actions');
    const settingsPicker = screen.getByTestId('chat-settings-picker-button');
    const imageMode = screen.getByTestId('chat-composer-mode-image');
    const imageOptions = screen.getByTestId('chat-image-options');

    expect(leadingActions).toContainElement(settingsPicker);
    expect(leadingActions).toContainElement(imageMode);
    expect(leadingActions).toContainElement(imageOptions);
    expect(settingsPicker.compareDocumentPosition(imageMode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(imageMode.compareDocumentPosition(imageOptions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps image and video modes mutually exclusive and sends one-turn video options', async () => {
    const onSend = vi.fn();
    renderChatInput(onSend);

    fireEvent.click(screen.getByTestId('chat-composer-mode-image'));
    expect(screen.getByTestId('chat-image-options')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-composer-mode-video'));
    expect(screen.queryByTestId('chat-image-options')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-video-options')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-video-model')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-video-options-trigger')).toHaveTextContent('16:9');
    expect(screen.getByTestId('chat-video-options-trigger')).toHaveTextContent('720P');
    expect(screen.getByTestId('chat-video-options-trigger')).toHaveTextContent('10s');

    openComposerOptionsSubmenu('chat-video-options-trigger', 'chat-video-resolution-row');
    fireEvent.click(screen.getByTestId('chat-video-resolution-option-720p'));
    openComposerOptionsSubmenu('chat-video-options-trigger', 'chat-video-duration-row');
    fireEvent.click(screen.getByTestId('chat-video-duration-option-10'));
    openComposerOptionsSubmenu('chat-video-options-trigger', 'chat-video-aspect-row');
    expect(screen.getByTestId('chat-video-aspect-menu')).toHaveTextContent('2:3');
    expect(screen.getByTestId('chat-video-aspect-menu')).toHaveTextContent('3:2');
    expect(screen.getByTestId('chat-video-aspect-menu')).toHaveTextContent('1:1');
    expect(screen.getByTestId('chat-video-aspect-menu')).toHaveTextContent('9:16');
    expect(screen.getByTestId('chat-video-aspect-menu')).toHaveTextContent('16:9');
    fireEvent.click(screen.getByTestId('chat-video-aspect-9-16'));
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Create a product video.' } });
    fireEvent.click(screen.getByTestId('chat-composer-send'));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(
        'Create a product video.',
        undefined,
        null,
        undefined,
        {
          modelId: 'grok-image-video',
          size: '720x1280',
          mode: 'text-to-video',
          aspectRatio: '9:16',
          resolution: '720P',
          durationSeconds: 10,
        },
      );
    });
  });

  it('keeps the draft intact and blocks video mode when more than one image is attached', async () => {
    const onSend = vi.fn();
    vi.mocked(hostApiDialogOpenMock).mockResolvedValue({
      canceled: false,
      filePaths: ['/tmp/reference-one.png', '/tmp/reference-two.png'],
    });
    vi.mocked(hostApiFetchMock).mockImplementation((path: string) => {
      if (path === '/api/files/stage-paths') {
        return Promise.resolve([
          {
            id: 'reference-one',
            fileName: 'reference-one.png',
            mimeType: 'image/png',
            fileSize: 100,
            stagedPath: '/tmp/staged-reference-one.png',
            preview: null,
          },
          {
            id: 'reference-two',
            fileName: 'reference-two.png',
            mimeType: 'image/png',
            fileSize: 100,
            stagedPath: '/tmp/staged-reference-two.png',
            preview: null,
          },
        ]);
      }
      return Promise.resolve({ success: true, skills: [] });
    });
    renderChatInput(onSend);

    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await waitFor(() => {
      expect(screen.getByText('reference-one.png')).toBeInTheDocument();
      expect(screen.getByText('reference-two.png')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('chat-composer-mode-video'));
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Animate both images.' } });
    fireEvent.click(screen.getByTestId('chat-composer-send'));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('Video generation supports one reference image at a time');
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('Animate both images.');
  });

  it('rejects a file selection above the media attachment limit before staging', async () => {
    vi.mocked(hostApiDialogOpenMock).mockResolvedValue({
      canceled: false,
      filePaths: Array.from({ length: 9 }, (_, index) => `/tmp/attachment-${index}.txt`),
    });
    const onSend = vi.fn();
    renderChatInput(onSend);

    fireEvent.click(screen.getByTestId('chat-composer-attach'));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('A message can include at most 8 attachments');
    });
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/files/stage-paths', expect.anything());
    expect(onSend).not.toHaveBeenCalled();
  });

  it('reserves attachment slots across consecutive selections before staging completes', async () => {
    vi.mocked(hostApiDialogOpenMock)
      .mockResolvedValueOnce({
        canceled: false,
        filePaths: Array.from({ length: 5 }, (_, index) => `/tmp/first-${index}.txt`),
      })
      .mockResolvedValueOnce({
        canceled: false,
        filePaths: Array.from({ length: 4 }, (_, index) => `/tmp/second-${index}.txt`),
      });
    const staged = new Promise<Array<Record<string, unknown>>>(() => {});
    vi.mocked(hostApiFetchMock).mockImplementation((path: string) => (
      path === '/api/files/stage-paths' ? staged : Promise.resolve({ success: true, skills: [] })
    ));
    renderChatInput();

    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await Promise.resolve();
    fireEvent.click(screen.getByTestId('chat-composer-attach'));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('A message can include at most 8 attachments');
    });
    expect(vi.mocked(hostApiFetchMock).mock.calls.filter(([path]) => path === '/api/files/stage-paths'))
      .toHaveLength(1);
  });

  it('keeps all buffer reservations when the first dropped attachment is removed during staging', async () => {
    const firstBuffer = createDeferred<ReturnType<typeof stagedAttachment>>();
    vi.mocked(hostApiFetchMock).mockImplementation((path: string, request?: { body?: string }) => {
      if (path === '/api/files/stage-buffer') {
        const { fileName } = JSON.parse(request!.body!);
        return fileName === 'buffer-0.txt' ? firstBuffer.promise : Promise.resolve(stagedAttachment(fileName));
      }
      if (path === '/api/files/stage-paths') {
        return Promise.resolve([stagedAttachment('replacement.txt')]);
      }
      return Promise.resolve({ success: true, skills: [] });
    });
    vi.mocked(hostApiDialogOpenMock)
      .mockResolvedValueOnce({ canceled: false, filePaths: Array.from({ length: 8 }, (_, i) => `/tmp/extra-${i}.txt`) })
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/replacement.txt'] });
    const onSend = vi.fn();
    const { container } = renderChatInput(onSend);
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Keep this draft' } });
    dropAttachments(container, Array.from({ length: 8 }, (_, i) => new File(['data'], `buffer-${i}.txt`)));
    await waitFor(() => {
      expect(hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/files/stage-buffer')).toHaveLength(1);
    });

    removeAttachmentByName('buffer-0.txt');
    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('A message can include at most 8 attachments');
    });
    expect(hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/files/stage-paths')).toHaveLength(0);
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('Keep this draft');
    expect(screen.getByText('buffer-7.txt')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await screen.findByText('replacement.txt');
    await act(async () => { firstBuffer.resolve(stagedAttachment('buffer-0.txt')); });
    await waitFor(() => { expect(screen.getByTestId('chat-composer-send')).not.toBeDisabled(); });
    expect(screen.queryByText('buffer-0.txt')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chat-composer-send'));
    await waitFor(() => { expect(onSend).toHaveBeenCalledTimes(1); });
    expect(onSend.mock.calls[0][1]).toHaveLength(8);
    expect(onSend.mock.calls[0][1].map((attachment: { fileName: string }) => attachment.fileName))
      .toEqual([...Array.from({ length: 7 }, (_, i) => `buffer-${i + 1}.txt`), 'replacement.txt']);
  });

  it('skips a removed buffer placeholder before its serial staging begins', async () => {
    const firstBuffer = createDeferred<ReturnType<typeof stagedAttachment>>();
    vi.mocked(hostApiFetchMock).mockImplementation((path: string, request?: { body?: string }) => {
      if (path !== '/api/files/stage-buffer') return Promise.resolve({ success: true, skills: [] });
      const { fileName } = JSON.parse(request!.body!);
      return fileName === 'first.txt' ? firstBuffer.promise : Promise.resolve(stagedAttachment(fileName));
    });
    const { container } = renderChatInput();
    dropAttachments(container, [new File(['a'], 'first.txt'), new File(['b'], 'removed.txt')]);
    removeAttachmentByName('removed.txt');
    await act(async () => { firstBuffer.resolve(stagedAttachment('first.txt')); });
    await waitFor(() => { expect(screen.getByTestId('chat-composer-send')).not.toBeDisabled(); });
    expect(hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/files/stage-buffer')).toHaveLength(1);
    expect(screen.queryByText('removed.txt')).not.toBeInTheDocument();
  });

  it('clears only failed attachments without losing pending buffer reservations', async () => {
    const secondBuffer = createDeferred<ReturnType<typeof stagedAttachment>>();
    vi.mocked(hostApiFetchMock).mockImplementation((path: string, request?: { body?: string }) => {
      if (path !== '/api/files/stage-buffer') return Promise.resolve({ success: true, skills: [] });
      const { fileName } = JSON.parse(request!.body!);
      if (fileName === 'paste-0.txt') return Promise.reject(new Error('buffer staging failed'));
      if (fileName === 'paste-1.txt') return secondBuffer.promise;
      return Promise.resolve(stagedAttachment(fileName));
    });
    vi.mocked(hostApiDialogOpenMock).mockResolvedValue({
      canceled: false,
      filePaths: Array.from({ length: 7 }, (_, i) => `/tmp/retry-${i}.txt`),
    });
    renderChatInput();
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Keep after failure' } });
    pasteAttachments(Array.from({ length: 8 }, (_, i) => new File(['data'], `paste-${i}.txt`)));
    fireEvent.click(await screen.findByText('Retry failed attachments'));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('A message can include at most 8 attachments');
    });
    expect(screen.queryByText('paste-0.txt')).not.toBeInTheDocument();
    expect(screen.getByText('paste-7.txt')).toBeInTheDocument();
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('Keep after failure');
    expect(hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/files/stage-paths')).toHaveLength(0);
    await act(async () => { secondBuffer.resolve(stagedAttachment('paste-1.txt')); });
    await waitFor(() => { expect(screen.getByTestId('chat-composer-send')).not.toBeDisabled(); });
  });

  it('releases failed path slots without marking another concurrent selection as failed', async () => {
    const failedBatch = createDeferred<Array<ReturnType<typeof stagedAttachment>>>();
    const healthyBatch = createDeferred<Array<ReturnType<typeof stagedAttachment>>>();
    vi.mocked(hostApiDialogOpenMock)
      .mockResolvedValueOnce({ canceled: false, filePaths: Array.from({ length: 4 }, (_, i) => `/tmp/failed-${i}.txt`) })
      .mockResolvedValueOnce({ canceled: false, filePaths: Array.from({ length: 4 }, (_, i) => `/tmp/healthy-${i}.txt`) })
      .mockResolvedValueOnce({ canceled: false, filePaths: Array.from({ length: 4 }, (_, i) => `/tmp/new-${i}.txt`) })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });
    vi.mocked(hostApiFetchMock).mockImplementation((path: string, request?: { body?: string }) => {
      if (path !== '/api/files/stage-paths') return Promise.resolve({ success: true, skills: [] });
      const { filePaths } = JSON.parse(request!.body!) as { filePaths: string[] };
      if (filePaths[0].includes('failed-')) return failedBatch.promise;
      if (filePaths[0].includes('healthy-')) return healthyBatch.promise;
      return Promise.resolve(filePaths.map((filePath) => stagedAttachment(filePath.split('/').pop()!)));
    });
    const onSend = vi.fn();
    renderChatInput(onSend);
    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await screen.findByText('failed-0.txt');
    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await screen.findByText('healthy-0.txt');
    await act(async () => { failedBatch.reject(new Error('path staging failed')); });
    expect(screen.getAllByText('Error')).toHaveLength(4);

    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await screen.findByText('new-0.txt');
    expect(toastErrorMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Retry failed attachments'));
    expect(screen.queryByText('failed-0.txt')).not.toBeInTheDocument();
    expect(screen.getByText('healthy-0.txt')).toBeInTheDocument();
    expect(screen.getByTestId('chat-composer-send')).toBeDisabled();
    await act(async () => {
      healthyBatch.resolve(Array.from({ length: 4 }, (_, i) => stagedAttachment(`healthy-${i}.txt`)));
    });
    await waitFor(() => { expect(screen.getByTestId('chat-composer-send')).not.toBeDisabled(); });
    fireEvent.click(screen.getByTestId('chat-composer-send'));
    await waitFor(() => { expect(onSend).toHaveBeenCalledTimes(1); });
    expect(onSend.mock.calls[0][1]).toHaveLength(8);
  });

  it.each(['paste', 'drop'])('rejects more than eight %s attachments and preserves the draft', async (source) => {
    const onSend = vi.fn();
    const { container } = renderChatInput(onSend);
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Unsent draft' } });
    const files = Array.from({ length: 9 }, (_, i) => new File(['data'], `oversize-${i}.txt`));
    if (source === 'paste') pasteAttachments(files);
    else dropAttachments(container, files);
    expect(toastErrorMock).toHaveBeenCalledWith('A message can include at most 8 attachments');
    expect(hostApiFetchMock.mock.calls.filter(([path]) => path.startsWith('/api/files/stage-'))).toHaveLength(0);
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('Unsent draft');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('rejects an oversized mixed path and buffer drop as one batch', () => {
    const { container } = renderChatInput();
    const pathFiles = Array.from({ length: 5 }, (_, i) => {
      const file = new File(['data'], `path-${i}.txt`);
      Object.defineProperty(file, 'path', { value: `/tmp/path-${i}.txt` });
      return file;
    });
    dropAttachments(container, [...pathFiles, ...Array.from({ length: 4 }, (_, i) => new File(['data'], `buffer-${i}.txt`))]);
    expect(toastErrorMock).toHaveBeenCalledWith('A message can include at most 8 attachments');
    expect(hostApiFetchMock.mock.calls.filter(([path]) => path.startsWith('/api/files/stage-'))).toHaveLength(0);
  });

  it('reserves slots atomically when two file dialogs resolve together', async () => {
    const firstDialog = createDeferred<{ canceled: boolean; filePaths: string[] }>();
    const secondDialog = createDeferred<{ canceled: boolean; filePaths: string[] }>();
    const staging = createDeferred<Array<ReturnType<typeof stagedAttachment>>>();
    vi.mocked(hostApiDialogOpenMock).mockReturnValueOnce(firstDialog.promise).mockReturnValueOnce(secondDialog.promise);
    vi.mocked(hostApiFetchMock).mockImplementation((path: string) => (
      path === '/api/files/stage-paths' ? staging.promise : Promise.resolve({ success: true, skills: [] })
    ));
    renderChatInput();
    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await act(async () => {
      firstDialog.resolve({ canceled: false, filePaths: Array.from({ length: 5 }, (_, i) => `/tmp/first-${i}.txt`) });
      secondDialog.resolve({ canceled: false, filePaths: Array.from({ length: 4 }, (_, i) => `/tmp/second-${i}.txt`) });
    });
    expect(toastErrorMock).toHaveBeenCalledWith('A message can include at most 8 attachments');
    expect(hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/files/stage-paths')).toHaveLength(1);
    await act(async () => { staging.resolve(Array.from({ length: 5 }, (_, i) => stagedAttachment(`first-${i}.txt`))); });
    await waitFor(() => { expect(screen.getByTestId('chat-composer-send')).not.toBeDisabled(); });
  });

  it('rejects send after new placeholders arrive during model persistence and keeps all draft attachments', async () => {
    const persistence = createDeferred<void>();
    const staging = createDeferred<Array<ReturnType<typeof stagedAttachment>>>();
    vi.mocked(chatState.waitForSessionModelUpdate).mockReturnValueOnce(persistence.promise);
    vi.mocked(hostApiDialogOpenMock).mockResolvedValue({ canceled: false, filePaths: ['/tmp/pending.txt'] });
    vi.mocked(hostApiFetchMock).mockImplementation((path: string) => (
      path === '/api/files/stage-paths' ? staging.promise : Promise.resolve({ success: true, skills: [] })
    ));
    const onSend = vi.fn();
    renderChatInput(onSend);
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Keep while staging' } });
    fireEvent.click(screen.getByTestId('chat-composer-send'));
    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await screen.findByText('pending.txt');
    await act(async () => { persistence.resolve(); });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('Keep while staging');
    expect(screen.getByText('pending.txt')).toBeInTheDocument();
    await act(async () => { staging.resolve([stagedAttachment('pending.txt')]); });
    await waitFor(() => { expect(screen.getByTestId('chat-composer-send')).not.toBeDisabled(); });
    fireEvent.click(screen.getByTestId('chat-composer-send'));
    await waitFor(() => { expect(onSend).toHaveBeenCalledTimes(1); });
    expect(onSend.mock.calls[0][1]).toHaveLength(1);
  });

  it('does not send a removed attachment after awaiting model persistence', async () => {
    const persistence = createDeferred<void>();
    vi.mocked(hostApiDialogOpenMock).mockResolvedValue({ canceled: false, filePaths: ['/tmp/original.txt'] });
    vi.mocked(hostApiFetchMock).mockImplementation((path: string) => (
      path === '/api/files/stage-paths'
        ? Promise.resolve([stagedAttachment('original.txt')])
        : Promise.resolve({ success: true, skills: [] })
    ));
    const onSend = vi.fn();
    renderChatInput(onSend);
    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await waitFor(() => { expect(screen.getByTestId('chat-composer-send')).not.toBeDisabled(); });
    vi.mocked(chatState.waitForSessionModelUpdate).mockReturnValueOnce(persistence.promise);
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Keep after removal' } });
    fireEvent.click(screen.getByTestId('chat-composer-send'));
    removeAttachmentByName('original.txt');
    await act(async () => { persistence.resolve(); });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('Keep after removal');
    expect(screen.queryByText('original.txt')).not.toBeInTheDocument();
  });

  it('releases only missing results from a partially staged path batch', async () => {
    vi.mocked(hostApiDialogOpenMock)
      .mockResolvedValueOnce({ canceled: false, filePaths: Array.from({ length: 8 }, (_, i) => `/tmp/partial-${i}.txt`) })
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/replacement.txt'] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });
    vi.mocked(hostApiFetchMock).mockImplementation((path: string, request?: { body?: string }) => {
      if (path !== '/api/files/stage-paths') return Promise.resolve({ success: true, skills: [] });
      const { filePaths } = JSON.parse(request!.body!) as { filePaths: string[] };
      return Promise.resolve(filePaths.slice(0, filePaths.length === 8 ? 7 : 1)
        .map((filePath) => stagedAttachment(filePath.split('/').pop()!)));
    });
    const onSend = vi.fn();
    renderChatInput(onSend);
    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await screen.findByText('Retry failed attachments');
    expect(screen.getAllByText('Error')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await screen.findByText('replacement.txt');
    expect(toastErrorMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Retry failed attachments'));
    await waitFor(() => { expect(screen.getByTestId('chat-composer-send')).not.toBeDisabled(); });
    fireEvent.click(screen.getByTestId('chat-composer-send'));
    await waitFor(() => { expect(onSend).toHaveBeenCalledTimes(1); });
    expect(onSend.mock.calls[0][1]).toHaveLength(8);
  });

  it('revalidates attachment placeholders after awaiting an extension send guard', async () => {
    const guard = createDeferred<{ ok: boolean }>();
    const staging = createDeferred<Array<ReturnType<typeof stagedAttachment>>>();
    const hasHooks = vi.spyOn(rendererExtensionRegistry, 'hasChatBeforeSendHooks').mockReturnValue(true);
    const beforeSend = vi.spyOn(rendererExtensionRegistry, 'runChatBeforeSend').mockReturnValue(guard.promise);
    vi.mocked(hostApiDialogOpenMock).mockResolvedValue({ canceled: false, filePaths: ['/tmp/guard-pending.txt'] });
    vi.mocked(hostApiFetchMock).mockImplementation((path: string) => (
      path === '/api/files/stage-paths' ? staging.promise : Promise.resolve({ success: true, skills: [] })
    ));
    const onSend = vi.fn();
    renderChatInput(onSend);
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Guarded draft' } });
    try {
      fireEvent.click(screen.getByTestId('chat-composer-send'));
      await waitFor(() => { expect(beforeSend).toHaveBeenCalledTimes(1); });
      fireEvent.click(screen.getByTestId('chat-composer-attach'));
      await screen.findByText('guard-pending.txt');
      await act(async () => { guard.resolve({ ok: true }); });
      expect(onSend).not.toHaveBeenCalled();
      expect(screen.getByTestId('chat-composer-input')).toHaveValue('Guarded draft');
      expect(screen.getByText('guard-pending.txt')).toBeInTheDocument();
      await act(async () => { staging.resolve([stagedAttachment('guard-pending.txt')]); });
    } finally {
      hasHooks.mockRestore();
      beforeSend.mockRestore();
    }
  });

  it('checks the actual send array limit after extension guards and keeps the draft on rejection', async () => {
    const hasHooks = vi.spyOn(rendererExtensionRegistry, 'hasChatBeforeSendHooks').mockReturnValue(true);
    const beforeSend = vi.spyOn(rendererExtensionRegistry, 'runChatBeforeSend').mockImplementation(async (context) => {
      context.attachments!.push(...Array.from({ length: 8 }, (_, i) => ({
        ...stagedAttachment(`guard-extra-${i}.txt`), status: 'ready' as const,
      })));
      return { ok: true };
    });
    vi.mocked(hostApiDialogOpenMock).mockResolvedValue({ canceled: false, filePaths: ['/tmp/original.txt'] });
    vi.mocked(hostApiFetchMock).mockImplementation((path: string) => (
      path === '/api/files/stage-paths'
        ? Promise.resolve([stagedAttachment('original.txt')])
        : Promise.resolve({ success: true, skills: [] })
    ));
    const onSend = vi.fn();
    renderChatInput(onSend);
    try {
      fireEvent.click(screen.getByTestId('chat-composer-attach'));
      await waitFor(() => { expect(screen.getByTestId('chat-composer-send')).not.toBeDisabled(); });
      fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Oversized guarded draft' } });
      fireEvent.click(screen.getByTestId('chat-composer-send'));
      await waitFor(() => { expect(toastErrorMock).toHaveBeenCalledWith('A message can include at most 8 attachments'); });
      expect(onSend).not.toHaveBeenCalled();
      expect(screen.getByTestId('chat-composer-input')).toHaveValue('Oversized guarded draft');
      expect(screen.getByText('original.txt')).toBeInTheDocument();
    } finally {
      hasHooks.mockRestore();
      beforeSend.mockRestore();
    }
  });

  it.each(['text', 'image', 'video'])('preserves a refused async %s send and clears the draft only after acceptance', async (mode) => {
    const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(hostApiDialogOpenMock).mockResolvedValue({ canceled: false, filePaths: ['/tmp/unsent.txt'] });
    vi.mocked(hostApiFetchMock).mockImplementation((path: string) => (
      path === '/api/files/stage-paths'
        ? Promise.resolve([stagedAttachment('unsent.txt')])
        : Promise.resolve({ success: true, skills: [] })
    ));
    renderChatInput(onSend);
    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await waitFor(() => { expect(screen.getByTestId('chat-composer-send')).not.toBeDisabled(); });
    if (mode !== 'text') fireEvent.click(screen.getByTestId(`chat-composer-mode-${mode}`));
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Retain refused draft' } });
    await act(async () => { fireEvent.click(screen.getByTestId('chat-composer-send')); });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][1]).toHaveLength(1);
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('Retain refused draft');
    expect(screen.getByText('unsent.txt')).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByTestId('chat-composer-send')); });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('');
    expect(screen.queryByText('unsent.txt')).not.toBeInTheDocument();
  });

  it.each(['false', 'throw', 'reject'])('keeps the draft and unlocks another send when the host returns %s', async (outcome) => {
    const onSend = vi.fn().mockImplementationOnce(() => {
      if (outcome === 'throw') throw new Error('sync rejection');
      if (outcome === 'reject') return Promise.reject(new Error('async rejection'));
      return false;
    }).mockReturnValue(true);
    renderChatInput(onSend);
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Retry this draft' } });
    await act(async () => { fireEvent.click(screen.getByTestId('chat-composer-send')); });
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('Retry this draft');
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByTestId('chat-composer-send')); });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('');
  });

  it('retains attachments and text added while the host accepts an earlier draft', async () => {
    const accepted = createDeferred<boolean>();
    const onSend = vi.fn().mockReturnValue(accepted.promise);
    vi.mocked(hostApiDialogOpenMock)
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/sent.txt'] })
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/next.txt'] });
    vi.mocked(hostApiFetchMock).mockImplementation((path: string, request?: { body?: string }) => {
      if (path !== '/api/files/stage-paths') return Promise.resolve({ success: true, skills: [] });
      const { filePaths } = JSON.parse(request!.body!) as { filePaths: string[] };
      return Promise.resolve(filePaths.map((filePath) => stagedAttachment(filePath.split('/').pop()!)));
    });
    renderChatInput(onSend);
    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await waitFor(() => { expect(screen.getByTestId('chat-composer-send')).not.toBeDisabled(); });
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Send first draft' } });
    fireEvent.click(screen.getByTestId('chat-composer-send'));
    await waitFor(() => { expect(onSend).toHaveBeenCalledTimes(1); });
    expect(screen.getByText('sent.txt')).toBeInTheDocument();
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('Send first draft');
    fireEvent.click(screen.getByTestId('chat-composer-send'));
    await act(async () => { await Promise.resolve(); });
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Next draft' } });
    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await screen.findByText('next.txt');
    await act(async () => { accepted.resolve(true); });
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('Next draft');
    expect(screen.queryByText('sent.txt')).not.toBeInTheDocument();
    expect(screen.getByText('next.txt')).toBeInTheDocument();
    expect(onSend.mock.calls[0][1]).toHaveLength(1);
  });

  it('preserves attached files when an async send throws', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('host send failed'));
    vi.mocked(hostApiDialogOpenMock).mockResolvedValue({ canceled: false, filePaths: ['/tmp/retained.txt'] });
    vi.mocked(hostApiFetchMock).mockImplementation((path: string) => (
      path === '/api/files/stage-paths'
        ? Promise.resolve([stagedAttachment('retained.txt')])
        : Promise.resolve({ success: true, skills: [] })
    ));
    renderChatInput(onSend);
    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await waitFor(() => { expect(screen.getByTestId('chat-composer-send')).not.toBeDisabled(); });
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Retain failed send' } });
    await act(async () => { fireEvent.click(screen.getByTestId('chat-composer-send')); });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('Retain failed send');
    expect(screen.getByText('retained.txt')).toBeInTheDocument();
  });

  it.each(['sync', 'async'])('treats %s void as an accepted send and clears the sent draft', async (mode) => {
    const onSend = vi.fn().mockImplementation(() => mode === 'async' ? Promise.resolve() : undefined);
    vi.mocked(hostApiDialogOpenMock).mockResolvedValue({ canceled: false, filePaths: ['/tmp/void-accepted.txt'] });
    vi.mocked(hostApiFetchMock).mockImplementation((path: string) => (
      path === '/api/files/stage-paths'
        ? Promise.resolve([stagedAttachment('void-accepted.txt')])
        : Promise.resolve({ success: true, skills: [] })
    ));
    renderChatInput(onSend);
    fireEvent.click(screen.getByTestId('chat-composer-attach'));
    await waitFor(() => { expect(screen.getByTestId('chat-composer-send')).not.toBeDisabled(); });
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Accepted void draft' } });
    await act(async () => { fireEvent.click(screen.getByTestId('chat-composer-send')); });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][1]).toHaveLength(1);
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('');
    expect(screen.queryByText('void-accepted.txt')).not.toBeInTheDocument();
  });

  it('combines model and reasoning into one selector before image mode', () => {
    configureAgentAndModelPickers();
    managedClientConfigState.textModelPolicy.defaultThinkingLevel = 'high';
    renderChatInput();

    const leadingActions = screen.getByTestId('chat-composer-leading-actions');
    const settingsPicker = screen.getByTestId('chat-settings-picker-button');
    const imageMode = screen.getByTestId('chat-composer-mode-image');

    expect(leadingActions).toContainElement(settingsPicker);
    expect(settingsPicker).toHaveTextContent('Smart');
    expect(settingsPicker).toHaveTextContent('High');
    expect(settingsPicker).toHaveAttribute('aria-expanded', 'false');
    expect(settingsPicker).not.toHaveClass('bg-black/[0.07]');
    expect(settingsPicker).not.toHaveClass('dark:bg-white/10');
    expect(settingsPicker).not.toHaveAttribute('aria-pressed');
    expect(screen.getByTestId('chat-composer-mode-image')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('chat-composer-mode-video')).toHaveAttribute('aria-pressed', 'false');
    expect(settingsPicker.compareDocumentPosition(imageMode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps image and video buttons selected only while their generation mode is active', () => {
    renderChatInput();

    const imageMode = screen.getByTestId('chat-composer-mode-image');
    const videoMode = screen.getByTestId('chat-composer-mode-video');
    fireEvent.click(imageMode);
    expect(imageMode).toHaveAttribute('aria-pressed', 'true');
    expect(videoMode).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(videoMode);
    expect(imageMode).toHaveAttribute('aria-pressed', 'false');
    expect(videoMode).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('chat-settings-picker-button')).not.toHaveAttribute('aria-pressed');
  });

  it('opens model or reasoning choices when their settings row is hovered', async () => {
    configureAgentAndModelPickers();
    renderChatInput();

    openSettingsPicker();
    expect(screen.getByTestId('chat-settings-picker-menu')).toBeInTheDocument();
    expect(screen.getByTestId('chat-settings-model-row')).toHaveTextContent('Model');
    expect(screen.getByTestId('chat-settings-model-row')).not.toHaveTextContent('Smart');
    expect(screen.getByTestId('chat-settings-thinking-row')).toHaveTextContent('Reasoning level');
    expect(screen.getByTestId('chat-settings-thinking-row')).not.toHaveTextContent('Medium');

    fireEvent.pointerMove(screen.getByTestId('chat-settings-model-row'), { pointerType: 'mouse' });
    expect(await screen.findByTestId('chat-model-picker-menu')).toBeInTheDocument();
    expect(screen.getByTestId('chat-settings-picker-menu')).toBeInTheDocument();

    fireEvent.pointerMove(screen.getByTestId('chat-settings-thinking-row'), { pointerType: 'mouse' });
    expect(await screen.findByTestId('chat-thinking-picker-menu')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-model-picker-menu')).not.toBeInTheDocument();
  });

  it('resets the current session model and reasoning overrides together', async () => {
    configureAgentAndModelPickers();
    chatState.sessions = [{
      key: chatState.currentSessionKey,
      model: 'openai/deepseek-v4-pro',
      thinkingLevel: 'high',
      thinkingDefault: 'medium',
      thinkingLevels: ['low', 'medium', 'high'].map((id) => ({ id })),
    }];
    renderChatInput();

    openSettingsPicker();
    fireEvent.click(screen.getByTestId('chat-settings-reset'));

    await waitFor(() => {
      expect(chatState.updateSessionModel).toHaveBeenCalledWith('agent:main:main', null);
      expect(chatState.updateSessionThinking).toHaveBeenCalledWith('agent:main:main', null);
    });
    expect(screen.queryByTestId('chat-settings-picker-menu')).not.toBeInTheDocument();
  });

  it('persists a thinking-level selection only for the current session', async () => {
    configureAgentAndModelPickers();
    chatState.sessions = [{
      key: chatState.currentSessionKey,
      model: 'openai/smart-latest',
      thinkingLevel: 'medium',
      thinkingDefault: 'medium',
      thinkingLevels: ['low', 'medium', 'high'].map((id) => ({ id })),
    }];

    renderChatInput();
    openThinkingSettingsPicker();
    fireEvent.click(screen.getByTestId('chat-thinking-option-high'));

    await waitFor(() => {
      expect(chatState.updateSessionThinking).toHaveBeenCalledWith('agent:main:main', 'high');
    });
  });

  it('does not expose xhigh when the Gateway has not published reasoning capabilities', () => {
    configureAgentAndModelPickers();
    chatState.sessions = [{
      key: chatState.currentSessionKey,
      model: 'openai/smart-latest',
    }];

    renderChatInput();
    openThinkingSettingsPicker();

    expect(screen.getByTestId('chat-thinking-option-high')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-thinking-option-xhigh')).not.toBeInTheDocument();
  });

  it('clears a stale reasoning override rejected by the current model capabilities', async () => {
    configureAgentAndModelPickers();
    chatState.sessions = [{
      key: chatState.currentSessionKey,
      model: 'openai/smart-latest',
      thinkingLevel: 'xhigh',
      thinkingDefault: 'off',
      thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'].map((id) => ({ id })),
    }];

    renderChatInput();

    await waitFor(() => {
      expect(chatState.updateSessionThinking).toHaveBeenCalledWith('agent:main:main', null);
    });
    openThinkingSettingsPicker();
    expect(screen.queryByTestId('chat-thinking-option-xhigh')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-thinking-option-inherit')).toHaveAttribute('data-state', 'checked');
  });

  it('keeps xhigh available when the Gateway declares it for the current model', () => {
    configureAgentAndModelPickers();
    chatState.sessions = [{
      key: chatState.currentSessionKey,
      model: 'custom/reasoning-model',
      thinkingLevel: 'xhigh',
      thinkingDefault: 'high',
      thinkingLevels: ['low', 'medium', 'high', 'xhigh'].map((id) => ({ id })),
    }];

    renderChatInput();
    openThinkingSettingsPicker();

    expect(screen.getByTestId('chat-thinking-option-xhigh')).toHaveAttribute('data-state', 'checked');
    expect(chatState.updateSessionThinking).not.toHaveBeenCalled();
  });

  it('waits for pending thinking persistence before sending', async () => {
    const thinkingUpdate = createDeferred<void>();
    const onSend = vi.fn();
    configureAgentAndModelPickers();
    chatState.pendingSessionThinkingUpdates['agent:main:main'] = true;
    chatState.waitForSessionThinkingUpdate.mockImplementation(() => thinkingUpdate.promise);

    renderChatInput(onSend);
    const input = screen.getByTestId('chat-composer-input');
    fireEvent.change(input, { target: { value: 'Use the selected reasoning level' } });
    expect(screen.getByTestId('chat-composer-send')).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    expect(chatState.waitForSessionModelUpdate).toHaveBeenCalledWith('agent:main:main');
    expect(chatState.waitForSessionThinkingUpdate).toHaveBeenCalledWith('agent:main:main');

    await act(async () => {
      delete chatState.pendingSessionThinkingUpdates['agent:main:main'];
      thinkingUpdate.resolve();
      await thinkingUpdate.promise;
    });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('Use the selected reasoning level', undefined, null);
    });
  });

  it('shows only text models supplied by managed client-config', () => {
    configureAgentAndModelPickers();

    renderChatInput();
    openModelSettingsPicker();

    expect(screen.getByTestId('chat-model-picker-menu')).toHaveTextContent('Smart');
    expect(screen.getByTestId('chat-model-picker-menu')).toHaveTextContent('DeepSeek V4 Pro');
    expect(screen.getByTestId('chat-model-picker-menu')).not.toHaveTextContent('Alpha');
    expect(screen.getByTestId('chat-model-picker-menu')).not.toHaveTextContent('Beta');
  });

  it('persists a model selection only for the current session', async () => {
    configureAgentAndModelPickers();

    renderChatInput();
    openModelSettingsPicker();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek V4 Pro' }));

    await waitFor(() => {
      expect(chatState.updateSessionModel).toHaveBeenCalledWith(
        'agent:main:main',
        'openai/deepseek-v4-pro',
      );
    });
    expect(screen.getByTestId('chat-settings-picker-button')).toHaveTextContent('DeepSeek V4 Pro');
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
    openModelSettingsPicker();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek V4 Pro' }));

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
    openModelSettingsPicker();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek V4 Pro' }));
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
      defaultThinkingLevel: 'medium',
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
    openModelSettingsPicker();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek V4 Pro' }));
    openModelSettingsPicker();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'GLM 5' }));

    expect(screen.getByTestId('chat-settings-picker-button')).toHaveTextContent('GLM 5');

    await act(async () => {
      finalUpdate.resolve();
      await finalUpdate.promise;
      firstUpdate.reject(new Error('older model update failed'));
      await firstUpdate.promise.catch(() => undefined);
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
    expect(screen.getByTestId('chat-settings-picker-button')).toHaveTextContent('GLM 5');
  });

  it('clears the current session override when selecting the managed default model', async () => {
    configureAgentAndModelPickers();
    chatState.sessions = [{
      key: chatState.currentSessionKey,
      model: 'openai/deepseek-v4-pro',
    }];

    renderChatInput();
    openModelSettingsPicker();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Smart' }));

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

  it('does not replace a configured personal Provider model with the managed default', async () => {
    configureAgentAndModelPickers();
    chatState.sessions = [{
      key: chatState.currentSessionKey,
      model: 'custom-aaaaaaaa/gpt-a',
    }];
    const onSend = vi.fn();

    renderChatInput(onSend);
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Use my Provider' } });
    fireEvent.click(screen.getByTestId('chat-composer-send'));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('Use my Provider', undefined, null);
    });
    expect(chatState.updateSessionModel).not.toHaveBeenCalled();
  });

  it('does not replace a personal OpenAI model with the managed default', async () => {
    const now = '2025-01-01T00:00:00.000Z';
    chatState.sessions = [{
      key: chatState.currentSessionKey,
      model: 'openai/gpt-5.5',
    }];
    providersState.accounts = [{
      id: 'openai-personal',
      vendorId: 'openai',
      label: 'Personal OpenAI',
      authMode: 'api_key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
      enabled: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    }];
    providersState.statuses = [{
      id: 'openai-personal',
      name: 'Personal OpenAI',
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
      enabled: true,
      hasKey: true,
      keyMasked: 'sk-***',
      createdAt: now,
      updatedAt: now,
    }];
    providersState.defaultAccountId = 'openai-personal';
    const onSend = vi.fn();

    renderChatInput(onSend);
    fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: 'Use personal OpenAI' } });
    fireEvent.click(screen.getByTestId('chat-composer-send'));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('Use personal OpenAI', undefined, null);
    });
    expect(chatState.updateSessionModel).not.toHaveBeenCalled();
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

    openModelSettingsPicker();
    expect(screen.getByTestId('chat-model-picker-menu')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-composer-agent'));

    expect(screen.queryByTestId('chat-model-picker-menu')).not.toBeInTheDocument();
    expect(screen.getByText('Research')).toBeInTheDocument();
  });

  it('closes an open model picker when opening the skill picker', async () => {
    configureAgentAndModelPickers();

    renderChatInput();

    openModelSettingsPicker();
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

  it('keeps the ACP composer enabled when a running gateway omits the optional readiness flag', async () => {
    const onSend = vi.fn();
    gatewayState.status = { state: 'running', port: 18789 };
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
    expect(screen.getByTestId('chat-settings-picker-button')).not.toBeDisabled();

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

    expect(screen.getByTestId('chat-composer-input')).toBeDisabled();
    expect(screen.getByText(/gateway starting \| port: 18789/i)).toBeInTheDocument();
  });

  it('shows the bounded connection retry attempt in the composer', () => {
    gatewayState.status = {
      state: 'starting',
      port: 18789,
      gatewayReady: false,
      connectionAttempt: 2,
      connectionMaxAttempts: 5,
    };

    renderChatInput();

    expect(screen.getByText(/gateway retrying connection \(2\/5\) \| port: 18789/i)).toBeInTheDocument();
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
