import type {
  BillingCheckout,
  BillingCreateOrderPayload,
  BillingErrorCode,
  BillingOrder,
  BillingOrderHistory,
  BillingOrderHistoryPayload,
  BillingOrderStatus,
  BillingOrderStatusPayload,
  BillingOverview,
  BillingPaymentMethod,
  BillingPaymentStatus,
  BillingProduct,
} from '../../shared/billing';
import {
  UCLAW_BILLING_HISTORY_PAGE_SIZE,
  UCLAW_BILLING_REQUEST_TIMEOUT_MS,
  UCLAW_BILLING_ROUTES,
} from '../../shared/junfeiai-endpoints';
import {
  requestManagedAuthenticatedJson,
  toManagedAuthError,
} from './managed-auth-service';

type JsonRecord = Record<string, unknown>;

export class BillingServiceError extends Error {
  constructor(
    public readonly code: BillingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BillingServiceError';
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = numberValue(value, fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function enabledValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

function normalizePaymentStatus(value: unknown): BillingPaymentStatus {
  const status = stringValue(value).toUpperCase();
  if (status === 'SUCCESS' || status === 'COMPLETED') return 'success';
  if (status === 'CANCELLED' || status === 'CANCELED') return 'cancelled';
  if (status === 'EXPIRED') return 'expired';
  if (['FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REFUND_FAILED'].includes(status)) return 'failed';
  return 'pending';
}

function normalizeTimestamp(value: unknown): number | undefined {
  const timestamp = numberValue(value);
  if (timestamp <= 0) return undefined;
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function safeHttpUrl(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizeProducts(value: unknown): BillingProduct[] {
  const seen = new Set<number>();
  return parseArray(value)
    .map(asRecord)
    .flatMap((product) => {
      const id = positiveInteger(product.id, 0);
      const name = stringValue(product.name);
      const allowedGroupIds = Array.isArray(product.allowed_group_ids)
        ? [...new Set(product.allowed_group_ids
          .map((groupId) => positiveInteger(groupId, 0))
          .filter((groupId) => groupId > 0))]
        : [];
      if (!id || !name || seen.has(id) || allowedGroupIds.length === 0) return [];
      seen.add(id);
      const stockValue = product.stock === null || product.stock === undefined || product.stock === ''
        ? null
        : Math.max(0, Math.floor(numberValue(product.stock)));
      return [{
        id,
        name,
        description: stringValue(product.description),
        enabled: product.enabled !== false,
        sortOrder: Math.max(0, Math.floor(numberValue(product.sort_order))),
        stock: stockValue,
        allowedGroupIds,
      }];
    })
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id);
}

function normalizePaymentMethods(value: unknown): BillingPaymentMethod[] {
  const seen = new Set<string>();
  return parseArray(value)
    .map(asRecord)
    .flatMap((method) => {
      const type = stringValue(method.type);
      if (!type || ['stripe', 'custom'].includes(type) || seen.has(type)) return [];
      seen.add(type);
      return [{ type, name: stringValue(method.name) || type }];
    });
}

function normalizeOverview(raw: unknown): BillingOverview {
  const overview = asRecord(raw);
  const user = asRecord(overview.user);
  const topupInfo = asRecord(overview.topupInfo ?? overview.topup_info);
  return {
    balance: numberValue(topupInfo.payg_current_quota ?? user.shrimp_quota),
    quotaPerUnit: numberValue(overview.quotaPerUnit ?? overview.quota_per_unit),
    creditUsdPerCny: numberValue(topupInfo.payg_credit_usd_per_cny),
    onlineTopupEnabled: enabledValue(topupInfo.enable_online_topup),
    products: normalizeProducts(topupInfo.payg_products),
    paymentMethods: normalizePaymentMethods(topupInfo.pay_methods),
  };
}

function tradeNo(order: JsonRecord): string {
  return stringValue(order.out_trade_no ?? order.trade_no ?? order.order_id ?? order.id);
}

function checkoutUrl(order: JsonRecord): string | undefined {
  const direct = safeHttpUrl(order.pay_url ?? order.checkout_url ?? order.pay_page_url);
  if (direct) return direct;
  return safeHttpUrl(asRecord(order.oauth).authorize_url);
}

function normalizeOrder(value: unknown): BillingOrder | null {
  const order = asRecord(value);
  const nextTradeNo = tradeNo(order);
  if (!nextTradeNo) return null;
  return {
    tradeNo: nextTradeNo,
    amountYuan: numberValue(order.money ?? order.amount),
    creditQuota: numberValue(order.credit_quota ?? order.quota),
    paymentMethod: stringValue(order.payment_method ?? order.epay_method ?? order.payment_type),
    paymentProvider: stringValue(order.payment_provider),
    status: normalizePaymentStatus(order.status),
    createdAt: normalizeTimestamp(order.create_time ?? order.created_at),
    completedAt: normalizeTimestamp(order.complete_time ?? order.completed_at),
  };
}

/** Read the signed-in user's normalized balance and payment configuration. */
export async function getBillingOverview(): Promise<BillingOverview> {
  const raw = await requestManagedAuthenticatedJson<unknown>(UCLAW_BILLING_ROUTES.overview, {
    timeoutMs: UCLAW_BILLING_REQUEST_TIMEOUT_MS,
  });
  return normalizeOverview(raw);
}

/** Read one bounded page of normalized recharge orders. */
export async function getBillingOrderHistory(
  payload: BillingOrderHistoryPayload = {},
): Promise<BillingOrderHistory> {
  const page = positiveInteger(payload.page, 1);
  const pageSize = Math.min(100, positiveInteger(payload.pageSize, UCLAW_BILLING_HISTORY_PAGE_SIZE));
  const raw = asRecord(await requestManagedAuthenticatedJson<unknown>(
    `${UCLAW_BILLING_ROUTES.history}?p=${encodeURIComponent(String(page))}&page_size=${encodeURIComponent(String(pageSize))}`,
    { timeoutMs: UCLAW_BILLING_REQUEST_TIMEOUT_MS },
  ));
  const items = parseArray(raw.items)
    .map(normalizeOrder)
    .filter((order): order is BillingOrder => order !== null);
  return {
    page: positiveInteger(raw.page, page),
    pageSize: positiveInteger(raw.page_size ?? raw.pageSize, pageSize),
    total: Math.max(0, Math.floor(numberValue(raw.total, items.length))),
    items,
  };
}

/** Validate the selected backend product and create one balance-recharge order. */
export async function createBillingOrder(payload: BillingCreateOrderPayload): Promise<BillingCheckout> {
  const overview = await getBillingOverview();
  const availableProducts = overview.products.filter(
    (item) => item.enabled && (item.stock === null || item.stock > 0),
  );
  const product = availableProducts.length === 1 ? availableProducts[0] : undefined;
  if (!overview.onlineTopupEnabled || !product || product.id !== payload.productId) {
    throw new BillingServiceError('payment_unavailable', 'Recharge is currently unavailable');
  }
  if (!overview.paymentMethods.some((method) => method.type === payload.paymentMethod)) {
    throw new BillingServiceError('payment_unavailable', 'The selected payment method is unavailable');
  }

  const amountYuan = payload.amountFen / 100;
  const order = asRecord(await requestManagedAuthenticatedJson<unknown>(UCLAW_BILLING_ROUTES.orders, {
    method: 'POST',
    timeoutMs: UCLAW_BILLING_REQUEST_TIMEOUT_MS,
    body: {
      amount: amountYuan,
      payment_type: payload.paymentMethod,
      order_type: 'balance',
      payment_source: 'clawx',
      is_mobile: false,
    },
  }));
  const nextStatus = normalizePaymentStatus(order.status);
  const nextTradeNo = tradeNo(order);
  if (nextStatus !== 'success' && !nextTradeNo) {
    throw new BillingServiceError('request_failed', 'UClaw did not return a recharge order number');
  }
  const estimatedQuota = Math.round(
    amountYuan * overview.creditUsdPerCny * overview.quotaPerUnit,
  );
  return {
    tradeNo: nextTradeNo,
    status: nextStatus,
    amountYuan,
    creditQuota: estimatedQuota > 0 ? estimatedQuota : numberValue(order.credit_quota),
    paymentMethod: stringValue(order.payment_type ?? order.epay_method) || payload.paymentMethod,
    checkoutUrl: checkoutUrl(order),
    qrCode: stringValue(order.qr_code ?? order.qrcode ?? order.qr_code_data) || undefined,
    qrImageUrl: safeHttpUrl(order.qr_image_url ?? order.qr_image ?? order.qrcode_img ?? order.img),
  };
}

/** Verify one order without mutating Provider, OpenClaw, or Gateway state. */
export async function getBillingOrderStatus(
  payload: BillingOrderStatusPayload,
): Promise<BillingOrderStatus> {
  const order = asRecord(await requestManagedAuthenticatedJson<unknown>(UCLAW_BILLING_ROUTES.verify, {
    method: 'POST',
    timeoutMs: UCLAW_BILLING_REQUEST_TIMEOUT_MS,
    body: { out_trade_no: payload.tradeNo },
  }));
  const responseTradeNo = tradeNo(order);
  if (responseTradeNo && responseTradeNo !== payload.tradeNo) {
    throw new BillingServiceError('request_failed', 'UClaw returned a different recharge order number');
  }
  return {
    tradeNo: payload.tradeNo,
    status: normalizePaymentStatus(order.status),
    creditQuota: numberValue(order.credit_quota ?? order.quota ?? order.amount),
  };
}

/** Convert service and Managed Auth failures into stable renderer-safe error codes. */
export function toBillingError(error: unknown): { errorCode: BillingErrorCode; message: string } {
  if (error instanceof BillingServiceError) {
    return { errorCode: error.code, message: error.message };
  }
  const managedError = toManagedAuthError(error);
  if (managedError.code === 'auth_required') {
    return { errorCode: 'auth_required', message: managedError.message };
  }
  if (managedError.code === 'auth_expired' || managedError.code === 'invalid_credentials') {
    return { errorCode: 'auth_expired', message: managedError.message };
  }
  if (managedError.code === 'network_error') {
    return { errorCode: 'network_error', message: managedError.message };
  }
  if (managedError.code === 'timeout') {
    return { errorCode: 'timeout', message: managedError.message };
  }
  return { errorCode: 'request_failed', message: managedError.message };
}
