/**
 * Auto-Updater Module
 * Handles automatic application updates using electron-updater
 *
 * Packaged macOS builds and Windows USB builds use the managed portable update
 * API and a verified ZIP. Other installed builds use electron-updater.
 */
import { autoUpdater, UpdateInfo, ProgressInfo, UpdateDownloadedEvent } from 'electron-updater';
import { BrowserWindow, app, ipcMain, shell } from 'electron';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import {
  UCLAW_UPDATE_CHECK_TIMEOUT_MS,
  UCLAW_UPDATE_DOWNLOAD_TIMEOUT_MS,
  UCLAW_UPDATE_ROUTES,
} from '../../shared/junfeiai-endpoints';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';
import { getUclawBackendOrigin } from '../utils/junfeiai-distribution';
import {
  canAutoReplacePortableUpdate,
  getPortableDataMode,
  getPortableModeInfo,
  getPortableUpdatePackageType,
  getPortableUpdatesDir,
  inspectPortableLayout,
  shouldUsePortableUpdatePackage,
  type PortableLayoutReason,
  type PortableUpdatePackageType,
} from '../utils/portable-mode';
import { proxyAwareFetch } from '../utils/proxy-fetch';
import { setQuitting } from './app-state';
import { launchPortableUpdateInstaller } from './portable-update-installer';
import {
  assertPortableUpdateZipFilename,
  comparePortableUpdateVersions,
  filenameFromPortableUpdateInfo,
  isValidPortableUpdateVersion,
  verifyPortableUpdatePackage,
} from './portable-update-security';

/** Resolve update endpoints from the checked-in UClaw distribution config. */
function getUpdateFeedBaseUrl(): string {
  return `${getUclawBackendOrigin()}${UCLAW_UPDATE_ROUTES.feed}`.replace(/\/+$/, '');
}

function getPortableLatestUpdateUrl(): URL {
  return new URL(`${getUclawBackendOrigin()}${UCLAW_UPDATE_ROUTES.latest}`);
}

export interface UpdateStatus {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  /** Monotonic sequence for renderer-side stale event filtering. */
  sequence?: number;
  mode?: 'installed' | 'portable';
  /** Artifact family used for this update, independent of data placement. */
  packageType?: PortableUpdatePackageType;
  /** Whether a downloaded artifact may replace the current app in place. */
  canAutoReplace?: boolean;
  /** True when the user must extract/migrate the ZIP manually. */
  requiresMigration?: boolean;
  migrationReason?: PortableLayoutReason;
  disposition?: UpdateDisposition;
  info?: UpdateInfo | PortableUpdateInfo;
  progress?: ProgressInfo;
  error?: string;
  downloadPath?: string;
}

export interface UpdaterEvents {
  'status-changed': (status: UpdateStatus) => void;
  'checking-for-update': () => void;
  'update-available': (info: UpdateInfo) => void;
  'update-not-available': (info: UpdateInfo) => void;
  'download-progress': (progress: ProgressInfo) => void;
  'update-downloaded': (event: UpdateDownloadedEvent) => void;
  'error': (error: Error) => void;
}

/**
 * Detect the update channel from a semver version string.
 * e.g. "0.1.8-alpha.0" → "alpha", "1.0.0-beta.1" → "beta", "1.0.0" → "latest"
 */
function detectChannel(version: string): string {
  const match = version.match(/-([a-zA-Z]+)/);
  return match ? match[1] : 'latest';
}

function platformForUpdateApi(): 'mac' | 'win' | 'linux' {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'win';
  return 'linux';
}

function normalizeUpdateChannel(channel: string): string {
  return channel === 'stable' ? 'latest' : channel;
}

type BackendEnvelope<T> = {
  success?: boolean;
  message?: string;
  data?: T;
};

export interface PortableUpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string | null;
  downloadUrl?: string;
  download_url?: string;
  feedUrl?: string;
  feed_url?: string;
  channel?: string;
  platform?: string;
  arch?: string;
  packageType?: string;
  package_type?: string;
  fileName?: string;
  file_name?: string;
  sha512?: string;
  size?: number;
  mandatory?: boolean;
}

type PortableUpdateArtifactMetadata = {
  downloadUrl: string;
  sha512: string;
  size: number;
};

type PortableUpdateIntegrityMetadata = Pick<PortableUpdateArtifactMetadata, 'sha512' | 'size'>;

type PortableUpdateFileOperations = {
  rename: typeof rename;
  remove: typeof rm;
};

/**
 * Replace a completed download without first deleting the previous cached
 * artifact.  POSIX (including macOS) can atomically replace a regular file by
 * renaming over it, so that is the fast path.  Some Windows/filesystem
 * combinations reject that operation while the old file is present; in that
 * case move the old file to a unique sibling, install the new file, and put
 * the old file back if the second rename fails.  The caller keeps the partial
 * path until this function resolves, so every failure remains recoverable.
 */
export async function replaceDownloadedUpdateAtomically(
  partialPath: string,
  targetPath: string,
  operations: PortableUpdateFileOperations = { rename, remove: rm },
): Promise<void> {
  try {
    // On macOS this is a single atomic directory entry replacement.  Do not
    // turn it into rm()+rename(); a failed rename must never lose the old ZIP.
    await operations.rename(partialPath, targetPath);
    return;
  } catch (firstError) {
    const code = (firstError as NodeJS.ErrnoException | undefined)?.code;
    // A non-collision error (permissions, I/O, cross-device, etc.) leaves the
    // original target untouched and should be reported directly.
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'ENOTEMPTY' && code !== 'EACCES') {
      throw firstError;
    }
  }

  const backupPath = `${targetPath}.previous-${randomUUID()}`;
  try {
    await operations.rename(targetPath, backupPath);
  } catch (backupError) {
    // The old target may have disappeared between the fast path and this
    // fallback.  Retry the atomic rename once; otherwise preserve the first
    // meaningful filesystem error for diagnostics.
    const backupCode = (backupError as NodeJS.ErrnoException | undefined)?.code;
    if (backupCode === 'ENOENT') {
      await operations.rename(partialPath, targetPath);
      return;
    }
    throw backupError;
  }

  try {
    await operations.rename(partialPath, targetPath);
  } catch (replacementError) {
    try {
      await operations.rename(backupPath, targetPath);
    } catch (rollbackError) {
      throw new Error(
        `Portable update replacement failed and rollback failed: ${(replacementError as Error).message || String(replacementError)}; ${(rollbackError as Error).message || String(rollbackError)}`,
        // Preserve the rollback failure as the causal error. The replacement
        // failure is included in the message above; attaching the caught
        // rollback error keeps diagnostics aligned with the actual terminal
        // failure and satisfies the caught-error preservation rule.
        { cause: rollbackError },
      );
    }
    throw replacementError;
  }

  // The new target is safely in place.  Failure to remove an old cache should
  // not turn a successful update download into an error; leave the backup for
  // a later cleanup pass and make the condition visible in logs.
  await operations.remove(backupPath, { force: true }).catch((cleanupError) => {
    logger.warn('[Updater] Failed to remove previous portable update cache:', cleanupError);
  });
}

function isPortableUpdateInfo(value: unknown): value is PortableUpdateInfo {
  return Boolean(
    value
      && typeof value === 'object'
      && typeof (value as PortableUpdateInfo).version === 'string',
  );
}

function createRequestTimeout(timeoutMs: number, message: string): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
  return {
    controller,
    dispose: () => clearTimeout(timer),
  };
}

/**
 * Validate the identity returned by the managed update API before accepting a
 * download URL. The API carries both camelCase and snake_case forms during
 * the rollout; the package/platform/architecture values themselves must be
 * exact so an arm64 client never installs an x64 (or installer) artifact.
 */
function validatePortableUpdateIdentity(
  info: PortableUpdateInfo,
  expectedPlatform: 'mac' | 'win' | 'linux',
  expectedArch: string,
): void {
  if (!isValidPortableUpdateVersion(info.version)) {
    throw new Error(`Managed update metadata version is invalid (received ${info.version || 'missing'})`);
  }
  const declaredPackageTypes = [
    { name: 'packageType', value: info.packageType },
    { name: 'package_type', value: info.package_type },
  ].filter(({ value }) => value !== undefined);
  if (declaredPackageTypes.some(({ value }) => typeof value !== 'string')) {
    throw new Error('Managed update metadata package type must be a string');
  }
  const packageTypes = declaredPackageTypes.map(({ value }) => (value as string).trim());
  if (packageTypes.some((value) => value.length === 0)) {
    throw new Error('Managed update metadata package type is required');
  }
  const packageType = packageTypes[0];
  if (packageTypes.some((value) => value !== packageType)) {
    throw new Error('Managed update metadata package type aliases disagree');
  }
  const platform = info.platform;
  const arch = info.arch;
  if (packageType !== 'portable_zip') {
    throw new Error(`Managed update metadata must use package_type=portable_zip (received ${packageType || 'missing'})`);
  }
  if (platform !== expectedPlatform) {
    throw new Error(`Managed update metadata platform mismatch (expected ${expectedPlatform}, received ${platform || 'missing'})`);
  }
  if (arch !== expectedArch) {
    throw new Error(`Managed update metadata architecture mismatch (expected ${expectedArch}, received ${arch || 'missing'})`);
  }
}

/**
 * Validate the artifact fields before exposing an update as available or
 * touching the network/filesystem.  The managed endpoint is an untrusted
 * boundary: a newer version without a complete URL, digest, or byte count is
 * not an actionable update and must fail closed.
 */
function validatePortableUpdateIntegrity(info: PortableUpdateInfo): PortableUpdateIntegrityMetadata {
  const sha512 = typeof info.sha512 === 'string' ? info.sha512.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{128}$/u.test(sha512)) {
    throw new Error('Managed update metadata sha512 must be a 128-character hexadecimal digest');
  }

  const size = info.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error('Managed update metadata size must be a positive integer');
  }

  return { sha512, size };
}

function validatePortableUpdateArtifact(info: PortableUpdateInfo): PortableUpdateArtifactMetadata {
  const declaredUrls = [
    { name: 'downloadUrl', value: info.downloadUrl },
    { name: 'download_url', value: info.download_url },
  ].filter(({ value }) => value !== undefined);

  if (declaredUrls.some(({ value }) => typeof value !== 'string')) {
    throw new Error('Managed update metadata download URL must be a string');
  }

  const urls = declaredUrls.map(({ value }) => (value as string).trim());
  if (urls.length === 0 || urls.some((value) => value.length === 0)) {
    throw new Error('Managed update metadata download URL is required');
  }
  const downloadUrl = urls[0];
  if (urls.some((value) => value !== downloadUrl)) {
    throw new Error('Managed update metadata download URL aliases disagree');
  }
  try {
    const parsed = new URL(downloadUrl);
    if (
      parsed.protocol !== 'https:'
      || !parsed.hostname
      || parsed.username
      || parsed.password
    ) {
      throw new Error('HTTPS URL is required and must include a host');
    }
  } catch {
    throw new Error('Managed update metadata download URL is invalid');
  }

  return { downloadUrl, ...validatePortableUpdateIntegrity(info) };
}

/**
 * Update artifacts and colocated application state are separate concerns.
 * macOS always consumes the managed portable ZIP endpoint, while only a
 * complete writable portable root may be replaced in place.
 */
export type UpdateDisposition = 'installer' | 'auto-replace' | 'manual-migration';

function updateMetadata(): Pick<
  UpdateStatus,
  'mode' | 'packageType' | 'canAutoReplace' | 'requiresMigration' | 'migrationReason' | 'disposition'
> {
  // Keep development/non-managed runs truthful.  In particular, Electron's
  // unpackaged Darwin process still uses the generic electron-updater feed;
  // exposing macOS's production portable_zip metadata there would make the
  // renderer offer manual ZIP migration for an installer update.
  if (!usesManagedPortablePackage()) {
    return {
      mode: 'installed',
      packageType: 'installer',
      canAutoReplace: false,
      requiresMigration: false,
      migrationReason: undefined,
      disposition: 'installer',
    };
  }

  const packageType = getPortableUpdatePackageType();
  const mode = getPortableDataMode();
  const liveLayout = process.platform === 'darwin' ? inspectPortableLayout() : null;
  const canAutoReplace = packageType === 'portable_zip'
    ? liveLayout?.canAutoReplace ?? canAutoReplacePortableUpdate()
    : true;
  const requiresMigration = packageType === 'portable_zip' && !canAutoReplace;
  const migrationReason = requiresMigration
    ? liveLayout?.reason ?? getPortableModeInfo().migrationReason
    : undefined;
  const disposition: UpdateDisposition = packageType === 'installer'
    ? 'installer'
    : canAutoReplace ? 'auto-replace' : 'manual-migration';
  return {
    mode,
    packageType,
    canAutoReplace,
    requiresMigration,
    migrationReason,
    disposition,
  };
}

function usesManagedPortablePackage(): boolean {
  // Packaged macOS builds have one update contract regardless of whether the
  // app was copied from a DMG, installed under /Applications, or extracted as
  // a USB ZIP. Keep the electron-updater path available in development so a
  // local renderer/main diagnostic does not unexpectedly call the managed
  // production API with a synthetic package identity.
  return process.platform === 'darwin'
    ? app.isPackaged
    : shouldUsePortableUpdatePackage();
}

export class AppUpdater extends EventEmitter {
  private mainWindow: BrowserWindow | null = null;
  private status: UpdateStatus = { status: 'idle', sequence: 0, ...updateMetadata() };
  private statusSequence = 0;
  private managedChannel: string;
  private autoInstallTimer: NodeJS.Timeout | null = null;
  private autoInstallCountdown = 0;

  /** Delay (in seconds) before auto-installing a downloaded update. */
  private static readonly AUTO_INSTALL_DELAY_SECONDS = 5;

  constructor() {
    super();

    // EventEmitter treats an unhandled 'error' event as fatal. Keep a default
    // listener so updater failures surface in logs/UI without terminating main.
    this.on('error', (error: Error) => {
      logger.error('[Updater] AppUpdater emitted error:', error);
    });
    
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    
    autoUpdater.logger = {
      info: (msg: string) => logger.info('[Updater]', msg),
      warn: (msg: string) => logger.warn('[Updater]', msg),
      error: (msg: string) => logger.error('[Updater]', msg),
      debug: (msg: string) => logger.debug('[Updater]', msg),
    };

    // Override feed URL for prerelease channels so that
    // alpha -> /alpha/alpha-mac.yml, beta -> /beta/beta-mac.yml, etc.
    const version = app.getVersion();
    const channel = detectChannel(version);
    this.managedChannel = normalizeUpdateChannel(channel);
    const feedUrl = `${getUpdateFeedBaseUrl()}/${channel}`;

    logger.info(`[Updater] Version: ${version}, channel: ${channel}, feedUrl: ${feedUrl}`);

    // Darwin managed updates never use electron-updater's generic feed (which
    // would probe latest-mac.yml/alpha-mac.yml). Keep that provider untouched
    // and route checks/downloads through the managed portable_zip API below.
    if (!usesManagedPortablePackage()) {
      // Set channel so electron-updater requests the correct yml filename.
      // e.g. channel "alpha" -> requests alpha-mac.yml.
      autoUpdater.channel = channel;
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: feedUrl,
        useMultipleRangeRequest: false,
      });
    }

    this.setupListeners();
  }

  /**
   * Set the main window for sending update events
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Get current update status
   */
  getStatus(): UpdateStatus {
    return this.status;
  }

  /**
   * Setup auto-updater event listeners
   */
  private setupListeners(): void {
    autoUpdater.on('checking-for-update', () => {
      this.updateStatus({
        status: 'checking',
        ...updateMetadata(),
        info: undefined,
        progress: undefined,
        error: undefined,
        downloadPath: undefined,
      });
      this.emit('checking-for-update');
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.updateStatus({
        status: 'available',
        ...updateMetadata(),
        info,
        progress: undefined,
        error: undefined,
        downloadPath: undefined,
      });
      this.emit('update-available', info);
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      this.updateStatus({
        status: 'not-available',
        ...updateMetadata(),
        info,
        progress: undefined,
        error: undefined,
        downloadPath: undefined,
      });
      this.emit('update-not-available', info);
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.updateStatus({ status: 'downloading', ...updateMetadata(), progress, error: undefined });
      this.emit('download-progress', progress);
    });

    autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
      this.updateStatus({ status: 'downloaded', ...updateMetadata(), info: event, error: undefined });
      this.emit('update-downloaded', event);
    });

    autoUpdater.on('error', (error: Error) => {
      // An updater error invalidates any in-flight artifact.  Do not leave a
      // previous downloaded path/info attached to an error status where a
      // delayed renderer install action could reuse it.
      this.updateStatus({
        status: 'error',
        ...updateMetadata(),
        info: undefined,
        progress: undefined,
        downloadPath: undefined,
        error: error.message,
      });
      this.emit('error', error);
    });
  }

  /**
   * Update status and notify renderer
   */
  private updateStatus(newStatus: Partial<UpdateStatus>): void {
    const has = (key: keyof UpdateStatus) => Object.prototype.hasOwnProperty.call(newStatus, key);
    const hasCompleteMetadata = [
      'mode',
      'packageType',
      'canAutoReplace',
      'requiresMigration',
      'disposition',
    ].every((key) => has(key as keyof UpdateStatus));
    // Callers handling a high-frequency progress stream pass one live metadata
    // snapshot through every event. Avoid synchronous filesystem inspection on
    // every ZIP chunk, especially when the portable root is a removable disk.
    const metadata = hasCompleteMetadata ? newStatus : updateMetadata();
    this.status = {
      status: newStatus.status ?? this.status.status,
      sequence: ++this.statusSequence,
      mode: newStatus.mode ?? metadata.mode,
      packageType: newStatus.packageType ?? metadata.packageType,
      canAutoReplace: newStatus.canAutoReplace ?? metadata.canAutoReplace,
      requiresMigration: newStatus.requiresMigration ?? metadata.requiresMigration,
      migrationReason: has('migrationReason') ? newStatus.migrationReason : metadata.migrationReason,
      disposition: newStatus.disposition ?? metadata.disposition,
      info: has('info') ? newStatus.info : this.status.info,
      progress: has('progress') ? newStatus.progress : this.status.progress,
      error: has('error') ? newStatus.error : this.status.error,
      downloadPath: has('downloadPath') ? newStatus.downloadPath : this.status.downloadPath,
    };
    this.sendToRenderer('update:status-changed', this.status);
  }

  /**
   * Send event to renderer process
   */
  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Check for updates.
   * electron-updater automatically tries providers defined in electron-builder.yml in order.
   *
   * In dev mode (not packed), autoUpdater.checkForUpdates() silently returns
   * null without emitting any events, so we must detect this and force a
   * final status so the UI never gets stuck in 'checking'.
   */
  async checkForUpdates(): Promise<UpdateInfo | PortableUpdateInfo | null> {
    if (usesManagedPortablePackage()) {
      return await this.checkPortableForUpdates();
    }

    try {
      const result = await autoUpdater.checkForUpdates();

      // In dev mode (app not packaged), autoUpdater silently returns null
      // without emitting ANY events (not even checking-for-update).
      // Detect this and force an error so the UI never stays silent.
      if (result == null) {
        this.updateStatus({
          status: 'error',
          ...updateMetadata(),
          info: undefined,
          progress: undefined,
          downloadPath: undefined,
          error: 'Update check skipped (dev mode – app is not packaged)',
        });
        return null;
      }

      // Safety net: if events somehow didn't fire, force a final state.
      if (this.status.status === 'checking' || this.status.status === 'idle') {
        this.updateStatus({ status: 'not-available' });
      }

      return result.updateInfo || null;
    } catch (error) {
      logger.error('[Updater] Check for updates failed:', error);
      this.updateStatus({
        status: 'error',
        ...updateMetadata(),
        info: undefined,
        progress: undefined,
        downloadPath: undefined,
        error: (error as Error).message || String(error),
      });
      throw error;
    }
  }

  /** Check the managed API for a verified USB ZIP update. */
  private async checkPortableForUpdates(): Promise<PortableUpdateInfo | null> {
    const timeout = createRequestTimeout(
      UCLAW_UPDATE_CHECK_TIMEOUT_MS,
      `Portable update check timed out after ${UCLAW_UPDATE_CHECK_TIMEOUT_MS}ms`,
    );
    try {
      this.updateStatus({
        status: 'checking',
        ...updateMetadata(),
        info: undefined,
        progress: undefined,
        error: undefined,
        downloadPath: undefined,
      });
      const currentVersion = app.getVersion();
      const channel = this.managedChannel || normalizeUpdateChannel(detectChannel(currentVersion));
      const url = getPortableLatestUpdateUrl();
      url.searchParams.set('channel', channel);
      url.searchParams.set('platform', platformForUpdateApi());
      url.searchParams.set('package_type', 'portable_zip');
      url.searchParams.set('arch', process.arch);

      const response = await proxyAwareFetch(url, { signal: timeout.controller.signal });
      if (!response.ok) {
        throw new Error(`Update check failed (${response.status})`);
      }

      const payload = await response.json() as BackendEnvelope<PortableUpdateInfo> | PortableUpdateInfo;
      if ('success' in payload && payload.success === false) {
        throw new Error(payload.message || 'Update check failed');
      }
      const info = 'data' in payload ? payload.data : payload;
      if (!isPortableUpdateInfo(info) || !info.version) {
        this.updateStatus({
          status: 'not-available',
          ...updateMetadata(),
          info: undefined,
          progress: undefined,
          error: undefined,
          downloadPath: undefined,
        });
        return null;
      }
      validatePortableUpdateIdentity(info, platformForUpdateApi(), process.arch);
      if (comparePortableUpdateVersions(info.version, currentVersion) <= 0) {
        this.updateStatus({
          status: 'not-available',
          ...updateMetadata(),
          info,
          progress: undefined,
          error: undefined,
          downloadPath: undefined,
        });
        return info;
      }
      validatePortableUpdateArtifact(info);

      this.updateStatus({
        status: 'available',
        ...updateMetadata(),
        info,
        progress: undefined,
        error: undefined,
        downloadPath: undefined,
      });
      return info;
    } catch (error) {
      const failure = timeout.controller.signal.aborted && timeout.controller.signal.reason instanceof Error
        ? timeout.controller.signal.reason
        : error;
      logger.error('[Updater] Portable update check failed:', failure);
      this.updateStatus({
        status: 'error',
        ...updateMetadata(),
        info: undefined,
        progress: undefined,
        downloadPath: undefined,
        error: (failure as Error).message || String(failure),
      });
      throw failure;
    } finally {
      timeout.dispose();
    }
  }

  /**
   * Download available update
   */
  async downloadUpdate(): Promise<{ downloadPath?: string }> {
    if (usesManagedPortablePackage()) {
      return await this.downloadPortableUpdate();
    }

    try {
      await autoUpdater.downloadUpdate();
      return {};
    } catch (error) {
      logger.error('[Updater] Download update failed:', error);
      this.updateStatus({
        status: 'error',
        ...updateMetadata(),
        info: undefined,
        progress: undefined,
        downloadPath: undefined,
        error: (error as Error).message || String(error),
      });
      throw error;
    }
  }

  /** Download and verify a USB ZIP before making it installable. */
  private async downloadPortableUpdate(): Promise<{ downloadPath: string }> {
    let partialPathToCleanup: string | null = null;
    const timeout = createRequestTimeout(
      UCLAW_UPDATE_DOWNLOAD_TIMEOUT_MS,
      `Portable update download timed out after ${UCLAW_UPDATE_DOWNLOAD_TIMEOUT_MS}ms`,
    );
    try {
      // Only reuse metadata that was explicitly presented as available.  A
      // not-available response intentionally keeps its info payload for
      // diagnostics/UI, but that payload must never become an implicit
      // download authorization if a stale renderer/IPC call arrives later.
      const cachedInfo = this.status.status === 'available' && isPortableUpdateInfo(this.status.info)
        ? this.status.info
        : undefined;
      const info = cachedInfo ?? await this.checkPortableForUpdates();
      if (!isPortableUpdateInfo(info)) {
        throw new Error('Portable update metadata is not available');
      }
      if (comparePortableUpdateVersions(info.version, app.getVersion()) <= 0) {
        throw new Error(`Portable update ${info.version} is not newer than the current version ${app.getVersion()}`);
      }
      // Revalidate the complete artifact identity at download time as well as
      // during the check. Status can be restored from renderer/IPC state or a
      // stale response, and an architecture/platform swap must never reach the
      // filesystem even if the package family still says portable_zip.
      validatePortableUpdateIdentity(info, platformForUpdateApi(), process.arch);
      const artifact = validatePortableUpdateArtifact(info);

      const updatesDir = getPortableUpdatesDir();
      if (!updatesDir) {
        throw new Error('Portable updates directory is not available');
      }
      await mkdir(updatesDir, { recursive: true });

      const response = await proxyAwareFetch(artifact.downloadUrl, { signal: timeout.controller.signal });
      if (!response.ok || !response.body) {
        throw new Error(`Download failed (${response.status})`);
      }

      const filename = filenameFromPortableUpdateInfo(
        { ...info, downloadUrl: artifact.downloadUrl },
        platformForUpdateApi(),
        process.arch,
      );
      assertPortableUpdateZipFilename(filename);
      const targetPath = join(updatesDir, filename);
      // Give each download attempt its own staging file. A user can click
      // Download twice (or a stale renderer request can overlap a retry); a
      // shared `.download` path would let one attempt truncate/remove the
      // other's bytes before either checksum is evaluated.
      const partialPath = `${targetPath}.download-${randomUUID()}`;
      partialPathToCleanup = partialPath;
      await rm(partialPath, { force: true });
      const headers = response.headers as unknown as { get: (name: string) => string | null };
      const total = Number.parseInt(headers.get('content-length') || '0', 10) || 0;
      let transferred = 0;
      let lastTransferred = 0;
      let lastTimestamp = Date.now();
      const downloadMetadata = updateMetadata();

      this.updateStatus({
        status: 'downloading',
        ...downloadMetadata,
        info,
        progress: {
          total,
          delta: 0,
          transferred: 0,
          percent: 0,
          bytesPerSecond: 0,
        },
        error: undefined,
        downloadPath: undefined,
      });

      const bodyStream = Readable.fromWeb(
        response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      );
      bodyStream.on('data', (chunk: Buffer | string) => {
        const delta = Buffer.byteLength(chunk);
        transferred += delta;
        const now = Date.now();
        const elapsedSeconds = Math.max((now - lastTimestamp) / 1000, 0.001);
        const bytesPerSecond = Math.round((transferred - lastTransferred) / elapsedSeconds);
        lastTimestamp = now;
        lastTransferred = transferred;
        this.updateStatus({
          status: 'downloading',
          ...downloadMetadata,
          info,
          progress: {
            total,
            delta,
            transferred,
            percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 0,
            bytesPerSecond,
          },
        });
      });

      await pipeline(bodyStream, createWriteStream(partialPath));
      const verified = await verifyPortableUpdatePackage(partialPath, artifact);
      await replaceDownloadedUpdateAtomically(partialPath, targetPath);
      partialPathToCleanup = null;
      this.updateStatus({
        status: 'downloaded',
        ...updateMetadata(),
        info,
        downloadPath: targetPath,
        progress: {
          total: total || verified.size,
          delta: 0,
          transferred: verified.size,
          percent: 100,
          bytesPerSecond: 0,
        },
      });
      return { downloadPath: targetPath };
    } catch (error) {
      if (partialPathToCleanup) {
        await rm(partialPathToCleanup, { force: true }).catch(() => {});
      }
      const failure = timeout.controller.signal.aborted && timeout.controller.signal.reason instanceof Error
        ? timeout.controller.signal.reason
        : error;
      logger.error('[Updater] Portable update download failed:', failure);
      this.updateStatus({
        status: 'error',
        ...updateMetadata(),
        info: undefined,
        progress: undefined,
        downloadPath: undefined,
        error: (failure as Error).message || String(failure),
      });
      throw failure;
    } finally {
      timeout.dispose();
    }
  }

  /**
   * Install update and restart.
   *
   * On macOS, electron-updater delegates to Squirrel.Mac (ShipIt). The
   * native quitAndInstall() spawns ShipIt then internally calls app.quit().
   * However, the tray close handler in index.ts intercepts window close
   * and hides to tray unless isQuitting is true. Squirrel's internal quit
   * sometimes fails to trigger before-quit in time, so we set isQuitting
   * BEFORE calling quitAndInstall(). This lets the native quit flow close
   * the window cleanly while ShipIt runs independently to replace the app.
   */
  quitAndInstall(): void {
    if (usesManagedPortablePackage()) {
      void this.installPortableUpdate().catch(() => {});
      return;
    }

    logger.info('[Updater] quitAndInstall called');
    setQuitting();
    autoUpdater.quitAndInstall();
  }

  async installDownloadedUpdate(): Promise<void> {
    if (usesManagedPortablePackage()) {
      await this.installPortableUpdate();
      return;
    }
    this.quitAndInstall();
  }

  /** Launch the external helper so the running portable executable can be replaced safely. */
  private async installPortableUpdate(): Promise<void> {
    // Keep track of whether the package has passed the same integrity checks
    // used by the downloader.  A failed metadata/integrity check must not
    // reveal a potentially tampered ZIP from the cache in the error handler.
    let verifiedPackage = false;
    try {
      if (this.status.status !== 'downloaded') {
        throw new Error(`Portable update is not ready to install (status: ${this.status.status})`);
      }
      const offeredDisposition = this.status.disposition;
      const info = this.status.info;
      if (!isPortableUpdateInfo(info)) {
        throw new Error('Portable update metadata is not available');
      }
      if (!this.status.downloadPath) {
        throw new Error('Portable update package has not been downloaded');
      }

      // The autoUpdater event surface remains registered for compatibility,
      // even though packaged macOS builds do not use its feed.  Fail closed if
      // an unexpected/stale event populates a downloaded status with installer
      // metadata or an artifact for another platform/architecture.
      validatePortableUpdateIdentity(info, platformForUpdateApi(), process.arch);
      const artifact = validatePortableUpdateIntegrity(info);
      const currentVersion = app.getVersion();
      if (comparePortableUpdateVersions(info.version, currentVersion) <= 0) {
        throw new Error(`Portable update ${info.version} is not newer than the current version ${currentVersion}`);
      }

      // Manual migration does not invoke the Go helper, so re-verify the file
      // here before revealing it to the user.  The helper repeats this check
      // for the in-place replacement path.
      await verifyPortableUpdatePackage(this.status.downloadPath, {
        sha512: artifact.sha512,
        size: artifact.size,
      });
      verifiedPackage = true;

      const metadata = updateMetadata();
      this.updateStatus({ status: 'downloaded', ...metadata });

      // A macOS app copied from a DMG or placed in /Applications still uses
      // the portable ZIP feed, but it has no safe in-place replacement root.
      // Reveal the verified package and let the user perform a full extract
      // and data migration instead of creating UClawData beside the app.
      // The disposition captured when the download was presented is an
      // explicit authorization for the in-place replacement path.  Do not
      // infer that authorization from a fresh writable-layout probe: a stale
      // or hand-crafted `downloaded` status (for example from delayed IPC)
      // may omit the field or carry an installer/manual disposition.  Such
      // artifacts are still safe to expose after verification, but require
      // the user to perform the complete extraction/migration flow.
      if (
        offeredDisposition !== 'auto-replace'
        || metadata.disposition !== 'auto-replace'
        || metadata.packageType !== 'portable_zip'
        || !metadata.canAutoReplace
        || metadata.requiresMigration
      ) {
        logger.info('[Updater] Portable package requires manual migration; opening downloaded package');
        await this.openDownloadedUpdate();
        return;
      }

      // `getPortableModeInfo()` is intentionally cached for runtime path
      // stability, while the replacement gate above is a fresh filesystem
      // probe.  If a user completes a portable root during this process
      // lifetime, avoid advertising auto-replace unless the runtime cache has
      // also observed that root; otherwise the installer cannot construct its
      // task workspace safely.
      if (metadata.packageType === 'portable_zip') {
        const runtimeMode = getPortableModeInfo();
        if (!runtimeMode.enabled || !runtimeMode.runtimeUpdatesDir || !runtimeMode.rootDir) {
          throw new Error('Portable runtime is not initialized for in-place replacement; manual migration is required');
        }
      }

      logger.info(`[Updater] Installing portable update v${info.version} from ${this.status.downloadPath}`);
      await launchPortableUpdateInstaller(this.status.downloadPath, {
        version: info.version,
        sha512: artifact.sha512,
        size: artifact.size,
      });
    } catch (error) {
      logger.error('[Updater] Portable update install failed:', error);
      this.updateStatus({
        status: 'error',
        ...updateMetadata(),
        ...(verifiedPackage
          ? {}
          : {
              info: undefined,
              progress: undefined,
              downloadPath: undefined,
            }),
        error: (error as Error).message || String(error),
      });
      if (verifiedPackage) {
        await this.openDownloadedUpdate().catch((openError) => {
          logger.warn('[Updater] Failed to open downloaded portable update after install error:', openError);
        });
      }
      throw error;
    }
  }

  async openDownloadedUpdate(): Promise<void> {
    if (this.status.downloadPath) {
      shell.showItemInFolder(this.status.downloadPath);
      return;
    }
    const updatesDir = getPortableUpdatesDir();
    if (updatesDir) {
      await shell.openPath(updatesDir);
    }
  }

  /**
   * Start a countdown that auto-installs the downloaded update.
   * Sends `update:auto-install-countdown` events to the renderer each second.
   */
  startAutoInstallCountdown(): void {
    this.clearAutoInstallTimer();
    // A countdown is an install authorization, not merely a UI animation.
    // Refuse to create one for an idle/available/error status or for a
    // downloaded portable status that has no verified artifact path.  This
    // protects against delayed renderer events and stale IPC calls invoking
    // the method after a newer check has invalidated the package.
    if (this.status.status !== 'downloaded') {
      logger.warn(`[Updater] Ignoring auto-install countdown for status ${this.status.status}`);
      this.sendToRenderer('update:auto-install-countdown', {
        seconds: -1,
        cancelled: true,
        sequence: this.status.sequence,
      });
      return;
    }

    const offeredDisposition = this.status.disposition;
    const metadata = updateMetadata();
    this.updateStatus({ ...metadata });

    if (this.status.status !== 'downloaded') {
      logger.warn('[Updater] Auto-install countdown lost its downloaded state during metadata refresh');
      this.sendToRenderer('update:auto-install-countdown', {
        seconds: -1,
        cancelled: true,
        sequence: this.status.sequence,
      });
      return;
    }

    if (this.status.packageType === 'portable_zip'
      && (!this.status.downloadPath || !isPortableUpdateInfo(this.status.info))) {
      logger.warn('[Updater] Ignoring portable auto-install countdown without a downloaded artifact');
      this.sendToRenderer('update:auto-install-countdown', {
        seconds: -1,
        cancelled: true,
        sequence: this.status.sequence,
      });
      return;
    }

    // A portable countdown is an authorization to launch the replacement
    // helper.  Treat every disposition other than an explicit, matching
    // auto-replace authorization as manual migration.  In particular, an old
    // or delayed `downloaded` status may omit `disposition`; a writable layout
    // probe alone must never turn that status into an automatic replacement.
    const portableAutoReplaceAuthorized = this.status.packageType !== 'portable_zip'
      || (
        offeredDisposition === 'auto-replace'
        && metadata.disposition === 'auto-replace'
        && metadata.canAutoReplace
        && !metadata.requiresMigration
      );
    if (!portableAutoReplaceAuthorized) {
      this.sendToRenderer('update:auto-install-countdown', {
        seconds: -1,
        cancelled: true,
        sequence: this.status.sequence,
      });
      void this.openDownloadedUpdate();
      return;
    }
    this.autoInstallCountdown = AppUpdater.AUTO_INSTALL_DELAY_SECONDS;
    // Keep the sequence tied to the downloaded artifact that authorized this
    // timer. Subsequent status transitions (for example a fresh check) must
    // not make an old countdown look current merely because the interval is
    // still running.
    const countdownSequence = this.status.sequence;
    this.sendToRenderer('update:auto-install-countdown', {
      seconds: this.autoInstallCountdown,
      sequence: countdownSequence,
    });

    this.autoInstallTimer = setInterval(() => {
      // Any newer status sequence supersedes the artifact that authorized this
      // timer.  Stop before calling quitAndInstall so a stale countdown cannot
      // install a package after a fresh check/download/error transition.
      if (this.status.status !== 'downloaded' || this.status.sequence !== countdownSequence) {
        this.clearAutoInstallTimer();
        this.sendToRenderer('update:auto-install-countdown', {
          seconds: -1,
          cancelled: true,
          sequence: this.status.sequence,
        });
        return;
      }
      this.autoInstallCountdown--;
      this.sendToRenderer('update:auto-install-countdown', {
        seconds: this.autoInstallCountdown,
        sequence: countdownSequence,
      });

      if (this.autoInstallCountdown <= 0) {
        this.clearAutoInstallTimer();
        // Re-check the sequence immediately before handing control to the
        // installer; updateStatus may have run between the interval callback
        // and this branch in a re-entrant event loop.
        if (this.status.status === 'downloaded' && this.status.sequence === countdownSequence) {
          this.quitAndInstall();
        }
      }
    }, 1000);
  }

  cancelAutoInstall(): void {
    this.clearAutoInstallTimer();
    this.sendToRenderer('update:auto-install-countdown', {
      seconds: -1,
      cancelled: true,
      sequence: this.status.sequence,
    });
  }

  private clearAutoInstallTimer(): void {
    if (this.autoInstallTimer) {
      clearInterval(this.autoInstallTimer);
      this.autoInstallTimer = null;
    }
  }

  /**
   * Set update channel (stable, beta, dev)
   */
  setChannel(channel: 'stable' | 'beta' | 'dev'): void {
    this.managedChannel = normalizeUpdateChannel(channel);
    autoUpdater.channel = channel;
  }

  /**
   * Set auto-download preference.
   *
   * ClawX uses a prompt-first update flow: finding an update shows a UI prompt,
   * and downloads/installations only start after the user chooses an action.
   * Keep this legacy IPC method as a no-op-compatible setter so stale renderer
   * settings cannot re-enable electron-updater's implicit auto-download path.
   */
  setAutoDownload(_enable: boolean): void {
    autoUpdater.autoDownload = false;
  }

  /**
   * Get current version
   */
  getCurrentVersion(): string {
    return app.getVersion();
  }
}

/**
 * Register IPC handlers for update operations
 */
export function registerUpdateHandlers(
  updater: AppUpdater,
  mainWindow: BrowserWindow
): void {
  updater.setMainWindow(mainWindow);

  // Get current update status
  ipcMain.handle('update:status', () => {
    return updater.getStatus();
  });

  // Get current version
  ipcMain.handle('update:version', () => {
    return updater.getCurrentVersion();
  });

  // Check for updates – always return final status so the renderer
  // never gets stuck in 'checking' waiting for a push event.
  ipcMain.handle('update:check', async () => {
    try {
      await updater.checkForUpdates();
      return { success: true, status: updater.getStatus() };
    } catch (error) {
      return { success: false, error: String(error), status: updater.getStatus() };
    }
  });

  // Download update
  ipcMain.handle('update:download', async () => {
    try {
      const result = await updater.downloadUpdate();
      return { success: true, ...result, status: updater.getStatus() };
    } catch (error) {
      return { success: false, error: String(error), status: updater.getStatus() };
    }
  });

  // Install update and restart
  ipcMain.handle('update:install', async () => {
    try {
      await updater.installDownloadedUpdate();
      return { success: true, status: updater.getStatus() };
    } catch (error) {
      return { success: false, error: String(error), status: updater.getStatus() };
    }
  });

  // Set update channel
  ipcMain.handle('update:setChannel', (_, channel: 'stable' | 'beta' | 'dev') => {
    updater.setChannel(channel);
    return { success: true };
  });

  // Set auto-download preference
  ipcMain.handle('update:setAutoDownload', (_, enable: boolean) => {
    updater.setAutoDownload(enable);
    return { success: true };
  });

  // Cancel pending auto-install countdown
  ipcMain.handle('update:cancelAutoInstall', () => {
    updater.cancelAutoInstall();
    return { success: true };
  });

}

// Export singleton instance
export const appUpdater = new AppUpdater();
