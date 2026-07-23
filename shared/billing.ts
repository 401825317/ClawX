export type BillingPaymentStatus = 'pending' | 'success' | 'failed' | 'cancelled' | 'expired';

export type BillingPaymentMethod = {
  type: string;
  name: string;
};

export type BillingProduct = {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  sortOrder: number;
  stock: number | null;
  allowedGroupIds: number[];
};

export type BillingOverview = {
  balance: number;
  quotaPerUnit: number;
  creditUsdPerCny: number;
  onlineTopupEnabled: boolean;
  products: BillingProduct[];
  paymentMethods: BillingPaymentMethod[];
};

export type BillingOrder = {
  tradeNo: string;
  amountYuan: number;
  creditQuota: number;
  paymentMethod: string;
  paymentProvider: string;
  status: BillingPaymentStatus;
  createdAt?: number;
  completedAt?: number;
};

export type BillingOrderHistory = {
  page: number;
  pageSize: number;
  total: number;
  items: BillingOrder[];
};

export type BillingCheckout = {
  tradeNo: string;
  status: BillingPaymentStatus;
  amountYuan: number;
  creditQuota: number;
  paymentMethod: string;
  checkoutUrl?: string;
  qrCode?: string;
  qrImageUrl?: string;
};

export type BillingOrderStatus = {
  tradeNo: string;
  status: BillingPaymentStatus;
  creditQuota: number;
};

export type BillingOrderHistoryPayload = {
  page?: number;
  pageSize?: number;
};

export type BillingCreateOrderPayload = {
  amountFen: number;
  paymentMethod: string;
  productId: number;
};

export type BillingOrderStatusPayload = {
  tradeNo: string;
};

export type BillingErrorCode =
  | 'auth_required'
  | 'auth_expired'
  | 'invalid_request'
  | 'payment_unavailable'
  | 'network_error'
  | 'timeout'
  | 'request_failed';

export type BillingResult<T> =
  | { success: true; data: T }
  | { success: false; errorCode: BillingErrorCode; message?: string };
