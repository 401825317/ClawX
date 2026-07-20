import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  __test,
  patchOpenClawVideoActualSpecContent,
  patchOpenClawVideoActualSpecRuntime,
  resolveOpenClawVideoMediaServices,
} from './openclaw-video-actual-spec-patch.mjs';

const mediaServices = {
  fileName: 'media-services-test.js',
  runFfprobeExport: 'l',
  probeVideoDimensionsExport: 'n',
};

function fixture() {
  return [
    'import { something } from "./somewhere.js";',
    'function scheduleMediaGenerationTaskCompletion(params) {',
    'params.lifecycle.completeTaskRun({',
    '\t\t\t\thandle: params.handle,',
    '\t\t\t\tprovider: executed.provider,',
    '\t\t\t\tmodel: executed.model,',
    '\t\t\t\tcount: executed.count,',
    __test.ASYNC_TERMINAL_ANCHOR,
    '}',
    __test.EXECUTE_ANCHOR,
    '\tconst result = { normalization: {}, metadata: {}, ignoredOverrides: [], videos: [] };',
    '\tconst urlOnlyVideos = [];',
    '\tconst bufferVideos = [];',
    __test.SAVE_ANCHOR,
    '\tconst requestedDurationSeconds = params.durationSeconds;',
    '\tconst ignoredOverrides = result.ignoredOverrides ?? [];',
    '\tconst ignoredOverrideKeys = new Set(ignoredOverrides.map((entry) => entry.key));',
    '\tconst warning = void 0;',
    '\tconst normalizedDurationSeconds = requestedDurationSeconds;',
    '\tconst normalizedSize = params.size;',
    '\tconst normalizedAspectRatio = params.aspectRatio;',
    '\tconst normalizedResolution = params.resolution;',
    __test.SPECIFICATION_ANCHOR,
    '\tconst attachments = [];',
    '\tconst lines = [',
    __test.LINES_ANCHOR,
    '\t];',
    '\treturn {',
    __test.DETAILS_ANCHOR,
    '\t\t\t}',
    '\t\t};',
    '}',
    'function syncVideo() {',
    '\t\t\t\tcompleteVideoGenerationTaskRun({',
    '\t\t\t\t\thandle: taskHandle,',
    '\t\t\t\t\tprovider: executed.provider,',
    '\t\t\t\t\tmodel: executed.model,',
    __test.SYNC_TERMINAL_ANCHOR,
    '}',
  ].join('\n');
}

test('patches actual video specification, non-blocking probes, differences, and task summaries', () => {
  const result = patchOpenClawVideoActualSpecContent(fixture(), { mediaServices });
  assert.equal(result.matched, true);
  assert.equal(result.changed, true);
  assert.match(result.content, /UCLAW_VIDEO_ACTUAL_SPEC_V1/);
  assert.match(result.content, /runFfprobeUClawVideoActualSpec/);
  assert.match(result.content, /probeVideoDimensionsUClawVideoActualSpec/);
  assert.match(result.content, /\/usr\/bin\/avmediainfo/);
  assert.match(result.content, /specificationDifferences/);
  assert.match(result.content, /specification,/);
  assert.match(result.content, /actual: \{ outputs: actualOutputs \}/);
  assert.match(result.content, /translated to size/);
  assert.match(result.content, /translation: translatedSpecification/);
  assert.match(result.content, /aspect ratio target/);
  assert.match(result.content, /terminalSummary: executed\.contentText/);
  assert.match(result.content, /terminalResult: terminalResult \?\?/);
  assert.doesNotMatch(result.content, /terminalOutcome: "blocked"/);

  const second = patchOpenClawVideoActualSpecContent(result.content, { mediaServices });
  assert.equal(second.changed, false);
  assert.equal(second.content, result.content);
});

test('keeps actual video specification compatible with the native media completion contract', () => {
  const completionFixture = fixture()
    .replace(
      'import { something } from "./somewhere.js";',
      'const UCLAW_NATIVE_MEDIA_COMPLETION_CONTRACT_V2 = true;\nimport { something } from "./somewhere.js";',
    )
    .replace(
      __test.ASYNC_TERMINAL_ANCHOR,
      '\t\t\t\tpaths: executed.paths,\n\t\t\t\tterminalResult: { terminalSummary: [executed.contentText, artifactContract].join("\\n") }\n\t\t\t});',
    );
  const result = patchOpenClawVideoActualSpecContent(completionFixture, { mediaServices });
  assert.equal(result.changed, true);
  assert.match(result.content, /UCLAW_VIDEO_ACTUAL_SPEC_V1/u);
  assert.match(result.content, /terminalSummary: \[executed\.contentText, artifactContract\]/u);
  assert.match(result.content, /terminalResult: \{ terminalSummary: executed\.contentText \}/u);
});

test('parses macOS avmediainfo dimensions, duration, and audio in the injected helper', () => {
  const helperSource = `${__test.parseGeneratedVideoAvMediaInfoSource}\nexport { parseGeneratedVideoAvMediaInfoUClaw };`;
  const helperUrl = `data:text/javascript;base64,${Buffer.from(helperSource).toString('base64')}`;
  return import(helperUrl).then(({ parseGeneratedVideoAvMediaInfoUClaw }) => {
    const parsed = parseGeneratedVideoAvMediaInfoUClaw([
      'Asset: /tmp/test.mp4',
      'Duration: 8.042 seconds (8042/1000)',
      'Track count: 2',
      "Track 1: Video 'vide'",
      '\tDimensions: 480 x 848',
      "Track 2: Sound 'soun'",
    ].join('\n'));
    assert.deepEqual(parsed, {
      width: 480,
      height: 848,
      size: '480x848',
      durationSeconds: 8.042,
      hasAudio: true,
    });
  });
});

test('resolves hashed media-services export aliases and patches one runtime file', () => {
  const root = mkdtempSync(join(tmpdir(), 'uclaw-video-actual-spec-'));
  writeFileSync(join(root, 'media-services-abc.js'), [
    'function runFfprobe() {}',
    'async function probeVideoDimensions() {}',
    'export { runFfprobe as l, probeVideoDimensions as n };',
  ].join('\n'));
  writeFileSync(join(root, 'openclaw-tools-abc.js'), fixture());

  assert.deepEqual(resolveOpenClawVideoMediaServices(root), {
    fileName: 'media-services-abc.js',
    runFfprobeExport: 'l',
    probeVideoDimensionsExport: 'n',
  });
  const first = patchOpenClawVideoActualSpecRuntime(root, { logger: { log() {} } });
  assert.deepEqual(first, { matchedFiles: 1, patchedFiles: 1, alreadyPatchedFiles: 0 });
  assert.match(readFileSync(join(root, 'openclaw-tools-abc.js'), 'utf8'), /UCLAW_VIDEO_ACTUAL_SPEC_V1/);
  const second = patchOpenClawVideoActualSpecRuntime(root, { logger: { log() {} } });
  assert.deepEqual(second, { matchedFiles: 1, patchedFiles: 0, alreadyPatchedFiles: 1 });
});

test('rejects drifted native anchors instead of silently shipping a partial patch', () => {
  const drifted = fixture().replace(__test.SAVE_ANCHOR, 'const changedSaveLoop = true;');
  assert.throws(
    () => patchOpenClawVideoActualSpecContent(drifted, { mediaServices }),
    /Expected exactly one video save loop anchor; found 0/,
  );
});

test('ignores unrelated bundles', () => {
  const result = patchOpenClawVideoActualSpecContent('const unrelated = true;', { mediaServices });
  assert.equal(result.matched, false);
  assert.equal(result.changed, false);
});
