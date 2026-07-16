import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_NAME = 'openclaw-process-control-semantics-patch';
const PROCESS_RUNTIME_SIGNATURE = 'function createProcessTool(defaults) {';
const EXIT_NOTIFY_RUNTIME_SIGNATURE = 'function maybeNotifyOnExit(session, status) {';
const KILL_PATCH_MARKER = 'UCLAW_PROCESS_KILL_SUCCESS_V1';
const REMOVE_PATCH_MARKER = 'UCLAW_PROCESS_REMOVE_SUCCESS_V1';
const MANUAL_CANCEL_NOTIFY_PATCH_MARKER = 'UCLAW_MANUAL_CANCEL_NO_EXEC_EVENT_V1';
const MANUAL_CANCEL_OUTCOME_PATCH_MARKER = 'UCLAW_MANUAL_CANCEL_COMPLETED_OUTCOME_V1';

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function replaceUnique(content, search, replacement, label, filePath) {
  const count = countOccurrences(content, search);
  if (count !== 1) {
    throw new Error(`[${PATCH_NAME}] Expected exactly one ${label} anchor in ${filePath}; found ${count}.`);
  }
  return content.replace(search, replacement);
}

const KILL_ANCHOR = `\t\t\t\tcase "kill": {
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
\t\t\t\t}`;

const KILL_PATCH = `\t\t\t\tcase "kill": { // ${KILL_PATCH_MARKER}
\t\t\t\t\tif (!scopedSession) return failText(\`No active session found for \${params.sessionId}\`);
\t\t\t\t\tif (!scopedSession.backgrounded) return failText(\`Session \${params.sessionId} is not backgrounded.\`);
\t\t\t\t\tconst canceled = cancelManagedSession(scopedSession.id);
\t\t\t\t\tif (!canceled) {
\t\t\t\t\t\tif (!terminateSessionFallback(scopedSession)) return failText(\`Unable to terminate session \${params.sessionId}: no active supervisor run or process id.\`);
\t\t\t\t\t\tmarkExited(scopedSession, null, "SIGKILL", "completed", "manual-cancel");
\t\t\t\t\t}
\t\t\t\t\tresetPollRetrySuggestion(params.sessionId);
\t\t\t\t\treturn {
\t\t\t\t\t\tcontent: [{
\t\t\t\t\t\t\ttype: "text",
\t\t\t\t\t\t\ttext: canceled ? \`Termination requested for session \${params.sessionId}.\` : \`Killed session \${params.sessionId}.\`
\t\t\t\t\t\t}],
\t\t\t\t\t\tdetails: {
\t\t\t\t\t\t\tstatus: "completed",
\t\t\t\t\t\t\tprocessStatus: canceled ? "termination-requested" : "terminated",
\t\t\t\t\t\t\tterminationReason: "manual-cancel",
\t\t\t\t\t\t\texpectedTermination: true,
\t\t\t\t\t\t\tname: scopedSession ? deriveSessionName(scopedSession.command) : void 0
\t\t\t\t\t\t}
\t\t\t\t\t};
\t\t\t\t}`;

const REMOVE_ANCHOR = `\t\t\t\tcase "remove":
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
\t\t\t\t\t}`;

const REMOVE_PATCH = `\t\t\t\tcase "remove": // ${REMOVE_PATCH_MARKER}
\t\t\t\t\tif (scopedSession) {
\t\t\t\t\t\tconst canceled = cancelManagedSession(scopedSession.id);
\t\t\t\t\t\tif (canceled) {
\t\t\t\t\t\t\tscopedSession.backgrounded = false;
\t\t\t\t\t\t\tdeleteSession(params.sessionId);
\t\t\t\t\t\t} else {
\t\t\t\t\t\t\tif (!terminateSessionFallback(scopedSession)) return failText(\`Unable to remove session \${params.sessionId}: no active supervisor run or process id.\`);
\t\t\t\t\t\t\tmarkExited(scopedSession, null, "SIGKILL", "completed", "manual-cancel");
\t\t\t\t\t\t\tdeleteSession(params.sessionId);
\t\t\t\t\t\t}
\t\t\t\t\t\tresetPollRetrySuggestion(params.sessionId);
\t\t\t\t\t\treturn {
\t\t\t\t\t\t\tcontent: [{
\t\t\t\t\t\t\t\ttype: "text",
\t\t\t\t\t\t\t\ttext: canceled ? \`Removed session \${params.sessionId} (termination requested).\` : \`Removed session \${params.sessionId}.\`
\t\t\t\t\t\t\t}],
\t\t\t\t\t\t\tdetails: {
\t\t\t\t\t\t\t\tstatus: "completed",
\t\t\t\t\t\t\t\tprocessStatus: canceled ? "termination-requested" : "terminated",
\t\t\t\t\t\t\t\tterminationReason: "manual-cancel",
\t\t\t\t\t\t\t\texpectedTermination: true,
\t\t\t\t\t\t\t\tname: scopedSession ? deriveSessionName(scopedSession.command) : void 0
\t\t\t\t\t\t\t}
\t\t\t\t\t\t};
\t\t\t\t\t}`;

const MANUAL_CANCEL_NOTIFY_ANCHOR = '\tif (status === "failed" && session.exitReason === "manual-cancel" && !output) return;';
const MANUAL_CANCEL_NOTIFY_PATCH = `\tif (session.exitReason === "manual-cancel") return; // ${MANUAL_CANCEL_NOTIFY_PATCH_MARKER}`;
const MANUAL_CANCEL_OUTCOME_ANCHOR = `\tconst isNormalExit = params.exit.reason === "exit";
\tconst isShellFailure = exitCode === 126 || exitCode === 127;
\tif ((isNormalExit && !isShellFailure ? "completed" : "failed") === "completed") {`;
const MANUAL_CANCEL_OUTCOME_PATCH = `\tconst isNormalExit = params.exit.reason === "exit";
\tconst isExpectedManualCancel = params.exit.reason === "manual-cancel"; // ${MANUAL_CANCEL_OUTCOME_PATCH_MARKER}
\tconst isShellFailure = exitCode === 126 || exitCode === 127;
\tif ((isExpectedManualCancel || isNormalExit && !isShellFailure ? "completed" : "failed") === "completed") {`;

function patchProcessRuntimeContent(content, filePath) {
  if (!content.includes(PROCESS_RUNTIME_SIGNATURE)) {
    return { content, changed: false, matched: false, kind: null };
  }

  const hasKillPatch = content.includes(KILL_PATCH_MARKER);
  const hasRemovePatch = content.includes(REMOVE_PATCH_MARKER);
  if (hasKillPatch || hasRemovePatch) {
    if (!hasKillPatch || !hasRemovePatch || countOccurrences(content, KILL_PATCH) !== 1 || countOccurrences(content, REMOVE_PATCH) !== 1) {
      throw new Error(`[${PATCH_NAME}] Process runtime is only partially patched: ${filePath}`);
    }
    return { content, changed: false, matched: true, kind: 'process-control' };
  }

  let patched = replaceUnique(content, KILL_ANCHOR, KILL_PATCH, 'process kill', filePath);
  patched = replaceUnique(patched, REMOVE_ANCHOR, REMOVE_PATCH, 'process remove', filePath);
  return { content: patched, changed: true, matched: true, kind: 'process-control' };
}

function patchExitNotifyRuntimeContent(content, filePath) {
  if (!content.includes(EXIT_NOTIFY_RUNTIME_SIGNATURE)) {
    return { content, changed: false, matched: false, kind: null };
  }

  const hasNotifyPatch = content.includes(MANUAL_CANCEL_NOTIFY_PATCH_MARKER);
  const hasOutcomePatch = content.includes(MANUAL_CANCEL_OUTCOME_PATCH_MARKER);
  if (hasNotifyPatch || hasOutcomePatch) {
    if (
      !hasNotifyPatch
      || !hasOutcomePatch
      || countOccurrences(content, MANUAL_CANCEL_NOTIFY_PATCH) !== 1
      || countOccurrences(content, MANUAL_CANCEL_OUTCOME_PATCH) !== 1
    ) {
      throw new Error(`[${PATCH_NAME}] Manual-cancel exec runtime is only partially patched: ${filePath}`);
    }
    return { content, changed: false, matched: true, kind: 'exit-notify' };
  }

  let patched = replaceUnique(
    content,
    MANUAL_CANCEL_NOTIFY_ANCHOR,
    MANUAL_CANCEL_NOTIFY_PATCH,
    'manual-cancel exit notification',
    filePath,
  );
  patched = replaceUnique(
    patched,
    MANUAL_CANCEL_OUTCOME_ANCHOR,
    MANUAL_CANCEL_OUTCOME_PATCH,
    'manual-cancel exec outcome',
    filePath,
  );
  return {
    content: patched,
    changed: true,
    matched: true,
    kind: 'exit-notify',
  };
}

export function patchOpenClawProcessControlSemanticsContent(content, filePath = '<fixture>') {
  if (content.includes(PROCESS_RUNTIME_SIGNATURE)) {
    return patchProcessRuntimeContent(content, filePath);
  }
  if (content.includes(EXIT_NOTIFY_RUNTIME_SIGNATURE)) {
    return patchExitNotifyRuntimeContent(content, filePath);
  }
  return { content, changed: false, matched: false, kind: null };
}

export function patchOpenClawProcessControlSemanticsRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[${PATCH_NAME}] OpenClaw dist directory not found: ${distDir}`);
  }

  const targets = readdirSync(distDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => ({ file, filePath: join(distDir, file) }))
    .map((target) => ({
      ...target,
      result: patchOpenClawProcessControlSemanticsContent(readFileSync(target.filePath, 'utf8'), target.filePath),
    }))
    .filter(({ result }) => result.matched);

  const processTargets = targets.filter(({ result }) => result.kind === 'process-control');
  const exitNotifyTargets = targets.filter(({ result }) => result.kind === 'exit-notify');
  if (processTargets.length !== 1 || exitNotifyTargets.length !== 1) {
    throw new Error(
      `[${PATCH_NAME}] Expected one process-control runtime and one exit-notify runtime; found ${processTargets.length} and ${exitNotifyTargets.length}.`,
    );
  }

  for (const target of targets) {
    if (target.result.changed && !dryRun) {
      writeFileSync(target.filePath, target.result.content, 'utf8');
    }
    logger.log?.(
      `[${PATCH_NAME}] ${target.result.changed ? (dryRun ? 'Dry-run matched' : 'Patched') : 'Already patched'}: ${target.file}`,
    );
  }

  return {
    patchedFiles: targets.filter(({ result }) => result.changed).length,
    alreadyPatchedFiles: targets.filter(({ result }) => !result.changed).length,
    processControlFile: processTargets[0].filePath,
    exitNotifyFile: exitNotifyTargets[0].filePath,
  };
}

export function patchInstalledOpenClawProcessControlSemanticsRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawProcessControlSemanticsRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
