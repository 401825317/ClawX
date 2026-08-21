// @vitest-environment node

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const previewModulePath = '../../resources/openclaw-plugins/uclaw-local-artifacts/workspace-http-preview.mjs';
const pluginModulePath = '../../resources/openclaw-plugins/uclaw-local-artifacts/index.mjs';

describe('uclaw-local-artifacts workspace HTML preview', () => {
  const tempRoots: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'uclaw-html-preview-'));
    tempRoots.push(root);
    const workspace = path.join(root, 'workspace');
    mkdirSync(workspace);
    const filePath = path.join(workspace, 'app.html');
    writeFileSync(filePath, '<!doctype html><title>Safe preview</title><h1>Ready</h1>', 'utf8');
    return { root, workspace, filePath };
  }

  it('serves only the tokenized exact HTML route over loopback GET and HEAD', async () => {
    const previewModule = await import(previewModulePath);
    const { workspace, filePath } = fixture();
    const preview = await previewModule.startWorkspaceHtmlPreview({ workspaceDir: workspace, filePath });
    closers.push(() => preview.close('test_cleanup'));

    expect(preview.browserUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{40,}\/index\.html$/u);
    const response = await fetch(preview.browserUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(await response.text()).toContain('Safe preview');

    const head = await fetch(preview.browserUrl, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await fetch(new URL('/wrong/index.html', preview.browserUrl))).status).toBe(404);
    expect((await fetch(preview.browserUrl, { method: 'POST' })).status).toBe(405);
  });

  it('accepts file URLs as source input but never returns a file URL to browser', async () => {
    const previewModule = await import(previewModulePath);
    const { workspace, filePath } = fixture();
    const preview = await previewModule.startWorkspaceHtmlPreview({
      workspaceDir: workspace,
      filePath: pathToFileURL(filePath).href,
    });
    closers.push(() => preview.close('test_cleanup'));

    expect(preview.browserUrl.startsWith('http://127.0.0.1:')).toBe(true);
    expect(preview.browserUrl.startsWith('file:')).toBe(false);
  });

  it('rejects outside-workspace paths, non-HTML files, and symlink escapes with recoverable errors', async () => {
    const previewModule = await import(previewModulePath);
    const { root, workspace } = fixture();
    const outside = path.join(root, 'outside.html');
    writeFileSync(outside, '<h1>private</h1>', 'utf8');

    await expect(previewModule.startWorkspaceHtmlPreview({ workspaceDir: workspace, filePath: outside }))
      .rejects.toMatchObject({
        code: 'workspace_preview_outside_workspace',
        recoverable: true,
        restartGateway: false,
      });

    const textPath = path.join(workspace, 'notes.txt');
    writeFileSync(textPath, 'not html', 'utf8');
    await expect(previewModule.startWorkspaceHtmlPreview({ workspaceDir: workspace, filePath: textPath }))
      .rejects.toMatchObject({ code: 'workspace_preview_not_html' });

    const linkPath = path.join(workspace, 'linked.html');
    try {
      symlinkSync(outside, linkPath, 'file');
      await expect(previewModule.startWorkspaceHtmlPreview({ workspaceDir: workspace, filePath: linkPath }))
        .rejects.toMatchObject({ code: 'workspace_preview_outside_workspace' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  });

  it('closes the loopback server on idle timeout and AbortSignal without holding active work', async () => {
    const previewModule = await import(previewModulePath);
    const { workspace, filePath } = fixture();
    const idlePreview = await previewModule.startWorkspaceHtmlPreview({
      workspaceDir: workspace,
      filePath,
      idleTtlMs: 60,
      maxLifetimeMs: 200,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(idlePreview.closed).toBe(true);
    expect(idlePreview.closeReason).toBe('idle_timeout');
    await expect(fetch(idlePreview.browserUrl)).rejects.toThrow();

    const controller = new AbortController();
    const abortedPreview = await previewModule.startWorkspaceHtmlPreview({
      workspaceDir: workspace,
      filePath,
      signal: controller.signal,
      idleTtlMs: 1000,
    });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(abortedPreview.closed).toBe(true);
    expect(abortedPreview.closeReason).toBe('aborted');
    await expect(fetch(abortedPreview.browserUrl)).rejects.toThrow();
    expect(previewModule.__test.activePreviews.size).toBe(0);
  });

  it('fails closed when cancellation races preview authorization or listen startup', async () => {
    const previewModule = await import(previewModulePath);
    const { workspace, filePath } = fixture();
    const controller = new AbortController();
    const starting = previewModule.startWorkspaceHtmlPreview({
      workspaceDir: workspace,
      filePath,
      signal: controller.signal,
    });
    controller.abort();

    await expect(starting).rejects.toMatchObject({
      code: 'workspace_preview_aborted',
      recoverable: true,
      restartGateway: false,
    });
    await vi.waitFor(() => expect(previewModule.__test.activePreviews.size).toBe(0));
    expect(previewModule.__test.activePreviewRecords.size).toBe(0);
  });

  it('rejects oversized HTML before serving it and caps concurrent preview ports', async () => {
    const previewModule = await import(previewModulePath);
    const { workspace } = fixture();
    const oversized = path.join(workspace, 'oversized.html');
    writeFileSync(oversized, Buffer.alloc(20 * 1024 * 1024 + 1, 0x20));
    await expect(previewModule.startWorkspaceHtmlPreview({ workspaceDir: workspace, filePath: oversized }))
      .rejects.toMatchObject({ code: 'workspace_preview_too_large' });

    const previews = [];
    for (let index = 0; index < 9; index += 1) {
      const filePath = path.join(workspace, `preview-${index}.html`);
      writeFileSync(filePath, `<title>${index}</title>`, 'utf8');
      const preview = await previewModule.startWorkspaceHtmlPreview({ workspaceDir: workspace, filePath });
      previews.push(preview);
      closers.push(() => preview.close('test_cleanup'));
    }
    expect(previewModule.__test.activePreviews.size).toBe(8);
    expect(previewModule.__test.activePreviewBytes).toBeGreaterThan(0);
    expect(previews[0].closed).toBe(true);
    expect(previews[0].closeReason).toBe('capacity_replaced');
    await expect(fetch(previews[0].browserUrl)).rejects.toThrow();
    expect(await fetch(previews.at(-1)!.browserUrl).then((response) => response.status)).toBe(200);
  });

  it('returns a stable recoverable tool error instead of recommending a Gateway restart', async () => {
    const plugin = await import(pluginModulePath);
    const { root, workspace } = fixture();
    const outside = path.join(root, 'outside.html');
    writeFileSync(outside, '<h1>outside</h1>', 'utf8');
    const tool = plugin.__test.createTools().find((candidate: { name: string }) => candidate.name === 'prepare_workspace_html_preview');

    const result = await tool.execute(
      'preview-call-1',
      { filePath: outside },
      new AbortController().signal,
      undefined,
      { cwd: workspace },
    );

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      ok: false,
      code: 'workspace_preview_outside_workspace',
      recoverable: true,
      restartGateway: false,
      kind: 'webpage',
    });
  });

  it('allows only the owning run token through Browser and closes it on terminal failure', async () => {
    const previewModule = await import(previewModulePath);
    const plugin = await import(pluginModulePath);
    const { workspace, filePath } = fixture();
    const owner = { runId: 'run-preview', sessionKey: 'session-preview', sessionId: 'conversation-preview' };
    const preview = await previewModule.startWorkspaceHtmlPreview({
      workspaceDir: workspace,
      filePath,
      owner,
    });
    closers.push(() => preview.close('test_cleanup'));

    const hooks = new Map<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>();
    plugin.default.register({
      registerTool() {},
      on(name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown) {
        hooks.set(name, handler);
      },
      lifecycle: { registerRuntimeLifecycle() {} },
    });
    const beforeToolCall = hooks.get('before_tool_call')!;
    const afterToolCall = hooks.get('after_tool_call')!;

    expect(await beforeToolCall({
      toolName: 'browser',
      runId: owner.runId,
      params: { action: 'open', targetUrl: preview.browserUrl, target: 'node', node: 'remote' },
    }, owner)).toEqual({
      params: {
        action: 'open',
        targetUrl: preview.browserUrl,
        target: 'host',
        profile: 'openclaw',
      },
    });
    expect(await beforeToolCall({
      toolName: 'browser',
      runId: 'other-run',
      params: { action: 'navigate', targetUrl: preview.browserUrl },
    }, { sessionKey: 'other-session' })).toMatchObject({
      block: true,
      blockReason: expect.stringContaining('browser_loopback_not_authorized'),
    });
    expect(await beforeToolCall({
      toolName: 'browser',
      params: { action: 'open', targetUrl: 'file:///workspace/page.html' },
    }, owner)).toMatchObject({
      block: true,
      blockReason: expect.stringContaining('browser_file_requires_workspace_preview'),
    });
    expect(await beforeToolCall({
      toolName: 'browser',
      params: { action: 'open', targetUrl: 'http://127.0.0.1:6553/admin' },
    }, owner)).toMatchObject({
      block: true,
      blockReason: expect.stringContaining('browser_loopback_not_authorized'),
    });

    await afterToolCall({
      toolName: 'browser',
      runId: owner.runId,
      params: { action: 'navigate' },
      error: 'timed out',
    }, owner);
    expect(preview.closed).toBe(true);
    expect(preview.closeReason).toBe('browser_tool_failed');
    expect(previewModule.__test.activePreviews.size).toBe(0);
    await expect(fetch(preview.browserUrl)).rejects.toThrow();
  });

  it('cleans only the matching session previews when an agent run ends', async () => {
    const previewModule = await import(previewModulePath);
    const plugin = await import(pluginModulePath);
    const { workspace, filePath } = fixture();
    const first = await previewModule.startWorkspaceHtmlPreview({
      workspaceDir: workspace,
      filePath,
      owner: { sessionKey: 'session-one' },
    });
    const second = await previewModule.startWorkspaceHtmlPreview({
      workspaceDir: workspace,
      filePath,
      owner: { sessionKey: 'session-two' },
    });
    closers.push(() => first.close('test_cleanup'), () => second.close('test_cleanup'));
    const hooks = new Map<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>();
    plugin.default.register({
      registerTool() {},
      on(name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown) {
        hooks.set(name, handler);
      },
      lifecycle: { registerRuntimeLifecycle() {} },
    });

    await hooks.get('agent_end')?.({}, { sessionKey: 'session-one' });
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(await fetch(second.browserUrl).then((response) => response.status)).toBe(200);
  });
});
