import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const PATCH_MARKER = 'UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_TIMEOUT_MS';
const QUEUE_MARKER = 'UCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUE_MARKER';
const QUEUE_CLEANUP_MARKER = 'UCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUE_CLEANUP_MARKER';
const QUEUE_GUARD_MARKER = '__uclawReplySessionInitQueued';
const STALE_SNAPSHOT_RELOAD_MARKER = 'UCLAW_REPLY_SESSION_INIT_CONFLICT_RELOAD_MARKER';
const STABLE_REVISION_MARKER = 'UCLAW_REPLY_SESSION_INIT_CONFLICT_STABLE_REVISION_MARKER';
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
const ${QUEUE_CLEANUP_MARKER} = true;
const UCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUES = globalThis.__uclawReplySessionInitConflictQueues || (globalThis.__uclawReplySessionInitConflictQueues = new Map());
function runUclawReplySessionInitializationInQueue(sessionKey, task) {
\tconst key = String(sessionKey || "__unknown__");
\tconst previous = UCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUES.get(key) || Promise.resolve();
\tconst run = previous.catch(() => void 0).then(task);
\tconst cleanup = run.catch(() => void 0).then(() => {
\t\tif (UCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUES.get(key) === cleanup) {
\t\t\tUCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUES.delete(key);
\t\t}
\t});
\tUCLAW_REPLY_SESSION_INIT_CONFLICT_QUEUES.set(key, cleanup);
\treturn run;
}
`;

const LEGACY_INIT_SESSION_QUEUE_HELPERS = `const ${QUEUE_MARKER} = true;
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

const STALE_SNAPSHOT_RETRY_BLOCK = `\tif (!committed.ok) {
\t\tif (!staleSnapshotRetried) return await initSessionStateAttempt(params, true);
\t\tthrow new Error(\`reply session initialization conflicted for \${sessionKey}\`);
\t}
`;

const STALE_SNAPSHOT_RELOAD_BLOCK = `\tif (!committed.ok) {
\t\t// ${STALE_SNAPSHOT_RELOAD_MARKER}: bounce to initSessionState so the next attempt reloads a fresh snapshot.
\t\tthrow new Error(\`reply session initialization conflicted for \${sessionKey}\`);
\t}
`;

const SESSION_REVISION_ANCHOR = `function createReplySessionInitializationRevision(entry) {
\treturn JSON.stringify(entry ?? null);
}
`;

const STABLE_SESSION_REVISION_PATCH = `const ${STABLE_REVISION_MARKER} = true;
function stringifyUclawReplySessionInitializationRevision(value) {
\tif (value === void 0) return void 0;
\tif (value === null || typeof value !== "object") return JSON.stringify(value);
\tif (Array.isArray(value)) {
\t\treturn \`[\${value.map((item) => stringifyUclawReplySessionInitializationRevision(item) ?? "null").join(",")}]\`;
\t}
\tconst parts = [];
\tfor (const key of Object.keys(value).sort()) {
\t\tconst encoded = stringifyUclawReplySessionInitializationRevision(value[key]);
\t\tif (encoded !== void 0) parts.push(\`\${JSON.stringify(key)}:\${encoded}\`);
\t}
\treturn \`{\${parts.join(",")}}\`;
}
function createReplySessionInitializationRevision(entry) {
\treturn stringifyUclawReplySessionInitializationRevision(entry ?? null);
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

function patchQueueHelper(content) {
  if (!content.includes(QUEUE_MARKER) || content.includes(QUEUE_CLEANUP_MARKER)) {
    return content;
  }
  return content.replace(LEGACY_INIT_SESSION_QUEUE_HELPERS, INIT_SESSION_QUEUE_HELPERS);
}

function patchQueueGuard(content) {
  let next = patchQueueHelper(content);
  if (next.includes(QUEUE_MARKER) && next.includes(QUEUE_GUARD_MARKER)) {
    return next;
  }

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

function patchStaleSnapshotRetry(content) {
  if (content.includes(STALE_SNAPSHOT_RELOAD_MARKER)) {
    return content;
  }
  return content.replace(STALE_SNAPSHOT_RETRY_BLOCK, STALE_SNAPSHOT_RELOAD_BLOCK);
}

function patchStableSessionRevision(content) {
  if (content.includes(STABLE_REVISION_MARKER)) {
    return content;
  }
  return content.replace(SESSION_REVISION_ANCHOR, STABLE_SESSION_REVISION_PATCH);
}

function patchReplySessionInitConflictContent(content) {
  let next = patchStableSessionRevision(content);

  if (next.includes(PATCH_MARKER)) {
    const withTimeout = next.replace(
      RETRY_TIMEOUT_DECLARATION_RE,
      `const UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_TIMEOUT_MS = ${RETRY_TIMEOUT_MS};`,
    );
    next = patchStaleSnapshotRetry(patchQueueGuard(withTimeout));
    return { content: next, changed: next !== content };
  }

  if (!next.includes(INIT_SESSION_STATE_ANCHOR)) {
    return { content: next, changed: next !== content };
  }

  next = patchStaleSnapshotRetry(patchQueueGuard(next.replace(INIT_SESSION_STATE_ANCHOR, INIT_SESSION_STATE_PATCH)));
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
