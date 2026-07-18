import assert from 'node:assert/strict';
import test from 'node:test';

import { __test } from '../resources/openclaw-plugins/uclaw-artifact-guard/index.mjs';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

test('compacts completed PPT canvas arguments before the next model turn', () => {
  const priorArgs = {
    id: 'create_designed_pptx_file',
    args: {
      title: 'Prior deck',
      designIntent: 'Distinct visual storytelling.',
      slides: [{ elements: [
        { type: 'text', text: 'A', x: 1, y: 1, w: 10, h: 10 },
        { type: 'shape', shape: 'rect', x: 1, y: 12, w: 10, h: 10 },
      ] }],
    },
  };
  const event = {
    prompt: 'make another PPT',
    messages: [
      { role: 'user', content: 'make a PPT' },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', name: 'tool_call', arguments: JSON.stringify(priorArgs) }],
      },
      { role: 'toolResult', content: '{"ok":true}' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'make another PPT' },
    ],
  };

  const result = __test.compactHistoricalPresentationToolCalls(event);
  assert.equal(result.compacted, 1);
  assert.ok(result.omittedChars > 0);
  const compacted = JSON.parse(event.messages[1].content[0].arguments);
  assert.equal(compacted.args.slides, undefined);
  assert.equal(compacted.args.slideCount, 1);
  assert.equal(compacted.args.elementCount, 2);
  assert.equal(compacted.args.summaryKind, 'designed_presentation_invocation');
});

test('does not compact the current turn PPT invocation', () => {
  const event = {
    prompt: 'make a PPT',
    messages: [
      { role: 'user', content: 'make a PPT' },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          name: 'create_designed_pptx_file',
          arguments: { title: 'Current', slides: [{ elements: [] }] },
        }],
      },
    ],
  };
  const result = __test.compactHistoricalPresentationToolCalls(event);
  assert.equal(result.compacted, 0);
  assert.equal(event.messages[1].content[0].arguments.slides.length, 1);
});

test('compacts frozen historical tool calls without mutating OpenClaw message objects', () => {
  const originalMessages = deepFreeze([
    { role: 'user', content: 'make a PPT' },
    {
      role: 'assistant',
      tool_calls: [{
        type: 'function',
        function: {
          name: 'create_designed_pptx_file',
          arguments: {
            title: 'Frozen deck',
            slides: [{
              elements: Array.from({ length: 24 }, (_, index) => ({
                type: 'text',
                text: `Detailed frozen slide content ${index}`,
                x: index,
                y: index,
                w: 10,
                h: 4,
              })),
            }],
          },
        },
      }],
    },
    { role: 'toolResult', content: '{"ok":true}' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'make another PPT' },
  ]);
  const event = {
    prompt: 'make another PPT',
    messages: originalMessages,
  };

  const result = __test.compactHistoricalPresentationToolCalls(event);

  assert.equal(result.compacted, 1);
  assert.notEqual(event.messages, originalMessages);
  assert.equal(originalMessages[1].tool_calls[0].function.arguments.slides[0].elements.length, 24);
  const compacted = event.messages[1].tool_calls[0].function.arguments;
  assert.equal(compacted.slides, undefined);
  assert.equal(compacted.slideCount, 1);
  assert.equal(compacted.elementCount, 24);
});

test('finds a successful PPT artifact nested behind the tool directory result', () => {
  const filePath = '/tmp/final-deck.pptx';
  const evidence = __test.buildToolArtifactEvidence({
    toolName: 'tool_call',
    result: {
      tool: { id: 'openclaw:uclaw-local-artifacts:repair_designed_pptx_file' },
      result: {
        content: [{ type: 'text', text: JSON.stringify({
          ok: true,
          filePath,
          media: `MEDIA:${filePath}`,
          verification: { status: 'passed', slideCount: 7 },
        }) }],
      },
    },
  });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].artifact.filePath, filePath);
});
