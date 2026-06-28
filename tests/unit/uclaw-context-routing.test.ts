import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('UClaw tool routing context', () => {
  const toolsContext = readFileSync(join(process.cwd(), 'resources', 'context', 'TOOLS.clawx.md'), 'utf8');
  const computerUsePlugin = readFileSync(
    join(process.cwd(), 'resources', 'openclaw-plugins', 'uclaw-computer-use', 'index.mjs'),
    'utf8',
  );
  const computerUseManifest = readFileSync(
    join(process.cwd(), 'resources', 'openclaw-plugins', 'uclaw-computer-use', 'openclaw.plugin.json'),
    'utf8',
  );
  const chatStore = readFileSync(join(process.cwd(), 'src', 'stores', 'chat.ts'), 'utf8');
  const computerRoutes = readFileSync(join(process.cwd(), 'electron', 'api', 'routes', 'computer.ts'), 'utf8');

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

  it('keeps ordinary public web research on web tools before browser or shell fallbacks', () => {
    expect(toolsContext).toContain('For public search, research, URL reading, current information');
    expect(toolsContext).toContain('prefer `web_search` first');
    expect(toolsContext).toContain('Use `web_fetch` for known URLs');
    expect(toolsContext).toContain('Avoid shell/Python HTTP scraping for ordinary searches');
    expect(toolsContext).toContain('Use `exec` with `curl`/`wttr.in` only as a last fallback');
    expect(toolsContext).toContain('Prefer it over `browser`, `browser-automation`, `exec`, PowerShell');
  });

  it('keeps web_search out of private logged-in account state while preserving it for public discovery', () => {
    expect(toolsContext).toContain('Do not use `web_search` to discover or verify state inside already-open/logged-in/private systems');
    expect(toolsContext).toContain('Those states are not public web facts');
    expect(toolsContext).toContain('Use `browser` for managed logged-in tabs');
    expect(toolsContext).toContain('`computer_web_observe`/desktop `computer_*` tools');
    expect(toolsContext).toContain('If `web_search` returns `web_search is disabled or no provider is available`');
    expect(toolsContext).toContain('treat `web_search` as unavailable for the rest of the current task/run');
    expect(toolsContext).toContain('Do not retry `web_search` with the same or similar query');
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

  it('treats account web automation as UClaw-orchestrated browser plus desktop fallback', () => {
    expect(toolsContext).toContain('Treat `browser` as UClaw\'s high-efficiency web engine');
    expect(toolsContext).toContain('Do not read `browser-automation/SKILL.md` from `node_modules/openclaw/skills`');
    expect(toolsContext).toContain('For logged-in business web tasks such as Douyin/TikTok private messages');
    expect(toolsContext).toContain('WeChat Official Account publishing');
    expect(toolsContext).toContain('ecommerce product listing/unlisting');
    expect(toolsContext).toContain('If the task can run in a healthy managed browser that is already logged in');
    expect(toolsContext).toContain('If managed browser is not logged in');
    expect(toolsContext).toContain('`profile="user"` attach fails');
    expect(toolsContext).toContain('`DevToolsActivePort`/`Could not connect to Chrome`');
    expect(toolsContext).toContain('switch to UClaw desktop computer-use tools');
    expect(toolsContext).toContain('Do not expose recoverable intermediate browser errors to the user as final failure');
  });

  it('requires observe-act-verify loops and narrow recovery for long computer-use tasks', () => {
    expect(toolsContext).toContain('UClaw computer use is the user-facing automation runtime');
    expect(toolsContext).toContain('Work in an observe -> act -> verify loop');
    expect(toolsContext).toContain('After every mutating browser, mouse, keyboard, DOM, or UIA action');
    expect(toolsContext).toContain('Do not keep acting from stale refs or old screenshots');
    expect(toolsContext).toContain('For long automation tasks, treat provider idle retries');
    expect(toolsContext).toContain('targetId mismatch');
    expect(toolsContext).toContain('action targetId must match request targetId');
    expect(toolsContext).toContain('prefer its raw `targetId`');
    expect(toolsContext).toContain('stop repeating that failure shape');
    expect(toolsContext).toContain('missing input refs as recoverable signals');
    expect(toolsContext).toContain('Do not tell the user the task failed while the runtime is still making progress');
  });

  it('keeps screenshot coordinate metadata in the primary computer-use path', () => {
    expect(toolsContext).toContain('Screenshot tools return `width`, `height`, and `coordinateMapping` metadata');
    expect(toolsContext).toContain('Do not run Python/PIL, shell scripts, `file`, or ad-hoc image parsers');
    expect(computerRoutes).toContain('width: imageSize.width');
    expect(computerRoutes).toContain('height: imageSize.height');
    expect(computerRoutes).toContain('coordinateMapping');
    expect(computerRoutes).toContain('formula: `screenX = ');
    expect(computerUsePlugin).toContain('coordinateMapping');
    expect(computerUsePlugin).toContain('Never run Python/PIL just to read image dimensions');
    expect(computerUsePlugin).toContain('width, height, display bounds, scale factor, and coordinateMapping');
  });

  it('blocks address-bar javascript injection as a desktop observation strategy', () => {
    expect(toolsContext).toContain('Do not paste `javascript:` URLs into a browser address bar');
    expect(toolsContext).toContain('Use available browser/DOM/UIA/observe tools');
    expect(computerRoutes).toContain('looksLikeAddressBarScript');
    expect(computerRoutes).toContain('Typing javascript: URLs is blocked for computer-use safety');
    expect(computerRoutes).toContain('Typing javascript: URLs into a browser address bar is unsafe and unreliable');
    expect(computerUsePlugin).toContain('Never paste javascript: URLs into a browser address bar');
  });

  it('describes computer-use plugin tools as native desktop controls', () => {
    expect(computerUsePlugin).toContain('Native UClaw computer-use tools');
    expect(computerUsePlugin).toContain('computer_browser_open_url');
    expect(computerUsePlugin).toContain('computer_web_observe');
    expect(computerUseManifest).toContain('computer_web_observe');
    expect(computerUsePlugin).toContain('Observe an external browser window such as Chrome, Edge, Brave, Chromium, Firefox, Opera, or Vivaldi');
    expect(computerUsePlugin).toContain('EXPECTED_FOREGROUND_SCHEMA');
    expect(computerUsePlugin).toContain('the host refuses input if another window is foreground');
    expect(computerUsePlugin).toContain('Open an absolute http/https URL in the system default browser');
    expect(computerUsePlugin).toContain('visual context for the current chat model');
    expect(computerUsePlugin).toContain('Do not call the standalone image tool without an explicit current-session vision model');
    expect(computerUsePlugin).toContain('Use this before controlling an already-open Chrome/Edge/native desktop app window');
    expect(computerUsePlugin).toContain('Prefer this over blind coordinate clicks');
    expect(computerUsePlugin).toContain('This is for UClaw app windows, not arbitrary external Chrome tabs');
  });

  it('uses aggregated external-browser observation before visual guessing', () => {
    expect(toolsContext).toContain('external browser windows such as Chrome, Edge, Brave, Chromium, Firefox, Opera, or Vivaldi');
    expect(toolsContext).toContain('prefer `computer_web_observe` as the first observation step');
    expect(toolsContext).toContain('clickable/editable candidates with bounds/centers');
    expect(computerRoutes).toContain('/api/computer/web/observe');
    expect(computerRoutes).toContain('observeExternalBrowser');
    expect(computerRoutes).toContain('inferBrowserLocation');
    expect(computerRoutes).toContain('extractWebObserveCandidates');
    expect(computerRoutes).toContain('ValuePattern');
  });

  it('keeps computer-use visual inspection on the current session model first', () => {
    expect(toolsContext).toContain('current session\'s vision-capable model');
    expect(toolsContext).toContain('For UClaw managed `lingzhiwuxian/smart-latest`, use `model: "openai/gpt-5.5"`');
    expect(toolsContext).toContain('OpenClaw\'s default image fallback may try unrelated providers such as Claude');
    expect(computerUsePlugin).toContain('avoid standalone image-tool fallbacks unless you pass the current session vision model explicitly');
    expect(computerUsePlugin).not.toContain('claude-opus-4-8');
  });

  it('does not surface the one-window LLM idle retry as a user-visible run error', () => {
    expect(chatStore).toContain('Model call exceeded one idle window');
    expect(chatStore).toContain('keeping run active for gateway/runtime retry');
    expect(chatStore).not.toContain('The model did not respond within 120 seconds. Retrying...');
  });
});
