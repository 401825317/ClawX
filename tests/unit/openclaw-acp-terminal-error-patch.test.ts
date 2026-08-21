// @vitest-environment node

import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const patchModulePath = resolve(repoRoot, 'scripts/openclaw-acp-terminal-error-patch.mjs');
const tempRoots = new Set<string>();

const acpStateErrorSource = [
  '\t\tif (state === "error") {',
  '\t\t\tconst stopReason = payload.errorKind === "refusal" ? "refusal" : "end_turn";',
  '\t\t\tthis.finishPrompt(pending.sessionId, pending, stopReason);',
  '\t\t}',
].join('\n');

const acpReconnectErrorSource = [
  '\t\tif (result?.status === "error") {',
  '\t\t\tthis.finishPrompt(sessionId, currentPending, "end_turn");',
  '\t\t\treturn false;',
  '\t\t}',
].join('\n');

const acpRuntimeSource = `
class AcpRuntimeHarness {
\tconstructor() {
\t\tthis.sessionUpdates = { emit: async () => {} };
\t\tthis.log = () => {};
\t}

\tmakePending(params, runId, resolve, reject) {
\t\treturn {
\t\t\t\tsessionId: "session",
\t\t\t\tsessionKey: "agent:pi:s1",
\t\t\t\tidempotencyKey: runId,
\t\t\t\tdisconnectContext: this.activeDisconnectContext ?? void 0,
\t\t\t\tresolve,
\t\t\t\treject
\t\t\t};
\t}

\trejectPendingPrompt(pending, error) {
\t\tpending.reject(error);
\t}

\tfinishPrompt(_sessionId, pending, stopReason) {
\t\tpending.resolve({ stopReason });
\t}

\tasync handleState(state, payload, pending) {
${acpStateErrorSource}
\t}

\tasync reconcile(result, currentPending, sessionId) {
${acpReconnectErrorSource}
\t\treturn true;
\t}
}

export function rejectFromStateError(payload) {
\treturn new Promise((resolve, reject) => {
\t\tconst runtime = new AcpRuntimeHarness();
\t\tconst pending = runtime.makePending({ messageId: "user-state" }, "run-state", resolve, reject);
\t\truntime.handleState("error", payload, pending);
\t});
}

export function rejectFromReconnectError(result) {
\treturn new Promise((resolve, reject) => {
\t\tconst runtime = new AcpRuntimeHarness();
\t\tconst pending = runtime.makePending({ messageId: "user-reconnect" }, "run-reconnect", resolve, reject);
\t\truntime.reconcile(result, pending, pending.sessionId);
\t});
}

/** ACP Agent implementation backed by the OpenClaw Gateway and replay ledger. */
`;

const classifierRuntimeSource = `
function isRateLimitErrorMessage(raw) {
\treturn /rate limit|quota|用户额度不足/i.test(raw);
}
function isBillingErrorMessage(raw) {
\treturn /billing|quota|用户额度不足/i.test(raw);
}
function isAuthErrorMessage(raw) {
\treturn /auth|403|quota|用户额度不足/i.test(raw);
}
function isImageDimensionErrorMessage() {
\treturn false;
}
function toReasonClassification(reason) {
\treturn { kind: "reason", reason };
}
function isRateLimitAssistantError(msg) {
\tif (!msg || msg.stopReason !== "error") return false;
\treturn isRateLimitErrorMessage(msg.errorMessage ?? "");
}
function isBillingAssistantError(msg) {
\tif (!msg || msg.stopReason !== "error") return false;
\treturn isBillingErrorMessage(msg.errorMessage ?? "");
}
function isAuthAssistantError(msg) {
\tif (!msg || msg.stopReason !== "error") return false;
\treturn isAuthErrorMessage(msg.errorMessage ?? "");
}
function classifyFailoverClassificationFromMessage(raw, provider, opts) {
\tif (isImageDimensionErrorMessage(raw)) return null;
\treturn toReasonClassification(provider && opts ? "auth" : "format");
}

export {
\tclassifyFailoverClassificationFromMessage,
\tisAuthAssistantError,
\tisBillingAssistantError,
\tisRateLimitAssistantError,
};
`;

interface AcpRuntimeModule {
  rejectFromReconnectError: (payload: unknown) => Promise<unknown>;
  rejectFromStateError: (payload: unknown) => Promise<unknown>;
}

interface ClassifierRuntimeModule {
  classifyFailoverClassificationFromMessage: (
    raw: string,
    provider?: string,
    opts?: Record<string, unknown>,
  ) => { kind: string; reason: string } | null;
  isAuthAssistantError: (message: Record<string, unknown>) => boolean;
  isBillingAssistantError: (message: Record<string, unknown>) => boolean;
  isRateLimitAssistantError: (message: Record<string, unknown>) => boolean;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

async function importPatchModule(): Promise<typeof import('../../scripts/openclaw-acp-terminal-error-patch.mjs')> {
  const root = await createTempRoot('uclaw-acp-terminal-patch-module-');
  const modulePath = join(root, 'openclaw-acp-terminal-error-patch.mjs');
  const source = (await readFile(patchModulePath, 'utf8')).replace(/^#![^\r\n]*(?:\r?\n|$)/, '');
  await writeFile(modulePath, source, 'utf8');
  return await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}-${Math.random()}`);
}

async function importFixture<T>(prefix: string, source: string): Promise<T> {
  const root = await createTempRoot(prefix);
  const fixturePath = join(root, 'runtime.mjs');
  await writeFile(fixturePath, source, 'utf8');
  return await import(`${pathToFileURL(fixturePath).href}?fixture=${Date.now()}-${Math.random()}`) as T;
}

async function writeOpenClawRuntime(
  version: string,
  acpSource = acpRuntimeSource,
  classifierSource = classifierRuntimeSource,
): Promise<{ acpPath: string; classifierPath: string; root: string }> {
  const root = await createTempRoot('uclaw-acp-terminal-runtime-');
  const dist = join(root, 'dist');
  const acpPath = join(dist, 'acp-cli-test.js');
  const classifierPath = join(dist, 'errors-test.js');
  await mkdir(dist, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ version }), 'utf8');
  await writeFile(acpPath, acpSource, 'utf8');
  await writeFile(classifierPath, classifierSource, 'utf8');
  return { acpPath, classifierPath, root };
}

afterEach(async () => {
  await Promise.all([...tempRoots].map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
  tempRoots.clear();
});

describe('OpenClaw 6.10 ACP terminal error runtime patch', () => {
  it('rejects ACP state=error and preserves the provider error text and cause', async () => {
    expect(existsSync(patchModulePath)).toBe(true);
    const { rewriteAcpTerminalErrors } = await importPatchModule();
    const rewritten = rewriteAcpTerminalErrors(acpRuntimeSource);

    expect(rewritten).toMatchObject({ replacements: 5, supported: true });
    const runtime = await importFixture<AcpRuntimeModule>(
      'uclaw-acp-state-error-',
      rewritten.content,
    );
    const payload = {
      errorMessage: '403 用户额度不足, 请充值后重试',
      state: 'error',
    };

    await expect(runtime.rejectFromStateError(payload)).rejects.toMatchObject({
      cause: payload,
      message: payload.errorMessage,
    });
  });

  it('rejects a reconnect error and preserves nested ACP message text', async () => {
    const { rewriteAcpTerminalErrors } = await importPatchModule();
    const rewritten = rewriteAcpTerminalErrors(acpRuntimeSource);
    const runtime = await importFixture<AcpRuntimeModule>(
      'uclaw-acp-reconnect-error-',
      rewritten.content,
    );
    const result = {
      message: {
        content: [
          { text: '上游连接恢复后仍然失败' },
          { text: '请稍后重试' },
        ],
      },
      status: 'error',
    };

    await expect(runtime.rejectFromReconnectError(result)).rejects.toMatchObject({
      cause: result,
      message: '上游连接恢复后仍然失败\n请稍后重试',
    });
  });

  it.each([
    '403 insufficient_user_quota',
    '403 用户额度不足, 剩余额度: ＄0.000000',
    '预扣费额度失败, 用户剩余额度不足',
    '订阅额度不足或未配置订阅',
  ])('keeps managed quota error out of auth/rate/billing and maps it to terminal format: %s', async (errorMessage) => {
    const { rewriteManagedUserQuotaHandling } = await importPatchModule();
    const rewritten = rewriteManagedUserQuotaHandling(classifierRuntimeSource);

    expect(rewritten).toMatchObject({ replacements: 5, supported: true });
    const runtime = await importFixture<ClassifierRuntimeModule>(
      'uclaw-quota-classifier-',
      rewritten.content,
    );
    const assistantError = { errorMessage, stopReason: 'error' };

    expect(runtime.isRateLimitAssistantError(assistantError)).toBe(false);
    expect(runtime.isBillingAssistantError(assistantError)).toBe(false);
    expect(runtime.isAuthAssistantError(assistantError)).toBe(false);
    expect(runtime.classifyFailoverClassificationFromMessage(errorMessage, 'openai', {})).toEqual({
      kind: 'reason',
      reason: 'format',
    });
  });

  it('patches both supported runtime files and remains idempotent', async () => {
    const { patchOpenClawAcpTerminalErrorRuntime } = await importPatchModule();
    const runtime = await writeOpenClawRuntime('2026.6.10');

    await expect(patchOpenClawAcpTerminalErrorRuntime(runtime.root)).resolves.toEqual({
      filesPatched: 2,
      filesScanned: 2,
    });
    await expect(readFile(runtime.acpPath, 'utf8')).resolves.toContain(
      'await this.rejectPendingPromptWithFailure(pending, payload, "ACP prompt failed");',
    );
    await expect(readFile(runtime.acpPath, 'utf8')).resolves.toContain(
      'sessionUpdate: "uclaw_turn_failure"',
    );
    await expect(readFile(runtime.classifierPath, 'utf8')).resolves.toContain(
      'if (isUclawManagedUserQuotaError(raw)) return toReasonClassification("format");',
    );
    await expect(patchOpenClawAcpTerminalErrorRuntime(runtime.root)).resolves.toEqual({
      filesPatched: 0,
      filesScanned: 2,
    });
  });

  it('rejects an unsupported OpenClaw version', async () => {
    const { patchOpenClawAcpTerminalErrorRuntime } = await importPatchModule();
    const runtime = await writeOpenClawRuntime('2026.6.11');

    await expect(patchOpenClawAcpTerminalErrorRuntime(runtime.root)).rejects.toThrow(
      'Expected OpenClaw 2026.6.10, found 2026.6.11',
    );
  });

  it('rejects unknown ACP and error-classifier runtime layouts', async () => {
    const { patchOpenClawAcpTerminalErrorRuntime } = await importPatchModule();
    const unknownAcp = await writeOpenClawRuntime(
      '2026.6.10',
      'unknown ACP runtime layout',
    );
    await expect(patchOpenClawAcpTerminalErrorRuntime(unknownAcp.root)).rejects.toThrow(
      'Expected exactly one supported OpenClaw ACP CLI runtime, found 0',
    );

    const unknownClassifier = await writeOpenClawRuntime(
      '2026.6.10',
      acpRuntimeSource,
      'unknown error classifier runtime layout',
    );
    await expect(patchOpenClawAcpTerminalErrorRuntime(unknownClassifier.root)).rejects.toThrow(
      'Expected exactly one supported OpenClaw error classifier runtime, found 0',
    );
  });

  it('applies the patch during dependency installation and OpenClaw bundling', async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
      scripts: Record<string, string>;
    };
    const bundleScript = await readFile(join(repoRoot, 'scripts/bundle-openclaw.mjs'), 'utf8');

    expect(packageJson.devDependencies?.openclaw).toBe('2026.6.10');
    expect(packageJson.scripts.postinstall).toContain('openclaw-acp-terminal-error-patch.mjs');
    expect(bundleScript).toContain(
      "import { patchOpenClawAcpTerminalErrorRuntime } from './openclaw-acp-terminal-error-patch.mjs';",
    );
    expect(bundleScript).toContain('await patchOpenClawAcpTerminalErrorRuntime(OUTPUT)');
  });
});
