#!/usr/bin/env node

/**
 * Guard local OpenClaw plugins against content/schema changes without a
 * corresponding package version bump.
 *
 * The normal build gate only verifies that package.json and
 * openclaw.plugin.json agree.  That is necessary, but it cannot catch a
 * schema or entry-point change when both files keep the old version.  This
 * check compares the plugin files in a pull request (or any two git refs)
 * and requires a strictly newer version whenever the effective plugin
 * content changes.
 *
 * The comparison is deliberately limited to the supplied base/head refs.
 * When a plugin was introduced after the supplied base (a common situation
 * for the release branch), the first commit that contains both metadata files
 * is used as that plugin's baseline.  This is important: treating every such
 * plugin as simply "added" would permanently exempt later same-version
 * content changes from the guard.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
export const PLUGIN_ROOT = 'resources/openclaw-plugins';

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

/**
 * Parse the semver subset used by local and mirrored OpenClaw plugins.
 * Build metadata is intentionally ignored for ordering.
 */
export function parsePluginVersion(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = VERSION_PATTERN.exec(text);
  if (!match) return null;
  if (match[4]?.split('.').some((part) => /^0\d+$/u.test(part))) return null;
  const prerelease = match[4]
    ? match[4].split('.').map((part) => (/^\d+$/u.test(part) ? Number(part) : part))
    : [];
  return {
    raw: text,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= left.length) return -1;
    if (index >= right.length) return 1;
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
    if (typeof a === 'number') return -1;
    if (typeof b === 'number') return 1;
    return String(a) < String(b) ? -1 : 1;
  }
  return 0;
}

/** Return -1, 0, or 1 for valid plugin versions; null for invalid input. */
export function comparePluginVersions(leftValue, rightValue) {
  const left = parsePluginVersion(leftValue);
  const right = parsePluginVersion(rightValue);
  if (!left || !right) return null;
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function cloneWithoutVersion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const clone = { ...value };
  delete clone.version;
  return clone;
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeJson(value[key])]),
  );
}

function parseJsonSnapshot(snapshot, label) {
  if (snapshot === null || snapshot === undefined) return null;
  try {
    return JSON.parse(String(snapshot));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function jsonEquivalentIgnoringVersion(leftSnapshot, rightSnapshot, label) {
  const left = parseJsonSnapshot(leftSnapshot, label);
  const right = parseJsonSnapshot(rightSnapshot, label);
  if (left === null || right === null) return left === right;
  return JSON.stringify(canonicalizeJson(cloneWithoutVersion(left)))
    === JSON.stringify(canonicalizeJson(cloneWithoutVersion(right)));
}

function metadataFromSnapshots(pluginId, snapshots) {
  const packagePath = `${PLUGIN_ROOT}/${pluginId}/package.json`;
  const manifestPath = `${PLUGIN_ROOT}/${pluginId}/openclaw.plugin.json`;
  const pkg = parseJsonSnapshot(snapshots.get(packagePath), `${pluginId} package.json`);
  const manifest = parseJsonSnapshot(snapshots.get(manifestPath), `${pluginId} openclaw.plugin.json`);
  return { pkg, manifest, packagePath, manifestPath };
}

function normalizeChangedPath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//u, '');
}

function pluginIdForPath(value) {
  const normalized = normalizeChangedPath(value);
  const prefix = `${PLUGIN_ROOT}/`;
  if (!normalized.startsWith(prefix)) return null;
  const remainder = normalized.slice(prefix.length);
  const slash = remainder.indexOf('/');
  if (slash <= 0) return null;
  const pluginId = remainder.slice(0, slash);
  if (!pluginId || pluginId === 'node_modules') return null;
  if (remainder.split('/').includes('node_modules')) return null;
  return pluginId;
}

function isVersionOnlyMetadataChange(filePath, beforeSnapshots, afterSnapshots, pluginId) {
  const normalized = normalizeChangedPath(filePath);
  const packagePath = `${PLUGIN_ROOT}/${pluginId}/package.json`;
  const manifestPath = `${PLUGIN_ROOT}/${pluginId}/openclaw.plugin.json`;
  if (normalized === packagePath) {
    return jsonEquivalentIgnoringVersion(
      beforeSnapshots.get(packagePath),
      afterSnapshots.get(packagePath),
      `${pluginId} package.json`,
    );
  }
  if (normalized === manifestPath) {
    return jsonEquivalentIgnoringVersion(
      beforeSnapshots.get(manifestPath),
      afterSnapshots.get(manifestPath),
      `${pluginId} openclaw.plugin.json`,
    );
  }
  return false;
}

function versionFromMetadata(metadata) {
  const packageVersion = metadata.pkg && typeof metadata.pkg.version === 'string'
    ? metadata.pkg.version.trim()
    : '';
  const manifestVersion = metadata.manifest && typeof metadata.manifest.version === 'string'
    ? metadata.manifest.version.trim()
    : '';
  return { packageVersion, manifestVersion };
}

/**
 * Validate a set of changed plugin files.
 *
 * `beforeSnapshots` and `afterSnapshots` are Maps keyed by repository-relative
 * paths. A missing path is represented by an absent map entry (new/deleted
 * file). The returned object is intentionally serialisable for unit tests and
 * CI tooling.
 */
export function checkPluginVersionBumps({
  changedFiles,
  beforeSnapshots = new Map(),
  afterSnapshots = new Map(),
}) {
  const normalizedFiles = [...new Set((changedFiles ?? []).map(normalizeChangedPath))];
  const pluginFiles = normalizedFiles.filter((filePath) => pluginIdForPath(filePath));
  const pluginIds = [...new Set(pluginFiles.map(pluginIdForPath))].sort();
  const violations = [];
  const checked = [];

  for (const pluginId of pluginIds) {
    const files = pluginFiles.filter((filePath) => pluginIdForPath(filePath) === pluginId);
    const before = metadataFromSnapshots(pluginId, beforeSnapshots);
    const after = metadataFromSnapshots(pluginId, afterSnapshots);

    // A deliberately removed plugin is handled by the bundle allowlist/build
    // checks. There is no new package to version-bump in this guard.  A
    // source-only addition is different: accepting it would let a plugin
    // enter the tree without package/manifest metadata (and therefore without
    // an auditable version), so fail closed for that case.
    if (!after.pkg && !after.manifest) {
      if (before.pkg || before.manifest) continue;
      violations.push({
        pluginId,
        code: 'metadata-missing',
        message: `${pluginId} must contain both package.json and openclaw.plugin.json after the change`,
        files,
      });
      continue;
    }

    if (!after.pkg || !after.manifest) {
      violations.push({
        pluginId,
        code: 'metadata-missing',
        message: `${pluginId} must contain both package.json and openclaw.plugin.json after the change`,
        files,
      });
      continue;
    }

    const afterVersions = versionFromMetadata(after);
    if (!afterVersions.packageVersion || !afterVersions.manifestVersion) {
      violations.push({
        pluginId,
        code: 'version-missing',
        message: `${pluginId} package.json and manifest must declare a version`,
        files,
      });
      continue;
    }
    if (afterVersions.packageVersion !== afterVersions.manifestVersion) {
      violations.push({
        pluginId,
        code: 'version-mismatch',
        message: `${pluginId} package.json (${afterVersions.packageVersion}) and manifest (${afterVersions.manifestVersion}) versions differ`,
        files,
      });
      continue;
    }
    if (!parsePluginVersion(afterVersions.packageVersion)) {
      violations.push({
        pluginId,
        code: 'version-invalid',
        message: `${pluginId} version "${afterVersions.packageVersion}" is not valid semantic versioning`,
        files,
      });
      continue;
    }

    // A newly introduced plugin has no previous release to compare against;
    // its current metadata is still validated above.
    if (!before.pkg && !before.manifest) {
      checked.push({ pluginId, files, contentChanged: true, versionChanged: true, added: true });
      continue;
    }

    const beforeVersions = versionFromMetadata(before);
    const versionChanged = beforeVersions.packageVersion !== afterVersions.packageVersion
      || beforeVersions.manifestVersion !== afterVersions.manifestVersion;
    const contentFiles = files.filter((filePath) => (
      !isVersionOnlyMetadataChange(filePath, beforeSnapshots, afterSnapshots, pluginId)
    ));
    const contentChanged = contentFiles.length > 0;

    if (contentChanged && !versionChanged) {
      violations.push({
        pluginId,
        code: 'content-without-version-bump',
        message: `${pluginId} plugin content/schema changed but version stayed ${afterVersions.packageVersion}; bump package.json and openclaw.plugin.json`,
        files: contentFiles,
      });
      continue;
    }

    if (versionChanged) {
      if (beforeVersions.packageVersion !== beforeVersions.manifestVersion) {
        violations.push({
          pluginId,
          code: 'before-version-mismatch',
          message: `${pluginId} had mismatched package/manifest versions before this change; repair the baseline before changing content`,
          files,
        });
        continue;
      }
      const order = comparePluginVersions(afterVersions.packageVersion, beforeVersions.packageVersion);
      if (order === null || order <= 0) {
        violations.push({
          pluginId,
          code: 'version-not-increased',
          message: `${pluginId} changed from ${beforeVersions.packageVersion || '[missing]'} to ${afterVersions.packageVersion}; content changes require a strictly newer version`,
          files,
        });
        continue;
      }
    }

    checked.push({ pluginId, files, contentChanged, versionChanged, added: false });
  }

  return { ok: violations.length === 0, checked, violations };
}

function gitText(args, root = REPOSITORY_ROOT) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitBlob(ref, relativePath, root = REPOSITORY_ROOT) {
  try {
    return gitText(['show', `${ref}:${relativePath}`], root);
  } catch {
    return null;
  }
}

function pluginMetadataPaths(pluginId) {
  return {
    packagePath: `${PLUGIN_ROOT}/${pluginId}/package.json`,
    manifestPath: `${PLUGIN_ROOT}/${pluginId}/openclaw.plugin.json`,
  };
}

/**
 * Find the first commit after `base` at which a plugin has both of its
 * version-bearing metadata files.  A feature branch can introduce a plugin
 * after the PR/release merge base; in that case the merge base is not a useful
 * "before" snapshot.  Returning the first complete metadata commit gives the
 * plugin an initial release baseline while excluding the initial import itself
 * from the subsequent content diff.
 */
function findPluginBaselineCommit({ base, head, pluginId, root = REPOSITORY_ROOT }) {
  const commitHead = head === 'HEAD' ? 'HEAD' : head;
  const { packagePath, manifestPath } = pluginMetadataPaths(pluginId);
  let commits;
  try {
    commits = gitText([
      'rev-list',
      '--reverse',
      '--topo-order',
      '--full-history',
      `${base}..${commitHead}`,
      '--',
      `${PLUGIN_ROOT}/${pluginId}`,
    ], root).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  } catch {
    return null;
  }

  for (const commit of commits) {
    // Use the commit tree, not the working tree, so an uncommitted edit cannot
    // accidentally become the baseline.  A plugin is considered introduced
    // only once both metadata files are present.
    if (gitBlob(commit, packagePath, root) !== null
      && gitBlob(commit, manifestPath, root) !== null) {
      return commit;
    }
  }
  return null;
}

function changedPluginFiles({ from, to = 'HEAD', pluginId, root = REPOSITORY_ROOT }) {
  // With the default HEAD target, a two-dot-ish `git diff <from>` also includes
  // staged and unstaged worktree edits.  An explicit immutable head uses the
  // three-dot range used by CI.  The caller may pass a historical baseline as
  // `from`; this intentionally excludes that baseline commit's initial import.
  const range = to === 'HEAD' ? from : `${from}...${to}`;
  const trackedFiles = gitText([
    'diff',
    '--name-only',
    '-z',
    range,
    '--',
    `${PLUGIN_ROOT}/${pluginId}`,
  ], root).split('\0').filter(Boolean).map(normalizeChangedPath);

  // `git diff` does not report untracked files. The normal worktree check
  // already includes them, but the historical-baseline path below replaces
  // the initial file list with this helper's result. Include untracked files
  // here as well so a plugin introduced in an earlier commit cannot bypass
  // the guard by adding only a new, uncommitted helper/schema file.
  if (to !== 'HEAD') return trackedFiles;
  const untrackedFiles = gitText([
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    `${PLUGIN_ROOT}/${pluginId}`,
  ], root).split('\0').filter(Boolean).map(normalizeChangedPath);
  return [...new Set([...trackedFiles, ...untrackedFiles])];
}

function metadataSnapshotsAtRef(ref, pluginId, root = REPOSITORY_ROOT) {
  const snapshots = new Map();
  const { packagePath, manifestPath } = pluginMetadataPaths(pluginId);
  for (const relativePath of [packagePath, manifestPath]) {
    const snapshot = gitBlob(ref, relativePath, root);
    if (snapshot !== null) snapshots.set(relativePath, snapshot);
  }
  return snapshots;
}

function metadataSnapshotsAtHead(pluginId, head, root = REPOSITORY_ROOT) {
  const snapshots = new Map();
  const { packagePath, manifestPath } = pluginMetadataPaths(pluginId);
  for (const relativePath of [packagePath, manifestPath]) {
    if (head === 'HEAD') {
      const absolutePath = path.join(root, ...relativePath.split('/'));
      if (fs.existsSync(absolutePath)) snapshots.set(relativePath, fs.readFileSync(absolutePath, 'utf8'));
    } else {
      const snapshot = gitBlob(head, relativePath, root);
      if (snapshot !== null) snapshots.set(relativePath, snapshot);
    }
  }
  return snapshots;
}

function changedFilesBetweenRefs(from, to, root = REPOSITORY_ROOT) {
  return gitText([
    'diff',
    '--name-only',
    '-z',
    from,
    to,
    '--',
    PLUGIN_ROOT,
  ], root).split('\0').filter(Boolean).map(normalizeChangedPath);
}

function commitParents(commit, root = REPOSITORY_ROOT) {
  try {
    const fields = gitText(['rev-list', '--parents', '-n', '1', commit], root)
      .trim().split(/\s+/u).filter(Boolean);
    return fields.slice(1);
  } catch {
    return [];
  }
}

function commitsBetweenRefs(base, head, root = REPOSITORY_ROOT) {
  try {
    return gitText([
      'rev-list',
      '--reverse',
      '--topo-order',
      // Inspect the release branch's linear history.  A merge commit's
      // first-parent diff contains the complete side-branch payload, while
      // traversing every reachable side commit would apply transitions out of
      // order and could reset an epoch twice.
      '--first-parent',
      `${base}..${head}`,
      '--',
      PLUGIN_ROOT,
    ], root).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function metadataSnapshotsAtWorkingTree(pluginId, root = REPOSITORY_ROOT) {
  return metadataSnapshotsAtHead(pluginId, 'HEAD', root);
}

function metadataIsSynchronized(metadata) {
  if (!metadata.pkg || !metadata.manifest) return false;
  const versions = versionFromMetadata(metadata);
  return Boolean(
    versions.packageVersion
    && versions.packageVersion === versions.manifestVersion
    && parsePluginVersion(versions.packageVersion),
  );
}

/**
 * Check version epochs across the commits in a range, rather than only the
 * aggregate base/head diff.  An aggregate diff can hide a later same-version
 * content edit when an earlier, unrelated commit already bumped the plugin
 * version.  We track content changes since the most recent synchronized
 * version and require a newer version before the range ends.  A bump in a
 * later commit may intentionally repair an earlier unbumped edit in the same
 * PR; this is why the check records an epoch instead of rejecting every
 * intermediate commit outright.
 */
export function runPluginVersionHistoryCheck({
  root = REPOSITORY_ROOT,
  base,
  head = 'HEAD',
} = {}) {
  if (!base) throw new Error('Plugin version history check requires a base Git ref.');

  /** @type {Map<string, {epochVersion: string|null, seenValid: boolean, pendingFiles: Set<string>}>} */
  const states = new Map();
  /** Cache Git tree reads: history checks otherwise invoke `git show` once
   * per field and once per classification, which is particularly expensive
   * on Windows CI where each child process has noticeable startup cost. */
  const metadataCache = new Map();
  const violations = [];

  function snapshotsAtRefCached(ref, pluginId) {
    const key = `${ref}:${pluginId}`;
    const cached = metadataCache.get(key);
    if (cached) return cached;
    const snapshots = metadataSnapshotsAtRef(ref, pluginId, root);
    metadataCache.set(key, snapshots);
    return snapshots;
  }

  function stateFor(pluginId) {
    let state = states.get(pluginId);
    if (!state) {
      const baseline = snapshotsAtRefCached(base, pluginId);
      const baselineMetadata = metadataFromSnapshots(pluginId, baseline);
      const baselineValid = metadataIsSynchronized(baselineMetadata);
      state = {
        epochVersion: baselineValid ? versionFromMetadata(baselineMetadata).packageVersion : null,
        seenValid: baselineValid,
        pendingFiles: new Set(),
      };
      states.set(pluginId, state);
    }
    return state;
  }

  function applyTransition(to, changedFiles, snapshotsBefore, snapshotsAfter) {
    const pluginIds = [...new Set(changedFiles.map(pluginIdForPath).filter(Boolean))];
    for (const pluginId of pluginIds) {
      const files = changedFiles.filter((filePath) => pluginIdForPath(filePath) === pluginId);
      const state = stateFor(pluginId);
      const beforeSnapshot = snapshotsBefore(pluginId);
      const afterSnapshot = snapshotsAfter(pluginId);
      const before = metadataFromSnapshots(pluginId, beforeSnapshot);
      const after = metadataFromSnapshots(pluginId, afterSnapshot);
      const afterValid = metadataIsSynchronized(after);
      const afterVersion = afterValid ? versionFromMetadata(after).packageVersion : '';
      const beforeVersions = versionFromMetadata(before);
      const afterVersions = versionFromMetadata(after);
      const versionChanged = beforeVersions.packageVersion !== afterVersions.packageVersion
        || beforeVersions.manifestVersion !== afterVersions.manifestVersion;
      const contentFiles = files.filter((filePath) => (
        !isVersionOnlyMetadataChange(filePath, beforeSnapshot, afterSnapshot, pluginId)
      ));
      const contentChanged = contentFiles.length > 0;

      // The first complete metadata snapshot is the plugin's initial epoch;
      // source files imported alongside it do not require a second bump.
      if (!state.seenValid && afterValid) {
        state.seenValid = true;
        state.epochVersion = afterVersion;
        state.pendingFiles.clear();
        continue;
      }

      if (!state.seenValid) {
        if (contentChanged) {
          for (const filePath of contentFiles) state.pendingFiles.add(filePath);
        }
        continue;
      }

      if (afterValid && afterVersion !== state.epochVersion) {
        const order = comparePluginVersions(afterVersion, state.epochVersion);
        if (order === null || order <= 0) {
          violations.push({
            pluginId,
            code: 'version-not-increased',
            message: `${pluginId} changed from ${state.epochVersion || '[missing]'} to ${afterVersion}; content changes require a strictly newer version`,
            files,
            commit: to,
          });
        }
        // A valid newer version establishes a fresh content epoch.  Even when
        // the transition itself is version-only, subsequent edits must bump
        // again instead of being masked by this earlier release metadata.
        if (order !== null && order > 0) {
          state.epochVersion = afterVersion;
          state.pendingFiles.clear();
        }
        continue;
      }

      // A package/manifest version can be changed in separate commits. While
      // metadata is temporarily mismatched, defer classification until the
      // first synchronized snapshot arrives; final metadata validation still
      // fails closed for a permanently malformed tree.
      if (contentChanged) {
        for (const filePath of contentFiles) state.pendingFiles.add(filePath);
      }
    }
  }

  const commits = commitsBetweenRefs(base, head === 'HEAD' ? 'HEAD' : head, root);
  for (const commit of commits) {
    const parents = commitParents(commit, root);
    const parent = parents[0];
    if (!parent) continue;
    const changedFiles = changedFilesBetweenRefs(parent, commit, root);
    if (changedFiles.length === 0) continue;
    applyTransition(
      commit,
      changedFiles,
        (pluginId) => snapshotsAtRefCached(parent, pluginId),
        (pluginId) => snapshotsAtRefCached(commit, pluginId),
    );
  }

  // The default invocation intentionally includes staged/unstaged and
  // untracked worktree changes so developers get the same answer locally as
  // the eventual CI commit. Explicit immutable heads are used by CI/release
  // jobs and do not include worktree state.
  if (head === 'HEAD') {
    // `git diff HEAD HEAD` is empty; use the ordinary worktree diff to include
    // staged and unstaged edits, then add untracked files explicitly.
    const worktreeFiles = gitText([
      'diff',
      '--name-only',
      '-z',
      'HEAD',
      '--',
      PLUGIN_ROOT,
    ], root).split('\0').filter(Boolean).map(normalizeChangedPath);
    const untrackedFiles = gitText([
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      PLUGIN_ROOT,
    ], root).split('\0').filter(Boolean).map(normalizeChangedPath);
    const worktreeFilesUnique = [...new Set([...worktreeFiles, ...untrackedFiles])];
    if (worktreeFilesUnique.length > 0) {
      applyTransition(
        'WORKTREE',
        worktreeFilesUnique,
        (pluginId) => snapshotsAtRefCached('HEAD', pluginId),
        (pluginId) => metadataSnapshotsAtWorkingTree(pluginId, root),
      );
    }
  }

  // Only a plugin that still exists in the final tree can block this build.
  // Deliberately removed/retired plugins are validated by the bundle allowlist
  // instead and should not leave a historical pending epoch behind.
  for (const [pluginId, state] of states) {
    const finalSnapshots = head === 'HEAD'
      // `WORKTREE` is a synthetic label, not a Git ref.  Reading it through
      // metadataSnapshotsAtRef would always return an empty map and could
      // therefore hide a same-version edit made after the last committed
      // version bump (especially an untracked/staged helper file).  Read the
      // actual working tree explicitly for the default local invocation.
      ? metadataSnapshotsAtWorkingTree(pluginId, root)
      : snapshotsAtRefCached(head, pluginId);
    const finalMetadata = metadataFromSnapshots(pluginId, finalSnapshots);
    if (!metadataIsSynchronized(finalMetadata)) continue;
    if (state.pendingFiles.size === 0) continue;
    violations.push({
      pluginId,
      code: 'content-without-version-bump',
      message: `${pluginId} plugin content/schema changed after version ${state.epochVersion}; bump package.json and openclaw.plugin.json`,
      files: [...state.pendingFiles],
    });
  }

  // A single malformed final plugin should retain the detailed metadata
  // diagnostics from checkPluginVersionBumps; this history pass only adds
  // epoch violations. De-duplicate a code/plugin pair when both checks catch
  // the same final content edit.
  const unique = [];
  const seen = new Set();
  for (const violation of violations) {
    const key = `${violation.pluginId}:${violation.code}:${(violation.files ?? []).join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(violation);
  }
  return { ok: unique.length === 0, violations: unique, checked: [...states.keys()] };
}

function resolveBaseRef(argv, env) {
  const explicit = argv.find((arg) => arg === '--base' || arg.startsWith('--base='));
  if (explicit) {
    if (explicit.startsWith('--base=')) return explicit.slice('--base='.length);
    const index = argv.indexOf(explicit);
    return argv[index + 1] || '';
  }
  if (String(env.PLUGIN_VERSION_BASE ?? '').trim()) return String(env.PLUGIN_VERSION_BASE).trim();
  if (String(env.GITHUB_BASE_SHA ?? '').trim()) return String(env.GITHUB_BASE_SHA).trim();
  if (String(env.GITHUB_EVENT_PATH ?? '').trim()) {
    try {
      const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
      const baseSha = event?.pull_request?.base?.sha;
      if (typeof baseSha === 'string' && baseSha.trim()) return baseSha.trim();
    } catch {
      // Let the explicit CI guard below produce a useful error if needed.
    }
  }
  // For local invocation, comparing with the immediate parent is useful and
  // deterministic. CI always supplies the pull request base SHA.
  const isCi = /^(?:1|true)$/iu.test(String(env.CI ?? ''));
  if (!isCi) {
    try {
      return gitText(['rev-parse', 'HEAD^']).trim();
    } catch {
      return '';
    }
  }
  return '';
}

export function runPluginVersionCheck({
  root = REPOSITORY_ROOT,
  base,
  head = 'HEAD',
} = {}) {
  if (!base) throw new Error('Plugin version guard requires a base Git ref (set PLUGIN_VERSION_BASE or pass --base).');
  // `git diff <base>` includes staged and unstaged worktree edits when the
  // caller uses the default HEAD. This makes the guard useful before commit;
  // an explicit head ref uses the immutable three-dot range used by CI.
  const range = head === 'HEAD' ? base : `${base}...${head}`;
  const changedOutput = gitText(['diff', '--name-only', '-z', range, '--', PLUGIN_ROOT], root);
  let changedFiles = changedOutput.split('\0').filter(Boolean).map(normalizeChangedPath);
  // `git diff` intentionally omits untracked files.  Include them for the
  // default worktree mode so a newly-created local plugin cannot bypass this
  // guard simply because it has not been committed yet.  CI uses an explicit
  // head ref and therefore has no untracked release inputs.
  if (head === 'HEAD') {
    const untrackedOutput = gitText([
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      PLUGIN_ROOT,
    ], root);
    changedFiles.push(...untrackedOutput.split('\0').filter(Boolean).map(normalizeChangedPath));
  }
  changedFiles = [...new Set(changedFiles)];
  let pluginIds = [...new Set(changedFiles.map(pluginIdForPath).filter(Boolean))];
  const beforeSnapshots = new Map();
  const afterSnapshots = new Map();
  for (const pluginId of pluginIds) {
    const baselineBefore = metadataSnapshotsAtRef(base, pluginId, root);
    const after = metadataSnapshotsAtHead(pluginId, head, root);
    for (const [relativePath, snapshot] of baselineBefore) beforeSnapshots.set(relativePath, snapshot);
    for (const [relativePath, snapshot] of after) afterSnapshots.set(relativePath, snapshot);

    // A plugin introduced after the supplied base is not automatically exempt
    // from future version checks.  Establish a baseline at its first complete
    // metadata commit, then inspect only changes made after that import.  If
    // no post-import files changed, retain the original file list so the
    // generic checker can classify it as a valid newly-added plugin.
    const { packagePath, manifestPath } = pluginMetadataPaths(pluginId);
    // Only a genuinely absent plugin gets the historical-import fallback.
    // If one metadata file exists at the supplied base, preserve that malformed
    // baseline and let the normal checker fail closed with a useful error.
    if (!baselineBefore.has(packagePath) && !baselineBefore.has(manifestPath)) {
      const baselineCommit = findPluginBaselineCommit({ base, head, pluginId, root });
      if (baselineCommit) {
        const postImportFiles = changedPluginFiles({
          from: baselineCommit,
          to: head,
          pluginId,
          root,
        });
        if (postImportFiles.length > 0) {
          const historicalBaseline = metadataSnapshotsAtRef(baselineCommit, pluginId, root);
          // Replace only this plugin's metadata entries; other plugins retain
          // their ordinary base snapshots in the shared maps.
          for (const relativePath of [
            `${PLUGIN_ROOT}/${pluginId}/package.json`,
            `${PLUGIN_ROOT}/${pluginId}/openclaw.plugin.json`,
          ]) {
            beforeSnapshots.delete(relativePath);
            const snapshot = historicalBaseline.get(relativePath);
            if (snapshot !== undefined) beforeSnapshots.set(relativePath, snapshot);
          }
          changedFiles = changedFiles.filter((filePath) => pluginIdForPath(filePath) !== pluginId);
          changedFiles.push(...postImportFiles);
          pluginIds = [...new Set(changedFiles.map(pluginIdForPath).filter(Boolean))];
        }
      }
    }
  }
  const aggregate = checkPluginVersionBumps({ changedFiles, beforeSnapshots, afterSnapshots });
  // The aggregate comparison is intentionally retained for fast metadata and
  // added/removed-plugin diagnostics.  A second, commit-epoch pass closes the
  // long-branch loophole where an earlier version bump masks a later same-
  // version content edit in the same base..head range.
  const history = runPluginVersionHistoryCheck({ root, base, head });
  const violations = [...aggregate.violations, ...history.violations];
  const seen = new Set();
  const uniqueViolations = violations.filter((violation) => {
    const key = `${violation.pluginId}:${violation.code}:${(violation.files ?? []).join('|')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ok: uniqueViolations.length === 0,
    checked: aggregate.checked,
    violations: uniqueViolations,
  };
}

function parseCli(argv) {
  const baseArg = argv.find((arg) => arg === '--base' || arg.startsWith('--base='));
  const base = baseArg?.startsWith('--base=') ? baseArg.slice('--base='.length) : undefined;
  const baseIndex = baseArg && !base ? argv.indexOf(baseArg) : -1;
  const headArg = argv.find((arg) => arg === '--head' || arg.startsWith('--head='));
  const head = headArg?.startsWith('--head=')
    ? headArg.slice('--head='.length)
    : headArg
      ? argv[argv.indexOf(headArg) + 1]
      : 'HEAD';
  return { base: base || (baseIndex >= 0 ? argv[baseIndex + 1] : undefined), head };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const { base, head } = parseCli(argv);
  const resolvedBase = base || resolveBaseRef(argv, env);
  const result = runPluginVersionCheck({ base: resolvedBase, head });
  if (!result.ok) {
    const lines = ['Plugin version guard failed:'];
    for (const violation of result.violations) {
      lines.push(`- ${violation.message}`);
      if (violation.files?.length) lines.push(`  changed: ${violation.files.join(', ')}`);
    }
    throw new Error(lines.join('\n'));
  }
  if (result.checked.length > 0) {
    console.log(`[plugin-version] checked ${result.checked.length} changed plugin(s): ${result.checked.map(({ pluginId }) => pluginId).join(', ')}`);
  } else {
    console.log('[plugin-version] no changed local plugins');
  }
  return result;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[plugin-version] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
