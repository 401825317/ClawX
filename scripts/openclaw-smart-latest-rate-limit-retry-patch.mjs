import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_NAME = 'openclaw-smart-latest-rate-limit-retry-patch';
const PATCH_MARKER = 'UCLAW_SMART_LATEST_RATE_LIMIT_RETRY_V1';

const SAME_MODEL_ANCHOR = `function sameModelCandidate(a, b) {
\treturn a.provider === b.provider && a.model === b.model;
}
function isCliAgentRuntime(runtime, cfg) {`;
const SAME_MODEL_PATCH = `function sameModelCandidate(a, b) {
\treturn a.provider === b.provider && a.model === b.model;
}
const ${PATCH_MARKER} = true;
function isSmartLatestRateLimitRetryError(err) {
\tconst reason = describeFailoverError(err).reason;
\tif (reason === "rate_limit") return true;
\tconst message = formatErrorMessage(err).toLowerCase();
\treturn message.includes("rate limit") || message.includes("too many requests") || /\\b429\\b/.test(message);
}
function isCliAgentRuntime(runtime, cfg) {`;

const MODEL_FUNCTION_START = 'function runWithModelFallback(params) {';
const IMAGE_FUNCTION_START = 'async function runWithImageModelFallback(params) {';

const RETRY_INSERT_ANCHOR = `\t\tif (attemptRun.exhaustionResult && (!exhaustionResult || attemptRun.exhaustionResult.priority >= exhaustionResult.priority)) exhaustionResult = attemptRun.exhaustionResult;\n\t\t{\n\t\t\tif (isNonProviderRuntimeCoordinationError(err)) throw err;`;
const RETRY_INSERT_PATCH = `\t\tif (attemptRun.exhaustionResult && (!exhaustionResult || attemptRun.exhaustionResult.priority >= exhaustionResult.priority)) exhaustionResult = attemptRun.exhaustionResult;\n\t\tif (candidate.model === "smart-latest" && isSmartLatestRateLimitRetryError(err)) {\n\t\t\tawait observeFailedCandidate({\n\t\t\t\tattempts,\n\t\t\t\tcandidate,\n\t\t\t\terror: err,\n\t\t\t\trunId: params.runId,\n\t\t\t\tsessionId: params.sessionId,\n\t\t\t\tlane: params.lane,\n\t\t\t\trequestedProvider: params.provider,\n\t\t\t\trequestedModel: params.model,\n\t\t\t\tattempt: i + 1,\n\t\t\t\ttotal: candidates.length,\n\t\t\t\tnextCandidate: candidates[i + 1],\n\t\t\t\tisPrimary,\n\t\t\t\trequestedModelMatched: requestedModel,\n\t\t\t\tfallbackConfigured: hasFallbackCandidates\n\t\t\t});\n\t\t\tconst retryAttemptRun = await runFallbackAttempt({\n\t\t\t\trun: params.run,\n\t\t\t\t...candidate,\n\t\t\t\tattempts,\n\t\t\t\toptions: {\n\t\t\t\t\t...runOptions,\n\t\t\t\t\tisFinalFallbackAttempt: i + 1 === candidates.length\n\t\t\t\t},\n\t\t\t\tdeferSessionSuspension: i + 1 < candidates.length,\n\t\t\t\tonDeferredSessionSuspension: (suspension) => {\n\t\t\t\t\tdeferredSuspension.pending = suspension;\n\t\t\t\t},\n\t\t\t\tclassifyResult: params.classifyResult,\n\t\t\t\tattempt: i + 1,\n\t\t\t\ttotal: candidates.length,\n\t\t\t\tattribution: {\n\t\t\t\t\tsessionId: params.sessionId,\n\t\t\t\t\tlane: params.lane\n\t\t\t\t},\n\t\t\t\tabortSignal: params.abortSignal\n\t\t\t});\n\t\t\tif ("success" in retryAttemptRun) {\n\t\t\t\tif (i > 0 || attempts.length > 0 || attemptedDuringCooldown) await observeDecision({\n\t\t\t\t\tdecision: "candidate_succeeded",\n\t\t\t\t\trunId: params.runId,\n\t\t\t\t\tsessionId: params.sessionId,\n\t\t\t\t\tlane: params.lane,\n\t\t\t\t\trequestedProvider: params.provider,\n\t\t\t\t\trequestedModel: params.model,\n\t\t\t\t\tcandidate,\n\t\t\t\t\tattempt: i + 1,\n\t\t\t\t\ttotal: candidates.length,\n\t\t\t\t\tpreviousAttempts: attempts,\n\t\t\t\t\tisPrimary,\n\t\t\t\t\trequestedModelMatched: requestedModel,\n\t\t\t\t\tfallbackConfigured: hasFallbackCandidates\n\t\t\t\t});\n\t\t\t\tconst notFoundAttempt = i > 0 ? attempts.find((a) => a.reason === "model_not_found") : void 0;\n\t\t\t\tif (notFoundAttempt) log.warn('Model "' + sanitizeForLog(notFoundAttempt.provider) + '/' + sanitizeForLog(notFoundAttempt.model) + '" not found. Fell back to "' + sanitizeForLog(candidate.provider) + '/' + sanitizeForLog(candidate.model) + '".');\n\t\t\t\treturn retryAttemptRun.success;\n\t\t\t}\n\t\t\tattemptRun = retryAttemptRun;\n\t\t\terr = attemptRun.error;\n\t\t\tif (attemptRun.classifiedResult) latestClassifiedResult = attemptRun.classifiedResult;\n\t\t\tif (attemptRun.exhaustionResult && (!exhaustionResult || attemptRun.exhaustionResult.priority >= exhaustionResult.priority)) exhaustionResult = attemptRun.exhaustionResult;\n\t\t}\n\t\t{\n\t\t\tif (isNonProviderRuntimeCoordinationError(err)) throw err;`;

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

export function patchOpenClawSmartLatestRateLimitRetryContent(content, filePath = '<fixture>') {
  if (!content.includes(MODEL_FUNCTION_START) || !content.includes(IMAGE_FUNCTION_START)) {
    return { content, changed: false, matched: false };
  }
  if (content.includes(PATCH_MARKER)) {
    return { content, changed: false, matched: true };
  }

  let patchedContent = replaceUnique(content, SAME_MODEL_ANCHOR, SAME_MODEL_PATCH, 'same-model helper', filePath);
  const modelStart = patchedContent.indexOf(MODEL_FUNCTION_START);
  const imageStart = patchedContent.indexOf(IMAGE_FUNCTION_START, modelStart + MODEL_FUNCTION_START.length);
  if (imageStart === -1) {
    return { content, changed: false, matched: false };
  }

  const prefix = patchedContent.slice(0, modelStart);
  const modelSection = patchedContent.slice(modelStart, imageStart);
  const suffix = patchedContent.slice(imageStart);

  let patchedModel = replaceUnique(modelSection, 'const attemptRun = await runFallbackAttempt({', 'let attemptRun = await runFallbackAttempt({', 'fallback attempt declaration', filePath);
  patchedModel = replaceUnique(patchedModel, 'const err = attemptRun.error;', 'let err = attemptRun.error;', 'fallback error declaration', filePath);
  patchedModel = replaceUnique(patchedModel, RETRY_INSERT_ANCHOR, RETRY_INSERT_PATCH, 'smart-latest retry block', filePath);
  return { content: `${prefix}${patchedModel}${suffix}`, changed: true, matched: true };
}

export function patchOpenClawSmartLatestRateLimitRetryRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[${PATCH_NAME}] OpenClaw dist directory not found: ${distDir}`);
  }

  let matchedFiles = 0;
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawSmartLatestRateLimitRetryContent(content, filePath);
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
    throw new Error(`[${PATCH_NAME}] Expected one OpenClaw model fallback runtime file; found ${matchedFiles}.`);
  }
  logger.log?.(
    `[${PATCH_NAME}] ${dryRun ? 'Dry-run matched' : 'Patched'} ${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`,
  );
  return { matchedFiles, patchedFiles, alreadyPatchedFiles };
}

export function patchInstalledOpenClawSmartLatestRateLimitRetryRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawSmartLatestRateLimitRetryRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
