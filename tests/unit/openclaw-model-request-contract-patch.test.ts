import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { patchOpenClawModelRequestContractRuntime } from '../../scripts/openclaw-model-request-contract-patch.mjs';

function freshRuntimeSource() {
  return `function buildGuardedModelFetch(model, timeoutMs, options) {
\treturn async (input, init) => {
\t\tlet localServiceLease;
\t\tconst request = input instanceof Request ? new Request(input, init) : void 0;
\t\tconst url = "https://example.test/v1/chat/completions";
\t\tconst baseInit = (request && {
\t\t\tmethod: request.method,
\t\t\theaders: request.headers,
\t\t\tbody: request.body ?? void 0,
\t\t\tredirect: request.redirect,
\t\t\tsignal: request.signal,
\t\t\t...request.body ? { duplex: "half" } : {}
\t\t}) ?? init;
\t\tconst synthesizeJsonAsSse = await requestBodyHasStreamTrue(request, baseInit);
\t\tconst guardedFetchOptions = { url, init: baseInit };
\t\tlet result;
\t\tconst useEnvProxy = false;
\t\ttry {
\t\t\tlocalServiceLease = await ensureModelProviderLocalService(model, baseInit?.headers, localServiceSignal);
\t\t\tresult = await fetchWithSsrFGuard(useEnvProxy ? withTrustedEnvProxyGuardedFetchMode(guardedFetchOptions) : guardedFetchOptions);
\t\t} catch (error) {
\t\t\tthrow error;
\t\t}
\t\treturn result;
\t};
}
`;
}

function contractOnlyRuntimeSource() {
  return `const UCLAW_MODEL_REQUEST_CONTRACT_DIAGNOSTIC = "safe-summary-v1";
function buildUClawModelRequestContractSummary(model, init) {
\treturn { diagnostic: UCLAW_MODEL_REQUEST_CONTRACT_DIAGNOSTIC };
}
function buildGuardedModelFetch(model, timeoutMs, options) {
\treturn async (input, init) => {
\t\tlet localServiceLease;
\t\tconst request = input instanceof Request ? new Request(input, init) : void 0;
\t\tconst url = "https://example.test/v1/chat/completions";
\t\tconst baseInit = (request && {
\t\t\tmethod: request.method,
\t\t\theaders: request.headers,
\t\t\tbody: request.body ?? void 0,
\t\t\tredirect: request.redirect,
\t\t\tsignal: request.signal,
\t\t\t...request.body ? { duplex: "half" } : {}
\t\t}) ?? init;
\t\tconst modelRequestContractSummary = buildUClawModelRequestContractSummary(model, baseInit);
\t\tconst synthesizeJsonAsSse = await requestBodyHasStreamTrue(request, baseInit);
\t\tconst guardedFetchOptions = { url, init: baseInit };
\t\tlet result;
\t\tconst useEnvProxy = false;
\t\ttry {
\t\t\tlocalServiceLease = await ensureModelProviderLocalService(model, baseInit?.headers, localServiceSignal);
\t\t\tlog$1.info(\`[model-request-contract] \${JSON.stringify(modelRequestContractSummary)}\`);
\t\t\tresult = await fetchWithSsrFGuard(useEnvProxy ? withTrustedEnvProxyGuardedFetchMode(guardedFetchOptions) : guardedFetchOptions);
\t\t} catch (error) {
\t\t\tthrow error;
\t\t}
\t\treturn result;
\t};
}
`;
}

describe('OpenClaw model request contract runtime patch', () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  function makeRuntimeFile(source: string) {
    tempRoot = mkdtempSync(join(tmpdir(), 'uclaw-model-request-contract-patch-'));
    const distDir = join(tempRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    const runtimeFile = join(distDir, 'openai-transport-test.js');
    writeFileSync(runtimeFile, source, 'utf8');
    return { distDir, runtimeFile };
  }

  it('adds request contract diagnostics and light chat reasoning override to fresh runtimes', () => {
    const { distDir, runtimeFile } = makeRuntimeFile(freshRuntimeSource());

    const result = patchOpenClawModelRequestContractRuntime(distDir, { logger: { log: () => undefined } });
    const patched = readFileSync(runtimeFile, 'utf8');

    expect(result.patchedFiles).toBe(1);
    expect(patched).toContain('UCLAW_MODEL_REQUEST_CONTRACT_DIAGNOSTIC');
    expect(patched).toContain('UCLAW_LIGHT_CHAT_MODEL_REQUEST_OVERRIDE');
    expect(patched).toContain('let baseInit = (request && {');
    expect(patched).toContain('baseInit = applyUClawLightChatModelRequestOverride(baseInit');
    expect(patched).toContain('log$1.info(`[model-request-light-chat] ${JSON.stringify(event)}`);');
    expect(patched).toContain('const modelRequestContractSummary = buildUClawModelRequestContractSummary(model, baseInit);');
  });

  it('upgrades runtimes that already had only the request contract diagnostic patch', () => {
    const first = makeRuntimeFile(contractOnlyRuntimeSource());

    const result = patchOpenClawModelRequestContractRuntime(first.distDir, { logger: { log: () => undefined } });
    const upgraded = readFileSync(first.runtimeFile, 'utf8');

    expect(result.patchedFiles).toBe(1);
    expect(upgraded).toContain('UCLAW_LIGHT_CHAT_MODEL_REQUEST_OVERRIDE');
    expect(upgraded).toContain('let baseInit = (request && {');
    expect(upgraded).toContain('baseInit = applyUClawLightChatModelRequestOverride(baseInit');
  });

  it('recognizes webchat light prompts after stripping sender metadata', () => {
    const { distDir, runtimeFile } = makeRuntimeFile(freshRuntimeSource());
    patchOpenClawModelRequestContractRuntime(distDir, { logger: { log: () => undefined } });
    const patched = readFileSync(runtimeFile, 'utf8');

    expect(patched).toContain('UCLAW_SENDER_METADATA_RE');
    expect(patched).toContain('UCLAW_QUEUED_USER_MESSAGE_MARKER_RE');
    expect(patched).toContain('\\\\x60\\\\x60\\\\x60(?:json)?');
    expect(patched).toContain('getUClawLightChatPromptSegments');
    expect(patched).toContain('classification.reason === "capability_question"');
    expect(patched).toContain('text.trim().replace(UCLAW_SENDER_METADATA_RE, "")');
    expect(patched).toContain('UCLAW_QUEUED_USER_MESSAGE_MARKER_RE.test(normalized)');
  });

  it('upgrades older light chat helpers that do not strip webchat sender metadata or queued merge markers', () => {
    const first = makeRuntimeFile(freshRuntimeSource());
    patchOpenClawModelRequestContractRuntime(first.distDir, { logger: { log: () => undefined } });
    const oldPatched = readFileSync(first.runtimeFile, 'utf8')
      .replaceAll('UCLAW_QUEUED_USER_MESSAGE_MARKER_RE', 'UCLAW_OLD_QUEUED_USER_MESSAGE_MARKER_RE');
    writeFileSync(first.runtimeFile, oldPatched, 'utf8');

    const result = patchOpenClawModelRequestContractRuntime(first.distDir, { logger: { log: () => undefined } });
    const upgraded = readFileSync(first.runtimeFile, 'utf8');

    expect(result.patchedFiles).toBe(1);
    expect(upgraded).toContain('UCLAW_SENDER_METADATA_RE');
    expect(upgraded).toContain('UCLAW_QUEUED_USER_MESSAGE_MARKER_RE');
    expect(upgraded).not.toContain('UCLAW_OLD_QUEUED_USER_MESSAGE_MARKER_RE');
    expect(upgraded).toContain('\\\\x60\\\\x60\\\\x60(?:json)?');
  });
});
