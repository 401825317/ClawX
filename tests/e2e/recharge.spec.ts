import type { ElectronApplication } from '@playwright/test';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  test,
} from './fixtures/electron';

type RecordedBillingInvocation = {
  module?: string;
  action?: string;
  payload?: unknown;
};

async function installBillingMock(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
    type HostRequest = {
      id?: string;
      module?: string;
      action?: string;
      payload?: unknown;
    };
    type HostHandler = (event: unknown, request: HostRequest) => Promise<unknown>;
    type BillingGlobals = {
      __billingE2E?: { invocations: RecordedBillingInvocation[] };
    };
    const originalHostInvoke = (ipcMain as unknown as {
      _invokeHandlers?: Map<string, HostHandler>;
    })._invokeHandlers?.get('host:invoke');
    const invocations: RecordedBillingInvocation[] = [];
    const globals = globalThis as unknown as BillingGlobals;
    globals.__billingE2E = { invocations };

    const respond = (id: unknown, data: unknown) => ({
      id: typeof id === 'string' ? id : undefined,
      ok: true,
      data,
    });

    ipcMain.removeHandler('host:invoke');
    ipcMain.handle('host:invoke', async (event: unknown, request: HostRequest) => {
      if (request?.module !== 'billing') {
        return originalHostInvoke?.(event, request) ?? respond(request?.id, {});
      }

      invocations.push({ module: request.module, action: request.action, payload: request.payload });
      if (request.action === 'overview') {
        return respond(request.id, {
          success: true,
          data: {
            balance: 1200,
            quotaPerUnit: 1000,
            creditUsdPerCny: 0.2,
            onlineTopupEnabled: true,
            products: [{
              id: 7,
              name: 'Standard recharge',
              description: 'UClaw balance',
              enabled: true,
              sortOrder: 1,
              stock: null,
              allowedGroupIds: [1],
            }],
            paymentMethods: [{ type: 'alipay', name: 'Alipay' }],
          },
        });
      }
      if (request.action === 'history') {
        return respond(request.id, {
          success: true,
          data: {
            page: 1,
            pageSize: 20,
            total: 1,
            items: [{
              tradeNo: 'history-1',
              amountYuan: 5,
              creditQuota: 1000,
              paymentMethod: 'Alipay',
              paymentProvider: 'epay',
              status: 'success',
              createdAt: Date.UTC(2026, 6, 23, 12, 0, 0),
            }],
          },
        });
      }
      if (request.action === 'createOrder') {
        return respond(request.id, {
          success: true,
          data: {
            tradeNo: 'trade-e2e',
            status: 'pending',
            amountYuan: 5,
            creditQuota: 1000,
            paymentMethod: 'Alipay',
            checkoutUrl: 'https://pay.example.test/trade-e2e',
            qrCode: 'https://pay.example.test/qr/trade-e2e',
          },
        });
      }
      if (request.action === 'orderStatus') {
        return respond(request.id, {
          success: true,
          data: { tradeNo: 'trade-e2e', status: 'success', creditQuota: 1000 },
        });
      }
      return respond(request.id, { success: false, errorCode: 'request_failed' });
    });
  });
}

async function billingInvocations(app: ElectronApplication): Promise<RecordedBillingInvocation[]> {
  return await app.evaluate(() => {
    const globals = globalThis as unknown as {
      __billingE2E?: { invocations: RecordedBillingInvocation[] };
    };
    return globals.__billingE2E?.invocations ?? [];
  });
}

test('recharges through the typed billing Host API and reads order history', async ({ launchElectronApp }) => {
  const app = await launchElectronApp({ skipSetup: true });

  try {
    await installBillingMock(app);
    const page = await getStableWindow(app);
    await page.reload();

    await page.getByTestId('sidebar-nav-recharge').click();
    await expect(page.getByTestId('recharge-page')).toBeVisible();
    await expect(page.getByText('1,200', { exact: true })).toBeVisible();

    await page.getByLabel('Amount').fill('5');
    await page.getByRole('button', { name: 'Generate payment code' }).click();
    await expect(page.getByRole('dialog').getByText('Order payment')).toBeVisible();
    await expect(page.getByRole('dialog').locator('svg[role="img"]')).toBeVisible();
    await page.getByRole('button', { name: 'Check status' }).click();
    await expect(page.getByRole('dialog').getByText(
      'Payment complete. Your shrimp balance is updated',
      { exact: true },
    )).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();

    await page.getByRole('button', { name: 'Order history' }).click();
    await expect(page.getByRole('dialog').getByText('Order history', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('CN¥5.00', { exact: true })).toBeVisible();

    const invocations = await billingInvocations(app);
    expect(invocations).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: 'billing', action: 'overview' }),
      expect.objectContaining({
        module: 'billing',
        action: 'createOrder',
        payload: { amountFen: 500, paymentMethod: 'alipay', productId: 7 },
      }),
      expect.objectContaining({
        module: 'billing',
        action: 'orderStatus',
        payload: { tradeNo: 'trade-e2e' },
      }),
      expect.objectContaining({ module: 'billing', action: 'history' }),
    ]));
    expect(JSON.stringify(invocations)).not.toMatch(/accessToken|refreshToken|relayToken|hostapi:fetch/);
  } finally {
    await closeElectronApp(app);
  }
});
