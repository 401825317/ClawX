import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChatToolbar } from '@/pages/Chat/ChatToolbar';

const { chatState, agentsState, artifactPanelState } = vi.hoisted(() => ({
  chatState: {
    refresh: vi.fn(),
    switchSession: vi.fn(),
    loading: false,
    sending: false,
    currentAgentId: 'main',
    sessions: [
      { key: 'agent:main:main', status: 'completed', hasActiveRun: false },
      { key: 'agent:research:main', status: 'completed', hasActiveRun: false },
    ],
  },
  agentsState: {
    agents: [
      {
        id: 'main',
        name: 'Main Agent',
        mainSessionKey: 'agent:main:main',
        modelDisplay: '智能路由',
      },
      {
        id: 'research',
        name: 'Research Agent',
        mainSessionKey: 'agent:research:main',
        modelDisplay: '智能路由',
      },
    ],
  },
  artifactPanelState: {
    openBrowser: vi.fn(),
    open: false,
    tab: 'preview',
    close: vi.fn(),
  },
}));

vi.mock('@/stores/chat', () => ({
  useChatStore: (selector: (state: typeof chatState) => unknown) => selector(chatState),
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

vi.mock('@/stores/artifact-panel', () => ({
  useArtifactPanel: (selector: (state: typeof artifactPanelState) => unknown) => selector(artifactPanelState),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, variables?: Record<string, unknown>) => {
      if (key === 'toolbar.currentAgent') {
        return `当前对话对象：${String(variables?.agent ?? '')}`;
      }
      if (key === 'toolbar.agentSwitcher') return '选择 Agent';
      if (key === 'toolbar.agentRunning') return '运行中';
      return key;
    },
  }),
}));

describe('ChatToolbar Agent switcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatState.currentAgentId = 'main';
  });

  it('switches to the selected Agent main session', async () => {
    render(
      <TooltipProvider>
        <ChatToolbar />
      </TooltipProvider>,
    );

    fireEvent.pointerDown(screen.getByTestId('chat-agent-switcher'), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Research Agent/ }));

    expect(chatState.switchSession).toHaveBeenCalledWith('agent:research:main');
  });
});
