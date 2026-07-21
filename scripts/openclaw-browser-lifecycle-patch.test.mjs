import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  patchOpenClawBrowserLifecycleContent,
  patchOpenClawBrowserLifecycleRuntime,
} from './openclaw-browser-lifecycle-patch.mjs';

const installedOpenClawDistDir = join(process.cwd(), 'node_modules', 'openclaw', 'dist');
const hasInstalledOpenClawRuntime = existsSync(installedOpenClawDistDir);

const lifecycleFixture = `
function createProfileAvailability({ opts, profile, state, getProfileState, setProfileRunning }) {
\tconst redactedProfileCdpUrl = redactCdpUrl(profile.cdpUrl) ?? profile.cdpUrl;
\tconst capabilities = getBrowserProfileCapabilities(profile);
\tconst isReachable = async (timeoutMs) => timeoutMs;
\tconst isHttpReachable = async (timeoutMs) => timeoutMs;
\tconst describeCdpFailure = async () => "diagnostic";
\tconst waitForCdpReadyAfterLaunch = async () => {
\t\tconst deadlineMs = Date.now() + (state().resolved.localCdpReadyTimeoutMs ?? CDP_READY_AFTER_LAUNCH_WINDOW_MS);
\t\twhile (Date.now() < deadlineMs) {
\t\t\tconst remainingMs = Math.max(0, deadlineMs - Date.now());
\t\t\tif (await isReachable(Math.max(75, Math.min(250, remainingMs)))) return;
\t\t\tawait new Promise((r) => {
\t\t\t\tsetTimeout(r, 100);
\t\t\t});
\t\t}
\t\tthrow new Error(\`Chrome CDP websocket for profile "\${profile.name}" is not reachable after start. \${await describeCdpFailure(250)}\`);
\t};
\tconst launchManagedChrome = async (profileState, current, launchOptions) => {
\t\tassertManagedLaunchNotCoolingDown(profile.name, profileState);
\t\ttry {
\t\t\treturn await launchOpenClawChrome(current.resolved, profile, launchOptions);
\t\t} catch (err) {
\t\t\trecordManagedLaunchFailure(profileState, err);
\t\t\tthrow err;
\t\t}
\t};
\tconst ensureBrowserAvailableOnce = async (options) => {
\t\tconst current = state();
\t\tconst remoteCdp = capabilities.isRemote;
\t\tconst attachOnly = profile.attachOnly;
\t\tconst profileState = getProfileState();
\t\tconst httpReachable = await isHttpReachable();
\t\tconst launchOptions = launchOptionsForEnsure(options);
\t\tif (!httpReachable) {
\t\t\tif ((attachOnly || remoteCdp) && opts.onEnsureAttachTarget) {
\t\t\t\tawait opts.onEnsureAttachTarget(profile);
\t\t\t\tif (await isHttpReachable(1200)) return;
\t\t\t}
\t\t\tif (!attachOnly && !remoteCdp && profile.cdpIsLoopback && !profileState.running) {
\t\t\t\tif (await isHttpReachable(1200) && await isReachable(1200)) {
\t\t\t\t\tresetManagedLaunchFailure(profileState);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t}
\t\t\tif (attachOnly || remoteCdp) {
\t\t\t\tif (capabilities.mode === "local-extension") {
\t\t\t\t\tconst { EXTENSION_PAIRING_HINT } = await getExtensionRelayModule();
\t\t\t\t\tthrow new BrowserProfileUnavailableError(\`The OpenClaw Chrome extension is not connected for profile "\${profile.name}". Open Chrome on this machine and check the extension popup shows "Connected". \${EXTENSION_PAIRING_HINT}\`);
\t\t\t\t}
\t\t\t\tthrow new BrowserProfileUnavailableError(remoteCdp ? \`Remote CDP for profile "\${profile.name}" is not reachable at \${redactedProfileCdpUrl}.\` : \`Browser attachOnly is enabled and profile "\${profile.name}" is not running.\`);
\t\t\t}
\t\t\tconst launched = await launchManagedChrome(profileState, current, launchOptions);
\t\t\tattachRunning(launched);
\t\t\ttry {
\t\t\t\tawait waitForCdpReadyAfterLaunch();
\t\t\t\tresetManagedLaunchFailure(profileState);
\t\t\t} catch (err) {
\t\t\t\tawait stopOpenClawChrome(launched).catch(() => {});
\t\t\t\tsetProfileRunning(null);
\t\t\t\trecordManagedLaunchFailure(profileState, err);
\t\t\t\tthrow err;
\t\t\t}
\t\t\treturn;
\t\t}
\t\tif (await isReachable()) {
\t\t\tresetManagedLaunchFailure(profileState);
\t\t\treturn;
\t\t}
\t\tif (attachOnly || remoteCdp) {
\t\t\tif (opts.onEnsureAttachTarget) {
\t\t\t\tawait opts.onEnsureAttachTarget(profile);
\t\t\t\tif (await isReachable(1200)) return;
\t\t\t}
\t\t\tif (remoteCdp && await isReachable(1200)) return;
\t\t\tconst detail = await describeCdpFailure(PROFILE_ATTACH_RETRY_TIMEOUT_MS);
\t\t\tthrow new BrowserProfileUnavailableError(remoteCdp ? \`Remote CDP websocket for profile "\${profile.name}" is not reachable. \${detail}\` : \`Browser attachOnly is enabled and CDP websocket for profile "\${profile.name}" is not reachable. \${detail}\`);
\t\t}
\t\tif (!profileState.running) {
\t\t\tconst detail = await describeCdpFailure(PROFILE_ATTACH_RETRY_TIMEOUT_MS);
\t\t\tthrow new BrowserProfileUnavailableError(\`Port \${profile.cdpPort} is in use for profile "\${profile.name}" but not by openclaw. \${formatLocalPortOwnershipHint(profile)} \${detail}\`);
\t\t}
\t\tawait stopOpenClawChrome(profileState.running);
\t\tsetProfileRunning(null);
\t\tconst relaunched = await launchManagedChrome(profileState, current, launchOptions);
\t\tattachRunning(relaunched);
\t\tif (!await isReachable(600)) {
\t\t\tconst err = /* @__PURE__ */ new Error(\`Chrome CDP websocket for profile "\${profile.name}" is not reachable after restart. \${await describeCdpFailure(600)}\`);
\t\t\trecordManagedLaunchFailure(profileState, err);
\t\t\tthrow err;
\t\t}
\t\tresetManagedLaunchFailure(profileState);
\t};
}
`;

test('existing managed Chrome is re-probed instead of relaunched', () => {
  const result = patchOpenClawBrowserLifecycleContent(lifecycleFixture, 'server-context.js');
  assert.equal(result.changed, true);
  assert.equal(result.matched, true);
  assert.match(result.content, /UCLAW_BROWSER_LIFECYCLE_RUNNING_GUARD_V1/u);
  assert.match(result.content, /await waitForExistingManagedChromeCdp\(profileState\);/u);
  assert.match(result.content, /OpenClaw will not launch or restart another Chrome on port/u);
  assert.doesNotMatch(result.content, /await stopOpenClawChrome\(profileState\.running\);/u);
  assert.doesNotMatch(result.content, /not reachable after restart/u);
  assert.equal(patchOpenClawBrowserLifecycleContent(result.content, 'server-context.js').changed, false);
});

test('a CDP port conflict has a deterministic owner-state error and cooldown', () => {
  const result = patchOpenClawBrowserLifecycleContent(lifecycleFixture, 'server-context.js');
  assert.match(result.content, /UCLAW_BROWSER_LIFECYCLE_PORT_CONFLICT_V1/u);
  assert.match(result.content, /no matching managed Chrome identity/u);
  assert.match(result.content, /if \(await isHttpReachable\(1200\) && await isReachable\(1200\)\)/u);
  assert.match(result.content, /if \(!launched\) return;/u);
  assert.match(result.content, /will not start a second Chrome or retry this port conflict automatically/u);
  assert.match(result.content, /cooldownUntil: now \+ MANAGED_LAUNCH_COOLDOWN_BASE_MS/u);
  assert.match(result.content, /name === "PortInUseError"/u);
});

test('runtime patch supports dry-run, write, and idempotence', () => {
  const distDir = mkdtempSync(join(tmpdir(), 'uclaw-browser-lifecycle-'));
  const target = join(distDir, 'server-context.js');
  writeFileSync(target, lifecycleFixture, 'utf8');
  writeFileSync(join(distDir, 'unrelated.js'), 'export const unrelated = true;', 'utf8');

  const dryRun = patchOpenClawBrowserLifecycleRuntime(distDir, { dryRun: true, logger: { log() {} } });
  assert.equal(dryRun.patchedFiles, 1);
  assert.equal(readFileSync(target, 'utf8'), lifecycleFixture);

  const first = patchOpenClawBrowserLifecycleRuntime(distDir, { logger: { log() {} } });
  assert.equal(first.patchedFiles, 1);
  assert.match(readFileSync(target, 'utf8'), /UCLAW_BROWSER_LIFECYCLE_NO_RESTART_V1/u);

  const second = patchOpenClawBrowserLifecycleRuntime(distDir, { logger: { log() {} } });
  assert.equal(second.patchedFiles, 0);
  assert.equal(second.alreadyPatchedFiles, 1);
});

test('runtime patch fails closed when the availability runtime is missing', () => {
  const distDir = mkdtempSync(join(tmpdir(), 'uclaw-browser-lifecycle-missing-'));
  writeFileSync(join(distDir, 'unrelated.js'), 'export const unrelated = true;', 'utf8');
  assert.throws(
    () => patchOpenClawBrowserLifecycleRuntime(distDir, { logger: { log() {} } }),
    /Expected exactly one browser availability runtime/u,
  );
});

test('current installed OpenClaw runtime still matches the lifecycle patch anchors', { skip: !hasInstalledOpenClawRuntime }, () => {
  const result = patchOpenClawBrowserLifecycleRuntime(
    installedOpenClawDistDir,
    { dryRun: true, logger: { log() {} } },
  );
  assert.equal(result.patchedFiles + result.alreadyPatchedFiles, 1);
});

test('the transformed installed OpenClaw runtime remains syntactically valid', { skip: !hasInstalledOpenClawRuntime }, () => {
  const source = patchOpenClawBrowserLifecycleRuntime(
    installedOpenClawDistDir,
    { dryRun: true, logger: { log() {} } },
  ).browserLifecycleFile;
  const distDir = mkdtempSync(join(tmpdir(), 'uclaw-browser-lifecycle-parse-'));
  const target = join(distDir, 'server-context.js');
  writeFileSync(target, readFileSync(source, 'utf8'), 'utf8');
  const result = patchOpenClawBrowserLifecycleRuntime(distDir, { logger: { log() {} } });
  // The installed bundle may already have been patched by postinstall/predev.
  // Copying it into the fixture must still prove that the transformed runtime
  // is valid JavaScript without making this test order-dependent.
  assert.equal(result.patchedFiles + result.alreadyPatchedFiles, 1);
  execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
});
