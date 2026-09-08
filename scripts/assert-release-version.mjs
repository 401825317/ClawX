#!/usr/bin/env node
/**
 * npm/pnpm `version` lifecycle hook: runs after package.json is bumped, before
 * `git tag`. Aborts if the target tag already exists locally or on the release
 * remote so we
 * never fail late on `fatal: tag 'vX.Y.Z' already exists` or a rejected push.
 */
import { readFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readPackageVersion() {
  const raw = readFileSync(join(root, 'package.json'), 'utf8');
  return JSON.parse(raw).version;
}

const version = process.env.npm_package_version || readPackageVersion();
const tag = `v${version}`;
const skipRemote = process.env.SKIP_RELEASE_REMOTE_CHECK === '1';

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

function localTagExists(t) {
  try {
    execSync(`git rev-parse -q --verify refs/tags/${t}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function remoteTagExists(remote, t) {
  try {
    const out = execFileSync('git', ['ls-remote', '--tags', remote, `refs/tags/${t}`], {
      encoding: 'utf8',
    }).trim();
    return out.length > 0;
  } catch {
    return null;
  }
}

if (localTagExists(tag)) {
  console.error(`
Release version check failed: git tag ${tag} already exists locally.

You cannot run \`pnpm version …\` for ${version} until that tag is gone or the
version is bumped to a value that does not yet have a tag.

Typical fixes:
  • Use the next prerelease explicitly, e.g. \`pnpm version 0.3.10-beta.4\`
  • Or delete only if you are sure it was created by mistake: \`git tag -d ${tag}\`
`);
  process.exit(1);
}

if (!skipRemote) {
  const releaseRemote = resolveReleaseRemote();
  const onRemote = remoteTagExists(releaseRemote, tag);
  if (onRemote === null) {
    console.error(`
Release version check failed: could not query ${releaseRemote} for refs/tags/${tag}.

Ensure \`origin\` exists and you can reach the network, run
\`pnpm run preversion\` / \`git fetch origin --tags\`, then retry.

To skip this check (offline only): SKIP_RELEASE_REMOTE_CHECK=1
`);
    process.exit(1);
  }
  if (onRemote) {
    console.error(`
Release version check failed: tag ${tag} already exists on ${releaseRemote}.

Bump to a version that is not on the remote yet (see \`git ls-remote --tags origin\`).
`);
    process.exit(1);
  }
}

if (skipRemote) {
  console.log('Release version OK (remote check skipped): tag is not present locally.');
  process.exit(0);
}

console.log(`Release version OK: tag ${tag} is not present locally and not on origin.`);
