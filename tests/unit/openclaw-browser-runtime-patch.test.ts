import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { patchOpenClawBrowserRuntime } from '../../scripts/openclaw-browser-runtime-patch.mjs';

describe('OpenClaw browser runtime patch', () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('adds resilient browser recovery and compact snapshot summaries', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'uclaw-browser-runtime-patch-'));
    const distDir = join(tempRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    const runtimeFile = join(distDir, 'plugin-service-test.js');

    writeFileSync(
      runtimeFile,
      `
function canRetryChromeActWithoutTargetId(request) {
\tconst typedRequest = request;
\tconst kind = typeof typedRequest.kind === "string" ? typedRequest.kind : typeof typedRequest.action === "string" ? typedRequest.action : "";
\treturn kind === "hover" || kind === "scrollIntoView" || kind === "wait";
}
async function executeSnapshotAction(params) {
\tif (snapshot.format === "ai") {
\t\tif (snapshot.blockedByDialog) {
\t\t\treturn {
\t\t\t\tcontent: [],
\t\t\t\tdetails: {
\t\t\t\t\t...wrapped.safeDetails,
\t\t\t\t\tformat: snapshot.format,
\t\t\t\t\ttargetId: snapshot.targetId,
\t\t\t\t\turl: snapshot.url,
\t\t\t\t\t...dialogStateFields
\t\t\t\t}
\t\t\t};
\t\t}
\t\tconst safeDetails = {
\t\t\tok: true,
\t\t\tformat: snapshot.format,
\t\t\ttargetId: snapshot.targetId,
\t\t\turl: snapshot.url,
\t\t\ttruncated: snapshot.truncated,
\t\t\tstats: snapshot.stats,
\t\t\trefs: snapshot.refs ? Object.keys(snapshot.refs).length : void 0,
\t\t\tlabels: snapshot.labels,
\t\t\tlabelsCount: snapshot.labelsCount,
\t\t\tlabelsSkipped: snapshot.labelsSkipped,
\t\t\tannotations: snapshot.annotations,
\t\t\timagePath: snapshot.imagePath,
\t\t};
\t}
\treturn {
\t\tcontent: [],
\t\tdetails: {
\t\t\t...wrapped.safeDetails,
\t\t\tformat: "aria",
\t\t\ttargetId: snapshot.targetId,
\t\t\turl: snapshot.url,
\t\t\tnodeCount: snapshot.nodes.length,
\t\t\t...snapshot.blockedByDialog ? { blockedByDialog: true } : {},
\t\t}
\t};
}
async function executeActAction(params) {
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
const hint = 'Do NOT retry the browser tool.';
`,
      'utf8',
    );

    const result = patchOpenClawBrowserRuntime(distDir, { logger: { log: () => undefined } });
    const patched = readFileSync(runtimeFile, 'utf8');

    expect(result.patchedFiles).toBe(1);
    expect(patched).toContain('function isBrowserTargetIdMismatchError(err)');
    expect(patched).toContain('recoveredFrom: "targetIdMismatch"');
    expect(patched).toContain('recoveredFrom: "staleRef"');
    expect(patched).toContain('pageSummary: buildBrowserPageSummary(snapshot)');
    expect(patched).toContain('You may retry once if this was a transient error.');
  });
});

