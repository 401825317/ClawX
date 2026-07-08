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

  it('routes composite media plans through normal chat with an execution contract and runtime plan steps', async () => {
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
            },
          ],
        },
      };
    });

    await useChatStore.getState().sendMessage('生成一张活动主视觉，再改成蓝色调');

    const sendCall = hostApiFetchMock.mock.calls.find(([url]) => url === '/api/chat/send');
    expect(sendCall).toBeTruthy();
    const payload = JSON.parse((sendCall?.[1] as { body: string }).body) as {
      sessionKey: string;
      message: string;
    };
    expect(payload.sessionKey).toBe('agent:main:main');
    expect(payload.message).toContain('【UClaw composite execution contract】');
    expect(payload.message).toContain('自动确定一个简洁主题/标题');
    expect(payload.message).toContain('不要询问用户先做哪个');
    expect(payload.message).toContain('每个子任务都必须产生自己的可交付产物');
    expect(payload.message).toContain('可以使用本轮前序子任务刚生成的图片');
    expect(payload.message).toContain('生成活动主视觉');
    expect(payload.message).toContain('调整主视觉色调');
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/media/image-generation/chat-send')).toBe(false);
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/media/video-generation/chat-send')).toBe(false);
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/chat/send-with-media')).toBe(false);

    const run = useChatStore.getState().runtimeRuns['run-text'];
    expect(run?.planSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'uclaw.composite', kind: 'composite', status: 'running' }),
      expect.objectContaining({
        id: 'uclaw.composite.poster',
        kind: 'composite-task',
        parentId: 'uclaw.composite',
        title: '生成活动主视觉',
        requiresArtifact: true,
      }),
      expect.objectContaining({
        id: 'uclaw.composite.edit-poster',
        kind: 'composite-task',
        parentId: 'uclaw.composite',
        title: '调整主视觉色调',
        detail: expect.stringContaining('刚生成图片'),
        requiresArtifact: true,
      }),
    ]));
  });

  it('routes a no-attachment multi-deliverable sample pack through normal chat instead of asking for one mode', async () => {
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
    expect(sendCall).toBeTruthy();
    const payload = JSON.parse((sendCall?.[1] as { body: string }).body) as {
      sessionKey: string;
      message: string;
    };
    expect(payload.sessionKey).toBe('agent:main:main');
    expect(payload.message).toContain('【UClaw composite execution contract】');
    expect(payload.message).toContain('不要询问用户先做哪个');
    expect(payload.message).toContain('不能用“我一次只能执行一种类型”来结束');
    expect(payload.message).toContain('生成图片');
    expect(payload.message).toContain('制作 PPT');
    expect(payload.message).toContain('制作 Excel');
    expect(payload.message).toContain('生成视频');
    expect(payload.message).toContain('根据图片修图');
    expect(payload.message).toContain('制作小程序');
    expect(payload.message).toContain('撰写文案');
    expect(payload.message).toContain('依赖：task-1-image_generate');
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/media/image-generation/chat-send')).toBe(false);
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/media/video-generation/chat-send')).toBe(false);
    expect(hostApiFetchMock.mock.calls.some(([url]) => url === '/api/chat/send-with-media')).toBe(false);

    const run = useChatStore.getState().runtimeRuns['run-text'];
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
