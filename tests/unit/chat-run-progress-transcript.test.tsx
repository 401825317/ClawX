import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const hostApiFetchMock = vi.fn();

const { gatewayState, agentsState } = vi.hoisted(() => ({
  gatewayState: {
    status: { state: 'running', port: 18789 },
  },
  agentsState: {
    agents: [{ id: 'main', name: 'main' }] as Array<Record<string, unknown>>,
    fetchAgents: vi.fn(),
  },
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

vi.mock('@/stores/artifact-panel', () => {
  const state = {
    open: false,
    widthPct: 45,
    openChanges: vi.fn(),
    openPreview: vi.fn(),
    close: vi.fn(),
  };
  return {
    useArtifactPanel: (selector: (value: typeof state) => unknown) => selector(state),
  };
});

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: () => undefined,
  },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown> | string) => {
      if (typeof params === 'string') return params;
      if (key === 'executionGraph.collapsedSummary') {
        return `collapsed ${String(params?.toolCount ?? '')} ${String(params?.processCount ?? '')}`.trim();
      }
      if (key === 'executionGraph.agentRun') return 'Main execution';
      if (key === 'executionGraph.title') return 'Execution Graph';
      if (key === 'executionGraph.collapseAction') return 'Collapse';
      if (key === 'executionGraph.thinkingLabel') return 'Thinking';
      if (key.startsWith('taskPanel.stepStatus.')) {
        return key.split('.').at(-1) ?? key;
      }
      return key;
    },
  }),
}));

vi.mock('@/hooks/use-stick-to-bottom-instant', () => ({
  useStickToBottomInstant: vi.fn(() => ({
    contentRef: { current: null },
    scrollRef: { current: null },
    scrollToBottom: vi.fn(),
    isAtBottom: true,
  })),
}));

vi.mock('@/hooks/use-min-loading', () => ({
  useMinLoading: () => false,
}));

vi.mock('@/pages/Chat/ChatToolbar', () => ({
  ChatToolbar: () => null,
}));

vi.mock('@/pages/Chat/ChatInput', () => ({
  ChatInput: ({ sending }: { sending?: boolean }) => (
    <div data-testid="mock-chat-input" data-sending={sending ? 'true' : 'false'} />
  ),
}));

vi.mock('@/pages/Chat/ChatMessage', () => ({
  ChatMessage: ({
    message,
    textOverride,
    isStreaming,
    suppressAssistantText,
  }: {
    message: { content?: unknown };
    textOverride?: string;
    isStreaming?: boolean;
    suppressAssistantText?: boolean;
  }) => {
    const text = typeof textOverride === 'string'
      ? textOverride
      : typeof message?.content === 'string'
        ? message.content
        : Array.isArray(message?.content)
          ? message.content
            .filter((block): block is { type?: string; text?: string } => typeof block === 'object' && block !== null)
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join(' ')
          : '';
    return (
      <div data-testid={isStreaming ? 'mock-streaming-message' : 'mock-chat-message'}>
        {suppressAssistantText ? '' : text}
      </div>
    );
  },
}));

async function setChatDevMode(value: boolean): Promise<void> {
  const { useSettingsStore } = await import('@/stores/settings');
  useSettingsStore.setState({ devModeUnlocked: value });
}

describe('Chat run progress transcript', () => {
  beforeEach(async () => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
    hostApiFetchMock.mockResolvedValue({ success: true, messages: [] });
    agentsState.fetchAgents.mockReset();
    await setChatDevMode(false);

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        {
          role: 'user',
          content: '帮我打开 QQMusic 并播放一首歌',
          timestamp: Date.now() / 1000,
        },
        {
          role: 'assistant',
          content: '我已经尝试打开 QQMusic 了，不过当前环境里还没法稳定代你完成应用内搜歌和播放。',
          timestamp: Date.now() / 1000,
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: false,
      activeRunId: 'run-open-music',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
      runtimeRuns: {
        'run-open-music': {
          runId: 'run-open-music',
          sessionKey: 'agent:main:main',
          status: 'completed',
          startedAt: 1773281731000,
          lastEventAt: 1773281735000,
          endedAt: 1773281735000,
          objective: '帮我打开 QQMusic 并播放一首歌',
          planSummary: 'UClaw 已接管本轮任务执行。',
          planSteps: [],
          artifacts: [],
          verifications: [],
          issues: [],
          checkpoints: [],
          gateEvaluations: [],
          gateResult: undefined,
          assistantText: '',
          thinkingText: '',
          progressEntries: [
            {
              id: 'progress:tool:call-open:commentary',
              kind: 'commentary',
              text: '我先尝试打开 QQMusic。',
            },
            {
              id: 'progress:tool:call-open',
              kind: 'action',
              text: '已运行',
              status: 'completed',
              command: 'open -a "QQMusic"',
            },
          ],
          events: [
            {
              type: 'tool.started',
              runId: 'run-open-music',
              sessionKey: 'agent:main:main',
              toolCallId: 'call-open',
              name: 'exec',
              args: { command: 'open -a "QQMusic"' },
              ts: 1773281731100,
            },
            {
              type: 'tool.completed',
              runId: 'run-open-music',
              sessionKey: 'agent:main:main',
              toolCallId: 'call-open',
              name: 'exec',
              result: { ok: true },
              isError: false,
              ts: 1773281732100,
            },
          ],
        },
      },
    });
  });

  it('renders the compact transcript as the default surface without exposing the execution graph', async () => {
    const { Chat } = await import('@/pages/Chat/index');

    render(<Chat />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-run-progress')).toBeInTheDocument();
    });

    expect(screen.getByText('我先尝试打开 QQMusic。')).toBeInTheDocument();
    expect(screen.getByText('已运行')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-execution-graph')).not.toBeInTheDocument();
  });

  it('surfaces live streaming commentary in the transcript without exposing the execution graph', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        {
          role: 'user',
          content: '帮我先读一下这个文件再总结',
          timestamp: Date.now() / 1000,
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: true,
      activeRunId: 'run-live-commentary',
      streamingText: '',
      streamingMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: '我先读一下文件，马上给你结论。' }],
      },
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
      runtimeRuns: {
        'run-live-commentary': {
          runId: 'run-live-commentary',
          sessionKey: 'agent:main:main',
          status: 'running',
          startedAt: 1773281731000,
          lastEventAt: 1773281732000,
          objective: '读取文件并总结',
          planSummary: '',
          planSteps: [],
          artifacts: [],
          verifications: [],
          issues: [],
          checkpoints: [],
          gateEvaluations: [],
          gateResult: undefined,
          assistantText: '',
          thinkingText: '',
          progressEntries: [],
          events: [
            {
              type: 'tool.started',
              runId: 'run-live-commentary',
              sessionKey: 'agent:main:main',
              toolCallId: 'call-read-file',
              name: 'read',
              args: { filePath: '/tmp/demo.md' },
              ts: 1773281731100,
            },
          ],
        },
      },
    });

    const { Chat } = await import('@/pages/Chat/index');

    render(<Chat />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-run-progress')).toBeInTheDocument();
    });

    expect(screen.getByText('我先读一下文件，马上给你结论。')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-execution-graph')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-streaming-message')).not.toBeInTheDocument();
  });
});
