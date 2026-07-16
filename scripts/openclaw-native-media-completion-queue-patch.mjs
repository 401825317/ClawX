import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_NAME = 'openclaw-native-media-completion-queue-patch';
const PATCH_MARKER = 'UCLAW_NATIVE_MEDIA_COMPLETION_SESSION_QUEUE_V1';
const RUNTIME_SIGNATURE = 'async function wakeMediaGenerationTaskCompletion(params) {';
const WAKE_ANCHOR = `async function wakeMediaGenerationTaskCompletion(params) {
\tif (!params.handle || isUClawNativeMediaTaskCancelled(params.handle)) return true;`;
const WAKE_PATCH = `const ${PATCH_MARKER} = true;
const UCLAW_NATIVE_MEDIA_COMPLETION_SESSION_QUEUES = globalThis.__uclawNativeMediaCompletionSessionQueues || (globalThis.__uclawNativeMediaCompletionSessionQueues = new Map());
function runUclawNativeMediaCompletionInSessionQueue(sessionKey, task) {
\tconst key = String(sessionKey || "__unknown__");
\tconst previous = UCLAW_NATIVE_MEDIA_COMPLETION_SESSION_QUEUES.get(key) || Promise.resolve();
\tconst run = previous.catch(() => void 0).then(task);
\tconst cleanup = run.catch(() => void 0).then(() => {
\t\tif (UCLAW_NATIVE_MEDIA_COMPLETION_SESSION_QUEUES.get(key) === cleanup) {
\t\t\tUCLAW_NATIVE_MEDIA_COMPLETION_SESSION_QUEUES.delete(key);
\t\t}
\t});
\tUCLAW_NATIVE_MEDIA_COMPLETION_SESSION_QUEUES.set(key, cleanup);
\treturn run;
}
async function wakeMediaGenerationTaskCompletion(params) {
\tif (!params.handle || isUClawNativeMediaTaskCancelled(params.handle)) return true;
\treturn await runUclawNativeMediaCompletionInSessionQueue(params.handle.requesterSessionKey, async () => {
\t\tif (isUClawNativeMediaTaskCancelled(params.handle)) return true;
\t\treturn await wakeMediaGenerationTaskCompletionQueued(params);
\t});
}
async function wakeMediaGenerationTaskCompletionQueued(params) {
\tif (!params.handle || isUClawNativeMediaTaskCancelled(params.handle)) return true;`;

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

export function patchOpenClawNativeMediaCompletionQueueContent(content, filePath = '<fixture>') {
  if (!content.includes(RUNTIME_SIGNATURE)) return { content, changed: false, matched: false };
  if (content.includes(PATCH_MARKER)) {
    if (countOccurrences(content, PATCH_MARKER) !== 1) {
      throw new Error(`[${PATCH_NAME}] Completion queue marker is not unique in ${filePath}.`);
    }
    return { content, changed: false, matched: true };
  }
  const count = countOccurrences(content, WAKE_ANCHOR);
  if (count !== 1) {
    throw new Error(`[${PATCH_NAME}] Expected exactly one media completion wake anchor in ${filePath}; found ${count}.`);
  }
  return { content: content.replace(WAKE_ANCHOR, WAKE_PATCH), changed: true, matched: true };
}

export function patchOpenClawNativeMediaCompletionQueueRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[${PATCH_NAME}] OpenClaw dist directory not found: ${distDir}`);
  }

  const targets = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => ({ file: entry.name, filePath: join(distDir, entry.name) }))
    .map((target) => ({
      ...target,
      result: patchOpenClawNativeMediaCompletionQueueContent(readFileSync(target.filePath, 'utf8'), target.filePath),
    }))
    .filter(({ result }) => result.matched);

  if (targets.length !== 1) {
    throw new Error(`[${PATCH_NAME}] Expected exactly one OpenClaw media completion runtime file in ${distDir}; found ${targets.length}.`);
  }
  const target = targets[0];
  if (target.result.changed && !dryRun) {
    writeFileSync(target.filePath, target.result.content, 'utf8');
  }
  logger.log?.(`[${PATCH_NAME}] ${target.result.changed ? (dryRun ? 'Dry-run matched' : 'Patched') : 'Already patched'} ${target.file}.`);
  return {
    patchedFiles: target.result.changed ? 1 : 0,
    alreadyPatchedFiles: target.result.changed ? 0 : 1,
    file: target.file,
  };
}

export function patchInstalledOpenClawNativeMediaCompletionQueueRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawNativeMediaCompletionQueueRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
