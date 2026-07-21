import { expect, test, completeSetup } from './fixtures/electron';

test.describe('ClawX update notifications', () => {
  test('prompts when a new version is available', async ({ electronApp, page }) => {
    await completeSetup(page);

    await electronApp.evaluate(() => {
      const { BrowserWindow } = process.mainModule!.require('electron') as typeof import('electron');
      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      win?.webContents.send('update:status-changed', {
        status: 'available',
        info: {
          version: '9.9.9',
          releaseDate: new Date().toISOString(),
        },
      });
    });

    await expect(page.getByText(/9\.9\.9/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Download|下载|ダウンロード|Скачать/i })).toBeVisible();
  });

  test('keeps a primary feed failure hidden when the legacy fallback succeeds', async ({ electronApp, page }) => {
    await completeSetup(page);

    // Replace only the updater transport so the real AppUpdater fallback and status projection run.
    await electronApp.evaluate(() => {
      const { createRequire } = process.mainModule!.require('node:module') as typeof import('node:module');
      const requireFromApp = createRequire(`${process.cwd()}/package.json`);
      const { autoUpdater } = requireFromApp('electron-updater') as typeof import('electron-updater');
      const testUpdater = autoUpdater as typeof autoUpdater & {
        __uclawOriginalCheckForUpdates?: typeof autoUpdater.checkForUpdates;
        __uclawUpdateAttempts?: number;
        __uclawUpdateMode?: 'fallback-success' | 'both-fail';
      };
      testUpdater.__uclawOriginalCheckForUpdates = autoUpdater.checkForUpdates;
      testUpdater.__uclawUpdateAttempts = 0;
      testUpdater.__uclawUpdateMode = 'fallback-success';
      autoUpdater.checkForUpdates = async () => {
        testUpdater.__uclawUpdateAttempts = (testUpdater.__uclawUpdateAttempts || 0) + 1;
        if (testUpdater.__uclawUpdateAttempts === 1 || testUpdater.__uclawUpdateMode === 'both-fail') {
          const error = new Error(
            testUpdater.__uclawUpdateAttempts === 1
              ? 'simulated managed feed failure'
              : 'simulated legacy feed failure',
          );
          autoUpdater.emit('error', error);
          throw error;
        }
        const updateInfo = {
          version: '1.0.2',
          files: [],
          path: '',
          sha512: '',
          releaseDate: new Date(0).toISOString(),
        };
        autoUpdater.emit('update-not-available', updateInfo);
        return { updateInfo } as Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>;
      };
    });

    try {
      const result = await page.evaluate(() => window.electron.ipcRenderer.invoke('update:check')) as {
        success: boolean;
        status?: { status?: string; error?: string };
      };
      expect(result.success).toBe(true);
      expect(result.status?.status).toBe('not-available');
      expect(result.status?.error).toBeUndefined();

      await electronApp.evaluate(() => {
        const { createRequire } = process.mainModule!.require('node:module') as typeof import('node:module');
        const requireFromApp = createRequire(`${process.cwd()}/package.json`);
        const { autoUpdater } = requireFromApp('electron-updater') as typeof import('electron-updater');
        const testUpdater = autoUpdater as typeof autoUpdater & {
          __uclawUpdateAttempts?: number;
          __uclawUpdateMode?: 'fallback-success' | 'both-fail';
        };
        testUpdater.__uclawUpdateAttempts = 0;
        testUpdater.__uclawUpdateMode = 'both-fail';
      });
      const failed = await page.evaluate(() => window.electron.ipcRenderer.invoke('update:check')) as {
        success: boolean;
        status?: { status?: string; error?: string };
      };
      expect(failed.success).toBe(false);
      expect(failed.status?.status).toBe('error');
      expect(failed.status?.error).toBe('simulated legacy feed failure');
    } finally {
      const attempts = await electronApp.evaluate(() => {
        const { createRequire } = process.mainModule!.require('node:module') as typeof import('node:module');
        const requireFromApp = createRequire(`${process.cwd()}/package.json`);
        const { autoUpdater } = requireFromApp('electron-updater') as typeof import('electron-updater');
        const testUpdater = autoUpdater as typeof autoUpdater & {
          __uclawOriginalCheckForUpdates?: typeof autoUpdater.checkForUpdates;
          __uclawUpdateAttempts?: number;
          __uclawUpdateMode?: 'fallback-success' | 'both-fail';
        };
        if (testUpdater.__uclawOriginalCheckForUpdates) {
          autoUpdater.checkForUpdates = testUpdater.__uclawOriginalCheckForUpdates;
        }
        const value = testUpdater.__uclawUpdateAttempts || 0;
        delete testUpdater.__uclawOriginalCheckForUpdates;
        delete testUpdater.__uclawUpdateAttempts;
        delete testUpdater.__uclawUpdateMode;
        return value;
      });
      expect(attempts).toBe(2);
    }
  });
});
