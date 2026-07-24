import type { ElectronApplication } from '@playwright/test';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  test,
} from './fixtures/electron';
import { UCLAW_BILLING_ORDER_STATUS_POLL_INTERVAL_MS } from '../../shared/junfeiai-endpoints';

type BillingMockOrderStatus = 'pending' | 'success' | 'auth_expired';
type BillingMockHistoryResponse = {
  delayMs: number;
  page: number;
  total: number;
  tradeNo: string;
};

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
      __billingE2E?: {
        createOrderDelayMs: number;
        historyResponses: BillingMockHistoryResponse[];
        invocations: RecordedBillingInvocation[];
        orderStatus: BillingMockOrderStatus;
      };
    };
    const originalHostInvoke = (ipcMain as unknown as {
      _invokeHandlers?: Map<string, HostHandler>;
    })._invokeHandlers?.get('host:invoke');
    const invocations: RecordedBillingInvocation[] = [];
    const globals = globalThis as unknown as BillingGlobals;
    globals.__billingE2E = {
      createOrderDelayMs: 0,
      historyResponses: [],
      invocations,
      orderStatus: 'pending',
    };

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
        const queuedResponse = globals.__billingE2E?.historyResponses.shift();
        if (queuedResponse && queuedResponse.delayMs > 0) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, queuedResponse.delayMs));
        }
        const page = queuedResponse?.page ?? 1;
        const tradeNo = queuedResponse?.tradeNo ?? 'history-1';
        return respond(request.id, {
          success: true,
          data: {
            page,
            pageSize: 20,
            total: queuedResponse?.total ?? 1,
            items: [{
              tradeNo,
              amountYuan: 5,
              creditQuota: 1000,
              paymentMethod: 'alipay',
              paymentProvider: 'epay',
              status: 'success',
              createdAt: Date.UTC(2026, 6, 23, 12, 0, 0),
              completedAt: Date.UTC(2026, 6, 23, 12, 1, 0),
            }],
          },
        });
      }
      if (request.action === 'createOrder') {
        const delayMs = globals.__billingE2E?.createOrderDelayMs ?? 0;
        if (delayMs > 0) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
        }
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
        const responseStatus = globals.__billingE2E?.orderStatus ?? 'pending';
        if (responseStatus === 'auth_expired') {
          return respond(request.id, { success: false, errorCode: 'auth_expired' });
        }
        return respond(request.id, {
          success: true,
          data: {
            tradeNo: 'trade-e2e',
            status: responseStatus,
            creditQuota: 1,
          },
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

async function setBillingOrderStatus(
  app: ElectronApplication,
  status: BillingMockOrderStatus,
): Promise<void> {
  await app.evaluate((_electron, nextStatus) => {
    const globals = globalThis as unknown as {
      __billingE2E?: { orderStatus: BillingMockOrderStatus };
    };
    if (!globals.__billingE2E) throw new Error('Billing E2E mock is not installed');
    globals.__billingE2E.orderStatus = nextStatus;
  }, status);
}

async function setBillingCreateOrderDelay(
  app: ElectronApplication,
  delayMs: number,
): Promise<void> {
  await app.evaluate((_electron, nextDelayMs) => {
    const globals = globalThis as unknown as {
      __billingE2E?: { createOrderDelayMs: number };
    };
    if (!globals.__billingE2E) throw new Error('Billing E2E mock is not installed');
    globals.__billingE2E.createOrderDelayMs = nextDelayMs;
  }, delayMs);
}

async function setBillingHistoryResponses(
  app: ElectronApplication,
  responses: BillingMockHistoryResponse[],
): Promise<void> {
  await app.evaluate((_electron, nextResponses) => {
    const globals = globalThis as unknown as {
      __billingE2E?: { historyResponses: BillingMockHistoryResponse[] };
    };
    if (!globals.__billingE2E) throw new Error('Billing E2E mock is not installed');
    globals.__billingE2E.historyResponses = nextResponses;
  }, responses);
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
    const checkoutDialog = page.getByRole('dialog').filter({ hasText: 'Order payment' });
    await expect(checkoutDialog).toBeVisible();
    await expect(checkoutDialog.locator('svg[role="img"]')).toBeVisible();

    await checkoutDialog.getByLabel('Close').click();
    await expect(checkoutDialog).toBeHidden();
    await expect(page.getByTestId('recharge-active-order')).toContainText('trade-e2e');
    await expect.poll(async () => (
      (await billingInvocations(app)).filter((item) => item.action === 'orderStatus').length
    ), { timeout: 6_000 }).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId('recharge-active-order')).toBeVisible();

    await page.getByRole('button', { name: 'View order' }).click();
    await expect(checkoutDialog).toBeVisible();
    await expect(checkoutDialog.getByText('1,000 shrimp', { exact: true })).toBeVisible();
    await expect(checkoutDialog.getByText('Waiting time', { exact: true })).toBeVisible();
    await expect(checkoutDialog.getByText('Last checked', { exact: true })).toBeVisible();
    const statusChecksBeforeManualRefresh = (await billingInvocations(app))
      .filter((item) => item.action === 'orderStatus').length;
    await checkoutDialog.getByRole('button', { name: 'Check status' }).click();
    await expect.poll(async () => (
      (await billingInvocations(app)).filter((item) => item.action === 'orderStatus').length
    )).toBeGreaterThan(statusChecksBeforeManualRefresh);
    const statusChecksBeforePayment = (await billingInvocations(app))
      .filter((item) => item.action === 'orderStatus').length;
    await setBillingOrderStatus(app, 'success');
    await expect.poll(async () => (
      (await billingInvocations(app)).filter((item) => item.action === 'orderStatus').length
    )).toBeGreaterThan(statusChecksBeforePayment);
    await expect(checkoutDialog).toBeHidden();
    await expect(page.getByText(
      'Payment complete. Your shrimp balance is updated',
      { exact: true },
    )).toBeVisible();
    await expect(page.getByTestId('recharge-active-order')).toBeHidden();

    await page.getByRole('button', { name: 'Order history' }).click();
    const historyDialog = page.getByRole('dialog').filter({ hasText: 'Order history' });
    await expect(historyDialog.getByText('Order history', { exact: true })).toBeVisible();
    await expect(historyDialog.getByText('history-1', { exact: true })).toBeVisible();
    await expect(historyDialog.getByText('CN¥5.00', { exact: true })).toBeVisible();
    await expect(historyDialog.getByText('Alipay', { exact: true })).toBeVisible();
    await expect(historyDialog.getByText(/^Completed /)).toBeVisible();
    await expect(historyDialog.getByText('Total: 1', { exact: true })).toBeVisible();
    await expect(historyDialog.getByRole('button', { name: 'Refresh order history' })).toBeVisible();

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

test('pauses automatic order polling when managed authentication expires', async ({ launchElectronApp }) => {
  const app = await launchElectronApp({ skipSetup: true });

  try {
    await installBillingMock(app);
    const page = await getStableWindow(app);
    await page.reload();

    await page.getByTestId('sidebar-nav-recharge').click();
    await expect(page.getByTestId('recharge-page')).toBeVisible();
    await expect(page.getByText('1,200', { exact: true })).toBeVisible();
    await setBillingOrderStatus(app, 'auth_expired');

    await page.getByLabel('Amount').fill('5');
    await page.getByRole('button', { name: 'Generate payment code' }).click();
    const checkoutDialog = page.getByRole('dialog').filter({ hasText: 'Order payment' });
    await expect(checkoutDialog).toBeVisible();
    await expect.poll(async () => (
      (await billingInvocations(app)).filter((item) => item.action === 'orderStatus').length
    ), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    await expect(checkoutDialog.getByText(
      'Your session has expired. Sign in to UClaw again',
      { exact: true },
    )).toBeVisible();

    const statusChecksAfterAuthFailure = (await billingInvocations(app))
      .filter((item) => item.action === 'orderStatus').length;
    await page.waitForTimeout(UCLAW_BILLING_ORDER_STATUS_POLL_INTERVAL_MS + 500);
    expect((await billingInvocations(app)).filter((item) => item.action === 'orderStatus'))
      .toHaveLength(statusChecksAfterAuthFailure);
    await expect(page.getByTestId('recharge-active-order')).toContainText('trade-e2e');
  } finally {
    await closeElectronApp(app);
  }
});

test('does not start order polling after leaving during order creation', async ({ launchElectronApp }) => {
  const app = await launchElectronApp({ skipSetup: true });

  try {
    await installBillingMock(app);
    const page = await getStableWindow(app);
    await page.reload();

    await page.getByTestId('sidebar-nav-recharge').click();
    await expect(page.getByTestId('recharge-page')).toBeVisible();
    await expect(page.getByText('1,200', { exact: true })).toBeVisible();
    await setBillingCreateOrderDelay(app, 1_000);

    await page.getByLabel('Amount').fill('5');
    await page.getByRole('button', { name: 'Generate payment code' }).click();
    await expect.poll(async () => (
      (await billingInvocations(app)).filter((item) => item.action === 'createOrder').length
    )).toBe(1);
    await page.getByTestId('sidebar-nav-settings').click();
    await expect(page.getByTestId('recharge-page')).toBeHidden();

    await page.waitForTimeout(1_000 + UCLAW_BILLING_ORDER_STATUS_POLL_INTERVAL_MS + 500);
    expect((await billingInvocations(app)).filter((item) => item.action === 'orderStatus'))
      .toHaveLength(0);
  } finally {
    await closeElectronApp(app);
  }
});

test('keeps the newest history page when an older request finishes later', async ({ launchElectronApp }) => {
  const app = await launchElectronApp({ skipSetup: true });

  try {
    await installBillingMock(app);
    const page = await getStableWindow(app);
    await page.reload();

    await page.getByTestId('sidebar-nav-recharge').click();
    await expect(page.getByTestId('recharge-page')).toBeVisible();
    await expect(page.getByText('1,200', { exact: true })).toBeVisible();
    await setBillingHistoryResponses(app, [
      { delayMs: 0, page: 1, total: 40, tradeNo: 'history-initial' },
      { delayMs: 2_000, page: 2, total: 40, tradeNo: 'history-stale' },
      { delayMs: 0, page: 1, total: 40, tradeNo: 'history-fresh' },
    ]);

    await page.getByRole('button', { name: 'Order history' }).click();
    const historyDialog = page.getByRole('dialog').filter({ hasText: 'Order history' });
    await expect(historyDialog.getByText('history-initial', { exact: true })).toBeVisible();
    await historyDialog.getByRole('button', { name: 'Next' }).click();
    await expect.poll(async () => (
      (await billingInvocations(app)).filter((item) => item.action === 'history').length
    )).toBe(2);
    await historyDialog.getByLabel('Close').click();
    await expect(historyDialog).toBeHidden();

    await page.getByRole('button', { name: 'Order history' }).click();
    await expect(historyDialog.getByText('history-fresh', { exact: true })).toBeVisible();
    await page.waitForTimeout(2_500);
    await expect(historyDialog.getByText('history-fresh', { exact: true })).toBeVisible();
    await expect(historyDialog.getByText('history-stale', { exact: true })).toHaveCount(0);
  } finally {
    await closeElectronApp(app);
  }
});
