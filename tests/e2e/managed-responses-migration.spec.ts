import {
  closeElectronApp,
  expect,
  getStableWindow,
  installIpcMocks,
  test,
} from './fixtures/electron';

function hostJson(json: unknown) {
  return {
    ok: true,
    data: {
      status: 200,
      ok: true,
      json,
    },
  };
}

test('offers an explicit native Responses migration for the managed legacy provider', async ({
  launchElectronApp,
}) => {
  const now = new Date().toISOString();
  const electronApp = await launchElectronApp({ skipSetup: true });
  try {
    const page = await getStableWindow(electronApp);
    await installIpcMocks(electronApp, {
      hostApi: {
      '["/api/provider-accounts","GET"]': hostJson([{
        id: 'lingzhiwuxian',
        vendorId: 'lingzhiwuxian',
        label: '零至无限',
        authMode: 'api_key',
        baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
        apiProtocol: 'openai-completions',
        model: 'smart-latest',
        enabled: true,
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      }]),
      '["/api/provider-accounts/key-info","GET"]': hostJson([{
        accountId: 'lingzhiwuxian',
        hasKey: true,
        keyMasked: '****',
      }]),
      '["/api/provider-vendors","GET"]': hostJson([{
        id: 'lingzhiwuxian',
        name: '零至无限',
        requiresApiKey: false,
        supportsMultipleAccounts: false,
      }]),
      '["/api/provider-accounts/default","GET"]': hostJson({ accountId: 'lingzhiwuxian' }),
      '["/api/provider-accounts/migrate-openai-chat","POST"]': hostJson({
        success: true,
        relaunching: true,
      }),
      },
    });
    await page.reload();
    await expect(page.getByTestId('main-layout')).toBeVisible();
    await page.getByTestId('sidebar-nav-models').click();

    await expect(page.getByTestId('managed-openai-migration-card')).toBeVisible();
    await expect(page.getByTestId('managed-openai-migration-button')).toBeEnabled();
    await page.getByTestId('managed-openai-migration-button').click();
    await expect(page.getByTestId('managed-openai-migration-button')).toBeDisabled();
  } finally {
    await closeElectronApp(electronApp);
  }
});
