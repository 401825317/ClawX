import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_MARKER = 'UCLAW_NATIVE_MEDIA_ACCEPTANCE';
const RETIRED_PATCH_SIGNATURES = [
  'acceptanceMismatches',
  'params.acceptance',
  'executed.acceptance',
  'executed.completionStatus',
  'executed.terminalResult',
  'original acceptance requirements',
];

const ACCEPTANCE_ANCHOR = 'const normalizedResolution = result.normalization?.resolution?.applied ?? (typeof result.metadata?.normalizedResolution === "string" && result.metadata.normalizedResolution.trim() ? result.metadata.normalizedResolution : void 0);';
const ACCEPTANCE_PATCH = `${ACCEPTANCE_ANCHOR}
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
	}; // ${PATCH_MARKER}_FACTS`;

const RETURN_ANCHOR = '\t\tmediaUrls: allMediaUrls,\n\t\tattachments,\n\t\tcontentText: lines.join("\\n"),\n\t\twakeResult: lines.join("\\n"),';
const RETURN_PATCH = `		mediaUrls: allMediaUrls,
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

const REPLY_ANCHOR = 'function buildMediaGenerationReplyInstruction(params) {\n\tif (params.status === "ok") return [';
const REPLY_PATCH = `function buildMediaGenerationReplyInstruction(params) {
	if (params.acceptance?.satisfied === false) return [
		"The generated media is an intermediate artifact only; the original acceptance requirements are not satisfied.",
		"Do not claim the original request is complete. Continue planning and executing the remaining work when the runtime has a suitable capability, or report the exact unmet requirements and concrete blocker.",
		"Use the current visible-reply contract for any artifact that is actually ready; keep internal task/session details private."
	].join(" ");
	if (params.status === "ok") return [`;

const STARTED_ANCHOR = 'Background task started for ${params.generationLabel} generation (${params.taskHandle?.taskId ?? "unknown"}). Do not call ${params.toolName} again for this request. Wait for the completion event; the completion agent will send the finished ${params.completionLabel} here when it\'s ready.';
const STARTED_PATCH = 'Background task started for ${params.generationLabel} generation (${params.taskHandle?.taskId ?? "unknown"}). Do not duplicate this running task. After the completion event, if the original acceptance requirements remain unmet, continue with the next required step instead of claiming completion.';

const INTERNAL_ANCHOR = '\t\tstatus: params.status,\n\t\tstatusLabel: params.statusLabel,';
const INTERNAL_PATCH = `		status: params.status,
		statusLabel: params.statusLabel,
		...params.acceptance ? { acceptance: params.acceptance } : {},`;

const WAKE_ANCHOR = '\t\t\t\tstatus: "ok",\n\t\t\t\tstatusLabel: "completed successfully",\n\t\t\t\tresult: executed.wakeResult,';
const WAKE_PATCH = `				status: executed.completionStatus ?? "ok",
				statusLabel: executed.completionStatusLabel ?? "completed successfully",
				acceptance: executed.acceptance, // ${PATCH_MARKER}_SCHEDULER
				result: executed.wakeResult,`;

const REPLY_PARAMS_ANCHOR = '\t\t\tcompletionLabel: params.completionLabel\n\t\t})';
const REPLY_PARAMS_PATCH = `			completionLabel: params.completionLabel,
			acceptance: params.acceptance
		})`;

const TERMINAL_ANCHOR = '\t\t\t\tterminalResult\n\t\t\t});';
const TERMINAL_PATCH = `				terminalResult: executed.terminalResult ?? terminalResult
			});`;

function restore(content, injected, original) {
  return content.includes(injected) ? content.replace(injected, original) : content;
}

export function cleanupOpenClawNativeMediaAcceptanceContent(content) {
  if (!content.includes('async function executeVideoGenerationJob')
    || !content.includes('function scheduleMediaGenerationTaskCompletion')) {
    return { content, changed: false, category: null };
  }
  let cleaned = content;
  cleaned = restore(cleaned, ACCEPTANCE_PATCH, ACCEPTANCE_ANCHOR);
  cleaned = restore(cleaned, RETURN_PATCH, RETURN_ANCHOR);
  cleaned = restore(cleaned, REPLY_PATCH, REPLY_ANCHOR);
  cleaned = restore(cleaned, STARTED_PATCH, STARTED_ANCHOR);
  cleaned = restore(cleaned, INTERNAL_PATCH, INTERNAL_ANCHOR);
  cleaned = restore(cleaned, WAKE_PATCH, WAKE_ANCHOR);
  cleaned = restore(cleaned, REPLY_PARAMS_PATCH, REPLY_PARAMS_ANCHOR);
  cleaned = restore(cleaned, TERMINAL_PATCH, TERMINAL_ANCHOR);
  const remainingSignatures = [PATCH_MARKER, ...RETIRED_PATCH_SIGNATURES]
    .filter((signature) => cleaned.includes(signature));
  if (remainingSignatures.length > 0) {
    throw new Error(
      `[openclaw-native-media-acceptance-cleanup] Retired acceptance patch was only partially removed: ${remainingSignatures.join(', ')}`,
    );
  }
  return { content: cleaned, changed: cleaned !== content, category: 'media-runtime' };
}

export function cleanupOpenClawNativeMediaAcceptanceRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  if (!existsSync(distDir)) return { cleanedFiles: 0, matchedFiles: 0 };
  let cleanedFiles = 0;
  let matchedFiles = 0;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const original = readFileSync(filePath, 'utf8');
    const result = cleanupOpenClawNativeMediaAcceptanceContent(original);
    if (!result.category) continue;
    matchedFiles += 1;
    if (!result.changed) continue;
    writeFileSync(filePath, result.content, 'utf8');
    cleanedFiles += 1;
    logger.log?.(`[openclaw-native-media-acceptance-cleanup] Cleaned: ${entry.name}`);
  }
  if (matchedFiles !== 1) {
    throw new Error(`[openclaw-native-media-acceptance-cleanup] Expected exactly one media runtime file; found ${matchedFiles}.`);
  }
  return { cleanedFiles, matchedFiles };
}

export function cleanupInstalledOpenClawNativeMediaAcceptanceRuntime(cwd = process.cwd(), options = {}) {
  return cleanupOpenClawNativeMediaAcceptanceRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}

export const __test = {
  ACCEPTANCE_ANCHOR,
  ACCEPTANCE_PATCH,
  RETURN_ANCHOR,
  RETURN_PATCH,
  REPLY_ANCHOR,
  REPLY_PATCH,
  STARTED_ANCHOR,
  STARTED_PATCH,
  INTERNAL_ANCHOR,
  INTERNAL_PATCH,
  WAKE_ANCHOR,
  WAKE_PATCH,
  REPLY_PARAMS_ANCHOR,
  REPLY_PARAMS_PATCH,
  TERMINAL_ANCHOR,
  TERMINAL_PATCH,
  RETIRED_PATCH_SIGNATURES,
};
