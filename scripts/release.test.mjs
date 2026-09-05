import assert from 'node:assert/strict';
import { execFileSync as runProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  inspectPortableArtifact,
  sha512File,
} from './windows-support/portable-release-utils.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const COMMIT = 'a'.repeat(40);

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-local-release-'));
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ version: '2.0.0' }, null, 2)}\n`);
  return root;
}

async function createPortableArtifactFixture(metadataOverrides = {}) {
  const root = await createFixture();
  const releaseDir = path.join(root, 'release');
  const zipFileName = 'UClaw-2.0.0-win-x64-usb.zip';
  const zipPath = path.join(releaseDir, zipFileName);
  const metadataPath = zipPath.replace(/\.zip$/u, '.json');
  await mkdir(releaseDir, { recursive: true });
  await writeFile(zipPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]));
  const zipSize = (await readFile(zipPath)).length;
  const sha512 = await sha512File(zipPath);
  const metadata = {
    version: '2.0.0',
    packageType: 'portable_zip',
    package_type: 'portable_zip',
    fileName: zipFileName,
    file_name: zipFileName,
    size: zipSize,
    sha512,
    buildId: 'real-artifact-build',
    gitCommit: COMMIT,
    ...metadataOverrides,
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return { root, zipPath, metadataPath, metadata, zipSize, sha512 };
}

function createCommandRunner({ dirty = false } = {}) {
  const calls = [];
  const execFileSync = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'git' && args[0] === 'status') return dirty ? ' M package.json\n' : '';
    if (command === 'git' && args[0] === 'rev-parse') return `${COMMIT}\n`;
    if (command === 'pnpm.cmd') return null;
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  return { calls, execFileSync };
}

async function loadReleaseModule() {
  return import('./release.mjs');
}

test('package metadata exposes the local Windows USB release entry at a stable version', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(pkg.scripts.release, 'node scripts/release.mjs');
  assert.match(pkg.scripts['test:release:pipeline'], /(?:^|\s)scripts\/release\.test\.mjs(?:\s|$)/u);
  assert.match(pkg.scripts['package:win:usb'], /--publish never/u);
  assert.equal(
    pkg.scripts['package:win:usb'].includes('run-packaged-regression'),
    false,
    'package:win:usb must build artifacts without running functional regression',
  );
  for (const forbidden of [
    '--publish always',
    'ossutil',
    'publish-portable-release',
    'release:portable:stage',
    'git tag',
    'git push',
    'gh release',
    'npm publish',
    'pnpm publish',
  ]) {
    assert.equal(
      pkg.scripts['package:win:usb'].includes(forbidden),
      false,
      `Unexpected remote action in package:win:usb: ${forbidden}`,
    );
  }
});

test('production workflow builds the Windows USB ZIP without signing credentials or regression', async () => {
  const workflow = await readFile(
    path.join(ROOT, '.github', 'workflows', 'uclaw-portable-production.yml'),
    'utf8',
  );
  assert.match(workflow, /pnpm run package:win:usb/u);
  assert.match(workflow, /Refresh integrity metadata from final ZIP/u);
  assert.match(workflow, /UCLAW_RELEASE_BRANCH: feature\/claw-0\.5\.1/u);
  assert.match(workflow, /ref: \$\{\{ env\.UCLAW_RELEASE_BRANCH \}\}/u);
  const buildWindowsBlock = workflow.match(/\n  build-windows-usb:[\s\S]*?(?=\n  [A-Za-z0-9_-]+:|$)/u)?.[0] ?? '';
  for (const forbidden of [
    'SIGNPATH_API_TOKEN',
    'signpath/github-action-submit-signing-request',
    'run-packaged-regression',
    'pnpm run test:e2e',
    'invoke-live-registration-gate',
  ]) {
    assert.equal(
      buildWindowsBlock.includes(forbidden),
      false,
      `Unexpected production workflow dependency: ${forbidden}`,
    );
  }
});

test('production workflow can perform only explicitly approved disabled staging', async () => {
  const workflow = await readFile(
    path.join(ROOT, '.github', 'workflows', 'uclaw-portable-production.yml'),
    'utf8',
  );
  assert.match(workflow, /build-macos-usb:/u);
  assert.match(workflow, /pnpm run package:mac:usb/u);
  assert.match(workflow, /UClaw-\$\{RELEASE_VERSION\}-mac-\$\{arch\}-usb\.zip/u);
  assert.match(
    workflow,
    /build-macos-usb:[\s\S]*?actions\/setup-go@v5[\s\S]*?pnpm run package:mac:usb/u,
  );
  assert.ok(
    workflow.includes('git fetch --no-tags origin main')
      && workflow.includes('PLUGIN_VERSION_BASE="$(git merge-base HEAD origin/main)" pnpm run package:mac:usb'),
    'macOS workflow must provide a plugin-version base to the package command',
  );
  assert.match(workflow, /candidates-ready:/u);
  assert.match(workflow, /operation:/u);
  assert.match(workflow, /- build_candidates/u);
  assert.match(workflow, /- verify_oss_upload/u);
  assert.match(workflow, /- stage_disabled/u);
  assert.match(workflow, /- stage_disabled_windows/u);
  assert.match(workflow, /stage-disabled:/u);
  assert.match(workflow, /stage-disabled-windows:/u);
  assert.match(workflow, /if: \$\{\{ inputs\.operation == 'stage_disabled' \}\}/u);
  assert.match(workflow, /environment: uclaw-disabled-stage/u);
  assert.match(workflow, /scripts\/windows-support\/publish-disabled-release-stage\.ps1/u);
  assert.match(workflow, /UCLAW_OSS_ACCESS_KEY_SECRET: \$\{\{ secrets\.UCLAW_OSS_ACCESS_KEY_SECRET \}\}/u);
  assert.match(workflow, /UCLAW_PRODUCTION_SSH_PASSWORD: \$\{\{ secrets\.UCLAW_PRODUCTION_SSH_PASSWORD \}\}/u);
  assert.match(workflow, /ossutil archive SHA-256 mismatch/u);
  assert.match(workflow, /Upload disabled staging receipt/u);
  assert.match(workflow, /sign-windows-usb:/u);
  assert.match(workflow, /sign-macos-usb:/u);
  assert.match(workflow, /Sign UClaw executables via SignPath/u);
  assert.match(workflow, /Build signed and notarized macOS USB packages/u);
  assert.match(workflow, /Authenticode validation failed/u);
  assert.match(workflow, /codesign --verify --deep --strict/u);
  assert.match(workflow, /spctl --assess --type execute/u);
  assert.match(workflow, /repack-portable-release\.mjs/u);
  assert.match(workflow, /verify-oss-upload:/u);
  assert.match(workflow, /inputs\.operation == 'verify_oss_upload'/u);
  assert.match(workflow, /test-oss-release-access\.ps1/u);
  assert.match(workflow, /Require protected OSS secrets/u);
  assert.match(workflow, /-RequireEnvironmentCredentials/u);
  assert.match(
    workflow,
    /stage-disabled:[\s\S]*?needs:[\s\S]*?- candidates-ready[\s\S]*?- verify-oss-upload/u,
  );
  for (const forbidden of [
    '.dmg',
    '.blockmap',
    'softprops/action-gh-release',
    'git tag -a',
    'git push origin "refs/tags/',
    'scripts/windows-support/publish-portable-release.ps1',
    'self-hosted',
    'uclaw-release',
    'RELEASE_MANDATORY',
    'RELEASE_NOTES',
  ]) {
    assert.equal(workflow.includes(forbidden), false, `Candidate workflow must not run: ${forbidden}`);
  }
});

test('legacy tag release workflow is inert after the portable ZIP migration', async () => {
  const workflow = await readFile(
    path.join(ROOT, '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  assert.match(workflow, /Release Workflow \(retired\)/u);
  for (const job of ['validate-release', 'release', 'publish', 'upload-oss', 'finalize']) {
    const jobBlock = workflow.match(
      new RegExp(`\\r?\\n  ${job}:\\r?\\n([\\s\\S]*?)(?=\\r?\\n  [A-Za-z0-9_-]+:|\\r?\\n?$)`, 'u'),
    )?.[1] ?? '';
    assert.match(jobBlock, /if:\s*\$\{\{\s*false\s*\}\}/u, `${job} must remain disabled`);
  }
  assert.match(workflow, /uclaw-portable-production\.yml/u);
});

test('OSS access probe is isolated from release objects and production database state', async () => {
  const probe = await readFile(
    path.join(ROOT, 'scripts', 'windows-support', 'test-oss-release-access.ps1'),
    'utf8',
  );
  assert.match(probe, /releases\/latest\/\.oss-probes\//u);
  assert.match(probe, /OSS_PROBE_OK/u);
  assert.match(probe, /Get-FileHash -Algorithm SHA256/u);
  assert.match(probe, /\brm \$objectUri --force/u);
  assert.match(probe, /\bstat \$objectUri --output-format json/u);
  assert.match(probe, /\$uploadAttempted = \$true[\s\S]*?\bcp \$payloadPath \$objectUri/u);
  assert.match(probe, /if \(\$uploadAttempted -and -not \$removed\)/u);
  assert.match(probe, /\$statusAfter -ne 404/u);
  assert.match(probe, /OSS_ACCESS_KEY_SECRET/u);
  assert.equal(/accessKeySecret=\$accessKeySecret/u.test(probe), false);
  assert.equal(/production-ssh|UCLAW_PRODUCTION|claw_x_releases|psql/iu.test(probe), false);
  assert.equal(/UClaw-\$?\{?version|macos-production-candidate/iu.test(probe), false);
});

test('disabled stage publisher never enables a release row', async () => {
  const publisher = await readFile(
    path.join(ROOT, 'scripts', 'windows-support', 'publish-disabled-release-stage.ps1'),
    'utf8',
  );
  assert.match(publisher, /enabled, mandatory/u);
  assert.match(publisher, /false, \$mandatorySql/u);
  assert.match(publisher, /stage operation changed an enabled release/u);
  assert.match(publisher, /Public release feed changed during disabled staging/u);
  assert.match(publisher, /Get-RemoteSha512Hex/u);
  assert.match(publisher, /OSS SHA-512 mismatch/u);
  assert.match(publisher, /function Assert-PortableMetadata/u);
  assert.match(publisher, /function Assert-SignedWindowsPortableCandidate/u);
  assert.match(publisher, /\[switch\]\$WindowsOnly/u);
  assert.match(publisher, /\[switch\]\$OverwriteExistingOssObjects/u);
  assert.match(publisher, /\[switch\]\$AllowUnsignedWindowsCandidate/u);
  assert.match(publisher, /aiwxxx-production-ssh\.json/u);
  assert.match(publisher, /releaseOrigin=https:\/\/aiwxxx\.com/u);
  assert.match(publisher, /Local production SSH credentials must declare releaseOrigin/u);
  assert.match(publisher, /\$overwriteArgument = if \(\$OverwriteExistingOssObjects\) \{ '--force' \} else \{ '--update' \}/u);
  assert.match(publisher, /if \(\$AllowUnsignedWindowsCandidate\)/u);
  assert.match(publisher, /Publishing an unsigned Windows portable candidate under explicit operator authorization/u);
  assert.match(publisher, /skipped_explicit_authorization/u);
  assert.match(publisher, /Assert-PortableMetadata -Metadata \$windowsMetadata/u);
  assert.match(publisher, /companion metadata is missing/u);
  assert.match(publisher, /Assert-PortableMetadata -Metadata \$metadata/u);
  assert.match(publisher, /metadataFileName mismatch/u);
  assert.match(publisher, /LocalPath = \$metadataPath/u);
  assert.match(publisher, /FileName = \$metadataFileName/u);
  assert.match(publisher, /Sha512Hex = Get-Sha512Hex \$metadataPath/u);
  assert.match(publisher, /objects = \$objects\.Count/u);
  assert.match(publisher, /function Get-SingleHttpHeaderValue/u);
  assert.match(publisher, /GitHub Actions release secrets are incomplete/u);
  assert.match(publisher, /UCLAW_OSS_ACCESS_KEY_SECRET/u);
  assert.match(publisher, /UCLAW_PRODUCTION_SSH_PASSWORD/u);
  assert.match(publisher, /PasswordEnvironmentVariable/u);
  assert.match(publisher, /\[int64\]::TryParse\(\$contentLengthText/u);
  assert.match(publisher, /\$null -ne \$head\.Length -and \$head\.Length -ne \$object\.Size/u);
  assert.match(publisher, /\$PSVersionTable\.PSEdition -eq 'Core'/u);
  assert.equal(publisher.includes('%SystemRoot%\\System32\\WindowsPowerShell'), false);
  assert.equal(
    /\[int64\]\$response\.Headers\['Content-Length'\]/u.test(publisher),
    false,
    'PowerShell 7 returns HTTP header values as String[]; normalize before parsing',
  );
  assert.match(publisher, /Platform = 'mac'; Arch = \$arch; PackageType = 'portable_zip'/u);
  assert.equal(publisher.includes("PackageType = 'installer'"), false);
  assert.equal(/\.dmg|\.blockmap/iu.test(publisher), false);
  assert.equal(/SET\s+enabled\s*=\s*true/iu.test(publisher), false);
});

test('Windows can execute the pnpm.cmd shim through the release shell strategy', {
  skip: process.platform !== 'win32',
}, () => {
  const version = runProcess('pnpm.cmd', ['--version'], {
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
  }).trim();
  assert.match(version, /^\d+\.\d+\.\d+/u);
});

test('rejects non-Windows platforms before running commands', async () => {
  const { runLocalRelease } = await loadReleaseModule();
  const root = await createFixture();
  const runner = createCommandRunner();
  try {
    await assert.rejects(
      runLocalRelease({ platform: 'darwin', root, execFileSync: runner.execFileSync }),
      /Windows/u,
    );
    assert.deepEqual(runner.calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a dirty Git workspace before building', async () => {
  const { runLocalRelease } = await loadReleaseModule();
  const root = await createFixture();
  const runner = createCommandRunner({ dirty: true });
  try {
    await assert.rejects(
      runLocalRelease({ platform: 'win32', root, execFileSync: runner.execFileSync }),
      /clean Git workspace/u,
    );
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0].command, 'git');
    assert.deepEqual(runner.calls[0].args, [
      'status',
      '--porcelain=v1',
      '--untracked-files=normal',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('builds only the Windows USB package and verifies its exact identity', async () => {
  const { runLocalRelease } = await loadReleaseModule();
  const root = await createFixture();
  const runner = createCommandRunner();
  const inspections = [];
  const messages = [];
  const environment = {
    PATH: 'C:\\tools',
    KEEP_ME: 'preserved',
    CSC_LINK: 'test-certificate.p12',
    WIN_CSC_LINK: 'test-windows-certificate.p12',
    CSC_KEY_PASSWORD: 'test-password',
    WIN_CSC_KEY_PASSWORD: 'test-windows-password',
  };
  try {
    const result = await runLocalRelease({
      platform: 'win32',
      root,
      execFileSync: runner.execFileSync,
      environment,
      inspectPortableArtifact: async (options) => {
        inspections.push(options);
        return {
          metadataMatches: true,
          zipPath: options.zipPath,
          identity: {
            version: '2.0.0',
            gitCommit: COMMIT,
            buildId: 'local-build',
            zipFileName: 'UClaw-2.0.0-win-x64-usb.zip',
            zipSize: 2048,
            sha512: 'b'.repeat(128),
          },
        };
      },
      log: (message) => messages.push(message),
    });

    assert.deepEqual(
      runner.calls.map(({ command, args }) => ({ command, args })),
      [
        {
          command: 'git',
          args: ['status', '--porcelain=v1', '--untracked-files=normal'],
        },
        { command: 'git', args: ['rev-parse', 'HEAD'] },
        { command: 'pnpm.cmd', args: ['run', 'package:win:usb'] },
      ],
    );
    assert.equal(runner.calls[2].options.shell, true);
    assert.deepEqual(runner.calls[2].options.env, {
      PATH: 'C:\\tools',
      KEEP_ME: 'preserved',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      CSC_LINK: '',
      WIN_CSC_LINK: '',
      CSC_KEY_PASSWORD: '',
      WIN_CSC_KEY_PASSWORD: '',
    });
    assert.deepEqual(inspections, [{
      zipPath: path.join(root, 'release', 'UClaw-2.0.0-win-x64-usb.zip'),
      expectedVersion: '2.0.0',
      expectedCommit: COMMIT,
    }]);
    assert.equal(result.identity.buildId, 'local-build');
    assert.ok(messages.some((message) => message.includes('No signing or production publication')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a portable metadata mismatch after building', async () => {
  const { runLocalRelease } = await loadReleaseModule();
  const root = await createFixture();
  const runner = createCommandRunner();
  try {
    await assert.rejects(
      runLocalRelease({
        platform: 'win32',
        root,
        execFileSync: runner.execFileSync,
        inspectPortableArtifact: async () => ({ metadataMatches: false }),
      }),
      /metadata/u,
    );
    assert.equal(runner.calls.at(-1).command, 'pnpm.cmd');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts a real portable ZIP and metadata with the exact release identity', async () => {
  const fixture = await createPortableArtifactFixture();
  try {
    const artifact = await inspectPortableArtifact({
      zipPath: fixture.zipPath,
      expectedVersion: '2.0.0',
      expectedCommit: COMMIT,
    });
    assert.equal(artifact.metadataMatches, true);
    assert.equal(artifact.identity.version, '2.0.0');
    assert.equal(artifact.identity.gitCommit, COMMIT);
    assert.equal(artifact.identity.zipSize, fixture.zipSize);
    assert.equal(artifact.identity.sha512, fixture.sha512);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('real portable inspection rejects a different expected version', async () => {
  const fixture = await createPortableArtifactFixture();
  try {
    await assert.rejects(
      inspectPortableArtifact({
        zipPath: fixture.zipPath,
        expectedVersion: '2.0.1',
        expectedCommit: COMMIT,
      }),
      /Portable version mismatch/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('real portable inspection rejects a non-full metadata commit', async () => {
  const fixture = await createPortableArtifactFixture({ gitCommit: 'abc1234' });
  try {
    await assert.rejects(
      inspectPortableArtifact({ zipPath: fixture.zipPath }),
      /Expected a full Git commit/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('real portable inspection rejects a mismatched metadata filename', async () => {
  const fixture = await createPortableArtifactFixture({ file_name: 'wrong.zip' });
  try {
    await assert.rejects(
      inspectPortableArtifact({ zipPath: fixture.zipPath }),
      /Portable filename mismatch/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('real portable inspection reports a mismatched metadata size', async () => {
  const fixture = await createPortableArtifactFixture({ size: 7 });
  try {
    const artifact = await inspectPortableArtifact({ zipPath: fixture.zipPath });
    assert.equal(artifact.metadataMatches, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('real portable inspection reports a mismatched metadata SHA-512', async () => {
  const fixture = await createPortableArtifactFixture({ sha512: '0'.repeat(128) });
  try {
    const artifact = await inspectPortableArtifact({ zipPath: fixture.zipPath });
    assert.equal(artifact.metadataMatches, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('the local release script contains no remote publication command', async () => {
  const source = await readFile(path.join(SCRIPT_DIR, 'release.mjs'), 'utf8');
  for (const forbidden of ['--publish', 'ossutil', 'git tag', 'gh release']) {
    assert.equal(source.includes(forbidden), false, `Unexpected remote publication token: ${forbidden}`);
  }
});
