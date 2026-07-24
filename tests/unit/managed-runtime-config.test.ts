// @vitest-environment node

import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  getManagedRuntimeOpenAiProviderIds,
  removeManagedRuntimeOpenAiState,
  restoreManagedRuntimeConfig,
  snapshotManagedRuntimeConfig,
  updateManagedRuntimeConfig,
} from '@electron/services/providers/managed-runtime-config';

describe('managed runtime config transaction', () => {
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

  it('discovers an orphan runtime-only managed relay without matching similar custom providers', async () => {
    await writeFile(configPath, JSON.stringify({
      models: {
        providers: {
          openai: { baseUrl: 'https://personal.example/v1', models: [{ id: 'personal-model' }] },
          'custom-runtime-only': {
            baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1/',
            models: [{ id: 'smart-latest' }],
            apiKey: 'legacy-inline-key',
          },
          'same-host-other-model': {
            baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
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
      models: {
        mode: 'merge',
        providers: {
          openai: { apiKey: 'personal-openai-key' },
          'custom-runtime-only': {
            baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
            models: [{ id: 'smart-latest' }],
            apiKey: 'legacy-inline-key',
          },
          'same-host-other-model': {
            baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
            models: [{ id: 'other-model' }],
            apiKey: 'keep-other-model-key',
          },
          'other-host-same-model': {
            baseUrl: 'https://llm.example.com/v1',
            models: [{ id: 'smart-latest' }],
            apiKey: 'keep-other-host-key',
          },
          deepseek: { apiKey: 'deepseek-key' },
        },
      },
      auth: {
        profiles: {
          'openai:default': { provider: 'openai', key: 'openai-key' },
          'orphan:default': { provider: 'custom-runtime-only', key: 'orphan-key' },
          'deepseek:default': { provider: 'deepseek', key: 'deepseek-key' },
        },
        order: {
          openai: ['openai:default'],
          'custom-runtime-only': ['orphan:default'],
          deepseek: ['deepseek:default', 'orphan:default'],
        },
        lastGood: {
          openai: 'openai:default',
          'custom-runtime-only': 'orphan:default',
          deepseek: 'deepseek:default',
          fallback: 'orphan:default',
        },
        usageStats: {
          'openai:default': { lastUsed: 1 },
          'orphan:default': { lastUsed: 2 },
          'deepseek:default': { lastUsed: 3 },
        },
        customMetadata: { keep: true },
      },
    }));
    const snapshot = await snapshotManagedRuntimeConfig();
    const discoveredIds = getManagedRuntimeOpenAiProviderIds(snapshot);

    await removeManagedRuntimeOpenAiState(snapshot, discoveredIds);

    const result = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    const models = result.models as Record<string, unknown>;
    const providers = models.providers as Record<string, unknown>;
    expect(result.channels).toEqual({ telegram: { enabled: true } });
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
    expect(result.commands).toEqual({ restart: true });
  });

  it('does not write a no-op runtime cleanup', async () => {
    const original = Buffer.from(JSON.stringify({
      models: { providers: { deepseek: { apiKey: 'deepseek-key' } } },
    }), 'utf8');
    await writeFile(configPath, original);
    const snapshot = await snapshotManagedRuntimeConfig();

    await removeManagedRuntimeOpenAiState(snapshot);

    expect(await readFile(configPath)).toEqual(original);
  });
});
