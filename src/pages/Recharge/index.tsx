import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ExternalLink, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { hostApiFetch } from '@/lib/host-api';
import { cn } from '@/lib/utils';
import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';

const ORDER_POLL_INTERVAL_MS = 2_000;

type PaygProduct = {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  sortOrder: number;
  stock: number | null;
  allowedGroupIds: number[];
};

type EpayMethod = {
  type: string;
  name: string;
};

type TopupInfo = Record<string, unknown> & {
  payg_current_quota?: unknown;
  payg_credit_usd_per_cny?: unknown;
  pay_methods?: unknown;
  enable_online_topup?: unknown;
  payg_products?: unknown;
};

type TopupOverview = {
  user?: Record<string, unknown>;
  quotaPerUnit?: number;
  topupInfo?: TopupInfo;
};

type OrderResult = Record<string, unknown> & {
  status?: string;
  trade_no?: string;
  credit_quota?: unknown;
};

type Checkout = {
  tradeNo: string;
  amountYuan: string;
  method: string;
  productName: string;
  creditQuota: number;
  payPageUrl: string;
  checkoutUrl: string;
  qrCode: string;
  qrDataUrl: string;
  qrSvgMarkup: string;
  qrError: string;
  canOpenInBrowser: boolean;
  createdAt: number;
  lastCheckedAt: number;
  lastStatusError: string;
};

type PayStatus = 'pending' | 'success' | 'failed';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeStockValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const stock = Number(value);
  return Number.isFinite(stock) ? Math.max(0, Math.floor(stock)) : null;
}

function normalizeGroupIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  for (const item of value) {
    const groupId = Number(item);
    if (!Number.isFinite(groupId) || groupId <= 0) continue;
    seen.add(Math.floor(groupId));
  }
  return [...seen].sort((a, b) => a - b);
}

function normalizePaygProducts(value: unknown): PaygProduct[] {
  const seen = new Set<number>();
  return (Array.isArray(value) ? value : [])
    .map((item) => asRecord(item))
    .flatMap((item) => {
      const id = Number(item.id ?? 0);
      const name = String(item.name ?? '').trim();
      const allowedGroupIds = normalizeGroupIds(item.allowed_group_ids);
      if (!Number.isFinite(id) || id <= 0 || seen.has(id) || !name || allowedGroupIds.length === 0) {
        return [];
      }
      seen.add(id);
      return [{
        id,
        name,
        description: String(item.description ?? '').trim(),
        enabled: item.enabled !== false,
        sortOrder: Number.isFinite(Number(item.sort_order)) ? Math.max(0, Math.floor(Number(item.sort_order))) : 0,
        stock: normalizeStockValue(item.stock),
        allowedGroupIds,
      }];
    })
    .sort((left, right) => (left.sortOrder - right.sortOrder) || (left.id - right.id));
}

function normalizeEpayMethods(value: unknown): EpayMethod[] {
  return parseJsonArray(value)
    .map((item) => asRecord(item))
    .map((item) => ({
      type: String(item.type ?? '').trim(),
      name: String(item.name ?? '').trim(),
    }))
    .filter((item) => item.type && item.type !== 'stripe' && item.type !== 'custom');
}

function getDefaultEpayMethod(methods: EpayMethod[]): string {
  return methods.find((item) => item.type === 'alipay')?.type || methods[0]?.type || '';
}

function isEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return Boolean(value);
}

function normalizeAmountInput(value: string): string {
  let normalized = '';
  let seenDot = false;
  for (const char of value) {
    if (char >= '0' && char <= '9') {
      normalized += char;
    } else if (char === '.' && !seenDot) {
      normalized += char;
      seenDot = true;
    }
  }
  if (!seenDot) return normalized;
  const [integerPart = '', decimalPart = ''] = normalized.split('.', 2);
  return `${integerPart}.${decimalPart.slice(0, 2)}`;
}

function parseAmountFen(value: string): number {
  const normalized = normalizeAmountInput(value);
  if (!normalized) return 0;
  const [integerPart = '0', decimalPart = ''] = normalized.split('.', 2);
  const amountFen = Number(integerPart || 0) * 100 + Number((decimalPart + '00').slice(0, 2));
  return Number.isSafeInteger(amountFen) && amountFen > 0 ? amountFen : 0;
}

function formatNumber(value: unknown, maximumFractionDigits = 2): string {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return '0';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits }).format(num);
}

function formatCurrency(value: unknown): string {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return '¥0.00';
  return `¥${new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num)}`;
}

function formatDateTime(value: unknown): string {
  const timestamp = Number(value ?? 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function getQuotaPerYuan(topupInfo: TopupInfo | null, quotaPerUnit: number): number {
  const creditUsdPerCny = Number(topupInfo?.payg_credit_usd_per_cny ?? 0);
  if (!Number.isFinite(creditUsdPerCny) || creditUsdPerCny <= 0) return 0;
  if (!Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) return 0;
  return creditUsdPerCny * quotaPerUnit;
}

function estimateQuota(amountYuan: string, topupInfo: TopupInfo | null, quotaPerUnit: number): number {
  const amountFen = parseAmountFen(amountYuan);
  const quotaPerYuan = getQuotaPerYuan(topupInfo, quotaPerUnit);
  if (amountFen <= 0 || quotaPerYuan <= 0) return 0;
  const estimated = Math.round((amountFen * quotaPerYuan) / 100);
  return Number.isFinite(estimated) && estimated > 0 ? estimated : 0;
}

function getPaymentMethodLabel(method: string): string {
  const normalized = method.toLowerCase();
  if (normalized.includes('ali')) return '支付宝';
  if (normalized.includes('wx') || normalized.includes('wechat')) return '微信';
  return method || '支付应用';
}

function getScanTip(method: string): string {
  const label = getPaymentMethodLabel(method);
  return `请使用${label}扫码完成付款`;
}

function getPaymentStatusLabel(status: PayStatus): string {
  if (status === 'success') return '已支付';
  if (status === 'failed') return '支付失败';
  return '等待支付';
}

function formatDurationLabel(ms: number): string {
  const totalSeconds = Math.max(1, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds > 0 ? `${totalMinutes} 分 ${seconds} 秒` : `${totalMinutes} 分`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
}

function getCheckoutWaitingLabel(checkout: Checkout): string {
  return formatDurationLabel(Date.now() - checkout.createdAt);
}

function getCheckoutGuidance(checkout: Checkout, status: PayStatus): {
  title: string;
  subtitle: string;
  detail: string;
  tone: 'pending' | 'warning' | 'failed';
} {
  if (status === 'failed') {
    return {
      title: '支付未完成',
      subtitle: '这笔订单没有支付成功，你可以取消后重新发起。',
      detail: '',
      tone: 'failed',
    };
  }

  if (checkout.lastStatusError) {
    return {
      title: '等待确认',
      subtitle: '暂时无法确认到账，你可以稍后重试。',
      detail: '',
      tone: 'warning',
    };
  }

  if (Date.now() - checkout.createdAt > 120_000) {
    return {
      title: '等待确认',
      subtitle: '如果你已经付款，可点击检查状态。',
      detail: '',
      tone: 'pending',
    };
  }

  return {
    title: '请扫码付款',
    subtitle: '完成付款后可在这里检查状态。',
    detail: '',
    tone: 'pending',
  };
}

function renderQrSvgMarkup(input: string): string {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(input);
  qr.make();
  const modules = qr.getModuleCount();
  const margin = 1;
  const size = modules + margin * 2;
  const cells: string[] = [];
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (!qr.isDark(row, col)) continue;
      cells.push(`<rect x="${col + margin}" y="${row + margin}" width="1" height="1" />`);
    }
  }
  return [
    `<svg class="shrimp-qr-svg compact" focusable="false" aria-hidden="true" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">`,
    '<rect width="100%" height="100%" fill="#fff" />',
    '<g fill="#0b1120">',
    cells.join(''),
    '</g>',
    '</svg>',
  ].join('');
}

function createCheckout(result: OrderResult, options: {
  method: string;
  amountYuan: number;
  productName: string;
  creditQuota: number;
}): Checkout {
  const checkoutUrl = String(result.checkout_url ?? '').trim();
  const payPageUrl = String(result.pay_page_url ?? result.payurl ?? result.pay_url ?? '').trim();
  const qrCode = String(result.qr_code ?? result.qrcode ?? result.qr_code_data ?? '').trim();
  const qrImageUrl = String(result.qr_image_url ?? result.qr_image ?? result.qrcode_img ?? result.img ?? '').trim();
  const resultCreditQuota = Number(result.credit_quota ?? 0);
  let qrSvgMarkup = '';
  let qrError = '';

  if (qrCode) {
    try {
      qrSvgMarkup = renderQrSvgMarkup(qrCode);
    } catch {
      qrError = '支付二维码生成失败，请联系管理员检查支付配置。';
    }
  } else if (!qrImageUrl) {
    qrError = '后台没有返回支付二维码，无法继续支付，请联系管理员检查支付配置。';
  }

  return {
    tradeNo: String(result.trade_no ?? '').trim(),
    checkoutUrl,
    payPageUrl,
    qrCode,
    qrDataUrl: qrImageUrl,
    qrSvgMarkup,
    qrError,
    canOpenInBrowser: Boolean(payPageUrl || checkoutUrl),
    method: options.method,
    amountYuan: Number.isFinite(options.amountYuan) ? options.amountYuan.toFixed(2) : '',
    creditQuota: Number.isFinite(resultCreditQuota) && resultCreditQuota > 0
      ? Math.round(resultCreditQuota)
      : Math.max(0, Math.round(options.creditQuota)),
    productName: options.productName,
    createdAt: Date.now(),
    lastCheckedAt: 0,
    lastStatusError: '',
  };
}

export function Recharge() {
  const [overview, setOverview] = useState<TopupOverview | null>(null);
  const [products, setProducts] = useState<PaygProduct[]>([]);
  const [epayMethods, setEpayMethods] = useState<EpayMethod[]>([]);
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);
  const [epayMethod, setEpayMethod] = useState('');
  const [amountYuan, setAmountYuan] = useState('');
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checkingPayment, setCheckingPayment] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeType, setNoticeType] = useState<'info' | 'error'>('info');
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [payStatus, setPayStatus] = useState<PayStatus>('pending');
  const pollTimerRef = useRef<number | null>(null);
  const checkoutTradeNoRef = useRef('');
  const checkingPaymentRef = useRef(false);

  useEffect(() => {
    checkoutTradeNoRef.current = checkout?.tradeNo ?? '';
  }, [checkout?.tradeNo]);

  useEffect(() => {
    checkingPaymentRef.current = checkingPayment;
  }, [checkingPayment]);

  const topupInfo = overview?.topupInfo ?? null;
  const quotaPerUnit = Number.isFinite(Number(overview?.quotaPerUnit)) ? Number(overview?.quotaPerUnit) : 0;
  const availableProducts = useMemo(
    () => products.filter((item) => item.enabled !== false && (typeof item.stock !== 'number' || item.stock > 0)),
    [products],
  );
  const selectedProduct = availableProducts.find((item) => item.id === selectedProductId) ?? null;
  const onlineTopupEnabled = isEnabled(topupInfo?.enable_online_topup) && epayMethods.length > 0;
  const hasActiveCheckout = Boolean(checkout?.tradeNo);
  const hasPendingCheckout = hasActiveCheckout && payStatus === 'pending';
  const hasFailedCheckout = hasActiveCheckout && payStatus === 'failed';
  const formStatusHint = selectedProduct && onlineTopupEnabled
    ? hasFailedCheckout
      ? '请先重新发起订单'
      : hasPendingCheckout
        ? ''
        : '输入金额后即可支付'
    : '当前充值暂不可用';
  const formDisabled = submitting || loading || !selectedProduct || !onlineTopupEnabled || hasActiveCheckout;
  const amountFen = parseAmountFen(amountYuan);
  const quotaValue = topupInfo?.payg_current_quota ?? overview?.user?.shrimp_quota ?? 0;
  const quotaPerYuan = getQuotaPerYuan(topupInfo, quotaPerUnit);
  const estimatedQuota = estimateQuota(amountYuan, topupInfo, quotaPerUnit);
  const hasQrVisual = Boolean(checkout?.qrSvgMarkup || checkout?.qrDataUrl);
  const showOpenPayLink = Boolean(checkout?.canOpenInBrowser && checkout.qrError);
  const checkoutGuidance = checkout ? getCheckoutGuidance(checkout, payStatus) : null;

  const clearPolling = useCallback(() => {
    if (pollTimerRef.current) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await hostApiFetch<TopupOverview>('/api/junfeiai/topup/overview');
      const nextTopupInfo = next.topupInfo ?? {};
      const nextMethods = normalizeEpayMethods(nextTopupInfo.pay_methods);
      const nextProducts = normalizePaygProducts(nextTopupInfo.payg_products)
        .filter((item) => item.enabled !== false);
      const nextAvailableProducts = nextProducts
        .filter((item) => typeof item.stock !== 'number' || item.stock > 0);
      const nextEpayEnabled = isEnabled(nextTopupInfo.enable_online_topup) && nextMethods.length > 0;
      const nextProductId = nextAvailableProducts.length === 1 ? nextAvailableProducts[0].id : null;
      const configError = !nextEpayEnabled
        ? '当前在线充值暂不可用，请联系管理员检查支付配置。'
        : nextAvailableProducts.length === 0
          ? '当前暂时无法充值，请稍后再试。'
          : nextAvailableProducts.length > 1
            ? '当前充值配置异常，请联系管理员。'
            : '';

      setOverview(next);
      setProducts(nextProducts);
      setEpayMethods(nextMethods);
      setSelectedProductId(nextProductId);
      setEpayMethod((current) => nextMethods.some((item) => item.type === current)
        ? current
        : getDefaultEpayMethod(nextMethods));
      setError(configError);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  const syncOrderStatus = useCallback(async (
    tradeNo: string,
    options: { manual?: boolean; pendingNotice?: boolean } = {},
  ) => {
    const currentTradeNo = String(tradeNo || '').trim();
    if (!currentTradeNo) return 'unknown';

    const result = await hostApiFetch<Record<string, unknown>>(
      `/api/junfeiai/topup/order/status?tradeNo=${encodeURIComponent(currentTradeNo)}&sync=${options.manual ? '1' : '0'}`,
    );
    const status = String(result.status ?? '').trim();
    const resultCreditQuota = Number(result.credit_quota ?? 0);

    if (checkoutTradeNoRef.current !== currentTradeNo) {
      return 'stale';
    }

    if (status === 'success') {
      clearPolling();
      await loadOverview();
      setCheckout(null);
      setCheckoutOpen(false);
      setCheckingPayment(false);
      setPayStatus('success');
      setNotice('');
      setNoticeType('info');
      return 'success';
    }

    if (status === 'failed') {
      clearPolling();
      setCheckout((current) => current && current.tradeNo === currentTradeNo ? {
        ...current,
        creditQuota: Number.isFinite(resultCreditQuota) && resultCreditQuota > 0
          ? Math.round(resultCreditQuota)
          : current.creditQuota,
        lastCheckedAt: Date.now(),
        lastStatusError: '',
      } : current);
      setCheckoutOpen(true);
      setCheckingPayment(false);
      setPayStatus('failed');
      setNotice('支付失败，请重新发起订单。');
      setNoticeType('error');
      return 'failed';
    }

    const shouldRefreshPendingState = options.manual || options.pendingNotice || checkingPaymentRef.current;
    if (shouldRefreshPendingState) {
      setCheckout((current) => current && current.tradeNo === currentTradeNo ? {
        ...current,
        creditQuota: Number.isFinite(resultCreditQuota) && resultCreditQuota > 0
          ? Math.round(resultCreditQuota)
          : current.creditQuota,
        lastCheckedAt: Date.now(),
        lastStatusError: '',
      } : current);
      setCheckingPayment(false);
      setPayStatus('pending');
      if (options.pendingNotice) {
        setNotice('暂未确认支付结果，请稍等片刻后再试。');
        setNoticeType('info');
      }
    }

    return 'pending';
  }, [clearPolling, loadOverview]);

  const startPolling = useCallback((tradeNo: string) => {
    clearPolling();
    const poll = async () => {
      if (checkoutTradeNoRef.current !== tradeNo) return;
      if (checkingPaymentRef.current) {
        pollTimerRef.current = window.setTimeout(poll, 1_000);
        return;
      }

      try {
        const status = await syncOrderStatus(tradeNo);
        if (status === 'success' || status === 'failed' || status === 'stale') return;
      } catch {
        if (checkoutTradeNoRef.current !== tradeNo) return;
        setCheckout((current) => current && current.tradeNo === tradeNo ? {
          ...current,
          lastCheckedAt: Date.now(),
          lastStatusError: '暂时无法连接到账确认服务，系统会自动重试。',
        } : current);
      }

      if (checkoutTradeNoRef.current !== tradeNo) return;
      pollTimerRef.current = window.setTimeout(poll, ORDER_POLL_INTERVAL_MS);
    };
    pollTimerRef.current = window.setTimeout(poll, ORDER_POLL_INTERVAL_MS);
  }, [clearPolling, syncOrderStatus]);

  useEffect(() => {
    void loadOverview();
    return () => clearPolling();
  }, [clearPolling, loadOverview]);

  const handleSubmit = async () => {
    if (submitting || checkout?.tradeNo) return;
    if (!selectedProduct) {
      setError(error || '当前充值配置不可用，请联系管理员。');
      return;
    }
    if (typeof selectedProduct.stock === 'number' && selectedProduct.stock <= 0) {
      setError('当前充值配置不可用，请联系管理员。');
      return;
    }

    const amount = Number(amountYuan);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('请输入充值金额');
      return;
    }

    if (!onlineTopupEnabled || !epayMethod) {
      setError('当前在线充值暂不可用，请联系管理员检查支付配置。');
      return;
    }

    setSubmitting(true);
    setError('');
    setNotice('');
    setCheckout(null);
    setCheckoutOpen(false);
    setCheckingPayment(false);
    setPayStatus('pending');
    clearPolling();

    try {
      const result = await hostApiFetch<OrderResult>('/api/junfeiai/topup/order', {
        method: 'POST',
        body: JSON.stringify({
          money: amount.toFixed(2),
          payMethod: 'epay',
          epayMethod,
          productId: selectedProduct.id,
        }),
      });

      if (String(result.status ?? '').trim() === 'success') {
        await loadOverview();
        setNotice('');
        setNoticeType('info');
        return;
      }

      const nextCheckout = createCheckout(result, {
        method: epayMethod,
        amountYuan: amount,
        productName: selectedProduct.name,
        creditQuota: estimatedQuota,
      });
      if (!nextCheckout.tradeNo) {
        throw new Error('后台没有返回订单号，无法继续确认支付状态。');
      }

      setCheckout(nextCheckout);
      checkoutTradeNoRef.current = nextCheckout.tradeNo;
      setCheckoutOpen(true);
      setPayStatus('pending');
      startPolling(nextCheckout.tradeNo);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCheckNow = async () => {
    if (!checkout?.tradeNo || checkingPayment) return;
    const tradeNo = checkout.tradeNo;
    setCheckingPayment(true);
    setError('');
    setNotice('');
    setCheckout((current) => current && current.tradeNo === tradeNo ? {
      ...current,
      lastStatusError: '',
    } : current);
    try {
      await syncOrderStatus(tradeNo, { manual: true, pendingNotice: true });
    } catch (checkError) {
      if (checkoutTradeNoRef.current !== tradeNo) return;
      setCheckingPayment(false);
      setCheckout((current) => current && current.tradeNo === tradeNo ? {
        ...current,
        lastCheckedAt: Date.now(),
        lastStatusError: checkError instanceof Error ? checkError.message : String(checkError),
      } : current);
    }
  };

  const handleOpenPayLink = async () => {
    if (!checkout?.canOpenInBrowser) {
      setError('后台没有返回有效的支付地址，无法继续支付，请联系管理员检查支付配置。');
      return;
    }
    try {
      await window.electron.openExternal(checkout.payPageUrl || checkout.checkoutUrl);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    }
  };

  const resetCheckout = () => {
    clearPolling();
    checkoutTradeNoRef.current = '';
    setCheckout(null);
    setCheckoutOpen(false);
    setCheckingPayment(false);
    setPayStatus('pending');
    setNotice('');
  };

  return (
    <div data-testid="recharge-page" className="flex h-[calc(100vh-2.5rem)] flex-col overflow-hidden -m-6 dark:bg-background">
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-8 py-10">
        <div className="mb-8 shrink-0">
          <h1 className="text-4xl font-serif font-normal tracking-tight text-foreground">虾粮商城</h1>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pb-10 pr-2 -mr-2">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="rounded-lg border border-black/10 px-4 py-3 dark:border-white/10">
              <span className="mr-3 text-xs font-medium text-muted-foreground">当前额度</span>
              <strong className="text-xl font-semibold tabular-nums text-foreground">{formatNumber(quotaValue)}</strong>
            </div>
            <Button variant="outline" onClick={() => void loadOverview()} disabled={loading} className="h-9 rounded-lg">
              <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
              {loading ? '刷新中...' : '刷新'}
            </Button>
          </div>

          {error && (
            <div className="mb-5 flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {notice && !checkout?.tradeNo && (
            <div className={cn(
              'mb-5 rounded-lg border p-4 text-sm',
              noticeType === 'error'
                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
            )}
            >
              {notice}
            </div>
          )}

          {checkout?.tradeNo && (
            <div className={cn(
              'mb-5 rounded-lg border p-4',
              payStatus === 'failed'
                ? 'border-destructive/40 bg-destructive/5'
                : 'border-black/10 dark:border-white/10',
            )}
            >
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">支付订单</p>
                  <strong className="mt-1 block text-sm text-foreground">{getPaymentStatusLabel(payStatus)}</strong>
                  <div className="mt-1 text-xs text-muted-foreground">
                    订单号：<code className="rounded bg-black/5 px-1.5 py-0.5 dark:bg-white/10">{checkout.tradeNo}</code>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {payStatus === 'pending' && (
                    <Button variant="outline" size="sm" onClick={() => void handleCheckNow()} disabled={checkingPayment}>
                      {checkingPayment ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                      立即检查支付状态
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setCheckoutOpen(true)}>
                    查看订单
                  </Button>
                  {showOpenPayLink && (
                    <Button variant="outline" size="sm" onClick={() => void handleOpenPayLink()}>
                      <ExternalLink className="mr-2 h-3.5 w-3.5" />
                      浏览器打开
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={resetCheckout}>
                    <RotateCcw className="mr-2 h-3.5 w-3.5" />
                    取消订单
                  </Button>
                </div>
              </div>
            </div>
          )}

          <section className="rounded-lg border border-black/10 p-5 dark:border-white/10">
            <div className="mb-5 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-foreground">充值额度</h2>
              {formStatusHint && <span className="text-sm text-muted-foreground">{formStatusHint}</span>}
            </div>

            <div className="space-y-5">
              <div>
                <label htmlFor="recharge-amount" className="mb-2 block text-sm font-medium text-foreground">
                  充值金额
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">¥</span>
                  <Input
                    id="recharge-amount"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    value={amountYuan}
                    disabled={formDisabled}
                    onChange={(event) => {
                      setAmountYuan(normalizeAmountInput(event.target.value));
                      if (selectedProduct && onlineTopupEnabled) {
                        setError('');
                        setNotice('');
                      }
                    }}
                    placeholder="输入金额，例如 10.00"
                    className="pl-8"
                  />
                </div>
                {quotaPerYuan > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {amountFen > 0 ? (
                      <>
                        按当前汇率，预计到账 <strong className="text-foreground">{formatNumber(estimatedQuota)}</strong> 虾粮
                      </>
                    ) : (
                      <>
                        按当前汇率，<strong className="text-foreground">¥1 ≈ {formatNumber(quotaPerYuan)}</strong> 虾粮
                      </>
                    )}
                  </p>
                )}
              </div>

              <div>
                <p className="mb-2 text-sm font-medium text-foreground">支付渠道</p>
                <div className="flex flex-wrap gap-2">
                  {loading && !loaded ? (
                    <>
                      <div className="h-10 w-24 animate-pulse rounded-lg bg-black/5 dark:bg-white/10" />
                      <div className="h-10 w-24 animate-pulse rounded-lg bg-black/5 dark:bg-white/10" />
                    </>
                  ) : epayMethods.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-black/10 px-3 py-2 text-sm text-muted-foreground dark:border-white/10">
                      暂无可用的支付渠道
                    </div>
                  ) : epayMethods.map((method) => (
                    <label
                      key={method.type}
                      className={cn(
                        'flex min-h-10 cursor-pointer items-center rounded-lg border px-4 text-sm font-medium transition-colors',
                        epayMethod === method.type
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-black/10 text-foreground hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5',
                        formDisabled && 'cursor-not-allowed opacity-50',
                      )}
                    >
                      <input
                        type="radio"
                        name="recharge-epay-method"
                        value={method.type}
                        checked={epayMethod === method.type}
                        disabled={formDisabled}
                        onChange={() => {
                          setEpayMethod(method.type);
                          if (selectedProduct && onlineTopupEnabled) {
                            setError('');
                            setNotice('');
                          }
                        }}
                        className="sr-only"
                      />
                      <span>{method.name || getPaymentMethodLabel(method.type)}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="pt-1">
                <Button onClick={() => void handleSubmit()} disabled={formDisabled} className="h-10 min-w-32 rounded-lg">
                  {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {submitting
                    ? '提交中...'
                    : hasPendingCheckout
                      ? '待支付中...'
                      : hasFailedCheckout
                        ? '请先重置订单'
                        : '立即充值'}
                </Button>
              </div>
            </div>
          </section>
        </div>
      </div>

      {checkout?.tradeNo && checkoutOpen && checkoutGuidance && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="recharge-checkout-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setCheckoutOpen(false);
            }
          }}
        >
          <div className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-lg border border-black/10 bg-background shadow-xl dark:border-white/10">
            <div className="grid max-h-[90vh] grid-cols-1 overflow-y-auto md:grid-cols-[300px_1fr]">
              <div className="border-b border-black/10 p-5 dark:border-white/10 md:border-b-0 md:border-r">
                <div className="flex min-h-[260px] items-center justify-center rounded-lg bg-white p-4">
                  {checkout.qrSvgMarkup ? (
                    <div
                      className="h-60 w-60 [&_svg]:h-full [&_svg]:w-full"
                      dangerouslySetInnerHTML={{ __html: checkout.qrSvgMarkup }}
                    />
                  ) : checkout.qrDataUrl ? (
                    <img src={checkout.qrDataUrl} alt={getScanTip(checkout.method)} className="h-60 w-60 object-contain" />
                  ) : (
                    <div className="px-4 text-center text-sm text-slate-600">
                      {checkout.qrError || '二维码生成失败'}
                    </div>
                  )}
                </div>
                <p className="mt-3 text-center text-sm text-muted-foreground">
                  {hasQrVisual ? getScanTip(checkout.method) : '完成付款后回到这里检查状态'}
                </p>
              </div>

              <div className="p-5">
                <div className={cn(
                  'mb-3 inline-flex rounded-full px-3 py-1 text-xs font-medium',
                  checkoutGuidance.tone === 'failed'
                    ? 'bg-destructive/10 text-destructive'
                    : checkoutGuidance.tone === 'warning'
                      ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-300'
                      : 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
                )}
                >
                  {getPaymentStatusLabel(payStatus)}
                </div>
                <h3 id="recharge-checkout-title" className="text-2xl font-semibold text-foreground">
                  {checkoutGuidance.title}
                </h3>
                {checkoutGuidance.subtitle && (
                  <p className="mt-2 text-sm text-muted-foreground">{checkoutGuidance.subtitle}</p>
                )}

                <div className="mt-5 space-y-3 text-sm">
                  {checkout.amountYuan && (
                    <div className="flex justify-between gap-3 border-b border-black/10 pb-2 dark:border-white/10">
                      <span className="text-muted-foreground">充值金额</span>
                      <strong>{formatCurrency(checkout.amountYuan)}</strong>
                    </div>
                  )}
                  {checkout.creditQuota > 0 && (
                    <div className="flex justify-between gap-3 border-b border-black/10 pb-2 dark:border-white/10">
                      <span className="text-muted-foreground">预计到账</span>
                      <strong>{formatNumber(checkout.creditQuota)} 虾粮</strong>
                    </div>
                  )}
                  <div className="flex justify-between gap-3 border-b border-black/10 pb-2 dark:border-white/10">
                    <span className="text-muted-foreground">订单号</span>
                    <code className="text-right text-xs">{checkout.tradeNo}</code>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-black/10 pb-2 dark:border-white/10">
                    <span className="text-muted-foreground">创建时间</span>
                    <strong>{formatDateTime(checkout.createdAt)}</strong>
                  </div>
                  {payStatus === 'pending' && (
                    <div className="flex justify-between gap-3 border-b border-black/10 pb-2 dark:border-white/10">
                      <span className="text-muted-foreground">等待时长</span>
                      <strong>{getCheckoutWaitingLabel(checkout)}</strong>
                    </div>
                  )}
                  {checkout.lastCheckedAt > 0 && (
                    <div className="flex justify-between gap-3 border-b border-black/10 pb-2 dark:border-white/10">
                      <span className="text-muted-foreground">最近检查</span>
                      <strong>{formatDateTime(checkout.lastCheckedAt)}</strong>
                    </div>
                  )}
                </div>

                {checkoutGuidance.detail && (
                  <div className="mt-4 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-sm text-sky-700 dark:text-sky-300">
                    {checkoutGuidance.detail}
                  </div>
                )}

                {checkout.lastStatusError && (
                  <div className="mt-4 rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-300">
                    {checkout.lastStatusError}
                  </div>
                )}

                <div className="mt-5 flex flex-wrap gap-2">
                  {payStatus === 'pending' && (
                    <Button variant="outline" onClick={() => void handleCheckNow()} disabled={checkingPayment}>
                      {checkingPayment ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                      立即检查支付状态
                    </Button>
                  )}
                  {showOpenPayLink && (
                    <Button variant="outline" onClick={() => void handleOpenPayLink()}>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      浏览器打开
                    </Button>
                  )}
                  {payStatus === 'pending' && (
                    <Button variant="outline" onClick={() => setCheckoutOpen(false)}>
                      关闭弹窗
                    </Button>
                  )}
                  <Button variant="outline" onClick={resetCheckout}>
                    取消订单
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Recharge;
