import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_MARKER = 'UCLAW_COMPACTION_SESSION_STATE_PATCH';
const SESSION_STORE_MARKER = `${PATCH_MARKER}_SESSION_STORE`;
const FOLLOWUP_EMPTY_PAYLOAD_MARKER = `${PATCH_MARKER}_FOLLOWUP_EMPTY_PAYLOAD`;
const FOLLOWUP_EMPTY_VISIBLE_MARKER = `${PATCH_MARKER}_FOLLOWUP_EMPTY_VISIBLE`;
const MAIN_EMPTY_PAYLOAD_MARKER = `${PATCH_MARKER}_MAIN_EMPTY_PAYLOAD`;
const MAIN_EMPTY_VISIBLE_MARKER = `${PATCH_MARKER}_MAIN_EMPTY_VISIBLE`;
const INCREMENT_HELPER_MARKER = `${PATCH_MARKER}_INCREMENT_HELPER`;
const SESSION_UPDATE_MARKER = `${PATCH_MARKER}_SESSION_UPDATE`;
const LIFECYCLE_TERMINAL_MARKER = `${PATCH_MARKER}_LIFECYCLE_TERMINAL`;

const SESSION_STORE_ANCHOR = `\t\tconst hasUsageTotalTokens = typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0;
\t\tconst useCompactionSnapshot = compactionTokensAfter !== void 0 && !hasUsageTotalTokens;`;

const SESSION_STORE_PATCH = `\t\tconst suppressUsageSnapshotAfterCompaction = compactionsThisRun > 0 && compactionTokensAfter === void 0; // ${SESSION_STORE_MARKER}
\t\tconst hasUsageTotalTokens = !suppressUsageSnapshotAfterCompaction && typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0;
\t\tconst useCompactionSnapshot = compactionTokensAfter !== void 0 && (!hasUsageTotalTokens || compactionsThisRun > 0 && compactionTokensAfter <= totalTokens);`;

const INCREMENT_HELPER_ANCHOR = `async function incrementRunCompactionCount(params) {
\tconst tokensAfterCompaction = resolveNonNegativeTokenCount(params.compactionTokensAfter) ?? (params.lastCallUsage ? deriveSessionTotalTokens({
\t\tusage: params.lastCallUsage,
\t\tcontextTokens: params.contextTokensUsed
\t}) : void 0);
\treturn incrementCompactionCount({`;

const INCREMENT_HELPER_PATCH = `async function incrementRunCompactionCount(params) {
\tconst tokensAfterCompaction = resolveNonNegativeTokenCount(params.compactionTokensAfter);
\treturn incrementCompactionCount({ // ${INCREMENT_HELPER_MARKER}`;

const FOLLOWUP_EMPTY_PAYLOAD_ANCHOR = `\t\t\tconst payloadArray = runResult.payloads ?? [];
\t\t\tif (payloadArray.length === 0) return;`;

const FOLLOWUP_EMPTY_PAYLOAD_PATCH = `\t\t\tconst payloadArray = runResult.payloads ?? [];
\t\t\tif (payloadArray.length === 0) {
\t\t\t\tif (autoCompactionCount > 0) {
\t\t\t\t\tconst previousSessionId = activeSessionEntry?.sessionId ?? run.sessionId;
\t\t\t\t\tawait incrementRunCompactionCount({
\t\t\t\t\t\tcfg: runtimeConfig,
\t\t\t\t\t\tsessionEntry: activeSessionEntry,
\t\t\t\t\t\tsessionStore,
\t\t\t\t\t\tsessionKey: replySessionKey,
\t\t\t\t\t\tstorePath,
\t\t\t\t\t\tamount: autoCompactionCount,
\t\t\t\t\t\tcompactionTokensAfter: runResult.meta?.agentMeta?.compactionTokensAfter,
\t\t\t\t\t\tnewSessionId: runResult.meta?.agentMeta?.sessionId,
\t\t\t\t\t\tnewSessionFile: runResult.meta?.agentMeta?.sessionFile
\t\t\t\t\t});
\t\t\t\t\tconst refreshedSessionEntry = replySessionKey && sessionStore ? sessionStore[replySessionKey] : void 0;
\t\t\t\t\tif (refreshedSessionEntry) {
\t\t\t\t\t\tactiveSessionEntry = refreshedSessionEntry;
\t\t\t\t\t\trefreshQueuedFollowupSession({
\t\t\t\t\t\t\tkey: replySessionKey,
\t\t\t\t\t\t\tpreviousSessionId,
\t\t\t\t\t\t\tnextSessionId: refreshedSessionEntry.sessionId,
\t\t\t\t\t\t\tnextSessionFile: refreshedSessionEntry.sessionFile
\t\t\t\t\t\t});
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\treturn;
\t\t\t} // ${FOLLOWUP_EMPTY_PAYLOAD_MARKER}`;

const FOLLOWUP_EMPTY_VISIBLE_ANCHOR = `\t\t\tif (finalPayloads.length === 0) return;`;

const FOLLOWUP_EMPTY_VISIBLE_PATCH = `\t\t\tif (finalPayloads.length === 0) {
\t\t\t\tif (autoCompactionCount > 0) {
\t\t\t\t\tconst previousSessionId = activeSessionEntry?.sessionId ?? run.sessionId;
\t\t\t\t\tawait incrementRunCompactionCount({
\t\t\t\t\t\tcfg: runtimeConfig,
\t\t\t\t\t\tsessionEntry: activeSessionEntry,
\t\t\t\t\t\tsessionStore,
\t\t\t\t\t\tsessionKey: replySessionKey,
\t\t\t\t\t\tstorePath,
\t\t\t\t\t\tamount: autoCompactionCount,
\t\t\t\t\t\tcompactionTokensAfter: runResult.meta?.agentMeta?.compactionTokensAfter,
\t\t\t\t\t\tnewSessionId: runResult.meta?.agentMeta?.sessionId,
\t\t\t\t\t\tnewSessionFile: runResult.meta?.agentMeta?.sessionFile
\t\t\t\t\t});
\t\t\t\t\tconst refreshedSessionEntry = replySessionKey && sessionStore ? sessionStore[replySessionKey] : void 0;
\t\t\t\t\tif (refreshedSessionEntry) {
\t\t\t\t\t\tactiveSessionEntry = refreshedSessionEntry;
\t\t\t\t\t\trefreshQueuedFollowupSession({
\t\t\t\t\t\t\tkey: replySessionKey,
\t\t\t\t\t\t\tpreviousSessionId,
\t\t\t\t\t\t\tnextSessionId: refreshedSessionEntry.sessionId,
\t\t\t\t\t\t\tnextSessionFile: refreshedSessionEntry.sessionFile
\t\t\t\t\t\t});
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\treturn;
\t\t\t} // ${FOLLOWUP_EMPTY_VISIBLE_MARKER}`;

const MAIN_EMPTY_PAYLOAD_ANCHOR = `\t\tif (payloadArray.length === 0 && fallbackNoticePayloads.length === 0 && !shouldDeliverTerminalFailure && (!emptyInteractiveReplyPayload || hasSpecificFallbackFailure)) {
\t\t\tconst silentFallbackFailurePayload = await returnSilentFallbackFailureIfNeeded();
\t\t\tif (silentFallbackFailurePayload) return silentFallbackFailurePayload;
\t\t\treturn returnWithQueuedFollowupDrain(void 0);
\t\t}`;

const MAIN_EMPTY_PAYLOAD_PATCH = `\t\tif (payloadArray.length === 0 && fallbackNoticePayloads.length === 0 && !shouldDeliverTerminalFailure && (!emptyInteractiveReplyPayload || hasSpecificFallbackFailure)) {
\t\t\tif (autoCompactionCount > 0) {
\t\t\t\tconst previousSessionId = activeSessionEntry?.sessionId ?? followupRun.run.sessionId;
\t\t\t\tawait incrementRunCompactionCount({
\t\t\t\t\tcfg,
\t\t\t\t\tsessionEntry: activeSessionEntry,
\t\t\t\t\tsessionStore: activeSessionStore,
\t\t\t\t\tsessionKey,
\t\t\t\t\tstorePath,
\t\t\t\t\tamount: autoCompactionCount,
\t\t\t\t\tcompactionTokensAfter: runResult.meta?.agentMeta?.compactionTokensAfter,
\t\t\t\t\tnewSessionId: runResult.meta?.agentMeta?.sessionId,
\t\t\t\t\tnewSessionFile: runResult.meta?.agentMeta?.sessionFile
\t\t\t\t});
\t\t\t\tconst refreshedSessionEntry = sessionKey && activeSessionStore ? activeSessionStore[sessionKey] : void 0;
\t\t\t\tif (refreshedSessionEntry) {
\t\t\t\t\tactiveSessionEntry = refreshedSessionEntry;
\t\t\t\t\trefreshQueuedFollowupSession({
\t\t\t\t\t\tkey: sessionKey,
\t\t\t\t\t\tpreviousSessionId,
\t\t\t\t\t\tnextSessionId: refreshedSessionEntry.sessionId,
\t\t\t\t\t\tnextSessionFile: refreshedSessionEntry.sessionFile
\t\t\t\t\t});
\t\t\t\t}
\t\t\t}
\t\t\tconst silentFallbackFailurePayload = await returnSilentFallbackFailureIfNeeded();
\t\t\tif (silentFallbackFailurePayload) return silentFallbackFailurePayload;
\t\t\treturn returnWithQueuedFollowupDrain(void 0);
\t\t} // ${MAIN_EMPTY_PAYLOAD_MARKER}`;

const MAIN_EMPTY_VISIBLE_ANCHOR = `\t\tif (replyPayloads.length === 0 || !hasVisibleReplyPayload && !canDeliverStandaloneFallbackNotice) {
\t\t\tconst silentFallbackFailurePayload = await returnSilentFallbackFailureIfNeeded();
\t\t\tif (silentFallbackFailurePayload) return silentFallbackFailurePayload;
\t\t\treturn returnWithQueuedFollowupDrain(void 0);
\t\t}`;

const MAIN_EMPTY_VISIBLE_PATCH = `\t\tif (replyPayloads.length === 0 || !hasVisibleReplyPayload && !canDeliverStandaloneFallbackNotice) {
\t\t\tif (autoCompactionCount > 0) {
\t\t\t\tconst previousSessionId = activeSessionEntry?.sessionId ?? followupRun.run.sessionId;
\t\t\t\tawait incrementRunCompactionCount({
\t\t\t\t\tcfg,
\t\t\t\t\tsessionEntry: activeSessionEntry,
\t\t\t\t\tsessionStore: activeSessionStore,
\t\t\t\t\tsessionKey,
\t\t\t\t\tstorePath,
\t\t\t\t\tamount: autoCompactionCount,
\t\t\t\t\tcompactionTokensAfter: runResult.meta?.agentMeta?.compactionTokensAfter,
\t\t\t\t\tnewSessionId: runResult.meta?.agentMeta?.sessionId,
\t\t\t\t\tnewSessionFile: runResult.meta?.agentMeta?.sessionFile
\t\t\t\t});
\t\t\t\tconst refreshedSessionEntry = sessionKey && activeSessionStore ? activeSessionStore[sessionKey] : void 0;
\t\t\t\tif (refreshedSessionEntry) {
\t\t\t\t\tactiveSessionEntry = refreshedSessionEntry;
\t\t\t\t\trefreshQueuedFollowupSession({
\t\t\t\t\t\tkey: sessionKey,
\t\t\t\t\t\tpreviousSessionId,
\t\t\t\t\t\tnextSessionId: refreshedSessionEntry.sessionId,
\t\t\t\t\t\tnextSessionFile: refreshedSessionEntry.sessionFile
\t\t\t\t\t});
\t\t\t\t}
\t\t\t}
\t\t\tconst silentFallbackFailurePayload = await returnSilentFallbackFailureIfNeeded();
\t\t\tif (silentFallbackFailurePayload) return silentFallbackFailurePayload;
\t\t\treturn returnWithQueuedFollowupDrain(void 0);
\t\t} // ${MAIN_EMPTY_VISIBLE_MARKER}`;

const SESSION_UPDATE_ANCHOR = `\t} else {
\t\tnext.totalTokensFresh = false;
\t\tnext.inputTokens = void 0;
\t\tnext.outputTokens = void 0;
\t\tnext.cacheRead = void 0;
\t\tnext.cacheWrite = void 0;
\t}`;

const SESSION_UPDATE_PATCH = `\t} else {
\t\tnext.totalTokens = void 0; // ${SESSION_UPDATE_MARKER}
\t\tnext.totalTokensFresh = false;
\t\tnext.inputTokens = void 0;
\t\tnext.outputTokens = void 0;
\t\tnext.cacheRead = void 0;
\t\tnext.cacheWrite = void 0;
\t}`;

const LIFECYCLE_TERMINAL_ANCHOR = `\t\tif (phase === "finishing") {
\t\t\tdeferredError = readStringValue(evt.data.error) ?? deferredError;
\t\t\tObject.assign(deferredTerminalMetadata, resolveAgentLifecycleTerminalMetadata(evt.data));
\t\t}`;

const LIFECYCLE_TERMINAL_PATCH = `\t\tif (phase === "finishing") {
\t\t\tdeferredError = readStringValue(evt.data.error); // ${LIFECYCLE_TERMINAL_MARKER}
\t\t\tfor (const key of DEFERRED_TERMINAL_METADATA_KEYS) delete deferredTerminalMetadata[key];
\t\t\tObject.assign(deferredTerminalMetadata, resolveAgentLifecycleTerminalMetadata(evt.data));
\t\t}`;

function walkFiles(rootDir) {
  const files = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const filePath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(filePath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(filePath);
  }
  return files;
}

function replaceOnce(content, anchor, patch, label, filePath) {
  if (content.includes(patch) || content.includes(label)) return { content, changed: false, matched: true };
  const count = content.split(anchor).length - 1;
  if (count === 0) return { content, changed: false, matched: false };
  if (count !== 1) {
    throw new Error(`[openclaw-compaction-session-state-patch] Expected one ${label} anchor in ${filePath}; found ${count}.`);
  }
  return {
    content: content.replace(anchor, patch),
    changed: true,
    matched: true,
  };
}

function patchFileContent(content, filePath) {
  let next = content;
  let changed = false;
  const categories = [];

  const replacements = [
    { anchor: SESSION_STORE_ANCHOR, patch: SESSION_STORE_PATCH, label: SESSION_STORE_MARKER, category: 'session-store' },
    { anchor: INCREMENT_HELPER_ANCHOR, patch: INCREMENT_HELPER_PATCH, label: INCREMENT_HELPER_MARKER, category: 'increment-helper' },
    { anchor: FOLLOWUP_EMPTY_PAYLOAD_ANCHOR, patch: FOLLOWUP_EMPTY_PAYLOAD_PATCH, label: FOLLOWUP_EMPTY_PAYLOAD_MARKER, category: 'followup-empty-payload' },
    { anchor: FOLLOWUP_EMPTY_VISIBLE_ANCHOR, patch: FOLLOWUP_EMPTY_VISIBLE_PATCH, label: FOLLOWUP_EMPTY_VISIBLE_MARKER, category: 'followup-empty-visible' },
    { anchor: MAIN_EMPTY_PAYLOAD_ANCHOR, patch: MAIN_EMPTY_PAYLOAD_PATCH, label: MAIN_EMPTY_PAYLOAD_MARKER, category: 'main-empty-payload' },
    { anchor: MAIN_EMPTY_VISIBLE_ANCHOR, patch: MAIN_EMPTY_VISIBLE_PATCH, label: MAIN_EMPTY_VISIBLE_MARKER, category: 'main-empty-visible' },
    { anchor: SESSION_UPDATE_ANCHOR, patch: SESSION_UPDATE_PATCH, label: SESSION_UPDATE_MARKER, category: 'session-update' },
    { anchor: LIFECYCLE_TERMINAL_ANCHOR, patch: LIFECYCLE_TERMINAL_PATCH, label: LIFECYCLE_TERMINAL_MARKER, category: 'lifecycle-terminal' },
  ];

  for (const replacement of replacements) {
    const result = replaceOnce(next, replacement.anchor, replacement.patch, replacement.label, filePath);
    if (!result.matched) continue;
    next = result.content;
    changed ||= result.changed;
    categories.push(replacement.category);
  }

  return { content: next, changed, categories };
}

export function patchOpenClawCompactionSessionStateRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-compaction-session-state-patch] OpenClaw dist directory not found: ${distDir}`);
  }

  const counts = new Map();
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;

  for (const filePath of walkFiles(distDir)) {
    const original = readFileSync(filePath, 'utf8');
    const result = patchFileContent(original, filePath);
    if (result.categories.length === 0) continue;
    for (const category of result.categories) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    if (result.changed) {
      patchedFiles += 1;
      if (!dryRun) writeFileSync(filePath, result.content, 'utf8');
    } else {
      alreadyPatchedFiles += 1;
    }
  }

  const expected = [
    'session-store',
    'increment-helper',
    'followup-empty-visible',
    'main-empty-payload',
    'main-empty-visible',
    'session-update',
    'lifecycle-terminal',
  ];
  for (const category of expected) {
    const count = counts.get(category) ?? 0;
    if (count !== 1) {
      throw new Error(
        `[openclaw-compaction-session-state-patch] Expected ${category}=1 in ${distDir}; found ${count}.`,
      );
    }
  }

  logger.log?.(
    `[openclaw-compaction-session-state-patch] ${dryRun ? 'Dry-run matched' : 'Patched'} ${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`,
  );

  return {
    patchedFiles,
    alreadyPatchedFiles,
    categoryCounts: Object.fromEntries(counts),
  };
}

export function patchInstalledOpenClawCompactionSessionStateRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawCompactionSessionStateRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}

export const __test = {
  patchFileContent,
};
