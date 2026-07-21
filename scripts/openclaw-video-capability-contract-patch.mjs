import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOOL_PATCH_MARKER = 'UCLAW_VIDEO_CAPABILITY_CONTRACT_TOOL_V1';
const RUNTIME_PATCH_MARKER = 'UCLAW_VIDEO_CAPABILITY_CONTRACT_RUNTIME_V1';
const OPENAI_PATCH_MARKER = 'UCLAW_VIDEO_CAPABILITY_CONTRACT_OPENAI_V1';
const OPENAI_DURATION_PATCH_MARKER = 'UCLAW_VIDEO_DURATION_CONTRACT_OPENAI_V2';

const GROK_VIDEO_MODELS = new Set(['grok-image-video', 'grok-video-1.5']);
const GROK_VIDEO_DURATIONS = [6, 10, 15];
const GROK_VIDEO_SIZES = ['1280x720', '720x1280', '1024x1024'];

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function replaceUnique(content, search, replacement, label, filePath) {
  const count = countOccurrences(content, search);
  if (count !== 1) {
    throw new Error(
      `[openclaw-video-capability-contract-patch] Expected exactly one ${label} anchor in ${filePath}; found ${count}.`,
    );
  }
  return content.replace(search, replacement);
}

function parseSize(size) {
  const match = typeof size === 'string' ? size.trim().match(/^(\d+)x(\d+)$/u) : null;
  if (!match) return undefined;
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!(width > 0 && height > 0)) return undefined;
  return { width, height, aspectRatio: width / height, area: width * height };
}

function parseAspectRatio(aspectRatio) {
  const match = typeof aspectRatio === 'string'
    ? aspectRatio.trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/u)
    : null;
  if (!match) return undefined;
  const width = Number.parseFloat(match[1]);
  const height = Number.parseFloat(match[2]);
  if (!(width > 0 && height > 0)) return undefined;
  return width / height;
}

function parseResolutionShortEdge(resolution) {
  if (typeof resolution !== 'string') return undefined;
  const normalized = resolution.trim().toUpperCase();
  if (normalized === '4K') return 2160;
  const match = normalized.match(/^(\d+)P$/u);
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 10);
  return value > 0 ? value : undefined;
}

export function resolveMappedVideoSizeForCapabilityContract(params) {
  const requestedAspectRatio = parseAspectRatio(params.aspectRatio);
  const requestedShortEdge = parseResolutionShortEdge(params.resolution);
  if (!requestedAspectRatio || !requestedShortEdge) return undefined;
  const requestedWidth = requestedAspectRatio >= 1
    ? Math.round(requestedShortEdge * requestedAspectRatio)
    : requestedShortEdge;
  const requestedHeight = requestedAspectRatio >= 1
    ? requestedShortEdge
    : Math.round(requestedShortEdge / requestedAspectRatio);
  const requestedArea = requestedWidth * requestedHeight;
  let selected;
  let selectedScore;
  for (const candidate of params.supportedSizes ?? []) {
    const parsed = parseSize(candidate);
    if (!parsed) continue;
    const score = [
      Math.abs(Math.log(parsed.aspectRatio / requestedAspectRatio)),
      Math.abs(Math.log(parsed.area / requestedArea)),
      candidate,
    ];
    if (
      !selectedScore
      || score[0] < selectedScore[0]
      || (score[0] === selectedScore[0] && score[1] < selectedScore[1])
      || (score[0] === selectedScore[0] && score[1] === selectedScore[1] && score[2] < selectedScore[2])
    ) {
      selected = candidate;
      selectedScore = score;
    }
  }
  return selected;
}

export function resolveOpenAiVideoCapabilityContractProfile(model, mode = 'generate') {
  if (!GROK_VIDEO_MODELS.has(model)) return undefined;
  const imageToVideo = mode === 'imageToVideo';
  const textToVideo = mode === 'generate';
  const videoToVideo = mode === 'videoToVideo';
  if (model === 'grok-video-1.5' && !imageToVideo) {
    return { enabled: false };
  }
  if (videoToVideo) {
    return model === 'grok-image-video'
      ? { enabled: true, maxVideos: 1, maxInputVideos: 1 }
      : { enabled: false };
  }
  if (!textToVideo && !imageToVideo) return undefined;
  return {
    ...(imageToVideo ? { enabled: true, maxInputImages: 1 } : {}),
    maxVideos: 1,
    maxDurationSeconds: 15,
    supportedDurationSeconds: [...GROK_VIDEO_DURATIONS],
    supportsSize: true,
    sizes: [...GROK_VIDEO_SIZES],
  };
}

const TOOL_SCHEMA_ANCHOR = `function createVideoGenerateToolSchema(params) {
\tconst properties = { ...VideoGenerateToolProperties };
\tif (!params.includeAudioReferences) {
\t\tdelete properties.audioRef;
\t\tdelete properties.audioRefs;
\t\tdelete properties.audioRoles;
\t}
\treturn Type.Object(properties);
}`;

const TOOL_SCHEMA_PATCH = `const ${TOOL_PATCH_MARKER} = true;
function formatActiveVideoGenerationCapabilityProfile(profile) {
\tif (!profile) return "Active provider/model capability profile is unavailable; execution-time capability validation remains authoritative.";
\tconst caps = profile.capabilities;
\treturn [
\t\t\`Active primary profile: \${profile.provider}/\${profile.model}.\`,
\t\t\`Modes: \${profile.modes.length > 0 ? profile.modes.join("/") : "none"}.\`,
\t\tcaps?.sizes?.length ? \`Supported sizes: \${caps.sizes.join(", ")}.\` : caps?.supportsSize ? "The primary model accepts provider-defined sizes." : "The primary model does not accept size directly.",
\t\tcaps?.supportedDurationSeconds?.length ? \`Supported durations: \${caps.supportedDurationSeconds.join("/")} seconds.\` : "Duration support is provider-defined.",
\t\tcaps?.supportsAspectRatio ? "aspectRatio is accepted directly." : caps?.supportsSize ? "aspectRatio is translated to a supported size when possible." : "aspectRatio is removed before provider invocation.",
\t\tcaps?.supportsResolution ? "resolution is accepted directly." : caps?.supportsSize ? "resolution plus aspectRatio is translated to a supported size when possible." : "resolution is removed before provider invocation.",
\t\tcaps?.supportsAudio ? "audio is controllable." : "audio is not controllable and is removed before provider invocation.",
\t\tcaps?.supportsWatermark ? "watermark is controllable." : "watermark is not controllable and is removed before provider invocation.",
\t\t"Mappable geometry fields remain available for model overrides and fallbacks. Change the configured primary model to rebuild controls that the active primary cannot express; execution-time validation remains authoritative."
\t].join(" ");
}
function resolveActiveVideoGenerationCapabilityProfile(params) {
\ttry {
\t\tconst modelConfig = resolveVideoGenerationModelConfigForTool(params);
\t\tif (!modelConfig) return;
\t\tconst provider = resolveSelectedVideoGenerationProvider({
\t\t\tconfig: params.cfg,
\t\t\tvideoGenerationModelConfig: modelConfig
\t\t});
\t\tif (!provider) return;
\t\tconst primaryRef = parseVideoGenerationModelRef(modelConfig.primary);
\t\tconst model = primaryRef?.provider === provider.id ? primaryRef.model : provider.defaultModel;
\t\tif (!model) return;
\t\tconst generateCaps = resolveVideoGenerationModeCapabilities({
\t\t\tprovider,
\t\t\tmodel,
\t\t\tinputImageCount: 0,
\t\t\tinputVideoCount: 0
\t\t}).capabilities;
\t\tconst imageToVideoCaps = resolveVideoGenerationModeCapabilities({
\t\t\tprovider,
\t\t\tmodel,
\t\t\tinputImageCount: 1,
\t\t\tinputVideoCount: 0
\t\t}).capabilities;
\t\tconst videoToVideoCaps = resolveVideoGenerationModeCapabilities({
\t\t\tprovider,
\t\t\tmodel,
\t\t\tinputImageCount: 0,
\t\t\tinputVideoCount: 1
\t\t}).capabilities;
\t\tconst generateEnabled = Boolean(generateCaps && (!("enabled" in generateCaps) || generateCaps.enabled !== false));
\t\tconst imageToVideoEnabled = Boolean(imageToVideoCaps && (!("enabled" in imageToVideoCaps) || imageToVideoCaps.enabled !== false));
\t\tconst videoToVideoEnabled = Boolean(videoToVideoCaps && (!("enabled" in videoToVideoCaps) || videoToVideoCaps.enabled !== false));
\t\treturn {
\t\t\tprovider: provider.id,
\t\t\tmodel,
\t\t\tmodes: [
\t\t\t\t...generateEnabled ? ["text-to-video"] : [],
\t\t\t\t...imageToVideoEnabled ? ["image-to-video"] : [],
\t\t\t\t...videoToVideoEnabled ? ["video-to-video"] : []
\t\t\t],
\t\t\tcapabilities: generateEnabled ? generateCaps : imageToVideoEnabled ? imageToVideoCaps : videoToVideoCaps
\t\t};
\t} catch {
\t\treturn;
\t}
}
function createVideoGenerateToolSchema(params) {
\tconst properties = { ...VideoGenerateToolProperties };
\tconst activeProfile = params.activeProfile;
\tif (activeProfile) {
\t\tconst caps = activeProfile.capabilities;
\t\tconst label = \`Active primary \${activeProfile.provider}/\${activeProfile.model}\`;
\t\tproperties.model = Type.Optional(Type.String({ description: \`Provider/model override. \${label} is selected by default; overrides and fallbacks are validated against their own capability profiles.\` }));
\t\tproperties.size = Type.Optional(Type.String({ description: caps?.sizes?.length ? \`Size. \${label} supports: \${caps.sizes.join(", ")}.\` : \`Size hint. \${label} does not publish a fixed size list.\` }));
\t\tproperties.aspectRatio = Type.Optional(Type.String({ description: caps?.supportsAspectRatio ? \`Aspect ratio accepted directly by \${label}.\` : caps?.supportsSize ? \`Aspect ratio is translated deterministically to a supported size for \${label}; combine with resolution when resolution tier matters.\` : \`Aspect ratio is unsupported by \${label} and is removed before provider invocation.\` }));
\t\tproperties.resolution = Type.Optional(Type.String({ description: caps?.supportsResolution ? \`Resolution accepted directly by \${label}.\` : caps?.supportsSize ? \`Resolution is not sent directly to \${label}; combine it with aspectRatio to select the closest supported size deterministically.\` : \`Resolution is unsupported by \${label} and is removed before provider invocation.\` }));
\t\tproperties.durationSeconds = Type.Optional(Type.Integer({
\t\t\tdescription: caps?.supportedDurationSeconds?.length ? \`Target seconds. \${label} supports: \${caps.supportedDurationSeconds.join(", ")}; other values round to the nearest supported duration.\` : "Target seconds; may round to nearest supported duration.",
\t\t\tminimum: 1
\t\t}));
\t\tif (caps?.supportsAudio) properties.audio = Type.Optional(Type.Boolean({ description: \`Generated-audio toggle supported by \${label}.\` }));
\t\telse delete properties.audio;
\t\tif (caps?.supportsWatermark) properties.watermark = Type.Optional(Type.Boolean({ description: \`Watermark toggle supported by \${label}.\` }));
\t\telse delete properties.watermark;
\t}
\tif (!params.includeAudioReferences) {
\t\tdelete properties.audioRef;
\t\tdelete properties.audioRefs;
\t\tdelete properties.audioRoles;
\t}
\treturn Type.Object(properties);
}`;

const TOOL_LIST_ANCHOR = `function createVideoGenerateListActionResult(config, options) {
\treturn createMediaGenerateProviderListActionResult({
\t\tkind: "video_generation",
\t\tproviders: listRuntimeVideoGenerationProviders({ config }),
\t\temptyText: "No video-generation providers are registered.",
\t\tcfg: config,
\t\tworkspaceDir: options?.workspaceDir,
\t\tagentDir: options?.agentDir,
\t\tauthStore: options?.authStore,
\t\tlistModes: listSupportedVideoGenerationModes,
\t\tsummarizeCapabilities: summarizeVideoGenerationCapabilities
\t});
}`;

const TOOL_LIST_PATCH = `function createVideoGenerateListActionResult(config, options) {
\tconst result = createMediaGenerateProviderListActionResult({
\t\tkind: "video_generation",
\t\tproviders: listRuntimeVideoGenerationProviders({ config }),
\t\temptyText: "No video-generation providers are registered.",
\t\tcfg: config,
\t\tworkspaceDir: options?.workspaceDir,
\t\tagentDir: options?.agentDir,
\t\tauthStore: options?.authStore,
\t\tlistModes: listSupportedVideoGenerationModes,
\t\tsummarizeCapabilities: summarizeVideoGenerationCapabilities
\t});
\tconst activeProfile = resolveActiveVideoGenerationCapabilityProfile({
\t\tcfg: config,
\t\tworkspaceDir: options?.workspaceDir,
\t\tagentDir: options?.agentDir,
\t\tauthStore: options?.authStore
\t});
\tif (!activeProfile) return result;
\treturn {
\t\t...result,
\t\tcontent: result.content.map((entry) => entry.type === "text" ? {
\t\t\t...entry,
\t\t\ttext: \`${'${entry.text}'}\\nactive: ${'${formatActiveVideoGenerationCapabilityProfile(activeProfile)}'}\`
\t\t} : entry),
\t\tdetails: {
\t\t\t...result.details,
\t\t\tactiveProfile
\t\t}
\t};
}`;

const TOOL_CREATE_ANCHOR = `\tconst scheduleBackgroundWork = options?.scheduleBackgroundWork ?? defaultScheduleVideoGenerateBackgroundWork;
\treturn {`;

const TOOL_CREATE_PATCH = `\tconst scheduleBackgroundWork = options?.scheduleBackgroundWork ?? defaultScheduleVideoGenerateBackgroundWork;
\tconst activeCapabilityProfile = resolveActiveVideoGenerationCapabilityProfile({
\t\tcfg,
\t\tworkspaceDir: options?.workspaceDir,
\t\tagentDir: options?.agentDir,
\t\tauthStore: options?.authProfileStore
\t});
\treturn {`;

const TOOL_DESCRIPTION_ANCHOR = `\t\tdescription: "Create videos. Session chats use background tasks. Do not resubmit the same logical segment while it is queued or running; use status instead. Long-form work may call video_generate multiple times with one shared parentTaskId and a unique segmentId per shot, verify every segment, then compose the final video. If requested duration exceeds provider limits, plan enough distinct segments instead of replacing generated motion with a still-image timeline. Duration may round to a provider-supported value.",`;

const TOOL_DESCRIPTION_PATCH = `\t\tdescription: \`Create videos. Session chats use background tasks. Do not resubmit the same logical segment while it is queued or running; use status instead. Long-form work may call video_generate multiple times with one shared parentTaskId and a unique segmentId per shot, verify every segment, then compose the final video. If requested duration exceeds provider limits, plan enough distinct segments instead of replacing generated motion with a still-image timeline. \${formatActiveVideoGenerationCapabilityProfile(activeCapabilityProfile)}\`,`;

const TOOL_PARAMETERS_ANCHOR = `\t\tparameters: createVideoGenerateToolSchema({ includeAudioReferences: shouldExposeVideoReferenceAudioParams({`;
const TOOL_PARAMETERS_PATCH = `\t\tparameters: createVideoGenerateToolSchema({
\t\t\tactiveProfile: activeCapabilityProfile,
\t\t\tincludeAudioReferences: shouldExposeVideoReferenceAudioParams({`;

const TOOL_VALIDATION_ANCHOR = `\tif (!caps) return;
\tif (mode === "imageToVideo" && "enabled" in caps && !caps.enabled && params.inputVideoCount === 0) throw new ToolInputError(\`${'${provider.id}'} does not support image-to-video reference inputs.\`);`;

const TOOL_VALIDATION_PATCH = `\tif (!caps) return;
\tif (mode === "generate" && "enabled" in caps && !caps.enabled) throw new ToolInputError(\`${'${provider.id}/${params.model ?? provider.defaultModel}'} does not support text-to-video; provide the required reference input or select another model.\`);
\tif (mode === "imageToVideo" && "enabled" in caps && !caps.enabled && params.inputVideoCount === 0) throw new ToolInputError(\`${'${provider.id}'} does not support image-to-video reference inputs.\`);`;

export function patchOpenClawVideoCapabilityToolContent(content, filePath = '<memory>') {
  if (!content.includes('function createVideoGenerateTool(options)')) return null;
  if (content.includes(TOOL_PATCH_MARKER)) return { content, changed: false, category: 'tool' };
  let patched = replaceUnique(content, TOOL_SCHEMA_ANCHOR, TOOL_SCHEMA_PATCH, 'video tool schema', filePath);
  patched = replaceUnique(patched, TOOL_LIST_ANCHOR, TOOL_LIST_PATCH, 'video provider list active profile', filePath);
  patched = replaceUnique(patched, TOOL_CREATE_ANCHOR, TOOL_CREATE_PATCH, 'video tool creation', filePath);
  patched = replaceUnique(patched, TOOL_DESCRIPTION_ANCHOR, TOOL_DESCRIPTION_PATCH, 'video tool description', filePath);
  patched = replaceUnique(patched, TOOL_PARAMETERS_ANCHOR, TOOL_PARAMETERS_PATCH, 'video tool parameters', filePath);
  patched = replaceUnique(patched, TOOL_VALIDATION_ANCHOR, TOOL_VALIDATION_PATCH, 'video mode validation', filePath);
  return { content: patched, changed: true, category: 'tool' };
}

const RUNTIME_MODEL_OVERLAY_ANCHOR = `\tconst withModelLimits = (caps) => {
\t\tconst model = params.model?.trim();
\t\tif (!caps || !model) return caps;
\t\tconst maxInputImages = caps.maxInputImagesByModel?.[model];
\t\tconst maxInputVideos = caps.maxInputVideosByModel?.[model];
\t\tconst maxInputAudios = caps.maxInputAudiosByModel?.[model];
\t\tif (typeof maxInputImages !== "number" && typeof maxInputVideos !== "number" && typeof maxInputAudios !== "number") return caps;
\t\treturn {
\t\t\t...caps,
\t\t\t...typeof maxInputImages === "number" ? { maxInputImages } : {},
\t\t\t...typeof maxInputVideos === "number" ? { maxInputVideos } : {},
\t\t\t...typeof maxInputAudios === "number" ? { maxInputAudios } : {}
\t\t};
\t};`;

const RUNTIME_MODEL_OVERLAY_PATCH = `\tconst withModelLimits = (caps) => {
\t\tconst model = params.model?.trim();
\t\tif (!caps || !model) return caps;
\t\tconst modelCapabilities = caps.modelCapabilities?.[model];
\t\tconst effectiveCaps = modelCapabilities ? { ...caps, ...modelCapabilities } : caps;
\t\tconst maxInputImages = effectiveCaps.maxInputImagesByModel?.[model];
\t\tconst maxInputVideos = effectiveCaps.maxInputVideosByModel?.[model];
\t\tconst maxInputAudios = effectiveCaps.maxInputAudiosByModel?.[model];
\t\tif (typeof maxInputImages !== "number" && typeof maxInputVideos !== "number" && typeof maxInputAudios !== "number") return effectiveCaps;
\t\treturn {
\t\t\t...effectiveCaps,
\t\t\t...typeof maxInputImages === "number" ? { maxInputImages } : {},
\t\t\t...typeof maxInputVideos === "number" ? { maxInputVideos } : {},
\t\t\t...typeof maxInputAudios === "number" ? { maxInputAudios } : {}
\t\t};
\t};`;

const RUNTIME_RESOLUTION_ORDER_ANCHOR = `const VIDEO_RESOLUTION_ORDER = [
\t"360P",
\t"480P",
\t"540P",
\t"720P",
\t"768P",
\t"1080P"
];`;

const RUNTIME_RESOLUTION_ORDER_PATCH = `const VIDEO_RESOLUTION_ORDER = [
\t"360P",
\t"480P",
\t"540P",
\t"720P",
\t"768P",
\t"1080P"
];
const ${RUNTIME_PATCH_MARKER} = true;
function resolveVideoGenerationSizeFromResolutionAndAspectRatio(params) {
\tconst normalizedResolution = params.resolution?.trim().toUpperCase();
\tconst resolutionMatch = normalizedResolution?.match(/^(\\d+)P$/u);
\tconst shortEdge = normalizedResolution === "4K" ? 2160 : resolutionMatch ? Number.parseInt(resolutionMatch[1], 10) : void 0;
\tconst aspectRatioMatch = params.aspectRatio?.trim().match(/^(\\d+(?:\\.\\d+)?):(\\d+(?:\\.\\d+)?)$/u);
\tif (!(shortEdge > 0) || !aspectRatioMatch) return;
\tconst aspectRatio = Number.parseFloat(aspectRatioMatch[1]) / Number.parseFloat(aspectRatioMatch[2]);
\tif (!(aspectRatio > 0)) return;
\tconst requestedSize = aspectRatio >= 1 ? \`${'${Math.round(shortEdge * aspectRatio)}x${shortEdge}'}\` : \`${'${shortEdge}x${Math.round(shortEdge / aspectRatio)}'}\`;
\treturn resolveClosestSize({
\t\trequestedSize,
\t\trequestedAspectRatio: params.aspectRatio,
\t\tsupportedSizes: params.supportedSizes
\t});
}`;

const RUNTIME_TRANSLATION_ANCHOR = `\tif (caps) {
\t\tif (size && (caps.sizes?.length ?? 0) > 0 && caps.supportsSize) {`;

const RUNTIME_TRANSLATION_PATCH = `\tif (caps) {
\t\tif (!size && resolution && aspectRatio && caps.supportsSize && !caps.supportsResolution) {
\t\t\tconst derivedSize = resolveVideoGenerationSizeFromResolutionAndAspectRatio({
\t\t\t\tresolution,
\t\t\t\taspectRatio,
\t\t\t\tsupportedSizes: caps.sizes
\t\t\t});
\t\t\tif (derivedSize) {
\t\t\t\tsize = derivedSize;
\t\t\t\tnormalization.size = {
\t\t\t\t\trequested: \`${'${resolution} ${aspectRatio}'}\`,
\t\t\t\t\tapplied: derivedSize,
\t\t\t\t\tderivedFrom: "resolution+aspectRatio"
\t\t\t\t};
\t\t\t\tnormalization.aspectRatio = {
\t\t\t\t\trequested: aspectRatio,
\t\t\t\t\tapplied: derivedSize,
\t\t\t\t\tderivedFrom: "size"
\t\t\t\t};
\t\t\t\tnormalization.resolution = {
\t\t\t\t\trequested: resolution,
\t\t\t\t\tapplied: derivedSize,
\t\t\t\t\tderivedFrom: "size"
\t\t\t\t};
\t\t\t\taspectRatio = void 0;
\t\t\t\tresolution = void 0;
\t\t\t}
\t\t}
\t\tif (size && (caps.sizes?.length ?? 0) > 0 && caps.supportsSize) {`;

export function patchOpenClawVideoCapabilityRuntimeContent(content, filePath = '<memory>') {
  if (!content.includes('function resolveVideoGenerationOverrides(params)')) return null;
  if (content.includes(RUNTIME_PATCH_MARKER)) return { content, changed: false, category: 'runtime' };
  let patched = replaceUnique(content, RUNTIME_MODEL_OVERLAY_ANCHOR, RUNTIME_MODEL_OVERLAY_PATCH, 'model capability overlay', filePath);
  patched = replaceUnique(patched, RUNTIME_RESOLUTION_ORDER_ANCHOR, RUNTIME_RESOLUTION_ORDER_PATCH, 'video resolution order', filePath);
  patched = replaceUnique(patched, RUNTIME_TRANSLATION_ANCHOR, RUNTIME_TRANSLATION_PATCH, 'resolution/aspect-ratio translation', filePath);
  return { content: patched, changed: true, category: 'runtime' };
}

const OPENAI_CONSTANTS_ANCHOR = `const OPENAI_VIDEO_SIZES = [
\t"720x1280",
\t"1280x720",
\t"1024x1792",
\t"1792x1024"
];`;

const OPENAI_CONSTANTS_PATCH = `const OPENAI_VIDEO_SIZES = [
\t"720x1280",
\t"1280x720",
\t"1024x1792",
\t"1792x1024"
];
const ${OPENAI_PATCH_MARKER} = true;
const UCLAW_OPENAI_GROK_VIDEO_MODEL = "grok-image-video";
const UCLAW_OPENAI_GROK_VIDEO_15_MODEL = "grok-video-1.5";
const ${OPENAI_DURATION_PATCH_MARKER} = true;
const UCLAW_OPENAI_GROK_VIDEO_SECONDS = [
\t6,
\t10,
\t15
];
const UCLAW_OPENAI_GROK_VIDEO_SIZES = [
\t"1280x720",
\t"720x1280",
\t"1024x1024"
];
function isUClawOpenAIGrokVideoModel(model) {
\treturn model === UCLAW_OPENAI_GROK_VIDEO_MODEL || model === UCLAW_OPENAI_GROK_VIDEO_15_MODEL;
}`;

const OPENAI_LEGACY_GROK_DURATION_PATCH = `const UCLAW_OPENAI_GROK_VIDEO_SECONDS = [
\t4,
\t6,
\t8,
\t10,
\t12,
\t15
];`;

const OPENAI_CURRENT_GROK_DURATION_PATCH = `const ${OPENAI_DURATION_PATCH_MARKER} = true;
const UCLAW_OPENAI_GROK_VIDEO_SECONDS = [
\t6,
\t10,
\t15
];`;

const OPENAI_DURATION_ANCHOR = `function resolveDurationSeconds(durationSeconds) {
\tif (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) return;
\tconst rounded = Math.max(OPENAI_VIDEO_SECONDS[0], Math.round(durationSeconds));
\tconst nearest = OPENAI_VIDEO_SECONDS.reduce((best, current) => Math.abs(current - rounded) < Math.abs(best - rounded) ? current : best);
\treturn String(nearest);
}`;

const OPENAI_DURATION_PATCH = `function resolveDurationSeconds(durationSeconds, model) {
\tif (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) return;
\tconst supportedSeconds = isUClawOpenAIGrokVideoModel(model) ? UCLAW_OPENAI_GROK_VIDEO_SECONDS : OPENAI_VIDEO_SECONDS;
\tconst rounded = Math.max(supportedSeconds[0], Math.round(durationSeconds));
\tconst nearest = supportedSeconds.reduce((best, current) => Math.abs(current - rounded) < Math.abs(best - rounded) ? current : best);
\treturn String(nearest);
}`;

const OPENAI_SIZE_ANCHOR = `function resolveSize(params) {
\tconst explicitSize = normalizeOptionalString(params.size);
\tif (explicitSize && OPENAI_VIDEO_SIZES.includes(explicitSize)) return explicitSize;
\tswitch (normalizeOptionalString(params.aspectRatio)) {
\t\tcase "9:16": return "720x1280";
\t\tcase "16:9": return "1280x720";
\t\tcase "4:7": return "1024x1792";
\t\tcase "7:4": return "1792x1024";
\t\tdefault: break;
\t}
\tif (params.resolution === "1080P") return "1792x1024";
}`;

const OPENAI_SIZE_PATCH = `function resolveSize(params) {
\tconst supportedSizes = isUClawOpenAIGrokVideoModel(params.model) ? UCLAW_OPENAI_GROK_VIDEO_SIZES : OPENAI_VIDEO_SIZES;
\tconst explicitSize = normalizeOptionalString(params.size);
\tif (explicitSize && supportedSizes.includes(explicitSize)) return explicitSize;
\tconst preferredSize = (() => {
\t\tswitch (normalizeOptionalString(params.aspectRatio)) {
\t\t\tcase "9:16": return "720x1280";
\t\t\tcase "16:9": return "1280x720";
\t\t\tcase "1:1": return "1024x1024";
\t\t\tcase "4:7": return "1024x1792";
\t\t\tcase "7:4": return "1792x1024";
\t\t\tdefault: return;
\t\t}
\t})();
\tif (preferredSize && supportedSizes.includes(preferredSize)) return preferredSize;
\tif (!isUClawOpenAIGrokVideoModel(params.model) && params.resolution === "1080P") return "1792x1024";
}`;

const OPENAI_GENERATE_CAPS_ANCHOR = `\t\t\tgenerate: {
\t\t\t\tmaxVideos: 1,
\t\t\t\tmaxDurationSeconds: 12,
\t\t\t\tsupportedDurationSeconds: OPENAI_VIDEO_SECONDS,
\t\t\t\tsupportsSize: true,
\t\t\t\tsizes: OPENAI_VIDEO_SIZES
\t\t\t},`;

const OPENAI_GENERATE_CAPS_PATCH = `\t\t\tgenerate: {
\t\t\t\tmaxVideos: 1,
\t\t\t\tmaxDurationSeconds: 12,
\t\t\t\tsupportedDurationSeconds: OPENAI_VIDEO_SECONDS,
\t\t\t\tsupportsSize: true,
\t\t\t\tsizes: OPENAI_VIDEO_SIZES,
\t\t\t\tmodelCapabilities: {
\t\t\t\t\t[UCLAW_OPENAI_GROK_VIDEO_MODEL]: {
\t\t\t\t\t\tmaxVideos: 1,
\t\t\t\t\t\tmaxDurationSeconds: 15,
\t\t\t\t\t\tsupportedDurationSeconds: UCLAW_OPENAI_GROK_VIDEO_SECONDS,
\t\t\t\t\t\tsupportsSize: true,
\t\t\t\t\t\tsizes: UCLAW_OPENAI_GROK_VIDEO_SIZES
\t\t\t\t\t},
\t\t\t\t\t[UCLAW_OPENAI_GROK_VIDEO_15_MODEL]: {
\t\t\t\t\t\tenabled: false,
\t\t\t\t\t\tmaxVideos: 1,
\t\t\t\t\t\tmaxDurationSeconds: 15,
\t\t\t\t\t\tsupportedDurationSeconds: UCLAW_OPENAI_GROK_VIDEO_SECONDS,
\t\t\t\t\t\tsupportsSize: true,
\t\t\t\t\t\tsizes: UCLAW_OPENAI_GROK_VIDEO_SIZES
\t\t\t\t\t}
\t\t\t\t}
\t\t\t},`;

const OPENAI_IMAGE_CAPS_ANCHOR = `\t\t\timageToVideo: {
\t\t\t\tenabled: true,
\t\t\t\tmaxVideos: 1,
\t\t\t\tmaxInputImages: 1,
\t\t\t\tmaxDurationSeconds: 12,
\t\t\t\tsupportedDurationSeconds: OPENAI_VIDEO_SECONDS,
\t\t\t\tsupportsSize: true,
\t\t\t\tsizes: OPENAI_VIDEO_SIZES
\t\t\t},`;

const OPENAI_IMAGE_CAPS_PATCH = `\t\t\timageToVideo: {
\t\t\t\tenabled: true,
\t\t\t\tmaxVideos: 1,
\t\t\t\tmaxInputImages: 1,
\t\t\t\tmaxDurationSeconds: 12,
\t\t\t\tsupportedDurationSeconds: OPENAI_VIDEO_SECONDS,
\t\t\t\tsupportsSize: true,
\t\t\t\tsizes: OPENAI_VIDEO_SIZES,
\t\t\t\tmodelCapabilities: {
\t\t\t\t\t[UCLAW_OPENAI_GROK_VIDEO_MODEL]: {
\t\t\t\t\t\tenabled: true,
\t\t\t\t\t\tmaxVideos: 1,
\t\t\t\t\t\tmaxInputImages: 1,
\t\t\t\t\t\tmaxDurationSeconds: 15,
\t\t\t\t\t\tsupportedDurationSeconds: UCLAW_OPENAI_GROK_VIDEO_SECONDS,
\t\t\t\t\t\tsupportsSize: true,
\t\t\t\t\t\tsizes: UCLAW_OPENAI_GROK_VIDEO_SIZES
\t\t\t\t\t},
\t\t\t\t\t[UCLAW_OPENAI_GROK_VIDEO_15_MODEL]: {
\t\t\t\t\t\tenabled: true,
\t\t\t\t\t\tmaxVideos: 1,
\t\t\t\t\t\tmaxInputImages: 1,
\t\t\t\t\t\tmaxDurationSeconds: 15,
\t\t\t\t\t\tsupportedDurationSeconds: UCLAW_OPENAI_GROK_VIDEO_SECONDS,
\t\t\t\t\t\tsupportsSize: true,
\t\t\t\t\t\tsizes: UCLAW_OPENAI_GROK_VIDEO_SIZES
\t\t\t\t\t}
\t\t\t\t}
\t\t\t},`;

const OPENAI_VIDEO_CAPS_ANCHOR = `\t\t\tvideoToVideo: {
\t\t\t\tenabled: true,
\t\t\t\tmaxVideos: 1,
\t\t\t\tmaxInputVideos: 1
\t\t\t}`;

const OPENAI_VIDEO_CAPS_PATCH = `\t\t\tvideoToVideo: {
\t\t\t\tenabled: true,
\t\t\t\tmaxVideos: 1,
\t\t\t\tmaxInputVideos: 1,
\t\t\t\tmodelCapabilities: {
\t\t\t\t\t[UCLAW_OPENAI_GROK_VIDEO_MODEL]: {
\t\t\t\t\t\tenabled: true,
\t\t\t\t\t\tmaxVideos: 1,
\t\t\t\t\t\tmaxInputVideos: 1
\t\t\t\t\t},
\t\t\t\t\t[UCLAW_OPENAI_GROK_VIDEO_15_MODEL]: { enabled: false }
\t\t\t\t}
\t\t\t}`;

const OPENAI_WIRE_ANCHOR = `\t\t\tconst model = normalizeOptionalString(req.model) ?? DEFAULT_OPENAI_VIDEO_MODEL;
\t\t\tconst seconds = resolveDurationSeconds(req.durationSeconds);
\t\t\tconst size = resolveSize({
\t\t\t\tsize: req.size,
\t\t\t\taspectRatio: req.aspectRatio,
\t\t\t\tresolution: req.resolution
\t\t\t});
\t\t\tconst referenceAsset = resolveReferenceAsset(req);`;

const OPENAI_WIRE_PATCH = `\t\t\tconst model = normalizeOptionalString(req.model) ?? DEFAULT_OPENAI_VIDEO_MODEL;
\t\t\tconst seconds = resolveDurationSeconds(req.durationSeconds, model);
\t\t\tconst size = resolveSize({
\t\t\t\tmodel,
\t\t\t\tsize: req.size,
\t\t\t\taspectRatio: req.aspectRatio,
\t\t\t\tresolution: req.resolution
\t\t\t});
\t\t\tconst referenceAsset = resolveReferenceAsset(req);
\t\t\tif (model === UCLAW_OPENAI_GROK_VIDEO_15_MODEL && referenceAsset?.kind !== "image") throw new Error("grok-video-1.5 requires exactly one reference image.");`;

export function patchOpenClawOpenAiVideoCapabilityContent(content, filePath = '<memory>') {
  if (!content.includes('function buildOpenAIVideoGenerationProvider()')) return null;
  if (content.includes(OPENAI_PATCH_MARKER)) {
    if (content.includes(OPENAI_DURATION_PATCH_MARKER)) {
      return { content, changed: false, category: 'openai-provider' };
    }
    return {
      content: replaceUnique(
        content,
        OPENAI_LEGACY_GROK_DURATION_PATCH,
        OPENAI_CURRENT_GROK_DURATION_PATCH,
        'legacy OpenAI Grok video durations',
        filePath,
      ),
      changed: true,
      category: 'openai-provider',
    };
  }
  let patched = replaceUnique(content, OPENAI_CONSTANTS_ANCHOR, OPENAI_CONSTANTS_PATCH, 'OpenAI video constants', filePath);
  patched = replaceUnique(patched, OPENAI_DURATION_ANCHOR, OPENAI_DURATION_PATCH, 'OpenAI video duration resolver', filePath);
  patched = replaceUnique(patched, OPENAI_SIZE_ANCHOR, OPENAI_SIZE_PATCH, 'OpenAI video size resolver', filePath);
  patched = replaceUnique(patched, OPENAI_GENERATE_CAPS_ANCHOR, OPENAI_GENERATE_CAPS_PATCH, 'OpenAI generate capabilities', filePath);
  patched = replaceUnique(patched, OPENAI_IMAGE_CAPS_ANCHOR, OPENAI_IMAGE_CAPS_PATCH, 'OpenAI image-to-video capabilities', filePath);
  patched = replaceUnique(patched, OPENAI_VIDEO_CAPS_ANCHOR, OPENAI_VIDEO_CAPS_PATCH, 'OpenAI video-to-video capabilities', filePath);
  patched = replaceUnique(patched, OPENAI_WIRE_ANCHOR, OPENAI_WIRE_PATCH, 'OpenAI video wire parameters', filePath);
  return { content: patched, changed: true, category: 'openai-provider' };
}

export function patchOpenClawVideoCapabilityContractRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-video-capability-contract-patch] OpenClaw dist directory not found: ${distDir}`);
  }
  const categoryCounts = new Map();
  let matchedFiles = 0;
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawVideoCapabilityToolContent(content, filePath)
      ?? patchOpenClawVideoCapabilityRuntimeContent(content, filePath)
      ?? patchOpenClawOpenAiVideoCapabilityContent(content, filePath);
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
  for (const category of ['tool', 'runtime', 'openai-provider']) {
    const count = categoryCounts.get(category) ?? 0;
    if (count !== 1) {
      throw new Error(
        `[openclaw-video-capability-contract-patch] Expected exactly one ${category} runtime file; found ${count}.`,
      );
    }
  }
  logger.log?.(
    `[openclaw-video-capability-contract-patch] ${dryRun ? 'Dry-run matched' : 'Patched'} ${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`,
  );
  return { matchedFiles, patchedFiles, alreadyPatchedFiles };
}

export function patchInstalledOpenClawVideoCapabilityContractRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawVideoCapabilityContractRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
