import type { ElectronApplication } from '@playwright/test';
import {
  completeSetup,
  expect,
  getRecordedHostInvocations,
  installIpcMocks,
  test,
} from './fixtures/electron';

const MANUAL_MIGRATION_STATUS = {
  mode: 'installed',
  packageType: 'portable_zip',
  canAutoReplace: false,
  requiresMigration: true,
  migrationReason: 'incomplete-structure',
  disposition: 'manual-migration',
  info: {
    version: '9.9.9',
    releaseDate: '2026-09-01T00:00:00.000Z',
  },
} as const;

async function emitUpdateStatus(
  electronApp: ElectronApplication,
  status: 'available' | 'downloaded',
): Promise<void> {
  await electronApp.evaluate((_electronApp, payload) => {
    const { BrowserWindow } = process.mainModule!.require('electron') as typeof import('electron');
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    win?.webContents.send('update:status-changed', payload);
  }, { status, sequence: 100, ...MANUAL_MIGRATION_STATUS });
}

test.describe('ClawX update notifications', () => {
  test('prompts when a new version is available', async ({ electronApp, page }) => {
    await completeSetup(page);

    await electronApp.evaluate(() => {
      const { BrowserWindow } = process.mainModule!.require('electron') as typeof import('electron');
      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      win?.webContents.send('update:status-changed', {
        status: 'available',
        sequence: 100,
        info: {
          version: '9.9.9',
          releaseDate: new Date().toISOString(),
        },
      });
    });

    await expect(page.getByText(/9\.9\.9/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Download|下载|ダウンロード|Скачать/i })).toBeVisible();
  });

  test('keeps incomplete macOS layouts on the portable ZIP manual-migration flow', async ({ electronApp, page }) => {
    await completeSetup(page);
    await installIpcMocks(electronApp, {
      recordHostInvocations: true,
      hostApi: {
        '["updates","download",null]': {
          success: true,
          status: { status: 'downloaded', ...MANUAL_MIGRATION_STATUS },
        },
        '["updates","install",null]': {
          success: true,
          status: { status: 'downloaded', ...MANUAL_MIGRATION_STATUS },
        },
      },
    });

    await emitUpdateStatus(electronApp, 'available');

    await expect(page.getByText(/portable ZIP/i)).toBeVisible();
    const downloadButton = page.getByRole('button', { name: 'Download Portable Package' });
    await expect(downloadButton).toBeVisible();
    await expect(page.getByRole('button', { name: /Install.*Restart|Update.*Restart/i })).toHaveCount(0);
    await downloadButton.click();

    await expect.poll(async () => (
      await getRecordedHostInvocations(electronApp)
    ).filter(({ module, action }) => module === 'updates' && action === 'download').length).toBe(1);

    await emitUpdateStatus(electronApp, 'downloaded');
    await electronApp.evaluate(() => {
      const { BrowserWindow } = process.mainModule!.require('electron') as typeof import('electron');
      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      win?.webContents.send('update:auto-install-countdown', { seconds: 9 });
    });

    await expect(page.getByText(/manually migrate/i)).toBeVisible();
    const openPackageButton = page.getByRole('button', { name: 'Open Migration Package' });
    await expect(openPackageButton).toBeVisible();
    await expect(page.getByText(/Restarting to install update/i)).toHaveCount(0);
    await openPackageButton.dispatchEvent('click');

    await expect.poll(async () => (
      await getRecordedHostInvocations(electronApp)
    ).filter(({ module, action }) => module === 'updates' && action === 'install').length).toBe(1);

    await page.getByTestId('sidebar-nav-settings').click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect(page.getByText('Portable package downloaded: v9.9.9 (manual migration required)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Migration Package' })).toBeVisible();
    await expect(page.getByText(/Restarting to install update/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  });
});
