import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_OPENCLAW_VERSION = '2026.7.1-2';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ENDPOINTS_PATH = join(SCRIPT_DIR, '..', 'shared', 'junfeiai-endpoints.json');
const TOOL_PATCH_MARKER = 'UCLAW_IMAGE_MODEL_POLICY_TOOL_VERSION = 1';
const OPENAI_PATCH_MARKER = 'UCLAW_IMAGE_MODEL_POLICY_OPENAI_VERSION = 1';
const MANAGED_IMAGE_PROVIDER_IDS = new Set(['openai', 'clawx-openai-image']);

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function replaceUnique(content, search, replacement, label, filePath) {
  const count = countOccurrences(content, search);
  if (count !== 1) {
    throw new Error(
      `[openclaw-image-model-policy-patch] Expected exactly one ${label} anchor in ${filePath}; found ${count}.`,
    );
  }
  return content.replace(search, replacement);
}

function readSingleJsonStringConstant(content, name, filePath) {
  const pattern = new RegExp(`^const ${name} = (".*");$`, 'gm');
  const matches = [...content.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `[openclaw-image-model-policy-patch] Expected exactly one ${name} constant in ${filePath}; found ${matches.length}.`,
    );
  }
  return {
    statement: matches[0][0],
    value: JSON.parse(matches[0][1]),
  };
}

function readNonEmptyString(value, key) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`[openclaw-image-model-policy-patch] ${key} must be a non-empty string in ${ENDPOINTS_PATH}.`);
  }
  return value.trim();
}

function parseModelRef(value) {
  const ref = typeof value === 'string' ? value.trim() : '';
  const separator = ref.indexOf('/');
  if (separator <= 0 || separator >= ref.length - 1) return null;
  return {
    ref,
    provider: ref.slice(0, separator).trim().toLowerCase(),
    model: ref.slice(separator + 1).trim(),
  };
}

/** Reads the canonical managed image model used by both source and runtime patches. */
export function readOpenClawImageModelPolicyConfig() {
  const endpoints = JSON.parse(readFileSync(ENDPOINTS_PATH, 'utf8'));
  const raw = endpoints.imageGenerationDefaults;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`[openclaw-image-model-policy-patch] imageGenerationDefaults is required in ${ENDPOINTS_PATH}.`);
  }
  const modelRef = readNonEmptyString(raw.modelRef, 'imageGenerationDefaults.modelRef');
  const parsed = parseModelRef(modelRef);
  if (!parsed || parsed.provider !== 'openai') {
    throw new Error('[openclaw-image-model-policy-patch] imageGenerationDefaults.modelRef must use openai/model format.');
  }
  return { modelRef: parsed.ref, provider: parsed.provider, model: parsed.model };
}

/** Resolves a model-supplied override without allowing it to escape the managed image profile. */
export function resolveManagedImageModelOverride(params) {
  const requestedModel = typeof params.requestedModel === 'string' && params.requestedModel.trim()
    ? params.requestedModel.trim()
    : undefined;
  if (!params.managedDistribution || !requestedModel) return requestedModel;

  const configuredPrimary = parseModelRef(params.configuredPrimary);
  const managedModel = parseModelRef(params.managedModelRef);
  if (
    !configuredPrimary
    || !managedModel
    || configuredPrimary.model !== managedModel.model
    || !MANAGED_IMAGE_PROVIDER_IDS.has(configuredPrimary.provider)
  ) {
    return requestedModel;
  }

  const requestedRef = parseModelRef(requestedModel);
  if (
    requestedRef?.model === managedModel.model
    && MANAGED_IMAGE_PROVIDER_IDS.has(requestedRef.provider)
  ) {
    return requestedModel;
  }
  if (!requestedRef && requestedModel === managedModel.model) return requestedModel;
  return configuredPrimary.ref;
}

function toolPolicyHelpers(config) {
  return `const UCLAW_IMAGE_MODEL_POLICY_TOOL_VERSION = 1;
const UCLAW_MANAGED_IMAGE_MODEL_REF = ${JSON.stringify(config.modelRef)};
const UCLAW_MANAGED_IMAGE_MODEL_ID = ${JSON.stringify(config.model)};
const UCLAW_MANAGED_IMAGE_MODEL_POLICY_ENABLED = typeof process === "undefined" || process.env.CLAWX_MANAGED_PROVIDER !== "0";
const UCLAW_MANAGED_IMAGE_PROVIDER_IDS = new Set(["openai", "clawx-openai-image"]);
function resolveUclawManagedImageModelOverride(requestedModel, configuredPrimary) {
\tif (!UCLAW_MANAGED_IMAGE_MODEL_POLICY_ENABLED || !requestedModel?.trim()) return requestedModel;
\tconst primaryRef = parseImageGenerationModelRef(configuredPrimary);
\tif (!primaryRef || primaryRef.model !== UCLAW_MANAGED_IMAGE_MODEL_ID || !UCLAW_MANAGED_IMAGE_PROVIDER_IDS.has(normalizeProviderId(primaryRef.provider))) return requestedModel;
\tconst requestedRef = parseImageGenerationModelRef(requestedModel);
\tif (requestedRef?.model === UCLAW_MANAGED_IMAGE_MODEL_ID && UCLAW_MANAGED_IMAGE_PROVIDER_IDS.has(normalizeProviderId(requestedRef.provider))) return requestedModel;
\tif (!requestedRef && requestedModel.trim() === UCLAW_MANAGED_IMAGE_MODEL_ID) return requestedModel;
\treturn configuredPrimary || UCLAW_MANAGED_IMAGE_MODEL_REF;
}
`;
}

const TOOL_HELPER_ANCHOR = 'function resolveImageGenerationModelConfigForTool(params) {';
const TOOL_MODEL_ANCHOR = `\t\t\tconst model = readStringParam(params, "model");
\t\t\tconst configuredImageGenerationModelConfig = coerceToolModelConfig(cfg.agents?.defaults?.imageGenerationModel);`;
const TOOL_MODEL_PATCH = `\t\t\tconst requestedModel = readStringParam(params, "model");
\t\t\tconst configuredImageGenerationModelConfig = coerceToolModelConfig(cfg.agents?.defaults?.imageGenerationModel);
\t\t\tconst model = resolveUclawManagedImageModelOverride(requestedModel, configuredImageGenerationModelConfig.primary);`;
const TOOL_MODEL_DESCRIPTION_ANCHOR = 'Provider/model override, e.g. openai/gpt-image-2; transparent OpenAI: openai/gpt-image-1.5.';
const TOOL_OPENAI_BACKGROUND_DESCRIPTION_ANCHOR = 'OpenAI background: transparent, opaque, auto. Transparent needs png/webp; default model routes to gpt-image-1.5.';
const TOOL_DESCRIPTION_ANCHOR = 'Transparent: outputFormat=\\"png\\" or \\"webp\\" + background=\\"transparent\\"; OpenAI also supports openai.background and routes default model to gpt-image-1.5.';

function managedToolModelDescription(modelRef) {
  return `Provider/model override. Managed default: ${modelRef}; use only configured provider models.`;
}

function managedToolDescription(modelRef) {
  return `Transparent: outputFormat=\\"png\\" or \\"webp\\" + background=\\"transparent\\"; managed OpenAI default is ${modelRef}.`;
}

export function patchOpenClawImageModelPolicyToolContent(content, config, filePath = '<memory>') {
  if (!content.includes('function createImageGenerateTool(options)')) return null;
  if (content.includes(TOOL_PATCH_MARKER)) {
    if (
      !content.includes('resolveUclawManagedImageModelOverride')
      || content.includes(TOOL_MODEL_DESCRIPTION_ANCHOR)
      || content.includes(TOOL_OPENAI_BACKGROUND_DESCRIPTION_ANCHOR)
      || content.includes(TOOL_DESCRIPTION_ANCHOR)
    ) {
      throw new Error(`[openclaw-image-model-policy-patch] Existing tool patch is incomplete in ${filePath}.`);
    }
    const currentRef = readSingleJsonStringConstant(content, 'UCLAW_MANAGED_IMAGE_MODEL_REF', filePath);
    const currentModel = readSingleJsonStringConstant(content, 'UCLAW_MANAGED_IMAGE_MODEL_ID', filePath);
    let patched = content;
    if (currentRef.value !== config.modelRef) {
      patched = replaceUnique(
        patched,
        currentRef.statement,
        `const UCLAW_MANAGED_IMAGE_MODEL_REF = ${JSON.stringify(config.modelRef)};`,
        'managed image model ref',
        filePath,
      );
      patched = replaceUnique(
        patched,
        managedToolModelDescription(currentRef.value),
        managedToolModelDescription(config.modelRef),
        'managed image tool model description',
        filePath,
      );
      patched = replaceUnique(
        patched,
        managedToolDescription(currentRef.value),
        managedToolDescription(config.modelRef),
        'managed image tool description',
        filePath,
      );
    }
    if (currentModel.value !== config.model) {
      patched = replaceUnique(
        patched,
        currentModel.statement,
        `const UCLAW_MANAGED_IMAGE_MODEL_ID = ${JSON.stringify(config.model)};`,
        'managed image model id',
        filePath,
      );
    }
    return { content: patched, changed: patched !== content, category: 'tool' };
  }

  let patched = replaceUnique(
    content,
    TOOL_HELPER_ANCHOR,
    `${toolPolicyHelpers(config)}${TOOL_HELPER_ANCHOR}`,
    'image tool helper',
    filePath,
  );
  patched = replaceUnique(patched, TOOL_MODEL_ANCHOR, TOOL_MODEL_PATCH, 'image tool model selection', filePath);
  patched = replaceUnique(
    patched,
    TOOL_MODEL_DESCRIPTION_ANCHOR,
    managedToolModelDescription(config.modelRef),
    'image tool model description',
    filePath,
  );
  patched = replaceUnique(
    patched,
    TOOL_OPENAI_BACKGROUND_DESCRIPTION_ANCHOR,
    'OpenAI background: transparent, opaque, auto. Transparent needs png/webp.',
    'image tool OpenAI background description',
    filePath,
  );
  patched = replaceUnique(
    patched,
    TOOL_DESCRIPTION_ANCHOR,
    managedToolDescription(config.modelRef),
    'image tool description',
    filePath,
  );
  return { content: patched, changed: true, category: 'tool' };
}

const OPENAI_MODEL_RESOLVER_ANCHOR = `function resolveOpenAIImageRequestModel(req, options) {
\tconst model = req.model || "gpt-image-2";
\tif (options?.allowTransparentDefaultReroute === true && model === "gpt-image-2" && (req.providerOptions?.openai?.background ?? req.background) === "transparent") return OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL;
\treturn model;
}`;

function openAiModelResolverPatch(config) {
  return `const UCLAW_IMAGE_MODEL_POLICY_OPENAI_VERSION = 1;
const UCLAW_OPENAI_IMAGE_MODEL_POLICY_DEFAULT_MODEL = ${JSON.stringify(config.model)};
const UCLAW_OPENAI_IMAGE_MODEL_POLICY_ENABLED = typeof process === "undefined" || process.env.CLAWX_MANAGED_PROVIDER !== "0";
function resolveOpenAIImageRequestModel(req, options) {
\tconst requestedModel = req.model || UCLAW_OPENAI_IMAGE_MODEL_POLICY_DEFAULT_MODEL;
\tif (UCLAW_OPENAI_IMAGE_MODEL_POLICY_ENABLED) {
\t\tconst separator = requestedModel.indexOf("/");
\t\tconst model = separator > 0 ? requestedModel.slice(separator + 1) : requestedModel;
\t\treturn model === OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL ? UCLAW_OPENAI_IMAGE_MODEL_POLICY_DEFAULT_MODEL : model;
\t}
\tif (options?.allowTransparentDefaultReroute === true && requestedModel === UCLAW_OPENAI_IMAGE_MODEL_POLICY_DEFAULT_MODEL && (req.providerOptions?.openai?.background ?? req.background) === "transparent") return OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL;
\treturn requestedModel;
}`;
}

export function patchOpenClawImageModelPolicyOpenAiContent(content, config, filePath = '<memory>') {
  if (!content.includes('function resolveOpenAIImageRequestModel(req, options)')) return null;
  if (content.includes(OPENAI_PATCH_MARKER)) {
    if (!content.includes('UCLAW_OPENAI_IMAGE_MODEL_POLICY_DEFAULT_MODEL')) {
      throw new Error(`[openclaw-image-model-policy-patch] Existing OpenAI provider patch is incomplete in ${filePath}.`);
    }
    const currentModel = readSingleJsonStringConstant(
      content,
      'UCLAW_OPENAI_IMAGE_MODEL_POLICY_DEFAULT_MODEL',
      filePath,
    );
    if (currentModel.value === config.model) {
      return { content, changed: false, category: 'openai-provider' };
    }
    return {
      content: replaceUnique(
        content,
        currentModel.statement,
        `const UCLAW_OPENAI_IMAGE_MODEL_POLICY_DEFAULT_MODEL = ${JSON.stringify(config.model)};`,
        'OpenAI image default model',
        filePath,
      ),
      changed: true,
      category: 'openai-provider',
    };
  }
  return {
    content: replaceUnique(
      content,
      OPENAI_MODEL_RESOLVER_ANCHOR,
      openAiModelResolverPatch(config),
      'OpenAI image model resolver',
      filePath,
    ),
    changed: true,
    category: 'openai-provider',
  };
}

function assertSupportedOpenClawVersion(distDir) {
  const packagePath = join(distDir, '..', 'package.json');
  if (!existsSync(packagePath)) {
    throw new Error(`[openclaw-image-model-policy-patch] OpenClaw package.json not found: ${packagePath}`);
  }
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (packageJson.version !== EXPECTED_OPENCLAW_VERSION) {
    throw new Error(
      `[openclaw-image-model-policy-patch] Expected OpenClaw ${EXPECTED_OPENCLAW_VERSION}, found ${String(packageJson.version)}.`,
    );
  }
}

/** Patches the installed or bundled OpenClaw image tool and built-in OpenAI provider. */
export function patchOpenClawImageModelPolicyRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-image-model-policy-patch] OpenClaw dist directory not found: ${distDir}`);
  }
  assertSupportedOpenClawVersion(distDir);
  const config = readOpenClawImageModelPolicyConfig();
  const categoryCounts = new Map();
  let matchedFiles = 0;
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;

  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawImageModelPolicyToolContent(content, config, filePath)
      ?? patchOpenClawImageModelPolicyOpenAiContent(content, config, filePath);
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
      throw new Error(`[openclaw-image-model-policy-patch] Expected exactly one ${category} runtime file; found ${count}.`);
    }
  }
  logger.log?.(
    `[openclaw-image-model-policy-patch] ${dryRun ? 'Dry-run matched' : 'Patched'} `
      + `${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`,
  );
  return { matchedFiles, patchedFiles, alreadyPatchedFiles };
}

export function patchInstalledOpenClawImageModelPolicyRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawImageModelPolicyRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
