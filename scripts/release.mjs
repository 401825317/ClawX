#!/usr/bin/env node

/**
 * Build a release without publishing, validate the finished artifact, and
 * publish exactly those files to the configured non-generic publishers only
 * after the platform gate has passed. Generic OSS upload remains a CI step.
 *
 * Windows is intentionally handled as an NSIS release. The USB ZIP has its
 * own build and regression command and must not be substituted here.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const ELECTRON_BUILDER_CLI = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function parseArgs(argv) {
  const options = { publish: true };
  for (const arg of argv) {
    if (arg === '--no-publish') {
      options.publish = false;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(`UClaw release build

Usage:
  pnpm run release          Build, validate, and publish the final artifacts.
  pnpm run release:build    Build and validate without publishing.

The Windows path validates the final NSIS installer after metadata/blockmap
refresh, including silent install, startup, overwrite upgrade, and uninstall.
The generic OSS provider is uploaded by the release workflow after its own
artifact verification step.
`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function run(command, args, label) {
  console.log(`[release] ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function assertCleanSource() {
  const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Cannot inspect Git source state before release.');
  if (result.stdout.trim()) {
    throw new Error('Release requires a clean Git worktree. Commit or move local changes before publishing.');
  }
}

function readPackage() {
  return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

function readProductName() {
  const text = readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  const match = text.match(/^productName:\s*([^\r\n#]+?)\s*$/mu);
  return match?.[1]?.trim() || 'UClaw';
}

function safeReleaseChild(name) {
  const resolved = path.resolve(RELEASE_DIR, name);
  const relative = path.relative(ROOT, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove a release path outside the workspace: ${resolved}`);
  }
  return resolved;
}

function isStaleBuildArtifact(name) {
  if (/^builder-(?:debug|effective-config)\.(?:yml|yaml)$/iu.test(name)) return true;
  return isPublishableArtifact(name);
}

async function cleanStaleBuildArtifacts() {
  let entries;
  try {
    entries = await readdir(RELEASE_DIR, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const target = safeReleaseChild(entry.name);
    if (entry.isDirectory() && entry.name === 'win-unpacked') {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      continue;
    }
    if (entry.isFile() && isStaleBuildArtifact(entry.name)) {
      await rm(target, { force: true, maxRetries: 5, retryDelay: 500 });
    }
  }
}

function isPublishableArtifact(name) {
  if (name === 'builder-debug.yml') return false;
  return /\.(?:dmg|zip|exe|AppImage|deb|rpm|blockmap|yml)$/iu.test(name);
}

async function resolvePublishableArtifacts(version, productName) {
  const entries = await readdir(RELEASE_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && isPublishableArtifact(entry.name))
    .map((entry) => path.join(RELEASE_DIR, entry.name))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) throw new Error('No publishable release artifacts were produced.');
  if (process.platform === 'win32') {
    const expectedInstaller = `${productName}-${version}-win-x64.exe`;
    if (!files.some((file) => path.basename(file) === expectedInstaller)) {
      throw new Error(`The expected Windows NSIS installer is missing: ${expectedInstaller}`);
    }
  }
  return files;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourcePackage = readPackage();
  const productName = readProductName();

  assertCleanSource();
  await cleanStaleBuildArtifacts();
  run(process.execPath, [path.join(ROOT, 'scripts', 'prep-bundled-binaries.mjs')], 'Prepare bundled runtime binaries');
  run(PNPM, ['run', 'package'], 'Build the application payload');
  if (process.platform === 'win32') {
    run(process.execPath, [path.join(ROOT, 'scripts', 'patch-nsis-win.mjs')], 'Apply the Windows NSIS packaging patches');
  }
  const builderArgs = process.platform === 'win32' ? ['--win', '--publish', 'never'] : ['--publish', 'never'];
  run(
    process.execPath,
    [path.join(ROOT, 'scripts', 'run-electron-builder.mjs'), ...builderArgs],
    'Build distributable artifacts without publishing',
  );

  if (process.platform === 'win32') {
    run(PNPM, ['run', 'release:refresh:win'], 'Refresh final NSIS blockmap and update metadata');
    run(PNPM, ['run', 'release:validate:win'], 'Run the final NSIS install lifecycle gate');
  }

  const artifacts = await resolvePublishableArtifacts(sourcePackage.version, productName);
  console.log(`[release] Verified artifacts ready: ${artifacts.map((file) => path.basename(file)).join(', ')}`);
  if (!options.publish) {
    console.log('[release] Build and validation passed; publishing was explicitly skipped.');
    return;
  }

  run(
    process.execPath,
    [
      ELECTRON_BUILDER_CLI,
      'publish',
      '--files',
      ...artifacts,
      '--version',
      sourcePackage.version,
      '--policy',
      'always',
    ],
    'Publish the already-validated artifacts',
  );
  console.log('[release] electron-builder generic providers are uploaded by CI; local publish covers configured non-generic publishers.');
  console.log(`[release] PASS: version=${sourcePackage.version}`);
}

main().catch((error) => {
  console.error(`[release] FAIL: ${error instanceof Error ? error.stack || error.message : error}`);
  process.exit(1);
});
