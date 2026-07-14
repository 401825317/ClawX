import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closeElectronApp, expect, test } from './fixtures/electron';

test.describe('ClawX Electron smoke flows', () => {
  test('shows the setup wizard on a fresh profile', async ({ page }) => {
    await expect(page.getByTestId('setup-page')).toBeVisible();
    await expect(page.getByTestId('setup-welcome-step')).toBeVisible();
    await expect(page.getByTestId('setup-skip-button')).toBeVisible();
  });

  test('ignores legacy renderer setup state on a fresh main profile', async ({ page }) => {
    await page.evaluate(() => {
      window.localStorage.setItem('clawx-settings', JSON.stringify({
        state: { setupComplete: true },
        version: 0,
      }));
    });
    await page.reload();

    await expect(page.getByTestId('setup-page')).toBeVisible();
    await expect(page.getByTestId('main-layout')).toHaveCount(0);
  });

  test('can skip setup and navigate to the models page', async ({ page }) => {
    await expect(page.getByTestId('setup-page')).toBeVisible();
    await page.getByTestId('setup-skip-button').click();

    await expect(page.getByTestId('main-layout')).toBeVisible();
    await page.getByTestId('sidebar-nav-models').click();

    await expect(page.getByTestId('models-page')).toBeVisible();
    await expect(page.getByTestId('models-page-title')).toBeVisible();
    await expect(page.getByTestId('providers-settings')).toBeVisible();
  });

  test('persists skipped setup across relaunch for the same isolated profile', async ({ electronApp, launchElectronApp }) => {
    const firstWindow = await electronApp.firstWindow();
    await firstWindow.waitForLoadState('domcontentloaded');
    await firstWindow.getByTestId('setup-skip-button').click();
    await expect(firstWindow.getByTestId('main-layout')).toBeVisible();

    await closeElectronApp(electronApp);

    const relaunchedApp = await launchElectronApp();
    try {
      const relaunchedWindow = await relaunchedApp.firstWindow();
      await relaunchedWindow.waitForLoadState('domcontentloaded');

      await expect(relaunchedWindow.getByTestId('main-layout')).toBeVisible();
      await expect(relaunchedWindow.getByTestId('setup-page')).toHaveCount(0);
    } finally {
      await closeElectronApp(relaunchedApp);
    }
  });

  test('migrates an activated legacy main profile without reopening setup', async ({ launchElectronApp, userDataDir }) => {
    await writeFile(join(userDataDir, 'settings.json'), JSON.stringify({
      gatewayAutoStart: true,
      gatewayPort: 18789,
    }));
    await writeFile(join(userDataDir, 'clawx-device-activation.json'), JSON.stringify({
      activated: true,
      onboardingCompleted: true,
      source: 'login',
    }));

    const app = await launchElectronApp();
    try {
      const window = await app.firstWindow();
      await window.waitForLoadState('domcontentloaded');

      await expect(window.getByTestId('main-layout')).toBeVisible();
      await expect(window.getByTestId('setup-page')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('does not migrate a managed legacy profile that lacks JunFeiAI auth and relay secrets', async ({ launchElectronApp, userDataDir }) => {
    await writeFile(join(userDataDir, 'settings.json'), JSON.stringify({ gatewayAutoStart: true }));
    await writeFile(join(userDataDir, 'clawx-device-activation.json'), JSON.stringify({
      activated: true,
      onboardingCompleted: true,
      source: 'login',
    }));
    await writeFile(join(userDataDir, 'clawx-providers.json'), JSON.stringify({
      providerSecrets: {
        openai: { type: 'api_key', accountId: 'openai', apiKey: 'legacy-provider-key' },
      },
    }));

    const app = await launchElectronApp({ managedProvider: true });
    try {
      const window = await app.firstWindow();
      await window.waitForLoadState('domcontentloaded');

      await expect(window.getByTestId('setup-page')).toBeVisible();
      await expect(window.getByTestId('main-layout')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });
});
