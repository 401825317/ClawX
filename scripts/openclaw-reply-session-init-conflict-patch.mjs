import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const PATCH_MARKER = 'UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_TIMEOUT_MS';
const QUEUE_MARKER = 'UCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUE_MARKER';
const QUEUE_GUARD_MARKER = '__uclawReplySessionInitQueued';
const RETRY_TIMEOUT_MS = 30_000;
const RETRY_TIMEOUT_DECLARATION_RE = /const UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_TIMEOUT_MS = [^;]+;/u;
const RETRY_BASE_DECLARATION_RE = /const UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_BASE_DELAY_MS = [^;]+;/u;

const INIT_SESSION_STATE_ANCHOR = `async function initSessionState(params) {
\treturn await initSessionStateAttempt(params, false);
}
async function initSessionStateAttempt(params, staleSnapshotRetried) {
`;

const SESSION_KEY_ANCHOR = `\tconst sessionKey = canonicalizeMainSessionAlias({
\t\tcfg,
\t\tagentId,
\t\tsessionKey: resolveSessionKey(sessionScope, sessionCtxForState, mainKey)
\t});
`;

const SESSION_KEY_QUEUE_GUARD = `${SESSION_KEY_ANCHOR}\tif (!params.__uclawReplySessionInitQueued) {
\t\treturn await runUclawReplySessionInitializationInQueue(sessionKey, () => initSessionStateAttempt({
\t\t\t...params,
\t\t\t__uclawReplySessionInitQueued: true
\t\t}, staleSnapshotRetried));
\t}
`;

const INIT_SESSION_QUEUE_HELPERS = `const ${QUEUE_MARKER} = true;
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
`;

const INIT_SESSION_STATE_PATCH = `const UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_TIMEOUT_MS = ${RETRY_TIMEOUT_MS};
const UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_BASE_DELAY_MS = 150;
${INIT_SESSION_QUEUE_HELPERS}function isUclawReplySessionInitializationConflict(error) {
\treturn String(error).toLowerCase().includes("reply session initialization conflicted");
}
function sleepUclawReplySessionInitializationConflictRetry(ms) {
\treturn new Promise((resolve) => setTimeout(resolve, ms));
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
`;

function patchQueueGuard(content) {
  if (content.includes(QUEUE_MARKER) && content.includes(QUEUE_GUARD_MARKER)) {
    return content;
  }

  let next = content;
  if (!next.includes(QUEUE_MARKER)) {
    next = next.replace(
      RETRY_BASE_DECLARATION_RE,
      (match) => `${match}\n${INIT_SESSION_QUEUE_HELPERS.trimEnd()}`,
    );
    if (next === content) {
      return content;
    }
  }
  if (!next.includes(QUEUE_GUARD_MARKER)) {
    next = next.replace(SESSION_KEY_ANCHOR, SESSION_KEY_QUEUE_GUARD);
  }
  return next;
}

function patchReplySessionInitConflictContent(content) {
  if (content.includes(PATCH_MARKER)) {
    const withTimeout = content.replace(
      RETRY_TIMEOUT_DECLARATION_RE,
      `const UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_TIMEOUT_MS = ${RETRY_TIMEOUT_MS};`,
    );
    const next = patchQueueGuard(withTimeout);
    return { content: next, changed: next !== content };
  }

  if (!content.includes(INIT_SESSION_STATE_ANCHOR)) {
    return { content, changed: false };
  }

  const next = patchQueueGuard(content.replace(INIT_SESSION_STATE_ANCHOR, INIT_SESSION_STATE_PATCH));
  return {
    content: next,
    changed: next !== content,
  };
}

export function patchOpenClawReplySessionInitConflictRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  if (!existsSync(distDir)) return { patchedFiles: 0, distDir };

  let patchedFiles = 0;
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith('.js')) continue;
    const filePath = join(distDir, file);
    const original = readFileSync(filePath, 'utf8');
    const patched = patchReplySessionInitConflictContent(original);
    if (!patched.changed) continue;
    writeFileSync(filePath, patched.content, 'utf8');
    patchedFiles++;
    logger.log?.(`[openclaw-reply-session-init-conflict-patch] Patched: ${file}`);
  }

  if (patchedFiles > 0) {
    logger.log?.(`[openclaw-reply-session-init-conflict-patch] Done. Patched ${patchedFiles} file(s).`);
  }

  return { patchedFiles, distDir };
}

export function patchInstalledOpenClawReplySessionInitConflictRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawReplySessionInitConflictRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
