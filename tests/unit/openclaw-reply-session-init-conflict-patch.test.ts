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
    expect(patched).toContain('runUclawReplySessionInitializationInQueue(sessionKey');
    expect(patched).toContain('__uclawReplySessionInitQueued: true');
    expect(patched).toContain('isUclawReplySessionInitializationConflict(error)');
    expect(patched).toContain('retrying after session settle');
    expect(patched).toContain('return await initSessionStateAttempt(params, false);');
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
    expect(patched).toContain('runUclawReplySessionInitializationInQueue(sessionKey');
    expect(patched).toContain('__uclawReplySessionInitQueued: true');
  });
});
