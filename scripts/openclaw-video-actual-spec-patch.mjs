import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_MARKER = 'UCLAW_VIDEO_ACTUAL_SPEC_V1';

const EXECUTE_ANCHOR = 'async function executeVideoGenerationJob(params) {';
const SAVE_ANCHOR = `\tconst mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "video");
\tconst savedVideos = [];
\tfor (const video of bufferVideos) try {
\t\tconst saved = await saveMediaBuffer(video.buffer, video.mimeType, "tool-video-generation", mediaMaxBytes, params.filename || video.fileName);
\t\tsavedVideos.push(saved);
\t} catch (error) {
\t\tif (video.url && isGeneratedMediaSizeLimitError(error)) {
\t\t\turlOnlyVideos.push({
\t\t\t\turl: video.url,
\t\t\t\tmimeType: video.mimeType,
\t\t\t\tfileName: video.fileName
\t\t\t});
\t\t\tcontinue;
\t\t}
\t\tthrow error;
\t}`;

const SPECIFICATION_ANCHOR = '\tconst allMediaUrls = [...savedVideos.map((video) => video.path), ...urlOnlyVideos.map((video) => video.url)];';
const LINES_ANCHOR = `\t\t...warning ? [\`Warning: \${warning}\`] : [],
\t\ttypeof requestedDurationSeconds === "number" && typeof normalizedDurationSeconds === "number" && requestedDurationSeconds !== normalizedDurationSeconds ? \`Duration normalized: requested \${requestedDurationSeconds}s; used \${normalizedDurationSeconds}s.\` : null,
\t\t...formatGeneratedAttachmentLines(attachments)`;
const DETAILS_ANCHOR = `\t\tdetails: {
\t\t\tprovider: result.provider,
\t\t\tmodel: result.model,
\t\t\tcount: totalCount,`;
const ASYNC_TERMINAL_ANCHOR = `\t\t\t\tpaths: executed.paths,
\t\t\t\tterminalResult
\t\t\t});`;
const SYNC_TERMINAL_ANCHOR = `\t\t\t\t\tcount: executed.count,
\t\t\t\t\tpaths: executed.savedPaths
\t\t\t\t});`;

function replacementCount(content, anchor) {
  return content.split(anchor).length - 1;
}

function replaceExactlyOnce(content, anchor, replacement, label) {
  const count = replacementCount(content, anchor);
  if (count !== 1) {
    throw new Error(`[openclaw-video-actual-spec-patch] Expected exactly one ${label} anchor; found ${count}.`);
  }
  return content.replace(anchor, replacement);
}

function buildImports(mediaServices) {
  return `import { execFile as execFileUClawVideoActualSpec } from "node:child_process";
import { ${mediaServices.runFfprobeExport} as runFfprobeUClawVideoActualSpec, ${mediaServices.probeVideoDimensionsExport} as probeVideoDimensionsUClawVideoActualSpec } from "./${mediaServices.fileName}"; // ${PATCH_MARKER}_IMPORT`;
}

const HELPERS = `function compactGeneratedVideoSpecificationUClaw(value) {
\treturn Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== void 0));
}
function parseGeneratedVideoProbeUClaw(stdout) {
\ttry {
\t\tconst parsed = JSON.parse(stdout);
\t\tconst streams = Array.isArray(parsed.streams) ? parsed.streams : [];
\t\tconst videoStream = streams.find((stream) => stream?.codec_type === "video");
\t\tconst width = Number.isInteger(videoStream?.width) && videoStream.width > 0 ? videoStream.width : void 0;
\t\tconst height = Number.isInteger(videoStream?.height) && videoStream.height > 0 ? videoStream.height : void 0;
\t\tconst parsedDuration = Number.parseFloat(parsed.format?.duration);
\t\treturn compactGeneratedVideoSpecificationUClaw({
\t\t\twidth,
\t\t\theight,
\t\t\tsize: width && height ? \`\${width}x\${height}\` : void 0,
\t\t\tdurationSeconds: Number.isFinite(parsedDuration) && parsedDuration >= 0 ? parsedDuration : void 0,
\t\t\thasAudio: streams.length > 0 ? streams.some((stream) => stream?.codec_type === "audio") : void 0
\t\t});
\t} catch {
\t\treturn;
\t}
}
function parseGeneratedVideoAvMediaInfoUClaw(stdout) {
\tif (typeof stdout !== "string" || !stdout.trim()) return;
\tconst dimensions = stdout.match(/^\\s*Dimensions:\\s*(\\d+)\\s*x\\s*(\\d+)\\s*$/mu);
\tconst duration = stdout.match(/^Duration:\\s*([0-9.]+)\\s+seconds(?:\\s|$)/mu);
\tconst width = dimensions ? Number.parseInt(dimensions[1], 10) : void 0;
\tconst height = dimensions ? Number.parseInt(dimensions[2], 10) : void 0;
\tconst durationSeconds = duration ? Number.parseFloat(duration[1]) : void 0;
\treturn compactGeneratedVideoSpecificationUClaw({
\t\twidth: Number.isInteger(width) && width > 0 ? width : void 0,
\t\theight: Number.isInteger(height) && height > 0 ? height : void 0,
\t\tsize: Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0 ? \`\${width}x\${height}\` : void 0,
\t\tdurationSeconds: Number.isFinite(durationSeconds) && durationSeconds >= 0 ? durationSeconds : void 0,
\t\thasAudio: /^Track \\d+: Sound\\b/mu.test(stdout)
\t});
}
async function probeGeneratedVideoBufferUClaw(buffer) {
\tlet ffprobeCompleted = false;
\ttry {
\t\tconst stdout = await runFfprobeUClawVideoActualSpec([
\t\t\t"-v",
\t\t\t"error",
\t\t\t"-show_entries",
\t\t\t"format=duration:stream=codec_type,width,height",
\t\t\t"-of",
\t\t\t"json",
\t\t\t"pipe:0"
\t\t], {
\t\t\tinput: buffer,
\t\t\ttimeoutMs: 5e3
\t\t});
\t\tffprobeCompleted = true;
\t\tconst specification = parseGeneratedVideoProbeUClaw(stdout);
\t\tif (specification && (specification.size || specification.durationSeconds !== void 0 || specification.hasAudio !== void 0)) return specification;
\t} catch {}
\tif (ffprobeCompleted) try {
\t\tconst dimensions = await probeVideoDimensionsUClawVideoActualSpec(buffer);
\t\tif (dimensions) return {
\t\t\twidth: dimensions.width,
\t\t\theight: dimensions.height,
\t\t\tsize: \`\${dimensions.width}x\${dimensions.height}\`
\t\t};
\t} catch {}
\treturn;
}
async function probeSavedGeneratedVideoUClaw(filePath) {
\tif (process.platform !== "darwin" || typeof filePath !== "string" || !filePath) return;
\treturn await new Promise((resolve) => {
\t\texecFileUClawVideoActualSpec("/usr/bin/avmediainfo", [filePath], {
\t\t\tencoding: "utf8",
\t\t\ttimeout: 5e3,
\t\t\tmaxBuffer: 1024 * 1024
\t\t}, (error, stdout) => {
\t\t\tif (error) {
\t\t\t\tresolve(void 0);
\t\t\t\treturn;
\t\t\t}
\t\t\tresolve(parseGeneratedVideoAvMediaInfoUClaw(stdout));
\t\t});
\t});
}
function formatGeneratedVideoSpecificationValueUClaw(value) {
\treturn typeof value === "boolean" ? value ? "on" : "off" : String(value);
}
function parseGeneratedVideoAspectRatioUClaw(value) {
\tif (typeof value !== "string") return;
\tconst match = value.match(/^\\s*(\\d+(?:\\.\\d+)?)\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*$/u);
\tif (!match) return;
\tconst width = Number.parseFloat(match[1]);
\tconst height = Number.parseFloat(match[2]);
\treturn width > 0 && height > 0 ? width / height : void 0;
}
function buildGeneratedVideoSpecificationDifferencesUClaw(specification) {
\tconst differences = [];
\tfor (const key of ["size", "aspectRatio", "resolution", "durationSeconds", "audio", "watermark"]) {
\t\tif (!(key in specification.requested)) continue;
\t\tif (!(key in specification.applied)) {
\t\t\tif (specification.translation?.inputs?.[key] !== void 0 && specification.translation?.size) differences.push(\`\${key} requested \${formatGeneratedVideoSpecificationValueUClaw(specification.requested[key])}, translated to size \${specification.translation.size}\`);
\t\t\telse differences.push(\`\${key} requested \${formatGeneratedVideoSpecificationValueUClaw(specification.requested[key])} but was not submitted\`);
\t\t\tcontinue;
\t\t}
\t\tif (specification.requested[key] !== specification.applied[key]) differences.push(\`\${key} requested \${formatGeneratedVideoSpecificationValueUClaw(specification.requested[key])}, submitted \${formatGeneratedVideoSpecificationValueUClaw(specification.applied[key])}\`);
\t}
\tfor (let index = 0; index < specification.actual.outputs.length; index++) {
\t\tconst output = specification.actual.outputs[index];
\t\tconst label = specification.actual.outputs.length === 1 ? "output" : \`output \${index + 1}\`;
\t\tif (output.size && specification.applied.size && output.size !== specification.applied.size) differences.push(\`\${label} size submitted \${specification.applied.size}, actual \${output.size}\`);
\t\tif (typeof output.durationSeconds === "number" && typeof specification.applied.durationSeconds === "number" && Math.abs(output.durationSeconds - specification.applied.durationSeconds) > .25) differences.push(\`\${label} duration submitted \${specification.applied.durationSeconds}s, actual \${Number(output.durationSeconds.toFixed(3))}s\`);
\t\tif (typeof output.hasAudio === "boolean" && typeof specification.applied.audio === "boolean" && output.hasAudio !== specification.applied.audio) differences.push(\`\${label} audio submitted \${formatGeneratedVideoSpecificationValueUClaw(specification.applied.audio)}, actual \${formatGeneratedVideoSpecificationValueUClaw(output.hasAudio)}\`);
\t\tconst requestedRatioLabel = specification.applied.aspectRatio ?? specification.translation?.inputs?.aspectRatio;
\t\tconst requestedRatio = parseGeneratedVideoAspectRatioUClaw(requestedRatioLabel);
\t\tif (requestedRatio && output.width && output.height && Math.abs(output.width / output.height - requestedRatio) / requestedRatio > .02) differences.push(\`\${label} aspect ratio target \${requestedRatioLabel}, actual \${output.width}:\${output.height}\`);
\t}
\treturn differences;
} // ${PATCH_MARKER}_HELPERS
`;

const SAVE_PATCH = `\tconst mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "video");
\tconst savedVideos = [];
\tconst savedVideoSpecifications = [];
\tconst urlOnlyVideoSpecifications = urlOnlyVideos.map(() => void 0);
\tfor (const video of bufferVideos) {
\t\tlet actualSpecification = await probeGeneratedVideoBufferUClaw(video.buffer);
\t\ttry {
\t\t\tconst saved = await saveMediaBuffer(video.buffer, video.mimeType, "tool-video-generation", mediaMaxBytes, params.filename || video.fileName);
\t\t\tconst savedSpecification = await probeSavedGeneratedVideoUClaw(saved.path);
\t\t\tactualSpecification = compactGeneratedVideoSpecificationUClaw({ ...actualSpecification, ...savedSpecification });
\t\t\tsavedVideos.push(saved);
\t\t\tsavedVideoSpecifications.push(actualSpecification);
\t\t} catch (error) {
\t\t\tif (video.url && isGeneratedMediaSizeLimitError(error)) {
\t\t\t\turlOnlyVideos.push({
\t\t\t\t\turl: video.url,
\t\t\t\t\tmimeType: video.mimeType,
\t\t\t\t\tfileName: video.fileName
\t\t\t\t});
\t\t\t\turlOnlyVideoSpecifications.push(actualSpecification);
\t\t\t\tcontinue;
\t\t\t}
\t\t\tthrow error;
\t\t}
\t}`;

const SPECIFICATION_PATCH = `\tconst requestedSpecification = compactGeneratedVideoSpecificationUClaw({
\t\tsize: params.size,
\t\taspectRatio: params.aspectRatio,
\t\tresolution: params.resolution,
\t\tdurationSeconds: requestedDurationSeconds,
\t\taudio: params.audio,
\t\twatermark: params.watermark
\t});
\tconst sizeDerivedFrom = result.normalization?.size?.derivedFrom;
\tconst translatedSpecification = sizeDerivedFrom ? {
\t\tsize: normalizedSize,
\t\tinputs: compactGeneratedVideoSpecificationUClaw({
\t\t\taspectRatio: sizeDerivedFrom.includes("aspectRatio") ? params.aspectRatio : void 0,
\t\t\tresolution: sizeDerivedFrom.includes("resolution") ? params.resolution : void 0
\t\t})
\t} : void 0;
\tconst appliedSpecification = compactGeneratedVideoSpecificationUClaw({
\t\tsize: normalizedSize ?? (!ignoredOverrideKeys.has("size") ? params.size : void 0),
\t\taspectRatio: result.normalization?.aspectRatio?.derivedFrom === "size" ? void 0 : normalizedAspectRatio ?? (!ignoredOverrideKeys.has("aspectRatio") ? params.aspectRatio : void 0),
\t\tresolution: result.normalization?.resolution?.derivedFrom === "size" ? void 0 : normalizedResolution ?? (!ignoredOverrideKeys.has("resolution") ? params.resolution : void 0),
\t\tdurationSeconds: normalizedDurationSeconds,
\t\taudio: !ignoredOverrideKeys.has("audio") ? params.audio : void 0,
\t\twatermark: !ignoredOverrideKeys.has("watermark") ? params.watermark : void 0
\t});
\tconst actualOutputs = [
\t\t...savedVideos.map((video, index) => compactGeneratedVideoSpecificationUClaw({
\t\t\tpath: video.path,
\t\t\t...savedVideoSpecifications[index]
\t\t})),
\t\t...urlOnlyVideos.map((video, index) => compactGeneratedVideoSpecificationUClaw({
\t\t\turl: video.url,
\t\t\t...urlOnlyVideoSpecifications[index]
\t\t}))
\t];
\tconst specification = {
\t\trequested: requestedSpecification,
\t\tapplied: appliedSpecification,
\t\t...translatedSpecification ? { translation: translatedSpecification } : {},
\t\tactual: { outputs: actualOutputs }
\t};
\tconst specificationDifferences = buildGeneratedVideoSpecificationDifferencesUClaw(specification);
\tconst specificationDifferenceLine = specificationDifferences.length > 0 ? \`Specification differences: \${specificationDifferences.slice(0, 3).join("; ")}\${specificationDifferences.length > 3 ? \`; +\${specificationDifferences.length - 3} more\` : ""}.\` : void 0;
${SPECIFICATION_ANCHOR}`;

const LINES_PATCH = `\t\t...warning ? [\`Warning: \${warning}\`] : [],
\t\t...specificationDifferenceLine ? [specificationDifferenceLine] : [],
\t\ttypeof requestedDurationSeconds === "number" && typeof normalizedDurationSeconds === "number" && requestedDurationSeconds !== normalizedDurationSeconds ? \`Duration normalized: requested \${requestedDurationSeconds}s; used \${normalizedDurationSeconds}s.\` : null,
\t\t...formatGeneratedAttachmentLines(attachments)`;

const DETAILS_PATCH = `\t\tdetails: {
\t\t\tprovider: result.provider,
\t\t\tmodel: result.model,
\t\t\tcount: totalCount,
\t\t\tspecification,`;

const ASYNC_TERMINAL_PATCH = `\t\t\t\tpaths: executed.paths,
\t\t\t\tterminalResult: terminalResult ?? (params.toolName === "Video generation" ? { terminalSummary: executed.contentText } : void 0)
\t\t\t});`;

const SYNC_TERMINAL_PATCH = `\t\t\t\t\tcount: executed.count,
\t\t\t\t\tpaths: executed.savedPaths,
\t\t\t\t\tterminalResult: { terminalSummary: executed.contentText }
\t\t\t\t});`;

export function patchOpenClawVideoActualSpecContent(content, options) {
  if (!content.includes(EXECUTE_ANCHOR)) return { content, changed: false, matched: false };
  if (content.includes(PATCH_MARKER)) return { content, changed: false, matched: true };
  if (!options?.mediaServices?.fileName
    || !options.mediaServices.runFfprobeExport
    || !options.mediaServices.probeVideoDimensionsExport) {
    throw new Error('[openclaw-video-actual-spec-patch] Media services import metadata is required.');
  }
  let patched = `${buildImports(options.mediaServices)}\n${content}`;
  patched = replaceExactlyOnce(patched, EXECUTE_ANCHOR, `${HELPERS}\n${EXECUTE_ANCHOR}`, 'executeVideoGenerationJob');
  patched = replaceExactlyOnce(patched, SAVE_ANCHOR, SAVE_PATCH, 'video save loop');
  patched = replaceExactlyOnce(patched, SPECIFICATION_ANCHOR, SPECIFICATION_PATCH, 'specification');
  patched = replaceExactlyOnce(patched, LINES_ANCHOR, LINES_PATCH, 'result lines');
  patched = replaceExactlyOnce(patched, DETAILS_ANCHOR, DETAILS_PATCH, 'details');
  patched = replaceExactlyOnce(patched, ASYNC_TERMINAL_ANCHOR, ASYNC_TERMINAL_PATCH, 'async terminal summary');
  patched = replaceExactlyOnce(patched, SYNC_TERMINAL_ANCHOR, SYNC_TERMINAL_PATCH, 'sync terminal summary');
  return { content: patched, changed: true, matched: true };
}

export function resolveOpenClawVideoMediaServices(distDir) {
  const candidates = [];
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^media-services-.*\.js$/u.test(entry.name)) continue;
    const content = readFileSync(join(distDir, entry.name), 'utf8');
    if (!content.includes('async function probeVideoDimensions') || !content.includes('function runFfprobe')) continue;
    const exportBlock = [...content.matchAll(/export \{([^}]+)\};/gu)].at(-1)?.[1] ?? '';
    const runFfprobeExport = exportBlock.match(/(?:^|,)\s*runFfprobe as ([A-Za-z_$][\w$]*)/u)?.[1];
    const probeVideoDimensionsExport = exportBlock.match(/(?:^|,)\s*probeVideoDimensions as ([A-Za-z_$][\w$]*)/u)?.[1];
    if (runFfprobeExport && probeVideoDimensionsExport) candidates.push({
      fileName: entry.name,
      runFfprobeExport,
      probeVideoDimensionsExport,
    });
  }
  if (candidates.length !== 1) {
    throw new Error(`[openclaw-video-actual-spec-patch] Expected exactly one media-services runtime; found ${candidates.length}.`);
  }
  return candidates[0];
}

export function patchOpenClawVideoActualSpecRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) throw new Error(`[openclaw-video-actual-spec-patch] OpenClaw dist directory not found: ${distDir}`);
  const mediaServices = resolveOpenClawVideoMediaServices(distDir);
  let matchedFiles = 0;
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawVideoActualSpecContent(content, { mediaServices });
    if (!result.matched) continue;
    matchedFiles += 1;
    if (result.changed) {
      patchedFiles += 1;
      if (!dryRun) writeFileSync(filePath, result.content, 'utf8');
    } else {
      alreadyPatchedFiles += 1;
    }
  }
  if (matchedFiles !== 1) throw new Error(`[openclaw-video-actual-spec-patch] Expected one video tool runtime file; found ${matchedFiles}.`);
  logger.log?.(`[openclaw-video-actual-spec-patch] ${dryRun ? 'Dry-run matched' : 'Patched'} ${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`);
  return { matchedFiles, patchedFiles, alreadyPatchedFiles };
}

export function patchInstalledOpenClawVideoActualSpecRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawVideoActualSpecRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}

export const __test = {
  PATCH_MARKER,
  EXECUTE_ANCHOR,
  SAVE_ANCHOR,
  SPECIFICATION_ANCHOR,
  LINES_ANCHOR,
  DETAILS_ANCHOR,
  ASYNC_TERMINAL_ANCHOR,
  SYNC_TERMINAL_ANCHOR,
  parseGeneratedVideoAvMediaInfoSource: HELPERS,
};
