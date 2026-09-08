#!/usr/bin/env node
/**
 * npm/pnpm `postversion`: push the current branch (set upstream if missing) and
 * only the new version tag — avoids \`git push --tags\` publishing unrelated tags.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readPackageVersion() {
  const raw = readFileSync(join(root, 'package.json'), 'utf8');
  return JSON.parse(raw).version;
}

function resolveReleaseRemote() {
  const configured = process.env.UCLAW_RELEASE_REMOTE?.trim();
  if (configured) return configured;

  try {
    const branch = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const upstream = execFileSync('git', ['config', '--get', `branch.${branch}.remote`], {
      encoding: 'utf8',
    }).trim();
    if (upstream) return upstream;
  } catch {
    // Detached or untracked branches use the conventional Actions remote.
  }

  return 'origin';
}

const version = process.env.npm_package_version || readPackageVersion();
const tag = `v${version}`;
const releaseRemote = resolveReleaseRemote();

execFileSync('git', ['push', '-u', releaseRemote, 'HEAD'], { stdio: 'inherit' });
execFileSync('git', ['push', releaseRemote, `refs/tags/${tag}`], { stdio: 'inherit' });
