import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

async function loadGuard() {
  return await import(
    `${join(process.cwd(), 'resources', 'openclaw-plugins', 'uclaw-artifact-guard', 'index.mjs')}?t=${Date.now()}-${Math.random()}`
  );
}

function registerFinalizeHook(pluginModule: { default: { register(api: unknown): void } }) {
  let finalizeHook: ((event: unknown) => unknown) | null = null;
  pluginModule.default.register({
    registerHook(name: string, handler: (event: unknown) => unknown) {
      if (name === 'before_agent_finalize') {
        finalizeHook = handler;
      }
    },
  });
  expect(finalizeHook).toBeTypeOf('function');
  return finalizeHook!;
}

describe('uclaw-artifact-guard', () => {
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
