import assert from 'node:assert/strict';
import { patchOpenClawVideoProviderCatalogContent } from './openclaw-video-provider-catalog-patch.mjs';

const source = `function parseVideoGenerationModelRef(ref) {
\tconst separator = ref.indexOf('/');
\treturn separator > 0 ? { provider: ref.slice(0, separator), model: ref.slice(separator + 1) } : undefined;
}
function listRuntimeVideoGenerationProviders(params, deps = {}) {
\treturn (deps.listProviders ?? listVideoGenerationProviders)(params?.config);
}`;
const first = patchOpenClawVideoProviderCatalogContent(source);
assert.equal(first.matched, true);
assert.equal(first.changed, true);
assert.match(first.content, /configuredByProvider/u);
assert.match(first.content, /configuredProvider/u);
assert.match(first.content, /primaryModelRef/u);
assert.match(first.content, /capabilityModels/u);
assert.match(first.content, /configuredVideoModels/u);
assert.match(first.content, /requestedDefault && models\.includes/u);

const listProviders = new Function(`${first.content}; return listRuntimeVideoGenerationProviders;`)();
const configured = listProviders({
  config: {
    agents: {
      defaults: {
        videoGenerationModel: {
          primary: 'openai/smart-latest',
          fallbacks: ['openai/qwen-latest'],
        },
      },
    },
    models: {
      providers: {
        openai: {
          models: [
            { id: 'grok-image-video' },
            { id: 'grok-video-1.5' },
            { id: 'smart-latest' },
            { id: 'qwen-latest' },
          ],
        },
      },
    },
  },
}, {
  listProviders: () => [{
    id: 'openai',
    defaultModel: 'sora-2',
    models: ['sora-2', 'sora-2-pro'],
    capabilities: {
      generate: {
        modelCapabilities: {
          'grok-image-video': { enabled: true },
          'grok-video-1.5': { enabled: false },
        },
      },
      imageToVideo: {
        modelCapabilities: {
          'grok-image-video': { enabled: true },
          'grok-video-1.5': { enabled: true },
        },
      },
    },
  }],
});
assert.deepEqual(configured[0].models, ['grok-image-video', 'grok-video-1.5']);
assert.equal(configured[0].defaultModel, 'grok-image-video');
assert.equal(configured[0].models.includes('smart-latest'), false);
assert.equal(configured[0].models.includes('qwen-latest'), false);

const configuredLegalPrimary = listProviders({
  config: {
    agents: { defaults: { videoGenerationModel: { primary: 'openai/grok-video-1.5' } } },
    models: {
      providers: {
        openai: { models: [{ id: 'grok-image-video' }, { id: 'grok-video-1.5' }] },
      },
    },
  },
}, {
  listProviders: () => [{
    id: 'openai',
    defaultModel: 'sora-2',
    models: ['sora-2', 'sora-2-pro'],
    capabilities: {
      generate: {
        modelCapabilities: {
          'grok-image-video': { enabled: true },
          'grok-video-1.5': { enabled: false },
        },
      },
    },
  }],
});
assert.deepEqual(configuredLegalPrimary[0].models, ['grok-video-1.5', 'grok-image-video']);
assert.equal(configuredLegalPrimary[0].defaultModel, 'grok-video-1.5');

const configuredNative = listProviders({
  config: {
    models: { providers: { openai: { models: [{ id: 'sora-2' }, { id: 'smart-latest' }] } } },
  },
}, {
  listProviders: () => [{
    id: 'openai',
    defaultModel: 'sora-2',
    models: ['sora-2', 'sora-2-pro'],
  }],
});
assert.deepEqual(configuredNative[0].models, ['sora-2']);

const configuredRef = listProviders({
  config: {
    agents: { defaults: { videoGenerationModel: 'custom/custom-video' } },
    models: { providers: { custom: { models: [{ id: 'chat-only' }] } } },
  },
}, {
  listProviders: () => [{
    id: 'custom',
    defaultModel: 'custom-video',
    models: ['custom-video'],
  }],
});
assert.deepEqual(configuredRef[0].models, ['custom-video']);
assert.equal(configuredRef[0].defaultModel, 'custom-video');

const unconfigured = listProviders({ config: {} }, {
  listProviders: () => [{
    id: 'openai',
    defaultModel: 'sora-2',
    models: ['sora-2', 'sora-2-pro'],
  }],
});
assert.deepEqual(unconfigured[0].models, ['sora-2', 'sora-2-pro']);
const second = patchOpenClawVideoProviderCatalogContent(first.content);
assert.equal(second.changed, false);

const previousSource = source.replace(`function listRuntimeVideoGenerationProviders(params, deps = {}) {
\treturn (deps.listProviders ?? listVideoGenerationProviders)(params?.config);
}`, `function listRuntimeVideoGenerationProviders(params, deps = {}) {
\tconst providers = (deps.listProviders ?? listVideoGenerationProviders)(params?.config);
\tconst modelConfig = params?.config?.agents?.defaults?.videoGenerationModel;
\tconst primaryRef = typeof modelConfig === "string" ? modelConfig : modelConfig?.primary;
\tconst primaryModelRef = typeof primaryRef === "string" ? parseVideoGenerationModelRef(primaryRef) : undefined;
\tconst configuredRefs = typeof modelConfig === "string" ? [modelConfig] : [modelConfig?.primary, ...Array.isArray(modelConfig?.fallbacks) ? modelConfig.fallbacks : []];
\tconst configuredByProvider = new Map();
\tfor (const ref of configuredRefs) {
\t\tif (typeof ref !== "string") continue;
\t\tconst parsed = parseVideoGenerationModelRef(ref);
\t\tif (!parsed?.provider || !parsed?.model) continue;
\t\tconst models = configuredByProvider.get(parsed.provider) ?? [];
\t\tif (!models.includes(parsed.model)) models.push(parsed.model);
\t\tconfiguredByProvider.set(parsed.provider, models);
\t}
\treturn providers.map((provider) => {
\t\tconst configuredProvider = params?.config?.models?.providers?.[provider.id];
\t\tconst providerModels = Array.isArray(configuredProvider?.models) ? configuredProvider.models.map((entry) => typeof entry === "string" ? entry : entry?.id).filter((model) => typeof model === "string" && model.trim()) : [];
\t\tconst explicitModels = [...new Set([...(configuredByProvider.get(provider.id) ?? []), ...providerModels])];
\t\treturn {
\t\t\t...provider,
\t\t\tdefaultModel: primaryModelRef?.provider === provider.id ? primaryModelRef.model : provider.defaultModel,
\t\t\tmodels: explicitModels.length > 0 ? explicitModels : [...new Set(provider.models ?? [])]
\t\t};
\t}); // UCLAW_CONFIGURED_VIDEO_MODELS_IN_CATALOG_V4
}`);
const upgraded = patchOpenClawVideoProviderCatalogContent(previousSource);
assert.equal(upgraded.matched, true);
assert.equal(upgraded.changed, true);
assert.match(upgraded.content, /UCLAW_CONFIGURED_VIDEO_MODELS_IN_CATALOG_V5/u);
console.log('openclaw video provider catalog patch tests passed');
