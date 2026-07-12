import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_MARKER = 'UCLAW_NATIVE_MEDIA_TASK_CANCELLATION';
const REGISTRY_SYMBOL = 'uclaw.native-media-task-abort-controller.v1';

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function replaceUnique(content, search, replacement, label, filePath) {
  const count = countOccurrences(content, search);
  if (count !== 1) {
    throw new Error(
      `[openclaw-native-media-cancellation-patch] Expected exactly one ${label} anchor in ${filePath}; found ${count}.`,
    );
  }
  return content.replace(search, replacement);
}

const MEDIA_ABORT_HELPERS_ANCHOR = `const MEDIA_GENERATION_TASK_KEEPALIVE_INTERVAL_MS = 6e4;`;

const MEDIA_ABORT_HELPERS_PATCH = `const MEDIA_GENERATION_TASK_KEEPALIVE_INTERVAL_MS = 6e4;
const UCLAW_NATIVE_MEDIA_TASK_CANCELLATION = "${REGISTRY_SYMBOL}";
const UCLAW_NATIVE_MEDIA_TASK_ABORT_REGISTRY_KEY = Symbol.for(UCLAW_NATIVE_MEDIA_TASK_CANCELLATION);
function getUClawNativeMediaTaskAbortRegistry() {
\tconst existing = globalThis[UCLAW_NATIVE_MEDIA_TASK_ABORT_REGISTRY_KEY];
\tif (existing instanceof Map) return existing;
\tconst registry = /* @__PURE__ */ new Map();
\tglobalThis[UCLAW_NATIVE_MEDIA_TASK_ABORT_REGISTRY_KEY] = registry;
\treturn registry;
}
function registerUClawNativeMediaTaskAbortController(handle) {
\tconst controller = new AbortController();
\thandle.abortController = controller;
\tgetUClawNativeMediaTaskAbortRegistry().set(handle.taskId, controller);
}
function isUClawNativeMediaTaskCancelled(handle) {
\treturn handle?.abortController?.signal.aborted === true;
}
function throwIfUClawNativeMediaTaskCancelled(handle) {
\tif (!isUClawNativeMediaTaskCancelled(handle)) return;
\tconst reason = handle.abortController.signal.reason;
\tif (reason !== void 0) throw reason;
\tconst error = /* @__PURE__ */ new Error("Media generation task cancelled.");
\terror.name = "AbortError";
\tthrow error;
}
function releaseUClawNativeMediaTaskAbortController(handle) {
\tif (!handle?.taskId || !handle.abortController) return;
\tconst registry = getUClawNativeMediaTaskAbortRegistry();
\tif (registry.get(handle.taskId) === handle.abortController) registry.delete(handle.taskId);
}`;

const MEDIA_HANDLE_ANCHOR = `\t\tconst handle = {
\t\t\ttaskId: task.taskId,
\t\t\trunId,
\t\t\trequesterSessionKey: sessionKey,
\t\t\trequesterOrigin,
\t\t\ttaskLabel: params.prompt
\t\t};
\t\ttouchMediaGenerationTaskRunContext(handle);`;

const MEDIA_HANDLE_PATCH = `\t\tconst handle = {
\t\t\ttaskId: task.taskId,
\t\t\trunId,
\t\t\trequesterSessionKey: sessionKey,
\t\t\trequesterOrigin,
\t\t\ttaskLabel: params.prompt
\t\t};
\t\tregisterUClawNativeMediaTaskAbortController(handle);
\t\ttouchMediaGenerationTaskRunContext(handle);`;

const MEDIA_PROGRESS_ANCHOR = `function recordMediaGenerationTaskProgress(params) {
\tif (!params.handle) return;`;
const MEDIA_PROGRESS_PATCH = `function recordMediaGenerationTaskProgress(params) {
\tif (!params.handle || isUClawNativeMediaTaskCancelled(params.handle)) return;`;

const MEDIA_COMPLETE_ANCHOR = `function completeMediaGenerationTaskRun(params) {
\tif (!params.handle) return;
\ttry {`;
const MEDIA_COMPLETE_PATCH = `function completeMediaGenerationTaskRun(params) {
\tif (!params.handle) return;
\tif (isUClawNativeMediaTaskCancelled(params.handle)) {
\t\treleaseUClawNativeMediaTaskAbortController(params.handle);
\t\tclearAgentRunContext(params.handle.runId);
\t\treturn;
\t}
\ttry {`;

const MEDIA_COMPLETE_FINALLY_ANCHOR = `\t} finally {
\t\tclearAgentRunContext(params.handle.runId);
\t}
}
function failMediaGenerationTaskRun(params) {`;
const MEDIA_COMPLETE_FINALLY_PATCH = `\t} finally {
\t\treleaseUClawNativeMediaTaskAbortController(params.handle);
\t\tclearAgentRunContext(params.handle.runId);
\t}
}
function failMediaGenerationTaskRun(params) {`;

const MEDIA_FAIL_ANCHOR = `function failMediaGenerationTaskRun(params) {
\tif (!params.handle) return;
\ttry {`;
const MEDIA_FAIL_PATCH = `function failMediaGenerationTaskRun(params) {
\tif (!params.handle) return;
\tif (isUClawNativeMediaTaskCancelled(params.handle)) {
\t\treleaseUClawNativeMediaTaskAbortController(params.handle);
\t\tclearAgentRunContext(params.handle.runId);
\t\treturn;
\t}
\ttry {`;

const MEDIA_FAIL_FINALLY_ANCHOR = `\t} finally {
\t\tclearAgentRunContext(params.handle.runId);
\t}
}
function buildMediaGenerationReplyInstruction(params) {`;
const MEDIA_FAIL_FINALLY_PATCH = `\t} finally {
\t\treleaseUClawNativeMediaTaskAbortController(params.handle);
\t\tclearAgentRunContext(params.handle.runId);
\t}
}
function buildMediaGenerationReplyInstruction(params) {`;

const MEDIA_WAKE_ANCHOR = `async function wakeMediaGenerationTaskCompletion(params) {
\tif (!params.handle) return true;`;
const MEDIA_WAKE_PATCH = `async function wakeMediaGenerationTaskCompletion(params) {
\tif (!params.handle || isUClawNativeMediaTaskCancelled(params.handle)) return true;`;

const MEDIA_DIRECT_DELIVERY_ANCHOR = `async function tryDeliverMediaGenerationDirect(params) {
\tconst origin = normalizeDeliveryContext(params.handle.requesterOrigin);`;
const MEDIA_DIRECT_DELIVERY_PATCH = `async function tryDeliverMediaGenerationDirect(params) {
\tif (isUClawNativeMediaTaskCancelled(params.handle)) return false;
\tconst origin = normalizeDeliveryContext(params.handle.requesterOrigin);`;
const MEDIA_DIRECT_SEND_ANCHOR = `\t\tconst { sendMessage } = await import("./task-registry-delivery-runtime-C6donMXJ.js");
\t\tawait sendMessage({`;
const MEDIA_DIRECT_SEND_PATCH = `\t\tconst { sendMessage } = await import("./task-registry-delivery-runtime-C6donMXJ.js");
\t\tif (isUClawNativeMediaTaskCancelled(params.handle)) return false;
\t\tawait sendMessage({`;

const IMAGE_RUNTIME_CALL_ANCHOR = `\tconst result = await generateImage({
\t\tcfg: params.effectiveCfg,`;
const IMAGE_RUNTIME_CALL_PATCH = `\tconst result = await generateImage({
\t\tcfg: params.effectiveCfg,
\t\tsignal: params.taskHandle?.abortController?.signal,`;

const IMAGE_RUNTIME_RESULT_ANCHOR = `\t\tssrfPolicy: params.ssrfPolicy
\t});
\tif (params.taskHandle) recordImageGenerationTaskProgress({`;
const IMAGE_RUNTIME_RESULT_PATCH = `\t\tssrfPolicy: params.ssrfPolicy
\t});
\tthrowIfUClawNativeMediaTaskCancelled(params.taskHandle);
\tif (params.taskHandle) recordImageGenerationTaskProgress({`;

const VIDEO_RUNTIME_CALL_ANCHOR = `\tconst result = await generateVideo({
\t\tcfg: params.effectiveCfg,`;
const VIDEO_RUNTIME_CALL_PATCH = `\tconst result = await generateVideo({
\t\tcfg: params.effectiveCfg,
\t\tsignal: params.taskHandle?.abortController?.signal,`;

const VIDEO_RUNTIME_RESULT_ANCHOR = `\t\ttimeoutMs: params.timeoutMs
\t});
\tif (params.taskHandle) recordVideoGenerationTaskProgress({`;
const VIDEO_RUNTIME_RESULT_PATCH = `\t\ttimeoutMs: params.timeoutMs
\t});
\tthrowIfUClawNativeMediaTaskCancelled(params.taskHandle);
\tif (params.taskHandle) recordVideoGenerationTaskProgress({`;
const IMAGE_ASYNC_START_ANCHOR = `\t\t\t\t\tmessage: "Image generation started; wait for the generated image completion event.",`;
const IMAGE_ASYNC_START_PATCH = `\t\t\t\t\tmessage: \`Background task started for image generation (\${taskHandle.taskId}). Wait for the generated image completion event.\`,`;
const VIDEO_ASYNC_START_ANCHOR = `\t\t\t\t\tmessage: "Video generation started; wait for the generated video completion event.",`;
const VIDEO_ASYNC_START_PATCH = `\t\t\t\t\tmessage: \`Background task started for video generation (\${taskHandle.taskId}). Wait for the generated video completion event.\`,`;

function patchMediaToolContent(content, filePath) {
  if (!content.includes('function createMediaGenerationTaskRun(params)')) return null;
  if (content.includes(PATCH_MARKER)) return { content, changed: false, category: 'media-tool' };
  let patched = content;
  patched = replaceUnique(patched, MEDIA_ABORT_HELPERS_ANCHOR, MEDIA_ABORT_HELPERS_PATCH, 'media abort helpers', filePath);
  patched = replaceUnique(patched, MEDIA_HANDLE_ANCHOR, MEDIA_HANDLE_PATCH, 'media task handle', filePath);
  patched = replaceUnique(patched, MEDIA_PROGRESS_ANCHOR, MEDIA_PROGRESS_PATCH, 'media task progress guard', filePath);
  patched = replaceUnique(patched, MEDIA_COMPLETE_ANCHOR, MEDIA_COMPLETE_PATCH, 'media completion guard', filePath);
  patched = replaceUnique(patched, MEDIA_COMPLETE_FINALLY_ANCHOR, MEDIA_COMPLETE_FINALLY_PATCH, 'media completion cleanup', filePath);
  patched = replaceUnique(patched, MEDIA_FAIL_ANCHOR, MEDIA_FAIL_PATCH, 'media failure guard', filePath);
  patched = replaceUnique(patched, MEDIA_FAIL_FINALLY_ANCHOR, MEDIA_FAIL_FINALLY_PATCH, 'media failure cleanup', filePath);
  patched = replaceUnique(patched, MEDIA_WAKE_ANCHOR, MEDIA_WAKE_PATCH, 'media completion wake guard', filePath);
  patched = replaceUnique(patched, MEDIA_DIRECT_DELIVERY_ANCHOR, MEDIA_DIRECT_DELIVERY_PATCH, 'media direct delivery guard', filePath);
  patched = replaceUnique(patched, MEDIA_DIRECT_SEND_ANCHOR, MEDIA_DIRECT_SEND_PATCH, 'media direct send guard', filePath);
  patched = replaceUnique(patched, IMAGE_RUNTIME_CALL_ANCHOR, IMAGE_RUNTIME_CALL_PATCH, 'image task signal', filePath);
  patched = replaceUnique(patched, IMAGE_RUNTIME_RESULT_ANCHOR, IMAGE_RUNTIME_RESULT_PATCH, 'image post-provider cancellation guard', filePath);
  patched = replaceUnique(patched, VIDEO_RUNTIME_CALL_ANCHOR, VIDEO_RUNTIME_CALL_PATCH, 'video task signal', filePath);
  patched = replaceUnique(patched, VIDEO_RUNTIME_RESULT_ANCHOR, VIDEO_RUNTIME_RESULT_PATCH, 'video post-provider cancellation guard', filePath);
  patched = replaceUnique(patched, IMAGE_ASYNC_START_ANCHOR, IMAGE_ASYNC_START_PATCH, 'image async task id notification', filePath);
  patched = replaceUnique(patched, VIDEO_ASYNC_START_ANCHOR, VIDEO_ASYNC_START_PATCH, 'video async task id notification', filePath);
  return { content: patched, changed: true, category: 'media-tool' };
}

const TASK_REGISTRY_CANCEL_ANCHOR = `async function cancelTaskById(params) {`;
const TASK_REGISTRY_CANCEL_PATCH = `const UCLAW_NATIVE_MEDIA_TASK_ABORT_REGISTRY = "${REGISTRY_SYMBOL}";
function abortUClawNativeMediaTaskById(taskId, reason) {
\tconst registry = globalThis[Symbol.for(UCLAW_NATIVE_MEDIA_TASK_ABORT_REGISTRY)];
\tconst controller = registry instanceof Map ? registry.get(taskId) : void 0;
\tif (!(controller instanceof AbortController)) return false;
\tif (!controller.signal.aborted) controller.abort(reason || "Cancelled by operator.");
\treturn true;
}
async function cancelTaskById(params) {`;

const TASK_REGISTRY_PERSIST_ANCHOR = `\t\tif (!updated) return {
\t\t\tfound: true,
\t\t\tcancelled: false,
\t\t\treason: "Task persistence failed.",
\t\t\ttask: cloneTaskRecord(task)
\t\t};
\t\tif (updated) maybeDeliverTaskTerminalUpdate(updated.taskId);`;
const TASK_REGISTRY_PERSIST_PATCH = `\t\tif (!updated) return {
\t\t\tfound: true,
\t\t\tcancelled: false,
\t\t\treason: "Task persistence failed.",
\t\t\ttask: cloneTaskRecord(task)
\t\t};
\t\tif (task.runtime === "cli") abortUClawNativeMediaTaskById(task.taskId, params.reason?.trim());
\t\tif (updated) maybeDeliverTaskTerminalUpdate(updated.taskId);`;

function patchTaskRegistryContent(content, filePath) {
  if (!content.includes('async function cancelTaskById(params)')) return null;
  if (content.includes('UCLAW_NATIVE_MEDIA_TASK_ABORT_REGISTRY')) {
    return { content, changed: false, category: 'task-registry' };
  }
  let patched = replaceUnique(
    content,
    TASK_REGISTRY_CANCEL_ANCHOR,
    TASK_REGISTRY_CANCEL_PATCH,
    'task registry cancel function',
    filePath,
  );
  patched = replaceUnique(
    patched,
    TASK_REGISTRY_PERSIST_ANCHOR,
    TASK_REGISTRY_PERSIST_PATCH,
    'persisted CLI task cancellation branch',
    filePath,
  );
  return { content: patched, changed: true, category: 'task-registry' };
}

const IMAGE_PROVIDER_REQUEST_ANCHOR = `\t\t\t\tinputImages: params.inputImages,
\t\t\t\t...timeoutMs !== void 0 ? { timeoutMs } : {},`;
const IMAGE_PROVIDER_REQUEST_PATCH = `\t\t\t\tinputImages: params.inputImages,
\t\t\t\tsignal: params.signal,
\t\t\t\t...timeoutMs !== void 0 ? { timeoutMs } : {},`;
const IMAGE_PROVIDER_CATCH_ANCHOR = `\t\t} catch (err) {
\t\t\tlastError = err;
\t\t\tconst described = isFailoverError(err)`;
const IMAGE_PROVIDER_CATCH_PATCH = `\t\t} catch (err) {
\t\t\tparams.signal?.throwIfAborted();
\t\t\tlastError = err;
\t\t\tconst described = isFailoverError(err)`;
const IMAGE_RUNTIME_START_ANCHOR = `async function generateImage(params, deps = {}) {
\tconst getProvider = deps.getProvider ?? getImageGenerationProvider;`;
const IMAGE_RUNTIME_START_PATCH = `async function generateImage(params, deps = {}) {
\tparams.signal?.throwIfAborted();
\tconst getProvider = deps.getProvider ?? getImageGenerationProvider;`;

function patchImageRuntimeContent(content, filePath) {
  if (!content.includes('async function generateImage(params, deps = {})')) return null;
  if (content.includes('signal: params.signal')) return { content, changed: false, category: 'image-runtime' };
  let patched = replaceUnique(content, IMAGE_RUNTIME_START_ANCHOR, IMAGE_RUNTIME_START_PATCH, 'image runtime cancellation guard', filePath);
  patched = replaceUnique(patched, IMAGE_PROVIDER_REQUEST_ANCHOR, IMAGE_PROVIDER_REQUEST_PATCH, 'image provider signal', filePath);
  patched = replaceUnique(patched, IMAGE_PROVIDER_CATCH_ANCHOR, IMAGE_PROVIDER_CATCH_PATCH, 'image cancellation failover guard', filePath);
  return { content: patched, changed: true, category: 'image-runtime' };
}

const VIDEO_PROVIDER_REQUEST_ANCHOR = `\t\t\t\tinputAudios: params.inputAudios,
\t\t\t\tproviderOptions: params.providerOptions,`;
const VIDEO_PROVIDER_REQUEST_PATCH = `\t\t\t\tinputAudios: params.inputAudios,
\t\t\t\tsignal: params.signal,
\t\t\t\tproviderOptions: params.providerOptions,`;
const VIDEO_PROVIDER_CATCH_ANCHOR = `\t\t} catch (err) {
\t\t\tlastError = err;
\t\t\trecordCapabilityCandidateFailure({`;
const VIDEO_PROVIDER_CATCH_PATCH = `\t\t} catch (err) {
\t\t\tparams.signal?.throwIfAborted();
\t\t\tlastError = err;
\t\t\trecordCapabilityCandidateFailure({`;
const VIDEO_RUNTIME_START_ANCHOR = `async function generateVideo(params, deps = {}) {
\tconst getProvider = deps.getProvider ?? getVideoGenerationProvider;`;
const VIDEO_RUNTIME_START_PATCH = `async function generateVideo(params, deps = {}) {
\tparams.signal?.throwIfAborted();
\tconst getProvider = deps.getProvider ?? getVideoGenerationProvider;`;

function patchVideoRuntimeContent(content, filePath) {
  if (!content.includes('async function generateVideo(params, deps = {})')) return null;
  if (content.includes('signal: params.signal')) return { content, changed: false, category: 'video-runtime' };
  let patched = replaceUnique(content, VIDEO_RUNTIME_START_ANCHOR, VIDEO_RUNTIME_START_PATCH, 'video runtime cancellation guard', filePath);
  patched = replaceUnique(patched, VIDEO_PROVIDER_REQUEST_ANCHOR, VIDEO_PROVIDER_REQUEST_PATCH, 'video provider signal', filePath);
  patched = replaceUnique(patched, VIDEO_PROVIDER_CATCH_ANCHOR, VIDEO_PROVIDER_CATCH_PATCH, 'video cancellation failover guard', filePath);
  return { content: patched, changed: true, category: 'video-runtime' };
}

const FETCH_TIMEOUT_SIGNAL_ANCHOR = `\tconst { signal, cleanup } = buildTimeoutAbortSignal({
\t\ttimeoutMs: Math.max(1, timeoutMs),
\t\toperation: "fetchWithTimeout",`;
const FETCH_TIMEOUT_SIGNAL_PATCH = `\tconst { signal: timeoutSignal, cleanup } = buildTimeoutAbortSignal({
\t\ttimeoutMs: Math.max(1, timeoutMs),
\t\toperation: "fetchWithTimeout",`;
const FETCH_TIMEOUT_URL_ANCHOR = `\t\turl
\t});
\ttry {
\t\treturn await fetchFn(url, {
\t\t\t...init,
\t\t\tsignal
\t\t});`;
const FETCH_TIMEOUT_URL_PATCH = `\t\turl
\t});
\tconst signal = init?.signal && timeoutSignal ? AbortSignal.any([init.signal, timeoutSignal]) : init?.signal ?? timeoutSignal;
\ttry {
\t\treturn await fetchFn(url, {
\t\t\t...init,
\t\t\tsignal
\t\t});`;

function patchFetchTimeoutContent(content, filePath) {
  if (
    !content.includes('//#region src/utils/fetch-timeout.ts')
    || !content.includes('async function fetchWithTimeout(url, init, timeoutMs')
  ) return null;
  if (content.includes('AbortSignal.any([init.signal, timeoutSignal])')) {
    return { content, changed: false, category: 'fetch-timeout' };
  }
  let patched = replaceUnique(content, FETCH_TIMEOUT_SIGNAL_ANCHOR, FETCH_TIMEOUT_SIGNAL_PATCH, 'fetch timeout signal declaration', filePath);
  patched = replaceUnique(patched, FETCH_TIMEOUT_URL_ANCHOR, FETCH_TIMEOUT_URL_PATCH, 'fetch timeout parent signal composition', filePath);
  return {
    content: patched,
    changed: true,
    category: 'fetch-timeout',
  };
}

const POLL_WAIT_ANCHOR = `async function waitProviderOperationPollInterval(params) {
\tconst pollIntervalMs = resolveTimerTimeoutMs(params.pollIntervalMs, 1);`;
const POLL_WAIT_PATCH = `async function waitProviderOperationPollInterval(params) {
\tparams.signal?.throwIfAborted();
\tconst pollIntervalMs = resolveTimerTimeoutMs(params.pollIntervalMs, 1);`;
const POLL_INIT_ANCHOR = `\t\tconst init = {
\t\t\tmethod: "GET",
\t\t\theaders: typeof params.headers === "function" ? params.headers() : params.headers
\t\t};`;
const POLL_INIT_PATCH = `\t\tconst init = {
\t\t\tmethod: "GET",
\t\t\theaders: typeof params.headers === "function" ? params.headers() : params.headers,
\t\t\tsignal: params.signal
\t\t};`;
const POLL_WAIT_CALL_ANCHOR = `\t\tawait waitProviderOperationPollInterval({
\t\t\tdeadline: params.deadline,
\t\t\tpollIntervalMs: params.pollIntervalMs
\t\t});`;
const POLL_WAIT_CALL_PATCH = `\t\tawait waitProviderOperationPollInterval({
\t\t\tdeadline: params.deadline,
\t\t\tpollIntervalMs: params.pollIntervalMs,
\t\t\tsignal: params.signal
\t\t});`;
const GUARDED_FETCH_SIGNAL_ANCHOR = `\t\tinit,
\t\ttimeoutMs: resolveGuardedHttpTimeoutMs(timeoutMs),`;
const GUARDED_FETCH_SIGNAL_PATCH = `\t\tinit,
\t\tsignal: init?.signal,
\t\ttimeoutMs: resolveGuardedHttpTimeoutMs(timeoutMs),`;
const POST_JSON_SIGNAL_ANCHOR = `\t\t\tmethod: "POST",
\t\t\theaders: params.headers,
\t\t\tbody: JSON.stringify(params.body)
\t\t},`;
const POST_JSON_SIGNAL_PATCH = `\t\t\tmethod: "POST",
\t\t\theaders: params.headers,
\t\t\tbody: JSON.stringify(params.body),
\t\t\tsignal: params.signal
\t\t},`;
const POST_MULTIPART_SIGNAL_ANCHOR = `async function postMultipartRequest(params) {
\treturn await postGuardedRequest({
\t\turl: params.url,
\t\tinit: {
\t\t\tmethod: "POST",
\t\t\theaders: params.headers,
\t\t\tbody: params.body
\t\t},`;
const POST_MULTIPART_SIGNAL_PATCH = `async function postMultipartRequest(params) {
\treturn await postGuardedRequest({
\t\turl: params.url,
\t\tinit: {
\t\t\tmethod: "POST",
\t\t\theaders: params.headers,
\t\t\tbody: params.body,
\t\t\tsignal: params.signal
\t\t},`;

function patchProviderTransportContent(content, filePath) {
  if (!content.includes('async function pollProviderOperationJson(params)')) return null;
  if (content.includes('UCLAW_NATIVE_MEDIA_PROVIDER_SIGNAL')) {
    return { content, changed: false, category: 'provider-transport' };
  }
  let patched = content.replace(
    POLL_WAIT_ANCHOR,
    `const UCLAW_NATIVE_MEDIA_PROVIDER_SIGNAL = "${PATCH_MARKER}";\n${POLL_WAIT_PATCH}`,
  );
  if (patched === content) {
    throw new Error(`[openclaw-native-media-cancellation-patch] Missing poll wait anchor in ${filePath}.`);
  }
  patched = replaceUnique(patched, POLL_INIT_ANCHOR, POLL_INIT_PATCH, 'poll request signal', filePath);
  patched = replaceUnique(patched, POLL_WAIT_CALL_ANCHOR, POLL_WAIT_CALL_PATCH, 'poll wait signal', filePath);
  patched = replaceUnique(patched, GUARDED_FETCH_SIGNAL_ANCHOR, GUARDED_FETCH_SIGNAL_PATCH, 'guarded fetch signal', filePath);
  patched = replaceUnique(patched, POST_JSON_SIGNAL_ANCHOR, POST_JSON_SIGNAL_PATCH, 'JSON POST signal', filePath);
  patched = replaceUnique(patched, POST_MULTIPART_SIGNAL_ANCHOR, POST_MULTIPART_SIGNAL_PATCH, 'multipart POST signal', filePath);
  return { content: patched, changed: true, category: 'provider-transport' };
}

const OPENAI_POLL_SIGNAL_ANCHOR = `\t\tauditContext: "openai-video-status",
\t\tisComplete: (payload) => payload.status === "completed",`;
const OPENAI_POLL_SIGNAL_PATCH = `\t\tauditContext: "openai-video-status",
\t\tsignal: params.signal,
\t\tisComplete: (payload) => payload.status === "completed",`;
const OPENAI_DOWNLOAD_INIT_ANCHOR = `\t\tinit: {
\t\t\tmethod: "GET",
\t\t\theaders: new Headers({`;
const OPENAI_DOWNLOAD_INIT_PATCH = `\t\tinit: {
\t\t\tmethod: "GET",
\t\t\tsignal: params.signal,
\t\t\theaders: new Headers({`;
const OPENAI_POST_COMMON_ANCHOR = `\t\t\t\t\t}),
\t\t\t\t\tfetchFn,
\t\t\t\t\tallowPrivateNetwork,`;
const OPENAI_POST_COMMON_PATCH = `\t\t\t\t\t}),
\t\t\t\t\tsignal: req.signal,
\t\t\t\t\tfetchFn,
\t\t\t\t\tallowPrivateNetwork,`;
const OPENAI_POLL_CALL_ANCHOR = `\t\t\t\t\tbaseUrl,
\t\t\t\t\tfetchFn,
\t\t\t\t\tallowPrivateNetwork,
\t\t\t\t\tdispatcherPolicy
\t\t\t\t});`;
const OPENAI_POLL_CALL_PATCH = `\t\t\t\t\tbaseUrl,
\t\t\t\t\tsignal: req.signal,
\t\t\t\t\tfetchFn,
\t\t\t\t\tallowPrivateNetwork,
\t\t\t\t\tdispatcherPolicy
\t\t\t\t});`;
const OPENAI_DOWNLOAD_CALL_ANCHOR = `\t\t\t\t\t\tbaseUrl,
\t\t\t\t\t\tfetchFn,
\t\t\t\t\t\tallowPrivateNetwork,
\t\t\t\t\t\tdispatcherPolicy,
\t\t\t\t\t\tmaxBytes:`;
const OPENAI_DOWNLOAD_CALL_PATCH = `\t\t\t\t\t\tbaseUrl,
\t\t\t\t\t\tsignal: req.signal,
\t\t\t\t\t\tfetchFn,
\t\t\t\t\t\tallowPrivateNetwork,
\t\t\t\t\t\tdispatcherPolicy,
\t\t\t\t\t\tmaxBytes:`;

function patchOpenAIVideoProviderContent(content, filePath) {
  if (!content.includes('extensions/openai/video-generation-provider.ts')) return null;
  if (content.includes('UCLAW_NATIVE_MEDIA_OPENAI_VIDEO_SIGNAL')) {
    return { content, changed: false, category: 'openai-video-provider' };
  }
  let patched = content.replace(
    'const DEFAULT_OPENAI_VIDEO_BASE_URL = "https://api.openai.com/v1";',
    `const UCLAW_NATIVE_MEDIA_OPENAI_VIDEO_SIGNAL = "${PATCH_MARKER}";\nconst DEFAULT_OPENAI_VIDEO_BASE_URL = "https://api.openai.com/v1";`,
  );
  if (patched === content) {
    throw new Error(`[openclaw-native-media-cancellation-patch] Missing OpenAI video marker anchor in ${filePath}.`);
  }
  patched = replaceUnique(patched, OPENAI_POLL_SIGNAL_ANCHOR, OPENAI_POLL_SIGNAL_PATCH, 'OpenAI video poll signal', filePath);
  patched = replaceUnique(patched, OPENAI_DOWNLOAD_INIT_ANCHOR, OPENAI_DOWNLOAD_INIT_PATCH, 'OpenAI video download signal', filePath);
  const postCount = countOccurrences(patched, OPENAI_POST_COMMON_ANCHOR);
  if (postCount !== 3) {
    throw new Error(`[openclaw-native-media-cancellation-patch] Expected three OpenAI video POST signal anchors in ${filePath}; found ${postCount}.`);
  }
  patched = patched.split(OPENAI_POST_COMMON_ANCHOR).join(OPENAI_POST_COMMON_PATCH);
  patched = replaceUnique(patched, OPENAI_POLL_CALL_ANCHOR, OPENAI_POLL_CALL_PATCH, 'OpenAI video poll invocation signal', filePath);
  patched = replaceUnique(patched, OPENAI_DOWNLOAD_CALL_ANCHOR, OPENAI_DOWNLOAD_CALL_PATCH, 'OpenAI video download invocation signal', filePath);
  return { content: patched, changed: true, category: 'openai-video-provider' };
}

const PATCHERS = [
  patchMediaToolContent,
  patchTaskRegistryContent,
  patchImageRuntimeContent,
  patchVideoRuntimeContent,
  patchFetchTimeoutContent,
  patchProviderTransportContent,
  patchOpenAIVideoProviderContent,
];

export function patchOpenClawNativeMediaCancellationContent(content, filePath = '<fixture>') {
  for (const patcher of PATCHERS) {
    const result = patcher(content, filePath);
    if (result) return result;
  }
  return { content, changed: false, category: null };
}

export function patchOpenClawNativeMediaCancellationRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-native-media-cancellation-patch] OpenClaw dist directory not found: ${distDir}`);
  }

  const categoryCounts = new Map();
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawNativeMediaCancellationContent(content, filePath);
    if (!result.category) continue;
    categoryCounts.set(result.category, (categoryCounts.get(result.category) ?? 0) + 1);
    if (result.changed) {
      patchedFiles += 1;
      if (!dryRun) writeFileSync(filePath, result.content, 'utf8');
    } else {
      alreadyPatchedFiles += 1;
    }
  }

  const expectedCategories = [
    'media-tool',
    'task-registry',
    'image-runtime',
    'video-runtime',
    'fetch-timeout',
    'provider-transport',
    'openai-video-provider',
  ];
  for (const category of expectedCategories) {
    const count = categoryCounts.get(category) ?? 0;
    if (count !== 1) {
      throw new Error(
        `[openclaw-native-media-cancellation-patch] Expected exactly one ${category} runtime file in ${distDir}; found ${count}.`,
      );
    }
  }

  logger.log?.(
    `[openclaw-native-media-cancellation-patch] ${dryRun ? 'Dry-run matched' : 'Patched'} ${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`,
  );
  return {
    patchedFiles,
    alreadyPatchedFiles,
    categoryCounts: Object.fromEntries(categoryCounts),
  };
}

export function patchInstalledOpenClawNativeMediaCancellationRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawNativeMediaCancellationRuntime(
    join(cwd, 'node_modules', 'openclaw', 'dist'),
    options,
  );
}
