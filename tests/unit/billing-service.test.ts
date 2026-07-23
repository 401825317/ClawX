// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UCLAW_BILLING_ROUTES } from '@shared/junfeiai-endpoints';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  toManagedAuthError: vi.fn((error: unknown) => {
    const record = error as { code?: string; message?: string };
    return {
      code: record?.code ?? 'unknown',
      message: record?.message ?? 'UClaw request failed',
    };
  }),
}));

vi.mock('@electron/services/managed-auth-service', () => ({
  requestManagedAuthenticatedJson: (...args: unknown[]) => mocks.request(...args),
  toManagedAuthError: (error: unknown) => mocks.toManagedAuthError(error),
}));

import {
  BillingServiceError,
  createBillingOrder,
  getBillingOrderHistory,
  getBillingOrderStatus,
  getBillingOverview,
  toBillingError,
} from '@electron/services/billing-service';

const overviewPayload = {
  user: { shrimp_quota: 88 },
  quotaPerUnit: 1000,
  topupInfo: {
    payg_current_quota: 12345,
    payg_credit_usd_per_cny: 0.2,
    enable_online_topup: true,
    pay_methods: JSON.stringify([
      { type: 'alipay', name: 'Alipay' },
      { type: 'stripe', name: 'Stripe' },
    ]),
    payg_products: [
      {
        id: 7,
        name: 'Standard',
        description: 'Balance recharge',
        enabled: true,
        sort_order: 1,
        stock: 10,
        allowed_group_ids: [1, 2],
      },
    ],
  },
};

describe('billing service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes overview without exposing credential-bearing fields', async () => {
    mocks.request.mockResolvedValueOnce({
      ...overviewPayload,
      access_token: 'access-secret',
    });

    const result = await getBillingOverview();

    expect(mocks.request).toHaveBeenCalledWith(UCLAW_BILLING_ROUTES.overview, expect.any(Object));
    expect(result).toEqual({
      balance: 12345,
      quotaPerUnit: 1000,
      creditUsdPerCny: 0.2,
      onlineTopupEnabled: true,
      products: [{
        id: 7,
        name: 'Standard',
        description: 'Balance recharge',
        enabled: true,
        sortOrder: 1,
        stock: 10,
        allowedGroupIds: [1, 2],
      }],
      paymentMethods: [{ type: 'alipay', name: 'Alipay' }],
    });
    expect(JSON.stringify(result)).not.toContain('access-secret');
  });

  it('creates a normalized order after validating server-owned payment configuration', async () => {
    mocks.request
      .mockResolvedValueOnce(overviewPayload)
      .mockResolvedValueOnce({
        out_trade_no: 'trade-1',
        status: 'PENDING',
        pay_url: 'https://pay.example.com/checkout',
        qr_code: 'https://pay.example.com/qr',
        credit_quota: 600,
        payment_type: 'alipay',
      });

    const result = await createBillingOrder({
      amountFen: 300,
      paymentMethod: 'alipay',
      productId: 7,
    });

    expect(result).toEqual({
      tradeNo: 'trade-1',
      status: 'pending',
      amountYuan: 3,
      creditQuota: 600,
      paymentMethod: 'alipay',
      checkoutUrl: 'https://pay.example.com/checkout',
      qrCode: 'https://pay.example.com/qr',
      qrImageUrl: undefined,
    });
    expect(mocks.request).toHaveBeenNthCalledWith(2, UCLAW_BILLING_ROUTES.orders, expect.objectContaining({
      method: 'POST',
      body: {
        amount: 3,
        payment_type: 'alipay',
        order_type: 'balance',
        payment_source: 'clawx',
        is_mobile: false,
      },
    }));
  });

  it('drops unsafe payment URLs returned by the backend', async () => {
    mocks.request
      .mockResolvedValueOnce(overviewPayload)
      .mockResolvedValueOnce({
        out_trade_no: 'trade-unsafe',
        status: 'pending',
        pay_url: 'file:///tmp/payment',
        qr_image_url: 'javascript:alert(1)',
      });

    const result = await createBillingOrder({ amountFen: 100, paymentMethod: 'alipay', productId: 7 });

    expect(result.checkoutUrl).toBeUndefined();
    expect(result.qrImageUrl).toBeUndefined();
  });

  it('rejects unavailable products before creating an order', async () => {
    mocks.request.mockResolvedValueOnce(overviewPayload);

    await expect(createBillingOrder({ amountFen: 100, paymentMethod: 'alipay', productId: 999 }))
      .rejects.toEqual(expect.objectContaining({ code: 'payment_unavailable' }));
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it('normalizes paginated history and terminal status values', async () => {
    mocks.request.mockResolvedValueOnce({
      page: 2,
      page_size: 20,
      total: 21,
      items: [
        {
          trade_no: 'trade-history',
          money: '5.50',
          credit_quota: 1100,
          payment_method: 'alipay',
          status: 'COMPLETED',
          create_time: 1_700_000_000,
        },
      ],
    });

    const result = await getBillingOrderHistory({ page: 2, pageSize: 20 });

    expect(result.items[0]).toEqual(expect.objectContaining({
      tradeNo: 'trade-history',
      amountYuan: 5.5,
      status: 'success',
      createdAt: 1_700_000_000_000,
    }));
    expect(mocks.request.mock.calls[0][0]).toBe(`${UCLAW_BILLING_ROUTES.history}?p=2&page_size=20`);
  });

  it('verifies order status through the authenticated Main request helper', async () => {
    mocks.request.mockResolvedValueOnce({
      out_trade_no: 'trade-status',
      status: 'EXPIRED',
      credit_quota: 200,
    });

    await expect(getBillingOrderStatus({ tradeNo: 'trade-status' })).resolves.toEqual({
      tradeNo: 'trade-status',
      status: 'expired',
      creditQuota: 200,
    });
    expect(mocks.request).toHaveBeenCalledWith(UCLAW_BILLING_ROUTES.verify, expect.objectContaining({
      method: 'POST',
      body: { out_trade_no: 'trade-status' },
    }));
  });

  it('maps managed authentication and transport failures to stable billing codes', () => {
    expect(toBillingError({ code: 'auth_required', message: 'Sign in' })).toEqual({
      errorCode: 'auth_required',
      message: 'Sign in',
    });
    expect(toBillingError({ code: 'invalid_credentials', message: 'Expired' })).toEqual({
      errorCode: 'auth_expired',
      message: 'Expired',
    });
    expect(toBillingError(new BillingServiceError('payment_unavailable', 'Unavailable'))).toEqual({
      errorCode: 'payment_unavailable',
      message: 'Unavailable',
    });
  });
});
