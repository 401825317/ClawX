import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cleanupSessionMock } = vi.hoisted(() => ({
  cleanupSessionMock: vi.fn(),
}));

vi.mock('@electron/utils/chat-session-cleanup', () => ({
  deleteLocalChatSession: (...args: unknown[]) => cleanupSessionMock(...args),
}));

const input = {
  roleName: 'Product Lead',
  responsibility: 'Own product planning and delivery.',
  avatarId: 'strategist',
  locale: 'en',
};

const generatedProfile = {
  roleName: 'Product Lead',
  personaName: 'Lin - Product Lead',
  responsibility: 'Own product planning and delivery.',
  capabilities: ['Roadmap planning', 'Requirement analysis', 'Delivery coordination'],
  boundaries: ['Confirm material scope changes'],
  workspaceInstructions: 'Keep decisions concrete and traceable.',
  welcomeMessage: 'Ready to plan the next milestone.',
};

describe('Agent profile generation Gateway service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cleanupSessionMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a hidden main-Agent session, sends without delivery, and returns the completed profile', async () => {
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'chat.history') {
        return { messages: [{ role: 'assistant', content: JSON.stringify(generatedProfile) }] };
      }
      if (method === 'sessions.list') {
        return { sessions: [{ key: params.sessionKey, status: 'completed' }] };
      }
      return {};
    });
    const { generateAgentProfileViaGateway } = await import('@electron/services/agent-profile-generation-service');

    const resultPromise = generateAgentProfileViaGateway({ gatewayManager: { rpc } as never }, input);
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toEqual({ ...generatedProfile, avatarId: 'strategist' });

    const createCall = rpc.mock.calls.find(([method]) => method === 'sessions.create');
    const sendCall = rpc.mock.calls.find(([method]) => method === 'chat.send');
    const historyCall = rpc.mock.calls.find(([method]) => method === 'chat.history');
    const sessionKey = (createCall?.[1] as { key?: string })?.key;
    expect(sessionKey).toMatch(/^agent:main:uclaw-profile-/);
    expect(createCall).toEqual(['sessions.create', { key: sessionKey, agentId: 'main' }, 15_000]);
    expect(sendCall?.[1]).toMatchObject({ sessionKey, deliver: false });
    expect(historyCall).toEqual([
      'chat.history',
      { sessionKey, limit: 20, maxChars: 80_000 },
      6_000,
    ]);
    expect(rpc).toHaveBeenCalledWith('chat.abort', { sessionKey }, 15_000);
    expect(cleanupSessionMock).toHaveBeenCalledWith(sessionKey);
  });

  it('uses the local fallback only after two consecutive chat.history timeouts', async () => {
    let historyAttempts = 0;
    const rpc = vi.fn(async (method: string) => {
      if (method === 'chat.history') {
        historyAttempts += 1;
        throw new Error('RPC timeout: chat.history');
      }
      return {};
    });
    const { generateAgentProfileViaGateway } = await import('@electron/services/agent-profile-generation-service');

    const resultPromise = generateAgentProfileViaGateway({ gatewayManager: { rpc } as never }, input);
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toMatchObject({
      roleName: input.roleName,
      responsibility: input.responsibility,
      avatarId: input.avatarId,
    });
    expect(historyAttempts).toBe(2);
    expect(cleanupSessionMock).toHaveBeenCalledTimes(1);
  });

  it('propagates assistant/provider failures and still aborts and cleans the hidden session', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'chat.history') {
        return {
          messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'model quota exhausted' }],
        };
      }
      return {};
    });
    const { generateAgentProfileViaGateway } = await import('@electron/services/agent-profile-generation-service');

    const resultPromise = generateAgentProfileViaGateway({ gatewayManager: { rpc } as never }, input);
    const rejection = expect(resultPromise).rejects.toThrow('model quota exhausted');
    await vi.runAllTimersAsync();
    await rejection;

    const createCall = rpc.mock.calls.find(([method]) => method === 'sessions.create');
    const sessionKey = (createCall?.[1] as { key?: string })?.key;
    expect(rpc).toHaveBeenCalledWith('chat.abort', { sessionKey }, 15_000);
    expect(cleanupSessionMock).toHaveBeenCalledWith(sessionKey);
  });
});
