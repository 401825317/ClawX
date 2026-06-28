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
    expect(toolsContext).toContain('treat this section as higher priority than Browser/Web Research routing');
    expect(toolsContext).toContain('computer_screenshot');
    expect(toolsContext).toContain('computer_browser_open_url');
    expect(toolsContext).toContain('computer_system_window_list');
    expect(toolsContext).toContain('computer_uia_tree');
    expect(toolsContext).toContain('computer_browser_dom_snapshot');
    expect(toolsContext).toContain('pass `expectedForeground`');
    expect(toolsContext).toContain('do not click, press keys, paste text, or manually type URLs');
    expect(toolsContext).toContain('Screenshot files are visual context for the current chat model');
    expect(toolsContext).toContain('do not call the standalone `image` tool just to inspect them');
    expect(toolsContext).toContain('Never call `image` without an explicit model for computer-use screenshots');
    expect(toolsContext).not.toContain('not native desktop automation');
  });

  it('keeps ordinary web research on web tools before browser or shell fallbacks', () => {
    expect(toolsContext).toContain('prefer `web_search` first');
    expect(toolsContext).toContain('Use `web_fetch` for known URLs');
    expect(toolsContext).toContain('Avoid shell/Python HTTP scraping for ordinary searches');
    expect(toolsContext).toContain('Use `exec` with `curl`/`wttr.in` only as a last fallback');
    expect(toolsContext).toContain('Prefer it over `browser`, `browser-automation`, `exec`, PowerShell');
  });

  it('keeps weather useful when explicit user location is missing', () => {
    expect(toolsContext).toContain('If the user asks for weather without naming a city');
    expect(toolsContext).toContain('if `nodes` returns an empty list, do not stop there');
    expect(toolsContext).toContain('try IP-based weather lookup with `web_fetch`');
    expect(toolsContext).toContain('Ask the user for a city only after location metadata, connected node location, and IP/web fallback');
  });

  it('prevents browser automation from stealing explicit computer-use URL tasks', () => {
    expect(toolsContext).toContain('If the user explicitly asks for UClaw `computer use`');
    expect(toolsContext).toContain('asks for `computer_browser_open_url`');
    expect(toolsContext).toContain('do not read/use `browser-automation` and do not call `browser`');
    expect(toolsContext).toContain('Do not switch to `browser`, `browser-automation`, `exec`, PowerShell');
  });

  it('describes computer-use plugin tools as native desktop controls', () => {
    expect(computerUsePlugin).toContain('Native UClaw computer-use tools');
    expect(computerUsePlugin).toContain('computer_browser_open_url');
    expect(computerUsePlugin).toContain('EXPECTED_FOREGROUND_SCHEMA');
    expect(computerUsePlugin).toContain('the host refuses input if another window is foreground');
    expect(computerUsePlugin).toContain('Open an absolute http/https URL in the system default browser');
    expect(computerUsePlugin).toContain('visual context for the current chat model');
    expect(computerUsePlugin).toContain('Do not call the standalone image tool without an explicit current-session vision model');
    expect(computerUsePlugin).toContain('Use this before controlling an already-open Chrome/Edge/native desktop app window');
    expect(computerUsePlugin).toContain('Prefer this over blind coordinate clicks');
    expect(computerUsePlugin).toContain('This is for UClaw app windows, not arbitrary external Chrome tabs');
  });

  it('keeps computer-use visual inspection on the current session model first', () => {
    expect(toolsContext).toContain('current session\'s vision-capable model');
    expect(toolsContext).toContain('For UClaw managed `lingzhiwuxian/smart-latest`, use `model: "openai/gpt-5.5"`');
    expect(toolsContext).toContain('OpenClaw\'s default image fallback may try unrelated providers such as Claude');
    expect(computerUsePlugin).toContain('avoid standalone image-tool fallbacks unless you pass the current session vision model explicitly');
    expect(computerUsePlugin).not.toContain('claude-opus-4-8');
  });
});
