// @vitest-environment node

import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UCLAW_COMPATIBILITY_PROVIDER_ID,
  UCLAW_MANAGED_PROVIDER_BASE_URL,
  UCLAW_PROVIDER_REQUEST_TIMEOUT_SECONDS,
  UCLAW_VIDEO_CONTENT_DOWNLOAD_MAX_ATTEMPTS,
  UCLAW_VIDEO_GENERATION_MAX_INPUT_IMAGE_BYTES,
  UCLAW_VIDEO_GENERATION_TIMEOUT_MS,
  UCLAW_VIDEO_PROVIDER_ID,
} from '@shared/junfeiai-endpoints';
import { createDefaultManagedClientVideoModelPolicy } from '@shared/managed-client-config';

const { root, configPath } = vi.hoisted(() => {
  const root = `/tmp/uclaw-managed-runtime-${Math.random().toString(36).slice(2)}`;
  return { root, configPath: `${root}/openclaw.json` };
});

vi.mock('@electron/utils/paths', () => ({
  resolveOpenClawConfigPath: () => configPath,
}));

vi.mock('@electron/utils/config-mutex', () => ({
  withConfigLock: async (task: () => Promise<unknown>) => task(),
}));

import {
  createManagedRuntimeProviderEntry,
  createManagedRuntimeVideoProviderEntry,
  getManagedRuntimeOpenAiProviderIds,
  installManagedRuntimeProviderState,
  isUclawManagedRuntimeProviderEntry,
  removeManagedRuntimeOpenAiState,
  restoreManagedRuntimeConfig,
  snapshotManagedRuntimeConfig,
  updateManagedRuntimeConfig,
} from '@electron/services/providers/managed-runtime-config';

describe('managed runtime config transaction', () => {
  const videoPolicy = createDefaultManagedClientVideoModelPolicy();

  beforeEach(async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects malformed JSON without replacing the original bytes', async () => {
    const malformed = Buffer.from('{"channels":', 'utf8');
    await writeFile(configPath, malformed);
    const snapshot = await snapshotManagedRuntimeConfig();

    await expect(updateManagedRuntimeConfig(snapshot, (config) => {
      config.models = {};
    })).rejects.toBeInstanceOf(SyntaxError);

    expect(await readFile(configPath)).toEqual(malformed);
  });

  it('atomically updates managed fields and restores the exact original bytes and mode', async () => {
    const original = Buffer.from(
      '{\n  "channels": { "telegram": { "enabled": true } },\n'
      + '  "plugins": { "entries": { "keep": true } },\n'
      + '  "tools": { "exec": { "ask": "off" } }\n}\n',
      'utf8',
    );
    await writeFile(configPath, original, { mode: 0o640 });
    await chmod(configPath, 0o640);
    const snapshot = await snapshotManagedRuntimeConfig();

    await updateManagedRuntimeConfig(snapshot, (config) => {
      config.models = { providers: { openai: { models: [{ id: 'smart-latest' }] } } };
    });

    const updated = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(updated).toEqual(expect.objectContaining({
      channels: { telegram: { enabled: true } },
      plugins: { entries: { keep: true } },
      tools: { exec: { ask: 'off' } },
      commands: { restart: true },
    }));
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    await restoreManagedRuntimeConfig(snapshot);

    expect(await readFile(configPath)).toEqual(original);
    expect((await stat(configPath)).mode & 0o777).toBe(0o640);
  });

  it('refuses to roll back over a newer external config generation', async () => {
    await writeFile(configPath, JSON.stringify({ channels: { keep: true } }));
    const snapshot = await snapshotManagedRuntimeConfig();
    await updateManagedRuntimeConfig(snapshot, (config) => {
      config.models = { providers: { openai: {} } };
    });
    const external = Buffer.from(JSON.stringify({ externallyUpdated: true }), 'utf8');
    await writeFile(configPath, external);

    await expect(restoreManagedRuntimeConfig(snapshot))
      .rejects.toThrow('OpenClaw config changed after the managed authentication write');
    expect(await readFile(configPath)).toEqual(external);
  });

  it('installs the same server-owned model catalog for both managed Providers', async () => {
    const policy = {
      defaultModel: 'smart-latest',
      models: [
        { id: 'smart-latest', label: 'Smart' },
        { id: 'standard-chat', label: 'Standard Chat' },
      ],
    };
    const providerEntry = createManagedRuntimeProviderEntry(policy);
    const videoProviderEntry = createManagedRuntimeVideoProviderEntry(videoPolicy);
    expect(providerEntry).toEqual(expect.objectContaining({
      baseUrl: UCLAW_MANAGED_PROVIDER_BASE_URL,
      api: 'openai-responses',
      timeoutSeconds: UCLAW_PROVIDER_REQUEST_TIMEOUT_SECONDS,
      request: { allowPrivateNetwork: true },
      agentRuntime: { id: 'pi' },
    }));
    expect(providerEntry.models.map((model) => model.id)).toEqual([
      'smart-latest',
      'standard-chat',
    ]);
    expect(providerEntry.models[0]).toEqual(expect.objectContaining({
      reasoning: true,
      compat: expect.objectContaining({ supportsReasoningEffort: true }),
    }));
    expect(providerEntry.models[1]).not.toHaveProperty('reasoning');
    expect(providerEntry.models[1]?.compat).toEqual({ supportsPromptCacheKey: true });
    expect(isUclawManagedRuntimeProviderEntry(providerEntry)).toBe(true);
    expect(isUclawManagedRuntimeProviderEntry({
      ...providerEntry,
      baseUrl: 'https://chatgpt.com/backend-api/codex',
    })).toBe(false);
    expect(videoProviderEntry).toEqual({
      baseUrl: UCLAW_MANAGED_PROVIDER_BASE_URL,
      api: 'openai-completions',
      request: { allowPrivateNetwork: true },
      models: [
        { id: 'grok-image-video', name: 'Grok Video' },
        { id: 'grok-video-1.5', name: 'Grok Video 1.5' },
      ],
    });
    expect(isUclawManagedRuntimeProviderEntry({
      ...providerEntry,
      request: { allowPrivateNetwork: false },
    })).toBe(false);

    await writeFile(configPath, JSON.stringify({
      agents: { defaults: { workspace: '/tmp/keep' } },
      plugins: {
        allow: ['keep-plugin'],
        entries: { 'keep-plugin': { enabled: true } },
      },
      models: {
        mode: 'merge',
        providers: {
          deepseek: { models: [{ id: 'deepseek-chat' }] },
          'openai-codex': {
            baseUrl: 'https://chatgpt.com/backend-api/codex',
            api: 'openai-chatgpt-responses',
            models: [{ id: 'gpt-5.5' }],
          },
          'clawx-openai-image': {
            baseUrl: UCLAW_MANAGED_PROVIDER_BASE_URL,
            models: [{ id: 'gpt-image-2' }],
          },
        },
      },
    }));
    const snapshot = await snapshotManagedRuntimeConfig();
    await installManagedRuntimeProviderState(snapshot, policy, videoPolicy);

    const installed = JSON.parse(await readFile(configPath, 'utf8')) as {
      agents: { defaults: Record<string, unknown> };
      models: { mode: string; providers: Record<string, unknown> };
      plugins: { allow: string[]; entries: Record<string, unknown> };
    };
    expect(installed.agents.defaults).toEqual(expect.objectContaining({
      workspace: '/tmp/keep',
      model: { primary: 'openai/smart-latest', fallbacks: [] },
      videoGenerationModel: {
        primary: 'uclaw-video/grok-image-video',
        fallbacks: [],
        timeoutMs: UCLAW_VIDEO_GENERATION_TIMEOUT_MS,
      },
      mediaMaxMb: 128,
    }));
    expect(installed.models.mode).toBe('merge');
    expect(installed.models.providers.openai).toEqual(providerEntry);
    expect(installed.models.providers[UCLAW_COMPATIBILITY_PROVIDER_ID]).toEqual(providerEntry);
    expect(installed.models.providers[UCLAW_VIDEO_PROVIDER_ID]).toEqual(videoProviderEntry);
    expect(installed.models.providers.deepseek).toEqual({ models: [{ id: 'deepseek-chat' }] });
    expect(installed.models.providers['openai-codex']).toEqual({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      api: 'openai-chatgpt-responses',
      models: [{ id: 'gpt-5.5' }],
    });
    expect(installed.models.providers['clawx-openai-image']).toEqual({
      baseUrl: UCLAW_MANAGED_PROVIDER_BASE_URL,
      models: [{ id: 'gpt-image-2' }],
    });
    expect(installed.plugins.allow).toEqual(['keep-plugin', UCLAW_VIDEO_PROVIDER_ID]);
    expect(installed.plugins.entries['keep-plugin']).toEqual({ enabled: true });
    expect(installed.plugins.entries[UCLAW_VIDEO_PROVIDER_ID]).toEqual({
      enabled: true,
      config: expect.objectContaining({
        defaultModel: 'grok-image-video',
        defaultAspectRatio: '16:9',
        defaultResolution: '480P',
        defaultDurationSeconds: 6,
        contentDownloadMaxAttempts: UCLAW_VIDEO_CONTENT_DOWNLOAD_MAX_ATTEMPTS,
        maxInputImageBytes: UCLAW_VIDEO_GENERATION_MAX_INPUT_IMAGE_BYTES,
      }),
    });

    const noOpSnapshot = await snapshotManagedRuntimeConfig();
    await installManagedRuntimeProviderState(noOpSnapshot, policy, videoPolicy);
    expect(noOpSnapshot.applied).toBeUndefined();
  });

  it('discovers an orphan runtime-only managed relay without matching similar custom providers', async () => {
    await writeFile(configPath, JSON.stringify({
      models: {
        providers: {
          openai: { baseUrl: 'https://personal.example/v1', models: [{ id: 'personal-model' }] },
          'openai-codex': {
            baseUrl: 'https://chatgpt.com/backend-api/codex',
            api: 'openai-chatgpt-responses',
            models: [{ id: 'gpt-5.5' }],
          },
          'custom-runtime-only': {
            baseUrl: `${UCLAW_MANAGED_PROVIDER_BASE_URL}/`,
            models: [{ id: 'smart-latest' }],
            apiKey: 'legacy-inline-key',
          },
          'same-host-other-model': {
            baseUrl: UCLAW_MANAGED_PROVIDER_BASE_URL,
            models: [{ id: 'other-model' }],
          },
          'other-host-same-model': {
            baseUrl: 'https://llm.example.com/v1',
            models: [{ id: 'smart-latest' }],
          },
        },
      },
    }));
    const snapshot = await snapshotManagedRuntimeConfig();

    expect(getManagedRuntimeOpenAiProviderIds(snapshot)).toEqual([
      'custom-runtime-only',
      'openai',
    ]);
  });

  it('removes managed runtime providers and complete auth metadata while preserving unrelated state', async () => {
    await writeFile(configPath, JSON.stringify({
      channels: { telegram: { enabled: true } },
      agents: {
        defaults: {
          model: {
            primary: 'openai/smart-latest',
            fallbacks: ['lingzhiwuxian/smart-latest'],
          },
          videoGenerationModel: {
            primary: 'uclaw-video/grok-image-video',
            fallbacks: ['runway/gen4.5'],
          },
          workspace: '/tmp/keep',
        },
      },
      models: {
        mode: 'merge',
        providers: {
          openai: { apiKey: 'personal-openai-key' },
          'custom-runtime-only': {
            baseUrl: UCLAW_MANAGED_PROVIDER_BASE_URL,
            models: [{ id: 'smart-latest' }],
            apiKey: 'legacy-inline-key',
          },
          'same-host-other-model': {
            baseUrl: UCLAW_MANAGED_PROVIDER_BASE_URL,
            models: [{ id: 'other-model' }],
            apiKey: 'keep-other-model-key',
          },
          'other-host-same-model': {
            baseUrl: 'https://llm.example.com/v1',
            models: [{ id: 'smart-latest' }],
            apiKey: 'keep-other-host-key',
          },
          deepseek: { apiKey: 'deepseek-key' },
          'uclaw-video': { baseUrl: UCLAW_MANAGED_PROVIDER_BASE_URL },
        },
      },
      auth: {
        profiles: {
          'openai:default': { provider: 'openai', key: 'openai-key' },
          'orphan:default': { provider: 'custom-runtime-only', key: 'orphan-key' },
          'deepseek:default': { provider: 'deepseek', key: 'deepseek-key' },
          'uclaw-video:default': { provider: 'uclaw-video', key: 'video-key' },
        },
        order: {
          openai: ['openai:default'],
          'custom-runtime-only': ['orphan:default'],
          deepseek: ['deepseek:default', 'orphan:default'],
          'uclaw-video': ['uclaw-video:default'],
        },
        lastGood: {
          openai: 'openai:default',
          'custom-runtime-only': 'orphan:default',
          deepseek: 'deepseek:default',
          fallback: 'orphan:default',
          'uclaw-video': 'uclaw-video:default',
        },
        usageStats: {
          'openai:default': { lastUsed: 1 },
          'orphan:default': { lastUsed: 2 },
          'deepseek:default': { lastUsed: 3 },
          'uclaw-video:default': { lastUsed: 4 },
        },
        customMetadata: { keep: true },
      },
      plugins: {
        allow: ['keep-plugin', 'uclaw-video'],
        entries: {
          'keep-plugin': { enabled: true },
          'uclaw-video': { enabled: true, config: { defaultResolution: '480P' } },
        },
      },
    }));
    const snapshot = await snapshotManagedRuntimeConfig();
    const discoveredIds = getManagedRuntimeOpenAiProviderIds(snapshot);

    await removeManagedRuntimeOpenAiState(snapshot, discoveredIds);

    const result = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    const models = result.models as Record<string, unknown>;
    const providers = models.providers as Record<string, unknown>;
    expect(result.channels).toEqual({ telegram: { enabled: true } });
    expect(result.agents).toEqual({
      defaults: {
        videoGenerationModel: { primary: 'runway/gen4.5' },
        workspace: '/tmp/keep',
      },
    });
    expect(models.mode).toBe('merge');
    expect(Object.keys(providers).sort()).toEqual([
      'deepseek',
      'other-host-same-model',
      'same-host-other-model',
    ]);
    expect(result.auth).toEqual({
      profiles: {
        'deepseek:default': { provider: 'deepseek', key: 'deepseek-key' },
      },
      order: { deepseek: ['deepseek:default'] },
      lastGood: { deepseek: 'deepseek:default' },
      usageStats: { 'deepseek:default': { lastUsed: 3 } },
      customMetadata: { keep: true },
    });
    expect(result.plugins).toEqual({
      allow: ['keep-plugin'],
      entries: { 'keep-plugin': { enabled: true } },
    });
    expect(result.commands).toEqual({ restart: true });
  });

  it('does not write a no-op runtime cleanup', async () => {
    const original = Buffer.from(JSON.stringify({
      agents: { defaults: { model: { primary: 'openai-codex/gpt-5.5', fallbacks: [] } } },
      models: {
        providers: {
          'openai-codex': {
            baseUrl: 'https://chatgpt.com/backend-api/codex',
            api: 'openai-chatgpt-responses',
            models: [{ id: 'gpt-5.5' }],
          },
          deepseek: { apiKey: 'deepseek-key' },
        },
      },
      auth: {
        profiles: {
          'openai-codex:default': { provider: 'openai-codex', mode: 'oauth' },
        },
        order: { 'openai-codex': ['openai-codex:default'] },
        lastGood: { 'openai-codex': 'openai-codex:default' },
        usageStats: { 'openai-codex:default': { lastUsed: 1 } },
      },
    }), 'utf8');
    await writeFile(configPath, original);
    const snapshot = await snapshotManagedRuntimeConfig();

    await removeManagedRuntimeOpenAiState(snapshot);

    expect(await readFile(configPath)).toEqual(original);
    expect(snapshot.applied).toBeUndefined();
  });
});
