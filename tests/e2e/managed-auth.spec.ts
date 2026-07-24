import type { ElectronApplication, Page } from '@playwright/test';
import type { ManagedAuthStatus } from '../../shared/managed-auth';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  test,
} from './fixtures/electron';

type ManagedAuthMockState = 'unmanaged' | 'loggedOut' | 'ready';

type RecordedHostInvocation = {
  module?: string;
  action?: string;
  payload?: unknown;
};

const bootstrap = {
  service: {
    name: 'UClaw',
    displayName: 'UClaw',
  },
  auth: {
    registrationEnabled: true,
    emailVerifyEnabled: true,
    loginEnabled: true,
    activationRequired: true,
  },
  runtime: {
    providerId: 'openai',
    accountId: 'openai',
    baseUrl: 'https://mock.invalid/v1',
    apiProtocol: 'openai-responses',
    defaultModel: 'smart-latest',
  },
};

const unmanagedStatus = {
  managed: false,
  hasAuthToken: false,
  hasRefreshToken: false,
  hasRelayToken: false,
  authValid: true,
  deviceActivated: false,
  activationRequired: false,
  bootstrap: {},
} satisfies ManagedAuthStatus;

const loggedOutStatus = {
  managed: true,
  localOnly: true,
  hasAuthToken: false,
  hasRefreshToken: false,
  hasRelayToken: false,
  authValid: false,
  deviceActivated: false,
  activationRequired: true,
  bootstrap,
} satisfies ManagedAuthStatus;

const readyStatus = {
  managed: true,
  localOnly: false,
  hasAuthToken: true,
  hasRefreshToken: true,
  hasRelayToken: true,
  authValid: true,
  deviceActivated: true,
  activationRequired: false,
  user: {
    id: 'user-e2e',
    username: 'uclaw-user',
    email: 'uclaw@example.test',
    displayName: 'UClaw User',
  },
  device: {
    id: 'device-e2e',
    status: 'active',
    activated: true,
  },
  bootstrap,
} satisfies ManagedAuthStatus;

async function installManagedAuthMock(
  app: ElectronApplication,
  initialState: ManagedAuthMockState,
): Promise<void> {
  await app.evaluate(
    async ({ app: _app }, input) => {
      const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');

      type HostRequest = {
        id?: string;
        module?: string;
        action?: string;
        payload?: unknown;
      };
      type HostHandler = (event: unknown, request: HostRequest) => Promise<unknown>;
      type MockGlobals = {
        __managedAuthE2E?: {
          invocations: RecordedHostInvocation[];
        };
      };

      const originalHostInvoke = (ipcMain as unknown as {
        _invokeHandlers?: Map<string, HostHandler>;
      })._invokeHandlers?.get('host:invoke');
      const fixtures: Record<ManagedAuthMockState, ManagedAuthStatus> = input.statuses;
      const globals = globalThis as unknown as MockGlobals;
      const invocations: RecordedHostInvocation[] = [];
      let status: ManagedAuthStatus = fixtures[input.initialState];

      globals.__managedAuthE2E = { invocations };

      const respond = (id: unknown, data: unknown) => ({
        id: typeof id === 'string' ? id : undefined,
        ok: true,
        data,
      });

      ipcMain.removeHandler('host:invoke');
      ipcMain.handle('host:invoke', async (event: unknown, request: HostRequest) => {
        invocations.push({
          module: request?.module,
          action: request?.action,
          payload: request?.payload,
        });

        if (request?.module !== 'managedAuth') {
          return originalHostInvoke?.(event, request) ?? respond(request?.id, {});
        }

        switch (request.action) {
          case 'bootstrap':
            return respond(request.id, status.bootstrap);
          case 'localStatus':
          case 'status':
            return respond(request.id, status);
          case 'checkActivation':
            return respond(request.id, { valid: true });
          case 'sendVerificationCode':
            return respond(request.id, { success: true, countdown: 60 });
          case 'register':
          case 'login':
            status = fixtures.ready;
            return respond(request.id, {
              success: true,
              status,
              user: status.user,
            });
          case 'verify':
          case 'refresh':
            return respond(request.id, { success: true, status });
          case 'logout':
            status = fixtures.loggedOut;
            return respond(request.id, { success: true, status });
          default:
            return respond(request.id, {});
        }
      });
    },
    {
      initialState,
      statuses: {
        unmanaged: unmanagedStatus,
        loggedOut: loggedOutStatus,
        ready: readyStatus,
      },
    },
  );
}

async function getRecordedHostInvocations(app: ElectronApplication): Promise<RecordedHostInvocation[]> {
  return await app.evaluate(() => {
    const globals = globalThis as unknown as {
      __managedAuthE2E?: { invocations: RecordedHostInvocation[] };
    };
    return globals.__managedAuthE2E?.invocations ?? [];
  });
}

/** Overlay the Provider Host API with the managed account snapshot used by the Models page. */
async function installManagedProviderUiMock(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
    type HostRequest = { id?: string; module?: string; action?: string };
    type HostHandler = (event: unknown, request: HostRequest) => Promise<unknown>;
    const originalHostInvoke = (ipcMain as unknown as {
      _invokeHandlers?: Map<string, HostHandler>;
    })._invokeHandlers?.get('host:invoke');
    const respond = (id: unknown, data: unknown) => ({
      id: typeof id === 'string' ? id : undefined,
      ok: true,
      data,
    });
    const now = '2026-07-24T00:00:00.000Z';
    const account = {
      id: 'openai',
      vendorId: 'openai',
      label: 'UClaw',
      authMode: 'api_key',
      baseUrl: 'https://mock.invalid/v1',
      apiProtocol: 'openai-responses',
      model: 'smart-latest',
      enabled: true,
      isDefault: true,
      metadata: { managedBy: 'uclaw', customModels: ['smart-latest'] },
      createdAt: now,
      updatedAt: now,
    };
    const vendor = {
      id: 'openai',
      name: 'UClaw',
      icon: 'U',
      placeholder: '',
      requiresApiKey: false,
      category: 'official',
      defaultModelId: 'smart-latest',
      supportedAuthModes: ['api_key'],
      defaultAuthMode: 'api_key',
      supportsMultipleAccounts: false,
    };

    ipcMain.removeHandler('host:invoke');
    ipcMain.handle('host:invoke', async (event: unknown, request: HostRequest) => {
      if (request?.module !== 'providers') {
        return originalHostInvoke?.(event, request) ?? respond(request?.id, {});
      }
      if (request.action === 'accounts') return respond(request.id, [account]);
      if (request.action === 'accountKeyInfo') {
        return respond(request.id, [{ accountId: 'openai', hasKey: true, keyMasked: null }]);
      }
      if (request.action === 'vendors') return respond(request.id, [vendor]);
      if (request.action === 'getDefaultAccount') return respond(request.id, { accountId: 'openai' });
      if (request.action === 'list') return respond(request.id, []);
      return originalHostInvoke?.(event, request) ?? respond(request?.id, {});
    });
  });
}

async function expectNoLegacyBrand(page: Page): Promise<void> {
  const latinLegacyBrand = new RegExp(['jun', '\\s*', 'fei'].join(''), 'i');
  const chineseLegacyBrand = new RegExp(['君', '\\s*', '飞'].join(''), 'i');
  await expect(page.locator('body')).not.toContainText(latinLegacyBrand);
  await expect(page.locator('body')).not.toContainText(chineseLegacyBrand);
}

async function expectNoGatewayLifecycleFromAuth(app: ElectronApplication): Promise<void> {
  const invocations = await getRecordedHostInvocations(app);
  const gatewayLifecycleInvocations = invocations.filter((invocation) => (
    invocation.module === 'gateway'
    && /^(?:start|restart|reload)$/i.test(invocation.action ?? '')
  ));
  expect(gatewayLifecycleInvocations).toEqual([]);
}

test.describe('UClaw managed account flows', () => {
  test('keeps managed account UI out of an unmanaged build', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ managedProvider: false, skipSetup: true });

    try {
      await installManagedAuthMock(app, 'unmanaged');
      const page = await getStableWindow(app);
      await page.reload();

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByTestId('managed-auth-gate')).toHaveCount(0);
      await page.getByTestId('sidebar-nav-settings').click();
      await expect(page.getByTestId('settings-page')).toBeVisible();
      await expect(page.getByTestId('settings-managed-auth-section')).toHaveCount(0);
      await expect(page.getByText('UClaw account', { exact: true })).toHaveCount(0);
      await expectNoLegacyBrand(page);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('registers and authorizes a managed account during Setup', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ managedProvider: true });

    try {
      await installManagedAuthMock(app, 'loggedOut');
      const page = await getStableWindow(app);
      await page.reload();

      await expect(page.getByTestId('setup-welcome-step')).toBeVisible();
      await page.getByTestId('setup-next-button').click();
      await expect(page.getByTestId('managed-account-auth-panel')).toBeVisible();
      await page.getByTestId('managed-auth-mode-register').click();

      await page.getByTestId('managed-auth-account-input').fill('uclaw-user');
      await page.getByTestId('managed-auth-password-input').fill('Password1');
      await page.getByTestId('managed-auth-activation-input').fill('ACT-E2E');
      await page.getByTestId('managed-auth-check-activation').click();
      await expect(page.getByTestId('managed-account-auth-panel').getByText(
        'Activation code verified',
        { exact: true },
      )).toBeVisible();
      await page.getByTestId('managed-auth-send-code').click();
      await page.getByTestId('managed-auth-verify-input').fill('123456');
      await page.getByTestId('managed-auth-submit').click();

      await expect(page.getByText('UClaw registration and activation completed', { exact: true })).toBeVisible();
      await expect(page.getByTestId('setup-next-button')).toBeEnabled();
      await expectNoLegacyBrand(page);

      const invocations = await getRecordedHostInvocations(app);
      expect(invocations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          module: 'managedAuth',
          action: 'checkActivation',
          payload: { code: 'ACT-E2E' },
        }),
        expect.objectContaining({
          module: 'managedAuth',
          action: 'sendVerificationCode',
          payload: { account: 'uclaw-user' },
        }),
        expect.objectContaining({
          module: 'managedAuth',
          action: 'register',
          payload: expect.objectContaining({
            account: 'uclaw-user',
            username: 'uclaw-user',
            activationCode: 'ACT-E2E',
            verifyCode: '123456',
          }),
        }),
      ]));
      await expectNoGatewayLifecycleFromAuth(app);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('recovers a completed profile through the global login Gate', async ({ launchElectronApp }) => {
    const setupApp = await launchElectronApp({ managedProvider: false });
    try {
      const setupPage = await getStableWindow(setupApp);
      await expect(setupPage.getByTestId('setup-skip-button')).toBeVisible();
      await setupPage.getByTestId('setup-skip-button').click();
      await expect(setupPage.getByTestId('main-layout')).toBeVisible();
    } finally {
      await closeElectronApp(setupApp);
    }

    const app = await launchElectronApp({ managedProvider: true });
    try {
      const page = await getStableWindow(app);
      await installManagedAuthMock(app, 'loggedOut');
      await page.reload();

      await expect(page.getByTestId('managed-auth-gate')).toBeVisible();
      await expect(page.getByTestId('managed-auth-gate').getByText('UClaw', { exact: true })).toBeVisible();
      await expect(page.getByTestId('managed-auth-mode-login')).toBeVisible();
      await expect(page.getByTestId('managed-auth-mode-register')).toBeVisible();
      await expect(page.getByTestId('managed-auth-activation-input')).toHaveCount(0);
      await expectNoLegacyBrand(page);

      await page.getByTestId('managed-auth-account-input').fill('uclaw-user');
      await page.getByTestId('managed-auth-password-input').fill('Password1');
      await page.getByTestId('managed-auth-submit').click();

      await expect(page.getByTestId('managed-auth-gate')).toHaveCount(0);
      await expect(page.getByTestId('main-layout')).toBeVisible();
      const invocations = await getRecordedHostInvocations(app);
      const loginInvocation = invocations.find((invocation) => (
        invocation.module === 'managedAuth' && invocation.action === 'login'
      ));
      expect(loginInvocation?.payload).toEqual(expect.objectContaining({ account: 'uclaw-user' }));
      expect((loginInvocation?.payload as { activationCode?: string } | undefined)?.activationCode).toBeUndefined();
      await expectNoGatewayLifecycleFromAuth(app);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('shows managed status in Settings and logs out without touching Gateway lifecycle', async ({ launchElectronApp }) => {
    const setupApp = await launchElectronApp({ managedProvider: false });
    try {
      const setupPage = await getStableWindow(setupApp);
      await expect(setupPage.getByTestId('setup-skip-button')).toBeVisible();
      await setupPage.getByTestId('setup-skip-button').click();
      await expect(setupPage.getByTestId('main-layout')).toBeVisible();
    } finally {
      await closeElectronApp(setupApp);
    }

    const app = await launchElectronApp({ managedProvider: true });

    try {
      await installManagedAuthMock(app, 'ready');
      await installManagedProviderUiMock(app);
      const page = await getStableWindow(app);
      await page.reload();

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await page.getByTestId('sidebar-nav-models').click();
      await expect(page.getByTestId('provider-card-openai')).toBeVisible();
      await expect(page.getByTestId('providers-add-button')).toHaveCount(0);
      await expect(page.getByTestId('provider-edit-openai')).toHaveCount(0);
      await expect(page.getByTestId('provider-delete-openai')).toHaveCount(0);

      await page.getByTestId('sidebar-nav-settings').click();
      await expect(page.getByTestId('settings-managed-auth-section')).toBeVisible();
      await expect(page.getByTestId('settings-managed-auth-status')).toHaveText('Signed in');
      await expect(page.getByText('UClaw account', { exact: true })).toBeVisible();
      await expectNoLegacyBrand(page);

      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByTestId('settings-managed-auth-status')).toHaveText('Signed out');
      await expectNoLegacyBrand(page);

      const invocations = await getRecordedHostInvocations(app);
      expect(invocations).toEqual(expect.arrayContaining([
        expect.objectContaining({ module: 'managedAuth', action: 'logout' }),
      ]));
      await expectNoGatewayLifecycleFromAuth(app);
    } finally {
      await closeElectronApp(app);
    }
  });
});
