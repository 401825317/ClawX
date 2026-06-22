import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

async function measureNavigation(
  page: Awaited<ReturnType<typeof getStableWindow>>,
  navTestId: string,
  targetTestId: string,
): Promise<number> {
  const startedAt = Date.now();
  await page.getByTestId(navTestId).click();
  await expect(page.getByTestId(targetTestId)).toBeVisible();
  return Date.now() - startedAt;
}

test.describe('ClawX navigation responsiveness', () => {
  test('keeps core navigation responsive with developer mode enabled', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const page = await getStableWindow(app);

      await expect(page.getByTestId('main-layout')).toBeVisible();

      await page.getByTestId('sidebar-nav-settings').click();
      await expect(page.getByTestId('settings-page')).toBeVisible();
      const devModeSwitch = page.getByTestId('settings-dev-mode-switch');
      await expect(devModeSwitch).toBeVisible();
      if (await devModeSwitch.getAttribute('data-state') !== 'checked') {
        await devModeSwitch.click();
      }
      await expect(page.getByTestId('sidebar-nav-dreams')).toBeVisible();

      const timings = {
        models: await measureNavigation(page, 'sidebar-nav-models', 'models-page'),
        agents: await measureNavigation(page, 'sidebar-nav-agents', 'agents-page'),
        channels: await measureNavigation(page, 'sidebar-nav-channels', 'channels-page'),
        settings: await measureNavigation(page, 'sidebar-nav-settings', 'settings-page'),
      };

      console.info('[navigation:perf]', JSON.stringify({ timings }));

      for (const [route, durationMs] of Object.entries(timings)) {
        expect(durationMs, `${route} navigation should not block on heavy background work`).toBeLessThan(5_000);
      }
    } finally {
      await closeElectronApp(app);
    }
  });
});
