import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_OPENCLAW_VERSION = '2026.6.10';
// Accept only the exact previous helper for an in-place upgrade; unknown edits fail closed.
const PREVIOUS_TERMINAL_HELPER_SHA256 = 'ca76861b96d318b7c4e8ea5de2342ffe4701f9c56934b0fa82133614575ad3b5';
// 2.0.19 shipped this exact helper with unparenthesized conditional spreads.
// Accept only this known broken revision so the next bundle can repair it.
const BROKEN_TERMINAL_HELPER_SHA256 = 'bcd83a4807bdcccc23faf899ee2a5e6ba63ca42d0f7a4f87f1225ab369ad0fd1';
export const TERMINAL_HELPER_FILE = 'uclaw-provider-terminal-errors.mjs';
// The generated 6.10 chunks include re-export shims with the same prefixes.
// Pin full names, not broad prefix matches that could silently patch a shim.
export const PROVIDER_RUNTIME_FILES = {
  transport: 'openai-transport-stream-CP3KgIXd.js',
  completions: 'openai-completions-vbhA-xck.js',
  responses: 'openai-responses-CZjB_GSL.js',
  azure: 'azure-openai-responses-D664BT94.js',
  anthropic: 'anthropic-D3JaLAzV.js',
  embedded: 'embedded-agent-BgF2MOkH.js',
  fallback: 'model-fallback-CTRdAq5q.js',
  'responses-shared': 'openai-responses-shared-B-EtUnSA.js',
};

/**
 * This helper runs inside the packaged provider runtime. Only explicit business
 * failures and allowlisted certificate codes cross the terminal-error boundary.
 * Never serialize fetch options, keys, certificates or arbitrary cause graphs.
 */
export const TERMINAL_HELPER_SOURCE = `// UClaw terminal provider errors: no trust changes and no generic network retry changes.
const TLS_CODES = new Set([
  "TLS_CERT_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED", "INVALID_CA"
]);
// Bound traversal and body inspection; do not persist untrusted transport data.
export function getUclawTerminalFailure(value) {
  const seen = new Set();
  const queue = [value];
  let quota = false;
  let subscription = false;
  let tls = false;
  let tlsCauseCode;
  for (let count = 0; queue.length && count < 48; count += 1) {
    const item = queue.shift();
    if (typeof item === "string") {
      if (item.length > 16384) continue;
      for (const code of TLS_CODES) {
        if (!new RegExp("\\\\b" + code + "\\\\b").test(item)) continue;
        tls = true;
        if (code !== "TLS_CERT_INVALID") tlsCauseCode ??= code;
      }
      if (/\\bSUBSCRIPTION_UNAVAILABLE\\b|订阅额度不足或未配置订阅|\\bno active subscription\\b/i.test(item)) subscription = true;
      if (/\\binsufficient_user_quota\\b|用户额度不足|预扣费额度失败/.test(item)) quota = true;
      if (item.trim().startsWith("{")) {
        try { queue.push(JSON.parse(item)); } catch { /* Not a structured provider body. */ }
      }
      continue;
    }
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (Array.isArray(item)) { queue.push(...item.slice(0, 12)); continue; }
    for (const key of ["tlsCauseCode", "code", "errorCode", "errorType", "type"]) {
      const code = item[key];
      if (TLS_CODES.has(code)) {
        tls = true;
        if (code !== "TLS_CERT_INVALID") tlsCauseCode ??= code;
      }
      if (code === "SUBSCRIPTION_UNAVAILABLE") subscription = true;
      if (code === "insufficient_user_quota") quota = true;
    }
    for (const key of ["message", "errorMessage", "error", "cause", "details", "detail", "body", "errorBody", "data", "response"]) {
      if (item[key] !== undefined) queue.push(item[key]);
    }
  }
  if (tls) return { code: "TLS_CERT_INVALID", errorMessage: "TLS_CERT_INVALID: " + (tlsCauseCode ?? "certificate validation failed"), ...(tlsCauseCode ? { tlsCauseCode } : {}) };
  if (subscription) return { code: "SUBSCRIPTION_UNAVAILABLE", errorMessage: "SUBSCRIPTION_UNAVAILABLE: no active subscription or subscription quota exhausted" };
  if (quota) return { code: "insufficient_user_quota", errorMessage: "insufficient_user_quota: user quota exhausted" };
}
export function throwUclawTerminalFailure(value) {
  const failure = getUclawTerminalFailure(value);
  if (!failure) return;
  // Only safe stable metadata is exposed to Gateway/ACP; no transport cause is serialized.
  throw Object.assign(new Error(failure.errorMessage), { code: failure.code, errorCode: failure.code, ...(failure.tlsCauseCode ? { tlsCauseCode: failure.tlsCauseCode } : {}) });
}
export function assignUclawTerminalFailure(output, error) {
  const failure = getUclawTerminalFailure(error);
  if (!failure) return;
  output.errorCode = failure.code;
  output.errorType = failure.code;
  output.errorMessage = failure.errorMessage;
  if (failure.tlsCauseCode) output.tlsCauseCode = failure.tlsCauseCode;
}
async function readBoundedErrorBody(response, signal) {
  if (response.ok || !/json/i.test(response.headers.get("content-type") ?? "")) return;
  // SDK fetch signals retain the original request deadline until this wrapper
  // returns. Without a caller-owned deadline/abort, do not wait on a body.
  if (!signal) return;
  signal.throwIfAborted();
  const length = Number(response.headers.get("content-length"));
  if (length > 16384) return;
  let reader;
  try { reader = response.clone().body?.getReader(); } catch { return; }
  if (!reader) return;
  const chunks = [];
  let size = 0;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException("Request aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      size += next.value.length;
      if (size > 16384) return;
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return; }
  } catch (error) {
    if (signal.aborted) {
      // The SDK will not consume this response after fetch rejects. Cancel both
      // tee branches so an abort cannot leave the original body outstanding.
      void response.body?.cancel().catch(() => {});
      throw signal.reason ?? error;
    }
    // Failed body inspection is not new evidence of a terminal failure.
    return;
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Do not await tee cancellation: the SDK has not yet consumed the other branch.
    void reader.cancel().catch(() => {});
  }
}
export function createUclawTerminalFetch(fetchImpl) {
  return async (input, init) => {
    let response;
    try { response = await fetchImpl(input, init); }
    catch (error) {
      const failure = getUclawTerminalFailure(error);
      if (failure?.code !== "TLS_CERT_INVALID") throw error;
      // Local SDK sentinel, NOT an upstream HTTP response. The SDK retries thrown
      // fetch errors before exposing their causes; this non-retryable response
      // preserves the certificate code without modifying trust or SDK globals.
      return new Response(JSON.stringify({ error: {
        code: failure.code, type: failure.code, message: failure.errorMessage,
        ...(failure.tlsCauseCode ? { tlsCauseCode: failure.tlsCauseCode } : {})
      } }), { status: 495, headers: { "content-type": "application/json", "x-should-retry": "false" } });
    }
    if (response.ok) return response;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const failure = getUclawTerminalFailure(await readBoundedErrorBody(response, signal));
    if (!failure) return response;
    const headers = new Headers(response.headers);
    headers.set("x-should-retry", "false");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}
`;

function replaceExact(content, source, target, expected = 1) {
  const targetCount = content.split(target).length - 1;
  if (targetCount === expected && content.split(target).join('').split(source).length - 1 === 0) return content;
  if (targetCount !== 0 || content.split(source).length - 1 !== expected) {
    throw new Error(`Unsupported OpenClaw provider layout at ${source.slice(0, 100)}`);
  }
  return content.split(source).join(target);
}

const helperImport = `import { createUclawTerminalFetch, assignUclawTerminalFailure, throwUclawTerminalFailure } from "./${TERMINAL_HELPER_FILE}";\n`;

/** Version-pinned edits to provider boundaries, not to SDK globals or media pools. */
export function rewriteProviderTerminalErrors(content, kind) {
  let result = content;
  if (kind === 'transport') {
    const source = 'function buildGuardedModelFetch(model, timeoutMs, options) {';
    result = replaceExact(result, source, [
      source,
      '\treturn createUclawTerminalFetch(buildUclawOriginalGuardedModelFetch(model, timeoutMs, options));',
      '}',
      'function buildUclawOriginalGuardedModelFetch(model, timeoutMs, options) {',
    ].join('\n'));
    result = replaceExact(result,
      '\tObject.assign(output, extractTransportErrorDetails(error));',
      '\tObject.assign(output, extractTransportErrorDetails(error));\n\tassignUclawTerminalFailure(output, error);');
  } else if (kind === 'embedded') {
    const source = '\t\t\t\t\tconst assistantForFailover = currentAttemptAssistant ?? sessionAssistantForCandidate;';
    result = replaceExact(result, source, `${source}\n\t\t\t\t\tif (assistantForFailover?.stopReason === "error") throwUclawTerminalFailure(assistantForFailover);`);
    const promptSource = '\t\t\t\t\tif (promptError && !aborted && promptErrorSource !== "compaction" && !hasRecoverableCodexAppServerTimeoutOutcome && !shouldSurfaceCodexCompletionTimeout) {';
    result = replaceExact(result, promptSource, `${promptSource}\n\t\t\t\t\t\tthrowUclawTerminalFailure(promptError);`);
  } else if (kind === 'fallback') {
    // This branch belongs only to text-model fallback. The shared image-model
    // candidate helper and media account scheduling are intentionally untouched.
    const errorSource = '\n\t\tconst err = attemptRun.error;';
    result = replaceExact(result, errorSource, `${errorSource}\n\t\tthrowUclawTerminalFailure(err);`);
  } else if (kind === 'responses-shared') {
    result = replaceExact(result, '\t\toutput.errorMessage = params.formatError(error);',
      '\t\toutput.errorMessage = params.formatError(error);\n\t\tassignUclawTerminalFailure(output, error);');
  } else {
    const constructors = { completions: 1, responses: 1, azure: 2, anthropic: 5 };
    if (!(kind in constructors)) throw new Error(`Unknown provider patch kind: ${kind}`);
    // Existing SDK retry options remain unchanged. Only terminal responses carry the veto.
    if (kind !== 'anthropic') {
      result = replaceExact(result, '\t\tdangerouslyAllowBrowser: true,',
        '\t\tdangerouslyAllowBrowser: true,\n\t\tfetch: createUclawTerminalFetch(globalThis.fetch),', constructors[kind]);
    } else {
      result = replaceExact(result, '\t\t\tdangerouslyAllowBrowser: true,',
        '\t\t\tdangerouslyAllowBrowser: true,\n\t\t\tfetch: createUclawTerminalFetch(globalThis.fetch),', 5);
    }
    if (kind === 'completions' || kind === 'anthropic') {
      result = replaceExact(result, '\t\t\toutput.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);',
        '\t\t\toutput.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);\n\t\t\tassignUclawTerminalFailure(output, error);');
    }
  }
  if (result.split(helperImport).length - 1 > 1) throw new Error('Unsupported duplicate terminal helper import.');
  if (!result.includes(helperImport)) result = helperImport + result;
  return result;
}

/** Restore all attempted writes, including a truncated failing file; not a cross-script transaction. */
async function commitPatchPlans(plans, fileOps) {
  const attempted = [];
  try {
    for (const plan of plans) {
      attempted.push(plan);
      await fileOps.writeFile(plan.path, plan.content, 'utf8');
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const plan of attempted.reverse()) {
      try {
        if (plan.original === undefined) await fileOps.rm(plan.path, { force: true });
        else await fileOps.writeFile(plan.path, plan.original, 'utf8');
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'Provider patch write failed; rollback incomplete', { cause: error });
    throw error;
  }
}

/** Preflight every supported chunk before writing anything; injected file ops support fault tests. */
export async function patchOpenClawProviderTerminalErrorRuntime(openclawDir, fileOps = { writeFile, rm }) {
  const pkg = JSON.parse(await readFile(join(openclawDir, 'package.json'), 'utf8'));
  if (pkg.version !== SUPPORTED_OPENCLAW_VERSION) {
    throw new Error(`Expected OpenClaw ${SUPPORTED_OPENCLAW_VERSION}, found ${String(pkg.version)}.`);
  }
  const dist = join(openclawDir, 'dist');
  const entries = await readdir(dist);
  const plans = [];
  for (const [kind, file] of Object.entries(PROVIDER_RUNTIME_FILES)) {
    const files = entries.filter((name) => name === file);
    if (files.length !== 1) throw new Error(`Expected exactly one OpenClaw ${kind} chunk, found ${files.length}.`);
    const path = join(dist, files[0]);
    const original = await readFile(path, 'utf8');
    plans.push({ path, original, content: rewriteProviderTerminalErrors(original, kind) });
  }
  const helperPath = join(dist, TERMINAL_HELPER_FILE);
  let helper;
  try { helper = await readFile(helperPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const helperHash = helper === undefined ? undefined : createHash('sha256').update(helper).digest('hex');
  if (helper !== undefined && helper !== TERMINAL_HELPER_SOURCE
    && helperHash !== PREVIOUS_TERMINAL_HELPER_SHA256
    && helperHash !== BROKEN_TERMINAL_HELPER_SHA256) {
    throw new Error('Unsupported UClaw terminal helper layout.');
  }
  const writes = plans.filter((plan) => plan.original !== plan.content);
  if (helper !== TERMINAL_HELPER_SOURCE) writes.unshift({ path: helperPath, original: helper, content: TERMINAL_HELPER_SOURCE });
  await commitPatchPlans(writes, fileOps);
  return { filesPatched: writes.length, filesScanned: plans.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('[patch-openclaw-provider-terminal-error]', await patchOpenClawProviderTerminalErrorRuntime(join(process.cwd(), 'node_modules/openclaw')));
}
