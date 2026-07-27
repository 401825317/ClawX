// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { withConfiguredMediaGenerationPlugins } from '@electron/gateway/config-sync';

describe('configured media generation plugins', () => {
  it('adds managed image and video providers selected by OpenClaw defaults', () => {
    expect(withConfiguredMediaGenerationPlugins(['whatsapp'], {
      agents: {
        defaults: {
          imageGenerationModel: { primary: 'clawx-openai-image/gpt-image-2' },
          videoGenerationModel: { primary: 'uclaw-video/grok-image-video' },
        },
      },
    })).toEqual([
      'whatsapp',
      'clawx-openai-image',
      'uclaw-video',
    ]);
  });

  it('does not install media plugins selected from unrelated providers', () => {
    expect(withConfiguredMediaGenerationPlugins([], {
      agents: {
        defaults: {
          imageGenerationModel: 'other/image',
          videoGenerationModel: 'other/video',
        },
      },
    })).toEqual([]);
  });
});
