import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isManagedOpenAiAccountForMigration,
  isManagedOpenAiRuntimeForMigration,
  isManagedTextFailoverRuntimeForMigration,
  rewriteManagedChatModelRefsForMigration,
} from '../electron/services/providers/openai-chat-migration';

test('rewrites only managed model references and preserves unrelated providers', () => {
  const input = {
    defaultModel: 'lingzhiwuxian/smart-latest',
    providers: {
      lingzhiwuxian: { api: 'openai-completions' },
      openai: { api: 'openai-responses', models: ['gpt-image-2'] },
    },
    nested: ['custom/model', { 'lingzhiwuxian/qwen-latest': true }],
  };
  const result = rewriteManagedChatModelRefsForMigration(input);

  assert.equal(result.count, 2);
  assert.deepEqual(result.value, {
    defaultModel: 'openai/smart-latest',
    providers: input.providers,
    nested: ['custom/model', { 'openai/qwen-latest': true }],
  });
});

test('blocks a model-reference key collision instead of overwriting data', () => {
  assert.throws(
    () => rewriteManagedChatModelRefsForMigration({
      'lingzhiwuxian/smart-latest': { legacy: true },
      'openai/smart-latest': { current: true },
    }),
    /already exists/,
  );
});

test('recognizes managed OpenAI accounts by runtime metadata or the managed endpoint', () => {
  const baseAccount = {
    id: 'openai',
    vendorId: 'openai' as const,
    label: 'OpenAI',
    authMode: 'api_key' as const,
    apiProtocol: 'openai-responses' as const,
    enabled: true,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  assert.equal(isManagedOpenAiAccountForMigration({
    ...baseAccount,
    baseUrl: 'http://127.0.0.1:8083/v1',
    metadata: { managedRuntimeContractVersion: 2 },
  }), true);
  assert.equal(isManagedOpenAiAccountForMigration({
    ...baseAccount,
    baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
  }), true);
  assert.equal(isManagedOpenAiAccountForMigration({
    ...baseAccount,
    baseUrl: 'https://api.openai.com/v1',
  }), false);
});

test('recognizes only the managed Responses runtime provider', () => {
  assert.equal(isManagedOpenAiRuntimeForMigration({
    baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1/',
    api: 'openai-responses',
  }), true);
  assert.equal(isManagedOpenAiRuntimeForMigration({
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-responses',
  }), false);
  assert.equal(isManagedOpenAiRuntimeForMigration({
    baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
    api: 'openai-completions',
  }), false);
});

test('requires the managed text fallback to reuse the relay with Chat Completions', () => {
  const managedRuntime = {
    models: {
      providers: {
        deepseek: {
          baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
          api: 'openai-completions',
          models: [{ id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' }],
        },
      },
    },
    agents: {
      defaults: {
        model: {
          fallbacks: ['deepseek/deepseek-v4-pro'],
        },
      },
    },
  };

  assert.equal(isManagedTextFailoverRuntimeForMigration(managedRuntime), true);
  assert.equal(isManagedTextFailoverRuntimeForMigration({
    ...managedRuntime,
    models: {
      providers: {
        deepseek: {
          ...managedRuntime.models.providers.deepseek,
          api: 'openai-responses',
        },
      },
    },
  }), false);
});
