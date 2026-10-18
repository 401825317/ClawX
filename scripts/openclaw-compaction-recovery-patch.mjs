import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMPACTION_RUNTIME_FILES = {
  bridge: 'delegate-b2ZmmBj8.js',
  middleware: 'tool-result-middleware-DA6D7k8x.js',
  native: 'compact-CWMSeMMg.js',
  embedded: 'embedded-agent-BgF2MOkH.js',
  fallback: 'model-fallback-CTRdAq5q.js',
};
const TERMINAL_IMPORT = 'import { throwUclawTerminalFailure } from "./uclaw-provider-terminal-errors.mjs";\n';
const PROVIDER_TERMINAL_IMPORT = 'import { createUclawTerminalFetch, assignUclawTerminalFailure, throwUclawTerminalFailure } from "./uclaw-provider-terminal-errors.mjs";\n';

function replaceOnce(content, source, target) {
  if (content.split(target).length === 2 && !content.replace(target, '').includes(source)) return content;
  if (content.split(source).length !== 2 || content.includes(target)) throw new Error('Unsupported compaction recovery layout');
  return content.replace(source, target);
}

export function rewriteCompactionBridge(content) {
  let result = replaceOnce(content,
    '\t\tforce: params.force,\n\t\tcustomInstructions: params.customInstructions,',
    '\t\tforce: params.force,\n\t\tabortSignal: params.abortSignal ?? runtimeContext.abortSignal,\n\t\tcustomInstructions: params.customInstructions,');
  result = replaceOnce(result, '\treturn {\n\t\tok: result.ok,',
    '\tthrowUclawTerminalFailure(result.reason);\n\treturn {\n\t\tok: result.ok,');
  return addTerminalImport(result);
}

function addTerminalImport(content) {
  const count = content.split(TERMINAL_IMPORT).length - 1 + content.split(PROVIDER_TERMINAL_IMPORT).length - 1;
  if (count > 1) throw new Error('Duplicate compaction terminal import');
  return count ? content : TERMINAL_IMPORT + content;
}

export function rewriteCompactionMiddleware(content) {
  let result = replaceOnce(content, '\tlet canceled = false;\n\tconst cancel = () => {',
    '\tlet canceled = false;\n\tlet pendingCompaction;\n\tconst cancel = () => {');
  result = replaceOnce(result, '\treturn await withTimeout(async (timeoutSignal) => {',
    '\ttry { return await withTimeout(async (timeoutSignal) => {');
  result = replaceOnce(result, '\t\t\tconst compactPromise = compact(composedAbortSignal.signal);',
    '\t\t\tconst compactPromise = compact(composedAbortSignal.signal);\n\t\t\tpendingCompaction = Promise.resolve(compactPromise);');
  result = replaceOnce(result, '\t}, timeoutMs, "Compaction");\n}', [
    '\t}, timeoutMs, "Compaction");',
    '\t} catch (error) {',
    '\t\t// Native/legacy writers must finish abort cleanup before recovery opens the transcript.',
    '\t\tif (canceled && opts?.drainOnCancel && pendingCompaction) {',
    '\t\t\tlet timer;',
    '\t\t\ttry {',
    '\t\t\t\tconst drained = await Promise.race([',
    '\t\t\t\t\tpendingCompaction.then(() => true, () => true),',
    '\t\t\t\t\tnew Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })',
    '\t\t\t\t]);',
    '\t\t\t\tif (!drained) throw Object.assign(new Error("session file locked: compaction cleanup did not settle", { cause: error }), { code: "COMPACTION_CLEANUP_PENDING" });',
    '\t\t\t} finally { clearTimeout(timer); }',
    '\t\t}',
    '\t\tthrow error;',
    '\t}',
    '}',
  ].join('\n'));
  result = replaceOnce(result, '\t} : params), timeoutMs, abortSignal ? { abortSignal } : void 0);',
    '\t} : params), timeoutMs, { abortSignal, drainOnCancel: contextEngine.info?.id === "legacy" });');
  result = replaceOnce(result, '\t\t\tshouldRetry: (err) => !isAbortError(err) && !isTimeoutError(err)',
    '\t\t\tshouldRetry: (err) => { params.signal?.throwIfAborted(); throwUclawTerminalFailure(err); return !isAbortError(err) && !isTimeoutError(err); }');
  result = replaceOnce(result, '\t} catch (err) {\n\t\tif (isAbortError(err) || isTimeoutError(err)) throw err;',
    '\t} catch (err) {\n\t\tparams.signal?.throwIfAborted();\n\t\tthrowUclawTerminalFailure(err);\n\t\tif (isAbortError(err) || isTimeoutError(err)) throw err;');
  result = replaceOnce(result, '\t} catch (fullError) {\n\t\tlog$1.warn(',
    '\t} catch (fullError) {\n\t\tparams.signal?.throwIfAborted();\n\t\tthrowUclawTerminalFailure(fullError);\n\t\tif (isAbortError(fullError) || isTimeoutError(fullError)) throw fullError;\n\t\tlog$1.warn(');
  result = replaceOnce(result, '\t} catch (partialError) {\n\t\tlog$1.warn(',
    '\t} catch (partialError) {\n\t\tparams.signal?.throwIfAborted();\n\t\tthrowUclawTerminalFailure(partialError);\n\t\tif (isAbortError(partialError) || isTimeoutError(partialError)) throw partialError;\n\t\tlog$1.warn(');
  return addTerminalImport(result);
}

export function rewriteNativeCompaction(content) {
  let result = replaceOnce(content, 'function classifyCompactionFallbackResult(result, provider, model) {\n\tif (result.ok) return null;',
    'function classifyCompactionFallbackResult(result, provider, model) {\n\tthrowUclawTerminalFailure(result.reason);\n\tif (result.ok) return null;');
  result = replaceOnce(result, '\t\t\tfallbacksOverride,\n\t\t\tclassifyResult:',
    '\t\t\tfallbacksOverride,\n\t\t\tabortSignal: params.abortSignal,\n\t\t\tclassifyResult:');
  result = replaceOnce(result, '\t\t\t\t\t\tabortSignal: params.abortSignal,\n\t\t\t\t\t\tonCancel:',
    '\t\t\t\t\t\tabortSignal: params.abortSignal,\n\t\t\t\t\t\tdrainOnCancel: true,\n\t\t\t\t\t\tonCancel:');
  result = replaceOnce(result, '\t} catch (err) {\n\t\treturn fallbackFailureToCompactionResult(err);',
    '\t} catch (err) {\n\t\tif (err?.code === "COMPACTION_CLEANUP_PENDING" || params.abortSignal?.aborted) throw err;\n\t\tthrowUclawTerminalFailure(err);\n\t\treturn fallbackFailureToCompactionResult(err);');
  result = replaceOnce(result, '\t} catch (err) {\n\t\treturn fail(resolveCompactionFailureReason({',
    '\t} catch (err) {\n\t\tif (err?.code === "COMPACTION_CLEANUP_PENDING" || params.abortSignal?.aborted) throw err;\n\t\tthrowUclawTerminalFailure(err);\n\t\treturn fail(resolveCompactionFailureReason({');
  return addTerminalImport(result);
}

export function rewriteEmbeddedCompaction(content) {
  const source = '} catch (compactErr) {\n';
  const target = source + '\t\t\t\tthrowUclawTerminalFailure(compactErr);\n\t\t\t\tif (compactErr?.code === "COMPACTION_CLEANUP_PENDING" || params.abortSignal?.aborted) throw compactErr;\n';
  if (content.split(target).length === 4) return content;
  if (content.split(source).length !== 4 || content.includes(target)) throw new Error('Unsupported compaction recovery layout');
  return addTerminalImport(content.split(source).join(target));
}

export function rewriteCompactionFallback(content) {
  return replaceOnce(content, '\n\t\tconst err = attemptRun.error;',
    '\n\t\tif (attemptRun.error?.code === "COMPACTION_CLEANUP_PENDING") throw attemptRun.error;\n\t\tconst err = attemptRun.error;');
}

export async function patchOpenClawCompactionRecoveryRuntime(root, fileOps = { writeFile }) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.version !== '2026.6.10') throw new Error(`Expected OpenClaw 2026.6.10, found ${pkg.version}`);
  const rewrites = { bridge: rewriteCompactionBridge, middleware: rewriteCompactionMiddleware, native: rewriteNativeCompaction, embedded: rewriteEmbeddedCompaction, fallback: rewriteCompactionFallback };
  const plans = [];
  for (const [key, name] of Object.entries(COMPACTION_RUNTIME_FILES)) {
    const path = join(root, 'dist', name);
    const original = await readFile(path, 'utf8');
    const content = rewrites[key](original);
    if (original !== content) plans.push({ path, original, content });
  }
  const attempted = [];
  try {
    for (const plan of plans) {
      attempted.push(plan);
      await fileOps.writeFile(plan.path, plan.content, 'utf8');
    }
  } catch (error) {
    const errors = [];
    for (const plan of attempted.reverse()) {
      try { await fileOps.writeFile(plan.path, plan.original, 'utf8'); } catch (rollbackError) { errors.push(rollbackError); }
    }
    if (errors.length) throw new AggregateError([error, ...errors], 'Compaction patch rollback incomplete');
    throw error;
  }
  return { filesPatched: plans.length, filesScanned: Object.keys(rewrites).length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('[patch-openclaw-compaction-recovery]', await patchOpenClawCompactionRecoveryRuntime(resolve('node_modules/openclaw')));
}
