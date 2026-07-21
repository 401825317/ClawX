import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listenHttpServer } from '../electron/api/server-listener.ts';
import { acquireProcessInstanceFileLock } from '../electron/main/process-instance-lock.ts';
import {
  buildWindowsProcessInspectionScript,
  isProcessDescendantByParentResolver,
  isVerifiedUClawProcess,
} from '../electron/utils/process-inspection.ts';

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('Host API listener rejects EADDRINUSE instead of reporting startup success', async () => {
  const blocker = createServer();
  await listenHttpServer(blocker, 0);
  const address = blocker.address();
  assert.ok(address && typeof address === 'object');

  const candidate = createServer();
  try {
    await assert.rejects(
      listenHttpServer(candidate, address.port),
      (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE',
    );
    assert.equal(candidate.listening, false);
  } finally {
    await closeServer(candidate);
    await closeServer(blocker);
  }
});

test('Host API listener resolves only after the server is listening', async () => {
  const server = createServer();
  try {
    await listenHttpServer(server, 0);
    assert.equal(server.listening, true);
  } finally {
    await closeServer(server);
  }
});

test('Windows process termination requires exact executable and product identity', () => {
  assert.equal(isVerifiedUClawProcess({
    pid: 101,
    name: 'UClaw.exe',
    executablePath: 'C:\\Program Files\\UClaw\\UClaw.exe',
    productName: 'UClaw',
    productVersion: '1.0.2',
  }, 'win32'), true);
  assert.equal(isVerifiedUClawProcess({
    pid: 102,
    name: 'UClaw.exe',
    executablePath: 'C:\\Temp\\UClaw.exe',
  }, 'win32'), false);
  assert.equal(isVerifiedUClawProcess({
    pid: 103,
    name: 'python.exe',
    executablePath: 'C:\\Temp\\uclaw-helper\\python.exe',
    productName: 'Python',
  }, 'win32'), false);
});

test('Windows process inspection emits valid block and hashtable separators', () => {
  const script = buildWindowsProcessInspectionScript(321);
  assert.match(script, /ProcessId = 321/u);
  assert.doesNotMatch(script, /\{\s*;/u);
  assert.doesNotMatch(script, /@\{\s*;/u);
  assert.match(script, /productVersion = \$productVersion;/u);
});

test('macOS verification requires an exact UClaw or ClawX app-bundle executable', () => {
  assert.equal(isVerifiedUClawProcess({
    pid: 201,
    executablePath: '/Applications/UClaw.app/Contents/MacOS/UClaw',
  }, 'darwin'), true);
  assert.equal(isVerifiedUClawProcess({
    pid: 202,
    executablePath: '/tmp/UClaw.app-helper/Contents/MacOS/UClaw',
  }, 'darwin'), false);
});

test('Gateway listener ancestry accepts descendants and rejects cycles', async () => {
  const parents = new Map<number, number>([
    [403, 402],
    [402, 401],
  ]);
  assert.equal(await isProcessDescendantByParentResolver(
    403,
    401,
    async (pid) => parents.get(pid),
  ), true);

  const cycle = new Map<number, number>([
    [501, 502],
    [502, 501],
  ]);
  assert.equal(await isProcessDescendantByParentResolver(
    501,
    599,
    async (pid) => cycle.get(pid),
  ), false);
});

test('Windows installer closes both UClaw.exe and legacy ClawX.exe processes', () => {
  const installer = readFileSync('scripts/installer.nsh', 'utf8');
  const extractPatch = readFileSync('scripts/patch-nsis-extract.mjs', 'utf8');
  assert.match(installer, /!define CLAWX_INSTALLER_ROLLBACK/u);
  assert.match(extractPatch, /!ifdef CLAWX_INSTALLER_ROLLBACK/u);
  assert.match(installer, /!define LEGACY_APP_EXECUTABLE_FILENAME "ClawX\.exe"/u);
  assert.match(installer, /taskkill \/F \/T \/IM "\$\{LEGACY_APP_EXECUTABLE_FILENAME\}"/u);
  assert.match(
    installer,
    /Name -ieq '\$\{APP_EXECUTABLE_FILENAME\}' -or \$\$_\.Name -ieq '\$\{LEGACY_APP_EXECUTABLE_FILENAME\}'/u,
  );
  assert.match(extractPatch, /taskkill \/F \/T \/IM ClawX\.exe/u);
});

test('Windows installer removes obsolete ClawX shortcuts after a successful rename upgrade', () => {
  const installer = readFileSync('scripts/installer.nsh', 'utf8');
  assert.match(
    installer,
    /\$oldDesktopLink != \$newDesktopLink[\s\S]*WinShell::UninstShortcut "\$oldDesktopLink"[\s\S]*Delete "\$oldDesktopLink"/u,
  );
  assert.match(
    installer,
    /\$oldStartMenuLink != \$newStartMenuLink[\s\S]*WinShell::UninstShortcut "\$oldStartMenuLink"[\s\S]*Delete "\$oldStartMenuLink"/u,
  );
});

test('release workflow publishes installer and portable metadata without deleting the live channel', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const afterPack = readFileSync('scripts/after-pack.cjs', 'utf8');
  const usbFinalizer = readFileSync('scripts/build-usb-release.mjs', 'utf8');
  const signedMetadata = readFileSync('scripts/refresh-signed-windows-update-metadata.mjs', 'utf8');
  const signedUsbMetadata = readFileSync('scripts/refresh-signed-windows-usb-metadata.mjs', 'utf8');
  const selfCheck = readFileSync('scripts/windows-support/UClaw-SelfCheck.mjs', 'utf8');
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
  const windowsBuildWorkflow = readFileSync('.github/workflows/win-build-test.yml', 'utf8');
  assert.match(packageJson.scripts?.['package:win'] || '', /updater:build:win/u);
  assert.match(packageJson.scripts?.['package:win:portable'] || '', /--win portable --x64/u);
  assert.match(packageJson.scripts?.['package:win:portable'] || '', /updater:build:win/u);
  assert.match(afterPack, /uclaw-portable-updater\.exe/u);
  assert.match(usbFinalizer, /resources\/resources\/updater\/win32-x64\/uclaw-portable-updater\.exe/u);
  assert.match(usbFinalizer, /const WINDOWS_PE_FILES = \[[\s\S]*resources\/resources\/updater\/win32-x64\/uclaw-portable-updater\.exe/u);
  assert.match(selfCheck, /path\.join\('resources', 'resources', 'updater', 'win32-x64', 'uclaw-portable-updater\.exe'\)/u);
  assert.match(workflow, /pnpm run package:win\n\s+pnpm run package:win:usb/u);
  assert.match(workflow, /release\/UClaw-\*-win-x64-usb\.json/u);
  assert.match(workflow, /Missing required Windows USB package/u);
  assert.match(workflow, /publish metadata last to switch clients atomically/u);
  assert.match(workflow, /Verify managed records before legacy feed promotion/u);
  assert.equal(
    packageJson.scripts?.['release:refresh-win-metadata'],
    'node scripts/refresh-signed-windows-update-metadata.mjs',
  );
  assert.equal(
    packageJson.scripts?.['release:refresh-win-usb-metadata'],
    'node scripts/refresh-signed-windows-usb-metadata.mjs',
  );
  assert.equal(
    packageJson.scripts?.['test:win-signing:unit'],
    'node --test scripts/refresh-signed-windows-usb-metadata.test.mjs',
  );
  assert.match(workflow, /Refresh Windows update metadata after code signing/u);
  assert.match(workflow, /pnpm run release:refresh-win-metadata/u);
  assert.match(workflow, /Get-AuthenticodeSignature/u);
  assert.match(workflow, /signature\.Status -ne 'Valid'/u);
  assert.match(signedMetadata, /executeAppBuilderAsJson/u);
  assert.match(signedMetadata, /'blockmap',[\s\S]*'--input',[\s\S]*'--output'/u);
  assert.match(signedMetadata, /gunzipSync/u);
  assert.match(signedMetadata, /Generated blockmap covers/u);
  assert.match(signedMetadata, /Manifest verification failed after refresh/u);
  assert.match(signedUsbMetadata, /refreshSignedWindowsUsbMetadata/u);
  assert.match(signedUsbMetadata, /sha512Hex/u);
  assert.match(signedUsbMetadata, /assertMetadataShape/u);
  assert.match(workflow, /SIGNPATH_USB_ARTIFACT_CONFIGURATION_SLUG/u);
  assert.match(workflow, /artifact-configuration-slug:/u);
  assert.match(workflow, /archive: false/u);
  assert.match(workflow, /release\/signpath-input\/\*\.zip/u);
  assert.match(workflow, /signpath-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(workflow, /skip-decompress: true/u);
  assert.match(workflow, /release:refresh-win-usb-metadata/u);
  assert.match(workflow, /Validate signed Windows USB package[\s\S]*test:packaged:win:full/u);
  assert.match(workflow, /signed USB ZIP/u);
  assert.match(workflow, /resources\\resources\\updater\\win32-x64\\uclaw-portable-updater\.exe/u);
  for (const signingWorkflow of [workflow, windowsBuildWorkflow]) {
    assert.match(signingWorkflow, /release\/signpath-input\/\*\.zip/u);
    assert.match(signingWorkflow, /signpath-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
    assert.match(signingWorkflow, /skip-decompress: true/u);
    assert.match(signingWorkflow, /Validate signed Windows USB package[\s\S]*test:packaged:win:full/u);
    assert.match(
      signingWorkflow,
      /Run signed Windows cross-version upgrade matrix[\s\S]*pnpm run test:upgrade:win/u,
    );
    assert.match(signingWorkflow, /UCLAW_UPGRADE_INSTALLER_101_URL/u);
    assert.match(signingWorkflow, /UCLAW_UPGRADE_INSTALLER_101_SHA512/u);
    assert.match(signingWorkflow, /release\/regression\/windows-upgrade-matrix-\*/u);
  }
  assert.match(workflow, /--managed-only/u);
  assert.match(workflow, /--mac-manifest staging\/latest\/latest-mac\.yml/u);
  assert.match(workflow, /--linux-manifest staging\/latest\/latest-linux\.yml/u);
  assert.match(workflow, /needs: \[publish, upload-oss, promote-update-channels\]/u);
  assert.doesNotMatch(workflow, /UClaw-\*-win-arm64\.exe/u);
  assert.doesNotMatch(workflow, /ossutil rm -r -f oss:\/\/valuecell-clawx\/\$\{CHANNEL\}/u);
});

test('manual Windows workflow exposes the native cross-version upgrade matrix', () => {
  const workflow = readFileSync('.github/workflows/package-win-manual.yml', 'utf8');
  assert.match(workflow, /- upgrade_matrix/u);
  assert.match(workflow, /require_private_installer:/u);
  assert.match(workflow, /pnpm run package:win:usb/u);
  assert.match(workflow, /pnpm run package:win/u);
  assert.match(workflow, /pnpm run test:upgrade:win -- --require-complete-installers/u);
  assert.match(workflow, /pnpm run test:upgrade:win\n/u);
  assert.match(workflow, /UCLAW_UPGRADE_INSTALLER_101_URL/u);
  assert.match(workflow, /UCLAW_UPGRADE_INSTALLER_101_SHA512/u);
  assert.match(workflow, /release\/regression\/windows-upgrade-matrix-\*/u);
});

test('Windows upgrade matrix verifies target artifacts and representative customer eras', () => {
  const matrix = readFileSync('scripts/windows-support/run-upgrade-matrix.mjs', 'utf8');
  for (const version of ['0.3.2', '0.4.6', '0.4.8', '0.5.0', '0.7.1', '1.0.1']) {
    assert.match(matrix, new RegExp(`['"]${version.replaceAll('.', '\\.')}['"]`, 'u'));
  }
  assert.match(matrix, /DOWNLOAD_ATTEMPTS = 3/u);
  assert.match(matrix, /AbortSignal\.timeout\(DOWNLOAD_TIMEOUT_MS\)/u);
  assert.match(matrix, /Target installer manifest mismatch/u);
  assert.match(matrix, /Target installer blockmap missing or empty/u);
  assert.match(matrix, /inspectProductShortcuts/u);
  assert.match(matrix, /assertProductShortcut/u);
  assert.match(matrix, /assertNoLegacyShortcut/u);
  assert.match(matrix, /assertNoScenarioShortcuts/u);
  assert.match(matrix, /portable-current-helper-archive-rejection/u);
  assert.match(matrix, /invalid-update\.zip/u);
  assert.match(matrix, /assertBlockmapMatchesInstaller\(installerPath, blockmapPath\)/u);
  assert.match(matrix, /kind: 'installed-nsis-clean'/u);
  assert.match(matrix, /function installedScenarioKind\(version\)/u);
  assert.match(matrix, /return version === '0\.7\.1'/u);
  assert.match(matrix, /'installed-nsis-overwrite'/u);
  assert.match(matrix, /installed-electron-updater/u);
  assert.match(matrix, /CLAWX_UPDATE_FEED_BASE_URL/u);
  assert.match(matrix, /ipcRenderer\.invoke\('update:check'\)/u);
  assert.match(matrix, /ipcRenderer\.invoke\('update:download'\)/u);
  assert.match(matrix, /ipcRenderer\.invoke\('update:install'\)/u);
  assert.match(matrix, /manifestRequests/u);
  assert.match(matrix, /installerRequests/u);
  assert.match(matrix, /kind: 'portable-legacy-helper-first-hop'/u);
  assert.match(matrix, /kind: 'portable-current-helper-startup-confirmation'/u);
  assert.match(matrix, /kind: 'portable-current-helper-startup-rollback'/u);
  assert.match(matrix, /kind: 'portable-current-helper-integrity-rejection'/u);
  assert.match(matrix, /for \(const failureMode of \['size', 'sha512'\]\)/u);
  assert.match(matrix, /legacyHelperSha512/u);
  assert.match(matrix, /currentHelperSha512/u);
  assert.match(matrix, /runTargetRuntimeSmoke/u);
  assert.match(matrix, /waitForExistingRuntime/u);
  assert.match(matrix, /const launchPath = path\.join\(appRoot, 'UClaw\.exe'\)/u);
  assert.match(matrix, /targetVersion: `\$\{TARGET_VERSION\}-ack-timeout`/u);
  assert.match(matrix, /\/api\/gateway\/status/u);
  assert.match(matrix, /hostResponse\.status === 401/u);
  assert.match(matrix, /\/health/u);
  assert.match(matrix, /runNsisUninstaller/u);
  assert.match(matrix, /uninstallMarkersPreserved/u);
  assert.match(matrix, /restoredRuntime/u);
  assert.match(matrix, /repository: '401825317\/ClawX'/u);
  assert.match(matrix, /productName: 'UClaw'/u);
  assert.match(matrix, /UCLAW_UPGRADE_INSTALLER_101_URL/u);
  assert.doesNotMatch(matrix, /UCLAW_UPGRADE_INSTALLER_071_URL/u);
});

test('public update channel verifier covers every historical customer discovery path', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const verifier = readFileSync('scripts/verify-public-update-channel.mjs', 'utf8');
  assert.equal(
    packageJson.scripts?.['test:update-channel'],
    'node scripts/verify-public-update-channel.mjs',
  );
  assert.equal(
    packageJson.scripts?.['test:update-channel:unit'],
    'node --test scripts/verify-public-update-channel.test.mjs',
  );
  const checkWorkflow = readFileSync('.github/workflows/check.yml', 'utf8');
  assert.match(checkWorkflow, /pnpm run test:update-channel:unit/u);
  assert.match(verifier, /ENDPOINTS\.appUpdates/u);
  assert.match(verifier, /MANAGED_FEED_PATH/u);
  assert.match(verifier, /LEGACY_FEED_BASE_URL/u);
  assert.match(verifier, /--managed-only/u);
  assert.match(verifier, /package_type', 'portable_zip'/u);
  assert.match(verifier, /returned HTML instead of update YAML/u);
  assert.match(verifier, /managed and legacy installer feeds/u);
  assert.match(verifier, /local and public installer metadata/u);
  assert.match(verifier, /local and public portable metadata/u);
});

test('shared instance lock blocks a live owner and reclaims a stale owner', () => {
  const lockDir = mkdtempSync(join(tmpdir(), 'uclaw-runtime-lock-'));
  try {
    const first = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'uclaw-test',
      pid: 1101,
      isPidAlive: (pid) => pid === 1101,
    });
    assert.equal(first.acquired, true);

    const blocked = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'uclaw-test',
      pid: 1102,
      isPidAlive: (pid) => pid === 1101,
    });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.ownerPid, 1101);
    first.release();

    writeFileSync(first.lockPath, '1101', 'utf8');
    const reclaimed = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'uclaw-test',
      pid: 1102,
      isPidAlive: () => false,
    });
    assert.equal(reclaimed.acquired, true);
    reclaimed.release();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test('shared instance lock never removes unknown or changed ownership content', () => {
  const lockDir = mkdtempSync(join(tmpdir(), 'uclaw-runtime-lock-'));
  try {
    const seed = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'uclaw-test',
      pid: 1201,
      isPidAlive: () => true,
    });
    assert.equal(seed.acquired, true);

    writeFileSync(seed.lockPath, 'unrecognized-owner', 'utf8');
    seed.release();
    assert.equal(readFileSync(seed.lockPath, 'utf8'), 'unrecognized-owner');

    const blocked = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'uclaw-test',
      pid: 1202,
      isPidAlive: () => false,
    });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.ownerFormat, 'unknown');

    rmSync(seed.lockPath, { force: true });
    const changed = acquireProcessInstanceFileLock({
      lockDir,
      lockName: 'uclaw-test',
      pid: 1203,
      isPidAlive: () => true,
    });
    assert.equal(changed.acquired, true);
    writeFileSync(changed.lockPath, '1204', 'utf8');
    changed.release();
    assert.equal(readFileSync(changed.lockPath, 'utf8'), '1204');
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});
