/**
 * Update State Store
 * Manages application update state
 */
import { create } from 'zustand';
import { useSettingsStore } from './settings';
import { hostApi } from '@/lib/host-api';
import { hostEvents } from '@/lib/host-events';
import type {
  UpdateChannel,
  UpdateInfoSnapshot,
  UpdateMode,
  UpdateProgressSnapshot,
  UpdateStatusSnapshot,
} from '@shared/host-api/contract';
import { UCLAW_UPDATE_CHECK_TIMEOUT_MS } from '@shared/junfeiai-endpoints';

export type UpdateInfo = UpdateInfoSnapshot;
export type ProgressInfo = UpdateProgressSnapshot;
export type UpdateStatus = UpdateStatusSnapshot['status'];

interface UpdateState {
  status: UpdateStatus;
  mode: UpdateMode;
  currentVersion: string;
  updateInfo: UpdateInfo | null;
  progress: ProgressInfo | null;
  error: string | null;
  downloadPath: string | null;
  isInitialized: boolean;
  /** Seconds remaining before auto-install, or null if inactive. */
  autoInstallCountdown: number | null;

  // Actions
  init: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  cancelAutoInstall: () => Promise<void>;
  setChannel: (channel: UpdateChannel) => Promise<void>;
  setAutoDownload: (enable: boolean) => Promise<void>;
  clearError: () => void;
}

let updateInitPromise: Promise<void> | null = null;

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: 'idle',
  mode: 'installed',
  currentVersion: '0.0.0',
  updateInfo: null,
  progress: null,
  error: null,
  downloadPath: null,
  isInitialized: false,
  autoInstallCountdown: null,

  init: async () => {
    if (get().isInitialized) return;
    if (updateInitPromise) return updateInitPromise;

    updateInitPromise = (async () => {
      // Get current version
      try {
        const version = await hostApi.updates.version();
        set({ currentVersion: version });
      } catch (error) {
        console.error('Failed to get version:', error);
      }

      // Get current status
      try {
        const status = await hostApi.updates.status();
        set({
          status: status.status,
          mode: status.mode || 'installed',
          updateInfo: status.info || null,
          progress: status.progress || null,
          error: status.error || null,
          downloadPath: status.downloadPath || null,
        });
      } catch (error) {
        console.error('Failed to get update status:', error);
      }

      // Listen for update events
      // Single source of truth: listen only to update:status-changed
      // (sent by AppUpdater.updateStatus() in the main process)
      hostEvents.onUpdateStatusChanged((status) => {
        set({
          status: status.status,
          mode: status.mode || get().mode,
          updateInfo: status.info || null,
          progress: status.progress || null,
          error: status.error || null,
          downloadPath: status.downloadPath || null,
        });
      });

      hostEvents.onUpdateAutoInstallCountdown(({ seconds, cancelled }) => {
        set({ autoInstallCountdown: cancelled ? null : seconds });
      });

      // New default is prompt-first: never auto-download/install unless the
      // user explicitly chooses Download from the notification or Settings.
      void hostApi.updates.setAutoDownload(false).catch(() => {});

      set({ isInitialized: true });

      // Auto-check for updates on startup (respects user toggle)
      const autoCheckUpdate = useSettingsStore.getState().autoCheckUpdate;
      if (autoCheckUpdate) {
        setTimeout(() => {
          get().checkForUpdates().catch(() => {});
        }, 10000);
      }
    })();

    try {
      await updateInitPromise;
    } finally {
      if (!get().isInitialized) {
        updateInitPromise = null;
      }
    }
  },

  checkForUpdates: async () => {
    set({ status: 'checking', error: null });
    
    try {
      const result = await Promise.race([
        hostApi.updates.check(),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error('Update check timed out')),
          UCLAW_UPDATE_CHECK_TIMEOUT_MS,
        )),
      ]);
      
      if (result.status) {
        set({
          status: result.status.status,
          mode: result.status.mode || get().mode,
          updateInfo: result.status.info || null,
          progress: result.status.progress || null,
          error: result.status.error || null,
          downloadPath: result.status.downloadPath || null,
        });
      } else if (!result.success) {
        set({ status: 'error', error: result.error || 'Failed to check for updates' });
      }
    } catch (error) {
      set({ status: 'error', error: String(error) });
    } finally {
      // In dev mode autoUpdater skips without emitting events, so the
      // status may still be 'checking' or even 'idle'. Catch both.
      const currentStatus = get().status;
      if (currentStatus === 'checking' || currentStatus === 'idle') {
        set({ status: 'error', error: 'Update check completed without a result. This usually means the app is running in dev mode.' });
      }
    }
  },

  downloadUpdate: async () => {
    set({ status: 'downloading', error: null });
    
    try {
      const result = await hostApi.updates.download();
      
      if (!result.success) {
        set({
          status: result.status?.status || 'error',
          mode: result.status?.mode || get().mode,
          updateInfo: result.status?.info || get().updateInfo,
          progress: result.status?.progress || get().progress,
          error: result.status?.error || result.error || 'Failed to download update',
          downloadPath: result.status?.downloadPath || get().downloadPath,
        });
      } else if (result.status) {
        set({
          status: result.status.status,
          mode: result.status.mode || get().mode,
          updateInfo: result.status.info || get().updateInfo,
          progress: result.status.progress || null,
          error: result.status.error || null,
          downloadPath: result.status.downloadPath || result.downloadPath || get().downloadPath,
        });
      } else if (result.downloadPath) {
        set({ downloadPath: result.downloadPath });
      }
    } catch (error) {
      set({ status: 'error', error: String(error) });
    }
  },

  installUpdate: async () => {
    try {
      const result = await hostApi.updates.install();
      if (!result.success) {
        set({
          status: result.status?.status || 'error',
          mode: result.status?.mode || get().mode,
          updateInfo: result.status?.info || get().updateInfo,
          progress: result.status?.progress || get().progress,
          error: result.status?.error || result.error || 'Failed to install update',
          downloadPath: result.status?.downloadPath || get().downloadPath,
        });
        return;
      }
      if (result.status) {
        set({
          status: result.status.status,
          mode: result.status.mode || get().mode,
          updateInfo: result.status.info || get().updateInfo,
          progress: result.status.progress || get().progress,
          error: result.status.error || null,
          downloadPath: result.status.downloadPath || get().downloadPath,
        });
      }
    } catch (error) {
      set({ status: 'error', error: String(error) });
    }
  },

  cancelAutoInstall: async () => {
    try {
      await hostApi.updates.cancelAutoInstall();
    } catch (error) {
      console.error('Failed to cancel auto-install:', error);
    }
  },

  setChannel: async (channel) => {
    try {
      await hostApi.updates.setChannel(channel);
    } catch (error) {
      console.error('Failed to set update channel:', error);
    }
  },

  setAutoDownload: async (enable) => {
    try {
      // Compatibility shim for older UI paths: the updater is now prompt-first,
      // so we keep electron-updater.autoDownload disabled even if a stale
      // persisted setting says otherwise.
      await hostApi.updates.setAutoDownload(false);
      if (enable) {
        console.info('[Update] Auto-download preference ignored; update prompts are shown instead.');
      }
    } catch (error) {
      console.error('Failed to set auto-download:', error);
    }
  },

  clearError: () => set({ error: null, status: 'idle' }),
}));
