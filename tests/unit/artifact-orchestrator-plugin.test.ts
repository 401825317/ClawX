// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Hook = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;

const hooks = new Map<string, Hook>();
let stateDirectory = '';
let workspaceRoot = '';

function policyPath(sessionKey: string): string {
  const digest = createHash('sha256').update(sessionKey).digest('hex');
  return join(stateDirectory, 'uclaw', 'artifact-policies', `${digest}.json`);
}

function createPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sessionKey: 'agent:main:artifact-test',
    workspaceRoot,
    kind: 'presentation',
    intent: 'create',
    mode: 'fast',
    skillId: 'presentation-maker',
    promptContract: 'presentation-maker:v1',
    modelAlias: 'openai/uclaw-artifact-v1',
    thinkingLevel: 'minimal',
    fastMode: true,
    maxRepairs: 1,
    allowNetwork: false,
    allowImageGeneration: false,
    preparedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

async function writePolicy(policy: Record<string, unknown>): Promise<void> {
  const sessionKey = String(policy.sessionKey);
  const destination = policyPath(sessionKey);
  await mkdir(join(stateDirectory, 'uclaw', 'artifact-policies'), { recursive: true });
  await writeFile(destination, JSON.stringify(policy), 'utf8');
}

describe('UClaw artifact orchestrator plugin', () => {
  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'uclaw-artifact-orchestrator-'));
    workspaceRoot = join(stateDirectory, 'workspace');
    process.env.OPENCLAW_STATE_DIR = stateDirectory;
    hooks.clear();
    const plugin = await import('../../resources/openclaw-plugins/uclaw-artifact-orchestrator/index.mjs');
    plugin.default.register({
      on(name: string, handler: Hook) {
        hooks.set(name, handler);
      },
    });
  });

  afterEach(async () => {
    delete process.env.OPENCLAW_STATE_DIR;
    await rm(stateDirectory, { recursive: true, force: true });
  });

  it('locks the model and appends the versioned contract only for a valid in-workspace policy', async () => {
    const policy = createPolicy();
    await writePolicy(policy);
    const context = {
      sessionKey: policy.sessionKey,
      workspaceDir: join(workspaceRoot, 'slides'),
    };

    expect(await hooks.get('before_model_resolve')?.({}, context)).toEqual({
      providerOverride: 'openai',
      modelOverride: 'uclaw-artifact-v1',
    });
    expect(await hooks.get('before_prompt_build')?.({}, context)).toEqual({
      appendSystemContext: expect.stringContaining('presentation-maker:v1'),
    });

    await writePolicy(createPolicy({ expiresAt: new Date(Date.now() - 1_000).toISOString() }));
    expect(await hooks.get('before_model_resolve')?.({}, context)).toBeUndefined();

    await writePolicy(createPolicy({ targetFile: join(stateDirectory, 'outside.pptx') }));
    expect(await hooks.get('before_prompt_build')?.({}, context)).toBeUndefined();

    await writePolicy(createPolicy());
    expect(await hooks.get('before_model_resolve')?.({}, {
      ...context,
      workspaceDir: join(stateDirectory, 'other-workspace'),
    })).toBeUndefined();
  });

  it('uses a strict fast-mode allowlist and permits only the task-local renderer', async () => {
    const policy = createPolicy();
    await writePolicy(policy);
    const context = { sessionKey: policy.sessionKey, runId: 'fast-permissions', workspaceDir: workspaceRoot };

    expect(await hooks.get('before_tool_call')?.({ toolName: 'web_search' }, context))
      .toMatchObject({ block: true });
    expect(await hooks.get('before_tool_call')?.({ toolName: 'powershell' }, context))
      .toMatchObject({ block: true });
    expect(await hooks.get('before_tool_call')?.({ toolName: 'image_generate' }, context))
      .toMatchObject({ block: true });
    expect(await hooks.get('before_tool_call')?.({ toolName: 'browser' }, context))
      .toMatchObject({ block: true });
    expect(await hooks.get('before_tool_call')?.({ toolName: 'download_file' }, context))
      .toMatchObject({ block: true });
    expect(await hooks.get('before_tool_call')?.({ toolName: 'custom_asset_helper' }, context))
      .toMatchObject({ block: true });
    expect(await hooks.get('before_tool_call')?.({ toolName: 'create_designed_pptx_file' }, context))
      .toBeUndefined();
    expect(await hooks.get('before_tool_call')?.({ toolName: 'create_pptx_file' }, context))
      .toMatchObject({ block: true, blockReason: expect.stringContaining('initial artifact render budget') });
  });

  it('allows image generation only as the explicit ecommerce renderer', async () => {
    const policy = createPolicy({
      sessionKey: 'agent:main:ecommerce-test',
      kind: 'ecommerce-main-image',
      skillId: 'ecommerce-main-image',
      promptContract: 'ecommerce-main-image:v1',
      allowImageGeneration: true,
    });
    await writePolicy(policy);
    const context = { sessionKey: policy.sessionKey, runId: 'fast-budget', workspaceDir: workspaceRoot };

    expect(await hooks.get('before_tool_call')?.({ toolName: 'image_generate' }, context)).toBeUndefined();
    expect(await hooks.get('before_tool_call')?.({ toolName: 'image_generate' }, context))
      .toMatchObject({ block: true, blockReason: expect.stringContaining('initial artifact render budget') });
    expect(await hooks.get('before_tool_call')?.({ toolName: 'image_generate_proxy' }, context))
      .toMatchObject({ block: true });

    await hooks.get('agent_end')?.({}, context);
    expect(await hooks.get('before_tool_call')?.({ toolName: 'image_generate' }, context)).toBeUndefined();
  });

  it('forces CAD work through create_dxf_file and blocks image substitutes', async () => {
    const policy = createPolicy({
      sessionKey: 'agent:main:cad-test',
      kind: 'cad',
      skillId: 'cad-editor',
      promptContract: 'cad-editor:v1',
    });
    await writePolicy(policy);
    const context = { sessionKey: policy.sessionKey, runId: 'cad-budget', workspaceDir: workspaceRoot };

    expect(await hooks.get('before_prompt_build')?.({}, context)).toEqual({
      appendSystemContext: expect.stringContaining('must call create_dxf_file'),
    });
    expect(await hooks.get('before_tool_call')?.({ toolName: 'image_generate' }, context))
      .toMatchObject({ block: true });
    expect(await hooks.get('before_tool_call')?.({ toolName: 'create_html_app_file' }, context))
      .toMatchObject({ block: true });
    expect(await hooks.get('before_tool_call')?.({ toolName: 'create_dxf_file' }, context))
      .toBeUndefined();
    expect(await hooks.get('before_tool_call')?.({ toolName: 'create_dxf_file' }, context))
      .toMatchObject({ block: true, blockReason: expect.stringContaining('initial artifact render budget') });
  });

  it('rejects a CAD policy that attempts to enable image generation', async () => {
    const policy = createPolicy({
      sessionKey: 'agent:main:cad-image-bypass',
      kind: 'cad',
      skillId: 'cad-editor',
      promptContract: 'cad-editor:v1',
      allowImageGeneration: true,
    });
    await writePolicy(policy);
    const context = { sessionKey: policy.sessionKey, runId: 'cad-invalid', workspaceDir: workspaceRoot };

    expect(await hooks.get('before_tool_call')?.({ toolName: 'image_generate' }, context)).toBeUndefined();
    expect(await hooks.get('before_tool_call')?.({ toolName: 'create_dxf_file' }, context)).toBeUndefined();
  });

  it('allows only declared refined assets and exactly two presentation repairs', async () => {
    const policy = createPolicy({
      sessionKey: 'agent:main:refined-test',
      mode: 'refined',
      thinkingLevel: 'high',
      fastMode: false,
      maxRepairs: 2,
      allowNetwork: true,
      allowImageGeneration: true,
    });
    await writePolicy(policy);
    const context = { sessionKey: policy.sessionKey, runId: 'refined-budget', workspaceDir: workspaceRoot };

    expect(await hooks.get('before_tool_call')?.({ toolName: 'web_search' }, context)).toBeUndefined();
    expect(await hooks.get('before_tool_call')?.({ toolName: 'web_fetch' }, context)).toBeUndefined();
    expect(await hooks.get('before_tool_call')?.({ toolName: 'image_generate' }, context)).toBeUndefined();
    expect(await hooks.get('before_tool_call')?.({ toolName: 'browser' }, context)).toMatchObject({ block: true });
    expect(await hooks.get('before_tool_call')?.({ toolName: 'create_designed_pptx_file' }, context)).toBeUndefined();
    expect(await hooks.get('before_tool_call')?.({ toolName: 'repair_designed_pptx_file' }, context)).toBeUndefined();
    expect(await hooks.get('before_tool_call')?.({ toolName: 'repair_designed_pptx_file' }, context)).toBeUndefined();
    expect(await hooks.get('before_tool_call')?.({ toolName: 'repair_designed_pptx_file' }, context))
      .toMatchObject({ block: true });
  });

  it('does not apply persisted policies after the runtime artifacts kill switch is disabled', async () => {
    const policy = createPolicy({ sessionKey: 'agent:main:disabled-feature' });
    await writePolicy(policy);
    hooks.clear();
    const plugin = await import('../../resources/openclaw-plugins/uclaw-artifact-orchestrator/index.mjs');
    plugin.default.register({
      pluginConfig: { features: { artifacts: { enabled: false } } },
      on(name: string, handler: Hook) {
        hooks.set(name, handler);
      },
    });
    const context = { sessionKey: policy.sessionKey, runId: 'feature-disabled', workspaceDir: workspaceRoot };

    expect(await hooks.get('before_model_resolve')?.({}, context)).toBeUndefined();
    expect(await hooks.get('before_prompt_build')?.({}, context)).toBeUndefined();
    expect(await hooks.get('before_tool_call')?.({ toolName: 'web_search' }, context)).toBeUndefined();
  });
});
