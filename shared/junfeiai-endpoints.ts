import endpoints from './junfeiai-endpoints.json';

const VALID_DEFAULT_THINKING_LEVELS = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);
const VALID_OPENCLAW_EXEC_SECURITY = new Set(['deny', 'allowlist', 'full']);
const VALID_OPENCLAW_EXEC_ASK = new Set(['off', 'on-miss', 'always']);
const VALID_OPENCLAW_TEXT_FAILOVER_API_PROTOCOLS = new Set(['openai-completions', 'openai-responses']);
const VALID_VIDEO_GENERATION_RESOLUTIONS = new Set(['480p', '720p']);

export type JunFeiAIOpenClawExecSecurity = 'deny' | 'allowlist' | 'full';
export type JunFeiAIOpenClawExecAsk = 'off' | 'on-miss' | 'always';
export type JunFeiAIOpenClawTranscriptLimit = number | string;
export type JunFeiAIOpenClawTextFailoverApiProtocol = 'openai-completions' | 'openai-responses';
export type JunFeiAIVideoGenerationResolution = '480p' | '720p';

export interface JunFeiAIOpenClawTextFailoverConfig {
  enabled: boolean;
  primaryProvider: string;
  fallbackProvider: string;
  fallbackModel: string;
  fallbackApiProtocol: JunFeiAIOpenClawTextFailoverApiProtocol;
  reusePrimaryBaseUrl: true;
  reusePrimaryApiKey: true;
}

/** Shared production endpoints for JunFeiAI consumers in both Electron processes. */
export const JUNFEIAI_PRODUCTION_ORIGIN = endpoints.productionOrigin.replace(/\/+$/, '');
export const JUNFEIAI_PRODUCTION_PROVIDER_BASE_URL = `${JUNFEIAI_PRODUCTION_ORIGIN}/v1`;

if (endpoints.defaultApiProtocol !== 'openai-responses' && endpoints.defaultApiProtocol !== 'openai-completions') {
  throw new Error('defaultApiProtocol in shared/junfeiai-endpoints.json must be an OpenAI protocol');
}

/** Shared API protocol for the managed text provider. */
export const JUNFEIAI_DEFAULT_API_PROTOCOL = endpoints.defaultApiProtocol;

if (!Number.isInteger(endpoints.defaultModelContextWindow) || endpoints.defaultModelContextWindow <= 0) {
  throw new Error('defaultModelContextWindow in shared/junfeiai-endpoints.json must be a positive integer');
}

/** Shared default model context window, measured in tokens. */
export const JUNFEIAI_DEFAULT_MODEL_CONTEXT_WINDOW = endpoints.defaultModelContextWindow;

if (!VALID_DEFAULT_THINKING_LEVELS.has(endpoints.defaultThinkingLevel)) {
  throw new Error('defaultThinkingLevel in shared/junfeiai-endpoints.json must be a supported thinking level');
}

/** Shared default thinking level for managed JunFeiAI chat. */
export const JUNFEIAI_DEFAULT_THINKING_LEVEL = endpoints.defaultThinkingLevel;

if (!VALID_OPENCLAW_EXEC_SECURITY.has(endpoints.openClawExec.security)) {
  throw new Error('openClawExec.security in shared/junfeiai-endpoints.json must be deny, allowlist, or full');
}
if (!VALID_OPENCLAW_EXEC_ASK.has(endpoints.openClawExec.ask)) {
  throw new Error('openClawExec.ask in shared/junfeiai-endpoints.json must be off, on-miss, or always');
}

/** Default OpenClaw host-command security policy for the managed desktop runtime. */
export const JUNFEIAI_OPENCLAW_EXEC_SECURITY = endpoints.openClawExec.security as JunFeiAIOpenClawExecSecurity;

/** Default OpenClaw host-command approval policy for the managed desktop runtime. */
export const JUNFEIAI_OPENCLAW_EXEC_ASK = endpoints.openClawExec.ask as JunFeiAIOpenClawExecAsk;

function readNonEmptyString(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} in shared/junfeiai-endpoints.json must be a non-empty string`);
  }
  return value.trim();
}

function readAbsolutePath(value: unknown, key: string): string {
  const path = readNonEmptyString(value, key);
  if (!path.startsWith('/')) {
    throw new Error(`${key} in shared/junfeiai-endpoints.json must start with /`);
  }
  return path.replace(/\/+$/, '');
}

const appUpdates = endpoints.appUpdates;
const legacyInstalledFeedBaseUrl = readNonEmptyString(
  appUpdates.legacyInstalledFeedBaseUrl,
  'appUpdates.legacyInstalledFeedBaseUrl',
).replace(/\/+$/, '');
const legacyInstalledFeedUrl = new URL(legacyInstalledFeedBaseUrl);
if (legacyInstalledFeedUrl.protocol !== 'https:') {
  throw new Error('appUpdates.legacyInstalledFeedBaseUrl must use https');
}

/** Managed electron-updater feed path, relative to the active JunFeiAI origin. */
export const JUNFEIAI_APP_UPDATE_MANAGED_FEED_PATH = readAbsolutePath(
  appUpdates.managedFeedPath,
  'appUpdates.managedFeedPath',
);

/** Managed portable-update API path, relative to the active JunFeiAI origin. */
export const JUNFEIAI_APP_UPDATE_MANAGED_API_PATH = readAbsolutePath(
  appUpdates.managedApiPath,
  'appUpdates.managedApiPath',
);

/** Legacy installed-build feed used only as a request-scoped fallback. */
export const JUNFEIAI_APP_UPDATE_LEGACY_INSTALLED_FEED_BASE_URL = legacyInstalledFeedBaseUrl;

const textFailover = endpoints.openClawTextFailover;
if (typeof textFailover.enabled !== 'boolean') {
  throw new Error('openClawTextFailover.enabled in shared/junfeiai-endpoints.json must be boolean');
}
const textFailoverPrimaryProvider = readNonEmptyString(
  textFailover.primaryProvider,
  'openClawTextFailover.primaryProvider',
);
const textFailoverFallbackProvider = readNonEmptyString(
  textFailover.fallbackProvider,
  'openClawTextFailover.fallbackProvider',
);
if (textFailoverPrimaryProvider === textFailoverFallbackProvider) {
  throw new Error('openClawTextFailover fallbackProvider must differ from primaryProvider');
}
const textFailoverFallbackModel = readNonEmptyString(
  textFailover.fallbackModel,
  'openClawTextFailover.fallbackModel',
);
if (!VALID_OPENCLAW_TEXT_FAILOVER_API_PROTOCOLS.has(textFailover.fallbackApiProtocol)) {
  throw new Error('openClawTextFailover.fallbackApiProtocol must be an OpenAI protocol');
}
if (textFailover.reusePrimaryBaseUrl !== true || textFailover.reusePrimaryApiKey !== true) {
  throw new Error('openClawTextFailover must reuse the primary base URL and API key');
}

/** Request-scoped text Provider fallback owned by the managed desktop runtime. */
export const JUNFEIAI_OPENCLAW_TEXT_FAILOVER: Readonly<JunFeiAIOpenClawTextFailoverConfig> = Object.freeze({
  enabled: textFailover.enabled,
  primaryProvider: textFailoverPrimaryProvider,
  fallbackProvider: textFailoverFallbackProvider,
  fallbackModel: textFailoverFallbackModel,
  fallbackApiProtocol: textFailover.fallbackApiProtocol as JunFeiAIOpenClawTextFailoverApiProtocol,
  reusePrimaryBaseUrl: true,
  reusePrimaryApiKey: true,
});

/** Fully-qualified fallback ref written into OpenClaw model fallback chains. */
export const JUNFEIAI_OPENCLAW_TEXT_FAILOVER_MODEL_REF =
  `${JUNFEIAI_OPENCLAW_TEXT_FAILOVER.fallbackProvider}/${JUNFEIAI_OPENCLAW_TEXT_FAILOVER.fallbackModel}`;

if (typeof endpoints.openClawCompaction.midTurnPrecheck.enabled !== 'boolean') {
  throw new Error('openClawCompaction.midTurnPrecheck.enabled in shared/junfeiai-endpoints.json must be boolean');
}
if (typeof endpoints.openClawCompaction.truncateAfterCompaction !== 'boolean') {
  throw new Error('openClawCompaction.truncateAfterCompaction in shared/junfeiai-endpoints.json must be boolean');
}
const transcriptLimit = endpoints.openClawCompaction.maxActiveTranscriptBytes;
if (
  !(typeof transcriptLimit === 'number' && Number.isInteger(transcriptLimit) && transcriptLimit > 0)
  && !(typeof transcriptLimit === 'string' && /^\d+(?:\.\d+)?(?:b|kb|mb|gb)$/iu.test(transcriptLimit.trim()))
) {
  throw new Error('openClawCompaction.maxActiveTranscriptBytes in shared/junfeiai-endpoints.json must be a positive byte size');
}

/** Run context-pressure recovery between tool results and the next model call. */
export const JUNFEIAI_OPENCLAW_MID_TURN_PRECHECK_ENABLED = endpoints.openClawCompaction.midTurnPrecheck.enabled;

/** Rotate the active transcript after successful semantic compaction. */
export const JUNFEIAI_OPENCLAW_TRUNCATE_AFTER_COMPACTION = endpoints.openClawCompaction.truncateAfterCompaction;

/** Preflight transcript-size threshold that triggers local compaction. */
export const JUNFEIAI_OPENCLAW_MAX_ACTIVE_TRANSCRIPT_BYTES = transcriptLimit as JunFeiAIOpenClawTranscriptLimit;

function readProviderModelRef(value: unknown, key: string): { ref: string; provider: string; model: string } {
  const ref = readNonEmptyString(value, key);
  const separator = ref.indexOf('/');
  if (separator <= 0 || separator >= ref.length - 1) {
    throw new Error(`${key} in shared/junfeiai-endpoints.json must use provider/model format`);
  }
  return {
    ref,
    provider: ref.slice(0, separator).trim().toLowerCase(),
    model: ref.slice(separator + 1).trim(),
  };
}

const imageGenerationDefaultModel = readProviderModelRef(
  endpoints.imageGenerationDefaults.modelRef,
  'imageGenerationDefaults.modelRef',
);
if (imageGenerationDefaultModel.provider !== 'openai') {
  throw new Error('imageGenerationDefaults.modelRef must use the openai provider');
}

/** Canonical OpenAI image model ref exposed to the managed OpenClaw runtime. */
export const JUNFEIAI_IMAGE_GENERATION_DEFAULT_MODEL_REF = imageGenerationDefaultModel.ref;

/** Model id derived from the canonical managed OpenAI image model ref. */
export const JUNFEIAI_IMAGE_GENERATION_DEFAULT_MODEL = imageGenerationDefaultModel.model;

function readVideoGenerationSize(
  value: unknown,
  key: string,
  orientation: 'landscape' | 'portrait' | 'square',
  shortEdge: number,
): string {
  if (typeof value !== 'string') {
    throw new Error(`${key} in shared/junfeiai-endpoints.json must be a WxH string`);
  }
  const normalized = value.trim().toLowerCase();
  const match = normalized.match(/^(\d+)x(\d+)$/u);
  if (!match) {
    throw new Error(`${key} in shared/junfeiai-endpoints.json must be a WxH string`);
  }
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  const orientationMatches = orientation === 'landscape'
    ? width > height
    : orientation === 'portrait'
      ? height > width
      : width === height;
  if (!orientationMatches || Math.min(width, height) !== shortEdge) {
    throw new Error(`${key} must match the configured resolution and ${orientation} orientation`);
  }
  return `${width}x${height}`;
}

const videoGenerationDefaults = endpoints.videoGenerationDefaults;
if (!VALID_VIDEO_GENERATION_RESOLUTIONS.has(videoGenerationDefaults.resolution)) {
  throw new Error('videoGenerationDefaults.resolution must be 480p or 720p');
}
const videoGenerationResolution = videoGenerationDefaults.resolution as JunFeiAIVideoGenerationResolution;
const videoGenerationShortEdge = Number.parseInt(videoGenerationResolution, 10);
const videoGenerationDefaultSizes = Object.freeze({
  landscape: readVideoGenerationSize(
    videoGenerationDefaults.sizes.landscape,
    'videoGenerationDefaults.sizes.landscape',
    'landscape',
    videoGenerationShortEdge,
  ),
  portrait: readVideoGenerationSize(
    videoGenerationDefaults.sizes.portrait,
    'videoGenerationDefaults.sizes.portrait',
    'portrait',
    videoGenerationShortEdge,
  ),
  square: readVideoGenerationSize(
    videoGenerationDefaults.sizes.square,
    'videoGenerationDefaults.sizes.square',
    'square',
    videoGenerationShortEdge,
  ),
});

/** Canonical default resolution for managed video generation. */
export const JUNFEIAI_VIDEO_GENERATION_DEFAULT_RESOLUTION = videoGenerationResolution;

/** Canonical managed video sizes ordered as landscape, portrait, then square. */
export const JUNFEIAI_VIDEO_GENERATION_DEFAULT_SIZES = Object.freeze([
  videoGenerationDefaultSizes.landscape,
  videoGenerationDefaultSizes.portrait,
  videoGenerationDefaultSizes.square,
]);

/** Canonical default video size used when no aspect ratio is specified. */
export const JUNFEIAI_VIDEO_GENERATION_DEFAULT_SIZE = videoGenerationDefaultSizes.landscape;

function readPositiveTimeoutMs(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} in shared/junfeiai-endpoints.json must be a positive integer`);
  }
  return value;
}

/** Canonical timeout for managed image generation requests. */
export const JUNFEIAI_IMAGE_GENERATION_TIMEOUT_MS = readPositiveTimeoutMs(
  endpoints.imageGenerationTimeoutMs,
  'imageGenerationTimeoutMs',
);

/** Canonical timeout for managed video generation requests. */
export const JUNFEIAI_VIDEO_GENERATION_TIMEOUT_MS = readPositiveTimeoutMs(
  endpoints.videoGenerationTimeoutMs,
  'videoGenerationTimeoutMs',
);

/** Canonical interval for managed video-generation status checks. */
export const JUNFEIAI_VIDEO_GENERATION_POLL_INTERVAL_MS = readPositiveTimeoutMs(
  endpoints.videoGenerationPollIntervalMs,
  'videoGenerationPollIntervalMs',
);

/** Bounded timeout for the explicit settings-page media connectivity test. */
export const JUNFEIAI_MEDIA_GENERATION_TEST_TIMEOUT_MS = readPositiveTimeoutMs(
  endpoints.mediaGenerationTestTimeoutMs,
  'mediaGenerationTestTimeoutMs',
);

/** Extra time for the renderer to receive a completed media-test response. */
export const JUNFEIAI_MEDIA_GENERATION_CLIENT_TIMEOUT_BUFFER_MS = readPositiveTimeoutMs(
  endpoints.mediaGenerationClientTimeoutBufferMs,
  'mediaGenerationClientTimeoutBufferMs',
);
