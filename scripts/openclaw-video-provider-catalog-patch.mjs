import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_MARKER = 'UCLAW_CONFIGURED_VIDEO_MODELS_IN_CATALOG_V5';
const PREVIOUS_PATCH_MARKER = 'UCLAW_CONFIGURED_VIDEO_MODELS_IN_CATALOG_V4';
const OLDER_PATCH_MARKER = 'UCLAW_CONFIGURED_VIDEO_MODELS_IN_CATALOG_V3';
const LEGACY_PATCH_MARKER = 'UCLAW_CONFIGURED_VIDEO_MODELS_IN_CATALOG_V2';
const INITIAL_PATCH_MARKER = 'UCLAW_CONFIGURED_VIDEO_MODELS_IN_CATALOG';

export function patchOpenClawVideoProviderCatalogContent(content) {
  const anchor = `function listRuntimeVideoGenerationProviders(params, deps = {}) {
\treturn (deps.listProviders ?? listVideoGenerationProviders)(params?.config);
}`;
  if (content.includes(PATCH_MARKER)) return { content, changed: false, matched: true };
  const previousAnchor = `function listRuntimeVideoGenerationProviders(params, deps = {}) {
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
\t}); // ${PREVIOUS_PATCH_MARKER}
}`;
  const olderAnchor = `function listRuntimeVideoGenerationProviders(params, deps = {}) {
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
\t\treturn {
\t\t\t...provider,
\t\t\tdefaultModel: primaryModelRef?.provider === provider.id ? primaryModelRef.model : provider.defaultModel,
\t\t\tmodels: [...new Set([...(configuredByProvider.get(provider.id) ?? []), ...providerModels, ...(provider.models ?? [])])]
\t\t};
\t}); // ${OLDER_PATCH_MARKER}
}`;
  const legacyAnchor = `function listRuntimeVideoGenerationProviders(params, deps = {}) {
\tconst providers = (deps.listProviders ?? listVideoGenerationProviders)(params?.config);
\tconst modelConfig = params?.config?.agents?.defaults?.videoGenerationModel;
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
\t\treturn {
\t\t\t...provider,
\t\t\tmodels: [...new Set([...(configuredByProvider.get(provider.id) ?? []), ...providerModels, ...(provider.models ?? [])])]
\t\t};
\t}); // ${LEGACY_PATCH_MARKER}
}`;
  const initialAnchor = `function listRuntimeVideoGenerationProviders(params, deps = {}) {
\tconst providers = (deps.listProviders ?? listVideoGenerationProviders)(params?.config);
\tconst modelConfig = params?.config?.agents?.defaults?.videoGenerationModel;
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
\treturn providers.map((provider) => ({
\t\t...provider,
\t\tmodels: [...new Set([...(configuredByProvider.get(provider.id) ?? []), ...(provider.models ?? [])])]
\t})); // ${INITIAL_PATCH_MARKER}
}`;
  const patchAnchor = content.includes(previousAnchor)
    ? previousAnchor
    : content.includes(olderAnchor)
      ? olderAnchor
      : content.includes(legacyAnchor)
        ? legacyAnchor
        : content.includes(initialAnchor)
          ? initialAnchor
          : anchor;
  if (!content.includes(patchAnchor)) return { content, changed: false, matched: false };
  const replacement = `function listRuntimeVideoGenerationProviders(params, deps = {}) {
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
\t\tconst hasConfiguredModels = Array.isArray(configuredProvider?.models);
\t\tconst configuredModels = hasConfiguredModels ? configuredProvider.models.map((entry) => typeof entry === "string" ? entry : entry?.id).filter((model) => typeof model === "string" && model.trim()) : [];
\t\tconst configuredModelSet = new Set(configuredModels);
\t\tconst nativeModels = Array.isArray(provider.models) ? provider.models.filter((model) => typeof model === "string" && model.trim()) : [];
\t\tconst nativeModelSet = new Set(nativeModels);
\t\tconst capabilityModels = Object.values(provider.capabilities ?? {}).flatMap((capability) => capability && typeof capability === "object" && capability.modelCapabilities && typeof capability.modelCapabilities === "object" ? Object.keys(capability.modelCapabilities) : []).filter((model) => configuredModelSet.has(model));
\t\tconst capabilityModelSet = new Set(capabilityModels);
\t\tconst isVideoModel = (model) => nativeModelSet.has(model) || capabilityModelSet.has(model);
\t\tconst configuredVideoModels = (configuredByProvider.get(provider.id) ?? []).filter(isVideoModel);
\t\tconst catalogModels = hasConfiguredModels ? configuredModels.filter(isVideoModel) : nativeModels;
\t\tconst models = [...new Set([...configuredVideoModels, ...catalogModels])];
\t\tconst requestedDefault = primaryModelRef?.provider === provider.id ? primaryModelRef.model : undefined;
\t\tconst defaultModel = requestedDefault && models.includes(requestedDefault) ? requestedDefault : models.includes(provider.defaultModel) ? provider.defaultModel : models[0];
\t\treturn {
\t\t\t...provider,
\t\t\tdefaultModel,
\t\t\tmodels
\t\t};
\t}); // ${PATCH_MARKER}
}`;
  return { content: content.replace(patchAnchor, replacement), changed: true, matched: true };
}

export function patchOpenClawVideoProviderCatalogRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) throw new Error(`[openclaw-video-provider-catalog-patch] OpenClaw dist directory not found: ${distDir}`);
  let matchedFiles = 0;
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawVideoProviderCatalogContent(content);
    if (!result.matched) continue;
    matchedFiles += 1;
    if (result.changed) {
      patchedFiles += 1;
      if (!dryRun) writeFileSync(filePath, result.content, 'utf8');
    } else alreadyPatchedFiles += 1;
  }
  if (matchedFiles !== 1) throw new Error(`[openclaw-video-provider-catalog-patch] Expected one runtime file; found ${matchedFiles}.`);
  logger.log?.(`[openclaw-video-provider-catalog-patch] ${dryRun ? 'Dry-run matched' : 'Patched'} ${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`);
  return { matchedFiles, patchedFiles, alreadyPatchedFiles };
}

export function patchInstalledOpenClawVideoProviderCatalogRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawVideoProviderCatalogRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
