import assert from 'node:assert/strict';
import test from 'node:test';

import { extractToolCompletedFiles } from '../src/stores/chat/runtime-graph.ts';
import type { ChatRuntimeEvent } from '../src/stores/chat/types.ts';

test('extracts a nested artifact returned through the tool directory bridge', () => {
  const filePath = '/tmp/final-deck.pptx';
  const event: ChatRuntimeEvent = {
    contractVersion: 1,
    producer: 'gateway',
    runId: 'run-ppt',
    sessionKey: 'agent:main:main',
    ts: 1,
    type: 'tool.completed',
    toolCallId: 'outer-tool-call',
    name: 'tool_call',
    isError: false,
    result: {
      tool: { id: 'openclaw:uclaw-local-artifacts:repair_designed_pptx_file' },
      result: {
        content: [{ type: 'text', text: JSON.stringify({
          ok: true,
          filePath,
          media: `MEDIA:${filePath}`,
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          verification: { status: 'passed', slideCount: 7 },
        }) }],
      },
    },
  };
  const files = extractToolCompletedFiles(event);
  assert.equal(files.length, 1);
  assert.equal(files[0].filePath, filePath);
});
