import { describe, expect, it } from 'vitest';

import { buildRuntimeProgressEvents } from '@/stores/chat/runtime-progress';

describe('buildRuntimeProgressEvents', () => {
  it('skips renderer-derived tool progress when native progress already exists for the tool call', () => {
    const events = buildRuntimeProgressEvents({
      progressEntries: [
        {
          id: 'progress:native:tool:call-1',
          kind: 'action',
          text: '正在执行',
          status: 'running',
          toolCallId: 'call-1',
          source: 'native',
        },
      ],
    } as any, {
      contractVersion: 1,
      producer: 'gateway',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      type: 'tool.started',
      toolCallId: 'call-1',
      name: 'read',
      args: { path: '/tmp/capabilities.md' },
    });

    expect(events).toEqual([]);
  });

  it('still derives tool progress when there is no native progress for the tool call', () => {
    const events = buildRuntimeProgressEvents(undefined, {
      contractVersion: 1,
      producer: 'gateway',
      runId: 'run-2',
      sessionKey: 'agent:main:main',
      type: 'tool.started',
      toolCallId: 'call-2',
      name: 'read',
      args: { path: '/tmp/capabilities.md' },
    });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'progress.update',
        entry: expect.objectContaining({
          id: 'progress:tool:call-2:commentary',
          kind: 'commentary',
          text: '我先查看相关内容。',
          toolCallId: 'call-2',
          source: 'derived',
        }),
      }),
      expect.objectContaining({
        type: 'progress.update',
        entry: expect.objectContaining({
          id: 'progress:tool:call-2',
          kind: 'action',
          text: '正在读取相关内容',
          status: 'running',
          toolCallId: 'call-2',
          source: 'derived',
        }),
      }),
    ]));
  });
});
