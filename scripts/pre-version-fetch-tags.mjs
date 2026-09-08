#!/usr/bin/env node
/**
 * npm/pnpm `preversion`: fetch tags from the release remote so local state
 * matches the branch that will receive the version bump. Local UClaw worktrees
 * track `fork`, while GitHub Actions checks out the same repository as
 * `origin`.
 */
import { execFileSync } from 'node:child_process';

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

const skip = process.env.SKIP_RELEASE_FETCH === '1';
if (skip) {
  console.log('[pre-version-fetch-tags] Skip: SKIP_RELEASE_FETCH=1');
  process.exit(0);
}

try {
  const releaseRemote = resolveReleaseRemote();
  execFileSync('git', ['fetch', releaseRemote, '--tags', '--prune'], {
    stdio: 'inherit',
  });
} catch {
  console.error(`
[pre-version-fetch-tags] git fetch release remote --tags failed.

Fix your network/remotes, or retry. To bypass (not recommended), run with
SKIP_RELEASE_FETCH=1 — assert-release-version may still block on remote tags
unless SKIP_RELEASE_REMOTE_CHECK=1.
`);
  process.exit(1);
}
