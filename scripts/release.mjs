#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFormalVersion,
  assertGitCommit,
  inspectPortableArtifact,
} from './windows-support/portable-release-utils.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');

/** Build and verify one local Windows USB release candidate without publishing it. */
export async function runLocalRelease({
  platform = process.platform,
  root = ROOT,
  execFileSync: runCommand = execFileSync,
  inspectPortableArtifact: inspectArtifact = inspectPortableArtifact,
  environment = process.env,
  log = (message) => console.log(message),
} = {}) {
  if (platform !== 'win32') {
    throw new Error('Local release candidates can only be built on Windows.');
  }

  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const version = String(pkg.version ?? '');
  assertFormalVersion(version);

  // Lock the candidate to one clean source tree before running the expensive build.
  const status = String(runCommand(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=normal'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  ) ?? '').trim();
  if (status) {
    throw new Error('Local release requires a clean Git workspace.');
  }

  const commit = String(runCommand('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  }) ?? '').trim().toLowerCase();
  assertGitCommit(commit);

  // Keep the local candidate unsigned even if the developer shell carries signing credentials.
  runCommand('pnpm.cmd', ['run', 'package:win:usb'], {
    cwd: root,
    env: {
      ...environment,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      CSC_LINK: '',
      WIN_CSC_LINK: '',
      CSC_KEY_PASSWORD: '',
      WIN_CSC_KEY_PASSWORD: '',
    },
    shell: true,
    windowsHide: true,
    stdio: 'inherit',
  });

  // Verify the final bytes against the metadata emitted by the USB build.
  const artifact = await inspectArtifact({
    zipPath: path.join(root, 'release', `UClaw-${version}-win-x64-usb.zip`),
    expectedVersion: version,
    expectedCommit: commit,
  });
  if (!artifact.metadataMatches) {
    throw new Error('Portable artifact metadata does not match the final ZIP bytes.');
  }

  log(`[local-release] Version: ${artifact.identity.version}`);
  log(`[local-release] Commit: ${artifact.identity.gitCommit}`);
  log(`[local-release] Build ID: ${artifact.identity.buildId}`);
  log(`[local-release] Size: ${artifact.identity.zipSize}`);
  log(`[local-release] SHA-512: ${artifact.identity.sha512}`);
  log(`[local-release] Candidate: ${artifact.zipPath}`);
  log('[local-release] No signing or production publication was performed.');

  return artifact;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runLocalRelease().catch((error) => {
    console.error(`[local-release] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
