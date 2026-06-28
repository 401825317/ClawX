import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('UClaw tool routing context', () => {
  const toolsContext = readFileSync(join(process.cwd(), 'resources', 'context', 'TOOLS.clawx.md'), 'utf8');
  const computerUsePlugin = readFileSync(
    join(process.cwd(), 'resources', 'openclaw-plugins', 'uclaw-computer-use', 'index.mjs'),
    'utf8',
  );

  it('routes desktop work to concrete computer-use tools', () => {
    expect(toolsContext).toContain('UClaw has native computer-use tools');
    expect(toolsContext).toContain('computer_screenshot');
    expect(toolsContext).toContain('computer_system_window_list');
    expect(toolsContext).toContain('computer_uia_tree');
    expect(toolsContext).toContain('computer_browser_dom_snapshot');
    expect(toolsContext).not.toContain('not native desktop automation');
  });

  it('keeps ordinary web research on web tools before browser or shell fallbacks', () => {
    expect(toolsContext).toContain('prefer `web_search` first');
    expect(toolsContext).toContain('Use `web_fetch` for known URLs');
    expect(toolsContext).toContain('Avoid shell/Python HTTP scraping for ordinary searches');
    expect(toolsContext).toContain('Use `exec` with `curl`/`wttr.in` only as a last fallback');
  });

  it('describes computer-use plugin tools as native desktop controls', () => {
    expect(computerUsePlugin).toContain('Native UClaw computer-use tools');
    expect(computerUsePlugin).toContain('Use this before controlling an already-open Chrome/Edge/native desktop app window');
    expect(computerUsePlugin).toContain('Prefer this over blind coordinate clicks');
    expect(computerUsePlugin).toContain('This is for UClaw app windows, not arbitrary external Chrome tabs');
  });
});
