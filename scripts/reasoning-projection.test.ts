import assert from 'node:assert/strict';
import test from 'node:test';

import { projectReasoningPanels } from '../src/pages/Chat/reasoning-projection.ts';
import type { ChatRuntimeRunState, RawMessage } from '../src/stores/chat/types.ts';

function assistantThinking(id: string, ...thinking: string[]): RawMessage {
  return {
    id,
    role: 'assistant',
    content: thinking.map((value) => ({ type: 'thinking' as const, thinking: value })),
    timestamp: 100,
  };
}

function runtimeRun(
  thinkingText: string,
  status: ChatRuntimeRunState['status'] = 'running',
): Pick<ChatRuntimeRunState, 'runId' | 'status' | 'thinkingText' | 'lastEventAt' | 'endedAt'> {
  return {
    runId: 'run-reasoning-1',
    status,
    thinkingText,
    lastEventAt: 200,
  };
}

test('off hides historical and live reasoning', () => {
  const panels = projectReasoningPanels({
    reasoningLevel: 'off',
    historyMessages: [assistantThinking('history-1', 'historical plan')],
    runtimeRun: runtimeRun('live plan'),
    streamMessage: assistantThinking('stream-1', 'stream plan'),
    activeTurn: true,
  });

  assert.deepEqual(panels, []);
});

test('on persistently replays assistant thinking after the turn finishes', () => {
  const panels = projectReasoningPanels({
    reasoningLevel: 'on',
    historyStartIndex: 7,
    historyMessages: [
      { role: 'user', content: [{ type: 'thinking', thinking: 'never expose user blocks' }] },
      assistantThinking('history-1', 'Inspecting the request', 'Choosing a safe execution path'),
    ],
    activeTurn: false,
    turnId: 'turn-1',
  });

  assert.equal(panels.length, 1);
  assert.equal(panels[0]?.id, 'reasoning:turn-1');
  assert.equal(panels[0]?.displayMode, 'persisted');
  assert.equal(panels[0]?.source, 'history');
  assert.deepEqual(panels[0]?.historyMessageIndexes, [8]);
  assert.equal(panels[0]?.text, 'Inspecting the request\n\nChoosing a safe execution path');
  assert.doesNotMatch(panels[0]?.text ?? '', /never expose/u);
});

test('stream is visible only while the current turn is active', () => {
  const historyMessages = [assistantThinking('history-1', 'old persisted reasoning')];
  const streamMessage = assistantThinking('stream-1', 'live streamed reasoning');

  assert.deepEqual(projectReasoningPanels({
    reasoningLevel: 'stream',
    historyMessages,
    streamMessage,
    activeTurn: false,
  }), []);

  const panels = projectReasoningPanels({
    reasoningLevel: 'STREAM',
    historyMessages,
    streamMessage,
    activeTurn: true,
    turnId: 'active-turn',
  });
  assert.equal(panels.length, 1);
  assert.equal(panels[0]?.displayMode, 'live');
  assert.equal(panels[0]?.source, 'stream');
  assert.equal(panels[0]?.text, 'live streamed reasoning');
  assert.deepEqual(panels[0]?.historyMessageIndexes, []);
});

test('deduplicates progressive history, runtime, and stream snapshots', () => {
  const panels = projectReasoningPanels({
    reasoningLevel: 'on',
    historyMessages: [
      assistantThinking('history-1', 'Planning the task'),
      assistantThinking('history-2', 'Planning the task\n\nChecking available tools'),
    ],
    runtimeRun: runtimeRun('Planning the task\n\nChecking available tools\n\nPreparing the result'),
    streamMessage: assistantThinking(
      'stream-1',
      'Planning the task\n\nChecking available tools\n\nPreparing the result',
    ),
    activeTurn: true,
  });

  assert.equal(panels.length, 1);
  assert.equal(panels[0]?.id, 'reasoning:run-reasoning-1');
  assert.equal(panels[0]?.source, 'runtime');
  assert.equal(panels[0]?.displayMode, 'live');
  assert.equal(
    panels[0]?.text,
    'Planning the task\n\nChecking available tools\n\nPreparing the result',
  );
  assert.deepEqual(panels[0]?.historyMessageIndexes, [0, 1]);
});

test('keeps distinct reasoning phases while removing exact duplicates', () => {
  const panels = projectReasoningPanels({
    reasoningLevel: 'on',
    historyMessages: [assistantThinking('history-1', 'Understand the request')],
    runtimeRun: runtimeRun('Use the image tool'),
    streamMessage: assistantThinking('stream-1', 'Use the image tool'),
    activeTurn: true,
  });

  assert.equal(panels[0]?.text, 'Understand the request\n\nUse the image tool');
  assert.equal(panels[0]?.source, 'mixed');
});

test('empty and unknown visibility inputs do not create panels', () => {
  assert.deepEqual(projectReasoningPanels({ reasoningLevel: 'on' }), []);
  assert.deepEqual(projectReasoningPanels({
    reasoningLevel: 'unexpected',
    runtimeRun: runtimeRun('must remain hidden'),
    activeTurn: true,
  }), []);
});

test('redacts credentials before reasoning reaches the renderer', () => {
  const panels = projectReasoningPanels({
    reasoningLevel: 'on',
    historyMessages: [assistantThinking('history-secret', 'Authorization: Bearer sk-proj-abcdef123456')],
  });

  assert.doesNotMatch(panels[0]?.text ?? '', /sk-proj-abcdef123456/u);
  assert.match(panels[0]?.text ?? '', /\[REDACTED\]/u);
});
