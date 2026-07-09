import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_SEND_RPC_TIMEOUT_MS } from '../../shared/chat-timeouts';
import { chatHistoryRpcParams } from './gateway-rpc-test-utils';

const { gatewayRpcMock, hostApiFetchMock, agentsState } = vi.hoisted(() => ({
  gatewayRpcMock: vi.fn(),
  hostApiFetchMock: vi.fn(),
  agentsState: {
    agents: [] as Array<Record<string, unknown>>,
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      rpc: gatewayRpcMock,
    }),
  },
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => agentsState,
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

describe('chat target routing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-11T12:00:00Z'));
    window.localStorage.clear();

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

    gatewayRpcMock.mockReset();
    gatewayRpcMock.mockImplementation(async (method: string) => {
      if (method === 'config.get') {
        return { messages: [] };
      }
      if (method === 'chat.history') {
        return { messages: [] };
      }
      if (method === 'chat.send') {
        return { runId: 'run-text' };
      }
      if (method === 'chat.abort') {
        return { ok: true };
      }
      if (method === 'sessions.list') {
        return { sessions: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    hostApiFetchMock.mockReset();
    hostApiFetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url === '/api/media/intent-plan') {
        const body = JSON.parse(init?.body || '{}') as {
          prompt?: string;
          requestedMode?: 'chat' | 'image' | 'video';
          explicitImages?: Array<{ fileName?: string; mimeType?: string; filePath: string }>;
          candidateImages?: Array<{ fileName?: string; mimeType?: string; filePath: string }>;
        };
        const prompt = body.prompt || '';
        const explicitImages = body.explicitImages ?? [];
        const candidateImages = body.candidateImages ?? [];
        if (/截图|screenshot/i.test(prompt)) {
          return { success: true, plan: { action: 'desktop_screenshot', source: 'planner', confidence: 0.95 } };
        }
        if (body.requestedMode === 'video' || /视频|动起来|video/i.test(prompt)) {
          const usesCandidate = /上一张|上一个|previous|last/i.test(prompt) && candidateImages.length > 0;
          const sourceImages = explicitImages.length > 0
            ? explicitImages
            : (usesCandidate ? [candidateImages[0]] : []);
          return {
            success: true,
            plan: {
              action: 'video_generate',
              source: 'planner',
              confidence: 0.9,
              selectedImageSource: explicitImages.length > 0 ? 'explicit' : (usesCandidate ? 'candidate' : 'none'),
              selectedImageIndex: sourceImages.length > 0 ? 0 : undefined,
              sourceImages,
            },
          };
        }
        const imageEditLike = /logo|去掉|remove|上一张|这个图片|这张图|加一条狗/i.test(prompt);
        if (imageEditLike && explicitImages.length === 0 && candidateImages.length === 0) {
          return {
            success: true,
            plan: {
              action: 'clarify',
              source: 'planner',
              confidence: 0.9,
              clarification: '你想编辑哪张图片？请上传或选中一张图片。',
            },
          };
        }
        if (imageEditLike || body.requestedMode === 'image' || /生成.*(图|海报)|出图|生图/i.test(prompt)) {
          const shouldEdit = explicitImages.length > 0 || (imageEditLike && candidateImages.length > 0);
          if (shouldEdit) {
            const sourceImages = explicitImages.length > 0 ? [explicitImages[0]] : [candidateImages[0]];
            return {
              success: true,
              plan: {
                action: 'image_edit',
                source: 'planner',
                confidence: 0.9,
                selectedImageSource: explicitImages.length > 0 ? 'explicit' : 'candidate',
                selectedImageIndex: 0,
                sourceImages,
              },
            };
          }
          return { success: true, plan: { action: 'image_generate', source: 'planner', confidence: 0.9 } };
        }
        return { success: true, plan: { action: 'chat', source: 'planner', confidence: 0.9 } };
      }
      if (url === '/api/chat/history') {
        return { success: true, result: { messages: [] } };
      }
      if (url === '/api/chat/send') {
        return { success: true, result: { runId: 'run-text' } };
      }
      if (url === '/api/chat/send-with-media') {
        return { success: true, result: { runId: 'run-media' } };
      }
      if (url === '/api/media/image-generation/chat-send') {
        return { success: true, jobId: 'job-image', job: { id: 'job-image', status: 'queued' } };
      }
      if (url === '/api/media/video-generation/chat-send') {
        return { success: true, jobId: 'job-video', job: { id: 'job-video', status: 'queued' } };
      }
      if (url === '/api/computer/desktop-screenshot') {
        return {
          success: true,
          screenshot: {
            fileName: 'desktop-screenshot.png',
            filePath: 'C:\\Users\\Administrator\\.openclaw\\media\\desktop-screenshots\\desktop-screenshot.png',
            mimeType: 'image/png',
            fileSize: 1024,
            preview: 'data:image/png;base64,abc',
            sourceName: 'Screen 1',
          },
        };
      }
      if (url === '/api/media/generation-jobs/job-image' || url === '/api/media/generation-jobs/job-video') {
        const isImage = url.endsWith('job-image');
        return {
          success: true,
          job: {
            id: isImage ? 'job-image' : 'job-video',
            kind: isImage ? 'image' : 'video',
            status: 'succeeded',
            result: {
              outputs: [isImage
                ? { path: '/tmp/generated.png', mimeType: 'image/png', size: 1024 }
                : { path: '/tmp/generated.mp4', mimeType: 'video/mp4', size: 4096 }],
            },
          },
        };
      }
      if (url === '/api/files/thumbnails') {
        const body = JSON.parse(init?.body || '{}') as {
          paths?: Array<{ filePath?: string; gatewayUrl?: string }>;
        };
        return Object.fromEntries((body.paths ?? []).map((entry) => {
          const key = entry.filePath ?? entry.gatewayUrl ?? '';
          return [key, { preview: null, fileSize: key.endsWith('.mp4') ? 4096 : 1024, filePath: entry.filePath }];
        }));
      }
      return { success: true, result: {} };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('switches to the selected agent main session before sending text', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [{ role: 'assistant', content: 'Existing main history' }],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage('Hello direct agent', undefined, 'research');

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:research:desk');
    expect(state.currentAgentId).toBe('research');
    expect(state.sessions.some((session) => session.key === 'agent:research:desk')).toBe(true);
    expect(state.messages.at(-1)?.content).toBe('Hello direct agent');

    const sendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/chat/send');
    const sendPayload = JSON.parse((sendCall?.[1] as { body: string } | undefined)?.body ?? '{}');
    expect(sendPayload).toMatchObject({
      sessionKey: 'agent:research:desk',
      message: 'Hello direct agent',
      deliver: false,
    });
    expect(typeof (sendPayload as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/chat/history')).toBe(false);

    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => {
      const historyCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/chat/history');
      expect(JSON.parse((historyCall?.[1] as { body: string } | undefined)?.body ?? '{}')).toEqual(
        chatHistoryRpcParams('agent:research:desk', 100),
      );
    });
  });

  it('uses the long chat.send timeout when falling back to Gateway RPC', async () => {
    hostApiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/chat/send') {
        throw new Error('host api unavailable');
      }
      if (url === '/api/chat/history') {
        return { success: true, result: { messages: [] } };
      }
      return { success: true, result: {} };
    });
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage('Hello fallback');

    expect(gatewayRpcMock).toHaveBeenCalledWith(
      'chat.send',
      expect.objectContaining({
        sessionKey: 'agent:main:main',
        message: 'Hello fallback',
        deliver: false,
      }),
      CHAT_SEND_RPC_TIMEOUT_MS,
    );
  });

  it('does not block sending on managed-auth remote refresh when local status is ready', async () => {
    const remoteStatus = deferred<unknown>();
    hostApiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/junfeiai/status') {
        return remoteStatus.promise;
      }
      if (url === '/api/chat/history') {
        return { success: true, result: { messages: [] } };
      }
      if (url === '/api/chat/send') {
        return { success: true, result: { runId: 'run-managed-fast-path' } };
      }
      return { success: true, result: {} };
    });

    const { useManagedAuthStore } = await import('@/stores/managed-auth');
    const { useProviderStore } = await import('@/stores/providers');
    const { useChatStore } = await import('@/stores/chat');

    useManagedAuthStore.setState({
      status: {
        managed: true,
        localOnly: true,
        hasAuthToken: true,
        hasRelayToken: true,
        authValid: false,
      },
      initialized: true,
      loading: false,
      verifying: false,
      error: null,
    });
    useProviderStore.setState({
      defaultAccountId: 'lingzhiwuxian',
      accounts: [{
        id: 'lingzhiwuxian',
        vendorId: 'lingzhiwuxian',
        label: 'LingZhiWuXian',
        authMode: 'api_key',
        enabled: true,
        isDefault: true,
        createdAt: '2026-03-11T12:00:00.000Z',
        updatedAt: '2026-03-11T12:00:00.000Z',
      }],
    });
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage('send without waiting for remote auth');

    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/junfeiai/status')).toBe(true);
    const sendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/chat/send');
    expect(sendCall).toBeTruthy();
    const sendPayload = JSON.parse((sendCall?.[1] as { body: string } | undefined)?.body ?? '{}');
    expect(sendPayload).toMatchObject({
      sessionKey: 'agent:main:main',
      message: 'send without waiting for remote auth',
    });
  });

  it('does not queue or block a Windows cross-session send while another session is running', async () => {
    window.electron.platform = 'win32';
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [
        { key: 'agent:main:main' },
        { key: 'agent:research:desk' },
      ],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      runtimeRuns: {
        'run-main-active': {
          runId: 'run-main-active',
          sessionKey: 'agent:main:main',
          status: 'running',
          startedAt: Date.now(),
          assistantText: '',
          thinkingText: '',
          events: [{
            type: 'run.started',
            runId: 'run-main-active',
            sessionKey: 'agent:main:main',
            ts: Date.now(),
          }],
        },
      },
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage('send now on research', undefined, 'research');

    expect(hostApiFetchMock.mock.calls.filter(([url]) => url === '/api/chat/send')).toHaveLength(1);
    const sendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/chat/send');
    const sendPayload = JSON.parse((sendCall?.[1] as { body: string } | undefined)?.body ?? '{}');
    expect(sendPayload).toMatchObject({
      sessionKey: 'agent:research:desk',
      message: 'send now on research',
    });
    expect('queuedSends' in useChatStore.getState()).toBe(false);
  });

  it('queues same-session follow-up sends until the active run is idle', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }, { key: 'agent:research:desk' }],
      messages: [{ role: 'user', content: 'first message' }],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: 'run-first',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      runtimeRuns: {},
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage('second message should wait');

    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/chat/send')).toBe(false);

    useChatStore.setState({
      sending: false,
      activeRunId: null,
      pendingFinal: false,
      lastUserMessageAt: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
    });
    useChatStore.getState().switchSession('agent:research:desk');
    useChatStore.getState().switchSession('agent:main:main');

    await vi.waitFor(() => {
      expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/chat/send')).toBe(true);
    });

    const sendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/chat/send');
    const sendPayload = JSON.parse((sendCall?.[1] as { body: string } | undefined)?.body ?? '{}');
    expect(sendPayload).toMatchObject({
      sessionKey: 'agent:main:main',
      message: 'second message should wait',
      deliver: false,
    });
  });

  it('deduplicates progressive duplicate assistant replies loaded from history', async () => {
    hostApiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/chat/history') {
        return {
          success: true,
          result: {
            messages: [
              { role: 'user', content: '你觉得这张图美嘛？', timestamp: 1000 },
              { role: 'assistant', content: '这张图整体是美的，主要优点是光影和构图', timestamp: 1001, id: 'assistant-short' },
              { role: 'assistant', content: '这张图整体是美的，主要优点是光影和构图都比较稳定，主体也清楚。', timestamp: 1002, id: 'assistant-full' },
              { role: 'assistant', content: '这张图整体是美的，主要优点是光影和构图都比较稳定，主体也清楚。', timestamp: 1003, id: 'assistant-full-echo' },
            ],
          },
        };
      }
      if (url === '/api/files/thumbnails') return {};
      return { success: true, result: {} };
    });
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      runtimeRuns: {},
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().loadHistory(true);

    const assistantMessages = useChatStore.getState().messages.filter((message) => message.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.id).toBe('assistant-full-echo');
    expect(assistantMessages[0]?.content).toBe('这张图整体是美的，主要优点是光影和构图都比较稳定，主体也清楚。');
  });

  it('delivers generated artifacts when terminal assistant text fails after files are produced', async () => {
    hostApiFetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url === '/api/chat/history') {
        return {
          success: true,
          result: {
            messages: [
              { role: 'user', content: '做一个 Excel 和一个 PPT', timestamp: 1000 },
              {
                role: 'assistant',
                content: 'Excel 和 PPT 已生成。\nMEDIA:/tmp/uclaw-budget.xlsx\nMEDIA:/tmp/uclaw-plan.pptx',
                timestamp: 1001,
                id: 'assistant-artifacts',
              },
              {
                role: 'assistant',
                content: '[assistant turn failed] HTTP 429: rate limited',
                timestamp: 1002,
                id: 'assistant-error',
                stopReason: 'error',
                errorMessage: 'HTTP 429: rate limited',
              },
            ],
          },
        };
      }
      if (url === '/api/files/thumbnails') {
        const body = JSON.parse(init?.body || '{}') as { paths?: Array<{ filePath?: string }> };
        return Object.fromEntries((body.paths ?? []).map((entry) => [
          entry.filePath ?? '',
          { preview: null, fileSize: 1024, filePath: entry.filePath },
        ]));
      }
      return { success: true, result: {} };
    });
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      runtimeRuns: {},
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().loadHistory(true);

    const state = useChatStore.getState();
    const lastMessage = state.messages.at(-1);
    expect(state.runError).toBeNull();
    expect(state.sending).toBe(false);
    expect(state.messages.some((message) => message.id === 'assistant-error')).toBe(false);
    expect(lastMessage).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('文件已生成，但最终文字回复没有成功送达'),
      _attachedFiles: [
        expect.objectContaining({ fileName: 'uclaw-budget.xlsx' }),
        expect.objectContaining({ fileName: 'uclaw-plan.pptx' }),
      ],
    });
  });

  it('does not let a completed background media job clear the foreground session run state', async () => {
    const { useChatStore } = await import('@/stores/chat');
    const mediaJobPoll = deferred<{
      success: true;
      job: {
        id: string;
        kind: 'image';
        status: 'succeeded';
        result: { outputs: Array<{ path: string; mimeType: string; size: number }> };
      };
    }>();

    useChatStore.setState({
      currentSessionKey: 'agent:main:a',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:a' }, { key: 'agent:main:b' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      runtimeRuns: {},
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    hostApiFetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url === '/api/media/intent-plan') {
        return { success: true, plan: { action: 'image_generate', source: 'planner', confidence: 0.95 } };
      }
      if (url === '/api/media/image-generation/chat-send') {
        return { success: true, jobId: 'job-image-a', job: { id: 'job-image-a', kind: 'image', status: 'queued' } };
      }
      if (url === '/api/media/generation-jobs/job-image-a') {
        return mediaJobPoll.promise;
      }
      if (url === '/api/files/thumbnails') {
        const body = JSON.parse(init?.body || '{}') as { paths?: Array<{ filePath?: string }> };
        return Object.fromEntries((body.paths ?? []).map((entry) => [
          entry.filePath ?? '',
          { preview: null, fileSize: 1024, filePath: entry.filePath },
        ]));
      }
      if (url === '/api/chat/history') {
        return { success: true, result: { messages: [] } };
      }
      return { success: true, result: {} };
    });

    const backgroundSend = useChatStore.getState().sendMessage('生成一张背景图', undefined, undefined, 'image');

    await vi.waitFor(() => {
      expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/media/generation-jobs/job-image-a')).toBe(true);
    });
    expect(useChatStore.getState().currentSessionKey).toBe('agent:main:a');
    expect(useChatStore.getState().pendingImageGenerationLocal).toBe(true);

    useChatStore.getState().switchSession('agent:main:b');
    useChatStore.setState({
      messages: [{ role: 'user', content: 'B is still running' }],
      sending: true,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: 'run-b',
      pendingFinal: true,
      lastUserMessageAt: Date.now(),
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
    });

    mediaJobPoll.resolve({
      success: true,
      job: {
        id: 'job-image-a',
        kind: 'image',
        status: 'succeeded',
        result: { outputs: [{ path: '/tmp/generated-a.png', mimeType: 'image/png', size: 1024 }] },
      },
    });
    await backgroundSend;

    expect(useChatStore.getState().currentSessionKey).toBe('agent:main:b');
    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().activeRunId).toBe('run-b');
    expect(useChatStore.getState().pendingFinal).toBe(true);
    expect(useChatStore.getState().messages).toEqual([{ role: 'user', content: 'B is still running' }]);

    useChatStore.getState().switchSession('agent:main:a');
    expect(useChatStore.getState().pendingImageGenerationLocal).toBe(false);
  });

  it('uses the selected agent main session for attachment sends', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage(
      '',
      [
        {
          fileName: 'design.png',
          mimeType: 'image/png',
          fileSize: 128,
          stagedPath: '/tmp/design.png',
          preview: 'data:image/png;base64,abc',
        },
      ],
      'research',
    );

    expect(useChatStore.getState().currentSessionKey).toBe('agent:research:desk');

    expect(hostApiFetchMock).toHaveBeenCalledWith(
      '/api/chat/send-with-media',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );

    const mediaSendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/chat/send-with-media');
    const payload = JSON.parse(
      (mediaSendCall?.[1] as { body: string }).body,
    ) as {
      sessionKey: string;
      message: string;
      media: Array<{ filePath: string }>;
    };

    expect(payload.sessionKey).toBe('agent:research:desk');
    expect(payload.message).toBe('Process the attached file(s).');
    expect(payload.media[0]?.filePath).toBe('/tmp/design.png');
  });

  it('sends planner-selected vision chat images through the media chat endpoint', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [
        {
          role: 'assistant',
          content: '图片已生成。',
          _attachedFiles: [
            {
              fileName: 'beauty.png',
              mimeType: 'image/png',
              fileSize: 1024,
              preview: 'data:image/png;base64,abc',
              filePath: '/tmp/beauty.png',
              source: 'message-ref',
            },
          ],
        },
      ],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });
    hostApiFetchMock.mockImplementation(async (url: string) => {
      if (url.toString().startsWith('/api/sessions/transcript?')) {
        return { messages: [] };
      }
      if (url === '/api/chat/send') {
        return { success: true, result: { runId: 'run-text' } };
      }
      if (url !== '/api/media/intent-plan') {
        return { success: true, result: {} };
      }
      return {
        success: true,
        plan: {
          action: 'vision_chat',
          source: 'planner',
          confidence: 0.95,
          selectedImageSource: 'candidate',
          selectedImageIndex: 0,
          sourceImages: [{
            fileName: 'beauty.png',
            mimeType: 'image/png',
            filePath: '/tmp/beauty.png',
          }],
        },
      };
    });

    await useChatStore.getState().sendMessage('你觉得美嘛？');

    const mediaSendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/chat/send-with-media');
    expect(mediaSendCall).toBeTruthy();
    const payload = JSON.parse(
      (mediaSendCall?.[1] as { body: string }).body,
    ) as {
      message: string;
      media: Array<{ filePath: string; mimeType: string; fileName: string }>;
    };
    expect(payload.message).toBe('你觉得美嘛？');
    expect(payload.media).toEqual([
      {
        filePath: '/tmp/beauty.png',
        mimeType: 'image/png',
        fileName: 'beauty.png',
      },
    ]);
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/chat/send')).toBe(false);
  });

  it('registers a pending new session before sending video generation jobs', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [{ role: 'user', content: 'previous chat' }],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
    });

    gatewayRpcMock.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'sessions.create') {
        return {
          ok: true,
          key: params?.key,
          entry: {
            key: params?.key,
            updatedAt: Date.now(),
          },
        };
      }
      if (method === 'config.get') {
        return { messages: [] };
      }
      if (method === 'chat.history') {
        return { messages: [] };
      }
      if (method === 'sessions.list') {
        return { sessions: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    useChatStore.getState().newSession();
    const newSessionKey = useChatStore.getState().currentSessionKey;

    await useChatStore.getState().sendMessage(
      '生成一个短视频',
      undefined,
      undefined,
      'video',
      undefined,
      { size: '1280x720', durationSeconds: 4 },
    );

    expect(gatewayRpcMock).toHaveBeenCalledWith('sessions.create', {
      key: newSessionKey,
      agentId: 'main',
      model: 'lingzhiwuxian/smart-latest',
    });

    const createCallOrder = gatewayRpcMock.mock.invocationCallOrder[
      gatewayRpcMock.mock.calls.findIndex(([method]) => method === 'sessions.create')
    ];
    const videoSendCallIndex = hostApiFetchMock.mock.calls.findIndex(([url]) => url === '/api/media/video-generation/chat-send');
    const videoSendCallOrder = hostApiFetchMock.mock.invocationCallOrder[videoSendCallIndex];

    expect(videoSendCallIndex).toBeGreaterThanOrEqual(0);
    expect(createCallOrder).toBeLessThan(videoSendCallOrder);
    expect(useChatStore.getState().sessions.some((session) => session.key === newSessionKey)).toBe(true);
  });

  it('treats URL-only video generation outputs as verified deliverable artifacts', async () => {
    const signedVideoUrl = 'content?u=aHR0cHM6Ly92aWRnZW4ueC5haS9kZW1vLm1wNA&exp=1783612254&sig=test-signature';
    hostApiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/media/intent-plan') {
        return { success: true, plan: { action: 'video_generate', source: 'planner', confidence: 0.9 } };
      }
      if (url === '/api/media/video-generation/chat-send') {
        return { success: true, jobId: 'job-video-url', job: { id: 'job-video-url', kind: 'video', status: 'queued' } };
      }
      if (url === '/api/media/generation-jobs/job-video-url') {
        return {
          success: true,
          job: {
            id: 'job-video-url',
            kind: 'video',
            status: 'succeeded',
            result: {
              outputs: [{
                url: signedVideoUrl,
                mimeType: 'video/mp4',
                durationSeconds: 4,
                metadata: { taskId: 'task-demo' },
              }],
            },
          },
        };
      }
      if (url === '/api/chat/history') {
        return { success: true, result: { messages: [] } };
      }
      return { success: true, result: {} };
    });
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      runtimeRuns: {},
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage(
      '生成一个短视频',
      undefined,
      undefined,
      'video',
      undefined,
      { size: '1280x720', durationSeconds: 4 },
    );

    const run = Object.values(useChatStore.getState().runtimeRuns)
      .find((item) => item.artifacts?.some((artifact) => artifact.url === signedVideoUrl));
    const artifactId = run?.artifacts?.[0]?.id;

    expect(run?.gateResult).toEqual(expect.objectContaining({
      decision: 'deliverable',
      artifactCount: 1,
      requiredVerificationCount: 1,
      passedRequiredVerificationCount: 1,
      verificationCoverage: 1,
    }));
    expect(run?.gateResult?.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'artifact.verification.missing' }),
    ]));
    expect(run?.verifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifactId,
        kind: 'artifact.availability',
        required: true,
        status: 'passed',
      }),
      expect.objectContaining({
        artifactId,
        kind: 'media.metadata',
        required: false,
        status: 'passed',
      }),
    ]));
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '视频已生成。',
      _attachedFiles: [
        expect.objectContaining({
          mimeType: 'video/mp4',
          gatewayUrl: signedVideoUrl,
        }),
      ],
    });
    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
    expect(useChatStore.getState().pendingFinal).toBe(false);
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/files/thumbnails')).toBe(false);
  });

  it('blocks video generation delivery when provider metadata reports a zero-second video', async () => {
    const signedVideoUrl = 'content?u=aHR0cHM6Ly92aWRnZW4ueC5haS96ZXJvLm1wNA&exp=1783612254&sig=test-signature';
    hostApiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/media/intent-plan') {
        return { success: true, plan: { action: 'video_generate', source: 'planner', confidence: 0.9 } };
      }
      if (url === '/api/media/video-generation/chat-send') {
        return { success: true, jobId: 'job-video-zero', job: { id: 'job-video-zero', kind: 'video', status: 'queued' } };
      }
      if (url === '/api/media/generation-jobs/job-video-zero') {
        return {
          success: true,
          job: {
            id: 'job-video-zero',
            kind: 'video',
            status: 'succeeded',
            result: {
              outputs: [{
                url: signedVideoUrl,
                mimeType: 'video/mp4',
                durationSeconds: 0,
              }],
            },
          },
        };
      }
      return { success: true, result: {} };
    });
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      runtimeRuns: {},
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage(
      '生成一个短视频',
      undefined,
      undefined,
      'video',
      undefined,
      { size: '1280x720', durationSeconds: 4 },
    );

    const run = Object.values(useChatStore.getState().runtimeRuns)
      .find((item) => item.artifacts?.some((artifact) => artifact.url === signedVideoUrl));
    const artifactId = run?.artifacts?.[0]?.id;
    expect(run?.gateResult).toEqual(expect.objectContaining({
      decision: 'continue_required',
      blockingIssueCount: 1,
    }));
    expect(run?.verifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifactId,
        kind: 'media.metadata',
        required: true,
        status: 'blocked',
        detail: expect.stringContaining('0 秒'),
      }),
    ]));
  });

  it('reuses the latest assistant image for edit-like image-mode sends without explicit attachments', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [
        {
          role: 'assistant',
          content: '图片已生成。',
          _attachedFiles: [
            {
              fileName: 'bike.png',
              mimeType: 'image/png',
              fileSize: 1024,
              preview: 'data:image/png;base64,abc',
              filePath: '/tmp/bike.png',
              source: 'message-ref',
            },
          ],
        },
      ],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage(
      '把 logo 去掉',
      undefined,
      undefined,
      'image',
      { size: '1024x1024', quality: 'medium' },
    );

    const imageSendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/media/image-generation/chat-send');
    expect(imageSendCall).toBeTruthy();
    const payload = JSON.parse(
      (imageSendCall?.[1] as { body: string }).body,
    ) as {
      sessionKey: string;
      prompt: string;
      inputImages?: Array<{ filePath: string; mimeType: string; fileName: string }>;
    };

    expect(payload.sessionKey).toBe('agent:main:main');
    expect(payload.prompt).toBe('把 logo 去掉');
    expect(payload.inputImages).toEqual([
      {
        fileName: 'bike.png',
        mimeType: 'image/png',
        filePath: '/tmp/bike.png',
      },
    ]);
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '图片已生成。',
      _attachedFiles: [
        expect.objectContaining({
          fileName: 'generated.png',
          mimeType: 'image/png',
          filePath: '/tmp/generated.png',
        }),
      ],
    });
  });

  it('uses the planner to route default-chat current-image edits to image edit with the latest assistant image', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [
        {
          role: 'assistant',
          content: '图片已生成。',
          _attachedFiles: [
            {
              fileName: 'room.png',
              mimeType: 'image/png',
              fileSize: 1024,
              preview: 'data:image/png;base64,abc',
              filePath: '/tmp/room.png',
              source: 'message-ref',
            },
          ],
        },
      ],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage('这个图片上能不能加一条狗？');

    const imageSendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/media/image-generation/chat-send');
    expect(imageSendCall).toBeTruthy();
    const payload = JSON.parse(
      (imageSendCall?.[1] as { body: string }).body,
    ) as {
      sessionKey: string;
      prompt: string;
      inputImages?: Array<{ filePath: string; mimeType: string; fileName: string }>;
    };

    expect(payload).toMatchObject({
      sessionKey: 'agent:main:main',
      prompt: '这个图片上能不能加一条狗？',
      inputImages: [
        {
          fileName: 'room.png',
          mimeType: 'image/png',
          filePath: '/tmp/room.png',
        },
      ],
    });
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/chat/send')).toBe(false);
  });

  it('keeps rewritten image prompts and auto-selected prior images out of the user-visible payload', async () => {
    const { useChatStore } = await import('@/stores/chat');
    const originalPrompt = '前面那1个狗狗的图片，能不能变成2条狗？';

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [
        {
          role: 'assistant',
          content: '图片已生成。',
          _attachedFiles: [
            {
              fileName: 'dog.png',
              mimeType: 'image/png',
              fileSize: 1024,
              preview: 'data:image/png;base64,abc',
              filePath: '/tmp/dog.png',
              source: 'message-ref',
            },
          ],
        },
      ],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });
    hostApiFetchMock.mockImplementation(async (url: string) => {
      if (url.toString().startsWith('/api/sessions/transcript?')) {
        return { messages: [] };
      }
      if (url === '/api/chat/send') {
        return { success: true, result: { runId: 'run-text' } };
      }
      if (url !== '/api/media/intent-plan') {
        return { success: true, result: {} };
      }
      return {
        success: true,
        plan: {
          action: 'image_edit',
          source: 'planner',
          confidence: 0.95,
          prompt: 'Internal planner prompt: turn the single dog into two dogs while preserving style.',
          selectedImageSource: 'candidate',
          selectedImageIndex: 0,
          sourceImages: [{
            fileName: 'dog.png',
            mimeType: 'image/png',
            filePath: '/tmp/dog.png',
          }],
        },
      };
    });

    await useChatStore.getState().sendMessage(originalPrompt);

    const imageSendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/media/image-generation/chat-send');
    expect(imageSendCall).toBeTruthy();
    const payload = JSON.parse(
      (imageSendCall?.[1] as { body: string }).body,
    ) as {
      sessionKey: string;
      originalPrompt?: string;
      prompt: string;
      inputImages?: Array<{ filePath: string; mimeType: string; fileName: string }>;
      userInputImages?: Array<{ filePath: string; mimeType: string; fileName: string }>;
      userMessageTimestampMs?: number;
    };

    expect(payload).toMatchObject({
      sessionKey: 'agent:main:main',
      originalPrompt,
      prompt: 'Internal planner prompt: turn the single dog into two dogs while preserving style.',
      inputImages: [
        {
          fileName: 'dog.png',
          mimeType: 'image/png',
          filePath: '/tmp/dog.png',
        },
      ],
      userInputImages: [],
      userMessageTimestampMs: Date.parse('2026-03-11T12:00:00Z'),
    });
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: 'user',
      content: originalPrompt,
    });
    expect(useChatStore.getState().messages.at(-1)?._attachedFiles).toBeUndefined();
  });

  it('asks a clarification instead of downgrading current-image edits when no image context exists', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage('这个图片上能不能加一条狗？');

    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/media/image-generation/chat-send')).toBe(false);
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/chat/send')).toBe(false);
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '你想编辑哪张图片？请上传或选中一张图片。',
    });
  });

  it('does not reuse the latest assistant image for a new image-generation prompt', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [
        {
          role: 'assistant',
          content: '图片已生成。',
          _attachedFiles: [
            {
              fileName: 'bike.png',
              mimeType: 'image/png',
              fileSize: 1024,
              preview: 'data:image/png;base64,abc',
              filePath: '/tmp/bike.png',
              source: 'message-ref',
            },
          ],
        },
      ],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage(
      '帮我生成一张全新的产品海报',
      undefined,
      undefined,
      'image',
      { size: '1024x1024', quality: 'medium' },
    );

    const imageSendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/media/image-generation/chat-send');
    expect(imageSendCall).toBeTruthy();
    const payload = JSON.parse(
      (imageSendCall?.[1] as { body: string }).body,
    ) as {
      sessionKey: string;
      prompt: string;
      inputImages?: Array<{ filePath: string; mimeType: string; fileName: string }>;
    };

    expect(payload.sessionKey).toBe('agent:main:main');
    expect(payload.prompt).toBe('帮我生成一张全新的产品海报');
    expect(payload.inputImages).toEqual([]);
  });

  it('auto-routes explicit image generation text to the image generation endpoint', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage('帮我生成一张产品海报');

    const imageSendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/media/image-generation/chat-send');
    expect(imageSendCall).toBeTruthy();
    const payload = JSON.parse(
      (imageSendCall?.[1] as { body: string }).body,
    ) as {
      sessionKey: string;
      prompt: string;
      model?: string;
      size?: string;
      quality?: string;
      inputImages?: Array<{ filePath: string; mimeType: string; fileName: string }>;
    };

    expect(payload).toMatchObject({
      sessionKey: 'agent:main:main',
      prompt: '帮我生成一张产品海报',
      model: 'gpt-image-2',
      size: '3840x2160',
      quality: 'high',
      inputImages: [],
    });
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/chat/send')).toBe(false);
  });

  it('auto-routes Chinese output-image wording to the image generation endpoint', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage('你之后自动帮我补全提示词 直接帮我出图');

    const imageSendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/media/image-generation/chat-send');
    expect(imageSendCall).toBeTruthy();
    const payload = JSON.parse(
      (imageSendCall?.[1] as { body: string }).body,
    ) as {
      sessionKey: string;
      prompt: string;
      inputImages?: Array<{ filePath: string; mimeType: string; fileName: string }>;
    };

    expect(payload).toMatchObject({
      sessionKey: 'agent:main:main',
      prompt: '你之后自动帮我补全提示词 直接帮我出图',
      inputImages: [],
    });
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/chat/send')).toBe(false);
  });

  it('keeps image lookup requests on the normal chat path', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage('帮我搜索几张参考图片');

    const sendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/chat/send');
    expect(sendCall).toBeTruthy();
    const payload = JSON.parse((sendCall?.[1] as { body: string }).body) as {
      sessionKey: string;
      message: string;
    };

    expect(payload).toMatchObject({
      sessionKey: 'agent:main:main',
      message: '帮我搜索几张参考图片',
    });
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/media/image-generation/chat-send')).toBe(false);
  });

  it('routes composite media plans through the local composite runner with runtime plan steps', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      runtimeRuns: {},
      error: null,
      loading: false,
      thinkingLevel: null,
    });
    hostApiFetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url.toString().startsWith('/api/sessions/transcript?')) {
        return { messages: [] };
      }
      if (url === '/api/media/image-generation/chat-send') {
        const body = init?.body ? JSON.parse(init.body) as { inputImages?: unknown[] } : {};
        const edited = (body.inputImages?.length ?? 0) > 0;
        return {
          success: true,
          job: {
            id: edited ? 'job-edit-poster' : 'job-poster',
            kind: 'image',
            sessionKey: 'agent:main:main',
            status: 'succeeded',
            result: {
              outputs: [{
                path: edited ? '/tmp/edit-poster.png' : '/tmp/poster.png',
                fileName: edited ? 'edit-poster.png' : 'poster.png',
                mimeType: 'image/png',
                size: 1024,
                width: 1024,
                height: 1024,
              }],
            },
          },
        };
      }
      if (url !== '/api/media/intent-plan') {
        return { success: true, result: {} };
      }
      return {
        success: true,
        plan: {
          action: 'chat',
          source: 'fallback',
          confidence: 1,
          reason: 'composite_intent_local',
          selectedImageSource: 'none',
          compositeTasks: [
            {
              id: 'poster',
              kind: 'image_generate',
              title: '生成活动主视觉',
              prompt: '生成一张科技活动主视觉海报。',
            },
            {
              id: 'edit-poster',
              kind: 'image_edit',
              title: '调整主视觉色调',
              prompt: '把刚生成的主视觉调整为蓝色调。',
              dependsOn: ['poster'],
            },
          ],
        },
      };
    });

    await useChatStore.getState().sendMessage('生成一张活动主视觉，再改成蓝色调');

    const sendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/chat/send');
    expect(sendCall).toBeFalsy();
    const imageCalls = hostApiFetchMock.mock.calls.filter(([url]) => url === '/api/media/image-generation/chat-send');
    expect(imageCalls).toHaveLength(2);
    for (const call of imageCalls) {
      const payload = JSON.parse((call[1] as { body: string }).body) as { suppressConversationAppend?: boolean };
      expect(payload.suppressConversationAppend).toBe(true);
    }
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/media/video-generation/chat-send')).toBe(false);
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/chat/send-with-media')).toBe(false);
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/local-artifacts/append-conversation')).toBe(true);

    const run = Object.values(useChatStore.getState().runtimeRuns)[0];
    expect(run?.planSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'uclaw.composite', kind: 'composite', status: 'completed' }),
      expect.objectContaining({
        id: 'uclaw.composite.poster',
        kind: 'composite-task',
        parentId: 'uclaw.composite',
        title: '生成活动主视觉',
        status: 'completed',
        requiresArtifact: true,
      }),
      expect.objectContaining({
        id: 'uclaw.composite.edit-poster',
        kind: 'composite-task',
        parentId: 'uclaw.composite',
        title: '调整主视觉色调',
        status: 'completed',
        requiresArtifact: true,
      }),
    ]));
  });

  it('feeds the latest dependent edited image into composite video generation', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      runtimeRuns: {},
      error: null,
      loading: false,
      thinkingLevel: null,
    });
    hostApiFetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url.toString().startsWith('/api/sessions/transcript?')) {
        return { messages: [] };
      }
      if (url === '/api/media/image-generation/chat-send') {
        const body = init?.body ? JSON.parse(init.body) as { inputImages?: unknown[] } : {};
        const edited = (body.inputImages?.length ?? 0) > 0;
        return {
          success: true,
          job: {
            id: edited ? 'job-edited-image' : 'job-generated-image',
            kind: 'image',
            sessionKey: 'agent:main:main',
            status: 'succeeded',
            result: {
              outputs: [{
                path: edited ? '/tmp/edited-image.png' : '/tmp/generated-image.png',
                fileName: edited ? 'edited-image.png' : 'generated-image.png',
                mimeType: 'image/png',
                size: 1024,
                width: 1024,
                height: 1024,
              }],
            },
          },
        };
      }
      if (url === '/api/media/video-generation/chat-send') {
        return {
          success: true,
          job: {
            id: 'job-video-from-edit',
            kind: 'video',
            sessionKey: 'agent:main:main',
            status: 'succeeded',
            result: {
              outputs: [{
                path: '/tmp/video-from-edit.mp4',
                fileName: 'video-from-edit.mp4',
                mimeType: 'video/mp4',
                size: 4096,
                durationSeconds: 15,
              }],
            },
          },
        };
      }
      if (url !== '/api/media/intent-plan') {
        return { success: true, result: {} };
      }
      return {
        success: true,
        plan: {
          action: 'chat',
          source: 'fallback',
          confidence: 1,
          reason: 'composite_intent_local',
          selectedImageSource: 'none',
          compositeTasks: [
            {
              id: 'task-1-image_generate',
              kind: 'image_generate',
              title: '生成图片',
              prompt: '生成一张未来城市工作台概念图。',
            },
            {
              id: 'task-2-image_edit',
              kind: 'image_edit',
              title: '图片改风格',
              prompt: '把刚生成的图片改成赛博朋克风。',
              dependsOn: ['task-1-image_generate'],
            },
            {
              id: 'task-3-video_generate',
              kind: 'video_generate',
              title: '基于改图生成视频',
              prompt: '基于改后的图生成 15 秒视频。',
              dependsOn: ['task-2-image_edit'],
            },
          ],
        },
      };
    });

    await useChatStore.getState().sendMessage('生成一张图，然后把这张图改成赛博朋克风，再基于改后的图生成 15 秒视频');

    const imageCalls = hostApiFetchMock.mock.calls.filter(([url]) => url === '/api/media/image-generation/chat-send');
    const videoCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/media/video-generation/chat-send');
    expect(imageCalls).toHaveLength(2);
    expect(videoCall).toBeTruthy();
    const payload = JSON.parse((videoCall?.[1] as { body: string }).body) as {
      inputImages?: Array<{ filePath: string; mimeType: string; fileName: string }>;
      route?: {
        mode?: string;
        sourceImages?: Array<{ filePath: string; mimeType: string; fileName: string }>;
      };
    };
    expect(payload.inputImages).toEqual([
      {
        fileName: 'edited-image.png',
        mimeType: 'image/png',
        filePath: '/tmp/edited-image.png',
      },
    ]);
    expect(payload.route?.mode).toBe('image_to_video');
    expect(payload.route?.sourceImages).toEqual(payload.inputImages);
  });

  it('routes a no-attachment multi-deliverable sample pack through the composite artifact runner', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      runtimeRuns: {},
      error: null,
      loading: false,
      thinkingLevel: null,
    });
    hostApiFetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url.toString().startsWith('/api/sessions/transcript?')) {
        return { messages: [] };
      }
      if (url === '/api/media/image-generation/chat-send') {
        const body = init?.body ? JSON.parse(init.body) as { inputImages?: unknown[] } : {};
        const edited = (body.inputImages?.length ?? 0) > 0;
        return {
          success: true,
          job: {
            id: edited ? 'job-image-edit' : 'job-image',
            kind: 'image',
            sessionKey: 'agent:main:main',
            status: 'succeeded',
            result: {
              outputs: [{
                path: edited ? '/tmp/uclaw-edit.png' : '/tmp/uclaw-image.png',
                fileName: edited ? 'uclaw-edit.png' : 'uclaw-image.png',
                mimeType: 'image/png',
                size: 1024,
                width: 1024,
                height: 1024,
              }],
            },
          },
        };
      }
      if (url === '/api/media/video-generation/chat-send') {
        return {
          success: true,
          job: {
            id: 'job-video',
            kind: 'video',
            sessionKey: 'agent:main:main',
            status: 'succeeded',
            result: {
              outputs: [{
                path: '/tmp/uclaw-video.mp4',
                fileName: 'uclaw-video.mp4',
                mimeType: 'video/mp4',
                size: 2048,
                durationSeconds: 15,
              }],
            },
          },
        };
      }
      if (url === '/api/local-artifacts/create') {
        const body = init?.body ? JSON.parse(init.body) as { kind?: string; title?: string } : {};
        const ext = body.kind === 'presentation' ? 'pptx' : body.kind === 'spreadsheet' ? 'xlsx' : body.kind === 'mini_program' ? 'html' : 'md';
        const mimeType = ext === 'pptx'
          ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
          : ext === 'xlsx'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : ext === 'html'
              ? 'text/html'
              : 'text/markdown';
        return {
          success: true,
          artifact: {
            kind: body.kind === 'mini_program' ? 'webpage' : body.kind,
            title: body.title || body.kind || 'artifact',
            fileName: `uclaw-${body.kind}.${ext}`,
            filePath: `/tmp/uclaw-${body.kind}.${ext}`,
            fileSize: 512,
            mimeType,
            media: `MEDIA:/tmp/uclaw-${body.kind}.${ext}`,
          },
        };
      }
      if (url !== '/api/media/intent-plan') {
        return { success: true, result: {} };
      }
      return {
        success: true,
        plan: {
          action: 'chat',
          source: 'fallback',
          confidence: 1,
          reason: 'composite_intent_local',
          selectedImageSource: 'none',
          compositeTasks: [
            { id: 'task-1-image_generate', kind: 'image_generate', title: '生成图片', prompt: '生成一张未来工作台概念图。' },
            { id: 'task-2-presentation', kind: 'presentation', title: '制作 PPT', prompt: '制作一份 AI 工作流效率提升 PPT。' },
            { id: 'task-3-spreadsheet', kind: 'spreadsheet', title: '制作 Excel', prompt: '制作一份月度预算 Excel。' },
            { id: 'task-4-video_generate', kind: 'video_generate', title: '生成视频', prompt: '生成一段未来城市工作台短视频。' },
            {
              id: 'task-5-image_edit',
              kind: 'image_edit',
              title: '根据图片修图',
              prompt: '用刚生成的图片做一版暖色电影感改图。',
              selectedImageSource: 'none',
              dependsOn: ['task-1-image_generate'],
              fallback: '没有显式输入图时，优先使用本轮前序图片生成子任务的结果。',
            },
            { id: 'task-6-mini_program', kind: 'mini_program', title: '制作小程序', prompt: '制作一个 Todo/灵感收集小工具。' },
            { id: 'task-7-copywriting', kind: 'copywriting', title: '撰写文案', prompt: '写一版产品宣传短文。' },
          ],
        },
      };
    });

    const prompt = '生图，PPT，Excel，生视频，根据图片修图，做小程序，生成文案，每个事儿都随便给我来一个';
    await useChatStore.getState().sendMessage(prompt);

    const sendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/chat/send');
    expect(sendCall).toBeFalsy();
    const imageCalls = hostApiFetchMock.mock.calls.filter(([url]) => url === '/api/media/image-generation/chat-send');
    const videoCalls = hostApiFetchMock.mock.calls.filter(([url]) => url === '/api/media/video-generation/chat-send');
    expect(imageCalls).toHaveLength(2);
    expect(videoCalls).toHaveLength(1);
    for (const call of [...imageCalls, ...videoCalls]) {
      const payload = JSON.parse((call[1] as { body: string }).body) as { suppressConversationAppend?: boolean };
      expect(payload.suppressConversationAppend).toBe(true);
    }
    expect(hostApiFetchMock.mock.calls.filter(([url]) => url === '/api/local-artifacts/create')).toHaveLength(4);
    const appendConversationCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/local-artifacts/append-conversation');
    expect(appendConversationCall).toBeTruthy();
    const appendPayload = JSON.parse((appendConversationCall?.[1] as { body: string }).body) as {
      runId?: string;
      prompt?: string;
      summaryText?: string;
      files?: Array<{
        fileName?: string;
        mimeType?: string;
        filePath?: string;
        gatewayUrl?: string;
        source?: string;
      }>;
      outputPaths?: string[];
    };
    expect(appendPayload.runId).toContain('history:agent:main:main:');
    expect(appendPayload.prompt).toBe(prompt);
    expect(appendPayload.summaryText).toContain('统一产物清单');
    expect(appendPayload.files).toHaveLength(7);
    expect(appendPayload.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fileName: 'uclaw-image.png',
        mimeType: 'image/png',
        filePath: '/tmp/uclaw-image.png',
        source: 'tool-result',
      }),
      expect.objectContaining({
        fileName: 'uclaw-video.mp4',
        mimeType: 'video/mp4',
        filePath: '/tmp/uclaw-video.mp4',
        source: 'tool-result',
      }),
    ]));
    expect(appendPayload.outputPaths).toEqual(expect.arrayContaining([
      '/tmp/uclaw-image.png',
      '/tmp/uclaw-presentation.pptx',
      '/tmp/uclaw-spreadsheet.xlsx',
      '/tmp/uclaw-video.mp4',
      '/tmp/uclaw-edit.png',
      '/tmp/uclaw-mini_program.html',
      '/tmp/uclaw-copywriting.md',
    ]));
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/chat/send-with-media')).toBe(false);

    const run = Object.values(useChatStore.getState().runtimeRuns)[0];
    const compositeSteps = run?.planSteps.filter((step) => step.kind === 'composite-task') ?? [];
    expect(compositeSteps).toHaveLength(7);
    expect(compositeSteps.map((step) => step.title)).toEqual([
      '生成图片',
      '制作 PPT',
      '制作 Excel',
      '生成视频',
      '根据图片修图',
      '制作小程序',
      '撰写文案',
    ]);
    expect(compositeSteps.every((step) => step.requiresArtifact === true)).toBe(true);
    expect(run?.artifacts).toHaveLength(7);
    expect(run?.gateResult?.decision).toBe('deliverable');
  });

  it('keeps automation planning requests with illustration wording on the normal chat path', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    const prompt = '我想让你帮我实现每天早上定时给我推送早报，然后根据优质内容改写之后自己配图发到我的微信公众号里，不使用公众号API实现';
    await useChatStore.getState().sendMessage(prompt);

    const sendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/chat/send');
    expect(sendCall).toBeTruthy();
    const payload = JSON.parse((sendCall?.[1] as { body: string }).body) as {
      sessionKey: string;
      message: string;
    };

    expect(payload).toMatchObject({
      sessionKey: 'agent:main:main',
      message: prompt,
    });
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/media/image-generation/chat-send')).toBe(false);
  });

  it('captures local desktop screenshots without routing through OpenClaw nodes', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage('你截图一下当前桌面');

    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/computer/desktop-screenshot')).toBe(true);
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/chat/send')).toBe(false);
    expect(gatewayRpcMock.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '已截取当前桌面。',
      _attachedFiles: [
        {
          fileName: 'desktop-screenshot.png',
          mimeType: 'image/png',
          fileSize: 1024,
          preview: 'data:image/png;base64,abc',
          source: 'tool-result',
        },
      ],
    });
  });

  it('forwards explicitly pasted image references for image-mode sends', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage(
      'remove logo',
      [{
        fileName: 'bike.png',
        mimeType: 'image/png',
        fileSize: 1024,
        stagedPath: '/tmp/bike.png',
        preview: 'data:image/png;base64,abc',
      }],
      undefined,
      'image',
      { size: '1024x1024', quality: 'medium' },
    );

    const imageSendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/media/image-generation/chat-send');
    expect(imageSendCall).toBeTruthy();
    const payload = JSON.parse(
      (imageSendCall?.[1] as { body: string }).body,
    ) as {
      inputImages?: Array<{ filePath: string; mimeType: string; fileName: string }>;
    };

    expect(payload.inputImages).toEqual([
      {
        fileName: 'bike.png',
        mimeType: 'image/png',
        filePath: '/tmp/bike.png',
      },
    ]);
    const imageModeUserMessage = useChatStore.getState().messages.find((message) => message.role === 'user');
    expect(imageModeUserMessage?._attachedFiles?.[0]).toMatchObject({
      fileName: 'bike.png',
      mimeType: 'image/png',
      filePath: '/tmp/bike.png',
      preview: 'data:image/png;base64,abc',
    });
    expect(useChatStore.getState().messages.at(-1)?._attachedFiles?.[0]).toMatchObject({
      fileName: 'generated.png',
      mimeType: 'image/png',
      filePath: '/tmp/generated.png',
    });
  });

  it('shows explicitly pasted image references for video-mode sends', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage(
      '让这张图动起来',
      [{
        fileName: 'frame.png',
        mimeType: 'image/png',
        fileSize: 1024,
        stagedPath: '/tmp/frame.png',
        preview: 'data:image/png;base64,abc',
      }],
      undefined,
      'video',
      undefined,
      { size: '1280x720', durationSeconds: 15 },
    );

    const videoSendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/media/video-generation/chat-send');
    expect(videoSendCall).toBeTruthy();
    const payload = JSON.parse(
      (videoSendCall?.[1] as { body: string }).body,
    ) as {
      inputImages?: Array<{ filePath: string; mimeType: string; fileName: string }>;
      durationSeconds?: number;
      model?: string;
    };

    expect(payload.durationSeconds).toBe(15);
    expect(payload.model).toBe('grok-video-1.5');
    expect(payload.inputImages).toEqual([
      {
        fileName: 'frame.png',
        mimeType: 'image/png',
        filePath: '/tmp/frame.png',
      },
    ]);
    const videoModeUserMessage = useChatStore.getState().messages.find((message) => message.role === 'user');
    expect(videoModeUserMessage?._attachedFiles?.[0]).toMatchObject({
      fileName: 'frame.png',
      mimeType: 'image/png',
      filePath: '/tmp/frame.png',
      preview: 'data:image/png;base64,abc',
    });
    expect(useChatStore.getState().messages.at(-1)?._attachedFiles?.[0]).toMatchObject({
      fileName: 'generated.mp4',
      mimeType: 'video/mp4',
      filePath: '/tmp/generated.mp4',
    });
  });

  it('does not reuse a previous assistant image for text-only video sends', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [
        {
          role: 'assistant',
          content: '图片已生成。',
          _attachedFiles: [
            {
              fileName: 'old-frame.png',
              mimeType: 'image/png',
              fileSize: 1024,
              preview: 'data:image/png;base64,abc',
              filePath: '/tmp/old-frame.png',
              source: 'message-ref',
            },
          ],
        },
      ],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage(
      '生成一段城市夜景视频',
      undefined,
      undefined,
      'video',
      undefined,
      { size: '1280x720', durationSeconds: 6 },
    );

    const videoSendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/media/video-generation/chat-send');
    expect(videoSendCall).toBeTruthy();
    const payload = JSON.parse(
      (videoSendCall?.[1] as { body: string }).body,
    ) as {
      inputImages?: Array<{ filePath: string; mimeType: string; fileName: string }>;
      candidateImages?: Array<{ filePath: string; mimeType: string; fileName: string }>;
      model?: string;
      durationSeconds?: number;
    };

    expect(payload.model).toBe('grok-image-video');
    expect(payload.durationSeconds).toBe(6);
    expect(payload.inputImages).toEqual([]);
    expect(payload.candidateImages).toBeUndefined();
  });

  it('sends a previous assistant image as a candidate for explicit previous-image video prompts', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [
        {
          role: 'assistant',
          content: '图片已生成。',
          _attachedFiles: [
            {
              fileName: 'old-frame.png',
              mimeType: 'image/png',
              fileSize: 1024,
              preview: 'data:image/png;base64,abc',
              filePath: '/tmp/old-frame.png',
              source: 'message-ref',
            },
          ],
        },
      ],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      pendingImageGenerationLocal: false,
      pendingVideoGenerationLocal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage(
      '用上一张图，改成蓝色调，然后给我出视频',
      undefined,
      undefined,
      'video',
      undefined,
      { size: '1280x720', durationSeconds: 6 },
    );

    const videoSendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/media/video-generation/chat-send');
    expect(videoSendCall).toBeTruthy();
    const payload = JSON.parse(
      (videoSendCall?.[1] as { body: string }).body,
    ) as {
      inputImages?: Array<{ filePath: string; mimeType: string; fileName: string }>;
      candidateImages?: Array<{ filePath: string; mimeType: string; fileName: string }>;
      model?: string;
      durationSeconds?: number;
    };

    expect(payload.durationSeconds).toBe(6);
    expect(payload.model).toBe('grok-video-1.5');
    expect(payload.inputImages).toEqual([
      {
        fileName: 'old-frame.png',
        mimeType: 'image/png',
        filePath: '/tmp/old-frame.png',
      },
    ]);
    expect(payload.candidateImages).toBeUndefined();
  });
});
