import { describe, expect, it } from 'vitest';
import {
  getSubagentToolGroupProgress,
  groupConsecutiveToolCalls,
  isToolCallGroupActive,
} from '@/lib/acp/tool-call-groups';
import type { ChatSession } from '@/stores/chat/types';
import type {
  MessageSegmentItem,
  PermissionItem,
  PlanItem,
  ThoughtItem,
  TimelineItem,
  ToolCallItem,
} from '@/lib/acp/timeline-types';

function tool(id: string): ToolCallItem {
  return {
    kind: 'tool-call',
    id: `tool:${id}`,
    toolCallId: id,
    title: `Tool ${id}`,
    status: 'completed',
    outputParts: [],
    locations: [],
  };
}

const assistantMessage: MessageSegmentItem = {
  kind: 'message-segment',
  id: 'message:assistant:0',
  role: 'assistant',
  messageId: 'message:assistant',
  segmentIndex: 0,
  parts: [{ kind: 'markdown', text: 'Continue.' }],
};

const thought: ThoughtItem = {
  kind: 'thought',
  id: 'thought:one',
  messageId: 'thought-message',
  parts: [{ kind: 'markdown', text: 'Thinking.' }],
};

const plan: PlanItem = {
  kind: 'plan',
  id: 'plan:one',
  entries: [],
};

const permission: PermissionItem = {
  kind: 'permission',
  id: 'permission:one',
  requestId: 'request:one',
  title: 'Approve command',
  options: [],
  status: 'pending',
};

describe('groupConsecutiveToolCalls', () => {
  it('groups two consecutive tool calls', () => {
    const toolA = tool('a');
    const toolB = tool('b');

    expect(groupConsecutiveToolCalls([toolA, toolB])).toEqual([
      {
        kind: 'tool-call-group',
        id: 'tool-call-group:tool:a',
        items: [toolA, toolB],
      },
    ]);
  });

  it('keeps a single tool call as a timeline item', () => {
    const toolA = tool('a');

    expect(groupConsecutiveToolCalls([toolA])).toEqual([
      { kind: 'timeline-item', item: toolA },
    ]);
  });

  it('keeps a single subagent spawn as a persistent task group', () => {
    const spawn = { ...tool('spawn'), title: 'sessions_spawn: task: research' };

    expect(groupConsecutiveToolCalls([spawn])).toEqual([{
      kind: 'tool-call-group',
      id: 'tool-call-group:tool:spawn',
      items: [spawn],
    }]);
  });

  it.each([
    ['message', assistantMessage],
    ['thought', thought],
    ['plan', plan],
    ['permission', permission],
  ] as Array<[string, TimelineItem]>)('uses %s items as group boundaries', (_label, boundary) => {
    const toolA = tool('a');
    const toolB = tool('b');

    expect(groupConsecutiveToolCalls([toolA, boundary, toolB])).toEqual([
      { kind: 'timeline-item', item: toolA },
      { kind: 'timeline-item', item: boundary },
      { kind: 'timeline-item', item: toolB },
    ]);
  });

  it('creates separate groups on opposite sides of a non-tool item', () => {
    const toolA = tool('a');
    const toolB = tool('b');
    const toolC = tool('c');
    const toolD = tool('d');

    expect(groupConsecutiveToolCalls([toolA, toolB, thought, toolC, toolD])).toEqual([
      {
        kind: 'tool-call-group',
        id: 'tool-call-group:tool:a',
        items: [toolA, toolB],
      },
      { kind: 'timeline-item', item: thought },
      {
        kind: 'tool-call-group',
        id: 'tool-call-group:tool:c',
        items: [toolC, toolD],
      },
    ]);
  });

  it('keeps the group id stable when a streaming tool call is appended', () => {
    const toolA = tool('a');
    const toolB = tool('b');
    const initialGroup = groupConsecutiveToolCalls([toolA, toolB])[0];
    const appendedGroup = groupConsecutiveToolCalls([toolA, toolB, tool('c')])[0];

    expect(initialGroup).toMatchObject({ id: 'tool-call-group:tool:a' });
    expect(appendedGroup).toMatchObject({ id: 'tool-call-group:tool:a' });
  });
});

describe('getSubagentToolGroupProgress', () => {
  const items: ToolCallItem[] = [
    { ...tool('spawn-a'), title: 'sessions_spawn: task: research A' },
    { ...tool('spawn-b'), title: 'sessions_spawn: task: research B' },
    {
      ...tool('yield'),
      title: 'sessions_yield: message: wait',
      outputParts: [{ kind: 'markdown', text: '{"status":"yielded","message":"wait"}' }],
    },
  ];
  const childSessions: ChatSession[] = [
    {
      key: 'agent:main:subagent:child-a',
      kind: 'subagent',
      parentSessionKey: 'agent:main:parent',
      subagentRunState: 'done',
      hasActiveSubagentRun: false,
    },
    {
      key: 'agent:main:subagent:child-b',
      kind: 'subagent',
      parentSessionKey: 'agent:main:parent',
      subagentRunState: 'running',
      hasActiveSubagentRun: true,
    },
  ];

  it('keeps a yielded parent turn active while one child is still running', () => {
    expect(getSubagentToolGroupProgress({
      items,
      parentSessionKey: 'agent:main:parent',
      subagentSessions: childSessions,
      hasFollowingContent: false,
    })).toEqual({ phase: 'waiting', total: 2, completed: 1 });
  });

  it('does not complete while a child is still running even if parent content follows', () => {
    expect(getSubagentToolGroupProgress({
      items,
      parentSessionKey: 'agent:main:parent',
      subagentSessions: childSessions,
      hasFollowingContent: true,
    })).toEqual({ phase: 'waiting', total: 2, completed: 1 });
  });

  it('moves from returned results to complete only after parent content resumes', () => {
    const completedSessions = childSessions.map((session) => ({
      ...session,
      subagentRunState: 'done',
      hasActiveSubagentRun: false,
    }));
    expect(getSubagentToolGroupProgress({
      items,
      parentSessionKey: 'agent:main:parent',
      subagentSessions: completedSessions,
      hasFollowingContent: false,
    })).toEqual({ phase: 'resuming', total: 2, completed: 2 });
    expect(getSubagentToolGroupProgress({
      items,
      parentSessionKey: 'agent:main:parent',
      subagentSessions: completedSessions,
      hasFollowingContent: true,
    })).toEqual({ phase: 'completed', total: 2, completed: 2 });
  });
});

describe('isToolCallGroupActive', () => {
  it('keeps a trailing group active between serial tools while the live turn is running', () => {
    expect(isToolCallGroupActive({
      items: [tool('completed')],
      isLastEntry: true,
      timing: { source: 'live', status: 'running', startedAtMs: 1 },
    })).toBe(true);
  });

  it('ends activity when a later display entry creates a content boundary', () => {
    expect(isToolCallGroupActive({
      items: [{ ...tool('running'), status: 'running' }],
      isLastEntry: false,
      timing: { source: 'live', status: 'running', startedAtMs: 1 },
    })).toBe(false);
  });

  it('lets a completed turn override stale running tool status', () => {
    expect(isToolCallGroupActive({
      items: [{ ...tool('stale'), status: 'running' }],
      isLastEntry: true,
      timing: { source: 'live', status: 'complete', durationMs: 2_000 },
    })).toBe(false);
  });

  it('falls back to live tool status when turn timing is unavailable', () => {
    expect(isToolCallGroupActive({
      items: [{ ...tool('live'), status: 'pending' }],
      isLastEntry: true,
    })).toBe(true);
    expect(isToolCallGroupActive({
      items: [tool('done')],
      isLastEntry: true,
    })).toBe(false);
  });

  it('does not animate historical-only tool groups', () => {
    expect(isToolCallGroupActive({
      items: [{ ...tool('history'), status: 'running', historical: true }],
      isLastEntry: true,
    })).toBe(false);
  });
});
