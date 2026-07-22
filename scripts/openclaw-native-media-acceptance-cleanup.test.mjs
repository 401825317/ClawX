import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __test,
  cleanupOpenClawNativeMediaAcceptanceContent,
} from './openclaw-native-media-acceptance-cleanup.mjs';

function patchedFixture() {
  return [
    'async function executeVideoGenerationJob() {',
    __test.ACCEPTANCE_PATCH,
    __test.RETURN_PATCH,
    '}',
    'function scheduleMediaGenerationTaskCompletion() {',
    __test.REPLY_PATCH,
    `const started = \`${__test.STARTED_PATCH}\`;`,
    __test.INTERNAL_PATCH,
    __test.WAKE_PATCH,
    __test.REPLY_PARAMS_PATCH,
    __test.TERMINAL_PATCH,
    '}',
  ].join('\n');
}

test('restores native OpenClaw media completion and removes semantic acceptance blocking', () => {
  const cleaned = cleanupOpenClawNativeMediaAcceptanceContent(patchedFixture());
  assert.equal(cleaned.changed, true);
  assert.equal(cleaned.category, 'media-runtime');
  assert.match(cleaned.content, new RegExp(__test.ACCEPTANCE_ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(cleaned.content, /status: "ok",\n\s*statusLabel: "completed successfully"/);
  assert.match(cleaned.content, /attachments,\n\s*contentText/);
  assert.doesNotMatch(cleaned.content, /UCLAW_NATIVE_MEDIA_ACCEPTANCE/);
  assert.doesNotMatch(cleaned.content, /acceptanceMismatches/);
  assert.doesNotMatch(cleaned.content, /acceptance: executed\.acceptance/);
  assert.doesNotMatch(cleaned.content, /terminalOutcome: "blocked"/);
  assert.doesNotMatch(cleaned.content, /params\.acceptance/);
});

test('keeps an already native media runtime unchanged', () => {
  const once = cleanupOpenClawNativeMediaAcceptanceContent(patchedFixture());
  const twice = cleanupOpenClawNativeMediaAcceptanceContent(once.content);
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once.content);
});

test('rejects a partially patched media runtime instead of shipping an invalid schema', () => {
  const partialFixture = [
    'async function executeVideoGenerationJob() {',
    'const acceptanceMismatches = [];',
    '}',
    'function scheduleMediaGenerationTaskCompletion() {',
    'const acceptance = params.acceptance;',
    'terminalResult: executed.terminalResult ?? terminalResult',
    '}',
  ].join('\n');
  assert.throws(
    () => cleanupOpenClawNativeMediaAcceptanceContent(partialFixture),
    /only partially removed: acceptanceMismatches, params\.acceptance, terminalResult: executed\.terminalResult \?\? terminalResult/,
  );
});

test('keeps the verified V3 terminal result contract', () => {
  const fixture = [
    'async function executeVideoGenerationJob() {}',
    'function scheduleMediaGenerationTaskCompletion() {',
    'const outputBlocked = executed.terminalResult?.terminalOutcome === "blocked";',
    'const summary = executed.terminalResult?.terminalSummary;',
    '}',
  ].join('\n');
  const cleaned = cleanupOpenClawNativeMediaAcceptanceContent(fixture);
  assert.equal(cleaned.changed, false);
  assert.equal(cleaned.content, fixture);
});

test('ignores unrelated OpenClaw bundles', () => {
  const result = cleanupOpenClawNativeMediaAcceptanceContent('const unrelated = true;');
  assert.equal(result.category, null);
  assert.equal(result.changed, false);
});
