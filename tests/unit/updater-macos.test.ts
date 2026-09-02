// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '@electron/main/updater';

const originalPlatform = process.platform;
const originalArch = process.arch;

const {
  appMock,
  autoUpdaterMock,
  canAutoReplaceMock,
  getPortableModeInfoMock,
  launchPortableUpdateInstallerMock,
  portableState,
  proxyAwareFetchMock,
  shellMock,
  verifyPortableUpdatePackageMock,
} = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    channel: undefined as string | undefined,
    logger: undefined as unknown,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    on(event: string, listener: (...args: unknown[]) => void) {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
      return true;
    },
    removeAllListeners() {
      listeners.clear();
      return this;
    },
  };

  const portableState = {
    packageType: 'portable_zip' as 'portable_zip' | 'installer',
    dataMode: 'installed' as 'installed' | 'portable',
    canAutoReplace: false,
    migrationReason: 'missing-portable-flag',
    updatesDir: '/tmp/uclaw-macos-updates',
  };
  const appMock = {
    isPackaged: true,
    getVersion: vi.fn(() => '2.0.3'),
    getName: vi.fn(() => 'clawx'),
    quit: vi.fn(),
  };
  const shellMock = {
    showItemInFolder: vi.fn(),
    openPath: vi.fn(async () => ''),
  };
  const verifyPortableUpdatePackageMock = vi.fn(async () => ({ size: 1, sha512: 'a'.repeat(128) }));

  return {
    appMock,
    autoUpdaterMock: autoUpdater,
    canAutoReplaceMock: vi.fn(() => portableState.canAutoReplace),
    getPortableModeInfoMock: vi.fn(() => {
      // Mirror the production cache shape closely enough for the updater's
      // in-place replacement guard. A portable data mode may still be
      // non-replaceable (for example when the root is read-only), but its
      // runtime directories are initialized independently of that gate.
      const enabled = portableState.dataMode === 'portable';
      return {
        enabled,
        runtimeUpdatesDir: enabled ? portableState.updatesDir : null,
        rootDir: enabled ? '/tmp/uclaw-portable' : null,
        migrationReason: portableState.migrationReason,
      };
    }),
    launchPortableUpdateInstallerMock: vi.fn(async () => undefined),
    portableState,
    proxyAwareFetchMock: vi.fn(),
    shellMock,
    verifyPortableUpdatePackageMock,
  };
});

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: vi.fn(),
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  shell: shellMock,
}));

vi.mock('electron-updater', () => ({ autoUpdater: autoUpdaterMock }));

vi.mock('@electron/utils/portable-mode', () => ({
  canAutoReplacePortableUpdate: (...args: unknown[]) => canAutoReplaceMock(...args),
  getPortableDataMode: () => portableState.dataMode,
  getPortableModeInfo: (...args: unknown[]) => getPortableModeInfoMock(...args),
  getPortableUpdatePackageType: () => portableState.packageType,
  getPortableUpdatesDir: () => portableState.updatesDir,
  inspectPortableLayout: () => ({
    canAutoReplace: portableState.canAutoReplace,
    reason: portableState.canAutoReplace ? 'complete' : portableState.migrationReason,
  }),
  isPortableMode: () => portableState.dataMode === 'portable',
  shouldUsePortableUpdatePackage: () => portableState.packageType === 'portable_zip',
}));

vi.mock('@electron/utils/junfeiai-distribution', () => ({
  getUclawBackendOrigin: () => 'https://updates.test',
}));

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: (...args: unknown[]) => proxyAwareFetchMock(...args),
}));

vi.mock('@electron/main/portable-update-installer', () => ({
  launchPortableUpdateInstaller: (...args: unknown[]) => launchPortableUpdateInstallerMock(...args),
}));

vi.mock('@electron/main/app-state', () => ({
  setQuitting: vi.fn(),
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@electron/main/portable-update-security', () => ({
  assertPortableUpdateZipFilename: vi.fn(),
  comparePortableUpdateVersions: vi.fn((left: string, right: string) => {
    if (left === right) return 0;
    if (left === '2.0.2') return -1;
    return 1;
  }),
  filenameFromPortableUpdateInfo: vi.fn(() => 'UClaw-update-mac.zip'),
  isValidPortableUpdateVersion: vi.fn((value: unknown) => (
    typeof value === 'string' && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(value)
  )),
  verifyPortableUpdatePackage: (...args: unknown[]) => verifyPortableUpdatePackageMock(...args),
}));

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, writable: true });
}

function setArch(arch: string): void {
  Object.defineProperty(process, 'arch', { value: arch, writable: true });
}

function makePortableResponse(
  version = '2.0.4',
  overrides: Partial<{
    packageType: string;
    package_type: string;
    platform: string;
    arch: string;
    download_url: string | null;
    sha512: string | null;
    size: number | null;
  }> = {},
): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        version,
        ...(overrides.packageType === undefined ? {} : { packageType: overrides.packageType }),
        package_type: overrides.package_type ?? 'portable_zip',
        platform: overrides.platform ?? 'mac',
        arch: overrides.arch ?? process.arch,
        download_url: overrides.download_url === undefined
          ? 'https://updates.test/download/UClaw-2.0.4-mac-usb.zip'
          : overrides.download_url,
        file_name: 'UClaw-2.0.4-mac-usb.zip',
        sha512: overrides.sha512 === undefined ? 'a'.repeat(128) : overrides.sha512,
        size: overrides.size === undefined ? 1 : overrides.size,
      },
    }),
  } as unknown as Response;
}

function setDownloadedStatus(updater: unknown): void {
  (updater as { status: UpdateStatus }).status = {
    status: 'downloaded',
    mode: 'installed',
    packageType: 'portable_zip',
    canAutoReplace: portableState.canAutoReplace,
    requiresMigration: !portableState.canAutoReplace,
    migrationReason: portableState.canAutoReplace ? undefined : portableState.migrationReason,
    disposition: portableState.canAutoReplace ? 'auto-replace' : 'manual-migration',
    info: {
      version: '2.0.4',
      package_type: 'portable_zip',
      platform: 'mac',
      arch: process.arch,
      sha512: 'a'.repeat(128),
      size: 1,
    },
    downloadPath: '/tmp/uclaw-macos-updates/UClaw-2.0.4-mac-usb.zip',
  };
}

beforeEach(() => {
  vi.resetModules();
  autoUpdaterMock.removeAllListeners();
  autoUpdaterMock.setFeedURL.mockReset();
  autoUpdaterMock.checkForUpdates.mockReset();
  appMock.isPackaged = true;
  appMock.getVersion.mockReturnValue('2.0.3');
  portableState.packageType = 'portable_zip';
  portableState.dataMode = 'installed';
  portableState.canAutoReplace = false;
  portableState.migrationReason = 'missing-portable-flag';
  proxyAwareFetchMock.mockReset();
  canAutoReplaceMock.mockClear();
  getPortableModeInfoMock.mockClear();
  launchPortableUpdateInstallerMock.mockClear();
  shellMock.showItemInFolder.mockClear();
  verifyPortableUpdatePackageMock.mockReset();
  verifyPortableUpdatePackageMock.mockResolvedValue({ size: 1, sha512: 'a'.repeat(128) });
});

afterEach(() => {
  setPlatform(originalPlatform);
  setArch(originalArch);
});

describe('macOS managed portable updater', () => {
  it.each(['arm64', 'x64'])('queries portable_zip metadata for macOS %s', async (arch) => {
    setPlatform('darwin');
    setArch(arch);
    proxyAwareFetchMock.mockResolvedValue(makePortableResponse());

    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    await updater.checkForUpdates();

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(1);
    const [request] = proxyAwareFetchMock.mock.calls[0] as [URL, RequestInit];
    expect(request).toBeInstanceOf(URL);
    expect(request.searchParams.get('platform')).toBe('mac');
    expect(request.searchParams.get('package_type')).toBe('portable_zip');
    expect(request.searchParams.get('arch')).toBe(arch);
    expect(request.pathname).toContain('/api/clawx/updates/latest');
    expect(updater.getStatus()).toMatchObject({
      status: 'available',
      mode: 'installed',
      packageType: 'portable_zip',
      canAutoReplace: false,
      requiresMigration: true,
      migrationReason: 'missing-portable-flag',
      disposition: 'manual-migration',
    });
    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled();
  });

  it('rejects a managed installer artifact even when the endpoint returns a newer version', async () => {
    setPlatform('darwin');
    setArch('arm64');
    proxyAwareFetchMock.mockResolvedValue(makePortableResponse('2.0.4', { package_type: 'installer' }));

    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();

    await expect(updater.checkForUpdates()).rejects.toThrow('package_type=portable_zip');
    expect(updater.getStatus()).toMatchObject({ status: 'error' });
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
  });

  it('rejects conflicting package type aliases instead of silently preferring camelCase', async () => {
    setPlatform('darwin');
    setArch('arm64');
    proxyAwareFetchMock.mockResolvedValue(makePortableResponse('2.0.4', {
      packageType: 'portable_zip',
      package_type: 'installer',
    }));

    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();

    await expect(updater.checkForUpdates()).rejects.toThrow(/package type aliases disagree/i);
    expect(updater.getStatus()).toMatchObject({ status: 'error', info: undefined });
  });

  it('rejects metadata for a different platform', async () => {
    setPlatform('darwin');
    setArch('arm64');
    proxyAwareFetchMock.mockResolvedValue(makePortableResponse('2.0.4', { platform: 'win' }));

    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();

    await expect(updater.checkForUpdates()).rejects.toThrow('platform mismatch');
    expect(updater.getStatus()).toMatchObject({ status: 'error' });
  });

  it('rejects metadata for a different architecture', async () => {
    setPlatform('darwin');
    setArch('arm64');
    proxyAwareFetchMock.mockResolvedValue(makePortableResponse('2.0.4', { arch: 'x64' }));

    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();

    await expect(updater.checkForUpdates()).rejects.toThrow('architecture mismatch');
    expect(updater.getStatus()).toMatchObject({ status: 'error' });
  });

  it.each([
    ['download URL', { download_url: null }, /download URL (is required|must be)/i],
    ['SHA-512 digest', { sha512: null }, /sha512 must be/i],
    ['size', { size: null }, /size must be/i],
  ])('fails closed when managed metadata is missing the %s', async (_label, overrides, expectedError) => {
    setPlatform('darwin');
    setArch('arm64');
    proxyAwareFetchMock.mockResolvedValue(makePortableResponse('2.0.4', overrides));

    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();

    await expect(updater.checkForUpdates()).rejects.toThrow(expectedError);
    expect(updater.getStatus()).toMatchObject({
      status: 'error',
      info: undefined,
      downloadPath: undefined,
    });
  });

  it('rejects malformed artifact metadata before issuing a download request', async () => {
    setPlatform('darwin');
    setArch('arm64');
    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    (updater as { status: UpdateStatus }).status = {
      status: 'available',
      mode: 'installed',
      packageType: 'portable_zip',
      canAutoReplace: false,
      requiresMigration: true,
      migrationReason: 'missing-portable-flag',
      disposition: 'manual-migration',
      info: {
        version: '2.0.4',
        package_type: 'portable_zip',
        platform: 'mac',
        arch: 'arm64',
        download_url: 'https://updates.test/malformed.zip',
        sha512: 'a'.repeat(128),
        size: null,
      },
    };

    await expect(updater.downloadUpdate()).rejects.toThrow(/size must be/i);
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(updater.getStatus()).toMatchObject({ status: 'error', info: undefined, downloadPath: undefined });
  });

  it('retains electron-updater feed behavior for unpackaged Darwin development runs', async () => {
    setPlatform('darwin');
    setArch('arm64');
    appMock.isPackaged = false;
    autoUpdaterMock.checkForUpdates.mockResolvedValue(null);

    const { AppUpdater } = await import('@electron/main/updater');
    // Module initialization also creates the exported singleton. Clear that
    // setup call so this assertion covers the explicitly constructed updater.
    autoUpdaterMock.setFeedURL.mockClear();
    const updater = new AppUpdater();

    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledTimes(1);
    expect(updater.getStatus()).toMatchObject({
      mode: 'installed',
      packageType: 'installer',
      canAutoReplace: false,
      requiresMigration: false,
      disposition: 'installer',
    });
    await updater.checkForUpdates();
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
  });

  it('keeps macOS channel selection on the managed API instead of latest-mac.yml', async () => {
    setPlatform('darwin');
    setArch('arm64');
    proxyAwareFetchMock.mockResolvedValue(makePortableResponse());

    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    updater.setChannel('beta');
    await updater.checkForUpdates();

    const [request] = proxyAwareFetchMock.mock.calls[0] as [URL, RequestInit];
    expect(request.searchParams.get('channel')).toBe('beta');
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
  });

  it('opens a verified ZIP for a standalone app instead of launching a replacement helper', async () => {
    setPlatform('darwin');
    setArch('arm64');
    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    setDownloadedStatus(updater);

    await updater.installDownloadedUpdate();

    expect(verifyPortableUpdatePackageMock).toHaveBeenCalledWith(
      '/tmp/uclaw-macos-updates/UClaw-2.0.4-mac-usb.zip',
      expect.objectContaining({ sha512: 'a'.repeat(128), size: 1 }),
    );
    expect(launchPortableUpdateInstallerMock).not.toHaveBeenCalled();
    expect(shellMock.showItemInFolder).toHaveBeenCalledWith(
      '/tmp/uclaw-macos-updates/UClaw-2.0.4-mac-usb.zip',
    );
  });

  it('launches the portable helper only after a complete writable layout is reported', async () => {
    setPlatform('darwin');
    setArch('x64');
    portableState.dataMode = 'portable';
    portableState.canAutoReplace = true;
    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    setDownloadedStatus(updater);

    await updater.installDownloadedUpdate();

    expect(launchPortableUpdateInstallerMock).toHaveBeenCalledWith(
      '/tmp/uclaw-macos-updates/UClaw-2.0.4-mac-usb.zip',
      expect.objectContaining({ version: '2.0.4', size: 1 }),
    );
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });

  it('reclassifies a downloaded update when the portable root becomes unsafe', async () => {
    setPlatform('darwin');
    setArch('arm64');
    portableState.dataMode = 'portable';
    portableState.canAutoReplace = true;
    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    setDownloadedStatus(updater);

    portableState.canAutoReplace = false;
    portableState.migrationReason = 'read-only-root';
    await updater.installDownloadedUpdate();

    expect(launchPortableUpdateInstallerMock).not.toHaveBeenCalled();
    expect(shellMock.showItemInFolder).toHaveBeenCalledTimes(1);
    expect(updater.getStatus()).toMatchObject({
      disposition: 'manual-migration',
      canAutoReplace: false,
      requiresMigration: true,
      migrationReason: 'read-only-root',
    });
  });

  it('does not replace the app from an action that was presented as manual migration', async () => {
    setPlatform('darwin');
    setArch('x64');
    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    setDownloadedStatus(updater);

    portableState.dataMode = 'portable';
    portableState.canAutoReplace = true;
    await updater.installDownloadedUpdate();

    expect(launchPortableUpdateInstallerMock).not.toHaveBeenCalled();
    expect(shellMock.showItemInFolder).toHaveBeenCalledTimes(1);
    expect(updater.getStatus()).toMatchObject({
      disposition: 'auto-replace',
      canAutoReplace: true,
      requiresMigration: false,
    });
    expect(updater.getStatus().migrationReason).toBeUndefined();
  });

  it('fails closed to manual migration when a downloaded status lacks auto-replace authorization', async () => {
    setPlatform('darwin');
    setArch('arm64');
    portableState.dataMode = 'portable';
    portableState.canAutoReplace = true;
    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    setDownloadedStatus(updater);
    const status = (updater as { status: UpdateStatus }).status;
    // Simulate an old/late IPC status that contains a verified-looking
    // artifact but no explicit disposition. A writable layout alone must not
    // authorize launching the replacement helper.
    delete status.disposition;

    await updater.installDownloadedUpdate();

    expect(launchPortableUpdateInstallerMock).not.toHaveBeenCalled();
    expect(shellMock.showItemInFolder).toHaveBeenCalledWith(
      '/tmp/uclaw-macos-updates/UClaw-2.0.4-mac-usb.zip',
    );
    expect(updater.getStatus()).toMatchObject({
      status: 'downloaded',
      disposition: 'auto-replace',
      canAutoReplace: true,
      requiresMigration: false,
    });
  });

  it('rejects an install request unless the updater status is downloaded', async () => {
    setPlatform('darwin');
    setArch('arm64');
    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    (updater as { status: UpdateStatus }).status = {
      status: 'available',
      mode: 'installed',
      packageType: 'portable_zip',
      canAutoReplace: false,
      requiresMigration: true,
      migrationReason: 'missing-portable-flag',
      disposition: 'manual-migration',
      info: {
        version: '2.0.4',
        package_type: 'portable_zip',
        platform: 'mac',
        arch: 'arm64',
        sha512: 'a'.repeat(128),
        size: 1,
      },
      downloadPath: '/tmp/uclaw-macos-updates/UClaw-2.0.4-mac-usb.zip',
    };

    await expect(updater.installDownloadedUpdate()).rejects.toThrow(/not ready to install/i);
    expect(verifyPortableUpdatePackageMock).not.toHaveBeenCalled();
    expect(launchPortableUpdateInstallerMock).not.toHaveBeenCalled();
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });

  it('rejects unexpected installer metadata before revealing the cached package', async () => {
    setPlatform('darwin');
    setArch('arm64');
    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    setDownloadedStatus(updater);
    const status = (updater as { status: UpdateStatus }).status;
    status.info = {
      ...(status.info as Record<string, unknown>),
      package_type: 'installer',
    } as UpdateStatus['info'];

    await expect(updater.installDownloadedUpdate()).rejects.toThrow(/package_type=portable_zip/i);
    expect(verifyPortableUpdatePackageMock).not.toHaveBeenCalled();
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
    expect(launchPortableUpdateInstallerMock).not.toHaveBeenCalled();
  });

  it('does not reveal a downloaded package when its integrity check fails', async () => {
    setPlatform('darwin');
    setArch('arm64');
    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    setDownloadedStatus(updater);
    verifyPortableUpdatePackageMock.mockRejectedValueOnce(new Error('sha512 mismatch'));

    await expect(updater.installDownloadedUpdate()).rejects.toThrow(/sha512 mismatch/i);
    expect(verifyPortableUpdatePackageMock).toHaveBeenCalledTimes(1);
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
    expect(launchPortableUpdateInstallerMock).not.toHaveBeenCalled();
    expect(updater.getStatus()).toMatchObject({ status: 'error', error: 'sha512 mismatch' });
  });

  it('rechecks the managed API instead of trusting info retained by not-available status', async () => {
    setPlatform('darwin');
    setArch('arm64');
    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    (updater as { status: UpdateStatus }).status = {
      status: 'not-available',
      mode: 'installed',
      packageType: 'portable_zip',
      canAutoReplace: false,
      requiresMigration: true,
      migrationReason: 'missing-portable-flag',
      disposition: 'manual-migration',
      // This is deliberately a newer-looking stale payload. It must not be
      // used without a fresh check because the status says no update exists.
      info: {
        version: '2.0.4',
        package_type: 'portable_zip',
        platform: 'mac',
        arch: 'arm64',
        download_url: 'https://updates.test/stale.zip',
        sha512: 'a'.repeat(128),
        size: 1,
      },
    };
    proxyAwareFetchMock.mockResolvedValue(makePortableResponse('2.0.3'));

    await expect(updater.downloadUpdate()).rejects.toThrow(/not newer/i);
    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetchMock.mock.calls[0][0]).toBeInstanceOf(URL);
    expect(updater.getStatus()).toMatchObject({ status: 'error' });
  });

  it('clears a previously downloaded artifact when a managed check fails', async () => {
    setPlatform('darwin');
    setArch('arm64');
    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    setDownloadedStatus(updater);
    proxyAwareFetchMock.mockRejectedValueOnce(new Error('managed endpoint unavailable'));

    await expect(updater.checkForUpdates()).rejects.toThrow(/endpoint unavailable/i);
    expect(updater.getStatus()).toMatchObject({
      status: 'error',
      info: undefined,
      progress: undefined,
      downloadPath: undefined,
      error: 'managed endpoint unavailable',
    });
  });

  it('clears a previously downloaded artifact when a managed download fails', async () => {
    setPlatform('darwin');
    setArch('arm64');
    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    (updater as { status: UpdateStatus }).status = {
      status: 'available',
      mode: 'installed',
      packageType: 'portable_zip',
      canAutoReplace: false,
      requiresMigration: true,
      migrationReason: 'missing-portable-flag',
      disposition: 'manual-migration',
      info: {
        version: '2.0.4',
        package_type: 'portable_zip',
        platform: 'mac',
        arch: 'arm64',
        download_url: 'https://updates.test/failing.zip',
        sha512: 'a'.repeat(128),
        size: 1,
      },
      downloadPath: '/tmp/uclaw-macos-updates/old.zip',
    };
    proxyAwareFetchMock.mockRejectedValueOnce(new Error('download endpoint unavailable'));

    await expect(updater.downloadUpdate()).rejects.toThrow(/download endpoint unavailable/i);
    expect(updater.getStatus()).toMatchObject({
      status: 'error',
      info: undefined,
      progress: undefined,
      downloadPath: undefined,
      error: 'download endpoint unavailable',
    });
  });

  it('rejects a cached available artifact that is not newer than the running version', async () => {
    setPlatform('darwin');
    setArch('arm64');
    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    (updater as { status: UpdateStatus }).status = {
      status: 'available',
      mode: 'installed',
      packageType: 'portable_zip',
      canAutoReplace: false,
      requiresMigration: true,
      migrationReason: 'missing-portable-flag',
      disposition: 'manual-migration',
      info: {
        version: '2.0.3',
        package_type: 'portable_zip',
        platform: 'mac',
        arch: 'arm64',
        download_url: 'https://updates.test/same-version.zip',
        sha512: 'a'.repeat(128),
        size: 1,
      },
    };

    await expect(updater.downloadUpdate()).rejects.toThrow(/not newer/i);
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(updater.getStatus()).toMatchObject({ status: 'error' });
  });

  it('rejects a cached older artifact before touching the download directory', async () => {
    setPlatform('darwin');
    setArch('arm64');
    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    (updater as { status: UpdateStatus }).status = {
      status: 'available',
      mode: 'installed',
      packageType: 'portable_zip',
      canAutoReplace: false,
      requiresMigration: true,
      migrationReason: 'missing-portable-flag',
      disposition: 'manual-migration',
      info: {
        version: '2.0.2',
        package_type: 'portable_zip',
        platform: 'mac',
        arch: 'arm64',
        download_url: 'https://updates.test/older.zip',
        sha512: 'a'.repeat(128),
        size: 1,
      },
    };

    await expect(updater.downloadUpdate()).rejects.toThrow(/not newer/i);
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(updater.getStatus()).toMatchObject({ status: 'error' });
  });

  it('replaces a cached ZIP without deleting the previous target first', async () => {
    const { replaceDownloadedUpdateAtomically } = await import('@electron/main/updater');
    const partialPath = '/tmp/uclaw-macos-updates/UClaw-update-mac.zip.download';
    const targetPath = '/tmp/uclaw-macos-updates/UClaw-update-mac.zip';
    const renameMock = vi.fn(async () => {
      const error = Object.assign(new Error('I/O failure'), { code: 'EIO' });
      throw error;
    });
    const removeMock = vi.fn(async () => undefined);

    await expect(replaceDownloadedUpdateAtomically(partialPath, targetPath, {
      rename: renameMock as never,
      remove: removeMock as never,
    })).rejects.toThrow('I/O failure');

    // A failed first rename must leave the previous target untouched; in
    // particular, no rm(targetPath) operation is attempted by the updater.
    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('rolls the previous cached ZIP back when a replacement rename fails', async () => {
    const { replaceDownloadedUpdateAtomically } = await import('@electron/main/updater');
    const partialPath = '/tmp/uclaw-macos-updates/UClaw-update-mac.zip.download';
    const targetPath = '/tmp/uclaw-macos-updates/UClaw-update-mac.zip';
    const calls: string[] = [];
    let replacementAttempt = 0;
    const renameMock = vi.fn(async (from: string, to: string) => {
      calls.push(`${from}->${to}`);
      if (from === partialPath && to === targetPath && replacementAttempt++ === 0) {
        throw Object.assign(new Error('destination busy'), { code: 'EEXIST' });
      }
      if (from === partialPath && to === targetPath) {
        throw Object.assign(new Error('replacement failed'), { code: 'EIO' });
      }
    });
    const removeMock = vi.fn(async () => undefined);

    await expect(replaceDownloadedUpdateAtomically(partialPath, targetPath, {
      rename: renameMock as never,
      remove: removeMock as never,
    })).rejects.toThrow('replacement failed');

    expect(calls[0]).toBe(`${partialPath}->${targetPath}`);
    expect(calls[1]).toMatch(new RegExp(`^${targetPath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}->${targetPath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\.previous-[0-9a-f-]+$`));
    expect(calls[2]).toBe(`${partialPath}->${targetPath}`);
    // The final rename restores the old target from its unique backup path.
    expect(calls[3]).toMatch(new RegExp(`^${targetPath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\.previous-[0-9a-f-]+->${targetPath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`));
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('does not start an auto-install countdown unless an update is downloaded', async () => {
    setPlatform('darwin');
    setArch('arm64');
    vi.useFakeTimers();
    const { AppUpdater } = await import('@electron/main/updater');
    const updater = new AppUpdater();
    const installSpy = vi.spyOn(updater, 'quitAndInstall');

    try {
      updater.startAutoInstallCountdown();
      vi.advanceTimersByTime(6000);
      expect(installSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a stale auto-install countdown when the status sequence changes', async () => {
    setPlatform('darwin');
    setArch('arm64');
    portableState.dataMode = 'portable';
    portableState.canAutoReplace = true;
    vi.useFakeTimers();
    try {
      const { AppUpdater } = await import('@electron/main/updater');
      const updater = new AppUpdater();
      setDownloadedStatus(updater);
      const installSpy = vi.spyOn(updater, 'quitAndInstall');
      updater.startAutoInstallCountdown();
      const status = (updater as { status: UpdateStatus }).status;
      (updater as { status: UpdateStatus }).status = { ...status, sequence: (status.sequence ?? 0) + 1 };

      vi.advanceTimersByTime(6000);
      expect(installSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when a portable downloaded status has no disposition', async () => {
    setPlatform('darwin');
    setArch('arm64');
    portableState.dataMode = 'portable';
    portableState.canAutoReplace = true;
    vi.useFakeTimers();
    try {
      const { AppUpdater } = await import('@electron/main/updater');
      const updater = new AppUpdater();
      setDownloadedStatus(updater);
      delete (updater as { status: UpdateStatus }).status.disposition;
      const installSpy = vi.spyOn(updater, 'quitAndInstall');

      updater.startAutoInstallCountdown();
      vi.advanceTimersByTime(6000);

      expect(installSpy).not.toHaveBeenCalled();
      expect(shellMock.showItemInFolder).toHaveBeenCalledWith(
        '/tmp/uclaw-macos-updates/UClaw-2.0.4-mac-usb.zip',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
