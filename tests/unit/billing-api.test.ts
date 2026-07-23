// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
  getHistory: vi.fn(),
  getOrderStatus: vi.fn(),
  getOverview: vi.fn(),
  toBillingError: vi.fn((error: unknown) => ({
    errorCode: 'request_failed',
    message: error instanceof Error ? error.message : 'Request failed',
  })),
}));

vi.mock('@electron/services/billing-service', () => ({
  createBillingOrder: (...args: unknown[]) => mocks.createOrder(...args),
  getBillingOrderHistory: (...args: unknown[]) => mocks.getHistory(...args),
  getBillingOrderStatus: (...args: unknown[]) => mocks.getOrderStatus(...args),
  getBillingOverview: (...args: unknown[]) => mocks.getOverview(...args),
  toBillingError: (error: unknown) => mocks.toBillingError(error),
}));

import { createBillingApi } from '@electron/services/billing-api';

describe('billing host API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOverview.mockResolvedValue({ balance: 1 });
    mocks.getHistory.mockResolvedValue({ page: 1, pageSize: 20, total: 0, items: [] });
    mocks.createOrder.mockResolvedValue({ tradeNo: 'trade-1', status: 'pending' });
    mocks.getOrderStatus.mockResolvedValue({ tradeNo: 'trade-1', status: 'success' });
  });

  it('routes and normalizes all typed billing actions', async () => {
    const api = createBillingApi();

    await api.overview();
    await api.history({ page: 2, pageSize: 10 });
    await api.createOrder({ amountFen: 500, paymentMethod: '  alipay  ', productId: 7 });
    await api.orderStatus({ tradeNo: '  trade-1  ' });

    expect(mocks.getOverview).toHaveBeenCalledWith();
    expect(mocks.getHistory).toHaveBeenCalledWith({ page: 2, pageSize: 10 });
    expect(mocks.createOrder).toHaveBeenCalledWith({ amountFen: 500, paymentMethod: 'alipay', productId: 7 });
    expect(mocks.getOrderStatus).toHaveBeenCalledWith({ tradeNo: 'trade-1' });
  });

  it('returns stable renderer-safe service failures', async () => {
    mocks.getOverview.mockRejectedValueOnce(new Error('backend unavailable'));
    const api = createBillingApi();

    await expect(api.overview()).resolves.toEqual({
      success: false,
      errorCode: 'request_failed',
      message: 'backend unavailable',
    });
  });

  it.each([
    ['history page', () => createBillingApi().history({ page: 0 })],
    ['order amount', () => createBillingApi().createOrder({ amountFen: 0, paymentMethod: 'alipay', productId: 7 })],
    ['product id', () => createBillingApi().createOrder({ amountFen: 100, paymentMethod: 'alipay', productId: 0 })],
    ['payment method', () => createBillingApi().createOrder({ amountFen: 100, paymentMethod: '', productId: 7 })],
    ['trade number', () => createBillingApi().orderStatus({ tradeNo: '' })],
  ])('rejects invalid %s payloads before calling the service', async (_name, action) => {
    await expect(async () => action()).rejects.toThrow(/Invalid billing/);
    expect(mocks.getHistory).not.toHaveBeenCalled();
    expect(mocks.createOrder).not.toHaveBeenCalled();
    expect(mocks.getOrderStatus).not.toHaveBeenCalled();
  });
});
