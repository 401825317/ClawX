import { describe, expect, it } from 'vitest';
import { appendToolErrorHint, normalizeToolErrorMessage } from '@/lib/tool-error-messages';

describe('tool error messages', () => {
  it('explains missing files without treating ENOENT as a skill failure', () => {
    expect(normalizeToolErrorMessage('ENOENT: no such file or directory, open C:\\tmp\\missing.txt', 'en'))
      .toBe('The file does not exist or the path is incorrect. Check the directory contents before continuing.');
  });

  it('explains unsupported local file URLs for the browser tool', () => {
    expect(normalizeToolErrorMessage('Navigation blocked: unsupported protocol "file:"', 'en'))
      .toBe('The browser tool cannot open file:// local files directly. Use the workspace preview or a local HTTP URL.');
  });

  it('explains scheduled task targeting errors for non-default agents', () => {
    expect(normalizeToolErrorMessage('sessionTarget "main" is only valid for the default agent', 'en'))
      .toBe('The scheduled task used incompatible params for a non-default agent. Use an isolated session and an agentTurn payload.');
  });

  it('prepends the friendly hint to the original detail once', () => {
    const detail = 'ENOENT: no such file or directory';
    const first = appendToolErrorHint(detail, 'en');
    const second = appendToolErrorHint(first, 'en');

    expect(first).toBe([
      'The file does not exist or the path is incorrect. Check the directory contents before continuing.',
      '',
      detail,
    ].join('\n'));
    expect(second).toBe(first);
  });
});
