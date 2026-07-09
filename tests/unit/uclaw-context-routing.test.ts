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
    expect(toolsContext).toContain('不使用、恢复或建议安装旧的 `uclaw-computer-use`');
    expect(toolsContext).toContain('不要凭空调用未列出的 `computer`、`desktop`、`screen` 等工具');
    expect(toolsContext).not.toContain('UClaw has native computer-use tools');
    expect(toolsContext).not.toContain('switch to UClaw desktop computer-use tools');
    expect(browserAutomationShim).not.toContain('switch to available desktop `computer_*` tools');
  });

  it('routes WeChat and native desktop actions through connector-or-block semantics', () => {
    expect(toolsContext).toContain('`browser` 只控制其托管网页，不等于原生桌面控制');
    expect(toolsContext).toContain('也不能假装操作微信、QQ、系统弹窗或用户已有浏览器窗口');
    expect(toolsContext).toContain('原生应用、外部消息、发布、购买、删除、支付等副作用');
    expect(toolsContext).toContain('当前明确列出且已连接的可靠工具执行');
    expect(toolsContext).toContain('未尝试 / 被阻断 / 仅生成草稿');
    expect(toolsContext).toContain('不能声称已发送或已完成');
    expect(browserAutomationShim).toContain('Do not use the `browser` tool for native desktop apps');
    expect(artifactGuard).toContain('不要使用 shell/盲键鼠/UI 脚本假装完成微信或桌面操作');
  });

  it('directs temporary screenshots into OpenClaw-managed media roots', () => {
    expect(toolsContext).toContain('MEDIA:<absolute-path>');
    expect(artifactGuard).toContain('OpenClaw media/workspace 目录');
    expect(artifactGuard).toContain('~/.openclaw/media/outbound/');
    expect(artifactGuard).toContain('不要写入裸 `/tmp/*.png`');
    expect(artifactGuard).toContain('rewriteTmpScreenshotMediaPaths');
    expect(artifactGuard).toContain('exec-screenshot-path-rewrite');
  });

  it('keeps ordinary public web research on web tools before browser or shell fallbacks', () => {
    expect(toolsContext).toContain('公网检索优先 `web_search`');
    expect(toolsContext).toContain('已知 URL 优先 `web_fetch`');
    expect(toolsContext).toContain('登录态或交互网页才用 `browser`');
    expect(toolsContext).toContain('可恢复错误先自行换路径或重试一次');
  });

  it('keeps web_search out of private logged-in state without inventing desktop fallback', () => {
    expect(toolsContext).toContain('登录态或交互网页才用 `browser`');
    expect(toolsContext).toContain('`browser` 只控制其托管网页');
    expect(toolsContext).toContain('原生应用、外部消息、发布、购买、删除、支付等副作用');
    expect(toolsContext).toContain('否则说明 `未尝试 / 被阻断 / 仅生成草稿`');
  });

  it('prevents local action and artifact tasks from ending with unexecuted promises', () => {
    expect(agentsContext).toContain('**本地动作完成规则**');
    expect(agentsContext).toContain('如果下一步明确，继续调用合适的工具，而不是发送最终回复');
    expect(toolsContext).toContain('### 回复与执行');
    expect(toolsContext).toContain('用户要求执行时先做事');
    expect(toolsContext).toContain('本地动作遵循 `观察 -> 执行 -> 验证 -> 交付`');
    expect(toolsContext).toContain('只有工具证据足够时才能声称已完成');
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
    expect(toolsContext).toContain('默认使用简体中文');
  });

  it('keeps current public lookup tasks useful through web tool routing', () => {
    expect(toolsContext).toContain('公网检索优先 `web_search`');
    expect(toolsContext).toContain('已知 URL 优先 `web_fetch`');
    expect(toolsContext).toContain('读取、分析、搜索、写文件、启动服务等任务使用当前列出的结构化工具');
    expect(toolsContext).toContain('可恢复错误先自行换路径或重试一次');
  });

  it('does not surface the one-window LLM idle retry as a user-visible run error', () => {
    expect(chatStore).toContain('Model call exceeded one idle window');
    expect(chatStore).toContain('keeping run active for gateway/runtime retry');
    expect(chatStore).not.toContain('The model did not respond within 120 seconds. Retrying...');
  });
});
