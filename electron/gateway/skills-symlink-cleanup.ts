/**
 * Async pre-launch cleanup for skill symlinks rejected by OpenClaw's managed
 * skill-root containment checks and for stale plugin runtime dependency roots.
 *
 * Startup can encounter thousands of entries on long-lived installations, so
 * every filesystem operation uses node:fs/promises and traversal yields to the
 * event loop in bounded batches. Removal remains deliberately narrow:
 *   - only symlinks immediately below the configured managed skill roots;
 *   - only immediate, real directories named openclaw-* below runtime-deps;
 *   - only runtime roots containing an OpenClaw symlink outside the current
 *     bundled OpenClaw package.
 */
import type { Dirent, Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, readdir, readlink, realpath, rename, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getOpenClawConfigDir, getOpenClawResolvedDir, getOpenClawSkillsDir } from '../utils/paths';
import { logger } from '../utils/logger';

const TRAVERSAL_YIELD_INTERVAL = 64;
const MAX_RUNTIME_DEPS_SYMLINKS = 5_000;

export interface CleanupOptions {
  /** Override for ~/.openclaw/skills (mainly for tests). */
  skillsDir?: string;
  /** Override for ~/.agents/skills (mainly for tests/log context). */
  agentsDir?: string;
  /** Override for ~/.openclaw/workspace/skills (mainly for tests). */
  workspaceSkillsDir?: string;
  /** Override for ~/.openclaw/workspace/.agents/skills (mainly for tests). */
  workspaceAgentsDir?: string;
}

export interface CleanupResult {
  /** Symlink/cache-root names removed from the managed directory. */
  removed: string[];
  /** Total number of symlink entries that were inspected. */
  examined: number;
  /** Cleanup operations that could not be completed and should be retried later. */
  failed?: number;
}

export interface PluginRuntimeDepsCleanupOptions {
  /** Override for ~/.openclaw/plugin-runtime-deps (mainly for tests). */
  runtimeDepsDir?: string;
  /** Override for the current bundled OpenClaw package dir (mainly for tests). */
  currentOpenClawDir?: string;
}

export interface CleanupDependencies {
  readdir(directoryPath: string): Promise<Dirent[]>;
  lstat(entryPath: string): Promise<Stats>;
  readlink(entryPath: string): Promise<string>;
  realpath(entryPath: string): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(entryPath: string, options: { force: boolean; recursive: boolean }): Promise<void>;
  unlink(entryPath: string): Promise<void>;
  yieldToEventLoop(): Promise<void>;
  yieldEveryEntries: number;
  maxRuntimeDepsSymlinks: number;
}

const DEFAULT_CLEANUP_DEPENDENCIES: CleanupDependencies = {
  readdir: (directoryPath) =>
    readdir(directoryPath, { withFileTypes: true, encoding: 'utf8' }),
  lstat: (entryPath) => lstat(entryPath),
  readlink: (entryPath) => readlink(entryPath, { encoding: 'utf8' }),
  realpath: (entryPath) => realpath(entryPath),
  rename: (oldPath, newPath) => rename(oldPath, newPath),
  rm: (entryPath, options) => rm(entryPath, options),
  unlink: (entryPath) => unlink(entryPath),
  yieldToEventLoop: () => new Promise((resolve) => setImmediate(resolve)),
  yieldEveryEntries: TRAVERSAL_YIELD_INTERVAL,
  maxRuntimeDepsSymlinks: MAX_RUNTIME_DEPS_SYMLINKS,
};

type RuntimeDepsScanResult = {
  stale: boolean;
  examined: number;
  failed: number;
};

function defaultSkillsDir(): string {
  return getOpenClawSkillsDir();
}

function defaultAgentsDir(): string {
  return path.join(homedir(), '.agents', 'skills');
}

function defaultWorkspaceSkillsDir(): string {
  return path.join(getOpenClawConfigDir(), 'workspace', 'skills');
}

function defaultWorkspaceAgentsDir(): string {
  return path.join(getOpenClawConfigDir(), 'workspace', '.agents', 'skills');
}

function defaultPluginRuntimeDepsDir(): string {
  return path.join(getOpenClawConfigDir(), 'plugin-runtime-deps');
}

function recordCleanupFailure(result: CleanupResult, count = 1): void {
  if (count > 0) result.failed = (result.failed ?? 0) + count;
}

function resolveCleanupDependencies(
  overrides: Partial<CleanupDependencies>,
): CleanupDependencies {
  const requestedYieldInterval = overrides.yieldEveryEntries;
  const yieldEveryEntries =
    Number.isSafeInteger(requestedYieldInterval) && (requestedYieldInterval ?? 0) > 0
      ? requestedYieldInterval!
      : TRAVERSAL_YIELD_INTERVAL;
  const requestedSymlinkLimit = overrides.maxRuntimeDepsSymlinks;
  const maxRuntimeDepsSymlinks =
    Number.isSafeInteger(requestedSymlinkLimit) && (requestedSymlinkLimit ?? 0) > 0
      ? requestedSymlinkLimit!
      : MAX_RUNTIME_DEPS_SYMLINKS;

  return {
    readdir: overrides.readdir ?? DEFAULT_CLEANUP_DEPENDENCIES.readdir,
    lstat: overrides.lstat ?? DEFAULT_CLEANUP_DEPENDENCIES.lstat,
    readlink: overrides.readlink ?? DEFAULT_CLEANUP_DEPENDENCIES.readlink,
    realpath: overrides.realpath ?? DEFAULT_CLEANUP_DEPENDENCIES.realpath,
    rename: overrides.rename ?? DEFAULT_CLEANUP_DEPENDENCIES.rename,
    rm: overrides.rm ?? DEFAULT_CLEANUP_DEPENDENCIES.rm,
    unlink: overrides.unlink ?? DEFAULT_CLEANUP_DEPENDENCIES.unlink,
    yieldToEventLoop:
      overrides.yieldToEventLoop ?? DEFAULT_CLEANUP_DEPENDENCIES.yieldToEventLoop,
    yieldEveryEntries,
    maxRuntimeDepsSymlinks,
  };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isMissingPathError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR';
}

async function yieldTraversal(index: number, dependencies: CleanupDependencies): Promise<void> {
  if (index > 0 && index % dependencies.yieldEveryEntries === 0) {
    await dependencies.yieldToEventLoop();
  }
}

/** Resolve an optional context root without turning a fresh install into an error. */
async function resolveOptionalRealRoot(
  directoryPath: string,
  dependencies: CleanupDependencies,
): Promise<string> {
  try {
    return await dependencies.realpath(directoryPath);
  } catch {
    const parent = path.dirname(directoryPath);
    const tail = path.basename(directoryPath);
    if (parent && parent !== directoryPath) {
      try {
        return path.join(await dependencies.realpath(parent), tail);
      } catch {
        // Fall back to the lexical path for log context only.
      }
    }
    return path.resolve(directoryPath);
  }
}

/** Lower-case Win32 paths so containment follows case-insensitive NTFS semantics. */
function normalizeForCompare(candidate: string): string {
  return process.platform === 'win32' ? candidate.toLowerCase() : candidate;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(normalizeForCompare(parent), normalizeForCompare(child));
  if (relative === '') return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function looksLikeOpenClawPackagePath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, '/');
  return /\/node_modules(?:\/\.pnpm\/[^/]+\/node_modules)?\/openclaw(?:\/|$)/.test(normalized);
}

async function resolveCurrentOpenClawRoots(
  currentOpenClawDir: string,
  dependencies: CleanupDependencies,
): Promise<string[]> {
  const roots = new Set<string>([path.resolve(currentOpenClawDir)]);
  try {
    roots.add(await dependencies.realpath(currentOpenClawDir));
  } catch {
    // The lexical package path still protects a partially materialized install.
  }
  return Array.from(roots);
}

async function isSymlinkEntry(
  entry: Dirent,
  entryPath: string,
  dependencies: CleanupDependencies,
): Promise<boolean> {
  if (entry.isSymbolicLink()) return true;
  try {
    return (await dependencies.lstat(entryPath)).isSymbolicLink();
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return false;
  }
}

function staleTargetError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = 'ESTALE';
  return error;
}

function sameEntryIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.birthtimeMs === right.birthtimeMs;
}

async function quarantineAndRemove(
  entryPath: string,
  expectedIdentity: Stats,
  expectedType: (info: Stats) => boolean,
  removeQuarantined: (quarantinePath: string) => Promise<void>,
  dependencies: CleanupDependencies,
  staleCode: string,
): Promise<void> {
  const quarantinePath = path.join(
    path.dirname(entryPath),
    `${path.basename(entryPath)}.uclaw-cleanup-${process.pid}-${randomUUID()}`,
  );
  try {
    await dependencies.rename(entryPath, quarantinePath);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }

  try {
    const quarantined = await dependencies.lstat(quarantinePath);
    if (!expectedType(quarantined) || !sameEntryIdentity(expectedIdentity, quarantined)) {
      throw staleTargetError(staleCode);
    }
    await removeQuarantined(quarantinePath);
  } catch (error) {
    try {
      await dependencies.rename(quarantinePath, entryPath);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `${staleCode}_restore_failed`,
        { cause: restoreError },
      );
    }
    throw error;
  }
}

async function removeSymlink(
  entryPath: string,
  dependencies: CleanupDependencies,
): Promise<void> {
  let current;
  try {
    current = await dependencies.lstat(entryPath);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (!current.isSymbolicLink()) {
    throw staleTargetError('skill_cleanup_target_changed');
  }
  await quarantineAndRemove(
    entryPath,
    current,
    (info) => info.isSymbolicLink(),
    async (quarantinePath) => {
      try {
        await dependencies.unlink(quarantinePath);
      } catch (error) {
        if (isMissingPathError(error)) return;
        if (!['EPERM', 'EACCES', 'EISDIR'].includes(errorCode(error) ?? '')) throw error;
        await dependencies.rm(quarantinePath, { force: true, recursive: true });
      }
    },
    dependencies,
    'skill_cleanup_target_changed',
  );
}

export async function cleanupAgentsSymlinkedSkills(
  opts: CleanupOptions = {},
  dependencyOverrides: Partial<CleanupDependencies> = {},
): Promise<CleanupResult> {
  const dependencies = resolveCleanupDependencies(dependencyOverrides);
  const hasMainOverrides = opts.skillsDir !== undefined || opts.agentsDir !== undefined;
  const hasWorkspaceOverrides =
    opts.workspaceSkillsDir !== undefined || opts.workspaceAgentsDir !== undefined;
  const roots = [
    {
      skillsDir: opts.skillsDir ?? defaultSkillsDir(),
      agentsDir: opts.agentsDir ?? defaultAgentsDir(),
    },
  ];

  if (!hasMainOverrides || hasWorkspaceOverrides) {
    roots.push({
      skillsDir: opts.workspaceSkillsDir ?? defaultWorkspaceSkillsDir(),
      agentsDir: opts.workspaceAgentsDir ?? defaultWorkspaceAgentsDir(),
    });
  }

  const result: CleanupResult = { removed: [], examined: 0 };
  const seenRoots = new Set<string>();

  for (const root of roots) {
    const rootKey = `${path.resolve(root.skillsDir)}\0${path.resolve(root.agentsDir)}`;
    if (seenRoots.has(rootKey)) continue;
    seenRoots.add(rootKey);

    const rootResult = await cleanupSkillsDir(root.skillsDir, root.agentsDir, dependencies);
    result.removed.push(...rootResult.removed);
    result.examined += rootResult.examined;
    if (rootResult.failed) {
      recordCleanupFailure(result, rootResult.failed);
    }
  }

  return result;
}

/**
 * Remove stale OpenClaw plugin runtime dependency cache roots.
 *
 * OpenClaw may materialize plugin-runtime-deps/openclaw-* as a symlink tree
 * into package dist files. Old worktree targets make plugin startup repeatedly
 * open and copy obsolete files before RPC readiness. Only immediate real
 * directories with a confirmed stale OpenClaw symlink are removed.
 */
export async function cleanupStalePluginRuntimeDeps(
  opts: PluginRuntimeDepsCleanupOptions = {},
  dependencyOverrides: Partial<CleanupDependencies> = {},
): Promise<CleanupResult> {
  const dependencies = resolveCleanupDependencies(dependencyOverrides);
  const runtimeDepsDir = opts.runtimeDepsDir ?? defaultPluginRuntimeDepsDir();
  const currentRoots = await resolveCurrentOpenClawRoots(
    opts.currentOpenClawDir ?? getOpenClawResolvedDir(),
    dependencies,
  );
  const result: CleanupResult = { removed: [], examined: 0 };

  let entries: Dirent[];
  try {
    entries = await dependencies.readdir(runtimeDepsDir);
  } catch (error) {
    if (isMissingPathError(error)) return result;
    logger.warn(`[plugin-runtime-deps-cleanup] Failed to list ${runtimeDepsDir}:`, error);
    recordCleanupFailure(result);
    return result;
  }

  let visitedRoots = 0;
  for (const entry of entries) {
    visitedRoots += 1;
    await yieldTraversal(visitedRoots, dependencies);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('openclaw-')) {
      continue;
    }

    const cacheRoot = path.join(runtimeDepsDir, entry.name);
    const scan = await scanRuntimeDepsRootForStaleOpenClawSymlink(
      cacheRoot,
      currentRoots,
      dependencies,
    );
    result.examined += scan.examined;
    if (scan.failed > 0) {
      recordCleanupFailure(result, scan.failed);
    }
    if (!scan.stale) continue;

    try {
      const current = await dependencies.lstat(cacheRoot);
      if (!current.isDirectory() || current.isSymbolicLink()) {
        throw staleTargetError('runtime_deps_cleanup_target_changed');
      }
      await quarantineAndRemove(
        cacheRoot,
        current,
        (info) => info.isDirectory() && !info.isSymbolicLink(),
        (quarantinePath) => dependencies.rm(
          quarantinePath,
          { force: true, recursive: true },
        ),
        dependencies,
        'runtime_deps_cleanup_target_changed',
      );
      result.removed.push(entry.name);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      logger.warn(`[plugin-runtime-deps-cleanup] Failed to remove ${cacheRoot}:`, error);
      recordCleanupFailure(result);
    }
  }

  if (result.removed.length > 0) {
    logger.info(
      `[plugin-runtime-deps-cleanup] Removed ${result.removed.length} stale OpenClaw runtime cache root(s): ` +
        result.removed.join(', '),
    );
  }

  return result;
}

async function scanRuntimeDepsRootForStaleOpenClawSymlink(
  cacheRoot: string,
  currentOpenClawRoots: string[],
  dependencies: CleanupDependencies,
): Promise<RuntimeDepsScanResult> {
  const stack = [cacheRoot];
  let examined = 0;
  let failed = 0;
  let visitedEntries = 0;
  let truncated = false;

  while (stack.length > 0) {
    const directoryPath = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await dependencies.readdir(directoryPath);
    } catch (error) {
      if (!isMissingPathError(error)) {
        logger.warn(`[plugin-runtime-deps-cleanup] Failed to scan ${directoryPath}:`, error);
        failed += 1;
      }
      continue;
    }

    for (const entry of entries) {
      if (examined >= dependencies.maxRuntimeDepsSymlinks) {
        truncated = true;
        break;
      }
      visitedEntries += 1;
      await yieldTraversal(visitedEntries, dependencies);
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(entryPath);
        continue;
      }

      let symlink: boolean;
      try {
        symlink = await isSymlinkEntry(entry, entryPath, dependencies);
      } catch (error) {
        logger.warn(`[plugin-runtime-deps-cleanup] Failed to inspect ${entryPath}:`, error);
        failed += 1;
        continue;
      }
      if (!symlink) continue;

      examined += 1;
      let target: string;
      try {
        target = path.resolve(path.dirname(entryPath), await dependencies.readlink(entryPath));
      } catch (error) {
        if (!isMissingPathError(error)) {
          logger.warn(`[plugin-runtime-deps-cleanup] Failed to read ${entryPath}:`, error);
          failed += 1;
        }
        continue;
      }
      if (!looksLikeOpenClawPackagePath(target)) continue;

      const pointsAtCurrentOpenClaw = currentOpenClawRoots.some((root) => isInside(root, target));
      if (!pointsAtCurrentOpenClaw) return { stale: true, examined, failed };
    }
    if (truncated) break;
  }

  if (truncated) {
    logger.warn(
      `[plugin-runtime-deps-cleanup] Scan limit reached after ${examined} symlink(s); cleanup will retry`,
    );
    failed += 1;
  }

  return { stale: false, examined, failed };
}

async function cleanupSkillsDir(
  skillsDir: string,
  agentsDir: string,
  dependencies: CleanupDependencies,
): Promise<CleanupResult> {
  const result: CleanupResult = { removed: [], examined: 0 };
  let skillsRealRoot: string;
  try {
    skillsRealRoot = await dependencies.realpath(skillsDir);
  } catch (error) {
    if (isMissingPathError(error)) return result;
    logger.warn(`[skills-cleanup] Failed to resolve ${skillsDir}:`, error);
    recordCleanupFailure(result);
    return result;
  }
  const agentsRealRoot = await resolveOptionalRealRoot(agentsDir, dependencies);

  let entries: Dirent[];
  try {
    entries = await dependencies.readdir(skillsDir);
  } catch (error) {
    if (isMissingPathError(error)) return result;
    logger.warn(`[skills-cleanup] Failed to list ${skillsDir}:`, error);
    recordCleanupFailure(result);
    return result;
  }

  let visitedEntries = 0;
  for (const entry of entries) {
    visitedEntries += 1;
    await yieldTraversal(visitedEntries, dependencies);
    const entryPath = path.join(skillsDir, entry.name);

    let symlink: boolean;
    try {
      symlink = await isSymlinkEntry(entry, entryPath, dependencies);
    } catch (error) {
      logger.warn(`[skills-cleanup] Failed to inspect ${entryPath}:`, error);
      recordCleanupFailure(result);
      continue;
    }
    if (!symlink) continue;

    result.examined += 1;
    let realTarget: string;
    try {
      realTarget = await dependencies.realpath(entryPath);
    } catch (error) {
      if (!isMissingPathError(error)) {
        logger.warn(`[skills-cleanup] Failed to resolve ${entryPath}:`, error);
        recordCleanupFailure(result);
      }
      continue;
    }
    if (isInside(skillsRealRoot, realTarget)) continue;

    try {
      await removeSymlink(entryPath, dependencies);
      result.removed.push(entry.name);
    } catch (error) {
      logger.warn(`[skills-cleanup] Failed to remove ${entryPath}:`, error);
      recordCleanupFailure(result);
    }
  }

  if (result.removed.length > 0) {
    logger.info(
      `[skills-cleanup] Removed ${result.removed.length} stray skill symlink(s) ` +
        `under ${skillsDir} that escaped managed root ${skillsRealRoot} ` +
        `(workaround for openclaw/openclaw#59219): ` +
        result.removed.join(', '),
    );
  } else if (result.examined > 0) {
    logger.debug(
      `[skills-cleanup] Examined ${result.examined} symlink(s) under ${skillsDir}; ` +
        `none escaped managed root (agents context: ${agentsRealRoot})`,
    );
  }

  return result;
}
