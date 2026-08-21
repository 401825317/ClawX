// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  root: '',
  ecommerceSkillVersion: 'v1',
  artifactsEnabled: true,
  htmlPreviewEnabled: true,
  longTermRulesEnabled: true,
  runtimeEpoch: 1,
  runtimeListeners: new Set<(current: unknown, previous: unknown) => void>(),
}));

vi.mock('@electron/services/managed-client-config-service', () => ({
  getManagedClientRuntimeConfigSnapshot: () => ({
    epoch: state.runtimeEpoch,
    verifiedAt: Date.now(),
    config: {
    observability: {
      enabled: false,
      tunnelPath: '/api/clawx/observability/envelope',
      crashSampleRate: 1,
      handledErrorSampleRate: 0.2,
      tracesSampleRate: 0.05,
      artifactSampleRate: 0.2,
      maxEventsPerHour: 30,
    },
    features: {
      artifacts: {
        enabled: state.artifactsEnabled,
        rolloutPercentage: 100,
        modelAlias: 'uclaw-artifact-v1',
        policyVersion: 'v1',
      },
      ecommerceMainImage: {
        enabled: true,
        rolloutPercentage: 100,
        skillVersion: state.ecommerceSkillVersion,
      },
      htmlPreview: { enabled: state.htmlPreviewEnabled },
      longTermRules: { enabled: state.longTermRulesEnabled },
    },
    },
  }),
  subscribeManagedClientRuntimeConfig: (listener: (current: unknown, previous: unknown) => void) => {
    state.runtimeListeners.add(listener);
    return () => state.runtimeListeners.delete(listener);
  },
}));

vi.mock('@electron/utils/installation-id', () => ({
  getOrCreateInstallationId: async () => 'artifact-test-installation',
}));

vi.mock('@electron/utils/paths', () => ({
  resolveOpenClawStateDir: () => state.root,
}));

vi.mock('@electron/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@electron/utils/telemetry', () => ({
  captureHandledException: vi.fn(),
}));

import { ArtifactTaskService } from '@electron/services/artifact-task-service';

function publishHtmlPreviewGate(enabled: boolean): void {
  const previousEnabled = state.htmlPreviewEnabled;
  const previous = {
    epoch: state.runtimeEpoch,
    verifiedAt: Date.now(),
    config: { features: { artifacts: { enabled: true }, htmlPreview: { enabled: previousEnabled } } },
  };
  state.htmlPreviewEnabled = enabled;
  state.runtimeEpoch += 1;
  const current = {
    epoch: state.runtimeEpoch,
    verifiedAt: Date.now(),
    config: { features: { artifacts: { enabled: true }, htmlPreview: { enabled } } },
  };
  for (const listener of state.runtimeListeners) listener(current, previous);
}

describe('ArtifactTaskService', () => {
  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'uclaw-artifact-task-'));
    state.ecommerceSkillVersion = 'v1';
    state.artifactsEnabled = true;
    state.htmlPreviewEnabled = true;
    state.longTermRulesEnabled = true;
    state.runtimeEpoch = 1;
    state.runtimeListeners.clear();
  });

  afterEach(async () => {
    delete process.env.CLAWX_ARTIFACTS_FORCE;
    await rm(state.root, { recursive: true, force: true });
  });

  it('classifies a fast artifact task in place and writes a bounded runtime policy', async () => {
    const service = new ArtifactTaskService();
    const result = await service.prepare({
      sessionKey: 'agent:main:session-empty',
      agentId: 'main',
      workspaceRoot: join(state.root, 'workspace'),
      message: '请创建一份季度总结 PPT。',
      hasHistory: false,
    });

    expect(result).toMatchObject({
      artifactTask: true,
      effectiveSessionKey: 'agent:main:session-empty',
      createSession: false,
      kind: 'presentation',
      intent: 'create',
      mode: 'fast',
      policyVersion: 'v1',
    });
    const policy = service.getPolicy(result.effectiveSessionKey);
    expect(policy).toMatchObject({
      skillId: 'presentation-maker',
      promptContract: 'presentation-maker:v1',
      modelAlias: 'openai/uclaw-artifact-v1',
      thinkingLevel: 'minimal',
      fastMode: true,
      maxRepairs: 1,
      allowNetwork: false,
      allowImageGeneration: false,
      runtimeFeatures: {
        artifacts: true,
        htmlPreview: true,
        longTermRules: true,
      },
    });

    const digest = createHash('sha256').update(result.effectiveSessionKey).digest('hex');
    const persisted = JSON.parse(await readFile(
      join(state.root, 'uclaw', 'artifact-policies', `${digest}.json`),
      'utf8',
    )) as Record<string, unknown>;
    expect(persisted).toMatchObject({ sessionKey: result.effectiveSessionKey, schemaVersion: 1 });
  });

  it('moves unrelated history into a visible artifact session and reuses only an explicitly referenced target', async () => {
    const service = new ArtifactTaskService();
    const created = await service.prepare({
      sessionKey: 'agent:main:session-chat-history',
      agentId: 'main',
      workspaceRoot: join(state.root, 'workspace'),
      message: '新建一个销售数据 Excel 表格。',
      hasHistory: true,
    });

    expect(created.artifactTask).toBe(true);
    expect(created.createSession).toBe(true);
    expect(created.effectiveSessionKey).not.toBe('agent:main:session-chat-history');
    expect(created.kind).toBe('spreadsheet');

    const unrelated = await service.prepare({
      sessionKey: 'agent:main:new-conversation',
      agentId: 'main',
      workspaceRoot: join(state.root, 'workspace'),
      message: '修改一份 Excel，增加利润率列。',
      hasHistory: true,
    });
    expect(unrelated).toMatchObject({
      artifactTask: true,
      createSession: true,
      intent: 'modify',
      kind: 'spreadsheet',
    });
    expect(unrelated.effectiveSessionKey).not.toBe(created.effectiveSessionKey);

    const modified = await service.prepare({
      sessionKey: 'agent:main:new-conversation-2',
      agentId: 'main',
      workspaceRoot: join(state.root, 'workspace'),
      message: '修改刚才的 Excel，增加利润率列。',
      hasHistory: true,
    });
    expect(modified).toMatchObject({
      artifactTask: true,
      effectiveSessionKey: unrelated.effectiveSessionKey,
      intent: 'modify',
      kind: 'spreadsheet',
    });
  });

  it('never reuses another agent\'s artifact session in the same workspace', async () => {
    const service = new ArtifactTaskService();
    const first = await service.prepare({
      sessionKey: 'agent:alpha:session-source',
      agentId: 'alpha',
      workspaceRoot: join(state.root, 'workspace'),
      message: '新建一个销售数据 Excel 表格。',
      hasHistory: true,
    });
    const second = await service.prepare({
      sessionKey: 'agent:beta:session-modify',
      agentId: 'beta',
      workspaceRoot: join(state.root, 'workspace'),
      message: '修改刚才的 Excel，增加利润率列。',
      hasHistory: true,
    });
    expect(second.artifactTask).toBe(true);
    expect(second.effectiveSessionKey).not.toBe(first.effectiveSessionKey);
    expect(second.createSession).toBe(true);
  });

  it('starts a fresh visible artifact session for a new create request with history', async () => {
    const service = new ArtifactTaskService();
    const first = await service.prepare({
      sessionKey: 'agent:main:artifact-existing',
      agentId: 'main',
      workspaceRoot: join(state.root, 'workspace'),
      message: '新建一个销售数据 Excel 表格。',
      hasHistory: true,
    });
    const fresh = await service.prepare({
      sessionKey: first.effectiveSessionKey,
      agentId: 'main',
      workspaceRoot: join(state.root, 'workspace'),
      message: '再新建一份销售数据 Excel 表格。',
      hasHistory: true,
    });
    expect(fresh.artifactTask).toBe(true);
    expect(fresh.createSession).toBe(true);
    expect(fresh.effectiveSessionKey).not.toBe(first.effectiveSessionKey);
  });

  it('fails closed when the remote artifact switch is disabled', async () => {
    state.artifactsEnabled = false;
    const service = new ArtifactTaskService();
    await expect(service.prepare({
      sessionKey: 'agent:main:disabled-artifact',
      agentId: 'main',
      workspaceRoot: join(state.root, 'workspace'),
      message: '新建一个销售数据 Excel 表格。',
      hasHistory: false,
    })).resolves.toEqual({
      artifactTask: false,
      effectiveSessionKey: 'agent:main:disabled-artifact',
      createSession: false,
    });
  });

  it('snapshots HTML preview and long-term-rule kill switches into the runtime policy', async () => {
    state.htmlPreviewEnabled = false;
    state.longTermRulesEnabled = false;
    const service = new ArtifactTaskService();
    const result = await service.prepare({
      sessionKey: 'agent:main:runtime-switches',
      agentId: 'main',
      workspaceRoot: join(state.root, 'workspace'),
      message: '新建一个销售数据 Excel 表格。',
      hasHistory: false,
    });
    expect(service.getPolicy(result.effectiveSessionKey)?.runtimeFeatures).toEqual({
      artifacts: true,
      htmlPreview: false,
      longTermRules: false,
    });
  });

  it('uses refined budgets only for explicit refined intent and ignores ordinary chat', async () => {
    const service = new ArtifactTaskService();
    const refined = await service.prepare({
      sessionKey: 'agent:main:session-refined',
      agentId: 'main',
      workspaceRoot: join(state.root, 'workspace'),
      message: '请精修这个 HTML 页面并搜索素材。',
      hasHistory: false,
    });
    expect(refined.mode).toBe('refined');
    expect(service.getPolicy(refined.effectiveSessionKey)).toMatchObject({
      thinkingLevel: 'high',
      fastMode: false,
      maxRepairs: 2,
      allowNetwork: true,
      allowImageGeneration: true,
    });

    const normal = await service.prepare({
      sessionKey: 'agent:main:session-normal',
      agentId: 'main',
      workspaceRoot: join(state.root, 'workspace'),
      message: '你好，今天怎么样？',
      hasHistory: false,
    });
    expect(normal).toEqual({
      artifactTask: false,
      effectiveSessionKey: 'agent:main:session-normal',
      createSession: false,
    });
  });

  it('recognizes ecommerce main-image work as a versioned image skill', async () => {
    const service = new ArtifactTaskService();
    const result = await service.prepare({
      sessionKey: 'agent:main:session-commerce',
      agentId: 'main',
      workspaceRoot: join(state.root, 'workspace'),
      message: '根据参考图创建一张白底电商主图。',
      hasHistory: false,
    });

    expect(result).toMatchObject({
      artifactTask: true,
      kind: 'ecommerce-main-image',
      mode: 'fast',
      policyVersion: 'v1',
    });
    expect(service.getPolicy(result.effectiveSessionKey)).toMatchObject({
      skillId: 'ecommerce-main-image',
      promptContract: 'ecommerce-main-image:v1',
      allowImageGeneration: true,
    });
  });

  it('fails closed when remote policy references an unbundled prompt contract', async () => {
    state.ecommerceSkillVersion = 'v2';
    const service = new ArtifactTaskService();
    await expect(service.prepare({
      sessionKey: 'agent:main:session-unsupported-commerce',
      agentId: 'main',
      workspaceRoot: join(state.root, 'workspace'),
      message: '创建一张电商主图。',
      hasHistory: false,
    })).resolves.toEqual({
      artifactTask: false,
      effectiveSessionKey: 'agent:main:session-unsupported-commerce',
      createSession: false,
    });
  });

  it('canonicalizes webpage artifacts in Main and rejects files outside the workspace', async () => {
    const workspace = join(state.root, 'workspace');
    const webpage = join(workspace, 'site', 'index.html');
    const outside = join(state.root, 'outside.html');
    await mkdir(join(workspace, 'site'), { recursive: true });
    await writeFile(webpage, '<!doctype html><title>Inside</title>', 'utf8');
    await writeFile(outside, '<!doctype html><title>Outside</title>', 'utf8');
    const service = new ArtifactTaskService();

    const preview = await service.validateWebpage({ workspaceRoot: workspace, filePath: webpage });
    expect(preview).toMatchObject({
      ok: true,
      browserUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{40,}\/index\.html$/u),
    });
    expect(preview).not.toHaveProperty('fileUrl');
    const response = await fetch(preview.browserUrl!);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Inside');
    await service.dispose();
    await expect(service.validateWebpage({ workspaceRoot: workspace, filePath: outside }))
      .resolves.toEqual({ ok: false });
    await expect(service.validateWebpage({ workspaceRoot: workspace, filePath: join(workspace, 'missing.html') }))
      .resolves.toEqual({ ok: false });
  });

  it.each([
    '请创建一份可编辑 CAD 图纸。',
    '生成这个户型的 DXF 文件。',
    '帮我做一张建筑平面图。',
    'Create an editable DWG floor plan drawing.',
  ])('classifies natural-language CAD work and requires the DXF skill: %s', async (message) => {
    const service = new ArtifactTaskService();
    const result = await service.prepare({
      sessionKey: `agent:main:cad-${message.length}`,
      agentId: 'main',
      workspaceRoot: join(state.root, 'workspace'),
      message,
      hasHistory: false,
    });

    expect(result).toMatchObject({
      artifactTask: true,
      kind: 'cad',
      intent: 'create',
      mode: 'fast',
      policyVersion: 'v1',
    });
    expect(service.getPolicy(result.effectiveSessionKey)).toMatchObject({
      kind: 'cad',
      skillId: 'cad-editor',
      promptContract: 'cad-editor:v1',
      allowNetwork: false,
      allowImageGeneration: false,
    });
  });

  it('keeps refined CAD work on the local DXF route without image generation', async () => {
    const service = new ArtifactTaskService();
    const result = await service.prepare({
      sessionKey: 'agent:main:cad-refined',
      agentId: 'main',
      workspaceRoot: join(state.root, 'workspace'),
      message: '请精修这份 CAD 建筑平面图。',
      hasHistory: false,
    });

    expect(result).toMatchObject({ artifactTask: true, kind: 'cad', mode: 'refined' });
    expect(service.getPolicy(result.effectiveSessionKey)).toMatchObject({
      allowNetwork: false,
      allowImageGeneration: false,
    });
  });

  it('replaces an HTML preview without letting the old timeout release the new preview route', async () => {
    const workspace = join(state.root, 'workspace');
    const webpage = join(workspace, 'site', 'index.html');
    await mkdir(join(workspace, 'site'), { recursive: true });
    await writeFile(webpage, '<!doctype html><title>First</title>', 'utf8');
    const service = new ArtifactTaskService();

    const first = await service.validateWebpage({ workspaceRoot: workspace, filePath: webpage });
    await writeFile(webpage, '<!doctype html><title>Second</title>', 'utf8');
    const second = await service.validateWebpage({ workspaceRoot: workspace, filePath: webpage });

    expect(first.browserUrl).not.toBe(second.browserUrl);
    await expect(fetch(first.browserUrl!)).rejects.toThrow();
    await expect(fetch(second.browserUrl!).then((response) => response.text())).resolves.toContain('Second');
    await service.dispose();
  });

  it('rejects HTML larger than 20 MB before serving it', async () => {
    const workspace = join(state.root, 'workspace');
    const webpage = join(workspace, 'oversized.html');
    await mkdir(workspace, { recursive: true });
    await writeFile(webpage, '<!doctype html>', 'utf8');
    await truncate(webpage, (20 * 1024 * 1024) + 1);
    const service = new ArtifactTaskService();

    await expect(service.validateWebpage({ workspaceRoot: workspace, filePath: webpage }))
      .resolves.toEqual({ ok: false });
    await service.dispose();
  });

  it('serializes concurrent replacements so only the latest same-path preview remains reachable', async () => {
    const workspace = join(state.root, 'workspace');
    const webpage = join(workspace, 'index.html');
    await mkdir(workspace, { recursive: true });
    await writeFile(webpage, '<!doctype html><title>Concurrent</title>', 'utf8');
    const service = new ArtifactTaskService();

    const previews = await Promise.all(Array.from({ length: 4 }, () => (
      service.validateWebpage({ workspaceRoot: workspace, filePath: webpage })
    )));
    expect(previews.every((preview) => preview.ok)).toBe(true);
    const reachable = await Promise.all(previews.map(async (preview) => {
      try {
        return (await fetch(preview.browserUrl!)).status === 200;
      } catch {
        return false;
      }
    }));
    expect(reachable.filter(Boolean)).toHaveLength(1);
    await service.dispose();
  });

  it('bounds active previews globally and closes the oldest route', async () => {
    const workspace = join(state.root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ArtifactTaskService();
    const previews = [];
    for (let index = 0; index < 5; index += 1) {
      const webpage = join(workspace, `page-${index}.html`);
      await writeFile(webpage, `<!doctype html><title>Page ${index}</title>`, 'utf8');
      previews.push(await service.validateWebpage({ workspaceRoot: workspace, filePath: webpage }));
    }

    await expect(fetch(previews[0].browserUrl!)).rejects.toThrow();
    for (const preview of previews.slice(1)) {
      await expect(fetch(preview.browserUrl!).then((response) => response.status)).resolves.toBe(200);
    }
    await service.dispose();
  });

  it('does not leave a preview reachable when closeAll races queued starts', async () => {
    const workspace = join(state.root, 'workspace');
    const webpage = join(workspace, 'index.html');
    await mkdir(workspace, { recursive: true });
    await writeFile(webpage, '<!doctype html><title>Cleanup race</title>', 'utf8');
    const service = new ArtifactTaskService();

    const pending = Array.from({ length: 4 }, () => (
      service.validateWebpage({ workspaceRoot: workspace, filePath: webpage })
    ));
    await service.dispose();
    const previews = await Promise.all(pending);
    for (const preview of previews) {
      if (preview.ok) await expect(fetch(preview.browserUrl!)).rejects.toThrow();
    }
  });

  it('stops active previews and refuses a new one when HTML preview is disabled at runtime', async () => {
    const workspace = join(state.root, 'workspace');
    const webpage = join(workspace, 'index.html');
    await mkdir(workspace, { recursive: true });
    await writeFile(webpage, '<!doctype html><title>Runtime gate</title>', 'utf8');
    const service = new ArtifactTaskService();

    const active = await service.validateWebpage({ workspaceRoot: workspace, filePath: webpage });
    expect(active).toMatchObject({ ok: true, browserUrl: expect.any(String) });
    expect(await fetch(active.browserUrl!).then((response) => response.status)).toBe(200);

    publishHtmlPreviewGate(false);
    await vi.waitFor(async () => {
      await expect(fetch(active.browserUrl!)).rejects.toThrow();
    });
    await expect(service.validateWebpage({ workspaceRoot: workspace, filePath: webpage }))
      .resolves.toEqual({ ok: false });
    await service.dispose();
  });

  it('fails closed for HTML preview when the runtime configuration omits the switch', async () => {
    const workspace = join(state.root, 'workspace');
    const webpage = join(workspace, 'index.html');
    await mkdir(workspace, { recursive: true });
    await writeFile(webpage, '<!doctype html><title>No configuration</title>', 'utf8');
    const service = new ArtifactTaskService();
    state.htmlPreviewEnabled = undefined as unknown as boolean;

    await expect(service.validateWebpage({ workspaceRoot: workspace, filePath: webpage }))
      .resolves.toEqual({ ok: false });
    await service.dispose();
  });
});
