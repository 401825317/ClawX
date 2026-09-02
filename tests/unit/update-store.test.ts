import { beforeEach, describe, expect, it, vi } from 'vitest';

const updatesApiMock = vi.hoisted(() => ({
  status: vi.fn(),
  version: vi.fn(),
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  setChannel: vi.fn(),
  setAutoDownload: vi.fn(),
  cancelAutoInstall: vi.fn(),
}));

const hostEventsMock = vi.hoisted(() => ({
  onUpdateStatusChanged: vi.fn(() => () => {}),
  onUpdateAutoInstallCountdown: vi.fn(() => () => {}),
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: { updates: updatesApiMock },
}));

vi.mock('@/lib/host-events', () => ({
  hostEvents: hostEventsMock,
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: { getState: () => ({ autoCheckUpdate: false }) },
}));

import { useUpdateStore } from '@/stores/update';
import { UCLAW_UPDATE_CHECK_TIMEOUT_MS } from '@shared/junfeiai-endpoints';
import type { UpdateStatusSnapshot } from '@shared/host-api/contract';

const downloadedArtifact = {
  version: '2.0.4',
  packageType: 'portable_zip' as const,
  downloadUrl: 'https://updates.test/UClaw.zip',
};

function resetStore(): void {
  useUpdateStore.setState({
    status: 'downloaded',
    statusSequence: 0,
    mode: 'portable',
    packageType: 'portable_zip',
    canAutoReplace: true,
    requiresMigration: false,
    migrationReason: null,
    disposition: 'auto-replace',
    currentVersion: '2.0.3',
    updateInfo: downloadedArtifact,
    progress: {
      total: 100,
      delta: 100,
      transferred: 100,
      percent: 100,
      bytesPerSecond: 100,
    },
    error: null,
    downloadPath: '/tmp/UClaw.zip',
    isInitialized: false,
    autoInstallCountdown: 3,
  });
}

describe('update store stale artifact handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it('clears a stale package when a download IPC call rejects', async () => {
    updatesApiMock.download.mockRejectedValueOnce(new Error('network unavailable'));

    await useUpdateStore.getState().downloadUpdate();

    expect(useUpdateStore.getState()).toMatchObject({
      status: 'error',
      updateInfo: null,
      progress: null,
      downloadPath: null,
      autoInstallCountdown: null,
      error: 'Error: network unavailable',
    });
  });

  it('clears a stale package when an install IPC call rejects', async () => {
    updatesApiMock.install.mockRejectedValueOnce(new Error('helper failed'));

    await useUpdateStore.getState().installUpdate();

    expect(useUpdateStore.getState()).toMatchObject({
      status: 'error',
      updateInfo: null,
      progress: null,
      downloadPath: null,
      autoInstallCountdown: null,
      error: 'Error: helper failed',
    });
  });

  it('clears a stale package when an update check rejects', async () => {
    updatesApiMock.check.mockRejectedValueOnce(new Error('check failed'));

    await useUpdateStore.getState().checkForUpdates();

    expect(useUpdateStore.getState()).toMatchObject({
      status: 'error',
      updateInfo: null,
      progress: null,
      downloadPath: null,
      autoInstallCountdown: null,
      error: 'Error: check failed',
    });
  });

  it('treats a successful download status as authoritative', async () => {
    updatesApiMock.download.mockResolvedValueOnce({
      success: true,
      status: {
        status: 'downloaded',
        mode: 'portable',
        packageType: 'portable_zip',
        canAutoReplace: true,
        requiresMigration: false,
        disposition: 'auto-replace',
      },
    });

    await useUpdateStore.getState().downloadUpdate();

    expect(useUpdateStore.getState()).toMatchObject({
      status: 'downloaded',
      updateInfo: null,
      progress: null,
      downloadPath: null,
      autoInstallCountdown: null,
    });
  });

  it('treats a successful install status as authoritative', async () => {
    updatesApiMock.install.mockResolvedValueOnce({
      success: true,
      status: {
        status: 'idle',
        mode: 'installed',
        packageType: 'installer',
        canAutoReplace: false,
        requiresMigration: false,
        disposition: 'installer',
      },
    });

    await useUpdateStore.getState().installUpdate();

    expect(useUpdateStore.getState()).toMatchObject({
      status: 'idle',
      mode: 'installed',
      packageType: 'installer',
      updateInfo: null,
      progress: null,
      downloadPath: null,
      autoInstallCountdown: null,
    });
  });

  it('clears the artifact when dismissing an update error', () => {
    useUpdateStore.getState().clearError();

    expect(useUpdateStore.getState()).toMatchObject({
      status: 'idle',
      error: null,
      updateInfo: null,
      progress: null,
      downloadPath: null,
      autoInstallCountdown: null,
    });
    expect(updatesApiMock.cancelAutoInstall).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending main-process countdown before a new operation', async () => {
    updatesApiMock.download.mockResolvedValueOnce({
      success: false,
      error: 'download failed',
    });

    await useUpdateStore.getState().downloadUpdate();

    expect(updatesApiMock.cancelAutoInstall).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().autoInstallCountdown).toBeNull();
  });

  it('accepts only the status sequence that authorized a countdown', async () => {
    let countdownHandler: ((payload: {
      seconds: number;
      cancelled?: boolean;
      sequence?: number;
    }) => void) | null = null;
    hostEventsMock.onUpdateAutoInstallCountdown.mockImplementationOnce((handler) => {
      countdownHandler = handler;
      return () => {};
    });
    updatesApiMock.version.mockResolvedValueOnce('2.0.3');
    updatesApiMock.status.mockResolvedValueOnce({
      status: 'downloaded',
      sequence: 5,
      mode: 'portable',
      packageType: 'portable_zip',
      canAutoReplace: true,
      requiresMigration: false,
      disposition: 'auto-replace',
      info: downloadedArtifact,
      downloadPath: '/tmp/UClaw.zip',
    });
    updatesApiMock.setAutoDownload.mockResolvedValueOnce(undefined);
    await useUpdateStore.getState().init();

    countdownHandler?.({ seconds: 9, sequence: 6 });
    expect(useUpdateStore.getState().autoInstallCountdown).toBeNull();

    countdownHandler?.({ seconds: 4, sequence: 5 });
    expect(useUpdateStore.getState().autoInstallCountdown).toBe(4);
  });

  it('quarantines queued status events after clearError until a fresh operation', async () => {
    let statusHandler: ((status: UpdateStatusSnapshot) => void) | null = null;
    hostEventsMock.onUpdateStatusChanged.mockImplementationOnce((handler) => {
      statusHandler = handler;
      return () => {};
    });
    updatesApiMock.version.mockResolvedValueOnce('2.0.3');
    updatesApiMock.status.mockResolvedValueOnce({
      status: 'error',
      sequence: 7,
      mode: 'portable',
      packageType: 'portable_zip',
      canAutoReplace: false,
      requiresMigration: true,
      disposition: 'manual-migration',
      error: 'stale update',
    });
    updatesApiMock.setAutoDownload.mockResolvedValueOnce(undefined);
    await useUpdateStore.getState().init();

    useUpdateStore.getState().clearError();
    statusHandler?.({
      status: 'available',
      sequence: 8,
      mode: 'portable',
      packageType: 'portable_zip',
      canAutoReplace: true,
      requiresMigration: false,
      disposition: 'auto-replace',
      info: downloadedArtifact,
      downloadPath: '/tmp/stale.zip',
    });

    expect(useUpdateStore.getState()).toMatchObject({
      status: 'idle',
      packageType: 'installer',
      updateInfo: null,
      downloadPath: null,
    });
  });

  it('ignores a late status event after an update check times out', async () => {
    let statusHandler: ((status: UpdateStatusSnapshot) => void) | null = null;
    hostEventsMock.onUpdateStatusChanged.mockImplementationOnce((handler) => {
      statusHandler = handler;
      return () => {};
    });
    updatesApiMock.version.mockResolvedValueOnce('2.0.3');
    updatesApiMock.status.mockResolvedValueOnce({
      status: 'idle',
      sequence: 1,
      mode: 'portable',
      packageType: 'portable_zip',
      canAutoReplace: true,
      requiresMigration: false,
      disposition: 'auto-replace',
    });
    updatesApiMock.setAutoDownload.mockResolvedValueOnce(undefined);
    await useUpdateStore.getState().init();

    updatesApiMock.check.mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const checkPromise = useUpdateStore.getState().checkForUpdates();
      await vi.advanceTimersByTimeAsync(UCLAW_UPDATE_CHECK_TIMEOUT_MS);
      await checkPromise;

      expect(useUpdateStore.getState()).toMatchObject({
        status: 'error',
        updateInfo: null,
        progress: null,
        downloadPath: null,
      });
      expect(statusHandler).toEqual(expect.any(Function));

      statusHandler?.({
        status: 'available',
        sequence: 1,
        mode: 'portable',
        packageType: 'portable_zip',
        canAutoReplace: true,
        requiresMigration: false,
        disposition: 'auto-replace',
        info: downloadedArtifact,
        progress: null,
        downloadPath: '/tmp/stale.zip',
      });

      expect(useUpdateStore.getState()).toMatchObject({
        status: 'error',
        updateInfo: null,
        progress: null,
        downloadPath: null,
      });

      // A new operation may already be active when an older main-process
      // event finally leaves the IPC queue. Sequence fencing must reject that
      // stale event instead of letting it resurrect an old artifact.
      let resolveNextCheck: ((value: unknown) => void) | null = null;
      updatesApiMock.check.mockImplementationOnce(() => new Promise((resolve) => {
        resolveNextCheck = resolve;
      }));
      const nextCheck = useUpdateStore.getState().checkForUpdates();
      await Promise.resolve();
      statusHandler?.({
        status: 'available',
        sequence: 2,
        mode: 'portable',
        packageType: 'portable_zip',
        canAutoReplace: true,
        requiresMigration: false,
        disposition: 'auto-replace',
        info: downloadedArtifact,
        progress: null,
        downloadPath: '/tmp/current.zip',
      });
      statusHandler?.({
        status: 'downloaded',
        sequence: 1,
        mode: 'portable',
        packageType: 'portable_zip',
        canAutoReplace: true,
        requiresMigration: false,
        disposition: 'auto-replace',
        info: downloadedArtifact,
        progress: null,
        downloadPath: '/tmp/stale.zip',
      });
      expect(useUpdateStore.getState()).toMatchObject({
        status: 'available',
        statusSequence: 2,
        downloadPath: '/tmp/current.zip',
      });
      resolveNextCheck?.({
        success: true,
        status: {
          status: 'not-available',
          sequence: 3,
          mode: 'portable',
          packageType: 'portable_zip',
          canAutoReplace: true,
          requiresMigration: false,
          disposition: 'auto-replace',
        },
      });
      await nextCheck;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects malformed status sequence values instead of reviving an artifact', async () => {
    let statusHandler: ((status: UpdateStatusSnapshot) => void) | null = null;
    hostEventsMock.onUpdateStatusChanged.mockImplementationOnce((handler) => {
      statusHandler = handler;
      return () => {};
    });
    updatesApiMock.version.mockResolvedValueOnce('2.0.3');
    updatesApiMock.status.mockResolvedValueOnce({
      status: 'idle',
      sequence: 4,
      mode: 'portable',
      packageType: 'portable_zip',
      canAutoReplace: true,
      requiresMigration: false,
      disposition: 'auto-replace',
    });
    updatesApiMock.setAutoDownload.mockResolvedValueOnce(undefined);
    await useUpdateStore.getState().init();

    statusHandler?.({
      status: 'available',
      sequence: Number.NaN,
      mode: 'portable',
      packageType: 'portable_zip',
      canAutoReplace: true,
      requiresMigration: false,
      disposition: 'auto-replace',
      info: downloadedArtifact,
      downloadPath: '/tmp/malformed.zip',
    });

    expect(useUpdateStore.getState()).toMatchObject({
      status: 'idle',
      statusSequence: 4,
      updateInfo: null,
      downloadPath: null,
    });
  });

  it('ignores unsequenced pushed status events during an active operation', async () => {
    let statusHandler: ((status: UpdateStatusSnapshot) => void) | null = null;
    hostEventsMock.onUpdateStatusChanged.mockImplementationOnce((handler) => {
      statusHandler = handler;
      return () => {};
    });
    updatesApiMock.version.mockResolvedValueOnce('2.0.3');
    updatesApiMock.status.mockResolvedValueOnce({
      status: 'idle',
      sequence: 4,
      mode: 'portable',
      packageType: 'portable_zip',
      canAutoReplace: true,
      requiresMigration: false,
      disposition: 'auto-replace',
    });
    updatesApiMock.setAutoDownload.mockResolvedValueOnce(undefined);
    await useUpdateStore.getState().init();

    let resolveCheck: ((value: unknown) => void) | null = null;
    updatesApiMock.check.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCheck = resolve;
    }));
    const checkPromise = useUpdateStore.getState().checkForUpdates();
    await Promise.resolve();

    // A legacy/delayed sender has no correlation sequence. It must not be
    // allowed to overwrite the `checking` lifecycle while this operation is
    // still in flight.
    statusHandler?.({
      status: 'available',
      mode: 'portable',
      packageType: 'portable_zip',
      canAutoReplace: true,
      requiresMigration: false,
      disposition: 'auto-replace',
      info: downloadedArtifact,
      downloadPath: '/tmp/stale.zip',
    });
    expect(useUpdateStore.getState()).toMatchObject({
      status: 'checking',
      statusSequence: 4,
      updateInfo: null,
      downloadPath: null,
    });

    resolveCheck?.({
      success: true,
      status: {
        status: 'not-available',
        sequence: 5,
        mode: 'portable',
        packageType: 'portable_zip',
        canAutoReplace: true,
        requiresMigration: false,
        disposition: 'auto-replace',
      },
    });
    await checkPromise;
  });
});
