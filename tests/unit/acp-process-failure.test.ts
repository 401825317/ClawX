import { describe, expect, it } from 'vitest';
import {
  acpProcessRetryDelayMs,
  classifyAcpProcessFailure,
  isAcpResourceFailure,
} from '@electron/utils/acp-process-failure';

describe('ACP process failure classification', () => {
  it.each([
    'Fatal process out of memory: Zone',
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    Object.assign(new Error('not enough memory'), { code: 'ENOMEM' }),
    { code: 'ERR_WORKER_OUT_OF_MEMORY', cause: new Error('worker stopped') },
    { code: 'ACP_RESOURCE_EXHAUSTED' },
  ])('classifies resource exhaustion without depending on one exit code: %o', (error) => {
    expect(classifyAcpProcessFailure(error)).toBe('resource');
    expect(isAcpResourceFailure(error)).toBe(true);
  });

  it('keeps a generic child exit distinct from a confirmed resource failure', () => {
    expect(classifyAcpProcessFailure(new Error('ACP process exited with code 1'))).toBe('process-exit');
    expect(isAcpResourceFailure(new Error('ACP process exited with code 1'))).toBe(false);
  });

  it('does not classify a protocol failure as memory exhaustion', () => {
    expect(classifyAcpProcessFailure(new Error('ACP agent does not support session/load'))).toBe('other');
  });

  it('uses bounded exponential delays', () => {
    expect([1, 2, 3, 4, 5, 9].map(acpProcessRetryDelayMs)).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      8_000,
      8_000,
    ]);
  });
});
