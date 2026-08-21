// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { withConfiguredMediaGenerationPlugins } from '@electron/gateway/config-sync';

describe('configured runtime plugins', () => {
  it('adds managed image, video, document and Blender plugins', () => {
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
      'uclaw-artifact-orchestrator',
      'uclaw-local-artifacts',
      'uclaw-blender',
    ]);
  });

  it('keeps document and Blender plugins when media providers are unrelated', () => {
    expect(withConfiguredMediaGenerationPlugins([], {
      agents: {
        defaults: {
          imageGenerationModel: 'other/image',
          videoGenerationModel: 'other/video',
        },
      },
    })).toEqual([
      'uclaw-artifact-orchestrator',
      'uclaw-local-artifacts',
      'uclaw-blender',
    ]);
  });
});
