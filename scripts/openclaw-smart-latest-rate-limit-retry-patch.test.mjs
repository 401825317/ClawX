import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  patchInstalledOpenClawSmartLatestRateLimitRetryRuntime,
  patchOpenClawSmartLatestRateLimitRetryContent,
} from './openclaw-smart-latest-rate-limit-retry-patch.mjs';

const fixture = `function sameModelCandidate(a, b) {
\treturn a.provider === b.provider && a.model === b.model;
}
function isCliAgentRuntime(runtime, cfg) {
\treturn Boolean(runtime || cfg);
}
async function runWithModelFallback(params) {
\tif (candidates.length === 0) throw new Error("No model configured.");
\tconst attempts = [];
\tlet lastError;
\tlet latestClassifiedResult;
\tlet exhaustionResult;
\tfor (let i = 0; i < candidates.length; i += 1) {
\t\tconst candidate = candidates[i];
\t\tconst attemptRun = await runFallbackAttempt({
\t\t\trun: params.run,
\t\t\t...candidate,
\t\t\tattempts,
\t\t\toptions: { isFinalFallbackAttempt: i + 1 === candidates.length },
\t\t\tdeferSessionSuspension: i + 1 < candidates.length,
\t\t\tonDeferredSessionSuspension: () => {},
\t\t\tclassifyResult: params.classifyResult,
\t\t\tattempt: i + 1,
\t\t\ttotal: candidates.length,
\t\t\tattribution: { sessionId: params.sessionId, lane: params.lane },
\t\t\tabortSignal: params.abortSignal
\t\t});
\t\tif ("success" in attemptRun) {
\t\t\treturn attemptRun.success;
\t\t}
\t\tconst err = attemptRun.error;
\t\tif (attemptRun.classifiedResult) latestClassifiedResult = attemptRun.classifiedResult;
\t\tif (attemptRun.exhaustionResult && (!exhaustionResult || attemptRun.exhaustionResult.priority >= exhaustionResult.priority)) exhaustionResult = attemptRun.exhaustionResult;
\t\t{
\t\t\tif (isNonProviderRuntimeCoordinationError(err)) throw err;
\t\t\tif (isLikelyContextOverflowError(formatErrorMessage(err))) throw err;
\t\t}
\t}
}
async function runWithImageModelFallback(params) {
\treturn params.run();
}`;

test('patches smart-latest rate-limit retry into OpenClaw fallback runtime', () => {
  const patched = patchOpenClawSmartLatestRateLimitRetryContent(fixture, 'model-fallback.js');
  assert.equal(patched.matched, true);
  assert.equal(patched.changed, true);
  assert.match(patched.content, /UCLAW_SMART_LATEST_RATE_LIMIT_RETRY_V1/);
  assert.match(patched.content, /candidate\.model === "smart-latest"/);
  assert.match(patched.content, /isSmartLatestRateLimitRetryError\(err\)/);
  assert.match(patched.content, /let attemptRun = await runFallbackAttempt/);
  assert.match(patched.content, /let err = attemptRun\.error;/);
});

test('runtime patch is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-smart-latest-rate-limit-retry-'));
  try {
    const dist = join(dir, 'node_modules', 'openclaw', 'dist');
    const file = join(dist, 'model-fallback.js');
    mkdirSync(dist, { recursive: true });
    writeFileSync(file, fixture, 'utf8');

    const first = patchInstalledOpenClawSmartLatestRateLimitRetryRuntime(dir, { logger: { log() {} } });
    assert.equal(first.matchedFiles, 1);
    assert.equal(first.patchedFiles, 1);
    assert.match(readFileSync(file, 'utf8'), /UCLAW_SMART_LATEST_RATE_LIMIT_RETRY_V1/);

    const second = patchInstalledOpenClawSmartLatestRateLimitRetryRuntime(dir, { logger: { log() {} } });
    assert.equal(second.matchedFiles, 1);
    assert.equal(second.patchedFiles, 0);
    assert.equal(second.alreadyPatchedFiles, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
