import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ENDPOINTS_PATH = join(SCRIPT_DIR, '..', 'shared', 'junfeiai-endpoints.json');
const PATCH_MARKER = 'UCLAW_MANAGED_MEDIA_TIMEOUT_V1';
const VIDEO_STATUS_MARKER = 'UCLAW_MANAGED_VIDEO_STATUS_V1';
const VIDEO_OUTPUT_URL_MARKER = 'UCLAW_MANAGED_VIDEO_OUTPUT_URL_V1';
const VIDEO_IMAGE_REFERENCE_MARKER = 'UCLAW_MANAGED_VIDEO_IMAGE_REFERENCE_V1';
const MANAGED_VIDEO_COMPLETE_STATUS_EXPRESSION = '["completed", "done", "succeeded"].includes(payload.status) || Boolean(resolveOpenAIVideoOutputUrl(payload))';
const MANAGED_VIDEO_OUTPUT_URL_HELPER = `// ${VIDEO_OUTPUT_URL_MARKER}
function resolveOpenAIVideoOutputUrl(payload) {
\tconst outputUrl = Array.isArray(payload.output) ? payload.output.find((value) => typeof value === "string") : void 0;
\treturn normalizeOptionalString(payload.video?.url)
\t\t?? normalizeOptionalString(payload.video_url)
\t\t?? normalizeOptionalString(payload.result_url)
\t\t?? normalizeOptionalString(payload.url)
\t\t?? normalizeOptionalString(payload.metadata?.url)
\t\t?? normalizeOptionalString(outputUrl);
}`;

function readManagedTimeouts() {
  const endpoints = JSON.parse(readFileSync(ENDPOINTS_PATH, 'utf8'));
  const imageTimeoutMs = endpoints.imageGenerationTimeoutMs;
  const videoTimeoutMs = endpoints.videoGenerationTimeoutMs;
  const videoPollIntervalMs = endpoints.videoGenerationPollIntervalMs;
  for (const [name, value] of Object.entries({ imageTimeoutMs, videoTimeoutMs, videoPollIntervalMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`[openclaw-managed-media-timeout-patch] ${name} must be a positive integer in ${ENDPOINTS_PATH}.`);
    }
  }
  return {
    imageTimeoutMs,
    videoTimeoutMs,
    videoPollIntervalMs,
    // One final attempt lets the provider-owned deadline enforce the full timeout.
    videoPollMaxAttempts: Math.ceil(videoTimeoutMs / videoPollIntervalMs) + 1,
  };
}

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function replaceUnique(content, search, replacement, label, filePath) {
  const count = countOccurrences(content, search);
  if (count !== 1) {
    throw new Error(`[openclaw-managed-media-timeout-patch] Expected exactly one ${label} anchor in ${filePath}; found ${count}.`);
  }
  return content.replace(search, replacement);
}

function patchMediaToolContent(content, filePath, timeouts) {
  const expected = `const timeoutMs = videoGenerationModelConfig.timeoutMs ?? ${timeouts.videoTimeoutMs}; // ${PATCH_MARKER}`;
  if (content.includes(expected)) {
    return { content, changed: false, category: 'media-tool' };
  }
  const hasManagedToolTimeout = content.includes('const timeoutMs = videoGenerationModelConfig.timeoutMs ??');
  const hasOriginalToolTimeout = content.includes('const timeoutMs = readGenerationTimeoutMs(args) ?? videoGenerationModelConfig.timeoutMs;');
  if (!hasManagedToolTimeout && !hasOriginalToolTimeout) return null;
  const patchedTimeoutPattern = /const timeoutMs = videoGenerationModelConfig\.timeoutMs \?\? \d+; \/\/ UCLAW_MANAGED_MEDIA_TIMEOUT_V1/g;
  if (content.includes(PATCH_MARKER)) {
    const matches = content.match(patchedTimeoutPattern) ?? [];
    if (matches.length !== 1) {
      throw new Error(`[openclaw-managed-media-timeout-patch] Expected exactly one managed video tool timeout in ${filePath}; found ${matches.length}.`);
    }
    return { content: content.replace(patchedTimeoutPattern, expected), changed: true, category: 'media-tool' };
  }
  return {
    content: replaceUnique(
      content,
      'const timeoutMs = readGenerationTimeoutMs(args) ?? videoGenerationModelConfig.timeoutMs;',
      expected,
      'video tool timeout',
      filePath,
    ),
    changed: true,
    category: 'media-tool',
  };
}

function patchOpenAiVideoProviderContent(content, filePath, timeouts) {
  if (!content.includes('extensions/openai/video-generation-provider.ts')) return null;
  const expectedTimeout = `const DEFAULT_TIMEOUT_MS = ${timeouts.videoTimeoutMs}; // ${PATCH_MARKER}`;
  const expectedPollInterval = `const POLL_INTERVAL_MS = ${timeouts.videoPollIntervalMs}; // ${PATCH_MARKER}`;
  const expectedMaxAttempts = `const MAX_POLL_ATTEMPTS = ${timeouts.videoPollMaxAttempts}; // ${PATCH_MARKER}`;
  const expectedCompletion = `isComplete: (payload) => ${MANAGED_VIDEO_COMPLETE_STATUS_EXPRESSION}, // ${VIDEO_STATUS_MARKER}`;
  const expectedDownloadStart = `\tconst outputUrl = normalizeOptionalString(params.outputUrl);\n\tconst url = outputUrl ? new URL(outputUrl) : new URL(\`${'${params.baseUrl}'}/videos/${'${params.videoId}'}/content\`);\n\tif (!outputUrl) url.searchParams.set("variant", "video");`;
  const expectedDownloadCall = '\t\t\t\t\t\toutputUrl: resolveOpenAIVideoOutputUrl(completed),';
  const expectedImageReference = `image: toOpenAIDataUrl(referenceAsset.buffer, referenceAsset.mimeType), // ${VIDEO_IMAGE_REFERENCE_MARKER}`;
  if (content.includes(expectedTimeout)
    && content.includes(expectedPollInterval)
    && content.includes(expectedMaxAttempts)
    && content.includes(expectedCompletion)
    && content.includes(VIDEO_OUTPUT_URL_MARKER)
    && content.includes(expectedDownloadStart)
    && content.includes(expectedDownloadCall)
    && content.includes(expectedImageReference)) {
    return { content, changed: false, category: 'openai-video-provider' };
  }
  const patchedTimeoutPattern = /const DEFAULT_TIMEOUT_MS = \d+; \/\/ UCLAW_MANAGED_MEDIA_TIMEOUT_V1/g;
  const patchedPollIntervalPattern = /const POLL_INTERVAL_MS = \d+; \/\/ UCLAW_MANAGED_MEDIA_TIMEOUT_V1/g;
  const patchedAttemptsPattern = /const MAX_POLL_ATTEMPTS = \d+; \/\/ UCLAW_MANAGED_MEDIA_TIMEOUT_V1/g;
  let patched = content;
  const timeoutMatches = patched.match(patchedTimeoutPattern) ?? [];
  if (timeoutMatches.length > 1) {
    throw new Error(`[openclaw-managed-media-timeout-patch] Expected exactly one managed OpenAI video timeout in ${filePath}; found ${timeoutMatches.length}.`);
  }
  patched = timeoutMatches.length === 1
    ? patched.replace(patchedTimeoutPattern, expectedTimeout)
    : replaceUnique(patched, 'const DEFAULT_TIMEOUT_MS = 12e4;', expectedTimeout, 'OpenAI video provider timeout', filePath);
  const pollIntervalMatches = patched.match(patchedPollIntervalPattern) ?? [];
  if (pollIntervalMatches.length > 1) {
    throw new Error(`[openclaw-managed-media-timeout-patch] Expected exactly one managed OpenAI video poll interval in ${filePath}; found ${pollIntervalMatches.length}.`);
  }
  patched = pollIntervalMatches.length === 1
    ? patched.replace(patchedPollIntervalPattern, expectedPollInterval)
    : replaceUnique(patched, 'const POLL_INTERVAL_MS = 2500;', expectedPollInterval, 'OpenAI video provider poll interval', filePath);
  const attemptsMatches = patched.match(patchedAttemptsPattern) ?? [];
  if (attemptsMatches.length > 1) {
    throw new Error(`[openclaw-managed-media-timeout-patch] Expected exactly one managed OpenAI video poll limit in ${filePath}; found ${attemptsMatches.length}.`);
  }
  patched = attemptsMatches.length === 1
    ? patched.replace(patchedAttemptsPattern, expectedMaxAttempts)
    : replaceUnique(patched, 'const MAX_POLL_ATTEMPTS = 120;', expectedMaxAttempts, 'OpenAI video provider poll limit', filePath);
  const managedCompletionPattern = /isComplete: \(payload\) => [^\n]+\/\/ UCLAW_MANAGED_VIDEO_STATUS_V1/g;
  const completionMatches = patched.match(managedCompletionPattern) ?? [];
  if (completionMatches.length > 1) {
    throw new Error(`[openclaw-managed-media-timeout-patch] Expected exactly one managed OpenAI video completion status in ${filePath}; found ${completionMatches.length}.`);
  }
  patched = completionMatches.length === 1
    ? patched.replace(managedCompletionPattern, expectedCompletion)
    : replaceUnique(
      patched,
      'isComplete: (payload) => payload.status === "completed",',
      expectedCompletion,
      'OpenAI video provider completion status',
      filePath,
    );
  if (!patched.includes(VIDEO_OUTPUT_URL_MARKER)) {
    patched = replaceUnique(
      patched,
      'function resolveOpenAIVideoDownloadTimeoutMs(timeoutMs) {',
      `${MANAGED_VIDEO_OUTPUT_URL_HELPER}\nfunction resolveOpenAIVideoDownloadTimeoutMs(timeoutMs) {`,
      'OpenAI video output URL helper',
      filePath,
    );
  }
  const originalDownloadStart = '\tconst url = new URL(`${params.baseUrl}/videos/${params.videoId}/content`);\n\turl.searchParams.set("variant", "video");';
  if (!patched.includes(expectedDownloadStart)) {
    patched = replaceUnique(
      patched,
      originalDownloadStart,
      expectedDownloadStart,
      'OpenAI video download URL',
      filePath,
    );
  }
  if (!patched.includes(expectedDownloadCall)) {
    patched = replaceUnique(
      patched,
      '\t\t\t\t\t\tbaseUrl,\n\t\t\t\t\t\tsignal: req.signal,\n\t\t\t\t\t\tfetchFn,\n\t\t\t\t\t\tallowPrivateNetwork,\n\t\t\t\t\t\tdispatcherPolicy,\n\t\t\t\t\t\tmaxBytes:',
      '\t\t\t\t\t\tbaseUrl,\n\t\t\t\t\t\toutputUrl: resolveOpenAIVideoOutputUrl(completed),\n\t\t\t\t\t\tsignal: req.signal,\n\t\t\t\t\t\tfetchFn,\n\t\t\t\t\t\tallowPrivateNetwork,\n\t\t\t\t\t\tdispatcherPolicy,\n\t\t\t\t\t\tmaxBytes:',
      'OpenAI video result URL download',
      filePath,
    );
  }
  const managedImageReferencePattern = /image: toOpenAIDataUrl\(referenceAsset\.buffer, referenceAsset\.mimeType\),? \/\/ UCLAW_MANAGED_VIDEO_IMAGE_REFERENCE_V1/g;
  const imageReferenceMatches = patched.match(managedImageReferencePattern) ?? [];
  if (imageReferenceMatches.length > 1) {
    throw new Error(`[openclaw-managed-media-timeout-patch] Expected exactly one managed OpenAI video image reference in ${filePath}; found ${imageReferenceMatches.length}.`);
  }
  patched = imageReferenceMatches.length === 1
    ? patched.replace(managedImageReferencePattern, expectedImageReference)
    : replaceUnique(
      patched,
      'input_reference: { image_url: toOpenAIDataUrl(referenceAsset.buffer, referenceAsset.mimeType) }',
      expectedImageReference,
      'OpenAI video image reference field',
      filePath,
    );
  return {
    content: patched,
    changed: true,
    category: 'openai-video-provider',
  };
}

export function patchOpenClawManagedMediaTimeoutContent(content, filePath = '<fixture>', timeouts = readManagedTimeouts()) {
  return patchMediaToolContent(content, filePath, timeouts)
    ?? patchOpenAiVideoProviderContent(content, filePath, timeouts)
    ?? { content, changed: false, category: null };
}

export function patchOpenClawManagedMediaTimeoutRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-managed-media-timeout-patch] OpenClaw dist directory not found: ${distDir}`);
  }

  const timeouts = readManagedTimeouts();
  const categoryCounts = new Map();
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawManagedMediaTimeoutContent(content, filePath, timeouts);
    if (!result.category) continue;
    categoryCounts.set(result.category, (categoryCounts.get(result.category) ?? 0) + 1);
    if (result.changed) {
      patchedFiles += 1;
      if (!dryRun) writeFileSync(filePath, result.content, 'utf8');
    } else {
      alreadyPatchedFiles += 1;
    }
  }

  for (const category of ['media-tool', 'openai-video-provider']) {
    const count = categoryCounts.get(category) ?? 0;
    if (count !== 1) {
      throw new Error(`[openclaw-managed-media-timeout-patch] Expected exactly one ${category} runtime file in ${distDir}; found ${count}.`);
    }
  }

  logger.log?.(
    `[openclaw-managed-media-timeout-patch] ${dryRun ? 'Dry-run matched' : 'Patched'} ${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`,
  );
  return { patchedFiles, alreadyPatchedFiles, categoryCounts: Object.fromEntries(categoryCounts) };
}

export function patchInstalledOpenClawManagedMediaTimeoutRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawManagedMediaTimeoutRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
