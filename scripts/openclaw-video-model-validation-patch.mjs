import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOOL_PATCH_MARKER = 'UCLAW_VIDEO_MODEL_VALIDATION_TOOL_V2';
const PREVIOUS_TOOL_PATCH_MARKER = 'UCLAW_VIDEO_MODEL_VALIDATION_TOOL_V1';
const OPENAI_PATCH_MARKER = 'UCLAW_VIDEO_MODEL_VALIDATION_OPENAI_V1';

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function replaceUnique(content, search, replacement, label, filePath) {
  const count = countOccurrences(content, search);
  if (count !== 1) {
    throw new Error(
      `[openclaw-video-model-validation-patch] Expected exactly one ${label} anchor in ${filePath}; found ${count}.`,
    );
  }
  return content.replace(search, replacement);
}

function normalizeProviderId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function parseModelRef(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const separator = normalized.indexOf('/');
  if (separator <= 0 || separator >= normalized.length - 1) return undefined;
  return {
    provider: normalizeProviderId(normalized.slice(0, separator)),
    model: normalized.slice(separator + 1).trim(),
  };
}

function advertisedModels(provider) {
  const models = new Set();
  for (const model of provider?.models ?? []) {
    if (typeof model === 'string' && model.trim()) models.add(model.trim());
  }
  if (models.size === 0 && typeof provider?.defaultModel === 'string' && provider.defaultModel.trim()) {
    models.add(provider.defaultModel.trim());
  }
  return models;
}

export function resolveValidatedVideoModelForCatalog(params) {
  const providers = Array.isArray(params.providers) ? params.providers : [];
  const explicit = typeof params.modelOverride === 'string' && params.modelOverride.trim()
    ? params.modelOverride.trim()
    : undefined;
  const configuredPrimary = typeof params.primary === 'string' && params.primary.trim()
    ? params.primary.trim()
    : undefined;
  const requested = explicit ?? configuredPrimary;
  const selectedProvider = providers.find((candidate) => [candidate?.id, ...(candidate?.aliases ?? [])]
    .map(normalizeProviderId)
    .filter(Boolean)
    .includes(normalizeProviderId(params.selectedProviderId)));
  if (explicit && selectedProvider && advertisedModels(selectedProvider).has(explicit)) {
    return { provider: selectedProvider.id, model: explicit };
  }
  const parsed = parseModelRef(requested);
  const providerHint = parsed?.provider || normalizeProviderId(params.selectedProviderId);
  const provider = providers.find((candidate) => {
    const ids = [candidate?.id, ...(candidate?.aliases ?? [])].map(normalizeProviderId).filter(Boolean);
    return providerHint ? ids.includes(providerHint) : false;
  });
  if (!provider) {
    throw new Error(`invalid_video_model: no video provider is registered for "${requested ?? 'configured primary'}".`);
  }
  const model = parsed?.model || requested || provider.defaultModel;
  if (!model || !advertisedModels(provider).has(model)) {
    throw new Error(`invalid_video_model: "${model ?? requested ?? 'configured primary'}" is not advertised by video provider "${provider.id}".`);
  }
  return { provider: provider.id, model };
}

const TOOL_HELPER_ANCHOR = `function resolveVideoGenerationModelConfigForTool(params) {
\treturn resolveCapabilityModelConfigForTool({
\t\tcfg: params.cfg,
\t\tworkspaceDir: params.workspaceDir,
\t\tagentDir: params.agentDir,
\t\tauthStore: params.authStore,
\t\tmodelConfig: params.cfg?.agents?.defaults?.videoGenerationModel,
\t\tproviders: () => listRuntimeVideoGenerationProviders({ config: params.cfg })
\t});
}
function hasExplicitVideoGenerationModelConfig(cfg) {`;

const TOOL_VALIDATION_HELPERS_PATCH = `const ${TOOL_PATCH_MARKER} = true;
function listAdvertisedVideoGenerationModels(provider) {
\tconst models = new Set();
\tfor (const model of provider?.models ?? []) if (typeof model === "string" && model.trim()) models.add(model.trim());
\tif (models.size === 0 && typeof provider?.defaultModel === "string" && provider.defaultModel.trim()) models.add(provider.defaultModel.trim());
\treturn models;
}
function validateVideoGenerationModelSelection(params) {
\tconst requested = params.modelOverride?.trim() || params.primary?.trim() || params.provider?.defaultModel?.trim();
\tif (!params.provider || !requested) throw new ToolInputError(\`invalid_video_model: no registered video provider/model matches "\${requested ?? "configured primary"}". Call video_generate action:list and choose an advertised video model.\`);
\tconst advertisedModels = listAdvertisedVideoGenerationModels(params.provider);
\tif (params.modelOverride?.trim() && advertisedModels.has(requested)) return requested;
\tconst parsed = parseVideoGenerationModelRef(requested);
\tif (parsed?.provider) {
\t\tconst providerIds = new Set([params.provider.id, ...params.provider.aliases ?? []].map((value) => normalizeProviderId(value)).filter(Boolean));
\t\tif (!providerIds.has(normalizeProviderId(parsed.provider))) throw new ToolInputError(\`invalid_video_model: provider "\${parsed.provider}" is not the selected video provider. Call video_generate action:list and choose an advertised video model.\`);
\t}
\tconst model = parsed?.model ?? requested;
\tif (!advertisedModels.has(model)) throw new ToolInputError(\`invalid_video_model: "\${model}" is not advertised by video provider "\${params.provider.id}". Call video_generate action:list and choose an advertised video model.\`);
\treturn model;
}
function hasExplicitVideoGenerationModelConfig(cfg) {`;

const TOOL_HELPER_PATCH = `function resolveVideoGenerationModelConfigForTool(params) {
\treturn resolveCapabilityModelConfigForTool({
\t\tcfg: params.cfg,
\t\tworkspaceDir: params.workspaceDir,
\t\tagentDir: params.agentDir,
\t\tauthStore: params.authStore,
\t\tmodelConfig: params.cfg?.agents?.defaults?.videoGenerationModel,
\t\tproviders: () => listRuntimeVideoGenerationProviders({ config: params.cfg })
\t});
}
${TOOL_VALIDATION_HELPERS_PATCH}`;

const PREVIOUS_TOOL_HELPER_ANCHOR = `const ${PREVIOUS_TOOL_PATCH_MARKER} = true;
function listAdvertisedVideoGenerationModels(provider) {
\tconst models = new Set();
\tfor (const model of provider?.models ?? []) if (typeof model === "string" && model.trim()) models.add(model.trim());
\tif (models.size === 0 && typeof provider?.defaultModel === "string" && provider.defaultModel.trim()) models.add(provider.defaultModel.trim());
\treturn models;
}
function validateVideoGenerationModelSelection(params) {
\tconst requested = params.modelOverride?.trim() || params.primary?.trim() || params.provider?.defaultModel?.trim();
\tif (!params.provider || !requested) throw new ToolInputError(\`invalid_video_model: no registered video provider/model matches "\${requested ?? "configured primary"}". Call video_generate action:list and choose an advertised video model.\`);
\tconst parsed = parseVideoGenerationModelRef(requested);
\tif (parsed?.provider) {
\t\tconst providerIds = new Set([params.provider.id, ...params.provider.aliases ?? []].map((value) => normalizeProviderId(value)).filter(Boolean));
\t\tif (!providerIds.has(normalizeProviderId(parsed.provider))) throw new ToolInputError(\`invalid_video_model: provider "\${parsed.provider}" is not the selected video provider. Call video_generate action:list and choose an advertised video model.\`);
\t}
\tconst model = parsed?.model ?? requested;
\tif (!listAdvertisedVideoGenerationModels(params.provider).has(model)) throw new ToolInputError(\`invalid_video_model: "\${model}" is not advertised by video provider "\${params.provider.id}". Call video_generate action:list and choose an advertised video model.\`);
\treturn model;
}
function hasExplicitVideoGenerationModelConfig(cfg) {`;

const PREVIOUS_TOOL_HELPER_PATCH = TOOL_VALIDATION_HELPERS_PATCH;

const TOOL_CALL_ANCHOR = `\t\t\tconst selectedProvider = resolveSelectedVideoGenerationProvider({
\t\t\t\tconfig: effectiveCfg,
\t\t\t\tvideoGenerationModelConfig,
\t\t\t\tmodelOverride: model
\t\t\t});
\t\t\tconst explicitModelRef = parseVideoGenerationModelRef(model);`;

const TOOL_CALL_PATCH = `\t\t\tconst selectedProvider = resolveSelectedVideoGenerationProvider({
\t\t\t\tconfig: effectiveCfg,
\t\t\t\tvideoGenerationModelConfig,
\t\t\t\tmodelOverride: model
\t\t\t});
\t\t\tvalidateVideoGenerationModelSelection({
\t\t\t\tprovider: selectedProvider,
\t\t\t\tmodelOverride: model,
\t\t\t\tprimary: videoGenerationModelConfig.primary
\t\t\t});
\t\t\tconst explicitModelRef = parseVideoGenerationModelRef(model);`;

export function patchOpenClawVideoModelValidationToolContent(content, filePath = '<memory>') {
  if (!content.includes('function createVideoGenerateTool(options)')) return null;
  if (content.includes(TOOL_PATCH_MARKER)) return { content, changed: false, category: 'tool' };
  if (content.includes(PREVIOUS_TOOL_PATCH_MARKER)) {
    return {
      content: replaceUnique(
        content,
        PREVIOUS_TOOL_HELPER_ANCHOR,
        PREVIOUS_TOOL_HELPER_PATCH,
        'previous video tool model validation helper',
        filePath,
      ),
      changed: true,
      category: 'tool',
    };
  }
  let patched = replaceUnique(content, TOOL_HELPER_ANCHOR, TOOL_HELPER_PATCH, 'video tool helper', filePath);
  patched = replaceUnique(patched, TOOL_CALL_ANCHOR, TOOL_CALL_PATCH, 'video tool validation call', filePath);
  return { content: patched, changed: true, category: 'tool' };
}

const OPENAI_HELPER_ANCHOR = `function isUClawOpenAIGrokVideoModel(model) {
\treturn model === UCLAW_OPENAI_GROK_VIDEO_MODEL || model === UCLAW_OPENAI_GROK_VIDEO_15_MODEL;
}`;

const OPENAI_HELPER_PATCH = `function isUClawOpenAIGrokVideoModel(model) {
\treturn model === UCLAW_OPENAI_GROK_VIDEO_MODEL || model === UCLAW_OPENAI_GROK_VIDEO_15_MODEL;
}
const ${OPENAI_PATCH_MARKER} = true;
function isSupportedOpenAIVideoGenerationModel(model) {
\treturn model === DEFAULT_OPENAI_VIDEO_MODEL || model === "sora-2-pro" || isUClawOpenAIGrokVideoModel(model);
}`;

const OPENAI_CALL_ANCHOR = `\t\t\tconst model = normalizeOptionalString(req.model) ?? DEFAULT_OPENAI_VIDEO_MODEL;
\t\t\tconst seconds = resolveDurationSeconds(req.durationSeconds, model);`;

const OPENAI_CALL_PATCH = `\t\t\tconst model = normalizeOptionalString(req.model) ?? DEFAULT_OPENAI_VIDEO_MODEL;
\t\t\tif (!isSupportedOpenAIVideoGenerationModel(model)) throw new Error(\`invalid_video_model: "\${model}" is not supported by the OpenAI video-generation provider.\`);
\t\t\tconst seconds = resolveDurationSeconds(req.durationSeconds, model);`;

export function patchOpenClawOpenAiVideoModelValidationContent(content, filePath = '<memory>') {
  if (!content.includes('function buildOpenAIVideoGenerationProvider()')) return null;
  if (content.includes(OPENAI_PATCH_MARKER)) return { content, changed: false, category: 'openai-provider' };
  let patched = replaceUnique(content, OPENAI_HELPER_ANCHOR, OPENAI_HELPER_PATCH, 'OpenAI video model helper', filePath);
  patched = replaceUnique(patched, OPENAI_CALL_ANCHOR, OPENAI_CALL_PATCH, 'OpenAI video model validation call', filePath);
  return { content: patched, changed: true, category: 'openai-provider' };
}

export function patchOpenClawVideoModelValidationRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-video-model-validation-patch] OpenClaw dist directory not found: ${distDir}`);
  }
  const categoryCounts = new Map();
  let matchedFiles = 0;
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawVideoModelValidationToolContent(content, filePath)
      ?? patchOpenClawOpenAiVideoModelValidationContent(content, filePath);
    if (!result) continue;
    matchedFiles += 1;
    categoryCounts.set(result.category, (categoryCounts.get(result.category) ?? 0) + 1);
    if (result.changed) {
      patchedFiles += 1;
      if (!dryRun) writeFileSync(filePath, result.content, 'utf8');
    } else {
      alreadyPatchedFiles += 1;
    }
  }
  for (const category of ['tool', 'openai-provider']) {
    const count = categoryCounts.get(category) ?? 0;
    if (count !== 1) {
      throw new Error(`[openclaw-video-model-validation-patch] Expected exactly one ${category} runtime file; found ${count}.`);
    }
  }
  logger.log?.(
    `[openclaw-video-model-validation-patch] ${dryRun ? 'Dry-run matched' : 'Patched'} ${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`,
  );
  return { matchedFiles, patchedFiles, alreadyPatchedFiles };
}

export function patchInstalledOpenClawVideoModelValidationRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawVideoModelValidationRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
