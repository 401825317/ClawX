import { describe, expect, it } from 'vitest';
import {
  listVideoGenerationVariants,
  resolveVideoGenerationOptions,
  validateVideoGenerationOptions,
} from '../../shared/video-generation-contract';
import { videoGenerationContractForTesting as pluginContract } from '../../resources/openclaw-plugins/uclaw-video/index.mjs';

const model = {
  id: 'future-video-model',
  modes: ['text-to-video'],
  sizes: ['1280x720', '720x1280', '2048x858'],
  aspectRatios: ['16:9', '9:16', '1024:429'],
  resolutions: ['720P', '858P', 'cinema-ultra'],
  durations: [7, 21],
  defaultSize: '1280x720',
  defaultAspectRatio: '16:9',
  defaultResolution: '720P',
  defaultDurationSeconds: 7,
};

describe('video generation cross-runtime contract', () => {
  it('keeps shared TypeScript and plugin ESM variants identical', () => {
    expect(pluginContract.listVideoGenerationVariants(model))
      .toEqual(listVideoGenerationVariants(model));
  });

  it('resolves the same future catalog selection in both runtimes', () => {
    const preferred = {
      aspectRatio: '1024:429',
      resolution: '858P',
      durationSeconds: 21,
    };
    expect(pluginContract.resolveVideoGenerationOptions(model, 'text-to-video', preferred))
      .toEqual(resolveVideoGenerationOptions(model, 'text-to-video', preferred));
  });

  it('rejects the same exact-size resolution mismatch in both runtimes', () => {
    const options = {
      modelId: model.id,
      size: '1280x720',
      mode: 'text-to-video',
      aspectRatio: '16:9',
      resolution: 'cinema-ultra',
      durationSeconds: 7,
    };
    expect(pluginContract.validateVideoGenerationOptions(options, model))
      .toEqual(validateVideoGenerationOptions(options, model));
  });
});
