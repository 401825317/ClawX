import { describe, expect, it } from 'vitest';
import { resolveImageComposerState, resolveVideoComposerState } from '../../src/lib/model-options';

const imagePolicy = {
  defaultModel: 'remote-image-v2',
  defaultSize: '1536x1024',
  defaultQuality: 'high',
  models: [{
    id: 'remote-image-v2',
    sizes: ['1024x1024', '1536x1024'],
    qualities: ['medium', 'high'],
    defaultSize: '1536x1024',
    defaultQuality: 'high',
  }],
};

const videoPolicy = {
  defaultModel: 'future-video-model',
  defaultSize: '1280x720',
  defaultAspectRatio: '16:9',
  defaultResolution: '720P',
  defaultDurationSeconds: 10,
  models: [{
    id: 'future-video-model',
    modes: ['text-to-video'],
    sizes: ['480x480', '720x720', '854x480', '1280x720'],
    aspectRatios: ['1:1', '16:9'],
    resolutions: ['480P', '720P'],
    durations: [5, 10],
    defaultSize: '1280x720',
    defaultAspectRatio: '16:9',
    defaultResolution: '720P',
    defaultDurationSeconds: 10,
    requiresImage: false,
  }],
};

describe('chat media option normalization', () => {
  it('preserves valid server-declared image and video selections', () => {
    expect(resolveImageComposerState(imagePolicy, {
      size: '1024x1024', quality: 'medium',
    })?.options).toEqual({ size: '1024x1024', quality: 'medium' });
    expect(resolveVideoComposerState(videoPolicy as never, 'text-to-video', {
      aspectRatio: '1:1', resolution: '480P', durationSeconds: 5,
    })?.options).toEqual({
      modelId: 'future-video-model',
      size: '480x480',
      mode: 'text-to-video',
      aspectRatio: '1:1',
      resolution: '480P',
      durationSeconds: 5,
    });
  });

  it('replaces invalidated selections with model defaults', () => {
    expect(resolveImageComposerState(imagePolicy, {
      size: '2160x3840', quality: 'low',
    })?.options).toEqual({ size: '1536x1024', quality: 'high' });
    expect(resolveVideoComposerState(videoPolicy as never, 'text-to-video', {
      aspectRatio: '9:16', resolution: '1080P', durationSeconds: 15,
    })?.options).toEqual({
      modelId: 'future-video-model',
      size: '1280x720',
      mode: 'text-to-video',
      aspectRatio: '16:9',
      resolution: '720P',
      durationSeconds: 10,
    });
  });

  it('returns null for explicit empty media capabilities', () => {
    expect(resolveImageComposerState({ ...imagePolicy, models: [] }, undefined)).toBeNull();
    expect(resolveVideoComposerState({ ...videoPolicy, models: [] } as never, 'text-to-video', undefined)).toBeNull();
  });

  it('uses the advertised 720P default without a prior selection', () => {
    expect(resolveVideoComposerState(videoPolicy as never, 'text-to-video', undefined)?.options)
      .toEqual({
        modelId: 'future-video-model',
        size: '1280x720',
        mode: 'text-to-video',
        aspectRatio: '16:9',
        resolution: '720P',
        durationSeconds: 10,
      });
  });

  it('accepts an unknown new model ID from the remote catalog', () => {
    const state = resolveVideoComposerState(videoPolicy as never, 'text-to-video', undefined);
    expect(state?.modelId).toBe('future-video-model');
    expect(state?.resolutions).toEqual(['720P']);
  });
});
