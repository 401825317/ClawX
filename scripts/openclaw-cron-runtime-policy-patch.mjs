import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_NAME = 'openclaw-cron-runtime-policy-patch';

const CRON_TOOL_SIGNATURE = 'function createCronTool(opts, deps) {';
const CRON_SERVICE_SIGNATURE = 'const TRANSIENT_PATTERNS = {';
const CRON_TASK_RUNS_SIGNATURE = '/** Detached task-ledger integration for cron runs. */';

const TOOL_HELPER_MARKER = 'UCLAW_CRON_MODEL_TIMEOUT_SANITIZER_V1';
const TOOL_ADD_MARKER = 'UCLAW_CRON_MODEL_TIMEOUT_ADD_V1';
const TOOL_UPDATE_MARKER = 'UCLAW_CRON_MODEL_TIMEOUT_UPDATE_V1';
const DEADLINE_HELPER_MARKER = 'UCLAW_CRON_DEADLINE_CLASSIFIER_V1';
const RETRY_GUARD_MARKER = 'UCLAW_CRON_DEADLINE_NO_RETRY_V1';
const FAILURE_KIND_MARKER = 'UCLAW_CRON_DEADLINE_FAILURE_KIND_V1';
const SCHEDULED_LEDGER_MARKER = 'UCLAW_CRON_SCHEDULED_TIMEOUT_LEDGER_V1';
const MANUAL_LEDGER_MARKER = 'UCLAW_CRON_MANUAL_TIMEOUT_LEDGER_V1';
const TASK_RUN_HELPER_MARKER = 'UCLAW_CRON_TASK_RUN_DEADLINE_CLASSIFIER_V1';

const TOOL_MARKERS = [TOOL_HELPER_MARKER, TOOL_ADD_MARKER, TOOL_UPDATE_MARKER];
const SERVICE_MARKERS = [
  DEADLINE_HELPER_MARKER,
  RETRY_GUARD_MARKER,
  FAILURE_KIND_MARKER,
  MANUAL_LEDGER_MARKER,
];
const TASK_RUN_MARKERS = [TASK_RUN_HELPER_MARKER, SCHEDULED_LEDGER_MARKER];

const TOOL_HELPER_ANCHOR = `function isEmptyRecoveredCronPatch(value) {`;
const TOOL_HELPER_PATCH = `function isUclawCronToolRecord(value) {
\treturn value !== null && typeof value === "object" && !Array.isArray(value);
}
function stripUclawCronToolTimeoutSeconds(value) {
\tif (!isUclawCronToolRecord(value) || !isUclawCronToolRecord(value.payload)) return false;
\tif (!Object.hasOwn(value.payload, "timeoutSeconds")) return false;
\tdelete value.payload.timeoutSeconds;
\treturn true;
} // ${TOOL_HELPER_MARKER}
function isEmptyRecoveredCronPatch(value) {`;

const TOOL_ADD_ANCHOR = `\t\t\t\t\tconst job = normalizeCronJobCreate(canonicalJob, { sessionContext: { sessionKey: opts?.agentSessionKey } }) ?? canonicalJob;`;
const TOOL_ADD_PATCH = `\t\t\t\t\tconst job = normalizeCronJobCreate(canonicalJob, { sessionContext: { sessionKey: opts?.agentSessionKey } }) ?? canonicalJob;
\t\t\t\t\tstripUclawCronToolTimeoutSeconds(job); // ${TOOL_ADD_MARKER}`;

const TOOL_UPDATE_ANCHOR = `\t\t\t\t\tconst patch = normalizeCronJobPatch(canonicalPatch) ?? canonicalPatch;`;
const TOOL_UPDATE_PATCH = `\t\t\t\t\tconst patch = normalizeCronJobPatch(canonicalPatch) ?? canonicalPatch;
\t\t\t\t\tstripUclawCronToolTimeoutSeconds(patch); // ${TOOL_UPDATE_MARKER}`;
const DEADLINE_HELPER_ANCHOR = `/** Classifies cron execution errors against the configured retryable transient categories. */
function resolveCronExecutionRetryHint(error, retryOn, classifiedReason) {`;
const DEADLINE_HELPER_PATCH = `const UCLAW_CRON_JOB_TIMEOUT_PREFIX = "cron: job execution timed out";
function isUclawCronJobDeadlineError(error) {
\tif (typeof error !== "string") return false;
\treturn error.trim().replace(/^Error:\\s*/i, "").toLowerCase().startsWith(UCLAW_CRON_JOB_TIMEOUT_PREFIX);
} // ${DEADLINE_HELPER_MARKER}
/** Classifies cron execution errors against the configured retryable transient categories. */
function resolveCronExecutionRetryHint(error, retryOn, classifiedReason) {`;

const RETRY_GUARD_ANCHOR = `function resolveCronExecutionRetryHint(error, retryOn, classifiedReason) {
\tif (!error || typeof error !== "string") return { retryable: false };
\tconst keys = retryOn?.length ? retryOn : Object.keys(TRANSIENT_PATTERNS);`;
const RETRY_GUARD_PATCH = `function resolveCronExecutionRetryHint(error, retryOn, classifiedReason) {
\tif (!error || typeof error !== "string") return { retryable: false };
\tif (isUclawCronJobDeadlineError(error)) return { retryable: false, category: "timeout" }; // ${RETRY_GUARD_MARKER}
\tconst keys = retryOn?.length ? retryOn : Object.keys(TRANSIENT_PATTERNS);`;

const FAILURE_KIND_ANCHOR = `\tjob.state.lastErrorReason = result.status === "error" && typeof result.error === "string" ? resolveFailoverReasonFromError(result.error, result.provider) ?? void 0 : void 0;`;
const FAILURE_KIND_PATCH = `\tjob.state.lastErrorReason = result.status === "error" && typeof result.error === "string" ? isUclawCronJobDeadlineError(result.error) ? "timeout" : resolveFailoverReasonFromError(result.error, result.provider) ?? void 0 : void 0; // ${FAILURE_KIND_MARKER}`;

const MANUAL_LEDGER_ANCHOR = `\t\t\tstatus: normalizeCronRunErrorText(params.coreResult.error) === "cron: job execution timed out" ? "timed_out" : "failed",`;
const MANUAL_LEDGER_PATCH = `\t\t\tstatus: isUclawCronJobDeadlineError(normalizeCronRunErrorText(params.coreResult.error)) ? "timed_out" : "failed", // ${MANUAL_LEDGER_MARKER}`;

const TASK_RUN_HELPER_ANCHOR = `/** Completes or fails the detached task ledger row for a cron run when one exists. */
function tryFinishCronTaskRun(state, result) {`;
const TASK_RUN_HELPER_PATCH = `function isUclawCronTaskRunDeadlineError(error) {
\tif (typeof error !== "string") return false;
\treturn error.trim().replace(/^Error:\\s*/i, "").toLowerCase().startsWith("cron: job execution timed out");
} // ${TASK_RUN_HELPER_MARKER}
/** Completes or fails the detached task ledger row for a cron run when one exists. */
function tryFinishCronTaskRun(state, result) {`;

const SCHEDULED_LEDGER_ANCHOR = `\t\t\tstatus: normalizeCronRunErrorText(result.error) === timeoutErrorMessage() ? "timed_out" : "failed",`;
const SCHEDULED_LEDGER_PATCH = `\t\t\tstatus: isUclawCronTaskRunDeadlineError(normalizeCronRunErrorText(result.error)) ? "timed_out" : "failed", // ${SCHEDULED_LEDGER_MARKER}`;
function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function replaceUnique(content, search, replacement, label, filePath) {
  const count = countOccurrences(content, search);
  if (count !== 1) {
    throw new Error(`[${PATCH_NAME}] Expected exactly one ${label} anchor in ${filePath}; found ${count}.`);
  }
  return content.replace(search, replacement);
}

function hasAnyMarker(content, markers) {
  return markers.some((marker) => content.includes(marker));
}

function assertFullyPatched(content, markers, label, filePath) {
  for (const marker of markers) {
    const count = countOccurrences(content, marker);
    if (count !== 1) {
      throw new Error(`[${PATCH_NAME}] ${label} runtime is only partially patched in ${filePath}: ${marker} found ${count} time(s).`);
    }
  }
}

function patchCronToolContent(content, filePath) {
  if (!content.includes(CRON_TOOL_SIGNATURE)) return null;
  if (hasAnyMarker(content, TOOL_MARKERS)) {
    assertFullyPatched(content, TOOL_MARKERS, 'cron tool', filePath);
    return { content, changed: false, category: 'cron-tool' };
  }

  let patched = replaceUnique(content, TOOL_HELPER_ANCHOR, TOOL_HELPER_PATCH, 'cron timeout sanitizer helper', filePath);
  patched = replaceUnique(patched, TOOL_ADD_ANCHOR, TOOL_ADD_PATCH, 'cron add timeout sanitizer', filePath);
  patched = replaceUnique(patched, TOOL_UPDATE_ANCHOR, TOOL_UPDATE_PATCH, 'cron update timeout sanitizer', filePath);
  return { content: patched, changed: true, category: 'cron-tool' };
}

function patchCronServiceContent(content, filePath) {
  if (!content.includes(CRON_SERVICE_SIGNATURE)) return null;
  if (hasAnyMarker(content, SERVICE_MARKERS)) {
    assertFullyPatched(content, SERVICE_MARKERS, 'cron service', filePath);
    return { content, changed: false, category: 'cron-service' };
  }

  let patched = replaceUnique(content, DEADLINE_HELPER_ANCHOR, DEADLINE_HELPER_PATCH, 'cron deadline classifier', filePath);
  patched = replaceUnique(patched, RETRY_GUARD_ANCHOR, RETRY_GUARD_PATCH, 'cron deadline retry guard', filePath);
  patched = replaceUnique(patched, FAILURE_KIND_ANCHOR, FAILURE_KIND_PATCH, 'cron deadline failure kind', filePath);
  patched = replaceUnique(patched, MANUAL_LEDGER_ANCHOR, MANUAL_LEDGER_PATCH, 'manual cron timeout ledger', filePath);
  return { content: patched, changed: true, category: 'cron-service' };
}

function patchCronTaskRunsContent(content, filePath) {
  if (!content.includes(CRON_TASK_RUNS_SIGNATURE)) return null;
  if (hasAnyMarker(content, TASK_RUN_MARKERS)) {
    assertFullyPatched(content, TASK_RUN_MARKERS, 'cron task-runs', filePath);
    return { content, changed: false, category: 'cron-task-runs' };
  }

  let patched = replaceUnique(content, TASK_RUN_HELPER_ANCHOR, TASK_RUN_HELPER_PATCH, 'cron task-run deadline classifier', filePath);
  patched = replaceUnique(patched, SCHEDULED_LEDGER_ANCHOR, SCHEDULED_LEDGER_PATCH, 'scheduled cron timeout ledger', filePath);
  return { content: patched, changed: true, category: 'cron-task-runs' };
}
export function patchOpenClawCronRuntimePolicyContent(content, filePath = '<fixture>') {
  return patchCronToolContent(content, filePath)
    ?? patchCronServiceContent(content, filePath)
    ?? patchCronTaskRunsContent(content, filePath)
    ?? { content, changed: false, category: null };
}

export function patchOpenClawCronRuntimePolicyRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[${PATCH_NAME}] OpenClaw dist directory not found: ${distDir}`);
  }

  const targets = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => {
      const filePath = join(distDir, entry.name);
      const result = patchOpenClawCronRuntimePolicyContent(readFileSync(filePath, 'utf8'), filePath);
      return { filePath, result };
    })
    .filter(({ result }) => result.category);

  const cronToolTargets = targets.filter(({ result }) => result.category === 'cron-tool');
  const cronServiceTargets = targets.filter(({ result }) => result.category === 'cron-service');
  const cronTaskRunTargets = targets.filter(({ result }) => result.category === 'cron-task-runs');
  if (cronToolTargets.length !== 1 || cronServiceTargets.length !== 1 || cronTaskRunTargets.length !== 1) {
    throw new Error(
      `[${PATCH_NAME}] Expected one cron-tool, one cron-service, and one cron-task-runs runtime; found ${cronToolTargets.length}, ${cronServiceTargets.length}, and ${cronTaskRunTargets.length}.`,
    );
  }

  for (const target of targets) {
    if (target.result.changed && !dryRun) {
      writeFileSync(target.filePath, target.result.content, 'utf8');
    }
    logger.log?.(
      `[${PATCH_NAME}] ${target.result.changed ? (dryRun ? 'Dry-run matched' : 'Patched') : 'Already patched'}: ${target.filePath}`,
    );
  }

  return {
    patchedFiles: targets.filter(({ result }) => result.changed).length,
    alreadyPatchedFiles: targets.filter(({ result }) => !result.changed).length,
    cronToolFile: cronToolTargets[0].filePath,
    cronServiceFile: cronServiceTargets[0].filePath,
    cronTaskRunsFile: cronTaskRunTargets[0].filePath,
  };
}

export function patchInstalledOpenClawCronRuntimePolicy(cwd = process.cwd(), options = {}) {
  return patchOpenClawCronRuntimePolicyRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
