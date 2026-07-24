// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayManager } from '@electron/gateway/manager';

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
  getHistory: vi.fn(),
  getOrderStatus: vi.fn(),
  getOverview: vi.fn(),
  getFreshManagedAuthStatus: vi.fn(),
  toManagedAuthError: vi.fn(),
  toBillingError: vi.fn((error: unknown) => ({
    errorCode: 'request_failed',
    message: error instanceof Error ? error.message : 'Request failed',
  })),
}));

vi.mock('@electron/services/managed-auth-service', () => ({
  getFreshManagedAuthStatus: (...args: unknown[]) => mocks.getFreshManagedAuthStatus(...args),
  toManagedAuthError: (error: unknown) => mocks.toManagedAuthError(error),
}));

vi.mock('@electron/services/billing-service', () => ({
  createBillingOrder: (...args: unknown[]) => mocks.createOrder(...args),
  getBillingOrderHistory: (...args: unknown[]) => mocks.getHistory(...args),
  getBillingOrderStatus: (...args: unknown[]) => mocks.getOrderStatus(...args),
  getBillingOverview: (...args: unknown[]) => mocks.getOverview(...args),
  toBillingError: (error: unknown) => mocks.toBillingError(error),
}));

import { createBillingApi } from '@electron/services/billing-api';

const gatewayManager = {} as GatewayManager;

function createApi() {
  return createBillingApi({ gatewayManager });
}

function managedHttpError(httpStatus: number, code = 'auth_expired'): Error {
  return Object.assign(new Error(`HTTP ${httpStatus}`), { httpStatus, authCode: code });
}

describe('billing host API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOverview.mockResolvedValue({ balance: 1 });
    mocks.getHistory.mockResolvedValue({ page: 1, pageSize: 20, total: 0, items: [] });
    mocks.createOrder.mockResolvedValue({ tradeNo: 'trade-1', status: 'pending' });
    mocks.getOrderStatus.mockResolvedValue({ tradeNo: 'trade-1', status: 'success' });
    mocks.getFreshManagedAuthStatus.mockResolvedValue({ authRejected: false, authValid: true });
    mocks.toManagedAuthError.mockImplementation((error: Error & { authCode?: string; httpStatus?: number }) => ({
      code: error.authCode ?? 'unknown',
      message: error.message,
      httpStatus: error.httpStatus,
    }));
  });

  it('routes and normalizes all typed billing actions', async () => {
    const api = createApi();

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
    const api = createApi();

    await expect(api.overview()).resolves.toEqual({
      success: false,
      errorCode: 'request_failed',
      message: 'backend unavailable',
    });
  });

  it('expires the session only after an authoritative verification rejects Billing 401', async () => {
    mocks.getOverview.mockRejectedValueOnce(managedHttpError(401));
    mocks.getFreshManagedAuthStatus.mockResolvedValueOnce({ authRejected: true, authValid: false });

    await expect(createApi().overview()).resolves.toEqual({
      success: false,
      errorCode: 'auth_expired',
      message: 'UClaw authentication was rejected',
    });
    expect(mocks.getFreshManagedAuthStatus).toHaveBeenCalledWith(gatewayManager);
    expect(mocks.getOverview).toHaveBeenCalledTimes(1);
  });

  it('keeps the session when authoritative verification accepts Billing 401', async () => {
    mocks.createOrder.mockRejectedValueOnce(managedHttpError(401));

    await expect(createApi().createOrder({
      amountFen: 500,
      paymentMethod: 'alipay',
      productId: 7,
    })).resolves.toEqual({
      success: false,
      errorCode: 'request_failed',
      message: 'UClaw billing request failed',
    });
    expect(mocks.getFreshManagedAuthStatus).toHaveBeenCalledWith(gatewayManager);
    expect(mocks.createOrder).toHaveBeenCalledTimes(1);
  });

  it('keeps the session when Billing 401 verification is unavailable', async () => {
    mocks.getOverview.mockRejectedValueOnce(managedHttpError(401));
    mocks.getFreshManagedAuthStatus.mockRejectedValueOnce(new Error('verify unavailable'));

    await expect(createApi().overview()).resolves.toEqual({
      success: false,
      errorCode: 'request_failed',
      message: 'UClaw billing request failed',
    });
    expect(mocks.getOverview).toHaveBeenCalledTimes(1);
  });

  it('does not verify or clear the session for Billing 403', async () => {
    mocks.getOverview.mockRejectedValueOnce(managedHttpError(403, 'auth_invalid'));

    await expect(createApi().overview()).resolves.toEqual({
      success: false,
      errorCode: 'request_failed',
      message: 'UClaw billing request failed',
    });
    expect(mocks.getFreshManagedAuthStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['history page', () => createApi().history({ page: 0 })],
    ['order amount', () => createApi().createOrder({ amountFen: 0, paymentMethod: 'alipay', productId: 7 })],
    ['product id', () => createApi().createOrder({ amountFen: 100, paymentMethod: 'alipay', productId: 0 })],
    ['payment method', () => createApi().createOrder({ amountFen: 100, paymentMethod: '', productId: 7 })],
    ['trade number', () => createApi().orderStatus({ tradeNo: '' })],
  ])('rejects invalid %s payloads before calling the service', async (_name, action) => {
    await expect(async () => action()).rejects.toThrow(/Invalid billing/);
    expect(mocks.getHistory).not.toHaveBeenCalled();
    expect(mocks.createOrder).not.toHaveBeenCalled();
    expect(mocks.getOrderStatus).not.toHaveBeenCalled();
  });
});
