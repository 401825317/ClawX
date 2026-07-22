import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  patchOpenClawAssistantLiveStreamContent,
  patchOpenClawAssistantLiveStreamRuntime,
} from './openclaw-assistant-live-stream-patch.mjs';

const fixture = `function handleMessageUpdate(ctx, evt) {
\tconst chunk = resolveAssistantTextChunk({
\t\tevtType,
\t\tdelta,
\t\tcontent,
\t\taccumulatedText: ctx.state.deltaBuffer
\t});
\tconst isPhasePendingOpenAiResponsesTextItem = evtType !== "text_end" && !deliveryPhase && Boolean(streamItemId) && isOpenAiResponsesAssistantMessage(partialAssistant);
\tif (isPhasePendingOpenAiResponsesTextItem) return;
\tconst skipLiveStream = ctx.params.suppressLiveStreamOutput === true;
}`;

const v1PendingPhasePatch = `\tif (isPhasePendingOpenAiResponsesTextItem) {
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
\t} // UCLAW_OPENAI_RESPONSES_UI_STREAM_V1`;

const v2PendingPhasePatch = `\tif (isPhasePendingOpenAiResponsesTextItem) {
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
\t} // UCLAW_OPENAI_RESPONSES_UI_STREAM_V2`;

const v3PendingPhasePatch = `\tif (isPhasePendingOpenAiResponsesTextItem) {
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
\t} // UCLAW_OPENAI_RESPONSES_UI_STREAM_V3`;

test('streams phase-pending Responses text only through the Agent/UI event path', () => {
  const patched = patchOpenClawAssistantLiveStreamContent(fixture, 'selection.js');

  assert.equal(patched.changed, true);
  assert.equal(patched.matched, true);
  assert.match(patched.content, /UCLAW_OPENAI_RESPONSES_UI_STREAM_V4/u);
  assert.match(patched.content, /ctx\.state\.deltaBuffer \+= chunk/u);
  assert.match(patched.content, /text: ""/u);
  assert.match(patched.content, /itemId: streamItemId/u);
  assert.match(patched.content, /delta: chunk/u);
  assert.match(patched.content, /emitAgentEvent\(\{/u);
  assert.match(patched.content, /ctx\.params\.onAgentEvent\?\.\(\{/u);
  assert.doesNotMatch(patched.insertedBlock, /text: ctx\.state\.deltaBuffer/u);
  assert.doesNotMatch(patched.insertedBlock, /buildAssistantStreamData/u);
  assert.doesNotMatch(patched.insertedBlock, /ctx\.emitAssistantStreamData/u);
  assert.doesNotMatch(patched.insertedBlock, /appendBlockReplyChunk/u);
  assert.doesNotMatch(patched.insertedBlock, /onPartialReply/u);

  const idempotent = patchOpenClawAssistantLiveStreamContent(patched.content, 'selection.js');
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.matched, true);
});

test('migrates an installed V1 phase-pending stream patch to V4', () => {
  const v1Content = fixture.replace(
    '\tif (isPhasePendingOpenAiResponsesTextItem) return;',
    v1PendingPhasePatch,
  );

  const migrated = patchOpenClawAssistantLiveStreamContent(v1Content, 'selection.js');

  assert.equal(migrated.changed, true);
  assert.equal(migrated.matched, true);
  assert.doesNotMatch(migrated.content, /UCLAW_OPENAI_RESPONSES_UI_STREAM_V1/u);
  assert.match(migrated.content, /UCLAW_OPENAI_RESPONSES_UI_STREAM_V4/u);
  assert.doesNotMatch(migrated.insertedBlock, /ctx\.emitAssistantStreamData/u);

  const idempotent = patchOpenClawAssistantLiveStreamContent(migrated.content, 'selection.js');
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.matched, true);
});

test('migrates an installed cumulative-text V2 patch to throttled-delta V4', () => {
  const v2Content = fixture.replace(
    '\tif (isPhasePendingOpenAiResponsesTextItem) return;',
    v2PendingPhasePatch,
  );

  const migrated = patchOpenClawAssistantLiveStreamContent(v2Content, 'selection.js');

  assert.equal(migrated.changed, true);
  assert.equal(migrated.matched, true);
  assert.doesNotMatch(migrated.content, /UCLAW_OPENAI_RESPONSES_UI_STREAM_V2/u);
  assert.match(migrated.content, /UCLAW_OPENAI_RESPONSES_UI_STREAM_V4/u);
  assert.doesNotMatch(migrated.insertedBlock, /text: ctx\.state\.deltaBuffer/u);
  assert.doesNotMatch(migrated.insertedBlock, /buildAssistantStreamData/u);

  const idempotent = patchOpenClawAssistantLiveStreamContent(migrated.content, 'selection.js');
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.matched, true);
});

test('migrates an installed delta-only V3 patch to throttled-delta V4', () => {
  const v3Content = fixture.replace(
    '\tif (isPhasePendingOpenAiResponsesTextItem) return;',
    v3PendingPhasePatch,
  );

  const migrated = patchOpenClawAssistantLiveStreamContent(v3Content, 'selection.js');

  assert.equal(migrated.changed, true);
  assert.equal(migrated.matched, true);
  assert.doesNotMatch(migrated.content, /UCLAW_OPENAI_RESPONSES_UI_STREAM_V3/u);
  assert.match(migrated.content, /UCLAW_OPENAI_RESPONSES_UI_STREAM_V4/u);
  assert.match(migrated.insertedBlock, /text: ""/u);
  assert.doesNotMatch(migrated.insertedBlock, /text: ctx\.state\.deltaBuffer/u);

  const idempotent = patchOpenClawAssistantLiveStreamContent(migrated.content, 'selection.js');
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.matched, true);
});

test('patches exactly one compatible OpenClaw assistant runtime', () => {
  const distDir = mkdtempSync(join(tmpdir(), 'uclaw-assistant-live-stream-'));
  const targetFile = join(distDir, 'selection-fixture.js');
  writeFileSync(targetFile, fixture, 'utf8');
  writeFileSync(join(distDir, 'unrelated.js'), 'export const value = 1;', 'utf8');

  const first = patchOpenClawAssistantLiveStreamRuntime(distDir, { logger: { log() {} } });
  assert.equal(first.patchedFiles, 1);
  assert.match(readFileSync(targetFile, 'utf8'), /UCLAW_OPENAI_RESPONSES_UI_STREAM_V4/u);

  const second = patchOpenClawAssistantLiveStreamRuntime(distDir, { logger: { log() {} } });
  assert.equal(second.patchedFiles, 0);
  assert.equal(second.alreadyPatchedFiles, 1);
});
