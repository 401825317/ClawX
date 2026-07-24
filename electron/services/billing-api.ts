import type { HostApiContract } from '../../shared/host-api/contract';
import type {
  BillingCreateOrderPayload,
  BillingOrderHistoryPayload,
  BillingOrderStatusPayload,
  BillingResult,
} from '../../shared/billing';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import type { GatewayManager } from '../gateway/manager';
import {
  createBillingOrder,
  getBillingOrderHistory,
  getBillingOrderStatus,
  getBillingOverview,
  toBillingError,
} from './billing-service';
import {
  getFreshManagedAuthStatus,
  toManagedAuthError,
} from './managed-auth-service';
import { isRecord } from './payload-utils';

type BillingPayload<Action extends keyof HostApiContract['billing']> =
  Parameters<HostApiContract['billing'][Action]>[0];

type BillingApiContext = {
  gatewayManager: GatewayManager;
};

function optionalHistoryPayload(payload: unknown): BillingOrderHistoryPayload {
  if (payload === undefined) return {};
  if (!isRecord(payload)) throw new Error('Invalid billing.history payload');
  const page = payload.page;
  const pageSize = payload.pageSize;
  if (page !== undefined && (!Number.isInteger(page) || Number(page) <= 0)) {
    throw new Error('Invalid billing.history page');
  }
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || Number(pageSize) <= 0)) {
    throw new Error('Invalid billing.history pageSize');
  }
  return { page: page as number | undefined, pageSize: pageSize as number | undefined };
}

function createOrderPayload(payload: unknown): BillingCreateOrderPayload {
  if (!isRecord(payload)) throw new Error('Invalid billing.createOrder payload');
  if (!Number.isInteger(payload.amountFen) || Number(payload.amountFen) <= 0) {
    throw new Error('Invalid billing.createOrder amountFen');
  }
  if (!Number.isInteger(payload.productId) || Number(payload.productId) <= 0) {
    throw new Error('Invalid billing.createOrder productId');
  }
  if (typeof payload.paymentMethod !== 'string' || !payload.paymentMethod.trim()) {
    throw new Error('Invalid billing.createOrder paymentMethod');
  }
  return {
    amountFen: Number(payload.amountFen),
    productId: Number(payload.productId),
    paymentMethod: payload.paymentMethod.trim(),
  };
}

function orderStatusPayload(payload: unknown): BillingOrderStatusPayload {
  if (!isRecord(payload) || typeof payload.tradeNo !== 'string' || !payload.tradeNo.trim()) {
    throw new Error('Invalid billing.orderStatus payload');
  }
  return { tradeNo: payload.tradeNo.trim() };
}

function billingRequestFailed<T>(): BillingResult<T> {
  return {
    success: false,
    errorCode: 'request_failed',
    message: 'UClaw billing request failed',
  };
}

async function callSafely<T>(
  task: () => Promise<T>,
  gatewayManager: GatewayManager,
): Promise<BillingResult<T>> {
  try {
    return { success: true, data: await task() };
  } catch (error) {
    const managedError = toManagedAuthError(error);
    if (managedError.httpStatus === 401) {
      try {
        // A Billing edge response is not authoritative for the runtime session.
        // Verify once without replaying the Billing request (createOrder included).
        const status = await getFreshManagedAuthStatus(gatewayManager);
        if (status.authRejected === true) {
          return {
            success: false,
            errorCode: 'auth_expired',
            message: 'UClaw authentication was rejected',
          };
        }
      } catch {
        return billingRequestFailed();
      }
      return billingRequestFailed();
    }
    if (managedError.httpStatus === 403) return billingRequestFailed();
    const failure = toBillingError(error);
    return { success: false, ...failure };
  }
}

/** Create the typed Billing Host API while managed auth retains credential ownership. */
export function createBillingApi(
  { gatewayManager }: BillingApiContext,
): CompleteHostServiceRegistry['billing'] {
  return {
    overview: () => callSafely(() => getBillingOverview(), gatewayManager),
    history: (payload: BillingPayload<'history'>) => {
      const body = optionalHistoryPayload(payload);
      return callSafely(() => getBillingOrderHistory(body), gatewayManager);
    },
    createOrder: (payload: BillingPayload<'createOrder'>) => {
      const body = createOrderPayload(payload);
      return callSafely(() => createBillingOrder(body), gatewayManager);
    },
    orderStatus: (payload: BillingPayload<'orderStatus'>) => {
      const body = orderStatusPayload(payload);
      return callSafely(() => getBillingOrderStatus(body), gatewayManager);
    },
  };
}
