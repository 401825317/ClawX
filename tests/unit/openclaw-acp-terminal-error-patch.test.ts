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

const acpReplayTranscriptSource = [
  '\tasync replaySessionTranscript(sessionId, transcript) {',
  '\t\tfor (const message of transcript) {',
  '\t\t\tconst replayChunks = extractReplayChunks(message);',
  '\t\t\tfor (const chunk of replayChunks) await this.sessionUpdates.emit({',
  '\t\t\t\tsessionId,',
  '\t\t\t\tupdate: {',
  '\t\t\t\t\tsessionUpdate: chunk.sessionUpdate,',
  '\t\t\t\t\tcontent: {',
  '\t\t\t\t\t\ttype: "text",',
  '\t\t\t\t\t\ttext: chunk.text',
  '\t\t\t\t\t}',
  '\t\t\t\t}',
  '\t\t\t});',
  '\t\t}',
  '\t}',
].join('\n');

const acpRuntimeSource = `
function extractReplayChunks(message) {
\tif (!message || (message.role !== "user" && message.role !== "assistant")) return [];
\tconst text = typeof message.content === "string"
\t\t? message.content
\t\t: Array.isArray(message.content)
\t\t\t? message.content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\\n")
\t\t\t: "";
\treturn text ? [{
\t\tsessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
\t\ttext
\t}] : [];
}

class AcpRuntimeHarness {
\tconstructor(transcript = []) {
\t\tthis.transcript = transcript;
\t\tthis.emitted = [];
\t\tthis.sessionUpdates = { emit: async (notification) => { this.emitted.push(notification); } };
\t\tthis.log = () => {};
\t\tthis.gateway = { request: async () => ({ messages: this.transcript }) };
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

\tasync getSessionTranscript(sessionKey) {
\t\tconst result = await this.gateway.request("sessions.get", {
\t\t\tkey: sessionKey,
\t\t\tlimit: 100
\t\t});
\t\tif (!Array.isArray(result.messages)) return [];
\t\treturn result.messages;
\t}

${acpReplayTranscriptSource}
}

export function rejectFromStateError(payload, transcript = []) {
\treturn new Promise((resolve, reject) => {
\t\tconst runtime = new AcpRuntimeHarness(transcript);
\t\tconst pending = runtime.makePending({ messageId: "user-state" }, "run-state", resolve, reject);
\t\truntime.handleState("error", payload, pending);
\t});
}

export async function captureStateError(payload, transcript = []) {
\tconst runtime = new AcpRuntimeHarness(transcript);
\tlet caught;
\ttry {
\t\tawait new Promise((resolve, reject) => {
\t\t\tconst pending = runtime.makePending({ messageId: "user-state" }, "run-state", resolve, reject);
\t\t\truntime.handleState("error", payload, pending);
\t\t});
\t} catch (error) {
\t\tcaught = error;
\t}
\treturn { error: caught, emitted: runtime.emitted };
}

export function rejectFromReconnectError(result) {
\treturn new Promise((resolve, reject) => {
\t\tconst runtime = new AcpRuntimeHarness();
\t\tconst pending = runtime.makePending({ messageId: "user-reconnect" }, "run-reconnect", resolve, reject);
\t\truntime.reconcile(result, pending, pending.sessionId);
\t});
}

export async function replayTranscript(transcript) {
\tconst runtime = new AcpRuntimeHarness(transcript);
\tawait runtime.replaySessionTranscript("session", transcript);
\treturn runtime.emitted;
}

/** ACP Agent implementation backed by the OpenClaw Gateway and replay ledger. */
`;

function legacyPatchedAcpRuntimeSource(): string {
  const helperMarker = '/** ACP Agent implementation backed by the OpenClaw Gateway and replay ledger. */';
  const legacyHelper = [
    'function buildAcpPromptError(value, fallback) {',
    '\tconst record = value && typeof value === "object" ? value : void 0;',
    '\tconst messageText = record?.message && typeof record.message === "object" && Array.isArray(record.message.content) ? record.message.content.map((block) => typeof block?.text === "string" ? block.text : "").filter(Boolean).join("\\n").trim() : "";',
    '\tconst message = typeof record?.errorMessage === "string" && record.errorMessage.trim() || typeof record?.error === "string" && record.error.trim() || typeof record?.message === "string" && record.message.trim() || messageText || fallback;',
    '\treturn new Error(message, { cause: value });',
    '}',
    helperMarker,
  ].join('\n');
  const pendingSource = [
    '\t\t\t\tidempotencyKey: runId,',
    '\t\t\t\tdisconnectContext: this.activeDisconnectContext ?? void 0,',
  ].join('\n');
  const pendingTarget = [
    '\t\t\t\tidempotencyKey: runId,',
    '\t\t\t\tuserMessageId: typeof params.messageId === "string" && params.messageId.trim() || runId,',
    '\t\t\t\tdisconnectContext: this.activeDisconnectContext ?? void 0,',
  ].join('\n');
  const rejectSource = '\trejectPendingPrompt(pending, error) {';
  const legacyReject = [
    '\tasync rejectPendingPromptWithFailure(pending, value, fallback) {',
    '\t\tconst error = buildAcpPromptError(value, fallback);',
    '\t\ttry {',
    '\t\t\tawait this.sessionUpdates.emit({',
    '\t\t\t\tsessionId: pending.sessionId,',
    '\t\t\t\tsessionKey: pending.sessionKey,',
    '\t\t\t\t...pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {},',
    '\t\t\t\trunId: pending.idempotencyKey,',
    '\t\t\t\trecord: true,',
    '\t\t\t\tupdate: {',
    '\t\t\t\t\tsessionUpdate: "uclaw_turn_failure",',
    '\t\t\t\t\tuserMessageId: pending.userMessageId,',
    '\t\t\t\t\terrorMessage: error.message',
    '\t\t\t\t}',
    '\t\t\t});',
    '\t\t} catch (recordError) {',
    '\t\t\tthis.log(`terminal prompt failure record failed for ${pending.sessionId}: ${String(recordError)}`);',
    '\t\t}',
    '\t\tthis.rejectPendingPrompt(pending, error);',
    '\t}',
    rejectSource,
  ].join('\n');
  const stateTarget = [
    '\t\tif (state === "error") {',
    '\t\t\tawait this.rejectPendingPromptWithFailure(pending, payload, "ACP prompt failed");',
    '\t\t}',
  ].join('\n');
  const reconnectTarget = [
    '\t\tif (result?.status === "error") {',
    '\t\t\tawait this.rejectPendingPromptWithFailure(currentPending, result, "ACP prompt failed after reconnect");',
    '\t\t\treturn false;',
    '\t\t}',
  ].join('\n');

  return acpRuntimeSource
    .replace(helperMarker, legacyHelper)
    .replace(pendingSource, pendingTarget)
    .replace(rejectSource, legacyReject)
    .replace(acpStateErrorSource, stateTarget)
    .replace(acpReconnectErrorSource, reconnectTarget);
}

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
  captureStateError: (payload: unknown, transcript?: unknown[]) => Promise<{
    emitted: Array<{ update?: Record<string, unknown> }>;
    error: Error;
  }>;
  replayTranscript: (transcript: unknown[]) => Promise<Array<{ update?: Record<string, unknown> }>>;
  rejectFromReconnectError: (payload: unknown) => Promise<unknown>;
  rejectFromStateError: (payload: unknown, transcript?: unknown[]) => Promise<unknown>;
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

    expect(rewritten).toMatchObject({ replacements: 6, supported: true });
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

  it('recovers the current quota failure from the transcript when ACP only returns a generic error', async () => {
    const { rewriteAcpTerminalErrors } = await importPatchModule();
    const rewritten = rewriteAcpTerminalErrors(acpRuntimeSource);
    const runtime = await importFixture<AcpRuntimeModule>(
      'uclaw-acp-transcript-quota-',
      rewritten.content,
    );
    const payload = {
      data: { details: 'LLM request failed: provider rejected the request schema or tool payload.' },
      state: 'error',
    };
    const quotaError = '400 insufficient_user_quota: deterministic regression balance exhausted';
    const transcript = [
      { role: 'user', content: 'old turn', idempotencyKey: 'old-user' },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: '400 insufficient_user_quota: old failure',
        errorCode: 'insufficient_user_quota',
      },
      { role: 'user', content: 'current turn', idempotencyKey: 'current-user' },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: quotaError,
        errorCode: 'insufficient_user_quota',
      },
    ];

    const result = await runtime.captureStateError(payload, transcript);

    expect(result.error).toMatchObject({ cause: payload, message: quotaError });
    expect(result.emitted).toContainEqual(expect.objectContaining({
      update: {
        sessionUpdate: 'uclaw_turn_failure',
        userMessageId: 'user-state',
        errorMessage: quotaError,
        errorCode: 'insufficient_user_quota',
      },
    }));
  });

  it('does not reuse a quota failure that occurred before the latest user turn', async () => {
    const { rewriteAcpTerminalErrors } = await importPatchModule();
    const rewritten = rewriteAcpTerminalErrors(acpRuntimeSource);
    const runtime = await importFixture<AcpRuntimeModule>(
      'uclaw-acp-transcript-old-quota-',
      rewritten.content,
    );
    const genericError = 'LLM request failed: provider rejected the request schema or tool payload.';
    const payload = { errorMessage: genericError, state: 'error' };
    const transcript = [
      { role: 'user', content: 'old turn', idempotencyKey: 'old-user' },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: '400 insufficient_user_quota: old failure',
        errorCode: 'insufficient_user_quota',
      },
      { role: 'user', content: 'current turn', idempotencyKey: 'current-user' },
    ];

    const result = await runtime.captureStateError(payload, transcript);

    expect(result.error.message).toBe(genericError);
    expect(result.emitted).toContainEqual(expect.objectContaining({
      update: {
        sessionUpdate: 'uclaw_turn_failure',
        userMessageId: 'user-state',
        errorMessage: genericError,
      },
    }));
  });

  it('replays transcript terminal failures when the ACP ledger is incomplete', async () => {
    const { rewriteAcpTerminalErrors } = await importPatchModule();
    const rewritten = rewriteAcpTerminalErrors(acpRuntimeSource);
    const runtime = await importFixture<AcpRuntimeModule>(
      'uclaw-acp-transcript-replay-',
      rewritten.content,
    );
    const quotaError = '400 insufficient_user_quota: deterministic regression balance exhausted';

    const emitted = await runtime.replayTranscript([
      { role: 'user', content: 'chargeable operation', idempotencyKey: 'quota-user' },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: quotaError,
        errorCode: 'insufficient_user_quota',
      },
    ]);

    expect(emitted).toEqual([
      {
        sessionId: 'session',
        update: {
          sessionUpdate: 'user_message_chunk',
          messageId: 'quota-user',
          content: { type: 'text', text: 'chargeable operation' },
        },
      },
      {
        sessionId: 'session',
        update: {
          sessionUpdate: 'uclaw_turn_failure',
          userMessageId: 'quota-user',
          errorMessage: quotaError,
          errorCode: 'insufficient_user_quota',
        },
      },
    ]);
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

  it('upgrades the previous ACP patch without duplicating helper methods', async () => {
    const { rewriteAcpTerminalErrors } = await importPatchModule();
    const upgraded = rewriteAcpTerminalErrors(legacyPatchedAcpRuntimeSource());

    expect(upgraded).toMatchObject({ replacements: 3, supported: true });
    expect(upgraded.content.match(/function buildAcpPromptError\(/gu)).toHaveLength(1);
    expect(upgraded.content.match(/async rejectPendingPromptWithFailure\(/gu)).toHaveLength(1);
    expect(upgraded.content).toContain('findUclawLatestTurnTranscriptError');
    expect(upgraded.content).toContain('sessionUpdate: "uclaw_turn_failure"');

    expect(rewriteAcpTerminalErrors(upgraded.content)).toMatchObject({
      content: upgraded.content,
      replacements: 0,
      supported: true,
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
