import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_NAME = 'openclaw-native-media-completion-contract-patch';
const PATCH_MARKER = 'UCLAW_NATIVE_MEDIA_COMPLETION_CONTRACT_V3';
const LEGACY_PATCH_MARKER = 'UCLAW_NATIVE_MEDIA_COMPLETION_CONTRACT_V2';
const RUNTIME_SIGNATURE = 'async function wakeMediaGenerationTaskCompletion(params) {';
const QUEUED_RUNTIME_SIGNATURE = 'async function wakeMediaGenerationTaskCompletionQueued(params) {';
const COORDINATOR_MARKER = 'UCLAW_SESSION_COORDINATOR_V1';
const WAKE_ANCHOR = `async function wakeMediaGenerationTaskCompletion(params) {
\tif (!params.handle || isUClawNativeMediaTaskCancelled(params.handle)) return true;`;
const DETACHED_RUNTIME_IMPORT = 'import { a as failTaskRunByRunId, c as recordTaskRunProgressByRunId, i as createRunningTaskRun, n as completeTaskRunByRunId } from "./detached-task-runtime-CkGwWUlu.js";';
const DETACHED_RUNTIME_IMPORT_PATCH = 'import { a as failTaskRunByRunId, c as recordTaskRunProgressByRunId, i as createRunningTaskRun, l as setDetachedTaskDeliveryStatusByRunId, n as completeTaskRunByRunId } from "./detached-task-runtime-CkGwWUlu.js";';
const DELIVERY_ANCHOR = '\tconst delivery = await deliverSubagentAnnouncement({';
const DELIVERY_PATCH = '\tif (await steerActiveUclawMediaRequester(params, triggerMessage)) {\n\t\tsetUclawNativeMediaDeliveryStatus(params, "delivered");\n\t\treturn true;\n\t}\n\tconst delivery = await deliverSubagentAnnouncement({';

const WAKE_PATCH = `const ${PATCH_MARKER} = true;
const ${COORDINATOR_MARKER} = true;
const UCLAW_SESSION_COORDINATOR_FOR_MEDIA = globalThis[Symbol.for("uclaw.session.coordinator.v1")] || (globalThis[Symbol.for("uclaw.session.coordinator.v1")] = { queues: new Map() });
function runUclawNativeMediaCompletionInSessionQueue(sessionKey, task) {
\tconst key = String(sessionKey || "__unknown__");
\tconst queueKey = "media-completion:" + key;
\tconst previous = UCLAW_SESSION_COORDINATOR_FOR_MEDIA.queues.get(queueKey) || Promise.resolve();
\tconst run = previous.catch(() => void 0).then(task);
\tconst cleanup = run.catch(() => void 0).then(() => {
\t\tif (UCLAW_SESSION_COORDINATOR_FOR_MEDIA.queues.get(queueKey) === cleanup) UCLAW_SESSION_COORDINATOR_FOR_MEDIA.queues.delete(queueKey);
\t});
\tUCLAW_SESSION_COORDINATOR_FOR_MEDIA.queues.set(queueKey, cleanup);
\treturn run;
}
function setUclawNativeMediaDeliveryStatus(params, status, error) {
\ttry {
\t\tsetDetachedTaskDeliveryStatusByRunId({
\t\t\trunId: params.handle.runId,
\t\t\truntime: "cli",
\t\t\tsessionKey: params.handle.requesterSessionKey,
\t\t\tdeliveryStatus: status,
\t\t\t...(error ? { error: String(error).slice(0, 1000) } : {})
\t\t});
\t} catch (statusError) {
\t\tlog$5.warn("Failed to persist native media delivery status", { taskId: params.handle?.taskId, status, error: statusError });
\t}
}
async function steerActiveUclawMediaRequester(params, triggerMessage) {
\tconst activeSessionId = resolveActiveEmbeddedRunSessionId(params.handle.requesterSessionKey);
\tif (!activeSessionId) return false;
\tfor (const delayMs of [0, 250, 1000]) {
\t\tif (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
\t\tif (isUClawNativeMediaTaskCancelled(params.handle)) return true;
\t\ttry {
\t\t\tconst outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(activeSessionId, triggerMessage, {
\t\t\t\tsteeringMode: "all",
\t\t\t\tdebounceMs: 0,
\t\t\t\twaitForTranscriptCommit: true
\t\t\t});
\t\t\tif (outcome?.queued) return true;
\t\t} catch (error) {
\t\t\tlog$5.debug?.("Active media completion steering is not available yet", { taskId: params.handle?.taskId, error });
\t\t}
\t}
\treturn false;
}
async function wakeMediaGenerationTaskCompletion(params) {
\tif (!params.handle || isUClawNativeMediaTaskCancelled(params.handle)) return true;
\treturn await runUclawNativeMediaCompletionInSessionQueue(params.handle.requesterSessionKey, async () => {
\t\tif (isUClawNativeMediaTaskCancelled(params.handle)) return true;
\t\treturn await wakeMediaGenerationTaskCompletionQueued(params);
\t});
}
async function wakeMediaGenerationTaskCompletionQueued(params) {
\tif (!params.handle || isUClawNativeMediaTaskCancelled(params.handle)) return true;`;

const RECURSIVE_QUEUED_WRAPPER = `async function wakeMediaGenerationTaskCompletionQueued(params) {
\tif (!params.handle || isUClawNativeMediaTaskCancelled(params.handle)) return true;
\treturn await runUclawNativeMediaCompletionInSessionQueue(params.handle.requesterSessionKey, async () => {
\t\tif (isUClawNativeMediaTaskCancelled(params.handle)) return true;
\t\treturn await wakeMediaGenerationTaskCompletionQueued(params);
\t});
}
`;

const SCHEDULE_START = 'function scheduleMediaGenerationTaskCompletion(params) {';
const SCHEDULE_PATCH = `function scheduleMediaGenerationTaskCompletion(params) {
\tparams.scheduleBackgroundWork(async () => {
\t\tlet executed;
\t\ttry {
\t\t\texecuted = await withMediaGenerationTaskKeepalive({
\t\t\t\thandle: params.handle,
\t\t\t\tprogressSummary: params.progressSummary,
\t\t\t\trun: params.run
\t\t\t});
\t\t} catch (error) {
\t\t\tparams.lifecycle.failTaskRun({ handle: params.handle, error });
\t\t\ttry {
\t\t\t\tawait params.lifecycle.wakeTaskCompletion({
\t\t\t\t\tconfig: params.config,
\t\t\t\t\thandle: params.handle,
\t\t\t\t\tstatus: "error",
\t\t\t\t\tstatusLabel: "failed",
\t\t\t\t\tresult: formatErrorMessage(error)
\t\t\t\t});
\t\t\t} catch (wakeError) {
\t\t\t\tparams.onWakeFailure(params.toolName + " failure completion wake failed", { taskId: params.handle?.taskId, runId: params.handle?.runId, error: wakeError });
\t\t\t}
\t\t\treturn;
\t\t}
\t\ttry {
\t\t\tparams.lifecycle.recordTaskProgress({
\t\t\t\thandle: params.handle,
\t\t\t\tprogressSummary: "Generated media; persisting artifact before delivery"
\t\t\t});
\t\t} catch (error) {
\t\t\tparams.onWakeFailure(params.toolName + " completion progress update failed", { taskId: params.handle?.taskId, runId: params.handle?.runId, error });
\t\t}
\t\ttry {
\t\t\t// Execution is terminal before any session wake is attempted. A
\t\t\t// session delivery failure must not turn a contract-valid provider
\t\t\t// artifact into an execution failure.
\t\t\tconst outputBlocked = executed.terminalResult?.terminalOutcome === "blocked";
\t\t\tconst localArtifactPath = (value) => typeof value === "string" && isAbsolute(value.trim()) ? value.trim() : void 0;
\t\t\tconst artifactPaths = !outputBlocked && Array.isArray(executed.paths) ? executed.paths.map(localArtifactPath).filter(Boolean) : [];
\t\t\tconst artifactAttachments = !outputBlocked && Array.isArray(executed.attachments) ? executed.attachments.map((value) => ({
\t\t\t\tpath: localArtifactPath(value?.path),
\t\t\t\tmimeType: typeof value?.mimeType === "string" ? value.mimeType : void 0,
\t\t\t\tname: typeof value?.name === "string" ? value.name : void 0
\t\t\t})).filter((value) => value.path) : [];
\t\t\tconst artifactContract = artifactPaths.length > 0 || artifactAttachments.length > 0
\t\t\t\t? "UCLAW_ARTIFACT_STATUS=available;UCLAW_ARTIFACTS=" + Buffer.from(JSON.stringify({ paths: artifactPaths, attachments: artifactAttachments })).toString("base64url")
\t\t\t\t: "UCLAW_ARTIFACT_STATUS=missing";
\t\t\tif (params.handle) setUclawNativeMediaDeliveryStatus({ handle: params.handle }, outputBlocked ? "not_applicable" : "session_queued");
\t\t\tparams.lifecycle.completeTaskRun({
\t\t\t\thandle: params.handle,
\t\t\t\tprovider: executed.provider,
\t\t\t\tmodel: executed.model,
\t\t\t\tcount: executed.count,
\t\t\t\tpaths: outputBlocked ? [] : executed.paths,
\t\t\t\tterminalResult: {
\t\t\t\t\t...executed.terminalResult?.terminalOutcome ? { terminalOutcome: executed.terminalResult.terminalOutcome } : {},
\t\t\t\t\tterminalSummary: [
\t\t\t\t\t\texecuted.terminalResult?.terminalSummary,
\t\t\t\t\t\ttypeof executed.contentText === "string" ? executed.contentText.trim() : "",
\t\t\t\t\t\tartifactContract
\t\t\t\t\t].filter(Boolean).join("\\n")
\t\t\t\t}
\t\t\t});
\t\t} catch (error) {
\t\t\tparams.onWakeFailure(params.toolName + " completion state update failed", { taskId: params.handle?.taskId, runId: params.handle?.runId, error });
\t\t\tparams.lifecycle.failTaskRun({ handle: params.handle, error });
\t\t\treturn;
\t\t}
\t\ttry {
\t\t\tconst outputBlocked = executed.terminalResult?.terminalOutcome === "blocked";
\t\t\tconst delivered = await params.lifecycle.wakeTaskCompletion({
\t\t\t\tconfig: params.config,
\t\t\t\thandle: params.handle,
\t\t\t\tstatus: outputBlocked ? "error" : "ok",
\t\t\t\tstatusLabel: outputBlocked ? "blocked by output verification" : "completed successfully",
\t\t\t\tresult: outputBlocked ? executed.terminalResult?.terminalSummary : executed.wakeResult,
\t\t\t\tattachments: outputBlocked ? [] : executed.attachments,
\t\t\t\tmediaUrls: outputBlocked ? [] : executed.mediaUrls
\t\t\t});
\t\t\tif (!delivered) params.onWakeFailure(params.toolName + (outputBlocked ? " blocked result delivery is pending" : " artifact is ready but completion delivery is pending"), { taskId: params.handle?.taskId, runId: params.handle?.runId });
\t\t} catch (error) {
\t\t\tif (params.handle) setUclawNativeMediaDeliveryStatus({ handle: params.handle }, "failed", error);
\t\t\tparams.onWakeFailure(params.toolName + " completion wake failed after successful generation", { taskId: params.handle?.taskId, runId: params.handle?.runId, error });
\t\t}
\t});
}
`;

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function patchDetachedRuntimeImport(content, filePath) {
  if (content.includes('setDetachedTaskDeliveryStatusByRunId')) return content;
  if (!content.includes(DETACHED_RUNTIME_IMPORT)) {
    throw new Error(`[${PATCH_NAME}] Detached task runtime import anchor was not found in ${filePath}.`);
  }
  return content.replace(DETACHED_RUNTIME_IMPORT, DETACHED_RUNTIME_IMPORT_PATCH);
}

function replaceUnique(content, search, replacement, label, filePath) {
  const count = countOccurrences(content, search);
  if (count !== 1) throw new Error(`[${PATCH_NAME}] Expected one ${label} anchor in ${filePath}; found ${count}.`);
  return content.replace(search, replacement);
}

function normalizeWakeDeclarations(content, filePath) {
  let normalized = content;
  while (countOccurrences(normalized, QUEUED_RUNTIME_SIGNATURE) > 1) {
    if (!normalized.includes(RECURSIVE_QUEUED_WRAPPER)) {
      throw new Error(`[${PATCH_NAME}] Duplicate queued media completion declarations could not be normalized in ${filePath}.`);
    }
    normalized = normalized.replace(RECURSIVE_QUEUED_WRAPPER, '');
  }

  const wakeCount = countOccurrences(normalized, RUNTIME_SIGNATURE);
  const queuedCount = countOccurrences(normalized, QUEUED_RUNTIME_SIGNATURE);
  if (wakeCount !== 1 || queuedCount !== 1) {
    throw new Error(`[${PATCH_NAME}] Expected one media completion wake declaration and one queued declaration in ${filePath}; found wake=${wakeCount}, queued=${queuedCount}.`);
  }
  return normalized;
}

export function patchOpenClawNativeMediaCompletionQueueContent(content, filePath = '<fixture>') {
  if (!content.includes(RUNTIME_SIGNATURE)) return { content, changed: false, matched: false };
  if (content.includes(PATCH_MARKER)) {
    if (countOccurrences(content, PATCH_MARKER) !== 1) throw new Error(`[${PATCH_NAME}] Completion contract marker is not unique in ${filePath}.`);
    const migrated = normalizeWakeDeclarations(
      content.replace('\tconst queueKey = key;', '\tconst queueKey = "media-completion:" + key;'),
      filePath,
    );
    return { content: migrated, changed: migrated !== content, matched: true };
  }
  if (content.includes(LEGACY_PATCH_MARKER)) {
    const scheduleStart = content.indexOf(SCHEDULE_START);
    const helperStart = content.indexOf(`const ${LEGACY_PATCH_MARKER} = true;`, scheduleStart + SCHEDULE_START.length);
    if (scheduleStart < 0 || helperStart < 0 || helperStart <= scheduleStart) {
      throw new Error(`[${PATCH_NAME}] Legacy media completion scheduler anchor was not found in ${filePath}.`);
    }
    const upgraded = normalizeWakeDeclarations(
      (content.slice(0, scheduleStart) + SCHEDULE_PATCH + content.slice(helperStart))
        .replace(LEGACY_PATCH_MARKER, PATCH_MARKER)
        .replace('\tconst queueKey = key;', '\tconst queueKey = "media-completion:" + key;'),
      filePath,
    );
    return { content: upgraded, changed: true, matched: true };
  }

  let patched = patchDetachedRuntimeImport(content, filePath);
  const scheduleStart = patched.indexOf(SCHEDULE_START);
  const wakeStart = patched.indexOf(RUNTIME_SIGNATURE, scheduleStart + SCHEDULE_START.length);
  if (scheduleStart < 0 || wakeStart < 0 || wakeStart <= scheduleStart) {
    throw new Error(`[${PATCH_NAME}] Media completion scheduler anchor was not found in ${filePath}.`);
  }
  patched = patched.slice(0, scheduleStart) + SCHEDULE_PATCH + patched.slice(wakeStart);
  const count = countOccurrences(patched, WAKE_ANCHOR);
  if (count !== 1) throw new Error(`[${PATCH_NAME}] Expected exactly one media completion wake anchor in ${filePath}; found ${count}.`);
  patched = patched.replace(WAKE_ANCHOR, WAKE_PATCH);
  patched = replaceUnique(patched, DELIVERY_ANCHOR, DELIVERY_PATCH, 'active media steering', filePath);
  patched = replaceUnique(
    patched,
    '\tif (delivery.delivered) return true;',
    '\tif (delivery.delivered) {\n\t\tsetUclawNativeMediaDeliveryStatus(params, "delivered");\n\t\treturn true;\n\t}',
    'successful media delivery status',
    filePath,
  );
  patched = replaceUnique(
    patched,
    '\t\treturn true;\n\t}\n\tconst canTryDirectCompletionFallback',
    '\t\tsetUclawNativeMediaDeliveryStatus(params, "delivered");\n\t\treturn true;\n\t}\n\tconst canTryDirectCompletionFallback',
    'terminal media delivery status',
    filePath,
  );
  patched = replaceUnique(
    patched,
    '\t\t})) return true;\n\t}\n\tif (params.status === "error")',
    '\t\t})) {\n\t\t\tsetUclawNativeMediaDeliveryStatus(params, "delivered");\n\t\t\treturn true;\n\t\t}\n\t}\n\tif (params.status === "error")',
    'successful media direct fallback status',
    filePath,
  );
  patched = replaceUnique(
    patched,
    '\t\t})) return true;\n\t}\n\tif (delivery.error)',
    '\t\t})) {\n\t\t\tsetUclawNativeMediaDeliveryStatus(params, "delivered");\n\t\t\treturn true;\n\t\t}\n\t}\n\tif (delivery.error)',
    'successful media error fallback status',
    filePath,
  );
  patched = replaceUnique(
    patched,
    '\treturn false;\n}\nasync function tryDeliverMediaGenerationDirect',
    '\tsetUclawNativeMediaDeliveryStatus(params, "failed", delivery.error);\n\treturn false;\n}\nasync function tryDeliverMediaGenerationDirect',
    'failed media delivery status',
    filePath,
  );
  patched = normalizeWakeDeclarations(patched, filePath);
  return { content: patched, changed: true, matched: true };
}

export function patchOpenClawNativeMediaCompletionQueueRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) throw new Error(`[${PATCH_NAME}] OpenClaw dist directory not found: ${distDir}`);

  const targets = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => ({ file: entry.name, filePath: join(distDir, entry.name) }))
    .map((target) => ({ ...target, result: patchOpenClawNativeMediaCompletionQueueContent(readFileSync(target.filePath, 'utf8'), target.filePath) }))
    .filter(({ result }) => result.matched);
  if (targets.length !== 1) throw new Error(`[${PATCH_NAME}] Expected exactly one OpenClaw media completion runtime file in ${distDir}; found ${targets.length}.`);

  const target = targets[0];
  if (target.result.changed && !dryRun) writeFileSync(target.filePath, target.result.content, 'utf8');
  logger.log?.(`[${PATCH_NAME}] ${target.result.changed ? (dryRun ? 'Dry-run matched' : 'Patched') : 'Already patched'} ${target.file}.`);
  return {
    patchedFiles: target.result.changed ? 1 : 0,
    alreadyPatchedFiles: target.result.changed ? 0 : 1,
    file: target.file,
  };
}

export function patchInstalledOpenClawNativeMediaCompletionQueueRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawNativeMediaCompletionQueueRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
