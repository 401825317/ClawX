import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('UClaw tool routing context', () => {
  const agentsContext = readFileSync(join(process.cwd(), 'resources', 'context', 'AGENTS.clawx.md'), 'utf8');
  const toolsContext = readFileSync(join(process.cwd(), 'resources', 'context', 'TOOLS.clawx.md'), 'utf8');
  const browserAutomationShim = readFileSync(
    join(process.cwd(), 'resources', 'openclaw-skill-shims', 'browser-automation', 'SKILL.md'),
    'utf8',
  );
  const artifactGuard = readFileSync(
    join(process.cwd(), 'resources', 'openclaw-plugins', 'uclaw-artifact-guard', 'index.mjs'),
    'utf8',
  );
  const finalizePatchScript = readFileSync(
    join(process.cwd(), 'scripts', 'openclaw-finalize-local-action-patch.mjs'),
    'utf8',
  );
  const chatStore = readFileSync(join(process.cwd(), 'src', 'stores', 'chat.ts'), 'utf8');
  const openClawWorkspaceSource = readFileSync(join(process.cwd(), 'electron', 'utils', 'openclaw-workspace.ts'), 'utf8');
  const localArtifactToolNames = [
    'create_pptx_file',
    'create_docx_file',
    'create_xlsx_file',
    'create_text_file',
    'create_html_app_file',
  ];

  it('does not advertise the legacy computer-use plugin as a reliable desktop path', () => {
    expect(toolsContext).toContain('The legacy `uclaw-computer-use` plugin is not part of the reliable execution surface');
    expect(toolsContext).toContain('do not mention enabling that plugin as the recovery path');
    expect(toolsContext).toContain('Do not assume `computer_*` tools exist');
    expect(toolsContext).not.toContain('UClaw has native computer-use tools');
    expect(toolsContext).not.toContain('switch to UClaw desktop computer-use tools');
    expect(browserAutomationShim).not.toContain('switch to available desktop `computer_*` tools');
  });

  it('routes WeChat and native desktop actions through connector-or-block semantics', () => {
    expect(toolsContext).toContain('For requests such as "打开微信并给某个群发消息"');
    expect(toolsContext).toContain('reliable path is a listed structured channel connector');
    expect(toolsContext).toContain('If that connector is absent or the target cannot be resolved');
    expect(toolsContext).toContain('State the blocker');
    expect(toolsContext).toContain('drafted only');
    expect(toolsContext).toContain('actually sent/posted/submitted');
    expect(toolsContext).toContain('Shell commands are not a substitute for reliable desktop UI automation of native chat apps');
  });

  it('directs temporary screenshots into OpenClaw-managed media roots', () => {
    expect(toolsContext).toContain('save it under an OpenClaw media/workspace directory');
    expect(toolsContext).toContain('~/.openclaw/media/outbound/');
    expect(toolsContext).toContain('not directly under `/tmp/*.png`');
    expect(toolsContext).toContain('Local media tools reject bare system-temp image paths');
    expect(artifactGuard).toContain('rewriteTmpScreenshotMediaPaths');
    expect(artifactGuard).toContain('exec-screenshot-path-rewrite');
  });

  it('keeps ordinary public web research on web tools before browser or shell fallbacks', () => {
    expect(toolsContext).toContain('For public search, research, URL reading, current information');
    expect(toolsContext).toContain('prefer `web_search` first');
    expect(toolsContext).toContain('Use `web_fetch` for known URLs');
    expect(toolsContext).toContain('Avoid shell/Python HTTP scraping for ordinary searches');
    expect(toolsContext).toContain('Use `exec` with `curl`/`wttr.in` only as a last fallback');
  });

  it('keeps web_search out of private logged-in state without inventing desktop fallback', () => {
    expect(toolsContext).toContain('Do not use `web_search` to discover or verify state inside already-open/logged-in/private systems');
    expect(toolsContext).toContain('Those states are not public web facts');
    expect(toolsContext).toContain('Use `browser` only for managed logged-in tabs');
    expect(toolsContext).toContain('or a listed structured connector for the relevant channel/app');
    expect(toolsContext).toContain('If neither exists, report the missing capability');
  });

  it('prevents local action and artifact tasks from ending with unexecuted promises', () => {
    expect(agentsContext).toContain('**本地动作完成规则**');
    expect(agentsContext).toContain('如果下一步明确，继续调用合适的工具，而不是发送最终回复');
    expect(toolsContext).toContain('### Local Actions');
    expect(toolsContext).toContain('do not end with a future-tense promise');
    expect(toolsContext).toContain('Only send the final reply after that state is verified');
    expect(toolsContext).toContain('Native desktop app operations and external chat-message sending require a reliable listed connector');
    expect(artifactGuard).toContain('before_agent_finalize');
    expect(artifactGuard).toContain('before_prompt_build');
    expect(artifactGuard).toContain('真实本地产物');
    expect(artifactGuard).toContain('DESKTOP_ACTION_REQUEST_RE');
    expect(artifactGuard).toContain('STRUCTURED_CONNECTOR_TOOL_RE');
    expect(artifactGuard).toContain('不要建议启用 uclaw-computer-use');
    expect(finalizePatchScript).toContain('allowUclawLocalActionRevisionAfterSideEffect');
  });

  it('describes the bundled local artifact plugin and tool surface in context', () => {
    const combinedContext = `${agentsContext}\n${toolsContext}`;

    expect(combinedContext).toContain('uclaw-local-artifacts');
    for (const toolName of localArtifactToolNames) {
      expect(agentsContext).toContain(`\`${toolName}\``);
      expect(toolsContext).toContain(`\`${toolName}\``);
    }
  });

  it('keeps UClaw workspace context merge enabled unless explicitly disabled', () => {
    expect(openClawWorkspaceSource).toContain('CLAWX_DISABLE_CONTEXT_MERGE');
    expect(openClawWorkspaceSource).toContain("CLAWX_ENABLE_CONTEXT_MERGE === '0'");
    expect(openClawWorkspaceSource).not.toContain("CLAWX_ENABLE_CONTEXT_MERGE === '1'");
  });

  it('forces user-facing replies to Simplified Chinese', () => {
    expect(agentsContext).toContain('**语言规则（强制）**');
    expect(agentsContext).toContain('默认所有面向用户的自然语言回复都必须使用简体中文');
    expect(agentsContext).toContain('禁止用英文写状态、计划、总结、道歉、解释、问题或最终回复');
    expect(toolsContext).toContain('解释工具可用性、缺失工具、重试、失败、进度或最终结果时，默认必须使用简体中文');
  });

  it('keeps weather useful when explicit user location is missing', () => {
    expect(toolsContext).toContain('If the user asks for weather without naming a city');
    expect(toolsContext).toContain('if `nodes` returns an empty list, do not stop there');
    expect(toolsContext).toContain('try IP-based weather lookup with `web_fetch`');
    expect(toolsContext).toContain('Ask the user for a city only after location metadata, connected node location, and IP/web fallback');
  });

  it('does not surface the one-window LLM idle retry as a user-visible run error', () => {
    expect(chatStore).toContain('Model call exceeded one idle window');
    expect(chatStore).toContain('keeping run active for gateway/runtime retry');
    expect(chatStore).not.toContain('The model did not respond within 120 seconds. Retrying...');
  });
});
