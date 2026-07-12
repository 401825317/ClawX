import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_MARKER = 'UCLAW_VIDEO_SEGMENT_DEDUPE_V2';
const PREVIOUS_PATCH_MARKER = 'UCLAW_VIDEO_SEGMENT_DEDUPE_V1';

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function replaceUnique(content, search, replacement, label, filePath) {
  const count = countOccurrences(content, search);
  if (count !== 1) {
    throw new Error(
      `[openclaw-video-segment-dedupe-patch] Expected exactly one ${label} anchor in ${filePath}; found ${count}.`,
    );
  }
  return content.replace(search, replacement);
}

const VIDEO_STATUS_HELPER_ANCHOR = `function createVideoGenerateDuplicateGuardResult(sessionKey, params) {
\treturn createMediaGenerateDuplicateGuardResult({
\t\tsessionKey,
\t\tprompt: params?.prompt,
\t\trequestKey: params?.requestKey,
\t\tfindDuplicateTask: findDuplicateGuardVideoGenerationTaskForSession,
\t\tbuildStatusText: buildVideoGenerationTaskStatusText,
\t\tbuildStatusDetails: buildVideoGenerationTaskStatusDetails
\t});
}`;

const VIDEO_STATUS_HELPER_PATCH = `function findDuplicateGuardVideoGenerationTaskForSession(sessionKey, params) {
\tconst normalizedSessionKey = normalizeOptionalString(sessionKey);
\tconst matchingTask = findDuplicateGuardMediaGenerationTaskForSession({
\t\tsessionKey,
\t\ttaskKind: VIDEO_GENERATION_TASK_KIND,
\t\tsourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
\t\ttaskLabel: params?.prompt,
\t\trequestKey: params?.requestKey,
\t\tmaxAgeMs: RECENT_VIDEO_GENERATION_DUPLICATE_GUARD_MS
\t});
\tif (matchingTask || !normalizedSessionKey || !params?.prompt?.startsWith("video-segment:")) return matchingTask;
\tconst nowMs = Date.now();
\treturn listFreshTasksForOwnerKey(normalizedSessionKey).find((task) => {
\t\tif (task.runtime !== "cli" || task.scopeKind !== "session" || task.taskKind !== VIDEO_GENERATION_TASK_KIND) return false;
\t\tif (!mediaGenerationSourceMatches(task, VIDEO_GENERATION_SOURCE_PREFIX) || !mediaGenerationTaskLabelMatches(task, params.prompt)) return false;
\t\tif (isTaskStillBlockingDuplicateGuard(task)) return true;
\t\treturn task.status === "succeeded" && task.terminalOutcome !== "blocked" && isRecentMediaGenerationTaskRecord({
\t\t\ttask,
\t\t\tmaxAgeMs: RECENT_VIDEO_GENERATION_DUPLICATE_GUARD_MS,
\t\t\tnowMs
\t\t});
\t});
}
${VIDEO_STATUS_HELPER_ANCHOR}
const UCLAW_VIDEO_SEGMENT_DEDUPE_PATCH = "${PATCH_MARKER}";
function resolveVideoGenerationSegmentScope(parentTaskId, segmentId) {
\tconst normalizedParentTaskId = normalizeOptionalString(parentTaskId);
\tconst normalizedSegmentId = normalizeOptionalString(segmentId);
\tif (Boolean(normalizedParentTaskId) !== Boolean(normalizedSegmentId)) throw new ToolInputError("parentTaskId and segmentId must be provided together");
\tif (!normalizedParentTaskId || !normalizedSegmentId) return;
\treturn {
\t\tparentTaskId: normalizedParentTaskId,
\t\tsegmentId: normalizedSegmentId,
\t\ttaskLabel: \`video-segment:\${stableStringify({
\t\t\tparentTaskId: normalizedParentTaskId,
\t\t\tsegmentId: normalizedSegmentId
\t\t})}\`
\t};
}`;

const VIDEO_DUPLICATE_FINDER_ANCHOR = `function findDuplicateGuardVideoGenerationTaskForSession(sessionKey, params) {
\treturn findDuplicateGuardMediaGenerationTaskForSession({
\t\tsessionKey,
\t\ttaskKind: VIDEO_GENERATION_TASK_KIND,
\t\tsourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
\t\ttaskLabel: params?.prompt,
\t\trequestKey: params?.requestKey,
\t\tmaxAgeMs: RECENT_VIDEO_GENERATION_DUPLICATE_GUARD_MS
\t});
}
`;

const VIDEO_STATUS_TEXT_ANCHOR = `function buildVideoGenerationTaskStatusText(task, params) {
\treturn buildMediaGenerationTaskStatusText({
\t\ttask,
\t\tsourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
\t\tnounLabel: "Video generation",
\t\ttoolName: "video_generate",
\t\tcompletionLabel: "video",
\t\tduplicateGuard: params?.duplicateGuard
\t});
}`;

const VIDEO_STATUS_TEXT_PATCH = `function buildVideoGenerationTaskStatusText(task, params) {
\tconst text = buildMediaGenerationTaskStatusText({
\t\ttask,
\t\tsourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
\t\tnounLabel: "Video generation",
\t\ttoolName: "video_generate",
\t\tcompletionLabel: "video",
\t\tduplicateGuard: params?.duplicateGuard
\t});
\tif (!params?.duplicateGuard) return text;
\treturn text
\t\t.replace("Do not call video_generate again for this request.", "Do not resubmit this same logical video segment while it is active; other planned segmentId values remain allowed.")
\t\t.replace("Do not call video_generate again for the same request;", "Do not resubmit this same logical video segment;");
}`;

const VIDEO_ACTIVE_PROMPT_ANCHOR = `function buildActiveVideoGenerationTaskPromptContextForSession(sessionKey) {
\treturn buildActiveMediaGenerationTaskPromptContextForSession({
\t\tsessionKey,
\t\ttaskKind: VIDEO_GENERATION_TASK_KIND,
\t\tsourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
\t\tnounLabel: "Video generation",
\t\ttoolName: "video_generate",
\t\tcompletionLabel: "videos"
\t});
}`;

const VIDEO_ACTIVE_PROMPT_PATCH = `function buildActiveVideoGenerationTaskPromptContextForSession(sessionKey) {
\tconst tasks = listActiveMediaGenerationTasksForSession({
\t\tsessionKey,
\t\ttaskKind: VIDEO_GENERATION_TASK_KIND,
\t\tsourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX
\t});
\tif (tasks.length === 0) return;
\treturn [
\t\t\`${'${tasks.length}'} active video generation ${'${tasks.length === 1 ? "task is" : "tasks are"}'} queued or running for this session.\`,
\t\t...tasks.map((task) => \`- Task ${'${task.taskId}'} is ${'${task.status}'}${'${task.progressSummary ? `: ${task.progressSummary}` : "."}'}\`),
\t\t"Do not resubmit the same logical segment while it is active; use video_generate action:\\\"status\\\" with its parentTaskId and segmentId when checking that segment.",
\t\t"For an explicit long-form composition plan, continue with a small bounded batch of distinct segmentId values under the same parentTaskId, then verify and compose their outputs."
\t].join("\\n");
}`;

const VIDEO_SCHEMA_ANCHOR = `const VideoGenerateToolProperties = {
\taction: Type.Optional(Type.String({ description: "\\\"generate\\\" default, \\\"status\\\" active task, \\\"list\\\" providers/models." })),
\tprompt: Type.Optional(Type.String({ description: "Video prompt." })),`;

const VIDEO_SCHEMA_PATCH = `const VideoGenerateToolProperties = {
\taction: Type.Optional(Type.String({ description: "\\\"generate\\\" default, \\\"status\\\" active task, \\\"list\\\" providers/models." })),
\tparentTaskId: Type.Optional(Type.String({
\t\tdescription: "Stable logical id shared by all generated segments of one long-form video. Use together with segmentId.",
\t\tminLength: 1,
\t\tmaxLength: 200
\t})),
\tsegmentId: Type.Optional(Type.String({
\t\tdescription: "Stable id for one logical video segment. Distinct segmentId values under the same parentTaskId may generate separately; replaying the same pair is deduplicated.",
\t\tminLength: 1,
\t\tmaxLength: 200
\t})),
\tprompt: Type.Optional(Type.String({ description: "Video prompt." })),`;

const VIDEO_DESCRIPTION_ANCHOR = `description: "Create videos. Session chats: background task; do not call video_generate again for same request; wait completion, then report through the current visible-reply contract with generated media attached using structured media fields. \\\"status\\\" checks active task. Duration may round to provider-supported value.",`;

const VIDEO_DESCRIPTION_PATCH = `description: "Create videos. Session chats use background tasks. Do not resubmit the same logical segment while it is queued or running; use status instead. Long-form work may call video_generate multiple times with one shared parentTaskId and a unique segmentId per shot, verify every segment, then compose the final video. If requested duration exceeds provider limits, plan enough distinct segments instead of replacing generated motion with a still-image timeline. Duration may round to a provider-supported value.",`;

const VIDEO_EXECUTE_HEAD_ANCHOR = `\t\texecute: async (_toolCallId, rawArgs) => {
\t\t\tconst args = rawArgs;
\t\t\tconst action = resolveAction(args);
\t\t\tif (action === "list") return createVideoGenerateListActionResult(cfg, {
\t\t\t\tworkspaceDir: options?.workspaceDir,
\t\t\t\tagentDir: options?.agentDir,
\t\t\t\tauthStore: options?.authProfileStore
\t\t\t});
\t\t\tif (action === "status") return createVideoGenerateStatusActionResult(options?.agentSessionKey);
\t\t\tconst videoGenerationModelConfig = resolveVideoGenerationModelConfigForTool({`;

const VIDEO_EXECUTE_HEAD_PATCH = `\t\texecute: async (_toolCallId, rawArgs) => {
\t\t\tconst args = rawArgs;
\t\t\tconst action = resolveAction(args);
\t\t\tconst parentTaskId = readStringParam(args, "parentTaskId");
\t\t\tconst segmentId = readStringParam(args, "segmentId");
\t\t\tconst segmentScope = resolveVideoGenerationSegmentScope(parentTaskId, segmentId);
\t\t\tif (action === "list") return createVideoGenerateListActionResult(cfg, {
\t\t\t\tworkspaceDir: options?.workspaceDir,
\t\t\t\tagentDir: options?.agentDir,
\t\t\t\tauthStore: options?.authProfileStore
\t\t\t});
\t\t\tif (action === "status") {
\t\t\t\tif (segmentScope) {
\t\t\t\t\tconst matchingSegment = createVideoGenerateDuplicateGuardResult(options?.agentSessionKey, { prompt: segmentScope.taskLabel });
\t\t\t\t\tif (matchingSegment) return matchingSegment;
\t\t\t\t}
\t\t\t\treturn createVideoGenerateStatusActionResult(options?.agentSessionKey);
\t\t\t}
\t\t\tconst videoGenerationModelConfig = resolveVideoGenerationModelConfigForTool({`;

const VIDEO_BROAD_GUARD_ANCHOR = `\t\t\tconst prompt = readStringParam(args, "prompt", { required: true });
\t\t\tconst activeDuplicateGuardResult = createVideoGenerateDuplicateGuardResult(options?.agentSessionKey);
\t\t\tif (activeDuplicateGuardResult) return activeDuplicateGuardResult;
\t\t\tconst model = readStringParam(args, "model");`;

const VIDEO_BROAD_GUARD_PATCH = `\t\t\tconst prompt = readStringParam(args, "prompt", { required: true });
\t\t\tconst taskLabel = segmentScope?.taskLabel ?? prompt;
\t\t\tconst activeDuplicateGuardResult = segmentScope ? void 0 : createVideoGenerateDuplicateGuardResult(options?.agentSessionKey);
\t\t\tif (activeDuplicateGuardResult) return activeDuplicateGuardResult;
\t\t\tconst model = readStringParam(args, "model");`;

const VIDEO_REQUEST_KEY_ANCHOR = `\t\t\tconst requestKey = buildMediaGenerationRequestKey({
\t\t\t\ttool: "video_generate",
\t\t\t\tprompt,`;

const VIDEO_REQUEST_KEY_PATCH = `\t\t\tconst requestKey = buildMediaGenerationRequestKey({
\t\t\t\ttool: "video_generate",
\t\t\t\tprompt,
\t\t\t\tparentTaskId: segmentScope?.parentTaskId,
\t\t\t\tsegmentId: segmentScope?.segmentId,`;

const VIDEO_SCOPED_GUARD_ANCHOR = `\t\t\tconst duplicateGuardResult = createVideoGenerateDuplicateGuardResult(options?.agentSessionKey, { requestKey });`;
const VIDEO_SCOPED_GUARD_PATCH = `\t\t\tconst duplicateGuardResult = createVideoGenerateDuplicateGuardResult(options?.agentSessionKey, {
\t\t\t\tprompt: taskLabel,
\t\t\t\trequestKey
\t\t\t});`;

const VIDEO_TASK_HANDLE_ANCHOR = `\t\t\tconst taskHandle = createVideoGenerationTaskRun({
\t\t\t\tsessionKey: options?.agentSessionKey,
\t\t\t\trequesterOrigin: options?.requesterOrigin,
\t\t\t\tprompt,
\t\t\t\tproviderId: selectedProvider?.id
\t\t\t});`;

const VIDEO_TASK_HANDLE_PATCH = `\t\t\tconst taskHandle = createVideoGenerationTaskRun({
\t\t\t\tsessionKey: options?.agentSessionKey,
\t\t\t\trequesterOrigin: options?.requesterOrigin,
\t\t\t\tprompt: taskLabel,
\t\t\t\tproviderId: selectedProvider?.id
\t\t\t});`;

const VIDEO_RECENT_TASK_LABEL_ANCHOR = `\t\t\t\t\ttaskKind: "video_generation",
\t\t\t\t\tsourcePrefix: "video_generate",
\t\t\t\t\ttaskId: taskHandle.taskId,
\t\t\t\t\trunId: taskHandle.runId,
\t\t\t\t\ttaskLabel: prompt,
\t\t\t\t\trequestKey,`;
const VIDEO_RECENT_TASK_LABEL_PATCH = `\t\t\t\t\ttaskKind: "video_generation",
\t\t\t\t\tsourcePrefix: "video_generate",
\t\t\t\t\ttaskId: taskHandle.taskId,
\t\t\t\t\trunId: taskHandle.runId,
\t\t\t\t\ttaskLabel,
\t\t\t\t\trequestKey,`;

const VIDEO_DETAIL_EXTRAS_ANCHOR = `\t\t\t\t\t\t...model ? { model } : {},
\t\t\t\t\t\t...size ? { size } : {},`;
const VIDEO_DETAIL_EXTRAS_PATCH = `\t\t\t\t\t\t...segmentScope ? {
\t\t\t\t\t\t\tparentTaskId: segmentScope.parentTaskId,
\t\t\t\t\t\t\tsegmentId: segmentScope.segmentId
\t\t\t\t\t\t} : {},
\t\t\t\t\t\t...model ? { model } : {},
\t\t\t\t\t\t...size ? { size } : {},`;

const VIDEO_SYNC_DETAILS_ANCHOR = `\t\t\t\tcompleteVideoGenerationTaskRun({
\t\t\t\t\thandle: taskHandle,
\t\t\t\t\tprovider: executed.provider,
\t\t\t\t\tmodel: executed.model,
\t\t\t\t\tcount: executed.count,
\t\t\t\t\tpaths: executed.savedPaths
\t\t\t\t});
\t\t\t\treturn {
\t\t\t\t\tcontent: [{
\t\t\t\t\t\ttype: "text",
\t\t\t\t\t\ttext: executed.contentText
\t\t\t\t\t}],
\t\t\t\t\tdetails: executed.details
\t\t\t\t};`;
const VIDEO_SYNC_DETAILS_PATCH = `\t\t\t\tcompleteVideoGenerationTaskRun({
\t\t\t\t\thandle: taskHandle,
\t\t\t\t\tprovider: executed.provider,
\t\t\t\t\tmodel: executed.model,
\t\t\t\t\tcount: executed.count,
\t\t\t\t\tpaths: executed.savedPaths
\t\t\t\t});
\t\t\t\treturn {
\t\t\t\t\tcontent: [{
\t\t\t\t\t\ttype: "text",
\t\t\t\t\t\ttext: executed.contentText
\t\t\t\t\t}],
\t\t\t\t\tdetails: {
\t\t\t\t\t\t...executed.details,
\t\t\t\t\t\t...segmentScope ? {
\t\t\t\t\t\t\tparentTaskId: segmentScope.parentTaskId,
\t\t\t\t\t\t\tsegmentId: segmentScope.segmentId
\t\t\t\t\t\t} : {}
\t\t\t\t\t}
\t\t\t\t};`;

export function patchOpenClawVideoSegmentDedupeContent(content, filePath = '<fixture>') {
  if (!content.includes('function createVideoGenerateTool(options)')) {
    return { content, changed: false, matched: false };
  }
  if (content.includes(PATCH_MARKER)) {
    return { content, changed: false, matched: true };
  }
  if (content.includes(PREVIOUS_PATCH_MARKER)) {
    let migrated = content;
    migrated = replaceUnique(
      migrated,
      'function findDuplicateGuardVideoGenerationTaskForSession(sessionKey, params) {\n\tconst matchingTask =',
      'function findDuplicateGuardVideoGenerationTaskForSession(sessionKey, params) {\n\tconst normalizedSessionKey = normalizeOptionalString(sessionKey);\n\tconst matchingTask =',
      'v1 normalized session key',
      filePath,
    );
    migrated = replaceUnique(
      migrated,
      'if (matchingTask || !params?.prompt?.startsWith("video-segment:")) return matchingTask;',
      'if (matchingTask || !normalizedSessionKey || !params?.prompt?.startsWith("video-segment:")) return matchingTask;',
      'v1 scoped session guard',
      filePath,
    );
    migrated = replaceUnique(
      migrated,
      'return listFreshTasksForOwnerKey(sessionKey).find((task) => {',
      'return listFreshTasksForOwnerKey(normalizedSessionKey).find((task) => {',
      'v1 scoped task lookup',
      filePath,
    );
    migrated = replaceUnique(
      migrated,
      'const UCLAW_VIDEO_SEGMENT_DEDUPE_V1 = "UCLAW_VIDEO_SEGMENT_DEDUPE_V1";',
      `const UCLAW_VIDEO_SEGMENT_DEDUPE_PATCH = "${PATCH_MARKER}";`,
      'v1 patch marker',
      filePath,
    );
    return { content: migrated, changed: true, matched: true };
  }

  let patched = content;
  patched = replaceUnique(patched, VIDEO_DUPLICATE_FINDER_ANCHOR, '', 'legacy video duplicate finder', filePath);
  patched = replaceUnique(patched, VIDEO_STATUS_HELPER_ANCHOR, VIDEO_STATUS_HELPER_PATCH, 'video status helper', filePath);
  patched = replaceUnique(patched, VIDEO_STATUS_TEXT_ANCHOR, VIDEO_STATUS_TEXT_PATCH, 'video duplicate status text', filePath);
  patched = replaceUnique(patched, VIDEO_ACTIVE_PROMPT_ANCHOR, VIDEO_ACTIVE_PROMPT_PATCH, 'active video prompt context', filePath);
  patched = replaceUnique(patched, VIDEO_SCHEMA_ANCHOR, VIDEO_SCHEMA_PATCH, 'video tool schema', filePath);
  patched = replaceUnique(patched, VIDEO_DESCRIPTION_ANCHOR, VIDEO_DESCRIPTION_PATCH, 'video tool description', filePath);
  patched = replaceUnique(patched, VIDEO_EXECUTE_HEAD_ANCHOR, VIDEO_EXECUTE_HEAD_PATCH, 'video execute head', filePath);
  patched = replaceUnique(patched, VIDEO_BROAD_GUARD_ANCHOR, VIDEO_BROAD_GUARD_PATCH, 'broad video duplicate guard', filePath);
  patched = replaceUnique(patched, VIDEO_REQUEST_KEY_ANCHOR, VIDEO_REQUEST_KEY_PATCH, 'video request key', filePath);
  patched = replaceUnique(patched, VIDEO_SCOPED_GUARD_ANCHOR, VIDEO_SCOPED_GUARD_PATCH, 'scoped video duplicate guard', filePath);
  patched = replaceUnique(patched, VIDEO_TASK_HANDLE_ANCHOR, VIDEO_TASK_HANDLE_PATCH, 'video task handle', filePath);
  patched = replaceUnique(patched, VIDEO_RECENT_TASK_LABEL_ANCHOR, VIDEO_RECENT_TASK_LABEL_PATCH, 'recent video task label', filePath);
  patched = replaceUnique(patched, VIDEO_DETAIL_EXTRAS_ANCHOR, VIDEO_DETAIL_EXTRAS_PATCH, 'async video detail extras', filePath);
  patched = replaceUnique(patched, VIDEO_SYNC_DETAILS_ANCHOR, VIDEO_SYNC_DETAILS_PATCH, 'sync video details', filePath);
  return { content: patched, changed: true, matched: true };
}

export function patchOpenClawVideoSegmentDedupeRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-video-segment-dedupe-patch] OpenClaw dist directory not found: ${distDir}`);
  }

  let matchedFiles = 0;
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawVideoSegmentDedupeContent(content, filePath);
    if (!result.matched) continue;
    matchedFiles += 1;
    if (result.changed) {
      patchedFiles += 1;
      if (!dryRun) writeFileSync(filePath, result.content, 'utf8');
    } else {
      alreadyPatchedFiles += 1;
    }
  }

  if (matchedFiles !== 1) {
    throw new Error(`[openclaw-video-segment-dedupe-patch] Expected one runtime file; found ${matchedFiles}.`);
  }
  logger.log?.(
    `[openclaw-video-segment-dedupe-patch] ${dryRun ? 'Dry-run matched' : 'Patched'} ${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`,
  );
  return { matchedFiles, patchedFiles, alreadyPatchedFiles };
}

export function patchInstalledOpenClawVideoSegmentDedupeRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawVideoSegmentDedupeRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
