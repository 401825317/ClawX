import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { patchOpenClawVideoCapabilityContractRuntime } from './openclaw-video-capability-contract-patch.mjs';
import {
  patchOpenClawVideoModelValidationRuntime,
  resolveValidatedVideoModelForCatalog,
} from './openclaw-video-model-validation-patch.mjs';
import { patchOpenClawVideoProviderCatalogRuntime } from './openclaw-video-provider-catalog-patch.mjs';

const providers = [{
  id: 'openai',
  aliases: ['openai-compatible'],
  defaultModel: 'grok-image-video',
  models: ['grok-image-video', 'grok-video-1.5'],
  capabilities: {
    generate: { modelCapabilities: { 'grok-image-video': { enabled: true } } },
    imageToVideo: { modelCapabilities: { 'grok-video-1.5': { enabled: true } } },
  },
}];
const slashModelProvider = {
  id: 'fal',
  defaultModel: 'fal-ai/minimax/video-01-live',
  models: ['fal-ai/minimax/video-01-live'],
};

assert.deepEqual(resolveValidatedVideoModelForCatalog({
  providers,
  selectedProviderId: 'openai',
  primary: 'openai/grok-image-video',
}), { provider: 'openai', model: 'grok-image-video' });
assert.deepEqual(resolveValidatedVideoModelForCatalog({
  providers,
  selectedProviderId: 'openai',
  primary: 'openai/grok-image-video',
  modelOverride: 'grok-video-1.5',
}), { provider: 'openai', model: 'grok-video-1.5' });
assert.deepEqual(resolveValidatedVideoModelForCatalog({
  providers: [...providers, slashModelProvider],
  selectedProviderId: 'fal',
  primary: 'fal/fal-ai/minimax/video-01-live',
  modelOverride: 'fal-ai/minimax/video-01-live',
}), { provider: 'fal', model: 'fal-ai/minimax/video-01-live' });
assert.throws(() => resolveValidatedVideoModelForCatalog({
  providers,
  selectedProviderId: 'openai',
  primary: 'openai/grok-image-video',
  modelOverride: 'smart-latest',
}), /invalid_video_model/u);
assert.throws(() => resolveValidatedVideoModelForCatalog({
  providers,
  selectedProviderId: 'openai',
  primary: 'openai/smart-latest',
}), /invalid_video_model/u);
assert.throws(() => resolveValidatedVideoModelForCatalog({
  providers,
  selectedProviderId: 'openai',
  primary: 'openai/grok-image-video',
  modelOverride: 'unknown-provider/grok-image-video',
}), /invalid_video_model/u);

const sourceDist = join(process.cwd(), 'node_modules', 'openclaw', 'dist');
const files = readdirSync(sourceDist)
  .filter((entry) => entry.endsWith('.js'))
  .map((entry) => ({
    file: join(sourceDist, entry),
    content: readFileSync(join(sourceDist, entry), 'utf8'),
  }));
const targets = [
  files.find((entry) => entry.content.includes('function createVideoGenerateTool(options)')),
  files.find((entry) => entry.content.includes('function resolveVideoGenerationOverrides(params)')),
  files.find((entry) => entry.content.includes('function buildOpenAIVideoGenerationProvider()')),
  files.find((entry) => entry.content.includes('function listRuntimeVideoGenerationProviders(params, deps = {})')),
];
assert.ok(targets.every(Boolean), 'expected video tool, runtime, OpenAI provider, and catalog fixtures');

const fixtureDist = mkdtempSync(join(tmpdir(), 'uclaw-video-model-validation-'));
try {
  const uniqueTargets = [...new Map(targets.map((target) => [target.file, target])).values()];
  for (const target of uniqueTargets) cpSync(target.file, join(fixtureDist, basename(target.file)));
  const catalog = patchOpenClawVideoProviderCatalogRuntime(fixtureDist, { logger: { log() {} } });
  assert.equal(catalog.matchedFiles, 1);
  const capability = patchOpenClawVideoCapabilityContractRuntime(fixtureDist, { logger: { log() {} } });
  assert.equal(capability.matchedFiles, 3);
  const first = patchOpenClawVideoModelValidationRuntime(fixtureDist, { logger: { log() {} } });
  assert.equal(first.matchedFiles, 2);
  assert.equal(first.patchedFiles + first.alreadyPatchedFiles, 2);

  const patchedContents = readdirSync(fixtureDist)
    .map((entry) => readFileSync(join(fixtureDist, entry), 'utf8'));
  const toolContent = patchedContents.find((content) => content.includes('function createVideoGenerateTool(options)'));
  const providerContent = patchedContents.find((content) => content.includes('function buildOpenAIVideoGenerationProvider()'));
  assert.match(toolContent, /UCLAW_VIDEO_MODEL_VALIDATION_TOOL_V2/u);
  assert.match(toolContent, /validateVideoGenerationModelSelection/u);
  assert.match(toolContent, /invalid_video_model/u);
  assert.match(providerContent, /UCLAW_VIDEO_CAPABILITY_CONTRACT_OPENAI_V3/u);
  assert.match(providerContent, /UCLAW_VIDEO_MODEL_VALIDATION_OPENAI_V2/u);
  assert.match(providerContent, /isSupportedOpenAIVideoGenerationModel/u);
  assert.match(providerContent, /isSupportedOpenAIVideoGenerationModel\(model, req\.cfg\)/u);
  assert.match(providerContent, /invalid_video_model/u);

  const helperMatch = toolContent.match(
    /function listAdvertisedVideoGenerationModels\(provider\) \{[\s\S]*?\n\}\nfunction validateVideoGenerationModelSelection\(params\) \{[\s\S]*?\n\}/u,
  );
  assert.ok(helperMatch, 'expected generated video model validation helpers');
  class ToolInputError extends Error {}
  const validateVideoGenerationModelSelection = new Function(
    'ToolInputError',
    'parseVideoGenerationModelRef',
    'normalizeProviderId',
    `${helperMatch[0]}; return validateVideoGenerationModelSelection;`,
  )(
    ToolInputError,
    (value) => {
      const separator = typeof value === 'string' ? value.indexOf('/') : -1;
      return separator > 0
        ? { provider: value.slice(0, separator), model: value.slice(separator + 1) }
        : undefined;
    },
    (value) => typeof value === 'string' ? value.trim().toLowerCase() : '',
  );
  const provider = providers[0];
  assert.equal(validateVideoGenerationModelSelection({
    provider,
    primary: 'openai/grok-image-video',
  }), 'grok-image-video');
  assert.equal(validateVideoGenerationModelSelection({
    provider,
    primary: 'openai/grok-image-video',
    modelOverride: 'grok-video-1.5',
  }), 'grok-video-1.5');
  assert.equal(validateVideoGenerationModelSelection({
    provider: slashModelProvider,
    primary: 'fal/fal-ai/minimax/video-01-live',
    modelOverride: 'fal-ai/minimax/video-01-live',
  }), 'fal-ai/minimax/video-01-live');
  assert.throws(() => validateVideoGenerationModelSelection({
    provider,
    primary: 'openai/grok-image-video',
    modelOverride: 'smart-latest',
  }), /invalid_video_model/u);

  for (const entry of readdirSync(fixtureDist)) {
    const checked = spawnSync(process.execPath, ['--check', join(fixtureDist, entry)], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  }

  const second = patchOpenClawVideoModelValidationRuntime(fixtureDist, { logger: { log() {} } });
  assert.deepEqual(second, { matchedFiles: 2, patchedFiles: 0, alreadyPatchedFiles: 2 });
} finally {
  rmSync(fixtureDist, { recursive: true, force: true });
}

console.log('openclaw video model validation patch tests passed');
