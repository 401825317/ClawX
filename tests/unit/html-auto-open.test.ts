import { describe, expect, it } from 'vitest';
import type { AcpTimelineSnapshot, ToolCallItem } from '@/lib/acp/timeline-types';
import {
  collectHtmlAutoOpen,
  isAbsolutePathInsideWorkspace,
  isTokenizedLoopbackPreviewUrl,
} from '@/lib/acp/html-auto-open';

function tool(
  toolCallId: string,
  output: unknown,
  options: { historical?: boolean; status?: ToolCallItem['status'] } = {},
): ToolCallItem {
  return {
    kind: 'tool-call',
    id: `tool:${toolCallId}`,
    toolCallId,
    title: 'Create HTML',
    status: options.status ?? 'completed',
    output,
    outputParts: [],
    locations: [],
    ...(options.historical ? { historical: true } : {}),
  };
}

function timeline(items: ToolCallItem[]): AcpTimelineSnapshot {
  return {
    sessionId: 'session-html',
    loadGeneration: 1,
    itemOrder: items.map((item) => item.id),
    itemsById: Object.fromEntries(items.map((item) => [item.id, item])),
    metadata: {},
    openMessageSegments: {},
    segmentCounts: {},
    fallbackMessageCounts: { user: 0, assistant: 0 },
  };
}

describe('HTML artifact auto-open', () => {
  it('accepts normalized workspace children and rejects traversal and siblings', () => {
    expect(isAbsolutePathInsideWorkspace(
      'C:\\Work\\project\\site\\..\\index.html',
      'C:\\Work\\project',
    )).toBe(true);
    expect(isAbsolutePathInsideWorkspace(
      'C:\\Work\\project\\site\\..\\..\\outside.html',
      'C:\\Work\\project',
    )).toBe(false);
    expect(isAbsolutePathInsideWorkspace(
      'C:\\Work\\project-copy\\index.html',
      'C:\\Work\\project',
    )).toBe(false);
    expect(isAbsolutePathInsideWorkspace('/work/project/../outside.html', '/work/project')).toBe(false);
    expect(isAbsolutePathInsideWorkspace('relative/index.html', '/work/project')).toBe(false);
  });

  it('opens only new successful live results and chooses the last webpage', () => {
    const snapshot = timeline([
      tool('historical', { ok: true, kind: 'webpage', filePath: 'C:\\Work\\old.html' }, { historical: true }),
      tool('failed', { ok: true, kind: 'webpage', filePath: 'C:\\Work\\failed.html' }, { status: 'failed' }),
      tool('first', { details: { ok: true, kind: 'webpage', filePath: 'C:\\Work\\first.html' } }),
      tool('last', JSON.stringify({ result: { ok: true, kind: 'webpage', path: 'C:\\Work\\last.html' } })),
      tool('outside', { ok: true, kind: 'webpage', filePath: 'C:\\Other\\outside.html' }),
    ]);

    expect(collectHtmlAutoOpen(snapshot, 'C:\\Work', new Set())).toEqual({
      filePath: 'C:\\Work\\last.html',
      observedToolCallIds: ['first', 'last', 'outside'],
    });
    expect(collectHtmlAutoOpen(snapshot, 'C:\\Work', new Set(['first', 'last', 'outside']))).toEqual({
      filePath: null,
      observedToolCallIds: [],
    });
  });

  it('observes a completed webpage result once even when validation cannot open it', () => {
    const rejected = timeline([
      tool('rejected', { ok: true, kind: 'webpage', filePath: 'C:\\Other\\outside.html' }),
    ]);
    const first = collectHtmlAutoOpen(rejected, 'C:\\Work', new Set());

    expect(first).toEqual({ filePath: null, observedToolCallIds: ['rejected'] });
    expect(collectHtmlAutoOpen(rejected, 'C:\\Work', new Set(first.observedToolCallIds))).toEqual({
      filePath: null,
      observedToolCallIds: [],
    });
  });

  it('accepts only exact tokenized IPv4 loopback HTTP preview URLs', () => {
    const token = 'A'.repeat(43);
    expect(isTokenizedLoopbackPreviewUrl(`http://127.0.0.1:49152/${token}/index.html`)).toBe(true);
    expect(isTokenizedLoopbackPreviewUrl(`file:///C:/Work/${token}/index.html`)).toBe(false);
    expect(isTokenizedLoopbackPreviewUrl(`http://localhost:49152/${token}/index.html`)).toBe(false);
    expect(isTokenizedLoopbackPreviewUrl(`http://127.0.0.1:49152/${token}/index.html?source=file`)).toBe(false);
    expect(isTokenizedLoopbackPreviewUrl(`http://127.0.0.1:49152/${token}/nested/index.html`)).toBe(false);
    expect(isTokenizedLoopbackPreviewUrl(`http://127.0.0.1:49152/${'A'.repeat(42)}/index.html`)).toBe(false);
  });

  it('finds a workspace source path in a preview-tool result and in rendered tool content', () => {
    const sourcePath = 'C:\\Work\\site\\index.html';
    const snapshot = timeline([
      tool('preview-details', {
        ok: true,
        kind: 'webpage',
        browserUrl: `http://127.0.0.1:49152/${'A'.repeat(43)}/index.html`,
        sourcePath,
      }),
      tool('preview-content', undefined),
    ]);
    snapshot.itemsById['tool:preview-content']!.outputParts = [{
      kind: 'markdown',
      text: JSON.stringify({ ok: true, kind: 'webpage', sourcePath }),
    }];

    expect(collectHtmlAutoOpen(snapshot, 'C:\\Work', new Set())).toEqual({
      filePath: sourcePath,
      observedToolCallIds: ['preview-details', 'preview-content'],
    });
  });

  it('refreshes the same path when a new tool call completes', () => {
    const output = { ok: true, kind: 'webpage', filePath: '/work/site/index.html' };
    const first = collectHtmlAutoOpen(timeline([tool('create', output)]), '/work', new Set());
    const updated = collectHtmlAutoOpen(
      timeline([tool('create', output), tool('update', output)]),
      '/work',
      new Set(first.observedToolCallIds),
    );

    expect(updated).toEqual({
      filePath: '/work/site/index.html',
      observedToolCallIds: ['update'],
    });
  });
});
