// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { consumeSseText } from '../../scripts/diagnostics/probe-responses-ttfb.mjs';

describe('Responses TTFB probe', () => {
  it('tracks the first event, first text, and completion without retaining content', () => {
    const state = {
      buffer: '',
      eventName: '',
      eventTypes: new Set<string>(),
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      completedMs: null,
    };

    consumeSseText(state, 'event: response.created\ndata: {"type":"response.created"}\n', 120);
    consumeSseText(state, '\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"secret text"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n', 340);

    expect(state.firstEventMs).toBe(120);
    expect(state.firstTextMs).toBe(340);
    expect(state.completedMs).toBe(340);
    expect([...state.eventTypes]).toEqual([
      'response.created',
      'response.output_text.delta',
      'response.completed',
    ]);
    expect(JSON.stringify(state)).not.toContain('secret text');
  });

  it('reports the model declared by the response without inferring alias routing', () => {
    const state = { buffer: '', eventName: '', eventTypes: new Set<string>(), responseModel: null };
    consumeSseText(state, 'data: {"type":"response.created","response":{"model":"gpt-fixture"}}\n\n', 1);
    expect(state.responseModel).toBe('gpt-fixture');
    consumeSseText(state, 'data: {"type":"response.completed","response":{"model":"smart-latest"}}\n\n', 2);
    expect(state.responseModel).toBe('smart-latest');
  });
});
