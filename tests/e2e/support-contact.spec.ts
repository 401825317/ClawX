import type { ElectronApplication } from '@playwright/test';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  test,
} from './fixtures/electron';

type RecordedSupportInvocation = {
  module?: string;
  action?: string;
  payload?: unknown;
};

const QR_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function installSupportMock(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ qrDataUrl }) => {
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
    type HostRequest = {
      id?: string;
      module?: string;
      action?: string;
      payload?: unknown;
    };
    type HostHandler = (event: unknown, request: HostRequest) => Promise<unknown>;
    const originalHostInvoke = (ipcMain as unknown as {
      _invokeHandlers?: Map<string, HostHandler>;
    })._invokeHandlers?.get('host:invoke');
    const invocations: RecordedSupportInvocation[] = [];
    (globalThis as unknown as {
      __supportE2E?: { invocations: RecordedSupportInvocation[] };
    }).__supportE2E = { invocations };

    const respond = (id: unknown, data: unknown) => ({
      id: typeof id === 'string' ? id : undefined,
      ok: true,
      data,
    });

    ipcMain.removeHandler('host:invoke');
    ipcMain.handle('host:invoke', async (event: unknown, request: HostRequest) => {
      if (request?.module !== 'support') {
        return originalHostInvoke?.(event, request) ?? respond(request?.id, {});
      }
      invocations.push({ module: request.module, action: request.action, payload: request.payload });
      return respond(request.id, {
        enabled: true,
        title: 'UClaw Support',
        description: 'Account, billing, and model assistance.',
        contacts: [
          {
            id: 'account',
            label: 'Account support',
            description: 'For sign-in and device authorization',
            qrCodeUrl: qrDataUrl,
            workHours: '09:00-18:00',
            wechatId: 'uclaw-account',
          },
          {
            id: 'model',
            label: 'Model support',
            qrCodeUrl: qrDataUrl,
            extraNote: 'Include the request time when asking for help.',
          },
        ],
      });
    });
  }, { qrDataUrl: QR_DATA_URL });
}

test('opens server-configured Help & Support through the typed Host API', async ({ launchElectronApp }) => {
  const app = await launchElectronApp({ skipSetup: true });

  try {
    await installSupportMock(app);
    const page = await getStableWindow(app);
    await page.reload();

    const entry = page.getByTestId('sidebar-support-contact');
    await expect(entry).toBeVisible();
    await expect(entry).toContainText('Help & Support');
    await entry.click();

    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('heading', { name: 'UClaw Support' })).toBeVisible();
    await expect(drawer.getByText('Account support', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Model support', { exact: true })).toBeVisible();
    await expect(drawer.getByAltText('Account support QR code')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Copy WeChat ID: uclaw-account' })).toBeVisible();

    const invocations = await app.evaluate(() => (
      (globalThis as unknown as {
        __supportE2E?: { invocations: RecordedSupportInvocation[] };
      }).__supportE2E?.invocations ?? []
    ));
    expect(invocations.length).toBeGreaterThanOrEqual(2);
    expect(invocations.every((invocation) => (
      invocation.module === 'support'
      && invocation.action === 'config'
      && invocation.payload === undefined
    ))).toBe(true);
  } finally {
    await closeElectronApp(app);
  }
});
