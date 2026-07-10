import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { patchOpenClawReplySessionInitConflictRuntime } from '../../scripts/openclaw-reply-session-init-conflict-patch.mjs';

describe('OpenClaw reply session init conflict runtime patch', () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('retries reply-session initialization after an ack-time dispatch conflict', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'uclaw-reply-session-init-conflict-patch-'));
    const distDir = join(tempRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    const runtimeFile = join(distDir, 'get-reply-test.js');

    writeFileSync(
      runtimeFile,
      `const log = createSubsystemLogger("session-init");
async function initSessionState(params) {
\treturn await initSessionStateAttempt(params, false);
}
async function initSessionStateAttempt(params, staleSnapshotRetried) {
\tconst sessionKey = canonicalizeMainSessionAlias({
\t\tcfg,
\t\tagentId,
\t\tsessionKey: resolveSessionKey(sessionScope, sessionCtxForState, mainKey)
\t});
\tconst committed = await commitReplySessionInitialization(params);
\tif (!committed.ok) {
\t\tif (!staleSnapshotRetried) return await initSessionStateAttempt(params, true);
\t\tthrow new Error(\`reply session initialization conflicted for \${sessionKey}\`);
\t}
}
`,
      'utf8',
    );

    const result = patchOpenClawReplySessionInitConflictRuntime(distDir, { logger: { log: () => undefined } });
    const patched = readFileSync(runtimeFile, 'utf8');

    expect(result.patchedFiles).toBe(1);
    expect(patched).toContain('UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_TIMEOUT_MS');
    expect(patched).toContain('UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_TIMEOUT_MS = 30000');
    expect(patched).toContain('UCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUE_MARKER');
    expect(patched).toContain('UCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUE_CLEANUP_MARKER');
    expect(patched).toContain('UCLAW_REPLY_SESSION_INIT_CONFLICT_RELOAD_MARKER');
    expect(patched).toContain('runUclawReplySessionInitializationInQueue(sessionKey');
    expect(patched).toContain('__uclawReplySessionInitQueued: true');
    expect(patched).toContain('isUclawReplySessionInitializationConflict(error)');
    expect(patched).toContain('retrying after session settle');
    expect(patched).toContain('const cleanup = run.catch(() => void 0).then(() => {');
    expect(patched).toContain('return await initSessionStateAttempt(params, false);');
    expect(patched).not.toContain('if (!staleSnapshotRetried) return await initSessionStateAttempt(params, true);');
  });

  it('upgrades an already patched runtime with the per-session queue guard', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'uclaw-reply-session-init-conflict-patch-'));
    const distDir = join(tempRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    const runtimeFile = join(distDir, 'get-reply-test.js');

    writeFileSync(
      runtimeFile,
      `const log = createSubsystemLogger("session-init");
const UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_TIMEOUT_MS = 8e3;
const UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_BASE_DELAY_MS = 150;
function isUclawReplySessionInitializationConflict(error) {
\treturn String(error).toLowerCase().includes("reply session initialization conflicted");
}
async function initSessionState(params) {
\treturn await initSessionStateAttempt(params, false);
}
async function initSessionStateAttempt(params, staleSnapshotRetried) {
\tconst sessionKey = canonicalizeMainSessionAlias({
\t\tcfg,
\t\tagentId,
\t\tsessionKey: resolveSessionKey(sessionScope, sessionCtxForState, mainKey)
\t});
\tconst committed = await commitReplySessionInitialization(params);
\tif (!committed.ok) {
\t\tif (!staleSnapshotRetried) return await initSessionStateAttempt(params, true);
\t\tthrow new Error(\`reply session initialization conflicted for \${sessionKey}\`);
\t}
}
`,
      'utf8',
    );

    const result = patchOpenClawReplySessionInitConflictRuntime(distDir, { logger: { log: () => undefined } });
    const patched = readFileSync(runtimeFile, 'utf8');

    expect(result.patchedFiles).toBe(1);
    expect(patched).toContain('UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_TIMEOUT_MS = 30000');
    expect(patched).toContain('UCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUE_MARKER');
    expect(patched).toContain('UCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUE_CLEANUP_MARKER');
    expect(patched).toContain('UCLAW_REPLY_SESSION_INIT_CONFLICT_RELOAD_MARKER');
    expect(patched).toContain('runUclawReplySessionInitializationInQueue(sessionKey');
    expect(patched).toContain('__uclawReplySessionInitQueued: true');
    expect(patched).not.toContain('if (!staleSnapshotRetried) return await initSessionStateAttempt(params, true);');
  });

  it('upgrades the legacy queue cleanup promise so conflict retries do not create unhandled rejections', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'uclaw-reply-session-init-conflict-patch-'));
    const distDir = join(tempRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    const runtimeFile = join(distDir, 'get-reply-test.js');

    writeFileSync(
      runtimeFile,
      `const log = createSubsystemLogger("session-init");
const UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_TIMEOUT_MS = 30000;
const UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_BASE_DELAY_MS = 150;
const UCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUE_MARKER = true;
const UCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUES = globalThis.__uclawReplySessionInitConflictQueues || (globalThis.__uclawReplySessionInitConflictQueues = new Map());
function runUclawReplySessionInitializationInQueue(sessionKey, task) {
\tconst key = String(sessionKey || "__unknown__");
\tconst previous = UCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUES.get(key) || Promise.resolve();
\tconst run = previous.catch(() => void 0).then(task);
\tconst cleanup = run.finally(() => {
\t\tif (UCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUES.get(key) === cleanup) {
\t\t\tUCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUES.delete(key);
\t\t}
\t});
\tUCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUES.set(key, cleanup);
\treturn run;
}
function isUclawReplySessionInitializationConflict(error) {
\treturn String(error).toLowerCase().includes("reply session initialization conflicted");
}
async function initSessionState(params) {
\tconst startedAt = Date.now();
\tlet attempt = 0;
\twhile (true) {
\t\ttry {
\t\t\treturn await initSessionStateAttempt(params, false);
\t\t} catch (error) {
\t\t\tif (!isUclawReplySessionInitializationConflict(error)) throw error;
\t\t\tconst elapsedMs = Date.now() - startedAt;
\t\t\tif (elapsedMs >= UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_TIMEOUT_MS) throw error;
\t\t\tattempt += 1;
\t\t\tconst delayMs = Math.min(1e3, UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_BASE_DELAY_MS * attempt);
\t\t\tlog.warn(\`reply session initialization conflicted; retrying after session settle attempt=\${attempt} elapsedMs=\${elapsedMs} delayMs=\${delayMs}\`);
\t\t\tawait sleepUclawReplySessionInitializationConflictRetry(delayMs);
\t\t}
\t}
}
async function initSessionStateAttempt(params, staleSnapshotRetried) {
\tconst sessionKey = canonicalizeMainSessionAlias({
\t\tcfg,
\t\tagentId,
\t\tsessionKey: resolveSessionKey(sessionScope, sessionCtxForState, mainKey)
\t});
\tif (!params.__uclawReplySessionInitQueued) {
\t\treturn await runUclawReplySessionInitializationInQueue(sessionKey, () => initSessionStateAttempt({
\t\t\t...params,
\t\t\t__uclawReplySessionInitQueued: true
\t\t}, staleSnapshotRetried));
\t}
\tconst committed = await commitReplySessionInitialization(params);
\tif (!committed.ok) {
\t\tif (!staleSnapshotRetried) return await initSessionStateAttempt(params, true);
\t\tthrow new Error(\`reply session initialization conflicted for \${sessionKey}\`);
\t}
}
`,
      'utf8',
    );

    const result = patchOpenClawReplySessionInitConflictRuntime(distDir, { logger: { log: () => undefined } });
    const patched = readFileSync(runtimeFile, 'utf8');

    expect(result.patchedFiles).toBe(1);
    expect(patched).toContain('UCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUE_CLEANUP_MARKER');
    expect(patched).toContain('const cleanup = run.catch(() => void 0).then(() => {');
    expect(patched).not.toContain('const cleanup = run.finally(() => {');
    expect(patched).toContain('UCLAW_REPLY_SESSION_INIT_CONFLICT_RELOAD_MARKER');
    expect(patched).not.toContain('if (!staleSnapshotRetried) return await initSessionStateAttempt(params, true);');
  });

  it('uses stable session entry revisions so key order does not cause stale snapshot loops', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'uclaw-reply-session-init-conflict-patch-'));
    const distDir = join(tempRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    const runtimeFile = join(distDir, 'session-accessor-test.js');

    writeFileSync(
      runtimeFile,
      `function createReplySessionInitializationRevision(entry) {
\treturn JSON.stringify(entry ?? null);
}
`,
      'utf8',
    );

    const result = patchOpenClawReplySessionInitConflictRuntime(distDir, { logger: { log: () => undefined } });
    const patched = readFileSync(runtimeFile, 'utf8');

    expect(result.patchedFiles).toBe(1);
    expect(patched).toContain('UCLAW_REPLY_SESSION_INIT_CONFLICT_STABLE_REVISION_MARKER');
    expect(patched).toContain('Object.keys(value).sort()');
    expect(patched).toContain('function createReplySessionInitializationRevision(entry)');
    expect(patched).not.toContain('return JSON.stringify(entry ?? null);');
  });
});
