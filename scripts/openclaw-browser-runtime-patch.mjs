import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export const BROWSER_HINT_REPLACEMENTS = [
  [
    'Do NOT retry the browser tool \u2014 it will keep failing. Use an alternative approach or inform the user that the browser is currently unavailable.',
    'If this was a transient error (timeout, network), you may retry once. If the same error persists after retry, try an alternative approach and let the user know.',
  ],
  [
    'Do NOT retry the browser tool.',
    'You may retry once if this was a transient error.',
  ],
];

const HELPER_ANCHOR = `function canRetryChromeActWithoutTargetId(request) {
\tconst typedRequest = request;
\tconst kind = typeof typedRequest.kind === "string" ? typedRequest.kind : typeof typedRequest.action === "string" ? typedRequest.action : "";
\treturn kind === "hover" || kind === "scrollIntoView" || kind === "wait";
}
`;

const RECOVERY_HELPERS = `function canRetryChromeActWithoutTargetId(request) {
\tconst typedRequest = request;
\tconst kind = typeof typedRequest.kind === "string" ? typedRequest.kind : typeof typedRequest.action === "string" ? typedRequest.action : "";
\treturn kind === "hover" || kind === "scrollIntoView" || kind === "wait";
}
function compactDefinedFields(record) {
\treturn Object.fromEntries(Object.entries(record).filter(([, value]) => value !== void 0));
}
function buildBrowserPageSummary(snapshot) {
\tif (!snapshot || typeof snapshot !== "object") return void 0;
\tconst refsCount = snapshot.refs && typeof snapshot.refs === "object" ? Object.keys(snapshot.refs).length : void 0;
\tconst labelsCount = typeof snapshot.labelsCount === "number" ? snapshot.labelsCount : Array.isArray(snapshot.labels) ? snapshot.labels.length : void 0;
\treturn compactDefinedFields({
\t\tformat: readStringValue(snapshot.format),
\t\ttargetId: readStringValue(snapshot.targetId),
\t\turl: readStringValue(snapshot.url),
\t\ttitle: readStringValue(snapshot.title),
\t\ttruncated: typeof snapshot.truncated === "boolean" ? snapshot.truncated : void 0,
\t\tnodeCount: Array.isArray(snapshot.nodes) ? snapshot.nodes.length : void 0,
\t\trefsCount,
\t\tlabelsCount,
\t\tblockedByDialog: snapshot.blockedByDialog === true ? true : void 0,
\t\tbrowserState: snapshot.browserState
\t});
}
function isBrowserTargetIdMismatchError(err) {
\treturn String(err).includes("action targetId must match request targetId");
}
function isBrowserStaleRefError(err) {
\tconst msg = String(err).toLowerCase();
\treturn msg.includes("not found or not visible") || msg.includes("run a new snapshot") || msg.includes("stale ref");
}
function pickBrowserRecoveryTargetId(tabs, previousTargetId) {
\tconst previous = readStringValue(previousTargetId);
\tconst formattedTabs = Array.isArray(tabs) ? tabs.map((tab) => formatAgentTab(tab)) : [];
\tif (previous) {
\t\tfor (const tab of formattedTabs) {
\t\t\tif (readStringValue(tab.targetId) === previous) return tab.targetId;
\t\t}
\t\tfor (const tab of formattedTabs) {
\t\t\tif (readStringValue(tab.suggestedTargetId) === previous || readStringValue(tab.label) === previous || readStringValue(tab.tabId) === previous) return tab.targetId;
\t\t}
\t}
\tif (formattedTabs.length === 1) return readStringValue(formattedTabs[0].targetId);
\treturn void 0;
}
async function readBrowserTabsForRecovery(params) {
\tconst { baseUrl, profile, proxyRequest } = params;
\ttry {
\t\treturn proxyRequest ? (await proxyRequest({
\t\t\tmethod: "GET",
\t\t\tpath: "/tabs",
\t\t\tprofile
\t\t})).tabs ?? [] : await browserToolActionDeps.browserTabs(baseUrl, { profile });
\t} catch {
\t\treturn [];
\t}
}
async function readBrowserSnapshotForRecovery(params, targetId) {
\tconst { baseUrl, profile, proxyRequest } = params;
\tconst query = {
\t\ttargetId,
\t\tmode: "efficient",
\t\ttimeoutMs: 1e4
\t};
\ttry {
\t\treturn proxyRequest ? await proxyRequest({
\t\t\tmethod: "GET",
\t\t\tpath: "/snapshot",
\t\t\tprofile,
\t\t\tquery,
\t\t\ttimeoutMs: 1e4
\t\t}) : await browserToolActionDeps.browserSnapshot(baseUrl, {
\t\t\t...query,
\t\t\tprofile
\t\t});
\t} catch {
\t\treturn void 0;
\t}
}
`;

const EXECUTE_ACT_ANCHOR = `async function executeActAction(params) {
\tconst { request, baseUrl, profile, proxyRequest } = params;
\tconst effectiveRequest = withConfiguredActTimeout(request, profile);
\ttry {
\t\tconst result = proxyRequest ? await proxyRequest({
\t\t\tmethod: "POST",
\t\t\tpath: "/act",
\t\t\tprofile,
\t\t\tbody: effectiveRequest,
\t\t\ttimeoutMs: resolveActProxyTimeoutMs(effectiveRequest)
\t\t}) : await browserToolActionDeps.browserAct(baseUrl, effectiveRequest, { profile });
\t\tparams.onTabActivity?.(readStringValue(result.targetId) ?? readStringValue(effectiveRequest.targetId));
\t\treturn jsonResult(result);
\t} catch (err) {
\t\tif (isChromeStaleTargetError(profile, err)) {
\t\t\tconst retryRequest = stripTargetIdFromActRequest(effectiveRequest);
\t\t\tconst tabs = proxyRequest ? (await proxyRequest({
\t\t\t\tmethod: "GET",
\t\t\t\tpath: "/tabs",
\t\t\t\tprofile
\t\t\t})).tabs ?? [] : await browserToolActionDeps.browserTabs(baseUrl, { profile }).catch(() => []);
\t\t\tif (retryRequest && canRetryChromeActWithoutTargetId(effectiveRequest) && tabs.length === 1) try {
\t\t\t\tconst retryResult = proxyRequest ? await proxyRequest({
\t\t\t\t\tmethod: "POST",
\t\t\t\t\tpath: "/act",
\t\t\t\t\tprofile,
\t\t\t\t\tbody: retryRequest,
\t\t\t\t\ttimeoutMs: resolveActProxyTimeoutMs(retryRequest)
\t\t\t\t}) : await browserToolActionDeps.browserAct(baseUrl, retryRequest, { profile });
\t\t\t\tparams.onTabActivity?.(readStringValue(retryResult.targetId) ?? readStringValue(retryRequest.targetId));
\t\t\t\treturn jsonResult(retryResult);
\t\t\t} catch {}
\t\t\tif (!tabs.length) throw new Error(\`No browser tabs found for profile="\${profile}". Make sure the configured Chromium-based browser (v144+) is running and has open tabs, then retry.\`, { cause: err });
\t\t\tthrow new Error(\`Chrome tab not found (stale targetId?). Run action=tabs profile="\${profile}" and use one of the returned targetIds.\`, { cause: err });
\t\t}
\t\tthrow err;
\t}
}
`;

const EXECUTE_ACT_PATCH = `async function executeActAction(params) {
\tconst { request, baseUrl, profile, proxyRequest } = params;
\tconst effectiveRequest = withConfiguredActTimeout(request, profile);
\tconst callAct = async (body) => proxyRequest ? await proxyRequest({
\t\tmethod: "POST",
\t\tpath: "/act",
\t\tprofile,
\t\tbody,
\t\ttimeoutMs: resolveActProxyTimeoutMs(body)
\t}) : await browserToolActionDeps.browserAct(baseUrl, body, { profile });
\ttry {
\t\tconst result = await callAct(effectiveRequest);
\t\tparams.onTabActivity?.(readStringValue(result.targetId) ?? readStringValue(effectiveRequest.targetId));
\t\treturn jsonResult(result);
\t} catch (err) {
\t\tif (isBrowserTargetIdMismatchError(err)) {
\t\t\tconst tabs = await readBrowserTabsForRecovery(params);
\t\t\tconst recoveryTargetId = pickBrowserRecoveryTargetId(tabs, effectiveRequest.targetId);
\t\t\tif (recoveryTargetId && recoveryTargetId !== readStringValue(effectiveRequest.targetId)) {
\t\t\t\tconst retryRequest = {
\t\t\t\t\t...effectiveRequest,
\t\t\t\t\ttargetId: recoveryTargetId
\t\t\t\t};
\t\t\t\ttry {
\t\t\t\t\tconst retryResult = await callAct(retryRequest);
\t\t\t\t\tparams.onTabActivity?.(readStringValue(retryResult.targetId) ?? recoveryTargetId);
\t\t\t\t\treturn jsonResult({
\t\t\t\t\t\t...retryResult,
\t\t\t\t\t\trecovered: true,
\t\t\t\t\t\trecoveredFrom: "targetIdMismatch",
\t\t\t\t\t\trecoveryTargetId
\t\t\t\t\t});
\t\t\t\t} catch {}
\t\t\t}
\t\t}
\t\tif (isBrowserStaleRefError(err)) {
\t\t\tconst targetId = readStringValue(effectiveRequest.targetId);
\t\t\tconst snapshot = await readBrowserSnapshotForRecovery(params, targetId);
\t\t\tif (snapshot) {
\t\t\t\tparams.onTabActivity?.(readStringValue(snapshot.targetId) ?? targetId);
\t\t\t\treturn jsonResult({
\t\t\t\t\trecovered: true,
\t\t\t\t\trecoveredFrom: "staleRef",
\t\t\t\t\tmessage: "The requested browser ref was stale. A fresh lightweight snapshot was captured; continue with refs from that fresh snapshot instead of retrying the old ref.",
\t\t\t\t\tpageSummary: buildBrowserPageSummary(snapshot),
\t\t\t\t\ttargetId: readStringValue(snapshot.targetId) ?? targetId,
\t\t\t\t\turl: readStringValue(snapshot.url)
\t\t\t\t});
\t\t\t}
\t\t}
\t\tif (isChromeStaleTargetError(profile, err)) {
\t\t\tconst retryRequest = stripTargetIdFromActRequest(effectiveRequest);
\t\t\tconst tabs = await readBrowserTabsForRecovery(params);
\t\t\tif (retryRequest && canRetryChromeActWithoutTargetId(effectiveRequest) && tabs.length === 1) try {
\t\t\t\tconst retryResult = await callAct(retryRequest);
\t\t\t\tparams.onTabActivity?.(readStringValue(retryResult.targetId) ?? readStringValue(retryRequest.targetId));
\t\t\t\treturn jsonResult(retryResult);
\t\t\t} catch {}
\t\t\tif (!tabs.length) throw new Error(\`No browser tabs found for profile="\${profile}". Make sure the configured Chromium-based browser (v144+) is running and has open tabs, then retry.\`, { cause: err });
\t\t\tthrow new Error(\`Chrome tab not found (stale targetId?). Run action=tabs profile="\${profile}" and use one of the returned targetIds.\`, { cause: err });
\t\t}
\t\tthrow err;
\t}
}
`;

const SNAPSHOT_REPLACEMENTS = [
  [
    `\t\t\t\t\tdetails: {
\t\t\t\t\t\t...wrapped.safeDetails,
\t\t\t\t\t\tformat: snapshot.format,
\t\t\t\t\t\ttargetId: snapshot.targetId,
\t\t\t\t\t\turl: snapshot.url,
\t\t\t\t\t\t...dialogStateFields
\t\t\t\t\t}`,
    `\t\t\t\t\tdetails: {
\t\t\t\t\t\t...wrapped.safeDetails,
\t\t\t\t\t\tformat: snapshot.format,
\t\t\t\t\t\ttargetId: snapshot.targetId,
\t\t\t\t\t\turl: snapshot.url,
\t\t\t\t\t\tpageSummary: buildBrowserPageSummary(snapshot),
\t\t\t\t\t\t...dialogStateFields
\t\t\t\t\t}`,
  ],
  [
    `\t\t\tlabelsSkipped: snapshot.labelsSkipped,
\t\t\tannotations: snapshot.annotations,
\t\t\timagePath: snapshot.imagePath,`,
    `\t\t\tlabelsSkipped: snapshot.labelsSkipped,
\t\t\tpageSummary: buildBrowserPageSummary(snapshot),
\t\t\tannotations: snapshot.annotations,
\t\t\timagePath: snapshot.imagePath,`,
  ],
  [
    `\t\t\t\turl: snapshot.url,
\t\t\t\tnodeCount: snapshot.nodes.length,
\t\t\t\t...snapshot.blockedByDialog ? { blockedByDialog: true } : {},`,
    `\t\t\t\turl: snapshot.url,
\t\t\t\tnodeCount: snapshot.nodes.length,
\t\t\t\tpageSummary: buildBrowserPageSummary(snapshot),
\t\t\t\t...snapshot.blockedByDialog ? { blockedByDialog: true } : {},`,
  ],
];

function patchBrowserRuntimeContent(content) {
  let next = content;
  let changed = false;

  for (const [search, replace] of BROWSER_HINT_REPLACEMENTS) {
    if (next.includes(search)) {
      next = next.replaceAll(search, replace);
      changed = true;
    }
  }

  if (next.includes(HELPER_ANCHOR) && !next.includes('function isBrowserTargetIdMismatchError(err)')) {
    next = next.replace(HELPER_ANCHOR, RECOVERY_HELPERS);
    changed = true;
  }

  if (next.includes(EXECUTE_ACT_ANCHOR) && !next.includes('recoveredFrom: "targetIdMismatch"')) {
    next = next.replace(EXECUTE_ACT_ANCHOR, EXECUTE_ACT_PATCH);
    changed = true;
  }

  for (const [search, replace] of SNAPSHOT_REPLACEMENTS) {
    if (next.includes(search) && !next.includes(replace)) {
      next = next.replace(search, replace);
      changed = true;
    }
  }

  return { content: next, changed };
}

export function patchOpenClawBrowserRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  if (!existsSync(distDir)) return { patchedFiles: 0, distDir };

  let patchedFiles = 0;
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith('.js')) continue;
    const filePath = join(distDir, file);
    const original = readFileSync(filePath, 'utf8');
    const patched = patchBrowserRuntimeContent(original);
    if (!patched.changed) continue;
    writeFileSync(filePath, patched.content, 'utf8');
    patchedFiles++;
    logger.log?.(`[openclaw-browser-runtime-patch] Patched: ${file}`);
  }

  if (patchedFiles > 0) {
    logger.log?.(`[openclaw-browser-runtime-patch] Done. Patched ${patchedFiles} file(s).`);
  }

  return { patchedFiles, distDir };
}

export function patchInstalledOpenClawBrowserRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawBrowserRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}

