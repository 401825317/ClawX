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
  JUNFEIAI_OPENCLAW_EXEC_ASK,
  JUNFEIAI_OPENCLAW_EXEC_SECURITY,
  JUNFEIAI_OPENCLAW_MAX_ACTIVE_TRANSCRIPT_BYTES,
  JUNFEIAI_OPENCLAW_MID_TURN_PRECHECK_ENABLED,
  JUNFEIAI_OPENCLAW_TEXT_FAILOVER,
  JUNFEIAI_OPENCLAW_TEXT_FAILOVER_MODEL_REF,
  JUNFEIAI_OPENCLAW_TRUNCATE_AFTER_COMPACTION,
  JUNFEIAI_RUNTIME_CONTRACT_VERSION,
  JUNFEIAI_VIDEO_GENERATION_POLL_INTERVAL_MS,
  JUNFEIAI_VIDEO_GENERATION_TIMEOUT_MS,
} from '../electron/utils/junfeiai-distribution.ts';
import {
  ensureJunFeiAICompactionDefaultsInConfig,
  ensureJunFeiAIExecDefaultsInConfig,
} from '../electron/utils/openclaw-auth.ts';
import endpoints from '../shared/junfeiai-endpoints.json';

test('keeps shared JunFeiAI defaults and managed transport explicit', () => {
  assert.equal(JUNFEIAI_DEFAULT_API_PROTOCOL, endpoints.defaultApiProtocol);
  assert.equal(JUNFEIAI_MANAGED_OPENAI_API_PROTOCOL, 'openai-responses');
  assert.equal(JUNFEIAI_DEFAULT_MODEL_CONTEXT_WINDOW, endpoints.defaultModelContextWindow);
  assert.equal(JUNFEIAI_DEFAULT_THINKING_LEVEL, endpoints.defaultThinkingLevel);
  assert.equal(JUNFEIAI_OPENCLAW_EXEC_SECURITY, endpoints.openClawExec.security);
  assert.equal(JUNFEIAI_OPENCLAW_EXEC_ASK, endpoints.openClawExec.ask);
  assert.deepEqual(JUNFEIAI_OPENCLAW_TEXT_FAILOVER, endpoints.openClawTextFailover);
  assert.equal(
    JUNFEIAI_OPENCLAW_TEXT_FAILOVER_MODEL_REF,
    `${endpoints.openClawTextFailover.fallbackProvider}/${endpoints.openClawTextFailover.fallbackModel}`,
  );
  assert.equal(
    JUNFEIAI_OPENCLAW_MID_TURN_PRECHECK_ENABLED,
    endpoints.openClawCompaction.midTurnPrecheck.enabled,
  );
  assert.equal(
    JUNFEIAI_OPENCLAW_TRUNCATE_AFTER_COMPACTION,
    endpoints.openClawCompaction.truncateAfterCompaction,
  );
  assert.equal(
    JUNFEIAI_OPENCLAW_MAX_ACTIVE_TRANSCRIPT_BYTES,
    endpoints.openClawCompaction.maxActiveTranscriptBytes,
  );
  assert.equal(JUNFEIAI_IMAGE_GENERATION_TIMEOUT_MS, endpoints.imageGenerationTimeoutMs);
  assert.equal(JUNFEIAI_VIDEO_GENERATION_TIMEOUT_MS, endpoints.videoGenerationTimeoutMs);
  assert.equal(JUNFEIAI_VIDEO_GENERATION_POLL_INTERVAL_MS, endpoints.videoGenerationPollIntervalMs);
  assert.equal(JUNFEIAI_MEDIA_GENERATION_TEST_TIMEOUT_MS, endpoints.mediaGenerationTestTimeoutMs);
  assert.equal(
    JUNFEIAI_MEDIA_GENERATION_CLIENT_TIMEOUT_BUFFER_MS,
    endpoints.mediaGenerationClientTimeoutBufferMs,
  );
  assert.equal(JUNFEIAI_RUNTIME_CONTRACT_VERSION, 5);
});

test('applies endpoint-configured OpenClaw exec defaults without dropping adjacent settings', () => {
  const config = {
    tools: {
      profile: 'full',
      exec: {
        security: 'deny',
        ask: 'always',
        timeoutSec: 600,
      },
    },
  };

  assert.equal(ensureJunFeiAIExecDefaultsInConfig(config), true);
  assert.deepEqual(config.tools.exec, {
    security: endpoints.openClawExec.security,
    ask: endpoints.openClawExec.ask,
    timeoutSec: 600,
  });
  assert.equal(ensureJunFeiAIExecDefaultsInConfig(config), false);
});

test('applies endpoint-configured OpenClaw compaction defaults without dropping adjacent settings', () => {
  const config = {
    agents: {
      defaults: {
        compaction: {
          mode: 'safeguard',
          reserveTokensFloor: 24000,
          midTurnPrecheck: {
            enabled: false,
            futureSetting: 'keep',
          },
        },
      },
    },
  };

  assert.equal(ensureJunFeiAICompactionDefaultsInConfig(config), true);
  assert.deepEqual(config.agents.defaults.compaction, {
    mode: 'safeguard',
    reserveTokensFloor: 24000,
    midTurnPrecheck: {
      enabled: endpoints.openClawCompaction.midTurnPrecheck.enabled,
      futureSetting: 'keep',
    },
    truncateAfterCompaction: endpoints.openClawCompaction.truncateAfterCompaction,
    maxActiveTranscriptBytes: endpoints.openClawCompaction.maxActiveTranscriptBytes,
  });
  assert.equal(ensureJunFeiAICompactionDefaultsInConfig(config), false);
});
