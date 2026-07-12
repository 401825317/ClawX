import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_MARKER = 'UCLAW_NATIVE_MEDIA_ACCEPTANCE';
const ACCEPTANCE_MARKER = `${PATCH_MARKER}_FACTS`;
const REPLY_MARKER = `${PATCH_MARKER}_REPLY`;
const SCHEDULER_MARKER = `${PATCH_MARKER}_SCHEDULER`;
const STARTED_MARKER = `${PATCH_MARKER}_STARTED`;

function replaceOnce(content, anchor, replacement, label, filePath) {
  const count = content.split(anchor).length - 1;
  if (count !== 1) throw new Error(`[openclaw-native-media-acceptance-patch] Expected one ${label} anchor in ${filePath}; found ${count}.`);
  return content.replace(anchor, replacement);
}

function replaceLast(content, anchor, replacement, label, filePath) {
  const index = content.lastIndexOf(anchor);
  if (index < 0) throw new Error(`[openclaw-native-media-acceptance-patch] Missing ${label} anchor in ${filePath}.`);
  if (content.indexOf(anchor) !== index) {
    // The bundled file contains image and video variants. The video executor
    // is the last occurrence in the stable OpenClaw build.
  }
  return `${content.slice(0, index)}${replacement}${content.slice(index + anchor.length)}`;
}

function patchMediaRuntimeContent(content, filePath) {
  if (!content.includes('async function executeVideoGenerationJob') || !content.includes('function scheduleMediaGenerationTaskCompletion')) return null;
  if (content.includes(PATCH_MARKER)) return { content, changed: false, category: 'media-runtime' };

  let patched = content;
  const acceptanceAnchor = 'const normalizedResolution = result.normalization?.resolution?.applied ?? (typeof result.metadata?.normalizedResolution === "string" && result.metadata.normalizedResolution.trim() ? result.metadata.normalizedResolution : void 0);';
  const acceptancePatch = `${acceptanceAnchor}
	const acceptanceMismatches = [];
	if (typeof requestedDurationSeconds === "number" && typeof normalizedDurationSeconds === "number" && requestedDurationSeconds !== normalizedDurationSeconds) acceptanceMismatches.push({
		field: "durationSeconds",
		reason: \`requested \${requestedDurationSeconds}s, actual \${normalizedDurationSeconds}s\`
	});
	for (const ignoredOverride of ignoredOverrides) acceptanceMismatches.push({
		field: ignoredOverride.key,
		reason: formatIgnoredVideoGenerationOverride(ignoredOverride)
	});
	const acceptance = {
		satisfied: acceptanceMismatches.length === 0,
		status: acceptanceMismatches.length === 0 ? "satisfied" : "blocked",
		requested: {
			durationSeconds: requestedDurationSeconds,
			size: params.size,
			resolution: params.resolution,
			aspectRatio: params.aspectRatio,
			audio: params.audio,
			watermark: params.watermark
		},
		actual: {
			durationSeconds: normalizedDurationSeconds,
			size: normalizedSize,
			resolution: normalizedResolution,
			aspectRatio: normalizedAspectRatio,
			audio: ignoredOverrideKeys.has("audio") ? void 0 : params.audio,
			watermark: ignoredOverrideKeys.has("watermark") ? void 0 : params.watermark
		},
		unmetRequirements: acceptanceMismatches
	}; // ${ACCEPTANCE_MARKER}`;
  patched = replaceLast(patched, acceptanceAnchor, acceptancePatch, 'acceptance facts', filePath);

  const returnAnchor = '\t\tmediaUrls: allMediaUrls,\n\t\tattachments,\n\t\tcontentText: lines.join("\\n"),\n\t\twakeResult: lines.join("\\n"),';
  const returnPatch = `		mediaUrls: allMediaUrls,
		attachments,
		contentText: lines.join("\\n"),
		wakeResult: lines.join("\\n"),
		acceptance,
		completionStatus: acceptance.satisfied ? "ok" : "unknown",
		completionStatusLabel: acceptance.satisfied ? "completed successfully" : "intermediate artifact; acceptance requirements remain unmet",
		terminalResult: acceptance.satisfied ? void 0 : {
			terminalOutcome: "blocked",
			terminalSummary: \`Generated intermediate video; unmet requirements: \${acceptanceMismatches.map((item) => item.reason).join("; ")}\`
		},`;
  patched = replaceOnce(patched, returnAnchor, returnPatch, 'video execution result', filePath);

  const replyAnchor = 'function buildMediaGenerationReplyInstruction(params) {\n\tif (params.status === "ok") return [';
  const replyPatch = `function buildMediaGenerationReplyInstruction(params) {
	if (params.acceptance?.satisfied === false) return [
		"The generated media is an intermediate artifact only; the original acceptance requirements are not satisfied.",
		"Do not claim the original request is complete. Continue planning and executing the remaining work when the runtime has a suitable capability, or report the exact unmet requirements and concrete blocker.",
		"Use the current visible-reply contract for any artifact that is actually ready; keep internal task/session details private."
	].join(" ");
	if (params.status === "ok") return [`;
  patched = replaceOnce(patched, replyAnchor, replyPatch, 'completion reply instruction', filePath);

  const startedAnchor = 'Background task started for ${params.generationLabel} generation (${params.taskHandle?.taskId ?? "unknown"}). Do not call ${params.toolName} again for this request. Wait for the completion event; the completion agent will send the finished ${params.completionLabel} here when it\'s ready.';
  const startedPatch = 'Background task started for ${params.generationLabel} generation (${params.taskHandle?.taskId ?? "unknown"}). Do not duplicate this running task. After the completion event, if the original acceptance requirements remain unmet, continue with the next required step instead of claiming completion.';
  patched = replaceOnce(patched, startedAnchor, startedPatch, 'async start instruction', filePath);

  const internalAnchor = '\t\tstatus: params.status,\n\t\tstatusLabel: params.statusLabel,';
  const internalPatch = `		status: params.status,
		statusLabel: params.statusLabel,
		...params.acceptance ? { acceptance: params.acceptance } : {},`;
  patched = replaceOnce(patched, internalAnchor, internalPatch, 'completion acceptance event', filePath);

  const wakeCallAnchor = '\t\t\t\tstatus: "ok",\n\t\t\t\tstatusLabel: "completed successfully",\n\t\t\t\tresult: executed.wakeResult,';
  const wakeCallPatch = `				status: executed.completionStatus ?? "ok",
				statusLabel: executed.completionStatusLabel ?? "completed successfully",
				acceptance: executed.acceptance, // ${SCHEDULER_MARKER}
				result: executed.wakeResult,`;
  patched = replaceOnce(patched, wakeCallAnchor, wakeCallPatch, 'completion wake status', filePath);

  const replyParamsAnchor = '\t\t\tcompletionLabel: params.completionLabel\n\t\t})';
  const replyParamsPatch = `			completionLabel: params.completionLabel,
			acceptance: params.acceptance
		})`;
  patched = replaceOnce(patched, replyParamsAnchor, replyParamsPatch, 'reply acceptance parameter', filePath);

  const terminalAnchor = '\t\t\t\tterminalResult\n\t\t\t});';
  const terminalPatch = `				terminalResult: executed.terminalResult ?? terminalResult
			});`;
  patched = replaceOnce(patched, terminalAnchor, terminalPatch, 'terminal acceptance result', filePath);
  return { content: patched, changed: true, category: 'media-runtime' };
}

export function patchOpenClawNativeMediaAcceptanceContent(content, filePath = '<fixture>') {
  return patchMediaRuntimeContent(content, filePath) ?? { content, changed: false, category: null };
}

export function patchOpenClawNativeMediaAcceptanceRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) throw new Error(`[openclaw-native-media-acceptance-patch] OpenClaw dist directory not found: ${distDir}`);
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  let matched = 0;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawNativeMediaAcceptanceContent(content, filePath);
    if (!result.category) continue;
    matched += 1;
    if (result.changed) {
      patchedFiles += 1;
      if (!dryRun) writeFileSync(filePath, result.content, 'utf8');
    } else alreadyPatchedFiles += 1;
  }
  if (matched !== 1) throw new Error(`[openclaw-native-media-acceptance-patch] Expected exactly one media runtime file; found ${matched}.`);
  logger.log?.(`[openclaw-native-media-acceptance-patch] ${dryRun ? 'Dry-run matched' : 'Patched'} ${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`);
  return { patchedFiles, alreadyPatchedFiles };
}

export function patchInstalledOpenClawNativeMediaAcceptanceRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawNativeMediaAcceptanceRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
