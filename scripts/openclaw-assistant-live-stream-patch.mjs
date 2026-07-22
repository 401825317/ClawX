import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_MARKER_V1 = 'UCLAW_OPENAI_RESPONSES_UI_STREAM_V1';
const PATCH_MARKER_V2 = 'UCLAW_OPENAI_RESPONSES_UI_STREAM_V2';
const PATCH_MARKER_V3 = 'UCLAW_OPENAI_RESPONSES_UI_STREAM_V3';
const PATCH_MARKER = 'UCLAW_OPENAI_RESPONSES_UI_STREAM_V4';
const PENDING_PHASE_ANCHOR = '\tif (isPhasePendingOpenAiResponsesTextItem) return;';
const PENDING_PHASE_PATCH_V1 = `\tif (isPhasePendingOpenAiResponsesTextItem) {
\t\tif (chunk) ctx.state.deltaBuffer += chunk;
\t\tconst suppressPendingPhaseUiStream = ctx.params.suppressLiveStreamOutput === true || ctx.params.silentExpected || suppressDeterministicApprovalOutput || suppressMessageToolOnlySourceReplyOutput;
\t\tif (chunk && !suppressPendingPhaseUiStream) {
\t\t\tctx.emitAssistantStreamData(buildAssistantStreamData({
\t\t\t\ttext: ctx.state.deltaBuffer,
\t\t\t\tdelta: chunk,
\t\t\t\titemId: streamItemId
\t\t\t}));
\t\t\tctx.state.emittedAssistantUpdate = true;
\t\t}
\t\treturn;
\t} // ${PATCH_MARKER_V1}`;
const PENDING_PHASE_PATCH_V2 = `\tif (isPhasePendingOpenAiResponsesTextItem) {
\t\tif (chunk) ctx.state.deltaBuffer += chunk;
\t\tconst suppressPendingPhaseUiStream = ctx.params.suppressLiveStreamOutput === true || ctx.params.silentExpected || suppressDeterministicApprovalOutput || suppressMessageToolOnlySourceReplyOutput;
\t\tif (chunk && !suppressPendingPhaseUiStream) {
\t\t\tconst pendingPhaseUiData = buildAssistantStreamData({
\t\t\t\ttext: ctx.state.deltaBuffer,
\t\t\t\tdelta: chunk,
\t\t\t\titemId: streamItemId
\t\t\t});
\t\t\t// Bypass terminal buffering only for the in-app Agent/UI event stream.
\t\t\temitAgentEvent({
\t\t\t\trunId: ctx.params.runId,
\t\t\t\tstream: "assistant",
\t\t\t\tdata: pendingPhaseUiData
\t\t\t});
\t\t\tctx.params.onAgentEvent?.({
\t\t\t\tstream: "assistant",
\t\t\t\tdata: pendingPhaseUiData
\t\t\t});
\t\t\tctx.state.emittedAssistantUpdate = true;
\t\t}
\t\treturn;
\t} // ${PATCH_MARKER_V2}`;
const PENDING_PHASE_PATCH_V3 = `\tif (isPhasePendingOpenAiResponsesTextItem) {
\t\tif (chunk) ctx.state.deltaBuffer += chunk;
\t\tconst suppressPendingPhaseUiStream = ctx.params.suppressLiveStreamOutput === true || ctx.params.silentExpected || suppressDeterministicApprovalOutput || suppressMessageToolOnlySourceReplyOutput;
\t\tif (chunk && !suppressPendingPhaseUiStream) {
\t\t\tconst pendingPhaseUiData = {
\t\t\t\tdelta: chunk,
\t\t\t\titemId: streamItemId
\t\t\t};
\t\t\t// Bypass terminal buffering only for the in-app Agent/UI event stream.
\t\t\temitAgentEvent({
\t\t\t\trunId: ctx.params.runId,
\t\t\t\tstream: "assistant",
\t\t\t\tdata: pendingPhaseUiData
\t\t\t});
\t\t\tctx.params.onAgentEvent?.({
\t\t\t\tstream: "assistant",
\t\t\t\tdata: pendingPhaseUiData
\t\t\t});
\t\t\tctx.state.emittedAssistantUpdate = true;
\t\t}
\t\treturn;
\t} // ${PATCH_MARKER_V3}`;
const PENDING_PHASE_PATCH = `\tif (isPhasePendingOpenAiResponsesTextItem) {
\t\tif (chunk) ctx.state.deltaBuffer += chunk;
\t\tconst suppressPendingPhaseUiStream = ctx.params.suppressLiveStreamOutput === true || ctx.params.silentExpected || suppressDeterministicApprovalOutput || suppressMessageToolOnlySourceReplyOutput;
\t\tif (chunk && !suppressPendingPhaseUiStream) {
\t\t\tconst pendingPhaseUiData = {
\t\t\t\ttext: "",
\t\t\t\tdelta: chunk,
\t\t\t\titemId: streamItemId
\t\t\t};
\t\t\t// Empty text activates the native Gateway coalescer without repeating accumulated content.
\t\t\temitAgentEvent({
\t\t\t\trunId: ctx.params.runId,
\t\t\t\tstream: "assistant",
\t\t\t\tdata: pendingPhaseUiData
\t\t\t});
\t\t\tctx.params.onAgentEvent?.({
\t\t\t\tstream: "assistant",
\t\t\t\tdata: pendingPhaseUiData
\t\t\t});
\t\t\tctx.state.emittedAssistantUpdate = true;
\t\t}
\t\treturn;
\t} // ${PATCH_MARKER}`;

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

/** Patch Responses text deltas before their item phase becomes available. */
export function patchOpenClawAssistantLiveStreamContent(content, filePath = '<fixture>') {
  if (!content.includes('function handleMessageUpdate(ctx, evt)')) {
    return { content, changed: false, matched: false, insertedBlock: '' };
  }
  if (content.includes(PATCH_MARKER)) {
    return { content, changed: false, matched: true, insertedBlock: PENDING_PHASE_PATCH };
  }
  if (content.includes(PATCH_MARKER_V3)) {
    const count = countOccurrences(content, PENDING_PHASE_PATCH_V3);
    if (count !== 1) {
      throw new Error(
        `[openclaw-assistant-live-stream-patch] Expected one installed V3 patch in ${filePath}; found ${count}.`,
      );
    }
    return {
      content: content.replace(PENDING_PHASE_PATCH_V3, PENDING_PHASE_PATCH),
      changed: true,
      matched: true,
      insertedBlock: PENDING_PHASE_PATCH,
    };
  }
  if (content.includes(PATCH_MARKER_V2)) {
    const count = countOccurrences(content, PENDING_PHASE_PATCH_V2);
    if (count !== 1) {
      throw new Error(
        `[openclaw-assistant-live-stream-patch] Expected one installed V2 patch in ${filePath}; found ${count}.`,
      );
    }
    return {
      content: content.replace(PENDING_PHASE_PATCH_V2, PENDING_PHASE_PATCH),
      changed: true,
      matched: true,
      insertedBlock: PENDING_PHASE_PATCH,
    };
  }
  if (content.includes(PATCH_MARKER_V1)) {
    const count = countOccurrences(content, PENDING_PHASE_PATCH_V1);
    if (count !== 1) {
      throw new Error(
        `[openclaw-assistant-live-stream-patch] Expected one installed V1 patch in ${filePath}; found ${count}.`,
      );
    }
    return {
      content: content.replace(PENDING_PHASE_PATCH_V1, PENDING_PHASE_PATCH),
      changed: true,
      matched: true,
      insertedBlock: PENDING_PHASE_PATCH,
    };
  }

  const count = countOccurrences(content, PENDING_PHASE_ANCHOR);
  if (count !== 1) {
    throw new Error(
      `[openclaw-assistant-live-stream-patch] Expected one phase-pending Responses anchor in ${filePath}; found ${count}.`,
    );
  }
  return {
    content: content.replace(PENDING_PHASE_ANCHOR, PENDING_PHASE_PATCH),
    changed: true,
    matched: true,
    insertedBlock: PENDING_PHASE_PATCH,
  };
}

/** Apply the UI-only stream patch to one compatible OpenClaw runtime bundle. */
export function patchOpenClawAssistantLiveStreamRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-assistant-live-stream-patch] OpenClaw dist directory not found: ${distDir}`);
  }

  const targets = readdirSync(distDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => ({ file, filePath: join(distDir, file) }))
    .map((target) => ({
      ...target,
      result: patchOpenClawAssistantLiveStreamContent(readFileSync(target.filePath, 'utf8'), target.filePath),
    }))
    .filter(({ result }) => result.matched);

  if (targets.length !== 1) {
    throw new Error(
      `[openclaw-assistant-live-stream-patch] Expected one assistant message runtime; found ${targets.length}.`,
    );
  }

  const target = targets[0];
  if (target.result.changed && !dryRun) {
    writeFileSync(target.filePath, target.result.content, 'utf8');
  }
  logger.log?.(
    `[openclaw-assistant-live-stream-patch] ${target.result.changed ? (dryRun ? 'Dry-run matched' : 'Patched') : 'Already patched'}: ${target.file}`,
  );
  return {
    patchedFiles: target.result.changed ? 1 : 0,
    alreadyPatchedFiles: target.result.changed ? 0 : 1,
    targetFile: target.filePath,
  };
}

export function patchInstalledOpenClawAssistantLiveStreamRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawAssistantLiveStreamRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
