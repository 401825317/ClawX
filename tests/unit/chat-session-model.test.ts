import { beforeEach, describe, expect, it, vi } from 'vitest';

const { gatewayRpcMock } = vi.hoisted(() => ({
  gatewayRpcMock: vi.fn(),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      rpc: gatewayRpcMock,
    }),
  },
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => ({ agents: [] }),
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    media: { thumbnails: vi.fn(async () => ({})) },
    sessions: {
      delete: vi.fn(async () => ({ success: true })),
      rename: vi.fn(async () => ({ success: true })),
      summaries: vi.fn(async () => ({ summaries: [] })),
      history: vi.fn(async () => ({ messages: [] })),
    },
    chat: { sendWithMedia: vi.fn(async () => ({ success: true })) },
  },
}));

async function loadStore() {
  const { useChatStore } = await import('@/stores/chat');
  return useChatStore;
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

describe('chat session model selection', () => {
  beforeEach(() => {
    vi.resetModules();
    gatewayRpcMock.mockReset();
  });

  it('patches only an existing session model', async () => {
    gatewayRpcMock.mockResolvedValue({
      resolved: { modelProvider: 'openai', model: 'deepseek-v4-pro' },
    });
    const store = await loadStore();
    store.setState({
      sessions: [
        { key: 'agent:main:main', model: 'openai/smart-latest' },
        { key: 'agent:main:other', model: 'openai/smart-latest' },
      ],
    });

    await store.getState().updateSessionModel('agent:main:main', 'openai/deepseek-v4-pro');

    expect(gatewayRpcMock).toHaveBeenCalledWith('sessions.patch', {
      key: 'agent:main:main',
      model: 'openai/deepseek-v4-pro',
    });
    expect(store.getState().sessions).toMatchObject([
      { key: 'agent:main:main', model: 'openai/deepseek-v4-pro' },
      { key: 'agent:main:other', model: 'openai/smart-latest' },
    ]);
  });

  it('creates a local placeholder and registers it when the selected session is missing', async () => {
    const createRpc = createDeferred<{ entry: { model: string } }>();
    gatewayRpcMock.mockReturnValue(createRpc.promise);
    const store = await loadStore();
    store.setState({ sessions: [] });

    const update = store.getState().updateSessionModel(
      'agent:main:session-missing',
      'openai/deepseek-v4-pro',
    );

    expect(store.getState().sessions).toMatchObject([{
      key: 'agent:main:session-missing',
      model: 'openai/deepseek-v4-pro',
      createdLocally: true,
    }]);
    expect(gatewayRpcMock).toHaveBeenCalledWith('sessions.create', {
      key: 'agent:main:session-missing',
      agentId: 'main',
      model: 'openai/deepseek-v4-pro',
    });

    createRpc.resolve({ entry: { model: 'openai/deepseek-v4-pro' } });
    await update;
    expect(store.getState().sessions[0]).toMatchObject({
      createdLocally: true,
      createdOnGateway: true,
    });
  });

  it('exposes pending model persistence and lets a remounted consumer await it', async () => {
    const patchRpc = createDeferred<{ resolved: { modelProvider: string; model: string } }>();
    gatewayRpcMock.mockReturnValue(patchRpc.promise);
    const store = await loadStore();
    store.setState({
      sessions: [{ key: 'agent:main:main', model: 'openai/smart-latest' }],
    });

    const update = store.getState().updateSessionModel(
      'agent:main:main',
      'openai/deepseek-v4-pro',
    );
    const waiter = store.getState().waitForSessionModelUpdate('agent:main:main');

    expect(store.getState().pendingSessionModelUpdates['agent:main:main']).toBe(true);
    patchRpc.resolve({ resolved: { modelProvider: 'openai', model: 'deepseek-v4-pro' } });
    await expect(waiter).resolves.toBeUndefined();
    await update;
    expect(store.getState().pendingSessionModelUpdates['agent:main:main']).toBeUndefined();
  });

  it('waits for the latest queued model update when an earlier update fails', async () => {
    const firstRpc = createDeferred<never>();
    const finalRpc = createDeferred<{ resolved: { modelProvider: string; model: string } }>();
    gatewayRpcMock
      .mockReturnValueOnce(firstRpc.promise)
      .mockReturnValueOnce(finalRpc.promise);
    const store = await loadStore();
    const sessionKey = 'agent:main:main';
    store.setState({
      sessions: [{ key: sessionKey, model: 'openai/smart-latest' }],
    });

    const firstUpdate = store.getState()
      .updateSessionModel(sessionKey, 'openai/deepseek-v4-pro')
      .then(() => 'fulfilled', () => 'rejected');
    const waiter = store.getState().waitForSessionModelUpdate(sessionKey);
    let waiterSettled = false;
    void waiter.finally(() => {
      waiterSettled = true;
    });
    const finalUpdate = store.getState()
      .updateSessionModel(sessionKey, 'openai/glm-5')
      .then(() => 'fulfilled', () => 'rejected');

    firstRpc.reject(new Error('older patch failed'));
    await vi.waitFor(() => {
      expect(gatewayRpcMock).toHaveBeenCalledTimes(2);
    });
    expect(waiterSettled).toBe(false);
    expect(store.getState().pendingSessionModelUpdates[sessionKey]).toBe(true);

    finalRpc.resolve({ resolved: { modelProvider: 'openai', model: 'glm-5' } });
    await expect(waiter).resolves.toBeUndefined();
    await expect(firstUpdate).resolves.toBe('rejected');
    await expect(finalUpdate).resolves.toBe('fulfilled');
    expect(store.getState().pendingSessionModelUpdates[sessionKey]).toBeUndefined();
    expect(store.getState().sessions[0]?.model).toBe('openai/glm-5');
  });

  it('keeps ACP creation pending after Gateway registration, then patches later selections', async () => {
    const createRpc = createDeferred<{ entry: { model: string } }>();
    gatewayRpcMock
      .mockReturnValueOnce(createRpc.promise)
      .mockResolvedValueOnce({ entry: { model: 'openai/glm-5' } });
    const store = await loadStore();
    store.setState({
      sessions: [{
        key: 'agent:main:session-new',
        displayName: 'agent:main:session-new',
        createdLocally: true,
      }],
    });

    const firstSelection = store.getState().updateSessionModel(
      'agent:main:session-new',
      'openai/deepseek-v4-pro',
    );

    expect(gatewayRpcMock).toHaveBeenCalledWith('sessions.create', {
      key: 'agent:main:session-new',
      agentId: 'main',
      model: 'openai/deepseek-v4-pro',
    });
    expect(store.getState().sessions[0]).toMatchObject({
      key: 'agent:main:session-new',
      model: 'openai/deepseek-v4-pro',
      createdLocally: true,
    });

    createRpc.resolve({ entry: { model: 'openai/deepseek-v4-pro' } });
    await firstSelection;
    expect(store.getState().sessions[0]).toMatchObject({
      key: 'agent:main:session-new',
      model: 'openai/deepseek-v4-pro',
      createdLocally: true,
      createdOnGateway: true,
    });

    await store.getState().updateSessionModel('agent:main:session-new', 'openai/glm-5');

    expect(gatewayRpcMock).toHaveBeenNthCalledWith(2, 'sessions.patch', {
      key: 'agent:main:session-new',
      model: 'openai/glm-5',
    });
    expect(store.getState().sessions[0]).toMatchObject({
      key: 'agent:main:session-new',
      model: 'openai/glm-5',
      createdLocally: true,
      createdOnGateway: true,
    });
  });

  it('serializes rapid selections and keeps the final model when the earlier request fails late', async () => {
    const firstRpc = createDeferred<never>();
    const rpcEvents: string[] = [];
    gatewayRpcMock.mockImplementation((_method: string, params: { model: string }) => {
      if (params.model === 'openai/deepseek-v4-pro') {
        rpcEvents.push('start:deepseek');
        return firstRpc.promise.then(
          (result) => {
            rpcEvents.push('settled:deepseek');
            return result;
          },
          (error) => {
            rpcEvents.push('settled:deepseek');
            throw error;
          },
        );
      }
      rpcEvents.push('start:glm');
      return Promise.resolve({
        resolved: { modelProvider: 'openai', model: 'glm-5' },
      }).then((result) => {
        rpcEvents.push('settled:glm');
        return result;
      });
    });

    const store = await loadStore();
    store.setState({
      sessions: [{ key: 'agent:main:main', model: 'openai/smart-latest' }],
    });

    const firstSelection = store.getState()
      .updateSessionModel('agent:main:main', 'openai/deepseek-v4-pro')
      .then(() => 'fulfilled', () => 'rejected');
    const finalSelection = store.getState()
      .updateSessionModel('agent:main:main', 'openai/glm-5')
      .then(() => 'fulfilled', () => 'rejected');

    // Let an incorrectly concurrent second RPC settle before the first RPC fails.
    await Promise.resolve();
    await Promise.resolve();
    firstRpc.reject(new Error('deepseek patch failed'));

    await expect(firstSelection).resolves.toBe('rejected');
    await expect(finalSelection).resolves.toBe('fulfilled');
    expect.soft(rpcEvents).toEqual([
      'start:deepseek',
      'settled:deepseek',
      'start:glm',
      'settled:glm',
    ]);
    expect(store.getState().sessions[0]).toMatchObject({
      key: 'agent:main:main',
      model: 'openai/glm-5',
    });
  });

  it('rolls back only the model field when persistence fails', async () => {
    const patchRpc = createDeferred<never>();
    gatewayRpcMock.mockReturnValue(patchRpc.promise);
    const store = await loadStore();
    store.setState({
      sessions: [
        {
          key: 'agent:main:main',
          model: 'openai/smart-latest',
          status: 'idle',
          hasActiveRun: false,
          label: 'Original label',
          workspacePath: '/workspace/original',
        },
        { key: 'agent:main:other', model: 'openai/smart-latest' },
      ],
    });

    const update = store.getState().updateSessionModel(
      'agent:main:main',
      'openai/deepseek-v4-pro',
    );
    store.setState((state) => ({
      sessions: state.sessions.map((session) => session.key === 'agent:main:main'
        ? {
          ...session,
          status: 'running',
          hasActiveRun: true,
          label: 'Concurrent label',
          workspacePath: '/workspace/concurrent',
        }
        : session),
    }));
    patchRpc.reject(new Error('patch failed'));

    await expect(update).rejects.toThrow('patch failed');
    expect(store.getState().sessions).toMatchObject([
      {
        key: 'agent:main:main',
        model: 'openai/smart-latest',
        status: 'running',
        hasActiveRun: true,
        label: 'Concurrent label',
        workspacePath: '/workspace/concurrent',
      },
      { key: 'agent:main:other', model: 'openai/smart-latest' },
    ]);
  });

  it('keeps the desired model during a queued catalog event and rolls back to its authoritative model', async () => {
    const listRpc = createDeferred<{
      ts: number;
      sessions: Array<Record<string, unknown>>;
    }>();
    const patchRpc = createDeferred<never>();
    gatewayRpcMock.mockImplementation((method: string) => {
      if (method === 'sessions.list') return listRpc.promise;
      if (method === 'sessions.patch') return patchRpc.promise;
      return Promise.resolve({ messages: [] });
    });
    const store = await loadStore();
    const sessionKey = 'agent:main:session-a';
    store.setState({
      currentSessionKey: sessionKey,
      currentAgentId: 'main',
      sessions: [{
        key: sessionKey,
        displayName: 'Session A',
        model: 'openai/smart-latest',
      }],
    });

    const loading = store.getState().loadSessions({ force: true });
    await vi.waitFor(() => {
      expect(gatewayRpcMock).toHaveBeenCalledWith('sessions.list', {
        includeDerivedTitles: true,
        includeLastMessage: true,
      });
    });
    const update = store.getState().updateSessionModel(
      sessionKey,
      'openai/deepseek-v4-pro',
    );
    store.getState().handleSessionsChanged({
      sessionKey,
      ts: 11,
      session: {
        key: sessionKey,
        displayName: 'Session A',
        modelProvider: 'openai',
        model: 'glm-5',
      },
    });
    listRpc.resolve({
      ts: 10,
      sessions: [{
        key: sessionKey,
        displayName: 'Session A',
        modelProvider: 'openai',
        model: 'smart-latest',
      }],
    });

    await loading;
    expect(store.getState().sessions[0]?.model).toBe('openai/deepseek-v4-pro');

    patchRpc.reject(new Error('patch failed'));
    await expect(update).rejects.toThrow('patch failed');
    expect(store.getState().sessions[0]?.model).toBe('openai/glm-5');
  });

  it('projects thinking from the target session and clears it for a new session', async () => {
    const store = await loadStore();
    store.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      thinkingLevel: 'high',
      sessions: [
        { key: 'agent:main:main', thinkingLevel: 'high' },
        { key: 'agent:main:other', thinkingLevel: 'low' },
      ],
    });

    store.getState().selectAcpSession('agent:main:other');
    expect(store.getState().thinkingLevel).toBe('low');

    store.getState().newSession();
    const newSessionKey = store.getState().currentSessionKey;
    expect(newSessionKey).toMatch(/^agent:main:session-/);
    expect(store.getState().thinkingLevel).toBeNull();
    expect(store.getState().sessions.find((session) => session.key === newSessionKey))
      .not.toHaveProperty('thinkingLevel');
  });

  it('patches only the selected thinking level for an existing session', async () => {
    gatewayRpcMock.mockResolvedValue({ entry: { thinkingLevel: 'high' } });
    const store = await loadStore();
    store.setState({
      currentSessionKey: 'agent:main:main',
      thinkingLevel: 'medium',
      sessions: [
        { key: 'agent:main:main', model: 'openai/smart-latest', thinkingLevel: 'medium' },
        { key: 'agent:main:other', model: 'openai/glm-5', thinkingLevel: 'low' },
      ],
    });

    await store.getState().updateSessionThinking('agent:main:main', 'high');

    expect(gatewayRpcMock).toHaveBeenCalledWith('sessions.patch', {
      key: 'agent:main:main',
      thinkingLevel: 'high',
    });
    expect(store.getState().sessions).toMatchObject([
      { key: 'agent:main:main', model: 'openai/smart-latest', thinkingLevel: 'high' },
      { key: 'agent:main:other', model: 'openai/glm-5', thinkingLevel: 'low' },
    ]);
    expect(store.getState().thinkingLevel).toBe('high');
  });

  it('registers a local session before patching its thinking level', async () => {
    gatewayRpcMock.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.create') return Promise.resolve({ entry: {} });
      return Promise.resolve({ entry: { thinkingLevel: params.thinkingLevel } });
    });
    const store = await loadStore();
    const sessionKey = 'agent:main:thinking-new';
    store.setState({
      currentSessionKey: sessionKey,
      sessions: [{ key: sessionKey, displayName: sessionKey, createdLocally: true }],
    });

    await store.getState().updateSessionThinking(sessionKey, 'high');

    expect(gatewayRpcMock).toHaveBeenNthCalledWith(1, 'sessions.create', {
      key: sessionKey,
      agentId: 'main',
    });
    expect(gatewayRpcMock).toHaveBeenNthCalledWith(2, 'sessions.patch', {
      key: sessionKey,
      thinkingLevel: 'high',
    });
    expect(store.getState().sessions[0]).toMatchObject({
      key: sessionKey,
      thinkingLevel: 'high',
      createdLocally: true,
      createdOnGateway: true,
    });
  });

  it('shares one local registration when model selection starts before thinking selection', async () => {
    const createRpc = createDeferred<{ entry: { model: string } }>();
    gatewayRpcMock.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.create') return createRpc.promise;
      return Promise.resolve({ entry: { thinkingLevel: params.thinkingLevel, model: params.model } });
    });
    const store = await loadStore();
    const sessionKey = 'agent:main:model-first';
    store.setState({
      currentSessionKey: sessionKey,
      sessions: [{ key: sessionKey, displayName: sessionKey, createdLocally: true }],
    });

    const modelUpdate = store.getState().updateSessionModel(sessionKey, 'openai/glm-5');
    const thinkingUpdate = store.getState().updateSessionThinking(sessionKey, 'high');

    expect(gatewayRpcMock).toHaveBeenCalledTimes(1);
    expect(gatewayRpcMock).toHaveBeenCalledWith('sessions.create', {
      key: sessionKey,
      agentId: 'main',
      model: 'openai/glm-5',
    });

    createRpc.resolve({ entry: { model: 'openai/glm-5' } });
    await Promise.all([modelUpdate, thinkingUpdate]);

    expect(gatewayRpcMock.mock.calls.filter(([method]) => method === 'sessions.create')).toHaveLength(1);
    expect(gatewayRpcMock).toHaveBeenCalledWith('sessions.patch', {
      key: sessionKey,
      thinkingLevel: 'high',
    });
    expect(gatewayRpcMock.mock.calls.filter(([, params]) => params?.model === 'openai/glm-5')).toHaveLength(1);
  });

  it('shares one local registration and patches the model when thinking selection starts first', async () => {
    const createRpc = createDeferred<{ entry: Record<string, never> }>();
    gatewayRpcMock.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.create') return createRpc.promise;
      if (Object.prototype.hasOwnProperty.call(params, 'model')) {
        return Promise.resolve({ resolved: { modelProvider: 'openai', model: 'glm-5' } });
      }
      return Promise.resolve({ entry: { thinkingLevel: params.thinkingLevel } });
    });
    const store = await loadStore();
    const sessionKey = 'agent:main:thinking-first';
    store.setState({
      currentSessionKey: sessionKey,
      sessions: [{ key: sessionKey, displayName: sessionKey, createdLocally: true }],
    });

    const thinkingUpdate = store.getState().updateSessionThinking(sessionKey, 'high');
    const modelUpdate = store.getState().updateSessionModel(sessionKey, 'openai/glm-5');

    expect(gatewayRpcMock).toHaveBeenCalledTimes(1);
    expect(gatewayRpcMock).toHaveBeenCalledWith('sessions.create', {
      key: sessionKey,
      agentId: 'main',
    });

    createRpc.resolve({ entry: {} });
    await Promise.all([thinkingUpdate, modelUpdate]);

    expect(gatewayRpcMock.mock.calls.filter(([method]) => method === 'sessions.create')).toHaveLength(1);
    expect(gatewayRpcMock).toHaveBeenCalledWith('sessions.patch', {
      key: sessionKey,
      thinkingLevel: 'high',
    });
    expect(gatewayRpcMock).toHaveBeenCalledWith('sessions.patch', {
      key: sessionKey,
      model: 'openai/glm-5',
    });
  });

  it('serializes rapid thinking changes and keeps the latest selection', async () => {
    const firstRpc = createDeferred<never>();
    const events: string[] = [];
    gatewayRpcMock.mockImplementation((_method: string, params: { thinkingLevel: string }) => {
      if (params.thinkingLevel === 'low') {
        events.push('start:low');
        return firstRpc.promise.finally(() => events.push('settled:low'));
      }
      events.push('start:high');
      return Promise.resolve({ entry: { thinkingLevel: 'high' } })
        .then((result) => {
          events.push('settled:high');
          return result;
        });
    });
    const store = await loadStore();
    store.setState({
      currentSessionKey: 'agent:main:main',
      thinkingLevel: 'medium',
      sessions: [{ key: 'agent:main:main', thinkingLevel: 'medium' }],
    });

    const firstUpdate = store.getState()
      .updateSessionThinking('agent:main:main', 'low')
      .then(() => 'fulfilled', () => 'rejected');
    const finalUpdate = store.getState()
      .updateSessionThinking('agent:main:main', 'high')
      .then(() => 'fulfilled', () => 'rejected');

    firstRpc.reject(new Error('low patch failed'));
    await expect(firstUpdate).resolves.toBe('rejected');
    await expect(finalUpdate).resolves.toBe('fulfilled');
    expect(events).toEqual(['start:low', 'settled:low', 'start:high', 'settled:high']);
    expect(store.getState().sessions[0]?.thinkingLevel).toBe('high');
    expect(store.getState().thinkingLevel).toBe('high');
  });

  it('rolls back only the thinking field when persistence fails', async () => {
    const patchRpc = createDeferred<never>();
    gatewayRpcMock.mockReturnValue(patchRpc.promise);
    const store = await loadStore();
    store.setState({
      currentSessionKey: 'agent:main:main',
      thinkingLevel: 'medium',
      sessions: [{
        key: 'agent:main:main',
        model: 'openai/smart-latest',
        thinkingLevel: 'medium',
        status: 'idle',
        label: 'Original label',
      }],
    });

    const update = store.getState().updateSessionThinking('agent:main:main', 'high');
    store.setState((state) => ({
      sessions: state.sessions.map((session) => session.key === 'agent:main:main'
        ? { ...session, model: 'openai/glm-5', status: 'running', label: 'Concurrent label' }
        : session),
    }));
    patchRpc.reject(new Error('thinking patch failed'));

    await expect(update).rejects.toThrow('thinking patch failed');
    expect(store.getState().sessions[0]).toMatchObject({
      key: 'agent:main:main',
      model: 'openai/glm-5',
      thinkingLevel: 'medium',
      status: 'running',
      label: 'Concurrent label',
    });
    expect(store.getState().thinkingLevel).toBe('medium');
  });
});
