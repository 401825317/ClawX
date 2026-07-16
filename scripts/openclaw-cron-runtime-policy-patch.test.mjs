import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  patchOpenClawCronRuntimePolicyContent,
  patchOpenClawCronRuntimePolicyRuntime,
} from './openclaw-cron-runtime-policy-patch.mjs';

const cronToolFixture = `
function isEmptyRecoveredCronPatch(value) {
\treturn false;
}
function createCronTool(opts, deps) {
\treturn {
\t\texecute: async (_toolCallId, args) => {
\t\t\tconst params = args;
\t\t\tswitch (params.action) {
\t\t\t\tcase "add": {
\t\t\t\t\tconst canonicalJob = params.job;
\t\t\t\t\tconst job = normalizeCronJobCreate(canonicalJob, { sessionContext: { sessionKey: opts?.agentSessionKey } }) ?? canonicalJob;
\t\t\t\t\tcapCronAgentTurnJobToolsAllow(job, opts?.creatorToolAllowlist);
\t\t\t\t\treturn callGateway("cron.add", {}, job);
\t\t\t\t}
\t\t\t\tcase "update": {
\t\t\t\t\tconst canonicalPatch = params.patch;
\t\t\t\t\tconst recoveredFlatPatch = false;
\t\t\t\t\tconst patch = normalizeCronJobPatch(canonicalPatch) ?? canonicalPatch;
\t\t\t\t\tif (recoveredFlatPatch && isEmptyRecoveredCronPatch(patch)) throw new Error("patch required");
\t\t\t\t\treturn callGateway("cron.update", {}, { id: params.id, patch });
\t\t\t\t}
\t\t\t}
\t\t}
\t};
}`;

const cronServiceFixture = `
const TRANSIENT_PATTERNS = {
\ttimeout: /(timeout|timed out)/i,
\tnetwork: /fetch failed/i
};
/** Classifies cron execution errors against the configured retryable transient categories. */
function resolveCronExecutionRetryHint(error, retryOn, classifiedReason) {
\tif (!error || typeof error !== "string") return { retryable: false };
\tconst keys = retryOn?.length ? retryOn : Object.keys(TRANSIENT_PATTERNS);
\tconst classified = classifiedReason ?? void 0;
\tif (classified && keys.includes(classified)) return { retryable: true, category: classified };
\tfor (const key of keys) if (TRANSIENT_PATTERNS[key]?.test(error)) return { retryable: true, category: key };
\treturn { retryable: false };
}
function applyJobResult(state, job, result) {
\tjob.state.lastErrorReason = result.status === "error" && typeof result.error === "string" ? resolveFailoverReasonFromError(result.error, result.provider) ?? void 0 : void 0;
}
function tryFinishCronTaskRun(state, result) {
\tfailTaskRunByRunId({
\t\trunId: result.taskRunId,
\t\truntime: "cron",
\t\t\tstatus: normalizeCronRunErrorText(result.error) === timeoutErrorMessage() ? "timed_out" : "failed",
\t\tendedAt: result.endedAt
\t});
}
function tryFinishManualTaskRun(state, params) {
\tfailTaskRunByRunId({
\t\trunId: params.taskRunId,
\t\truntime: "cron",
\t\t\tstatus: normalizeCronRunErrorText(params.coreResult.error) === "cron: job execution timed out" ? "timed_out" : "failed",
\t\tendedAt: params.endedAt
\t});
}`;

function loadSanitizer(content) {
  const match = content.match(/function stripUclawCronToolTimeoutSeconds\(value\) \{[\s\S]*?\n\}/u);
  assert.ok(match, 'cron timeout sanitizer helper must be present');
  return Function('isRecord$1', `${match[0]}\nreturn stripUclawCronToolTimeoutSeconds;`)(
    (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value)),
  );
}

test('model cron add/update calls strip only payload.timeoutSeconds', () => {
  const result = patchOpenClawCronRuntimePolicyContent(cronToolFixture, 'openclaw-tools.js');
  assert.equal(result.changed, true);
  assert.equal(result.category, 'cron-tool');
  assert.match(result.content, /UCLAW_CRON_MODEL_TIMEOUT_SANITIZER_V1/u);
  assert.match(result.content, /stripUclawCronToolTimeoutSeconds\(job\); \/\/ UCLAW_CRON_MODEL_TIMEOUT_ADD_V1/u);
  assert.match(result.content, /stripUclawCronToolTimeoutSeconds\(patch\); \/\/ UCLAW_CRON_MODEL_TIMEOUT_UPDATE_V1/u);

  const sanitize = loadSanitizer(result.content);
  const job = { payload: { kind: 'agentTurn', message: 'do work', timeoutSeconds: 300 } };
  assert.equal(sanitize(job), true);
  assert.deepEqual(job, { payload: { kind: 'agentTurn', message: 'do work' } });
  assert.equal(sanitize(job), false);
  assert.equal(sanitize({ payload: { timeoutSeconds: 0 } }), true);
  assert.equal(sanitize({ payload: { kind: 'agentTurn' } }), false);
  assert.equal(patchOpenClawCronRuntimePolicyContent(result.content, 'openclaw-tools.js').changed, false);
});

test('deadline errors with phase text are non-transient and retain timeout classification', () => {
  const result = patchOpenClawCronRuntimePolicyContent(cronServiceFixture, 'server-cron.js');
  assert.equal(result.changed, true);
  assert.equal(result.category, 'cron-service');
  assert.match(result.content, /UCLAW_CRON_DEADLINE_CLASSIFIER_V1/u);
  assert.match(result.content, /UCLAW_CRON_DEADLINE_NO_RETRY_V1/u);
  assert.match(result.content, /UCLAW_CRON_DEADLINE_FAILURE_KIND_V1/u);
  assert.equal((result.content.match(/isUclawCronJobDeadlineError\(normalizeCronRunErrorText\(/gu) ?? []).length, 2);

  const resolveRetryHint = Function(`${result.content}\nreturn resolveCronExecutionRetryHint;`)();
  assert.deepEqual(
    resolveRetryHint('cron: job execution timed out (last phase: model_call_started)', ['timeout'], 'timeout'),
    { retryable: false, category: 'timeout' },
  );
  assert.deepEqual(
    resolveRetryHint('Error: cron: job execution timed out (last phase: tool_execution_started)', ['timeout'], 'timeout'),
    { retryable: false, category: 'timeout' },
  );
  assert.deepEqual(resolveRetryHint('fetch timed out', ['timeout']), { retryable: true, category: 'timeout' });
  assert.deepEqual(resolveRetryHint('cron: isolated agent setup timed out before runner start', ['timeout']), { retryable: true, category: 'timeout' });
  assert.equal(patchOpenClawCronRuntimePolicyContent(result.content, 'server-cron.js').changed, false);
});

test('phase-aware deadline errors remain timed_out in scheduled and manual task ledgers', () => {
  const result = patchOpenClawCronRuntimePolicyContent(cronServiceFixture, 'server-cron.js');
  const failures = [];
  const [finishScheduled, finishManual] = Function(
    'failTaskRunByRunId',
    'normalizeCronRunErrorText',
    'timeoutErrorMessage',
    'resolveFailoverReasonFromError',
    `${result.content}\nreturn [tryFinishCronTaskRun, tryFinishManualTaskRun];`,
  )(
    (entry) => failures.push(entry),
    (error) => error,
    () => 'cron: job execution timed out',
    () => undefined,
  );

  finishScheduled({ deps: { log: { warn() {} } } }, {
    taskRunId: 'scheduled',
    error: 'cron: job execution timed out (last phase: model_call_started)',
    endedAt: 1,
  });
  finishManual({ deps: { log: { warn() {} } } }, {
    taskRunId: 'manual',
    coreResult: { error: 'cron: job execution timed out (last phase: tool_execution_started)' },
    endedAt: 2,
  });
  assert.deepEqual(failures.map((entry) => entry.status), ['timed_out', 'timed_out']);
});

test('runtime patch is fail-closed and idempotent across cron tool and service chunks', () => {
  const distDir = mkdtempSync(join(tmpdir(), 'uclaw-cron-runtime-policy-'));
  const toolFile = join(distDir, 'openclaw-tools.js');
  const serviceFile = join(distDir, 'server-cron.js');
  writeFileSync(toolFile, cronToolFixture, 'utf8');
  writeFileSync(serviceFile, cronServiceFixture, 'utf8');
  writeFileSync(join(distDir, 'unrelated.js'), 'export const untouched = true;', 'utf8');

  const first = patchOpenClawCronRuntimePolicyRuntime(distDir, { logger: { log() {} } });
  assert.equal(first.patchedFiles, 2);
  assert.match(readFileSync(toolFile, 'utf8'), /UCLAW_CRON_MODEL_TIMEOUT_ADD_V1/u);
  assert.match(readFileSync(serviceFile, 'utf8'), /UCLAW_CRON_DEADLINE_NO_RETRY_V1/u);

  const second = patchOpenClawCronRuntimePolicyRuntime(distDir, { logger: { log() {} } });
  assert.equal(second.patchedFiles, 0);
  assert.equal(second.alreadyPatchedFiles, 2);
});

test('runtime patch rejects partial and missing cron targets', () => {
  const partiallyPatched = cronToolFixture.replace(
    'function isEmptyRecoveredCronPatch(value) {',
    'function isEmptyRecoveredCronPatch(value) { // UCLAW_CRON_MODEL_TIMEOUT_SANITIZER_V1',
  );
  assert.throws(
    () => patchOpenClawCronRuntimePolicyContent(partiallyPatched, 'partial-tools.js'),
    /only partially patched/u,
  );

  const distDir = mkdtempSync(join(tmpdir(), 'uclaw-cron-runtime-policy-missing-'));
  writeFileSync(join(distDir, 'openclaw-tools.js'), cronToolFixture, 'utf8');
  assert.throws(
    () => patchOpenClawCronRuntimePolicyRuntime(distDir, { logger: { log() {} } }),
    /found 1 and 0/u,
  );
});

test('current installed OpenClaw runtime matches all fail-closed cron policy anchors', () => {
  const result = patchOpenClawCronRuntimePolicyRuntime(
    join(process.cwd(), 'node_modules', 'openclaw', 'dist'),
    { dryRun: true, logger: { log() {} } },
  );
  assert.equal(result.patchedFiles + result.alreadyPatchedFiles, 2);
});
