import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JUNFEIAI_DEFAULT_API_PROTOCOL,
  JUNFEIAI_DEFAULT_MODEL_CONTEXT_WINDOW,
  JUNFEIAI_DEFAULT_THINKING_LEVEL,
  JUNFEIAI_IMAGE_GENERATION_TIMEOUT_MS,
  JUNFEIAI_MEDIA_GENERATION_CLIENT_TIMEOUT_BUFFER_MS,
  JUNFEIAI_MEDIA_GENERATION_TEST_TIMEOUT_MS,
  JUNFEIAI_MANAGED_OPENAI_API_PROTOCOL,
  JUNFEIAI_RUNTIME_CONTRACT_VERSION,
  JUNFEIAI_VIDEO_GENERATION_POLL_INTERVAL_MS,
  JUNFEIAI_VIDEO_GENERATION_TIMEOUT_MS,
} from '../electron/utils/junfeiai-distribution.ts';
import endpoints from '../shared/junfeiai-endpoints.json';

test('keeps shared JunFeiAI defaults and managed transport explicit', () => {
  assert.equal(JUNFEIAI_DEFAULT_API_PROTOCOL, endpoints.defaultApiProtocol);
  assert.equal(JUNFEIAI_MANAGED_OPENAI_API_PROTOCOL, 'openai-responses');
  assert.equal(JUNFEIAI_DEFAULT_MODEL_CONTEXT_WINDOW, endpoints.defaultModelContextWindow);
  assert.equal(JUNFEIAI_DEFAULT_THINKING_LEVEL, endpoints.defaultThinkingLevel);
  assert.equal(JUNFEIAI_IMAGE_GENERATION_TIMEOUT_MS, endpoints.imageGenerationTimeoutMs);
  assert.equal(JUNFEIAI_VIDEO_GENERATION_TIMEOUT_MS, endpoints.videoGenerationTimeoutMs);
  assert.equal(JUNFEIAI_VIDEO_GENERATION_POLL_INTERVAL_MS, endpoints.videoGenerationPollIntervalMs);
  assert.equal(JUNFEIAI_MEDIA_GENERATION_TEST_TIMEOUT_MS, endpoints.mediaGenerationTestTimeoutMs);
  assert.equal(
    JUNFEIAI_MEDIA_GENERATION_CLIENT_TIMEOUT_BUFFER_MS,
    endpoints.mediaGenerationClientTimeoutBufferMs,
  );
  assert.equal(JUNFEIAI_RUNTIME_CONTRACT_VERSION, 4);
});
