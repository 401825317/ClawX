/**
 * Auto-Updater Module
 * Handles automatic application updates using electron-updater
 *
 * Update providers are configured in electron-builder.yml (OSS primary, GitHub fallback).
 * For prerelease channels (alpha, beta), the feed URL is overridden at runtime
 * to point at the channel-specific OSS directory (e.g. /alpha/, /beta/).
 */
import { autoUpdater, UpdateInfo, ProgressInfo, UpdateDownloadedEvent } from 'electron-updater';
import { BrowserWindow, app, ipcMain, shell } from 'electron';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';
import { setQuitting } from './app-state';
import { getJunFeiAIBackendOrigin } from '../utils/junfeiai-distribution';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getPortableUpdatesDir, isPortableMode } from '../utils/portable-mode';
import { proxyAwareFetch } from '../utils/proxy-fetch';
import {
  assertPortableUpdateZipFilename,
  filenameFromPortableUpdateInfo,
  verifyPortableUpdatePackage,
} from './portable-update-security';
import { launchPortableUpdateInstaller } from './portable-update-installer';

/** Base update feed URL (without trailing channel path). */
function getUpdateFeedBaseUrl(): string {
  return (
    process.env.CLAWX_UPDATE_FEED_BASE_URL
    || `${getJunFeiAIBackendOrigin()}/api/clawx/updates/feed`
  ).replace(/\/+$/, '');
}

function getUpdateApiBaseUrl(): string {
  return (
    process.env.CLAWX_UPDATE_API_BASE_URL
    || `${getJunFeiAIBackendOrigin()}/api/clawx/updates`
  ).replace(/\/+$/, '');
}

export interface UpdateStatus {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  mode?: 'installed' | 'portable';
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

function isPortableUpdateInfo(value: unknown): value is PortableUpdateInfo {
  return Boolean(
    value
      && typeof value === 'object'
      && typeof (value as PortableUpdateInfo).version === 'string',
  );
}

function compareSemverLike(a: string, b: string): number {
  const parse = (value: string) => value
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export class AppUpdater extends EventEmitter {
  private mainWindow: BrowserWindow | null = null;
  private status: UpdateStatus = { status: 'idle', mode: isPortableMode() ? 'portable' : 'installed' };
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
    const feedUrl = `${getUpdateFeedBaseUrl()}/${channel}`;

    logger.info(`[Updater] Version: ${version}, channel: ${channel}, feedUrl: ${feedUrl}`);

    // Set channel so electron-updater requests the correct yml filename.
    // e.g. channel "alpha" → requests alpha-mac.yml, channel "latest" → requests latest-mac.yml
    autoUpdater.channel = channel;

    autoUpdater.setFeedURL({
      provider: 'generic',
      url: feedUrl,
      useMultipleRangeRequest: false,
    });

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
      this.updateStatus({ status: 'checking' });
      this.emit('checking-for-update');
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.updateStatus({ status: 'available', info });
      this.emit('update-available', info);
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      this.updateStatus({ status: 'not-available', info });
      this.emit('update-not-available', info);
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.updateStatus({ status: 'downloading', progress });
      this.emit('download-progress', progress);
    });

    autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
      this.updateStatus({ status: 'downloaded', info: event });
      this.emit('update-downloaded', event);
    });

    autoUpdater.on('error', (error: Error) => {
      this.updateStatus({ status: 'error', error: error.message });
      this.emit('error', error);
    });
  }

  /**
   * Update status and notify renderer
   */
  private updateStatus(newStatus: Partial<UpdateStatus>): void {
    const has = (key: keyof UpdateStatus) => Object.prototype.hasOwnProperty.call(newStatus, key);
    this.status = {
      status: newStatus.status ?? this.status.status,
      mode: newStatus.mode ?? this.status.mode ?? (isPortableMode() ? 'portable' : 'installed'),
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
    if (isPortableMode()) {
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
      this.updateStatus({ status: 'error', error: (error as Error).message || String(error) });
      throw error;
    }
  }

  private async checkPortableForUpdates(): Promise<PortableUpdateInfo | null> {
    try {
      this.updateStatus({ status: 'checking', mode: 'portable', progress: undefined, error: undefined });
      const currentVersion = app.getVersion();
      const channel = normalizeUpdateChannel(detectChannel(currentVersion));
      const platform = platformForUpdateApi();
      const url = new URL(`${getUpdateApiBaseUrl()}/latest`);
      url.searchParams.set('channel', channel);
      url.searchParams.set('platform', platform);
      url.searchParams.set('package_type', 'portable_zip');
      url.searchParams.set('arch', process.arch);

      const response = await proxyAwareFetch(url);
      if (!response.ok) {
        throw new Error(`Update check failed (${response.status})`);
      }

      const envelope = await response.json() as BackendEnvelope<PortableUpdateInfo>;
      if (envelope.success === false) {
        throw new Error(envelope.message || 'Update check failed');
      }
      const info = envelope.data;
      if (!isPortableUpdateInfo(info) || !info.version) {
        this.updateStatus({ status: 'not-available', mode: 'portable', info: undefined });
        return null;
      }
      if (compareSemverLike(info.version, currentVersion) <= 0) {
        this.updateStatus({ status: 'not-available', mode: 'portable', info });
        return info;
      }

      this.updateStatus({ status: 'available', mode: 'portable', info });
      return info;
    } catch (error) {
      logger.error('[Updater] Portable update check failed:', error);
      this.updateStatus({
        status: 'error',
        mode: 'portable',
        error: (error as Error).message || String(error),
      });
      throw error;
    }
  }

  /**
   * Download available update
   */
  async downloadUpdate(): Promise<{ downloadPath?: string }> {
    if (isPortableMode()) {
      return await this.downloadPortableUpdate();
    }

    try {
      await autoUpdater.downloadUpdate();
      return {};
    } catch (error) {
      logger.error('[Updater] Download update failed:', error);
      throw error;
    }
  }

  private async downloadPortableUpdate(): Promise<{ downloadPath: string }> {
    let partialPathToCleanup: string | null = null;
    try {
      const info = isPortableUpdateInfo(this.status.info)
        ? this.status.info
        : await this.checkPortableForUpdates();
      const downloadUrl = info?.downloadUrl || info?.download_url;
      if (!isPortableUpdateInfo(info) || !downloadUrl) {
        throw new Error('No portable update download URL is available');
      }
      if ((info.packageType || info.package_type) !== 'portable_zip') {
        throw new Error('Portable update metadata must use package_type=portable_zip');
      }

      const updatesDir = getPortableUpdatesDir();
      if (!updatesDir) {
        throw new Error('Portable updates directory is not available');
      }
      await mkdir(updatesDir, { recursive: true });

      const response = await proxyAwareFetch(downloadUrl);
      if (!response.ok || !response.body) {
        throw new Error(`Download failed (${response.status})`);
      }

      const filename = filenameFromPortableUpdateInfo(
        { ...info, downloadUrl },
        platformForUpdateApi(),
        process.arch,
      );
      assertPortableUpdateZipFilename(filename);
      const targetPath = join(updatesDir, filename);
      const partialPath = `${targetPath}.download`;
      partialPathToCleanup = partialPath;
      await rm(partialPath, { force: true });
      const total = Number.parseInt(response.headers.get('content-length') || '0', 10) || 0;
      let transferred = 0;
      let lastTransferred = 0;
      let lastTimestamp = Date.now();

      this.updateStatus({
        status: 'downloading',
        mode: 'portable',
        info,
        progress: {
          total,
          delta: 0,
          transferred: 0,
          percent: 0,
          bytesPerSecond: 0,
        },
      });

      const bodyStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
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
          mode: 'portable',
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
      const verified = await verifyPortableUpdatePackage(partialPath, info);
      await rename(partialPath, targetPath);
      partialPathToCleanup = null;
      this.updateStatus({
        status: 'downloaded',
        mode: 'portable',
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
      logger.error('[Updater] Portable update download failed:', error);
      this.updateStatus({
        status: 'error',
        mode: 'portable',
        error: (error as Error).message || String(error),
      });
      throw error;
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
    if (isPortableMode()) {
      void this.installPortableUpdate().catch(() => {});
      return;
    }

    logger.info('[Updater] quitAndInstall called');
    setQuitting();
    autoUpdater.quitAndInstall();
  }

  async installDownloadedUpdate(): Promise<void> {
    if (isPortableMode()) {
      await this.installPortableUpdate();
      return;
    }
    this.quitAndInstall();
  }

  private async installPortableUpdate(): Promise<void> {
    try {
      const info = this.status.info;
      if (!isPortableUpdateInfo(info)) {
        throw new Error('Portable update metadata is not available');
      }
      if (!this.status.downloadPath) {
        throw new Error('Portable update package has not been downloaded');
      }

      logger.info(`[Updater] Installing portable update v${info.version} from ${this.status.downloadPath}`);
      await launchPortableUpdateInstaller(this.status.downloadPath, {
        version: info.version,
        sha512: info.sha512,
        size: info.size,
      });
    } catch (error) {
      logger.error('[Updater] Portable update install failed:', error);
      this.updateStatus({
        status: 'error',
        mode: 'portable',
        error: (error as Error).message || String(error),
      });
      await this.openDownloadedUpdate().catch((openError) => {
        logger.warn('[Updater] Failed to open downloaded portable update after install error:', openError);
      });
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
  private startAutoInstallCountdown(): void {
    this.clearAutoInstallTimer();
    this.autoInstallCountdown = AppUpdater.AUTO_INSTALL_DELAY_SECONDS;
    this.sendToRenderer('update:auto-install-countdown', { seconds: this.autoInstallCountdown });

    this.autoInstallTimer = setInterval(() => {
      this.autoInstallCountdown--;
      this.sendToRenderer('update:auto-install-countdown', { seconds: this.autoInstallCountdown });

      if (this.autoInstallCountdown <= 0) {
        this.clearAutoInstallTimer();
        this.quitAndInstall();
      }
    }, 1000);
  }

  cancelAutoInstall(): void {
    this.clearAutoInstallTimer();
    this.sendToRenderer('update:auto-install-countdown', { seconds: -1, cancelled: true });
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
      return { success: false, error: String(error) };
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
