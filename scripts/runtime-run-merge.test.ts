import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { AttachedFileMeta, ChatRuntimeRunState, RawMessage } from '../src/stores/chat/types.ts';
import {
  mergeRuntimeRunStates,
  runtimeRunsShareTaskIdentity,
} from '../src/pages/Chat/runtime-run-merge.ts';

const sessionKey = 'agent:main:session-merge';
let dedupeAssistantRepliesForDisplay: (messages: RawMessage[]) => RawMessage[];
let closeChatStoreModule: (() => Promise<void>) | undefined;

before(async () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() { return storage.size; },
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, String(value)),
    },
  });

  const { createServer } = await import('vite');
  const server = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  const chatStore = await server.ssrLoadModule('/src/stores/chat.ts') as {
    dedupeAssistantRepliesForDisplay: (messages: RawMessage[]) => RawMessage[];
  };
  dedupeAssistantRepliesForDisplay = chatStore.dedupeAssistantRepliesForDisplay;
  closeChatStoreModule = async () => server.close();
});

after(async () => {
  await closeChatStoreModule?.();
});

function videoAttachment(filePath: string, fileSize = 0): AttachedFileMeta {
  return {
    fileName: 'night-market.mp4',
    mimeType: 'video/mp4',
    fileSize,
    preview: null,
    filePath,
    source: fileSize > 0 ? 'tool-result' : 'message-ref',
  };
}

function run(
  runId: string,
  status: ChatRuntimeRunState['status'],
  lastEventAt: number,
): ChatRuntimeRunState {
  return {
    runId,
    sessionKey,
    status,
    lastEventAt,
    assistantText: '',
    thinkingText: '',
    events: [],
  };
}

test('same-turn assistant replies with the same normalized media attachment collapse to one card', () => {
  const videoPath = '/Users/me/.openclaw/media/outbound/night-market.mp4';
  const messages: RawMessage[] = [
    {
      id: 'user-video',
      role: 'user',
      content: '根据上面的图片生成视频',
      timestamp: 100,
    },
    {
      id: 'assistant-video-1',
      role: 'assistant',
      content: `本地视频已生成。\n\nMEDIA:${videoPath}`,
      timestamp: 200,
      _attachedFiles: [videoAttachment('/Users/me/.openclaw/media/outbound/./night-market.mp4')],
    },
    {
      id: 'assistant-video-2',
      role: 'assistant',
      content: `本地视频已生成并完成编码验证，时长 8 秒，分辨率 1280x720。\n\nMEDIA:${videoPath}`,
      timestamp: 300,
      _attachedFiles: [videoAttachment(videoPath, 6_105_942)],
    },
    {
      id: 'assistant-video-3',
      role: 'assistant',
      content: `视频文件已确认存在。\n\nMEDIA:${videoPath}`,
      timestamp: 400,
    },
  ];

  const deduped = dedupeAssistantRepliesForDisplay(messages);

  assert.equal(deduped.length, 2);
  const reply = deduped[1]!;
  assert.equal(reply.id, 'assistant-video-3');
  assert.equal(reply.timestamp, 400);
  assert.match(String(reply.content), /完成编码验证/);
  assert.equal(reply._attachedFiles?.length, 1);
  assert.equal(reply._attachedFiles?.[0]?.filePath, videoPath);
  assert.equal(reply._attachedFiles?.[0]?.fileSize, 6_105_942);
});

test('same-turn assistant replies with different media attachments remain separate', () => {
  const firstPath = '/Users/me/.openclaw/media/outbound/first.mp4';
  const secondPath = '/Users/me/.openclaw/media/outbound/second.mp4';
  const messages: RawMessage[] = [
    { id: 'user-two-videos', role: 'user', content: '生成两个视频', timestamp: 100 },
    {
      id: 'assistant-first-video',
      role: 'assistant',
      content: `第一个视频。\n\nMEDIA:${firstPath}`,
      timestamp: 200,
      _attachedFiles: [videoAttachment(firstPath, 100)],
    },
    {
      id: 'assistant-second-video',
      role: 'assistant',
      content: `第二个视频。\n\nMEDIA:${secondPath}`,
      timestamp: 300,
      _attachedFiles: [videoAttachment(secondPath, 200)],
    },
  ];

  const deduped = dedupeAssistantRepliesForDisplay(messages);

  assert.equal(deduped.length, 3);
  assert.equal(deduped[1]?.id, 'assistant-first-video');
  assert.equal(deduped[2]?.id, 'assistant-second-video');
});

test('terminal task evidence wins over a later-loaded pending history alias', () => {
  const historyRun = run('history:session:message-1', 'completed', 20);
  historyRun.turnContract = {
    version: 1,
    intent: 'media',
    toolRequirement: 'required',
    sideEffect: 'remote_generation',
    sideEffectAuthorized: true,
    acceptance: {
      requiresArtifact: true,
      requiresVerification: true,
      requiresApproval: false,
      requiresToolEvidence: true,
    },
  };
  historyRun.asyncTaskLedger = {
    'child:video': {
      id: 'child:video',
      taskId: 'video-task-1',
      runId: 'tool:video_generate:1',
      status: 'pending',
      source: 'tool-result',
      updatedAt: 20,
    },
  };

  const taskRun = run('tool:video_generate:1', 'completed', 30);
  taskRun.tasks = [{
    taskId: 'video-task-1',
    runtime: 'video_generate',
    title: 'Generate video',
    status: 'completed',
    updatedAt: 30,
    endedAt: 30,
  }];
  taskRun.asyncTaskLedger = {
    'task:video-task-1': {
      id: 'task:video-task-1',
      taskId: 'video-task-1',
      runId: 'tool:video_generate:1',
      status: 'completed',
      source: 'task-completion',
      updatedAt: 30,
    },
  };

  assert.equal(runtimeRunsShareTaskIdentity(historyRun, taskRun), true);
  const forward = mergeRuntimeRunStates('segment:message-1', sessionKey, [historyRun, taskRun]);
  const reverse = mergeRuntimeRunStates('segment:message-1', sessionKey, [taskRun, historyRun]);

  for (const merged of [forward, reverse]) {
    assert.equal(merged?.status, 'completed');
    assert.equal(merged?.turnContract?.intent, 'media');
    assert.equal(merged?.tasks?.[0]?.status, 'completed');
    assert.equal(Object.keys(merged?.asyncTaskLedger ?? {}).length, 1);
    assert.equal(Object.values(merged?.asyncTaskLedger ?? {})[0]?.status, 'completed');
    assert.equal(Object.values(merged?.asyncTaskLedger ?? {})[0]?.updatedAt, 30);
  }
});

test('unrelated task aliases never merge by session alone', () => {
  const first = run('history:session:message-1', 'completed', 20);
  first.asyncTaskLedger = {
    first: {
      id: 'first',
      taskId: 'task-first',
      status: 'completed',
      source: 'task-completion',
      updatedAt: 20,
    },
  };
  const second = run('tool:other', 'completed', 30);
  second.tasks = [{
    taskId: 'task-second',
    title: 'Other task',
    status: 'completed',
    updatedAt: 30,
  }];

  assert.equal(runtimeRunsShareTaskIdentity(first, second), false);
});

test('native media tasks in one requester session do not merge through childSessionKey', () => {
  const imageRun = run('history:session:image-message', 'completed', 20);
  imageRun.asyncTaskLedger = {
    image: {
      id: 'task:image-task',
      taskId: 'image-task',
      childSessionKey: sessionKey,
      status: 'completed',
      source: 'task-completion',
      updatedAt: 20,
    },
  };

  const videoRun = run('tool:video_generate:failed', 'error', 30);
  videoRun.tasks = [{
    taskId: 'video-task',
    runtime: 'video_generate',
    title: 'Generate video',
    childSessionKey: sessionKey,
    status: 'error',
    detail: 'provider unavailable',
    updatedAt: 30,
    endedAt: 30,
  }];

  assert.equal(runtimeRunsShareTaskIdentity(imageRun, videoRun), false);
});

test('a distinct child agent session remains a valid task identity alias', () => {
  const ownerRun = run('run-owner', 'completed', 20);
  ownerRun.asyncTaskLedger = {
    child: {
      id: 'child:agent:researcher:session-child',
      childSessionKey: 'agent:researcher:session-child',
      status: 'completed',
      source: 'task-completion',
      updatedAt: 20,
    },
  };

  const childRun = run('run-child', 'completed', 30);
  childRun.tasks = [{
    taskId: 'research-task',
    runtime: 'subagent',
    title: 'Research',
    childSessionKey: 'agent:researcher:session-child',
    status: 'completed',
    updatedAt: 30,
    endedAt: 30,
  }];

  assert.equal(runtimeRunsShareTaskIdentity(ownerRun, childRun), true);
});

test('a terminal task error makes the merged user turn terminal error', () => {
  const mainRun = run('run-main', 'completed', 20);
  const taskRun = run('tool:video_generate:failed', 'error', 30);
  taskRun.tasks = [{
    taskId: 'video-task-failed',
    title: 'Generate video',
    status: 'error',
    detail: 'provider unavailable',
    updatedAt: 30,
    endedAt: 30,
  }];

  const merged = mergeRuntimeRunStates('segment:failed', sessionKey, [mainRun, taskRun]);
  assert.equal(merged?.status, 'error');
  assert.equal(merged?.tasks?.[0]?.detail, 'provider unavailable');
});
