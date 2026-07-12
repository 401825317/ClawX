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
assert.match(first.content, /defaultModel: primaryModelRef/u);
assert.match(first.content, /explicitModels\.length > 0 \? explicitModels/u);

const listProviders = new Function(`${first.content}; return listRuntimeVideoGenerationProviders;`)();
const configured = listProviders({
  config: {
    agents: { defaults: { videoGenerationModel: { primary: 'openai/grok-image-video' } } },
    models: { providers: { openai: { models: [{ id: 'grok-video-1.5' }] } } },
  },
}, {
  listProviders: () => [{
    id: 'openai',
    defaultModel: 'sora-2',
    models: ['sora-2', 'sora-2-pro'],
  }],
});
assert.deepEqual(configured[0].models, ['grok-image-video', 'grok-video-1.5']);
assert.equal(configured[0].defaultModel, 'grok-image-video');

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
console.log('openclaw video provider catalog patch tests passed');
