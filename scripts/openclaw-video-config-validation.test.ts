import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ensureManagedOpenAiVideoRelay,
  hasCompleteManagedOpenAiVideoModelCatalog,
  normalizeRegisteredVideoModelRef,
  type VideoGenerationProviderRow,
} from '../electron/utils/openclaw-video-generation';
import { syncOpenAiCompatibleVideoRelay } from '../electron/utils/openclaw-auth';
import {
  CLAWX_OPENAI_VIDEO_DEFAULT_MODEL,
  CLAWX_OPENAI_VIDEO_MODEL_IDS,
  CLAWX_OPENAI_VIDEO_PROVIDER_KEY,
} from '../electron/utils/openclaw-video-relay-constants';
import { getJunFeiAIDefaultBaseUrl } from '../electron/utils/junfeiai-distribution';
import endpoints from '../shared/junfeiai-endpoints.json';

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

assert.equal(
  `${CLAWX_OPENAI_VIDEO_PROVIDER_KEY}/${CLAWX_OPENAI_VIDEO_DEFAULT_MODEL}`,
  endpoints.videoGenerationDefaults.defaultModelRef,
);
assert.deepEqual(CLAWX_OPENAI_VIDEO_MODEL_IDS, [
  endpoints.videoGenerationDefaults.defaultModelRef.split('/')[1],
  endpoints.videoGenerationDefaults.imageToVideoModelRef.split('/')[1],
]);

assert.equal(hasCompleteManagedOpenAiVideoModelCatalog({
  models: {
    providers: {
      openai: { models: [{ id: 'smart-latest' }] },
    },
  },
}), false);
assert.equal(hasCompleteManagedOpenAiVideoModelCatalog({
  models: {
    providers: {
      openai: { models: ['smart-latest', ...CLAWX_OPENAI_VIDEO_MODEL_IDS] },
    },
  },
}), true);
assert.equal(hasCompleteManagedOpenAiVideoModelCatalog({
  models: {
    providers: {
      openai: {
        models: [
          { id: 'smart-latest' },
          ...CLAWX_OPENAI_VIDEO_MODEL_IDS.slice(0, 1).map((id) => ({ id })),
        ],
      },
    },
  },
}), false);
assert.equal(hasCompleteManagedOpenAiVideoModelCatalog({
  models: {
    providers: {
      openai: {
        models: [
          { id: 'smart-latest' },
          ...CLAWX_OPENAI_VIDEO_MODEL_IDS.map((id) => ({ id })),
        ],
      },
    },
  },
}), true);

async function assertManagedVideoRelaySelfHealing(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-video-relay-self-heal-'));
  const configPath = path.join(root, 'openclaw.json');
  const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  const baseUrl = getJunFeiAIDefaultBaseUrl();

  try {
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    await writeFile(configPath, JSON.stringify({
      models: {
        providers: {
          openai: {
            baseUrl,
            api: 'openai-responses',
            models: [{ id: 'smart-latest', name: 'smart-latest' }],
          },
        },
      },
      agents: {
        defaults: {
          videoGenerationModel: {
            primary: `${CLAWX_OPENAI_VIDEO_PROVIDER_KEY}/${CLAWX_OPENAI_VIDEO_DEFAULT_MODEL}`,
            timeoutMs: endpoints.videoGenerationTimeoutMs,
          },
        },
      },
    }, null, 2));

    // Apply the same merge used by the managed relay repair path.
    await syncOpenAiCompatibleVideoRelay({
      enabled: true,
      baseUrl,
      videoModelIds: CLAWX_OPENAI_VIDEO_MODEL_IDS,
    });

    const repaired = JSON.parse(await readFile(configPath, 'utf8')) as {
      models: {
        providers: {
          openai: {
            baseUrl: string;
            models: Array<{ id: string }>;
          };
        };
      };
    };
    const repairedModelIds = repaired.models.providers.openai.models.map(
      (model: { id: string }) => model.id,
    );
    assert.deepEqual(repairedModelIds, ['smart-latest', ...CLAWX_OPENAI_VIDEO_MODEL_IDS]);
    assert.equal(repaired.models.providers.openai.baseUrl, baseUrl);
    assert.equal(hasCompleteManagedOpenAiVideoModelCatalog(repaired), true);

    const contentBeforeSecondEnsure = await readFile(configPath, 'utf8');
    const statBeforeSecondEnsure = await stat(configPath);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Startup calls preserveExisting; a complete relay must not be written again.
    await ensureManagedOpenAiVideoRelay({ preserveExisting: true });

    const contentAfterSecondEnsure = await readFile(configPath, 'utf8');
    const statAfterSecondEnsure = await stat(configPath);
    assert.equal(contentAfterSecondEnsure, contentBeforeSecondEnsure);
    assert.equal(statAfterSecondEnsure.mtimeMs, statBeforeSecondEnsure.mtimeMs);
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
    }
    await rm(root, { recursive: true, force: true });
  }
}

assertManagedVideoRelaySelfHealing()
  .then(() => console.log('openclaw video config validation tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
