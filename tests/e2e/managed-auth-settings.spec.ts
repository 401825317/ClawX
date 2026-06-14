import { completeSetup, expect, test } from './fixtures/electron';

test.describe('Managed account settings UI', () => {
  test('shows account status at the top of settings without blocking unmanaged e2e builds', async ({ page }) => {
    await completeSetup(page);

    await expect(page.getByTestId('managed-auth-gate')).toHaveCount(0);

    await page.getByTestId('sidebar-nav-settings').click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect(page.getByTestId('settings-managed-auth-section')).toBeVisible();
    await expect(page.getByTestId('settings-managed-auth-status')).toBeVisible();
  });
});
