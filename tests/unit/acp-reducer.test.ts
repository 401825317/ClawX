import { describe, expect, it } from 'vitest';
import { applyAttachmentResolution, attachmentRequestFingerprint } from '@/lib/acp/attachments';
import { contentBlockToRenderPart, toolContentToRenderPart } from '@/lib/acp/content-blocks';
import { appendSyntheticAssistantMessage, applyAcpSessionUpdate, createEmptyAcpTimeline } from '@/lib/acp/reducer';

const assistantBlockContext = {
  role: 'assistant' as const,
  messageId: 'msg-a',
  segmentIndex: 0,
  blockIndex: 0,
};

describe('ACP timeline reducer', () => {
  it('keeps an Assistant stream open when a generated-media overlay is added', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-a',
        content: { type: 'text', text: 'The image is' },
      },
    });
    state = appendSyntheticAssistantMessage(state, {
      messageId: 'compat:image-generation:evidence-a',
      evidenceId: 'evidence-a',
      parts: [{ kind: 'image', source: 'data:image/png;base64,a', mediaIdentity: 'image-a' }],
      afterItemId: 'msg-a:0',
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-a',
        content: { type: 'text', text: ' ready.' },
      },
    });

    expect(state.itemOrder).toEqual([
      'msg-a:0',
      'compat:image-generation:evidence-a:0',
    ]);
    expect(state.itemsById['msg-a:0']).toMatchObject({
      kind: 'message-segment',
      parts: [{ kind: 'markdown', text: 'The image is ready.' }],
    });
    expect(state.openMessageSegments).toMatchObject({ 'msg-a': 'msg-a:0' });
  });

  it('keeps a fallback Assistant stream open across a generated-media overlay', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'The image is' },
      },
    });
    state = appendSyntheticAssistantMessage(state, {
      messageId: 'compat:image-generation:evidence-a',
      evidenceId: 'evidence-a',
      parts: [{ kind: 'image', source: 'data:image/png;base64,a', mediaIdentity: 'image-a' }],
      afterItemId: 'assistant:message:0:0',
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' ready.' },
      },
    });

    expect(state.itemOrder).toEqual([
      'assistant:message:0:0',
      'compat:image-generation:evidence-a:0',
    ]);
    expect(state.itemsById['assistant:message:0:0']).toMatchObject({
      kind: 'message-segment',
      parts: [{ kind: 'markdown', text: 'The image is ready.' }],
    });
    expect(state.itemsById['assistant:message:1:0']).toBeUndefined();
  });

  it('preserves a resolved generated image when a full Assistant message replaces ACP text', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-a',
        content: { type: 'text', text: 'Partial caption' },
      },
    });
    const existing = state.itemsById['msg-a:0'];
    if (existing?.kind !== 'message-segment') throw new Error('expected Assistant segment');
    state = {
      ...state,
      itemsById: {
        ...state.itemsById,
        [existing.id]: {
          ...existing,
          compat: { source: 'image-generation', evidenceId: 'evidence-a' },
          parts: [
            ...existing.parts,
            { kind: 'image', source: 'data:image/png;base64,a', mediaIdentity: 'image-a' },
          ],
        },
      },
    };

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message',
        messageId: 'msg-a',
        content: [{ type: 'text', text: 'Final caption' }],
      },
    });

    expect(state.itemsById['msg-a:0']).toMatchObject({
      kind: 'message-segment',
      compat: { source: 'image-generation', evidenceId: 'evidence-a' },
      parts: [
        { kind: 'markdown', text: 'Final caption' },
        { kind: 'image', source: 'data:image/png;base64,a', mediaIdentity: 'image-a' },
      ],
    });
  });

  it('allocates fallback message ids independently from compatibility item count', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'before tool' },
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read file',
        status: 'completed',
      },
    });
    state = appendSyntheticAssistantMessage(state, {
      messageId: 'compat:image-generation:evidence-a',
      evidenceId: 'evidence-a',
      parts: [{ kind: 'image', source: 'data:image/png;base64,a', mediaIdentity: 'image-a' }],
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'after tool' },
      },
    });

    expect(state.itemOrder).toContain('assistant:message:1:0');
    expect(state.itemsById['assistant:message:1:0']).toMatchObject({
      kind: 'message-segment',
      parts: [{ kind: 'markdown', text: 'after tool' }],
    });
  });

  it('segments assistant text when process blocks interleave with the same messageId', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-a',
        content: { type: 'text', text: 'I will inspect this.' },
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read file',
        status: 'pending',
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-a',
        content: { type: 'text', text: 'The file is safe.' },
      },
    });

    expect(state.itemOrder).toEqual(['msg-a:0', 'tool:tool-1', 'msg-a:1']);
    expect(state.itemsById['msg-a:0']).toMatchObject({
      kind: 'message-segment',
      role: 'assistant',
      segmentIndex: 0,
      parts: [{ kind: 'markdown', text: 'I will inspect this.' }],
    });
    expect(state.itemsById['msg-a:1']).toMatchObject({
      kind: 'message-segment',
      role: 'assistant',
      segmentIndex: 1,
      parts: [{ kind: 'markdown', text: 'The file is safe.' }],
    });
  });

  it('keeps fallback message ids stable across chunks until a process block closes the segment', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'first' },
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' second' },
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read file',
        status: 'pending',
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'after tool' },
      },
    });

    expect(state.itemOrder).toEqual(['assistant:message:0:0', 'tool:tool-1', 'assistant:message:1:0']);
    expect(state.itemsById['assistant:message:0:0']).toMatchObject({
      kind: 'message-segment',
      parts: [{ kind: 'markdown', text: 'first second' }],
    });
    expect(state.itemsById['assistant:message:1:0']).toMatchObject({
      kind: 'message-segment',
      parts: [{ kind: 'markdown', text: 'after tool' }],
    });
  });

  it('keeps fallback chunks interleaved when user and assistant messages omit ids', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'first user' },
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'first assistant' },
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'second user' },
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'second assistant' },
      },
    });

    expect(state.itemOrder).toEqual([
      'user:message:0:0',
      'assistant:message:0:0',
      'user:message:1:0',
      'assistant:message:1:0',
    ]);
    expect(state.itemsById['user:message:0:0']).toMatchObject({
      kind: 'message-segment',
      role: 'user',
      parts: [{ kind: 'markdown', text: 'first user' }],
    });
    expect(state.itemsById['user:message:1:0']).toMatchObject({
      kind: 'message-segment',
      role: 'user',
      parts: [{ kind: 'markdown', text: 'second user' }],
    });
  });

  it('coalesces adjacent markdown chunks into one render part', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-a',
        content: { type: 'text', text: 'hello' },
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-a',
        content: { type: 'text', text: ' world' },
      },
    });

    expect(state.itemOrder).toEqual(['msg-a:0']);
    expect(state.itemsById['msg-a:0']).toMatchObject({
      kind: 'message-segment',
      parts: [{ kind: 'markdown', text: 'hello world' }],
    });
  });

  it('replaces an optimistic user segment when ACP echoes the first chunk with the same id', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);
    state = {
      ...state,
      itemOrder: ['user-msg:0'],
      itemsById: {
        'user-msg:0': {
          kind: 'message-segment',
          id: 'user-msg:0',
          role: 'user',
          messageId: 'user-msg',
          segmentIndex: 0,
          optimistic: true,
          parts: [{ kind: 'markdown', text: 'hello' }],
        },
      },
      openMessageSegments: { 'user-msg': 'user-msg:0' },
      segmentCounts: { 'user-msg': 1 },
    };

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'user-msg',
        content: { type: 'text', text: 'hello' },
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'user-msg',
        content: { type: 'text', text: ' world' },
      },
    });

    expect(state.itemsById['user-msg:0']).toMatchObject({
      kind: 'message-segment',
      optimistic: false,
      parts: [{ kind: 'markdown', text: 'hello world' }],
    });
  });

  it('preserves optimistic attachment parts when ACP echoes only user text chunks', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);
    state = {
      ...state,
      itemOrder: ['user-msg:0'],
      itemsById: {
        'user-msg:0': {
          kind: 'message-segment',
          id: 'user-msg:0',
          role: 'user',
          messageId: 'user-msg',
          segmentIndex: 0,
          optimistic: true,
          userPromptTextBlocks: ['inspect this', '[Resource link] /repo/notes.txt'],
          userPromptTextBlocksOptimistic: true,
          parts: [
            { kind: 'markdown', text: 'inspect this' },
            {
              kind: 'attachment',
              attachmentId: 'attachment:user-msg:0:1',
              reference: { uri: '/repo/notes.txt', name: 'notes.txt', mimeType: 'text/plain' },
              source: 'acp-resource',
              access: { status: 'pending' },
            },
          ],
        },
      },
      openMessageSegments: { 'user-msg': 'user-msg:0' },
      segmentCounts: { 'user-msg': 1 },
    };

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'user-msg',
        content: { type: 'text', text: 'inspect' },
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'user-msg',
        content: { type: 'text', text: ' this' },
      },
    });

    expect(state.itemsById['user-msg:0']).toMatchObject({
      kind: 'message-segment',
      optimistic: false,
      userPromptTextBlocks: ['inspect this', '[Resource link] /repo/notes.txt'],
      parts: [
        { kind: 'markdown', text: 'inspect this' },
        {
          kind: 'attachment',
          attachmentId: 'attachment:user-msg:0:1',
          reference: { uri: '/repo/notes.txt', name: 'notes.txt', mimeType: 'text/plain' },
          source: 'acp-resource',
          access: { status: 'pending' },
        },
      ],
    });
  });

  it('preserves optimistic attachment parts when ACP echoes only a full user text message', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);
    state = {
      ...state,
      itemOrder: ['user-msg:0'],
      itemsById: {
        'user-msg:0': {
          kind: 'message-segment',
          id: 'user-msg:0',
          role: 'user',
          messageId: 'user-msg',
          segmentIndex: 0,
          optimistic: true,
          userPromptTextBlocks: ['inspect this', '[Resource link] /repo/notes.txt'],
          userPromptTextBlocksOptimistic: true,
          parts: [
            { kind: 'markdown', text: 'inspect this' },
            {
              kind: 'attachment',
              attachmentId: 'attachment:user-msg:0:1',
              reference: { uri: '/repo/notes.txt', name: 'notes.txt', mimeType: 'text/plain' },
              source: 'acp-resource',
              access: { status: 'pending' },
            },
          ],
        },
      },
      openMessageSegments: { 'user-msg': 'user-msg:0' },
      segmentCounts: { 'user-msg': 1 },
    };

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'user_message',
        messageId: 'user-msg',
        content: [{ type: 'text', text: 'inspect this' }],
      } as never,
    });

    expect(state.itemsById['user-msg:0']).toMatchObject({
      kind: 'message-segment',
      optimistic: false,
      userPromptTextBlocks: ['inspect this', '[Resource link] /repo/notes.txt'],
      parts: [
        { kind: 'markdown', text: 'inspect this' },
        {
          kind: 'attachment',
          attachmentId: 'attachment:user-msg:0:1',
          reference: { uri: '/repo/notes.txt', name: 'notes.txt', mimeType: 'text/plain' },
          source: 'acp-resource',
          access: { status: 'pending' },
        },
      ],
    });
  });

  it('replaces an optimistic user segment when ACP echoes the first chunk without an id', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);
    state = {
      ...state,
      itemOrder: ['user-msg:0'],
      itemsById: {
        'user-msg:0': {
          kind: 'message-segment',
          id: 'user-msg:0',
          role: 'user',
          messageId: 'user-msg',
          segmentIndex: 0,
          optimistic: true,
          parts: [{ kind: 'markdown', text: 'hello' }],
        },
      },
      openMessageSegments: { 'user-msg': 'user-msg:0' },
      segmentCounts: { 'user-msg': 1 },
    };

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'hello' },
      },
    });

    expect(state.itemsById['user-msg:0']).toMatchObject({
      kind: 'message-segment',
      optimistic: false,
      parts: [{ kind: 'markdown', text: 'hello' }],
    });
  });

  it('replaces message segment content on full message update', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-a',
        content: { type: 'text', text: 'partial' },
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message',
        messageId: 'msg-a',
        content: [
          { type: 'text', text: 'complete' },
          { type: 'image', uri: 'file:///tmp/plot.png', data: 'ignored', mimeType: 'image/png' },
          { type: 'resource_link', uri: 'file:///tmp/result.txt', name: 'result.txt', mimeType: 'text/plain' },
        ],
      } as never,
    });

    const item = state.itemsById['msg-a:0'];
    expect(item).toMatchObject({ kind: 'message-segment', segmentIndex: 0 });
    if (item?.kind === 'message-segment') {
      expect(item.parts).toEqual([
        { kind: 'markdown', text: 'complete' },
        { kind: 'image', source: 'file:///tmp/plot.png', mimeType: 'image/png' },
        {
          kind: 'attachment',
          attachmentId: 'attachment:msg-a:0:2',
          reference: { uri: 'file:///tmp/result.txt', name: 'result.txt', mimeType: 'text/plain' },
          source: 'acp-resource',
          access: { status: 'pending' },
        },
      ]);
    }
  });

  it('hides the ACP working directory envelope from a user message bubble', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);
    const text = '[Working directory: ~/.openclaw/workspace]\n\nhello bro';

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'user_message',
        messageId: 'user-msg',
        content: [{ type: 'text', text }],
      } as never,
    });

    expect(state.itemsById['user-msg:0']).toMatchObject({
      kind: 'message-segment',
      parts: [{ kind: 'markdown', text: 'hello bro' }],
      userPromptTextBlocks: [text],
    });
  });

  it('keeps an ordered binary-free OpenClaw prompt text projection for user content', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'user_message',
        messageId: 'user-with-files',
        content: [
          { type: 'text', text: 'Create the report' },
          { type: 'image', data: 'large-base64-must-not-be-retained', mimeType: 'image/png' },
          {
            type: 'resource_link',
            uri: 'file:///repo/input.xlsx',
            name: 'input.xlsx',
            title: 'Input (July)',
          },
          {
            type: 'resource',
            resource: { uri: 'file:///repo/context.txt', text: 'Embedded context' },
          },
        ],
      } as never,
    });

    expect(state.itemsById['user-with-files:0']).toMatchObject({
      kind: 'message-segment',
      userPromptTextBlocks: [
        'Create the report',
        '[Resource link (Input \\(July\\))] file:///repo/input.xlsx',
        'Embedded context',
      ],
    });
    const item = state.itemsById['user-with-files:0'];
    expect(item?.kind === 'message-segment' ? JSON.stringify(item.userPromptTextBlocks) : '')
      .not.toContain('large-base64-must-not-be-retained');
  });

  it('adds full message content as a later segment after a process block closes the message', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-a',
        content: { type: 'text', text: 'partial before tool' },
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read file',
        status: 'pending',
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message',
        messageId: 'msg-a',
        content: [{ type: 'text', text: 'complete after tool' }],
      } as never,
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-a',
        content: { type: 'text', text: ' trailing chunk' },
      },
    });

    expect(state.itemOrder).toEqual(['msg-a:0', 'tool:tool-1', 'msg-a:1']);
    expect(state.itemsById['msg-a:0']).toMatchObject({
      kind: 'message-segment',
      segmentIndex: 0,
      parts: [{ kind: 'markdown', text: 'partial before tool' }],
    });
    expect(state.itemsById['msg-a:1']).toMatchObject({
      kind: 'message-segment',
      segmentIndex: 1,
      parts: [{ kind: 'markdown', text: 'complete after tool trailing chunk' }],
    });
  });

  it('upserts tool calls, replaces update content, and appends content chunks', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Search',
        status: 'pending',
        content: [{ type: 'content', content: { type: 'text', text: 'initial output' } }],
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'in_progress',
        content: [{ type: 'diff', path: 'src/demo.ts', oldText: 'old', newText: 'new text' }],
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'tool_call_content_chunk',
        toolCallId: 'tool-1',
        content: { type: 'content', content: { type: 'text', text: 'found result' } },
      } as never,
    });

    expect(state.itemsById['tool:tool-1']).toMatchObject({
      kind: 'tool-call',
      status: 'running',
      outputParts: [
        { kind: 'markdown', text: 'Diff: src/demo.ts\n\nnew text' },
        { kind: 'markdown', text: 'found result' },
      ],
    });
  });

  it.each([
    [
      'DOCX',
      'document',
      'C:\\Users\\Tester\\workspace\\uclaw-regression.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    [
      'XLSX',
      'spreadsheet',
      'C:\\Users\\Tester\\workspace\\uclaw-regression.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    [
      'PPTX',
      'presentation',
      'C:\\Users\\Tester\\workspace\\uclaw-regression.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  ])('projects a completed structured %s tool result as a pending attachment', (_label, kind, filePath, mimeType) => {
    const payload = {
      ok: true,
      kind,
      filePath,
      fileSize: 4096,
      sizeBytes: 4096,
      mimeType,
      media: `MEDIA:${filePath}`,
    };
    const toolCallId = `create-${kind}`;
    const state = applyAcpSessionUpdate(createEmptyAcpTimeline('agent:pi:s1', 1), {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        title: `Create ${kind}`,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: JSON.stringify(payload) } }],
        rawOutput: {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          details: payload,
        },
      },
    } as never);

    expect(state.itemsById[`tool:${toolCallId}`]).toMatchObject({
      kind: 'tool-call',
      status: 'completed',
      outputParts: [
        { kind: 'markdown', text: JSON.stringify(payload) },
        {
          kind: 'attachment',
          attachmentId: `attachment:tool-artifact:${toolCallId}:0:0`,
          reference: {
            uri: filePath,
            name: filePath.split('\\').at(-1),
            mimeType,
            size: 4096,
          },
          source: 'acp-resource',
          evidenceId: `uclaw-office-artifact:${toolCallId}`,
          access: { status: 'pending' },
        },
      ],
    });
  });

  it('keeps one resolved Office attachment when the completed tool result is replayed', () => {
    const filePath = 'C:\\Users\\Tester\\workspace\\report.docx';
    const mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const payload = {
      ok: true,
      kind: 'document',
      filePath,
      sizeBytes: 1024,
      mimeType,
      media: `MEDIA:${filePath}`,
    };
    const notification = {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'create-docx',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: JSON.stringify(payload) } }],
        rawOutput: { details: payload },
      },
    } as never;
    let state = applyAcpSessionUpdate(createEmptyAcpTimeline('agent:pi:s1', 1), notification);
    const pending = state.itemsById['tool:create-docx'];
    const attachment = pending?.kind === 'tool-call'
      ? pending.outputParts.find((part) => part.kind === 'attachment')
      : undefined;
    if (!attachment || attachment.kind !== 'attachment') throw new Error('missing Office attachment');
    state = applyAttachmentResolution(state, {
      attachmentId: attachment.attachmentId,
      expectedFingerprint: attachmentRequestFingerprint(attachment),
      result: {
        ok: true,
        identity: 'office-report',
        displayName: 'report.docx',
        mimeType,
        size: 1024,
        target: {
          kind: 'local',
          scope: 'workspace',
          ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: filePath },
        },
      },
    });
    state = applyAcpSessionUpdate(state, notification);

    const replayed = state.itemsById['tool:create-docx'];
    const attachments = replayed?.kind === 'tool-call'
      ? replayed.outputParts.filter((part) => part.kind === 'attachment')
      : [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ access: { status: 'available', identity: 'office-report' } });
  });

  it.each([
    ['failed status', 'failed', { ok: true }],
    ['failed payload', 'completed', { ok: false }],
    ['relative path', 'completed', { filePath: 'exports/report.docx' }],
    ['mismatched MEDIA path', 'completed', { media: 'MEDIA:C:\\Users\\Tester\\workspace\\other.docx' }],
    ['mismatched MIME type', 'completed', { mimeType: 'application/pdf' }],
    ['mismatched extension', 'completed', { filePath: 'C:\\Users\\Tester\\workspace\\report.xlsx' }],
    ['Windows device path', 'completed', { filePath: '\\\\?\\C:\\Users\\Tester\\workspace\\report.docx' }],
  ])('rejects unsafe Office tool result: %s', (_label, status, overrides) => {
    const filePath = 'C:\\Users\\Tester\\workspace\\report.docx';
    const payload = {
      ok: true,
      kind: 'document',
      filePath,
      sizeBytes: 1024,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      media: `MEDIA:${filePath}`,
      ...overrides,
    };
    const state = applyAcpSessionUpdate(createEmptyAcpTimeline('agent:pi:s1', 1), {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'unsafe-office-result',
        status,
        rawOutput: { details: payload },
      },
    } as never);

    const item = state.itemsById['tool:unsafe-office-result'];
    expect(item?.kind === 'tool-call' ? item.outputParts : []).toEqual([]);
  });

  it('does not duplicate a native resource link with the same Office artifact result', () => {
    const filePath = 'C:\\Users\\Tester\\workspace\\report.xlsx';
    const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const payload = {
      ok: true,
      kind: 'spreadsheet',
      filePath,
      sizeBytes: 2048,
      mimeType,
      media: `MEDIA:${filePath}`,
    };
    const state = applyAcpSessionUpdate(createEmptyAcpTimeline('agent:pi:s1', 1), {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'native-office-resource',
        status: 'completed',
        content: [{
          type: 'content',
          content: { type: 'resource_link', uri: filePath, name: 'report.xlsx', mimeType, size: 2048 },
        }],
        rawOutput: { details: payload },
      },
    } as never);

    const item = state.itemsById['tool:native-office-resource'];
    const attachments = item?.kind === 'tool-call'
      ? item.outputParts.filter((part) => part.kind === 'attachment')
      : [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ reference: { uri: filePath } });
    expect(attachments[0]).not.toHaveProperty('evidenceId');
  });

  it('appends marked synthetic assistant messages without faking ACP updates', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'live-msg',
        content: { type: 'text', text: 'Working...' },
      },
    });

    state = appendSyntheticAssistantMessage(state, {
      messageId: 'compat:image-generation:task-1',
      evidenceId: 'evidence-1',
      parts: [
        { kind: 'markdown', text: 'Generated image is ready.' },
        { kind: 'image', source: 'data:image/png;base64,abc123', mimeType: 'image/png', alt: 'Generated image' },
      ],
    });

    expect(state.itemOrder).toEqual(['live-msg:0', 'compat:image-generation:task-1:0']);
    expect(state.openMessageSegments).toEqual({ 'live-msg': 'live-msg:0' });
    expect(state.itemsById['compat:image-generation:task-1:0']).toMatchObject({
      kind: 'message-segment',
      role: 'assistant',
      messageId: 'compat:image-generation:task-1',
      compat: { source: 'image-generation', evidenceId: 'evidence-1' },
      parts: [
        { kind: 'markdown', text: 'Generated image is ready.' },
        { kind: 'image', source: 'data:image/png;base64,abc123', mimeType: 'image/png' },
      ],
    });
  });

  it('updates an existing synthetic assistant message with the same id', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);
    state = appendSyntheticAssistantMessage(state, {
      messageId: 'compat:image-generation:task-1',
      evidenceId: 'evidence-1',
      parts: [{ kind: 'markdown', text: 'Generated image is ready.' }],
    });
    state = appendSyntheticAssistantMessage(state, {
      messageId: 'compat:image-generation:task-1',
      evidenceId: 'evidence-1',
      parts: [{ kind: 'markdown', text: 'Generated image is ready again.' }],
    });

    expect(state.itemOrder).toEqual(['compat:image-generation:task-1:0']);
    expect(state.itemsById['compat:image-generation:task-1:0']).toMatchObject({
      parts: [{ kind: 'markdown', text: 'Generated image is ready again.' }],
    });
  });

  it('converts embedded resources with a uri into attachment render parts', () => {
    expect(contentBlockToRenderPart({
      type: 'resource',
      resource: { uri: 'file:///tmp/report.md', text: '# Report', mimeType: 'text/markdown' },
    }, assistantBlockContext)).toEqual({
      kind: 'attachment',
      attachmentId: 'attachment:msg-a:0:0',
      reference: { uri: 'file:///tmp/report.md', name: 'report.md', mimeType: 'text/markdown' },
      source: 'acp-resource',
      access: { status: 'pending' },
    });
  });

  it('prefers image data when an image uri is not render-safe', () => {
    expect(contentBlockToRenderPart({
      type: 'image',
      uri: '/tmp/staged-image.png',
      data: 'abc123',
      mimeType: 'image/png',
    }, assistantBlockContext)).toEqual({ kind: 'image', source: 'data:image/png;base64,abc123', mimeType: 'image/png' });
  });

  it('returns an unavailable attachment for embedded resources without a usable uri', () => {
    expect(contentBlockToRenderPart({
      type: 'resource',
      resource: { text: '# Report', mimeType: 'text/markdown' },
    } as never, assistantBlockContext)).toEqual({
      kind: 'attachment',
      attachmentId: 'attachment:msg-a:0:0',
      reference: { uri: '', name: '' , mimeType: 'text/markdown' },
      source: 'acp-resource',
      access: { status: 'unavailable', reason: 'invalidReference' },
    });
  });

  it('preserves resource link metadata and accepts ClawX staging ownership only from user content', () => {
    const resource = {
      type: 'resource_link' as const,
      uri: 'file:///tmp/budget.xlsx',
      name: '',
      title: 'Budget workbook',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 2048,
      _meta: { clawx: { stagingId: 'stage-1' } },
    };

    expect(contentBlockToRenderPart(resource, {
      ...assistantBlockContext,
      role: 'user',
    })).toMatchObject({
      kind: 'attachment',
      attachmentId: 'attachment:msg-a:0:0',
      reference: {
        uri: 'file:///tmp/budget.xlsx',
        name: 'Budget workbook',
        mimeType: resource.mimeType,
        size: 2048,
        stagingId: 'stage-1',
      },
      source: 'acp-resource',
      access: { status: 'pending' },
    });
    expect(contentBlockToRenderPart(resource, assistantBlockContext)).not.toMatchObject({
      reference: { stagingId: 'stage-1' },
    });
  });

  it('renders a staged user image block as an attachment and ignores untrusted display paths', () => {
    expect(contentBlockToRenderPart({
      type: 'image',
      data: 'abc123',
      mimeType: 'image/png',
      uri: '/tmp/clawx-staging/photo.png',
      _meta: {
        clawx: {
          stagingId: 'stage-photo',
          displayPath: '/spoofed/private/path/photo.png',
          fileName: 'photo.png',
        },
      },
    }, {
      role: 'user', messageId: 'user-photo', segmentIndex: 0, blockIndex: 0,
    })).toMatchObject({
      kind: 'attachment',
      reference: {
        uri: '/tmp/clawx-staging/photo.png',
        name: 'photo.png',
        mimeType: 'image/png',
        stagingId: 'stage-photo',
      },
    });
    expect(contentBlockToRenderPart({
      type: 'resource_link',
      uri: '/tmp/clawx-staging/notes.txt',
      name: 'notes.txt',
      _meta: { clawx: { stagingId: 'stage-notes', displayPath: '/spoofed/private/notes.txt' } },
    }, {
      role: 'user', messageId: 'user-notes', segmentIndex: 0, blockIndex: 0,
    })).not.toMatchObject({ reference: { displayPath: expect.anything() } });
  });

  it('uses segment and block positions for distinct attachment ids around a tool call', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);
    const resource = { type: 'resource_link' as const, uri: 'file:///tmp/report.txt', name: 'report.txt' };

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'msg-a', content: resource },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Inspect', status: 'completed' },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'msg-a', content: resource },
    });

    expect(state.itemsById['msg-a:0']).toMatchObject({
      parts: [{ attachmentId: 'attachment:msg-a:0:0' }],
    });
    expect(state.itemsById['msg-a:1']).toMatchObject({
      parts: [{ attachmentId: 'attachment:msg-a:1:0' }],
    });

    const secondAttachment = state.itemsById['msg-a:1']?.kind === 'message-segment'
      ? state.itemsById['msg-a:1'].parts[0]
      : undefined;
    if (!secondAttachment || secondAttachment.kind !== 'attachment') throw new Error('missing second attachment');
    state = applyAttachmentResolution(state, {
      attachmentId: 'attachment:msg-a:1:0',
      expectedFingerprint: attachmentRequestFingerprint(secondAttachment),
      result: {
        ok: true,
        identity: 'second-resource',
        displayName: 'report.txt',
        mimeType: 'text/plain',
        size: 42,
        target: {
          kind: 'local',
          scope: 'workspace',
          ref: { sessionKey: 'agent:pi:s1', generation: 1, uri: 'file:///tmp/report.txt' },
        },
      },
    });
    expect(state.itemsById['msg-a:0']).toMatchObject({
      parts: [{ access: { status: 'pending' } }],
    });
    expect(state.itemsById['msg-a:1']).toMatchObject({
      parts: [{ access: { status: 'available', identity: 'second-resource' } }],
    });
  });

  it('converts terminal tool content into a safe markdown render part', () => {
    expect(toolContentToRenderPart({ type: 'terminal', terminalId: 'terminal-1' })).toEqual({
      kind: 'markdown',
      text: 'Terminal: terminal-1',
    });
  });

  it('ignores notifications for other sessions', () => {
    const state = createEmptyAcpTimeline('agent:pi:s1', 1);

    const next = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s2',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-a',
        content: { type: 'text', text: 'ignored' },
      },
    });

    expect(next).toBe(state);
    expect(next.itemOrder).toEqual([]);
  });

  it('updates session metadata for modes, session info, commands, and usage', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'plan', description: 'Create a plan' }],
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: { sessionUpdate: 'session_info_update', title: 'Demo', updatedAt: '2026-07-05T00:00:00Z' },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0.01, currency: 'USD' } },
    });

    expect(state.metadata).toEqual({
      currentModeId: 'code',
      availableCommands: [{ name: 'plan', description: 'Create a plan' }],
      title: 'Demo',
      updatedAt: '2026-07-05T00:00:00Z',
      usage: { used: 10, size: 100, cost: { amount: 0.01, currency: 'USD' } },
    });
  });

  it('updates metadata for config option updates', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);
    const configOptions = [
      {
        type: 'boolean',
        id: 'auto-approve',
        name: 'Auto approve safe tools',
        currentValue: false,
      },
    ];

    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: { sessionUpdate: 'config_option_update', configOptions },
    });

    expect(state.metadata.configOptions).toEqual(configOptions);
  });

  it('rebuilds a persisted terminal failure against the latest replayed user turn', () => {
    let state = createEmptyAcpTimeline('agent:pi:s1', 1);
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'continue' },
      },
    });
    state = applyAcpSessionUpdate(state, {
      sessionId: 'agent:pi:s1',
      update: {
        sessionUpdate: 'uclaw_turn_failure',
        userMessageId: 'live-id-not-present-during-replay',
        errorMessage: 'status_code=403, code=insufficient_user_quota, 用户额度不足',
      },
    });

    expect(state.itemOrder).toEqual(['user:message:0:0', 'turn-failure:user:message:0']);
    expect(state.itemsById['turn-failure:user:message:0']).toMatchObject({
      kind: 'turn-failure',
      userMessageId: 'user:message:0',
      failure: {
        code: 'INSUFFICIENT_QUOTA',
        retryable: false,
        httpStatus: 403,
        upstreamCode: 'insufficient_user_quota',
      },
    });
  });
});
