import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadGuard() {
  return await import(
    `${join(process.cwd(), 'resources', 'openclaw-plugins', 'uclaw-artifact-guard', 'index.mjs')}?t=${Date.now()}-${Math.random()}`
  );
}

type HookHandler = (event: unknown) => unknown;

function registerHooks(pluginModule: { default: { register(api: unknown): void } }) {
  const hooks = new Map<string, HookHandler>();
  pluginModule.default.register({
    registerHook(name: string, handler: HookHandler) {
      hooks.set(name, handler);
    },
  });
  return hooks;
}

function registerFinalizeHook(pluginModule: { default: { register(api: unknown): void } }) {
  const finalizeHook = registerHooks(pluginModule).get('before_agent_finalize');
  expect(finalizeHook).toBeTypeOf('function');
  return finalizeHook!;
}

describe('uclaw-artifact-guard', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects Chinese and artifact delivery rules before prompt build', async () => {
    const pluginModule = await loadGuard();
    const hooks = registerHooks(pluginModule);
    const promptHook = hooks.get('before_prompt_build');

    expect(promptHook).toBeTypeOf('function');
    const result = promptHook!({ runId: 'run-prompt-context' }) as { appendSystemContext?: string };

    expect(result.appendSystemContext).toContain('简体中文');
    expect(result.appendSystemContext).toContain('真实本地产物');
    expect(result.appendSystemContext).toContain('MEDIA:<absolute-path>');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('prompt-context'));
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('做个电站维保'));
  });

  it('classifies promise-only artifact replies as revision candidates', async () => {
    const pluginModule = await loadGuard();

    const analysis = pluginModule.__test.analyzeArtifactFinal({
      messages: [
        { role: 'user', content: '帮我生成一份产品介绍 PPT' },
        { role: 'assistant', content: '我会生成一份 PPT，并整理好页面结构。' },
      ],
    });

    expect(analysis).toMatchObject({
      artifactRequest: true,
      artifactEvidence: false,
      explicitBlocker: false,
      promiseOnly: true,
      shouldRevise: true,
    });
  });

  it('retries artifact requests that end with an unexecuted promise', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);

    const result = finalizeHook({
      finalPromptText: '做个电站维保的招投标书，做20页',
      lastAssistantMessage: '我会生成一份真实的 Word 标书文件，按 20 页结构排版，并用分页符控制页数。',
      messages: [
        { role: 'user', content: '做个电站维保的招投标书，做20页' },
        { role: 'assistant', content: '我会生成一份真实的 Word 标书文件，按 20 页结构排版，并用分页符控制页数。' },
      ],
    }) as { action?: string; retry?: { instruction?: string; maxAttempts?: number }; reason?: string } | undefined;

    expect(result?.action).toBe('revise');
    expect(result?.reason).toContain('artifact delivery');
    expect(result?.retry?.instruction).toContain('真实本地产物');
    expect(result?.retry?.instruction).toContain('Node/Python/uv');
    expect(result?.retry?.instruction).toContain('MEDIA:<absolute-path>');
    expect(result?.retry?.maxAttempts).toBe(2);
  });

  it('allows artifact replies that include a concrete file path', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);

    const result = finalizeHook({
      messages: [
        { role: 'user', content: '做个电站维保的招投标书，做20页' },
        {
          role: 'assistant',
          content: '已生成。\n\nMEDIA:/Users/me/Downloads/UClaw/电站维保招投标书.docx',
        },
      ],
    });

    expect(result).toBeUndefined();
  });

  it('allows explicit blockers instead of looping forever', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);

    const result = finalizeHook({
      messages: [
        { role: 'user', content: '做个电站维保的招投标书，做20页' },
        {
          role: 'assistant',
          content: '无法继续：已尝试使用 Node/Python 生成 DOCX，但当前环境缺少写入权限，需要你确认输出目录。',
        },
      ],
    });

    expect(result).toBeUndefined();
  });

  it('ignores ordinary chat promises', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);

    const result = finalizeHook({
      messages: [
        { role: 'user', content: '你明天能提醒我吗？' },
        { role: 'assistant', content: '我会提醒你。' },
      ],
    });

    expect(result).toBeUndefined();
  });
});
