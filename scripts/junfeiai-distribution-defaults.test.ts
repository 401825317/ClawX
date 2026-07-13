import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JUNFEIAI_DEFAULT_API_PROTOCOL,
  JUNFEIAI_DEFAULT_MODEL_CONTEXT_WINDOW,
  JUNFEIAI_DEFAULT_THINKING_LEVEL,
  JUNFEIAI_MANAGED_OPENAI_API_PROTOCOL,
  JUNFEIAI_RUNTIME_CONTRACT_VERSION,
} from '../electron/utils/junfeiai-distribution.ts';
import endpoints from '../shared/junfeiai-endpoints.json';

test('keeps shared JunFeiAI defaults and managed transport explicit', () => {
  assert.equal(JUNFEIAI_DEFAULT_API_PROTOCOL, endpoints.defaultApiProtocol);
  assert.equal(JUNFEIAI_MANAGED_OPENAI_API_PROTOCOL, 'openai-responses');
  assert.equal(JUNFEIAI_DEFAULT_MODEL_CONTEXT_WINDOW, endpoints.defaultModelContextWindow);
  assert.equal(JUNFEIAI_DEFAULT_THINKING_LEVEL, endpoints.defaultThinkingLevel);
  assert.equal(JUNFEIAI_RUNTIME_CONTRACT_VERSION, 4);
});
