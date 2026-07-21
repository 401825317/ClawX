import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  patchOpenClawProcessControlSemanticsContent,
  patchOpenClawProcessControlSemanticsRuntime,
} from './openclaw-process-control-semantics-patch.mjs';

const processFixture = `
function createProcessTool(defaults) {
\treturn {
\t\texecute: async (_toolCallId, args) => {
\t\t\tconst params = args;
\t\t\tconst scopedSession = getSession(params.sessionId);
\t\t\tconst scopedFinished = getFinishedSession(params.sessionId);
\t\t\t\tcase "kill": {
\t\t\t\t\tif (!scopedSession) return failText(\`No active session found for \${params.sessionId}\`);
\t\t\t\t\tif (!scopedSession.backgrounded) return failText(\`Session \${params.sessionId} is not backgrounded.\`);
\t\t\t\t\tconst canceled = cancelManagedSession(scopedSession.id);
\t\t\t\t\tif (!canceled) {
\t\t\t\t\t\tif (!terminateSessionFallback(scopedSession)) return failText(\`Unable to terminate session \${params.sessionId}: no active supervisor run or process id.\`);
\t\t\t\t\t\tmarkExited(scopedSession, null, "SIGKILL", "failed");
\t\t\t\t\t}
\t\t\t\t\tresetPollRetrySuggestion(params.sessionId);
\t\t\t\t\treturn {
\t\t\t\t\t\tcontent: [{
\t\t\t\t\t\t\ttype: "text",
\t\t\t\t\t\t\ttext: canceled ? \`Termination requested for session \${params.sessionId}.\` : \`Killed session \${params.sessionId}.\`
\t\t\t\t\t\t}],
\t\t\t\t\t\tdetails: {
\t\t\t\t\t\t\tstatus: "failed",
\t\t\t\t\t\t\tname: scopedSession ? deriveSessionName(scopedSession.command) : void 0
\t\t\t\t\t\t}
\t\t\t\t\t};
\t\t\t\t}
\t\t\t\tcase "clear":
\t\t\t\t\tif (scopedFinished) return { details: { status: "completed" } };
\t\t\t\t\treturn { details: { status: "failed" } };
\t\t\t\tcase "remove":
\t\t\t\t\tif (scopedSession) {
\t\t\t\t\t\tconst canceled = cancelManagedSession(scopedSession.id);
\t\t\t\t\t\tif (canceled) {
\t\t\t\t\t\t\tscopedSession.backgrounded = false;
\t\t\t\t\t\t\tdeleteSession(params.sessionId);
\t\t\t\t\t\t} else {
\t\t\t\t\t\t\tif (!terminateSessionFallback(scopedSession)) return failText(\`Unable to remove session \${params.sessionId}: no active supervisor run or process id.\`);
\t\t\t\t\t\t\tmarkExited(scopedSession, null, "SIGKILL", "failed");
\t\t\t\t\t\t\tdeleteSession(params.sessionId);
\t\t\t\t\t\t}
\t\t\t\t\t\tresetPollRetrySuggestion(params.sessionId);
\t\t\t\t\t\treturn {
\t\t\t\t\t\t\tcontent: [{
\t\t\t\t\t\t\t\ttype: "text",
\t\t\t\t\t\t\t\ttext: canceled ? \`Removed session \${params.sessionId} (termination requested).\` : \`Removed session \${params.sessionId}.\`
\t\t\t\t\t\t\t}],
\t\t\t\t\t\t\tdetails: {
\t\t\t\t\t\t\t\tstatus: "failed",
\t\t\t\t\t\t\t\tname: scopedSession ? deriveSessionName(scopedSession.command) : void 0
\t\t\t\t\t\t\t}
\t\t\t\t\t\t};
\t\t\t\t\t}
\t\t\t\t\tif (scopedFinished) return { details: { status: "completed" } };
\t\t\t\t\treturn { details: { status: "failed" } };
\t\t}
\t};
}`;

const exitNotifyFixture = `
function buildExecExitOutcome(params) {
\tconst exitCode = params.exit.exitCode ?? 0;
\tconst isNormalExit = params.exit.reason === "exit";
\tconst isShellFailure = exitCode === 126 || exitCode === 127;
\tif ((isNormalExit && !isShellFailure ? "completed" : "failed") === "completed") {
\t\treturn { status: "completed", exitCode };
\t}
\treturn { status: "failed", exitCode };
}
function maybeNotifyOnExit(session, status) {
\tif (!session.backgrounded || !session.notifyOnExit || session.exitNotified) return;
\tconst sessionKey = session.sessionKey?.trim();
\tif (!sessionKey) return;
\tsession.exitNotified = true;
\tconst exitLabel = session.exitSignal ? \`signal \${session.exitSignal}\` : \`code \${session.exitCode ?? 0}\`;
\tconst output = compactNotifyOutput(tail(session.tail || session.aggregated || "", 400));
\tif (status === "failed" && session.exitReason === "manual-cancel" && !output) return;
\tif (status === "completed" && !output && session.notifyOnExitEmptySuccess !== true) return;
\tconst summary = output ? \`Exec \${status} (\${session.id.slice(0, 8)}, \${exitLabel}) :: \${output}\` : \`Exec \${status} (\${session.id.slice(0, 8)}, \${exitLabel})\`;
\tenqueueSystemEvent(summary, { sessionKey });
\trequestHeartbeat({ source: "exec-event", reason: "exec-event" });
}`;

test('successful kill and remove are completed control operations', () => {
  const result = patchOpenClawProcessControlSemanticsContent(processFixture, 'bash-tools.js');
  assert.equal(result.changed, true);
  assert.equal(result.matched, true);
  assert.equal(result.kind, 'process-control');
  assert.match(result.content, /case "kill": \{ \/\/ UCLAW_PROCESS_KILL_SUCCESS_V1/u);
  assert.match(result.content, /case "remove": \/\/ UCLAW_PROCESS_REMOVE_SUCCESS_V1/u);
  assert.equal((result.content.match(/status: "completed"/gu) ?? []).length, 4);
  assert.equal((result.content.match(/expectedTermination: true/gu) ?? []).length, 2);
  assert.equal((result.content.match(/terminationReason: "manual-cancel"/gu) ?? []).length, 2);
  assert.equal((result.content.match(/"SIGKILL", "completed", "manual-cancel"/gu) ?? []).length, 2);
  assert.match(result.content, /Unable to terminate session .* no active supervisor run or process id/u);
  assert.match(result.content, /Unable to remove session .* no active supervisor run or process id/u);
  assert.equal(patchOpenClawProcessControlSemanticsContent(result.content, 'bash-tools.js').changed, false);
});

test('manual cancellation never creates an exec exit event even when output exists', () => {
  const result = patchOpenClawProcessControlSemanticsContent(exitNotifyFixture, 'bash-tools.exec-runtime.js');
  assert.equal(result.changed, true);
  assert.equal(result.kind, 'exit-notify');
  assert.match(result.content, /if \(session\.exitReason === "manual-cancel"\) return; \/\/ UCLAW_MANUAL_CANCEL_NO_EXEC_EVENT_V1/u);
  assert.match(result.content, /isExpectedManualCancel = params\.exit\.reason === "manual-cancel"; \/\/ UCLAW_MANUAL_CANCEL_COMPLETED_OUTCOME_V1/u);
  assert.match(result.content, /isExpectedManualCancel \|\| isNormalExit && !isShellFailure/u);
  assert.doesNotMatch(result.content, /session\.exitReason === "manual-cancel" && !output/u);
  assert.match(result.content, /requestHeartbeat\(\{ source: "exec-event", reason: "exec-event" \}\)/u);

  const buildOutcome = Function(`${result.content}\nreturn buildExecExitOutcome;`)();
  assert.equal(buildOutcome({ exit: { reason: 'manual-cancel', exitCode: null } }).status, 'completed');
  assert.equal(buildOutcome({ exit: { reason: 'exit', exitCode: 0 } }).status, 'completed');
  assert.equal(buildOutcome({ exit: { reason: 'overall-timeout', exitCode: null } }).status, 'failed');
  assert.equal(buildOutcome({ exit: { reason: 'exit', exitCode: 127 } }).status, 'failed');

  let enqueued = 0;
  let heartbeatRequested = 0;
  const maybeNotify = Function(
    'compactNotifyOutput',
    'tail',
    'enqueueSystemEvent',
    'requestHeartbeat',
    `${result.content}\nreturn maybeNotifyOnExit;`,
  )(
    (value) => value,
    (value) => value,
    () => { enqueued += 1; },
    () => { heartbeatRequested += 1; },
  );
  maybeNotify({
    backgrounded: true,
    notifyOnExit: true,
    exitNotified: false,
    sessionKey: 'agent:main:main',
    exitReason: 'manual-cancel',
    exitSignal: 'SIGTERM',
    tail: 'historical server output',
    id: 'manual-cancel-session',
  }, 'completed');
  assert.equal(enqueued, 0);
  assert.equal(heartbeatRequested, 0);
  maybeNotify({
    backgrounded: true,
    notifyOnExit: true,
    exitNotified: false,
    sessionKey: 'agent:main:main',
    exitReason: 'overall-timeout',
    exitSignal: 'SIGKILL',
    tail: 'timeout output',
    id: 'real-failure-session',
  }, 'failed');
  assert.equal(enqueued, 1);
  assert.equal(heartbeatRequested, 1);
  assert.equal(patchOpenClawProcessControlSemanticsContent(result.content, 'bash-tools.exec-runtime.js').changed, false);
});

test('patch fails closed on a partially patched process runtime', () => {
  const partiallyPatched = processFixture.replace(
    'case "kill": {',
    'case "kill": { // UCLAW_PROCESS_KILL_SUCCESS_V1',
  );
  assert.throws(
    () => patchOpenClawProcessControlSemanticsContent(partiallyPatched, 'partial.js'),
    /only partially patched/u,
  );
});

test('runtime patch is fail-closed and idempotent across both OpenClaw chunks', () => {
  const distDir = mkdtempSync(join(tmpdir(), 'uclaw-process-semantics-'));
  const processFile = join(distDir, 'bash-tools.js');
  const exitNotifyFile = join(distDir, 'bash-tools.exec-runtime.js');
  writeFileSync(processFile, processFixture, 'utf8');
  writeFileSync(exitNotifyFile, exitNotifyFixture, 'utf8');
  writeFileSync(join(distDir, 'unrelated.js'), 'export const untouched = true;', 'utf8');

  const first = patchOpenClawProcessControlSemanticsRuntime(distDir, { logger: { log() {} } });
  assert.equal(first.patchedFiles, 2);
  assert.match(readFileSync(processFile, 'utf8'), /UCLAW_PROCESS_KILL_SUCCESS_V1/u);
  assert.match(readFileSync(exitNotifyFile, 'utf8'), /UCLAW_MANUAL_CANCEL_NO_EXEC_EVENT_V1/u);

  const second = patchOpenClawProcessControlSemanticsRuntime(distDir, { logger: { log() {} } });
  assert.equal(second.patchedFiles, 0);
  assert.equal(second.alreadyPatchedFiles, 2);
});

test('runtime patch rejects a missing required chunk', () => {
  const distDir = mkdtempSync(join(tmpdir(), 'uclaw-process-semantics-missing-'));
  writeFileSync(join(distDir, 'bash-tools.js'), processFixture, 'utf8');
  assert.throws(
    () => patchOpenClawProcessControlSemanticsRuntime(distDir, { logger: { log() {} } }),
    /found 1 and 0/u,
  );
});

test('current installed OpenClaw runtime matches both fail-closed anchors', () => {
  const result = patchOpenClawProcessControlSemanticsRuntime(
    join(process.cwd(), 'node_modules', 'openclaw', 'dist'),
    { dryRun: true, logger: { log() {} } },
  );
  assert.equal(result.patchedFiles + result.alreadyPatchedFiles, 2);
});
