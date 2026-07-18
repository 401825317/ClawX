import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROVIDER_PATCH_MARKER = 'UCLAW_IMAGE_MODEL_LOCK_PROVIDER_V1';
const TOOL_PATCH_MARKER = 'UCLAW_IMAGE_MODEL_LOCK_TOOL_V1';
const OPENAI_IMAGE_1 = 'gpt-image-' + '1';
const OPENAI_IMAGE_1_5 = `${OPENAI_IMAGE_1}.5`;
const OPENAI_IMAGE_1_MINI = `${OPENAI_IMAGE_1}-mini`;
const OPENAI_IMAGE_1_5_SUFFIX = '.5';

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function replaceUnique(content, search, replacement, label, filePath) {
  const count = countOccurrences(content, search);
  if (count !== 1) {
    throw new Error(
      `[openclaw-image-model-lock-patch] Expected exactly one ${label} anchor in ${filePath}; found ${count}.`,
    );
  }
  return content.replace(search, replacement);
}

const PROVIDER_MODEL_CONSTANT_ANCHOR = `const OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL = "${OPENAI_IMAGE_1_5}";`;
const PROVIDER_MODEL_CONSTANT_PATCH = `const ${PROVIDER_PATCH_MARKER} = true;
const OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL = OPENAI_DEFAULT_IMAGE_MODEL;`;

const PROVIDER_MODELS_ANCHOR = `const OPENAI_IMAGE_MODELS = [
\tOPENAI_DEFAULT_IMAGE_MODEL,
\tOPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL,
\t"${OPENAI_IMAGE_1}",
\t"${OPENAI_IMAGE_1_MINI}"
];`;
const PROVIDER_MODELS_PATCH = `const OPENAI_IMAGE_MODELS = [
\tOPENAI_DEFAULT_IMAGE_MODEL
];`;

const PROVIDER_RESOLVERS_ANCHOR = `function resolveOpenAIImageRequestModel(req, options) {
\tconst model = req.model || "gpt-image-2";
\tif (options?.allowTransparentDefaultReroute === true && model === "gpt-image-2" && (req.providerOptions?.openai?.background ?? req.background) === "transparent") return OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL;
\treturn model;
}
function resolveNativeOpenAIImageSizesForModel(model) {
\tswitch (model) {
\t\tcase "${OPENAI_IMAGE_1}":
\t\tcase "${OPENAI_IMAGE_1_MINI}": return OPENAI_LEGACY_IMAGE_SIZES;
\t\tdefault: return OPENAI_SUPPORTED_SIZES;
\t}
}`;
const PROVIDER_RESOLVERS_PATCH = `function resolveOpenAIImageRequestModel(_req, _options) {
\treturn OPENAI_DEFAULT_IMAGE_MODEL;
}
function resolveNativeOpenAIImageSizesForModel(_model) {
\treturn OPENAI_SUPPORTED_SIZES;
}`;

export function patchOpenClawImageModelLockProviderContent(content, filePath = '<memory>') {
  if (content.includes(PROVIDER_PATCH_MARKER)) return { content, changed: false, category: 'provider' };
  if (!content.includes('function resolveOpenAIImageRequestModel(req, options)')) return null;
  let patched = replaceUnique(
    content,
    PROVIDER_MODEL_CONSTANT_ANCHOR,
    PROVIDER_MODEL_CONSTANT_PATCH,
    'OpenAI transparent image model constant',
    filePath,
  );
  patched = replaceUnique(
    patched,
    PROVIDER_MODELS_ANCHOR,
    PROVIDER_MODELS_PATCH,
    'OpenAI image model catalog',
    filePath,
  );
  patched = replaceUnique(
    patched,
    PROVIDER_RESOLVERS_ANCHOR,
    PROVIDER_RESOLVERS_PATCH,
    'OpenAI image model resolvers',
    filePath,
  );
  return { content: patched, changed: true, category: 'provider' };
}

const TOOL_SCHEMA_ANCHOR = `const ImageGenerateToolSchema = Type.Object({`;
const TOOL_SCHEMA_PATCH = `const ${TOOL_PATCH_MARKER} = true;
const ImageGenerateToolSchema = Type.Object({`;

const TOOL_MODEL_DESCRIPTION_ANCHOR =
  'model: Type.Optional(Type.String({ description: "Provider/model override, e.g. openai/gpt-image-2; transparent OpenAI: openai/gpt-image-'
  + '1'
  + OPENAI_IMAGE_1_5_SUFFIX
  + '." })),';
const TOOL_MODEL_DESCRIPTION_PATCH = `model: Type.Optional(Type.String({ description: "Image generation model is fixed to openai/gpt-image-2." })),`;

const TOOL_OPENAI_BACKGROUND_DESCRIPTION_ANCHOR =
  'background: optionalStringEnum(SUPPORTED_BACKGROUNDS, { description: "OpenAI background: transparent, opaque, auto. Transparent needs png/webp; default model routes to gpt-image-'
  + '1'
  + OPENAI_IMAGE_1_5_SUFFIX
  + '." }),';
const TOOL_OPENAI_BACKGROUND_DESCRIPTION_PATCH = `background: optionalStringEnum(SUPPORTED_BACKGROUNDS, { description: "OpenAI background: transparent, opaque, auto. Transparent requests keep openai/gpt-image-2." }),`;

const TOOL_DESCRIPTION_ANCHOR =
  'description: "Create/edit images. Session chats: background task; do not call image_generate again for same request; wait completion, then report through the current visible-reply contract with generated media attached using structured media fields. Transparent: outputFormat=\\"png\\" or \\"webp\\" + background=\\"transparent\\"; OpenAI also supports openai.background and routes default model to gpt-image-'
  + '1'
  + OPENAI_IMAGE_1_5_SUFFIX
  + '. Use action=\\"list\\" for providers/models/readiness/auth, \\"status\\" for active task.",';
const TOOL_DESCRIPTION_PATCH = `description: "Create/edit images with the configured image-generation model. Session chats: background task; do not call image_generate again for same request; wait completion, then report through the current visible-reply contract with generated media attached using structured media fields. UClaw locks OpenAI image generation to gpt-image-2. Use action=\\"list\\" for providers/models/readiness/auth, \\"status\\" for active task.",`;

export function patchOpenClawImageModelLockToolContent(content, filePath = '<memory>') {
  if (content.includes(TOOL_PATCH_MARKER)) return { content, changed: false, category: 'tool' };
  if (!content.includes('const ImageGenerateToolSchema = Type.Object({')) return null;
  let patched = replaceUnique(content, TOOL_SCHEMA_ANCHOR, TOOL_SCHEMA_PATCH, 'image tool schema', filePath);
  patched = replaceUnique(
    patched,
    TOOL_MODEL_DESCRIPTION_ANCHOR,
    TOOL_MODEL_DESCRIPTION_PATCH,
    'image tool model description',
    filePath,
  );
  patched = replaceUnique(
    patched,
    TOOL_OPENAI_BACKGROUND_DESCRIPTION_ANCHOR,
    TOOL_OPENAI_BACKGROUND_DESCRIPTION_PATCH,
    'image tool OpenAI background description',
    filePath,
  );
  patched = replaceUnique(
    patched,
    TOOL_DESCRIPTION_ANCHOR,
    TOOL_DESCRIPTION_PATCH,
    'image tool description',
    filePath,
  );
  return { content: patched, changed: true, category: 'tool' };
}

export function patchOpenClawImageModelLockRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-image-model-lock-patch] OpenClaw dist directory not found: ${distDir}`);
  }

  const categoryCounts = new Map();
  let matchedFiles = 0;
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawImageModelLockProviderContent(content, filePath)
      ?? patchOpenClawImageModelLockToolContent(content, filePath);
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

  for (const category of ['provider', 'tool']) {
    const count = categoryCounts.get(category) ?? 0;
    if (count !== 1) {
      throw new Error(`[openclaw-image-model-lock-patch] Expected exactly one ${category} runtime file; found ${count}.`);
    }
  }
  logger.log?.(
    `[openclaw-image-model-lock-patch] ${dryRun ? 'Dry-run matched' : 'Patched'} ${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`,
  );
  return { matchedFiles, patchedFiles, alreadyPatchedFiles };
}

export function patchInstalledOpenClawImageModelLockRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawImageModelLockRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
