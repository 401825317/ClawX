import assert from 'node:assert/strict';
import {
  normalizeRegisteredVideoModelRef,
  type VideoGenerationProviderRow,
} from '../electron/utils/openclaw-video-generation';
import { normalizeClawXOpenAiVideoDurationSeconds } from '../electron/utils/openclaw-video-relay-constants';

function provider(params: {
  id: string;
  aliases?: string[];
  defaultModel: string;
  models: string[];
}): VideoGenerationProviderRow {
  return {
    aliases: params.aliases ?? [],
    available: true,
    configured: true,
    selected: true,
    label: params.id,
    ...params,
  };
}

const providers = [
  provider({
    id: 'openai',
    defaultModel: 'sora-2',
    models: ['sora-2', 'sora-2-pro', 'grok-image-video', 'grok-video-1.5'],
  }),
  provider({
    id: 'fal',
    aliases: ['fal-video'],
    defaultModel: 'fal-ai/minimax/video-01-live',
    models: ['fal-ai/minimax/video-01-live'],
  }),
];

assert.equal(normalizeRegisteredVideoModelRef('openai/sora-2', providers), 'openai/sora-2');
assert.equal(
  normalizeRegisteredVideoModelRef('openai/grok-imagine-video-1.5', providers),
  'openai/grok-video-1.5',
);
assert.equal(
  normalizeRegisteredVideoModelRef('fal-video/fal-ai/minimax/video-01-live', providers),
  'fal/fal-ai/minimax/video-01-live',
);
assert.equal(normalizeRegisteredVideoModelRef('openai/smart-latest', providers), null);
assert.equal(normalizeRegisteredVideoModelRef('unknown/fal-ai/minimax/video-01-live', providers), null);
assert.equal(normalizeClawXOpenAiVideoDurationSeconds(), 6);
assert.equal(normalizeClawXOpenAiVideoDurationSeconds(4), 6);
assert.equal(normalizeClawXOpenAiVideoDurationSeconds(6), 6);
assert.equal(normalizeClawXOpenAiVideoDurationSeconds(9), 10);
assert.equal(normalizeClawXOpenAiVideoDurationSeconds(12), 10);
assert.equal(normalizeClawXOpenAiVideoDurationSeconds(14), 15);

console.log('openclaw video config validation tests passed');
