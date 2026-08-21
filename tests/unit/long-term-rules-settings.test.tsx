// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LongTermRule } from '@shared/long-term-rules';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeRule(id: string, content = `Rule ${id}`): LongTermRule {
  return {
    id,
    scope: 'agent',
    agentId: 'main',
    content,
    enabled: true,
    version: 1,
    createdAt: '2026-08-19T08:00:00.000Z',
    updatedAt: '2026-08-19T08:00:00.000Z',
  };
}

const enabled = (rules: LongTermRule[]) => ({ status: 'enabled' as const, rules });
const disabled = () => ({ status: 'disabled' as const, rules: [] as LongTermRule[] });

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  fetchAgents: vi.fn(),
  list: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  undo: vi.fn(),
  update: vi.fn(),
  state: {
    agents: [{ id: 'main' }] as Array<{ id: string; workspace?: string }>,
    chatWorkspacePath: 'C:\\workspace-a',
    currentAgentId: 'main',
    currentSessionKey: null as string | null,
    sessions: [] as Array<{ key: string; cwd?: string }>,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: 'en' },
  }),
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    longTermRules: {
      list: (...args: unknown[]) => mocks.list(...args),
      create: (...args: unknown[]) => mocks.create(...args),
      update: (...args: unknown[]) => mocks.update(...args),
      delete: (...args: unknown[]) => mocks.delete(...args),
      undo: (...args: unknown[]) => mocks.undo(...args),
    },
  },
}));

vi.mock('@/lib/workspace-context', () => ({
  resolveEffectiveWorkspace: ({
    session,
    globalWorkspace,
  }: {
    session: { cwd?: string } | null;
    globalWorkspace: string;
  }) => ({ cwd: session?.cwd || globalWorkspace }),
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: (selector: (state: unknown) => unknown) => selector({
    agents: mocks.state.agents,
    fetchAgents: mocks.fetchAgents,
  }),
}));

vi.mock('@/stores/chat', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({
    currentAgentId: mocks.state.currentAgentId,
    currentSessionKey: mocks.state.currentSessionKey,
    sessions: mocks.state.sessions,
  }),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector({
    chatWorkspacePath: mocks.state.chatWorkspacePath,
  }),
}));

import { LongTermRulesSettings } from '@/components/settings/LongTermRulesSettings';

describe('LongTermRulesSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.agents = [{ id: 'main' }];
    mocks.state.chatWorkspacePath = 'C:\\workspace-a';
    mocks.state.currentAgentId = 'main';
    mocks.state.currentSessionKey = null;
    mocks.state.sessions = [];
    mocks.list.mockResolvedValue(enabled([]));
    mocks.create.mockResolvedValue({ rules: [] });
    mocks.update.mockResolvedValue({ rules: [] });
    mocks.delete.mockResolvedValue({ rules: [] });
    mocks.undo.mockResolvedValue({ rules: [] });
  });

  it('renders an accurate disabled state without editable controls when the gate is disabled', async () => {
    mocks.list.mockResolvedValue(disabled());

    render(<LongTermRulesSettings />);

    expect(await screen.findByText('longTermRules.disabledTitle')).toBeInTheDocument();
    expect(screen.getByText('longTermRules.disabledDescription')).toBeInTheDocument();
    expect(screen.getByTestId('settings-long-term-rules')).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByTestId('long-term-rule-new-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('long-term-rule-create')).not.toBeInTheDocument();
    expect(screen.queryByTestId('long-term-rule-scope-agent')).not.toBeInTheDocument();
    expect(screen.queryByTestId('long-term-rules-empty')).not.toBeInTheDocument();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('clears the old context immediately and ignores stale workspace and Agent responses', async () => {
    const workspaceB = deferred<ReturnType<typeof enabled>>();
    const agentB = deferred<ReturnType<typeof enabled>>();
    const workspaceBRules = [makeRule('workspace-b', 'Workspace B stale rule')];
    const agentBRules = [makeRule('agent-b', 'Agent B current rule')];

    mocks.list.mockImplementation(({ agentId, workspaceRoot }: { agentId: string; workspaceRoot: string }) => {
      if (agentId === 'agent-b') return agentB.promise;
      if (workspaceRoot === 'C:\\workspace-b') return workspaceB.promise;
      return Promise.resolve(enabled([makeRule('workspace-a', 'Workspace A old rule')]));
    });

    const { rerender } = render(<LongTermRulesSettings />);
    expect(await screen.findByText('Workspace A old rule')).toBeInTheDocument();

    mocks.state.chatWorkspacePath = 'C:\\workspace-b';
    rerender(<LongTermRulesSettings />);

    expect(screen.queryByText('Workspace A old rule')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-long-term-rules')).toHaveAttribute('aria-busy', 'true');

    mocks.state.agents = [{ id: 'main' }, { id: 'agent-b', workspace: 'C:\\agent-b-workspace' }];
    mocks.state.currentAgentId = 'agent-b';
    rerender(<LongTermRulesSettings />);

    await act(async () => {
      agentB.resolve(enabled(agentBRules));
      await agentB.promise;
    });
    expect(await screen.findByText('Agent B current rule')).toBeInTheDocument();

    await act(async () => {
      workspaceB.resolve(enabled(workspaceBRules));
      await workspaceB.promise;
    });
    expect(screen.getByText('Agent B current rule')).toBeInTheDocument();
    expect(screen.queryByText('Workspace B stale rule')).not.toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith({
      agentId: 'agent-b',
      workspaceRoot: 'C:\\agent-b-workspace',
    });
  });

  it('rejects an old response after switching away and returning to the same context key', async () => {
    const firstWorkspaceA = deferred<ReturnType<typeof enabled>>();
    const workspaceB = deferred<ReturnType<typeof enabled>>();
    const secondWorkspaceA = deferred<ReturnType<typeof enabled>>();
    mocks.list
      .mockImplementationOnce(() => firstWorkspaceA.promise)
      .mockImplementationOnce(() => workspaceB.promise)
      .mockImplementationOnce(() => secondWorkspaceA.promise);

    const { rerender } = render(<LongTermRulesSettings />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));

    mocks.state.chatWorkspacePath = 'C:\\workspace-b';
    rerender(<LongTermRulesSettings />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));

    mocks.state.chatWorkspacePath = 'C:\\workspace-a';
    rerender(<LongTermRulesSettings />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));

    await act(async () => {
      secondWorkspaceA.resolve(enabled([makeRule('current-a', 'Current Workspace A rule')]));
      await secondWorkspaceA.promise;
    });
    expect(await screen.findByText('Current Workspace A rule')).toBeInTheDocument();

    await act(async () => {
      firstWorkspaceA.resolve(enabled([makeRule('stale-a', 'Stale Workspace A rule')]));
      workspaceB.resolve(enabled([makeRule('stale-b', 'Stale Workspace B rule')]));
      await Promise.all([firstWorkspaceA.promise, workspaceB.promise]);
    });

    expect(screen.getByText('Current Workspace A rule')).toBeInTheDocument();
    expect(screen.queryByText('Stale Workspace A rule')).not.toBeInTheDocument();
    expect(screen.queryByText('Stale Workspace B rule')).not.toBeInTheDocument();
  });

  it('exposes loading and error states, retries explicitly, and maintains aria-busy', async () => {
    const firstLoad = deferred<ReturnType<typeof enabled>>();
    const retryLoad = deferred<ReturnType<typeof enabled>>();
    mocks.list
      .mockImplementationOnce(() => firstLoad.promise)
      .mockImplementationOnce(() => retryLoad.promise);

    render(<LongTermRulesSettings />);

    expect(screen.getByTestId('settings-long-term-rules')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('longTermRules.loading')).toBeInTheDocument();
    expect(screen.queryByTestId('long-term-rule-new-content')).not.toBeInTheDocument();

    await act(async () => {
      firstLoad.reject(new Error('synthetic load failure'));
      await firstLoad.promise.catch(() => undefined);
    });

    expect(await screen.findByText('longTermRules.loadFailed')).toBeInTheDocument();
    expect(screen.getByTestId('settings-long-term-rules')).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByTestId('long-term-rule-new-content')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'longTermRules.retry' }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('settings-long-term-rules')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('longTermRules.loading')).toBeInTheDocument();

    await act(async () => {
      retryLoad.resolve(enabled([]));
      await retryLoad.promise;
    });

    expect(await screen.findByTestId('long-term-rules-empty')).toBeInTheDocument();
    expect(screen.getByTestId('settings-long-term-rules')).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByText('longTermRules.loadFailed')).not.toBeInTheDocument();
  });

  it('tracks concurrent mutations independently until each request settles', async () => {
    const rules = [makeRule('rule-a'), makeRule('rule-b')];
    const updateA = deferred<{ rules: LongTermRule[] }>();
    const updateB = deferred<{ rules: LongTermRule[] }>();
    mocks.list.mockResolvedValue(enabled(rules));
    mocks.update.mockImplementation(({ id }: { id: string }) => (
      id === 'rule-a' ? updateA.promise : updateB.promise
    ));

    render(<LongTermRulesSettings />);

    const articleA = await screen.findByTestId('long-term-rule-rule-a');
    const articleB = screen.getByTestId('long-term-rule-rule-b');
    const switchA = within(articleA).getByRole('switch');
    const switchB = within(articleB).getByRole('switch');

    fireEvent.click(switchA);
    fireEvent.click(switchB);

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(switchA).toBeDisabled();
    expect(switchB).toBeDisabled();
    expect(screen.getByTestId('settings-long-term-rules')).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      updateA.resolve({ rules });
      await updateA.promise;
    });
    await waitFor(() => expect(within(articleA).getByRole('switch')).not.toBeDisabled());
    expect(within(articleB).getByRole('switch')).toBeDisabled();
    expect(screen.getByTestId('settings-long-term-rules')).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      updateB.resolve({ rules });
      await updateB.promise;
    });
    await waitFor(() => expect(within(articleB).getByRole('switch')).not.toBeDisabled());
    expect(screen.getByTestId('settings-long-term-rules')).toHaveAttribute('aria-busy', 'false');
  });

  it('allows rule metadata to wrap in narrow settings panes', async () => {
    mocks.list.mockResolvedValue(enabled([makeRule('layout')]));

    render(<LongTermRulesSettings />);

    const article = await screen.findByTestId('long-term-rule-layout');
    const metadata = within(article).getByText('longTermRules.scopeAgent').parentElement;
    expect(metadata).not.toBeNull();
    expect(metadata).toHaveClass('flex', 'flex-wrap');
    expect(metadata).not.toHaveClass('whitespace-nowrap');
  });
});
