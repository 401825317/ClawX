import { app } from 'electron';
import path from 'path';
import { existsSync, type Dirent } from 'fs';
import { lstat, mkdir, readdir, readFile, symlink } from 'fs/promises';
import { join } from 'path';

function fsPath(filePath: string): string {
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
import { getAllSettings } from '../utils/store';
import { getApiKey, getDefaultProvider, getProvider } from '../utils/secure-storage';
import { getProviderEnvVar, getKeyableProviderTypes } from '../utils/provider-registry';
import {
  getOpenClawConfigDir,
  getOpenClawDir,
  getOpenClawEntryPath,
  getOpenClawResolvedDir,
  getOpenClawSkillsDir,
  isOpenClawPresent,
} from '../utils/paths';
import { getUvMirrorEnv } from '../utils/uv-env';
import { captureChannelStartupSnapshot, readOpenClawConfig } from '../utils/channel-config';
import {
  REQUIRED_UCLAW_RUNTIME_PLUGIN_IDS,
  sanitizeOpenClawConfig,
  batchSyncConfigFields,
} from '../utils/openclaw-auth';
import { buildProxyEnv, resolveProxySettings } from '../utils/proxy';
import { syncProxyConfigToOpenClaw } from '../utils/openclaw-proxy';
import { logger } from '../utils/logger';
import { prependPathEntry } from '../utils/env-path';
import {
  buildCandidateSources,
  cleanupStalePluginInstallArtifacts,
  ensureParallelPluginInstalled,
  ensurePluginInstalled,
  findBestBundledPluginSource,
  findMissingPluginRuntimeDependencies,
  removeManagedPluginInstall,
  repairTrustedOfficialPluginInstallRecords,
} from '../utils/plugin-install';
import { CLAWX_OPENAI_IMAGE_PROVIDER_KEY } from '../utils/openclaw-image-relay-constants';
import { UCLAW_VIDEO_PROVIDER_ID } from '../../shared/junfeiai-endpoints';
import {
  getUclawBackendOrigin,
  isUclawManagedDistribution,
  UCLAW_AUTH_ACCOUNT_ID,
  UCLAW_COMPATIBILITY_PROVIDER_ID,
  UCLAW_PROVIDER_ID,
} from '../utils/junfeiai-distribution';
import { getUclawDiagnosticHeaders } from '../utils/uclaw-request-diagnostics';
import { getProviderAccount } from '../services/providers/provider-store';
import {
  isUclawManagedAccount,
  resolveValidUclawManagedRelayPairToken,
  withProviderMutationLock,
} from '../services/providers/provider-mutation-lock';
import { getProviderSecret } from '../services/secrets/secret-store';
import { getBlenderBridgeEnvironment } from '../services/blender/bridge-server';
import {
  buildManagedOpenAiProviderEnv,
  shouldInjectProviderEnv,
  stripManagedProviderEnv,
  stripSystemdSupervisorEnv,
} from './config-sync-env';
import { cleanupAgentsSymlinkedSkills, cleanupStalePluginRuntimeDeps } from './skills-symlink-cleanup';
import {
  buildPrelaunchMaintenanceCacheKey,
  type PrelaunchMaintenanceRunResult,
  type PrelaunchMaintenanceTaskName,
} from './prelaunch-maintenance-cache';
import {
  type AsyncPrelaunchMaintenanceTaskName,
  directoryChildrenSignatureAsync,
  directoryTreeSignatureAsync,
  pathSignatureAsync,
  runCachedPrelaunchMaintenanceTaskAsync,
  scheduleCachedPrelaunchMaintenanceTaskAsync,
} from './async-prelaunch-maintenance-cache';
import { runPrelaunchPhase } from './prelaunch-liveness';


export interface GatewayLaunchContext {
  appSettings: Awaited<ReturnType<typeof getAllSettings>>;
  openclawDir: string;
  entryScript: string;
  gatewayArgs: string[];
  forkEnv: Record<string, string | undefined>;
  mode: 'dev' | 'packaged';
  binPathExists: boolean;
  loadedProviderKeyCount: number;
  proxySummary: string;
  channelStartupSummary: string;
}

export interface GatewayPrelaunchSyncSummary {
  timingsMs: Record<string, number>;
  maintenance: Partial<Record<PrelaunchMaintenanceTaskName, PrelaunchMaintenanceRunResult>>;
  deferredMaintenance: Array<{
    task: AsyncPrelaunchMaintenanceTaskName;
    status: 'scheduled' | 'coalesced';
  }>;
  configuredChannels: string[];
  skipChannels: boolean;
  channelStartupSummary: string;
}

// ── Auto-upgrade bundled plugins on startup ──────────────────────

const CHANNEL_PLUGIN_MAP: Record<string, { dirName: string; npmName: string }> = {
  dingtalk: { dirName: 'dingtalk', npmName: '@soimy/dingtalk' },
  wecom: { dirName: 'wecom', npmName: '@wecom/wecom-openclaw-plugin' },
  feishu: { dirName: 'feishu-openclaw-plugin', npmName: '@larksuite/openclaw-lark' },
  discord: { dirName: 'discord', npmName: '@openclaw/discord' },
  qqbot: { dirName: 'qqbot', npmName: '@openclaw/qqbot' },
  whatsapp: { dirName: 'whatsapp', npmName: '@openclaw/whatsapp' },

  'openclaw-weixin': { dirName: 'openclaw-weixin', npmName: '@tencent-weixin/openclaw-weixin' },
  [CLAWX_OPENAI_IMAGE_PROVIDER_KEY]: { dirName: CLAWX_OPENAI_IMAGE_PROVIDER_KEY, npmName: 'clawx-openai-image-plugin' },
  'uclaw-artifact-orchestrator': { dirName: 'uclaw-artifact-orchestrator', npmName: 'uclaw-artifact-orchestrator-plugin' },
  'uclaw-local-artifacts': { dirName: 'uclaw-local-artifacts', npmName: 'uclaw-local-artifacts-plugin' },
  'uclaw-blender': { dirName: 'uclaw-blender', npmName: 'uclaw-blender-plugin' },
  [UCLAW_VIDEO_PROVIDER_ID]: { dirName: UCLAW_VIDEO_PROVIDER_ID, npmName: 'uclaw-video-plugin' },
};

const PARALLEL_WEB_SEARCH_PROVIDERS = new Set(['parallel', 'parallel-free']);
const DEFERRED_MAINTENANCE_DELAY_MS = 30_000;

/** Check whether the current web search selection needs the Parallel plugin runtime. */
function isParallelWebSearchConfigured(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const tools = (config as { tools?: unknown }).tools;
  if (!tools || typeof tools !== 'object') return false;
  const web = (tools as { web?: unknown }).web;
  if (!web || typeof web !== 'object') return false;
  const search = (web as { search?: unknown }).search;
  if (!search || typeof search !== 'object') return false;
  const provider = (search as { provider?: unknown }).provider;
  return typeof provider === 'string'
    && PARALLEL_WEB_SEARCH_PROVIDERS.has(provider.trim())
    && (search as { enabled?: unknown }).enabled !== false;
}

/**
 * OpenClaw ships some channel plugins as bundled extensions under
 * dist/extensions/. If ClawX previously mirrored one of those ids into
 * ~/.openclaw/extensions/, the stale copy overrides the bundled plugin.
 * Only remove extension copies whose id is actually bundled in the
 * currently resolved OpenClaw runtime (e.g. telegram in 2026.6.10).
 */
async function listBundledOpenClawExtensionPluginIds(): Promise<string[]> {
  const extensionsDir = join(getOpenClawResolvedDir(), 'dist', 'extensions');
  let entries: Dirent<string>[];
  try {
    entries = await readdir(fsPath(extensionsDir), { withFileTypes: true });
  } catch {
    return [];
  }

  const pluginIds = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry): Promise<string | null> => {
      const manifestPath = join(extensionsDir, entry.name, 'openclaw.plugin.json');
      try {
        const parsed = JSON.parse(await readFile(fsPath(manifestPath), 'utf-8')) as { id?: unknown };
        return typeof parsed.id === 'string' && parsed.id.trim()
          ? parsed.id.trim()
          : null;
      } catch {
        return null;
      }
    }));

  return pluginIds.filter((pluginId): pluginId is string => pluginId !== null).sort();
}

async function cleanupStaleBuiltInExtensions(): Promise<void> {
  await Promise.all((await listBundledOpenClawExtensionPluginIds()).map(async (ext) => {
    const bundledSource = join(getOpenClawResolvedDir(), 'dist', 'extensions', ext);
    const result = await removeManagedPluginInstall(ext, {
      candidateSources: [bundledSource],
      operation: 'remove-stale-builtin-copy',
    });
    if (result.removed) {
      logger.info(`[plugin] Removed UClaw-managed stale built-in extension copy: ${ext}`);
    }
  }));
}

async function measureAsync<T>(timings: Record<string, number>, key: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const phase = key.endsWith('Ms') ? key.slice(0, -2) : key;
    const { result } = await runPrelaunchPhase(
      phase,
      fn,
      (sample) => {
        if (!sample.eventLoopBlocked) return;
        logger.warn('[gateway-prelaunch] Main event loop blocked', {
          phase: sample.phase,
          callSite: sample.callSite,
          durationMs: Math.round(sample.durationMs),
          eventLoopDelayMs: Math.round(sample.eventLoopDelayMs),
          outcome: sample.outcome,
          samplingTruncated: sample.samplingTruncated,
        });
      },
      { callSite: `gateway.config-sync.${phase}` },
    );
    return result;
  } finally {
    timings[key] = Date.now() - startedAt;
  }
}

function appVersionForCache(): string {
  try {
    return app.getVersion();
  } catch {
    return 'unknown';
  }
}

/**
 * Auto-upgrade all configured channel plugins before Gateway start.
 * - Packaged mode: uses bundled plugins from resources/ (includes deps)
 * - Dev mode: falls back to node_modules/ with pnpm-aware dep collection
 */
async function ensureConfiguredPluginsUpgraded(configuredChannels: string[]): Promise<boolean> {
  const results = await Promise.all(configuredChannels.map(async (channelType) => {
    const pluginInfo = CHANNEL_PLUGIN_MAP[channelType];
    if (!pluginInfo) return true;
    const result = await ensurePluginInstalled(
      pluginInfo.dirName,
      buildCandidateSources(pluginInfo.dirName),
      channelType === CLAWX_OPENAI_IMAGE_PROVIDER_KEY ? 'UClaw OpenAI Image' : channelType,
      { deferTrustedRecordSync: true },
    );
    if (result.warning) {
      logger.warn(`[plugin] ${channelType}: ${result.warning}`);
    }
    return result.installed;
  }));
  return results.every(Boolean);
}

/**
 * Remove channel plugin extensions from ~/.openclaw/extensions/ when their
 * corresponding channel is no longer configured.  This prevents the Gateway
 * from scanning residual plugin manifests that were installed by a previous
 * configuration but are no longer needed.
 */
async function cleanupUnconfiguredChannelPlugins(configuredChannels: string[]): Promise<boolean> {
  const configuredSet = new Set(configuredChannels);
  const results = await Promise.all(Object.entries(CHANNEL_PLUGIN_MAP).map(async ([channelType, pluginInfo]) => {
    if (configuredSet.has(channelType)) return true;
    const { dirName } = pluginInfo;
    const result = await removeManagedPluginInstall(dirName, {
      candidateSources: buildCandidateSources(dirName),
      operation: 'remove-unconfigured-channel',
    });
    if (result.removed) {
      logger.info(`[plugin] Removed UClaw-managed unconfigured channel plugin: ${channelType} (${dirName})`);
    }
    return !result.preserved;
  }));
  return results.every(Boolean);
}

function resolveImageGenerationPrimary(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const agents = (config as { agents?: unknown }).agents;
  if (!agents || typeof agents !== 'object') return null;
  const defaults = (agents as { defaults?: unknown }).defaults;
  if (!defaults || typeof defaults !== 'object') return null;
  const imageGenerationModel = (defaults as { imageGenerationModel?: unknown }).imageGenerationModel;
  if (typeof imageGenerationModel === 'string') return imageGenerationModel.trim() || null;
  if (imageGenerationModel && typeof imageGenerationModel === 'object') {
    const primary = (imageGenerationModel as { primary?: unknown }).primary;
    return typeof primary === 'string' && primary.trim() ? primary.trim() : null;
  }
  return null;
}

function resolveVideoGenerationPrimary(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const agents = (config as { agents?: unknown }).agents;
  if (!agents || typeof agents !== 'object') return null;
  const defaults = (agents as { defaults?: unknown }).defaults;
  if (!defaults || typeof defaults !== 'object') return null;
  const videoGenerationModel = (defaults as { videoGenerationModel?: unknown }).videoGenerationModel;
  if (typeof videoGenerationModel === 'string') return videoGenerationModel.trim() || null;
  if (videoGenerationModel && typeof videoGenerationModel === 'object') {
    const primary = (videoGenerationModel as { primary?: unknown }).primary;
    return typeof primary === 'string' && primary.trim() ? primary.trim() : null;
  }
  return null;
}

export function withConfiguredMediaGenerationPlugins(
  configuredChannels: string[],
  rawConfig: unknown,
): string[] {
  const next = [...configuredChannels];
  const imagePrimary = resolveImageGenerationPrimary(rawConfig);
  const imageProvider = imagePrimary?.includes('/')
    ? imagePrimary.slice(0, imagePrimary.indexOf('/')).trim()
    : imagePrimary;
  if (imageProvider === CLAWX_OPENAI_IMAGE_PROVIDER_KEY && !next.includes(CLAWX_OPENAI_IMAGE_PROVIDER_KEY)) {
    next.push(CLAWX_OPENAI_IMAGE_PROVIDER_KEY);
  }

  const videoPrimary = resolveVideoGenerationPrimary(rawConfig);
  const videoProvider = videoPrimary?.includes('/')
    ? videoPrimary.slice(0, videoPrimary.indexOf('/')).trim()
    : videoPrimary;
  if (videoProvider === UCLAW_VIDEO_PROVIDER_ID && !next.includes(UCLAW_VIDEO_PROVIDER_ID)) {
    next.push(UCLAW_VIDEO_PROVIDER_ID);
  }

  // Document and Blender tools are UClaw product capabilities rather than
  // user-configured channels, so keep their runtime plugins installed on every launch.
  for (const pluginId of REQUIRED_UCLAW_RUNTIME_PLUGIN_IDS) {
    if (!next.includes(pluginId)) next.push(pluginId);
  }
  return next;
}

async function buildPluginSourceSignatures(configuredChannels: string[]): Promise<Record<string, unknown>> {
  const entries = await Promise.all([...configuredChannels].sort().map(async (channelType) => {
    const pluginInfo = CHANNEL_PLUGIN_MAP[channelType];
    if (!pluginInfo) return null;
    const bundledSources = buildCandidateSources(pluginInfo.dirName);
    const targetDir = join(getOpenClawConfigDir(), 'extensions', pluginInfo.dirName);
    const sourceDir = await findBestBundledPluginSource(bundledSources, targetDir)
      || (!app.isPackaged ? join(process.cwd(), 'node_modules', ...pluginInfo.npmName.split('/')) : '');
    const signature = sourceDir
      ? {
        sourceDir,
        manifest: await pathSignatureAsync(fsPath(join(sourceDir, 'openclaw.plugin.json'))),
        packageJson: await pathSignatureAsync(fsPath(join(sourceDir, 'package.json'))),
        sourceDirectory: await directoryChildrenSignatureAsync(fsPath(sourceDir)),
        installedMissingRuntimeDependencies: await findMissingPluginRuntimeDependencies(targetDir),
      }
      : 'missing';
    return [channelType, signature] as const;
  }));
  return Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
}

async function buildPluginMaintenanceCacheKey(
  openclawDir: string,
  configuredChannels: string[],
): Promise<string> {
  return buildPrelaunchMaintenanceCacheKey({
    task: 'plugin-maintenance',
    appVersion: appVersionForCache(),
    openclawDir,
    cwd: process.cwd(),
    configuredChannels: [...configuredChannels].sort(),
    extensionsDir: await directoryChildrenSignatureAsync(fsPath(join(getOpenClawConfigDir(), 'extensions'))),
    sourceSignatures: await buildPluginSourceSignatures(configuredChannels),
  });
}

async function buildSkillsSymlinkCleanupCacheKey(openclawDir: string): Promise<string> {
  const workspaceSkillsDir = join(getOpenClawConfigDir(), 'workspace', 'skills');
  return buildPrelaunchMaintenanceCacheKey({
    task: 'skills-symlink-cleanup',
    appVersion: appVersionForCache(),
    openclawDir,
    skillsDir: getOpenClawSkillsDir(),
    skillsDirSignature: await directoryChildrenSignatureAsync(fsPath(getOpenClawSkillsDir())),
    workspaceSkillsDir,
    workspaceSkillsDirSignature: await directoryChildrenSignatureAsync(fsPath(workspaceSkillsDir)),
  });
}

async function buildPluginInstallArtifactCleanupCacheKey(openclawDir: string): Promise<string> {
  return buildPrelaunchMaintenanceCacheKey({
    task: 'plugin-install-artifact-cleanup',
    appVersion: appVersionForCache(),
    openclawDir,
    extensionsDirSignature: await directoryChildrenSignatureAsync(
      fsPath(join(getOpenClawConfigDir(), 'extensions')),
    ),
  });
}

async function buildRuntimeDepsCleanupCacheKey(openclawDir: string): Promise<string> {
  const runtimeDepsDir = join(getOpenClawConfigDir(), 'plugin-runtime-deps');
  return buildPrelaunchMaintenanceCacheKey({
    task: 'runtime-deps-cleanup',
    appVersion: appVersionForCache(),
    openclawDir,
    currentOpenClawDir: getOpenClawResolvedDir(),
    runtimeDepsDir,
    // The normal launch key is intentionally shallow. A recursive audit is
    // scheduled after launch; app/build/path changes still force a blocking
    // cleanup before the child can see stale runtime roots.
    runtimeDepsDirSignature: await directoryChildrenSignatureAsync(fsPath(runtimeDepsDir)),
  });
}

async function buildRuntimeDepsDeepAuditCacheKey(openclawDir: string): Promise<string> {
  const runtimeDepsDir = join(getOpenClawConfigDir(), 'plugin-runtime-deps');
  return buildPrelaunchMaintenanceCacheKey({
    task: 'runtime-deps-deep-audit',
    appVersion: appVersionForCache(),
    openclawDir,
    currentOpenClawDir: getOpenClawResolvedDir(),
    runtimeDepsDir,
    runtimeDepsDirSignature: await directoryTreeSignatureAsync(fsPath(runtimeDepsDir)),
  });
}

function safeMaintenanceErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/i.test(code)
    ? code
    : 'unknown';
}

function scheduleDeferredMaintenance(
  summary: GatewayPrelaunchSyncSummary['deferredMaintenance'],
  taskName: AsyncPrelaunchMaintenanceTaskName,
  cacheKey: () => Promise<string>,
  task: () => Promise<void | boolean>,
): void {
  const scheduled = scheduleCachedPrelaunchMaintenanceTaskAsync(taskName, cacheKey, task, {
    delayMs: DEFERRED_MAINTENANCE_DELAY_MS,
    onComplete: (result) => {
      logger.info('[metric] gateway.prelaunch.deferred-maintenance', {
        task: taskName,
        executed: result.executed,
        reason: result.reason,
      });
    },
    onError: (error) => {
      logger.warn('[gateway-prelaunch] Deferred maintenance failed', {
        task: taskName,
        code: safeMaintenanceErrorCode(error),
      });
    },
  });
  summary.push({
    task: taskName,
    status: scheduled.scheduled ? 'scheduled' : 'coalesced',
  });
}

function schedulePostLaunchMaintenance(
  openclawDir: string,
  summary: GatewayPrelaunchSyncSummary['deferredMaintenance'],
): void {
  scheduleDeferredMaintenance(
    summary,
    'plugin-install-artifact-cleanup',
    () => buildPluginInstallArtifactCleanupCacheKey(openclawDir),
    cleanupStalePluginInstallArtifacts,
  );
  scheduleDeferredMaintenance(
    summary,
    'skills-symlink-cleanup',
    () => buildSkillsSymlinkCleanupCacheKey(openclawDir),
    async () => ((await cleanupAgentsSymlinkedSkills()).failed ?? 0) === 0,
  );
  scheduleDeferredMaintenance(
    summary,
    'runtime-deps-deep-audit',
    () => buildRuntimeDepsDeepAuditCacheKey(openclawDir),
    async () => ((await cleanupStalePluginRuntimeDeps()).failed ?? 0) === 0,
  );
}

/**
 * Ensure extension-specific packages are resolvable from shared dist/ chunks.
 *
 * OpenClaw's Rollup bundler creates shared chunks in dist/ (e.g.
 * sticker-cache-*.js) that eagerly `import "grammy"`.  ESM bare specifier
 * resolution walks from the importing file's directory upward:
 *   dist/node_modules/ → openclaw/node_modules/ → …
 * It does NOT search `dist/extensions/telegram/node_modules/`.
 *
 * NODE_PATH only works for CJS require(), NOT for ESM import statements.
 *
 * Fix: create symlinks in openclaw/node_modules/ pointing to packages in
 * dist/extensions/<ext>/node_modules/.  This makes the standard ESM
 * resolution algorithm find them.  Skip-if-exists avoids overwriting
 * openclaw's own deps (they take priority).
 */
let _extensionDepsLinked = false;

/**
 * Reset the extension-deps-linked cache so the next
 * ensureExtensionDepsResolvable() call re-scans and links.
 * Called before each Gateway launch to pick up newly installed extensions.
 */
export function resetExtensionDepsLinked(): void {
  _extensionDepsLinked = false;
}

async function ensureExtensionDepsResolvable(openclawDir: string): Promise<void> {
  if (_extensionDepsLinked) return;

  const extDir = join(openclawDir, 'dist', 'extensions');
  const topNM = join(openclawDir, 'node_modules');
  let linkedCount = 0;

  try {
    let extensions: Dirent<string>[];
    try {
      extensions = await readdir(extDir, { withFileTypes: true }) as Dirent<string>[];
    } catch {
      return;
    }

    for (const ext of extensions) {
      if (!ext.isDirectory()) continue;
      const extNM = join(extDir, ext.name, 'node_modules');
      let packages: Dirent<string>[];
      try {
        packages = await readdir(extNM, { withFileTypes: true }) as Dirent<string>[];
      } catch {
        continue;
      }

      for (const pkg of packages) {
        if (pkg.name === '.bin') continue;

        if (pkg.name.startsWith('@')) {
          // Scoped package — iterate sub-entries
          const scopeDir = join(extNM, pkg.name);
          let scopeEntries: Dirent<string>[];
          try { scopeEntries = await readdir(scopeDir, { withFileTypes: true }) as Dirent<string>[]; } catch { continue; }
          for (const sub of scopeEntries) {
            if (!sub.isDirectory()) continue;
            const dest = join(topNM, pkg.name, sub.name);
            try {
              await lstat(dest);
              continue;
            } catch {
              // Missing destination is expected.
            }
            try {
              await mkdir(join(topNM, pkg.name), { recursive: true });
              await symlink(join(scopeDir, sub.name), dest);
              linkedCount++;
            } catch { /* skip on error — non-fatal */ }
          }
        } else {
          const dest = join(topNM, pkg.name);
          try {
            await lstat(dest);
            continue;
          } catch {
            // Missing destination is expected.
          }
          try {
            await mkdir(topNM, { recursive: true });
            await symlink(join(extNM, pkg.name), dest);
            linkedCount++;
          } catch { /* skip on error — non-fatal */ }
        }
      }
    }
  } catch {
    // extensions dir may not exist or be unreadable — non-fatal
  }

  if (linkedCount > 0) {
    logger.info(`[extension-deps] Linked ${linkedCount} extension packages into ${topNM}`);
  }

  _extensionDepsLinked = true;
}

// ── Pre-launch sync ──────────────────────────────────────────────

export async function syncGatewayConfigBeforeLaunch(
  appSettings: Awaited<ReturnType<typeof getAllSettings>>,
  openclawDir: string,
): Promise<GatewayPrelaunchSyncSummary> {
  const timingsMs: Record<string, number> = {};
  const maintenance: GatewayPrelaunchSyncSummary['maintenance'] = {};
  const deferredMaintenance: GatewayPrelaunchSyncSummary['deferredMaintenance'] = [];
  let configuredChannels: string[] = [];
  let shouldInstallParallelSearchPlugin = false;
  let skipChannels = false;
  let channelStartupSummary = 'enabled(unknown)';

  // Reset the extension-deps cache so that newly installed extensions
  // (e.g. user added a channel while the app was running) get their
  // node_modules linked on the next Gateway spawn.
  resetExtensionDepsLinked();

  await measureAsync(timingsMs, 'proxySyncMs', async () => {
    await syncProxyConfigToOpenClaw(appSettings, { preserveExistingWhenDisabled: true });
  });

  try {
    await measureAsync(timingsMs, 'sanitizeMs', sanitizeOpenClawConfig);
  } catch (err) {
    logger.warn('Failed to sanitize openclaw.json:', err);
  }

  // Remove stale copies of built-in extensions (Discord, Telegram) that
  // override OpenClaw's working built-in plugins and break channel loading.
  try {
    await measureAsync(timingsMs, 'staleBuiltinExtensionCleanupMs', cleanupStaleBuiltInExtensions);
  } catch (err) {
    logger.warn('Failed to clean stale built-in extensions:', err);
  }

  // Remove stray symlinks under ~/.openclaw/skills whose realpath resolves
  // inside ~/.agents/skills.  OpenClaw's hardened skill loader rejects these
  // on every launch (reason=symlink-escape) and the underlying skills are
  // still discovered via the agents-skills-personal source, so the symlinks
  // are pure log noise.  Transitional workaround for openclaw/openclaw#59219.
  // Remove stale OpenClaw runtime-deps cache roots that point at an older
  // worktree/package.  Those symlink trees can make Gateway plugin setup spend
  // a long time in synchronous fs.open/copy calls before the RPC router is
  // responsive.
  const runtimeDepsCleanupPromise = (async () => {
    try {
      const result = await measureAsync(
        timingsMs,
        'runtimeDepsCleanupMs',
        () => runCachedPrelaunchMaintenanceTaskAsync(
          'runtime-deps-cleanup',
          () => buildRuntimeDepsCleanupCacheKey(openclawDir),
          async () => ((await cleanupStalePluginRuntimeDeps()).failed ?? 0) === 0,
        ),
      );
      maintenance['runtime-deps-cleanup'] = result;
    } catch (err) {
      logger.warn('Failed to clean stale OpenClaw plugin runtime deps:', err);
    }
  })();

  // A deep tree walk is useful for catching an unexpected nested target but is
  // not needed on every launch. The shallow launch key above catches app/path
  // generations; the full audit runs after the child has had time to start.
  // Auto-upgrade installed plugins before Gateway starts so that
  // the plugin manifest ID matches what sanitize wrote to the config.
  // Only install/upgrade plugins for channels that are actually configured
  // in openclaw.json — do NOT expand the list from plugins.allow.
  try {
    configuredChannels = await measureAsync(timingsMs, 'configuredChannelsMs', async () => {
      const snapshot = await captureChannelStartupSnapshot();
      shouldInstallParallelSearchPlugin = isParallelWebSearchConfigured(snapshot.config);
      skipChannels = snapshot.configuredChannels.length === 0;
      channelStartupSummary = skipChannels
        ? 'skipped(no configured channels)'
        : `enabled(${snapshot.configuredChannels.join(',')})`;
      return withConfiguredMediaGenerationPlugins(
        snapshot.configuredChannels,
        snapshot.config,
      );
    });

    const result = await measureAsync(timingsMs, 'pluginMaintenanceMs', () => runCachedPrelaunchMaintenanceTaskAsync(
      'plugin-maintenance',
      () => buildPluginMaintenanceCacheKey(openclawDir, configuredChannels),
      () => ensureConfiguredPluginsUpgraded(configuredChannels),
    ));
    maintenance['plugin-maintenance'] = result;
    const cleanupOk = await measureAsync(
      timingsMs,
      'unconfiguredPluginCleanupMs',
      () => cleanupUnconfiguredChannelPlugins(configuredChannels),
    );
    if (!cleanupOk) {
      logger.warn('[plugin] One or more unconfigured channel plugins could not be removed');
    }
  } catch (err) {
    // A missing or malformed snapshot is not evidence that the user removed
    // every channel. Preserve installed plugins and launch channels fail-open.
    logger.warn('Failed to capture trusted channel config; preserving channel runtime state:', err);
  }

  await runtimeDepsCleanupPromise;

  // Batch gateway token, browser config, and session idle into one read+write cycle.
  try {
    await measureAsync(timingsMs, 'configFieldSyncMs', async () => {
      await batchSyncConfigFields(appSettings.gatewayToken);
    });
  } catch (err) {
    logger.warn('Failed to batch-sync config fields to openclaw.json:', err);
  }

  // Batch sync may seed parallel-free on a fresh profile, so resolve again afterwards.
  try {
    shouldInstallParallelSearchPlugin ||= isParallelWebSearchConfigured(await readOpenClawConfig());
    if (shouldInstallParallelSearchPlugin) {
      const result = await measureAsync(
        timingsMs,
        'parallelPluginMaintenanceMs',
        () => ensureParallelPluginInstalled({ deferTrustedRecordSync: true }),
      );
      if (result.warning) {
        logger.warn(`[plugin] Parallel Search: ${result.warning}`);
      }
    }
  } catch (err) {
    logger.warn('Failed to install Parallel Search plugin:', err);
  }

  // Refresh all trusted official records in one config lock and one atomic
  // openclaw.json replacement, including the optional Parallel install above.
  try {
    await measureAsync(
      timingsMs,
      'trustedPluginInstallSyncMs',
      repairTrustedOfficialPluginInstallRecords,
    );
  } catch (err) {
    logger.warn('Failed to repair trusted plugin install metadata:', err);
  }

  return {
    timingsMs,
    maintenance,
    deferredMaintenance,
    configuredChannels,
    skipChannels,
    channelStartupSummary,
  };
}

/** Resolve the canonical managed OpenAI credential without racing login or logout. */
export async function loadManagedOpenAiProviderEnv(): Promise<ReturnType<typeof buildManagedOpenAiProviderEnv>> {
  return withProviderMutationLock(async () => {
    const [account, compatibilityAccount] = await Promise.all([
      getProviderAccount(UCLAW_PROVIDER_ID),
      getProviderAccount(UCLAW_COMPATIBILITY_PROVIDER_ID),
    ]);
    if (
      account?.id !== UCLAW_PROVIDER_ID
      || account.vendorId !== 'openai'
      || !isUclawManagedAccount(account)
    ) {
      return buildManagedOpenAiProviderEnv(null);
    }

    const [authSecret, relaySecret, compatibilityRelaySecret] = await Promise.all([
      getProviderSecret(UCLAW_AUTH_ACCOUNT_ID, { migrate: false }),
      getProviderSecret(UCLAW_PROVIDER_ID, { migrate: false }),
      getProviderSecret(UCLAW_COMPATIBILITY_PROVIDER_ID, { migrate: false }),
    ]);
    return buildManagedOpenAiProviderEnv(resolveValidUclawManagedRelayPairToken(
      account,
      compatibilityAccount,
      authSecret,
      relaySecret,
      compatibilityRelaySecret,
    ));
  });
}

async function loadProviderEnv(
  managedDistribution: boolean,
): Promise<{ providerEnv: Record<string, string>; loadedProviderKeyCount: number }> {
  const providerEnv: Record<string, string> = {};
  const providerTypes = getKeyableProviderTypes();
  let loadedProviderKeyCount = 0;

  if (managedDistribution) {
    try {
      const managedOpenAi = await loadManagedOpenAiProviderEnv();
      Object.assign(providerEnv, managedOpenAi.providerEnv);
      loadedProviderKeyCount += managedOpenAi.loadedProviderKeyCount;
    } catch {
      const managedOpenAi = buildManagedOpenAiProviderEnv(null);
      Object.assign(providerEnv, managedOpenAi.providerEnv);
      logger.warn('Failed to load the managed OpenAI credential; Gateway login is required');
    }
    try {
      providerEnv.CLAWX_UCLAW_ORIGIN = getUclawBackendOrigin();
      providerEnv.CLAWX_UCLAW_DIAGNOSTIC_HEADERS = JSON.stringify(
        await getUclawDiagnosticHeaders({ includeRequestId: false }),
      );
    } catch (error) {
      logger.warn('Failed to build UClaw Gateway request diagnostics:', error);
    }
  }

  try {
    const defaultProviderId = await getDefaultProvider();
    if (defaultProviderId) {
      const defaultProvider = await getProvider(defaultProviderId);
      const defaultProviderType = defaultProvider?.type;
      if (defaultProviderType) {
        const envVar = getProviderEnvVar(defaultProviderType);
        if (shouldInjectProviderEnv(envVar, managedDistribution)) {
          const defaultProviderKey = await getApiKey(defaultProviderId);
          if (envVar && defaultProviderKey) {
            providerEnv[envVar] = defaultProviderKey;
            loadedProviderKeyCount++;
          }
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to load default provider key for environment injection:', err);
  }

  for (const providerType of providerTypes) {
    try {
      const envVar = getProviderEnvVar(providerType);
      if (!shouldInjectProviderEnv(envVar, managedDistribution)) continue;
      const key = await getApiKey(providerType);
      if (envVar && key) {
        providerEnv[envVar] = key;
        loadedProviderKeyCount++;
      }
    } catch (err) {
      logger.warn(`Failed to load API key for ${providerType}:`, err);
    }
  }

  return { providerEnv, loadedProviderKeyCount };
}

export async function prepareGatewayLaunchContext(port: number): Promise<GatewayLaunchContext> {
  const timingsMs: Record<string, number> = {};
  const totalStartedAt = Date.now();
  const openclawDir = getOpenClawDir();
  const entryScript = getOpenClawEntryPath();
  const managedDistribution = isUclawManagedDistribution();

  if (!isOpenClawPresent()) {
    throw new Error(`OpenClaw package not found at: ${openclawDir}`);
  }

  const appSettings = await measureAsync(timingsMs, 'settingsMs', getAllSettings);
  const prelaunchSummary = await measureAsync(timingsMs, 'prelaunchSyncMs', async () => (
    await syncGatewayConfigBeforeLaunch(appSettings, openclawDir)
  ));

  if (!existsSync(entryScript)) {
    throw new Error(`OpenClaw entry script not found at: ${entryScript}`);
  }

  const gatewayArgs = ['gateway', '--port', String(port), '--token', appSettings.gatewayToken, '--allow-unconfigured'];
  const mode = app.isPackaged ? 'packaged' : 'dev';

  const platform = process.platform;
  const arch = process.arch;
  const target = `${platform}-${arch}`;
  const binPath = app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(process.cwd(), 'resources', 'bin', target);
  const binPathExists = existsSync(binPath);

  const { providerEnv, loadedProviderKeyCount } = await measureAsync(
    timingsMs,
    'providerEnvMs',
    () => loadProviderEnv(managedDistribution),
  );
  const { skipChannels, channelStartupSummary } = prelaunchSummary;
  const uvEnv = await measureAsync(timingsMs, 'uvEnvMs', getUvMirrorEnv);
  const proxyEnv = buildProxyEnv(appSettings);
  const resolvedProxy = resolveProxySettings(appSettings);
  const proxySummary = appSettings.proxyEnabled
    ? `http=${resolvedProxy.httpProxy || '-'}, https=${resolvedProxy.httpsProxy || '-'}, all=${resolvedProxy.allProxy || '-'}`
    : 'disabled';

  const { NODE_OPTIONS: _nodeOptions, ...baseEnv } = process.env;
  const baseEnvRecord = baseEnv as Record<string, string | undefined>;
  const baseEnvPatched = binPathExists
    ? prependPathEntry(baseEnvRecord, binPath).env
    : baseEnvRecord;
  const inheritedEnv = stripManagedProviderEnv(
    stripSystemdSupervisorEnv(baseEnvPatched),
    managedDistribution,
  );
  // The private bridge endpoint is process-scoped. Never inherit a stale
  // endpoint or token from the shell or an older UClaw process.
  delete inheritedEnv.CLAWX_HOST_API_ORIGIN;
  delete inheritedEnv.CLAWX_HOST_API_TOKEN;
  delete inheritedEnv.CLAWX_UCLAW_ORIGIN;
  delete inheritedEnv.CLAWX_UCLAW_DIAGNOSTIC_HEADERS;
  const forkEnv: Record<string, string | undefined> = {
    ...inheritedEnv,
    ...providerEnv,
    ...uvEnv,
    ...proxyEnv,
    ...getBlenderBridgeEnvironment(),
    OPENCLAW_GATEWAY_TOKEN: appSettings.gatewayToken,
    OPENCLAW_SKIP_CHANNELS: skipChannels ? '1' : '',
    OPENCLAW_NO_RESPAWN: '1',
    // Disable OpenClaw's interactive-shell env snapshot. When the Gateway runs
    // as an Electron utilityProcess, `process.execPath` is the Electron binary,
    // and OpenClaw captures the shell env by spawning `process.execPath -e
    // <script>` inside a sanitized login shell that strips ELECTRON_RUN_AS_NODE.
    // Electron then treats the script as an app path and pops up "Unable to find
    // Electron app at <cwd>/const safe = new Set(...)". Turning the snapshot off
    // avoids that broken spawn; exec tools fall back to the Gateway launch env.
    OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
  };

  // Ensure extension-specific packages (e.g. grammy from the telegram
  // extension) are resolvable by shared dist/ chunks via symlinks in
  // openclaw/node_modules/.  NODE_PATH does NOT work for ESM imports.
  await measureAsync(timingsMs, 'extensionDepsMs', () => ensureExtensionDepsResolvable(openclawDir));
  // Schedule only after every launch-context barrier has completed. The
  // unref'd grace timer gives the caller time to fork Gateway before any
  // best-effort scan starts.
  schedulePostLaunchMaintenance(openclawDir, prelaunchSummary.deferredMaintenance);
  timingsMs.totalMs = Date.now() - totalStartedAt;

  logger.info('[metric] gateway.prelaunch', {
    ...prelaunchSummary.timingsMs,
    ...timingsMs,
    maintenance: prelaunchSummary.maintenance,
    deferredMaintenance: prelaunchSummary.deferredMaintenance,
    configuredChannelCount: prelaunchSummary.configuredChannels.length,
  });

  return {
    appSettings,
    openclawDir,
    entryScript,
    gatewayArgs,
    forkEnv,
    mode,
    binPathExists,
    loadedProviderKeyCount,
    proxySummary,
    channelStartupSummary,
  };
}
