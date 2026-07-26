// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdatesApi } from '@electron/services/updates-api';
import type { AppUpdater, UpdateStatus } from '@electron/main/updater';

function createUpdaterMock() {
  return {
    getStatus: vi.fn<() => UpdateStatus>(() => ({
      status: 'available' as const,
      mode: 'portable' as const,
      info: {
        version: '1.2.3',
        releaseDate: '2026-07-25T00:00:00.000Z',
        releaseNotes: 'Portable update',
        download_url: 'https://download.test/UClaw-1.2.3-win-x64-usb.zip',
        package_type: 'portable_zip',
        file_name: 'UClaw-1.2.3-win-x64-usb.zip',
        sha512: 'a'.repeat(128),
        size: 123,
      },
    })),
    getCurrentVersion: vi.fn(() => '1.2.2'),
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => ({ downloadPath: 'C:\\runtime\\updates\\UClaw.zip' })),
    installDownloadedUpdate: vi.fn(async () => undefined),
    setChannel: vi.fn(),
    setAutoDownload: vi.fn(),
    cancelAutoInstall: vi.fn(),
  };
}

describe('updates Typed Host API', () => {
  let updater: ReturnType<typeof createUpdaterMock>;

  beforeEach(() => {
    updater = createUpdaterMock();
  });

  it('normalizes portable metadata and mode for the renderer', () => {
    const api = createUpdatesApi(updater as unknown as AppUpdater);

    expect(api.status()).toEqual({
      status: 'available',
      mode: 'portable',
      info: {
        version: '1.2.3',
        releaseDate: '2026-07-25T00:00:00.000Z',
        releaseNotes: 'Portable update',
        downloadUrl: 'https://download.test/UClaw-1.2.3-win-x64-usb.zip',
        channel: undefined,
        platform: undefined,
        arch: undefined,
        packageType: 'portable_zip',
        fileName: 'UClaw-1.2.3-win-x64-usb.zip',
        sha512: 'a'.repeat(128),
        size: 123,
        mandatory: undefined,
      },
      progress: undefined,
      error: undefined,
      downloadPath: undefined,
    });
  });

  it('returns the final status and portable download path after download', async () => {
    updater.getStatus.mockReturnValue({
      status: 'downloaded',
      mode: 'portable',
      info: { version: '1.2.3' },
      downloadPath: 'C:\\runtime\\updates\\UClaw.zip',
    });
    const api = createUpdatesApi(updater as unknown as AppUpdater);

    await expect(api.download()).resolves.toMatchObject({
      success: true,
      downloadPath: 'C:\\runtime\\updates\\UClaw.zip',
      status: {
        status: 'downloaded',
        mode: 'portable',
        downloadPath: 'C:\\runtime\\updates\\UClaw.zip',
      },
    });
  });

  it('returns an error status when portable installation fails', async () => {
    updater.installDownloadedUpdate.mockRejectedValueOnce(new Error('helper blocked'));
    updater.getStatus.mockReturnValue({
      status: 'error',
      mode: 'portable',
      info: { version: '1.2.3' },
      error: 'helper blocked',
      downloadPath: 'C:\\runtime\\updates\\UClaw.zip',
    });
    const api = createUpdatesApi(updater as unknown as AppUpdater);

    await expect(api.install()).resolves.toMatchObject({
      success: false,
      error: 'Error: helper blocked',
      status: { status: 'error', mode: 'portable', error: 'helper blocked' },
    });
  });
});
