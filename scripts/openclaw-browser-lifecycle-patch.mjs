import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_NAME = 'openclaw-browser-lifecycle-patch';
const RUNTIME_SIGNATURE = 'function createProfileAvailability({ opts, profile, state, getProfileState, setProfileRunning }) {';
const PATCH_MARKERS = [
  'UCLAW_BROWSER_LIFECYCLE_PORT_CONFLICT_V1',
  'UCLAW_BROWSER_LIFECYCLE_RUNNING_GUARD_V1',
  'UCLAW_BROWSER_LIFECYCLE_NO_RESTART_V1',
];

const WAIT_FOR_CDP_READY_AFTER_LAUNCH_ANCHOR = `\tconst waitForCdpReadyAfterLaunch = async () => {
\t\tconst deadlineMs = Date.now() + (state().resolved.localCdpReadyTimeoutMs ?? CDP_READY_AFTER_LAUNCH_WINDOW_MS);
\t\twhile (Date.now() < deadlineMs) {
\t\t\tconst remainingMs = Math.max(0, deadlineMs - Date.now());
\t\t\tif (await isReachable(Math.max(75, Math.min(250, remainingMs)))) return;
\t\t\tawait new Promise((r) => {
\t\t\t\tsetTimeout(r, 100);
\t\t\t});
\t\t}
\t\tthrow new Error(\`Chrome CDP websocket for profile "\${profile.name}" is not reachable after start. \${await describeCdpFailure(250)}\`);
\t};`;

const WAIT_FOR_CDP_READY_AFTER_LAUNCH_PATCH = `${WAIT_FOR_CDP_READY_AFTER_LAUNCH_ANCHOR}
\tconst waitForExistingManagedChromeCdp = async (profileState) => {
\t\tassertManagedLaunchNotCoolingDown(profile.name, profileState);
\t\ttry {
\t\t\tawait waitForCdpReadyAfterLaunch();
\t\t\tresetManagedLaunchFailure(profileState);
\t\t} catch (err) {
\t\t\trecordManagedLaunchFailure(profileState, err);
\t\t\tconst runningPid = profileState.running?.pid;
\t\t\tconst pidDetail = typeof runningPid === "number" && runningPid > 0 ? \` (pid \${runningPid})\` : "";
\t\t\tthrow new BrowserProfileUnavailableError(\`Managed Chrome profile "\${profile.name}"\${pidDetail} is already registered by this OpenClaw runtime, but its CDP endpoint did not become ready after a bounded re-probe. OpenClaw will not launch or restart another Chrome on port \${profile.cdpPort}. \${formatLocalPortOwnershipHint(profile)} Last CDP error: \${normalizeFailureMessage(err)}\`); // UCLAW_BROWSER_LIFECYCLE_RUNNING_GUARD_V1
\t\t}
\t};`;

const LAUNCH_MANAGED_CHROME_ANCHOR = `\tconst launchManagedChrome = async (profileState, current, launchOptions) => {
\t\tassertManagedLaunchNotCoolingDown(profile.name, profileState);
\t\ttry {
\t\t\treturn await launchOpenClawChrome(current.resolved, profile, launchOptions);
\t\t} catch (err) {
\t\t\trecordManagedLaunchFailure(profileState, err);
\t\t\tthrow err;
\t\t}
\t};`;

const LAUNCH_MANAGED_CHROME_PATCH = `\tconst isManagedChromePortConflict = (err) => {
\t\tconst code = err && typeof err === "object" ? err.code : void 0;
\t\tconst name = err instanceof Error ? err.name : "";
\t\tconst message = normalizeFailureMessage(err);
\t\treturn code === "EADDRINUSE" || name === "PortInUseError" || /\\bEADDRINUSE\\b|already in use/i.test(message);
\t};
\tconst recordManagedChromePortConflict = (profileState, err) => {
\t\tconst now = Date.now();
\t\tprofileState.managedLaunchFailure = {
\t\t\tconsecutiveFailures: MANAGED_LAUNCH_FAILURE_THRESHOLD,
\t\t\tlastFailureAt: now,
\t\t\tcooldownUntil: now + MANAGED_LAUNCH_COOLDOWN_BASE_MS,
\t\t\tlastError: normalizeFailureMessage(err)
\t\t};
\t};
\tconst launchManagedChrome = async (profileState, current, launchOptions) => {
\t\tassertManagedLaunchNotCoolingDown(profile.name, profileState);
\t\ttry {
\t\t\treturn await launchOpenClawChrome(current.resolved, profile, launchOptions);
\t\t} catch (err) {
\t\t\tif (isManagedChromePortConflict(err)) {
\t\t\t\tif (await isHttpReachable(1200) && await isReachable(1200)) {
\t\t\t\t\tresetManagedLaunchFailure(profileState);
\t\t\t\t\treturn null;
\t\t\t\t}
\t\t\t\trecordManagedChromePortConflict(profileState, err);
\t\t\t\tconst detail = await describeCdpFailure(250).catch(() => "CDP diagnostic unavailable.");
\t\t\t\tconst cooldownSeconds = Math.ceil(MANAGED_LAUNCH_COOLDOWN_BASE_MS / 1e3);
\t\t\t\tthrow new BrowserProfileUnavailableError(\`CDP port \${profile.cdpPort} for profile "\${profile.name}" is occupied while this OpenClaw runtime has no matching managed Chrome identity. OpenClaw will not start a second Chrome or retry this port conflict automatically for \${cooldownSeconds}s. \${formatLocalPortOwnershipHint(profile)} \${detail}\`); // UCLAW_BROWSER_LIFECYCLE_PORT_CONFLICT_V1
\t\t\t}
\t\t\trecordManagedLaunchFailure(profileState, err);
\t\t\tthrow err;
\t\t}
\t};`;

const UNREACHABLE_CDP_BRANCH_ANCHOR = `\t\tif (!httpReachable) {
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
\t\t\tif (attachOnly || remoteCdp) throw new BrowserProfileUnavailableError(remoteCdp ? \`Remote CDP for profile "\${profile.name}" is not reachable at \${redactedProfileCdpUrl}.\` : \`Browser attachOnly is enabled and profile "\${profile.name}" is not running.\`);
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
\t\t}`;

const UNREACHABLE_CDP_BRANCH_PATCH = `\t\tif (!httpReachable) {
\t\t\tif ((attachOnly || remoteCdp) && opts.onEnsureAttachTarget) {
\t\t\t\tawait opts.onEnsureAttachTarget(profile);
\t\t\t\tif (await isHttpReachable(1200)) return;
\t\t\t}
\t\t\tif (!attachOnly && !remoteCdp && profile.cdpIsLoopback) {
\t\t\t\tif (await isHttpReachable(1200) && await isReachable(1200)) {
\t\t\t\t\tresetManagedLaunchFailure(profileState);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tif (profileState.running) {
\t\t\t\t\tawait waitForExistingManagedChromeCdp(profileState);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t}
\t\t\tif (attachOnly || remoteCdp) throw new BrowserProfileUnavailableError(remoteCdp ? \`Remote CDP for profile "\${profile.name}" is not reachable at \${redactedProfileCdpUrl}.\` : \`Browser attachOnly is enabled and profile "\${profile.name}" is not running.\`);
\t\t\tconst launched = await launchManagedChrome(profileState, current, launchOptions);
\t\t\tif (!launched) return;
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
\t\t}`;

const UNHEALTHY_OWNED_CDP_BRANCH_ANCHOR = `\t\tif (!profileState.running) {
\t\t\tconst detail = await describeCdpFailure(PROFILE_ATTACH_RETRY_TIMEOUT_MS);
\t\t\tthrow new BrowserProfileUnavailableError(\`Port \${profile.cdpPort} is in use for profile "\${profile.name}" but not by openclaw. \${formatLocalPortOwnershipHint(profile)} \${detail}\`);
\t\t}
\t\tawait stopOpenClawChrome(profileState.running);
\t\tsetProfileRunning(null);
\t\tattachRunning(await launchManagedChrome(profileState, current, launchOptions));
\t\tif (!await isReachable(600)) {
\t\t\tconst err = /* @__PURE__ */ new Error(\`Chrome CDP websocket for profile "\${profile.name}" is not reachable after restart. \${await describeCdpFailure(600)}\`);
\t\t\trecordManagedLaunchFailure(profileState, err);
\t\t\tthrow err;
\t\t}
\t\tresetManagedLaunchFailure(profileState);`;

const UNHEALTHY_OWNED_CDP_BRANCH_PATCH = `\t\tif (!profileState.running) {
\t\t\tconst detail = await describeCdpFailure(PROFILE_ATTACH_RETRY_TIMEOUT_MS);
\t\t\tthrow new BrowserProfileUnavailableError(\`Port \${profile.cdpPort} is in use for profile "\${profile.name}" but not by openclaw. \${formatLocalPortOwnershipHint(profile)} \${detail}\`);
\t\t}
\t\tawait waitForExistingManagedChromeCdp(profileState); // UCLAW_BROWSER_LIFECYCLE_NO_RESTART_V1`;

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

function assertPatchIsComplete(content, filePath) {
  const presentMarkers = PATCH_MARKERS.filter((marker) => content.includes(marker));
  if (presentMarkers.length === 0) return false;
  if (presentMarkers.length !== PATCH_MARKERS.length) {
    throw new Error(`[${PATCH_NAME}] Browser lifecycle runtime is only partially patched: ${filePath}`);
  }
  for (const marker of PATCH_MARKERS) {
    if (countOccurrences(content, marker) !== 1) {
      throw new Error(`[${PATCH_NAME}] Browser lifecycle marker is not unique in ${filePath}: ${marker}`);
    }
  }
  return true;
}

export function patchOpenClawBrowserLifecycleContent(content, filePath = '<fixture>') {
  if (!content.includes(RUNTIME_SIGNATURE)) {
    return { content, changed: false, matched: false };
  }
  if (assertPatchIsComplete(content, filePath)) {
    return { content, changed: false, matched: true };
  }

  let patched = replaceUnique(
    content,
    WAIT_FOR_CDP_READY_AFTER_LAUNCH_ANCHOR,
    WAIT_FOR_CDP_READY_AFTER_LAUNCH_PATCH,
    'existing managed Chrome CDP re-probe',
    filePath,
  );
  patched = replaceUnique(
    patched,
    LAUNCH_MANAGED_CHROME_ANCHOR,
    LAUNCH_MANAGED_CHROME_PATCH,
    'managed Chrome launch conflict handling',
    filePath,
  );
  patched = replaceUnique(
    patched,
    UNREACHABLE_CDP_BRANCH_ANCHOR,
    UNREACHABLE_CDP_BRANCH_PATCH,
    'unreachable CDP launch branch',
    filePath,
  );
  patched = replaceUnique(
    patched,
    UNHEALTHY_OWNED_CDP_BRANCH_ANCHOR,
    UNHEALTHY_OWNED_CDP_BRANCH_PATCH,
    'unhealthy managed Chrome restart branch',
    filePath,
  );
  return { content: patched, changed: true, matched: true };
}

export function patchOpenClawBrowserLifecycleRuntime(distDir, options = {}) {
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
      result: patchOpenClawBrowserLifecycleContent(readFileSync(target.filePath, 'utf8'), target.filePath),
    }))
    .filter(({ result }) => result.matched);

  if (targets.length !== 1) {
    throw new Error(`[${PATCH_NAME}] Expected exactly one browser availability runtime in ${distDir}; found ${targets.length}.`);
  }

  const target = targets[0];
  if (target.result.changed && !dryRun) {
    writeFileSync(target.filePath, target.result.content, 'utf8');
  }
  logger.log?.(
    `[${PATCH_NAME}] ${target.result.changed ? (dryRun ? 'Dry-run matched' : 'Patched') : 'Already patched'}: ${target.file}`,
  );
  return {
    patchedFiles: target.result.changed ? 1 : 0,
    alreadyPatchedFiles: target.result.changed ? 0 : 1,
    browserLifecycleFile: target.filePath,
  };
}

export function patchInstalledOpenClawBrowserLifecycleRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawBrowserLifecycleRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
