import { describe, expect, it } from 'vitest';

import { isSupportedCompositeRunTaskSet } from '../../shared/composite-run';

describe('composite run task cardinality', () => {
  it.each([
    'presentation',
    'spreadsheet',
    'mini_program',
    'copywriting',
  ] as const)('accepts one deterministic local artifact task: %s', (kind) => {
    expect(isSupportedCompositeRunTaskSet([{ kind }])).toBe(true);
  });

  it.each([
    'image_generate',
    'image_edit',
    'video_generate',
  ] as const)('keeps one media task on its direct runtime route: %s', (kind) => {
    expect(isSupportedCompositeRunTaskSet([{ kind }])).toBe(false);
  });

  it('requires at least one task and continues to accept real composites', () => {
    expect(isSupportedCompositeRunTaskSet([])).toBe(false);
    expect(isSupportedCompositeRunTaskSet([
      { kind: 'image_generate' },
      { kind: 'video_generate' },
    ])).toBe(true);
  });
});
