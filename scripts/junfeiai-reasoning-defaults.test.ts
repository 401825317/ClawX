import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PI_AI_OPENROUTER_REASONING_COMPAT,
  PI_AI_OPENROUTER_THINKING_LEVEL_MAP,
  PI_AI_RESPONSES_REASONING_COMPAT,
} from '../electron/shared/pi-ai-model-cost.ts';
import { ensureJunFeiAIReasoningDefaultsInConfig } from '../electron/utils/openclaw-auth.ts';

function managedConfig() {
  return {
    agents: {
      defaults: {
        model: { primary: 'lingzhiwuxian/smart-latest' },
        thinkingDefault: 'high',
        reasoningDefault: 'off',
      },
    },
    models: {
      providers: {
        lingzhiwuxian: {
          models: [{
            id: 'smart-latest',
            reasoning: false,
            compat: { supportsPromptCacheKey: true },
          }],
        },
      },
    },
  };
}

test('managed JunFeiAI config defaults to visible xhigh reasoning', () => {
  const config = managedConfig();

  assert.equal(ensureJunFeiAIReasoningDefaultsInConfig(config), true);
  assert.equal(config.agents.defaults.thinkingDefault, 'xhigh');
  assert.equal(config.agents.defaults.reasoningDefault, 'on');

  const model = config.models.providers.lingzhiwuxian.models[0];
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.compat, PI_AI_OPENROUTER_REASONING_COMPAT);
  assert.deepEqual(model.thinkingLevelMap, PI_AI_OPENROUTER_THINKING_LEVEL_MAP);
  assert.equal(model.compat.supportedReasoningEfforts.includes('xhigh'), true);
  assert.equal(model.thinkingLevelMap.xhigh, 'xhigh');

  assert.equal(ensureJunFeiAIReasoningDefaultsInConfig(config), false);
});

test('non-JunFeiAI defaults are not overwritten', () => {
  const config = {
    agents: {
      defaults: {
        model: { primary: 'openai/gpt-5.4' },
        thinkingDefault: 'medium',
        reasoningDefault: 'off',
      },
    },
  };

  assert.equal(ensureJunFeiAIReasoningDefaultsInConfig(config), false);
  assert.equal(config.agents.defaults.thinkingDefault, 'medium');
  assert.equal(config.agents.defaults.reasoningDefault, 'off');
});

test('managed OpenAI Responses keeps xhigh without OpenRouter wire formatting', () => {
  const config = {
    agents: {
      defaults: {
        model: { primary: 'openai/smart-latest' },
        thinkingDefault: 'high',
        reasoningDefault: 'off',
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
          api: 'openai-responses',
          models: [{
            id: 'smart-latest',
            reasoning: true,
            compat: {
              ...PI_AI_OPENROUTER_REASONING_COMPAT,
              thinkingFormat: 'openrouter',
            },
            thinkingLevelMap: PI_AI_OPENROUTER_THINKING_LEVEL_MAP,
          }],
        },
      },
    },
  };

  assert.equal(ensureJunFeiAIReasoningDefaultsInConfig(config), true);
  assert.equal(config.agents.defaults.thinkingDefault, 'xhigh');
  assert.equal(config.agents.defaults.reasoningDefault, 'on');
  const model = config.models.providers.openai.models[0];
  assert.deepEqual(model.compat, PI_AI_RESPONSES_REASONING_COMPAT);
  assert.equal(model.compat.thinkingFormat, undefined);
  assert.equal(model.thinkingLevelMap, undefined);
});
