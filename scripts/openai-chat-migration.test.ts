import assert from 'node:assert/strict';
import test from 'node:test';
import { rewriteManagedChatModelRefsForMigration } from '../electron/services/providers/openai-chat-migration';

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
