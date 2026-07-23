import assert from 'node:assert/strict';
import {
  normalizeRegisteredVideoModelRef,
  type VideoGenerationProviderRow,
} from '../electron/utils/openclaw-video-generation';
import { normalizeClawXOpenAiVideoDurationSeconds } from '../electron/utils/openclaw-video-relay-constants';
import type {
  ManagedVideoCapabilityContract,
  ManagedVideoModelCapability,
} from '../shared/managed-video-capabilities';

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

const managedVideoModel = {
  id: 'grok-image-video',
  label: 'Grok Image Video',
  modes: ['text-to-video', 'image-to-video'],
  sizes: ['854x480', '1280x720', '720x1280', '1024x1024'],
  durations: [6, 10, 15],
  defaultSize: '1280x720',
  defaultDurationSeconds: 6,
  requiresImage: false,
  enabled: true,
} satisfies ManagedVideoModelCapability;

const managedVideoContract = {
  contractVersion: 1,
  defaultModel: managedVideoModel.id,
  defaultSize: managedVideoModel.defaultSize,
  defaultDurationSeconds: managedVideoModel.defaultDurationSeconds,
  models: [
    managedVideoModel,
    {
      ...managedVideoModel,
      id: 'grok-video-1.5',
      label: 'Grok Video 1.5',
      modes: ['image-to-video'],
      requiresImage: true,
    },
  ],
} satisfies ManagedVideoCapabilityContract;

assert.equal(normalizeRegisteredVideoModelRef('openai/sora-2', providers), 'openai/sora-2');
assert.equal(
  normalizeRegisteredVideoModelRef('openai/grok-imagine-video-1.5', providers, managedVideoContract),
  'openai/grok-video-1.5',
);
assert.equal(
  normalizeRegisteredVideoModelRef('fal-video/fal-ai/minimax/video-01-live', providers),
  'fal/fal-ai/minimax/video-01-live',
);
assert.equal(normalizeRegisteredVideoModelRef('openai/smart-latest', providers), null);
assert.equal(normalizeRegisteredVideoModelRef('unknown/fal-ai/minimax/video-01-live', providers), null);
assert.equal(normalizeClawXOpenAiVideoDurationSeconds(managedVideoModel), 6);
assert.equal(normalizeClawXOpenAiVideoDurationSeconds(managedVideoModel, 4), 6);
assert.equal(normalizeClawXOpenAiVideoDurationSeconds(managedVideoModel, 6), 6);
assert.equal(normalizeClawXOpenAiVideoDurationSeconds(managedVideoModel, 9), 10);
assert.equal(normalizeClawXOpenAiVideoDurationSeconds(managedVideoModel, 12), 10);
assert.equal(normalizeClawXOpenAiVideoDurationSeconds(managedVideoModel, 14), 15);

console.log('openclaw video config validation tests passed');
