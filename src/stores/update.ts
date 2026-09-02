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
  UpdateDisposition,
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
  /** Last main-process update status sequence accepted by this renderer. */
  statusSequence: number;
  mode: UpdateMode;
  packageType: string;
  canAutoReplace: boolean;
  requiresMigration: boolean;
  migrationReason: string | null;
  disposition: UpdateDisposition;
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
let unsubscribeUpdateStatus: (() => void) | null = null;
let unsubscribeUpdateCountdown: (() => void) | null = null;

// Main-process updater events are delivered independently from the Host API
// request that triggered them.  If a request times out, its queued
// `update:status-changed` event can arrive later and otherwise resurrect a
// stale available/downloaded artifact in the renderer.  Keep a small local
// operation epoch: status events are accepted only while the corresponding
// renderer operation is still active, and late promise results from an older
// operation are ignored as well.
let updateOperationGeneration = 0;
let activeUpdateOperationGeneration: number | null = null;
// A timed-out/rejected IPC operation may still be running in the main process
// and can emit a higher sequence after the renderer has already reported an
// error. Without an operation correlation id those late events cannot be
// attributed safely, so suppress sequenced status events until the user starts
// a fresh explicit update operation.
let suppressSequencedStatusEvents = false;

function beginUpdateOperation(): number {
  const generation = ++updateOperationGeneration;
  activeUpdateOperationGeneration = generation;
  suppressSequencedStatusEvents = false;
  return generation;
}

function isCurrentUpdateOperation(generation: number): boolean {
  return activeUpdateOperationGeneration === generation;
}

function finishUpdateOperation(generation: number): void {
  if (activeUpdateOperationGeneration === generation) {
    activeUpdateOperationGeneration = null;
  }
}

function disposeUpdateSubscriptions(): void {
  unsubscribeUpdateStatus?.();
  unsubscribeUpdateStatus = null;
  unsubscribeUpdateCountdown?.();
  unsubscribeUpdateCountdown = null;
}

/**
 * The main process owns the countdown timer. Clear it before starting any
 * renderer operation so an already-authorized timer cannot install an older
 * artifact after the user has begun a fresh check/download/install flow.
 * Cancellation is best-effort: a broken IPC channel must not prevent the
 * requested operation from proceeding.
 */
async function cancelMainAutoInstall(): Promise<void> {
  try {
    await hostApi.updates.cancelAutoInstall();
  } catch (error) {
    console.warn('Failed to cancel pending auto-install before update operation:', error);
  }
}

function isFreshStatusSequence(
  incoming: UpdateStatusSnapshot,
  current: number,
): boolean {
  return incoming.sequence === undefined
    || (Number.isSafeInteger(incoming.sequence) && incoming.sequence > current);
}

function nextStatusSequence(
  incoming: UpdateStatusSnapshot | undefined,
  current: number,
): number {
  return incoming?.sequence !== undefined && Number.isSafeInteger(incoming.sequence)
    ? Math.max(current, incoming.sequence)
    : current;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: 'idle',
  // Main starts its first status snapshot at sequence 0.  Use -1 locally so
  // that initial snapshot is accepted; subsequent snapshots must be strictly
  // newer to prevent duplicate/late events from overwriting state.
  statusSequence: -1,
  mode: 'installed',
  packageType: 'installer',
  canAutoReplace: false,
  requiresMigration: false,
  migrationReason: null,
  disposition: 'installer',
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
        if (isFreshStatusSequence(status, get().statusSequence)) {
          set({
            status: status.status,
            statusSequence: nextStatusSequence(status, get().statusSequence),
            mode: status.mode || 'installed',
            packageType: status.packageType || 'installer',
            canAutoReplace: status.canAutoReplace ?? false,
            requiresMigration: status.requiresMigration ?? false,
            migrationReason: status.migrationReason ?? null,
            disposition: status.disposition || 'installer',
            updateInfo: status.info || null,
            progress: status.progress || null,
            error: status.error || null,
            downloadPath: status.downloadPath || null,
            autoInstallCountdown: null,
          });
        }
      } catch (error) {
        console.error('Failed to get update status:', error);
      }

      // A test reset, hot reload, or a failed initialization can leave the
      // previous subscriptions alive. Release them before installing a fresh
      // pair so one IPC event cannot be applied multiple times.
      disposeUpdateSubscriptions();

      // Listen for update events
      // Single source of truth: listen only to update:status-changed
      // (sent by AppUpdater.updateStatus() in the main process)
      unsubscribeUpdateStatus = hostEvents.onUpdateStatusChanged((status) => {
        // Pushed status events must carry the main-process sequence. An
        // unsequenced event cannot be correlated with the renderer operation
        // that produced it, so accepting it during a later check/download
        // could resurrect a stale artifact from a legacy or delayed sender.
        // Direct Host API snapshots remain compatible because they are applied
        // by the operation/init responses above, not through this subscription.
        if (status.sequence === undefined) return;
        if (suppressSequencedStatusEvents) return;
        if (!isFreshStatusSequence(status, get().statusSequence)) return;
        set({
          status: status.status,
          statusSequence: nextStatusSequence(status, get().statusSequence),
          mode: status.mode || get().mode,
          packageType: status.packageType || get().packageType,
          canAutoReplace: status.canAutoReplace ?? get().canAutoReplace,
          requiresMigration: status.requiresMigration ?? get().requiresMigration,
          migrationReason: status.migrationReason ?? null,
          disposition: status.disposition || get().disposition,
          updateInfo: status.info || null,
          progress: status.progress || null,
          error: status.error || null,
          downloadPath: status.downloadPath || null,
          // Countdown events are separate from the status snapshot. A fresh
          // status event always starts a new lifecycle and must not resurrect
          // a countdown from an older update.
          autoInstallCountdown: null,
        });
      });

      unsubscribeUpdateCountdown = hostEvents.onUpdateAutoInstallCountdown(({ seconds, cancelled, sequence }) => {
        // A countdown is emitted after the downloaded status request has
        // completed, so there is normally no active renderer operation here.
        // Use the main-process sequence to reject delayed timers; retain a
        // conservative downloaded-state check for legacy unsequenced events.
        if (sequence === undefined) {
          if (activeUpdateOperationGeneration === null || get().status !== 'downloaded') return;
        // The main process stamps a countdown with the exact status sequence
        // that authorized the timer.  A greater sequence is not safe to
        // accept: the corresponding status event may still be queued, and a
        // future countdown could otherwise appear against an older artifact.
        } else if (!Number.isSafeInteger(sequence) || sequence !== get().statusSequence) {
          return;
        }
        if (get().status !== 'downloaded') return;
        if (cancelled) {
          set({ autoInstallCountdown: null });
          return;
        }
        if (!Number.isFinite(seconds) || seconds < 0) return;
        set({ autoInstallCountdown: seconds });
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
      // Keep the promise only while initialization is in flight. Once it has
      // settled, `isInitialized` remains the fast-path guard in production,
      // while a failed/test-reset initialization can be retried cleanly
      // instead of awaiting a stale resolved promise forever.
      if (updateInitPromise) {
        updateInitPromise = null;
      }
    }
  },

  checkForUpdates: async () => {
    const operationGeneration = beginUpdateOperation();
    // A new check supersedes any previously downloaded artifact.  Clear the
    // path/progress synchronously so a slow or unavailable host API cannot
    // leave an old package actionable while the check is in flight.
    set({
      status: 'checking',
      error: null,
      progress: null,
      downloadPath: null,
      updateInfo: null,
      autoInstallCountdown: null,
    });
    // Do not block scheduling the bounded check timeout on a best-effort
    // cancellation IPC call. A stalled/queued cancellation must never leave
    // the renderer's check operation without a live timeout.
    void cancelMainAutoInstall();
    
    try {
      const result = await Promise.race([
        hostApi.updates.check(),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error('Update check timed out')),
          UCLAW_UPDATE_CHECK_TIMEOUT_MS,
        )),
      ]);

      if (!isCurrentUpdateOperation(operationGeneration)) return;
      
      if (result.status && isFreshStatusSequence(result.status, get().statusSequence)) {
        set({
          status: result.status.status,
          statusSequence: nextStatusSequence(result.status, get().statusSequence),
          mode: result.status.mode || get().mode,
          packageType: result.status.packageType || get().packageType,
          canAutoReplace: result.status.canAutoReplace ?? get().canAutoReplace,
          requiresMigration: result.status.requiresMigration ?? get().requiresMigration,
          migrationReason: result.status.migrationReason ?? null,
          disposition: result.status.disposition || get().disposition,
          updateInfo: result.status.info || null,
          progress: result.status.progress || null,
          error: result.status.error || null,
          downloadPath: result.status.downloadPath || null,
          autoInstallCountdown: null,
        });
      } else if (!result.success) {
        suppressSequencedStatusEvents = true;
        if (result.status && !isFreshStatusSequence(result.status, get().statusSequence)) {
          return;
        }
        set({
          status: 'error',
          statusSequence: nextStatusSequence(result.status, get().statusSequence),
          mode: result.status?.mode || get().mode,
          packageType: result.status?.packageType || get().packageType,
          canAutoReplace: result.status?.canAutoReplace ?? get().canAutoReplace,
          requiresMigration: result.status?.requiresMigration ?? get().requiresMigration,
          migrationReason: result.status
            ? result.status.migrationReason ?? null
            : get().migrationReason,
          disposition: result.status?.disposition || get().disposition,
          updateInfo: null,
          progress: null,
          downloadPath: null,
          autoInstallCountdown: null,
          error: result.error || 'Failed to check for updates',
        });
      }
    } catch (error) {
      if (!isCurrentUpdateOperation(operationGeneration)) return;
      suppressSequencedStatusEvents = true;
      // A transport/IPC exception does not carry a trustworthy status
      // snapshot. Clear every artifact field so a failed operation can never
      // leave a previously downloaded package actionable in the renderer.
      set({
        status: 'error',
        updateInfo: null,
        progress: null,
        downloadPath: null,
        autoInstallCountdown: null,
        error: String(error),
      });
    } finally {
      if (isCurrentUpdateOperation(operationGeneration)) {
        finishUpdateOperation(operationGeneration);
        // In dev mode autoUpdater skips without emitting events, so the
        // status may still be 'checking' or even 'idle'. Catch both.
        const currentStatus = get().status;
        if (currentStatus === 'checking' || currentStatus === 'idle') {
          suppressSequencedStatusEvents = true;
          set({
            status: 'error',
            updateInfo: null,
            progress: null,
            downloadPath: null,
            autoInstallCountdown: null,
            error: 'Update check completed without a result. This usually means the app is running in dev mode.',
          });
        }
      }
    }
  },

  downloadUpdate: async () => {
    const operationGeneration = beginUpdateOperation();
    set({
      status: 'downloading',
      error: null,
      progress: null,
      downloadPath: null,
      autoInstallCountdown: null,
    });
    // Cancellation is best-effort and must not delay the download request (or
    // its timeout/error handling).
    void cancelMainAutoInstall();
    
    try {
      const result = await hostApi.updates.download();

      if (!isCurrentUpdateOperation(operationGeneration)) return;
      
      if (!result.success) {
        suppressSequencedStatusEvents = true;
        if (result.status && !isFreshStatusSequence(result.status, get().statusSequence)) return;
        set({
          status: result.status?.status || 'error',
          statusSequence: nextStatusSequence(result.status, get().statusSequence),
          mode: result.status?.mode || get().mode,
          packageType: result.status?.packageType || get().packageType,
          canAutoReplace: result.status?.canAutoReplace ?? get().canAutoReplace,
          requiresMigration: result.status?.requiresMigration ?? get().requiresMigration,
          migrationReason: result.status
            ? result.status.migrationReason ?? null
            : get().migrationReason,
          disposition: result.status?.disposition || get().disposition,
          // A returned status is authoritative.  The main process clears
          // artifact metadata on failed checks/downloads; falling back to a
          // previously downloaded payload here can make the renderer offer a
          // stale install action after an error.
          updateInfo: result.status ? result.status.info || null : null,
          progress: result.status ? result.status.progress || null : null,
          error: result.status?.error || result.error || 'Failed to download update',
          downloadPath: result.status ? result.status.downloadPath || null : null,
          autoInstallCountdown: null,
        });
      } else if (result.status && isFreshStatusSequence(result.status, get().statusSequence)) {
        set({
          status: result.status.status,
          statusSequence: nextStatusSequence(result.status, get().statusSequence),
          mode: result.status.mode || get().mode,
          packageType: result.status.packageType || get().packageType,
          canAutoReplace: result.status.canAutoReplace ?? get().canAutoReplace,
          requiresMigration: result.status.requiresMigration ?? get().requiresMigration,
          migrationReason: result.status.migrationReason ?? null,
          disposition: result.status.disposition || get().disposition,
          // The returned status is authoritative. Do not fall back to a
          // package from an earlier operation if a compatibility host omits
          // optional artifact fields.
          updateInfo: result.status.info || null,
          progress: result.status.progress || null,
          error: result.status.error || null,
          downloadPath: result.status.downloadPath || result.downloadPath || null,
          autoInstallCountdown: null,
        });
      } else if (result.downloadPath) {
        set({ downloadPath: result.downloadPath });
      }
    } catch (error) {
      if (!isCurrentUpdateOperation(operationGeneration)) return;
      suppressSequencedStatusEvents = true;
      // The main process may fail before it can return a normalized status.
      // Do not retain metadata/path from an earlier available or downloaded
      // update after that failure.
      set({
        status: 'error',
        updateInfo: null,
        progress: null,
        downloadPath: null,
        autoInstallCountdown: null,
        error: String(error),
      });
    } finally {
      finishUpdateOperation(operationGeneration);
    }
  },

  installUpdate: async () => {
    const operationGeneration = beginUpdateOperation();
    set({ autoInstallCountdown: null });
    // Cancellation is best-effort and must not delay the install IPC call.
    void cancelMainAutoInstall();
    try {
      const result = await hostApi.updates.install();
      if (!isCurrentUpdateOperation(operationGeneration)) return;
      if (!result.success) {
        suppressSequencedStatusEvents = true;
        if (result.status && !isFreshStatusSequence(result.status, get().statusSequence)) return;
        set({
          status: result.status?.status || 'error',
          statusSequence: nextStatusSequence(result.status, get().statusSequence),
          mode: result.status?.mode || get().mode,
          packageType: result.status?.packageType || get().packageType,
          canAutoReplace: result.status?.canAutoReplace ?? get().canAutoReplace,
          requiresMigration: result.status?.requiresMigration ?? get().requiresMigration,
          migrationReason: result.status
            ? result.status.migrationReason ?? null
            : get().migrationReason,
          disposition: result.status?.disposition || get().disposition,
          // Preserve no stale package when the main process reports an
          // explicit failure status with cleared artifact fields.
          updateInfo: result.status ? result.status.info || null : null,
          progress: result.status ? result.status.progress || null : null,
          error: result.status?.error || result.error || 'Failed to install update',
          downloadPath: result.status ? result.status.downloadPath || null : null,
          autoInstallCountdown: null,
        });
        return;
      }
      if (result.status && isFreshStatusSequence(result.status, get().statusSequence)) {
        set({
          status: result.status.status,
          statusSequence: nextStatusSequence(result.status, get().statusSequence),
          mode: result.status.mode || get().mode,
          packageType: result.status.packageType || get().packageType,
          canAutoReplace: result.status.canAutoReplace ?? get().canAutoReplace,
          requiresMigration: result.status.requiresMigration ?? get().requiresMigration,
          migrationReason: result.status.migrationReason ?? null,
          disposition: result.status.disposition || get().disposition,
          // Treat the returned status as a complete snapshot. Retaining the
          // previous path/info here can re-enable an already failed package.
          updateInfo: result.status.info || null,
          progress: result.status.progress || null,
          error: result.status.error || null,
          downloadPath: result.status.downloadPath || null,
          autoInstallCountdown: null,
        });
      }
    } catch (error) {
      if (!isCurrentUpdateOperation(operationGeneration)) return;
      suppressSequencedStatusEvents = true;
      // Installation errors are terminal for the current artifact until a
      // fresh check/download succeeds. Clear stale fields even when the IPC
      // call rejects without a status payload.
      set({
        status: 'error',
        updateInfo: null,
        progress: null,
        downloadPath: null,
        autoInstallCountdown: null,
        error: String(error),
      });
    } finally {
      finishUpdateOperation(operationGeneration);
    }
  },

  cancelAutoInstall: async () => {
    // Reflect the user's cancellation immediately; the main-process event is
    // asynchronous and may be delayed behind another IPC message.
    set({ autoInstallCountdown: null });
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

  clearError: () => {
    // Dismissing an error is an explicit reset boundary. Invalidate any
    // in-flight renderer operation and quarantine sequenced events that may
    // still be queued by the main process; a subsequent check/download starts
    // a fresh operation and lifts this quarantine.
    updateOperationGeneration += 1;
    activeUpdateOperationGeneration = null;
    suppressSequencedStatusEvents = true;
    // Clearing an error also invalidates any main-process countdown that may
    // have been authorized for the now-discarded artifact. Keep this
    // best-effort and non-blocking because clearError is intentionally sync.
    void cancelMainAutoInstall();
    set({
      error: null,
      status: 'idle',
      mode: 'installed',
      packageType: 'installer',
      canAutoReplace: false,
      requiresMigration: false,
      migrationReason: null,
      disposition: 'installer',
      updateInfo: null,
      progress: null,
      downloadPath: null,
      autoInstallCountdown: null,
    });
  },
}));
