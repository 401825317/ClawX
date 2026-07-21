import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PATCH_MARKER = 'UCLAW_NATIVE_IMAGE_DELIVERY';
const SOURCE_RUNTIME_FILE = 'openclaw-native-image-delivery-runtime.mjs';
const TARGET_RUNTIME_FILE = 'uclaw-native-image-delivery-runtime.mjs';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function replaceOnce(content, anchor, replacement, label, filePath) {
  const count = content.split(anchor).length - 1;
  if (count !== 1) {
    throw new Error(`[openclaw-native-image-delivery-patch] Expected one ${label} anchor in ${filePath}; found ${count}.`);
  }
  return content.replace(anchor, replacement);
}

export function patchOpenClawNativeImageDeliveryContent(content, filePath = '<fixture>') {
  if (!content.includes('async function executeImageGenerationJob')) {
    return { content, changed: false, category: null };
  }
  if (content.includes(PATCH_MARKER) && content.includes('saveGeneratedImageForDeliveryUClaw')) {
    return { content, changed: false, category: 'image-runtime' };
  }

  const importLine = `import { normalizeGeneratedImageForDelivery as normalizeGeneratedImageForDeliveryUClaw, saveGeneratedImageForDelivery as saveGeneratedImageForDeliveryUClaw } from "./${TARGET_RUNTIME_FILE}"; // ${PATCH_MARKER}\n`;
  const legacyImportLine = `import { normalizeGeneratedImageForDelivery as normalizeGeneratedImageForDeliveryUClaw } from "./${TARGET_RUNTIME_FILE}"; // ${PATCH_MARKER}\n`;
  const legacySaveAnchor = '\tconst savedImages = await Promise.all(deliveryImages.map((image) => saveMediaBuffer(image.buffer, image.mimeType, "tool-image-generation", mediaMaxBytes, params.filename || image.fileName)));';
  const upgradedSave = `\tconst savedImages = await Promise.all(deliveryImages.map((image) => saveGeneratedImageForDeliveryUClaw(saveMediaBuffer, image, {
\t\tmaxBytes: mediaMaxBytes,
\t\toriginalFilename: params.filename || image.fileName
\t})));`;
  if (content.includes(PATCH_MARKER)) {
    const withImport = replaceOnce(content, legacyImportLine, importLine, 'legacy image delivery import', filePath);
    return {
      content: replaceOnce(withImport, legacySaveAnchor, upgradedSave, 'legacy image save', filePath),
      changed: true,
      category: 'image-runtime',
    };
  }

  const saveAnchor = '\tconst mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "image");\n\tconst savedImages = await Promise.all(result.images.map((image) => saveMediaBuffer(image.buffer, image.mimeType, "tool-image-generation", mediaMaxBytes, params.filename || image.fileName)));';
  const savePatch = `\tconst mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "image");
\tconst deliveryImages = await Promise.all(result.images.map((image) => normalizeGeneratedImageForDeliveryUClaw(image, {
\t\tmaxBytes: mediaMaxBytes,
\t\toutputFormat: params.outputFormat,
\t\toutputCompression: params.providerOptions?.openai?.outputCompression,
\t\tbackground: params.background ?? params.providerOptions?.openai?.background
\t})));
${upgradedSave}`;

  const patched = replaceOnce(content, saveAnchor, savePatch, 'image save', filePath);
  return { content: `${importLine}${patched}`, changed: true, category: 'image-runtime' };
}

export function patchOpenClawNativeImageDeliveryRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-native-image-delivery-patch] OpenClaw dist directory not found: ${distDir}`);
  }

  let matched = 0;
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawNativeImageDeliveryContent(content, filePath);
    if (!result.category) continue;
    matched += 1;
    if (result.changed) {
      patchedFiles += 1;
      if (!dryRun) writeFileSync(filePath, result.content, 'utf8');
    } else {
      alreadyPatchedFiles += 1;
    }
  }

  if (matched !== 1) {
    throw new Error(`[openclaw-native-image-delivery-patch] Expected exactly one image runtime file; found ${matched}.`);
  }
  if (!dryRun) copyFileSync(join(SCRIPT_DIR, SOURCE_RUNTIME_FILE), join(distDir, TARGET_RUNTIME_FILE));
  logger.log?.(
    `[openclaw-native-image-delivery-patch] ${dryRun ? 'Dry-run matched' : 'Patched'} `
      + `${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`,
  );
  return { patchedFiles, alreadyPatchedFiles };
}

export function patchInstalledOpenClawNativeImageDeliveryRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawNativeImageDeliveryRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
