import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JUNFEIAI_DEFAULT_API_PROTOCOL,
  JUNFEIAI_DEFAULT_MODEL_CONTEXT_WINDOW,
  JUNFEIAI_MANAGED_OPENAI_API_PROTOCOL,
  JUNFEIAI_RUNTIME_CONTRACT_VERSION,
} from '../electron/utils/junfeiai-distribution.ts';

test('keeps legacy and managed JunFeiAI transports explicit and stable', () => {
  assert.equal(JUNFEIAI_DEFAULT_API_PROTOCOL, 'openai-completions');
  assert.equal(JUNFEIAI_MANAGED_OPENAI_API_PROTOCOL, 'openai-responses');
  assert.equal(JUNFEIAI_DEFAULT_MODEL_CONTEXT_WINDOW, 372_000);
  assert.equal(JUNFEIAI_RUNTIME_CONTRACT_VERSION, 3);
});
