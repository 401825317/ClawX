import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const PATCH_MARKER = 'UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_TIMEOUT_MS';

const INIT_SESSION_STATE_ANCHOR = `async function initSessionState(params) {
\treturn await initSessionStateAttempt(params, false);
}
async function initSessionStateAttempt(params, staleSnapshotRetried) {
`;

const INIT_SESSION_STATE_PATCH = `const UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_TIMEOUT_MS = 8e3;
const UCLAW_REPLY_SESSION_INIT_CONFLICT_RETRY_BASE_DELAY_MS = 150;
function isUclawReplySessionInitializationConflict(error) {
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

function patchReplySessionInitConflictContent(content) {
  if (content.includes(PATCH_MARKER)) {
    return { content, changed: false };
  }

  if (!content.includes(INIT_SESSION_STATE_ANCHOR)) {
    return { content, changed: false };
  }

  return {
    content: content.replace(INIT_SESSION_STATE_ANCHOR, INIT_SESSION_STATE_PATCH),
    changed: true,
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
