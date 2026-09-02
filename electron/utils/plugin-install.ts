/**
 * Shared OpenClaw Plugin Install Utilities
 *
 * Provides version-aware install/upgrade logic for bundled OpenClaw plugins
 * (DingTalk, WeCom, Feishu, WeChat, Discord, QQBot, WhatsApp, Parallel Search). Used both at app startup (to auto-upgrade
 * stale plugins) and when a user configures a channel.
 */
import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { logger } from './logger';
import { withConfigLock } from './config-mutex';
import { upsertPluginInstallRecordsIntoSqlite } from './plugin-install-index';
import { resolveOpenClawConfigPath, resolveOpenClawStateDir } from './paths';
import {
  isTransientPluginInstallPath,
  resolvePluginInstallWorkPaths,
  resolvePluginInstallWorkRoot,
} from './plugin-install-paths';

function normalizeFsPathForWindows(filePath: string): string {
  if (process.platform !== 'win32') return filePath;
  if (!filePath) return filePath;
  if (filePath.startsWith('\\\\?\\')) return filePath;

  const windowsPath = filePath.replace(/\//g, '\\');
  if (!path.win32.isAbsolute(windowsPath)) return windowsPath;
  if (windowsPath.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${windowsPath.slice(2)}`;
  }
  return `\\\\?\\${windowsPath}`;
}

function fsPath(filePath: string): string {
  return normalizeFsPathForWindows(filePath);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(fsPath(filePath));
    return true;
  } catch {
    return false;
  }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    // Do not follow an entrypoint symlink out of the plugin tree. Bundled
    // mirrors are self-contained and should contain ordinary files here;
    // treating an external symlink as a valid source would make ownership and
    // content checks depend on arbitrary user-controlled paths.
    return (await lstat(fsPath(filePath))).isFile();
  } catch {
    return false;
  }
}

async function realpathSafe(filePath: string): Promise<string> {
  return realpath(fsPath(filePath));
}

/**
 * Unicode-safe recursive directory copy. The manual async walk also avoids
 * Node's historical Windows non-ASCII `cp` failures.
 */
export async function cpAsyncSafe(src: string, dest: string): Promise<void> {
  const sourcePath = fsPath(src);
  const sourceInfo = await lstat(sourcePath);
  if (!sourceInfo.isDirectory()) {
    throw new Error(`Refusing to copy non-directory plugin source: ${src}`);
  }
  await _copyDirAsyncRecursive(sourcePath, fsPath(dest));
}

async function _copyDirAsyncRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcChild = join(src, entry.name);
    const destChild = join(dest, entry.name);
    // Do not follow links while copying a plugin tree.  `stat()` used here
    // previously made a symlink to an arbitrary file/directory look like a
    // regular source entry, allowing a malformed bundled mirror to copy
    // bytes from outside the package (or recurse forever through a link
    // cycle).  Bundled mirrors and staged plugin trees are expected to be
    // self-contained ordinary files, so fail closed for links and special
    // filesystem nodes instead of silently dereferencing them.
    const info = await lstat(srcChild);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to copy symbolic link in plugin source: ${srcChild}`);
    }
    if (info.isDirectory()) {
      await _copyDirAsyncRecursive(srcChild, destChild);
    } else if (info.isFile()) {
      await copyFile(srcChild, destChild);
    } else {
      throw new Error(`Refusing to copy unsupported filesystem entry in plugin source: ${srcChild}`);
    }
  }
}

function asErrnoException(error: unknown): NodeJS.ErrnoException | null {
  if (error && typeof error === 'object') {
    return error as NodeJS.ErrnoException;
  }
  return null;
}

type PluginInstallPhase =
  | 'staging-setup'
  | 'staging-copy'
  | 'validation'
  | 'dependency-hydration'
  | 'activation'
  | 'rollback'
  | 'cleanup';

class PluginInstallPhaseError extends Error {
  constructor(
    readonly phase: PluginInstallPhase,
    message: string,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = 'PluginInstallPhaseError';
  }
}

class PluginOwnershipConflictError extends Error {
  constructor(readonly ownership: ManagedPluginOwnership) {
    super(`Managed plugin ownership conflict: ${ownership.code}`);
    this.name = 'PluginOwnershipConflictError';
  }
}

function rootErrnoException(error: unknown): NodeJS.ErrnoException | null {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const errno = current as NodeJS.ErrnoException;
    if (typeof errno.code === 'string') return errno;
    current = 'cause' in errno ? errno.cause : null;
  }
  return asErrnoException(error);
}

function toErrorDiagnostic(error: unknown): {
  code?: string;
  name?: string;
  phase?: PluginInstallPhase;
  message: string;
} {
  const errno = rootErrnoException(error);
  if (!errno) {
    return { message: String(error) };
  }

  return {
    code: typeof errno.code === 'string' ? errno.code : undefined,
    name: error instanceof Error ? error.name : errno.name,
    phase: error instanceof PluginInstallPhaseError ? error.phase : undefined,
    message: error instanceof Error ? error.message : errno.message || String(error),
  };
}

function asPluginInstallPhaseError(
  error: unknown,
  phase: PluginInstallPhase,
  pluginLabel: string,
): PluginInstallPhaseError {
  if (error instanceof PluginInstallPhaseError) return error;
  return new PluginInstallPhaseError(
    phase,
    `${pluginLabel} plugin install failed during ${phase}: ${toErrorDiagnostic(error).message}`,
    error,
  );
}

const WINDOWS_TRANSIENT_FS_ERRORS = new Set(['EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY', 'EPERM']);
const WINDOWS_FS_RETRY_DELAYS_MS = [0, 50, 150, 300, 600] as const;
async function runWithTransientFsRetry<T>(operation: () => Promise<T>): Promise<T> {
  const delays = process.platform === 'win32' ? WINDOWS_FS_RETRY_DELAYS_MS : [0] as const;
  let lastError: unknown;
  for (const delayMs of delays) {
    if (delayMs > 0) await delay(delayMs);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const code = asErrnoException(error)?.code;
      if (process.platform !== 'win32' || !code || !WINDOWS_TRANSIENT_FS_ERRORS.has(code)) {
        throw error;
      }
    }
  }
  throw lastError;
}

export async function cleanupStalePluginInstallArtifacts(): Promise<boolean> {
  const extensionsRoot = getOpenClawExtensionsDir();
  let succeeded = true;

  try {
    for (const entry of await readdir(fsPath(extensionsRoot), { withFileTypes: true })) {
      if (!isTransientPluginInstallPath(entry.name)) continue;
      const stalePath = join(extensionsRoot, entry.name);
      try {
        await runWithTransientFsRetry(() => rm(fsPath(stalePath), { recursive: true, force: true }));
        logger.info(`[plugin] Removed stale plugin install artifact: ${stalePath}`);
      } catch (error) {
        succeeded = false;
        logger.warn('[plugin] Failed to remove stale plugin install artifact', {
          stalePath,
          ...toErrorDiagnostic(error),
        });
      }
    }
  } catch (error) {
    if (asErrnoException(error)?.code !== 'ENOENT') {
      succeeded = false;
      logger.warn('[plugin] Failed to scan extensions for stale install artifacts', {
        extensionsRoot,
        ...toErrorDiagnostic(error),
      });
    }
  }

  const workRoot = resolvePluginInstallWorkRoot(extensionsRoot);
  try {
    await runWithTransientFsRetry(() => rm(fsPath(workRoot), { recursive: true, force: true }));
  } catch (error) {
    succeeded = false;
    logger.warn('[plugin] Failed to clean plugin install work directory', {
      workRoot,
      ...toErrorDiagnostic(error),
    });
  }

  return succeeded;
}

// ── Known plugin-ID corrections ─────────────────────────────────────────────
// Some npm packages ship with an openclaw.plugin.json whose "id" field
// doesn't match the ID the plugin code actually exports.  After copying we
// patch both the manifest AND the compiled JS so the Gateway accepts them.
const MANIFEST_ID_FIXES: Record<string, string> = {
  'wecom-openclaw-plugin': 'wecom',
};

/**
 * After a plugin has been copied to ~/.openclaw/extensions/<dir>, fix any
 * known manifest-ID mismatches so the Gateway can load the plugin.
 * Also patches package.json fields that the Gateway uses as "entry hints".
 */
export async function fixupPluginManifest(targetDir: string): Promise<void> {
  // 1. Fix openclaw.plugin.json id
  const manifestPath = join(targetDir, 'openclaw.plugin.json');
  try {
    const raw = await readFile(fsPath(manifestPath), 'utf-8');
    const manifest = JSON.parse(raw);
    const oldId = manifest.id as string | undefined;
    if (oldId && MANIFEST_ID_FIXES[oldId]) {
      const newId = MANIFEST_ID_FIXES[oldId];
      manifest.id = newId;
      await writeFile(fsPath(manifestPath), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
      logger.info(`[plugin] Fixed manifest ID: ${oldId} → ${newId}`);
    }
  } catch {
    // manifest may not exist yet — ignore
  }

  // 2. Fix package.json fields that Gateway uses as "entry hints"
  const pkgPath = join(targetDir, 'package.json');
  try {
    const raw = await readFile(fsPath(pkgPath), 'utf-8');
    const pkg = JSON.parse(raw);
    let modified = false;

    // Check if the package name contains a legacy ID that needs fixing
    for (const [oldId, newId] of Object.entries(MANIFEST_ID_FIXES)) {
      if (typeof pkg.name === 'string' && pkg.name.includes(oldId)) {
        pkg.name = pkg.name.replace(oldId, newId);
        modified = true;
      }
      const install = pkg.openclaw?.install;
      if (install) {
        if (typeof install.npmSpec === 'string' && install.npmSpec.includes(oldId)) {
          install.npmSpec = install.npmSpec.replace(oldId, newId);
          modified = true;
        }
        if (typeof install.localPath === 'string' && install.localPath.includes(oldId)) {
          install.localPath = install.localPath.replace(oldId, newId);
          modified = true;
        }
      }
    }

    if (modified) {
      await writeFile(fsPath(pkgPath), JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
      logger.info(`[plugin] Fixed package.json entry hints in ${targetDir}`);
    }
  } catch {
    // ignore
  }

  // 3. Fix hardcoded plugin IDs in compiled JS entry files.
  //    The Gateway validates that the JS export's `id` matches the manifest.
  await patchPluginEntryIds(targetDir);
}

/**
 * Patch the compiled JS entry files so the hardcoded `id` field in the
 * plugin export matches the manifest.  Without this, the Gateway rejects
 * the plugin with "plugin id mismatch".
 */
async function patchPluginEntryIds(targetDir: string): Promise<void> {
  const pkgPath = join(targetDir, 'package.json');
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await readFile(fsPath(pkgPath), 'utf-8'));
  } catch {
    return;
  }

  const entryFiles = [pkg.main, pkg.module].filter(Boolean) as string[];

  for (const entry of entryFiles) {
    const entryPath = join(targetDir, entry);
    if (!(await pathExists(entryPath))) continue;

    let content: string;
    try {
      content = await readFile(fsPath(entryPath), 'utf-8');
    } catch {
      continue;
    }

    let patched = false;
    for (const [wrongId, correctId] of Object.entries(MANIFEST_ID_FIXES)) {
      // Match patterns like:  id: "wecom-openclaw-plugin"  or  id: 'wecom-openclaw-plugin'
      const escapedWrongId = wrongId.replace(/-/g, '\\-');
      const pattern = new RegExp(`(\\bid\\s*:\\s*)(["'])${escapedWrongId}\\2`, 'g');
      const replaced = content.replace(pattern, `$1$2${correctId}$2`);
      if (replaced !== content) {
        content = replaced;
        patched = true;
        logger.info(`[plugin] Patched plugin ID in ${entry}: "${wrongId}" → "${correctId}"`);
      }
    }

    if (patched) {
      await writeFile(fsPath(entryPath), content, 'utf-8');
    }
  }
}

// ── Plugin npm name mapping ──────────────────────────────────────────────────

const PLUGIN_NPM_NAMES: Record<string, string> = {
  dingtalk: '@soimy/dingtalk',
  wecom: '@wecom/wecom-openclaw-plugin',
  'feishu-openclaw-plugin': '@larksuite/openclaw-lark',
  discord: '@openclaw/discord',
  qqbot: '@openclaw/qqbot',
  whatsapp: '@openclaw/whatsapp',

  'openclaw-weixin': '@tencent-weixin/openclaw-weixin',
  parallel: '@openclaw/parallel-plugin',
};

/**
 * Official @openclaw/* extension plugins that ClawX mirrors into
 * ~/.openclaw/extensions/. OpenClaw 2026.6+ requires matching
 * plugins.installs metadata so trustedOfficialInstall is true and
 * runtime APIs such as openKeyedStore are available.
 */
const TRUSTED_OFFICIAL_EXTENSION_PLUGINS: Record<string, string> = {
  whatsapp: '@openclaw/whatsapp',
  discord: '@openclaw/discord',
  qqbot: '@openclaw/qqbot',
  parallel: '@openclaw/parallel-plugin',
};

function getOpenClawExtensionsDir(): string {
  return join(resolveOpenClawStateDir(), 'extensions');
}

export const UCLAW_MANAGED_PLUGIN_MARKER_FILENAME = '.uclaw-managed-plugin.json';
const UCLAW_MANAGED_PLUGIN_MARKER_VERSION = 1;

export type ManagedPluginOwnership = Readonly<{
  status: 'absent' | 'managed' | 'user-owned-or-unknown' | 'indeterminate';
  evidence:
    | 'none'
    | 'managed-marker'
    | 'trusted-install-record'
    | 'bundled-content-match'
    | 'clawx-managed-plugin-id'
    | 'invalid-marker'
    | 'state-read-failed';
  code: string;
  contentModified?: boolean;
}>;

export type ManagedPluginRemovalResult = Readonly<{
  removed: boolean;
  preserved: boolean;
  code: 'absent' | 'removed' | 'ownership-conflict' | 'remove-failed';
  ownership: ManagedPluginOwnership;
  warning?: string;
}>;

export type PluginInstallResult = Readonly<{
  installed: boolean;
  warning?: string;
  /**
   * Machine-readable failure classification.  The regular UI install flow
   * keeps returning a best-effort result, while Gateway startup can opt into
   * the fail-closed `requireBundledSource` mode below and turn these failures
   * into a repair-required startup error.
   */
  code?: 'managed-plugin-ownership-conflict' | 'bundled-source-missing' | 'bundled-source-invalid';
  /** True when continuing with an existing/stale copy would be unsafe. */
  repairRequired?: boolean;
  action?: 'preserved';
  ownership?: ManagedPluginOwnership;
}>;

type ManagedPluginMarker = Readonly<{
  schemaVersion: number;
  managedBy: string;
  pluginId: string;
  contentFingerprint: string;
  installedAt: string;
}>;

type ManagedPluginOwnershipOptions = Readonly<{
  targetDir?: string;
  candidateSources?: string[];
}>;

/**
 * ClawX owns these currently bundled local plugins across upgrades, including
 * installs created before the managed marker was introduced.
 *
 * Do not use a broad `uclaw-*` prefix here.  Retired ids are reusable by a
 * user's own extension; treating the name alone as ownership would allow the
 * retirement cleanup to delete that unrelated plugin.  Retired copies are
 * removable only when they carry a valid UClaw marker (or another positive
 * ownership proof such as a trusted record/content match).
 */
const ACTIVE_CLAWX_MANAGED_PLUGIN_IDS = new Set([
  'clawx-openai-image',
  'uclaw-artifact-orchestrator',
  'uclaw-local-artifacts',
  'uclaw-blender',
  'uclaw-video',
]);

function isClawXManagedPluginId(pluginDirName: string): boolean {
  return ACTIVE_CLAWX_MANAGED_PLUGIN_IDS.has(pluginDirName);
}

function normalizeComparablePluginPath(filePath: string): string {
  const normalized = path.resolve(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function fingerprintToIntegrity(fingerprint: string): string {
  return `sha256-${Buffer.from(fingerprint, 'hex').toString('base64')}`;
}

type TrustedOfficialPluginInstallRecord = {
  source: 'npm';
  spec: string;
  installPath: string;
  version: string;
  resolvedName: string;
  resolvedVersion: string;
  resolvedSpec: string;
  integrity: string;
  installedAt: string;
};

/** Store plain paths for OpenClaw install-record matching (no Windows \\?\ prefix). */
async function normalizePluginInstallPathForRecord(targetDir: string): Promise<string | null> {
  try {
    const resolved = await realpath(fsPath(targetDir));
    return path.normalize(resolved);
  } catch {
    return path.normalize(targetDir);
  }
}

async function buildTrustedOfficialPluginInstallRecord(
  pluginDirName: string,
  targetDir: string,
): Promise<TrustedOfficialPluginInstallRecord | null> {
  const npmName = TRUSTED_OFFICIAL_EXTENSION_PLUGINS[pluginDirName];
  if (!npmName) return null;

  const [version, installPath, contentFingerprint] = await Promise.all([
    readPluginVersion(join(targetDir, 'package.json')),
    normalizePluginInstallPathForRecord(targetDir),
    readPluginContentFingerprint(targetDir),
  ]);
  if (!version || !installPath || !contentFingerprint) return null;

  return {
    source: 'npm',
    spec: npmName,
    installPath,
    version,
    resolvedName: npmName,
    resolvedVersion: version,
    resolvedSpec: `${npmName}@${version}`,
    integrity: fingerprintToIntegrity(contentFingerprint),
    installedAt: new Date().toISOString(),
  };
}

function persistTrustedOfficialPluginInstallRecordsToSqlite(
  records: Record<string, Record<string, unknown>>,
): boolean {
  return upsertPluginInstallRecordsIntoSqlite(records);
}

async function replaceConfigAtomically(configPath: string, content: string): Promise<void> {
  const directory = path.dirname(configPath);
  const temporaryPath = join(
    directory,
    `.${path.basename(configPath)}.uclaw-plugin-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let published = false;
  await mkdir(fsPath(directory), { recursive: true, mode: 0o700 });
  try {
    handle = await open(fsPath(temporaryPath), 'wx', 0o600);
    await handle.writeFile(content, 'utf-8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    await runWithTransientFsRetry(() => rename(fsPath(temporaryPath), fsPath(configPath)));
    published = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published) await unlink(fsPath(temporaryPath)).catch(() => undefined);
  }
}

function trustedInstallRecordMatches(
  existing: unknown,
  expected: TrustedOfficialPluginInstallRecord,
): boolean {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    return false;
  }
  const record = existing as Record<string, unknown>;
  return record.source === expected.source
    && record.spec === expected.spec
    && record.installPath === expected.installPath
    && record.version === expected.version
    && record.resolvedName === expected.resolvedName
    && record.resolvedVersion === expected.resolvedVersion
    && record.resolvedSpec === expected.resolvedSpec
    && record.integrity === expected.integrity;
}

/**
 * Write or refresh plugins.installs.<id> for a ClawX-mirrored official plugin.
 * Also persists the record into openclaw.sqlite for OpenClaw 2026.6+ trust checks.
 * Safe to call repeatedly; no-ops when metadata is already current.
 */
async function syncTrustedOfficialPluginInstallRecords(
  targets: Array<{ pluginDirName: string; targetDir: string }>,
): Promise<boolean> {
  const expectedRecords: Record<string, TrustedOfficialPluginInstallRecord> = {};
  for (const { pluginDirName, targetDir } of targets) {
    if (!(await pathExists(join(targetDir, 'openclaw.plugin.json')))) continue;
    const ownership = await inspectManagedPluginOwnership(pluginDirName, {
      targetDir,
      candidateSources: buildCandidateSources(pluginDirName),
    });
    if (ownership.status !== 'managed') {
      logger.warn('[plugin] Trusted install metadata was not claimed for an unmanaged plugin', {
        event: 'managed_plugin_ownership',
        pluginId: pluginDirName,
        operation: 'sync-install-record',
        outcome: 'preserved',
        ownership,
      });
      continue;
    }
    const expected = await buildTrustedOfficialPluginInstallRecord(pluginDirName, targetDir);
    if (expected) expectedRecords[pluginDirName] = expected;
  }
  if (Object.keys(expectedRecords).length === 0) return false;

  return withConfigLock(async () => {
    const configPath = resolveOpenClawConfigPath();
    let raw: string;
    try {
      raw = await readFile(fsPath(configPath), 'utf-8');
    } catch (error) {
      if (asErrnoException(error)?.code !== 'ENOENT') {
        logger.warn('[plugin] Failed to read trusted install metadata target', toErrorDiagnostic(error));
      }
      return false;
    }

    let config: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      config = parsed as Record<string, unknown>;
    } catch (error) {
      logger.warn('[plugin] Failed to parse trusted install metadata target', toErrorDiagnostic(error));
      return false;
    }

    let plugins = config.plugins;
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
      plugins = { enabled: true, installs: {} };
      config.plugins = plugins;
    }
    const pluginsRecord = plugins as Record<string, unknown>;
    const installs = pluginsRecord.installs;
    const installsRecord = installs && typeof installs === 'object' && !Array.isArray(installs)
      ? installs as Record<string, unknown>
      : {};

    const changedPluginIds: string[] = [];
    for (const [pluginDirName, expected] of Object.entries(expectedRecords)) {
      if (trustedInstallRecordMatches(installsRecord[pluginDirName], expected)) continue;
      installsRecord[pluginDirName] = expected;
      changedPluginIds.push(pluginDirName);
    }
    pluginsRecord.installs = installsRecord;

    if (changedPluginIds.length > 0) {
      try {
        await replaceConfigAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`);
        logger.info(`[plugin] Synced trusted install metadata for: ${changedPluginIds.join(', ')}`);
      } catch (error) {
        logger.warn('[plugin] Failed to atomically sync trusted install metadata', {
          pluginIds: changedPluginIds,
          ...toErrorDiagnostic(error),
        });
        return false;
      }
    }

    const sqliteChanged = persistTrustedOfficialPluginInstallRecordsToSqlite(expectedRecords);
    return changedPluginIds.length > 0 || sqliteChanged;
  });
}

export async function syncTrustedOfficialPluginInstallRecord(
  pluginDirName: string,
  targetDir: string,
): Promise<boolean> {
  return syncTrustedOfficialPluginInstallRecords([{ pluginDirName, targetDir }]);
}

/** Repair trusted install metadata for all mirrored official plugins on disk. */
export async function repairTrustedOfficialPluginInstallRecords(): Promise<void> {
  await syncTrustedOfficialPluginInstallRecords(
    Object.keys(TRUSTED_OFFICIAL_EXTENSION_PLUGINS).map((pluginDirName) => ({
      pluginDirName,
      targetDir: join(resolveOpenClawStateDir(), 'extensions', pluginDirName),
    })),
  );
}

export async function resolvePluginNpmPackagePath(npmName: string): Promise<string | null> {
  const candidateRoots = app.isPackaged
    ? [app.getAppPath(), process.resourcesPath]
    : [app.getAppPath(), process.cwd(), join(app.getAppPath(), '..')];

  for (const root of candidateRoots) {
    const npmPkgPath = join(root, 'node_modules', ...npmName.split('/'));
    if (await pathExists(join(npmPkgPath, 'openclaw.plugin.json'))) {
      return npmPkgPath;
    }
  }

  return null;
}

async function readPluginVersion(pkgJsonPath: string): Promise<string | null> {
  try {
    const raw = await readFile(fsPath(pkgJsonPath), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

type PluginPackageMetadata = {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  dependencies?: Record<string, unknown>;
  openclaw?: {
    extensions?: string[];
    runtimeExtensions?: string[];
  };
};

type PluginManifestMetadata = {
  id?: string;
  version?: string;
  entry?: string;
};

async function readPluginMetadata(pluginDir: string): Promise<{
  pkg: PluginPackageMetadata;
  manifest: PluginManifestMetadata;
}> {
  const [packageRaw, manifestRaw] = await Promise.all([
    readFile(fsPath(join(pluginDir, 'package.json')), 'utf-8'),
    readFile(fsPath(join(pluginDir, 'openclaw.plugin.json')), 'utf-8'),
  ]);
  const pkg = JSON.parse(packageRaw) as unknown;
  const manifest = JSON.parse(manifestRaw) as unknown;
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new Error('package.json must contain an object');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('openclaw.plugin.json must contain an object');
  }
  return {
    pkg: pkg as PluginPackageMetadata,
    manifest: manifest as PluginManifestMetadata,
  };
}

function getDeclaredPluginEntries(pkg: PluginPackageMetadata, manifest: PluginManifestMetadata): string[] {
  return [...new Set([
    manifest.entry,
    pkg.main,
    pkg.module,
    ...(Array.isArray(pkg.openclaw?.extensions) ? pkg.openclaw.extensions : []),
    ...(Array.isArray(pkg.openclaw?.runtimeExtensions) ? pkg.openclaw.runtimeExtensions : []),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

async function assertPluginPackageReady(
  pluginDir: string,
  pluginDirName: string,
  pluginLabel: string,
): Promise<void> {
  let metadata: Awaited<ReturnType<typeof readPluginMetadata>>;
  try {
    metadata = await readPluginMetadata(pluginDir);
  } catch (error) {
    throw new Error(`${pluginLabel} plugin metadata is invalid: ${toErrorDiagnostic(error).message}`, {
      cause: error,
    });
  }

  const { pkg, manifest } = metadata;
  if (typeof manifest.id !== 'string' || !manifest.id.trim()) {
    throw new Error(`${pluginLabel} plugin manifest id is missing`);
  }
  if (typeof pkg.name !== 'string' || !pkg.name.trim()) {
    throw new Error(`${pluginLabel} plugin package name is missing`);
  }
  if (typeof pkg.version !== 'string' || !pkg.version.trim()) {
    throw new Error(`${pluginLabel} plugin package version is missing`);
  }

  const entries = getDeclaredPluginEntries(pkg, manifest);
  const existingEntries = await Promise.all(entries.map((entry) => isRegularFile(join(pluginDir, entry))));
  if (entries.length === 0 || !existingEntries.some(Boolean)) {
    throw new Error(`${pluginLabel} plugin has no existing declared entrypoint (${entries.join(', ') || 'none'})`);
  }

  // Apply the strict identity contract only to plugins that this build
  // actually bundles and owns.  A user extension is allowed to reuse a
  // `uclaw-*` directory name; the prefix alone must not make it subject to
  // ClawX's package/manifest naming rules.
  if (isClawXManagedPluginId(pluginDirName)) {
    if (manifest.id !== pluginDirName) {
      throw new Error(`${pluginLabel} plugin id mismatch: expected ${pluginDirName}, got ${manifest.id}`);
    }
    if (pkg.name !== pluginDirName && pkg.name !== `${pluginDirName}-plugin`) {
      throw new Error(`${pluginLabel} plugin package name mismatch: ${pkg.name}`);
    }
    if (!manifest.version || manifest.version !== pkg.version) {
      throw new Error(
        `${pluginLabel} plugin version mismatch: package=${pkg.version}, manifest=${String(manifest.version)}`,
      );
    }
    if (!pkg.main || !manifest.entry || pkg.main !== manifest.entry) {
      throw new Error(
        `${pluginLabel} plugin entry mismatch: package.main=${String(pkg.main)}, manifest.entry=${String(manifest.entry)}`,
      );
    }
  }
}

/**
 * Return a deterministic SHA-256 fingerprint for every source-bearing file
 * in a plugin tree (excluding dependency payloads and the ownership marker).
 * Startup maintenance uses this as part of its cache key so a same-size
 * schema/content edit cannot be hidden behind a stale cache hit.
 */
export async function readPluginContentFingerprint(pluginDir: string): Promise<string | null> {
  try {
    // Preserve the old fingerprint contract: a directory is not a plugin
    // identity unless both metadata files are present and valid JSON objects.
    // Besides keeping malformed sources out of the cache, this prevents an
    // empty/partial user directory from being mistaken for a bundled mirror
    // during ownership checks.
    await readPluginMetadata(pluginDir);

    const hash = createHash('sha256');
    // Hash the complete plugin payload, not only package/manifest/entrypoint.
    // Local plugins commonly import sibling modules (for example
    // uclaw-local-artifacts/cad-dxf.mjs and workspace-http-preview.mjs) and
    // ship skills.  Omitting those files lets a same-version stale install
    // survive a source update.  Walk in lexical order and include relative
    // path, node type, byte length, and bytes for deterministic fingerprints.
    const walk = async (absoluteDir: string, relativeDir: string): Promise<void> => {
      const entries = (await readdir(fsPath(absoluteDir), { withFileTypes: true }))
        .filter((entry) => entry.name !== 'node_modules' && entry.name !== '.uclaw-managed-plugin.json')
        .filter((entry) => !isTransientPluginInstallPath(join(relativeDir, entry.name)))
        // Do not use localeCompare here: fingerprints are persisted across
        // launches and must not vary with the host's locale settings.
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

      for (const entry of entries) {
        const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const absolutePath = join(absoluteDir, entry.name);
        const info = await lstat(fsPath(absolutePath));
        if (info.isDirectory()) {
          hash.update(`dir\0${relativePath}\0\n`);
          await walk(absolutePath, relativePath);
        } else if (info.isSymbolicLink()) {
          // Never follow symlinks: this avoids cycles and prevents content
          // outside the plugin directory from affecting its identity.
          const target = await readlink(fsPath(absolutePath));
          const bytes = Buffer.byteLength(target, 'utf8');
          hash.update(`symlink\0${relativePath}\0${bytes}\0${target}\n`);
        } else if (info.isFile()) {
          const bytes = await readFile(fsPath(absolutePath));
          hash.update(`file\0${relativePath}\0${bytes.byteLength}\0`);
          hash.update(bytes);
          hash.update('\n');
        }
      }
    };
    await walk(pluginDir, '');
    return hash.digest('hex');
  } catch {
    return null;
  }
}

async function readPluginRuntimeDependencyNames(pluginDir: string): Promise<string[]> {
  try {
    const raw = await readFile(fsPath(join(pluginDir, 'package.json')), 'utf-8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
    };
    // Optional dependencies are still runtime requirements for a packaged
    // plugin when the plugin imports them conditionally (the bundle and
    // release validators already enforce this same contract). Keep the
    // installer/maintenance check aligned so a missing optional payload cannot
    // leave a stale or partially hydrated plugin active.
    return Object.keys({
      ...(pkg.dependencies || {}),
      ...(pkg.optionalDependencies || {}),
    }).sort();
  } catch {
    return [];
  }
}

function pluginDependencyDir(pluginDir: string, dependencyName: string): string {
  return join(pluginDir, 'node_modules', ...dependencyName.split('/'));
}

export async function findMissingPluginRuntimeDependencies(pluginDir: string): Promise<string[]> {
  const dependencies = await readPluginRuntimeDependencyNames(pluginDir);
  const present = await Promise.all(dependencies.map((dependencyName) => (
    pathExists(join(pluginDependencyDir(pluginDir, dependencyName), 'package.json'))
  )));
  return dependencies.filter((_dependencyName, index) => !present[index]);
}

export async function findBestBundledPluginSource(
  candidateSources: string[],
  _targetDir?: string,
): Promise<string | null> {
  const sourcePresence = await Promise.all(
    candidateSources.map((dir) => pathExists(join(dir, 'openclaw.plugin.json'))),
  );
  const availableSources = candidateSources.filter((_dir, index) => sourcePresence[index]);
  if (availableSources.length === 0) return null;

  // Prefer a structurally valid candidate when multiple packaged locations
  // exist. If every candidate is malformed, retain the first manifest-bearing
  // path so the activation phase can report `bundled-source-invalid` (rather
  // than collapsing the diagnostic into a misleading "missing" result).
  const validSources: string[] = [];
  for (const dir of availableSources) {
    try {
      const { pkg, manifest } = await readPluginMetadata(dir);
      const entries = getDeclaredPluginEntries(pkg, manifest);
      if (entries.length > 0 && (await Promise.all(entries.map((entry) => isRegularFile(join(dir, entry))))).some(Boolean)) {
        validSources.push(dir);
      }
    } catch {
      // Leave malformed candidates in availableSources for diagnostics when
      // no valid fallback exists.
    }
  }
  const sourcesToRank = validSources.length > 0 ? validSources : availableSources;

  let bestSource: { dir: string; mtimeMs: number; missingRuntimeDeps: string[] } | null = null;
  for (const dir of sourcesToRank) {
    let mtimeMs = 0;
    for (const fileName of ['openclaw.plugin.json', 'package.json']) {
      try {
        mtimeMs = Math.max(mtimeMs, (await stat(fsPath(join(dir, fileName)))).mtimeMs);
      } catch {
        // Install validation will report unreadable metadata for the chosen source.
      }
    }

    let entryFiles: unknown[] = [];
    try {
      const raw = await readFile(fsPath(join(dir, 'package.json')), 'utf-8');
      const pkg = JSON.parse(raw) as PluginPackageMetadata;
      entryFiles = [
        pkg.main,
        pkg.module,
        ...(Array.isArray(pkg.openclaw?.extensions) ? pkg.openclaw.extensions : []),
        ...(Array.isArray(pkg.openclaw?.runtimeExtensions) ? pkg.openclaw.runtimeExtensions : []),
      ];
    } catch {
      // Install validation will report unreadable metadata for the chosen source.
    }

    for (const entryFile of entryFiles) {
      if (typeof entryFile !== 'string' || !entryFile.trim()) continue;
      try {
        mtimeMs = Math.max(mtimeMs, (await stat(fsPath(join(dir, entryFile)))).mtimeMs);
      } catch {
        // Install validation will report missing entrypoints for the chosen source.
      }
    }

    const missingRuntimeDeps = await findMissingPluginRuntimeDependencies(dir);
    const isBetterPackagedSource = Boolean(
      bestSource && app.isPackaged && missingRuntimeDeps.length < bestSource.missingRuntimeDeps.length,
    );
    const isNewerEquivalentSource = (
      !bestSource
      || bestSource.missingRuntimeDeps.length === missingRuntimeDeps.length
      || !app.isPackaged
    ) && (!bestSource || mtimeMs > bestSource.mtimeMs);

    if (!bestSource || isBetterPackagedSource || isNewerEquivalentSource) {
      bestSource = { dir, mtimeMs, missingRuntimeDeps };
    }
  }

  return bestSource?.dir ?? availableSources[0] ?? null;
}

// ── pnpm-aware node_modules copy helpers ─────────────────────────────────────

/** Walk up from a path until we find a parent named node_modules. */
function findParentNodeModules(startPath: string): string | null {
  let dir = startPath;
  while (dir !== path.dirname(dir)) {
    if (path.basename(dir) === 'node_modules') return dir;
    dir = path.dirname(dir);
  }
  return null;
}

/** List packages inside a node_modules dir (handles @scoped packages). */
async function listPackagesInDir(nodeModulesDir: string): Promise<Array<{ name: string; fullPath: string }>> {
  const result: Array<{ name: string; fullPath: string }> = [];
  const SKIP = new Set(['.bin', '.package-lock.json', '.modules.yaml', '.pnpm']);
  let entries: Dirent[];
  try {
    entries = await readdir(fsPath(nodeModulesDir), { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (SKIP.has(entry.name)) continue;
    const entryPath = join(nodeModulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      try {
        for (const sub of await readdir(fsPath(entryPath))) {
          result.push({ name: `${entry.name}/${sub}`, fullPath: join(entryPath, sub) });
        }
      } catch { /* ignore */ }
    } else {
      result.push({ name: entry.name, fullPath: entryPath });
    }
  }
  return result;
}

/**
 * Copy a plugin from a pnpm node_modules location, including its
 * transitive runtime dependencies (replicates bundle-openclaw-plugins.mjs
 * logic).
 */
export async function copyPluginFromNodeModules(
  npmPkgPath: string,
  targetDir: string,
  npmName: string,
): Promise<void> {
  let realPath: string;
  try {
    realPath = await realpathSafe(npmPkgPath);
  } catch {
    throw new Error(`Cannot resolve real path for ${npmPkgPath}`);
  }

  // 1. Copy plugin package itself
  await rm(fsPath(targetDir), { recursive: true, force: true });
  await mkdir(fsPath(targetDir), { recursive: true });
  await cpAsyncSafe(realPath, targetDir);

  // 2. Collect transitive deps from pnpm virtual store
  const rootVirtualNM = findParentNodeModules(realPath);
  if (!rootVirtualNM) {
    logger.warn(`[plugin] Cannot find virtual store node_modules for ${npmName}, plugin may lack deps`);
    return;
  }

  // Read peer deps to skip (they're provided by the host gateway)
  const SKIP_PACKAGES = new Set(['typescript', '@playwright/test']);
  try {
    const pluginPkg = JSON.parse(await readFile(fsPath(join(targetDir, 'package.json')), 'utf-8'));
    for (const peer of Object.keys(pluginPkg.peerDependencies || {})) {
      SKIP_PACKAGES.add(peer);
    }
  } catch { /* ignore */ }

  const collected = new Map<string, string>(); // realPath → packageName
  const queue: Array<{ nodeModulesDir: string; skipPkg: string }> = [
    { nodeModulesDir: rootVirtualNM, skipPkg: npmName },
  ];

  while (queue.length > 0) {
    const { nodeModulesDir, skipPkg } = queue.shift()!;
    for (const { name, fullPath } of await listPackagesInDir(nodeModulesDir)) {
      if (name === skipPkg) continue;
      if (SKIP_PACKAGES.has(name) || name.startsWith('@types/')) continue;
      let depRealPath: string;
      try {
        depRealPath = await realpathSafe(fullPath);
      } catch { continue; }
      if (collected.has(depRealPath)) continue;
      collected.set(depRealPath, name);
      const depVirtualNM = findParentNodeModules(depRealPath);
      if (depVirtualNM && depVirtualNM !== nodeModulesDir) {
        queue.push({ nodeModulesDir: depVirtualNM, skipPkg: name });
      }
    }
  }

  // 3. Copy flattened deps into targetDir/node_modules/
  const outputNM = join(targetDir, 'node_modules');
  await mkdir(fsPath(outputNM), { recursive: true });
  const copiedNames = new Set<string>();
  for (const [depRealPath, pkgName] of collected) {
    if (copiedNames.has(pkgName)) continue;
    copiedNames.add(pkgName);
    const dest = join(outputNM, pkgName);
    try {
      await mkdir(fsPath(path.dirname(dest)), { recursive: true });
      await cpAsyncSafe(depRealPath, dest);
    } catch { /* skip individual dep failures */ }
  }

  logger.info(`[plugin] Copied ${copiedNames.size} deps for ${npmName}`);
}

async function copyLocalPluginRuntimeDependenciesFromNodeModules(
  targetDir: string,
  pluginLabel: string,
): Promise<void> {
  const dependencies = await readPluginRuntimeDependencyNames(targetDir);
  if (dependencies.length === 0) return;

  const skipPackages = new Set(['typescript', '@playwright/test']);
  try {
    const pluginPkg = JSON.parse(await readFile(fsPath(join(targetDir, 'package.json')), 'utf-8'));
    for (const peer of Object.keys(pluginPkg.peerDependencies || {})) {
      skipPackages.add(peer);
    }
  } catch {
    // Plugin metadata validation reports malformed package.json separately.
  }

  const collected = new Map<string, string>();
  const queue: Array<{ nodeModulesDir: string; skipPkg: string }> = [];
  for (const depName of dependencies) {
    const dependencyParts = depName.split('/');
    const dependencyCandidates = [
      join(process.cwd(), 'node_modules', ...dependencyParts),
      join(app.getAppPath(), 'node_modules', ...dependencyParts),
      join(__dirname, '../../node_modules', ...dependencyParts),
    ];
    let depPath: string | undefined;
    for (const candidate of dependencyCandidates) {
      if (await pathExists(join(candidate, 'package.json'))) {
        depPath = candidate;
        break;
      }
    }
    if (!depPath) {
      throw new Error(`Missing dependency "${depName}" for ${pluginLabel}. Run pnpm install first.`);
    }

    const realDepPath = await realpathSafe(depPath);
    collected.set(realDepPath, depName);
    const rootVirtualNM = findParentNodeModules(realDepPath);
    if (rootVirtualNM) {
      queue.push({ nodeModulesDir: rootVirtualNM, skipPkg: depName });
    }
  }

  while (queue.length > 0) {
    const { nodeModulesDir, skipPkg } = queue.shift()!;
    for (const { name, fullPath } of await listPackagesInDir(nodeModulesDir)) {
      if (name === skipPkg || skipPackages.has(name) || name.startsWith('@types/')) continue;

      let depRealPath: string;
      try {
        depRealPath = await realpathSafe(fullPath);
      } catch {
        continue;
      }
      if (collected.has(depRealPath)) continue;
      collected.set(depRealPath, name);

      const depVirtualNM = findParentNodeModules(depRealPath);
      if (depVirtualNM && depVirtualNM !== nodeModulesDir) {
        queue.push({ nodeModulesDir: depVirtualNM, skipPkg: name });
      }
    }
  }

  const outputNM = join(targetDir, 'node_modules');
  await mkdir(fsPath(outputNM), { recursive: true });
  const copiedNames = new Set<string>();
  for (const [depRealPath, pkgName] of collected) {
    if (copiedNames.has(pkgName)) continue;
    copiedNames.add(pkgName);
    const dest = join(outputNM, pkgName);
    await mkdir(fsPath(path.dirname(dest)), { recursive: true });
    await cpAsyncSafe(depRealPath, dest);
  }

  logger.info(`[plugin] Hydrated ${copiedNames.size} runtime deps for ${pluginLabel} from root node_modules`);
}

async function ensurePluginRuntimeDependencies(targetDir: string, pluginLabel: string): Promise<string[]> {
  let missingDeps = await findMissingPluginRuntimeDependencies(targetDir);
  if (missingDeps.length === 0) return [];

  if (!app.isPackaged) {
    try {
      await copyLocalPluginRuntimeDependenciesFromNodeModules(targetDir, pluginLabel);
      missingDeps = await findMissingPluginRuntimeDependencies(targetDir);
    } catch (error) {
      logger.warn('[plugin] Failed to hydrate runtime dependencies', {
        pluginLabel,
        targetDir,
        missingDeps,
        platform: process.platform,
        ...toErrorDiagnostic(error),
      });
    }
  }

  return missingDeps;
}

// ── Core install / upgrade logic ─────────────────────────────────────────────

async function prepareAndActivatePlugin(
  targetDir: string,
  pluginDirName: string,
  candidateSources: string[],
  pluginLabel: string,
  prepareStaging: (stagingDir: string) => Promise<void>,
): Promise<void> {
  const nonce = `${process.pid}-${randomUUID()}`;
  const { workRoot, stagingDir, backupDir } = resolvePluginInstallWorkPaths(targetDir, nonce);
  let oldVersionMoved = false;
  let newVersionActivated = false;
  let phase: PluginInstallPhase = 'staging-setup';

  // Keep incomplete trees outside extensions so OpenClaw never scans a partial install.
  try {
    await mkdir(fsPath(path.dirname(targetDir)), { recursive: true });
    await mkdir(fsPath(workRoot), { recursive: true });
    await Promise.all([
      rm(fsPath(stagingDir), { recursive: true, force: true }),
      rm(fsPath(backupDir), { recursive: true, force: true }),
    ]);

    phase = 'staging-copy';
    await prepareStaging(stagingDir);
    phase = 'validation';
    const [hasManifest, hasPackageJson] = await Promise.all([
      pathExists(join(stagingDir, 'openclaw.plugin.json')),
      pathExists(join(stagingDir, 'package.json')),
    ]);
    if (!hasManifest) {
      throw new Error(`Failed to stage ${pluginLabel} plugin mirror (manifest missing).`);
    }
    if (!hasPackageJson) {
      throw new Error(`Failed to stage ${pluginLabel} plugin mirror (package.json missing).`);
    }
    await fixupPluginManifest(stagingDir);
    await assertPluginPackageReady(stagingDir, path.basename(targetDir), pluginLabel);
    phase = 'dependency-hydration';
    const missingRuntimeDeps = await ensurePluginRuntimeDependencies(stagingDir, pluginLabel);
    if (missingRuntimeDeps.length > 0) {
      throw new Error(
        `Failed to stage ${pluginLabel} plugin mirror (runtime dependencies missing: ${missingRuntimeDeps.join(', ')})`,
      );
    }
    await writeManagedPluginMarker(stagingDir, pluginDirName);

    phase = 'activation';
    const activationOwnership = await inspectManagedPluginOwnership(pluginDirName, {
      targetDir,
      candidateSources,
    });
    if (activationOwnership.status === 'managed') {
      await runWithTransientFsRetry(() => rename(fsPath(targetDir), fsPath(backupDir)));
      oldVersionMoved = true;
    } else if (activationOwnership.status !== 'absent') {
      throw new PluginOwnershipConflictError(activationOwnership);
    }
    await runWithTransientFsRetry(() => rename(fsPath(stagingDir), fsPath(targetDir)));
    newVersionActivated = true;

    if (oldVersionMoved) {
      try {
        await runWithTransientFsRetry(() => rm(fsPath(backupDir), { recursive: true, force: true }));
        oldVersionMoved = false;
      } catch (error) {
        logger.warn(`[plugin] ${pluginLabel} upgraded but its backup could not be removed`, {
          backupDir,
          ...toErrorDiagnostic(error),
        });
      }
    }
  } catch (error) {
    const installError = asPluginInstallPhaseError(error, phase, pluginLabel);
    const [targetExists, backupExists] = await Promise.all([
      pathExists(targetDir),
      pathExists(backupDir),
    ]);
    if (!newVersionActivated && oldVersionMoved && !targetExists && backupExists) {
      try {
        await runWithTransientFsRetry(() => rename(fsPath(backupDir), fsPath(targetDir)));
        oldVersionMoved = false;
      } catch (rollbackError) {
        logger.error(`[plugin] Failed to roll back ${pluginLabel} after install failure`, {
          backupDir,
          targetDir,
          ...toErrorDiagnostic(asPluginInstallPhaseError(rollbackError, 'rollback', pluginLabel)),
        });
      }
    }
    throw installError;
  } finally {
    try {
      await runWithTransientFsRetry(() => rm(fsPath(stagingDir), { recursive: true, force: true }));
    } catch {
      // A unique staging directory can be cleaned at the next launch.
    }
    if (!oldVersionMoved && await pathExists(backupDir)) {
      try {
        await runWithTransientFsRetry(() => rm(fsPath(backupDir), { recursive: true, force: true }));
      } catch {
        // Preserve the active target if backup cleanup is temporarily blocked.
      }
    }
  }
}

/**
 * Options used by both the UI/channel install path and the Gateway startup
 * maintenance path.  Startup sets `requireBundledSource` so a missing or
 * malformed bundled mirror cannot silently leave an old plugin active.
 */
export type PluginInstallOptions = {
  deferTrustedRecordSync?: boolean;
  requireBundledSource?: boolean;
};
const pluginInstallTails = new Map<string, Promise<void>>();

function normalizePluginInstallLockKey(targetDir: string): string {
  const resolved = path.resolve(targetDir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function withPluginInstallLock<T>(targetDir: string, operation: () => Promise<T>): Promise<T> {
  const key = normalizePluginInstallLockKey(targetDir);
  const previous = pluginInstallTails.get(key) ?? Promise.resolve();
  const ready = previous.catch(() => undefined);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = ready.then(() => current);
  pluginInstallTails.set(key, tail);

  await ready;
  try {
    return await operation();
  } finally {
    release();
    if (pluginInstallTails.get(key) === tail) pluginInstallTails.delete(key);
  }
}

function ownershipConflictInstallResult(
  pluginDirName: string,
  pluginLabel: string,
  ownership: ManagedPluginOwnership,
): PluginInstallResult {
  logManagedPluginPreservation(pluginDirName, 'install-or-upgrade', ownership);
  return {
    installed: false,
    code: 'managed-plugin-ownership-conflict',
    action: 'preserved',
    ownership,
    warning: `${pluginLabel} plugin was preserved because UClaw ownership was not proven`,
  };
}

function findOwnershipConflict(error: unknown): PluginOwnershipConflictError | null {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current instanceof PluginOwnershipConflictError) return current;
    current = 'cause' in current ? current.cause : null;
  }
  return null;
}

type ManagedMarkerReadResult =
  | { status: 'missing' }
  | { status: 'valid'; marker: ManagedPluginMarker }
  | { status: 'invalid' };

async function readManagedPluginMarker(
  pluginDir: string,
  pluginDirName: string,
): Promise<ManagedMarkerReadResult> {
  const markerPath = join(pluginDir, UCLAW_MANAGED_PLUGIN_MARKER_FILENAME);
  let raw: string;
  try {
    raw = await readFile(fsPath(markerPath), 'utf-8');
  } catch (error) {
    return asErrnoException(error)?.code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'invalid' };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ManagedPluginMarker>;
    if (
      !parsed
      || typeof parsed !== 'object'
      || parsed.schemaVersion !== UCLAW_MANAGED_PLUGIN_MARKER_VERSION
      || parsed.managedBy !== 'uclaw'
      || parsed.pluginId !== pluginDirName
      || typeof parsed.contentFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/u.test(parsed.contentFingerprint)
      || typeof parsed.installedAt !== 'string'
      || !parsed.installedAt.trim()
    ) {
      return { status: 'invalid' };
    }
    return { status: 'valid', marker: parsed as ManagedPluginMarker };
  } catch {
    return { status: 'invalid' };
  }
}

async function writeManagedPluginMarker(pluginDir: string, pluginDirName: string): Promise<void> {
  const contentFingerprint = await readPluginContentFingerprint(pluginDir);
  if (!contentFingerprint) {
    throw new Error(`Cannot establish managed ownership for ${pluginDirName}: content fingerprint unavailable`);
  }
  const marker: ManagedPluginMarker = {
    schemaVersion: UCLAW_MANAGED_PLUGIN_MARKER_VERSION,
    managedBy: 'uclaw',
    pluginId: pluginDirName,
    contentFingerprint,
    installedAt: new Date().toISOString(),
  };
  await writeFile(
    fsPath(join(pluginDir, UCLAW_MANAGED_PLUGIN_MARKER_FILENAME)),
    `${JSON.stringify(marker, null, 2)}\n`,
    { encoding: 'utf-8', mode: 0o600 },
  );
}

type ConfiguredInstallRecordReadResult =
  | { status: 'missing' }
  | { status: 'found'; record: Record<string, unknown> }
  | { status: 'invalid' };

async function readConfiguredPluginInstallRecord(
  pluginDirName: string,
): Promise<ConfiguredInstallRecordReadResult> {
  let raw: string;
  try {
    raw = await readFile(fsPath(resolveOpenClawConfigPath()), 'utf-8');
  } catch (error) {
    return asErrnoException(error)?.code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'invalid' };
  }

  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'invalid' };
    config = parsed as Record<string, unknown>;
  } catch {
    return { status: 'invalid' };
  }

  if (config.plugins === undefined) return { status: 'missing' };
  if (!config.plugins || typeof config.plugins !== 'object' || Array.isArray(config.plugins)) {
    return { status: 'invalid' };
  }
  const installs = (config.plugins as Record<string, unknown>).installs;
  if (installs === undefined) return { status: 'missing' };
  if (!installs || typeof installs !== 'object' || Array.isArray(installs)) {
    return { status: 'invalid' };
  }
  const record = (installs as Record<string, unknown>)[pluginDirName];
  if (record === undefined) return { status: 'missing' };
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { status: 'invalid' };
  return { status: 'found', record: record as Record<string, unknown> };
}

async function trustedInstallRecordOwnsTarget(
  pluginDirName: string,
  targetDir: string,
  record: Record<string, unknown>,
): Promise<boolean> {
  const expected = await buildTrustedOfficialPluginInstallRecord(pluginDirName, targetDir);
  if (!expected || !trustedInstallRecordMatches(record, expected)) return false;

  const recordedPath = typeof record.installPath === 'string' ? record.installPath : '';
  if (!recordedPath || !path.isAbsolute(recordedPath)) return false;
  const targetPaths = new Set([normalizeComparablePluginPath(targetDir)]);
  try {
    targetPaths.add(normalizeComparablePluginPath(await realpathSafe(targetDir)));
  } catch {
    // The metadata and content checks below remain authoritative.
  }
  return targetPaths.has(normalizeComparablePluginPath(recordedPath));
}

/**
 * Resolve whether UClaw may mutate a plugin directory. Any ambiguous state is
 * deliberately non-destructive: a same-name extension is user-owned until
 * positive UClaw ownership evidence is available.
 */
export async function inspectManagedPluginOwnership(
  pluginDirName: string,
  options: ManagedPluginOwnershipOptions = {},
): Promise<ManagedPluginOwnership> {
  const targetDir = options.targetDir ?? join(getOpenClawExtensionsDir(), pluginDirName);
  let targetInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    targetInfo = await lstat(fsPath(targetDir));
  } catch (error) {
    if (asErrnoException(error)?.code === 'ENOENT') {
      return { status: 'absent', evidence: 'none', code: 'target_absent' };
    }
    return { status: 'indeterminate', evidence: 'state-read-failed', code: 'target_inspection_failed' };
  }

  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
    return { status: 'indeterminate', evidence: 'state-read-failed', code: 'target_type_unsafe' };
  }

  const markerResult = await readManagedPluginMarker(targetDir, pluginDirName);
  if (markerResult.status === 'invalid') {
    return { status: 'indeterminate', evidence: 'invalid-marker', code: 'managed_marker_invalid' };
  }
  if (markerResult.status === 'valid') {
    const currentFingerprint = await readPluginContentFingerprint(targetDir);
    return {
      status: 'managed',
      evidence: 'managed-marker',
      code: 'managed_marker_valid',
      contentModified: currentFingerprint !== null
        && currentFingerprint !== markerResult.marker.contentFingerprint,
    };
  }

  if (isClawXManagedPluginId(pluginDirName)) {
    return {
      status: 'managed',
      evidence: 'clawx-managed-plugin-id',
      code: 'clawx_managed_plugin_id',
    };
  }

  const configuredRecord = await readConfiguredPluginInstallRecord(pluginDirName);
  if (configuredRecord.status === 'invalid') {
    return { status: 'indeterminate', evidence: 'state-read-failed', code: 'install_record_state_invalid' };
  }
  if (
    configuredRecord.status === 'found'
    && await trustedInstallRecordOwnsTarget(pluginDirName, targetDir, configuredRecord.record)
  ) {
    return { status: 'managed', evidence: 'trusted-install-record', code: 'trusted_install_record_valid' };
  }

  const targetFingerprint = await readPluginContentFingerprint(targetDir);
  if (targetFingerprint) {
    for (const sourceDir of options.candidateSources ?? []) {
      try {
        const sourceInfo = await lstat(fsPath(sourceDir));
        if (!sourceInfo.isDirectory()) continue;
      } catch (error) {
        if (asErrnoException(error)?.code === 'ENOENT') continue;
        return { status: 'indeterminate', evidence: 'state-read-failed', code: 'source_inspection_failed' };
      }
      const sourceFingerprint = await readPluginContentFingerprint(sourceDir);
      if (!sourceFingerprint) {
        return { status: 'indeterminate', evidence: 'state-read-failed', code: 'source_fingerprint_failed' };
      }
      if (sourceFingerprint === targetFingerprint) {
        return { status: 'managed', evidence: 'bundled-content-match', code: 'bundled_content_match' };
      }
    }
  }

  return {
    status: 'user-owned-or-unknown',
    evidence: 'none',
    code: configuredRecord.status === 'found' ? 'install_record_not_uclaw_owned' : 'ownership_not_proven',
  };
}

function logManagedPluginPreservation(
  pluginDirName: string,
  operation: string,
  ownership: ManagedPluginOwnership,
): void {
  logger.warn('[plugin] Preserved same-name plugin because UClaw ownership was not proven', {
    event: 'managed_plugin_ownership',
    pluginId: pluginDirName,
    operation,
    outcome: 'preserved',
    ownership,
  });
}

export async function removeManagedPluginInstall(
  pluginDirName: string,
  options: ManagedPluginOwnershipOptions & { operation?: string } = {},
): Promise<ManagedPluginRemovalResult> {
  const targetDir = options.targetDir ?? join(getOpenClawExtensionsDir(), pluginDirName);
  return withPluginInstallLock(targetDir, async () => {
    const ownership = await inspectManagedPluginOwnership(pluginDirName, options);
    if (ownership.status === 'absent') {
      return { removed: false, preserved: false, code: 'absent', ownership };
    }
    if (ownership.status !== 'managed') {
      logManagedPluginPreservation(pluginDirName, options.operation ?? 'remove', ownership);
      return {
        removed: false,
        preserved: true,
        code: 'ownership-conflict',
        ownership,
        warning: `Preserved ${pluginDirName}: UClaw ownership was not proven`,
      };
    }

    try {
      await runWithTransientFsRetry(() => rm(fsPath(targetDir), { recursive: true, force: true }));
      return { removed: true, preserved: false, code: 'removed', ownership };
    } catch (error) {
      const warning = `Failed to remove UClaw-managed plugin ${pluginDirName}`;
      logger.warn('[plugin] Managed plugin removal failed', {
        event: 'managed_plugin_ownership',
        pluginId: pluginDirName,
        operation: options.operation ?? 'remove',
        outcome: 'failed',
        ownership,
        ...toErrorDiagnostic(error),
      });
      return { removed: false, preserved: true, code: 'remove-failed', ownership, warning };
    }
  });
}

export async function ensurePluginInstalled(
  pluginDirName: string,
  candidateSources: string[],
  pluginLabel: string,
  options: PluginInstallOptions = {},
): Promise<PluginInstallResult> {
  const targetDir = join(getOpenClawExtensionsDir(), pluginDirName);
  return withPluginInstallLock(targetDir, () => ensurePluginInstalledUnlocked(
    pluginDirName,
    candidateSources,
    pluginLabel,
    options,
    targetDir,
  ));
}

async function ensurePluginInstalledUnlocked(
  pluginDirName: string,
  candidateSources: string[],
  pluginLabel: string,
  options: PluginInstallOptions,
  targetDir: string,
): Promise<PluginInstallResult> {
  const targetManifest = join(targetDir, 'openclaw.plugin.json');
  const targetPkgJson = join(targetDir, 'package.json');
  const requireBundledSource = options.requireBundledSource === true;
  const syncTrustedRecord = async (): Promise<void> => {
    if (!options.deferTrustedRecordSync) {
      await syncTrustedOfficialPluginInstallRecord(pluginDirName, targetDir);
    }
  };

  const finalizeInstalled = async (): Promise<PluginInstallResult> => {
    const marker = await readManagedPluginMarker(targetDir, pluginDirName);
    if (marker.status === 'invalid') {
      const ownership: ManagedPluginOwnership = {
        status: 'indeterminate',
        evidence: 'invalid-marker',
        code: 'managed_marker_invalid',
      };
      return ownershipConflictInstallResult(pluginDirName, pluginLabel, ownership);
    }
    if (marker.status === 'missing') {
      try {
        await writeManagedPluginMarker(targetDir, pluginDirName);
      } catch (error) {
        logger.warn('[plugin] Installed plugin could not be marked as UClaw-managed', {
          event: 'managed_plugin_ownership',
          pluginId: pluginDirName,
          operation: 'write-managed-marker',
          outcome: 'failed',
          ...toErrorDiagnostic(error),
        });
        return {
          installed: true,
          warning: `${pluginLabel} is installed, but its UClaw ownership marker could not be written`,
        };
      }
    }
    await syncTrustedRecord();
    return { installed: true };
  };

  const sourceDir = await findBestBundledPluginSource(candidateSources, targetDir);
  // In a packaged runtime, a missing mirror is itself a compatibility failure.
  // Classify it before ownership inspection so a markerless legacy copy is not
  // mislabeled as a user-owned conflict and quietly retained by callers.
  if (!sourceDir && requireBundledSource && app.isPackaged) {
    return {
      installed: false,
      repairRequired: true,
      code: 'bundled-source-missing',
      warning: `${pluginLabel} plugin bundled mirror/source is missing; repair/reinstall this UClaw package before starting Gateway. Checked: ${candidateSources.join(' | ')}`,
    };
  }
  const ownership = await inspectManagedPluginOwnership(pluginDirName, {
    targetDir,
    // Keep every candidate in the ownership probe. A markerless official
    // plugin may have been installed from a fallback mirror (for example an
    // unpacked resources path) while the ranking logic selects a newer copy
    // from the primary path. Restricting the probe to only the selected source
    // would incorrectly classify that existing managed copy as user-owned and
    // refuse a legitimate upgrade.
    candidateSources,
  });
  if (ownership.status !== 'absent' && ownership.status !== 'managed') {
    // UClaw-owned local plugins are part of the bundled application contract.
    // In strict packaged startup mode an invalid marker/indeterminate target
    // cannot be treated as an ordinary user-owned extension: doing so would
    // silently keep a potentially incompatible stale copy alive. Preserve the
    // bytes for explicit repair, but stop Gateway admission until the package
    // is repaired or reinstalled.
    if (requireBundledSource && app.isPackaged && isClawXManagedPluginId(pluginDirName)) {
      return {
        installed: false,
        repairRequired: true,
        code: 'bundled-source-invalid',
        ownership,
        warning: `${pluginLabel} plugin ownership state is invalid; repair/reinstall this UClaw package before starting Gateway`,
      };
    }
    return ownershipConflictInstallResult(pluginDirName, pluginLabel, ownership);
  }
  const targetHasManifest = await pathExists(targetManifest);

  // If already installed, check whether an upgrade is available
  if (targetHasManifest) {
    let installedPackageReady = true;
    try {
      await assertPluginPackageReady(targetDir, pluginDirName, pluginLabel);
    } catch (error) {
      installedPackageReady = false;
      logger.info(`[plugin] Refreshing ${pluginLabel} plugin: ${toErrorDiagnostic(error).message}`);
    }

    if (!sourceDir && app.isPackaged) {
      const [installedVersion, missingRuntimeDeps] = await Promise.all([
        readPluginVersion(targetPkgJson),
        findMissingPluginRuntimeDependencies(targetDir),
      ]);
      // A packaged Gateway must never keep running an old extension merely
      // because the newly bundled mirror disappeared from the app bundle.
      // This is deliberately checked even when the installed copy looks
      // healthy: a source-less copy cannot be compared for schema/content
      // compatibility and may be the exact stale plugin that broke startup.
      if (requireBundledSource) {
        return {
          installed: false,
          repairRequired: true,
          code: 'bundled-source-missing',
          warning: `${pluginLabel} plugin bundled mirror/source is missing; repair/reinstall this UClaw package before starting Gateway. Checked: ${candidateSources.join(' | ')}`,
        };
      }
      if (installedPackageReady && installedVersion && missingRuntimeDeps.length === 0) {
        return finalizeInstalled();
      }
      return {
        installed: false,
        warning: `${pluginLabel} plugin metadata or runtime dependencies are incomplete and no bundled repair source is available${missingRuntimeDeps.length > 0 ? `: ${missingRuntimeDeps.join(', ')}` : ''}`,
      };
    }

    if (!sourceDir) {
      // In strict startup mode keep looking for the dev/node_modules source
      // below.  Returning the installed copy here would bypass that repair
      // path and silently accept stale content in an un-packaged launch.
      if (!requireBundledSource) return finalizeInstalled();
    } else {
      const [installedVersion, sourceVersion] = await Promise.all([
        readPluginVersion(targetPkgJson),
        readPluginVersion(join(sourceDir, 'package.json')),
      ]);
      if (!sourceVersion || !installedVersion) {
        logger.info(`[plugin] Refreshing ${pluginLabel} plugin: package metadata is missing or unreadable`);
      } else if (sourceVersion !== installedVersion) {
        logger.info(
          `[plugin] Upgrading ${pluginLabel} plugin: ${installedVersion} → ${sourceVersion}`,
        );
      } else {
        const [installedFingerprint, sourceFingerprint, missingRuntimeDeps] = await Promise.all([
          readPluginContentFingerprint(targetDir),
          readPluginContentFingerprint(sourceDir),
          findMissingPluginRuntimeDependencies(targetDir),
        ]);
        if (
          installedPackageReady
          && missingRuntimeDeps.length === 0
          && installedFingerprint
          && sourceFingerprint
          && installedFingerprint === sourceFingerprint
        ) {
          return finalizeInstalled();
        }
        if (missingRuntimeDeps.length > 0) {
          logger.info(
            `[plugin] Refreshing ${pluginLabel} plugin: runtime dependencies missing (${missingRuntimeDeps.join(', ')})`,
          );
        } else {
          logger.info(`[plugin] Refreshing ${pluginLabel} plugin: bundled content changed without version bump`);
        }
      }
    }
  }

  // Fresh install or upgrade — try bundled/build sources first
  if (sourceDir) {
    const attempts: Array<{
      attempt: number;
      code?: string;
      name?: string;
      phase?: PluginInstallPhase;
      message: string;
    }> = [];
    const maxAttempts = process.platform === 'win32' ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await prepareAndActivatePlugin(targetDir, pluginDirName, [sourceDir], pluginLabel, async (stagingDir) => {
          await cpAsyncSafe(sourceDir, stagingDir);
        });
        const result = await finalizeInstalled();
        logger.info(`Installed ${pluginLabel} plugin from bundled mirror: ${sourceDir}`);
        return result;
      } catch (error) {
        const conflict = findOwnershipConflict(error);
        if (conflict) {
          return ownershipConflictInstallResult(pluginDirName, pluginLabel, conflict.ownership);
        }
        const diagnostic = toErrorDiagnostic(error);
        attempts.push({ attempt, ...diagnostic });
        if (attempt < maxAttempts) await delay(150 * attempt);
      }
    }

    logger.warn(
      `[plugin] Bundled mirror install failed for ${pluginLabel}`,
      {
        pluginDirName,
        pluginLabel,
        sourceDir,
        targetDir,
        platform: process.platform,
        attempts,
      },
    );

    return {
      installed: false,
      ...(requireBundledSource ? {
        repairRequired: true,
        code: 'bundled-source-invalid' as const,
      } : {}),
      warning: `Failed to install bundled ${pluginLabel} plugin mirror`,
    };
  }

  // Dev mode fallback: copy from node_modules with pnpm-aware dep resolution
  if (!app.isPackaged) {
    const npmName = PLUGIN_NPM_NAMES[pluginDirName];
    if (npmName) {
      const npmPkgPath = await resolvePluginNpmPackagePath(npmName);
      if (npmPkgPath && await pathExists(join(npmPkgPath, 'openclaw.plugin.json'))) {
        const targetManifestStillExists = await pathExists(targetManifest);
        const [installedVersion, sourceVersion, installedFingerprint, sourceFingerprint, missingRuntimeDeps] = await Promise.all([
          targetManifestStillExists ? readPluginVersion(targetPkgJson) : Promise.resolve(null),
          readPluginVersion(join(npmPkgPath, 'package.json')),
          targetManifestStillExists ? readPluginContentFingerprint(targetDir) : Promise.resolve(null),
          readPluginContentFingerprint(npmPkgPath),
          targetManifestStillExists ? findMissingPluginRuntimeDependencies(targetDir) : Promise.resolve([]),
        ]);
        const needsRefresh = !targetManifestStillExists
          || !sourceVersion
          || !installedVersion
          || sourceVersion !== installedVersion
          || missingRuntimeDeps.length > 0
          || !installedFingerprint
          || !sourceFingerprint
          || installedFingerprint !== sourceFingerprint;

        if (needsRefresh) {
          logger.info(
            `[plugin] ${installedVersion ? 'Upgrading' : 'Installing'} ${pluginLabel} plugin` +
            `${installedVersion ? `: ${installedVersion} → ${sourceVersion}` : `: ${sourceVersion}`} (dev/node_modules)`,
          );
          try {
            await prepareAndActivatePlugin(targetDir, pluginDirName, [npmPkgPath], pluginLabel, async (stagingDir) => {
              await copyPluginFromNodeModules(npmPkgPath, stagingDir, npmName);
            });
            if (await pathExists(join(targetDir, 'openclaw.plugin.json'))) {
              return finalizeInstalled();
            }
          } catch (err) {
            const conflict = findOwnershipConflict(err);
            if (conflict) {
              return ownershipConflictInstallResult(pluginDirName, pluginLabel, conflict.ownership);
            }
            logger.warn(
              `[plugin] Failed to install ${pluginLabel} plugin from node_modules`,
              {
                pluginDirName,
                pluginLabel,
                npmName,
                npmPkgPath,
                targetDir,
                platform: process.platform,
                ...toErrorDiagnostic(err),
              },
            );
          }
        } else {
          return finalizeInstalled();
        }
      }
    }
  }

  return {
    installed: false,
    ...(requireBundledSource ? {
      repairRequired: true,
      code: 'bundled-source-missing' as const,
    } : {}),
    warning: `Bundled ${pluginLabel} plugin mirror not found. Checked: ${candidateSources.join(' | ')}`,
  };
}

// ── Candidate source path builder ────────────────────────────────────────────

export function buildCandidateSources(pluginDirName: string): string[] {
  const resourcesPath = process.resourcesPath || app.getAppPath();
  return app.isPackaged
    ? [
      join(resourcesPath, 'openclaw-plugins', pluginDirName),
      join(resourcesPath, 'resources', 'openclaw-plugins', pluginDirName),
      join(resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', pluginDirName),
      join(resourcesPath, 'app.asar.unpacked', 'resources', 'openclaw-plugins', pluginDirName),
      join(resourcesPath, 'app.asar.unpacked', 'openclaw-plugins', pluginDirName),
    ]
    : [
      join(app.getAppPath(), 'build', 'openclaw-plugins', pluginDirName),
      join(app.getAppPath(), 'resources', 'openclaw-plugins', pluginDirName),
      join(process.cwd(), 'build', 'openclaw-plugins', pluginDirName),
      join(process.cwd(), 'resources', 'openclaw-plugins', pluginDirName),
      join(__dirname, '../../build/openclaw-plugins', pluginDirName),
      join(__dirname, '../../resources/openclaw-plugins', pluginDirName),
    ];
}

// ── Per-channel plugin helpers ───────────────────────────────────────────────

export function ensureDingTalkPluginInstalled(
  options: PluginInstallOptions = {},
): Promise<PluginInstallResult> {
  return ensurePluginInstalled('dingtalk', buildCandidateSources('dingtalk'), 'DingTalk', options);
}

export function ensureWeComPluginInstalled(
  options: PluginInstallOptions = {},
): Promise<PluginInstallResult> {
  return ensurePluginInstalled('wecom', buildCandidateSources('wecom'), 'WeCom', options);
}

export function ensureFeishuPluginInstalled(
  options: PluginInstallOptions = {},
): Promise<PluginInstallResult> {
  return ensurePluginInstalled(
    'feishu-openclaw-plugin',
    buildCandidateSources('feishu-openclaw-plugin'),
    'Feishu',
    options,
  );
}



export function ensureWeChatPluginInstalled(
  options: PluginInstallOptions = {},
): Promise<PluginInstallResult> {
  return ensurePluginInstalled('openclaw-weixin', buildCandidateSources('openclaw-weixin'), 'WeChat', options);
}

export function ensureDiscordPluginInstalled(
  options: PluginInstallOptions = {},
): Promise<PluginInstallResult> {
  return ensurePluginInstalled('discord', buildCandidateSources('discord'), 'Discord', options);
}

export function ensureQQBotPluginInstalled(
  options: PluginInstallOptions = {},
): Promise<PluginInstallResult> {
  return ensurePluginInstalled('qqbot', buildCandidateSources('qqbot'), 'QQBot', options);
}

export function ensureWhatsAppPluginInstalled(
  options: PluginInstallOptions = {},
): Promise<PluginInstallResult> {
  return ensurePluginInstalled('whatsapp', buildCandidateSources('whatsapp'), 'WhatsApp', options);
}

export function ensureClawXOpenAiImagePluginInstalled(
  options: PluginInstallOptions = {},
): Promise<PluginInstallResult> {
  return ensurePluginInstalled(
    'clawx-openai-image',
    buildCandidateSources('clawx-openai-image'),
    'UClaw OpenAI Image',
    options,
  );
}

export function ensureParallelPluginInstalled(
  options: PluginInstallOptions = {},
): Promise<PluginInstallResult> {
  return ensurePluginInstalled(
    'parallel',
    buildCandidateSources('parallel'),
    'Parallel Search',
    options,
  );
}

// ── Bulk startup installer ───────────────────────────────────────────────────

/**
 * All bundled plugins, in the same order as after-pack.cjs BUNDLED_PLUGINS.
 */
const ALL_BUNDLED_PLUGINS = [
  { fn: ensureDingTalkPluginInstalled, label: 'DingTalk' },
  { fn: ensureWeComPluginInstalled, label: 'WeCom' },

  { fn: ensureFeishuPluginInstalled, label: 'Feishu' },
  { fn: ensureWeChatPluginInstalled, label: 'WeChat' },
  { fn: ensureDiscordPluginInstalled, label: 'Discord' },
  { fn: ensureQQBotPluginInstalled, label: 'QQBot' },
  { fn: ensureWhatsAppPluginInstalled, label: 'WhatsApp' },
  { fn: ensureParallelPluginInstalled, label: 'Parallel Search' },
  { fn: ensureClawXOpenAiImagePluginInstalled, label: 'UClaw OpenAI Image' },
] as const;

/**
 * Ensure all bundled OpenClaw plugins are installed/upgraded in
 * `~/.openclaw/extensions/`.  Designed to be called once at app startup
 * as a fire-and-forget task — errors are logged but never thrown.
 */
export async function ensureAllBundledPluginsInstalled(): Promise<void> {
  for (const { fn, label } of ALL_BUNDLED_PLUGINS) {
    try {
      const result = await fn({ deferTrustedRecordSync: true });
      if (result.warning) {
        logger.warn(`[plugin] ${label}: ${result.warning}`);
      }
    } catch (error) {
      logger.warn(`[plugin] Failed to install/upgrade ${label} plugin:`, error);
    }
  }
  await repairTrustedOfficialPluginInstallRecords();
}
