import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dedupeTurnAttachments } from '@/lib/acp/attachments';
import { appendSyntheticAssistantMessage } from '@/lib/acp/reducer';
import type { AttachmentRenderPart, RenderPart } from '@/lib/acp/timeline-types';
import { UCLAW_VIDEO_GENERATION_TIMEOUT_MS } from '@shared/junfeiai-endpoints';

const hostApiMock = vi.hoisted(() => ({
  loadAcpSession: vi.fn(),
  sendAcpPrompt: vi.fn(),
  cancelAcpSession: vi.fn(),
  respondAcpPermission: vi.fn(),
  mediaThumbnails: vi.fn(),
  recordAcpTrace: vi.fn(),
  sessionsHistory: vi.fn(),
  sessionTurnTimings: vi.fn(),
  resolveAttachment: vi.fn(),
}));

const hostEventsMock = vi.hoisted(() => ({
  updateListener: null as ((payload: unknown) => void) | null,
  permissionListener: null as ((payload: unknown) => void) | null,
  gatewayChatMessageListener: null as ((payload: unknown) => void) | null,
  runtimeEventListener: null as ((payload: unknown) => void) | null,
  onAcpSessionUpdate: vi.fn((listener: (payload: unknown) => void) => {
    hostEventsMock.updateListener = listener;
    return () => { hostEventsMock.updateListener = null; };
  }),
  onAcpPermissionRequest: vi.fn((listener: (payload: unknown) => void) => {
    hostEventsMock.permissionListener = listener;
    return () => { hostEventsMock.permissionListener = null; };
  }),
  onGatewayChatMessage: vi.fn((listener: (payload: unknown) => void) => {
    hostEventsMock.gatewayChatMessageListener = listener;
    return () => { hostEventsMock.gatewayChatMessageListener = null; };
  }),
  onChatRuntimeEvent: vi.fn((listener: (payload: unknown) => void) => {
    hostEventsMock.runtimeEventListener = listener;
    return () => { hostEventsMock.runtimeEventListener = null; };
  }),
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    chat: {
      loadAcpSession: hostApiMock.loadAcpSession,
      sendAcpPrompt: hostApiMock.sendAcpPrompt,
      cancelAcpSession: hostApiMock.cancelAcpSession,
      respondAcpPermission: hostApiMock.respondAcpPermission,
    },
    media: {
      thumbnails: hostApiMock.mediaThumbnails,
    },
    diagnostics: {
      recordAcpTrace: hostApiMock.recordAcpTrace,
    },
    sessions: {
      history: hostApiMock.sessionsHistory,
      turnTimings: hostApiMock.sessionTurnTimings,
    },
    files: {
      resolveAttachment: hostApiMock.resolveAttachment,
    },
  },
}));

vi.mock('@/lib/host-events', () => ({
  hostEvents: {
    onAcpSessionUpdate: hostEventsMock.onAcpSessionUpdate,
    onAcpPermissionRequest: hostEventsMock.onAcpPermissionRequest,
    onGatewayChatMessage: hostEventsMock.onGatewayChatMessage,
    onChatRuntimeEvent: hostEventsMock.onChatRuntimeEvent,
  },
}));

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string) => {
      const labels: Record<string, string> = {
        'chat:imageGeneration.generatedReady': 'Generated image is ready.',
        'chat:imageGeneration.generatedReadyWithMissing': 'Generated image is ready. Some images could not be loaded.',
        'chat:imageGeneration.previewUnavailable': 'Image generation completed, but the preview could not be loaded.',
        'chat:acp.image': 'Image',
      };
      return labels[key] ?? key;
    },
  },
}));

async function importStore() {
  return import('@/stores/acp-chat-session');
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function availableAttachment(
  attachmentId: string,
  source: AttachmentRenderPart['source'],
  identity: string,
): AttachmentRenderPart {
  return {
    kind: 'attachment',
    attachmentId,
    reference: { uri: `file:///repo/${attachmentId}.txt`, name: `${attachmentId}.txt` },
    source,
    access: {
      status: 'available',
      identity,
      mimeType: 'text/plain',
      size: 42,
      target: {
        kind: 'local',
        scope: 'workspace',
        ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: `file:///repo/${attachmentId}.txt` },
      },
    },
  };
}

describe('ACP Chat store', () => {
  beforeEach(() => {
    vi.resetModules();
    hostApiMock.loadAcpSession.mockReset().mockResolvedValue({ success: true, generation: 1 });
    hostApiMock.sendAcpPrompt.mockReset().mockResolvedValue({ success: true });
    hostApiMock.cancelAcpSession.mockReset().mockResolvedValue({ success: true });
    hostApiMock.respondAcpPermission.mockReset().mockResolvedValue({ success: true });
    hostApiMock.mediaThumbnails.mockReset().mockResolvedValue({});
    hostApiMock.recordAcpTrace.mockReset().mockResolvedValue({ success: true });
    hostApiMock.sessionsHistory.mockReset().mockResolvedValue({ success: true, messages: [] });
    hostApiMock.sessionTurnTimings.mockReset().mockResolvedValue({ success: true, timings: [] });
    hostApiMock.resolveAttachment.mockReset().mockImplementation(async (payload: {
      ref: { sessionKey: string; generation: number; uri: string };
      mimeType?: string;
    }) => {
      const isImage = payload.mimeType?.startsWith('image/');
      return {
        ok: true,
        identity: isImage ? payload.ref.uri : 'attachment-identity',
        displayName: isImage ? payload.ref.uri.split('/').pop() ?? 'image.png' : 'report.txt',
        mimeType: isImage ? payload.mimeType : 'text/plain',
        size: 42,
        target: {
          kind: 'local',
          scope: 'workspace',
          ref: payload.ref,
        },
      };
    });
    hostEventsMock.updateListener = null;
    hostEventsMock.permissionListener = null;
    hostEventsMock.gatewayChatMessageListener = null;
    hostEventsMock.runtimeEventListener = null;
    hostEventsMock.onAcpSessionUpdate.mockClear();
    hostEventsMock.onAcpPermissionRequest.mockClear();
    hostEventsMock.onGatewayChatMessage.mockClear();
    hostEventsMock.onChatRuntimeEvent.mockClear();
  });

  it('prepares a local pending session by clearing renderer state without loading ACP', async () => {
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo-a', cwd: '/repo-a/project',
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: 'old' },
        },
      },
    });
    expect(useAcpChatSessionStore.getState().timeline.itemOrder).toEqual(['msg-1:0']);
    hostApiMock.loadAcpSession.mockClear();

    useAcpChatSessionStore.getState().prepareLocalSession({
      sessionKey: 'agent:pi:session-local',
      workspaceRoot: '/repo-b',
      cwd: '/repo-b/project',
    });

    expect(hostApiMock.loadAcpSession).not.toHaveBeenCalled();
    expect(useAcpChatSessionStore.getState()).toMatchObject({
      activeSessionKey: 'agent:pi:session-local',
      workspaceRoot: '/repo-b',
      cwd: '/repo-b/project',
      loading: false,
      sending: false,
      cancelling: false,
      error: null,
    });
    expect(useAcpChatSessionStore.getState().timeline).toMatchObject({
      sessionId: 'agent:pi:session-local',
      itemOrder: [],
    });
  });

  it('loads a session, resets the timeline, subscribes once, and ignores stale generation updates', async () => {
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    ensureAcpChatSubscriptions();

    await expect(useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo/packages/app',
    })).resolves.toBe(true);
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: 'fresh' },
        },
      },
    });
    expect(useAcpChatSessionStore.getState().timeline.itemOrder).toEqual(['msg-1:0']);

    hostApiMock.loadAcpSession.mockResolvedValueOnce({ success: true, generation: 2 });
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo/packages/app',
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'stale-msg',
          content: { type: 'text', text: 'stale' },
        },
      },
    });

    expect(hostEventsMock.onAcpSessionUpdate).toHaveBeenCalledTimes(1);
    expect(hostEventsMock.onAcpPermissionRequest).toHaveBeenCalledTimes(1);
    expect(hostEventsMock.onGatewayChatMessage).toHaveBeenCalledTimes(1);
    expect(hostEventsMock.onChatRuntimeEvent).toHaveBeenCalledTimes(1);
    expect(hostApiMock.loadAcpSession).toHaveBeenLastCalledWith({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo/packages/app',
    });
    expect(useAcpChatSessionStore.getState()).toMatchObject({
      activeSessionKey: 'agent:pi:s1',
      workspaceRoot: '/repo',
      cwd: '/repo/packages/app',
      generation: 2,
      loading: false,
      error: null,
    });
    expect(useAcpChatSessionStore.getState().timeline).toMatchObject({
      sessionId: 'agent:pi:s1',
      loadGeneration: 2,
      itemOrder: [],
    });
  });

  it('keeps the complete replay after preparing a local chat and quickly loading history again', async () => {
    const historicalLoad = createDeferred<{
      success: boolean;
      generation?: number;
      sessionUpdates?: Array<Record<string, unknown>>;
    }>();
    hostApiMock.loadAcpSession
      .mockResolvedValueOnce({ success: true, generation: 1 })
      .mockReturnValueOnce(historicalLoad.promise);
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();

    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    useAcpChatSessionStore.getState().prepareLocalSession({
      sessionKey: 'agent:pi:session-local',
      workspaceRoot: '/repo',
      cwd: '/repo',
    });
    const reloadPromise = useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    historicalLoad.resolve({
      success: true,
      generation: 2,
      sessionUpdates: [
        {
          sessionKey: 'agent:pi:s1',
          generation: 2,
          historical: true,
          notification: {
            sessionId: 'agent:pi:s1',
            update: {
              sessionUpdate: 'user_message_chunk',
              messageId: 'history-user',
              content: { type: 'text', text: 'history prompt' },
            },
          },
        },
        {
          sessionKey: 'agent:pi:s1',
          generation: 2,
          historical: true,
          notification: {
            sessionId: 'agent:pi:s1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'history-assistant',
              content: { type: 'text', text: 'complete historical answer' },
            },
          },
        },
      ],
    });

    await expect(reloadPromise).resolves.toBe(true);
    expect(useAcpChatSessionStore.getState().timeline.itemOrder).toEqual([
      'history-user:0',
      'history-assistant:0',
    ]);
    expect(useAcpChatSessionStore.getState().timeline.itemsById['history-user:0']).toMatchObject({
      parts: [{ kind: 'markdown', text: 'history prompt' }],
    });
    expect(useAcpChatSessionStore.getState().timeline.itemsById['history-assistant:0']).toMatchObject({
      parts: [{ kind: 'markdown', text: 'complete historical answer' }],
    });
  });

  it('commits a completed ACP load batch as one timeline snapshot', async () => {
    hostApiMock.loadAcpSession.mockResolvedValueOnce({
      success: true,
      generation: 1,
      sessionUpdates: [
        {
          sessionKey: 'agent:pi:s1',
          generation: 1,
          historical: true,
          notification: {
            sessionId: 'agent:pi:s1',
            update: {
              sessionUpdate: 'user_message_chunk',
              messageId: 'batched-user',
              content: { type: 'text', text: 'batched prompt' },
            },
          },
        },
        {
          sessionKey: 'agent:pi:s1',
          generation: 1,
          historical: true,
          notification: {
            sessionId: 'agent:pi:s1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'batched-assistant',
              content: { type: 'text', text: 'batched answer' },
            },
          },
        },
      ],
    });
    const { useAcpChatSessionStore } = await importStore();
    const observed: Array<{ loading: boolean; itemCount: number }> = [];
    const unsubscribe = useAcpChatSessionStore.subscribe((state) => {
      observed.push({ loading: state.loading, itemCount: state.timeline.itemOrder.length });
    });

    await expect(useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
    })).resolves.toBe(true);
    unsubscribe();

    expect(observed).not.toContainEqual({ loading: false, itemCount: 1 });
    expect(observed.at(-1)).toEqual({ loading: false, itemCount: 2 });
  });

  it('ignores event-channel updates and image side effects while a session load is pending', async () => {
    const load = createDeferred<{ success: boolean; generation?: number }>();
    hostApiMock.loadAcpSession.mockReturnValueOnce(load.promise);
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    const loadPromise = useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 99,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'stale-load-message',
          content: { type: 'text', text: 'stale replay' },
        },
      },
    });

    expect(useAcpChatSessionStore.getState().timeline.itemOrder).toEqual([]);
    expect(useAcpChatSessionStore.getState().generation).toBe(0);
    expect(hostApiMock.mediaThumbnails).not.toHaveBeenCalled();
    load.resolve({ success: true, generation: 1 });
    await loadPromise;
  });

  it('merges matching event-channel updates that arrive during the load handoff', async () => {
    const load = createDeferred<{ success: boolean; generation?: number }>();
    hostApiMock.loadAcpSession.mockReturnValueOnce(load.promise);
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    const loadPromise = useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'handoff-message',
          content: { type: 'text', text: 'arrived during IPC handoff' },
        },
      },
    });

    expect(useAcpChatSessionStore.getState().timeline.itemOrder).toEqual([]);
    load.resolve({ success: true, generation: 1 });
    await loadPromise;
    expect(useAcpChatSessionStore.getState().timeline.itemsById['handoff-message:0']).toMatchObject({
      parts: [{ kind: 'markdown', text: 'arrived during IPC handoff' }],
    });
  });

  it('applies matching generation updates', async () => {
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: 'fresh' },
        },
      },
    });

    expect(useAcpChatSessionStore.getState().timeline.itemOrder).toEqual(['msg-1:0']);
    expect(useAcpChatSessionStore.getState().timeline.itemsById['msg-1:0']).toMatchObject({
      kind: 'message-segment',
      role: 'assistant',
      parts: [{ kind: 'markdown', text: 'fresh' }],
    });
  });

  it('supplements ACP replayed turns with transcript-derived whole-turn timing', async () => {
    hostApiMock.loadAcpSession.mockResolvedValueOnce({
      success: true,
      generation: 1,
      sessionUpdates: [
        {
          sessionKey: 'agent:pi:s1',
          generation: 1,
          historical: true,
          notification: {
            sessionId: 'agent:pi:s1',
            update: {
              sessionUpdate: 'user_message_chunk',
              messageId: 'user-history',
              content: { type: 'text', text: 'Measure this turn' },
            },
          },
        },
        {
          sessionKey: 'agent:pi:s1',
          generation: 1,
          historical: true,
          notification: {
            sessionId: 'agent:pi:s1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'assistant-history',
              content: { type: 'text', text: 'Measured' },
            },
          },
        },
      ],
    });
    hostApiMock.sessionTurnTimings.mockResolvedValueOnce({
      success: true,
      timings: [{
        normalizedUserText: 'Measure this turn',
        userOccurrenceFromTail: 1,
        durationMs: 6_400,
      }],
    });
    const { useAcpChatSessionStore } = await importStore();

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });

    await vi.waitFor(() => expect(useAcpChatSessionStore.getState().turnTimingsByUserMessageId).toEqual({
      'user-history': { source: 'transcript', status: 'complete', durationMs: 6_400 },
    }));
    expect(hostApiMock.sessionTurnTimings).toHaveBeenCalledWith({
      sessionKey: 'agent:pi:s1',
      limit: 1000,
    });
  });

  it('tracks live whole-turn timing and freezes it when the prompt settles', async () => {
    const prompt = createDeferred<{ success: boolean; generation: number }>();
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const { useAcpChatSessionStore } = await importStore();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });

    const sending = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'Time this', messageId: 'user-live',
    });
    await vi.waitFor(() => expect(hostApiMock.sendAcpPrompt).toHaveBeenCalledTimes(1));
    expect(useAcpChatSessionStore.getState().turnTimingsByUserMessageId).toEqual({
      'user-live': { source: 'live', status: 'running', startedAtMs: 1_000 },
    });

    now.mockReturnValue(4_600);
    prompt.resolve({ success: true, generation: 1 });
    await expect(sending).resolves.toBe(true);
    expect(useAcpChatSessionStore.getState().turnTimingsByUserMessageId).toEqual({
      'user-live': { source: 'live', status: 'complete', durationMs: 3_600 },
    });
    now.mockRestore();
  });

  it('keeps an in-flight timeline updated while another session is active and restores it on return', async () => {
    const prompt = createDeferred<{ success: boolean; generation: number }>();
    hostApiMock.loadAcpSession
      .mockResolvedValueOnce({ success: true, generation: 1 })
      .mockResolvedValueOnce({ success: true, generation: 2 })
      .mockResolvedValueOnce({ success: true, generation: 1, resumedActivePrompt: true });
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });
    const sendPrompt = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'keep streaming', messageId: 'msg-user',
    });
    await vi.waitFor(() => expect(hostApiMock.sendAcpPrompt).toHaveBeenCalledTimes(1));
    const timingBeforeNavigation = useAcpChatSessionStore.getState().turnTimingsByUserMessageId['msg-user'];
    expect(timingBeforeNavigation).toMatchObject({ source: 'live', status: 'running' });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-assistant',
          content: { type: 'text', text: 'before switch ' },
        },
      },
    });

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s2', workspaceRoot: '/repo', cwd: '/repo',
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-assistant',
          content: { type: 'text', text: 'while away ' },
        },
      },
    });

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });
    expect(useAcpChatSessionStore.getState()).toMatchObject({
      activeSessionKey: 'agent:pi:s1',
      generation: 1,
      sending: true,
    });
    expect(useAcpChatSessionStore.getState().turnTimingsByUserMessageId['msg-user'])
      .toEqual(timingBeforeNavigation);
    expect(useAcpChatSessionStore.getState().timeline.itemsById['msg-assistant:0']).toMatchObject({
      parts: [{ kind: 'markdown', text: 'before switch while away ' }],
    });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-assistant',
          content: { type: 'text', text: 'after return' },
        },
      },
    });
    expect(useAcpChatSessionStore.getState().timeline.itemsById['msg-assistant:0']).toMatchObject({
      parts: [{ kind: 'markdown', text: 'before switch while away after return' }],
    });

    prompt.resolve({ success: true, generation: 1 });
    await expect(sendPrompt).resolves.toBe(true);
    expect(useAcpChatSessionStore.getState().sending).toBe(false);
  });

  it('keeps historical media visible while background generation is pending across navigation', async () => {
    const pendingTaskId = '59635a84-fcb4-438a-9566-64a8308c9011';
    const prompt = createDeferred<{ success: boolean; generation: number }>();
    const historicalReplay = [
      {
        sessionKey: 'agent:pi:s1',
        generation: 1,
        historical: true,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'user_message',
            messageId: 'history-user',
            content: [{ type: 'text', text: 'Generate the first image' }],
          },
        },
      },
      {
        sessionKey: 'agent:pi:s1',
        generation: 1,
        historical: true,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'history-image-tool',
            title: 'Generate image',
            status: 'completed',
            content: [],
            locations: [],
          },
        },
      },
    ];
    hostApiMock.loadAcpSession
      .mockResolvedValueOnce({ success: true, generation: 1, sessionUpdates: historicalReplay })
      .mockResolvedValueOnce({ success: true, generation: 2, sessionUpdates: [] })
      .mockResolvedValueOnce({
        success: true,
        generation: 3,
        resumedActivePrompt: false,
        sessionUpdates: [
          ...historicalReplay.map((event) => ({ ...event, generation: 3 })),
          {
            sessionKey: 'agent:pi:s1',
            generation: 3,
            historical: true,
            notification: {
              sessionId: 'agent:pi:s1',
              update: {
                sessionUpdate: 'user_message',
                messageId: 'pending-user',
                content: [{ type: 'text', text: 'Modify the image' }],
              },
            },
          },
          {
            sessionKey: 'agent:pi:s1',
            generation: 3,
            historical: true,
            notification: {
              sessionId: 'agent:pi:s1',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'pending-image-tool',
                title: 'Generate image',
                status: 'completed',
                content: [{
                  type: 'content',
                  content: {
                    type: 'text',
                    text: `Background task started for image generation (${pendingTaskId}).`,
                  },
                }],
                locations: [],
              },
            },
          },
        ],
      });
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
    });
    useAcpChatSessionStore.setState((state) => ({
      timeline: appendSyntheticAssistantMessage(state.timeline, {
        messageId: 'compat:image-generation:history-image',
        evidenceId: 'history-image-evidence',
        afterItemId: 'tool:history-image-tool',
        parts: [
          { kind: 'markdown', text: 'Generated image is ready.' },
          {
            kind: 'image',
            source: 'data:image/png;base64,history',
            mimeType: 'image/png',
            mediaIdentity: 'history-image-identity',
            attachmentFileRef: {
              sessionKey: 'agent:pi:s1',
              generation: 1,
              uri: 'file:///repo/history.png',
            },
          },
        ],
      }),
    }));
    const sendPrompt = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'Modify the image',
      messageId: 'pending-user',
    });
    await vi.waitFor(() => expect(hostApiMock.sendAcpPrompt).toHaveBeenCalledTimes(1));
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'pending-image-tool',
          title: 'Generate image',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${pendingTaskId}).`,
            },
          }],
          locations: [],
        },
      },
    });
    expect(useAcpChatSessionStore.getState().pendingImageGenerationTaskIds).toEqual([pendingTaskId]);

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s2', workspaceRoot: '/repo-2', cwd: '/repo-2', createIfMissing: true,
    });
    prompt.resolve({ success: true, generation: 1 });
    await expect(sendPrompt).resolves.toBe(true);
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
    });

    const state = useAcpChatSessionStore.getState();
    const mediaItemId = state.timeline.itemOrder.find((itemId) => (
      state.timeline.itemsById[itemId]?.kind === 'message-segment'
      && state.timeline.itemsById[itemId]?.compat?.evidenceId === 'history-image-evidence'
    ));
    expect(state.pendingImageGenerationTaskIds).toEqual([pendingTaskId]);
    expect(state.sending).toBe(false);
    expect(state.turnTimingsByUserMessageId['pending-user']).toMatchObject({
      source: 'live',
      status: 'complete',
    });
    expect(mediaItemId).toBeTruthy();
    expect(state.timeline.itemOrder).toEqual([
      'history-user:0',
      'tool:history-image-tool',
      mediaItemId,
      'pending-user:0',
      'tool:pending-image-tool',
    ]);
    expect(state.timeline.itemsById[mediaItemId!]).toMatchObject({
      role: 'assistant',
      compat: { source: 'image-generation', evidenceId: 'history-image-evidence' },
      parts: [
        { kind: 'markdown', text: 'Generated image is ready.' },
        {
          kind: 'image',
          mediaIdentity: 'history-image-identity',
          attachmentFileRef: {
            sessionKey: 'agent:pi:s1',
            generation: 3,
            uri: 'file:///repo/history.png',
          },
        },
      ],
    });
  });

  it('retains a background snapshot when an image task starts after navigation', async () => {
    const taskId = 'ef4d45ee-2e9e-4b68-9bf4-3e9049bf8f12';
    const prompt = createDeferred<{ success: boolean; generation: number }>();
    hostApiMock.loadAcpSession
      .mockResolvedValueOnce({ success: true, generation: 1, sessionUpdates: [] })
      .mockResolvedValueOnce({ success: true, generation: 2, sessionUpdates: [] })
      .mockResolvedValueOnce({
        success: true,
        generation: 3,
        resumedActivePrompt: false,
        sessionUpdates: [
          {
            sessionKey: 'agent:pi:s1',
            generation: 3,
            historical: true,
            notification: {
              sessionId: 'agent:pi:s1',
              update: {
                sessionUpdate: 'user_message',
                messageId: 'replayed-user',
                content: [{ type: 'text', text: 'Generate an image in the background' }],
              },
            },
          },
          {
            sessionKey: 'agent:pi:s1',
            generation: 3,
            historical: true,
            notification: {
              sessionId: 'agent:pi:s1',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'replayed-image-tool',
                title: 'Generate image',
                status: 'completed',
                content: [{
                  type: 'content',
                  content: {
                    type: 'text',
                    text: `Background task started for image generation (${taskId}).`,
                  },
                }],
                locations: [],
              },
            },
          },
        ],
      });
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
    });
    const sendPrompt = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'Generate an image in the background',
      messageId: 'live-background-user',
    });
    await vi.waitFor(() => expect(hostApiMock.sendAcpPrompt).toHaveBeenCalledTimes(1));
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s2', workspaceRoot: '/repo-2', cwd: '/repo-2', createIfMissing: true,
    });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'live-image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    prompt.resolve({ success: true, generation: 1 });
    await expect(sendPrompt).resolves.toBe(true);
    expect(useAcpChatSessionStore.getState()).toMatchObject({
      activeSessionKey: 'agent:pi:s2',
      pendingImageGenerationTaskIds: [],
      error: null,
    });

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
    });
    expect(useAcpChatSessionStore.getState()).toMatchObject({
      activeSessionKey: 'agent:pi:s1',
      generation: 3,
      sending: false,
      pendingImageGenerationTaskIds: [taskId],
    });
    expect(useAcpChatSessionStore.getState().turnTimingsByUserMessageId['live-background-user'])
      .toMatchObject({ source: 'live', status: 'complete' });

    hostApiMock.mediaThumbnails.mockResolvedValueOnce({
      '/tmp/background-result.png': {
        preview: 'data:image/png;base64,background-result',
        fileSize: 64,
      },
    });
    hostEventsMock.gatewayChatMessageListener?.({
      message: {
        sessionKey: 'agent:pi:s1',
        runId: `image_generate:${taskId}:completion`,
        message: {
          role: 'toolresult',
          toolName: 'message',
          details: { mediaUrls: ['/tmp/background-result.png'] },
        },
      },
    });
    await vi.waitFor(() => expect(useAcpChatSessionStore.getState().pendingImageGenerationTaskIds).toEqual([]));
    expect(Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
      .flatMap((item) => item.kind === 'message-segment' ? item.parts : [])
      .filter((part) => part.kind === 'image')).toMatchObject([
      { source: 'data:image/png;base64,background-result' },
    ]);
  });

  it('retries a deferred image completion after its first resolution becomes stale during navigation', async () => {
    const taskId = '52d80874-bc9b-47c4-b337-3e28bf23f3bd';
    const imagePath = '/tmp/deferred-navigation-result.png';
    const firstResolution = createDeferred<Record<string, unknown>>();
    const replay = (generation: number) => [
      {
        sessionKey: 'agent:pi:s1',
        generation,
        historical: true,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'user_message',
            messageId: 'background-user',
            content: [{ type: 'text', text: 'Generate an image while I navigate' }],
          },
        },
      },
      {
        sessionKey: 'agent:pi:s1',
        generation,
        historical: true,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'background-image-tool',
            title: 'Generate image',
            status: 'completed',
            content: [{
              type: 'content',
              content: {
                type: 'text',
                text: `Background task started for image generation (${taskId}).`,
              },
            }],
            locations: [],
          },
        },
      },
    ];
    hostApiMock.loadAcpSession
      .mockResolvedValueOnce({ success: true, generation: 1, sessionUpdates: [] })
      .mockResolvedValueOnce({ success: true, generation: 2, sessionUpdates: [] })
      .mockResolvedValueOnce({ success: true, generation: 3, sessionUpdates: replay(3) })
      .mockResolvedValueOnce({ success: true, generation: 4, sessionUpdates: [] })
      .mockResolvedValueOnce({ success: true, generation: 5, sessionUpdates: replay(5) });
    hostApiMock.resolveAttachment
      .mockReturnValueOnce(firstResolution.promise)
      .mockImplementation(async (payload: {
        ref: { sessionKey: string; generation: number; uri: string };
      }) => ({
        ok: true,
        identity: 'deferred-navigation-image',
        displayName: 'deferred-navigation-result.png',
        mimeType: 'image/png',
        size: 64,
        target: { kind: 'local', scope: 'openclaw-media', ref: payload.ref },
      }));
    hostApiMock.mediaThumbnails.mockResolvedValue({
      'deferred-navigation-image': {
        preview: 'data:image/png;base64,deferred-navigation',
        fileSize: 64,
      },
    });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'background-image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    expect(useAcpChatSessionStore.getState().pendingImageGenerationTaskIds).toEqual([taskId]);

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s2', workspaceRoot: '/repo-2', cwd: '/repo-2', createIfMissing: true,
    });
    hostEventsMock.gatewayChatMessageListener?.({
      message: {
        sessionKey: 'agent:pi:s1',
        runId: `image_generate:${taskId}:completion`,
        message: {
          role: 'toolresult',
          toolName: 'message',
          details: { mediaUrls: [imagePath] },
        },
      },
    });
    expect(hostApiMock.resolveAttachment).not.toHaveBeenCalled();

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
    });
    await vi.waitFor(() => expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(1));
    expect(useAcpChatSessionStore.getState().pendingImageGenerationTaskIds).toEqual([taskId]);

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s2', workspaceRoot: '/repo-2', cwd: '/repo-2', createIfMissing: true,
    });
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
    });
    await vi.waitFor(() => expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(useAcpChatSessionStore.getState().pendingImageGenerationTaskIds).toEqual([]));

    firstResolution.resolve({
      ok: true,
      identity: 'deferred-navigation-image',
      displayName: 'deferred-navigation-result.png',
      mimeType: 'image/png',
      size: 64,
      target: {
        kind: 'local',
        scope: 'openclaw-media',
        ref: { sessionKey: 'agent:pi:s1', generation: 3, uri: imagePath },
      },
    });
    await vi.waitFor(() => expect(hostApiMock.recordAcpTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'image-generation:projection-dropped',
        details: expect.objectContaining({ reason: 'stale-resolution' }),
      }),
    ));

    const images = Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
      .flatMap((item) => item.kind === 'message-segment' ? item.parts : [])
      .filter((part) => part.kind === 'image');
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      source: 'data:image/png;base64,deferred-navigation',
      mediaIdentity: 'deferred-navigation-image',
      attachmentFileRef: {
        sessionKey: 'agent:pi:s1',
        generation: 5,
        uri: imagePath,
      },
    });
    expect(hostApiMock.resolveAttachment).toHaveBeenNthCalledWith(1, {
      ref: { sessionKey: 'agent:pi:s1', generation: 3, uri: imagePath },
      mimeType: 'image/png',
    });
    expect(hostApiMock.resolveAttachment).toHaveBeenNthCalledWith(2, {
      ref: { sessionKey: 'agent:pi:s1', generation: 5, uri: imagePath },
      mimeType: 'image/png',
    });
  });

  it('merges a restored historical image into the authoritative replay reply without duplicating text', async () => {
    const initialReplay = [
      {
        sessionKey: 'agent:pi:s1',
        generation: 1,
        historical: true,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'user_message',
            messageId: 'history-user',
            content: [{ type: 'text', text: 'Generate an image' }],
          },
        },
      },
      {
        sessionKey: 'agent:pi:s1',
        generation: 1,
        historical: true,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'history-image-tool',
            title: 'Generate image',
            status: 'completed',
            content: [],
            locations: [],
          },
        },
      },
      {
        sessionKey: 'agent:pi:s1',
        generation: 1,
        historical: true,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'agent_message',
            messageId: 'old-caption-reply',
            content: [{ type: 'text', text: 'Generated image is ready.' }],
          },
        },
      },
    ];
    hostApiMock.loadAcpSession
      .mockResolvedValueOnce({ success: true, generation: 1, sessionUpdates: initialReplay })
      .mockResolvedValueOnce({ success: true, generation: 2, sessionUpdates: [] })
      .mockResolvedValueOnce({
        success: true,
        generation: 3,
        resumedActivePrompt: false,
        sessionUpdates: initialReplay.map((event, index) => ({
          ...event,
          generation: 3,
          ...(index === 2
            ? {
              notification: {
                sessionId: 'agent:pi:s1',
                update: {
                  sessionUpdate: 'agent_message',
                  messageId: 'replayed-caption-reply',
                  content: [{ type: 'text', text: 'Generated image is ready.' }],
                },
              },
            }
            : {}),
        })),
      });
    const { useAcpChatSessionStore } = await importStore();

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
    });
    useAcpChatSessionStore.setState((state) => {
      const reply = state.timeline.itemsById['old-caption-reply:0'];
      if (reply?.kind !== 'message-segment') throw new Error('Expected the historical reply');
      return {
        pendingImageGenerationTaskIds: ['pending-image-task'],
        timeline: {
          ...state.timeline,
          itemsById: {
            ...state.timeline.itemsById,
            [reply.id]: {
              ...reply,
              compat: { source: 'image-generation', evidenceId: 'native-image-evidence' },
              parts: [
                ...reply.parts,
                {
                  kind: 'image',
                  source: 'data:image/png;base64,native-history',
                  mediaIdentity: 'native-history-image',
                  attachmentFileRef: {
                    sessionKey: 'agent:pi:s1',
                    generation: 1,
                    uri: 'file:///repo/native-history.png',
                  },
                },
              ],
            },
          },
        },
      };
    });

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s2', workspaceRoot: '/repo-2', cwd: '/repo-2', createIfMissing: true,
    });
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
    });

    const timeline = useAcpChatSessionStore.getState().timeline;
    const replies = timeline.itemOrder
      .map((itemId) => timeline.itemsById[itemId])
      .filter((item): item is Extract<typeof item, { kind: 'message-segment' }> => (
        item?.kind === 'message-segment' && item.role === 'assistant'
      ));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      id: 'replayed-caption-reply:0',
      compat: { source: 'image-generation', evidenceId: 'native-image-evidence' },
      parts: [
        { kind: 'markdown', text: 'Generated image is ready.' },
        {
          kind: 'image',
          mediaIdentity: 'native-history-image',
          attachmentFileRef: { sessionKey: 'agent:pi:s1', generation: 3 },
        },
      ],
    });
    expect(timeline.itemsById['old-caption-reply:0']).toBeUndefined();
  });

  it('falls back to ACP replay when a prompt settles during live-session reactivation', async () => {
    const prompt = createDeferred<{ success: boolean; generation: number }>();
    const resume = createDeferred<{ success: boolean; generation: number; resumedActivePrompt: boolean }>();
    hostApiMock.loadAcpSession
      .mockResolvedValueOnce({ success: true, generation: 1 })
      .mockResolvedValueOnce({ success: true, generation: 2 })
      .mockReturnValueOnce(resume.promise)
      .mockResolvedValueOnce({
        success: true,
        generation: 3,
        sessionUpdates: [{
          sessionKey: 'agent:pi:s1',
          generation: 3,
          historical: true,
          notification: {
            sessionId: 'agent:pi:s1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'msg-assistant',
              content: { type: 'text', text: 'complete replay' },
            },
          },
        }],
      });
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
    const { useAcpChatSessionStore } = await importStore();

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });
    const sendPrompt = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'finish while returning', messageId: 'msg-user',
    });
    await vi.waitFor(() => expect(hostApiMock.sendAcpPrompt).toHaveBeenCalledTimes(1));
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s2', workspaceRoot: '/repo', cwd: '/repo',
    });
    const returnToLiveSession = useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });
    await vi.waitFor(() => expect(hostApiMock.loadAcpSession).toHaveBeenCalledTimes(3));

    prompt.resolve({ success: true, generation: 1 });
    await sendPrompt;
    resume.resolve({ success: true, generation: 1, resumedActivePrompt: true });

    await expect(returnToLiveSession).resolves.toBe(true);
    expect(hostApiMock.loadAcpSession).toHaveBeenCalledTimes(4);
    expect(useAcpChatSessionStore.getState()).toMatchObject({
      activeSessionKey: 'agent:pi:s1',
      generation: 3,
      sending: false,
    });
    expect(useAcpChatSessionStore.getState().timeline.itemsById['msg-assistant:0']).toMatchObject({
      parts: [{ kind: 'markdown', text: 'complete replay' }],
    });
  });

  it('keeps a resolved permission non-actionable when its live session is restored', async () => {
    const prompt = createDeferred<{ success: boolean; generation: number }>();
    const permission = createDeferred<{ success: boolean; generation: number }>();
    hostApiMock.loadAcpSession
      .mockResolvedValueOnce({ success: true, generation: 1 })
      .mockResolvedValueOnce({ success: true, generation: 2 })
      .mockResolvedValueOnce({ success: true, generation: 1, resumedActivePrompt: true });
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
    hostApiMock.respondAcpPermission.mockReturnValueOnce(permission.promise);
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });
    const sendPrompt = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'edit', messageId: 'msg-user',
    });
    await vi.waitFor(() => expect(hostApiMock.sendAcpPrompt).toHaveBeenCalledTimes(1));
    hostEventsMock.permissionListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      requestId: 'permission-1',
      request: {
        sessionId: 'agent:pi:s1',
        toolCall: { toolCallId: 'tool-1', title: 'Edit file', status: 'pending' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      },
    });
    const respond = useAcpChatSessionStore.getState().respondPermission('permission-1', 'allow-once');
    await vi.waitFor(() => expect(hostApiMock.respondAcpPermission).toHaveBeenCalledTimes(1));

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s2', workspaceRoot: '/repo', cwd: '/repo',
    });
    permission.resolve({ success: true, generation: 1 });
    await respond;
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });

    expect(useAcpChatSessionStore.getState().timeline.itemsById['permission:permission-1']).toMatchObject({
      kind: 'permission',
      status: 'selected',
    });

    prompt.resolve({ success: true, generation: 1 });
    await sendPrompt;
  });

  it('resolves every new pending attachment and patches the matching ids', async () => {
    hostApiMock.resolveAttachment.mockImplementation(async (payload: { ref: { uri: string } }) => ({
      ok: true,
      identity: `identity:${payload.ref.uri}`,
      displayName: payload.ref.uri.endsWith('one.txt') ? 'one.txt' : 'two.txt',
      mimeType: 'text/plain',
      size: payload.ref.uri.endsWith('one.txt') ? 1 : 2,
      target: { kind: 'local', scope: 'workspace', ref: payload.ref },
    }));
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message',
          messageId: 'msg-files',
          content: [
            { type: 'resource_link', uri: 'file:///repo/one.txt', name: 'one.txt', mimeType: 'text/plain', size: 1 },
            { type: 'resource_link', uri: 'file:///repo/two.txt', name: 'two.txt', mimeType: 'text/plain', size: 2 },
          ],
        },
      },
    });

    await vi.waitFor(() => expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(2));
    expect(hostApiMock.resolveAttachment).toHaveBeenNthCalledWith(1, {
      ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: 'file:///repo/one.txt' },
      name: 'one.txt',
      mimeType: 'text/plain',
      size: 1,
    });
    expect(hostApiMock.resolveAttachment).toHaveBeenNthCalledWith(2, {
      ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: 'file:///repo/two.txt' },
      name: 'two.txt',
      mimeType: 'text/plain',
      size: 2,
    });
    await vi.waitFor(() => {
      const item = useAcpChatSessionStore.getState().timeline.itemsById['msg-files:0'];
      expect(item).toMatchObject({
        parts: [
          { attachmentId: 'attachment:msg-files:0:0', access: { status: 'available', identity: 'identity:file:///repo/one.txt' } },
          { attachmentId: 'attachment:msg-files:0:1', access: { status: 'available', identity: 'identity:file:///repo/two.txt' } },
        ],
      });
    });
  });

  it('drops an old deferred resolution when the same attachment position receives a new reference', async () => {
    const resolutionA = createDeferred<Record<string, unknown>>();
    const resolutionB = createDeferred<Record<string, unknown>>();
    hostApiMock.resolveAttachment
      .mockReturnValueOnce(resolutionA.promise)
      .mockReturnValueOnce(resolutionB.promise);
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });
    const envelopeFor = (fileName: string) => ({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message',
          messageId: 'msg-file',
          content: [{
            type: 'resource_link',
            uri: `file:///repo/${fileName}`,
            name: fileName,
            mimeType: 'text/plain',
          }],
        },
      },
    });

    hostEventsMock.updateListener?.(envelopeFor('a.txt'));
    await vi.waitFor(() => expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(1));
    hostEventsMock.updateListener?.(envelopeFor('b.txt'));
    await vi.waitFor(() => expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(2));

    resolutionB.resolve({
      ok: true,
      identity: 'identity-b',
      displayName: 'b.txt',
      mimeType: 'text/plain',
      size: 2,
      target: {
        kind: 'local',
        scope: 'workspace',
        ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: 'file:///repo/b.txt' },
      },
    });
    await vi.waitFor(() => {
      expect(useAcpChatSessionStore.getState().timeline.itemsById['msg-file:0']).toMatchObject({
        parts: [{
          attachmentId: 'attachment:msg-file:0:0',
          reference: { uri: 'file:///repo/b.txt', name: 'b.txt' },
          access: {
            status: 'available',
            identity: 'identity-b',
            target: { ref: { uri: 'file:///repo/b.txt' } },
          },
        }],
      });
    });

    resolutionA.resolve({
      ok: true,
      identity: 'identity-a',
      displayName: 'a.txt',
      mimeType: 'text/plain',
      size: 1,
      target: {
        kind: 'local',
        scope: 'workspace',
        ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: 'file:///repo/a.txt' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useAcpChatSessionStore.getState().timeline.itemsById['msg-file:0']).toMatchObject({
      parts: [{
        reference: { uri: 'file:///repo/b.txt', name: 'b.txt' },
        access: {
          status: 'available',
          identity: 'identity-b',
          target: { ref: { uri: 'file:///repo/b.txt' } },
        },
      }],
    });
  });

  it('drops attachment resolution after the active session and generation change', async () => {
    const resolution = createDeferred<Record<string, unknown>>();
    hostApiMock.resolveAttachment.mockReturnValueOnce(resolution.promise);
    hostApiMock.loadAcpSession
      .mockReset()
      .mockResolvedValueOnce({ success: true, generation: 1 })
      .mockResolvedValueOnce({ success: true, generation: 2 });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo-a', cwd: '/repo-a',
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-file',
          content: { type: 'resource_link', uri: 'file:///repo-a/report.txt', name: 'report.txt' },
        },
      },
    });
    await vi.waitFor(() => expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(1));

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s2', workspaceRoot: '/repo-b', cwd: '/repo-b',
    });
    resolution.resolve({
      ok: true,
      identity: 'stale-identity',
      displayName: 'report.txt',
      mimeType: 'text/plain',
      size: 42,
      target: {
        kind: 'local',
        scope: 'workspace',
        ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: 'file:///repo-a/report.txt' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useAcpChatSessionStore.getState().timeline).toMatchObject({
      sessionId: 'agent:pi:s2',
      loadGeneration: 2,
      itemOrder: [],
    });
  });

  it('keeps unavailable attachments renderable and retries a later pending replacement', async () => {
    hostApiMock.resolveAttachment
      .mockResolvedValueOnce({ ok: false, displayName: 'report.txt', error: 'unavailable' })
      .mockResolvedValueOnce({
        ok: true,
        identity: 'report-identity',
        displayName: 'report.txt',
        mimeType: 'text/plain',
        size: 42,
        target: {
          kind: 'local',
          scope: 'workspace',
          ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: 'file:///repo/report.txt' },
        },
      });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });
    const envelope = {
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message',
          messageId: 'msg-file',
          content: [{ type: 'resource_link', uri: 'file:///repo/report.txt', name: 'report.txt' }],
        },
      },
    };

    hostEventsMock.updateListener?.(envelope);
    await vi.waitFor(() => {
      expect(useAcpChatSessionStore.getState().timeline.itemsById['msg-file:0']).toMatchObject({
        parts: [{ access: { status: 'unavailable', reason: 'unavailable' } }],
      });
    });

    hostEventsMock.updateListener?.(envelope);
    await vi.waitFor(() => {
      expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(2);
      expect(useAcpChatSessionStore.getState().timeline.itemsById['msg-file:0']).toMatchObject({
        parts: [{ access: { status: 'available', identity: 'report-identity' } }],
      });
    });
  });

  it('prefers native attachments and compatibility inline images by resolved identity regardless of order', () => {
    const native = availableAttachment('native', 'acp-resource', 'same-media');
    const compatibility = availableAttachment('compat', 'openclaw-media', 'same-media');
    const image: RenderPart = {
      kind: 'image',
      source: 'data:image/png;base64,abc',
      mediaIdentity: 'same-media',
    };

    expect(dedupeTurnAttachments([compatibility, native])).toEqual([native]);
    expect(dedupeTurnAttachments([native, compatibility])).toEqual([native]);
    expect(dedupeTurnAttachments([compatibility, image])).toEqual([]);
    expect(dedupeTurnAttachments([image, compatibility])).toEqual([]);
  });

  it('replaces an earlier compatibility attachment when a native attachment resolves to the same identity', async () => {
    hostApiMock.resolveAttachment.mockResolvedValueOnce({
      ok: true,
      identity: 'same-media',
      displayName: 'native.txt',
      mimeType: 'text/plain',
      size: 42,
      target: {
        kind: 'local',
        scope: 'workspace',
        ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: 'file:///repo/native.txt' },
      },
    });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });
    useAcpChatSessionStore.setState((state) => ({
      timeline: {
        ...state.timeline,
        itemOrder: ['compat:0'],
        itemsById: {
          'compat:0': {
            kind: 'message-segment',
            id: 'compat:0',
            role: 'assistant',
            messageId: 'compat',
            segmentIndex: 0,
            parts: [availableAttachment('compat', 'openclaw-media', 'same-media')],
          },
        },
      },
    }));

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'native',
          content: { type: 'resource_link', uri: 'file:///repo/native.txt', name: 'native.txt' },
        },
      },
    });

    await vi.waitFor(() => {
      const parts = Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
        .filter((item) => item.kind === 'message-segment')
        .flatMap((item) => item.parts)
        .filter((part) => part.kind === 'attachment');
      expect(parts).toMatchObject([{ source: 'acp-resource', access: { identity: 'same-media' } }]);
    });
  });

  it('marks replay tool updates as historical from the ACP envelope without marking live prompt updates', async () => {
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();

    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'replayed-tool',
          title: 'Read history',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'historical output' } }],
        },
      },
    });

    expect(useAcpChatSessionStore.getState().timeline.itemsById['tool:replayed-tool']).toMatchObject({
      kind: 'tool-call',
      historical: true,
    });

    const promptDeferred = createDeferred<{ success: true }>();
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(promptDeferred.promise);
    const promptPromise = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'live prompt',
      messageId: 'live-message',
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'live-tool',
          title: 'Live tool',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'live output' } }],
        },
      },
    });

    expect(useAcpChatSessionStore.getState().timeline.itemsById['tool:live-tool']).toMatchObject({
      kind: 'tool-call',
      historical: false,
    });

    promptDeferred.resolve({ success: true });
    await promptPromise;
  });

  it('ignores stale loadSession completion after a newer load', async () => {
    const staleLoad = createDeferred<{ success: boolean; error?: string; generation?: number }>();
    const currentLoad = createDeferred<{ success: boolean; error?: string; generation?: number }>();
    hostApiMock.loadAcpSession
      .mockReset()
      .mockReturnValueOnce(staleLoad.promise)
      .mockReturnValueOnce(currentLoad.promise);
    const { useAcpChatSessionStore } = await importStore();

    const staleLoadPromise = useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo-a', cwd: '/repo-a/project',
    });
    const currentLoadPromise = useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s2', workspaceRoot: '/repo-b', cwd: '/repo-b/project',
    });
    currentLoad.resolve({ success: true, generation: 2 });
    await currentLoadPromise;
    staleLoad.resolve({ success: false, error: 'stale load failed', generation: 1 });
    await staleLoadPromise;

    expect(useAcpChatSessionStore.getState()).toMatchObject({
      activeSessionKey: 'agent:pi:s2',
      workspaceRoot: '/repo-b',
      cwd: '/repo-b/project',
      generation: 2,
      loading: false,
      error: null,
    });
    expect(useAcpChatSessionStore.getState().timeline).toMatchObject({
      sessionId: 'agent:pi:s2',
      loadGeneration: 2,
      itemOrder: [],
    });
  });

  it('inserts permission requests and responds with the selected outcome', async () => {
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: 'Need permission.' },
        },
      },
    });

    hostEventsMock.permissionListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      requestId: 'perm-1',
      request: {
        sessionId: 'agent:pi:s1',
        toolCall: { toolCallId: 'tool-1', title: 'Edit file', status: 'pending' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      },
    });

    expect(useAcpChatSessionStore.getState().timeline.itemOrder).toEqual(['msg-1:0', 'permission:perm-1']);
    expect(useAcpChatSessionStore.getState().timeline.openMessageSegments).toEqual({});
    expect(useAcpChatSessionStore.getState().timeline.itemsById['permission:perm-1']).toMatchObject({
      kind: 'permission',
      requestId: 'perm-1',
      toolCallId: 'tool-1',
      title: 'Edit file',
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      status: 'pending',
    });

    await useAcpChatSessionStore.getState().respondPermission('perm-1', 'allow-once');

    expect(hostApiMock.respondAcpPermission).toHaveBeenCalledWith({
      sessionKey: 'agent:pi:s1',
      requestId: 'perm-1',
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(useAcpChatSessionStore.getState().timeline.itemsById['permission:perm-1']).toMatchObject({
      kind: 'permission',
      status: 'selected',
    });
  });

  it('sends prompts, cancels the active session, and clears errors', async () => {
    hostApiMock.sendAcpPrompt.mockResolvedValueOnce({ success: false, error: 'prompt failed' });
    const { useAcpChatSessionStore } = await importStore();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    await expect(useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'hello',
      media: [{ filePath: '/repo/image.png', stagingId: 'stage-image', fileName: 'image.png', mimeType: 'image/png' }],
    })).resolves.toBe(false);
    expect(hostApiMock.sendAcpPrompt).toHaveBeenCalledWith({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'hello',
      media: [{ filePath: '/repo/image.png', stagingId: 'stage-image', fileName: 'image.png', mimeType: 'image/png' }],
      messageId: expect.any(String),
    });
    expect(useAcpChatSessionStore.getState()).toMatchObject({
      sending: false,
      error: 'prompt failed',
    });
    expect(useAcpChatSessionStore.getState().timeline.itemOrder).toEqual([]);
    expect(useAcpChatSessionStore.getState().turnTimingsByUserMessageId).toEqual({});

    useAcpChatSessionStore.getState().clearError();
    expect(useAcpChatSessionStore.getState().error).toBeNull();

    await useAcpChatSessionStore.getState().cancel();
    expect(hostApiMock.cancelAcpSession).toHaveBeenCalledWith({ sessionKey: 'agent:pi:s1' });
    expect(useAcpChatSessionStore.getState().cancelling).toBe(false);
  });

  it('adds an optimistic user segment immediately before ACP echoes a user update', async () => {
    const prompt = createDeferred<{ success: boolean; error?: string; generation?: number }>();
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
    const { useAcpChatSessionStore } = await importStore();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    const sendPromise = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'hello from user',
      media: [{ filePath: '/repo/notes.txt', stagingId: 'stage-notes', fileName: 'notes.txt', mimeType: 'text/plain' }],
    });

    const state = useAcpChatSessionStore.getState();
    expect(state.timeline.itemOrder).toHaveLength(1);
    const itemId = state.timeline.itemOrder[0];
    const item = state.timeline.itemsById[itemId];
    expect(item).toMatchObject({
      kind: 'message-segment',
      role: 'user',
      segmentIndex: 0,
      userPromptTextBlocks: ['hello from user', '[Resource link] /repo/notes.txt'],
      parts: [
        { kind: 'markdown', text: 'hello from user' },
        {
          kind: 'attachment',
          attachmentId: expect.stringMatching(/^attachment:/),
          reference: {
            uri: '/repo/notes.txt',
            name: 'notes.txt',
            mimeType: 'text/plain',
            stagingId: 'stage-notes',
          },
          source: 'acp-resource',
          access: { status: 'pending' },
        },
      ],
    });
    expect(hostApiMock.sendAcpPrompt).toHaveBeenCalledWith({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'hello from user',
      media: [{ filePath: '/repo/notes.txt', stagingId: 'stage-notes', fileName: 'notes.txt', mimeType: 'text/plain' }],
      messageId: expect.any(String),
    });

    prompt.resolve({ success: true });
    await expect(sendPromise).resolves.toBe(true);
  });

  it('does not resolve an optimistic user attachment again when ACP echoes the same resource', async () => {
    const prompt = createDeferred<{ success: boolean; error?: string; generation?: number }>();
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
    hostApiMock.resolveAttachment.mockResolvedValueOnce({
      ok: true,
      identity: 'staged-notes',
      displayName: 'notes.txt',
      mimeType: 'text/plain',
      size: 12,
      target: {
        kind: 'local',
        scope: 'staging',
        ref: {
          sessionKey: 'agent:pi:s1',
          generation: 1,
          uri: '/repo/notes.txt',
          stagingId: 'stage-notes',
        },
      },
    });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });

    const sendPromise = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'inspect this',
      messageId: 'user-msg',
      media: [{
        filePath: '/repo/notes.txt',
        stagingId: 'stage-notes',
        fileName: 'notes.txt',
        mimeType: 'text/plain',
      }],
    });
    await vi.waitFor(() => {
      expect(useAcpChatSessionStore.getState().timeline.itemsById['user-msg:0']).toMatchObject({
        parts: [
          { kind: 'markdown' },
          { kind: 'attachment', access: { status: 'available', identity: 'staged-notes' } },
        ],
      });
    });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'user_message',
          messageId: 'user-msg',
          content: [
            { type: 'text', text: 'inspect this' },
            {
              type: 'resource_link',
              uri: '/repo/notes.txt',
              name: 'notes.txt',
              mimeType: 'text/plain',
              _meta: { clawx: { stagingId: 'stage-notes' } },
            },
          ],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(1);
    expect(useAcpChatSessionStore.getState().timeline.itemsById['user-msg:0']).toMatchObject({
      parts: [
        { kind: 'markdown' },
        { kind: 'attachment', access: { status: 'available', identity: 'staged-notes' } },
      ],
    });

    prompt.resolve({ success: true });
    await sendPromise;
  });

  it('keeps a reconciled user segment when prompt completion fails after ACP echo', async () => {
    const prompt = createDeferred<{ success: boolean; error?: string; generation?: number }>();
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    const sendPromise = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'hello from user',
    });
    const sentPayload = hostApiMock.sendAcpPrompt.mock.calls[0]?.[0] as { messageId: string };

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'user_message_chunk',
          messageId: sentPayload.messageId,
          content: { type: 'text', text: 'hello from user' },
        },
      },
    });
    prompt.resolve({ success: false, error: 'prompt failed after echo' });
    await expect(sendPromise).resolves.toBe(false);

    expect(useAcpChatSessionStore.getState().timeline.itemOrder).toHaveLength(1);
    expect(useAcpChatSessionStore.getState().timeline.itemsById[`${sentPayload.messageId}:0`]).toMatchObject({
      kind: 'message-segment',
      role: 'user',
      optimistic: false,
      parts: [{ kind: 'markdown', text: 'hello from user' }],
    });
  });

  it('reconciles only the current failed assistant segment from its transcript turn', async () => {
    const prompt = createDeferred<{ success: boolean; error?: string; generation?: number }>();
    const userText = '画一张西瓜吃席瓜的图';
    const persistedPartial = '我按“西瓜在宴席上吃西瓜”的谐音梗来画';
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
    hostApiMock.sessionsHistory.mockResolvedValueOnce({
      success: true,
      messages: [
        { role: 'user', id: 'transcript-user', content: userText },
        {
          role: 'assistant',
          id: 'failed-assistant-transcript',
          content: [{ type: 'text', text: persistedPartial }],
          stopReason: 'error',
          errorMessage: 'stream_read_error',
        },
      ],
    });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
    });

    const sendPromise = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1', cwd: '/repo', message: userText, messageId: 'failed-user-live',
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'user_message',
          messageId: 'failed-user-live',
          content: [{ type: 'text', text: userText }],
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'failed-assistant-live',
          content: { type: 'text', text: '我' },
        },
      },
    });
    prompt.resolve({ success: false, error: 'stream_read_error' });

    await expect(sendPromise).resolves.toBe(false);
    await vi.waitFor(() => expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(1));
    const timeline = useAcpChatSessionStore.getState().timeline;
    const assistantItems = timeline.itemOrder
      .map((id) => timeline.itemsById[id])
      .filter((item) => item?.kind === 'message-segment' && item.role === 'assistant');
    expect(assistantItems).toHaveLength(1);
    expect(assistantItems[0]).toMatchObject({
      messageId: 'failed-assistant-live',
      parts: [{ kind: 'markdown', text: persistedPartial }],
    });
    expect(hostApiMock.loadAcpSession).toHaveBeenCalledTimes(1);
  });

  it('does not respond to missing or already-resolved permission requests', async () => {
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    await useAcpChatSessionStore.getState().respondPermission('missing', 'allow-once');

    expect(hostApiMock.respondAcpPermission).not.toHaveBeenCalled();
    expect(useAcpChatSessionStore.getState().error).toBeNull();

    hostEventsMock.permissionListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      requestId: 'perm-1',
      request: {
        sessionId: 'agent:pi:s1',
        toolCall: { toolCallId: 'tool-1', title: 'Edit file', status: 'pending' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      },
    });
    await useAcpChatSessionStore.getState().respondPermission('perm-1', 'allow-once');
    hostApiMock.respondAcpPermission.mockClear();

    await useAcpChatSessionStore.getState().respondPermission('perm-1', 'allow-once');

    expect(hostApiMock.respondAcpPermission).not.toHaveBeenCalled();
    expect(useAcpChatSessionStore.getState().error).toBeNull();
  });

  it('ignores stale sendPrompt completion after switching sessions', async () => {
    const prompt = createDeferred<{ success: boolean; error?: string; generation?: number }>();
    hostApiMock.loadAcpSession
      .mockReset()
      .mockResolvedValueOnce({ success: true, generation: 1 })
      .mockResolvedValueOnce({ success: true, generation: 2 });
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
    const { useAcpChatSessionStore } = await importStore();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo-a', cwd: '/repo-a' });

    const promptPromise = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo-a',
      message: 'hello',
    });
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s2', workspaceRoot: '/repo-b', cwd: '/repo-b' });
    prompt.resolve({ success: false, error: 'stale prompt failed', generation: 1 });
    await promptPromise;

    expect(useAcpChatSessionStore.getState()).toMatchObject({
      activeSessionKey: 'agent:pi:s2',
      generation: 2,
      sending: false,
      error: null,
    });
  });

  it('returns false and does not prompt when the session is not active', async () => {
    const { useAcpChatSessionStore } = await importStore();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo-a', cwd: '/repo-a' });

    await expect(useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s2',
      cwd: '/repo-b',
      message: 'wrong session',
    })).resolves.toBe(false);

    expect(hostApiMock.sendAcpPrompt).not.toHaveBeenCalled();
    expect(useAcpChatSessionStore.getState().error).toBeNull();
  });

  it('ignores stale cancel completion after switching sessions', async () => {
    const cancel = createDeferred<{ success: boolean; error?: string; generation?: number }>();
    hostApiMock.loadAcpSession
      .mockReset()
      .mockResolvedValueOnce({ success: true, generation: 1 })
      .mockResolvedValueOnce({ success: true, generation: 2 });
    hostApiMock.cancelAcpSession.mockReturnValueOnce(cancel.promise);
    const { useAcpChatSessionStore } = await importStore();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo-a', cwd: '/repo-a' });

    const cancelPromise = useAcpChatSessionStore.getState().cancel();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s2', workspaceRoot: '/repo-b', cwd: '/repo-b' });
    cancel.resolve({ success: false, error: 'stale cancel failed', generation: 1 });
    await cancelPromise;

    expect(useAcpChatSessionStore.getState()).toMatchObject({
      activeSessionKey: 'agent:pi:s2',
      generation: 2,
      cancelling: false,
      error: null,
    });
  });

  it('ignores stale respondPermission completion after switching sessions', async () => {
    const permissionResponse = createDeferred<{ success: boolean; error?: string; generation?: number }>();
    hostApiMock.loadAcpSession
      .mockReset()
      .mockResolvedValueOnce({ success: true, generation: 1 })
      .mockResolvedValueOnce({ success: true, generation: 2 });
    hostApiMock.respondAcpPermission.mockReturnValueOnce(permissionResponse.promise);
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo-a', cwd: '/repo-a' });
    hostEventsMock.permissionListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      requestId: 'perm-1',
      request: {
        sessionId: 'agent:pi:s1',
        toolCall: { toolCallId: 'tool-1', title: 'Edit file', status: 'pending' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      },
    });

    const responsePromise = useAcpChatSessionStore.getState().respondPermission('perm-1', 'allow-once');
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s2', workspaceRoot: '/repo-b', cwd: '/repo-b' });
    permissionResponse.resolve({ success: false, error: 'stale permission failed', generation: 1 });
    await responsePromise;

    expect(useAcpChatSessionStore.getState()).toMatchObject({
      activeSessionKey: 'agent:pi:s2',
      generation: 2,
      error: null,
    });
    expect(useAcpChatSessionStore.getState().timeline.itemOrder).toEqual([]);
  });

  it('sets an error and clears loading when session load fails', async () => {
    hostApiMock.loadAcpSession.mockResolvedValueOnce({ success: false, error: 'load failed' });
    const { useAcpChatSessionStore } = await importStore();

    const loaded = await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo/project',
    });

    expect(loaded).toBe(false);
    expect(useAcpChatSessionStore.getState()).toMatchObject({
      activeSessionKey: null,
      workspaceRoot: null,
      cwd: null,
      loading: false,
      error: 'load failed',
    });
  });

  it('projects trusted image-generation Gateway media into the ACP timeline', async () => {
    hostApiMock.loadAcpSession
      .mockResolvedValueOnce({ success: true, generation: 1 })
      .mockResolvedValueOnce({ success: true, generation: 2 })
      .mockResolvedValueOnce({ success: true, generation: 3 });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: 'Background task started for image generation (32aa3a12-a05b-4074-af4e-246cc4a9a303).',
            },
          }],
        },
      },
    });
    expect(useAcpChatSessionStore.getState().pendingImageGenerationTaskIds).toEqual([
      '32aa3a12-a05b-4074-af4e-246cc4a9a303',
    ]);
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s2',
      workspaceRoot: '/repo-2',
      cwd: '/repo-2',
    });
    expect(useAcpChatSessionStore.getState().pendingImageGenerationTaskIds).toEqual([]);
    hostApiMock.mediaThumbnails.mockResolvedValueOnce({
      '/tmp/sky.png': { preview: 'data:image/png;base64,abc123', fileSize: 67 },
    });

    hostEventsMock.gatewayChatMessageListener?.({
      message: {
        sessionKey: 'agent:pi:s1',
        runId: 'image_generate:32aa3a12-a05b-4074-af4e-246cc4a9a303:ok',
        message: {
          role: 'toolresult',
          toolName: 'message',
          details: { mediaUrls: ['/tmp/sky.png'] },
        },
      },
    });
    expect(hostApiMock.mediaThumbnails).not.toHaveBeenCalled();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1',
      workspaceRoot: '/repo',
      cwd: '/repo',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hostApiMock.mediaThumbnails).toHaveBeenCalledWith({
      paths: [{
        attachmentFileRef: expect.objectContaining({ uri: '/tmp/sky.png' }),
        key: '/tmp/sky.png',
        mimeType: 'image/png',
      }],
    });
    const timeline = useAcpChatSessionStore.getState().timeline;
    const syntheticId = timeline.itemOrder.find((id) => id.startsWith('compat:image-generation:'));
    expect(syntheticId).toBeTruthy();
    expect(timeline.itemsById[syntheticId!]).toMatchObject({
      kind: 'message-segment',
      role: 'assistant',
      compat: { source: 'image-generation' },
      parts: [
        { kind: 'markdown', text: 'Generated image is ready.' },
        { kind: 'image', source: 'data:image/png;base64,abc123', mimeType: 'image/png', alt: 'Image' },
      ],
    });
    expect(useAcpChatSessionStore.getState().pendingImageGenerationTaskIds).toEqual([]);
  });

  it('records image-generation start detection trace entries', async () => {
    const taskId = '0d2ee919-2dfd-4b72-9da3-d87e6ee56747';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });

    expect(hostApiMock.recordAcpTrace).toHaveBeenCalledWith(expect.objectContaining({
      event: 'image-generation:start-detected',
      direction: 'projection',
      sessionKey: 'agent:pi:s1',
      generation: 1,
      details: expect.objectContaining({ taskId }),
    }));
  });

  it('keeps video generation pending until the detached completion run terminates', async () => {
    const taskId = '27c3d85f-0d5e-4bf5-b5d3-c8316db9ddde';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1',
      workspaceRoot: '/repo',
      cwd: '/repo',
    });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'video-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for video generation (${taskId}).`,
            },
          }],
        },
      },
    });
    expect(useAcpChatSessionStore.getState().pendingVideoGenerationTaskIds).toEqual([taskId]);

    hostEventsMock.runtimeEventListener?.({
      type: 'run.started',
      runId: `video_generate:${taskId}:completion`,
      sessionKey: `video_generate:${taskId}`,
    });
    expect(useAcpChatSessionStore.getState().pendingVideoGenerationTaskIds).toEqual([taskId]);

    hostEventsMock.runtimeEventListener?.({
      type: 'run.ended',
      status: 'completed',
      runId: `video_generate:${taskId}:completion`,
      sessionKey: `video_generate:${taskId}`,
    });
    expect(useAcpChatSessionStore.getState().pendingVideoGenerationTaskIds).toEqual([]);
  });

  it('releases the video lock and displays an error for an immediate internal failure', async () => {
    const taskId = '56db7fb4-8809-46e9-8ad4-d7724918f295';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1',
      workspaceRoot: '/repo',
      cwd: '/repo',
    });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'video-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for video generation (${taskId}).`,
            },
          }],
        },
      },
    });
    expect(useAcpChatSessionStore.getState().pendingVideoGenerationTaskIds).toEqual([taskId]);

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'text',
            text: [
              '[Internal task completion event]',
              'source: video_generation',
              `session_key: video_generate:${taskId}`,
              'status: failed',
            ].join('\n'),
          },
        },
      },
    });

    const state = useAcpChatSessionStore.getState();
    expect(state.pendingVideoGenerationTaskIds).toEqual([]);
    expect(state.timeline.itemOrder.some((itemId) => {
      const item = state.timeline.itemsById[itemId];
      return item?.kind === 'message-segment'
        && item.role === 'assistant'
        && item.compat?.source === 'video-generation'
        && item.parts.some((part) => part.kind === 'error');
    })).toBe(true);
  });

  it('projects one local video when completion arrives after the initial live transcript window', async () => {
    vi.useFakeTimers();
    try {
      const taskId = 'c5c772d1-54b2-45b7-a6b4-22f9ed900806';
      const videoPath = '/Users/test/.openclaw/media/tool-video-generation/finished-video.mp4';
      let historyReadCount = 0;
      hostApiMock.sessionsHistory.mockImplementation(async () => {
        historyReadCount += 1;
        return {
          success: true,
          messages: historyReadCount < 4
            ? [{ role: 'user', id: 'transcript-user', content: 'Create a short video' }]
            : [
                { role: 'user', id: 'transcript-user', content: 'Create a short video' },
                { role: 'assistant', id: 'video-result', content: `Video ready\nMEDIA:${videoPath}` },
              ],
        };
      });
      hostApiMock.resolveAttachment.mockImplementation(async (payload: {
        ref: { sessionKey: string; generation: number; uri: string; transcriptMessageId?: string };
      }) => ({
        ok: true,
        identity: 'local-video-identity',
        displayName: 'finished-video.mp4',
        mimeType: 'video/mp4',
        size: 4_096,
        target: { kind: 'local', scope: 'openclaw-media', ref: payload.ref },
      }));
      hostApiMock.sendAcpPrompt.mockImplementationOnce(async () => {
        hostEventsMock.updateListener?.({
          sessionKey: 'agent:pi:s1',
          generation: 1,
          notification: {
            sessionId: 'agent:pi:s1',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'video-tool',
              status: 'completed',
              content: [{
                type: 'content',
                content: {
                  type: 'text',
                  text: `Background task started for video generation (${taskId}).`,
                },
              }],
            },
          },
        });
        return { success: true };
      });

      const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
      ensureAcpChatSubscriptions();
      await useAcpChatSessionStore.getState().loadSession({
        sessionKey: 'agent:pi:s1',
        workspaceRoot: '/repo',
        cwd: '/repo',
        createIfMissing: true,
      });
      await useAcpChatSessionStore.getState().sendPrompt({
        sessionKey: 'agent:pi:s1',
        cwd: '/repo',
        message: 'Create a short video',
        messageId: 'live-video-user',
      });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(2);
      hostEventsMock.runtimeEventListener?.({
        type: 'run.ended',
        status: 'completed',
        runId: 'video_generate:29cc008c-778c-4357-92ca-8e80bbfd8cdc:completion',
        sessionKey: 'video_generate:29cc008c-778c-4357-92ca-8e80bbfd8cdc',
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(2);
      expect(useAcpChatSessionStore.getState().pendingVideoGenerationTaskIds).toEqual([taskId]);

      hostEventsMock.runtimeEventListener?.({
        type: 'run.ended',
        status: 'completed',
        runId: `video_generate:${taskId}:completion`,
        sessionKey: `video_generate:${taskId}`,
      });
      await vi.advanceTimersByTimeAsync(20_000);

      const videoAttachments = Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
        .flatMap((item) => item.kind === 'message-segment' ? item.parts : [])
        .filter((part) => part.kind === 'attachment' && part.access.status === 'available'
          && part.access.mimeType === 'video/mp4');
      expect(videoAttachments).toHaveLength(1);
      expect(videoAttachments[0]).toMatchObject({
        source: 'openclaw-media',
        reference: { uri: videoPath, transcriptMessageId: 'video-result' },
        access: {
          identity: 'local-video-identity',
          target: { kind: 'local', scope: 'openclaw-media' },
        },
      });
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(4);
      expect(useAcpChatSessionStore.getState().pendingVideoGenerationTaskIds).toEqual([]);

      hostEventsMock.runtimeEventListener?.({
        type: 'run.ended',
        status: 'completed',
        runId: `video_generate:${taskId}:completion`,
        sessionKey: `video_generate:${taskId}`,
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers an early video terminal event until the live transcript operation starts', async () => {
    vi.useFakeTimers();
    try {
      const taskId = '7104ce7d-6d5c-4b86-96b4-acf14329214d';
      const videoPath = '/Users/test/.openclaw/media/tool-video-generation/early-video.mp4';
      const prompt = createDeferred<{ success: true }>();
      hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
      hostApiMock.sessionsHistory.mockResolvedValue({
        success: true,
        messages: [
          { role: 'user', content: 'Create an early video' },
          { role: 'assistant', id: 'early-video-result', content: `MEDIA:${videoPath}` },
        ],
      });
      hostApiMock.resolveAttachment.mockImplementation(async (payload: {
        ref: { sessionKey: string; generation: number; uri: string; transcriptMessageId?: string };
      }) => ({
        ok: true,
        identity: 'early-local-video',
        displayName: 'early-video.mp4',
        mimeType: 'video/mp4',
        size: 2_048,
        target: { kind: 'local', scope: 'openclaw-media', ref: payload.ref },
      }));

      const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
      ensureAcpChatSubscriptions();
      await useAcpChatSessionStore.getState().loadSession({
        sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
      });
      const send = useAcpChatSessionStore.getState().sendPrompt({
        sessionKey: 'agent:pi:s1',
        cwd: '/repo',
        message: 'Create an early video',
        messageId: 'early-video-user',
      });
      await vi.advanceTimersByTimeAsync(0);
      hostEventsMock.updateListener?.({
        sessionKey: 'agent:pi:s1',
        generation: 1,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'video-tool',
            status: 'completed',
            content: [{
              type: 'content',
              content: {
                type: 'text',
                text: `Background task started for video generation (${taskId}).`,
              },
            }],
          },
        },
      });
      hostEventsMock.runtimeEventListener?.({
        type: 'run.ended',
        status: 'completed',
        runId: `video_generate:${taskId}:completion`,
        sessionKey: `video_generate:${taskId}`,
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(hostApiMock.sessionsHistory).not.toHaveBeenCalled();

      prompt.resolve({ success: true });
      await send;
      await vi.advanceTimersByTimeAsync(0);

      const videoAttachments = Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
        .flatMap((item) => item.kind === 'message-segment' ? item.parts : [])
        .filter((part) => part.kind === 'attachment' && part.access.status === 'available'
          && part.access.mimeType === 'video/mp4');
      expect(videoAttachments).toHaveLength(1);
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(1);
      expect(videoAttachments[0]).toMatchObject({
        reference: { uri: videoPath, transcriptMessageId: 'early-video-result' },
        access: { identity: 'early-local-video', target: { kind: 'local' } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not project a completed video into a different active session', async () => {
    vi.useFakeTimers();
    try {
      const taskId = 'b417f652-dab7-44f4-9a3e-7630f65fb0be';
      hostApiMock.sendAcpPrompt.mockImplementationOnce(async () => {
        hostEventsMock.updateListener?.({
          sessionKey: 'agent:pi:s1',
          generation: 1,
          notification: {
            sessionId: 'agent:pi:s1',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'video-tool',
              status: 'completed',
              content: [{
                type: 'content',
                content: {
                  type: 'text',
                  text: `Background task started for video generation (${taskId}).`,
                },
              }],
            },
          },
        });
        return { success: true };
      });
      const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
      ensureAcpChatSubscriptions();
      await useAcpChatSessionStore.getState().loadSession({
        sessionKey: 'agent:pi:s1', workspaceRoot: '/repo-one', cwd: '/repo-one', createIfMissing: true,
      });
      await useAcpChatSessionStore.getState().sendPrompt({
        sessionKey: 'agent:pi:s1', cwd: '/repo-one', message: 'Create a video', messageId: 'video-user',
      });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(2);

      await useAcpChatSessionStore.getState().loadSession({
        sessionKey: 'agent:pi:s2', workspaceRoot: '/repo-two', cwd: '/repo-two', createIfMissing: true,
      });
      const historyReadCount = hostApiMock.sessionsHistory.mock.calls.length;
      hostEventsMock.runtimeEventListener?.({
        type: 'run.ended',
        status: 'completed',
        runId: `video_generate:${taskId}:completion`,
        sessionKey: `video_generate:${taskId}`,
      });
      await vi.advanceTimersByTimeAsync(20_000);

      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(historyReadCount);
      expect(useAcpChatSessionStore.getState()).toMatchObject({
        activeSessionKey: 'agent:pi:s2',
        pendingVideoGenerationTaskIds: [],
      });
      expect(Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
        .flatMap((item) => item.kind === 'message-segment' ? item.parts : [])
        .filter((part) => part.kind === 'attachment')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps video generation status scoped to its session across navigation', async () => {
    const taskId = '426c9459-766a-444b-b593-cd7d87c2830c';
    hostApiMock.loadAcpSession
      .mockResolvedValueOnce({ success: true, generation: 1 })
      .mockResolvedValueOnce({ success: true, generation: 2 })
      .mockResolvedValueOnce({ success: true, generation: 1 });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1',
      workspaceRoot: '/repo-one',
      cwd: '/repo-one',
    });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'video-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for video generation (${taskId}).`,
            },
          }],
        },
      },
    });
    expect(useAcpChatSessionStore.getState().pendingVideoGenerationTaskIds).toEqual([taskId]);

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s2',
      workspaceRoot: '/repo-two',
      cwd: '/repo-two',
    });
    expect(useAcpChatSessionStore.getState().pendingVideoGenerationTaskIds).toEqual([]);

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1',
      workspaceRoot: '/repo-one',
      cwd: '/repo-one',
    });
    expect(useAcpChatSessionStore.getState().pendingVideoGenerationTaskIds).toEqual([taskId]);

    hostEventsMock.runtimeEventListener?.({
      type: 'run.ended',
      status: 'completed',
      runId: `video_generate:${taskId}:completion`,
      sessionKey: `video_generate:${taskId}`,
    });
    expect(useAcpChatSessionStore.getState().pendingVideoGenerationTaskIds).toEqual([]);
  });

  it('releases a video generation send lock when completion delivery times out', async () => {
    vi.useFakeTimers();
    try {
      const taskId = 'b48bd8c7-8fcc-4a5b-8c2b-68b2d43ecc41';
      const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
      ensureAcpChatSubscriptions();
      useAcpChatSessionStore.getState().prepareLocalSession({
        sessionKey: 'agent:pi:s1',
        workspaceRoot: '/repo',
        cwd: '/repo',
      });

      hostEventsMock.updateListener?.({
        sessionKey: 'agent:pi:s1',
        generation: 0,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'video-tool',
            status: 'completed',
            content: [{
              type: 'content',
              content: {
                type: 'text',
                text: `Background task started for video generation (${taskId}).`,
              },
            }],
          },
        },
      });
      expect(useAcpChatSessionStore.getState().pendingVideoGenerationTaskIds).toEqual([taskId]);

      await vi.advanceTimersByTimeAsync(UCLAW_VIDEO_GENERATION_TIMEOUT_MS + 15_000);
      expect(useAcpChatSessionStore.getState().pendingVideoGenerationTaskIds).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records projection rejection when generated media lacks fresh image-generation context', async () => {
    const { useAcpChatSessionStore } = await importStore();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    await useAcpChatSessionStore.getState().projectImageGenerationCompletion({
      sessionKey: 'agent:pi:s1',
      source: 'gateway-chat-message',
      evidenceId: 'gateway:run-1:/tmp/sky.png',
      caption: 'Generated image is ready.',
      candidates: [{ key: '/tmp/sky.png', filePath: '/tmp/sky.png', mimeType: 'image/png' }],
    });

    expect(hostApiMock.recordAcpTrace).toHaveBeenCalledWith(expect.objectContaining({
      event: 'image-generation:projection-rejected',
      direction: 'projection',
      sessionKey: 'agent:pi:s1',
      generation: 1,
      details: expect.objectContaining({
        reason: 'no-fresh-context',
        source: 'gateway-chat-message',
        candidateCount: 1,
      }),
    }));
  });

  it('supplements historical ACP image-generation completions from transcript history', async () => {
    const taskId = '0d2ee919-2dfd-4b72-9da3-d87e6ee56747';
    hostApiMock.sessionsHistory.mockResolvedValueOnce({
      success: true,
      messages: [
        {
          role: 'toolresult',
          toolCallId: 'image-tool',
          toolName: 'image_generate',
          content: [{
            type: 'text',
            text: `Background task started for image generation (${taskId}).`,
          }],
          details: { taskId },
        },
        {
          role: 'assistant',
          id: 'assistant-image-ready',
          content: [{
            type: 'text',
            text: '图片生成完成！\n\nMEDIA:/tmp/replayed-sky.png',
          }],
        },
      ],
    });
    hostApiMock.mediaThumbnails.mockResolvedValueOnce({
      '/tmp/replayed-sky.png': { preview: 'data:image/png;base64,replayed', fileSize: 67 },
    });
    const { useAcpChatSessionStore } = await importStore();

    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hostApiMock.sessionsHistory).toHaveBeenCalledWith({ sessionKey: 'agent:pi:s1', limit: 1000 });
    expect(hostApiMock.mediaThumbnails).toHaveBeenCalledWith({
      paths: [{
        attachmentFileRef: expect.objectContaining({ uri: '/tmp/replayed-sky.png' }),
        key: '/tmp/replayed-sky.png',
        mimeType: 'image/png',
      }],
    });
    const timeline = useAcpChatSessionStore.getState().timeline;
    const syntheticId = timeline.itemOrder.find((id) => id.startsWith('compat:image-generation:'));
    expect(syntheticId).toBeTruthy();
    expect(timeline.itemsById[syntheticId!]).toMatchObject({
      kind: 'message-segment',
      role: 'assistant',
      compat: { source: 'image-generation' },
      parts: [
        { kind: 'markdown', text: '图片生成完成！' },
        { kind: 'image', source: 'data:image/png;base64,replayed', mimeType: 'image/png', alt: 'Image' },
      ],
    });
  });

  it('restores a text-only image failure after an OpenClaw inter-session completion trigger', async () => {
    const taskId = '0d2ee919-2dfd-4b72-9da3-d87e6ee56747';
    hostApiMock.sessionsHistory.mockResolvedValueOnce({
      success: true,
      messages: [
        { role: 'user', content: '生成一张小猫图' },
        {
          role: 'toolresult',
          toolCallId: 'image-tool',
          toolName: 'image_generate',
          content: `Background task started for image generation (${taskId}).`,
          details: { taskId },
        },
        {
          role: 'user',
          content: `[Inter-session message] sourceSession=image_generate:${taskId} sourceChannel=webchat sourceTool=image_generate isUser=false\n[Internal task completion event]\nstatus: failed`,
        },
        {
          role: 'assistant',
          id: 'kitten-failure',
          content: '抱歉，这次小猫图生成失败了：当前图像生成模型通道不可用。',
        },
      ],
    });
    const { useAcpChatSessionStore } = await importStore();

    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hostApiMock.mediaThumbnails).not.toHaveBeenCalled();
    const timeline = useAcpChatSessionStore.getState().timeline;
    const syntheticId = timeline.itemOrder.find((id) => id.startsWith('compat:image-generation:'));
    expect(syntheticId).toBeTruthy();
    expect(timeline.itemsById[syntheticId!]).toMatchObject({
      role: 'assistant',
      parts: [{
        kind: 'markdown',
        text: '抱歉，这次小猫图生成失败了：当前图像生成模型通道不可用。',
      }],
    });
  });

  it('anchors supplemented historical image-generation previews after the originating tool card', async () => {
    const taskId = '0d2ee919-2dfd-4b72-9da3-d87e6ee56747';
    const history = createDeferred<{
      success: true;
      messages: Array<Record<string, unknown>>;
    }>();
    hostApiMock.sessionsHistory.mockReturnValueOnce(history.promise);
    hostApiMock.mediaThumbnails.mockResolvedValueOnce({
      '/tmp/replayed-sky.png': { preview: 'data:image/png;base64,replayed', fileSize: 67 },
    });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();

    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'user_message',
          messageId: 'image-user',
          content: [{ type: 'text', text: 'Generate an image' }],
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'image-tool',
          title: 'image_generate',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: `Background task started for image generation (${taskId}).` } }],
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'user_message',
          messageId: 'thanks-user',
          content: [{ type: 'text', text: 'Thanks' }],
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message',
          messageId: 'welcome-assistant',
          content: [{ type: 'text', text: 'You are welcome' }],
        },
      },
    });

    history.resolve({
      success: true,
      messages: [
        {
          role: 'toolresult',
          toolCallId: 'image-tool',
          toolName: 'image_generate',
          content: `Background task started for image generation (${taskId}).`,
          details: { taskId },
        },
        {
          role: 'assistant',
          id: 'assistant-image-ready',
          content: '图片生成完成！\n\nMEDIA:/tmp/replayed-sky.png',
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = useAcpChatSessionStore.getState().timeline;
    const syntheticId = timeline.itemOrder.find((id) => id.startsWith('compat:image-generation:'));
    expect(syntheticId).toBeTruthy();
    expect(timeline.itemOrder).toEqual([
      'image-user:0',
      'tool:image-tool',
      syntheticId,
      'thanks-user:0',
      'welcome-assistant:0',
    ]);
  });

  it('uses transcript task ids to anchor image completions when transcript toolCallId is missing', async () => {
    const firstTaskId = '11111111-1111-4111-8111-111111111111';
    const secondTaskId = '22222222-2222-4222-8222-222222222222';
    const history = createDeferred<{
      success: true;
      messages: Array<Record<string, unknown>>;
    }>();
    hostApiMock.sessionsHistory.mockReturnValueOnce(history.promise);
    hostApiMock.mediaThumbnails.mockResolvedValueOnce({
      '/tmp/first-sky.png': { preview: 'data:image/png;base64,first', fileSize: 67 },
    });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();

    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    for (const [toolCallId, taskId] of [['first-image-tool', firstTaskId], ['second-image-tool', secondTaskId]] as const) {
      hostEventsMock.updateListener?.({
        sessionKey: 'agent:pi:s1',
        generation: 1,
        historical: true,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolCallId,
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: `Background task started for image generation (${taskId}).` } }],
          },
        },
      });
    }

    history.resolve({
      success: true,
      messages: [
        {
          role: 'toolresult',
          toolName: 'image_generate',
          content: `Background task started for image generation (${firstTaskId}).`,
          details: { taskId: firstTaskId },
        },
        {
          role: 'assistant',
          id: 'first-image-ready',
          content: '第一张图片完成！\n\nMEDIA:/tmp/first-sky.png',
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = useAcpChatSessionStore.getState().timeline;
    const syntheticId = timeline.itemOrder.find((id) => id.startsWith('compat:image-generation:'));
    expect(syntheticId).toBeTruthy();
    expect(timeline.itemOrder).toEqual([
      'tool:first-image-tool',
      syntheticId,
      'tool:second-image-tool',
    ]);
  });

  it('drops a pending transcript supplement when a new prompt starts before thumbnail hydration completes', async () => {
    const taskId = '0d2ee919-2dfd-4b72-9da3-d87e6ee56747';
    const thumbnail = createDeferred<Record<string, { preview: string | null; fileSize: number }>>();
    const prompt = createDeferred<{ success: true }>();
    hostApiMock.sessionsHistory.mockResolvedValueOnce({
      success: true,
      messages: [
        {
          role: 'toolresult',
          toolCallId: 'image-tool',
          toolName: 'image_generate',
          content: `Background task started for image generation (${taskId}).`,
          details: { taskId },
        },
        {
          role: 'assistant',
          id: 'assistant-image-ready',
          content: '图片生成完成！\n\nMEDIA:/tmp/replayed-sky.png',
        },
      ],
    });
    hostApiMock.mediaThumbnails.mockReturnValueOnce(thumbnail.promise);
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
    const { useAcpChatSessionStore } = await importStore();

    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hostApiMock.mediaThumbnails).toHaveBeenCalledWith({
      paths: [{
        attachmentFileRef: expect.objectContaining({ uri: '/tmp/replayed-sky.png' }),
        key: '/tmp/replayed-sky.png',
        mimeType: 'image/png',
      }],
    });

    const promptPromise = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: 'live prompt',
      messageId: 'live-user',
    });
    thumbnail.resolve({
      '/tmp/replayed-sky.png': { preview: 'data:image/png;base64,replayed', fileSize: 67 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = useAcpChatSessionStore.getState().timeline;
    expect(timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toHaveLength(0);
    expect(timeline.itemsById['live-user:0']).toMatchObject({
      kind: 'message-segment',
      role: 'user',
      parts: [{ kind: 'markdown', text: 'live prompt' }],
    });

    prompt.resolve({ success: true });
    await promptPromise;
  });

  it('does not read transcript history for freshly created ACP sessions', async () => {
    const { useAcpChatSessionStore } = await importStore();

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      createIfMissing: true,
    });

    expect(hostApiMock.sessionsHistory).not.toHaveBeenCalled();
  });

  it('projects a recorded image-generation background task completion from its task session', async () => {
    const taskId = '32aa3a12-a05b-4074-af4e-246cc4a9a303';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    hostApiMock.mediaThumbnails.mockResolvedValueOnce({
      '/tmp/sky.png': { preview: 'data:image/png;base64,abc123', fileSize: 67 },
    });

    hostEventsMock.runtimeEventListener?.({
      type: 'tool.completed',
      sessionKey: `image_generate:${taskId}`,
      runId: `image_generate:${taskId}:ok`,
      toolCallId: 'message-tool',
      name: 'message',
      result: {
        details: {
          status: 'ok',
          deliveryStatus: 'sent',
          sourceReplySink: 'internal-ui',
          sourceReply: {
            text: 'Here is the exact sky scene you requested.',
            mediaUrls: ['/tmp/sky.png'],
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hostApiMock.mediaThumbnails).toHaveBeenCalledWith({
      paths: [{
        attachmentFileRef: expect.objectContaining({ uri: '/tmp/sky.png' }),
        key: '/tmp/sky.png',
        mimeType: 'image/png',
      }],
    });
    const timeline = useAcpChatSessionStore.getState().timeline;
    const syntheticId = timeline.itemOrder.find((id) => id.startsWith('compat:image-generation:'));
    expect(syntheticId).toBeTruthy();
    expect(timeline.itemsById[syntheticId!]).toMatchObject({
      kind: 'message-segment',
      role: 'assistant',
      compat: { source: 'image-generation' },
      parts: [
        { kind: 'markdown', text: 'Here is the exact sky scene you requested.' },
        { kind: 'image', source: 'data:image/png;base64,abc123', mimeType: 'image/png', alt: 'Image' },
      ],
    });
  });

  it('projects a text-only image-generation failure as an assistant reply', async () => {
    const taskId = '32aa3a12-a05b-4074-af4e-246cc4a9a303';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    expect(useAcpChatSessionStore.getState().pendingImageGenerationTaskIds).toEqual([taskId]);

    hostEventsMock.runtimeEventListener?.({
      type: 'tool.completed',
      sessionKey: `image_generate:${taskId}`,
      runId: `image_generate:${taskId}:error`,
      toolCallId: 'message-tool',
      name: 'message',
      result: {
        details: {
          status: 'ok',
          deliveryStatus: 'sent',
          sourceReplySink: 'internal-ui',
          sourceReply: {
            text: 'Image generation failed because no image model is available.',
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hostApiMock.mediaThumbnails).not.toHaveBeenCalled();
    const timeline = useAcpChatSessionStore.getState().timeline;
    const syntheticId = timeline.itemOrder.find((id) => id.startsWith('compat:image-generation:'));
    expect(syntheticId).toBeTruthy();
    expect(timeline.itemsById[syntheticId!]).toMatchObject({
      kind: 'message-segment',
      role: 'assistant',
      compat: { source: 'image-generation' },
      parts: [{
        kind: 'markdown',
        text: 'Image generation failed because no image model is available.',
      }],
    });
    expect(useAcpChatSessionStore.getState().pendingImageGenerationTaskIds).toEqual([]);
  });

  it('upgrades a generic image caption when authoritative source-reply text arrives later', async () => {
    const taskId = '32aa3a12-a05b-4074-af4e-246cc4a9a303';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    hostApiMock.mediaThumbnails.mockResolvedValueOnce({
      '/tmp/sky.png': { preview: 'data:image/png;base64,abc123', fileSize: 67 },
    });

    hostEventsMock.runtimeEventListener?.({
      type: 'assistant.delta',
      sessionKey: 'agent:pi:s1',
      runId: `image_generate:${taskId}:ok`,
      text: 'Draft caption that must not win.',
      mediaUrls: ['/tmp/sky.png'],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    hostEventsMock.runtimeEventListener?.({
      type: 'tool.completed',
      sessionKey: `image_generate:${taskId}`,
      runId: `image_generate:${taskId}:ok`,
      toolCallId: 'message-tool',
      name: 'message',
      result: {
        details: {
          status: 'ok',
          deliveryStatus: 'sent',
          sourceReplySink: 'internal-ui',
          sourceReply: {
            text: 'The finished sky scene uses your requested watercolor style.',
            mediaUrls: ['/tmp/sky.png'],
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'The finished sky scene uses your requested watercolor style.',
          },
        },
      },
    });

    const timeline = useAcpChatSessionStore.getState().timeline;
    const matchingReplies = timeline.itemOrder
      .map((id) => timeline.itemsById[id])
      .filter((item) => item?.kind === 'message-segment'
        && item.role === 'assistant'
        && item.parts.some((part) => (
          part.kind === 'markdown'
          && part.text === 'The finished sky scene uses your requested watercolor style.'
        )));
    expect(matchingReplies).toHaveLength(1);
    expect(matchingReplies[0]).toMatchObject({
      parts: [
        { kind: 'markdown', text: 'The finished sky scene uses your requested watercolor style.' },
        { kind: 'image', source: 'data:image/png;base64,abc123' },
      ],
    });
    expect(matchingReplies[0]?.messageId).not.toMatch(/^compat:image-generation:/);
  });

  it('hydrates a late ACP image reply when preview resolution succeeds on retry', async () => {
    const taskId = 'aa3a12a0-5b40-474a-84fe-246cc4a9a303';
    const caption = 'The finished rabbit image is ready.';
    const generatedPath = '/tmp/retry-rabbit.png';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool-retry',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    hostApiMock.resolveAttachment.mockResolvedValueOnce({
      ok: false,
      displayName: 'retry-rabbit.png',
      error: 'notFound',
    });
    hostApiMock.mediaThumbnails.mockResolvedValue({
      [generatedPath]: { preview: 'data:image/png;base64,retried-rabbit', fileSize: 67 },
    });
    const completion = {
      message: {
        sessionKey: 'agent:pi:s1',
        runId: `image_generate:${taskId}:ok`,
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${caption}\n\nMEDIA:${generatedPath}` }],
        },
      },
    };

    hostEventsMock.gatewayChatMessageListener?.(completion);
    await new Promise((resolve) => setTimeout(resolve, 0));
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: caption },
        },
      },
    });
    expect(useAcpChatSessionStore.getState().timeline.itemOrder.filter(
      (id) => id.startsWith('compat:image-generation:'),
    )).toHaveLength(0);

    hostEventsMock.gatewayChatMessageListener?.(completion);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = useAcpChatSessionStore.getState().timeline;
    const matchingReplies = timeline.itemOrder
      .map((id) => timeline.itemsById[id])
      .filter((item) => item?.kind === 'message-segment'
        && item.role === 'assistant'
        && item.parts.some((part) => part.kind === 'markdown' && part.text === caption));
    expect(matchingReplies).toHaveLength(1);
    expect(matchingReplies[0]).toMatchObject({
      parts: [
        { kind: 'markdown', text: caption },
        {
          kind: 'image',
          source: 'data:image/png;base64,retried-rabbit',
          mediaIdentity: generatedPath,
        },
      ],
    });
    expect(timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toHaveLength(0);
  });

  it('keeps same-turn image media owned by its nearest task anchor', async () => {
    const firstTaskId = 'bb3a12a0-5b40-474a-84fe-246cc4a9a303';
    const secondTaskId = 'cc3a12a0-5b40-474a-84fe-246cc4a9a303';
    const caption = 'The generated image is ready.';
    const firstPath = '/tmp/first-owned-image.png';
    const secondPath = '/tmp/second-owned-image.png';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });
    emitImageTaskStart(firstTaskId, 'image-tool-first');
    emitImageTaskStart(secondTaskId, 'image-tool-second');
    hostApiMock.mediaThumbnails.mockResolvedValue({
      [firstPath]: { preview: 'data:image/png;base64,first-owned', fileSize: 67 },
      [secondPath]: { preview: 'data:image/png;base64,second-owned', fileSize: 68 },
    });

    emitGatewayImageCompletion(firstTaskId, caption, firstPath);
    await new Promise((resolve) => setTimeout(resolve, 0));
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: caption },
        },
      },
    });
    emitGatewayImageCompletion(secondTaskId, caption, secondPath);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = useAcpChatSessionStore.getState().timeline;
    const assistantReplies = timeline.itemOrder
      .map((id) => timeline.itemsById[id])
      .filter((item) => item?.kind === 'message-segment' && item.role === 'assistant');
    const firstReply = assistantReplies.find((item) => item?.parts.some((part) => (
      part.kind === 'image' && part.mediaIdentity === firstPath
    )));
    const secondReply = assistantReplies.find((item) => item?.parts.some((part) => (
      part.kind === 'image' && part.mediaIdentity === secondPath
    )));
    expect(firstReply?.messageId).toMatch(/^compat:image-generation:/);
    expect(secondReply?.messageId).not.toMatch(/^compat:image-generation:/);
    expect(firstReply?.parts.some((part) => part.kind === 'image' && part.mediaIdentity === secondPath)).toBe(false);
    expect(secondReply?.parts.some((part) => part.kind === 'image' && part.mediaIdentity === firstPath)).toBe(false);

    function emitImageTaskStart(taskId: string, toolCallId: string): void {
      hostEventsMock.updateListener?.({
        sessionKey: 'agent:pi:s1',
        generation: 1,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'completed',
            content: [{
              type: 'content',
              content: {
                type: 'text',
                text: `Background task started for image generation (${taskId}).`,
              },
            }],
          },
        },
      });
    }

    function emitGatewayImageCompletion(taskId: string, text: string, generatedPath: string): void {
      hostEventsMock.gatewayChatMessageListener?.({
        message: {
          sessionKey: 'agent:pi:s1',
          runId: `image_generate:${taskId}:ok`,
          state: 'final',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `${text}\n\nMEDIA:${generatedPath}` }],
          },
        },
      });
    }
  });

  it('deduplicates ACP and runtime text-only evidence for the same image task', async () => {
    const taskId = '32aa3a12-a05b-4074-af4e-246cc4a9a303';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'message-tool',
          status: 'completed',
          rawOutput: {
            details: {
              status: 'ok',
              deliveryStatus: 'sent',
              sourceReplySink: 'internal-ui',
              sourceReply: { text: 'ACP failure explanation.' },
            },
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    hostEventsMock.runtimeEventListener?.({
      type: 'tool.completed',
      sessionKey: `image_generate:${taskId}`,
      runId: `image_generate:${taskId}:error`,
      toolCallId: 'message-tool',
      name: 'message',
      result: {
        details: {
          status: 'ok',
          deliveryStatus: 'sent',
          sourceReplySink: 'internal-ui',
          sourceReply: { text: 'Runtime failure explanation.' },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = useAcpChatSessionStore.getState().timeline;
    const syntheticIds = timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'));
    expect(syntheticIds).toHaveLength(1);
    expect(timeline.itemsById[syntheticIds[0]!]).toMatchObject({
      parts: [{ kind: 'markdown', text: 'ACP failure explanation.' }],
    });
  });

  it('rejects a task-tagged completion that does not match the recorded image task', async () => {
    const recordedTaskId = '32aa3a12-a05b-4074-af4e-246cc4a9a303';
    const unrelatedTaskId = '45bb4b23-b16c-4185-b05f-357dd5b0b414';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${recordedTaskId}).`,
            },
          }],
        },
      },
    });

    hostEventsMock.runtimeEventListener?.({
      type: 'tool.completed',
      sessionKey: 'agent:pi:s1',
      runId: `image_generate:${unrelatedTaskId}:error`,
      toolCallId: 'message-tool',
      name: 'message',
      result: {
        details: {
          status: 'ok',
          deliveryStatus: 'sent',
          sourceReplySink: 'internal-ui',
          sourceReply: { text: 'Unrelated completion.' },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useAcpChatSessionStore.getState().timeline.itemOrder.filter(
      (id) => id.startsWith('compat:image-generation:'),
    )).toHaveLength(0);
  });

  it('deduplicates different media references that resolve to the same generated image', async () => {
    const taskId = '32aa3a12-a05b-4074-af4e-246cc4a9a303';
    const { useAcpChatSessionStore } = await importStore();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    useAcpChatSessionStore.getState().recordImageGenerationStart({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    hostApiMock.resolveAttachment.mockResolvedValue({
      ok: true,
      identity: 'same-generated-image',
      displayName: 'sky.png',
      mimeType: 'image/png',
      size: 67,
      target: {
        kind: 'local',
        scope: 'openclaw-media',
        ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: '/tmp/sky.png' },
      },
    });
    hostApiMock.mediaThumbnails.mockResolvedValue({
      'same-generated-image': { preview: 'data:image/png;base64,abc123', fileSize: 67 },
    });

    await useAcpChatSessionStore.getState().projectImageGenerationCompletion({
      sessionKey: `image_generate:${taskId}`,
      source: 'runtime-event',
      taskId,
      evidenceId: 'runtime-local-path',
      caption: 'The sky image is ready.',
      authoritativeCaption: true,
      candidates: [{ key: '/tmp/sky.png', filePath: '/tmp/sky.png', mimeType: 'image/png' }],
    });
    await useAcpChatSessionStore.getState().projectImageGenerationCompletion({
      sessionKey: `image_generate:${taskId}`,
      source: 'gateway-chat-message',
      taskId,
      evidenceId: 'gateway-media-url',
      caption: 'The sky image is ready.',
      authoritativeCaption: true,
      candidates: [{
        key: '/api/chat/media/outgoing/session/image/full',
        gatewayUrl: '/api/chat/media/outgoing/session/image/full',
        mimeType: 'image/png',
      }],
    });

    const timeline = useAcpChatSessionStore.getState().timeline;
    expect(timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toHaveLength(1);
    expect(Object.values(timeline.itemsById).flatMap((item) => (
      item.kind === 'message-segment' ? item.parts.filter((part) => part.kind === 'image') : []
    ))).toHaveLength(1);
  });

  it('reprojects image-generation previews from historical ACP replay tool output', async () => {
    const taskId = '32aa3a12-a05b-4074-af4e-246cc4a9a303';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostApiMock.mediaThumbnails.mockResolvedValueOnce({
      '/tmp/replayed-sky.png': { preview: 'data:image/png;base64,replayed', fileSize: 67 },
    });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'message-tool',
          status: 'completed',
          rawOutput: {
            details: {
              status: 'ok',
              deliveryStatus: 'sent',
              sourceReplySink: 'internal-ui',
              sourceReply: { mediaUrls: ['/tmp/replayed-sky.png'] },
            },
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hostApiMock.mediaThumbnails).toHaveBeenCalledWith({
      paths: [{
        attachmentFileRef: expect.objectContaining({ uri: '/tmp/replayed-sky.png' }),
        key: '/tmp/replayed-sky.png',
        mimeType: 'image/png',
      }],
    });
    const timeline = useAcpChatSessionStore.getState().timeline;
    const syntheticId = timeline.itemOrder.find((id) => id.startsWith('compat:image-generation:'));
    expect(syntheticId).toBeTruthy();
    expect(timeline.itemsById[syntheticId!]).toMatchObject({
      kind: 'message-segment',
      role: 'assistant',
      compat: { source: 'image-generation' },
      parts: [
        { kind: 'markdown', text: 'Generated image is ready.' },
        { kind: 'image', source: 'data:image/png;base64,replayed', mimeType: 'image/png', alt: 'Image' },
      ],
    });
  });

  it('reprojects image-generation previews from historical ACP assistant MEDIA text', async () => {
    const taskId = '32aa3a12-a05b-4074-af4e-246cc4a9a303';
    const generatedPath = '/Users/me/.openclaw/media/tool-image-generation/clawx-image-1.png';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostApiMock.mediaThumbnails.mockResolvedValueOnce({
      [generatedPath]: { preview: 'data:image/png;base64,replayed-media-text', fileSize: 67 },
    });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'replayed-image-result',
          content: {
            type: 'text',
            text: `图片生成完成！这是为你创建的蓝天白云风景图。\n\nMEDIA:${generatedPath}`,
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hostApiMock.mediaThumbnails).toHaveBeenCalledWith({
      paths: [{
        attachmentFileRef: expect.objectContaining({ uri: generatedPath }),
        key: generatedPath,
        mimeType: 'image/png',
      }],
    });
    const timeline = useAcpChatSessionStore.getState().timeline;
    const syntheticId = timeline.itemOrder.find((id) => id.startsWith('compat:image-generation:'));
    expect(syntheticId).toBeTruthy();
    expect(timeline.itemsById[syntheticId!]).toMatchObject({
      kind: 'message-segment',
      role: 'assistant',
      compat: { source: 'image-generation' },
      parts: [
        { kind: 'markdown', text: 'Generated image is ready.' },
        { kind: 'image', source: 'data:image/png;base64,replayed-media-text', mimeType: 'image/png', alt: 'Image' },
      ],
    });
  });

  it('does not let historical replay context authorize live ACP media updates', async () => {
    const taskId = '32aa3a12-a05b-4074-af4e-246cc4a9a303';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'message-tool',
          status: 'completed',
          rawOutput: {
            details: {
              sourceReply: { mediaUrls: ['/tmp/live-after-replay.png'] },
            },
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = useAcpChatSessionStore.getState().timeline;
    expect(hostApiMock.mediaThumbnails).not.toHaveBeenCalled();
    expect(timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toHaveLength(0);
  });

  it('does not let live image-generation context authorize historical ACP MEDIA text', async () => {
    const taskId = '32aa3a12-a05b-4074-af4e-246cc4a9a303';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: `Background task started for image generation (${taskId}).` } }],
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'historical-media-with-live-context',
          content: { type: 'text', text: 'Done\n\nMEDIA:/tmp/live-context-only.png' },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = useAcpChatSessionStore.getState().timeline;
    expect(hostApiMock.mediaThumbnails).not.toHaveBeenCalled();
    expect(timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toHaveLength(0);
  });

  it('does not project ACP rawOutput media without internal-ui delivery evidence', async () => {
    const taskId = '32aa3a12-a05b-4074-af4e-246cc4a9a303';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: `Background task started for image generation (${taskId}).` } }],
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'read-tool',
          status: 'completed',
          rawOutput: {
            details: {
              sourceReply: { mediaUrls: ['/tmp/not-internal-ui-delivery.png'] },
            },
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = useAcpChatSessionStore.getState().timeline;
    expect(hostApiMock.mediaThumbnails).not.toHaveBeenCalled();
    expect(timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toHaveLength(0);
  });

  it('does not let historical task ids become runtime-eligible after a live image-generation start', async () => {
    const historicalTaskId = '32aa3a12-a05b-4074-af4e-246cc4a9a303';
    const liveTaskId = '42bb4b23-b16c-4185-b05f-357dd5ba0414';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'historical-image-tool',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: `Background task started for image generation (${historicalTaskId}).` } }],
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'live-image-tool',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: `Background task started for image generation (${liveTaskId}).` } }],
        },
      },
    });

    hostEventsMock.runtimeEventListener?.({
      type: 'tool.completed',
      sessionKey: `image_generate:${historicalTaskId}`,
      runId: `image_generate:${historicalTaskId}:ok`,
      toolCallId: 'message-tool',
      name: 'message',
      result: {
        details: {
          sourceReply: { mediaUrls: ['/tmp/stale-replayed-task.png'] },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = useAcpChatSessionStore.getState().timeline;
    expect(hostApiMock.mediaThumbnails).not.toHaveBeenCalled();
    expect(timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toHaveLength(0);
  });

  it('does not project media without recent image-generation context', async () => {
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });

    hostEventsMock.gatewayChatMessageListener?.({
      message: {
        sessionKey: 'agent:pi:s1',
        runId: 'run-1',
        message: {
          role: 'toolresult',
          toolName: 'message',
          details: { mediaUrls: ['/tmp/not-from-image-generation.png'] },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hostApiMock.mediaThumbnails).not.toHaveBeenCalled();
    expect(useAcpChatSessionStore.getState().timeline.itemOrder).toEqual([]);
  });

  it('does not trust Gateway media from historical image-generation replay context', async () => {
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: 'Background task started for image generation (32aa3a12-a05b-4074-af4e-246cc4a9a303).',
            },
          }],
        },
      },
    });

    hostEventsMock.gatewayChatMessageListener?.({
      message: {
        sessionKey: 'agent:pi:s1',
        runId: 'run-1',
        message: {
          role: 'toolresult',
          toolName: 'message',
          details: { mediaUrls: ['/tmp/replayed-image.png'] },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = useAcpChatSessionStore.getState().timeline;
    expect(hostApiMock.mediaThumbnails).not.toHaveBeenCalled();
    expect(timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toHaveLength(0);
  });

  it('merges live image media into the matching ACP completion reply', async () => {
    const taskId = '32aa3a12-a05b-4074-af4e-246cc4a9a303';
    const caption = 'The generated rabbit image is ready.';
    const generatedPath = '/tmp/generated-rabbit.png';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1',
      workspaceRoot: '/repo',
      cwd: '/repo',
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'image-completion-reply',
          content: { type: 'text', text: caption },
        },
      },
    });
    hostApiMock.mediaThumbnails.mockResolvedValue({
      [generatedPath]: { preview: 'data:image/png;base64,rabbit', fileSize: 67 },
    });

    hostEventsMock.gatewayChatMessageListener?.({
      message: {
        sessionKey: 'agent:pi:s1',
        runId: `image_generate:${taskId}:ok`,
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${caption}\n\nMEDIA:${generatedPath}` }],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = useAcpChatSessionStore.getState().timeline;
    const matchingReplies = timeline.itemOrder
      .map((id) => timeline.itemsById[id])
      .filter((item) => item?.kind === 'message-segment'
        && item.role === 'assistant'
        && item.parts.some((part) => part.kind === 'markdown' && part.text === caption));
    expect(matchingReplies).toHaveLength(1);
    expect(matchingReplies[0]).toMatchObject({
      kind: 'message-segment',
      messageId: 'image-completion-reply',
      parts: [
        { kind: 'markdown', text: caption },
        { kind: 'image', source: 'data:image/png;base64,rabbit' },
      ],
    });
    expect(timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toEqual([]);
  });

  it('merges a later live ACP message-tool image completion into the existing authoritative caption', async () => {
    const taskId = '25272bb3-b8d2-4a24-99d2-27b95e606bcc';
    const caption = 'The blue coffee cup product photo is ready.';
    const generatedPath = '/tmp/generated-blue-coffee-cup.png';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1',
      workspaceRoot: '/repo',
      cwd: '/repo',
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'user_message',
          messageId: 'image-user',
          content: [{ type: 'text', text: 'Generate a blue coffee cup product photo' }],
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          title: 'Generate image',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message',
          messageId: 'native-image-reply',
          content: [{ type: 'text', text: caption }],
        },
      },
    });
    hostApiMock.mediaThumbnails.mockResolvedValue({
      [generatedPath]: { preview: 'data:image/png;base64,blue-coffee-cup', fileSize: 67 },
    });

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'message-tool',
          title: 'Deliver image',
          status: 'completed',
          rawOutput: {
            details: {
              status: 'ok',
              deliveryStatus: 'sent',
              sourceReplySink: 'internal-ui',
              sourceReply: {
                text: caption,
                mediaUrls: [generatedPath],
              },
            },
          },
        },
      },
    });
    await vi.waitFor(() => expect(hostApiMock.mediaThumbnails).toHaveBeenCalledTimes(1));

    const timeline = useAcpChatSessionStore.getState().timeline;
    const captionItems = timeline.itemOrder
      .map((id) => timeline.itemsById[id])
      .filter((item) => item?.kind === 'message-segment'
        && item.role === 'assistant'
        && item.parts.some((part) => part.kind === 'markdown' && part.text === caption));
    expect(captionItems).toHaveLength(1);
    expect(timeline.itemsById['native-image-reply:0']).toMatchObject({
      kind: 'message-segment',
      role: 'assistant',
      messageId: 'native-image-reply',
      parts: [
        { kind: 'markdown', text: caption },
        { kind: 'image', source: 'data:image/png;base64,blue-coffee-cup' },
      ],
    });
    expect(timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toEqual([]);
  });

  it('merges a later live transcript image completion into the preceding native ACP caption', async () => {
    const taskId = 'd4942664-e2f8-4819-a320-b8e897c13275';
    const prompt = 'Generate a western woman shopping photo';
    const caption = 'The realistic western woman shopping photo is ready.';
    const generatedPath = '/tmp/live-transcript-caption-first.png';
    const history = createDeferred<{
      success: true;
      messages: Array<Record<string, unknown>>;
    }>();
    hostApiMock.sendAcpPrompt.mockImplementationOnce(async () => {
      hostEventsMock.updateListener?.({
        sessionKey: 'agent:pi:s1',
        generation: 1,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'image-tool-caption-first',
            status: 'completed',
            content: [{
              type: 'content',
              content: {
                type: 'text',
                text: `Background task started for image generation (${taskId}).`,
              },
            }],
          },
        },
      });
      return { success: true };
    });
    hostApiMock.sessionsHistory.mockReturnValueOnce(history.promise);
    hostApiMock.mediaThumbnails.mockResolvedValue({
      [generatedPath]: { preview: 'data:image/png;base64,live-transcript-caption-first', fileSize: 67 },
    });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1',
      workspaceRoot: '/repo',
      cwd: '/repo',
      createIfMissing: true,
    });

    await useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: prompt,
      messageId: 'caption-first-user',
    });
    await vi.waitFor(() => expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(1));
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: caption },
        },
      },
    });
    history.resolve({
      success: true,
      messages: [
        { role: 'user', content: prompt },
        {
          role: 'toolresult',
          toolCallId: 'image-tool-caption-first',
          toolName: 'image_generate',
          content: `Background task started for image generation (${taskId}).`,
          details: { taskId },
        },
        {
          role: 'user',
          content: `[Inter-session message] sourceSession=image_generate:${taskId} sourceChannel=webchat sourceTool=image_generate isUser=false\n[Internal task completion event]\nstatus: completed successfully`,
          provenance: {
            kind: 'inter_session',
            sourceSessionKey: `image_generate:${taskId}`,
            sourceTool: 'image_generate',
          },
        },
        {
          role: 'assistant',
          id: 'transcript-caption-first-reply',
          content: `${caption}\n\nMEDIA:${generatedPath}`,
        },
      ],
    });
    await vi.waitFor(() => expect(hostApiMock.mediaThumbnails).toHaveBeenCalledTimes(1));

    const timeline = useAcpChatSessionStore.getState().timeline;
    const matchingReplies = timeline.itemOrder
      .map((id) => timeline.itemsById[id])
      .filter((item) => item?.kind === 'message-segment'
        && item.role === 'assistant'
        && item.parts.some((part) => part.kind === 'markdown' && part.text === caption));
    expect(matchingReplies).toHaveLength(1);
    expect(matchingReplies[0]).toMatchObject({
      kind: 'message-segment',
      role: 'assistant',
      parts: [
        { kind: 'markdown', text: caption },
        { kind: 'image', source: 'data:image/png;base64,live-transcript-caption-first' },
      ],
    });
    expect(timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toEqual([]);
  });

  it('keeps one live completion when a structured gateway image is followed by the model MEDIA mirror', async () => {
    const prompt = '画一张西瓜吃席瓜的图';
    const caption = '画好了：西瓜坐在中式宴席上，用筷子吃西瓜，旁边还有一桌西瓜宾客。';
    const truncatedMirror = '画好了：西瓜坐在中式宴席上，用筷子吃西瓜，旁边还有一桌西瓜';
    const gatewayUrl = '/api/chat/media/outgoing/agent%3Api%3As1/image-1/full';
    const imagePath = '/repo/watermelon.png';
    hostApiMock.sendAcpPrompt.mockImplementationOnce(async () => {
      hostEventsMock.updateListener?.({
        sessionKey: 'agent:pi:s1',
        generation: 1,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'image-tool-sync-result',
            status: 'completed',
            content: [{
              type: 'content',
              content: { type: 'text', text: `Generated 1 image. Attachments: mimeType=image/png path="${imagePath}"` },
            }],
          },
        },
      });
      hostEventsMock.updateListener?.({
        sessionKey: 'agent:pi:s1',
        generation: 1,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'agent_message',
            messageId: 'gateway-image-message',
            content: [{ type: 'text', text: caption }],
          },
        },
      });
      return { success: true };
    });
    hostApiMock.sessionsHistory.mockResolvedValue({
      success: true,
      messages: [
        { role: 'user', id: 'image-user-transcript', content: prompt },
        {
          role: 'toolresult',
          toolCallId: 'image-tool-sync-result',
          toolName: 'image_generate',
          content: `Generated 1 image. Attachments: mimeType=image/png path="${imagePath}"`,
        },
        {
          role: 'assistant',
          id: 'gateway-image-message',
          content: [
            { type: 'text', text: caption },
            { type: 'image', url: gatewayUrl, mimeType: 'image/png' },
          ],
        },
        {
          role: 'assistant',
          id: 'model-image-message',
          content: `${caption}\n\nMEDIA:${imagePath}`,
        },
      ],
    });
    hostApiMock.mediaThumbnails.mockResolvedValue({
      [imagePath]: { preview: 'data:image/png;base64,watermelon', fileSize: 67 },
    });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
    });

    await useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1', cwd: '/repo', message: prompt, messageId: 'image-user-live',
    });
    await vi.waitFor(() => expect(hostApiMock.mediaThumbnails).toHaveBeenCalledTimes(1));
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
            sessionUpdate: 'agent_message',
            messageId: 'model-image-message',
            content: [{ type: 'text', text: truncatedMirror }],
        },
      },
    });

    const timeline = useAcpChatSessionStore.getState().timeline;
    const captionItems = timeline.itemOrder
      .map((id) => timeline.itemsById[id])
      .filter((item) => item?.kind === 'message-segment'
        && item.role === 'assistant'
        && item.parts.some((part) => part.kind === 'markdown' && part.text === caption));
    expect(captionItems).toHaveLength(1);
    expect(captionItems[0]).toMatchObject({
      messageId: 'gateway-image-message',
      parts: [
        { kind: 'markdown', text: caption },
        { kind: 'image', source: 'data:image/png;base64,watermelon' },
      ],
    });
    expect(timeline.itemOrder
      .map((id) => timeline.itemsById[id])
      .filter((item) => item?.kind === 'message-segment' && item.role === 'assistant')
      .flatMap((item) => item?.kind === 'message-segment' ? item.parts : [])
      .some((part) => part.kind === 'markdown' && part.text === truncatedMirror)).toBe(false);
    expect(hostApiMock.resolveAttachment).toHaveBeenCalledWith(expect.objectContaining({
      ref: expect.objectContaining({
        uri: imagePath,
        transcriptMessageId: 'model-image-message',
      }),
    }));
    expect(timeline.itemOrder
      .map((id) => timeline.itemsById[id])
      .filter((item) => item?.kind === 'message-segment')
      .flatMap((item) => item?.kind === 'message-segment' ? item.parts : [])
      .some((part) => part.kind === 'attachment')).toBe(false);
  });

  it('waits for media before projecting a successful text-only image completion', async () => {
    const taskId = '4959fd41-c9eb-448d-a12c-3f120a12bf28';
    const prompt = 'Generate a white woman shopping in China';
    const caption = 'The China street shopping photo is ready.';
    const generatedPath = '/tmp/china-street-shopping.png';
    const history = createDeferred<{
      success: true;
      messages: Array<Record<string, unknown>>;
    }>();
    hostApiMock.sendAcpPrompt.mockImplementationOnce(async () => {
      hostEventsMock.updateListener?.({
        sessionKey: 'agent:pi:s1',
        generation: 1,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'image-tool-success-text-first',
            status: 'completed',
            content: [{
              type: 'content',
              content: {
                type: 'text',
                text: `Background task started for image generation (${taskId}).`,
              },
            }],
          },
        },
      });
      return { success: true };
    });
    hostApiMock.sessionsHistory.mockReturnValueOnce(history.promise);
    hostApiMock.mediaThumbnails.mockResolvedValue({
      [generatedPath]: { preview: 'data:image/png;base64,china-street-shopping', fileSize: 67 },
    });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1',
      workspaceRoot: '/repo',
      cwd: '/repo',
      createIfMissing: true,
    });

    await useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: prompt,
      messageId: 'success-text-first-user',
    });
    await vi.waitFor(() => expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(1));
    hostEventsMock.runtimeEventListener?.({
      type: 'assistant.delta',
      sessionKey: 'agent:pi:s1',
      runId: `image_generate:${taskId}:ok`,
      phase: 'final_answer',
      text: caption,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useAcpChatSessionStore.getState().timeline.itemOrder.filter(
      (id) => id.startsWith('compat:image-generation:'),
    )).toHaveLength(0);

    history.resolve({
      success: true,
      messages: [
        { role: 'user', content: prompt },
        {
          role: 'toolresult',
          toolCallId: 'image-tool-success-text-first',
          toolName: 'image_generate',
          content: `Background task started for image generation (${taskId}).`,
          details: { taskId },
        },
        {
          role: 'user',
          content: `[Inter-session message] sourceSession=image_generate:${taskId} sourceChannel=webchat sourceTool=image_generate isUser=false\n[Internal task completion event]\nstatus: completed successfully`,
          provenance: {
            kind: 'inter_session',
            sourceSessionKey: `image_generate:${taskId}`,
            sourceTool: 'image_generate',
          },
        },
        {
          role: 'assistant',
          id: 'success-text-first-completion',
          content: `${caption}\n\nMEDIA:${generatedPath}`,
        },
      ],
    });
    await vi.waitFor(() => expect(hostApiMock.mediaThumbnails).toHaveBeenCalledTimes(1));

    const timeline = useAcpChatSessionStore.getState().timeline;
    const replies = timeline.itemOrder
      .map((id) => timeline.itemsById[id])
      .filter((item) => item?.kind === 'message-segment'
        && item.role === 'assistant'
        && item.parts.some((part) => part.kind === 'markdown' && part.text === caption));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      parts: [
        { kind: 'markdown', text: caption },
        { kind: 'image', source: 'data:image/png;base64,china-street-shopping' },
      ],
    });
  });

  it('reconciles a late streamed ACP reply after the image completion was projected first', async () => {
    const taskId = '65dd6d45-d38e-4e8b-ae4f-579ff7d2d636';
    const caption = 'The generated rabbit image is ready.';
    const generatedPath = '/tmp/generated-rabbit-before-acp.png';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1',
      workspaceRoot: '/repo',
      cwd: '/repo',
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    hostApiMock.mediaThumbnails.mockResolvedValue({
      [generatedPath]: { preview: 'data:image/png;base64,rabbit-before-acp', fileSize: 67 },
    });

    hostEventsMock.gatewayChatMessageListener?.({
      message: {
        sessionKey: 'agent:pi:s1',
        runId: `image_generate:${taskId}:ok`,
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${caption}\n\nMEDIA:${generatedPath}` }],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    let timeline = useAcpChatSessionStore.getState().timeline;
    expect(timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toHaveLength(1);

    const firstChunk = caption.slice(0, 24);
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: firstChunk },
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: caption.slice(firstChunk.length) },
        },
      },
    });

    timeline = useAcpChatSessionStore.getState().timeline;
    const matchingReplies = timeline.itemOrder
      .map((id) => timeline.itemsById[id])
      .filter((item) => item?.kind === 'message-segment'
        && item.role === 'assistant'
        && item.parts.some((part) => part.kind === 'markdown' && part.text === caption));
    expect(matchingReplies).toHaveLength(1);
    expect(matchingReplies[0]).toMatchObject({
      kind: 'message-segment',
      parts: [
        { kind: 'markdown', text: caption },
        {
          kind: 'image',
          source: 'data:image/png;base64,rabbit-before-acp',
          mediaIdentity: generatedPath,
        },
      ],
    });
    expect(matchingReplies[0]?.messageId).not.toMatch(/^compat:image-generation:/);
    expect(timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toEqual([]);
  });

  it('reconciles a live transcript image supplement before its native ACP reply arrives', async () => {
    const taskId = '76ee7e56-e49f-4f9c-bf50-680008e3e747';
    const prompt = 'Generate a rabbit walking through a shopping street';
    const caption = 'The rabbit street photo is ready.';
    const generatedPath = '/tmp/live-transcript-rabbit.png';
    hostApiMock.sendAcpPrompt.mockImplementationOnce(async () => {
      hostEventsMock.updateListener?.({
        sessionKey: 'agent:pi:s1',
        generation: 1,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'image-tool',
            status: 'completed',
            content: [{
              type: 'content',
              content: {
                type: 'text',
                text: `Background task started for image generation (${taskId}).`,
              },
            }],
          },
        },
      });
      return { success: true };
    });
    hostApiMock.sessionsHistory.mockResolvedValue({
      success: true,
      messages: [
        { role: 'user', content: prompt },
        {
          role: 'toolresult',
          toolCallId: 'image-tool',
          toolName: 'image_generate',
          content: `Background task started for image generation (${taskId}).`,
          details: { taskId },
        },
        {
          role: 'user',
          content: `[Inter-session message] sourceSession=image_generate:${taskId} sourceChannel=webchat sourceTool=image_generate isUser=false\n[Internal task completion event]\nstatus: completed successfully`,
          provenance: {
            kind: 'inter_session',
            sourceSessionKey: `image_generate:${taskId}`,
            sourceTool: 'image_generate',
          },
        },
        {
          role: 'assistant',
          id: 'rabbit-transcript-completion',
          content: `${caption}\n\nMEDIA:${generatedPath}`,
        },
      ],
    });
    hostApiMock.mediaThumbnails.mockResolvedValue({
      [generatedPath]: { preview: 'data:image/png;base64,live-transcript-rabbit', fileSize: 67 },
    });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1',
      workspaceRoot: '/repo',
      cwd: '/repo',
      createIfMissing: true,
    });

    await useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: prompt,
      messageId: 'rabbit-user',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useAcpChatSessionStore.getState().timeline.itemOrder.filter(
      (id) => id.startsWith('compat:image-generation:'),
    )).toHaveLength(1);

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: caption },
        },
      },
    });

    const timeline = useAcpChatSessionStore.getState().timeline;
    const matchingReplies = timeline.itemOrder
      .map((id) => timeline.itemsById[id])
      .filter((item) => item?.kind === 'message-segment'
        && item.role === 'assistant'
        && item.parts.some((part) => part.kind === 'markdown' && part.text === caption));
    expect(matchingReplies).toHaveLength(1);
    expect(matchingReplies[0]).toMatchObject({
      parts: [
        { kind: 'markdown', text: caption },
        {
          kind: 'image',
          source: 'data:image/png;base64,live-transcript-rabbit',
          mediaIdentity: generatedPath,
        },
      ],
    });
    expect(timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toEqual([]);
  });

  it('does not reconcile a projected image caption with native ACP text from a later user turn', async () => {
    const taskId = '87ff8f67-f5a0-40ad-8061-791119f4f858';
    const caption = 'The generated rabbit image is ready.';
    const generatedPath = '/tmp/generated-rabbit-previous-turn.png';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1',
      workspaceRoot: '/repo',
      cwd: '/repo',
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    hostApiMock.mediaThumbnails.mockResolvedValue({
      [generatedPath]: { preview: 'data:image/png;base64,rabbit-previous-turn', fileSize: 67 },
    });
    hostEventsMock.gatewayChatMessageListener?.({
      message: {
        sessionKey: 'agent:pi:s1',
        runId: `image_generate:${taskId}:ok`,
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${caption}\n\nMEDIA:${generatedPath}` }],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'user_message_chunk',
          messageId: 'later-user',
          content: { type: 'text', text: 'Repeat the same sentence.' },
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'later-assistant',
          content: { type: 'text', text: caption },
        },
      },
    });

    const timeline = useAcpChatSessionStore.getState().timeline;
    expect(timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toHaveLength(1);
    expect(timeline.itemsById['later-assistant:0']).toMatchObject({
      parts: [{ kind: 'markdown', text: caption }],
    });
    expect(timeline.itemsById['later-assistant:0']).not.toHaveProperty('compat');
    expect(hostApiMock.recordAcpTrace).toHaveBeenCalledWith(expect.objectContaining({
      event: 'image-generation:projection-reconciliation-stopped',
      details: expect.objectContaining({ taskId, reason: 'user-turn-closed' }),
    }));
  });

  it('does not merge image media into matching ACP text that precedes the image tool card', async () => {
    const taskId = '43bb4b23-b16c-4185-b05f-357dd5b0b414';
    const caption = 'The generated rabbit image is ready.';
    const generatedPath = '/tmp/generated-rabbit-after-tool.png';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1',
      workspaceRoot: '/repo',
      cwd: '/repo',
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'reply-before-image-tool',
          content: { type: 'text', text: caption },
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    hostApiMock.mediaThumbnails.mockResolvedValue({
      [generatedPath]: { preview: 'data:image/png;base64,rabbit-after-tool', fileSize: 67 },
    });

    hostEventsMock.gatewayChatMessageListener?.({
      message: {
        sessionKey: 'agent:pi:s1',
        runId: `image_generate:${taskId}:ok`,
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${caption}\n\nMEDIA:${generatedPath}` }],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = useAcpChatSessionStore.getState().timeline;
    expect(timeline.itemsById['reply-before-image-tool:0']).toMatchObject({
      kind: 'message-segment',
      role: 'assistant',
      parts: [{ kind: 'markdown', text: caption }],
    });
    expect(timeline.itemsById['reply-before-image-tool:0']).not.toHaveProperty('compat');
    const syntheticId = timeline.itemOrder.find((id) => id.startsWith('compat:image-generation:'));
    expect(syntheticId).toBeTruthy();
    expect(timeline.itemsById[syntheticId!]).toMatchObject({
      parts: [
        { kind: 'markdown', text: caption },
        { kind: 'image', source: 'data:image/png;base64,rabbit-after-tool' },
      ],
    });
  });

  it('does not merge image media into matching ACP text from a later user turn', async () => {
    const taskId = '54cc5c34-c27d-4296-c16f-468ee6c1c525';
    const caption = 'The generated rabbit image is ready.';
    const generatedPath = '/tmp/generated-rabbit-other-turn.png';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1',
      workspaceRoot: '/repo',
      cwd: '/repo',
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'user_message_chunk',
          messageId: 'later-user-turn',
          content: { type: 'text', text: 'A later user request.' },
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'reply-in-later-turn',
          content: { type: 'text', text: caption },
        },
      },
    });
    hostApiMock.mediaThumbnails.mockResolvedValue({
      [generatedPath]: { preview: 'data:image/png;base64,rabbit-other-turn', fileSize: 67 },
    });

    hostEventsMock.gatewayChatMessageListener?.({
      message: {
        sessionKey: 'agent:pi:s1',
        runId: `image_generate:${taskId}:ok`,
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${caption}\n\nMEDIA:${generatedPath}` }],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = useAcpChatSessionStore.getState().timeline;
    expect(timeline.itemsById['reply-in-later-turn:0']).toMatchObject({
      kind: 'message-segment',
      role: 'assistant',
      parts: [{ kind: 'markdown', text: caption }],
    });
    expect(timeline.itemsById['reply-in-later-turn:0']).not.toHaveProperty('compat');
    const syntheticId = timeline.itemOrder.find((id) => id.startsWith('compat:image-generation:'));
    expect(syntheticId).toBeTruthy();
    expect(timeline.itemsById[syntheticId!]).toMatchObject({
      parts: [
        { kind: 'markdown', text: caption },
        { kind: 'image', source: 'data:image/png;base64,rabbit-other-turn' },
      ],
    });
  });

  it('dedupes repeated image-generation media delivery records', async () => {
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Background task started for image generation (32aa3a12-a05b-4074-af4e-246cc4a9a303).' } }],
        },
      },
    });
    hostApiMock.mediaThumbnails.mockResolvedValue({
      '/tmp/sky.png': { preview: 'data:image/png;base64,abc123', fileSize: 67 },
    });
    const delivery = {
      message: {
        sessionKey: 'agent:pi:s1',
        runId: 'run-1',
        message: { role: 'toolresult', toolName: 'message', details: { mediaUrls: ['/tmp/sky.png'] } },
      },
    };

    hostEventsMock.gatewayChatMessageListener?.(delivery);
    hostEventsMock.gatewayChatMessageListener?.(delivery);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hostApiMock.mediaThumbnails).toHaveBeenCalledTimes(1);
    expect(useAcpChatSessionStore.getState().timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toHaveLength(1);
  });

  it('dedupes image-generation media delivered by Gateway and runtime streams', async () => {
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Background task started for image generation (32aa3a12-a05b-4074-af4e-246cc4a9a303).' } }],
        },
      },
    });
    hostApiMock.mediaThumbnails.mockResolvedValue({
      '/tmp/sky.png': { preview: 'data:image/png;base64,abc123', fileSize: 67 },
    });

    hostEventsMock.gatewayChatMessageListener?.({
      message: {
        sessionKey: 'agent:pi:s1',
        runId: 'run-1',
        message: { role: 'toolresult', toolName: 'message', details: { mediaUrls: ['/tmp/sky.png'] } },
      },
    });
    hostEventsMock.runtimeEventListener?.({
      type: 'tool.completed',
      sessionKey: 'agent:pi:s1',
      runId: 'run-1',
      name: 'message',
      result: { mediaUrls: ['/tmp/sky.png'] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hostApiMock.mediaThumbnails).toHaveBeenCalledTimes(1);
    expect(useAcpChatSessionStore.getState().timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toHaveLength(1);
  });

  it('keeps distinct image-generation completions when evidence keys collide under 32-bit hashing', async () => {
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Background task started for image generation (32aa3a12-a05b-4074-af4e-246cc4a9a303).' } }],
        },
      },
    });
    hostApiMock.mediaThumbnails.mockResolvedValue({
      '5JYWuT}ThLA}x[G': { preview: 'data:image/png;base64,abc123', fileSize: 67 },
      'bb7CGq|v9x5xCZb': { preview: 'data:image/png;base64,def456', fileSize: 68 },
    });

    hostEventsMock.runtimeEventListener?.({
      type: 'assistant.delta',
      sessionKey: 'agent:pi:s1',
      runId: 'run-1',
      mimeType: 'image/png',
      mediaUrls: ['5JYWuT}ThLA}x[G'],
    });
    hostEventsMock.runtimeEventListener?.({
      type: 'assistant.delta',
      sessionKey: 'agent:pi:s1',
      runId: 'run-1',
      mimeType: 'image/png',
      mediaUrls: ['bb7CGq|v9x5xCZb'],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = useAcpChatSessionStore.getState().timeline;
    const syntheticIds = timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'));
    expect(hostApiMock.mediaThumbnails).toHaveBeenCalledTimes(2);
    expect(syntheticIds).toHaveLength(2);
    expect(new Set(syntheticIds).size).toBe(2);
  });

  it('appends a text fallback when trusted image-generation completion previews cannot be loaded', async () => {
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Background task started for image generation (32aa3a12-a05b-4074-af4e-246cc4a9a303).' } }],
        },
      },
    });
    hostApiMock.mediaThumbnails.mockResolvedValueOnce({
      '/tmp/sky.png': { preview: null, fileSize: 0 },
    });

    hostEventsMock.gatewayChatMessageListener?.({
      message: {
        sessionKey: 'agent:pi:s1',
        runId: 'run-1',
        message: { role: 'toolresult', toolName: 'message', details: { mediaUrls: ['/tmp/sky.png'] } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = useAcpChatSessionStore.getState().timeline;
    const syntheticId = timeline.itemOrder.find((id) => id.startsWith('compat:image-generation:'));
    expect(syntheticId).toBeTruthy();
    expect(timeline.itemsById[syntheticId!]).toMatchObject({
      kind: 'message-segment',
      role: 'assistant',
      parts: [{ kind: 'markdown', text: 'Image generation completed, but the preview could not be loaded.' }],
    });
  });

  it('drops stale image-generation hydrated previews after a session generation changes', async () => {
    const thumbnailDeferred = createDeferred<Record<string, { preview: string | null; fileSize: number }>>();
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo' });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Background task started for image generation (32aa3a12-a05b-4074-af4e-246cc4a9a303).' } }],
        },
      },
    });
    hostApiMock.mediaThumbnails.mockReturnValueOnce(thumbnailDeferred.promise);
    hostEventsMock.gatewayChatMessageListener?.({
      message: {
        sessionKey: 'agent:pi:s1',
        runId: 'run-1',
        message: { role: 'toolresult', toolName: 'message', details: { mediaUrls: ['/tmp/sky.png'] } },
      },
    });

    hostApiMock.loadAcpSession.mockResolvedValueOnce({ success: true, generation: 2 });
    await useAcpChatSessionStore.getState().loadSession({ sessionKey: 'agent:pi:s2', workspaceRoot: '/repo-2', cwd: '/repo-2' });
    thumbnailDeferred.resolve({ '/tmp/sky.png': { preview: 'data:image/png;base64,abc123', fileSize: 67 } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useAcpChatSessionStore.getState()).toMatchObject({ activeSessionKey: 'agent:pi:s2', generation: 2 });
    expect(useAcpChatSessionStore.getState().timeline.itemOrder).toEqual([]);
  });

  it('feeds image-generation and general MEDIA extraction from one history response', async () => {
    const taskId = '32aa3a12-a05b-4074-af4e-246cc4a9a303';
    const history = createDeferred<{ success: true; messages: Array<Record<string, unknown>> }>();
    hostApiMock.sessionsHistory.mockReturnValueOnce(history.promise);
    hostApiMock.resolveAttachment.mockImplementation(async (payload: { ref: { uri: string } }) => {
      const image = payload.ref.uri.endsWith('.png');
      return {
        ok: true,
        identity: image ? 'generated-image-identity' : 'report-identity',
        displayName: image ? 'generated.png' : 'report.pdf',
        mimeType: image ? 'image/png' : 'application/pdf',
        size: image ? 64 : 128,
        target: { kind: 'local', scope: 'workspace', ref: payload.ref },
      };
    });
    hostApiMock.mediaThumbnails.mockResolvedValueOnce({
      'generated-image-identity': { preview: 'data:image/png;base64,generated', fileSize: 64 },
    });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'user_message',
          messageId: 'user-assets',
          content: [{ type: 'text', text: 'Create assets' }],
        },
      },
    });
    history.resolve({
      success: true,
      messages: [
        { role: 'user', id: 'transcript-user', content: 'Create assets' },
        {
          role: 'toolresult',
          toolCallId: 'image-tool',
          toolName: 'image_generate',
          content: `Background task started for image generation (${taskId}).`,
          details: { taskId },
        },
        {
          role: 'assistant',
          id: 'assistant-assets',
          content: 'Assets ready\nMEDIA:/repo/generated.png\nMEDIA:/repo/report.pdf',
        },
      ],
    });

    await vi.waitFor(() => {
      const parts = Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
        .flatMap((item) => item.kind === 'message-segment' ? item.parts : []);
      expect(parts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'image',
          mediaIdentity: 'generated-image-identity',
          attachmentFileRef: expect.objectContaining({
            sessionKey: 'agent:pi:s1',
            generation: 1,
            uri: '/repo/generated.png',
          }),
        }),
        expect.objectContaining({
          kind: 'attachment',
          source: 'openclaw-media',
          reference: expect.objectContaining({ uri: '/repo/report.pdf', transcriptMessageId: 'assistant-assets' }),
          access: expect.objectContaining({ status: 'available', identity: 'report-identity' }),
        }),
      ]));
      const imagePart = parts.find((part) => part.kind === 'image');
      expect(imagePart).not.toHaveProperty('filePath');
      expect(imagePart).not.toHaveProperty('data');
    });
    expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(1);
    expect(hostApiMock.resolveAttachment).toHaveBeenCalledWith(expect.objectContaining({
      ref: expect.objectContaining({ uri: '/repo/generated.png', transcriptMessageId: 'assistant-assets' }),
    }));
    expect(hostApiMock.mediaThumbnails).toHaveBeenCalledWith({
      paths: [{
        attachmentFileRef: expect.objectContaining({ uri: '/repo/generated.png' }),
        key: 'generated-image-identity',
        mimeType: 'image/png',
      }],
    });
    const transcriptTraces = hostApiMock.recordAcpTrace.mock.calls
      .map(([payload]) => payload as { event: string })
      .filter((payload) => payload.event.startsWith('openclaw-media:'));
    expect(transcriptTraces.map((payload) => payload.event)).toEqual(expect.arrayContaining([
      'openclaw-media:history-request-started',
      'openclaw-media:history-request-succeeded',
      'openclaw-media:turn-matched',
      'openclaw-media:resolution-available',
      'openclaw-media:projection-appended',
    ]));
    expect(JSON.stringify(transcriptTraces)).not.toContain('/repo/');
    expect(JSON.stringify(transcriptTraces)).not.toContain('MEDIA:');
  });

  it('recovers historical MEDIA when the ACP user turn contains a resource attachment', async () => {
    const history = createDeferred<{ success: true; messages: Array<Record<string, unknown>> }>();
    hostApiMock.sessionsHistory.mockReturnValueOnce(history.promise);
    const inputPath = 'C:\\Users\\Administrator\\.openclaw\\media\\input.xlsx';
    const outputPath = 'C:\\Users\\Administrator\\.openclaw\\media\\output.xlsx';
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();

    const load = useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: 'C:\\Users\\Administrator\\.openclaw\\workspace', cwd: 'C:\\Users\\Administrator\\.openclaw\\workspace',
    });
    await load;
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      historical: true,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'user_message',
          messageId: 'user-with-resource',
          content: [
            { type: 'text', text: 'Create the report' },
            { type: 'resource_link', uri: inputPath, name: 'input.xlsx' },
          ],
        },
      },
    });
    history.resolve({
      success: true,
      messages: [
        {
          role: 'user',
          content: `[Working directory: C:\\Users\\Administrator\\.openclaw\\workspace]\n\nCreate the report\n[Resource link] ${inputPath}`,
        },
        { role: 'assistant', id: 'assistant-output', content: `Report ready\nMEDIA:${outputPath}` },
      ],
    });

    await vi.waitFor(() => {
      const attachments = Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
        .flatMap((item) => item.kind === 'message-segment' ? item.parts : [])
        .filter((part) => part.kind === 'attachment' && part.source === 'openclaw-media');
      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toMatchObject({
        reference: { uri: outputPath, transcriptMessageId: 'assistant-output' },
        access: { status: 'available' },
      });
    });
  });

  it.each([
    { kind: 'resource', inputPath: '/repo/input.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    { kind: 'image', inputPath: '/repo/input.png', mimeType: 'image/png' },
  ])('recovers live MEDIA for an attachment-only $kind prompt', async ({ kind, inputPath, mimeType }) => {
    const outputPath = `/repo/${kind}-output.pdf`;
    hostApiMock.sessionsHistory.mockResolvedValueOnce({
      success: true,
      messages: [
        {
          role: 'user',
          content: kind === 'resource'
            ? `[Working directory: /repo]\n\n[Resource link] ${inputPath}`
            : '[Working directory: /repo]\n\n',
        },
        { role: 'assistant', id: `${kind}-assistant`, content: `MEDIA:${outputPath}` },
      ],
    });
    const { useAcpChatSessionStore } = await importStore();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
    });

    await expect(useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'agent:pi:s1',
      cwd: '/repo',
      message: '',
      messageId: `${kind}-only-user`,
      media: [{ filePath: inputPath, stagingId: `${kind}-stage`, mimeType }],
    })).resolves.toBe(true);

    await vi.waitFor(() => {
      const attachments = Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
        .flatMap((item) => item.kind === 'message-segment' ? item.parts : [])
        .filter((part) => part.kind === 'attachment' && part.source === 'openclaw-media');
      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toMatchObject({
        reference: { uri: outputPath, transcriptMessageId: `${kind}-assistant` },
        access: { status: 'available' },
      });
    });
    expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(1);
  });

  it('records a reason-coded history failure without transcript content', async () => {
    hostApiMock.sessionsHistory.mockRejectedValueOnce(new Error('history failed for MEDIA:/private/secret.txt'));
    const { useAcpChatSessionStore } = await importStore();

    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const traces = hostApiMock.recordAcpTrace.mock.calls.map(([payload]) => payload as Record<string, unknown>);
    expect(traces).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'openclaw-media:history-request-started' }),
      expect.objectContaining({
        event: 'openclaw-media:history-request-failed',
        details: expect.objectContaining({ reason: 'request-failed' }),
      }),
    ]));
    expect(JSON.stringify(traces)).not.toContain('/private/secret.txt');
  });

  it('upgrades one unavailable MEDIA attachment when unrelated history is evicted before retry', async () => {
    vi.useFakeTimers();
    try {
      const targetMessages = [
        { role: 'user', content: 'Create report' },
        { role: 'assistant', content: 'MEDIA:/repo/report.pdf' },
      ];
      hostApiMock.sessionsHistory
        .mockResolvedValueOnce({
          success: true,
          messages: [
            { role: 'user', content: 'Unrelated prompt' },
            { role: 'assistant', content: 'Unrelated response' },
            ...targetMessages,
          ],
        })
        .mockResolvedValueOnce({ success: true, messages: targetMessages });
      hostApiMock.resolveAttachment
        .mockResolvedValueOnce({ ok: false, displayName: 'report.pdf', error: 'unavailable' })
        .mockResolvedValueOnce({
          ok: true,
          identity: 'report-identity',
          displayName: 'report.pdf',
          mimeType: 'application/pdf',
          size: 128,
          target: {
            kind: 'local',
            scope: 'workspace',
            ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: '/repo/report.pdf' },
          },
        });
      const { useAcpChatSessionStore } = await importStore();
      await useAcpChatSessionStore.getState().loadSession({
        sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
      });
      await useAcpChatSessionStore.getState().sendPrompt({
        sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'Create report', messageId: 'live-user',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
        .flatMap((item) => item.kind === 'message-segment' ? item.parts : []))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: 'attachment', access: { status: 'unavailable', reason: 'unavailable' } }),
        ]));

      await vi.advanceTimersByTimeAsync(1500);
      const attachments = Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
        .flatMap((item) => item.kind === 'message-segment' ? item.parts : [])
        .filter((part) => part.kind === 'attachment');
      expect(attachments).toHaveLength(1);
      expect(attachments).toMatchObject([{
        kind: 'attachment',
        access: { status: 'available', identity: 'report-identity' },
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops an older immediate attachment resolution after the delayed attempt starts', async () => {
    vi.useFakeTimers();
    try {
      const firstResolution = createDeferred<Record<string, unknown>>();
      hostApiMock.sessionsHistory.mockResolvedValue({
        success: true,
        messages: [
          { role: 'user', id: 'transcript-user', content: 'Create report' },
          { role: 'assistant', id: 'transcript-assistant', content: 'MEDIA:/repo/report.pdf' },
        ],
      });
      hostApiMock.resolveAttachment
        .mockReturnValueOnce(firstResolution.promise)
        .mockResolvedValueOnce({
          ok: true,
          identity: 'fresh-report',
          displayName: 'report.pdf',
          mimeType: 'application/pdf',
          size: 128,
          target: {
            kind: 'local',
            scope: 'workspace',
            ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: '/repo/report.pdf' },
          },
        });
      const { useAcpChatSessionStore } = await importStore();
      await useAcpChatSessionStore.getState().loadSession({
        sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
      });
      await useAcpChatSessionStore.getState().sendPrompt({
        sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'Create report', messageId: 'live-user',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1500);
      expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(2);
      firstResolution.resolve({ ok: false, displayName: 'report.pdf', error: 'unavailable' });
      await vi.advanceTimersByTimeAsync(0);

      const attachments = Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
        .flatMap((item) => item.kind === 'message-segment' ? item.parts : [])
        .filter((part) => part.kind === 'attachment');
      expect(attachments).toMatchObject([{ access: { status: 'available', identity: 'fresh-report' } }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the 1500 ms retry supersede a stale image reservation and project once', async () => {
    vi.useFakeTimers();
    try {
      const taskId = '32aa3a12-a05b-4074-af4e-246cc4a9a303';
      const firstResolution = createDeferred<Record<string, unknown>>();
      hostApiMock.sessionsHistory.mockResolvedValue({
        success: true,
        messages: [
          { role: 'user', content: 'Create image' },
          {
            role: 'toolresult',
            toolName: 'image_generate',
            toolCallId: 'image-tool',
            content: `Background task started for image generation (${taskId}).`,
            details: { taskId },
          },
          { role: 'assistant', id: 'image-result', content: 'MEDIA:/repo/generated.png' },
        ],
      });
      hostApiMock.resolveAttachment
        .mockReturnValueOnce(firstResolution.promise)
        .mockResolvedValueOnce({
          ok: true,
          identity: 'generated-identity',
          displayName: 'generated.png',
          mimeType: 'image/png',
          size: 64,
          target: {
            kind: 'local',
            scope: 'workspace',
            ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: '/repo/generated.png' },
          },
        });
      hostApiMock.mediaThumbnails.mockResolvedValue({
        'generated-identity': { preview: 'data:image/png;base64,retry', fileSize: 64 },
      });
      const { useAcpChatSessionStore } = await importStore();
      await useAcpChatSessionStore.getState().loadSession({
        sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
      });
      await useAcpChatSessionStore.getState().sendPrompt({
        sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'Create image', messageId: 'live-user',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1500);
      expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(2);
      firstResolution.resolve({ ok: false, displayName: 'generated.png', error: 'unavailable' });
      await vi.advanceTimersByTimeAsync(0);

      const images = Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
        .flatMap((item) => item.kind === 'message-segment' ? item.parts : [])
        .filter((part) => part.kind === 'image');
      expect(images).toMatchObject([{ source: 'data:image/png;base64,retry', mediaIdentity: 'generated-identity' }]);
      expect(hostApiMock.mediaThumbnails).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a stale transcript supplement steal an active gateway image projection', async () => {
    const taskId = 'a5328d99-76f6-429f-b53f-acde09cf838b';
    const caption = 'The generated product image is ready.';
    const generatedPath = '/repo/generated-product.png';
    const gatewayResolution = createDeferred<Record<string, unknown>>();
    const transcriptResolution = createDeferred<Record<string, unknown>>();
    const resolvedAttachment = {
      ok: true,
      identity: 'generated-product-identity',
      displayName: 'generated-product.png',
      mimeType: 'image/png',
      size: 64,
      target: {
        kind: 'local',
        scope: 'workspace',
        ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: generatedPath },
      },
    };
    hostApiMock.resolveAttachment
      .mockReturnValueOnce(gatewayResolution.promise)
      .mockReturnValueOnce(transcriptResolution.promise);
    hostApiMock.mediaThumbnails.mockResolvedValue({
      'generated-product-identity': { preview: 'data:image/png;base64,product', fileSize: 64 },
    });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool-overlap',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for image generation (${taskId}).`,
            },
          }],
        },
      },
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'agent_message',
          messageId: 'native-image-overlap-reply',
          content: [{ type: 'text', text: caption }],
        },
      },
    });
    const evidence = {
      sessionKey: 'agent:pi:s1',
      taskId,
      source: 'gateway-chat-message' as const,
      evidenceId: 'gateway-image-overlap',
      caption,
      authoritativeCaption: true,
      candidates: [{ key: generatedPath, filePath: generatedPath, mimeType: 'image/png' }],
    };

    const gatewayProjection = useAcpChatSessionStore.getState().projectImageGenerationCompletion(evidence);
    await vi.waitFor(() => expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(1));
    let transcriptCurrent = true;
    const transcriptProjection = useAcpChatSessionStore.getState().projectImageGenerationCompletion(
      { ...evidence, source: 'transcript-history', evidenceId: 'transcript-image-overlap' },
      {
        reservationOwner: 'transcript:overlap:1',
        isCurrent: () => transcriptCurrent,
        staleReason: 'stale-transcript-supplement',
      },
    );
    await Promise.resolve();
    transcriptCurrent = false;
    transcriptResolution.resolve(resolvedAttachment);
    await transcriptProjection;
    gatewayResolution.resolve(resolvedAttachment);
    await gatewayProjection;

    expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(1);
    const timeline = useAcpChatSessionStore.getState().timeline;
    const captionItems = timeline.itemOrder
      .map((id) => timeline.itemsById[id])
      .filter((item) => item?.kind === 'message-segment'
        && item.role === 'assistant'
        && item.parts.some((part) => part.kind === 'markdown' && part.text === caption));
    expect(captionItems).toHaveLength(1);
    expect(timeline.itemsById['native-image-overlap-reply:0']).toMatchObject({
      parts: [
        { kind: 'markdown', text: caption },
        { kind: 'image', source: 'data:image/png;base64,product' },
      ],
    });
    expect(timeline.itemOrder.filter((id) => id.startsWith('compat:image-generation:'))).toEqual([]);
  });

  it('does not replay an older image-generation turn during a live non-image supplement', async () => {
    vi.useFakeTimers();
    try {
      const taskId = '32aa3a12-a05b-4074-af4e-246cc4a9a303';
      hostApiMock.sessionsHistory.mockResolvedValue({
        success: true,
        messages: [
          { role: 'user', content: 'Create old image' },
          {
            role: 'toolresult',
            toolName: 'image_generate',
            content: `Background task started for image generation (${taskId}).`,
            details: { taskId },
          },
          { role: 'assistant', id: 'old-image', content: 'MEDIA:/repo/old.png' },
          { role: 'user', content: 'Create current report' },
          { role: 'assistant', id: 'current-report', content: 'MEDIA:/repo/current.pdf' },
        ],
      });
      hostApiMock.resolveAttachment.mockImplementation(async (payload: { ref: { uri: string } }) => ({
        ok: true,
        identity: `identity:${payload.ref.uri}`,
        displayName: payload.ref.uri.split('/').pop() ?? 'file',
        mimeType: payload.ref.uri.endsWith('.png') ? 'image/png' : 'application/pdf',
        size: 64,
        target: { kind: 'local', scope: 'workspace', ref: payload.ref },
      }));
      const { useAcpChatSessionStore } = await importStore();
      await useAcpChatSessionStore.getState().loadSession({
        sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
      });
      await useAcpChatSessionStore.getState().sendPrompt({
        sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'Create current report', messageId: 'live-user',
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(hostApiMock.resolveAttachment).not.toHaveBeenCalledWith(expect.objectContaining({
        ref: expect.objectContaining({ uri: '/repo/old.png' }),
      }));
      expect(hostApiMock.resolveAttachment).toHaveBeenCalledWith(expect.objectContaining({
        ref: expect.objectContaining({ uri: '/repo/current.pdf' }),
      }));
      expect(useAcpChatSessionStore.getState().timeline.itemOrder
        .filter((id) => id.startsWith('compat:image-generation:'))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['resolver', 'thumbnail'] as const)(
    'releases an image reservation after a %s error so the same evidence can retry',
    async (failure) => {
      const evidence = {
        sessionKey: 'agent:pi:s1',
        source: 'gateway-chat-message' as const,
        evidenceId: `retry-after-${failure}`,
        caption: '',
        candidates: [{ key: '/repo/retry.png', filePath: '/repo/retry.png', mimeType: 'image/png' }],
      };
      if (failure === 'resolver') {
        hostApiMock.resolveAttachment
          .mockRejectedValueOnce(new Error('resolve failed'))
          .mockResolvedValueOnce({
            ok: true,
            identity: 'retry-identity',
            displayName: 'retry.png',
            mimeType: 'image/png',
            size: 64,
            target: {
              kind: 'local', scope: 'workspace',
              ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: '/repo/retry.png' },
            },
          });
      } else {
        hostApiMock.resolveAttachment.mockResolvedValue({
          ok: true,
          identity: 'retry-identity',
          displayName: 'retry.png',
          mimeType: 'image/png',
          size: 64,
          target: {
            kind: 'local', scope: 'workspace',
            ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: '/repo/retry.png' },
          },
        });
        hostApiMock.mediaThumbnails.mockRejectedValueOnce(new Error('thumbnail failed'));
      }
      hostApiMock.mediaThumbnails.mockResolvedValueOnce({
        'retry-identity': { preview: 'data:image/png;base64,retried', fileSize: 64 },
      });
      const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
      ensureAcpChatSubscriptions();
      await useAcpChatSessionStore.getState().loadSession({
        sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
      });
      hostEventsMock.updateListener?.({
        sessionKey: 'agent:pi:s1',
        generation: 1,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'image-tool',
            content: [{ type: 'content', content: { type: 'text', text: 'Background task started for image generation (32aa3a12-a05b-4074-af4e-246cc4a9a303).' } }],
          },
        },
      });

      await useAcpChatSessionStore.getState().projectImageGenerationCompletion(evidence);
      await useAcpChatSessionStore.getState().projectImageGenerationCompletion(evidence);

      const images = Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
        .flatMap((item) => item.kind === 'message-segment' ? item.parts : [])
        .filter((part) => part.kind === 'image');
      expect(images).toMatchObject([{ source: 'data:image/png;base64,retried' }]);
      expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(2);
    },
  );

  it('releases an image reservation when resolution returns after a stale generation', async () => {
    const resolution = createDeferred<Record<string, unknown>>();
    hostApiMock.resolveAttachment
      .mockReturnValueOnce(resolution.promise)
      .mockResolvedValueOnce({
        ok: true,
        identity: 'fresh-generation-image',
        displayName: 'fresh.png',
        mimeType: 'image/png',
        size: 64,
        target: {
          kind: 'local', scope: 'workspace',
          ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: '/repo/fresh.png' },
        },
      });
    hostApiMock.mediaThumbnails.mockResolvedValue({
      'fresh-generation-image': { preview: 'data:image/png;base64,fresh', fileSize: 64 },
    });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1', generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update', toolCallId: 'image-tool',
          content: [{ type: 'content', content: { type: 'text', text: 'Background task started for image generation (32aa3a12-a05b-4074-af4e-246cc4a9a303).' } }],
        },
      },
    });
    const evidence = {
      sessionKey: 'agent:pi:s1',
      source: 'gateway-chat-message' as const,
      evidenceId: 'stale-generation-retry',
      caption: '',
      candidates: [{ key: '/repo/fresh.png', filePath: '/repo/fresh.png', mimeType: 'image/png' }],
    };

    const staleProjection = useAcpChatSessionStore.getState().projectImageGenerationCompletion(evidence);
    await vi.waitFor(() => expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(1));
    useAcpChatSessionStore.setState({ generation: 2 });
    resolution.resolve({ ok: false, displayName: 'fresh.png', error: 'staleSession' });
    await staleProjection;
    useAcpChatSessionStore.setState({ generation: 1 });
    await useAcpChatSessionStore.getState().projectImageGenerationCompletion(evidence);

    expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(2);
    expect(Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
      .flatMap((item) => item.kind === 'message-segment' ? item.parts : [])
      .filter((part) => part.kind === 'image')).toMatchObject([
      { source: 'data:image/png;base64,fresh', mediaIdentity: 'fresh-generation-image' },
    ]);
  });

  it('requests a live transcript immediately and retries exactly once at 1500 ms', async () => {
    vi.useFakeTimers();
    try {
      const { useAcpChatSessionStore } = await importStore();
      await useAcpChatSessionStore.getState().loadSession({
        sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
      });

      await useAcpChatSessionStore.getState().sendPrompt({
        sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'Create report', messageId: 'live-user',
      });

      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1499);
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not inherit image polling for an ordinary prompt after a recent image task', async () => {
    vi.useFakeTimers();
    try {
      const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
      ensureAcpChatSubscriptions();
      await useAcpChatSessionStore.getState().loadSession({
        sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
      });
      hostEventsMock.updateListener?.({
        sessionKey: 'agent:pi:s1',
        generation: 1,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'old-image-tool',
            content: [{
              type: 'content',
              content: {
                type: 'text',
                text: 'Background task started for image generation (3c16cb82-0408-46d5-ae84-7fc9fd241107).',
              },
            }],
          },
        },
      });

      await useAcpChatSessionStore.getState().sendPrompt({
        sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'Summarize this file', messageId: 'ordinary-user',
      });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps polling a recorded image task until its live transcript completion appears', async () => {
    vi.useFakeTimers();
    try {
      const taskId = '0d2ee919-2dfd-4b72-9da3-d87e6ee56747';
      const prompt = createDeferred<{ success: true }>();
      const pendingMessages = [
        { role: 'user', content: '生成一张小猫图' },
        {
          role: 'toolresult',
          toolCallId: 'image-tool',
          toolName: 'image_generate',
          content: `Background task started for image generation (${taskId}).`,
          details: { taskId },
        },
      ];
      hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
      hostApiMock.sessionsHistory
        .mockResolvedValueOnce({ success: true, messages: pendingMessages })
        .mockResolvedValueOnce({ success: true, messages: pendingMessages })
        .mockResolvedValueOnce({
          success: true,
          messages: [
            ...pendingMessages,
            {
              role: 'user',
              content: `[Inter-session message] sourceSession=image_generate:${taskId} sourceChannel=webchat sourceTool=image_generate isUser=false\n[Internal task completion event]\nstatus: failed`,
            },
            {
              role: 'assistant',
              id: 'kitten-failure-live',
              content: '抱歉，这次小猫图生成失败了：当前图像生成模型通道不可用。',
            },
          ],
        });
      const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
      ensureAcpChatSubscriptions();
      await useAcpChatSessionStore.getState().loadSession({
        sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
      });

      const send = useAcpChatSessionStore.getState().sendPrompt({
        sessionKey: 'agent:pi:s1', cwd: '/repo', message: '生成一张小猫图', messageId: 'live-image-user',
      });
      hostEventsMock.updateListener?.({
        sessionKey: 'agent:pi:s1',
        generation: 1,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'image-tool',
            status: 'completed',
            content: [{
              type: 'content',
              content: {
                type: 'text',
                text: `Background task started for image generation (${taskId}).`,
              },
            }],
          },
        },
      });
      prompt.resolve({ success: true });
      await send;
      await vi.advanceTimersByTimeAsync(0);
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1500);
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3000);
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(3);

      const timeline = useAcpChatSessionStore.getState().timeline;
      const completion = timeline.itemOrder
        .map((id) => timeline.itemsById[id])
        .find((item) => item?.kind === 'message-segment' && item.compat?.source === 'image-generation');
      expect(completion).toMatchObject({
        role: 'assistant',
        parts: [{
          kind: 'markdown',
          text: '抱歉，这次小猫图生成失败了：当前图像生成模型通道不可用。',
        }],
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps polling a successful image task until its transcript includes the media artifact', async () => {
    vi.useFakeTimers();
    try {
      const taskId = 'd153f131-a264-4a08-bc6e-641584ebc4af';
      const imagePath = '/tmp/generated-puppy.png';
      const pendingMessages = [
        { role: 'user', content: '生成一张小狗图' },
        {
          role: 'toolresult',
          toolCallId: 'image-tool',
          toolName: 'image_generate',
          content: `Background task started for image generation (${taskId}).`,
          details: { taskId },
        },
      ];
      const completionTrigger = {
        role: 'user',
        content: `[Inter-session message] sourceSession=image_generate:${taskId} sourceChannel=webchat sourceTool=image_generate isUser=false\n[Internal task completion event]\nstatus: completed successfully`,
      };
      hostApiMock.sessionsHistory
        .mockResolvedValueOnce({ success: true, messages: pendingMessages })
        .mockResolvedValueOnce({ success: true, messages: pendingMessages })
        .mockResolvedValueOnce({
          success: true,
          messages: [
            ...pendingMessages,
            completionTrigger,
            { role: 'assistant', id: 'puppy-success', content: '生成好了 🐶' },
          ],
        })
        .mockResolvedValueOnce({
          success: true,
          messages: [
            ...pendingMessages,
            completionTrigger,
            { role: 'assistant', id: 'puppy-success', content: `生成好了 🐶\n\nMEDIA:${imagePath}` },
          ],
        });
      hostApiMock.mediaThumbnails.mockResolvedValue({
        [imagePath]: { preview: 'data:image/png;base64,puppy', fileSize: 42 },
      });
      const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
      ensureAcpChatSubscriptions();
      await useAcpChatSessionStore.getState().loadSession({
        sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
      });
      await useAcpChatSessionStore.getState().sendPrompt({
        sessionKey: 'agent:pi:s1', cwd: '/repo', message: '生成一张小狗图', messageId: 'live-image-user',
      });
      hostEventsMock.updateListener?.({
        sessionKey: 'agent:pi:s1',
        generation: 1,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'image-tool',
            status: 'completed',
            content: [{
              type: 'content',
              content: {
                type: 'text',
                text: `Background task started for image generation (${taskId}).`,
              },
            }],
          },
        },
      });

      await vi.advanceTimersByTimeAsync(1500);
      await vi.advanceTimersByTimeAsync(3000);
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(3);
      expect(hostApiMock.resolveAttachment).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(4);
      expect(hostApiMock.resolveAttachment).toHaveBeenCalledWith(expect.objectContaining({
        ref: expect.objectContaining({ uri: imagePath }),
      }));
      expect(Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
        .flatMap((item) => item.kind === 'message-segment' ? item.parts : [])
        .filter((part) => part.kind === 'image')).toMatchObject([
        { source: 'data:image/png;base64,puppy', mediaIdentity: imagePath },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops live transcript polling when a Gateway image completion is accepted', async () => {
    vi.useFakeTimers();
    try {
      const taskId = '28bac848-e485-48b8-a775-2c341b381266';
      const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
      ensureAcpChatSubscriptions();
      await useAcpChatSessionStore.getState().loadSession({
        sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
      });
      await useAcpChatSessionStore.getState().sendPrompt({
        sessionKey: 'agent:pi:s1', cwd: '/repo', message: '生成一张小狗图', messageId: 'live-image-user',
      });
      hostEventsMock.updateListener?.({
        sessionKey: 'agent:pi:s1',
        generation: 1,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'image-tool',
            status: 'completed',
            content: [{
              type: 'content',
              content: {
                type: 'text',
                text: `Background task started for image generation (${taskId}).`,
              },
            }],
          },
        },
      });

      await useAcpChatSessionStore.getState().projectImageGenerationCompletion({
        sessionKey: 'agent:pi:s1',
        taskId,
        source: 'gateway-chat-message',
        evidenceId: 'gateway-image-failure',
        caption: 'Image generation failed because no image model is available.',
        authoritativeCaption: true,
        candidates: [],
      });
      hostEventsMock.updateListener?.({
        sessionKey: 'agent:pi:s1',
        generation: 1,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'image-tool',
            status: 'completed',
            content: [{
              type: 'content',
              content: {
                type: 'text',
                text: `Background task started for image generation (${taskId}).`,
              },
            }],
          },
        },
      });

      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start transcript polling when an image completion arrives before the prompt resolves', async () => {
    vi.useFakeTimers();
    try {
      const taskId = 'db0b0475-8fa2-49b9-a989-d387480008fa';
      const prompt = createDeferred<{ success: true }>();
      hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
      const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
      ensureAcpChatSubscriptions();
      await useAcpChatSessionStore.getState().loadSession({
        sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
      });
      const send = useAcpChatSessionStore.getState().sendPrompt({
        sessionKey: 'agent:pi:s1', cwd: '/repo', message: '生成一张小猫图', messageId: 'live-image-user',
      });
      hostEventsMock.updateListener?.({
        sessionKey: 'agent:pi:s1',
        generation: 1,
        notification: {
          sessionId: 'agent:pi:s1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'image-tool',
            content: [{
              type: 'content',
              content: {
                type: 'text',
                text: `Background task started for image generation (${taskId}).`,
              },
            }],
          },
        },
      });
      await useAcpChatSessionStore.getState().projectImageGenerationCompletion({
        sessionKey: 'agent:pi:s1',
        taskId,
        source: 'gateway-chat-message',
        evidenceId: 'early-gateway-image-failure',
        caption: 'Image generation failed because no image model is available.',
        authoritativeCaption: true,
        candidates: [],
      });

      prompt.resolve({ success: true });
      await send;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(hostApiMock.sessionsHistory).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['new-prompt', 'cancel', 'load', 'session-switch', 'generation-change'] as const)(
    'invalidates the pending live transcript retry on %s',
    async (invalidation) => {
      vi.useFakeTimers();
      try {
        const { useAcpChatSessionStore } = await importStore();
        await useAcpChatSessionStore.getState().loadSession({
          sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
        });
        await useAcpChatSessionStore.getState().sendPrompt({
          sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'First', messageId: 'first-user',
        });
        expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(1);

        if (invalidation === 'new-prompt') {
          await useAcpChatSessionStore.getState().sendPrompt({
            sessionKey: 'agent:pi:s1', cwd: '/repo', message: 'Second', messageId: 'second-user',
          });
        } else if (invalidation === 'cancel') {
          await useAcpChatSessionStore.getState().cancel();
        } else if (invalidation === 'load') {
          await useAcpChatSessionStore.getState().loadSession({
            sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
          });
        } else if (invalidation === 'session-switch') {
          useAcpChatSessionStore.getState().prepareLocalSession({
            sessionKey: 'agent:pi:s2', workspaceRoot: '/repo-2', cwd: '/repo-2', createIfMissing: true,
          });
        } else {
          useAcpChatSessionStore.setState((state) => ({ generation: state.generation + 1 }));
        }

        await vi.advanceTimersByTimeAsync(1500);
        expect(hostApiMock.sessionsHistory).toHaveBeenCalledTimes(invalidation === 'new-prompt' ? 3 : 1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('resolves structured image evidence through Main and stores the opaque media identity', async () => {
    hostApiMock.resolveAttachment.mockResolvedValue({
      ok: true,
      identity: 'opaque-generated-image',
      displayName: 'sky.png',
      mimeType: 'image/png',
      size: 64,
      target: {
        kind: 'local',
        scope: 'openclaw-media',
        ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: 'file:///repo/sky.png' },
      },
    });
    hostApiMock.mediaThumbnails.mockResolvedValueOnce({
      'opaque-generated-image': { preview: 'data:image/png;base64,sky', fileSize: 64 },
    });
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'agent:pi:s1', workspaceRoot: '/repo', cwd: '/repo', createIfMissing: true,
    });
    hostEventsMock.updateListener?.({
      sessionKey: 'agent:pi:s1',
      generation: 1,
      notification: {
        sessionId: 'agent:pi:s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: 'Background task started for image generation (32aa3a12-a05b-4074-af4e-246cc4a9a303).',
            },
          }],
        },
      },
    });
    hostEventsMock.gatewayChatMessageListener?.({
      message: {
        sessionKey: 'agent:pi:s1',
        runId: 'run-image',
        message: {
          role: 'assistant',
          _attachedFiles: [
            { filePath: 'file:///repo/sky.png', mimeType: 'image/png' },
            { filePath: '/repo/sky.png', mimeType: 'image/png' },
          ],
        },
      },
    });

    await vi.waitFor(() => {
      const image = Object.values(useAcpChatSessionStore.getState().timeline.itemsById)
        .flatMap((item) => item.kind === 'message-segment' ? item.parts : [])
        .find((part) => part.kind === 'image');
      expect(image).toMatchObject({ mediaIdentity: 'opaque-generated-image' });
    });
    expect(hostApiMock.resolveAttachment).toHaveBeenCalledWith({
      ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: 'file:///repo/sky.png' },
      mimeType: 'image/png',
    });
    expect(hostApiMock.resolveAttachment).toHaveBeenCalledTimes(2);
    expect(hostApiMock.mediaThumbnails).toHaveBeenCalledWith({
      paths: [{
        attachmentFileRef: { sessionKey: 'agent:pi:s1', generation: 1, uri: 'file:///repo/sky.png' },
        key: 'opaque-generated-image',
        mimeType: 'image/png',
      }],
    });
  });
});
