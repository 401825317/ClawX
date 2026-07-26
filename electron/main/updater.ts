/**
 * Auto-Updater Module
 * Handles automatic application updates using electron-updater
 *
 * Installed builds use electron-updater against the managed UClaw feed.
 * Windows USB builds use the managed portable update API and a verified ZIP.
 */
import { autoUpdater, UpdateInfo, ProgressInfo, UpdateDownloadedEvent } from 'electron-updater';
import { BrowserWindow, app, ipcMain, shell } from 'electron';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  UCLAW_UPDATE_CHECK_TIMEOUT_MS,
  UCLAW_UPDATE_DOWNLOAD_TIMEOUT_MS,
  UCLAW_UPDATE_ROUTES,
} from '../../shared/junfeiai-endpoints';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';
import { getUclawBackendOrigin } from '../utils/junfeiai-distribution';
import { getPortableUpdatesDir, isPortableMode } from '../utils/portable-mode';
import { proxyAwareFetch } from '../utils/proxy-fetch';
import { setQuitting } from './app-state';
import { launchPortableUpdateInstaller } from './portable-update-installer';
import {
  assertPortableUpdateZipFilename,
  comparePortableUpdateVersions,
  filenameFromPortableUpdateInfo,
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
      this.updateStatus({
        status: 'checking',
        mode: 'installed',
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
        mode: 'installed',
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
        mode: 'installed',
        info,
        progress: undefined,
        error: undefined,
        downloadPath: undefined,
      });
      this.emit('update-not-available', info);
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.updateStatus({ status: 'downloading', mode: 'installed', progress, error: undefined });
      this.emit('download-progress', progress);
    });

    autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
      this.updateStatus({ status: 'downloaded', mode: 'installed', info: event, error: undefined });
      this.emit('update-downloaded', event);
    });

    autoUpdater.on('error', (error: Error) => {
      this.updateStatus({ status: 'error', mode: 'installed', error: error.message });
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

  /** Check the managed API for a verified USB ZIP update. */
  private async checkPortableForUpdates(): Promise<PortableUpdateInfo | null> {
    const timeout = createRequestTimeout(
      UCLAW_UPDATE_CHECK_TIMEOUT_MS,
      `Portable update check timed out after ${UCLAW_UPDATE_CHECK_TIMEOUT_MS}ms`,
    );
    try {
      this.updateStatus({
        status: 'checking',
        mode: 'portable',
        info: undefined,
        progress: undefined,
        error: undefined,
        downloadPath: undefined,
      });
      const currentVersion = app.getVersion();
      const channel = normalizeUpdateChannel(detectChannel(currentVersion));
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
          mode: 'portable',
          info: undefined,
          progress: undefined,
          error: undefined,
          downloadPath: undefined,
        });
        return null;
      }
      if (comparePortableUpdateVersions(info.version, currentVersion) <= 0) {
        this.updateStatus({
          status: 'not-available',
          mode: 'portable',
          info,
          progress: undefined,
          error: undefined,
          downloadPath: undefined,
        });
        return info;
      }

      this.updateStatus({
        status: 'available',
        mode: 'portable',
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
        mode: 'portable',
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

  /** Download and verify a USB ZIP before making it installable. */
  private async downloadPortableUpdate(): Promise<{ downloadPath: string }> {
    let partialPathToCleanup: string | null = null;
    const timeout = createRequestTimeout(
      UCLAW_UPDATE_DOWNLOAD_TIMEOUT_MS,
      `Portable update download timed out after ${UCLAW_UPDATE_DOWNLOAD_TIMEOUT_MS}ms`,
    );
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

      const response = await proxyAwareFetch(downloadUrl, { signal: timeout.controller.signal });
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
      const headers = response.headers as unknown as { get: (name: string) => string | null };
      const total = Number.parseInt(headers.get('content-length') || '0', 10) || 0;
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
      await rm(targetPath, { force: true });
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
      const failure = timeout.controller.signal.aborted && timeout.controller.signal.reason instanceof Error
        ? timeout.controller.signal.reason
        : error;
      logger.error('[Updater] Portable update download failed:', failure);
      this.updateStatus({
        status: 'error',
        mode: 'portable',
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

  /** Launch the external helper so the running portable executable can be replaced safely. */
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
  startAutoInstallCountdown(): void {
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
