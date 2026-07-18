import assert from 'node:assert/strict';
import test from 'node:test';

const helpersModule = await import('../src/stores/chat/helpers.ts');
const { isRecoverableRuntimeError } = helpersModule.default ?? helpersModule;

test('rate limit errors are treated as recoverable runtime errors', () => {
  assert.equal(
    isRecoverableRuntimeError('429 Upstream rate limit exceeded, please retry later'),
    true,
  );
  assert.equal(
    isRecoverableRuntimeError('Too many requests from the provider'),
    true,
  );
  assert.equal(
    isRecoverableRuntimeError('OpenAI rate limit exceeded'),
    true,
  );
  assert.equal(
    isRecoverableRuntimeError('Provider request failed.'),
    false,
  );
});
